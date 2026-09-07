# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

易标投标工具箱（OpenBidKit_Yibiao）：开源免费 AI 标书编写桌面工具（AGPL-3.0），Electron + React 19 + TypeScript + Vite。功能覆盖 AI 生成技术方案、图文、商务标、企业知识库、标书查重、废标项检查、标讯等。

- `client/`：当前唯一有效产品代码（Electron 桌面客户端）。
- `analytics/`：独立 Cloudflare Worker API + Dashboard（埋点统计、公告、资源、插件、模型信息、许可证、Agent 失败诊断等在线服务）。改在线服务协议时同步检查两端。
- `openxmlhelper/`：.NET 10 的 Word / Open XML 助手，打包进客户端 extraResources。
- `sql/workspace_schema.sql`：SQLite 目标结构的文档镜像；运行时权威是 `client/electron/services/sqliteDatabase.cjs` 的 migration。

**开工前必读**：[AGENTS.md](AGENTS.md)（仓库总规则）和 [client/开发说明.md](client/开发说明.md)（客户端稳定架构边界、复用入口与易遗漏约束）。两者比本文件更详细，冲突时以它们为准。

## 常用命令

仓库根目录没有 `package.json`，所有客户端命令先 `cd client`。CI 使用 Node 22；调试 Open XML 功能或本地打包还需要 .NET 10 SDK。

```powershell
cd client
npm ci                        # 安装；postinstall 按当前 Electron 重建 native 模块
npm run dev                   # Vite 127.0.0.1:5173 --strictPort 启动后打开 Electron
npm run build                 # tsc --noEmit && vite build（唯一类型检查入口）
npm run smoke:electron-native # 验证 better-sqlite3 等 native 模块 ABI（必须用 Electron 跑）
node --check electron/xxx.cjs # 修改 Main/preload 后逐个做语法检查
node --test <file.test.cjs>   # 定向执行测试（仓库无统一 lint/test 脚本）
npm audit                     # 依赖变更时
npm run dist:win              # Windows 打包；dist:mac 同理，产物在 client/release/
```

- `npm run build` 出现既有 chunk 体积警告但退出码为 0 时仍算成功。
- `better-sqlite3` 报 `NODE_MODULE_VERSION` 不匹配时运行 `npm run postinstall`。
- Analytics：`cd analytics/worker`（或 `dashboard`）后 `npm install; npm run dev` / `npm run deploy`。`analytics/scripts/deploy-if-changed.mjs` 只部署有变化的目录，强制部署用 `FORCE_DEPLOY=1 npm run deploy`。

## 架构

### 进程边界（最关键的一条）

- Renderer = ESM TypeScript（`client/src/**`）；Electron Main、preload、IPC、services = CommonJS（`client/electron/**/*.cjs`），保持 `.cjs`。
- Renderer 不直接使用 Node、`fs`、`path`、`ipcRenderer`，只通过 `window.yibiao` 访问本地能力；修改 preload API 必须同步 `client/src/shared/types/ipc.ts`（全局声明由 `src/vite-env.d.ts` 引用）。
- 主窗口开启 `contextIsolation`、关闭 `nodeIntegration`。Renderer 负责页面状态与交互编排；Main 负责配置、SQLite、文件解析、AI、Agent、后台任务、导出、插件、更新。

### 运行结构与代码位置

```
src/main.tsx → AppProviders → WorkspaceDatabaseGate → App → AppShell + AppRouter
Renderer → window.yibiao → electron/preload.cjs → electron/ipc/*.cjs → electron/services/*.cjs
```

- `AppRouter` 是基于 `SectionId` 的组件分发，不是 URL 路由，不要按 React Router 的约定加页面。`WorkspaceDatabaseGate` 在数据库检查/迁移完成前阻止业务页面挂载。
- 功能代码放 `src/features/<feature>/`（目录按实际复杂度创建，不补空层级）；跨功能运行时代码放 `src/shared/`（ui/types/prompts/utils/markdown），`shared/` 不得依赖 feature。只被一个功能使用的代码留在该 feature，出现真实跨功能复用后再上移。
- 新增菜单页面需同步 5 处：`src/shared/types/navigation.ts`（SectionId）、`src/app/menuConfig.ts`、`src/app/AppRouter.tsx`、`src/components/Sidebar.tsx`（图标映射）、`analytics/dashboard/public/src/pages/traffic.js`（埋点路由中文名）。页面底部操作条复用 `FloatingToolbar`。
- 新增/修改 bridge API 的完整链路：`electron/services/` 实现 → 对应 `electron/ipc/*Ipc.cjs` 注册通道 → `ipc/index.cjs` 装配（依赖工作区数据库的通道同时加入 `workspaceDatabaseChannels`）→ `preload.cjs` 暴露 → `src/shared/types/ipc.ts` 同步类型。新业务 IPC 默认保持薄（只注册/转发），业务逻辑放 services。
- `onXxx` 事件 API 必须返回取消订阅函数，React effect 卸载时调用。

### 数据与后台任务

- 配置存 Electron `userData/user_config.json`；业务工作区存 `userData/workspace/`；结构化业务状态的权威存储是 `userData/workspace/yibiao.sqlite`。改表结构 = 在 `sqliteDatabase.cjs` 增加 migration + 同步根目录 `sql/workspace_schema.sql`。
- Renderer 只用 `localStorage` 存轻量 UI 偏好；草稿、API Key、流程状态、业务正文都走 Main 侧存储/IPC。
- 耗时流程（标书分析、目录生成、正文生成、查重、废标检查等）在 Electron Main 后台任务中运行并持续写入对应 SQLite Store，页面卸载不取消任务；重新挂载从 Store 快照和 `tasks.getActiveTasks()` 回放恢复。
- 受管任务经 `taskService.cjs`：`updateTask()` 只更新 Main 内存并推送事件；`checkpointTask()` 在同一 Store 事务中提交任务和业务 patch 后再推送事件。会清空任务或下游结果的命令必须先取消相关活动任务并等待 runner settled 再提交 Store（复用 `beforeCommit` 链路）。
- Main 侧文件读写显式使用 UTF-8，并把 Windows 中文路径当默认场景处理。
- Mermaid 以 Markdown `mermaid` 代码块持久化：Renderer 由 `MarkdownRenderer` 本地预览，Word 导出由 Main 的 `localImageRenderService.cjs` 本地转图（不依赖外网）。
- `MarkdownRenderer` 当前默认允许原始 HTML：AI、Agent、远程公告等非本地可信内容必须显式传 `allowRawHtml={false}`。

### 技术方案（technical-plan）关键不变量

- 目录与正文的权威来源是 `technical_plan_outline_nodes` 表（Renderer 对应 `outlineData.outline[*].content`）。
- `saveOutline()` 的 `reason` 是持久化协议：`replace` 清空全部旧正文；`edit`/`delete`/`add-*` 结合 `idMap`/`affectedNodeIds` 只失效受影响节点；`sort` 重映射并保留正文与相关状态。省略 `reason` 会被 Store 按 `replace` 处理。
- 所有非 `sort` 的目录变更会使正文任务和全文图片计划失效，纯排序保留并重映射。这些失效清理由 Main Store 完成，Renderer 不另写一套清理规则。
- 正文任务处于 running/pausing/paused 时，Store 禁止目录变更和手工正文保存。
- `technical-plan` 与 `existing-plan-expansion` 两个入口共用 `TechnicalPlanHome.tsx`、各 Step 页面、同一套 Store 和任务事件，仅由 `workflowKind` 区分。改共用页面必须同时验证两个入口，不复制流程页面。

### AI 与 Agent

- 模型请求统一经过 `electron/services/aiService.cjs`（集中处理模型配置、文本/生图队列、并发、重试、取消、Token 统计与埋点），Main 业务代码不要直接发模型 HTTP 请求。
- Pi Agent（@earendil-works/pi-*）由 `agentService.cjs` 管理，每次调用创建独立 Runtime/Session；`services/agent/` 与 `services/pi/` 只实现运行时与工具，不引用业务 Store 或业务 Prompt。业务适配器通过 `agentService` 公共接口调用。
- Prompt 不写进产品组件：Renderer 可复用 Prompt 放 `src/shared/prompts/`，feature 或 Main 后台任务专用 Prompt 与对应 service/task 放在一起。
- Agent 提问由全局 `AgentQuestionDialogProvider` 和 Main 的问答/自动确认服务承接，feature 不实现第二套等待 Promise 或弹窗。

### UI

- 全局 CSS + Radix primitives，不使用 Tailwind；用户可见文案用中文。
- 优先从 `src/shared/ui/index.ts` 引入复用组件：`FloatingToolbar`、`AppDialog`、`AppSwitch`、`UploadBoard`、`ProgressBar`、`EmptyState`、`MarkdownRenderer`、`MarkdownEditor` 等。
- 成功/失败/普通提示走 `useToast()` 的 `success`/`error`/`info`，不用 `alert`/`window.confirm`；确认或长文案用 `AppDialog`。
- 页面根容器保持 `height: 100%`/`min-height: 0`，长内容在页面内部滚动；`body` 固定 `overflow: hidden`，不为 `FloatingToolbar` 预留大段空白。
- 新 feature 样式放 `src/styles/feature-<name>.css`，在 `src/styles.css` 的 feature 区导入；总入口顺序 tokens → layout → shared → feature 参与 CSS 优先级，不随意重排。

## 验证要点

| 改动范围 | 最低验证 |
|---|---|
| Renderer / TypeScript | `cd client; npm run build` |
| Main / preload / IPC | 逐个 `node --check` 改动的 `.cjs`，再 `npm run build`；涉及窗口/IPC 还要 `npm run dev` 手动验证 |
| SQLite Store / migration / 后台任务 | 上述之外加 `npm run smoke:electron-native`，并手动验证保存、重启恢复、中断状态 |
| 有对应 `*.test.cjs` 的模块 | `node --test <test-file>` |
| 依赖变更 | `npm ci`、`npm run build`、`npm audit` |

## 硬性要求

- 用户报功能异常时不要猜原因：先真实排查代码和复现链路，按需增加诊断日志，精准定位后再修复。
- 本地客户端场景下，Renderer、preload、Main、内部 IPC 都属于用户本机可信边界：只在用户输入层做校验，层级之间不重复堆叠参数校验，也不加多余安全性兜底。
- 严格遵守用户命令。额外想法只在 Plan 阶段提出；进入 Build 阶段后仅执行已确认方案，如需扩大范围必须先向用户确认。
- 禁止删除、绕过或弱化任何埋点、统计、Analytics Dashboard 展示和 Worker 聚合逻辑；确需调整必须等价保留统计能力并说明影响。普通 `/track` 埋点不得上传 API Key、Prompt、模型响应、文件内容、文件名或本地路径。
- 不把 `ACCOUNT_ID`、`ADMIN_TOKEN`、`ANALYTICS_API_TOKEN` 等密钥写入仓库；Worker 配置保留 `keep_vars: true`，不要在 `wrangler.jsonc` 增加 `secrets.required`。
- 正式发布尚未接入 Windows/macOS 操作系统代码签名，未签名提示是已知发布约束，不要在普通功能改动里临时绕过。

## 发布

`.github/workflows/release.yml` 只在推送 `v*` tag 或手动输入 `tag_name` 时发布客户端：CI 使用 Node 22，在 `client/` 下 `npm ci`，从 tag 同步 `package.json` 版本，`electron-builder --publish never` 构建后由 `gh release upload` 上传产物。
