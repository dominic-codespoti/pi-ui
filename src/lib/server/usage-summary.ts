/**
 * Cross-session usage summary built from the session scanner's per-file
 * day/model buckets — no session file is re-read to answer it.
 */
import type { UsageSummary, UsageTotals } from '../ws/protocol';
import type { SessionUsageBuckets } from './session-scan';

export type { UsageSummary, UsageTotals };

export const MAX_USAGE_DAYS = 366;
const MAX_PROJECT_ROWS = 10;

function emptyTotals(): UsageTotals {
  return { cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, messages: 0 };
}

function add(target: UsageTotals, cell: readonly number[]): void {
  target.cost += cell[0] ?? 0;
  target.tokens += cell[1] ?? 0;
  target.inputTokens += cell[2] ?? 0;
  target.outputTokens += cell[3] ?? 0;
  target.messages += cell[4] ?? 0;
}

function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function clampUsageDays(days: unknown): number {
  const n = typeof days === 'number' && Number.isFinite(days) ? Math.floor(days) : 30;
  return Math.min(MAX_USAGE_DAYS, Math.max(1, n));
}

export function summarizeUsage(
  files: ReadonlyArray<{ cwd: string; usage: SessionUsageBuckets }>,
  days: number,
  now: Date = new Date()
): UsageSummary {
  const window = clampUsageDays(days);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (window - 1));
  const since = localDay(start);
  const until = localDay(now);

  const totals = emptyTotals();
  const byDay = new Map<string, UsageTotals>();
  const byModel = new Map<string, UsageTotals>();
  const byProject = new Map<string, UsageTotals>();
  let sessionsWithUsage = 0;

  // Every day in the window appears, so a chart has no gaps.
  for (let i = 0; i < window; i++) {
    byDay.set(
      localDay(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)),
      emptyTotals()
    );
  }

  for (const file of files) {
    let counted = false;
    for (const [day, models] of Object.entries(file.usage)) {
      // ISO-like YYYY-MM-DD strings compare chronologically.
      if (day < since || day > until) continue;
      for (const [model, cell] of Object.entries(models)) {
        add(totals, cell);
        const dayTotals = byDay.get(day);
        if (dayTotals) add(dayTotals, cell);
        let modelTotals = byModel.get(model);
        if (!modelTotals) byModel.set(model, (modelTotals = emptyTotals()));
        add(modelTotals, cell);
        let projectTotals = byProject.get(file.cwd);
        if (!projectTotals) byProject.set(file.cwd, (projectTotals = emptyTotals()));
        add(projectTotals, cell);
        counted = true;
      }
    }
    if (counted) sessionsWithUsage++;
  }

  const ranked = <K extends string>(map: Map<string, UsageTotals>, key: K) =>
    [...map]
      .map(([name, value]) => ({ [key]: name, ...value }) as { [P in K]: string } & UsageTotals)
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  return {
    days: window,
    since,
    until,
    totals,
    byDay: [...byDay].map(([day, value]) => ({ day, ...value })),
    byModel: ranked(byModel, 'model'),
    byProject: ranked(byProject, 'cwd').slice(0, MAX_PROJECT_ROWS),
    sessionsWithUsage,
  };
}
