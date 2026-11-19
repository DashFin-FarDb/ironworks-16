import { chromium } from 'playwright';
import { execSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const OUT_DIR = path.resolve('oracle/runs');
fs.mkdirSync(OUT_DIR, { recursive: true });

function getGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'uncommitted';
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr !== 'string') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('Could not allocate ephemeral port'));
      }
    });
  });
}

function runVitestSummary(): { passed: number; failed: number } {
  try {
    const out = execSync('npx vitest run --reporter=json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const parsed = JSON.parse(out);
    return { passed: parsed.numPassedTests ?? 0, failed: parsed.numFailedTests ?? 0 };
  } catch (err: any) {
    try {
      const parsed = JSON.parse(err.stdout?.toString() || '{}');
      return { passed: parsed.numPassedTests ?? 0, failed: parsed.numFailedTests ?? 0 };
    } catch {
      return { passed: 0, failed: -1 };
    }
  }
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function runDeterministicPass(browser: any, url: string, captureDir?: string, sha?: string) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors: string[] = [];
  page.on('console', (msg: any) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err: any) => consoleErrors.push(err.message));

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  let pixelDiffRatio = 0;
  const f0 = captureDir && sha ? path.join(captureDir, `${sha}_tick000.png`) : null;
  const f300 = captureDir && sha ? path.join(captureDir, `${sha}_tick300.png`) : null;
  if (f0) await page.screenshot({ path: f0 });

  const stepped = await page.evaluate(() => {
    const w = window as any;
    if (typeof w.__STEP_TICKS__ === 'function') { w.__STEP_TICKS__(300); return true; }
    return false;
  });
  if (!stepped) await page.waitForTimeout(1500);
  if (f300) await page.screenshot({ path: f300 });

  const telemetry = await page.evaluate(() => {
    const w = window as any;
    return typeof w.__FACTORY_TELEMETRY__ === 'function' ? w.__FACTORY_TELEMETRY__() : {};
  });

  const stateJson: string | null = await page.evaluate(() => {
    const w = window as any;
    return typeof w.__SERIALIZE_STATE__ === 'function' ? w.__SERIALIZE_STATE__() : null;
  });

  if (f0 && f300) {
    const img0 = PNG.sync.read(fs.readFileSync(f0));
    const img300 = PNG.sync.read(fs.readFileSync(f300));
    const diff = pixelmatch(img0.data, img300.data, null, img0.width, img0.height, { threshold: 0.1 });
    pixelDiffRatio = Number((diff / (img0.width * img0.height)).toFixed(6));
  }

  return { page, consoleErrors, telemetry, stateHash: stateJson ? sha256(stateJson) : null, pixelDiffRatio };
}

async function main() {
  const sha = getGitSha();
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}/?showcase=1`;
  const tests = runVitestSummary();

  const server = spawn('npx', ['vite', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2000));

  try {
    const browser = await chromium.launch();

    // Pass 1 (visual capture + state hash)
    const run1 = await runDeterministicPass(browser, url, OUT_DIR, sha);

    // Fail-closed fault-injection probes on Run 1 page
    const faultProbes = await run1.page.evaluate(() => {
      const w = window as any;
      if (typeof w.__INJECT_FAULT__ !== 'function') return { supported: false };
      const corruptSave = w.__INJECT_FAULT__('corrupt_save');
      const blackout = w.__INJECT_FAULT__('blackout');
      if (typeof w.__STEP_TICKS__ === 'function') w.__STEP_TICKS__(60);
      const postBlackout = typeof w.__FACTORY_TELEMETRY__ === 'function' ? w.__FACTORY_TELEMETRY__() : {};
      const hasNaN = Object.values(postBlackout).some((v) => typeof v === 'number' && Number.isNaN(v));
      return { supported: true, corruptSave, blackout, postBlackoutHasNaN: hasNaN };
    });
    await run1.page.close();

    // Pass 2 (independent determinism check)
    const run2 = await runDeterministicPass(browser, url);
    await run2.page.close();

    const deterministicMatch = run1.stateHash !== null && run1.stateHash === run2.stateHash;

    const record = {
      timestamp: new Date().toISOString(),
      sha,
      testsPassed: tests.passed,
      testsFailed: tests.failed,
      consoleErrorCount: run1.consoleErrors.length,
      consoleErrors: run1.consoleErrors.slice(0, 5),
      pixelDiffRatio: run1.pixelDiffRatio,
      deterministicMatch,
      stateHash: run1.stateHash,
      faultProbes,
      telemetry: run1.telemetry,
    };

    fs.appendFileSync('oracle/telemetry_log.jsonl', JSON.stringify(record) + '\n', 'utf8');
    console.log(JSON.stringify(record, null, 2));
    await browser.close();
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
