'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeLogChunk,
  stripTerminalControl,
  capEntries,
  filterEntries,
  stableServerColor,
  isRoutineHealthLog
} = require('../allLogs');

test('decodes complete streamed lines while retaining a partial line', () => {
  const first = decodeLogChunk('', 'one\r\ntwo par');
  assert.deepEqual(first, { lines: ['one'], remainder: 'two par' });
  const second = decodeLogChunk(first.remainder, 't\nthree\n');
  assert.deepEqual(second, { lines: ['two part', 'three'], remainder: '' });
  const splitCrLf = decodeLogChunk('split\r', '\nnext');
  assert.deepEqual(splitCrLf, { lines: ['split'], remainder: 'next' });
});

test('removes terminal formatting from attached screen output', () => {
  assert.equal(stripTerminalControl('\u001b[2J\u001b[Hready\u001b[32m green\u001b[0m\n'), 'ready green\n');
  assert.equal(stripTerminalControl('\u001b]0;screen title\u0007message'), 'message');
});

test('retains stable observation order when server entries interleave', () => {
  const entries = [
    { server: 'alpha', text: 'a1' },
    { server: 'beta', text: 'b1' },
    { server: 'alpha', text: 'a2' }
  ];
  assert.deepEqual(capEntries(entries, 10).map(entry => entry.text), ['a1', 'b1', 'a2']);
});

test('filters by enabled server and case-insensitive text or server name', () => {
  const entries = [
    { server: 'Alpha', text: 'Ready' },
    { server: 'Beta', text: 'failed' }
  ];
  assert.deepEqual(filterEntries(entries, new Set(['Alpha']), 'ready'), [entries[0]]);
  assert.deepEqual(filterEntries(entries, new Set(['Beta']), 'BETA'), [entries[1]]);
  assert.deepEqual(filterEntries(entries, new Set(), ''), []);
});

test('caps merged history at 10,000 newest entries', () => {
  const entries = Array.from({ length: 10005 }, (_, index) => ({ text: String(index) }));
  const capped = capEntries(entries);
  assert.equal(capped.length, 10000);
  assert.equal(capped[0].text, '5');
  assert.equal(capped[9999].text, '10004');
});

test('server colors are stable and distinguish common names', () => {
  assert.equal(stableServerColor('alpha'), stableServerColor('alpha'));
  assert.notEqual(stableServerColor('alpha'), stableServerColor('beta'));
});

test('suppresses only successful Tiled access logs for its configured health path', () => {
  const tiled = { server_type: 'tiled', status_url: 'http://tiled-host:8000/healthz' };
  assert.equal(
    isRoutineHealthLog('catalog', tiled, 'INFO: 127.0.0.1:50000 - "GET /healthz HTTP/1.1" 200 OK'),
    true
  );
  assert.equal(
    isRoutineHealthLog('catalog', tiled, 'INFO: 127.0.0.1:50000 - "GET /healthz?probe=1 HTTP/1.1" 204 No Content'),
    true
  );
  assert.equal(
    isRoutineHealthLog('catalog', tiled, 'INFO: 127.0.0.1:50000 - "GET /healthz HTTP/1.1" 503 Service Unavailable'),
    false
  );
  assert.equal(
    isRoutineHealthLog('catalog', tiled, 'INFO: 127.0.0.1:50000 - "GET /api/v1/search/ HTTP/1.1" 200 OK'),
    false
  );
  assert.equal(
    isRoutineHealthLog('catalog', { ...tiled, server_type: 'other' }, '"GET /healthz HTTP/1.1" 200 OK'),
    false
  );
});
