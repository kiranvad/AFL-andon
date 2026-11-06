'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerTerminationHandlers } = require('../termination');

function setup(t, { tty = true, env = {}, ppid = 100 } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const runtime = Object.assign(new EventEmitter(), {
    ppid, stdin: { isTTY: tty }, stdout: {}, stderr: {}, env,
    kill: () => {}
  });
  const signals = [];
  t.after(registerTerminationHandlers(signal => signals.push(signal), runtime));
  return { runtime, signals };
}

test('detects a terminal launch wrapper being reparented without a hangup signal', t => {
  const { runtime, signals } = setup(t);
  runtime.ppid = 1;
  t.mock.timers.tick(1000);
  assert.deepEqual(signals, ['SIGHUP']);
  t.mock.timers.tick(2000);
  assert.deepEqual(signals, ['SIGHUP']);
});

test('detects a missing launch parent when the reported parent PID does not change', t => {
  const { runtime, signals } = setup(t);
  runtime.kill = (pid, signal) => {
    assert.equal(pid, 100);
    assert.equal(signal, 0);
    throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
  };
  t.mock.timers.tick(1000);
  assert.deepEqual(signals, ['SIGHUP']);
});

test('monitors npm launches with redirected terminal output', t => {
  const { runtime, signals } = setup(t, { tty: false, env: { npm_lifecycle_event: 'start' } });
  runtime.ppid = 1;
  t.mock.timers.tick(1000);
  assert.deepEqual(signals, ['SIGHUP']);
});

test('does not monitor ordinary GUI launches', t => {
  const { runtime, signals } = setup(t, { tty: false });
  runtime.ppid = 1;
  t.mock.timers.tick(1000);
  assert.deepEqual(signals, []);
});

test('leaves a living launch parent and permission errors alone', t => {
  const { runtime, signals } = setup(t);
  t.mock.timers.tick(1000);
  assert.deepEqual(signals, []);
  runtime.kill = () => {
    throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
  };
  t.mock.timers.tick(1000);
  assert.deepEqual(signals, []);
});

for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']) {
  test(`keeps ${signal} handled while shutdown is pending`, t => {
    const { runtime, signals } = setup(t);
    runtime.emit(signal);
    runtime.emit(signal);
    runtime.emit('SIGTERM');
    runtime.ppid = 1;
    t.mock.timers.tick(1000);
    assert.deepEqual(signals, [signal]);
    assert.equal(runtime.listenerCount(signal), 1);
  });
}
