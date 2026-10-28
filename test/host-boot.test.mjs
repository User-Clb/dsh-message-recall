/**
 * 宿主半真实加载验证：模拟官方 webServer，确认路由注册与调用都通。
 *
 * 运行：node test/host-boot.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginPath = path.join(here, '..', 'index.js');

/** 构造最小宿主 ctx：只有插件真正会用到的成员。 */
function makeCtx(services) {
  const routes = [];
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
      run({ ...ctx, ...Object.fromEntries(names.map((n) => [n, services[n]])) });
      return () => {};
    },
  };
  return { ctx, routes };
}

/** 造一个 webServer 桩，记录注册的路由。 */
function makeWebServer(routes) {
  return {
    register(spec, label) {
      routes.push({ spec, label });
      return () => {
        const index = routes.findIndex((row) => row.spec === spec);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
}

/** 用一个真实可迭代的 request 跑一次路由（与官方 webServer 行为一致）。 */
async function invoke(spec, pathname, payload) {
  const body = JSON.stringify(payload ?? {});
  const request = Readable.from([Buffer.from(body)]);
  request.method = 'POST';
  request.url = pathname;

  let status = 0;
  let text = '';
  const response = {
    writeHead(code) {
      status = code;
      return response;
    },
    end(chunk) {
      if (chunk !== undefined) text += String(chunk);
    },
  };

  await spec.handler(request, response);
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status, text, json };
}

test('插件模块结构正确', async () => {
  const mod = await import(pathToFileURL(path.resolve(pluginPath)).href);
  assert.equal(mod.name, 'dsh-message-recall');
  assert.deepEqual(mod.inject, ['sessions', 'sessionController']);
  assert.equal(typeof mod.apply, 'function');
});

test('路由注册成功且能响应 status', async () => {
  const mod = await import(pathToFileURL(path.resolve(pluginPath)).href);
  const { ctx, routes } = makeCtx({
    sessions: { get: () => undefined },
    sessionController: {},
    webServer: undefined,
  });
  ctx.inject = (names, run) => {
    const scope = { ...ctx, webServer: makeWebServer(routes) };
    run(scope);
    return () => {};
  };

  mod.apply(ctx);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].spec.path, '/dsh-message-recall');

  const result = await invoke(routes[0].spec, '/dsh-message-recall/status', { sessionId: 'missing' });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.deepEqual(result.json.recallable, []);
});

test('未知 action 返回 404', async () => {
  const mod = await import(pathToFileURL(path.resolve(pluginPath)).href);
  const { ctx, routes } = makeCtx({
    sessions: { get: () => undefined },
    sessionController: {},
  });
  ctx.inject = (names, run) => {
    run({ ...ctx, webServer: makeWebServer(routes) });
    return () => {};
  };
  mod.apply(ctx);

  const result = await invoke(routes[0].spec, '/dsh-message-recall/nope', {});
  assert.equal(result.status, 404);
  assert.equal(result.json.code, 'unknown-action');
});
