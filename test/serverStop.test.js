'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const SSHOperations = require('../sshOperations');
const { parseStopResult, runLocalStop } = require('../serverStop');

const stopped = () => ({ success: true, code: 0, output: JSON.stringify({ success: true, verified: true }) });

function setup() {
  const ops = new SSHOperations('/tmp/config');
  ops.config = {
    tiled: { server_type: 'tiled', tiled_management: { type: 'afl_proxy' }, host: 'localhost',
      username: os.userInfo().username, httpPort: 8000, screen_name: 'tiled', server_module: '',
      env_type: 'pip', virtualenv_path: '/env', config_file_location: '/profiles/http.yml' },
    driver: { host: 'worker.example', username: 'user', screen_name: 'driver', httpPort: 5000,
      server_module: 'AFL.example.Driver' }
  };
  ops.updateAndonRuntimeConfig = async () => ({ success: true });
  return ops;
}

function tunnel(ops, owners, sources) {
  const forward = { serverNames: new Set(owners), closed: false, close() { this.closed = true; } };
  ops.tiledTunnels.set('test', forward);
  sources.forEach(([owner, source]) => ops.tiledTunnelSources.set(owner, source));
  return forward;
}

test('local proxy Stop launches cleanup immediately and verifies its acknowledgement', async () => {
  const ops = setup();
  let spawned = false;
  ops.localStop = async (spec, python) => {
    spawned = true;
    assert.equal(spec.module, 'AFL.automation.shared.TiledProxyDriver');
    assert.equal(spec.port, 8000);
    assert.equal(python, '/env/bin/python');
    return stopped();
  };
  ops.executeCommand = () => assert.fail('local shutdown must not wait for SSH');
  const pending = ops.stopServer('tiled');
  assert.equal(spawned, true);
  assert.equal((await pending).verified, true);
});

test('failed Stop releases source tunnels and does not mark the server stopped', async () => {
  const ops = setup();
  const forward = tunnel(ops, ['driver'], [['driver', 'tiled']]);
  let saved = false;
  ops.updateAndonRuntimeConfig = async () => { saved = true; return { success: true }; };
  ops.localStop = async () => ({ success: true, code: 1, output: '{"success":false,"error":"Still running"}' });
  const result = await ops.stopServer('tiled');
  assert.equal(result.success, false);
  assert.equal(result.error, 'Still running');
  assert.equal(saved, false);
  assert.equal(forward.closed, true);
  assert.equal(ops.tiledTunnels.size, 0);
  assert.equal(ops.tiledTunnelSources.size, 0);
});

test('stopping one owner preserves a shared tunnel until its last owner stops', async () => {
  const ops = setup();
  ops.config.second = { ...ops.config.driver, screen_name: 'second' };
  const forward = tunnel(ops, ['driver', 'second'], [['driver', 'tiled'], ['second', 'tiled']]);
  ops.runServerStop = async () => stopped();
  await ops.stopServer('driver');
  assert.equal(forward.closed, false);
  assert.deepEqual([...forward.serverNames], ['second']);
  await ops.stopServer('second');
  assert.equal(forward.closed, true);
});

test('stopping a Tiled source preserves owners using a different Tiled card', async () => {
  const ops = setup();
  const forward = tunnel(ops, ['driver', 'other'], [['driver', 'tiled'], ['other', 'other tiled']]);
  ops.localStop = async () => stopped();
  await ops.stopServer('tiled');
  assert.equal(forward.closed, false);
  assert.deepEqual([...forward.serverNames], ['other']);
});

test('NAS disconnect releases source tunnels without issuing a container stop', async () => {
  const ops = setup();
  ops.config.tiled.tiled_management = { type: 'docker_compose' };
  ops.config.tiled.external_service = true;
  const forward = tunnel(ops, ['driver'], [['driver', 'tiled']]);
  ops.executeCommand = ops.localStop = () => assert.fail('NAS Stop only disconnects');
  assert.equal((await ops.stopServer('tiled')).disconnected, true);
  assert.equal(forward.closed, true);
});

test('a stopped NAS selection is not automatically rediscovered for new tunnels', async () => {
  const ops = setup();
  ops.localStop = async () => stopped();
  await ops.stopServer('tiled');
  ops.probeServerHealth = () => assert.fail('explicitly stopped Tiled must stay disconnected');
  assert.equal(await ops.discoverActiveTiledConnection(), null);
});

test('remote cleanup uses nohup and a finite command timeout', async () => {
  const ops = setup();
  ops.executeCommand = async (_name, command, timeout) => {
    assert.match(command, /^nohup /);
    assert.equal(timeout, 25000);
    assert.equal(command.includes('pkill -f'), false);
    return stopped();
  };
  assert.equal((await ops.stopServer('driver')).verified, true);
});

test('Restart never launches a second process after an unverified Stop', async () => {
  const ops = setup();
  ops.stopServer = async () => ({ success: false, sshDown: true, error: 'SSH disconnected' });
  ops.startServer = () => assert.fail('Stop must succeed before Restart');
  assert.equal((await ops.restartServer('driver')).success, false);
});

test('zero exit status without a verified worker result is still a Stop failure', () => {
  assert.equal(parseStopResult({ success: true, code: 0, output: '' }).success, false);
});

test('local worker is detached from the terminal and retains captured result output', async () => {
  let unreferenced = false;
  const result = await runLocalStop({ screenName: 'test' }, 'python3', (_python, _args, options) => {
    assert.deepEqual(options, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
      unref() { unreferenced = true; }, kill() {} });
    queueMicrotask(() => { child.stdout.emit('data', stopped().output); child.emit('close', 0); });
    return child;
  });
  assert.equal(unreferenced, true);
  assert.equal(parseStopResult(result).verified, true);
});

test('shutdown queues a bounded local fallback before waiting on remote drivers', () => {
  const ops = setup();
  ops.localStop = (spec, _python, _spawn, timeout) => {
    assert.equal(spec.watchParent, process.pid);
    assert.deepEqual(spec.groups.map(group => group.map(item => item.name)), [[], ['tiled']]);
    assert.equal(timeout, 90000);
    return Promise.resolve({ success: true, code: 0 });
  };
  ops.beginLocalShutdown(['driver', 'tiled']);
});

test('SSH command disconnects and deadlines resolve instead of hanging Stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ops = setup();
  ops.sshKeys = [{ path: '/key', key: Buffer.from('key') }];
  let destroyed = false;
  const conn = Object.assign(new EventEmitter(), { exec() {}, end() {}, destroy() { destroyed = true; } });
  ops.connectWithAvailableKeys = async () => ({ conn });
  const pending = ops.executeCommand('driver', 'nohup cleanup', 1000);
  await Promise.resolve();
  t.mock.timers.tick(1000);
  assert.match((await pending).error, /timed out/);
  assert.equal(destroyed, true);
  const disconnected = ops.executeCommand('driver', 'cleanup', 1000);
  await Promise.resolve();
  conn.emit('close');
  assert.match((await disconnected).error, /disconnected/);
});

test('Stop during SSH authentication prevents a pending launch command from executing', async () => {
  const ops = setup();
  ops.sshKeys = [{ path: '/key', key: Buffer.from('key') }];
  let connected;
  ops.connectWithAvailableKeys = () => new Promise(resolve => { connected = resolve; });
  const conn = Object.assign(new EventEmitter(), { end() {},
    exec() { assert.fail('canceled launch must not execute'); } });
  let canceled = false;
  const pending = ops.executeCommand('driver', 'screen -d -m launcher', 1000, { isCanceled: () => canceled });
  canceled = true;
  connected({ conn });
  assert.equal((await pending).canceled, true);
});

test('Stop before a prepared launch executes prevents a new server process', async () => {
  const ops = setup();
  ops.resolveModuleConfigPath = async () => ({ success: true, configPath: null });
  ops.syncActiveTiledConfigForDriver = async () => ({ success: true });
  ops.getRemoteOs = async () => 'linux';
  ops.runServerStop = async () => stopped();
  ops.executeCommand = () => assert.fail('canceled launch must not execute');
  let preparing;
  let prepared;
  const atLaunch = new Promise(resolve => { preparing = resolve; });
  const pending = ops.startServer('driver', { onBeforeLaunch: () => {
    preparing();
    return new Promise(resolve => { prepared = resolve; });
  } });
  await atLaunch;
  assert.equal((await ops.stopServer('driver')).success, true);
  prepared();
  assert.equal((await pending).canceled, true);
});
