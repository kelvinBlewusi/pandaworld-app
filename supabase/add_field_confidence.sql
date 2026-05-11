-- Persist per-field AI confidence + source so the review page can render
-- coloured indicators (yellow=inferred, green=high-confidence, gray=seller-
-- required) per the PDF restructuring spec.
--
-- Stored alongside the existing field_sources column. Shape:
--   { "title":       { confidence: 0.85, source: "inferred" },
--     "brand":       { confidence: 0.95, source: "image", reasoning: "Logo visible" },
--     "selling_price": { confidence: 0, source: "seller-required" },
--     "dynamic_attributes.color": { confidence: 0.9, source: "inferred" } }

alter table listings
  add column if not exists field_confidence  jsonb,
  add column if not exists category_alternates jsonb;

comment on column listings.field_confidence is
  'Per-field AI confidence + provenance. Mirrors keys in field_sources. source ∈ image|ocr|inferred|seller-required.';

comment on column listings.category_alternates is
  'Top-3 category picks from AI classification with confidence scores. Used to offer a switcher when the primary pick is uncertain.';
