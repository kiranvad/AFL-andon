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
