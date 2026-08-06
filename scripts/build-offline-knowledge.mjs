import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, '.knowledge-cache', 'index.json.gz');
const target = path.join(root, 'offline-pack.js');

const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(source)));
const rows = Object.values(payload.storedFields || {});
const suspect = /(肉根揪|掉照|钥闻门|本标淅|本标淡|本标淮|毛石持土境|淫凑土挡土塌|工业厂房排架柱|工程实践证明|但选用|如\d{2,}|划\d{2,}|GByT|Smm|\uFFFD)/i;
const normative = /(应|宜|不得|严禁|不应|不宜|可采用|不小于|不大于|不低于|不高于|至少|必须|验算|承载力|稳定|变形|强度|抗震|抗滑|抗倾覆|地基|基础|渗流|排水|防渗|冲刷|冻胀)/;

function clean(value) {
  return String(value || '')
    .replace(/…+|\.{3,}/g, '')
    .replace(/\s*([。；，、：])\s*/g, '$1')
    .replace(/(?<=[A-Za-z0-9])一(?=[A-Za-z0-9])/g, '-')
    .replace(/(\d)\s*\.\s*(\d)/g, '$1.$2')
    .replace(/\s+(?=(?:mm|cm|m|MPa|kPa|%)(?:\b|[~～]))/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function quality(sentence) {
  if (sentence.length < 22 || sentence.length > 240) return -1;
  if (suspect.test(sentence) || !normative.test(sentence)) return -1;
  if (/\r|\n/.test(sentence)) return -1;
  if (/(?:\d\s+){2,}\d|[A-Za-z]\s+[A-Za-z]|'\s*[A-Za-z]|[A-Za-z]\s*'/.test(sentence)) return -1;
  if (!/[。；！？!?]$/.test(sentence)) return -1;
  if (sentence.length > 100 && !/[，；]/.test(sentence)) return -1;
  let score = 0;
  if (/(不得|严禁|必须|不应|不宜)/.test(sentence)) score += 5;
  if (/(不小于|不大于|不低于|不高于|宜取|应取)/.test(sentence)) score += 5;
  if (/\d+(?:\.\d+)?\s*(?:mm|cm|m|MPa|kPa|%)/i.test(sentence)) score += 5;
  if (/(验算|承载力|稳定|变形|抗震|抗滑|抗倾覆|地基|基础|渗流|排水|防渗|冲刷|冻胀)/.test(sentence)) score += 3;
  score += Math.min(4, sentence.length / 60);
  return score;
}

const perDocument = new Map();
for (const row of rows) {
  const key = `${row.title}|${row.code}`;
  const candidates = clean(row.text)
    .split(/(?<=[。；！？!?])\s*/)
    .map((text) => ({ text, score: quality(text) }))
    .filter((item) => item.score >= 0);
  if (!candidates.length) continue;
  const best = candidates.sort((left, right) => right.score - left.score)[0];
  const list = perDocument.get(key) || [];
  list.push({
    title: row.title,
    code: row.code,
    page: row.page,
    path: row.relativePath,
    text: best.text,
    score: best.score
  });
  perDocument.set(key, list);
}

const selected = [];
for (const list of perDocument.values()) {
  list.sort((left, right) => right.score - left.score);
  const seen = new Set();
  for (const item of list) {
    const signature = item.text.replace(/[\s，。；：、()（）]/g, '').slice(0, 56);
    if (seen.has(signature)) continue;
    seen.add(signature);
    selected.push({ t: item.title, c: item.code, p: item.page, f: item.path, x: item.text });
    if (seen.size >= 48) break;
  }
}

selected.sort((left, right) => left.t.localeCompare(right.t, 'zh-CN') || left.p - right.p);
fs.writeFileSync(target, `var OFFLINE_KNOWLEDGE = ${JSON.stringify(selected)};\n`, 'utf8');
console.log(`Wrote ${selected.length} offline knowledge points to ${target}`);
