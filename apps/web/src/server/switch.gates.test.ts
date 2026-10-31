import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, type TestContext } from 'vitest';

const LEDGER = path.resolve(import.meta.dirname, '../../../../.ctc-dev/eval/switch.json');
type Row = { gate: string; status: string; passed: number; failed: number; skipped: number; reason?: string };

/** The rows of the last full `node .claude/metric/eval/switch/run.mjs`. */
function rows(): Row[] {
  expect(fs.existsSync(LEDGER), `${LEDGER} is missing: run node .claude/metric/eval/switch/run.mjs`).toBe(true);
  return (JSON.parse(fs.readFileSync(LEDGER, 'utf8')) as { rows: Row[] }).rows;
}

/** Skipped while `run.mjs` runs (its ledger is unfinished) and on a machine without the scratch services, where no gate run can exist. */
const skipped = (): boolean => process.env['CTC_SWITCH_RUNNING'] === '1' || (process.env['CTC_SCRATCH_PG_URL'] ?? '') === '';

function green(ctx: TestContext, gate: string): void {
  if (skipped()) return ctx.skip();
  const row = rows().find((r) => r.gate === gate);
  expect(row, `no row for ${gate}`).toBeDefined();
  expect(`${row?.status} ${row?.reason ?? ''}`.trim()).toBe('pass');
  if (gate !== 'ci') expect([row?.failed, row?.skipped, (row?.passed ?? 0) >= 1]).toEqual([0, 0, true]);
}

describe('switch.gates', () => {
  it('tenancy is green', (ctx) => green(ctx, 'tenancy'));
  it('failopen is green', (ctx) => green(ctx, 'failopen'));
  it('ci is green', (ctx) => green(ctx, 'ci'));
  it('graph.ids is green', (ctx) => green(ctx, 'graph.ids'));
  it('graph.resolve is green', (ctx) => green(ctx, 'graph.resolve'));
  it('graph.incremental is green', (ctx) => green(ctx, 'graph.incremental'));
  it('graph.query is green', (ctx) => green(ctx, 'graph.query'));
  it('suggest.latency is green', (ctx) => green(ctx, 'suggest.latency'));
  it('suggest.context is green', (ctx) => green(ctx, 'suggest.context'));
  it('library.version is green', (ctx) => green(ctx, 'library.version'));
  it('library.mcp is green', (ctx) => green(ctx, 'library.mcp'));
  it('library.override is green', (ctx) => green(ctx, 'library.override'));
  it('suggest.skills is green', (ctx) => green(ctx, 'suggest.skills'));
  it('memory.spool is green', (ctx) => green(ctx, 'memory.spool'));
  it('memory.idempotent is green', (ctx) => green(ctx, 'memory.idempotent'));
  it('memory.bands is green', (ctx) => green(ctx, 'memory.bands'));
  it('memory.context is green', (ctx) => green(ctx, 'memory.context'));
  it('memory.recall is green', (ctx) => green(ctx, 'memory.recall'));
  it('runner.lifecycle is green', (ctx) => green(ctx, 'runner.lifecycle'));
  it('runner.crash is green', (ctx) => green(ctx, 'runner.crash'));
  it('runner.fanout is green', (ctx) => green(ctx, 'runner.fanout'));
  it('runner.idempotent is green', (ctx) => green(ctx, 'runner.idempotent'));
  it('runner.md is green', (ctx) => green(ctx, 'runner.md'));
  it('dev-instance is green', (ctx) => green(ctx, 'dev-instance'));

  it('dashboard-e2e is reported as not run', (ctx) => {
    if (skipped()) return ctx.skip();
    const row = rows().find((r) => r.gate === 'dashboard-e2e');
    expect([row?.status, /O12/.test(row?.reason ?? '')]).toEqual(['not_run', true]);
  });
});
