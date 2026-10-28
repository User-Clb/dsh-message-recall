/**
 * 只读：完整列出某个会话的表面节点与模型消息，用于定位「为什么内容还在」。
 */
const base = process.argv[2];
const target = process.argv[3] ?? '';

const post = async (path, payload) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(30000),
  });
  return await response.json();
};

const data = await post('/derived', { sessionId: target, tail: 40 });
for (const session of data.sessions ?? []) {
  console.log(`会话 ${session.sessionId}`);
  console.log(`  表面节点=${session.surfaceNodes} 模型消息=${session.messageCount}`);
  console.log(`  角色=${JSON.stringify(session.roles)}`);
  console.log('  --- 模型消息（尾部）---');
  for (const message of session.tail ?? []) {
    console.log(`  [${message.role}] ${String(message.text).replace(/\s+/g, ' ').slice(0, 90)}`);
  }
}

const status = await post('/status', { sessionId: target, limit: 40 });
console.log('\n--- 可撤回的用户消息 ---');
for (const row of status.recallable ?? []) {
  console.log(`  seq=${row.seq} ${JSON.stringify(String(row.text).slice(0, 50))}`);
}
