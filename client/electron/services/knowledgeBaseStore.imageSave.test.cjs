const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createKnowledgeBaseStore } = require('./knowledgeBaseStore.cjs');

// saveMatchResult 落库时图条目字段（item_kind / image_type / asset_url）必须持久化，
// 否则 readReferences 与检索无法区分图条目，配图复用链路整体失效。
test('saveMatchResult persists image item columns', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE knowledge_folders (
      folder_id TEXT PRIMARY KEY, name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_documents (
      document_id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, file_name TEXT NOT NULL,
      status TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
      item_count INTEGER, block_count INTEGER, filtered_block_count INTEGER, candidate_item_count INTEGER,
      discarded_block_count INTEGER, system_discarded_after_retry_count INTEGER, last_batch_size INTEGER
    );
    CREATE TABLE knowledge_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, item_id TEXT NOT NULL,
      title TEXT NOT NULL, resume TEXT NOT NULL, content TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
      source_file TEXT, content_chars INTEGER NOT NULL DEFAULT 0,
      item_kind TEXT NOT NULL DEFAULT 'text', image_type TEXT, asset_url TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_item_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, item_id TEXT NOT NULL,
      block_id TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE knowledge_candidate_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, item_id TEXT NOT NULL,
      title TEXT NOT NULL, summary TEXT NOT NULL, source TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_reports (
      document_id TEXT PRIMARY KEY, total_blocks INTEGER, filtered_blocks_count INTEGER,
      candidate_items_count INTEGER, final_items_count INTEGER, matched_blocks_count INTEGER,
      discarded_blocks_count INTEGER, system_discarded_after_retry_count INTEGER,
      new_items_from_recovery_count INTEGER, recovery_attempt_count INTEGER, batch_size INTEGER,
      coverage_rate REAL, matched_rate REAL, created_at TEXT
    );
    CREATE TABLE knowledge_discarded_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, source TEXT NOT NULL,
      reason TEXT NOT NULL, block_ids_json TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare('INSERT INTO knowledge_documents (document_id, folder_id, file_name, status, sort_order, updated_at) VALUES (?, ?, ?, ?, 0, ?)').run('doc-a', 'folder-a', '实施方案.docx', 'success', '2026-02-01');

  const app = { getPath: () => path.join(os.tmpdir(), '知识库图片落库回归') };
  const store = createKnowledgeBaseStore({ app, db });

  store.saveMatchResult('doc-a', {
    candidateItems: [],
    matchResult: { discarded: [], system_discarded_after_retry: [] },
    report: null,
    finalItems: [
      { id: 'K000001', title: '文字条目', resume: '文字摘要', content: '正文内容', source_block_ids: ['block-1'] },
      {
        id: 'K000002',
        title: '配电箱接线示意图',
        resume: '配电箱内部接线方式说明',
        content: '![配电箱接线示意图](yibiao-asset://imported-images/batch-a/picture-01.png)',
        item_kind: 'image',
        image_type: '工程图示',
        asset_url: 'yibiao-asset://imported-images/batch-a/picture-01.png',
        source_file: '实施方案.docx',
        source_block_ids: ['block-2'],
      },
    ],
  });

  const rows = db.prepare('SELECT * FROM knowledge_items ORDER BY sort_order ASC').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].item_kind, 'text');
  assert.equal(rows[0].image_type, null);
  assert.equal(rows[0].asset_url, null);
  assert.equal(rows[1].item_kind, 'image');
  assert.equal(rows[1].image_type, '工程图示');
  assert.equal(rows[1].asset_url, 'yibiao-asset://imported-images/batch-a/picture-01.png');

  const references = store.readReferences(['doc-a']);
  const items = references[0].items;
  assert.equal(items.length, 2);
  const imageItem = items.find((item) => item.id === 'K000002');
  assert.equal(imageItem.item_kind, 'image');
  assert.equal(imageItem.image_type, '工程图示');
  assert.equal(imageItem.asset_url, 'yibiao-asset://imported-images/batch-a/picture-01.png');
  assert.equal(imageItem.source_file, '实施方案.docx');
});
