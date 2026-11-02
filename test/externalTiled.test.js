const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SSHOperations = require('../sshOperations');

test('a Docker Compose Tiled profile disconnects without stopping the service', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'andon-external-tiled-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const profilePath = path.join(directory, 'nas.yaml');
  const configPath = path.join(directory, 'launchers.json');
  await fs.writeFile(profilePath, `
uri: http://192.0.2.10:8000
api_key: test-secret
management:
  type: docker_compose
  authentication: password
  host: 192.0.2.10
  username: root
  project_directory: /srv/tiled-project
  service: tiled
`);
  await fs.writeFile(configPath, JSON.stringify({
    aflnas_tiled: {
      server_type: 'tiled',
      config_file_location: profilePath,
      host: 'localhost',
      username: 'test',
      httpPort: 8000,
      screen_name: 'must-not-run',
      active: true
    }
  }));

  const operations = new SSHOperations(configPath, undefined, {
    aflGlobalConfigPath: path.join(directory, 'afl-global-config.json')
  });
  await operations.loadConfig();
  const server = operations.config.aflnas_tiled;

  assert.equal(server.external_service, true);
  assert.equal(server.host, '192.0.2.10');
  assert.equal(server.username, 'root');
  assert.equal(server.httpPort, 8000);
  assert.equal(server.tiled_profile_uri, 'http://192.0.2.10:8000/');
  assert.deepEqual(operations.getServersByHost(), {});

  const commands = [];
  const commandOptions = [];
  operations.executeCommand = async (_serverName, command, _timeout, options) => {
    commands.push(command);
    commandOptions.push(options);
    return {
      success: true,
      code: 0,
      output: command.includes('ps --status running') ? 'container-id\n' : 'compose output\n'
    };
  };
  operations.waitForServerHealth = async () => ({ ok: true, statusCode: 200 });

  assert.deepEqual(await operations.getServerStatus('aflnas_tiled'), {
    success: false,
    status: false,
    authenticationRequired: true,
    managementType: 'docker_compose',
    screenState: 'unknown'
  });
  operations.setSessionPassword('aflnas_tiled', 'test-password');

  assert.deepEqual(await operations.getServerStatus('aflnas_tiled'), {
    success: true,
    status: true,
    managementType: 'docker_compose',
    screenState: 'running'
  });
  assert.equal((await operations.startServer('aflnas_tiled')).success, true);
  const aflGlobalConfig = JSON.parse(await fs.readFile(path.join(directory, 'afl-global-config.json'), 'utf8'));
  assert.deepEqual(Object.values(aflGlobalConfig).at(-1), {
    tiled_server: 'http://192.0.2.10:8000',
    tiled_api_key: 'test-secret'
  });
  const commandCountBeforeStop = commands.length;
  operations.clearSessionPassword('aflnas_tiled');
  assert.deepEqual(await operations.stopServer('aflnas_tiled'), {
    success: true,
    disconnected: true,
    status: false,
    managementType: 'docker_compose',
    screenState: 'disconnected'
  });
  assert.equal(commands.length, commandCountBeforeStop);
  operations.setSessionPassword('aflnas_tiled', 'test-password');
  assert.equal((await operations.restartServer('aflnas_tiled')).success, true);
  assert.equal((await operations.getServerLog('aflnas_tiled')).success, true);
  assert.equal((await operations.joinServer('aflnas_tiled')).success, true);
  assert.equal(commands.length, 5);
  assert.ok(commands.every(command => command.startsWith("sudo -S -p '")));
  assert.match(commands[0], /docker compose ps --status running --quiet/);
  assert.match(commands[1], /test -d/);
  assert.match(commands[1], /docker compose config --services/);
  assert.match(commands[1], /docker compose up -d/);
  assert.match(commands[2], /docker compose restart/);
  assert.match(commands[3], /docker compose logs --tail=200/);
  assert.match(commands[4], /docker compose exec/);
  assert.ok(commandOptions.every(options => options.stdin === 'test-password\n'));
  assert.equal(commandOptions[4].pty, true);

  await fs.writeFile(profilePath, 'uvicorn:\n  port: 8000\ntrees:\n  - path: /\n    tree: catalog\n');
  await operations.loadConfig();
  assert.equal(operations.config.aflnas_tiled.external_service, false);
  assert.deepEqual(operations.config.aflnas_tiled.tiled_management, { type: 'screen' });
  assert.equal(operations.config.aflnas_tiled.tiled_profile_uri, undefined);
  assert.deepEqual(operations.getServersByHost(), { localhost: ['aflnas_tiled'] });
});

test('Docker Compose start validates the project and skips an already-running service', async () => {
  const operations = new SSHOperations('/tmp/config');
  operations.config = {
    tiled: {
      server_type: 'tiled',
      host: 'nas',
      username: 'admin',
      tiled_management: {
        type: 'docker_compose',
        authentication: 'password',
        projectDirectory: '/volume1/docker/tiled',
        service: 'tiled'
      }
    }
  };
  operations.setSessionPassword('tiled', 'secret');
  operations.executeCommand = async (_serverName, command, _timeout, options) => {
    assert.match(command, /test -d/);
    assert.match(command, /docker compose config --services/);
    assert.equal(options.stdin, 'secret\n');
    return { success: true, code: 0, output: '__AFL_ANDON_ALREADY_RUNNING__\n' };
  };
  operations.waitForServerHealth = async () => ({ ok: true, statusCode: 200 });
  operations.activateTiledForSession = async () => ({});

  const result = await operations.startServer('tiled');
  assert.equal(result.success, true);
  assert.equal(result.alreadyRunning, true);
});

test('Docker Compose start reports a missing project instead of launching', async () => {
  const operations = new SSHOperations('/tmp/config');
  operations.config = {
    tiled: {
      server_type: 'tiled',
      host: 'nas',
      username: 'admin',
      tiled_management: {
        type: 'docker_compose',
        authentication: 'password',
        projectDirectory: '/volume1/docker/tiled',
        service: 'tiled'
      }
    }
  };
  operations.setSessionPassword('tiled', 'secret');
  operations.activateTiledForSession = async () => ({});
  operations.executeCommand = async () => ({
    success: true,
    code: 40,
    output: '__AFL_ANDON_PROJECT_MISSING__\n'
  });

  const result = await operations.startServer('tiled');
  assert.equal(result.success, false);
  assert.match(result.error, /project directory does not exist/);

  operations.executeCommand = async () => ({
    success: true,
    code: 41,
    output: '__AFL_ANDON_SERVICE_MISSING__\n'
  });
  const missingService = await operations.startServer('tiled');
  assert.equal(missingService.success, false);
  assert.match(missingService.error, /service "tiled" is not declared/);
});

test('native Tiled activation uses the API root instead of its browser URL', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'andon-native-tiled-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, 'tiled.yml');
  const globalConfigPath = path.join(directory, 'config.json');
  await fs.writeFile(profilePath, `
authentication:
  single_user_api_key: config-key
uvicorn:
  port: 8000
trees:
  - path: /
    tree: catalog
`);

  const operations = new SSHOperations('/tmp/config', undefined, {
    aflGlobalConfigPath: globalConfigPath
  });
  operations.config = {
    tiled: {
      server_type: 'tiled',
      config_file_location: profilePath,
      host: 'localhost',
      httpPort: 8000,
      webview_url: 'http://localhost:8000/ui/browse?api_key=browser-key'
    }
  };

  const result = await operations.activateTiledForSession('tiled');

  assert.equal(result.record.tiled_server, 'http://localhost:8000');
  assert.equal(result.record.tiled_api_key, 'config-key');
});

test('remote drivers receive a Tiled URL reachable from their SSH host', async () => {
  const operations = new SSHOperations('/tmp/config');
  operations.config = {
    gripper: {
      host: '10.42.0.186',
      username: 'pi',
      server_module: 'AFL.automation.manipulate.ElectrochemGripper'
    }
  };
  operations.activeTiledConnection = {
    serverName: 'tiled',
    tiledServer: 'http://localhost:8000',
    tiledApiKey: 'config-key'
  };
  operations.executeCommand = async (_serverName, command, _timeout, options) => {
    if (command.includes('SSH_CONNECTION')) {
      return { success: true, code: 0, output: '10.42.0.1 45678 10.42.0.186 22\n' };
    }
    assert.match(command, /curl .*http:\/\/10\.42\.0\.1:8000\/api\/v1\/metadata\//);
    assert.doesNotMatch(command, /config-key/);
    assert.equal(options.stdin, 'config-key\n');
    return { success: true, code: 0, output: '200' };
  };
  operations.getRemoteHomePath = async () => '/home/pi';
  operations.readRemoteFile = async () => ({
    success: true,
    data: JSON.stringify({
      '26/07/10 14:00:00.000000': {
        system_serial: 'gripper',
        tiled_server: '',
        tiled_api_key: '',
        ports: { ElectrochemGripper: 5058 }
      }
    })
  });
  let written;
  operations.writeRemoteFile = async (host, remotePath, content) => {
    written = { host, remotePath, config: JSON.parse(content) };
    return { success: true };
  };

  const result = await operations.syncActiveTiledConfigForDriver('gripper');
  const newest = Object.values(written.config).at(-1);

  assert.equal(result.success, true);
  assert.equal(written.host, '10.42.0.186');
  assert.equal(written.remotePath, '/home/pi/.afl/config.json');
  assert.equal(newest.tiled_server, 'http://10.42.0.1:8000');
  assert.equal(newest.tiled_api_key, 'config-key');
  assert.deepEqual(newest.ports, { ElectrochemGripper: 5058 });
});

test('remote Tiled synchronization fails when Tiled is unreachable from the driver host', async () => {
  const operations = new SSHOperations('/tmp/config');
  operations.config = {
    gripper: {
      host: '10.42.0.186',
      username: 'pi',
      server_module: 'AFL.automation.manipulate.ElectrochemGripper'
    }
  };
  operations.activeTiledConnection = {
    serverName: 'tiled',
    tiledServer: 'http://10.42.0.1:8000',
    tiledApiKey: 'config-key'
  };
  operations.executeCommand = async (_serverName, command) => {
    assert.match(command, /api\/v1\/metadata/);
    return { success: true, code: 7, output: '' };
  };
  operations.readRemoteFile = async () => {
    assert.fail('an unreachable Tiled service must not update remote configuration');
  };

  const result = await operations.syncActiveTiledConfigForDriver('gripper');

  assert.equal(result.success, false);
  assert.match(result.error, /Tiled connection failed/);
  assert.match(result.error, /http:\/\/10\.42\.0\.1:8000/);
});

test('local drivers verify Tiled at its API address', async () => {
  const operations = new SSHOperations('/tmp/config');
  operations.config = {
    camera: {
      host: 'localhost',
      server_module: 'AFL.automation.vision.RGBCamera'
    }
  };
  operations.activeTiledConnection = {
    serverName: 'tiled',
    tiledServer: 'http://localhost:8000',
    tiledApiKey: 'config-key'
  };
  operations.executeCommand = async (_serverName, command, _timeout, options) => {
    assert.match(command, /http:\/\/localhost:8000\/api\/v1\/metadata\//);
    assert.doesNotMatch(command, /config-key/);
    assert.equal(options.stdin, 'config-key\n');
    return { success: true, code: 0, output: '200' };
  };

  const result = await operations.syncActiveTiledConfigForDriver('camera');

  assert.deepEqual(result, {
    success: true,
    tiledServer: 'http://localhost:8000',
    verified: true
  });
});

test('remote driver launch stops when Tiled configuration cannot be synchronized', async () => {
  const operations = new SSHOperations('/tmp/config', '/tmp/key');
  operations.config = {
    gripper: {
      host: '10.42.0.186',
      username: 'pi',
      httpPort: 5058,
      screen_name: 'gripper',
      server_module: 'AFL.automation.manipulate.ElectrochemGripper',
      shell: 'bash'
    }
  };
  operations.syncActiveTiledConfigForDriver = async () => ({
    success: false,
    error: 'remote config write failed'
  });
  operations.executeCommand = async () => {
    assert.fail('the driver process must not be launched');
  };

  const result = await operations.startServer('gripper');

  assert.equal(result.success, false);
  assert.match(result.error, /Driver was not launched/);
  assert.match(result.error, /remote config write failed/);
});
