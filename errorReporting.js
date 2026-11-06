'use strict';

function errorText(error) {
  if (typeof error === 'string') return error;
  return error?.stack || error?.message || String(error ?? 'Unknown error');
}

function inferErrorServers(text, config = {}) {
  const names = Object.keys(config || {}).sort((a, b) => b.length - a.length);
  const name = names.find(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\w])${escaped}(?=$|[^\\w])`, 'i').test(String(text));
  });
  if (name) return [name];
  const hosts = names.filter(name => config[name].host && String(text).includes(config[name].host));
  return hosts.length ? hosts : ['Andon'];
}

function ipcErrorServers(channel, args, config = {}) {
  if (args[0]?.serverName) return [args[0].serverName];
  if (channel === 'get-batch-server-status' && args[1]) return [args[1]];
  if (/^(?:start|stop|restart|join|remove|toggle)-server|^(?:get-server-|start-ssh-session|close-ssh-session|set-session-ssh-password|activate-server-log-stream|tiled-)/.test(channel) && typeof args[0] === 'string') {
    return [args[0]];
  }
  if (typeof args[0] === 'string') {
    if (Object.hasOwn(config || {}, args[0])) return [args[0]];
    const names = Object.keys(config || {}).filter(name => config[name].host === args[0]);
    if (names.length) return names;
  }
  return ['Andon'];
}

class ErrorDialog {
  constructor(document, clipboard) {
    this.document = document;
    this.clipboard = clipboard;
    this.errors = new Map();
    this.incidents = new Map();
    this.dialog = null;
  }

  initialize() {
    this.dialog = this.document.getElementById('error-dialog');
    this.dialog.addEventListener('cancel', event => event.preventDefault());
    // Only Clear Errors can release the modal lock.
    this.dialog.addEventListener('close', () => {
      if (this.errors.size) this.render();
    });
    this.document.getElementById('copy-errors').addEventListener('click', () => this.copy());
    this.document.getElementById('clear-errors').addEventListener('click', () => this.clear());
    this.render();
  }

  report(serverName, error, observedAt = Date.now()) {
    const text = errorText(error);
    const key = JSON.stringify([serverName || 'Andon', text]);
    if (this.errors.has(key)) return;
    this.errors.set(key, { serverName: serverName || 'Andon', text, observedAt });
    this.render();
  }

  reportOnce(incident, serverName, error) {
    const text = errorText(error);
    if (this.incidents.get(incident) === text) return;
    this.incidents.set(incident, text);
    this.report(serverName, text);
  }

  resolve(incident) {
    this.incidents.delete(incident);
  }

  render() {
    if (!this.dialog) return;
    const list = this.document.getElementById('error-list');
    list.replaceChildren();
    for (const { serverName, text, observedAt } of this.errors.values()) {
      const entry = this.document.createElement('section');
      entry.className = 'error-entry';
      const title = this.document.createElement('h3');
      title.textContent = serverName;
      const time = this.document.createElement('time');
      time.textContent = new Date(observedAt).toLocaleString();
      const message = this.document.createElement('pre');
      message.textContent = text;
      entry.append(title, time, message);
      list.appendChild(entry);
    }
    this.document.getElementById('error-dialog-title').textContent = `Andon errors (${this.errors.size})`;
    this.document.getElementById('error-copy-status').textContent = '';
    if (this.errors.size && !this.dialog.open) this.dialog.showModal();
  }

  copy() {
    const text = [...this.errors.values()].map(entry =>
      `[${new Date(entry.observedAt).toISOString()}] ${entry.serverName}\n${entry.text}`
    ).join('\n\n');
    try {
      this.clipboard.writeText(text);
      this.document.getElementById('error-copy-status').textContent = 'Errors copied.';
    } catch (error) {
      this.report('Andon', error);
    }
  }

  clear() {
    this.errors.clear();
    this.render();
    this.dialog.close();
  }
}

// Screen log chunks may split a traceback at any byte boundary. Collect its
// complete lines before presenting it, retaining indentation and error text.
class ServerLogErrors {
  constructor(report) {
    this.report = report;
    this.tracebacks = new Map();
  }

  consume(serverName, lines) {
    if (serverName === 'Andon') return; // Application errors arrive as structured events.
    for (const line of lines) {
      if (line.startsWith('Traceback (most recent call last):')) {
        this.flush(serverName);
        this.tracebacks.set(serverName, [line]);
      } else if (this.tracebacks.has(serverName)) {
        this.tracebacks.get(serverName).push(line);
        if (/^[A-Za-z_][\w.]*(?::|$)/.test(line)) this.flush(serverName);
      } else if (
        /^\s*(?:\[[^\]\r\n]+\]\s*)?\[?(?:ERROR|CRITICAL|FATAL)\]?(?=[:\s])/i.test(line) ||
        /^\d{4}-\d\d-\d\d\b.*?\s-\s(?:ERROR|CRITICAL|FATAL)\s-\s/.test(line) ||
        /^(?:\w+\.)*\w*(?:Error|Exception|Fault|SystemExit|KeyboardInterrupt)(?::|$)/.test(line) ||
        /:\s+(?:command not found|Permission denied|No such file or directory)(?:$|[:\s])/.test(line)
      ) {
        this.report(serverName, line);
      }
    }
  }

  flush(serverName) {
    const lines = this.tracebacks.get(serverName);
    if (!lines) return;
    this.tracebacks.delete(serverName);
    this.report(serverName, lines.join('\n'));
  }

  reset(serverName) {
    this.tracebacks.delete(serverName);
  }
}

module.exports = { errorText, inferErrorServers, ipcErrorServers, ErrorDialog, ServerLogErrors };
