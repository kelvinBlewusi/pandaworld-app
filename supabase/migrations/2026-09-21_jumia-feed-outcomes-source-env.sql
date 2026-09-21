-- Tags every jumia_feed_outcomes row with which Jumia environment produced
-- it — 'staging' or 'production' — so a rejection caught on the new
-- staging branch (see STAGING.md) can be told apart from a real seller
-- hitting the same thing live. Without this, staging test pushes and
-- production incidents are indistinguishable in the one shared table
-- (both apps currently point at the same Supabase project), which
-- defeats using staging as a systematic pre-flight check rather than
-- something watched by eye.
--
-- Every existing row predates this column and was necessarily written
-- against production (staging wasn't wired up until now) — default and
-- backfill both to 'production' rather than leaving them null.
alter table jumia_feed_outcomes
  add column if not exists source_env text not null default 'production'
    check (source_env in ('staging', 'production'));

update jumia_feed_outcomes set source_env = 'production' where source_env is null;

create index if not exists jumia_feed_outcomes_source_env_idx
  on jumia_feed_outcomes (source_env);
