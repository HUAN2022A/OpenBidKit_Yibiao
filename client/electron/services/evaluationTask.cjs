const crypto = require('node:crypto');
const { compactLogError, createNoopDeveloperLogger, textMetrics } = require('../utils/developerLog.cjs');
const { splitUserTextByContextLimit } = require('../utils/userTextSplitter.cjs');

// 标书正文分段打分时的上下文占用比例（复用 rejectionCheckTask.cjs 的滚动思路）。
const documentSegmentLimitRatio = 0.55;
const evidencePartEvidenceLimit = 600;
const evidencePartReasonLimit = 300;
const maxEvidenceParts = 40;
const maxLogEntries = 100;

function now() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function truncatePromptText(value, maxLength) {
  const text = normalizeText(value);
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function getArrayPayload(parsed, keys) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  return [];
}

function getCurrentAiConfig(aiService) {
  try {
    return typeof aiService?.getConfig === 'function' ? aiService.getConfig() : {};
  } catch {
    return {};
  }
}

function shouldUseSegmentedDocument(aiService, documentContent, limitRatio = documentSegmentLimitRatio) {
  const config = getCurrentAiConfig(aiService);
  return splitUserTextByContextLimit(documentContent, config, { limitRatio }).length > 1;
}

function createEvaluationDeveloperLogger(aiService, name, meta = {}) {
  try {
    return aiService?.createDeveloperLogger?.('evaluation', { name, meta }) || createNoopDeveloperLogger();
  } catch {
    return createNoopDeveloperLogger();
  }
}

async function runText(aiService, request, _onProgress, label) {
  const content = await aiService.chat({
    ...request,
    logTitle: request.logTitle || request.log_title || label,
  });
  if (!content.trim()) {
    throw new Error(`${label}未返回内容`);
  }
  return content;
}

async function runJson(aiService, request, onProgress, label) {
  const jsonRequest = {
    ...request,
    response_format: request.response_format || { type: 'json_object' },
    progressCallback: request.progressCallback || onProgress,
    logTitle: request.logTitle || request.log_title || request.progressLabel || label,
  };
  return aiService.collectJsonResponse ? aiService.collectJsonResponse(jsonRequest) : aiService.requestJson(jsonRequest);
}

// 从评分项原文里提取“权重/分值”。提取不到时默认 100，并用 warning 日志说明。
function extractMaxScore(item, developerLogger) {
  const rawCandidates = [
    item.maxScore, item.max_score, item.fullScore, item.full_score,
    item.weight, item.points, item.score, item.分值, item.分数, item.权重,
  ]
    .map((value) => (value === undefined || value === null ? '' : String(value).trim()))
    .filter(Boolean);
  for (const raw of rawCandidates) {
    const number = parseNumberFromText(raw);
    if (number > 0) return number;
  }
  const fallbackText = [item.criteria, item.description, item.standard, item.requirement, item.name]
    .map((value) => String(value || ''))
    .join(' ');
  const fromText = parseNumberFromText(fallbackText);
  if (fromText > 0) return fromText;
  developerLogger.write('evaluation.scoring_item.max_score_defaulted', {
    name: normalizeText(item.name || item.title || item.item),
    default: 100,
    warning: '未从评分标准中提取到分值，按默认满分 100 处理',
  });
  return 100;
}

function parseNumberFromText(value) {
  const text = String(value || '').trim();
  const match = text.match(/(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function clampScore(value, maxScore) {
  const max = Number.isFinite(maxScore) && maxScore > 0 ? maxScore : 0;
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(max, Math.round(number * 100) / 100));
}

function normalizeScoringItems(parsed, developerLogger) {
  return getArrayPayload(parsed, ['items', 'scoringItems', 'scoring_items'])
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const name = normalizeText(item.name || item.title || item.item || item.itemName || item.item_name);
      if (!name) return null;
      return {
        id: createId('evaluation_item'),
        name: name.slice(0, 100),
        maxScore: extractMaxScore(item, developerLogger),
        criteria: normalizeText(item.criteria || item.standard || item.requirement || item.description) || '未明确评分标准，请结合招标文件人工复核。',
      };
    })
    .filter(Boolean);
}

function normalizeScoreItemPayload(parsed, maxScore) {
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  return {
    score: clampScore(source.score ?? source.points ?? source.grade, maxScore),
    evidence: normalizeText(source.evidence || source.originalText || source.original_text || source.excerpt) || '未提供明确标书证据。',
    deductionReason: normalizeText(source.deductionReason || source.deduction_reason || source.reason || source.riskReason) || '未说明扣分/得分理由。',
    suggestion: normalizeText(source.suggestion || source.recommendation) || '请结合评分标准对标书相应章节进行优化。',
  };
}

function normalizeOverallComment(parsed) {
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  return normalizeText(source.overallComment || source.overall_comment || source.comment)
    || '本次评标完成，请结合评分明细逐项优化标书。';
}

function buildScoringItemsMessages(scoringItemsContent) {
  return [
    {
      role: 'user',
      content: `【AI评标｜评分项拆解】
以下内容来自招标文件“技术评分项/技术评分要求”解析结果。请从中拆解出所有可量化、可打分的评分项。

${scoringItemsContent}

输出要求：
1. name 是评分项名称，简洁明确。
2. maxScore 是该项满分分值，从“权重/分值”中提取为数值；确实提取不到时填 100。
3. criteria 是该评分项的评分标准原文或概括。

JSON 格式：{"items":[{"name":"评分项名称","maxScore":100,"criteria":"评分标准"}]}

仅输出 JSON，不要输出 Markdown、代码块或解释。`,
    },
  ];
}

function buildSingleScoringMessages(item, documentContent) {
  return [
    {
      role: 'user',
      content: `【AI评标｜逐项打分】
评分项：${item.name}
满分：${item.maxScore}
评分标准：${item.criteria}

标书正文：
${documentContent}

请基于标书正文对该评分项打分，score 为 0 到 ${item.maxScore} 之间的数值。

JSON 格式：{"score":85,"evidence":"标书原文证据","deductionReason":"扣分/得分理由","suggestion":"改进建议"}

仅输出 JSON，不要输出 Markdown、代码块或解释。`,
    },
  ];
}

function buildSegmentEvidenceMessages(item, segmentContent, segmentIndex, totalSegments) {
  return [
    {
      role: 'user',
      content: `【AI评标｜标书分段审阅】
评分项：${item.name}
满分：${item.maxScore}
评分标准：${item.criteria}

标书正文片段：第 ${segmentIndex}/${totalSegments} 段
${segmentContent}

请从该片段中提取与本评分项相关的证据，并给出针对该片段的得分/扣分依据。若该片段与本评分项无关，evidence 填“无相关内容”。

JSON 格式：{"score":0,"evidence":"该片段中与本评分项相关的原文证据","deductionReason":"针对该片段的得分/扣分依据","suggestion":"改进建议"}

仅输出 JSON，不要输出 Markdown、代码块或解释。`,
    },
  ];
}

function buildFinalScoringMessages(item, evidenceParts) {
  const relevant = evidenceParts.filter((part) => part && part.evidence !== '无相关内容');
  const parts = (relevant.length ? relevant : evidenceParts).slice(0, maxEvidenceParts);
  const summary = parts
    .map((part, index) => `片段${index + 1}：证据：${part.evidence}｜依据：${part.deductionReason}｜建议：${part.suggestion}`)
    .join('\n');
  return [
    {
      role: 'user',
      content: `【AI评标｜评分项定稿】
评分项：${item.name}
满分：${item.maxScore}
评分标准：${item.criteria}

以下是标书各片段中与本评分项相关的证据汇总：
${summary}

请综合上述证据对该评分项给出最终打分，score 为 0 到 ${item.maxScore} 之间的数值。

JSON 格式：{"score":85,"evidence":"标书原文证据","deductionReason":"扣分/得分理由","suggestion":"改进建议"}

仅输出 JSON，不要输出 Markdown、代码块或解释。`,
    },
  ];
}

function buildOverallMessages(items) {
  const lines = items.map((item) => `- ${item.name}：${item.score}/${item.maxScore}（证据：${truncatePromptText(item.evidence, 200)}；理由：${truncatePromptText(item.deductionReason, 200)}）`);
  return [
    {
      role: 'user',
      content: `【AI评标｜总体评语】
以下是本次评标的评分明细（总分由程序确定性求和，你只需输出总体评语，不要重复计算总分）。

${lines.join('\n')}

请给出总体评语，概括标书整体水平、主要优势与不足。

JSON 格式：{"overallComment":"总体评语"}

仅输出 JSON，不要输出 Markdown、代码块或解释。`,
    },
  ];
}

async function runScoringItemsExtraction(aiService, input, onProgress, developerLogger) {
  onProgress('正在拆解评分项。');
  const payload = await runJson(aiService, {
    messages: buildScoringItemsMessages(input.scoringItemsContent),
    schemaName: 'EvaluationScoringItems',
    progressLabel: '评分项拆解',
    failureMessage: '评分项拆解结果格式无效，请重新检查',
  }, onProgress, '评分项拆解');
  return normalizeScoringItems(payload, developerLogger);
}

async function runSegmentedItemScoring(aiService, item, documentContent, onProgress) {
  const config = getCurrentAiConfig(aiService);
  const segments = splitUserTextByContextLimit(documentContent, config, { limitRatio: documentSegmentLimitRatio });
  const evidenceParts = [];
  for (const [index, segment] of segments.entries()) {
    onProgress(`正在审阅标书第 ${index + 1}/${segments.length} 段。`);
    const payload = await runJson(aiService, {
      messages: buildSegmentEvidenceMessages(item, segment, index + 1, segments.length),
      schemaName: 'EvaluationScoreItem',
      progressLabel: `评分项「${item.name}」标书分段审阅`,
      failureMessage: '评分项标书分段审阅结果格式无效，请重新检查',
    }, onProgress, `评分项「${item.name}」标书分段审阅`);
    const normalized = normalizeScoreItemPayload(payload, item.maxScore);
    evidenceParts.push({
      ...normalized,
      evidence: truncatePromptText(normalized.evidence, evidencePartEvidenceLimit),
      deductionReason: truncatePromptText(normalized.deductionReason, evidencePartReasonLimit),
    });
  }
  onProgress(`正在汇总评分项「${item.name}」得分。`);
  const payload = await runJson(aiService, {
    messages: buildFinalScoringMessages(item, evidenceParts),
    schemaName: 'EvaluationScoreItem',
    progressLabel: `评分项「${item.name}」打分`,
    failureMessage: '评分项打分结果格式无效，请重新检查',
  }, onProgress, `评分项「${item.name}」打分`);
  return normalizeScoreItemPayload(payload, item.maxScore);
}

async function runScoreItem(aiService, item, documentContent, onProgress) {
  if (shouldUseSegmentedDocument(aiService, documentContent)) {
    return runSegmentedItemScoring(aiService, item, documentContent, onProgress);
  }
  onProgress(`正在为评分项「${item.name}」打分。`);
  const payload = await runJson(aiService, {
    messages: buildSingleScoringMessages(item, documentContent),
    schemaName: 'EvaluationScoreItem',
    progressLabel: `评分项「${item.name}」打分`,
    failureMessage: '评分项打分结果格式无效，请重新检查',
  }, onProgress, `评分项「${item.name}」打分`);
  return normalizeScoreItemPayload(payload, item.maxScore);
}

async function runOverallComment(aiService, items, onProgress) {
  onProgress('正在生成总体评语。');
  const payload = await runJson(aiService, {
    messages: buildOverallMessages(items),
    schemaName: 'EvaluationOverall',
    progressLabel: '总体评语',
    failureMessage: '总体评语格式无效，请重新检查',
  }, onProgress, '总体评语');
  return normalizeOverallComment(payload);
}

function createResultItems(scoringItems, scoreMap) {
  return scoringItems.map((item) => {
    const scored = scoreMap.get(item.id) || {};
    return {
      id: item.id,
      name: item.name,
      maxScore: item.maxScore,
      score: scored.score ?? 0,
      criteria: item.criteria,
      evidence: scored.evidence || '',
      deductionReason: scored.deductionReason || '',
      suggestion: scored.suggestion || '',
    };
  });
}

async function runEvaluationTask({ aiService, workspaceStore, updateTask, checkpointTask, payload, previousState }) {
  const state = {
    ...(previousState || {}),
    ...(payload?.workspaceState || {}),
  };

  if (typeof workspaceStore.createEvaluationInputSignature !== 'function') {
    throw new Error('AI评标存储接口尚未初始化');
  }

  const technicalPlanDocument = state.technicalPlanDocument || null;
  const documentContent = String(technicalPlanDocument?.content || '').trim();
  const scoringItemsContent = String(state.scoringItems?.content || '').trim();
  if (!scoringItemsContent) throw new Error('缺少评分标准，请先从技术方案导入评分标准');
  if (!documentContent) throw new Error('缺少标书正文，请先从技术方案导入标书正文');

  const inputSignature = String(workspaceStore.createEvaluationInputSignature(technicalPlanDocument, scoringItemsContent) || '');
  if (!inputSignature) throw new Error('评分输入签名缺失，请先从技术方案导入评分标准与正文');

  const developerLogger = createEvaluationDeveloperLogger(aiService, 'evaluation-run', {
    input_signature: inputSignature,
  });
  developerLogger.write('evaluation.run.started', {
    input_signature: inputSignature,
    scoring_items_metrics: textMetrics(scoringItemsContent),
    document_metrics: textMetrics(documentContent),
  });

  let logs = ['开始AI评标。'];
  function addLog(message) {
    logs = [...logs, message].slice(-maxLogEntries);
    return logs;
  }

  checkpointTask({ status: 'running', progress: 5, logs }, {
    evaluationResult: {
      status: 'running',
      inputSignature,
      totalScore: 0,
      totalMaxScore: 0,
      scoreRate: 0,
      overallComment: '',
      items: [],
      activeItemId: undefined,
      progressMessage: '正在拆解评分项。',
      error: undefined,
      updatedAt: now(),
    },
  });

  try {
    // 第一步：评分项拆解。
    const scoringItems = await runScoringItemsExtraction(aiService, { scoringItemsContent }, (message) => {
      updateTask({ status: 'running', progress: 15, logs: addLog(`评分项拆解：${message}`) }, {
        evaluationResult: { status: 'running', inputSignature, progressMessage: message, updatedAt: now() },
      });
    }, developerLogger);
    if (!scoringItems.length) throw new Error('未从评分标准中拆解出评分项，请检查招标解析结果');
    developerLogger.write('evaluation.run.scoring_items_extracted', {
      input_signature: inputSignature,
      count: scoringItems.length,
    });
    checkpointTask({ status: 'running', progress: 20, logs: addLog(`已拆解出 ${scoringItems.length} 个评分项。`) }, {
      evaluationResult: {
        status: 'running',
        inputSignature,
        items: createResultItems(scoringItems, new Map()),
        progressMessage: `已拆解出 ${scoringItems.length} 个评分项，开始逐项打分。`,
        updatedAt: now(),
      },
    });

    // 第二步：逐项打分。
    const scoreMap = new Map();
    for (const [index, item] of scoringItems.entries()) {
      const progress = 20 + Math.round(((index + 1) / scoringItems.length) * 55);
      const scored = await runScoreItem(aiService, item, documentContent, (message) => {
        updateTask({ status: 'running', progress, logs: addLog(`评分项「${item.name}」：${message}`) }, {
          evaluationResult: {
            status: 'running',
            inputSignature,
            progressMessage: `正在打分：${item.name}（${index + 1}/${scoringItems.length}）${message ? `：${message}` : ''}`,
            updatedAt: now(),
          },
        });
      });
      scoreMap.set(item.id, scored);
      const itemsSoFar = createResultItems(scoringItems, scoreMap);
      checkpointTask({ status: 'running', progress, logs: addLog(`已完成评分项「${item.name}」打分（${scored.score}/${item.maxScore}）。`) }, {
        evaluationResult: {
          status: 'running',
          inputSignature,
          items: itemsSoFar,
          activeItemId: item.id,
          progressMessage: `已完成 ${index + 1}/${scoringItems.length} 项打分。`,
          updatedAt: now(),
        },
      });
    }

    // 第三步：汇总（总分由 Main 侧确定性求和，AI 只出总体评语）。
    const items = createResultItems(scoringItems, scoreMap);
    const totalScore = round2(items.reduce((sum, item) => sum + (Number(item.score) || 0), 0));
    const totalMaxScore = round2(items.reduce((sum, item) => sum + (Number(item.maxScore) || 0), 0));
    const scoreRate = totalMaxScore > 0 ? round4(totalScore / totalMaxScore) : 0;
    const overallComment = await runOverallComment(aiService, items, (message) => {
      updateTask({ status: 'running', progress: 90, logs: addLog(`汇总：${message}`) }, {
        evaluationResult: {
          status: 'running',
          inputSignature,
          items,
          totalScore,
          totalMaxScore,
          scoreRate,
          progressMessage: message,
          updatedAt: now(),
        },
      });
    });

    checkpointTask({ status: 'success', progress: 100, logs: addLog('AI评标完成。') }, {
      evaluationResult: {
        status: 'success',
        inputSignature,
        totalScore,
        totalMaxScore,
        scoreRate,
        overallComment,
        items,
        activeItemId: items[0]?.id,
        progressMessage: '评标完成。',
        error: undefined,
        updatedAt: now(),
      },
    });
    developerLogger.write('evaluation.run.completed', {
      input_signature: inputSignature,
      total_score: totalScore,
      total_max_score: totalMaxScore,
      score_rate: scoreRate,
      item_count: items.length,
    });
  } catch (error) {
    const message = error?.message || 'AI评标失败';
    developerLogger.write('evaluation.run.error', {
      input_signature: inputSignature,
      error: compactLogError(error),
    });
    checkpointTask({ status: 'error', progress: 100, logs: addLog(`AI评标失败：${message}`), error: message }, {
      evaluationResult: {
        status: 'error',
        inputSignature,
        error: message,
        progressMessage: message,
        updatedAt: now(),
      },
    });
  }
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function round4(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

module.exports = {
  runEvaluationTask,
};
