# KTV 点歌台 / KTV Queue

大家用自己的手机点歌，主持人的电脑负责播放。整个系统只跑在主持人的电脑上，不需要账号，也不依赖国外服务。
Everyone requests songs from their own phone; the host's computer plays them. It runs entirely on the host's laptop: no accounts, no foreign services.

## 开始 / Start

1. **只需一次**：安装 Node.js（LTS 版本，18 或更新）：https://nodejs.cn （中文站）或 https://nodejs.org
   **Once:** install Node.js (LTS, version 18 or newer).
2. 双击 `start-windows.bat`（Windows）或 `start-mac.command`（Mac）。
   Double-click the start file. (Or in a terminal: `node server.js`.)
   - Windows 弹出防火墙提示时，选择“专用网络”并允许。/ If Windows asks about the firewall, allow it on Private networks.
   - Mac 第一次可能需要：右键 → 打开。/ On Mac the first time: right-click → Open.
3. 在这台电脑的浏览器打开 http://localhost:3000 。
   Open http://localhost:3000 in this computer's browser.
4. 点“今晚当主持人？”，设置主持人密码，点“创建房间”。
   Tap "Hosting tonight?", choose a host PIN, tap "Create a room".
5. 点“用这个屏幕播放”，再点“开始播放”。把电脑接到电视（HDMI 或投屏）。
   Tap "Play on this screen", then "Start party". Connect the laptop to the TV.
6. 朋友们用**微信扫屏幕左上角的二维码**，输入名字就能加入。手机必须和电脑连**同一个 WiFi**。
   Friends scan the QR code in the top-left of the screen with WeChat and enter their name. Phones must be on the **same WiFi** as the laptop.

## 使用说明 / How it works

- **点歌**：粘贴带歌词的 KTV 视频链接，歌名会自动填好（B站）。
- **扫码加入**：二维码和“扫码加入”提示在播放屏幕的左上角，房间号在它下面；放大时，只要视频旁边放得下，二维码也会留在左上角。
- **放大 / 缩小**：在播放屏幕上点“放大”，视频会铺满整个显示器（浏览器也会进入全屏）；点“缩小”或按 Esc 回到原来的大小。播放屏幕上不显示“点歌”表单，主持人在手机上管理队列即可。
- **投票**：大家都能给歌投票，看不到是谁点的。主持人能看到点歌人，可以拖动排序，或点“按票数排序”。
- **B站**：在页面内播放，按视频时长自动切歌。如果歌没有立刻开始播放，等它开始后点“重新计时”；也可以“关闭自动切歌”，改点“下一首”。
- **其他网站**（腾讯视频、爱奇艺、抖音、网易云等）：不能在页面内播放，会给出“打开链接”按钮，唱完点“跳到下一首”。
- YouTube 也支持，但需要这台电脑能访问 YouTube。
- 房间数据保存在 `data.json`，重启不会丢；3 天没人用的房间会被清理。

## 常见问题 / Troubleshooting

- **手机打不开 / Phones can't open it**：确认和电脑在同一个 WiFi。部分场所的 WiFi 会隔离设备（手机互相、手机与电脑之间不能通信）；这时可以改用随身路由器，或手机热点。注意：视频会通过电脑的网络播放，用热点会消耗流量。
- **电脑有多个网络地址**：点房间号，在邀请窗口里换一个地址试试。
- **微信里打不开或有提示**：点右上角“···”，选择“在默认浏览器打开”。
- **电脑休眠会中断点歌**：请在系统设置里关闭休眠。不要关闭黑色的命令窗口；按 Ctrl+C 停止。
- 局域网内的任何人都能打开这个页面；主持人功能由主持人密码保护。没有加密（http），请勿用于敏感用途。
