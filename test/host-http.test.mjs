/**
 * 真机加载验证：用真实 node:http 起服务，挂上插件路由，
 * 然后用真 fetch 打过去，确认路由能返回 200。
 *
 * 这个测试证明「插件自身」是对的；若线上 404，就只可能是进程没重启。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginPath = path.join(here, '..', 'index.js');

/** 造一个带官方 surface 语义的会话。 */
function makeSession(id) {
  const log = [
    { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第一条' }] } },
    { type: 'assistant/message', seq: 1, time: 2, surfaceOp: 'append', data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '回复一' }] } } },
    { type: 'user/message', seq: 2, time: 3, surfaceOp: 'append', data: { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '要撤回' }] } },
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
      if (!op || op === 'append') nodes.push(event.seq);
      else if (op.op === 'replace') {
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          if (nodes[i] >= op.startSeq && nodes[i] <= op.endSeq) nodes.splice(i, 1);
        }
        nodes.push(event.seq);
      }
      return event;
    },
    // 按当前表面节点投影消息（与官方 deriveMessages 语义一致），
    // 这样 host 的「模型消息必须变少」校验才能被验证到。
    deriveMessages() {
      return nodes
        .map((seq) => log[seq])
        .filter((event) => event && (event.type === 'user/message' || event.type === 'assistant/message'))
        .map((event) => ({
          id: event.data?.id ?? event.data?.message?.id,
          role: event.type === 'user/message' ? 'user' : 'assistant',
          content: event.data?.content ?? event.data?.message?.content ?? [],
        }));
    },
  };
}

async function startServer(session) {
  const mod = await import(pathToFileURL(path.resolve(pluginPath)).href);

  let route;
  const services = {
    sessions: { get: (id) => (id === session?.id ? session : undefined), list: () => [session] },
    sessionController: { updateQueue: async () => {} },
    agents: { get: () => ({ phase: { kind: 'idle' }, inbox: { nextTurn: [], nextStep: [] } }) },
    webServer: {
      register(spec) {
        route = spec;
        return () => {};
      },
    },
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
      run({ ...ctx, webServer: services.webServer });
    },
  };

  mod.apply(ctx);
  assert.ok(route, '路由必须被注册');
  assert.equal(route.path, '/dsh-message-recall');

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

test('真 HTTP：status 返回可撤回列表', async () => {
  const session = makeSession('session-http');
  const { server, base } = await startServer(session);
  try {
    const response = await fetch(`${base}/dsh-message-recall/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-http' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.recallable.map((row) => row.seq), [0, 2]);
  } finally {
    server.close();
  }
});

test('真 HTTP：recall 让目标离开官方表面', async () => {
  const session = makeSession('session-http-2');
  const { server, base } = await startServer(session);
  try {
    const response = await fetch(`${base}/dsh-message-recall/recall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-http-2', seq: 2, scope: 'only' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.startSeq, 2);
    assert.equal(body.endSeq, 2);
    assert.equal(body.cleared, true);
    assert.ok(!session.surface.nodes.includes(2), '目标必须离开表面');
  } finally {
    server.close();
  }
});
