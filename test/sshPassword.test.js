'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const SSHOperations = require('../sshOperations');

test('answers keyboard-interactive prompts with the session password', async () => {
  class KeyboardInteractiveClient extends EventEmitter {
    connect(options) {
      this.options = options;
      queueMicrotask(() => {
        this.emit(
          'keyboard-interactive',
          'SSH login',
          '',
          '',
          [{ prompt: 'Password: ', echo: false }],
          answers => {
            this.answers = answers;
            this.emit('ready');
          }
        );
      });
    }

    end() {}
    destroy() {}
  }

  const client = new KeyboardInteractiveClient();
  const operations = new SSHOperations('/tmp/config', '/tmp/key', {
    clientFactory: () => client
  });

  const connection = await operations.connectWithPassword(
    'tiled',
    { host: 'nas', username: 'admin', sshPort: 2222 },
    'secret',
    5000
  );

  assert.equal(connection, client);
  assert.equal(client.options.tryKeyboard, true);
  assert.equal(client.options.port, 2222);
  assert.deepEqual(client.answers, ['secret']);
});

test('uses an in-memory SSH password before configured keys', async () => {
  const operations = new SSHOperations('/tmp/config', '/tmp/key');
  operations.config = { tiled: { host: 'nas', username: 'admin', ssh_authentication: 'password' } };
  operations.sshKeys = [{ path: '/tmp/key', key: Buffer.from('unused') }];
  operations.setSessionPassword('tiled', 'secret');

  let passwordAttempted = false;
  operations.connectWithPassword = async (_name, server, password) => {
    passwordAttempted = true;
    assert.equal(server.host, 'nas');
    assert.equal(password, 'secret');
    return { connected: true };
  };
  operations.connectWithKey = async () => {
    throw new Error('key authentication should not be attempted');
  };

  const result = await operations.connectWithAvailableKeys('tiled');
  assert.equal(passwordAttempted, true);
  assert.deepEqual(result, { conn: { connected: true }, authentication: 'password' });
  assert.equal(operations.hasSessionPassword('tiled'), true);
});

test('clears a rejected session password so the UI can ask again', async () => {
  const operations = new SSHOperations('/tmp/config', '/tmp/key');
  operations.config = { tiled: { host: 'nas', username: 'admin', ssh_authentication: 'password' } };
  operations.setSessionPassword('tiled', 'wrong');
  operations.connectWithPassword = async () => {
    const error = new Error('authentication failed');
    error.level = 'client-authentication';
    throw error;
  };

  await assert.rejects(
    operations.connectWithAvailableKeys('tiled'),
    /password authentication failed/
  );
  assert.equal(operations.hasSessionPassword('tiled'), false);
});

for (const launcher of [
  { server_module: 'AFL.double_agent.AgentDriver' },
  { server_script: '/home/user/start-agent.sh' }
]) {
  const type = launcher.server_module ? 'module' : 'script';
  test(`${type} launchers run commands with only an in-memory password`, async () => {
    const connections = [];
    class PasswordClient extends EventEmitter {
      connect(options) {
        connections.push(options);
        queueMicrotask(() => this.emit('ready'));
      }

      exec(command, callback) {
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        callback(null, stream);
        queueMicrotask(() => {
          stream.emit('data', command === 'screen -ls' ? '123.AgentServer (Detached)\n' : 'agent output\n');
          stream.emit('close', 0);
        });
      }

      end() {}
      destroy() {}
    }

    const operations = new SSHOperations('/tmp/config', undefined, {
      clientFactory: () => new PasswordClient()
    });
    operations.config = {
      agent: { host: 'workstation', username: 'user', screen_name: 'AgentServer', ssh_authentication: 'password', ...launcher }
    };

    // Missing passwords must request authentication even when no key exists.
    const missingPassword = await operations.executeCommand('agent', 'screen -ls');
    assert.equal(missingPassword.authenticationRequired, true);
    assert.equal(missingPassword.sshDown, false);
    assert.equal((await operations.getServerStatus('agent')).authenticationRequired, true);
    assert.equal((await operations.getBatchServerStatus('workstation')).authenticationRequired, true);
    assert.equal(connections.length, 0);

    operations.setSessionPassword('agent', 'session-secret');
    const status = await operations.getServerStatus('agent');
    assert.equal(status.success, true);
    assert.equal(status.status, true);
    assert.equal((await operations.getServerLog('agent')).output, 'agent output\n');
    assert.equal(connections.length, 2);
    assert.ok(connections.every(options => options.password === 'session-secret' && !options.privateKey));
  });
}

test('key authentication stays selected when another launcher has cached a password', async () => {
  const operations = new SSHOperations('/tmp/config');
  operations.config = {
    password: { host: 'workstation', username: 'user', ssh_authentication: 'password' },
    key: { host: 'workstation', username: 'user', ssh_authentication: 'key' },
    legacy: { host: 'workstation', username: 'user' }
  };
  operations.sshKeys = [{ path: '/tmp/key', key: Buffer.from('test-key') }];
  operations.setSessionPassword('password', 'session-secret');
  operations.connectWithPassword = async () => { throw new Error('Password mode was not selected'); };
  operations.connectWithKey = async () => ({ connected: true });

  assert.equal((await operations.connectWithAvailableKeys('key')).keyPath, '/tmp/key');
  assert.equal((await operations.connectWithAvailableKeys('legacy')).keyPath, '/tmp/key');
});

test('passwords are shared only by matching SSH endpoints', () => {
  const operations = new SSHOperations('/tmp/config');
  operations.config = {
    module: { host: 'workstation', username: 'user', ssh_authentication: 'password' },
    script: { host: 'workstation', username: 'user', sshPort: 22, ssh_authentication: 'password' },
    otherPort: { host: 'workstation', username: 'user', sshPort: 2222, ssh_authentication: 'password' },
    otherUser: { host: 'workstation', username: 'other', ssh_authentication: 'password' }
  };
  operations.setSessionPassword('module', 'session-secret');
  assert.equal(operations.hasSessionPassword('script'), true);
  assert.equal(operations.hasSessionPassword('otherPort'), false);
  assert.equal(operations.hasSessionPassword('otherUser'), false);
});

test('launcher authentication survives saving without persisting the session password', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'andon-password-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'launchers.json');
  const operations = new SSHOperations(configPath);
  operations.addServer('agent', { host: 'workstation', username: 'user', server_module: 'AFL.double_agent.AgentDriver', ssh_authentication: 'password' });
  operations.setSessionPassword('agent', 'session-secret');
  await operations.saveConfig();

  const saved = await fs.readFile(configPath, 'utf8');
  assert.equal(saved.includes('session-secret'), false);
  const reloaded = new SSHOperations(configPath);
  await reloaded.loadConfig();
  assert.equal(reloaded.config.agent.ssh_authentication, 'password');
  assert.equal(reloaded.hasSessionPassword('agent'), false);
  await assert.rejects(reloaded.connectWithAvailableKeys('agent'), { code: 'SSH_AUTHENTICATION_REQUIRED' });
});

test('config uploads and runtime records use the selected launcher account on a shared host', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'andon-password-upload-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const localPath = path.join(directory, 'agent.json');
  await fs.writeFile(localPath, '{"save_path":"/home/user/results"}');
  const operations = new SSHOperations('/tmp/config');
  operations.config = {
    legacy: { host: 'workstation', username: 'other', ssh_authentication: 'key' },
    agent: {
      host: 'workstation', username: 'user', ssh_authentication: 'password',
      server_module: 'AFL.double_agent.AgentDriver', config_file_location: localPath
    }
  };
  operations.setSessionPassword('agent', 'session-secret');
  const remoteFiles = new Map();
  operations.getRemoteOs = async serverName => {
    assert.equal(serverName, 'agent');
    return 'linux';
  };
  operations.connectWithPassword = async (serverName, server, password) => {
    assert.equal(serverName, 'agent');
    assert.equal(server.username, 'user');
    assert.equal(password, 'session-secret');
    return {
      end() {},
      sftp(callback) {
        callback(null, {
          mkdir(_path, _options, done) { done(); },
          readFile(remotePath, _encoding, done) {
            if (remoteFiles.has(remotePath)) done(null, remoteFiles.get(remotePath));
            else done(Object.assign(new Error('No such file'), { code: 'ENOENT' }));
          },
          writeFile(remotePath, content, _encoding, done) {
            remoteFiles.set(remotePath, content);
            done();
          }
        });
      }
    };
  };

  const uploaded = await operations.resolveModuleConfigPath('agent', operations.config.agent);
  assert.equal(uploaded.success, true);
  assert.equal(remoteFiles.get(uploaded.configPath), await fs.readFile(localPath, 'utf8'));
  assert.equal((await operations.updateAndonRuntimeConfig('agent', 'running')).success, true);
  const runtime = remoteFiles.get('/home/user/.afl/configs/andon.config.json');
  assert.equal(JSON.parse(runtime).launchers.agent.ssh_authentication, 'password');
  assert.equal(runtime.includes('session-secret'), false);
});
