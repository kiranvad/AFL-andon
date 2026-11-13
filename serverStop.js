'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Pass source rather than a filename so this also works inside Electron's asar
// and on remote hosts without installing Andon or a Python package there.
const workerSource = fs.readFileSync(path.join(__dirname, 'serverStop.py'), 'utf8');
const STOP_TIMEOUT_MS = 25000;

function parseStopResult(result) {
  if (!result.success) return result;
  const lines = String(result.output || '').trim().split('\n');
  let status;
  try { status = JSON.parse(lines.at(-1)); } catch (_) { /* Missing acknowledgement. */ }
  if (!status || status.verified !== true || status.success !== true || result.code !== 0) {
    return { ...result, success: false, error: status?.error || result.error ||
      `Server shutdown was not verified${result.code != null ? ` (exit ${result.code})` : ''}.` };
  }
  return { ...result, ...status, ...(status.forced ? {
    warning: 'The server required forced termination after graceful shutdown timed out.'
  } : {}) };
}

function runLocalStop(spec, python = 'python3', spawnWorker = spawn, timeout = STOP_TIMEOUT_MS) {
  return new Promise(resolve => {
    let worker;
    let timer;
    let output = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      // A new session and closed stdin let cleanup survive terminal hangup or
      // Andon being killed. Output is emitted only after process cleanup ends.
      worker = spawnWorker(python, ['-c', workerSource, JSON.stringify(spec)], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe']
      });
      worker.unref();
      worker.stdout.on('data', data => { output += data; });
      worker.stderr.on('data', data => { output += data; });
      worker.once('error', error => finish({ success: false, error: error.message }));
      worker.once('close', (code, signal) => finish({ success: true, output, code, signal }));
      timer = setTimeout(() => {
        worker.kill('SIGTERM');
        finish({ success: false, error: `Server shutdown was not verified within ${timeout}ms.` });
      }, timeout);
    } catch (error) {
      finish({ success: false, error: error.message });
    }
  });
}

module.exports = { workerSource, STOP_TIMEOUT_MS, parseStopResult, runLocalStop };
