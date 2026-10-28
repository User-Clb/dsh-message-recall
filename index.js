/**
 * dsh-message-recall — 消息撤回插件（Host 半）。
 *
 * 语义：
 *   - 撤回一条用户消息 => 该消息之后（含该条）的会话表面节点被遮蔽，
 *     模型上下文从该点截断；被撤回的原文返回给客户端回填输入框。
 *   - 使用官方会话表面替换（surfaceOp: { op: 'replace', startSeq, endSeq }），
 *     与官方 compaction checkpoint 同一条通道，不修改会话文件格式。
 *   - 替换事件本身不产生模型消息（deriveMessages 包装过滤 + id 前缀约定）。
 *
 * 传输：与 dsh-purge 相同的做法 —— 宿主用 webServer.register 注册普通 HTTP
 * 路由，浏览器端用同源 fetch 调用。参数优先从查询串读取，避免依赖请求体流；
 * POST 正文按需再读，读失败不影响主流程。
 */
import { registerRecall } from './src/recall.js';

export const name = 'dsh-message-recall';
export const inject = ['sessions', 'sessionController'];

const ROUTE = '/dsh-message-recall';

export function apply(ctx) {
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const dispose = scope.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: (request, response) => handleRequest(request, response, ctx),
      });
      ctx.logger?.info?.(`[dsh-message-recall] routes registered at ${ROUTE}`);
      return () => {
        try { dispose?.(); } catch { /* ignore */ }
      };
    }, 'dsh-message-recall: web routes');
  });
}

/** 发送 JSON。 */
function sendJson(response, status, body) {
  if (response.writableEnded || response.headersSent) return;
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

/** 读取 POST 正文；任何失败都降级为空对象。 */
async function readBody(request) {
  try {
    if (typeof request[Symbol.asyncIterator] !== 'function') return {};
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 1024 * 1024) break;
      chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 合并查询串与正文，查询串优先。 */
function mergePayload(url, body) {
  const merged = { ...(body ?? {}) };
  for (const [key, value] of url.searchParams) {
    if (value !== '') merged[key] = value;
  }
  return merged;
}

/** 只读诊断：报告宿主能看到哪些会话与服务。 */
function probeSessions(ctx) {
  const out = { services: {}, sessions: [] };
  for (const name of ['sessions', 'sessionController', 'agents', 'webServer']) {
    try {
      out.services[name] = Boolean(ctx.get(name, false));
    } catch {
      out.services[name] = 'throw';
    }
  }
  try {
    const sessions = ctx.get('sessions', false);
    const list = sessions?.list?.() ?? [];
    out.count = Array.isArray(list) ? list.length : -1;
    for (const session of (Array.isArray(list) ? list : []).slice(0, 8)) {
      let events = -1;
      try {
        events = (session?.snapshotEvents?.() ?? []).length;
      } catch {
        events = 'throw';
      }
      out.sessions.push({
        id: session?.id ?? session?.header?.id ?? '(none)',
        events,
      });
    }
  } catch (error) {
    out.error = String(error?.message ?? error);
  }
  return out;
}

/**
 * 只读审计：列出会话里所有撤回标记及其遮蔽跨度。
 *
 * 用来核对「我到底遮蔽了多少」——跨度异常大就说明目标定位错了。
 *
 * @param ctx - Host 根上下文。
 * @param payload - `{ sessionId? }`。
 */
function auditMarkers(ctx, payload) {
  const sessions = ctx.get('sessions', false);
  const list = sessions?.list?.() ?? [];
  const wanted = typeof payload?.sessionId === 'string' ? payload.sessionId : '';

  const out = [];
  for (const session of list) {
    const id = session?.id ?? session?.header?.id;
    if (typeof id !== 'string' || !id) continue;
    if (wanted && id !== wanted) continue;

    let events = [];
    try {
      events = [...(session?.snapshotEvents?.() ?? [])];
    } catch {
      events = [];
    }

    const markers = [];
    for (const event of events) {
      const markerId = event?.data?.id;
      if (typeof markerId !== 'string') continue;
      if (markerId.indexOf('rewind-') !== 0) continue;
      const op = event.surfaceOp;
      if (!op || op === 'append' || op.op !== 'replace') continue;
      const span = Number(op.endSeq) - Number(op.startSeq) + 1;
      markers.push({
        markerSeq: Number(event.seq),
        startSeq: Number(op.startSeq),
        endSeq: Number(op.endSeq),
        span,
        sources: Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs.length : 0,
      });
    }

    out.push({
      sessionId: id,
      eventCount: events.length,
      markerCount: markers.length,
      markers: markers.slice(-10),
    });
  }
  return { ok: true, sessions: out };
}

/**
 * 只读诊断：报告模型实际会看到的派生消息（deriveMessages 的真实结果）。
 *
 * 这是判断「撤回有没有真的进到模型上下文」的唯一可靠依据：
 * 表面节点变了但派生消息没变，就等于没撤回。
 *
 * @param ctx - Host 根上下文。
 * @param payload - `{ sessionId?, tail? }`。
 */
function inspectDerived(ctx, payload) {
  const sessions = ctx.get('sessions', false);
  const list = sessions?.list?.() ?? [];
  const wanted = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  const tail = Number.isFinite(Number(payload?.tail)) ? Number(payload.tail) : 12;

  const out = [];
  for (const session of list) {
    const id = session?.id ?? session?.header?.id;
    if (typeof id !== 'string' || !id) continue;
    if (wanted && id !== wanted) continue;

    let messages = [];
    try {
      messages = session?.deriveMessages?.() ?? [];
    } catch (error) {
      out.push({ sessionId: id, error: String(error?.message ?? error) });
      continue;
    }

    const flat = (message) => {
      const content = message?.content;
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      return content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('');
    };

    out.push({
      sessionId: id,
      surfaceNodes: Array.isArray(session?.surface?.nodes) ? session.surface.nodes.length : -1,
      messageCount: messages.length,
      roles: messages.reduce((acc, message) => {
        const role = String(message?.role ?? '?');
        acc[role] = (acc[role] ?? 0) + 1;
        return acc;
      }, {}),
      tail: messages.slice(-tail).map((message) => ({
        role: message?.role ?? '?',
        id: message?.id ?? null,
        text: flat(message).slice(0, 80),
      })),
    });
  }
  return { ok: true, sessions: out };
}

async function handleRequest(request, response, ctx) {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const action = url.pathname.slice(ROUTE.length).replace(/^\/+/, '');

    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' });
      response.end();
      return;
    }

    const body = await readBody(request);
    const payload = mergePayload(url, body);

    if (action === 'status') {
      sendJson(response, 200, await registerRecall.status(ctx, payload));
      return;
    }
    if (action === 'audit') {
      sendJson(response, 200, auditMarkers(ctx, payload));
      return;
    }
    if (action === 'derived') {
      sendJson(response, 200, inspectDerived(ctx, payload));
      return;
    }
    if (action === 'probe') {
      sendJson(response, 200, probeSessions(ctx));
      return;
    }
    if (action === 'recall') {
      sendJson(response, 200, await registerRecall.recall(ctx, payload));
      return;
    }
    sendJson(response, 404, { ok: false, code: 'unknown-action', message: `unknown action: ${action}` });
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-message-recall] request failed: ${error?.stack ?? error}`);
    try {
      sendJson(response, 200, { ok: false, code: 'internal-error', message: String(error?.message ?? error) });
    } catch {
      /* 响应已结束 */
    }
  }
}
