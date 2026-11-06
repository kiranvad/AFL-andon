'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const SSHOperations = require('../sshOperations');

test('config-location metadata survives launcher loading, grouping, and saving', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'andon-config-locations-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'launchers.json');
  await fs.writeFile(configPath, JSON.stringify({
    configs_locations: './profiles',
    worker: { host: 'worker.example', username: 'test-user', server_module: 'AFL.double_agent.AgentDriver', ssh_authentication: 'password' }
  }));
  const operations = new SSHOperations(configPath);
  await operations.loadConfig();
  assert.equal(operations.config.configs_locations, './profiles');
  assert.equal(operations.config.worker.httpPort, 5000);
  assert.equal(operations.config.worker.username, 'test-user');
  assert.equal(operations.config.worker.ssh_authentication, 'password');
  assert.deepEqual(operations.getServersByHost(), { 'worker.example': ['worker'] });
  await operations.saveConfig();
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(saved.configs_locations, './profiles');
  assert.equal(saved.worker.server_module, 'AFL.double_agent.AgentDriver');
});
