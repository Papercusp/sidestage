const conceptTabs = Array.from(document.querySelectorAll('[data-concept]'));
const conceptPanels = Array.from(document.querySelectorAll('[data-concept-panel]'));
const toast = document.querySelector('.toast');
let toastTimer;

function showToast(message) {
  if (!toast) return;
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 2400);
}

function activateConcept(name, options = {}) {
  const selectedTab = conceptTabs.find((tab) => tab.dataset.concept === name) || conceptTabs[0];
  if (!selectedTab) return;
  conceptTabs.forEach((tab) => {
    const selected = tab === selectedTab;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  conceptPanels.forEach((panel) => {
    panel.hidden = panel.dataset.conceptPanel !== selectedTab.dataset.concept;
  });
  if (options.updateHash !== false) history.replaceState(null, '', '#' + selectedTab.dataset.concept);
  if (options.focus) selectedTab.focus();
}

conceptTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => activateConcept(tab.dataset.concept));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let nextIndex = index;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + conceptTabs.length) % conceptTabs.length;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % conceptTabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = conceptTabs.length - 1;
    activateConcept(conceptTabs[nextIndex].dataset.concept, { focus: true });
  });
});

document.querySelectorAll('[data-preview-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    const selected = tab.getAttribute('aria-selected') === 'true';
    const label = tab.textContent.trim();
    showToast(selected ? label + ' is the visible preview.' : 'Preview-only: ' + label + ' would open its Studio workspace.');
  });
});

document.querySelectorAll('[data-action]').forEach((control) => {
  control.addEventListener('click', () => showToast('Preview-only action: ' + control.dataset.action + '.'));
});

function setManagerView(view) {
  document.querySelectorAll('[data-manager-view]').forEach((tab) => {
    const selected = tab.dataset.managerView === view;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('[data-manager-pane]').forEach((pane) => {
    pane.hidden = pane.dataset.managerPane !== view;
  });
}

document.querySelectorAll('[data-manager-view]').forEach((tab) => {
  tab.addEventListener('click', () => setManagerView(tab.dataset.managerView));
});
document.querySelectorAll('[data-manager-create]').forEach((button) => button.addEventListener('click', () => setManagerView('create')));
document.querySelectorAll('[data-manager-list]').forEach((button) => button.addEventListener('click', () => setManagerView('list')));

const detailCopy = {
  'Studio Finds: August drop': 'Eight reserved products · five still in the live lineup',
  'Home Objects preview': 'Twelve reserved products · ready to rehearse tomorrow',
  'Archive Edit · Vol. 2': 'Five reserved products · three still need details',
  'Summer sample sale': 'Ten products · replay and sales results available',
};

document.querySelectorAll('[data-manager-event]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-manager-event]').forEach((item) => item.classList.toggle('selected', item === button));
    const title = document.querySelector('[data-detail-title]');
    const copy = document.querySelector('[data-detail-copy]');
    if (title) title.textContent = button.dataset.managerEvent;
    if (copy) copy.textContent = detailCopy[button.dataset.managerEvent] || 'Seller-owned event details';
  });
});

document.querySelectorAll('[data-event-search]').forEach((input) => {
  input.addEventListener('input', () => {
    const group = input.dataset.eventSearch;
    const list = document.querySelector('[data-event-list="' + group + '"]');
    if (!list) return;
    const query = input.value.trim().toLowerCase();
    const items = Array.from(list.querySelectorAll('[data-searchable]'));
    let visible = 0;
    items.forEach((item) => {
      const matches = !query || item.dataset.searchable.toLowerCase().includes(query);
      item.hidden = !matches;
      if (matches) visible += 1;
    });
    const count = document.querySelector('[data-result-count="' + group + '"]');
    const empty = document.querySelector('[data-empty="' + group + '"]');
    if (count) count.textContent = String(visible);
    if (empty) empty.hidden = visible !== 0;
  });
});

const requestedConcept = window.location.hash.slice(1);
const initialConcept = conceptTabs.some((tab) => tab.dataset.concept === requestedConcept) ? requestedConcept : 'four-tabs';
activateConcept(initialConcept, { updateHash: false });

window.addEventListener('hashchange', () => {
  const nextConcept = window.location.hash.slice(1);
  if (conceptTabs.some((tab) => tab.dataset.concept === nextConcept)) {
    activateConcept(nextConcept, { updateHash: false });
  }
});
