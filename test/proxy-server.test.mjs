/**
 * dsh-lan-access — reverse-proxy contract tests.
 *
 * These drive the real `src/proxy-server.cjs` child process. The regression
 * they lock down is the one that broke remote access under the Desktop client:
 * the proxy used to call `listen()` only after the upstream token handshake
 * succeeded, so a wrong/stale upstream port left the process alive but the
 * phone's port dead.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const PROXY_SCRIPT = fileURLToPath(new URL('../src/proxy-server.cjs', import.meta.url))
const HOST = '127.0.0.1'

/** Reserve a free loopback port by binding and immediately releasing it. */
async function freePort() {
  const server = net.createServer()
  server.listen(0, HOST)
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** Poll a TCP connect until it succeeds or the deadline passes. */
async function waitForConnect(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ host: HOST, port })
      socket.setTimeout(400)
      const settle = (value) => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(value)
      }
      socket.once('connect', () => settle(true))
      socket.once('error', () => settle(false))
      socket.once('timeout', () => settle(false))
    })
    if (ok) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Spawn the proxy with a controlled environment and collect its output. */
function startProxy(env) {
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))
  return { child, logs }
}

function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

/** One plain GET through the proxy with caller-shaped Host/Origin headers. */
function getThroughProxy(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port, method: 'GET', path, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('proxy accepts phone connections even when the upstream handshake cannot succeed yet', async () => {
  const proxyPort = await freePort()
  // Nothing listens here: every handshake attempt fails, as it did when the
  // plugin pointed at the wrong upstream port.
  const deadUpstreamPort = await freePort()
  const { child, logs } = startProxy({
    LAN_PROXY_BIND: HOST,
    LAN_PROXY_PORT: String(proxyPort),
    LAN_PROXY_UPSTREAM_HOST: HOST,
    LAN_PROXY_UPSTREAM_PORT: String(deadUpstreamPort),
    LAN_PROXY_TOKEN: 'launch-token',
  })
  try {
    const listening = await waitForConnect(proxyPort, 3000)
    assert.equal(listening, true, `proxy never listened on ${HOST}:${proxyPort}\n${logs.join('')}`)
  } finally {
    stopChild(child)
  }
})

test('proxy rewrites Host/Origin to loopback and injects the session cookie', async () => {
  const seen = []
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/?token=')) {
      res.writeHead(303, { 'set-cookie': 'dsh-auth-test=session-value; Path=/', location: './' })
      res.end()
      return
    }
    seen.push({ host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  upstream.listen(0, HOST)
  await once(upstream, 'listening')
  const upstreamPort = upstream.address().port
  const proxyPort = await freePort()
  const { child, logs } = startProxy({
    LAN_PROXY_BIND: HOST,
    LAN_PROXY_PORT: String(proxyPort),
    LAN_PROXY_UPSTREAM_HOST: HOST,
    LAN_PROXY_UPSTREAM_PORT: String(upstreamPort),
    LAN_PROXY_TOKEN: 'launch-token',
  })
  try {
    assert.equal(await waitForConnect(proxyPort, 3000), true, `proxy never listened\n${logs.join('')}`)
    // The handshake now happens in the background, so poll a few forwarded
    // requests until the cookie has been minted.
    const deadline = Date.now() + 3000
    let response
    for (;;) {
      response = await getThroughProxy(proxyPort, '/api/probe', {
        host: '192.168.1.50:3082',
        origin: 'http://192.168.1.50:3082',
      })
      const last = seen[seen.length - 1]
      if (last !== undefined && last.cookie !== undefined) break
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(response.status, 200)
    assert.equal(response.body, '{"ok":true}')
    const last = seen[seen.length - 1]
    assert.ok(last !== undefined, 'upstream saw no forwarded request')
    assert.equal(last.host, `${HOST}:${upstreamPort}`, 'Host must be rewritten to the upstream loopback authority')
    assert.equal(last.origin, `http://${HOST}:${upstreamPort}`, 'Origin must be rewritten to the same authority')
    assert.equal(last.cookie, 'dsh-auth-test=session-value', 'forwarded requests must carry the minted session cookie')
  } finally {
    stopChild(child)
    await new Promise((resolve) => upstream.close(resolve))
  }
})
