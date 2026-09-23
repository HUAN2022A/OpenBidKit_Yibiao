/**
 * 标书改进（bid-improvement）Store 服务。
 *
 * 面向「完成态标书提质」场景的持久化层，负责把已导入标书拆分为
 * 文档（documents）、目录节点（outline nodes）、润色历史（polish history）
 * 与工作区 UI 状态（workspace state）四类数据落 SQLite。
 *
 * 设计要点：
 * - 与 rejectionCheckStore / evaluationStore 同构的闭包工厂模式，仅依赖 db，
 *   不触碰文件系统（文档 Markdown 正文直接存 SQLite 的 content 列）。
 * - 目录树扁平化用 sort_order 保持兄弟顺序，重建树用 parent_id 组装 children。
 * - 目录节点 node_id 全局唯一（updateNodeContent / getNodeById 仅凭 nodeId 定位，
 *   因此导入方生成节点 id 时需保证跨文档唯一；saveOutlineNodes 会检测跨文档冲突并抛错）。
 * - 所有多语句写操作包在 db.transaction 内保证原子性；错误以清晰中文消息抛出。
 */

const crypto = require('node:crypto');

const DOCUMENT_TABLE = 'bid_improvement_documents';
const NODE_TABLE = 'bid_improvement_nodes';
const HISTORY_TABLE = 'bid_improvement_polish_history';
const META_TABLE = 'bid_improvement_meta';

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

function toDbBool(value) {
  return value ? 1 : 0;
}

function fromDbBool(value) {
  return Number(value) === 1;
}

function normalizeRole(role) {
  return role === 'bid' ? 'bid' : 'tender';
}

function createBidImprovementStore(db) {
  if (!db) throw new Error('bidImprovementStore: 缺少 db');

  function log(level, message, error) {
    const text = `[bid-improvement] ${message}`;
    if (level === 'error') {
      if (error) console.error(text, error);
      else console.error(text);
    } else {
      if (error) console.warn(text, error);
      else console.warn(text);
    }
  }

  function ensureSchema() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${DOCUMENT_TABLE} (
        document_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        file_name TEXT NOT NULL,
        source_path TEXT,
        content TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL,
        content_chars INTEGER NOT NULL DEFAULT 0,
        parser_label TEXT,
        imported_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${NODE_TABLE} (
        node_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        parent_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bid_improvement_nodes_document ON ${NODE_TABLE}(document_id);

      CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
        history_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        original_content TEXT NOT NULL,
        polished_content TEXT NOT NULL,
        polish_goal TEXT NOT NULL,
        accepted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bid_improvement_history_node ON ${HISTORY_TABLE}(node_id);
      CREATE INDEX IF NOT EXISTS idx_bid_improvement_history_document ON ${HISTORY_TABLE}(document_id);

      CREATE TABLE IF NOT EXISTS ${META_TABLE} (
        id INTEGER PRIMARY KEY,
        active_document_id TEXT,
        active_node_id TEXT,
        selected_node_ids_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  ensureSchema();

  function ensureMetaRow() {
    const existing = db.prepare(`SELECT * FROM ${META_TABLE} WHERE id = 1`).get();
    if (existing) return existing;
    const timestamp = now();
    db.prepare(`
      INSERT INTO ${META_TABLE} (id, active_document_id, active_node_id, selected_node_ids_json, created_at, updated_at)
      VALUES (1, NULL, NULL, NULL, @created_at, @updated_at)
    `).run({ created_at: timestamp, updated_at: timestamp });
    return db.prepare(`SELECT * FROM ${META_TABLE} WHERE id = 1`).get();
  }

  function updateMeta(fields) {
    ensureMetaRow();
    const entries = Object.entries(fields || {}).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE ${META_TABLE} SET ${assignments}, updated_at = @updated_at WHERE id = 1`).run({
      ...Object.fromEntries(entries),
      updated_at: now(),
    });
  }

  // ---- 目录树序列化 ----

  /** 递归扁平化目录树：sort_order 记录兄弟顺序，parent_id 供重建树用。 */
  function flattenOutlineNodes(nodes, documentId, parentId = null, level = 1, rows = []) {
    (Array.isArray(nodes) ? nodes : []).forEach((node, index) => {
      const nodeId = String(node?.id || '').trim();
      if (!nodeId) return;
      rows.push({
        node_id: nodeId,
        document_id: documentId,
        parent_id: parentId,
        sort_order: index,
        level: Math.max(1, Number(node?.level) || level),
        title: String(node?.title || '').trim(),
        content: String(node?.content || ''),
      });
      if (Array.isArray(node?.children) && node.children.length) {
        flattenOutlineNodes(node.children, documentId, nodeId, level + 1, rows);
      }
    });
    return rows;
  }

  /** 由扁平行重建树形结构（按 parent_id 组装 children，sort_order 保持顺序）。 */
  function buildOutlineTree(rows) {
    if (!rows.length) return [];
    const map = new Map();
    for (const row of rows) {
      map.set(row.node_id, {
        id: row.node_id,
        title: row.title,
        level: Number(row.level) || 1,
        content: row.content || '',
        _sortOrder: Number(row.sort_order) || 0,
        children: [],
      });
    }

    const roots = [];
    for (const row of rows) {
      const node = map.get(row.node_id);
      if (row.parent_id && map.has(row.parent_id)) {
        map.get(row.parent_id).children.push(node);
      } else {
        roots.push(node);
      }
    }

    const sortRecursive = (node) => {
      if (node.children.length) {
        node.children.sort((a, b) => a._sortOrder - b._sortOrder);
        node.children.forEach(sortRecursive);
      }
    };
    roots.sort((a, b) => a._sortOrder - b._sortOrder);
    roots.forEach(sortRecursive);

    const cleanup = (node) => {
      delete node._sortOrder;
      if (node.children.length) {
        node.children.forEach(cleanup);
      } else {
        delete node.children;
      }
      return node;
    };
    return roots.map(cleanup);
  }

  // ---- 文档管理 ----

  function documentFromRow(row) {
    if (!row) return null;
    return {
      id: row.document_id,
      role: normalizeRole(row.role),
      fileName: row.file_name,
      sourcePath: row.source_path || undefined,
      content: row.content || '',
      outline: getOutlineNodes(row.document_id),
      parserLabel: row.parser_label || undefined,
      importedAt: row.imported_at || undefined,
    };
  }

  function generateDocumentId(content, fileName) {
    const hash = stableHash(content).slice(0, 12);
    const stamp = Date.now().toString(36);
    return `bid-imp-${stamp}-${hash}`;
  }

  /** 保存文档（upsert）；传入 outline 时在同一事务内一并替换该文档的目录节点。 */
  function saveDocument(document) {
    if (!document || typeof document !== 'object') {
      throw new Error('保存文档失败：文档数据缺失');
    }
    const content = String(document.content || '');
    const documentId = String(document.id || '').trim() || generateDocumentId(content, document.fileName);
    const role = normalizeRole(document.role);
    const timestamp = now();
    const values = {
      document_id: documentId,
      role,
      file_name: String(document.fileName || (role === 'bid' ? '投标文件' : '招标文件')),
      source_path: document.sourcePath ? String(document.sourcePath) : null,
      content,
      content_hash: stableHash(content),
      content_chars: content.length,
      parser_label: document.parserLabel ? String(document.parserLabel) : null,
      imported_at: document.importedAt || timestamp,
      updated_at: timestamp,
    };
    const saveRow = () => {
      db.prepare(`
        INSERT INTO ${DOCUMENT_TABLE} (
          document_id, role, file_name, source_path, content, content_hash, content_chars, parser_label, imported_at, updated_at
        ) VALUES (
          @document_id, @role, @file_name, @source_path, @content, @content_hash, @content_chars, @parser_label, @imported_at, @updated_at
        ) ON CONFLICT(document_id) DO UPDATE SET
          role = excluded.role,
          file_name = excluded.file_name,
          source_path = excluded.source_path,
          content = excluded.content,
          content_hash = excluded.content_hash,
          content_chars = excluded.content_chars,
          parser_label = excluded.parser_label,
          updated_at = excluded.updated_at
      `).run(values);
    };
    if (hasOwn(document, 'outline')) {
      const transaction = db.transaction(() => {
        saveRow();
        replaceOutlineNodes(documentId, document.outline);
      });
      transaction();
    } else {
      saveRow();
    }
    return documentId;
  }

  function getDocument(documentId) {
    const row = db.prepare(`SELECT * FROM ${DOCUMENT_TABLE} WHERE document_id = ?`).get(String(documentId || ''));
    return documentFromRow(row);
  }

  function getAllDocuments() {
    return db.prepare(`SELECT * FROM ${DOCUMENT_TABLE} ORDER BY imported_at DESC, document_id ASC`).all()
      .map(documentFromRow);
  }

  /** 删除文档，并级联删除其目录节点与润色历史。 */
  function deleteDocument(documentId) {
    const id = String(documentId || '').trim();
    if (!id) return { success: false, message: '缺少文档 ID' };
    const existing = db.prepare(`SELECT 1 FROM ${DOCUMENT_TABLE} WHERE document_id = ?`).get(id);
    if (!existing) return { success: false, message: '未找到该文档' };
    const transaction = db.transaction(() => {
      db.prepare(`DELETE FROM ${HISTORY_TABLE} WHERE document_id = ?`).run(id);
      db.prepare(`DELETE FROM ${NODE_TABLE} WHERE document_id = ?`).run(id);
      db.prepare(`DELETE FROM ${DOCUMENT_TABLE} WHERE document_id = ?`).run(id);
      const meta = ensureMetaRow();
      if (meta.active_document_id === id) {
        updateMeta({ active_document_id: null, active_node_id: null, selected_node_ids_json: null });
      }
    });
    transaction();
    return { success: true, message: '已删除文档' };
  }

  // ---- 目录节点管理 ----

  /** 清空某文档旧节点后重写扁平行；检测跨文档的 node_id 冲突。 */
  function replaceOutlineNodes(documentId, nodes) {
    const docId = String(documentId || '');
    db.prepare(`DELETE FROM ${NODE_TABLE} WHERE document_id = ?`).run(docId);
    const rows = flattenOutlineNodes(nodes, docId);
    if (!rows.length) return 0;

    // node_id 需全局唯一：仅凭 nodeId 定位的 updateNodeContent / getNodeById 依赖这一点。
    const foreignOwners = new Map(
      db.prepare(`SELECT node_id, document_id FROM ${NODE_TABLE} WHERE document_id != ?`).all(docId)
        .map((row) => [row.node_id, row.document_id]),
    );
    for (const row of rows) {
      const owner = foreignOwners.get(row.node_id);
      if (owner) {
        throw new Error(`目录节点 ID 冲突：节点“${row.node_id}”已属于文档“${owner}”`);
      }
    }

    const timestamp = now();
    const insert = db.prepare(`
      INSERT INTO ${NODE_TABLE} (
        node_id, document_id, parent_id, sort_order, level, title, content, created_at, updated_at
      ) VALUES (
        @node_id, @document_id, @parent_id, @sort_order, @level, @title, @content, @created_at, @updated_at
      )
    `);
    for (const row of rows) {
      insert.run({ ...row, created_at: timestamp, updated_at: timestamp });
    }
    return rows.length;
  }

  function saveOutlineNodes(documentId, nodes) {
    const id = String(documentId || '').trim();
    if (!id) throw new Error('保存目录失败：缺少文档 ID');
    let count = 0;
    const transaction = db.transaction(() => {
      count = replaceOutlineNodes(id, nodes);
    });
    transaction();
    return count;
  }

  function getOutlineNodes(documentId) {
    const rows = db.prepare(`
      SELECT * FROM ${NODE_TABLE} WHERE document_id = ? ORDER BY level ASC, sort_order ASC, node_id ASC
    `).all(String(documentId || ''));
    return buildOutlineTree(rows);
  }

  function nodeFromRow(row) {
    if (!row) return null;
    return {
      id: row.node_id,
      documentId: row.document_id,
      title: row.title,
      level: Number(row.level) || 1,
      content: row.content || '',
    };
  }

  function getNodeById(nodeId) {
    const row = db.prepare(`SELECT * FROM ${NODE_TABLE} WHERE node_id = ?`).get(String(nodeId || ''));
    return nodeFromRow(row);
  }

  function updateNodeContent(nodeId, content) {
    const id = String(nodeId || '').trim();
    if (!id) return null;
    const existing = db.prepare(`SELECT 1 FROM ${NODE_TABLE} WHERE node_id = ?`).get(id);
    if (!existing) {
      log('warn', `更新节点正文失败：节点不存在（${id}）`);
      return null;
    }
    db.prepare(`UPDATE ${NODE_TABLE} SET content = ?, updated_at = ? WHERE node_id = ?`)
      .run(String(content || ''), now(), id);
    return getNodeById(id);
  }

  // ---- 润色历史 ----

  function historyFromRow(row) {
    if (!row) return null;
    return {
      id: row.history_id,
      documentId: row.document_id,
      nodeId: row.node_id,
      originalContent: row.original_content,
      polishedContent: row.polished_content,
      polishGoal: row.polish_goal,
      accepted: fromDbBool(row.accepted),
      createdAt: row.created_at,
    };
  }

  function generateHistoryId() {
    return `polish-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  }

  function resolveHistoryDocumentId(history) {
    if (history?.documentId) return String(history.documentId);
    const row = db.prepare(`SELECT document_id FROM ${NODE_TABLE} WHERE node_id = ?`).get(String(history?.nodeId || ''));
    return row?.document_id || '';
  }

  function savePolishHistory(history) {
    if (!history || typeof history !== 'object') {
      throw new Error('保存润色历史失败：历史记录缺失');
    }
    const nodeId = String(history.nodeId || '').trim();
    if (!nodeId) throw new Error('保存润色历史失败：缺少节点 ID');
    const documentId = resolveHistoryDocumentId(history);
    if (!documentId) throw new Error('保存润色历史失败：找不到节点所属文档');
    const historyId = String(history.id || '').trim() || generateHistoryId();
    const timestamp = now();
    db.prepare(`
      INSERT INTO ${HISTORY_TABLE} (
        history_id, document_id, node_id, original_content, polished_content, polish_goal, accepted, created_at, updated_at
      ) VALUES (
        @history_id, @document_id, @node_id, @original_content, @polished_content, @polish_goal, @accepted, @created_at, @updated_at
      ) ON CONFLICT(history_id) DO UPDATE SET
        document_id = excluded.document_id,
        node_id = excluded.node_id,
        original_content = excluded.original_content,
        polished_content = excluded.polished_content,
        polish_goal = excluded.polish_goal,
        accepted = excluded.accepted,
        updated_at = excluded.updated_at
    `).run({
      history_id: historyId,
      document_id: documentId,
      node_id: nodeId,
      original_content: String(history.originalContent || ''),
      polished_content: String(history.polishedContent || ''),
      polish_goal: String(history.polishGoal || ''),
      accepted: toDbBool(history.accepted),
      created_at: history.createdAt || timestamp,
      updated_at: timestamp,
    });
    return historyId;
  }

  function getPolishHistory(nodeId) {
    return db.prepare(`
      SELECT * FROM ${HISTORY_TABLE} WHERE node_id = ? ORDER BY created_at DESC, history_id ASC
    `).all(String(nodeId || '')).map(historyFromRow);
  }

  function markPolishAccepted(historyId, accepted) {
    const id = String(historyId || '').trim();
    if (!id) return { success: false, message: '缺少历史记录 ID' };
    const existing = db.prepare(`SELECT 1 FROM ${HISTORY_TABLE} WHERE history_id = ?`).get(id);
    if (!existing) return { success: false, message: '未找到该润色历史' };
    db.prepare(`UPDATE ${HISTORY_TABLE} SET accepted = ?, updated_at = ? WHERE history_id = ?`)
      .run(toDbBool(accepted), now(), id);
    return { success: true };
  }

  // ---- 工作区状态 ----

  function getWorkspaceState() {
    const meta = ensureMetaRow();
    return {
      documents: getAllDocuments(),
      activeDocumentId: meta.active_document_id || null,
      activeNodeId: meta.active_node_id || null,
      selectedNodeIds: safeJsonParse(meta.selected_node_ids_json, []),
    };
  }

  function updateWorkspaceState(patch) {
    const metaUpdates = {};
    if (hasOwn(patch, 'activeDocumentId')) {
      metaUpdates.active_document_id = patch.activeDocumentId ? String(patch.activeDocumentId) : null;
    }
    if (hasOwn(patch, 'activeNodeId')) {
      metaUpdates.active_node_id = patch.activeNodeId ? String(patch.activeNodeId) : null;
    }
    if (hasOwn(patch, 'selectedNodeIds')) {
      metaUpdates.selected_node_ids_json = jsonOrNull(
        (Array.isArray(patch.selectedNodeIds) ? patch.selectedNodeIds : [])
          .map((id) => String(id).trim())
          .filter(Boolean),
      );
    }
    if (Object.keys(metaUpdates).length) updateMeta(metaUpdates);
    return getWorkspaceState();
  }

  function clear() {
    const transaction = db.transaction(() => {
      db.prepare(`DELETE FROM ${HISTORY_TABLE}`).run();
      db.prepare(`DELETE FROM ${NODE_TABLE}`).run();
      db.prepare(`DELETE FROM ${DOCUMENT_TABLE}`).run();
      db.prepare(`DELETE FROM ${META_TABLE}`).run();
      ensureMetaRow();
    });
    transaction();
    return { success: true, message: '标书改进缓存已清空' };
  }

  ensureMetaRow();

  return {
    saveDocument,
    getDocument,
    getAllDocuments,
    deleteDocument,
    saveOutlineNodes,
    getOutlineNodes,
    updateNodeContent,
    getNodeById,
    savePolishHistory,
    getPolishHistory,
    markPolishAccepted,
    getWorkspaceState,
    updateWorkspaceState,
    clear,
  };
}

module.exports = {
  createBidImprovementStore,
};
