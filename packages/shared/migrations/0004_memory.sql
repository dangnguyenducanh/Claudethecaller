-- 0004_memory: long-term memories and per-session summaries.

create table {schema}.memories (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default 'local',
  scope text not null check (scope in ('global', 'project')),
  project_id text,
  kind text not null check (kind in ('preference', 'convention', 'fact', 'skill_outcome')),
  text text not null,
  hash text not null,
  source jsonb not null default '{}',
  superseded_by uuid references {schema}.memories (id),
  confidence real not null default 0.5,
  pinned boolean not null default false,
  reinforcement_dates date[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  use_count int not null default 0,
  deleted_at timestamptz,
  -- judgment: nullable; a memory row may exist before its embedding job ran (and the hash-uniqueness check needs rows without one).
  embedding extensions.vector(1024),
  tsv tsvector generated always as (to_tsvector('simple', text)) stored,
  check ((scope = 'global') = (project_id is null)),
  foreign key (user_id, project_id) references {schema}.projects (user_id, id) on delete cascade
);
create unique index memories_hash on {schema}.memories (user_id, scope, project_id, hash) nulls not distinct;
create index memories_tsv on {schema}.memories using gin (tsv);
create index memories_hnsw on {schema}.memories using hnsw (embedding extensions.vector_cosine_ops);
create index memories_live on {schema}.memories (user_id, scope, project_id) where deleted_at is null;

create table {schema}.session_summaries (
  session_id text primary key references {schema}.sessions (id) on delete cascade,
  user_id text not null default 'local',
  project_id text not null,
  request text not null default '',
  investigated text not null default '',
  learned text not null default '',
  completed text not null default '',
  next_steps text not null default '',
  notes text not null default '',
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (user_id, content_hash)
);

alter table {schema}.memories enable row level security;
alter table {schema}.session_summaries enable row level security;
