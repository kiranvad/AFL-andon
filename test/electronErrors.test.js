const test = require('node:test');
const assert = require('node:assert/strict');

const { isExpectedWebviewNavigationAbort } = require('../electronErrors');

test('recognizes Electron webview navigation cancellation', () => {
  assert.equal(isExpectedWebviewNavigationAbort({
    code: 'ERR_ABORTED',
    errno: -3,
    url: 'http://localhost:5005/'
  }), true);
});

test('does not hide unrelated errors', () => {
  assert.equal(isExpectedWebviewNavigationAbort({
    code: 'ERR_CONNECTION_REFUSED',
    errno: -102,
    url: 'http://localhost:5005/'
  }), false);
  assert.equal(isExpectedWebviewNavigationAbort(new Error('failed')), false);
});
