'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const SSHOperations = require('./sshOperations');
const { ensureLauncherConfig, ensureAndonConfig } = require('./configBootstrap');

async function checkLocalSsh(sshKeyPath, { clientFactory } = {}) {
  // Use Andon's own authentication path: success in an external SSH agent alone
  // does not establish that the application can use the installed key.
  const operations = new SSHOperations(undefined, sshKeyPath, { clientFactory });
  const username = os.userInfo().username;
  operations.config = { installation: { host: 'localhost', username, sshPort: 22 } };
  try {
    await operations.loadSSHKey({ quiet: true });
    if (operations.getAvailableSSHKeys().length === 0) {
      throw new Error('No readable SSH private key was found for this user account.');
    }
    const { conn } = await operations.connectWithAvailableKeys('installation', 5000);
    conn.end();
  } catch (error) {
    const serviceUnavailable = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.code);
    const section = serviceUnavailable
      ? 'Developer and administrator setup > 2. Enable the SSH server (INSTALL.md#enable-ssh-server)'
      : 'User installation > 2. Set up SSH keys for your account (INSTALL.md#ssh-key-setup)';
    throw new Error(
      `SSH setup check failed for ${username}@localhost:22: ${error.message}\n` +
      `Read: ${section}\n` +
      `Guide: ${path.join(__dirname, 'INSTALL.md')}\n` +
      'After completing those steps, rerun npm run setup from the checkout as the same user.',
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
  await ensureAndonConfig(path.join(aflDirectory, 'configs', 'andon.config.json'));
  await ensureLauncherConfig(configPath);
  return { configPath, aflDirectory };
}

module.exports = { checkLocalSsh, installAndon };
