-- 0003_library: capability library (versions, files, blobs, vectors, overrides).

create table {schema}.capabilities (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default 'local',
  namespace text not null,
  kind text not null check (kind in ('skill', 'agent', 'command', 'workflow')),
  name text not null,
  root_path text not null,
  served_version int,
  removed_at timestamptz,
  enrichment jsonb not null default '{}',
  unique (user_id, namespace, kind, name)
);

create table {schema}.capability_versions (
  id uuid primary key default gen_random_uuid(),
  cap_id uuid not null references {schema}.capabilities (id) on delete cascade,
  version int not null check (version >= 1),
  body_hash text not null,
  description text not null,
  frontmatter jsonb not null default '{}',
  labels text[] not null default '{}',
  commit_message text,
  created_at timestamptz not null default now(),
  unique (cap_id, version)
);
create index capability_versions_labels on {schema}.capability_versions using gin (labels);

-- A label sits on at most one version per capability. Moving it is allowed inside one transaction: clear it from the old version first.
create function {schema}.capability_label_guard() returns trigger
  language plpgsql
  as $$
begin
  if exists (
    select 1 from {schema}.capability_versions v
    where v.cap_id = new.cap_id and v.id <> new.id and v.labels && new.labels
  ) then
    raise exception 'label already on another version of capability %', new.cap_id using errcode = '23505';
  end if;
  return new;
end
$$;
create trigger capability_versions_label_guard
  before insert or update of labels on {schema}.capability_versions
  for each row execute function {schema}.capability_label_guard();

create table {schema}.cap_files (
  version_id uuid not null references {schema}.capability_versions (id) on delete cascade,
  path text not null,
  blob_hash text not null,
  primary key (version_id, path)
);

create table {schema}.cap_blobs (
  user_id text not null default 'local',
  hash text not null,
  content text not null,
  size int not null,
  primary key (user_id, hash)
);

create table {schema}.cap_vectors (
  cap_id uuid not null references {schema}.capabilities (id) on delete cascade,
  text_hash text not null,
  embedding extensions.vector(1024) not null,
  model text not null,
  primary key (cap_id, text_hash)
);
create index cap_vectors_hnsw on {schema}.cap_vectors using hnsw (embedding extensions.vector_cosine_ops);

create table {schema}.overrides (
  user_id text not null default 'local',
  project_id text,
  cap_id uuid not null references {schema}.capabilities (id) on delete cascade,
  action text not null check (action in ('pin', 'block')),
  label text,
  version int,
  unique nulls not distinct (user_id, project_id, cap_id)
);

alter table {schema}.capabilities enable row level security;
alter table {schema}.capability_versions enable row level security;
alter table {schema}.cap_files enable row level security;
alter table {schema}.cap_blobs enable row level security;
alter table {schema}.cap_vectors enable row level security;
alter table {schema}.overrides enable row level security;
