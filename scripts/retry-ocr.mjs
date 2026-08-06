import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createScheduler, createWorker, OEM, PSM } from 'tesseract.js';
import chiSim from '@tesseract.js-data/chi_sim';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  KnowledgeBase,
  joinPageItems,
  metadataFromPath,
  normalizeText,
  splitPageText,
  walkPdfFiles
} from '../knowledge-base.mjs';

const gzip = promisify(zlib.gzip);
const execFileAsync = promisify(execFile);
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pdfRoot = path.join(projectRoot, '水利水电规范库');
const cacheDir = path.join(projectRoot, '.knowledge-cache');
const manifestPath = path.join(cacheDir, 'manifest.json');
const indexPath = path.join(cacheDir, 'index.json.gz');
const reportPath = path.join(cacheDir, 'ocr-report.json');
const retryReportPath = path.join(cacheDir, 'ocr-retry-report.json');
const progressPath = path.join(cacheDir, 'ocr-progress.json');
const rasterDir = path.join(cacheDir, 'ocr-retry-raster');
const scale = Number(process.env.OCR_RETRY_SCALE || 2.05);
const workerCount = Math.max(1, Math.min(4, Number(process.env.OCR_RETRY_WORKERS || 3)));
const pdfToPpm = process.env.PDFTOPPM_PATH || path.join(
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
const trialNotice = /此为试读[^\n]*(?:www\.[a-z0-9.-]+)?/gi;

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

async function rasterize(filePath, pageNumber) {
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
    return { context, height: canvas.height, imageBuffer, width: canvas.width };
  } finally {
    await fs.rm(imagePath, { force: true });
  }
}

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
if (!manifest.ocr?.complete) throw new Error('完整 OCR 尚未完成');
await fs.access(pdfToPpm);

const knowledge = new KnowledgeBase({ root: pdfRoot, cacheDir });
await knowledge.initialize();
const sourceReport = JSON.parse(await fs.readFile(reportPath, 'utf8'));
const targets = new Set(sourceReport.filter((row) => row.blank + row.failed > 0).map((row) => row.file));

let removedChunks = 0;
const removedPages = new Set();
const trialResults = knowledge.index.search('试读', { combineWith: 'OR', prefix: false, fuzzy: false });
for (const result of trialResults) {
  const cleaned = normalizeText(result.text).replace(trialNotice, '').trim();
  if (cleaned.length >= 12 || !trialNotice.test(result.text)) continue;
  trialNotice.lastIndex = 0;
  knowledge.index.discard(result.id);
  targets.add(result.relativePath);
  removedPages.add(`${result.relativePath}:${result.page}`);
  removedChunks += 1;
}

const files = await walkPdfFiles(pdfRoot);
const scheduler = createScheduler();
for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
  const worker = await createWorker('chi_sim', OEM.LSTM_ONLY, {
    langPath: chiSim.langPath,
    gzip: chiSim.gzip,
    cachePath: path.join(cacheDir, 'tesseract')
  });
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    preserve_interword_spaces: '1'
  });
  scheduler.addWorker(worker);
}

let checkedPages = 0;
let recoveredPages = 0;
let addedChunks = 0;
const blankPages = [];
const unreadablePages = [];
const recovered = [];
const pending = [];

try {
  for (const filePath of files) {
    const metadata = metadataFromPath(filePath, pdfRoot);
    if (!targets.has(metadata.relativePath)) continue;

    const data = new Uint8Array(await fs.readFile(filePath));
    const pdf = await getDocument({ data, disableWorker: true, useSystemFonts: true, verbosity: 0 }).promise;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        if (joinPageItems(content.items).length >= 12) continue;
        if (knowledge.index.has(`ocr:${metadata.relativePath}:${pageNumber}:0`)) continue;

        checkedPages += 1;
        const raster = await rasterize(filePath, pageNumber);
        if (inkRatio(raster.context, raster.width, raster.height) < .0015) {
          blankPages.push({ file: metadata.relativePath, page: pageNumber });
          continue;
        }

        const task = scheduler.addJob('recognize', raster.imageBuffer).then((result) => {
          const text = normalizeText(result.data.text).replace(trialNotice, '').trim();
          trialNotice.lastIndex = 0;
          if (text.length < 12 || result.data.confidence < 8) {
            unreadablePages.push({ file: metadata.relativePath, page: pageNumber, confidence: result.data.confidence });
            return;
          }

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
          recoveredPages += 1;
          addedChunks += chunks.length;
          recovered.push({ file: metadata.relativePath, page: pageNumber, confidence: result.data.confidence });
        }).catch((error) => {
          unreadablePages.push({ file: metadata.relativePath, page: pageNumber, error: error.message });
        });
        pending.push(task);
        if (pending.length >= workerCount) await Promise.all(pending.splice(0));
      } finally {
        page.cleanup();
      }
    }
    await Promise.all(pending.splice(0));
    await pdf.destroy();
  }
} finally {
  await scheduler.terminate();
  await fs.rm(rasterDir, { recursive: true, force: true });
}

const compressed = await gzip(Buffer.from(JSON.stringify(knowledge.index)), { level: 7 });
await fs.writeFile(indexPath, compressed);

const removedPageCount = removedPages.size;
manifest.chunks = manifest.chunks - removedChunks + addedChunks;
manifest.emptyPages = blankPages.length + unreadablePages.length;
manifest.ocr.recognizedPages = manifest.ocr.recognizedPages - removedPageCount + recoveredPages;
manifest.ocr.blankPages = blankPages.length;
manifest.ocr.unreadablePages = unreadablePages.length;
manifest.ocr.addedChunks = manifest.ocr.addedChunks - removedChunks + addedChunks;
manifest.ocr.retry = {
  checkedPages,
  recoveredPages,
  removedTrialPages: removedPageCount,
  completedAt: new Date().toISOString(),
  scale,
  workers: workerCount
};
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

const retryReport = {
  checkedPages,
  recoveredPages,
  removedTrialPages: Array.from(removedPages),
  blankPages,
  unreadablePages,
  recovered
};
await fs.writeFile(retryReportPath, JSON.stringify(retryReport, null, 2));
await fs.writeFile(progressPath, JSON.stringify({ phase: 'ready', complete: true, ...manifest.ocr }, null, 2));

console.log(`二次 OCR 完成：复核 ${checkedPages} 页，恢复 ${recoveredPages} 页，剩余空白 ${blankPages.length} 页，无法识别 ${unreadablePages.length} 页。`);
