-- 0005_runner: workflow runs, steps and schedules.

create table {schema}.wf_runs (
  id bigint generated always as identity primary key,
  user_id text not null default 'local',
  owner text not null,
  workflow_cap_id uuid references {schema}.capabilities (id) on delete set null,
  workflow_version int not null default 1,
  status text not null default 'queued' check (status in ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled', 'quota')),
  state jsonb not null default '{}',
  trigger text not null check (trigger in ('button', 'cli', 'api', 'schedule', 'mcp')),
  inputs jsonb not null default '{}',
  repo text,
  base_branch text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  legacy jsonb not null default '{}'
);
create unique index wf_runs_one_running on {schema}.wf_runs (owner) where status = 'running';
create index wf_runs_owner on {schema}.wf_runs (owner, id desc);

create table {schema}.wf_steps (
  id bigint generated always as identity primary key,
  run_id bigint not null references {schema}.wf_runs (id) on delete cascade,
  node_id text not null,
  visit int not null check (visit >= 1),
  attempt int not null default 1 check (attempt >= 1),
  retry_of_step_id bigint references {schema}.wf_steps (id),
  failure_count int not null default 0 check (failure_count >= 0),
  parent_step_id bigint references {schema}.wf_steps (id),
  status text not null check (status in ('queued', 'running', 'waiting', 'done', 'failed', 'timeout', 'start_unknown', 'quota', 'skipped', 'cancelled', 'circuit_broken')),
  stage text check (stage in ('worktree', 'setup', 'spawn', 'stream', 'report')),
  liveness text check (liveness in ('alive', 'start_unknown')),
  pid int,
  pid_started_at timestamptz,
  token_hash text,
  worktree text,
  branch text,
  options jsonb,
  resolution text,
  prompt_outcome text check (prompt_outcome in ('delivered', 'not_delivered', 'unconfirmed')),
  output jsonb,
  usage jsonb,
  cost_usd real,
  error text,
  log_path text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  legacy jsonb not null default '{}',
  unique (run_id, node_id, visit, attempt)
);
create index wf_steps_run on {schema}.wf_steps (run_id);

create table {schema}.wf_schedules (
  user_id text not null default 'local',
  owner text not null,
  workflow text not null,
  cron text not null,
  input text not null default '',
  enabled boolean not null default true,
  last_fired_at timestamptz,
  primary key (user_id, owner, workflow)
);

alter table {schema}.wf_runs enable row level security;
alter table {schema}.wf_steps enable row level security;
alter table {schema}.wf_schedules enable row level security;
