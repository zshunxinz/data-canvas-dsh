# Architecture

dsh-xcharts-canvas 是一个 DeepSeek Harness 插件（Cordis bundle），分宿主与浏览器两半。

## 目录

```
index.js           宿主入口：注册工具、路由、system prompt 段
lib/               宿主侧：store、data-store、routes、tools、trace、reference、backup…
client-src/        浏览器侧源码（按文件名顺序拼接为 client.js）
client.js          构建产物（不要手改）
client.echarts.js  echarts UMD chunk（构建产物）
tests/             node:test 测试
scripts/           构建、打包、验收脚本
docs/              使用、架构、安全、开发文档
```

## 两半职责

**宿主（`lib/`）**

- `store.js`：画布、卡片、版本、撤销历史；
- `data-store.js`：数据源（文件快照 / 数据库连接）、查询、结果快照；
- `routes.js`：`/api/xcharts-canvas/*` HTTP 路由；
- `tools.js` / `data-tools.js` / `reference-tools.js` / `trace-tools.js`：Agent 工具；
- `secrets.js` + `lib/db/`：加密凭据与只读数据库适配器；
- `workspace-backup.js`、`storage-maintenance.js`：备份与存储维护。

**客户端（`client-src/`）**

- 按文件名顺序拼接（见 `scripts/build-client.mjs`），新增 section 必须加入列表；
- `09-data-sources.js` / `09a-data-table.js` / `09c-database-ui.js`：数据源工作区与可复用表格；
- `07-canvas-workspace.js`：分析画布；
- `10-plugin-registration.js`：注册两个 `main` 插槽与侧边栏入口。

## 数据存储

默认 `$DSH_HOME/storages/xcharts-canvas/`：

```
canvases/    画布（卡片、版本、布局）
datasources/ 数据源（文件快照内联行 / 数据库连接元数据）
results/     查询结果快照
inputs/      溯源用的输入快照
history/     撤销历史
executions/  执行记录
followups/   追问草稿
usages/      引用使用记录（按月）
secrets/     AES-256-GCM 加密凭据
secrets.key  本地主密钥（0600，或 XCHARTS_SECRET_KEY）
```

## HTTP API

统一前缀 `/api/xcharts-canvas`，主要资源：

- `/canvases`、`/canvases/:id`、`/canvases/:id/layout`、`/canvases/:id/arrange`
- `/datasources`、`/datasources/:id`、`/datasources/:id/query`、`/datasources/:id/schema`
- `/datasources/:id/results/:resultId`、`/datasources/:id/usage`
- `/datasources/test-connection`、`/datasources/database`、`/datasources/:id/secret`
- `/capabilities`、`/changelog`、`/storage`、`/backup/export`、`/backup/import`

## 引用协议

对话中的短引用由宿主工具解析：

- `[xcharts:ds:<id>@<hash>]`：数据源（版本化）；
- `[xcharts:res:<id>]`：结果快照；
- `[xcharts:card:<canvas>/<card>@<version>]`：卡片数据版本。

AI 先解析引用再回答；引用只表示"可读取的内容"，不表示授权。

## 工具

画布：`canvas_create`、`canvas_add_card`、`canvas_update_card`、`canvas_add_result`、`canvas_list`、`canvas_read`、`canvas_delete`、`canvas_followup`；
数据源：`datasource_list`、`datasource_import`、`datasource_describe`、`datasource_query`、`datasource_test_connection`；
其他：`measure_create`、`analysis_read_result`、`xcharts_context`、`canvas_followup_context`。

## 兼容性

宿主 API 版本见 `GET /capabilities`（`api_version`、`plugin_version`）；新增路由时同时提升 `api_version` 并在客户端做降级。
