import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const allowedOperators = new Set(['exists', '==', '!=', '>', '>=', '<', '<=', 'between', 'contains']);
const ruleStatuses = new Set(['draft', 'reviewed', 'retired']);
const standardStatuses = new Set(['current', 'effective']);

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function text(value) {
  return String(value ?? '').trim();
}

function semanticText(value) {
  const valueText = text(value);
  return /^(默认|未知|未定义|未识别|无|N\/A|BIMBase构件)$/i.test(valueText) ? '' : valueText;
}

const IDENTITY_FIELD_LABELS = {
  canonicalName: '真实名称',
  systemType: '所属系统',
  assemblyType: '整体组件',
  semanticType: '语义类型',
  verifiedEvidence: '审核证据',
  identity: '身份信息'
};

function identityMissingText(fields) {
  return (fields || ['identity']).map((field) => IDENTITY_FIELD_LABELS[field] || field).join('、');
}

function getField(object, field) {
  return text(field).split('.').filter(Boolean).reduce((value, key) => value?.[key], object);
}

const unitFactors = new Map([
  ['mm', 1], ['毫米', 1], ['cm', 10], ['厘米', 10], ['m', 1000], ['米', 1000],
  ['mm2', 1], ['mm²', 1], ['cm2', 100], ['cm²', 100], ['m2', 1000000], ['m²', 1000000],
  ['mm3', 1], ['mm³', 1], ['cm3', 1000], ['cm³', 1000], ['m3', 1000000000], ['m³', 1000000000],
  ['kpa', 1], ['mpa', 1000], ['pa', 0.001]
]);

function numericValue(value, targetUnit = '') {
  const match = String(value ?? '').trim().match(/^([-+]?\d+(?:\.\d+)?)\s*([a-zA-Z²³%\u4e00-\u9fff]*)/);
  if (!match) return Number.NaN;
  const number = Number(match[1]);
  const actualUnit = match[2].toLowerCase();
  const target = String(targetUnit || '').toLowerCase();
  if (!actualUnit || !target || actualUnit === target || actualUnit === '%') return number;
  const from = unitFactors.get(actualUnit);
  const to = unitFactors.get(target);
  return from && to ? number * from / to : number;
}

function compare(actual, operator, expected, options = {}) {
  const tolerance = Number(options.tolerance);
  const epsilon = Number.isFinite(tolerance) ? Math.abs(tolerance) : 0;
  if (operator === 'exists') return actual !== undefined && actual !== null && actual !== '';
  if (operator === 'contains') return String(actual ?? '').includes(String(expected ?? ''));
  if (operator === 'between') {
    const number = numericValue(actual, options.unit);
    return Number.isFinite(number) && Array.isArray(expected) && number >= Number(expected[0]) - epsilon && number <= Number(expected[1]) + epsilon;
  }
  if (operator === '==' || operator === '!=') {
    const left = numericValue(actual, options.unit);
    const right = numericValue(expected, options.unit);
    const equal = Number.isFinite(left) && Number.isFinite(right)
      ? Math.abs(left - right) <= epsilon
      : String(actual ?? '') === String(expected ?? '');
    return operator === '==' ? equal : !equal;
  }
  const left = numericValue(actual, options.unit);
  const right = numericValue(expected, options.unit);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (operator === '>') return left > right - epsilon;
  if (operator === '>=') return left >= right - epsilon;
  if (operator === '<') return left < right + epsilon;
  return left <= right + epsilon;
}

function matchesValues(expected = ['*'], actual = []) {
  const patterns = expected.map((value) => text(value).toLowerCase()).filter(Boolean);
  const candidates = actual.map((value) => text(value).toLowerCase()).filter(Boolean);
  return patterns.includes('*') || patterns.some((pattern) => candidates.some((candidate) => candidate === pattern || candidate.includes(pattern)));
}

function matchesComponent(rule, component, project = {}) {
  // name/shapeName are geometric labels (e.g. "长方体"), never compliance classification.
  const checks = [
    [rule.projectTypes, [project.type]],
    [rule.disciplines, [project.discipline]],
    [rule.systemTypes, [component.systemType, component.system]],
    [rule.assemblyTypes, [component.assemblyType, component.assembly, component.category]],
    [rule.standardNames, [component.standardName]],
    [rule.componentTypes, [component.componentType, component.semanticType]]
  ].filter(([expected]) => Array.isArray(expected) && expected.length);
  return checks.length === 0 || checks.every(([expected, actual]) => matchesValues(expected, actual));
}

function complianceContext(project, component) {
  return [
    project.type,
    project.discipline,
    component.systemType,
    component.system,
    component.assemblyType,
    component.assembly,
    component.category,
    component.canonicalName,
    component.standardName,
    component.semanticType,
    component.componentType,
    component.role,
    component.material
  ].map(text).filter(Boolean).join(' ');
}

function propertyValue(component, aliases) {
  const sources = [component.rawProperties || {}, component.parameters || {}, component.extendedProperties || {}];
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const folded = new Map(Object.entries(source).map(([key, value]) => [text(key).toLowerCase(), value]));
    for (const alias of aliases) {
      const value = folded.get(text(alias).toLowerCase());
      if (value !== undefined && value !== null && text(value)) return value;
    }
  }
  return null;
}

function normalizeEvidence(entries, defaults = {}) {
  const values = Array.isArray(entries) ? entries : (entries ? [entries] : []);
  return values.map((entry, index) => {
    if (typeof entry === 'string') return { type: defaults.type || 'reference', source: text(entry) };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    return {
      type: text(entry.type || defaults.type) || 'reference',
      source: text(entry.source || entry.document || defaults.source),
      field: text(entry.field),
      value: entry.value ?? null,
      reviewedBy: text(entry.reviewedBy || defaults.reviewedBy),
      reviewedAt: text(entry.reviewedAt || defaults.reviewedAt)
    };
  }).filter((entry) => entry && (entry.source || entry.field || text(entry.value))).map((entry, index) => ({ id: `evidence-${index + 1}`, ...entry }));
}

function normalizeStandardReferences(entries, defaults = {}) {
  const values = Array.isArray(entries) ? entries : (entries ? [entries] : []);
  return values.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    return {
      code: text(entry.code || entry.standardCode),
      title: text(entry.title || entry.standardTitle),
      version: text(entry.version || entry.standardVersion),
      standardStatus: text(entry.standardStatus || entry.status),
      clause: text(entry.clause),
      page: Number(entry.page || entry.sourcePage) || null,
      path: text(entry.path || entry.sourcePath || entry.sourceDocument),
      excerpt: text(entry.excerpt || entry.sourceExcerpt),
      reviewedBy: text(entry.reviewedBy || defaults.reviewedBy),
      reviewedAt: text(entry.reviewedAt || defaults.reviewedAt)
    };
  }).filter(Boolean);
}

function verifiedStandardReference(reference) {
  return Boolean(reference && reference.code && reference.version && ['current', 'effective'].includes(reference.standardStatus) &&
    reference.clause && Number.isInteger(reference.page) && reference.page > 0 && reference.path && reference.excerpt &&
    reference.reviewedBy && reference.reviewedAt);
}

function mappingMatchesComponent(mapping, component) {
  const condition = mapping.when ?? mapping.match;
  if (!condition) return false;
  if (typeof condition === 'string') {
    const candidates = [component.entityId, component.modelId, component.elementId, component.schemaName, component.levelName,
      component.semanticType, component.componentTypeRaw, component.systemType, component.assemblyType]
      .map((value) => text(value).toLowerCase()).filter(Boolean);
    return candidates.some((value) => value === text(condition).toLowerCase() || value.includes(text(condition).toLowerCase()));
  }
  if (typeof condition !== 'object' || Array.isArray(condition)) return false;
  return Object.entries(condition).every(([field, expected]) => {
    const actual = getField(component, field) ?? component[field] ?? propertyValue(component, [field]);
    const values = Array.isArray(expected) ? expected : [expected];
    return values.some((value) => text(actual).toLowerCase() === text(value).toLowerCase());
  });
}

function normalizeComponent(component, project = {}) {
  const normalized = { ...component };
  const mappings = Array.isArray(project.componentMappings) ? project.componentMappings : [];
  const mapping = mappings.find((item) => item.enabled !== false && mappingMatchesComponent(item, normalized));
  normalized.sourceName = text(normalized.sourceName || normalized.name || normalized.shapeName) || null;
  normalized.canonicalName = semanticText(mapping?.canonicalName || normalized.canonicalName || normalized.engineeringName ||
    propertyValue(normalized, ['真实构件名称', '工程构件名称', '设备名称', '专业名称', 'CanonicalName', 'EngineeringName'])) || null;
  normalized.standardName = semanticText(mapping?.standardName || normalized.standardName ||
    propertyValue(normalized, ['规范正式名称', '规范构件名称', 'StandardName'])) || null;
  const explicitType = semanticText(normalized.semanticType || (normalized.componentType === 'BIMBase构件' ? '' : normalized.componentType) ||
    propertyValue(normalized, ['语义类型', '专业类型', '构件类型', '类别', 'Category', 'SemanticType']));
  normalized.semanticType = semanticText(mapping?.semanticType || mapping?.componentType || explicitType) || null;
  normalized.componentType = normalized.semanticType;
  normalized.systemType = semanticText(mapping?.systemType || normalized.systemType || normalized.system ||
    propertyValue(normalized, ['系统类型', '所属系统', '系统', 'SystemType'])) || null;
  normalized.assemblyType = semanticText(mapping?.assemblyType || normalized.assemblyType || normalized.assembly ||
    propertyValue(normalized, ['整体组件类型', '所属组件', '组件类型', 'AssemblyType'])) || null;
  normalized.role = semanticText(mapping?.role || normalized.role || normalized.function ||
    propertyValue(normalized, ['作用', '用途', '功能', 'Function', 'Role'])) || null;
  normalized.material = semanticText(mapping?.material || normalized.material || normalized.parameters?.material ||
    propertyValue(normalized, ['材料', '材质', 'Material'])) || null;
  const evidence = [
    ...normalizeEvidence(normalized.identityEvidence || normalized.identity?.evidence, { source: 'BIMBase' }),
    ...normalizeEvidence(mapping?.evidence, {
      type: 'reviewed-mapping', source: `工程映射 ${text(mapping?.id) || 'unnamed'}`,
      reviewedBy: mapping?.reviewedBy, reviewedAt: mapping?.reviewedAt
    })
  ];
  const standardReferences = normalizeStandardReferences(mapping?.standardReferences || normalized.standardReferences || normalized.standardMatch?.references, {
    reviewedBy: mapping?.reviewedBy || normalized.standardMatch?.reviewedBy,
    reviewedAt: mapping?.reviewedAt || normalized.standardMatch?.reviewedAt
  });
  const upstreamVerified = String(normalized.identityStatus || normalized.identity?.status || '').toLowerCase() === 'verified';
  const mappingVerified = Boolean(mapping && text(mapping.reviewedBy) && text(mapping.reviewedAt) && evidence.length);
  const completeIdentity = Boolean(normalized.canonicalName && normalized.systemType && normalized.assemblyType && normalized.semanticType);
  const partialIdentity = Boolean(normalized.canonicalName || normalized.systemType || normalized.assemblyType || normalized.semanticType);
  const identityStatus = completeIdentity && (upstreamVerified || mappingVerified) ? 'verified' : (partialIdentity ? 'partial' : 'unresolved');
  const upstreamStandardVerified = String(normalized.standardMatchStatus || normalized.standardMatch?.status || '').toLowerCase() === 'verified';
  const standardVerified = Boolean(normalized.standardName && standardReferences.some(verifiedStandardReference) && (mappingVerified || upstreamStandardVerified));
  normalized.systemPath = [normalized.systemType, normalized.assemblyType, normalized.canonicalName].filter(Boolean);
  normalized.identity = {
    status: identityStatus,
    sourceName: normalized.sourceName,
    canonicalName: normalized.canonicalName,
    systemPath: normalized.systemPath,
    evidence,
    reviewedBy: text(mapping?.reviewedBy || normalized.identity?.reviewedBy) || null,
    reviewedAt: text(mapping?.reviewedAt || normalized.identity?.reviewedAt) || null,
    missing: [
      !normalized.canonicalName && 'canonicalName', !normalized.systemType && 'systemType',
      !normalized.assemblyType && 'assemblyType', !normalized.semanticType && 'semanticType',
      !(upstreamVerified || mappingVerified) && 'verifiedEvidence'
    ].filter(Boolean)
  };
  normalized.standardMatch = {
    status: standardVerified ? 'verified' : (normalized.standardName || standardReferences.length ? 'partial' : 'unresolved'),
    standardName: normalized.standardName,
    references: standardReferences,
    reviewedBy: text(mapping?.reviewedBy || normalized.standardMatch?.reviewedBy) || null,
    reviewedAt: text(mapping?.reviewedAt || normalized.standardMatch?.reviewedAt) || null,
    missing: [
      !normalized.standardName && 'standardName',
      !standardReferences.some(verifiedStandardReference) && 'verifiedStandardReference'
    ].filter(Boolean)
  };
  normalized.classification = {
    status: identityStatus === 'verified' ? 'classified' :
      (normalized.canonicalName || normalized.semanticType || normalized.systemType || normalized.assemblyType ? 'partial' : 'unclassified'),
    source: mapping ? `project-mapping:${text(mapping.id) || 'unnamed'}` : 'bim-properties',
    shapeNameUsed: false
  };
  return normalized;
}

function groupComponents(components, field, unknownLabel) {
  const groups = new Map();
  for (const component of components) {
    const name = text(component[field]) || unknownLabel;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(component.entityId);
  }
  return [...groups.entries()].map(([name, entityIds]) => ({
    name,
    count: entityIds.length,
    entityIds: entityIds.slice(0, 30),
    truncated: entityIds.length > 30
  })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-CN'));
}

function groupModels(components) {
  const groups = new Map();
  for (const component of components) {
    const modelId = text(component.modelId) || 'unknown';
    groups.set(modelId, (groups.get(modelId) || 0) + 1);
  }
  return [...groups.entries()]
    .map(([modelId, count]) => ({ modelId: modelId === 'unknown' ? null : modelId, name: modelId === 'unknown' ? '未识别模型' : `模型 ${modelId}`, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-CN'));
}

function formatExpected(rule) {
  if (rule.operator === 'exists') return '必须提供';
  const suffix = rule.unit || '';
  const tolerance = Number(rule.tolerance);
  const toleranceText = Number.isFinite(tolerance) && tolerance > 0 ? `（容差 ±${tolerance}${suffix}）` : '';
  if (rule.operator === 'between') return `${rule.value?.[0]}～${rule.value?.[1]}${suffix}${toleranceText}`;
  return `${rule.operator} ${rule.value}${suffix}${toleranceText}`;
}

function ruleCitation(rule) {
  return {
    title: text(rule.standardTitle) || text(rule.sourceDocument) || text(rule.standardCode),
    code: text(rule.standardCode),
    version: text(rule.standardVersion),
    standardStatus: text(rule.standardStatus),
    clause: text(rule.clause),
    page: Number(rule.sourcePage),
    path: text(rule.sourcePath || rule.sourceDocument),
    excerpt: text(rule.sourceExcerpt),
    verifiedBy: text(rule.reviewedBy),
    verifiedAt: text(rule.reviewedAt)
  };
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

function uniqueSources(sources = []) {
  const values = new Map();
  for (const source of sources.flat(Infinity).filter(Boolean)) {
    const key = [source.code, source.clause, source.page, source.path, source.title].map(text).join('|');
    if (key && !values.has(key)) values.set(key, source);
  }
  return [...values.values()];
}

export class BimDoctor {
  constructor({ dataDir, rulesFile, contextFile, knowledge }) {
    this.dataDir = dataDir;
    this.rulesFile = rulesFile;
    this.contextFile = contextFile || path.join(dataDir, 'context.json');
    this.knowledge = knowledge;
  }

  async initialize() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      await fs.access(this.rulesFile);
    } catch {
      await this.setRules([]);
    }
    try {
      await fs.access(this.contextFile);
    } catch {
      await fs.writeFile(this.contextFile, JSON.stringify({ schemaVersion: 2, revision: 0, mappings: [] }, null, 2));
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

  projectProfile(job) {
    if (!job) return null;
    const components = (job.components || []).map((component) => normalizeComponent(component, job.project));
    const classified = components.filter((component) => component.classification.status === 'classified').length;
    const partial = components.filter((component) => component.classification.status === 'partial').length;
    const identityVerified = components.filter((component) => component.identity.status === 'verified').length;
    const identityPartial = components.filter((component) => component.identity.status === 'partial').length;
    const standardMatched = components.filter((component) => component.standardMatch.status === 'verified').length;
    const summary = job.summary || {};
    const complianceStatus = summary.fail > 0 ? 'FAIL'
      : summary.needIdentity > 0 ? 'NEED_IDENTITY'
        : summary.needStandard > 0 ? 'NEED_STANDARD'
          : summary.needRule > 0 ? 'NEED_RULE'
            : summary.needData > 0 ? 'NEED_DATA'
              : summary.total > 0 && summary.pass === summary.total ? 'PASS' : 'NEED_DATA';
    const citations = uniqueSources((job.results || []).flatMap((result) => [
      ...(result.sources || []), ...(result.issues || []).flatMap((issue) => issue.sources || [])
    ]));
    return {
      scope: 'project',
      project: job.project,
      snapshotVersion: job.project?.snapshotVersion || null,
      componentCount: components.length,
      modelCount: new Set(components.map((component) => text(component.modelId)).filter(Boolean)).size,
      modelGroups: groupModels(components),
      nativeGroups: Array.isArray(job.project?.nativeGroups) ? job.project.nativeGroups : [],
      systems: groupComponents(components, 'systemType', '未识别系统'),
      assemblies: groupComponents(components, 'assemblyType', '未识别整体组件'),
      standardNames: groupComponents(components, 'standardName', '未匹配规范正式名称'),
      componentTypes: groupComponents(components, 'semanticType', '未识别构件类型'),
      materials: groupComponents(components, 'material', '未识别材质'),
      dataQuality: {
        classified, partial, unclassified: components.length - classified - partial,
        identityVerified, identityPartial, identityUnresolved: components.length - identityVerified - identityPartial,
        standardMatched, standardUnmatched: components.length - standardMatched
      },
      compliance: { status: complianceStatus, summary, citations },
      citations,
      components: components.slice(0, 200).map((component) => ({
        entityId: component.entityId,
        modelId: component.modelId ?? null,
        elementId: component.elementId ?? null,
        sourceName: component.sourceName,
        canonicalName: component.canonicalName,
        standardName: component.standardName,
        systemPath: component.systemPath,
        systemType: component.systemType,
        assemblyType: component.assemblyType,
        semanticType: component.semanticType,
        role: component.role,
        material: component.material,
        schemaName: component.schemaName || null,
        className: component.componentTypeRaw || null,
        levelName: component.levelName || null,
        identity: component.identity,
        standardMatch: component.standardMatch,
        classification: component.classification
      })),
      truncated: components.length > 200
    };
  }

  async latestSnapshot(entityId = '', scope = 'auto') {
    const jobs = await this.listJobs(100);
    const bridge = await this.getBridgeState();
    if (!jobs.length) return { bridge, job: null, project: null, projectProfile: null, projectCompliance: null, component: null, result: null };
    const projectKey = (job) => text(job.project?.path || job.project?.fileName || `${job.project?.source || 'BIMBase'}:${job.project?.name || ''}`);
    const bridgeProjectName = text(bridge.project?.name);
    const bridgeProjectKey = text(bridge.project?.path || bridge.project?.fileName ||
      (bridgeProjectName && !/^(BIMBase\s*)?当前工程$/.test(bridgeProjectName) ? `BIMBase:${bridgeProjectName}` : ''));
    let projectView = jobs.find((job) => job.project?.checkScope === 'project' && (!bridgeProjectKey || projectKey(job) === bridgeProjectKey))
      || (bridgeProjectKey ? jobs.find((job) => projectKey(job) === bridgeProjectKey) : null)
      || jobs.find((job) => job.project?.checkScope === 'project') || jobs[0];
    const requestedEntity = text(entityId || (scope !== 'project' ? bridge.entityId : ''));
    let componentView = requestedEntity
      ? jobs.find((job) => job.project?.checkScope === 'component' && text(job.project?.targetEntityId) === requestedEntity)
      : jobs.find((job) => job.project?.checkScope === 'component' && projectKey(job) === projectKey(projectView));
    if (!componentView) {
      componentView = jobs.find((job) => job.project?.checkScope === 'component' && projectKey(job) === projectKey(projectView));
    }
    if (componentView && projectKey(componentView) !== projectKey(projectView)) {
      projectView = jobs.find((job) => job.project?.checkScope === 'project' && projectKey(job) === projectKey(componentView)) || componentView;
    }
    let projectJob = await this.readJob(projectView.id);
    let componentJob = componentView ? await this.readJob(componentView.id) : null;
    let selectedComponent = null;
    let selectedResult = null;
    if (componentJob) {
      selectedComponent = componentJob.components.find((component) => !requestedEntity || text(component.entityId) === requestedEntity) || componentJob.components[0] || null;
      selectedResult = selectedComponent ? componentJob.results.find((result) => text(result.entityId) === text(selectedComponent.entityId)) || null : null;
    }
    if (!selectedComponent && requestedEntity) {
      selectedComponent = projectJob.components.find((component) => text(component.entityId) === requestedEntity) || null;
      selectedResult = selectedComponent ? projectJob.results.find((result) => text(result.entityId) === requestedEntity) || null : null;
    }
    const activeJob = scope === 'project' || !componentJob ? projectJob : componentJob;
    const profile = this.projectProfile(projectJob);
    return {
      bridge,
      job: this.jobView(activeJob, false, false),
      project: projectJob.project,
      projectProfile: profile,
      projectCompliance: profile?.compliance || null,
      component: selectedComponent ? normalizeComponent(selectedComponent, projectJob.project) : null,
      result: selectedResult
    };
  }

  async nextSnapshotVersion(project) {
    const baseIdentity = text(project.path || project.fileName || `${project.source || 'BIMBase'}:${project.name || ''}`);
    const scope = text(project.checkScope) || 'project';
    const target = scope === 'component' ? text(project.targetEntityId) : '';
    const identity = `${baseIdentity}|${scope}|${target}`;
    const jobs = await this.listJobs(100);
    const versions = jobs.filter((job) => {
      const current = job.project || {};
      const currentBase = text(current.path || current.fileName || `${current.source || 'BIMBase'}:${current.name || ''}`);
      const currentScope = text(current.checkScope) || 'project';
      const currentTarget = currentScope === 'component' ? text(current.targetEntityId) : '';
      return `${currentBase}|${currentScope}|${currentTarget}` === identity;
    }).map((job) => Number(job.project?.snapshotVersion) || 0);
    return (versions.length ? Math.max(...versions) : 0) + 1;
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
    return (await this.readRulesDocument()).rules;
  }

  async readRulesDocument() {
    const payload = JSON.parse(await fs.readFile(this.rulesFile, 'utf8'));
    return {
      schemaVersion: Number(payload.schemaVersion) || 1,
      revision: Number(payload.revision) || 0,
      updatedAt: payload.updatedAt || null,
      rules: Array.isArray(payload) ? payload : (payload.rules || [])
    };
  }

  async getRuleSetInfo() {
    const document = await this.readRulesDocument();
    return {
      schemaVersion: document.schemaVersion,
      revision: document.revision,
      updatedAt: document.updatedAt,
      ruleCount: document.rules.filter((rule) => rule.enabled !== false && rule.status === 'reviewed').length,
      draftCount: document.rules.filter((rule) => rule.status === 'draft').length
    };
  }

  async getContextMappings() {
    try {
      const payload = JSON.parse(await fs.readFile(this.contextFile, 'utf8'));
      return { schemaVersion: Number(payload.schemaVersion) || 3, revision: Number(payload.revision) || 0, updatedAt: payload.updatedAt || null, mappings: payload.mappings || [] };
    } catch { return { schemaVersion: 3, revision: 0, updatedAt: null, mappings: [] }; }
  }

  async setContextMappings(mappings, meta = {}) {
    if (!Array.isArray(mappings)) throw httpError('mappings 必须是数组');
    const current = await this.getContextMappings();
    const normalized = mappings.map((mapping, index) => {
      if (!text(mapping.match)) throw httpError(`第 ${index + 1} 条工程映射缺少 match`);
      if (mapping.componentMappings !== undefined && !Array.isArray(mapping.componentMappings)) {
        throw httpError(`第 ${index + 1} 条工程映射的 componentMappings 必须是数组`);
      }
      const componentMappings = (mapping.componentMappings || []).map((item, componentIndex) => {
        if (!item || (!item.when && !item.match)) throw httpError(`第 ${index + 1} 条工程映射中的第 ${componentIndex + 1} 条构件映射缺少 when`);
        if (!['canonicalName', 'semanticType', 'componentType', 'systemType', 'assemblyType', 'role', 'material'].some((field) => text(item[field]))) {
          throw httpError(`第 ${index + 1} 条工程映射中的第 ${componentIndex + 1} 条构件映射缺少分类结果`);
        }
        if (!text(item.reviewedBy) || !text(item.reviewedAt)) {
          throw httpError(`第 ${index + 1} 条工程映射中的第 ${componentIndex + 1} 条构件映射缺少 reviewedBy/reviewedAt`);
        }
        if (!Array.isArray(item.evidence) || !normalizeEvidence(item.evidence).length) {
          throw httpError(`第 ${index + 1} 条工程映射中的第 ${componentIndex + 1} 条构件映射缺少 evidence`);
        }
        const when = item.when;
        const stableLocator = when && typeof when === 'object' && !Array.isArray(when) &&
          (text(when.entityId) || (text(when.modelId) && text(when.elementId)));
        if (!stableLocator) {
          throw httpError(`第 ${index + 1} 条工程映射中的第 ${componentIndex + 1} 条构件映射必须使用 entityId 或 modelId+elementId 独立定位`);
        }
        const standardReferences = normalizeStandardReferences(item.standardReferences, { reviewedBy: item.reviewedBy, reviewedAt: item.reviewedAt });
        if (!text(item.standardName) || !standardReferences.some(verifiedStandardReference)) {
          throw httpError(`第 ${index + 1} 条工程映射中的第 ${componentIndex + 1} 条构件映射缺少规范正式名称或完整规范依据`);
        }
        return { ...item, enabled: item.enabled !== false, id: text(item.id) || `component-${componentIndex + 1}` };
      });
      return { ...mapping, enabled: mapping.enabled !== false, id: text(mapping.id) || `context-${index + 1}`, match: text(mapping.match), componentMappings };
    });
    const document = { schemaVersion: 3, revision: current.revision + 1, updatedAt: new Date().toISOString(), mappings: normalized };
    await fs.writeFile(`${this.contextFile}.tmp`, JSON.stringify(document, null, 2));
    await fs.rename(`${this.contextFile}.tmp`, this.contextFile);
    await fs.appendFile(path.join(this.dataDir, 'rule-audit.jsonl'), `${JSON.stringify({ action: 'context-mapping', revision: document.revision, updatedAt: document.updatedAt, actor: text(meta.actor) || 'system', reason: text(meta.reason), mappingCount: normalized.length })}\n`);
    return document;
  }

  async resolveProjectContext(project) {
    const current = await this.getContextMappings();
    const identity = text(project.path || project.fileName || project.name).toLowerCase();
    const matches = current.mappings.filter((mapping) => mapping.enabled !== false && identity.includes(text(mapping.match).toLowerCase()));
    return matches.reduce((resolved, mapping) => {
      const patch = Object.fromEntries(Object.entries(mapping).filter(([key]) => !['id', 'match', 'enabled'].includes(key)));
      if (patch.projectType && !patch.type) patch.type = patch.projectType;
      return { ...resolved, ...patch };
    }, { ...project });
  }

  async setRules(rules, meta = {}) {
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
      const status = text(rule.status || (rule.enabled === false ? 'draft' : ''));
      if (!ruleStatuses.has(status)) throw httpError(`第 ${index + 1} 条规则的 status 必须是 draft/reviewed/retired`);
      if (rule.enabled !== false && status !== 'reviewed') throw httpError(`第 ${index + 1} 条启用规则必须先标记为 reviewed`);
      if (rule.enabled !== false && (!text(rule.standardCode) || !text(rule.clause))) {
        throw httpError(`第 ${index + 1} 条启用规则必须填写 standardCode 和 clause`);
      }
      if (rule.enabled !== false && (!text(rule.unit) || !text(rule.reviewedBy) || !text(rule.version))) {
        throw httpError(`第 ${index + 1} 条启用规则必须填写 unit、reviewedBy 和 version`);
      }
      if (rule.enabled !== false && (!text(rule.reviewedAt) || !text(rule.standardVersion))) {
        throw httpError(`第 ${index + 1} 条启用规则必须填写 reviewedAt 和 standardVersion`);
      }
      if (rule.enabled !== false && !standardStatuses.has(text(rule.standardStatus))) {
        throw httpError(`第 ${index + 1} 条启用规则的 standardStatus 必须是 current/effective`);
      }
      if (rule.enabled !== false && (!text(rule.sourceDocument) || !Number.isInteger(Number(rule.sourcePage)) || Number(rule.sourcePage) < 1 || !text(rule.sourceExcerpt))) {
        throw httpError(`第 ${index + 1} 条启用规则必须填写 sourceDocument、sourcePage 和 sourceExcerpt`);
      }
      if (rule.enabled !== false && operator !== 'exists' && (rule.value === undefined || rule.value === null || rule.value === '')) {
        throw httpError(`第 ${index + 1} 条启用规则必须填写 value`);
      }
      const scopeFields = ['projectTypes', 'disciplines', 'systemTypes', 'assemblyTypes', 'standardNames', 'componentTypes'];
      if (rule.enabled !== false && !scopeFields.some((field) => Array.isArray(rule[field]) && rule[field].some((value) => text(value)))) {
        throw httpError(`第 ${index + 1} 条启用规则必须至少指定一个工程/系统/组件语义范围`);
      }
      return {
        enabled: rule.enabled !== false,
        severity: rule.severity || 'major',
        status,
        componentTypes: rule.componentTypes || [],
        ...rule,
        id: text(rule.id),
        field: text(rule.field),
        operator,
        status
      };
    });
    let previous;
    try { previous = await this.readRulesDocument(); } catch { previous = { revision: 0 }; }
    const updatedAt = new Date().toISOString();
    const document = { schemaVersion: 2, revision: previous.revision + 1, updatedAt, rules: normalized };
    const revisionsDir = path.join(this.dataDir, 'rule-revisions');
    await fs.mkdir(revisionsDir, { recursive: true });
    if (previous.revision > 0) await fs.writeFile(path.join(revisionsDir, `${previous.revision}.json`), JSON.stringify(previous, null, 2));
    await fs.writeFile(`${this.rulesFile}.tmp`, JSON.stringify(document, null, 2));
    await fs.rename(`${this.rulesFile}.tmp`, this.rulesFile);
    await fs.appendFile(path.join(this.dataDir, 'rule-audit.jsonl'), `${JSON.stringify({
      action: 'replace', revision: document.revision, updatedAt,
      actor: text(meta.actor) || 'system', reason: text(meta.reason), ruleCount: normalized.length
    })}\n`);
    return normalized;
  }

  async listRuleRevisions() {
    const revisionsDir = path.join(this.dataDir, 'rule-revisions');
    let names = [];
    try { names = await fs.readdir(revisionsDir); } catch { return []; }
    return (await Promise.all(names.filter((name) => /^\d+\.json$/.test(name)).map(async (name) => {
      try {
        const document = JSON.parse(await fs.readFile(path.join(revisionsDir, name), 'utf8'));
        return { revision: document.revision, updatedAt: document.updatedAt, ruleCount: document.rules?.length || 0 };
      } catch { return null; }
    }))).filter(Boolean).sort((left, right) => right.revision - left.revision);
  }

  async rollbackRules(revision, meta = {}) {
    const value = Number(revision);
    if (!Number.isInteger(value) || value < 1) throw httpError('revision 无效');
    const file = path.join(this.dataDir, 'rule-revisions', `${value}.json`);
    let document;
    try { document = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw httpError('规则版本不存在', 404); }
    return this.setRules(document.rules || [], { ...meta, reason: meta.reason || `rollback to revision ${value}` });
  }

  async createJob(body = {}) {
    const project = await this.resolveProjectContext(body.project || {});
    if (!text(project.name)) throw httpError('project.name 不能为空');
    const components = Array.isArray(body.components) ? body.components : [];
    if (!text(project.checkScope) && components.length) {
      project.checkScope = components.length === 1 ? 'component' : 'project';
    }
    if (project.checkScope === 'component' && !text(project.targetEntityId) && components.length === 1) {
      project.targetEntityId = text(components[0].entityId);
    }
    project.snapshotVersion = await this.nextSnapshotVersion(project);
    const now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      status: 'collecting',
      project: { source: 'BIMBase', sourceVersion: '2025', ...project },
      createdAt: now,
      updatedAt: now,
      components: [],
      results: [],
      summary: { total: 0, pass: 0, fail: 0, warning: 0, needIdentity: 0, needStandard: 0, needRule: 0, needData: 0, error: 0 }
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
      byId.set(entityId, normalizeComponent({ ...component, entityId }, job.project));
    }
    job.components = [...byId.values()];
    if (!text(job.project?.checkScope) && components.length) {
      job.project.checkScope = job.components.length === 1 ? 'component' : 'project';
      if (job.project.checkScope === 'component') job.project.targetEntityId = text(job.components[0].entityId);
    }
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
    if (component.identity?.status !== 'verified') {
      return {
        entityId: component.entityId,
        status: 'NEED_IDENTITY',
        summary: `真实构件身份尚未核实，缺少：${identityMissingText(component.identity?.missing)}。`,
        issues: [],
        sources: [],
        identity: component.identity || null
      };
    }
    if (component.standardMatch?.status !== 'verified') {
      const context = complianceContext(project, component);
      const sources = context ? this.searchSources(`${context} 规范正式名称 构件组成`, sourceCache) : [];
      return {
        entityId: component.entityId,
        status: 'NEED_STANDARD',
        summary: `尚未核实该构件与规范正式名称的对应关系，缺少：${(component.standardMatch?.missing || ['standardName']).map((field) => ({ standardName: '规范正式名称', verifiedStandardReference: '完整规范依据' }[field] || field)).join('、')}。`,
        issues: [],
        sources,
        identity: component.identity || null,
        standardMatch: component.standardMatch || null
      };
    }
    const applicable = rules.filter((rule) => rule.enabled !== false && matchesComponent(rule, component, project));
    if (!applicable.length) {
      const context = complianceContext(project, component);
      const sources = context ? this.searchSources(`${context} 适用规范 设计要求`, sourceCache) : [];
      return {
        entityId: component.entityId,
        status: sources.length ? 'NEED_RULE' : 'NEED_STANDARD',
        summary: sources.length
          ? '已找到与真实构件身份相关的候选规范，但尚无经审核的机器判定规则。'
          : '规范库中尚未找到与该真实构件身份直接匹配的可靠条文，需要补充或审核适用规范。',
        issues: [],
        sources
      };
    }

    const issues = applicable.map((rule) => {
      const actual = getField(component, rule.field);
      const missing = actual === undefined || actual === null || actual === '';
      const passed = !missing && compare(actual, rule.operator, rule.value, { unit: rule.unit, tolerance: rule.tolerance });
      const query = rule.query || `${rule.standardCode || ''} ${rule.clause || ''} ${rule.title || complianceContext(project, component)}`;
      const citation = ruleCitation(rule);
      const retrieved = this.searchSources(query, sourceCache).filter((source) => !citation.code || text(source.code).includes(citation.code) || citation.code.includes(text(source.code)));
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
        sources: uniqueSources([citation, ...retrieved])
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
      sources: uniqueSources(issues.flatMap((issue) => issue.sources || [])),
      identity: component.identity,
      standardMatch: component.standardMatch
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
      needIdentity: count('NEED_IDENTITY'),
      needStandard: count('NEED_STANDARD'),
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

  async reportCsv(id) {
    const job = await this.readJob(id);
    const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const components = new Map((job.components || []).map((component) => [text(component.entityId), normalizeComponent(component, job.project)]));
    const rows = [['项目', '快照版本', '构件ID', '原始名称', '真实专业名称', '规范正式名称', '系统路径', '身份状态', '规范对应状态', '结论', '规则ID', '检查项', '字段', '实际值', '期望值', '规范编号', '规范版本', '条文号', 'PDF页码', '原文摘录']];
    for (const result of job.results || []) {
      const component = components.get(text(result.entityId)) || {};
      const issues = result.issues?.length ? result.issues : [{}];
      for (const issue of issues) {
        const citation = issue.sources?.[0] || result.sources?.[0] || {};
        rows.push([
          job.project?.name, job.project?.snapshotVersion, result.entityId, component.sourceName, component.canonicalName, component.standardName,
          (component.systemPath || []).join(' / '), component.identity?.status, component.standardMatch?.status, result.status,
          issue.ruleId, issue.title, issue.field, issue.actual, issue.expected,
          issue.standardCode || citation.code, citation.version, issue.clause || citation.clause,
          citation.page, citation.excerpt
        ]);
      }
    }
    return `\uFEFF${rows.map((row) => row.map(escape).join(',')).join('\r\n')}\r\n`;
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
      const baseIdentity = text(project.path || project.fileName || `${project.source || 'BIMBase'}:${project.name || job.id}`);
      const scope = text(project.checkScope) || (Array.isArray(job.components) && job.components.length === 1 ? 'component' : 'project');
      const target = scope === 'component'
        ? text(project.targetEntityId || job.components?.[0]?.entityId)
        : '';
      const identity = `${baseIdentity}|${scope}|${target}`;
      if (!latestByProject.has(identity)) latestByProject.set(identity, job);
    }
    return [...latestByProject.values()]
      .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)))
      .map((job) => this.jobView(job));
  }

  jobView(job, includeComponents = false, includeResults = false) {
    const view = { ...job };
    const project = { ...(job.project || {}) };
    if (!text(project.checkScope)) {
      project.checkScope = Array.isArray(job.components) && job.components.length === 1 ? 'component' : 'project';
    }
    if (project.checkScope === 'component' && !text(project.targetEntityId) && job.components?.length === 1) {
      project.targetEntityId = text(job.components[0].entityId);
    }
    view.project = project;
    if (!includeComponents) delete view.components;
    if (!includeResults) delete view.results;
    return view;
  }

  componentView(component, project = {}) {
    return component ? normalizeComponent(component, project) : null;
  }
}

export { compare, getField };
