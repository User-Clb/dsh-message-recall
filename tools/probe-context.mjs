/**
 * 真机核查：模型实际收到的消息里是否还含有指定内容。
 *
 * 这是「撤回是否真进上下文」的最终判定。
 * 用法：node tools/probe-context.mjs <base-url> <关键词>
 */
const base = process.argv[2];
const needle = process.argv[3] ?? '7788';

const response = await fetch(`${base}/derived`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tail: 200 }),
  signal: AbortSignal.timeout(30000),
});
const data = await response.json();

let found = false;
for (const session of data.sessions ?? []) {
  if (session.error) continue;
  console.log(`会话 ${session.sessionId.slice(0, 24)}  表面=${session.surfaceNodes}  模型消息=${session.messageCount}`);

  for (const message of session.tail ?? []) {
    const text = String(message.text ?? '');
    if (!text.includes(needle)) continue;
    found = true;
    console.log(`  ⚠️ 命中 角色=${message.role}`);
    console.log(`     内容: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
}

console.log(found
  ? `\n结论: 模型消息里仍有「${needle}」→ 撤回没进上下文`
  : `\n结论: 模型消息里已无「${needle}」→ 撤回已进上下文`);
