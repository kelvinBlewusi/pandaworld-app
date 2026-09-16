-- Capture two more of Jumia's per-attribute validation rules, both from
-- the corrected GET /catalog/attribute-sets/{sid} response Jumia's own
-- 2026-09-16 doc changelog describes (validations is a single object with
-- lowercase keys — see the same commit's fix to fetchAttributesFromJumia
-- in lib/jumia/categories.ts, which was previously reading
-- validations[0].MinLength off a shape the live API never actually
-- returns).
--
-- decimal_places is the rule behind "Attribute [x] with the value [y] is
-- a not valid number without decimals" — Jumia's own wording for the
-- exact class of rejection capacity_liter hit in
-- 2026-09-14_fix-attribute-type-codes.sql (that migration fixed the
-- TYPE being wrong; this column is what would have caught the DECIMAL
-- VALUE being wrong too, for any attribute whose type was always
-- correct).
--
-- not_zero_or_negative is the rule behind "The attribute [x] with the
-- value [y] should not be null or a negative value" — a quantity field
-- (weight, capacity, warranty period) that Jumia rejects outright if the
-- AI or the seller ever supplies zero or a negative number.
--
-- Both are nullable/false-default so a category whose live sync hasn't
-- run since this migration lands (or whose validations object simply
-- doesn't populate the key) behaves exactly as before: no bound to
-- enforce, same as min_length/max_length already do.
alter table public.jumia_category_attributes
  add column if not exists decimal_places integer,
  add column if not exists not_zero_or_negative boolean not null default false;

comment on column public.jumia_category_attributes.decimal_places is
  'validations.decimalPlaces from GET /catalog/attribute-sets/{sid}. '
  'Null means Jumia did not constrain this attribute''s decimal places. '
  '0 means integer-only — used by preflightAttributes to round a '
  'fractional value before Jumia rejects it outright.';

comment on column public.jumia_category_attributes.not_zero_or_negative is
  'validations.notZeroOrNegative from GET /catalog/attribute-sets/{sid}. '
  'True means Jumia rejects a value of zero or below for this attribute — '
  'used by preflightAttributes to drop such a value before it is ever '
  'sent, the same way an invalid enum value is dropped today.';
