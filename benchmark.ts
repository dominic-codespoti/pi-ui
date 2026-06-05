#!/usr/bin/env bun
/**
 * Server-side benchmark for pi-ui-2
 *
 * Uses Playwright to intercept the page's WebSocket for first-connect timing,
 * then creates a controlled second WebSocket from page context for round-trips.
 */
// @ts-nocheck

import { chromium } from 'playwright';
import { $ } from 'bun';
import { resolve } from 'node:path';

const PORT = 9876;
const PASSWORD = 'benchmark-test';
const URL = `http://localhost:${PORT}`;
const CWD = resolve(import.meta.dir ?? '.');

const samples: { label: string; ms: number }[] = [];
function record(label: string, ms: number) {
  samples.push({ label, ms });
  console.log(`  ${label}: ${ms.toFixed(1)} ms`);
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let serverProc: import('bun').Subprocess | null = null;

async function startServer(): Promise<number> {
  console.log('\n=== Starting server ===');
  const t0 = process.hrtime.bigint();

  serverProc = Bun.spawn(['bun', '--smol', 'run', 'bin/pifrontier.ts'], {
    env: { ...process.env as Record<string, string>, PI_PASSWORD: PASSWORD, PORT: String(PORT), PI_CWD: CWD },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const reader = serverProc.stdout!.getReader();
  const decoder = new TextDecoder();
  let output = '';
  const timeout = setTimeout(() => { console.error('[bench] Timeout'); cleanup(); process.exit(1); }, 45_000);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    if (output.includes('Listening on')) break;
  }
  clearTimeout(timeout);
  reader.releaseLock();

  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  Started in ${ms.toFixed(1)} ms`);
  record('server startup', ms);
  return serverProc.pid;
}

function cleanup() {
  if (serverProc) { serverProc.kill('SIGTERM'); serverProc = null; }
}
async function getMemRssKb(pid: number): Promise<number> {
  const out = await $`ps -o rss= -p ${pid}`.text();
  return parseInt(out.trim(), 10);
}
async function getCpuPercent(pid: number): Promise<number> {
  const out = await $`ps -o %cpu= -p ${pid}`.text();
  return parseFloat(out.trim());
}

// ── Main ──────────────────────────────────────────────────────────────────────

try {
  const pid = await startServer();
  await Bun.sleep(500);

  const idleRssKb = await getMemRssKb(pid);
  const idleCpu = await getCpuPercent(pid);
  console.log(`\n=== Idle ===`);
  console.log(`  RSS: ${(idleRssKb / 1024).toFixed(1)} MB | CPU: ${idleCpu.toFixed(1)}%`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Intercept first WS creation to measure SDK load time
  let firstConnectMs = 0;
  let firstConnectAt = 0;

  const firstWSPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No WS within 30s')), 30_000);

    page.on('websocket', (pwWs) => {
      const tCreate = Date.now();
      let connected = false;

      pwWs.on('framereceived', (frame) => {
        try {
          const data = JSON.parse(frame.payload as string);
          if (data.type === 'connected' && !connected) {
            connected = true;
            firstConnectMs = Date.now() - tCreate;
            firstConnectAt = Date.now();
            clearTimeout(timeout);
            resolve();
          }
        } catch { /* skip */ }
      });
    });
  });

  // ── Login ───────────────────────────────────────────────────────────────────
  console.log(`\n=== Login flow ===`);
  const t0 = process.hrtime.bigint();
  await page.goto(`${URL}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/');
  await page.waitForLoadState('networkidle');
  record('login + redirect', Number(process.hrtime.bigint() - t0) / 1e6);

  // Wait for first WS connection
  await firstWSPromise;
  console.log(`  First WS → 'connected': ${firstConnectMs.toFixed(1)} ms`);
  record('first WS: SDK load + session init', firstConnectMs);

  await Bun.sleep(2000);

  // Post-connection metrics
  const postConnRss = await getMemRssKb(pid);
  const postConnCpu = await getCpuPercent(pid);
  console.log(`\n  After SDK: RSS ${(postConnRss / 1024).toFixed(1)} MB (+${((postConnRss - idleRssKb) / 1024).toFixed(1)} MB)`);
  console.log(`  CPU: ${postConnCpu.toFixed(2)}%`);

  // ── Create benchmark WS from page context ─────────────────────────────────
  // Create a NEW WebSocket from page context (cookies auto-sent by browser).
  // Since session is already initialized, this will be fast.
  console.log(`\n=== Creating benchmark WS ===`);
  const benchWsMs: number = await page.evaluate((port) => {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      ws.addEventListener('open', () => {
        ws.addEventListener('message', function handler(e) {
          try {
            if (JSON.parse(e.data).type === 'connected') {
              ws.removeEventListener('message', handler);
              // Store globally
              (window as any).__benchWS = ws;
              resolve(performance.now() - t0);
            }
          } catch {}
        });
      });
      ws.addEventListener('error', (e) => reject(String(e)));
      setTimeout(() => reject('timeout'), 15_000);
    });
  }, PORT);
  record('bench WS connect', benchWsMs);

  await Bun.sleep(500);

  // ── Round-trip measurement via page.evaluate ──────────────────────────────
  async function measureRT(msg: object, expectType: string): Promise<number> {
    return page.evaluate(({ msgStr, expectType }) => {
      const msg = JSON.parse(msgStr);
      return new Promise((resolve, reject) => {
        const ws = (window as any).__benchWS;
        if (!ws || ws.readyState !== WebSocket.OPEN) { reject('WS not open'); return; }
        const t0 = performance.now();
        const handler = (e: MessageEvent) => {
          try {
            if (JSON.parse(e.data as string).type === expectType) {
              ws.removeEventListener('message', handler);
              resolve(performance.now() - t0);
            }
          } catch {}
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify(msg));
        setTimeout(() => { ws.removeEventListener('message', handler); reject('timeout'); }, 15_000);
      });
    }, { msgStr: JSON.stringify(msg), expectType });
  }

  // ── Run measurements ────────────────────────────────────────────────────
  console.log(`\n=== Round-trip times ===`);

  for (let i = 0; i < 3; i++) {
    const ms = await measureRT({ type: 'get_providers' }, 'providers_list');
    record(`get_providers #${i + 1}`, ms);
  }
  for (let i = 0; i < 3; i++) {
    const ms = await measureRT({ type: 'list_sessions' }, 'sessions_list');
    record(`list_sessions #${i + 1}`, ms);
  }
  {
    const ms = await measureRT({ type: 'get_resources' }, 'resources_list');
    record(`get_resources`, ms);
  }

  const dirs = ['.', './src', './src/lib'];
  for (let i = 0; i < dirs.length; i++) {
    const prefix = dirs[i];
    const ms = await page.evaluate(({ prefix }) => {
      return new Promise<number>((resolve, reject) => {
        const ws = (window as any).__benchWS;
        if (!ws || ws.readyState !== WebSocket.OPEN) { reject('WS not open'); return; }
        const t0 = performance.now();
        const handler = (e: MessageEvent) => {
          try {
            if (JSON.parse(e.data as string).type === 'dir_completions') {
              ws.removeEventListener('message', handler);
              resolve(performance.now() - t0);
            }
          } catch {}
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ type: 'dir_complete', prefix }));
        setTimeout(() => { ws.removeEventListener('message', handler); reject('timeout'); }, 15_000);
      });
    }, { prefix });
    record(`dir_complete('${prefix}')`, ms);
  }

  const queries = ['server', 'protocol', ''];
  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    const ms = await page.evaluate(({ query }) => {
      return new Promise<number>((resolve, reject) => {
        const ws = (window as any).__benchWS;
        if (!ws || ws.readyState !== WebSocket.OPEN) { reject('WS not open'); return; }
        const t0 = performance.now();
        const handler = (e: MessageEvent) => {
          try {
            if (JSON.parse(e.data as string).type === 'file_completions') {
              ws.removeEventListener('message', handler);
              resolve(performance.now() - t0);
            }
          } catch {}
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ type: 'file_complete', query }));
        setTimeout(() => { ws.removeEventListener('message', handler); reject('timeout'); }, 15_000);
      });
    }, { query });
    record(`file_complete('${query}')`, ms);
  }

  {
    const ms = await measureRT({ type: 'get_all_sessions' }, 'all_sessions_list');
    record(`get_all_sessions`, ms);
  }

  // ── Final ─────────────────────────────────────────────────────────────────
  await Bun.sleep(500);
  const finalRss = await getMemRssKb(pid);
  const finalCpu = await getCpuPercent(pid);
  await browser.close();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(62)}`);
  console.log(`  SUMMARY`);
  console.log(`${'='.repeat(62)}`);
  console.log(`  Memory:`);
  console.log(`    Idle:                       ${(idleRssKb / 1024).toFixed(1)} MB`);
  console.log(`    After SDK (1st WS):         ${(postConnRss / 1024).toFixed(1)} MB  (+${((postConnRss - idleRssKb) / 1024).toFixed(1)} MB)`);
  console.log(`    After benchmark:            ${(finalRss / 1024).toFixed(1)} MB  (+${((finalRss - idleRssKb) / 1024).toFixed(1)} MB)`);
  console.log(`    SDK overhead estimate:      ~${((postConnRss - idleRssKb) / 1024).toFixed(0)} MB`);
  console.log(`  CPU:`);
  console.log(`    Idle:                       ${idleCpu.toFixed(1)}%`);
  console.log(`    Post-connection:            ${postConnCpu.toFixed(1)}%`);
  console.log(`    Final:                      ${finalCpu.toFixed(1)}%`);
  console.log(`\n  Latency:`);
  const maxLabel = Math.max(...samples.map(s => s.label.length));
  for (const s of samples) {
    console.log(`    ${s.label.padEnd(maxLabel)}  ${s.ms.toFixed(1).padStart(8)} ms`);
  }

} catch (err) {
  console.error('[bench] Error:', err.stack || err);
} finally {
  cleanup();
}
