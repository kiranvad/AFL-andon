const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SSHOperations = require('../sshOperations');
const { getSshAuthentication } = require('../sshAuthentication');

test('a NAS card uses password authentication after loading a YAML without an SSH mode', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'andon-tiled-auth-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, 'nas.yaml');
  const configPath = path.join(directory, 'launchers.json');
  await fs.writeFile(profilePath, `
uvicorn:
  port: 8000
management:
  type: docker_compose
  host: 192.0.2.10
  username: nas-user
  project_directory: /srv/tiled-project
  service: tiled
`);
  await fs.writeFile(configPath, JSON.stringify({
    nas: { server_type: 'tiled', config_file_location: profilePath, ssh_authentication: 'password' }
  }));
  const operations = new SSHOperations(configPath);
  await operations.loadConfig();
  assert.equal(getSshAuthentication(operations.config.nas), 'password');
  assert.equal((await operations.getServerStatus('nas')).authenticationRequired, true);
  operations.setSessionPassword('nas', 'session-secret');
  operations.connectWithPassword = async (_name, server, password) => {
    assert.equal(server.host, '192.0.2.10');
    assert.equal(server.username, 'nas-user');
    assert.equal(password, 'session-secret');
    return { connected: true };
  };
  assert.equal((await operations.connectWithAvailableKeys('nas')).authentication, 'password');
});

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
    nas_tiled: {
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
  const server = operations.config.nas_tiled;

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

  assert.deepEqual(await operations.getServerStatus('nas_tiled'), {
    success: false,
    status: false,
    authenticationRequired: true,
    managementType: 'docker_compose',
    screenState: 'unknown'
  });
  operations.setSessionPassword('nas_tiled', 'test-password');

  assert.deepEqual(await operations.getServerStatus('nas_tiled'), {
    success: true,
    status: true,
    managementType: 'docker_compose',
    screenState: 'running'
  });
  assert.equal((await operations.startServer('nas_tiled')).success, true);
  const aflGlobalConfig = JSON.parse(await fs.readFile(path.join(directory, 'afl-global-config.json'), 'utf8'));
  assert.deepEqual(Object.values(aflGlobalConfig).at(-1), {
    tiled_server: 'http://192.0.2.10:8000',
    tiled_api_key: 'test-secret'
  });
  const commandCountBeforeStop = commands.length;
  operations.clearSessionPassword('nas_tiled');
  assert.deepEqual(await operations.stopServer('nas_tiled'), {
    success: true,
    disconnected: true,
    status: false,
    managementType: 'docker_compose',
    screenState: 'disconnected'
  });
  assert.equal(commands.length, commandCountBeforeStop);
  operations.setSessionPassword('nas_tiled', 'test-password');
  assert.equal((await operations.restartServer('nas_tiled')).success, true);
  assert.equal((await operations.getServerLog('nas_tiled')).success, true);
  assert.equal((await operations.joinServer('nas_tiled')).success, true);
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
  assert.equal(operations.config.nas_tiled.external_service, false);
  assert.deepEqual(operations.config.nas_tiled.tiled_management, { type: 'screen' });
  assert.equal(operations.config.nas_tiled.tiled_profile_uri, undefined);
  assert.deepEqual(operations.getServersByHost(), { localhost: ['nas_tiled'] });
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
        projectDirectory: '/srv/tiled-project',
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
        projectDirectory: '/srv/tiled-project',
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
