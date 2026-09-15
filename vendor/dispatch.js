// ============================================
// DISPATCH PANEL — dispatch.js
// Slide-in left panel for undispatched drivers
// ============================================

import {
  db, collection, query, where,
  getDocs, getDoc, doc, updateDoc, serverTimestamp, onSnapshot
} from './firebase-config.js';

// =========================
// STATE
// =========================
let isPanelOpen = false;
let dispatchUnsub = null;
let undispatchedDrivers = []; // [{ driver, orders[] }]

// =========================
// INJECT STYLES
// =========================
function injectDispatchStyles() {
  if (document.getElementById('dispatch-styles')) return;

  const style = document.createElement('style');
  style.id = 'dispatch-styles';
  style.innerHTML = `

    /* ── Layout shell ── */
    #dispatch-layout {
      display: flex;
      align-items: flex-start;
      transition: gap 0.45s cubic-bezier(0.22, 1, 0.36, 1);
    }

    /* ── Side panel ── */
    #dispatch-panel {
      width: 0;
      min-width: 0;
      overflow: hidden;
      flex-shrink: 0;
      transition:
        width 0.45s cubic-bezier(0.22, 1, 0.36, 1),
        min-width 0.45s cubic-bezier(0.22, 1, 0.36, 1),
        opacity 0.35s ease;
      opacity: 0;
      will-change: width;
    }

    #dispatch-panel.open {
      width: 300px;
      min-width: 300px;
      opacity: 1;
    }

    #dispatch-panel-inner {
      width: 300px;
      padding: 0 12px 0 0;
    }

    /* ── Orders container pushed right ── */
    #dispatch-orders-wrap {
      flex: 1;
      min-width: 0;
      transition: all 0.45s cubic-bezier(0.22, 1, 0.36, 1);
    }

    /* ── Driver card ── */
    .dispatch-driver-card {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 16px;
      padding: 14px;
      margin-bottom: 10px;
      transition: border-color 0.2s ease, background 0.2s ease;
    }

    .dispatch-driver-card:hover {
      border-color: rgba(99,102,241,0.3);
      background: rgba(99,102,241,0.04);
    }

    .dispatch-btn {
      width: 100%;
      margin-top: 10px;
      padding: 9px 0;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 700;
      color: white;
      background: linear-gradient(135deg, #6366f1, #a855f7);
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: opacity 0.2s ease, transform 0.15s ease;
      box-shadow: 0 4px 14px rgba(99,102,241,0.25);
    }

    .dispatch-btn:hover {
      opacity: 0.88;
      transform: translateY(-1px);
    }

    .dispatch-btn:active {
      transform: scale(0.97);
    }

    .dispatch-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none;
    }

    .dispatch-order-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 9px;
      padding: 3px 8px;
      border-radius: 20px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.07);
      color: rgba(255,255,255,0.45);
      margin: 2px 2px 0 0;
    }

    /* ── Panel header ── */
    #dispatch-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }

    /* ── Collapse toggle (desktop) ── */
    #dispatch-toggle-btn {
      position: absolute;
      left: -14px;
      top: 24px;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: #1a1d27;
      border: 1px solid rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 10;
      transition: background 0.2s, color 0.2s, transform 0.35s cubic-bezier(0.22,1,0.36,1);
      font-size: 12px;
    }

    #dispatch-toggle-btn:hover {
      background: #6366f1;
      color: white;
      border-color: transparent;
    }

    #dispatch-panel-wrap {
      position: relative;
    }

    /* ── Floating FAB (mobile) ── */
    #dispatch-fab {
      display: none;
      position: fixed;
      top: 76px;
      right: 16px;
      z-index: 60;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: linear-gradient(135deg, #6366f1, #a855f7);
      border: none;
      cursor: pointer;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 20px rgba(99,102,241,0.45);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }

    #dispatch-fab:hover {
      transform: scale(1.08);
      box-shadow: 0 6px 28px rgba(99,102,241,0.6);
    }

    #dispatch-fab-badge {
      position: absolute;
      top: -4px;
      right: -4px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #ef4444;
      font-size: 9px;
      font-weight: 800;
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 2px solid #030406;
    }

    /* ── Mobile modal ── */
    #dispatch-mobile-modal {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 80;
      background: rgba(0,0,0,0.75);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      align-items: flex-end;
      justify-content: center;
      padding: 0;
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    #dispatch-mobile-modal.open {
      opacity: 1;
    }

    #dispatch-mobile-sheet {
      width: 100%;
      max-height: 82vh;
      background: #0f1115;
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 24px 24px 0 0;
      padding: 20px 16px 32px;
      overflow-y: auto;
      transform: translateY(100%);
      transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
    }

    #dispatch-mobile-modal.open #dispatch-mobile-sheet {
      transform: translateY(0);
    }

    /* ── Responsive: hide/show ── */
    @media (max-width: 768px) {
      #dispatch-panel-wrap { display: none !important; }
      #dispatch-fab { display: flex; }
    }

    @media (min-width: 769px) {
      #dispatch-mobile-modal { display: none !important; }
      #dispatch-fab { display: none !important; }
    }

    /* ── Scrollbar ── */
    #dispatch-panel-inner::-webkit-scrollbar,
    #dispatch-mobile-sheet::-webkit-scrollbar { width: 3px; }
    #dispatch-panel-inner::-webkit-scrollbar-track { background: transparent; }
    #dispatch-panel-inner::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 10px; }

    /* ── Empty state ── */
    .dispatch-empty {
      text-align: center;
      padding: 32px 12px;
      color: rgba(255,255,255,0.2);
      font-size: 11px;
    }

    /* ── Pulse dot on FAB ── */
    @keyframes dispatch-pulse {
      0%, 100% { box-shadow: 0 4px 20px rgba(99,102,241,0.45); }
      50% { box-shadow: 0 4px 28px rgba(99,102,241,0.75), 0 0 0 6px rgba(99,102,241,0.15); }
    }

    #dispatch-fab.has-drivers {
      animation: dispatch-pulse 2.5s ease-in-out infinite;
    }

    /* ── Spinner ── */
    @keyframes dispatch-spin {
      to { transform: rotate(360deg); }
    }
    .dispatch-spin {
      animation: dispatch-spin 0.7s linear infinite;
      display: inline-block;
    }
  `;
  document.head.appendChild(style);
}

// =========================
// INJECT DOM STRUCTURE
// =========================
function injectDispatchDOM() {
  if (document.getElementById('dispatch-panel-wrap')) return;

  // ── Find the orders tab content and wrap it ──
  const ordersList = document.getElementById('orders-list');
  if (!ordersList) return;

  // The orders tab container (parent of orders-list, filters, stats etc.)
  const ordersTabContent = ordersList.closest('.tab') || ordersList.parentElement;

  // Wrap everything in a flex layout shell
  const layoutShell = document.createElement('div');
  layoutShell.id = 'dispatch-layout';

  // Panel wrap (relative for the toggle button)
  layoutShell.innerHTML = `
    <!-- LEFT PANEL -->
    <div id="dispatch-panel-wrap" style="position:relative;">
      <div id="dispatch-panel">
        <div id="dispatch-panel-inner">

          <div id="dispatch-panel-header">
            <div>
              <p style="font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.25);margin-bottom:3px;">
                Not Dispatched
              </p>
              <h3 style="font-size:14px;font-weight:700;color:white;line-height:1.2;">
                Drivers
                <span id="dispatch-driver-count" style="font-size:11px;font-weight:500;color:rgba(99,102,241,0.8);margin-left:5px;"></span>
              </h3>
            </div>
            <button id="dispatch-close-btn" title="Close panel"
              style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);color:rgba(255,255,255,0.4);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:13px;transition:all 0.2s;">
              ✕
            </button>
          </div>

          <div id="dispatch-driver-list">
            <!-- driver cards injected here -->
          </div>

        </div>
      </div>

      <!-- Desktop toggle button (arrow) -->
      <button id="dispatch-toggle-btn" title="Toggle dispatch panel">
        <svg id="dispatch-toggle-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
      </button>
    </div>

    <!-- RIGHT: existing orders content -->
    <div id="dispatch-orders-wrap"></div>
  `;

  // Move all existing tab children into the orders wrap
  const ordersWrap = layoutShell.querySelector('#dispatch-orders-wrap');
  while (ordersTabContent.firstChild) {
    ordersWrap.appendChild(ordersTabContent.firstChild);
  }

  ordersTabContent.appendChild(layoutShell);

  // ── FAB (mobile) ──
  document.body.insertAdjacentHTML('beforeend', `
    <button id="dispatch-fab" title="Undispatched drivers">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
        <path d="M4.93 4.93a10 10 0 0 0 0 14.14"/>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
        <path d="M8.46 8.46a5 5 0 0 0 0 7.07"/>
      </svg>
      <span id="dispatch-fab-badge" class="hidden">0</span>
    </button>

    <!-- Mobile bottom sheet modal -->
    <div id="dispatch-mobile-modal">
      <div id="dispatch-mobile-sheet">
        <div style="width:40px;height:4px;background:rgba(255,255,255,0.1);border-radius:99px;margin:0 auto 18px;"></div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <div>
            <p style="font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.25);margin-bottom:2px;">Not Dispatched</p>
            <h3 style="font-size:16px;font-weight:700;color:white;">
              Drivers
              <span id="dispatch-mobile-count" style="font-size:12px;color:rgba(99,102,241,0.8);margin-left:6px;"></span>
            </h3>
          </div>
          <button id="dispatch-mobile-close"
            style="width:32px;height:32px;border-radius:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);color:rgba(255,255,255,0.4);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;">
            ✕
          </button>
        </div>
        <div id="dispatch-mobile-driver-list">
          <!-- driver cards injected here -->
        </div>
      </div>
    </div>
  `);

  bindDispatchEvents();
}

// =========================
// BIND EVENTS
// =========================
function bindDispatchEvents() {
  // Desktop toggle
  document.getElementById('dispatch-toggle-btn')?.addEventListener('click', togglePanel);
  document.getElementById('dispatch-close-btn')?.addEventListener('click', closePanel);

  // FAB open mobile modal
  document.getElementById('dispatch-fab')?.addEventListener('click', openMobileModal);

  // Close mobile modal
  document.getElementById('dispatch-mobile-close')?.addEventListener('click', closeMobileModal);
  document.getElementById('dispatch-mobile-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeMobileModal();
  });
}

// =========================
// PANEL OPEN / CLOSE
// =========================
function openPanel() {
  const panel = document.getElementById('dispatch-panel');
  const toggleIcon = document.getElementById('dispatch-toggle-icon');
  if (!panel) return;
  isPanelOpen = true;
  panel.classList.add('open');
  // Flip arrow to point right (close)
  if (toggleIcon) toggleIcon.setAttribute('points', '9 18 15 12 9 6');
}

function closePanel() {
  const panel = document.getElementById('dispatch-panel');
  const toggleIcon = document.getElementById('dispatch-toggle-icon');
  if (!panel) return;
  isPanelOpen = false;
  panel.classList.remove('open');
  // Arrow points left (open)
  if (toggleIcon) toggleIcon.setAttribute('points', '15 18 9 12 15 6');
}

function togglePanel() {
  isPanelOpen ? closePanel() : openPanel();
}

// =========================
// MOBILE MODAL
// =========================
function openMobileModal() {
  const modal = document.getElementById('dispatch-mobile-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('open')));
  document.body.style.overflow = 'hidden';
}

function closeMobileModal() {
  const modal = document.getElementById('dispatch-mobile-modal');
  if (!modal) return;
  modal.classList.remove('open');
  setTimeout(() => {
    modal.style.display = 'none';
    document.body.style.overflow = '';
  }, 400);
}

// =========================
// RENDER DRIVER CARDS (shared HTML)
// =========================
function buildDriverCardHTML(driverData, isMobile = false) {
  const { driver, orders } = driverData;
  const suffix = isMobile ? '-mobile' : '';

  const orderPills = orders.map(o => `
    <span class="dispatch-order-pill">
      📦 #${o.id.slice(-5).toUpperCase()}
    </span>
  `).join('');

  const vehicleIcon = driver.vehicleType?.toLowerCase().includes('bike') ? '🏍️'
    : driver.vehicleType?.toLowerCase().includes('car') ? '🚗'
    : '🚚';

  return `
    <div class="dispatch-driver-card" data-driver-id="${driver.id}">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        <div style="width:36px;height:36px;border-radius:10px;background:rgba(99,102,241,0.12);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">
          ${vehicleIcon}
        </div>
        <div style="min-width:0;flex:1;">
          <p style="font-size:12px;font-weight:700;color:white;truncate;">${escHTML(driver.name || 'Driver')}</p>
          <p style="font-size:10px;color:rgba(255,255,255,0.3);margin-top:1px;">${escHTML(driver.vehicleType || 'N/A')} · ${escHTML(driver.plateNumber || '—')}</p>
        </div>
        <span style="font-size:9px;padding:3px 8px;border-radius:20px;font-weight:600;background:rgba(234,179,8,0.12);color:rgb(234,179,8);border:1px solid rgba(234,179,8,0.2);flex-shrink:0;">
          ⏳ Assigned
        </span>
      </div>

      <div style="margin-bottom:8px;">
        <p style="font-size:9px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:rgba(255,255,255,0.2);margin-bottom:5px;">
          ${orders.length} order${orders.length !== 1 ? 's' : ''} assigned
        </p>
        <div style="display:flex;flex-wrap:wrap;">
          ${orderPills}
        </div>
      </div>

      <button class="dispatch-btn" data-driver-id="${driver.id}" data-order-count="${orders.length}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
        </svg>
        Dispatch Driver
      </button>
    </div>
  `;
}

// =========================
// RENDER INTO PANEL + MOBILE
// =========================
function renderDispatchPanels() {
  const desktopList = document.getElementById('dispatch-driver-list');
  const mobileList = document.getElementById('dispatch-mobile-driver-list');
  const countEl = document.getElementById('dispatch-driver-count');
  const mobileCountEl = document.getElementById('dispatch-mobile-count');
  const fab = document.getElementById('dispatch-fab');
  const fabBadge = document.getElementById('dispatch-fab-badge');

  const count = undispatchedDrivers.length;

  // Update counts
  if (countEl) countEl.textContent = count > 0 ? `(${count})` : '';
  if (mobileCountEl) mobileCountEl.textContent = count > 0 ? `(${count})` : '';

  // FAB badge
  if (fab) fab.classList.toggle('has-drivers', count > 0);
  if (fabBadge) {
    fabBadge.textContent = count;
    fabBadge.classList.toggle('hidden', count === 0);
  }

  const emptyHTML = `
    <div class="dispatch-empty">
      <p style="font-size:24px;margin-bottom:8px;">✅</p>
      <p>All drivers dispatched!</p>
    </div>`;

  const cardsHTML = count === 0
    ? emptyHTML
    : undispatchedDrivers.map(d => buildDriverCardHTML(d, false)).join('');

  const mobileCardsHTML = count === 0
    ? emptyHTML
    : undispatchedDrivers.map(d => buildDriverCardHTML(d, true)).join('');

  if (desktopList) desktopList.innerHTML = cardsHTML;
  if (mobileList) mobileList.innerHTML = mobileCardsHTML;

  // Auto-open panel if there are drivers to dispatch
  if (count > 0 && !isPanelOpen) openPanel();
  if (count === 0 && isPanelOpen) closePanel();

  // Bind dispatch buttons
  document.querySelectorAll('.dispatch-btn').forEach(btn => {
    btn.addEventListener('click', () => handleDispatch(btn));
  });
}

// =========================
// HANDLE DISPATCH
// =========================
async function handleDispatch(btn) {
  const driverId = btn.dataset.driverId;
  const driverEntry = undispatchedDrivers.find(d => d.driver.id === driverId);
  if (!driverEntry) return;

  const { driver, orders } = driverEntry;

  // Set loading state on ALL buttons for this driver
  const allBtns = document.querySelectorAll(`.dispatch-btn[data-driver-id="${driverId}"]`);
  allBtns.forEach(b => {
    b.disabled = true;
    b.innerHTML = `
      <svg class="dispatch-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
      </svg>
      Dispatching…
    `;
  });

  try {
    // Update all assigned orders → "out for delivery"
    const orderUpdates = orders.map(o =>
      updateDoc(doc(db, 'orders', o.id), {
        status: 'out for delivery',
        dispatchedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    );

    // Update driver → "on-road"
    const driverUpdate = updateDoc(doc(db, 'drivers', driverId), {
      status: 'on-road',
      updatedAt: serverTimestamp()
    });

    await Promise.all([...orderUpdates, driverUpdate]);

    window.showNotif?.({
      type: 'success',
      title: '🚀 Driver Dispatched',
      message: `${driver.name} is now out for delivery with ${orders.length} order${orders.length !== 1 ? 's' : ''}.`
    });

    // Remove from local state (snapshot will also update)
    undispatchedDrivers = undispatchedDrivers.filter(d => d.driver.id !== driverId);
    renderDispatchPanels();

  } catch (e) {
    console.error('Dispatch failed:', e);
    window.showNotif?.({
      type: 'error',
      title: 'Dispatch Failed',
      message: 'Could not dispatch driver. Please try again.'
    });

    // Restore buttons
    allBtns.forEach(b => {
      b.disabled = false;
      b.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
        </svg>
        Dispatch Driver
      `;
    });
  }
}

// =========================
// HELPER
// =========================
function escHTML(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// =========================
// LIVE LISTENER — watch assigned orders + drivers
// =========================
function startDispatchListener(vendorId) {
  if (dispatchUnsub) dispatchUnsub();

  const q = query(
    collection(db, 'orders'),
    where('vendor_id', '==', vendorId),
    where('status', '==', 'assigned')
  );

  dispatchUnsub = onSnapshot(q, async (snap) => {
    if (snap.empty) {
      undispatchedDrivers = [];
      renderDispatchPanels();
      return;
    }

    // Group orders by driverId
    const byDriver = new Map();
    snap.docs.forEach(d => {
      const order = { id: d.id, ...d.data() };
      if (!order.driverId) return;
      if (!byDriver.has(order.driverId)) byDriver.set(order.driverId, []);
      byDriver.get(order.driverId).push(order);
    });

    // Fetch driver docs (parallel)
    const driverEntries = await Promise.all(
      Array.from(byDriver.entries()).map(async ([driverId, orders]) => {
        try {
          const dSnap = await getDoc(doc(db, 'drivers', driverId));
          const driver = dSnap.exists() ? { id: dSnap.id, ...dSnap.data() } : { id: driverId, name: 'Unknown Driver' };
          return { driver, orders };
        } catch {
          return { driver: { id: driverId, name: 'Unknown Driver' }, orders };
        }
      })
    );

    undispatchedDrivers = driverEntries;
    renderDispatchPanels();

  }, (err) => {
    console.error('Dispatch listener error:', err);
  });
}

// =========================
// INIT — call this from orders.js
// =========================
export function initDispatchPanel(vendorId) {
  injectDispatchStyles();
  injectDispatchDOM();
  startDispatchListener(vendorId);
}

export function destroyDispatchPanel() {
  if (dispatchUnsub) {
    dispatchUnsub();
    dispatchUnsub = null;
  }
}