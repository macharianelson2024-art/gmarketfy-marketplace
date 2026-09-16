/**
 * pending.js
 * -----------------------------------------------------------------------
 * Renders the client's pending-orders tab.
 *
 * Per order card:
 *   - Status badge, progress bar, client info, vendor note, delivery info
 *   - "Track Driver" button (only when out-for-delivery + driverId present)
 *       · becomes "live" (pulsing dot) the moment the driver starts
 *         broadcasting to Realtime DB
 *       · click → opens the tracking modal
 *   - "Pay now" button (wired to payment-modal.js)
 *
 * The tracking modal mounts the same live-tracking preview used on the
 * client dashboard, at a much larger size, plus a header with driver info
 * and a Call button.
 * -----------------------------------------------------------------------
 */

import {
  db, collection, query, where, orderBy,
  getDoc, doc, auth, onSnapshot,
} from "./firebase-config.js";

import {
  getDatabase, ref, onValue,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

import { openPaymentModal } from "./payment-modal.js";
import { initLiveTrackingPreview } from "./live-tracking.js";

// =========================
// CONSTANTS
// =========================
const DELIVERY_STEPS = ["Confirmed", "Assigned", "Out for delivery", "Delivered", "Paid", "paid & delivered"];
const PICKUP_STEPS   = ["Confirmed", "Packaging", "Ready", "Paid"];

// Per-card RTDB listener for the "is driver broadcasting?" indicator
const cardRTDBListeners = new Map(); // orderId -> unsubscribe

// Modal runtime
let trackingModal = null; // { overlay, tracker, orderId }

// =========================
// HELPERS
// =========================
function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function getStepIndex(status, steps) {
  const idx = steps.findIndex(s => s.toLowerCase() === status?.toLowerCase());
  return idx === -1 ? 0 : idx;
}

function formatTimeAgo(date) {
  if (!date) return "";
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60)    return "Just now";
  if (seconds < 3600)  return `${Math.floor(seconds / 60)} mins ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hrs ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

function extractDestination(order) {
  const addr = order?.delivery?.address;
  if (!addr) return null;
  const candidates = [addr.addressDraft, addr];
  for (const c of candidates) {
    if (!c) continue;
    const lat = Number(c.lat);
    const lng = Number(c.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
      return { lat, lng };
    }
  }
  return null;
}

function canTrack(order) {
  const status = (order.status || "").toLowerCase();
  return (
    !!order.driverId &&
    status === "out for delivery" &&
    !!extractDestination(order)
  );
}

// =========================
// STATUS BADGE
// =========================
function buildStatusBadge(status, paymentStatus, isDelivery) {
  const map = {
    pending:            { classes: "bg-yellow-500/15 text-yellow-400",  icon: "⏳", label: "Pending" },
    confirmed:          { classes: "bg-blue-500/15 text-blue-400",      icon: "✅", label: "Confirmed" },
    packaging:          { classes: "bg-blue-500/15 text-blue-400",      icon: "📦", label: "Packaging" },
    assigned:           { classes: "bg-purple-500/15 text-purple-400",  icon: "🚴", label: "Assigned to driver" },
    "out for delivery": { classes: "bg-orange-500/15 text-orange-400",  icon: "🚚", label: "Out for delivery" },
    "proof uploaded":   { classes: "bg-pink-500/15 text-pink-400",      icon: "📸", label: "Proof uploaded" },
    delivered:          { classes: "bg-green-500/15 text-green-400",    icon: "✅", label: "Delivered" },
    ready:              { classes: "bg-indigo-500/15 text-indigo-400",  icon: "📍", label: "Ready for Pickup" },
    "picked up":        { classes: "bg-green-500/15 text-green-400",    icon: "✅", label: "Picked up" },
    paid:               { classes: "bg-green-500/15 text-green-400",    icon: "💚", label: "Paid" },
    "paid & delivered": { classes: "bg-green-500/15 text-green-400",    icon: "💚", label: "Paid & Delivered" },
  };

  const s  = { ...(map[status?.toLowerCase()] || map.pending) };
  const st = status?.toLowerCase();
  const isPaid = paymentStatus?.toLowerCase() === "paid";

  const terminalStatuses = isDelivery
    ? ["paid", "paid & delivered", "delivered"]
    : ["paid", "picked up"];
  const isTerminal = terminalStatuses.includes(st);

  if (isPaid && !isTerminal) {
    s.classes = "bg-green-500/15 text-green-400";
    s.icon = "💚";
    s.label = `Paid & ${s.label}`;
  } else if (!isPaid) {
    if (isDelivery) {
      if (st === "paid")       { s.icon = "💚"; s.label = "Paid (awaiting delivery)"; }
      if (st === "delivered")  { s.icon = "✅"; s.label = "Delivered (awaiting payment)"; }
      if (st === "confirmed")  { s.icon = "✅"; s.label = "Confirmed (awaiting payment)"; }
    } else {
      if (st === "confirmed")  { s.icon = "✅"; s.label = "Confirmed (payment done during pickup)"; }
      if (st === "packaging")  { s.icon = "📦"; s.label = "Packaging (payment done during pickup)"; }
    }
  }

  return `
    <span class="text-[11px] px-2.5 py-1 rounded-lg font-semibold flex items-center gap-1 whitespace-nowrap ${s.classes}">
      ${s.icon} ${s.label}
    </span>`;
}

// =========================
// PROGRESS BAR
// =========================
function buildProgressBar(status, paymentStatus, isDelivery) {
  const steps   = isDelivery ? DELIVERY_STEPS : PICKUP_STEPS;
  const current = getStepIndex(status, steps);
  const percent = Math.round((current / (steps.length - 1)) * 100);

  const colorMap = {
    confirmed:          "#6366f1",
    packaging:          "#6366f1",
    assigned:           "#a855f7",
    "out for delivery": "#f97316",
    delivered:          "#22c55e",
    ready:              "#a78bfa",
    "picked up":        "#22c55e",
    paid:               "#22c55e",
    "paid & delivered": "#22c55e",
  };

  const fillColor = colorMap[status?.toLowerCase()] || "#6366f1";

  const dotsHTML = steps.map((step, i) => {
    const isDone   = i < current;
    const isActive = i === current;
    const dotBg    = isDone   ? "#22c55e"
                   : isActive ? fillColor
                   : "rgba(255,255,255,0.1)";
    const lblColor  = isDone   ? "text-green-400"
                    : isActive ? "text-white"
                    : "text-white/20";
    const lblWeight = isActive ? "font-semibold" : "";

    return `
      <div class="flex flex-col items-center gap-1 flex-1">
        <div style="width:8px;height:8px;border-radius:50%;background:${dotBg};transition:background 0.3s;"></div>
        <span class="text-[10px] text-center ${lblColor} ${lblWeight}">${step}</span>
      </div>`;
  }).join("");

  return `
    <div class="flex items-center justify-between mb-1.5">
      <span class="text-[11px] text-white/30">Order progress</span>
      <span class="text-[11px] font-semibold" style="color:${fillColor};">${steps[current]}</span>
    </div>
    <div class="h-1 bg-white/5 rounded-full overflow-hidden mb-2">
      <div style="height:100%;width:${percent}%;background:${fillColor};border-radius:99px;transition:width 0.4s ease;"></div>
    </div>
    <div class="flex justify-between">
      ${dotsHTML}
    </div>`;
}

// =========================
// PAY BUTTON ELIGIBILITY
// =========================
function canClientPay(order) {
  const status        = order.status?.toLowerCase();
  const isDelivery    = order.delivery?.enabled;
  const paymentTiming = order.paymentTiming || "before";
  const paymentStatus = order.paymentStatus?.toLowerCase();

  if (paymentStatus === "paid") return false;

  if (!isDelivery) return status === "ready";

  if (paymentTiming === "before") {
    return ["confirmed", "assigned", "out for delivery", "delivered"].includes(status);
  }

  if (paymentTiming === "after") {
    return status === "delivered" || status === "paid & delivered" || status === "proof uploaded";
  }

  return false;
}

function buildPayButton(order) {
  const status    = order.status?.toLowerCase();
  const isPaidNow = order.paymentStatus?.toLowerCase() === "paid";
  const eligible  = canClientPay(order);
  const isPaid    = isPaidNow || status === "paid" || status === "paid & delivered";

  if (isPaid) {
    return `
      <div class="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-green-500/10 text-green-400 border border-green-500/15">
        💚 Paid
      </div>`;
  }

  if (!eligible) {
    const isDelivery    = order.delivery?.enabled;
    const paymentTiming = order.paymentTiming || "before";
    let hint = "";

    if (!isDelivery && status !== "ready") {
      hint = "Available when ready";
    } else if (isDelivery && paymentTiming === "after" && status !== "proof uploaded") {
      hint = "Available after delivery proof";
    } else {
      hint = "Waiting for vendor";
    }

    return `
      <div class="flex flex-col items-end gap-0.5">
        <div class="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-white/5 text-white/20 border border-white/5 cursor-not-allowed">
          🔒 Pay now
        </div>
        <span class="text-[10px] text-white/20">${escHtml(hint)}</span>
      </div>`;
  }

  return `
    <button
      class="pay-order-btn flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold border border-white/5 hover:opacity-90 transition animate-pulse"
      data-order-id="${escHtml(order.id)}"
      style="background:linear-gradient(135deg,#4ade80,#22c55e);color:#052e16;">
      💳 Pay now
    </button>`;
}

// =========================
// TRACK DRIVER BUTTON
// =========================
function buildTrackButton(order) {
  if (!canTrack(order)) return "";

  return `
    <div class="mx-3 mt-2 mb-1">
      <button
        type="button"
        class="track-driver-btn w-full flex items-center justify-between px-4 py-3 rounded-xl bg-gradient-to-r from-indigo-500/15 to-violet-500/15 border border-indigo-500/25 hover:border-indigo-500/50 transition group"
        data-track-order-id="${escHtml(order.id)}">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-9 h-9 rounded-full bg-indigo-500/25 flex items-center justify-center text-base shrink-0">
            🚚
          </div>
          <div class="text-left min-w-0">
            <p class="text-xs font-bold text-white truncate">Track driver live</p>
            <p class="text-[10px] text-white/40 truncate" data-track-status-text>Waiting for driver to start journey…</p>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="track-live-dot hidden w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]"></span>
          <svg class="w-4 h-4 text-white/40 group-hover:text-white/70 transition" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </div>
      </button>
    </div>
  `;
}

function attachTrackListener(order) {
  const btn = document.querySelector(`[data-track-order-id="${order.id}"]`);
  if (!btn) return;

  const statusText = btn.querySelector("[data-track-status-text]");
  const liveDot = btn.querySelector(".track-live-dot");

  const dbRT = getDatabase();
  const locRef = ref(dbRT, `driverLocations/${order.driverId}`);

  const unsub = onValue(locRef, (snap) => {
    const data = snap.val();
    const isLive = !!(
      data &&
      data.activeOrderId === order.id &&
      data.updatedAt &&
      Date.now() - data.updatedAt < 60000
    );

    if (isLive) {
      liveDot?.classList.remove("hidden");
      if (statusText) statusText.textContent = "Driver is on the road — tap to view";
    } else {
      liveDot?.classList.add("hidden");
      if (statusText) {
        const owned = data?.activeOrderId === order.id;
        statusText.textContent = owned
          ? "Signal lost — reconnecting…"
          : "Waiting for driver to start journey…";
      }
    }

    btn.dataset.live = isLive ? "1" : "0";
  });

  // Clean up any previous listener for this order
  if (cardRTDBListeners.has(order.id)) {
    try { cardRTDBListeners.get(order.id)(); } catch {}
  }
  cardRTDBListeners.set(order.id, unsub);
}

function detachAllTrackListeners() {
  for (const unsub of cardRTDBListeners.values()) {
    try { unsub(); } catch {}
  }
  cardRTDBListeners.clear();
}

// =========================
// TIME AGO
// =========================
function formatTimeAgoShort(date) {
  return formatTimeAgo(date);
}

// =========================
// RENDER — MAIN
// =========================
function renderPendingOrders(orders) {
  const list  = document.getElementById("pending-list");
  const empty = document.getElementById("pending-empty");

  // Tear down old per-card RTDB listeners before we rebuild the DOM
  detachAllTrackListeners();

  list.innerHTML = "";

  if (!orders || orders.length === 0) {
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  orders.forEach(order => {
    const card = buildOrderCard(order);
    list.appendChild(card);
  });

  // After cards are in the DOM, wire RTDB listeners for the track buttons
  orders.forEach(order => {
    if (canTrack(order)) attachTrackListener(order);
  });
}

// =========================
// BUILD ORDER CARD
// =========================
function buildOrderCard(order) {
  const isDelivery    = order.delivery?.enabled;
  const status        = order.status || "pending";
  const placedOn      = order.placedOn?.toDate?.() || order.createdAt?.toDate?.() || null;
  const timeAgo       = formatTimeAgoShort(placedOn);
  const address       = order.delivery?.address;
  const vendorNote    = order.vendorNote || null;
  const showProgress  = status !== "pending";
  const paymentStatus = order.paymentStatus;
  const eligible      = canClientPay(order);

  const deliveryInfoHTML = typeof window.getRelevantDeliveryInfo === "function"
    ? window.getRelevantDeliveryInfo(order, order.id)
    : "";

  const card = document.createElement("div");
  card.className = "w-full max-w-md bg-[#1a1a1a] rounded-2xl shadow-md overflow-hidden flex flex-col";

  card.innerHTML = `
    <img
      src="${escHtml(order.image || "")}"
      alt="${escHtml(order.name || "")}"
      class="w-full h-[160px] object-cover bg-white/5 border border-white/5"
      onerror="this.style.opacity='0.2'" />

    <!-- NAME + BADGE -->
    <div class="flex items-start justify-between gap-2 pt-3 px-3">
      <div class="min-w-0">
        <p class="text-sm font-semibold text-white truncate">${escHtml(order.name || "Order")}</p>
        <p class="text-xs text-white/35 mt-0.5">🏪 ${escHtml(order.vendorName || "Vendor")} &nbsp;·&nbsp; x${escHtml(order.quantity)}</p>
      </div>
      ${buildStatusBadge(status, paymentStatus, isDelivery)}
    </div>

    <!-- ORDER META -->
    <div class="flex items-center justify-between px-3 mt-1.5">
      <span class="text-xs text-white/25">Order #${escHtml((order.id || "").slice(-5).toUpperCase())}</span>
      <span class="text-xs text-white/25">${escHtml(timeAgo)}</span>
    </div>

    <!-- PROGRESS BAR -->
    <div class="px-3 mt-3 mb-1">
      ${showProgress
        ? buildProgressBar(status, paymentStatus, isDelivery)
        : `<p class="text-xs text-white/25 italic pb-1">Waiting for vendor to confirm...</p>`}
    </div>

    <div class="mx-3 my-2 h-px bg-white/5"></div>

    <!-- VENDOR NOTE -->
    <div class="px-3 pb-2">
      <p class="text-[10px] uppercase tracking-widest text-white/25 mb-1.5">Vendor note</p>
      <div class="bg-white/5 rounded-xl px-3 py-2 border-l-2 border-white/10 text-xs ${vendorNote ? 'text-white/60' : 'text-white/20 italic'}">
        ${escHtml(vendorNote || "No note from vendor yet...")}
      </div>
    </div>

    ${isDelivery && address ? `
      <div class="mx-3 my-1 h-px bg-white/5"></div>
      <div class="px-3 pb-2">
        <p class="text-[10px] uppercase tracking-widest text-white/25 mb-1.5">📦 Delivering to</p>
        <p class="text-xs text-white/50">${escHtml(address.clientName)} &nbsp;·&nbsp; ${escHtml(address.phoneNumber)}</p>
        <p class="text-xs text-white/30 mt-0.5">${escHtml(address.streetAddress || "")}, ${escHtml(address.Apartment || "")}, ${escHtml(address.HouseNo || "")}, ${escHtml(address.city || "")}</p>
      </div>
    ` : ""}

    ${deliveryInfoHTML}

    <!-- TRACK DRIVER BUTTON (only when out-for-delivery + driverId) -->
    ${buildTrackButton(order)}

    <div class="mx-3 mt-1 h-px bg-white/5"></div>

    <!-- TOTAL + PAY -->
    <div class="flex items-center justify-between px-3 py-3 mt-auto">
      <div>
        <p class="text-xs text-white/35 mb-0.5">Total</p>
        <p class="text-base font-bold ${eligible ? 'text-green-400' : 'text-indigo-400'}">
          KSh ${Number(order.subtotal || 0).toLocaleString()}
        </p>
      </div>
      ${buildPayButton(order)}
    </div>
  `;

  const payBtn = card.querySelector(".pay-order-btn");
  if (payBtn) payBtn.addEventListener("click", () => openPaymentModal(order));

  const trackBtn = card.querySelector(".track-driver-btn");
  if (trackBtn) trackBtn.addEventListener("click", () => openTrackingModal(order));

  return card;
}

// =========================
// TRACKING MODAL
// =========================
async function fetchDriverInfo(driverId) {
  try {
    const snap = await getDoc(doc(db, "drivers", driverId));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      name: d.name || "Your driver",
      phone: d.phone || "",
      vehicle: d.vehicleType || "",
    };
  } catch (err) {
    console.warn("driver info fetch failed:", err);
    return null;
  }
}

function vehicleLabel(v) {
  const map = {
    motorbike: "Motorbike",
    bicycle: "Bicycle",
    car: "Car",
    van: "Van",
    foot: "On foot",
  };
  return map[v] || "";
}

async function openTrackingModal(order) {
  if (trackingModal) closeTrackingModal();

  const destination = extractDestination(order);
  if (!destination) {
    window.showNotif?.({ type: "error", title: "Location unavailable", message: "This order has no saved destination." });
    return;
  }

  // Build modal shell
  const overlay = document.createElement("div");
  overlay.id = "tracking-modal-overlay";
  overlay.className =
    "fixed inset-0 z-[85] bg-black/70 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 " +
    "opacity-0 transition-opacity duration-300";

  overlay.innerHTML = `
    <div id="tracking-modal-panel"
      class="w-full max-w-lg bg-[#0f1115] border border-white/5 rounded-3xl overflow-hidden shadow-2xl
             scale-95 transition-transform duration-300 max-h-[92vh] flex flex-col">

      <!-- Header -->
      <div class="flex items-center justify-between px-5 py-4 border-b border-white/5 shrink-0">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-10 h-10 rounded-full bg-indigo-500/15 flex items-center justify-center text-lg shrink-0">🚚</div>
          <div class="min-w-0">
            <h3 class="text-base font-bold text-white truncate">Track Your Delivery</h3>
            <p class="text-xs text-white/40 truncate" id="tracking-modal-driver">Loading driver…</p>
          </div>
        </div>
        <button id="tracking-modal-close"
          class="w-9 h-9 rounded-full bg-white/5 flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition shrink-0">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <!-- Map (flex-fill) -->
      <div class="flex-1 min-h-[420px] relative bg-[#14161c]" id="tracking-modal-map-slot"></div>

      <!-- Footer -->
      <div class="px-5 py-4 border-t border-white/5 shrink-0 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="text-[10px] uppercase tracking-widest text-white/30">Order</p>
          <p class="text-sm font-semibold text-white truncate">${escHtml(order.name || "Your order")}</p>
          <p class="text-[11px] text-white/40 mt-0.5">#${escHtml((order.id || "").slice(-8).toUpperCase())}</p>
        </div>
        <button id="tracking-modal-call"
          class="hidden px-4 py-2.5 rounded-xl bg-emerald-500/15 text-emerald-400 text-sm font-semibold hover:bg-emerald-500/25 transition items-center gap-2 shrink-0">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
          </svg>
          Call
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  requestAnimationFrame(() => {
    overlay.classList.remove("opacity-0");
    overlay.querySelector("#tracking-modal-panel").classList.remove("scale-95");
  });

  trackingModal = { overlay, tracker: null, orderId: order.id };

  // Wire close
  const closeBtn = overlay.querySelector("#tracking-modal-close");
  closeBtn.addEventListener("click", closeTrackingModal);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeTrackingModal();
  });

  const escHandler = (e) => {
    if (e.key === "Escape") closeTrackingModal();
  };
  document.addEventListener("keydown", escHandler);
  trackingModal.escHandler = escHandler;

  // Mount the live tracking map (big)
  const slot = overlay.querySelector("#tracking-modal-map-slot");
  try {
    const tracker = await initLiveTrackingPreview(slot, {
      driverId: order.driverId,
      orderId: order.id,
      destination,
      height: slot.clientHeight || 420,
    });
    if (trackingModal && trackingModal.orderId === order.id) {
      trackingModal.tracker = tracker;
    } else {
      tracker.destroy(); // modal was closed during init
    }
  } catch (err) {
    console.warn("tracking map mount failed:", err);
  }

  // Fetch + render driver info
  const driver = await fetchDriverInfo(order.driverId);
  if (!trackingModal || trackingModal.orderId !== order.id) return;

  const driverEl = overlay.querySelector("#tracking-modal-driver");
  const callBtn = overlay.querySelector("#tracking-modal-call");

  if (driver) {
    const v = vehicleLabel(driver.vehicle);
    driverEl.textContent = v ? `${driver.name} · ${v}` : driver.name;

    if (driver.phone) {
      callBtn.classList.remove("hidden");
      callBtn.classList.add("flex");
      callBtn.addEventListener("click", () => {
        window.location.href = `tel:${driver.phone}`;
      });
    }
  } else {
    driverEl.textContent = "Your driver";
  }
}

function closeTrackingModal() {
  if (!trackingModal) return;
  const { overlay, tracker, escHandler } = trackingModal;

  try { tracker?.destroy(); } catch (err) { console.warn("tracker destroy failed:", err); }
  if (escHandler) document.removeEventListener("keydown", escHandler);

  overlay.classList.add("opacity-0");
  overlay.querySelector("#tracking-modal-panel").classList.add("scale-95");
  document.body.style.overflow = "";

  setTimeout(() => overlay.remove(), 300);
  trackingModal = null;
}

// =========================
// ENRICH (product image + vendor name + live delivery flag)
// =========================
async function enrichOrder(data) {
  try {
    const [productSnap, vendorSnap] = await Promise.all([
      getDoc(doc(db, "products", data.product_id)),
      getDoc(doc(db, "vendors",  data.vendor_id)),
    ]);

    data.image      = productSnap.exists() ? productSnap.data().image    : "";
    data.vendorName = vendorSnap.exists()  ? vendorSnap.data().storeName : "Unknown Vendor";

    const vendorDelivery = vendorSnap.exists() ? vendorSnap.data().delivery : null;
    data.delivery = {
      ...data.delivery,
      enabled: data.delivery?.enabled ?? (vendorDelivery?.enabled || false),
    };
  } catch (e) {
    data.image      = "";
    data.vendorName = "Unknown Vendor";
    console.warn("Failed to enrich order:", data.id, e);
  }
  return data;
}

// =========================
// LOAD PENDING TAB
// =========================
async function loadPendingTab() {
  const list  = document.getElementById("pending-list");
  const empty = document.getElementById("pending-empty");

  list.innerHTML = `
    <div class="col-span-full flex justify-center py-12">
      <div class="w-8 h-8 border-2 border-white/10 border-t-indigo-500 rounded-full animate-spin"></div>
    </div>`;
  empty.classList.add("hidden");

  if (!auth.currentUser) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  try {
    const uid = auth.currentUser.uid;

    const q = query(
      collection(db, "orders"),
      where("clientId", "==", uid),
      where("status", "not-in", ["picked up", "cancelled", "paid & delivered"]),
      orderBy("status"),
      orderBy("createdAt", "desc")
    );

    if (window._pendingOrdersUnsub) window._pendingOrdersUnsub();

    window._pendingOrdersUnsub = onSnapshot(
      q,
      async (snap) => {
        if (snap.empty) {
          list.innerHTML = "";
          empty.classList.remove("hidden");
          detachAllTrackListeners();
          return;
        }

        empty.classList.add("hidden");

        const orders = await Promise.all(
          snap.docs.map((d) => enrichOrder({ id: d.id, ...d.data() }))
        );

        renderPendingOrders(orders);
      },
      (e) => {
        console.warn("onSnapshot failed:", e);
        list.innerHTML = "";
        empty.classList.remove("hidden");
        window.showNotif?.({
          type: "error",
          title: "Failed to load",
          message: "Could not load your pending orders.",
        });
      }
    );
  } catch (e) {
    console.warn("loadPendingTab failed:", e);
    list.innerHTML = "";
    empty.classList.remove("hidden");
    window.showNotif?.({
      type: "error",
      title: "Failed to load",
      message: "Could not load your pending orders.",
    });
  }
}

window.loadPendingTab = loadPendingTab;

// Cleanup on unload
window.addEventListener("beforeunload", () => {
  detachAllTrackListeners();
  if (trackingModal) {
    try { trackingModal.tracker?.destroy(); } catch {}
  }
});