window.__ModuleLoader__.load({
  id: "dsh-message-recall",
  factory: (require) => {
    /*
     dsh-message-recall 客户端半。
     
     职责边界（刻意做到最小、最安全）：
       - 只在用户消息框的复制按钮旁插一个撤回按钮（原生 DOM，不覆盖官方槽位）；
       - 点击后调用宿主 /dsh-message-recall/recall，由宿主真删除（表面替换 + 派生缓存失效）；
       - 宿主成功后，让当前会话重新加载窗口，界面自然少掉那几条（不再用 CSS 假装隐藏）。
     
     不碰装配器、不覆盖官方 React 树、不改其它插件，任何异常都只影响按钮自身。
    */
   try {
    const React = require ? require("react") : null;
    const h = React ? React.createElement : null;

    const NAME = "dsh-message-recall";
    const ROUTE = "/dsh-message-recall";

    /* ================================================================ */
    /* 文案                                                             */
    /* ================================================================ */

    const TEXT = {
      zh: {
        recall: "撤回",
        recallPending: "撤回这条排队中的消息",
        only: "仅撤回这条消息",
        from: "撤回这条及之后的所有消息",
        fromWarn: "撤回这条及之后的所有消息（不可恢复）",
        busy: "撤回中…",
        failed: "撤回失败",
        scope: "选择撤回范围",
      },
      en: {
        recall: "Recall",
        recallPending: "Recall this queued message",
        only: "Recall only this message",
        from: "Recall this and all later messages",
        fromWarn: "Recall this and all later messages (cannot be undone)",
        busy: "Recalling…",
        failed: "Recall failed",
        scope: "Choose recall scope",
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
    /* 传输                                                             */
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

    async function callApi(action, params, timeoutMs = 90000) {
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
          throw new Error("连不上撤回接口");
        }
        throw error;
      } finally {
        window.clearTimeout(timer);
      }
    }

    /* ================================================================ */
    /* 会话重载：让界面按新表面重建                                     */
    /* ================================================================ */

    /**
     * 让界面按新的表面重建。
     *
     * 客户端 uiConversation 的窗口装配自带剔除规则：
     * 见到 `rewind-` 前缀的表面替换事件就剔除被遮蔽的节点。
     * 所以这里只需让该会话重新装配一次窗口即可，不自己过滤、不打补丁。
     *
     * @param sessionId - 目标会话。
     * @param ctx - 插件上下文。
     * @returns 是否触发了重建。
     */
    /**
     * 撤回后让界面更新。
     *
     * 绝不刷新页面：那会打断用户、丢失滚动位置，看起来像「应用重启」。
     * 这里只做局部更新——把被撤回的那几条从视图里移掉：
     *   scope=only 移除点击的那一条（及其回复）；scope=from 移除到末尾。
     *
     * @param fromBar - 被点击按钮所在的操作条。
     * @param scope - "only" 或 "from"。
     */
    /**
     * 撤回后立即更新界面（不刷新页面）。
     *
     * 语义与宿主严格一致：只处理「这条及其之后」，绝不碰更早的消息。
     * 做法：拿到页面上所有消息行（按视觉顺序），从被点击那条开始向后隐藏。
     * 只隐藏「单条消息」容器，避免误伤整个会话。
     *
     * @param fromBar - 被点击按钮所在的操作条。
     * @param scope - "only" 只隐藏这一条（及其回复）；"from" 隐藏到末尾。
     */
    function updateView(fromBar, scope) {
      try {
        const all = collectMessageRows();
        const at = all.findIndex((entry) => entry.bar && (entry.bar === fromBar || entry.bar.contains(fromBar)));
        if (at < 0) return;

        let targets;
        if (scope === 'from') {
          targets = all.slice(at);
        } else {
          // only：本条 + 紧随其后的回复，遇到下一条用户消息就停。
          targets = [];
          for (let index = at; index < all.length; index += 1) {
            const entry = all[index];
            if (index > at && entry.isUser) break;
            targets.push(entry);
          }
        }

        for (const { node } of targets) {
          if (!node) continue;
          node.style.display = "none";
          node.setAttribute("data-dsh-recall-hidden", "1");
        }
      } catch {
        /* 界面更新失败也不刷新页面 */
      }
    }

    /**
     * 收集页面上所有消息行（用户与助手都算），按视觉顺序。
     *
     * @returns `{ node, isUser, bar }` 数组。
     */
    function collectMessageRows() {
      const nodes = [...document.querySelectorAll("[data-chat-flow-key]")];
      const out = [];
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        // 只取「单条消息」容器：内部不再嵌套其它消息行。
        if (node.querySelector("[data-chat-flow-key]")) continue;

        let bar = null;
        let isUser = false;
        for (const button of node.querySelectorAll("button")) {
          const label = (button.getAttribute("aria-label") ?? button.getAttribute("title") ?? "").trim();
          if (/复制|copy/i.test(label)) { bar = button.parentElement; isUser = true; break; }
        }
        out.push({ node, isUser, bar });
      }
      return out;
    }

    /* ================================================================ */
    /* 当前会话                                                         */
    /* ================================================================ */

    /**
     * 取当前会话 id。
     *
     * 必须带上它：否则宿主只能跨会话按文本猜目标，
     * 会命中别的会话里同文本的消息（表现为「该消息已被撤回」但气泡还在）。
     *
     * @param ctx - 插件上下文。
     * @returns 会话 id，取不到返回空串。
     */
    /**
     * 取当前会话 id。
     *
     * 优先从 DOM 精确取：官方在会话根节点上写了 data-conversation-session，
     * 值就是 sessionId。这比「取事件最多的会话」可靠——多会话并存时，
     * 后者会取错，表现就是「没找到要撤回的消息」。
     *
     * @param ctx - 插件上下文。
     * @param fromNode - 可选：从这个元素向上找（点按钮时传按钮自己）。
     * @returns 会话 id，取不到返回空串。
     */
    /**
     * 取当前**可见**会话的 id。
     *
     * 页面里可能同时挂着多个会话容器（缓存的旧会话也在 DOM 里），
     * 所以不能随便取第一个——必须取「可见且有尺寸」的那个，
     * 否则撤回会作用到别的会话，表现为「没找到要撤回的消息」。
     *
     * @param ctx - 插件上下文。
     * @param fromNode - 可选：从触发元素向上找。
     * @returns 会话 id，取不到返回空串。
     */
    /**
     * 取当前会话 id。
     *
     * 唯一权威来源：官方 uiWorkspace 的当前选中会话。
     * 不用 DOM 的 data-conversation-session——实测它会残留旧值
     * （容器上写着 A，实际显示的却是 B 的内容），据此撤回必然定位错。
     *
     * @param ctx - 插件上下文。
     * @returns 会话 id，取不到返回空串。
     */
    function currentSessionId(ctx) {
      try {
        const workspace = ctx?.get?.("uiWorkspace", false);
        const selected = workspace?.selection?.getSnapshot?.()?.sessionId;
        if (typeof selected === "string" && selected) return selected;
      } catch { /* 继续 */ }

      // 次选：官方 sessions 的当前会话（与 workspace 同源）。
      try {
        const sessions = ctx?.get?.("sessions", false);
        const current = sessions?.current?.()?.id ?? sessions?.activeSessionId;
        if (typeof current === "string" && current) return current;
      } catch { /* 继续 */ }

      return "";
    }

    /* ================================================================ */
    /* 按钮（原生 DOM）                                                  */
    /* ================================================================ */

    const MOUNT = "data-dsh-recall-mount";

    /* ================================================================ */
    /* 兼容：收起 dsh-purge 的「回退」按钮（缺失时零影响）               */
    /* ================================================================ */

    const PURGE_STYLE_ID = "dsh-message-recall-purge-compat";
    const PURGE_SELECTOR = ".dshp-rewind-wrap";

    /**
     * 把输入框里的「回退」按钮藏起来，仅当它真的存在时。
     *
     * 兼容性约定：
     *   - purge 未安装 / 改名 / 卸载 => 查不到该元素，直接返回，
     *     不注入样式、不报错；
     *   - 样式用独立 id，卸载时整块移除，不残留；
     *   - 纯 CSS 隐藏，不引用 purge 的任何对象，也不改它的文件。
     */
    function syncPurgeComfort() {
      try {
        const present = document.querySelector(PURGE_SELECTOR) !== null;
        const existing = document.getElementById(PURGE_STYLE_ID);
        if (present && !existing) {
          const style = document.createElement("style");
          style.id = PURGE_STYLE_ID;
          // 它的职责已由本插件的按消息撤回取代，避免两个入口并存。
          style.textContent = `${PURGE_SELECTOR}{display:none !important}`;
          document.head.appendChild(style);
          return;
        }
        if (!present && existing) existing.remove();
      } catch {
        /* 任何异常都不影响本插件主流程 */
      }
    }

    function iconSvg() {
      return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">'
        + '<path d="M6.2 3.4 2.2 6.9l4 3.5V8.1h2.9c2.2 0 3.7 1.1 4.7 2.9-.3-3.1-2.2-5.3-4.7-5.3H6.2V3.4Z"'
        + ' stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/></svg>';
    }

    /**
     * 从用户消息行里取出气泡正文纯文本。
     *
     * 不能直接用 row.textContent：会把时间戳和按钮文案一起带进来。
     *
     * @param row - 用户消息行。
     * @param bar - 操作条（其内容不计入正文）。
     * @returns 正文纯文本。
     */
    function bubbleTextOf(row, bar) {
      const parts = [];
      const walk = (node) => {
        if (!node) return;
        if (bar && (node === bar || bar.contains(node))) return;
        if (node.nodeType === 3) {
          const value = String(node.nodeValue ?? "");
          if (value.trim()) parts.push(value);
          return;
        }
        if (node.nodeType !== 1) return;
        const tag = node.tagName;
        if (tag === "BUTTON" || tag === "SVG" || tag === "SCRIPT" || tag === "STYLE") return;
        for (const child of node.childNodes ?? []) walk(child);
      };
      walk(row);
      return parts.join(" ").replace(/\s+/g, " ").trim();
    }

    /** 找到用户消息行的操作条（复制按钮所在那一行）。 */
    function findActionRow(row) {
      for (const button of row.querySelectorAll("button")) {
        const label = (button.getAttribute("aria-label") ?? button.getAttribute("title") ?? "").trim();
        if (/复制|copy/i.test(label)) return button.parentElement;
      }
      let best = null;
      for (const node of row.querySelectorAll("div")) {
        if (node.querySelector("button")) best = node;
      }
      return best;
    }

    /**
     * 从消息行的 DOM 上取官方消息 id。
     *
     * 节点 key 由 `match()` 返回的 id 构成，形如
     * `["node","input-message<id>",null]`，这里把 id 抽出来。
     * 用 id 定位是精确的：不会像文本那样命中别的会话或同文本消息。
     *
     * @param row - 消息行元素。
     * @returns 消息 id，取不到返回空串。
     */
    /**
     * 从消息行的 DOM 上取官方消息 id（全局唯一）。
     *
     * data-chat-node-key 的格式在不同版本里可能是：
     *   - JSON 数组：["node","<key>",null]
     *   - 裸字符串：<key>
     * 而 <key> 本身又可能是 "input-message<id>" 或直接 <id>。
     * 这里逐层剥开，拿到最里层的 id。
     *
     * @param row - 消息行元素。
     * @returns 消息 id，取不到返回空串。
     */
    function messageIdOf(row) {
      const node = row?.closest?.("[data-chat-node-key]") ?? row?.querySelector?.("[data-chat-node-key]");
      let raw = node?.getAttribute?.("data-chat-node-key") ?? "";
      if (!raw) return "";

      // 剥 JSON 数组
      if (raw.startsWith("[")) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            // 取数组里第一个非固定前缀的字符串
            for (const part of parsed) {
              if (typeof part !== "string" || !part) continue;
              if (part === "node" || part === "group") continue;
              raw = part;
              break;
            }
          }
        } catch { /* 保持原值 */ }
      }

      // 去掉 input-message / steering 等前缀
      const m = raw.match(/^(?:input-message|steering|context|assistant-step|turn-trigger)-?(.+)$/);
      if (m) return m[1];

      // 已是裸 id
      return raw;
    }

    /**
     * 造一个「撤回排队消息」按钮。
     *
     * 排队消息还没写进会话日志，撤回就是把它从发送队列里移除，
     * 不需要表面替换，所以单独走 pending 通道。
     *
     * @param messageText - 气泡文本（用于在队列里匹配）。
     * @param ctx - 插件上下文。
     * @param bubble - 排队气泡元素（撤回后移除自己）。
     * @returns 按钮宿主元素。
     */
    function buildPendingButton(messageText, ctx, bubble) {
      const labels = dict();

      const host = document.createElement("span");
      host.setAttribute(MOUNT, "");
      host.style.cssText = "display:inline-flex;align-items:center;";

      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-dsh-recall-pending", "");
      button.title = labels.recallPending;
      button.setAttribute("aria-label", labels.recallPending);
      button.style.cssText = "display:inline-flex;align-items:center;justify-content:center;"
        + "width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;"
        + "color:inherit;opacity:.7;cursor:pointer;line-height:1;";
      button.innerHTML = iconSvg();
      button.addEventListener("mouseenter", () => { button.style.opacity = "1"; });
      button.addEventListener("mouseleave", () => { button.style.opacity = "0.7"; });

      let busy = false;
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (busy) return;
        busy = true;
        button.disabled = true;
        button.style.opacity = "0.45";
        try {
          const sessionId = currentSessionId(ctx);
          if (!sessionId) throw new Error("取不到当前会话");
          const result = await callApi("recall", {
            sessionId,
            pending: true,
            text: messageText,
          });
          if (!result?.ok) throw new Error(result?.message ?? labels.failed);
          bubble.remove();
        } catch (error) {
          button.title = String(error?.message ?? error);
        } finally {
          busy = false;
          button.disabled = false;
          button.style.opacity = "0.7";
        }
      });

      host.appendChild(button);
      return host;
    }

    /**
     * 造一个撤回按钮。
     *
     * @param target - `{ messageId, text }`，优先用 messageId 精确定位。
     * @param ctx - 插件上下文。
     * @param onRecalled - 撤回成功回调。
     * @returns 按钮宿主元素。
     */
    function buildButton(target, ctx, onRecalled) {
      const labels = dict();

      const host = document.createElement("span");
      host.setAttribute(MOUNT, "");
      host.style.cssText = "position:relative;display:inline-flex;align-items:center;";

      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-dsh-recall-button", "");
      button.title = labels.recall;
      button.setAttribute("aria-label", labels.recall);
      button.style.cssText = "display:inline-flex;align-items:center;justify-content:center;"
        + "width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;"
        + "color:inherit;opacity:.7;cursor:pointer;line-height:1;";
      button.innerHTML = iconSvg();
      button.addEventListener("mouseenter", () => { button.style.opacity = "1"; });
      button.addEventListener("mouseleave", () => { button.style.opacity = "0.7"; });

      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      menu.style.cssText = "position:absolute;bottom:calc(100% + 6px);right:0;min-width:200px;"
        + "padding:4px;border-radius:8px;border:1px solid rgba(127,127,127,.24);"
        + "background:var(--dsw-alias-bg-elevated,#1f1f1f);box-shadow:0 6px 20px rgba(0,0,0,.3);"
        + "z-index:50;display:none;";

      const notice = document.createElement("span");
      notice.style.cssText = "font-size:11px;margin-left:4px;opacity:.75;";

      const item = (scope, label) => {
        const el = document.createElement("button");
        el.type = "button";
        el.setAttribute("role", "menuitem");
        el.setAttribute("data-dsh-recall-scope", scope);
        el.textContent = label;
        el.style.cssText = "display:block;width:100%;padding:7px 10px;border:0;border-radius:6px;"
          + "background:transparent;color:inherit;text-align:left;font-size:12px;cursor:pointer;"
          + "white-space:nowrap;";
        el.addEventListener("mouseenter", () => { el.style.background = "rgba(127,127,127,.16)"; });
        el.addEventListener("mouseleave", () => { el.style.background = "transparent"; });
        el.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void run(scope);
        });
        return el;
      };

      // 「仅撤回本条」放第一位：破坏面最小，是最常用也最安全的操作。
      menu.appendChild(item("only", labels.only));
      menu.appendChild(item("from", labels.fromWarn));

      let busy = false;

      const run = async (scope) => {
        if (busy) return;
        busy = true;
        menu.style.display = "none";
        button.disabled = true;
        button.style.opacity = "0.45";
        button.title = labels.busy;
        notice.textContent = "";
        try {
          const sessionId = currentSessionId(ctx);
          if (!sessionId) throw new Error("取不到当前会话");
          // 优先用 messageId 精确撤回；只有拿不到 id 时才退回按文本。
          const payload = { sessionId, scope, index: target.index };
          const result = await callApi("recall", payload);
          if (!result?.ok) throw new Error(result?.message ?? labels.failed);
          await onRecalled?.(result, scope);
        } catch (error) {
          notice.textContent = String(error?.message ?? error);
        } finally {
          // 无论成功失败都必须复位，否则按钮永远停在「撤回中…」。
          busy = false;
          button.disabled = false;
          button.style.opacity = "0.7";
          button.title = labels.recall;
        }
      };

      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (busy) return;
        menu.style.display = menu.style.display === "none" ? "block" : "none";
      });

      const onDoc = (event) => {
        if (host.contains(event.target)) return;
        menu.style.display = "none";
      };
      document.addEventListener("mousedown", onDoc, true);

      host.appendChild(button);
      host.appendChild(menu);
      host.appendChild(notice);
      return host;
    }

    /* ================================================================ */
    /* 扫描挂载                                                         */
    /* ================================================================ */

    /**
     * 收集页面上所有用户消息行，按视觉顺序返回。
     *
     * 不依赖 data-chat-node-key / flow-kind 的具体取值（各版本不一致），
     * 只用「有复制按钮的操作条」这一稳定特征。
     *
     * @returns 用户消息行数组，按页面从上到下排列。
     */
    function collectUserRows() {
      const rows = [];
      for (const bar of document.querySelectorAll("[class*='_actions']")) {
        if (!(bar instanceof HTMLElement)) continue;
        let hasCopy = false;
        for (const button of bar.querySelectorAll("button")) {
          const label = (button.getAttribute("aria-label") ?? button.getAttribute("title") ?? "").trim();
          if (/复制|copy/i.test(label)) { hasCopy = true; break; }
        }
        if (!hasCopy) continue;
        const row = bar.closest("[data-chat-flow-key]") ?? bar.parentElement;
        if (!row || rows.includes(row)) continue;
        rows.push({ row, bar });
      }
      // 按文档顺序排序（querySelectorAll 已保证，但兜底一次）。
      rows.sort((a, b) => {
        const pos = a.row.compareDocumentPosition(b.row);
        return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      return rows;
    }

    function sweep(ctx) {
      let added = 0;
      const rows = collectUserRows();

      rows.forEach((entry, index) => {
        const { row, bar } = entry;
        if (bar.querySelector(`[${MOUNT}]`)) return;

        const text = bubbleTextOf(row, bar);
        // index 是「页面上第几条用户消息」，宿主按同一顺序取，最可靠。
        bar.appendChild(buildButton({ index, text }, ctx, (result, scope) => {
          updateView(bar, scope || "only");
        }));
        added += 1;
      });

      // 排队中的消息
      for (const bubble of document.querySelectorAll("[data-pending-steering]")) {
        if (!(bubble instanceof HTMLElement)) continue;
        if (bubble.querySelector(`[${MOUNT}]`)) continue;
        const host = document.createElement("span");
        host.setAttribute(MOUNT, "");
        host.style.cssText = "display:inline-flex;align-items:center;margin-left:6px;";
        bubble.appendChild(host);
        host.appendChild(buildPendingButton((bubble.textContent ?? "").trim(), ctx, bubble));
        added += 1;
      }

      return added;
    }

    /* ================================================================ */
    /* 插件                                                             */
    /* ================================================================ */

    function apply(ctx) {
      ctx.effect(() => {
        try { ctx.locale?.register?.("message-recall", TEXT); } catch { /* 忽略 */ }
        return () => {};
      }, "dsh-message-recall: dictionaries");

      // 助手回复的独立撤回按钮：走官方 assistant-actions 槽位（官方扩展点）。
      // 每条助手消息都有自己的撤回按钮，与用户消息功能一致。
      ctx.slots?.inject?.("conversation.chat.assistant-actions", () => {
        try {
          return ctx.slots.register(
            {
              name: "conversation.chat.assistant-actions",
              id: "dsh-message-recall-assistant",
              order: 10,
              inject: (sessionId) => ({ sessionId }),
            },
            (props) => {
              const messageId = props?.messageId;
              const labels = dict();

              // 用 React 渲染按钮，符合槽位契约。
              return h("button", {
                type: "button",
                "data-dsh-recall-assistant": "",
                title: labels.recall,
                "aria-label": labels.recall,
                style: {
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: "20px", height: "20px", padding: "0", border: "0",
                  borderRadius: "5px", background: "transparent", color: "inherit",
                  opacity: 0.7, cursor: "pointer", lineHeight: 1,
                },
                onClick: async (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  try {
                    const r = await callApi("recall", { sessionId: props?.sessionId, messageId, scope: "only" });
                    if (!r?.ok) throw new Error(r?.message ?? labels.failed);
                  } catch (e) {
                    event.currentTarget.title = String(e?.message ?? e);
                  }
                },
                dangerouslySetInnerHTML: { __html: iconSvg() },
              });
            },
          );
        } catch {
          return () => {};
        }
      });

      let observer = null;
      let timer = null;

      ctx.effect(() => {
        // 启动自愈：清掉上一次可能残留的隐藏状态。
        // 若曾因 bug 隐藏了整屏，这一步会把它们全部恢复。
        try {
          for (const node of document.querySelectorAll("[data-dsh-recall-hidden]")) {
            node.style.display = "";
            node.removeAttribute("data-dsh-recall-hidden");
          }
        } catch { /* 忽略 */ }

        // 实测上报：把页面真实 DOM 状态发给宿主，用于诊断（不改任何显示）。
        try {
          const report = () => {
            try {
              const flows = document.querySelectorAll("[data-chat-flow-key]").length;
              const hidden = document.querySelectorAll("[data-dsh-recall-hidden]").length;
              const visible = [...document.querySelectorAll("[data-chat-flow-key]")]
                .filter((n) => getComputedStyle(n).display !== "none").length;
              // 上报所有会话容器，区分哪个是可见的
              const roots = [...document.querySelectorAll("[data-conversation-session]")].map((n) => {
                const cs = getComputedStyle(n);
                const r = n.getBoundingClientRect();
                const flows = n.querySelectorAll("[data-chat-flow-key]").length;
                return {
                  id: n.getAttribute("data-conversation-session") || "(empty)",
                  display: cs.display,
                  visibility: cs.visibility,
                  w: Math.round(r.width),
                  h: Math.round(r.height),
                  flows,
                };
              });
              const root = document.querySelector("[data-conversation-session]");
              fetch("/dsh-message-recall/dom-report", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  session: root?.getAttribute("data-conversation-session") ?? "",
                  roots,
                  picked: (() => { try { return currentSessionId(ctx); } catch { return 'ERR'; } })(),
                  sampleIds: [...document.querySelectorAll("[class*='_actions']")].slice(0, 6).map((bar) => {
                    const row = bar.closest("[data-chat-flow-key]") ?? bar.parentElement;
                    const node = row?.closest("[data-chat-node-key]") ?? row?.querySelector("[data-chat-node-key]");
                    return {
                      raw: (node?.getAttribute("data-chat-node-key") ?? "").slice(0, 50),
                      id: (() => { try { return messageIdOf(row); } catch { return "ERR"; } })().slice(0, 40),
                    };
                  }),
                  containers: [...document.querySelectorAll("[data-conversation-session]")].map((n) => {
                    const r = n.getBoundingClientRect();
                    return { id: (n.getAttribute("data-conversation-session") || "").slice(0, 26), h: Math.round(r.height), w: Math.round(r.width) };
                  }),
                  scrolls: [...document.querySelectorAll("[data-conversation-scroll]")].map((n) => {
                    const r = n.getBoundingClientRect();
                    return { h: Math.round(r.height), scrollH: n.scrollHeight, flows: n.querySelectorAll("[data-chat-flow-key]").length };
                  }),
                  inlineHidden: [...document.querySelectorAll("[style*='display: none']")].slice(0, 8).map((n) => ({
                    tag: n.tagName,
                    flow: n.getAttribute("data-chat-flow-key") ?? null,
                    sess: n.getAttribute("data-conversation-session") ?? null,
                  })),
                  flows, hidden, visible,
                  hiddenIds: [...document.querySelectorAll("[data-dsh-recall-hidden]")]
                    .slice(0, 5).map((n) => n.getAttribute("data-chat-flow-key")),
                }),
              }).catch(() => {});
            } catch { /* ignore */ }
          };
          window.setTimeout(report, 1500);
          window.setTimeout(report, 4000);
        } catch { /* ignore */ }

        const schedule = () => {
          if (timer !== null) return;
          timer = window.setTimeout(() => {
            timer = null;
            try { sweep(ctx); } catch { /* 单次失败不影响界面 */ }
            syncPurgeComfort();
          }, 150);
        };

        observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });
        schedule();

        return () => {
          try { observer?.disconnect(); } catch { /* 忽略 */ }
          observer = null;
          if (timer !== null) window.clearTimeout(timer);
          for (const node of document.querySelectorAll(`[${MOUNT}]`)) node.remove();
          // 卸载时把兼容样式摘掉，不给其它插件留副作用。
          try { document.getElementById(PURGE_STYLE_ID)?.remove(); } catch { /* 忽略 */ }
        };
      }, "dsh-message-recall: mount");
    }

    return {
      name: NAME,
      inject: ["slots", "locale"],
      apply,
      __test: { dict, bubbleTextOf },
    };
   } catch (error) {
     try {
       window.__DSH_RECALL_ERROR__ = String(error && error.stack || error);
       console.error("[dsh-message-recall] factory failed:", error);
     } catch { /* ignore */ }
     throw error;
   }
  },
});
