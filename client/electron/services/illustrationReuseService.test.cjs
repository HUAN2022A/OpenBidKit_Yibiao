const { test } = require('node:test');
const assert = require('node:assert');
const { collectCandidatesByKeyword } = require('./illustrationReuseService.cjs');

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
