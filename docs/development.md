# Development

## 前置

- Node.js 22+
- pnpm

## 命令

```bash
pnpm install          # 安装依赖（含 pg/mysql2/hyparquet）
pnpm build:client     # 拼接 client-src → client.js
pnpm test             # 构建 + 全量测试
pnpm pack             # 生成 dsh-xcharts-canvas-<version>.tgz
```

单独跑测试：

```bash
node --test tests/store.test.js tests/routes.test.js
```

## 客户端源码组织

`client-src/` 下的文件按**文件名顺序**拼接成一个浏览器 bundle（`client.js`），它们共享同一作用域：

- `00-entry.js` 定义 `__ModuleLoader__` 注册入口；
- `04-styles-icons.js` / `04b-ui-kit.js`：样式 token 与通用组件（Dialog、Select、IconButton、ToastStack、PanelPopover…）；
- `09*`：数据源工作区与表格；
- `10-plugin-registration.js`：注册插槽、侧边栏入口、@ 触发器；
- `99-exit.js` 结束注册。

**新增 section 必须**在 `scripts/build-client.mjs` 的 `sections` 列表中登记，否则不会被打包。

## 测试

- 全部为 `node:test`，无浏览器依赖；
- 界面用自研 React stand-in（`tests/helpers/react-standin.mjs`）渲染真实 `client.js`；
- 修改客户端后必须重新构建再跑测试（`pnpm test` 已包含构建）；
- 新增行为优先补**小而有价值**的回归测试，不堆无意义断言。

## 约定

- 复用现有组件与 token（`S`、`RADIUS`、`UI`），不引入新的视觉语言；
- 不新增一级按钮：能力进现有下拉/右键/弹窗；
- 控件位置稳定：不因 hover/聚焦改变布局（避免点击目标漂移）；
- 只读定位：任何新功能都不产生数据库写操作；
- 中文文案短句、动词开头，与现有界面一致。

## 发布

1. 更新 `CHANGELOG.md`；
2. `pnpm test` 全绿；
3. 版本号遵循 semver（0.x 阶段允许小步变化）；
4. `pnpm pack` 生成 tgz，确认包含 `LICENSE`、`README.md`、`package.json`；
5. 打 tag（`vX.Y.Z`）并在 GitHub Release 附 CHANGELOG；
6. npm 发布（如启用）。

## 目录说明

- `lib/`：宿主代码；`tests/`：测试；`scripts/`：构建/打包/验收脚本；
- `docs/`：使用（usage）、架构（architecture）、安全（security）、开发（本文件）。
