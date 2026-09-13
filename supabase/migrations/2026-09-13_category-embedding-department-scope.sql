-- Scope search_categories_by_embedding() to one department's subtree,
-- mirroring lib/jumia/category-search.ts's getSubtreeCategories() (which
-- the fuzzy-search half of the department-first pipeline already uses).
--
-- Why: the department-first auto-analyze pipeline (lib/actions/
-- auto-analyze.ts) picks a top-level department first, then only
-- fuzzy-searches within that department's subtree — this was a
-- deliberate fix for the old "blind full-catalog search" bug where a
-- strong text match in the WRONG department (e.g. a safety helmet
-- filed under "Laptops") could still win. Adding embedding-based
-- semantic search back in as a quality boost (see AGENTS.md's
-- "retrieval upgrade" note) must respect that same department scope —
-- an unscoped semantic hit from outside the picked department would
-- reopen exactly the bug the department-first redesign fixed.
--
-- dept_path defaults to NULL (unscoped — the pre-existing behavior),
-- so any caller that doesn't pass it keeps working unchanged.
--
-- Apply via Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.

DROP FUNCTION IF EXISTS search_categories_by_embedding(vector(768), int);

CREATE OR REPLACE FUNCTION search_categories_by_embedding(
  query_embedding vector(768),
  match_limit     int DEFAULT 8,
  dept_path       text DEFAULT NULL
)
RETURNS TABLE (
  code              integer,
  name              text,
  path              text,
  attribute_set_sid text,
  similarity        float
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    jc.code,
    jc.name,
    jc.path,
    jc.attribute_set_sid,
    GREATEST(0.0, LEAST(1.0, 1.0 - (jc.embedding <=> query_embedding) / 2.0))::float AS similarity
  FROM jumia_categories jc
  WHERE jc.embedding IS NOT NULL
    AND jc.attribute_set_sid IS NOT NULL
    AND (
      dept_path IS NULL
      OR jc.path = dept_path
      OR jc.path LIKE dept_path || ' > %'
    )
  ORDER BY jc.embedding <=> query_embedding
  LIMIT match_limit;
$$;

COMMENT ON FUNCTION search_categories_by_embedding IS
  'Cosine-similarity search over jumia_categories.embedding, optionally scoped to one department subtree via dept_path. Used by lib/jumia/category-search.ts -> searchCategoriesByEmbedding(). Returns top-N nearest categories scored 0-1.';
