'use strict';

const { installAndon } = require('../installation');

async function main() {
  // Release builders install dependencies without configuring the build host.
  // This exception applies only to postinstall; explicit setup always checks SSH.
  if (process.env.npm_lifecycle_event === 'postinstall' && process.env.AFL_ANDON_BUILD_ONLY === '1') {
    console.log('Build-only install: skipping user configuration and SSH checks. The application performs setup on first launch.');
    return;
  }
  const { configPath, aflDirectory } = await installAndon();
  console.log(`AFL Andon setup complete. SSH login to localhost verified.\nAFL directory: ${aflDirectory}\nLauncher configuration: ${configPath}`);
}

main().catch(error => {
  console.error(`AFL Andon installation failed: ${error.message}`);
  process.exitCode = 1;
});
