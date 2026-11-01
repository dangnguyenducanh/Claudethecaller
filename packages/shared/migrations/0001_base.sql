-- 0001_base: extensions, projects, sessions, history, jobs, idempotency keys, api keys, dedup review.
-- {schema} is replaced by the runner with the validated, quoted schema name; the runner creates the schema and schema_migrations itself.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create extension if not exists unaccent with schema extensions;

create table {schema}.projects (
  user_id text not null default 'local',
  id text not null,
  root text not null,
  profile_hash text,
  name text not null,
  embedding extensions.vector(1024),
  created_at timestamptz not null default now(),
  last_active timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, name)
);

create table {schema}.sessions (
  id text primary key,
  user_id text not null default 'local',
  project_id text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  model text not null default '',
  tokens bigint not null default 0,
  transcript_path text,
  title text not null default '',
  source text not null default 'hook' check (source in ('hook', 'history')),
  status text not null default 'processed' check (status in ('pending', 'processed', 'failed')),
  git_branch text,
  processed_at timestamptz,
  foreign key (user_id, project_id) references {schema}.projects (user_id, id) on delete cascade
);

create table {schema}.history_files (
  user_id text not null default 'local',
  path text not null,
  size bigint not null default 0,
  mtime bigint not null default 0,
  status text not null default 'imported' check (status in ('imported', 'skipped', 'failed')),
  session_id text,
  rows int not null default 0,
  error text,
  imported_at timestamptz not null default now(),
  primary key (user_id, path)
);

create table {schema}.jobs (
  id text primary key default gen_random_uuid()::text,
  user_id text not null default 'local',
  queue text not null check (queue in ('graph', 'library', 'llm', 'memory', 'runner', 'cleanup', 'dlq-retry')),
  kind text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'dead')),
  progress real not null default 0,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  payload jsonb not null default '{}',
  attempts int not null default 0,
  updated_at timestamptz not null default now()
);
create index jobs_queue_status on {schema}.jobs (queue, status, created_at);

create table {schema}.idempotency_keys (
  user_id text not null default 'local',
  key text not null,
  route text not null,
  payload_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);
create index idempotency_keys_created on {schema}.idempotency_keys (created_at);

create table {schema}.api_keys (
  id bigserial primary key,
  key_hash text not null unique,
  user_id text not null default 'local',
  name text not null default '',
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table {schema}.dedup_review (
  id bigserial primary key,
  user_id text not null default 'local',
  a text not null,
  b text not null,
  similarity real not null,
  status text not null default 'open' check (status in ('open', 'merged', 'kept_apart')),
  at timestamptz not null default now(),
  unique (user_id, a, b)
);

alter table {schema}.projects enable row level security;
alter table {schema}.sessions enable row level security;
alter table {schema}.history_files enable row level security;
alter table {schema}.jobs enable row level security;
alter table {schema}.idempotency_keys enable row level security;
alter table {schema}.api_keys enable row level security;
alter table {schema}.dedup_review enable row level security;
