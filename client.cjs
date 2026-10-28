// dsh-message-recall 客户端半。
//
// 职责边界（刻意做到最小、最安全）：
//   - 只在用户消息框的复制按钮旁插一个撤回按钮（原生 DOM，不覆盖官方槽位）；
//   - 点击后调用宿主 /dsh-message-recall/recall，由宿主真删除（表面替换 + 派生缓存失效）；
//   - 宿主成功后，让当前会话重新加载窗口，界面自然少掉那几条（不再用 CSS 假装隐藏）。
//
// 不碰装配器、不覆盖官方 React 树、不改其它插件，任何异常都只影响按钮自身。
window.__ModuleLoader__.load({
  id: "dsh-message-recall",
  factory: () => {
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
        scope: "选择撤回范围",
      },
      en: {
        recall: "Recall",
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
    async function reloadSession(sessionId, ctx) {
      if (!sessionId) return false;

      const conversation = (() => {
        try { return ctx?.get?.("uiConversation", false); } catch { return undefined; }
      })();

      // 用装配器当前窗口重新装配一次：它内部会按 rewind- 标记剔除。
      try {
        const binding = conversation?.binding?.(sessionId);
        const assembler = binding?.assembler;
        if (assembler && typeof assembler.replaceWindow === "function") {
          const inputs = assembler.inputs;
          if (inputs instanceof Map && inputs.size > 0) {
            assembler.replaceWindow([...inputs.values()], assembler.hasMore === true);
            return true;
          }
        }
      } catch {
        /* 继续兜底 */
      }

      // 兜底：重新打开会话（官方 openSession = replaceMain(..., "reveal")）。
      try {
        const workspace = ctx?.get?.("uiWorkspace", false);
        if (workspace && typeof workspace.openSession === "function") {
          workspace.openSession(sessionId);
          return true;
        }
      } catch {
        /* 忽略 */
      }
      return false;
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
    function currentSessionId(ctx) {
      try {
        const workspace = ctx?.get?.("uiWorkspace", false);
        const selected = workspace?.selection?.getSnapshot?.()?.sessionId;
        if (typeof selected === "string" && selected) return selected;
      } catch {
        /* 继续兜底 */
      }
      try {
        const sessions = ctx?.get?.("sessions", false);
        const list = sessions?.list?.() ?? [];
        // 兜底：取事件最多的活会话。
        let best = "";
        let bestCount = -1;
        for (const row of list) {
          const id = row?.id ?? row?.header?.id;
          if (typeof id !== "string" || !id) continue;
          let count = 0;
          try {
            count = Number(row?.snapshotEvents?.()?.length ?? 0);
          } catch {
            count = 0;
          }
          if (count >= bestCount) {
            bestCount = count;
            best = id;
          }
        }
        return best;
      } catch {
        return "";
      }
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
    function messageIdOf(row) {
      const node = row.closest("[data-chat-node-key]") ?? row.querySelector("[data-chat-node-key]");
      const raw = node?.getAttribute("data-chat-node-key") ?? "";
      if (!raw) return "";
      // key 可能是 JSON 数组，也可能就是裸 id。
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const part of parsed) {
            if (typeof part !== "string") continue;
            const match = part.match(/^input-message(.+)$/);
            if (match) return match[1];
          }
          return "";
        }
      } catch {
        /* 不是 JSON，按裸值处理 */
      }
      const match = raw.match(/^input-message(.+)$/);
      return match ? match[1] : "";
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
          const payload = { sessionId, scope };
          if (target.messageId) payload.messageId = target.messageId;
          else payload.text = target.text;
          const result = await callApi("recall", payload);
          if (!result?.ok) throw new Error(result?.message ?? labels.failed);
          await onRecalled?.(result);
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

    function sweep(ctx) {
      let added = 0;
      for (const row of document.querySelectorAll("[data-chat-flow-kind='user']")) {
        if (!(row instanceof HTMLElement)) continue;
        if (row.querySelector(`[${MOUNT}]`)) continue;

        const bar = findActionRow(row);
        if (!bar) continue;

        const text = bubbleTextOf(row, bar);
        const messageId = messageIdOf(row);
        if (!text && !messageId) continue;

        bar.appendChild(buildButton({ messageId, text }, ctx, async (result) => {
          // 宿主已经真删除了；这里让会话窗口按新表面重建。
          await reloadSession(result.sessionId, ctx);
        }));
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

      let observer = null;
      let timer = null;

      ctx.effect(() => {
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
  },
});
