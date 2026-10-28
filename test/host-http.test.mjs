/**
 * 真机 HTTP 验证：起一个真 node:http 服务，挂上插件的路由，
 * 用真 fetch 打过去，确认 200 + 正确 JSON。
 *
 * 运行：node test/host-http.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginPath = path.join(here, '..', 'index.js');

/** 起一个真 HTTP 服务，把插件的 prefix 路由挂上去。 */
async function startServer(session) {
  const mod = await import(pathToFileURL(path.resolve(pluginPath)).href);

  let route;
  const services = {
    sessions: { get: (id) => (id === session?.id ? session : undefined), list: () => (session ? [session] : []) },
    sessionController: {},
  };

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name in services) return services[name];
      throw new Error(`unknown service: ${name}`);
    },
    effect(fn) {
      fn();
    },
    inject(names, run) {
      run({
        ...ctx,
        webServer: {
          register(spec) {
            route = spec;
            return () => {};
          },
        },
      });
    },
  };

  mod.apply(ctx);
  assert.ok(route, '路由必须被注册');

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/dsh-message-recall')) {
      route.handler(request, response).catch((error) => {
        response.writeHead(500);
        response.end(String(error));
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

/** 造一个最小可用会话。 */
function makeSession(id) {
  const log = [
    { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第一条' }] } },
    { type: 'assistant/message', seq: 1, time: 2, surfaceOp: 'append', data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '回复一' }] } } },
    { type: 'user/message', seq: 2, time: 3, surfaceOp: 'append', data: { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第二条' }] } },
  ];
  const nodes = [0, 1, 2];
  return {
    id,
    snapshotEvents: () => log,
    surface: { get nodes() { return [...nodes]; } },
    append(type, data, opts) {
      const event = { type, seq: log.length, time: Date.now(), data, ...opts };
      log.push(event);
      const op = opts?.surfaceOp;
      if (op && typeof op === 'object' && op.op === 'replace') {
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          if (nodes[i] >= op.startSeq && nodes[i] <= op.endSeq) nodes.splice(i, 1);
        }
      }
      nodes.push(event.seq);
      return event;
    },
    deriveMessages() {
      return log.filter((event) => event.type === 'user/message' || event.type === 'assistant/message');
    },
  };
}

test('真 HTTP：status 返回 200 与可撤回列表', async () => {
  const session = makeSession('session-http-1');
  const { server, base } = await startServer(session);
  try {
    const response = await fetch(`${base}/dsh-message-recall/status?sessionId=session-http-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.recallable.map((row) => row.seq), [0, 2]);
  } finally {
    server.close();
  }
});

test('真 HTTP：recall scope=only 只掉一条', async () => {
  const session = makeSession('session-http-2');
  const { server, base } = await startServer(session);
  try {
    const response = await fetch(`${base}/dsh-message-recall/recall?sessionId=session-http-2&seq=2&scope=only`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.scope, 'only');
    assert.equal(body.startSeq, 2);
    assert.equal(body.endSeq, 2);
    assert.equal(body.text, '第二条');

    // 第一条仍在。
    const status = await fetch(`${base}/dsh-message-recall/status?sessionId=session-http-2`, { method: 'POST', body: '{}' });
    const statusBody = await status.json();
    assert.deepEqual(statusBody.recallable.map((row) => row.seq), [0]);
  } finally {
    server.close();
  }
});

test('真 HTTP：recall scope=from 掉本条及之后', async () => {
  const session = makeSession('session-http-3');
  const { server, base } = await startServer(session);
  try {
    const response = await fetch(`${base}/dsh-message-recall/recall?sessionId=session-http-3&seq=2&scope=from`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = await response.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.startSeq, 2);
    assert.equal(body.endSeq, 2);
    assert.equal(body.recalledCount, 1);
  } finally {
    server.close();
  }
});
