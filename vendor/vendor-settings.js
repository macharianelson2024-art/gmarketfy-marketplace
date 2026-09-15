// ============================================
// VENDOR DASHBOARD — SETTINGS TAB
// ============================================

import {
  db, doc, getDoc, updateDoc,
  serverTimestamp
} from './firebase-config.js';

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

function getVal(id) {
  return document.getElementById(id)?.value?.trim() || "";
}

// =========================
// STATE
// =========================
let hasPhysicalStore = false;
let deliveryEnabled = false;
let deliveryMode = "static";
let storeActive = true;
let isSaving = false;

// =========================
// LOAD SETTINGS
// =========================
window.loadSettingsTab = async function() {
  const vendorId = window.vendorId;
  if (!vendorId) return;

  // Show loader
  const settingsContainer = document.querySelector("#tabs-wrapper .tab:nth-child(6)");
  if (!settingsContainer) return;

  try {
    const snap = await getDoc(doc(db, "vendors", vendorId));
    if (!snap.exists()) return;

    const v = snap.data();

    // ---- Store Profile ----
    setVal("set-storeName", v.storeName || "");
    setVal("set-category", v.category || "");
    setVal("set-email", v.email || "");
    setVal("set-phone", v.phone || "");
    setVal("set-currency", v.currency || "KSh");
    setVal("set-payout", v.payoutMethod || "");
    setVal("set-description", v.storeDescription || "");

    // ---- Physical Store ----
    hasPhysicalStore = v.hasPhysicalStore || false;
    updatePhysicalStoreUI();

    if (hasPhysicalStore && v.address) {
      setVal("set-street", v.address.street || "");
      setVal("set-city", v.address.city || "");
      setVal("set-state", v.address.state || "");
      setVal("set-country", v.address.country || "");
      setVal("set-building", v.address.building || "");
      setVal("set-postal", v.address.postalCode || "");
    }

    // ---- Delivery ----
    deliveryEnabled = v.delivery?.enabled || false;
    deliveryMode = v.delivery?.mode || "static";
    updateDeliveryUI();

    if (deliveryEnabled) {
      setVal("set-delivery-fee", v.delivery?.fee || "");
      document.querySelectorAll(".delivery-mode-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.mode === deliveryMode);
      });
    }

    // ---- Visibility ----
    storeActive = v.isActive !== false;
    updateVisibilityUI();

  } catch (e) {
    console.error("Settings load failed:", e);
    window.showNotif?.({ type: "error", title: "Failed", message: "Could not load settings." });
  }
};

// =========================
// TOGGLE: PHYSICAL STORE
// =========================
function updatePhysicalStoreUI() {
  const toggle = document.getElementById("physical-store-toggle");
  const knob = document.getElementById("physical-store-knob");
  const fields = document.getElementById("physical-address-fields");

  if (!toggle || !knob || !fields) return;

  if (hasPhysicalStore) {
    toggle.classList.add("toggle-active");
    knob.classList.add("toggle-knob");
    fields.classList.remove("hidden");
  } else {
    toggle.classList.remove("toggle-active");
    knob.classList.remove("toggle-knob");
    fields.classList.add("hidden");
  }
}

document.getElementById("physical-store-toggle")?.addEventListener("click", () => {
  hasPhysicalStore = !hasPhysicalStore;
  updatePhysicalStoreUI();
});

// =========================
// TOGGLE: DELIVERY
// =========================
function updateDeliveryUI() {
  const toggle = document.getElementById("delivery-toggle");
  const knob = document.getElementById("delivery-knob");
  const options = document.getElementById("delivery-options");

  if (!toggle || !knob || !options) return;

  if (deliveryEnabled) {
    toggle.classList.add("toggle-active");
    knob.classList.add("toggle-knob");
    options.classList.remove("hidden");
  } else {
    toggle.classList.remove("toggle-active");
    knob.classList.remove("toggle-knob");
    options.classList.add("hidden");
  }
}

document.getElementById("delivery-toggle")?.addEventListener("click", () => {
  deliveryEnabled = !deliveryEnabled;
  updateDeliveryUI();
});

// =========================
// DELIVERY MODE BUTTONS
// =========================
document.querySelectorAll(".delivery-mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    deliveryMode = btn.dataset.mode;
    document.querySelectorAll(".delivery-mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
  });
});

// =========================
// TOGGLE: VISIBILITY
// =========================
function updateVisibilityUI() {
  const toggle = document.getElementById("visibility-toggle");
  const knob = document.getElementById("visibility-knob");
  const label = document.getElementById("visibility-label");

  if (!toggle || !knob || !label) return;

  if (storeActive) {
    toggle.classList.add("toggle-active");
    knob.classList.add("translate-x-6", "bg-indigo-400");
    knob.classList.remove("bg-slate-400");
    label.textContent = "Your store is currently active";
  } else {
    toggle.classList.remove("toggle-active");
    knob.classList.remove("translate-x-6", "bg-indigo-400");
    knob.classList.add("bg-slate-400");
    label.textContent = "Your store is currently hidden";
  }
}

document.getElementById("visibility-toggle")?.addEventListener("click", () => {
  storeActive = !storeActive;
  updateVisibilityUI();
});

// =========================
// SAVE ALL SETTINGS
// =========================
document.getElementById("save-settings-btn")?.addEventListener("click", async () => {
  const vendorId = window.vendorId;
  if (!vendorId || isSaving) return;

  const btn = document.getElementById("save-settings-btn");
  isSaving = true;
  btn.disabled = true;
  btn.textContent = "Saving...";
  window.showLoadingDots?.("Saving settings...");

  try {
    // Read all fields
    const storeName = getVal("set-storeName");
    const category = getVal("set-category");
    const email = getVal("set-email");
    const phone = getVal("set-phone");
    const currency = getVal("set-currency");
    const payoutMethod = getVal("set-payout");
    const storeDescription = getVal("set-description");

    const deliveryFee = parseFloat(getVal("set-delivery-fee")) || 0;

    // Build address if physical store enabled
    let address = null;
    if (hasPhysicalStore) {
      address = {
        street: getVal("set-street"),
        city: getVal("set-city"),
        state: getVal("set-state"),
        country: getVal("set-country"),
        building: getVal("set-building"),
        postalCode: getVal("set-postal")
      };
    }

    // Build update payload
    const updates = {
      storeName,
      category,
      email,
      phone,
      currency,
      payoutMethod,
      storeDescription,
      hasPhysicalStore,
      isActive: storeActive,
      delivery: {
        enabled: deliveryEnabled,
        mode: deliveryMode,
        fee: deliveryFee,
        type: "internal"
      },
      updatedAt: serverTimestamp()
    };

    // Only include address if physical store is enabled
    if (hasPhysicalStore && address) {
      updates.address = address;
    }

    await updateDoc(doc(db, "vendors", vendorId), updates);

    // Update cached data
    if (window.vendorData) {
      Object.assign(window.vendorData, updates);
    }

    window.hideLoadingDots?.();
    window.showNotif?.({
      type: "success",
      title: "Settings Saved",
      message: "Your store settings have been updated successfully."
    });

  } catch (e) {
    console.error("Settings save failed:", e);
    window.hideLoadingDots?.();
    window.showNotif?.({
      type: "error",
      title: "Save Failed",
      message: e.message || "Could not save settings. Please try again."
    });
  } finally {
    isSaving = false;
    btn.disabled = false;
    btn.textContent = "Save All Settings";
  }
});

// =========================
// INIT: Bind tab activation
// =========================
// The shell calls window.loadSettingsTab when tab is switched to index 5