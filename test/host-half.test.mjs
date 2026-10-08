/**
 * dsh-lan-access — host half contract tests.
 *
 * The host half must read the *live* web-server authority instead of the old
 * hardcoded `127.0.0.1:3080`: `dsh web --port` and the Desktop client (which
 * pins 19387) both move the upstream, and a stale upstream is exactly what left
 * the proxy process alive but the phone's port dead.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { once } from 'node:events'

import { apply } from '../src/index.js'

const PROXY_PORT = 3082

/** A port the stub proxy can actually bind, so readiness can be observed. */
async function canBind(host, port) {
  const server = net.createServer()
  try {
    server.listen(port, host)
    await once(server, 'listening')
    return true
  } catch {
    return false
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** A long-lived child that listens exactly where the spec's env says to. */
function listeningStub(spec) {
  const code = 'const net=require("node:net");net.createServer().listen(Number(process.env.LAN_PROXY_PORT),process.env.LAN_PROXY_BIND)'
  return childHandle(code, spec)
}

/** A long-lived child that never listens (models a proxy stuck before listen). */
function silentStub(spec) {
  return childHandle('setInterval(()=>{},1000)', spec)
}

function childHandle(code, spec) {
  const child = spawn(process.execPath, ['-e', code], {
    env: { ...process.env, ...spec.env },
    stdio: 'ignore',
  })
  return {
    terminate: () => child.kill('SIGKILL'),
    done: new Promise((resolve) => child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }))),
    waitForExit: () => new Promise((resolve) => child.once('exit', resolve)),
  }
}

/** Minimal cordis-shaped context capturing the routes the host half registers. */
function makeContext({ upstreamPort, spawnImpl }) {
  const routes = new Map()
  const calls = { authenticatedUrl: [], spawn: [] }
  const handles = []
  const webServer = {
    host: '127.0.0.1',
    port: upstreamPort,
    tapIndex: () => () => {},
    register: (route) => {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const connection = {
    authenticatedUrl: (baseUrl) => {
      calls.authenticatedUrl.push(baseUrl)
      return `${baseUrl}/?token=launch-token`
    },
  }
  const subprocess = {
    resolveExecutable: async () => process.execPath,
    spawn: (spec) => {
      calls.spawn.push(spec)
      const handle = spawnImpl(spec)
      handles.push(handle)
      return handle
    },
  }
  const services = { webServer, subprocess, connection }
  const ctx = {
    get: (name) => services[name],
    effect: (fn) => fn(),
  }
  apply(ctx)
  return {
    routes,
    calls,
    /** Terminate every stub child and wait for it to die, so its port is free. */
    dispose: async () => {
      for (const handle of handles) {
        try { handle.terminate() } catch { /* already gone */ }
      }
      await Promise.all(handles.map((handle) => handle.done.catch(() => {})))
    },
  }
}

/** One POST /lan/set carrying a JSON body. */
async function postSet(route, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  const captured = { status: 0, body: '' }
  const res = {
    writeHead(status) {
      captured.status = status
    },
    end(payload) {
      if (payload !== undefined) captured.body += String(payload)
    },
  }
  await route.handler(req, res)
  return { status: captured.status, json: JSON.parse(captured.body) }
}

/** One GET /lan/info. */
async function getInfo(route) {
  const req = Readable.from([])
  req.method = 'GET'
  const captured = { status: 0, body: '' }
  const res = {
    writeHead(status) {
      captured.status = status
    },
    end(payload) {
      if (payload !== undefined) captured.body += String(payload)
    },
  }
  await route.handler(req, res)
  return { status: captured.status, json: JSON.parse(captured.body) }
}

test('host half points the proxy at the live web-server authority, not 3080', async (t) => {
  const upstreamPort = 45678
  const harness = makeContext({ upstreamPort, spawnImpl: listeningStub })
  t.after(harness.dispose)
  const { routes, calls } = harness
  const set = routes.get('/lan/set')
  assert.ok(set !== undefined, '/lan/set must be registered')

  const started = await postSet(set, { ip: '127.0.0.1', enabled: true })
  try {
    assert.equal(started.json.ok, true)
    assert.equal(started.json.enabled, true)
    const spec = calls.spawn[0]
    assert.ok(spec !== undefined, 'the host half must spawn a proxy')
    assert.equal(spec.env.LAN_PROXY_UPSTREAM_PORT, String(upstreamPort))
    assert.equal(spec.env.LAN_PROXY_UPSTREAM_HOST, '127.0.0.1')
    assert.equal(spec.env.LAN_PROXY_TOKEN, 'launch-token')
    assert.equal(spec.env.LAN_PROXY_BIND, '127.0.0.1')
    assert.deepEqual(calls.authenticatedUrl, [`http://127.0.0.1:${upstreamPort}`])
  } finally {
    await postSet(set, { ip: '127.0.0.1', enabled: false })
  }
})

test('host half reports failure (and no enabled state) when the proxy never listens', { skip: !(await canBind('127.0.0.1', PROXY_PORT)) && `port ${PROXY_PORT} is already in use` }, async (t) => {
  const harness = makeContext({ upstreamPort: 45678, spawnImpl: silentStub })
  t.after(harness.dispose)
  const set = harness.routes.get('/lan/set')

  const started = await postSet(set, { ip: '127.0.0.1', enabled: true })
  assert.equal(started.json.ok, false, 'a proxy that never listens must not report success')
  assert.equal(started.json.enabled, false)
  assert.match(started.json.error, /3082/)
})

test('/lan/info exposes the proxy port and the live upstream', async (t) => {
  const harness = makeContext({ upstreamPort: 19387, spawnImpl: listeningStub })
  t.after(harness.dispose)
  const info = harness.routes.get('/lan/info')
  assert.ok(info !== undefined, '/lan/info must be registered')

  const response = await getInfo(info)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.port, PROXY_PORT)
  assert.deepEqual(response.json.upstream, { host: '127.0.0.1', port: 19387 })
})
