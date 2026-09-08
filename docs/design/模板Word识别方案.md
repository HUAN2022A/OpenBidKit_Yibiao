# 模板 Word 识别 —— 上传模板自动配置导出参数 实施方案

> 状态：待实施
> 目标项目：OpenBidKit_Yibiao（Electron 桌面端）
> 关联需求：模板设置中上传自己的模板 Word，AI 识别后自动配置好模板参数

---

## 1. 背景与问题

模板设置当前只能手动配置：[ExportFormatPage.tsx](client/src/features/export-format/pages/ExportFormatPage.tsx)（1650 行表单）逐项填写纸张、标题六级样式、正文、表格、图片等参数，或用两套预设（版面/主题）快速填充。用户手里通常已有一份符合公司规范的模板 Word，希望上传后自动得到参数配置，再人工确认微调。

## 2. 目标与非目标

### 目标

- 上传 .docx 模板，解析出排版事实（字体、字号、对齐、缩进、行距、编号、页面设置、页眉页脚、表格样式等）。
- **规则主路**：确定性映射（查表 + 单位换算 + 模式匹配）把事实转成 `ExportFormatConfig`，预填进现有新建模板表单，每项附置信标记。
- **AI 兜底**：仅当存在规则无法归类的项（未知字体、无法判定标题层级、编号模式未匹配）时，调用一次用户配置的模型补全这些项。
- 输出"识别依据摘要"（如"检测到一级标题：黑体小二居中"）供用户核对。
- 用户确认/微调后走现有保存链路（`templates:create`），识别结果**不自动生效**。

### 非目标（本期不做）

- 不修改用户的原始模板文件；不做"格式克隆"（逐字节复刻模板样式）——导出仍按参数重新生成。
- 不做 .doc/.wps 直读（v1 仅 .docx；旧格式可复用既有 LibreOffice 转换提示，Phase 2 再考虑自动转换）。
- 不做 openxmlhelper（.NET）解析源（Phase 2 可插拔接入，见 §4.1）。
- 复杂文档（多分节、重度主题字体、样式继承链极深）保真度不做 100% 承诺，靠置信标记 + AI 兜底 + 人工确认兜住。

## 3. 现状代码锚点

| 位置 | 说明 |
|---|---|
| `client/src/shared/types/exportFormat.ts` | `ExportFormatConfig` 完整参数集；`SIZE_TO_PT`（约 L250，中文字号→pt 映射，规则映射做反向查表）；`FONT_OPTIONS`/`ALIGNMENT_OPTIONS` 等枚举 |
| `client/src/features/export-format/pages/ExportFormatPage.tsx` | 表单页；预设预填机制 `handleApplyLayoutPreset`（约 L509）/`handleApplyThemePreset`（约 L520），识别结果复用同一 `setConfig` 路径 |
| `client/src/features/export-format/pages/MyTemplatesPage.tsx` | 模板列表与新建入口 |
| `client/electron/services/templateStore.cjs` | 模板 CRUD（listTemplate/getTemplate/createTemplate/updateTemplate/deleteTemplate） |
| `client/electron/ipc/templateIpc.cjs` | 现有通道 `templates:list/get/create/update/delete`（无上传/分析通道） |
| `client/electron/services/knowledgeBaseService.cjs` 的 `uploadDocuments` | Main 侧 `dialog.showOpenDialog` 选文件的既有模式 |
| `client/electron/services/aiService.cjs` 的 `collectJsonResponse` | 结构化 JSON 输出模式（知识库图片标注同款；AI 兜底复用） |
| `client/electron/preload.cjs` | `window.yibiao.file.getPathForFile`（拖拽路径）；`template` 命名空间现状 |
| 依赖 | `adm-zip`、`cheerio` 已在 `client/package.json`，解析层零新依赖 |

## 4. 总体设计

### 4.1 三层架构（解析可插拔、映射规则化、AI 只兜底）

```
上传 docx
  │
  ▼
① 解析层（可插拔契约）        v1：纯 Node（adm-zip 解包 + cheerio 读 OOXML）
  │                            接口中立，Phase 2 可加 openxmlhelper 第二实现源
  ▼ 排版事实 facts.json（原始事实，含来源标注）
② 规则映射层（确定性，零模型）  字号查表 / 字体别名表 / 单位换算 / outlineLvl 分级 / 编号模式匹配
  │                            每项附 confidence: 'rule' | 'ai' | 'missing'
  ▼ ExportFormatConfig 预填 + 识别依据摘要
③ AI 兜底层（可选）            仅对低置信/未归类项做一次补全调用；
                               摘要可让 AI 润色（可选）
  ▼
预填表单 → 人工确认 → templates:create 保存
```

**为什么规则做映射主路**：pt→中文字号、字体归一、对齐/缩进/边距换算、`w:outlineLvl` 标题分级、`numFmt`+`lvlText` 编号模式识别都是机械换算，规则结果确定、零成本、离线可用、可单元测试；机械换算交给 AI 反而费 token 且易错（仓库文章五已论证弱模型输出复杂 JSON 不稳定）。

**AI 兜底的边界**：只补"未归类项"的小件 JSON（每件字段量小），用严格 validator 校验；不为省事把完整映射交给 AI。

### 4.2 排版事实契约（facts）

解析层输出与路线无关的中立结构（v1 由 Node 实现）：

```js
{
  page: { paperSizeMm, orientation, marginsCm, firstPageDifferent },
  headerFooter: { headerText, footerText, pageNumberFormat, pageNumberStart },
  styles: [{ styleId, styleName, outlineLvl, fontEastAsia, fontAscii, sizeHalfPt, bold, alignment, colorHex, spacingBeforePt, spacingAfterPt, firstLineIndentChars, lineSpacing, numFmt, lvlText, basedOn }],
  headingStyleIds: ['1', '2', ...],   // 按 outlineLvl 归级的样式
  bodyStyleId: 'a',                    // 正文样式
  tableStyles: { border, headerRow, bodyCell },   // 能取则取，取不到置信缺省
  unclassified: [{ kind: 'unknown-font', raw: '...', context }],  // 规则未归类的项，交给 AI 兜底
}
```

### 4.3 识别结果与置信

`templates:analyze-word` 返回 `{ config, summary, confidenceByField }`：
- `config`：规则映射出的 `ExportFormatConfig` 预填值（未识别字段填默认值）。
- `summary`：逐组中文摘要（规则模板化拼写，AI 兜底项标注"AI 推断"）。
- `confidenceByField`：如 `{ 'headings.0.font': 'rule', 'table.header_row.font': 'ai', 'image.caption_font': 'missing' }`，供摘要展示与后续调优。

### 4.4 数据与流程

- **IPC 新通道**：`templates:analyze-word`（无参，Main 弹文件对话框选 .docx，仿 `uploadDocuments` 模式）→ Main 解析 + 规则映射（+按需 AI 兜底，经 `aiService.collectJsonResponse`，遵循离线模式守卫）→ 返回识别结果。解析与映射均在 Main 后台完成，不阻塞页面。
- **Renderer**：ExportFormatPage（`mode="create"`）增加"上传 Word 模板识别"入口；识别完成后 `setConfig` 预填 + 展示识别摘要面板；用户确认后走现有 `templates:create` 保存。
- **离线语义**：规则主路纯本地零网络；AI 兜底走用户配置模型，离线模式下跳过兜底并提示"部分项需人工确认"（与全局离线模式方案口径一致）。
- 预览验证：导出参数可先试用现有导出流程生成样例 Word 核对（现有能力，不新增）。

## 5. 分阶段实施

| 阶段 | 内容 | 改动范围 |
|---|---|---|
| Phase 0（规则主路，可独立交付） | 新建 `client/electron/services/templateWordAnalyzer.cjs`（docx 解包 + facts 提取 + 规则映射 + 摘要拼写）；`templateIpc.cjs` 注册 `templates:analyze-word`；preload + `ipc.ts` 类型；ExportFormatPage 上传入口与预填/摘要面板 | 新建服务 + 3 个接线文件 + 页面 |
| Phase 1（AI 兜底） | 未归类项补全调用（一次批量）+ 严格 validator + 摘要标注"AI 推断" | analyzer 服务内 + 页面摘要展示 |
| Phase 2（可选增强） | openxmlhelper 作为第二解析源（同 facts 契约）；.doc/.wps 经 LibreOffice 自动转 docx；识别置信度低时提示重试 | .NET 助手 + 打包链路 |

## 6. 测试与验收

### 单元 / 集成

1. 解析器 fixture 测试（`node --test`，fixture docx 由测试脚本生成或用静态样例）：标准样式模板、WPS 产出模板、纯直接格式模板、含页眉页脚/编号/表格模板，断言 facts 关键字段。
2. 规则映射测试：`SIZE_TO_PT` 反向查表（含四舍五入档位）、字体别名表（SimSun/宋体-简/主题字体→宋体）、`numFmt`+`lvlText` 模式（1.1.1 → outline-decimal；`第{zh}章` 式 → 自定义模板）、单位换算（twips→cm、half-points→pt、行距倍数）。
3. AI 兜底：只对 `unclassified` 项调用；validator 拒绝非法字号/字体名；离线时跳过。

### 端到端场景

- **A（标准模板）**：上传规范公司模板 → 预填与人工核对的差异小 → 确认保存 → 导出 Word 风格与模板一致。
- **B（WPS 模板）**：规则能识别大部分字段，个别项标"AI 推断"或"未识别"。
- **C（无 AI 配置/离线）**：流程可用，未归类项提示人工确认，全程零模型调用。
- **D（回归）**：手动配置/预设/保存/导出链路不受影响。

## 7. 风险与边界

| 风险 | 应对 |
|---|---|
| 识别≠复刻：导出按参数重新生成，不可能与模板 100% 一致 | 摘要明示"参数化重建"预期；用户确认环节兜底 |
| WPS/怪癖文档解析偏差 | 置信标记 + 摘要透明化 + AI 兜底 + Phase 2 openxmlhelper 第二源 |
| 弱模型 JSON 不稳定 | AI 只补小件、严格 validator、失败即降级为"未识别" |
| 大文件/损坏文件 | 解析前置大小与 zip 校验，报错文案可操作 |
| 主题字体（asciiTheme）未解析 | v1 主题字体按"未归类"交 AI 兜底；别名表覆盖常见映射 |
