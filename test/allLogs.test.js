'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeLogChunk,
  stripTerminalControl,
  capEntries,
  filterEntries,
  LogSourceTracker,
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

test('source toggles apply across servers and combine with server selection and search', () => {
  const entries = [
    { server: 'Alpha', text: 'Ready', source: 'APIServer' },
    { server: 'Beta', text: 'Ready', source: 'APIServer' },
    { server: 'Alpha', text: 'Running task', source: 'QueueDaemon' },
    { server: 'Beta', text: 'Running task', source: 'QueueDaemon' },
    { server: 'Alpha', text: 'Driver ready', source: null },
    { server: 'Andon', text: 'APIServer connected', type: 'app' }
  ];
  const enabled = new Set(['Alpha', 'Beta', 'Andon']);
  assert.deepEqual(filterEntries(entries, enabled, '', new Set(['APIServer'])), entries.slice(2));
  assert.deepEqual(filterEntries(entries, enabled, '', new Set(['QueueDaemon'])), [entries[0], entries[1], entries[4], entries[5]]);
  assert.deepEqual(filterEntries(entries, enabled, '', new Set(['APIServer', 'QueueDaemon'])), entries.slice(4));
  assert.deepEqual(filterEntries(entries, new Set(['Alpha']), 'RUNNING', new Set(['APIServer'])), [entries[2]]);
  assert.deepEqual(filterEntries(entries, enabled, 'ready', new Set(['APIServer'])), [entries[4]]);
  assert.deepEqual(filterEntries(entries, enabled), entries);
});

test('identifies Python calling modules without matching module names in driver messages', () => {
  const tracker = new LogSourceTracker();
  const cases = [
    ['[2026-11-12 10:00:00,001] DEBUG in APIServer: Adding route /test', 'APIServer'],
    ['[2026-11-12 10:00:00,002] INFO in QueueDaemon: Running task', 'QueueDaemon'],
    ['ERROR in AFL.automation.APIServer.APIServer: Driver query failed', 'APIServer'],
    ['WARNING in QueueDaemon.py: Task failed', 'QueueDaemon'],
    ['INFO in Camera: APIServer and QueueDaemon are ready', null],
    ['Driver printed QueueDaemon', null],
    ['INFO in constructor: Driver message', null]
  ];
  for (const [line, expected] of cases) assert.equal(tracker.classify('Alpha', line), expected, line);
});

test('tracks multiline messages and chained tracebacks separately for interleaved servers', () => {
  const tracker = new LogSourceTracker();
  assert.equal(tracker.classify('Alpha', 'ERROR in QueueDaemon: Task failed'), 'QueueDaemon');
  assert.equal(tracker.classify('Beta', 'INFO in APIServer: Request'), 'APIServer');
  for (const line of [
    'Traceback (most recent call last):',
    '  File "driver.py", line 10, in execute',
    '    raise ValueError("task failed")',
    'ValueError: task failed',
    '',
    'The above exception was the direct cause of the following exception:',
    '',
    'Traceback (most recent call last):',
    '  File "QueueDaemon.py", line 144, in run',
    'RuntimeError: task failed'
  ]) assert.equal(tracker.classify('Alpha', line), 'QueueDaemon', line);
  assert.equal(tracker.classify('Beta', '  request details'), 'APIServer');
  assert.equal(tracker.classify('Alpha', 'INFO in Camera: Ready'), null);
  assert.equal(tracker.classify('Alpha', '  camera details'), null);
  assert.equal(tracker.classify('Beta', 'driver printed output'), null);
  assert.equal(tracker.classify('Beta', '  driver details'), null);
});

test('stream resets clear source attribution and inline tracebacks keep their exception line', () => {
  const tracker = new LogSourceTracker();
  assert.equal(tracker.classify('Alpha', 'ERROR in APIServer: Traceback (most recent call last):'), 'APIServer');
  assert.equal(tracker.classify('Alpha', '  File "driver.py", line 10, in execute'), 'APIServer');
  assert.equal(tracker.classify('Alpha', 'ValueError: failed'), 'APIServer');
  tracker.reset('Alpha');
  assert.equal(tracker.classify('Alpha', '  new stream output'), null);
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

test('suppresses successful access logs for configured server health paths', () => {
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
    true
  );
  assert.equal(
    isRoutineHealthLog('camera', {}, 'INFO: 127.0.0.1:50000 - "GET /queue_state HTTP/1.1" 200 OK'),
    true
  );
  assert.equal(
    isRoutineHealthLog('tiled', { server_type: 'tiled' }, 'INFO: 127.0.0.1:50000 - "GET /api/v1/metadata/ HTTP/1.1" 200 OK'),
    true
  );
  assert.equal(
    isRoutineHealthLog(
      'tiled',
      { server_type: 'tiled' },
      'afl-tiled-tiled-1 | [request-id] 127.0.0.1:44884 (anon) - "GET /api/v1/metadata HTTP/1.1" 307 Temporary Redirect'
    ),
    true
  );
  assert.equal(
    isRoutineHealthLog(
      'tiled',
      { server_type: 'tiled', status_url: 'http://localhost:8000/healthz' },
      'example-tiled-1 | [request-id] 192.0.2.20:48298 (singleuser) - "GET /api/v1/metadata/ HTTP/1.1" 200 OK'
    ),
    true
  );
});
