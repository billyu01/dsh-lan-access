#!/usr/bin/env node
/**
 * dsh-lan-access — per-address reverse proxy.
 *
 * Spawned by the host plugin (one process per enabled address). It listens on
 * ONE local IPv4 address and forwards HTTP + WebSocket to the loopback DSH web
 * server, rewriting Host/Origin to the loopback authority so DSH's own /api
 * browser-trust fence sees a local same-origin request and accepts it.
 *
 * Environment (set by the host plugin):
 *   LAN_PROXY_BIND            address to listen on (default 0.0.0.0)
 *   LAN_PROXY_PORT            listen port (default 3082)
 *   LAN_PROXY_UPSTREAM_HOST   upstream host (default 127.0.0.1)
 *   LAN_PROXY_UPSTREAM_PORT   upstream port (default 3080)
 *
 * No authentication. Intended for trusted LAN / Tailscale only; see README.
 */
'use strict';

const http = require('node:http');
const net = require('node:net');

const PORT = Number(process.env.LAN_PROXY_PORT || 3082);
const BIND = process.env.LAN_PROXY_BIND || '0.0.0.0';
const UP_HOST = process.env.LAN_PROXY_UPSTREAM_HOST || '127.0.0.1';
const UP_PORT = Number(process.env.LAN_PROXY_UPSTREAM_PORT || 3080);
const AUTH = UP_HOST + ':' + UP_PORT;
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);

// Headers that must not be forwarded verbatim; host is set explicitly below.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'host',
]);

function forwardHttp(req, res) {
  const headers = {};
  for (const k of Object.keys(req.headers)) {
    if (HOP_BY_HOP.has(k)) continue;
    const v = req.headers[k];
    if (v !== undefined) headers[k] = v;
  }
  headers.host = AUTH;
  headers.connection = 'close';
  if (req.headers.origin !== undefined) headers.origin = 'http://' + AUTH;

  const upstream = http.request({
    host: UP_HOST,
    port: UP_PORT,
    method: req.method,
    path: req.url,
    headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('bad gateway');
  });
  req.pipe(upstream);
}

function forwardUpgrade(req, socket, head) {
  const upstream = net.connect(UP_PORT, UP_HOST, () => {
    const lines = [req.method + ' ' + req.url + ' HTTP/1.1'];
    for (const k of Object.keys(req.headers)) {
      if (k === 'host' || k === 'origin') continue;
      const v = req.headers[k];
      if (v !== undefined) lines.push(k + ': ' + (Array.isArray(v) ? v.join(', ') : v));
    }
    lines.push('host: ' + AUTH);
    if (req.headers.origin !== undefined) lines.push('origin: http://' + AUTH);
    lines.push('', '');
    upstream.write(lines.join(CRLF));
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

const server = http.createServer((req, res) => forwardHttp(req, res));
server.on('upgrade', (req, socket, head) => forwardUpgrade(req, socket, head));

function listen() {
  const onError = (err) => {
    server.removeListener('error', onError);
    console.error('[dsh-lan-access] bind ' + BIND + ':' + PORT + ' failed: ' +
      (err && err.message ? err.message : err) + ' — retrying in 3s');
    setTimeout(listen, 3000);
  };
  server.once('error', onError);
  server.listen(PORT, BIND, () => {
    server.removeListener('error', onError);
    console.log('[dsh-lan-access] listening on ' + BIND + ':' + PORT +
      ' -> http://' + AUTH);
  });
}

listen();
