# dsh-frp-tunnel

把当前 DSH Web 界面通过你自己的 frps 云服务器映射到公网。Host 插件 + Web 设置页，随 profile 生效。

```
浏览器 ──► 反向代理(443) ──► frps:remotePort ──► frpc ──► 127.0.0.1:<中继> ──► 127.0.0.1:<DSH 端口>
              (可选)            (你的云服务器)              (本插件)          (每次启动都不同)
```

安卓客户端源码在 [`mobile-app/`](mobile-app/)（Wails v3），编译好的 APK 见 [Releases](../../releases)。

## 为什么中间要加一层中继

DSH 的端口是 `--port 0` 由系统分配的，每次启动都变；frpc 的 TOML 里也没法写「当前端口」。所以插件在运行时读 `ctx.webServer.getOrigin()`，把真实端口填进生成的 frpc 配置。

中继还解决第二个问题：DSH 的 `/api` 有一道 `Host`/`Origin` 信任栅栏，登录 Cookie 也绑定 host:port。公网域名直接打进来会被 403。中继把 `Host`、`Origin`、`Referer` 改写成 loopback authority 再转发，于是不用往 `trustedHosts` 里塞公网域名，Cookie 也照常有效。

中继只监听 `127.0.0.1`，端口同样由系统分配。可选 HTTP Basic 层挡在 DSH 自己的令牌之前。

## 配置：用界面，不用改文件

**设置 → 插件（Plugins）→ 找到 `FRP 内联穿透` 这一行 → 点开**，右侧就是全部配置项，按「服务器 / 公网入口 / 访问控制 / 高级」分组。改完点「保存并生效」。

表单会立刻重建隧道：停旧的 frpc 和中继、用新值重启，不需要重启 DSH。所有字段都声明为 volatile，走的是设置服务的原地更新路径。

如果不改界面直接看文件，值落在 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/desktop/cordis.patch.yml`）里 `id: frp-tunnel` 下。`config` 是整体替换而不是深合并，所以界面保存时会把全部字段一起写回去。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉时插件完全不动作，中继和 frpc 都停 |
| `serverAddr` / `serverPort` | `''` / `7000` | 必填，否则只打一条告警 |
| `authToken` | `''` | frps 的 `auth.token`，标记为 secret，界面遮盖、日志剔除 |
| `user` | `''` | 仅当 frps 配了 `userConnections` 或用户隔离时填 |
| `tls` | `true` | 与 frps 控制连接之间的 TLS（`transport.tls.enable`） |
| `proxyType` | `tcp` | `tcp` 用 `remotePort`；`http` 用域名（需 frps 开 `vhostHTTPPort`/`vhostHTTPSPort`） |
| `remotePort` | `6080` | tcp 时的公网端口，受 frps `allowPorts` 约束 |
| `customDomain` / `subdomain` | `''` | http 模式用，二选一 |
| `proxyName` | `dsh-web` | 同一 frps 上不可重复 |
| `publicUrl` | `''` | 覆盖对外访问地址，留空自动推导 |
| `frpcPath` | `/opt/homebrew/bin/frpc` | `brew install frpc` 装出来的位置 |
| `tunnelUser` / `tunnelPassword` | `dsh` / `''` | 入口的 HTTP Basic；`tunnelPassword` 留空则不启用该层 |

界面里的「入口密码」建议设成与 frps 后台密码不同的强随机串——它挡在公网第一层。

## 产物

启动成功后写到 `~/.dsh/frp-tunnel/`（目录 `0700`，文件 `0600`）：

- `access-url.txt` —— 带登录令牌的完整访问链接，直接贴浏览器就能进
- `frpc.toml` —— 本次生成的 frpc 配置，停止时删除

`frpc` 的 stdout/stderr 会被接管、剔除令牌和密码后转进 DSH 日志。frpc 意外退出会以 5 秒间隔自动重启，最多 5 次；用尽后停下来等下一次设置变更，避免配置写错时空转。

## 配 frps 侧

frps 的 `frps.toml` 至少要这几项：

```toml
bindPort = 7000
auth.method = "token"
auth.token = "换成你的令牌"

webServer.port = 7500        # 可选，dashboard
allowPorts = [{ start = 6080, end = 6080 }]   # 不写则默认全放行
```

想让 `proxyType: http` 生效还得配 `vhostHTTPPort` / `vhostHTTPSPort` 和（可选）`subdomainHost`。**只开 TCP 时就用 `tcp` 模式**，前面再套一层 Nginx 做 HTTPS 终止。

## 给 HTTPS 加一层反向代理（可选）

如果域名已经解析到 frps 那台机器、由 Nginx 提供 443 和证书，就把该站点的 `proxy_pass` 指到 `remotePort`：

```nginx
location ^~ / {
    proxy_pass http://127.0.0.1:6080;   # = remotePort
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

`Upgrade`/`Connection` 和长超时是必须的：DSH 会话走 `/api/remote.mux` 的 WebSocket，缺了这几行界面能打开但一直不响应。

## 固定登录页 `/__frp/login`

- 设置了 `tunnelPassword` 后，`https://<域名>/__frp/login` 是一个固定入口：输入用户名和密码后，中继会种下 `frp_gate` Cookie（值为 `HMAC-SHA256(password, "frp-gate:"+user)`），然后跳到当次 DSH 的令牌链接。所以 DSH 重启、令牌变化都不影响这个入口。
- 登录失败有节流。登录成功后返回一个同源的"继续"页，由它用 `location.replace` 打开令牌链接。这样做是因为 App（`wails.localhost`）发起的跨站 POST 会丢掉 DSH 的 `SameSite=Strict` Cookie。

## 手机端适配（`mobileLayout`，默认开）

中继在 GET HTML 响应的 `</head>` 前注入 `/__frp/mobile.css` 和 `/__frp/mobile.js`。这两个文件不需要登录，缓存为 immutable。注入只影响经隧道访问的流量，本机 GUI 不受影响；而且只在窄屏（≤760px）或触屏小屏上生效。

- 侧栏和右栏改为抽屉加遮罩；头部不再被遮挡，标题区可以横向滚动，右侧按钮始终可见。
- 用 `pushState` 合成前进/后退：切换会话、打开抽屉或弹窗都会记一条历史，浏览器后退和安卓返回键都能逐级退回。
- 后退时 DSH 会自动聚焦输入框，导致键盘弹出。现在只有用户真正点了输入框才弹键盘。
- 手动开关：`localStorage.setItem('dsh-m','on'|'off')`，删掉这个键就恢复自动判断。
- 安卓 App 的返回键会先调用页面的 `window.__DSH_MOBILE_BACK__()`；它返回 false（已经到最开头）时，App 回到设置页。
- 安卓 15 强制全面屏：App 按系统栏和键盘的 insets 留出边距，状态栏和导航栏跟随页面背景色，图标颜色也会自动切换深浅。

## 安全

这条链路等价于**把能在本机执行任意命令的 GUI 暴露给公网**。插件只能保证令牌和 HTTP 可达性，挡不住暴力破解。生产使用请叠加：

- 非空的 `tunnelPassword`（第一道门）
- frps 的 `allowPorts` 只放行需要的那一个端口
- 云服务器安全组只对固定 IP 开放该端口
- 对外只暴露 443，`remotePort` 绑在 `127.0.0.1` 上不给外网
- 定期换令牌；`access-url.txt` 里的登录令牌每次 DSH 启动都会变，Cookie 有效期 30 天

## 测试

```bash
node test-relay.mjs   # 中继改写 / Basic / POST / upgrade，以及 frpc verify 校验生成的 TOML
```

## 实现备注

- 客户端配置页注册在 `plugins.row.config`，键是 `<包名>#<行 id>`，即 `@local/dsh-frp-tunnel#frp-tunnel`。没有这一半，插件行点开是空的。
- 客户端模块由 `dsh-client-modules` 在启动时按 `package.json` 的 `dsh.client` + `exports["./client"]` 组装，包清单改动需要重启 DSH 才生效（清单按 sourceKey 缓存，没有运行期失效路径）。
