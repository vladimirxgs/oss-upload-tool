# OSS 上传工具

跨平台图形化的阿里云 OSS 上传工具，把命令行工具 `ossutil` 封装成只有三个按钮的极简界面：

- **上传** — 先选数据类型（normal / calibration / mechmind / K1）与日期，再选本地文件/目录（也可拖入窗口），上传到对应目录
- **查看** — 列出 `hw-upload` 桶内已有文件（文件名 / 大小 / 修改时间）
- **配置** — 设置 endpoint / AccessKey（右下角小按钮）

### 上传路径映射（桶固定为 `hw-upload`）

| 数据类型 | 目标目录 |
|---|---|
| normal | `oss://hw-upload/raw_data/raw_data_{date}/normal/` |
| calibration | `oss://hw-upload/raw_data/raw_data_{date}/calibration/` |
| mechmind | `oss://hw-upload/raw_data/raw_data_{date}/s1/` |
| K1 | `oss://hw-upload/raw_data/raw_data_{date}/s2/` |

技术栈：Electron + 原生 HTML/CSS/JS，`ossutil` 二进制随应用分发，运行时按平台/架构自动选择。

## 目录结构

```
core/                     # ossutil 各平台 zip（来源）
resources/ossutil/        # 解压后的二进制（npm install 自动生成）
src/main/                 # Electron 主进程：窗口、IPC、ossutil 调用
src/preload/              # contextBridge 暴露最小 API
src/renderer/             # 界面（三个按钮）
scripts/prepare-ossutil.js
```

## 开发运行

```bash
npm install     # 安装依赖 + 自动解压 ossutil 二进制
npm start       # 启动应用
```

## 打包

```bash
npm run dist          # 打包当前平台
npm run dist:mac      # macOS (dmg + zip)
npm run dist:win      # Windows (nsis)
npm run dist:linux    # Linux (AppImage)
```

产物在 `dist/` 目录。完整的三平台安装包建议用 CI（GitHub Actions）在各自平台构建，或本机分别执行对应命令。

## 平台 / 架构映射

| 运行平台 | ossutil 二进制 |
|---|---|
| macOS x64 | `mac-amd64/ossutil` |
| macOS arm64 | `mac-arm64/ossutil`（缺失时回退 amd64，需 Rosetta 2） |
| Windows x64 | `windows-amd64/ossutil.exe` |
| Linux x64 | `linux-amd64/ossutil` |
| Linux arm64 | `linux-arm64/ossutil` |

> **注意**：当前 `core/` 未提供 `ossutil-v1.7.19-mac-arm64.zip`。Apple Silicon 上若未安装 Rosetta 2，需要补上该 zip 后才能完成实际上传（列表/配置不受影响）。可从阿里云官方 CDN 下载：`https://gosspublic.alicdn.com/ossutil/1.7.19/ossutil-v1.7.19-mac-arm64.zip`，放到 `core/` 后重新 `npm run prepare`。

## 其他说明

- 配置（含 AccessKeySecret）以明文保存在本机 `userData/config.json`，请勿在他人可读的机器上使用高权限密钥。
- 输入 ak/sk/endpoint 后，会按当前运行平台写入 ossutil 标准配置文件 `~/.ossutilconfig`（mac/linux 为 `$HOME/.ossutilconfig`，Windows 为 `%USERPROFILE%\.ossutilconfig`），每次调用通过 `--config-file` 指定该文件。
- Windows 下系统文件对话框不支持同时选择文件与目录，目录上传请直接**拖入窗口**（各平台拖拽均支持文件与目录）。
