/**
 * 只读核查：用官方 zstd 流式解码读取整个会话日志，
 * 统计撤回标记及其遮蔽跨度。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PassThrough } from 'node:stream';

const root = 'C:/Users/Revision-Extra/.dsh/sessions/--G-laboratory--';
const sid = process.argv[2] ?? 'session-a9a3ab5e-4b43-430d-8738-75507038f5cd';
const file = path.join(root, sid, 'session.v4.jsonl.zstd');

if (!fs.existsSync(file)) {
  console.log('missing', file);
  process.exit(1);
}

const buf = fs.readFileSync(file);
const results = [];

await new Promise((resolve) => {
  const source = new PassThrough();
  const decoder = zlib.createZstdDecompress();
  const chunks = [];

  decoder.on('data', (chunk) => chunks.push(chunk));
  decoder.on('end', () => {
    results.push(Buffer.concat(chunks).toString('utf8'));
    resolve();
  });
  decoder.on('error', (error) => {
    console.log('解码错误:', error.message, '(已读字节 =', Buffer.concat(chunks).length, ')');
    results.push(Buffer.concat(chunks).toString('utf8'));
    resolve();
  });

  source.end(buf);
  source.pipe(decoder);
});

const text = results.join('');
const lines = text.split('\n').filter(Boolean);
console.log('行数 =', lines.length);

const events = [];
for (const line of lines) {
  try {
    events.push(JSON.parse(line));
  } catch {
    /* 跳过 */
  }
}
console.log('事件数 =', events.length);

const lastSeq = events.reduce((max, event) => Math.max(max, Number(event.seq ?? -1)), -1);
console.log('最大 seq =', lastSeq);

const markers = events.filter((event) => {
  const id = event?.data?.id;
  return typeof id === 'string' && id.startsWith('recall-');
});
console.log('撤回标记 =', markers.length);
for (const event of markers) {
  const op = event.surfaceOp;
  const start = Number(op?.startSeq);
  const end = Number(op?.endSeq);
  console.log(`  marker.seq=${event.seq} start=${start} end=${end} 跨度=${end - start + 1} 遮蔽源=${event.sourceEventSeqs?.length ?? 0}`);
}
