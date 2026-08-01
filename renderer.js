// renderer.js (Renderer process)
const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const JSONEditor = require('jsoneditor');
const { createLogger } = require('./logger');

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

log.info('Renderer process starting');

let config;
let editingServer = null;
let aflConfig = {};
let aflConfigEditor;
let selectedAflHost = null;

let sshStream;

let terminal;
let currentServerName;
let activeTab = null;
let inactiveExpanded = false;
const startedServers = new Set();

async function joinServer(serverName) {
  log.info(`Joining server: ${serverName}`);
  try {
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetchFn(url, { signal: controller.signal });
    if (!response.ok) {
      const reason = `HTTP ${response.status} from ${url}`;
      log.warn(`${serverName}: ${reason}`);
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
    log.warn(`${serverName}: ${reason}`);
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

    updateServerStatusUI(serverName, result, queueResult);
  } catch (error) {
    log.error(`Error getting status for ${serverName}:`, error.message);
  }
}

// Update the UI with status information
function updateServerStatusUI(serverName, screenResult, queueResult) {
  const screenStatusElement = document.getElementById(`${serverName}-screen-status`);
  const httpStatusElement = document.getElementById(`${serverName}-http-status`);
  
  if (screenStatusElement) {
    if (screenResult.sshDown) {
      screenStatusElement.textContent = 'SSH DOWN';
      screenStatusElement.className = 'status-indicator status-down';
    } else if (screenResult.screenState === 'dead') {
      screenStatusElement.textContent = 'SCREEN EXITED';
      screenStatusElement.className = 'status-indicator status-down';
      screenStatusElement.title = 'The screen session has exited; view the server log for the cause.';
    } else {
      screenStatusElement.textContent = screenResult.status ? 'SCREEN ACTIVE' : 'SCREEN DOWN';
      screenStatusElement.className = `status-indicator ${screenResult.status ? 'status-up' : 'status-down'}`;
      screenStatusElement.title = screenResult.status ? '' : 'No live screen session was found.';
    }
  }
  
  if (httpStatusElement) {
    if (queueResult.ok) {
      const serverCfg = config[serverName] || {};
      const state = typeof queueResult.state === 'string' ? queueResult.state.trim() : '';
      httpStatusElement.textContent = serverCfg.device || !state
        ? 'SERVER UP'
        : `SERVER ${state.toUpperCase()}`;
      httpStatusElement.className = 'status-indicator status-up';
    } else {
      httpStatusElement.textContent = 'UNREACHABLE';
      httpStatusElement.className = 'status-indicator status-down';
      httpStatusElement.title = '';
    }
  }

  updateTabStatus(serverName, queueResult);
}

function showServerDownStatus(serverName) {
  const screenStatusElement = document.getElementById(`${serverName}-screen-status`);
  const httpStatusElement = document.getElementById(`${serverName}-http-status`);
  if (screenStatusElement) {
    screenStatusElement.textContent = 'SCREEN DOWN';
    screenStatusElement.className = 'status-indicator status-down';
    screenStatusElement.title = '';
  }
  if (httpStatusElement) {
    httpStatusElement.textContent = 'SERVER DOWN';
    httpStatusElement.className = 'status-indicator status-down';
    httpStatusElement.title = '';
  }
}

// Batch update server statuses by host
async function batchUpdateServerStatuses() {
  try {
    // Get servers grouped by host, keeping only servers started by this
    // Andon session. This avoids probing launchers that have not been started.
    const allByHost   = await ipcRenderer.invoke('get-servers-by-host');
    const startedByHost = {};

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
          log.warn(`SSH down for host ${host}, marking all servers as down`);
          servers.forEach(serverName => {
            updateServerStatusUI(serverName, { sshDown: true }, false);
          });
          return;
        }

        // For each server on this host, update its status based on the batch result
        const sessions = batchResult.sessions;

        await Promise.all(
          servers.map(async serverName => {
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
            updateServerStatusUI(serverName, screenStatus, queueResult);
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
  showServerDownStatus(serverName);
  try {
    const result = await ipcRenderer.invoke(`${action}-server`, serverName);
    if (result.success) {
      log.info(`${action} successful for ${serverName}`);
    } else if (result.sshDown) {
      log.warn(`SSH is down for ${serverName}`);
    } else {
      log.error(`${action} failed for ${serverName}:`, result.error || 'Unknown error');
    }
    if (result.success && (action === 'start' || action === 'restart')) {
      startedServers.add(serverName);
      await updateServerStatus(serverName);
    }
    if (result.success && action === 'stop') startedServers.delete(serverName);
  } catch (error) {
    log.error(`Error during ${action} for ${serverName}:`, error.message);
  }
}


async function viewServerLog(serverName) {
  log.info(`Viewing log for ${serverName}`);
  try {
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
    li.title = serverName;
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

function updateTabStatus(serverName, queueResult) {
  const tab = document.querySelector(`.tab-item[data-server="${serverName}"] .tab-icon`);
  if (!tab) return;
  tab.classList.remove('status-green','status-blue','status-yellow','status-red');
  let cls = 'status-red';
  if (queueResult.ok) {
    const serverCfg = config[serverName] || {};
    if (serverCfg.device) {
      cls = 'status-green';
    } else {
      switch ((queueResult.state || '').toLowerCase()) {
        case 'paused':
          cls = 'status-yellow';
          break;
        case 'active':
          cls = 'status-blue';
          break;
        case 'ready':
          cls = 'status-green';
          break;
        default:
          cls = 'status-red';
      }
    }
  }
  tab.classList.add(cls);
}

function setActiveTab(name) {
  activeTab = name;
  log.debug(`Setting active tab: ${name}`);
  document.querySelectorAll('.tab-item').forEach(item => item.classList.remove('selected'));
  const tab = document.querySelector(`.tab-item[data-server="${name}"]`);
  if (tab) tab.classList.add('selected');
  const andon = document.getElementById('andon-panel');
  const webviewContainer = document.getElementById('webview-container');
  const settings = document.getElementById('settings-panel');
  if (name === 'andon') {
    webviewContainer.style.display = 'none';
    settings.style.display = 'none';
    andon.style.display = 'block';
  } else if (name === 'settings') {
    andon.style.display = 'none';
    webviewContainer.style.display = 'none';
    settings.style.display = 'block';
  } else {
    andon.style.display = 'none';
    settings.style.display = 'none';
    webviewContainer.style.display = 'flex';
  }
}

function openAndonPanel() {
  log.debug('Opening Andon panel');
  const webview = document.getElementById('server-webview');
  webview.src = '';
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
  const url = serverConfig.webview_url ||
              `http://${serverConfig.host}:${serverConfig.httpPort}/`;
  log.debug(`Loading URL: ${url}`);
  webview.src = url;
  activeTab = serverName;
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
  screenStatusElement.textContent = 'SCREEN DOWN';
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
    form.elements['server-type'].value = server.server_script ? 'script' : 'module';
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
  if (serverType === 'script') {
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

  document.querySelector('.close-terminal').addEventListener('click', closeTerminalModal);

  document.addEventListener('click', (e) => {
    if (e.target.closest('#inactive-servers-header')) {
      toggleInactiveServers();
    }
  });

  window.onclick = function(event) {
    const termModal = document.getElementById('terminal-modal');

    const logModal = document.getElementById('log-modal');
    if (event.target == logModal) {
      logModal.style.display = 'none';
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
