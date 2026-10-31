-- 0002_graph: context + coding graph.

create table {schema}.graph_nodes (
  user_id text not null default 'local',
  project_id text not null,
  id text not null,
  kind text not null check (kind in ('code', 'doc', 'context', 'capability')),
  type text not null,
  label text not null,
  source_file text,
  source_location text,
  origin text not null check (origin in ('ast', 'parser', 'claude', 'commit', 'review', 'session')),
  content_hash text not null,
  embedding extensions.vector(1024),
  meta jsonb not null default '{}',
  text text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id, id)
);
create index graph_nodes_type on {schema}.graph_nodes (user_id, project_id, type);
create index graph_nodes_label on {schema}.graph_nodes using gin (to_tsvector('simple', label));
create index graph_nodes_hnsw on {schema}.graph_nodes using hnsw (embedding extensions.vector_cosine_ops);

create table {schema}.graph_edges (
  user_id text not null default 'local',
  project_id text not null,
  src text not null,
  dst text not null,
  relation text not null,
  confidence text not null check (confidence in ('CONFIRMED', 'EXTRACTED', 'INFERRED', 'AMBIGUOUS', 'DROPPED')),
  score real not null default 1,
  origin text not null check (origin in ('ast', 'parser', 'claude', 'commit', 'review', 'session')),
  source_location text,
  primary key (user_id, project_id, src, dst, relation)
);
create index graph_edges_src on {schema}.graph_edges (user_id, project_id, src, relation);
create index graph_edges_dst on {schema}.graph_edges (user_id, project_id, dst, relation);

create table {schema}.graph_sources (
  user_id text not null default 'local',
  project_id text not null,
  file text not null,
  content_hash text not null,
  extractor_version text not null,
  built_at_commit text,
  primary key (user_id, project_id, file)
);

alter table {schema}.graph_nodes enable row level security;
alter table {schema}.graph_edges enable row level security;
alter table {schema}.graph_sources enable row level security;
