# 蛇域争霸 · Snake Arena

5 人实时贪吃蛇竞技场：**4200×3000 大地图、互相吞噬、一次复活、5 种道具**。
同一 Wi-Fi 直接加入；外网朋友也能通过房主在大厅里一键生成的临时公网链接加入。
浏览器、Windows 原生窗口和 Android App 三端同服。

![桌面竞技场](docs/preview-game.png)

![手机端](docs/preview-mobile.png)

> **这是源码仓库**：不提交 `dist/` 编译产物、Node 二进制、Android SDK/JDK 和签名密钥。
> 需要现成安装包时，请从 GitHub Releases 下载，或按下方「构建」自行生成。
> 截图中的 `192.168.x.x` 和 `*.lhr.life` 都是测试示例地址。

## 特性

- **5 人同房**：满 5 人后拒绝新连接，房主退出自动转移。
- **互相吞噬**：头对头时体型大 15% 以上直接吃掉对方；头撞身体则撞的人死。
- **1 次复活**：首次死亡 3 秒后带护盾复活，第二次淘汰观战；复活币可再加一次。
- **中途加入**：对局开始后加入也会立即在安全位置生成（1 条命 + 2.6 秒出生护盾），
  出生方向朝地图中心，不再等到下一轮。
- **5 种道具**：护盾、疾风、磁铁、双倍、复活币，最多同时 4 个，约 9 秒刷新。
- **大地图**：4200×3000，4 分钟一局；死亡爆出能量豆，击杀获得质量。
- **三端**：Canvas 浏览器客户端、Windows WebView2 原生窗口、Android WebView App。
- **单人无尽**：连接页即可开始，不需要服务器；吃豆成长，撞墙或咬到自己结束，
  最高分保存在本机。浏览器 / Windows / Android 都可离线玩。
- **外网联机**：房主一键生成 `https://*.lhr.life`，不需要路由器端口映射。
- **零运行时 npm 依赖**：服务端是 Node 原生 HTTP + 自实现 WebSocket。

![单人无尽](docs/preview-solo.png)

## 快速开始（局域网）

需要 Node.js 18+（开发时使用 Node 24），没有 npm 依赖。

```bash
node server.js
# 浏览器打开 http://127.0.0.1:3000
```

- 默认端口 3000；被占用时自动尝试 3001–3011，以终端输出为准。
- 同一 Wi-Fi 的手机或电脑浏览器打开 `http://<房主IP>:<端口>` 即可。
- Windows 桌面版会自动开服，并显示局域网地址。

### 外网联机

1. 房主进入大厅，在「外网联机」区域点 **生成公网地址**。
2. 等待 5–15 秒，复制出现的 `https://xxxx.lhr.life`。
3. 外网朋友用浏览器打开该链接，或在手机 App 的「服务器地址 / 公网链接」里粘贴。
4. 最多仍然 5 人；房主点开始游戏。

![外网联机](docs/preview-wan.png)

实现方式是房主本机通过 SSH 连接 [localhost.run](https://localhost.run/) 的免费隧道：

- **不需要端口映射**，NAT / CGNAT 后面也能用；
- 需要房主电脑能**出站 SSH（默认 22 端口）**并安装 OpenSSH 客户端；
- 页面走 HTTPS，WebSocket 走 WSS；
- 链接是**临时且公开**的，任何拿到链接的人都能加入；不用时请点「关闭隧道」；
- 免费服务可能限速或断开，延迟取决于线路，适合朋友娱乐，不适合高强度竞技。

## 操作

| 平台 | 转向 | 加速 |
| --- | --- | --- |
| 桌面浏览器 / Windows | 鼠标指向 | 按住鼠标左键 / 空格 |
| 手机 App / 手机浏览器 | 拖动屏幕（虚拟摇杆） | 右下角「加速」按钮 |

> 手机端要按住屏幕拖动一段距离才会转向；只点一下不会改变方向。
> 公网隧道延迟可能到 0.5 秒以上，转向会明显滞后；想跟手请用同一 Wi-Fi / 手机热点。

单人无尽与多人共用同一套鼠标 / 触摸 / 加速输入；单人模式没有倒计时、复活和对手，
撞墙或咬到自己结束，按本机最高分记录。

## 项目结构

```text
.
├─ server.js              HTTP 静态服务 + 原生 WebSocket + 连接管理
├─ game.js                权威游戏逻辑（移动 / 碰撞 / 吞噬 / 复活 / 道具 / 回合）
├─ tunnel.js              外网联机：本机 SSH → localhost.run
├─ public/                浏览器 / 手机 / Windows 共用的网页客户端
├─ desktop/               Windows 启动器（WinForms + WebView2）
│  ├─ launcher.cs
│  ├─ build-windows.ps1
│  ├─ webview2/           WebView2 SDK DLL（构建所需）
│  └─ README-Windows.txt
├─ mobile/                Android WebView 外壳与 APK 构建脚本
├─ tests/                 Node 测试与无头 Edge E2E
├─ docs/                  预览截图
└─ legacy/snake.html      初代单文件经典贪吃蛇（独立，可直接打开）
```

## 构建

构建产物输出到 `dist/`，该目录已被 `.gitignore` 忽略；发布时把生成的两个包
作为 GitHub Release 附件，而不是提交进仓库。

### Windows 便携版

要求：Windows 10/11、Node.js 18+、.NET Framework 4.8（自带 `csc.exe`）、Python 3。
`desktop/webview2/` 已包含构建所需的 WebView2 SDK DLL。

```powershell
npm run build:windows
# 输出 dist/SnakeArena-Windows.zip
```

生成的是未签名程序，SmartScreen 可能提示；选择「更多信息 → 仍要运行」。
压缩包内含 `node.exe`，最终用户不需要安装 Node。

### Android APK

要求：JDK 17、Android SDK（`platforms;android-35` + `build-tools;35.0.0`）、Python 3。
PowerShell 构建脚本会自动使用 `JAVA_HOME` 和 `ANDROID_HOME`（或 `ANDROID_SDK_ROOT`）：

```powershell
$env:JAVA_HOME = "C:\Program Files\Java\jdk-17"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
npm run build:apk
# 输出 dist/SnakeArena.apk
```

如果本机是仓库内 `tools/jdk`、`tools/android-sdk` 的本地布局，脚本也会自动回退到那里
（`tools/` 不提交 Git）。首次构建会自动生成演示签名密钥 `mobile/snake-arena.keystore`
（已忽略）；正式发布请替换为你自己的 keystore，否则无法覆盖安装其他签名的版本。

## 测试

```bash
npm test
# 15 个游戏逻辑测试 + 4 个服务器集成测试
```

可选的无头 Edge E2E（Windows，需安装 Edge）：

```powershell
$env:EDGE_PATH = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
npm run solo-check    # 单人无尽：手机尺寸、触摸转向、死亡结算、重开、退出
npm run touch-check   # 多人手机端触摸转向 + 空格加速回归
npm run ui-check      # 4 人开局、死亡、复活、道具、手机 HUD、结算
npm run file-check    # file:// 模拟 APK 连接局域网服务器
npm run tunnel-check  # 真实公网隧道 API / HTTP / WSS / Host 限制
npm run wan-check     # 房主公网隧道 + 公网浏览器 + file:// 手机 3 人开局
```

`tunnel-check` / `wan-check` 会创建真实的临时公网隧道，需要网络、OpenSSH 和 Edge。

## 边界与安全

- 仅支持局域网直连和 localhost.run 免费公网隧道；没有账号、房间密码、聊天或公网匹配大厅。
- 公网链接是公开的，任何人拿到都能加入（最多 5 人）；房主关闭窗口 / 隧道即失效。
- 局域网传输为明文 `ws://`；公网隧道走 `wss://`。不要把本地 HTTP 端口直接暴露到公网。
- 源码仓库不包含签名密钥；`mobile/build-apk.ps1` 会生成本地演示密钥。
- 开发环境没有安卓真机 / 模拟器，APK 构建、签名和 `file://` 客户端流程已验证；
  正式发布前建议在真机上再测一次。
- 免费隧道可能限速、断开或调整服务；外网联机失败时局域网仍然可用。

## 初代单机版

`legacy/snake.html` 是最早的单文件经典贪吃蛇（24×24 网格、最高分、手机适配），
浏览器直接打开即可，和多人版完全独立。

## License

MIT。第三方组件说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
