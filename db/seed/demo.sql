-- Idempotent demo catalog for a clean clone.
-- Restart's production catalog can be exported with
-- scripts/export-restart-catalog.sh; this small fixture keeps the public demo
-- runnable without shipping private or million-row production data.

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
    'Over-ear wireless headphones with adaptive noise cancellation and a  thirty-hour battery.',
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

INSERT INTO storefront_product (
  id, slug, region, price_cents, active, group_id, condition, handling, qty, reserved_qty
)
VALUES
  ('demo-espresso-new', 'barista-pro-espresso-new', 'US', 49999, true, 'demo-espresso-machine', 'NEW', 2, 12, 0),
  ('demo-espresso-refurbished', 'barista-pro-espresso-refurbished', 'US', 34999, true, 'demo-espresso-machine', 'REFURBISHED', 4, 4, 0),
  ('demo-headphones-black', 'cloud-anc-black', 'US', 19999, true, 'demo-wireless-headphones', 'NEW', 2, 24, 0),
  ('demo-headphones-sand', 'cloud-anc-sand', 'US', 20999, true, 'demo-wireless-headphones', 'NEW', 2, 8, 0),
  ('demo-camera-body', 'creator-4k-body', 'US', 89999, true, 'demo-creator-camera', 'NEW', 3, 6, 0),
  ('demo-camera-kit', 'creator-4k-kit', 'US', 109999, true, 'demo-creator-camera', 'NEW', 5, 3, 0),
  ('demo-desk-bamboo', 'lift-desk-bamboo', 'US', 54999, true, 'demo-standing-desk', 'NEW', 7, 10, 0),
  ('demo-desk-open-box', 'lift-desk-open-box', 'US', 39999, true, 'demo-standing-desk', 'USED', 9, 2, 0)
ON CONFLICT (slug, region) DO UPDATE SET
  price_cents = EXCLUDED.price_cents,
  active = EXCLUDED.active,
  group_id = EXCLUDED.group_id,
  condition = EXCLUDED.condition,
  handling = EXCLUDED.handling,
  qty = EXCLUDED.qty,
  reserved_qty = EXCLUDED.reserved_qty,
  updated_at = now();
