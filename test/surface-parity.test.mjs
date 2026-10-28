/**
 * 与官方 foldSurface 交叉验证。
 *
 * 目的：确认本插件写出的 surfaceOp replace 事件，
 * 在官方折叠语义下确实让目标节点离开表面（而不是只在本插件里“看起来”生效）。
 *
 * 运行：node --test test/surface-parity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { registerRecall } from '../src/recall.js';

/** 本机 DSH 内核的官方 surface 模块。 */
const DSH_KERNEL = process.env.DSH_KERNEL_SURFACE
  ?? 'F:/AllSoftware/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js';

const surfaceApi = await import(pathToFileURL(path.resolve(DSH_KERNEL)).href);
const foldSurface = surfaceApi.foldSurface;

/** 官方折叠：从事件流算出表面节点。 */
function officialNodes(events) {
  const folded = foldSurface(events);
  const nodes = folded?.nodes ?? folded;
  if (!Array.isArray(nodes)) throw new Error('官方 foldSurface 返回结构不符预期');
  return nodes.map((entry) => (typeof entry === 'number' ? entry : Number(entry?.seq ?? entry)));
}

/** 造一条带官方表面语义的会话（用官方折叠做表面视图）。 */
function makeSession(events) {
  const log = [...events];
  return {
    snapshotEvents: () => log,
    surface: {
      get nodes() {
        return officialNodes(log);
      },
    },
    append(type, data, opts) {
      const event = { type, seq: log.length, time: Date.now(), data, ...opts };
      log.push(event);
      return event;
    },
    // 按官方折叠结果投影消息，供 host 的上下文校验使用。
    deriveMessages() {
      const onSurface = new Set(officialNodes(log));
      return log
        .filter((event) => onSurface.has(event.seq))
        .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
        .map((event) => ({
          id: event.data?.id ?? event.data?.message?.id,
          role: event.type === 'user/message' ? 'user' : 'assistant',
          content: event.data?.content ?? event.data?.message?.content ?? [],
        }));
    },
  };
}

const userEvent = (seq, id, text) => ({
  type: 'user/message',
  seq,
  time: 1700000000000 + seq,
  surfaceOp: 'append',
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});

const assistantEvent = (seq, id, text) => ({
  type: 'assistant/message',
  seq,
  time: 1700000000000 + seq,
  surfaceOp: 'append',
  data: { message: { id, role: 'assistant', content: [{ type: 'text', text }] } },
});

function makeCtx(session, sessionId) {
  if (session && !session.id) session.id = sessionId;
  const services = {
    sessions: { get: () => session, list: () => [session] },
    agents: { get: () => ({ phase: { kind: 'idle' }, inbox: { nextTurn: [], nextStep: [] } }) },
    sessionController: { updateQueue: async () => {} },
  };
  return {
    get(name) {
      if (name in services) return services[name];
      throw new Error(`unknown service ${name}`);
    },
  };
}

test('官方折叠确认目标节点真的离开表面', async () => {
  const sessionId = 'session-parity';
  const session = makeSession([
    userEvent(0, 'u1', '第一条'),
    assistantEvent(1, 'a1', '回复一'),
    userEvent(2, 'u2', '第二条'),
    assistantEvent(3, 'a2', '回复二'),
  ]);
  const ctx = makeCtx(session, sessionId);

  const before = officialNodes(session.snapshotEvents());
  assert.deepEqual(before, [0, 1, 2, 3]);

  const result = await registerRecall.recall(ctx, { sessionId, seq: 2, scope: 'from' });
  assert.equal(result.ok, true, JSON.stringify(result));

  const after = officialNodes(session.snapshotEvents());
  assert.ok(!after.includes(2), '官方折叠下目标必须消失');
  assert.ok(!after.includes(3), '官方折叠下其后节点必须消失');
  assert.deepEqual(after.slice(0, 2), [0, 1], '之前的内容保持不变');
});

test('scope=only 在官方折叠下只移除一条', async () => {
  const sessionId = 'session-parity-only';
  const session = makeSession([
    userEvent(0, 'u1', '第一条'),
    assistantEvent(1, 'a1', '回复一'),
    userEvent(2, 'u2', '第二条'),
    assistantEvent(3, 'a2', '回复二'),
  ]);
  const ctx = makeCtx(session, sessionId);

  const result = await registerRecall.recall(ctx, { sessionId, seq: 2, scope: 'only' });
  assert.equal(result.ok, true, JSON.stringify(result));

  const after = officialNodes(session.snapshotEvents());
  assert.ok(!after.includes(2), '目标消失');
  assert.ok(!after.includes(3), '它引出的助手回复也消失');
  assert.ok(after.includes(0) && after.includes(1), '更早一轮保留');
});
