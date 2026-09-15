import {
  collection,
  addDoc,
  updateDoc,
  doc,
  serverTimestamp,
  query,
  onSnapshot,
  where,
  setDoc,
  getDoc,
  onAuthStateChanged,
  orderBy,
  increment
} from './firebase.js'

import {
    app ,
    auth ,
    db
} from './firebase.js'


let _ordersUnsub = null;

function listenToOrders(vendorId) {
  // clean up previous listener
  if (_ordersUnsub) { _ordersUnsub(); _ordersUnsub = null; }

  const q = query(
    collection(db, "orders"),
    where("vendor_id", "==", vendorId),
    orderBy("createdAt", "desc")
  );

  _ordersUnsub = onSnapshot(q, (snapshot) => {
    const container = document.getElementById("ordersList");
    const empty     = document.getElementById("emptyOrders");

    container.innerHTML = "";

    if (snapshot.empty) {
      empty.classList.remove("hidden");
      return;
    }

    empty.classList.add("hidden");

    snapshot.forEach(docSnap => {
      const order    = { ...docSnap.data(), order_id: docSnap.id };
      const card     = renderOrderCard(order);
      container.appendChild(card);
    });
  });
}


function renderOrderCard(order) {

  const card = document.createElement("div");

  const statusColors = {
    pending: "bg-yellow-500/20 text-yellow-300",
    completed: "bg-green-500/20 text-green-300",
    cancelled: "bg-red-500/20 text-red-300"
  };

  card.className =
    "glass p-4 rounded-2xl flex flex-col gap-3 fade-up transition hover:scale-[1.01]";

  card.innerHTML = `

    <!-- HEADER CARD -->
    <div class="glass p-3 rounded-xl flex justify-between items-start">

      <div>
        <h3 class="text-white font-medium">${order.product.name}</h3>
        <p class="text-xs text-white/40">Order ID: ${order.order_id || ""}</p>
      </div>

      <span class="text-xs px-2 py-1 rounded-full ${statusColors[order.status]}">
        ${order.status}
      </span>

    </div>


    <!-- CUSTOMER CARD -->
    <div class="glass p-3 rounded-xl">
      <p class="text-xs text-white/40 mb-1">Customer</p>
      <p class="text-sm text-white/80">👤 ${order.customer.name}</p>
      <p class="text-sm text-white/60">📞 ${order.customer.phone}</p>
    </div>


    <!-- PRODUCT + ORDER INFO CARD -->
    <div class="glass p-3 rounded-xl">

      <p class="text-xs text-white/40 mb-2">Order Details</p>

      <div class="flex justify-between text-sm text-white/70">
        <span>Quantity</span>
        <span>${order.quantity}</span>
      </div>

      <div class="flex justify-between text-sm text-white/70 mt-1">
        <span>Unit Price</span>
        <span>${order.product.price}</span>
      </div>

      <div class="flex justify-between text-sm text-white/70 mt-1">
        <span>Total</span>
        <span class="text-white font-semibold">${order.total}</span>
      </div>

    </div>


    <!-- DELIVERY + SCHEDULE CARD -->
    <div class="grid grid-cols-2 gap-2">

      <div class="glass p-3 rounded-xl">
        <p class="text-xs text-white/40 mb-1">Delivery</p>

        ${
          order.delivery
            ? `
              <p class="text-xs text-white/70">Type: ${order.delivery.type || "N/A"}</p>
              <p class="text-xs text-white/70">Fee: ${getfeeMessage(order.delivery.fee, order.delivery.type)}</p>
            `
            : `<p class="text-xs text-white/50">Pickup</p>`
        }
      </div>

      <div class="glass p-3 rounded-xl">
        <p class="text-xs text-white/40 mb-1">Schedule</p>
        <p class="text-xs text-white/70">${order.schedule?.date || "N/A"}</p>
        <p class="text-xs text-white/70">${order.schedule?.time || "N/A"}</p>
      </div>

    </div>


    <!-- ACTIONS -->
    <div class="flex gap-2 pt-1">

      <button class="btn-complete text-xs bg-green-500/20 px-3 py-1 rounded-lg flex-1">
        Complete
      </button>

      <button class="btn-cancel text-xs bg-red-500/20 px-3 py-1 rounded-lg flex-1">
        Cancel
      </button>

    </div>
  `;

  // =========================
  // ACTION EVENTS
  // =========================

  card.querySelector(".btn-complete").onclick = () =>
    updateOrderStatus(order , "completed");

  card.querySelector(".btn-cancel").onclick = () =>
    updateOrderStatus(order, "cancelled");

  // open details (avoid button clicks)
  card.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    openOrderDetails(order);
  });

  return card;
}

console.log("hello world.....");

function getfeeMessage(fee , type){ 
  if(fee > 0 && type === "static") return fee
  else if(type === "dynamic")   return `starts from KES ${fee}`;
  else return "Free Delivery"

}

async function updateOrderStatus(order, status) {

  const orderId = order.order_id;

  const priorityMap = {
    pending: 0,
    completed: 1,
    delivered: 2,
    cancelled: 3
  };

  const productId = order.product.id;
  const price = order.product.price;


  // 🔥 Update order status first
  await updateDoc(doc(db, "orders", orderId), {
    status,
    updatedAt: serverTimestamp()
  });

  // 🔥 ONLY update revenue if transitioning to completed
  if (order.status !== "completed" && status === "completed") {

    try {
      const productStatsRef = doc(db, "productStats", productId);

      await updateDoc(productStatsRef, {
        "metrics.totalRevenue": increment(price),
        updatedAt: serverTimestamp()
      });

    } catch (e) {
      console.error("Revenue update failed:", e);
    }
  }
}


onAuthStateChanged(auth, (user) => {
  if (!user) return;
  const uid = user.uid;

  // load when tab is switched to orders
  window.addEventListener("loadOrders", () => {
    listenToOrders(uid);
  });
});


function openOrderDetails(order) {

  const modal = document.getElementById("orderDetailsModal");
  const box = document.getElementById("orderDetailsBox");
  const content = document.getElementById("orderDetailsContent");

  content.innerHTML = `

    <!-- CUSTOMER -->
    <div>
      <h4 class="text-white font-medium mb-1">Customer</h4>
      <p>👤 ${order.customer.name}</p>
      <p>📞 ${order.customer.phone}</p>
    </div>

    <!-- PRODUCT -->
    <div>
      <h4 class="text-white font-medium mb-1">Product</h4>
      <p>${order.product.name}</p>
      <p>Qty: ${order.quantity}</p>
      <p>Price: ${order.product.price}</p>
    </div>

    <!-- DELIVERY -->
    <div>
      <h4 class="text-white font-medium mb-1">Delivery</h4>
      ${
        order.delivery
          ? `
            <p>Type: ${order.delivery.type || "N/A"}</p>
            <p>Location: ${order.delivery.location || "N/A"}</p>
            <p>Fee: ${getfeeMessage(order.delivery.fee, order.delivery.type)}</p>
          `
          : `<p class="text-white/50">Customer will pick up</p>`
      }
    </div>

    <!-- SCHEDULE -->
    <div>
      <h4 class="text-white font-medium mb-1">Schedule</h4>
      <p>📅 ${order.schedule?.date || "N/A"}</p>
      <p>⏰ ${order.schedule?.time || "N/A"}</p>
    </div>

    <!-- STATUS -->
    <div>
      <h4 class="text-white font-medium mb-1">Status</h4>
      <p>${order.status}</p>
    </div>

    <!-- TOTAL -->
    <div class="pt-2 border-t border-white/10">
      <h4 class="text-white font-medium mb-1">Total</h4>
      <p class="text-lg font-semibold">${order.total}</p>
    </div>

  `;

  // show modal
  modal.classList.remove("opacity-0", "pointer-events-none");
  box.classList.remove("scale-95", "opacity-0");
}


document.getElementById("closeOrderDetails").onclick = closeOrderDetails;

function closeOrderDetails() {

  const modal = document.getElementById("orderDetailsModal");
  const box = document.getElementById("orderDetailsBox");

  box.classList.add("scale-95", "opacity-0");

  setTimeout(() => {
    modal.classList.add("opacity-0", "pointer-events-none");
  }, 200);
}

document.getElementById("orderDetailsModal").addEventListener("click", (e) => {

  const box = document.getElementById("orderDetailsBox");

  if (!box.contains(e.target)) {
    closeOrderDetails();
  }
});



const loader = document.getElementById("globalLoader");

function showLoader() {
  loader.classList.remove("hidden");
}

function hideLoader() {
  loader.classList.add("hidden");
}