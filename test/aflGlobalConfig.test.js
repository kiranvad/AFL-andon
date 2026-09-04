'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { formatTimestamp, updateAflTiledConfig } = require('../aflGlobalConfig');

test('updates Tiled settings by appending an AFL configuration record', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'andon-afl-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    '26/30/08 12:00:00.000000': {
      system_serial: 'Balto',
      tiled_server: 'http://localhost:8000',
      tiled_api_key: 'old-key',
      ports: { RGBCamera: 5095 }
    }
  }));

  const now = new Date(2026, 7, 31, 17, 30, 15, 123);
  const result = await updateAflTiledConfig(
    configPath,
    'http://192.0.2.10:8000/',
    'nas-key',
    { now }
  );
  const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));

  assert.equal(result.timestamp, formatTimestamp(now));
  assert.equal(Object.keys(updated).length, 2);
  assert.equal(updated['26/30/08 12:00:00.000000'].tiled_server, 'http://localhost:8000');
  assert.deepEqual(updated[result.timestamp], {
    system_serial: 'Balto',
    tiled_server: 'http://192.0.2.10:8000',
    tiled_api_key: 'nas-key',
    ports: { RGBCamera: 5095 }
  });
});
