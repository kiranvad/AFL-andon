const { version } = require('../package.json');

const expectedTag = `v${version}`;
const releaseTag = process.env.RELEASE_TAG;

if (releaseTag !== expectedTag) {
  console.error(
    `Release tag ${releaseTag || '(missing)'} must match package.json version: ${expectedTag}`
  );
  process.exit(1);
}

console.log(`Release tag ${releaseTag} matches package.json version ${version}`);
