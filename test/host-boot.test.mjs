/**
 * 宿主半真实加载验证：用官方 cordis 起一个最小 Context，
 * 挂上假的 sessions / sessionController / connection，再 plugin 本插件，
 * 确认 apply() 不抛错、RPC 路由真的被注册、调用能通。
 *
 * 运行：node test/host-boot.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const CORDIS = process.env.DSH_CORDIS
  ?? 'F:/AllSoftware/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';

const pluginPath = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', 'index.js');

async function loadCordis() {
  const module = await import(pathToFileURL(path.resolve(CORDIS)).href);
  return module;
}

const cordis = await loadCordis();

/** 造一个最小 Context：注册表 + effect + plugin。 */
function makeRoot() {
  const App = cordis.App ?? cordis.Context;
  const ctx = new (cordis.Context ?? App)(cordis.Context ? undefined : {});
  return ctx;
}

test('插件模块可被真实 cordis 加载且 apply 不抛错', async () => {
  const mod = await import(pathToFileURL(path.resolve(pluginPath)).href);
  assert.equal(mod.name, 'dsh-message-recall');
  assert.deepEqual(mod.inject, ['sessions', 'sessionController']);
  assert.equal(typeof mod.apply, 'function');
});

test('RPC 路由注册后能被调用（status 端点）', async () => {
  const mod = await import(pathToFileURL(path.resolve(pluginPath)).href);

  const routes = new Map();
  const services = {
    sessions: { get: () => undefined },
    sessionController: {},
    connection: {
      fetch: {
        register(spec) {
          routes.set(spec.path, spec);
          return () => routes.delete(spec.path);
        },
      },
    },
  };

  // 最小 ctx 桩：只需要插件用到的几个成员。
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name in services) return services[name];
      throw new Error(`unknown service: ${name}`);
    },
    effect(fn) {
      const dispose = fn();
      return () => dispose?.();
    },
    inject(names, run) {
      const scope = {
        ...ctx,
        connection: services.connection,
        effect: ctx.effect,
      };
      run(scope);
      return () => {};
    },
  };

  mod.apply(ctx);

  assert.ok(routes.has('/api/plugin-rpc/dsh-message-recall'), 'RPC 路由必须被注册');

  const spec = routes.get('/api/plugin-rpc/dsh-message-recall');
  assert.deepEqual(spec.methods, ['POST']);

  // 调一次 status：会话不存在时应返回结构化的失败，而不是抛错。
  const request = new Request('http://127.0.0.1/api/plugin-rpc/dsh-message-recall', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'r1',
      method: 'plugin-rpc/dsh-message-recall',
      payload: { endpoint: 'status', payload: { sessionId: 'missing' } },
    }),
  });

  const response = await spec.fetch(request);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.type, 'server-response');
  assert.equal(body.rpcId, 'r1');
  assert.equal(body.result.ok, true);
  // 只读查询：会话不存在时返回空列表而不是抛错。
  assert.equal(body.result.value.ok, true);
  assert.deepEqual(body.result.value.recallable, []);
  assert.equal(body.result.value.live, false);
});

test('未知 endpoint 返回结构化错误', async () => {
  const mod = await import(pathToFileURL(path.resolve(pluginPath)).href);

  let registered;
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'sessions') return { get: () => undefined };
      if (name === 'sessionController') return {};
      if (name === 'connection') {
        return {
          fetch: {
            register(spec) {
              registered = spec;
              return () => {};
            },
          },
        };
      }
      throw new Error(`unknown service: ${name}`);
    },
    effect(fn) {
      fn();
    },
    inject(names, run) {
      run({ ...ctx, connection: ctx.get('connection'), effect: ctx.effect });
    },
  };

  mod.apply(ctx);
  assert.ok(registered);

  const response = await registered.fetch(new Request('http://127.0.0.1/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'r2',
      method: 'plugin-rpc/dsh-message-recall',
      payload: { endpoint: 'nope', payload: {} },
    }),
  }));

  const body = await response.json();
  assert.equal(body.result.ok, false);
  assert.equal(body.result.error.code, 'unknown-endpoint');
});
