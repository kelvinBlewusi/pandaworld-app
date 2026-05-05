-- Phase 5A fix: store the attributeSet sid on each category
-- This is the UUID used to fetch attribute schemas from:
--   GET /catalog/attribute-sets/{sid}
-- Run in Supabase → SQL Editor

alter table jumia_categories
  add column if not exists attribute_set_sid text,
  add column if not exists attribute_set_name text;

comment on column jumia_categories.attribute_set_sid is
  'UUID from attributeSet.sid — used to fetch attribute schemas via GET /catalog/attribute-sets/{sid}';
