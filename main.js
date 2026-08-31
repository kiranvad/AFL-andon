// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { createLogger, logFilePath } = require('./logger');
const { CombinedLogWriter } = require('./combinedLog');
const log = createLogger('main');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const SSHOperations = require('./sshOperations');
const { isExpectedWebviewNavigationAbort } = require('./electronErrors');
const { loadTiledProfile } = require('./tiled/profile');

let mainWindow;
let sshOps;
// Track attempts, not only healthy launches. A detached `screen` can exist
// before the health check fails, and it must be stopped when Andon exits.
const andonManagedServers = new Set();
const sessionLogStreams = new Map();
const sessionLogEvents = [];
let sessionLogSequence = 0;
const combinedLogWriter = new CombinedLogWriter();
let shutdownPromise;
let shutdownComplete = false;
let fatalShutdownInProgress = false;
let closeConfirmationInProgress = false;
let allowWindowClose = false;
const tiledCatalogPathCache = new Map();
const andonConfigPath = path.join(os.homedir(), '.afl', 'configs', 'andon.config.json');

const ICON_PATH_MAC = path.join(__dirname, 'assets', 'icons', 'mac', 'icon.icns');
const ICON_PATH_PNG = path.join(__dirname, 'assets', 'icons', 'png', '256x256.png');

function getAppIconPath() {
  return process.platform === 'darwin' ? ICON_PATH_MAC : ICON_PATH_PNG;
}

function sendSessionLogEvent(entry, payload) {
  const message = { sequence: ++sessionLogSequence, serverName: entry.serverName, ...payload };
  sessionLogEvents.push(message);
  if (sessionLogEvents.length > 20000) sessionLogEvents.splice(0, sessionLogEvents.length - 20000);
  if (entry.owner && !entry.owner.isDestroyed()) {
    entry.owner.send('server-log-stream', message);
  }
}

function scheduleSessionLogReconnect(entry) {
  if (!entry.desired || entry.reconnectTimer) return;
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    openSessionLogStream(entry);
  }, 3000);
}

async function openSessionLogStream(entry) {
  if (!entry.desired || entry.connecting || entry.controller) return;
  entry.connecting = true;
  const generation = ++entry.generation;
  try {
    const controller = await sshOps.streamServerLog(entry.serverName, entry.startOffset, {
      onData(data) {
        if (!entry.desired || generation !== entry.generation) return;
        if (!entry.receivedData) {
          entry.receivedData = true;
          log.info(`Receiving session log stream for ${entry.serverName}`);
        }
        if (entry.active) {
          sendSessionLogEvent(entry, { type: 'data', data, observedAt: Date.now() });
        } else {
          entry.pending.push({ data, observedAt: Date.now() });
          entry.pendingSize += data.length;
          while (entry.pendingSize > 2_000_000 && entry.pending.length > 1) {
            entry.pendingSize -= entry.pending.shift().data.length;
          }
        }
      },
      onError(error) {
        const shouldNotify = entry.active && entry.lastStatus !== 'failed';
        entry.lastStatus = 'failed';
        entry.error = error.message;
        if (shouldNotify) {
          sendSessionLogEvent(entry, { type: 'status', status: 'failed', error: error.message });
        }
      },
      onClose(error) {
        if (!entry.desired || generation !== entry.generation) return;
        entry.startOffset = entry.controller?.offset ?? entry.startOffset;
        entry.controller = null;
        const shouldNotify = entry.active && entry.lastStatus !== 'failed';
        entry.lastStatus = 'failed';
        entry.error = error?.message || entry.error || 'SSH log stream closed';
        if (shouldNotify) {
          sendSessionLogEvent(entry, { type: 'status', status: 'failed', error: entry.error });
        }
        scheduleSessionLogReconnect(entry);
      }
    });
    if (!entry.desired || generation !== entry.generation) {
      controller.close();
      return;
    }
    entry.controller = controller;
    entry.startOffset = controller.offset;
    log.info(`Session log stream connected for ${entry.serverName} at byte ${entry.startOffset}`);
    entry.lastStatus = 'connected';
    entry.error = '';
    if (entry.active) {
      sendSessionLogEvent(entry, { type: 'status', status: 'connected' });
    }
  } catch (error) {
    if (entry.desired && generation === entry.generation) {
      entry.lastStatus = 'failed';
      entry.error = error.message;
      if (entry.active) {
        sendSessionLogEvent(entry, { type: 'status', status: 'failed', error: error.message });
      }
      scheduleSessionLogReconnect(entry);
    }
  } finally {
    entry.connecting = false;
  }
}

async function beginSessionLogStream(serverName, owner, startOffset) {
  stopSessionLogStream(serverName, false);
  const entry = {
    serverName,
    owner,
    desired: true,
    active: false,
    connecting: false,
    controller: null,
    reconnectTimer: null,
    generation: 0,
    pending: [],
    pendingSize: 0,
    lastStatus: 'connecting',
    error: '',
    startOffset,
    receivedData: false
  };
  sessionLogStreams.set(serverName, entry);
  await openSessionLogStream(entry);
}

function activateSessionLogStream(serverName, owner) {
  const entry = sessionLogStreams.get(serverName);
  if (!entry) return { success: false, error: 'No session log stream exists for this server' };
  if (entry.owner !== owner) return { success: false, error: 'Log stream belongs to another renderer' };
  entry.active = true;
  const result = {
    success: true,
    status: entry.controller ? 'connected' : 'failed',
    error: entry.controller ? '' : (entry.error || 'Connecting to log stream'),
    chunks: entry.pending
  };
  entry.pending = [];
  entry.pendingSize = 0;
  log.debug(`Activated session log stream for ${serverName} with ${result.chunks.length} buffered chunk(s)`);
  return result;
}

function stopSessionLogStream(serverName, notify = true) {
  const entry = sessionLogStreams.get(serverName);
  if (!entry) return;
  entry.desired = false;
  entry.generation += 1;
  clearTimeout(entry.reconnectTimer);
  entry.controller?.close();
  if (notify && entry.active) sendSessionLogEvent(entry, { type: 'status', status: 'stopped' });
  sessionLogStreams.delete(serverName);
}

function stopAllSessionLogStreams() {
  for (const serverName of [...sessionLogStreams.keys()]) stopSessionLogStream(serverName, false);
}

function isTiledLauncher(serverName) {
  const server = sshOps?.config?.[serverName];
  return server?.server_type === 'tiled' || String(serverName || '').trim().toLowerCase() === 'tiled';
}

async function getTiledLauncherProfile(serverName, options = {}) {
  const server = sshOps?.config?.[serverName];
  const configPath = server?.config_file_location?.trim();
  if (!configPath) return null;
  try {
    return await loadTiledProfile(configPath, options);
  } catch (error) {
    throw new Error(`Could not read the Tiled profile ${configPath}: ${error.message}`);
  }
}

async function getTiledBaseUrl(serverName) {
  if (!isTiledLauncher(serverName)) {
    throw new Error('Tiled browser access is only available for the Tiled launcher.');
  }
  const server = sshOps?.config?.[serverName];
  if (!server) throw new Error('The Tiled launcher is not configured.');

  const profile = await getTiledLauncherProfile(serverName, { loadApiKey: false });
  const rawUrl = profile?.uri || server.webview_url || `http://${server.host}:${server.httpPort}/`;
  let baseUrl;
  try {
    baseUrl = new URL(rawUrl);
  } catch (_error) {
    throw new Error(`The Tiled launcher has an invalid webview URL: ${rawUrl}`);
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error('The Tiled launcher URL must use HTTP or HTTPS.');
  }
  return new URL('/', baseUrl);
}

async function getTiledRequestHeaders(serverName) {
  const server = sshOps?.config?.[serverName] || {};
  const profile = await getTiledLauncherProfile(serverName);
  let apiKey = profile?.apiKey || '';
  // AFL stores its runtime Tiled credential in a timestamped configuration
  // history. Native Andon browser requests should use that existing key when
  // the launcher YAML intentionally omits credentials from version control.
  if (!apiKey) {
    try {
      const aflConfig = JSON.parse(await fs.readFile(path.join(os.homedir(), '.afl', 'config.json'), 'utf8'));
      const records = Array.isArray(aflConfig) ? aflConfig : Object.values(aflConfig || {});
      const latestKey = [...records].reverse().find(record => typeof record?.tiled_api_key === 'string' && record.tiled_api_key.trim())?.tiled_api_key;
      apiKey = latestKey?.trim() || '';
    } catch (error) {
      log.debug(`No usable AFL Tiled API key found: ${error.message}`);
    }
  }
  return {
    Accept: 'application/vnd.api+json, application/json',
    ...(apiKey ? { Authorization: `Apikey ${apiKey}` } : {})
  };
}

function normalizeTiledPath(pathValue) {
  const normalized = String(pathValue || '').trim().replace(/^\/+|\/+$/g, '');
  if (normalized.includes('..')) throw new Error('Invalid Tiled catalog path.');
  return normalized;
}

function encodeTiledPath(pathValue) {
  return normalizeTiledPath(pathValue).split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

async function getTiledCatalogPath(serverName) {
  const server = sshOps?.config?.[serverName] || {};
  const profile = await getTiledLauncherProfile(serverName, { loadApiKey: false });
  const configuredPath = normalizeTiledPath(profile?.catalogPath || server.tiled_catalog_path);
  if (configuredPath) return configuredPath;
  if (tiledCatalogPathCache.has(serverName)) return tiledCatalogPathCache.get(serverName);

  const baseUrl = await getTiledBaseUrl(serverName);
  const probeUrl = new URL('api/v1/metadata/run_documents', baseUrl);
  const response = await fetch(probeUrl, { headers: await getTiledRequestHeaders(serverName) });
  if (response.ok) {
    tiledCatalogPathCache.set(serverName, 'run_documents');
    return 'run_documents';
  }
  if (response.status === 404) {
    // Native Tiled deployments such as Andon's bundled configuration store
    // uploads at the root, while AFL server browsers use run_documents. Do
    // not cache this negative result: an AFL service may create the container
    // after Andon's first browser refresh.
    return '';
  }
  throw new Error(`Could not inspect the Tiled catalog (${response.status}): ${await response.text()}`);
}

async function getTiledEntryPath(serverName, entryId) {
  const safeId = normalizeTiledPath(entryId);
  if (!safeId) throw new Error('Invalid Tiled entry ID.');
  const catalogPath = await getTiledCatalogPath(serverName);
  return catalogPath && safeId !== catalogPath && !safeId.startsWith(`${catalogPath}/`)
    ? `${catalogPath}/${safeId}`
    : safeId;
}

async function tiledSearch(serverName, {
  offset = 0,
  limit = 50,
  cursor = null,
  // `attrs.meta.ended` and `meta.ended` coexist in this catalog and use a
  // non-ISO timestamp format. In Tiled's REST sort syntax, `-` means use the
  // catalog's default node ordering (time_created) in descending order.
  sort = '-',
  query = '',
  queries = [],
  filters = {}
} = {}) {
  const baseUrl = await getTiledBaseUrl(serverName);
  const catalogPath = await getTiledCatalogPath(serverName);
  const searchPath = catalogPath ? `api/v1/search/${encodeTiledPath(catalogPath)}` : 'api/v1/search/';
  const url = new URL(searchPath, baseUrl);
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  const safeLimit = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 50));
  // Tiled servers may use either offsets or opaque cursors. Prefer the
  // cursor supplied by the previous response so paging continues past the
  // first server-side page limit.
  if (cursor) {
    url.searchParams.set('page[cursor]', String(cursor));
  } else {
    url.searchParams.set('page[offset]', String(safeOffset));
  }
  url.searchParams.set('page[limit]', String(safeLimit));
  url.searchParams.append('fields', 'metadata');
  url.searchParams.append('fields', 'structure_family');
  if (sort) url.searchParams.set('sort', sort);
  const containsQueries = [
    ...(query && String(query).trim() ? [{ field: 'sample_name', value: query }] : []),
    ...(Array.isArray(queries) ? queries : [])
  ];
  for (const { field, value } of containsQueries) {
    if (!field || value === null || value === undefined || String(value).trim() === '') continue;
    const key = String(field).startsWith('attrs.') ? String(field) : `attrs.${field}`;
    url.searchParams.append('filter[contains][condition][key]', key);
    url.searchParams.append('filter[contains][condition][value]', JSON.stringify(String(value).trim()));
  }
  for (const [field, values] of Object.entries(filters || {})) {
    const selected = (Array.isArray(values) ? values : [values]).filter(value => value !== '' && value !== null && value !== undefined);
    if (!selected.length) continue;
    const key = String(field).startsWith('attrs.') ? String(field) : `attrs.${field}`;
    url.searchParams.append('filter[in][condition][key]', key);
    url.searchParams.append('filter[in][condition][value]', JSON.stringify(selected));
  }

  const response = await fetch(url, { headers: await getTiledRequestHeaders(serverName) });
  if (!response.ok) throw new Error(`Tiled search failed (${response.status}): ${await response.text()}`);
  const payload = await response.json();
  return { ...payload, andon_catalog_path: catalogPath || '/' };
}

async function tiledFullData(serverName, entryId) {
  const baseUrl = await getTiledBaseUrl(serverName);
  const entryPath = await getTiledEntryPath(serverName, entryId);
  const headers = await getTiledRequestHeaders(serverName);

  const metadata = await tiledMetadata(serverName, entryPath);
  const fullLink = metadata?.data?.links?.full;
  const url = fullLink ? new URL(fullLink, baseUrl) : new URL(`api/v1/array/full/${encodeTiledPath(entryPath)}`, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith('/api/v1/')) {
    throw new Error('Tiled returned an invalid data link.');
  }
  url.searchParams.set('format', 'application/json');
  const response = await fetch(url, { headers: { ...headers, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Tiled data request failed (${response.status}): ${await response.text()}`);
  return response.json();
}

async function tiledContainerArrays(serverName, entryId) {
  const baseUrl = await getTiledBaseUrl(serverName);
  const entryPath = await getTiledEntryPath(serverName, entryId);
  const headers = await getTiledRequestHeaders(serverName);
  const searchUrl = new URL(`api/v1/search/${encodeTiledPath(entryPath)}`, baseUrl);
  searchUrl.searchParams.set('page[limit]', '100');
  searchUrl.searchParams.append('fields', 'structure');
  searchUrl.searchParams.append('fields', 'structure_family');
  searchUrl.searchParams.append('fields', 'specs');
  const catalogResponse = await fetch(searchUrl, { headers });
  if (!catalogResponse.ok) throw new Error(`Tiled container search failed (${catalogResponse.status}): ${await catalogResponse.text()}`);
  const catalog = await catalogResponse.json();
  return Array.isArray(catalog.data) ? catalog.data.filter(item => item?.attributes?.structure_family === 'array') : [];
}

function containerStructures(items) {
  return Object.fromEntries(items.map(item => {
    const structure = item.attributes?.structure || {};
    const specs = item.attributes?.specs || [];
    const role = specs.some(spec => spec?.name === 'xarray_coord') ? 'coordinate' : 'variable';
    return [item.id, { ...structure, role }];
  }));
}

async function tiledContainerData(serverName, entryId) {
  const baseUrl = await getTiledBaseUrl(serverName);
  const headers = await getTiledRequestHeaders(serverName);
  const items = await tiledContainerArrays(serverName, entryId);
  const values = await Promise.all(items.map(async item => {
    const fullLink = item?.links?.full;
    if (!fullLink) throw new Error(`Missing data link for ${item.id}`);
    const url = new URL(fullLink, baseUrl);
    if (url.origin !== baseUrl.origin || !url.pathname.startsWith('/api/v1/')) throw new Error(`Invalid data link for ${item.id}`);
    url.searchParams.set('format', 'application/json');
    const response = await fetch(url, { headers: { ...headers, Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Tiled data request for ${item.id} failed (${response.status})`);
    return [item.id, await response.json()];
  }));
  return {
    data: Object.fromEntries(values),
    structures: containerStructures(items)
  };
}

async function tiledContainerStructure(serverName, entryId) {
  return { structures: containerStructures(await tiledContainerArrays(serverName, entryId)) };
}

async function tiledDistinct(serverName, field, filters = {}) {
  const baseUrl = await getTiledBaseUrl(serverName);
  const catalogPath = await getTiledCatalogPath(serverName);
  const distinctPath = catalogPath ? `api/v1/distinct/${encodeTiledPath(catalogPath)}` : 'api/v1/distinct/';
  const url = new URL(distinctPath, baseUrl);
  const normalizedField = String(field || '').replace(/^attrs\./, '');
  if (!normalizedField || normalizedField.includes('..')) throw new Error('Invalid Tiled metadata field.');
  url.searchParams.append('metadata', `attrs.${normalizedField}`);
  url.searchParams.append('metadata', normalizedField);
  for (const [filterField, values] of Object.entries(filters || {})) {
    const selected = (Array.isArray(values) ? values : [values]).filter(Boolean);
    if (!selected.length) continue;
    const key = String(filterField).startsWith('attrs.') ? String(filterField) : `attrs.${filterField}`;
    url.searchParams.append('filter[in][condition][key]', key);
    url.searchParams.append('filter[in][condition][value]', JSON.stringify(selected));
  }
  const response = await fetch(url, { headers: await getTiledRequestHeaders(serverName) });
  if (!response.ok) throw new Error(`Tiled distinct request failed (${response.status}): ${await response.text()}`);
  return response.json();
}

async function tiledMetadata(serverName, entryId) {
  const baseUrl = await getTiledBaseUrl(serverName);
  const entryPath = await getTiledEntryPath(serverName, entryId);
  const url = new URL(`api/v1/metadata/${encodeTiledPath(entryPath)}`, baseUrl);
  const response = await fetch(url, { headers: await getTiledRequestHeaders(serverName) });
  if (!response.ok) throw new Error(`Tiled metadata request failed (${response.status}): ${await response.text()}`);
  return response.json();
}

async function tiledDataPreview(serverName, entryId) {
  const payload = await tiledMetadata(serverName, entryId);
  const attributes = payload?.data?.attributes || {};
  return {
    entry_id: payload?.data?.id || entryId,
    structure_family: attributes.structure_family || 'unknown',
    structure: attributes.structure || null,
    metadata: attributes.metadata || {},
    note: 'This is a dataset summary. Full array values are intentionally not loaded here; use Plot Selected to load data for visualization.'
  };
}

async function tiledPing(serverName) {
  const baseUrl = await getTiledBaseUrl(serverName);
  const url = new URL('api/v1/metadata/', baseUrl);
  const response = await fetch(url, { headers: await getTiledRequestHeaders(serverName) });
  if (!response.ok) {
    return { ok: false, statusCode: response.status, reason: `HTTP ${response.status}`, url: url.toString() };
  }
  return { ok: true, statusCode: response.status, state: 'ready', url: url.toString() };
}

// Set default paths (use os.homedir() since app.getPath() isn't available at load time)
let configPath = path.join(os.homedir(), '.afl', 'launchers.json');
let sshKeyPath = path.join(os.homedir(), '.ssh', 'id_rsa');

log.info('AFL-andon main process starting');
log.debug(`Default config path: ${configPath}`);
log.debug(`Default SSH key path: ${sshKeyPath}`);

// Override with environment variables if set
if (process.env.SERVER_CONTROL_CONFIG_PATH) {
  configPath = process.env.SERVER_CONTROL_CONFIG_PATH;
  log.info(`Using config path from environment: ${configPath}`);
}
if (process.env.SERVER_CONTROL_SSH_KEY_PATH) {
  sshKeyPath = process.env.SERVER_CONTROL_SSH_KEY_PATH;
  log.info(`Using SSH key path from environment: ${sshKeyPath}`);
}

// Override with command-line arguments if provided
const argConfigPath = process.argv.find(arg => arg.startsWith('--config='));
const argSshKeyPath = process.argv.find(arg => arg.startsWith('--ssh-key='));

if (argConfigPath) {
  configPath = argConfigPath.split('=')[1];
  log.info(`Using config path from command line: ${configPath}`);
}
if (argSshKeyPath) {
  sshKeyPath = argSshKeyPath.split('=')[1];
  log.info(`Using SSH key path from command line: ${sshKeyPath}`);
}

async function createWindow() {
  log.info('Creating main window');
  const iconPath = getAppIconPath();
  log.debug(`Using icon: ${iconPath}`);
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    icon: iconPath,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webviewTag: true
      }
  });

  log.debug('Loading index.html');
  await mainWindow.loadFile('index.html');
  mainWindow.on('close', async event => {
    if (allowWindowClose) return;

    event.preventDefault();
    if (closeConfirmationInProgress) return;
    closeConfirmationInProgress = true;
    try {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Cancel', 'Close Andon'],
        defaultId: 0,
        cancelId: 0,
        title: 'Close AFL Andon?',
        message: 'Closing Andon will stop all running servers.',
        detail: 'Do you want to close AFL Andon and stop the servers it started?'
      });
      if (response === 1) {
        allowWindowClose = true;
        mainWindow.close();
      }
    } finally {
      closeConfirmationInProgress = false;
    }
  });
  log.info('Main window created successfully');
}

async function stopManagedServersForShutdown() {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    if (sshOps) {
      const serverNames = [...andonManagedServers];
      log.info(`Stopping ${serverNames.length} Andon-managed server(s) before shutdown`);
      const results = await Promise.allSettled(
        serverNames.map(serverName => sshOps.stopServer(serverName))
      );
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          log.error(`Shutdown: failed to stop ${serverNames[index]}:`, result.reason?.message || result.reason);
        }
      });
      stopAllSessionLogStreams();
    }
    await combinedLogWriter.flush();
  })().finally(() => {
    shutdownComplete = true;
  });

  return shutdownPromise;
}

app.whenReady().then(async () => {
  log.info('Electron app ready');
  log.debug(`Process ID: ${process.pid}`);
  log.debug(`Electron version: ${process.versions.electron}`);
  log.debug(`Node version: ${process.versions.node}`);
  log.debug(`Chrome version: ${process.versions.chrome}`);
  log.info(`Log file location: ${logFilePath}`);

  const iconPath = getAppIconPath();
  if (process.platform === 'darwin' && app.dock) {
    try {
      await app.dock.setIcon(iconPath);
      log.debug(`macOS dock icon set: ${iconPath}`);
    } catch (error) {
      log.warn(`Failed to set macOS dock icon: ${error.message}`);
    }
  }
  
  try {
    sshOps = new SSHOperations(configPath, sshKeyPath);
    log.debug('SSHOperations instance created');
    await sshOps.initialize();
    log.info('SSHOperations initialized successfully');
    await createWindow();
  } catch (error) {
    log.error('Failed to initialize application:', error.message);
    log.error('Stack trace:', error.stack);
  }
});

app.on('window-all-closed', async () => {
  log.info('All windows closed');
  await stopManagedServersForShutdown();
  if (process.platform !== 'darwin') {
    log.info('Quitting application');
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (shutdownComplete) return;

  event.preventDefault();
  stopManagedServersForShutdown().finally(() => app.quit());
});

async function handleTerminationSignal(signal) {
  log.info(`Received ${signal}; stopping Andon-started servers before exit`);
  await stopManagedServersForShutdown();
  process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGQUIT' ? 131 : 143;
  app.exit(process.exitCode);
}

async function handleFatalError(kind, error) {
  if (fatalShutdownInProgress) return;
  fatalShutdownInProgress = true;
  log.error(`${kind}: ${error?.stack || error}`);
  try {
    await stopManagedServersForShutdown();
  } catch (shutdownError) {
    log.error(`${kind}: shutdown cleanup failed: ${shutdownError.message}`);
  }
  app.exit(1);
}

process.once('SIGINT', () => {
  handleTerminationSignal('SIGINT').catch(error => {
    log.error(`SIGINT shutdown failed: ${error.message}`);
    app.exit(130);
  });
});

process.once('SIGTERM', () => {
  handleTerminationSignal('SIGTERM').catch(error => {
    log.error(`SIGTERM shutdown failed: ${error.message}`);
    app.exit(143);
  });
});

process.once('SIGHUP', () => {
  handleTerminationSignal('SIGHUP').catch(error => {
    log.error(`SIGHUP shutdown failed: ${error.message}`);
    app.exit(143);
  });
});

process.once('SIGQUIT', () => {
  handleTerminationSignal('SIGQUIT').catch(error => {
    log.error(`SIGQUIT shutdown failed: ${error.message}`);
    app.exit(131);
  });
});

process.once('uncaughtException', error => {
  handleFatalError('Uncaught exception', error);
});

process.on('unhandledRejection', error => {
  // Electron can reject the internal GUEST_VIEW_MANAGER_CALL promise when a
  // webview navigation is superseded. That is normal browser cancellation,
  // not an Andon failure, and must never trigger remote-server shutdown.
  if (isExpectedWebviewNavigationAbort(error)) {
    log.debug(`Ignoring canceled webview navigation: ${error.url}`);
    return;
  }
  handleFatalError('Unhandled rejection', error);
});

app.on('activate', () => {
  log.debug('App activated');
  if (BrowserWindow.getAllWindows().length === 0) {
    log.info('No windows open, creating new window');
    createWindow();
  }
});

ipcMain.handle('start-server', async (event, serverName) => {
  log.info(`IPC: start-server requested for ${serverName}`);
  // Register before invoking the launcher: startServer can create a screen
  // and bind a port before a later health/detach check returns failure.
  andonManagedServers.add(serverName);
  try {
    stopSessionLogStream(serverName, false);
    const result = await sshOps.startServer(serverName, {
      onBeforeLaunch: () => sshOps.getServerLogSize(serverName),
      onLaunched: boundary => beginSessionLogStream(serverName, event.sender, boundary?.success ? boundary.size : null)
    });
    if (result.sshDown) {
      stopSessionLogStream(serverName, false);
      log.warn(`start-server: SSH is down for ${serverName}`);
      return { success: false, sshDown: true };
    }
    if (!result.success) {
      stopSessionLogStream(serverName, false);
      log.error(`start-server: ${serverName} failed to start: ${result.error || 'Unknown error'}`);
      return result;
    }
    if (result.degraded) {
      log.warn(`start-server: ${serverName} started in degraded state: ${result.warning}`);
    } else {
      log.info(`start-server: ${serverName} started successfully`);
    }
    return result;
  } catch (error) {
    stopSessionLogStream(serverName, false);
    log.error(`start-server: Error for ${serverName}:`, error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('has-session-ssh-password', (_event, serverName) => {
  return { available: sshOps.hasSessionPassword(serverName) };
});

ipcMain.handle('set-session-ssh-password', (_event, serverName, password) => {
  const server = sshOps.config[serverName];
  if (server?.tiled_management?.authentication !== 'password') {
    return { success: false, error: 'This launcher does not use password authentication.' };
  }
  try {
    sshOps.setSessionPassword(serverName, password);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-server', async (event, serverName) => {
  log.info(`IPC: stop-server requested for ${serverName}`);
  try {
    const result = await sshOps.stopServer(serverName);
    if (result.sshDown) {
      log.warn(`stop-server: SSH is down for ${serverName}`);
      return { success: false, sshDown: true };
    }
    if (result.success) {
      andonManagedServers.delete(serverName);
      stopSessionLogStream(serverName);
    }
    log.info(`stop-server: ${serverName} stopped successfully`);
    return result;
  } catch (error) {
    log.error(`stop-server: Error for ${serverName}:`, error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('restart-server', async (event, serverName) => {
  log.info(`IPC: restart-server requested for ${serverName}`);
  andonManagedServers.add(serverName);
  try {
    stopSessionLogStream(serverName, false);
    const result = await sshOps.restartServer(serverName, {
      onBeforeLaunch: () => sshOps.getServerLogSize(serverName),
      onLaunched: boundary => beginSessionLogStream(serverName, event.sender, boundary?.success ? boundary.size : null)
    });
    if (result.sshDown) {
      stopSessionLogStream(serverName, false);
      log.warn(`restart-server: SSH is down for ${serverName}`);
      return { success: false, sshDown: true };
    }
    if (!result.success) {
      stopSessionLogStream(serverName, false);
      log.error(`restart-server: ${serverName} failed to restart: ${result.error || 'Unknown error'}`);
      return result;
    }
    log.info(`restart-server: ${serverName} restarted successfully`);
    return result;
  } catch (error) {
    stopSessionLogStream(serverName, false);
    log.error(`restart-server: Error for ${serverName}:`, error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('activate-server-log-stream', (event, serverName) => {
  return activateSessionLogStream(serverName, event.sender);
});

ipcMain.handle('get-session-log-events', (_event, afterSequence = 0) => {
  const cursor = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
  return {
    events: sessionLogEvents.filter(item => item.sequence > cursor),
    latestSequence: sessionLogSequence
  };
});

ipcMain.on('append-combined-log-entries', (_event, entries) => {
  combinedLogWriter.append(entries).catch(error => {
    log.error(`Could not write combined log ${combinedLogWriter.filePath}: ${error.message}`);
  });
});

ipcMain.handle('get-server-status', async (event, serverName) => {
  log.debug(`IPC: get-server-status for ${serverName}`);
  try {
    const result = await sshOps.getServerStatus(serverName);
    log.debug(`get-server-status: ${serverName} status=${result.status}, sshDown=${result.sshDown}`);
    return result;
  } catch (error) {
    log.error(`get-server-status: Error for ${serverName}:`, error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-batch-server-status', async (event, host) => {
  log.debug(`IPC: get-batch-server-status for host ${host}`);
  try {
    const result = await sshOps.getBatchServerStatus(host);
    if (result.success) {
      log.debug(`get-batch-server-status: ${host} sessions=${result.sessions?.length || 0}`);
    } else {
      log.debug(`get-batch-server-status: ${host} failed - sshDown=${result.sshDown}`);
    }
    return result;
  } catch (error) {
    log.error(`get-batch-server-status: Error for host ${host}:`, error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-servers-by-host', (event) => {
  log.debug('IPC: get-servers-by-host');
  const result = sshOps.getServersByHost();
  log.debug(`get-servers-by-host: ${Object.keys(result).length} hosts found`);
  return result;
});

ipcMain.handle('get-server-log', async (event, serverName) => {
  log.info(`IPC: get-server-log for ${serverName}`);
  try {
    const result = await sshOps.getServerLog(serverName);
    if (result.sshDown) {
      log.warn(`get-server-log: SSH is down for ${serverName}`);
      return { success: false, sshDown: true };
    }
    log.debug(`get-server-log: Retrieved ${result.output?.length || 0} bytes for ${serverName}`);
    return result;
  } catch (error) {
    log.error(`get-server-log: Error for ${serverName}:`, error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('join-server', async (event, serverName) => {
  log.info(`IPC: join-server for ${serverName}`);
  try {
    const result = await sshOps.joinServer(serverName);
    if (result.sshDown) {
      log.warn(`join-server: SSH is down for ${serverName}`);
      return { success: false, sshDown: true };
    }
    return result;
  } catch (error) {
    log.error(`join-server: Error for ${serverName}:`, error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('import-config', async () => {
  log.info('IPC: import-config');
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });

    if (result.canceled) {
      log.debug('import-config: Dialog canceled');
      return { success: false, message: 'File selection was canceled.' };
    }

    const sourcePath = result.filePaths[0];
    log.info(`import-config: Importing from ${sourcePath}`);
    await fs.copyFile(sourcePath, configPath);
    sshOps.loadConfig(configPath);
    log.info('import-config: Config imported successfully');
    return { success: true, message: 'Config file imported successfully.' };
  } catch (error) {
    log.error('import-config: Error:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('import-ssh-key', async () => {
  log.info('IPC: import-ssh-key');
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile']
    });

    if (result.canceled) {
      log.debug('import-ssh-key: Dialog canceled');
      return { success: false, message: 'File selection was canceled.' };
    }

    const sourcePath = result.filePaths[0];
    log.info(`import-ssh-key: Importing from ${sourcePath}`);
    await fs.copyFile(sourcePath, sshKeyPath);
    await fs.chmod(sshKeyPath, 0o600); // Ensure correct permissions
    await sshOps.loadSSHKey();
    log.info('import-ssh-key: SSH key imported successfully');
    return { success: true, message: 'SSH key imported successfully.' };
  } catch (error) {
    log.error('import-ssh-key: Error:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-config', async () => {
  log.debug('IPC: get-config');
  await sshOps.loadConfig();  // Reload config before sending
  const serverCount = Object.keys(sshOps.config).length;
  log.debug(`get-config: Returning config with ${serverCount} servers`);
  return sshOps.config;
});

// These endpoints are intentionally restricted to a Tiled-type launcher (with
// a legacy fallback for a launcher named "tiled"). The bundled browser uses them so it can read the Tiled catalog
// without depending on an AFL driver or on browser CORS configuration.
ipcMain.handle('tiled-ping', async (_event, serverName) => {
  try {
    return await tiledPing(serverName);
  } catch (error) {
    log.warn(`tiled-ping failed: ${error.message}`);
    return { ok: false, reason: error.message };
  }
});

ipcMain.handle('tiled-search', async (_event, serverName, options) => {
  try {
    return { success: true, data: await tiledSearch(serverName, options) };
  } catch (error) {
    log.warn(`tiled-search failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('tiled-metadata', async (_event, serverName, entryId) => {
  try {
    return { success: true, data: await tiledMetadata(serverName, entryId) };
  } catch (error) {
    log.warn(`tiled-metadata failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('tiled-full-data', async (_event, serverName, entryId) => {
  try {
    return { success: true, data: await tiledFullData(serverName, entryId) };
  } catch (error) {
    log.warn(`tiled-full-data failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('tiled-data-preview', async (_event, serverName, entryId) => {
  try {
    return { success: true, data: await tiledDataPreview(serverName, entryId) };
  } catch (error) {
    log.warn(`tiled-data-preview failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('tiled-container-data', async (_event, serverName, entryId) => {
  try {
    return { success: true, data: await tiledContainerData(serverName, entryId) };
  } catch (error) {
    log.warn(`tiled-container-data failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('tiled-container-structure', async (_event, serverName, entryId) => {
  try {
    return { success: true, data: await tiledContainerStructure(serverName, entryId) };
  } catch (error) {
    log.warn(`tiled-container-structure failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('tiled-distinct', async (_event, serverName, field, filters) => {
  try {
    return { success: true, data: await tiledDistinct(serverName, field, filters) };
  } catch (error) {
    log.warn(`tiled-distinct failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('tiled-open-plot', async (event, serverName, entryIds) => {
  try {
    if (!isTiledLauncher(serverName)) throw new Error('Plotting is only available for a Tiled launcher.');
    const ids = Array.isArray(entryIds) ? [...new Set(entryIds.map(id => String(id || '').trim()).filter(Boolean))] : [];
    if (!ids.length) throw new Error('Select at least one Tiled entry to plot.');
    const plotWindow = new BrowserWindow({
      width: 1200,
      height: 860,
      minWidth: 820,
      minHeight: 620,
      title: 'Tiled Plot Viewer',
      webPreferences: {
        preload: path.join(__dirname, 'tiled-webview-preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    plotWindow.setMenuBarVisibility(false);
    await plotWindow.loadFile(path.join(__dirname, 'tiled', 'browser', 'plot.html'), {
      query: { server: String(serverName), plotEntries: JSON.stringify(ids) }
    });
    return { success: true };
  } catch (error) {
    log.warn(`tiled-open-plot failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('add-server', async (event, { serverName, serverConfig }) => {
  log.info(`IPC: add-server ${serverName}`);
  log.debug(`add-server: Config:`, serverConfig);
  sshOps.addServer(serverName, serverConfig);
  await sshOps.saveConfig();
  log.info(`add-server: ${serverName} added successfully`);
  return { success: true };
});

ipcMain.handle('update-server', async (event, { serverName, serverConfig }) => {
  log.info(`IPC: update-server ${serverName}`);
  log.debug(`update-server: New config:`, serverConfig);
  sshOps.updateServer(serverName, serverConfig);
  await sshOps.saveConfig();
  log.info(`update-server: ${serverName} updated successfully`);
  return { success: true };
});

ipcMain.handle('remove-server', async (event, serverName) => {
  log.info(`IPC: remove-server ${serverName}`);
  sshOps.removeServer(serverName);
  await sshOps.saveConfig();
  log.info(`remove-server: ${serverName} removed successfully`);
  return { success: true };
});

ipcMain.handle('toggle-server-active', async (event, serverName) => {
  log.info(`IPC: toggle-server-active ${serverName}`);
  sshOps.toggleServerActive(serverName);
  await sshOps.saveConfig();
  const newState = sshOps.config[serverName]?.active ? 'active' : 'inactive';
  log.info(`toggle-server-active: ${serverName} is now ${newState}`);
  return { success: true };
});

ipcMain.handle('save-config', async () => {
  log.info('IPC: save-config');
  try {
    await sshOps.saveConfig();
    log.info('save-config: Configuration saved successfully');
    return { success: true };
  } catch (error) {
    log.error('save-config: Error:', error.message);
    return { success: false, error: error.message };
  }
});

const sshConnections = {};

ipcMain.handle('start-ssh-session', async (event, serverName) => {
  log.info(`IPC: start-ssh-session for ${serverName}`);
  
  // Close existing connection if any
  if (sshConnections[serverName]) {
    log.debug(`start-ssh-session: Closing existing connection for ${serverName}`);
    await closeSSHConnection(serverName);
  }

  const serverConfig = sshOps.config[serverName];
  if (!serverConfig) {
    log.error(`start-ssh-session: No config found for ${serverName}`);
    return { success: false, error: 'Server not found' };
  }
  
  try {
    log.debug(`start-ssh-session: Connecting to ${serverConfig.host} as ${serverConfig.username}`);
    const { conn, keyPath } = await sshOps.connectWithAvailableKeys(serverName, 5000, {
      pty: {
        term: 'xterm'
      }
    });

    log.debug(`start-ssh-session: SSH connection established for ${serverName}${keyPath ? ` using ${keyPath}` : ' using a session password'}`);
    
    const dockerCompose = sshOps.isDockerComposeManaged(serverConfig);
    const joinCommand = sshOps.getJoinCommand(serverName);
    const stream = await new Promise((resolve, reject) => {
      const onStream = (err, openedStream) => {
        if (err) reject(err);
        else resolve(openedStream);
      };
      if (dockerCompose) conn.exec(joinCommand, { pty: { term: 'xterm' } }, onStream);
      else conn.shell(onStream);
    });

    sshConnections[serverName] = { conn, stream };
    log.debug(`start-ssh-session: Shell opened for ${serverName}`);

    let sudoPasswordPending = dockerCompose;
    stream.on('data', (data) => {
      let text = data.toString();
      if (sudoPasswordPending && text.includes(sshOps.getSudoPrompt())) {
        sudoPasswordPending = false;
        text = text.replace(sshOps.getSudoPrompt(), '');
        stream.write(`${sshOps.getSessionPassword(serverName)}\n`);
      }
      if (text) mainWindow.webContents.send('ssh-data', { serverName, data: text });
    });

    stream.on('close', () => {
      log.debug(`start-ssh-session: Stream closed for ${serverName}`);
      closeSSHConnection(serverName);
    });

    // A Compose join is started directly as a PTY command so the sudo password
    // can be supplied without echoing it into the interactive terminal.
    if (!dockerCompose) {
      log.debug(`start-ssh-session: Sending join command for ${serverName}`);
      stream.write(`${joinCommand}\n`);
    }

    log.info(`start-ssh-session: Successfully connected to ${serverName}`);
    return { success: true };
  } catch (error) {
    log.error(`start-ssh-session: Connection error for ${serverName}:`, error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('close-ssh-session', async (event, serverName) => {
  log.info(`IPC: close-ssh-session for ${serverName}`);
  await closeSSHConnection(serverName);
  return { success: true };
});

async function closeSSHConnection(serverName) {
  const connection = sshConnections[serverName];
  if (connection) {
    log.debug(`closeSSHConnection: Closing connection for ${serverName}`);
    if (connection.stream) {
      connection.stream.end();
    }
    if (connection.conn) {
      connection.conn.end();
    }
    delete sshConnections[serverName];
    log.info(`closeSSHConnection: Closed SSH connection for ${serverName}`);
  } else {
    log.debug(`closeSSHConnection: No connection found for ${serverName}`);
  }
}

ipcMain.on('ssh-data', (event, { serverName, data }) => {
  const connection = sshConnections[serverName];
  if (connection && connection.stream) {
    connection.stream.write(data);
  }
});

ipcMain.on('resize-pty', (event, { serverName, cols, rows }) => {
  log.debug(`IPC: resize-pty for ${serverName} to ${cols}x${rows}`);
  const connection = sshConnections[serverName];
  if (connection && connection.stream) {
    connection.stream.setWindow(rows, cols);
  }
});

ipcMain.handle('set-config-path', async (event, newPath) => {
  log.info(`IPC: set-config-path to ${newPath}`);
  configPath = newPath;
  sshOps.setConfigPath(newPath);
  await sshOps.loadConfig();
  log.info('set-config-path: Config reloaded from new path');
  return { success: true };
});


ipcMain.handle('set-ssh-key-path', async (event, newPath) => {
  log.info(`IPC: set-ssh-key-path to ${newPath}`);
  sshKeyPath = newPath;
  sshOps.setSshKeyPath(newPath);
  return { success: true };
});

ipcMain.handle('get-paths', () => {
  log.debug('IPC: get-paths');
  // Return the actual loaded SSH key path from sshOps (may differ from default if fallback was used)
  return { configPath, sshKeyPath: sshOps.sshKeyPath || sshKeyPath };
});

ipcMain.handle('show-open-dialog', async (event, options) => {
  log.debug('IPC: show-open-dialog');
  const result = await dialog.showOpenDialog(mainWindow, options);
  log.debug(`show-open-dialog: canceled=${result.canceled}, files=${result.filePaths?.length || 0}`);
  return result;
});

ipcMain.handle('get-afl-config', async (event, host) => {
  log.info(`IPC: get-afl-config for host ${host || 'local'}`);
  if (host) {
    log.debug(`get-afl-config: Fetching from remote host ${host}`);
    const result = await sshOps.getRemoteAflConfig(host);
    if (!result.success) {
      log.error(`get-afl-config: Failed to fetch from ${host}:`, result.error);
      return { success: false, error: result.error };
    }
    log.info(`get-afl-config: Successfully fetched from ${host}`);
    return { success: true, data: result.data };
  }
  const cfgPath = andonConfigPath;
  log.debug(`get-afl-config: Reading local Andon config from ${cfgPath}`);
  try {
    const data = await fs.readFile(cfgPath, 'utf8');
    log.info('get-afl-config: Local config loaded successfully');
    return { success: true, data: JSON.parse(data) };
  } catch (err) {
    if (err.code === 'ENOENT') {
      log.info('get-afl-config: No local Andon config exists yet');
      return { success: true, data: {} };
    }
    log.error('get-afl-config: Failed to read local config:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-afl-config', async (event, host, cfg) => {
  log.info(`IPC: save-afl-config for host ${host || 'local'}`);
  if (host) {
    log.debug(`save-afl-config: Saving to remote host ${host}`);
    const res = await sshOps.saveRemoteAflConfig(host, cfg);
    if (!res.success) {
      log.error(`save-afl-config: Failed to save to ${host}:`, res.error);
    } else {
      log.info(`save-afl-config: Successfully saved to ${host}`);
    }
    return res;
  }
  const cfgPath = andonConfigPath;
  log.debug(`save-afl-config: Saving to local Andon config path ${cfgPath}`);
  try {
    const { driver_custom_configs, ...andonConfig } = cfg || {};
    await fs.mkdir(path.dirname(cfgPath), { recursive: true });
    await fs.writeFile(cfgPath, JSON.stringify(andonConfig, null, 2));
    log.info('save-afl-config: Local config saved successfully');
    return { success: true };
  } catch (err) {
    log.error('save-afl-config: Error saving:', err.message);
    return { success: false, error: err.message };
  }
});
