# DSH

轻量 DeepSeek Harness 管理器：按官方 [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/deepseek-harness) 隔离安装版本，内置 [dsh-market](https://github.com/dsh-market/dsh-market) 插件市场，托盘常驻，Windows 一键启动。

不用 Electron / Tauri。界面走系统浏览器，后台只跑一个 Node 进程。

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

需要 Rust（`cargo`）和下网下载便携 Node。

```sh
npm run dist
```

产物在 `release/DSH/`：双击 `DSH.exe` 即可。便携 Node 和 npm 打在包里，系统不用先装 Node。

## 行为

- 安装某个 DSH 版本后会对该版本的 `web` profile 执行 `dsh plugin --profile web add dshmarket`
- 插件目录来自 [awesome-dsh-plugin](https://awesome-dsh-plugin.com/plugins.json)
- 每个版本使用独立 `DSH_HOME`，互不覆盖
