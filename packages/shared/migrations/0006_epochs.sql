-- 0006_epochs: the cache epoch counters of a project (read by repositories/projects.ts).

alter table {schema}.projects add column if not exists graph_epoch bigint not null default 0;
alter table {schema}.projects add column if not exists mem_epoch bigint not null default 0;
