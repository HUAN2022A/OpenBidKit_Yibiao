const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const AdmZip = require('adm-zip');

const {
  analyzeTemplateWord,
  parseOoxml,
  mapFactsToConfig,
  applyAiFallback,
  createDefaultConfig,
  buildConfidenceMap,
  ptToSizeName,
  normalizeFont,
  jcToAlignment,
  twipsToCm,
  detectHeadingNumbering,
  paperSizeFromMm,
} = require('./templateWordAnalyzer.cjs');

// ── fixture 构造 ─────────────────────────────────────────────────────
function buildDocxXml() {
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal" w:default="1">
    <w:name w:val="Normal"/><w:qFormat/>
    <w:pPr><w:ind w:firstLineChars="200"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="0"/><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="36"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="1"/><w:jc w:val="both"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="黑体"/><w:sz w:val="28"/></w:rPr>
  </w:style>
</w:styles>`;

  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="第%1章"/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>第一章 总则</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading2"/><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>第一节 目的</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Normal"/></w:pPr>
      <w:r><w:t>这是正文内容。</w:t></w:r>
    </w:p>
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992"/>
      <w:headerReference w:type="default" r:id="rId7"/>
      <w:footerReference w:type="default" r:id="rId8"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>`;

  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>某某招标文件</w:t></w:r></w:p></w:hdr>`;

  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
</w:ftr>`;

  return { styles, numbering, document, rels, header, footer };
}

function buildFixtureZip() {
  const xml = buildDocxXml();
  const zip = new AdmZip();
  zip.addFile('word/styles.xml', Buffer.from(xml.styles, 'utf-8'));
  zip.addFile('word/numbering.xml', Buffer.from(xml.numbering, 'utf-8'));
  zip.addFile('word/document.xml', Buffer.from(xml.document, 'utf-8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(xml.rels, 'utf-8'));
  zip.addFile('word/header1.xml', Buffer.from(xml.header, 'utf-8'));
  zip.addFile('word/footer1.xml', Buffer.from(xml.footer, 'utf-8'));
  return zip;
}

async function writeFixtureDocx(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-analyzer-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'fixture.docx');
  await fs.writeFile(filePath, buildFixtureZip().toBuffer());
  return filePath;
}

// ── 含表格 + 图片的 fixture ──────────────────────────────────────────
function buildTableImageDocument() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="5000" w:type="pct"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="8" w:space="0" w:color="FF0000"/>
          <w:left w:val="single" w:sz="8" w:space="0" w:color="FF0000"/>
          <w:bottom w:val="single" w:sz="8" w:space="0" w:color="FF0000"/>
          <w:right w:val="single" w:sz="8" w:space="0" w:color="FF0000"/>
          <w:insideH w:val="single" w:sz="8" w:space="0" w:color="FF0000"/>
          <w:insideV w:val="single" w:sz="8" w:space="0" w:color="FF0000"/>
        </w:tblBorders>
        <w:tblCellMar>
          <w:top w:w="120" w:type="dxa"/>
          <w:left w:w="120" w:type="dxa"/>
        </w:tblCellMar>
      </w:tblPr>
      <w:tblGrid>
        <w:gridCol w:w="4000"/>
        <w:gridCol w:w="4000"/>
      </w:tblGrid>
      <w:tr>
        <w:trPr><w:tblHeader/></w:trPr>
        <w:tc>
          <w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="EEF5FF"/></w:tcPr>
          <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="黑体" w:eastAsia="黑体"/><w:sz w:val="24"/></w:rPr><w:t>序号</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="EEF5FF"/></w:tcPr>
          <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="黑体" w:eastAsia="黑体"/><w:sz w:val="24"/></w:rPr><w:t>名称</w:t></w:r></w:p>
        </w:tc>
      </w:tr>
      <w:tr>
        <w:tc>
          <w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="宋体" w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr><w:t>1</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="宋体" w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr><w:t>项目A</w:t></w:r></w:p>
        </w:tc>
      </w:tr>
    </w:tbl>
    <w:p>
      <w:pPr><w:jc w:val="center"/></w:pPr>
      <w:r>
        <w:drawing>
          <wp:inline distT="0" distB="0" distL="0" distR="0">
            <wp:extent cx="3000000" cy="2000000"/>
            <wp:effectExtent l="0" t="0" r="0" b="0"/>
            <wp:docPr id="1" name="图片 1"/>
            <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
            <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="图片 1"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId4"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3000000" cy="2000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>
    <w:p>
      <w:pPr><w:jc w:val="center"/></w:pPr>
      <w:r><w:rPr><w:rFonts w:ascii="宋体" w:eastAsia="宋体"/><w:sz w:val="18"/></w:rPr><w:t>图1 某某示意图</w:t></w:r>
    </w:p>
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

function buildTableImageFixtureZip() {
  const xml = buildDocxXml();
  const zip = new AdmZip();
  zip.addFile('word/styles.xml', Buffer.from(xml.styles, 'utf-8'));
  zip.addFile('word/numbering.xml', Buffer.from(xml.numbering, 'utf-8'));
  zip.addFile('word/document.xml', Buffer.from(buildTableImageDocument(), 'utf-8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(xml.rels, 'utf-8'));
  zip.addFile('word/header1.xml', Buffer.from(xml.header, 'utf-8'));
  zip.addFile('word/footer1.xml', Buffer.from(xml.footer, 'utf-8'));
  return zip;
}

async function writeTableImageFixtureDocx(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-analyzer-ti-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'fixture-table-image.docx');
  await fs.writeFile(filePath, buildTableImageFixtureZip().toBuffer());
  return filePath;
}

// ── 纯函数测试 ──────────────────────────────────────────────────────
test('字号换算：pt → 中文字号反向查表', () => {
  assert.equal(ptToSizeName(18), '小二');
  assert.equal(ptToSizeName(12), '小四');
  assert.equal(ptToSizeName(10.5), '五号');
  assert.equal(ptToSizeName(16), '三号');
  assert.equal(ptToSizeName(42), '初号');
  assert.equal(ptToSizeName(null), null);
  assert.equal(ptToSizeName(0), null);
});

test('字体别名：SimSun/仿宋_GB2312 等归一化', () => {
  assert.equal(normalizeFont('SimSun'), '宋体');
  assert.equal(normalizeFont('SimSun-ExtB'), '宋体');
  assert.equal(normalizeFont('宋体-简'), '宋体');
  assert.equal(normalizeFont('SimHei'), '黑体');
  assert.equal(normalizeFont('KaiTi'), '楷体');
  assert.equal(normalizeFont('FangSong'), '仿宋');
  assert.equal(normalizeFont('仿宋_GB2312'), '仿宋');
  assert.equal(normalizeFont('Microsoft YaHei'), '微软雅黑');
  assert.equal(normalizeFont('DengXian'), '等线');
  assert.equal(normalizeFont('华文新魏'), null);
});

test('对齐映射 jc → ALIGNMENT_OPTIONS', () => {
  assert.equal(jcToAlignment('center'), '居中对齐');
  assert.equal(jcToAlignment('both'), '两端对齐');
  assert.equal(jcToAlignment('left'), '左对齐');
  assert.equal(jcToAlignment('right'), '右对齐');
  assert.equal(jcToAlignment('bogus'), null);
});

test('twips → cm', () => {
  assert.equal(twipsToCm(567), 1);
  assert.equal(twipsToCm(1440), 2.54);
});

test('编号模板匹配：第%1章 → 第{zh}章，多级 → outline-decimal', () => {
  assert.deepEqual(detectHeadingNumbering({ numFmt: 'chineseCounting', lvlText: '第%1章' }), { format: 'custom', template: '第{zh}章' });
  assert.deepEqual(detectHeadingNumbering({ numFmt: 'decimal', lvlText: '%1.%2' }), { format: 'outline-decimal' });
  assert.equal(detectHeadingNumbering({ numFmt: 'none', lvlText: '' }), null);
});

test('纸张尺寸 mm → PAPER_SIZES', () => {
  assert.equal(paperSizeFromMm(210, 297), 'a4');
  assert.equal(paperSizeFromMm(297, 210), 'a4'); // 横向 A4 也识别为 a4
});

// ── 解析 + 规则映射测试 ──────────────────────────────────────────────
test('解析 fixture docx 并映射为 ExportFormatConfig', async (t) => {
  const filePath = await writeFixtureDocx(t);
  const facts = parseOoxml(filePath);

  // 解析层 facts
  assert.equal(facts.headings[0].font, '黑体');
  assert.equal(facts.headings[0].sizeHalf, 36);
  assert.equal(facts.headings[0].jc, 'center');
  assert.equal(facts.headings[0].bold, true);
  assert.equal(facts.headings[1].font, '黑体');
  assert.equal(facts.headings[1].sizeHalf, 28);
  assert.equal(facts.page.margins.topCm, 2.54);
  assert.equal(facts.body.font, '宋体');
  assert.equal(facts.body.sizeHalf, 24);
  assert.equal(facts.body.firstLineChars, 200);

  const { config, confidenceByField, summary } = mapFactsToConfig(facts, { sourceFileName: 'fixture.docx' });

  // 页面
  assert.equal(config.page.paper_size, 'a4');
  assert.equal(config.page.orientation, 'portrait');
  // fixture 使用 Word 出厂边距（1 英寸/1.25 英寸），被护栏忽略，保留默认 2.2cm
  assert.equal(config.page.margin_top_cm, 2.2);
  assert.equal(config.page.margin_left_cm, 2.2);
  assert.equal(config.page.header_enabled, true);
  assert.equal(config.page.header_text, '某某招标文件');
  assert.equal(config.page.footer_enabled, true);
  assert.equal(config.page.page_number_enabled, true);

  // 标题
  assert.equal(config.headings[0].font, '黑体');
  assert.equal(config.headings[0].size, '小二');
  assert.equal(config.headings[0].alignment, '居中对齐');
  assert.equal(config.headings[0].bold, true);
  assert.equal(config.headings[0].numbering_format, 'custom');
  assert.equal(config.headings[0].numbering_template, '第{zh}章');
  assert.equal(config.headings[1].size, '四号');
  assert.equal(config.headings[1].alignment, '两端对齐');
  assert.equal(config.headings[1].numbering_format, 'outline-decimal');

  // 正文
  assert.equal(config.body_text.font, '宋体');
  assert.equal(config.body_text.size, '小四');
  assert.equal(config.body_text.first_line_indent_chars, 2);
  assert.equal(config.body_text.line_spacing_multiple, 1.2);

  // confidence
  assert.equal(confidenceByField['headings.0.font'], 'rule');
  assert.equal(confidenceByField['headings.0.size'], 'rule');
  assert.equal(confidenceByField['page.paper_size'], 'rule');
  assert.equal(confidenceByField['headings.3.font'], 'default'); // 未定义的标题级别保持默认
  assert.equal(confidenceByField['table.border_width'], 'default');

  // summary 分组存在
  assert.ok(summary.some((s) => s.group === '页面设置' && s.source === 'rule'));
  assert.ok(summary.some((s) => s.group === '标题样式' && s.source === 'rule'));
});

test('Letter/Legal 纸张忽略，保留默认 A4（Word/WPS 出厂纸张护栏）', () => {
  const letter = mapFactsToConfig({ page: { widthMm: 215.9, heightMm: 279.4 } });
  assert.equal(letter.config.page.paper_size, 'a4');
  assert.equal(letter.confidenceByField['page.paper_size'], 'default');

  const legal = mapFactsToConfig({ page: { widthMm: 215.9, heightMm: 355.6 } });
  assert.equal(legal.config.page.paper_size, 'a4');
  assert.equal(legal.confidenceByField['page.paper_size'], 'default');

  // A4 正常识别不受影响
  const a4 = mapFactsToConfig({ page: { widthMm: 210, heightMm: 297 } });
  assert.equal(a4.config.page.paper_size, 'a4');
  assert.equal(a4.confidenceByField['page.paper_size'], 'rule');
});

test('五号及更小正文忽略，保留默认小四（Normal 出厂字号护栏）', () => {
  // 21 half-pt = 10.5pt 五号；20 half-pt = 10pt 会就近落到五号
  const five = mapFactsToConfig({ body: { sizeHalf: 21 } });
  assert.equal(five.config.body_text.size, '小四');
  assert.equal(five.confidenceByField['body_text.size'], 'default');

  // 四号（14pt）不被护栏拦截，仍正常识别
  const four = mapFactsToConfig({ body: { sizeHalf: 28 } });
  assert.equal(four.config.body_text.size, '四号');
  assert.equal(four.confidenceByField['body_text.size'], 'rule');
});

test('Word 出厂边距忽略，保留默认 2.2cm；非默认边距正常识别', () => {
  // Word 出厂边距（上下 1 英寸、左右 1.25 英寸）
  const factory = mapFactsToConfig({
    page: { margins: { topCm: 2.54, bottomCm: 2.54, leftCm: 3.17, rightCm: 3.17 } },
  });
  assert.equal(factory.config.page.margin_top_cm, 2.2);
  assert.equal(factory.config.page.margin_left_cm, 2.2);
  assert.equal(factory.confidenceByField['page.margin_top_cm'], 'default');

  // 非默认边距（四周 3cm）正常识别，不被护栏拦截
  const custom = mapFactsToConfig({
    page: { margins: { topCm: 3, bottomCm: 3, leftCm: 3, rightCm: 3 } },
  });
  assert.equal(custom.config.page.margin_top_cm, 3);
  assert.equal(custom.confidenceByField['page.margin_top_cm'], 'rule');
});

test('未识别字体进入 unclassified，AI 兜底只补 unclassified 且拒绝非法值', async () => {
  const config = createDefaultConfig();
  const confidenceByField = buildConfidenceMap(config);
  const unclassified = [{ kind: 'font', raw: '华文新魏', field: 'headings.0.font' }];

  // 非法字体：应被拒绝，保持 default
  const badAi = {
    async collectJsonResponse() {
      return { 'headings.0.font': '不存在的字体', 'table.border_width': 999 };
    },
  };
  await applyAiFallback({ aiService: badAi, config, confidenceByField, unclassified });
  assert.equal(config.headings[0].font, '黑体'); // 保持默认
  assert.equal(confidenceByField['headings.0.font'], 'default');
  assert.equal(confidenceByField['table.border_width'], 'default'); // AI 不能越界写非 unclassified 字段

  // 合法字体：应被采纳，confidence = ai
  const goodAi = {
    async collectJsonResponse() {
      return { 'headings.0.font': '隶书' };
    },
  };
  await applyAiFallback({ aiService: goodAi, config, confidenceByField, unclassified });
  assert.equal(config.headings[0].font, '隶书');
  assert.equal(confidenceByField['headings.0.font'], 'ai');
});

test('离线模式跳过 AI 兜底', async () => {
  const config = createDefaultConfig();
  const confidenceByField = buildConfidenceMap(config);
  const unclassified = [{ kind: 'font', raw: '华文新魏', field: 'headings.0.font' }];
  let called = false;
  const aiService = {
    async collectJsonResponse() {
      called = true;
      return { 'headings.0.font': '隶书' };
    },
  };
  await applyAiFallback({ aiService, config, confidenceByField, unclassified, offlineMode: true });
  assert.equal(called, false);
  assert.equal(config.headings[0].font, '黑体');
});

// ── 全链路（analyzeTemplateWord）测试 ─────────────────────────────────
test('analyzeTemplateWord 全链路返回 TemplateWordAnalysisResult', async (t) => {
  const filePath = await writeFixtureDocx(t);
  const result = await analyzeTemplateWord({ filePath });

  assert.equal(result.sourceFileName, 'fixture.docx');
  assert.equal(result.sourceFormat, 'docx');
  assert.equal(result.config.headings[0].size, '小二');
  assert.equal(result.config.page.paper_size, 'a4');
  assert.equal(typeof result.confidenceByField['headings.0.font'], 'string');
  assert.ok(Array.isArray(result.summary) && result.summary.length > 0);
});

// ── 表格 / 图片样式解析 + 规则映射 + 摘要 ─────────────────────────────
test('表格与图片样式解析、映射与摘要', async (t) => {
  const filePath = await writeTableImageFixtureDocx(t);
  const facts = parseOoxml(filePath);

  // 解析层 facts.table
  assert.ok(facts.table, '应解析出表格 facts');
  assert.equal(facts.table.border_width, 1);
  assert.equal(facts.table.border_color, '#ff0000');
  assert.equal(facts.table.full_width, true);
  assert.equal(facts.table.header_row.font, '黑体');
  assert.equal(facts.table.header_row.fill, 'EEF5FF');

  // 解析层 facts.image
  assert.ok(facts.image, '应解析出图片 facts');
  assert.ok(facts.image.max_width_percent >= 1 && facts.image.max_width_percent <= 100);
  assert.equal(facts.image.caption_font, '宋体');

  const { config, confidenceByField, summary } = mapFactsToConfig(facts, { sourceFileName: 'fixture-table-image.docx' });

  // 表格映射
  assert.equal(config.table.border_width, 1);
  assert.equal(config.table.border_color, '#ff0000');
  assert.equal(config.table.full_width, true);
  assert.equal(config.table.header_row.font, '黑体');
  assert.equal(config.table.header_row.size, '小四');
  assert.equal(config.table.header_row.background_color, '#eef5ff');
  assert.equal(config.table.body_cell.font, '宋体');
  assert.equal(config.table.body_cell.size, '小四');

  // 图片映射
  assert.ok(config.image.max_width_percent >= 1 && config.image.max_width_percent <= 100);
  assert.equal(config.image.caption_font, '宋体');
  assert.equal(config.image.caption_size, '小五');
  assert.equal(config.image.caption_alignment, '居中对齐');

  // confidence 与摘要
  assert.equal(confidenceByField['table.border_width'], 'rule');
  assert.equal(confidenceByField['table.header_row.font'], 'rule');
  assert.equal(confidenceByField['image.caption_font'], 'rule');
  assert.ok(summary.some((s) => s.group === '表格' && s.source === 'rule'));
  assert.ok(summary.some((s) => s.group === '图片' && s.source === 'rule'));
});
