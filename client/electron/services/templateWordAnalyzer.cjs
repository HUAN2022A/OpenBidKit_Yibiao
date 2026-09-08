/**
 * 模板 Word 文档格式分析器。
 *
 * 链路：解析层（adm-zip 解包 docx + cheerio 读取 OOXML）→ 规则映射层（确定性）→ AI 兜底层（可选）。
 * 输出可直接预填进 ExportFormatPage 表单的 ExportFormatConfig。
 *
 * 本文件运行在 Main 侧（CommonJS），无法直接 import src/ 下的 TS 类型，故这里内联了
 * exportFormat.ts 中的选项常量与默认值（务必保持与 exportFormat.ts 同步）。
 */

const path = require('node:path');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');
const { normalizeDocumentParseError, isLibreOfficeMissingError } = require('./documentParseErrors.cjs');

// ── 与 exportFormat.ts 同步的常量 ─────────────────────────────────────
const FONT_OPTIONS = [
  '宋体', '新宋体', '黑体', '楷体', '仿宋', '微软雅黑', '微软雅黑 Light', '等线', '等线 Light',
  '隶书', '幼圆', '华文宋体', '华文黑体', '华文楷体', '华文仿宋', '华文中宋', '华文细黑',
  '苹方', 'PingFang SC', '宋体-简', '黑体-简', '楷体-简', '冬青黑体简体中文', 'Hiragino Sans GB',
  '思源宋体', '思源黑体', 'Source Han Serif SC', 'Source Han Sans SC',
];

const SIZE_OPTIONS = [
  '初号', '小初', '一号', '小一', '二号', '小二', '三号', '小三', '四号', '小四', '五号', '小五', '六号', '小六',
];

const SIZE_TO_PT = {
  '初号': 42,
  '小初': 36,
  '一号': 26,
  '小一': 24,
  '二号': 22,
  '小二': 18,
  '三号': 16,
  '小三': 15,
  '四号': 14,
  '小四': 12,
  '五号': 10.5,
  '小五': 9,
  '六号': 7.5,
  '小六': 6.5,
};

const ALIGNMENT_OPTIONS = ['居中对齐', '两端对齐', '左对齐', '右对齐'];

const PAPER_SIZES = ['a4', 'a3', 'a5', 'b4', 'b5', 'letter', 'legal', '16k'];

const PAPER_DIMENSIONS = {
  a4: { width: 210, height: 297 },
  a3: { width: 297, height: 420 },
  a5: { width: 148, height: 210 },
  b4: { width: 250, height: 353 },
  b5: { width: 176, height: 250 },
  letter: { width: 215.9, height: 279.4 },
  legal: { width: 215.9, height: 355.6 },
  '16k': { width: 184, height: 260 },
};

const PAPER_SIZE_LABELS = {
  a4: 'A4', a3: 'A3', a5: 'A5', b4: 'B4', b5: 'B5', letter: 'Letter', legal: 'Legal', '16k': '16开',
};

const HEADING_LEVEL_LABELS = ['一级标题', '二级标题', '三级标题', '四级标题', '五级标题', '六级标题'];

function createDefaultConfig() {
  return {
    template_name: '默认模版',
    page: {
      paper_size: 'a4',
      orientation: 'portrait',
      first_page_different: false,
      margin_top_cm: 2.2,
      margin_bottom_cm: 2.2,
      margin_left_cm: 2.2,
      margin_right_cm: 2.2,
      header_enabled: false,
      header_text: '',
      header_right_text: '',
      header_font: '宋体',
      header_size: '小五',
      header_alignment: '居中对齐',
      header_color: '#536176',
      header_logo_enabled: false,
      header_underline: false,
      footer_enabled: false,
      footer_text: '',
      footer_distance_cm: 1.75,
      footer_font: '宋体',
      footer_size: '小五',
      footer_alignment: '居中对齐',
      footer_color: '#536176',
      page_number_enabled: false,
      page_number_format: '{page}',
      page_number_start: 1,
    },
    heading_level1_page_break_before: false,
    heading_border: {
      enabled: false,
      min_heading_left_enabled: false,
      border_color: '#cfd8ee',
      level_cell_colors: ['#eef5ff', '#f3f7ff', '#f8fbff', '#fbfdff', '#ffffff', '#ffffff'],
      structure: '上下结构',
    },
    headings: [
      { font: '黑体', size: '小二', alignment: '居中对齐', bold: false, text_color: '#243048', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '第{zh}章' },
      { font: '黑体', size: '四号', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '第{zh}节' },
      { font: '黑体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 10, spacing_after_pt: 10, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '{tail}' },
      { font: '楷体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 5, spacing_after_pt: 5, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '{tail}' },
      { font: '黑体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 5, spacing_after_pt: 5, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '{tail}' },
      { font: '宋体', size: '小四', alignment: '两端对齐', bold: false, text_color: '#243048', spacing_before_pt: 0, spacing_after_pt: 0, first_line_indent_chars: 0, line_spacing: 1, numbering_format: 'custom', numbering_template: '{tail}' },
    ],
    body_text: {
      font: '宋体',
      size: '小四',
      alignment: '左对齐',
      spacing_before_pt: 0,
      spacing_after_pt: 0,
      first_line_indent_chars: 2,
      line_spacing_multiple: 1.5,
      list_style: 'disc',
      ordered_list_style: 'decimal-dot',
      list_indent_chars: 2,
    },
    table: {
      border_width: 1,
      border_color: '#000000',
      cell_padding_pt: 6,
      full_width: true,
      header_row: { font: '黑体', size: '小四', alignment: '居中对齐', text_color: '#243048', background_color: '#ffffff' },
      first_column: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#ffffff' },
      body_cell: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#ffffff' },
    },
    image: {
      max_width_percent: 90,
      alignment: '居中对齐',
      caption_font: '宋体',
      caption_size: '小五',
      caption_alignment: '居中对齐',
      caption_bold: false,
      caption_italic: false,
    },
  };
}

// ── 通用工具 ─────────────────────────────────────────────────────────
function round2(n) {
  return Math.round(n * 100) / 100;
}

function parseXml(xmlText) {
  if (!xmlText || !String(xmlText).trim()) return null;
  return cheerio.load(String(xmlText), { xmlMode: true });
}

/** 返回指定标签名（含命名空间前缀，如 w:p）的所有 DOM 节点。 */
function xmlNodes($, name) {
  if (!$) return [];
  const out = [];
  $('*').each(function () {
    if (this.name === name) out.push(this);
  });
  return out;
}

function xmlFirst($, name) {
  return xmlNodes($, name)[0] || null;
}

/** 在某个节点子树（含自身）内查找指定标签名的节点。 */
function subByName($, node, name) {
  const out = [];
  if (!node) return out;
  if (node.name === name) out.push(node);
  $(node).find('*').each(function () {
    if (this.name === name) out.push(this);
  });
  return out;
}

function subFirst($, node, name) {
  return subByName($, node, name)[0] || null;
}

function nodeAttr(node, name) {
  if (!node || !node.attribs) return undefined;
  return node.attribs[name];
}

function numAttr(node, name) {
  const v = nodeAttr(node, name);
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function setByPath(obj, dotPath, value) {
  const parts = String(dotPath).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

function collectLeafPaths(obj, prefix = '') {
  const paths = [];
  for (const [key, value] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...collectLeafPaths(value, p));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => paths.push(...collectLeafPaths(item, `${p}.${i}`)));
    } else {
      paths.push(p);
    }
  }
  return paths;
}

function buildConfidenceMap(config) {
  const map = {};
  for (const p of collectLeafPaths(config)) map[p] = 'default';
  return map;
}

// ── 规则映射层（纯函数，确定性，供测试） ─────────────────────────────
function halfPointsToPt(halfPoints) {
  if (halfPoints == null || !Number.isFinite(Number(halfPoints))) return null;
  return Number(halfPoints) / 2;
}

/** pt → 中文字号反向查表，四舍五入取最近档；超出合理范围返回 null。 */
function ptToSizeName(pt) {
  if (pt == null || !Number.isFinite(Number(pt))) return null;
  const value = Number(pt);
  if (value <= 0 || value > 80) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const name of SIZE_OPTIONS) {
    const diff = Math.abs(SIZE_TO_PT[name] - value);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = name;
    }
  }
  if (best == null || bestDiff > 4) return null;
  return best;
}

/** 归一化字体 token（小写、去掉空格/连字符/下划线）。 */
function normalizeFontToken(name) {
  return String(name || '').trim().toLowerCase().replace(/[\s\-_]+/g, '');
}

// 字体别名表（key 为 normalizeFontToken 后的值）。
const FONT_ALIASES = {
  simsun: '宋体',
  simsunextb: '宋体',
  '宋体简': '宋体',
  simsunext: '宋体',
  nsimsun: '新宋体',
  simhei: '黑体',
  kaiti: '楷体',
  kaitisc: '楷体',
  fangsong: '仿宋',
  '仿宋gb2312': '仿宋',
  microsoftyahei: '微软雅黑',
  microsoftyaheiui: '微软雅黑',
  dengxian: '等线',
  dengxianlight: '等线 Light',
};

const FONT_OPTION_TOKENS = new Map(FONT_OPTIONS.map((f) => [normalizeFontToken(f), f]));

/** 字体别名 + 大小写/空格归一化，映射到 FONT_OPTIONS；无法识别返回 null。 */
function normalizeFont(fontName) {
  const raw = String(fontName || '').trim();
  if (!raw) return null;
  const token = normalizeFontToken(raw);
  if (!token) return null;
  const aliased = FONT_ALIASES[token];
  if (aliased) return aliased;
  return FONT_OPTION_TOKENS.get(token) || null;
}

/** jc → ALIGNMENT_OPTIONS。 */
function jcToAlignment(jc) {
  const map = {
    center: '居中对齐',
    both: '两端对齐',
    distribute: '两端对齐',
    left: '左对齐',
    start: '左对齐',
    right: '右对齐',
    end: '右对齐',
  };
  const key = String(jc || '').trim().toLowerCase();
  return map[key] || null;
}

/** twips → cm（1cm = 567twips）。 */
function twipsToCm(twips) {
  if (twips == null || !Number.isFinite(Number(twips))) return null;
  return round2(Number(twips) / 567);
}

/** twips → mm（1mm = 56.7twips）。 */
function twipsToMm(twips) {
  if (twips == null || !Number.isFinite(Number(twips))) return null;
  return round2(Number(twips) / 56.7);
}

/** 段前/段后间距 twips → pt（1pt = 20twips）。 */
function spacingTwipsToPt(twips) {
  if (twips == null || !Number.isFinite(Number(twips))) return null;
  return round2(Number(twips) / 20);
}

/** firstLineChars（百分之一字符）→ 字符数。 */
function firstLineCharsToNumber(chars) {
  if (chars == null || !Number.isFinite(Number(chars))) return null;
  return round2(Number(chars) / 100);
}

/** 行距：auto/atLeast 时 line 为 240 分之一行 → 倍数；exact 为 twips，无法转倍数返回 null。 */
function lineToMultiple(line, lineRule) {
  if (line == null || !Number.isFinite(Number(line))) return null;
  const rule = String(lineRule || 'auto').toLowerCase();
  // auto 时 w:line 是 240 分之一行，line/240 即行距倍数。
  if (rule === 'auto') return round2(Number(line) / 240);
  // atLeast / exact 是固定或最小行高（二十分之一磅），不是倍数，无法等价映射到倍数字段 → 交给默认值。
  return null;
}

/** 颜色 val（如 FF0000 / auto）→ #rrggbb；无法解析返回 null。 */
function colorToHex(val) {
  const raw = String(val || '').trim().replace(/^#/, '');
  if (!raw || raw.toLowerCase() === 'auto') return null;
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
  return null;
}

/** 纸张尺寸 mm（任意宽高顺序）→ PAPER_SIZES；偏差过大返回 null。 */
function paperSizeFromMm(widthMm, heightMm) {
  if (widthMm == null || heightMm == null) return null;
  const sw = Math.min(Number(widthMm), Number(heightMm));
  const sh = Math.max(Number(widthMm), Number(heightMm));
  let best = null;
  let bestDist = Infinity;
  for (const key of PAPER_SIZES) {
    const dim = PAPER_DIMENSIONS[key];
    const dist = Math.abs(dim.width - sw) + Math.abs(dim.height - sh);
    if (dist < bestDist) {
      bestDist = dist;
      best = key;
    }
  }
  if (bestDist > 12) return null;
  return best;
}

function mapOrientation(orient, widthMm, heightMm) {
  if (String(orient || '').toLowerCase() === 'landscape') return 'landscape';
  if (widthMm != null && heightMm != null && Number(widthMm) > Number(heightMm)) return 'landscape';
  return 'portrait';
}

/** numFmt + lvlText 模式匹配编号模板。 */
function detectHeadingNumbering(lvl) {
  if (!lvl) return null;
  const numFmt = String(lvl.numFmt || '').trim().toLowerCase();
  const lvlText = String(lvl.lvlText || '');
  if (!numFmt || !lvlText) return null;

  const chineseFmt = numFmt === 'chinesecounting' || numFmt === 'chinesecountingthousand' || numFmt === 'chineselegal';
  const hasChapterWord = /第/.test(lvlText) && /章|节|部分|篇|编/.test(lvlText);

  if (chineseFmt && hasChapterWord) {
    const template = lvlText.replace(/%\d+/g, '{zh}');
    return { format: 'custom', template };
  }
  if (numFmt === 'decimal') {
    const levels = (lvlText.match(/%\d+/g) || []).length;
    if (levels > 1) return { format: 'outline-decimal' };
    if (levels === 1) return { format: 'outline-decimal', template: '{num}' };
  }
  if (chineseFmt) {
    const template = lvlText.replace(/%\d+/g, '{zh}');
    return { format: 'custom', template };
  }
  return null;
}

function detectSourceFormat(filePath, format) {
  if (format === 'docx') return 'docx';
  if (format === 'legacy_word') {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    return ext === '.wps' ? 'wps' : 'doc';
  }
  return null;
}

// ── 解析层（OOXML） ─────────────────────────────────────────────────
function parseRPr($, node) {
  const out = { fonts: {}, szHalf: null, b: null, color: null };
  if (!node) return out;
  const rFonts = subFirst($, node, 'w:rFonts');
  if (rFonts) {
    out.fonts = {
      ascii: nodeAttr(rFonts, 'w:ascii'),
      hAnsi: nodeAttr(rFonts, 'w:hAnsi'),
      eastAsia: nodeAttr(rFonts, 'w:eastAsia'),
      asciiTheme: nodeAttr(rFonts, 'w:asciiTheme'),
      eastAsiaTheme: nodeAttr(rFonts, 'w:eastAsiaTheme'),
    };
  }
  const sz = subFirst($, node, 'w:sz');
  if (sz && nodeAttr(sz, 'w:val') != null) out.szHalf = Number(nodeAttr(sz, 'w:val'));
  const b = subFirst($, node, 'w:b');
  if (b) {
    const val = nodeAttr(b, 'w:val');
    out.b = val == null ? true : String(val) !== '0' && String(val).toLowerCase() !== 'false';
  }
  const color = subFirst($, node, 'w:color');
  if (color && nodeAttr(color, 'w:val') != null) out.color = String(nodeAttr(color, 'w:val'));
  return out;
}

function parsePPr($, node) {
  const out = { jc: null, outlineLvl: null, spacing: null, ind: null, numPr: null, pStyleVal: null };
  if (!node) return out;
  const jc = subFirst($, node, 'w:jc');
  if (jc && nodeAttr(jc, 'w:val') != null) out.jc = String(nodeAttr(jc, 'w:val'));
  const ol = subFirst($, node, 'w:outlineLvl');
  if (ol && nodeAttr(ol, 'w:val') != null) out.outlineLvl = Number(nodeAttr(ol, 'w:val'));
  const spacing = subFirst($, node, 'w:spacing');
  if (spacing) {
    out.spacing = {
      beforeTwips: numAttr(spacing, 'w:before'),
      afterTwips: numAttr(spacing, 'w:after'),
      line: numAttr(spacing, 'w:line'),
      lineRule: nodeAttr(spacing, 'w:lineRule') || null,
    };
  }
  const ind = subFirst($, node, 'w:ind');
  if (ind) {
    out.ind = {
      firstLineChars: numAttr(ind, 'w:firstLineChars'),
      firstLineTwips: numAttr(ind, 'w:firstLine'),
    };
  }
  const numPr = subFirst($, node, 'w:numPr');
  if (numPr) {
    const numId = subFirst($, numPr, 'w:numId');
    const ilvl = subFirst($, numPr, 'w:ilvl');
    out.numPr = {
      numId: numId ? numAttr(numId, 'w:val') : null,
      ilvl: ilvl ? numAttr(ilvl, 'w:val') : null,
    };
  }
  const pStyle = subFirst($, node, 'w:pStyle');
  if (pStyle && nodeAttr(pStyle, 'w:val') != null) out.pStyleVal = String(nodeAttr(pStyle, 'w:val'));
  return out;
}

function parseThemeFonts($theme) {
  const result = { major: { latin: null, ea: null }, minor: { latin: null, ea: null } };
  if (!$theme) return result;
  for (const key of ['major', 'minor']) {
    const fontNode = xmlFirst($theme, key === 'major' ? 'a:majorFont' : 'a:minorFont');
    if (!fontNode) continue;
    const latin = subFirst($theme, fontNode, 'a:latin');
    const ea = subFirst($theme, fontNode, 'a:ea');
    result[key].latin = latin ? nodeAttr(latin, 'typeface') || null : null;
    result[key].ea = ea ? nodeAttr(ea, 'typeface') || null : null;
  }
  return result;
}

function parseStyles($styles, themeFonts) {
  const styles = [];
  let docDefaultsRPr = { fonts: {}, szHalf: null, b: null, color: null };
  let docDefaultsPPr = { jc: null, outlineLvl: null, spacing: null, ind: null, numPr: null, pStyleVal: null };
  if ($styles) {
    const rPrDefault = xmlFirst($styles, 'w:rPrDefault');
    if (rPrDefault) docDefaultsRPr = parseRPr($styles, subFirst($styles, rPrDefault, 'w:rPr'));
    const pPrDefault = xmlFirst($styles, 'w:pPrDefault');
    if (pPrDefault) docDefaultsPPr = parsePPr($styles, subFirst($styles, pPrDefault, 'w:pPr'));

    for (const node of xmlNodes($styles, 'w:style')) {
      const type = nodeAttr(node, 'w:type');
      if (type !== 'paragraph') continue;
      const styleId = nodeAttr(node, 'w:styleId') || '';
      const nameNode = subFirst($styles, node, 'w:name');
      const name = nameNode ? nodeAttr(nameNode, 'w:val') || '' : '';
      const basedOnNode = subFirst($styles, node, 'w:basedOn');
      const basedOn = basedOnNode ? nodeAttr(basedOnNode, 'w:val') || null : null;
      const pPr = parsePPr($styles, subFirst($styles, node, 'w:pPr'));
      const rPr = parseRPr($styles, subFirst($styles, node, 'w:rPr'));
      styles.push({ styleId, name, outlineLvl: pPr.outlineLvl, basedOn, pPr, rPr });
    }
  }
  return { styles, docDefaultsRPr, docDefaultsPPr, themeFonts };
}

function mergeSpacing(parent, child) {
  const p = parent || {};
  const c = child || {};
  return {
    beforeTwips: c.beforeTwips != null ? c.beforeTwips : p.beforeTwips,
    afterTwips: c.afterTwips != null ? c.afterTwips : p.afterTwips,
    line: c.line != null ? c.line : p.line,
    lineRule: c.lineRule != null ? c.lineRule : p.lineRule,
  };
}

function mergeInd(parent, child) {
  const p = parent || {};
  const c = child || {};
  return {
    firstLineChars: c.firstLineChars != null ? c.firstLineChars : p.firstLineChars,
    firstLineTwips: c.firstLineTwips != null ? c.firstLineTwips : p.firstLineTwips,
  };
}

function mergeRPr(parent, child) {
  const p = parent || {};
  const c = child || {};
  return {
    fonts: { ...(p.fonts || {}), ...(c.fonts || {}) },
    szHalf: c.szHalf != null ? c.szHalf : p.szHalf,
    b: c.b != null ? c.b : p.b,
    color: c.color != null ? c.color : p.color,
  };
}

function mergePPr(parent, child) {
  const p = parent || {};
  const c = child || {};
  return {
    jc: c.jc != null ? c.jc : p.jc,
    outlineLvl: c.outlineLvl != null ? c.outlineLvl : p.outlineLvl,
    spacing: mergeSpacing(p.spacing, c.spacing),
    ind: mergeInd(p.ind, c.ind),
    numPr: c.numPr || p.numPr,
    pStyleVal: c.pStyleVal != null ? c.pStyleVal : p.pStyleVal,
  };
}

function resolveStyleProps(stylesMap, styleId, docDefaultsRPr, docDefaultsPPr, depth = 0) {
  const base = { rPr: docDefaultsRPr || {}, pPr: docDefaultsPPr || {} };
  if (!styleId || depth > 10) return base;
  const style = stylesMap.get(styleId);
  if (!style) return base;
  const parent = resolveStyleProps(stylesMap, style.basedOn, docDefaultsRPr, docDefaultsPPr, depth + 1);
  return {
    rPr: mergeRPr(parent.rPr, style.rPr),
    pPr: mergePPr(parent.pPr, style.pPr),
  };
}

function resolveFontName(rPr, themeFonts) {
  if (!rPr) return null;
  const f = rPr.fonts || {};
  if (f.eastAsia && String(f.eastAsia).trim()) return String(f.eastAsia).trim();
  if (f.ascii && String(f.ascii).trim()) return String(f.ascii).trim();
  if (f.hAnsi && String(f.hAnsi).trim()) return String(f.hAnsi).trim();
  const eaTheme = f.eastAsiaTheme;
  if (eaTheme) {
    const key = eaTheme === 'majorEastAsia' ? 'major' : 'minor';
    const ea = themeFonts?.[key]?.ea;
    if (ea && String(ea).trim()) return String(ea).trim();
  }
  const asciiTheme = f.asciiTheme;
  if (asciiTheme) {
    const key = asciiTheme === 'majorHAnsi' ? 'major' : 'minor';
    const latin = themeFonts?.[key]?.latin;
    if (latin && String(latin).trim()) return String(latin).trim();
  }
  return null;
}

function parseSectPr($, node) {
  const out = { widthTwips: null, heightTwips: null, orient: null, margins: null, headerRefs: [], footerRefs: [], titlePg: false };
  if (!node) return out;
  const pgSz = subFirst($, node, 'w:pgSz');
  if (pgSz) {
    out.widthTwips = numAttr(pgSz, 'w:w');
    out.heightTwips = numAttr(pgSz, 'w:h');
    out.orient = nodeAttr(pgSz, 'w:orient') || null;
  }
  const pgMar = subFirst($, node, 'w:pgMar');
  if (pgMar) {
    out.margins = {
      top: numAttr(pgMar, 'w:top'),
      bottom: numAttr(pgMar, 'w:bottom'),
      left: numAttr(pgMar, 'w:left'),
      right: numAttr(pgMar, 'w:right'),
    };
  }
  for (const ref of subByName($, node, 'w:headerReference')) {
    const rid = nodeAttr(ref, 'r:id');
    if (rid) out.headerRefs.push(rid);
  }
  for (const ref of subByName($, node, 'w:footerReference')) {
    const rid = nodeAttr(ref, 'r:id');
    if (rid) out.footerRefs.push(rid);
  }
  out.titlePg = Boolean(subFirst($, node, 'w:titlePg'));
  return out;
}

function parseDocument($document) {
  const result = { paragraphs: [], sectPr: null };
  if (!$document) return result;
  result.sectPr = parseSectPr($document, xmlFirst($document, 'w:sectPr'));
  for (const pNode of xmlNodes($document, 'w:p')) {
    const pPr = parsePPr($document, subFirst($document, pNode, 'w:pPr'));
    const firstRun = subFirst($document, pNode, 'w:r');
    const firstRunRPr = firstRun ? parseRPr($document, subFirst($document, firstRun, 'w:rPr')) : null;
    result.paragraphs.push({ pStyle: pPr.pStyleVal, jc: pPr.jc, spacing: pPr.spacing, ind: pPr.ind, numPr: pPr.numPr, firstRunRPr });
  }
  return result;
}

function parseNumbering($numbering) {
  const abstractNums = new Map();
  const nums = new Map();
  if (!$numbering) return { abstractNums, nums };
  for (const absNode of xmlNodes($numbering, 'w:abstractNum')) {
    const absId = String(nodeAttr(absNode, 'w:abstractNumId') ?? '');
    const lvls = {};
    for (const lvlNode of subByName($numbering, absNode, 'w:lvl')) {
      const ilvl = Number(nodeAttr(lvlNode, 'w:ilvl') ?? -1);
      if (ilvl < 0) continue;
      const numFmtNode = subFirst($numbering, lvlNode, 'w:numFmt');
      const lvlTextNode = subFirst($numbering, lvlNode, 'w:lvlText');
      const startNode = subFirst($numbering, lvlNode, 'w:start');
      lvls[ilvl] = {
        numFmt: numFmtNode ? nodeAttr(numFmtNode, 'w:val') || null : null,
        lvlText: lvlTextNode ? nodeAttr(lvlTextNode, 'w:val') || null : null,
        start: startNode ? numAttr(startNode, 'w:val') : null,
      };
    }
    abstractNums.set(absId, lvls);
  }
  for (const numNode of xmlNodes($numbering, 'w:num')) {
    const numId = String(nodeAttr(numNode, 'w:numId') ?? '');
    const absRef = subFirst($numbering, numNode, 'w:abstractNumId');
    if (absRef) nums.set(numId, String(nodeAttr(absRef, 'w:val') ?? ''));
  }
  return { abstractNums, nums };
}

function resolveNumberingLvl(numbering, numPr, fallbackIlvl) {
  if (!numPr || numPr.numId == null) return null;
  const absId = numbering.nums.get(String(numPr.numId));
  if (!absId) return null;
  const lvls = numbering.abstractNums.get(absId);
  if (!lvls) return null;
  const ilvl = numPr.ilvl != null ? numPr.ilvl : fallbackIlvl;
  return lvls[ilvl] || lvls[0] || null;
}

function parseRels(relsXml) {
  const rels = new Map();
  if (!relsXml || !String(relsXml).trim()) return rels;
  const $ = parseXml(relsXml);
  if (!$) return rels;
  for (const relNode of xmlNodes($, 'Relationship')) {
    const id = nodeAttr(relNode, 'Id');
    const target = nodeAttr(relNode, 'Target');
    const type = nodeAttr(relNode, 'Type') || '';
    if (id && target) rels.set(id, { target, type });
  }
  return rels;
}

function resolvePartPath(target) {
  let t = String(target || '').replace(/\\/g, '/');
  if (t.startsWith('/')) t = t.slice(1);
  if (t.startsWith('word/')) return t;
  return `word/${t}`;
}

function xmlHasField($, fieldName) {
  if (!$) return false;
  const upper = String(fieldName).toUpperCase();
  for (const n of xmlNodes($, 'w:instrText')) {
    if ($(n).text().toUpperCase().includes(upper)) return true;
  }
  return false;
}

function readHeaderFooterParts(readEntry, refs, rels) {
  let text = '';
  let hasPage = false;
  for (const rid of refs) {
    const rel = rels.get(rid);
    if (!rel) continue;
    const xml = readEntry(resolvePartPath(rel.target));
    if (!xml) continue;
    const $ = parseXml(xml);
    if (!$) continue;
    for (const tNode of xmlNodes($, 'w:t')) text += $(tNode).text();
    if (xmlHasField($, 'PAGE')) hasPage = true;
  }
  return { text, hasPage };
}

function findBodyStyleId(styles) {
  for (const s of styles) {
    const name = String(s.name || '').trim();
    if (name === 'Normal' || name === '正文') return s.styleId;
  }
  for (const s of styles) {
    if (/正文/.test(s.name || '')) return s.styleId;
  }
  for (const s of styles) {
    if (/normal/i.test(s.name || '')) return s.styleId;
  }
  return null;
}

/** 单元格样式：提取字体/字号/对齐/文字色/底纹色（原始值，未经规则归一化）。 */
function parseTableCellStyle($, tc, themeFonts) {
  const out = { font: null, sizeHalf: null, jc: null, color: null, fill: null };
  if (!tc) return out;
  const tcPr = subFirst($, tc, 'w:tcPr');
  if (tcPr) {
    const shd = subFirst($, tcPr, 'w:shd');
    if (shd) out.fill = nodeAttr(shd, 'w:fill') || null;
  }
  const firstP = subFirst($, tc, 'w:p');
  if (firstP) {
    const pPr = parsePPr($, subFirst($, firstP, 'w:pPr'));
    out.jc = pPr.jc;
    const firstR = subFirst($, firstP, 'w:r');
    if (firstR) {
      const rPr = parseRPr($, subFirst($, firstR, 'w:rPr'));
      out.font = resolveFontName(rPr, themeFonts);
      out.sizeHalf = rPr.szHalf;
      out.color = rPr.color;
    }
  }
  return out;
}

const TABLE_BORDER_SIDES = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];

/** 表格边框：各边 w:sz（八分之一磅）取最大值作 pt，w:color（auto→null）作色值。 */
function parseTableBorder($, tblBorders) {
  const out = { widthPt: null, color: null };
  if (!tblBorders) return out;
  let maxSz = null;
  let color = null;
  for (const side of TABLE_BORDER_SIDES) {
    const sideNode = subFirst($, tblBorders, `w:${side}`);
    if (!sideNode) continue;
    const sz = numAttr(sideNode, 'w:sz');
    if (sz != null) maxSz = maxSz == null ? sz : Math.max(maxSz, sz);
    if (color == null) {
      const c = nodeAttr(sideNode, 'w:color');
      if (c && String(c).toLowerCase() !== 'auto') color = c;
    }
  }
  if (maxSz != null) out.widthPt = round2(maxSz / 8);
  out.color = colorToHex(color);
  return out;
}

/** 表格 facts：边框/边距/整宽 + 表头、首列、正文格三组单元格样式。 */
function parseTableFacts($, tbls, sectPr, themeFonts) {
  if (!tbls || tbls.length === 0) return null;
  // 多个表时取第一个含边框/底纹信息的作代表
  let chosen = null;
  for (const tbl of tbls) {
    const tblPr = subFirst($, tbl, 'w:tblPr');
    const tblBorders = tblPr ? subFirst($, tblPr, 'w:tblBorders') : null;
    const tblShd = tblPr ? subFirst($, tblPr, 'w:shd') : null;
    if (tblBorders || tblShd) { chosen = tbl; break; }
  }
  if (!chosen) chosen = tbls[0];

  const tblPr = subFirst($, chosen, 'w:tblPr');

  const border = parseTableBorder($, tblPr ? subFirst($, tblPr, 'w:tblBorders') : null);

  let cellPaddingPt = null;
  const tblCellMar = tblPr ? subFirst($, tblPr, 'w:tblCellMar') : null;
  if (tblCellMar) {
    const top = subFirst($, tblCellMar, 'w:top');
    const left = subFirst($, tblCellMar, 'w:left');
    const w = top ? numAttr(top, 'w:w') : (left ? numAttr(left, 'w:w') : null);
    if (w != null) cellPaddingPt = spacingTwipsToPt(w);
  }

  let fullWidth = false;
  const tblW = tblPr ? subFirst($, tblPr, 'w:tblW') : null;
  if (tblW) {
    const type = nodeAttr(tblW, 'w:type');
    const w = numAttr(tblW, 'w:w');
    if (type === 'pct') {
      // pct 单位为五十分之一百分比，5000 即 100%
      fullWidth = w != null && w >= 5000;
    } else if (type === 'dxa') {
      const availTwips = (sectPr?.widthTwips ?? 0) - (sectPr?.margins?.left ?? 0) - (sectPr?.margins?.right ?? 0);
      fullWidth = w != null && availTwips > 0 && Math.abs(w - availTwips) <= 60;
    }
  }

  const trs = subByName($, chosen, 'w:tr');
  let headerRow = null;
  for (const tr of trs) {
    const trPr = subFirst($, tr, 'w:trPr');
    if (trPr && subFirst($, trPr, 'w:tblHeader')) { headerRow = tr; break; }
  }
  if (!headerRow) headerRow = trs[0] || null;

  const headerTc = headerRow ? subFirst($, headerRow, 'w:tc') : null;
  const header = parseTableCellStyle($, headerTc, themeFonts);

  const firstDataRow = trs[1] || trs[0] || null;
  const firstColTc = firstDataRow ? subFirst($, firstDataRow, 'w:tc') : null;
  const firstColumn = parseTableCellStyle($, firstColTc, themeFonts);

  let bodyCellTc = null;
  if (trs[1]) {
    const tcs = subByName($, trs[1], 'w:tc');
    bodyCellTc = tcs[1] || tcs[0] || null;
  }
  if (!bodyCellTc && trs[0]) {
    const tcs = subByName($, trs[0], 'w:tc');
    bodyCellTc = tcs[0] || null;
  }
  const bodyCell = parseTableCellStyle($, bodyCellTc, themeFonts);

  return {
    border_width: border.widthPt,
    border_color: border.color,
    cell_padding_pt: cellPaddingPt,
    full_width: fullWidth,
    header_row: header,
    first_column: firstColumn,
    body_cell: bodyCell,
  };
}

/** 段落纯文本（拼接所有 w:t）。 */
function paragraphText($, p) {
  let text = '';
  for (const t of subByName($, p, 'w:t')) text += $(t).text();
  return text.trim();
}

/** 返回第一个包含指定标签名的段落。 */
function findParagraphContaining($, name) {
  for (const p of xmlNodes($, 'w:p')) {
    if (subFirst($, p, name)) return p;
  }
  return null;
}

/** 是否图注段：文本以「图+数字/中文数字」开头，或样式名含题注/Caption/图注。 */
function isCaptionParagraph($, p, stylesMap) {
  if (/^图\s*[0-9一二三四五六七八九十]/.test(paragraphText($, p))) return true;
  const pStyle = subFirst($, p, 'w:pStyle');
  const styleId = pStyle ? nodeAttr(pStyle, 'w:val') : null;
  if (styleId) {
    const style = stylesMap.get(styleId);
    if (style && /题注|Caption|图注/.test(String(style.name || ''))) return true;
  }
  return false;
}

/** 图片 facts：尺寸（EMU→pt→最大宽度百分比）、对齐、图注样式。 */
function parseImageFacts($, drawings, picts, page, themeFonts, stylesMap) {
  const hasDrawing = drawings && drawings.length > 0;
  const hasPict = picts && picts.length > 0;
  if (!hasDrawing && !hasPict) return null;

  const image = {
    max_width_percent: null,
    jc: null,
    caption_font: null,
    caption_size_half: null,
    caption_jc: null,
    caption_bold: null,
    caption_italic: null,
  };

  let cxEmu = null;
  for (const d of drawings || []) {
    const inline = subFirst($, d, 'wp:inline');
    const anchor = subFirst($, d, 'wp:anchor');
    const container = inline || anchor;
    if (!container) continue;
    const extent = subFirst($, container, 'wp:extent');
    if (extent) {
      const cx = numAttr(extent, 'cx');
      if (cx != null) { cxEmu = cx; break; }
    }
  }
  if (cxEmu != null) {
    const cxPt = cxEmu / 12700;
    const widthMm = page && page.widthMm != null ? page.widthMm : null;
    const leftMm = (page && page.margins && page.margins.leftCm != null ? page.margins.leftCm : 0) * 10;
    const rightMm = (page && page.margins && page.margins.rightCm != null ? page.margins.rightCm : 0) * 10;
    const availMm = widthMm != null ? widthMm - leftMm - rightMm : null;
    if (availMm != null && availMm > 0) {
      const availPt = (availMm * 72) / 25.4;
      let pct = Math.round((cxPt / availPt) * 100);
      pct = Math.max(1, Math.min(100, pct));
      image.max_width_percent = pct;
    }
  }

  const imgPara = findParagraphContaining($, 'w:drawing') || findParagraphContaining($, 'w:pict');
  if (imgPara) {
    const pPr = parsePPr($, subFirst($, imgPara, 'w:pPr'));
    image.jc = pPr.jc;
  }

  // 图注：优先图片紧邻的下一段/上一段，再回退到全篇任意匹配段
  const allP = xmlNodes($, 'w:p');
  const imgIndex = imgPara ? allP.indexOf(imgPara) : -1;
  let caption = null;
  if (imgIndex >= 0) {
    const next = allP[imgIndex + 1];
    if (next && isCaptionParagraph($, next, stylesMap)) caption = next;
    if (!caption) {
      const prev = allP[imgIndex - 1];
      if (prev && isCaptionParagraph($, prev, stylesMap)) caption = prev;
    }
  }
  if (!caption) {
    for (const p of allP) {
      if (isCaptionParagraph($, p, stylesMap)) { caption = p; break; }
    }
  }

  if (caption) {
    const pPr = parsePPr($, subFirst($, caption, 'w:pPr'));
    image.caption_jc = pPr.jc;
    const firstR = subFirst($, caption, 'w:r');
    if (firstR) {
      const rPrNode = subFirst($, firstR, 'w:rPr');
      const rPr = parseRPr($, rPrNode);
      image.caption_font = resolveFontName(rPr, themeFonts);
      image.caption_size_half = rPr.szHalf;
      image.caption_bold = rPr.b;
      const iNode = subFirst($, rPrNode, 'w:i');
      if (iNode) {
        const val = nodeAttr(iNode, 'w:val');
        image.caption_italic = val == null ? true : (String(val) !== '0' && String(val).toLowerCase() !== 'false');
      }
    }
  }

  return image;
}

/** 解包 docx 并抽取结构化 facts（原始值，未经规则归一化）。 */
function parseOoxml(filePath, log) {
  const logFn = typeof log === 'function' ? log : () => {};
  const zip = new AdmZip(filePath);
  const readEntry = (name) => {
    const entry = zip.getEntry(name);
    return entry ? entry.getData().toString('utf-8') : '';
  };

  const $styles = parseXml(readEntry('word/styles.xml'));
  const $document = parseXml(readEntry('word/document.xml'));
  const $numbering = parseXml(readEntry('word/numbering.xml'));
  const $theme = parseXml(readEntry('word/theme/theme1.xml'));
  const rels = parseRels(readEntry('word/_rels/document.xml.rels'));

  const themeFonts = parseThemeFonts($theme);
  const { styles, docDefaultsRPr, docDefaultsPPr } = parseStyles($styles, themeFonts);
  const stylesMap = new Map(styles.map((s) => [s.styleId, s]));
  const numbering = parseNumbering($numbering);
  const docInfo = parseDocument($document);

  // 页面设置
  const page = { firstPageDifferent: false, hasHeaderRef: false, hasFooterRef: false };
  if (docInfo.sectPr) {
    const sp = docInfo.sectPr;
    page.widthMm = twipsToMm(sp.widthTwips);
    page.heightMm = twipsToMm(sp.heightTwips);
    page.orient = sp.orient;
    page.firstPageDifferent = sp.titlePg;
    page.hasHeaderRef = sp.headerRefs.length > 0;
    page.hasFooterRef = sp.footerRefs.length > 0;
    if (sp.margins) {
      page.margins = {
        topCm: twipsToCm(sp.margins.top),
        bottomCm: twipsToCm(sp.margins.bottom),
        leftCm: twipsToCm(sp.margins.left),
        rightCm: twipsToCm(sp.margins.right),
      };
    }
    const headerParts = readHeaderFooterParts(readEntry, sp.headerRefs, rels);
    const footerParts = readHeaderFooterParts(readEntry, sp.footerRefs, rels);
    page.headerText = headerParts.text;
    page.headerHasPage = headerParts.hasPage;
    page.footerText = footerParts.text;
    page.footerHasPage = footerParts.hasPage;
  }

  // 标题样式（outlineLvl 0-5）
  const headings = new Array(6).fill(null);
  for (const style of styles) {
    const lvl = style.outlineLvl;
    if (lvl == null || lvl < 0 || lvl > 5) continue;
    if (headings[lvl]) continue;
    const resolved = resolveStyleProps(stylesMap, style.styleId, docDefaultsRPr, docDefaultsPPr);
    headings[lvl] = {
      styleId: style.styleId,
      name: style.name,
      font: resolveFontName(resolved.rPr, themeFonts),
      sizeHalf: resolved.rPr.szHalf,
      bold: resolved.rPr.b,
      jc: resolved.pPr.jc,
      color: resolved.rPr.color,
      spacingBeforeTwips: resolved.pPr.spacing?.beforeTwips ?? null,
      spacingAfterTwips: resolved.pPr.spacing?.afterTwips ?? null,
      firstLineChars: resolved.pPr.ind?.firstLineChars ?? null,
      line: resolved.pPr.spacing?.line ?? null,
      lineRule: resolved.pPr.spacing?.lineRule ?? null,
    };
  }

  // 标题段落级 numPr（比样式级更常见）
  const paragraphNumPrByStyle = new Map();
  for (const para of docInfo.paragraphs) {
    if (para.pStyle && para.numPr && !paragraphNumPrByStyle.has(para.pStyle)) {
      paragraphNumPrByStyle.set(para.pStyle, para.numPr);
    }
  }
  for (let i = 0; i < 6; i += 1) {
    if (!headings[i]) continue;
    const styleNumPr = (stylesMap.get(headings[i].styleId)?.pPr?.numPr) || null;
    const numPr = paragraphNumPrByStyle.get(headings[i].styleId) || styleNumPr;
    const lvl = resolveNumberingLvl(numbering, numPr, i);
    if (lvl) {
      headings[i].numFmt = lvl.numFmt;
      headings[i].lvlText = lvl.lvlText;
    }
  }

  // 正文样式
  const bodyStyleId = findBodyStyleId(styles);
  const bodyResolved = bodyStyleId
    ? resolveStyleProps(stylesMap, bodyStyleId, docDefaultsRPr, docDefaultsPPr)
    : { rPr: docDefaultsRPr, pPr: docDefaultsPPr };
  const body = {
    font: resolveFontName(bodyResolved.rPr, themeFonts),
    sizeHalf: bodyResolved.rPr.szHalf,
    jc: bodyResolved.pPr.jc,
    spacingBeforeTwips: bodyResolved.pPr.spacing?.beforeTwips ?? null,
    spacingAfterTwips: bodyResolved.pPr.spacing?.afterTwips ?? null,
    firstLineChars: bodyResolved.pPr.ind?.firstLineChars ?? null,
    line: bodyResolved.pPr.spacing?.line ?? null,
    lineRule: bodyResolved.pPr.spacing?.lineRule ?? null,
  };

  // 正文段落直接格式兜底（无样式/正文样式段落的首个 run rPr）
  const bodySample = { font: null, sizeHalf: null, jc: null };
  for (const para of docInfo.paragraphs) {
    const isBodyPara = !para.pStyle || para.pStyle === bodyStyleId;
    if (!isBodyPara) continue;
    if (bodySample.font == null && para.firstRunRPr) {
      bodySample.font = resolveFontName(para.firstRunRPr, themeFonts);
      bodySample.sizeHalf = para.firstRunRPr.szHalf;
    }
    if (bodySample.jc == null && para.jc) bodySample.jc = para.jc;
    if (bodySample.font != null && bodySample.jc != null) break;
  }

  // 表格样式
  const tblNodes = xmlNodes($document, 'w:tbl');
  const table = parseTableFacts($document, tblNodes, docInfo.sectPr, themeFonts);

  // 图片样式
  const drawingNodes = xmlNodes($document, 'w:drawing');
  const pictNodes = xmlNodes($document, 'w:pict');
  const image = parseImageFacts($document, drawingNodes, pictNodes, page, themeFonts, stylesMap);

  logFn('解析完成：样式/页面/编号/页眉页脚已抽取');
  return { page, headings, body, bodySample, table, image };
}

// ── 规则映射层（facts → config + confidence） ───────────────────────
function mapFactsToConfig(facts, options = {}) {
  const config = createDefaultConfig();
  const sources = {};
  const unclassified = [];
  const sourceFileName = options.sourceFileName || '';

  const setField = (field, value) => {
    setByPath(config, field, value);
    sources[field] = 'rule';
  };
  const pushUnclassified = (kind, raw, field) => {
    unclassified.push({ kind, raw: String(raw == null ? '' : raw), field });
  };

  if (sourceFileName) {
    config.template_name = sourceFileName.replace(/\.[^.]+$/, '');
    sources.template_name = 'rule';
  }

  // 页面设置
  const pg = facts.page || {};
  if (pg.widthMm != null || pg.heightMm != null) {
    const paper = paperSizeFromMm(pg.widthMm, pg.heightMm);
    // Letter/Legal 是 Word/WPS 的出厂默认纸张（尤其 WPS 新建文档常默认 Letter），
    // 中文标书以 A4 为准，这里忽略以免覆盖默认 A4。
    if (paper && paper !== 'letter' && paper !== 'legal') setField('page.paper_size', paper);
    else if (!paper) pushUnclassified('paper', `${pg.widthMm}×${pg.heightMm}mm`, 'page.paper_size');
  }
  if (pg.orient != null || pg.widthMm != null) {
    setField('page.orientation', mapOrientation(pg.orient, pg.widthMm, pg.heightMm));
  }
  if (pg.firstPageDifferent != null) setField('page.first_page_different', Boolean(pg.firstPageDifferent));
  if (pg.margins) {
    // Word/WPS 出厂边距（上下 1 英寸 ≈ 2.54cm、左右 1.25 英寸 ≈ 3.17cm）是未格式化的默认值，
    // 中文标书正文常见四周 2.2cm 左右，这里忽略以免覆盖默认边距。
    const isFactoryDefaultMargin = pg.margins.topCm === 2.54
      && pg.margins.bottomCm === 2.54
      && pg.margins.leftCm === 3.17
      && pg.margins.rightCm === 3.17;
    if (!isFactoryDefaultMargin) {
      if (pg.margins.topCm != null) setField('page.margin_top_cm', pg.margins.topCm);
      if (pg.margins.bottomCm != null) setField('page.margin_bottom_cm', pg.margins.bottomCm);
      if (pg.margins.leftCm != null) setField('page.margin_left_cm', pg.margins.leftCm);
      if (pg.margins.rightCm != null) setField('page.margin_right_cm', pg.margins.rightCm);
    }
  }
  if (pg.hasHeaderRef != null) {
    setField('page.header_enabled', Boolean(pg.hasHeaderRef));
    if (pg.headerText) setField('page.header_text', pg.headerText);
  }
  if (pg.hasFooterRef != null) {
    setField('page.footer_enabled', Boolean(pg.hasFooterRef));
    if (pg.footerText) setField('page.footer_text', pg.footerText);
  }
  if (pg.footerHasPage === true) setField('page.page_number_enabled', true);

  // 标题样式
  for (let i = 0; i < 6; i += 1) {
    const h = facts.headings?.[i];
    if (!h) continue;
    if (h.font) {
      const font = normalizeFont(h.font);
      if (font) setField(`headings.${i}.font`, font);
      else pushUnclassified('font', h.font, `headings.${i}.font`);
    }
    if (h.sizeHalf != null) {
      const pt = halfPointsToPt(h.sizeHalf);
      const size = ptToSizeName(pt);
      if (size) setField(`headings.${i}.size`, size);
      else pushUnclassified('size', `${pt}pt`, `headings.${i}.size`);
    }
    if (h.jc) {
      const alignment = jcToAlignment(h.jc);
      if (alignment) setField(`headings.${i}.alignment`, alignment);
    }
    if (h.bold != null) setField(`headings.${i}.bold`, Boolean(h.bold));
    if (h.color) {
      const hex = colorToHex(h.color);
      if (hex) setField(`headings.${i}.text_color`, hex);
    }
    if (h.spacingBeforeTwips != null) setField(`headings.${i}.spacing_before_pt`, spacingTwipsToPt(h.spacingBeforeTwips));
    if (h.spacingAfterTwips != null) setField(`headings.${i}.spacing_after_pt`, spacingTwipsToPt(h.spacingAfterTwips));
    if (h.firstLineChars != null) setField(`headings.${i}.first_line_indent_chars`, firstLineCharsToNumber(h.firstLineChars));
    if (h.line != null) {
      const multiple = lineToMultiple(h.line, h.lineRule);
      if (multiple != null) setField(`headings.${i}.line_spacing`, multiple);
    }
    if (h.numFmt || h.lvlText) {
      const numberingInfo = detectHeadingNumbering({ numFmt: h.numFmt, lvlText: h.lvlText });
      if (numberingInfo) {
        setField(`headings.${i}.numbering_format`, numberingInfo.format);
        if (numberingInfo.template) setField(`headings.${i}.numbering_template`, numberingInfo.template);
      }
    }
  }

  // 正文
  const body = facts.body || {};
  const sample = facts.bodySample || {};
  const bodyFont = body.font || sample.font;
  if (bodyFont) {
    const font = normalizeFont(bodyFont);
    if (font) setField('body_text.font', font);
    else pushUnclassified('font', bodyFont, 'body_text.font');
  }
  const bodySizeHalf = body.sizeHalf != null ? body.sizeHalf : sample.sizeHalf;
  if (bodySizeHalf != null) {
    const pt = halfPointsToPt(bodySizeHalf);
    const size = ptToSizeName(pt);
    // 五号及更小是 Word/WPS 的 Normal 出厂字号，非标书正文常见选择，保留默认小四。
    if (size && SIZE_TO_PT[size] > SIZE_TO_PT['五号']) setField('body_text.size', size);
    else if (!size) pushUnclassified('size', `${pt}pt`, 'body_text.size');
  }
  const bodyJc = body.jc || sample.jc;
  if (bodyJc) {
    const alignment = jcToAlignment(bodyJc);
    if (alignment) setField('body_text.alignment', alignment);
  }
  if (body.spacingBeforeTwips != null) setField('body_text.spacing_before_pt', spacingTwipsToPt(body.spacingBeforeTwips));
  if (body.spacingAfterTwips != null) setField('body_text.spacing_after_pt', spacingTwipsToPt(body.spacingAfterTwips));
  if (body.firstLineChars != null) setField('body_text.first_line_indent_chars', firstLineCharsToNumber(body.firstLineChars));
  if (body.line != null) {
    const multiple = lineToMultiple(body.line, body.lineRule);
    if (multiple != null) setField('body_text.line_spacing_multiple', multiple);
  }

  // 表格
  const table = facts.table;
  if (table) {
    if (table.border_width != null) setField('table.border_width', table.border_width);
    if (table.border_color) setField('table.border_color', table.border_color);
    if (table.cell_padding_pt != null) setField('table.cell_padding_pt', table.cell_padding_pt);
    if (table.full_width != null) setField('table.full_width', Boolean(table.full_width));

    const cellGroups = [
      ['header_row', table.header_row],
      ['first_column', table.first_column],
      ['body_cell', table.body_cell],
    ];
    for (const [key, cell] of cellGroups) {
      if (!cell) continue;
      if (cell.font) {
        const font = normalizeFont(cell.font);
        if (font) setField(`table.${key}.font`, font);
        else pushUnclassified('font', cell.font, `table.${key}.font`);
      }
      if (cell.sizeHalf != null) {
        const pt = halfPointsToPt(cell.sizeHalf);
        const size = ptToSizeName(pt);
        if (size) setField(`table.${key}.size`, size);
        else pushUnclassified('size', `${pt}pt`, `table.${key}.size`);
      }
      if (cell.jc) {
        const alignment = jcToAlignment(cell.jc);
        if (alignment) setField(`table.${key}.alignment`, alignment);
      }
      if (cell.color) {
        const hex = colorToHex(cell.color);
        if (hex) setField(`table.${key}.text_color`, hex);
      }
      if (cell.fill) {
        const hex = colorToHex(cell.fill);
        if (hex) setField(`table.${key}.background_color`, hex);
      }
    }
  }

  // 图片
  const image = facts.image;
  if (image) {
    if (image.max_width_percent != null) setField('image.max_width_percent', image.max_width_percent);
    if (image.jc) {
      const alignment = jcToAlignment(image.jc);
      if (alignment) setField('image.alignment', alignment);
    }
    if (image.caption_font) {
      const font = normalizeFont(image.caption_font);
      if (font) setField('image.caption_font', font);
      else pushUnclassified('font', image.caption_font, 'image.caption_font');
    }
    if (image.caption_size_half != null) {
      const pt = halfPointsToPt(image.caption_size_half);
      const size = ptToSizeName(pt);
      if (size) setField('image.caption_size', size);
      else pushUnclassified('size', `${pt}pt`, 'image.caption_size');
    }
    if (image.caption_jc) {
      const alignment = jcToAlignment(image.caption_jc);
      if (alignment) setField('image.caption_alignment', alignment);
    }
    if (image.caption_bold != null) setField('image.caption_bold', Boolean(image.caption_bold));
    if (image.caption_italic != null) setField('image.caption_italic', Boolean(image.caption_italic));
  }

  const confidenceByField = buildConfidenceMap(config);
  for (const [field, src] of Object.entries(sources)) confidenceByField[field] = src;

  const summary = buildSummary(config, sources, facts);
  return { config, confidenceByField, summary, unclassified };
}

function buildSummary(config, sources, facts) {
  const summary = [];
  const groupHasRule = (prefix) => Object.keys(sources).some((k) => k.startsWith(prefix) && sources[k] === 'rule');

  // 页面设置
  const pageHasRule = groupHasRule('page.');
  let pageText = '未检测到页面设置，使用默认 A4 纵向页面';
  if (pageHasRule) {
    const p = config.page;
    const orientLabel = p.orientation === 'landscape' ? '横向' : '纵向';
    pageText = `纸张 ${PAPER_SIZE_LABELS[p.paper_size] || p.paper_size} ${orientLabel}，页边距 上${p.margin_top_cm}cm 下${p.margin_bottom_cm}cm 左${p.margin_left_cm}cm 右${p.margin_right_cm}cm`;
  }
  summary.push({ group: '页面设置', text: pageText, source: pageHasRule ? 'rule' : 'default' });

  // 标题样式
  const headingParts = [];
  for (let i = 0; i < 6; i += 1) {
    if (sources[`headings.${i}.font`] === 'rule' || sources[`headings.${i}.size`] === 'rule' || sources[`headings.${i}.alignment`] === 'rule') {
      const h = config.headings[i];
      headingParts.push(`${HEADING_LEVEL_LABELS[i]}：${h.font} ${h.size} ${h.alignment}${h.bold ? ' 加粗' : ''}`);
    }
  }
  summary.push({
    group: '标题样式',
    text: headingParts.length ? headingParts.join('；') : '未检测到标题样式，使用默认标题格式',
    source: headingParts.length ? 'rule' : 'default',
  });

  // 正文
  const bodyHasRule = groupHasRule('body_text.');
  let bodyText = '未检测到正文样式，使用默认正文格式';
  if (bodyHasRule) {
    const b = config.body_text;
    bodyText = `正文：${b.font} ${b.size}，首行缩进${b.first_line_indent_chars}字符，${b.line_spacing_multiple}倍行距`;
  }
  summary.push({ group: '正文', text: bodyText, source: bodyHasRule ? 'rule' : 'default' });

  // 页眉页脚
  const hfHasRule = sources['page.header_enabled'] === 'rule' || sources['page.footer_enabled'] === 'rule';
  let hfText = '未检测到页眉页脚';
  if (hfHasRule) {
    const parts = [];
    if (config.page.header_enabled && config.page.header_text) parts.push(`页眉“${config.page.header_text}”`);
    else if (config.page.header_enabled) parts.push('含页眉');
    if (config.page.footer_enabled && config.page.page_number_enabled) parts.push('页脚含页码');
    else if (config.page.footer_enabled && config.page.footer_text) parts.push(`页脚“${config.page.footer_text}”`);
    hfText = parts.length ? parts.join('，') : '检测到页眉页脚占位';
  }
  summary.push({ group: '页眉页脚', text: hfText, source: hfHasRule ? 'rule' : 'default' });

  // 编号
  const numberingHasRule = Object.keys(sources).some((k) => k.endsWith('.numbering_format') && sources[k] === 'rule');
  let numberingText = '未检测到自动编号，沿用默认编号格式';
  if (numberingHasRule) {
    const anyCustom = Object.keys(sources).some((k) => k.endsWith('.numbering_template') && sources[k] === 'rule' && /第\{zh\}/.test(config.headings[0]?.numbering_template || ''));
    const anyOutline = Object.keys(sources).some((k) => k.endsWith('.numbering_format') && config.headings[0]?.numbering_format === 'outline-decimal');
    if (anyCustom) numberingText = '标题采用“第X章”式中文编号';
    else if (anyOutline) numberingText = '标题采用数字连续多级编号（1.1.1）';
    else numberingText = '检测到标题自动编号';
  }
  summary.push({ group: '编号', text: numberingText, source: numberingHasRule ? 'rule' : 'default' });

  // 表格
  const tableHasRule = groupHasRule('table.');
  let tableText = '未检测到表格样式，使用默认表格样式';
  if (tableHasRule) {
    const t = config.table;
    const parts = [];
    if (sources['table.border_width'] === 'rule') parts.push(`边框 ${t.border_width} pt`);
    const hdr = [];
    if (sources['table.header_row.font'] === 'rule' || sources['table.header_row.size'] === 'rule') hdr.push(`${t.header_row.font} ${t.header_row.size}`);
    if (sources['table.header_row.background_color'] === 'rule') hdr.push('底纹着色');
    if (hdr.length) parts.push(`表头 ${hdr.join(' ')}`);
    const cell = [];
    if (sources['table.body_cell.font'] === 'rule' || sources['table.body_cell.size'] === 'rule') cell.push(`${t.body_cell.font} ${t.body_cell.size}`);
    if (cell.length) parts.push(`单元格 ${cell.join(' ')}`);
    tableText = parts.length ? `表格：${parts.join('，')}` : '检测到表格样式';
  }
  summary.push({ group: '表格', text: tableText, source: tableHasRule ? 'rule' : 'default' });

  // 图片
  const imageHasRule = groupHasRule('image.');
  let imageText = '未检测到图片样式，使用默认图片样式';
  if (imageHasRule) {
    const img = config.image;
    const parts = [];
    if (sources['image.max_width_percent'] === 'rule') parts.push(`最大宽度 ${img.max_width_percent} %`);
    const cap = [];
    if (sources['image.caption_font'] === 'rule' || sources['image.caption_size'] === 'rule') cap.push(`${img.caption_font} ${img.caption_size}`);
    if (sources['image.caption_alignment'] === 'rule') cap.push(img.caption_alignment);
    if (img.caption_bold) cap.push('加粗');
    if (img.caption_italic) cap.push('斜体');
    if (cap.length) parts.push(`图注 ${cap.join(' ')}`);
    imageText = parts.length ? `图片：${parts.join('，')}` : '检测到图片样式';
  }
  summary.push({ group: '图片', text: imageText, source: imageHasRule ? 'rule' : 'default' });

  return summary;
}

// ── AI 兜底层（可选） ───────────────────────────────────────────────
function validateByKind(kind, value) {
  const v = typeof value === 'string' ? value.trim() : value;
  switch (kind) {
    case 'font': return FONT_OPTIONS.includes(v) ? v : null;
    case 'size': return SIZE_OPTIONS.includes(v) ? v : null;
    case 'alignment': return ALIGNMENT_OPTIONS.includes(v) ? v : null;
    case 'numbering_format': return ['outline-decimal', 'custom'].includes(v) ? v : null;
    case 'paper': return PAPER_SIZES.includes(v) ? v : null;
    default: return null;
  }
}

function buildAiMessages(unclassified) {
  return [
    { role: 'system', content: '你是 Word 模板格式识别助手。请把无法确定的中文字号、字体、对齐、纸张等原始值规范化为指定枚举。只能返回 JSON 对象，键为字段路径，值为给定枚举中的一个，不得编造、不得包含枚举之外的值。' },
    { role: 'user', content: `待规范化项：\n${JSON.stringify(unclassified, null, 2)}\n\n可用字号：${SIZE_OPTIONS.join('、')}\n可用字体：${FONT_OPTIONS.join('、')}\n可用对齐：${ALIGNMENT_OPTIONS.join('、')}\n可用编号格式：outline-decimal、custom\n可用纸张：${PAPER_SIZES.join('、')}` },
  ];
}

function normalizeAiPatches(result, unclassified) {
  const raw = result && typeof result === 'object'
    ? (result.fields && typeof result.fields === 'object' ? result.fields : result)
    : {};
  if (!raw || typeof raw !== 'object') return [];
  const byField = new Map(unclassified.map((u) => [u.field, u]));
  const patches = [];
  for (const [field, value] of Object.entries(raw)) {
    const item = byField.get(field);
    if (!item) continue; // 只允许补 unclassified，拒绝 AI 越界写其他字段
    if (value == null || value === '') continue;
    const validated = validateByKind(item.kind, value);
    if (validated === null) continue; // 非法值丢弃，保持默认
    patches.push({ field, value: validated });
  }
  return patches;
}

async function applyAiFallback({ aiService, config, confidenceByField, unclassified, offlineMode, log }) {
  const logFn = typeof log === 'function' ? log : () => {};
  if (!unclassified || !unclassified.length) return;

  const markDefault = () => {
    for (const item of unclassified) {
      if (confidenceByField[item.field] == null || confidenceByField[item.field] === 'default') {
        confidenceByField[item.field] = 'default';
      }
    }
  };

  if (offlineMode === true) {
    logFn('离线模式，跳过 AI 兜底识别');
    markDefault();
    return;
  }
  if (!aiService || typeof aiService.collectJsonResponse !== 'function') {
    logFn('未配置 AI 服务，跳过 AI 兜底识别');
    markDefault();
    return;
  }

  try {
    const result = await aiService.collectJsonResponse({
      messages: buildAiMessages(unclassified),
      logTitle: '模板格式智能识别',
      progressLabel: '模板格式兜底识别',
      failureMessage: 'AI 兜底识别返回结果无效',
      max_retries: 0,
    });
    const patches = normalizeAiPatches(result, unclassified);
    for (const patch of patches) {
      setByPath(config, patch.field, patch.value);
      confidenceByField[patch.field] = 'ai';
    }
    logFn(`AI 兜底识别补充 ${patches.length} 项格式`);
  } catch (error) {
    logFn(`AI 兜底识别失败：${error?.message || String(error)}，沿用默认值`);
    markDefault();
  }
}

// ── 入口 ────────────────────────────────────────────────────────────
async function analyzeTemplateWord({ aiService, filePath, log, offlineMode }) {
  const logFn = typeof log === 'function' ? log : () => {};
  const inputPath = path.resolve(String(filePath || ''));
  if (!inputPath || inputPath === path.resolve('.')) {
    throw new Error('未指定要分析的 Word 文件路径');
  }

  const convert = await import('./doc2markdown/convert.mjs');
  const format = await convert.detectFileFormat(inputPath);

  let facts;
  let sourceFormat = detectSourceFormat(inputPath, format);
  if (format === 'docx') {
    logFn('正在解析 DOCX 文档结构…');
    facts = parseOoxml(inputPath, logFn);
  } else if (format === 'legacy_word') {
    logFn('.doc/.wps 文件，正在转换为 DOCX 后解析…');
    try {
      facts = await convert.withLegacyWordDocxFile(inputPath, (docxPath) => parseOoxml(docxPath, logFn));
    } catch (error) {
      if (isLibreOfficeMissingError(error)) {
        throw normalizeDocumentParseError(error, inputPath);
      }
      throw error;
    }
  } else {
    throw new Error('仅支持 .docx / .doc / .wps 格式的 Word 文档');
  }

  const mapped = mapFactsToConfig(facts, { sourceFileName: path.basename(inputPath) });
  if (mapped.unclassified.length > 0) {
    await applyAiFallback({
      aiService,
      config: mapped.config,
      confidenceByField: mapped.confidenceByField,
      unclassified: mapped.unclassified,
      offlineMode,
      log: logFn,
    });
  }

  return {
    config: mapped.config,
    summary: mapped.summary,
    confidenceByField: mapped.confidenceByField,
    sourceFileName: path.basename(inputPath),
    sourceFormat,
  };
}

module.exports = {
  analyzeTemplateWord,
  parseOoxml,
  mapFactsToConfig,
  applyAiFallback,
  createDefaultConfig,
  buildConfidenceMap,
  collectLeafPaths,
  // 规则映射纯函数
  halfPointsToPt,
  ptToSizeName,
  normalizeFont,
  jcToAlignment,
  twipsToCm,
  twipsToMm,
  spacingTwipsToPt,
  firstLineCharsToNumber,
  lineToMultiple,
  colorToHex,
  detectHeadingNumbering,
  paperSizeFromMm,
  detectSourceFormat,
};
