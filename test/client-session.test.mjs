/**
 * 锁定会话 id 的获取方式。
 *
 * 历史教训：曾用「取事件最多的会话」兜底，多会话并存时取错，
 * 表现是撤回报「没找到要撤回的消息」。必须从 DOM 精确取。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'client.cjs'), 'utf8');

test('从 data-conversation-session 精确取会话 id', () => {
  assert.ok(source.includes('data-conversation-session'), '必须使用官方 DOM 属性');
  assert.ok(source.includes('closest('), '必须从触发元素向上定位');
});

test('不再用「事件最多的会话」猜测', () => {
  assert.ok(
    !source.includes('bestCount'),
    '不得用事件数量猜会话（多会话并存时会取错）',
  );
});

test('撤回请求必须带 sessionId', () => {
  assert.ok(source.includes('sessionId,'), '撤回载荷必须包含 sessionId');
});
