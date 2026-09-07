const { AI_QUEUE_SCOPE_PAUSED } = require('../utils/aiRequestQueue.cjs');

// 配图复用命中阈值：LLM 给出的把握程度达到该值才允许直接复用历史图。
const REUSE_CONFIDENCE_THRESHOLD = 0.8;
// L2 语义匹配时喂给 LLM 的历史图候选上限，控制单次调用的上下文开销。
const REUSE_CANDIDATE_LIMIT = 15;
// 小节正文进入提示词时的单节/合计截断上限。
const SECTION_CONTENT_MAX_CHARS = 1500;
const SECTIONS_CONTENT_MAX_CHARS = 3000;
const RESUME_MAX_CHARS = 200;
// 与 contentGenerationTask.cjs 中的暂停错误码保持一致，用于区分「任务暂停」与普通失败。
const CONTENT_GENERATION_PAUSED = 'CONTENT_GENERATION_PAUSED';
// 知识库图条目未归类时的兜底类型（与 knowledgeBaseService.IMAGE_TYPE_FALLBACK 一致）。
const UNCLASSIFIED_IMAGE_TYPE = '其他图';

// 配图类型同义词映射：plan item 的 image_type -> 知识库图条目 image_type 候选集合。
// 知识库图条目的 image_type 使用中文标签词汇表（工程图示/实景照片/流程图/层级图/职责关系图/其他图），
// 配图规划的 AI/Mermaid 类型是英文代码，HTML 类型是用户自定义中文类型（如「进度网络图」），
// 同一组内的类型互相等价，L1 收窄时一并纳入候选。
const IMAGE_TYPE_SYNONYM_GROUPS = [
  ['进度网络图', '里程碑计划图', '进度计划图', '甘特图', '施工进度图'],
  ['组织架构图', '组织结构图', '组织关系图', '机构设置图'],
  ['系统架构图', '总体架构图', '技术架构图', '体系架构图'],
  ['工程图示', 'engineering_diagram'],
  ['实景照片', 'realistic_photo'],
  ['流程图', 'process'],
  ['层级图', 'hierarchy'],
  ['职责关系图', 'responsibility'],
];

const IMAGE_TYPE_SYNONYMS = new Map();
for (const group of IMAGE_TYPE_SYNONYM_GROUPS) {
  for (const member of group) {
    IMAGE_TYPE_SYNONYMS.set(member, new Set(group));
  }
}

// 安全规则表：复用前规则先行扫描，命中即判定疑似含项目专有信息，禁止复用。
// 覆盖客户名/机构名、报价与金额数字、logo 与徽标、地址地点、联系方式、人名与职务、
// 旧项目名称与编号等常见模式；规则未覆盖的疑点由 L2 LLM 的 sensitive 字段兜底。
// 任何不确定情形默认禁止复用（宁可重新生成，不冒带入旧项目信息的风险）。
const SENSITIVE_RULE_PATTERNS = [
  {
    label: '客户名或机构名',
    pattern: /[一-龥]{2,25}(?:有限公司|有限责任公司|股份公司|股份有限公司|公司|集团|研究院|研究所|设计院|大学|学院|医院|银行|供电局|人民政府|管理局|委员会|事务所)/u,
  },
  {
    label: '报价或金额',
    pattern: /(?:报价|金额|价格|单价|总价|中标价|成交价|预算|概算|投资额|费用|\d+(?:\.\d+)?\s*[万亿]?\s*元)/u,
  },
  {
    label: 'logo 或徽标',
    pattern: /(?:logo|徽标|司标|标志图案|企业标志)/iu,
  },
  {
    label: '地址或地点',
    pattern: /(?:地址|大厦|园区|广场|写字楼|[路街巷]\d+号)/u,
  },
  {
    label: '联系方式',
    pattern: /(?:联系电话|联系方式|手机|电话|传真|邮箱|e-?mail)/iu,
  },
  {
    label: '人名或职务',
    pattern: /[一-龥]{2,4}(?:先生|女士|经理|主任|总监|工程师|局长|处长|教授|总工)/u,
  },
  {
    label: '旧项目名称或编号',
    pattern: /(?:项目名称|项目编号|招标编号|合同编号|标段编号)/u,
  },
];

function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(text, limit) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}

function isPauseLikeError(error) {
  return error?.code === AI_QUEUE_SCOPE_PAUSED || error?.code === CONTENT_GENERATION_PAUSED;
}

function resolveCandidateImageTypes(planImageType) {
  const normalized = singleLine(planImageType);
  if (!normalized) return new Set();
  const group = IMAGE_TYPE_SYNONYMS.get(normalized);
  return group ? new Set(group) : new Set([normalized]);
}

// L1 收窄：按 plan item 的 image_type 过滤知识库图条目（精确匹配 + 同义词映射）。
// 未归类条目（其他图）只在没有同类型/同义词候选时兜底参与匹配，避免类型收窄完全失效。
function collectCandidates(planItem, imageItems) {
  const planImageType = singleLine(planItem?.image_type);
  const allowedTypes = resolveCandidateImageTypes(planImageType);
  const ranked = [];
  for (const imageItem of Array.isArray(imageItems) ? imageItems : []) {
    const id = singleLine(imageItem?.id);
    const title = singleLine(imageItem?.title);
    const resume = singleLine(imageItem?.resume);
    const assetUrl = singleLine(imageItem?.asset_url);
    // 缺 id/title/asset_url 的条目无法被复用，直接排除。
    if (!id || !title || !assetUrl) continue;
    const imageType = singleLine(imageItem?.image_type);
    const rank = allowedTypes.has(imageType)
      ? (imageType === planImageType ? 0 : 1)
      : (!imageType || imageType === UNCLASSIFIED_IMAGE_TYPE ? 2 : -1);
    if (rank < 0) continue;
    ranked.push({
      rank,
      id,
      title,
      resume,
      asset_url: assetUrl,
      source_file: singleLine(imageItem?.source_file),
    });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const typed = ranked.filter((candidate) => candidate.rank < 2);
  const chosen = typed.length ? typed : ranked;
  return chosen.slice(0, REUSE_CANDIDATE_LIMIT);
}

function resolveSectionTexts(planItem, sections) {
  const ids = Array.isArray(planItem?.section_ids) ? planItem.section_ids : [];
  const parts = [];
  let total = 0;
  for (const id of ids) {
    const content = singleLine(sections?.[id]?.content);
    if (!content) continue;
    const remaining = SECTIONS_CONTENT_MAX_CHARS - total;
    if (remaining <= 0) break;
    const truncated = truncateText(content, Math.min(SECTION_CONTENT_MAX_CHARS, remaining));
    parts.push(`小节ID: ${id}\n${truncated}`);
    total += truncated.length;
  }
  return parts.join('\n\n');
}

function findSensitiveRuleHit(text) {
  const value = String(text || '');
  if (!value.trim()) return null;
  for (const rule of SENSITIVE_RULE_PATTERNS) {
    if (rule.pattern.test(value)) return rule;
  }
  return null;
}

function renderCandidatesForPrompt(candidates) {
  return candidates.map((candidate, index) => [
    `${index + 1}. 候选ID: ${candidate.id}`,
    `   标题: ${candidate.title}`,
    `   简介: ${truncateText(candidate.resume, RESUME_MAX_CHARS)}`,
  ].join('\n')).join('\n');
}

function buildReuseDecisionMessages({ planItem, sectionText, candidates }) {
  const imageType = singleLine(planItem?.image_type);
  const title = singleLine(planItem?.title);
  return [
    {
      role: 'system',
      content: `你是投标文件配图复用助手。请判断候选历史图条目中是否有适合直接复用、替换当前计划新生成图片的历史图。

要求：
1. 只返回 JSON，不要输出解释或 Markdown。
2. 只有当候选图与当前小节正文的主题、业务场景明显一致，且图类型相符时，才允许复用（reuse=true）。
3. 复用时 reuse_item_id 必须严格复制候选列表中的候选ID，不得编造；confidence 表示你对“该图可直接复用、无需修改”的把握程度，取值 0-1，拿不准时必须低于 0.8。
4. sensitive 表示该候选图是否疑似含有项目专有信息（旧客户名、报价数字、logo、地址地点、旧项目名称等），任何疑似都必须为 true；sensitive=true 时系统会拒绝复用。
5. 没有把握时宁可返回 reuse=false（系统会按原计划重新生成图片），不要冒险复用历史图。`,
    },
    {
      role: 'user',
      content: [
        '当前小节正文（拟配图的位置）：',
        sectionText,
        '',
        `计划配图信息：图类型「${imageType}」，图注标题「${title}」`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '候选历史图条目（只包含候选ID、标题和简介）：',
        renderCandidatesForPrompt(candidates),
      ].join('\n'),
    },
    {
      role: 'user',
      content: `请返回 JSON：
{ "reuse": true, "reuse_item_id": "候选ID", "confidence": 0.9, "sensitive": false }
或
{ "reuse": false, "sensitive": false }`,
    },
  ];
}

function normalizeReuseDecision(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const reuse = Boolean(source.reuse);
  return {
    reuse,
    reuse_item_id: reuse ? singleLine(source.reuse_item_id ?? source.reuseItemId) : '',
    confidence: reuse ? Number(source.confidence) : 0,
    sensitive: Boolean(source.sensitive ?? source.suspect_sensitive ?? source.contains_private_info),
  };
}

function validateReuseDecision(decision, candidateIds) {
  if (!decision.reuse) return;
  if (!decision.reuse_item_id) throw new Error('reuse_item_id 不能为空');
  if (!candidateIds.has(decision.reuse_item_id)) {
    throw new Error(`reuse_item_id 不在候选列表中：${decision.reuse_item_id}`);
  }
  if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
    throw new Error('confidence 必须是 0-1 的数字');
  }
}

// 每个 plan item 一次 LLM 调用：把「当前小节正文 + 计划图类型」与收窄后的候选图条目列表
// 打包进同一次调用，让 LLM 选出 top-1；不做逐候选调用。
async function matchOneCandidate(planItem, sectionText, candidates, aiService) {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  return aiService.collectJsonResponse({
    messages: buildReuseDecisionMessages({ planItem, sectionText, candidates }),
    logTitle: `配图复用-${singleLine(planItem?.item_id)}-${singleLine(planItem?.title) || '未命名配图'}`,
    progressLabel: '配图复用检索',
    failureMessage: '模型返回的配图复用判定格式无效',
    normalizer: normalizeReuseDecision,
    validator: (decision) => validateReuseDecision(decision, candidateIds),
  });
}

/**
 * 在全文图片编排 plan 产出后检索知识库历史相似图。
 * 命中（confidence >= 阈值）且通过安全校验的 plan item 会被原地打上
 * reuse_source = { item_id, asset_url, confidence }；否则不改动 plan item，走原有生成流程。
 * LLM 调用失败按未命中处理，不中断配图规划；任务暂停类错误原样抛出。
 */
async function retrieveSimilarIllustrations({ planItems, sections, imageItems, aiService, log = () => {} }) {
  const items = Array.isArray(planItems) ? planItems : [];
  const stats = { total: items.length, reused: 0, missed: 0 };
  if (!items.length) return stats;
  const availableImages = Array.isArray(imageItems) ? imageItems : [];
  if (!availableImages.length) {
    log('知识库无可用图条目，跳过配图复用检索。');
    return stats;
  }

  for (const planItem of items) {
    const label = `${singleLine(planItem?.item_id)}（${singleLine(planItem?.title) || '未命名配图'}）`;

    // 规则先行：所在小节正文疑似含项目专有信息时直接禁止复用，不再进入语义匹配。
    const sectionText = resolveSectionTexts(planItem, sections);
    if (!sectionText) {
      stats.missed += 1;
      log(`配图复用：${label} 未取到小节正文，按原计划生成。`);
      continue;
    }
    const sectionHit = findSensitiveRuleHit(sectionText);
    if (sectionHit) {
      stats.missed += 1;
      log(`配图复用：${label} 所在小节正文疑似含${sectionHit.label}，禁止复用，按原计划生成。`);
      continue;
    }

    // L1 收窄，并对候选图 title/resume 执行规则扫描，命中规则的候选不可复用。
    const candidates = collectCandidates(planItem, availableImages);
    if (!candidates.length) {
      stats.missed += 1;
      log(`配图复用：${label} 无同类型历史图候选，按原计划生成。`);
      continue;
    }
    const cleanCandidates = candidates.filter((candidate) => !findSensitiveRuleHit(`${candidate.title} ${candidate.resume}`));
    if (!cleanCandidates.length) {
      stats.missed += 1;
      log(`配图复用：${label} 历史图候选均疑似含项目专有信息，禁止复用，按原计划生成。`);
      continue;
    }

    // L2 语义匹配 + LLM 兜底安全校验。
    try {
      const decision = await matchOneCandidate(planItem, sectionText, cleanCandidates, aiService);
      if (!decision.reuse) {
        stats.missed += 1;
        log(`配图复用：${label} 未找到语义匹配的历史图，按原计划生成。`);
      } else if (decision.sensitive) {
        stats.missed += 1;
        log(`配图复用：${label} 候选历史图疑似含项目专有信息，禁止复用，按原计划生成。`);
      } else if (!(decision.confidence >= REUSE_CONFIDENCE_THRESHOLD)) {
        stats.missed += 1;
        log(`配图复用：${label} 候选历史图复用把握不足（confidence ${decision.confidence}），按原计划生成。`);
      } else {
        const candidate = cleanCandidates.find((entry) => entry.id === decision.reuse_item_id);
        planItem.reuse_source = {
          item_id: candidate.id,
          asset_url: candidate.asset_url,
          confidence: decision.confidence,
        };
        stats.reused += 1;
        log(`配图复用：${label} 命中历史图 ${candidate.id}（confidence ${decision.confidence}），将直接复用。`);
      }
    } catch (error) {
      if (isPauseLikeError(error)) throw error;
      stats.missed += 1;
      log(`配图复用：${label} 检索失败（${error?.message || String(error)}），按原计划生成。`);
    }
  }

  log(`配图复用检索完成：共 ${stats.total} 项，命中复用 ${stats.reused} 项，按原计划生成 ${stats.missed} 项。`);
  return stats;
}

module.exports = {
  REUSE_CONFIDENCE_THRESHOLD,
  retrieveSimilarIllustrations,
};
