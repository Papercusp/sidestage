const initialItems = [
  { id: 'weekender', initials: 'HW', tone: '', title: 'Hand-finished weekender', sku: 'WKN-148', price: '$148', stock: 4, duration: 8, notes: 'Open with the waxed-canvas finish, then show the interior laptop sleeve.', stage: 'live', planned: true },
  { id: 'catchall', initials: 'SC', tone: 'gold', title: 'Studio brass catchall', sku: 'BRA-058', price: '$58', stock: 20, duration: 6, notes: 'Compare the two patinas. Mention that every edge is hand-burnished.', stage: 'next', planned: true },
  { id: 'tote', initials: 'CT', tone: 'blue', title: 'Canvas utility tote', sku: 'TOTE-074', price: '$74', stock: 7, duration: 5, notes: 'Demo the reinforced base and the bottle pocket.', stage: 'planned', planned: true },
  { id: 'jacket', initials: 'AJ', tone: '', title: 'Archive jacket auction', sku: 'JKT-120', price: '$120', stock: 1, duration: 7, notes: 'Auction beat. Show the repaired cuff before opening bids.', stage: 'planned', planned: true },
  { id: 'lamp', initials: 'CL', tone: 'green', title: 'Ceramic task lamp', sku: 'LMP-186', price: '$186', stock: 3, duration: 4, notes: 'Dim the room before showing the warm pool of light.', stage: 'planned', planned: false },
  { id: 'linen', initials: 'LS', tone: 'gold', title: 'Washed linen shirt', sku: 'LIN-096', price: '$96', stock: 12, duration: 5, notes: 'Call out the relaxed fit and garment-dyed color.', stage: 'planned', planned: false },
];

let items = initialItems.map((item) => ({ ...item }));
let selectedId = 'catchall';
let currentMode = 'manage';
let dragId = null;
let toastTimer;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function plannedItems() {
  return items.filter((item) => item.planned);
}

function reservedItems() {
  return items.filter((item) => !item.planned);
}

function stageLabel(item) {
  if (item.stage === 'live') return '<span class="status pass">On stage</span>';
  if (item.stage === 'next') return '<span class="badge red">Next</span>';
  return '<span class="badge">Planned</span>';
}

function productMark(item) {
  return `<span class="product-mark ${item.tone}" aria-hidden="true">${escapeHtml(item.initials)}</span>`;
}

function productCopy(item) {
  return `<span class="product-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.price)} · ${item.stock} available · ${escapeHtml(item.sku)}</small><span class="row-status">${stageLabel(item)}<span class="badge">${item.duration || '—'} min</span></span></span>`;
}

function dragHandle(item) {
  return `<button class="drag-handle" type="button" draggable="true" data-drag-id="${item.id}" aria-label="Drag ${escapeHtml(item.title)} to reorder" title="Drag to reorder"></button>`;
}

function moveActions(item, index, count) {
  return `<span class="move-actions"><button class="move-button" type="button" data-move="-1" data-item-id="${item.id}" aria-label="Move ${escapeHtml(item.title)} up" ${index === 0 ? 'disabled' : ''}>↑</button><button class="move-button" type="button" data-move="1" data-item-id="${item.id}" aria-label="Move ${escapeHtml(item.title)} down" ${index === count - 1 ? 'disabled' : ''}>↓</button></span>`;
}

function reserveCard(item) {
  return `<article class="reserve-card">${productMark(item)}<span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.price)} · ${item.stock} available</small></span><button class="button small" type="button" data-add="${item.id}" aria-label="Add ${escapeHtml(item.title)} to the show plan">Add</button></article>`;
}

function renderMetrics() {
  const planned = plannedItems();
  const runtime = planned.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
  $$('[data-planned-count]').forEach((node) => { node.textContent = String(planned.length); });
  $$('[data-runtime]').forEach((node) => { node.textContent = `${runtime}m`; });
}

function renderInline() {
  const planned = plannedItems();
  const list = $('[data-inline-list]');
  if (list) {
    list.innerHTML = planned.map((item, index) => {
      const plan = item.stage === 'live'
        ? `<div class="inline-plan"><span><strong>Live state stays protected.</strong><br>Planning edits never stage or un-stage this product.</span></div>`
        : `<div class="inline-plan"><label class="plan-field"><span>Minutes</span><input type="number" min="1" max="240" value="${item.duration || ''}" data-item-id="${item.id}" data-field="duration" aria-label="Minutes for ${escapeHtml(item.title)}"></label><label class="plan-field"><span>Seller notes</span><textarea rows="1" data-item-id="${item.id}" data-field="notes" aria-label="Seller notes for ${escapeHtml(item.title)}">${escapeHtml(item.notes)}</textarea></label></div>`;
      return `<li class="inline-row sort-row ${item.stage === 'live' ? 'is-live' : ''}" data-sort-row="${item.id}">${dragHandle(item)}<div class="inline-product">${productMark(item)}${productCopy(item)}</div>${plan}${moveActions(item, index, planned.length)}</li>`;
    }).join('');
  }
  const reserve = $('[data-inline-reserve]');
  if (reserve) reserve.innerHTML = reservedItems().length ? reservedItems().map(reserveCard).join('') : '<p class="reserve-empty">Every reserved product is in the show plan.</p>';
}

function renderInspector() {
  const planned = plannedItems();
  if (!planned.some((item) => item.id === selectedId)) selectedId = planned[0]?.id || null;
  const list = $('[data-inspector-list]');
  if (list) {
    list.innerHTML = planned.map((item, index) => `<li class="inspector-row sort-row ${item.id === selectedId ? 'is-selected' : ''}" data-sort-row="${item.id}">${dragHandle(item)}${productMark(item)}<button class="select-product" type="button" data-select="${item.id}" aria-pressed="${item.id === selectedId}"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.price)} · ${item.stock} available</small></button><span class="plan-summary"><strong>${item.duration || '—'} min</strong>${item.notes ? 'Notes ready' : 'No notes'}</span>${moveActions(item, index, planned.length)}</li>`).join('');
  }
  const reserve = $('[data-inspector-reserve]');
  if (reserve) reserve.innerHTML = reservedItems().length ? `<div class="panel-title"><div><strong>Reserved, not planned</strong><small>Add without leaving this view</small></div></div>${reservedItems().map(reserveCard).join('')}` : '';
  const inspector = $('[data-inspector]');
  const item = items.find((candidate) => candidate.id === selectedId);
  if (inspector && item) {
    inspector.innerHTML = `<div class="inspector-hero">${productMark(item)}<div><span class="eyebrow">${item.stage === 'live' ? 'On stage · read only' : 'Selected plan item'}</span><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.price)} · ${item.stock} available · ${escapeHtml(item.sku)}</p></div></div><div class="inspector-form"><label class="inspector-field"><span>Planned minutes</span><input type="number" min="1" max="240" value="${item.duration || ''}" data-item-id="${item.id}" data-field="duration" ${item.stage === 'live' ? 'disabled' : ''}><small>Advisory only. Going over never blocks the room.</small></label><label class="inspector-field"><span>On-stage notes</span><textarea rows="4" data-item-id="${item.id}" data-field="notes" ${item.stage === 'live' ? 'disabled' : ''}>${escapeHtml(item.notes)}</textarea><small>Visible to the seller when this product reaches the stage.</small></label><div class="inspector-preview"><span>Active Event preview</span><strong>${escapeHtml(item.title)} · ${item.duration || '—'} minutes</strong><p>${escapeHtml(item.notes || 'No talking notes yet.')}</p></div><div class="inspector-actions">${item.stage !== 'live' ? `<button class="button danger" type="button" data-remove="${item.id}">Remove from plan</button>` : '<span class="badge">Live item stays in place</span>'}<button class="button" type="button" data-save>Save details</button></div></div>`;
  }
}

function renderManageMode() {
  const content = $('[data-mode-content]');
  const context = $('[data-mode-context]');
  if (!content || !context) return;
  context.innerHTML = `<span><strong>${items.length} reserved products</strong> · ${plannedItems().length} in the show plan</span><span>Commerce fields stay visible; timing stays summarized.</span>`;
  content.innerHTML = `<div class="manage-table"><div class="manage-header"><span>Product</span><span>Event stock</span><span>Live price</span><span>Show plan</span></div>${items.map((item) => `<article class="manage-row"><div class="manage-product">${productMark(item)}${productCopy(item)}</div><div class="manage-cell" data-label="Event stock"><strong>${item.stock} units</strong><small>Reserved inventory</small></div><div class="manage-cell" data-label="Live price"><strong>${escapeHtml(item.price)}</strong><small>Seller controlled</small></div><div class="manage-cell" data-label="Show plan"><span class="manage-plan-status ${item.planned ? '' : 'is-unplanned'}">${item.planned ? `${item.duration || '—'} min` : 'Not planned'}</span></div><button class="button small" type="button" ${item.stage === 'live' ? 'disabled' : item.planned ? `data-remove="${item.id}"` : `data-add="${item.id}"`}>${item.stage === 'live' ? 'On stage' : item.planned ? 'Remove' : 'Add to plan'}</button></article>`).join('')}</div>`;
}

function renderPlanMode() {
  const planned = plannedItems();
  const content = $('[data-mode-content]');
  const context = $('[data-mode-context]');
  if (!content || !context) return;
  const runtime = planned.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
  context.innerHTML = `<span><strong>${planned.length} planned beats · ${runtime} minutes</strong></span><span>Drag to reorder or use the arrow controls.</span>`;
  content.innerHTML = `<ol class="mode-plan-list sortable-list" aria-label="Run of show plan">${planned.map((item, index) => `<li class="mode-plan-row sort-row" data-sort-row="${item.id}">${dragHandle(item)}<span class="plan-position">${String(index + 1).padStart(2, '0')}</span><div class="mode-plan-product">${productMark(item)}${productCopy(item)}</div><label class="plan-field"><span>Minutes</span><input type="number" min="1" max="240" value="${item.duration || ''}" data-item-id="${item.id}" data-field="duration" aria-label="Minutes for ${escapeHtml(item.title)}" ${item.stage === 'live' ? 'disabled' : ''}></label><span class="mode-note-preview"><strong>Notes:</strong> ${escapeHtml(item.notes || 'None yet')}</span>${moveActions(item, index, planned.length)}</li>`).join('')}</ol>${reservedItems().length ? `<section class="reserve-well"><div><span class="eyebrow">Reserved inventory</span><h4>Add another beat</h4></div><div class="reserve-grid">${reservedItems().map(reserveCard).join('')}</div></section>` : ''}`;
}

function renderMode() {
  $$('[data-mode]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.mode === currentMode)));
  const title = $('[data-mode-title]');
  const copy = $('[data-mode-copy]');
  if (title) title.textContent = currentMode === 'manage' ? 'Manage products.' : 'Plan the show.';
  if (copy) copy.textContent = currentMode === 'manage' ? 'Review event inventory and the products reserved for this room.' : 'Order the room, budget each beat, and prepare seller notes.';
  if (currentMode === 'manage') renderManageMode(); else renderPlanMode();
}

function renderAll() {
  renderInline();
  renderInspector();
  renderMode();
  renderMetrics();
}

function markDirty(message = 'Unsaved changes') {
  $$('[data-draft-state]').forEach((node) => {
    node.textContent = message;
    node.classList.add('is-dirty');
  });
}

function showToast(message) {
  const toast = $('.toast');
  if (!toast) return;
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2600);
}

function moveItem(id, direction) {
  const planned = plannedItems();
  const index = planned.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= planned.length) return;
  const targetId = planned[target].id;
  const from = items.findIndex((item) => item.id === id);
  const to = items.findIndex((item) => item.id === targetId);
  [items[from], items[to]] = [items[to], items[from]];
  markDirty();
  renderAll();
  showToast(`${items[to].title} moved ${direction < 0 ? 'up' : 'down'}.`);
}

function moveBefore(sourceId, targetId) {
  if (!sourceId || sourceId === targetId) return;
  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  let targetIndex = items.findIndex((item) => item.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [source] = items.splice(sourceIndex, 1);
  targetIndex = items.findIndex((item) => item.id === targetId);
  items.splice(targetIndex, 0, source);
  markDirty();
  renderAll();
  showToast(`${source.title} moved before ${items.find((item) => item.id === targetId)?.title}.`);
}

function addToPlan(id) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) return;
  item.planned = true;
  selectedId = item.id;
  markDirty();
  renderAll();
  showToast(`${item.title} added to the show plan.`);
}

function removeFromPlan(id) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item || item.stage === 'live') return;
  item.planned = false;
  if (selectedId === id) selectedId = plannedItems()[0]?.id || null;
  markDirty();
  renderAll();
  showToast(`${item.title} stays reserved but is no longer planned.`);
}

function saveDraft() {
  $$('[data-draft-state]').forEach((node) => {
    node.textContent = 'Draft saved just now';
    node.classList.remove('is-dirty');
  });
  showToast('Preview saved locally. No SideStage data changed.');
}

function resetScenario() {
  items = initialItems.map((item) => ({ ...item }));
  selectedId = 'catchall';
  currentMode = 'manage';
  renderAll();
  $$('[data-draft-state]').forEach((node) => {
    node.textContent = 'Draft saved';
    node.classList.remove('is-dirty');
  });
  showToast('Shared preview scenario reset.');
}

function activateConcept(name, options = {}) {
  const tabs = $$('[data-concept]');
  const selected = tabs.find((tab) => tab.dataset.concept === name) || tabs[0];
  if (!selected) return;
  tabs.forEach((tab) => {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  $$('[data-concept-panel]').forEach((panel) => { panel.hidden = panel.dataset.conceptPanel !== selected.dataset.concept; });
  if (options.updateHash !== false) history.replaceState(null, '', `#${selected.dataset.concept}`);
  if (options.focus) selected.focus();
}

document.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-concept]');
  if (tab) return activateConcept(tab.dataset.concept);

  const move = event.target.closest('[data-move]');
  if (move) return moveItem(move.dataset.itemId, Number(move.dataset.move));

  const add = event.target.closest('[data-add]');
  if (add) return addToPlan(add.dataset.add);

  const remove = event.target.closest('[data-remove]');
  if (remove) return removeFromPlan(remove.dataset.remove);

  const select = event.target.closest('[data-select]');
  if (select) {
    selectedId = select.dataset.select;
    renderInspector();
    return;
  }

  const mode = event.target.closest('[data-mode]');
  if (mode) {
    currentMode = mode.dataset.mode;
    renderMode();
    showToast(`${currentMode === 'manage' ? 'Manage products' : 'Plan show'} mode opened.`);
    return;
  }

  if (event.target.closest('[data-save]')) return saveDraft();
  if (event.target.closest('[data-reset]')) return resetScenario();
});

document.addEventListener('change', (event) => {
  const field = event.target.closest('[data-field][data-item-id]');
  if (!field) return;
  const item = items.find((candidate) => candidate.id === field.dataset.itemId);
  if (!item) return;
  item[field.dataset.field] = field.dataset.field === 'duration' ? Math.max(1, Number(field.value) || 1) : field.value;
  markDirty();
  renderAll();
});

document.addEventListener('dragstart', (event) => {
  const handle = event.target.closest('[data-drag-id]');
  if (!handle) return;
  dragId = handle.dataset.dragId;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', dragId);
  handle.closest('[data-sort-row]')?.classList.add('is-dragging');
});

document.addEventListener('dragover', (event) => {
  const row = event.target.closest('[data-sort-row]');
  if (!row || row.dataset.sortRow === dragId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  $$('[data-sort-row].is-drag-over').forEach((candidate) => candidate.classList.remove('is-drag-over'));
  row.classList.add('is-drag-over');
});

document.addEventListener('drop', (event) => {
  const row = event.target.closest('[data-sort-row]');
  if (!row) return;
  event.preventDefault();
  const sourceId = dragId || event.dataTransfer.getData('text/plain');
  const targetId = row.dataset.sortRow;
  dragId = null;
  moveBefore(sourceId, targetId);
});

document.addEventListener('dragend', () => {
  dragId = null;
  $$('.is-dragging, .is-drag-over').forEach((node) => node.classList.remove('is-dragging', 'is-drag-over'));
});

$$('[data-concept]').forEach((tab, index, tabs) => {
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let next = index;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    activateConcept(tabs[next].dataset.concept, { focus: true });
  });
});

window.addEventListener('hashchange', () => {
  const next = window.location.hash.slice(1);
  if ($$('[data-concept]').some((tab) => tab.dataset.concept === next)) activateConcept(next, { updateHash: false });
});

const requested = window.location.hash.slice(1);
activateConcept($$('[data-concept]').some((tab) => tab.dataset.concept === requested) ? requested : 'inline-flow', { updateHash: false });
renderAll();

window.__SIDESTAGE_LINEUP_MOCKUP__ = {
  getState: () => items.map((item) => ({ ...item })),
  activateConcept,
  reset: resetScenario,
};
