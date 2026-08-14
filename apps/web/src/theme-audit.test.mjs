import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { audit, PALETTE } from '../tools/theme-audit/audit-lib.mjs';

const stylesCss = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

const rootHexes = () => {
  const root = stylesCss.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  const withoutComments = root.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...new Set((withoutComments.match(/#[0-9a-f]{6}\b/gi) ?? []).map((hex) => hex.toUpperCase()))];
};

const nativeCheckbox = {
  tagName: 'INPUT',
  id: 'catalog-row-select',
  className: '',
  childNodes: [],
  parentElement: null,
  textContent: '',
  getAttribute: (name) => name === 'type' ? 'checkbox' : null,
  getBoundingClientRect: () => ({ width: 16, height: 16 }),
};

const checkboxStyle = {
  visibility: 'visible',
  display: 'inline-block',
  opacity: '1',
  accentColor: 'rgb(214, 43, 31)',
  color: 'rgb(0, 0, 0)',
  backgroundColor: 'rgba(0, 0, 0, 0)',
  backgroundImage: 'none',
  borderTopColor: 'rgb(0, 0, 0)',
  borderBottomColor: 'rgb(0, 0, 0)',
  borderLeftColor: 'rgb(0, 0, 0)',
  borderRightColor: 'rgb(0, 0, 0)',
  borderTopStyle: 'none',
  borderBottomStyle: 'none',
  borderLeftStyle: 'none',
  borderRightStyle: 'none',
  borderTopWidth: '0px',
  borderBottomWidth: '0px',
  borderLeftWidth: '0px',
  borderRightWidth: '0px',
};

describe('theme audit drift oracle', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('covers every authored hex value in the styles.css :root token block', () => {
    expect(rootHexes().filter((hex) => !PALETTE.includes(hex))).toEqual([]);
  });

  it('does not report unpainted native-control colors or borders as drift', () => {
    vi.stubGlobal('document', { querySelectorAll: () => [nativeCheckbox] });
    vi.stubGlobal('getComputedStyle', () => checkboxStyle);
    vi.stubGlobal('location', { href: 'https://sidestage.test/?tab=config' });

    const result = audit(PALETTE);

    expect(result.counts.drift).toBe(0);
    expect(result.drift).toEqual([]);
    expect(result.counts.accentAuto).toBe(0);
  });
});
