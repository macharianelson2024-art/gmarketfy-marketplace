import {
  db,
  collection,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  getDocs,
  Timestamp,
  getDoc,
  doc,
  addDoc,
  updateDoc,
  increment,
  serverTimestamp,
  onAuthStateChanged,
  auth,
  signInWithEmailAndPassword,
  signOut,
  setDoc,
  updateProfile,
  createUserWithEmailAndPassword,
  deleteDoc,
  onSnapshot
} from './firebase-config.js'

import { openLocationPickerModal } from './location-picker-modal.js';

let summaryMessage = ""
let addressDraft = {}

let completeAddress = false;


// wherever your "add delivery address" button currently opens the form:
async function onAddAddressClick(existingAddress = null) {
  const coords = await openLocationPickerModal({
    savedLat: existingAddress?.lat,
    savedLng: existingAddress?.lng,
  });

  if (!coords) return; // client hit cancel/close — do nothing
  addressDraft.lat = coords.lat;
  addressDraft.lng = coords.lng;

showAddressInputDialog(null , summaryMessage)


};

// =========================
// DOM REFS
// =========================
const tabs   = document.querySelectorAll(".tab");
const slider = document.getElementById("slider");
const nav    = document.getElementById("nav");
const loader = document.getElementById("loader");

function getCurrentStatus() {
  const isOnline = window.navigator.onLine;
  if (isOnline) {
    initializeApp();
  } else {
    window.showNotif({ type: "info", title: "Network Error", message: "You are not connected to the internet." });
  }
}

getCurrentStatus();

// =========================
// STATE
// =========================
let dashboardCart   = [];
let deliveryEnabled = false;
let userdata        = null;
window.userdata     = userdata;

// =========================
// AUTH 
// =========================
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.showNotif({ type: "error", title: "No Account", message: "You are not Logged in." });
    setTimeout(() => { window.showLoadingDots("Redirecting for authentication"); }, 200);
    localStorage.setItem('Gressor-gmarketfy-client-log-in-request', 'true');
    setTimeout(() => { window.location.href = '/explore.html'; }, 1500);
  } else {
    window.showLoadingDots("Loading dashboard...");
    const currentUser     = await getDoc(doc(db, "clients", user.uid));
    const currentUserData = currentUser.data();
    window.userdata       = currentUserData;
    if (currentUserData.autoEnableDelivery) deliveryEnabled = true;
    listenToDashboard();
    cartNotifListen();
    pendingNotifListen();
    window.hideLoadingDots();
  }
});

// =========================
// NETWORK
// =========================
window.addEventListener('online', () => {
  window.showNotif({ type: "info", title: "Network Restored", message: "You are now connected to the internet." });
  initializeApp();
});

window.addEventListener('offline', () => {
  window.showNotif({ type: "info", title: "Network Error", message: "You are not connected to the internet." });
});

// =========================
// APP INIT
// =========================
function initializeApp() {
  const buttons = document.querySelectorAll(".btn");

  buttons.forEach((btn, i) => {
    btn.addEventListener("click", async () => {
      buttons.forEach(b => {
        b.classList.remove("text-white");
        b.classList.add("text-white/50");
      });

      btn.classList.add("text-white");
      btn.classList.remove("text-white/50");

      moveSlider(btn);
      tabs.forEach(t => t.classList.remove("active"));
      loader.classList.add("active");

      setTimeout(async () => {
        loader.classList.remove("active");
        tabs[i].classList.add("active");

        if (i === 1) await loadPendingTab();
        if (i === 2) await loadHistoryTab();
        if (i === 3) await loadCartTab();
        if (i === 4) await loadSettingsTab();
      }, 150);
    });
  });

  moveSlider(buttons[0]);
}

function moveSlider(btn) {
  slider.style.width     = btn.offsetWidth  + "px";
  slider.style.height    = btn.offsetHeight + "px";
  slider.style.transform = `translate(${btn.offsetLeft}px, ${btn.offsetTop}px)`;
}

window.onresize = () => {
  const active = document.querySelector(".btn.text-white");
  if (active) moveSlider(active);
};

function autoSwitchTab(tabindex) {
  const buttons = document.querySelectorAll(".btn");
  if (tabindex >= buttons.length) return;

  onAuthStateChanged(auth, async (user) => {
    if (!user) return;

    buttons.forEach(b => {
      b.classList.remove("text-white");
      b.classList.add("text-white/50");
    });

    const btn = buttons[tabindex];
    btn.classList.add("text-white");
    btn.classList.remove("text-white/50");

    moveSlider(btn);
    tabs.forEach(t => t.classList.remove("active"));
    loader.classList.add("active");

    setTimeout(async () => {
      loader.classList.remove("active");
      tabs[tabindex].classList.add("active");

      if (tabindex === 1) await loadPendingTab();
      if (tabindex === 2) await loadHistoryTab();
      if (tabindex === 3) await loadCartTab();
      if (tabindex === 4) await loadSettingsTab();
    }, 150);
  });
}

// =========================
// NAV
// =========================
document.getElementById("home").addEventListener('click', () => { window.location.href = '/index.html'; });
document.getElementById('browse-explore').addEventListener('click', () => { window.location.href = '/explore.html'; });

// =========================
// NOTIFICATION BADGES
// =========================
window.updateCartNotification = function (cart = 0) {
  const el = document.querySelector('.cart-notif');
  if (!el) return;
  el.innerText = cart;
  cart ? el.classList.remove('hidden') : setTimeout(() => el.classList.add('hidden'), 500);
};

window.updatePendingNotificaton = function (pendingProducts = 0) {
  const el = document.querySelector('.pending-notif');
  if (!el) return;
  el.innerText = pendingProducts;
  pendingProducts ? el.classList.remove('hidden') : setTimeout(() => el.classList.add('hidden'), 500);
};

// Live cart badge listener
function cartNotifListen() {
  if (!auth.currentUser) return;
  if (window._cartNotifUnsub) window._cartNotifUnsub();

  window._cartNotifUnsub = onSnapshot(doc(db, "carts", auth.currentUser.uid), (snap) => {
    const items  = snap.exists() ? (snap.data().carts || []) : [];
    const length = items.length;
    const el     = document.querySelector('.cart-notif');
    if (!el) return;
    el.innerText = length;
    length ? el.classList.remove('hidden') : setTimeout(() => el.classList.add('hidden'), 500);
  });
}

// Live pending badge listener
function pendingNotifListen() {
  if (!auth.currentUser) return;
  if (window._pendingNotifUnsub) window._pendingNotifUnsub();

  const q = query(
    collection(db, "orders"),
    where("clientId", "==", auth.currentUser.uid),
    where("status", "not-in", ["picked up", "cancelled", "paid & delivered"])
  );

  window._pendingNotifUnsub = onSnapshot(q, (snap) => {
    const el = document.querySelector('.pending-notif');
    if (!el) return;
    const count = snap.size;
    el.innerText = count;
    count ? el.classList.remove('hidden') : setTimeout(() => el.classList.add('hidden'), 500);
  });
}

// =========================
// DASHBOARD LISTENER
// =========================
function listenToDashboard() {
  if (!auth.currentUser) return;

  const uid = auth.currentUser.uid;
  const q   = query(
    collection(db, "orderingHistory"),
    where("clientId", "==", uid),
    orderBy("completedAt", "desc")
  );

  if (window._dashboardUnsub) window._dashboardUnsub();

  window._dashboardUnsub = onSnapshot(q, async (snap) => {
    try {
      const orders = await Promise.all(
        snap.docs.map(async (d) => {
          const data = { id: d.id, ...d.data() };
          try {
            const [productSnap, vendorSnap] = await Promise.all([
              getDoc(doc(db, "products", data.product_id)),
              getDoc(doc(db, "vendors",  data.vendor_id))
            ]);
            data.image      = productSnap.exists() ? productSnap.data().image    : "";
            data.vendorName = vendorSnap.exists()  ? vendorSnap.data().storeName : "Unknown Vendor";
          } catch (e) {
            data.image      = "";
            data.vendorName = "Unknown Vendor";
          }
          return data;
        })
      );

      const totalOrders      = snap.size;
      const totalSpent       = orders.reduce((s, o) => s + (o.subtotal || 0), 0);
      const productsReceived = orders.reduce((s, o) => s + (o.quantity  || 0), 0);

      const pendingSnap = await getDocs(query(
        collection(db, "orders"),
        where("clientId", "==", uid),
        where("status", "not-in", ["delivered", "picked up", "cancelled", "paid"])
      ));

      animateStat("transactions-completed", totalOrders,      false);
      animateStat("products_received",      productsReceived, false);
      animateStat("pending_products",       pendingSnap.size, false);
      animateStat("money_spent",            totalSpent,       true);

    } catch (e) {
      console.warn("Dashboard enrichment failed:", e);
    }
  }, (e) => {
    console.warn("listenToDashboard error:", e);
    window.showNotif({ type: "error", title: "Dashboard Error", message: "Could not load your dashboard stats." });
  });
}

function animateStat(elementId, targetValue, isCurrency) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const duration  = 800;
  const start     = performance.now();
  const fromValue = parseFloat(el.dataset.prev || 0);
  el.dataset.prev = targetValue;

  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased    = 1 - Math.pow(1 - progress, 3);
    const current  = Math.round(fromValue + (targetValue - fromValue) * eased);
    el.textContent = isCurrency ? `KSh ${current.toLocaleString()}` : current.toLocaleString();
    if (progress < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

// =========================
// CART
// =========================
function renderCart(cartItems) {
  const list   = document.getElementById("cart-list");
  const footer = document.getElementById("cart-footer");
  const empty  = document.getElementById("cart-empty");

  list.innerHTML = "";
  dashboardCart  = cartItems;

  if (!cartItems || cartItems.length === 0) {
    footer.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  footer.classList.remove("hidden");

  cartItems.forEach((item) => {
    const card = document.createElement("div");
    card.className = `w-full max-w-md bg-[#1a1a1a] rounded-2xl shadow-md overflow-hidden flex flex-col`;
    card.dataset.productId = item.product_id;

    card.innerHTML = `
      <img src="${item.image}" alt="${item.name}"
        class="w-full h-[160px] object-cover bg-white/5 border border-white/5"
        onerror="this.style.opacity='0'" />
      <div class="flex flex-col gap-1 py-2 px-3">
        <p class="text-sm font-semibold text-white">${item.name}</p>
        <p class="text-xs text-white/35">🏪 ${item.vendorName}</p>
      </div>
      <p class="item-subtotal text-sm font-bold text-indigo-400 px-3" data-price="${item.price}">
        ${item.currency} ${(item.price * item.quantity).toLocaleString()}
      </p>
      <div class="delivery-section m-2 flex items-center justify-between bg-white/5 p-2 rounded-xl">
        <div>
          <p class="text-xs text-white">Delivery</p>
          <p class="delivery-price text-[11px] text-white/40">--</p>
        </div>
        <div class="delivery-toggle w-10 h-5 flex items-center bg-white/10 rounded-full p-1 cursor-pointer transition">
          <div class="delivery-knob w-3 h-3 bg-slate-400 rounded-full transition"></div>
        </div>
      </div>
      <div class="flex items-center justify-between mt-2 py-3 px-3">
        <div class="flex items-center bg-white/5 rounded-lg overflow-hidden">
          <button class="qty-dec w-8 h-8 text-white/60 hover:text-white hover:bg-white/10">−</button>
          <span class="qty-val text-xs font-bold text-white px-2">${item.quantity}</span>
          <button class="qty-inc w-8 h-8 text-white/60 hover:text-white hover:bg-white/10">+</button>
        </div>
        <button class="remove-btn text-xs font-semibold text-red-400 px-3 h-8 rounded-lg border border-red-500/15 bg-red-500/8 hover:bg-red-500/15">
          ✕ Remove
        </button>
      </div>
    `;

    card.querySelector(".qty-dec").addEventListener("click", () => updateCartQty(item.product_id, -1, card));
    card.querySelector(".qty-inc").addEventListener("click", () => updateCartQty(item.product_id, +1, card));
    card.querySelector(".remove-btn").addEventListener("click", () => removeCartItem(item.product_id, card));

    const toggle  = card.querySelector(".delivery-toggle");
    const knob    = card.querySelector(".delivery-knob");
    const priceEl = card.querySelector(".delivery-price");

    if (!item.deliveryEnabledVendor) {
      priceEl.textContent = "Not available";
      toggle.classList.add("opacity-30", "pointer-events-none");
      item.deliverySelected = false;
    } else {
      if (item.deliveryMode === "dynamic") {
        priceEl.textContent = `Starts from KSh ${item.deliveryFee}`;
        priceEl.classList.add("text-yellow-400");
      } else {
        priceEl.textContent = `KSh ${item.deliveryFee}`;
      }

      if (deliveryEnabled) {
        item.deliverySelected = true;
        toggle.classList.add("bg-indigo-500/30");
        knob.classList.add("translate-x-5", "bg-indigo-400");
        knob.classList.remove("bg-slate-400");
      } else {
        item.deliverySelected = false;
      }

      toggle.addEventListener("click", () => {
        item.deliverySelected = !item.deliverySelected;
        console.log(dashboardCart);
        
        if (item.deliverySelected) {
          toggle.classList.add("bg-indigo-500/30");
          knob.classList.add("translate-x-5", "bg-indigo-400");
          knob.classList.remove("bg-slate-400");
        } else {
          toggle.classList.remove("bg-indigo-500/30");
          knob.classList.remove("translate-x-5", "bg-indigo-400");
          knob.classList.add("bg-slate-400");
        }
        refreshCartTotals();
      });
    }

    list.appendChild(card);
  });

  refreshCartTotals();
}

async function updateCartQty(productId, delta, card) {
  const item = dashboardCart.find(i => i.product_id === productId);
  if (!item) return;

  const newQty = item.quantity + delta;
  if (newQty <= 0) { removeCartItem(productId, card); return; }

  item.quantity = newQty;
  card.querySelector(".qty-val").textContent = newQty;
  card.querySelector(".item-subtotal").textContent = `${item.currency || "KSh"} ${(item.price * newQty).toLocaleString()}`;
  refreshCartTotals();

  try {
    const ref  = doc(db, "carts", auth.currentUser.uid);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const firestoreCart = snap.data().carts || [];
      const fi = firestoreCart.findIndex(i => i.product_id === productId);
      if (fi !== -1) { firestoreCart[fi].quantity = newQty; await updateDoc(ref, { carts: firestoreCart }); }
    }
  } catch (e) { console.warn("Qty sync failed:", e); }
}

async function removeCartItem(productId, card) {
  card.style.transition = "all 0.25s ease";
  card.style.opacity    = "0";
  card.style.transform  = "translateX(20px)";
  setTimeout(() => card.remove(), 250);

  dashboardCart = dashboardCart.filter(i => i.product_id !== productId);
  refreshCartTotals();

  if (dashboardCart.length === 0) {
    document.getElementById("cart-footer").classList.add("hidden");
    document.getElementById("cart-empty").classList.remove("hidden");
  }

  try {
    const ref  = doc(db, "carts", auth.currentUser.uid);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await updateDoc(ref, { carts: snap.data().carts.filter(i => i.product_id !== productId) });
    }
  } catch (e) { console.warn("Remove sync failed:", e); }
}

function refreshCartTotals() {
  const total   = dashboardCart.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const count   = dashboardCart.reduce((sum, i) => sum + i.quantity, 0);
  const totalEl = document.getElementById("cart-total");
  const countEl = document.getElementById("cart-item-count");

  if (countEl) countEl.textContent = count;
  if (totalEl) {
    const prev = parseFloat(totalEl.dataset.prev || 0);
    animateCartTotal(totalEl, prev, total);
    totalEl.dataset.prev = total;
  }
}

function animateCartTotal(el, from, to) {
  const duration = 400;
  const start    = performance.now();
  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased    = 1 - Math.pow(1 - progress, 3);
    el.textContent = "KSh " + Math.round(from + (to - from) * eased).toLocaleString();
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// =========================
// SUBMIT ORDER
// =========================
document.getElementById("submitOrderBtn").addEventListener("click", () => {
  if (!auth.currentUser) {
    window.showNotif({ type: "error", title: "Not logged in", message: "Please log in to place an order." });
    return;
  }
  if (dashboardCart.length === 0) {
    window.showNotif({ type: "error", title: "Empty Cart", message: "Your cart is empty." });
    return;
  }

  const total     = dashboardCart.reduce((s, i) => s + i.price * i.quantity, 0);
  const itemCount = dashboardCart.reduce((s, i) => s + i.quantity, 0);

  window.showDialog({
    type: "info", emoji: "🛒", tag: "Confirm Order", title: "Place your order?",
    message: `You're about to submit ${itemCount} item(s) totalling KSh ${total.toLocaleString()}.`,
    actions: [
      { label: "Yes, Submit Order", style: "primary",   onClick: handleDeliveryCheck },
      { label: "Not yet",           style: "secondary", onClick: () => {} }
    ]
  });
});

async function handleDeliveryCheck() {
  const deliveryItems = dashboardCart.filter(i => i.deliverySelected && i.deliveryEnabledVendor);
  const pickupItems   = dashboardCart.filter(i => !i.deliverySelected || !i.deliveryEnabledVendor);

  const hasDelivery   = deliveryItems.length > 0;
  const hasPickup     = pickupItems.length > 0;

  // nothing needs delivery — just place the order
  if (!hasDelivery) {
    if (hasPickup) {
      window.showDialog({
        type:    "info",
        emoji:   "🏪",
        tag:     "Pickup Only",
        title:   "Your order is pickup only",
        message: "None of your items have delivery enabled. You'll pick them up directly from the vendor at the agreed location.",
        actions: [
          { label: "Place order",  style: "primary",   onClick: () => submitOrder(null) },
          { label: "Cancel",       style: "secondary", onClick: () => {} }
        ]
      });
      return;
    }
    await submitOrder(null);
    return;
  }

  // build a clear summary message
  const deliveryNames = deliveryItems.map(i => i.name).join(", ");
  const pickupNames   = pickupItems.map(i => i.name).join(", ");

   summaryMessage = `${deliveryItems.length} item(s) will be delivered: ${deliveryNames}.`;
  if (hasPickup) {
    summaryMessage += ` The remaining ${pickupItems.length} item(s) (${pickupNames}) will be picked up from the vendor.`;
  }

  window.showLoadingDots("Checking delivery address...");

  try {
    const uid      = auth.currentUser.uid;
    const addrSnap = await getDoc(doc(db, "clientAddresses", uid));
    window.hideLoadingDots();

    if (addrSnap.exists()) {
      const saved   = addrSnap.data();
      const missing = validateAddress(saved);

      if (missing.length > 0) {
        window.showNotif({
          type:    "warning",
          title:   "Incomplete Saved Address",
          message: `Your saved address is missing: ${missing.join(", ")}. Please enter a full address.`
        });
        await onAddAddressClick()
        showAddressInputDialog(null, summaryMessage);
        return;
      }

      // show clear dialog with delivery summary
      window.showDialog({
        type:    "info",
        emoji:   "📦",
        tag:     "Delivery Summary",
        title:   hasPickup
          ? "Some items will be delivered, others picked up"
          : `${deliveryItems.length > 1 ? "Your items" : "Your item"} will be delivered`,
        message: `${summaryMessage}\n\nDeliver to: ${saved.clientName}.`,
        actions: [
          { label: "Deliver here",           style: "primary",   onClick: () => submitOrder(saved) },
          { label: "Pin Location 📍", style: "secondary", onClick: async () => await onAddAddressClick() }
        ]
      });

    } else {
      // no saved address
      await onAddAddressClick()
      showAddressInputDialog(null, summaryMessage);
    }

  } catch (e) {
    window.hideLoadingDots();
    console.warn("Address fetch failed:", e);
    await onAddAddressClick()
    showAddressInputDialog(null, summaryMessage);
  }
}




function validateAddress(addr) {
  const required = {
    clientName: "Name", 
    phoneNumber: "Phone Number", 
    Apartment: "Apartment", 
    HouseNo: "House Number"
  };

  // 1. Check text fields
  const missing = Object.entries(required)
    .filter(([key]) => !addr[key] || typeof addr[key] !== "string" || addr[key].trim() === "")
    .map(([, label]) => label);

  // 2. Validate addressDraft object separately
  if (!addr.addressDraft || !addr.addressDraft.lat || !addr.addressDraft.lng) {
    missing.push("Pin Location (addressDraft)");
  }

  return missing;
}



async function showAddressInputDialog(prefill, summaryMessage = null) {
  const overlay   = document.getElementById("app-dialog-overlay");
  const visual    = document.getElementById("dialog-visual");
  const tagEl     = document.getElementById("dialog-tag");
  const titleEl   = document.getElementById("dialog-title");
  const messageEl = document.getElementById("dialog-message");
  const actionsEl = document.getElementById("dialog-actions");

  visual.className    = "dialog-visual type-info";
  document.getElementById("dialog-emoji").textContent = "🏠";
  tagEl.className     = "dialog-tag type-info";
  tagEl.textContent   = "Delivery Address";
  tagEl.style.display = "inline-block";
  titleEl.textContent = "Where should we deliver?";

  messageEl.innerHTML = `
    ${summaryMessage ? `
      <div class="bg-white/5 rounded-xl px-3 py-2 text-xs text-white/50 mb-3 border-l-2 border-indigo-500/40">
        📦 ${summaryMessage}
      </div>
    ` : ''}
    <p class="text-xs text-white/40 mb-3">
      ℹ️ This address will only be used for this order. It won't be saved as your default.
      To set a default address, go to the <strong class="text-white/60">Settings tab</strong>.
    </p>
    <div class="grid grid-cols-2 gap-2 mt-2">
      <input id="dialog_clientName"    class="bg-white/5 p-3 rounded-xl text-sm outline-none text-white col-span-1" placeholder="Your Name"       value="${prefill?.clientName    || ''}" />
      <input id="dialog_phoneNumber"   class="bg-white/5 p-3 rounded-xl text-sm outline-none text-white col-span-1" placeholder="Phone Number"    value="${prefill?.phoneNumber   || ''}" />
      <input id="dialog_Apartment"     class="bg-white/5 p-3 rounded-xl text-sm outline-none text-white col-span-1" placeholder="Apartment Name"  value="${prefill?.Apartment     || ''}" />
      <input id="dialog_HouseNo"       class="bg-white/5 p-3 rounded-xl text-sm outline-none text-white col-span-1" placeholder="House Number"    value="${prefill?.HouseNo       || ''}" />
    </div>`;

  actionsEl.innerHTML = "";

  const confirmBtn = document.createElement("button");
  confirmBtn.className   = "dialog-btn primary";
  confirmBtn.textContent = "Confirm & Place Order";
  confirmBtn.addEventListener("click", () => {
    const address = {
      clientName:    document.getElementById("dialog_clientName")?.value?.trim(),
      phoneNumber:   document.getElementById("dialog_phoneNumber")?.value?.trim(),
      Apartment:     document.getElementById("dialog_Apartment")?.value?.trim(),
      HouseNo:       document.getElementById("dialog_HouseNo")?.value?.trim(),
    };

    address.addressDraft = addressDraft


    completeAddress = address

    const missing = validateAddress(address);
    if (missing.length > 0) {
      window.showNotif({ type: "error", title: "Missing Fields", message: `Please fill in: ${missing.join(", ")}` });
      return;
    }
    window.closeDialog();
    if (!addressDraft.lat || !addressDraft.lng){
            window.showNotif({ type: "error", title: "No Location", message: `please Select a valid map location` });
            return
    }
    window.showLoadingDots("Saving your address")
    submitOrder(address);

  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className   = "dialog-btn secondary";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => window.closeDialog());

  actionsEl.appendChild(confirmBtn);
  actionsEl.appendChild(cancelBtn);
  overlay.classList.add("open");
}



async function updateclientaddress(addressToSave) {
  if (!addressToSave) {
    console.log("could not get the address you sent..", addressToSave);
    return;
  }

  const uid = auth.currentUser?.uid;
  if (!uid) {
    console.warn("User not logged in, cannot update address.");
    return;
  }

  try {
    // Spread addressToSave so fields save directly at root level
    await setDoc(doc(db, "clientAddresses", uid), { ...addressToSave }, { merge: true });
    console.log("Address updated successfully!");
  } catch (error) {
    console.error("Address update error:", error);
    window.showNotif({ type: "error", title: "Update Failed", message: "Could not update address in DB." });
  }
}

async function submitOrder(deliveryAddress) {
  if (completeAddress){    
   await updateclientaddress(completeAddress)
  }
  window.showLoadingDots("Placing your order...");
  try {
    const uid = auth.currentUser.uid;


    
const orderPromises = dashboardCart.map(async (item) => {

  const itemNeedsDelivery = item.deliverySelected;

  // get product
  const productSnap = await getDoc(doc(db, "products", item.product_id));
  const data = productSnap.exists() ? productSnap.data() : {};

  if (! data) {window.showNotif({ type: "error", title: "invalid product", message: `the product ${item.name} cannot be found from vendor...` }); return}

  if (data.paymentTiming) {
    item.paymentTiming = data.paymentTiming;
  }

  console.log("got:", data);

  // create order
  return addDoc(collection(db, "orders"), {
    clientId: uid,
    product_id: item.product_id,
    vendor_id: item.vendor_id,
    name: item.name,
    price: data.price,
    quantity: item.quantity,
    subtotal: data.price * item.quantity,

    status: "pending",
    paymentStatus: "pending",

    paymentTiming: item.paymentTiming || "before",

    placedOn: Timestamp.now(),
    createdAt: Timestamp.now(),
    priceDuringPurchase : data.price,
    delivery: {
      enabled: itemNeedsDelivery,
      ...(itemNeedsDelivery && deliveryAddress
        ? { address: deliveryAddress }
        : {})
    }
  });
});

    await Promise.all(orderPromises);
    await setDoc(doc(db, "carts", uid), { clientId: uid, carts: [] });

    dashboardCart = [];
    renderCart([]);
    window.hideLoadingDots();
    window.showNotif({ type: "success", title: "Order Placed!", message: "Your order has been submitted successfully." });

  } catch (e) {
    console.warn("Order failed:", e);
    window.hideLoadingDots();
    window.showNotif({ type: "error", title: "Order Failed", message: "Something went wrong. Please try again." });
  }
}

// =========================
// CART TAB LOADER
// =========================
async function loadCartTab() {
  const list   = document.getElementById("cart-list");
  const footer = document.getElementById("cart-footer");
  const empty  = document.getElementById("cart-empty");

  list.innerHTML = `
    <div class="flex justify-center py-12">
      <div class="w-8 h-8 border-2 border-white/10 border-t-indigo-500 rounded-full animate-spin"></div>
    </div>`;
  footer.classList.add("hidden");
  empty.classList.add("hidden");

  if (!auth.currentUser) { list.innerHTML = ""; empty.classList.remove("hidden"); return; }

  try {
    const cartSnap = await getDoc(doc(db, "carts", auth.currentUser.uid));

    if (!cartSnap.exists() || cartSnap.data().carts?.length === 0) {
      list.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }

    const slimItems = cartSnap.data().carts || [];

    const enriched = await Promise.all(
      slimItems.map(async (item) => {
        try {
          const productSnap = await getDoc(doc(db, "products", item.product_id));
          const product     = productSnap.exists() ? productSnap.data() : {};
          let vendorData    = {};
          if (item.vendor_id) {
            const vendorSnap = await getDoc(doc(db, "vendors", item.vendor_id));
            if (vendorSnap.exists()) vendorData = vendorSnap.data();
          }

          
          return {
            ...item,
            name:                 product.name     || "Unknown Product",
            image:                product.image    || "",
            currency:             product.currency || "KSh",
            vendorName:           vendorData.storeName        || "Unknown Vendor",
            deliveryEnabledVendor: vendorData.delivery?.enabled || false,
            deliveryFee:          vendorData.delivery?.fee     || 0,
            deliveryMode:         vendorData.delivery?.mode    || "fixed"
          };
        } catch (e) {
          console.warn("Failed to enrich cart item:", item.product_id, e);
          return { ...item, name: "Unknown Product", image: "", vendorName: "Unknown Vendor", currency: "KSh" };
        }
      })
    );

    renderCart(enriched);
  } catch (e) {
    console.warn("loadCartTab failed:", e);
    list.innerHTML = "";
    empty.classList.remove("hidden");
  }
}