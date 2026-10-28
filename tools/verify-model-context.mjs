/**
 * 真机实验：撤回后立刻对比派生消息数量，确认模型上下文是否真的少了内容。
 *
 * 这是「撤回是否真的进到模型」的判定实验。
 */
const base = process.argv[2];

const post = async (path, payload, timeoutMs = 40000) => {
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

const before = await post('/derived', { tail: 6 });
const target = (before.sessions ?? []).find((row) => !row.error);
console.log(`撤回前: 表面节点=${target.surfaceNodes} 模型消息=${target.messageCount}`);

const status = await post('/status', { limit: 5 });
const rows = status.recallable ?? [];
if (rows.length === 0) {
  console.log('没有可撤回条目');
  process.exit(0);
}

const last = rows[rows.length - 1];
console.log(`目标: seq=${last.seq} 文本=${JSON.stringify(String(last.text).slice(0, 25))}`);

const recall = await post('/recall', { sessionId: status.sessionId, messageId: last.messageId });
console.log(`撤回: ok=${recall.ok} scope=${recall.scope} 遮蔽=${recall.recalledCount}`);

const after = await post('/derived', { tail: 6 });
const target2 = (after.sessions ?? []).find((row) => !row.error);
console.log(`撤回后: 表面节点=${target2.surfaceNodes} 模型消息=${target2.messageCount}`);

const delta = target.messageCount - target2.messageCount;
console.log(`模型消息减少 = ${delta}`);
console.log(delta > 0 ? '✅ 撤回真的进了模型上下文' : '❌ 模型上下文没有变化（撤回是假的）');

// 检查被撤回的文本是否还在模型消息里
const needle = String(last.text).replace(/\s+/g, ' ').trim();
const stillInModel = (target2.tail ?? []).some((row) => String(row.text).includes(needle.slice(0, 10)));
console.log(`被撤回文本仍出现在模型消息尾部: ${stillInModel ? '是 ❌' : '否 ✅'}`);
