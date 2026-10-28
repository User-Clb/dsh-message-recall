/**
 * 撤回逻辑离线自测：用真实会话日志验证 foldSurfaceNodes 与截断语义。
 *
 * 运行：node test/recall.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldSurfaceNodes } from '../src/recall.js';

/** 造一条最小可用的事件序列。 */
function events(specs) {
  return specs.map((spec, index) => ({
    type: spec.type ?? 'user/message',
    seq: index,
    time: 1000 + index,
    data: spec.data ?? { id: `m${index}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `t${index}` }] },
    ...(spec.surfaceOp === undefined ? { surfaceOp: 'append' } : { surfaceOp: spec.surfaceOp }),
    ...(spec.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: spec.sourceEventSeqs }),
  }));
}

test('foldSurfaceNodes 保留 append 节点', () => {
  const log = events([
    { type: 'system/message' },
    { type: 'user/message' },
    { type: 'assistant/message' },
  ]);
  assert.deepEqual(foldSurfaceNodes(log), [0, 1, 2]);
});

test('foldSurfaceNodes 用 replace 遮蔽闭区间', () => {
  const log = events([
    { type: 'system/message' },              // 0
    { type: 'user/message' },                // 1
    { type: 'assistant/message' },           // 2
    { type: 'user/message' },                // 3
    { type: 'assistant/message' },           // 4
    {
      type: 'user/message',                  // 5 撤回标记：遮蔽 3..4
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 },
      sourceEventSeqs: [3, 4],
      data: { id: 'recall-a', role: 'user', source: { kind: 'user' }, content: [] },
    },
  ]);
  assert.deepEqual(foldSurfaceNodes(log), [0, 1, 2, 5]);
});

test('foldSurfaceNodes 支持连续撤回归纳', () => {
  const log = events([
    { type: 'system/message' },              // 0
    { type: 'user/message' },                // 1
    { type: 'assistant/message' },           // 2
    {
      type: 'user/message',                  // 3 第一次撤回：遮蔽 1..2
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
      sourceEventSeqs: [1, 2],
      data: { id: 'recall-b', role: 'user', source: { kind: 'user' }, content: [] },
    },
    { type: 'user/message' },                // 4 新消息
    {
      type: 'user/message',                  // 5 第二次撤回：遮蔽 3..4
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 },
      sourceEventSeqs: [3, 4],
      data: { id: 'recall-c', role: 'user', source: { kind: 'user' }, content: [] },
    },
  ]);
  // 0 保留；1,2 被第一次撤回遮蔽；3,4 被第二次撤回遮蔽；5 是当前标记。
  assert.deepEqual(foldSurfaceNodes(log), [0, 5]);
});

test('无撤回标记时行为与纯 append 一致', () => {
  const log = events([
    { type: 'user/message' },
    { type: 'tool/result' },
    { type: 'assistant/message' },
  ]);
  const folded = foldSurfaceNodes(log);
  assert.equal(folded.length, 3);
  assert.deepEqual(folded, [...folded].sort((a, b) => a - b));
});
