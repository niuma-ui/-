import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeBase } from '../knowledge-base.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const knowledge = new KnowledgeBase({
  root: path.join(projectRoot, '水利水电规范库'),
  cacheDir: path.join(projectRoot, '.knowledge-cache')
});

const timer = setInterval(() => {
  const status = knowledge.status();
  const current = status.current ? ` | ${status.current}` : '';
  process.stdout.write(`\r${status.phase}: ${status.completed}/${status.total} | ${status.pages} 页 | ${status.chunks} 段${current}`.slice(0, 180));
}, 500);

try {
  await knowledge.initialize({ force: process.argv.includes('--force') });
  clearInterval(timer);
  const status = knowledge.status();
  process.stdout.write(`\n索引完成：${status.total} 份 PDF，${status.pages} 页，${status.chunks} 个正文片段。\n`);
} catch (error) {
  clearInterval(timer);
  console.error('\n索引失败：', error);
  process.exitCode = 1;
}
