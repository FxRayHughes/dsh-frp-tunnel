# DSH Remote（安卓客户端）

一个 Wails v3 小应用：填写 frp 隧道的公网地址（如 `https://dsh.example.com`），以及插件 `tunnelUser` / `tunnelPassword` 配置的账号密码，就能在手机上打开电脑端的 DSH。

- 通过 `/__frp/login` 登录，自动跳转到当次 DSH 的令牌链接；电脑端 DSH 重启后不用重新配置。
- 账号保存在应用私有目录，可设置启动时自动连接。
- 适配安卓 15 全面屏：按系统栏和键盘留出边距，系统栏颜色跟随页面。
- 返回键先交给页面的 `window.__DSH_MOBILE_BACK__()`（由插件注入的手机层提供），退到最开头时回到设置页。
- 网络断开时自动回到设置页并给出提示。
- **P2P 优先**（默认开启，设置页可关）：见下文。
- **下载**：页面里的「下载」「下载文件夹（zip）」等保存到手机的 `下载/DSH Remote/`（安卓 10 起经 MediaStore，无需存储权限；更早的系统存在应用专属下载目录），完成后弹提示。

## 连接顺序：P2P → 服务器中转 → 公网地址

1. 用账号密码向公网地址的 `/__frp/p2p` 要 P2P 参数（frps 地址与 token、电脑端的 xtcp/stcp 代理名、访问密钥）。这个接口在入口密码之后，没登录拿不到。
2. App 内嵌 frp 0.71.1 客户端，在手机的 `127.0.0.1:<随机端口>` 开一个 xtcp 访问端口：先 UDP 打洞直连电脑；1.5 秒内没打通的连接交给 stcp，经 frps 中转。打洞在后台继续重试，打通后新连接自动走 P2P。
3. 访问端口能连通电脑端的入口页后，WebView 从 `http://127.0.0.1:<端口>/__frp/login` 登录进入 DSH。连接页会提示当前是「P2P 直连」还是「服务器中转」。
4. 电脑端没开 P2P（插件旧版本、关了「手机 App P2P 直连」或没设入口密码）或 frps 连不上时，直接用公网地址，跟以前一样。

打洞前 App 会按 frp 的方式探测 `stun.miwifi.com`、`stun.easyvoip.com`、`stun.nextcloud.com:443`，把第一个完整响应的 IP:端口交给 frp（frp 默认的 easyvoip 有一半地址已失效，会让打洞约一半失败）。

只对回环地址放开明文 HTTP（`res/xml/network_security_config.xml`），其余地址仍只允许 HTTPS。访问端口只监听手机本机回环，经 frp 的流量用访问密钥加密。

电脑端要求：dsh-frp-tunnel 的「手机 App P2P 直连」开启（默认开）且设置了入口密码，它会额外登记 `<proxyName>-p2p`（xtcp）和 `<proxyName>-p2p-s`（stcp）两个代理。双方都是对称型 NAT 时打不通，会一直走中转。

## 构建

需要 Go 1.26+、wails3 v3.0.0-beta.33、JDK 21、Android SDK 35 + NDK 26.3。

```bash
./build-apk.sh          # 输出 bin/dsh-remote.apk（arm64）
ARCH=x86_64 ./build-apk.sh   # 模拟器用
```

签名使用 `~/.android-keys/dsh-remote.env`，需要导出 Wails 安卓任务读取的签名变量。缺少这个文件时打 debug 签名包。**不要把 keystore 或 env 提交进仓库**。

`build-apk.sh` 里的工具链路径是按 mise 安装位置写的，请按自己的环境修改。
