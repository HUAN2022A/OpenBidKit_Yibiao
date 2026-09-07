const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createKnowledgeBaseStore } = require('./knowledgeBaseStore.cjs');

function createFixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE knowledge_folders (
      folder_id TEXT PRIMARY KEY, name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_documents (
      document_id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, file_name TEXT NOT NULL,
      status TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, item_id TEXT NOT NULL,
      title TEXT NOT NULL, resume TEXT NOT NULL, content TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
      item_kind TEXT NOT NULL DEFAULT 'text', image_type TEXT, asset_url TEXT
    );
  `);
  db.prepare('INSERT INTO knowledge_folders VALUES (?, ?, 0, ?, ?)').run('folder-a', '项目资料', '2026-01-01', '2026-01-01');
  db.prepare('INSERT INTO knowledge_folders VALUES (?, ?, 1, ?, ?)').run('folder-b', '历史标书', '2026-01-01', '2026-01-01');
  db.prepare('INSERT INTO knowledge_documents VALUES (?, ?, ?, ?, 0, ?)').run('doc-a', 'folder-a', '实施方案.docx', 'success', '2026-02-01');
  db.prepare('INSERT INTO knowledge_documents VALUES (?, ?, ?, ?, 0, ?)').run('doc-b', 'folder-b', '运维说明.docx', 'success', '2026-01-15');
  db.prepare('INSERT INTO knowledge_documents VALUES (?, ?, ?, ?, 0, ?)').run('doc-c', 'folder-b', '处理中.docx', 'matching', '2026-03-01');
  const insertItem = db.prepare('INSERT INTO knowledge_items (document_id, item_id, title, resume, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  const insertImageItem = db.prepare('INSERT INTO knowledge_items (document_id, item_id, title, resume, content, sort_order, item_kind, image_type, asset_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insertItem.run('doc-a', 'A-1', '质量保证体系', '覆盖质量目标和检查机制', '方案正文包含质量保证关键字。', 0);
  insertItem.run('doc-b', 'B-1', '运维流程', '提供质量保证服务', '正文不含目标词。', 0);
  insertItem.run('doc-c', 'C-1', '质量保证草稿', '处理中内容', '不应被检索', 0);
  const app = { getPath: () => path.join(os.tmpdir(), '知识库分页回归') };
  return { db, insertItem, insertImageItem, store: createKnowledgeBaseStore({ app, db }) };
}

test('search preserves filename, title, resume and content matches and their priority', (t) => {
  const { store, insertItem } = createFixture(t);
  const byFilename = store.search({ keyword: '实施方案', page: 1 });
  assert.equal(byFilename.total, 1);
  assert.equal(byFilename.items[0].match_field, 'file_name');
  assert.equal(byFilename.items[0].file_name, '实施方案.docx');
  insertItem.run('doc-b', 'B-2', '检查措施', '专项检查', '质量保证正文命中', 1);
  const result = store.search({ keyword: '质量保证', page: 1 });
  assert.equal(result.total, 3);
  assert.deepEqual(result.items.map((item) => item.item_id), ['A-1', 'B-1', 'B-2']);
  assert.deepEqual(result.items.map((item) => item.match_field), ['title', 'resume', 'content']);
  assert.equal(result.items[0].folder_name, '项目资料');
  assert.match(result.items[1].snippet, /质量保证/);
  assert.match(result.items[2].snippet, /质量保证/);
});

test('search ignores unfinished documents and blank keywords', (t) => {
  const { store } = createFixture(t);
  assert.deepEqual(store.search({ keyword: '草稿', page: 1 }), { items: [], total: 0, page: 1, pageSize: 100 });
  assert.deepEqual(store.search({ keyword: '  ', page: 3 }), { items: [], total: 0, page: 1, pageSize: 100 });
});

test('all 235 filename matches remain accessible across documents without duplicates or omissions', (t) => {
  const { db, store, insertItem } = createFixture(t);
  db.exec("DELETE FROM knowledge_items; UPDATE knowledge_documents SET file_name = '公共资料.docx'");
  const expected = [];
  db.transaction(() => {
    for (let index = 0; index < 235; index += 1) {
      const itemId = `item-${index}`;
      expected.push(itemId);
      insertItem.run(index < 150 ? 'doc-a' : 'doc-b', itemId, '条目', '摘要', '正文', index);
    }
    insertItem.run('doc-c', 'unfinished', '条目', '摘要', '正文', 0);
  })();
  const pages = [1, 2, 3].map((page) => store.search({ keyword: '公共资料', page }));
  assert.deepEqual(pages.map((page) => page.total), [235, 235, 235]);
  assert.deepEqual(pages.map((page) => page.items.length), [100, 100, 35]);
  assert.deepEqual(pages.flatMap((page) => page.items.map((item) => item.item_id)), expected);
  assert.equal(pages[1].items[50].document_id, 'doc-b');
  assert.deepEqual(store.search({ keyword: '公共资料', page: 2 }), pages[1]);
});

test('page boundaries follow 100 and 101 matches and clamp after deletion including an empty library', (t) => {
  const { db, store, insertItem } = createFixture(t);
  db.exec('DELETE FROM knowledge_items');
  for (let index = 0; index < 101; index += 1) {
    insertItem.run('doc-a', `boundary-${index}`, '边界', '摘要', '正文', index);
  }
  const second = store.search({ keyword: '边界', page: 2 });
  assert.equal(second.total, 101);
  assert.equal(second.page, 2);
  assert.deepEqual(second.items.map((item) => item.item_id), ['boundary-100']);
  db.prepare('DELETE FROM knowledge_items WHERE item_id = ?').run('boundary-100');
  const clamped = store.search({ keyword: '边界', page: 2 });
  assert.equal(clamped.total, 100);
  assert.equal(clamped.page, 1);
  assert.equal(clamped.items.length, 100);
  db.exec('DELETE FROM knowledge_items');
  assert.deepEqual(store.search({ keyword: '边界', page: 2 }), { items: [], total: 0, page: 1, pageSize: 100 });
});

test('image items match only title/resume; URL syntax in content never participates', (t) => {
  const { store, insertItem, insertImageItem } = createFixture(t);
  insertImageItem.run('doc-a', 'IMG-1', '配电箱接线示意图', '配电箱内部接线方式说明', '![配电箱接线示意图](yibiao-asset://imported-images/batch-a/picture-01.png)', 1, 'image', '示意图', 'yibiao-asset://imported-images/batch-a/picture-01.png');

  // 图条目 content 中的图片引用 URL 语法不参与子串匹配
  assert.deepEqual(store.search({ keyword: 'picture-01', page: 1 }), { items: [], total: 0, page: 1, pageSize: 100 });
  assert.deepEqual(store.search({ keyword: 'yibiao-asset', page: 1 }), { items: [], total: 0, page: 1, pageSize: 100 });

  // 图条目仅按 title / resume 匹配，且返回 item_kind / image_type / asset_url
  const byTitle = store.search({ keyword: '配电箱', page: 1 });
  assert.equal(byTitle.total, 1);
  assert.equal(byTitle.items[0].item_id, 'IMG-1');
  assert.equal(byTitle.items[0].match_field, 'title');
  assert.equal(byTitle.items[0].item_kind, 'image');
  assert.equal(byTitle.items[0].image_type, '示意图');
  assert.equal(byTitle.items[0].asset_url, 'yibiao-asset://imported-images/batch-a/picture-01.png');
  assert.match(byTitle.items[0].snippet, /配电箱/);

  const byResume = store.search({ keyword: '内部接线', page: 1 });
  assert.equal(byResume.total, 1);
  assert.equal(byResume.items[0].match_field, 'resume');

  // content URL 中即使包含关键词，图条目也不参与 content 匹配
  insertImageItem.run('doc-a', 'IMG-2', '厂区平面图', '厂区总平面布置图', '![厂区平面图](yibiao-asset://imported-images/batch-a/质量保证平面图.png)', 2, 'image', '平面图', 'yibiao-asset://imported-images/batch-a/质量保证平面图.png');
  const mixed = store.search({ keyword: '质量保证', page: 1 });
  assert.equal(mixed.total, 2);
  assert.deepEqual(mixed.items.map((item) => item.item_id), ['A-1', 'B-1']);

  // 图条目 title 命中优先级高于文本条目 content 命中，文本条目 content 匹配不受影响
  insertItem.run('doc-b', 'B-3', '标书正文段落', '无关键词摘要', '文中提到配电箱接线示意图。', 1);
  const order = store.search({ keyword: '配电箱', page: 1 });
  assert.deepEqual(order.items.map((item) => item.item_id), ['IMG-1', 'B-3']);
  assert.deepEqual(order.items.map((item) => item.match_field), ['title', 'content']);
  assert.equal(order.items[1].item_kind, 'text');
  assert.equal(order.items[1].image_type, undefined);
  assert.equal(order.items[1].asset_url, undefined);
});
