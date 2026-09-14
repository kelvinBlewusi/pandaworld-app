-- Correct the cached Jumia attribute types.
--
-- mapAttrType() in lib/jumia/categories.ts had two of the legacy numeric
-- codes wrong since it was written, and nothing surfaced it until Jumia
-- rejected a live feed:
--
--   "Attribute [capacity_liter] with the value [0.35] should be a number
--    without decimals."
--
-- capacity_liter was cached as BOOLEAN. So were capacity_kg, cpu_cores,
-- cpu_speed, storage_capacity, voltage, display_size, pages,
-- year_of_publication and eleven more — 19 distinct names, every one a
-- quantity, not one a yes/no. In the editor they rendered as a Yes/No
-- dropdown, so a seller could not type a number into any of them.
--
-- The other direction: description, short_description, package_content,
-- product_warranty, warranty_address and manufacturer_txt were cached as
-- NUMBER across 594 categories each. All long free text. That one stayed
-- invisible because SchemaField already special-cased those names back to
-- a rich-text box — a workaround for this bug, sitting on top of it.
--
-- So: the code mapped to "boolean" is NUMBER, and the code mapped to
-- "number" is TEXT_AREA. Nothing in the live cache is genuinely boolean;
-- a real one arrives as the string "BOOLEAN", which the mapper already
-- handles separately.
--
-- ONE statement with a CASE on purpose. Run as two updates, the
-- 'boolean' -> 'number' rows would be swept up by a subsequent
-- 'number' -> 'textarea' and land two steps from where they started.
--
-- The guard is what makes re-running safe. Without it a second run would
-- do exactly the damage the CASE exists to prevent: the 556 rows this
-- migration turns into 'number' still match `type in ('number',
-- 'boolean')`, and would be pushed on to 'textarea'. A surviving
-- 'boolean' row is the signature of the un-migrated state, so keying off
-- it makes the whole thing a no-op once applied.

do $$
begin
  if exists (select 1 from jumia_category_attributes where type = 'boolean') then
    update jumia_category_attributes
    set type = case type
                 when 'number'  then 'textarea'   -- long free text
                 when 'boolean' then 'number'     -- quantities
               end
    where type in ('number', 'boolean');
  end if;
end $$;

-- Applied to the live cache 2026-09-14:
--   556 rows 'boolean'  -> 'number'    (19 names, 178 categories)
--   3565 rows 'number'  -> 'textarea'  (7 names, 595 categories)
