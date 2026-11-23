// dsh-message-recall 客户端半。
//
// 严格遵循官方 slot 规范（docs/subsystems/slots.zh.md）：
//   - 组件是纯函数：不接收 ctx、不访问 DOM、不 import 其它功能插件；
//   - 一切数据经 props 注入（node / sessionId / messageId 由框架提供）；
//   - service 留在 apply 闭包内，只向组件投影 callback；
//   - 用 ctx.slots.inject(key, cb) 向官方槽位贡献，随 entry 生命周期自动回收。
window.__ModuleLoader__.load({
  id: "dsh-message-recall",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const NAME = "dsh-message-recall";
    const ROUTE = "/dsh-message-recall";

    /* ================================================================ */
    /* 文案                                                             */
    /* ================================================================ */

    const TEXT = {
      zh: {
        recall: "撤回",
        only: "仅撤回这条消息",
        from: "撤回这条及之后的所有消息",
        fromWarn: "撤回这条及之后的所有消息（不可恢复）",
        busy: "撤回中…",
        failed: "撤回失败",
      },
      en: {
        recall: "Recall",
        only: "Recall only this message",
        from: "Recall this and all later messages",
        fromWarn: "Recall this and all later messages (cannot be undone)",
        busy: "Recalling…",
        failed: "Recall failed",
      },
    };

    function dict() {
      try {
        return String(document.documentElement?.lang ?? "zh").toLowerCase().startsWith("en")
          ? TEXT.en
          : TEXT.zh;
      } catch {
        return TEXT.zh;
      }
    }

    /* ================================================================ */
    /* 传输（service 层，留在 apply 闭包内）                            */
    /* ================================================================ */

    function routeUrl(action) {
      return new URL(`${ROUTE}/${action}`, window.location.origin).toString();
    }

    async function callApi(action, payload, timeoutMs = 90000) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(routeUrl(action), {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload ?? {}),
          signal: controller.signal,
        });
        const text = await response.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          throw new Error(`HTTP ${response.status}`);
        }
        if (!data || typeof data !== "object") throw new Error(`HTTP ${response.status}`);
        return data;
      } catch (error) {
        if (error?.name === "AbortError") throw new Error("撤回超时");
        const message = String(error?.message ?? error);
        if (/failed to fetch|networkerror|load failed/i.test(message)) {
          throw new Error("连不上撤回接口，请确认 DSH 仍在运行");
        }
        throw error;
      } finally {
        window.clearTimeout(timer);
      }
    }

    /* ================================================================ */
    /* 图标（纯 SVG 字符串）                                            */
    /* ================================================================ */

    const RECALL_SVG =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">'
      + '<path d="M6.2 3.4 2.2 6.9l4 3.5V8.1h2.9c2.2 0 3.7 1.1 4.7 2.9-.3-3.1-2.2-5.3-4.7-5.3H6.2V3.4Z"'
      + ' stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/></svg>';

    const BUTTON_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "24px",
      height: "24px",
      padding: "0",
      border: "0",
      borderRadius: "6px",
      background: "transparent",
      color: "inherit",
      opacity: 0.72,
      cursor: "pointer",
      lineHeight: 1,
    };

    const MENU_STYLE = {
      position: "absolute",
      bottom: "calc(100% + 6px)",
      right: "0",
      minWidth: "205px",
      padding: "4px",
      borderRadius: "8px",
      border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24))",
      background: "var(--dsw-alias-bg-elevated, #1f1f1f)",
      boxShadow: "0 6px 20px rgba(0,0,0,.3)",
      zIndex: 60,
      display: "flex",
      flexDirection: "column",
      gap: "2px",
    };

    const ITEM_STYLE = {
      display: "block",
      width: "100%",
      padding: "7px 10px",
      border: "0",
      borderRadius: "6px",
      background: "transparent",
      color: "inherit",
      textAlign: "left",
      fontSize: "12px",
      whiteSpace: "nowrap",
      cursor: "pointer",
    };

    /** 与官方 formatMessageClock 一致的简短时钟（HH:MM）。 */
    function formatClock(time) {
      try {
        const d = new Date(Number(time));
        if (Number.isNaN(d.getTime())) return "";
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      } catch {
        return "";
      }
    }

    /** 复制按钮，与官方复制行为一致。 */
    function CopyButton({ text }) {
      const [copied, setCopied] = React.useState(false);
      const copy = React.useCallback(async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(String(text ?? ""));
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch { /* 忽略 */ }
      }, [text]);

      return h("button", {
        type: "button",
        title: copied ? "已复制" : "复制",
        "aria-label": copied ? "已复制" : "复制",
        onClick: copy,
        style: BUTTON_STYLE,
        onMouseEnter: (e) => { e.currentTarget.style.opacity = "1"; },
        onMouseLeave: (e) => { e.currentTarget.style.opacity = "0.72"; },
        dangerouslySetInnerHTML: {
          __html: copied
            ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8.5 6.2 11.8 13 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 5.5V4a1.6 1.6 0 0 0-1.6-1.6H4A1.6 1.6 0 0 0 2.4 4v4.9A1.6 1.6 0 0 0 4 10.5h1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
        },
      });
    }


    /* ================================================================ */
    /* 纯函数组件：RecallAction                                        */
    /* ================================================================ */

    /**
     * 撤回按钮 + 范围菜单。纯函数组件，不接收 ctx、不访问 DOM。
     *
     * 数据全部来自 props：
     *   - sessionId：由 session 作用域框架注入
     *   - messageId / seq：由宿主槽位的 owner 参数注入
     *   - onRecall：apply 闭包投影出的回调
     *
     * @param props - 见上。
     * @returns 按钮元素。
     */
    function RecallAction(props) {
      const { sessionId, messageId, seq, pending, onRecall, onReload, labels } = props;
      const t = labels ?? dict();
      const [busy, setBusy] = React.useState(false);
      const [menu, setMenu] = React.useState(false);
      const [notice, setNotice] = React.useState("");
      const wrapRef = React.useRef(null);

      React.useEffect(() => {
        if (!menu) return undefined;
        const close = (event) => {
          if (wrapRef.current && wrapRef.current.contains(event.target)) return;
          setMenu(false);
        };
        document.addEventListener("mousedown", close, true);
        return () => document.removeEventListener("mousedown", close, true);
      }, [menu]);

      const run = React.useCallback(
        async (scope) => {
          if (busy) return;
          setMenu(false);
          setBusy(true);
          setNotice("");
          try {
            const result = await onRecall({ sessionId, messageId, seq, pending, scope });
            if (!result?.ok) throw new Error(result?.message ?? t.failed);
            // 撤回成功：把「当前表面」推给装配器，界面无感重装。
            try {
              const refreshed = await onReload?.(sessionId);
              // 无感刷新失败时明确告知，而不是静默残留旧内容。
              if (!refreshed) setNotice("已撤回，刷新界面后可见");
            } catch { /* 忽略 */ }
          } catch (error) {
            setNotice(String(error?.message ?? error));
          } finally {
            setBusy(false);
          }
        },
        [busy, messageId, onRecall, onReload, pending, seq, sessionId, t.failed],
      );

      const item = (scope, label) =>
        h(
          "button",
          {
            type: "button",
            role: "menuitem",
            "data-dsh-recall-scope": scope,
            key: scope,
            style: ITEM_STYLE,
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              void run(scope);
            },
            onMouseEnter: (e) => { e.currentTarget.style.background = "rgba(127,127,127,.16)"; },
            onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
          },
          label,
        );

      return h(
        "span",
        { ref: wrapRef, style: { position: "relative", display: "inline-flex", alignItems: "center" } },
        h(
          "button",
          {
            type: "button",
            title: busy ? t.busy : t.recall,
            "aria-label": busy ? t.busy : t.recall,
            "data-dsh-recall-button": "",
            disabled: busy,
            style: { ...BUTTON_STYLE, opacity: busy ? 0.45 : BUTTON_STYLE.opacity },
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!busy) setMenu((open) => !open);
            },
            onMouseEnter: (e) => { if (!busy) e.currentTarget.style.opacity = "1"; },
            onMouseLeave: (e) => { if (!busy) e.currentTarget.style.opacity = "0.72"; },
            dangerouslySetInnerHTML: { __html: RECALL_SVG },
          },
        ),
        menu
          ? h(
              "div",
              { role: "menu", style: MENU_STYLE },
              item("only", t.only),
              item("from", t.fromWarn),
            )
          : null,
        notice
          ? h("span", { style: { fontSize: "11px", marginLeft: "4px", opacity: 0.75 } }, notice)
          : null,
      );
    }

    /* ================================================================ */
    /* 插件                                                             */
    /* ================================================================ */

    function apply(ctx) {

      ctx.effect(() => {
        try { ctx.locale?.register?.("message-recall", TEXT); } catch { /* 忽略 */ }
        return () => {};
      }, "dsh-message-recall: dictionaries");

      /**
       * 撤回 service：留在 apply 闭包内，只向组件投影这个回调。
       *
       * 组件永远拿不到 ctx，符合官方「service 与 model object 留在 apply
       * closure 中，只向组件投影 callback」的规范。
       */
      const recall = async ({ sessionId, messageId, seq, pending, scope }) => {
        const payload = { sessionId, scope };
        if (pending) payload.pending = true;
        if (messageId) payload.messageId = messageId;
        if (Number.isFinite(Number(seq))) payload.seq = Number(seq);
        return callApi("recall", payload);
      };

      /**
       * 无感重装：把「当前表面」的事件推给客户端事件源。
       *
       * 官方 MutableSessionEventSource.replace(entries) 会发布
       * { kind: 'replace', entries }，ui-conversation 装配器收到后重装窗口。
       * 被撤回的节点不在表面里，重装后自然从界面消失 —— 不刷新页面。
       *
       * service 留在 apply 闭包内，只向组件投影这个 callback。
       */
      const onReload = async (sessionId) => {
        if (!sessionId) return false;

        const data = await callApi("surface", { sessionId }, 30000).catch(() => null);
        if (!data?.ok || !Array.isArray(data.events) || data.events.length === 0) return false;
        const entries = data.events.map((event) => ({ event }));

        // 路径 1（当前内核权威）：sessions.binding(id).eventSource 是官方
        // MutableSessionEventSource，uiConversation 装配器订阅了它。
        // replace() 发布 { kind:'replace' } → 装配器按新表面重装窗口。
        // 当前内核的 client Service 目录并未暴露 uiConversation，只暴露 sessions，
        // 所以这一条才是真正生效的主路径。
        try {
          const sessions = ctx?.get?.("sessions", false);
          const source = sessions?.binding?.(sessionId)?.eventSource;
          if (source && typeof source.replace === "function") {
            source.replace(entries, false);
            return true;
          }
        } catch { /* 继续兜底 */ }

        // 路径 2（旧内核兼容）：uiConversation.bindings
        try {
          const conversation = ctx?.get?.("uiConversation", false);
          const store = conversation?.bindings;

          // bindings 的 key 可能是 sessionId，也可能是 owner 对象：
          // 两种都试，再兜底遍历一次（WeakMapWithValues 可枚举）。
          let record = store?.get?.(sessionId);
          if (!record && typeof store?.values?.[Symbol.iterator] === "function") {
            for (const row of store.values()) {
              const sid = row?.source?.sessionId ?? row?.binding?.source?.sessionId;
              if (sid === sessionId) { record = row; break; }
            }
          }

          const source =
            record?.source?.eventSource ??
            record?.binding?.source?.eventSource;
          if (source && typeof source.replace === "function") {
            source.replace(entries, false);
            return true;
          }
        } catch { /* 继续 */ }

        try {
          const conversation = ctx?.get?.("uiConversation", false);
          const assembler = conversation?.binding?.(sessionId)?.assembler;
          if (assembler && typeof assembler.replaceWindow === "function") {
            assembler.replaceWindow(entries, false);
            return true;
          }
        } catch { return false; }

        return false;
      };
;

      // 用户消息：覆盖 conversation.chat.node 的 user key，并**完整复刻官方渲染**。
      //
      // 官方在 MessageItem.tsx 里的结构是：
      //   <div class=userRow>
      //     {renderSlotChain('conversation.chat.user.before', {...})}
      //     {renderFactorySlot('conversation.chat.user.content', {...})}
      //     {actions?.(text)}      <-- 复制/时间/分支 都在这里
      //   </div>
      //
      // 这里按同样顺序复刻，并在 actions 里追加撤回按钮，官方的东西一个不少。
      ctx.slots.inject("conversation.chat.node", () =>
        ctx.slots.register(
          {
            name: "conversation.chat.node",
            key: "user",
            priority: -1,
            locale: "message-recall",
            inject: (sessionId) => ({ sessionId }),
          },
          function UserRecallNode(props) {
            const node = props?.node;
            const data = node?.data ?? {};
            const seq = node?.anchorSeq ?? data.seq;
            const messageId = data.id ?? node?.id;

            // 官方：contentParts 把 content 拆成 text / attachments / rest
            const prepared = React.useMemo(() => {
              const texts = [];
              const attachments = [];
              const rest = [];
              for (const block of Array.isArray(data.content) ? data.content : []) {
                const b = block ?? {};
                if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
                else if (b.type === "image" && b.attachment !== undefined) {
                  attachments.push({ type: "image", image: { attachment: b.attachment } });
                } else if (b.type === "file" && b.attachment !== undefined) {
                  attachments.push({ type: "file", file: b.attachment });
                } else rest.push(block);
              }
              return { text: texts.join(""), attachments, extraBlocks: rest };
            }, [data.content]);

            // 官方 actions 里是复制 + 时间 + 分支；这里保留时间与复制，
            // 再把撤回按钮插在复制之后，符合官方「between copy and branch」的位置语义。
            const actions = (text) =>
              h("div", {
                style: {
                  display: "flex", alignItems: "center", gap: "8px",
                  height: "28px", justifyContent: "flex-end",
                },
                "data-actions-row": "",
              },
                data.time !== undefined
                  ? h("span", {
                      style: {
                        fontSize: "13px", opacity: 0.65, paddingRight: "6px",
                        fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
                      },
                    }, formatClock(data.time))
                  : null,
                h(CopyButton, { text }),
                h(RecallAction, {
                  sessionId: props.sessionId, messageId, seq,
                  onRecall: recall, onReload, labels: dict(),
                }),
              );

            // 严格复刻官方 UserStyleBubble 的两层结构（缺一层就会位移）：
            //   .userRow   flex column, align-items flex-end, gap 6
            //     ├─ user.before 座位
            //     └─ .userStack  flex column, align-items flex-end, gap 8
            //                     min-width 0, max-width min(0.702*内容宽, 82%)
            //          ├─ 正文（官方 Factory）
            //          └─ actions 行
            const ROW = {
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: "6px",
            };
            const STACK = {
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: "8px",
              minWidth: 0,
              maxWidth: "min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)",
            };

            return h(
              "div",
              { style: ROW, "data-dsh-recall-row": "" },
              props.renderSlotChain
                ? props.renderSlotChain("conversation.chat.user.before",
                    { source: data.source, kind: node?.kind }, { fallback: null })
                : null,
              h(
                "div",
                { style: STACK, "data-dsh-recall-stack": "" },
                props.renderFactorySlot("conversation.chat.user.content", {
                  content: prepared,
                  loadImage: props.loadImage,
                  facts: data.referenceLabels === undefined ? {} : { sessionLabels: data.referenceLabels },
                  interactive: true,
                }),
                actions(prepared.text),
              ),
            );
          },
        ));

            // 隐藏 dsh-purge 的「回退」按钮：本插件已提供同等能力，
      // 两个入口并列会让人分不清。用一条 CSS 规则，不碰 purge 文件。
      // 该按钮不存在时规则不匹配任何元素，不影响其它插件。
      ctx.effect(() => {
        const STYLE_ID = "dsh-message-recall-purge-compat";
        try {
          if (document.getElementById(STYLE_ID)) return () => {};
          const style = document.createElement("style");
          style.id = STYLE_ID;
          style.textContent = ".dshp-rewind-wrap{display:none !important}";
          document.head.appendChild(style);
          return () => {
            try { document.getElementById(STYLE_ID)?.remove(); } catch { /* 忽略 */ }
          };
        } catch {
          return () => {};
        }
      }, "dsh-message-recall: purge compat");

      // 助手回复的撤回按钮（官方公开扩展点 assistant-actions）。
      // 官方注入 messageId；seq 由 useChat 快照按 id 反查，供「及之后」定位原点。
      ctx.slots.inject("conversation.chat.assistant-actions", () =>
        ctx.slots.register(
          {
            name: "conversation.chat.assistant-actions",
            id: "dsh-message-recall-assistant",
            order: 20,
            locale: "message-recall",
            inject: (sessionId) => ({ sessionId }),
          },
          function AssistantRecall(props) {
            const messageId = props?.messageId;
            // 从 Chat 快照里找这个 id 对应的节点，拿它的 anchorSeq。
            const seq = (props.useChat && typeof props.useChat === "function")
              ? props.useChat((snap) => {
                  try {
                    for (const key of snap?.order ?? []) {
                      const node = snap.nodes.get(key);
                      const id = node?.data?.id ?? node?.data?.message?.id ?? node?.id;
                      if (String(id) === String(messageId)) return node.anchorSeq;
                    }
                  } catch { /* 忽略 */ }
                  return undefined;
                })
              : undefined;

            return h(RecallAction, {
              sessionId: props.sessionId,
              messageId,
              seq,
              onRecall: recall,
              onReload,
              labels: dict(),
            });
          },
        ));
    }

    return {
      name: NAME,
      inject: ["slots", "locale"],
      apply,
      __test: { dict },
    };
  },
});
