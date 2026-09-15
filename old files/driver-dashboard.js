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
  app,
  auth,
  db,
  limit
} from "./firebase-config.js";

import { firebaseConfig } from './firebase-config.js';

// ============================
// STATE
// ============================
let driverData = null;
let activeOrders = [];
let allHistory = [];
let activeOrdersUnsub = null;
let historyUnsub = null;
let isSubmitting = false;
let productCache = new Map(); // Cache product images

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
// TERMINAL STATUSES
// ============================
const TERMINAL_STATUSES = new Set([
  'delivered',
  'paid & delivered',
  'picked up',
  'cancelled'
]);

const ACTIVE_STATUSES = new Set([
  'assigned',
  'out for delivery',
  'proof uploaded'
]);

// ============================
// STATUS CONFIG
// ============================
const STATUS_CONFIG = {
  assigned: {
    label: 'Assigned',
    icon: '🚴',
    color: 'assigned',
    nextAction: 'Start Delivery',
    nextIcon: '🚚',
    nextStatus: 'out for delivery'
  },
  'out for delivery': {
    label: 'Out for Delivery',
    icon: '🚚',
    color: 'out-for-delivery',
    nextAction: 'Mark Delivered',
    nextIcon: '📸',
    nextStatus: null
  },
  'proof uploaded': {
    label: 'Proof Uploaded',
    icon: '📸',
    color: 'proof-uploaded',
    nextAction: null,
    nextIcon: null,
    nextStatus: null
  },
  'paid & delivered': {
    label: 'Paid & Delivered',
    icon: '💚',
    color: 'completed',
    nextAction: null,
    nextIcon: null,
    nextStatus: null
  },
  delivered: {
    label: 'Delivered',
    icon: '✅',
    color: 'completed',
    nextAction: null,
    nextIcon: null,
    nextStatus: null
  },
  cancelled: {
    label: 'Cancelled',
    icon: '❌',
    color: 'completed',
    nextAction: null,
    nextIcon: null,
    nextStatus: null
  }
};

// ============================
// DRIVER STATUS CONFIG
// ============================
const DRIVER_STATUS = {
  free: {
    label: 'Available',
    dot: 'free',
    color: 'text-emerald-400'
  },
  'on-road': {
    label: 'On Road',
    dot: 'on-road',
    color: 'text-orange-400'
  },
  'off-duty': {
    label: 'Off Duty',
    dot: 'off-duty',
    color: 'text-slate-400'
  },
  'not-active': {
    label: 'Not Active',
    dot: 'off-duty',
    color: 'text-slate-500'
  }
};

// ============================
// FETCH PRODUCT IMAGE
// ============================
async function fetchProductImage(productId) {
  if (!productId) return null;
  
  // Check cache first
  if (productCache.has(productId)) {
    return productCache.get(productId);
  }
  
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
// ORDER DETAIL MODAL
// ============================
let currentDetailOrder = null;

async function openOrderDetail(order) {
  currentDetailOrder = order;
  const modal = $('order-detail-modal');
  const content = $('order-detail-content');
  
  if (!modal || !content) return;
  
  // Show loading state
  content.innerHTML = `
    <div class="flex flex-col items-center justify-center py-16">
      <div class="spinner w-10 h-10 border-2 border-white/10 border-t-indigo-400"></div>
      <p class="text-sm text-white/30 mt-4">Loading order details...</p>
    </div>
  `;
  
  // Open modal with fade
  modal.classList.add('open');
  
  // Fetch product image if needed
  let productImage = order.productImage || order.image || '';
  if (!productImage && order.product_id) {
    productImage = await fetchProductImage(order.product_id);
  }
  
  // Build detail view with fetched image
  content.innerHTML = buildOrderDetailHTML(order, productImage);
  
  // Bind close events
  const closeBtn = $('order-detail-close');
  if (closeBtn) {
    closeBtn.onclick = () => {
      modal.classList.remove('open');
      currentDetailOrder = null;
    };
  }
  
  modal.onclick = (e) => {
    if (e.target === modal) {
      modal.classList.remove('open');
      currentDetailOrder = null;
    }
  };
  
  // Bind action buttons in detail
  const actionBtn = content.querySelector('.detail-action-btn');
  if (actionBtn && !actionBtn.disabled) {
    actionBtn.addEventListener('click', () => {
      modal.classList.remove('open');
      const status = order.status || 'assigned';
      handleOrderAction(order, status, actionBtn);
    });
  }
  
  // Bind call and map buttons
  const callBtn = content.querySelector('.detail-call-btn');
  if (callBtn) {
    callBtn.addEventListener('click', () => {
      const phone = order.clientPhone || '';
      if (phone) {
        window.location.href = `tel:${phone}`;
      }
    });
  }
  
  const mapBtn = content.querySelector('.detail-map-btn');
  if (mapBtn) {
    mapBtn.addEventListener('click', () => {
      const address = order.delivery?.address?.streetAddress || '';
      if (address) {
        window.open(`https://maps.google.com/?q=${encodeURIComponent(address)}`, '_blank');
      }
    });
  }
  
  // Bind proof image click
  const proofPreview = content.querySelector('.proof-detail-preview');
  if (proofPreview) {
    proofPreview.addEventListener('click', () => {
      const img = proofPreview.querySelector('img');
      if (img) {
        openProofFullView(img.src);
      }
    });
  }
}

// ============================
// BUILD ORDER DETAIL HTML
// ============================
function buildOrderDetailHTML(order, productImage) {
  const status = order.status || 'assigned';
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.assigned;
  const isPayBefore = order.paymentTiming === 'before';
  const isPaid = order.paymentStatus === 'paid';
  const address = order.delivery?.address;
  const clientName = order.clientName || 'Customer';
  const clientPhone = order.clientPhone || '';
  const productName = order.productName || order.name || 'Product';
  const quantity = order.quantity || 1;
  const createdAt = order.createdAt?.toDate?.() || new Date();
  const subtotal = order.subtotal || 0;
  const vendorNote = order.vendorNote || '';
  const proofImage = order.proofImage || '';
  
  // Determine if action should be shown
  const showAction = status === 'assigned' || status === 'out for delivery';
  const actionConfig = status === 'assigned' ? {
    label: 'Start Delivery 🚚',
    class: 'primary',
    action: 'start'
  } : status === 'out for delivery' ? {
    label: 'Mark Delivered 📸',
    class: 'success',
    action: 'deliver'
  } : null;

  return `
    <div class="space-y-4">
      <!-- Product Image Header -->
      <div class="relative -mx-6 -mt-6 rounded-t-3xl overflow-hidden h-64 bg-white/5">
        ${productImage ? `
          <img src="${productImage}" alt="${escHTML(productName)}" class="w-full h-full object-cover" />
          <div class="absolute inset-0 bg-gradient-to-t from-[#0c0e12] via-transparent to-transparent"></div>
        ` : `
          <div class="w-full h-full flex items-center justify-center text-7xl opacity-20">
            📦
          </div>
        `}
        
        <!-- Status Badge -->
        <div class="absolute top-4 right-4">
          <span class="status-badge ${config.color} glass px-3 py-1.5 text-xs">
            ${config.icon} ${config.label}
          </span>
        </div>
        
        <!-- Payment Badge -->
        <div class="absolute bottom-4 left-4 flex gap-2 flex-wrap">
          ${isPayBefore ? `
            <span class="text-[10px] px-3 py-1.5 rounded-full glass ${isPaid ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20' : 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/20'}">
              ${isPaid ? '💳 Paid Before' : '⏳ Pay Before'}
            </span>
          ` : `
            <span class="text-[10px] px-3 py-1.5 rounded-full glass bg-blue-500/20 text-blue-400 border border-blue-500/20">
              📦 Pay After
            </span>
          `}
        </div>
      </div>
      
      <!-- Product Name & Price -->
      <div class="flex items-start justify-between">
        <div class="flex-1 min-w-0">
          <h3 class="text-xl font-bold text-white">${escHTML(productName)}</h3>
          <p class="text-sm text-white/30 mt-0.5">
            Order #${order.id.slice(-8).toUpperCase()} · ${timeAgo(createdAt)}
          </p>
        </div>
        <span class="text-2xl font-black text-emerald-400 ml-3 shrink-0">
          KSh ${subtotal.toLocaleString()}
        </span>
      </div>
      
      <!-- Quantity & Item Info -->
      <div class="flex items-center gap-4 text-sm text-white/40 bg-white/[0.02] rounded-xl p-3 border border-white/[0.03]">
        <span>📦 Qty: <strong class="text-white">×${quantity}</strong></span>
        ${order.options ? `
          <span class="w-px h-4 bg-white/10"></span>
          <span>⚙️ ${escHTML(order.options)}</span>
        ` : ''}
      </div>
      
      <!-- Client Info -->
      <div class="bg-white/[0.02] rounded-xl p-4 border border-white/[0.03] space-y-3">
        <h4 class="text-[10px] font-bold text-white/30 uppercase tracking-wider">👤 Client Details</h4>
        
        <div class="flex items-center justify-between">
          <span class="text-sm text-white/40">Name</span>
          <span class="text-sm text-white/80 font-medium">${escHTML(clientName)}</span>
        </div>
        
        ${clientPhone ? `
          <div class="flex items-center justify-between">
            <span class="text-sm text-white/40">Phone</span>
            <button class="detail-call-btn text-sm text-indigo-400 hover:text-indigo-300 transition font-medium flex items-center gap-1.5">
              <i class="fas fa-phone-alt text-xs"></i>
              ${escHTML(clientPhone)}
            </button>
          </div>
        ` : ''}
        
        ${address ? `
          <div class="flex items-start justify-between gap-4 pt-2 border-t border-white/5">
            <span class="text-sm text-white/40 shrink-0">📍 Address</span>
            <div class="text-right flex-1">
              <p class="text-sm text-white/70 leading-relaxed">
                ${escHTML(address.streetAddress || '')}
                ${address.city ? `, ${escHTML(address.city)}` : ''}
                ${address.building ? `, ${escHTML(address.building)}` : ''}
              </p>
              <button class="detail-map-btn text-xs text-indigo-400/60 hover:text-indigo-400 transition mt-1 flex items-center justify-end gap-1">
                <i class="fas fa-external-link-alt text-[10px]"></i>
                Open in Maps
              </button>
            </div>
          </div>
        ` : ''}
      </div>
      
      <!-- Vendor Note -->
      ${vendorNote ? `
        <div class="bg-yellow-500/5 border border-yellow-500/10 rounded-xl p-3">
          <p class="text-[10px] text-yellow-400/60 font-semibold uppercase tracking-wider">📝 Vendor Note</p>
          <p class="text-sm text-white/70 mt-1 italic">${escHTML(vendorNote)}</p>
        </div>
      ` : ''}
      
      <!-- Delivery Proof (if uploaded) -->
      ${proofImage ? `
        <div class="bg-white/[0.02] rounded-xl p-3 border border-white/[0.03]">
          <p class="text-[10px] text-white/30 font-semibold uppercase tracking-wider mb-2">📸 Delivery Proof</p>
          <div class="relative rounded-xl overflow-hidden cursor-pointer proof-detail-preview">
            <img src="${proofImage}" alt="Delivery proof" class="w-full h-40 object-cover" />
            <div class="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent flex items-end p-3">
              <span class="text-xs text-white/80 font-medium">Tap to view full size</span>
            </div>
          </div>
        </div>
      ` : ''}
      
      <!-- Action Button -->
      ${showAction && actionConfig ? `
        <button class="detail-action-btn action-btn ${actionConfig.class} mt-2" data-action="${actionConfig.action}">
          ${actionConfig.label}
        </button>
      ` : status === 'proof uploaded' ? `
        <button class="action-btn secondary w-full" disabled>
          <i class="fas fa-clock"></i> Waiting for Vendor Confirmation
        </button>
      ` : ''}
      
      <!-- Order Timeline -->
      <div class="bg-white/[0.02] rounded-xl p-3 border border-white/[0.03] mt-2">
        <p class="text-[10px] text-white/30 font-semibold uppercase tracking-wider mb-2">⏱️ Timeline</p>
        <div class="space-y-1.5 text-xs text-white/40">
          <div class="flex items-center justify-between">
            <span>📦 Order Created</span>
            <span>${timeAgo(createdAt)}</span>
          </div>
          ${order.status === 'out for delivery' ? `
            <div class="flex items-center justify-between text-orange-400/60">
              <span>🚚 Out for Delivery</span>
              <span>●</span>
            </div>
          ` : ''}
          ${order.status === 'assigned' ? `
            <div class="flex items-center justify-between text-purple-400/60">
              <span>🚴 Assigned to Driver</span>
              <span>●</span>
            </div>
          ` : ''}
          ${order.completedAt ? `
            <div class="flex items-center justify-between text-emerald-400/60">
              <span>✅ Delivered</span>
              <span>${timeAgo(order.completedAt)}</span>
            </div>
          ` : ''}
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
  overlay.className = 'fixed inset-0 z-[300] bg-black/95 backdrop-blur-sm flex items-center justify-center p-4 cursor-pointer';
  overlay.innerHTML = `
    <div class="relative max-w-2xl max-h-[90vh]">
      <img src="${imageSrc}" alt="Delivery proof" class="max-w-full max-h-[85vh] object-contain rounded-xl" />
      <button class="absolute -top-3 -right-3 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition text-sm">
        <i class="fas fa-times"></i>
      </button>
    </div>
  `;
  
  const close = () => {
    overlay.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onEsc);
  };
  
  const onEsc = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('button')) close();
  });
  document.addEventListener('keydown', onEsc);
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}

// ============================
// TOAST SYSTEM
// ============================
function showToast({ type = 'info', title, message, duration = 4000 }) {
  const container = $('toast-container');
  if (!container) return;

  const icons = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️',
    delivery: '🚚'
  };

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <span class="icon">${icons[type] || 'ℹ️'}</span>
    <div class="content">
      <div class="title">${title}</div>
      ${message ? `<div class="message">${message}</div>` : ''}
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
    profile: $('tab-profile')
  };

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');

      const tab = item.dataset.tab;
      Object.keys(tabs).forEach(key => {
        tabs[key].classList.toggle('active', key === tab);
      });

      if (tab === 'history' && allHistory.length === 0) {
        loadHistory();
      }
    });
  });
}

// ============================
// AUTH CHECK
// ============================
async function checkAuth() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        window.location.href = '/driver.html';
        return;
      }

      try {
        const docSnap = await getDoc(doc(db, 'drivers', user.uid));
        if (!docSnap.exists()) {
          await signOut(auth);
          window.location.href = '/driver.html';
          return;
        }

        driverData = { id: user.uid, ...docSnap.data() };

        if (driverData.driverLoginActivated === false) {
          window.location.href = '/driver.html?reset=true';
          return;
        }

        if (driverData.status === 'not-active') {
          await updateDoc(doc(db, 'drivers', user.uid), {
            status: 'free',
            updatedAt: serverTimestamp()
          });
          driverData.status = 'free';
        }

        resolve(driverData);
      } catch (err) {
        console.error('Auth check failed:', err);
        await signOut(auth);
        window.location.href = '/driver.html';
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

// ============================
// UPDATE STATS
// ============================
function updateStats() {
  const activeCount = activeOrders.filter(o => ACTIVE_STATUSES.has(o.status)).length;
  statsActive.textContent = activeCount;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayDeliveries = allHistory.filter(o => {
    const date = o.completedAt?.toDate?.() || new Date();
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
  if (activeOrdersUnsub) {
    activeOrdersUnsub();
    activeOrdersUnsub = null;
  }

  const q = query(
    collection(db, 'orders'),
    where('driverId', '==', driverData.id),
    where('status', 'not-in', ['delivered', 'paid & delivered', 'picked up', 'cancelled']),
    orderBy('createdAt', 'desc')
  );

  activeOrdersUnsub = onSnapshot(q, (snap) => {
    activeOrders = snap.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    renderActiveOrders();
    updateStats();
    checkForNewOrders(snap);
  }, (err) => {
    console.error('Active orders listener error:', err);
    showToast({
      type: 'error',
      title: 'Connection Error',
      message: 'Failed to load orders. Reconnecting...'
    });
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
        showToast({
          type: 'delivery',
          title: 'New Delivery Assignment! 🚚',
          message: `${order.clientName || 'Customer'} — ${order.productName || 'Order'}`
        });
        if (navigator.vibrate) navigator.vibrate(200);
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
  activeOrders.forEach((order, index) => {
    const card = buildOrderCard(order, index);
    fragment.appendChild(card);
  });

  activeOrdersList.innerHTML = '';
  activeOrdersList.appendChild(fragment);
}

// ============================
// BUILD ORDER CARD
// ============================
function buildOrderCard(order, index) {
  const status = order.status || 'assigned';
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.assigned;
  const isPayBefore = order.paymentTiming === 'before';
  const isPaid = order.paymentStatus === 'paid';
  const address = order.delivery?.address;
  const clientName = order.clientName || 'Customer';
  const clientPhone = order.clientPhone || '';
  const productName = order.productName || order.name || 'Product';
  const quantity = order.quantity || 1;

  const card = document.createElement('div');
  card.className = 'order-card';
  card.style.animationDelay = `${index * 80}ms`;
  
  card.innerHTML = `
    <div class="status-bar ${config.color}"></div>

    <div class="flex items-center justify-between mb-3">
      <span class="status-badge ${config.color}">
        ${config.icon} ${config.label}
      </span>
      <div class="flex items-center gap-2">
        ${isPayBefore ? `
          <span class="text-[9px] px-2 py-0.5 rounded-full ${isPaid ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/10' : 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/10'}">
            ${isPaid ? '💳 Paid' : '⏳ Pay Before'}
          </span>
        ` : `
          <span class="text-[9px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/10">
            📦 Pay After
          </span>
        `}
      </div>
    </div>

    <div class="flex items-start justify-between mb-2">
      <div class="flex-1 min-w-0">
        <h4 class="text-sm font-semibold text-white truncate">${escHTML(productName)}</h4>
        <p class="text-xs text-white/40 mt-0.5">×${quantity}</p>
      </div>
      <span class="text-sm font-bold text-emerald-400 ml-2 shrink-0">
        KSh ${(order.subtotal || 0).toLocaleString()}
      </span>
    </div>

    <div class="bg-white/[0.02] rounded-xl p-3 mb-3 space-y-1.5 border border-white/[0.03]">
      <div class="flex items-center justify-between">
        <span class="text-[10px] text-white/30">👤 Client</span>
        <span class="text-xs text-white/70 font-medium">${escHTML(clientName)}</span>
      </div>
      ${clientPhone ? `
        <div class="flex items-center justify-between">
          <span class="text-[10px] text-white/30">📱 Phone</span>
          <a href="tel:${escHTML(clientPhone)}" class="text-xs text-indigo-400 hover:text-indigo-300 transition font-medium">
            <i class="fas fa-phone mr-1"></i>${escHTML(clientPhone)}
          </a>
        </div>
      ` : ''}
      ${address ? `
        <div class="flex items-start justify-between gap-2">
          <span class="text-[10px] text-white/30 shrink-0">📍 Address</span>
          <div class="flex-1 text-right">
            <p class="text-xs text-white/50 leading-relaxed">${escHTML(address.streetAddress || '')}${address.city ? `, ${escHTML(address.city)}` : ''}</p>
            <a href="https://maps.google.com/?q=${encodeURIComponent(address.streetAddress || '')}" target="_blank" 
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

    <div class="mt-1">
      ${buildActionButton(order, status, config)}
    </div>
  `;

  const actionBtn = card.querySelector('.action-btn');
  if (actionBtn && !actionBtn.disabled) {
    actionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
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
function buildActionButton(order, status, config) {
  if (status === 'proof uploaded') {
    return `
      <button class="action-btn secondary" disabled>
        <i class="fas fa-clock"></i> Waiting for Vendor
      </button>
    `;
  }

  if (status === 'assigned' && config.nextStatus) {
    return `
      <button class="action-btn primary" data-action="start">
        <i class="fas fa-truck"></i> ${config.nextAction}
      </button>
    `;
  }

  if (status === 'out for delivery') {
    return `
      <button class="action-btn success" data-action="deliver">
        <i class="fas fa-camera"></i> ${config.nextAction}
      </button>
    `;
  }

  return `
    <button class="action-btn secondary" disabled>
      <i class="fas fa-minus"></i> No Action Available
    </button>
  `;
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
      await updateDoc(doc(db, 'orders', order.id), {
        status: 'out for delivery',
        updatedAt: serverTimestamp()
      });

      await updateDoc(doc(db, 'drivers', driverData.id), {
        status: 'on-road',
        updatedAt: serverTimestamp()
      });

      showToast({
        type: 'success',
        title: 'Delivery Started! 🚚',
        message: 'You are now out for delivery'
      });

      updateHeaderStatus('on-road');

    } else if (status === 'out for delivery') {
      openProofModal(order);
    }

  } catch (err) {
    console.error('Action failed:', err);
    showToast({
      type: 'error',
      title: 'Action Failed',
      message: err.message || 'Something went wrong'
    });
  } finally {
    isSubmitting = false;
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// ============================
// PROOF MODAL 
// ============================
let currentProofOrder = null;
let proofImageData = null;

function openProofModal(order) {
  currentProofOrder = order;
  proofImageData = null;
  
  const modal = $('proof-modal');
  const dropZone = $('proof-drop-zone');
  const fileInput = $('proof-file-input');
  const preview = $('proof-preview');
  const overlay = $('proof-overlay');
  const placeholder = $('proof-placeholder');
  const submitBtn = $('proof-submit-btn');
  const captionInput = $('proof-caption');
  const submitText = $('proof-submit-text');
  const spinner = $('proof-spinner');
  const closeBtn = $('proof-close-btn');

  // Reset state
  preview.classList.add('hidden');
  overlay.classList.add('hidden');
  placeholder.classList.remove('hidden');
  dropZone.classList.remove('has-image');
  submitBtn.disabled = true;
  submitText.textContent = 'Confirm Delivery';
  spinner.classList.add('hidden');
  captionInput.value = '';
  fileInput.value = '';

  // Open modal with fade
  modal.classList.add('open');

  // Handle file selection
  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      showToast({
        type: 'error',
        title: 'Invalid File',
        message: 'Please select an image file'
      });
      return;
    }

    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      showToast({
        type: 'warning',
        title: 'Large File',
        message: 'Image will be compressed'
      });
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
    reader.onerror = () => {
      showToast({
        type: 'error',
        title: 'Read Failed',
        message: 'Could not read the image file'
      });
    };
    reader.readAsDataURL(file);
  };

  fileInput.onchange = handleFileSelect;

  // Handle drag and drop (optional enhancement)
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
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      fileInput.files = files;
      handleFileSelect({ target: { files } });
    }
  });

  // Click drop zone to open file picker
  dropZone.onclick = () => fileInput.click();

  // Close handlers
  const closeModal = () => {
    modal.classList.remove('open');
    currentProofOrder = null;
    proofImageData = null;
    // Clean up
    if (fileInput) fileInput.value = '';
  };

  closeBtn.onclick = closeModal;
  $('proof-cancel-btn').onclick = closeModal;

  // Click outside to close
  modal.onclick = (e) => {
    if (e.target === modal) {
      closeModal();
    }
  };

  // ESC key to close
  const handleEsc = (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) {
      closeModal();
    }
  };
  document.addEventListener('keydown', handleEsc);
  
  // Clean up listener when modal closes
  const observer = new MutationObserver(() => {
    if (!modal.classList.contains('open')) {
      document.removeEventListener('keydown', handleEsc);
      observer.disconnect();
    }
  });
  observer.observe(modal, { attributes: true, attributeFilter: ['class'] });

  // Submit handler
  submitBtn.onclick = async () => {
    if (!proofImageData || !currentProofOrder) return;

    submitBtn.disabled = true;
    submitText.textContent = 'Uploading...';
    spinner.classList.remove('hidden');

    try {
      // Compress image
      const compressed = await compressImage(proofImageData);

      // Determine final status
      const isPayBefore = currentProofOrder.paymentTiming === 'before';
      const finalStatus = isPayBefore ? 'paid & delivered' : 'proof uploaded';

      // Update order
      await updateDoc(doc(db, 'orders', currentProofOrder.id), {
        status: finalStatus,
        proofImage: compressed,
        proofCaption: captionInput.value.trim() || '',
        completedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      // Save proof to proofs collection
      await setDoc(doc(db, 'proofs', currentProofOrder.id), {
        orderId: currentProofOrder.id,
        image: compressed,
        vendorNote: captionInput.value.trim() || '',
        driverId: driverData.id,
        updatedAt: serverTimestamp()
      });

      // Check if driver has any other out_for_delivery orders
      const activeCheck = await getDocs(query(
        collection(db, 'orders'),
        where('driverId', '==', driverData.id),
        where('status', '==', 'out for delivery')
      ));

      // If no other active deliveries, set driver status to free
      if (activeCheck.empty) {
        await updateDoc(doc(db, 'drivers', driverData.id), {
          status: 'free',
          updatedAt: serverTimestamp()
        });
        updateHeaderStatus('free');
      }

      // Increment total deliveries
      const newTotal = (driverData.totalDeliveries || 0) + 1;
      await updateDoc(doc(db, 'drivers', driverData.id), {
        totalDeliveries: newTotal
      });
      driverData.totalDeliveries = newTotal;

      showToast({
        type: 'success',
        title: 'Delivery Confirmed! ✅',
        message: 'Proof uploaded successfully'
      });

      closeModal();

    } catch (err) {
      console.error('Proof upload failed:', err);
      showToast({
        type: 'error',
        title: 'Upload Failed',
        message: err.message || 'Could not upload proof. Please try again.'
      });
    } finally {
      submitBtn.disabled = false;
      submitText.textContent = 'Confirm Delivery';
      spinner.classList.add('hidden');
    }
  };
}

// ============================
// IMAGE COMPRESSION
// ============================
function compressImage(dataUrl, maxW = 800, quality = 0.7) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = dataUrl;
  });
}

// ============================
// LOAD HISTORY (initial)
// ============================
async function loadHistory() {
  try {
    const q = query(
      collection(db, 'orders'),
      where('driverId', '==', driverData.id),
      where('status', 'in', ['delivered', 'paid & delivered', 'picked up', 'cancelled']),
      orderBy('completedAt', 'desc'),
      limit(50)
    );

    const snap = await getDocs(q);
    allHistory = snap.docs.map(d => ({
      id: d.id,
      ...d.data(),
      completedAt: d.data().completedAt?.toDate?.() || new Date()
    }));

    if (window.updateHistoryList) {
      window.updateHistoryList(allHistory);
    }

  } catch (err) {
    console.error('Load history failed:', err);
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
    window.location.href = '/driver.html';
  } catch (err) {
    console.error('Logout failed:', err);
    hideLoading();
    showToast({
      type: 'error',
      title: 'Logout Failed',
      message: 'Please try again'
    });
  }
}

// ============================
// INIT
// ============================
async function initDashboard() {
  try {
    showLoading('Loading dashboard...');

    await checkAuth();
    
    if (!driverData) {
      window.location.href = '/driver.html';
      return;
    }

    updateHeaderStatus(driverData.status || 'free');
    setupNavigation();
    listenToActiveOrders();
    await loadHistory();
    updateStats();

    $('logout-btn').addEventListener('click', handleLogout);

    const searchInput = $('history-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        if (window.filterHistory) {
          window.filterHistory(query);
        }
      });
    }

    hideLoading();

  } catch (err) {
    console.error('Init failed:', err);
    hideLoading();
    showToast({
      type: 'error',
      title: 'Failed to Load',
      message: 'Please refresh the page'
    });
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

// ============================
// START
// ============================
document.addEventListener('DOMContentLoaded', initDashboard);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !activeOrdersUnsub) {
    listenToActiveOrders();
  }
});
       