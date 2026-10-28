/**
 * 用 UTF-8 正确写入 GitHub 仓库描述（PowerShell 会把中文转成问号）。
 *
 * 运行：node tools/set-repo-description.mjs
 */
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN required');
  process.exit(2);
}

const description = 'DeepSeek Harness 消息撤回插件：每条你发出的消息气泡下方、复制按钮旁边都有撤回按钮。'
  + '默认撤回这条消息及其引出的整轮回复，也可选择撤回这条及之后；'
  + '被撤回的内容会真正退出会话视图与模型上下文，下一轮对话模型就不再知道它。'
  + 'Web 界面与桌面客户端共用同一份客户端包。';

const response = await fetch('https://api.github.com/repos/User-Clb/dsh-message-recall', {
  method: 'PATCH',
  headers: {
    authorization: `token ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-message-recall',
    'content-type': 'application/json; charset=utf-8',
  },
  body: JSON.stringify({ description, homepage: 'https://github.com/User-Clb/dsh-message-recall' }),
});

const body = await response.json();
console.log('status =', response.status);
console.log('description =', body.description);
console.log('homepage =', body.homepage);
