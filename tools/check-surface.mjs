/**
 * 检查指定文本是否还在会话表面上。
 *
 * 用来区分两种情况：
 *   - 已离开表面 => 撤回成功，只是界面没刷新
 *   - 仍在表面   => 撤回根本没生效
 */
const base = process.argv[2];
const needle = process.argv[3] ?? '为什么叫我YG';

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

const status = await post('/status', { limit: 15 });
if (!status.body?.ok) {
  console.log('status 失败:', JSON.stringify(status.body).slice(0, 200));
  process.exit(1);
}

console.log('会话 =', status.body.sessionId);
console.log('表面节点 =', status.body.surfaceNodes, ' 事件 =', status.body.totalEvents);

const rows = status.body.recallable ?? [];
const hit = rows.find((row) => String(row.text).includes(needle));
console.log(`查「${needle}」在可撤回列表(最近 ${rows.length} 条)里:`, hit ? `在 seq=${hit.seq}` : '不在');

// 再查它是否还残留在整份事件里（不在表面 = 已撤回）
const all = await post('/status', { limit: 9999 });
const allRows = all.body?.recallable ?? [];
const inAll = allRows.some((row) => String(row.text).includes(needle));
console.log('在全部可撤回条目里:', inAll ? '仍在表面（撤回没生效）' : '已离开表面（撤回成功，界面没刷新）');
console.log('可撤回总数 =', allRows.length);
