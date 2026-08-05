const { Client } = require('ssh2');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { createLogger } = require('./logger');

const log = createLogger('ssh');
const ANDON_CONFIG_FILENAME = 'andon.config.json';

// Common SSH key filenames in order of preference (modern/secure first)
// Based on OpenSSH default identity file search order
const SSH_KEY_CANDIDATES = [
  'id_ed25519',      // Ed25519 - modern, recommended
  'id_ecdsa',        // ECDSA
  'id_ecdsa_sk',     // ECDSA with FIDO/U2F security key
  'id_ed25519_sk',   // Ed25519 with FIDO/U2F security key
  'id_rsa',          // RSA - traditional, widely supported
  'id_dsa',          // DSA - deprecated but may still exist
];

const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function isLocalHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  return normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]';
}

// `screen -ls` retains exited sessions until `screen -wipe` is run. Keep
// those entries separate so a stale record is never reported as a live server.
function parseScreenSessions(output) {
  const sessions = [];
  for (const line of output.split('\n')) {
    const match = line.match(/\d+\.([^\s\t]+)/);
    if (!match || !match[1]) continue;

    let state = 'unknown';
    if (/\(Dead/i.test(line)) state = 'dead';
    else if (/\(Detached\)/i.test(line)) state = 'detached';
    else if (/\(Attached\)/i.test(line)) state = 'attached';
    sessions.push({ name: match[1], state, line: line.trim() });
  }
  return sessions;
}

class SSHOperations {
  constructor(configPath, sshKeyPath) {
    this.config = {};
    this.sshKeyPath = sshKeyPath;
    this.sshKey = null;
    this.sshKeys = [];
    this.preferredSSHKeyPaths = {};
    this.configPath = configPath;
    this.screenSessionCache = {}; // Cache for screen sessions by host
    this.hostOsCache = {}; // Cache for remote OS detection (darwin vs linux)
    log.debug(`SSHOperations created with configPath=${configPath}, sshKeyPath=${sshKeyPath}`);
  }

  async initialize() {
    log.info('Initializing SSHOperations');
    await this.loadConfig();
    await this.loadSSHKey();
    log.info('SSHOperations initialization complete');
  }

  async loadConfig() {
    log.debug(`Loading config from ${this.configPath}`);
    try {
      const configData = await fs.readFile(this.configPath, 'utf8');
      this.config = JSON.parse(configData);
      const serverCount = Object.keys(this.config).length;
      log.info(`Loaded config with ${serverCount} servers from ${this.configPath}`);
      
      // Set default values if not specified
      Object.keys(this.config).forEach(serverName => {
        const server = this.config[serverName];
        if (!server.httpPort) {
          server.httpPort = 5000;
          log.debug(`${serverName}: Using default httpPort 5000`);
        }
        if (!server.shell) {
          server.shell = 'bash';
          log.debug(`${serverName}: Using default shell 'bash'`);
        }
        if (!('active' in server)) {
          server.active = true;
        }
        if (!('device' in server)) {
          server.device = false;
        }
        if (!server.username) {
          log.warn(`${serverName}: Username not specified, using current user`);
          server.username = os.userInfo().username;
        }
      });
    } catch (error) {
      log.error(`Failed to load config from ${this.configPath}:`, error.message);
      if (error.code === 'ENOENT') {
        log.warn('Config file does not exist - starting with empty config');
        this.config = {};
      }
    }
  }

  async saveConfig() {
    log.debug(`Saving config to ${this.configPath}`);
    try {
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2));
      log.info(`Config saved successfully to ${this.configPath}`);
    } catch (error) {
      log.error(`Failed to save config to ${this.configPath}:`, error.message);
      throw error;
    }
  }

  async loadSSHKey() {
    log.debug('Loading SSH key');
    const sshDir = path.join(os.homedir(), '.ssh');
    const candidatePaths = [];

    // First, try the explicitly configured path.
    if (this.sshKeyPath) {
      candidatePaths.push(this.sshKeyPath);
    }

    // Then search common key locations, skipping duplicates.
    for (const keyName of SSH_KEY_CANDIDATES) {
      const keyPath = path.join(sshDir, keyName);
      if (candidatePaths.includes(keyPath)) {
        continue;
      }
      candidatePaths.push(keyPath);
    }

    log.debug(`Searching for SSH keys in ${sshDir}`);

    this.sshKeys = [];
    for (const keyPath of candidatePaths) {
      try {
        const key = await fs.readFile(keyPath);
        this.sshKeys.push({ path: keyPath, key });
        log.info(`Loaded SSH key from: ${keyPath}`);
      } catch (error) {
        log.debug(`Could not load SSH key from ${keyPath}: ${error.message}`);
      }
    }

    if (this.sshKeys.length > 0) {
      this.sshKey = this.sshKeys[0].key;
      this.sshKeyPath = this.sshKeys[0].path;
      log.info(`Loaded ${this.sshKeys.length} SSH key(s); defaulting to ${this.sshKeyPath}`);
      return;
    }

    this.sshKey = null;
    const triedPaths = candidatePaths.filter(Boolean);
    log.error(`No valid SSH key found. Tried: ${triedPaths.join(', ')}`);
  }

  getAvailableSSHKeys(host = null) {
    if (Array.isArray(this.sshKeys) && this.sshKeys.length > 0) {
      const preferredPath = host ? this.preferredSSHKeyPaths[host] : null;
      if (!preferredPath) {
        return this.sshKeys;
      }

      const preferredKey = this.sshKeys.find((entry) => entry.path === preferredPath);
      if (!preferredKey) {
        return this.sshKeys;
      }

      return [
        preferredKey,
        ...this.sshKeys.filter((entry) => entry.path !== preferredPath)
      ];
    }
    if (this.sshKey) {
      return [{ path: this.sshKeyPath, key: this.sshKey }];
    }
    return [];
  }

  setPreferredSSHKey(host, authKey) {
    if (!authKey || !authKey.path) {
      return;
    }

    this.preferredSSHKeyPaths[host] = authKey.path;
    this.sshKey = authKey.key;
    this.sshKeyPath = authKey.path;

    if (Array.isArray(this.sshKeys) && this.sshKeys.length > 0) {
      this.sshKeys = [
        authKey,
        ...this.sshKeys.filter((entry) => entry.path !== authKey.path)
      ];
    }
  }

  isAuthenticationError(error) {
    if (!error) {
      return false;
    }
    return error.level === 'client-authentication' ||
      /authentication methods failed|all configured authentication methods failed|permission denied/i.test(error.message || '');
  }

  connectWithKey(serverName, serverConfig, authKey, timeout = 0, extraOptions = {}) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let timer;
      let settled = false;
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const finish = (fn, value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        fn(value);
      };

      conn.on('ready', () => {
        log.debug(`${serverName}: Authenticated with SSH key ${authKey.path}`);
        finish(resolve, conn);
      }).on('error', (error) => {
        error.sshKeyPath = authKey.path;
        try {
          conn.end();
        } catch (_) {
          // Ignore cleanup errors while switching to the next key.
        }
        finish(reject, error);
      });

      log.debug(`${serverName}: Trying SSH key ${authKey.path}`);
      conn.connect({
        host: serverConfig.host,
        port: 22,
        username: serverConfig.username,
        privateKey: authKey.key,
        ...extraOptions
      });

      if (timeout > 0) {
        timer = setTimeout(() => {
          const timeoutError = new Error(`SSH connection timed out after ${timeout}ms`);
          timeoutError.code = 'ETIMEDOUT';
          timeoutError.sshKeyPath = authKey.path;
          conn.destroy();
          finish(reject, timeoutError);
        }, timeout);
      }
    });
  }

  async connectWithAvailableKeys(serverName, timeout = 0, extraOptions = {}) {
    const serverConfig = this.config[serverName];
    if (!serverConfig) {
      throw new Error(`Server not found: ${serverName}`);
    }

    const authKeys = this.getAvailableSSHKeys(serverConfig.host);
    if (authKeys.length === 0) {
      throw new Error('No SSH key loaded');
    }

    let lastError = null;
    for (const authKey of authKeys) {
      try {
        const conn = await this.connectWithKey(serverName, serverConfig, authKey, timeout, extraOptions);
        this.setPreferredSSHKey(serverConfig.host, authKey);
        return { conn, keyPath: authKey.path };
      } catch (error) {
        lastError = error;
        if (!this.isAuthenticationError(error)) {
          throw error;
        }
        log.debug(`${serverName}: Authentication failed with SSH key ${authKey.path}`);
      }
    }

    throw lastError || new Error('All configured authentication methods failed');
  }

  setConfigPath(newPath) {
    log.debug(`Setting config path to ${newPath}`);
    this.configPath = newPath;
  }

  setSshKeyPath(newPath) {
    log.debug(`Setting SSH key path to ${newPath}`);
    this.sshKeyPath = newPath;
  }

  addServer(serverName, serverConfig) {
    log.info(`Adding server: ${serverName}`);
    log.debug(`Server config:`, serverConfig);
    this.config[serverName] = serverConfig;
  }

  removeServer(serverName) {
    log.info(`Removing server: ${serverName}`);
    delete this.config[serverName];
  }

  updateServer(serverName, serverConfig) {
    log.info(`Updating server: ${serverName}`);
    log.debug(`New config:`, serverConfig);
    this.config[serverName] = { ...this.config[serverName], ...serverConfig };
  }

  toggleServerActive(serverName) {
    if (this.config[serverName]) {
      const newState = !this.config[serverName].active;
      this.config[serverName].active = newState;
      log.info(`Server ${serverName} active state changed to ${newState}`);
    } else {
      log.warn(`Cannot toggle active state: server ${serverName} not found`);
    }
  }

  async executeCommand(serverName, command, timeout = 0) {
    const serverConfig = this.config[serverName];
    if (!serverConfig) {
      log.error(`No config found for server: ${serverName}`);
      return { success: false, sshDown: true };
    }

    if (this.getAvailableSSHKeys().length === 0) {
      log.error(`No SSH key loaded - cannot execute command for ${serverName}`);
      return { success: false, sshDown: true, error: 'No SSH key loaded' };
    }

    log.debug(`${serverName} -> ${serverConfig.host}: Executing command: ${command}`);

    let conn;
    try {
      ({ conn } = await this.connectWithAvailableKeys(serverName, timeout));
    } catch (error) {
      log.error(`${serverName}: SSH connection error:`, error.message);
      if (error.level) {
        log.debug(`${serverName}: Error level: ${error.level}`);
      }
      return { success: false, sshDown: true, error: error.message };
    }

    return new Promise((resolve) => {
      conn.exec(command, (err, stream) => {
        if (err) {
          log.error(`${serverName}: Command execution failed:`, err.message);
          conn.end();
          resolve({ success: false, sshDown: true, error: err.message });
          return;
        }

        let output = '';
        stream.on('close', (code, signal) => {
          conn.end();
          log.debug(`${serverName}: Command finished with code=${code}, signal=${signal}`);
          // Don't warn for screen -ls returning code 1 (means "no screens found" - expected)
          const isScreenLsNoScreens = command === 'screen -ls' && code === 1;
          if (code !== 0 && code !== null && !isScreenLsNoScreens) {
            log.warn(`${serverName}: Command exited with non-zero code ${code}`);
          }
          resolve({ success: true, output, code, signal });
          log.debug(`${serverName}: Output length: ${output.length} bytes`);
        }).on('data', (data) => {
          output += data;
        }).stderr.on('data', (data) => {
          output += data;
          log.debug(`${serverName}: stderr: ${data.toString().trim()}`);
        });
      });
    });
  }

  // Detect remote OS (returns 'darwin' for macOS, 'linux' for Linux, etc.)
  async getRemoteOs(serverName) {
    const serverConfig = this.config[serverName];
    if (!serverConfig) return null;
    
    const host = serverConfig.host;
    
    // Check cache first
    if (this.hostOsCache[host]) {
      log.debug(`${serverName}: Using cached OS for ${host}: ${this.hostOsCache[host]}`);
      return this.hostOsCache[host];
    }
    
    // Detect OS using uname
    const result = await this.executeCommand(serverName, 'uname -s', 5000);
    if (result.success && result.output) {
      const osName = result.output.trim().toLowerCase();
      this.hostOsCache[host] = osName;
      log.info(`${serverName}: Detected remote OS for ${host}: ${osName}`);
      return osName;
    }
    
    log.warn(`${serverName}: Could not detect remote OS, assuming linux`);
    return 'linux';
  }

  // Get the home directory path for a host based on its OS
  async getRemoteHomePath(host, username) {
    // Find a server on this host to detect OS
    const serverName = Object.keys(this.config).find(name =>
      this.config[name].host === host
    );
    
    if (!serverName) {
      // Default to Linux path if we can't detect
      log.warn(`Cannot detect OS for ${host}, defaulting to Linux home path`);
      return `/home/${username}`;
    }
    
    const remoteOs = await this.getRemoteOs(serverName);
    const homePath = remoteOs === 'darwin' ? `/Users/${username}` : `/home/${username}`;
    log.debug(`Home path for ${username}@${host} (${remoteOs}): ${homePath}`);
    return homePath;
  }

  getStatusUrl(serverName) {
    const serverConfig = this.config[serverName];
    return serverConfig.status_url ||
      `http://${serverConfig.host}:${serverConfig.httpPort}/queue_state`;
  }

  async probeServerHealth(serverName) {
    const url = this.getStatusUrl(serverName);
    const command = `curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 3 ${shellQuote(url)}`;
    const result = await this.executeCommand(serverName, command, 5000);
    if (!result.success) return { ok: false, url, reason: result.error || 'SSH connection failed' };

    const statusCode = (result.output || '').trim().match(/\d{3}$/)?.[0] || null;
    if (result.code === 0 && statusCode && Number(statusCode) >= 200 && Number(statusCode) < 300) {
      return { ok: true, url, statusCode: Number(statusCode) };
    }
    const detail = (result.output || '').trim().replace(/\d{3}$/, '').trim();
    return {
      ok: false,
      url,
      statusCode: statusCode ? Number(statusCode) : null,
      reason: detail || (statusCode ? `HTTP ${statusCode}` : 'connection failed')
    };
  }

  async waitForServerHealth(serverName, attempts = 20, intervalMs = 1000) {
    let lastResult;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      lastResult = await this.probeServerHealth(serverName);
      if (lastResult.ok) return lastResult;
      if (attempt < attempts - 1) await sleep(intervalMs);
    }
    return lastResult;
  }

  async ensureScreenDetached(serverName) {
    const screenName = this.config[serverName].screen_name;
    const getSession = async () => {
      const statusResult = await this.executeCommand(serverName, 'screen -ls', 5000);
      if (!statusResult.success) {
        return { error: statusResult.error || 'could not verify screen state' };
      }
      return {
        session: parseScreenSessions(statusResult.output)
          .find(item => item.name === screenName && item.state !== 'dead')
      };
    };

    let { session, error } = await getSession();
    if (error) return { ok: false, reason: error };
    if (!session) return { ok: false, reason: `screen session "${screenName}" exited` };
    if (session.state === 'detached') return { ok: true };

    if (session.state !== 'attached') {
      return { ok: false, reason: `screen session is ${session.state}, not detached` };
    }

    // A user may have joined the session while the server was starting.  Send
    // the screen command only in that case: `screen -X detach` errors for an
    // already-detached session.
    const detachResult = await this.executeCommand(
      serverName,
      `screen -S ${shellQuote(screenName)} -X detach`,
      5000
    );
    if (!detachResult.success || (detachResult.code !== 0 && detachResult.code !== null)) {
      return {
        ok: false,
        reason: detachResult.error || `screen detach command exited with code ${detachResult.code}`
      };
    }

    ({ session, error } = await getSession());
    if (error) return { ok: false, reason: error };
    if (!session) return { ok: false, reason: `screen session "${screenName}" exited while detaching` };
    if (session.state !== 'detached') return { ok: false, reason: `screen session is ${session.state}, not detached` };
    return { ok: true };
  }

  async resolveModuleConfigPath(serverName, serverConfig) {
    const localPath = serverConfig.config_file_location?.trim();
    if (!localPath) return { success: true, configPath: null };

    let content;
    try {
      content = await fs.readFile(localPath, 'utf8');
    } catch (error) {
      const message = error.code === 'ENOENT'
        ? `Config file does not exist on this computer: ${localPath}`
        : `Could not read config file ${localPath}: ${error.message}`;
      log.error(`${serverName}: ${message}`);
      return { success: false, error: message };
    }
    log.info(`${serverName}: Read launcher config file from ${localPath} (${Buffer.byteLength(content, 'utf8')} bytes)`);

    if (isLocalHost(serverConfig.host)) {
      log.debug(`${serverName}: Using local config file ${localPath}`);
      return { success: true, configPath: localPath };
    }

    const homePath = await this.getRemoteHomePath(serverConfig.host, serverConfig.username);
    const extension = path.extname(localPath);
    const safeServerName = serverName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const remotePath = `${homePath}/.afl/configs/${safeServerName}.launch-config${extension}`;
    const upload = await this.writeRemoteFile(serverConfig.host, remotePath, content);
    if (!upload.success) {
      const message = `Could not copy config file to ${serverConfig.host}: ${upload.error}`;
      log.error(`${serverName}: ${message}`);
      return { success: false, error: message };
    }

    log.info(`${serverName}: Copied local config file to ${remotePath}`);
    return { success: true, configPath: remotePath };
  }

  async startServer(serverName) {
    log.info(`Starting server: ${serverName}`);
    const serverConfig = this.config[serverName];
    
    if (!serverConfig) {
      log.error(`Cannot start server: ${serverName} not found in config`);
      return { success: false, error: 'Server not found' };
    }

    let moduleConfigPath = null;
    if (serverConfig.server_module) {
      const configResult = await this.resolveModuleConfigPath(serverName, serverConfig);
      if (!configResult.success) return configResult;
      moduleConfigPath = configResult.configPath;
    }
    
    // Detect remote OS to use appropriate screen options
    const remoteOs = await this.getRemoteOs(serverName);
    const isMacOs = remoteOs === 'darwin';
    log.debug(`${serverName}: Remote OS is ${remoteOs}, isMacOs=${isMacOs}`);
    
    const screenLogPath = path.join('.afl', `${serverConfig.screen_name}.screenlog`);
    let startCommand;

    // Build screen logging options based on OS
    // macOS screen doesn't support -Logfile option, only -L (logs to screenlog.0 in cwd)
    // Linux GNU screen supports -L -Logfile <path>
    let screenLogOpts;
    if (isMacOs) {
      // On macOS, we can't specify logfile location with screen
      // Instead, we'll redirect output within the command
      screenLogOpts = '';
      log.debug(`${serverName}: Using macOS-compatible screen options (no -Logfile)`);
    } else {
      screenLogOpts = `-L -Logfile $\{HOME}/${screenLogPath}`;
      log.debug(`${serverName}: Using Linux screen options with -Logfile`);
    }

    if (serverConfig.server_module) {
      let command = `python -m ${serverConfig.server_module}`;
      if (moduleConfigPath) {
        command += ` --config ${shellQuote(moduleConfigPath)}`;
        log.info(`${serverName}: Launching server with provided config file ${moduleConfigPath}`);
        log.debug(`${serverName}: Using config file ${moduleConfigPath}`);
      }
      log.debug(`${serverName}: Using server_module: ${serverConfig.server_module}`);
      
      // Handle environment activation based on env_type
      if (serverConfig.env_type === 'pip' && serverConfig.virtualenv_path) {
        log.debug(`${serverName}: Activating virtualenv at ${serverConfig.virtualenv_path}`);
        command = `source ${serverConfig.virtualenv_path}/bin/activate;${command}`;
      } else if (serverConfig.conda_env) {
        log.debug(`${serverName}: Activating conda env: ${serverConfig.conda_env}`);
        command = `conda activate ${serverConfig.conda_env};${command}`;
      }
      
      // On macOS, redirect output to log file since screen can't do it
      if (isMacOs) {
        command = `${command} >> $\{HOME}/${screenLogPath} 2>&1`;
      }
      
      startCommand = `screen -d -m ${screenLogOpts} -S ${serverConfig.screen_name} ${serverConfig.shell} -ci ${shellQuote(command)}`;
    } else if (serverConfig.server_script) {
      log.debug(`${serverName}: Using server_script: ${serverConfig.server_script}`);
      if (isMacOs) {
        // Wrap script to redirect output on macOS
        startCommand = `screen -d -m ${screenLogOpts} -S ${serverConfig.screen_name} ${serverConfig.shell} -c "${serverConfig.server_script} >> $\{HOME}/${screenLogPath} 2>&1"`;
      } else {
        startCommand = `screen -d -m ${screenLogOpts} -S ${serverConfig.screen_name} ${serverConfig.server_script}`;
      }
    } else {
      log.error(`${serverName}: Neither server_module nor server_script specified`);
      return { success: false, error: 'Neither server_module nor server_script specified in config' };
    }

    log.info(`${serverName}: Executing start command`);
    log.debug(`${serverName}: Command: ${startCommand}`);
    const result = await this.executeCommand(serverName, startCommand);
    
    if (!result.success) {
      log.error(`${serverName}: Failed to start server - SSH connection failed`);
      return result;
    }
    
    // Log the command output for debugging
    if (result.output && result.output.trim()) {
      log.debug(`${serverName}: Command output:\n${result.output}`);
    }
    
    // Check the exit code - screen -d -m should return 0 on success
    if (result.code !== 0 && result.code !== null) {
      log.error(`${serverName}: Start command failed with exit code ${result.code}`);
      if (result.output && result.output.trim()) {
        log.error(`${serverName}: Command output:\n${result.output}`);
      }
      return { success: false, error: `Start command exited with code ${result.code}`, output: result.output };
    }
    
    const health = await this.waitForServerHealth(
      serverName,
      serverConfig.health_check_attempts || 20,
      serverConfig.health_check_interval_ms || 1000
    );
    if (!health.ok) {
      const reason = health.statusCode ? `HTTP ${health.statusCode}` : health.reason;
      const error = `Server started but is not reachable at ${health.url}: ${reason}`;
      log.error(`${serverName}: ${error}`);
      return { success: false, error, health };
    }

    const detached = await this.ensureScreenDetached(serverName);
    if (!detached.ok) {
      const error = `Server is reachable at ${health.url}, but its screen session could not be detached: ${detached.reason}`;
      log.error(`${serverName}: ${error}`);
      return { success: false, error, health };
    }

    const runtimeConfig = await this.updateAndonRuntimeConfig(serverName, 'running');
    if (!runtimeConfig.success) {
      const error = `Server started, but Andon runtime config could not be updated: ${runtimeConfig.error || 'unknown error'}`;
      log.error(`${serverName}: ${error}`);
      return { success: false, error, health };
    }

    log.info(`${serverName}: Server started, passed health check, and is detached`);
    return { ...result, health };
  }

  async stopServer(serverName) {
    log.info(`Stopping server: ${serverName}`);
    const serverConfig = this.config[serverName];
    
    if (!serverConfig) {
      log.error(`Cannot stop server: ${serverName} not found in config`);
      return { success: false, error: 'Server not found' };
    }
    
    // Build a more robust stop command that:
    // 1. Sends Ctrl+C to the screen session to gracefully stop the process
    // 2. Waits briefly for graceful shutdown
    // 3. Kills any remaining python processes running the server module
    // 4. Quits the screen session
    
    let stopCommands = [];
    
    const remoteOs = await this.getRemoteOs(serverName);
    const isMacOs = remoteOs === 'darwin';
    log.debug(`${serverName}: Remote OS is ${remoteOs}, isMacOs=${isMacOs}`);
    
    const ctrlCCommand = isMacOs
      ? `screen -S ${serverConfig.screen_name} -p 0 -X stuff $'\\003'`
      : `screen -X -S ${serverConfig.screen_name} stuff $'\\003'`;
    
    // First, try to send Ctrl+C (SIGINT) to gracefully stop the server
    stopCommands.push(ctrlCCommand);
    
    // Wait a moment for graceful shutdown
    stopCommands.push('sleep 1');
    
    // Kill any python processes running this specific module (if server_module is set)
    if (serverConfig.server_module) {
      // Use pkill to find and kill python processes running this module
      // The -f flag matches against the full command line
      const modulePattern = serverConfig.server_module.replace(/\./g, '\\.');
      stopCommands.push(`pkill -f "python.*${modulePattern}" 2>/dev/null || true`);
      log.debug(`${serverName}: Will kill processes matching: python.*${modulePattern}`);
    }
    
    // Finally, quit the screen session (ignore errors if already dead)
    stopCommands.push(`screen -X -S ${serverConfig.screen_name} quit 2>/dev/null || true`);
    
    const stopCommand = stopCommands.join('; ');
    log.debug(`${serverName}: Executing stop command: ${stopCommand}`);
    
    const result = await this.executeCommand(serverName, stopCommand);
    
    if (result.success) {
      log.info(`${serverName}: Server stopped successfully`);
      const runtimeConfig = await this.updateAndonRuntimeConfig(serverName, 'stopped');
      if (!runtimeConfig.success) {
        log.error(`${serverName}: Andon runtime config could not be updated after stop: ${runtimeConfig.error || 'unknown error'}`);
        return { success: false, error: runtimeConfig.error || 'Failed to update Andon runtime config' };
      }
    } else {
      log.error(`${serverName}: Failed to stop server`);
    }
    
    return result;
  }

  async restartServer(serverName) {
    log.info(`Restarting server: ${serverName}`);
    const stopResult = await this.stopServer(serverName);
    if (!stopResult.success && !stopResult.sshDown) {
      log.error(`${serverName}: Stop failed during restart`);
      return stopResult;
    }
    
    log.debug(`${serverName}: Stop complete, starting server`);
    const startResult = await this.startServer(serverName);
    
    if (startResult.success) {
      log.info(`${serverName}: Server restarted successfully`);
    }
    
    return startResult;
  }

  async getServerStatus(serverName) {
    const serverConfig = this.config[serverName];
    
    if (!serverConfig) {
      log.error(`Cannot get status: ${serverName} not found in config`);
      return { success: false, error: 'Server not found' };
    }

    log.debug(`${serverName}: Checking status on ${serverConfig.host}`);
    
    // Use the cached screen sessions if they exist for this host and are recent
    const host = serverConfig.host;
    const cachedData = this.screenSessionCache && this.screenSessionCache[host];
    const now = Date.now();
    
    if (cachedData && (now - cachedData.timestamp) < 5000) { // Cache valid for 5 seconds
      const status = cachedData.sessions.includes(serverConfig.screen_name);
      const matchingSession = cachedData.sessionDetails?.find(session => session.name === serverConfig.screen_name);
      log.debug(`${serverName}: Using cached status: ${status} (cache age: ${now - cachedData.timestamp}ms)`);
      return {
        success: true,
        status: status,
        screenState: matchingSession?.state || 'missing'
      };
    }
    
    const statusCommand = 'screen -ls';
    const result = await this.executeCommand(serverName, statusCommand, 500);

    if (!result.success) {
      log.warn(`${serverName}: Failed to get status - SSH down`);
      return { success: false, sshDown: true };
    }
    
    // Parse and cache all screen sessions for this host
    if (!this.screenSessionCache) {
      this.screenSessionCache = {};
    }
    
    const sessionDetails = parseScreenSessions(result.output);
    const screenSessions = sessionDetails
      .filter(session => session.state !== 'dead')
      .map(session => session.name);
    const matchingSession = sessionDetails.find(session => session.name === serverConfig.screen_name);
    
    // Cache the results
    this.screenSessionCache[host] = {
      timestamp: now,
      sessions: screenSessions,
      sessionDetails
    };

    log.debug(`${serverName}: Found ${screenSessions.length} sessions on ${host}: ${screenSessions.join(', ') || '(none)'}`);
    
    const status = screenSessions.includes(serverConfig.screen_name);
    log.debug(`${serverName}: Screen "${serverConfig.screen_name}" is ${status ? 'ACTIVE' : 'INACTIVE'}`);
    
    return {
      success: true,
      status: status,
      screenState: matchingSession?.state || 'missing'
    };
  }

  // Get status for all servers on a given host in one call
  async getBatchServerStatus(host) {
    // Find a server from this host to execute the command
    const serverName = Object.keys(this.config).find(name =>
      this.config[name].host === host
    );
    
    if (!serverName) {
      log.error(`No server configured for host ${host}`);
      return { success: false, error: `No server configured for host ${host}` };
    }
    
    log.debug(`Batch status check for host ${host} using ${serverName}`);
    const statusCommand = 'screen -ls';
    const result = await this.executeCommand(serverName, statusCommand, 500);
    
    if (!result.success) {
      log.warn(`Batch status check failed for host ${host} - SSH down`);
      return { success: false, sshDown: true, host };
    }
    
    const sessionDetails = parseScreenSessions(result.output);
    const screenSessions = sessionDetails
      .filter(session => session.state !== 'dead')
      .map(session => session.name);
    
    // Cache the results
    const now = Date.now();
    if (!this.screenSessionCache) {
      this.screenSessionCache = {};
    }
    this.screenSessionCache[host] = {
      timestamp: now,
      sessions: screenSessions,
      sessionDetails
    };
    
    log.debug(`Host ${host}: Found ${screenSessions.length} screen sessions: ${screenSessions.join(', ') || '(none)'}`);
    
    return { success: true, host, sessions: screenSessions, sessionDetails };
  }
  
  // Group all servers by host for efficient batch checking
  getServersByHost() {
    const hostMap = {};
    
    Object.entries(this.config).forEach(([serverName, serverConfig]) => {
      if (!serverConfig.active) return;
      
      const host = serverConfig.host;
      if (!hostMap[host]) {
        hostMap[host] = [];
      }
      hostMap[host].push(serverName);
    });
    
    log.debug(`Servers grouped by host: ${Object.entries(hostMap).map(([h, s]) => `${h}(${s.length})`).join(', ')}`);
    
    return hostMap;
  }
  
  async getServerLog(serverName, lines = 200) {
    log.info(`Getting log for ${serverName} (last ${lines} lines)`);
    const serverConfig = this.config[serverName];
    
    if (!serverConfig) {
      log.error(`Cannot get log: ${serverName} not found in config`);
      return { success: false, error: 'Server not found' };
    }
    
    const logPath = path.join('.afl', `${serverConfig.screen_name}.screenlog`);
    const logCommand = `tail -n ${lines} $\{HOME}/${logPath}`;
    log.debug(`${serverName}: Log command: ${logCommand}`);
    
    const result = await this.executeCommand(serverName, logCommand);
    
    if (result.success) {
      log.debug(`${serverName}: Retrieved ${result.output?.length || 0} bytes of log`);
    } else {
      log.error(`${serverName}: Failed to retrieve log`);
    }
    
    return result;
  }

  async joinServer(serverName) {
    log.info(`Joining server session: ${serverName}`);
    const serverConfig = this.config[serverName];
    
    if (!serverConfig) {
      log.error(`Cannot join server: ${serverName} not found in config`);
      return { success: false, error: 'Server not found' };
    }
    
    const joinCommand = `screen -x ${serverConfig.screen_name}`;
    log.debug(`${serverName}: Join command: ${joinCommand}`);
    return this.executeCommand(serverName, joinCommand);
  }

  getServerForHost(host) {
    const entry = Object.entries(this.config).find(([, cfg]) => cfg.host === host);
    if (!entry) {
      log.debug(`No server found for host ${host}`);
      return null;
    }
    log.debug(`Found server for host ${host}: ${entry[0]}`);
    return entry[1];
  }

  getServerNameForHost(host) {
    const entry = Object.entries(this.config).find(([, cfg]) => cfg.host === host);
    return entry ? entry[0] : null;
  }

  async readRemoteFile(host, remotePath) {
    const server = this.getServerForHost(host);
    const serverName = this.getServerNameForHost(host);
    if (!server) {
      log.error(`Cannot read remote file: no server for host ${host}`);
      return { success: false, error: `No server for host ${host}` };
    }
    
    log.info(`Reading remote file ${remotePath} from ${host}`);

    let conn;
    try {
      ({ conn } = await this.connectWithAvailableKeys(serverName, 5000));
    } catch (error) {
      log.error(`Connection error reading ${remotePath} on ${host}:`, error.message);
      return { success: false, error: error.message };
    }

    return new Promise((resolve) => {
      log.debug(`SFTP connection ready for ${host}`);
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          log.error(`SFTP error reading ${remotePath} on ${host}:`, err.message);
          resolve({ success: false, error: err.message });
          return;
        }
        sftp.readFile(remotePath, 'utf8', (err, data) => {
          conn.end();
          if (err) {
            log.error(`Failed to read ${remotePath} on ${host}:`, err.message);
            resolve({ success: false, error: err.message });
          } else {
            log.info(`Successfully read ${remotePath} from ${host} (${data.length} bytes)`);
            resolve({ success: true, data });
          }
        });
      });
    });
  }

  async writeRemoteFile(host, remotePath, content) {
    const server = this.getServerForHost(host);
    const serverName = this.getServerNameForHost(host);
    if (!server) {
      log.error(`Cannot write remote file: no server for host ${host}`);
      return { success: false, error: `No server for host ${host}` };
    }
    
    log.info(`Writing remote file ${remotePath} to ${host}`);

    let conn;
    try {
      ({ conn } = await this.connectWithAvailableKeys(serverName, 5000));
    } catch (error) {
      log.error(`Connection error writing ${remotePath} on ${host}:`, error.message);
      return { success: false, error: error.message };
    }

    return new Promise((resolve) => {
      log.debug(`SFTP connection ready for ${host}`);
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          log.error(`SFTP error writing ${remotePath} on ${host}:`, err.message);
          resolve({ success: false, error: err.message });
          return;
        }
        const dir = path.posix.dirname(remotePath);
        const parentDir = path.posix.dirname(dir);
        log.debug(`Creating directories ${parentDir} and ${dir} on ${host}`);
        sftp.mkdir(parentDir, { mode: 0o755 }, () => {
          sftp.mkdir(dir, { mode: 0o755 }, () => {
            sftp.writeFile(remotePath, content, 'utf8', (err2) => {
              conn.end();
              if (err2) {
                log.error(`Failed to write ${remotePath} on ${host}:`, err2.message);
                resolve({ success: false, error: err2.message });
              } else {
                log.info(`Successfully wrote ${remotePath} to ${host} (${content.length} bytes)`);
                resolve({ success: true });
              }
              });
          });
        });
      });
    });
  }

  async getRemoteAflConfig(host) {
    const server = this.getServerForHost(host);
    if (!server) {
      log.error(`Cannot get Andon config: no server for host ${host}`);
      return { success: false, error: `No server for host ${host}` };
    }
    
    const homePath = await this.getRemoteHomePath(host, server.username);
    const remotePath = `${homePath}/.afl/configs/${ANDON_CONFIG_FILENAME}`;
    log.info(`Getting Andon config from ${host}: ${remotePath}`);
    
    const res = await this.readRemoteFile(host, remotePath);
    if (!res.success) {
      if (/no such file|enoent/i.test(res.error || '')) {
        log.info(`No Andon config exists yet on ${host}`);
        return { success: true, data: {} };
      }
      return res;
    }
    
    try {
      const parsed = JSON.parse(res.data);
      const keyCount = Object.keys(parsed).length;
      log.info(`Parsed Andon config from ${host}: ${keyCount} entries`);
      return { success: true, data: parsed };
    } catch (parseError) {
      log.warn(`Remote Andon config on ${host} is empty or invalid JSON: ${parseError.message}`);
      return { success: true, data: {} };
    }
  }

  async saveRemoteAflConfig(host, cfgObj) {
    const server = this.getServerForHost(host);
    if (!server) {
      log.error(`Cannot save Andon config: no server for host ${host}`);
      return { success: false, error: `No server for host ${host}` };
    }
    
    const homePath = await this.getRemoteHomePath(host, server.username);
    const remotePath = `${homePath}/.afl/configs/${ANDON_CONFIG_FILENAME}`;
    log.info(`Saving Andon config to ${remotePath} on ${host}`);
    
    const { driver_custom_configs, ...andonConfig } = cfgObj || {};
    const content = JSON.stringify(andonConfig, null, 2);
    
    const res = await this.writeRemoteFile(host, remotePath, content);
    if (res.success) {
      log.info(`Andon config saved successfully on ${host}`);
    }
    return res;
  }

  async updateAndonRuntimeConfig(serverName, state) {
    const serverConfig = this.config[serverName];
    if (!serverConfig) return { success: false, error: 'Server not found' };

    const host = serverConfig.host;
    const current = await this.getRemoteAflConfig(host);
    if (!current.success) return current;

    const { driver_custom_configs, ...andonConfig } = current.data || {};
    const launchers = andonConfig.launchers || {};
    const previous = launchers[serverName] || {};
    const timestamp = new Date().toISOString();
    launchers[serverName] = {
      ...previous,
      ...serverConfig,
      runtime_state: state,
      ...(state === 'running' ? { started_at: timestamp } : { stopped_at: timestamp }),
    };
    andonConfig.launchers = launchers;

    return this.saveRemoteAflConfig(host, andonConfig);
  }
}

module.exports = SSHOperations;
