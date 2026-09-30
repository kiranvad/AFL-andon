'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const SSHOperations = require('../sshOperations');

test('reads the screen-log byte boundary before launch', async () => {
  const operations = new SSHOperations('/tmp/config', '/tmp/key');
  operations.config = { alpha: { screen_name: 'Alpha Server' } };
  let command = '';
  operations.executeCommand = async (_name, value) => {
    command = value;
    return { success: true, output: '1234\n' };
  };
  assert.deepEqual(await operations.getServerLogSize('alpha'), { success: true, size: 1234 });
  assert.match(command, /wc -c/);
  assert.match(command, /Alpha Server\.screenlog/);
});

test('streams the screen log from the supplied session byte boundary', async () => {
  const connection = new EventEmitter();
  const channel = new EventEmitter();
  channel.stderr = new EventEmitter();
  channel.setEncoding = () => {};
  channel.close = () => channel.emit('close');
  connection.end = () => {};
  let command = '';
  connection.exec = (value, callback) => {
    command = value;
    callback(null, channel);
    setImmediate(() => channel.emit('data', 'startup line\n'));
  };

  const operations = new SSHOperations('/tmp/config', '/tmp/key');
  operations.config = { alpha: { host: 'host', username: 'user', screen_name: 'Alpha Server' } };
  operations.connectWithAvailableKeys = async () => ({ conn: connection });
  const chunks = [];
  const controller = await operations.streamServerLog('alpha', 42, { onData: data => chunks.push(data) });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(command, `tail -c +43 -F "$HOME"/'.afl/Alpha Server.screenlog'`);
  assert.equal(chunks.join(''), 'startup line\n');
  assert.equal(controller.offset, 55);
  controller.close();
});

test('streams Docker Compose logs for a remotely managed Tiled profile', async () => {
  const connection = new EventEmitter();
  const channel = new EventEmitter();
  channel.stderr = new EventEmitter();
  channel.setEncoding = () => {};
  channel.close = () => channel.emit('close');
  const writes = [];
  channel.write = value => writes.push(value);
  connection.end = () => {};
  let command = '';
  connection.exec = (value, callback) => {
    command = value;
    callback(null, channel);
  };

  const operations = new SSHOperations('/tmp/config', '/tmp/key');
  operations.config = {
    tiled: {
      host: 'nas',
      username: 'admin',
      server_type: 'tiled',
      tiled_management: {
        type: 'docker_compose',
        authentication: 'password',
        projectDirectory: '/srv/tiled-project',
        service: 'tiled'
      }
    }
  };
  operations.setSessionPassword('tiled', 'test-password');
  operations.connectWithAvailableKeys = async () => ({ conn: connection });
  const controller = await operations.streamServerLog('tiled', 42);

  assert.match(command, /^sudo -S -p '' -i sh -lc/);
  assert.match(command, /docker compose logs --follow --tail=0 --no-color/);
  assert.deepEqual(writes, ['test-password\n']);
  assert.equal(controller.offset, null);
  controller.close();
});

test('reports a failure when the log stream cannot be opened', async () => {
  const connection = new EventEmitter();
  connection.end = () => {};
  connection.exec = (_value, callback) => {
    callback(new Error('no screen session'));
  };
  const operations = new SSHOperations('/tmp/config', '/tmp/key');
  operations.config = { alpha: { host: 'host', username: 'user', screen_name: 'alpha' } };
  operations.connectWithAvailableKeys = async () => ({ conn: connection });

  await assert.rejects(
    operations.streamServerLog('alpha', 0),
    /no screen session/
  );
});

test('sets a one-second GNU Screen logfile flush interval after launch', async () => {
  const operations = new SSHOperations('/tmp/config', '/tmp/key');
  operations.config = {
    alpha: {
      host: 'host',
      username: 'user',
      screen_name: 'Alpha Server',
      server_script: '/opt/alpha/start.sh',
      shell: 'bash'
    }
  };
  operations.getRemoteOs = async () => 'linux';
  const commands = [];
  operations.executeCommand = async (_name, command) => {
    commands.push(command);
    return { success: true, output: '', code: 0 };
  };
  operations.waitForServerHealth = async () => ({ ok: true });
  operations.ensureScreenDetached = async () => ({ ok: true });
  operations.updateAndonRuntimeConfig = async () => ({ success: true });

  const result = await operations.startServer('alpha');

  assert.equal(result.success, true);
  assert.equal(commands[1], "screen -S 'Alpha Server' -X logfile flush 1");
});

test('keeps a live Screen driver accessible when HTTP health is unavailable', async () => {
  const operations = new SSHOperations('/tmp/config', '/tmp/key');
  operations.config = {
    camera: {
      host: 'localhost',
      username: 'user',
      httpPort: 5095,
      screen_name: 'camera',
      server_module: 'AFL.automation.vision.RGBCamera -i',
      shell: 'bash'
    }
  };
  operations.getRemoteOs = async () => 'linux';
  operations.executeCommand = async () => ({ success: true, output: '', code: 0 });
  operations.waitForServerHealth = async () => ({
    ok: false,
    url: 'http://localhost:5095/queue_state',
    reason: 'connection refused'
  });
  operations.ensureScreenDetached = async () => ({ ok: true });
  operations.updateAndonRuntimeConfig = async () => ({ success: true });

  const result = await operations.startServer('camera');

  assert.equal(result.success, true);
  assert.equal(result.degraded, true);
  assert.equal(result.screenState, 'detached');
  assert.match(result.warning, /HTTP is not reachable/);
});

test('fails startup when neither HTTP nor the Screen process survives', async () => {
  const operations = new SSHOperations('/tmp/config', '/tmp/key');
  operations.config = {
    camera: {
      host: 'localhost',
      username: 'user',
      httpPort: 5095,
      screen_name: 'camera',
      server_module: 'AFL.automation.vision.RGBCamera -i',
      shell: 'bash'
    }
  };
  operations.getRemoteOs = async () => 'linux';
  operations.executeCommand = async () => ({ success: true, output: '', code: 0 });
  operations.waitForServerHealth = async () => ({
    ok: false,
    url: 'http://localhost:5095/queue_state',
    reason: 'connection refused'
  });
  operations.ensureScreenDetached = async () => ({ ok: false, reason: 'screen session "camera" exited' });

  const result = await operations.startServer('camera');

  assert.equal(result.success, false);
  assert.match(result.error, /screen session is unavailable/);
});
