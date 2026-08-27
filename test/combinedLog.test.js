'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { CombinedLogWriter, formatEntry, startupTimestamp } = require('../combinedLog');

test('uses the Andon startup timestamp in a filesystem-safe log name', () => {
  const started = new Date(2026, 7, 25, 14, 3, 7, 42);
  assert.equal(startupTimestamp(started), '2026-08-25_14-03-07-042');
});

test('formats combined entries with observation time and server name', () => {
  const observed = new Date(2026, 7, 25, 14, 3, 7, 42).getTime();
  assert.equal(formatEntry({ server: 'mixer', text: 'ready', observedAt: observed }),
    '[2026-08-25 14:03:07.042] [mixer] ready\n');
});

test('writes ordered entries to a dedicated combined log directory', async t => {
  const logRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'andon-combined-log-'));
  t.after(() => fs.rm(logRoot, { recursive: true, force: true }));
  const writer = new CombinedLogWriter({
    startupTime: new Date(2026, 7, 25, 14, 3, 7, 42),
    logRoot
  });

  writer.append([{ server: 'alpha', text: 'first', observedAt: 1 }]);
  writer.append([{ server: 'beta', text: 'second', observedAt: 2 }]);
  await writer.flush();

  assert.equal(writer.filePath,
    path.join(logRoot, 'combined', 'andon-2026-08-25_14-03-07-042.log'));
  const contents = await fs.readFile(writer.filePath, 'utf8');
  assert.match(contents, /\[alpha\] first\n.*\[beta\] second\n/s);
});
