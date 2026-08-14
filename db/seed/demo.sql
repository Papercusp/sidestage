-- Idempotent demo catalog for a clean clone.
--
-- Restart's production catalog can be exported with
-- scripts/export-restart-catalog.sh; this fixture keeps the public demo
-- runnable without shipping private or million-row production data. The
-- option rows intentionally cover a two-axis cross product, a sold-out
-- combination, and a no-option base product.

BEGIN;

INSERT INTO product_catalog (
  group_id, region, product_type, title, description, brand, manufacturer,
  identifiers, properties, images, bullets, weight, dimensions, updated_at
)
VALUES
  (
    'demo-espresso-machine', 'US', 'KITCHEN_APPLIANCE',
    'Barista Pro Espresso Machine',
    'A compact dual-boiler espresso machine with a built-in grinder and steam wand.',
    'BrewHaus', 'BrewHaus Manufacturing',
    '{"mpn":"BH-ESP-200"}',
    '{"color":"stainless","powerWatts":1600,"waterTankLiters":2}',
    '[{"url":"https://placehold.co/800x800/png?text=Barista+Pro","alt":"Barista Pro espresso machine","isPrimary":true}]',
    '["Dual boiler","Integrated burr grinder","Stainless steel body"]',
    '{"value":11.4,"unit":"kg"}',
    '{"length":41,"width":32,"height":42,"unit":"cm"}',
    now()
  ),
  (
    'demo-wireless-headphones', 'US', 'AUDIO',
    'Cloud ANC Wireless Headphones',
    'Over-ear wireless headphones with adaptive noise cancellation and a thirty-hour battery.',
    'Northstar Audio', 'Northstar Audio Labs',
    '{"mpn":"NSA-CLOUD-1"}',
    '{"color":"black","bluetooth":"5.3","batteryHours":30}',
    '[{"url":"https://placehold.co/800x800/png?text=Cloud+ANC","alt":"Cloud ANC headphones","isPrimary":true}]',
    '["Adaptive ANC","30-hour battery","Multipoint Bluetooth"]',
    '{"value":0.82,"unit":"kg"}',
    '{"length":19,"width":17,"height":8,"unit":"cm"}',
    now()
  ),
  (
    'demo-creator-camera', 'US', 'CAMERA',
    'Creator 4K Mirrorless Camera',
    'A lightweight mirrorless camera with 4K60 video, a flip screen, and USB-C streaming.',
    'FrameForge', 'FrameForge Imaging',
    '{"mpn":"FF-C4K-24"}',
    '{"mount":"E","sensor":"APS-C","video":"4K60"}',
    '[{"url":"https://placehold.co/800x800/png?text=Creator+4K","alt":"Creator 4K mirrorless camera","isPrimary":true}]',
    '["4K60 video","Flip touchscreen","USB-C live streaming"]',
    '{"value":0.68,"unit":"kg"}',
    '{"length":13,"width":7,"height":9,"unit":"cm"}',
    now()
  ),
  (
    'demo-standing-desk', 'US', 'OFFICE_FURNITURE',
    'Lift Electric Standing Desk',
    'A quiet electric standing desk with a solid bamboo top and programmable height presets.',
    'Field Office', 'Field Office Works',
    '{"mpn":"FO-LIFT-48"}',
    '{"top":"bamboo","widthInches":48,"heightRangeInches":[28,47]}',
    '[{"url":"https://placehold.co/800x800/png?text=Lift+Desk","alt":"Lift electric standing desk","isPrimary":true}]',
    '["Programmable presets","Quiet dual motor","Bamboo desktop"]',
    '{"value":31.0,"unit":"kg"}',
    '{"length":122,"width":61,"height":75,"unit":"cm"}',
    now()
  ),
  (
    'linen-hoodie', 'US', 'APPAREL',
    'Linen Hoodie',
    'A breathable linen-blend hoodie for warm-weather layering.',
    'SideStage Studio', 'SideStage Studio',
    '{"mpn":"SS-LINEN-HOODIE"}',
    '{"material":"linen blend","fit":"relaxed"}',
    '[{"url":"https://placehold.co/800x800/png?text=Linen+Hoodie","alt":"Linen hoodie","isPrimary":true}]',
    '["Breathable linen blend","Relaxed fit","Machine washable"]',
    '{"value":0.42,"unit":"kg"}',
    '{"length":30,"width":24,"height":5,"unit":"cm"}',
    now()
  ),
  (
    'stoneware-mug', 'US', 'HOME',
    'Stoneware Mug',
    'A hand-finished stoneware mug in two glazes and two generous capacities.',
    'Kiln & Co', 'Kiln & Co',
    '{"mpn":"KC-STONEWARE-MUG"}',
    '{"material":"stoneware","dishwasherSafe":true}',
    '[{"url":"https://placehold.co/800x800/png?text=Stoneware+Mug","alt":"Stoneware mug","isPrimary":true}]',
    '["Hand-finished glaze","Dishwasher safe","Microwave safe"]',
    '{"value":0.38,"unit":"kg"}',
    '{"length":12,"width":12,"height":14,"unit":"cm"}',
    now()
  ),
  (
    'woven-market-tote', 'US', 'BAGS',
    'Woven Market Tote',
    'A sturdy natural-cotton market tote with reinforced handles.',
    'SideStage Studio', 'SideStage Studio',
    '{"mpn":"SS-WOVEN-TOTE"}',
    '{"material":"natural cotton","capacityLiters":18}',
    '[{"url":"https://placehold.co/800x800/png?text=Woven+Tote","alt":"Woven market tote","isPrimary":true}]',
    '["Natural cotton","Reinforced handles","Folds flat"]',
    '{"value":0.25,"unit":"kg"}',
    '{"length":42,"width":15,"height":35,"unit":"cm"}',
    now()
  )
ON CONFLICT (group_id, region) DO UPDATE SET
  product_type = EXCLUDED.product_type,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  brand = EXCLUDED.brand,
  manufacturer = EXCLUDED.manufacturer,
  identifiers = EXCLUDED.identifiers,
  properties = EXCLUDED.properties,
  images = EXCLUDED.images,
  bullets = EXCLUDED.bullets,
  weight = EXCLUDED.weight,
  dimensions = EXCLUDED.dimensions,
  updated_at = now();

-- All variant writes intentionally leave reserved_qty untouched on conflict.
-- Re-running the seed updates catalog facts but never releases a live hold.
INSERT INTO storefront_product (
  id, slug, region, sku, price_cents, active, group_id, condition, handling,
  option_signature, variant_images, qty
)
VALUES
  ('demo-espresso-new', 'barista-pro-espresso-new', 'US', 'BH-ESP-200-NEW', 49999, true, 'demo-espresso-machine', 'NEW', 2, 'condition=new|handling=2', '[]', 12),
  ('demo-espresso-refurbished', 'barista-pro-espresso-refurbished', 'US', 'BH-ESP-200-REF', 34999, true, 'demo-espresso-machine', 'REFURBISHED', 4, 'condition=refurbished|handling=4', '[]', 4),
  ('demo-headphones-black', 'cloud-anc-black', 'US', 'NSA-CLOUD-BLK', 19999, true, 'demo-wireless-headphones', 'NEW', 2, 'condition=new|handling=2', '[]', 24),
  ('demo-headphones-sand', 'cloud-anc-sand', 'US', 'NSA-CLOUD-SND', 20999, true, 'demo-wireless-headphones', 'NEW', 2, 'condition=new|handling=2|legacy=sand', '[]', 8),
  ('demo-camera-body', 'creator-4k-body', 'US', 'FF-C4K-BODY', 89999, true, 'demo-creator-camera', 'NEW', 3, 'condition=new|handling=3', '[]', 6),
  ('demo-camera-kit', 'creator-4k-kit', 'US', 'FF-C4K-KIT', 109999, true, 'demo-creator-camera', 'NEW', 5, 'condition=new|handling=5', '[]', 3),
  ('demo-desk-bamboo', 'lift-desk-bamboo', 'US', 'FO-LIFT-BAMBOO', 54999, true, 'demo-standing-desk', 'NEW', 7, 'condition=new|handling=7', '[]', 10),
  ('demo-desk-open-box', 'lift-desk-open-box', 'US', 'FO-LIFT-OPEN', 39999, true, 'demo-standing-desk', 'USED', 9, 'condition=used|handling=9', '[]', 2),
  ('linen-hoodie-red-s', 'linen-hoodie-red-s', 'US', 'LINEN-HOODIE-RED-S', 6800, true, 'linen-hoodie', 'NEW', 2, 'color=red|size=s', '[{"url":"https://placehold.co/800x800/png?text=Red+S","alt":"Linen hoodie in red, size S","isPrimary":true}]', 7),
  ('linen-hoodie-red-m', 'linen-hoodie-red-m', 'US', 'LINEN-HOODIE-RED-M', 6800, true, 'linen-hoodie', 'NEW', 2, 'color=red|size=m', '[{"url":"https://placehold.co/800x800/png?text=Red+M","alt":"Linen hoodie in red, size M","isPrimary":true}]', 5),
  ('linen-hoodie-blue-s', 'linen-hoodie-blue-s', 'US', 'LINEN-HOODIE-BLUE-S', 6800, true, 'linen-hoodie', 'NEW', 2, 'color=blue|size=s', '[{"url":"https://placehold.co/800x800/png?text=Blue+S","alt":"Linen hoodie in blue, size S","isPrimary":true}]', 3),
  ('linen-hoodie-blue-m', 'linen-hoodie-blue-m', 'US', 'LINEN-HOODIE-BLUE-M', 6800, true, 'linen-hoodie', 'NEW', 2, 'color=blue|size=m', '[{"url":"https://placehold.co/800x800/png?text=Blue+M","alt":"Linen hoodie in blue, size M","isPrimary":true}]', 4),
  ('stoneware-mug-matte-12oz', 'stoneware-mug-matte-12oz', 'US', 'STONEWARE-MATTE-12OZ', 2400, true, 'stoneware-mug', 'NEW', 2, 'finish=matte|capacity=12oz', '[{"url":"https://placehold.co/800x800/png?text=Matte+12oz","alt":"Matte stoneware mug, 12 ounces","isPrimary":true}]', 12),
  ('stoneware-mug-matte-16oz', 'stoneware-mug-matte-16oz', 'US', 'STONEWARE-MATTE-16OZ', 2600, true, 'stoneware-mug', 'NEW', 2, 'finish=matte|capacity=16oz', '[{"url":"https://placehold.co/800x800/png?text=Matte+16oz","alt":"Matte stoneware mug, 16 ounces","isPrimary":true}]', 8),
  ('stoneware-mug-gloss-12oz', 'stoneware-mug-gloss-12oz', 'US', 'STONEWARE-GLOSS-12OZ', 2500, true, 'stoneware-mug', 'NEW', 2, 'finish=gloss|capacity=12oz', '[{"url":"https://placehold.co/800x800/png?text=Gloss+12oz","alt":"Gloss stoneware mug, 12 ounces","isPrimary":true}]', 5),
  ('stoneware-mug-gloss-16oz', 'stoneware-mug-gloss-16oz', 'US', 'STONEWARE-GLOSS-16OZ', 2700, true, 'stoneware-mug', 'NEW', 2, 'finish=gloss|capacity=16oz', '[{"url":"https://placehold.co/800x800/png?text=Gloss+16oz","alt":"Gloss stoneware mug, 16 ounces","isPrimary":true}]', 0),
  ('woven-market-tote-base', 'woven-market-tote-base', 'US', 'WOVEN-MARKET-TOTE', 4200, true, 'woven-market-tote', 'NEW', 5, 'base', '[{"url":"https://placehold.co/800x800/png?text=Woven+Tote","alt":"Natural cotton woven market tote","isPrimary":true}]', 0)
ON CONFLICT (id) DO UPDATE SET
  slug = EXCLUDED.slug,
  region = EXCLUDED.region,
  sku = EXCLUDED.sku,
  price_cents = EXCLUDED.price_cents,
  active = EXCLUDED.active,
  group_id = EXCLUDED.group_id,
  condition = EXCLUDED.condition,
  handling = EXCLUDED.handling,
  option_signature = EXCLUDED.option_signature,
  variant_images = EXCLUDED.variant_images,
  qty = EXCLUDED.qty,
  updated_at = now();

INSERT INTO product_option_axes (id, group_id, region, slug, label, position, required)
VALUES
  ('linen-hoodie-color', 'linen-hoodie', 'US', 'color', 'Color', 0, true),
  ('linen-hoodie-size', 'linen-hoodie', 'US', 'size', 'Size', 1, true),
  ('stoneware-mug-finish', 'stoneware-mug', 'US', 'finish', 'Finish', 0, true),
  ('stoneware-mug-capacity', 'stoneware-mug', 'US', 'capacity', 'Capacity', 1, true)
ON CONFLICT (id) DO UPDATE SET
  label = EXCLUDED.label,
  position = EXCLUDED.position,
  required = EXCLUDED.required;

INSERT INTO product_option_values (id, axis_id, slug, label, position, metadata)
VALUES
  ('linen-hoodie-color-red', 'linen-hoodie-color', 'red', 'Red', 0, '{"swatch":"#c95b61"}'),
  ('linen-hoodie-color-blue', 'linen-hoodie-color', 'blue', 'Blue', 1, '{"swatch":"#4d79b8"}'),
  ('linen-hoodie-size-s', 'linen-hoodie-size', 's', 'S', 0, '{}'),
  ('linen-hoodie-size-m', 'linen-hoodie-size', 'm', 'M', 1, '{}'),
  ('stoneware-mug-finish-matte', 'stoneware-mug-finish', 'matte', 'Matte', 0, '{"sheen":"low"}'),
  ('stoneware-mug-finish-gloss', 'stoneware-mug-finish', 'gloss', 'Gloss', 1, '{"sheen":"high"}'),
  ('stoneware-mug-capacity-12oz', 'stoneware-mug-capacity', '12oz', '12 oz', 0, '{"ounces":12}'),
  ('stoneware-mug-capacity-16oz', 'stoneware-mug-capacity', '16oz', '16 oz', 1, '{"ounces":16}')
ON CONFLICT (id) DO UPDATE SET
  axis_id = EXCLUDED.axis_id,
  slug = EXCLUDED.slug,
  label = EXCLUDED.label,
  position = EXCLUDED.position,
  metadata = EXCLUDED.metadata;

INSERT INTO storefront_product_option (variant_id, axis_id, value_id)
VALUES
  ('linen-hoodie-red-s', 'linen-hoodie-color', 'linen-hoodie-color-red'),
  ('linen-hoodie-red-s', 'linen-hoodie-size', 'linen-hoodie-size-s'),
  ('linen-hoodie-red-m', 'linen-hoodie-color', 'linen-hoodie-color-red'),
  ('linen-hoodie-red-m', 'linen-hoodie-size', 'linen-hoodie-size-m'),
  ('linen-hoodie-blue-s', 'linen-hoodie-color', 'linen-hoodie-color-blue'),
  ('linen-hoodie-blue-s', 'linen-hoodie-size', 'linen-hoodie-size-s'),
  ('linen-hoodie-blue-m', 'linen-hoodie-color', 'linen-hoodie-color-blue'),
  ('linen-hoodie-blue-m', 'linen-hoodie-size', 'linen-hoodie-size-m'),
  ('stoneware-mug-matte-12oz', 'stoneware-mug-finish', 'stoneware-mug-finish-matte'),
  ('stoneware-mug-matte-12oz', 'stoneware-mug-capacity', 'stoneware-mug-capacity-12oz'),
  ('stoneware-mug-matte-16oz', 'stoneware-mug-finish', 'stoneware-mug-finish-matte'),
  ('stoneware-mug-matte-16oz', 'stoneware-mug-capacity', 'stoneware-mug-capacity-16oz'),
  ('stoneware-mug-gloss-12oz', 'stoneware-mug-finish', 'stoneware-mug-finish-gloss'),
  ('stoneware-mug-gloss-12oz', 'stoneware-mug-capacity', 'stoneware-mug-capacity-12oz'),
  ('stoneware-mug-gloss-16oz', 'stoneware-mug-finish', 'stoneware-mug-finish-gloss'),
  ('stoneware-mug-gloss-16oz', 'stoneware-mug-capacity', 'stoneware-mug-capacity-16oz')
ON CONFLICT (variant_id, axis_id) DO UPDATE SET
  value_id = EXCLUDED.value_id;

-- ── Event directory (P-118 / D-019) ──────────────────────────────────────────
-- The "What's on" Channel Guide groups by state, so the demo set covers all
-- three buyer-visible states plus a draft that must NOT appear — the draft row
-- is the fixture that proves the read path filters rather than the client
-- hiding rows.
--
-- Times are relative to now() rather than fixed timestamps: a seeded "starts in
-- two hours" event stays genuinely upcoming whenever the demo is run, where a
-- hardcoded date silently rots into the past and the Up-next group empties out.
--
-- sunday-drop is the pre-existing real event (it already has an event_config
-- row); it is inserted here so the guide lists it alongside the rest, and the
-- ON CONFLICT keeps a seller's later edits from being clobbered by a re-seed.
INSERT INTO event (
  event_id, title, seller_id, seller_name, status, starts_at, ended_at, thumbnail_url
)
VALUES
  -- Live now
  ('sunday-drop', 'Sunday vintage drop', 'seller-marsh', 'Marsh & Co Vintage',
   'live', now() - interval '35 minutes', NULL,
   'https://placehold.co/400x400/D62B1F/FFF8EF/png?text=Vintage'),
  ('midnight-sneaker-vault', 'Midnight sneaker vault', 'seller-sole', 'Sole Provisions',
   'live', now() - interval '12 minutes', NULL,
   'https://placehold.co/400x400/2A1F1A/FFC400/png?text=Sneakers'),
  ('estate-jewels-hour', 'Estate jewels hour', 'seller-ashgrove', 'Ashgrove Estate',
   'live', now() - interval '1 hour 20 minutes', NULL,
   'https://placehold.co/400x400/8A7A6C/FFF8EF/png?text=Jewels'),

  -- Up next
  ('tuesday-tool-run', 'Tuesday tool run', 'seller-ironbark', 'Ironbark Supply',
   'scheduled', now() + interval '2 hours', NULL,
   'https://placehold.co/400x400/A66A00/FFF8EF/png?text=Tools'),
  ('denim-archive-drop', 'Denim archive drop', 'seller-blueloom', 'Blue Loom Archive',
   'scheduled', now() + interval '6 hours', NULL,
   'https://placehold.co/400x400/1E7F4F/FFF8EF/png?text=Denim'),
  ('weekend-ceramics', 'Weekend ceramics studio sale', 'seller-kiln', 'Kiln & Coast',
   'scheduled', now() + interval '2 days', NULL,
   'https://placehold.co/400x400/E8D3BC/2A1F1A/png?text=Ceramics'),

  -- Ended (replay)
  ('friday-flash-audio', 'Friday flash: hi-fi audio', 'seller-northstar', 'Northstar Audio',
   'ended', now() - interval '19 hours', now() - interval '18 hours',
   'https://placehold.co/400x400/2A1F1A/FFF8EF/png?text=Audio'),
  ('warehouse-clearout', 'Warehouse clear-out marathon', 'seller-restart', 'Restart Outfitters',
   'ended', now() - interval '3 days 2 hours', now() - interval '3 days',
   'https://placehold.co/400x400/C2271C/FFF8EF/png?text=Clearout'),

  -- Draft: unpublished, and must never surface in the buyer guide.
  ('spring-preview-draft', 'Spring preview (unpublished)', 'seller-marsh', 'Marsh & Co Vintage',
   'draft', NULL, NULL, NULL)
ON CONFLICT (event_id) DO UPDATE SET
  title = EXCLUDED.title,
  seller_id = EXCLUDED.seller_id,
  seller_name = EXCLUDED.seller_name,
  status = EXCLUDED.status,
  starts_at = EXCLUDED.starts_at,
  ended_at = EXCLUDED.ended_at,
  thumbnail_url = EXCLUDED.thumbnail_url,
  updated_at = now();

COMMIT;
