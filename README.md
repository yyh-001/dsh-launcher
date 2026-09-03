# DSH

轻量 DeepSeek Harness 管理器：选一个版本，启动 `dsh web`。所有版本共用同一个 **web** profile（一份 `DSH_HOME`），换版本不会重装插件。首次会给这个 profile 装上 `dshmarket`。

不用 Electron / Tauri / npm CLI。界面走系统浏览器。

## 开发

需要本机 Node.js 22.18+（官方 DSH 要求 `^22.19.0 || >=24`）。

```sh
npm install
npm start
```

会打开管理页并挂到托盘。关掉网页不会退出，托盘里点「退出」。

只起网页：

```sh
npm run server
```

打开 `http://127.0.0.1:3780`。

## 打包 exe

需要 Rust（`cargo`）和本机 Inno Setup 6（没有的话打包脚本会尝试下载）。会下网拉取便携 Node。

```sh
npm run dist
```

产物：

- `release/DSH/`：便携目录，双击 `DSH.exe`
- `release/DSH-Setup.exe`：安装包（默认装到 `%LOCALAPPDATA%\Programs\DSH`，创建桌面「DSH启动器」）

只带便携 `node.exe`，不带 npm；装 DSH 走 registry 直下 tarball。

## 行为

- 二进制按版本隔离；`DSH_HOME` 共用，profile 固定为 `web`
- 第一次启动时若没有 `dshmarket`，执行 `dsh plugin --profile web add dshmarket`
- 同一时间只跑一个版本
