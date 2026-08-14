const conceptTabs = Array.from(document.querySelectorAll('[data-concept]'));
const conceptPanels = Array.from(document.querySelectorAll('[data-concept-panel]'));
const toast = document.querySelector('.toast');
let toastTimer;

function showToast(message) {
  if (!toast) return;
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2400);
}

function activateConcept(name, options = {}) {
  const selectedTab = conceptTabs.find((tab) => tab.dataset.concept === name) || conceptTabs[0];
  if (!selectedTab) return;
  conceptTabs.forEach((tab) => {
    const selected = tab === selectedTab;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  conceptPanels.forEach((panel) => { panel.hidden = panel.dataset.conceptPanel !== selectedTab.dataset.concept; });
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

document.querySelectorAll('[data-action]').forEach((control) => {
  control.addEventListener('click', () => showToast('Preview-only action: ' + control.dataset.action + '.'));
});

const replyContent = {
  fit: {
    recipient: 'Reply to Mara L.',
    source: 'Size notes · Hand-finished weekender',
    text: 'The medium has a 22-inch body and adjustable straps, so it should sit comfortably at 5′8″. I’m holding it up now so you can see the length.',
  },
  shipping: {
    recipient: 'Reply to Leo P.',
    source: 'Shipping policy · Checkout regions',
    text: 'We currently ship this event within the US only. I’m sorry the room did not make that clearer before checkout.',
  },
  strap: {
    recipient: 'Reply to Dana R.',
    source: 'Catalog details · Hand-finished weekender',
    text: 'Yes — the adjustable leather shoulder strap is included with every weekender.',
  },
};

const replyDrawer = document.querySelector('[data-reply-drawer]');
document.querySelectorAll('[data-draft-for]').forEach((button) => {
  button.addEventListener('click', () => {
    const content = replyContent[button.dataset.draftFor];
    if (!replyDrawer || !content) return;
    replyDrawer.querySelector('[data-reply-recipient]').textContent = content.recipient;
    replyDrawer.querySelector('[data-reply-source]').textContent = content.source;
    replyDrawer.querySelector('[data-reply-text]').value = content.text;
    replyDrawer.dataset.replyFor = button.dataset.draftFor;
    replyDrawer.hidden = false;
    replyDrawer.querySelector('[data-reply-text]').focus();
  });
});

document.querySelector('[data-close-reply]')?.addEventListener('click', () => { replyDrawer.hidden = true; });
document.querySelector('[data-send-reply]')?.addEventListener('click', () => {
  const question = replyDrawer?.dataset.replyFor;
  if (question) resolveQuestion(question, 'Reply sent to the room.');
  if (replyDrawer) replyDrawer.hidden = true;
});

function resolveQuestion(questionId, message = 'Marked answered.') {
  const card = document.querySelector('[data-question="' + questionId + '"]');
  if (!card) return;
  card.classList.add('is-resolved');
  window.setTimeout(() => {
    card.hidden = true;
    const remaining = Array.from(document.querySelectorAll('[data-question]')).filter((item) => !item.hidden).length;
    const waitingCount = document.querySelector('[data-queue-view="waiting"] span');
    if (waitingCount) waitingCount.textContent = String(remaining);
    const empty = document.querySelector('[data-queue-empty]');
    if (empty) empty.hidden = remaining !== 0;
  }, 180);
  showToast(message);
}

document.querySelectorAll('[data-resolve]').forEach((button) => {
  button.addEventListener('click', () => resolveQuestion(button.dataset.resolve));
});

document.querySelectorAll('[data-queue-view]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-queue-view]').forEach((item) => {
      const selected = item === button;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-selected', String(selected));
    });
    showToast(button.dataset.queueView === 'waiting' ? 'Showing unanswered buyer questions.' : 'Preview-only: this view would change the message set.');
  });
});

document.querySelectorAll('.focus-tabs button, .signal-filters button, .pulse-status button').forEach((button) => {
  button.addEventListener('click', () => {
    const group = button.parentElement;
    group.querySelectorAll('button').forEach((item) => {
      const selected = item === button;
      item.classList.toggle('active', selected);
      if (item.hasAttribute('role')) item.setAttribute('aria-selected', String(selected));
    });
    showToast('Preview filter: ' + button.textContent.trim() + '.');
  });
});

const requestedConcept = window.location.hash.slice(1);
const initialConcept = conceptTabs.some((tab) => tab.dataset.concept === requestedConcept) ? requestedConcept : 'answer-queue';
activateConcept(initialConcept, { updateHash: false });

window.addEventListener('hashchange', () => {
  const nextConcept = window.location.hash.slice(1);
  if (conceptTabs.some((tab) => tab.dataset.concept === nextConcept)) activateConcept(nextConcept, { updateHash: false });
});
