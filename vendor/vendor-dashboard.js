// ============================================
// VENDOR DASHBOARD — WITH OVERVIEW TAB (OPTIMISED)
// ============================================

import {
  db, collection, query, where, orderBy,
  getDocs, getDoc, doc,
  auth, onAuthStateChanged, serverTimestamp ,signOut,
  onSnapshot , updateDoc
} from './firebase-config.js';

import {isTimestampGreater} from '../universalScript.js';
import {initVault} from './vendor-vault.js'



// =========================
// CACHE LAYER
// =========================
const _docCache = new Map();

async function cachedGet(colName, id) {
  if (!id) return null;
  const key = `${colName}/${id}`;
  if (_docCache.has(key)) return _docCache.get(key);
  try {
    const snap = await getDoc(doc(db, colName, id));
    const data = snap.exists() ? snap.data() : null;
    if (data) _docCache.set(key, data);
    return data;
  } catch {
    return null;
  }
}

// =========================
// STATE
// =========================
let currentVendorId = null;
let currentVendorData = null;

// =========================
// AUTH GATE
// =========================
onAuthStateChanged(auth, async (user) => {
//  signOut(auth); // Force sign out for now, as per your request
  if (!user) {
     window.showDialog({
  type:    "warn",
  emoji:   "✖️",
  tag:     "No Account",
  title:   "You're not logged in",
  message: "you are not currently logged in. you will need a vendor account.",
  actions: [
    {
      label: "Create Vendor Account",
      style: "primary",
      onClick: () => {
         window.showLoadingDots("Reidirecting to create account...");
         localStorage.setItem('vendorOnboarding' , 'true');
         setTimeout(()=>{
         window.location.href = '/vendor/authentication/authentication.html';
          },500)
      }
    },
    {
      label: "Log in with an existing account",
      style: "secondary",
      onClick: () => {
          window.showLoadingDots("Reidirecting for authentication...");
          setTimeout(()=>{
            window.location.href = '/vendor/authentication/authentication.html';
            },500)
      }
    },
    {
      label: "Cancel",
      style: "danger",
      onClick: () => {} // just closes
    }
  ]
})
    return;
  }

  const vendorData = await cachedGet("vendors", user.uid);
  if (!vendorData) {
       window.showDialog({
  type:    "warn",
  emoji:   "✖️",
  tag:     "No Account",
  title:   "You're not logged in",
  message: "you are not currently logged in. you will need a vendor account.",
  actions: [
    {
      label: "Create Vendor Account",
      style: "primary",
      onClick: () => {
         window.showLoadingDots("Reidirecting to create account...");
         localStorage.setItem('vendorOnboarding' , 'true');
         setTimeout(()=>{
         window.location.href = '/vendor/authentication/authentication.html';
          },500)
      }
    },
    {
      label: "Log in with an existing account",
      style: "secondary",
      onClick: () => {
          window.showLoadingDots("Reidirecting for authentication...");
          setTimeout(()=>{
            window.location.href = '/vendor/authentication/authentication.html';
            },500)
      }
    },
    {
      label: "Cancel",
      style: "danger",
      onClick: () => {} // just closes
    }
  ]
})
    return;
  }

  currentVendorId = user.uid;
  window.vendorId = currentVendorId;
  console.log("found it : " , currentVendorId);
  
  currentVendorData = vendorData;
  startListeningToNotifications();
  initTabs();
  loadOverviewTab();
});

// =========================
// TAB NAVIGATION
// =========================
function initTabs() {
  const nav = document.getElementById("nav-bar");
  const slider = document.getElementById("slider");
  const navBtns = document.querySelectorAll("#nav-bar .nav-btn");
  const tabs = document.querySelectorAll("#tabs-wrapper .tab");
  const mobileTrigger = document.getElementById("mobile-menu-trigger");
  const mobileOverlay = document.getElementById("mobile-nav-overlay");
  const mobilePanel = document.getElementById("mobile-nav-panel");
  const mobileBtns = document.querySelectorAll(".mobile-nav-btn");
  const menuIcon = document.getElementById("menu-icon");
  const vaultContainer = document.getElementById('vault-tab-root');


  if (!nav || !slider || !navBtns.length) return;

  let activeIndex = 0;
  const BREAKPOINT = 768;

  const isMobile = () => window.innerWidth < BREAKPOINT;

  function applyResponsive() {
    if (isMobile()) {
      nav.style.display = "none";
      if (mobileTrigger) mobileTrigger.style.display = "flex";
    } else {
      nav.style.display = "flex";
      if (mobileTrigger) mobileTrigger.style.display = "none";
      if (mobileOverlay && !mobileOverlay.classList.contains("hidden")) closeMobileNav();
      moveSlider(navBtns[activeIndex]);
    }
  }

  function moveSlider(btn) {
    if (!btn) return;
    const btnRect = btn.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    slider.style.width = `${btnRect.width}px`;
    slider.style.height = `${btnRect.height}px`;
    slider.style.transform = `translate(${btnRect.left - navRect.left}px, ${btnRect.top - navRect.top}px)`;
  }

  function switchTab(index) {
    activeIndex = index;
    navBtns.forEach((btn, i) => {
      const isActive = i === index;
      btn.classList.toggle("text-white", isActive);
      btn.classList.toggle("text-white/50", !isActive);
      if (isActive && !isMobile()) moveSlider(btn);
    });
    tabs.forEach((tab, i) => tab.classList.toggle("active", i === index));

    // Lazy-load tab content
    const loaders = [
      loadOverviewTab,
      () => window.loadProductsTab?.(),
      () => window.loadOrdersTab?.(),
      () => window.loadDriversTab?.(),
      () => window.loadAnalyticsTab?.(),
      () => window.loadSettingsTab?.(),
      () => initVault(vaultContainer)
    ];
    loaders[index]?.();
  }

  navBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const index = parseInt(btn.getAttribute("data-tab"));
      if (!isNaN(index)) switchTab(index);
    });
  });

  function openMobileNav() {
    if (!mobileOverlay || !mobilePanel) return;
    mobileOverlay.classList.remove("hidden");
    void mobileOverlay.offsetWidth;
    mobileOverlay.style.opacity = "1";
    mobilePanel.style.transform = "translateY(0)";
    if (menuIcon) menuIcon.innerHTML = `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`;
    document.body.style.overflow = "hidden";
  }

  function closeMobileNav() {
    if (!mobileOverlay || !mobilePanel) return;
    mobileOverlay.style.opacity = "0";
    mobilePanel.style.transform = "translateY(100%)";
    if (menuIcon) menuIcon.innerHTML = `<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>`;
    document.body.style.overflow = "";
    setTimeout(() => mobileOverlay.classList.add("hidden"), 400);
  }

  mobileTrigger?.addEventListener("click", openMobileNav);
  mobileOverlay?.addEventListener("click", (e) => { if (e.target === mobileOverlay) closeMobileNav(); });
  mobileBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const index = parseInt(btn.getAttribute("data-tab"));
      if (!isNaN(index)) { closeMobileNav(); switchTab(index); }
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !mobileOverlay?.classList.contains("hidden")) closeMobileNav();
  });

  applyResponsive();
  switchTab(0);

  const positionActive = () => { if (!isMobile()) moveSlider(navBtns[activeIndex]); };
  document.fonts?.ready.then(positionActive);
  setTimeout(positionActive, 100);
  setTimeout(positionActive, 300);

  let resizeTimeout;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => { applyResponsive(); positionActive(); }, 100);
  });

  if (window.ResizeObserver) {
    new ResizeObserver(() => { if (!isMobile()) positionActive(); }).observe(nav);
  }
}


// =========================
// OVERVIEW TAB
// =========================
async function loadOverviewTab() {
  if (!currentVendorId) return;
  const vendorId = currentVendorId;

  try {
    // Fire ALL top-level queries simultaneously
    const [productsSnap, historySnap, pendingSnap] = await Promise.all([
      getDocs(query(collection(db, "products"), where("vendor_id", "==", vendorId))),
      getDocs(query(collection(db, "orderingHistory"), where("vendor_id", "==", vendorId), orderBy("completedAt", "desc"))),
      getDocs(query(collection(db, "orders"), where("vendor_id", "==", vendorId), where("status", "not-in", ["delivered", "picked up", "cancelled", "paid" ,"paid & delivered"])))
    ]);

    // ---- Counts & revenue ----
    const totalProducts = productsSnap.size;
    const pendingCount = pendingSnap.size;

    const completedOrders = historySnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const totalOrders = completedOrders.length;
    const totalRevenue = completedOrders.reduce((sum, o) => sum + (o.subtotal || 0), 0);

    // Animate all counters at once
    animateCount("ov-products", totalProducts);
    animateCount("ov-orders", totalOrders);
    animateCount("ov-revenue", totalRevenue, true);
    animateCount("ov-pending", pendingCount);

    // ---- Recent orders — enrich top 5 in parallel, using cache ----
    const recentRaw = completedOrders.slice(0, 5);

    const recentOrders = await Promise.all(
      recentRaw.map(async (order) => {
        const [productData, clientData] = await Promise.all([
          cachedGet("products", order.product_id),
          cachedGet("clients", order.clientId)
        ]);
        return {
          ...order,
          image: productData?.image || "",
          productName: productData?.name || order.name || "Product",
          clientName: clientData?.username || clientData?.first_name || "Customer"
        };
      })
    );

    renderRecentOrders(recentOrders);

  } catch (error) {
    console.error("Overview load failed:", error);
    const el = document.getElementById("ov-recent-orders");
    if (el) el.innerHTML = `<p class="text-sm text-red-400 text-center py-6">Failed to load overview data.</p>`;
  }
}

// =========================
// ANIMATE COUNT
// =========================
function animateCount(elementId, targetValue, isCurrency = false) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const duration = 800;
  const startTime = performance.now();

  function tick(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    const current = Math.round(targetValue * eased);
    el.textContent = isCurrency ? `KSh ${current.toLocaleString()}` : current.toLocaleString();
    if (progress < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

// =========================
// RENDER RECENT ORDERS
// =========================
function renderRecentOrders(orders) {
  const container = document.getElementById("ov-recent-orders");
  if (!container) return;

  if (!orders?.length) {
    container.innerHTML = `
      <div class="text-center py-8">
        <span class="text-3xl block mb-3">📋</span>
        <p class="text-sm text-white/30">No completed orders yet.</p>
        <p class="text-xs text-white/20 mt-1">Orders will appear here once customers complete purchases.</p>
      </div>`;
    return;
  }

  // Build as a fragment — single DOM write
  const fragment = document.createDocumentFragment();
  orders.forEach(order => {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between py-3 px-1 border-b border-white/5 last:border-0 gap-3 hover:bg-white/[0.02] rounded-lg transition-colors";
    row.innerHTML = `
      <div class="w-10 h-10 rounded-lg bg-white/5 overflow-hidden shrink-0 border border-white/5">
        ${order.image
          ? `<img src="${order.image}" alt="" class="w-full h-full object-cover" onerror="this.style.display='none'" />`
          : `<div class="w-full h-full flex items-center justify-center text-white/20 text-lg">📦</div>`
        }
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm text-white font-medium truncate">${escHTML(order.productName)}</p>
        <div class="flex items-center gap-2 text-xs text-white/30 mt-0.5">
          <span>👤 ${escHTML(order.clientName)}</span>
          <span>·</span>
          <span>x${order.quantity || 1}</span>
          <span>·</span>
          <span>${formatTimeAgo(order.completedAt?.toDate?.() || new Date())}</span>
        </div>
      </div>
      <div class="text-right shrink-0">
        <p class="text-sm font-semibold text-emerald-400">KSh ${(order.subtotal || 0).toLocaleString()}</p>
        <p class="text-[10px] text-white/20 mt-0.5">#${(order.id || '').slice(-6).toUpperCase()}</p>
      </div>`;
    fragment.appendChild(row);
  });

  container.innerHTML = "";
  container.appendChild(fragment);
}

// =========================
// HELPERS
// =========================
function escHTML(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(date).toLocaleDateString();
}

// Expose globals used by other tab scripts
window.escHTML = escHTML;

window.openModal = function (id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.classList.remove("hidden");
  void overlay.offsetWidth;
  overlay.style.opacity = "1";
  overlay.querySelector("div")?.classList.remove("scale-95");
};

window.closeModal = function (id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.style.opacity = "0";
  overlay.querySelector("div")?.classList.add("scale-95");
  setTimeout(() => overlay.classList.add("hidden"), 300);
};


const vendorNotificationsRef = doc(db, "GmarketfyNotifications", "VendorNotifications");


 function startListeningToNotifications() {
onSnapshot(vendorNotificationsRef, (snap) => {
  if (!snap.exists()) return;
  let notificationInfo = snap.data();
  let lastNotifVendorsawTime = currentVendorData.lastUpdateSeenTime;




let latestNotificationTime = notificationInfo.updatedAt;

console.log(lastNotifVendorsawTime , latestNotificationTime);


let showNotification = isTimestampGreater(latestNotificationTime, lastNotifVendorsawTime);
  
if (showNotification) {
  window.showDialog({
    type: "info",
    emoji: "🔔",
    tag: "New Notification",
    title: "You have a new notification!",
    message: notificationInfo.message || "Check your notifications for details.",
    actions: [
      {
        label: "Okay",
        style: "primary",
        onClick: async () => {
         await updateDoc(doc(db, "vendors", currentVendorId), {
          lastUpdateSeenTime: serverTimestamp()
        })} 
      }
    ]
  });
}  
});
}