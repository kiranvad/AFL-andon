'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const TIMESTAMP_PATTERN = /^(\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{6})$/;

function timestampValue(value) {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return Number.NEGATIVE_INFINITY;
  const [, year, day, month, hour, minute, second, microsecond] = match;
  return new Date(
    2000 + Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Math.floor(Number(microsecond) / 1000)
  ).getTime();
}

function formatTimestamp(date = new Date(), suffix = 0) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const microseconds = (date.getMilliseconds() * 1000) + suffix;
  return [
    `${pad(date.getFullYear() % 100)}/${pad(date.getDate())}/${pad(date.getMonth() + 1)}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(microseconds, 6)}`
  ].join(' ');
}

function newestRecord(config) {
  const entries = Object.entries(config);
  if (entries.length === 0) return {};
  entries.sort(([left], [right]) => timestampValue(right) - timestampValue(left));
  return entries[0][1] && typeof entries[0][1] === 'object' && !Array.isArray(entries[0][1])
    ? entries[0][1]
    : {};
}

async function updateAflTiledConfig(configPath, tiledServer, tiledApiKey, options = {}) {
  const url = new URL(String(tiledServer || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('The active Tiled server must use HTTP or HTTPS.');
  }

  let config = {};
  let mode = 0o600;
  try {
    const [contents, stat] = await Promise.all([
      fs.readFile(configPath, 'utf8'),
      fs.stat(configPath)
    ]);
    config = JSON.parse(contents);
    mode = stat.mode & 0o777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`AFL global config ${configPath} must contain a JSON object.`);
  }

  const record = {
    ...newestRecord(config),
    tiled_server: url.toString().replace(/\/$/, ''),
    tiled_api_key: String(tiledApiKey || '').trim()
  };
  const now = options.now || new Date();
  let suffix = 0;
  let timestamp = formatTimestamp(now, suffix);
  while (Object.hasOwn(config, timestamp)) {
    suffix += 1;
    timestamp = formatTimestamp(now, suffix);
  }
  config[timestamp] = record;

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 4)}\n`, { mode });
    await fs.rename(temporaryPath, configPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return { timestamp, record };
}

module.exports = { formatTimestamp, updateAflTiledConfig };
