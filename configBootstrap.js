'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// Exclusive creation preserves existing deployments, including concurrent setup.
async function ensureLauncherConfig(configPath) {
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
    throw new Error(`Cannot read launcher configuration ${configPath}: ${error.message}`, { cause: error });
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Launcher configuration ${configPath} must contain a JSON object (use {} for an empty installation).`);
  }
  return config;
}

module.exports = { ensureLauncherConfig };
