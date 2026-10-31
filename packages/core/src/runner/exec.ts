/**
 * Pure part of the F4 runner cold path: the agent registry (argv), the stream reader, the worktree recipe, the repo `ctc.yaml` setup parser,
 * the agent preamble, the restart-sweep decision and the exit outcome. Called from: `apps/worker/src/runner` (the `runner.step` handler and the
 * restart sweep). Why: every decision that needs no process, file or database lives here so it can be tested without any of them.
 * Deliberately NOT done: any I/O (no `node:*` import, `@ctc/shared` only as types), killing, spawning, status writes (T6.1 core and the worker).
 * Untrusted: every argument (workflow text, run row, repo `ctc.yaml`, agent output lines). No function throws on odd input except where its
 * comment says so; none edits an argument.
 */
import { parse } from 'yaml';

/** spec:658-659 and DECISIONS D9: the two agents with a registry entry. */
export const AGENTS = ['claude', 'codex'] as const;
/** spec:596; `bypassPermissions` is deliberately absent (spec:603). */
export const PERMISSIONS = ['acceptEdits', 'dontAsk', 'plan'] as const;

/**
 * Read at call time so a test can change and restore it (D2). Every number is chosen by judgment except `defaultTimeoutS` (spec:596),
 * `summaryMax` (the web `summaryMax`) and `errorMax` (the web `reasonMax`).
 */
export const runnerExecLimits = {
  killGraceMs: 5000,
  tailPollMs: 250,
  statusPollMs: 2000,
  reportExitGraceMs: 30000,
  quotaExitGraceMs: 10000,
  exitRecordGraceMs: 500,
  pidStartToleranceMs: 1000,
  summaryMax: 20000,
  errorMax: 2000,
  gitTimeoutMs: 30000,
  defaultTimeoutS: 1800,
};

export type AgentNode = {
  agent: string;
  prompt: string;
  worktree: 'new' | 'parent' | 'none';
  permission: string;
  model?: string | null;
  timeoutS: number;
  workflow: string;
  child?: string | number | null;
  base?: string | null;
  parentWorktree?: string | null;
  resolution?: string | null;
  setupDecision?: 'run' | 'skip' | null;
};

const BANNED_FLAGS = ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox'];
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,99}$/;

/**
 * Full argv of an agent (prompt is NOT in it, it goes to stdin). `base` is the configured argv. Returns a new array.
 * Throws `TypeError` whose message is the `<reason>` of `spawn refused: <reason>` for an unknown or unconfigured agent, a permission outside
 * `PERMISSIONS`, a model outside the allowed pattern or a banned flag in `base`.
 */
export function agentArgv(
  agent: string, base: readonly string[] | undefined, o: { permission: string; model?: string | null | undefined },
): string[] {
  if (!(AGENTS as readonly string[]).includes(agent) || !Array.isArray(base)) throw new TypeError(`unknown agent ${String(agent)}`);
  if (!(PERMISSIONS as readonly string[]).includes(o.permission)) throw new TypeError(`permission ${String(o.permission)} not allowed`);
  const model = o.model;
  if (model !== undefined && model !== null && (typeof model !== 'string' || !MODEL.test(model))) throw new TypeError('model not allowed');
  for (const flag of BANNED_FLAGS) if (base.includes(flag)) throw new TypeError(`banned flag ${flag}`);
  const modelArgs = model === undefined || model === null ? [] : ['--model', model];
  if (agent === 'claude') return [...base, ...(base.includes('--verbose') ? [] : ['--verbose']), '--permission-mode', o.permission, ...modelArgs];
  return [...base, '--sandbox', o.permission === 'plan' ? 'read-only' : 'workspace-write', ...modelArgs];
}

export type StreamState = {
  events: number;
  lastMessage: string | null;
  usage: Record<string, unknown> | null;
  costUsd: number | null;
  quota: { resetsAt: string | null } | null;
  error: string | null;
};

export const emptyStream = (): StreamState => ({ events: 0, lastMessage: null, usage: null, costUsd: null, quota: null, error: null });

/** spec:661; seen real text: "You've hit your session limit · resets 3pm". A false positive would park a healthy step. */
const USAGE_LIMIT = /usage limit|hit your (\w+ )?limit/i;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Reads one stdout line of an agent. Never throws, never edits `state`, returns a new state. A line that is not a JSON object returns `state`.
 * Unknown event types only count. Shapes for codex are partly unverified (OPEN.md), so every field is read defensively.
 */
export function readStreamLine(agent: string, state: StreamState, line: string): StreamState {
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return state;
  }
  if (!isObj(ev)) return state;
  const next: StreamState = { ...state, events: state.events + 1 };
  const { summaryMax, errorMax } = runnerExecLimits;
  const quotaOf = (text: unknown): void => {
    if (typeof text === 'string' && USAGE_LIMIT.test(text) && next.quota === null) next.quota = { resetsAt: null };
  };
  if (agent === 'claude') {
    if (ev['type'] === 'assistant' && isObj(ev['message']) && Array.isArray(ev['message']['content'])) {
      const text = ev['message']['content'].filter((p): p is { text: string } => isObj(p) && p['type'] === 'text' && typeof p['text'] === 'string').map((p) => p.text).join('\n');
      if (text !== '') next.lastMessage = text.slice(0, summaryMax);
    } else if (ev['type'] === 'result') {
      if (typeof ev['result'] === 'string') next.lastMessage = ev['result'].slice(0, summaryMax);
      if (isObj(ev['usage'])) next.usage = ev['usage'];
      if (typeof ev['total_cost_usd'] === 'number' && Number.isFinite(ev['total_cost_usd'])) next.costUsd = ev['total_cost_usd'];
      if (ev['is_error'] === true) quotaOf(ev['result']);
    } else if (ev['type'] === 'rate_limit_event' && isObj(ev['rate_limit_info']) && ev['rate_limit_info']['status'] === 'rejected') {
      const at = ev['rate_limit_info']['resetsAt'];
      const date = typeof at === 'number' && Number.isFinite(at) ? new Date(at * 1000) : null;
      next.quota = { resetsAt: date !== null && !Number.isNaN(date.getTime()) ? date.toISOString() : null };
    }
  } else if (agent === 'codex') {
    const item = ev['item'];
    if (ev['type'] === 'item.completed' && isObj(item) && item['type'] === 'agent_message' && typeof item['text'] === 'string') {
      next.lastMessage = item['text'].slice(0, summaryMax);
    } else if (ev['type'] === 'turn.completed' && isObj(ev['usage'])) {
      next.usage = ev['usage'];
    } else if (ev['type'] === 'error' || ev['type'] === 'turn.failed') {
      const message = ev['type'] === 'error' ? ev['message'] : isObj(ev['error']) ? ev['error']['message'] : undefined;
      if (typeof message === 'string') {
        next.error = message.slice(0, errorMax);
        quotaOf(message);
      }
    }
  }
  return next;
}

const clean = (v: unknown): string => String(v).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
const segments = (p: string): string[] => p.split('/').filter((s) => s !== '' && s !== '.');

/**
 * The worktree of one attempt (spec:646-649). Pure. Throws `TypeError` when `repo` is not absolute, `dir` is absolute or has a `..` segment,
 * or `base` is empty, not a string or starts with `-`. The branch carries `-v<visit>` / `-a<attempt>` so a retry or a loop never collides with a
 * kept branch (the spec name alone would).
 */
export function worktreeRecipe(o: {
  repo: string; dir: string; workflow: string; runId: number | string; nodeId: string; stepId: number | string; visit: number; attempt: number;
  child?: string | number | null | undefined; base: string;
}): { branch: string; path: string; add: string[]; config: string[] } {
  if (typeof o.repo !== 'string' || !o.repo.startsWith('/')) throw new TypeError('repo must be an absolute path');
  if (typeof o.dir !== 'string' || o.dir.startsWith('/') || o.dir.split('/').includes('..')) throw new TypeError('dir must be relative without ..');
  if (typeof o.base !== 'string' || o.base === '' || o.base.startsWith('-')) throw new TypeError('invalid base');
  const parts = [o.workflow, o.runId, o.nodeId, ...(o.child === undefined || o.child === null ? [] : [o.child])].map(clean);
  const branch = `ctc/${parts.join('-')}${o.visit > 1 ? `-v${o.visit}` : ''}${o.attempt > 1 ? `-a${o.attempt}` : ''}`;
  const path = `/${[...segments(o.repo), ...segments(o.dir), String(o.runId), String(o.stepId)].join('/')}`;
  return { branch, path, add: ['worktree', 'add', '--no-track', '-b', branch, path, o.base], config: ['config', `branch.${branch}.base`, o.base] };
}

/**
 * Setup commands of a repo `ctc.yaml` (spec:650). `setup` may be a string or an array of strings; blank entries are dropped; a missing file text,
 * a document without `setup` or a non-mapping document gives `[]`. Throws `TypeError` for invalid YAML or any other `setup` type.
 */
export function parseRepoSetup(text: string): { setup: string[] } {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    throw new TypeError('ctc.yaml is not valid YAML');
  }
  const setup = isObj(doc) ? doc['setup'] : undefined;
  if (setup === undefined || setup === null) return { setup: [] };
  const list = typeof setup === 'string' ? [setup] : setup;
  if (!Array.isArray(list) || !list.every((e) => typeof e === 'string')) throw new TypeError('setup must be a string or a list of strings');
  return { setup: list.filter((e) => e.trim() !== '') };
}

/**
 * The text an agent receives on stdin (spec:654): step goal, gate resolution if any, how to report. Pure and deterministic. It names the
 * environment variables that hold the report URL and the step token, never a token value.
 */
export function buildPreamble(o: { workflow: string; nodeId: string; attempt: number; prompt: string; resolution?: string | null | undefined }): string {
  return [
    `You are running step "${o.nodeId}" of workflow "${o.workflow}" (attempt ${o.attempt}).`,
    '',
    '## Your task',
    o.prompt,
    ...(o.resolution ? ['', '## Decision already made for this step', o.resolution] : []),
    '',
    '## How to report',
    'When you are finished, report the result once with this command (the URL and the token are in your environment):',
    '',
    '    curl -sS -X POST "$CTC_REPORT_URL" -H "Content-Type: application/json" -H "X-CTC-Step-Token: $CTC_STEP_TOKEN" \\',
    '      -d \'{"outcome":"done","summary":"<what you did>"}\'',
    '',
    'Use "outcome":"failed" when you could not finish. If you exit without reporting, the step counts as done with your last message as the summary.',
    '',
  ].join('\n');
}

export type SweepProbe = { exitCode: number | null; startedAt: Date | null };

/**
 * What the restart sweep does with one `running` step (spec:682-686). `startedAt` is the start time of the live process with `step.pid`
 * (null when none). A stage before `spawn` was interrupted; an exit record means the agent finished; a live pid whose start time matches
 * `pidStartedAt` (within `pidStartToleranceMs`, inclusive) is reattached; anything else is unknown and is never acted on (spec:686).
 */
export function sweepAction(
  step: { stage: string | null; pid: number | null; pidStartedAt: Date | null }, probe: SweepProbe,
): 'fail_stage' | 'finish' | 'reattach' | 'start_unknown' {
  if (step.stage === null || step.stage === 'worktree' || step.stage === 'setup') return 'fail_stage';
  if (probe.exitCode !== null) return 'finish';
  if (step.pid !== null && step.pidStartedAt !== null && probe.startedAt !== null
    && Math.abs(probe.startedAt.getTime() - step.pidStartedAt.getTime()) <= runnerExecLimits.pidStartToleranceMs) return 'reattach';
  return 'start_unknown';
}

/**
 * Final status of an attempt whose agent process exited (spec:662-666): exit 0 is `done` with the last message as summary; any other
 * exit is `failed` with `exit <n>` and the last non-empty line of the stderr tail. Summary and error are cut to their limits.
 */
export function exitOutcome(o: { exitCode: number; stream: StreamState; stderrTail?: string | undefined }): {
  to: 'done' | 'failed'; output: { outcome: 'done' | 'failed'; summary: string | null }; error: string | null;
} {
  const summary = o.stream.lastMessage === null ? null : o.stream.lastMessage.slice(0, runnerExecLimits.summaryMax);
  if (o.exitCode === 0) return { to: 'done', output: { outcome: 'done', summary }, error: null };
  const last = (o.stderrTail ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '').pop();
  const error = `exit ${o.exitCode}${last === undefined ? '' : `: ${last}`}`.slice(0, runnerExecLimits.errorMax);
  return { to: 'failed', output: { outcome: 'failed', summary }, error };
}
