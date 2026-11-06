'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const SSHOperations = require('../sshOperations');

function setup() {
  const operations = new SSHOperations('/tmp/config');
  operations.config.agent = { host: 'worker', httpPort: 5050 };
  operations.executeCommand = async () => { throw new Error('Health checks must not require remote commands'); };
  return operations;
}

for (const status of [200, 503]) {
  test(`driver health checks use the card port and report HTTP ${status}`, async t => {
    const operations = setup();
    let cancelled = false;
    t.mock.method(global, 'fetch', async (url, options) => {
      assert.equal(url, 'http://worker:5050/queue_state');
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: status === 200, status, body: { cancel: async () => { cancelled = true; } } };
    });
    const result = await operations.probeServerHealth('agent');
    assert.equal(result.ok, status === 200);
    assert.equal(result.statusCode, status);
    assert.equal(cancelled, true);
    if (status !== 200) assert.equal(result.reason, 'HTTP 503');
  });
}

test('driver health checks preserve custom status URLs and report connection failures', async t => {
  const operations = setup();
  operations.config.agent.status_url = 'http://worker:5050/health';
  t.mock.method(global, 'fetch', async url => {
    assert.equal(url, operations.config.agent.status_url);
    throw new Error('Connection refused');
  });
  assert.deepEqual(await operations.probeServerHealth('agent'), {
    ok: false, url: 'http://worker:5050/health', reason: 'Connection refused'
  });
});

test('driver health checks abort requests after three seconds', async t => {
  const operations = setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(global, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('request timed out')), { once: true });
  }));
  const pending = operations.probeServerHealth('agent');
  t.mock.timers.tick(3000);
  assert.equal((await pending).reason, 'request timed out');
});
