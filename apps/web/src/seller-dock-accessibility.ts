const TAB_CLASS = 'dv-tab';
const ACTIVE_TAB_CLASS = 'dv-active-tab';

function idFragment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'panel';
}

/**
 * Add the WAI-ARIA relationships Dockview 6.6 omits from its generated DOM.
 *
 * Dockview owns these outer nodes (the React panel components never receive
 * them), so this is the SideStage integration seam: it annotates Dockview's
 * own active-tab class instead of maintaining a second selection state.
 */
export function syncSellerDockAccessibility(root: HTMLElement, layoutName: string): void {
  const prefix = `seller-dock-${idFragment(layoutName)}`;
  const groups = Array.from(root.querySelectorAll<HTMLElement>('.dv-groupview'));

  groups.forEach((group, groupIndex) => {
    const tabList = group.querySelector<HTMLElement>('.dv-tabs-container');
    const panel = group.querySelector<HTMLElement>('.dv-content-container');
    if (!tabList || !panel) return;

    const tabs = Array.from(tabList.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains(TAB_CLASS),
    );
    const panelId = `${prefix}-group-${groupIndex}-panel`;

    tabList.setAttribute('role', 'tablist');
    tabList.setAttribute('aria-label', 'Dock panels');
    tabList.setAttribute(
      'aria-orientation',
      group.classList.contains('dv-groupview-header-left') ||
        group.classList.contains('dv-groupview-header-right')
        ? 'vertical'
        : 'horizontal',
    );
    panel.id = panelId;
    panel.setAttribute('role', 'tabpanel');

    let activeTabId: string | undefined;
    tabs.forEach((tab, tabIndex) => {
      const title = tab.querySelector<HTMLElement>('.dv-default-tab-content')?.textContent ?? '';
      const tabId = `${prefix}-group-${groupIndex}-tab-${idFragment(title)}-${tabIndex}`;
      const selected = tab.classList.contains(ACTIVE_TAB_CLASS);

      tab.id = tabId;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(selected));
      tab.setAttribute('aria-controls', panelId);
      if (selected) activeTabId = tabId;
    });

    const labelledBy = activeTabId ?? tabs[0]?.id;
    if (labelledBy) panel.setAttribute('aria-labelledby', labelledBy);
    else panel.removeAttribute('aria-labelledby');
  });
}

/** Keep semantics aligned as Dockview adds, removes, moves, or activates tabs. */
export function observeSellerDockAccessibility(
  root: HTMLElement | null,
  layoutName: string,
): (() => void) | undefined {
  if (!root) return undefined;

  const sync = () => syncSellerDockAccessibility(root, layoutName);
  sync();
  const dockStructureSelector = [
    '.dv-groupview',
    '.dv-tabs-container',
    '.dv-tab',
    '.dv-content-container',
    '.dv-default-tab-content',
  ].join(',');
  const touchesDockStructure = (node: Node): boolean => (
    node instanceof Element &&
    (node.matches(dockStructureSelector) || node.querySelector(dockStructureSelector) !== null)
  );
  const observer = new MutationObserver((records) => {
    const needsSync = records.some((record) => {
      if (record.type === 'attributes') {
        return record.target instanceof Element && record.target.classList.contains(TAB_CLASS);
      }
      return (
        touchesDockStructure(record.target) ||
        Array.from(record.addedNodes).some(touchesDockStructure) ||
        Array.from(record.removedNodes).some(touchesDockStructure)
      );
    });
    if (needsSync) sync();
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });
  return () => observer.disconnect();
}
