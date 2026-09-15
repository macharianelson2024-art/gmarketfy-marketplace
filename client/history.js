import {
  db, collection, query, where, orderBy,
  getDocs, Timestamp, getDoc, doc, updateDoc,
  setDoc, auth, onSnapshot, deleteDoc
} from './firebase-config.js'

// =========================
// STATE
// =========================
let allHistoryOrders = [];
let activeFilter     = "all";

// =========================
// LOAD HISTORY TAB
// =========================
async function loadHistoryTab() {
  const list  = document.getElementById("history-list");
  const empty = document.getElementById("history-empty");

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
      collection(db, "orderingHistory"),
      where("clientId", "==", uid),
      orderBy("completedAt", "desc")
    );

    const snap = await getDocs(q);

    if (snap.empty) {
      list.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }

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

    renderHistoryOrders(orders);

  } catch (e) {
    console.warn("loadHistoryTab failed:", e);
    list.innerHTML = "";
    empty.classList.remove("hidden");
    window.showNotif({ type: "error", title: "Failed to load", message: "Could not load your order history." });
  }
}

window.loadHistoryTab = loadHistoryTab;

// =========================
// STATUS BADGE
// =========================
function buildHistoryBadge(status) {
  const map = {
    delivered:   { classes: "bg-green-500/12 text-green-400",   icon: "✅", label: "Delivered" },
    "picked up": { classes: "bg-indigo-500/12 text-indigo-400", icon: "📍", label: "Picked up" },
    paid:        { classes: "bg-green-500/12 text-green-400",   icon: "💚", label: "Paid" },
  };

  const s = map[status?.toLowerCase()] || { classes: "bg-white/10 text-white/40", icon: "📦", label: status };
  return `
    <span class="text-[11px] px-2.5 py-1 rounded-lg font-semibold flex items-center gap-1 whitespace-nowrap ${s.classes}">
      ${s.icon} ${s.label}
    </span>`;
}

// =========================
// RENDER HISTORY
// =========================
function renderHistoryOrders(orders) {
  allHistoryOrders = orders;
  applyHistoryFilter(activeFilter);
  renderHistoryStats(orders);
}

function applyHistoryFilter(filter) {
  activeFilter = filter;

  const list  = document.getElementById("history-list");
  const empty = document.getElementById("history-empty");

  document.querySelectorAll(".history-filter-btn").forEach(btn => {
    const isActive = btn.dataset.filter === filter;

    // active = plain, no border
    btn.classList.toggle("border-white/8",  isActive);
    btn.classList.toggle("text-white/40",   isActive);
    btn.classList.toggle("bg-transparent",  isActive);

    // inactive = has border and styles
    btn.classList.toggle("border-white/15", !isActive);
    btn.classList.toggle("bg-white/8",      !isActive);
    btn.classList.toggle("text-white",      !isActive);
  });

  const filtered = filter === "all"
    ? allHistoryOrders
    : allHistoryOrders.filter(o => {
        const s = o.status?.toLowerCase();
        if (filter === "delivered") return s === "delivered" || s === "paid";
        if (filter === "pickup")    return s === "picked up";
        return true;
      });

  list.innerHTML = "";

  if (filtered.length === 0) {
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  filtered.forEach(order => {
    console.log(order);
    
    const isDelivery  = order.delivery?.enabled;
    const address     = order.delivery?.address;
    const completedAt = order.completedAt?.toDate?.() || new Date();
    const timeAgo     = formatTimeAgo(completedAt);
    const status      = order.status?.toLowerCase();

    const card = document.createElement("div");
    card.className = `
      w-full max-w-md
      bg-[#1a1a1a]
      rounded-2xl
      shadow-md
      overflow-hidden
      flex flex-col
    `;

    card.innerHTML = `
      <img
        src="${order.image || ''}"
        alt="${order.name}"
        class="w-full h-[130px] object-cover bg-white/5 border border-white/5"
        onerror="this.style.opacity='0.2'" />

      <div class="flex items-start justify-between gap-2 pt-3 px-3">
        <div>
          <p class="text-sm font-semibold text-white">${order.name}</p>
          <p class="text-xs text-white/30 mt-0.5">🏪 ${order.vendorName} &nbsp;·&nbsp; x${order.quantity}</p>
        </div>
        ${buildHistoryBadge(status)}
      </div>

      <div class="flex items-center justify-between px-3 mt-1.5">
        <span class="text-xs text-white/20">Order #${order.id?.slice(-5).toUpperCase()}</span>
        <span class="text-xs text-white/20">${timeAgo}</span>
      </div>

      <div class="px-3 py-2.5">
        <p class="text-[10px] uppercase tracking-widest text-white/20 mb-1.5">
          ${isDelivery && address ? '📦 Delivered to' : '📍 Picked up at'}
        </p>
        ${isDelivery && address ? `
          <p class="text-xs text-white/40">${address.clientName} &nbsp;·&nbsp; ${address.phoneNumber}</p>
          <p class="text-xs text-white/25 mt-0.5">${address.streetAddress}, ${address.Apartment}, ${address.HouseNo}, ${address.city}</p>
        ` : `
          <p class="text-xs text-white/40">${order.vendorName}</p>
        `}
      </div>

      <div class="mx-3 h-px bg-white/5"></div>

      <div class="flex items-center justify-between px-3 py-3 mt-auto">
        <div>
          <p class="text-xs text-white/30 mb-0.5">Paid</p>
          <p class="text-base font-bold text-green-400">KSh ${order.subtotal?.toLocaleString()}</p>
        </div>
        <button class="reorder-btn flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold
          border border-indigo-500/20 bg-indigo-500/10 text-indigo-400
          hover:bg-indigo-500/20 transition">
          🔁 Reorder
        </button>
      </div>
    `;

    card.querySelector(".reorder-btn").addEventListener("click", () => handleReorder(order));
    list.appendChild(card);
  });
}

// =========================
// HISTORY STATS
// =========================
function renderHistoryStats(orders) {
  const totalOrders = orders.length;
  const totalSpent  = orders.reduce((s, o) => s + (o.subtotal || 0), 0);

  const now       = new Date();
  const thisMonth = orders
    .filter(o => {
      const d = o.completedAt?.toDate?.();
      return d && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    })
    .reduce((s, o) => s + (o.subtotal || 0), 0);

  const totalEl     = document.getElementById("history-total-orders");
  const spentEl     = document.getElementById("history-total-spent");
  const thisMonthEl = document.getElementById("history-this-month");

  if (totalEl)     totalEl.textContent     = totalOrders;
  if (spentEl)     spentEl.textContent     = `KSh ${totalSpent.toLocaleString()}`;
  if (thisMonthEl) thisMonthEl.textContent = `KSh ${thisMonth.toLocaleString()}`;
}

// =========================
// REORDER
// =========================
async function handleReorder(order) {
  if (!auth.currentUser) return;

  window.showDialog({
    type:    "info",
    emoji:   "🔁",
    tag:     "Reorder",
    title:   `Reorder ${order.name}?`,
    message: `This will add ${order.name} x${order.quantity} from ${order.vendorName} back to your cart.`,
    actions: [
      { label: "Yes, add to cart", style: "primary",   onClick: () => addReorderToCart(order) },
      { label: "Not yet",          style: "secondary", onClick: () => {} }
    ]
  });
}

async function addReorderToCart(order) {
  if (!auth.currentUser) return;

  window.showLoadingDots("Adding to cart...");

  try {
    const uid  = auth.currentUser.uid;
    const ref  = doc(db, "carts", uid);
    const snap = await getDoc(ref);

    const existingCart = snap.exists() ? (snap.data().carts || []) : [];
    const alreadyIn    = existingCart.findIndex(i => i.product_id === order.product_id);

    if (alreadyIn !== -1) {
      existingCart[alreadyIn].quantity += order.quantity;
      await updateDoc(ref, { carts: existingCart });
    } else {
      await setDoc(ref, {
        clientId: uid,
        carts: [...existingCart, {
          product_id: order.product_id,
          vendor_id:  order.vendor_id,
          quantity:   order.quantity,
          price:      order.price,
          addedAt:    Timestamp.now()
        }]
      });
    }

    window.hideLoadingDots();
    window.showNotif({
      type:    "success",
      title:   "Added to cart!",
      message: `${order.name} x${order.quantity} has been added to your cart.`
    });

  } catch (e) {
    console.warn("Reorder failed:", e);
    window.hideLoadingDots();
    window.showNotif({ type: "error", title: "Reorder Failed", message: "Could not add item to cart. Try again." });
  }
}

// =========================
// FILTER LISTENERS
// =========================
document.querySelectorAll(".history-filter-btn").forEach(btn => {
  btn.addEventListener("click", () => applyHistoryFilter(btn.dataset.filter));
});

// =========================
// TIME AGO
// =========================
function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60)    return "Just now";
  if (seconds < 3600)  return `${Math.floor(seconds / 60)} mins ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hrs ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

// =========================
// PENDING NOTIF LIVE LISTENER
// =========================
function pendingNotifListen() {
  if (!auth.currentUser) return;
  if (window._pendingNotifUnsub) window._pendingNotifUnsub();

  const el = document.querySelector('.pending-notif');
  if (!el) return;

  const q = query(
    collection(db, "orders"),
    where("clientId", "==", auth.currentUser.uid),
    where("status", "not-in", ["delivered", "picked up", "cancelled", "paid"]),
    orderBy("status"),
    orderBy("createdAt", "desc")
  );

  window._pendingNotifUnsub = onSnapshot(q, (snap) => {
    const length = snap.size;
    el.innerText = length;
    length ? el.classList.remove('hidden') : setTimeout(() => el.classList.add('hidden'), 500);
  });
}

// =========================
// CART NOTIF LIVE LISTENER
// =========================
function cartNotifListen() {
  if (!auth.currentUser) return;
  if (window._cartNotifUnsub) window._cartNotifUnsub();

  window._cartNotifUnsub = onSnapshot(doc(db, "carts", auth.currentUser.uid), (snap) => {
    const length = snap.exists() ? (snap.data().carts || []).length : 0;
    const el     = document.querySelector('.cart-notif');
    if (!el) return;
    el.innerText = length;
    length ? el.classList.remove('hidden') : setTimeout(() => el.classList.add('hidden'), 500);
  });
}

window.loadHistoryTab      = loadHistoryTab;
window.pendingNotifListen  = pendingNotifListen;
window.cartNotifListen     = cartNotifListen;