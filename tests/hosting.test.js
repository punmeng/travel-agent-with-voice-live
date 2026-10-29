import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';
import { hostingPolicy } from '../lib/hosting.js';
import { createApp } from '../server.js';

const publicOrigin = 'https://travel.example.com';
const hosted = { APP_MODE: 'mock', HOSTING_MODE: 'azure', PUBLIC_ORIGIN: publicOrigin };

test('hosting defaults remain loopback-only and exact HTTP same-origin', () => {
  const policy = hostingPolicy({});
  assert.equal(policy.bindAddress, '127.0.0.1');
  assert.equal(policy.secureCookies, false);
  for (const host of ['localhost', '127.0.0.1', 'localhost:3100', '127.0.0.1:3100']) {
    assert.equal(policy.acceptsHost(host), true);
    assert.equal(policy.acceptsOrigin(host, `http://${host}`), true);
    assert.equal(policy.acceptsOrigin(host, `https://${host}`), false);
  }
  for (const host of [undefined, ['localhost'], 'evil.localhost', 'travel.example.com', 'localhost.evil.invalid']) {
    assert.equal(policy.acceptsHost(host), false);
  }
});

test('hosted policy fails startup on ambiguous or unsafe configuration', () => {
  assert.throws(() => hostingPolicy({ HOSTING_MODE: 'production' }), /HOSTING_MODE/);
  assert.throws(() => hostingPolicy({ PUBLIC_ORIGIN: publicOrigin }), /requires HOSTING_MODE/);
  assert.throws(() => createApp({ ...hosted, PUBLIC_ORIGIN: undefined }), /PUBLIC_ORIGIN/);
  for (const origin of [
    '', 'http://travel.example.com', 'https://travel.example.com/', 'https://travel.example.com/path',
    'https://travel.example.com?x=1', 'https://travel.example.com#hash',
    'https://name:password@travel.example.com', 'https://travel.example.com:443',
    'https://travel.example.com:8443', 'https://TRAVEL.example.com',
    'https://localhost', 'https://test.localhost', 'https://127.0.0.1',
    'https://[::1]', 'https://*.example.com', 'https://travel.example.com.',
    'https://travel_example.com', ' https://travel.example.com'
  ]) {
    assert.throws(() => hostingPolicy({ ...hosted, PUBLIC_ORIGIN: origin }), /PUBLIC_ORIGIN/, origin);
  }
});

test('hosted policy accepts only the configured host and HTTPS origin', () => {
  const policy = hostingPolicy(hosted);
  assert.equal(policy.bindAddress, '0.0.0.0');
  assert.equal(policy.secureCookies, true);
  assert.equal(policy.acceptsOrigin('travel.example.com', publicOrigin), true);
  for (const host of [undefined, 'localhost', '127.0.0.1', 'travel.example.com:443', 'other.example.com']) {
    assert.equal(policy.acceptsHost(host), false);
    assert.equal(policy.acceptsOrigin(host, publicOrigin), false);
  }
  for (const origin of [undefined, 'null', ['https://travel.example.com'], 'http://travel.example.com',
    `${publicOrigin}/`, 'https://other.example.com', `${publicOrigin}.evil.invalid`]) {
    assert.equal(policy.acceptsOrigin('travel.example.com', origin), false);
  }
});

async function startApp(context, env, dependencies = {}) {
  const server = createApp(env, dependencies);
  const connections = new Set();
  server.on('connection', socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    for (const socket of connections) socket.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const request = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { host: 'travel.example.com', connection: 'close', ...headers }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { server, request };
}

test('hosted HTTP uses Secure cookies and ignores forged forwarding headers', { timeout: 10000 }, async context => {
  const { request } = await startApp(context, hosted);
  assert.equal((await request('/api/health')).status, 200);
  const boot = await request('/api/bootstrap');
  assert.equal(boot.status, 200);
  const cookie = boot.headers['set-cookie'][0];
  assert.match(cookie, /; Secure$/);
  assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\//);
  const post = headers => request('/api/language', {
    method: 'POST', headers: { cookie: cookie.split(';')[0], 'content-type': 'application/json', ...headers },
    body: { locale: 'en-US' }
  });
  assert.equal((await post({ origin: publicOrigin })).status, 200);
  for (const origin of [undefined, 'http://travel.example.com', 'https://evil.invalid']) {
    const response = await post({ ...(origin ? { origin } : {}), 'x-forwarded-proto': 'https',
      'x-forwarded-host': 'travel.example.com' });
    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'ORIGIN_FORBIDDEN');
  }
  const forged = await request('/api/health', {
    headers: { host: 'evil.invalid', 'x-forwarded-host': 'travel.example.com', 'x-forwarded-proto': 'https' }
  });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.error, 'HOST_FORBIDDEN');
});

test('local HTTP still rejects public hosts and leaves the local cookie usable over HTTP', async context => {
  const { server, request } = await startApp(context, { APP_MODE: 'mock' });
  assert.equal((await request('/api/health')).status, 403);
  const response = await request('/api/bootstrap', { headers: { host: `127.0.0.1:${server.address().port}` } });
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.headers['set-cookie'][0], /Secure/);
});

class Upstream extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  send() {}
  close() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
}

test('hosted WS requires exact HTTPS origin and retains session-bound single-use tickets', { timeout: 15000 }, async context => {
  let connections = 0;
  const env = { ...hosted, VOICE_LIVE_ENABLED: 'true', VOICE_LIVE_ENDPOINT: 'https://demo.services.ai.azure.com/' };
  const { server, request } = await startApp(context, env, { voice: {
    credential: { getToken: async () => ({ token: 'test-only-token' }) },
    connect: () => {
      connections++;
      const upstream = new Upstream();
      setImmediate(() => {
        upstream.emit('open');
        upstream.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })), false);
      });
      return upstream;
    }
  } });
  const bootstrap = await request('/api/bootstrap');
  const cookie = bootstrap.headers['set-cookie'][0].split(';')[0];
  const post = () => request('/api/voice/session', {
    method: 'POST', headers: { cookie, origin: publicOrigin, 'content-type': 'application/json' }, body: {}
  });
  const wsurl = `ws://127.0.0.1:${server.address().port}/api/voice/stream`;
  const sockets = [];
  context.after(() => { for (const socket of sockets) socket.terminate(); });
  const connect = (ticket, headers) => {
    const socket = new WebSocket(wsurl, ['journey-voice', ticket.nonce], {
      headers: { host: 'travel.example.com', origin: publicOrigin, cookie, ...headers }
    });
    sockets.push(socket);
    return socket;
  };
  const denied = async (ticket, headers) => {
    const socket = connect(ticket, headers);
    const status = await new Promise((resolve, reject) => {
      socket.on('unexpected-response', (_req, res) => {
        res.resume(); socket.terminate(); resolve(res.statusCode);
      });
      socket.on('open', () => { socket.close(); reject(new Error('Unexpected WebSocket upgrade')); });
      socket.on('error', () => {});
    });
    assert.equal(status, 403);
  };
  const ticket = (await post()).body;
  await denied(ticket, { origin: 'http://travel.example.com' });
  await denied(ticket, { origin: 'https://evil.invalid', 'x-forwarded-proto': 'https' });
  await denied(ticket, { host: 'evil.invalid', 'x-forwarded-host': 'travel.example.com' });
  await denied(ticket, { cookie: 'journey=another-session' });
  assert.equal(connections, 0);
  const next = await post();
  assert.equal(next.status, 200);
  const socket = connect(next.body, {});
  const [message] = await once(socket, 'message');
  assert.equal(JSON.parse(message).type, 'ready');
  assert.equal(connections, 1);
  await denied(next.body, {});
  const close = once(socket, 'close');
  socket.send(JSON.stringify({ type: 'stop' }));
  await close;
});
