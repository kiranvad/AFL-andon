'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { ErrorDialog, ServerLogErrors, inferErrorServers, ipcErrorServers } = require('../errorReporting');
const { decodeLogChunk, stripTerminalControl } = require('../allLogs');

function setupDialog() {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  function element(tag) {
    const listeners = new Map();
    return {
      tag, children: [], textContent: '', open: false, modalCalls: 0, style: {}, dataset: {},
      addEventListener(type, callback) { listeners.set(type, callback); },
      dispatch(type, event = {}) { listeners.get(type)?.(event); },
      replaceChildren() { this.children = []; },
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
      setAttribute() {},
      showModal() { assert.equal(this.tag, 'dialog'); this.open = true; this.modalCalls += 1; },
      close() { this.open = false; this.dispatch('close'); }
    };
  }
  const elements = Object.fromEntries([...html.matchAll(/<([\w-]+)\b[^>]*\bid="([^"]+)"/g)]
    .map(([, tag, id]) => [id, element(tag)]));
  let copied;
  const document = {
    getElementById: id => elements[id], createElement: element
  };
  const notifications = new ErrorDialog(document, { writeText(text) { copied = text; } });
  return { notifications, elements, document, copied: () => copied };
}

function setupRenderer(invoke) {
  const { elements, document } = setupDialog();
  const rendererPath = path.resolve(__dirname, '../renderer.js');
  const rendererRequire = createRequire(rendererPath);
  const listeners = new Map();
  const windowListeners = new Map();
  let initialize;
  document.addEventListener = (type, callback) => { if (type === 'DOMContentLoaded') initialize = callback; };
  document.querySelector = selector => selector.includes('.close') ? document.createElement('span') : null;
  const logger = Object.fromEntries(['info', 'debug', 'error', 'warn'].map(level => [level, () => {}]));
  const mocks = {
    electron: { ipcRenderer: { on: (channel, callback) => listeners.set(channel, callback), invoke, send() {} }, clipboard: { writeText() {} } },
    './logger': { createLogger: () => logger, setLogSink() {} },
    '@xterm/xterm': {}, '@xterm/addon-fit': {}, jsoneditor: {}
  };
  const context = vm.createContext({
    __dirname: path.dirname(rendererPath), document, global: {},
    window: { addEventListener: (type, callback) => windowListeners.set(type, callback) },
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {},
    require: name => mocks[name] || rendererRequire(name)
  });
  vm.runInContext(fs.readFileSync(rendererPath, 'utf8'), context, { filename: rendererPath });
  vm.runInContext("config = { Sulphur: { host: 'sulphur' } }; loadPaths = loadConfig = async () => {}; renderServers = () => {};", context);
  return { context, elements, listeners, windowListeners, initialize: () => initialize() };
}

test('queued errors block through Copy, Escape and backdrop clicks until Clear Errors', () => {
  const { notifications, elements, copied } = setupDialog();
  const exact = 'OSError: [Errno 98] Address already in use\n  <script>alert("error")</script>';
  notifications.report('Sulphur', exact, 1000);
  notifications.report('Sulphur', exact, 1001);
  notifications.report('worker', 'Permission denied', 1002);
  notifications.initialize();
  const dialog = elements['error-dialog'];
  assert.equal(dialog.open, true);
  assert.equal(dialog.modalCalls, 1);
  const entries = elements['error-list'].children;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].children[0].textContent, 'Sulphur');
  assert.equal(entries[0].children[2].textContent, exact);
  assert.deepEqual(entries[0].children[2].children, []);

  let prevented = false;
  dialog.dispatch('cancel', { preventDefault() { prevented = true; } });
  dialog.dispatch('click', { target: dialog });
  assert.equal(prevented, true);
  assert.equal(dialog.open, true);
  elements['copy-errors'].dispatch('click');
  assert.equal(copied(), '[1970-01-01T00:00:01.000Z] Sulphur\n' + exact + '\n\n[1970-01-01T00:00:01.002Z] worker\nPermission denied');
  assert.equal(dialog.open, true);
  assert.equal(notifications.errors.size, 2);
  // Even an unexpected close cannot leave unresolved errors hidden.
  dialog.close();
  assert.equal(dialog.open, true);
  elements['clear-errors'].dispatch('click');
  assert.equal(dialog.open, false);
  assert.equal(notifications.errors.size, 0);
  notifications.report('Sulphur', exact);
  assert.equal(dialog.open, true);
});

test('acknowledged polling failures stay acknowledged until recovery or a different error', () => {
  const { notifications, elements } = setupDialog();
  notifications.initialize();
  notifications.reportOnce('health:Sulphur', 'Sulphur', 'Connection refused');
  notifications.clear();
  notifications.reportOnce('health:Sulphur', 'Sulphur', 'Connection refused');
  assert.equal(elements['error-dialog'].open, false);
  notifications.reportOnce('health:Sulphur', 'Sulphur', 'Request timed out');
  assert.equal(elements['error-dialog'].open, true);
  notifications.clear();
  notifications.resolve('health:Sulphur');
  notifications.reportOnce('health:Sulphur', 'Sulphur', 'Request timed out');
  assert.equal(elements['error-dialog'].open, true);
});

test('clipboard failures retain the original error and keep Andon blocked', () => {
  const { notifications, elements } = setupDialog();
  notifications.initialize();
  notifications.report('Sulphur', 'Original error');
  notifications.clipboard.writeText = () => { throw new Error('Clipboard unavailable'); };
  notifications.copy();
  assert.equal(notifications.errors.size, 2);
  assert.equal(elements['error-dialog'].open, true);
  assert.ok([...notifications.errors.values()].some(entry => entry.text.includes('Clipboard unavailable')));
});

test('tracebacks survive chunk boundaries and concurrent server output without alteration', () => {
  const errors = [];
  const collector = new ServerLogErrors((serverName, text) => errors.push({ serverName, text }));
  const remainders = new Map();
  function feed(serverName, data) {
    const decoded = decodeLogChunk(remainders.get(serverName), stripTerminalControl(data));
    remainders.set(serverName, decoded.remainder);
    collector.consume(serverName, decoded.lines);
  }
  feed('Sulphur', 'Traceback (most recent ca');
  feed('worker', '[2026-11-05] WARNING in driver: continuing\n');
  feed('Sulphur', 'll last):\r\n  File "/app/launcher.py", line 244\r\n    server.run()\r\nOSE');
  assert.equal(errors.length, 0);
  feed('worker', '\u001b[31mERROR:driver:Permission denied\u001b[0m\n');
  feed('Sulphur', 'rror: [Errno 98] Address already in use\r\n');
  assert.deepEqual(errors, [
    { serverName: 'worker', text: 'ERROR:driver:Permission denied' },
    { serverName: 'Sulphur', text: 'Traceback (most recent call last):\n  File "/app/launcher.py", line 244\n    server.run()\nOSError: [Errno 98] Address already in use' }
  ]);
});

test('error levels and bare exceptions are collected while warnings and ordinary text remain logs', () => {
  const errors = [];
  const collector = new ServerLogErrors((server, text) => errors.push(text));
  collector.consume('Sulphur', [
    '[2026-11-05 16:15:51] ERROR in driver: exact message',
    '[ERROR] [driver] exact message',
    '2026-11-05 16:15:51,000 - driver - CRITICAL - exact message',
    'ValueError: invalid input',
    '/app/start.sh: line 10: python: command not found',
    'UserWarning: CUDA driver is old',
    'INFO:driver:No errors found',
    'The error rate is zero'
  ]);
  assert.equal(errors.length, 5);
  collector.consume('Andon', ['[ERROR] Application errors arrive separately']);
  assert.equal(errors.length, 5);
});

test('server names are matched independently of overlapping names and IPC hosts', () => {
  const config = { tiled: { host: 'localhost' }, 'tiled NAS': { host: 'nas' }, Sulphur: { host: '192.0.2.20' } };
  assert.deepEqual(inferErrorServers('tiled NAS: failed', config), ['tiled NAS']);
  assert.deepEqual(inferErrorServers('Failed to connect to 192.0.2.20', config), ['Sulphur']);
  assert.deepEqual(inferErrorServers('Application failed', config), ['Andon']);
  assert.deepEqual(ipcErrorServers('get-batch-server-status', ['192.0.2.20', 'Sulphur'], config), ['Sulphur']);
  assert.deepEqual(ipcErrorServers('update-server', [{ serverName: 'Sulphur' }], config), ['Sulphur']);
  assert.deepEqual(ipcErrorServers('start-server', ['missing'], config), ['missing']);
});

test('the renderer receives errors before initialization and on every tab, with replay protection', async () => {
  const event = { sequence: 1, serverName: 'Sulphur', type: 'error', error: 'Exact startup error' };
  const { context, elements, listeners, windowListeners, initialize } = setupRenderer(async () => ({ events: [event], latestSequence: 1 }));
  listeners.get('server-log-stream')({}, event);
  await initialize();
  assert.equal(elements['error-dialog'].open, true);
  assert.equal(elements['error-list'].children[0].children[2].textContent, event.error);
  elements['clear-errors'].dispatch('click');
  listeners.get('server-log-stream')({}, event);
  assert.equal(elements['error-dialog'].open, false);
  vm.runInContext("activeTab = 'settings';", context);
  listeners.get('server-log-stream')({}, { ...event, sequence: 2, error: 'New server failure' });
  assert.equal(elements['error-dialog'].open, true);
  elements['clear-errors'].dispatch('click');
  windowListeners.get('unhandledrejection')({ reason: new Error('Renderer failure') });
  assert.equal(elements['error-dialog'].open, true);
  assert.match(elements['error-list'].children[0].children[2].textContent, /Renderer failure/);
});

test('failed server controls use the blocking dialog with the exact returned error and output', async () => {
  const { context, elements, initialize } = setupRenderer(async channel => channel === 'get-session-log-events'
    ? { events: [] } : { success: false, error: 'Exact authentication failure', output: 'SSH diagnostic output' });
  await initialize();
  await context.controlServer('Sulphur', 'start');
  assert.equal(elements['error-dialog'].open, true);
  assert.deepEqual(elements['error-list'].children.map(entry => entry.children[2].textContent), [
    'Exact authentication failure', 'SSH diagnostic output'
  ]);
});
