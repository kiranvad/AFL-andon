'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getSshAuthentication } = require('../sshAuthentication');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

function createRenderer(launchers, invoke = async () => ({ available: false, success: true }), locations = { enabled: false, files: [] }) {
  // Exercise the real renderer functions using the IDs in the actual HTML.
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    value: '', checked: false, style: {}, dataset: {}, children: [],
    focus() {},
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); },
    group: { style: {} }, closest() { return this.group; }
  }]));
  const form = elements['server-form'];
  form.elements = elements;
  form.reset = () => {
    for (const element of Object.values(elements)) {
      element.value = '';
      element.checked = false;
    }
  };
  const saved = [];
  const logger = Object.fromEntries(['info', 'debug', 'warn', 'error'].map(level => [level, () => {}]));
  const context = vm.createContext({
    launchers, saved, locations, global: {}, __dirname: root,
    Option: function(text, value) { this.textContent = text; this.value = value; },
    document: {
      getElementById: id => elements[id], addEventListener() {},
      createElement() { return { children: [], appendChild(child) { this.children.push(child); } }; }
    },
    window: {},
    setTimeout: callback => { callback(); return 0; },
    alert: message => { throw new Error(message); },
    require(name) {
      if (name === 'electron') return { ipcRenderer: { on() {}, invoke } };
      if (name === './logger') return { createLogger: () => logger, setLogSink() {} };
      if (['@xterm/xterm', '@xterm/addon-fit', 'jsoneditor'].includes(name)) return {};
      return name.startsWith('./') ? require(path.join(root, name)) : require(name);
    }
  });
  vm.runInContext(renderer, context, { filename: 'renderer.js' });
  vm.runInContext(`
    config = launchers;
    configLocationOptions = locations;
    addServer = updateServer = async (name, server) => saved.push({ name, server });
  `, context);
  return { context, elements, form, saved };
}

test('config-location choices preserve authentication and stay out of script launches', async () => {
  const { context, elements, form, saved } = createRenderer({
    configs_locations: '/profiles',
    agent: {
      host: 'worker.example', username: 'test-user', httpPort: 5050, screen_name: 'AgentServer', active: true,
      server_module: 'AFL.double_agent.AgentDriver', ssh_authentication: 'password', config_file_location: '/profiles/original.json'
    }
  }, undefined, { enabled: true, files: ['/profiles/original.json', '/profiles/selected.json'] });
  assert.deepEqual(Array.from(context.serverNames()), ['agent']);
  context.openServerModal('agent');
  const select = elements['server-config-location-select'];
  assert.equal(elements['config-location-select-group'].style.display, 'block');
  assert.deepEqual(select.children.map(child => child.value), ['', '/profiles/original.json', '/profiles/selected.json']);
  assert.equal(select.value, '/profiles/original.json');
  select.value = '/profiles/selected.json';
  context.selectConfigLocation();
  await context.handleServerFormSubmit({ preventDefault() {}, target: form });
  assert.equal(saved[0].server.config_file_location, '/profiles/selected.json');
  assert.equal(saved[0].server.ssh_authentication, 'password');

  elements['server-type'].value = 'script';
  elements['server-script'].value = '/opt/agent/start.sh';
  context.updateServerTypeFields();
  assert.equal(elements['config-location-select-group'].style.display, 'none');
  await context.handleServerFormSubmit({ preventDefault() {}, target: form });
  assert.equal(saved[1].server.config_file_location, '');
  assert.equal(saved[1].server.server_module, '');
  assert.equal(saved[1].server.server_script, '/opt/agent/start.sh');
  assert.equal(saved[1].server.ssh_authentication, 'password');

  elements['server-type'].value = 'tiled';
  context.updateServerTypeFields();
  assert.equal(elements['config-location-select-group'].style.display, 'block');
});

for (const launcher of [
  { server_module: 'AFL.double_agent.AgentDriver' },
  { server_script: '/home/user/start-agent.sh' },
  { server_type: 'tiled', config_file_location: '/profiles/nas.yml', tiled_management: { authentication: 'key' } }
]) {
  const type = launcher.server_type || (launcher.server_module ? 'module' : 'script');
  test(`${type} editor restores and saves the authentication choice`, async () => {
    const { context, elements, form, saved } = createRenderer({
      agent: {
        host: 'workstation', username: 'user', httpPort: 5000, screen_name: 'AgentServer',
        ssh_authentication: 'password', active: true, ...launcher
      }
    });
    context.openServerModal('agent');
    assert.equal(elements['server-ssh-authentication'].value, 'password');
    assert.equal(elements['ssh-authentication-group'].style.display, 'block');
    await context.handleServerFormSubmit({ preventDefault() {}, target: form });
    assert.equal(saved[0].server.ssh_authentication, 'password');
    assert.equal(Object.hasOwn(saved[0].server, 'password'), false);

    context.openServerModal('agent');
    elements['server-ssh-authentication'].value = 'key';
    await context.handleServerFormSubmit({ preventDefault() {}, target: form });
    assert.equal(saved[1].server.ssh_authentication, 'key');

    context.openServerModal();
    assert.equal(elements['server-ssh-authentication'].value, 'key');
    assert.equal(elements['ssh-authentication-group'].style.display, 'block');
  });
}

test('editing a legacy Tiled profile retains its YAML authentication in the card', async () => {
  const server = { server_type: 'tiled', tiled_management: { authentication: 'password' } };
  const { context, elements, form, saved } = createRenderer({ tiled: server });
  context.openServerModal('tiled');
  assert.equal(getSshAuthentication(server), 'password');
  assert.equal(elements['server-ssh-authentication'].value, 'password');
  assert.equal(elements['ssh-authentication-group'].style.display, 'block');
  await context.handleServerFormSubmit({ preventDefault() {}, target: form });
  assert.equal(saved[0].server.ssh_authentication, 'password');

  elements['server-ssh-authentication'].value = 'key';
  await context.handleServerFormSubmit({ preventDefault() {}, target: form });
  assert.equal(getSshAuthentication({ ...server, ...saved[1].server }), 'key');
});

test('the AFL Tiled proxy retains the existing card controls and indicators', () => {
  const { context } = createRenderer({ tiled: {
    server_type: 'tiled', tiled_management: { type: 'afl_proxy' },
    host: 'localhost', username: 'user', httpPort: 8001, active: true
  } });
  const card = context.createServerControls('tiled');
  const all = [];
  function visit(element) { all.push(element); element.children.forEach(visit); }
  visit(card);
  assert.deepEqual(all.filter(element => /-btn$/.test(element.className || '')).map(element => element.textContent),
    ['Edit', 'Deactivate', 'Start', 'Stop', 'Restart', 'View Log', 'Join']);
  assert.equal(all.find(element => element.id === 'tiled-screen-status').textContent, 'SSH DOWN');
  assert.equal(all.find(element => element.id === 'tiled-http-status').textContent, 'SERVER DOWN');
});

test('selecting a local script saves its file path and clears the previous module selection', async () => {
  const selected = '/control/launchers/start-worker.sh';
  const calls = [];
  const { context, elements, form, saved } = createRenderer({
    worker: { host: 'worker', username: 'test-user', server_module: 'AFL.double_agent.AgentDriver', server_type: 'module', config_file_location: '/old/AgentDriver.json' }
  }, async (channel, options) => {
    calls.push({ channel, options });
    return { canceled: false, filePaths: [selected] };
  });
  context.openServerModal('worker');
  elements['server-type'].value = 'script';
  await context.browseServerScript();
  assert.equal(calls[0].channel, 'show-open-dialog');
  assert.equal(elements['server-script'].value, selected);
  await context.handleServerFormSubmit({ preventDefault() {}, target: form });
  assert.equal(saved[0].server.server_type, 'script');
  assert.equal(saved[0].server.server_module, '');
  assert.equal(saved[0].server.server_script, '');
  assert.equal(saved[0].server.script_file_location, selected);
  assert.equal(saved[0].server.config_file_location, '');
});

test('Tiled editor hides derived fields, keeps YAML Browse available, and omits stale values', async () => {
  const selected = '/private configs/tiled.yml';
  const calls = [];
  const { context, elements, form, saved } = createRenderer({ tiled: {
    server_type: 'tiled', host: 'localhost', username: 'user', httpPort: 1234,
    screen_name: 'tiled', status_url: 'http://stale/healthz', webview_url: 'http://stale/',
    config_file_location: '/old.yml'
  } }, async (channel, options) => {
    calls.push({ channel, options });
    return { canceled: false, filePaths: [selected] };
  });
  context.openServerModal('tiled');
  for (const id of ['server-http-port', 'server-status-url', 'server-webview-url']) {
    assert.equal(elements[id].group.style.display, 'none');
    assert.equal(elements[id].disabled, true);
  }
  assert.equal(elements['server-http-port'].required, false);
  assert.equal(elements['config-file-group'].style.display, 'block');
  assert.ok(elements['browse-server-config']);
  await context.browseServerConfig();
  assert.deepEqual(Array.from(calls[0].options.filters[0].extensions), ['yml', 'yaml']);
  assert.equal(elements['server-config-file-location'].value, selected);
  await context.handleServerFormSubmit({ preventDefault() {}, target: form });
  assert.equal(saved[0].server.config_file_location, selected);
  for (const key of ['httpPort', 'status_url', 'webview_url']) assert.equal(Object.hasOwn(saved[0].server, key), false);
  elements['server-type'].value = 'module';
  context.updateServerTypeFields();
  assert.equal(elements['server-http-port'].group.style.display, 'block');
  assert.equal(elements['server-http-port'].required, true);
  assert.equal(elements['server-http-port'].disabled, false);
});

test('typing a local script path selects it for copying on start', async t => {
  const os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'andon-script-editor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const selected = path.join(directory, 'start-worker.sh');
  fs.writeFileSync(selected, '#!/usr/bin/env bash\n');
  const { context, elements, form, saved } = createRenderer({});
  context.openServerModal();
  elements['server-name'].value = 'Worker';
  elements['server-type'].value = 'script';
  elements['server-script'].value = selected;
  await context.handleServerFormSubmit({ preventDefault() {}, target: form });
  assert.equal(saved[0].server.script_file_location, selected);
});

test('canceling script selection preserves the current file', async () => {
  const selected = '/control/launchers/start-worker.sh';
  const { context, elements } = createRenderer({
    worker: { script_file_location: selected }
  }, async () => ({ canceled: true, filePaths: [] }));
  context.openServerModal('worker');
  assert.equal(elements['server-type'].value, 'script');
  await context.browseServerScript();
  assert.equal(elements['server-script'].value, selected);
  assert.equal(elements['server-script'].dataset.localFile, selected);
});

test('ordinary launchers prompt once, reuse the cached password, and allow cancellation', async () => {
  const calls = [];
  let password = '';
  const { context, elements } = createRenderer({
    agent: { host: 'workstation', username: 'user', ssh_authentication: 'password' }
  }, async (channel, _name, value) => {
    calls.push(channel);
    if (channel === 'has-session-ssh-password') return { available: Boolean(password) };
    if (channel === 'set-session-ssh-password') password = value;
    return { success: true };
  });
  const first = context.ensureSshPassword('agent');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements['ssh-password-modal'].style.display, 'block');
  context.finishSshPasswordPrompt('session-secret');
  assert.equal(await first, true);
  assert.equal(await context.ensureSshPassword('agent'), true);
  assert.deepEqual(calls, ['has-session-ssh-password', 'set-session-ssh-password', 'has-session-ssh-password']);
  assert.equal(elements['ssh-password-input'].value, '');

  password = '';
  const canceled = context.ensureSshPassword('agent');
  await new Promise(resolve => setImmediate(resolve));
  context.finishSshPasswordPrompt();
  assert.equal(await canceled, false);
  assert.equal(calls.filter(channel => channel === 'set-session-ssh-password').length, 1);
});

test('status polling uses a started launcher for each account and authentication mode', async () => {
  const queries = [];
  const { context } = createRenderer({
    inactive: { host: 'workstation', username: 'unused' },
    agent: { host: 'workstation', username: 'user', ssh_authentication: 'password' },
    script: { host: 'workstation', username: 'user', ssh_authentication: 'password' },
    other: { host: 'workstation', username: 'other', ssh_authentication: 'password' },
    keyed: { host: 'workstation', username: 'user', ssh_authentication: 'key' }
  }, async (channel, host, name) => {
    if (channel === 'get-servers-by-host') return { workstation: ['inactive', 'agent', 'script', 'other', 'keyed'] };
    queries.push({ channel, host, name });
    return { success: true, sessions: [], sessionDetails: [] };
  });
  vm.runInContext(`
    ['agent', 'script', 'other', 'keyed'].forEach(name => startedServers.add(name));
    fetchQueueState = async () => ({ ok: true, state: 'ready' });
    updateServerStatusUI = () => {};
  `, context);
  await context.batchUpdateServerStatuses();
  assert.deepEqual(queries.map(query => query.name), ['agent', 'other', 'keyed']);
  assert.ok(queries.every(query => query.channel === 'get-batch-server-status' && query.host === 'workstation'));
});
