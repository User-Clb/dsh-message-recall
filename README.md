# dsh-message-recall

DeepSeek Harness 的消息撤回插件：**每条你发出的消息气泡下方、复制按钮旁边**都有一个撤回按钮。被撤回的内容会真正从会话视图**和模型上下文**里移除——不是视觉隐藏，下一轮对话模型就不知道它了。

Web GUI 与桌面客户端共用同一份客户端包（`dsh.client.platform = "web"`，桌面端内嵌的就是同一套 Web 界面）。

## 效果

| 位置 | 行为 |
| --- | --- |
| 每条用户消息气泡 | 复制按钮旁边多一个撤回箭头图标 |
| 点开撤回按钮 | 两个选项：仅撤回这条 / 撤回这条及之后 |
| 仅撤回这条（默认） | 撤掉这条消息**及其引出的整轮回复**，后面的提问不受影响 |
| 撤回这条及之后 | 从这里到会话末尾全部撤掉 |
| 模型上下文 | 同步截断，下一轮请求不再包含被撤回内容 |
| 会话文件 | 保持追加式，原始事件仍在，可审计、可恢复 |

## 为什么是"真撤回"

官方会话存储是事件溯源的：日志只追加，模型可见的历史由**表面层**（surface）决定。一条 `surfaceOp: { op: "replace", startSeq, endSeq }` 事件会让指定区间退出当前表面——官方 `/compact` 检查点用的就是这条通道。

插件两端一起做实：

- **Host**（`src/recall.js`）
  - 用**官方** `session.surface.nodes` 取当前表面（不自己折叠，避免区间与官方视图不一致）。
  - 追加表面替换事件，`session.deriveMessages()` 立即从该点截断。
  - 追加后递增 `surface.contentGeneration` 并重置 `derivedGeneration`，强制派生缓存重建——漏掉这步请求会带旧历史被服务端拒绝（`400 / code 11158`）。
  - 标记事件用 `rewind-` 前缀：客户端 `uiConversation` 的窗口装配按该前缀剔除被遮蔽节点，同时派生时也会被过滤，不进模型消息。
  - **撤回一条用户消息会连带它引出的助手回复与工具结果**，止于下一条用户消息——否则助手回复里复述过的内容仍会被模型读到。
- **Client**（`client.cjs`）
  - 原生 DOM 注入按钮，不覆盖官方槽位、不打装配器补丁、不改任何其它插件。
  - 撤回后用官方 `uiConversation.binding(sessionId)` 的装配器重装窗口，气泡随即消失。

## 三重校验

撤回不是"看起来成功"就算数，Host 侧逐层核对：

1. 被遮蔽的 seq 必须真的离开 `surface.nodes`；
2. `deriveMessages()` 的条数必须真的变少（`modelDelta > 0`），否则返回 `context-unchanged`；
3. 一次遮蔽不得超过表面节点数的 50%，超过返回 `span-too-large`，防止误触清空整段对话。

## 安装

```bash
# 在 DSH profile 目录（$DSH_HOME/profiles/<profile>）里
pnpm add link:G:/path/to/dsh-message-recall
```

然后在同一个 `package.json` 的 `dsh.profile.bundles` 里加入 `"dsh-message-recall"`，重启 DSH。

也可以从 Git 直接安装：

```bash
pnpm add github:User-Clb/dsh-message-recall
```

## 结构

```
index.js            Host 入口：注册 /dsh-message-recall 路由
src/recall.js       撤回核心：表面替换、上下文截断、三重校验
client.cjs          浏览器端：撤回按钮（原生 DOM）
cordis.patch.yml    组合包 patch（Host 行）
dsh.plugin.json     插件清单
tools/              真机验证脚本（rpa-verify / verify-fix / probe-context 等）
test/               单元与真机 HTTP 测试
```

## HTTP 端点

宿主用 `webServer.register` 注册普通路由，客户端同源 `fetch` 调用（不依赖 `connection.rpc`）：

| 端点 | 说明 |
| --- | --- |
| `POST /dsh-message-recall/recall` | `{ sessionId, messageId?, seq?, text?, scope? }`；`scope` 取 `"only"`（默认）或 `"from"`。返回 `{ ok, scope, startSeq, endSeq, recalledCount, modelDelta, cleared, text }` |
| `POST /dsh-message-recall/status` | 只读：当前表面上可撤回的用户消息列表 |
| `POST /dsh-message-recall/audit` | 只读：所有撤回标记及其遮蔽跨度（排查误删用） |
| `POST /dsh-message-recall/derived` | 只读：模型实际会收到的派生消息尾部（验证上下文是否真截断） |

定位优先级：`seq` → `messageId` → `text`。客户端从 DOM 的 `data-chat-node-key` 解析官方消息 id，因此不会命中同文本的其它消息。

## 已知限制

- 只能在**已激活**的会话上撤回（会话未加载时没有可写句柄）。
- 撤回是追加式遮蔽，不是物理删除；需要彻底清空请直接删除会话记录。
- 桌面端与 Web 端功能相同，不需要单独安装桌面版本。
- 撤回后界面刷新依赖官方 `openSession` / 装配器重装；若界面未立即更新，刷新页面即可。

## License

MIT
