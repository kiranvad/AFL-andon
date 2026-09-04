// logger.js
// Centralized logging module for AFL-andon with Python-style formatting
const path = require('path');
const os = require('os');

// Determine if we're in the main process or renderer
const isMain = process.type === 'browser';

// Get log level from environment variable, default to 'info'
// Set AFL_ANDON_LOG_LEVEL=debug for verbose output
const logLevel = (process.env.AFL_ANDON_LOG_LEVEL || 'info').toLowerCase();

// Valid log levels with numeric priorities
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  verbose: 4,
  silly: 5
};

// Python-style log level names for display
const LEVEL_NAMES = {
  error: 'ERROR',
  warn: 'WARNING',
  info: 'INFO',
  debug: 'DEBUG',
  verbose: 'DEBUG',
  silly: 'TRACE'
};

const currentLevel = LOG_LEVELS[logLevel] ?? LOG_LEVELS.debug;
let logSink = null;

function stringifyArgs(args) {
  return args.map(item => {
    if (item === null) return 'null';
    if (item === undefined) return 'undefined';
    if (item instanceof Error) {
      return item.stack || item.message || String(item);
    }
    if (typeof item === 'object') {
      try {
        return JSON.stringify(item, null, 2);
      } catch {
        return String(item);
      }
    }
    return String(item);
  }).join(' ');
}

function emitLogEntry(level, moduleName, args) {
  if (!logSink) return;
  try {
    logSink({ level, moduleName, text: stringifyArgs(args), observedAt: Date.now() });
  } catch (_) {
    // Logging must never interrupt application behavior.
  }
}

function setLogSink(sink) {
  logSink = typeof sink === 'function' ? sink : null;
}

// Create Python-style format: "2025-12-02 10:30:45,123 - module - LEVEL - message"
function formatDate() {
  const date = new Date();
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const ms = pad(date.getMilliseconds(), 3);
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds},${ms}`;
}

function formatMessage(level, moduleName, args) {
  const timestamp = formatDate();
  const levelName = (LEVEL_NAMES[level] || level.toUpperCase()).padEnd(7);
  const modName = moduleName.padEnd(15);
  
  const text = stringifyArgs(args);
  
  return `[${timestamp}] [${levelName.toLowerCase().trim()}] [${moduleName}] ${text}`;
}

// Create a simple logger that writes to console
function createSimpleLogger(moduleName) {
  const logFn = (level, ...args) => {
    if (LOG_LEVELS[level] > currentLevel) return;
    const message = formatMessage(level, moduleName, args);
    emitLogEntry(level, moduleName, args);
    
    if (level === 'error') {
      console.error(message);
    } else if (level === 'warn') {
      console.warn(message);
    } else {
      console.log(message);
    }
  };
  
  return {
    error: (...args) => logFn('error', ...args),
    warn: (...args) => logFn('warn', ...args),
    info: (...args) => logFn('info', ...args),
    debug: (...args) => logFn('debug', ...args),
    verbose: (...args) => logFn('verbose', ...args),
    silly: (...args) => logFn('silly', ...args),
  };
}

// For main process, also set up file logging
let log;
let logFilePath;

if (isMain) {
  const electronLog = require('electron-log');
  
  // Configure console transport
  electronLog.transports.console.format = '[{y}-{m}-{d} {h}:{i}:{s},{ms}] [{level}] {text}';
  electronLog.transports.console.level = logLevel;
  
  // Configure file transport
  const logDir = path.join(os.homedir(), '.afl', 'logs');
  logFilePath = path.join(logDir, 'afl-andon.log');
  electronLog.transports.file.resolvePathFn = () => logFilePath;
  electronLog.transports.file.level = logLevel;
  electronLog.transports.file.maxSize = 10 * 1024 * 1024; // 10 MB max
  electronLog.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s},{ms}] [{level}] {text}';
  
  log = electronLog;
} else {
  // Renderer process - use simple console logger
  logFilePath = path.join(os.homedir(), '.afl', 'logs', 'afl-andon.log');
  log = createSimpleLogger('renderer');
}

// Create module-specific logger factory
function createLogger(moduleName) {
  if (isMain && log.info) {
    // Main process with electron-log
    const prefix = `[${moduleName}]`;
    const logFn = (level, ...args) => {
      log[level](prefix, ...args);
      if (LOG_LEVELS[level] <= currentLevel) emitLogEntry(level, moduleName, args);
    };
    return {
      error: (...args) => logFn('error', ...args),
      warn: (...args) => logFn('warn', ...args),
      info: (...args) => logFn('info', ...args),
      debug: (...args) => logFn('debug', ...args),
      verbose: (...args) => logFn('verbose', ...args),
      silly: (...args) => logFn('silly', ...args),
    };
  } else {
    // Renderer process - use simple logger
    return createSimpleLogger(moduleName);
  }
}

// Log startup info (only in main process to avoid duplicates)
if (isMain) {
  log.info('[logger] AFL-andon logger initialized');
  log.info(`[logger] Log level: ${logLevel}`);
  log.info(`[logger] Log file: ${logFilePath}`);
}

// Export the configured logger and factory
module.exports = log;
module.exports.createLogger = createLogger;
module.exports.logFilePath = logFilePath;
module.exports.setLogSink = setLogSink;
