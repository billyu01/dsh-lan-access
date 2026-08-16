/**
 * dsh-lan-access — Browser half.
 *
 * Registers a "手机访问 / Mobile Access" settings section. Each local IPv4
 * address is one row with a toggle switch (off by default) and a copy button.
 * The half talks to the Host half over the two JSON routes (/lan/info,
 * /lan/set) via plain fetch, so no dynamic-plugin RPC is required.
 *
 * Requires the `slots` service (declared as a hard dependency). Renders with
 * React.createElement; no JSX transform is assumed.
 */
export const inject = ['slots']

const CSS = `
.lan-access-page { font-family: inherit; color: inherit; }
.lan-access-page h2 { margin: 0 0 4px; font-size: 18px; }
.lan-access-page .lan-desc { margin: 0 0 16px; font-size: 13px; opacity: 0.75; line-height: 1.5; }
.lan-access-page .lan-hint { margin: 16px 0 0; font-size: 12px; opacity: 0.6; line-height: 1.5; }
.lan-access-page .lan-status { font-size: 13px; opacity: 0.7; padding: 8px 0; }
.lan-access-page .lan-error { color: #d64545; font-size: 13px; }
.lan-access-page .lan-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin: 8px 0; border: 1px solid rgba(128,128,128,0.25); border-radius: 10px; background: rgba(128,128,128,0.06); }
.lan-access-page .lan-url { flex: 1; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-all; }
.lan-access-page .lan-tag { font-size: 11px; padding: 2px 6px; border-radius: 999px; background: rgba(80,140,255,0.18); opacity: 0.85; white-space: nowrap; }
.lan-access-page .lan-tag.alt { background: rgba(128,128,128,0.18); }
.lan-access-page .lan-copy { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 6px; border: 1px solid rgba(128,128,128,0.3); background: transparent; color: inherit; cursor: pointer; }
.lan-access-page .lan-copy:hover { background: rgba(128,128,128,0.14); }
.lan-access-page .lan-toggle { display: inline-flex; align-items: center; flex-shrink: 0; background: none; border: none; cursor: pointer; padding: 4px 6px; border-radius: 8px; color: inherit; }
.lan-access-page .lan-toggle:hover { background: rgba(128,128,128,0.14); }
.lan-access-page .lan-toggle:disabled { opacity: 0.5; cursor: default; }
.lan-access-page .lan-toggle-track { position: relative; width: 42px; height: 24px; border-radius: 999px; background: rgba(128,128,128,0.4); transition: background 0.18s; flex-shrink: 0; }
.lan-access-page .lan-toggle.on .lan-toggle-track { background: #2ea05a; }
.lan-access-page .lan-toggle-thumb { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform 0.18s; box-shadow: 0 1px 2px rgba(0,0,0,0.3); }
.lan-access-page .lan-toggle.on .lan-toggle-thumb { transform: translateX(18px); }
.lan-access-page .lan-subtitle { margin: 16px 0 0; font-size: 12px; font-weight: 600; opacity: 0.65; }
`

async function lanInfo() {
  const res = await fetch('/lan/info')
  return res.json()
}

async function lanSet(ip, enabled) {
  const res = await fetch('/lan/set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip, enabled }),
  })
  return res.json()
}

function Toggle(props) {
  return React.createElement('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': props.enabled ? 'true' : 'false',
    'aria-label': props.enabled ? '关闭' : '开启',
    className: 'lan-toggle' + (props.enabled ? ' on' : ''),
    disabled: props.busy,
    onClick: props.onToggle,
  },
    React.createElement('span', { className: 'lan-toggle-track' },
      React.createElement('span', { className: 'lan-toggle-thumb' }),
    ),
  )
}

function CopyIcon(props) {
  if (props.done) {
    return React.createElement('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      React.createElement('path', { d: 'M20 6 9 17l-5-5' }),
    )
  }
  return React.createElement('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    React.createElement('rect', { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }),
    React.createElement('path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }),
  )
}

function copyText(text) {
  return new Promise((resolve) => {
    const done = () => resolve()
    try {
      if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done)
      } else if (typeof document !== 'undefined' && document) {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try { document.execCommand('copy') } catch (e) { /* noop */ }
        document.body.removeChild(ta)
        done()
      } else {
        done()
      }
    } catch (e) {
      done()
    }
  })
}

function LanAccessPage() {
  const [state, setState] = React.useState({ loading: true, items: [], port: 3082, error: null })
  const [pending, setPending] = React.useState({})
  const [copied, setCopied] = React.useState(null)

  React.useEffect(() => {
    let alive = true
    lanInfo().then((data) => {
      if (!alive) return
      if (data && data.ok) {
        setState({ loading: false, items: data.items || [], port: data.port || 3082, error: null })
      } else {
        setState({ loading: false, items: [], port: (data && data.port) || 3082, error: (data && data.error) || '无法获取局域网地址' })
      }
    }).catch((err) => {
      if (!alive) return
      setState({ loading: false, items: [], port: 3082, error: String(err && err.message ? err.message : err) })
    })
    return () => { alive = false }
  }, [])

  const toggle = (it) => {
    const next = !it.enabled
    setPending((prev) => { const p = { ...prev }; p[it.ip] = true; return p })
    lanSet(it.ip, next).then((res) => {
      setPending((prev) => { const p = { ...prev }; p[it.ip] = false; return p })
      if (res && res.ok) {
        setState((prev) => ({
          loading: prev.loading,
          port: prev.port,
          error: prev.error,
          items: prev.items.map((x) => x.ip === it.ip ? { ip: x.ip, private: x.private, enabled: res.enabled } : x),
        }))
      }
    }).catch(() => {
      setPending((prev) => { const p = { ...prev }; p[it.ip] = false; return p })
    })
  }

  const onCopy = async (url) => {
    await copyText(url)
    setCopied(url)
  }

  const children = []
  children.push(React.createElement('h2', null, '手机远程访问'))
  children.push(React.createElement('p', { className: 'lan-desc' }, '每个地址一个开关，默认全部关闭。点开关开启后，再用手机访问该地址。'))

  if (state.loading) {
    children.push(React.createElement('div', { className: 'lan-status' }, '正在检测本机地址…'))
  } else if (state.error) {
    children.push(React.createElement('div', { className: 'lan-error' }, state.error))
  } else {
    const privates = state.items.filter((it) => it.private)
    const others = state.items.filter((it) => !it.private)
    const all = privates.concat(others)
    if (all.length === 0) {
      children.push(React.createElement('div', { className: 'lan-status' }, '未检测到局域网地址，请确认电脑已连接网络。'))
    } else {
      let lastWasPrivate = null
      all.forEach((it) => {
        if (lastWasPrivate === true && !it.private) {
          children.push(React.createElement('div', { className: 'lan-subtitle' }, '其他地址（VPN / 虚拟网卡）'))
        }
        lastWasPrivate = it.private
        const url = 'http://' + it.ip + ':' + state.port + '/'
        const busy = pending[it.ip] === true
        const isCopied = copied === url
        children.push(React.createElement('div', { className: 'lan-row', key: it.ip },
          React.createElement('span', { className: 'lan-url' }, url),
          React.createElement('span', { className: 'lan-tag' + (it.private ? '' : ' alt') }, it.private ? '局域网' : '其他'),
          React.createElement(Toggle, { enabled: !!it.enabled, busy, onToggle: () => toggle(it) }),
          React.createElement('button', { className: 'lan-copy', title: isCopied ? '已复制' : '复制', 'aria-label': isCopied ? '已复制' : '复制', onClick: () => onCopy(url) },
            React.createElement(CopyIcon, { done: isCopied }),
          ),
        ))
      })
    }
    children.push(React.createElement('p', { className: 'lan-hint' }, '提示：开启后若手机打不开，请确认电脑防火墙允许 ' + state.port + ' 端口入站，且手机与电脑处于同一网络。'))
  }

  return React.createElement('div', { className: 'lan-access-page' }, children)
}

export function apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-lan-access'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'lan-access: styles')

  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'mobile-access', order: 30, label: '手机访问' },
    () => React.createElement(LanAccessPage),
  ))
}
