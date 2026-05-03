-- Phase 5A: Add dynamic_attributes column to listings
-- Stores the AI-detected category-specific fields as a JSON map
-- e.g. { "ram": "8GB", "operating_system": "Android", "network": "5G" }
-- Run AFTER add_jumia_categories.sql

alter table listings
  add column if not exists dynamic_attributes jsonb default '{}'::jsonb;

comment on column listings.dynamic_attributes is
  'AI-detected category-specific attribute values, keyed by Jumia attribute name.
   These match the exact fields shown in Jumia Vendor Center for the selected category.';
