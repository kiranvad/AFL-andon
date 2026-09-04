const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTiledProfile } = require('../tiled/profile');

test('loads an external Tiled YAML profile with an inline API key', async () => {
  const readFile = async () =>
    `uri: http://192.0.2.10:8000
api_key: abc123
catalog_path: run_documents
management:
  type: docker_compose
  authentication: password
  host: 192.0.2.10
  username: root
  project_directory: /srv/tiled-project
  service: tiled
`;

  const profile = await loadTiledProfile('/profiles/nas.yml', { readFile });
  assert.equal(profile.mode, 'external');
  assert.equal(profile.uri, 'http://192.0.2.10:8000/');
  assert.equal(profile.apiKey, 'abc123');
  assert.equal(profile.catalogPath, 'run_documents');
  assert.deepEqual(profile.management, {
    type: 'docker_compose',
    authentication: 'password',
    host: '192.0.2.10',
    username: 'root',
    projectDirectory: '/srv/tiled-project',
    service: 'tiled',
    joinShell: '/bin/sh'
  });
});

test('loads a NAS profile using the local Tiled authentication and uvicorn layout', async () => {
  const readFile = async () => `
authentication:
  single_user_api_key: abc123
uvicorn:
  host: 0.0.0.0
  port: 8000
structure_clients: dask
management:
  type: docker_compose
  authentication: password
  host: 192.0.2.10
  username: nas-user
  project_directory: /srv/tiled-project
  service: tiled
`;

  const profile = await loadTiledProfile('/profiles/nas.yml', { readFile });
  assert.equal(profile.mode, 'external');
  assert.equal(profile.uri, 'http://192.0.2.10:8000/');
  assert.equal(profile.apiKey, 'abc123');
  assert.equal(profile.management.host, '192.0.2.10');
});

test('does not return an external API key during metadata-only loading', async () => {
  const readFile = async () =>
    'uri: http://192.0.2.10:8000\napi_key: abc123\n';

  const profile = await loadTiledProfile('/profiles/nas.yml', {
    readFile,
    loadApiKey: false
  });
  assert.equal(profile.apiKey, '');
  assert.equal(Object.hasOwn(profile, 'raw'), false);
});

test('recognizes a native Tiled service YAML as locally managed', async () => {
  const readFile = async () => `
authentication:
  single_user_api_key: local-secret
trees:
  - path: /
    tree: catalog
`;
  const profile = await loadTiledProfile('/profiles/local.yml', { readFile });
  assert.equal(profile.mode, 'local');
  assert.equal(profile.uri, '');
  assert.equal(profile.apiKey, 'local-secret');
  assert.deepEqual(profile.management, { type: 'screen' });
});

test('rejects ambiguous local and external profiles', async () => {
  const readFile = async () => 'uri: http://localhost:8000\ntrees: []\n';
  await assert.rejects(
    loadTiledProfile('/profiles/bad.yml', { readFile }),
    /cannot define both uri and trees/
  );
});

test('rejects incomplete Docker Compose management', async () => {
  const readFile = async () => `
uri: http://localhost:8000
management:
  type: docker_compose
  host: localhost
`;
  await assert.rejects(
    loadTiledProfile('/profiles/bad-management.yml', { readFile }),
    /management.username is required/
  );
});
