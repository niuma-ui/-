import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BimDoctor } from '../bim-doctor.mjs';

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
await doctor.setRules([{
  id: 'WIDTH-001',
  projectTypes: ['水工建筑'],
  componentTypes: ['wall'],
  field: 'parameters.width',
  operator: '>=',
  value: 200,
  unit: 'mm',
  standardCode: 'TEST-1',
  clause: '3.1'
}]);
const job = await doctor.createJob({ project: { name: '测试工程', type: '水工建筑' } });
await doctor.addComponents(job.id, [
  { entityId: '1:1', componentType: 'wall', parameters: { width: 240 } },
  { entityId: '1:2', componentType: 'wall', parameters: { width: 180 } },
  { entityId: '1:3', componentType: 'wall', parameters: {} }
]);
const result = await doctor.runJob(job.id);
assert.deepEqual(result.summary, { total: 3, pass: 1, fail: 1, warning: 0, needRule: 0, needData: 1, error: 0 });
assert.equal(result.results[1].issues[0].actual, 180);
assert.equal(result.results[2].status, 'NEED_DATA');

const shapeOnlyJob = await doctor.createJob({ project: { name: '变电设备', type: '电气设备' } });
await doctor.addComponents(shapeOnlyJob.id, [
  { entityId: '2:1', name: '长方体', shapeName: '长方体', componentType: null, parameters: { width: 240 } }
]);
const shapeOnlyResult = await doctor.runJob(shapeOnlyJob.id);
assert.equal(shapeOnlyResult.results[0].status, 'NEED_RULE');
const duplicateProjectJob = await doctor.createJob({ project: { name: '变电设备', type: '电气设备' } });
const dedupedJobs = await doctor.listJobs();
assert.equal(dedupedJobs.length, 2);
assert.equal(dedupedJobs.some((item) => item.id === duplicateProjectJob.id), true);
assert.equal(dedupedJobs.some((item) => item.id === shapeOnlyJob.id), false);
const jobs = await doctor.listJobs();
assert.equal(jobs.length, 2);
assert.ok(jobs.some((item) => item.id === job.id));
assert.equal(jobs[0].components, undefined);
console.log('bim-doctor self-test passed');
