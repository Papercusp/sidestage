/**
 * Imported catalog rows carry merchant-authored HTML in their description
 * (`<p><b>…`, `<ul><li>…`, `<br><br>`). Product copy in the buyer UI is
 * text-only and React escapes what it renders, so an unprojected description
 * reaches the customer as literal markup rather than prose
 * (EI-20491379430268439: Scout cards showed `<p><b>` to buyers).
 *
 * The projection belongs at the boundary where a catalog row becomes a UI
 * product, so every surface that renders the copy inherits it — fixing it per
 * render site is what let the same defect ship on two surfaces at once.
 *
 * Parsing (rather than regex-stripping) is what decodes entities correctly:
 * `&nbsp;` becomes a space and `&amp;` an ampersand. Joining text nodes on a
 * space keeps a readable separator between adjacent block tags, so list items
 * and `<br>`-separated sentences do not run together into one word.
 */
export function productDescriptionText(value: unknown): string | undefined {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : undefined;
  // No markup to project, or no DOM to parse with (non-browser callers such as
  // node-environment tests): carry the string through untouched.
  if (!raw || typeof document === 'undefined' || !/[<&]/.test(raw)) return raw;

  const template = document.createElement('template');
  template.innerHTML = raw;
  template.content.querySelectorAll('script, style, template, noscript').forEach((node) => node.remove());
  const parts: string[] = [];
  const collect = (node: Node): void => {
    if (node.nodeType === 3 && node.textContent) parts.push(node.textContent);
    node.childNodes.forEach(collect);
  };
  collect(template.content);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text ? text : undefined;
}
