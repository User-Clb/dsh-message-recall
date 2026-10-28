/**
 * 宿主半端到端验证：用假 ctx + 真会话对象模拟一次完整撤回，
 * 确认 append 被调用、区间正确、原文回传、模型派生被过滤。
 *
 * 运行：node test/host-recall.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerRecall } from '../src/recall.js';

/** 造一个最小可用的假 Session（只有插件会用到的成员）。 */
function makeSession(events) {
  const log = [...events];
  const appended = [];
  // 与真实 Session 一致：surface.nodes 会随 append 的 surfaceOp 折叠。
  const nodes = events.map((event) => event.seq);
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
      // 折叠表面。
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
      return log.filter((event) => event.type === 'user/message' || event.type === 'assistant/message');
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

/** 构造假 ctx：sessions / agents / sessionController 都从同一张表取。 */
function makeCtx(session, sessionId) {
  const removed = [];
  const services = {
    sessions: { get: (id) => (id === sessionId ? session : undefined) },
    agents: { get: () => ({ phase: { kind: 'idle' }, inbox: { nextTurn: [], nextStep: [] } }) },
    sessionController: {
      updateQueue: async (request) => {
        removed.push(request);
      },
    },
  };
  return {
    removed,
    get(name) {
      if (name in services) return services[name];
      throw new Error(`unknown service ${name}`);
    },
  };
}

test('撤回一条用户消息：区间正确、原文回传、标记被派生过滤', async () => {
  const sessionId = 'session-test';
  const session = makeSession([
    userEvent(0, 'u1', '第一条'),
    assistantEvent(1, 'a1', '回复一'),
    userEvent(2, 'u2', '第二条'),
    assistantEvent(3, 'a2', '回复二'),
  ]);
  const ctx = makeCtx(session, sessionId);

  const result = await registerRecall.recall(ctx, { sessionId, seq: 2 });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.startSeq, 2);
  assert.equal(result.endSeq, 3);
  assert.equal(result.text, '第二条', '原文必须回传给输入框');
  assert.equal(result.recalledCount, 2);

  // 追加了一条表面替换事件。
  assert.equal(session.appended.length, 1);
  const marker = session.appended[0];
  assert.equal(marker.type, 'user/message');
  assert.deepEqual(marker.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 3 });
  assert.deepEqual(marker.sourceEventSeqs, [2, 3]);
  assert.ok(String(marker.data.id).startsWith('recall-'));

  // 派生消息里不得残留撤回标记。
  const derived = session.deriveMessages();
  assert.ok(
    derived.every((message) => !String(message?.id ?? '').startsWith('recall-')),
    '撤回标记不得进入模型消息',
  );
});

test('撤回首条消息时保留系统提示（startSeq 不小于首个表面节点）', async () => {
  const sessionId = 'session-test-2';
  const session = makeSession([
    { type: 'system/message', seq: 0, time: 1, surfaceOp: 'append', data: { turn: 0, step: 0, content: [{ type: 'text', text: 'sys' }] } },
    userEvent(1, 'u1', '你好'),
    assistantEvent(2, 'a1', '你好'),
  ]);
  const ctx = makeCtx(session, sessionId);

  const result = await registerRecall.recall(ctx, { sessionId, seq: 1 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.startSeq, 1, '系统提示必须留在表面之外');
  assert.equal(result.endSeq, 2);
});

test('重复撤回同一位置返回 already-recalled', async () => {
  const sessionId = 'session-test-3';
  const session = makeSession([
    userEvent(0, 'u1', '要撤回'),
    assistantEvent(1, 'a1', '收到'),
  ]);
  const ctx = makeCtx(session, sessionId);

  const first = await registerRecall.recall(ctx, { sessionId, seq: 0 });
  assert.equal(first.ok, true);

  // 第二次：0 已在遮蔽区间内，表面只剩撤回标记。
  const second = await registerRecall.recall(ctx, { sessionId, seq: 0 });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'already-recalled');
});

test('status 只列出仍在表面上的用户消息', async () => {
  const sessionId = 'session-test-4';
  const session = makeSession([
    userEvent(0, 'u1', '保留'),
    assistantEvent(1, 'a1', '好的'),
  ]);
  const ctx = makeCtx(session, sessionId);

  const before = await registerRecall.status(ctx, { sessionId });
  assert.equal(before.ok, true);
  assert.deepEqual(before.recallable.map((item) => item.seq), [0]);

  await registerRecall.recall(ctx, { sessionId, seq: 0 });
  const after = await registerRecall.status(ctx, { sessionId });
  assert.deepEqual(after.recallable.map((item) => item.seq), []);
});

test('scope=only 只撤这一条，后续消息保留', async () => {
  const sessionId = 'session-test-5';
  const session = makeSession([
    userEvent(0, 'u1', '第一条'),
    assistantEvent(1, 'a1', '回复一'),
    userEvent(2, 'u2', '第二条'),
    assistantEvent(3, 'a2', '回复二'),
  ]);
  const ctx = makeCtx(session, sessionId);

  const result = await registerRecall.recall(ctx, { sessionId, seq: 2, scope: 'only' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.scope, 'only');
  assert.equal(result.startSeq, 2);
  assert.equal(result.endSeq, 2, '仅撤回本条时区间只覆盖这一个节点');
  assert.equal(result.recalledCount, 1);
  assert.equal(result.text, '第二条');

  // 第一条、回复一、回复二 都仍在表面上。
  const after = await registerRecall.status(ctx, { sessionId });
  assert.deepEqual(after.recallable.map((item) => item.seq), [0]);
});

test('scope=from 是默认行为，撤回本条及其之后', async () => {
  const sessionId = 'session-test-6';
  const session = makeSession([
    userEvent(0, 'u1', '第一条'),
    assistantEvent(1, 'a1', '回复一'),
    userEvent(2, 'u2', '第二条'),
    assistantEvent(3, 'a2', '回复二'),
  ]);
  const ctx = makeCtx(session, sessionId);

  const result = await registerRecall.recall(ctx, { sessionId, seq: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'from');
  assert.equal(result.startSeq, 2);
  assert.equal(result.endSeq, 3);
  assert.equal(result.recalledCount, 2);
});
