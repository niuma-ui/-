import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const allowedOperators = new Set(['exists', '==', '!=', '>', '>=', '<', '<=', 'between', 'contains']);

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function text(value) {
  return String(value ?? '').trim();
}

function getField(object, field) {
  return text(field).split('.').filter(Boolean).reduce((value, key) => value?.[key], object);
}

function compare(actual, operator, expected) {
  if (operator === 'exists') return actual !== undefined && actual !== null && actual !== '';
  if (operator === 'contains') return String(actual ?? '').includes(String(expected ?? ''));
  if (operator === 'between') {
    const number = Number(actual);
    return Number.isFinite(number) && Array.isArray(expected) && number >= Number(expected[0]) && number <= Number(expected[1]);
  }
  if (operator === '==' || operator === '!=') {
    const equal = String(actual ?? '') === String(expected ?? '');
    return operator === '==' ? equal : !equal;
  }
  const left = Number(actual);
  const right = Number(expected);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (operator === '>') return left > right;
  if (operator === '>=') return left >= right;
  if (operator === '<') return left < right;
  return left <= right;
}

function matchesValues(expected = ['*'], actual = []) {
  const patterns = expected.map((value) => text(value).toLowerCase()).filter(Boolean);
  const candidates = actual.map((value) => text(value).toLowerCase()).filter(Boolean);
  return patterns.includes('*') || patterns.some((pattern) => candidates.some((candidate) => candidate === pattern || candidate.includes(pattern)));
}

function matchesComponent(rule, component, project = {}) {
  // name/shapeName are geometric labels (e.g. "长方体"), never compliance classification.
  const checks = [
    [rule.projectTypes, [project.type, project.name]],
    [rule.disciplines, [project.discipline]],
    [rule.systemTypes, [component.systemType, component.system]],
    [rule.assemblyTypes, [component.assemblyType, component.assembly, component.category]],
    [rule.componentTypes, [component.componentType, component.componentTypeRaw, component.semanticType]]
  ].filter(([expected]) => Array.isArray(expected) && expected.length);
  return checks.length === 0 || checks.every(([expected, actual]) => matchesValues(expected, actual));
}

function complianceContext(project, component) {
  return [
    project.type,
    project.discipline,
    project.name,
    component.systemType,
    component.system,
    component.assemblyType,
    component.assembly,
    component.category,
    component.semanticType,
    component.componentType,
    component.componentTypeRaw
  ].map(text).filter(Boolean).join(' ');
}

function formatExpected(rule) {
  if (rule.operator === 'exists') return '必须提供';
  if (rule.operator === 'between') return `${rule.value?.[0]}～${rule.value?.[1]}${rule.unit || ''}`;
  return `${rule.operator} ${rule.value}${rule.unit || ''}`;
}

function sourceView(result) {
  return {
    title: result.title,
    code: result.code,
    page: result.page,
    path: result.path,
    excerpt: text(result.text).replace(/\s+/g, ' ').slice(0, 280)
  };
}

export class BimDoctor {
  constructor({ dataDir, rulesFile, knowledge }) {
    this.dataDir = dataDir;
    this.rulesFile = rulesFile;
    this.knowledge = knowledge;
  }

  async initialize() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      await fs.access(this.rulesFile);
    } catch {
      await this.setRules([]);
    }
  }

  async updateBridgeState(state) {
    const target = path.join(this.dataDir, 'bridge-state.json');
    await fs.writeFile(`${target}.tmp`, JSON.stringify({ ...state, lastSeenAt: new Date().toISOString() }, null, 2));
    await fs.rename(`${target}.tmp`, target);
    return this.getBridgeState();
  }

  async getBridgeState() {
    try {
      const state = JSON.parse(await fs.readFile(path.join(this.dataDir, 'bridge-state.json'), 'utf8'));
      return { ...state, online: Date.now() - Date.parse(state.lastSeenAt || 0) < 15000 };
    } catch {
      return { online: false, lastSeenAt: null };
    }
  }

  async latestSnapshot(entityId = '') {
    const jobs = await this.listJobs(1);
    if (!jobs.length) return { bridge: await this.getBridgeState(), job: null, project: null, component: null, result: null };
    const job = await this.readJob(jobs[0].id);
    const index = text(entityId) ? job.components.findIndex((component) => text(component.entityId) === text(entityId)) : 0;
    const selectedComponent = index >= 0 ? job.components[index] : null;
    const selectedResult = selectedComponent ? job.results.find((result) => text(result.entityId) === text(selectedComponent.entityId)) || null : null;
    return {
      bridge: await this.getBridgeState(),
      job: this.jobView(job, false, false),
      project: job.project,
      component: selectedComponent,
      result: selectedResult
    };
  }

  jobPath(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw httpError('任务 ID 无效');
    return path.join(this.dataDir, `${id}.json`);
  }

  async readJob(id) {
    try {
      return JSON.parse(await fs.readFile(this.jobPath(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw httpError('检查任务不存在', 404);
      throw error;
    }
  }

  async writeJob(job) {
    const target = this.jobPath(job.id);
    await fs.writeFile(`${target}.tmp`, JSON.stringify(job, null, 2));
    await fs.rename(`${target}.tmp`, target);
  }

  async getRules() {
    const payload = JSON.parse(await fs.readFile(this.rulesFile, 'utf8'));
    return Array.isArray(payload) ? payload : payload.rules || [];
  }

  async setRules(rules) {
    if (!Array.isArray(rules)) throw httpError('rules 必须是数组');
    const normalized = rules.map((rule, index) => {
      const operator = text(rule.operator);
      if (!text(rule.id) || !text(rule.field) || !allowedOperators.has(operator)) {
        throw httpError(`第 ${index + 1} 条规则缺少 id/field 或 operator 不受支持`);
      }
      if (rule.componentTypes !== undefined && !Array.isArray(rule.componentTypes)) {
        throw httpError(`第 ${index + 1} 条规则的 componentTypes 必须是数组`);
      }
      if (operator === 'between' && (!Array.isArray(rule.value) || rule.value.length !== 2)) {
        throw httpError(`第 ${index + 1} 条 between 规则必须提供两个边界值`);
      }
      return {
        enabled: rule.enabled !== false,
        severity: rule.severity || 'major',
        componentTypes: rule.componentTypes || ['*'],
        ...rule,
        id: text(rule.id),
        field: text(rule.field),
        operator
      };
    });
    await fs.writeFile(`${this.rulesFile}.tmp`, JSON.stringify({ rules: normalized }, null, 2));
    await fs.rename(`${this.rulesFile}.tmp`, this.rulesFile);
    return normalized;
  }

  async createJob(body = {}) {
    const project = body.project || {};
    if (!text(project.name)) throw httpError('project.name 不能为空');
    const components = Array.isArray(body.components) ? body.components : [];
    const now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      status: 'collecting',
      project: { source: 'BIMBase', sourceVersion: '2025', ...project },
      createdAt: now,
      updatedAt: now,
      components: [],
      results: [],
      summary: { total: 0, pass: 0, fail: 0, warning: 0, needRule: 0, needData: 0, error: 0 }
    };
    await this.addComponentsToJob(job, components);
    await this.writeJob(job);
    return job;
  }

  async addComponents(id, components) {
    const job = await this.readJob(id);
    await this.addComponentsToJob(job, components);
    await this.writeJob(job);
    return job;
  }

  async addComponentsToJob(job, components) {
    if (!Array.isArray(components) || components.length > 5000) throw httpError('components 必须是最多 5000 项的数组');
    const byId = new Map(job.components.map((component) => [text(component.entityId), component]));
    for (const component of components) {
      const entityId = text(component.entityId);
      if (!entityId) throw httpError('构件缺少 entityId');
      byId.set(entityId, { ...component, entityId });
    }
    job.components = [...byId.values()];
    job.updatedAt = new Date().toISOString();
    job.summary.total = job.components.length;
  }

  searchSources(query, cache) {
    const key = text(query);
    if (!key || !this.knowledge?.ready) return [];
    if (!cache.has(key)) cache.set(key, this.knowledge.search(key, 3).map(sourceView));
    return cache.get(key);
  }

  evaluateComponent(component, rules, sourceCache, project = {}) {
    const applicable = rules.filter((rule) => rule.enabled !== false && matchesComponent(rule, component, project));
    if (!applicable.length) {
      const query = `${complianceContext(project, component) || '工程整体 构件系统'} 适用规范 设计要求`;
      return {
        entityId: component.entityId,
        status: 'NEED_RULE',
        summary: '已检索候选规范，但尚无经审核的机器判定规则。',
        issues: [],
        sources: this.searchSources(query, sourceCache)
      };
    }

    const issues = applicable.map((rule) => {
      const actual = getField(component, rule.field);
      const missing = actual === undefined || actual === null || actual === '';
      const passed = !missing && compare(actual, rule.operator, rule.value);
      const query = rule.query || `${rule.standardCode || ''} ${rule.clause || ''} ${rule.title || complianceContext(project, component)}`;
      return {
        ruleId: rule.id,
        status: missing ? 'NEED_DATA' : (passed ? 'PASS' : 'FAIL'),
        severity: rule.severity,
        title: rule.title || rule.id,
        field: rule.field,
        actual: missing ? null : actual,
        expected: formatExpected(rule),
        unit: rule.unit || null,
        standardCode: rule.standardCode || null,
        clause: rule.clause || null,
        suggestion: passed ? null : (rule.suggestion || `请核验并调整 ${rule.field}`),
        sources: this.searchSources(query, sourceCache)
      };
    });
    const status = issues.some((issue) => issue.status === 'FAIL')
      ? 'FAIL'
      : issues.some((issue) => issue.status === 'NEED_DATA') ? 'NEED_DATA' : 'PASS';
    return {
      entityId: component.entityId,
      status,
      summary: status === 'PASS' ? '已启用规则全部通过。' : `${issues.filter((issue) => issue.status !== 'PASS').length} 项需要处理。`,
      issues,
      sources: []
    };
  }

  async runJob(id) {
    const job = await this.readJob(id);
    const rules = await this.getRules();
    job.status = 'running';
    job.updatedAt = new Date().toISOString();
    await this.writeJob(job);
    const sourceCache = new Map();
    job.results = job.components.map((component) => {
      try {
        return this.evaluateComponent(component, rules, sourceCache, job.project);
      } catch (error) {
        return { entityId: component.entityId, status: 'ERROR', summary: error.message, issues: [], sources: [] };
      }
    });
    const count = (status) => job.results.filter((result) => result.status === status).length;
    job.summary = {
      total: job.results.length,
      pass: count('PASS'),
      fail: count('FAIL'),
      warning: count('WARNING'),
      needRule: count('NEED_RULE'),
      needData: count('NEED_DATA'),
      error: count('ERROR')
    };
    job.status = 'completed';
    job.ruleCount = rules.filter((rule) => rule.enabled !== false).length;
    job.updatedAt = new Date().toISOString();
    await this.writeJob(job);
    return job;
  }

  async listJobs(limit = 20) {
    const names = await fs.readdir(this.dataDir);
    const jobs = [];
    for (const name of names) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        jobs.push(JSON.parse(await fs.readFile(path.join(this.dataDir, name), 'utf8')));
      } catch {
        // Skip incomplete files left by an interrupted write.
      }
    }
    const latestByProject = new Map();
    for (const job of jobs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))) {
      const project = job.project || {};
      const identity = text(project.path || project.fileName || `${project.source || 'BIMBase'}:${project.name || job.id}`);
      if (!latestByProject.has(identity)) latestByProject.set(identity, job);
    }
    return [...latestByProject.values()]
      .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)))
      .map((job) => this.jobView(job));
  }

  jobView(job, includeComponents = false, includeResults = false) {
    const view = { ...job };
    if (!includeComponents) delete view.components;
    if (!includeResults) delete view.results;
    return view;
  }
}

export { compare, getField };
