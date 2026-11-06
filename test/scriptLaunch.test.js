'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const SSHOperations = require('../sshOperations');

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'andon-script-launch-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "agent script 'source.sh");
  const content = '#!/usr/bin/env bash\nprintf "ready\\n"\n';
  await fs.writeFile(source, content, { mode: 0o600 });
  const operations = new SSHOperations('/tmp/config', undefined, {
    aflGlobalConfigPath: path.join(directory, '.afl', 'config.json')
  });
  operations.config = {
    other: { host: 'worker', username: 'other-user' },
    agent: { host: 'worker', username: 'test-user', shell: 'bash', screen_name: 'AgentServer', script_file_location: source }
  };
  const files = new Map();
  const modes = new Map();
  operations.connectWithAvailableKeys = async name => {
    assert.equal(name, 'agent');
    return { conn: {
      end() {},
      sftp(done) {
        done(null, {
          mkdir(_path, _options, callback) { callback(); },
          writeFile(file, bytes, _options, callback) { files.set(file, bytes); callback(); },
          chmod(file, mode, callback) { modes.set(file, mode); callback(); }
        });
      }
    } };
  };
  operations.getRemoteOs = async name => { assert.equal(name, 'agent'); return 'linux'; };
  const commands = [];
  operations.executeCommand = async (name, command) => {
    assert.equal(name, 'agent');
    commands.push(command);
    return { success: true, code: 0, output: '' };
  };
  operations.waitForServerHealth = async () => ({ ok: true });
  operations.ensureScreenDetached = async () => ({ ok: true });
  operations.updateAndonRuntimeConfig = async () => ({ success: true });
  return { directory, operations, source, content, files, modes, commands };
}

test('a local Script file is copied to the selected SSH account and executed from the copied path', async t => {
  const { operations, source, content, files, modes, commands } = await setup(t);
  assert.equal((await operations.startServer('agent')).success, true);
  const destination = '/home/test-user/.afl/scripts/agent.launch-script.sh';
  assert.equal(files.get(destination), content);
  assert.equal(modes.get(destination), 0o700);
  assert.equal(await fs.readFile(source, 'utf8'), content);
  assert.equal((await fs.stat(source)).mode & 0o777, 0o600);
  const start = commands.find(command => command.startsWith('screen -d -m'));
  assert.ok(start.endsWith(`'${destination}'`));
  assert.equal(start.includes(source), false);
});

test('editing the control-side script is reflected in the next launch', async t => {
  const { operations, source, files } = await setup(t);
  await operations.startServer('agent');
  const changed = '#!/usr/bin/env bash\nprintf "updated\\n"\n';
  await fs.writeFile(source, changed);
  await operations.startServer('agent');
  assert.equal(files.get('/home/test-user/.afl/scripts/agent.launch-script.sh'), changed);
});

test('a missing selected local script fails before contacting the server', async t => {
  const { operations, source, commands, files } = await setup(t);
  await fs.unlink(source);
  const result = await operations.startServer('agent');
  assert.equal(result.success, false);
  assert.match(result.error, /Could not read script file on this computer/);
  assert.equal(commands.length, 0);
  assert.equal(files.size, 0);
});

test('local file launches without a shebang use the selected shell', async t => {
  const { operations, source, commands } = await setup(t);
  await fs.writeFile(source, 'printf "ready\\n"\n');
  assert.equal((await operations.startServer('agent')).success, true);
  assert.ok(commands.find(command => command.startsWith('screen -d -m'))
    .endsWith("'bash' '/home/test-user/.afl/scripts/agent.launch-script.sh'"));
});

test('localhost receives an executable copy without changing the source file permissions', async t => {
  const { directory, operations, source, content } = await setup(t);
  operations.config.agent.host = 'localhost';
  operations.config.agent.username = os.userInfo().username;
  const result = await operations.resolveScriptPath('agent', operations.config.agent);
  const destination = path.join(directory, '.afl', 'scripts', 'agent.launch-script.sh');
  assert.equal(result.success, true);
  assert.equal(result.scriptPath, destination);
  assert.equal(await fs.readFile(destination, 'utf8'), content);
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(source)).mode & 0o777, 0o600);
});

test('legacy server-side commands retain their launch behavior', async t => {
  const { operations, commands, files } = await setup(t);
  operations.config.agent.server_script = '/opt/agent/start.sh --debug';
  delete operations.config.agent.script_file_location;
  assert.equal((await operations.startServer('agent')).success, true);
  assert.equal(files.size, 0);
  assert.ok(commands.find(command => command.startsWith('screen -d -m')).endsWith('/opt/agent/start.sh --debug'));
});

for (const launcher of ['script', 'module', 'legacy']) {
  test(`${launcher} launches carry the card HTTP port into the server environment`, async t => {
    const { operations, commands } = await setup(t);
    operations.config.agent.httpPort = 5050;
    if (launcher === 'module') {
      delete operations.config.agent.script_file_location;
      operations.config.agent.server_module = 'AFL.double_agent.AgentDriver';
    } else if (launcher === 'legacy') {
      delete operations.config.agent.script_file_location;
      operations.config.agent.server_script = '/opt/agent/start.sh --debug';
    }
    assert.equal((await operations.startServer('agent')).success, true);
    const start = commands.find(command => command.startsWith('screen -d -m'));
    assert.ok(start.includes('AFL_HTTP_PORT='), start);
    // Execute the generated Screen arguments with harmless replacements to
    // verify the launched process receives the value, including shell quoting.
    const { execFileSync } = require('node:child_process');
    const capture = start.replace(/^screen /, 'capture_screen ');
    const script = `
      capture_screen() {
        while [ "$#" -gt 0 ]; do
          if [ "$1" = env ] || [ "$1" = bash ]; then break; fi
          shift
        done
        "$@"
      }
      python() { printf '%s' "$AFL_HTTP_PORT"; }
      env() { export "$1"; shift; printf '%s' "$AFL_HTTP_PORT"; }
      ${capture}
    `;
    // Module launches run through bash -ci; replace it with a noninteractive
    // shell so the test does not load the user's startup files.
    const safeScript = script.replace('bash -ci ', 'bash -c ').replace(' python -m ', ' printenv AFL_HTTP_PORT # ');
    assert.equal(execFileSync('bash', ['-c', safeScript], { encoding: 'utf8' }).trim(), '5050');
  });
}

test('an invalid card HTTP port prevents launching or uploading a script', async t => {
  const { operations, commands, files } = await setup(t);
  for (const port of [0, 65536, 5050.5, 'invalid']) {
    operations.config.agent.httpPort = port;
    const result = await operations.startServer('agent');
    assert.equal(result.success, false);
    assert.match(result.error, /HTTP port must be an integer between 1 and 65535/);
  }
  assert.equal(commands.length, 0);
  assert.equal(files.size, 0);
});

test('saving removes duplicate local script fields and retains remote commands', async t => {
  const { directory, operations, source } = await setup(t);
  operations.configPath = path.join(directory, 'launchers.json');
  operations.config.agent.server_script = source;
  operations.config.remote = { server_script: '/opt/agent/start.sh --debug', script_file_location: '' };
  operations.config.module = { server_module: 'AFL.double_agent.AgentDriver', server_script: '', script_file_location: '' };
  await operations.saveConfig();
  const saved = JSON.parse(await fs.readFile(operations.configPath, 'utf8'));
  assert.equal(saved.agent.script_file_location, source);
  assert.equal(Object.hasOwn(saved.agent, 'server_script'), false);
  assert.equal(saved.remote.server_script, '/opt/agent/start.sh --debug');
  assert.equal(Object.hasOwn(saved.remote, 'script_file_location'), false);
  assert.equal(Object.hasOwn(saved.module, 'server_script'), false);
  assert.equal(Object.hasOwn(saved.module, 'script_file_location'), false);
});
