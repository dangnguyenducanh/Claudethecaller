/**
 * Zod schema for `config/*.yaml` merged into one object (spec.md:208, 219).
 *
 * Used by: `./index.ts` only. Why: a typo or wrong type in an operator-written config must stop the start, not fall back
 * to a default. Deliberately not done: file or env reading, `~` expansion, legacy-key handling (all in `./index.ts`).
 * Keys keep today's snake_case names. Every missing key gets its default at every depth, hence `prefault({})` on sections.
 */
import { z } from 'zod';

/** Python-era top-level keys that stay valid while the Python service still reads the same files; kept untouched. */
export const LEGACY_KEYS = [
  'abstain_below',
  'gate_path',
  'gate_min_p',
  'gate',
  'agent_min_rerank',
  'blend',
  'memory_weight',
  'memory_in_query',
  'topic_shift_below',
  'graph_links',
  'writer',
  'jobs',
  'history',
  'graph_extract',
] as const;

const posInt = z.int().min(1);
const posNum = z.number().gt(0);
const weight = z.number().min(0);
const fraction = z.number().min(0).max(1);
const str = z.string().min(1);

const urlWithScheme = (schemes: readonly string[]) =>
  z.string().refine(
    (value) => {
      try {
        return schemes.includes(new URL(value).protocol.slice(0, -1));
      } catch {
        return false;
      }
    },
    { error: `must be a URL with scheme ${schemes.join(' or ')}` },
  );

/** Strict section (unknown key = issue) whose missing keys, and the missing section itself, take their defaults. */
const section = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape).prefault({} as never);

const ttl = z
  .looseObject({
    emb: posInt.default(604800),
    sug: posInt.default(3600),
    proj: posInt.default(86400),
    ovr: posInt.default(300),
    ctx: posInt.default(600),
    key: posInt.default(300),
    rl: posInt.default(60),
  })
  .prefault({});

const cache = z
  .looseObject({
    l1_size: posInt.default(256),
    redis_timeout_s: posNum.default(0.02),
    down_for_s: posInt.default(10),
    ttl,
  })
  .prefault({});

const DEFAULT_AGENTS = {
  claude: { argv: ['claude', '-p', '--output-format', 'stream-json'] },
  codex: { argv: ['codex', 'exec', '--json'] },
};

/** Configured agents are added to the built-ins (or replace one by name), never replace the whole map. */
const agents = z
  .record(z.string(), z.strictObject({ argv: z.array(str).min(1) }))
  .default({})
  .transform((configured) => ({ ...DEFAULT_AGENTS, ...configured }));

export const ConfigSchema = z.strictObject({
  embed_url: str.default('http://127.0.0.1:18300'),
  rerank_url: str.default('http://127.0.0.1:18301'),
  embed_model: str.default('ThakiCloud/SKILLRET-Embedding-0.6B'),
  embedding_dim: posInt.default(1024),
  timeout_s: posNum.default(2),
  batch_timeout_s: posInt.default(60),
  llm: str.default('openai:http://127.0.0.1:18302/v1:qwen2.5-3b'),

  k: posInt.default(5),
  depth: posInt.default(50),
  rerank_top: posInt.default(20),
  rrf_k: posInt.default(60),
  embed: section({
    text: z.enum(['current', 'skillret']).default('skillret'),
    instruction: z.enum(['coding', 'skillret']).default('skillret'),
    skillret_body_chars: posInt.default(8000),
  }),
  ranking: section({
    keyword_rrf_weight: weight.default(0),
    rerank_weight: weight.default(0),
    fusion: z.enum(['rrf', 'score']).default('rrf'),
    score_w: fraction.default(0.7),
    rerank_by: z.enum(['sigmoid', 'logit']).default('sigmoid'),
  }),
  graph_push: section({
    floor: fraction.default(0.3),
    max_pointers: posInt.default(3),
    max_chars: posInt.default(400),
    note_max: posInt.default(3),
  }),

  mode: z.enum(['local', 'shared']).default('local'),
  port: z.int().min(1).max(65535).default(18310),
  socket: str.default('~/.claudethecaller/ctc.sock'),
  redis_url: urlWithScheme(['redis', 'rediss']).default('redis://127.0.0.1:18303/0'),
  database_url: urlWithScheme(['postgres', 'postgresql']).nullable().default(null),
  claude_home: str.default('~/.claude'),
  trash_dir: str.default('~/.claudethecaller/trash'),
  rate_limit_per_min: posInt.default(600),
  db_pool: section({ min: posInt.default(3), max: posInt.default(5) }),
  cache,

  graph: section({
    languages: z
      .array(str)
      .default(['ts', 'tsx', 'js', 'python', 'bash', 'sql', 'json', 'markdown']),
    query: section({
      seeds: posInt.default(3),
      depth: posInt.default(2),
      hub_min: posInt.default(50),
      budget_tokens: posInt.default(2000),
    }),
    shrink_guard: fraction.default(0.2),
    debounce_s: posInt.default(3),
    hint: section({
      per_session: posInt.default(5),
      quiet_s: posInt.default(1800),
      max_nodes: posInt.default(5),
    }),
  }),
  library: section({
    roots: z.array(str).default(['~/.claude']),
    default_label: str.default('production'),
    dedup_cosine: fraction.default(0.92),
    max_files: posInt.default(200),
    max_bytes: posInt.default(1048576),
  }),
  spool: section({
    dir: str.default('~/.claudethecaller/spool'),
    keep_days: posInt.default(7),
  }),
  memory: section({
    context_chars: posInt.default(10000),
    rrf: section({ k: posInt.default(60), per_leg: posInt.default(100) }),
    bands: section({ noop: fraction.default(0.95), update: fraction.default(0.85) }),
    half_life_days: posInt.default(30),
    start: section({ summaries: posInt.default(3), memories: posInt.default(30) }),
  }),
  runner: section({
    worktree: section({
      add_timeout_s: posInt.default(180),
      keep_days: posInt.default(7),
      dir: str.default('.ctc/wt'),
    }),
    setup: section({
      timeout_s: posInt.default(120),
      max_output_mb: posInt.default(10),
      policy: z.enum(['run', 'ask', 'skip']).default('run'),
    }),
    max_failures: posInt.default(3),
    fanout: section({ max_depth: posInt.default(1), max_parallel: posInt.default(3) }),
    agents,
    max_visits: posInt.default(3),
    claude_version: z.string().optional(),
    idle_wait_min: posNum.optional(),
    poll_s: posNum.optional(),
  }),

  legacy: z.record(z.string(), z.unknown()).default({}),
});

export type Config = z.output<typeof ConfigSchema>;
