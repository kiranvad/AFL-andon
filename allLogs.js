'use strict';

const MAX_MERGED_LINES = 10000;

function decodeLogChunk(remainder, chunk) {
  const combined = `${remainder || ''}${chunk || ''}`;
  const lines = [];
  let start = 0;
  for (let index = 0; index < combined.length; index += 1) {
    const character = combined[index];
    if (character !== '\n' && character !== '\r') continue;
    if (character === '\r' && index === combined.length - 1) break;
    lines.push(combined.slice(start, index));
    if (character === '\r' && combined[index + 1] === '\n') index += 1;
    start = index + 1;
  }
  return { lines, remainder: combined.slice(start) };
}

function stripTerminalControl(value) {
  return String(value || '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[@-_]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function capEntries(entries, limit = MAX_MERGED_LINES) {
  const safeLimit = Math.max(0, Number.isInteger(limit) ? limit : MAX_MERGED_LINES);
  return entries.length > safeLimit ? entries.slice(entries.length - safeLimit) : entries;
}

function filterEntries(entries, enabledServers, search = '') {
  const query = String(search).trim().toLocaleLowerCase();
  return entries.filter(entry => {
    if (enabledServers && !enabledServers.has(entry.server)) return false;
    return !query || String(entry.text).toLocaleLowerCase().includes(query) ||
      String(entry.server).toLocaleLowerCase().includes(query);
  });
}

function stableServerColor(serverName) {
  let hash = 0;
  for (const character of String(serverName)) {
    hash = ((hash << 5) - hash + character.codePointAt(0)) | 0;
  }
  return `hsl(${Math.abs(hash) % 360} 68% 42%)`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRoutineHealthLog(serverName, serverConfig, line) {
  const isTiled = serverConfig?.server_type === 'tiled' ||
    String(serverName || '').trim().toLocaleLowerCase() === 'tiled';
  if (!isTiled) return false;

  let healthPath = '/queue_state';
  if (serverConfig?.status_url) {
    try {
      healthPath = new URL(serverConfig.status_url).pathname || '/';
    } catch (_) {
      return false;
    }
  }
  const pathPattern = escapeRegExp(healthPath.replace(/\/$/, '') || '/');
  return new RegExp(`(?:"|\\s)GET\\s+${pathPattern}(?:\\?[^\\s"]*)?\\s+HTTP\\/\\d(?:\\.\\d)?"?\\s+2\\d\\d(?:\\s|$)`, 'i')
    .test(String(line));
}

module.exports = {
  MAX_MERGED_LINES,
  decodeLogChunk,
  stripTerminalControl,
  capEntries,
  filterEntries,
  stableServerColor,
  isRoutineHealthLog
};
