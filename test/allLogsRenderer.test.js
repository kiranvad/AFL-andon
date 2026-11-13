'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function setupRenderer() {
  const rendererPath = path.resolve(__dirname, '../renderer.js');
  const rendererRequire = createRequire(rendererPath);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  function element(tag, attributes = '') {
    const listeners = new Map();
    const flatten = children => children.flatMap(child => child.tag === 'fragment' ? child.children : [child]);
    return {
      tag, children: [], textContent: '', value: '', style: {}, dataset: {},
      checked: /(?:^|\s)checked(?:\s|=|$)/.test(attributes),
      scrollHeight: 0, scrollTop: 0, clientHeight: 0,
      addEventListener(type, callback) { listeners.set(type, callback); },
      dispatch(type, event = {}) { listeners.get(type)?.(event); },
      replaceChildren(...children) { this.children = flatten(children); },
      append(...children) { this.children.push(...flatten(children)); },
      appendChild(child) { this.append(child); },
      setAttribute() {}
    };
  }
  const elements = Object.fromEntries([...html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)]
    .map(([, tag, attributes, id]) => [id, element(tag, attributes)]));
  let initialize;
  const listeners = new Map();
  const timers = new Map();
  const persisted = [];
  let timerId = 0;
  const logger = Object.fromEntries(['info', 'debug', 'warn', 'error'].map(level => [level, () => {}]));
  const mocks = {
    electron: { ipcRenderer: {
      on: (channel, callback) => listeners.set(channel, callback),
      invoke: async () => ({ events: [] }),
      send(channel, entries) { if (channel === 'append-combined-log-entries') persisted.push(...entries); }
    } },
    './logger': { createLogger: () => logger, setLogSink() {} },
    '@xterm/xterm': {}, '@xterm/addon-fit': {}, jsoneditor: {}
  };
  const context = vm.createContext({
    __dirname: path.dirname(rendererPath), global: {}, window: {},
    document: {
      getElementById: id => elements[id],
      createElement: element,
      createDocumentFragment: () => element('fragment'),
      createTextNode: text => ({ textContent: text }),
      querySelector: () => element('span'),
      addEventListener(type, callback) { if (type === 'DOMContentLoaded') initialize = callback; }
    },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {},
    require: name => mocks[name] || rendererRequire(name)
  });
  vm.runInContext(fs.readFileSync(rendererPath, 'utf8'), context, { filename: rendererPath });
  vm.runInContext(`
    config = { Alpha: {}, Beta: {} };
    loadPaths = loadConfig = async () => {};
    renderServers = () => {};
    activeTab = 'all-logs';
  `, context);
  await initialize();
  return {
    context, elements, persisted,
    stream(payload) {
      listeners.get('server-log-stream')(null, payload);
      for (const [id, callback] of timers) { timers.delete(id); callback(); }
    },
    visible() {
      return elements['all-logs-output'].children.map(row =>
        row.children.length ? row.children.map(child => child.textContent).join('') : row.textContent
      ).join('\n');
    },
    toggle(source, checked) {
      const checkbox = elements[`all-logs-${source.toLowerCase()}`];
      checkbox.checked = checked;
      checkbox.dispatch('change');
    }
  };
}

test('global source checkboxes hide history and live output, then restore it without losing saved logs', async () => {
  const renderer = await setupRenderer();
  assert.equal(renderer.elements['all-logs-apiserver'].checked, true);
  assert.equal(renderer.elements['all-logs-queuedaemon'].checked, true);
  for (const serverName of ['Alpha', 'Beta']) {
    renderer.stream({ serverName, type: 'status', status: 'connected' });
    renderer.stream({ serverName, type: 'data', data:
      'INFO in APIServer: api-history\nINFO in QueueDaemon: queue-history\nINFO in Camera: driver-history\n' });
  }
  assert.equal((renderer.visible().match(/api-history/g) || []).length, 2);
  renderer.toggle('APIServer', false);
  assert.doesNotMatch(renderer.visible(), /api-history/);
  assert.equal((renderer.visible().match(/queue-history/g) || []).length, 2);
  renderer.toggle('QueueDaemon', false);
  assert.doesNotMatch(renderer.visible(), /api-history|queue-history/);
  assert.equal((renderer.visible().match(/driver-history/g) || []).length, 2);

  // Both source filters also apply to a server first seen after toggling.
  renderer.stream({ serverName: 'Gamma', type: 'status', status: 'connected' });
  for (const serverName of ['Alpha', 'Beta', 'Gamma']) {
    renderer.stream({ serverName, type: 'data', data:
      'INFO in APIServer: api-live\nINFO in QueueDaemon: queue-live\nINFO in Camera: driver-live\n' });
  }
  assert.doesNotMatch(renderer.visible(), /api-live|queue-live/);
  assert.equal((renderer.visible().match(/driver-live/g) || []).length, 3);
  assert.equal(renderer.persisted.length, 15);
  renderer.toggle('APIServer', true);
  assert.equal((renderer.visible().match(/api-history/g) || []).length, 2);
  assert.equal((renderer.visible().match(/api-live/g) || []).length, 3);
  assert.doesNotMatch(renderer.visible(), /queue-history|queue-live/);
  renderer.toggle('QueueDaemon', true);
  assert.equal((renderer.visible().match(/queue-live/g) || []).length, 3);

  const betaCheckbox = renderer.elements['all-logs-filters'].children[1].children[0];
  betaCheckbox.checked = false;
  betaCheckbox.dispatch('change');
  assert.doesNotMatch(renderer.visible(), /\[Beta\]/);
  renderer.elements['all-logs-search'].value = 'queue-live';
  renderer.elements['all-logs-search'].dispatch('input');
  assert.equal(renderer.elements['all-logs-output'].children.length, 2);
  assert.doesNotMatch(renderer.visible(), /api-live|driver-live/);
  renderer.toggle('QueueDaemon', false);
  assert.match(renderer.visible(), /No log lines match/);
});

test('partial lines, traceback continuations and stop/restart boundaries retain correct sources', async () => {
  const renderer = await setupRenderer();
  renderer.stream({ serverName: 'Alpha', type: 'status', status: 'connected' });
  renderer.toggle('QueueDaemon', false);
  renderer.stream({ serverName: 'Alpha', type: 'data', data: '\u001b[32mERROR in QueueDae' });
  renderer.stream({ serverName: 'Alpha', type: 'data', data: 'mon: Task failed\u001b[0m\nTraceback (most recent call last):\n  File "driver.py", line 1\n' });
  renderer.stream({ serverName: 'Alpha', type: 'data', data: 'ValueError: failure without newline' });
  renderer.stream({ serverName: 'Alpha', type: 'status', status: 'stopped' });
  assert.doesNotMatch(renderer.visible(), /Task failed|Traceback|driver.py|ValueError/);
  assert.equal(renderer.persisted.length, 4);
  renderer.toggle('QueueDaemon', true);
  assert.match(renderer.visible(), /ValueError: failure without newline/);
  renderer.toggle('QueueDaemon', false);
  renderer.stream({ serverName: 'Alpha', type: 'status', status: 'connected', reset: true });
  renderer.stream({ serverName: 'Alpha', type: 'data', data: '  driver startup after reset\n' });
  assert.match(renderer.visible(), /driver startup after reset/);
});
