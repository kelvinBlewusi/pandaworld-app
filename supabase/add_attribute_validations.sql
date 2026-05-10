-- Capture Jumia's exact MinLength / MaxLength constraints per attribute.
--
-- Without these we can't tell the seller "description must be 50-9000 chars"
-- until Jumia rejects the listing. After this migration, the review form
-- shows the live limits next to each field and gates Submit accordingly.
--
-- Source: GET /catalog/attribute-sets/{sid} response, validations[].MinLength
-- and validations[].MaxLength fields.

alter table jumia_category_attributes
  add column if not exists min_length integer,
  add column if not exists max_length integer;

comment on column jumia_category_attributes.min_length is 'Jumia API validation: minimum length / value for this attribute. NULL when not specified.';
comment on column jumia_category_attributes.max_length is 'Jumia API validation: maximum length / value for this attribute. NULL when not specified.';
