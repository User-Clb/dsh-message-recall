/**
 * dsh-message-recall 核心逻辑（Host 侧）。
 *
 * 「真正撤回」的落点有两处，缺一不可：
 *
 * 1) 模型上下文 —— 在会话日志尾部追加一条表面替换事件：
 *      append('user/message', {...}, {
 *        surfaceOp: { op: 'replace', startSeq, endSeq },
 *        sourceEventSeqs: [...shadowed],
 *      })
 *    这与官方 compaction checkpoint 走同一条通道。session.deriveMessages()
 *    立即从该点截断，下一轮请求不再包含被撤回的消息。
 *    替换事件本身是 user/message，但 id 带 recall- 前缀，派生时被过滤，
 *    因此不会以「用户说了一句空话」的形式进入上下文。
 *
 * 2) 会话记录视图 —— 被遮蔽的事件仍留在追加式日志里（可审计、可恢复），
 *    但已不在「当前表面」上。客户端装配器按同一规则剔除，气泡真正消失。
 *
 * 另外：撤回前先停掉仍在跑的回合，并清空入站队列里未发出的内容，
 * 避免撤回后旧内容又被唤醒。
 */

/** 从 ctx 取服务，缺省安全。 */
function service(ctx, name) {
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

/** 表面可参与的事件类型（与 dsh-session 的 SURFACE_EVENT_TYPES 一致）。 */
const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
]);

/** 撤回标记事件的 id 前缀。 */
const RECALL_PREFIX = 'recall-';

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

/** 会话日志读取：优先活会话快照，其次控制器 inspect，最后查询服务。 */
async function readLog(ctx, sessionId) {
  const sessions = service(ctx, 'sessions');
  const live = sessions?.get?.(sessionId);
  if (live?.snapshotEvents) {
    return { events: asEvents(live.snapshotEvents()), session: live };
  }

  const controller = service(ctx, 'sessionController');
  if (typeof controller?.inspect === 'function') {
    const inspected = await controller.inspect(sessionId);
    return { events: asEvents(inspected?.events), session: live ?? null };
  }

  const query = service(ctx, 'sessionQuery');
  if (typeof query?.observeSession === 'function') {
    const observed = await query.observeSession(sessionId, { projectionMode: 'none' });
    try {
      return { events: asEvents(observed?.events), session: live ?? null };
    } finally {
      observed?.[Symbol.dispose]?.();
    }
  }

  return { events: asEvents(live?.snapshotEvents?.() ?? []), session: live ?? null };
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
  const kind = event.data?.source?.kind;
  if (kind !== undefined && kind !== 'user') return false;
  return userTextOf(event) !== '';
}

/**
 * 按表面替换规则折叠出「当前表面」的节点序列。
 *
 * @param events - 完整事件日志（按 seq 升序）。
 * @returns 当前表面事件的 seq 数组（升序）。
 */
export function foldSurfaceNodes(events) {
  const nodes = [];
  for (const event of events) {
    if (!SURFACE_TYPES.has(event?.type)) continue;
    const op = event.surfaceOp;
    if (op === undefined || op === 'append') {
      nodes.push(Number(event.seq));
      continue;
    }
    if (typeof op !== 'object' || op === null || op.op !== 'replace') continue;
    const start = Number(op.startSeq);
    const end = Number(op.endSeq);
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      if (nodes[index] >= start && nodes[index] <= end) nodes.splice(index, 1);
    }
    nodes.push(Number(event.seq));
  }
  return nodes.sort((left, right) => left - right);
}

/** 把模型派生消息里的撤回标记过滤掉。 */
function wrapDerive(session) {
  if (!session || typeof session.deriveMessages !== 'function' || session.__recallWrapped) return session;
  const original = session.deriveMessages.bind(session);
  session.deriveMessages = function deriveMessagesWithoutRecallMarkers() {
    const messages = original();
    if (!Array.isArray(messages)) return messages;
    return messages.filter((message) => {
      const id = message?.id;
      return !(typeof id === 'string' && id.startsWith(RECALL_PREFIX));
    });
  };
  session.__recallWrapped = true;
  return session;
}

/** 让下一次请求重新组装（撤回后不复用上一轮的请求头序列）。 */
function resetRequestSeries(ctx, sessionId) {
  const agents = service(ctx, 'agents');
  const agent = agents?.get?.(sessionId) ?? agents?.agent?.(sessionId);
  if (!agent) return;
  try { agent.requestHeaderLogged = false; } catch { /* ignore */ }
  try { agent.requestSurfaceGeneration = -1; } catch { /* ignore */ }
  try { agent.frozenMessages?.clear?.(); } catch { /* ignore */ }
}

/** 清掉入站队列里尚未发出的消息。 */
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
      await controller?.updateQueue?.({ sessionId, itemId: id, action: { kind: 'remove' } });
    } catch { /* ignore */ }
  }
}

/** 该回合仍在运行时先停掉，避免撤回后旧回合继续写回。 */
async function stopRunningTurn(ctx, sessionId) {
  const agents = service(ctx, 'agents');
  const agent = agents?.get?.(sessionId);
  const phase = agent?.phase?.kind;
  if (!phase || phase === 'idle') return false;
  try {
    await agent?.cancel?.({ kind: 'user' }, { keepInbox: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 客户端拿不到会话 id 时的兜底：取最近活跃的活会话。
 *
 * @param ctx - Host 根上下文。
 * @returns 会话 id，找不到返回空串。
 */
function fallbackSessionId(ctx) {
  const sessions = service(ctx, 'sessions');
  try {
    const list = sessions?.list?.();
    if (!Array.isArray(list) || list.length === 0) return '';
    // 取最后创建且事件最多的活会话（最可能是用户正在看的那个）。
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
    /* 忽略 */
  }
  return '';
}

/**
 * 撤回消息。
 *
 * @param ctx - Host 根上下文。
 * @param payload - `{ sessionId, seq?, messageId?, scope? }`；
 *   `scope` 取 `"only"`（仅撤回本条）或 `"from"`（本条及其之后，默认）。
 * @returns 撤回结果；成功时含回填输入框所需的原文。
 */
async function recall(ctx, payload) {
  let sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  if (!sessionId) sessionId = fallbackSessionId(ctx);
  if (!sessionId) return { ok: false, code: 'no-session', message: '没有当前会话' };

  const stopped = await stopRunningTurn(ctx, sessionId);

  const { events, session } = await readLog(ctx, sessionId);
  if (events.length === 0 && !session) {
    return { ok: false, code: 'session-not-found', message: '找不到该会话' };
  }

  const nodes = foldSurfaceNodes(events);
  if (nodes.length === 0) return { ok: false, code: 'empty-surface', message: '没有可撤回的消息' };

  const wantedId = typeof payload?.messageId === 'string' ? payload.messageId : '';
  const wantedSeq = Number.isFinite(Number(payload?.seq)) ? Number(payload.seq) : undefined;

  let targetSeq;
  if (wantedId) {
    const hit = events.find((event) => event?.type === 'user/message' && event.data?.id === wantedId);
    if (hit) targetSeq = Number(hit.seq);
  }
  if (targetSeq === undefined && wantedSeq !== undefined) targetSeq = wantedSeq;
  if (targetSeq === undefined) return { ok: false, code: 'target-missing', message: '没有指定要撤回哪一条' };

  // 定位目标在表面上的位置。
  let startIndex = nodes.findIndex((seq) => seq >= targetSeq);
  if (startIndex < 0) return { ok: false, code: 'already-recalled', message: '该消息已被撤回' };

  // 系统提示永远不进入撤回区间。
  while (startIndex < nodes.length) {
    const event = events[Number(nodes[startIndex])];
    if (event?.type !== 'system/message') break;
    startIndex += 1;
  }
  if (startIndex >= nodes.length) {
    return { ok: false, code: 'already-recalled', message: '该消息已被撤回' };
  }

  // 目标若已是撤回标记，说明这个位置之前就撤回过。
  const candidate = events[Number(nodes[startIndex])];
  if (isRecallMarker(candidate)) {
    return { ok: false, code: 'already-recalled', message: '该消息已被撤回' };
  }

  // scope=only：只撤这一条；scope=from：本条及其之后（默认）。
  const scope = payload?.scope === 'only' ? 'only' : 'from';

  const startSeq = Number(nodes[startIndex]);
  let endSeq;
  if (scope === 'only') {
    // 只撤这一条用户消息本身，后续内容保持不动。
    endSeq = startSeq;
  } else {
    endSeq = Number(nodes[nodes.length - 1]);
  }
  if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq) || endSeq < startSeq) {
    return { ok: false, code: 'bad-range', message: '撤回区间无效' };
  }

  const text = isHumanUserEvent(candidate) ? userTextOf(candidate) : '';

  const shadowed = nodes
    .slice(startIndex)
    .map((seq) => Number(seq))
    .filter((seq) => Number.isSafeInteger(seq) && seq >= startSeq && seq <= endSeq);

  const live = wrapDerive(session ?? service(ctx, 'sessions')?.get?.(sessionId));
  if (!live || typeof live.append !== 'function') {
    return { ok: false, code: 'no-live-session', message: '会话未激活，先打开该会话再撤回' };
  }

  await disarmInbox(ctx, sessionId);

  const marker = live.append(
    'user/message',
    {
      id: `${RECALL_PREFIX}${Date.now().toString(36)}-${shadowed.length}`,
      role: 'user',
      source: { kind: 'user' },
      content: [],
    },
    { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: shadowed },
  );

  resetRequestSeries(ctx, sessionId);

  return {
    ok: true,
    sessionId,
    scope,
    startSeq,
    endSeq,
    markerSeq: Number(marker?.seq ?? -1),
    recalledCount: shadowed.length,
    stopped,
    text,
    at: Date.now(),
  };
}

/** 只读状态：当前会话有哪些可撤回的用户消息。 */
async function status(ctx, payload) {
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  if (!sessionId) return { ok: false, code: 'no-session', message: '没有当前会话' };

  const { events, session } = await readLog(ctx, sessionId);
  const nodes = foldSurfaceNodes(events);
  const onSurface = new Set(nodes);
  const recallable = events
    .filter((event) => onSurface.has(Number(event?.seq)))
    .filter(isHumanUserEvent)
    .map((event) => ({
      seq: Number(event.seq),
      messageId: event.data?.id ?? '',
      text: userTextOf(event).slice(0, 160),
    }));

  return { ok: true, sessionId, surfaceNodes: nodes.length, recallable, live: Boolean(session) };
}

export const registerRecall = { recall, status, foldSurfaceNodes, isRecallMarker };
