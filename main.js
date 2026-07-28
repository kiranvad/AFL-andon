// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { createLogger, logFilePath } = require('./logger');
const log = createLogger('main');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const SSHOperations = require('./sshOperations');

let mainWindow;
let sshOps;

const ICON_PATH_MAC = path.join(__dirname, 'assets', 'icons', 'mac', 'icon.icns');
const ICON_PATH_PNG = path.join(__dirname, 'assets', 'icons', 'png', '256x256.png');

function getAppIconPath() {
  return process.platform === 'darwin' ? ICON_PATH_MAC : ICON_PATH_PNG;
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
  log.info('Main window created successfully');
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

app.on('window-all-closed', () => {
  log.info('All windows closed');
  if (process.platform !== 'darwin') {
    log.info('Quitting application');
    app.quit();
  }
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
  try {
    const result = await sshOps.startServer(serverName);
    if (result.sshDown) {
      log.warn(`start-server: SSH is down for ${serverName}`);
      return { success: false, sshDown: true };
    }
    log.info(`start-server: ${serverName} started successfully`);
    return result;
  } catch (error) {
    log.error(`start-server: Error for ${serverName}:`, error.message);
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
    log.info(`stop-server: ${serverName} stopped successfully`);
    return result;
  } catch (error) {
    log.error(`stop-server: Error for ${serverName}:`, error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('restart-server', async (event, serverName) => {
  log.info(`IPC: restart-server requested for ${serverName}`);
  try {
    const result = await sshOps.restartServer(serverName);
    if (result.sshDown) {
      log.warn(`restart-server: SSH is down for ${serverName}`);
      return { success: false, sshDown: true };
    }
    log.info(`restart-server: ${serverName} restarted successfully`);
    return result;
  } catch (error) {
    log.error(`restart-server: Error for ${serverName}:`, error.message);
    return { success: false, error: error.message };
  }
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

    log.debug(`start-ssh-session: SSH connection established for ${serverName} using ${keyPath}`);
    
    const stream = await new Promise((resolve, reject) => {
      conn.shell((err, stream) => {
        if (err) reject(err);
        else resolve(stream);
      });
    });

    sshConnections[serverName] = { conn, stream };
    log.debug(`start-ssh-session: Shell opened for ${serverName}`);

    stream.on('data', (data) => {
      mainWindow.webContents.send('ssh-data', { serverName, data: data.toString() });
    });

    stream.on('close', () => {
      log.debug(`start-ssh-session: Stream closed for ${serverName}`);
      closeSSHConnection(serverName);
    });

    // Send the 'screen -x' command
    const screenCmd = `screen -x ${serverConfig.screen_name}\n`;
    log.debug(`start-ssh-session: Sending command: ${screenCmd.trim()}`);
    stream.write(screenCmd);

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
  const cfgPath = path.join(os.homedir(), '.afl', 'config.json');
  log.debug(`get-afl-config: Reading local config from ${cfgPath}`);
  try {
    const data = await fs.readFile(cfgPath, 'utf8');
    log.info('get-afl-config: Local config loaded successfully');
    return { success: true, data: JSON.parse(data) };
  } catch (err) {
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
  const cfgPath = path.join(os.homedir(), '.afl', 'config.json');
  log.debug(`save-afl-config: Saving to local path ${cfgPath}`);
  try {
    let data = {};
    try {
      const existing = await fs.readFile(cfgPath, 'utf8');
      data = JSON.parse(existing);
    } catch (_) {
      log.debug('save-afl-config: No existing config, creating new');
    }
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const micros = String(now.getMilliseconds() * 1000).padStart(6, '0');
    const ts = `${String(now.getFullYear()).slice(-2)}/${pad(now.getDate())}/${pad(now.getMonth() + 1)} ` +
               `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${micros}`;
    data[ts] = cfg;
    await fs.mkdir(path.dirname(cfgPath), { recursive: true });
    await fs.writeFile(cfgPath, JSON.stringify(data, null, 2));
    log.info('save-afl-config: Local config saved successfully');
    return { success: true };
  } catch (err) {
    log.error('save-afl-config: Error saving:', err.message);
    return { success: false, error: err.message };
  }
});
