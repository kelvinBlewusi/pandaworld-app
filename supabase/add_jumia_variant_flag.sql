-- Add is_variant flag to jumia_category_attributes
-- is_variant = true means this attribute can be used as a variant dimension
-- (e.g. Color, RAM, Internal Memory) in the variant matrix editor.
-- Run in Supabase → SQL Editor

alter table jumia_category_attributes
  add column if not exists is_variant boolean not null default false;

comment on column jumia_category_attributes.is_variant is
  'When true, this attribute acts as a variant axis in the review-page variant matrix (e.g. Color, RAM)';

-- Backfill known variant axes for already-synced categories based on common field names
update jumia_category_attributes
set is_variant = true
where name in (
  'color', 'ram', 'internal_memory', 'storage_capacity',
  'size', 'shoe_size', 'clothing_size', 'capacity', 'voltage',
  'screen_size_inches', 'pack_size', 'weight_variant'
);
