// driver-history.js
// Module to render and filter the driver's delivery history tab.

const $ = (id) => document.getElementById(id);

const historyListEl = $('history-list');
const historyEmpty = $('history-empty');
const historyContainer = $('history-list-container');

let allHistoryLocal = [];    // full dataset provided by driver-dashboard
let filteredHistory = [];    // subset after filtering

// Local timeAgo helper (dashboard has its own; we keep a small local copy)
function timeAgo(date) {
  if (!date) return 'Just now';
  const d = (date instanceof Date) ? date : new Date(date);
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return d.toLocaleDateString();
}

function normalizeOrder(o) {
  const copy = { ...o };
  // ensure completedAt is a Date (driver-dashboard already sets this but be robust)
  if (copy.completedAt && copy.completedAt.toDate) copy.completedAt = copy.completedAt.toDate();
  if (!copy.completedAt) copy.completedAt = new Date(0);
  return copy;
}

function renderHistory() {
  const list = filteredHistory;
  if (!list || list.length === 0) {
    historyListEl.innerHTML = '';
    historyEmpty.classList.remove('hidden');
    return;
  }
  historyEmpty.classList.add('hidden');

  const frag = document.createDocumentFragment();
  list.forEach((order) => {
    const item = buildHistoryItem(order);
    frag.appendChild(item);
  });

  historyListEl.innerHTML = '';
  historyListEl.appendChild(frag);
}

function buildHistoryItem(order) {
  const display = (window.getOrderStatusDisplay && window.getOrderStatusDisplay(order)) || { label: order.status || '', icon: '', color: '' };
  const product = (window.getProductName && window.getProductName(order)) || (order.name || 'Product');
  const client = (window.getClientInfo && window.getClientInfo(order)) || { name: '', phone: '', street: '' };
  const subtotal = order.subtotal || 0;
  const qty = order.quantity || 1;
  const completedAt = order.completedAt instanceof Date ? order.completedAt : new Date(order.completedAt || 0);
  const paid = (window.isOrderPaid && window.isOrderPaid(order)) || false;

  const item = document.createElement('div');
  item.className = 'history-item bg-white/[0.02] rounded-xl p-3 border border-white/[0.03] flex items-center justify-between gap-3';
  item.innerHTML = `
    <div class="flex-1 min-w-0">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="text-sm font-semibold text-white truncate">${window.escHTML ? window.escHTML(product) : escapeHtml(product)}</div>
          <div class="text-xs text-white/40 mt-0.5">${window.escHTML ? window.escHTML(client.name) : escapeHtml(client.name)} · ${timeAgo(completedAt)}</div>
        </div>
        <div class="text-right shrink-0">
          <div class="text-sm font-bold text-emerald-400">KSh ${subtotal.toLocaleString()}</div>
          <div class="text-xs text-white/40 mt-0.5">${qty}×</div>
        </div>
      </div>

      ${client.street ? `<div class="text-[10px] text-white/30 mt-2 truncate">📍 ${window.escHTML ? window.escHTML(client.street) : escapeHtml(client.street)}</div>` : ''}
    </div>

    <div class="ml-3 flex flex-col items-end gap-2 shrink-0">
      <span class="status-badge ${display.color} text-xs">${display.icon} ${display.label}</span>
      ${paid ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/10">💳 Paid</span>` : `<span class="text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 border border-yellow-500/10">⏳ Pay</span>`}
    </div>
  `;

  item.addEventListener('click', (e) => {
    // ignore clicks on links/buttons if present
    if (e.target.closest('a') || e.target.closest('button')) return;
    if (window.openOrderDetail) window.openOrderDetail(order);
  });

  return item;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Public: update history list from driver-dashboard
function updateHistoryList(list) {
  if (!Array.isArray(list)) list = [];
  allHistoryLocal = list.map(normalizeOrder);
  filteredHistory = [...allHistoryLocal];
  renderHistory();
  // Optionally update "no results" related UI elsewhere
}
window.updateHistoryList = updateHistoryList;

// Public: filter history (query already lowercased by dashboard)
function filterHistory(query) {
  if (!query) {
    filteredHistory = [...allHistoryLocal];
    renderHistory();
    return;
  }

  const q = query.toLowerCase();
  filteredHistory = allHistoryLocal.filter((o) => {
    const product = (window.getProductName ? window.getProductName(o) : o.name || '').toString().toLowerCase();
    const client = ((window.getClientInfo ? window.getClientInfo(o).name : '') || '').toString().toLowerCase();
    const phone = ((window.getClientInfo ? window.getClientInfo(o).phone : '') || '').toString().toLowerCase();
    const id = (o.id || '').toString().toLowerCase();
    const addr = ((window.getClientInfo ? window.getClientInfo(o).street : '') || '').toString().toLowerCase();
    const vendorNote = (o.vendorNote || '').toString().toLowerCase();

    return product.includes(q) || client.includes(q) || phone.includes(q) || id.includes(q) || addr.includes(q) || vendorNote.includes(q);
  });

  renderHistory();
}
window.filterHistory = filterHistory;

// Attach a simple "scroll-to-load-more" UX placeholder (optional)
// If you later implement server-side pagination, listen for scroll and emit an event.
// Here we just show a subtle hint if there are more than N items.
(function initHints() {
  if (!historyContainer) return;
  historyContainer.addEventListener('scroll', () => {
    // This is a no-op placeholder to enable future infinite-scroll hooks.
    // You can replace with an event dispatch: document.dispatchEvent(new CustomEvent('history:needMore'))
  });
})();

// Expose for debugging
window._historyLocal = () => ({ all: allHistoryLocal, filtered: filteredHistory });

/* End of driver-history.js */