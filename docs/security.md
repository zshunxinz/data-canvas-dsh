# Security

## 只读数据访问

- 数据库连接使用**只读事务**（PostgreSQL `BEGIN READ ONLY`，MySQL `START TRANSACTION READ ONLY`）；
- SQL 守卫（`lib/db/guard.js`）：
  - 只允许单条语句；
  - 只允许 `SELECT` / `WITH` / `EXPLAIN` / `SHOW` / `DESCRIBE` / `VALUES` / `TABLE`；
  - 拒绝写操作、DDL、`COPY`、`SET`、`LOAD` 等；
  - 自动加 `LIMIT`（多包一层子查询）与 15 秒超时；
  - MySQL 关闭多语句与本地文件加载。
- 不提供数据编辑（INSERT/UPDATE/DELETE）能力。

## 凭据

- 密码使用 **AES-256-GCM** 加密存储在 `storages/xcharts-canvas/secrets/`；
- 主密钥为 `secrets.key`（尽力 0600）或环境变量 `XCHARTS_SECRET_KEY`；
- 数据源 JSON、列表接口、Agent 工具输出、日志、备份、导出文件中**均不含密码**；
- 删除数据源会级联删除凭据；
- 备份只带连接元数据，换机导入后需要重新填写密码。

## 脱敏

- Agent 工具与溯源输出中的主机显示为 `10.0.*.*` 形式；
- 错误信息去掉连接串与密码；
- system prompt 明确告诉模型：只读、不要索要密码、不要尝试写操作。

## AI 边界

- 模型只能通过工具看到**结构**与**查询结果**（以及用户主动引用的内容/文件）；
- 连接凭据不进入模型上下文；
- 引用协议 `[xcharts:...]` 只表示可读取内容，不表示授权。

## 威胁模型与限制

- 本插件是**单机**工具：默认信任本机用户与本地存储；
- 不提供多用户、权限、审计、远程共享；
- 主密钥与 `secrets/` 同目录时，能读取该目录的本机进程可解密凭据——这是本地工具的固有限制；
- 生产数据库请使用**只读账号**；代码守卫是纵深防御，不替代数据库权限控制。

## 报告问题

发现安全问题请通过仓库 issue 私下联系维护者（或使用 GitHub Security Advisory），不要公开贴出可复现的凭据/数据。
