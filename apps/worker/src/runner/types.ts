/**
 * Shared types and tiny helpers of the runner cold path. Called from: every file of this directory. Why: `RunnerExecDeps` is the one seam to
 * the worker main and to T6.3 (D9); the attempt-dir file names are written once so the handler and the restart sweep agree on them.
 * Deliberately NOT done: any logic, I/O or defaults.
 */
import path from 'node:path';
import type { AgentNode } from '@ctc/core/runner';
import type { Ctx, Repositories } from '@ctc/shared/repositories';

export type Step = NonNullable<Awaited<ReturnType<Repositories['runner']['getStep']>>>;
export type Run = NonNullable<Awaited<ReturnType<Repositories['runner']['getRun']>>>;

export type RunnerExecDeps = {
  repos: Repositories;
  config: {
    runner: {
      max_failures: number;
      worktree: { add_timeout_s: number; dir: string };
      setup: { timeout_s: number; max_output_mb: number; policy: 'run' | 'ask' | 'skip' };
      agents: Record<string, { argv: string[] }>;
    };
  };
  /** Absolute directory that holds one directory per run (the attempt dir). */
  runsDir: string;
  /** A dev instance (`CTC_HOME` set) never spawns an agent or creates a worktree. */
  dev?: boolean;
  /** Base URL of the report route, e.g. `http://127.0.0.1:18410`. */
  reportBase: string;
  resolveNode(ctx: Ctx, run: Run, step: Step): Promise<AgentNode | null>;
  onStepEnd?(ctx: Ctx, step: Step): Promise<void>;
  log?(message: string, fields?: Record<string, unknown>): void;
};

/** Every file of one attempt lives in `<runsDir>/<runId>/` and is named by the step id (D14b). */
export function attemptPaths(runsDir: string, runId: number, stepId: number) {
  const dir = path.join(runsDir, String(runId));
  const f = (ext: string): string => path.join(dir, `${stepId}.${ext}`);
  return { dir, prompt: f('prompt'), log: f('jsonl'), err: f('err'), exit: f('exit'), setup: f('setup.log'), git: f('git') };
}

/** `ConflictError` of the repositories and `RunnerError('conflict')` of the core both carry this code. */
export const isConflict = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === 'conflict';
export const errClass = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
