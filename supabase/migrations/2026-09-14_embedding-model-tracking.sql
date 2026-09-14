-- Record WHICH model produced each category embedding.
--
-- THE INCIDENT THIS PREVENTS REPEATING: category retrieval was returning
-- near-random results for four months, and nothing in the system could
-- show why. The timeline, reconstructed from git and this table:
--
--   2026-05-17  categories synced (27,720 rows)
--   2026-05-26  0eacc3d adds the embedding backfill, running on AI
--               Studio's gemini-embedding-001
--   2026-05-29  94444fa switches embedding QUERIES to Vertex's
--               text-embedding-005
--
-- From that day the index and the queries lived in two different vector
-- spaces. Both models emit 768 dimensions, so nothing errored — pgvector
-- happily computed cosine similarity between unrelated spaces and
-- returned confident nonsense. A safety helmet was filed under "Ball
-- Transfers", a canvas print under "Icing & Decorating Spatulas", and
-- four of seven Jumia push failures trace back to a wrong category.
--
-- Two things made it invisible AND unfixable:
--   1. Nothing recorded which model wrote a vector, so the mismatch was
--      undetectable by inspection — the index is internally coherent
--      (similarity from one anchor to 3,000 random rows is unimodal,
--      0.445-0.731, no second cluster), it is just coherent in the WRONG
--      space.
--   2. embedPendingCategories only ever selected `WHERE embedding IS
--      NULL`. At 100% coverage the daily cron was a permanent no-op — it
--      could not rewrite a single stale vector, ever.
--
-- This column fixes (1) and unblocks (2): the backfill now re-embeds any
-- row whose model does not match the backend currently in use, so a
-- future backend switch heals itself on the next cron run instead of
-- silently poisoning retrieval.

alter table jumia_categories
  add column if not exists embedding_model text;

-- Existing vectors are labelled by what they are, not by a guess.
-- Evidence says gemini-embedding-001, but the model was never recorded,
-- so asserting it would be inventing provenance. 'unknown-legacy' is
-- honest and works identically for the purpose: it matches no current
-- model name, so every one of these rows is re-embedded.
update jumia_categories
set embedding_model = 'unknown-legacy'
where embedding is not null
  and embedding_model is null;

-- Serves the backfill's "which rows still need embedding" scan and its
-- remaining-count, both of which now filter on this column.
create index if not exists jumia_categories_embedding_model_idx
  on jumia_categories (embedding_model, code);

comment on column jumia_categories.embedding_model is
  'Model that produced `embedding` (e.g. text-embedding-005). Vectors from '
  'different models are not comparable, so the backfill re-embeds any row '
  'whose value differs from the backend currently in use. Never leave this '
  'unset when writing an embedding.';
