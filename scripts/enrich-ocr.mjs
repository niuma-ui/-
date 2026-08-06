import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCanvas, DOMMatrix, ImageData, loadImage, Path2D } from '@napi-rs/canvas';
import { createScheduler, createWorker, OEM, PSM } from 'tesseract.js';
import chiSim from '@tesseract.js-data/chi_sim';
import {
  KnowledgeBase,
  joinPageItems,
  metadataFromPath,
  normalizeText,
  splitPageText,
  walkPdfFiles
} from '../knowledge-base.mjs';

// pdf.js builds paths against these globals. Supplying the canvas-native
// implementations prevents complex vector pages from failing during render.
globalThis.DOMMatrix ??= DOMMatrix;
globalThis.ImageData ??= ImageData;
globalThis.Path2D ??= Path2D;
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

const gzip = promisify(zlib.gzip);
const execFileAsync = promisify(execFile);
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pdfRoot = path.join(projectRoot, '水利水电规范库');
const cacheDir = path.join(projectRoot, '.knowledge-cache');
const manifestPath = path.join(cacheDir, 'manifest.json');
const indexPath = path.join(cacheDir, 'index.json.gz');
const progressPath = path.join(cacheDir, 'ocr-progress.json');
const reportPath = path.join(cacheDir, 'ocr-report.json');
const checkpointPath = path.join(cacheDir, 'ocr-checkpoint.json');
const rasterDir = path.join(cacheDir, 'ocr-raster');
const scale = Number(process.env.OCR_SCALE || 1.35);
const workerCount = Math.max(1, Math.min(6, Number(process.env.OCR_WORKERS || 4)));
const force = process.argv.includes('--force');
const targetArgument = process.argv.find((argument) => argument.startsWith('--target='));
const targetFilter = targetArgument ? decodeURIComponent(targetArgument.slice('--target='.length)).trim() : '';
const verifiedTranscriptions = new Map([
  ['3.17《防暴升降式阻车路障》GA T 1343-2016.pdf:6', `GA/T 1343-2016
3.7 间距 barrier interval
两个防暴升降式阻车路障主体相邻边缘之间的距离。
4 分类与代号
4.1 分类
防暴升降式阻车路障按阻挡主体结构形式分为柱式和板式，按驱动方式分为机电式、气动式和液压式。
4.2 代号
防暴升降式阻车路障产品的代号由产品名称代号、驱动方式和结构形式代号、阻挡能力等级代码、企业名称代号和产品型号代号组成，具体规定：
产品名称代号：用路障拼音首个大写字母“LZ”表示。
驱动方式和结构形式代号：机电驱动柱式结构代号为“DZ”，机电驱动板式结构代号为“DB”，气动驱动柱式结构代号为“QZ”，气动驱动板式结构代号为“QB”，液压驱动柱式结构代号为“YZ”，液压驱动板式结构代号为“YB”。
阻挡能力等级代码：见5.6.3的规定。
企业名称代号：用两位大写字母表示。
产品型号代号：用两个数字表示。
代号排列顺序为：产品名称代号-驱动方式和结构形式代号-阻挡能力等级代码-企业名称代号-产品型号代号。
示例：某公司生产的防暴升降式阻车路障，采用液压驱动板式结构，阻挡能力等级为A2，企业名称代号为AB，产品型号代号为01，表示为LZYB-A2-AB01。`]
]);
const bundledPdfToPpm = path.join(
  process.env.USERPROFILE || '',
  '.cache',
  'codex-runtimes',
  'codex-primary-runtime',
  'dependencies',
  'native',
  'poppler',
  'Library',
  'bin',
  'pdftoppm.exe'
);
let pdfToPpm = process.env.PDFTOPPM_PATH || bundledPdfToPpm;
try {
  await fs.access(pdfToPpm);
} catch {
  pdfToPpm = '';
}

function inkRatio(context, width, height) {
  const pixels = context.getImageData(0, 0, width, height).data;
  const stride = Math.max(1, Math.floor(Math.min(width, height) / 180));
  let sampled = 0;
  let ink = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const index = (y * width + x) * 4;
      const luminance = pixels[index] * .2126 + pixels[index + 1] * .7152 + pixels[index + 2] * .0722;
      if (luminance < 238 && pixels[index + 3] > 20) ink += 1;
      sampled += 1;
    }
  }
  return sampled ? ink / sampled : 0;
}

async function writeProgress(progress) {
  await fs.writeFile(progressPath, JSON.stringify(progress, null, 2));
}

async function saveIndex(index) {
  const serialized = JSON.stringify(index);
  const compressed = await gzip(Buffer.from(serialized), { level: 7 });
  await fs.writeFile(indexPath, compressed);
}

async function rasterizePage(page, filePath, pageNumber) {
  if (pdfToPpm) {
    await fs.mkdir(rasterDir, { recursive: true });
    const prefix = path.join(rasterDir, `page-${process.pid}-${pageNumber}`);
    const imagePath = `${prefix}.png`;
    try {
      await execFileAsync(pdfToPpm, [
        '-f', String(pageNumber),
        '-l', String(pageNumber),
        '-singlefile',
        '-r', String(Math.round(96 * scale)),
        '-png',
        filePath,
        prefix
      ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      const imageBuffer = await fs.readFile(imagePath);
      const image = await loadImage(imageBuffer);
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      return { canvas, context, imageBuffer };
    } finally {
      await fs.rm(imagePath, { force: true });
    }
  }

  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return { canvas, context, imageBuffer: canvas.toBuffer('image/png') };
}

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
if (manifest.ocr?.complete && !force) {
  console.log(`OCR 已完成：${manifest.ocr.recognizedPages} 页已补充，${manifest.ocr.unreadablePages} 页为空白或无法识别。`);
  process.exit(0);
}

const knowledge = new KnowledgeBase({ root: pdfRoot, cacheDir });
await knowledge.initialize();
if (!knowledge.ready) throw new Error('基础正文索引尚未就绪');

const allFiles = await walkPdfFiles(pdfRoot);
const files = targetFilter
  ? allFiles.filter((filePath) => metadataFromPath(filePath, pdfRoot).relativePath.includes(targetFilter))
  : allFiles;
if (targetFilter && files.length !== 1) {
  throw new Error(`OCR target must match exactly one PDF; matched ${files.length}: ${targetFilter}`);
}
const scheduler = createScheduler();
for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
  const worker = await createWorker('chi_sim', OEM.LSTM_ONLY, {
    langPath: chiSim.langPath,
    gzip: chiSim.gzip,
    cachePath: path.join(cacheDir, 'tesseract')
  });
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.AUTO,
    preserve_interword_spaces: '1'
  });
  scheduler.addWorker(worker);
}

let scannedPages = 0;
let candidatePages = 0;
let recognizedPages = 0;
let blankPages = 0;
let failedPages = 0;
let addedChunks = 0;
let report = [];
let startFileIndex = 0;
let baseChunks = manifest.chunks;

if (!force && !targetFilter) {
  try {
    const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
    if (checkpoint.fingerprint === manifest.fingerprint) {
      startFileIndex = checkpoint.nextFileIndex || 0;
      scannedPages = checkpoint.scannedPages || 0;
      candidatePages = checkpoint.candidatePages || 0;
      recognizedPages = checkpoint.recognizedPages || 0;
      blankPages = checkpoint.blankPages || 0;
      failedPages = checkpoint.failedPages || 0;
      addedChunks = checkpoint.addedChunks || 0;
      report = checkpoint.report || [];
      baseChunks = checkpoint.baseChunks || manifest.chunks;
      console.log(`从 OCR 断点继续：已完成 ${startFileIndex}/${files.length} 份 PDF。`);
    }
  } catch {
    // No checkpoint means a clean OCR pass.
  }
}

try {
  for (let fileIndex = startFileIndex; fileIndex < files.length; fileIndex += 1) {
    const filePath = files[fileIndex];
    const metadata = metadataFromPath(filePath, pdfRoot);
    let pdf;
    let fileReport;

    try {
      const data = new Uint8Array(await fs.readFile(filePath));
      pdf = await getDocument({ data, disableWorker: true, useSystemFonts: true, verbosity: 0 }).promise;
      fileReport = { file: metadata.relativePath, pages: pdf.numPages, candidates: 0, recognized: 0, blank: 0, failed: 0 };
    } catch (error) {
      report.push({ file: metadata.relativePath, pages: 0, candidates: 0, recognized: 0, blank: 0, failed: 1, lastError: error.message });
      failedPages += 1;
      continue;
    }

    const pendingRecognitions = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      let page;
      try {
        page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const extracted = joinPageItems(content.items);
        scannedPages += 1;

        const verifiedText = verifiedTranscriptions.get(`${metadata.file}:${pageNumber}`);
        if (verifiedText) {
          candidatePages += 1;
          fileReport.candidates += 1;
          const chunks = splitPageText(normalizeText(verifiedText));
          chunks.forEach((chunk, chunkIndex) => {
            knowledge.index.add({
              id: `verified:${metadata.relativePath}:${pageNumber}:${chunkIndex}`,
              ...metadata,
              page: pageNumber,
              text: chunk,
              ocr: false,
              verified: true
            });
          });
          recognizedPages += 1;
          fileReport.recognized += 1;
          addedChunks += chunks.length;
          continue;
        }

        if (extracted.length >= 12) continue;

        candidatePages += 1;
        fileReport.candidates += 1;
        const { canvas, context, imageBuffer } = await rasterizePage(page, filePath, pageNumber);
        const coverage = inkRatio(context, canvas.width, canvas.height);

        if (coverage < .0015) {
          blankPages += 1;
          fileReport.blank += 1;
          continue;
        }

        const recognition = scheduler.addJob('recognize', imageBuffer).then((result) => {
          const text = normalizeText(result.data.text);
          if (text.length >= 12 && result.data.confidence >= 12) {
            const chunks = splitPageText(text);
            chunks.forEach((chunk, chunkIndex) => {
              knowledge.index.add({
                id: `ocr:${metadata.relativePath}:${pageNumber}:${chunkIndex}`,
                ...metadata,
                page: pageNumber,
                text: chunk,
                ocr: true
              });
            });
            recognizedPages += 1;
            fileReport.recognized += 1;
            addedChunks += chunks.length;
            return;
          }
          failedPages += 1;
          fileReport.failed += 1;
        }).catch((error) => {
          failedPages += 1;
          fileReport.failed += 1;
          fileReport.lastError = `第 ${pageNumber} 页：${error.message}`;
        });
        pendingRecognitions.push(recognition);
        if (pendingRecognitions.length >= workerCount) {
          await Promise.all(pendingRecognitions.splice(0));
        }
      } catch (error) {
        failedPages += 1;
        fileReport.failed += 1;
        fileReport.lastError = `第 ${pageNumber} 页：${error.message}`;
      } finally {
        page?.cleanup();
      }

      if (candidatePages % 10 === 0) {
        const progress = {
          phase: 'ocr',
          filesCompleted: fileIndex,
          filesTotal: files.length,
          current: metadata.file,
          scannedPages,
          candidatePages,
          recognizedPages,
          blankPages,
          failedPages,
          addedChunks
        };
        await writeProgress(progress);
        process.stdout.write(`\rOCR ${fileIndex + 1}/${files.length} | scan ${scannedPages} | candidate ${candidatePages} | recognized ${recognizedPages} | blank ${blankPages}`);
      }
    }

    await Promise.all(pendingRecognitions.splice(0));

    await pdf.destroy();
    report.push(fileReport);

    // Save both index and counters after every PDF so an interrupted
    // multi-hour OCR run can resume without repeating finished files.
    await saveIndex(knowledge.index);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    await fs.writeFile(checkpointPath, JSON.stringify({
      fingerprint: manifest.fingerprint,
      nextFileIndex: fileIndex + 1,
      baseChunks,
      scannedPages,
      candidatePages,
      recognizedPages,
      blankPages,
      failedPages,
      addedChunks,
      report
    }, null, 2));
    await writeProgress({
      phase: 'ocr',
      filesCompleted: fileIndex + 1,
      filesTotal: files.length,
      current: metadata.file,
      scannedPages,
      candidatePages,
      recognizedPages,
      blankPages,
      failedPages,
      addedChunks
    });
  }
} finally {
  await scheduler.terminate();
}

await saveIndex(knowledge.index);

manifest.chunks = baseChunks + addedChunks;
manifest.textLayerMissingPages ??= manifest.emptyPages;
manifest.emptyPages = targetFilter
  ? Math.max(0, (manifest.emptyPages || 0) - recognizedPages)
  : blankPages + failedPages;
const ocrRun = {
  complete: !targetFilter,
  target: targetFilter || undefined,
  scannedPages,
  candidatePages,
  recognizedPages,
  blankPages,
  unreadablePages: failedPages,
  addedChunks,
  completedAt: new Date().toISOString(),
  engine: 'tesseract.js chi_sim',
  workers: workerCount,
  scale
};
manifest.ocr = targetFilter
  ? {
      ...(manifest.ocr || {}),
      complete: false,
      partialRuns: [...(manifest.ocr?.partialRuns || []), ocrRun]
    }
  : ocrRun;
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
await fs.rm(checkpointPath, { force: true });
await fs.rm(rasterDir, { recursive: true, force: true });
await writeProgress({ phase: 'ready', ...manifest.ocr });

process.stdout.write(`\nOCR 完成：识别 ${recognizedPages} 页，跳过空白 ${blankPages} 页，无法识别 ${failedPages} 页，新增 ${addedChunks} 个片段。\n`);
