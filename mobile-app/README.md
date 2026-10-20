# DSH Remote（安卓客户端）

一个 Wails v3 小应用：填写 frp 隧道的公网地址（如 `https://dsh.example.com`），以及插件 `tunnelUser` / `tunnelPassword` 配置的账号密码，就能在手机上打开电脑端的 DSH。

- 通过 `/__frp/login` 登录，自动跳转到当次 DSH 的令牌链接；电脑端 DSH 重启后不用重新配置。
- 账号保存在应用私有目录，可设置启动时自动连接。
- 适配安卓 15 全面屏：按系统栏和键盘留出边距，系统栏颜色跟随页面。
- 返回键先交给页面的 `window.__DSH_MOBILE_BACK__()`（由插件注入的手机层提供），退到最开头时回到设置页。
- 网络断开时自动回到设置页并给出提示。

## 构建

需要 Go 1.26+、wails3 v3.0.0-beta.33、JDK 21、Android SDK 35 + NDK 26.3。

```bash
./build-apk.sh          # 输出 bin/dsh-remote.apk（arm64）
ARCH=x86_64 ./build-apk.sh   # 模拟器用
```

签名使用 `~/.android-keys/dsh-remote.env`，需要导出 Wails 安卓任务读取的签名变量。缺少这个文件时打 debug 签名包。**不要把 keystore 或 env 提交进仓库**。

`build-apk.sh` 里的工具链路径是按 mise 安装位置写的，请按自己的环境修改。
