const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs/promises');
const AdmZip = require('adm-zip');
const { extractImagesFromMarkdown } = require('./fileService.cjs');

/** 1x1 像素 PNG，同时用于 data URL、远程服务与 zip 包场景。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const ASSET_URL_PATTERN = /^yibiao-asset:\/\/imported-images\/[^/]+\/image-\d{4}\.(png|jpg|gif|bmp|webp)$/;

/**
 * 构造与 createAssetContext 相同结构的导入资产上下文。
 * 纯 Node 环境没有 Electron app 对象，直接落盘到临时目录。
 */
function createAssetsFixture(t) {
  const batchId = `extract-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const baseDir = path.join(os.tmpdir(), `fileService-extract-${batchId}`);
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  return {
    baseDir,
    urlPrefix: `yibiao-asset://imported-images/${encodeURIComponent(batchId)}`,
    index: 0,
  };
}

/** 启动返回固定 PNG 的本地 HTTP 服务，用真实网络请求覆盖远程 http(s) 场景。 */
async function startPngServer(t, extraRoutes = {}) {
  const server = http.createServer((req, res) => {
    if (extraRoutes[req.url]) {
      res.writeHead(extraRoutes[req.url].status, { 'Content-Type': extraRoutes[req.url].contentType });
      res.end(extraRoutes[req.url].body);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(TINY_PNG);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('提取 data URL 图片并落盘为导入资产', async (t) => {
  const assets = createAssetsFixture(t);
  const dataRef = `data:image/png;base64,${TINY_PNG.toString('base64')}`;
  const items = await extractImagesFromMarkdown(`# 标题\n\n![数据图](${dataRef})\n\n正文`, assets, {});

  assert.equal(items.length, 1);
  assert.equal(items[0].alt, '数据图');
  assert.equal(items[0].originalRef, dataRef);
  assert.match(items[0].asset_url, ASSET_URL_PATTERN);
  const written = await fs.readFile(path.join(assets.baseDir, 'image-0001.png'));
  assert.deepEqual(written, TINY_PNG);
});

test('提取远程 http(s) 图片并落盘为导入资产', async (t) => {
  const assets = createAssetsFixture(t);
  const origin = await startPngServer(t);
  const remoteRef = `${origin}/images/remote.png`;
  const items = await extractImagesFromMarkdown(`![远程图](${remoteRef})`, assets, {});

  assert.equal(items.length, 1);
  assert.equal(items[0].alt, '远程图');
  assert.equal(items[0].originalRef, remoteRef);
  assert.match(items[0].asset_url, ASSET_URL_PATTERN);
  const written = await fs.readFile(path.join(assets.baseDir, 'image-0001.png'));
  assert.deepEqual(written, TINY_PNG);
});

test('提取 zip 包内图片引用并落盘为导入资产', async (t) => {
  const assets = createAssetsFixture(t);
  const zip = new AdmZip();
  zip.addFile('images/pic.png', TINY_PNG);
  const zipEntries = zip.getEntries();

  const items = await extractImagesFromMarkdown('![压缩包图](images/pic.png)', assets, {
    zipEntries,
    markdownEntryName: 'full.md',
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].alt, '压缩包图');
  assert.equal(items[0].originalRef, 'images/pic.png');
  assert.match(items[0].asset_url, ASSET_URL_PATTERN);
  const written = await fs.readFile(path.join(assets.baseDir, 'image-0001.png'));
  assert.deepEqual(written, TINY_PNG);
});

test('提取本地相对路径图片并落盘为导入资产', async (t) => {
  const assets = createAssetsFixture(t);
  const localDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fileService-extract-local-'));
  t.after(() => fs.rm(localDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(localDir, 'img'), { recursive: true });
  await fs.writeFile(path.join(localDir, 'img', 'pic.png'), TINY_PNG);

  const items = await extractImagesFromMarkdown('![本地图](img/pic.png)', assets, { localBaseDir: localDir });

  assert.equal(items.length, 1);
  assert.equal(items[0].alt, '本地图');
  assert.equal(items[0].originalRef, 'img/pic.png');
  assert.match(items[0].asset_url, ASSET_URL_PATTERN);
  const written = await fs.readFile(path.join(assets.baseDir, 'image-0001.png'));
  assert.deepEqual(written, TINY_PNG);
});

test('四种来源混合时按文档出现顺序返回，<img> 标签一并提取', async (t) => {
  const assets = createAssetsFixture(t);
  const localDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fileService-extract-local-'));
  t.after(() => fs.rm(localDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(localDir, 'img'), { recursive: true });
  await fs.writeFile(path.join(localDir, 'img', 'a.png'), TINY_PNG);
  await fs.writeFile(path.join(localDir, 'img', 'b.png'), TINY_PNG);

  const origin = await startPngServer(t);
  const remoteRef = `${origin}/images/remote.png`;
  const dataRef = `data:image/png;base64,${TINY_PNG.toString('base64')}`;
  const zip = new AdmZip();
  zip.addFile('zip/pic.png', TINY_PNG);
  const zipEntries = zip.getEntries();

  const markdown = [
    '![本地一](img/a.png)',
    '<img src="img/b.png" alt="HTML图">',
    `![远程图](${remoteRef})`,
    '![压缩包图](zip/pic.png)',
    `![数据图](${dataRef})`,
  ].join('\n');
  const items = await extractImagesFromMarkdown(markdown, assets, {
    zipEntries,
    markdownEntryName: 'full.md',
    localBaseDir: localDir,
  });

  assert.deepEqual(
    items.map((item) => item.alt),
    ['本地一', 'HTML图', '远程图', '压缩包图', '数据图'],
  );
  assert.deepEqual(
    items.map((item) => item.originalRef),
    ['img/a.png', 'img/b.png', remoteRef, 'zip/pic.png', dataRef],
  );
  assert.deepEqual(
    items.map((item) => path.posix.basename(item.asset_url)),
    ['image-0001.png', 'image-0002.png', 'image-0003.png', 'image-0004.png', 'image-0005.png'],
  );
});

test('解析失败的图片被跳过，yibiao-asset:// 引用原样返回且不重复落盘', async (t) => {
  const assets = createAssetsFixture(t);
  const localDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fileService-extract-local-'));
  t.after(() => fs.rm(localDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(localDir, 'img'), { recursive: true });
  await fs.writeFile(path.join(localDir, 'img', 'ok.png'), TINY_PNG);

  const origin = await startPngServer(t, {
    '/note.txt': { status: 200, contentType: 'text/plain', body: '不是图片' },
  });
  const existingRef = 'yibiao-asset://imported-images/batch-1/image-0007.png';

  const markdown = [
    '![存在的图](img/ok.png)',
    '![缺失的图](img/missing.png)',
    `![非图片响应](${origin}/note.txt)`,
    `![已导入图](${existingRef})`,
  ].join('\n');
  const items = await extractImagesFromMarkdown(markdown, assets, { localBaseDir: localDir });

  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((item) => item.alt),
    ['存在的图', '已导入图'],
  );
  assert.equal(items[0].originalRef, 'img/ok.png');
  assert.equal(items[1].originalRef, existingRef);
  assert.equal(items[1].asset_url, existingRef);
  // 失败图片不占编号：仅成功落盘一张图，yibiao-asset 引用未写入新文件
  assert.equal(assets.index, 1);
});

test('空内容与无图 Markdown 返回空数组', async (t) => {
  const assets = createAssetsFixture(t);
  assert.deepEqual(await extractImagesFromMarkdown('', assets, {}), []);
  assert.deepEqual(await extractImagesFromMarkdown('只有文字，没有图片', assets, {}), []);
  assert.deepEqual(await extractImagesFromMarkdown(null, assets, {}), []);
});
