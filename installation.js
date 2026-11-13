'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const SSHOperations = require('./sshOperations');
const { ensureLauncherConfig } = require('./configBootstrap');

async function checkLocalSsh(sshKeyPath, { clientFactory } = {}) {
  // Use Andon's own authentication path: success in an external SSH agent alone
  // does not establish that the application can use the installed key.
  const operations = new SSHOperations(undefined, sshKeyPath, { clientFactory });
  await operations.loadSSHKey();
  const username = os.userInfo().username;
  operations.config = { installation: { host: 'localhost', username, sshPort: 22 } };
  try {
    const { conn } = await operations.connectWithAvailableKeys('installation', 5000);
    conn.end();
  } catch (error) {
    throw new Error(
      `SSH setup check failed for ${username}@localhost:22: ${error.message}\n` +
      'Enable the local SSH server and authorize a readable, unencrypted private key for this account. ' +
      'Set SERVER_CONTROL_SSH_KEY_PATH if the key is outside the standard ~/.ssh locations. ' +
      'See INSTALL.md, then rerun npm run setup.',
      { cause: error }
    );
  }
}

async function installAndon({
  configPath = process.env.SERVER_CONTROL_CONFIG_PATH || path.join(os.homedir(), '.afl', 'launchers.json'),
  sshKeyPath = process.env.SERVER_CONTROL_SSH_KEY_PATH,
  firstRunOnly = false,
  clientFactory
} = {}) {
  let checkSsh = !firstRunOnly;
  if (firstRunOnly) {
    try {
      await fs.access(configPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      checkSsh = true;
    }
  }
  // A failed SSH check must not leave a configuration that looks installed on
  // the next first-run attempt. Authentication does not execute any command.
  if (checkSsh) await checkLocalSsh(sshKeyPath, { clientFactory });

  const aflDirectory = path.join(os.homedir(), '.afl');
  await fs.mkdir(path.join(aflDirectory, 'configs'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(aflDirectory, 'logs'), { recursive: true, mode: 0o700 });
  await ensureLauncherConfig(configPath);
  return { configPath, aflDirectory };
}

module.exports = { checkLocalSsh, installAndon };
