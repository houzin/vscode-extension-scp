# VS Code SCP Extension

这是一个类似 WinSCP 的 VS Code 扩展，允许你在 VS Code 中直接管理远程服务器文件。

## 功能

- 连接到远程服务器
- 上传文件到远程服务器
- 从远程服务器下载文件

## 使用方法

1. 安装扩展后，在 VS Code 命令面板中（按 `Ctrl+Shift+P`）输入 "SCP" 可以看到以下命令：
   - `SCP: Connect to Server` - 连接到远程服务器
   - `SCP: Upload File` - 上传文件到服务器
   - `SCP: Download File` - 从服务器下载文件

2. 使用步骤：
   - 首先使用 "Connect to Server" 命令连接到服务器
   - 连接成功后，可以使用 "Upload File" 或 "Download File" 命令进行文件传输

## 要求

- VS Code 1.60.0 或更高版本
- Node.js 14.0.0 或更高版本

## 安装

1. 在 VS Code 中打开扩展面板
2. 搜索 "VS Code SCP"
3. 点击安装

## 开发

1. 克隆仓库
2. 运行 `npm install` 安装依赖
3. 运行 `npm run compile` 编译代码
4. 按 F5 启动调试

## 许可证

MIT 