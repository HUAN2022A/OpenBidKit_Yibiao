const { test } = require('node:test');
const assert = require('node:assert');
const { collectCandidatesByKeyword, retrieveSimilarIllustrations } = require('./illustrationReuseService.cjs');

function imageItem(overrides = {}) {
  return {
    id: 'img-1',
    title: '示例图',
    resume: '示例图简介',
    asset_url: 'yibiao-asset://knowledge/img-1.png',
    image_type: '其他图',
    ...overrides,
  };
}

test('优先复用：HTML 图形式类型能跨词汇表匹配知识库图（组织架构图 vs 层级图）', () => {
  const planItem = { title: '组织架构图', image_type: '组织架构图' };
  const candidates = collectCandidatesByKeyword(planItem, [
    imageItem({ id: 'img-org', title: '公司组织架构图', resume: '公司各部门组织关系', image_type: '层级图' }),
  ]);
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].id, 'img-org');
  assert.strictEqual(candidates[0].image_type, '层级图');
  assert.ok(!('score' in candidates[0]), '返回候选不应泄漏内部 score 字段');
});

test('优先复用：无关键词重叠时返回兜底候选（风险矩阵 vs 实景照片）', () => {
  const planItem = { title: '风险矩阵', image_type: '风险矩阵' };
  const candidates = collectCandidatesByKeyword(planItem, [
    imageItem({ id: 'img-photo', title: '设备机房实景照片', resume: '机房设备部署现场', image_type: '实景照片' }),
  ]);
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].id, 'img-photo');
  assert.strictEqual(candidates[0].image_type, '实景照片');
});

test('优先复用：按关键词相关性排序，最相关的候选排最前', () => {
  const planItem = { title: '系统拓扑结构图', image_type: '系统架构图' };
  const candidates = collectCandidatesByKeyword(planItem, [
    imageItem({ id: 'img-flow', title: '设备巡检流程', resume: '巡检步骤', image_type: '流程图' }),
    imageItem({ id: 'img-topo', title: '系统拓扑架构图', resume: '系统拓扑结构', image_type: '工程图示' }),
  ]);
  assert.ok(candidates.length >= 1);
  assert.strictEqual(candidates[0].id, 'img-topo');
});

test('优先复用：缺 id/title/asset_url 的条目被排除', () => {
  const planItem = { title: '组织架构图', image_type: '组织架构图' };
  const candidates = collectCandidatesByKeyword(planItem, [
    imageItem({ id: '', title: '无 id', resume: '简介', image_type: '层级图' }),
    imageItem({ id: 'img-x', title: '', resume: '无标题', image_type: '层级图' }),
    imageItem({ id: 'img-y', title: '组织架构图', resume: '简介', asset_url: '', image_type: '层级图' }),
    imageItem({ id: 'img-ok', title: '组织架构图', resume: '简介', image_type: '层级图' }),
  ]);
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].id, 'img-ok');
});

function mockAiService(decision) {
  return { collectJsonResponse: async () => decision };
}

test('复用：当前小节正文含客户名/金额/地址时仍能走到语义匹配并复用', async () => {
  const aiService = mockAiService({ reuse: true, reuse_item_id: 'img-org', confidence: 0.9, sensitive: false });
  const planItems = [{ item_id: 'item-1', title: '组织架构图', image_type: '组织架构图', section_ids: ['1.1'] }];
  const sections = { '1.1': { content: '本项目建设单位为华能集团有限公司，总投资约 5000 万元，位于创新产业园。' } };
  const imageItems = [imageItem({ id: 'img-org', title: '组织架构图', resume: '各部门组织关系', image_type: '层级图' })];
  const stats = await retrieveSimilarIllustrations({ planItems, sections, imageItems, aiService });
  assert.strictEqual(stats.reused, 1);
  assert.strictEqual(planItems[0].reuse_source.item_id, 'img-org');
});

test('复用：候选历史图图注含旧客户名时仍被拦截，走重新生成', async () => {
  const aiService = mockAiService({ reuse: true, reuse_item_id: 'img-org', confidence: 0.9, sensitive: false });
  const planItems = [{ item_id: 'item-1', title: '组织架构图', image_type: '组织架构图', section_ids: ['1.1'] }];
  const sections = { '1.1': { content: '项目组织架构说明。' } };
  const imageItems = [imageItem({ id: 'img-org', title: '华能集团组织架构图', resume: '华能集团各部门', image_type: '层级图' })];
  const stats = await retrieveSimilarIllustrations({ planItems, sections, imageItems, aiService });
  assert.strictEqual(stats.reused, 0);
  assert.strictEqual(planItems[0].reuse_source, undefined);
});

test('复用：LLM 判定候选疑似含项目专有信息时不复用', async () => {
  const aiService = mockAiService({ reuse: true, reuse_item_id: 'img-org', confidence: 0.95, sensitive: true });
  const planItems = [{ item_id: 'item-1', title: '组织架构图', image_type: '组织架构图', section_ids: ['1.1'] }];
  const sections = { '1.1': { content: '项目组织架构说明。' } };
  const imageItems = [imageItem({ id: 'img-org', title: '组织架构图', resume: '各部门组织关系', image_type: '层级图' })];
  const stats = await retrieveSimilarIllustrations({ planItems, sections, imageItems, aiService });
  assert.strictEqual(stats.reused, 0);
});

test('复用：把握不足（confidence < 0.8）时不复用', async () => {
  const aiService = mockAiService({ reuse: true, reuse_item_id: 'img-org', confidence: 0.5, sensitive: false });
  const planItems = [{ item_id: 'item-1', title: '组织架构图', image_type: '组织架构图', section_ids: ['1.1'] }];
  const sections = { '1.1': { content: '项目组织架构说明。' } };
  const imageItems = [imageItem({ id: 'img-org', title: '组织架构图', resume: '各部门组织关系', image_type: '层级图' })];
  const stats = await retrieveSimilarIllustrations({ planItems, sections, imageItems, aiService });
  assert.strictEqual(stats.reused, 0);
});
