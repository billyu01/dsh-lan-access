# dsh-lan-access

[中文](README.zh.md) | English

Access your DeepSeek Harness from your phone over **LAN or Tailscale** — a
cordis plugin with a built-in reverse proxy and per-address toggle switches.

> **Educational use only.** This project is provided as-is for learning and
> reference. It exposes the Harness web UI without authentication; do not use
> it on untrusted networks or in production. See the disclaimer below.

## What it does

DeepSeek Harness's web UI normally only accepts `/api` requests from
`localhost` (a browser-trust fence against DNS rebinding). Opening
`http://<your-lan-ip>:3080` from a phone serves the page but every `/api`
call returns `403`. It also relies on `crypto.randomUUID`, which is absent in
non-secure contexts (plain http).

This plugin fixes both, inside a "Mobile Access" settings page:

- **Per-address toggle switches** — each local IPv4 address (LAN and
  VPN/Tailscale) gets its own switch, **all off by default**.
- **Built-in reverse proxy** — turning an address on spawns a tiny proxy that
  listens on `<address>:3082` and forwards to `127.0.0.1:3080`, rewriting
  `Host`/`Origin` to loopback so the fence accepts every `/api` request —
  including the privileged ones.
- **`crypto.randomUUID` polyfill** — injected into `index.html` so the SPA
  boots over plain http.

## Usage

1. Install and mount the plugin in a DSH web composition (see
   `cordis.patch.yml`).
2. Open **Settings → 手机访问 / Mobile Access**.
3. Flip the switch for the address you want (e.g. your Tailscale `100.x`
   address or the Wi-Fi `192.168.x.x`).
4. On your phone, open `http://<that-address>:3082/`.

Keep switches off when you don't need remote access.

## How it works

```
phone ── http://<ip>:3082/ ──> proxy (src/proxy-server.cjs)
                                   │ rewrites Host/Origin → 127.0.0.1:3080
                                   ▼
                              DSH web server (:3080)
                                   │ /api fence sees loopback → accept
                                   ▼
                              DeepSeek Harness
```

The control flow:

- **Host half** (`src/index.js`) injects the polyfill into `index.html`,
  exposes two JSON routes (`GET /lan/info`, `POST /lan/set`), and manages one
  `node` subprocess per enabled address.
- **Browser half** (`src/client.js`) renders the settings section and talks to
  the host half through those two routes.

## Repository layout

```
dsh-lan-access/
├── package.json          # package metadata, exports, release script
├── cordis.patch.yml      # example composition rows
├── src/
│   ├── index.js          # Host half (ESM cordis plugin)
│   ├── client.js         # Browser half (settings UI)
│   └── proxy-server.cjs  # per-address reverse proxy (spawned child)
├── scripts/
│   └── release.sh        # npm publish helper
├── README.md / README.zh.md
└── LICENSE
```

## Development

```bash
npm run release -- patch   # bump + publish (patch | minor | major | x.y.z)
```

## Disclaimer

This project is for **educational and reference purposes only**. It removes no
authentication barrier — any device that can reach an enabled address on port
3082 gains full access to the Harness web UI, including file browsing and
shell execution. Use it only on networks you trust (your own LAN, a private
Tailscale tailnet). The author(s) are not responsible for any damage or data
loss caused by using this software. This project is not affiliated with
DeepSeek.

## License

[MIT](LICENSE)
