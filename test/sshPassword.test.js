'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
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
  operations.config = { tiled: { host: 'nas', username: 'admin' } };
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
  operations.config = { tiled: { host: 'nas', username: 'admin' } };
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
