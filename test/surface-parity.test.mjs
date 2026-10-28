/**
 * 与官方 foldSurface 交叉验证：撤回插件的表面折叠必须与 DSH 内核一致。
 *
 * 运行：node test/surface-parity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { foldSurfaceNodes } from '../src/recall.js';

/** 定位本机 DSH 内核里官方 surface 模块（用于交叉验证）。 */
const DSH_KERNEL = process.env.DSH_KERNEL_SURFACE
  ?? 'F:/AllSoftware/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js';

async function loadOfficialSurface() {
  const module = await import(pathToFileURL(path.resolve(DSH_KERNEL)).href);
  return module;
}

const surfaceApi = await loadOfficialSurface();
const foldSurface = surfaceApi.foldSurface;
const deriveEventMessage = surfaceApi.deriveEventMessage;

/** 造一条与 DSH 内核一致的事件序列。 */
function buildLog(specs) {
  return specs.map((spec, index) => {
    const event = {
      type: spec.type,
      seq: index,
      time: 1700000000000 + index * 1000,
      data: spec.data,
      surfaceOp: spec.surfaceOp ?? 'append',
    };
    if (spec.sourceEventSeqs !== undefined) event.sourceEventSeqs = spec.sourceEventSeqs;
    return event;
  });
}

const userData = (id, text) => ({
  id,
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
});

const assistantData = (id, text) => ({
  message: {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
  },
});

const systemData = () => ({
  turn: 0,
  step: 0,
  content: [{ type: 'text', text: 'system prompt' }],
});

test('官方 foldSurface 与插件折叠结果一致（单次撤回）', () => {
  const log = buildLog([
    { type: 'system/message', data: systemData() },
    { type: 'user/message', data: userData('u1', '第一条') },
    { type: 'assistant/message', data: assistantData('a1', '回复一') },
    { type: 'user/message', data: userData('u2', '第二条') },
    { type: 'assistant/message', data: assistantData('a2', '回复二') },
    {
      type: 'user/message',
      data: userData('recall-1', ''),
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 },
      sourceEventSeqs: [3, 4],
    },
  ]);

  const official = foldSurface(log);
  const mine = foldSurfaceNodes(log);

  assert.deepEqual(mine, [...official.nodes].map(Number).sort((a, b) => a - b));
  // 撤回点之前的内容必须完整保留。
  assert.ok(mine.includes(0));
  assert.ok(mine.includes(1));
  assert.ok(mine.includes(2));
  // 被撤回的区间必须消失。
  assert.ok(!mine.includes(3));
  assert.ok(!mine.includes(4));
});

test('官方 foldSurface 与插件折叠结果一致（无撤回）', () => {
  const log = buildLog([
    { type: 'system/message', data: systemData() },
    { type: 'user/message', data: userData('u1', '你好') },
    { type: 'assistant/message', data: assistantData('a1', '你好，有什么可以帮你？') },
  ]);

  const official = foldSurface(log);
  const mine = foldSurfaceNodes(log);

  assert.deepEqual(mine, [...official.nodes].map(Number).sort((a, b) => a - b));
  assert.equal(mine.length, 3);
});

test('撤回标记自身不产生模型消息', async () => {
  const log = buildLog([
    { type: 'system/message', data: systemData() },
    { type: 'user/message', data: userData('u1', '要撤回的话') },
    {
      type: 'user/message',
      data: userData('recall-2', ''),
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
      sourceEventSeqs: [1],
    },
  ]);

  const folded = foldSurface(log);

  // 表面节点：0（system）与 2（撤回标记），被撤回的 1 已不在表面。
  assert.deepEqual([...folded.nodes].map(Number).sort((a, b) => a - b), [0, 2]);

  // 撤回标记自身是 user/message，必须靠 id 前缀在派生时被过滤；
  // 这里确认内核把它识别为普通 user 消息，因此插件的 derive 过滤是必需的。
  const markerMessage = deriveEventMessage(log[2]);
  assert.equal(markerMessage?.id, 'recall-2');

  // 被撤回的那条不得出现在表面节点里。
  assert.ok(![...folded.nodes].map(Number).includes(1));
});
