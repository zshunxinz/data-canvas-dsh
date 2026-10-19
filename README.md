# data-canvas-dsh

> 在 DeepSeek Harness 里把数据变成**可复用的分析卡片**：导入文件或连接数据库（只读），查询、看结果、落卡、在对话里引用、追溯每个数字的来源。

这是一个 DSH 插件（Cordis bundle）：宿主侧提供数据与路由，浏览器侧渲染「数据源与分析」「分析画布」两个工作区。

## 功能

- **数据源**
  - 文件：CSV / TSV / XLSX / Parquet（快照导入，带解析提示与重试）
  - 数据库：MySQL / PostgreSQL（只读连接，AES-256-GCM 本地凭据，密码不进模型/备份/日志）
  - 表结构：字段浏览、字段搜索、CREATE TABLE 语法查看、按字段名找表
  - 查询：只读 SQL（单条、自动 LIMIT、15s 超时、可取消），常用 SQL / 最近执行
- **结果**
  - 表格：排序、列显隐、列宽拖拽、冻结首列、全屏、表内搜索、复制、导出 CSV、字段画像
  - 结果可「添加到画布」「在对话中使用」，形成卡片与引用
- **分析画布**
  - 网格布局、拖拽/缩放、对齐、撤销重做、卡片数据版本与溯源、复算
- **协作与数据**
  - 引用协议 `xcharts:ds/...`、`xcharts:res/...`、`xcharts:card/...`，AI 先解析引用再回答
  - 使用情况、备份/恢复、存储占用与清理、插件内更新记录

## 安装

前置：DeepSeek Harness（桌面或 `dsh web`），Node.js 22+。

1. 通过 DSH 的插件管理器安装本包（发布到 npm 后）；
2. 或本地开发：把本目录放入 profile 的 `node_modules/`，在 profile 的 `package.json` 里声明：

   ```json
   { "dependencies": { "data-canvas-dsh": "link:/path/to/data-canvas-dsh" } }
   ```

   并在 `dsh.profile.bundles` 中加入 `data-canvas-dsh`。

3. 重启 DSH（宿主侧路由/工具在启动时加载）；浏览器侧刷新即可。

## 快速开始

1. 打开侧边栏「数据源」，点击「新增数据源」：
   - 拖入一个 CSV/XLSX，或
   - 选择「数据库」，填写 MySQL/PostgreSQL 连接（建议使用**只读账号**），点「测试连接」。
2. 在左侧选择数据源，写 SQL 或使用结构化查询，点「执行」（Ctrl/Cmd+Enter）。
3. 结果出现后：
   - 「添加到画布」生成卡片；
   - 「在对话中使用」把结果引用发给 Agent；
   - 表格右上角可全屏、搜索、复制、导出 CSV、查看字段画像。
4. 在「分析画布」里拖拽卡片布局；卡片菜单可查看溯源与版本。

## 安全与隐私

- **只读**：数据库连接强制只读事务，SQL 守卫拒绝写/DDL/多语句；不提供数据编辑。
- **凭据**：AES-256-GCM 存储在本地 `secrets/`，主密钥为 `secrets.key`（或环境变量 `XCHARTS_SECRET_KEY`）；密码不出现在数据源 JSON、列表、工具输出、日志、备份与 AI 上下文中。
- **主机打码**：工具与溯源输出中的主机显示为 `10.0.*.*` 形式。
- **数据不出本机**：插件不向外部服务上传数据；AI 仅通过 DSH 会话看到你主动引用的内容。

## 兼容性

- DSH：开发与验证于 `0.2.0-rc.2` 系列；宿主 API 版本见插件 `capabilities`。
- Node.js：22+。
- 数据库：MySQL 5.7+ / PostgreSQL 12+；驱动为 `pg`、`mysql2`，Parquet 依赖 `hyparquet`。
- 文件：CSV/TSV/XLSX/Parquet；单文件行数上限 50,000。

## 开发

```bash
pnpm install
pnpm build:client     # 拼接 client-src 为 client.js
pnpm test             # 构建 + 全量测试
pnpm pack             # 生成可安装的 tgz
```

- 客户端源码在 `client-src/`，按文件名顺序拼接（见 `scripts/build-client.mjs`），新增 section 需加入列表；
- 宿主侧在 `lib/`，入口 `index.js`；
- 使用说明、架构、安全与开发文档见 [`docs/`](docs/README.md)。

## 许可

[MIT](LICENSE)。依赖许可：`pg`/`mysql2`/`hyparquet`/`csv-parse`/`exceljs` 为 MIT，`echarts` 为 Apache-2.0。

## 贡献

欢迎 issue 与 PR；提交前请跑 `pnpm test`。行为准则与贡献指南将在开源准备阶段补齐。
