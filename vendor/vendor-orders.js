// ============================================
// VENDOR DASHBOARD — ORDERS TAB (OPTIMISED)
// ============================================

import {
  db, collection, query, where, orderBy,
  getDocs, getDoc, doc, updateDoc,
  serverTimestamp, onSnapshot, setDoc ,  arrayUnion, arrayRemove
} from './firebase-config.js';

import { initDispatchPanel, destroyDispatchPanel } from './dispatch.js';


// =========================
// STATE
// =========================
let allOrders = [];
let activeFilter = "all";
let selectedDriverId = null;
let selectedOrderIds = new Set();
let currentAssignOrderId = null;
let currentNoteOrderId = null;
let currentProofOrderId = null;
let ordersUnsub = null;
let loadingOrderIds = new Set();

// =========================
// STATUS CONFIG
// =========================
const STATUS_FLOW = {
  pending: {
    label: "Pending", icon: "⏳", color: "bg-yellow-500/15 text-yellow-400",
    next: "confirmed", nextLabel: "Confirm Order", nextIcon: "✅"
  },
  confirmed: {
    label: "Confirmed", icon: "✅", color: "bg-blue-500/15 text-blue-400",
    next: null, nextLabel: null, nextIcon: null
  },
  // Payment-before-delivery orders land here after client pays
  paid: {
    label: "Paid", icon: "💚", color: "bg-emerald-500/15 text-emerald-400",
    next: "assigned", nextLabel: "Assign Driver", nextIcon: "🚴"
  },
  assigned: {
    label: "Assigned", icon: "🚴", color: "bg-purple-500/15 text-purple-400",
    next: "out for delivery", nextLabel: "Out for Delivery", nextIcon: "🚚"
  },
  "out for delivery": {
    label: "Out for Delivery", icon: "🚚", color: "bg-orange-500/15 text-orange-400",
    next: "proof uploaded", nextLabel: "Upload Proof", nextIcon: "📸"
  },
  "proof uploaded": {
    label: "Proof Uploaded", icon: "📸", color: "bg-pink-500/15 text-pink-400",
    next: null, nextLabel: null, nextIcon: null
  },
  packaging: {
    label: "Packaging", icon: "📦", color: "bg-blue-500/15 text-blue-400",
    next: "ready", nextLabel: "Mark as Ready", nextIcon: "📍"
  },
  ready: {
    label: "Ready for Pickup", icon: "📍", color: "bg-indigo-500/15 text-indigo-400",
    next: null, nextLabel: null, nextIcon: null
  },
  delivered: {
    label: "Delivered", icon: "✅", color: "bg-green-500/15 text-green-400",
    next: null, nextLabel: null, nextIcon: null
  },
  "picked up": {
    label: "Picked Up", icon: "✅", color: "bg-green-500/15 text-green-400",
    next: null, nextLabel: null, nextIcon: null
  },
  // Terminal status for payment-before-delivery orders after proof upload
  "paid & delivered": {
    label: "Paid & Delivered", icon: "💚", color: "bg-green-500/15 text-green-400",
    next: null, nextLabel: null, nextIcon: null
  },
  cancelled: {
    label: "Cancelled", icon: "❌", color: "bg-red-500/15 text-red-400",
    next: null, nextLabel: null, nextIcon: null
  }
};

// "paid" is NOT terminal — it still needs driver assignment + delivery
const TERMINAL_STATUSES = new Set(["delivered", "picked up", "cancelled", "paid & delivered"]);

// Helper: is this a payment-before-delivery order?
function isPayBeforeDelivery(order) {
  return order?.delivery?.enabled && order?.paymentTiming === "before";
}

// Helper: is this order eligible for the bulk selector (delivery, no driver, awaiting assignment)?
function isUnassignedDelivery(order) {
  return (
    order.delivery?.enabled &&
    !order.driverId &&
    order.status === "confirmed" &&
    (!isPayBeforeDelivery(order) || isPaid(order))   // 👈 gate pay-before orders on real payment
  );
}

// =========================
// DRIVER ↔ CLIENT VISIBILITY
// =========================
// Only remove a client from a driver's assignedClientIds if they have
// no OTHER active order with that same driver — otherwise we'd cut
// their read access while a second delivery is still in progress.
async function maybeRemoveClientFromDriver(driverId, clientId) {
  if (!driverId || !clientId) return;
  try {
    const stillActive = await getDocs(query(
      collection(db, "orders"),
      where("driverId", "==", driverId),
      where("clientId", "==", clientId),
      where("status", "not-in", ["delivered", "paid & delivered", "picked up", "cancelled"])
    ));
    if (stillActive.empty) {
      await updateDoc(doc(db, "drivers", driverId), {
        assignedClientIds: arrayRemove(clientId)
      });
    }
  } catch (e) {
    console.warn("maybeRemoveClientFromDriver failed:", e);
  }
}

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
// LOCAL HELPERS
// =========================
function escHTML(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// Source of truth for "has this order been paid" — separate from delivery status.
// Falls back to legacy status values for orders created before paymentStatus existed.
function isPaid(order) {
  return order?.paymentStatus === "paid"
    || (!("paymentStatus" in (order || {})) && (order?.status === "paid" || order?.status === "paid & delivered" || order?.status === "picked up"));
}

function openModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.classList.remove("hidden");
  void overlay.offsetWidth;
  overlay.style.opacity = "1";
  overlay.querySelector("[data-modal-panel]")?.classList.remove("scale-95", "translate-y-4");
}

function closeModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.style.opacity = "0";
  overlay.querySelector("[data-modal-panel]")?.classList.add("scale-95", "translate-y-4");
  setTimeout(() => overlay.classList.add("hidden"), 300);
}

function timeAgo(date) {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(date).toLocaleDateString();
}


// =========================
// INJECT SELECTOR STYLES
// =========================
function injectSelectorStyles() {
  if (document.getElementById("custom-selector-styles")) return;

  const style = document.createElement("style");
  style.id = "custom-selector-styles";
  style.innerHTML = `
    @keyframes wildPulsing {
      0%   { transform: scale(0.7); opacity: 0.5; }
      50%  { transform: scale(1);   opacity: 1;   }
      100% { transform: scale(0.7); opacity: 0.5; }
    }
    @keyframes checkMarkPop {
      0%   { transform: scale(0) rotate(-90deg); opacity: 0; }
      50%  { transform: scale(1.3) rotate(10deg); }
      100% { transform: scale(1) rotate(0deg);   opacity: 1; }
    }
    @keyframes scaleIn {
      from { opacity: 0; transform: scale(0.9); }
      to   { opacity: 1; transform: scale(1);   }
    }

    .unassigned-selector {
      position: relative;
      width: 36px; height: 36px;
      border-radius: 8px;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      border: 3px solid rgba(99, 102, 241, 0.8);
      background: rgba(99, 102, 241, 0.15);
      animation: wildPulsing 2s ease-in-out infinite;
      box-shadow: 0 0 15px rgba(99, 102, 241, 0.4);
    }
    .unassigned-selector:hover {
      transform: scale(1.09);
      border-color: rgba(99, 102, 241, 1);
      background: rgba(99, 102, 241, 0.3);
      box-shadow: 0 0 25px rgba(99, 102, 241, 0.8);
    }
    .unassigned-selector.selected {
      border-color: #c7d2fe;
      background: linear-gradient(135deg, #6366f1 0%, #818cf8 50%, #a5b4fc 100%);
    }
    .unassigned-selector.selected svg {
      animation: checkMarkPop 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
      filter: drop-shadow(0 0 8px rgba(255,255,255,1)) drop-shadow(0 0 12px rgba(99,102,241,0.9));
    }
    .unassigned-selector svg {
      width: 18px; height: 18px;
      color: white; stroke-width: 3.5;
      filter: drop-shadow(0 0 2px rgba(99, 102, 241, 0.5));
    }
    .unassigned-selector::before {
      content: '';
      position: absolute; inset: -8px;
      border-radius: 10px;
      background: radial-gradient(circle, rgba(99,102,241,0.5) 0%, transparent 70%);
      opacity: 0;
      transition: opacity 0.3s ease;
      pointer-events: none; z-index: -1;
    }
    .unassigned-selector:hover::before { opacity: 1; }
    .unassigned-selector.selected::before {
      background: radial-gradient(circle, rgba(99,102,241,1) 0%, rgba(99,102,241,0.6) 30%, transparent 70%);
      opacity: 1;
    }
  `;
  document.head.appendChild(style);
}


// =========================
// INJECT MODALS
// =========================
function injectModals() {
  if (document.getElementById("vendor-note-overlay")) return;

  document.body.insertAdjacentHTML("beforeend", `
    <!-- VENDOR NOTE MODAL -->
    <div id="vendor-note-overlay"
      class="fixed inset-0 z-[80] bg-black/70 backdrop-blur-md hidden opacity-0 transition-opacity duration-300 flex items-end sm:items-center justify-center p-4">
      <div data-modal-panel
        class="w-full max-w-md bg-[#0f1115] border border-white/8 rounded-[1.75rem] p-6 scale-95 translate-y-4 transition-all duration-300 shadow-2xl">
        <div class="w-10 h-1 bg-white/10 rounded-full mx-auto mb-5 sm:hidden"></div>
        <div class="flex items-start justify-between mb-5">
          <div>
            <div class="flex items-center gap-2 mb-1">
              <span class="text-base">📝</span>
              <h3 class="text-base font-bold text-white tracking-tight">Vendor Note</h3>
            </div>
            <p class="text-xs text-white/35" id="note-modal-order-label">Order note</p>
          </div>
          <button id="close-note-modal"
            class="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition text-sm">✕</button>
        </div>
        <div class="relative mb-5">
          <textarea id="note-modal-textarea" rows="4" maxlength="300"
            placeholder="Add a note for this order… e.g. handle with care, call before delivery…"
            class="w-full bg-white/[0.03] border border-white/8 focus:border-indigo-500/50 rounded-2xl px-4 py-3.5 text-sm text-white placeholder-white/20 outline-none resize-none transition-colors duration-200 leading-relaxed"></textarea>
          <span id="note-char-count" class="absolute bottom-3 right-3 text-[10px] text-white/20">0 / 300</span>
        </div>
        <div class="flex flex-wrap gap-2 mb-5">
          <button class="note-chip text-[10px] px-3 py-1.5 rounded-full bg-white/5 text-white/45 border border-white/8 hover:bg-white/10 hover:text-white/70 transition">📦 Handle with care</button>
          <button class="note-chip text-[10px] px-3 py-1.5 rounded-full bg-white/5 text-white/45 border border-white/8 hover:bg-white/10 hover:text-white/70 transition">📞 Call before delivery</button>
          <button class="note-chip text-[10px] px-3 py-1.5 rounded-full bg-white/5 text-white/45 border border-white/8 hover:bg-white/10 hover:text-white/70 transition">🚪 Leave at door</button>
          <button class="note-chip text-[10px] px-3 py-1.5 rounded-full bg-white/5 text-white/45 border border-white/8 hover:bg-white/10 hover:text-white/70 transition">⏰ Urgent order</button>
        </div>
        <div class="flex gap-3">
          <button id="save-note-btn"
            class="flex-1 h-11 rounded-xl bg-white text-black text-sm font-extrabold hover:bg-slate-100 transition active:scale-[0.98] flex items-center justify-center gap-2">
            <span id="save-note-btn-text">Save Note</span>
            <svg id="save-note-spinner" class="hidden w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
          </button>
          <button id="close-note-modal-2"
            class="px-5 h-11 rounded-xl bg-white/5 text-white/50 text-sm font-semibold hover:bg-white/10 transition">Cancel</button>
        </div>
      </div>
    </div>

    <!-- PROOF UPLOAD SHEET -->
    <div id="proof-upload-overlay"
      class="fixed inset-0 z-[80] bg-black/70 backdrop-blur-md hidden opacity-0 transition-opacity duration-300 flex items-end sm:items-center justify-center p-4">
      <div data-modal-panel
        class="w-full max-w-md bg-[#0f1115] border border-white/8 rounded-[1.75rem] p-6 scale-95 translate-y-4 transition-all duration-300 shadow-2xl">
        <div class="w-10 h-1 bg-white/10 rounded-full mx-auto mb-5 sm:hidden"></div>
        <div class="flex items-start justify-between mb-6">
          <div>
            <h3 class="text-base font-bold text-white tracking-tight">Upload Delivery Proof</h3>
            <p class="text-xs text-white/35 mt-0.5">A photo confirming successful delivery</p>
          </div>
          <button id="close-proof-modal"
            class="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition text-sm">✕</button>
        </div>
        <label id="proof-drop-zone"
          class="relative flex flex-col items-center justify-center gap-3 h-44 rounded-2xl border-2 border-dashed border-white/10 bg-white/[0.02] cursor-pointer hover:border-indigo-500/40 hover:bg-indigo-500/5 transition-all duration-200 mb-5 overflow-hidden group">
          <input type="file" id="proof-file-input" accept="image/*" class="hidden" />
          <div id="proof-placeholder" class="flex flex-col items-center gap-2">
            <div class="w-12 h-12 rounded-2xl bg-white/5 group-hover:bg-indigo-500/10 flex items-center justify-center transition-colors">
              <svg class="w-5 h-5 text-white/30 group-hover:text-indigo-400 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
              </svg>
            </div>
            <div class="text-center">
              <p class="text-xs font-semibold text-white/40 group-hover:text-white/60 transition-colors">Tap to upload photo</p>
              <p class="text-[10px] text-white/20 mt-0.5">JPEG / PNG · Max 5MB</p>
            </div>
          </div>
          <img id="proof-preview-img" class="hidden absolute inset-0 w-full h-full object-cover rounded-2xl" />
          <div id="proof-preview-overlay" class="hidden absolute inset-0 bg-black/50 flex items-center justify-center rounded-2xl">
            <span class="text-xs font-semibold text-white bg-black/50 px-4 py-2 rounded-full">🔄 Change photo</span>
          </div>
        </label>
        <input id="proof-caption" type="text" maxlength="100"
          placeholder="Optional caption… e.g. Left at gate, customer received"
          class="w-full bg-white/[0.03] border border-white/8 focus:border-indigo-500/50 rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 outline-none transition-colors duration-200 mb-5" />
        <div class="flex gap-3">
          <button id="submit-proof-btn" disabled
            class="flex-1 h-11 rounded-xl bg-white text-black text-sm font-extrabold hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed transition active:scale-[0.98] flex items-center justify-center gap-2">
            <span id="submit-proof-text">Upload Proof</span>
            <svg id="submit-proof-spinner" class="hidden w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
          </button>
          <button id="close-proof-modal-2"
            class="px-5 h-11 rounded-xl bg-white/5 text-white/50 text-sm font-semibold hover:bg-white/10 transition">Cancel</button>
        </div>
      </div>
    </div>

    <!-- BULK ASSIGN DRIVER MODAL -->
    <div id="bulk-assign-overlay" class="fixed inset-0 z-[70] bg-black/60 backdrop-blur-md hidden opacity-0 transition-opacity duration-300 flex items-center justify-center p-4">
      <div id="bulk-assign-modal" class="w-full max-w-sm bg-[#0d1117] border border-white/10 rounded-2xl p-6 scale-95 transition-transform duration-300">
        <h2 class="text-lg font-bold mb-1">Assign to Driver</h2>
        <p class="text-xs text-white/40 mb-4" id="bulk-assign-count">Select orders and driver</p>
        <div id="bulk-assign-driver-list" class="space-y-2 max-h-60 overflow-y-auto mb-4"></div>
        <input type="hidden" id="bulk-selected-driver-id" />
        <div class="flex gap-3">
          <button id="bulk-confirm-assign-btn" class="flex-1 py-2.5 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition" disabled>Assign</button>
          <button class="bulk-assign-close-btn px-4 py-2.5 rounded-xl bg-white/5 text-white/60 text-sm hover:bg-white/10 transition">Cancel</button>
        </div>
      </div>
    </div>
  `);

  // ---- Note modal bindings ----
  const noteTA = document.getElementById("note-modal-textarea");
  const charCount = document.getElementById("note-char-count");
  noteTA?.addEventListener("input", () => {
    charCount.textContent = `${noteTA.value.length} / 300`;
  });
  document.querySelectorAll(".note-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const current = noteTA.value.trim();
      noteTA.value = current ? `${current}, ${chip.textContent.trim()}` : chip.textContent.trim();
      charCount.textContent = `${noteTA.value.length} / 300`;
    });
  });
  document.getElementById("close-note-modal")?.addEventListener("click", () => closeModal("vendor-note-overlay"));
  document.getElementById("close-note-modal-2")?.addEventListener("click", () => closeModal("vendor-note-overlay"));

  // ---- Proof modal bindings ----
  const proofInput = document.getElementById("proof-file-input");
  const proofPreviewImg = document.getElementById("proof-preview-img");
  const proofPlaceholder = document.getElementById("proof-placeholder");
  const proofPreviewOverlay = document.getElementById("proof-preview-overlay");
  const submitProofBtn = document.getElementById("submit-proof-btn");

  document.getElementById("proof-drop-zone")?.addEventListener("click", () => proofInput?.click());
  proofInput?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      proofPreviewImg.src = ev.target.result;
      proofPreviewImg.classList.remove("hidden");
      proofPreviewOverlay.classList.remove("hidden");
      proofPlaceholder.classList.add("hidden");
      submitProofBtn.disabled = false;
    };
    reader.readAsDataURL(file);
  });
  document.getElementById("close-proof-modal")?.addEventListener("click", () => closeModal("proof-upload-overlay"));
  document.getElementById("close-proof-modal-2")?.addEventListener("click", () => closeModal("proof-upload-overlay"));

  // ---- Save note ----
  document.getElementById("save-note-btn")?.addEventListener("click", async () => {
    if (!currentNoteOrderId) return;
    const textarea = document.getElementById("note-modal-textarea");
    const btn = document.getElementById("save-note-btn");
    const btnText = document.getElementById("save-note-btn-text");
    const spinner = document.getElementById("save-note-spinner");

    btn.disabled = true;
    btnText.textContent = "Saving…";
    spinner.classList.remove("hidden");

    try {
      await updateDoc(doc(db, "orders", currentNoteOrderId), {
        vendorNote: textarea.value.trim(),
        updatedAt: serverTimestamp()
      });
      closeModal("vendor-note-overlay");
      window.showNotif?.({ type: "success", title: "Note Saved", message: "Your note has been saved." });
    } catch (e) {
      console.error("Save note failed:", e);
      window.showNotif?.({ type: "error", title: "Failed", message: "Could not save note." });
    } finally {
      btn.disabled = false;
      btnText.textContent = "Save Note";
      spinner.classList.add("hidden");
    }
  });

  // ---- Submit proof ----
  // Resolves to "paid & delivered" if payBefore order, else "proof uploaded"
  document.getElementById("submit-proof-btn")?.addEventListener("click", async () => {
    if (!currentProofOrderId) return;
    const proofFileInput = document.getElementById("proof-file-input");
    const captionInput = document.getElementById("proof-caption");
    const btn = document.getElementById("submit-proof-btn");
    const btnText = document.getElementById("submit-proof-text");
    const spinner = document.getElementById("submit-proof-spinner");

    const file = proofFileInput?.files?.[0];
    if (!file) return;

    btn.disabled = true;
    btnText.textContent = "Uploading…";
    spinner.classList.remove("hidden");

    try {
      const compressed = await compressImage(file, 800, 0.65);
      const caption = captionInput?.value?.trim() || "";

      // Determine terminal status based on payment type
      const order = allOrders.find(o => o.id === currentProofOrderId);
      const finalStatus = isPayBeforeDelivery(order) ? "paid & delivered" : "proof uploaded";

      await updateDoc(doc(db, "orders", currentProofOrderId), {
        vendorNote: caption,
        status: finalStatus,
        updatedAt: serverTimestamp()
      });

      await setDoc(doc(db, "proofs", currentProofOrderId), {
        orderId: currentProofOrderId,
        image: compressed,
        caption,
        createdAt: serverTimestamp()
      });

      // terminal for pay-before orders — client no longer needs driver visibility
      // once this order is done, unless another active order with this driver exists
      if (finalStatus === "paid & delivered" && order.driverId) {
        await maybeRemoveClientFromDriver(order.driverId, order.clientId);
      }

      closeModal("proof-upload-overlay");
      window.showNotif?.({ type: "success", title: "Proof Uploaded", message: "Delivery proof has been saved." });
    } catch (e) {
      console.error("Upload proof failed:", e);
      window.showNotif?.({ type: "error", title: "Failed", message: "Could not upload proof." });
    } finally {
      btn.disabled = false;
      btnText.textContent = "Upload Proof";
      spinner.classList.add("hidden");
    }
  });

  // ---- Bulk assign confirmation ----
  document.getElementById("bulk-confirm-assign-btn")?.addEventListener("click", async () => {
    if (selectedOrderIds.size === 0) return;
    const driverId = document.getElementById("bulk-selected-driver-id").value;
    if (!driverId) return;

    const btn = document.getElementById("bulk-confirm-assign-btn");
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = `<svg class="w-4 h-4 animate-spin mx-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;
    try {
      const count = selectedOrderIds.size;
      const ordersToAssign = Array.from(selectedOrderIds)
        .map(id => allOrders.find(o => o.id === id))
        .filter(Boolean);
      const clientIds = [...new Set(ordersToAssign.map(o => o.clientId))];

      await Promise.all([
        ...ordersToAssign.map(o =>
          updateDoc(doc(db, "orders", o.id), {
            driverId,
            status: "assigned",
            updatedAt: serverTimestamp()
          })
        ),
        updateDoc(doc(db, "drivers", driverId), {
          assignedClientIds: arrayUnion(...clientIds)
        })
      ]);

      closeModal("bulk-assign-overlay");
      selectedOrderIds.clear();
      renderFilteredOrders();
      updateBulkAssignButton();

      window.showNotif?.({
        type: "success",
        title: "Bulk Assignment Complete",
        message: `✅ ${count} order${count > 1 ? "s" : ""} assigned to driver.`
      });

      updateDriverStats(driverId);
    } catch (e) {
      console.error("Bulk assign failed:", e);
      window.showNotif?.({ type: "error", title: "Failed", message: "Could not assign orders." });
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  document.querySelectorAll(".bulk-assign-close-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      closeModal("bulk-assign-overlay");
      document.getElementById("bulk-selected-driver-id").value = "";
    });
  });
}


// =========================
// PAYMENT GUARD DIALOG
// =========================
function showPaymentGuard(orderNames, onConfirm) {
  const existing = document.getElementById("payment-guard-overlay");
  if (existing) existing.remove();

  const isBulk = orderNames.length > 1;
  const listHTML = orderNames
    .map(n => `<li class="flex items-center gap-2 text-xs text-white/60"><span class="text-yellow-400">⚠️</span>${escHTML(n)}</li>`)
    .join("");

  const el = document.createElement("div");
  el.id = "payment-guard-overlay";
  el.className = "fixed inset-0 z-[90] bg-black/70 backdrop-blur-md flex items-center justify-center p-4";
  el.innerHTML = `
    <div class="w-full max-w-sm bg-[#0f1115] border border-yellow-500/20 rounded-[1.75rem] p-6 shadow-2xl"
         style="animation: scaleIn 0.25s cubic-bezier(0.34,1.56,0.64,1)">
      <div class="w-12 h-12 rounded-2xl bg-yellow-500/10 flex items-center justify-center text-2xl mb-4 mx-auto">💳</div>
      <h3 class="text-base font-bold text-white text-center tracking-tight mb-1">Payment Before Delivery</h3>
      <p class="text-xs text-white/40 text-center mb-4">
        ${isBulk ? "These orders require" : "This order requires"} payment before dispatch.
        Are you sure you want to assign a driver?
      </p>
      <ul class="space-y-1.5 bg-white/[0.02] border border-white/5 rounded-xl p-3 mb-5">
        ${listHTML}
      </ul>
      <div class="flex gap-3">
        <button id="payment-guard-confirm"
          class="flex-1 h-11 rounded-xl bg-yellow-500 text-black text-sm font-extrabold hover:bg-yellow-400 transition active:scale-[0.98]">
          Yes, Assign Anyway
        </button>
        <button id="payment-guard-cancel"
          class="px-5 h-11 rounded-xl bg-white/5 text-white/50 text-sm font-semibold hover:bg-white/10 transition">
          Cancel
        </button>
      </div>
    </div>`;

  el.querySelector("#payment-guard-confirm").addEventListener("click", () => {
    el.remove();
    onConfirm();
  });
  el.querySelector("#payment-guard-cancel").addEventListener("click", () => el.remove());
  el.addEventListener("click", e => { if (e.target === el) el.remove(); });

  document.body.appendChild(el);
}


// =========================
// SKELETON CARD
// =========================
function skeletonCard() {
  return `
    <div class="w-full max-w-md bg-[#111318] rounded-2xl overflow-hidden border border-white/5 flex flex-col animate-pulse">
      <div class="h-40 bg-white/5"></div>
      <div class="p-4 space-y-3">
        <div class="h-4 bg-white/5 rounded-lg w-3/5"></div>
        <div class="h-3 bg-white/5 rounded-lg w-2/5"></div>
        <div class="space-y-2 bg-white/[0.02] rounded-xl p-3">
          <div class="h-3 bg-white/5 rounded w-full"></div>
          <div class="h-3 bg-white/5 rounded w-4/5"></div>
          <div class="h-3 bg-white/5 rounded w-3/5"></div>
        </div>
        <div class="h-10 bg-white/5 rounded-xl mt-2"></div>
      </div>
    </div>`;
}


// =========================
// ENRICH ORDER
// =========================
async function enrichOrder(data) {
  const [clientData, productData, driverData] = await Promise.all([
    cachedGet("clients", data.clientId),
    cachedGet("products", data.product_id),
    data.driverId ? cachedGet("drivers", data.driverId) : Promise.resolve(null)
  ]);

  data.clientName = clientData?.username || clientData?.first_name || "Customer";
  data.clientPhone = clientData?.phone || "N/A";
  data.productImage = productData?.image || "";
  data.productName = productData?.name || data.name || "Product";

  if (driverData) {
    data.driverName = driverData.name || "Unknown Driver";
    data.driverPhone = driverData.phone || "";
  }

  return data;
}


// =========================
// LOAD ORDERS — LIVE LISTENER
// =========================
window.loadOrdersTab = function () {
  const vendorId = window.vendorId;
  if (!vendorId) return;
  initDispatchPanel(vendorId);
  injectSelectorStyles();
  injectModals();
  if (ordersUnsub) ordersUnsub();

  const list = document.getElementById("orders-list");
  if (list) list.innerHTML = [1, 2, 3].map(() => skeletonCard()).join("");

  const q = query(
    collection(db, "orders"),
    where("vendor_id", "==", vendorId),
    orderBy("createdAt", "desc")
  );

  ordersUnsub = onSnapshot(q, async (snap) => {
    const orders = await Promise.all(
      snap.docs.map(d => {
        const data = { id: d.id, ...d.data() };
        if (loadingOrderIds.has(data.id)) {
          const existing = allOrders.find(o => o.id === data.id);
          if (existing) return existing;
        }
        return enrichOrder(data);
      })
    );

    allOrders = orders;
    renderFilteredOrders();
    updateOrdersBadge();
    updateBulkAssignButton();
  }, (err) => {
    console.error("Orders listener error:", err);
    if (list) list.innerHTML = `
      <div class="col-span-full text-center py-16">
        <p class="text-4xl mb-3">⚠️</p>
        <p class="text-sm text-red-400">Failed to load orders.</p>
        <button onclick="window.loadOrdersTab()" class="mt-3 text-xs text-indigo-400 hover:underline">Try again</button>
      </div>`;
  });
};


// =========================
// UPDATE BADGE
// =========================
function updateOrdersBadge() {
  const pendingCount = allOrders.filter(o => o.status === "pending").length;
  const badge = document.querySelector(".orders-badge");
  if (badge) {
    badge.textContent = pendingCount;
    badge.classList.toggle("hidden", pendingCount === 0);
  }
}


// =========================
// UPDATE BULK ASSIGN BUTTON
// =========================
function updateBulkAssignButton() {
  const unassigned = allOrders.filter(isUnassignedDelivery);
  let bulkBtn = document.getElementById("bulk-assign-btn");

  if (unassigned.length === 0) {
    if (bulkBtn) bulkBtn.remove();
    return;
  }

  if (!bulkBtn) {
    const ordersContainer = document.getElementById("orders-list")?.parentElement;
    if (ordersContainer) {
      bulkBtn = document.createElement("button");
      bulkBtn.id = "bulk-assign-btn";
      bulkBtn.className = "fixed bottom-5 left-1/2 -translate-x-1/2 z-20 px-6 py-3 rounded-2xl bg-indigo-500 text-white font-semibold text-sm hover:bg-indigo-600 transition shadow-xl flex items-center gap-2 animate-pulse";
      bulkBtn.innerHTML = `
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        <span id="bulk-count-display">${unassigned.length}</span> unassigned
      `;
      bulkBtn.addEventListener("click", openBulkAssignModal);
      document.body.appendChild(bulkBtn);
    }
  } else {
    document.getElementById("bulk-count-display").textContent = unassigned.length;
  }
}


// =========================
// RENDER FILTERED ORDERS
// =========================
function renderFilteredOrders() {
  const list = document.getElementById("orders-list");
  const empty = document.getElementById("orders-empty");
  if (!list) return;

  let filtered = allOrders;
  if (activeFilter === "pending") {
    filtered = allOrders.filter(o => o.status === "pending");
  } else if (activeFilter === "active") {
    filtered = allOrders.filter(o => !TERMINAL_STATUSES.has(o.status));
  } else if (activeFilter === "completed") {
    filtered = allOrders.filter(o => TERMINAL_STATUSES.has(o.status));
  }

  if (filtered.length === 0) {
    list.innerHTML = "";
    empty?.classList.remove("hidden");
    return;
  }

  empty?.classList.add("hidden");

  const fragment = document.createDocumentFragment();
  filtered.forEach((order, i) => {
    fragment.appendChild(buildOrderCard(order, i));
  });

  list.innerHTML = "";
  list.appendChild(fragment);
}


// =========================
// BUILD ORDER CARD
// =========================
function buildOrderCard(order, index = 0) {
  const status = order.status || "pending";
  const statusInfo = STATUS_FLOW[status] || STATUS_FLOW.pending;

  
  const isDelivery = order.delivery?.enabled;
  const address = order.delivery?.address;
  const driverName = order.driverName || null;
  const payBefore = isPayBeforeDelivery(order);

  // Show bulk selector for confirmed delivery orders (normal) OR paid delivery orders (pay-before)
  const showSelector = isUnassignedDelivery(order);
  const isSelected = selectedOrderIds.has(order.id);

  const card = document.createElement("div");
  card.className = `w-full max-w-md bg-[#111318] rounded-2xl overflow-hidden border transition-all duration-300 flex flex-col order-card ${
    isSelected ? "border-indigo-500/50 bg-indigo-500/5" : "border-white/5 hover:border-white/10"
  }`;
  card.style.cssText = `opacity:0;transform:translateY(28px);transition:opacity 0.4s ease,transform 0.4s cubic-bezier(0.22,1,0.36,1);transition-delay:${index * 60}ms;`;

  requestAnimationFrame(() => requestAnimationFrame(() => {
    card.style.opacity = "1";
    card.style.transform = "translateY(0)";
  }));

  card.innerHTML = `
    <div class="relative h-40 overflow-hidden bg-white/5">
      ${order.productImage
        ? `<img src="${order.productImage}" alt="" class="w-full h-full object-cover" onerror="this.style.opacity='0.2'" />`
        : `<div class="w-full h-full flex items-center justify-center text-white/10 text-4xl">📦</div>`
      }
      <div class="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent pointer-events-none"></div>
      <span class="absolute top-3 right-3 text-[10px] px-2.5 py-1 rounded-full font-semibold ${statusInfo.color} backdrop-blur-sm border border-white/5">
      ${statusInfo.icon} ${statusInfo.label}
    </span>
    ${isPaid(order) && !["paid", "paid & delivered", "picked up"].includes(status) ? `
      <span class="absolute top-11 right-3 text-[10px] px-2.5 py-1 rounded-full font-semibold bg-emerald-500/15 text-emerald-400 backdrop-blur-sm border border-emerald-500/15">
        💚 Paid
      </span>
    ` : ""}
      ${isDelivery
        ? `<span class="absolute top-3 left-3 text-[10px] px-2.5 py-1 rounded-full bg-black/50 text-white/60 backdrop-blur-sm">🚚 Delivery</span>`
        : `<span class="absolute top-3 left-3 text-[10px] px-2.5 py-1 rounded-full bg-black/50 text-white/60 backdrop-blur-sm">🏪 Pickup</span>`
      }
      ${showSelector ? `
        <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
          <button class="unassigned-selector ${isSelected ? "selected" : ""}">
            ${isSelected ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"></polyline></svg>` : ""}
          </button>
        </div>
      ` : ""}
    </div>

    <div class="p-4 space-y-3 flex-1 flex flex-col">
      <div>
        <h3 class="text-sm font-semibold text-white truncate">${escHTML(order.productName)}</h3>
        <p class="text-[10px] text-white/25 mt-0.5">
          #${order.id.slice(-6).toUpperCase()} · ${timeAgo(order.createdAt?.toDate?.() || new Date())}
          ${payBefore ? `<span class="ml-1.5 text-emerald-400/70">· 💳 Pay before delivery</span>` : ""}
        </p>
      </div>

      <div class="bg-white/[0.02] rounded-xl p-3 space-y-1.5 border border-white/[0.03]">
        <p class="text-[9px] font-bold text-white/25 uppercase tracking-widest mb-2">Customer</p>
        <div class="flex items-center justify-between">
          <span class="text-xs text-white/40">👤 Name</span>
          <span class="text-xs text-white/80 font-medium">${escHTML(order.clientName)}</span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-xs text-white/40">📱 Phone</span>
          <a href="tel:${escHTML(order.clientPhone)}" class="text-xs text-indigo-400 hover:text-indigo-300 transition">${escHTML(order.clientPhone)}</a>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-xs text-white/40">📦 Qty</span>
          <span class="text-xs text-white/80 font-semibold">×${order.quantity || 1}</span>
        </div>
      </div>

      ${isDelivery ? `
        <div class="bg-white/[0.02] rounded-xl p-3 space-y-1.5 border border-white/[0.03]">
          <p class="text-[9px] font-bold text-white/25 uppercase tracking-widest mb-2">Delivery</p>
          ${driverName ? `
            <div class="flex items-center justify-between">
              <span class="text-xs text-white/40">🚴 Driver</span>
              <span class="text-xs text-purple-400 font-medium">${escHTML(driverName)}</span>
            </div>` : ""}
          ${address ? `
            <div class="flex items-start justify-between gap-2">
              <span class="text-xs text-white/40 shrink-0">📍 Address</span>
              <span class="text-xs text-white/50 text-right leading-relaxed">${escHTML(address.streetAddress || "")}, ${escHTML(address.city || "")}</span>
            </div>` : ""}
        </div>
      ` : `
        <div class="bg-white/[0.02] rounded-xl p-3 border border-white/[0.03]">
          <p class="text-[9px] font-bold text-white/25 uppercase tracking-widest mb-1.5">Pickup</p>
          <p class="text-xs text-white/40">Customer will collect from your store.</p>
        </div>
      `}

      ${order.proofImage ? `
        <div class="relative rounded-xl overflow-hidden bg-white/5 cursor-pointer proof-preview" data-src="${order.proofImage}">
          <img src="${order.proofImage}" class="w-full h-28 object-cover opacity-75 hover:opacity-100 transition-opacity duration-200" />
          <div class="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent flex items-end p-2.5">
            <span class="text-[10px] text-white/80 font-medium">📸 View delivery proof</span>
          </div>
        </div>
      ` : ""}

      <div class="bg-white/[0.02] rounded-xl p-3 border border-white/[0.03]">
        <p class="text-[9px] font-bold text-white/25 uppercase tracking-widest mb-1.5">Note</p>
        <p class="text-xs text-white/45 leading-relaxed italic">${order.vendorNote ? escHTML(order.vendorNote) : "—"}</p>
      </div>

      <div class="flex items-center justify-between pt-2 border-t border-white/5 mt-auto">
        <div>
          <p class="text-[10px] text-white/25">Total</p>
          <p class="text-base font-bold text-emerald-400">KSh ${(order.subtotal || 0).toLocaleString()}</p>
        </div>
        <div class="flex gap-2">
          ${getActionButtons(order, status, isDelivery, payBefore)}
        </div>
      </div>
    </div>`;

  card.querySelector(".proof-preview")?.addEventListener("click", (e) => {
    previewImage(e.currentTarget.dataset.src, "Delivery Proof");
  });

  if (showSelector) {
    const selector = card.querySelector(".unassigned-selector");
    selector?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleOrderSelection(order.id);
    });
  }

  bindOrderActions(card, order, status, isDelivery);
  return card;
}


// =========================
// TOGGLE ORDER SELECTION
// =========================
function toggleOrderSelection(orderId) {
  if (selectedOrderIds.has(orderId)) {
    selectedOrderIds.delete(orderId);
  } else {
    selectedOrderIds.add(orderId);
  }
  renderFilteredOrders();
}


// =========================
// GET ACTION BUTTONS
// =========================
function getActionButtons(order, status, isDelivery, payBefore) {
  const spinner = `<svg class="btn-spinner hidden w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;
  const buttons = [];

  // Confirm (any pending order)
  if (status === "pending") {
    buttons.push(`<button class="order-action-btn px-3 py-2 rounded-lg bg-emerald-500/15 text-emerald-400 text-[11px] font-semibold hover:bg-emerald-500/25 border border-emerald-500/15 transition flex items-center gap-1.5" data-action="confirm"><span class="btn-label">✅ Confirm</span>${spinner}</button>`);
  }

  // Normal delivery: confirmed → assign
  if (isDelivery && status === "confirmed" && !payBefore) {
    buttons.push(`<button class="order-action-btn px-3 py-2 rounded-lg bg-purple-500/15 text-purple-400 text-[11px] font-semibold hover:bg-purple-500/25 border border-purple-500/15 transition" data-action="assign">🚴 Assign</button>`);
  }

    // Pay-before delivery: confirmed but NOT paid yet → awaiting payment
  if (isDelivery && status === "confirmed" && payBefore && !isPaid(order)) {
    buttons.push(`<span class="px-3 py-2 rounded-lg bg-yellow-500/10 text-yellow-400/70 text-[11px] border border-yellow-500/10">⏳ Awaiting payment</span>`);
  }

  // Pay-before delivery: confirmed AND paid → safe to assign
  if (isDelivery && status === "confirmed" && payBefore && isPaid(order)) {
    buttons.push(`<button class="order-action-btn px-3 py-2 rounded-lg bg-purple-500/15 text-purple-400 text-[11px] font-semibold hover:bg-purple-500/25 border border-purple-500/15 transition" data-action="assign">🚴 Assign</button>`);
  }
  // Pickup flow
  if (!isDelivery && status === "confirmed") {
    buttons.push(`<button class="order-action-btn px-3 py-2 rounded-lg bg-blue-500/15 text-blue-400 text-[11px] font-semibold hover:bg-blue-500/25 border border-blue-500/15 transition flex items-center gap-1.5" data-action="packaging"><span class="btn-label">📦 Package</span>${spinner}</button>`);
  }
  if (status === "packaging") {
    buttons.push(`<button class="order-action-btn px-3 py-2 rounded-lg bg-indigo-500/15 text-indigo-400 text-[11px] font-semibold hover:bg-indigo-500/25 border border-indigo-500/15 transition flex items-center gap-1.5" data-action="ready"><span class="btn-label">📍 Ready</span>${spinner}</button>`);
  }

  // Proof upload (out for delivery)
  if (status === "out for delivery") {
    //this feature is removed so that only drivers can upload proof, not vendors. Vendors can only view the proof uploaded by drivers.
    //buttons.push(`<button class="order-action-btn px-3 py-2 rounded-lg bg-pink-500/15 text-pink-400 text-[11px] font-semibold hover:bg-pink-500/25 border border-pink-500/15 transition" data-action="upload-proof">📸 Proof</button>`);
  }

  // Note button (any non-terminal order)
  if (!TERMINAL_STATUSES.has(status)) {
    buttons.push(`<button class="order-action-btn px-3 py-2 rounded-lg bg-white/5 text-white/50 text-[11px] font-semibold hover:bg-white/10 border border-white/5 transition" data-action="add-note">📝</button>`);
  }

  return buttons.join("");
}


// =========================
// BIND ORDER ACTIONS
// =========================
function bindOrderActions(card, order, status, isDelivery) {
  card.querySelectorAll(".order-action-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.action;

      if (action === "assign") {
        openAssignDriverModal(order.id);
        return;
      }
      if (action === "upload-proof") {
        openProofUploadSheet(order.id);
        return;
      }
      if (action === "add-note") {
        openNoteModal(order);
        return;
      }

      const statusMap = { confirm: "confirmed", packaging: "packaging", ready: "ready" };
      const newStatus = statusMap[action];
      if (!newStatus) return;

      setButtonLoading(btn, true);
      loadingOrderIds.add(order.id);

      try {
        await updateOrderStatus(order.id, newStatus);
      } catch (e) {
        console.error("Status update failed:", e);
      } finally {
        loadingOrderIds.delete(order.id);
        setButtonLoading(btn, false);
      }
    });
  });
}


// =========================
// BUTTON LOADING STATE
// =========================
function setButtonLoading(btn, loading) {
  btn.disabled = loading;
  btn.querySelector(".btn-label")?.classList.toggle("hidden", loading);
  btn.querySelector(".btn-spinner")?.classList.toggle("hidden", !loading);
}


// =========================
// UPDATE ORDER STATUS
// =========================
async function updateOrderStatus(orderId, newStatus) {
  try {
    await updateDoc(doc(db, "orders", orderId), {
      status: newStatus,
      updatedAt: serverTimestamp()
    });
    window.showNotif?.({
      type: "success",
      title: "Status Updated",
      message: `Order is now "${STATUS_FLOW[newStatus]?.label || newStatus}".`
    });
  } catch (e) {
    console.error("Status update failed:", e);
    window.showNotif?.({ type: "error", title: "Failed", message: "Could not update order status." });
    throw e;
  }
}


// =========================
// VENDOR NOTE MODAL
// =========================
function openNoteModal(order) {
  currentNoteOrderId = order.id;
  const label = document.getElementById("note-modal-order-label");
  const textarea = document.getElementById("note-modal-textarea");
  const charCount = document.getElementById("note-char-count");
  if (label) label.textContent = `#${order.id.slice(-6).toUpperCase()} · ${escHTML(order.productName || "Order")}`;
  if (textarea) {
    textarea.value = order.vendorNote || "";
    charCount.textContent = `${textarea.value.length} / 300`;
  }
  openModal("vendor-note-overlay");
  setTimeout(() => textarea?.focus(), 350);
}


// =========================
// PROOF UPLOAD SHEET
// =========================
function openProofUploadSheet(orderId) {
  currentProofOrderId = orderId;
  const proofInput = document.getElementById("proof-file-input");
  const proofPreviewImg = document.getElementById("proof-preview-img");
  const proofPlaceholder = document.getElementById("proof-placeholder");
  const proofPreviewOverlay = document.getElementById("proof-preview-overlay");
  const submitProofBtn = document.getElementById("submit-proof-btn");
  const captionInput = document.getElementById("proof-caption");

  if (proofInput) proofInput.value = "";
  if (proofPreviewImg) { proofPreviewImg.src = ""; proofPreviewImg.classList.add("hidden"); }
  if (proofPreviewOverlay) proofPreviewOverlay.classList.add("hidden");
  if (proofPlaceholder) proofPlaceholder.classList.remove("hidden");
  if (submitProofBtn) submitProofBtn.disabled = true;
  if (captionInput) captionInput.value = "";

  openModal("proof-upload-overlay");
}


// =========================
// IMAGE COMPRESSION
// =========================
function compressImage(file, maxW = 800, quality = 0.65) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = ev.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}


// =========================
// ASSIGN DRIVER MODAL (single order)
// Guard fires if: delivery enabled + paymentTiming === "before" + NOT yet paid
// If status is already "paid", payment is confirmed — skip the guard
// =========================
async function openAssignDriverModal(orderId) {
  const order = allOrders.find(o => o.id === orderId);
  const payBefore = isPayBeforeDelivery(order);
  const alreadyPaid = isPaid(order);   // 👈 was: order?.status === "paid"

  if (payBefore && !alreadyPaid) {
    showPaymentGuard(
      [order.productName || `#${orderId.slice(-6).toUpperCase()}`],
      () => openAssignDriverModal_proceed(orderId)
    );
    return;
  }

  openAssignDriverModal_proceed(orderId);
}

async function openAssignDriverModal_proceed(orderId) {
  currentAssignOrderId = orderId;
  selectedDriverId = null;

  const list = document.getElementById("assign-driver-list");
  const confirmBtn = document.getElementById("confirm-assign-btn");

  list.innerHTML = `
    <div class="flex flex-col items-center gap-3 py-6">
      <div class="w-7 h-7 border-2 border-white/10 border-t-indigo-400 rounded-full animate-spin"></div>
      <p class="text-xs text-white/30">Loading drivers…</p>
    </div>`;
  confirmBtn.disabled = true;
  openModal("assign-driver-overlay");

      //remember dont fetch drivers who are unavailabe fix..........................
      try {
    const snap = await getDocs(query(
      collection(db, "drivers"),
      where("vendor_id", "==", window.vendorId),
      where("status", "==", "free")
    ));

    if (snap.empty) {
      list.innerHTML = `
        <div class="text-center py-6">
          <p class="text-2xl mb-2">🚚</p>
          <p class="text-xs text-white/30">No drivers are Available Right now.</p>
        </div>`;
      return;
    }

    const fragment = document.createDocumentFragment();
    snap.forEach(d => {
      const driver = { id: d.id, ...d.data() };
      const statusClass = driver.status === "free"
        ? "bg-emerald-500/15 text-emerald-400"
        : driver.status === "on-road"
          ? "bg-orange-500/15 text-orange-400"
          : "bg-white/10 text-white/40";

      const item = document.createElement("div");
      item.className = "flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-white/5 cursor-pointer hover:border-indigo-500/30 transition-all duration-200";
      item.innerHTML = `
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-full bg-white/5 flex items-center justify-center text-base">🚚</div>
          <div>
            <p class="text-xs text-white font-semibold">${escHTML(driver.name)}</p>
            <p class="text-[10px] text-white/30 mt-0.5">${escHTML(driver.vehicleType || "N/A")} · ${escHTML(driver.plateNumber || "—")}</p>
          </div>
        </div>
        <span class="text-[10px] px-2.5 py-1 rounded-full font-medium ${statusClass}">${driver.status || "free"}</span>`;

      item.addEventListener("click", () => {
        list.querySelectorAll(":scope > div").forEach(el =>
          el.classList.remove("border-indigo-500/50", "bg-indigo-500/5")
        );
        item.classList.add("border-indigo-500/50", "bg-indigo-500/5");
        selectedDriverId = driver.id;
        confirmBtn.disabled = false;
      });

      fragment.appendChild(item);
    });

    list.innerHTML = "";
    list.appendChild(fragment);
  } catch (e) {
    console.error("Load drivers failed:", e);
    list.innerHTML = `<p class="text-xs text-red-400 text-center py-4">Failed to load drivers.</p>`;
  }
}


// =========================
// OPEN BULK ASSIGN MODAL
// Guard fires only for orders where payment hasn't been received yet
// (status === "paid" orders are already cleared — no guard needed)
// =========================
async function openBulkAssignModal() {
  if (selectedOrderIds.size === 0) {
    window.showNotif?.({ type: "warning", title: "No Orders Selected", message: "Please select at least one order." });
    return;
  }

  // Only warn about pay-before orders that are still "confirmed" (not yet paid)
const unpaidPayBeforeOrders = allOrders.filter(o =>
  selectedOrderIds.has(o.id) &&
  isPayBeforeDelivery(o) &&
  !isPaid(o)   // 👈 was: o.status !== "paid"
);

  if (unpaidPayBeforeOrders.length > 0) {
    const names = unpaidPayBeforeOrders.map(o => o.productName || `#${o.id.slice(-6).toUpperCase()}`);
    showPaymentGuard(names, () => openBulkAssignModal_proceed());
    return;
  }

  openBulkAssignModal_proceed();
}

async function openBulkAssignModal_proceed() {
  const list = document.getElementById("bulk-assign-driver-list");
  const countLabel = document.getElementById("bulk-assign-count");
  const confirmBtn = document.getElementById("bulk-confirm-assign-btn");

  countLabel.textContent = `${selectedOrderIds.size} order${selectedOrderIds.size > 1 ? "s" : ""} selected`;
  list.innerHTML = `
    <div class="flex flex-col items-center gap-3 py-6">
      <div class="w-7 h-7 border-2 border-white/10 border-t-indigo-400 rounded-full animate-spin"></div>
      <p class="text-xs text-white/30">Loading drivers…</p>
    </div>`;
  confirmBtn.disabled = true;
  document.getElementById("bulk-selected-driver-id").value = "";
  openModal("bulk-assign-overlay");

  try {
    const snap = await getDocs(query(
      collection(db, "drivers"),
      where("vendor_id", "==", window.vendorId)
    ));

    if (snap.empty) {
      list.innerHTML = `
        <div class="text-center py-6">
          <p class="text-2xl mb-2">🚚</p>
          <p class="text-xs text-white/30">No drivers available.</p>
        </div>`;
      return;
    }

    const fragment = document.createDocumentFragment();
    snap.forEach(d => {
      const driver = { id: d.id, ...d.data() };
      const statusClass = driver.status === "free"
        ? "bg-emerald-500/15 text-emerald-400"
        : driver.status === "on-road"
          ? "bg-orange-500/15 text-orange-400"
          : "bg-white/10 text-white/40";

      const item = document.createElement("div");
      item.className = "flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-white/5 cursor-pointer hover:border-indigo-500/30 transition-all duration-200";
      item.innerHTML = `
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-full bg-white/5 flex items-center justify-center text-base">🚚</div>
          <div>
            <p class="text-xs text-white font-semibold">${escHTML(driver.name)}</p>
            <p class="text-[10px] text-white/30 mt-0.5">${escHTML(driver.vehicleType || "N/A")} · ${escHTML(driver.plateNumber || "—")}</p>
          </div>
        </div>
        <span class="text-[10px] px-2.5 py-1 rounded-full font-medium ${statusClass}">${driver.status || "free"}</span>`;

      item.addEventListener("click", () => {
        list.querySelectorAll(":scope > div").forEach(el =>
          el.classList.remove("border-indigo-500/50", "bg-indigo-500/5")
        );
        item.classList.add("border-indigo-500/50", "bg-indigo-500/5");
        document.getElementById("bulk-selected-driver-id").value = driver.id;
        confirmBtn.disabled = false;
      });

      fragment.appendChild(item);
    });

    list.innerHTML = "";
    list.appendChild(fragment);
  } catch (e) {
    console.error("Load drivers failed:", e);
    list.innerHTML = `<p class="text-xs text-red-400 text-center py-4">Failed to load drivers.</p>`;
  }
}


// =========================
// CONFIRM SINGLE ASSIGN
// =========================
document.getElementById("confirm-assign-btn")?.addEventListener("click", async () => {
  if (!currentAssignOrderId || !selectedDriverId) return;
  const btn = document.getElementById("confirm-assign-btn");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = `<svg class="w-4 h-4 animate-spin mx-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;

  loadingOrderIds.add(currentAssignOrderId);

try {
  const order = allOrders.find(o => o.id === currentAssignOrderId);
  await Promise.all([
    updateDoc(doc(db, "orders", currentAssignOrderId), {
      driverId: selectedDriverId,
      status: "assigned",
      updatedAt: serverTimestamp()
    }),
    updateDoc(doc(db, "drivers", selectedDriverId), {
      assignedClientIds: arrayUnion(order.clientId)
    })
  ]);
  closeModal("assign-driver-overlay");
  updateDriverStats(selectedDriverId);
  window.showNotif?.({ type: "success", title: "Driver Assigned", message: "Driver has been assigned to this order." });
} catch (e) {
    console.error("Assign failed:", e);
    window.showNotif?.({ type: "error", title: "Failed", message: "Could not assign driver." });
    btn.disabled = false;
    btn.textContent = originalText;
  } finally {
    loadingOrderIds.delete(currentAssignOrderId);
      setTimeout(()=>{
              btn.innerHTML = 'Assign Driver';
      } , 1000);
  }
});

document.querySelectorAll(".assign-close-btn").forEach(btn => {
  btn.addEventListener("click", () => closeModal("assign-driver-overlay"));
});


// =========================
// IMAGE PREVIEW (FULL SIZE)
// =========================
function previewImage(src, title) {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex items-center justify-center p-4 cursor-pointer";
  overlay.innerHTML = `
    <div class="relative max-w-2xl max-h-[90vh]">
      <img src="${src}" alt="" class="max-w-full max-h-[85vh] object-contain rounded-xl shadow-2xl" />
      <p class="text-center text-white/50 text-xs mt-3">${escHTML(title)}</p>
      <button class="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center text-sm transition">✕</button>
    </div>`;

  const close = () => {
    overlay.remove();
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onEsc);
  };
  const onEsc = (e) => { if (e.key === "Escape") close(); };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.tagName === "BUTTON") close();
  });
  document.addEventListener("keydown", onEsc);
  document.body.style.overflow = "hidden";
  document.body.appendChild(overlay);
}


// =========================
// FILTER BUTTONS
// =========================
document.querySelectorAll(".order-filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    activeFilter = btn.dataset.filter;
    document.querySelectorAll(".order-filter-btn").forEach(b => {
      b.classList.remove("bg-white/8", "text-white", "border-white/15");
      b.classList.add("text-white/40", "border-white/8");
    });
    btn.classList.add("bg-white/8", "text-white", "border-white/15");
    btn.classList.remove("text-white/40", "border-white/8");
    renderFilteredOrders();
  });
});


// =========================
// UPDATE DRIVER STATS (fire-and-forget)
// =========================
async function updateDriverStats(driverId) {
  if (!driverId) return;
  try {
    const allSnap = await getDocs(query(
      collection(db, "orders"),
      where("driverId", "==", driverId)
    ));
    const totalDeliveries = allSnap.size;
    const activeDeliveries = allSnap.docs.filter(d =>
      !TERMINAL_STATUSES.has(d.data().status)
    ).length;

    await updateDoc(doc(db, "drivers", driverId), {
      totalDeliveries,
      activeDeliveries,
      updatedAt: serverTimestamp()
    });
  } catch (e) {
    console.warn("Driver stats update failed:", e);
  }
}