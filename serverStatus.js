'use strict';

function serverActivity(queueResult) {
  if (!queueResult?.ok) return 'down';
  return String(queueResult.state || '').trim().toLowerCase() === 'paused'
    ? 'paused'
    : 'active';
}

function serverActivityPresentation(queueResult) {
  const state = serverActivity(queueResult);
  return {
    state,
    label: `SERVER ${state.toUpperCase()}`,
    cardClass: state === 'active' ? 'status-up' : (state === 'paused' ? 'status-yellow' : 'status-down'),
    sidebarClass: state === 'active' ? 'status-green' : (state === 'paused' ? 'status-yellow' : 'status-red')
  };
}

module.exports = { serverActivity, serverActivityPresentation };
