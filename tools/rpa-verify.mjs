/**
 * 真机验证：在**指定会话**内按文本撤回，并前后对比表面。
 *
 * 用法：node tools/rpa-verify.mjs <base-url> [sessionId]
 */
const base = process.argv[2];
const explicitSession = process.argv[3];
if (!base) {
  console.error('用法: node tools/rpa-verify.mjs <base-url> [sessionId]');
  process.exit(2);
}

const post = async (path, payload, timeoutMs = 25000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    clearTimeout(timer);
  }
};

// 先确定会话：显式传入优先，否则用 status 的兜底结果。
const probe = await post('/status', { sessionId: explicitSession ?? '', limit: 5 });
if (!probe.body?.ok) {
  console.log('status 失败:', JSON.stringify(probe.body).slice(0, 200));
  process.exit(1);
}
const sessionId = explicitSession ?? probe.body.sessionId;
console.log('会话 =', sessionId);

const before = await post('/status', { sessionId, limit: 10 });
const rows = before.body?.recallable ?? [];
console.log(`撤回前: 表面节点=${before.body?.surfaceNodes} 事件=${before.body?.totalEvents} 可撤回=${rows.length}`);
if (rows.length === 0) {
  console.log('该会话没有可撤回条目');
  process.exit(0);
}

const target = rows[rows.length - 1];
console.log(`目标: seq=${target.seq} 文本=${JSON.stringify(String(target.text).slice(0, 30))}`);

// 关键：带 sessionId，只在当前会话内定位。
const result = await post('/recall', {
  sessionId,
  text: target.text,
  scope: 'only',
}, 45000);
console.log('撤回返回:', JSON.stringify(result.body).slice(0, 240));

const after = await post('/status', { sessionId, limit: 10 });
const still = (after.body?.recallable ?? []).some((row) => row.seq === target.seq);
console.log(`撤回后: 表面节点=${after.body?.surfaceNodes} 事件=${after.body?.totalEvents}`);
console.log(still ? '结果: 失败，目标仍在表面' : '结果: 成功，目标已离开表面');
process.exit(still ? 2 : 0);
