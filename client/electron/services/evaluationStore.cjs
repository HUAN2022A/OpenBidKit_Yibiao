const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getWorkspaceDir } = require('../utils/paths.cjs');

const initialState = {
  technicalPlanDocument: null,
  scoringItems: { status: 'idle', content: '', source: 'technical-plan' },
  runOptions: { judgeCount: 1 },
  evaluationResult: {
    status: 'idle',
    totalScore: 0,
    totalMaxScore: 0,
    scoreRate: 0,
    overallComment: '',
    items: [],
  },
  evaluationTask: undefined,
  activeTab: 'documents',
};

const evaluationResultType = 'evaluation';
const evaluationTaskType = 'evaluation-run';
const evaluationTaskDomain = 'evaluation-check';
const technicalPlanDocumentId = 'technical-plan';
const technicalPlanDocumentRole = 'technical-plan';

const taskFieldTypes = {
  evaluationTask: evaluationTaskType,
};

const taskTypeFields = Object.fromEntries(
  Object.entries(taskFieldTypes).map(([field, type]) => [type, field]),
);

function now() {
  return new Date().toISOString();
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

function normalizeActiveTab(value) {
  return value === 'results' ? 'results' : 'documents';
}

function normalizeRunOptions(options) {
  const rawJudgeCount = Number(options?.judgeCount);
  const judgeCount = Number.isFinite(rawJudgeCount) && rawJudgeCount >= 1 ? Math.floor(rawJudgeCount) : 1;
  return { judgeCount };
}

function normalizeScoreRate(totalScore, totalMaxScore) {
  const max = Number(totalMaxScore || 0);
  return max > 0 ? Number(totalScore || 0) / max : 0;
}

function stripTripleQuoteWrapper(content) {
  const trimmed = String(content || '').trim();
  if (trimmed.startsWith("'''") && trimmed.endsWith("'''")) {
    return trimmed.slice(3, -3).trim();
  }
  return String(content || '');
}

function getEvaluationDir(app) {
  return path.join(getWorkspaceDir(app), 'evaluation');
}

function getDocumentMarkdownRelativePath(documentId) {
  const safe = String(documentId || technicalPlanDocumentId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `evaluation/documents/${safe}.md`;
}

function getEvaluationDocumentMarkdownPath(app, documentId) {
  const safe = String(documentId || technicalPlanDocumentId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getEvaluationDir(app), 'documents', `${safe}.md`);
}

function createDocumentSignature(document) {
  if (!document) return '';
  const content = String(document.content || '').trim();
  return [
    document.id || document.role,
    document.source,
    document.fileName,
    content.length,
    content.slice(0, 800),
    content.slice(-800),
  ].join('\n---yibiao-evaluation-signature---\n');
}

function createEvaluationInputSignature(document, scoringItemsContent) {
  const documentContent = document ? String(document.content || '').trim() : '';
  const scoring = String(scoringItemsContent || '').trim();
  if (!documentContent || !scoring) return '';
  return stableHash(`${documentContent}\n---yibiao-evaluation-input---\n${scoring}`);
}

function createEvaluationStore({ app, db, technicalPlanStore, taskLogStore }) {
  const evaluationDir = getEvaluationDir(app);

  function resolveMarkdownPath(relativeOrAbsolutePath, documentId) {
    const value = String(relativeOrAbsolutePath || '').trim();
    if (!value) return getEvaluationDocumentMarkdownPath(app, documentId);
    return path.isAbsolute(value) ? value : path.join(getWorkspaceDir(app), ...value.split('/'));
  }

  function reportCleanupError(label, error) {
    console.warn(`[evaluation] ${label}`, error);
  }

  function runCleanupSync(cleanup) {
    try {
      cleanup();
    } catch (error) {
      reportCleanupError('清理评标文件失败', error);
    }
  }

  async function runCleanup(cleanup) {
    try {
      await cleanup();
    } catch (error) {
      reportCleanupError('清理评标文件失败', error);
    }
  }

  function ensureMetaRow() {
    const existing = db.prepare('SELECT * FROM evaluation_meta WHERE id = 1').get();
    if (existing) return existing;
    const timestamp = now();
    db.prepare(`
      INSERT INTO evaluation_meta (
        id, active_tab, run_options_json, scoring_items_json, created_at, updated_at
      ) VALUES (
        1, 'documents', @run_options_json, NULL, @timestamp, @timestamp
      )
    `).run({ run_options_json: JSON.stringify(initialState.runOptions), timestamp });
    return db.prepare('SELECT * FROM evaluation_meta WHERE id = 1').get();
  }

  function updateMeta(fields) {
    ensureMetaRow();
    const entries = Object.entries(fields || {}).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE evaluation_meta SET ${assignments}, updated_at = @updated_at WHERE id = 1`).run({
      ...Object.fromEntries(entries),
      updated_at: now(),
    });
  }

  function createPreparedDocument(document) {
    if (!document) return null;
    const content = String(document.content || '').trim();
    if (!content) return null;
    const documentId = String(document.id || technicalPlanDocumentId);
    const timestamp = now();
    const markdownPath = getDocumentMarkdownRelativePath(documentId);
    return {
      content: `${content}\n`,
      absolutePath: resolveMarkdownPath(markdownPath, documentId),
      values: {
        document_id: documentId,
        role: technicalPlanDocumentRole,
        source: document.source === 'technical-plan' ? 'technical-plan' : 'upload',
        file_name: String(document.fileName || '技术方案正文'),
        markdown_path: markdownPath,
        content_hash: stableHash(content),
        content_chars: content.length,
        imported_at: document.importedAt || timestamp,
        updated_at: timestamp,
      },
    };
  }

  function savePreparedDocument(prepared) {
    if (!prepared) return '';
    db.prepare(`
      INSERT INTO evaluation_documents (
        document_id, role, source, file_name, markdown_path, content_hash, content_chars, imported_at, updated_at
      ) VALUES (
        @document_id, @role, @source, @file_name, @markdown_path, @content_hash, @content_chars, @imported_at, @updated_at
      ) ON CONFLICT(document_id) DO UPDATE SET
        role = excluded.role,
        source = excluded.source,
        file_name = excluded.file_name,
        markdown_path = excluded.markdown_path,
        content_hash = excluded.content_hash,
        content_chars = excluded.content_chars,
        imported_at = excluded.imported_at,
        updated_at = excluded.updated_at
    `).run(prepared.values);
    return prepared.values.document_id;
  }

  function documentFromRow(row) {
    if (!row) return null;
    const filePath = resolveMarkdownPath(row.markdown_path, row.document_id);
    return {
      id: row.document_id,
      role: row.role,
      fileName: row.file_name,
      content: fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '',
      source: row.source === 'technical-plan' ? 'technical-plan' : 'upload',
      importedAt: row.imported_at,
    };
  }

  function loadDocument() {
    const row = db.prepare('SELECT * FROM evaluation_documents ORDER BY imported_at ASC LIMIT 1').get();
    return documentFromRow(row);
  }

  function readDocumentMarkdown() {
    const document = loadDocument();
    return document ? String(document.content || '') : '';
  }

  function saveScoringItems(scoringItems) {
    if (!scoringItems) {
      updateMeta({ scoring_items_json: null });
      return;
    }
    const content = stripTripleQuoteWrapper(scoringItems.content || '');
    updateMeta({
      scoring_items_json: JSON.stringify({
        status: normalizeStatus(scoringItems.status, ['idle', 'success', 'error'], 'idle'),
        content,
        source: scoringItems.source === 'technical-plan' ? 'technical-plan' : String(scoringItems.source || 'technical-plan'),
        updatedAt: scoringItems.updatedAt || now(),
        error: scoringItems.error ? String(scoringItems.error) : undefined,
      }),
    });
  }

  function loadScoringItems() {
    const meta = db.prepare('SELECT scoring_items_json FROM evaluation_meta WHERE id = 1').get();
    const raw = safeJsonParse(meta?.scoring_items_json, null);
    if (!raw || typeof raw !== 'object') return { ...initialState.scoringItems };
    return {
      status: normalizeStatus(raw.status, ['idle', 'success', 'error'], 'idle'),
      content: stripTripleQuoteWrapper(raw.content || ''),
      source: raw.source === 'technical-plan' ? 'technical-plan' : String(raw.source || 'technical-plan'),
      updatedAt: raw.updatedAt || undefined,
      error: raw.error || undefined,
    };
  }

  function saveResult(result) {
    if (!result) {
      clearScoreItemRows(evaluationResultType);
      db.prepare('DELETE FROM evaluation_results WHERE result_type = ?').run(evaluationResultType);
      return;
    }
    const existing = db.prepare('SELECT * FROM evaluation_results WHERE result_type = ?').get(evaluationResultType);
    const timestamp = now();
    db.prepare(`
      INSERT INTO evaluation_results (
        result_type, status, input_signature, total_score, total_max_score, overall_comment, active_item_id, progress_message, error, updated_at
      ) VALUES (
        @result_type, @status, @input_signature, @total_score, @total_max_score, @overall_comment, @active_item_id, @progress_message, @error, @updated_at
      ) ON CONFLICT(result_type) DO UPDATE SET
        status = excluded.status,
        input_signature = excluded.input_signature,
        total_score = excluded.total_score,
        total_max_score = excluded.total_max_score,
        overall_comment = excluded.overall_comment,
        active_item_id = excluded.active_item_id,
        progress_message = excluded.progress_message,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run({
      result_type: evaluationResultType,
      status: hasOwn(result, 'status')
        ? normalizeStatus(result.status, ['idle', 'running', 'success', 'error'], 'idle')
        : existing?.status || 'idle',
      input_signature: hasOwn(result, 'inputSignature')
        ? result.inputSignature ? String(result.inputSignature) : null
        : existing?.input_signature || null,
      total_score: hasOwn(result, 'totalScore')
        ? result.totalScore === undefined || result.totalScore === null ? 0 : Number(result.totalScore)
        : existing?.total_score ?? 0,
      total_max_score: hasOwn(result, 'totalMaxScore')
        ? result.totalMaxScore === undefined || result.totalMaxScore === null ? 0 : Number(result.totalMaxScore)
        : existing?.total_max_score ?? 0,
      overall_comment: hasOwn(result, 'overallComment')
        ? result.overallComment ? String(result.overallComment) : null
        : existing?.overall_comment || null,
      active_item_id: hasOwn(result, 'activeItemId')
        ? result.activeItemId ? String(result.activeItemId) : null
        : existing?.active_item_id || null,
      progress_message: hasOwn(result, 'progressMessage')
        ? result.progressMessage ? String(result.progressMessage) : null
        : existing?.progress_message || null,
      error: hasOwn(result, 'error')
        ? result.error ? String(result.error) : null
        : existing?.error || null,
      updated_at: result.updatedAt || timestamp,
    });
    if (hasOwn(result, 'items')) {
      clearScoreItemRows(evaluationResultType);
      saveScoreItemRows(evaluationResultType, result.items || []);
    }
  }

  function clearScoreItemRows(resultType) {
    db.prepare('DELETE FROM evaluation_score_items WHERE result_type = ?').run(resultType);
  }

  function saveScoreItemRows(resultType, items) {
    const timestamp = now();
    const insert = db.prepare(`
      INSERT INTO evaluation_score_items (
        item_id, result_type, name, max_score, score, criteria, evidence, deduction_reason, suggestion, sort_order, created_at, updated_at
      ) VALUES (
        @item_id, @result_type, @name, @max_score, @score, @criteria, @evidence, @deduction_reason, @suggestion, @sort_order, @created_at, @updated_at
      )
    `);
    (Array.isArray(items) ? items : []).forEach((item, index) => insert.run({
      item_id: String(item.id || `evaluation-item-${index + 1}`),
      result_type: resultType,
      name: String(item.name || ''),
      max_score: item.maxScore === undefined || item.maxScore === null ? 0 : Number(item.maxScore),
      score: item.score === undefined || item.score === null ? 0 : Number(item.score),
      criteria: String(item.criteria || ''),
      evidence: String(item.evidence || ''),
      deduction_reason: String(item.deductionReason || ''),
      suggestion: String(item.suggestion || ''),
      sort_order: index,
      created_at: timestamp,
      updated_at: timestamp,
    }));
  }

  function loadScoreItemRows(resultType) {
    return db.prepare('SELECT * FROM evaluation_score_items WHERE result_type = ? ORDER BY sort_order ASC').all(resultType).map((item) => ({
      id: item.item_id,
      name: item.name,
      maxScore: Number(item.max_score || 0),
      score: Number(item.score || 0),
      criteria: item.criteria,
      evidence: item.evidence,
      deductionReason: item.deduction_reason,
      suggestion: item.suggestion,
    }));
  }

  function loadResult(resultType) {
    const row = db.prepare('SELECT * FROM evaluation_results WHERE result_type = ?').get(resultType);
    if (!row) {
      return {
        status: 'idle',
        totalScore: 0,
        totalMaxScore: 0,
        scoreRate: 0,
        overallComment: '',
        items: [],
      };
    }
    const totalScore = Number(row.total_score || 0);
    const totalMaxScore = Number(row.total_max_score || 0);
    return {
      status: normalizeStatus(row.status, ['idle', 'running', 'success', 'error'], 'idle'),
      inputSignature: row.input_signature || undefined,
      totalScore,
      totalMaxScore,
      scoreRate: normalizeScoreRate(totalScore, totalMaxScore),
      overallComment: row.overall_comment || '',
      items: loadScoreItemRows(resultType),
      activeItemId: row.active_item_id || undefined,
      progressMessage: row.progress_message || undefined,
      error: row.error || undefined,
      updatedAt: row.updated_at || undefined,
    };
  }

  function taskFromRow(row) {
    if (!row) return undefined;
    return {
      task_id: row.task_id,
      type: row.type,
      status: normalizeStatus(row.status, ['running', 'success', 'error'], 'running'),
      progress: Number(row.progress || 0),
      logs: taskLogStore.list(evaluationTaskDomain, row.type, row.task_id),
      started_at: row.started_at,
      updated_at: row.updated_at,
      error: row.error || undefined,
    };
  }

  function saveTask(type, task) {
    if (!task) {
      db.prepare('DELETE FROM evaluation_tasks WHERE type = ?').run(type);
      return;
    }
    const timestamp = now();
    db.prepare(`
      INSERT INTO evaluation_tasks (type, task_id, status, progress, stats_json, error, started_at, updated_at)
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
    taskLogStore.sync(evaluationTaskDomain, type, String(task.task_id || ''), task.logs, task.updated_at || timestamp);
  }

  function loadTasks() {
    const tasks = {};
    for (const row of db.prepare('SELECT * FROM evaluation_tasks').all()) {
      const field = taskTypeFields[row.type];
      if (field) tasks[field] = taskFromRow(row);
    }
    return tasks;
  }

  function createDocumentMutation(partial) {
    const mutation = {
      preparedDocument: null,
      clearDocument: false,
      oldRows: [],
    };
    if (!hasOwn(partial, 'technicalPlanDocument')) return mutation;
    if (partial.technicalPlanDocument) {
      const prepared = createPreparedDocument(partial.technicalPlanDocument);
      if (prepared) {
        mutation.preparedDocument = prepared;
        const oldRow = db.prepare('SELECT * FROM evaluation_documents WHERE document_id = ?').get(prepared.values.document_id);
        if (oldRow) mutation.oldRows.push(oldRow);
      } else {
        mutation.clearDocument = true;
        mutation.oldRows.push(...db.prepare('SELECT * FROM evaluation_documents').all());
      }
    } else {
      mutation.clearDocument = true;
      mutation.oldRows.push(...db.prepare('SELECT * FROM evaluation_documents').all());
    }
    return mutation;
  }

  function applyDocumentMutation(mutation) {
    if (!mutation) return;
    if (mutation.clearDocument) {
      db.prepare('DELETE FROM evaluation_documents').run();
    }
    if (mutation.preparedDocument) {
      savePreparedDocument(mutation.preparedDocument);
    }
  }

  function writePreparedDocumentSync(prepared) {
    if (!prepared) return;
    fs.mkdirSync(path.dirname(prepared.absolutePath), { recursive: true });
    fs.writeFileSync(prepared.absolutePath, prepared.content, 'utf-8');
  }

  async function writePreparedDocument(prepared) {
    if (!prepared) return;
    await fs.promises.mkdir(path.dirname(prepared.absolutePath), { recursive: true });
    await fs.promises.writeFile(prepared.absolutePath, prepared.content, 'utf-8');
  }

  function removeMarkdownRowsSync(rows) {
    for (const row of rows || []) {
      const targetPath = resolveMarkdownPath(row.markdown_path, row.document_id);
      runCleanupSync(() => fs.rmSync(targetPath, { force: true }));
    }
  }

  async function removeMarkdownRows(rows) {
    await Promise.all((rows || []).map((row) => {
      const targetPath = resolveMarkdownPath(row.markdown_path, row.document_id);
      return runCleanup(() => fs.promises.rm(targetPath, { force: true }));
    }));
  }

  async function cleanupDocumentMutation(mutation) {
    await removeMarkdownRows(mutation.oldRows);
  }

  const updateEvaluationTransaction = db.transaction((partial, documentMutation) => {
    ensureMetaRow();
    const metaUpdates = {};
    if (hasOwn(partial, 'activeTab')) metaUpdates.active_tab = normalizeActiveTab(partial.activeTab);
    if (hasOwn(partial, 'runOptions')) metaUpdates.run_options_json = JSON.stringify(normalizeRunOptions(partial.runOptions));
    if (Object.keys(metaUpdates).length) updateMeta(metaUpdates);

    applyDocumentMutation(documentMutation);
    if (hasOwn(partial, 'scoringItems')) saveScoringItems(partial.scoringItems);
    if (hasOwn(partial, 'evaluationResult')) saveResult(partial.evaluationResult);
    if (hasOwn(partial, 'evaluationTask')) saveTask(evaluationTaskType, partial.evaluationTask);
  });

  function loadEvaluation() {
    const meta = db.prepare('SELECT * FROM evaluation_meta WHERE id = 1').get();
    if (!meta) throw new Error('AI评标数据库尚未初始化');
    return {
      ...initialState,
      technicalPlanDocument: loadDocument(),
      scoringItems: loadScoringItems(),
      runOptions: normalizeRunOptions(safeJsonParse(meta.run_options_json, initialState.runOptions)),
      evaluationResult: loadResult(evaluationResultType),
      evaluationTask: loadTasks().evaluationTask,
      activeTab: normalizeActiveTab(meta.active_tab),
    };
  }

  function updateEvaluationWithoutReload(partial) {
    const nextPartial = partial || {};
    const documentMutation = createDocumentMutation(nextPartial);
    writePreparedDocumentSync(documentMutation.preparedDocument);
    try {
      updateEvaluationTransaction(nextPartial, documentMutation);
    } catch (error) {
      if (documentMutation.preparedDocument) {
        runCleanupSync(() => fs.rmSync(documentMutation.preparedDocument.absolutePath, { force: true }));
      }
      throw error;
    }
    void cleanupDocumentMutation(documentMutation);
  }

  async function updateEvaluationWithAsyncFiles(partial) {
    const nextPartial = partial || {};
    const documentMutation = createDocumentMutation(nextPartial);
    await writePreparedDocument(documentMutation.preparedDocument);
    try {
      updateEvaluationTransaction(nextPartial, documentMutation);
    } catch (error) {
      if (documentMutation.preparedDocument) {
        await runCleanup(() => fs.promises.rm(documentMutation.preparedDocument.absolutePath, { force: true }));
      }
      throw error;
    }
    await cleanupDocumentMutation(documentMutation);
  }

  function updateEvaluation(partial) {
    updateEvaluationWithoutReload(partial);
  }

  function assembleOutlineDocument(outline) {
    const parts = [];
    function walk(items, level) {
      for (const item of Array.isArray(items) ? items : []) {
        const title = String(item?.title || '').trim();
        const content = String(item?.content || '').trim();
        const children = Array.isArray(item?.children) ? item.children : [];
        const heading = title ? `${'#'.repeat(Math.min(level + 1, 6))} ${title}` : '';
        if (children.length) {
          if (heading) parts.push(heading);
          walk(children, level + 1);
        } else {
          if (heading) parts.push(heading);
          if (content) parts.push(content);
        }
      }
    }
    walk(outline, 0);
    return parts.join('\n\n');
  }

  async function runBeforeCommit(beforeCommit) {
    if (typeof beforeCommit === 'function') {
      await beforeCommit();
    }
  }

  async function importFromTechnicalPlan(options = {}) {
    if (!technicalPlanStore?.loadTechnicalPlan) {
      throw new Error('技术方案缓存接口尚未初始化');
    }
    await runBeforeCommit(options.beforeCommit);
    const technicalPlan = technicalPlanStore.loadTechnicalPlan();
    const scoringItemsContent = stripTripleQuoteWrapper(String(technicalPlan?.techRequirements || ''));
    const documentContent = assembleOutlineDocument(technicalPlan?.outlineData?.outline);
    if (!scoringItemsContent.trim() && !documentContent.trim()) {
      return { success: false, message: '技术方案中暂无评分标准与正文，请先完成招标解析与正文生成' };
    }
    const timestamp = now();
    const technicalPlanDocument = documentContent.trim() ? {
      id: technicalPlanDocumentId,
      role: technicalPlanDocumentRole,
      fileName: '技术方案正文',
      content: documentContent,
      source: 'technical-plan',
      importedAt: timestamp,
    } : null;
    const scoringItems = {
      status: scoringItemsContent.trim() ? 'success' : 'idle',
      content: scoringItemsContent,
      source: 'technical-plan',
      updatedAt: timestamp,
    };
    await updateEvaluationWithAsyncFiles({
      technicalPlanDocument,
      scoringItems,
    });
    return { success: true, message: '已从技术方案导入评分标准与正文' };
  }

  async function clearEvaluation() {
    const rows = db.prepare('SELECT * FROM evaluation_documents').all();
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM evaluation_score_items').run();
      db.prepare('DELETE FROM evaluation_results').run();
      db.prepare('DELETE FROM evaluation_tasks').run();
      db.prepare('DELETE FROM evaluation_documents').run();
      db.prepare('DELETE FROM evaluation_meta').run();
      ensureMetaRow();
    });
    transaction();
    await removeMarkdownRows(rows);
    await runCleanup(() => fs.promises.rm(evaluationDir, { recursive: true, force: true }));
    return { success: true, message: 'AI评标缓存已清空' };
  }

  fs.mkdirSync(evaluationDir, { recursive: true });
  ensureMetaRow();

  return {
    loadEvaluation,
    updateEvaluation,
    updateEvaluationWithoutReload,
    clearEvaluation,
    importFromTechnicalPlan,
    readDocumentMarkdown,
    createDocumentSignature,
    createEvaluationInputSignature,
  };
}

module.exports = {
  createEvaluationStore,
  createDocumentSignature,
  createEvaluationInputSignature,
};
