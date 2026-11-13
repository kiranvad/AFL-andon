'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { registerTerminationHandlers } = require('../termination');

const mainPath = path.resolve(__dirname, '../main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const mainRequire = createRequire(mainPath);
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function setup(t, { env = {}, stopFailure = null } = {}) {
  const calls = [];
  const handlers = new Map();
  const runtime = Object.assign(new EventEmitter(), {
    pid: 200, ppid: 100, platform: 'linux', argv: [], env, versions: {},
    stdin: {}, stdout: {}, stderr: {}
  });
  const app = Object.assign(new EventEmitter(), {
    whenReady: () => Promise.resolve(),
    exit: code => calls.push(['exit', code]),
    quit: () => calls.push(['quit'])
  });
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = { isDestroyed: () => false, send() {} };
    }
    async loadFile() {}
  }
  let finishStops;
  const stopGate = new Promise(resolve => { finishStops = resolve; });
  class SSHOperations {
    config = { nas: { server_type: 'tiled' } };
    async initialize() {}
    async startServer(name) { return { success: name !== 'failed' }; }
    async restartServer() { return { success: true }; }
    async stopServer(name) {
      calls.push(['stop', name]);
      await stopGate;
      if (name === 'failed' && stopFailure) return { success: false, error: stopFailure };
      return name === 'nas' ? { success: true, disconnected: true } : { success: true };
    }
    closeTiledTunnels() { calls.push(['close-tunnels']); }
  }
  class CombinedLogWriter {
    async flush() { calls.push(['flush']); }
  }
  const errors = [];
  const log = Object.fromEntries(['info', 'debug', 'warn', 'error'].map(level => [level,
    (...args) => { if (level === 'error') errors.push(args.join(' ')); }]));
  const mocks = {
    electron: {
      app, BrowserWindow, dialog: {},
      ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} }
    },
    './logger': { createLogger: () => log, setLogSink() {} },
    './sshOperations': SSHOperations,
    './installation': { async installAndon() {} },
    './combinedLog': { CombinedLogWriter },
    './termination': {
      ...mainRequire('./termination'),
      registerTerminationHandlers(callback) {
        t.after(registerTerminationHandlers(callback, runtime));
      }
    }
  };
  vm.runInNewContext(mainSource, {
    require: name => mocks[name] || mainRequire(name),
    __dirname: path.dirname(mainPath), process: runtime, console,
    setTimeout, clearTimeout, URL
  }, { filename: mainPath });
  await nextTurn();
  const launch = async () => {
    const event = { sender: {} };
    await handlers.get('start-server')(event, 'started');
    await handlers.get('restart-server')(event, 'restarted');
    await handlers.get('start-server')(event, 'failed');
    await handlers.get('start-server')(event, 'nas');
  };
  return { calls, app, runtime, finishStops, launch, errors };
}

test('terminal hangup waits for the same server cleanup as closing the app', async t => {
  for (const trigger of ['SIGHUP', 'window-all-closed']) {
    const { calls, app, runtime, finishStops, launch } = await setup(t);
    await launch();
    if (trigger === 'SIGHUP') {
      runtime.emit('SIGHUP');
      runtime.emit('SIGHUP');
      runtime.emit('SIGTERM');
    } else {
      app.emit('window-all-closed');
    }
    assert.deepEqual(calls, [
      ['stop', 'started'], ['stop', 'restarted'], ['stop', 'failed']
    ]);
    finishStops();
    await nextTurn();
    assert.deepEqual(calls, [
      ['stop', 'started'], ['stop', 'restarted'], ['stop', 'failed'], ['stop', 'nas'],
      ['close-tunnels'], ['flush'], trigger === 'SIGHUP' ? ['exit', 129] : ['quit']
    ]);
  }
});

test('loss of the npm launch wrapper runs server cleanup without receiving a signal', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { calls, runtime, finishStops, launch } = await setup(t, {
    env: { npm_lifecycle_event: 'start' }
  });
  await launch();
  runtime.ppid = 1;
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, [
    ['stop', 'started'], ['stop', 'restarted'], ['stop', 'failed']
  ]);
  finishStops();
  await nextTurn();
  assert.deepEqual(calls.at(-1), ['exit', 129]);
});

test('shutdown reports returned Stop failures and still releases tunnels', async t => {
  const { app, calls, errors, finishStops, launch } = await setup(t, { stopFailure: 'process remains alive' });
  await launch();
  app.emit('window-all-closed');
  finishStops();
  await nextTurn();
  assert.ok(errors.some(error => error.includes('failed') && error.includes('process remains alive')));
  assert.ok(calls.some(([name]) => name === 'close-tunnels'));
  assert.ok(calls.findIndex(([name, server]) => name === 'stop' && server === 'nas') >
    calls.findIndex(([name, server]) => name === 'stop' && server === 'failed'));
});
