/**
 * 标书导入与目录提取服务（bidImprovementService）
 *
 * 面向「标书完成后提质」场景：把一份已写好的标书（投标文件 / 招标文件）导入为
 * Markdown，提取目录树作为简化结构持久化，并桥接到废标项检查与 AI 评标。
 *
 * 职责边界：
 * - importDocument(filePath, role)  解析文档 -> 提取目录 -> 存 Store -> 返回文档 ID
 * - exportDocument(documentId)      读取目录树 -> 组装 -> 复用 exportService 导出 Word
 * - bridgeToRejectionCheck(documentId)  读取文档 -> 复用 rejectionCheckStore.importDocument
 * - bridgeToEvaluation(documentId)      读取文档 -> 复用 evaluationStore.importFromCustomSource
 *
 * 说明：
 * - 文档 Markdown 落盘到 workspace/bid-improvement/documents/<id>.md，元数据与目录树
 *   存 SQLite 表 bid_improvement_documents（服务自建，幂等）。
 * - 目录树为简化结构 { id, title, level, content, children }，叶子节点带 content，
 *   分支节点带 children，与 exportService 的 payload.outline 同构。
 * - evaluationStore 需提供 importFromCustomSource 接口；当前仓库若尚未提供，桥接会抛出
 *   明确错误，接入方补齐该接口后即生效。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getWorkspaceDir } = require('../utils/paths.cjs');

const DOCUMENT_TABLE = 'bid_improvement_documents';
const POLISH_HISTORY_TABLE = 'bid_improvement_polish_history';
const WORKSPACE_STATE_TABLE = 'bid_improvement_workspace_state';

function now() {
  return new Date().toISOString();
}

function normalizeRole(role) {
  return role === 'bid' ? 'bid' : 'tender';
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getBidImprovementDir(app) {
  return path.join(getWorkspaceDir(app), 'bid-improvement');
}

function getDocumentsDir(app) {
  return path.join(getBidImprovementDir(app), 'documents');
}

function getDocumentMarkdownPath(app, documentId) {
  const safe = String(documentId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getDocumentsDir(app), `${safe}.md`);
}

function createDocumentId(markdown, fileName) {
  const hash = crypto.createHash('sha256').update(String(markdown || '')).digest('hex').slice(0, 12);
  const stamp = Date.now().toString(36);
  return `bid-imp-${stamp}-${hash}`;
}

/** 去掉标题中的 Markdown 强调符号与尾部井号，压缩空白。 */
function cleanTitle(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/[*_~`>]/g, '')
    .replace(/\s+#+\s*$/g, '')
    .trim();
}

/**
 * 从 Markdown 提取目录树（仅标题结构，正文挂到最近的标题下）。
 * 返回顶层节点数组；整篇无标题时退化为单个叶子节点。
 */
function extractOutlineTree(markdown, options = {}) {
  const defaultTitle = String(options.title || '').trim();
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const root = { children: [] };
  const stack = [root];
  let inFence = false;
  let headingCount = 0;
  let nodeCounter = 0;

  const appendText = (node, text) => {
    node.content = node.content ? `${node.content}\n${text}` : text;
  };

  for (const line of lines) {
    // 代码块内的 # 不作为标题处理
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      appendText(stack[stack.length - 1], line);
      continue;
    }
    if (inFence) {
      appendText(stack[stack.length - 1], line);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!heading) {
      appendText(stack[stack.length - 1], line);
      continue;
    }

    const level = heading[1].length;
    const title = cleanTitle(heading[2]);
    if (!title) {
      appendText(stack[stack.length - 1], line);
      continue;
    }

    headingCount += 1;
    nodeCounter += 1;
    const node = { id: `node-${nodeCounter}`, title, level, content: '', children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  if (headingCount === 0) {
    const content = String(root.content || '').trim();
    return content
      ? [{ id: 'doc', title: defaultTitle || '标书文档', level: 1, content, children: [] }]
      : [];
  }
  return root.children;
}

/** 归一化目录树：叶子不带 children，正文统一 trim。 */
function normalizeTree(nodes) {
  return (Array.isArray(nodes) ? nodes : []).map((node) => {
    const children = normalizeTree(node.children || []);
    const normalized = {
      id: String(node.id || ''),
      title: String(node.title || '').trim(),
      level: Math.max(1, Number(node.level) || 1),
      content: String(node.content || '').trim(),
    };
    if (children.length) normalized.children = children;
    return normalized;
  });
}

/** 从目录树重新组装 Markdown（与 evaluationStore.assembleOutlineDocument 同构）。 */
function assembleMarkdown(outline) {
  const parts = [];
  function walk(items, level) {
    for (const item of Array.isArray(items) ? items : []) {
      const title = String(item?.title || '').trim();
      const content = String(item?.content || '').trim();
      const children = Array.isArray(item?.children) ? item.children : [];
      if (title) parts.push(`${'#'.repeat(Math.min(level + 1, 6))} ${title}`);
      if (children.length) {
        walk(children, level + 1);
      } else if (content) {
        parts.push(content);
      }
    }
  }
  walk(outline, 0);
  return parts.join('\n\n');
}

function createBidImprovementService({ app, db, fileService, exportService, rejectionCheckStore, evaluationStore }) {
  if (!app) throw new Error('bidImprovementService: 缺少 app');
  if (!db) throw new Error('bidImprovementService: 缺少 db');

  const documentsDir = getDocumentsDir(app);
  fs.mkdirSync(documentsDir, { recursive: true });

  function ensureSchema() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${DOCUMENT_TABLE} (
        document_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        file_name TEXT NOT NULL,
        source_path TEXT,
        markdown_path TEXT NOT NULL,
        outline_json TEXT,
        content_hash TEXT NOT NULL,
        content_chars INTEGER NOT NULL DEFAULT 0,
        parser_label TEXT,
        imported_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${POLISH_HISTORY_TABLE} (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        original_content TEXT NOT NULL,
        polished_content TEXT NOT NULL,
        polish_goal TEXT NOT NULL,
        accepted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${WORKSPACE_STATE_TABLE} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  ensureSchema();

  function rowToDocument(row) {
    if (!row) return null;
    const markdownPath = path.isAbsolute(row.markdown_path)
      ? row.markdown_path
      : path.join(getWorkspaceDir(app), row.markdown_path);
    return {
      id: row.document_id,
      role: row.role,
      fileName: row.file_name,
      sourcePath: row.source_path || '',
      content: fs.existsSync(markdownPath) ? fs.readFileSync(markdownPath, 'utf8') : '',
      outline: safeJsonParse(row.outline_json, []),
      parserLabel: row.parser_label || undefined,
      importedAt: row.imported_at,
    };
  }

  function loadDocument(documentId) {
    const row = db.prepare(`SELECT * FROM ${DOCUMENT_TABLE} WHERE document_id = ?`).get(String(documentId || ''));
    return rowToDocument(row);
  }

  function listDocuments() {
    return db.prepare(`SELECT * FROM ${DOCUMENT_TABLE} ORDER BY imported_at DESC`).all().map(rowToDocument);
  }

  function readDocumentMarkdown(documentId) {
    const document = loadDocument(documentId);
    return document ? document.content : '';
  }

  function saveDocument({ role, fileName, sourcePath, markdown, outlineTree, parserLabel }) {
    const documentId = createDocumentId(markdown, fileName);
    const markdownPath = getDocumentMarkdownPath(app, documentId);
    fs.writeFileSync(markdownPath, `${markdown}\n`, 'utf8');
    const timestamp = now();
    db.prepare(`
      INSERT INTO ${DOCUMENT_TABLE} (
        document_id, role, file_name, source_path, markdown_path, outline_json,
        content_hash, content_chars, parser_label, imported_at, updated_at
      ) VALUES (
        @document_id, @role, @file_name, @source_path, @markdown_path, @outline_json,
        @content_hash, @content_chars, @parser_label, @imported_at, @updated_at
      ) ON CONFLICT(document_id) DO UPDATE SET
        role = excluded.role,
        file_name = excluded.file_name,
        source_path = excluded.source_path,
        markdown_path = excluded.markdown_path,
        outline_json = excluded.outline_json,
        content_hash = excluded.content_hash,
        content_chars = excluded.content_chars,
        parser_label = excluded.parser_label,
        updated_at = excluded.updated_at
    `).run({
      document_id: documentId,
      role,
      file_name: fileName,
      source_path: sourcePath || null,
      markdown_path: markdownPath,
      outline_json: JSON.stringify(outlineTree || []),
      content_hash: crypto.createHash('sha256').update(String(markdown || '')).digest('hex'),
      content_chars: String(markdown || '').length,
      parser_label: parserLabel || null,
      imported_at: timestamp,
      updated_at: timestamp,
    });
    return documentId;
  }

  function removeDocument(documentId) {
    const document = loadDocument(documentId);
    if (!document) return { success: false, message: '未找到该文档' };
    db.prepare(`DELETE FROM ${DOCUMENT_TABLE} WHERE document_id = ?`).run(document.id);
    try {
      fs.rmSync(getDocumentMarkdownPath(app, document.id), { force: true });
    } catch (error) {
      console.warn('[bid-improvement] 清理文档 Markdown 失败:', error?.message || String(error));
    }
    return { success: true, message: '已删除文档' };
  }

  // ---- 目录树编辑 / 润色历史 / 工作区状态 ----

  /** 在目录树中按 nodeId 更新节点正文；未命中时返回 null。 */
  function updateNodeContentInTree(nodes, nodeId, content) {
    let replaced = false;
    const walk = (items) => (Array.isArray(items) ? items : []).map((node) => {
      if (node.id === nodeId) {
        replaced = true;
        return { ...node, content };
      }
      if (Array.isArray(node.children) && node.children.length) {
        return { ...node, children: walk(node.children) };
      }
      return node;
    });
    const next = walk(nodes);
    return replaced ? next : null;
  }

  /** 在目录树中查找节点。 */
  function findNodeInTree(nodes, nodeId) {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (node.id === nodeId) return node;
      const found = findNodeInTree(node.children || [], nodeId);
      if (found) return found;
    }
    return null;
  }

  /** 按 nodeId 定位所属文档 ID（优先活动文档，其次按导入顺序回退）。 */
  function resolveDocumentIdByNodeId(nodeId) {
    const state = readWorkspaceState();
    if (state.activeDocumentId) {
      const active = loadDocument(state.activeDocumentId);
      if (active && findNodeInTree(active.outline, nodeId)) return active.id;
    }
    for (const document of listDocuments()) {
      if (findNodeInTree(document.outline, nodeId)) return document.id;
    }
    return null;
  }

  /** 将更新后的目录树持久化回 outline_json 与 Markdown 文件。 */
  function persistDocumentOutline(documentId, outline) {
    const markdown = assembleMarkdown(outline);
    const markdownPath = getDocumentMarkdownPath(app, documentId);
    fs.writeFileSync(markdownPath, `${markdown}\n`, 'utf8');
    db.prepare(`
      UPDATE ${DOCUMENT_TABLE}
      SET outline_json = @outline_json,
          content_hash = @content_hash,
          content_chars = @content_chars,
          updated_at = @updated_at
      WHERE document_id = @document_id
    `).run({
      document_id: documentId,
      outline_json: JSON.stringify(outline),
      content_hash: crypto.createHash('sha256').update(String(markdown)).digest('hex'),
      content_chars: String(markdown).length,
      updated_at: now(),
    });
  }

  function getOutlineNodes(documentId) {
    const document = loadDocument(documentId);
    return document?.outline ?? [];
  }

  function updateNodeContent(nodeId, content) {
    const normalizedNodeId = String(nodeId || '');
    if (!normalizedNodeId) return { success: false, message: '缺少目录节点 ID' };
    const documentId = resolveDocumentIdByNodeId(normalizedNodeId);
    if (!documentId) return { success: false, message: '未找到该目录节点' };
    const document = loadDocument(documentId);
    const nextOutline = updateNodeContentInTree(document.outline, normalizedNodeId, String(content ?? ''));
    if (!nextOutline) return { success: false, message: '未找到该目录节点' };
    persistDocumentOutline(documentId, nextOutline);
    return { success: true };
  }

  function getPolishHistory(nodeId) {
    const rows = db.prepare(`SELECT * FROM ${POLISH_HISTORY_TABLE} WHERE node_id = ? ORDER BY created_at DESC`).all(String(nodeId || ''));
    return rows.map((row) => ({
      id: row.id,
      nodeId: row.node_id,
      originalContent: row.original_content,
      polishedContent: row.polished_content,
      polishGoal: row.polish_goal,
      accepted: Boolean(row.accepted),
      createdAt: row.created_at,
    }));
  }

  function savePolishResult(result) {
    const nodeId = String(result?.nodeId || '');
    const polishedContent = String(result?.polishedContent ?? '');
    const polishGoal = String(result?.polishGoal ?? '');
    const accepted = Boolean(result?.accepted);
    if (!nodeId) return { success: false, message: '缺少目录节点 ID' };

    const documentId = resolveDocumentIdByNodeId(nodeId);
    if (!documentId) return { success: false, message: '未找到该目录节点' };
    const document = loadDocument(documentId);
    const node = findNodeInTree(document.outline, nodeId);
    const originalContent = String(node?.content ?? '').trim();

    db.prepare(`
      INSERT INTO ${POLISH_HISTORY_TABLE} (id, node_id, original_content, polished_content, polish_goal, accepted, created_at)
      VALUES (@id, @node_id, @original_content, @polished_content, @polish_goal, @accepted, @created_at)
    `).run({
      id: `polish-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      node_id: nodeId,
      original_content: originalContent,
      polished_content: polishedContent,
      polish_goal: polishGoal,
      accepted: accepted ? 1 : 0,
      created_at: now(),
    });

    if (accepted && polishedContent) {
      const nextOutline = updateNodeContentInTree(document.outline, nodeId, polishedContent);
      if (nextOutline) persistDocumentOutline(documentId, nextOutline);
    }
    return { success: true };
  }

  function readWorkspaceState() {
    const row = db.prepare(`SELECT value FROM ${WORKSPACE_STATE_TABLE} WHERE key = 'default'`).get();
    const value = safeJsonParse(row?.value, {});
    return {
      activeDocumentId: value.activeDocumentId ?? null,
      activeNodeId: value.activeNodeId ?? null,
      selectedNodeIds: Array.isArray(value.selectedNodeIds) ? value.selectedNodeIds : [],
    };
  }

  function getWorkspaceState() {
    return {
      documents: listDocuments(),
      ...readWorkspaceState(),
    };
  }

  function updateWorkspaceState(patch) {
    const current = readWorkspaceState();
    const next = {
      activeDocumentId: patch?.activeDocumentId !== undefined ? patch.activeDocumentId : current.activeDocumentId,
      activeNodeId: patch?.activeNodeId !== undefined ? patch.activeNodeId : current.activeNodeId,
      selectedNodeIds: Array.isArray(patch?.selectedNodeIds) ? patch.selectedNodeIds : current.selectedNodeIds,
    };
    db.prepare(`
      INSERT INTO ${WORKSPACE_STATE_TABLE} (key, value, updated_at)
      VALUES ('default', @value, @updated_at)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run({ value: JSON.stringify(next), updated_at: now() });
  }

  function clear() {
    for (const document of listDocuments()) {
      try {
        fs.rmSync(getDocumentMarkdownPath(app, document.id), { force: true });
      } catch (error) {
        console.warn('[bid-improvement] 清理文档 Markdown 失败:', error?.message || String(error));
      }
    }
    db.prepare(`DELETE FROM ${DOCUMENT_TABLE}`).run();
    db.prepare(`DELETE FROM ${POLISH_HISTORY_TABLE}`).run();
    db.prepare(`DELETE FROM ${WORKSPACE_STATE_TABLE}`).run();
    return { success: true };
  }

  /**
   * 导入文档：解析为 Markdown -> 提取目录树 -> 存 Store -> 返回文档 ID。
   * @param {string} filePath 待导入文件的绝对路径
   * @param {'bid'|'tender'} role 文档角色
   */
  async function importDocument(filePath, role) {
    const documentRole = normalizeRole(role);
    if (!fileService) {
      throw new Error('文件解析服务尚未初始化');
    }
    const label = documentRole === 'bid' ? '投标文件' : '招标文件';
    let result;
    if (typeof fileService.importTechnicalPlanDocument === 'function') {
      result = await fileService.importTechnicalPlanDocument(label, {
        filePaths: [filePath],
        multiple: false,
        assetScopePrefix: 'bid-improvement',
      });
    } else if (typeof fileService.importDocument === 'function') {
      result = await fileService.importDocument({ filePaths: [filePath], multiple: false, assetScopePrefix: 'bid-improvement' });
    } else {
      throw new Error('文件解析服务缺少导入接口');
    }

    if (!result?.success) {
      return { success: false, message: result?.message || '导入失败' };
    }
    const first = Array.isArray(result.documents) && result.documents.length ? result.documents[0] : result;
    const markdown = String(first?.file_content || result?.file_content || '').trim();
    if (!markdown) {
      return { success: false, message: '未提取到有效 Markdown 内容' };
    }

    const fileName = first?.file_name || result?.file_name || path.basename(filePath);
    const outlineTree = normalizeTree(extractOutlineTree(markdown, { title: fileName }));
    const documentId = saveDocument({
      role: documentRole,
      fileName,
      sourcePath: filePath,
      markdown,
      outlineTree,
      parserLabel: first?.parser_label || result?.parser_label,
    });
    return {
      success: true,
      documentId,
      fileName,
      role: documentRole,
      outline: outlineTree,
      message: '导入成功',
    };
  }

  /**
   * 导出文档：读取目录树 -> 组装 -> 复用 exportService 导出 Word。
   */
  async function exportDocument(documentId, options = {}) {
    if (!exportService?.exportWord) {
      throw new Error('导出服务尚未初始化');
    }
    const document = loadDocument(documentId);
    if (!document) {
      return { success: false, message: '未找到该文档' };
    }
    const outline = Array.isArray(document.outline) && document.outline.length
      ? document.outline
      : [{ title: document.fileName || '标书文档', content: document.content }];
    const payload = {
      project_name: options.projectName || document.fileName || '标书文档',
      outline,
      ...(options.payload || {}),
    };
    return exportService.exportWord(payload, options.onProgress);
  }

  /**
   * 桥接到废标项检查：读取文档后，复用 rejectionCheckStore.importDocument 重新导入。
   * 依赖原始文件路径（rejectionCheckStore 按文件路径解析入库）。
   */
  async function bridgeToRejectionCheck(documentId, options = {}) {
    if (!rejectionCheckStore?.importDocument) {
      throw new Error('废标检查服务尚未初始化');
    }
    const document = loadDocument(documentId);
    if (!document) {
      return { success: false, message: '未找到该文档' };
    }
    if (!document.sourcePath) {
      return { success: false, message: '该文档缺少原始文件路径，无法桥接废标检查' };
    }
    const result = await rejectionCheckStore.importDocument(document.role, [document.sourcePath], options);
    return {
      success: Boolean(result?.success),
      message: result?.message || (result?.success ? '已导入废标检查' : '导入废标检查失败'),
      result,
    };
  }

  /**
   * 桥接到 AI 评标：读取文档内容后，调用 evaluationStore.importFromCustomSource。
   * 依赖 evaluationStore 提供 importFromCustomSource 接口（缺失时抛出明确错误）。
   */
  async function bridgeToEvaluation(documentId, options = {}) {
    if (!evaluationStore) {
      throw new Error('AI评标服务尚未初始化');
    }
    const document = loadDocument(documentId);
    if (!document) {
      return { success: false, message: '未找到该文档' };
    }
    if (typeof evaluationStore.importFromCustomSource !== 'function') {
      throw new Error('AI评标服务尚未提供 importFromCustomSource 接口');
    }
    const result = await evaluationStore.importFromCustomSource({
      document: {
        id: document.id,
        role: document.role,
        fileName: document.fileName,
        content: document.content,
        source: 'bid-improvement',
        importedAt: document.importedAt,
      },
      ...options,
    });
    return {
      success: Boolean(result?.success),
      message: result?.message || (result?.success ? '已导入AI评标' : '导入AI评标失败'),
      result,
    };
  }

  return {
    importDocument,
    exportDocument,
    bridgeToRejectionCheck,
    bridgeToEvaluation,
    getDocument: loadDocument,
    getAllDocuments: listDocuments,
    deleteDocument: removeDocument,
    getOutlineNodes,
    updateNodeContent,
    getPolishHistory,
    savePolishResult,
    getWorkspaceState,
    updateWorkspaceState,
    clear,
  };
}

module.exports = {
  createBidImprovementService,
  extractOutlineTree,
  normalizeTree,
  assembleMarkdown,
};
