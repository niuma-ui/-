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
    if (snapshot && snapshot.result && /(是否|符合|合规|达标|满足.*规范|合不合)/.test(question)) {
      const compliance = { status: snapshot.result.status, summary: snapshot.result.summary, issues: snapshot.result.issues || [] };
      const answer = complianceAnswer(snapshot);
      await Promise.resolve(writeEvent('meta', { sources: snapshot.result.sources || [], documents: [], suggestions: [], resolvedQuestion: question }));
      await Promise.resolve(writeEvent('delta', { delta: answer }));
      remember(session, question, { answer, sources: snapshot.result.sources || [], documents: [], suggestions: [], mode: 'rule-engine', resolvedQuestion: question, compliance });
      writeEvent('done', { sessionId: session.id, mode: 'rule-engine', model: null, warning: null, sources: snapshot.result.sources || [], documents: [], suggestions: [], resolvedQuestion: question, compliance });
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

function doctorContextPrompt(snapshot, question) {
  const project = snapshot.project || {};
  const component = snapshot.component || {};
  const result = snapshot.result || {};
  const parameters = Object.entries(component.parameters || {}).map(([key, value]) => `${key}=${value}`).join('，');
  const issues = (result.issues || []).map((issue) => `${issue.title || issue.ruleId}: 实际${issue.actual ?? '缺失'}，预期${issue.expected || ''}`).join('；');
  return [
    `BIMBase实时项目上下文：项目=${project.name || '未知'}，工程类型=${project.type || '未分类'}，专业=${project.discipline || '未填写'}，系统=${component.systemType || component.system || '未识别'}，整体组件=${component.assemblyType || component.assembly || '未识别'}`,
    `当前构件：entityId=${component.entityId || '未选中'}，形状名称=${component.shapeName || component.name || '未知'}，语义类型=${component.semanticType || component.componentType || '未识别'}，参数=${parameters || '无'}`,
    `机器规则结论：${result.status || 'NEED_RULE'}；${result.summary || '尚无已审核机器规则'}${issues ? `；问题=${issues}` : ''}`,
    `用户问题：${question}`,
    '请只依据检索到的规范正文回答；不要把形状名称当作规范类别。涉及是否合规时，先明确机器规则状态；NEED_RULE/NEED_DATA 不得回答为合格。'
  ].join('\n');
}

function doctorContextTerms(snapshot) {
  const project = snapshot.project || {};
  const component = snapshot.component || {};
  return [project.type, project.discipline, project.name, component.systemType, component.system, component.assemblyType, component.assembly, component.semanticType, component.componentType]
    .map((value) => String(value || '').trim())
    .filter((value) => value.length >= 2 && !/^(BIMBase|当前工程|未知|未分类|未填写|未识别)/.test(value));
}

function complianceAnswer(snapshot) {
  const result = snapshot.result || {};
  if (result.status === 'PASS') return '基于当前已审核的机器规则，本次检查通过。仍应结合完整设计工况和规范原页进行最终复核。';
  if (result.status === 'FAIL') return `本次检查不符合已审核规则：${(result.issues || []).filter((issue) => issue.status === 'FAIL').map((issue) => `${issue.title || issue.ruleId}，实际 ${issue.actual}，要求 ${issue.expected}`).join('；')}`;
  if (result.status === 'NEED_DATA') return '当前缺少规则所需的项目或构件参数，无法判定是否合格。请先补齐结果中标记为 NEED_DATA 的字段。';
  return '当前没有适用于该项目/整体组件的已审核机器规则，因此不能判断为合格或不合格。系统只能提供候选规范，待确认适用标准和条文后才能形成准确结论。';
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
        json(response, 200, await bimDoctor.latestSnapshot(url.searchParams.get('entityId') || ''));
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
          const component = (job.components || []).find((item) => String(item.entityId) === String(body.entityId || '')) || job.components?.[0] || null;
          return { bridge: await bimDoctor.getBridgeState(), job: bimDoctor.jobView(job), project: job.project, component, result };
        }) : await bimDoctor.latestSnapshot(body.entityId || '');
        const compliance = snapshot.result ? { status: snapshot.result.status, summary: snapshot.result.summary, issues: snapshot.result.issues || [] } : { status: 'NEED_RULE', summary: '暂无项目检查结果', issues: [] };
        if (/(是否|符合|合规|达标|满足.*规范|合不合)/.test(question)) {
          json(response, 200, { answer: complianceAnswer(snapshot), sources: snapshot.result?.sources || [], documents: [], suggestions: [], mode: 'rule-engine', compliance, snapshot });
          return;
        }
        const terms = doctorContextTerms(snapshot);
        if (!terms.length) {
          json(response, 200, { answer: '尚未识别项目类型、专业、系统或整体组件，无法准确定位适用规范。请先通过实时桥接取得工程和组件语义；构件形状名称不作为规范分类依据。', sources: [], documents: [], suggestions: [], mode: 'context-required', compliance, snapshot });
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
          json(response, 200, bimDoctor.jobView(await bimDoctor.readJob(id), false, true));
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
