-- 0007_memory_fixes: a session that ends again with more content gets another summary; the extract cursor of a session.

alter table {schema}.session_summaries drop constraint session_summaries_pkey;
alter table {schema}.session_summaries add primary key (session_id, content_hash);
alter table {schema}.sessions add column if not exists extracted_turns int not null default 0;
