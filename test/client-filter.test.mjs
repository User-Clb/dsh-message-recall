/**
 * 客户端窗口过滤逻辑验证：撤回标记必须把自身与被遮蔽区间一起剔除。
 *
 * 运行：node test/client-filter.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client.cjs');

/**
 * 在受控沙箱里加载 client.cjs，取出内部纯函数。
 *
 * 客户端包是 `window.__ModuleLoader__.load({...})` 形式，
 * 这里用一个伪造的 loader 捕获 factory，再用最小 require 桩执行。
 */
function loadClientInternals() {
  const source = fs.readFileSync(clientPath, 'utf8');

  const fakeReact = {
    createElement: () => null,
    useMemo: (fn) => fn(),
    useState: (initial) => [initial, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
    Component: class Component {
      constructor(props) {
        this.props = props;
        this.state = {};
      }
    },
  };

  const captured = {};
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          captured.id = id;
          captured.exports = factory((name) => {
            if (name === 'react') return fakeReact;
            throw new Error(`unexpected require: ${name}`);
          });
        },
      },
    },
    document: { documentElement: { lang: 'zh' }, querySelector: () => null },
    navigator: {},
    console,
    setTimeout,
    clearTimeout,
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.cjs' });

  assert.equal(captured.id, 'dsh-message-recall');
  return captured.exports;
}

const plugin = loadClientInternals();

test('插件导出结构正确', () => {
  assert.equal(plugin.name, 'dsh-message-recall');
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(Array.isArray(plugin.inject));
});

test('dropRecalled 剔除撤回标记与其遮蔽区间', async () => {
  const dropRecalled = plugin.__test?.dropRecalled;
  assert.ok(typeof dropRecalled === 'function', '客户端需导出 dropRecalled 供测试');

  const entries = [
    { event: { type: 'system/message', seq: 0, surfaceOp: 'append', data: {} } },
    { event: { type: 'user/message', seq: 1, surfaceOp: 'append', data: { id: 'u1' } } },
    { event: { type: 'assistant/message', seq: 2, surfaceOp: 'append', data: {} } },
    { event: { type: 'user/message', seq: 3, surfaceOp: 'append', data: { id: 'u2' } } },
    {
      event: {
        type: 'user/message',
        seq: 4,
        surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 },
        sourceEventSeqs: [3],
        data: { id: 'recall-abc', content: [] },
      },
    },
  ];

  const kept = dropRecalled(entries).map((entry) => entry.event.seq);
  assert.deepEqual(kept, [0, 1, 2]);
});

test('dropRecalled 无撤回时原样返回', async () => {
  const dropRecalled = plugin.__test?.dropRecalled;
  const entries = [
    { event: { type: 'user/message', seq: 0, surfaceOp: 'append', data: { id: 'a' } } },
    { event: { type: 'assistant/message', seq: 1, surfaceOp: 'append', data: {} } },
  ];
  const kept = dropRecalled(entries).map((entry) => entry.event.seq);
  assert.deepEqual(kept, [0, 1]);
});
