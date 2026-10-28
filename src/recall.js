/**
 * dsh-message-recall 核心逻辑（Host 侧）。
 *
 * 「真撤回」的语义与实现要点（照官方 compaction / dsh-purge 回退验证过的路子）：
 *
 *   1) 用**官方** `session.surface.nodes` 取当前表面，不自己折叠，
 *      否则拿到的区间和官方视图不一致，会写出破坏性的 replace 事件。
 *   2) append 一条带 `surfaceOp: { op: 'replace', startSeq, endSeq }` 的替换事件，
 *      `sourceEventSeqs` 只放真正被遮蔽的那些节点。
 *   3) append 之后必须 `invalidateDerivedCache(session)`，
 *      否则派生缓存仍是旧的 → 请求带旧历史 → 被服务端拒绝（400 / code 11158）。
 *   4) 用 `deriveMessages()` 复核：被撤回的文本必须真的不在里面了。
 *   5) 替换事件本身不进模型消息（id 前缀 + 派生过滤）。
 */

/** 从 ctx 取服务，缺省安全。 */
function service(ctx, name) {
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

/**
 * 撤回标记事件的 id 前缀。
 *
 * 用 `rewind-` 前缀是刻意的：客户端 uiConversation 的窗口装配已在
 * `rewindVisibleEntries` 里按这个前缀剔除被遮蔽的节点（dsh-purge 留的规则）。
 * 用同一前缀，撤回后的气泡才会从界面上真正消失，而不是只改数据。
 * 标记事件本身仍不进模型消息（deriveMessages 过滤同前缀）。
 */
const RECALL_PREFIX = 'rewind-';

function asEvents(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value[Symbol.iterator] === 'function') {
    try {
      return [...value];
    } catch {
      return [];
    }
  }
  return [];
}

/** 从 user/message 事件提取纯文本。 */
function userTextOf(event) {
  const content = event?.data?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block) return '';
      if (typeof block === 'string') return block;
      return typeof block.text === 'string' ? block.text : '';
    })
    .join('');
}

/** 该事件是否是本插件写入的撤回标记。 */
export function isRecallMarker(event) {
  if (!event || event.type !== 'user/message') return false;
  const id = event?.data?.id;
  return typeof id === 'string' && id.startsWith(RECALL_PREFIX);
}

/** 一条事件是否是「人类用户发出的、有内容的」消息。 */
function isHumanUserEvent(event) {
  if (event?.type !== 'user/message') return false;
  if (isRecallMarker(event)) return false;
  const kind = event?.data?.source?.kind;
  if (kind !== undefined && kind !== 'user') return false;
  return userTextOf(event) !== '';
}

/** 规范化文本，用于比对。 */
function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 取活会话对象。 */
function liveSession(ctx, sessionId) {
  const sessions = service(ctx, 'sessions');
  return sessions?.get?.(sessionId);
}

/** 会话事件读取：优先活会话快照，失败返回空数组。 */
function readEvents(ctx, sessionId) {
  const live = liveSession(ctx, sessionId);
  if (typeof live?.snapshotEvents === 'function') {
    try {
      return asEvents(live.snapshotEvents());
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * 取当前表面节点。
 *
 * 必须用官方 `session.surface.nodes`：它是唯一权威的表面视图。
 *
 * @param session - 活会话对象。
 * @returns 表面节点 seq 数组（升序）。
 */
function surfaceNodes(session) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.map((seq) => Number(seq)).filter((seq) => Number.isSafeInteger(seq));
}

/**
 * 让派生缓存失效。
 *
 * 真实 `deriveMessages()` 的逻辑：
 *   generation !== derivedGeneration → 清空 derived，从 0 重建
 * 所以只把 `derivedGeneration` 设成和 generation 相同以外的值是不够的，
 * 必须让它俩必然不等。这里同时递增 surface.contentGeneration 并把
 * derivedGeneration 设成一个必然不同的值。
 *
 * @param session - 活会话对象。
 */
function invalidateDerivedCache(session) {
  if (!session) return;
  let bumped = false;
  try {
    const surface = session.surface;
    if (surface && typeof surface.contentGeneration === 'number') {
      surface.contentGeneration += 1;
      bumped = true;
    }
  } catch { /* ignore */ }

  // 官方 deriveMessages 判据：generation !== derivedGeneration 才重建。
  // 递增成功时把 derivedGeneration 设成一个必然不等的值；
  // 递增失败（属性只读/不存在）时，也要让两者不等。
  try { session.derived = []; } catch { /* ignore */ }
  try { session.derivedNodes = 0; } catch { /* ignore */ }
  try {
    const generation = session?.surface?.contentGeneration;
    session.derivedGeneration = typeof generation === 'number'
      ? generation - 1
      : -1;
  } catch { /* ignore */ }

  // 自检：重建后如果派生消息里还留着已撤离表面的节点，说明失效没成功。
  return bumped;
}

/** 把撤回标记从派生消息里过滤掉。 */
function wrapDerive(session) {
  if (!session || typeof session.deriveMessages !== 'function' || session.__recallDerive) return session;
  const original = session.deriveMessages.bind(session);
  session.deriveMessages = function deriveMessagesWithoutRecallMarkers() {
    const messages = original();
    if (!Array.isArray(messages)) return [];
    return messages.filter((message) => {
      const id = message?.id;
      return !(typeof id === 'string' && id.startsWith(RECALL_PREFIX));
    });
  };
  session.__recallDerive = true;
  return session;
}

/** 派生消息里是否还残留某段文本。 */
function deriveStillContains(session, text) {
  const needle = normalizeText(text);
  // 太短的文本（如「1」「?」「继续」）在其它消息里也会出现，
  // 拿它判定会把成功当失败，直接跳过文本复核，只认表面校验。
  if (needle.length < 6) return false;
  if (!needle || typeof session?.deriveMessages !== 'function') return false;
  let messages = [];
  try {
    messages = session.deriveMessages();
  } catch {
    return false;
  }
  if (!Array.isArray(messages)) return false;
  const flat = (message) => {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('');
  };
  return messages.some((message) => {
    if (!message || message.role === 'system') return false;
    const id = message?.id;
    if (typeof id === 'string' && id.startsWith(RECALL_PREFIX)) return false;
    return normalizeText(flat(message)).includes(needle);
  });
}

/** 让下一次请求重新组装。 */
function resetRequestSeries(ctx, sessionId) {
  const agents = service(ctx, 'agents');
  const agent = agents?.get?.(sessionId) ?? agents?.agent?.(sessionId);
  if (!agent) return;
  try { agent.requestHeaderLogged = false; } catch { /* ignore */ }
  try { agent.requestSurfaceGeneration = -1; } catch { /* ignore */ }
  try { agent.frozenMessages?.clear?.(); } catch { /* ignore */ }
}

/** 停掉仍在运行的回合（只停当前那一个，不阻塞撤回主流程）。 */
async function stopRunningTurn(ctx, sessionId) {
  const agents = service(ctx, 'agents');
  const agent = agents?.get?.(sessionId);
  const phase = agent?.phase?.kind;
  if (!phase || phase === 'idle') return false;
  try {
    // 不 await：cancel 的 promise 可能到下一轮才 settle，
    // await 会把撤回请求一起拖住（表现为点击无响应）。
    const pending = agent.cancel?.({ kind: 'user' }, { keepInbox: true });
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** 清掉入站队列里尚未发出的内容（失败或慢都不阻塞撤回）。 */
async function disarmInbox(ctx, sessionId) {
  const controller = service(ctx, 'sessionController');
  const agents = service(ctx, 'agents');
  const agent = agents?.get?.(sessionId);
  const ids = [];
  try {
    for (const message of [...(agent?.inbox?.nextTurn ?? []), ...(agent?.inbox?.nextStep ?? [])]) {
      if (message?.id) ids.push(message.id);
    }
  } catch { /* ignore */ }
  for (const id of ids) {
    try {
      const pending = controller?.updateQueue?.({ sessionId, itemId: id, action: { kind: 'remove' } });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch { /* ignore */ }
  }
}

/**
 * 按文本定位目标事件。
 *
 * 客户端从界面取到的文本常带杂质（多个文本节点拼接、多余空格、
 * 图片占位等），所以按强度逐级放宽，从尾部向前取第一个命中的：
 *
 *   1) 规范化后完全相等；
 *   2) 去空白后完全相等；
 *   3) 互相包含（较长一方包含较短一方，且较短一方足够长）。
 *
 * @param events - 会话事件（升序）。
 * @param text - 客户端传来的文本。
 * @returns 目标事件 seq，找不到返回 undefined。
 */
function matchByText(events, text) {
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const squash = (value) => String(value ?? '').replace(/\s+/g, '');

  const wanted = norm(text);
  const wantedSquash = squash(text);
  if (!wanted) return undefined;

  // 候选：人类用户消息，从尾部往前（越近越可能是点的那条）。
  const candidates = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isHumanUserEvent(event)) continue;
    candidates.push({
      seq: Number(event.seq),
      norm: norm(userTextOf(event)),
      squash: squash(userTextOf(event)),
    });
  }
  if (candidates.length === 0) return undefined;

  // 1) 规范化后完全相等。
  const exact = candidates.find((row) => row.norm === wanted);
  if (exact) return exact.seq;

  // 2) 去掉所有空白后相等。
  if (wantedSquash.length > 0) {
    const squashed = candidates.find((row) => row.squash === wantedSquash);
    if (squashed) return squashed.seq;
  }

  // 3) 互相包含：较短的至少 4 个字，避免误命中。
  const shorter = Math.min(wantedSquash.length, 40);
  if (shorter >= 4) {
    const needle = wantedSquash.slice(0, shorter);
    const partial = candidates.find(
      (row) => row.squash.includes(needle) || needle.includes(row.squash.slice(0, shorter)),
    );
    if (partial) return partial.seq;
  }

  return undefined;
}

/**
 * 撤回消息（真删除：从会话表面与模型上下文里一起移除）。
 *
 * @param ctx - Host 根上下文。
 * @param payload - `{ sessionId?, seq?, text?, scope? }`。
 *   `scope` 取 `"only"`（只撤这条）或 `"from"`（这条及其之后，默认）。
 * @returns 撤回结果；成功时含回填输入框所需的原文。
 */
async function recall(ctx, payload) {
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  // 必须明确指定会话：跨会话按文本猜会命中别的会话里同文本的消息
  // （表现为「该消息已被撤回」但当前气泡还在），所以这里不再兜底猜测。
  if (!sessionId) {
    return { ok: false, code: 'no-session', message: '没有指定会话，请重试' };
  }

  let targetSeq;
  if (Number.isFinite(Number(payload?.seq))) targetSeq = Number(payload.seq);
  const stopped = await stopRunningTurn(ctx, sessionId);

  const session = liveSession(ctx, sessionId);
  if (!session || typeof session.append !== 'function' || !session.surface) {
    return { ok: false, code: 'no-live-session', message: '会话未激活，先打开该会话再撤回' };
  }

  const events = readEvents(ctx, sessionId);
  const eventAt = (seq) => events.find((event) => Number(event?.seq) === Number(seq));

  // 权威表面视图。
  const nodes = surfaceNodes(session);
  if (nodes.length === 0) {
    return { ok: false, code: 'empty-surface', message: '没有可撤回的消息' };
  }

  // 起点的确定顺序：seq 最精确，其次 messageId，最后才用文本。
  // 文本匹配是危险的（同文本消息会互相错配，导致区间从很靠前的位置开始，
  // 一次「及之后」就把前面和后面一起遮掉），因此只作为最后手段。
  const onSurface = new Set(nodes.map((seq) => Number(seq)));

  if (targetSeq === undefined && typeof payload?.messageId === 'string' && payload.messageId) {
    const wanted = payload.messageId;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!onSurface.has(Number(event?.seq))) continue;
      if (event?.type !== 'user/message') continue;
      if (String(event?.data?.id ?? '') === wanted) {
        targetSeq = Number(event.seq);
        break;
      }
    }
  }

  if (targetSeq === undefined && Number.isFinite(Number(payload?.seq))) {
    targetSeq = Number(payload.seq);
  }

  if (targetSeq === undefined && typeof payload?.text === 'string') {
    const visible = events.filter((event) => onSurface.has(Number(event?.seq)));
    targetSeq = matchByText(visible, payload.text);
  }

  if (targetSeq === undefined) {
    return { ok: false, code: 'target-missing', message: '没找到要撤回的消息' };
  }

  // 安全闸：文本/模糊定位拿到起点后，要求它确实是一条用户消息；
  // 否则宁可失败，也不冒险从一个错误的位置开始遮。
  const anchor = events.find((event) => Number(event?.seq) === targetSeq);
  if (!anchor || anchor.type !== 'user/message') {
    return {
      ok: false,
      code: 'bad-anchor',
      message: '定位到的不是一条用户消息，已取消以免误删',
    };
  }

  // 定位表面下标。
  let startIndex = nodes.findIndex((seq) => seq >= targetSeq);
  if (startIndex < 0) return { ok: false, code: 'already-recalled', message: '该消息已被撤回' };

  // 系统提示永不进入撤回区间。
  while (startIndex < nodes.length) {
    const event = eventAt(nodes[startIndex]);
    if (event?.type !== 'system/message') break;
    startIndex += 1;
  }
  if (startIndex >= nodes.length) {
    return { ok: false, code: 'already-recalled', message: '该消息已被撤回' };
  }

  const candidate = eventAt(nodes[startIndex]);
  if (isRecallMarker(candidate)) {
    return { ok: false, code: 'already-recalled', message: '该消息已被撤回' };
  }

  // 默认只撤本条：这是破坏面最小的操作。
  // 「及之后」必须由调用方显式指定，避免一次误触清空整段对话。
  const scope = payload?.scope === 'from' ? 'from' : 'only';

  /**
   * 一条用户消息撤回时，它引出的助手回复与工具结果也必须一起撤回。
   *
   * 否则模型上下文里仍留着助手那条回答（它往往复述了用户内容），
   * 表现就是「界面没了，但模型还记得」。
   *
   * 只吃到「下一条用户消息之前」，不越过其它提问。
   */
  const endIndexOfTurn = (from) => {
    let last = from;
    for (let index = from + 1; index < nodes.length; index += 1) {
      const event = eventAt(nodes[index]);
      if (event?.type === 'user/message' && !isRecallMarker(event)) break;
      last = index;
    }
    return last;
  };

  const lastIndex = scope === 'from'
    ? nodes.length - 1
    : endIndexOfTurn(startIndex);

  const shadowed = nodes.slice(startIndex, lastIndex + 1);

  const startSeq = shadowed[0];
  const endSeq = shadowed[shadowed.length - 1];
  if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq)) {
    return { ok: false, code: 'bad-range', message: '撤回区间无效' };
  }

  // 安全闸：一次「及之后」不该遮蔽超过半个会话。
  // 超过就说明起点定位错了（例如命中了很早的同文本消息），宁可拒绝。
  const span = shadowed.length;
  const surfaceSize = nodes.length;
  if (surfaceSize >= 20 && span > Math.ceil(surfaceSize * 0.5)) {
    return {
      ok: false,
      code: 'span-too-large',
      message: `这次撤回会遮蔽 ${span}/${surfaceSize} 个节点，已取消以免误删。请确认是否点错了位置。`,
    };
  }

  const text = isHumanUserEvent(candidate) ? userTextOf(candidate) : '';

  await disarmInbox(ctx, sessionId);

  let cleared = false;
  let modelDelta = 0;
  try {
    const live = wrapDerive(session);

    // 撤回前的模型消息条数（用于事后证明上下文真的少了内容）。
    const beforeCount = (() => {
      try { return (live.deriveMessages?.() ?? []).length; } catch { return -1; }
    })();

    live.append(
      'user/message',
      {
        id: `${RECALL_PREFIX}${Date.now().toString(36)}-${shadowed.length}`,
        role: 'user',
        source: { kind: 'user' },
        content: [],
      },
      { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: shadowed },
    );
    // 关键：让派生缓存失效，否则请求仍带旧历史。
    invalidateDerivedCache(live);

    // 复核一：这些 seq 必须真的离开表面视图。
    const left = new Set(surfaceNodes(live));
    if (shadowed.some((seq) => left.has(seq))) {
      return { ok: false, code: 'not-cleared', message: '撤回未生效，请重试' };
    }

    // 复核二：模型消息必须真的变少。这是「撤回是否进上下文」的硬指标，
    // 只改表面不改派生就等于没撤回，必须报错而不是假装成功。
    const afterCount = (() => {
      try { return (live.deriveMessages?.() ?? []).length; } catch { return -1; }
    })();
    if (beforeCount >= 0 && afterCount >= 0) {
      modelDelta = beforeCount - afterCount;
      if (modelDelta <= 0) {
        return {
          ok: false,
          code: 'context-unchanged',
          message: '界面已移除，但模型上下文没有变化，撤回未真正生效',
        };
      }
    }

    // 文本复核只作参考：极短文本（如「?」「继续」）在其它消息里也会出现，
    // 不能拿它判定失败，否则会把成功当失败。
    cleared = !deriveStillContains(live, text);
  } catch (error) {
    return { ok: false, code: 'append-failed', message: String(error?.message ?? error) };
  }

  resetRequestSeries(ctx, sessionId);

  return {
    ok: true,
    sessionId,
    scope,
    startSeq,
    endSeq,
    recalledCount: shadowed.length,
    modelDelta,
    stopped,
    cleared,
    text,
    at: Date.now(),
  };
}

/**
 * 会话兜底：取事件最多的活会话（最可能是用户正在看的那个）。
 *
 * 只给只读的 status 用；recall 必须由调用方明确指定会话。
 *
 * @param ctx - Host 根上下文。
 * @returns 会话 id，找不到返回空串。
 */
function fallbackSessionId(ctx) {
  const sessions = service(ctx, 'sessions');
  try {
    const list = sessions?.list?.() ?? [];
    if (!Array.isArray(list) || list.length === 0) return '';
    let best = '';
    let bestScore = -1;
    for (const session of list) {
      const id = session?.id ?? session?.header?.id;
      if (typeof id !== 'string' || !id) continue;
      let score = 0;
      try {
        score = Number(session?.snapshotEvents?.()?.length ?? 0);
      } catch {
        score = 0;
      }
      if (score >= bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  } catch {
    return '';
  }
}

/** 只读状态：当前会话有哪些可撤回的用户消息。 */
async function status(ctx, payload) {
  let sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  if (!sessionId) sessionId = fallbackSessionId(ctx);
  if (!sessionId) return { ok: false, code: 'no-session', message: '没有当前会话' };

  const session = liveSession(ctx, sessionId);
  const nodes = session ? surfaceNodes(session) : [];
  const events = readEvents(ctx, sessionId);

  // 只回尾部若干条，避免长会话把响应撑大、把请求拖慢。
  const limit = Number.isFinite(Number(payload?.limit)) ? Math.max(1, Number(payload.limit)) : 20;
  const onSurface = new Set(nodes);
  const recallable = [];
  for (let index = events.length - 1; index >= 0 && recallable.length < limit; index -= 1) {
    const event = events[index];
    if (!onSurface.has(Number(event?.seq))) continue;
    if (!isHumanUserEvent(event)) continue;
    recallable.push({
      seq: Number(event.seq),
      messageId: event.data?.id ?? '',
      text: userTextOf(event).slice(0, 160),
    });
  }
  recallable.reverse();

  return {
    ok: true,
    sessionId,
    surfaceNodes: nodes.length,
    totalEvents: events.length,
    recallable,
    live: Boolean(session),
  };
}

export const registerRecall = { recall, status, isRecallMarker };
