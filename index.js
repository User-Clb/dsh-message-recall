/**
 * dsh-message-recall — 消息撤回插件（Host 半）。
 *
 * 语义：
 *   - 撤回一条用户消息 => 该消息之后（含该条）的全部会话表面节点被遮蔽，
 *     模型上下文从该点截断；被撤回的原文通过 RPC 返回给客户端回填输入框。
 *   - 使用官方会话表面替换（surfaceOp: { op: 'replace', startSeq, endSeq }），
 *     和官方 compaction checkpoint 用的是同一条通道，不修改会话文件格式。
 *   - 替换事件本身不产生模型消息（deriveMessages 包装过滤 + id 前缀约定）。
 *
 * 客户端半（client.cjs）提供气泡下方的撤回按钮，并通过同一 RPC 驱动这里。
 */
import { registerRecall } from './src/recall.js';

export const name = 'dsh-message-recall';
export const inject = ['sessions', 'sessionController'];

const RPC_PATH = '/api/plugin-rpc/dsh-message-recall';
const RPC_METHOD = 'plugin-rpc/dsh-message-recall';

export function apply(ctx) {
  let disposeRpc;
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => {
      disposeRpc = scope.connection.fetch.register({
        path: RPC_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleRpc(request, ctx),
      });
      ctx.logger?.info?.(`[dsh-message-recall] RPC registered: ${RPC_PATH}`);
      return () => disposeRpc?.();
    }, 'dsh-message-recall: RPC route');
  });

  return () => {
    disposeRpc?.();
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function success(rpcId, value) {
  return jsonResponse({ type: 'server-response', rpcId, result: { ok: true, value } });
}

function failure(rpcId, code, message) {
  return jsonResponse({ type: 'server-response', rpcId, result: { ok: false, error: { code, message, details: {} } } });
}

async function handleRpc(request, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('invalid JSON request body', { status: 400 });
  }
  if (body === null || typeof body !== 'object' || body.type !== 'client-request'
    || typeof body.rpcId !== 'string' || body.method !== RPC_METHOD) {
    return new Response('invalid client-request envelope', { status: 400 });
  }
  const wrapped = body.payload;
  if (!wrapped || typeof wrapped !== 'object' || typeof wrapped.endpoint !== 'string') {
    return failure(body.rpcId, 'invalid-request', 'payload must be { endpoint, payload }');
  }

  try {
    switch (wrapped.endpoint) {
      case 'status': {
        return success(body.rpcId, await registerRecall.status(ctx, wrapped.payload ?? {}));
      }
      case 'recall': {
        const result = await registerRecall.recall(ctx, wrapped.payload ?? {});
        return result.ok ? success(body.rpcId, result) : failure(body.rpcId, result.code ?? 'recall-failed', result.message ?? '撤回失败');
      }
      case 'runtime': {
        return success(body.rpcId, {
          rpc: RPC_PATH,
          method: RPC_METHOD,
          sessions: Boolean(ctx.get?.('sessions')),
        });
      }
      default:
        return failure(body.rpcId, 'unknown-endpoint', `unknown endpoint: ${wrapped.endpoint}`);
    }
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-message-recall] ${wrapped.endpoint} failed: ${error?.message ?? error}`);
    return failure(body.rpcId, 'internal-error', String(error?.message ?? error));
  }
}
