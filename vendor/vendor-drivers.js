// ============================================
// VENDOR DASHBOARD — DRIVERS TAB (OPTIMISED)
// ============================================

import {
  db, collection, query, where, orderBy,
  getDocs, getDoc, doc, updateDoc, deleteDoc, setDoc,
  serverTimestamp, onSnapshot
} from './firebase-config.js';

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from './firebase-config.js';

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
// DRIVER AUTH HELPERS
// =========================
function generateDriverPin() {
  // 6 digits — Firebase Auth's password minimum is 6 characters
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizePhone(phone) {
  return phone.replace(/[^\d]/g, "");
}

function driverEmailFromPhone(phone) {
  return `${normalizePhone(phone)}@drivers.gmarketfy.app`;
}

async function isPhoneTaken(phone) {
  const snap = await getDocs(query(
    collection(db, "drivers"),
    where("vendor_id", "==", window.vendorId),
    where("phone", "==", normalizePhone(phone))
  ));
  return !snap.empty;
}

async function createDriverAuthAccount(phone) {
  const pin = generateDriverPin();
  const email = driverEmailFromPhone(phone);

  const secondaryApp = initializeApp(firebaseConfig, `driverCreation-${Date.now()}`);
  const secondaryAuth = getAuth(secondaryApp);

  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, pin);
    await signOut(secondaryAuth);
    return { uid: cred.user.uid, pin };
  } catch (err) {
    if (err.code === "auth/email-already-in-use") {
      throw new Error("This phone number is already registered to a driver on the platform.");
    }
    throw err;
  } finally {
    await deleteApp(secondaryApp);
  }
}

// =========================
// HELPERS
// =========================
function escHTML(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val ?? "";
}

function openModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => { overlay.style.opacity = "1"; });
  overlay.querySelector("[data-modal-panel]")?.classList.remove("scale-95", "translate-y-4");
}

function closeModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.style.opacity = "0";
  overlay.querySelector("[data-modal-panel]")?.classList.add("scale-95", "translate-y-4");
  setTimeout(() => overlay.classList.add("hidden"), 300);
}

// =========================
// STATUS CONFIG
// =========================
const DRIVER_STATUS = {
  free: {
    label: "Available", icon: "🟢",
    color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
    dot: "bg-emerald-400"
  },
  "on-road": {
    label: "On Road", icon: "🟠",
    color: "bg-orange-500/15 text-orange-400 border-orange-500/20",
    dot: "bg-orange-400"
  },
  "off-duty": {
    label: "Off Duty", icon: "⚫",
    color: "bg-white/8 text-white/35 border-white/10",
    dot: "bg-white/20"
  },

  "not-active": {
    label: "Account not Active", icon: "⚪",
    color: "bg-white/8 text-white/35 border-white/10",
    dot: "bg-white/20"
  }
};

const VEHICLE_ICONS = {
  "Motorcycle": "🏍️", "Bicycle": "🚲", "Car": "🚗",
  "Van": "🚐", "Truck": "🚛", "Tuk-Tuk": "🛺", "Scooter": "🛵"
};

const TERMINAL_STATUSES = new Set(["delivered","paid & delivered" , "cancelled", "paid", "picked up"]);

// Vendor-controllable statuses — only these can be toggled by the vendor
const VENDOR_CONTROLLABLE_STATUSES = new Set(["free", "off-duty"]);

function getVehicleIcon(type) { return VEHICLE_ICONS[type] || "🚚"; }

// Check if a status transition is allowed for vendor control
function isVendorStatusChangeAllowed(fromStatus, toStatus) {
  const from = fromStatus || "free";
  // Both statuses must be vendor-controllable
  if (!VENDOR_CONTROLLABLE_STATUSES.has(from) || !VENDOR_CONTROLLABLE_STATUSES.has(toStatus)) {
    return false;
  }
  // Cannot change to the same status
  if (from === toStatus) {
    return false;
  }
  return true;
}

// =========================
// STATE
// =========================
let allDrivers = [];
let editingDriverId = null;
let driversUnsub = null;
let driverImageData = null;

// =========================
// INJECT MODALS (once)
// =========================
function injectDriverModals() {
  if (document.getElementById("driver-add-overlay")) return;

  document.body.insertAdjacentHTML("beforeend", `
    <!-- ADD / EDIT DRIVER MODAL -->
    <div id="driver-add-overlay"
      class="fixed inset-0 z-[80] bg-black/70 backdrop-blur-xl hidden opacity-0 transition-opacity duration-300 flex items-center justify-center p-4">
      <div data-modal-panel
        class="w-full max-w-xl bg-[#0c0e12] border border-white/5 rounded-[2.2rem] px-6 md:px-10 py-8 scale-95 translate-y-6 transition-all duration-300 shadow-[0_20px_80px_rgba(0,0,0,0.6)] max-h-[92vh] overflow-y-auto relative">

        <div class="text-center mb-10">
          <h2 id="driver-modal-heading" class="text-3xl font-extrabold text-white tracking-tight">Add Driver</h2>
          <p class="text-slate-500 text-sm mt-2">Enter driver details below</p>
        </div>

        <button id="close-driver-modal"
          class="absolute top-5 right-5 w-10 h-10 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 transition text-white/60 hover:text-white">✕</button>

        <form id="driver-add-form" class="space-y-8">
          <input type="hidden" id="daf-id" />

          <!-- PHOTO -->
          <div class="flex flex-col items-center gap-5 text-center">
            <label class="text-[11px] font-bold text-slate-400 uppercase tracking-[0.25em]">Driver Photo</label>
            <input type="file" id="daf-image-input" accept="image/*" class="hidden" />
            <div id="daf-image-click-area"
              class="w-40 h-40 rounded-full border-2 border-dashed border-white/10 bg-gradient-to-br from-white/[0.04] to-white/[0.01] flex items-center justify-center overflow-hidden cursor-pointer hover:border-indigo-500/50 hover:shadow-[0_0_0_6px_rgba(99,102,241,0.15)] transition-all duration-300 relative group">
              <div id="daf-image-placeholder" class="flex flex-col items-center gap-2 text-center px-2">
                <div class="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-lg">📷</div>
                <span class="text-[10px] text-slate-400 font-semibold tracking-widest">UPLOAD PHOTO</span>
              </div>
              <img id="daf-image-preview" class="absolute inset-0 w-full h-full object-cover hidden rounded-full" />
              <div class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition flex items-center justify-center rounded-full">
                <span class="text-sm text-white font-semibold tracking-wide">Change Photo</span>
              </div>
            </div>
            <button type="button" id="daf-remove-image-btn" class="hidden text-xs text-red-400 hover:text-red-300 transition font-medium">Remove Photo</button>
          </div>

          <!-- NAME -->
          <div class="space-y-2">
            <label class="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Full Name</label>
            <input id="daf-name" type="text"
              class="w-full h-14 px-5 bg-white/[0.035] border border-white/10 rounded-2xl text-white text-sm outline-none focus:border-indigo-500/60 focus:bg-white/[0.05] transition"
              placeholder="e.g. Brian Otieno" />
          </div>

          <!-- PHONE -->
          <div class="space-y-2">
            <label class="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Phone</label>
            <input id="daf-phone" type="tel"
              class="w-full h-14 px-5 bg-white/[0.035] border border-white/10 rounded-2xl text-white text-sm outline-none focus:border-indigo-500/60 focus:bg-white/[0.05] transition disabled:opacity-40 disabled:cursor-not-allowed"
              placeholder="+254..." />
            <p id="daf-phone-lock-note" class="hidden text-[10px] text-white/25">Phone number is locked after creation — it's tied to this driver's login.</p>
          </div>

          <!-- EMAIL -->
          <div class="space-y-2">
            <label class="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Email</label>
            <input id="daf-email" type="email"
              class="w-full h-14 px-5 bg-white/[0.035] border border-white/10 rounded-2xl text-white text-sm outline-none focus:border-indigo-500/60 focus:bg-white/[0.05] transition"
              placeholder="driver@example.com" />
          </div>

          <!-- VEHICLE -->
          <div class="space-y-3 text-center">
            <label class="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Vehicle Type</label>
            <div class="flex flex-wrap justify-center gap-2" id="vehicle-chip-group">
              ${Object.entries(VEHICLE_ICONS).map(([type, icon]) => `
                <button type="button" data-vehicle="${type}"
                  class="vehicle-chip text-xs px-4 py-2 rounded-full border border-white/10 bg-white/[0.02] text-white/60 hover:border-indigo-500/40 hover:text-white transition">
                  ${icon} ${type}
                </button>`).join("")}
            </div>
            <input type="hidden" id="daf-vehicle" />
          </div>

          <!-- PLATE -->
          <div class="space-y-2">
            <input id="daf-plate" type="text"
              class="w-full h-14 px-5 bg-white/[0.035] border border-white/10 rounded-2xl text-white text-sm outline-none focus:border-indigo-500/60 focus:bg-white/[0.05] transition uppercase"
              placeholder="Plate Number" />
          </div>

          <!-- ID -->
          <div class="space-y-2">
            <input id="daf-id-number" type="text"
              class="w-full h-14 px-5 bg-white/[0.035] border border-white/10 rounded-2xl text-white text-sm outline-none focus:border-indigo-500/60 focus:bg-white/[0.05] transition"
              placeholder="National ID" />
          </div>

          <!-- GENDER -->
          <div class="space-y-3">
            <label class="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Gender</label>
            <div class="grid grid-cols-3 gap-3" id="gender-group">
              <button type="button" data-gender="male" class="gender-chip w-full h-12 rounded-2xl border border-white/10 bg-white/[0.02] text-white/60 text-sm font-semibold hover:border-indigo-500/40 transition">👨 Male</button>
              <button type="button" data-gender="female" class="gender-chip w-full h-12 rounded-2xl border border-white/10 bg-white/[0.02] text-white/60 text-sm font-semibold hover:border-indigo-500/40 transition">👩 Female</button>
              <button type="button" data-gender="other" class="gender-chip w-full h-12 rounded-2xl border border-white/10 bg-white/[0.02] text-white/60 text-sm font-semibold hover:border-indigo-500/40 transition">⚧ Other</button>
            </div>
            <input type="hidden" id="daf-gender" />
          </div>

          <!-- NOTE -->
          <div class="space-y-2">
            <label class="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Note</label>
            <textarea id="daf-note"
              class="w-full px-5 py-4 bg-white/[0.035] border border-white/10 rounded-2xl text-white text-sm outline-none focus:border-indigo-500/60 focus:bg-white/[0.05] resize-none h-28 transition"
              placeholder="Extra info..."></textarea>
          </div>

          <!-- ACTIONS -->
          <div class="flex flex-col gap-3 pt-4">
            <button type="submit" id="daf-submit-btn"
              class="w-full h-14 bg-white hover:bg-slate-200 text-black font-extrabold rounded-2xl text-sm transition-all active:scale-[0.98] flex items-center justify-center gap-2">
              <span id="daf-submit-text">Add Driver</span>
              <svg id="daf-spinner" class="hidden w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
            </button>
            <button type="button" id="cancel-driver-modal"
              class="w-full h-12 rounded-2xl bg-white/5 text-white/60 text-sm font-semibold hover:bg-white/10 transition">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  `);

  // ---- Vehicle chips ----
  document.getElementById("vehicle-chip-group")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".vehicle-chip");
    if (!chip) return;
    document.querySelectorAll(".vehicle-chip").forEach(c => {
      c.classList.remove("border-indigo-500/50", "bg-indigo-500/10", "text-indigo-300");
      c.classList.add("border-white/10", "bg-white/[0.02]", "text-white/60");
    });
    chip.classList.add("border-indigo-500/50", "bg-indigo-500/10", "text-indigo-300");
    chip.classList.remove("border-white/10", "bg-white/[0.02]", "text-white/60");
    document.getElementById("daf-vehicle").value = chip.dataset.vehicle;
  });

  // ---- Gender chips ----
  document.getElementById("gender-group")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".gender-chip");
    if (!btn) return;
    document.querySelectorAll(".gender-chip").forEach(b => {
      b.classList.remove("border-indigo-500/50", "bg-indigo-500/10", "text-indigo-300");
      b.classList.add("border-white/10", "bg-white/[0.02]", "text-white/60");
    });
    btn.classList.add("border-indigo-500/50", "bg-indigo-500/10", "text-indigo-300");
    btn.classList.remove("border-white/10", "bg-white/[0.02]", "text-white/60");
    document.getElementById("daf-gender").value = btn.dataset.gender;
  });

  // ---- Close buttons ----
  document.getElementById("close-driver-modal")?.addEventListener("click", () => closeModal("driver-add-overlay"));
  document.getElementById("cancel-driver-modal")?.addEventListener("click", () => closeModal("driver-add-overlay"));

  // ---- Overlay backdrop click ----
  document.getElementById("driver-add-overlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("driver-add-overlay")) closeModal("driver-add-overlay");
  });

  // ---- Plate uppercase ----
  document.getElementById("daf-plate")?.addEventListener("input", e => {
    const start = e.target.selectionStart;
    e.target.value = e.target.value.toUpperCase();
    e.target.setSelectionRange(start, start);
  });

  // ---- Image handling ----
  const imageInput = document.getElementById("daf-image-input");
  const previewImg = document.getElementById("daf-image-preview");
  const placeholder = document.getElementById("daf-image-placeholder");
  const previewArea = document.getElementById("daf-image-click-area");
  const removeImageBtn = document.getElementById("daf-remove-image-btn");

  function applyImagePreview(dataUrl) {
    driverImageData = dataUrl;
    previewImg.src = dataUrl;
    previewImg.classList.remove("hidden");
    placeholder.classList.add("hidden");
    removeImageBtn.classList.remove("hidden");
    previewArea.classList.add("border-indigo-500/30");
  }

  function clearImagePreview() {
    driverImageData = null;
    imageInput.value = "";
    previewImg.src = "";
    previewImg.classList.add("hidden");
    placeholder.classList.remove("hidden");
    removeImageBtn.classList.add("hidden");
    previewArea.classList.remove("border-indigo-500/30");
  }

  previewArea?.addEventListener("click", () => imageInput?.click());
  removeImageBtn?.addEventListener("click", (e) => { e.stopPropagation(); clearImagePreview(); });

  imageInput?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) {
      window.showNotif?.({ type: "warning", title: "Large Image", message: "Image will be compressed." });
    }
    const reader = new FileReader();
    reader.onload = (ev) => applyImagePreview(ev.target.result);
    reader.readAsDataURL(file);
  });

  // Expose image setter for edit mode
  window._setDriverImageData = (data) => {
    if (data) applyImagePreview(data);
    else clearImagePreview();
  };

  // ---- Form submit ----
  bindDriverForm();
}

// =========================
// SKELETON CARD
// =========================
function driverSkeleton() {
  return `
    <div class="w-full max-w-xs bg-[#111318] rounded-2xl border border-white/5 p-5 animate-pulse">
      <div class="flex items-center gap-3 mb-4">
        <div class="w-12 h-12 rounded-2xl bg-white/5 shrink-0"></div>
        <div class="flex-1 space-y-2">
          <div class="h-3.5 bg-white/5 rounded-lg w-3/5"></div>
          <div class="h-2.5 bg-white/5 rounded-lg w-2/5"></div>
        </div>
      </div>
      <div class="space-y-2 mb-4">
        <div class="h-2.5 bg-white/5 rounded w-full"></div>
        <div class="h-2.5 bg-white/5 rounded w-4/5"></div>
      </div>
      <div class="h-8 bg-white/5 rounded-xl"></div>
    </div>`;
}

// =========================
// LOAD DRIVERS TAB
// =========================
window.loadDriversTab = function () {
  const vendorId = window.vendorId;
  if (!vendorId) return;

  injectDriverModals();
  bindAddDriverBtn();

  if (driversUnsub) driversUnsub();

  const grid = document.getElementById("drivers-grid");
  const empty = document.getElementById("drivers-empty");

  if (grid) grid.innerHTML = [1, 2, 3, 4].map(() => driverSkeleton()).join("");
  empty?.classList.add("hidden");

  const q = query(
    collection(db, "drivers"),
    where("vendor_id", "==", vendorId),
    orderBy("createdAt", "desc")
  );

  driversUnsub = onSnapshot(q, async (snap) => {
    // Enrich ALL drivers with order counts in parallel — no sequential loop
    allDrivers = await Promise.all(
      snap.docs.map(async (d) => {
        const driver = { id: d.id, ...d.data() };
        try {
          const ordersSnap = await getDocs(query(
            collection(db, "orders"),
            where("driverId", "==", driver.id)
          ));
          driver._totalDeliveries = ordersSnap.size;
          driver._activeDeliveries = ordersSnap.docs.filter(o =>
            !TERMINAL_STATUSES.has(o.data().status)
          ).length;
        } catch(error) {
          console.error(`Failed to fetch order counts for driver ${driver.id}:`, error);
          driver._totalDeliveries = 0;
          driver._activeDeliveries = 0;
        }
        return driver;
      })
    );

    renderDrivers();
  }, (err) => {
    console.error("Drivers listener error:", err);
    if (grid) grid.innerHTML = `
      <div class="col-span-full text-center py-16">
        <p class="text-3xl mb-3">⚠️</p>
        <p class="text-sm text-red-400">Failed to load drivers.</p>
        <button onclick="window.loadDriversTab()" class="mt-3 text-xs text-indigo-400 hover:underline">Retry</button>
      </div>`;
  });
};

// =========================
// RENDER ALL DRIVERS
// =========================
function renderDrivers() {
  const grid = document.getElementById("drivers-grid");
  const empty = document.getElementById("drivers-empty");
  if (!grid) return;

  if (allDrivers.length === 0) {
    grid.innerHTML = "";
    empty?.classList.remove("hidden");
    return;
  }

  empty?.classList.add("hidden");
  renderDriversSummaryBar();

  // Build all cards in a fragment — single DOM write
  const fragment = document.createDocumentFragment();
  allDrivers.forEach((driver, i) => fragment.appendChild(buildDriverCard(driver, i)));
  grid.innerHTML = "";
  grid.appendChild(fragment);
}

// =========================
// SUMMARY BAR
// =========================
function renderDriversSummaryBar() {
  document.getElementById("drivers-summary-bar")?.remove();

  const free = allDrivers.filter(d => d.status === "free").length;
  const onRoad = allDrivers.filter(d => d.status === "on-road").length;
  const offDuty = allDrivers.filter(d => d.status === "off-duty").length;

  const bar = document.createElement("div");
  bar.id = "drivers-summary-bar";
  bar.className = "grid grid-cols-4 gap-3 mb-6";
  bar.innerHTML = `
    <div class="bg-white/[0.03] border border-white/5 rounded-2xl p-4 flex flex-col gap-1">
      <p class="text-[9px] font-bold text-white/25 uppercase tracking-widest">Total</p>
      <p class="text-2xl font-black text-white">${allDrivers.length}</p>
    </div>
    <div class="bg-emerald-500/8 border border-emerald-500/15 rounded-2xl p-4 flex flex-col gap-1">
      <p class="text-[9px] font-bold text-emerald-500/60 uppercase tracking-widest">Available</p>
      <p class="text-2xl font-black text-emerald-400">${free}</p>
    </div>
    <div class="bg-orange-500/8 border border-orange-500/15 rounded-2xl p-4 flex flex-col gap-1">
      <p class="text-[9px] font-bold text-orange-500/60 uppercase tracking-widest">On Road</p>
      <p class="text-2xl font-black text-orange-400">${onRoad}</p>
    </div>
    <div class="bg-white/[0.03] border border-white/5 rounded-2xl p-4 flex flex-col gap-1">
      <p class="text-[9px] font-bold text-white/25 uppercase tracking-widest">Off Duty</p>
      <p class="text-2xl font-black text-white/40">${offDuty}</p>
    </div>`;

  document.getElementById("drivers-grid")?.parentElement?.insertBefore(
    bar,
    document.getElementById("drivers-grid")
  );
}

// =========================
// BUILD DRIVER CARD (returns element)
// =========================
function buildDriverCard(driver, index = 0) {
  const status = driver.status || "free";
  const statusInfo = DRIVER_STATUS[status] || DRIVER_STATUS.free;
  const vehicleIcon = getVehicleIcon(driver.vehicleType);
  const isOnRoad = status === "on-road";

  const card = document.createElement("div");
  card.className = "w-full max-w-xs bg-[#111318] border border-white/5 rounded-2xl overflow-hidden hover:border-white/10 transition-all duration-300 cursor-pointer group flex flex-col driver-card";
  card.dataset.driverId = driver.id;
  card.style.cssText = `opacity:0;transform:translateY(28px);transition:opacity 0.4s ease,transform 0.4s cubic-bezier(0.22,1,0.36,1);transition-delay:${index * 55}ms;`;

  requestAnimationFrame(() => requestAnimationFrame(() => {
    card.style.opacity = "1";
    card.style.transform = "translateY(0)";
  }));

  card.innerHTML = `
    <div class="h-1 w-full ${status === 'free' ? 'bg-emerald-500' : status === 'on-road' ? 'bg-orange-500 animate-pulse' : 'bg-white/10'}"></div>

    <div class="p-5 flex-1 flex flex-col gap-4">
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-3">
          <div class="relative w-12 h-12 rounded-2xl bg-gradient-to-br
            ${status === 'free' ? 'from-emerald-500/20 to-teal-500/10 border-emerald-500/20'
              : status === 'on-road' ? 'from-orange-500/20 to-amber-500/10 border-orange-500/20'
              : 'from-white/5 to-white/[0.02] border-white/8'}
            border flex items-center justify-center text-2xl shrink-0 transition-all duration-300">
            ${vehicleIcon}
            ${isOnRoad ? `<span class="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-orange-400 border-2 border-[#111318] animate-pulse"></span>` : ''}
            ${status === 'free' ? `<span class="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-400 border-2 border-[#111318]"></span>` : ''}
          </div>
          <div class="min-w-0">
            <h3 class="text-sm font-bold text-white truncate group-hover:text-indigo-300 transition-colors">${escHTML(driver.name)}</h3>
            <p class="text-[10px] text-white/30 mt-0.5 truncate">${escHTML(driver.vehicleType || 'Driver')}${driver.plateNumber ? ' · ' + escHTML(driver.plateNumber) : ''}</p>
          </div>
        </div>
        <span class="shrink-0 text-[9px] px-2.5 py-1 rounded-full font-semibold border ${statusInfo.color}">${statusInfo.label}</span>
      </div>

      <div class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between">
          <span class="text-[10px] text-white/25">📱 Phone</span>
          <a href="tel:${escHTML(driver.phone)}" class="text-[10px] text-indigo-400 hover:text-indigo-300 transition phone-link">${escHTML(driver.phone || '—')}</a>
        </div>
        ${driver.email ? `
          <div class="flex items-center justify-between">
            <span class="text-[10px] text-white/25">✉️ Email</span>
            <span class="text-[10px] text-white/45 truncate max-w-[140px]">${escHTML(driver.email)}</span>
          </div>` : ''}
      </div>

      <div class="grid grid-cols-2 gap-2">
        <div class="bg-white/[0.025] rounded-xl px-3 py-2.5 text-center border border-white/[0.04]">
          <p class="text-base font-black text-white">${driver._totalDeliveries ?? '—'}</p>
          <p class="text-[9px] text-white/25 uppercase tracking-wider mt-0.5">Total</p>
        </div>
        <div class="bg-white/[0.025] rounded-xl px-3 py-2.5 text-center border border-white/[0.04]">
          <p class="text-base font-black ${driver._activeDeliveries > 0 ? 'text-orange-400' : 'text-white'}">${driver._activeDeliveries ?? '—'}</p>
          <p class="text-[9px] text-white/25 uppercase tracking-wider mt-0.5">Active</p>
        </div>
      </div>

      ${driver.note ? `
        <p class="text-[10px] text-white/30 italic leading-relaxed line-clamp-2 border-t border-white/5 pt-3">
          "${escHTML(driver.note)}"
        </p>` : ''}

      <!-- Status toggle — event delegation on the row -->
      <div class="status-btn-row flex gap-1.5 pt-1 border-t border-white/5 mt-auto">
        ${Object.entries(DRIVER_STATUS).map(([key, val]) => {
          // Only show vendor-controllable statuses (free and off-duty)
          if (!VENDOR_CONTROLLABLE_STATUSES.has(key)) return '';
          
          const isActive = status === key;
          const isAllowed = isVendorStatusChangeAllowed(status, key);
          
          return `
            <button class="status-quick-btn flex-1 py-1.5 rounded-lg text-[9px] font-bold border transition-all duration-200
              ${isActive ? val.color + ' opacity-100' : isAllowed ? 'border-white/5 bg-white/[0.02] text-white/20 hover:text-white/50 hover:border-white/10 cursor-pointer' : 'border-white/5 bg-white/[0.02] text-white/10 cursor-not-allowed opacity-50'}"
              data-status="${key}"
              ${isAllowed ? '' : 'disabled'}>
              ${val.label}
            </button>`;
        }).join("")}
      </div>
    </div>`;

  // Open detail on card click (excluding phone links and status buttons)
  card.addEventListener("click", (e) => {
    if (e.target.closest(".phone-link") || e.target.closest(".status-btn-row")) return;
    openDriverDetail(driver);
  });

  // Status button delegation — one listener on the row
  card.querySelector(".status-btn-row")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const btn = e.target.closest(".status-quick-btn");
    if (!btn || btn.disabled) return;
    
    const newStatus = btn.dataset.status;
    
    // Validate transition is allowed
    if (!isVendorStatusChangeAllowed(status, newStatus)) {
      window.showNotif?.({
        type: "warning",
        title: "Cannot Change Status",
        message: "You can only toggle between Available and Off Duty statuses."
      });
      return;
    }

    // Optimistic update
    const prevStatus = driver.status;
    driver.status = newStatus;
    renderDrivers();

    try {
      await updateDoc(doc(db, "drivers", driver.id), {
        status: newStatus,
        updatedAt: serverTimestamp()
      });
      window.showNotif?.({
        type: "success",
        title: "Status Updated",
        message: `${driver.name} is now ${DRIVER_STATUS[newStatus]?.label}.`
      });
    } catch {
      driver.status = prevStatus;
      renderDrivers();
      window.showNotif?.({ type: "error", title: "Failed", message: "Could not update driver status." });
    }
  });

  return card;
}

// =========================
// DRIVER DETAIL SHEET
// =========================
function openDriverDetail(driver) {
  const overlay = document.getElementById("driver-detail-overlay");
  const panel = overlay?.querySelector("[data-detail-panel]");
  if (!overlay || !panel) return;

  const status = driver.status || "free";
  const statusInfo = DRIVER_STATUS[status] || DRIVER_STATUS.free;

  panel.innerHTML = `
    <div class="relative h-44 bg-gradient-to-br from-white/[0.05] to-white/[0.02] flex items-center justify-center overflow-hidden">
      ${driver.image
        ? `<img src="${driver.image}" class="w-full h-full object-cover" />`
        : `<div class="text-6xl opacity-60">${getVehicleIcon(driver.vehicleType)}</div>`
      }
      <div class="absolute inset-0 bg-black/40"></div>
      <div class="absolute top-4 right-4 px-3 py-1 rounded-full text-[10px] font-bold border ${statusInfo.color}">
        ${statusInfo.icon} ${statusInfo.label}
      </div>
      <button id="close-detail-top" class="absolute top-4 left-4 w-8 h-8 rounded-full bg-black/40 flex items-center justify-center text-white/80 hover:bg-black/60 transition text-sm">✕</button>
    </div>

    <div class="p-5 space-y-5 text-white">
      <div class="text-center">
        <h2 class="text-xl font-extrabold">${escHTML(driver.name || "Unknown Driver")}</h2>
        <p class="text-xs text-white/40 mt-1">${driver.vehicleType ? `${getVehicleIcon(driver.vehicleType)} ${driver.vehicleType}` : "—"}</p>
        ${driver.gender ? `<p class="text-[10px] text-white/30 mt-0.5">${driver.gender === 'male' ? '👨 Male' : driver.gender === 'female' ? '👩 Female' : '⚧ Other'}</p>` : ''}
      </div>

      <div class="grid grid-cols-3 gap-2">
        <div class="bg-white/[0.03] rounded-xl p-3 text-center">
          <p class="text-lg font-black">${driver._totalDeliveries ?? 0}</p>
          <p class="text-[9px] text-white/30">Total</p>
        </div>
        <div class="bg-white/[0.03] rounded-xl p-3 text-center">
          <p class="text-lg font-black text-orange-400">${driver._activeDeliveries ?? 0}</p>
          <p class="text-[9px] text-white/30">Active</p>
        </div>
        <div class="bg-white/[0.03] rounded-xl p-3 text-center">
          <p class="text-lg font-black text-indigo-300">${driver.rating ? driver.rating.toFixed(1) : "N/A"}</p>
          <p class="text-[9px] text-white/30">Rating</p>
        </div>
      </div>

      <div class="space-y-2 text-sm">
        <div class="flex justify-between text-white/50">
          <span>📱 Phone</span>
          <a href="tel:${escHTML(driver.phone || '')}" class="text-indigo-400">${escHTML(driver.phone || '—')}</a>
        </div>
        <div class="flex justify-between text-white/50">
          <span>✉️ Email</span>
          <span class="text-white/70 truncate max-w-[180px]">${escHTML(driver.email || '—')}</span>
        </div>
        <div class="flex justify-between text-white/50">
          <span>🚗 Plate</span>
          <span class="text-white/70 font-mono uppercase">${escHTML(driver.plateNumber || '—')}</span>
        </div>
        <div class="flex justify-between text-white/50">
          <span>🪪 ID</span>
          <span class="text-white/70">${escHTML(driver.idNumber || '—')}</span>
        </div>
      </div>

      ${driver.note ? `
        <div class="bg-white/[0.03] border border-white/5 rounded-xl p-3 text-xs text-white/60 italic">
          "${escHTML(driver.note)}"
        </div>` : ''}

      <div class="flex gap-2 pt-2">
        <button id="detail-edit-btn" class="flex-1 h-10 rounded-xl bg-indigo-500/15 text-indigo-300 text-xs font-bold hover:bg-indigo-500/25 border border-indigo-500/15 transition">✏️ Edit</button>
        <button id="detail-delete-btn" class="px-4 h-10 rounded-xl bg-red-500/10 text-red-400 text-xs font-bold hover:bg-red-500/20 border border-red-500/10 transition">🗑️ Remove</button>
      </div>
    </div>`;

  overlay.classList.remove("hidden");
  requestAnimationFrame(() => {
    overlay.style.opacity = "1";
    panel.classList.remove("scale-95", "translate-y-6");
  });

  function closeDetail() {
    overlay.style.opacity = "0";
    panel.classList.add("scale-95", "translate-y-6");
    setTimeout(() => overlay.classList.add("hidden"), 250);
    overlay.onclick = null;
  }

  document.getElementById("close-detail-top")?.addEventListener("click", closeDetail);
  overlay.onclick = (e) => { if (e.target === overlay) closeDetail(); };

  document.getElementById("detail-edit-btn")?.addEventListener("click", () => {
    closeDetail();
    setTimeout(() => openDriverForm(driver), 300);
  });
  document.getElementById("detail-delete-btn")?.addEventListener("click", () => {
    closeDetail();
    setTimeout(() => confirmDeleteDriver(driver), 300);
  });
}

// =========================
// OPEN DRIVER FORM
// =========================
function openDriverForm(driver = null) {
  editingDriverId = driver?.id || null;

  document.getElementById("driver-modal-heading").textContent = driver ? "Edit Driver" : "Add Driver";
  document.getElementById("daf-submit-text").textContent = driver ? "Update Driver" : "Add Driver";

  setVal("daf-id", driver?.id || "");
  setVal("daf-name", driver?.name || "");
  setVal("daf-phone", driver?.phone || "");
  setVal("daf-email", driver?.email || "");
  setVal("daf-vehicle", driver?.vehicleType || "");
  setVal("daf-plate", driver?.plateNumber || "");
  setVal("daf-id-number", driver?.idNumber || "");
  setVal("daf-note", driver?.note || "");
  setVal("daf-gender", driver?.gender || "");

  // Phone is locked once a driver exists — it's tied to their login (auth email is derived from it)
  const phoneInput = document.getElementById("daf-phone");
  const phoneLockNote = document.getElementById("daf-phone-lock-note");
  if (phoneInput) phoneInput.disabled = !!driver;
  phoneLockNote?.classList.toggle("hidden", !driver);

  // Vehicle chips
  document.querySelectorAll(".vehicle-chip").forEach(chip => {
    const active = chip.dataset.vehicle === driver?.vehicleType;
    chip.classList.toggle("border-indigo-500/50", active);
    chip.classList.toggle("bg-indigo-500/10", active);
    chip.classList.toggle("text-indigo-300", active);
    chip.classList.toggle("border-white/10", !active);
    chip.classList.toggle("bg-white/[0.02]", !active);
    chip.classList.toggle("text-white/60", !active);
  });

  // Gender chips
  document.querySelectorAll(".gender-chip").forEach(btn => {
    const active = btn.dataset.gender === driver?.gender;
    btn.classList.toggle("border-indigo-500/50", active);
    btn.classList.toggle("bg-indigo-500/10", active);
    btn.classList.toggle("text-indigo-300", active);
    btn.classList.toggle("border-white/10", !active);
    btn.classList.toggle("bg-white/[0.02]", !active);
    btn.classList.toggle("text-white/60", !active);
  });

  // Image
  window._setDriverImageData?.(driver?.image || null);

  openModal("driver-add-overlay");
  setTimeout(() => document.getElementById("daf-name")?.focus(), 350);
}

// =========================
// BIND ADD DRIVER BUTTON
// =========================
function bindAddDriverBtn() {
  const btn = document.getElementById("add-driver-btn");
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => openDriverForm(null));
  }
}

// =========================
// BIND DRIVER FORM SUBMIT (once)
// =========================
function bindDriverForm() {
  const form = document.getElementById("driver-add-form");
  if (!form || form.dataset.bound) return;
  form.dataset.bound = "1";

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!window.vendorId) return;

    const name = document.getElementById("daf-name")?.value.trim();
    const phone = document.getElementById("daf-phone")?.value.trim();
    const email = document.getElementById("daf-email")?.value.trim();
    const vehicleType = document.getElementById("daf-vehicle")?.value.trim();
    const plateNumber = document.getElementById("daf-plate")?.value.trim().toUpperCase();
    const idNumber = document.getElementById("daf-id-number")?.value.trim();
    const note = document.getElementById("daf-note")?.value.trim();
    const gender = document.getElementById("daf-gender")?.value.trim();

    if (!name) {
      window.showNotif?.({ type: "error", title: "Name required", message: "Please enter the driver's full name." });
      document.getElementById("daf-name")?.focus();
      return;
    }
    if (!phone) {
      window.showNotif?.({ type: "error", title: "Phone required", message: "Please enter a phone number." });
      document.getElementById("daf-phone")?.focus();
      return;
    }
    if (!gender) {
      window.showNotif?.({ type: "error", title: "Gender required", message: "Please select driver gender." });
      return;
    }

    const submitBtn = document.getElementById("daf-submit-btn");
    const submitText = document.getElementById("daf-submit-text");
    const spinner = document.getElementById("daf-spinner");

    submitBtn.disabled = true;
    submitText.textContent = editingDriverId ? "Updating…" : "Adding…";
    spinner.classList.remove("hidden");

    const payload = {
      vendor_id: window.vendorId,
      name,
      email: email || "",
      gender,
      vehicleType: vehicleType || "",
      plateNumber: plateNumber || "",
      note: note || "",
      image: driverImageData || "",
      updatedAt: serverTimestamp()
    };

    try {
      if (editingDriverId) {
        // phone is intentionally NOT included in payload here — it's locked post-creation
        await updateDoc(doc(db, "drivers", editingDriverId), payload);
        // Invalidate cache for this driver
        _docCache.delete(`drivers/${editingDriverId}`);
        window.showNotif?.({ type: "success", title: "Updated", message: `${name} has been updated.` });
      } else {
        // one auth account per phone number
        if (await isPhoneTaken(phone)) {
          throw new Error("A driver with this phone number already exists.");
        }

        submitText.textContent = "Creating login…";
        const { uid, pin } = await createDriverAuthAccount(phone);

        payload.phone = normalizePhone(phone); // keep stored phone consistent with the login email
        payload.status = "not-active";  // driver must set their own PIN on first login
        payload.driverLoginActivated = false;  // forces a PIN reset on first login
        payload.assignedClientIds = [];        // populated via arrayUnion when orders are assigned
        payload.createdAt = serverTimestamp();
        payload.totalDeliveries = 0;
        payload.activeDeliveries = 0;
        // doc ID = auth uid, so security rules can check driver_id == request.auth.uid
        await setDoc(doc(db, "drivers", uid), payload);

        // Fire ID doc write in background — don't block the UX
        setDoc(doc(db, "driverIDs", uid), {
          driverId: uid,
          vendor_id: window.vendorId,
          nationalId: idNumber || "",
          createdAt: serverTimestamp()
        }).catch(err => console.warn("driverIDs write failed:", err));

        // show the PIN ONCE — vendor relays it via WhatsApp/SMS themselves, not stored anywhere
        window.showDialog?.({
          type: "success",
          emoji: "🔑",
          tag: "Driver added",
          title: `Share this PIN with ${name}`,
          message: `Phone: ${payload.phone}\nPIN: <span class="font-bold color-primary"> ${pin} </span>\n\nThey'll be asked to set their own PIN on first login.`,
          actions: [{ label: "Got it", style: "primary", onClick: () => {} }]
        });
      }

      closeModal("driver-add-overlay");
      editingDriverId = null;
    } catch (err) {
      console.error("Driver save failed:", err);
      window.showNotif?.({ type: "error", title: "Failed", message: err.message || "Could not save driver." });
    } finally {
      submitBtn.disabled = false;
      submitText.textContent = editingDriverId ? "Update Driver" : "Add Driver";
      spinner.classList.add("hidden");
    }
  });
}

// =========================
// DELETE DRIVER
// =========================
function confirmDeleteDriver(driver) {
  const doDelete = async () => {
    window.showLoadingDots?.("Removing driver…");
    try {
      await deleteDoc(doc(db, "drivers", driver.id));
      _docCache.delete(`drivers/${driver.id}`);
      window.hideLoadingDots?.();
      window.showNotif?.({ type: "success", title: "Removed", message: `${driver.name} has been removed.` });
    } catch {
      window.hideLoadingDots?.();
      window.showNotif?.({ type: "error", title: "Failed", message: "Could not remove driver." });
    }
  };

  if (typeof window.showDialog === "function") {
    window.showDialog({
      type: "danger", emoji: "🗑️", tag: "Remove Driver",
      title: `Remove "${driver.name}"?`,
      message: "This will permanently remove this driver from your team. Past orders will retain the driver's name.",
      actions: [
        { label: "Yes, remove", style: "danger", onClick: doDelete },
        { label: "Cancel", style: "secondary", onClick: () => {} }
      ]
    });
  } else {
    if (!confirm(`Remove "${driver.name}" from your team?`)) return;
    doDelete();
  }
}
