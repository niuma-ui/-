import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataSource = await fs.readFile(path.join(root, 'data.js'), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(`${dataSource};globalThis.__DATA = DATA;`, context);

const entries = [...new Map(context.__DATA.map((item) => [
  `${item.code}|${item.name}`,
  { code: item.code, name: item.name }
])).values()];

const platform = 'https://std.samr.gov.cn';
const detailPaths = {
  BV_GB: '/gb/search/gbDetailed?id=',
  BV_HB: '/hb/search/stdHBDetailed?id=',
  BV_DB: '/db/search/stdDBDetailed?id='
};
const authorities = {
  BV_GB: '全国标准信息公共服务平台 · 国家标准',
  BV_HB: '全国标准信息公共服务平台 · 行业标准',
  BV_DB: '全国标准信息公共服务平台 · 地方标准'
};
const publicationOverrides = {
  'GB50666-2011': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2011/art_17339_206934.html',
  'GBT51015-2014': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2015/art_17339_224321.html',
  'GB50330-2013': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2015/art_17339_224874.html',
  'GB50007-2011': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2011/art_17339_206919.html',
  'GB50286-2013': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2015/art_17339_224611.html',
  'GB50009-2012': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2012/art_17339_210754.html',
  'GB50010-2010': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2024/art_17339_778180.html',
  'JTGD30-2015': 'https://xxgk.mot.gov.cn/2020/jigou/glj/202006/t20200623_3312251.html',
  'JGJ79-2012': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2012/art_17339_211727.html',
  'GB50013-2018': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2024/art_17339_241590.html',
  'GB50014-2021': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2021/art_17339_250183.html',
  'GB50202-2018': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2019/art_17339_239995.html',
  'GB50096-2011': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2011/art_17339_206878.html',
  'GB50763-2012': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2012/art_17339_209758.html',
  'GB51192-2016': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2017/art_17339_230801.html',
  'GBT51439-2021': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2021/art_17339_250179.html',
  'GBT50337-2018': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2019/art_17339_239845.html',
  'GB51018-2014': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2015/art_17339_224099.html',
  'CJJ36-2016': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2017/art_17339_231174.html',
  'GB50068-2018': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2019/art_17339_239764.html',
  'GB50288-2018': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2019/art_17339_240004.html',
  'GB50268-2008': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2008/art_17339_179023.html',
  'JTGD60-2015': 'https://xxgk.mot.gov.cn/2020/jigou/glj/202204/t20220425_3652828.html',
  'GB50016-2014': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2015/art_17339_224333.html',
  'GB50318-2017': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2017/art_17339_231227.html',
  'GB50054-2011': 'https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2011/art_17339_206925.html'
};

const officialPublicationNames = {
  'GB50286-2013': '堤防工程设计规范',
  'GBT50337-2018': '城市环境卫生设施规划标准',
  'CJJ36-2016': '城镇道路养护技术规范'
};

const directRecordOverrides = {
  'NBT11089-2023': {
    url: 'https://hbba.sacinfo.org.cn/stdDetail/d681956501f72c78931dc4167edd51d9eee57a3fa85dda7000b6c90241669cc3',
    authority: '全国行业标准信息服务平台 · 国家能源局备案',
    label: '查看官方行业标准备案详情',
    officialCode: 'NB/T 11089-2023',
    officialName: '水工挡土墙设计规范'
  },
  'SLT260-2025': {
    url: 'https://hbba.sacinfo.org.cn/stdDetail/58735a43b7cefc2e4b10f48b2d0e74d67b92046c648296c5386e54cb425d12ef',
    authority: '全国行业标准信息服务平台 · 水利部备案',
    label: '查看官方行业标准备案详情',
    officialCode: 'SL/T 260-2025',
    officialName: '堤防工程施工规范'
  },
  'JTG3362-2018': {
    url: 'https://jtst.mot.gov.cn/hb/search/stdHBDetailed?id=43905ea5cfb5e748c54f6413238b510e',
    authority: '中华人民共和国交通运输部',
    label: '查看交通运输部标准详情',
    officialCode: 'JTG 3362-2018',
    officialName: '公路钢筋混凝土及预应力混凝土桥涵设计规范'
  }
};

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

function cleanText(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function codeKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[—–−~～]/g, '-')
    .replace(/[^A-Z0-9.-]/g, '');
}

function nameKey(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').replace(/[《》]/g, '');
}

function codeFamily(value) {
  const letters = codeKey(value).match(/^[A-Z]+/)?.[0] || '';
  if (letters.startsWith('GB')) return 'GB';
  if (letters.startsWith('SL')) return 'SL';
  if (letters.startsWith('NB')) return 'NB';
  if (letters.startsWith('DB')) return 'DB';
  return letters;
}

function parseResults(html) {
  const rows = [];
  const pattern = /<a\s+href="#"\s+tid="([^"]+)"\s+pid="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const codeMatch = match[3].match(/<span[^>]*class="en-code"[^>]*>([\s\S]*?)<\/span>/i);
    const code = cleanText(codeMatch?.[1]);
    const name = cleanText(match[3].replace(codeMatch?.[0] || '', ''));
    if (code && detailPaths[match[1]]) rows.push({ type: match[1], pid: match[2], code, name });
  }
  return rows;
}

async function search(query) {
  const url = `${platform}/search/stdPage?tid=&q=${encodeURIComponent(query)}&op=`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (official-standard-link-verifier)' },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseResults(await response.text());
}

function fallbackFor(code) {
  const key = codeKey(code);
  if (key.startsWith('Q')) return {
    url: '',
    authority: '企业标准信息公共服务平台',
    label: '',
    status: 'unresolved'
  };
  if (key.startsWith('DB')) return {
    url: '',
    authority: '全国地方标准信息平台',
    label: '',
    status: 'unresolved'
  };
  const publication = publicationAuthority(code);
  if (publication) {
    return {
      url: '',
      authority: publication.authority,
      label: '',
      status: 'unresolved'
    };
  }
  return {
    url: '',
    authority: '全国行业标准信息服务平台',
    label: '',
    status: 'unresolved'
  };
}

function publicationAuthority(code) {
  const key = codeKey(code);
  if (key.startsWith('JTG')) return {
    domain: 'mot.gov.cn',
    authority: '中华人民共和国交通运输部',
    label: '查看交通运输部正式发布依据'
  };
  if (key.startsWith('NB')) return {
    domain: 'nea.gov.cn',
    authority: '国家能源局',
    label: '查看国家能源局正式发布依据'
  };
  if (key.startsWith('GB') || key.startsWith('JGJ') || key.startsWith('CJJ')) return {
    domain: 'mohurd.gov.cn',
    authority: '中华人民共和国住房和城乡建设部',
    label: '查看住房城乡建设部正式发布依据'
  };
  return null;
}

function parseSearchResults(html, expectedDomain) {
  const rows = [];
  const resultPattern = /<li[^>]*class="[^"]*res-list[^"]*"[\s\S]*?<\/li>/gi;
  for (const result of html.matchAll(resultPattern)) {
    const link = result[0].match(/<h3[^>]*>[\s\S]*?<a[^>]*data-mdurl="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const description = result[0].match(/<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (!link) continue;
    const url = decodeHtml(link[1]);
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (!(host === expectedDomain || host.endsWith(`.${expectedDomain}`))) continue;
      rows.push({ url, title: cleanText(link[2]), excerpt: cleanText(description?.[1]) });
    } catch {
      // Ignore malformed search results.
    }
  }
  return rows;
}

async function findOfficialPublication(entry) {
  const source = publicationAuthority(entry.code);
  if (!source) return null;
  const compactCode = entry.code.normalize('NFKC').replace(/[—–−]/g, '-').replace(/\s+/g, '');
  const compactName = entry.name.replace(/\s+/g, '');
  const queries = [
    `site:${source.domain} "${entry.code}" "${compactName}"`,
    `site:${source.domain} "${compactCode}" 发布 ${compactName}`,
    `site:${source.domain} "现批准《${compactName}》" 编号`
  ];
  const rows = [];
  for (const query of queries) {
    const response = await fetch(`https://www.so.com/s?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) continue;
    rows.push(...parseSearchResults(await response.text(), source.domain));
    if (rows.some((row) => codeKey(`${row.title} ${row.excerpt}`).includes(codeKey(entry.code)))) break;
  }
  const expectedCode = codeKey(entry.code);
  const expectedName = nameKey(entry.name);
  rows.forEach((row) => {
    const haystack = `${row.title} ${row.excerpt}`;
    row.score = 0;
    if (codeKey(haystack).includes(expectedCode)) row.score += 8;
    if (nameKey(haystack).includes(expectedName)) row.score += 6;
    if (/发布|公告|标准|规范/.test(row.title)) row.score += 3;
    if (/下载|附件|全文/.test(row.excerpt)) row.score += 1;
  });
  const best = rows.sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 8) return null;

  try {
    const detail = await fetch(best.url.replace(/^http:/, 'https:'), {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    });
    if (!detail.ok) return null;
    const finalUrl = detail.url;
    const finalHost = new URL(finalUrl).hostname.toLowerCase();
    if (!(finalHost === source.domain || finalHost.endsWith(`.${source.domain}`))) return null;
    const body = cleanText(await detail.text());
    const exactCode = codeKey(body).includes(expectedCode);
    const exactName = nameKey(body).includes(expectedName);
    if (!exactCode && !exactName) return null;
    return {
      ...entry,
      url: finalUrl,
      authority: source.authority,
      label: source.label,
      status: exactCode ? 'verified-publication' : 'code-review',
      officialCode: exactCode ? entry.code : '',
      officialName: entry.name,
      type: 'official-publication'
    };
  } catch {
    return null;
  }
}

async function resolveEntry(entry) {
  if (/10341\.1\s*[~～-]\s*4-2019/i.test(entry.code.normalize('NFKC'))) {
    return {
      ...entry,
      url: `${platform}/hb/search/stdHBDetailed?id=B93EFF4F39D38B79E05397BE0A0AEFBA`,
      authority: '全国标准信息公共服务平台 · 国家能源行业标准',
      label: '官方依据 · 第1部分',
      status: 'code-review',
      officialCode: 'NB/T 10341.1-2019 至 NB/T 10341.4-2023',
      officialName: '水电工程启闭机设计规范（分部分发布）',
      type: 'official-series',
      links: [
        { label: '官方依据 · 第1部分', url: `${platform}/hb/search/stdHBDetailed?id=B93EFF4F39D38B79E05397BE0A0AEFBA` },
        { label: '官方依据 · 第2部分', url: `${platform}/hb/search/stdHBDetailed?id=B93EFF4F39D48B79E05397BE0A0AEFBA` },
        { label: '官方依据 · 第3部分', url: `${platform}/hb/search/stdHBDetailed?id=B93EFF4F39D58B79E05397BE0A0AEFBA` },
        { label: '官方依据 · 第4部分（2023）', url: `${platform}/hb/search/stdHBDetailed?id=18DB2D46B0DFD654E06397BE0A0AB4DA` }
      ]
    };
  }
  const overrideKey = codeKey(entry.code);
  const directRecord = directRecordOverrides[overrideKey];
  if (directRecord) {
    const exactName = nameKey(entry.name) === nameKey(directRecord.officialName);
    return {
      ...entry,
      ...directRecord,
      status: exactName ? 'verified' : 'code-review',
      type: 'official-record'
    };
  }
  const override = publicationOverrides[overrideKey];
  if (override) {
    const source = publicationAuthority(entry.code);
    const officialName = officialPublicationNames[overrideKey] || entry.name;
    const exactName = nameKey(entry.name) === nameKey(officialName);
    return {
      ...entry,
      url: override,
      authority: source.authority,
      label: exactName ? source.label : '查看主管部门发布文件并核对名称',
      status: exactName ? 'verified-publication' : 'code-review',
      officialCode: entry.code,
      officialName,
      type: 'official-publication'
    };
  }
  let rows = await search(entry.code);
  let match = rows.find((row) => codeKey(row.code) === codeKey(entry.code));
  let status = 'verified';

  if (!match) {
    rows = await search(entry.name);
    match = rows.find((row) => codeKey(row.code) === codeKey(entry.code));
  }

  if (!match) {
    const sameName = rows.find((row) => nameKey(row.name) === nameKey(entry.name) && codeFamily(row.code) === codeFamily(entry.code));
    if (sameName) {
      match = sameName;
      status = 'code-review';
    }
  }

  if (!match) {
    const publication = await findOfficialPublication(entry);
    if (publication) return publication;
    return { ...entry, ...fallbackFor(entry.code), officialCode: '', officialName: '' };
  }
  return {
    ...entry,
    url: `${platform}${detailPaths[match.type]}${encodeURIComponent(match.pid)}`,
    authority: authorities[match.type],
    label: status === 'verified' ? '查看官方认证详情' : '查看同名官方标准并核对编号',
    status,
    officialCode: match.code,
    officialName: match.name,
    pid: match.pid,
    type: match.type
  };
}

const resolved = new Array(entries.length);
let cursor = 0;
const workers = Array.from({ length: 5 }, async () => {
  while (cursor < entries.length) {
    const index = cursor++;
    const entry = entries[index];
    try {
      resolved[index] = await resolveEntry(entry);
    } catch (error) {
      resolved[index] = { ...entry, ...fallbackFor(entry.code), error: error.message };
    }
    process.stdout.write(`\r官方来源核验 ${index + 1}/${entries.length}`);
  }
});
await Promise.all(workers);

const sourceMap = Object.fromEntries(resolved.map((item) => [`${item.code}|${item.name}`, item]));
const output = `window.OFFICIAL_SOURCES = ${JSON.stringify(sourceMap, null, 2)};\n`;
await fs.writeFile(path.join(root, 'official-sources.js'), output, 'utf8');
await fs.writeFile(path.join(root, '.knowledge-cache', 'official-source-report.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  total: resolved.length,
  verified: resolved.filter((item) => item.status === 'verified').length,
  verifiedPublication: resolved.filter((item) => item.status === 'verified-publication').length,
  codeReview: resolved.filter((item) => item.status === 'code-review').length,
  registry: resolved.filter((item) => item.status === 'registry').length,
  unresolved: resolved.filter((item) => item.status === 'unresolved').length,
  items: resolved
}, null, 2), 'utf8');

process.stdout.write('\n');
console.log(JSON.stringify({
  total: resolved.length,
  verified: resolved.filter((item) => item.status === 'verified').length,
  verifiedPublication: resolved.filter((item) => item.status === 'verified-publication').length,
  codeReview: resolved.filter((item) => item.status === 'code-review').length,
  registry: resolved.filter((item) => item.status === 'registry').length,
  unresolved: resolved.filter((item) => item.status === 'unresolved').length
}, null, 2));
