'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const SSHOperations = require('../sshOperations');

test('HTTP Tiled launches an AFL proxy on the card host and port using its virtualenv', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'andon-proxy-launch-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'launchers.json');
  const profilePath = path.join(directory, 'http.yml');
  await fs.writeFile(profilePath, 'uri: http://tiled.example:8000\napi_key: test-key\n');
  await fs.writeFile(configPath, JSON.stringify({ tiled: {
    server_type: 'tiled', host: 'localhost', username: os.userInfo().username,
    screen_name: 'TiledProxy', httpPort: 8001, config_file_location: profilePath,
    env_type: 'pip', virtualenv_path: '/control/.venv', ssh_authentication: 'key'
  } }));
  const operations = new SSHOperations(configPath, undefined, {
    aflGlobalConfigPath: path.join(directory, 'config.json')
  });
  await operations.loadConfig();
  assert.equal(operations.config.tiled.host, 'localhost');
  assert.equal(operations.config.tiled.httpPort, 8001);
  assert.equal(operations.config.tiled.external_service, false);
  assert.equal(operations.isDockerComposeManaged(operations.config.tiled), false);
  assert.deepEqual(operations.getServersByHost(), { localhost: ['tiled'] });
  const commands = [];
  operations.getRemoteOs = async () => 'linux';
  operations.executeCommand = async (_name, command) => {
    commands.push(command);
    return { success: true, code: 0, output: '' };
  };
  operations.updateAndonRuntimeConfig = async () => ({ success: true });
  operations.ensureScreenDetached = async () => ({ ok: true });
  operations.waitForServerHealth = async () => ({ ok: true, statusCode: 200 });
  assert.equal((await operations.startServer('tiled')).success, true);
  const launch = commands.find(command => command.startsWith('screen -d -m'));
  assert.match(launch, /-m AFL\.automation\.shared\.TiledProxyDriver/);
  assert.match(launch, /source.*\/control\/\.venv\/bin\/activate/);
  assert.match(launch, /--port.*8001/);
  assert.match(launch, /--host.*127\.0\.0\.1/);
  assert.equal(launch.includes('test-key'), false);
  assert.equal(launch.includes('docker compose'), false);
  assert.equal(launch.includes('tiled serve config'), false);
  let observedUrl;
  t.mock.method(global, 'fetch', async url => {
    observedUrl = url;
    return { ok: true, status: 200 };
  });
  assert.equal((await operations.probeServerHealth('tiled')).ok, true);
  assert.equal(observedUrl, 'http://localhost:8001/api/v1/metadata/');
  const record = Object.values(JSON.parse(await fs.readFile(path.join(directory, 'config.json')))).at(-1);
  assert.equal(record.tiled_server, 'http://tiled.example:8000');
  assert.equal((await operations.stopServer('tiled')).success, true);
  assert.ok(commands.some(command => command.includes('screen -X -S TiledProxy quit')));
  assert.ok(commands.every(command => !command.includes('docker compose')));
});
