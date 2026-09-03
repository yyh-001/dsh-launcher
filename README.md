<p align="center">
  <img src="docs/hero.png" alt="DSH启动器" width="880" />
</p>

<h1 align="center">DSH启动器</h1>

<p align="center">选一个版本，启动 dsh web</p>

轻量 DeepSeek Harness 管理器。版本按目录隔离，web profile 共用一份 `DSH_HOME`，换版本不用重装插件。托盘常驻，界面走系统浏览器。

<p align="center">
  <img src="docs/screenshot-home.png" alt="控制" width="720" />
</p>

<p align="center">
  <img src="docs/screenshot-settings.png" alt="设置" width="720" />
</p>

## 使用

Windows 安装 `DSH-Setup.exe` 后，桌面打开 **DSH启动器**。管理页：`http://127.0.0.1:3780/`。

- 选版本 → 启动 / 停止 / 更新 / 卸载
- 更新会装最新版并移除当前旧版
- 同一时间只跑一个版本；首次启动可预装 `dshmarket`

## 开发

需要本机 Node.js 22.18+（官方 DSH：`^22.19.0 || >=24`）。

```sh
npm install
npm start
```

托盘常驻。只起网页：`npm run server`。

## 打包

需要 Rust 与 Inno Setup 6（没有会尝试下载）。便携 Node 从镜像拉取。

```sh
npm run dist
```

- `release/DSH/`：便携目录
- `release/DSH-Setup.exe`：安装包（默认 `%LOCALAPPDATA%\Programs\DSH`）

安装包带 `node.exe` 与 npm 10。装 DSH 走 `npm install`，仓库默认 [npmmirror](https://registry.npmmirror.com)。
