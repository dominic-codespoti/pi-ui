#!/usr/bin/env bun
/**
 * Server-side benchmark for pi-ui-2
 *
 * Uses Playwright to intercept the page's WebSocket for first-connect timing,
 * then creates a controlled second WebSocket from page context for round-trips.
 */
// @ts-nocheck

import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { $, type Subprocess } from 'bun';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolvePort, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolvePort());
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolveClose, reject) => {
    probe.close((err) => (err ? reject(err) : resolveClose()));
  });
  if (!port) throw new Error('Could not reserve a benchmark port');
  return port;
}

const BENCH_ROOT = mkdtempSync(join(tmpdir(), 'pi-ui-benchmark-'));
const AGENT_DIR = join(BENCH_ROOT, 'agent');
const HOME_DIR = join(BENCH_ROOT, 'home');
const PROJECT_A = join(BENCH_ROOT, 'project-a');
const PROJECT_B = join(BENCH_ROOT, 'project-b');
mkdirSync(AGENT_DIR);
mkdirSync(HOME_DIR);
mkdirSync(PROJECT_A);
mkdirSync(PROJECT_B);

const PORT = await reservePort();
const PASSWORD = 'benchmark-test';
const URL = `http://127.0.0.1:${PORT}`;
const CWD = resolve(import.meta.dir ?? '.');

const samples: { label: string; ms: number }[] = [];
const rttSamples: Record<string, number[]> = {};
const evidenceSamples: Record<string, number[]> = {};
const skippedMetrics: { label: string; reason: string }[] = [];

function record(label: string, ms: number) {
  samples.push({ label, ms });
  console.log(`  ${label}: ${ms.toFixed(1)} ms`);
}

function recordEvidence(label: string, ms: number) {
  (evidenceSamples[label] ??= []).push(ms);
}

function recordRtt(label: string, ms: number) {
  (rttSamples[label] ??= []).push(ms);
  record(`${label} #${rttSamples[label].length}`, ms);
}

function skipMetric(label: string, reason: string) {
  skippedMetrics.push({ label, reason });
  console.log(`  ${label}: SKIPPED (${reason})`);
}

function percentile(values: number[], p: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function printDistribution(label: string, values: number[], unit = 'ms') {
  if (!values.length) {
    console.log(`    ${label}: no samples`);
    return;
  }
  console.log(
    `    ${label} (n=${values.length}): median ${percentile(values, 0.5).toFixed(1)} ${unit}, ` +
      `p95 ${percentile(values, 0.95).toFixed(1)} ${unit}, p99 ${percentile(values, 0.99).toFixed(1)} ${unit}`
  );
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let serverProc: Subprocess | null = null;
let browser: Browser | null = null;

async function startServer(): Promise<number> {
  console.log('\n=== Starting server ===');
  console.log(`  Isolated agent dir: ${AGENT_DIR}`);
  console.log(`  Isolated home dir: ${HOME_DIR}`);
  const t0 = process.hrtime.bigint();

  serverProc = Bun.spawn(['bun', '--smol', 'run', 'bin/pifrontier.ts'], {
    env: {
      ...(process.env as Record<string, string>),
      PI_PASSWORD: PASSWORD,
      PI_CODING_AGENT_DIR: AGENT_DIR,
      HOME: HOME_DIR,
      XDG_CONFIG_HOME: join(HOME_DIR, '.config'),
      XDG_CACHE_HOME: join(HOME_DIR, '.cache'),
      PORT: String(PORT),
      PI_CWD: CWD,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const reader = serverProc.stdout!.getReader();
  const decoder = new TextDecoder();
  let output = '';
  let startupTimedOut = false;
  const timeout = setTimeout(() => {
    startupTimedOut = true;
    serverProc?.kill('SIGTERM');
  }, 45_000);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    if (output.includes('Listening on')) break;
  }
  clearTimeout(timeout);
  reader.releaseLock();
  if (startupTimedOut || !output.includes('Listening on')) {
    throw new Error(`Benchmark server exited before listening:\n${output}`);
  }

  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  Started in ${ms.toFixed(1)} ms`);
  record('server startup', ms);
  return serverProc.pid;
}

async function cleanup(): Promise<void> {
  await browser?.close();
  browser = null;
  if (serverProc) {
    const proc = serverProc;
    serverProc = null;
    proc.kill('SIGTERM');
    await proc.exited.catch(() => {});
  }
  rmSync(BENCH_ROOT, { recursive: true, force: true });
}
async function getMemRssKb(pid: number): Promise<number> {
  const out = await $`ps -o rss= -p ${pid}`.text();
  return parseInt(out.trim(), 10);
}
async function getCpuPercent(pid: number): Promise<number> {
  const out = await $`ps -o %cpu= -p ${pid}`.text();
  return parseFloat(out.trim());
}

const transport = {
  sentFrames: 0,
  receivedFrames: 0,
  sentUtf8Bytes: 0,
  receivedUtf8Bytes: 0,
};

function payloadBytes(payload: unknown): number {
  if (typeof payload === 'string') return Buffer.byteLength(payload, 'utf8');
  if (payload instanceof Uint8Array) return payload.byteLength;
  return Buffer.byteLength(String(payload ?? ''), 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

try {
  const pid = await startServer();
  await Bun.sleep(500);

  const idleRssKb = await getMemRssKb(pid);
  const idleCpu = await getCpuPercent(pid);
  console.log(`\n=== Idle ===`);
  console.log(`  RSS: ${(idleRssKb / 1024).toFixed(1)} MB | CPU: ${idleCpu.toFixed(1)}%`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Keep the timing state outside the frame handler. A handler exception is
  // otherwise swallowed by the JSON-parse guard below, leaving the wait to
  // report a misleading "No WS" timeout even after the app connected.
  let firstConnectMs = 0;
  let firstConnectAt = 0;

  // Intercept first WS creation to measure SDK load time

  const firstWSPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No WS within 30s')), 30_000);

    page.on('websocket', (pwWs) => {
      const tCreate = Date.now();
      let connected = false;

      pwWs.on('framesent', (frame) => {
        transport.sentFrames += 1;
        transport.sentUtf8Bytes += payloadBytes(frame.payload);
      });
      pwWs.on('framereceived', (frame) => {
        transport.receivedFrames += 1;
        transport.receivedUtf8Bytes += payloadBytes(frame.payload);
        try {
          const data = JSON.parse(frame.payload as string);
          if (data.type === 'connected' && !connected) {
            connected = true;
            firstConnectMs = Date.now() - tCreate;
            firstConnectAt = Date.now();
            clearTimeout(timeout);
            resolve();
          }
        } catch {
          /* skip */
        }
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
  console.log(
    `\n  After SDK: RSS ${(postConnRss / 1024).toFixed(1)} MB (+${((postConnRss - idleRssKb) / 1024).toFixed(1)} MB)`
  );
  console.log(`  CPU: ${postConnCpu.toFixed(2)}%`);

  // ── Create benchmark WS from page context ─────────────────────────────────
  // Create a NEW WebSocket from page context (cookies auto-sent by browser).
  // Since session is already initialized, this will be fast.
  console.log(`\n=== Creating benchmark WS ===`);
  const benchConnection: { ms: number; sessionId: string } = await page.evaluate((port) => {
    const { promise, resolve, reject } = Promise.withResolvers<{ ms: number; sessionId: string }>();
    const t0 = performance.now();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timeout = setTimeout(() => reject('timeout'), 15_000);
    ws.addEventListener('open', () => {
      ws.addEventListener('message', function handler(e) {
        try {
          const payload = JSON.parse(e.data as string) as { type?: string; sessionId?: string };
          if (payload.type !== 'connected' || typeof payload.sessionId !== 'string') return;
          clearTimeout(timeout);
          ws.removeEventListener('message', handler);
          (window as Window & { __benchWS?: WebSocket }).__benchWS = ws;
          resolve({ ms: performance.now() - t0, sessionId: payload.sessionId });
        } catch {
          /* ignore malformed frames */
        }
      });
    });
    ws.addEventListener('error', () => reject('WS error'));
    return promise;
  }, PORT);
  const benchWsMs = benchConnection.ms;
  const benchSessionId = benchConnection.sessionId;
  record('bench WS connect', benchWsMs);

  await Bun.sleep(500);

  // ── Round-trip measurement via page.evaluate ──────────────────────────────
  async function requestResponse(
    msg: object,
    expectType: string,
    timeoutMs = 15_000
  ): Promise<unknown> {
    return page.evaluate(
      ({ msgStr, expectType, timeoutMs }) => {
        const msg = JSON.parse(msgStr) as Record<string, unknown>;
        const { promise, resolve, reject } = Promise.withResolvers<unknown>();
        const ws = (window as Window & { __benchWS?: WebSocket }).__benchWS;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject('WS not open');
          return promise;
        }
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          ws.removeEventListener('message', handler);
          reject(`timeout waiting for ${expectType}`);
        }, timeoutMs);
        const finish = (error?: unknown, payload?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.removeEventListener('message', handler);
          if (error !== undefined) reject(error);
          else resolve(payload);
        };
        const handler = (e: MessageEvent) => {
          try {
            const payload = JSON.parse(e.data as string) as Record<string, unknown>;
            if (payload.type !== expectType) return;
            // Match every correlation field shared by request and response.
            // In particular, completion/session operations must not consume
            // a response for another request or resident session.
            for (const key of ['requestId', 'sessionId', 'query', 'prefix', 'command', 'trigger']) {
              if (key in msg && key in payload && msg[key] !== payload[key]) return;
            }
            finish(undefined, payload);
          } catch {
            /* ignore malformed frames */
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify(msg));
        return promise;
      },
      { msgStr: JSON.stringify(msg), expectType, timeoutMs }
    );
  }

  async function measureRT(msg: object, expectType: string): Promise<number> {
    const t0 = performance.now();
    await requestResponse(msg, expectType);
    return performance.now() - t0;
  }
  console.log(`\n=== Browser input/render evidence ===`);
  const perfSupport = await page.evaluate(() => {
    const state = {
      longTasks: [] as number[],
      rafIntervals: [] as number[],
      inputToPaint: [] as number[],
      supported: { longTask: false, raf: typeof requestAnimationFrame === 'function' },
    };
    (window as unknown as { __benchPerf?: typeof state }).__benchPerf = state;
    if ('PerformanceObserver' in window) {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
        });
        observer.observe({ type: 'longtask', buffered: true });
        state.supported.longTask = true;
      } catch {
        state.supported.longTask = false;
      }
    }
    let previous = performance.now();
    const tick = (now: number) => {
      state.rafIntervals.push(now - previous);
      previous = now;
      requestAnimationFrame(tick);
    };
    if (state.supported.raf) requestAnimationFrame(tick);
    document.addEventListener(
      'input',
      () => {
        const inputAt = performance.now();
        requestAnimationFrame(() => state.inputToPaint.push(performance.now() - inputAt));
      },
      true
    );
    return state.supported;
  });
  const composer = page.locator('textarea:visible').first();
  if ((await composer.count()) === 0) {
    skipMetric('typing duration', 'visible composer textarea not found');
    skipMetric('input-to-paint', 'visible composer textarea not found');
  } else {
    await composer.waitFor({ state: 'visible' });
    const typingSamples = [
      'benchmark typing sample alpha',
      'benchmark typing sample beta',
      'benchmark typing sample gamma',
    ];
    for (const text of typingSamples) {
      await composer.focus();
      const typingStart = performance.now();
      await page.keyboard.type(text, { delay: 8 });
      recordEvidence('typing duration', performance.now() - typingStart);
      await composer.fill('');
      await page.waitForTimeout(40);
    }
  }
  await page.waitForTimeout(100);
  const browserEvidence = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __benchPerf?: { longTasks: number[]; rafIntervals: number[]; inputToPaint: number[] };
      }
    ).__benchPerf;
    return state ?? { longTasks: [], rafIntervals: [], inputToPaint: [] };
  });
  for (const value of browserEvidence.longTasks) recordEvidence('long task duration', value);
  for (const value of browserEvidence.rafIntervals) recordEvidence('rAF interval', value);
  for (const value of browserEvidence.inputToPaint) recordEvidence('input-to-paint', value);
  if (!perfSupport.longTask)
    skipMetric('long task duration', 'PerformanceObserver longtask is unsupported');
  if (!perfSupport.raf) skipMetric('rAF interval', 'requestAnimationFrame is unsupported');
  if (!browserEvidence.inputToPaint.length) {
    skipMetric('input-to-paint', 'no input samples were observed');
  }
  // ── Run measurements ────────────────────────────────────────────────────
  console.log(`\n=== Round-trip times ===`);
  for (let i = 0; i < 3; i++) {
    const ms = await measureRT({ type: 'get_providers' }, 'providers_list');
    recordRtt('get_providers', ms);
  }
  for (let i = 0; i < 3; i++) {
    const ms = await measureRT({ type: 'get_projects' }, 'projects_list');
    recordRtt('get_projects', ms);
  }
  {
    const ms = await measureRT({ type: 'get_resources' }, 'resources_list');
    recordRtt('get_resources', ms);
  }
  const dirs = ['.', './src', './src/lib'];
  for (const prefix of dirs) {
    const ms = await measureRT({ type: 'dir_complete', prefix }, 'dir_completions');
    recordRtt(`dir_complete('${prefix}')`, ms);
  }

  const queries = ['server', 'protocol', ''];
  for (const query of queries) {
    const requestId = `bench-file-${crypto.randomUUID()}`;
    const msg = {
      type: 'file_complete',
      sessionId: benchSessionId,
      requestId,
      query,
    };
    const ms = await measureRT(msg, 'file_completions');
    recordRtt(`file_complete('${query}')`, ms);
  }

  const allSessionsStart = performance.now();
  let allSessionsPayload = await requestResponse({ type: 'get_all_sessions' }, 'all_sessions_list');
  recordRtt('get_all_sessions', performance.now() - allSessionsStart);
  let sessions = Array.isArray(allSessionsPayload?.sessions) ? allSessionsPayload.sessions : [];

  // An isolated benchmark normally starts without persisted sessions. Create
  // two real sessions when possible, then re-read the catalog so switching
  // measures the same ID/path-addressed records a user sees.
  if (sessions.length < 2) {
    for (const targetCwd of [PROJECT_A, PROJECT_B]) {
      try {
        await requestResponse(
          { type: 'new_session', targetCwd, requestId: `bench-new-${crypto.randomUUID()}` },
          'session_loaded'
        );
      } catch (error) {
        skipMetric('warm session switch', `could not create a benchmark session: ${String(error)}`);
        break;
      }
    }
    try {
      allSessionsPayload = await requestResponse({ type: 'get_all_sessions' }, 'all_sessions_list');
      sessions = Array.isArray(allSessionsPayload?.sessions) ? allSessionsPayload.sessions : [];
    } catch (error) {
      skipMetric('warm session switch', `session catalog refresh failed: ${String(error)}`);
    }
  }

  const switchTargets = sessions
    .filter((session: any) => typeof session?.path === 'string' && typeof session?.id === 'string')
    .slice(0, 2);
  if (switchTargets.length < 2) {
    skipMetric('warm session switch', 'fewer than two persisted sessions with IDs and paths');
  } else {
    async function measureWarmSwitch(
      target: any
    ): Promise<{ sessionLoadedMs: number | null; visibleMs: number | null }> {
      const requestId = `bench-switch-${crypto.randomUUID()}`;
      const candidates = [
        target.name,
        target.firstMessage,
        !target.name && !target.firstMessage ? '(empty)' : null,
        String(target.path).split('/').pop(),
      ].filter((value) => typeof value === 'string' && value.length > 0);
      return page.evaluate(
        ({ path, targetId, requestId, candidates }) =>
          new Promise((resolve, reject) => {
            const ws = (window as any).__benchWS;
            if (!ws || ws.readyState !== WebSocket.OPEN) {
              reject('WS not open');
              return;
            }
            const started = performance.now();
            let sessionLoadedMs: number | null = null;
            let settled = false;
            const finish = (visibleMs: number | null) => {
              if (settled) return;
              settled = true;
              ws.removeEventListener('message', onMessage);
              resolve({ sessionLoadedMs, visibleMs });
            };
            const checkVisible = () => {
              const current = Array.from(document.querySelectorAll('button[aria-current="true"]'));
              const visible = current.some((button) => {
                const text = button.textContent ?? '';
                return candidates.some((candidate) => text.includes(candidate));
              });
              if (visible) finish(performance.now() - started);
              else if (performance.now() - started - (sessionLoadedMs ?? 0) > 1_500) finish(null);
              else requestAnimationFrame(checkVisible);
            };
            const onMessage = (event: MessageEvent) => {
              try {
                const payload = JSON.parse(event.data as string);
                if (
                  payload.type === 'session_loaded' &&
                  payload.sessionId === targetId &&
                  payload.requestId === requestId
                ) {
                  sessionLoadedMs = performance.now() - started;
                  requestAnimationFrame(checkVisible);
                }
              } catch {}
            };
            ws.addEventListener('message', onMessage);
            ws.send(JSON.stringify({ type: 'switch_session', path, requestId }));
            setTimeout(() => finish(null), 5_000);
          }),
        {
          path: target.path,
          targetId: target.id,
          requestId,
          candidates,
        }
      );
    }

    console.log(`\n=== Warm session switches ===`);
    for (const target of [switchTargets[0], switchTargets[1], switchTargets[0]]) {
      const result = await measureWarmSwitch(target);
      if (result.sessionLoadedMs !== null) {
        recordEvidence('warm switch request → session_loaded', result.sessionLoadedMs);
      } else {
        skipMetric('warm switch request → session_loaded', 'no matching session_loaded response');
      }
      if (result.visibleMs !== null) {
        recordEvidence('warm switch request → correct visible session', result.visibleMs);
      } else {
        skipMetric(
          'correct visible session',
          result.sessionLoadedMs === null
            ? 'no matching session_loaded response'
            : 'session_loaded arrived but no matching aria-current session row'
        );
      }
    }
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
  console.log(
    `    After SDK (1st WS):         ${(postConnRss / 1024).toFixed(1)} MB  (+${((postConnRss - idleRssKb) / 1024).toFixed(1)} MB)`
  );
  console.log(
    `    After benchmark:            ${(finalRss / 1024).toFixed(1)} MB  (+${((finalRss - idleRssKb) / 1024).toFixed(1)} MB)`
  );
  console.log(
    `    SDK overhead estimate:      ~${((postConnRss - idleRssKb) / 1024).toFixed(0)} MB`
  );
  console.log(`  CPU:`);
  console.log(`    Idle:                       ${idleCpu.toFixed(1)}%`);
  console.log(`    Post-connection:            ${postConnCpu.toFixed(1)}%`);
  console.log(`    Final:                      ${finalCpu.toFixed(1)}%`);
  console.log(`\n  Backend RTT distributions (kept separate from browser evidence):`);
  for (const [label, values] of Object.entries(rttSamples)) printDistribution(label, values);
  console.log(`\n  Browser evidence distributions:`);
  for (const [label, values] of Object.entries(evidenceSamples)) printDistribution(label, values);
  console.log(`\n  WebSocket transport:`);
  console.log(`    Frames sent:                 ${transport.sentFrames}`);
  console.log(`    Frames received:             ${transport.receivedFrames}`);
  console.log(`    UTF-8 bytes sent:            ${transport.sentUtf8Bytes}`);
  console.log(`    UTF-8 bytes received:        ${transport.receivedUtf8Bytes}`);
  if (skippedMetrics.length) {
    console.log(`\n  Skipped metrics (explicit):`);
    for (const metric of skippedMetrics) console.log(`    ${metric.label}: ${metric.reason}`);
  }
  console.log(`\n  Latency samples:`);
  const maxLabel = Math.max(...samples.map((s) => s.label.length));
  for (const s of samples) {
    console.log(`    ${s.label.padEnd(maxLabel)}  ${s.ms.toFixed(1).padStart(8)} ms`);
  }
} catch (err) {
  console.error('[bench] Error:', err instanceof Error ? err.stack : err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
