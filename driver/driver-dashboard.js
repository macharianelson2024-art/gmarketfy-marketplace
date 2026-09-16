// ============================================
// DRIVER DASHBOARD — CORE (driver-dashboard.js)
// ============================================

import {
  getAuth,
  onAuthStateChanged,
  signOut
} from "./firebase-config.js";

import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  getDoc,
  doc,
  updateDoc,
  serverTimestamp,
  getDocs,
  setDoc,
  writeBatch,   // ⬅ must be exported from firebase-config.js (re-export from firebase/firestore)
  increment,    // ⬅ must be exported from firebase-config.js (re-export from firebase/firestore)
  app,
  auth,
  db,
  limit
} from "./firebase-config.js";

import { firebaseConfig } from './firebase-config.js';

import {
  initDriverMap,
  setDriverMapOrders,
  recenterDriverMap,
} from "./driver-map.js";

import {
  startDriverLocationSharing,
  stopDriverLocationSharing,
} from "./live-tracking.js";

// ============================
// STATE
// ============================
let driverData = null;
let activeOrders = [];
let allHistory = [];
let activeOrdersUnsub = null;
let isSubmitting = false;
let isDashboardVisible = true;
const productCache = new Map();

// Location-sharing runtime — auto-start when orders > 0, stop 60s after
let _sharingActive = false;
let _sharingStopTimer = null;

function syncLocationSharing(orders) {
  if (!driverData?.id) return;

  const shouldShare = orders.length > 0;

  if (shouldShare) {
    if (_sharingStopTimer) {
      clearTimeout(_sharingStopTimer);
      _sharingStopTimer = null;
    }
    if (!_sharingActive) {
      // Which order to advertise as "active"? Prefer one already out for
      // delivery, else fall back to the first assigned order.
      const primary =
        orders.find((o) => (o.status || "").toLowerCase() === "out for delivery") ||
        orders[0];
      startDriverLocationSharing(driverData.id, primary.id);
      _sharingActive = true;
    }
  } else {
    if (_sharingActive && !_sharingStopTimer) {
      _sharingStopTimer = setTimeout(() => {
        stopDriverLocationSharing(driverData.id);
        _sharingActive = false;
        _sharingStopTimer = null;
      }, 60000);
    }
  }
}

// DOM refs
const $ = (id) => document.getElementById(id);
const activeOrdersList = $('active-orders-list');
const activeEmpty = $('active-empty');
const statsActive = $('stats-active');
const statsToday = $('stats-today');
const statsTotal = $('stats-total');
const navBadge = $('nav-badge');
const headerStatusDot = $('header-status-dot');
const headerStatusLabel = $('header-status-label');
const loadingOverlay = $('loading-overlay');
const loadingMessage = $('loading-message');

// ============================
// STATUS SETS — single source of truth
// ============================
// 'proof uploaded' is kept only so old/legacy docs still render sensibly.
// This dashboard no longer *writes* that status — see submitProof().
const TERMINAL_STATUSES = new Set(['delivered', 'paid & delivered', 'picked up', 'cancelled']);
const ACTIVE_STATUSES = new Set(['assigned', 'out for delivery', 'proof uploaded']);
const TERMINAL_LIST = Array.from(TERMINAL_STATUSES);

// ============================
// STATUS CONFIG (base labels — payment-aware
// overrides happen in getOrderStatusDisplay)
// ============================
const STATUS_CONFIG = {
  assigned: { label: 'Assigned', icon: '🚴', color: 'assigned', nextAction: 'Start Delivery', nextStatus: 'out for delivery' },
  'out for delivery': { label: 'Out for Delivery', icon: '🚚', color: 'out-for-delivery', nextAction: 'Mark Delivered', nextStatus: null },
  'proof uploaded': { label: 'Proof Uploaded', icon: '📸', color: 'proof-uploaded', nextAction: null, nextStatus: null },
  'paid & delivered': { label: 'Paid & Delivered', icon: '💚', color: 'completed', nextAction: null, nextStatus: null },
  delivered: { label: 'Delivered', icon: '✅', color: 'completed', nextAction: null, nextStatus: null },
  cancelled: { label: 'Cancelled', icon: '❌', color: 'completed', nextAction: null, nextStatus: null }
};

// ============================
// DRIVER STATUS CONFIG
// ============================
const DRIVER_STATUS = {
  free: { label: 'Available', dot: 'free', color: 'text-emerald-400' },
  'on-road': { label: 'On Road', dot: 'on-road', color: 'text-orange-400' },
  'off-duty': { label: 'Off Duty', dot: 'off-duty', color: 'text-slate-400' },
  'not-active': { label: 'Not Active', dot: 'off-duty', color: 'text-slate-500' }
};

// ============================
// DRIVER DATA — single setter so window.driverData
// is never stale
// ============================
function setDriverData(next) {
  driverData = next;
  window.driverData = driverData;
}

function haptic(ms = 10) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

function debounce(fn, wait = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

// ============================
// FIRESTORE ORDER SHAPE HELPERS
// Real order doc:
//   name, product_id, price, subtotal, quantity
//   paymentStatus ("paid" | other), paymentTiming ("before" | "after")
//   status, driverId, vendor_id, clientId
//   createdAt, placedOn, dispatchedAt, paidAt, updatedAt (timestamps)
//   delivery: { enabled, address: { clientName, phoneNumber, streetAddress,
//               city, region, country, Apartment, HouseNo, updatedAt } }
// There is no top-level clientName/clientPhone/productName/building —
// those live under delivery.address or are just `name`.
// ============================
function getProductName(order) {
  return order.name || 'Product';
}

function getClientInfo(order) {
  const addr = order.delivery?.address || {};
  return {
    name: addr.clientName || 'Customer',
    phone: addr.phoneNumber || '',
    street: addr.streetAddress || '',
    city: addr.city || '',
    region: addr.region || '',
    country: addr.country || '',
    apartment: addr.Apartment || '',
    houseNo: addr.HouseNo || ''
  };
}

function isOrderPaid(order) {
  return order.paymentStatus === 'paid';
}

// Payment/status-aware badge — this is what makes an unpaid
// delivered order read as "Waiting for Payment" instead of just
// "Delivered", everywhere a status badge is rendered.
function getOrderStatusDisplay(order) {
  const status = order.status || 'assigned';

  if (status === 'delivered' && !isOrderPaid(order)) {
    return { label: 'Waiting for Payment', icon: '⏳', color: 'pending-payment' };
  }

  const config = STATUS_CONFIG[status] || STATUS_CONFIG.assigned;
  return { label: config.label, icon: config.icon, color: config.color };
}
window.getOrderStatusDisplay = getOrderStatusDisplay; // reusable from driver-history.js

// ============================
// FETCH PRODUCT IMAGE (cached, via product_id)
// ============================
async function fetchProductImage(productId) {
  if (!productId) return null;
  if (productCache.has(productId)) return productCache.get(productId);

  try {
    const productDoc = await getDoc(doc(db, 'products', productId));
    if (productDoc.exists()) {
      const data = productDoc.data();
      const image = data.image || data.productImage || '';
      productCache.set(productId, image);
      return image;
    }
  } catch (err) {
    console.warn('Failed to fetch product image:', err);
  }
  return null;
}

// ============================
// GENERIC MODAL HELPERS
// ============================
function openModal(modal) {
  if (!modal) return;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModalEl(modal) {
  if (!modal) return;
  modal.classList.remove('open');
  document.body.style.overflow = '';
}

// ============================
// ORDER DETAIL MODAL
// ============================
let currentDetailOrder = null;
let detailEscHandler = null;

async function openOrderDetail(order) {
  currentDetailOrder = order;
  const modal = $('order-detail-modal');
  const content = $('order-detail-content');
  if (!modal || !content) return;

  content.innerHTML = `
    <div class="flex flex-col items-center justify-center py-16">
      <div class="spinner w-10 h-10 border-2 border-white/10 border-t-indigo-400"></div>
      <p class="text-sm text-white/30 mt-4">Loading order details...</p>
    </div>
  `;

  openModal(modal);

  let productImage = order.productImage || order.image || '';
  if (!productImage && order.product_id) {
    productImage = await fetchProductImage(order.product_id);
  }

  if (currentDetailOrder?.id !== order.id) return; // closed / switched while fetching

  content.innerHTML = buildOrderDetailHTML(order, productImage);

  const closeBtn = $('order-detail-close');
  if (closeBtn) closeBtn.onclick = () => closeOrderDetail();

  modal.onclick = (e) => { if (e.target === modal) closeOrderDetail(); };

  if (detailEscHandler) document.removeEventListener('keydown', detailEscHandler);
  detailEscHandler = (e) => { if (e.key === 'Escape') closeOrderDetail(); };
  document.addEventListener('keydown', detailEscHandler);

  const actionBtn = content.querySelector('.detail-action-btn');
  if (actionBtn && !actionBtn.disabled) {
    actionBtn.addEventListener('click', () => {
      closeOrderDetail();
      handleOrderAction(order, order.status || 'assigned', actionBtn);
    });
  }

  const callBtn = content.querySelector('.detail-call-btn');
  if (callBtn) {
    callBtn.addEventListener('click', () => {
      const { phone } = getClientInfo(order);
      if (phone) window.location.href = `tel:${phone}`;
    });
  }

  const mapBtn = content.querySelector('.detail-map-btn');
  if (mapBtn) {
    mapBtn.addEventListener('click', () => {
      const { street } = getClientInfo(order);
      if (street) window.open(`https://maps.google.com/?q=${encodeURIComponent(street)}`, '_blank');
    });
  }

  const proofPreview = content.querySelector('.proof-detail-preview');
  if (proofPreview) {
    proofPreview.addEventListener('click', () => {
      const img = proofPreview.querySelector('img');
      if (img) openProofFullView(img.src);
    });
  }
}

function closeOrderDetail() {
  closeModalEl($('order-detail-modal'));
  currentDetailOrder = null;
  if (detailEscHandler) {
    document.removeEventListener('keydown', detailEscHandler);
    detailEscHandler = null;
  }
}

function safeImgSrc(src) {
  if (!src) return '';
  if (/^https?:\/\//i.test(src) || /^data:image\//i.test(src)) return src;
  return '';
}

// ============================
// BUILD ORDER DETAIL HTML
// ============================
function buildOrderDetailHTML(order, productImage) {
  const status = order.status || 'assigned';
  const display = getOrderStatusDisplay(order);
  const isPayBefore = order.paymentTiming === 'before';
  const isPaid = isOrderPaid(order);
  const client = getClientInfo(order);
  const productName = getProductName(order);
  const quantity = order.quantity || 1;
  const createdAt = order.createdAt?.toDate?.() || new Date();
  const subtotal = order.subtotal || 0;
  const vendorNote = order.vendorNote || '';
  const proofImage = safeImgSrc(order.proofImage || '');
  const safeProductImage = safeImgSrc(productImage);

  const showAction = status === 'assigned' || status === 'out for delivery';
  const actionConfig = status === 'assigned'
    ? { label: 'Start Delivery 🚚', class: 'primary', action: 'start' }
    : status === 'out for delivery'
      ? { label: 'Mark Delivered 📸', class: 'success', action: 'deliver' }
      : null;

  const addressLine1 = [client.street, client.city].filter(Boolean).join(', ');
  const addressLine2 = [
    client.apartment ? `Apt ${client.apartment}` : '',
    client.houseNo ? `House No. ${client.houseNo}` : ''
  ].filter(Boolean).join(' · ');

  return `
    <div class="space-y-4">
      <div class="relative -mx-6 -mt-6 rounded-t-3xl overflow-hidden h-64 bg-white/5">
        ${safeProductImage ? `
          <img src="${safeProductImage}" alt="${escHTML(productName)}" class="w-full h-full object-cover" loading="lazy" />
          <div class="absolute inset-0 bg-gradient-to-t from-[#0c0e12] via-transparent to-transparent"></div>
        ` : `
          <div class="w-full h-full flex items-center justify-center text-7xl opacity-20">📦</div>
        `}
        <div class="absolute top-4 right-4">
          <span class="status-badge ${display.color} glass px-3 py-1.5 text-xs">${display.icon} ${display.label}</span>
        </div>
        <div class="absolute bottom-4 left-4 flex gap-2 flex-wrap">
          ${isPayBefore ? `
            <span class="text-[10px] px-3 py-1.5 rounded-full glass ${isPaid ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20' : 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/20'}">
              ${isPaid ? '💳 Paid Before' : '⏳ Pay Before'}
            </span>
          ` : `
            <span class="text-[10px] px-3 py-1.5 rounded-full glass ${isPaid ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20' : 'bg-blue-500/20 text-blue-400 border border-blue-500/20'}">
              ${isPaid ? '💳 Paid' : '📦 Pay After'}
            </span>
          `}
        </div>
      </div>

      <div class="flex items-start justify-between">
        <div class="flex-1 min-w-0">
          <h3 class="text-xl font-bold text-white">${escHTML(productName)}</h3>
          <p class="text-sm text-white/30 mt-0.5">Order #${order.id.slice(-8).toUpperCase()} · ${timeAgo(createdAt)}</p>
        </div>
        <span class="text-2xl font-black text-emerald-400 ml-3 shrink-0">KSh ${subtotal.toLocaleString()}</span>
      </div>

      <div class="flex items-center gap-4 text-sm text-white/40 bg-white/[0.02] rounded-xl p-3 border border-white/[0.03]">
        <span>📦 Qty: <strong class="text-white">×${quantity}</strong></span>
      </div>

      <div class="bg-white/[0.02] rounded-xl p-4 border border-white/[0.03] space-y-3">
        <h4 class="text-[10px] font-bold text-white/30 uppercase tracking-wider">👤 Client Details</h4>
        <div class="flex items-center justify-between">
          <span class="text-sm text-white/40">Name</span>
          <span class="text-sm text-white/80 font-medium">${escHTML(client.name)}</span>
        </div>
        ${client.phone ? `
          <div class="flex items-center justify-between">
            <span class="text-sm text-white/40">Phone</span>
            <button class="detail-call-btn text-sm text-indigo-400 hover:text-indigo-300 transition font-medium flex items-center gap-1.5">
              <i class="fas fa-phone-alt text-xs"></i>${escHTML(client.phone)}
            </button>
          </div>
        ` : ''}
        ${addressLine1 ? `
          <div class="flex items-start justify-between gap-4 pt-2 border-t border-white/5">
            <span class="text-sm text-white/40 shrink-0">📍 Address</span>
            <div class="text-right flex-1">
              <p class="text-sm text-white/70 leading-relaxed">${escHTML(addressLine1)}</p>
              ${addressLine2 ? `<p class="text-xs text-white/40 mt-0.5">${escHTML(addressLine2)}</p>` : ''}
              <button class="detail-map-btn text-xs text-indigo-400/60 hover:text-indigo-400 transition mt-1 flex items-center justify-end gap-1">
                <i class="fas fa-external-link-alt text-[10px]"></i>Open in Maps
              </button>
            </div>
          </div>
        ` : ''}
      </div>

      ${vendorNote ? `
        <div class="bg-yellow-500/5 border border-yellow-500/10 rounded-xl p-3">
          <p class="text-[10px] text-yellow-400/60 font-semibold uppercase tracking-wider">📝 Vendor Note</p>
          <p class="text-sm text-white/70 mt-1 italic">${escHTML(vendorNote)}</p>
        </div>
      ` : ''}

      ${proofImage ? `
        <div class="bg-white/[0.02] rounded-xl p-3 border border-white/[0.03]">
          <p class="text-[10px] text-white/30 font-semibold uppercase tracking-wider mb-2">📸 Delivery Proof</p>
          <div class="relative rounded-xl overflow-hidden cursor-pointer proof-detail-preview">
            <img src="${proofImage}" alt="Delivery proof" class="w-full h-40 object-cover" loading="lazy" />
            <div class="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent flex items-end p-3">
              <span class="text-xs text-white/80 font-medium">Tap to view full size</span>
            </div>
          </div>
        </div>
      ` : ''}

      ${showAction && actionConfig ? `
        <button class="detail-action-btn action-btn ${actionConfig.class} mt-2" data-action="${actionConfig.action}">${actionConfig.label}</button>
      ` : status === 'delivered' && !isPaid ? `
        <button class="action-btn secondary w-full" disabled><i class="fas fa-hourglass-half"></i> Waiting for Payment</button>
      ` : ''}

      <div class="bg-white/[0.02] rounded-xl p-3 border border-white/[0.03] mt-2">
        <p class="text-[10px] text-white/30 font-semibold uppercase tracking-wider mb-2">⏱️ Timeline</p>
        <div class="space-y-1.5 text-xs text-white/40">
          <div class="flex items-center justify-between"><span>📦 Order Placed</span><span>${timeAgo(createdAt)}</span></div>
          ${order.dispatchedAt ? `<div class="flex items-center justify-between text-purple-400/60"><span>🚴 Dispatched to Driver</span><span>${timeAgo(order.dispatchedAt?.toDate?.() || order.dispatchedAt)}</span></div>` : ''}
          ${order.status === 'out for delivery' ? `<div class="flex items-center justify-between text-orange-400/60"><span>🚚 Out for Delivery</span><span>●</span></div>` : ''}
          ${order.completedAt ? `<div class="flex items-center justify-between text-emerald-400/60"><span>✅ Delivered</span><span>${timeAgo(order.completedAt?.toDate?.() || order.completedAt)}</span></div>` : ''}
        </div>
      </div>
    </div>
  `;
}

// ============================
// TIME AGO HELPER
// ============================
function timeAgo(date) {
  if (!date) return 'Just now';
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(date).toLocaleDateString();
}

// ============================
// PROOF IMAGE FULL VIEW
// ============================
function openProofFullView(imageSrc) {
  const overlay = document.createElement('div');
  overlay.className = 'proof-fullview';
  overlay.innerHTML = `
    <div class="proof-fullview-inner">
      <img src="${imageSrc}" alt="Delivery proof" />
      <button class="proof-fullview-close" aria-label="Close"><i class="fas fa-times"></i></button>
    </div>
  `;

  const close = () => {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onEsc);
    setTimeout(() => overlay.remove(), 220);
  };

  const onEsc = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('button')) close(); });
  document.addEventListener('keydown', onEsc);
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);

  requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('open')));
}

// ============================
// TOAST SYSTEM
// ============================
const MAX_TOASTS = 3;

function showToast({ type = 'info', title, message, duration = 4000 }) {
  const container = $('toast-container');
  if (!container) return;

  while (container.children.length >= MAX_TOASTS) {
    container.firstElementChild?.remove();
  }

  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️', delivery: '🚚' };

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <span class="icon">${icons[type] || 'ℹ️'}</span>
    <div class="content">
      <div class="title">${escHTML(title)}</div>
      ${message ? `<div class="message">${escHTML(message)}</div>` : ''}
    </div>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-20px) scale(0.95)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

window.showToast = showToast;

// ============================
// LOADING OVERLAY
// ============================
function showLoading(message = 'Loading...') {
  loadingOverlay.classList.remove('hidden');
  loadingMessage.textContent = message;
}
function hideLoading() {
  loadingOverlay.classList.add('hidden');
}
window.showLoading = showLoading;
window.hideLoading = hideLoading;

// ============================
// NAVIGATION
// ============================
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const tabs = {
    active: $('tab-active'),
    history: $('tab-history'),
    profile: $('tab-profile'),
    map: $('tab-map'),
  };

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      if (item.classList.contains('active')) return;
      haptic(8);
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      const tab = item.dataset.tab;
      Object.keys(tabs).forEach(key => tabs[key]?.classList.toggle('active', key === tab));

      if (tab === 'history' && allHistory.length === 0) loadHistory();

      if (tab === 'map') {
        initDriverMap('driver-map-canvas').then(() => {
          // Leaflet can't measure the container while it's hidden — force a
          // redraw + recenter after the tab becomes visible.
          setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
            recenterDriverMap();
          }, 50);
        });
      }
    });
  });
}

async function checkAuth() {
  return new Promise((resolve) => {
    let resolved = false;
    let settleTimer = null;

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      // Firebase fires null *before* it restores the persisted session.
      // Wait ~1s before treating null as a real logged-out state.
      if (!user) {
        if (resolved) return;
        if (!settleTimer) {
          settleTimer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            unsubscribe();
            window.location.href = './driver.html';
          }, 1000);
        }
        return;
      }

      // User present — cancel the pending "logged out" redirect
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      if (resolved) return;
      resolved = true;

      try {
        const docSnap = await getDoc(doc(db, 'drivers', user.uid));
        if (!docSnap.exists()) {
          await signOut(auth);
          window.location.href = './driver.html';
          return;
        }

        setDriverData({ id: user.uid, ...docSnap.data() });

        if (driverData.driverLoginActivated === false) {
          window.location.href = './driver.html?reset=true';
          return;
        }

        if (driverData.status === 'not-active') {
          await updateDoc(doc(db, 'drivers', user.uid), {
            status: 'free',
            updatedAt: serverTimestamp(),
          });
          setDriverData({ ...driverData, status: 'free' });
        }

        unsubscribe();
        resolve(driverData);
      } catch (err) {
        console.error('Auth check failed:', err);
        await signOut(auth);
        window.location.href = './driver.html';
      }
    });
  });
}

// ============================
// UPDATE HEADER STATUS
// ============================
function updateHeaderStatus(status) {
  const config = DRIVER_STATUS[status] || DRIVER_STATUS['off-duty'];
  headerStatusDot.className = `driver-status-dot ${config.dot}`;
  headerStatusLabel.textContent = config.label;
  headerStatusLabel.className = `text-white/70 font-medium ${config.color}`;
}
window.updateHeaderStatus = updateHeaderStatus;

// ============================
// UPDATE STATS
// ============================
function updateStats() {
  const activeCount = activeOrders.filter(o => ACTIVE_STATUSES.has(o.status)).length;
  statsActive.textContent = activeCount;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayDeliveries = allHistory.filter(o => {
    const date = o.completedAt?.toDate?.() || o.completedAt || new Date(0);
    return date >= today;
  });
  statsToday.textContent = todayDeliveries.length;
  statsTotal.textContent = driverData?.totalDeliveries || 0;

  if (activeCount > 0) {
    navBadge.classList.remove('hidden');
    navBadge.textContent = activeCount > 9 ? '9+' : activeCount;
  } else {
    navBadge.classList.add('hidden');
  }
}

// ============================
// LISTEN TO ACTIVE ORDERS
// ============================
function listenToActiveOrders() {
  if (activeOrdersUnsub) { activeOrdersUnsub(); activeOrdersUnsub = null; }

  const q = query(
    collection(db, 'orders'),
    where('driverId', '==', driverData.id),
    where('status', 'not-in', TERMINAL_LIST),
    orderBy('createdAt', 'desc')
  );

  activeOrdersUnsub = onSnapshot(q, (snap) => {
    activeOrders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderActiveOrders();
    updateStats();
    checkForNewOrders(snap);

    // Keep the map + location sharing in sync with the current orders list
    setDriverMapOrders(activeOrders);

    const emptyEl = $('map-empty-overlay');
    if (emptyEl) emptyEl.classList.toggle('hidden', activeOrders.length > 0);

    syncLocationSharing(activeOrders);
  }, (err) => {
    console.error('Active orders listener error:', err);
    showToast({ type: 'error', title: 'Connection Error', message: 'Failed to load orders. Reconnecting...' });
  });
}

// ============================
// CHECK FOR NEW ORDERS
// ============================
let previousOrderIds = new Set();

function checkForNewOrders(snap) {
  const currentIds = new Set(snap.docs.map(d => d.id));

  if (previousOrderIds.size > 0) {
    const newIds = [...currentIds].filter(id => !previousOrderIds.has(id));
    if (newIds.length > 0) {
      const newOrder = snap.docs.find(d => d.id === newIds[0]);
      if (newOrder) {
        const order = { id: newOrder.id, ...newOrder.data() };
        const { name } = getClientInfo(order);
        showToast({
          type: 'delivery',
          title: 'New Delivery Assignment! 🚚',
          message: `${name} — ${getProductName(order)}`
        });
        haptic(200);
      }
    }
  }
  previousOrderIds = currentIds;
}

// ============================
// RENDER ACTIVE ORDERS
// ============================
function renderActiveOrders() {
  if (activeOrders.length === 0) {
    activeOrdersList.innerHTML = '';
    activeEmpty.classList.remove('hidden');
    return;
  }
  activeEmpty.classList.add('hidden');

  const fragment = document.createDocumentFragment();
  activeOrders.forEach((order, index) => fragment.appendChild(buildOrderCard(order, index)));

  activeOrdersList.innerHTML = '';
  activeOrdersList.appendChild(fragment);
}

// ============================
// BUILD ORDER CARD
// ============================
function buildOrderCard(order, index) {
  const status = order.status || 'assigned';
  const display = getOrderStatusDisplay(order);
  const isPayBefore = order.paymentTiming === 'before';
  const isPaid = isOrderPaid(order);
  const client = getClientInfo(order);
  const productName = getProductName(order);
  const quantity = order.quantity || 1;

  const card = document.createElement('div');
  card.className = 'order-card';
  card.style.animationDelay = `${Math.min(index, 6) * 60}ms`;

  card.innerHTML = `
    <div class="status-bar ${display.color}"></div>
    <div class="flex items-center justify-between mb-3">
      <span class="status-badge ${display.color}">${display.icon} ${display.label}</span>
      <div class="flex items-center gap-2">
        ${isPayBefore ? `
          <span class="text-[9px] px-2 py-0.5 rounded-full ${isPaid ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/10' : 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/10'}">
            ${isPaid ? '💳 Paid' : '⏳ Pay Before'}
          </span>
        ` : `
          <span class="text-[9px] px-2 py-0.5 rounded-full ${isPaid ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/10' : 'bg-blue-500/10 text-blue-400 border border-blue-500/10'}">
            ${isPaid ? '💳 Paid' : '📦 Pay After'}
          </span>
        `}
      </div>
    </div>

    <div class="flex items-start justify-between mb-2">
      <div class="flex-1 min-w-0">
        <h4 class="text-sm font-semibold text-white truncate">${escHTML(productName)}</h4>
        <p class="text-xs text-white/40 mt-0.5">×${quantity}</p>
      </div>
      <span class="text-sm font-bold text-emerald-400 ml-2 shrink-0">KSh ${(order.subtotal || 0).toLocaleString()}</span>
    </div>

    <div class="bg-white/[0.02] rounded-xl p-3 mb-3 space-y-1.5 border border-white/[0.03]">
      <div class="flex items-center justify-between">
        <span class="text-[10px] text-white/30">👤 Client</span>
        <span class="text-xs text-white/70 font-medium">${escHTML(client.name)}</span>
      </div>
      ${client.phone ? `
        <div class="flex items-center justify-between">
          <span class="text-[10px] text-white/30">📱 Phone</span>
          <a href="tel:${escHTML(client.phone)}" class="text-xs text-indigo-400 hover:text-indigo-300 transition font-medium">
            <i class="fas fa-phone mr-1"></i>${escHTML(client.phone)}
          </a>
        </div>
      ` : ''}
      ${client.street ? `
        <div class="flex items-start justify-between gap-2">
          <span class="text-[10px] text-white/30 shrink-0">📍 Address</span>
          <div class="flex-1 text-right">
            <p class="text-xs text-white/50 leading-relaxed">${escHTML(client.street)}${client.city ? `, ${escHTML(client.city)}` : ''}</p>
            <a href="https://maps.google.com/?q=${encodeURIComponent(client.street)}" target="_blank"
               class="text-[10px] text-indigo-400/60 hover:text-indigo-400 transition">
              <i class="fas fa-external-link-alt mr-0.5"></i>Open Maps
            </a>
          </div>
        </div>
      ` : ''}
    </div>

    ${order.vendorNote ? `
      <div class="bg-white/[0.02] rounded-xl p-2.5 mb-3 border border-white/[0.03]">
        <p class="text-[10px] text-white/30">📝 Note</p>
        <p class="text-xs text-white/50 italic mt-0.5">${escHTML(order.vendorNote)}</p>
      </div>
    ` : ''}

    <div class="mt-1">${buildActionButton(status, isPaid)}</div>
  `;

  const actionBtn = card.querySelector('.action-btn');
  if (actionBtn && !actionBtn.disabled) {
    actionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic(10);
      handleOrderAction(order, status, actionBtn);
    });
  }

  card.addEventListener('click', (e) => {
    if (e.target.closest('.action-btn') || e.target.closest('a')) return;
    openOrderDetail(order);
  });

  return card;
}

// ============================
// BUILD ACTION BUTTON
// ============================
function buildActionButton(status, isPaid) {
  if (status === 'delivered' && !isPaid) {
    return `<button class="action-btn secondary" disabled><i class="fas fa-hourglass-half"></i> Waiting for Payment</button>`;
  }
  if (status === 'proof uploaded') {
    return `<button class="action-btn secondary" disabled><i class="fas fa-clock"></i> Waiting for Vendor</button>`;
  }
  if (status === 'assigned') {
    return `<button class="action-btn primary" data-action="start"><i class="fas fa-truck"></i> Start Delivery</button>`;
  }
  if (status === 'out for delivery') {
    return `<button class="action-btn success" data-action="deliver"><i class="fas fa-camera"></i> Mark Delivered</button>`;
  }
  return `<button class="action-btn secondary" disabled><i class="fas fa-minus"></i> No Action Available</button>`;
}

// ============================
// HANDLE ORDER ACTION
// ============================
async function handleOrderAction(order, status, btn) {
  if (isSubmitting) return;
  isSubmitting = true;

  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Processing...`;

  try {
    if (status === 'assigned') {
      const batch = writeBatch(db);
      batch.update(doc(db, 'orders', order.id), { status: 'out for delivery', updatedAt: serverTimestamp() });
      batch.update(doc(db, 'drivers', driverData.id), { status: 'on-road', updatedAt: serverTimestamp() });
      await batch.commit();

      showToast({ type: 'success', title: 'Delivery Started! 🚚', message: 'You are now out for delivery' });
      updateHeaderStatus('on-road');
      setDriverData({ ...driverData, status: 'on-road' });

    } else if (status === 'out for delivery') {
      openProofModal(order);
    }
  } catch (err) {
    console.error('Action failed:', err);
    showToast({ type: 'error', title: 'Action Failed', message: err.message || 'Something went wrong' });
  } finally {
    isSubmitting = false;
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// ============================
// PROOF MODAL — listeners bound once
// ============================
let currentProofOrder = null;
let proofImageData = null;
let proofModalBound = false;
let proofModalClose = () => {};

function bindProofModalOnce() {
  if (proofModalBound) return;
  proofModalBound = true;

  const modal = $('proof-modal');
  const dropZone = $('proof-drop-zone');
  const fileInput = $('proof-file-input');
  const preview = $('proof-preview');
  const overlay = $('proof-overlay');
  const placeholder = $('proof-placeholder');
  const submitBtn = $('proof-submit-btn');
  const closeBtn = $('proof-close-btn');
  const cancelBtn = $('proof-cancel-btn');

  const handleFileSelect = (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast({ type: 'error', title: 'Invalid File', message: 'Please select an image file' });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      showToast({ type: 'warning', title: 'Large File', message: 'Image will be compressed' });
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      proofImageData = ev.target.result;
      preview.src = proofImageData;
      preview.classList.remove('hidden');
      overlay.classList.remove('hidden');
      placeholder.classList.add('hidden');
      dropZone.classList.add('has-image');
      submitBtn.disabled = false;
    };
    reader.onerror = () => showToast({ type: 'error', title: 'Read Failed', message: 'Could not read the image file' });
    reader.readAsDataURL(file);
  };

  fileInput.addEventListener('change', (e) => handleFileSelect(e.target.files[0]));

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'rgba(99, 102, 241, 0.5)';
    dropZone.style.background = 'rgba(99, 102, 241, 0.05)';
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.style.borderColor = '';
    dropZone.style.background = '';
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = '';
    dropZone.style.background = '';
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileSelect(file);
  });
  dropZone.addEventListener('click', () => fileInput.click());

  proofModalClose = () => {
    closeModalEl(modal);
    currentProofOrder = null;
    proofImageData = null;
    fileInput.value = '';
  };

  closeBtn.addEventListener('click', proofModalClose);
  cancelBtn.addEventListener('click', proofModalClose);
  modal.addEventListener('click', (e) => { if (e.target === modal) proofModalClose(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) proofModalClose();
  });

  submitBtn.addEventListener('click', () => submitProof());
}

function openProofModal(order) {
  bindProofModalOnce();

  currentProofOrder = order;
  proofImageData = null;

  const modal = $('proof-modal');
  const preview = $('proof-preview');
  const overlay = $('proof-overlay');
  const placeholder = $('proof-placeholder');
  const submitBtn = $('proof-submit-btn');
  const captionInput = $('proof-caption');
  const submitText = $('proof-submit-text');
  const spinner = $('proof-spinner');
  const fileInput = $('proof-file-input');
  const dropZone = $('proof-drop-zone');

  preview.classList.add('hidden');
  overlay.classList.add('hidden');
  placeholder.classList.remove('hidden');
  dropZone.classList.remove('has-image');
  submitBtn.disabled = true;
  submitText.textContent = 'Confirm Delivery';
  spinner.classList.add('hidden');
  captionInput.value = '';
  fileInput.value = '';

  openModal(modal);
}

// ============================
// IMAGE COMPRESSION (with error handling)
// ============================
function compressImage(dataUrl, maxW = 800, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error('Image took too long to process')), 8000);

    img.onload = () => {
      clearTimeout(timer);
      try {
        const scale = Math.min(1, maxW / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => { clearTimeout(timer); reject(new Error('Could not read that image')); };
    img.src = dataUrl;
  });
}

// ============================
// SUBMIT PROOF
// Decision point: paymentStatus on the order (NOT
// paymentTiming) decides the outcome —
//   paid     -> status: 'paid & delivered'
//   not paid -> status: 'delivered'   (shows as
//               "Waiting for Payment" via getOrderStatusDisplay)
// Both are terminal, both set updatedAt + completedAt now.
// ============================
async function submitProof() {
  if (!proofImageData || !currentProofOrder) return;

  const submitBtn = $('proof-submit-btn');
  const submitText = $('proof-submit-text');
  const spinner = $('proof-spinner');
  const captionInput = $('proof-caption');

  submitBtn.disabled = true;
  submitText.textContent = 'Uploading...';
  spinner.classList.remove('hidden');

  try {
    const compressed = await compressImage(proofImageData);
    const paid = isOrderPaid(currentProofOrder);
    const finalStatus = paid ? 'paid & delivered' : 'delivered';
    const caption = captionInput.value.trim();

    const batch = writeBatch(db);
    batch.update(doc(db, 'orders', currentProofOrder.id), {
      status: finalStatus,
      proofImage: compressed,
      vendorNote: caption,
      updatedAt: serverTimestamp(),
      completedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'proofs', currentProofOrder.id), {
      orderId: currentProofOrder.id,
      image: compressed,
      vendorNote: caption,
      driverId: driverData.id,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    await batch.commit();

    const activeCheck = await getDocs(query(
      collection(db, 'orders'),
      where('driverId', '==', driverData.id),
      where('status', '==', 'out for delivery')
    ));

    const driverUpdates = { totalDeliveries: increment(1), updatedAt: serverTimestamp() };
    if (activeCheck.empty) driverUpdates.status = 'free';
    await updateDoc(doc(db, 'drivers', driverData.id), driverUpdates);

    setDriverData({
      ...driverData,
      totalDeliveries: (driverData.totalDeliveries || 0) + 1,
      status: activeCheck.empty ? 'free' : driverData.status
    });
    if (activeCheck.empty) updateHeaderStatus('free');

    showToast({
      type: 'success',
      title: paid ? 'Delivery Confirmed! ✅' : 'Delivered — Payment Pending ⏳',
      message: paid ? 'Proof uploaded successfully' : 'Marked delivered. Awaiting payment from the client.'
    });
    haptic(15);
    proofModalClose();

  } catch (err) {
    console.error('Proof upload failed:', err);
    showToast({ type: 'error', title: 'Upload Failed', message: err.message || 'Could not upload proof. Please try again.' });
  } finally {
    submitBtn.disabled = false;
    submitText.textContent = 'Confirm Delivery';
    spinner.classList.add('hidden');
  }
}

// ============================
// LOAD HISTORY (initial)
// ============================
async function loadHistory() {
  try {
    const q = query(
      collection(db, 'orders'),
      where('driverId', '==', driverData.id),
      where('status', 'in', TERMINAL_LIST),
      orderBy('completedAt', 'desc'),
      limit(50)
    );

    const snap = await getDocs(q);
    allHistory = snap.docs.map(d => ({
      id: d.id,
      ...d.data(),
      completedAt: d.data().completedAt?.toDate?.() || new Date()
    }));

    window.updateHistoryList?.(allHistory);
    updateStats();
  } catch (err) {
    console.error('Load history failed:', err);
    showToast({ type: 'error', title: 'Could Not Load History', message: 'Pull to refresh and try again' });
  }
}

// ============================
// ESCAPE HTML
// ============================
function escHTML(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================
// LOGOUT
// ============================
async function handleLogout() {
  try {
    showLoading('Logging out...');
    await signOut(auth);
    window.location.href = "./driver.html";
  } catch (err) {
    console.error('Logout failed:', err);
    hideLoading();
    showToast({ type: 'error', title: 'Logout Failed', message: 'Please try again' });
  }
}

// ============================
// INIT
// ============================
async function initDashboard() {
  try {
    showLoading('Loading dashboard...');

    await checkAuth();
    if (!driverData) { window.location.href = "./driver.html"; return; }

    updateHeaderStatus(driverData.status || 'free');
    setupNavigation();
    listenToActiveOrders();
    await loadHistory();
    updateStats();

    $('logout-btn').addEventListener('click', handleLogout);

    // Map tab — recenter button
    const recenterBtn = $('map-recenter-btn');
    if (recenterBtn) recenterBtn.addEventListener('click', recenterDriverMap);

    const searchInput = $('history-search');
    if (searchInput) {
      searchInput.addEventListener('input', debounce((e) => {
        window.filterHistory?.(e.target.value.toLowerCase().trim());
      }, 200));
    }

    hideLoading();
  } catch (err) {
    console.error('Init failed:', err);
    hideLoading();
    showToast({ type: 'error', title: 'Failed to Load', message: 'Please refresh the page' });
  }
}

// ============================
// EXPOSE TO OTHER MODULES
// ============================
window.driverData = driverData;
window.db = db;
window.auth = auth;
window.showToast = showToast;
window.escHTML = escHTML;
window.compressImage = compressImage;
window.fetchProductImage = fetchProductImage;
window.openOrderDetail = openOrderDetail;
window.getClientInfo = getClientInfo;
window.getProductName = getProductName;
window.isOrderPaid = isOrderPaid;

// ============================
// START
// ============================
document.addEventListener('DOMContentLoaded', initDashboard);

document.addEventListener('visibilitychange', () => {
  isDashboardVisible = !document.hidden;
  if (isDashboardVisible && !activeOrdersUnsub && driverData) {
    listenToActiveOrders();
  }
});

// Stop location sharing cleanly if the driver closes the tab. The RTDB
// onDisconnect() handles crashes / connection loss; this covers the
// graceful case so no stale pin lingers for 60s.
window.addEventListener('beforeunload', () => {
  if (_sharingActive && driverData?.id) {
    stopDriverLocationSharing(driverData.id);
  }
});