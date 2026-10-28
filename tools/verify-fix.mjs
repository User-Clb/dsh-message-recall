/**
 * 修复验证：确认「默认只撤本条」与「跨度安全闸」都真的生效。
 *
 * 对真实进程执行，覆盖两种场景：
 *   A. 不带 scope => 只遮蔽 1 个节点
 *   B. 强行要求 from 且起点在很早的位置 => 被安全闸拒绝
 */
const base = process.argv[2];

const post = async (path, payload, timeoutMs = 30000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal,
    });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};

const status = await post('/status', { limit: 30 });
if (!status?.ok) {
  console.log('status 失败:', JSON.stringify(status).slice(0, 200));
  process.exit(1);
}
const sessionId = status.sessionId;
console.log(`会话=${sessionId}  表面节点=${status.surfaceNodes}`);

const rows = status.recallable ?? [];
console.log(`可撤回条目=${rows.length}`);
if (rows.length === 0) {
  console.log('没有可撤回条目');
  process.exit(0);
}

// A. 默认范围：拿最后一条，不带 scope。
const last = rows[rows.length - 1];
console.log(`\n[A] 默认范围测试  seq=${last.seq} 文本=${JSON.stringify(String(last.text).slice(0, 20))}`);
const a = await post('/recall', { sessionId, messageId: last.messageId });
console.log(`   => ok=${a.ok} scope=${a.scope ?? '-'} 遮蔽=${a.recalledCount ?? '-'} 起=${a.startSeq ?? '-'} 止=${a.endSeq ?? '-'}`);
if (a.ok && a.scope !== 'only') console.log('   ❌ 默认范围不是 only');
else if (a.ok) console.log('   ✅ 默认只撤本条');

// B. 安全闸：故意用很早的一条做 from。
const status2 = await post('/status', { limit: 40 });
const rows2 = status2.recallable ?? [];
if (rows2.length >= 2) {
  const earliest = rows2[0];
  console.log(`\n[B] 跨度安全闸测试  seq=${earliest.seq}（最靠前的一条，要求 from）`);
  const b = await post('/recall', { sessionId, messageId: earliest.messageId, scope: 'from' });
  if (b.ok) {
    const span = Number(b.endSeq) - Number(b.startSeq) + 1;
    const half = Math.ceil(status2.surfaceNodes * 0.5);
    console.log(`   ok=true 跨度=${span} 半场阈值=${half}`);
    console.log(span > half ? '   ❌ 超大跨度未被拦截' : '   ✅ 跨度在允许范围');
  } else {
    console.log(`   ok=false code=${b.code} message=${b.message}`);
    console.log(b.code === 'span-too-large' ? '   ✅ 超大跨度被安全闸拦下' : '   ⚠️ 因其它原因失败');
  }
}
