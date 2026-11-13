'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// Exclusive creation preserves existing deployments, including concurrent setup.
async function ensureJsonObjectFile(configPath, description) {
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(configPath, '{}\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  let config;
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${description.toLowerCase()} ${configPath}: ${error.message}`, { cause: error });
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${description} ${configPath} must contain a JSON object (use {} for an empty installation).`);
  }
  return config;
}

function ensureLauncherConfig(configPath) {
  return ensureJsonObjectFile(configPath, 'Launcher configuration');
}

function ensureAndonConfig(configPath) {
  return ensureJsonObjectFile(configPath, 'Andon configuration');
}

module.exports = { ensureLauncherConfig, ensureAndonConfig };
