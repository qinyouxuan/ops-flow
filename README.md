# Ops Flow Plus

Ops Flow Plus 是一个面向服务器日常运维、部署与排障的桌面工具，将
SSH 终端、SFTP 文件管理、数据库、Redis、工作流、备份恢复和运行环境
管理集中在一个客户端中。

项目全部功能统一提供，并依据
[Mozilla Public License 2.0](./LICENSE) 开放源代码。

## 支持范围

- 桌面客户端目前支持 Windows x64。
- SSH、SFTP、命令、工作流、安装部署、系统服务、运行环境检测、备份恢复和
  主机管理以远程 Linux 服务器为主要目标。
- 数据库和 Redis 连接作为独立的全局资源保存，不随左侧当前服务器切换；可从
  Windows 本机直接连接，也可固定选择一台已保存的 Linux SSH 服务器作为跳板，
  无需先连接命令终端。
- Windows Server 可以在配置 OpenSSH 后尝试基础终端和文件操作，但远程部署、
  Windows 服务、计划任务、防火墙和运行环境管理尚未完整支持。

## 主要功能

- SSH 服务器连接管理、交互式终端和实时资源概览
- SFTP 文件浏览、搜索、上传、下载、编辑、重命名、备份和删除
- 最近路径、收藏路径以及带名称、标签和备注的常用命令
- MySQL、PostgreSQL、SQL Server、Oracle，以及可选的达梦数据库连接与 SQL 操作
- 内置数据库逻辑备份，可将字段结构、主键、二级索引、外键、检查/唯一约束、
  视图、触发器、存储程序和数据导出为 SQL 或 GZIP 压缩 SQL，无需安装数据库命令行客户端
- SQL 与 GZIP 脚本导入；超过 10 MB 的文件由主进程流式扫描和执行，不受编辑器大小限制
- Redis 连接、数据库与键浏览、常用维护操作，以及无需 `redis-cli` 的 `.opsredis`
  逻辑库备份与恢复
- 可视化工作流、批量服务器执行、角色范围、运行身份和失败回滚
- 安全审计、系统服务、定时任务、防火墙和监听端口检查
- Java、Node.js、Python、Go、.NET、Redis、MySQL、Nginx 等运行环境检测与部署
- 备份任务发现、备份产物校验及人工确认后的恢复操作
- 配置加密导出、解密预览和跨电脑导入
- 上传、下载、部署和 SQL 文件任务的统一进度与取消控制

## 数据备份与恢复

- 数据库逻辑备份支持 MySQL/MariaDB、PostgreSQL、SQL Server、Oracle 和达梦。结构备份会按
  各引擎的系统目录或元数据接口读取表、主键、二级索引、外键、检查/唯一约束、视图、
  触发器，以及存储过程、函数或包；MySQL/MariaDB 的索引和约束由 `SHOW CREATE TABLE`
  一并保留。
- 生成的恢复脚本按表结构、表数据、约束与索引、存储程序、视图、触发器排列。建议恢复到
  相同数据库引擎和兼容版本的空数据库或空模式，并保证连接账号有读取元数据及创建对象的权限。
- `.sql` 与 `.sql.gz` 都可以通过“执行脚本”导入。解压后不超过 10 MB 的脚本会加载到编辑器；
  更大的脚本由主进程流式解析和执行，不会一次性载入内存，也没有 10 MB 导入上限；同目录
  存在对应 `.sha256` 文件时会在执行前校验，没有校验文件的第三方导出脚本也可以正常执行。
- Redis 备份使用 `.opsredis` 流式文件保存每个键的 `DUMP` 内容和过期时间，并生成
  `.sha256`。恢复时会检查文件结构和可用的 SHA-256，可选择跳过已有键、覆盖已有键或遇到
  冲突停止。恢复取消不会自动删除已经写入的键。

## 技术栈

- Electron
- React + Vite
- React Flow
- xterm.js
- ssh2
- mysql2、pg、mssql、oracledb；达梦通过用户自行安装的外部 `dmdb` 驱动接入
- redis
- electron-store

## 本地开发

需要 Node.js `22.12.0` 或更高版本，建议使用当前 Node.js LTS。在 Windows
PowerShell 中，如果执行策略
阻止 `npm.ps1`，可以直接使用 `npm.cmd`：

```powershell
npm.cmd install
npm.cmd run audit:prod
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

正式签名与发布流程见
[Windows 数字签名](./docs/windows-code-signing.md)和
[发行检查清单](./docs/release-checklist.md)。

## 配置与安全

- 连接密码和私钥优先使用 Electron `safeStorage` 结合当前系统用户保护。
- 服务器、数据库、Redis、工作流、命令和历史记录保存在 Electron 用户数据
  目录中，不属于源码，也不会自动打进安装包。
- 原始本机配置不适合直接复制到另一台电脑；跨电脑迁移请使用软件内的
  “导出加密配置”和“解密并导入”。
- 加密备份密码不会随备份文件一起保存，请通过独立安全渠道传递。
- 工作流、部署、删除、恢复、防火墙和服务操作可能改变远程服务器状态，
  执行前应确认服务器、路径、账号、命令和回滚方案。
- 请勿把真实服务器密码、私钥、数据库密码或导出的配置备份提交到仓库。
- 数据库 SQL 与 `.opsredis` 逻辑备份包含业务数据且默认不加密，请保存到受控目录，
  不要提交到仓库。

## 文档截图与隐私

公开截图只能使用专门准备的演示环境和虚构数据。提交前必须确认画面中没有
真实服务器地址、端口组合、主机名、SSH 用户、登录横幅、目录、服务名、
数据库名、表数据、Redis 键值、日志、备份文件名、Windows 用户名或本机路径。
推荐的截图范围和示例数据见
[截图隐私检查清单](./docs/screenshots/README.md)。

项目当前不提交任何真实连接测试结果、运行时基本信息或本机配置文件。

达梦 `dmdb` 驱动受厂商许可证约束，不包含在公开依赖锁和公开安装包中。
需要使用达梦时，请先阅读
[达梦 Node.js 接口文档](https://eco.dameng.com/document/dm/zh-cn/app-dev/JavaScript_NodeJs)
以及所安装版本随附的 `LICENSE`，在独立目录自行安装并接受厂商许可证，例如：

```powershell
mkdir C:\OpsFlowDrivers
cd C:\OpsFlowDrivers
npm.cmd init -y
npm.cmd install dmdb
```

然后在“设置 → 常规 → 达梦数据库”中选择
`C:\OpsFlowDrivers\node_modules\dmdb`。Ops Flow 只保存本机路径并从原目录加载，
不会复制驱动，也不会把驱动路径或文件放入配置备份。

如果旧版达梦服务端只能协商现代 Electron 运行时不再提供的算法（例如连接报
`Unknown cipher`），可在同一设置区域开启“兼容旧版达梦”。该模式
使用本机 Node.js 运行时启动独立子进程。程序会先检测运行时是否已支持所需
算法，只在新版 Node.js 确有需要时为该子进程启用 OpenSSL legacy provider；
达梦驱动和本次连接凭据只存在于该子进程内，
数据库操作结束后进程即退出。Ops Flow 主进程的配置加密及其他数据库连接不受
影响。程序会自动探测 Node.js，也允许手工选择 `node.exe`。兼容开关与运行时
路径同样仅保存在本机，不随配置导出。

兼容模式只应用于无法及时升级的旧服务端，会允许达梦会话使用较弱的旧算法；
可以升级数据库服务端时，应关闭兼容模式并改用服务端支持的现代 AES 算法。
不要通过关闭 `loginEncrypt` 绕过登录保护。

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

安全问题请按照 [SECURITY.md](./SECURITY.md) 私下报告；参与开发前请阅读
[CONTRIBUTING.md](./CONTRIBUTING.md)。

维护者：秦屿

联系邮箱：734052482@qq.com

## 许可证

本项目的自有源代码依据
[Mozilla Public License 2.0](./LICENSE) 发布。第三方依赖仍分别遵循其各自
的许可证，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

分发安装包或其他可执行版本时，需要同时向接收者说明如何及时获得该版本
对应的源代码。具体说明见 [SOURCE_CODE.md](./SOURCE_CODE.md)。
