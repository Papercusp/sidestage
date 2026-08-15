-- Idempotent demo catalog for a clean clone.
--
-- Restart's production catalog can be exported with
-- scripts/export-restart-catalog.sh; this fixture keeps the public demo
-- runnable without shipping private or million-row production data. The
-- option rows intentionally cover a single-axis colour product, a two-axis
-- cross product, a sold-out combination, and a no-option base product.

BEGIN;

-- Inventory ownership is explicit at every write boundary, including fixtures.
-- Conflict updates intentionally preserve the row's existing seller_id.

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

-- The four demo products used to split on Restart's resale axis
-- (condition + handling days). SideStage sells live from a seller's own
-- inventory, where the buyer picks a COLOURWAY, so each product now offers two
-- colours and `condition`/`handling` are held constant within a group — they
-- are import-compatibility columns, not the variant axis (WI-38716). Renaming
-- the ids means a demo database seeded before that change keeps its old rows
-- unless they are dropped here, which would show fourteen variants across four
-- products. Both tables that reference a variant (storefront_product_option,
-- inventory_reservation) cascade on delete.
DELETE FROM storefront_product
WHERE id IN (
  'demo-espresso-new', 'demo-espresso-refurbished', 'demo-headphones-black',
  'demo-camera-body', 'demo-camera-kit', 'demo-desk-bamboo', 'demo-desk-open-box'
);

-- All variant writes intentionally leave reserved_qty untouched on conflict.
-- Re-running the seed updates catalog facts but never releases a live hold.
INSERT INTO storefront_product (
  id, seller_id, slug, region, sku, price_cents, active, group_id, condition, handling,
  option_signature, variant_images, qty
)
VALUES
  ('demo-espresso-matte-black', 'demo-seller', 'barista-pro-espresso-matte-black', 'US', 'BH-ESP-200-BLK', 49999, true, 'demo-espresso-machine', 'NEW', 2, 'color=matte-black', '[{"url":"/demo-products/barista-pro-matte-black.webp","alt":"Barista Pro espresso machine in matte black","isPrimary":true}]', 12),
  ('demo-espresso-cream', 'demo-seller', 'barista-pro-espresso-cream', 'US', 'BH-ESP-200-CRM', 49999, true, 'demo-espresso-machine', 'NEW', 2, 'color=cream', '[{"url":"/demo-products/barista-pro-cream.webp","alt":"Barista Pro espresso machine in cream","isPrimary":true}]', 5),
  ('demo-headphones-midnight', 'demo-seller', 'cloud-anc-midnight', 'US', 'NSA-CLOUD-MID', 19999, true, 'demo-wireless-headphones', 'NEW', 2, 'color=midnight', '[{"url":"/demo-products/cloud-anc-midnight.webp","alt":"Cloud ANC wireless headphones in midnight","isPrimary":true}]', 24),
  ('demo-headphones-sand', 'demo-seller', 'cloud-anc-sand', 'US', 'NSA-CLOUD-SND', 19999, true, 'demo-wireless-headphones', 'NEW', 2, 'color=sand', '[{"url":"/demo-products/cloud-anc-sand.webp","alt":"Cloud ANC wireless headphones in sand","isPrimary":true}]', 8),
  ('demo-camera-black', 'demo-seller', 'creator-4k-black', 'US', 'FF-C4K-BLK', 89999, true, 'demo-creator-camera', 'NEW', 3, 'color=black', '[{"url":"/demo-products/creator-4k-black.webp","alt":"Creator 4K mirrorless camera in black","isPrimary":true}]', 6),
  ('demo-camera-silver', 'demo-seller', 'creator-4k-silver', 'US', 'FF-C4K-SLV', 89999, true, 'demo-creator-camera', 'NEW', 3, 'color=silver', '[{"url":"/demo-products/creator-4k-silver.webp","alt":"Creator 4K mirrorless camera in silver","isPrimary":true}]', 3),
  ('demo-desk-natural-oak', 'demo-seller', 'lift-desk-natural-oak', 'US', 'FO-LIFT-OAK', 54999, true, 'demo-standing-desk', 'NEW', 7, 'color=natural-oak', '[{"url":"/demo-products/lift-desk-natural-oak.webp","alt":"Lift electric standing desk with a natural oak top","isPrimary":true}]', 10),
  ('demo-desk-walnut', 'demo-seller', 'lift-desk-walnut', 'US', 'FO-LIFT-WAL', 54999, true, 'demo-standing-desk', 'NEW', 7, 'color=walnut', '[{"url":"/demo-products/lift-desk-walnut.webp","alt":"Lift electric standing desk with a walnut top","isPrimary":true}]', 2),
  ('linen-hoodie-red-s', 'demo-seller', 'linen-hoodie-red-s', 'US', 'LINEN-HOODIE-RED-S', 6800, true, 'linen-hoodie', 'NEW', 2, 'color=red|size=s', '[{"url":"https://placehold.co/800x800/png?text=Red+S","alt":"Linen hoodie in red, size S","isPrimary":true}]', 7),
  ('linen-hoodie-red-m', 'demo-seller', 'linen-hoodie-red-m', 'US', 'LINEN-HOODIE-RED-M', 6800, true, 'linen-hoodie', 'NEW', 2, 'color=red|size=m', '[{"url":"https://placehold.co/800x800/png?text=Red+M","alt":"Linen hoodie in red, size M","isPrimary":true}]', 5),
  ('linen-hoodie-blue-s', 'demo-seller', 'linen-hoodie-blue-s', 'US', 'LINEN-HOODIE-BLUE-S', 6800, true, 'linen-hoodie', 'NEW', 2, 'color=blue|size=s', '[{"url":"https://placehold.co/800x800/png?text=Blue+S","alt":"Linen hoodie in blue, size S","isPrimary":true}]', 3),
  ('linen-hoodie-blue-m', 'demo-seller', 'linen-hoodie-blue-m', 'US', 'LINEN-HOODIE-BLUE-M', 6800, true, 'linen-hoodie', 'NEW', 2, 'color=blue|size=m', '[{"url":"https://placehold.co/800x800/png?text=Blue+M","alt":"Linen hoodie in blue, size M","isPrimary":true}]', 4),
  ('stoneware-mug-matte-12oz', 'demo-seller', 'stoneware-mug-matte-12oz', 'US', 'STONEWARE-MATTE-12OZ', 2400, true, 'stoneware-mug', 'NEW', 2, 'finish=matte|capacity=12oz', '[{"url":"https://placehold.co/800x800/png?text=Matte+12oz","alt":"Matte stoneware mug, 12 ounces","isPrimary":true}]', 12),
  ('stoneware-mug-matte-16oz', 'demo-seller', 'stoneware-mug-matte-16oz', 'US', 'STONEWARE-MATTE-16OZ', 2600, true, 'stoneware-mug', 'NEW', 2, 'finish=matte|capacity=16oz', '[{"url":"https://placehold.co/800x800/png?text=Matte+16oz","alt":"Matte stoneware mug, 16 ounces","isPrimary":true}]', 8),
  ('stoneware-mug-gloss-12oz', 'demo-seller', 'stoneware-mug-gloss-12oz', 'US', 'STONEWARE-GLOSS-12OZ', 2500, true, 'stoneware-mug', 'NEW', 2, 'finish=gloss|capacity=12oz', '[{"url":"https://placehold.co/800x800/png?text=Gloss+12oz","alt":"Gloss stoneware mug, 12 ounces","isPrimary":true}]', 5),
  ('stoneware-mug-gloss-16oz', 'demo-seller', 'stoneware-mug-gloss-16oz', 'US', 'STONEWARE-GLOSS-16OZ', 2700, true, 'stoneware-mug', 'NEW', 2, 'finish=gloss|capacity=16oz', '[{"url":"https://placehold.co/800x800/png?text=Gloss+16oz","alt":"Gloss stoneware mug, 16 ounces","isPrimary":true}]', 0),
  ('woven-market-tote-base', 'demo-seller', 'woven-market-tote-base', 'US', 'WOVEN-MARKET-TOTE', 4200, true, 'woven-market-tote', 'NEW', 5, 'base', '[{"url":"https://placehold.co/800x800/png?text=Woven+Tote","alt":"Natural cotton woven market tote","isPrimary":true}]', 0)
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
  ('demo-espresso-machine-color', 'demo-espresso-machine', 'US', 'color', 'Color', 0, true),
  ('demo-wireless-headphones-color', 'demo-wireless-headphones', 'US', 'color', 'Color', 0, true),
  ('demo-creator-camera-color', 'demo-creator-camera', 'US', 'color', 'Color', 0, true),
  ('demo-standing-desk-color', 'demo-standing-desk', 'US', 'color', 'Color', 0, true),
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
  ('demo-espresso-machine-color-matte-black', 'demo-espresso-machine-color', 'matte-black', 'Matte Black', 0, '{"swatch":"#2f3033"}'),
  ('demo-espresso-machine-color-cream', 'demo-espresso-machine-color', 'cream', 'Cream', 1, '{"swatch":"#efe6d5"}'),
  ('demo-wireless-headphones-color-midnight', 'demo-wireless-headphones-color', 'midnight', 'Midnight', 0, '{"swatch":"#1b2033"}'),
  ('demo-wireless-headphones-color-sand', 'demo-wireless-headphones-color', 'sand', 'Sand', 1, '{"swatch":"#d8c6a8"}'),
  ('demo-creator-camera-color-black', 'demo-creator-camera-color', 'black', 'Black', 0, '{"swatch":"#26262a"}'),
  ('demo-creator-camera-color-silver', 'demo-creator-camera-color', 'silver', 'Silver', 1, '{"swatch":"#c9ccd1"}'),
  ('demo-standing-desk-color-natural-oak', 'demo-standing-desk-color', 'natural-oak', 'Natural Oak', 0, '{"swatch":"#c8a97a"}'),
  ('demo-standing-desk-color-walnut', 'demo-standing-desk-color', 'walnut', 'Walnut', 1, '{"swatch":"#5b3a2a"}'),
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
  ('demo-espresso-matte-black', 'demo-espresso-machine-color', 'demo-espresso-machine-color-matte-black'),
  ('demo-espresso-cream', 'demo-espresso-machine-color', 'demo-espresso-machine-color-cream'),
  ('demo-headphones-midnight', 'demo-wireless-headphones-color', 'demo-wireless-headphones-color-midnight'),
  ('demo-headphones-sand', 'demo-wireless-headphones-color', 'demo-wireless-headphones-color-sand'),
  ('demo-camera-black', 'demo-creator-camera-color', 'demo-creator-camera-color-black'),
  ('demo-camera-silver', 'demo-creator-camera-color', 'demo-creator-camera-color-silver'),
  ('demo-desk-natural-oak', 'demo-standing-desk-color', 'demo-standing-desk-color-natural-oak'),
  ('demo-desk-walnut', 'demo-standing-desk-color', 'demo-standing-desk-color-walnut'),
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

-- ── Curated Event Manager catalog (50 groups / exactly 200 variants) ────────
-- The million-row Restart import is useful for production search, but it is a
-- poor event-creation demo: almost every row has no normalized color/size axis.
-- Keep that corpus intact and tag this deliberately small collection instead.
-- PgCatalogSource scopes its default Event Manager reads to this marker.
--
-- The compact manifest is the authored data. Everything repetitive — ids,
-- options, images, stock, dimensions, axes, values and 260 normalized option
-- mappings — is derived set-wise so the declared 50 × 4 shape cannot drift.
CREATE TEMP TABLE event_demo_manifest (
  product_number integer PRIMARY KEY,
  title text NOT NULL,
  product_type text NOT NULL,
  brand text NOT NULL,
  base_price_cents integer NOT NULL,
  image_filename text NOT NULL UNIQUE CHECK (
    image_filename ~ '^[a-z0-9-]+\.webp$'
  )
) ON COMMIT DROP;

-- BEGIN EVENT_DEMO_MANIFEST (catalog.fixture.test.ts counts these source rows)
INSERT INTO event_demo_manifest (
  product_number, title, product_type, brand, base_price_cents, image_filename
)
VALUES
  (1, 'Harbor Kettle', 'KITCHEN', 'Hearthline', 7400, 'event-demo-01-harbor-kettle.webp'),
  (2, 'Cloud ANC Headphones', 'AUDIO', 'Northstar Audio', 19900, 'cloud-anc-midnight.webp'),
  (3, 'Arc Table Lamp', 'HOME', 'Field & Form', 12800, 'event-demo-03-arc-table-lamp.webp'),
  (4, 'Daily Pour Carafe', 'KITCHEN', 'BrewHaus', 4600, 'event-demo-04-daily-pour-carafe.webp'),
  (5, 'Woven Market Tote', 'BAGS', 'SideStage Studio', 4200, 'event-demo-05-woven-market-tote.webp'),
  (6, 'Pocket Power Bank', 'TECH', 'Relay Works', 5900, 'event-demo-06-pocket-power-bank.webp'),
  (7, 'Cloud Knit Throw', 'HOME', 'Common Thread', 8800, 'event-demo-07-cloud-knit-throw.webp'),
  (8, 'Flow Yoga Mat', 'FITNESS', 'North Loop', 6400, 'event-demo-08-flow-yoga-mat.webp'),
  (9, 'Travel Vanity Case', 'BEAUTY', 'Morrow', 7600, 'event-demo-09-travel-vanity-case.webp'),
  (10, 'Focus Desk Tray', 'OFFICE', 'Field Office', 3900, 'event-demo-10-focus-desk-tray.webp'),
  (11, 'Stoneware Planter', 'HOME', 'Kiln & Coast', 5200, 'event-demo-11-stoneware-planter.webp'),
  (12, 'Weekender Toaster', 'KITCHEN', 'Hearthline', 9800, 'event-demo-12-weekender-toaster.webp'),
  (13, 'Pocket Bluetooth Speaker', 'AUDIO', 'Northstar Audio', 8900, 'event-demo-13-pocket-bluetooth-speaker.webp'),
  (14, 'Studio Sunglasses', 'ACCESSORIES', 'Morrow', 6800, 'event-demo-14-studio-sunglasses.webp'),
  (15, 'Linen Cushion Cover', 'HOME', 'Common Thread', 3400, 'event-demo-15-linen-cushion-cover.webp'),
  (16, 'Click Wireless Mouse', 'TECH', 'Relay Works', 4900, 'event-demo-16-click-wireless-mouse.webp'),
  (17, 'Insulated Lunch Jar', 'KITCHEN', 'Trail Table', 4400, 'event-demo-17-insulated-lunch-jar.webp'),
  (18, 'Everyday Card Wallet', 'ACCESSORIES', 'Atelier June', 5600, 'event-demo-18-everyday-card-wallet.webp'),
  (19, 'Bedside Alarm Clock', 'HOME', 'Field & Form', 7200, 'event-demo-19-bedside-alarm-clock.webp'),
  (20, 'Steel Water Bottle', 'FITNESS', 'North Loop', 3800, 'event-demo-20-steel-water-bottle.webp'),
  (21, 'Linen Hoodie', 'APPAREL', 'SideStage Studio', 6800, 'event-demo-21-linen-hoodie.webp'),
  (22, 'Ribbed Crew Tee', 'APPAREL', 'Common Thread', 3200, 'event-demo-22-ribbed-crew-tee.webp'),
  (23, 'Court Low Sneaker', 'FOOTWEAR', 'North Loop', 11000, 'event-demo-23-court-low-sneaker.webp'),
  (24, 'Canvas Chore Jacket', 'APPAREL', 'Workshop Union', 13800, 'event-demo-24-canvas-chore-jacket.webp'),
  (25, 'Sunday Lounge Pant', 'APPAREL', 'Soft Hours', 7200, 'event-demo-25-sunday-lounge-pant.webp'),
  (26, 'Classic Leather Belt', 'ACCESSORIES', 'Atelier June', 5800, 'event-demo-26-classic-leather-belt.webp'),
  (27, 'Merino Base Layer', 'APPAREL', 'North Loop', 8400, 'event-demo-27-merino-base-layer.webp'),
  (28, 'Trail Knit Runner', 'FOOTWEAR', 'North Loop', 12400, 'event-demo-28-trail-knit-runner.webp'),
  (29, 'Relaxed Oxford Shirt', 'APPAREL', 'Common Thread', 7600, 'event-demo-29-relaxed-oxford-shirt.webp'),
  (30, 'Utility Cargo Short', 'APPAREL', 'Workshop Union', 6900, 'event-demo-30-utility-cargo-short.webp'),
  (31, 'Studio Apron', 'APPAREL', 'Hearthline', 5400, 'event-demo-31-studio-apron.webp'),
  (32, 'Training Grip Glove', 'FITNESS', 'North Loop', 3600, 'event-demo-32-training-grip-glove.webp'),
  (33, 'Everyday Sock Set', 'APPAREL', 'Soft Hours', 2800, 'event-demo-33-everyday-sock-set.webp'),
  (34, 'Packable Rain Shell', 'APPAREL', 'Trail Table', 11800, 'event-demo-34-packable-rain-shell.webp'),
  (35, 'Felt Brim Hat', 'ACCESSORIES', 'Atelier June', 6400, 'event-demo-35-felt-brim-hat.webp'),
  (36, 'Coastal Wrap Dress', 'APPAREL', 'Atelier June', 14800, 'event-demo-36-coastal-wrap-dress.webp'),
  (37, 'Washed Denim Jacket', 'APPAREL', 'Blue Loom', 15600, 'event-demo-37-washed-denim-jacket.webp'),
  (38, 'Harbor Deck Shoe', 'FOOTWEAR', 'North Loop', 12000, 'event-demo-38-harbor-deck-shoe.webp'),
  (39, 'Soft Terry Sweatshirt', 'APPAREL', 'Soft Hours', 7800, 'event-demo-39-soft-terry-sweatshirt.webp'),
  (40, 'Tailored Work Trouser', 'APPAREL', 'Workshop Union', 11200, 'event-demo-40-tailored-work-trouser.webp'),
  (41, 'Alpine Puffer Vest', 'APPAREL', 'Trail Table', 13200, 'event-demo-41-alpine-puffer-vest.webp'),
  (42, 'Ribbed Knit Dress', 'APPAREL', 'Common Thread', 9800, 'event-demo-42-ribbed-knit-dress.webp'),
  (43, 'City Chelsea Boot', 'FOOTWEAR', 'Atelier June', 17800, 'event-demo-43-city-chelsea-boot.webp'),
  (44, 'Camp Collar Shirt', 'APPAREL', 'Blue Loom', 7200, 'event-demo-44-camp-collar-shirt.webp'),
  (45, 'Quilted House Robe', 'APPAREL', 'Soft Hours', 10800, 'event-demo-45-quilted-house-robe.webp'),
  (46, 'Studio Training Short', 'FITNESS', 'North Loop', 6200, 'event-demo-46-studio-training-short.webp'),
  (47, 'Heritage Rugby Top', 'APPAREL', 'Workshop Union', 8800, 'event-demo-47-heritage-rugby-top.webp'),
  (48, 'Lightweight Field Parka', 'APPAREL', 'Trail Table', 16400, 'event-demo-48-lightweight-field-parka.webp'),
  (49, 'Pleated Midi Skirt', 'APPAREL', 'Atelier June', 9400, 'event-demo-49-pleated-midi-skirt.webp'),
  (50, 'Brushed Flannel Overshirt', 'APPAREL', 'Blue Loom', 10200, 'event-demo-50-brushed-flannel-overshirt.webp');
-- END EVENT_DEMO_MANIFEST

CREATE TEMP TABLE event_demo_color_palette (
  position integer PRIMARY KEY,
  slug text NOT NULL,
  label text NOT NULL,
  swatch text NOT NULL
) ON COMMIT DROP;

INSERT INTO event_demo_color_palette (position, slug, label, swatch)
VALUES
  (0, 'cream', 'Cream', '#eee4d2'),
  (1, 'ember', 'Ember', '#bd4f3f'),
  (2, 'ocean', 'Ocean', '#426b8a'),
  (3, 'sage', 'Sage', '#78906f'),
  (4, 'sand', 'Sand', '#d9c7a9'),
  (5, 'plum', 'Plum', '#785a78'),
  (6, 'clay', 'Clay', '#b86f52'),
  (7, 'midnight', 'Midnight', '#202533');

CREATE TEMP TABLE event_demo_variants ON COMMIT DROP AS
SELECT
  manifest.product_number,
  manifest.title,
  manifest.product_type,
  manifest.brand,
  manifest.base_price_cents,
  manifest.image_filename,
  format('event-demo-%s', to_char(manifest.product_number, 'FM00')) AS group_id,
  variant.variant_number,
  format('event-demo-%s-v%s', to_char(manifest.product_number, 'FM00'), variant.variant_number) AS variant_id,
  palette.slug AS color_slug,
  palette.label AS color_label,
  palette.swatch AS color_swatch,
  CASE
    WHEN manifest.product_number BETWEEN 21 AND 35
      THEN (ARRAY['small', 'medium', 'large', 'extra-large'])[variant.variant_number]
    WHEN manifest.product_number >= 36
      THEN (ARRAY['small', 'medium'])[1 + mod(variant.variant_number - 1, 2)]
  END AS size_slug,
  CASE
    WHEN manifest.product_number BETWEEN 21 AND 35
      THEN (ARRAY['Small', 'Medium', 'Large', 'Extra Large'])[variant.variant_number]
    WHEN manifest.product_number >= 36
      THEN (ARRAY['Small', 'Medium'])[1 + mod(variant.variant_number - 1, 2)]
  END AS size_label
FROM event_demo_manifest AS manifest
CROSS JOIN generate_series(1, 4) AS variant(variant_number)
LEFT JOIN event_demo_color_palette AS palette
  ON palette.position = CASE
    WHEN manifest.product_number <= 20
      THEN mod(manifest.product_number + variant.variant_number - 1, 8)
    WHEN manifest.product_number >= 36 AND variant.variant_number <= 2 THEN 7
    WHEN manifest.product_number >= 36 THEN 4
  END;

-- Remove only stale rows from this explicitly tagged demo collection. Expected
-- variant ids are upserted below, so their live reserved_qty is preserved.
DELETE FROM storefront_product AS variant
USING product_catalog AS catalog
WHERE catalog.properties->>'sidestageCollection' = 'event-demo-200'
  AND variant.group_id = catalog.group_id
  AND variant.region = catalog.region
  AND NOT EXISTS (
    SELECT 1 FROM event_demo_variants AS expected
    WHERE expected.variant_id = variant.id
  );

DELETE FROM product_catalog AS catalog
WHERE catalog.properties->>'sidestageCollection' = 'event-demo-200'
  AND NOT EXISTS (
    SELECT 1 FROM event_demo_variants AS expected
    WHERE expected.group_id = catalog.group_id
  );

INSERT INTO product_catalog (
  group_id, region, product_type, title, description, brand, manufacturer,
  identifiers, properties, images, bullets, weight, dimensions, updated_at
)
SELECT
  format('event-demo-%s', to_char(product_number, 'FM00')),
  'US',
  product_type,
  title,
  format('A seller-ready %s curated for the SideStage Event Manager demo.', lower(title)),
  brand,
  brand,
  jsonb_build_object('mpn', format('EVENT_DEMO_%s', to_char(product_number, 'FM00'))),
  jsonb_build_object(
    'variantMode', CASE
      WHEN product_number <= 20 THEN 'color'
      WHEN product_number <= 35 THEN 'size'
      ELSE 'color-size'
    END,
    'productNumber', product_number,
    'sidestageCollection', 'event-demo-200'
  ),
  jsonb_build_array(jsonb_build_object(
    'url', '/demo-products/' || image_filename,
    'alt', title,
    'isPrimary', true
  )),
  jsonb_build_array(
    'Four live-sale variants',
    'Normalized catalog options',
    'Demo inventory included'
  ),
  jsonb_build_object('value', 0.8 + 0.2 * mod(product_number, 7), 'unit', 'kg'),
  jsonb_build_object(
    'length', 24 + mod(product_number, 12),
    'width', 18 + mod(product_number, 8),
    'height', 6 + mod(product_number, 10),
    'unit', 'cm'
  ),
  now()
FROM event_demo_manifest
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

-- Now that all expected group ids carry the collection marker, remove any
-- unexpected variant previously left under one of them.
DELETE FROM storefront_product AS variant
USING event_demo_manifest AS manifest
WHERE variant.group_id = format('event-demo-%s', to_char(manifest.product_number, 'FM00'))
  AND variant.region = 'US'
  AND NOT EXISTS (
    SELECT 1 FROM event_demo_variants AS expected
    WHERE expected.variant_id = variant.id
  );

INSERT INTO storefront_product (
  id, seller_id, slug, region, sku, price_cents, active, group_id, condition, handling,
  option_signature, variant_images, qty
)
SELECT
  variant_id,
  'demo-seller',
  variant_id,
  'US',
  format('SS-DEMO-%s-V%s', to_char(product_number, 'FM00'), variant_number),
  base_price_cents + (variant_number - 1) * 200,
  true,
  group_id,
  'NEW',
  2,
  concat_ws('|',
    CASE WHEN color_slug IS NOT NULL THEN 'color=' || color_slug END,
    CASE WHEN size_slug IS NOT NULL THEN 'size=' || size_slug END
  ),
  jsonb_build_array(jsonb_build_object(
    'url', '/demo-products/' || image_filename,
    'alt', title,
    'isPrimary', true
  )),
  CASE
    WHEN mod((product_number - 1) * 4 + variant_number, 19) = 15 THEN 0
    ELSE 5 + mod(product_number + variant_number, 17)
  END
FROM event_demo_variants
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

CREATE TEMP TABLE event_demo_axes ON COMMIT DROP AS
SELECT
  format('event-demo-%s-color', to_char(product_number, 'FM00')) AS id,
  format('event-demo-%s', to_char(product_number, 'FM00')) AS group_id,
  'color'::text AS slug,
  'Color'::text AS label,
  0 AS position
FROM event_demo_manifest
WHERE product_number <= 20 OR product_number >= 36
UNION ALL
SELECT
  format('event-demo-%s-size', to_char(product_number, 'FM00')),
  format('event-demo-%s', to_char(product_number, 'FM00')),
  'size',
  'Size',
  CASE WHEN product_number >= 36 THEN 1 ELSE 0 END
FROM event_demo_manifest
WHERE product_number >= 21;

DELETE FROM product_option_axes AS axis
USING event_demo_manifest AS manifest
WHERE axis.group_id = format('event-demo-%s', to_char(manifest.product_number, 'FM00'))
  AND axis.region = 'US'
  AND NOT EXISTS (
    SELECT 1 FROM event_demo_axes AS expected WHERE expected.id = axis.id
  );

INSERT INTO product_option_axes (id, group_id, region, slug, label, position, required)
SELECT id, group_id, 'US', slug, label, position, true
FROM event_demo_axes
ON CONFLICT (id) DO UPDATE SET
  group_id = EXCLUDED.group_id,
  region = EXCLUDED.region,
  slug = EXCLUDED.slug,
  label = EXCLUDED.label,
  position = EXCLUDED.position,
  required = EXCLUDED.required;

CREATE TEMP TABLE event_demo_option_values ON COMMIT DROP AS
SELECT
  group_id || '-color-' || color_slug AS id,
  group_id || '-color' AS axis_id,
  color_slug AS slug,
  min(color_label) AS label,
  (dense_rank() OVER (PARTITION BY group_id ORDER BY color_slug) - 1)::integer AS position,
  jsonb_build_object('swatch', min(color_swatch)) AS metadata
FROM event_demo_variants
WHERE color_slug IS NOT NULL
GROUP BY product_number, group_id, color_slug
UNION ALL
SELECT
  group_id || '-size-' || size_slug,
  group_id || '-size',
  size_slug,
  min(size_label),
  CASE
    WHEN product_number <= 35 THEN min(variant_number) - 1
    WHEN size_slug = 'small' THEN 0
    ELSE 1
  END,
  '{}'::jsonb
FROM event_demo_variants
WHERE size_slug IS NOT NULL
GROUP BY product_number, group_id, size_slug;

DELETE FROM product_option_values AS option_value
USING event_demo_axes AS axis
WHERE option_value.axis_id = axis.id
  AND NOT EXISTS (
    SELECT 1 FROM event_demo_option_values AS expected
    WHERE expected.id = option_value.id
  );

INSERT INTO product_option_values (id, axis_id, slug, label, position, metadata)
SELECT id, axis_id, slug, label, position, metadata
FROM event_demo_option_values
ON CONFLICT (id) DO UPDATE SET
  axis_id = EXCLUDED.axis_id,
  slug = EXCLUDED.slug,
  label = EXCLUDED.label,
  position = EXCLUDED.position,
  metadata = EXCLUDED.metadata;

CREATE TEMP TABLE event_demo_option_mappings ON COMMIT DROP AS
SELECT
  variant_id,
  group_id || '-color' AS axis_id,
  group_id || '-color-' || color_slug AS value_id
FROM event_demo_variants
WHERE color_slug IS NOT NULL
UNION ALL
SELECT
  variant_id,
  group_id || '-size',
  group_id || '-size-' || size_slug
FROM event_demo_variants
WHERE size_slug IS NOT NULL;

DELETE FROM storefront_product_option AS selected
USING event_demo_variants AS variant
WHERE selected.variant_id = variant.variant_id
  AND NOT EXISTS (
    SELECT 1 FROM event_demo_option_mappings AS expected
    WHERE expected.variant_id = selected.variant_id
      AND expected.axis_id = selected.axis_id
  );

INSERT INTO storefront_product_option (variant_id, axis_id, value_id)
SELECT variant_id, axis_id, value_id
FROM event_demo_option_mappings
ON CONFLICT (variant_id, axis_id) DO UPDATE SET
  value_id = EXCLUDED.value_id;

-- Fail the seed transaction instead of silently publishing a partial catalog.
DO $$
DECLARE
  group_count integer;
  variant_count integer;
  color_group_count integer;
  size_group_count integer;
  combined_group_count integer;
  color_assignment_count integer;
  size_assignment_count integer;
  group_image_count integer;
  variant_image_count integer;
  invalid_image_count integer;
BEGIN
  SELECT
    count(*),
    count(*) FILTER (WHERE properties->>'variantMode' = 'color'),
    count(*) FILTER (WHERE properties->>'variantMode' = 'size'),
    count(*) FILTER (WHERE properties->>'variantMode' = 'color-size')
  INTO group_count, color_group_count, size_group_count, combined_group_count
  FROM product_catalog
  WHERE properties->>'sidestageCollection' = 'event-demo-200';

  SELECT
    count(*),
    count(DISTINCT catalog.images->0->>'url'),
    count(DISTINCT variant.variant_images->0->>'url')
  INTO variant_count, group_image_count, variant_image_count
  FROM storefront_product AS variant
  JOIN product_catalog AS catalog
    ON catalog.group_id = variant.group_id AND catalog.region = variant.region
  WHERE catalog.properties->>'sidestageCollection' = 'event-demo-200';

  SELECT count(*)
  INTO invalid_image_count
  FROM storefront_product AS variant
  JOIN product_catalog AS catalog
    ON catalog.group_id = variant.group_id AND catalog.region = variant.region
  WHERE catalog.properties->>'sidestageCollection' = 'event-demo-200'
    AND (
      jsonb_array_length(catalog.images) <> 1
      OR jsonb_array_length(variant.variant_images) <> 1
      OR catalog.images->0->>'url' !~ '^/demo-products/[a-z0-9-]+\.webp$'
      OR variant.variant_images->0->>'url' IS DISTINCT FROM catalog.images->0->>'url'
      OR catalog.images->0->>'alt' IS DISTINCT FROM catalog.title
      OR variant.variant_images->0->>'alt' IS DISTINCT FROM catalog.title
    );

  SELECT
    count(*) FILTER (WHERE axis.slug = 'color'),
    count(*) FILTER (WHERE axis.slug = 'size')
  INTO color_assignment_count, size_assignment_count
  FROM storefront_product_option AS selected
  JOIN storefront_product AS variant ON variant.id = selected.variant_id
  JOIN product_catalog AS catalog
    ON catalog.group_id = variant.group_id AND catalog.region = variant.region
  JOIN product_option_axes AS axis ON axis.id = selected.axis_id
  WHERE catalog.properties->>'sidestageCollection' = 'event-demo-200';

  IF group_count <> 50 OR variant_count <> 200 THEN
    RAISE EXCEPTION
      'event-demo-200 invariant failed: expected 50 groups / 200 variants, got % / %',
      group_count, variant_count;
  END IF;
  IF color_group_count <> 20 OR size_group_count <> 15 OR combined_group_count <> 15 THEN
    RAISE EXCEPTION
      'event-demo-200 mode split failed: expected 20 / 15 / 15, got % / % / %',
      color_group_count, size_group_count, combined_group_count;
  END IF;
  IF color_assignment_count <> 140 OR size_assignment_count <> 120 THEN
    RAISE EXCEPTION
      'event-demo-200 option mapping failed: expected 140 color / 120 size, got % / %',
      color_assignment_count, size_assignment_count;
  END IF;
  IF group_image_count <> 50 OR variant_image_count <> 50 THEN
    RAISE EXCEPTION
      'event-demo-200 image invariant failed: expected 50 distinct group images reused across 200 variants, got % / %',
      group_image_count, variant_image_count;
  END IF;
  IF invalid_image_count <> 0 THEN
    RAISE EXCEPTION
      'event-demo-200 owned-image invariant failed: % variant row(s) lack one matching local group WebP and stable title alt',
      invalid_image_count;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM storefront_product AS variant
    JOIN product_catalog AS catalog
      ON catalog.group_id = variant.group_id AND catalog.region = variant.region
    WHERE catalog.properties->>'sidestageCollection' = 'event-demo-200'
    GROUP BY catalog.group_id
    HAVING count(*) <> 4
  ) THEN
    RAISE EXCEPTION 'event-demo-200 per-group invariant failed: each group must have four variants';
  END IF;
END;
$$;

-- ── Event directory (P-118 / D-019) ──────────────────────────────────────────
-- Durable Postgres is the real-data Channel Guide. Showcase events belong only
-- to the explicit DATA_BACKEND=memory fallback in event.service.ts; inserting
-- them here made a real database look multi-seller even when no seller-created
-- event had ever reached the directory.
--
-- Clean legacy buyer-visible fixtures only while their authored identity and
-- content are still intact. A seller-modified row that happens to reuse one of
-- these ids is preserved. The old unpublished draft is harmless and is left
-- alone; this seed no longer creates it on fresh databases.
DELETE FROM event AS stored
USING (VALUES
  ('sunday-drop', 'Sunday vintage drop', 'seller-marsh', 'Marsh & Co Vintage',
   'https://placehold.co/400x400/D62B1F/FFF8EF/png?text=Vintage'),
  ('midnight-sneaker-vault', 'Midnight sneaker vault', 'seller-sole', 'Sole Provisions',
   'https://placehold.co/400x400/2A1F1A/FFC400/png?text=Sneakers'),
  ('estate-jewels-hour', 'Estate jewels hour', 'seller-ashgrove', 'Ashgrove Estate',
   'https://placehold.co/400x400/8A7A6C/FFF8EF/png?text=Jewels'),
  ('tuesday-tool-run', 'Tuesday tool run', 'seller-ironbark', 'Ironbark Supply',
   'https://placehold.co/400x400/A66A00/FFF8EF/png?text=Tools'),
  ('denim-archive-drop', 'Denim archive drop', 'seller-blueloom', 'Blue Loom Archive',
   'https://placehold.co/400x400/1E7F4F/FFF8EF/png?text=Denim'),
  ('weekend-ceramics', 'Weekend ceramics studio sale', 'seller-kiln', 'Kiln & Coast',
   'https://placehold.co/400x400/E8D3BC/2A1F1A/png?text=Ceramics'),
  ('friday-flash-audio', 'Friday flash: hi-fi audio', 'seller-northstar', 'Northstar Audio',
   'https://placehold.co/400x400/2A1F1A/FFF8EF/png?text=Audio'),
  ('warehouse-clearout', 'Warehouse clear-out marathon', 'seller-restart', 'Restart Outfitters',
   'https://placehold.co/400x400/C2271C/FFF8EF/png?text=Clearout')
) AS fixture(event_id, title, seller_id, seller_name, thumbnail_url)
WHERE stored.event_id = fixture.event_id
  AND stored.seller_id = fixture.seller_id
  AND stored.seller_name = fixture.seller_name
  AND stored.title = fixture.title
  AND stored.thumbnail_url IS NOT DISTINCT FROM fixture.thumbnail_url;

COMMIT;
