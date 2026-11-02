/**
 * 锁定客户端按钮挂载策略。
 *
 * 历史教训：曾用 data-chat-flow-kind='user' 选节点，但官方取值在不同版本
 * 里是 user / input-message / steering 不一，导致按钮时有时无。
 * 现在改为「按官方操作条反查」：用户消息的操作条里必有复制按钮。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client.cjs');
const source = fs.readFileSync(clientPath, 'utf8');

test('按操作条反查用户消息，不依赖 flow-kind', () => {
  assert.ok(source.includes("_actions"), '必须通过官方操作条类名定位');
  assert.ok(
    !source.includes("data-chat-flow-kind='user'")
      && !source.includes("data-chat-flow-kind='input-message'"),
    '不得再依赖 data-chat-flow-kind（各版本取值不一致）',
  );
});

test('以复制按钮作为用户消息的判定特征', () => {
  assert.ok(/复制|copy/i.test(source), '必须用复制按钮的 aria-label 判定');
});

test('支持撤回排队中的消息', () => {
  assert.ok(source.includes('data-pending-steering'), '必须识别排队气泡');
  assert.ok(source.includes('recallPending'), '必须有排队消息撤回文案');
  assert.ok(source.includes('pending: true'), '排队撤回必须走 pending 通道');
});
