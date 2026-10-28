/**
 * 交叉验证：本插件写出的标记，能否被客户端 uiConversation 的剔除规则识别。
 *
 * 直接调用官方（已被 dsh-purge 规则增强过的）rewindVisibleEntries 语义：
 * 这里复刻它的判定条件，确保标记前缀与 surfaceOp 形状都对得上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientConversation = 'F:/AllSoftware/DeepSeek Harness/resources/app/dsh/node_modules/'
  + '@deepseek-ai/dsh-client-ui-conversation/lib/client.js';

/** 官方判定：这条事件是不是「回退标记」。 */
function isRewindMarker(event) {
  if (!event || event.type !== 'user/message') return false;
  const id = event.data && event.data.id;
  if (typeof id !== 'string' || id.indexOf('rewind-') !== 0) return false;
  const op = event.surfaceOp;
  return Boolean(op) && op !== 'append' && op.op === 'replace';
}

test('客户端剔除规则确实按 rewind- 前缀工作', () => {
  const source = fs.readFileSync(clientConversation, 'utf8');
  assert.ok(
    source.includes('"rewind-"') || source.includes("'rewind-'"),
    '客户端应包含 rewind- 前缀判定',
  );
  const marker = {
    type: 'user/message',
    seq: 99,
    data: { id: 'rewind-abc-2' },
    surfaceOp: { op: 'replace', startSeq: 10, endSeq: 12 },
  };
  assert.equal(isRewindMarker(marker), true, '我们的标记必须被客户端识别');
});

test('撤回事件的前缀与 surfaceOp 形状符合客户端规则', async () => {
  const { registerRecall } = await import('../src/recall.js');

  const log = [
    { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第一条' }] } },
    { type: 'assistant/message', seq: 1, time: 2, surfaceOp: 'append', data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '回复' }] } } },
    { type: 'user/message', seq: 2, time: 3, surfaceOp: 'append', data: { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第二条' }] } },
  ];
  const nodes = [0, 1, 2];

  const session = {
    id: 'session-prefix',
    snapshotEvents: () => log,
    surface: { get nodes() { return [...nodes]; } },
    append(type, data, opts) {
      const event = { type, seq: log.length, time: Date.now(), data, ...opts };
      log.push(event);
      const op = opts?.surfaceOp;
      if (!op || op === 'append') nodes.push(event.seq);
      else if (op.op === 'replace') {
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          if (nodes[i] >= op.startSeq && nodes[i] <= op.endSeq) nodes.splice(i, 1);
        }
        nodes.push(event.seq);
      }
      return event;
    },
    // 按当前表面节点投影消息，供 host 的上下文校验使用。
    deriveMessages() {
      return nodes
        .map((seq) => log[seq])
        .filter((event) => event && (event.type === 'user/message' || event.type === 'assistant/message'))
        .map((event) => ({
          id: event.data?.id ?? event.data?.message?.id,
          role: event.type === 'user/message' ? 'user' : 'assistant',
          content: event.data?.content ?? event.data?.message?.content ?? [],
        }));
    },
  };

  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: () => session, list: () => [session] };
      if (name === 'agents') return { get: () => ({ phase: { kind: 'idle' }, inbox: { nextTurn: [], nextStep: [] } }) };
      if (name === 'sessionController') return { updateQueue: async () => {} };
      throw new Error(`unknown service ${name}`);
    },
  };

  const result = await registerRecall.recall(ctx, { sessionId: 'session-prefix', seq: 2, scope: 'only' });
  assert.equal(result.ok, true, JSON.stringify(result));

  const marker = log.find((event) => String(event.data?.id ?? '').startsWith('rewind-'));
  assert.ok(marker, '必须写出 rewind- 前缀的标记事件');
  assert.equal(isRewindMarker(marker), true, '标记必须被客户端剔除规则识别');
});
