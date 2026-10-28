// dsh-message-recall 客户端半。
//
// 两部分能力：
//
// A. 撤回按钮 —— 覆盖用户消息节点（keyed slot "user"，priority -1 优先于官方），
//    气泡正文仍走官方 Factory `conversation.chat.user.content`（样式不变），
//    在正文下方自绘一条操作条，复制按钮之后就是撤回按钮。
//
// B. 真撤回 —— 官方 ConversationNodeAssembler 在重建窗口时不会剔除被
//    `surfaceOp: replace` 遮蔽的旧事件，导致气泡只是"看不见"而仍在场。
//    这里给装配器打补丁，在 replaceWindow / append 入口按撤回区间过滤，
//    使被撤回的事件真正退出会话视图（与 Host 侧 deriveMessages 截断同语义）。
window.__ModuleLoader__.load({
  id: "dsh-message-recall",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const NAME = "dsh-message-recall";
    const ROUTE = "/dsh-message-recall";
    const NS = "message-recall";

    /* ================================================================ */
    /* 传输：同源 fetch（与宿主 webServer 注册的普通路由对应）            */
    /* ================================================================ */

    function routeUrl(action, params) {
      const url = new URL(`${ROUTE}/${action}`, window.location.origin);
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
      return url.toString();
    }

    async function callApi(action, params, timeoutMs = 60000) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(routeUrl(action, params), {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params ?? {}),
          signal: controller.signal,
        });
        const text = await response.text();
        let data;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
        }
        if (!data || typeof data !== "object") throw new Error(`HTTP ${response.status}: 空响应`);
        return data;
      } catch (error) {
        if (error?.name === "AbortError") throw new Error("撤回请求超时");
        const message = String(error?.message ?? error);
        if (/failed to fetch|networkerror|load failed/i.test(message)) {
          throw new Error("连不上撤回接口，确认 DSH 还在运行后刷新页面");
        }
        throw error;
      } finally {
        window.clearTimeout(timer);
      }
    }

    /* ================================================================ */
    /* 撤回标记识别与窗口过滤                                            */
    /* ================================================================ */

    /** 该事件是否是本插件写入的撤回标记。 */
    function isRecallMarker(event) {
      if (!event || event.type !== "user/message") return false;
      const op = event.surfaceOp;
      if (!op || typeof op !== "object" || op.op !== "replace") return false;
      const id = event?.data?.id;
      return typeof id === "string" && id.indexOf("recall-") === 0;
    }

    /**
     * 从窗口条目里剔除被撤回的事件。
     *
     * 撤回标记覆盖 [startSeq, markerSeq]：区间内的事件连同标记本身
     * 都不再参与会话视图装配。
     *
     * @param entries - 装配器窗口条目。
     * @returns 过滤后的条目（无撤回标记时原样返回）。
     */
    function dropRecalled(entries) {
      const list = Array.isArray(entries) ? entries : [...(entries ?? [])];
      const hidden = new Set();
      let marked = false;

      for (const entry of list) {
        const event = entry?.event;
        if (!isRecallMarker(event)) continue;
        marked = true;
        const start = Number(event.surfaceOp.startSeq);
        const end = Number(event.seq);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        for (let seq = start; seq <= end; seq += 1) hidden.add(seq);
        if (Array.isArray(event.sourceEventSeqs)) {
          for (const source of event.sourceEventSeqs) {
            if (typeof source === "number") hidden.add(source);
          }
        }
      }

      if (!marked) return list;
      return list.filter((entry) => {
        const seq = entry?.event?.seq;
        return typeof seq === "number" && !hidden.has(seq);
      });
    }

    /** 给一个装配器实例打上过滤补丁。 */
    function patchAssembler(assembler) {
      if (!assembler || assembler.__dshRecallPatched) return assembler;
      assembler.__dshRecallPatched = true;

      const replaceWindow = assembler.replaceWindow?.bind(assembler);
      const append = assembler.append?.bind(assembler);

      if (typeof replaceWindow === "function") {
        assembler.replaceWindow = function recallReplaceWindow(entries, hasMore) {
          return replaceWindow(dropRecalled(entries), hasMore);
        };
      }

      if (typeof append === "function") {
        assembler.append = function recallAppend(record) {
          // 撤回标记到达：按当前窗口重建，被撤回的气泡立即消失。
          if (isRecallMarker(record?.event) && typeof assembler.replaceWindow === "function") {
            const current = assembler.inputs instanceof Map ? [...assembler.inputs.values()] : [];
            return assembler.replaceWindow([...current, record], assembler.hasMore === true);
          }
          return append(record);
        };
      }

      return assembler;
    }

    /* ================================================================ */
    /* 视图                                                             */
    /* ================================================================ */

    const zh = {
      recall: "撤回这条及之后的消息",
      recallOnly: "仅撤回这条消息",
      recallFrom: "撤回这条及之后的所有消息",
      scopeTitle: "选择撤回范围",
      busy: "撤回中…",
      copy: "复制",
      copied: "已复制",
      failed: "撤回失败",
    };
    const en = {
      recall: "Recall this and everything after",
      recallOnly: "Recall only this message",
      recallFrom: "Recall this and all later messages",
      scopeTitle: "Choose recall scope",
      busy: "Recalling…",
      copy: "Copy",
      copied: "Copied",
      failed: "Recall failed",
    };

    const styles = {
      row: {
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: "4px",
        minHeight: "20px",
      },
      iconButton: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "20px",
        height: "20px",
        padding: "0",
        border: "0",
        borderRadius: "5px",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        opacity: 0.55,
        lineHeight: 1,
        transition: "opacity 120ms ease",
      },
      time: {
        fontSize: "11px",
        opacity: 0.5,
        marginRight: "2px",
        whiteSpace: "nowrap",
      },
      notice: {
        fontSize: "11px",
        opacity: 0.8,
        marginRight: "4px",
      },
      recallWrap: {
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
      },
      menu: {
        position: "absolute",
        bottom: "calc(100% + 6px)",
        right: "0",
        minWidth: "210px",
        padding: "4px",
        borderRadius: "8px",
        border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.24))",
        background: "var(--dsw-alias-bg-elevated, #1f1f1f)",
        boxShadow: "0 6px 20px rgba(0,0,0,0.28)",
        zIndex: 40,
        display: "flex",
        flexDirection: "column",
        gap: "2px",
      },
      menuItem: {
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: "1px",
        width: "100%",
        padding: "7px 9px",
        border: "0",
        borderRadius: "6px",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        textAlign: "left",
        fontSize: "12px",
        lineHeight: 1.35,
      },
      menuLabel: { fontSize: "12px" },
      menuHint: { fontSize: "11px", opacity: 0.6 },
    };

    function CopyGlyph({ copied }) {
      return copied
        ? h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
            h("path", { d: "M3.5 8.5 6.5 11.5 12.5 5", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" }))
        : h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
            h("rect", { x: 5.5, y: 5.5, width: 8, height: 8, rx: 2, stroke: "currentColor", strokeWidth: 1.2 }),
            h("path", { d: "M10.5 5.5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4.5a2 2 0 0 0 2 2h1.5", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" }));
    }

    function RecallGlyph() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", {
          d: "M6.2 3.4 2.2 6.9l4 3.5V8.1h2.9c2.2 0 3.7 1.1 4.7 2.9-.3-3.1-2.2-5.3-4.7-5.3H6.2V3.4Z",
          stroke: "currentColor",
          strokeWidth: 1.2,
          strokeLinejoin: "round",
          strokeLinecap: "round",
        }));
    }

    /** 把 text 写进剪贴板。 */
    function writeClipboard(text) {
      if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text).then(() => true, () => false);
      }
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return Promise.resolve(ok);
      } catch {
        return Promise.resolve(false);
      }
    }

    /** 从内容块拼出纯文本。 */
    function textOf(content) {
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("");
    }

    /** 把消息内容整理成官方 Factory 需要的形状。 */
    function prepareContent(data) {
      const texts = [];
      const attachments = [];
      const extraBlocks = [];
      for (const block of Array.isArray(data?.content) ? data.content : []) {
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
        else if (block.type === "image" && block.attachment !== undefined) {
          attachments.push({ type: "image", image: { attachment: block.attachment } });
        } else if (block.type === "file" && block.attachment !== undefined) {
          attachments.push({ type: "file", file: block.attachment });
        } else extraBlocks.push(block);
      }
      return {
        text: texts.join(""),
        attachments,
        extraBlocks,
        referenceLabels: Array.isArray(data?.referenceLabels) ? data.referenceLabels : [],
      };
    }

    /** 本地时间 HH:MM。 */
    function clockOf(time) {
      if (typeof time !== "number") return "";
      try {
        return new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      } catch {
        return "";
      }
    }

    /* ================================================================ */
    /* 插件                                                             */
    /* ================================================================ */

    /**
     * 错误边界：节点渲染一旦抛错就退回官方外观，绝不让整个客户端崩溃。
     */
    class RecallBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        try {
          console.warn("[dsh-message-recall] node render failed:", error);
        } catch {
          /* ignore */
        }
      }

      render() {
        if (this.state.failed) return this.props.fallback ?? null;
        return this.props.children ?? null;
      }
    }

    function apply(ctx) {
      // 官方 locale 只提供 register / bind；这里用 bind 得到命名空间的 t()。
      const bound = typeof ctx.locale?.bind === "function" ? ctx.locale.bind(NS) : null;
      const t = (key) => {
        try {
          if (typeof bound === "function") {
            const value = bound(key);
            if (typeof value === "string" && value !== key) return value;
          }
        } catch {
          /* 回退到内置字典 */
        }
        return zh[key] ?? key;
      };

      ctx.effect(() => ctx.locale?.register?.(NS, { zh, en }), "dsh-message-recall: dictionaries");

      /** 当前会话 id：优先官方 UI Workspace 的持久化选择，其次从 DOM 兜底。 */
      function currentSessionId() {
        try {
          const workspace = ctx.get("uiWorkspace", false);
          const selected = workspace?.selection?.getSnapshot?.()?.sessionId;
          if (typeof selected === "string" && selected) return selected;
        } catch {
          /* 继续兜底 */
        }
        // DOM 兜底：会话根节点通常带 data-session-id。
        const marker = document.querySelector("[data-session-id]");
        const fromDom = marker?.getAttribute("data-session-id");
        if (fromDom) return fromDom;
        return "";
      }

      /** 执行撤回：Host 截断表面，再把原文回填输入框。 */
      async function recall(sessionId, seq, fallbackText, setDraft, scope) {
        const result = await callApi("recall", { sessionId, seq, scope });
        if (!result || result.ok !== true) throw new Error(result?.message ?? t("failed"));
        const text = typeof result.text === "string" && result.text !== "" ? result.text : (fallbackText ?? "");
        if (text && typeof setDraft === "function") setDraft(text);
        return result;
      }

      /* ---------- 用户消息节点（气泡 + 操作条） ---------- */

      function UserRecallNodeView(props) {
        const { node, renderFactorySlot, loadImage, t: translate, inputActions, sessionId: injectedSessionId } = props;
        const data = node?.data ?? {};
        const content = React.useMemo(() => prepareContent(data), [data]);
        const plain = content.text;
        // uiSession.provide 把 inputActions 作为 Session 作用域标准 prop 下发。
        const setDraft = typeof inputActions?.setDraft === "function"
          ? (text) => inputActions.setDraft(text)
          : undefined;

        const [copied, setCopied] = React.useState(false);
        const [phase, setPhase] = React.useState("idle");
        const [error, setError] = React.useState(null);
        const [menuOpen, setMenuOpen] = React.useState(false);

        const copy = React.useCallback(
          (event) => {
            event.preventDefault();
            event.stopPropagation();
            writeClipboard(plain).then((ok) => {
              if (!ok) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          },
          [plain],
        );

        /** 执行一次撤回，scope 为 only / from。 */
        const run = React.useCallback(
          async (event, scope) => {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            setMenuOpen(false);
            if (phase === "busy") return;
            const sessionId = injectedSessionId || currentSessionId();
            if (!sessionId) {
              setError("取不到会话 id");
              return;
            }
            setPhase("busy");
            setError(null);
            try {
              const result = await recall(sessionId, Number(data.seq), plain, setDraft, scope);
              setPhase("done");
              if (result?.recalledCount > 1) setError(`已撤回 ${result.recalledCount} 条`);
            } catch (cause) {
              setPhase("idle");
              setError(String(cause?.message ?? cause));
            }
          },
          [data.seq, injectedSessionId, phase, plain, setDraft, t],
        );

        // 点外部收起菜单。
        React.useEffect(() => {
          if (!menuOpen) return undefined;
          const close = () => setMenuOpen(false);
          window.addEventListener("click", close, true);
          window.addEventListener("keydown", close, true);
          return () => {
            window.removeEventListener("click", close, true);
            window.removeEventListener("keydown", close, true);
          };
        }, [menuOpen]);

        const clock = clockOf(data.time);
        const copyLabel = copied ? (translate?.("copied") ?? t("copied")) : (translate?.("copy") ?? t("copy"));
        const recallLabel = phase === "busy" ? t("busy") : t("recall");

        /** 撤回范围菜单项。 */
        const menuItem = (scope, label, hint) =>
          h(
            "button",
            {
              type: "button",
              role: "menuitem",
              "data-dsh-recall-scope": scope,
              onClick: (event) => run(event, scope),
              style: styles.menuItem,
              onMouseEnter: (e) => { e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16))"; },
              onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
            },
            h("span", { style: styles.menuLabel }, label),
            hint ? h("span", { style: styles.menuHint }, hint) : null,
          );

        return h(
          "div",
          { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px" } },
          renderFactorySlot("conversation.chat.user.content", {
            content,
            loadImage,
            facts: {},
            interactive: true,
          }),
          h(
            "div",
            { style: styles.row, "data-dsh-recall-row": "" },
            error !== null ? h("span", { style: styles.notice, role: "status" }, error) : null,
            clock ? h("span", { style: styles.time }, clock) : null,
            phase === "done"
              ? null
              : h(
                  "span",
                  { style: styles.recallWrap },
                  h(
                    "button",
                    {
                      type: "button",
                      title: recallLabel,
                      "aria-label": recallLabel,
                      "aria-haspopup": "menu",
                      "aria-expanded": menuOpen ? "true" : "false",
                      "data-dsh-recall-button": "",
                      disabled: phase === "busy",
                      onClick: (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (phase === "busy") return;
                        setMenuOpen((open) => !open);
                      },
                      style: styles.iconButton,
                      onMouseEnter: (e) => { e.currentTarget.style.opacity = "1"; },
                      onMouseLeave: (e) => { e.currentTarget.style.opacity = "0.55"; },
                    },
                    h(RecallGlyph, {}),
                  ),
                  menuOpen
                    ? h(
                        "div",
                        { role: "menu", "aria-label": t("scopeTitle"), style: styles.menu },
                        menuItem("only", t("recallOnly"), ""),
                        menuItem("from", t("recallFrom"), ""),
                      )
                    : null,
                ),
            h(
              "button",
              {
                type: "button",
                title: copyLabel,
                "aria-label": copyLabel,
                onClick: copy,
                style: styles.iconButton,
                onMouseEnter: (e) => { e.currentTarget.style.opacity = "1"; },
                onMouseLeave: (e) => { e.currentTarget.style.opacity = "0.55"; },
              },
              h(CopyGlyph, { copied }),
            ),
          ),
        );
      }

      /* ---------- 注册 ---------- */

      /**
       * 兜底渲染：与官方外观一致的用户气泡（无撤回按钮）。
       * 只在撤回组件抛错时使用，保证消息始终可见。
       */
      function UserRecallPlain(props) {
        const { node, renderFactorySlot, loadImage } = props;
        const data = node?.data ?? {};
        let content;
        try {
          content = prepareContent(data);
        } catch {
          content = { text: "", attachments: [], extraBlocks: [], referenceLabels: [] };
        }
        return renderFactorySlot("conversation.chat.user.content", {
          content,
          loadImage,
          facts: {},
          interactive: true,
        });
      }

      ctx.slots.inject("conversation.chat.node", () => ctx.slots.register(
        {
          name: "conversation.chat.node",
          key: "user",
          // 比官方条目（默认 0）更低的 priority 优先渲染。
          priority: -1,
          locale: NS,
          // 槽位注入：官方把当前会话 id 直接下发给 Session 作用域的条目。
          inject: (sessionId) => ({ sessionId }),
        },
        function UserRecallNodeBoundary(props) {
          return h(
            RecallBoundary,
            {
              fallback: h(UserRecallPlain, props),
            },
            h(UserRecallNodeView, props),
          );
        },
      ));

      /* ---------- 装配器补丁：让被撤回的事件真正消失 ---------- */

      ctx.inject(["uiConversation"], (scope) => {
        scope.effect(() => {
          const conversation = scope.uiConversation;
          if (!conversation || typeof conversation.binding !== "function") return;

          const original = conversation.binding.bind(conversation);
          conversation.binding = function bindingWithRecall(source) {
            const binding = original(source);
            if (binding?.assembler) patchAssembler(binding.assembler);
            return binding;
          };

          // 已建立的绑定也补一次。
          try {
            for (const record of conversation.bindings?.values?.() ?? []) {
              if (record?.binding?.assembler) patchAssembler(record.binding.assembler);
            }
          } catch {
            /* 忽略 */
          }

          return () => {
            conversation.binding = original;
          };
        }, "dsh-message-recall: assembler filter");
      });
    }

    return {
      name: NAME,
      inject: ["slots", "locale"],
      apply,
      /** 内部纯函数出口，供离线测试验证窗口过滤语义。 */
      __test: { dropRecalled, isRecallMarker, patchAssembler },
    };
  },
});
