import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BimDoctor, compare } from '../bim-doctor.mjs';

assert.equal(compare('100cm', '>=', 1000, { unit: 'mm' }), true);
assert.equal(compare(99.5, '>=', 100, { tolerance: 0.5 }), true);

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bim-doctor-'));
const doctor = new BimDoctor({
  dataDir: path.join(root, 'jobs'),
  rulesFile: path.join(root, 'rules.json'),
  knowledge: {
    ready: true,
    search: () => [{ title: '测试规范', code: 'TEST-1', page: 3, path: 'test.pdf', text: '测试条文正文' }]
  }
});

await doctor.initialize();
await assert.rejects(() => doctor.setContextMappings([{
  id: 'INVALID-MAP', match: 'invalid', componentMappings: [{ id: 'INVALID-COMPONENT', when: { modelId: '1' }, canonicalName: '未审核名称' }]
}]), /reviewedBy\/reviewedAt/);
await assert.rejects(() => doctor.setContextMappings([{
  id: 'BROAD-MAP', match: 'broad', componentMappings: [{
    id: 'BROAD-COMPONENT', when: { modelId: '1' }, canonicalName: '测试构件', standardName: '测试构件', semanticType: 'test', systemType: '测试系统', assemblyType: '测试组件',
    reviewedBy: 'test', reviewedAt: '2026-08-07T00:00:00Z', evidence: ['测试设备表'],
    standardReferences: [{ standardCode: 'TEST-1', standardVersion: '2026', standardStatus: 'current', clause: '1.1', sourceDocument: 'test.pdf', sourcePage: 1, sourceExcerpt: '测试构件定义。' }]
  }]
}]), /独立定位/);
await doctor.setContextMappings([{
  id: 'MAP-1', match: 'mapped-project', projectType: '水工建筑', discipline: '结构',
  componentMappings: [{
    id: 'MODEL-10', when: { modelId: '10', elementId: '1' }, systemType: '输水系统', assemblyType: '闸室组件',
    canonicalName: '检修闸门 1 号', semanticType: '检修闸门', role: '检修隔断', material: '钢',
    standardName: '检修闸门',
    reviewedBy: 'test-reviewer', reviewedAt: '2026-08-07T00:00:00Z',
    evidence: [{ type: 'design-document', source: '设备表', field: '设备编号', value: 'GATE-001' }],
    standardReferences: [{ standardCode: 'TEST-1', standardVersion: '2026', standardStatus: 'current', clause: '2.1', sourceDocument: 'test.pdf', sourcePage: 3, sourceExcerpt: '检修闸门定义。' }]
  }]
}]);
const mappedJob = await doctor.createJob({ project: { name: 'mapped-project', path: 'D:/mapped-project.p3d' } });
assert.equal(mappedJob.project.type, '水工建筑');
assert.equal(mappedJob.project.discipline, '结构');
assert.equal(mappedJob.project.snapshotVersion, 1);
await doctor.addComponents(mappedJob.id, [{ entityId: '10:1', modelId: 10, elementId: 1, name: '长方体', shapeName: '长方体', parameters: {} }]);
const mappedProfile = doctor.projectProfile(await doctor.readJob(mappedJob.id));
assert.equal(mappedProfile.systems[0].name, '输水系统');
assert.equal(mappedProfile.componentTypes[0].name, '检修闸门');
assert.deepEqual(mappedProfile.modelGroups, [{ modelId: '10', name: '模型 10', count: 1 }]);
assert.equal(mappedProfile.components[0].role, '检修隔断');
assert.equal(mappedProfile.components[0].canonicalName, '检修闸门 1 号');
assert.equal(mappedProfile.components[0].identity.status, 'verified');
assert.equal(mappedProfile.components[0].standardMatch.status, 'verified');
assert.equal(mappedProfile.components[0].classification.shapeNameUsed, false);
await assert.rejects(() => doctor.setRules([{
  id: 'UNREVIEWED', componentTypes: ['wall'], field: 'parameters.width', operator: '>=', value: 200,
  unit: 'mm', standardCode: 'TEST-1', clause: '3.1'
}]), /reviewed/);
await assert.rejects(() => doctor.setRules([{
  id: 'MISSING-SOURCE', status: 'reviewed', componentTypes: ['wall'], field: 'parameters.width', operator: '>=', value: 200,
  unit: 'mm', standardCode: 'TEST-1', clause: '3.1', reviewedBy: 'test', reviewedAt: '2026-08-07T00:00:00Z',
  version: '1.0.0', standardVersion: '2026', standardStatus: 'current'
}]), /sourceDocument/);
await doctor.setRules([{
  id: 'WIDTH-001',
  status: 'reviewed',
  projectTypes: ['水工建筑'],
  componentTypes: ['wall'],
  field: 'parameters.width',
  operator: '>=',
  value: 200,
  unit: 'mm',
  standardCode: 'TEST-1',
  clause: '3.1',
  reviewedBy: 'test',
  reviewedAt: '2026-08-07T00:00:00Z',
  version: '1.0.0',
  standardVersion: '2026',
  standardStatus: 'current',
  sourceDocument: 'test.pdf',
  sourcePath: 'test.pdf',
  sourcePage: 3,
  sourceExcerpt: '构件宽度不得小于 200 mm。',
  tolerance: 0
}]);
const job = await doctor.createJob({ project: { name: '测试工程', type: '水工建筑' } });
const standardIdentity = {
  standardName: '测试墙体', standardMatchStatus: 'verified',
  standardReferences: [{ standardCode: 'TEST-1', standardVersion: '2026', standardStatus: 'current', clause: '3.1', sourceDocument: 'test.pdf', sourcePage: 3, sourceExcerpt: '测试墙体定义。', reviewedBy: 'test', reviewedAt: '2026-08-07T00:00:00Z' }]
};
await doctor.addComponents(job.id, [
  { entityId: '1:1', canonicalName: '测试墙 1', semanticType: 'wall', systemType: '主体系统', assemblyType: '墙体组件', identityStatus: 'verified', identityEvidence: ['测试设备表'], ...standardIdentity, parameters: { width: 240 } },
  { entityId: '1:2', canonicalName: '测试墙 2', semanticType: 'wall', systemType: '主体系统', assemblyType: '墙体组件', identityStatus: 'verified', identityEvidence: ['测试设备表'], ...standardIdentity, parameters: { width: 180 } },
  { entityId: '1:3', canonicalName: '测试墙 3', semanticType: 'wall', systemType: '主体系统', assemblyType: '墙体组件', identityStatus: 'verified', identityEvidence: ['测试设备表'], ...standardIdentity, parameters: {} }
]);
const result = await doctor.runJob(job.id);
assert.deepEqual(result.summary, { total: 3, pass: 1, fail: 1, warning: 0, needIdentity: 0, needStandard: 0, needRule: 0, needData: 1, error: 0 });
assert.equal(result.results[1].issues[0].actual, 180);
assert.equal(result.results[2].status, 'NEED_DATA');
assert.equal(result.results[0].sources[0].page, 3);
assert.equal(result.results[0].sources[0].excerpt, '构件宽度不得小于 200 mm。');

const shapeOnlyJob = await doctor.createJob({ project: { name: '变电设备' } });
await doctor.addComponents(shapeOnlyJob.id, [
  { entityId: '2:1', name: '长方体', shapeName: '长方体', componentType: null, parameters: { width: 240 } }
]);
const shapeOnlyResult = await doctor.runJob(shapeOnlyJob.id);
assert.equal(shapeOnlyResult.results[0].status, 'NEED_IDENTITY');
assert.equal(shapeOnlyResult.results[0].sources.length, 0);
assert.match(shapeOnlyResult.results[0].summary, /真实构件身份尚未核实/);
assert.match(shapeOnlyResult.results[0].summary, /真实名称、所属系统、整体组件、语义类型、审核证据/);
const duplicateProjectJob = await doctor.createJob({ project: { name: '变电设备', type: '电气设备' } });
const dedupedJobs = await doctor.listJobs();
assert.equal(dedupedJobs.length, 4);
assert.equal(dedupedJobs.some((item) => item.id === duplicateProjectJob.id), true);
assert.equal(dedupedJobs.some((item) => item.id === shapeOnlyJob.id), true);
assert.equal(dedupedJobs.find((item) => item.id === shapeOnlyJob.id).project.checkScope, 'component');
const jobs = await doctor.listJobs();
assert.equal(jobs.length, 4);
assert.ok(jobs.some((item) => item.id === job.id));
assert.equal(jobs[0].components, undefined);
const revisions = await doctor.listRuleRevisions();
assert.ok(revisions.length >= 1);
await doctor.rollbackRules(revisions[revisions.length - 1].revision, { actor: 'test' });
assert.equal((await doctor.getRules()).length, 0);
console.log('bim-doctor self-test passed');
