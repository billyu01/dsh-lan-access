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
 *   LAN_PROXY_TOKEN           launch token for the upstream auth handshake
 *
 * The upstream DSH web server now requires a per-launch token + signed cookie.
 * When LAN_PROXY_TOKEN is set, this proxy performs the handshake itself at
 * startup and injects the resulting session cookie into every forwarded
 * request, so clients on this port need no token of their own. Intended for
 * trusted LAN / Tailscale only; see README.
 */
'use strict';

const http = require('node:http');
const net = require('node:net');
const zlib = require('node:zlib');

const PORT = Number(process.env.LAN_PROXY_PORT || 3082);
const BIND = process.env.LAN_PROXY_BIND || '0.0.0.0';
const UP_HOST = process.env.LAN_PROXY_UPSTREAM_HOST || '127.0.0.1';
const UP_PORT = Number(process.env.LAN_PROXY_UPSTREAM_PORT || 3080);
const AUTH = UP_HOST + ':' + UP_PORT;
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
const TOKEN = process.env.LAN_PROXY_TOKEN || '';
// 代理向上游换取到的会话 cookie（name=value）。一旦持有，所有转发都自动带上它，
// 使得 3082 的访问者无需再手动携带 token。
let sessionCookie = '';

// Headers that must not be forwarded verbatim; host is set explicitly below.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'host',
]);

// Reuse upstream connections (proxy -> loopback DSH). The original proxy
// forced `connection: close` on every request, so a phone had to open a fresh
// TCP connection per plugin bundle — dozens of handshakes over Tailscale/Wi-Fi
// that intermittently timed out as "bundle script ... failed to load".
const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });

/** 从 Set-Cookie 头（string | string[]）里取出第一段的 name=value。 */
function extractCookie(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const item of list) {
    if (typeof item === 'string') {
      const semi = item.indexOf(';');
      const pair = semi === -1 ? item : item.slice(0, semi);
      if (pair.includes('=')) return pair.trim();
    }
  }
  return '';
}

/**
 * 用启动令牌向上游 GET /?token=… 完成认证握手，缓存返回的会话 cookie。
 * 只有成功拿到 cookie 才返回 true。
 */
function authenticateUpstream() {
  return new Promise((resolve) => {
    const req = http.request({
      host: UP_HOST,
      port: UP_PORT,
      method: 'GET',
      path: '/?token=' + encodeURIComponent(TOKEN),
      headers: { host: AUTH },
      agent: upstreamAgent,
    }, (res) => {
      sessionCookie = extractCookie(res.headers['set-cookie']);
      res.resume();
      resolve(sessionCookie !== '');
    });
    req.on('error', () => { sessionCookie = ''; resolve(false); });
    req.end();
  });
}

function forwardHttp(req, res) {
  const headers = {};
  const hasBody = (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
    || req.headers['transfer-encoding'] !== undefined;
  for (const k of Object.keys(req.headers)) {
    if (HOP_BY_HOP.has(k)) continue;
    const v = req.headers[k];
    if (v !== undefined) headers[k] = v;
  }
  headers.host = AUTH;
  if (sessionCookie) headers.cookie = sessionCookie;
  // Bodyless requests (the bundle fetches) keep the connection alive so the
  // phone reuses one connection across dozens of bundles. Requests with a body
  // still close to delimit it (content-length / transfer-encoding are
  // hop-by-hop and are not re-framed here).
  if (hasBody) headers.connection = 'close';
  if (req.headers.origin !== undefined) headers.origin = 'http://' + AUTH;

  const upstream = http.request({
    host: UP_HOST,
    port: UP_PORT,
    method: req.method,
    path: req.url,
    headers,
    agent: upstreamAgent,
  }, (upstreamRes) => {
    const status = upstreamRes.statusCode || 502;
    const contentType = String(upstreamRes.headers['content-type'] || '');
    const compressible = /(^text\/|application\/(json|javascript|x-javascript|xml)|image\/svg\+xml|application\/manifest\+json)/i.test(contentType);
    const wantsGzip = /gzip/i.test(String(req.headers['accept-encoding'] || ''));
    const alreadyEncoded = upstreamRes.headers['content-encoding'] !== undefined;

    // Re-compress shell assets / bundles / html before they cross the phone's
    // network: the upstream serves them uncompressed (1.2MB+ of JS/CSS), which
    // intermittently stalls out on 5G/Tailscale. Gzip cuts that ~4x.
    if (status === 200 && compressible && wantsGzip && !alreadyEncoded) {
      const resHeaders = {};
      for (const k of Object.keys(upstreamRes.headers)) {
        if (k === 'connection' || k === 'keep-alive' || k === 'content-length' || k === 'transfer-encoding' || k === 'content-encoding') continue;
        const v = upstreamRes.headers[k];
        if (v !== undefined) resHeaders[k] = v;
      }
      resHeaders['content-encoding'] = 'gzip';
      resHeaders['vary'] = 'Accept-Encoding';
      res.writeHead(status, resHeaders);
      const gz = zlib.createGzip({ level: 6 });
      gz.on('error', () => { try { res.destroy(); } catch (e) {} });
      upstreamRes.pipe(gz).pipe(res);
    } else {
      const resHeaders = {};
      for (const k of Object.keys(upstreamRes.headers)) {
        if (k === 'connection' || k === 'keep-alive') continue;
        const v = upstreamRes.headers[k];
        if (v !== undefined) resHeaders[k] = v;
      }
      res.writeHead(status, resHeaders);
      upstreamRes.pipe(res);
    }
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
      if (k === 'host' || k === 'origin' || k === 'cookie') continue;
      const v = req.headers[k];
      if (v !== undefined) lines.push(k + ': ' + (Array.isArray(v) ? v.join(', ') : v));
    }
    lines.push('host: ' + AUTH);
    if (req.headers.origin !== undefined) lines.push('origin: http://' + AUTH);
    if (sessionCookie) lines.push('cookie: ' + sessionCookie);
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

async function start() {
  if (TOKEN) {
    const ok = await authenticateUpstream();
    if (!ok) {
      console.error('[dsh-lan-access] upstream auth failed — retrying in 3s');
      setTimeout(start, 3000);
      return;
    }
    console.log('[dsh-lan-access] upstream session established');
  }
  listen();
}

start();
