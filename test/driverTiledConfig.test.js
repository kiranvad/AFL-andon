'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const SSHOperations = require('../sshOperations');

async function setup(t, renameError = null) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'andon-driver-tiled-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'agent.json');
  const profilePath = path.join(directory, 'tiled.yml');
  await fs.writeFile(profilePath, 'trees:\n  - path: /\n    tree: catalog\nauthentication:\n  single_user_api_key: local-tiled-key\n');
  const original = '{"save_path":"/tmp/results","pipeline":{}}';
  await fs.writeFile(configPath, original);
  const operations = new SSHOperations('/tmp/config', undefined, { aflGlobalConfigPath: path.join(directory, 'config.json') });
  t.after(() => operations.closeTiledTunnels());
  // A stale global record must not select the NAS over the running tiled card.
  await fs.writeFile(operations.aflGlobalConfigPath, JSON.stringify({
    '26/02/11 00:00:00.000000': { tiled_server: 'http://nas:8000', tiled_api_key: 'nas-key' }
  }));
  operations.config = {
    tiled: { server_type: 'tiled', host: 'localhost', httpPort: 8111, webview_url: 'http://localhost:8111/', config_file_location: profilePath },
    worker: { host: 'worker', username: 'test-user', shell: 'bash', screen_name: 'AgentServer', server_script: '/home/test-user/.afl/scripts/start-worker.sh' }
  };
  const globalPath = '/home/test-user/.afl/config.json';
  const oldRecord = { system_serial: 'Worker', ports: { DoubleAgentDriver: 5050 }, tiled_server: 'http://localhost:8000', tiled_api_key: 'old-key' };
  const files = new Map([[globalPath, JSON.stringify({ '26/02/11 00:00:00.000000': oldRecord })]]);
  const modes = new Map();
  const forwards = [];
  operations.connectWithAvailableKeys = async () => ({ conn: Object.assign(new EventEmitter(), {
    end() { this.emit('close'); },
    forwardIn(address, port, callback) { forwards.push({ address, port }); callback(null, port || 38123); },
    sftp(done) {
      done(null, {
        mkdir(_path, _options, callback) { callback(); },
        readFile(file, _encoding, callback) {
          if (files.has(file)) callback(null, files.get(file));
          else callback(new Error('No such file'));
        },
        writeFile(file, content, _options, callback) { files.set(file, content); callback(); },
        chmod(file, mode, callback) { modes.set(file, mode); callback(); },
        ext_openssh_rename(from, to, callback) {
          if (renameError) throw renameError;
          files.set(to, files.get(from)); files.delete(from);
          modes.set(to, modes.get(from)); modes.delete(from); callback();
        },
        unlink(file, callback) { files.delete(file); callback(); }
      });
    }
  }) });
  const commands = [];
  operations.executeCommand = async (name, command) => {
    assert.equal(name, 'worker');
    commands.push(command);
    return { success: true, code: 0, output: command.includes('SSH_CONNECTION') ? '192.0.2.20' : command.includes('api/v1/metadata/') ? '200' : '' };
  };
  operations.getRemoteOs = async () => 'linux';
  operations.probeServerHealth = async name => { assert.equal(name, 'tiled'); return { ok: true }; };
  operations.waitForServerHealth = async () => ({ ok: true, url: 'http://worker:5050' });
  operations.ensureScreenDetached = async () => ({ ok: true });
  operations.updateAndonRuntimeConfig = async () => ({ success: true });
  return { directory, operations, files, modes, globalPath, configPath, original, commands, oldRecord, forwards };
}

test('a Script launcher automatically receives the running control-side Tiled connection', async t => {
  const { directory, operations, files, modes, globalPath, commands, oldRecord, forwards } = await setup(t);
  const source = path.join(directory, 'start-worker.sh');
  await fs.writeFile(source, '#!/usr/bin/env bash\nprintf "ready\\n"\n');
  delete operations.config.worker.server_script;
  operations.config.worker.script_file_location = source;
  assert.equal((await operations.startServer('worker')).success, true);
  const global = JSON.parse(files.get(globalPath));
  assert.deepEqual(global['26/02/11 00:00:00.000000'], oldRecord);
  assert.deepEqual(Object.values(global).at(-1), { ...oldRecord, tiled_server: 'http://127.0.0.1:38123', tiled_api_key: 'local-tiled-key' });
  assert.deepEqual(forwards, [{ address: '127.0.0.1', port: 0 }]);
  assert.equal(modes.get(globalPath), 0o600);
  assert.equal([...files.keys()].some(file => file.includes('.tmp-') || file.includes('.launch-config')), false);
  assert.ok(commands.find(command => command.startsWith('screen -d -m')).endsWith("'/home/test-user/.afl/scripts/worker.launch-script.sh'"));
  assert.equal(commands.some(command => command.includes('local-tiled-key')), false);
  assert.equal(JSON.stringify(operations.config).includes('local-tiled-key'), false);
});

for (const withConfig of [false, true]) {
  test(`Module launches receive Tiled automatically ${withConfig ? 'with' : 'without'} a driver config`, async t => {
    const { operations, files, globalPath, configPath, original } = await setup(t);
    delete operations.config.worker.server_script;
    operations.config.worker.server_module = 'AFL.double_agent.AgentDriver';
    if (withConfig) operations.config.worker.config_file_location = configPath;
    assert.equal((await operations.startServer('worker')).success, true);
    assert.equal(Object.values(JSON.parse(files.get(globalPath))).at(-1).tiled_server, 'http://127.0.0.1:38123');
    if (withConfig) {
      assert.equal(files.get('/home/test-user/.afl/configs/worker.launch-config.json'), original);
      assert.equal(await fs.readFile(configPath, 'utf8'), original);
    }
  });
}

test('the most recently activated Tiled card is used for subsequent driver starts', async t => {
  const { directory, operations, files, globalPath, commands } = await setup(t);
  const profilePath = path.join(directory, 'external.yml');
  await fs.writeFile(profilePath, 'uri: http://192.0.2.55:8222\napi_key: current-key\n');
  operations.config['another tiled'] = { server_type: 'tiled', config_file_location: profilePath };
  await operations.activateTiledForSession('another tiled');
  assert.equal(operations.activeTiledServerName, 'another tiled');
  operations.probeServerHealth = async name => { assert.equal(name, 'another tiled'); return { ok: true }; };
  assert.equal((await operations.startServer('worker')).success, true);
  const record = Object.values(JSON.parse(files.get(globalPath))).at(-1);
  assert.equal(record.tiled_server, 'http://127.0.0.1:38123');
  assert.equal([...operations.tiledTunnels.values()][0].target.origin, 'http://192.0.2.55:8222');
  assert.equal(record.tiled_api_key, 'current-key');
  assert.equal(commands.some(command => command.includes('SSH_CONNECTION')), false);
});

test('when no Tiled service is active, driver starts keep the host existing configuration', async t => {
  const { operations, files, globalPath } = await setup(t);
  const original = files.get(globalPath);
  operations.probeServerHealth = async () => ({ ok: false, reason: 'connection refused' });
  assert.equal((await operations.startServer('worker')).success, true);
  assert.equal(files.get(globalPath), original);
});

test('an unavailable current Tiled prevents starting a driver with stale connection settings', async t => {
  const { operations, files, globalPath, commands } = await setup(t);
  const original = files.get(globalPath);
  operations.activeTiledServerName = 'tiled';
  operations.probeServerHealth = async () => ({ ok: false, reason: 'connection refused' });
  const result = await operations.startServer('worker');
  assert.equal(result.success, false);
  assert.match(result.error, /Current Tiled launcher "tiled" is unavailable/);
  assert.equal(files.get(globalPath), original);
  assert.equal(commands.some(command => command.startsWith('screen')), false);
});

test('a malformed remote global config is preserved and prevents starting the driver', async t => {
  const { operations, files, globalPath, commands } = await setup(t);
  files.set(globalPath, 'invalid JSON');
  assert.equal((await operations.startServer('worker')).success, false);
  assert.equal(files.get(globalPath), 'invalid JSON');
  assert.equal(operations.tiledTunnels.size, 0);
  assert.equal(commands.some(command => command.startsWith('screen')), false);
});

test('a failed atomic config update preserves the original and removes its temporary file', async t => {
  const { operations, files, globalPath, commands } = await setup(t, new Error('Server does not support this extended request'));
  const original = files.get(globalPath);
  const result = await operations.startServer('worker');
  assert.equal(result.success, false);
  assert.match(result.error, /does not support/);
  assert.equal(files.get(globalPath), original);
  assert.equal(operations.tiledTunnels.size, 0);
  assert.equal([...files.keys()].some(file => file.includes('.tmp-')), false);
  assert.equal(commands.some(command => command.startsWith('screen')), false);
});

test('local drivers use the same current Tiled connection without changing driver JSON', async t => {
  const { operations, configPath, original } = await setup(t);
  operations.config.worker.host = 'localhost';
  operations.config.worker.username = os.userInfo().username;
  await operations.configureTiledForLaunch('worker');
  const record = Object.values(JSON.parse(await fs.readFile(operations.aflGlobalConfigPath, 'utf8'))).at(-1);
  assert.equal(record.tiled_server, 'http://localhost:8111');
  assert.equal(record.tiled_api_key, 'local-tiled-key');
  const result = await operations.resolveModuleConfigPath('worker', { host: 'localhost', config_file_location: configPath });
  assert.equal(result.configPath, configPath);
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
});

test('disconnecting the current NAS Tiled clears its session selection', async t => {
  const { operations } = await setup(t);
  operations.activeTiledServerName = 'tiled';
  operations.config.tiled.tiled_management = { type: 'docker_compose' };
  assert.equal((await operations.stopServer('tiled')).disconnected, true);
  assert.equal(operations.activeTiledServerName, null);
});

test('drivers sharing an account reuse the tunnel until the last driver stops', async t => {
  const { operations, forwards } = await setup(t);
  operations.runServerStop = async () => ({
    success: true, code: 0, output: '{"success":true,"verified":true}'
  });
  operations.config.second = { ...operations.config.worker };
  const url = new URL('http://tiled.example:8000');
  const first = await operations.ensureTiledTunnel('worker', url);
  const second = await operations.ensureTiledTunnel('second', url);
  assert.equal(first.tunnel, second.tunnel);
  assert.equal(forwards.length, 1);
  assert.equal((await operations.stopServer('worker')).success, true);
  assert.equal(first.tunnel.closed, false);
  operations.releaseTiledTunnels('second');
  assert.equal(first.tunnel.closed, true);
  assert.equal(operations.tiledTunnels.size, 0);
});

for (const stoppedName of ['worker', 'tiled']) {
  test(`Stop on ${stoppedName} cancels pending Tiled forwarding and releases its transport`, { timeout: 5000 }, async t => {
    const { operations, files, globalPath } = await setup(t);
    const original = files.get(globalPath);
    operations.runServerStop = async () => ({ success: true, code: 0,
      output: '{"success":true,"verified":true}' });
    let forwarding;
    const requested = new Promise(resolve => { forwarding = resolve; });
    let destroyed = false;
    let complete;
    operations.connectWithAvailableKeys = async () => ({ conn: Object.assign(new EventEmitter(), {
      end() {},
      destroy() { destroyed = true; this.emit('close'); },
      forwardIn(_address, _port, callback) { complete = callback; forwarding(); }
    }) });
    const pending = operations.configureTiledForLaunch('worker');
    const canceled = assert.rejects(pending, /canceled|closed|disconnected/i);
    await requested;
    assert.equal((await operations.stopServer(stoppedName)).success, true);
    // Even a late successful forwarding callback must not revive the tunnel.
    complete(null, 38123);
    await canceled;
    assert.equal(destroyed, true);
    assert.equal(operations.tiledTunnels.size, 0);
    assert.equal(operations.tiledTunnelSources.size, 0);
    assert.equal(files.get(globalPath), original);
  });
}

test('Stop during Tiled discovery prevents a late health result from selecting it again', async t => {
  const { operations } = await setup(t);
  operations.runServerStop = async () => ({ success: true, code: 0,
    output: '{"success":true,"verified":true}' });
  let complete;
  operations.probeServerHealth = () => new Promise(resolve => { complete = resolve; });
  operations.activateTiledForSession = () => assert.fail('stopped Tiled must not be activated');
  const pending = operations.discoverActiveTiledConnection();
  await operations.stopServer('tiled');
  complete({ ok: true });
  assert.equal(await pending, null);
  assert.equal(operations.activeTiledServerName, null);
  assert.equal(operations.activeTiledConnection, null);
});

test('switching Tiled for one driver preserves the previous service for other drivers', async t => {
  const { directory, operations } = await setup(t);
  operations.config.second = { ...operations.config.worker };
  await operations.configureTiledForLaunch('worker');
  const previous = [...operations.tiledTunnels.values()][0];
  await operations.ensureTiledTunnel('second', previous.target);
  const profilePath = path.join(directory, 'external.yml');
  await fs.writeFile(profilePath, 'uri: http://tiled.example:8000\napi_key: current-key\n');
  operations.config.external = { server_type: 'tiled', config_file_location: profilePath };
  operations.activeTiledServerName = 'external';
  operations.probeServerHealth = async () => ({ ok: true });
  await operations.configureTiledForLaunch('worker');
  assert.equal(operations.tiledTunnels.size, 2);
  assert.deepEqual([...previous.serverNames], ['second']);
  assert.equal(previous.closed, false);
});

test('denied remote forwarding leaves settings intact and prevents driver startup', async t => {
  const { operations, files, globalPath, commands } = await setup(t);
  const original = files.get(globalPath);
  operations.connectWithAvailableKeys = async () => ({ conn: Object.assign(new EventEmitter(), {
    end() { this.emit('close'); },
    forwardIn(_address, _port, callback) { callback(new Error('Forwarding denied')); }
  }) });
  const result = await operations.startServer('worker');
  assert.equal(result.success, false);
  assert.match(result.error, /remote TCP forwarding/);
  assert.equal(files.get(globalPath), original);
  assert.equal(operations.tiledTunnels.size, 0);
  assert.equal(commands.some(command => command.startsWith('screen')), false);
});

test('HTTPS Tiled preserves direct connections and its TLS hostname', async t => {
  const { directory, operations, files, globalPath, forwards } = await setup(t);
  const profilePath = path.join(directory, 'https.yml');
  await fs.writeFile(profilePath, 'uri: https://tiled.example\napi_key: current-key\n');
  operations.config.tiled.config_file_location = profilePath;
  await operations.configureTiledForLaunch('worker');
  assert.equal(Object.values(JSON.parse(files.get(globalPath))).at(-1).tiled_server, 'https://tiled.example');
  assert.equal(forwards.length, 0);
});

test('after reopening, any healthy enabled Tiled card is discovered for a driver', async t => {
  const { operations, files, globalPath } = await setup(t);
  operations.config.catalog = operations.config.tiled;
  delete operations.config.tiled;
  operations.probeServerHealth = async name => { assert.equal(name, 'catalog'); return { ok: true }; };
  const result = await operations.syncActiveTiledConfigForDriver('worker');
  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  assert.equal(operations.activeTiledServerName, 'catalog');
  assert.equal(operations.activeTiledConnection.serverName, 'catalog');
  assert.equal(Object.values(JSON.parse(files.get(globalPath))).at(-1).tiled_server, 'http://127.0.0.1:38123');
});

test('browser paths and URL credentials never enter driver Tiled configuration', async t => {
  const { operations, files, globalPath, commands } = await setup(t);
  operations.config.tiled.webview_url = 'http://localhost:8111/ui/browse?api_key=browser-key#results';
  assert.equal((await operations.syncActiveTiledConfigForDriver('worker')).success, true);
  const tunnel = [...operations.tiledTunnels.values()][0];
  assert.equal(tunnel.target.toString(), 'http://localhost:8111/');
  assert.equal(Object.values(JSON.parse(files.get(globalPath))).at(-1).tiled_server, 'http://127.0.0.1:38123');
  assert.equal(commands.some(command => command.includes('browser-key') || command.includes('/ui/browse')), false);
});

test('an authenticated Tiled failure preserves config and prevents driver launch', async t => {
  const { operations, files, globalPath, commands } = await setup(t);
  const original = files.get(globalPath);
  operations.executeCommand = async (_name, command) => {
    commands.push(command);
    return { success: true, code: 0, output: '401' };
  };
  const result = await operations.startServer('worker');
  assert.equal(result.success, false);
  assert.match(result.error, /Tiled returned HTTP 401/);
  assert.equal(files.get(globalPath), original);
  assert.equal(operations.tiledTunnels.size, 0);
  assert.equal(commands.some(command => command.startsWith('screen -d -m')), false);
});
