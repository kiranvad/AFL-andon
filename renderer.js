// renderer.js (Renderer process)
const { ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const JSONEditor = require('jsoneditor');
const { createLogger, setLogSink } = require('./logger');
const { serverActivityPresentation } = require('./serverStatus');
const {
  MAX_MERGED_LINES,
  decodeLogChunk,
  stripTerminalControl,
  capEntries,
  filterEntries,
  stableServerColor,
  isRoutineHealthLog
} = require('./allLogs');

const log = createLogger('renderer');

// Use the built-in fetch in recent Node versions. node-fetch remains as a
// fallback for older environments but may throw if imported directly.
let fetchFn;
try {
  // Prefer global fetch if available
  fetchFn = global.fetch || require('node-fetch');
} catch (err) {
  // `require` will fail for ESM-only node-fetch; fall back to global
  fetchFn = global.fetch;
}

let config;
let editingServer = null;
let aflConfig = {};
let aflConfigEditor;
let selectedAflHost = null;

let sshStream;

let terminal;
let currentServerName;
let activeTab = null;
let loadedWebviewServerName = null;
let inactiveExpanded = false;
const startedServers = new Set();
const displayedServerStatuses = new Map();
const allLogServers = new Map();
let mergedLogEntries = [];
let allLogsPaused = false;
const logChunkRemainders = new Map();
let allLogsRenderTimer = null;
let lastSessionLogSequence = 0;
let allLogsSyncTimer = null;
let allLogsSyncRunning = false;
let sshPasswordPromptResolve = null;

setLogSink(({ level, moduleName, text, observedAt }) => {
  if (!['error', 'warn', 'info'].includes(level)) return;
  const entries = String(text).split(/\r?\n/).map(line => ({
    server: 'Andon',
    text: `[${level.toUpperCase()}] [${moduleName}] ${line}`,
    observedAt,
    type: 'app'
  }));
  addMergedLogEntries(entries);
  scheduleAllLogsRender();
});

log.info('Renderer process starting');

function requestSshPassword(serverName) {
  const modal = document.getElementById('ssh-password-modal');
  const form = document.getElementById('ssh-password-form');
  const input = document.getElementById('ssh-password-input');
  const label = document.getElementById('ssh-password-label');
  label.textContent = `SSH password for ${config[serverName].username}@${config[serverName].host}`;
  input.value = '';
  modal.style.display = 'block';
  setTimeout(() => input.focus(), 0);

  return new Promise(resolve => {
    sshPasswordPromptResolve = resolve;
    form.dataset.serverName = serverName;
  });
}

function finishSshPasswordPrompt(password = null) {
  const modal = document.getElementById('ssh-password-modal');
  const input = document.getElementById('ssh-password-input');
  modal.style.display = 'none';
  input.value = '';
  const resolve = sshPasswordPromptResolve;
  sshPasswordPromptResolve = null;
  resolve?.(password);
}

async function ensureSshPassword(serverName, forcePrompt = false) {
  const server = config?.[serverName];
  if (server?.tiled_management?.authentication !== 'password') return true;
  if (!forcePrompt) {
    const status = await ipcRenderer.invoke('has-session-ssh-password', serverName);
    if (status.available) return true;
  }
  const password = await requestSshPassword(serverName);
  if (password === null) return false;
  const result = await ipcRenderer.invoke('set-session-ssh-password', serverName, password);
  if (!result.success) {
    alert(result.error || 'Could not set the SSH password.');
    return false;
  }
  return true;
}

function ensureAllLogServer(serverName) {
  if (!allLogServers.has(serverName)) {
    allLogServers.set(serverName, {
      enabled: true,
      lifecycle: 'running',
      connection: 'waiting',
      error: ''
    });
  }
  return allLogServers.get(serverName);
}

function addMergedLogEntries(entries, { persist = true } = {}) {
  if (!entries.length) return;
  mergedLogEntries = capEntries(mergedLogEntries.concat(entries), MAX_MERGED_LINES);
  if (persist) ipcRenderer.send('append-combined-log-entries', entries);
}

function formatObservationTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
}

function renderAllLogFilters() {
  const container = document.getElementById('all-logs-filters');
  if (!container) return;
  container.replaceChildren();
  for (const [serverName, state] of allLogServers) {
    const label = document.createElement('label');
    label.className = `all-logs-filter ${state.lifecycle === 'stopped' ? 'stopped' : ''} ${state.connection === 'failed' ? 'failed' : ''}`;
    label.title = state.lifecycle === 'stopped' ? 'Stopped; collected history is retained' : (state.error || 'Connected');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.enabled;
    checkbox.addEventListener('change', () => {
      state.enabled = checkbox.checked;
      renderAllLogs();
    });
    const text = document.createElement('span');
    text.textContent = `${serverName}${state.lifecycle === 'stopped' ? ' (stopped)' : ''}`;
    text.style.color = stableServerColor(serverName);
    label.append(checkbox, text);
    container.appendChild(label);
  }
}

function renderAllLogs() {
  const output = document.getElementById('all-logs-output');
  if (!output) return;
  const keepAtBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 24;
  const enabled = new Set([...allLogServers].filter(([, state]) => state.enabled).map(([name]) => name));
  const search = document.getElementById('all-logs-search')?.value || '';
  const entries = filterEntries(mergedLogEntries, enabled, search);
  const fragment = document.createDocumentFragment();
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.id = 'all-logs-empty';
    empty.textContent = allLogServers.size
      ? 'No log lines match the current filters.'
      : 'Start or restart a server to begin collecting logs.';
    fragment.appendChild(empty);
  } else {
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = `all-log-line${entry.type === 'system' ? ' all-log-system' : ''}`;
      const time = document.createElement('span');
      time.className = 'all-log-time';
      time.textContent = `[${formatObservationTime(entry.observedAt)}] `;
      const server = document.createElement('span');
      server.className = 'all-log-server';
      server.style.color = stableServerColor(entry.server);
      server.textContent = `[${entry.server}] `;
      row.append(time, server, document.createTextNode(entry.text));
      fragment.appendChild(row);
    }
  }
  output.replaceChildren(fragment);
  if (document.getElementById('all-logs-autoscroll')?.checked && keepAtBottom) {
    output.scrollTop = output.scrollHeight;
  }
}

function updateAllLogsStatus(message) {
  const status = document.getElementById('all-logs-status');
  if (status) status.textContent = message;
}

function updateAllLogsStreamSummary() {
  const running = [...allLogServers.values()].filter(state => state.lifecycle === 'running');
  const connected = running.filter(state => state.connection === 'connected').length;
  if (!running.length) {
    updateAllLogsStatus(allLogsPaused ? 'Paused — no running servers' : 'No running servers');
  } else {
    updateAllLogsStatus(`${allLogsPaused ? 'Paused — ' : ''}${connected}/${running.length} streaming · ${mergedLogEntries.length.toLocaleString()} lines`);
  }
}

function showAllLogsPanel() {
  clearTimeout(allLogsRenderTimer);
  allLogsRenderTimer = null;
  renderAllLogFilters();
  renderAllLogs();
  updateAllLogsStreamSummary();
}

function scheduleAllLogsRender() {
  if (activeTab !== 'all-logs' || allLogsPaused || allLogsRenderTimer) return;
  allLogsRenderTimer = setTimeout(() => {
    allLogsRenderTimer = null;
    renderAllLogs();
    updateAllLogsStreamSummary();
  }, 50);
}

function handleServerLogStream({ serverName, type, data = '', status, error = '', reset = false, observedAt = Date.now(), persisted = false }) {
  const state = ensureAllLogServer(serverName);
  if (reset) logChunkRemainders.delete(serverName);
  if (type === 'data') {
    const decoded = decodeLogChunk(logChunkRemainders.get(serverName) || '', stripTerminalControl(data));
    logChunkRemainders.set(serverName, decoded.remainder);
    const entries = decoded.lines
      .filter(text => !isRoutineHealthLog(serverName, config?.[serverName], text))
      .map(text => ({ server: serverName, text, observedAt, type: 'log' }));
    addMergedLogEntries(entries, { persist: !persisted });
  } else if (type === 'status') {
    if (status === 'stopped') {
      const remainder = logChunkRemainders.get(serverName) || '';
      if (remainder && !isRoutineHealthLog(serverName, config?.[serverName], remainder)) {
        addMergedLogEntries([{ server: serverName, text: remainder, observedAt, type: 'log' }]);
      }
      logChunkRemainders.delete(serverName);
      state.lifecycle = 'stopped';
      state.connection = 'stopped';
    } else if (status === 'connected') {
      if (state.connection === 'failed') {
        addMergedLogEntries([{ server: serverName, text: 'Log connection recovered.', observedAt, type: 'system' }]);
      }
      state.lifecycle = 'running';
      state.connection = 'connected';
      state.error = '';
    } else if (status === 'failed') {
      if (state.connection !== 'failed' || state.error !== error) {
        addMergedLogEntries([{ server: serverName, text: `Log connection failed: ${error}`, observedAt, type: 'system' }]);
      }
      state.connection = 'failed';
      state.error = error;
    }
    renderAllLogFilters();
  }
  scheduleAllLogsRender();
  if (type === 'status') updateAllLogsStreamSummary();
}

function receiveServerLogEvent(payload) {
  if (payload.sequence) {
    if (payload.sequence <= lastSessionLogSequence) return;
    lastSessionLogSequence = payload.sequence;
  }
  handleServerLogStream(payload);
}

async function syncSessionLogEvents() {
  if (allLogsSyncRunning) return;
  allLogsSyncRunning = true;
  try {
    const result = await ipcRenderer.invoke('get-session-log-events', lastSessionLogSequence);
    for (const event of result.events || []) receiveServerLogEvent(event);
    lastSessionLogSequence = Math.max(lastSessionLogSequence, result.latestSequence || 0);
  } catch (error) {
    log.warn(`Could not synchronize live log events: ${error.message}`);
  } finally {
    allLogsSyncRunning = false;
  }
}

function startAllLogsSync() {
  clearInterval(allLogsSyncTimer);
  syncSessionLogEvents();
  allLogsSyncTimer = setInterval(syncSessionLogEvents, 250);
}

function stopAllLogsSync() {
  clearInterval(allLogsSyncTimer);
  allLogsSyncTimer = null;
}

async function joinServer(serverName) {
  log.info(`Joining server: ${serverName}`);
  try {
    if (!await ensureSshPassword(serverName)) return;
    // Close existing connection if any
    if (currentServerName) {
      log.debug(`Closing existing connection to ${currentServerName}`);
      await ipcRenderer.invoke('close-ssh-session', currentServerName);
      currentServerName = null;
    }

    // Reinitialize terminal
    if (terminal) {
      log.debug('Disposing old terminal instance');
      terminal.dispose();
      terminal = null;
    }
    initializeTerminal();

    log.debug(`Starting SSH session for ${serverName}`);
    const result = await ipcRenderer.invoke('start-ssh-session', serverName);
    if (result.success) {
      log.info(`Successfully connected to ${serverName}`);
      showTerminalModal();
      currentServerName = serverName;
      terminal.clear();
      terminal.writeln(`Connected to ${serverName}`);
    } else {
      log.error(`Failed to join server ${serverName}: ${result.error || 'Unknown error'}`);
      alert(`Failed to join server ${serverName}`);
    }
  } catch (error) {
    log.error(`Error joining server ${serverName}:`, error.message);
    alert(`Error joining server ${serverName}: ${error.message}`);
  }
}

function initializeTerminal() {
  if (terminal) {
    log.warn('Terminal already initialized, disposing old instance');
    terminal.dispose();
  }

  log.debug('Creating new terminal instance');
  terminal = new Terminal({
    disableStdin: false
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const terminalContainer = document.getElementById('terminal-container');
  terminal.open(terminalContainer);
  fitAddon.fit();

  terminal.onData(data => {
    if (currentServerName) {
      ipcRenderer.send('ssh-data', { serverName: currentServerName, data });
    }
  });

  // Remove any existing ssh-data listeners
  ipcRenderer.removeAllListeners('ssh-data');

  ipcRenderer.on('ssh-data', (event, { serverName, data }) => {
    if (serverName === currentServerName) {
      terminal.write(data);
    }
  });
  
  log.debug('Terminal initialized');
}


function showTerminalModal() {
  log.debug('Showing terminal modal');
  const modal = document.getElementById('terminal-modal');
  modal.style.display = 'block';
  if (!terminal) {
    initializeTerminal();
  }
}

function closeTerminalModal() {
  log.debug('Closing terminal modal');
  const modal = document.getElementById('terminal-modal');
  modal.style.display = 'none';
  if (currentServerName) {
    log.debug(`Closing SSH session for ${currentServerName}`);
    ipcRenderer.send('close-ssh-session', currentServerName);
    currentServerName = null;
  }
}

async function loadConfig() {
  log.debug('Loading configuration');
  config = await ipcRenderer.invoke('get-config');
  const serverCount = Object.keys(config || {}).length;
  log.info(`Configuration loaded: ${serverCount} servers`);
}

async function loadAflConfig() {
  if (!selectedAflHost) {
    log.debug('No AFL host selected, skipping config load');
    return;
  }
  log.info(`Loading AFL config from ${selectedAflHost}`);
  const result = await ipcRenderer.invoke('get-afl-config', selectedAflHost);
  if (!result.success) {
    log.error(`Failed to load AFL config from ${selectedAflHost}:`, result.error);
    alert(`Failed to load config: ${result.error}`);
    return;
  }
  aflConfig = result.data || {};
  log.info(`Loaded current Andon config with ${Object.keys(aflConfig).length} entries`);
  renderAflConfigEditor();
}

function renderAflConfigEditor() {
  const container = document.getElementById('afl-config-editor');
  if (!container) return;
  if (!aflConfigEditor) {
    log.debug('Creating AFL config editor');
    aflConfigEditor = new JSONEditor(container, {
      mode: 'tree',
      mainMenuBar: false,
      navigationBar: false,
      statusBar: false
    });
  }
  aflConfigEditor.set(aflConfig);
}

async function saveAflConfig() {
  if (!selectedAflHost) {
    log.warn('No AFL host selected for saving');
    return;
  }
  if (aflConfigEditor) {
    aflConfig = aflConfigEditor.get();
  }
  log.info(`Saving AFL config to ${selectedAflHost}`);
  const res = await ipcRenderer.invoke('save-afl-config', selectedAflHost, aflConfig);
  if (res && res.success) {
    log.info('AFL config saved successfully');
    alert('Settings saved');
  } else {
    const errMsg = res && res.error ? res.error : 'unknown error';
    log.error(`Failed to save AFL config:`, errMsg);
    alert(`Failed to save settings: ${errMsg}`);
  }
  await loadAflConfig();
}

function populateAflHostSelect() {
  const select = document.getElementById('config-host-select');
  if (!select) return;
  select.innerHTML = '';
  const hosts = Array.from(new Set(Object.values(config || {}).map(c => c.host)));
  log.debug(`Populating AFL host select with ${hosts.length} hosts`);
  hosts.forEach(h => {
    const opt = document.createElement('option');
    opt.value = h;
    opt.textContent = h;
    select.appendChild(opt);
  });
  if (hosts.length && !selectedAflHost) {
    selectedAflHost = hosts[0];
    select.value = selectedAflHost;
    log.debug(`Selected default AFL host: ${selectedAflHost}`);
  }
  select.onchange = async () => {
    selectedAflHost = select.value;
    log.debug(`AFL host changed to ${selectedAflHost}`);
    await loadAflConfig();
  };
}


async function fetchQueueState(serverName) {
  const serverConfig = config[serverName];
  if (!serverConfig) {
    log.warn(`No config for server ${serverName}`);
    return { ok: false, state: null, reason: 'No server configuration is loaded' };
  }
  const url = serverConfig.status_url ||
              `http://${serverConfig.host}:${serverConfig.httpPort}/queue_state`;
  if (serverConfig.server_type === 'tiled') {
    const result = await ipcRenderer.invoke('tiled-ping', serverName);
    return {
      ok: !!result?.ok,
      state: result?.state || null,
      url: result?.url || url,
      reason: result?.reason || null
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetchFn(url, { signal: controller.signal });
    if (!response.ok) {
      const reason = `HTTP ${response.status} from ${url}`;
      log.debug(`${serverName}: ${reason}`);
      return { ok: false, state: null, url, reason };
    }
    if (serverConfig.device) {
      return { ok: true, state: null, url };
    }
    let state;
    try {
      const body = (await response.text()).trim();
      // Health endpoints such as Tiled's return JSON (for example
      // {"status":"ready"}), while AFL queue_state returns a plain string.
      // Normalize both to the same state value so health JSON does not leave
      // the server tab red or render as a raw JSON blob in the UI.
      try {
        const parsed = JSON.parse(body);
        state = typeof parsed?.status === 'string' ? parsed.status : body;
      } catch (_) {
        state = body;
      }
    } catch (_) {
      state = null;
    }
    log.debug(`${serverName}: Queue state = ${state || '(none)'}`);
    return { ok: true, state, url };
  } catch (err) {
    const reason = err?.name === 'AbortError'
      ? `Timed out reaching ${url}`
      : `Cannot reach ${url}: ${err?.message || 'connection failed'}`;
    log.debug(`${serverName}: ${reason}`);
    return { ok: false, state: null, url, reason };
  } finally {
    clearTimeout(timer);
  }
}

async function updateServerStatus(serverName) {
  try {
    // For individual status updates (e.g. after server control operations),
    // we still use direct status check
    const result = await ipcRenderer.invoke('get-server-status', serverName);
    const queueResult = await fetchQueueState(serverName);

    // Stop can be clicked while either request is in flight. Do not let that
    // stale response repaint a disconnected server as active.
    if (!startedServers.has(serverName)) return;
    updateServerStatusUI(serverName, result, queueResult);
  } catch (error) {
    log.error(`Error getting status for ${serverName}:`, error.message);
  }
}

// Update the UI with status information
function updateServerStatusUI(serverName, screenResult, queueResult) {
  const screenStatusElement = document.getElementById(`${serverName}-screen-status`);
  const httpStatusElement = document.getElementById(`${serverName}-http-status`);
  const sshConnected = screenResult.success &&
    !screenResult.sshDown &&
    !screenResult.authenticationRequired;
  const serverStatus = serverActivityPresentation(queueResult);
  
  if (screenStatusElement) {
    screenStatusElement.textContent = sshConnected ? 'SSH UP' : 'SSH DOWN';
    screenStatusElement.className = `status-indicator ${sshConnected ? 'status-up' : 'status-down'}`;
    if (screenResult.authenticationRequired) {
      screenStatusElement.title = 'Click Start and enter the NAS SSH password to enable management and status checks.';
    } else if (screenResult.managementType === 'docker_compose') {
      screenStatusElement.title = screenResult.status
        ? 'SSH is connected and the configured Docker Compose service is running.'
        : 'SSH is connected, but the configured Docker Compose service is not running.';
    } else if (screenResult.external || config[serverName]?.external_service) {
      screenStatusElement.title = 'This service is monitored by Andon but managed outside Andon.';
    } else if (screenResult.sshDown) {
      screenStatusElement.title = 'Andon could not establish the SSH connection.';
    } else if (screenResult.screenState === 'dead') {
      screenStatusElement.title = 'SSH is connected, but the Screen session has exited; view the server log for the cause.';
    } else {
      screenStatusElement.title = screenResult.status
        ? 'SSH is connected and the Screen session is active.'
        : (sshConnected ? 'SSH is connected, but no live Screen session was found.' : 'SSH is disconnected.');
    }
  }
  
  if (httpStatusElement) {
    httpStatusElement.textContent = serverStatus.label;
    httpStatusElement.className = `status-indicator ${serverStatus.cardClass}`;
    httpStatusElement.title = serverStatus.state === 'down'
      ? (queueResult?.reason || 'The server HTTP API is not reachable.')
      : '';
  }

  updateTabStatus(serverName, queueResult, screenResult);
  logServerStatusChange(serverName, sshConnected, serverStatus.state);
}

function logServerStatusChange(serverName, sshConnected, serverState) {
  const status = `${sshConnected ? 'SSH UP' : 'SSH DOWN'}, SERVER ${serverState.toUpperCase()}`;
  if (displayedServerStatuses.get(serverName) === status) return;
  displayedServerStatuses.set(serverName, status);
  log.info(`${serverName}: status changed to ${status}`);
}

function showServerDownStatus(serverName, disconnected = false) {
  const screenStatusElement = document.getElementById(`${serverName}-screen-status`);
  const httpStatusElement = document.getElementById(`${serverName}-http-status`);
  if (screenStatusElement) {
    screenStatusElement.textContent = 'SSH DOWN';
    screenStatusElement.className = 'status-indicator status-down';
    screenStatusElement.title = disconnected
      ? 'Andon is disconnected; the remote container was not changed.'
      : '';
  }
  if (httpStatusElement) {
    httpStatusElement.textContent = 'SERVER DOWN';
    httpStatusElement.className = 'status-indicator status-down';
    httpStatusElement.title = disconnected
      ? 'Andon is no longer polling this server.'
      : '';
  }
  updateTabStatus(serverName, { ok: false }, { status: false });
  logServerStatusChange(serverName, false, 'down');
}

// Batch update server statuses by host
async function batchUpdateServerStatuses() {
  try {
    // Get servers grouped by host, keeping only servers started by this
    // Andon session. This avoids probing launchers that have not been started.
    const allByHost   = await ipcRenderer.invoke('get-servers-by-host');
    const startedByHost = {};

    const externalServers = [...startedServers].filter(name => config[name]?.external_service);
    await Promise.all(externalServers.map(name => updateServerStatus(name)));

    for (const [host, names] of Object.entries(allByHost)) {
      const startedNames = names.filter(name => startedServers.has(name));
      if (startedNames.length) startedByHost[host] = startedNames;
    }
    if (Object.keys(startedByHost).length === 0) return;

    await Promise.all(
      Object.entries(startedByHost).map(async ([host, servers]) => {
        const batchResult = await ipcRenderer.invoke(
          'get-batch-server-status',
          host
        );

        if (!batchResult.success) {
          // If SSH is down for this host, update all servers on this host
          log.debug(`SSH down for host ${host}, marking all servers as down`);
          servers.forEach(serverName => {
            updateServerStatusUI(serverName, { sshDown: true }, false);
          });
          return;
        }

        // For each server on this host, update its status based on the batch result
        const sessions = batchResult.sessions;

        await Promise.all(
          servers.map(async serverName => {
            if (!startedServers.has(serverName)) return;
            const serverConfig = config[serverName];
            if (!serverConfig) {
              log.warn(`No config for server ${serverName}`);
              return;
            }
            const screenStatus = {
              success: true,
              status: sessions.includes(serverConfig.screen_name),
              sshDown: false,
              screenState: batchResult.sessionDetails?.find(
                session => session.name === serverConfig.screen_name
              )?.state || 'missing'
            };

            // Fetch queue state for each server individually
            let queueResult;
            try {
              queueResult = await fetchQueueState(serverName);
            } catch (err) {
              log.error(`Error fetching queue state for ${serverName}:`, err.message);
              queueResult = { ok: false, state: null };
            }

            // Update the UI
            if (startedServers.has(serverName)) {
              updateServerStatusUI(serverName, screenStatus, queueResult);
            }
          })
        );
      })
    );
  } catch (error) {
    log.error('Error in batch status update:', error.message);
  }
}

async function controlServer(serverName, action) {
  log.info(`Controlling server ${serverName}: ${action}`);
  const disconnectOnly = action === 'stop' &&
    config?.[serverName]?.tiled_management?.type === 'docker_compose';
  const wasStarted = startedServers.has(serverName);
  try {
    if (!disconnectOnly && !await ensureSshPassword(serverName, action === 'start' || action === 'restart')) return;
    if (action === 'stop') {
      startedServers.delete(serverName);
    }
    showServerDownStatus(serverName, disconnectOnly);
    const result = await ipcRenderer.invoke(`${action}-server`, serverName);
    if (result.success) {
      log.info(`${action} successful for ${serverName}`);
    } else if (result.authenticationRequired) {
      log.warn(`SSH authentication is required for ${serverName}`);
      alert(`SSH authentication failed for ${serverName}. Click Start and enter the password again.`);
    } else if (result.sshDown) {
      log.warn(`SSH is down for ${serverName}`);
    } else {
      log.error(`${action} failed for ${serverName}:`, result.error || 'Unknown error');
    }
    if (result.success && (action === 'start' || action === 'restart')) {
      const stream = await ipcRenderer.invoke('activate-server-log-stream', serverName);
      handleServerLogStream({
        serverName,
        type: 'status',
        status: stream.success ? stream.status : 'failed',
        error: stream.error || '',
        reset: true,
        observedAt: Date.now()
      });
      for (const chunk of stream.chunks || []) {
        handleServerLogStream({ serverName, type: 'data', ...chunk });
      }
      const startupRemainder = logChunkRemainders.get(serverName) || '';
      if (startupRemainder && !isRoutineHealthLog(serverName, config?.[serverName], startupRemainder)) {
        addMergedLogEntries([{
          server: serverName,
          text: startupRemainder,
          observedAt: Date.now(),
          type: 'log'
        }]);
        logChunkRemainders.delete(serverName);
        scheduleAllLogsRender();
      }
      startedServers.add(serverName);
      const logState = ensureAllLogServer(serverName);
      logState.lifecycle = 'running';
      renderAllLogFilters();
      await updateServerStatus(serverName);
      updateAllLogsStreamSummary();
    }
    if (result.success && action === 'stop') {
      showServerDownStatus(serverName, disconnectOnly);
      disconnectServerWebview(serverName);
      if (currentServerName === serverName) {
        document.getElementById('terminal-modal').style.display = 'none';
        currentServerName = null;
      }
      const logState = allLogServers.get(serverName);
      if (logState) {
        logState.lifecycle = 'stopped';
        logState.connection = 'stopped';
      }
      renderAllLogFilters();
      renderAllLogs();
      updateAllLogsStreamSummary();
    } else if (!result.success && action === 'stop') {
      if (wasStarted) {
        startedServers.add(serverName);
        await updateServerStatus(serverName);
      }
    }
  } catch (error) {
    log.error(`Error during ${action} for ${serverName}:`, error.message);
    if (action === 'stop') {
      if (wasStarted) {
        startedServers.add(serverName);
        await updateServerStatus(serverName);
      }
    }
  }
}


async function viewServerLog(serverName) {
  log.info(`Viewing log for ${serverName}`);
  try {
    if (!await ensureSshPassword(serverName)) return;
    const result = await ipcRenderer.invoke('get-server-log', serverName, 200); // Request 200 lines
    if (result.success) {
      log.debug(`Retrieved log for ${serverName}: ${result.output?.length || 0} bytes`);
      const logModal = document.getElementById('log-modal');
      const logContent = document.getElementById('log-content');
      const logTitle = document.getElementById('log-title');

      logTitle.textContent = `Server Log: ${serverName}`;
      logContent.textContent = result.output;

      // Show the modal
      logModal.style.display = 'block';

      // Scroll to the bottom
      logContent.scrollTop = logContent.scrollHeight;
    } else if (result.authenticationRequired) {
      alert(`SSH authentication is required for ${serverName}.`);
    } else if (result.sshDown) {
      log.warn(`SSH is down for ${serverName}`);
      alert(`Unable to get log: SSH is down for ${serverName}`);
    } else {
      log.error(`Failed to get log for ${serverName}`);
      alert(`Failed to get log for ${serverName}`);
    }
  } catch (error) {
    log.error(`Error getting log for ${serverName}:`, error.message);
  }
}

// Function to close the log modal
function closeLogModal() {
  log.debug('Closing log modal');
  const logModal = document.getElementById('log-modal');
  logModal.style.display = 'none';
}

function createServerTabs() {
  log.debug('Creating server tabs');
  const tabList = document.getElementById('tab-list');
  tabList.innerHTML = '';
  const andonLi = document.createElement('li');
  andonLi.className = 'tab-item';
  andonLi.dataset.server = 'andon';
  const andonIcon = document.createElement('div');
  andonIcon.className = 'tab-icon status-white';
  andonIcon.textContent = '🚥';
  andonLi.appendChild(andonIcon);
  andonLi.onclick = openAndonPanel;
  tabList.appendChild(andonLi);

  const logsLi = document.createElement('li');
  logsLi.className = 'tab-item';
  logsLi.id = 'all-logs-tab';
  logsLi.dataset.server = 'all-logs';
  logsLi.title = 'All Logs';
  const logsIcon = document.createElement('div');
  logsIcon.className = 'tab-icon';
  logsIcon.textContent = '≣';
  logsLi.appendChild(logsIcon);
  logsLi.onclick = () => setActiveTab('all-logs');
  tabList.appendChild(logsLi);
  
  let activeCount = 0;
  Object.keys(config).forEach(serverName => {
    const serverConfig = config[serverName];
    if (!serverConfig.active) return; // skip disabled servers
    activeCount++;
    const li = document.createElement('li');
    li.className = 'tab-item';
    li.dataset.server = serverName;
    const icon = document.createElement('div');
    icon.className = 'tab-icon status-red';
    icon.textContent = serverConfig.icon || serverName.charAt(0).toUpperCase();
    li.appendChild(icon);
    li.dataset.status = 'down';
    li.title = `${serverName}: DOWN`;
    li.setAttribute('aria-label', `${serverName}: down`);
    li.onclick = () => openServerWebview(serverName);
    tabList.appendChild(li);
  });
  
  const settingsLi = document.createElement('li');
  settingsLi.className = 'tab-item';
  settingsLi.id = 'settings-tab';
  settingsLi.dataset.server = 'settings';
  const settingsIcon = document.createElement('div');
  settingsIcon.className = 'tab-icon status-white';
  settingsIcon.textContent = '⚙️';
  settingsLi.appendChild(settingsIcon);
  settingsLi.onclick = openSettingsPanel;
  tabList.appendChild(settingsLi);
  
  log.debug(`Created tabs for ${activeCount} active servers`);
}

function updateTabStatus(serverName, queueResult, screenResult = {}) {
  const tab = document.querySelector(`.tab-item[data-server="${serverName}"] .tab-icon`);
  if (!tab) return;
  tab.classList.remove('status-green','status-yellow','status-red');
  const presentation = serverActivityPresentation(queueResult);
  tab.classList.add(presentation.sidebarClass);
  const button = tab.closest('.tab-item');
  if (button) {
    button.dataset.status = presentation.state;
    button.title = `${serverName}: ${presentation.state.toUpperCase()}`;
    button.setAttribute('aria-label', `${serverName}: ${presentation.state}`);
  }
}

function setActiveTab(name) {
  const wasAllLogs = activeTab === 'all-logs';
  activeTab = name;
  log.debug(`Setting active tab: ${name}`);
  document.querySelectorAll('.tab-item').forEach(item => item.classList.remove('selected'));
  const tab = document.querySelector(`.tab-item[data-server="${name}"]`);
  if (tab) tab.classList.add('selected');
  const andon = document.getElementById('andon-panel');
  const webviewContainer = document.getElementById('webview-container');
  const settings = document.getElementById('settings-panel');
  const allLogs = document.getElementById('all-logs-panel');
  if (name === 'andon') {
    webviewContainer.style.display = 'none';
    settings.style.display = 'none';
    allLogs.style.display = 'none';
    andon.style.display = 'block';
  } else if (name === 'settings') {
    andon.style.display = 'none';
    webviewContainer.style.display = 'none';
    allLogs.style.display = 'none';
    settings.style.display = 'block';
  } else if (name === 'all-logs') {
    andon.style.display = 'none';
    webviewContainer.style.display = 'none';
    settings.style.display = 'none';
    allLogs.style.display = 'flex';
  } else {
    andon.style.display = 'none';
    settings.style.display = 'none';
    allLogs.style.display = 'none';
    webviewContainer.style.display = 'flex';
  }
  if (name === 'all-logs' && !wasAllLogs) {
    allLogsPaused = false;
    const pauseButton = document.getElementById('all-logs-pause');
    if (pauseButton) pauseButton.textContent = 'Pause';
    showAllLogsPanel();
    startAllLogsSync();
  }
  if (name !== 'all-logs' && wasAllLogs) {
    clearTimeout(allLogsRenderTimer);
    allLogsRenderTimer = null;
    stopAllLogsSync();
  }
}

function openAndonPanel() {
  log.debug('Opening Andon panel');
  // Keep the webview loaded while it is hidden. Clearing src while a page is
  // loading makes Electron reject GUEST_VIEW_MANAGER_CALL with ERR_ABORTED.
  setActiveTab('andon');
}

function openServerWebview(serverName) {
  const tabIcon = document.querySelector(
    `.tab-item[data-server="${serverName}"] .tab-icon`
  );
  if (tabIcon && tabIcon.classList.contains('status-red')) {
    log.debug(`Server ${serverName} is down, not opening webview`);
    return; // server down - don't change tabs
  }
  log.info(`Opening webview for server: ${serverName}`);
  const serverConfig = config[serverName];
  setActiveTab(serverName);
  const webview = document.getElementById('server-webview');
  loadedWebviewServerName = serverName;
  if (serverConfig.server_type === 'tiled' || String(serverName).trim().toLowerCase() === 'tiled') {
    const browserUrl = pathToFileURL(path.join(__dirname, 'tiled', 'browser', 'index.html'));
    browserUrl.searchParams.set('server', serverName);
    log.debug(`Loading bundled Tiled browser: ${browserUrl}`);
    const url = browserUrl.toString();
    if (webview.getAttribute('src') !== url) webview.src = url;
    activeTab = serverName;
    return;
  }
  const url = serverConfig.webview_url ||
              `http://${serverConfig.host}:${serverConfig.httpPort}/`;
  log.debug(`Loading URL: ${url}`);
  if (webview.getAttribute('src') !== url) webview.src = url;
  activeTab = serverName;
}

function disconnectServerWebview(serverName) {
  if (loadedWebviewServerName !== serverName) return;
  const webview = document.getElementById('server-webview');
  webview.stop?.();
  webview.src = 'about:blank';
  loadedWebviewServerName = null;
  if (activeTab === serverName) openAndonPanel();
}

function closeServerWebview() {
  log.debug('Closing server webview');
  openAndonPanel();
}

async function openSettingsPanel() {
  log.debug('Opening settings panel');
  populateAflHostSelect();
  await loadAflConfig();
  setActiveTab('settings');
}


function createServerControls(serverName) {
  const serverConfig = config[serverName];
  const container = document.createElement('div');
  container.className = 'server-container';
  
  const headerElement = document.createElement('div');
  headerElement.className = 'server-header';

  const nameElement = document.createElement('div');
  nameElement.className = 'server-name';
  nameElement.textContent = serverName;
  headerElement.appendChild(nameElement);

  const actionsElement = document.createElement('div');
  actionsElement.className = 'server-actions';

  const editButton = document.createElement('button');
  editButton.textContent = 'Edit';
  editButton.className = 'edit-btn';
  editButton.onclick = () => openServerModal(serverName);
  actionsElement.appendChild(editButton);

  const toggleActiveButton = document.createElement('button');
  toggleActiveButton.textContent = serverConfig.active ? 'Deactivate' : 'Activate';
  toggleActiveButton.className = 'toggle-active-btn';
  toggleActiveButton.onclick = () => toggleServerActive(serverName);
  actionsElement.appendChild(toggleActiveButton);

  headerElement.appendChild(actionsElement);
  container.appendChild(headerElement);

  const infoElement = document.createElement('div');
  infoElement.className = 'server-info';
  infoElement.textContent = `SSH: ${serverConfig.username}@${serverConfig.host}, HTTP: ${serverConfig.host}:${serverConfig.httpPort}`;
  container.appendChild(infoElement);

  const statusContainer = document.createElement('div');
  statusContainer.className = 'status-indicators';

  const screenStatusElement = document.createElement('span');
  screenStatusElement.id = `${serverName}-screen-status`;
  screenStatusElement.textContent = 'SSH DOWN';
  screenStatusElement.className = 'status-indicator status-down';
  statusContainer.appendChild(screenStatusElement);

  const httpStatusElement = document.createElement('span');
  httpStatusElement.id = `${serverName}-http-status`;
  httpStatusElement.textContent = 'SERVER DOWN';
  httpStatusElement.className = 'status-indicator status-down';
  statusContainer.appendChild(httpStatusElement);

  container.appendChild(statusContainer);

  const controlsContainer = document.createElement('div');
  controlsContainer.className = 'controls';

  ['start', 'stop', 'restart'].forEach(action => {
    const button = document.createElement('button');
    button.textContent = action.charAt(0).toUpperCase() + action.slice(1);
    button.className = `${action}-btn`;
    button.onclick = () => controlServer(serverName, action);
    controlsContainer.appendChild(button);
  });

  const logButton = document.createElement('button');
  logButton.textContent = 'View Log';
  logButton.className = 'log-btn';
  logButton.onclick = () => viewServerLog(serverName);
  controlsContainer.appendChild(logButton);

  const joinButton = document.createElement('button');
  joinButton.textContent = 'Join';
  joinButton.className = 'join-btn';
  joinButton.onclick = () => joinServer(serverName);
  controlsContainer.appendChild(joinButton);

  container.appendChild(controlsContainer);

  return container;
}


function openServerModal(serverName = null) {
  log.debug(`Opening server modal for: ${serverName || 'new server'}`);
  const modal = document.getElementById('server-modal');
  const modalTitle = document.getElementById('modal-title');
  const form = document.getElementById('server-form');

  editingServer = serverName;

  if (serverName) {
    modalTitle.textContent = 'Edit Server';
    const server = config[serverName];
    form.elements['server-name'].value = serverName;
    form.elements['server-host'].value = server.host;
    form.elements['server-username'].value = server.username;
    form.elements['server-http-port'].value = server.httpPort;
    form.elements['server-screen-name'].value = server.screen_name;
    form.elements['server-type'].value = server.server_type === 'tiled'
      ? 'tiled'
      : (server.server_script ? 'script' : 'module');
    form.elements['server-script'].value = server.server_script || '';
    form.elements['server-module'].value = server.server_module || '';
    form.elements['server-config-file-location'].value = server.config_file_location || '';
    form.elements['server-shell'].value = server.shell || 'bash';
    form.elements['server-env-type'].value = server.env_type || (server.conda_env ? 'conda' : 'pip');
    form.elements['server-conda-env'].value = server.conda_env || '';
    form.elements['server-virtualenv-path'].value = server.virtualenv_path || '';
    form.elements['server-device'].checked = !!server.device;
    form.elements['server-status-url'].value = server.status_url || '';
    form.elements['server-webview-url'].value = server.webview_url || '';
    form.elements['server-active'].checked = server.active;
    form.elements['server-name'].disabled = true;
  } else {
    modalTitle.textContent = 'Add New Server';
    form.reset();
    form.elements['server-name'].disabled = false;
    form.elements['server-type'].value = 'script';
    form.elements['server-shell'].value = 'bash';
    form.elements['server-device'].checked = false;
    form.elements['server-status-url'].value = '';
    form.elements['server-webview-url'].value = '';
    form.elements['server-config-file-location'].value = '';
    form.elements['server-active'].checked = true;
    form.elements['server-env-type'].value = 'conda';
  }

  updateServerTypeFields();
  updateEnvTypeFields();
  modal.style.display = 'block';
}

function updateServerTypeFields() {
  const serverType = document.getElementById('server-type').value;
  document.getElementById('script-group').style.display = serverType === 'script' ? 'block' : 'none';
  document.getElementById('module-group').style.display = serverType === 'module' ? 'block' : 'none';
  const configInput = document.getElementById('server-config-file-location');
  const isTiled = serverType === 'tiled';
  configInput.required = isTiled;
  configInput.placeholder = isTiled ? '/path/to/tiled_config.yml' : '/path/to/server-config.json';
  document.getElementById('server-shell').closest('.form-group').style.display = isTiled ? 'none' : 'block';
  document.getElementById('server-env-type').closest('.form-group').style.display = 'block';
  document.getElementById('conda-group').style.display = document.getElementById('server-env-type').value === 'conda' ? 'block' : 'none';
  document.getElementById('virtualenv-group').style.display = document.getElementById('server-env-type').value === 'pip' ? 'block' : 'none';
}

function updateEnvTypeFields() {
  const envType = document.getElementById('server-env-type').value;
  document.getElementById('conda-group').style.display = envType === 'conda' ? 'block' : 'none';
  document.getElementById('virtualenv-group').style.display = envType === 'pip' ? 'block' : 'none';
}

async function handleServerFormSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const serverName = form.elements['server-name'].value;
  log.info(`Submitting server form for: ${serverName}`);
  
  const serverConfig = {
    host: form.elements['server-host'].value,
    username: form.elements['server-username'].value,
    httpPort: parseInt(form.elements['server-http-port'].value, 10),
    screen_name: form.elements['server-screen-name'].value,
    shell: form.elements['server-shell'].value,
    active: form.elements['server-active'].checked,
    device: form.elements['server-device'].checked
  };

  const serverType = form.elements['server-type'].value;
  if (serverType === 'tiled') {
    serverConfig.server_type = 'tiled';
    serverConfig.shell = 'bash';
  } else if (serverType === 'script') {
    serverConfig.server_script = form.elements['server-script'].value;
  } else {
    serverConfig.server_module = form.elements['server-module'].value;
  }

  // Keep an empty value so an edit can explicitly clear a prior selection.
  serverConfig.config_file_location = form.elements['server-config-file-location'].value.trim();

  const envType = form.elements['server-env-type'].value;
  serverConfig.env_type = envType;

  if (envType === 'conda') {
    const condaEnv = form.elements['server-conda-env'].value;
    if (condaEnv) {
      serverConfig.conda_env = condaEnv;
    }
  } else if (envType === 'pip') {
    const venvPath = form.elements['server-virtualenv-path'].value;
    if (venvPath) {
      serverConfig.virtualenv_path = venvPath;
    }
  }

  const statusUrl = form.elements['server-status-url'].value;
  if (statusUrl) {
    serverConfig.status_url = statusUrl;
  }
  const webviewUrl = form.elements['server-webview-url'].value;
  if (webviewUrl) {
    serverConfig.webview_url = webviewUrl;
  }

  if (editingServer) {
    await updateServer(editingServer, serverConfig);
  } else {
    await addServer(serverName, serverConfig);
  }

  closeServerModal();
}

function closeServerModal() {
  log.debug('Closing server modal');
  const modal = document.getElementById('server-modal');
  modal.style.display = 'none';
  editingServer = null;
}

async function addServer(serverName, serverConfig) {
  log.info(`Adding new server: ${serverName}`);
  await ipcRenderer.invoke('add-server', { serverName, serverConfig });
  await loadConfig();
  renderServers();
  ipcRenderer.on('server-log-stream', (_event, payload) => receiveServerLogEvent(payload));
}

 async function updateServer(serverName, serverConfig) {
  log.info(`Updating server: ${serverName}`);
  let tabElement = document.querySelector(`.tab-item[data-server="${activeTab}"]`);
  if (!tabElement) {
    activeTab = 'andon';
    setActiveTab(activeTab);
  }
  await ipcRenderer.invoke('update-server', { serverName, serverConfig });
  await loadConfig();
  renderServers();
}

async function removeServer(serverName) {
  log.info(`Removing server: ${serverName}`);
  await ipcRenderer.invoke('remove-server', serverName);
  await loadConfig();
  renderServers();
}

async function toggleServerActive(serverName) {
  log.info(`Toggling active state for: ${serverName}`);
  await ipcRenderer.invoke('toggle-server-active', serverName);
  await loadConfig();
  renderServers();
}

function renderServers() {
  log.debug('Rendering servers');
  const appContainer = document.getElementById('app');

  // Clear existing content
  appContainer.innerHTML = '';
  createServerTabs();
  setActiveTab(activeTab || 'andon');

  // Sort servers: active first, then alphabetically
  const sortedServers = Object.keys(config).sort((a, b) => {
    if (config[a].active === config[b].active) {
      return a.localeCompare(b);
    }
    return config[b].active - config[a].active;
  });

  // Render active servers
  let activeCount = 0;
  sortedServers.forEach(serverName => {
    if (config[serverName].active) {
      activeCount++;
      const serverControls = createServerControls(serverName);
      appContainer.appendChild(serverControls);
    }
  });

  // Always create the inactive servers section
  const inactiveServers = sortedServers.filter(name => !config[name].active);
  
  const inactiveHeader = document.createElement('div');
  inactiveHeader.id = 'inactive-servers-header';
  inactiveHeader.className = 'inactive-servers-header';
  inactiveHeader.innerHTML = `<span class="arrow">${inactiveExpanded ? '▼' : '▶'}</span> Inactive Servers (${inactiveServers.length})`;
  appContainer.appendChild(inactiveHeader);

  const inactiveContent = document.createElement('div');
  inactiveContent.id = 'inactive-servers-content';
  inactiveContent.style.display = inactiveExpanded ? 'grid' : 'none';
  appContainer.appendChild(inactiveContent);

  inactiveServers.forEach(serverName => {
    const serverControls = createServerControls(serverName);
    inactiveContent.appendChild(serverControls);
  });

  log.info(`Rendered ${activeCount} active servers, ${inactiveServers.length} inactive`);

}

// Function to toggle inactive servers visibility
function toggleInactiveServers() {
  const content = document.getElementById('inactive-servers-content');
  const arrow = document.querySelector('#inactive-servers-header .arrow');
  inactiveExpanded = !inactiveExpanded;
  log.debug(`Inactive servers section ${inactiveExpanded ? 'expanded' : 'collapsed'}`);
  if (inactiveExpanded) {
    content.style.display = 'grid';
    arrow.textContent = '▼';
  } else {
    content.style.display = 'none';
    arrow.textContent = '▶';
  }
}

async function importConfig() {
  log.info('Importing configuration');
  try {
    const result = await ipcRenderer.invoke('import-config');
    if (result.success) {
      log.info('Configuration imported successfully');
      alert(result.message);
      await loadConfig();
      renderServers();
    } else {
      log.warn('Configuration import failed:', result.message || result.error);
      alert(result.message || result.error);
    }
  } catch (error) {
    log.error('Error importing config:', error.message);
    alert('Failed to import config file.');
  }
}

async function importSSHKey() {
  log.info('Importing SSH key');
  try {
    const result = await ipcRenderer.invoke('import-ssh-key');
    if (result.success) {
      log.info('SSH key imported successfully');
      alert(result.message);
    } else {
      log.warn('SSH key import failed:', result.message || result.error);
      alert(result.message || result.error);
    }
  } catch (error) {
    log.error('Error importing SSH key:', error.message);
    alert('Failed to import SSH key.');
  }
}

async function loadPaths() {
  log.debug('Loading paths');
  const paths = await ipcRenderer.invoke('get-paths');
  document.getElementById('config-path').textContent = paths.configPath;
  document.getElementById('ssh-key-path').textContent = paths.sshKeyPath;
  log.debug(`Config path: ${paths.configPath}, SSH key path: ${paths.sshKeyPath}`);
}

async function setConfigPath() {
  log.debug('Opening config path dialog');
  const result = await ipcRenderer.invoke('show-open-dialog', {
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (!result.canceled) {
    const newPath = result.filePaths[0];
    log.info(`Setting config path to: ${newPath}`);
    await ipcRenderer.invoke('set-config-path', newPath);
    loadPaths();
    renderServers();  // Reload the server list with the new configuration
  }
}

async function saveConfig() {
  log.info('Saving configuration');
  const result = await ipcRenderer.invoke('save-config');
  if (result.success) {
    log.info('Configuration saved successfully');
    alert('Configuration saved successfully');
  } else {
    log.error('Failed to save configuration:', result.error);
    alert('Failed to save configuration: ' + result.error);
  }
}

async function setSshKeyPath() {
  log.debug('Opening SSH key path dialog');
  const result = await ipcRenderer.invoke('show-open-dialog', {
    properties: ['openFile']
  });
  if (!result.canceled) {
    const newPath = result.filePaths[0];
    log.info(`Setting SSH key path to: ${newPath}`);
    await ipcRenderer.invoke('set-ssh-key-path', newPath);
    loadPaths();
  }
}

// Wait for the DOM to be fully loaded before creating UI elements
document.addEventListener('DOMContentLoaded', async () => {
  log.info('DOM content loaded, initializing UI');
  
  await loadPaths();  // Load paths first
  await loadConfig();
  renderServers();

  // The preload exposes only read-only, Tiled-specific IPC calls. It is used
  // by the bundled Tiled page; ordinary server webviews do not call it.
  const webview = document.getElementById('server-webview');
  webview.setAttribute('preload', pathToFileURL(path.join(__dirname, 'tiled-webview-preload.js')).toString());

  // Set up event listeners
  document.getElementById('add-server-btn').addEventListener('click', () => openServerModal());
  document.querySelector('.modal .close').addEventListener('click', closeServerModal);
  document.getElementById('server-form').addEventListener('submit', handleServerFormSubmit);
  // document.getElementById('import-config-btn').addEventListener('click', importConfig);
  // document.getElementById('import-ssh-key-btn').addEventListener('click', importSSHKey);
  document.getElementById('server-type').addEventListener('change', updateServerTypeFields);
  document.getElementById('server-env-type').addEventListener('change', updateEnvTypeFields);
  document.getElementById('set-config-path-btn').addEventListener('click', setConfigPath);
  document.getElementById('save-config-btn').addEventListener('click', saveConfig);
  document.getElementById('set-ssh-key-path-btn').addEventListener('click', setSshKeyPath);
  const saveAflBtn = document.getElementById('save-afl-config-btn');
  if (saveAflBtn) {
    saveAflBtn.addEventListener('click', saveAflConfig);
  }

  document.getElementById('webview-back').addEventListener('click', () => {
    const wv = document.getElementById('server-webview');
    if (wv.canGoBack()) wv.goBack();
  });
  document.getElementById('webview-forward').addEventListener('click', () => {
    const wv = document.getElementById('server-webview');
    if (wv.canGoForward()) wv.goForward();
  });
  document.getElementById('webview-refresh').addEventListener('click', () => {
    document.getElementById('server-webview').reload();
  });

  document.querySelector('.close-log').addEventListener('click', closeLogModal);
  document.getElementById('ssh-password-form').addEventListener('submit', event => {
    event.preventDefault();
    finishSshPasswordPrompt(document.getElementById('ssh-password-input').value);
  });
  document.querySelector('.close-ssh-password').addEventListener('click', () => finishSshPasswordPrompt());
  document.getElementById('ssh-password-cancel').addEventListener('click', () => finishSshPasswordPrompt());

  document.getElementById('all-logs-search').addEventListener('input', renderAllLogs);
  document.getElementById('all-logs-pause').addEventListener('click', () => {
    allLogsPaused = !allLogsPaused;
    document.getElementById('all-logs-pause').textContent = allLogsPaused ? 'Resume' : 'Pause';
    if (allLogsPaused) {
      clearTimeout(allLogsRenderTimer);
      allLogsRenderTimer = null;
      updateAllLogsStreamSummary();
    } else {
      renderAllLogs();
      updateAllLogsStreamSummary();
    }
  });
  document.getElementById('all-logs-refresh').addEventListener('click', () => {
    renderAllLogs();
    updateAllLogsStreamSummary();
  });
  document.getElementById('all-logs-clear').addEventListener('click', () => {
    mergedLogEntries = [];
    renderAllLogs();
    updateAllLogsStatus(allLogsPaused ? 'Paused — history cleared' : 'History cleared');
  });
  document.getElementById('all-logs-autoscroll').addEventListener('change', event => {
    if (event.target.checked) {
      const output = document.getElementById('all-logs-output');
      output.scrollTop = output.scrollHeight;
    }
  });

  document.querySelector('.close-terminal').addEventListener('click', closeTerminalModal);

  document.addEventListener('click', (e) => {
    if (e.target.closest('#inactive-servers-header')) {
      toggleInactiveServers();
    }
  });

  window.onclick = function(event) {
    const termModal = document.getElementById('terminal-modal');

    const logModal = document.getElementById('log-modal');
    const passwordModal = document.getElementById('ssh-password-modal');
    if (event.target == logModal) {
      logModal.style.display = 'none';
    }
    if (event.target == passwordModal) {
      finishSshPasswordPrompt();
    }
    if (event.target == termModal) {
      closeTerminalModal();
    }
  }

  let statusJobRunning = false;

  log.info('Starting status update interval for Andon-started servers (500ms)');
  setInterval(async () => {
    if (statusJobRunning || !config || startedServers.size === 0) return;
    statusJobRunning = true;
    try {
      await batchUpdateServerStatuses();
    } finally {
      statusJobRunning = false;
    }
  }, 500);
  
  log.info('UI initialization complete');
});
