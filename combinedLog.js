'use strict';

const fs = require('fs').promises;
const os = require('os');
const path = require('path');

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

function startupTimestamp(date) {
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-') +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

function formatEntry(entry) {
  const observedAt = new Date(Number.isFinite(entry.observedAt) ? entry.observedAt : Date.now());
  const timestamp = `${observedAt.getFullYear()}-${pad(observedAt.getMonth() + 1)}-${pad(observedAt.getDate())} ` +
    `${pad(observedAt.getHours())}:${pad(observedAt.getMinutes())}:${pad(observedAt.getSeconds())}.${pad(observedAt.getMilliseconds(), 3)}`;
  return `[${timestamp}] [${String(entry.server || 'unknown')}] ${String(entry.text ?? '')}\n`;
}

class CombinedLogWriter {
  constructor({ startupTime = new Date(), logRoot = path.join(os.homedir(), '.afl', 'logs') } = {}) {
    this.directory = path.join(logRoot, 'combined');
    this.filePath = path.join(this.directory, `andon-${startupTimestamp(startupTime)}.log`);
    this.writeQueue = Promise.resolve();
  }

  append(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return this.writeQueue;
    const contents = entries.map(formatEntry).join('');
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      await fs.appendFile(this.filePath, contents, 'utf8');
    });
    return this.writeQueue;
  }

  flush() {
    return this.writeQueue;
  }
}

module.exports = { CombinedLogWriter, formatEntry, startupTimestamp };
