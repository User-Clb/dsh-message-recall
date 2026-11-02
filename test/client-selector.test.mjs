/**
 * 锁定客户端按钮挂载条件：必须匹配官方用户消息的 kind。
 *
 * 这条测试是为了防止「选择器写成 user 而官方是 input-message」
 * 这类错误再次发生（表现为按钮时有时无）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client.cjs');

/** 官方 ui-chat 里用户消息的 flow kind。 */
const OFFICIAL_USER_KIND = 'input-message';

test('按钮选择器包含官方用户消息 kind', () => {
  const source = fs.readFileSync(clientPath, 'utf8');
  assert.ok(
    source.includes(`data-chat-flow-kind='${OFFICIAL_USER_KIND}'`)
      || source.includes(`data-chat-flow-kind="${OFFICIAL_USER_KIND}"`),
    `选择器必须匹配官方 kind "${OFFICIAL_USER_KIND}"`,
  );
});

test('按钮选择器不再使用错误的 user kind', () => {
  const source = fs.readFileSync(clientPath, 'utf8');
  assert.ok(
    !source.includes("data-chat-flow-kind='user'"),
    "不得使用 data-chat-flow-kind='user'（官方没有这个取值）",
  );
});

test('挂载前会检查是否已挂载，避免重复按钮', () => {
  const source = fs.readFileSync(clientPath, 'utf8');
  assert.ok(source.includes('MOUNT'), '必须有挂载标记');
  assert.ok(source.includes('continue'), '已挂载时必须跳过');
});
