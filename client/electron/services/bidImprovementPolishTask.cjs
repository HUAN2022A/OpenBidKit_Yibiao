// 标书润色后台任务（bid improvement polish）。
//
// 面向「完成态标书提质」场景：对已生成的技术方案正文小节做表达层面润色，
// 不改写事实、数据与承诺，只提升专业性 / 简洁性 / 合规性。
//
// runBidImprovementPolishTask 是 taskService 托管的 runner，签名与 contentGenerationTask /
// rejectionCheckTask 一致，供 startManagedTask 调用。业务输入通过 payload 传入：
//   payload = {
//     nodeIds: string[],        // 需要润色的正文小节 nodeId 列表
//     polishGoal: string,       // 润色目标，可为「专业性 / 简洁性 / 合规性」或自由描述
//     tenderContext: string,    // 招标要求上下文（评分要点、实质性条款等）
//   }
//
// 输出（返回值）：{ nodeId, originalContent, polishedContent }[]
// 进度通过 updateTask 推送到 Renderer；取消依赖 taskService 传入的 taskControl.signal
// 以及 aiService 的队列取消能力。

function normalizeText(value) {
  return String(value || '').trim();
}

// 将目录树扁平化为 nodeId -> node 的映射，方便按 id 精确取到正文。
function collectNodesById(outline) {
  const map = new Map();
  const visit = (items) => {
    for (const item of items || []) {
      if (item?.id) map.set(String(item.id), item);
      if (Array.isArray(item?.children)) visit(item.children);
    }
  };
  visit(outline);
  return map;
}

// 润色目标的固定指导语。polishGoal 支持中英文关键词与自由文本，未识别时按自由描述处理。
const POLISH_GOAL_GUIDANCE = {
  professional: '本次润色重点提升专业性：使用规范的行业术语与正式书面语，表述严谨、层次清晰，避免口语化、随意化表达。',
  concise: '本次润色重点提升简洁性：删除套话、重复与无实质信息的内容，压缩冗余表述，使文字精炼、要点突出，同时不损失必要信息。',
  compliance: '本次润色重点提升合规性：确保表述稳妥、不夸大、不越权承诺，消除可能与招标要求相抵触或构成废标风险的措辞，留有余地。',
};

function buildPolishGoalGuidance(polishGoal) {
  const goal = normalizeText(polishGoal);
  if (!goal) {
    return '在保证专业性、简洁性、合规性的前提下，整体提升投标文件表达质量。';
  }
  const lower = goal.toLowerCase();
  if (lower === 'professional') return POLISH_GOAL_GUIDANCE.professional;
  if (lower === 'concise') return POLISH_GOAL_GUIDANCE.concise;
  if (lower === 'compliance') return POLISH_GOAL_GUIDANCE.compliance;
  if (goal.includes('专业')) return POLISH_GOAL_GUIDANCE.professional;
  if (goal.includes('简洁') || goal.includes('精炼') || goal.includes('冗余')) return POLISH_GOAL_GUIDANCE.concise;
  if (goal.includes('合规') || goal.includes('废标') || goal.includes('风险')) return POLISH_GOAL_GUIDANCE.compliance;
  return `本次润色重点：${goal}。同时兼顾专业性、简洁性与合规性。`;
}

function buildPolishMessages({ tenderContext, originalContent, polishGoal }) {
  return [
    {
      role: 'system',
      content: '你是一名资深投标文件编写专家，长期负责政府采购、工程建设等领域投标文件的编制、评审与优化，熟悉评标办法、评分标准、废标项规则和实质性条款。你擅长在不改变原文事实与承诺的前提下，提升投标文件的专业性、简洁性与合规性。',
    },
    {
      role: 'user',
      content: `【投标文件润色任务 v1｜润色目标】
${buildPolishGoalGuidance(polishGoal)}

【招标要求上下文】
${tenderContext || '（未提供招标要求上下文）'}

【原始内容】
${originalContent}

【润色要求】
1. 保留事实：不得新增、删除或改动原文中的事实、数据、型号、规格、工期、金额、资质、人员、承诺、业绩等实质信息；不确定的内容保持原样，不得杜撰。
2. 提升表达：修正语病、错别字与冗余，优化句式与逻辑衔接，使用规范、专业、严谨的书面表达。
3. 符合评分要求：优先体现招标要求中的实质性条款与评分要点，突出原文与招标要求的对应关系，但不虚构响应。
4. 仅输出润色后的正文内容本身，不要输出任何解释、说明、标题或 Markdown 代码块。`,
    },
  ];
}

/**
 * 标书润色后台任务。
 *
 * @param {object} args 由 taskService.startManagedTask 注入的 runner 参数。
 * @param {object} args.aiService 已绑定队列作用域与取消信号的 AI 服务。
 * @param {object} args.workspaceStore 技术方案 Store（technicalPlanStore）。
 * @param {function} args.updateTask 仅更新 Main 内存并推送 Renderer 的任务状态更新。
 * @param {object} args.payload 业务输入：{ nodeIds, polishGoal, tenderContext }。
 * @param {object} args.taskControl 任务控制器，含取消信号 signal。
 * @returns {Promise<Array<{ nodeId: string, originalContent: string, polishedContent: string }>>}
 */
async function runBidImprovementPolishTask({ aiService, workspaceStore, updateTask, payload, taskControl }) {
  const nodeIds = Array.isArray(payload?.nodeIds)
    ? payload.nodeIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const polishGoal = normalizeText(payload?.polishGoal);
  const tenderContext = normalizeText(payload?.tenderContext);

  if (!nodeIds.length) {
    throw new Error('请选择需要润色的正文小节');
  }
  if (typeof workspaceStore?.loadTechnicalPlan !== 'function') {
    throw new Error('技术方案存储接口尚未初始化');
  }

  const plan = workspaceStore.loadTechnicalPlan() || {};
  const outline = Array.isArray(plan.outlineData?.outline) ? plan.outlineData.outline : [];
  const nodeById = collectNodesById(outline);

  const targets = [];
  for (const nodeId of nodeIds) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const originalContent = String(node.content || '').trim();
    if (!originalContent) continue;
    targets.push({ nodeId, title: normalizeText(node.title) || nodeId, originalContent });
  }
  if (!targets.length) {
    throw new Error('所选小节没有可润色的正文内容');
  }

  updateTask({ status: 'running', progress: 5, logs: [`开始润色 ${targets.length} 个正文小节。`] });

  const results = [];
  let completed = 0;
  for (const target of targets) {
    if (taskControl?.signal?.aborted) {
      throw taskControl.signal.reason || new Error('润色任务已取消');
    }
    updateTask({
      status: 'running',
      progress: 5 + Math.round((completed / targets.length) * 90),
      logs: [`正在润色：${target.title}（${completed + 1}/${targets.length}）`],
    });

    // 温度说明：aiService.chat 的 temperature 由文本模型全局配置（temperature_enabled /
    // temperature）决定，不支持按请求覆盖。润色任务通过确定性的系统角色与聚焦指令保持
    // 输出专业、稳定（等价于低温度的效果），不在此处伪造无效的 temperature 字段。
    const polishedContent = await aiService.chat({
      messages: buildPolishMessages({
        tenderContext,
        originalContent: target.originalContent,
        polishGoal,
      }),
      logTitle: `标书润色-${target.nodeId}-${target.title}`,
    });

    const polished = normalizeText(polishedContent);
    if (!polished) {
      throw new Error(`小节“${target.title}”润色未返回内容`);
    }
    results.push({ nodeId: target.nodeId, originalContent: target.originalContent, polishedContent: polished });
    completed += 1;
  }

  updateTask({
    status: 'success',
    progress: 100,
    logs: [`润色完成，共处理 ${results.length} 个正文小节。`],
    stats: { results },
  });

  return results;
}

module.exports = { runBidImprovementPolishTask };
