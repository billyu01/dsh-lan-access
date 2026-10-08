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

1. Install the plugin into a DSH web profile. It ships as a profile bundle
   (`dsh.bundle.patch`), so the plugin manager adds it to
   `dsh.profile.bundles` and the bundle patch mounts both halves by itself:
   install it from the Plugins page, or run
   `dsh plugin --profile <name> add dsh-lan-access`. To compose it by hand
   instead, copy the `insert` list from `cordis.patch.yml` into the profile's
   own `cordis.patch.yml`.
2. Open **Settings → 手机访问 / Mobile Access**.
3. Flip the switch for the address you want (e.g. your Tailscale `100.x`
   address or the Wi-Fi `192.168.x.x`).
4. On your phone, open `http://<that-address>:3082/`.

The switch works in both surfaces: `dsh web` (default port 3080, or whatever
`--port` selects) and the DeepSeek Harness **Desktop client**, whose web server
runs on `19387`. The proxy picks up whichever port the running host actually
listens on, so no configuration is needed. The proxy also performs the launch
token exchange itself and injects the resulting session cookie, so the phone
URL needs no `?token=`.

Keep switches off when you don't need remote access.

## Android app

Besides opening `http://<that-address>:3082/` in a mobile browser, you can use
the prebuilt Android app (`dsh-access`).

### Download

Download the latest `dsh-access.apk` from the [dsh-app Releases](https://github.com/billyu01/dsh-app/releases). Source: [billyu01/dsh-app](https://github.com/billyu01/dsh-app).

### Install

The APK is not on an app store — sideload it:

1. Download `dsh-access.apk` to your phone.
2. Open it and allow "unknown sources" when Android prompts.
3. If an older version is installed, uninstall it first — builds are signed
   differently, so installing over the old one fails with
   `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.

### Usage

1. Open **dsh-access**.
2. Enter the access address with its token (e.g.
   `http://192.168.1.10:3082/?token=<token>`, where `<token>` is printed by
   `dsh web` on startup) and tap **Enter**.
3. Saved addresses are listed with their reachability status; tap one to open
   it again.

> The app pairs with the plugin: enable an address switch under
> **Settings → Mobile Access**, then enter that address (port `3082`)
> in the app.

## How it works

```
phone ── http://<ip>:3082/ ──> proxy (src/proxy-server.cjs)
                                   │ rewrites Host/Origin → 127.0.0.1:<live port>
                                   ▼
                              DSH web server (:3080, or any --port;
                                             the Desktop client pins 19387)
                                   │ /api fence sees loopback → accept
                                   ▼
                              DeepSeek Harness
```

The control flow:

- **Host half** (`src/index.js`) injects the polyfill into `index.html`,
  exposes two JSON routes (`GET /lan/info`, `POST /lan/set`), and manages one
  `node` subprocess per enabled address. It reads the upstream authority from
  the live `webServer` service, so `dsh web --port <n>` and the Desktop client
  (which runs its web server on `19387`) both work; the old hardcoded `3080`
  left the proxy retrying its handshake forever without ever binding.
- The host half only reports a switch as **on** after it observes the proxy
  accepting connections; a proxy that never binds is terminated and the
  settings row shows the reason instead of a phantom "on" state.
- **Browser half** (`src/client.js`) renders the settings section and talks to
  the host half through those two routes.

## Tests

```sh
npm test        # node:test — proxy contract + host-half contract, no network needed
```

The suite drives the real `src/proxy-server.cjs` against a fake upstream and
the host half against a stubbed `ctx`, including the regression where the
proxy must bind even while its upstream handshake cannot succeed yet.

## Repository layout

```
dsh-lan-access/
├── package.json          # package metadata, exports, release script
├── cordis.patch.yml      # example composition rows
├── src/
│   ├── index.js          # Host half (ESM cordis plugin)
│   ├── client.js         # Browser half (settings UI)
│   └── proxy-server.cjs  # per-address reverse proxy (spawned child)
├── lib/
│   └── client.js         # Browser half, hand-mirrored bundle served to clients
├── test/                 # node:test contract tests (not published)
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
