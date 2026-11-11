'use strict';

const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const SSHOperations = require('../sshOperations');

async function probeWithoutCurl(t, withPython = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'andon-tiled-probe-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  if (withPython) {
    const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
    await fs.symlink(python, path.join(directory, 'python3'));
  }
  const operations = new SSHOperations('/tmp/unused-launchers');
  const commands = [];
  operations.executeCommand = (_name, command, _timeout, options) => {
    commands.push(command);
    return new Promise(resolve => {
      const child = execFile('/bin/bash', ['-c', command], {
        env: { ...process.env, PATH: directory }, timeout: 5000
      }, (error, stdout, stderr) => {
        resolve({ success: true, code: error?.code || 0, output: stdout + stderr });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(options.stdin || '');
    });
  };
  return { operations, commands };
}

async function upstream(t, status, requests) {
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(status);
    response.end('metadata');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

for (const authenticated of [false, true]) {
  test(`Python verifies ${authenticated ? 'authenticated' : 'anonymous'} Tiled when curl is unavailable`, async t => {
    const { operations, commands } = await probeWithoutCurl(t);
    const requests = [];
    const { url } = await upstream(t, 200, requests);
    const key = authenticated ? "test-key ' $(echo literal)" : '';
    const result = await operations.probeTiledFromDriverHost('worker', url, key);
    assert.equal(result.success, true);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(requests, [{
      url: '/api/v1/metadata/', authorization: authenticated ? `Apikey ${key}` : undefined
    }]);
    if (authenticated) assert.equal(commands.some(command => command.includes(key)), false);
  });
}

test('Python reports rejected Tiled authentication as HTTP 401', async t => {
  const { operations } = await probeWithoutCurl(t);
  const { url } = await upstream(t, 401, []);
  assert.deepEqual(await operations.probeTiledFromDriverHost('worker', url, 'invalid-key'), {
    success: false, error: 'Tiled returned HTTP 401'
  });
});

test('Python preserves the connection failure when Tiled is unreachable', async t => {
  const { operations } = await probeWithoutCurl(t);
  const { server, url } = await upstream(t, 200, []);
  await new Promise(resolve => server.close(resolve));
  const result = await operations.probeTiledFromDriverHost('worker', url, 'test-key');
  assert.equal(result.success, false);
  assert.match(result.error, /Tiled request failed:.*Connection refused/i);
});

test('a host missing both curl and Python reports the missing tools', async t => {
  const { operations } = await probeWithoutCurl(t, false);
  const result = await operations.probeTiledFromDriverHost('worker', 'http://tiled.example:8000', 'test-key');
  assert.equal(result.success, false);
  assert.match(result.error, /Neither curl nor python3 is available/);
});

test('curl connection errors retain their diagnostic instead of reporting HTTP 000', async t => {
  const operations = new SSHOperations('/tmp/unused-launchers');
  operations.executeCommand = async () => ({
    success: true, code: 7, output: 'curl: (7) Failed to connect to Tiled\n000'
  });
  const result = await operations.probeTiledFromDriverHost('worker', 'http://tiled.example:8000', 'test-key');
  assert.equal(result.success, false);
  assert.match(result.error, /Failed to connect to Tiled/);
  assert.doesNotMatch(result.error, /Tiled returned HTTP 000/);
});
