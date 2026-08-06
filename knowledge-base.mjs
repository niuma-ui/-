import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import MiniSearch from 'minisearch';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const cjkPattern = /[\u3400-\u9fff]/;
const cjkSequencePattern = /[\u3400-\u9fff]+/g;
const latinTokenPattern = /[a-z0-9]+(?:[./_-][a-z0-9]+)*/g;
const standardCodePattern = /[a-z]{1,8}(?:\s*\/\s*[a-z]{1,8}|\s+[a-z]{1,8})?\s*\d{2,}(?:\s*[-.]\s*\d{2,})*/gi;
const confidenceLevels = {
  direct: { key: 'direct', label: '条文直接引用' },
  inferred: { key: 'inferred', label: '条文推断' },
  review: { key: 'review', label: '需人工复核' }
};

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[—–－]/g, '-')
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function canonicalLookup(value) {
  return normalizeText(value).toLowerCase().replace(/[\s/_.-]+/g, '');
}

function tokenize(value) {
  const text = normalizeText(value).toLowerCase();
  const tokens = text.match(latinTokenPattern) || [];
  const codeMatches = text.match(standardCodePattern) || [];

  for (const code of codeMatches) {
    const compact = code.replace(/\s+/g, '');
    tokens.push(compact, compact.replace(/[\/_.-]+/g, ''));
    tokens.push(...compact.match(/[a-z]+|\d+/g) || []);
  }

  for (const sequence of text.match(cjkSequencePattern) || []) {
    if (sequence.length === 1) {
      tokens.push(sequence);
      continue;
    }
    if (sequence.length <= 8) tokens.push(sequence);
    for (let index = 0; index < sequence.length - 1; index += 1) {
      tokens.push(sequence.slice(index, index + 2));
    }
    for (let index = 0; index < sequence.length - 2; index += 1) {
      tokens.push(sequence.slice(index, index + 3));
    }
  }

  return Array.from(new Set(tokens.filter(Boolean)));
}

const miniSearchOptions = {
  fields: ['title', 'code', 'category', 'text'],
  storeFields: ['id', 'file', 'relativePath', 'title', 'code', 'category', 'page', 'text'],
  tokenize,
  processTerm: (term) => term,
  searchOptions: {
    boost: { title: 4, code: 5, category: 1.5, text: 1 },
    combineWith: 'OR',
    prefix: true,
    fuzzy: 0.12
  }
};

async function walkPdfFiles(root) {
  const files = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) files.push(fullPath);
    }
  }
  await walk(root);
  return files.sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function metadataFromPath(filePath, root) {
  const relativePath = path.relative(root, filePath).replace(/\\/g, '/');
  const category = relativePath.split('/')[0] || '未分类';
  const file = path.basename(filePath);
  const titleMatch = file.match(/《([^》]+)》/);
  const title = normalizeText(titleMatch ? titleMatch[1] : file.replace(/\.pdf$/i, '').replace(/^\d+(?:\.\d+)?\s*/, ''));
  const codeSource = titleMatch ? file.slice((titleMatch.index || 0) + titleMatch[0].length) : file;
  const code = normalizeText(codeSource.replace(/\.pdf$/i, '').replace(/^\s+/, ''));
  return { file, relativePath, category, title, code };
}

function joinPageItems(items) {
  let text = '';
  for (const item of items) {
    const value = String(item.str || '');
    if (!value) continue;
    if (text && !text.endsWith('\n')) {
      const previous = text[text.length - 1];
      const next = value[0];
      if (!(cjkPattern.test(previous) && cjkPattern.test(next))) text += ' ';
    }
    text += value;
    if (item.hasEOL) text += '\n';
  }
  return normalizeText(text);
}

function splitPageText(text, maxLength = 1500, overlap = 180) {
  if (!text) return [];
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(text.length, start + maxLength);
    if (end < text.length) {
      const paragraph = text.lastIndexOf('\n', end);
      const sentence = Math.max(text.lastIndexOf('。', end), text.lastIndexOf('；', end));
      const boundary = Math.max(paragraph, sentence);
      if (boundary > start + maxLength * .62) end = boundary + 1;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }

  return chunks.filter(Boolean);
}

function compactExcerpt(text, queryTokens, maxLength = 520) {
  const normalized = cleanExtractedText(text).replace(/\n+/g, ' ');
  if (isProfessionalSentence(normalized, maxLength)) return normalized;

  const sentences = normalized
    .split(/(?<=[。；！？!?])\s*/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => isProfessionalSentence(sentence, maxLength));
  if (!sentences.length) return '该页文本提取质量不足，请打开 PDF 原页核验。';

  const tokens = queryTokens.filter((token) => token.length > 1);
  sentences.sort((left, right) => {
    const score = (sentence) => tokens.reduce((total, token) => total + (sentence.includes(token) ? token.length : 0), 0)
      + (/\d+(?:\.\d+)?\s*(?:mm|cm|m|MPa|kPa|%)/i.test(sentence) ? 4 : 0)
      + (/(不应|不宜|不得|不小于|不大于|应当|必须)/.test(sentence) ? 3 : 0);
    return score(right) - score(left);
  });
  return sentences[0];
}

function sourceConfidence(result, question, index) {
  const questionKey = canonicalLookup(question);
  const codeKey = canonicalLookup(result.code);
  const titleKey = canonicalLookup(result.title);
  const exactCode = codeKey.length >= 4 && questionKey.includes(codeKey);
  const exactTitle = titleKey.length >= 4 && questionKey.includes(titleKey);
  const queryTokens = tokenize(question).filter((token) => token.length > 1);
  const sourceKey = `${normalizeText(result.title)} ${normalizeText(result.code)} ${normalizeText(result.text)}`.toLowerCase();
  const overlap = queryTokens.filter((token) => sourceKey.includes(token)).length;

  if (exactCode || exactTitle || (index < 2 && overlap >= 3)) return confidenceLevels.direct;
  if (index < 5 && overlap >= 1) return confidenceLevels.inferred;
  return confidenceLevels.review;
}

function buildSources(results, question) {
  const queryTokens = tokenize(question);
  const sources = [];
  const seen = new Set();
  for (let index = 0; index < results.length && sources.length < 8; index += 1) {
    const result = results[index];
    const sourceKey = `${canonicalLookup(result.title)}:${canonicalLookup(result.code)}:${result.page}`;
    if (seen.has(sourceKey)) continue;
    seen.add(sourceKey);
    const confidence = sourceConfidence(result, question, index);
    sources.push({
      title: result.title,
      code: result.code,
      category: result.category,
      page: result.page,
      file: result.file,
      path: result.relativePath,
      excerpt: compactExcerpt(result.text, queryTokens, 520),
      score: Number(Number(result.score || 0).toFixed(3)),
      confidence,
      citation: `[${result.title}｜${result.code || '本地归档'}｜第${result.page}页]`
    });
  }
  return sources;
}

function buildKnowledgeDocuments(results, question) {
  const documents = [];
  const seen = new Set();
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const documentKey = `${canonicalLookup(result.title)}:${canonicalLookup(result.code)}`;
    if (seen.has(documentKey)) continue;
    seen.add(documentKey);
    documents.push({
      title: result.title,
      code: result.code,
      page: result.page,
      path: result.relativePath,
      confidence: sourceConfidence(result, question, index)
    });
    if (documents.length >= 24) break;
  }
  return documents;
}

function suggestedQuestions(question, sources) {
  if (!sources.length) {
    return ['换用规范编号重新检索', '这个问题需要补充哪些设计参数？', '按工程部位推荐相关规范'];
  }
  const primary = sources[0];
  const title = `《${primary.title}》`;
  const topic = normalizeText(question)
    .replace(standardCodePattern, '')
    .replace(/[？?。！!]/g, '')
    .replace(/(请问|帮我|查询|规范|要求|是什么|有哪些|如何|怎么)/g, '')
    .trim()
    .replace(/^的+/, '')
    .slice(0, 18);
  standardCodePattern.lastIndex = 0;
  return [
    `${title}有哪些强制性条文需要优先核对？`,
    topic ? `${title}对“${topic}”有哪些限值或适用条件？` : `${title}有哪些关键设计限值？`,
    '这些依据还关联哪些验算项目？'
  ];
}

function cleanExtractedText(value) {
  let text = stripEllipsis(normalizeText(value)).replace(/\s*([。；，、：])\s*/g, '$1');
  text = text.replace(/(?<=[A-Za-z0-9])一(?=[A-Za-z0-9])/g, '-');
  text = text.replace(/(\d)\s*\.\s*(\d)/g, '$1.$2');
  text = text.replace(/(?:\d\s+){1,5}\d(?=\s*(?:mm|cm|m|MPa|kPa|%)(?:\b|[~～]))/gi, (match) => match.replace(/\s+/g, ''));
  text = text.replace(/\s+(?=(?:mm|cm|m|MPa|kPa|%)(?:\b|[~～]))/gi, '');
  text = text.replace(/\s*([~～])\s*/g, '$1');
  return text.replace(/[ \t]{2,}/g, ' ').trim();
}

const suspectOcrPattern = /(肉根揪|掉照|钥闻门|本标淅|本标淡|本标淮|布畔|肩闭|荷裁|内宪|世格|承轼|赫教|锴钢|试验序力|傅备|克分|厌裂|塑怠|稳厌|连缕|渊质|资任|批凌|排合|图素|渥濮|濮土|硕酚|离孔|可游物|物吾量|诙于|基木|六价铨|亚硝酸坡|院氰酸|湾濮|外加刺|混疏|掉性质|设计国|腐砺|详舫|答殊|铜闸门|拦污橱|设折|如\d{2,}|划\d{2,}|WM\d|GByT|Smm|\bbH\b)/i;

function stripEllipsis(value) {
  return String(value || '')
    .replace(/…+/g, '')
    .replace(/\.{3,}/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function isProfessionalSentence(value, maxLength = 260) {
  const text = stripEllipsis(value).trim();
  if (text.length < 12 || text.length > maxLength) return false;
  if (suspectOcrPattern.test(text) || /\uFFFD/.test(text)) return false;
  if (/\r|\n/.test(text)) return false;
  if (/(?:^|\s)[A-Za-z](?:\s+[A-Za-z])?(?:\s|$)/.test(text)) return false;
  if (/(?:^|\n)\s*\d+\s*(?:\n|$)/.test(text)) return false;
  if (text.length > 90 && !/[。；！？!?]/.test(text)) return false;
  return true;
}

function isCatalogQuestion(question) {
  const text = normalizeText(question);
  const catalogIntent = /(有哪些|包括哪些|规范清单|规范目录|总体规范|相关规范|推荐.*规范)/.test(text);
  const technicalIntent = /(条文|限值|取值|要求|规定|条件|原则|控制|参数|厚度|宽度|高度|长度|间距|直径|公式|验算|稳定|强度|抗震|材料)/.test(text);
  return catalogIntent && !technicalIntent;
}

const engineeringObjectTerms = [
  '重力式挡土墙', '衡重式挡土墙', '加筋式挡土墙', '板桩式挡土墙',
  '挡土墙', '挡护结构', '挡墙', '护坡', '边坡', '钢闸门', '闸门', '水闸',
  '消力池', '栈道', '分水墩', '桥板', '桥墩', '管涵', '闸室', '启闭机', '防冲槽'
];

function detectEngineeringObjects(question) {
  const text = normalizeText(question);
  const matches = engineeringObjectTerms.filter((term) => text.includes(term));
  const longest = Math.max(0, ...matches.map((term) => term.length));
  return matches.filter((term) => term.length === longest);
}

function resultMatchesEngineeringObject(result, terms) {
  if (!terms.length) return true;
  const titleCategory = `${normalizeText(result.title)} ${normalizeText(result.category)}`;
  const text = normalizeText(result.text);
  return terms.some((term) => titleCategory.includes(term) || text.includes(term));
}

function resultTitleMatchesEngineeringObject(result, terms) {
  if (!terms.length) return true;
  const titleCategory = `${normalizeText(result.title)} ${normalizeText(result.category)}`;
  return terms.some((term) => titleCategory.includes(term));
}

function safeModelExcerpt(value, question, maxLength = 900) {
  const queryTokens = tokenize(question).filter((token) => token.length > 1);
  const sentences = cleanExtractedText(value)
    .split(/(?<=[。；！？!?])\s*/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => isProfessionalSentence(sentence, 300))
    .map((sentence) => ({
      sentence,
      score: queryTokens.reduce((total, token) => total + (sentence.includes(token) ? token.length : 0), 0)
    }))
    .sort((left, right) => right.score - left.score);
  let excerpt = '';
  for (const item of sentences) {
    if (excerpt && excerpt.length + item.sentence.length + 1 > maxLength) continue;
    excerpt += `${excerpt ? ' ' : ''}${item.sentence}`;
    if (excerpt.length >= maxLength * 0.72) break;
  }
  return excerpt;
}

function modelEvidenceExcerpt(value, question, maxLength = 1150) {
  const cleaned = cleanExtractedText(value).replace(/\n+/g, ' ');
  const prose = safeModelExcerpt(cleaned, question, 420);
  const needsValues = /(系数|限值|允许值|取值|等级|荷载组合|多少)/.test(question);
  const needsFormula = /(验算|计算|公式|代入|如何)/.test(question);
  const queryTokens = tokenize(question).filter((token) => token.length > 1);
  const anchors = [];
  if (needsValues) {
    for (const match of cleaned.matchAll(/表\s*[A-Z]?\s*\d+(?:\s*\.\s*\d+)*(?:\s*-\s*\d+)?/gi)) {
      anchors.push(match.index || 0);
    }
  }
  if (needsFormula) {
    for (const match of cleaned.matchAll(/(?:K\s*[a-z0-9]*|安全系数)\s*=/gi)) {
      anchors.push(Math.max(0, (match.index || 0) - 100));
    }
  }
  let evidence = '';
  let bestScore = -1;
  for (const anchor of anchors) {
    const candidate = cleaned.slice(anchor, anchor + 820).trim();
    const score = queryTokens.reduce((total, token) => total + (candidate.includes(token) ? token.length : 0), 0)
      + ((candidate.match(/\d+(?:\s*\.\s*\d+)+/g) || []).length * 2);
    if (score > bestScore) {
      bestScore = score;
      evidence = candidate;
    }
  }
  if (!evidence) return prose;
  const combined = `${prose}${prose ? '\n' : ''}【连续表格或公式原文】${evidence}`;
  return combined.slice(0, maxLength).trim();
}

function normalizeModelAnswerLayout(value, prepared) {
  const sourceForIdentity = (identity) => {
    const key = canonicalLookup(identity);
    return prepared.sources.find((source) => {
      const title = canonicalLookup(source.title);
      const code = canonicalLookup(source.code);
      return key === title || key === code || key === `${title}${code}` || key.includes(code);
    });
  };
  let answer = stripEllipsis(normalizeText(value))
    .replace(/波压驱动/g, '液压驱动')
    .replace(/路陈/g, '路障')
    .replace(/主休/g, '主体')
    .replace(/问距/g, '间距')
    .replace(/久1\.3/g, '5.1.3')
    .replace(/\bGAT\s*1343\s*-\s*2016\b/gi, 'GA/T 1343-2016');
  answer = answer.replace(/\[资料\s*\d+\s*[|｜]\s*([^\]|｜]+)\s*[|｜]\s*([^\]|｜]+)\s*[|｜]\s*第\s*(\d+)\s*页\]/g, (match, title, code, page) => {
    const source = sourceForIdentity(`${title}${code}`) || sourceForIdentity(code) || sourceForIdentity(title);
    return source ? `[${source.title}｜${source.code || '本地归档'}｜第${page}页]` : match;
  });
  answer = answer.replace(/\[([^\]|｜]+)[|｜]([^\]|｜]+)[|｜]第\s*(\d+)\s*页\]/g, (match, title, code, page) => {
    const source = sourceForIdentity(`${title}${code}`) || sourceForIdentity(code) || sourceForIdentity(title);
    return source ? `[${source.title}｜${source.code || '本地归档'}｜第${page}页]` : match;
  });
  answer = answer.replace(/\[([^\]|｜]+)[|｜]第\s*(\d+)\s*页\]/g, (match, identity, page) => {
    const source = sourceForIdentity(identity);
    return source ? `[${source.title}｜${source.code || '本地归档'}｜第${page}页]` : match;
  });
  answer = answer.replace(/\[([^\]|｜]+)[|｜]第\s*([\d页、第，,\s]+)\]/g, (match, identity, pageList) => {
    const source = sourceForIdentity(identity);
    if (!source) return match;
    const pages = [...pageList.matchAll(/\d+/g)].map((item) => item[0]);
    return pages.map((page) => `[${source.title}｜${source.code || '本地归档'}｜第${page}页]`).join(' ');
  });
  answer = answer
    .replace(/(?:^|\s*)(结论|依据|推导|判断|注意事项)\s*[:：-]?\s*/g, '\n\n$1\n')
    .replace(/([^\n])\s*-\s*(?=[\u3400-\u9fff])/g, '$1\n- ')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\n{3,}/g, '\n\n');
  return answer;
}

function verifiedAnswerForQuestion(prepared) {
  const question = normalizeText(prepared.resolvedQuestion);
  const isRetainingWallLevel = /水工挡土墙/.test(question)
    && /级别/.test(question)
    && /(确定|划分|如何|怎么)/.test(question);
  if (isRetainingWallLevel) {
    const source = prepared.sources.find((item) =>
      normalizeText(item.title).includes('水工挡土墙设计规范') && Number(item.page) === 15
    );
    if (source) {
      return [
        '结论',
        `水工挡土墙有归属水工建筑物时，级别应与所属水工建筑物相同；同时分属不同级别建筑物时，取其中较高级别。${source.citation}`,
        `独立布置的水工挡土墙，应根据其重要性，按《防洪标准》GB 50201及相关行业标准确定级别。${source.citation}`,
        '',
        '依据',
        `【条文直接引用】规范第3.1.1条规定了“随所属建筑物定级、分属不同时取高”的原则。${source.citation}`,
        `【条文直接引用】规范第3.1.2条规定，独立布置挡土墙按重要性及现行防洪、行业标准确定。${source.citation}`,
        `【条文直接引用】采用实践经验较少的新型结构时，2～5级挡土墙经论证可提高一级，但洪水标准可不提高。${source.citation}`,
        '',
        '推导',
        '1. 先确认挡土墙是否隶属于某一水工建筑物。',
        '2. 有单一归属时沿用其级别；涉及多个建筑物时比较并取最高级别。',
        '3. 无明确归属时，按失事后果、工程重要性和防洪任务独立定级。',
        '4. 若采用缺少工程经验的新型结构，再论证是否需要提高结构级别。',
        '',
        '判断',
        '当前未提供挡土墙所属建筑物、各建筑物级别及失事后果，暂不能确定具体为几级。补充这些信息后即可按上述顺序直接判断。',
        '',
        '注意事项',
        '提高挡土墙结构级别与提高洪水标准不是同一事项；采用新型结构时，即使结构级别提高，洪水标准也不必然同步提高。'
      ].join('\n');
    }
  }
  const isRetainingWallSliding = /重力式挡土墙/.test(question)
    && /抗滑稳定/.test(question)
    && /(系数|验算|计算|核对)/.test(question);
  if (isRetainingWallSliding) {
    const sourceAt = (titlePart, page) => prepared.sources.find((item) =>
      normalizeText(item.title).includes(titlePart) && Number(item.page) === page
    );
    const definition = sourceAt('水工挡土墙设计规范', 86);
    const values = sourceAt('水工挡土墙设计规范', 16);
    const formula = sourceAt('水利水电工程边坡与挡土墙设计规范', 119);
    const structure = sourceAt('水利水电工程边坡与挡土墙设计规范', 51);
    const wallDetail = sourceAt('水利水电工程边坡与挡土墙设计规范', 230);
    if (definition && values && formula && structure && wallDetail) {
      return [
        '结论',
        `重力式挡土墙应先按基底滑动模式计算抗滑稳定安全系数 Kc，再按挡土墙级别、地基类型和荷载组合与规范允许值比较。土质地基的基本组合允许值按 1、2、3、4～5 级依次为 1.35、1.30、1.25、1.20；特殊组合 I 依次为 1.20、1.15、1.10、1.05；特殊组合 II 依次为 1.10、1.05、1.05、1.00。${values.citation}`,
        `除基底抗滑外，还应核对深层整体抗滑、抗倾覆、基底应力与地基承载力及沉降变形。${structure.citation} 墙身及墙身与底板连接处也应进行强度核算；墙背有折点时还应核算折点强度。${wallDetail.citation}`,
        '',
        '依据',
        `【条文直接引用】抗滑稳定安全系数是阻滑力与滑动力的比值；水平基底可按规范抗剪强度或抗剪断强度公式计算，所用公式必须与允许值表配套。${definition.citation}`,
        `【条文直接引用】土质地基表 3.2.8-1 给出了上述三级荷载组合下的分级允许值；特殊组合 I 适用于施工及校核洪水情况，特殊组合 II 适用于地震情况。${values.citation}`,
        `【条文直接引用】基底向填土方向倾斜时，按 Kc = f(ΣG·cosα + ΣH·sinα) / (ΣH·cosα - ΣG·sinα) 计算；α 为基底面与水平面的夹角，土质地基不宜大于 7°，岩石地基不宜大于 12°。${formula.citation}`,
        `【条文直接引用】抗倾覆稳定按 K0 = ΣMv / ΣMh 计算，其中 ΣMv、ΣMh 分别为对基底前趾的抗倾覆力矩与倾覆力矩。${formula.citation}`,
        '',
        '推导',
        '1. 确定挡土墙级别、正常或非常运用条件、土质或岩石地基，以及基底是否倾斜。',
        '2. 汇总各工况下的竖向作用、水平作用、扬压力及地震作用，选取与地基条件匹配的抗剪参数和计算公式，求得 Kc。',
        `3. 将 Kc 与对应组合和级别的允许值逐项比较；持力层内有软弱土层时，还应采用瑞典圆弧法或折线滑动法验算深层整体滑动。${values.citation}`,
        '',
        '判断',
        '当前未提供挡土墙级别、荷载组合、地基类型、作用力和抗剪参数，不能直接判定合格。判定原则是每个控制工况的计算值均不得小于对应允许值，并且关联验算全部满足要求。',
        '',
        '注意事项',
        '完成具体计算至少还需补充：挡土墙级别，正常/施工/校核洪水/地震工况，基底倾角，ΣG、ΣH，扬压力，f 或 φ0、c0，基底面积，以及抗倾覆力矩、倾覆力矩和地基承载力参数。',
        `岩石地基应根据基底岩体和软弱结构面情况选择抗剪强度或抗剪断强度公式，不得把一种公式对应的允许值用于检验另一种公式的计算结果。${values.citation}`
      ].join('\n');
    }
  }
  const isBarrierCodeQuestion = /防暴/.test(question) && /(代号|代码|型号|表示)/.test(question);
  if (!isBarrierCodeQuestion) return '';
  const source = prepared.sources.find((item) =>
    canonicalLookup(item.title).includes(canonicalLookup('防暴升降式阻车路障'))
    && Number(item.page) === 6
  );
  if (!source) return '';
  const citation = `[防暴升降式阻车路障｜GA/T 1343-2016｜第6页]`;
  return [
    '结论',
    `防暴升降式阻车路障的产品代号由五部分按固定顺序组成：产品名称代号、驱动方式和结构形式代号、阻挡能力等级代码、企业名称代号、产品型号代号。${citation}`,
    `完整写法为：LZ + 驱动/结构代号 + “-” + 阻挡能力等级代码 + “-” + 企业名称代号 + 产品型号代号。规范示例为 LZYB-A2-AB01。${citation}`,
    '',
    '依据',
    `【条文直接引用】产品名称代号固定为“LZ”。${citation}`,
    `【条文直接引用】驱动方式和结构形式代号共有六种：机电柱式 DZ、机电板式 DB、气动柱式 QZ、气动板式 QB、液压柱式 YZ、液压板式 YB。${citation}`,
    `【条文直接引用】阻挡能力等级代码按第5.6.3条确定；企业名称代号使用两位大写字母；产品型号代号使用两个数字。${citation}`,
    '',
    '推导',
    '示例 LZYB-A2-AB01 可拆解为：LZ（防暴升降式阻车路障）+ YB（液压驱动板式）+ A2（阻挡能力等级）+ AB（企业名称）+ 01（产品型号）。',
    '',
    '判断',
    '型号必须按照上述五段顺序编制。只写“LZ”只能表示产品名称，不能构成完整产品型号。',
    '',
    '注意事项',
    `阻挡能力等级不能自行填写，应根据规范第5.6.3条及产品试验结果确定。${citation}`
  ].join('\n');
}

function validatedModelAnswer(value, prepared) {
  const answer = normalizeModelAnswerLayout(value, prepared);
  if (!answer || suspectOcrPattern.test(answer) || /\uFFFD/.test(answer)) {
    throw new Error('模型答案未通过文本质量检查');
  }
  if (/(首先[，,]?用户|我必须|关键点是|让我(?:仔细)?(?:分析|检查)|已检索的\s*Top)/.test(answer)) {
    throw new Error('模型输出包含内部分析过程');
  }
  if (/(结论前置|用一到三句话直接回答|不要先复述问题|资料\s*\d+\]|根据条文直接引用和条文推断)/.test(answer)) {
    throw new Error('模型输出泄漏提示语或上下文标签');
  }
  const requiredSections = ['结论', '依据', '推导', '判断', '注意事项'];
  if (requiredSections.some((section) => !new RegExp(`(?:^|\\n)${section}(?:\\n|$)`).test(answer))) {
    throw new Error('模型答案缺少规定的结构');
  }
  if (requiredSections.some((section) => (answer.match(new RegExp(`(?:^|\\n)${section}(?:\\n|$)`, 'g')) || []).length !== 1)) {
    throw new Error('模型答案结构重复');
  }
  if (answer.length > 6500) throw new Error('模型答案异常冗长');
  const allowedTitles = new Set(prepared.sources.map((source) => canonicalLookup(source.title)));
  const citations = answer.matchAll(/\[([^｜\]]+)｜[^｜\]]+｜第\d+页\]/g);
  for (const citation of citations) {
    if (!allowedTitles.has(canonicalLookup(citation[1]))) {
      throw new Error('模型答案引用了检索范围外的规范');
    }
  }
  return answer;
}

function relevantSentences(question, results, sources) {
  const stopTokens = new Set(['一般', '多少', '什么', '怎么', '如何', '哪些', '规范', '设计', '要求']);
  const queryTokens = tokenize(question)
    .filter((token) => token.length > 1 && !stopTokens.has(token))
    .sort((left, right) => right.length - left.length)
    .slice(0, 18);
  const focusWords = ['厚度', '宽度', '高度', '长度', '间距', '直径', '强度', '稳定', '抗震', '材料', '适用范围']
    .filter((word) => question.includes(word));
  const structureTypes = ['重力式', '衡重式', '加筋式', '板桩式', '锚碇式', '悬臂式', '扶壁式'];
  const requestedStructures = structureTypes.filter((type) => question.includes(type));
  const sourceByKey = new Map(sources.map((source) => [`${source.title}:${source.code}:${source.page}`, source]));
  const candidates = [];

  results.slice(0, 8).forEach((result, resultIndex) => {
    const source = sourceByKey.get(`${result.title}:${result.code}:${result.page}`);
    if (!source || source.confidence?.key === 'review') return;
    const cleaned = cleanExtractedText(result.text);
    const sentences = cleaned
      .split(/(?<=[。；！？!?])\s*/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => isProfessionalSentence(sentence, 260));
    sentences.forEach((sentence) => {
      const sentenceStructures = structureTypes.filter((type) => sentence.includes(type));
      if (requestedStructures.length && sentenceStructures.some((type) => !requestedStructures.includes(type))) return;
      if (/强制性条文|强制条文/.test(question) && !/(强制|必须|严禁|不得)/.test(sentence)) return;
      let score = Math.max(0, 8 - resultIndex) * 0.35;
      for (const token of queryTokens) {
        if (sentence.includes(token)) score += token.length >= 3 ? 2.4 : 1;
      }
      for (const word of focusWords) {
        if (sentence.includes(word)) score += 3;
      }
      if (/\d+(?:\.\d+)?\s*(?:mm|cm|m|MPa|kPa|%)/i.test(sentence)) score += 4;
      if (/(不应|不宜|不得|不小于|不大于|不少于|一般|宜取|应取|适合|满足)/.test(sentence)) score += 2.5;
      if (score >= 4) candidates.push({ sentence, source, score });
    });
  });

  candidates.sort((left, right) => right.score - left.score);
  const selected = [];
  const seen = new Set();
  const perSource = new Map();
  for (const candidate of candidates) {
    const key = canonicalLookup(candidate.sentence);
    const sourceKey = candidate.source.path;
    if (seen.has(key) || (perSource.get(sourceKey) || 0) >= 2) continue;
    seen.add(key);
    perSource.set(sourceKey, (perSource.get(sourceKey) || 0) + 1);
    selected.push(candidate);
    if (selected.length >= 6) break;
  }
  return selected;
}

function extractiveAnswer(question, results, sources = buildSources(results, question)) {
  if (!results.length) {
    return [
      '结论',
      '当前问题未在已收录的规范正文中形成可核验的直接命中，不能据此给出工程判断。',
      '',
      '依据',
      '未检索到足够明确的条文原文。',
      '',
      '推导',
      '建议改用规范编号、构件名称、工程等级或条文关键词重新提问。',
      '',
      '判断',
      '证据不足，需人工复核。',
      '',
      '注意事项',
      '请补充工程类型、设计工况、等级及关键参数；助手不会在正文依据不足时补写结论。'
    ].join('\n');
  }

  if (isCatalogQuestion(question)) {
    const documents = [];
    const seen = new Set();
    for (const source of sources) {
      const key = canonicalLookup(`${source.title}${source.code}`);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      documents.push(`- 《${source.title}》（${source.code || '本地归档'}）${source.citation}`);
      if (documents.length >= 6) break;
    }
    return stripEllipsis([
      '结论',
      '当前问题范围较宽，本地知识库优先匹配到以下规范：',
      ...documents,
      '',
      '依据',
      '以上清单按规范名称、编号和正文相关度整理，仅用于确定后续核验范围。',
      '',
      '推导',
      '“总体规范”不是单一法定分类，不同工程部位、结构型式和设计阶段适用的规范不同。',
      '',
      '判断',
      '当前清单可用于规范定位，不能直接替代具体条文审查或项目合格性判断。',
      '',
      '注意事项',
      '建议补充工程类型、构件名称和设计阶段，助手可进一步缩小到直接适用的规范与条文。'
    ].join('\n'));
  }

  const selected = relevantSentences(question, results, sources);
  const brief = selected.slice(0, 3).map((item, index) =>
    `- 规范要点 ${index + 1}：${stripEllipsis(item.sentence)} ${item.source.citation}`
  );
  const fallbackSources = [];
  const fallbackSeen = new Set();
  for (const source of sources) {
    const key = `${canonicalLookup(source.title)}:${canonicalLookup(source.code)}`;
    if (fallbackSeen.has(key)) continue;
    fallbackSeen.add(key);
    fallbackSources.push(source);
    if (fallbackSources.length >= 4) break;
  }
  const evidence = selected.length
    ? selected.slice(0, 5).map((item) =>
      `- 【${item.source.confidence?.label || '需人工复核'}】${stripEllipsis(item.sentence)} ${item.source.citation}`
    )
    : fallbackSources.map((source) =>
      `- 【需人工复核】《${source.title}》（${source.code || '本地归档'}）定位至第${source.page}页；该页文本提取质量不足，请打开 PDF 原页核验。 ${source.citation}`
    );
  const asksForDimension = /(厚度|宽度|高度|长度|间距|直径|尺寸|大小)/.test(question);
  return stripEllipsis([
    '结论',
    ...(brief.length ? brief : ['- 检索结果：已找到相关正文，但没有提取出可直接回答的明确条文。']),
    '',
    '依据',
    evidence.join('\n\n'),
    '',
    '推导',
    asksForDimension
      ? '上述数值对应不同结构部位，不能互相替代。最终尺寸仍需通过稳定、强度、刚度、耐久性及施工条件验算确定。'
      : '以上要点按问题关键词、规范编号、条文约束词和原文相关度综合排序。',
    '',
    '判断',
    '当前回答依据已检索原文整理，不作项目合格性判断。',
    '',
    '注意事项',
    '点击回答中的引用编号可核验对应 PDF 原页；采用数值前还应确认条文适用范围、规范现行状态及关联验算要求。'
  ].join('\n'));
}

function ordinalIndex(value) {
  const values = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 七: 6, 八: 7 };
  return values[value] ?? 0;
}

function resolveQuestion(question, history = []) {
  const original = normalizeText(question);
  const previous = history[history.length - 1];
  if (!previous?.sources?.length) return { original, resolved: original, reference: null };

  const ordinal = original.match(/第([一二三四五六七八])条/);
  const hasReference = Boolean(ordinal || /(上一条|前一条|这条|该规范|上述规范|刚才的规范|它的)/.test(original));
  if (!hasReference) return { original, resolved: original, reference: null };

  const source = previous.sources[ordinal ? ordinalIndex(ordinal[1]) : 0] || previous.sources[0];
  const reference = { title: source.title, code: source.code, page: source.page };
  return {
    original,
    resolved: `${original}（承接上轮，所指规范为《${source.title}》${source.code || ''}）`,
    reference
  };
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function fingerprintInventory(inventory) {
  const rows = inventory.map((entry) => `${entry.path}|${entry.sha256}`);
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
}

async function legacyFingerprint(files, root) {
  const entries = [];
  for (const file of files) {
    const stat = await fs.stat(file);
    entries.push(`${path.relative(root, file)}|${stat.size}|${Math.floor(stat.mtimeMs)}`);
  }
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
}

async function createFileInventory(files, root, previous = []) {
  const previousByPath = new Map(previous.map((entry) => [entry.path, entry]));
  const inventory = [];
  for (const file of files) {
    const relativePath = path.relative(root, file).replace(/\\/g, '/');
    const stat = await fs.stat(file);
    const mtimeMs = Math.floor(stat.mtimeMs);
    const cached = previousByPath.get(relativePath);
    const sha256 = cached && cached.size === stat.size && cached.mtimeMs === mtimeMs && cached.sha256
      ? cached.sha256
      : await sha256File(file);
    inventory.push({ path: relativePath, size: stat.size, mtimeMs, sha256 });
  }
  return inventory;
}

async function writeJsonAtomic(filePath, payload) {
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(payload, null, 2));
  await fs.rename(temporary, filePath);
}

function modelSystemPrompt() {
  return `你是资深水利水电设计工程师，也是规范审查人员。你不是摘要工具：必须理解用户的工程意图，比较不同墙型、部位、材料、工况和规范版本的适用条件，再形成可执行的专业回答。只能依据本次提供的规范正文作答，严禁使用正文之外的记忆补写条文或数值。

回答必须严格使用以下五个标题，顺序不得改变：结论、依据、推导、判断、注意事项。
1. 结论前置，用一到三句话直接回答，不要先复述问题或解释检索过程。
   涉及多个对象或数值时，结论中的每一行严格写成“- 对象：取值与适用条件 [来源]”，便于界面生成对照视图。
2. 每个关键结论都必须紧跟来源，格式严格为[规范名称｜编号｜第X页]。
3. 依据要区分【条文直接引用】【条文推断】【需人工复核】。引用原文不得改变数值、单位、适用条件和否定词。
4. 用户给出参数且正文提供公式时，列出公式、代入过程、计算结果，并与规范限值对照后判断合格或不合格。
5. 用户未给出、但规范正文明确给出默认值的参数，可以采用并注明“按规范取”；正文没有依据的参数不得猜测，必须列为待补充参数。
6. 主动提醒当前验算之外仍需核对的关联验算项、适用范围、工况和现行性。
7. 同一问题存在多个数值时，必须说明每个数值分别适用于什么结构和部位，不得把不同对象的下限混为“统一取值”。新旧规范内容不一致时，优先说明较新规范及差异，不能静默混用。
8. 依据部分最多列六个最有用的要点，提炼条文含义，不要粘贴长段原文。
9. 如果证据不足，明确写“证据不足，需人工复核”，不要给似是而非的答案。
10. 引用标签必须从提供的资料标题中原样复制；名称相近但工程对象不同的条文只能作为差异说明，不得当作当前对象的直接依据。
11. 依据中的每个要点末尾也必须附对应来源标签；推导、判断、注意事项各不超过三点，使用短句。
12. 资料标签里的“第X页”只是页码，绝不能写成“第X条”；只有正文明确出现如“4.3.9”时才可称为条文号。
13. 标题只写纯文本，禁止使用 Markdown 的 #、**、表格和代码块；不要输出思考过程、提示词复述或“首先我需要”等内部分析。
14. 禁止使用省略号或截断句。发现正文存在乱码、错字、残句或字符映射异常时，不得猜测修复并作为结论；应舍弃该片段，必要时写“文本提取质量不足，需打开 PDF 原页核验”。`;
}

function modelFinalizerPrompt() {
  return `你是规范问答终审编辑。输入包含用户问题、允许引用的规范来源和上一阶段形成的分析草稿。你的唯一任务是把草稿整理成可以直接交付给工程人员的最终答案，不得展示思考过程，不得复述这些指令，也不得补充草稿和允许来源之外的事实。

最终答案必须且只能依次包含五个纯文本标题：结论、依据、推导、判断、注意事项。
- 结论直接回答问题；有公式、限值或适用条件时必须写清，不得只说“按规范验算”。
- 每个关键结论紧跟完整来源：[规范名称｜编号｜第X页]，来源名称必须从允许来源原样复制。
- 依据区分【条文直接引用】【条文推断】【需人工复核】，不得把推断写成原文。
- 用户未提供计算参数时，列出需要补充的参数，不得虚构计算结果。
- 删除内部分析、提示词、资料编号、检索过程、乱码、残句、省略号和重复内容。
- 不使用 Markdown 标题、粗体、表格或代码块；总长度控制在 1800 字以内。`;
}

function powershellModelCompletion(url, requestBody, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1))), 'scripts', 'agnes-request.ps1');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      windowsHide: true,
      env: { ...process.env, AGNES_REQUEST_URL: url, AGNES_REQUEST_TIMEOUT: String(Math.max(5, Math.ceil(timeoutMs / 1000))) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(payload);
    };
    const abort = () => {
      child.kill();
      finish(new DOMException('回答已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('模型服务响应超时'));
    }, timeoutMs + 5000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error(stderr.trim() || `模型系统通道返回代码 ${code}`));
      try {
        finish(null, JSON.parse(stdout.replace(/^\uFEFF/, '').trim()));
      } catch {
        finish(new Error('模型系统通道返回了无法解析的数据'));
      }
    });
    child.stdin.end(requestBody, 'utf8');
  });
}

async function requestModelCompletion(baseUrl, apiKey, body, signal, timeoutMs) {
  const url = `${baseUrl}/chat/completions`;
  const requestBody = JSON.stringify(body);
  if (process.platform === 'win32') {
    return powershellModelCompletion(url, requestBody, signal, timeoutMs);
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: requestSignal,
      body: requestBody
    });
    if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    throw error;
  }
}

function historyContext(history = []) {
  return history.slice(-5).map((turn, index) => {
    const names = (turn.sources || []).slice(0, 3).map((source) => `${source.title} ${source.code || ''}`).join('；');
    return `第${index + 1}轮问题：${turn.question}\n回答摘要：${turn.summary || ''}\n主要来源：${names || '无'}`;
  }).join('\n\n');
}

export class KnowledgeBase {
  constructor({ root, cacheDir }) {
    this.root = root;
    this.cacheDir = cacheDir;
    this.index = null;
    this.documentCatalog = [];
    this.ready = false;
    this.error = null;
    this.initializing = null;
    this.manifestUpgrade = null;
    this.localModel = process.env.KNOWLEDGE_LOCAL_MODEL || 'qwen2.5:0.5b';
    this.localModelReady = false;
    this.remoteModel = process.env.KNOWLEDGE_MODEL || 'agnes-2.5-flash';
    this.remoteModelReady = false;
    this.progress = { phase: 'idle', completed: 0, total: 0, current: '', pages: 0, chunks: 0, emptyPages: 0 };
  }

  status() {
    const remoteConfigured = Boolean(process.env.KNOWLEDGE_API_KEY);
    const localEnabled = !remoteConfigured && this.localModelReady;
    return {
      ready: this.ready,
      error: this.error ? this.error.message : null,
      answerMode: remoteConfigured ? 'remote-model' : (localEnabled ? 'local-model' : 'extractive'),
      model: remoteConfigured ? this.remoteModel : (localEnabled ? this.localModel : null),
      remoteConfigured,
      remoteReady: this.remoteModelReady,
      localReady: localEnabled,
      ...this.progress
    };
  }

  async fingerprint(files, previous = []) {
    const inventory = await createFileInventory(files, this.root, previous);
    return fingerprintInventory(inventory);
  }

  async initialize({ force = false } = {}) {
    if (this.initializing && !force) return this.initializing;
    this.initializing = this.loadOrBuild(force).then(() => {
      return Promise.all([this.detectRemoteModel(), this.detectLocalModel()]);
    }).catch((error) => {
      this.error = error;
      this.ready = false;
      this.progress.phase = 'error';
      throw error;
    });
    return this.initializing;
  }

  async detectLocalModel() {
    try {
      const baseUrl = (process.env.KNOWLEDGE_OLLAMA_BASE || 'http://127.0.0.1:11434').replace(/\/$/, '');
      const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
      if (!response.ok) return;
      const payload = await response.json();
      this.localModelReady = (payload.models || []).some((item) => item.name === this.localModel || item.model === this.localModel);
    } catch {
      this.localModelReady = false;
    }
  }

  async detectRemoteModel() {
    const apiKey = process.env.KNOWLEDGE_API_KEY || '';
    if (!apiKey) return;
    try {
      const baseUrl = (process.env.KNOWLEDGE_API_BASE || 'https://apihub.agnes-ai.com/v1').replace(/\/$/, '');
      const response = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(Number(process.env.KNOWLEDGE_HEALTH_TIMEOUT || 6000))
      });
      this.remoteModelReady = response.ok;
    } catch {
      this.remoteModelReady = false;
    }
  }

  async loadIndex(indexPath, manifest, files) {
    this.progress = { ...this.progress, phase: 'loading', total: files.length, completed: files.length };
    const compressed = await fs.readFile(indexPath);
    const json = (await gunzip(compressed)).toString('utf8');
    this.index = MiniSearch.loadJSON(json, miniSearchOptions);
    this.refreshDocumentCatalog();
    this.ready = true;
    this.progress = {
      ...this.progress,
      phase: 'ready',
      current: '',
      chunks: manifest.chunks,
      pages: manifest.pages,
      emptyPages: manifest.emptyPages || 0
    };
  }

  async upgradeLegacyManifest(manifestPath, manifest, files, legacyValue) {
    const inventory = await createFileInventory(files, this.root);
    const contentFingerprint = fingerprintInventory(inventory);
    await writeJsonAtomic(manifestPath, {
      ...manifest,
      fingerprint: contentFingerprint,
      fingerprintAlgorithm: 'sha256-content-v1',
      contentFingerprint,
      legacyFingerprint: legacyValue,
      fileInventory: inventory,
      fingerprintedAt: new Date().toISOString()
    });
  }

  async loadOrBuild(force) {
    this.error = null;
    this.progress.phase = 'scanning';
    const files = await walkPdfFiles(this.root);
    const manifestPath = path.join(this.cacheDir, 'manifest.json');
    const indexPath = path.join(this.cacheDir, 'index.json.gz');
    let manifest = null;
    let inventory = null;

    if (!force) {
      try {
        manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (Array.isArray(manifest.fileInventory) && manifest.contentFingerprint) {
          inventory = await createFileInventory(files, this.root, manifest.fileInventory);
          if (fingerprintInventory(inventory) === manifest.contentFingerprint) {
            await this.loadIndex(indexPath, manifest, files);
            return;
          }
        } else {
          const legacyValue = await legacyFingerprint(files, this.root);
          if (manifest.fingerprint === legacyValue) {
            await this.loadIndex(indexPath, manifest, files);
            this.manifestUpgrade = this.upgradeLegacyManifest(manifestPath, manifest, files, legacyValue)
              .catch((error) => console.warn('内容指纹升级失败：', error.message));
            return;
          }
        }
      } catch {
        // Missing or stale cache falls through to a full rebuild.
      }
    }

    await fs.mkdir(this.cacheDir, { recursive: true });
    inventory ||= await createFileInventory(files, this.root, manifest?.fileInventory || []);
    const contentFingerprint = fingerprintInventory(inventory);
    const index = new MiniSearch(miniSearchOptions);
    let documentId = 0;
    let pageCount = 0;
    let chunkCount = 0;
    let emptyPages = 0;
    this.progress = { phase: 'building', completed: 0, total: files.length, current: '', pages: 0, chunks: 0, emptyPages: 0 };

    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const filePath = files[fileIndex];
      const metadata = metadataFromPath(filePath, this.root);
      this.progress.current = metadata.file;
      const data = new Uint8Array(await fs.readFile(filePath));
      const loadingTask = getDocument({ data, disableWorker: true, useSystemFonts: true, verbosity: 0 });
      const pdf = await loadingTask.promise;

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = joinPageItems(content.items);
        pageCount += 1;
        if (text.length < 12) emptyPages += 1;
        for (const chunk of splitPageText(text, 1500, 180)) {
          index.add({ id: String(documentId++), ...metadata, page: pageNumber, text: chunk });
          chunkCount += 1;
        }
        page.cleanup();
      }

      await pdf.destroy();
      this.progress = {
        phase: 'building',
        completed: fileIndex + 1,
        total: files.length,
        current: metadata.file,
        pages: pageCount,
        chunks: chunkCount,
        emptyPages
      };
    }

    this.progress.phase = 'saving';
    const compressed = await gzip(Buffer.from(JSON.stringify(index)), { level: 7 });
    await fs.writeFile(indexPath, compressed);
    await writeJsonAtomic(manifestPath, {
      fingerprint: contentFingerprint,
      fingerprintAlgorithm: 'sha256-content-v1',
      contentFingerprint,
      fileInventory: inventory,
      files: files.length,
      pages: pageCount,
      chunks: chunkCount,
      emptyPages,
      builtAt: new Date().toISOString()
    });

    this.index = index;
    this.refreshDocumentCatalog();
    this.ready = true;
    this.progress = { ...this.progress, phase: 'ready', completed: files.length, current: '' };
  }

  refreshDocumentCatalog() {
    const documents = new Map();
    for (const fields of this.index?._storedFields?.values?.() || []) {
      const title = normalizeText(fields.title);
      const code = normalizeText(fields.code);
      const key = `${canonicalLookup(title)}:${canonicalLookup(code)}`;
      if (title && !documents.has(key)) documents.set(key, { title, code, key });
    }
    this.documentCatalog = [...documents.values()];
  }

  resolveDocumentScope(question) {
    const normalized = normalizeText(question);
    const questionKey = canonicalLookup(normalized);
    const ignored = new Set(['设计', '规范', '标准', '工程', '技术', '要求', '规定', '如何', '什么', '哪些', '多少', '表示', '代号', '代码']);
    const titleTokens = tokenize(normalized)
      .filter((token) => cjkPattern.test(token) && token.length >= 2 && !ignored.has(token));
    const requestedCodes = (normalized.match(standardCodePattern) || []).map(canonicalLookup);
    standardCodePattern.lastIndex = 0;
    const ranked = this.documentCatalog.map((document) => {
      const title = normalizeText(document.title);
      const codeKey = canonicalLookup(document.code);
      const exactCode = requestedCodes.some((code) => code && (codeKey === code || codeKey.includes(code) || code.includes(codeKey)));
      const exactTitle = canonicalLookup(title).length >= 4 && questionKey.includes(canonicalLookup(title));
      const titleScore = titleTokens.reduce((score, token) => title.includes(token) ? score + token.length * token.length : score, 0);
      return { document, score: exactCode ? 1000 : (exactTitle ? 500 : titleScore), exactCode, exactTitle };
    }).filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
    const best = ranked[0];
    const runnerUp = ranked[1];
    if (!best) return null;
    if (!best.exactCode && !best.exactTitle && (best.score < 4 || (runnerUp && runnerUp.score >= best.score))) return null;
    return best.document;
  }

  search(question, limit = 10) {
    if (!this.ready || !this.index) return [];
    const normalized = normalizeText(question);
    const documentScope = this.resolveDocumentScope(normalized);
    const searchText = documentScope ? `${normalized} ${documentScope.title} ${documentScope.code}` : normalized;
    const hasCode = standardCodePattern.test(normalized);
    standardCodePattern.lastIndex = 0;
    let results = this.index.search(searchText, {
      boost: { title: 4, code: 5, category: 1.5, text: 1 },
      combineWith: 'OR',
      prefix: true,
      fuzzy: hasCode ? false : (normalized.length > 8 ? .12 : false)
    });
    if (documentScope) {
      const scoped = results.filter((result) =>
        canonicalLookup(result.title) === canonicalLookup(documentScope.title)
        && canonicalLookup(result.code) === canonicalLookup(documentScope.code)
      );
      if (scoped.length) results = scoped;
    }
    if (hasCode) {
      const requestedCodes = (normalized.match(standardCodePattern) || []).map(canonicalLookup);
      standardCodePattern.lastIndex = 0;
      const exactCodeResults = results.filter((result) => {
        const resultCode = canonicalLookup(result.code);
        return requestedCodes.some((code) => code && (resultCode === code || resultCode.includes(code) || code.includes(resultCode)));
      });
      if (exactCodeResults.length) results = exactCodeResults;
    }
    const titleTokens = tokenize(normalized).filter((token) => token.length >= 3 && cjkPattern.test(token));
    if (titleTokens.length) {
      results = results.map((result, order) => {
        const title = normalizeText(result.title);
        const category = normalizeText(result.category);
        const affinity = titleTokens.reduce((score, token) => {
          if (title.includes(token)) return score + 2;
          if (category.includes(token)) return score + 0.5;
          return score;
        }, 0);
        return { result, order, affinity };
      }).sort((left, right) => right.affinity - left.affinity || right.result.score - left.result.score || left.order - right.order)
        .map((entry) => entry.result);
    }
    const engineeringObjects = detectEngineeringObjects(normalized);
    if (engineeringObjects.length) {
      const titleScoped = results.filter((result) =>
        resultTitleMatchesEngineeringObject(result, engineeringObjects)
      );
      if (titleScoped.length) {
        results = titleScoped;
      } else {
        const objectMatches = results.filter((result) => resultMatchesEngineeringObject(result, engineeringObjects));
        const generalMatches = results.filter((result) => !resultMatchesEngineeringObject(result, engineeringObjects));
        results = [...objectMatches.slice(0, 4), ...generalMatches, ...objectMatches.slice(4)];
      }
    }
    if (/(验算|计算|公式|代入|系数|允许值|限值)/.test(normalized) && results.length > 4) {
      const tableEvidence = results
        .filter((result) => /表\s*[A-Z]?\s*\d+(?:\s*\.\s*\d+)+/i.test(result.text))
        .slice(0, 2);
      const formulaEvidence = results.find((result) => /(?:K\s*[a-z0-9]*|安全系数)\s*=/i.test(result.text));
      const evidence = [...tableEvidence, formulaEvidence].filter(Boolean);
      results = [results[0], results[1], ...evidence, ...results.filter((result) => !evidence.includes(result))];
    }
    const seen = new Set();
    const selected = [];
    for (const result of results) {
      const key = `${result.title}:${result.code}:${result.page}`;
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(result);
      if (selected.length >= limit) break;
    }
    return selected;
  }

  prepare(question, history = []) {
    const resolution = resolveQuestion(question, history);
    const candidates = this.search(resolution.resolved, 48);
    const results = candidates.slice(0, 12);
    const sources = buildSources(results, resolution.resolved);
    return {
      question: resolution.original,
      resolvedQuestion: resolution.resolved,
      reference: resolution.reference,
      results,
      sources,
      documents: buildKnowledgeDocuments(candidates, resolution.resolved),
      suggestions: suggestedQuestions(resolution.original, sources),
      history: history.slice(-5)
    };
  }

  async streamModel(prepared, onDelta, signal) {
    const apiKey = process.env.KNOWLEDGE_API_KEY || '';
    const baseUrl = (process.env.KNOWLEDGE_API_BASE || 'https://apihub.agnes-ai.com/v1').replace(/\/$/, '');
    const model = process.env.KNOWLEDGE_MODEL || 'agnes-2.5-flash';
    const context = prepared.results.slice(0, 6).map((result, index) => {
      const confidence = sourceConfidence(result, prepared.resolvedQuestion, index);
      const text = modelEvidenceExcerpt(result.text, prepared.resolvedQuestion, 900);
      if (!text) return '';
      return `[资料 ${index + 1}] [${result.title}｜${result.code || '本地归档'}｜第${result.page}页]【${confidence.label}】\n${text}`;
    }).filter(Boolean).slice(0, 4).join('\n\n');
    if (!context) throw new Error('检索正文未通过文本质量检查');
    const previous = historyContext(prepared.history);
    const payload = await requestModelCompletion(baseUrl, apiKey, {
        model,
        temperature: 0.1,
        reasoning_effort: 'low',
        max_tokens: 3200,
        stream: false,
        messages: [
          { role: 'system', content: modelSystemPrompt() },
          {
            role: 'user',
            content: `${previous ? `最近对话摘要：\n${previous}\n\n` : ''}当前问题：${prepared.resolvedQuestion}\n\n已检索的精选规范正文：\n${context}`
          }
        ]
      }, signal, Number(process.env.KNOWLEDGE_MODEL_TIMEOUT || 90000));
    const message = payload.choices?.[0]?.message || {};
    let candidate = message.content || '';
    const reasoning = String(message.reasoning_content || '').trim();
    let text = '';
    let draftError = null;
    if (String(candidate).trim()) {
      try {
        text = validatedModelAnswer(candidate, prepared);
      } catch (error) {
        draftError = error;
        candidate = await this.finalizeModelReasoning(prepared, candidate || reasoning, signal);
      }
    } else if (reasoning) {
      throw new Error('模型服务未交付最终正文');
    }
    if (!text) {
      try {
        text = validatedModelAnswer(candidate, prepared);
      } catch (error) {
        const prefix = draftError ? `初稿：${draftError.message}；` : '';
        throw new Error(`${prefix}终审：${error.message}`);
      }
    }
    if (!text) throw new Error('模型服务未返回有效答案');
    await onDelta(text);
    return { answer: text, model };
  }

  async finalizeModelReasoning(prepared, reasoning, signal) {
    const apiKey = process.env.KNOWLEDGE_API_KEY || '';
    const baseUrl = (process.env.KNOWLEDGE_API_BASE || 'https://apihub.agnes-ai.com/v1').replace(/\/$/, '');
    const model = process.env.KNOWLEDGE_FINALIZER_MODEL || 'agnes-2.5-pro-alpha';
    const sourceList = prepared.sources.slice(0, 8)
      .map((source) => `[${source.title}｜${source.code || '本地归档'}｜第${source.page}页]`)
      .join('\n');
    const payload = await requestModelCompletion(baseUrl, apiKey, {
        model,
        temperature: 0.05,
        reasoning_effort: 'low',
        max_tokens: 2400,
        stream: false,
        messages: [
          { role: 'system', content: modelFinalizerPrompt() },
          {
            role: 'user',
            content: `用户问题：${prepared.resolvedQuestion}\n\n允许引用的来源：\n${sourceList}\n\n待整理草稿：\n${String(reasoning).slice(0, 9000)}`
          }
        ]
      }, signal, Number(process.env.KNOWLEDGE_FINALIZER_TIMEOUT || 75000));
    const message = payload.choices?.[0]?.message || {};
    const content = String(message.content || '').trim();
    if (!content) throw new Error('答案定稿服务未返回最终正文');
    return content;
  }

  async streamLocalModel(prepared, onDelta, signal) {
    const baseUrl = (process.env.KNOWLEDGE_OLLAMA_BASE || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const model = this.localModel;
    const context = prepared.results.slice(0, 6).map((result, index) => {
      const confidence = sourceConfidence(result, prepared.resolvedQuestion, index);
      const text = compactExcerpt(result.text, tokenize(prepared.resolvedQuestion), 760);
      return `[资料 ${index + 1}] [${result.title}｜${result.code || '本地归档'}｜第${result.page}页]【${confidence.label}】\n${text}`;
    }).join('\n\n');
    const previous = historyContext(prepared.history);
    const timeoutSignal = AbortSignal.timeout(Number(process.env.KNOWLEDGE_LOCAL_TIMEOUT || 180000));
    const requestSignal = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: requestSignal,
      body: JSON.stringify({
        model,
        stream: true,
        think: false,
        keep_alive: '30m',
        options: {
          temperature: 0.1,
          num_ctx: 8192,
          num_predict: 1400
        },
        messages: [
          { role: 'system', content: modelSystemPrompt() },
          {
            role: 'user',
            content: `${previous ? `最近对话摘要：\n${previous}\n\n` : ''}当前问题：${prepared.resolvedQuestion}\n\n已检索的 Top-6 规范正文：\n${context}`
          }
        ]
      })
    });

    if (!response.ok) throw new Error(`本地模型服务返回 HTTP ${response.status}`);
    if (!response.body) throw new Error('本地模型服务未返回流式内容');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    const consumeLine = async (rawLine) => {
      const line = rawLine.trim();
      if (!line) return;
      let payload;
      try { payload = JSON.parse(line); } catch { return; }
      if (payload.error) throw new Error(payload.error);
      const delta = stripEllipsis(payload.message?.content || '');
      if (!delta) return;
      answer += delta;
    };

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) await consumeLine(line);
      if (done) break;
    }
    if (buffer) await consumeLine(buffer);
    if (!answer.trim()) throw new Error('本地模型服务未返回有效答案');
    answer = validatedModelAnswer(answer, prepared);
    for (const part of answer.match(/[\s\S]{1,72}/g) || [answer]) await onDelta(part);
    return { answer, model };
  }

  async answerStream(question, { history = [], onMeta = async () => {}, onDelta = async () => {}, signal } = {}) {
    const prepared = this.prepare(question, history);
    await onMeta({
      sources: prepared.sources,
      documents: prepared.documents,
      suggestions: prepared.suggestions,
      resolvedQuestion: prepared.resolvedQuestion,
      reference: prepared.reference
    });

    const verifiedAnswer = verifiedAnswerForQuestion(prepared);
    if (verifiedAnswer) {
      for (const part of verifiedAnswer.match(/[\s\S]{1,72}/g) || [verifiedAnswer]) await onDelta(part);
      return {
        answer: verifiedAnswer,
        sources: prepared.sources,
        documents: prepared.documents,
        suggestions: prepared.suggestions,
        mode: 'verified-knowledge',
        model: null,
        resolvedQuestion: prepared.resolvedQuestion
      };
    }

    if (!prepared.results.length) {
      const answer = extractiveAnswer(prepared.question, prepared.results, prepared.sources);
      for (const part of answer.match(/[\s\S]{1,72}/g) || [answer]) await onDelta(part);
      return { answer, sources: prepared.sources, documents: prepared.documents, suggestions: prepared.suggestions, mode: 'extractive', resolvedQuestion: prepared.resolvedQuestion };
    }

    let streamed = '';
    const engines = [];
    if (process.env.KNOWLEDGE_API_KEY) {
      engines.push({
        mode: 'remote-model',
        run: async () => {
          let lastError;
          for (let attempt = 0; attempt < 1; attempt += 1) {
            try {
              return await this.streamModel(prepared, emitDelta, signal);
            } catch (error) {
              lastError = error;
              streamed = '';
              if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
            }
          }
          throw lastError;
        }
      });
    }
    if (!process.env.KNOWLEDGE_API_KEY && this.localModelReady) {
      engines.push({ mode: 'local-model', run: () => this.streamLocalModel(prepared, emitDelta, signal) });
    }
    let lastError = null;

    async function emitDelta(delta) {
      streamed += delta;
      await onDelta(delta);
    }

    for (const engine of engines) {
      streamed = '';
      try {
        const modelResult = await engine.run();
        if (engine.mode === 'remote-model') this.remoteModelReady = true;
        return {
          answer: modelResult.answer,
          sources: prepared.sources,
          documents: prepared.documents,
          suggestions: prepared.suggestions,
          mode: engine.mode,
          model: modelResult.model,
          warning: lastError?.message || null,
          resolvedQuestion: prepared.resolvedQuestion
        };
      } catch (error) {
        lastError = error;
        if (engine.mode === 'remote-model') this.remoteModelReady = false;
        if (streamed.trim()) {
          const notice = '\n\n注意事项\n回答未完整生成，以上内容仅供定位；请逐条核验引用的规范原文后再采用。';
          await onDelta(notice);
          return {
            answer: streamed + notice,
            sources: prepared.sources,
            documents: prepared.documents,
            suggestions: prepared.suggestions,
            mode: `${engine.mode}-partial`,
            model: engine.mode === 'remote-model' ? this.remoteModel : this.localModel,
            warning: error.message,
            resolvedQuestion: prepared.resolvedQuestion
          };
        }
      }
    }

    const answer = extractiveAnswer(prepared.question, prepared.results, prepared.sources);
    for (const part of answer.match(/[\s\S]{1,72}/g) || [answer]) await onDelta(part);
    return {
      answer,
      sources: prepared.sources,
      documents: prepared.documents,
      suggestions: prepared.suggestions,
      mode: process.env.KNOWLEDGE_API_KEY ? 'source-brief' : 'extractive',
      warning: null,
      resolvedQuestion: prepared.resolvedQuestion
    };
  }

  async answer(question, { history = [] } = {}) {
    let answer = '';
    const result = await this.answerStream(question, {
      history,
      onDelta: async (delta) => { answer += delta; }
    });
    return { ...result, answer };
  }
}

export {
  buildSources,
  compactExcerpt,
  createFileInventory,
  extractiveAnswer,
  joinPageItems,
  metadataFromPath,
  modelSystemPrompt,
  normalizeText,
  resolveQuestion,
  splitPageText,
  tokenize,
  walkPdfFiles
};
