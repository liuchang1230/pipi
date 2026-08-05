# pipi

与 pi agent 及其扩展完全兼容的桌面 AI 应用。

## 功能特性

- Electron + Vite + React 桌面应用
- 集成终端（xterm + node-pty）
- SSH / SFTP 远程会话支持
- Markdown 渲染与语法高亮
- 项目与会话管理
- 自定义终端主题

## 系统要求

- **Node.js** `^18.0.0 || >=20.0.0`（已验证 Node 22 LTS）
- npm 10+（或其他兼容 npm 的包管理器）
- 原生模块 `node-pty`：
  - **Windows x64 / macOS**：包内自带预编译二进制
    （`prebuilds/win32-x64`、`prebuilds/darwin-*`），一般无需编译工具链
  - **Linux**：无预编译二进制，需本地编译，需要 `python3`、`make`
    和 `g++`
  - 若找不到匹配的预编译版本，`node-pty` 会回退到本地
    `node-gyp rebuild`；此时 Windows 需要安装 **Visual Studio Build Tools**
    （勾选 "Desktop development with C++" 工作负载）

## 从源码运行

```bash
npm install
npm run dev
```

注意事项：

- `npm install` 会执行 `electron` 与 `node-pty` 的安装脚本，并从网络下载二进制。
- 如果 Electron 二进制下载缓慢或失败（例如在国内网络环境），可配置镜像：

  ```bash
  # Windows（PowerShell）
  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
  npm install

  # macOS / Linux
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
  ```

## 构建

```bash
npm run build
```

构建产物输出到 `out/` 目录，可用 `npm run preview` 预览。

> 注：可安装的发行包（NSIS 安装包 / 便携版）尚未提供——见下方路线图。

## 常见问题

- **`node-pty` 编译失败**
  - Linux（Debian/Ubuntu）：`sudo apt install python3 make g++`
  - Windows：安装 Visual Studio Build Tools
  - 强制本地重新编译：`npm rebuild node-pty --build-from-source`
- **Electron 下载缓慢或失败**：设置 `ELECTRON_MIRROR` 环境变量（见上文）

## 脚本

| 脚本 | 说明 |
| ---------------- | ------- |
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 构建生产版本 |
| `npm run preview` | 预览生产构建 |
| `npm run typecheck` | 类型检查全部源码 |

## 路线图

- 通过 `electron-builder` 产出可安装发行包（Windows NSIS 安装包 / 便携版），
  并处理 `node-pty` 在 Electron 下的 ABI 重编译
- 模型一键配置模板（DeepSeek / 硅基流动 / Kimi / 智谱 + 自定义
  OpenAI 兼容端点）
- 下载页面与发布产物
