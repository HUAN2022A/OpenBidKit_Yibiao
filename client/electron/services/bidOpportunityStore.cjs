const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getWorkspaceDir } = require('../utils/paths.cjs');

const initialState = {
  enterprise: { companyName: '', industry: '', regions: [], strengths: '' },
  qualifications: [],
  performances: [],
  opportunities: [],
  activeOpportunityId: null,
  activeTab: 'opportunities',
  parseTask: undefined,
  scoreTask: undefined,
  priceTask: undefined,
};

const parseTaskType = 'bid-opportunity-parse';
const scoreTaskType = 'bid-opportunity-score';
const priceTaskType = 'bid-opportunity-price';
const taskDomain = 'bid-opportunity';

const opportunityStatuses = ['new', 'screening', 'following', 'bidding', 'abandoned'];
const parseStatuses = ['idle', 'running', 'success', 'error'];
const recommendations = ['bid', 'evaluate', 'skip'];

const taskFieldTypes = {
  parseTask: parseTaskType,
  scoreTask: scoreTaskType,
  priceTask: priceTaskType,
};

const taskTypeFields = Object.fromEntries(
  Object.entries(taskFieldTypes).map(([field, type]) => [type, field]),
);

function now() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function safeJsonParse(value, fallback) {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonOrNull(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function stableHash(content) {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

function normalizeStatus(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeRegions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeText(item)).filter(Boolean);
}

function normalizeEnterprise(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    companyName: normalizeText(source.companyName),
    industry: normalizeText(source.industry),
    regions: normalizeRegions(source.regions),
    strengths: normalizeText(source.strengths),
  };
}

function normalizeQualification(value, index = 0) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    id: normalizeText(source.id) || createId('qual'),
    name: normalizeText(source.name),
    level: normalizeText(source.level),
    certNo: normalizeText(source.certNo),
    validUntil: normalizeText(source.validUntil),
    sortOrder: Number.isFinite(Number(source.sortOrder)) ? Number(source.sortOrder) : index,
  };
}

function normalizePerformance(value, index = 0) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    id: normalizeText(source.id) || createId('perf'),
    projectName: normalizeText(source.projectName),
    industry: normalizeText(source.industry),
    region: normalizeText(source.region),
    amount: normalizeText(source.amount),
    completedAt: normalizeText(source.completedAt),
    description: normalizeText(source.description),
    sortOrder: Number.isFinite(Number(source.sortOrder)) ? Number(source.sortOrder) : index,
  };
}

function normalizeKeyDates(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ label: normalizeText(item.label), date: normalizeText(item.date) }));
}

function getBidOpportunityDir(app) {
  return path.join(getWorkspaceDir(app), 'bid-opportunity');
}

function getAnnouncementRelativePath(opportunityId) {
  const safe = String(opportunityId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `bid-opportunity/announcements/${safe}.md`;
}

function getAnnouncementMarkdownPath(app, opportunityId) {
  const safe = String(opportunityId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getBidOpportunityDir(app), 'announcements', `${safe}.md`);
}

function createBidOpportunityStore({ app, db, fileService, taskLogStore, technicalPlanStore }) {
  const opportunityDir = getBidOpportunityDir(app);

  function resolveMarkdownPath(relativeOrAbsolutePath, opportunityId) {
    const value = String(relativeOrAbsolutePath || '').trim();
    if (!value) return getAnnouncementMarkdownPath(app, opportunityId);
    return path.isAbsolute(value) ? value : path.join(getWorkspaceDir(app), ...value.split('/'));
  }

  function ensureMetaRow() {
    const existing = db.prepare('SELECT * FROM bid_opportunity_meta WHERE id = 1').get();
    if (existing) return existing;
    const timestamp = now();
    db.prepare(`
      INSERT INTO bid_opportunity_meta (
        id, active_opportunity_id, active_tab, enterprise_json, created_at, updated_at
      ) VALUES (
        1, NULL, 'opportunities', @enterprise_json, @timestamp, @timestamp
      )
    `).run({ enterprise_json: JSON.stringify(initialState.enterprise), timestamp });
    return db.prepare('SELECT * FROM bid_opportunity_meta WHERE id = 1').get();
  }

  function updateMeta(fields) {
    ensureMetaRow();
    const entries = Object.entries(fields || {}).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE bid_opportunity_meta SET ${assignments}, updated_at = @updated_at WHERE id = 1`).run({
      ...Object.fromEntries(entries),
      updated_at: now(),
    });
  }

  function opportunityRowValues(opp, index, timestamp) {
    const source = opp && typeof opp === 'object' ? opp : {};
    const structured = source.structured && typeof source.structured === 'object' ? source.structured : null;
    const score = source.score && typeof source.score === 'object' ? source.score : null;
    return {
      id: normalizeText(source.id) || createId('opp'),
      title: normalizeText(source.title) || '未命名机会',
      source: source.source === 'upload' ? 'upload' : source.source === 'url' ? 'url' : 'manual',
      status: normalizeStatus(source.status, opportunityStatuses, 'new'),
      raw_markdown_path: getAnnouncementRelativePath(source.id || ''),
      raw_hash: normalizeText(source.rawHash),
      raw_chars: Number.isFinite(Number(source.rawChars)) ? Number(source.rawChars) : 0,
      parse_status: normalizeStatus(source.parseStatus, parseStatuses, 'idle'),
      structured_json: jsonOrNull(structured),
      score_json: jsonOrNull(score),
      price_prediction_json: jsonOrNull(source.pricePrediction),
      analysis_text: normalizeText(source.analysisText),
      recommendation: recommendations.includes(source.recommendation) ? source.recommendation : null,
      tenderer: normalizeText(source.tenderer),
      region: normalizeText(source.region),
      budget_text: normalizeText(source.budgetText),
      deadline_text: normalizeText(source.deadlineText),
      owner: normalizeText(source.owner),
      conclusion: normalizeText(source.conclusion),
      key_dates_json: jsonOrNull(normalizeKeyDates(source.keyDates)),
      sort_order: index,
      created_at: normalizeText(source.createdAt) || timestamp,
      updated_at: timestamp,
    };
  }

  function saveOpportunities(opportunities) {
    const timestamp = now();
    const insert = db.prepare(`
      INSERT INTO bid_opportunities (
        id, title, source, status, raw_markdown_path, raw_hash, raw_chars, parse_status,
        structured_json, score_json, price_prediction_json, analysis_text, recommendation, tenderer, region, budget_text,
        deadline_text, owner, conclusion, key_dates_json, sort_order, created_at, updated_at
      ) VALUES (
        @id, @title, @source, @status, @raw_markdown_path, @raw_hash, @raw_chars, @parse_status,
        @structured_json, @score_json, @price_prediction_json, @analysis_text, @recommendation, @tenderer, @region, @budget_text,
        @deadline_text, @owner, @conclusion, @key_dates_json, @sort_order, @created_at, @updated_at
      )
    `);
    db.prepare('DELETE FROM bid_opportunities').run();
    (Array.isArray(opportunities) ? opportunities : []).forEach((opp, index) => {
      insert.run(opportunityRowValues(opp, index, timestamp));
    });
  }

  function opportunityFromRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      source: row.source === 'upload' ? 'upload' : row.source === 'url' ? 'url' : 'manual',
      status: normalizeStatus(row.status, opportunityStatuses, 'new'),
      rawHash: row.raw_hash || '',
      rawChars: Number(row.raw_chars || 0),
      parseStatus: normalizeStatus(row.parse_status, parseStatuses, 'idle'),
      structured: safeJsonParse(row.structured_json, null),
      score: safeJsonParse(row.score_json, null),
      pricePrediction: safeJsonParse(row.price_prediction_json, null),
      analysisText: row.analysis_text || '',
      recommendation: recommendations.includes(row.recommendation) ? row.recommendation : null,
      tenderer: row.tenderer || '',
      region: row.region || '',
      budgetText: row.budget_text || '',
      deadlineText: row.deadline_text || '',
      owner: row.owner || '',
      conclusion: row.conclusion || '',
      keyDates: safeJsonParse(row.key_dates_json, []),
      createdAt: row.created_at || undefined,
      updatedAt: row.updated_at || undefined,
    };
  }

  function loadOpportunities() {
    return db.prepare('SELECT * FROM bid_opportunities ORDER BY sort_order ASC').all().map(opportunityFromRow);
  }

  function loadOpportunity(opportunityId) {
    const row = db.prepare('SELECT * FROM bid_opportunities WHERE id = ?').get(opportunityId);
    return opportunityFromRow(row);
  }

  function saveQualifications(qualifications) {
    const timestamp = now();
    const insert = db.prepare(`
      INSERT INTO bid_opportunity_qualifications (
        id, name, level, cert_no, valid_until, sort_order, created_at, updated_at
      ) VALUES (
        @id, @name, @level, @cert_no, @valid_until, @sort_order, @created_at, @updated_at
      )
    `);
    db.prepare('DELETE FROM bid_opportunity_qualifications').run();
    (Array.isArray(qualifications) ? qualifications : []).forEach((item, index) => {
      const normalized = normalizeQualification(item, index);
      insert.run({
        id: normalized.id,
        name: normalized.name,
        level: normalized.level,
        cert_no: normalized.certNo,
        valid_until: normalized.validUntil,
        sort_order: normalized.sortOrder,
        created_at: timestamp,
        updated_at: timestamp,
      });
    });
  }

  function savePerformances(performances) {
    const timestamp = now();
    const insert = db.prepare(`
      INSERT INTO bid_opportunity_performances (
        id, project_name, industry, region, amount, completed_at, description, sort_order, created_at, updated_at
      ) VALUES (
        @id, @project_name, @industry, @region, @amount, @completed_at, @description, @sort_order, @created_at, @updated_at
      )
    `);
    db.prepare('DELETE FROM bid_opportunity_performances').run();
    (Array.isArray(performances) ? performances : []).forEach((item, index) => {
      const normalized = normalizePerformance(item, index);
      insert.run({
        id: normalized.id,
        project_name: normalized.projectName,
        industry: normalized.industry,
        region: normalized.region,
        amount: normalized.amount,
        completed_at: normalized.completedAt,
        description: normalized.description,
        sort_order: normalized.sortOrder,
        created_at: timestamp,
        updated_at: timestamp,
      });
    });
  }

  function qualificationFromRow(row) {
    return {
      id: row.id,
      name: row.name,
      level: row.level || '',
      certNo: row.cert_no || '',
      validUntil: row.valid_until || '',
      sortOrder: Number(row.sort_order || 0),
    };
  }

  function performanceFromRow(row) {
    return {
      id: row.id,
      projectName: row.project_name,
      industry: row.industry || '',
      region: row.region || '',
      amount: row.amount || '',
      completedAt: row.completed_at || '',
      description: row.description || '',
      sortOrder: Number(row.sort_order || 0),
    };
  }

  function loadQualifications() {
    return db.prepare('SELECT * FROM bid_opportunity_qualifications ORDER BY sort_order ASC').all().map(qualificationFromRow);
  }

  function loadPerformances() {
    return db.prepare('SELECT * FROM bid_opportunity_performances ORDER BY sort_order ASC').all().map(performanceFromRow);
  }

  function loadEnterprise() {
    const meta = db.prepare('SELECT enterprise_json FROM bid_opportunity_meta WHERE id = 1').get();
    return normalizeEnterprise(safeJsonParse(meta?.enterprise_json, initialState.enterprise));
  }

  function taskFromRow(row) {
    if (!row) return undefined;
    return {
      task_id: row.task_id,
      type: row.type,
      status: normalizeStatus(row.status, ['running', 'success', 'error'], 'running'),
      progress: Number(row.progress || 0),
      logs: taskLogStore.list(taskDomain, row.type, row.task_id),
      started_at: row.started_at,
      updated_at: row.updated_at,
      error: row.error || undefined,
    };
  }

  function saveTask(type, task) {
    if (!task) {
      db.prepare('DELETE FROM bid_opportunity_tasks WHERE type = ?').run(type);
      return;
    }
    const timestamp = now();
    db.prepare(`
      INSERT INTO bid_opportunity_tasks (type, task_id, status, progress, stats_json, error, started_at, updated_at)
      VALUES (@type, @task_id, @status, @progress, @stats_json, @error, @started_at, @updated_at)
      ON CONFLICT(type) DO UPDATE SET
        task_id = excluded.task_id,
        status = excluded.status,
        progress = excluded.progress,
        stats_json = excluded.stats_json,
        error = excluded.error,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `).run({
      type,
      task_id: String(task.task_id || ''),
      status: String(task.status || 'running'),
      progress: Math.max(0, Math.min(100, Math.round(Number(task.progress || 0)))),
      stats_json: jsonOrNull(task.stats),
      error: task.error ? String(task.error) : null,
      started_at: task.started_at || timestamp,
      updated_at: task.updated_at || timestamp,
    });
    taskLogStore.sync(taskDomain, type, String(task.task_id || ''), task.logs, task.updated_at || timestamp);
  }

  function loadTasks() {
    const tasks = {};
    for (const row of db.prepare('SELECT * FROM bid_opportunity_tasks').all()) {
      const field = taskTypeFields[row.type];
      if (field) tasks[field] = taskFromRow(row);
    }
    return tasks;
  }

  const updateBidOpportunityTransaction = db.transaction((partial) => {
    ensureMetaRow();
    const metaUpdates = {};
    if (hasOwn(partial, 'activeOpportunityId')) metaUpdates.active_opportunity_id = partial.activeOpportunityId ? String(partial.activeOpportunityId) : null;
    if (hasOwn(partial, 'activeTab')) metaUpdates.active_tab = partial.activeTab === 'enterprise' ? 'enterprise' : 'opportunities';
    if (hasOwn(partial, 'enterprise')) metaUpdates.enterprise_json = JSON.stringify(normalizeEnterprise(partial.enterprise));
    if (Object.keys(metaUpdates).length) updateMeta(metaUpdates);

    if (hasOwn(partial, 'opportunities')) saveOpportunities(partial.opportunities);
    if (hasOwn(partial, 'qualifications')) saveQualifications(partial.qualifications);
    if (hasOwn(partial, 'performances')) savePerformances(partial.performances);
    if (hasOwn(partial, 'parseTask')) saveTask(parseTaskType, partial.parseTask);
    if (hasOwn(partial, 'scoreTask')) saveTask(scoreTaskType, partial.scoreTask);
    if (hasOwn(partial, 'priceTask')) saveTask(priceTaskType, partial.priceTask);
  });

  function loadBidOpportunity() {
    const meta = db.prepare('SELECT * FROM bid_opportunity_meta WHERE id = 1').get();
    if (!meta) throw new Error('投标机会数据库尚未初始化');
    const tasks = loadTasks();
    return {
      ...initialState,
      enterprise: loadEnterprise(),
      qualifications: loadQualifications(),
      performances: loadPerformances(),
      opportunities: loadOpportunities(),
      activeOpportunityId: meta.active_opportunity_id || null,
      activeTab: meta.active_tab === 'enterprise' ? 'enterprise' : 'opportunities',
      parseTask: tasks.parseTask,
      scoreTask: tasks.scoreTask,
      priceTask: tasks.priceTask,
    };
  }

  function updateBidOpportunityWithoutReload(partial) {
    updateBidOpportunityTransaction(partial || {});
  }

  function updateBidOpportunity(partial) {
    updateBidOpportunityWithoutReload(partial);
  }

  function readAnnouncementMarkdown(opportunityId) {
    const row = db.prepare('SELECT * FROM bid_opportunities WHERE id = ?').get(opportunityId);
    if (!row) return '';
    const filePath = resolveMarkdownPath(row.raw_markdown_path, row.id);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  }

  function writeAnnouncementMarkdown(opportunityId, content) {
    const absolutePath = getAnnouncementMarkdownPath(app, opportunityId);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, String(content || ''), 'utf-8');
  }

  function removeAnnouncementMarkdown(opportunityId) {
    try {
      fs.rmSync(getAnnouncementMarkdownPath(app, opportunityId), { force: true });
    } catch (error) {
      console.warn('[bid-opportunity] 删除公告文件失败', error);
    }
  }

  async function runBeforeCommit(options) {
    if (typeof options?.beforeCommit === 'function') {
      await options.beforeCommit();
    }
  }

  function buildAnnouncementOpportunity({ rawText, title, source }) {
    const id = createId('opp');
    const content = String(rawText || '').trim();
    const timestamp = now();
    return {
      id,
      title: normalizeText(title) || '未命名机会',
      source,
      status: 'new',
      rawHash: stableHash(content),
      rawChars: content.length,
      parseStatus: 'idle',
      structured: null,
      score: null,
      pricePrediction: null,
      analysisText: '',
      recommendation: null,
      tenderer: '',
      region: '',
      budgetText: '',
      deadlineText: '',
      owner: '',
      conclusion: '',
      keyDates: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  function prependOpportunity(existing, next) {
    return [next, ...(Array.isArray(existing) ? existing : [])];
  }

  async function importAnnouncement(options = {}) {
    if (typeof fileService?.importTechnicalPlanDocument !== 'function') {
      throw new Error('文件解析服务尚未初始化');
    }
    await runBeforeCommit(options);
    const result = await fileService.importTechnicalPlanDocument('招标公告');
    if (!result?.success) {
      return { success: false, message: result?.message || '文件导入失败' };
    }
    const rawText = String(result.file_content || '').trim();
    if (!rawText) {
      return { success: false, message: '未提取到有效公告内容' };
    }
    const opportunity = buildAnnouncementOpportunity({
      rawText,
      title: result.file_name ? result.file_name.replace(/\.[^.]+$/, '') : undefined,
      source: 'upload',
    });
    writeAnnouncementMarkdown(opportunity.id, rawText);
    const nextOpportunities = prependOpportunity(loadOpportunities(), opportunity);
    updateBidOpportunityTransaction({
      opportunities: nextOpportunities,
      activeOpportunityId: opportunity.id,
    });
    return { success: true, message: '公告已导入', opportunityId: opportunity.id };
  }

  async function importFromTechnicalPlan(options = {}) {
    if (typeof technicalPlanStore?.loadTechnicalPlan !== 'function') {
      throw new Error('技术方案缓存接口尚未初始化');
    }
    await runBeforeCommit(options);
    const technicalPlan = technicalPlanStore.loadTechnicalPlan();
    const tenderFiles = Array.isArray(technicalPlan?.tenderFiles) ? technicalPlan.tenderFiles : [];
    if (!tenderFiles.length) {
      return { success: false, message: '技术方案中暂无招标文件，请先导入并解析招标文件' };
    }
    const created = [];
    for (const file of tenderFiles) {
      const rawText = String(technicalPlanStore.readTenderSourceMarkdown?.(file.id) || '').trim();
      if (!rawText) continue;
      const opportunity = buildAnnouncementOpportunity({
        rawText,
        title: file.fileName ? String(file.fileName).replace(/\.[^.]+$/, '') : undefined,
        source: 'upload',
      });
      writeAnnouncementMarkdown(opportunity.id, rawText);
      created.push(opportunity);
    }
    if (!created.length) {
      return { success: false, message: '技术方案中的招标文件内容为空，请先完成招标文件解析' };
    }
    updateBidOpportunityTransaction({
      opportunities: [...created, ...loadOpportunities()],
      activeOpportunityId: created[0].id,
    });
    return {
      success: true,
      message: `已沉淀 ${created.length} 条投标机会`,
      opportunityIds: created.map((item) => item.id),
    };
  }

  async function importFromUrl(url, options = {}) {
    if (typeof fileService?.fetchWebPageMarkdown !== 'function') {
      throw new Error('网页抓取服务尚未初始化');
    }
    await runBeforeCommit(options);
    const result = await fileService.fetchWebPageMarkdown(url);
    if (!result?.success) {
      return { success: false, message: result?.message || '网页抓取失败' };
    }
    const rawText = String(result.markdown || '').trim();
    if (!rawText) {
      return { success: false, message: '未从网页提取到正文内容' };
    }
    const opportunity = buildAnnouncementOpportunity({
      rawText,
      title: result.title ? String(result.title).slice(0, 200) : undefined,
      source: 'url',
    });
    writeAnnouncementMarkdown(opportunity.id, rawText);
    updateBidOpportunityTransaction({
      opportunities: [opportunity, ...loadOpportunities()],
      activeOpportunityId: opportunity.id,
    });
    return { success: true, message: '已从链接导入公告', opportunityId: opportunity.id };
  }

  async function createAnnouncement(payload = {}, options = {}) {
    await runBeforeCommit(options);
    const rawText = String(payload?.rawText || '').trim();
    if (!rawText) {
      return { success: false, message: '公告内容不能为空' };
    }
    const opportunity = buildAnnouncementOpportunity({
      rawText,
      title: payload?.title,
      source: 'manual',
    });
    writeAnnouncementMarkdown(opportunity.id, rawText);
    const nextOpportunities = prependOpportunity(loadOpportunities(), opportunity);
    updateBidOpportunityTransaction({
      opportunities: nextOpportunities,
      activeOpportunityId: opportunity.id,
    });
    return { success: true, message: '公告已创建', opportunityId: opportunity.id };
  }

  async function updateAnnouncement(payload = {}, options = {}) {
    await runBeforeCommit(options);
    const opportunityId = String(payload?.opportunityId || '');
    if (!opportunityId) {
      return { success: false, message: '缺少机会标识' };
    }
    const opportunities = loadOpportunities();
    const target = opportunities.find((item) => item.id === opportunityId);
    if (!target) {
      return { success: false, message: '机会不存在' };
    }
    const fields = {};
    if (hasOwn(payload, 'status')) fields.status = normalizeStatus(payload.status, opportunityStatuses, target.status);
    if (hasOwn(payload, 'owner')) fields.owner = normalizeText(payload.owner);
    if (hasOwn(payload, 'conclusion')) fields.conclusion = normalizeText(payload.conclusion);
    if (hasOwn(payload, 'keyDates')) fields.keyDates = normalizeKeyDates(payload.keyDates);
    const nextOpportunities = opportunities.map((item) => (
      item.id === opportunityId ? { ...item, ...fields } : item
    ));
    updateBidOpportunityTransaction({ opportunities: nextOpportunities });
    return { success: true, message: '机会已更新' };
  }

  async function deleteAnnouncement(opportunityId, options = {}) {
    await runBeforeCommit(options);
    const id = String(opportunityId || '');
    const opportunities = loadOpportunities().filter((item) => item.id !== id);
    removeAnnouncementMarkdown(id);
    const meta = db.prepare('SELECT active_opportunity_id FROM bid_opportunity_meta WHERE id = 1').get();
    const nextActive = meta?.active_opportunity_id === id
      ? (opportunities[0]?.id || null)
      : (meta?.active_opportunity_id || opportunities[0]?.id || null);
    updateBidOpportunityTransaction({ opportunities, activeOpportunityId: nextActive });
    return { success: true, message: '机会已删除' };
  }

  async function saveEnterprise(payload = {}, options = {}) {
    await runBeforeCommit(options);
    const enterprise = normalizeEnterprise(payload?.enterprise);
    const qualifications = Array.isArray(payload?.qualifications) ? payload.qualifications : [];
    const performances = Array.isArray(payload?.performances) ? payload.performances : [];
    updateBidOpportunityTransaction({ enterprise, qualifications, performances });
    return { success: true, message: '企业画像已保存' };
  }

  async function clearBidOpportunity() {
    const rows = db.prepare('SELECT * FROM bid_opportunities').all();
    db.transaction(() => {
      db.prepare('DELETE FROM bid_opportunity_tasks').run();
      db.prepare('DELETE FROM bid_opportunity_qualifications').run();
      db.prepare('DELETE FROM bid_opportunity_performances').run();
      db.prepare('DELETE FROM bid_opportunities').run();
      db.prepare('DELETE FROM bid_opportunity_meta').run();
      ensureMetaRow();
    })();
    for (const row of rows) {
      removeAnnouncementMarkdown(row.id);
    }
    try {
      fs.rmSync(opportunityDir, { recursive: true, force: true });
    } catch (error) {
      console.warn('[bid-opportunity] 清理目录失败', error);
    }
    return { success: true, message: '投标机会缓存已清空' };
  }

  fs.mkdirSync(opportunityDir, { recursive: true });
  ensureMetaRow();

  return {
    loadBidOpportunity,
    updateBidOpportunity,
    updateBidOpportunityWithoutReload,
    readAnnouncementMarkdown,
    importAnnouncement,
    importFromTechnicalPlan,
    importFromUrl,
    createAnnouncement,
    updateAnnouncement,
    deleteAnnouncement,
    saveEnterprise,
    clearBidOpportunity,
    loadOpportunities,
    loadOpportunity,
    loadEnterprise,
    loadQualifications,
    loadPerformances,
  };
}

module.exports = {
  createBidOpportunityStore,
};
