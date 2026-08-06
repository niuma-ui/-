import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { KnowledgeBase } from './knowledge-base.mjs';
import { BimDoctor } from './bim-doctor.mjs';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const pdfRoot = path.join(projectRoot, '水利水电规范库');
const cacheDir = path.join(projectRoot, '.knowledge-cache');
const bimDoctorDir = path.join(cacheDir, 'bim-doctor');
const bimDoctorRulesFile = path.join(projectRoot, 'bim-doctor-rules.json');
const bimDoctorContextFile = path.join(projectRoot, 'bim-doctor-context.json');
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4173);
const queryWindowMs = 10 * 60 * 1000;
const queryLimit = Number(process.env.QUERY_LIMIT || 30);
const sessionTtlMs = 12 * 60 * 60 * 1000;
const queryBuckets = new Map();
const sessions = new Map();
const publicFiles = new Set([
  'index.html',
  'index_20260725.html',
  'data.js',
  'official-sources.js',
  'offline-pack.js',
  'ios-workbench.css',
  'ios-workbench.js'
]);
const securityHeaders = {
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:4173 http://localhost:4173; object-src 'self'; base-uri 'none'; frame-ancestors 'self'"
};
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Knowledge-Session, X-BIM-Bridge-Token',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS'
};
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf'
};

const knowledge = new KnowledgeBase({ root: pdfRoot, cacheDir });
knowledge.initialize().catch((error) => {
  console.error('知识库索引初始化失败：', error);
});
const bimDoctor = new BimDoctor({ dataDir: bimDoctorDir, rulesFile: bimDoctorRulesFile, contextFile: bimDoctorContextFile, knowledge });
bimDoctor.initialize().catch((error) => {
  console.error('构件医生初始化失败：', error);
});

function responseHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...securityHeaders,
    ...corsHeaders,
    ...extra
  };
}

function json(response, status, payload) {
  if (response.headersSent) return;
  response.writeHead(status, responseHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
  response.end(JSON.stringify(payload));
}

function clientAddress(request) {
  const forwarded = String(request.headers['cf-connecting-ip'] || request.headers['x-forwarded-for'] || '');
  return forwarded.split(',')[0].trim() || request.socket.remoteAddress || 'unknown';
}

function allowQuery(request) {
  const now = Date.now();
  const address = clientAddress(request);
  const previous = queryBuckets.get(address);
  const bucket = !previous || now - previous.startedAt >= queryWindowMs
    ? { startedAt: now, count: 0 }
    : previous;
  bucket.count += 1;
  queryBuckets.set(address, bucket);

  if (queryBuckets.size > 500) {
    for (const [key, value] of queryBuckets) {
      if (now - value.startedAt >= queryWindowMs) queryBuckets.delete(key);
    }
  }

  return bucket.count <= queryLimit;
}

async function readJson(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('请求内容不是有效的 JSON');
  }
}

function bridgeAuthorized(request) {
  const expected = String(process.env.BIM_BRIDGE_TOKEN || '');
  const provided = String(request.headers['x-bim-bridge-token'] || '');
  if (expected) {
    const left = Buffer.from(expected);
    const right = Buffer.from(provided);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }
  const address = String(request.socket.remoteAddress || '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function requireBridgeAuth(request, response) {
  if (bridgeAuthorized(request)) return true;
  json(response, 401, { error: '构件医生桥接未授权；远程桥接请配置 BIM_BRIDGE_TOKEN' });
  return false;
}

function normalizeSessionId(value) {
  const candidate = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{16,80}$/.test(candidate) ? candidate : crypto.randomUUID();
}

function cleanSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.updatedAt > sessionTtlMs) sessions.delete(id);
  }
  if (sessions.size <= 500) return;
  const ordered = [...sessions.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt);
  for (const [id] of ordered.slice(0, sessions.size - 500)) sessions.delete(id);
}

function getSession(value) {
  cleanSessions();
  const id = normalizeSessionId(value);
  const session = sessions.get(id) || { id, turns: [], updatedAt: Date.now() };
  session.updatedAt = Date.now();
  sessions.set(id, session);
  return session;
}

function summarizeAnswer(answer) {
  return String(answer || '')
    .replace(/\s+/g, ' ')
    .replace(/原文摘录：[^。；]{80,}/g, '原文摘录已省略')
    .slice(0, 700);
}

function citationIdentity(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s/_.-]+/g, '');
}

function sourcesInAnswerOrder(answer, sources) {
  const available = [...(sources || [])];
  const ordered = [];
  const citationPattern = /\[([^｜\]]+)(?:｜([^｜\]]+))?｜第\s*(\d+)\s*页\]/g;
  for (const match of String(answer || '').matchAll(citationPattern)) {
    const first = citationIdentity(match[1]);
    const second = citationIdentity(match[2]);
    const page = Number(match[3]);
    const source = available.find((item) => {
      if (Number(item.page) !== page) return false;
      const title = citationIdentity(item.title);
      const code = citationIdentity(item.code);
      return second ? title === first && code === second : title === first || code === first;
    });
    if (source && !ordered.includes(source)) ordered.push(source);
  }
  for (const source of available) {
    if (!ordered.includes(source)) ordered.push(source);
  }
  return ordered;
}

function remember(session, question, result) {
  const orderedSources = sourcesInAnswerOrder(result.answer, result.sources);
  session.turns.push({
    question,
    resolvedQuestion: result.resolvedQuestion || question,
    summary: summarizeAnswer(result.answer),
    sources: orderedSources.slice(0, 8).map(({ title, code, page, path, confidence }) => ({
      title, code, page, path, confidence
    }))
  });
  session.turns = session.turns.slice(-5);
  session.updatedAt = Date.now();
}

function validateQuestion(body) {
  const question = String(body.question || '').trim();
  if (question.length < 2 || question.length > 500) {
    const error = new Error('问题长度应为 2 到 500 个字符');
    error.statusCode = 400;
    throw error;
  }
  return question;
}

function apiReady(request, response) {
  if (!allowQuery(request)) {
    response.setHeader('Retry-After', Math.ceil(queryWindowMs / 1000));
    json(response, 429, { error: '提问较频繁，请稍后再试' });
    return false;
  }
  if (!knowledge.ready) {
    json(response, 503, { error: '知识库正在建立正文索引', status: knowledge.status() });
    return false;
  }
  return true;
}

function isInsideRoot(filePath) {
  const relative = path.relative(projectRoot, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isPublicFile(filePath) {
  const relative = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  return publicFiles.has(relative)
    || relative.startsWith('assets/')
    || relative.startsWith('水利水电规范库/');
}

async function serveFile(request, response, pathname) {
  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(projectRoot, `.${requestPath}`);
  if (!isInsideRoot(filePath)) {
    response.writeHead(403, responseHeaders());
    response.end();
    return;
  }
  if (!isPublicFile(filePath)) {
    response.writeHead(404, responseHeaders());
    response.end('Not found');
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    response.writeHead(404, responseHeaders());
    response.end('Not found');
    return;
  }
  if (!stat.isFile()) {
    response.writeHead(404, responseHeaders());
    response.end('Not found');
    return;
  }

  const contentType = types[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.range;
  if (range && contentType === 'application/pdf') {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (start <= end && start < stat.size) {
        response.writeHead(206, responseHeaders({
          'Content-Type': contentType,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=3600'
        }));
        if (request.method === 'HEAD') return response.end();
        fs.createReadStream(filePath, { start, end }).pipe(response);
        return;
      }
    }
  }

  response.writeHead(200, responseHeaders({
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': contentType === 'application/pdf' ? 'bytes' : 'none',
    'Cache-Control': contentType === 'application/pdf' ? 'private, max-age=3600' : 'no-store'
  }));
  if (request.method === 'HEAD') return response.end();
  fs.createReadStream(filePath).pipe(response);
}

async function handleStreamingQuery(request, response) {
  if (!apiReady(request, response)) return;
  const body = await readJson(request);
  const question = validateQuestion(body);
  const snapshot = body.bimSnapshot && (body.bimSnapshot.project || body.bimSnapshot.job)
    ? body.bimSnapshot
    : await bimDoctor.latestSnapshot();
  const hasBimContext = snapshot && doctorContextTerms(snapshot).length > 0;
  const session = getSession(body.sessionId || request.headers['x-knowledge-session']);
  const abortController = new AbortController();
  response.on('close', () => {
    if (!response.writableEnded) abortController.abort();
  });
  response.writeHead(200, responseHeaders({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'X-Accel-Buffering': 'no'
  }));
  const writeEvent = (type, payload = {}) => {
    if (!response.writableEnded && !response.destroyed) response.write(`${JSON.stringify({ type, ...payload })}\n`);
  };

  writeEvent('start', { sessionId: session.id });
  try {
    const scope = doctorQuestionScope(question);
    const compliance = scope === 'project' ? snapshot?.projectCompliance : snapshot?.result;
    if (snapshot && compliance && /(是否|符合|合规|达标|满足.*规范|合不合)/.test(question)) {
      const complianceView = { status: compliance.status, summary: compliance.summary, issues: compliance.issues || [] };
      const sources = scope === 'project' ? (snapshot.projectProfile?.citations || []) : (snapshot.result?.sources || []);
      const answer = complianceAnswer(snapshot, scope);
      await Promise.resolve(writeEvent('meta', { sources, documents: [], suggestions: [], resolvedQuestion: question }));
      await Promise.resolve(writeEvent('delta', { delta: answer }));
      remember(session, question, { answer, sources, documents: [], suggestions: [], mode: 'rule-engine', resolvedQuestion: question, compliance: complianceView });
      writeEvent('done', { sessionId: session.id, mode: 'rule-engine', model: null, warning: null, sources, documents: [], suggestions: [], resolvedQuestion: question, compliance: complianceView });
      return;
    }
    if (snapshot?.job && isBimContextQuestion(question) && !doctorIdentityReady(snapshot, scope)) {
      const answer = contextRequiredAnswer(snapshot, scope);
      await Promise.resolve(writeEvent('meta', { sources: [], documents: [], suggestions: [], resolvedQuestion: question }));
      await Promise.resolve(writeEvent('delta', { delta: answer }));
      remember(session, question, { answer, sources: [], documents: [], suggestions: [], mode: 'identity-required', resolvedQuestion: question });
      writeEvent('done', { sessionId: session.id, mode: 'identity-required', model: null, warning: null, sources: [], documents: [], suggestions: [], resolvedQuestion: question });
      return;
    }
    const contextualQuestion = hasBimContext ? doctorContextPrompt(snapshot, question) : question;
    const result = await knowledge.answerStream(contextualQuestion, {
      history: session.turns,
      signal: abortController.signal,
      onMeta: async (payload) => writeEvent('meta', payload),
      onDelta: async (delta) => writeEvent('delta', { delta })
    });
    remember(session, question, result);
    writeEvent('done', {
      sessionId: session.id,
      mode: result.mode,
      model: result.model || null,
      warning: result.warning || null,
      sources: result.sources,
      documents: result.documents,
      suggestions: result.suggestions,
      resolvedQuestion: result.resolvedQuestion
    });
  } catch (error) {
    writeEvent('error', { error: error.name === 'AbortError' ? '回答已取消' : error.message });
  } finally {
    if (!response.writableEnded && !response.destroyed) response.end();
  }
}

function profileGroupText(groups = []) {
  return groups.slice(0, 12).map((group) => {
    const name = group.canonicalName || group.name || group.sourceName || group.groupId || '未命名';
    const count = group.count ?? group.memberCount ?? group.memberEntityIds?.length;
    return count == null ? name : `${name}(${count})`;
  }).join('、') || '无数据';
}

function doctorQuestionScope(question) {
  if (/(整体|整个|全项目|全工程|项目整体|工程整体|全部构件|各类构件|系统组成|项目组成)/.test(question)) return 'project';
  if (/(当前构件|这个构件|该构件|选中构件|单个构件|entity\s*id)/i.test(question)) return 'component';
  return 'auto';
}

function isBimContextQuestion(question) {
  return /(当前|本项目|本工程|这个构件|该构件|选中构件|整体工程|整个项目|项目构件|工程构件|真实名称|规范名称|所属系统|整体组件|作用和材质)/.test(question);
}

function doctorIdentityReady(snapshot, scope = 'auto') {
  if (scope === 'project') {
    const total = Number(snapshot.projectProfile?.componentCount || 0);
    return total > 0 && Number(snapshot.projectProfile?.dataQuality?.identityVerified || 0) === total &&
      Number(snapshot.projectProfile?.dataQuality?.standardMatched || 0) === total;
  }
  return snapshot.component?.identity?.status === 'verified' && snapshot.component?.standardMatch?.status === 'verified';
}

function identityMissingText(fields) {
  const labels = { canonicalName: '真实名称', systemType: '所属系统', assemblyType: '整体组件', semanticType: '语义类型', verifiedEvidence: '审核证据', identity: '身份信息' };
  return (fields || ['identity']).map((field) => labels[field] || field).join('、');
}

function contextRequiredAnswer(snapshot, scope = 'auto') {
  const profile = snapshot.projectProfile || {};
  const component = snapshot.component || {};
  const modelGroups = (profile.modelGroups || []).map((item) => `${item.name}（${item.count}个实体）`).join('、');
  if (scope === 'project') {
    return `当前工程已读取 ${profile.componentCount || 0} 个实体、${profile.modelCount || 0} 个模型组${modelGroups ? `：${modelGroups}` : ''}。真实身份已核实 ${profile.dataQuality?.identityVerified || 0} 个，规范正式名称已对应 ${profile.dataQuality?.standardMatched || 0} 个；未完成的构件不能判断合规。`;
  }
  return `当前实体为 ${component.entityId || '未选中'}${component.sourceName ? `，BIMBase原始名称为“${component.sourceName}”` : ''}。其真实专业身份或规范正式名称对应依据尚不完整，不能据此匹配规范或判断合规。`;
}

function doctorContextPrompt(snapshot, question) {
  const project = snapshot.project || {};
  const profile = snapshot.projectProfile || {};
  const component = snapshot.component || {};
  const result = snapshot.result || {};
  const parameters = Object.entries(component.parameters || {}).map(([key, value]) => `${key}=${value}`).join('，');
  const issues = (result.issues || []).map((issue) => {
    const source = issue.sources?.[0] || {};
    return `${issue.title || issue.ruleId}: 实际${issue.actual ?? '缺失'}，预期${issue.expected || ''}，依据${source.code || issue.standardCode || '未填写'} ${source.clause || issue.clause || ''} 第${source.page || '未标注'}页`;
  }).join('；');
  const componentIndex = (profile.components || []).slice(0, 60).map((item) =>
    `${item.entityId}[真实名称=${item.canonicalName || '待确认'},规范名称=${item.standardName || '待对应'},原始名称=${item.sourceName || '无'},身份=${item.identity?.status || 'unresolved'},规范对应=${item.standardMatch?.status || 'unresolved'},系统=${item.systemType || '未识别'},组件=${item.assemblyType || '未识别'},类型=${item.semanticType || '未识别'},作用=${item.role || '未识别'},材质=${item.material || '未识别'},SDK类=${item.className || '无'},层级=${item.levelName || '无'}]`
  ).join('；');
  return [
    `BIMBase整体工程：项目=${project.name || '未知'}，工程类型=${project.type || '未分类'}，专业=${project.discipline || '未填写'}，阶段=${project.stage || '未填写'}，构件数=${profile.componentCount ?? '未知'}，模型数=${profile.modelCount ?? '未知'}`,
    `工程组成：系统=${profileGroupText(profile.systems)}；整体组件=${profileGroupText(profile.assemblies)}；规范正式名称=${profileGroupText(profile.standardNames)}；构件类型=${profileGroupText(profile.componentTypes)}；材质=${profileGroupText(profile.materials)}；BIM原生组合=${profileGroupText(profile.nativeGroups)}`,
    `身份质量：已核实=${profile.dataQuality?.identityVerified || 0}，规范名称已对应=${profile.dataQuality?.standardMatched || 0}，部分=${profile.dataQuality?.identityPartial || 0}，未识别=${profile.dataQuality?.identityUnresolved || 0}`,
    `工程构件目录：${componentIndex || '尚未取得构件语义信息'}`,
    `当前构件：entityId=${component.entityId || '未选中'}，真实名称=${component.canonicalName || '待确认'}，规范正式名称=${component.standardName || '待对应'}，原始名称=${component.sourceName || component.name || '无'}，身份状态=${component.identity?.status || 'unresolved'}，规范对应状态=${component.standardMatch?.status || 'unresolved'}，系统路径=${(component.systemPath || []).join(' / ') || '未识别'}，语义类型=${component.semanticType || '未识别'}，作用=${component.role || '未识别'}，材质=${component.material || '未识别'}，参数=${parameters || '无'}`,
    `机器规则结论：${result.status || 'NEED_RULE'}；${result.summary || '尚无已审核机器规则'}${issues ? `；问题=${issues}` : ''}`,
    `用户问题：${question}`,
    '先判断用户询问的是整体工程还是单构件，再按真实名称、系统、整体组件、构件类型、作用、材质和参数回答。只依据已核实的 BIM 身份证据、已审核规则和检索到的规范正文；形状及原始组合名称不参与规范分类。回答按结论、对象、参数对比、规范编号与版本、条款与PDF页码、原文摘要、建议组织。任何缺失必须明确，不得猜测；NEED_IDENTITY/NEED_STANDARD/NEED_RULE/NEED_DATA 均不得回答为合格。'
  ].join('\n');
}

function doctorContextTerms(snapshot) {
  const project = snapshot.project || {};
  const profile = snapshot.projectProfile || {};
  const component = snapshot.component || {};
  return [project.type, project.discipline, component.canonicalName, component.standardName, component.systemType, component.system, component.assemblyType, component.assembly, component.semanticType, component.componentType, component.role, component.material,
    ...(profile.systems || []).map((item) => item.name), ...(profile.assemblies || []).map((item) => item.name), ...(profile.standardNames || []).map((item) => item.name), ...(profile.componentTypes || []).map((item) => item.name)]
    .map((value) => String(value || '').trim())
    .filter((value, index, values) => value.length >= 2 && !/^(BIMBase|当前工程|未知|未分类|未填写|未识别|未匹配|待确认)/.test(value) && values.indexOf(value) === index);
}

function complianceAnswer(snapshot, scope = 'auto') {
  const useProject = scope === 'project';
  const result = useProject ? (snapshot.projectCompliance || {}) : (snapshot.result || {});
  if (useProject) {
    const summary = result.summary || {};
    if (result.status === 'PASS') return `结论：通过当前已审核规则。\n对象：整体工程快照，共 ${summary.total || 0} 个真实身份已核实构件。\n依据：${snapshot.projectProfile?.citations?.length || 0} 组可追溯规范引用。\n说明：仍需结合完整设计工况和规范原页进行最终复核。`;
    if (result.status === 'FAIL') return `结论：不符合。\n对象：整体工程，共 ${summary.fail || 0} 个构件未通过已审核规则。\n处理：请按构件医生报告中的实际值、限值、规范条款、PDF页码和整改建议逐项处理。`;
    if (result.status === 'NEED_DATA') return `结论：无法判定。\n原因：${summary.needData || 0} 个构件缺少规则所需参数。\n处理：补齐带单位的实际参数后重新检查。`;
    if (result.status === 'NEED_IDENTITY') return `结论：无法判定。\n原因：${summary.needIdentity || 0} 个实体尚未确认真实专业名称、系统、整体组件或身份依据。\n处理：完成真实构件身份审核后再匹配规范。`;
    if (result.status === 'NEED_STANDARD') return `结论：无法判定。\n原因：${summary.needStandard || 0} 个已识别构件在当前规范库中没有直接匹配的可靠条文。\n处理：补充并审核适用规范原文。`;
    return `结论：无法判定。\n原因：${summary.needRule || 0} 个构件尚无适用的已审核机器规则。\n处理：确认适用规范、条款、限值和适用条件后建立规则。`;
  }
  const component = snapshot.component || {};
  const objectText = `${component.canonicalName || '真实名称待确认'}（规范名称：${component.standardName || '待对应'}；${component.entityId || '未选中'}）`;
  if (result.status === 'NEED_IDENTITY') return `结论：无法判定。\n对象：${objectText}。\n原因：真实构件身份尚未核实，缺少 ${identityMissingText(component.identity?.missing)}。`;
  if (result.status === 'NEED_STANDARD') return `结论：无法判定。\n对象：${objectText}。\n原因：尚未用规范编号、版本、条款、PDF页码和原文核实其规范正式名称及适用关系。`;
  if (result.status === 'NEED_RULE') return `结论：无法判定。\n对象：${objectText}。\n原因：已有候选规范，但尚未形成包含条款、页码、限值和适用条件的已审核规则。`;
  if (result.status === 'NEED_DATA') return `结论：无法判定。\n对象：${objectText}。\n原因：缺少规则所需的带单位实际参数。`;
  const issueLines = (result.issues || []).map((issue) => {
    const source = issue.sources?.[0] || {};
    return `- ${issue.title || issue.ruleId}：实际 ${issue.actual ?? '缺失'}，要求 ${issue.expected}；依据 ${source.code || issue.standardCode || '未填写'} ${source.version || ''} 第${source.clause || issue.clause || '未标注'}条，PDF第${source.page || '未标注'}页；${source.excerpt ? `原文摘要：${source.excerpt}；` : ''}${issue.suggestion ? `建议：${issue.suggestion}` : ''}`;
  }).join('\n');
  return `结论：${result.status === 'PASS' ? '符合当前已审核规则' : '不符合当前已审核规则'}。\n对象：${objectText}，系统路径 ${(component.systemPath || []).join(' / ') || '未识别'}。\n核验：\n${issueLines || '无检查项'}\n说明：结论仅覆盖列出的规则、参数和工况。`;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      response.writeHead(204, responseHeaders());
      response.end();
      return;
    }

    if (request.method === 'GET' && pathname === '/api/knowledge/status') {
      json(response, 200, knowledge.status());
      return;
    }

    if (pathname.startsWith('/api/bim-doctor/')) {
      if (!requireBridgeAuth(request, response)) return;
      if (request.method === 'GET' && pathname === '/api/bim-doctor/status') {
        const ruleSet = await bimDoctor.getRuleSetInfo();
        json(response, 200, { ready: true, knowledgeReady: knowledge.ready, ruleCount: ruleSet.ruleCount, ruleSet, context: await bimDoctor.getContextMappings(), bridge: await bimDoctor.getBridgeState() });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/bim-doctor/heartbeat') {
        json(response, 200, { bridge: await bimDoctor.updateBridgeState(await readJson(request, 128 * 1024)) });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/bim-doctor/snapshot') {
        json(response, 200, await bimDoctor.latestSnapshot(url.searchParams.get('entityId') || '', url.searchParams.get('scope') || 'auto'));
        return;
      }
      if (request.method === 'GET' && pathname === '/api/bim-doctor/profile') {
        const snapshot = await bimDoctor.latestSnapshot('', 'project');
        json(response, 200, { project: snapshot.project, profile: snapshot.projectProfile, bridge: snapshot.bridge });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/bim-doctor/context') {
        json(response, 200, await bimDoctor.getContextMappings());
        return;
      }
      if (request.method === 'PUT' && pathname === '/api/bim-doctor/context') {
        const body = await readJson(request, 512 * 1024);
        json(response, 200, await bimDoctor.setContextMappings(body.mappings, body.meta || {}));
        return;
      }
      if (request.method === 'POST' && pathname === '/api/bim-doctor/ask') {
        const body = await readJson(request, 256 * 1024);
        const question = String(body.question || '').trim();
        if (!question) throw new Error('question 不能为空');
        const snapshot = body.jobId ? await bimDoctor.readJob(body.jobId).then(async (job) => {
          const result = (job.results || []).find((item) => String(item.entityId) === String(body.entityId || '')) || job.results?.[0] || null;
          const rawComponent = (job.components || []).find((item) => String(item.entityId) === String(body.entityId || '')) || job.components?.[0] || null;
          const profile = bimDoctor.projectProfile(job);
          return { bridge: await bimDoctor.getBridgeState(), job: bimDoctor.jobView(job), project: job.project, projectProfile: profile, projectCompliance: profile.compliance, component: bimDoctor.componentView(rawComponent, job.project), result };
        }) : await bimDoctor.latestSnapshot(body.entityId || '');
        const scope = doctorQuestionScope(question);
        const scopedCompliance = scope === 'project' ? snapshot.projectCompliance : snapshot.result;
        const compliance = scopedCompliance ? { status: scopedCompliance.status, summary: scopedCompliance.summary, issues: scopedCompliance.issues || [] } : { status: 'NEED_RULE', summary: '暂无项目检查结果', issues: [] };
        if (/(是否|符合|合规|达标|满足.*规范|合不合)/.test(question)) {
          json(response, 200, { answer: complianceAnswer(snapshot, scope), sources: scope === 'project' ? (snapshot.projectProfile?.citations || []) : (snapshot.result?.sources || []), documents: [], suggestions: [], mode: 'rule-engine', compliance, snapshot });
          return;
        }
        if (isBimContextQuestion(question) && !doctorIdentityReady(snapshot, scope)) {
          json(response, 200, { answer: contextRequiredAnswer(snapshot, scope), sources: [], documents: [], suggestions: [], mode: 'identity-required', compliance, snapshot });
          return;
        }
        const terms = doctorContextTerms(snapshot);
        if (!terms.length) {
          json(response, 200, { answer: contextRequiredAnswer(snapshot, scope), sources: [], documents: [], suggestions: [], mode: 'context-required', compliance, snapshot });
          return;
        }
        const probe = knowledge.search(`${terms.join(' ')} ${question}`, 8);
        const relevant = probe.filter((source) => terms.some((term) => `${source.title || ''} ${source.text || ''}`.includes(term)));
        if (!relevant.length) {
          json(response, 200, { answer: `当前规范库中未检索到与“${terms.join('、')}”直接匹配的可靠条文，不能用其他专业规范替代判断。请补充对应专业规范后再审核。`, sources: [], documents: [], suggestions: [], mode: 'no-applicable-standard', compliance, snapshot });
          return;
        }
        const result = await knowledge.answer(doctorContextPrompt(snapshot, question), { history: Array.isArray(body.history) ? body.history.slice(-5) : [] });
        json(response, 200, { ...result, compliance, snapshot });
        return;
      }
      if (pathname === '/api/bim-doctor/rules' && request.method === 'GET') {
        json(response, 200, { rules: await bimDoctor.getRules(), ruleSet: await bimDoctor.getRuleSetInfo() });
        return;
      }
      if (pathname === '/api/bim-doctor/rules/revisions' && request.method === 'GET') {
        json(response, 200, { revisions: await bimDoctor.listRuleRevisions() });
        return;
      }
      if (pathname === '/api/bim-doctor/rules' && request.method === 'PUT') {
        const body = await readJson(request, 5 * 1024 * 1024);
        json(response, 200, { rules: await bimDoctor.setRules(body.rules, body.meta || {}), ruleSet: await bimDoctor.getRuleSetInfo() });
        return;
      }
      if (pathname === '/api/bim-doctor/rules/rollback' && request.method === 'POST') {
        const body = await readJson(request, 64 * 1024);
        json(response, 200, { rules: await bimDoctor.rollbackRules(body.revision, body.meta || {}), ruleSet: await bimDoctor.getRuleSetInfo() });
        return;
      }
      if (pathname === '/api/bim-doctor/jobs' && request.method === 'POST') {
        const job = await bimDoctor.createJob(await readJson(request, 20 * 1024 * 1024));
        json(response, 201, bimDoctor.jobView(job));
        return;
      }
      if (pathname === '/api/bim-doctor/jobs' && request.method === 'GET') {
        json(response, 200, { jobs: await bimDoctor.listJobs(url.searchParams.get('limit')) });
        return;
      }
      const reportMatch = pathname.match(/^\/api\/bim-doctor\/jobs\/([a-f0-9-]{36})\/report$/);
      if (reportMatch && request.method === 'GET') {
        const job = await bimDoctor.readJob(reportMatch[1]);
        const report = await bimDoctor.reportCsv(reportMatch[1]);
        const projectName = String(job.project?.name || 'project')
          .replace(/[^\w\u4e00-\u9fff.-]+/g, '_')
          .slice(0, 60) || 'project';
        const filename = `bim-doctor-${projectName}-${job.project?.snapshotVersion || 1}.csv`;
        response.writeHead(200, responseHeaders({
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
        }));
        response.end(report);
        return;
      }
      const jobMatch = pathname.match(/^\/api\/bim-doctor\/jobs\/([a-f0-9-]{36})(?:\/(components|run|results))?$/);
      if (jobMatch) {
        const [, id, action] = jobMatch;
        if (request.method === 'POST' && action === 'components') {
          const body = await readJson(request, 20 * 1024 * 1024);
          json(response, 200, bimDoctor.jobView(await bimDoctor.addComponents(id, body.components)));
          return;
        }
        if (request.method === 'POST' && action === 'run') {
          json(response, 200, bimDoctor.jobView(await bimDoctor.runJob(id), false, true));
          return;
        }
        if (request.method === 'GET' && action === 'results') {
          json(response, 200, bimDoctor.jobView(await bimDoctor.readJob(id), true, true));
          return;
        }
        if (request.method === 'GET' && !action) {
          json(response, 200, bimDoctor.jobView(await bimDoctor.readJob(id)));
          return;
        }
      }
    }

    if (request.method === 'POST' && pathname === '/api/knowledge/query/stream') {
      await handleStreamingQuery(request, response);
      return;
    }

    if (request.method === 'POST' && pathname === '/api/knowledge/query') {
      if (!apiReady(request, response)) return;
      const body = await readJson(request);
      const question = validateQuestion(body);
      const session = getSession(body.sessionId || request.headers['x-knowledge-session']);
      const result = await knowledge.answer(question, { history: session.turns });
      remember(session, question, result);
      json(response, 200, { ...result, sessionId: session.id });
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(response, 405, { error: 'Method not allowed' });
      return;
    }

    await serveFile(request, response, pathname);
  } catch (error) {
    console.error(error);
    json(response, error.statusCode || 500, { error: error.statusCode ? error.message : '服务暂时不可用', detail: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`设计规范知识库：http://127.0.0.1:${port}`);
  const addresses = [];
  for (const group of Object.values(os.networkInterfaces())) {
    for (const address of group || []) {
      if (address.family === 'IPv4' && !address.internal) addresses.push(`http://${address.address}:${port}`);
    }
  }
  if (addresses.length) console.log(`局域网访问：${addresses.join('  ')}`);
});
