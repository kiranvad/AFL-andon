const fs = require('fs').promises;
const yaml = require('js-yaml');

function normalizeHttpUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Tiled profile uri must use HTTP or HTTPS.');
  }
  return new URL('/', url).toString();
}

function requireManagementString(management, field, profilePath) {
  const value = String(management?.[field] || '').trim();
  if (!value) {
    throw new Error(`Tiled profile ${profilePath} management.${field} is required.`);
  }
  return value;
}

function normalizeManagement(profile, mode, profilePath) {
  if (mode === 'local') return { type: 'screen' };

  const management = profile.management || {};
  const type = String(management.type || 'external').trim();
  if (type === 'external') return { type };
  if (type !== 'docker_compose') {
    throw new Error(`Tiled profile ${profilePath} has unsupported management type "${type}".`);
  }

  const authentication = String(management.authentication || 'key').trim();
  if (!['key', 'password'].includes(authentication)) {
    throw new Error(`Tiled profile ${profilePath} management.authentication must be "key" or "password".`);
  }

  return {
    type,
    authentication,
    host: requireManagementString(management, 'host', profilePath),
    username: requireManagementString(management, 'username', profilePath),
    projectDirectory: requireManagementString(management, 'project_directory', profilePath),
    service: requireManagementString(management, 'service', profilePath),
    joinShell: String(management.join_shell || '/bin/sh').trim() || '/bin/sh'
  };
}

async function loadTiledProfile(profilePath, options = {}) {
  const readFile = options.readFile || fs.readFile;
  const loadApiKey = options.loadApiKey !== false;
  const contents = await readFile(profilePath, 'utf8');
  const profile = yaml.load(contents) || {};
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error(`Tiled profile ${profilePath} must contain a YAML mapping.`);
  }

  // A Tiled client profile has `uri` and describes a service that already
  // exists. A native Tiled service configuration has `trees` and can be
  // launched locally with `tiled serve config`.
  const explicitUri = typeof profile.uri === 'string' && profile.uri.trim();
  const dockerManaged = String(profile.management?.type || '').trim() === 'docker_compose';
  const external = explicitUri || dockerManaged;
  const local = Array.isArray(profile.trees);
  if (!external && !local) {
    throw new Error(`Tiled profile ${profilePath} must define either uri or trees.`);
  }
  if (external && local) {
    throw new Error(`Tiled profile ${profilePath} cannot define both uri and trees.`);
  }

  let apiKey = '';
  if (external) {
    if (loadApiKey) {
      apiKey = String(
        profile.api_key || profile.authentication?.single_user_api_key || ''
      ).trim();
    }
    if (loadApiKey && !apiKey && typeof profile.headers?.Authorization === 'string') {
      apiKey = profile.headers.Authorization.replace(/^Apikey\s+/i, '').trim();
    }
  } else if (loadApiKey) {
    apiKey = String(profile.authentication?.single_user_api_key || '').trim();
  }

  const management = normalizeManagement(profile, external ? 'external' : 'local', profilePath);
  let uri = '';
  if (external) {
    const derivedUri = explicitUri ||
      `http://${management.host}:${Number(profile.uvicorn?.port) || 8000}`;
    uri = normalizeHttpUrl(derivedUri);
  }

  return {
    mode: external ? 'external' : 'local',
    uri,
    apiKey,
    management,
    catalogPath: String(profile.catalog_path || '').trim().replace(/^\/+|\/+$/g, ''),
    structureClients: profile.structure_clients || 'dask'
  };
}

module.exports = { loadTiledProfile, normalizeHttpUrl, normalizeManagement };
