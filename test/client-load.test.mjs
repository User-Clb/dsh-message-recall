/**
 * 客户端包验证：原生 DOM 实现，零侵入官方 React 树。
 *
 * 运行：node --test test/client-load.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, "..", "client.cjs");

/** 造一个够用的最小 DOM。 */
function makeDom() {
  const makeElement = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      style: { cssText: "" },
      children: [],
      textContent: "",
      innerHTML: "",
      _attrs: new Map(),
      setAttribute(name, value) { el._attrs.set(name, String(value)); },
      getAttribute(name) { return el._attrs.has(name) ? el._attrs.get(name) : null; },
      removeAttribute(name) { el._attrs.delete(name); },
      appendChild(child) { el.children.push(child); return child; },
      remove() {},
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      contains() { return false; },
      closest() { return null; },
    };
    return el;
  };

  const document = {
    documentElement: { lang: "zh" },
    head: { appendChild() {} },
    body: makeElement("body"),
    getElementById: () => null,
    createElement: (tag) => makeElement(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };

  return { document };
}

/** 在沙箱里执行客户端包。 */
function loadClient() {
  const source = fs.readFileSync(clientPath, "utf8");
  const captured = {};
  const { document } = makeDom();

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          captured.id = id;
          captured.exports = factory(() => {
            throw new Error("本实现不应 require 任何模块");
          });
        },
      },
      location: { origin: "http://127.0.0.1:1", hash: "" },
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
    document,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    AbortController: class {
      constructor() { this.signal = undefined; }
      abort() {}
    },
    fetch: async () => ({ status: 200, text: async () => "{}" }),
    URL,
    console,
    setTimeout,
    clearTimeout,
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "client.cjs" });
  return captured;
}

test("客户端包可被求值且导出结构正确", () => {
  const captured = loadClient();
  assert.equal(captured.id, "dsh-message-recall");
  assert.equal(captured.exports.name, "dsh-message-recall");
  assert.equal(typeof captured.exports.apply, "function");
  assert.ok(Array.isArray(captured.exports.inject));
});

test("apply 不注册任何槽位、不覆盖官方节点（零侵入）", () => {
  const captured = loadClient();
  let registered = 0;
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    locale: { register() {}, bind: () => (key) => key },
    get() {
      throw new Error("unknown service");
    },
    effect(fn) {
      const dispose = fn();
      return () => dispose?.();
    },
    slots: {
      inject() {
        throw new Error("不应注入任何槽位");
      },
      register() {
        registered += 1;
        return () => {};
      },
    },
  };

  captured.exports.apply(ctx);
  assert.equal(registered, 0, "不得注册槽位，避免干扰官方渲染树");
});

test("气泡取文本会剔除操作条内容", () => {
  const captured = loadClient();
  const bubbleTextOf = captured.exports.__test?.bubbleTextOf;
  assert.equal(typeof bubbleTextOf, "function", "需要导出 bubbleTextOf 供测试");

  // 构造：正文在子 div，操作条是另一个容器（含时间与按钮）。
  const makeNode = (tag, text, kids = []) => {
    const el = {
      nodeType: 1,
      tagName: tag,
      childNodes: [],
      contains(other) { return el === other; },
    };
    const nodes = [...kids];
    if (text !== undefined) {
      nodes.unshift({ nodeType: 3, nodeValue: text });
    }
    el.childNodes = nodes;
    return el;
  };

  const body = makeNode("DIV", "要撤回的正文", []);
  const time = makeNode("SPAN", "10月28日 23:34", []);
  const copyBtn = makeNode("BUTTON", undefined, []);
  const bar = makeNode("DIV", undefined, [time, copyBtn]);
  const row = makeNode("DIV", undefined, [body, bar]);

  const text = bubbleTextOf(row, bar);
  assert.equal(text, "要撤回的正文", "不得包含时间戳或按钮文案");
});
