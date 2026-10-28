/**
 * 只读诊断：打印模型实际会收到的消息（派生消息尾部）。
 *
 * 判断撤回是否真的进了模型上下文，只看这个。
 */
const base = process.argv[2];

const response = await fetch(`${base}/derived`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tail: 10 }),
  signal: AbortSignal.timeout(25000),
});
const data = await response.json();

if (!data?.ok) {
  console.log('derived 失败:', JSON.stringify(data).slice(0, 200));
  process.exit(1);
}

for (const session of data.sessions ?? []) {
  console.log(`\n会话 ${session.sessionId}`);
  if (session.error) {
    console.log('  错误:', session.error);
    continue;
  }
  console.log(`  表面节点=${session.surfaceNodes}  模型消息数=${session.messageCount}`);
  console.log(`  角色分布=${JSON.stringify(session.roles)}`);
  for (const message of session.tail ?? []) {
    const text = String(message.text).replace(/\s+/g, ' ').slice(0, 60);
    console.log(`  [${message.role}] ${text}`);
  }
}
