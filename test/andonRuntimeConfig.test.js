'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const SSHOperations = require('../sshOperations');
const { setLogSink } = require('../logger');

function setup(t, { host = 'localhost', missingCode = 2, readError, connectionError, sftpError, contents } = {}) {
  const errors = [];
  setLogSink(entry => { if (entry.level === 'error') errors.push(entry.text); });
  t.after(() => setLogSink(null));
  const operations = new SSHOperations('/tmp/unused-launchers');
  operations.config = {
    other: { host, username: 'other-user' },
    agent: {
      host, username: 'test-user', server_module: 'AFL.double_agent.AgentDriver',
      screen_name: 'AgentServer', shell: 'bash', httpPort: 5000
    }
  };
  const runtimePath = '/home/test-user/.afl/configs/andon.config.json';
  const files = new Map(contents === undefined ? [] : [[runtimePath, contents]]);
  const writes = [];
  operations.getRemoteHomePath = async (_host, username, serverName) => {
    assert.equal(username, 'test-user');
    assert.equal(serverName, 'agent');
    return '/home/test-user';
  };
  operations.connectWithAvailableKeys = async serverName => {
    assert.equal(serverName, 'agent');
    if (connectionError) throw connectionError;
    return { conn: {
      end() {},
      sftp(done) {
        if (sftpError) return done(sftpError);
        done(null, {
          readFile(file, _encoding, callback) {
            if (readError) return callback(readError);
            if (files.has(file)) return callback(null, files.get(file));
            callback(Object.assign(new Error('No such file'), { code: missingCode }));
          },
          mkdir(_directory, _options, callback) { callback(); },
          writeFile(file, content, _options, callback) {
            writes.push(file);
            files.set(file, content);
            callback();
          }
        });
      }
    } };
  };
  operations.getRemoteOs = async () => 'linux';
  operations.syncActiveTiledConfigForDriver = async () => ({ success: true });
  operations.executeCommand = async () => ({ success: true, code: 0, output: '' });
  operations.waitForServerHealth = async () => ({ ok: true });
  operations.ensureScreenDetached = async () => ({ ok: true });
  return { operations, runtimePath, files, writes, errors, host };
}

for (const [host, missingCode] of [['localhost', 2], ['worker.example', 'ENOENT']]) {
  test(`the first server start on ${host} creates a runtime record without reporting a missing-file error`, async t => {
    const { operations, runtimePath, files, errors } = setup(t, { host, missingCode });
    assert.equal((await operations.startServer('agent')).success, true);
    const record = JSON.parse(files.get(runtimePath)).launchers.agent;
    assert.equal(record.runtime_state, 'running');
    assert.equal(record.username, 'test-user');
    assert.ok(record.started_at);
    assert.deepEqual(errors, []);
  });
}

test('reading missing optional runtime settings returns an empty object without logging an error', async t => {
  const { operations, errors, writes, host } = setup(t);
  assert.deepEqual(await operations.getRemoteAflConfig(host, 'agent'), { success: true, data: {} });
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
});

test('runtime updates preserve other settings and launchers', async t => {
  const previous = { notes: 'keep', launchers: { previous: { runtime_state: 'stopped' } } };
  const { operations, files, runtimePath, errors } = setup(t, { contents: JSON.stringify(previous) });
  assert.equal((await operations.updateAndonRuntimeConfig('agent', 'running')).success, true);
  assert.equal((await operations.updateAndonRuntimeConfig('agent', 'stopped')).success, true);
  const saved = JSON.parse(files.get(runtimePath));
  assert.equal(saved.notes, previous.notes);
  assert.deepEqual(saved.launchers.previous, previous.launchers.previous);
  assert.equal(saved.launchers.agent.runtime_state, 'stopped');
  assert.ok(saved.launchers.agent.started_at);
  assert.ok(saved.launchers.agent.stopped_at);
  assert.deepEqual(errors, []);
});

test('a missing required SFTP file still reports an error', async t => {
  const { operations, errors, host } = setup(t);
  const result = await operations.readRemoteFile(host, '/srv/required-config.json', 'agent');
  assert.equal(result.success, false);
  assert.equal(result.missing, undefined);
  assert.match(errors[0], /Failed to read .*No such file/);
});

for (const [name, options] of [
  ['permission denied', { readError: Object.assign(new Error('Permission denied'), { code: 3 }) }],
  ['SSH authentication failure', { connectionError: Object.assign(new Error('SSH credential file not found'), { code: 'ENOENT' }) }],
  ['SFTP setup failure', { sftpError: Object.assign(new Error('SFTP subsystem unavailable'), { code: 2 }) }]
]) {
  test(`${name} is not treated as a missing optional runtime file`, async t => {
    const { operations, errors, writes } = setup(t, options);
    assert.equal((await operations.updateAndonRuntimeConfig('agent', 'running')).success, false);
    assert.ok(errors.length > 0);
    assert.deepEqual(writes, []);
  });
}

test('invalid runtime JSON is reported and never replaced by a runtime update', async t => {
  for (const contents of ['', '{broken', 'null', '[]']) {
    const { operations, files, runtimePath, writes, errors } = setup(t, { contents });
    const result = await operations.updateAndonRuntimeConfig('agent', 'running');
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid Andon configuration/);
    assert.equal(files.get(runtimePath), contents);
    assert.deepEqual(writes, []);
    assert.ok(errors.length > 0);
  }
});
