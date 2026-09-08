# AI 评标功能实现方案（并行开发契约）

> 本文档是 AI 评标功能的实现契约，多个开发 agent 按本文档的命名与接口并行实现，各层只依赖本文档定义，不互相依赖。

## 一、已锁定的产品决策

1. **单评委模式**：一次打分。`runOptions` 预留 `judgeCount` 字段（当前恒为 1），未来多评委时扩展为 `judgeCount: N` 取均值，不改表结构。
2. **仅从「生成的技术方案」导入**：打分对象是用户已在技术方案里生成的正文。数据源字段用单数 `technicalPlanDocument`，未来支持上传时扩展为 `bidDocuments[]`，不改表结构。
3. 菜单入口 `ai-evaluation`、`SectionId 'ai-evaluation'`、侧边栏图标均已存在，只需补 `AppRouter` 分发与 `traffic.js` 埋点。

## 二、数据源（全部现成，无需新解析）

| 需要 | 来源 | 读取方式 |
|---|---|---|
| 评分标准 | Step02 招标解析的 `techRequirements` | `technicalPlanStore.loadTechnicalPlan().techRequirements`（Markdown，含「技术评分项/技术评分要求」） |
| 招标文件正文 | 技术方案的招标文件 | `technicalPlanStore.readTenderMarkdown()` |
| 标书正文 | 生成的方案正文（权威在 `outlineData.outline[*].content`） | `technicalPlanStore.loadTechnicalPlan().outlineData.outline`（前序遍历，父节点只出标题，叶子节点出标题 + content） |

## 三、命名约定（全链路统一前缀 `evaluation`）

- 存储：`evaluationStore.cjs`，构造函数 `createEvaluationStore({ app, db, technicalPlanStore, taskLogStore })`
- 任务：`evaluationTask.cjs`，导出 `runEvaluationTask`
- IPC：`evaluationIpc.cjs`，导出 `registerEvaluationIpc`
- 任务类型：`evaluation-run`；`stateKey: 'evaluation'`；`group: 'evaluation-check'`；`groupLabel: 'AI评标'`；`field: 'evaluationTask'`
- Renderer feature 目录：`client/src/features/ai-evaluation/`

## 四、Store 契约（Agent A 实现）

### 状态结构（`loadEvaluation()` 返回值）

```js
{
  technicalPlanDocument: { id, role: 'technical-plan', fileName, content, source: 'technical-plan', importedAt } | null,
  scoringItems: { status: 'idle'|'success'|'error', content: '', source: 'technical-plan', updatedAt, error } ,
  runOptions: { judgeCount: 1 },
  evaluationResult: {
    status: 'idle'|'running'|'success'|'error',
    inputSignature, totalScore, totalMaxScore, scoreRate,
    overallComment,
    items: [ { id, name, maxScore, score, criteria, evidence, deductionReason, suggestion } ],
    activeItemId, progressMessage, error, updatedAt,
  },
  evaluationTask: { task_id, type: 'evaluation-run', status, progress, logs, started_at, updated_at, error } | undefined,
  activeTab: 'documents'|'results',
}
```

### 导出方法（`createEvaluationStore` 返回，Agent B/C 只调用这些，不得自行访问 db）

```js
{
  loadEvaluation,                 // () => 全量状态
  updateEvaluation,               // (partial) => void（含 saveUiState / saveResult / saveTask）
  updateEvaluationWithoutReload,  // (partial) => void
  clearEvaluation,                // async () => { success, message }
  importFromTechnicalPlan,        // async (options) => { success, message }
  readDocumentMarkdown,           // () => string（返回 technicalPlanDocument.content）
  createDocumentSignature,        // (document) => string
  createEvaluationInputSignature, // (document, scoringItemsContent) => string
}
```

`importFromTechnicalPlan` 内部逻辑：从 `technicalPlanStore` 读 `techRequirements`（写入 `scoringItems.content`）与 `outlineData.outline` 前序拼装全文（写入 `technicalPlanDocument`），二者都空则返回 `{ success: false, message: '技术方案中暂无评分标准与正文，请先完成招标解析与正文生成' }`。

### 数据表（migration 版本 26，`CREATE TABLE IF NOT EXISTS`）

```sql
evaluation_meta        (id INTEGER PRIMARY KEY, active_tab TEXT, run_options_json TEXT, created_at TEXT, updated_at TEXT)
evaluation_documents   (document_id TEXT PRIMARY KEY, role TEXT, source TEXT, file_name TEXT, markdown_path TEXT, content_hash TEXT, content_chars INTEGER, imported_at TEXT, updated_at TEXT)
evaluation_tasks       (type TEXT PRIMARY KEY, task_id TEXT, status TEXT, progress INTEGER, stats_json TEXT, error TEXT, started_at TEXT, updated_at TEXT)
evaluation_results     (result_type TEXT PRIMARY KEY, status TEXT, input_signature TEXT, total_score REAL, total_max_score REAL, overall_comment TEXT, active_item_id TEXT, progress_message TEXT, error TEXT, updated_at TEXT)
evaluation_score_items (item_id TEXT PRIMARY KEY, result_type TEXT, name TEXT, max_score REAL, score REAL, criteria TEXT, evidence TEXT, deduction_reason TEXT, suggestion TEXT, sort_order INTEGER, created_at TEXT, updated_at TEXT)
```

同步更新 `sql/workspace_schema.sql` 与 `sqliteDatabase.cjs` 的 `schemaVersion = 26` + `migrations` 数组加 `{ version: 26, description: 'AI评标', up(db) }`。

## 五、任务契约（Agent B 实现）

```js
// evaluationTask.cjs
async function runEvaluationTask({ aiService, workspaceStore, updateTask, checkpointTask, payload, previousState })
module.exports = { runEvaluationTask };
```

流程（三步，每步 `checkpointTask` 提交）：

1. **评分项拆解**：把 `scoringItems.content` 解析为结构化数组，JSON schema：
   ```json
   { "items": [ { "name": "评分项名称", "maxScore": 100, "criteria": "评分标准" } ] }
   ```
   （`maxScore` 从「权重/分值」提取；提取不到时默认 100 并用 `warning` 日志说明）
2. **逐项打分**：对每个评分项，读 `technicalPlanDocument.content` 相关章节，输出：
   ```json
   { "score": 85, "evidence": "标书原文证据", "deductionReason": "扣分/得分理由", "suggestion": "改进建议" }
   ```
   标书超长时用 `splitUserTextByContextLimit` 分段（复用 `rejectionCheckTask.cjs` 的滚动思路）。
3. **汇总**：`totalScore` / `totalMaxScore` 由 **Main 侧确定性求和**（不信 AI 算的总分）；AI 只输出 `overallComment`。`scoreRate = totalMaxScore > 0 ? totalScore / totalMaxScore : 0`。

AI 调用统一走 `aiService.chat` / `aiService.collectJsonResponse`，`schemaName` 用 `EvaluationScoringItems` / `EvaluationScoreItem` / `EvaluationOverall`；进度用 `updateTask`/`checkpointTask` 推 `progressMessage`。

## 六、装配契约（Agent C 实现）

### IPC 通道（`evaluationIpc.cjs`）

```js
evaluation:load-state                  -> evaluationStore.loadEvaluation()
evaluation:import-from-technical-plan  -> taskService.importEvaluationFromTechnicalPlan()
evaluation:save-ui-state               -> evaluationStore.updateEvaluation(partial)
evaluation:update-state                -> evaluationStore.updateEvaluationWithoutReload(partial)
evaluation:export-excel                -> checkResultExportService.exportEvaluationExcel(request)
evaluation:clear                       -> taskService.resetEvaluation()
tasks:start-evaluation-run             -> taskService.startEvaluationRun(payload)
```

### `ipc/index.cjs` 改动

- `createEvaluationStore(...)` 装配（`db: sqliteDatabase.db`）
- `createTaskService({ ..., evaluationStore })` 传入
- `registerEvaluationIpc({ evaluationStore, taskService, checkResultExportService })`
- 上述通道加入 `workspaceDatabaseChannels`

### `taskService.cjs` 改动

- 引入 `runEvaluationTask`
- `TASK_DEFINITIONS` 加 `evaluation-run`（见第三节命名约定）
- `runnerWorkspaceStore` 按 `stateKey === 'evaluation'` 返回 `evaluationStore`
- 新增 `startEvaluationRun(payload)`、`resetEvaluation()`、`cancelEvaluationTasks()`、中断恢复（参考 rejection-check 的 `recoverInterruptedRejectionCheckTasks`）

### `preload.cjs` + `ipc.ts`

preload 暴露 `window.yibiao.evaluation`：

```js
evaluation: {
  loadState: () => ipcRenderer.invoke('evaluation:load-state'),
  importFromTechnicalPlan: () => ipcRenderer.invoke('evaluation:import-from-technical-plan'),
  saveUiState: (payload) => ipcRenderer.invoke('evaluation:save-ui-state', payload),
  updateState: (partial) => ipcRenderer.invoke('evaluation:update-state', partial),
  exportExcel: (request) => ipcRenderer.invoke('evaluation:export-excel', request),
  clear: () => ipcRenderer.invoke('evaluation:clear'),
}
```

`tasks` 增加 `startEvaluation: (payload) => ipcRenderer.invoke('tasks:start-evaluation-run', payload)`。同步 `ipc.ts` 类型（`EvaluationWorkspaceState` / `EvaluationResultState` / `EvaluationScoreItem` / `EvaluationBackgroundTaskState`）。

### `checkResultExportService.cjs` 改动

新增 `exportEvaluationExcel(request)` 与 `buildEvaluationWorkbook`，两个工作表：
- 「评标概览」：总分、满分、得分率、总体评语、导出时间
- 「评分明细」：序号、评分项、满分、得分、评分标准、标书证据、扣分理由、改进建议

## 七、渲染层契约（Agent D 实现）

### 文件

- `client/src/features/ai-evaluation/types.ts`（镜像第四节状态结构）
- `client/src/features/ai-evaluation/pages/EvaluationPage.tsx`
- `client/src/app/AppRouter.tsx` 加 `case 'ai-evaluation': return <EvaluationPage />;`
- `analytics/dashboard/public/src/pages/traffic.js` 加埋点路由中文名「AI评标」

### 页面结构（参考 `RejectionCheckPage.tsx`）

- 步骤一「导入」：从技术方案导入按钮（调 `evaluation.importFromTechnicalPlan`），显示导入的评分标准/正文预览
- 步骤二「评标」：开始评标按钮（调 `tasks.startEvaluation`），进度条 + 日志（`ProgressBar` / 任务日志）
- 步骤三「结果」：总分卡片 + 评分明细列表（每项：名称/满分/得分/证据/理由/建议）+ 总体评语
- 底部 `FloatingToolbar`：导出 Excel、清空、返回
- 复用 `UploadBoard` / `EmptyState` / `MarkdownRenderer` / `AppDialog` / `useToast`

## 八、文件归属（并行 agent 各自动的文件，互不重叠）

| Agent | 文件 |
|---|---|
| A（存储层） | `evaluationStore.cjs`、`sqliteDatabase.cjs`、`sql/workspace_schema.sql` |
| B（任务层） | `evaluationTask.cjs` |
| C（装配层） | `evaluationIpc.cjs`、`ipc/index.cjs`、`taskService.cjs`、`preload.cjs`、`ipc.ts`、`checkResultExportService.cjs` |
| D（渲染层） | `features/ai-evaluation/types.ts`、`features/ai-evaluation/pages/EvaluationPage.tsx`、`AppRouter.tsx`、`traffic.js` |

## 九、验证命令（Agent 只做语法检查，不跑 build）

```bash
cd client
node --check electron/services/evaluationStore.cjs
node --check electron/services/evaluationTask.cjs
node --check electron/ipc/evaluationIpc.cjs
npm run build   # 最终集成后统一跑
```

## 十、参照模板（Agent 各自必读）

- A 读 `client/electron/services/rejectionCheckStore.cjs`
- B 读 `client/electron/services/rejectionCheckTask.cjs`
- C 读 `client/electron/ipc/rejectionCheckIpc.cjs`、`client/electron/ipc/index.cjs`、`client/electron/services/taskService.cjs`
- D 读 `client/src/features/rejection-check/pages/RejectionCheckPage.tsx`、`client/src/features/rejection-check/types.ts`
