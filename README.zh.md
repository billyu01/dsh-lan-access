# dsh-lan-access

中文 | [English](README.md)

一个让 DeepSeek Harness 支持**手机远程访问**的 cordis 插件：内置反向代理，每个地址独立开关，支持局域网与 Tailscale。

> **仅做学习参考。** 本项目按原样提供，仅供学习与参考。它会在无认证的情况下暴露 Harness 的 Web 界面，请勿在不信任的网络或生产环境中使用。详见文末免责声明。

## 它解决什么问题

DeepSeek Harness 的 Web 界面默认只接受来自 `localhost` 的 `/api` 请求（一道防 DNS 重绑定的浏览器信任栅栏）。用手机打开 `http://<你的局域网IP>:3080` 时，页面能加载，但所有 `/api` 请求都返回 `403`。此外它还依赖 `crypto.randomUUID`，而该 API 在非安全上下文（纯 http）下不存在。

本插件在「手机访问」设置页里一并解决这两个问题：

- **每个地址独立开关** —— 每个本机 IPv4 地址（局域网和 VPN/Tailscale）各有一个开关，**默认全部关闭**。
- **内置反向代理** —— 打开某个地址的开关后，会启动一个小型代理，监听 `<地址>:3082` 并转发到 `127.0.0.1:3080`，同时把 `Host`/`Origin` 重写为 loopback，使栅栏放行所有 `/api` 请求（包括特权方法）。
- **`crypto.randomUUID` polyfill** —— 注入 `index.html`，让 SPA 能在纯 http 下正常启动。

## 使用手册

1. 将插件安装并挂载到 DSH 的 Web 组合中（见 `cordis.patch.yml`）。
2. 打开 **设置 → 手机访问**。
3. 打开你想要的地址对应的开关（例如 Tailscale 的 `100.x` 地址，或 Wi-Fi 的 `192.168.x.x`）。
4. 在手机上打开 `http://<该地址>:3082/`。

不需要远程访问时，记得关闭开关。

## Android 应用

除了在手机浏览器直接打开 `http://<该地址>:3082/`，也可以使用打包好的 Android 应用（`dsh-access`）。

### 下载

在 [Releases](../../releases) 页面下载最新的 `dsh-access.apk`。

### 安装

APK 未上架应用商店，需要侧载安装：

1. 把 `dsh-access.apk` 下载到手机。
2. 打开 APK，按系统提示允许「未知来源」安装。
3. 若之前装过旧版本，先卸载再装——不同版本签名不同，直接覆盖会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。

### 使用

1. 打开 **dsh-access**。
2. 输入带 token 的访问地址（例如 `http://192.168.1.10:3082/?token=<token>`，token 由 `dsh web` 启动时打印），点「进入」。
3. 已保存的地址会自动列出并显示连通性状态，之后点击即可再次进入。

> 应用需与插件配合：先在 **设置 → 手机访问** 打开对应地址的开关，再把该地址（`3082` 端口）填入应用。

## 原理

```
手机 ── http://<ip>:3082/ ──> 反向代理 (src/proxy-server.cjs)
                                   │ 重写 Host/Origin → 127.0.0.1:3080
                                   ▼
                              DSH Web 服务器 (:3080)
                                   │ /api 栅栏看到 loopback → 放行
                                   ▼
                              DeepSeek Harness
```

控制链路：

- **Host 半部**（`src/index.js`）向 `index.html` 注入 polyfill，暴露两个 JSON 路由（`GET /lan/info`、`POST /lan/set`），并为每个已开启的地址管理一个 `node` 子进程。
- **浏览器半部**（`src/client.js`）渲染设置页，通过这两个路由与 Host 半部通信。

## 目录结构

```
dsh-lan-access/
├── package.json          # 包元数据、导出、发布脚本
├── cordis.patch.yml      # 组合行示例
├── src/
│   ├── index.js          # Host 半部（ESM cordis 插件）
│   ├── client.js         # 浏览器半部（设置页 UI）
│   └── proxy-server.cjs  # 每地址反向代理（子进程）
├── scripts/
│   └── release.sh        # npm 发布辅助脚本
├── README.md / README.zh.md
└── LICENSE
```

## 开发与发布

```bash
npm run release -- patch   # 升版本并发布（patch | minor | major | x.y.z）
```

## 免责声明

本项目**仅供学习与参考**。它没有移除任何认证屏障——任何能访问到已开启地址 3082 端口的设备，都会获得 Harness Web 界面的完整访问权，包括文件浏览与 shell 执行。请只在可信网络（你自己的局域网、私有 Tailscale 网络）中使用。作者对因使用本软件造成的任何损害或数据丢失概不负责。本项目与 DeepSeek 无关。

## 许可证

[MIT](LICENSE)
