'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger, setLogSink } = require('../logger');

test('forwards application log entries to the configured combined-log sink', t => {
  const entries = [];
  setLogSink(entry => entries.push(entry));
  t.after(() => setLogSink(null));

  createLogger('test-module').info('connected', { server: 'alpha' });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, 'info');
  assert.equal(entries[0].moduleName, 'test-module');
  assert.equal(entries[0].text, 'connected {\n  "server": "alpha"\n}');
  assert.equal(Number.isFinite(entries[0].observedAt), true);
});
