'use strict';

function getSshAuthentication(server) {
  return server?.ssh_authentication || server?.tiled_management?.authentication || 'key';
}

function getSshCredentialId(server) {
  return server ? `${server.username}@${server.host}:${server.sshPort || 22}` : '';
}

module.exports = { getSshAuthentication, getSshCredentialId };
