# dsh-message-recall

DeepSeek Harness 的消息撤回插件：**每条你发出的消息气泡下方、复制按钮旁边**都有一个撤回按钮。点开后可以选择两种范围，被撤回的内容真正消失——不是视觉隐藏，而是同时从会话记录视图和模型上下文里被移除，原文还会回到输入框方便改写重发。

Web GUI 与桌面客户端共用同一份客户端包（`dsh.client.platform = "web"`，桌面端内嵌的就是同一套 Web 界面）。

## 效果

| 位置 | 行为 |
| --- | --- |
| 每条用户消息气泡 | 复制按钮旁边多一个撤回箭头图标 |
| 点开撤回按钮 | 弹出两个选项：仅撤回本条 / 撤回本条及之后 |
| 仅撤回本条 | 只移除这一条，后续对话保持不动 |
| 撤回本条及之后 | 该消息及其之后的所有消息从会话视图消失 |
| 模型上下文 | 从撤回点截断，下一轮请求不再包含被撤回内容 |
| 输入框 | 自动回填被撤回消息的原文 |
| 会话文件 | 保持追加式，原始事件仍在，可审计、可恢复 |

## 为什么是"真撤回"

官方会话存储是事件溯源的：日志只追加，模型可见的历史由**表面层**（surface）决定。一条 `surfaceOp: { op: "replace", startSeq, endSeq }` 事件会让指定区间退出当前表面，官方 `/compact` 的检查点用的就是这条通道。

插件两端一起把它做实：

- **Host**（`src/recall.js`）：在当前会话追加表面替换事件，`session.deriveMessages()` 立即从该点截断；替换事件自身用 `recall-` 前缀在派生时被过滤，不会混进上下文；同时清空入站队列里尚未发出的内容，并在该轮仍在运行时先停掉它。
- **Client**（`client.cjs`）：官方装配器收到替换事件后会重建窗口，但不会剔除被遮蔽的旧事件。插件在 `ConversationNodeAssembler` 上包一层过滤，使被撤回的事件不再参与会话视图装配，气泡真正消失。

两侧语义一致，所以撤回之后既看不到、也不会再被模型读到。

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
index.js            Host 插件入口：注册 plugin-rpc 路由
src/recall.js       撤回核心：表面折叠、截断、原文提取
client.cjs          浏览器端：撤回按钮 + 装配器过滤补丁
cordis.patch.yml    组合包 patch（Host 行）
dsh.plugin.json     插件清单
```

Host 侧 RPC 端点 `/api/plugin-rpc/dsh-message-recall`：

- `recall` `{ sessionId, seq, scope? }` —— `scope` 取 `"only"`（仅本条）或 `"from"`（本条及之后，默认）；返回 `{ ok, scope, startSeq, endSeq, recalledCount, text, stopped }`
- `status` `{ sessionId }` —— 只读：当前表面上可撤回的用户消息列表

## 已知限制

- 只能在**已激活**的会话上撤回（会话未加载时没有可写句柄）。
- 撤回是追加式遮蔽，不是物理删除；需要彻底清空请直接删除会话记录。
- 桌面端与 Web 端功能相同；不需要单独安装桌面版本。

## License

MIT
