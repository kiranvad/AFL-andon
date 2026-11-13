'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { ensureLauncherConfig } = require('../configBootstrap');
const { checkLocalSsh, installAndon } = require('../installation');
const SSHOperations = require('../sshOperations');

async function temporaryHome(t, { key = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'andon-installation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => directory);
  t.mock.method(os, 'userInfo', () => ({ username: 'install-user' }));
  const keyPath = path.join(directory, '.ssh', 'id_ed25519');
  if (key) {
    await fs.mkdir(path.dirname(keyPath));
    await fs.writeFile(keyPath, 'private-key-fixture');
  }
  return { directory, keyPath, configPath: path.join(directory, '.afl', 'launchers.json') };
}

function sshFixture(event = 'ready', error) {
  const calls = [];
  const connections = [];
  class Client extends EventEmitter {
    connect(options) {
      calls.push(options);
      connections.push(this);
      queueMicrotask(() => this.emit(event, error));
    }
    end() { this.ended = true; }
    destroy() { this.destroyed = true; }
  }
  return { clientFactory: () => new Client(), calls, connections };
}

test('installation authenticates with Andon and creates private, empty configuration', async t => {
  const { directory, configPath } = await temporaryHome(t);
  const ssh = sshFixture();
  const result = await installAndon({ configPath, clientFactory: ssh.clientFactory });
  assert.equal(result.configPath, configPath);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), {});
  const runtimePath = path.join(directory, '.afl', 'configs', 'andon.config.json');
  assert.deepEqual(JSON.parse(await fs.readFile(runtimePath, 'utf8')), {});
  for (const name of ['configs', 'logs']) {
    assert.ok((await fs.stat(path.join(directory, '.afl', name))).isDirectory());
  }
  assert.equal(ssh.calls.length, 1);
  assert.equal(ssh.calls[0].host, 'localhost');
  assert.equal(ssh.calls[0].port, 22);
  assert.equal(ssh.calls[0].username, 'install-user');
  assert.equal(ssh.calls[0].privateKey.toString(), 'private-key-fixture');
  assert.equal(ssh.connections[0].ended, true);
  const operations = new SSHOperations(configPath);
  await operations.initialize();
  assert.deepEqual(operations.getServerEntries(), []);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(runtimePath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(configPath))).mode & 0o777, 0o700);
  }
});

test('setup preserves existing launchers and respects a custom config and SSH key', async t => {
  const { directory } = await temporaryHome(t, { key: false });
  const configPath = path.join(directory, 'private', 'launchers.json');
  const sshKeyPath = path.join(directory, 'custom-key');
  const runtimePath = path.join(directory, '.afl', 'configs', 'andon.config.json');
  const original = '{"worker":{"host":"worker.example","username":"worker-user"}}\n';
  const originalRuntime = '{"launchers":{"worker":{"runtime_state":"stopped"}},"notes":"existing settings"}\n';
  await fs.mkdir(path.dirname(configPath));
  await fs.mkdir(path.dirname(runtimePath), { recursive: true });
  await fs.writeFile(configPath, original);
  await fs.writeFile(runtimePath, originalRuntime);
  await fs.writeFile(sshKeyPath, 'custom-key-fixture');
  const ssh = sshFixture();
  await installAndon({ configPath, sshKeyPath, clientFactory: ssh.clientFactory });
  await installAndon({ configPath, sshKeyPath, clientFactory: ssh.clientFactory });
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
  assert.equal(await fs.readFile(runtimePath, 'utf8'), originalRuntime);
  assert.equal(ssh.calls.length, 2);
  assert.equal(ssh.calls[0].privateKey.toString(), 'custom-key-fixture');
  assert.ok((await fs.stat(path.join(directory, '.afl', 'configs'))).isDirectory());
});

test('startup repairs an older installation missing the runtime config without rechecking SSH', async t => {
  const { directory, configPath } = await temporaryHome(t, { key: false });
  await fs.mkdir(path.dirname(configPath));
  const original = '{"agent":{"host":"localhost","username":"install-user"}}\n';
  await fs.writeFile(configPath, original);
  await installAndon({ configPath, firstRunOnly: true, clientFactory() { assert.fail('An existing installation should not recheck SSH'); } });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, '.afl', 'configs', 'andon.config.json'), 'utf8')), {});
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
});

test('startup rejects an invalid existing runtime config without replacing it', async t => {
  const { directory, configPath } = await temporaryHome(t, { key: false });
  const runtimePath = path.join(directory, '.afl', 'configs', 'andon.config.json');
  await fs.mkdir(path.dirname(runtimePath), { recursive: true });
  await fs.writeFile(configPath, '{}\n');
  for (const contents of ['{broken', '[]', 'null']) {
    await fs.writeFile(runtimePath, contents);
    await assert.rejects(installAndon({ configPath, firstRunOnly: true }), /[Aa]ndon configuration/);
    assert.equal(await fs.readFile(runtimePath, 'utf8'), contents);
  }
});

test('missing nested launcher paths are initialized without a load error', async t => {
  const { directory } = await temporaryHome(t);
  const configPath = path.join(directory, 'nested', 'config', 'launchers.json');
  const operations = new SSHOperations(configPath);
  await operations.loadConfig();
  assert.deepEqual(operations.config, {});
  assert.equal(await fs.readFile(configPath, 'utf8'), '{}\n');
});

test('malformed and non-object config files are rejected without overwriting them', async t => {
  const { configPath } = await temporaryHome(t);
  await fs.mkdir(path.dirname(configPath));
  for (const contents of ['', '{broken', 'null', '[]', '"text"']) {
    await fs.writeFile(configPath, contents);
    await assert.rejects(ensureLauncherConfig(configPath), /Cannot read launcher configuration|must contain a JSON object/);
    const operations = new SSHOperations(configPath);
    await assert.rejects(operations.loadConfig());
    assert.equal(await fs.readFile(configPath, 'utf8'), contents);
  }
});

test('a disabled SSH server fails first-run setup and can be retried safely', async t => {
  const { configPath } = await temporaryHome(t);
  const ssh = sshFixture('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
  await assert.rejects(installAndon({ configPath, firstRunOnly: true, clientFactory: ssh.clientFactory }),
    error => {
      assert.match(error.message, /SSH setup check failed for install-user@localhost:22: connect ECONNREFUSED/);
      assert.match(error.message, /Developer and administrator setup > 2\. Enable the SSH server \(INSTALL\.md#enable-ssh-server\)/);
      return true;
    });
  await assert.rejects(fs.access(configPath), { code: 'ENOENT' });
  assert.equal(ssh.connections[0].ended, true);
  const working = sshFixture();
  await installAndon({ configPath, firstRunOnly: true, clientFactory: working.clientFactory });
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), {});
  await installAndon({ configPath, firstRunOnly: true, clientFactory() { throw new Error('Should not recheck an installed account'); } });
});

test('missing keys and rejected authentication point to the user SSH key instructions', async t => {
  const { keyPath, configPath } = await temporaryHome(t, { key: false });
  await assert.rejects(checkLocalSsh(), error => {
    assert.match(error.message, /No readable SSH private key was found for this user account/);
    assert.match(error.message, /User installation > 2\. Set up SSH keys for your account \(INSTALL\.md#ssh-key-setup\)/);
    assert.ok(error.message.includes(`Guide: ${path.resolve(__dirname, '../INSTALL.md')}`));
    assert.match(error.message, /rerun npm run setup.*same user/);
    return true;
  });
  await fs.mkdir(path.dirname(keyPath));
  await fs.writeFile(keyPath, 'private-key-fixture');
  const failure = Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' });
  const ssh = sshFixture('error', failure);
  await assert.rejects(installAndon({ configPath, clientFactory: ssh.clientFactory }), error => {
    assert.match(error.message, /authentication methods failed/);
    assert.match(error.message, /INSTALL\.md#ssh-key-setup/);
    return true;
  });
  await assert.rejects(fs.access(configPath), { code: 'ENOENT' });
});

test('SSH setup times out and closes a connection that never authenticates', async t => {
  await temporaryHome(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let connected;
  const gate = new Promise(resolve => { connected = resolve; });
  const client = Object.assign(new EventEmitter(), {
    connect() { connected(); }, end() {}, destroy() { this.destroyed = true; }
  });
  const check = checkLocalSsh(undefined, { clientFactory: () => client });
  const rejection = assert.rejects(check, error => {
    assert.match(error.message, /SSH connection timed out after 5000ms/);
    assert.match(error.message, /INSTALL\.md#enable-ssh-server/);
    return true;
  });
  await gate;
  t.mock.timers.tick(5000);
  await rejection;
  assert.equal(client.destroyed, true);
});

test('SSH error references resolve to named installation guide sections', async () => {
  const guide = await fs.readFile(path.resolve(__dirname, '../INSTALL.md'), 'utf8');
  for (const [anchor, heading] of [
    ['ssh-key-setup', '### 2. Set up SSH keys for your account'],
    ['enable-ssh-server', '### 2. Enable the SSH server']
  ]) {
    assert.ok(guide.includes(`<a id="${anchor}"></a>\n\n${heading}`));
  }
});

test('CLI fails with status 1; only postinstall has a build-only exception', async () => {
  const source = await fs.readFile(path.resolve(__dirname, '../scripts/install.js'), 'utf8');
  async function run(env) {
    const runtime = { env };
    const output = [];
    vm.runInNewContext(source, {
      require: () => ({ async installAndon() { throw new Error('SSH setup check fixture failed'); } }),
      process: runtime,
      console: { log: text => output.push(text), error: text => output.push(text) }
    });
    await new Promise(resolve => setImmediate(resolve));
    return { exitCode: runtime.exitCode || 0, output: output.join('\n') };
  }
  for (const env of [
    { AFL_ANDON_BUILD_ONLY: '1', npm_lifecycle_event: 'setup' },
    { AFL_ANDON_BUILD_ONLY: '0', npm_lifecycle_event: 'postinstall' }
  ]) {
    const result = await run(env);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /AFL Andon installation failed: SSH setup check fixture failed/);
  }
  const build = await run({ AFL_ANDON_BUILD_ONLY: '1', npm_lifecycle_event: 'postinstall' });
  assert.equal(build.exitCode, 0);
  assert.match(build.output, /Build-only install: skipping user configuration and SSH checks/);
});
