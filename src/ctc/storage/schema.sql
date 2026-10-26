-- claudethecaller schema (PLAN.md B3). Idempotent; Store.open() replaces {schema} with a code constant (ctc, ctc_skillret).
-- Columns added after a table first shipped go in `alter table … add column if not exists` (create … if not exists skips them).

-- The whole file runs as one implicit transaction (simple query): the advisory lock serializes concurrent applies
-- (N workers starting at once otherwise hit 'tuple concurrently updated' / duplicate pg_namespace rows).
select pg_advisory_xact_lock(7426001);

create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create extension if not exists unaccent with schema extensions;
create schema if not exists {schema};

-- immutable wrappers so unaccent can feed a generated column (array_to_string is only stable)
create or replace function {schema}.unaccent_i(text) returns text
  language sql immutable strict parallel safe
  as $$ select extensions.unaccent('extensions.unaccent'::regdictionary, $1) $$;

create or replace function {schema}.cap_text(name text, description text, summary text, triggers text[]) returns text
  language sql immutable parallel safe
  as $$ select {schema}.unaccent_i($1 || ' ' || $2 || ' ' || coalesce($3, '') || ' ' || array_to_string(coalesce($4, '{}'), ' ')) $$;

create table if not exists {schema}.capabilities (
  id text primary key,
  kind text not null,
  name text not null,
  namespace text not null,
  invoke text not null,
  description text not null,
  body text not null default '',
  path text not null,
  hash text not null,
  summary text,
  triggers text[] not null default '{}',
  enricher_version text,
  cluster_id text,
  updated_at timestamptz not null default now(),
  tsv tsvector generated always as (to_tsvector('simple', {schema}.cap_text(name, description, summary, triggers))) stored
);
create index if not exists capabilities_tsv on {schema}.capabilities using gin (tsv);
create index if not exists capabilities_namespace on {schema}.capabilities (namespace);

create table if not exists {schema}.cap_vectors (
  cap_id text not null references {schema}.capabilities (id) on delete cascade,
  text_hash text not null,
  model text not null,
  text text not null,
  embedding extensions.vector(1024) not null,
  primary key (cap_id, text_hash)
);
create index if not exists cap_vectors_hnsw on {schema}.cap_vectors using hnsw (embedding extensions.vector_cosine_ops);

create table if not exists {schema}.projects (
  user_id text not null default 'local',
  id text not null,  -- sha256(resolved cwd)[:8]
  name text not null,
  path text not null,
  profile_hash text,
  embedding extensions.vector(1024),
  created_at timestamptz not null default now(),
  last_active timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, name)
);

create table if not exists {schema}.overrides (
  user_id text not null default 'local',
  project text not null,  -- project id or '*' = all projects
  cap_id text not null,
  action text not null check (action in ('pin', 'block', 'disable')),
  at timestamptz not null default now(),
  primary key (user_id, project, cap_id)
);

create table if not exists {schema}.sessions (
  id text primary key,
  user_id text not null default 'local',
  project_id text not null,
  title text not null default '',
  model text not null default '',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  turns int not null default 0,
  tokens bigint not null default 0,
  foreign key (user_id, project_id) references {schema}.projects (user_id, id) on delete cascade
);
create index if not exists sessions_project on {schema}.sessions (user_id, project_id, started_at desc);

create table if not exists {schema}.events (
  id bigserial primary key,
  session_id text not null references {schema}.sessions (id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}',
  at timestamptz not null default now()
);
create index if not exists events_session on {schema}.events (session_id);

create table if not exists {schema}.decisions (
  id bigserial primary key,
  user_id text not null default 'local',
  session_id text not null references {schema}.sessions (id) on delete cascade,
  project_id text not null,
  ref text not null,
  prompt text not null,
  abstained boolean not null,
  followed boolean not null default false,
  confidence real not null default 0,
  difficulty text not null default 'standard',
  model_tier text not null default 'sonnet',
  latency_ms real not null default 0,
  bundle jsonb not null,             -- Bundle.model_dump()
  stages jsonb not null default '[]', -- StageRow[]
  at timestamptz not null default now(),
  unique (session_id, ref)
);
create index if not exists decisions_project on {schema}.decisions (user_id, project_id, at desc);
create index if not exists decisions_user on {schema}.decisions (user_id, at desc);

create table if not exists {schema}.memories (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default 'local',
  scope text not null check (scope in ('global', 'project')),
  project_id text,  -- null for global
  kind text not null check (kind in ('preference', 'convention', 'fact', 'skill_outcome')),
  text text not null,
  hash text not null,
  source jsonb not null default '{}',
  supersedes uuid references {schema}.memories (id),
  confidence real not null default 0.5,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  use_count int not null default 0,
  deleted_at timestamptz,
  embedding extensions.vector(1024) not null,
  foreign key (user_id, project_id) references {schema}.projects (user_id, id) on delete cascade
);
create index if not exists memories_hnsw on {schema}.memories using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists memories_live on {schema}.memories (user_id, scope, project_id) where deleted_at is null;

create table if not exists {schema}.dedup_review (
  id bigserial primary key,
  a text not null,
  b text not null,
  similarity real not null,
  status text not null default 'open' check (status in ('open', 'merged', 'kept_apart')),
  at timestamptz not null default now(),
  unique (a, b)
);

create table if not exists {schema}.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default 'local',
  kind text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  progress real not null default 0,
  payload jsonb not null default '{}',
  result jsonb,
  error text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- B9 history import (PLAN.md "History import design"): one row per main transcript; size/mtime cover its subagents/ too
create table if not exists {schema}.history_files (
  user_id text not null default 'local',
  path text not null,
  session_id text,
  size bigint not null default 0,   -- bytes of <session>.jsonl + <session>/subagents/*.jsonl
  mtime bigint not null default 0,  -- newest st_mtime_ns of those files
  rows int not null default 0,
  status text not null default 'imported' check (status in ('imported', 'skipped', 'failed')),
  error text,
  imported_at timestamptz not null default now(),
  primary key (user_id, path)
);
alter table {schema}.sessions
  add column if not exists source text not null default 'hook' check (source in ('hook', 'history')),
  add column if not exists status text not null default 'processed' check (status in ('pending', 'processed', 'failed')),
  add column if not exists summary text,
  add column if not exists git_branch text,
  add column if not exists transcript_path text,
  add column if not exists processed_at timestamptz;
alter table {schema}.decisions add column if not exists source text not null default 'hook' check (source in ('hook', 'history'));

create table if not exists {schema}.api_keys (
  id bigserial primary key,
  key_hash text not null unique,
  user_id text not null,
  name text not null default '',
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Workflow runner (PLAN.md m5 "Data model"). Logs live on disk (~/.claudethecaller/runs/<id>/), not here.
create table if not exists {schema}.wf_runs (
  id bigint generated always as identity primary key,
  owner text not null,                                   -- claude auth status .email
  workflow text not null,                                -- cap_id
  project_id text,  -- no FK: projects is keyed (user_id, id)
  file_sha text not null,
  graph jsonb not null,                                  -- snapshot at submit
  trigger text not null check (trigger in ('button', 'cli', 'api', 'schedule', 'mcp')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled', 'quota')),
  input text not null default '',
  state jsonb not null default '{}',                     -- walker state, ctc.runner.graph
  repo text, worktree text, branch text, base_sha text, pr_url text,
  auth jsonb,                                            -- {authMethod, email, claude_version}
  error text,
  quota_resets_at timestamptz,
  auto_resume boolean not null default true,
  tokens bigint not null default 0,                      -- running total, for max_run_tokens
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz
);
create unique index if not exists wf_runs_one_running on {schema}.wf_runs (owner) where status = 'running';
create index if not exists wf_runs_owner on {schema}.wf_runs (owner, id desc);

create table if not exists {schema}.wf_steps (
  id bigint generated always as identity primary key,
  run_id bigint not null references {schema}.wf_runs (id) on delete cascade,
  node_id text not null,
  visit int not null,
  kind text not null,                                    -- trigger|agent|shell|if|merge|approval
  status text not null check (status in ('running', 'waiting', 'done', 'failed', 'timeout', 'cancelled', 'quota', 'skipped')),
  input text, output jsonb, error text,
  session_id text, num_turns int, usage jsonb, cost_usd real,   -- cost is notional
  permission_denials jsonb, overage boolean,
  pre_sha text, post_sha text, files jsonb, diff text,          -- diff <= 64 KB
  log_path text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (run_id, node_id, visit)
);
-- a retry / run-from / run-to: a new run linked to its parent (set null, so pruning a parent never fails)
alter table {schema}.wf_runs
  add column if not exists parent_run_id bigint references {schema}.wf_runs (id) on delete set null,
  add column if not exists from_node text,
  add column if not exists to_node text;
-- run started with pinned: nodes with pin return pin.output (editor and CLI only)
alter table {schema}.wf_runs add column if not exists pinned boolean not null default false;
-- marker = completed without executing (reused from the parent run, pinned output, disabled pass-through)
alter table {schema}.wf_steps add column if not exists marker text check (marker in ('reused', 'pinned', 'disabled'));
alter table {schema}.wf_steps add column if not exists tries int not null default 1;  -- shell retry-on-fail tries (US7)

create table if not exists {schema}.wf_schedules (
  owner text not null,
  workflow text not null,
  cron text not null,
  input text not null default '',
  enabled boolean not null default true,
  last_fired_at timestamptz,
  primary key (owner, workflow)
);

-- RLS on, no policies: only the postgres role (bypasses RLS) touches these tables.
alter table {schema}.capabilities enable row level security;
alter table {schema}.cap_vectors enable row level security;
alter table {schema}.projects enable row level security;
alter table {schema}.overrides enable row level security;
alter table {schema}.sessions enable row level security;
alter table {schema}.events enable row level security;
alter table {schema}.decisions enable row level security;
alter table {schema}.memories enable row level security;
alter table {schema}.dedup_review enable row level security;
alter table {schema}.jobs enable row level security;
alter table {schema}.api_keys enable row level security;
alter table {schema}.history_files enable row level security;
alter table {schema}.wf_runs enable row level security;
alter table {schema}.wf_steps enable row level security;
alter table {schema}.wf_schedules enable row level security;
