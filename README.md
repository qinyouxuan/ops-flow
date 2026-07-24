# Ops Flow Plus

Ops Flow Plus 是一个面向服务器日常运维、部署与排障的桌面工具，将
SSH 终端、SFTP 文件管理、数据库、Redis、工作流、备份恢复和运行环境
管理集中在一个客户端中。

项目全部功能统一提供，并依据
[Mozilla Public License 2.0](./LICENSE) 开放源代码。

## 主要功能

- SSH 服务器连接管理、交互式终端和实时资源概览
- SFTP 文件浏览、搜索、上传、下载、编辑、重命名、备份和删除
- 最近路径、收藏路径以及带名称、标签和备注的常用命令
- MySQL、PostgreSQL、SQL Server、Oracle 和达梦数据库连接与 SQL 操作
- Redis 连接、数据库与键浏览以及常用维护操作
- 可视化工作流、批量服务器执行、角色范围、运行身份和失败回滚
- 安全审计、系统服务、定时任务、防火墙和监听端口检查
- Java、Node.js、Python、Go、.NET、Redis、MySQL、Nginx 等运行环境检测与部署
- 备份任务发现、备份产物校验及人工确认后的恢复操作
- 配置加密导出、解密预览和跨电脑导入
- 上传、下载、部署和 SQL 文件任务的统一进度与取消控制

## 技术栈

- Electron
- React + Vite
- React Flow
- xterm.js
- ssh2
- mysql2、pg、mssql、oracledb、dmdb
- redis
- electron-store

## 本地开发

建议使用当前 Node.js LTS 版本。在 Windows PowerShell 中，如果执行策略
阻止 `npm.ps1`，可以直接使用 `npm.cmd`：

```powershell
npm.cmd install
npm.cmd run dev
```

SSH、SFTP、数据库和 Redis 操作依赖 Electron preload bridge，因此不能把
普通浏览器中的 Vite 页面作为正式运行入口。

## 构建

生产构建：

```powershell
npm.cmd run build
```

生成 Windows 安装包和免安装 ZIP：

```powershell
npm.cmd run dist:win
```

仅生成免安装 ZIP：

```powershell
npm.cmd run dist:win:zip
```

构建产物默认输出到 `release/`。

## 配置与安全

- 连接密码和私钥优先使用 Electron `safeStorage` 结合当前系统用户保护。
- 原始本机配置不适合直接复制到另一台电脑；跨电脑迁移请使用软件内的
  “导出加密配置”和“解密并导入”。
- 加密备份密码不会随备份文件一起保存，请通过独立安全渠道传递。
- 工作流、部署、删除、恢复、防火墙和服务操作可能改变远程服务器状态，
  执行前应确认服务器、路径、账号、命令和回滚方案。
- 请勿把真实服务器密码、私钥、数据库密码或导出的配置备份提交到仓库。

## 版本与源码

公开仓库：

https://github.com/qinyouxuan/ops-flow

正式发布时，安装包、免安装包、SHA-256 校验文件和对应版本源码应放在同一个
GitHub Release 中，并使用相同版本标签。安装包内同时携带 `LICENSE` 和
`SOURCE_CODE.md`，用于说明许可证及源码获取方式。

版本变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 反馈

问题反馈和功能建议请使用
[GitHub Issues](https://github.com/qinyouxuan/ops-flow/issues)。

维护者：秦屿

联系邮箱：1829941918@qq.com

## 许可证

本项目的自有源代码依据
[Mozilla Public License 2.0](./LICENSE) 发布。第三方依赖仍分别遵循其各自
的许可证。

分发安装包或其他可执行版本时，需要同时向接收者说明如何及时获得该版本
对应的源代码。具体说明见 [SOURCE_CODE.md](./SOURCE_CODE.md)。
