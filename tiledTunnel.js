'use strict';

const net = require('node:net');

// The listener lives on the driver host. Each request crosses SSH to Andon,
// which opens the Tiled connection using the control computer's network.
class TiledTunnel {
  constructor({ connect, targetUrl, log, retryDelays = [1000, 2000, 5000, 10000, 30000] }) {
    this.connect = connect;
    this.target = new URL(targetUrl);
    if (this.target.protocol !== 'http:') throw new Error('Tiled tunnels require an HTTP service URL.');
    this.log = log;
    this.retryDelays = retryDelays;
    this.serverNames = new Set();
    this.port = 0;
    this.conn = null;
    this.pending = null;
    this.closed = false;
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.streams = new Set();
  }

  get url() {
    const url = new URL(this.target);
    url.hostname = '127.0.0.1';
    url.port = this.port;
    return url;
  }

  async ensureReady() {
    if (this.closed) throw new Error('Tiled tunnel is closed.');
    if (this.pending) return this.pending;
    if (this.conn) return this.url;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.pending = this.open().catch(error => {
      // A previously established tunnel must recover on the same port so
      // running drivers can keep using their existing Tiled client.
      if (this.port) this.scheduleReconnect();
      throw error;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async open() {
    const { conn } = await this.connect();
    let disconnected = false;
    let assignedPort = this.port;
    conn.on('error', () => {}); // The authentication layer also reports errors.
    conn.once('close', () => {
      disconnected = true;
      if (this.conn !== conn) return;
      this.conn = null;
      this.destroyStreams();
      this.scheduleReconnect();
    });
    conn.on('tcp connection', (info, accept, reject) => {
      if (this.closed || info.destIP !== '127.0.0.1' || info.destPort !== assignedPort) {
        reject();
        return;
      }
      this.forward(accept());
    });

    try {
      if (this.closed) throw new Error('Tiled tunnel was closed during connection.');
      assignedPort = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('SSH Tiled forwarding request timed out.')), 5000);
        const onClose = () => finish(new Error('SSH disconnected while establishing the Tiled tunnel.'));
        const finish = (error, port) => {
          clearTimeout(timer);
          conn.removeListener('close', onClose);
          if (error) reject(error);
          else resolve(port);
        };
        conn.once('close', onClose);
        try {
          conn.forwardIn('127.0.0.1', this.port, (error, port) => {
            const resultPort = this.port || port;
            if (!error && (!Number.isInteger(resultPort) || resultPort < 1 || resultPort > 65535)) {
              error = new Error('SSH did not allocate a valid Tiled forwarding port.');
            }
            finish(error, resultPort);
          });
        } catch (error) {
          finish(error);
        }
      });
      if (this.closed || disconnected) throw new Error('SSH Tiled tunnel closed during startup.');
      this.port = assignedPort;
      this.conn = conn;
      this.retryAttempt = 0;
      this.log.info(`Tiled tunnel ready at ${this.url.origin} via the control computer to ${this.target.origin}`);
      return this.url;
    } catch (error) {
      conn.end();
      throw new Error(`Could not establish an SSH Tiled tunnel: ${error.message}. Check that the driver host permits remote TCP forwarding.`);
    }
  }

  forward(channel) {
    const socket = net.createConnection({
      host: this.target.hostname.replace(/^\[|\]$/g, ''),
      port: Number(this.target.port) || 80
    });
    const pair = { socket, channel };
    this.streams.add(pair);
    const cleanup = () => {
      this.streams.delete(pair);
      socket.destroy();
      channel.destroy();
    };
    socket.setTimeout(5000, () => socket.destroy(new Error('Tiled connection timed out on the control computer.')));
    socket.once('connect', () => socket.setTimeout(0));
    socket.on('error', error => {
      this.log.warn(`Tiled tunnel connection to ${this.target.origin} failed: ${error.message}`);
      cleanup();
    });
    channel.on('error', cleanup);
    socket.once('close', cleanup);
    channel.once('close', cleanup);
    channel.pipe(socket).pipe(channel);
  }

  scheduleReconnect() {
    if (this.closed || this.retryTimer || !this.serverNames.size) return;
    const delay = this.retryDelays[Math.min(this.retryAttempt++, this.retryDelays.length - 1)];
    this.log.warn(`Tiled tunnel interrupted; reconnecting in ${delay / 1000} seconds.`);
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      try {
        await this.ensureReady();
      } catch (error) {
        if (!this.closed) this.log.warn(`Tiled tunnel reconnect failed: ${error.message}`);
      }
    }, delay);
    this.retryTimer.unref();
  }

  destroyStreams() {
    for (const { socket, channel } of this.streams) {
      socket.destroy();
      channel.destroy();
    }
    this.streams.clear();
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.destroyStreams();
    this.conn?.end();
    this.conn = null;
  }
}

module.exports = TiledTunnel;
