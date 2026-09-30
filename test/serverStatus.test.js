'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { serverActivityPresentation } = require('../serverStatus');

test('maps server activity consistently for cards and sidebar buttons', () => {
  assert.deepEqual(serverActivityPresentation({ ok: true, state: 'active' }), {
    state: 'active',
    label: 'SERVER ACTIVE',
    cardClass: 'status-up',
    sidebarClass: 'status-green'
  });
  assert.deepEqual(serverActivityPresentation({ ok: true, state: 'ready' }), {
    state: 'active',
    label: 'SERVER ACTIVE',
    cardClass: 'status-up',
    sidebarClass: 'status-green'
  });
  assert.deepEqual(serverActivityPresentation({ ok: true, state: 'paused' }), {
    state: 'paused',
    label: 'SERVER PAUSED',
    cardClass: 'status-yellow',
    sidebarClass: 'status-yellow'
  });
  assert.deepEqual(serverActivityPresentation({ ok: false }), {
    state: 'down',
    label: 'SERVER DOWN',
    cardClass: 'status-down',
    sidebarClass: 'status-red'
  });
});
