const { compactLogError, createNoopDeveloperLogger, textMetrics } = require('../utils/developerLog.cjs');

const maxLogEntries = 100;

function now() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function getArrayPayload(parsed, keys) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  return [];
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number * 100) / 100));
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function createBidOpportunityDeveloperLogger(aiService, name, meta = {}) {
  try {
    return aiService?.createDeveloperLogger?.('bid-opportunity', { name, meta }) || createNoopDeveloperLogger();
  } catch {
    return createNoopDeveloperLogger();
  }
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

function buildParseMessages(rawText) {
  return [
    {
      role: 'user',
      content: `【投标机会｜招标公告解析】
以下是一份招标公告/招标文件的原文。请从中提取结构化信息。

${rawText}

请提取以下字段（缺失时填空字符串）：
1. projectName：项目名称
2. tenderer：招标人/采购人
3. budget：预算金额或预算口径
4. region：实施地区/交货地点
5. deadline：截标/开标时间
6. qualificationRequirements：投标人资质要求
7. performanceRequirements：业绩或类似项目要求
8. scoringMethod：评标办法/评分规则

JSON 格式：{"projectName":"...","tenderer":"...","budget":"...","region":"...","deadline":"...","qualificationRequirements":"...","performanceRequirements":"...","scoringMethod":"..."}

仅输出 JSON，不要输出 Markdown、代码块或解释。`,
    },
  ];
}

function buildScoreMessages(structured, enterprise, qualifications, performances) {
  const qualificationLines = qualifications.length
    ? qualifications.map((item, index) => `${index + 1}. ${item.name}${item.level ? `（${item.level}）` : ''}${item.certNo ? `｜证书号 ${item.certNo}` : ''}${item.validUntil ? `｜有效期至 ${item.validUntil}` : ''}`).join('\n')
    : '（未填写资质）';
  const performanceLines = performances.length
    ? performances.map((item, index) => `${index + 1}. ${item.projectName}${item.industry ? `｜行业 ${item.industry}` : ''}${item.region ? `｜地区 ${item.region}` : ''}${item.amount ? `｜金额 ${item.amount}` : ''}${item.description ? `｜${item.description}` : ''}`).join('\n')
    : '（未填写业绩）';

  return [
    {
      role: 'user',
      content: `【投标机会｜匹配评分】
请基于以下「招标公告结构化信息」与「本企业画像」，判断该机会是否值得投入标书资源，并逐维度打分。

一、招标公告结构化信息：
- 项目名称：${structured.projectName || '未知'}
- 招标人：${structured.tenderer || '未知'}
- 预算：${structured.budget || '未知'}
- 地区：${structured.region || '未知'}
- 截标时间：${structured.deadline || '未知'}
- 资质要求：${structured.qualificationRequirements || '未明确'}
- 业绩要求：${structured.performanceRequirements || '未明确'}
- 评标办法：${structured.scoringMethod || '未明确'}

二、本企业画像：
- 企业名称：${enterprise.companyName || '未填写'}
- 主营行业：${enterprise.industry || '未填写'}
- 优势区域：${(enterprise.regions || []).join('、') || '未填写'}
- 企业优势：${enterprise.strengths || '未填写'}

三、资质证书：
${qualificationLines}

四、历史业绩：
${performanceLines}

请从以下六个维度打分（score 为 0 到 100 的数值，100 代表最有利于本企业投标）：
1. key=qualification，label=资质匹配，note=匹配或不匹配的具体说明
2. key=performance，label=业绩匹配，note=类似业绩的匹配程度说明
3. key=region，label=区域匹配，note=地区/交付能力匹配说明
4. key=budget，label=预算规模，note=预算规模与本企业承接能力匹配说明
5. key=competition，label=竞争强度，note=竞争激烈程度与中标难度判断
6. key=time，label=时间充裕度，note=截标时间是否足够编制标书

并给出：
- recommendation：投/不投/需评估的结论，取值 bid（建议投）/ skip（不建议投）/ evaluate（需评估）
- analysis：总体投标建议（Markdown，含主要优势、主要风险、下一步建议）

JSON 格式：{"dimensions":[{"key":"qualification","label":"资质匹配","score":80,"note":"..."}],"recommendation":"bid","analysis":"..."}

仅输出 JSON，不要输出 Markdown 代码块或解释。`,
    },
  ];
}

function normalizeParsePayload(parsed) {
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  return {
    projectName: normalizeText(source.projectName || source.project_name),
    tenderer: normalizeText(source.tenderer),
    budget: normalizeText(source.budget),
    region: normalizeText(source.region),
    deadline: normalizeText(source.deadline),
    qualificationRequirements: normalizeText(source.qualificationRequirements || source.qualification_requirements),
    performanceRequirements: normalizeText(source.performanceRequirements || source.performance_requirements),
    scoringMethod: normalizeText(source.scoringMethod || source.scoring_method),
  };
}

function normalizeScorePayload(parsed) {
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const dimensions = getArrayPayload(source, ['dimensions', 'items'])
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      key: normalizeText(item.key),
      label: normalizeText(item.label) || normalizeText(item.key),
      score: clampScore(item.score ?? item.points ?? item.grade),
      note: normalizeText(item.note || item.reason || item.explanation),
    }))
    .filter((item) => item.key && item.label);
  const recommendation = ['bid', 'evaluate', 'skip'].includes(source.recommendation) ? source.recommendation : 'evaluate';
  return {
    dimensions,
    recommendation,
    analysis: normalizeText(source.analysis) || '暂未生成投标建议。',
  };
}

function buildPricePredictionMessages(structured, enterprise, qualifications, performances) {
  const qualificationLines = qualifications.length
    ? qualifications.map((item, index) => `${index + 1}. ${item.name}${item.level ? `（${item.level}）` : ''}${item.certNo ? `｜证书号 ${item.certNo}` : ''}${item.validUntil ? `｜有效期至 ${item.validUntil}` : ''}`).join('\n')
    : '（未填写资质）';
  const performanceLines = performances.length
    ? performances.map((item, index) => `${index + 1}. ${item.projectName}${item.industry ? `｜行业 ${item.industry}` : ''}${item.region ? `｜地区 ${item.region}` : ''}${item.amount ? `｜金额 ${item.amount}` : ''}${item.description ? `｜${item.description}` : ''}`).join('\n')
    : '（未填写业绩）';

  return [
    {
      role: 'user',
      content: `【投标机会｜报价预测】
请基于以下「招标公告结构化信息」与「本企业画像」，推断本次投标的潜在竞争对手及其可能报价，并给出我方报价建议。

一、招标公告结构化信息：
- 项目名称：${structured.projectName || '未知'}
- 招标人：${structured.tenderer || '未知'}
- 预算/控制价：${structured.budget || '未明确'}
- 地区：${structured.region || '未知'}
- 截标时间：${structured.deadline || '未知'}
- 资质要求：${structured.qualificationRequirements || '未明确'}
- 业绩要求：${structured.performanceRequirements || '未明确'}
- 评标办法：${structured.scoringMethod || '未明确'}

二、本企业画像：
- 企业名称：${enterprise.companyName || '未填写'}
- 主营行业：${enterprise.industry || '未填写'}
- 优势区域：${(enterprise.regions || []).join('、') || '未填写'}
- 企业优势：${enterprise.strengths || '未填写'}

三、资质证书：
${qualificationLines}

四、历史业绩：
${performanceLines}

JSON 格式：{"competitors":[{"name":"推断的竞争对手名称或泛称","confidence":"high","predictedPrice":"预测报价","predictedPriceRange":"预测报价区间","rationale":"推断理由"}],"recommendedPrice":"我方建议报价","recommendedPriceRange":"我方建议报价区间","strategy":"报价策略说明","winProbability":"中标概率估计","overallComment":"总体说明"}

要求：
1. 这是基于公告与行业常识的参考性估算，非真实竞对数据；预算/控制价缺失或无法推断时，如实标注不确定，不要编造精确数字。
2. confidence 表示该对手参与竞标且报价判断的把握度，取值 high（高）/ medium（中）/ low（低）。
3. recommendedPrice 与 strategy 需结合「预算/控制价 + 评标办法（最低价中标/综合评分等）+ 竞争对手预测」给出可操作的报价建议。

仅输出 JSON，不要输出 Markdown、代码块或解释。`,
    },
  ];
}

function normalizePricePredictionPayload(parsed) {
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const competitors = getArrayPayload(source, ['competitors', 'items'])
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item, index) => ({
      id: `competitor-${index + 1}`,
      name: normalizeText(item.name || item.company || item.companyName || item.company_name),
      confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'medium',
      predictedPrice: normalizeText(item.predictedPrice || item.predicted_price || item.price),
      predictedPriceRange: normalizeText(item.predictedPriceRange || item.predicted_price_range || item.priceRange || item.price_range),
      rationale: normalizeText(item.rationale || item.reason || item.explanation),
    }))
    .filter((item) => item.name);
  return {
    recommendedPrice: normalizeText(source.recommendedPrice || source.recommended_price),
    recommendedPriceRange: normalizeText(source.recommendedPriceRange || source.recommended_price_range),
    strategy: normalizeText(source.strategy),
    winProbability: normalizeText(source.winProbability || source.win_probability || source.probability),
    competitors,
    overallComment: normalizeText(source.overallComment || source.overall_comment || source.comment),
  };
}

function checkpointOpportunity(checkpointTask, workspaceStore, taskPartial, opportunityId, patch) {
  const fresh = Array.isArray(workspaceStore.loadOpportunities?.()) ? workspaceStore.loadOpportunities() : [];
  const nextOpportunities = fresh.map((item) => (
    item.id === opportunityId ? { ...item, ...patch } : item
  ));
  return checkpointTask(taskPartial, { opportunities: nextOpportunities });
}

function resolveActiveOpportunity(state, payload) {
  const opportunities = Array.isArray(state.opportunities) ? state.opportunities : [];
  const activeId = state.activeOpportunityId || payload?.opportunityId || opportunities[0]?.id;
  return opportunities.find((item) => item.id === activeId) || opportunities[0] || null;
}

async function runBidOpportunityParseTask({ aiService, workspaceStore, updateTask, checkpointTask, payload, previousState }) {
  const state = { ...(previousState || {}), ...(payload?.workspaceState || {}) };
  const active = resolveActiveOpportunity(state, payload);
  if (!active) throw new Error('缺少待解析的公告，请先导入或新建公告');
  if (typeof workspaceStore.readAnnouncementMarkdown !== 'function') {
    throw new Error('投标机会存储接口尚未初始化');
  }

  const rawText = normalizeText(workspaceStore.readAnnouncementMarkdown(active.id));
  if (!rawText) throw new Error('公告正文为空，请重新导入公告');

  const developerLogger = createBidOpportunityDeveloperLogger(aiService, 'bid-opportunity-parse', {
    opportunity_id: active.id,
  });
  developerLogger.write('bid-opportunity.parse.started', {
    opportunity_id: active.id,
    raw_metrics: textMetrics(rawText),
  });

  let logs = ['开始公告解析。'];
  function addLog(message) {
    logs = [...logs, message].slice(-maxLogEntries);
    return logs;
  }

  checkpointOpportunity(checkpointTask, workspaceStore, { status: 'running', progress: 10, logs }, active.id, { parseStatus: 'running' });

  try {
    updateTask({ status: 'running', progress: 40, logs: addLog('正在提取结构化字段。') });
    const payloadResult = await runJson(aiService, {
      messages: buildParseMessages(rawText),
      schemaName: 'BidOpportunityStructured',
      progressLabel: '公告解析',
      failureMessage: '公告解析结果格式无效，请重新检查',
    }, (message) => {
      updateTask({ status: 'running', progress: 60, logs: addLog(`公告解析：${message}`) });
    }, '公告解析');
    const structured = normalizeParsePayload(payloadResult);
    developerLogger.write('bid-opportunity.parse.completed', {
      opportunity_id: active.id,
      has_project_name: Boolean(structured.projectName),
    });

    checkpointOpportunity(checkpointTask, workspaceStore, { status: 'success', progress: 100, logs: addLog('公告解析完成。') }, active.id, {
      parseStatus: 'success',
      structured,
      title: structured.projectName || active.title,
      tenderer: structured.tenderer,
      region: structured.region,
      budgetText: structured.budget,
      deadlineText: structured.deadline,
    });
  } catch (error) {
    const message = error?.message || '公告解析失败';
    developerLogger.write('bid-opportunity.parse.error', {
      opportunity_id: active.id,
      error: compactLogError(error),
    });
    checkpointOpportunity(checkpointTask, workspaceStore, { status: 'error', progress: 100, logs: addLog(`公告解析失败：${message}`), error: message }, active.id, { parseStatus: 'error' });
  }
}

async function runBidOpportunityScoreTask({ aiService, workspaceStore, updateTask, checkpointTask, payload, previousState }) {
  const state = { ...(previousState || {}), ...(payload?.workspaceState || {}) };
  const active = resolveActiveOpportunity(state, payload);
  if (!active) throw new Error('缺少待评分的机会');
  if (!active.structured) throw new Error('请先完成公告解析再进行匹配评分');

  const enterprise = state.enterprise || {};
  const qualifications = Array.isArray(state.qualifications) ? state.qualifications : [];
  const performances = Array.isArray(state.performances) ? state.performances : [];

  const developerLogger = createBidOpportunityDeveloperLogger(aiService, 'bid-opportunity-score', {
    opportunity_id: active.id,
  });
  developerLogger.write('bid-opportunity.score.started', {
    opportunity_id: active.id,
    qualification_count: qualifications.length,
    performance_count: performances.length,
  });

  let logs = ['开始匹配评分。'];
  function addLog(message) {
    logs = [...logs, message].slice(-maxLogEntries);
    return logs;
  }

  checkpointOpportunity(checkpointTask, workspaceStore, { status: 'running', progress: 10, logs }, active.id, {
    score: active.score ? { ...active.score } : null,
  });

  try {
    updateTask({ status: 'running', progress: 40, logs: addLog('正在逐维度匹配打分。') });
    const payloadResult = await runJson(aiService, {
      messages: buildScoreMessages(active.structured, enterprise, qualifications, performances),
      schemaName: 'BidOpportunityScore',
      progressLabel: '匹配评分',
      failureMessage: '匹配评分结果格式无效，请重新检查',
    }, (message) => {
      updateTask({ status: 'running', progress: 70, logs: addLog(`匹配评分：${message}`) });
    }, '匹配评分');
    const normalized = normalizeScorePayload(payloadResult);
    const totalScore = normalized.dimensions.length
      ? round2(normalized.dimensions.reduce((sum, item) => sum + item.score, 0) / normalized.dimensions.length)
      : 0;

    developerLogger.write('bid-opportunity.score.completed', {
      opportunity_id: active.id,
      total_score: totalScore,
      dimension_count: normalized.dimensions.length,
      recommendation: normalized.recommendation,
    });

    checkpointOpportunity(checkpointTask, workspaceStore, { status: 'success', progress: 100, logs: addLog('匹配评分完成。') }, active.id, {
      score: { dimensions: normalized.dimensions, totalScore },
      recommendation: normalized.recommendation,
      analysisText: normalized.analysis,
    });
  } catch (error) {
    const message = error?.message || '匹配评分失败';
    developerLogger.write('bid-opportunity.score.error', {
      opportunity_id: active.id,
      error: compactLogError(error),
    });
    checkpointTask({ status: 'error', progress: 100, logs: addLog(`匹配评分失败：${message}`), error: message });
  }
}

async function runBidOpportunityPriceTask({ aiService, workspaceStore, updateTask, checkpointTask, payload, previousState }) {
  const state = { ...(previousState || {}), ...(payload?.workspaceState || {}) };
  const active = resolveActiveOpportunity(state, payload);
  if (!active) throw new Error('缺少待预测的机会');
  if (!active.structured) throw new Error('请先完成公告解析再进行报价预测');

  const enterprise = state.enterprise || {};
  const qualifications = Array.isArray(state.qualifications) ? state.qualifications : [];
  const performances = Array.isArray(state.performances) ? state.performances : [];

  const developerLogger = createBidOpportunityDeveloperLogger(aiService, 'bid-opportunity-price', {
    opportunity_id: active.id,
  });
  developerLogger.write('bid-opportunity.price.started', {
    opportunity_id: active.id,
    has_budget: Boolean(active.structured.budget),
    scoring_method: active.structured.scoringMethod || '',
  });

  let logs = ['开始报价预测。'];
  function addLog(message) {
    logs = [...logs, message].slice(-maxLogEntries);
    return logs;
  }

  checkpointOpportunity(checkpointTask, workspaceStore, { status: 'running', progress: 10, logs }, active.id, {
    pricePrediction: active.pricePrediction ? { ...active.pricePrediction } : null,
  });

  try {
    updateTask({ status: 'running', progress: 40, logs: addLog('正在推断竞争对手与报价。') });
    const payloadResult = await runJson(aiService, {
      messages: buildPricePredictionMessages(active.structured, enterprise, qualifications, performances),
      schemaName: 'BidOpportunityPricePrediction',
      progressLabel: '报价预测',
      failureMessage: '报价预测结果格式无效，请重新检查',
    }, (message) => {
      updateTask({ status: 'running', progress: 70, logs: addLog(`报价预测：${message}`) });
    }, '报价预测');
    const normalized = normalizePricePredictionPayload(payloadResult);

    developerLogger.write('bid-opportunity.price.completed', {
      opportunity_id: active.id,
      competitor_count: normalized.competitors.length,
      has_recommended_price: Boolean(normalized.recommendedPrice),
    });

    checkpointOpportunity(checkpointTask, workspaceStore, { status: 'success', progress: 100, logs: addLog('报价预测完成。') }, active.id, {
      pricePrediction: { status: 'success', ...normalized, updatedAt: now() },
    });
  } catch (error) {
    const message = error?.message || '报价预测失败';
    developerLogger.write('bid-opportunity.price.error', {
      opportunity_id: active.id,
      error: compactLogError(error),
    });
    checkpointOpportunity(checkpointTask, workspaceStore, { status: 'error', progress: 100, logs: addLog(`报价预测失败：${message}`), error: message }, active.id, {
      pricePrediction: { status: 'error', error: message, updatedAt: now() },
    });
  }
}

module.exports = {
  runBidOpportunityParseTask,
  runBidOpportunityScoreTask,
  runBidOpportunityPriceTask,
};
