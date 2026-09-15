import {
  db, collection, query, where, orderBy, getDocs,
  Timestamp, getDoc, doc, updateDoc, setDoc,
  auth, onAuthStateChanged, onSnapshot,  deleteDoc,
  arrayRemove, arrayUnion
} from './firebase-config.js'

// =========================
// STEPS
// =========================
const DELIVERY_STEPS = ["Confirmed", "Assigned", "Out for delivery", "Delivered", "Paid", "paid & delivered"];
const PICKUP_STEPS   = ["Confirmed", "Packaging", "Ready", "Paid"];

function getStepIndex(status, steps) {
  const idx = steps.findIndex(s => s.toLowerCase() === status?.toLowerCase());
  return idx === -1 ? 0 : idx;
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

  // terminal statuses differ per flow
  const terminalStatuses = isDelivery
    ? ["paid", "paid & delivered", "delivered"]
    : ["paid", "picked up"];
  const isTerminal = terminalStatuses.includes(st);

  if (isPaid && !isTerminal) {
    // paid early, order is still physically moving (delivery) or being prepped (pickup)
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
// PAY BUTTON LOGIC
// =========================
function canClientPay(order) {
  const status        = order.status?.toLowerCase();
  const isDelivery     = order.delivery?.enabled;
  const paymentTiming  = order.paymentTiming || "before";
  const paymentStatus  = order.paymentStatus?.toLowerCase();

  if (paymentStatus === "paid") return false;

  // pickup — can pay when ready
  if (!isDelivery) return status === "ready";

  // delivery + pay before — active from confirmed onwards
  if (paymentTiming === "before") {
    return ["confirmed", "assigned", "out for delivery", "delivered"].includes(status);
  }

  // delivery + pay after — only once delivery is confirmed
  if (paymentTiming === "after") {
    return status === "delivered" || status === "paid & delivered";
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
    // show why pay is locked
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
        <span class="text-[10px] text-white/20">${hint}</span>
      </div>`;
  }

  return `
    <button
      class="pay-order-btn flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold border border-white/5 hover:opacity-90 transition animate-pulse"
      data-order-id="${order.id}"
      style="background:linear-gradient(135deg,#4ade80,#22c55e);color:#052e16;">
      💳 Pay now
    </button>`;
}


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
// RENDER
// =========================
function renderPendingOrders(orders) {
  const list  = document.getElementById("pending-list");
  const empty = document.getElementById("pending-empty");

  list.innerHTML = "";

  if (!orders || orders.length === 0) {
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  orders.forEach(order => {
    const isDelivery   = order.delivery?.enabled;
    const status       = order.status || "pending";
    const placedOn     = order.placedOn?.toDate?.() || new Date();
    const timeAgo      = formatTimeAgo(placedOn);
    const address      = order.delivery?.address;
    const vendorNote   = order.vendorNote || null;
    const showProgress = status !== "pending";
    const paymentStatus = order.paymentStatus;
    const eligible     = canClientPay(order);

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
        class="w-full h-[160px] object-cover bg-white/5 border border-white/5"
        onerror="this.style.opacity='0.2'" />

      <!-- NAME + BADGE -->
      <div class="flex items-start justify-between gap-2 pt-3 px-3">
        <div>
          <p class="text-sm font-semibold text-white">${order.name}</p>
          <p class="text-xs text-white/35 mt-0.5">🏪 ${order.vendorName || "Vendor"} &nbsp;·&nbsp; x${order.quantity}</p>
        </div>
        ${buildStatusBadge(status , paymentStatus , isDelivery)}
      </div>

      <!-- ORDER META -->
      <div class="flex items-center justify-between px-3 mt-1.5">
        <span class="text-xs text-white/25">Order #${order.id?.slice(-5).toUpperCase()}</span>
        <span class="text-xs text-white/25">${timeAgo}</span>
      </div>

      <!-- PROGRESS BAR -->
      <div class="px-3 mt-3 mb-1">
        ${showProgress ? buildProgressBar(status, paymentStatus, isDelivery) : `
          <p class="text-xs text-white/25 italic pb-1">Waiting for vendor to confirm...</p>
        `}
      </div>

      <div class="mx-3 my-2 h-px bg-white/5"></div>

      <!-- VENDOR NOTE -->
      <div class="px-3 pb-2">
        <p class="text-[10px] uppercase tracking-widest text-white/25 mb-1.5">Vendor note</p>
        <div class="bg-white/5 rounded-xl px-3 py-2 border-l-2 border-white/10 text-xs ${vendorNote ? 'text-white/60' : 'text-white/20 italic'}">
          ${vendorNote || "No note from vendor yet..."}
        </div>
      </div>

      ${isDelivery && address ? `
        <div class="mx-3 my-1 h-px bg-white/5"></div>
        <div class="px-3 pb-2">
          <p class="text-[10px] uppercase tracking-widest text-white/25 mb-1.5">📦 Delivering to</p>
          <p class="text-xs text-white/50">${address.clientName} &nbsp;·&nbsp; ${address.phoneNumber}</p>
          <p class="text-xs text-white/30 mt-0.5">${address.streetAddress}, ${address.Apartment}, ${address.HouseNo}, ${address.city}</p>
        </div>
      ` : ''}

      ${window.getRelevantDeliveryInfo(order, order.id)}
      <div class="mx-3 mt-1 h-px bg-white/5"></div>

      <!-- TOTAL + PAY -->
      <div class="flex items-center justify-between px-3 py-3 mt-auto">
        <div>
          <p class="text-xs text-white/35 mb-0.5">Total</p>
          <p class="text-base font-bold ${eligible ? 'text-green-400' : 'text-indigo-400'}">
            KSh ${order.subtotal?.toLocaleString()}
          </p>
        </div>
        ${buildPayButton(order)}
      </div>
    `;

    // only wire up click if eligible
    const payBtn = card.querySelector(".pay-order-btn");
    if (payBtn) payBtn.addEventListener("click", () => handlePayOrder(order));

    list.appendChild(card);
  });
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

    window._pendingOrdersUnsub = onSnapshot(q, async (snap) => {
      if (snap.empty) {
        list.innerHTML = "";
        empty.classList.remove("hidden");
        return;
      }

      empty.classList.add("hidden");

const orders = await Promise.all(
  snap.docs.map(async (d) => {
    const data = { id: d.id, ...d.data() };
    try {
      const [productSnap, vendorSnap] = await Promise.all([
        getDoc(doc(db, "products", data.product_id)),
        getDoc(doc(db, "vendors",  data.vendor_id))
      ]);
      data.image                = productSnap.exists() ? productSnap.data().image          : "";
      data.vendorName           = vendorSnap.exists()  ? vendorSnap.data().storeName       : "Unknown Vendor";

      // ✅ overwrite delivery.enabled with live vendor setting
const vendorDelivery = vendorSnap.exists() ? vendorSnap.data().delivery : null;
data.delivery = {
  ...data.delivery,
  enabled: data.delivery?.enabled ?? (vendorDelivery?.enabled || false)
};

    } catch (e) {
      data.image      = "";
      data.vendorName = "Unknown Vendor";
      console.warn("Failed to enrich order:", data.id, e);
    }
    return data;
  })
);

      renderPendingOrders(orders);

    }, (e) => {
      console.warn("onSnapshot failed:", e);
      list.innerHTML = "";
      empty.classList.remove("hidden");
      window.showNotif({ type: "error", title: "Failed to load", message: "Could not load your pending orders." });
    });

  } catch (e) {
    console.warn("loadPendingTab failed:", e);
    list.innerHTML = "";
    empty.classList.remove("hidden");
    window.showNotif({ type: "error", title: "Failed to load", message: "Could not load your pending orders." });
  }
}

window.loadPendingTab = loadPendingTab;

// =========================
// PAY ORDER
// =========================
function handlePayOrder(order) {
  window.showDialog({
    type:    "info",
    emoji:   "💳",
    tag:     "Payment",
    title:   `Pay KSh ${order.subtotal?.toLocaleString()}?`,
    message: `Completing payment for ${order.name} from ${order.vendorName}.`,
    actions: [
      { label: "Proceed to payment", style: "primary",   onClick: () => processPayment(order) },
      { label: "Not yet",            style: "secondary", onClick: () => {} }
    ]
  });
}

// =========================
// PROCESS PAYMENT
// =========================

async function processPayment(order) {
  if (!auth.currentUser) return;

  window.showLoadingDots("Processing payment...");

  try {
    const isDelivery = order.delivery?.enabled;


      const user = auth.currentUser;

      if (!user) {
          window.showNotif({ type: "error", title: "Authentication Failed", message: "User is not authenticated" });
          return;
      }    

      const idToken = await user.getIdToken();

      let response = await fetch(`http://127.0.0.1:8000/pay/${order.id}/`, {
          method: "POST",
          headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${idToken}`
          },
          body: JSON.stringify({
              phone: "0719857793"
          })
      });
          

   
    window.hideLoadingDots();
    window.showNotif({
      type: "success",
      title: "Payment Successful! 🎉",
      message: `Your order for ${order.name} has been completed.`
    });

    if (typeof loadHistoryTab === "function") await loadHistoryTab();
 
  } catch (e) {
    console.warn("processPayment failed:", e);
    window.hideLoadingDots();
    window.showNotif({ type: "error", title: "Payment Failed", message: "Something went wrong. Please try again." });
  }
}