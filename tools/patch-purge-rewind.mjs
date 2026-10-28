/**
 * 一次性补丁：把 dsh-purge 挂在输入框右侧的「回退」按钮注册注释掉。
 *
 * 只做两处最小改动：
 *   1) `installRewindUi` 里 `ctx.slots.inject("conversation.input.right", ...)`
 *      那一整条注册语句（含 `}, RewindSafe));` 收尾）整体注释；
 *   2) 其余逻辑（rewind watch 等）原样保留，避免影响 purge 其它能力。
 *
 * 幂等：已注释过就跳过；文件保持 UTF-8 原编码。
 */
import fs from 'node:fs';

const target = process.argv[2];
if (!target) {
  console.error('usage: node patch-purge-rewind.mjs <client.js>');
  process.exit(2);
}

const source = fs.readFileSync(target, 'utf8');
const lines = source.split('\n');

const START = 'ctx.slots.inject("conversation.input.right", () => ctx.slots.register({';
const ID = 'id: "dsh-purge-rewind"';

const startIndex = lines.findIndex(
  (line, index) => line.includes(START) && !line.trimStart().startsWith('//')
    && lines.slice(index, index + 6).some((row) => row.includes(ID)),
);

if (startIndex < 0) {
  const already = lines.some((line) => line.includes('[dsh-message-recall]') && line.includes('dsh-purge-rewind'));
  console.log(already ? 'already patched' : 'anchor not found');
  process.exit(already ? 0 : 1);
}

// 找到该注册语句的收尾行 `}, RewindSafe));`。
let endIndex = -1;
for (let index = startIndex; index < Math.min(startIndex + 20, lines.length); index += 1) {
  if (lines[index].includes('RewindSafe));')) {
    endIndex = index;
    break;
  }
}
if (endIndex < 0) {
  console.error('closing line not found');
  process.exit(1);
}

for (let index = startIndex; index <= endIndex; index += 1) {
  lines[index] = `// [dsh-message-recall] ${lines[index]}`;
}

fs.writeFileSync(target, lines.join('\n'), 'utf8');
console.log(`commented lines ${startIndex + 1}..${endIndex + 1}`);
