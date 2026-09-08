# 招投标全流程 Skill 设计方案

本文档说明如何把“招投标技术方案生成流程”沉淀为一个 Codex Skill，并给出可直接改造成 `SKILL.md` 的结构草案。目标不是把现有项目代码照搬进去，而是把其中稳定、可复用的工作方法抽象出来，供 OpenClaw 或其他智能体工作流复用。

## 一、Skill 的定位

建议 Skill 名称：

```yaml
name: bidding-workflow
description: 将招投标资料处理、标段识别、招标解析、目录规划、全局事实整理、正文生成、审计修复、配图规划和交付物导出组织成可复用工作流。用于用户要求分析招标文件、生成投标技术方案、扩写已有方案、设计投标文档生成智能体、迁移招投标提示词工作流到 OpenClaw 或类似 agentic workflow 的场景。
```

这个 Skill 负责“指导智能体如何执行招投标流程”，不直接替代业务系统的状态机。正式产品里仍然应该由应用层管理：

- 文件上传和解析；
- 工作区状态；
- 后台任务；
- 用户确认；
- 失败恢复；
- 导出与落盘。

Skill 的价值在于让 Codex/OpenClaw 知道：

- 每一步做什么；
- 什么时候做；
- 输入是什么；
- 输出必须长什么样；
- Prompt 如何拆；
- 哪些事情禁止做；
- 如何验证结果；
- 如何从失败中恢复。

## 二、为什么不要做成一个“大 Prompt”

完整招投标流程很长，直接写一个“大 Prompt：请根据招标文件生成完整技术方案”会有几个问题：

- 上下文过大，招标文件、知识库、原方案很容易超限；
- 中间结果不可审计，用户很难确认哪一步出了问题；
- 正文容易前后矛盾，例如工期、服务期、人员、地点不一致；
- AI 容易改变目录结构，导致导出和章节缓存失效；
- 失败后只能整轮重跑，成本高；
- 很难迁移到 OpenClaw 的多 Agent/多阶段执行模型。

因此应设计成“多阶段、结构化、可恢复”的 Skill。

推荐总流程：

```text
输入规范化
  -> 标段/范围识别
  -> 招标文件解析
  -> 目录/计划树生成
  -> 全局事实变量整理
  -> 章节执行前编排
  -> 正文/产物生成
  -> 字数和结构调整
  -> 一致性/覆盖审计
  -> 局部 patch 修复
  -> 图片/附录/交付物规划
  -> 导出或交付
```

## 三、推荐 Skill 目录结构

如果正式创建 Skill，建议目录如下：

```text
bidding-workflow/
├── SKILL.md
├── agents/
│   └── openai.yaml
└── references/
    ├── workflow.md
    ├── prompt-patterns.md
    ├── schemas.md
    ├── validation.md
    └── openclaw-adapter.md
```

不建议把所有提示词都塞进 `SKILL.md`。按照 Skill 的渐进披露原则，`SKILL.md` 保持短，只放核心工作流和引用导航；详细 Prompt、Schema、迁移规则放到 `references/`。

### 文件职责

| 文件 | 作用 |
| --- | --- |
| `SKILL.md` | 触发后必读，放核心流程、强约束、何时读取 reference |
| `references/workflow.md` | 完整招投标业务阶段说明 |
| `references/prompt-patterns.md` | 各阶段 Prompt 模板和设计原则 |
| `references/schemas.md` | JSON 输出结构、字段定义、校验规则 |
| `references/validation.md` | 每一步如何判断通过、失败、可恢复 |
| `references/openclaw-adapter.md` | 如何迁移到 OpenClaw 的 Agent/Task/Tool 架构 |

## 四、SKILL.md 草案

下面内容可以作为 `bidding-workflow/SKILL.md` 的初稿。

```markdown
---
name: bidding-workflow
description: 将招投标资料处理、标段识别、招标解析、目录规划、全局事实整理、正文生成、审计修复、配图规划和交付物导出组织成可复用工作流。用于用户要求分析招标文件、生成投标技术方案、扩写已有方案、设计投标文档生成智能体、迁移招投标提示词工作流到 OpenClaw 或类似 agentic workflow 的场景。
---

# Bidding Workflow

使用本 Skill 时，按“先结构化理解，再生成，再审计修复”的顺序执行。不要把招标文件一次性塞进一个大 Prompt 直接生成完整投标文件。

## 工作原则

1. 先规范化输入，再让 AI 推理。
2. 长文本先分段处理，再合并。
3. 每个阶段必须有结构化输出。
4. 目录/计划树生成后，正文阶段不得擅自新增、删除、拆分、合并目录节点。
5. 全局事实变量是后续正文的统一口径，正文不得自行编造与其冲突的工期、地点、人员、品牌、质保、服务承诺。
6. 审计阶段只找明确问题，不做泛泛文风优化。
7. 修复阶段优先返回局部 patch，不返回完整重写。
8. 任何用户确认点，例如标段选择、目录确认、全局事实确认，都应停在相应阶段等待确认。

## 快速流程

1. 读取招标文件、补充资料、原方案和用户目标。
2. 将输入转成稳定工作区文件。
3. 如有多标段，先识别标段并要求用户选择范围。
4. 分任务提取招标文件关键信息。
5. 基于技术评分要求生成目录或计划树。
6. 整理全局事实变量。
7. 为每个叶子章节生成执行前编排。
8. 生成正文或目标产物。
9. 做字数、事实一致性和原方案覆盖审计。
10. 用局部 patch 修复问题。
11. 规划图片、附录或导出产物。

## 何时读取 references

- 需要完整业务阶段说明时，读取 `references/workflow.md`。
- 需要写或改 Prompt 时，读取 `references/prompt-patterns.md`。
- 需要设计 JSON 输出和校验时，读取 `references/schemas.md`。
- 需要做验收、失败恢复、重跑策略时，读取 `references/validation.md`。
- 需要迁移到 OpenClaw 时，读取 `references/openclaw-adapter.md`。

## 禁止事项

- 不要在一个 Prompt 中同时完成招标解析、目录生成、正文生成和审计。
- 不要让正文生成阶段改变目录结构。
- 不要把招标要求原样当作全局事实变量；应转写为本方案统一采用的响应事实或承诺口径。
- 不要在审计阶段报告“缺失但正文未涉及”的事实。
- 不要为了满足字数目标删除有效承诺或编造关键参数。
- 不要让 Agent 直接写业务数据库；Agent 输出文件必须由主流程校验后合并。
```

## 五、references/workflow.md 草案

```markdown
# 招投标工作流

## 1. 输入规范化

职责：把用户资料转成稳定工作区。

输入：
- 招标文件；
- 补遗文件；
- 用户投标范围；
- 已有方案，可选；
- 知识库，可选；
- 字数、表格、图片、审计配置。

输出：
- `tender-original.md`：完整招标文件；
- `tender.md`：当前投标范围工作副本；
- `original-plan.md`：已有方案；
- 输入索引、hash、字符数、解析状态。

规则：
- 下游只读规范化后的工作区文件；
- 用户变更输入后，清空下游结果；
- 不在此阶段生成正文。

## 2. 标段/范围识别

职责：识别招标文件中的标段、标包、分包或采购包。

输入：
- 带行号招标文件 Markdown。

输出：

```json
{
  "sections": [
    {
      "id": "section-1",
      "index": 1,
      "unit": "标段",
      "title": "一标段",
      "headLine": "一标段：设备采购及安装",
      "description": "设备采购、安装、调试及售后服务。",
      "includeRanges": [
        { "startLine": 120, "endLine": 180, "reason": "一标段采购清单" }
      ],
      "evidence": ["一标段：设备采购及安装"]
    }
  ]
}
```

用户选择某个范围后，生成 `tender.md` 工作副本。

## 3. 招标文件解析

职责：把招标文件拆成可复用的业务信息项。

必选项：
- 项目概述；
- 技术评分要求；
- 项目信息；
- 甲方信息；
- 交货和服务要求。

可选项：
- 采购清单；
- 响应文件要求；
- 代理机构信息；
- 投标关键节点；
- 投标保证金；
- 资格性审查；
- 符合性检查；
- 开标要求；
- 评标要求；
- 商务评分要求；
- 无效标与废标项；
- 合同授予与签订；
- 合同解除和终止。

规则：
- JSON 类提取必须固定 schema；
- Markdown 类提取只输出整理结果；
- 长文本分段提取后合并；
- 必填项失败时，不进入目录生成。

## 4. 目录/计划树生成

职责：根据技术评分要求生成技术方案目录。

输入：
- 项目概述；
- 技术评分要求；
- 原方案目录，可选；
- 知识库轻量条目；
- 字数控制配置。

输出：

```json
{
  "outline": [
    {
      "id": "1",
      "title": "总体实施方案",
      "description": "说明总体实施思路和关键路径",
      "children": [
        {
          "id": "1.1",
          "title": "实施目标",
          "description": "明确项目实施目标",
          "children": [
            {
              "id": "1.1.1",
              "title": "目标分解",
              "description": "分解目标和交付成果"
            }
          ]
        }
      ]
    }
  ]
}
```

规则：
- 一级目录应对应技术评分大类；
- 每个二级目录应包含三级目录；
- 字数目标影响叶子节点数量；
- 目录确认后，正文阶段不得改变结构。

## 5. 全局事实变量

职责：整理全文必须统一使用的事实、承诺和响应口径。

输入：
- 招标文件；
- Step02 关键解析；
- 目录；
- 知识库；
- 原方案，可选。

输出：

```json
{
  "groups": [
    {
      "id": "service_commitment",
      "title": "服务承诺变量",
      "content": "- 服务响应时间：接到通知后 2 小时内响应。\n- 质保期：按招标文件要求执行。"
    }
  ]
}
```

规则：
- 不输出招标要求摘录；
- 要转写为“本方案统一采用什么”；
- 保留工期、交货期或服务期等关键变量；
- 用户可人工编辑。

## 6. 章节执行前编排

职责：为每个叶子章节决定写作重点、引用素材、引用事实和表格需求。

输出：

```json
{
  "writing_focus": "本节重点说明项目实施组织方式和协调机制。",
  "knowledge": { "item_ids": ["kb-1::item-3"] },
  "facts": { "titles": ["服务承诺变量"] },
  "table": {
    "needed": true,
    "purpose": "展示岗位职责和协作关系"
  }
}
```

规则：
- 只能从给定知识库 id 和事实标题中选择；
- 只做编排，不生成正文；
- 表格判断要克制。

## 7. 正文生成

职责：按叶子章节生成正文。

输入：
- 当前章节；
- 项目概述；
- 本章节选中的全局事实；
- 知识库正文；
- 编排决策；
- 字数目标；
- 原方案底稿，可选。

输出：
- 当前小节 Markdown 正文。

规则：
- 不输出章节标题；
- 不输出 Mermaid 或图片；
- 不编造未给出的关键承诺；
- 扩写模式下优先保留原方案实质内容。

## 8. 审计与修复

职责：检查事实冲突、原方案覆盖、字数和表格问题。

审计输出：

```json
{
  "conflicts": [
    {
      "section_id": "1.2.3",
      "fact_title": "服务承诺变量",
      "evidence": "正文中的冲突原文",
      "reason": "与全局事实变量不一致",
      "severity": "high"
    }
  ]
}
```

修复输出：

```json
{
  "patches": [
    {
      "section_id": "1.2.3",
      "old_text": "当前正文中逐字存在的原文块",
      "new_text": "替换后的正文块",
      "reason": "修复服务响应时间冲突"
    }
  ]
}
```

规则：
- 审计只报告明确冲突；
- 修复只返回局部 patch；
- patch 必须可唯一定位；
- 失败原因应回传下一轮修复。

## 9. 图片和交付物规划

职责：正文完成后统一规划配图、图表、附录和导出。

图片计划输出：

```json
{
  "items": [
    {
      "kind": "html",
      "image_type": "进度网络图",
      "title": "核心业务上线实施进度网络图",
      "section_ids": ["3.2.1", "3.2.2"],
      "placement": "before",
      "priority": 5
    }
  ]
}
```

规则：
- 全文统一规划；
- 图题不得重复；
- 同一小节只允许一张图；
- Mermaid/HTML/AI 图片按能力和适配度选择。
```

## 六、references/prompt-patterns.md 草案

```markdown
# Prompt Patterns

## 1. 通用提取 System Prompt

```text
你是专业的投标资料分析助手。请严格基于用户提供的上下文完成提取和总结。

通用要求：
1. 保持信息全面、准确，优先使用用户提供上下文中的内容。
2. 如果上下文没有提及，明确写“没有提及”。
3. 只输出最终结果，不输出过程、提示语或客套话。
4. 始终使用简体中文。
```

## 2. JSON 提取模板

```text
任务：{title}

目标：{goals}

约束：
1. 输出格式必须为 JSON。
2. 严格按照以下 JSON 格式输出，只修改 value，禁止修改 key 和结构。
3. 招标文件中没有的字段填充“没有提及”。

JSON 格式：
{schema}

仅输出 JSON，不要输出其他内容。
```

## 3. 长文本分段合并模板

```text
以下内容来自同一份招标文件按段分别解析后的结果。每段结果只代表该片段内的信息，不代表整份文件的完整结论。

合并要求：
1. 如果某段写“没有提及”，只表示该片段没有相关信息。
2. 如果其他片段提供了有效信息，应以有效信息为准。
3. 删除重复、空泛、冲突的片段性表述。
4. 保留所有有价值、可用于最终结果的信息。
5. 不要新增分段结果中没有的信息，不要自行编造。
6. 最终输出必须符合原始任务要求。
```

## 4. 标段识别模板

```text
你是严谨的招标文件多标段识别专家。你只能基于用户提供的带行号文本识别标段、标包、分包、采购包、包件或标的。

要求：
1. 只识别明确属于某个标段的内容范围。
2. 通用条款不要归入某个标段。
3. includeRanges 必须使用输入中的真实行号。
4. 不要编造标段。
5. 如果本段没有明确标段内容，返回 {"sections":[]}。
6. 只返回 JSON。
```

## 5. 目录生成模板

```text
你是一个专业的标书编写专家。请围绕指定的技术评分项大类，为已经固定好的一级目录生成二级和三级目录。

结构要求：
1. 顶层 children 只能放当前一级目录的直接子目录。
2. 每个二级目录都必须包含非空 children 数组。
3. 三级目录只包含 id、title、description，不要继续包含 children。
4. 编号必须以当前一级目录编号为前缀。
5. 只返回 JSON，不要输出其他内容。
```

## 6. 全局事实变量模板

```text
你是专业的投标技术方案事实变量整理助手。请基于用户提供的上下文，整理后续正文需要统一采用的全局事实变量。

关键定义：
1. 全局事实变量不是招标要求摘录、评分规则摘要或待办事项清单。
2. 它是技术方案正文中需要保持一致的确定性方案事实、响应设定、承诺口径或执行安排。
3. 用户资料已经给出明确事实时，优先使用资料中的事实值。
4. 用户资料只给出要求时，应转写为本方案统一采用的响应事实。
```

## 7. 正文编排模板

```text
你是投标技术方案正文编排助手。请根据章节上下文判断本小节最适合的表达方式。

要求：
1. 只返回 JSON。
2. knowledge.item_ids 只能从参考知识库轻量条目的 id 中选择。
3. facts.titles 只能从全局事实变量标题清单中选择。
4. writing_focus 用 1-2 句话概括本节正文重点。
5. 表格仅在明显提升表达清晰度时使用。
```

## 8. 正文生成模板

```text
你是一个专业的标书编写专家，负责为投标文件的技术标部分生成具体内容。

要求：
1. 内容要专业、准确，与章节标题和描述保持一致。
2. 这是技术方案，不是宣传报告，不要假大空。
3. 内容要详细具体，避免空泛描述。
4. 不要输出 Markdown 标题。
5. 严禁输出 Mermaid、图片 Markdown 或图表代码。
6. 如果本章节需要使用的全局事实变量中包含相关内容，必须优先使用变量值。
7. 未提供时不要主动编造具体人员、周期、质保、品牌、型号等。
```

## 9. 扩写模式正文模板

```text
当前章节已经从用户原方案中还原出正文底稿。该底稿是用户已经写好的真实技术方案内容，必须作为本章节的基础保留。

要求：
1. 首要遵从正文底稿，不要从零重写成另一套方案。
2. 必须保留底稿中的实质信息、技术路线、服务承诺、设备参数、人员安排、周期、验收、售后和实施方法。
3. 可以调整语序、合并重复表达、提升专业性、补充细节。
4. 不要提到“原方案”“历史文档”“用户原文”或“底稿”。
5. 输出当前章节完整正文，不输出标题。
```

## 10. 审计模板

```text
你是投标技术方案全文一致性审计助手。请审计本组正文是否与给定事实冲突。

要求：
1. 只返回 JSON。
2. 只找正文中已经明确写出、且与事实相违背的内容。
3. 正文没有涉及某条事实时，不要报告缺失，不要建议补充。
4. 不报告文风、质量、重复、篇幅、表达优化等问题。
5. section_id 必须来自允许清单。
```

## 11. 局部 patch 修复模板

```text
你是投标技术方案正文一致性修复助手。请只针对当前小节返回局部精确替换 patch。

要求：
1. 只返回 JSON。
2. 不要返回完整正文。
3. 只修正正文中与事实冲突的内容。
4. old_text 必须是当前小节正文中逐字存在的原文块，建议包含足够上下文，确保只出现一次。
5. new_text 是替换后的正文块，不要包含章节标题。
```
```

## 七、references/schemas.md 草案

```markdown
# Schemas

## 标段识别

```json
{
  "sections": [
    {
      "id": "section-1",
      "index": 1,
      "unit": "标段",
      "title": "一标段",
      "headLine": "一标段：设备采购及安装",
      "description": "设备采购、安装、调试及售后服务。",
      "includeRanges": [
        { "startLine": 120, "endLine": 180, "reason": "一标段采购清单" }
      ],
      "evidence": ["一标段：设备采购及安装"]
    }
  ]
}
```

校验：
- `sections` 必须是数组；
- 有效多标段至少 2 项；
- `includeRanges` 必须使用真实行号；
- `endLine >= startLine`；
- `title` 不能为空。

## 目录

```json
{
  "outline": [
    {
      "id": "1",
      "title": "一级目录",
      "description": "说明",
      "children": [
        {
          "id": "1.1",
          "title": "二级目录",
          "description": "说明",
          "children": [
            {
              "id": "1.1.1",
              "title": "三级目录",
              "description": "说明"
            }
          ]
        }
      ]
    }
  ]
}
```

校验：
- id 必须连续、可排序；
- title 不包含 Markdown `#`；
- title 不包含原文编号；
- 一级目录按业务要求锁定；
- 叶子节点数量应符合字数配置推导的范围。

## 全局事实变量

```json
{
  "groups": [
    {
      "id": "service_commitment",
      "title": "服务承诺变量",
      "content": "- 服务响应时间：2 小时内响应。"
    }
  ]
}
```

校验：
- `groups` 必须非空；
- 每项必须包含 `id/title/content`；
- content 必须是正文可直接统一使用的事实；
- 不应是招标要求摘录、评分规则、待办事项。

## 正文编排

```json
{
  "writing_focus": "1-2 句话说明正文重点",
  "knowledge": { "item_ids": [] },
  "facts": { "titles": [] },
  "table": {
    "needed": false,
    "purpose": ""
  }
}
```

校验：
- `knowledge.item_ids` 必须来自允许知识库 id；
- `facts.titles` 必须来自全局事实标题；
- `table.needed=false` 时 `purpose` 可为空；
- 不得出现正文草稿。

## 一致性冲突

```json
{
  "conflicts": [
    {
      "section_id": "1.1.1",
      "fact_title": "服务承诺变量",
      "evidence": "冲突原文",
      "reason": "冲突原因",
      "severity": "high"
    }
  ]
}
```

校验：
- section_id 必须来自允许清单；
- 只报告明确冲突；
- conflicts 可以为空。

## 局部修复 patch

```json
{
  "patches": [
    {
      "section_id": "1.1.1",
      "old_text": "当前正文中唯一存在的原文块",
      "new_text": "替换后的正文块",
      "reason": "修复原因"
    }
  ]
}
```

校验：
- old_text 不为空；
- new_text 不为空；
- old_text 与 new_text 不相同；
- old_text 必须能唯一匹配当前正文；
- patch 不得包含章节标题。
```

## 八、references/validation.md 草案

```markdown
# Validation

## 阶段通过标准

### 输入规范化

通过：
- 已产生稳定工作区文件；
- 文件 hash、字符数和解析状态已记录；
- 下游读取工作区文件而不是原始上传对象。

失败：
- 文件为空；
- 解析失败；
- 用户取消上传。

### 标段识别

通过：
- 识别到 2 个及以上有效标段；
- 每个标段有合法行号范围；
- 用户已选择当前投标范围。

失败：
- 未识别到有效标段；
- 行号不合法；
- 用户未选择范围。

### 招标解析

通过：
- 必选项全部 success；
- `projectOverview` 和 `techRequirements` 非空；
- JSON 类结果通过 schema 校验。

失败：
- 必选项为空；
- JSON 不合法且修复失败；
- 用户切换投标范围导致结果失效。

### 目录生成

通过：
- outline JSON 合法；
- 一级目录覆盖技术评分大类；
- 叶子节点数量满足或已记录 warning；
- 用户确认目录。

失败：
- 目录为空；
- 一级目录映射错误；
- 结构无法修复；
- 原方案超过用户设置的最大字数且无法扩写。

### 全局事实

通过：
- groups 非空；
- 每项有 id/title/content；
- 内容是统一事实而非要求摘录；
- 用户确认或保存。

失败：
- groups 为空；
- 无法生成工期/交付期/服务期相关变量；
- 与招标硬性要求明显冲突。

### 正文生成

通过：
- 每个叶子章节有有效正文；
- 正文不包含重复标题；
- 正文不包含 Mermaid 或图片代码；
- 章节状态 success。

失败：
- 生成内容为空；
- 输出只有标题或目录；
- 与全局事实明显冲突且修复失败。

### 审计修复

通过：
- 审计 JSON 合法；
- 无 high severity 冲突；
- patch 能唯一应用；
- 应用后复核通过。

失败：
- patch 无法定位；
- 修复后仍冲突；
- 修复引入新事实冲突。

## 恢复规则

- 页面关闭不能视为任务失败；
- active task 消失但状态仍为 running，应标记为“上次任务未完成”；
- 正文生成 paused 可继续；
- 目录、招标解析、标段识别中断通常要求重新执行；
- 清空上游输入时必须清空下游结果。
```

## 九、references/openclaw-adapter.md 草案

```markdown
# OpenClaw Adapter

## 推荐映射

| 招投标流程概念 | OpenClaw 可映射为 |
| --- | --- |
| workspace 文件 | Task workspace artifacts |
| Step02 解析项 | Extractor tasks |
| 目录 outline | Plan tree |
| 全局事实变量 | Project facts / constraints |
| 正文编排 | Task execution plan |
| 正文生成 | Worker task |
| 一致性审计 | Auditor task |
| patch 修复 | Patch applier / repair task |
| 图片规划 | Asset planning task |

## OpenClaw Skill 拆法

如果 OpenClaw 任务很复杂，不建议只做一个巨大 Skill。可以拆成：

```text
openclaw-bidding-intake
openclaw-bidding-extract
openclaw-bidding-plan-tree
openclaw-bidding-facts
openclaw-bidding-generate
openclaw-bidding-audit
```

如果用户更想“一键触发”，可以保留一个总 Skill：

```text
bidding-workflow
```

总 Skill 只负责调度和约束，细节引用 references。

## OpenClaw 执行模式建议

### 1. Intake Agent

职责：
- 读取用户资料；
- 建立输入包；
- 切分长文本；
- 记录 hash。

输出：
- `source.md`
- `source-index.json`
- `workflow-config.json`

### 2. Extractor Agents

职责：
- 独立提取项目概述、技术要求、关键日期、服务要求等；
- 每个提取项单独缓存。

输出：
- `extract/project-overview.md`
- `extract/tech-requirements.md`
- `extract/project-info.json`

### 3. Planner Agent

职责：
- 生成计划树；
- 审核计划树覆盖；
- 根据目标字数或复杂度调整叶子节点。

输出：
- `plan-tree.json`

### 4. Facts Agent

职责：
- 从输入、提取结果、知识库、旧方案中整理全局事实。

输出：
- `facts.json`

### 5. Worker Agents

职责：
- 每个叶子节点生成正文或代码产物；
- 只读取自己需要的事实和素材；
- 不改计划树。

输出：
- `sections/{node_id}.md`

### 6. Auditor Agent

职责：
- 检查事实冲突、覆盖缺失、格式问题；
- 只输出 issue JSON。

输出：
- `audit/issues.json`

### 7. Repair Agent

职责：
- 根据 issue 返回局部 patch；
- patch 由主流程应用。

输出：
- `repair/patches.json`

## 关键设计原则

1. Worker 不直接写最终文件，只写自己的输出。
2. Auditor 不修复，只报告问题。
3. Repair 不做审计，只修复已确认问题。
4. 主流程负责应用 patch 和更新状态。
5. facts 是所有 Worker 的共同约束。
6. plan-tree 是 Worker 的结构边界。
```

## 十、如果要真正创建 Skill

可以按下面步骤落地：

```powershell
# 1. 创建 Skill 目录
python C:\Users\huan2\.codex\skills\.system\skill-creator\scripts\init_skill.py bidding-workflow --path C:\Users\huan2\.codex\skills --resources references

# 2. 写入 SKILL.md
# 3. 写入 references/workflow.md
# 4. 写入 references/prompt-patterns.md
# 5. 写入 references/schemas.md
# 6. 写入 references/validation.md
# 7. 写入 references/openclaw-adapter.md

# 8. 校验
python C:\Users\huan2\.codex\skills\.system\skill-creator\scripts\quick_validate.py C:\Users\huan2\.codex\skills\bidding-workflow
```

如果 `skill-creator` 目录下没有 scripts，可改用当前 Codex 客户端自带的 Skill 创建工具或手工创建目录，但最终仍应满足：

- 文件夹名与 skill name 一致；
- 必须有 `SKILL.md`；
- frontmatter 只放 `name` 和 `description`；
- references 只放真正会被读取的资料。

## 十一、最适合迁移到 OpenClaw 的核心思想

从易标这个项目里，最值得借鉴的不是具体招投标文案，而是以下工作流设计：

1. **分阶段，不大包大揽**  
   每个阶段只做一件事，每个 Prompt 只服务一个输出。

2. **结构化输出优先**  
   提取、计划、事实、审计、修复都尽量 JSON 化。

3. **先计划，再执行**  
   正文生成前先做章节编排；OpenClaw 里可对应为每个任务先生成 task plan。

4. **全局事实约束所有生成**  
   避免多 Agent 并发时口径发散。

5. **审计和修复分离**  
   Auditor 只报问题，Repair 只改问题。

6. **修复用 patch，不整段重写**  
   patch 必须可定位、可验证、可回滚。

7. **长上下文切换文件模式**  
   短任务用 chat，长任务用 Agent workspace 文件输入输出。

8. **应用层管理状态，Skill 管理方法**  
   Skill 只告诉智能体怎么做，状态、缓存、恢复、导出仍应由系统实现。

