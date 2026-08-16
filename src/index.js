/**
 * dsh-lan-access — Host half.
 *
 * A standard cordis plugin (ESM). It:
 *   1. injects a `crypto.randomUUID` polyfill into index.html so the SPA
 *      boots in non-secure contexts (plain http over a LAN/Tailscale IP);
 *   2. exposes two JSON control routes used by the browser half:
 *        GET  /lan/info — local IPv4 addresses + per-address enabled state
 *        POST /lan/set  — enable/disable the reverse proxy for one address
 *   3. spawns one reverse-proxy subprocess per enabled address (see
 *      proxy-server.cjs), which rewrites Host/Origin to loopback so DSH's
 *      /api browser-trust fence accepts the request.
 *
 * Consumes these host services (all optional, read with ctx.get):
 *   - webServer   (index.html tap + the two control routes)
 *   - subprocess  (spawns the proxy processes)
 *   - shell       (detects local IPv4 addresses)
 */
import { fileURLToPath } from 'node:url'

export const name = 'lan-access'
export const inject = []

const PROXY_PORT = 3082
const PROXY_SCRIPT = fileURLToPath(new URL('./proxy-server.cjs', import.meta.url))

/** Build the crypto.randomUUID polyfill <script> tag. */
function polyfillScript() {
  const body = [
    '(function(){',
    'try{',
    'if(typeof crypto!=="undefined"&&typeof crypto.randomUUID!=="function"){',
    'var make=function(){',
    'var b=new Uint8Array(16);crypto.getRandomValues(b);',
    'b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;',
    'var h=[];for(var i=0;i<16;i++){h.push((b[i]<16?"0":"")+b[i].toString(16));}',
    'return h[0]+h[1]+h[2]+h[3]+"-"+h[4]+h[5]+"-"+h[6]+h[7]+"-"+h[8]+h[9]+"-"+h[10]+h[11]+h[12]+h[13]+h[14]+h[15];',
    '};',
    'try{crypto.randomUUID=make;}catch(e){',
    'try{Object.defineProperty(crypto,"randomUUID",{value:make,configurable:true,writable:true});}catch(e2){}',
    '}',
    '}',
    '}catch(e){}',
    '})();',
  ].join('\n')
  return '<script>' + body + '<\/script>'
}

function injectPolyfill(html) {
  const script = polyfillScript()
  const head = html.indexOf('<head>')
  if (head !== -1) return html.slice(0, head + 6) + script + html.slice(head + 6)
  return script + html
}

/** True for RFC1918 / link-local IPv4. */
function isPrivate(ip) {
  const p = String(ip).split('.')
  if (p.length !== 4) return false
  const o = p.map((n) => parseInt(n, 10))
  if (o.some((n) => Number.isNaN(n))) return false
  if (o[0] === 10) return true
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true
  if (o[0] === 192 && o[1] === 168) return true
  if (o[0] === 169 && o[1] === 254) return true
  return false
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  const subprocess = ctx.get('subprocess')
  const shell = ctx.get('shell')

  // 1. crypto.randomUUID polyfill into index.html.
  if (webServer !== undefined) {
    ctx.effect(() => webServer.tapIndex(injectPolyfill), 'lan-access: randomUUID polyfill')
  }

  // Per-address proxy process handles: ip -> subprocess handle.
  const handles = new Map()
  let nodePathPromise = null
  const getNode = () => {
    if (nodePathPromise === null) nodePathPromise = subprocess.resolveExecutable('node')
    return nodePathPromise
  }

  const stopProxy = (ip) => {
    const h = handles.get(ip)
    if (h !== undefined) {
      try { h.terminate() } catch (e) { /* already gone */ }
      handles.delete(ip)
    }
  }

  const startProxy = async (ip) => {
    if (handles.has(ip)) return
    const nodePath = await getNode()
    const handle = subprocess.spawn({
      argv: [nodePath, PROXY_SCRIPT],
      cwd: '/',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      graceMs: 3000,
      env: {
        LAN_PROXY_PORT: String(PROXY_PORT),
        LAN_PROXY_BIND: ip,
      },
    })
    handles.set(ip, handle)
  }

  if (subprocess !== undefined) {
    ctx.effect(() => () => {
      for (const h of handles.values()) { try { h.terminate() } catch (e) { /* noop */ } }
      handles.clear()
    }, 'lan-access: proxy teardown')
  }

  // 2. Detect local IPv4 addresses once per request (cheap; lets the UI refresh).
  const listAddresses = async () => {
    const cmd = "(ifconfig 2>/dev/null || ip -4 addr show 2>/dev/null) | awk '/inet / && $2 !~ /^127\\./ {gsub(/addr:/,\"\",$2); sub(/\\/.*/,\"\",$2); print $2}' | sort -u"
    const spec = shell.resolve({ command: cmd, timeoutMs: 6000 })
    const result = await shell.run(spec)
    const text = (result && result.stdout && result.stdout.text) ? result.stdout.text : ''
    const ips = text.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
    return ips.map((ip) => ({ ip, private: isPrivate(ip), enabled: handles.has(ip) }))
  }

  // 3. Control routes used by the browser half.
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/lan/info',
      handler: async (req, res) => {
        if (shell === undefined) return json(res, 200, { ok: true, items: [], port: PROXY_PORT })
        try {
          const items = await listAddresses()
          items.sort((a, b) => (a.private !== b.private) ? (a.private ? -1 : 1) : (a.ip < b.ip ? -1 : 1))
          json(res, 200, { ok: true, items, port: PROXY_PORT })
        } catch (err) {
          json(res, 200, { ok: false, items: [], port: PROXY_PORT, error: String(err && err.message ? err.message : err) })
        }
      },
    }), 'lan-access: /lan/info route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/lan/set',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
        if (subprocess === undefined) return json(res, 200, { ok: false, error: 'subprocess service unavailable' })
        let parsed
        try {
          parsed = JSON.parse(await readBody(req))
        } catch (e) {
          return json(res, 400, { ok: false, error: 'invalid json body' })
        }
        const ip = parsed && parsed.ip
        const enabled = !!(parsed && parsed.enabled)
        if (typeof ip !== 'string' || ip.length === 0) return json(res, 400, { ok: false, error: 'missing ip' })
        try {
          if (enabled) await startProxy(ip)
          else stopProxy(ip)
          return json(res, 200, { ok: true, ip, enabled })
        } catch (err) {
          return json(res, 200, { ok: false, ip, error: String(err && err.message ? err.message : err) })
        }
      },
    }), 'lan-access: /lan/set route')
  }
}
