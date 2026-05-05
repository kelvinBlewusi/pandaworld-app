-- Add field_sources + quality_score to listings
-- field_sources: tracks which fields were AI-generated vs user-edited
-- quality_score: 0-100 computed score (cached from last save)
-- Run in Supabase → SQL Editor

alter table listings
  add column if not exists field_sources   jsonb    default '{}',
  add column if not exists quality_score   integer;

comment on column listings.field_sources is
  'Map of field_name → "ai" | "user" — tracks provenance for the per-field AI badges';

comment on column listings.quality_score is
  '0–100 listing quality score (completeness + content length + variant coverage)';
