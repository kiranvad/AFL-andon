'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { generateKeyPairSync } = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { Client, Server } = require('ssh2');
const TiledTunnel = require('../tiledTunnel');

const log = { info() {}, warn() {} };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function listen(server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function sshFixture(t) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const clients = new Set();
  const listeners = new Set();
  const sockets = new Set();
  const requests = [];
  const server = new Server({ hostKeys: [privateKey] }, client => {
    clients.add(client);
    const owned = new Set();
    client.on('error', () => {});
    client.on('authentication', context => context.accept());
    client.on('request', (accept, reject, name, info) => {
      if (name !== 'tcpip-forward' || info.bindAddr !== '127.0.0.1') return reject();
      requests.push(info);
      const listener = net.createServer(socket => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        client.forwardOut(info.bindAddr, listener.address().port, '127.0.0.1', socket.remotePort, (error, channel) => {
          if (error) return socket.destroy();
          channel.on('error', () => socket.destroy());
          channel.on('close', () => socket.destroy());
          socket.on('close', () => channel.destroy());
          socket.pipe(channel).pipe(socket);
        });
      });
      listeners.add(listener);
      owned.add(listener);
      listener.on('error', () => reject());
      listener.listen(info.bindPort, info.bindAddr, () => accept(listener.address().port));
    });
    client.on('close', () => {
      clients.delete(client);
      for (const listener of owned) listener.close();
    });
  });
  const port = await listen(server);
  t.after(async () => {
    for (const client of clients) client.end();
    for (const socket of sockets) socket.destroy();
    for (const listener of listeners) if (listener.listening) listener.close();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    requests, clients,
    async connect() {
      const conn = new Client();
      conn.on('error', () => {});
      conn.connect({ host: '127.0.0.1', port, username: 'test-user', readyTimeout: 1000 });
      await once(conn, 'ready');
      return { conn };
    }
  };
}

function request(url, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: body ? 'PUT' : 'GET',
      headers: { Authorization: 'Apikey test-key', Connection: 'close' },
      agent: false,
      timeout: 2000
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Test request timed out.')));
    req.end(body);
  });
}

test('HTTP metadata reads and binary uploads cross a real reverse SSH tunnel', { timeout: 10000 }, async t => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    res.writeHead(req.method === 'PUT' ? 201 : 200);
    res.end(req.method === 'PUT' ? body : 'metadata');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const fixture = await sshFixture(t);
  const tunnel = new TiledTunnel({ connect: fixture.connect, targetUrl: `http://127.0.0.1:${upstreamPort}`, log, retryDelays: [20] });
  tunnel.serverNames.add('worker');
  t.after(() => tunnel.close());
  const url = await tunnel.ensureReady();
  assert.notEqual(Number(url.port), upstreamPort);
  assert.deepEqual(fixture.requests, [{ bindAddr: '127.0.0.1', bindPort: 0 }]);
  assert.deepEqual(await request(new URL('/api/v1/metadata/', url)), { status: 200, body: Buffer.from('metadata') });
  const body = Buffer.alloc(1024 * 1024, 0xa5);
  assert.deepEqual(await request(new URL('/api/v1/array/full/run?x=1', url), body), { status: 201, body });
  assert.equal(received[1].method, 'PUT');
  assert.equal(received[1].url, '/api/v1/array/full/run?x=1');
  assert.equal(received[1].auth, 'Apikey test-key');
  assert.deepEqual(received[1].body, body);

  // Drop SSH; recovery must retain the URL already stored by the driver.
  const oldConnection = tunnel.conn;
  oldConnection.end();
  await once(oldConnection, 'close');
  for (let i = 0; i < 100 && !tunnel.conn; i++) await sleep(20);
  assert.ok(tunnel.conn);
  assert.equal(tunnel.url.toString(), url.toString());
  assert.deepEqual(fixture.requests[1], { bindAddr: '127.0.0.1', bindPort: Number(url.port) });
  assert.equal((await request(new URL('/api/v1/metadata/', url))).status, 200);
  const liveConnection = tunnel.conn;
  tunnel.close();
  await once(liveConnection, 'close');
  await assert.rejects(request(url));
});

test('concurrent tunnel starts share one forwarding request and reject unrelated ports', async t => {
  const conn = new EventEmitter();
  conn.end = () => conn.emit('close');
  let complete;
  let connections = 0;
  conn.forwardIn = (_address, _port, callback) => { complete = callback; };
  const tunnel = new TiledTunnel({ connect: async () => { connections++; return { conn }; }, targetUrl: 'http://tiled.example:8000', log });
  t.after(() => tunnel.close());
  const first = tunnel.ensureReady();
  const second = tunnel.ensureReady();
  await sleep(0);
  complete(null, 32123);
  assert.equal((await first).toString(), (await second).toString());
  assert.equal(connections, 1);
  let rejected = false;
  conn.emit('tcp connection', { destIP: '0.0.0.0', destPort: 32123 }, () => { throw new Error('Unexpected acceptance'); }, () => { rejected = true; });
  assert.equal(rejected, true);
});

test('closing a tunnel while SSH is connecting cancels setup without leaving a forward', async () => {
  const conn = new EventEmitter();
  let ended = false;
  conn.end = () => { ended = true; conn.emit('close'); };
  conn.forwardIn = () => { throw new Error('Forwarding after close'); };
  let connected;
  const tunnel = new TiledTunnel({ connect: () => new Promise(resolve => { connected = resolve; }), targetUrl: 'http://tiled.example:8000', log });
  const ready = tunnel.ensureReady();
  tunnel.close();
  connected({ conn });
  await assert.rejects(ready, /closed during connection/);
  assert.equal(ended, true);
});
