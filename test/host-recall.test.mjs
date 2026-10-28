/**
 * 宿主侧撤回测试。
 *
 * 关键点：stub 必须提供官方 `session.surface.nodes`，
 * 因为实现依赖它做区间计算与结果复核。
 *
 * 运行：node --test test/host-recall.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerRecall } from '../src/recall.js';

/** 造一个带官方 surface 语义的最小会话。 */
function makeSession(events) {
  const log = [...events];
  const appended = [];
  const nodes = events.filter((event) => event.surfaceOp === 'append').map((event) => event.seq);

  return {
    appended,
    snapshotEvents: () => log,
    surface: {
      get nodes() {
        return [...nodes];
      },
    },
    append(type, data, opts) {
      const event = { type, seq: log.length, time: Date.now(), data, ...opts };
      log.push(event);
      appended.push(event);

      const op = opts?.surfaceOp;
      if (op === undefined || op === 'append') {
        nodes.push(event.seq);
      } else if (op && typeof op === 'object' && op.op === 'replace') {
        for (let index = nodes.length - 1; index >= 0; index -= 1) {
          if (nodes[index] >= op.startSeq && nodes[index] <= op.endSeq) nodes.splice(index, 1);
        }
        nodes.push(event.seq);
      }
      return event;
    },
    deriveMessages() {
      const onSurface = new Set(nodes);
      return log.filter((event) => onSurface.has(event.seq))
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
  // 官方会话对象带 id，按文本定位依赖它。
  if (session && !session.id) session.id = sessionId;
  const services = {
    sessions: {
      get: (id) => (id === sessionId ? session : undefined),
      list: () => (session ? [session] : []),
    },
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

test('撤回一条：区间正确、表面真的变了、原文回传', async () => {
  const sessionId = 'session-test';
  const session = makeSession([
    userEvent(0, 'u1', '第一条'),
    assistantEvent(1, 'a1', '回复一'),
    userEvent(2, 'u2', '第二条'),
    assistantEvent(3, 'a2', '回复二'),
  ]);
  const ctx = makeCtx(session, sessionId);

  const before = [...session.surface.nodes];
  assert.deepEqual(before, [0, 1, 2, 3]);

  const result = await registerRecall.recall(ctx, { sessionId, seq: 2, scope: 'from' });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.startSeq, 2);
  assert.equal(result.endSeq, 3);
  assert.equal(result.text, '第二条');
  assert.equal(result.cleared, true, '派生消息里不应再残留原文');

  // 表面：0,1 保留，2,3 被移除，最后是撤回标记。
  const after = session.surface.nodes;
  assert.ok(!after.includes(2), '目标必须离开表面');
  assert.ok(!after.includes(3), '其后节点必须离开表面');
  assert.deepEqual(after.slice(0, 2), [0, 1]);

  // 派生缓存必须被清掉（否则请求带旧历史会被拒）。
  assert.deepEqual(session.derived, []);
  assert.equal(session.derivedNodes, 0);
  assert.equal(session.derivedGeneration, -1);
});

test('scope=only 撤回本条及其助手回复，后续提问保留', async () => {
  const sessionId = 'session-only';
  const session = makeSession([
    userEvent(0, 'u1', '第一条'),
    assistantEvent(1, 'a1', '回复一'),
    userEvent(2, 'u2', '第二条'),
    assistantEvent(3, 'a2', '回复二'),
  ]);
  const ctx = makeCtx(session, sessionId);

  const result = await registerRecall.recall(ctx, { sessionId, seq: 2, scope: 'only' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.startSeq, 2);
  assert.equal(result.endSeq, 3, '必须连它引出的助手回复一起撤');
  assert.equal(result.recalledCount, 2, '用户消息 + 助手回复');

  const after = session.surface.nodes;
  assert.ok(!after.includes(2), '目标离开表面');
  assert.ok(!after.includes(3), '助手回复也离开表面');
  assert.ok(after.includes(0) && after.includes(1), '更早的一轮保留');
});

test('系统提示永不被撤回', async () => {
  const sessionId = 'session-sys';
  const session = makeSession([
    { type: 'system/message', seq: 0, time: 1, surfaceOp: 'append', data: { turn: 0, step: 0, content: [{ type: 'text', text: 'sys' }] } },
    userEvent(1, 'u1', '你好'),
    assistantEvent(2, 'a1', '你好'),
  ]);
  const ctx = makeCtx(session, sessionId);

  const result = await registerRecall.recall(ctx, { sessionId, seq: 1 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.startSeq, 1);
  assert.ok(session.surface.nodes.includes(0), 'system/message 必须留在表面');
});

test('重复撤回同一位置返回 already-recalled', async () => {
  const sessionId = 'session-dup';
  const session = makeSession([
    userEvent(0, 'u1', '要撤回'),
    assistantEvent(1, 'a1', '收到'),
  ]);
  const ctx = makeCtx(session, sessionId);

  const first = await registerRecall.recall(ctx, { sessionId, seq: 0, scope: 'from' });
  assert.equal(first.ok, true, JSON.stringify(first));

  const second = await registerRecall.recall(ctx, { sessionId, seq: 0, scope: 'from' });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'already-recalled');
});

test('默认范围是 only：撤回本条及助手回复，不清空后续提问', async () => {
  const sessionId = 'session-default-only';
  const session = makeSession([
    userEvent(0, 'u1', '第一条'),
    assistantEvent(1, 'a1', '回复一'),
    userEvent(2, 'u2', '第二条'),
    assistantEvent(3, 'a2', '回复二'),
  ]);
  const ctx = makeCtx(session, sessionId);

  const result = await registerRecall.recall(ctx, { sessionId, seq: 0 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.scope, 'only', '默认必须是 only');
  assert.equal(result.startSeq, 0);
  assert.equal(result.endSeq, 1, '只覆盖这一轮（提问 + 回复）');

  const after = session.surface.nodes;
  assert.ok(!after.includes(0), '目标离开表面');
  assert.ok(after.includes(2) && after.includes(3), '后续一轮必须保留');
});

test('按 messageId 精确定位（客户端主路径）', async () => {
  const sessionId = 'session-by-id';
  const session = makeSession([
    userEvent(0, 'id-a', '同样的文字'),
    assistantEvent(1, 'a1', '回复'),
    userEvent(2, 'id-b', '同样的文字'),
  ]);
  const ctx = makeCtx(session, sessionId);

  const result = await registerRecall.recall(ctx, { sessionId, messageId: 'id-b', scope: 'only' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.startSeq, 2, '必须命中 id-b 这条，而不是同文本的另一条');
});

test('按文本定位可以撤回（必须指定会话）', async () => {
  const sessionId = 'session-text';
  const session = makeSession([
    userEvent(0, 'u1', '第一条'),
    assistantEvent(1, 'a1', '回复一'),
    userEvent(2, 'u2', '要撤回的这句'),
  ]);
  const ctx = makeCtx(session, sessionId);

  const result = await registerRecall.recall(ctx, { sessionId, text: '要撤回的这句', scope: 'only' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.startSeq, 2);
  assert.equal(result.text, '要撤回的这句');
});

test('不带会话 id 时拒绝执行，避免跨会话误命中', async () => {
  const sessionId = 'session-no-id';
  const session = makeSession([userEvent(0, 'u1', '要撤回')]);
  const ctx = makeCtx(session, sessionId);

  const result = await registerRecall.recall(ctx, { text: '要撤回', scope: 'only' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no-session');
});

test('status 只列出仍在表面上的用户消息', async () => {
  const sessionId = 'session-status';
  const session = makeSession([
    userEvent(0, 'u1', '保留'),
    assistantEvent(1, 'a1', '好的'),
  ]);
  const ctx = makeCtx(session, sessionId);

  const before = await registerRecall.status(ctx, { sessionId });
  assert.equal(before.ok, true);
  assert.deepEqual(before.recallable.map((row) => row.seq), [0]);

  await registerRecall.recall(ctx, { sessionId, seq: 0 });
  const after = await registerRecall.status(ctx, { sessionId });
  assert.deepEqual(after.recallable.map((row) => row.seq), []);
});
