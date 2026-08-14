export const PALETTE = [
  '#FFF8EF', '#FFFFFF', '#EBDFCC', '#2A1F1A', '#77685A', '#D62B1F', '#FFF8F5',
  '#B52218', '#C2271C', '#B42217', '#FFC400', '#2A1F04', '#9B6300', '#EDB400',
  '#D9A500', '#196B42', '#A61B10', '#FBF2E3', '#FDF8F0', '#FFF3E0',
  // D-004 "theme island": the video inset is deliberately dark, and its on-dark
  // values are declared as named tokens (--video-inset-bg / --on-video*), so they
  // satisfy D-002 and are not drift.
  '#10131A', '#F7F0E7', '#BCAE9F', '#343B47', '#1B2029', '#FF7A6B',
  '#F3E2CC', '#E8D3BC', '#FFFDF9',
];

/** In-page audit. Returns contrast failures, palette drift, and D-003 collisions. */
export const audit = (paletteHexes) => {
  const px = (s) => { const m = String(s).match(/-?[\d.]+/); return m ? parseFloat(m[0]) : 0; };
  const parse = (s) => {
    if (!s) return null;
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
  });
  const lum = ({ r, g, b }) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const L1 = lum(a), L2 = lum(b); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  const label = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const effBg = (el) => {
    const stack = []; let e = el;
    while (e) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return { gradient: true };
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 0.999) break; }
      e = e.parentElement;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return base;
  };

  const contrast = [], drift = [], collisions = [], accentAuto = [];
  const seenDrift = new Set();

  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const inputType = String(el.getAttribute?.('type') ?? '').toLowerCase();
    const usesNativeAccent = (el.tagName === 'INPUT' && ['checkbox', 'radio', 'range'].includes(inputType))
      || el.tagName === 'PROGRESS';

    if (['INPUT'].includes(el.tagName) && ['checkbox', 'radio', 'range'].includes(el.getAttribute('type'))) {
      if (cs.accentColor === 'auto') accentAuto.push(label(el));
    }

    for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderRightColor']) {
      // Native accent-painted controls expose a UA-default `color` even though
      // it does not paint the widget. Treat their real accentColor separately.
      if (prop === 'color' && usesNativeAccent) continue;

      // Browsers still compute border colours for sides that are not painted.
      // Reporting those values creates drift noise for border:none / 0-width UI.
      const borderSide = prop.match(/^border(Top|Bottom|Left|Right)Color$/)?.[1];
      if (borderSide
        && (cs[`border${borderSide}Style`] === 'none' || px(cs[`border${borderSide}Width`]) === 0)) continue;

      const c = parse(cs[prop]);
      if (!c || c.a === 0) continue;
      const h = hex(c);
      if (paletteHexes.includes(h)) continue;
      const key = `${prop}|${h}`;
      if (seenDrift.has(key)) continue;
      seenDrift.add(key);
      drift.push({ prop, hex: h, alpha: Math.round(c.a * 100) / 100, sample: label(el) });
    }

    const txt = (el.textContent || '').trim().toLowerCase();
    if (['BUTTON', 'A'].includes(el.tagName) && txt.length < 40
      && /\b(delete|remove|destroy|discard|reset|end (event|stream|show)|kick|ban|stop)\b/.test(txt)) {
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a > 0.5 && hex(bg) === '#D62B1F') collisions.push({ el: label(el), text: txt.slice(0, 40) });
    }

    const direct = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!direct) continue;
    const fg = parse(cs.color);
    if (!fg || fg.a === 0) continue;
    const bg = effBg(el);
    if (!bg || bg.gradient) continue;
    const fgc = fg.a < 0.999 ? over(fg, bg) : fg;
    const size = px(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400;
    const floor = (size >= 24 || (size >= 18.66 && weight >= 700)) ? 3.0 : 4.5;
    const r = ratio(fgc, bg);
    if (r < floor) contrast.push({ el: label(el), text: (el.textContent || '').trim().slice(0, 45), fg: hex(fgc), bg: hex(bg), size, ratio: Math.round(r * 100) / 100, floor });
  }

  contrast.sort((a, b) => a.ratio - b.ratio);
  return {
    href: location.href,
    counts: { contrast: contrast.length, drift: drift.length, collisions: collisions.length, accentAuto: accentAuto.length },
    contrast: contrast.slice(0, 12), drift: drift.slice(0, 25), collisions, accentAuto: accentAuto.slice(0, 3),
  };
};
