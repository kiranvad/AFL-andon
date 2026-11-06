'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const mainPath = path.resolve(__dirname, '../main.js');
const source = fs.readFileSync(mainPath, 'utf8');
const mainRequire = createRequire(mainPath);

async function setup(options = {}) {
  const handlers = new Map();
  const events = [];
  const streamCallbacks = new Map();
  let sink;
  let operations;
  const app = Object.assign(new EventEmitter(), {
    whenReady: () => Promise.resolve(), exit() {}, quit() {}
  });
  const runtime = Object.assign(new EventEmitter(), {
    pid: 200, ppid: 100, platform: 'linux', argv: [], env: {}, versions: {},
    stdin: {}, stdout: {}, stderr: {}
  });
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = { isDestroyed: () => false, send: (channel, payload) => events.push(payload) };
    }
    async loadFile() {}
  }
  class SSHOperations {
    constructor() {
      operations = this;
      this.config = options.config || { Sulphur: { host: 'sulphur' }, worker: { host: 'worker' } };
    }
    async initialize() {}
    async getServerLogSize() { return { success: true, size: 0 }; }
    async streamServerLog(name, offset, callbacks) {
      streamCallbacks.set(name, callbacks);
      return { offset, close() {} };
    }
  }
  class CombinedLogWriter {
    async append() {}
    async flush() {}
  }
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (...args) =>
    sink?.({ level, moduleName: 'main', text: args.join(' '), observedAt: Date.now() })
  ]));
  const mocks = {
    electron: {
      app, BrowserWindow, dialog: { showOpenDialog: async () => ({ canceled: true }) },
      ipcMain: { handle: (channel, callback) => handlers.set(channel, callback), on() {} }
    },
    './logger': { createLogger: () => logger, setLogSink: callback => { sink = callback; } },
    './sshOperations': SSHOperations,
    './combinedLog': { CombinedLogWriter },
    './termination': { signalExitCodes: {}, registerTerminationHandlers() {} }
  };
  if (options.profile) mocks['./tiled/profile'] = { loadTiledProfile: async () => options.profile };
  vm.runInNewContext(source, {
    require: name => mocks[name] || mainRequire(name),
    __dirname: path.dirname(mainPath), process: runtime, console, setTimeout, clearTimeout, URL,
    fetch: options.fetch
  }, { filename: mainPath });
  await new Promise(resolve => setImmediate(resolve));
  const invoke = (channel, ...args) => handlers.get(channel)({ sender: {} }, ...args);
  return { operations, logger, streamCallbacks, invoke, errors: () => events.filter(event => event.type === 'error') };
}

test('failed SSH results preserve exact errors and command output with the affected server', async () => {
  const { operations, invoke, errors } = await setup();
  operations.startServer = async () => ({ success: false, sshDown: true, error: 'All configured authentication methods failed', output: 'Exact command output' });
  const result = await invoke('start-server', 'Sulphur');
  assert.equal(result.error, 'All configured authentication methods failed');
  assert.deepEqual(errors().map(event => [event.serverName, event.error]), [
    ['Sulphur', 'All configured authentication methods failed'], ['Sulphur', 'Exact command output']
  ]);
});

test('the bundled Tiled browser uses the local AFL proxy endpoint for health and search', async () => {
  const requests = [];
  const { invoke } = await setup({
    config: { tiled: {
      server_type: 'tiled', host: 'localhost', httpPort: 8001,
      config_file_location: '/profiles/http.yml', tiled_management: { type: 'afl_proxy' }
    } },
    profile: { mode: 'proxy', uri: 'http://tiled.example:8000/', apiKey: 'test-key' },
    fetch: async (url, options) => {
      requests.push({ url: String(url), headers: options.headers });
      return { ok: true, status: 200, json: async () => ({ data: [], meta: { count: 0 } }) };
    }
  });
  assert.equal((await invoke('tiled-ping', 'tiled')).ok, true);
  assert.equal((await invoke('tiled-search', 'tiled', {})).success, true);
  assert.ok(requests.length >= 3);
  assert.ok(requests.every(request => request.url.startsWith('http://localhost:8001/api/v1/')));
  assert.ok(requests.every(request => request.headers.Authorization === 'Apikey test-key'));
});

test('concurrent server operations attach their log errors to the correct server', async () => {
  const { operations, logger, invoke, errors } = await setup();
  const finish = {};
  operations.startServer = async name => {
    await new Promise(resolve => { finish[name] = resolve; });
    logger.error('socket: Permission denied');
    return { success: false, error: 'socket: Permission denied' };
  };
  const sulphur = invoke('start-server', 'Sulphur');
  const worker = invoke('start-server', 'worker');
  finish.worker();
  finish.Sulphur();
  await Promise.all([sulphur, worker]);
  assert.deepEqual(new Set(errors().map(event => event.serverName)), new Set(['Sulphur', 'worker']));
});

test('a startup traceback opens an error event before health checks finish or logs are activated', async () => {
  const { operations, streamCallbacks, invoke, errors } = await setup();
  let finishStartup;
  const gate = new Promise(resolve => { finishStartup = resolve; });
  operations.startServer = async (name, options) => {
    await options.onLaunched({ success: true, size: 0 });
    await gate;
    return { success: true };
  };
  const startup = invoke('start-server', 'Sulphur');
  await new Promise(resolve => setImmediate(resolve));
  const callbacks = streamCallbacks.get('Sulphur');
  callbacks.onData('Traceback (most recent call last):\n  File "/app/server.py", line 1\nOSE');
  assert.equal(errors().length, 0);
  callbacks.onData('rror: [Errno 98] Address already in use\n');
  assert.equal(errors().length, 1);
  assert.equal(errors()[0].serverName, 'Sulphur');
  assert.equal(errors()[0].error, 'Traceback (most recent call last):\n  File "/app/server.py", line 1\nOSError: [Errno 98] Address already in use');
  finishStartup();
  await startup;
});

test('status failures are reported once per incident and report again after recovery', async () => {
  const { operations, invoke, errors } = await setup();
  operations.getBatchServerStatus = async () => ({ success: false, error: 'Connection refused' });
  await invoke('get-batch-server-status', 'sulphur', 'Sulphur');
  await invoke('get-batch-server-status', 'sulphur', 'Sulphur');
  assert.equal(errors().length, 1);
  operations.getBatchServerStatus = async () => ({ success: true, sessions: [] });
  await invoke('get-batch-server-status', 'sulphur', 'Sulphur');
  operations.getBatchServerStatus = async () => ({ success: false, error: 'Connection refused' });
  await invoke('get-batch-server-status', 'sulphur', 'Sulphur');
  assert.equal(errors().length, 2);
});

test('rejected configuration changes report the full exception and server', async () => {
  const { operations, invoke, errors } = await setup();
  operations.updateServer = () => {};
  const failure = new Error('EACCES: permission denied, open launchers.json');
  operations.saveConfig = async () => { throw failure; };
  await assert.rejects(invoke('update-server', { serverName: 'Sulphur', serverConfig: {} }), /EACCES/);
  assert.equal(errors()[0].serverName, 'Sulphur');
  assert.equal(errors()[0].error, failure.stack);
});

test('canceling a file selection is not reported as an error', async () => {
  const { invoke, errors } = await setup();
  const result = await invoke('import-config');
  assert.equal(result.canceled, true);
  assert.equal(errors().length, 0);
});
