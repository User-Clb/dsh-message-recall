/**
 * 实测：不同文本形态能否被宿主定位到。
 *
 * 用于判断「没找到要撤回的消息」是文本不一致造成的。
 */
const base = process.argv[2] ?? 'http://127.0.0.1:57171/dsh-message-recall';

const status = await (await fetch(`${base}/status`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})).json();

const rows = status.recallable ?? [];
console.log('可撤回条目 =', rows.length);

// 取最后一条真实原文，模拟客户端取文本的几种可能。
const last = rows[rows.length - 1];
if (!last) {
  console.log('没有可撤回条目');
  process.exit(0);
}

const raw = last.text;
console.log('原文 =', JSON.stringify(raw));

const variants = [
  { label: '完全一致', text: raw },
  { label: '去首尾空白', text: raw.trim() },
  { label: '压缩空白', text: raw.replace(/\s+/g, ' ') },
  { label: '连接所有空白', text: raw.replace(/\s+/g, '') },
  { label: '前10字', text: raw.slice(0, 10) },
  { label: '加尾随空格', text: `${raw} ` },
];

for (const item of variants) {
  try {
    const response = await fetch(`${base}/recall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: item.text, scope: 'only' }),
    });
    const body = await response.json();
    console.log(
      `${item.label.padEnd(12)} => ok=${body.ok} code=${body.code ?? '-'} seq=${body.startSeq ?? '-'}`,
    );
    if (body.ok) break;
  } catch (error) {
    console.log(`${item.label.padEnd(12)} => ERR ${error.message}`);
  }
}
