import { db, getDoc , doc} from "./firebase.js";

import {
  collection,
  query,
  where,
  onSnapshot,
  
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let revenueChart;
let ordersChart;
let productsChart;

// ===============================
// 🚀 INIT ANALYTICS
// ===============================
export function initAnalytics(vendorId) {
  if (!vendorId) return;
  try{
  initCharts();
  listenOrders(vendorId);
  listenProductStats(vendorId);
}
catch(e){
  console.log(e);
  
}
}

export {
  getNumberOfStoreVisitors
}

// ===============================
// 📦 ORDERS STREAM
// ===============================
function listenOrders(vendorId) {

  const q = query(
    collection(db, "orders"),
    where("vendor_id", "==", vendorId)
  );

  onSnapshot(q, (snapshot) => {

    let totalRevenue = 0;
    let totalOrders = 0;

    let completed = 0;
    let pending = 0;
    let cancelled = 0;

    const revenueByDay = {
      Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0
    };

    const pendingOrders = [];

    snapshot.forEach((docSnap) => {
      const order = docSnap.data();
      totalOrders++;

      const amount = parseInt(
        (order.total || "0").replace(/[^\d]/g, "")
      ) || 0;

      const status = order.status || "pending";

      // =========================
      // 💰 REVENUE ONLY COMPLETED
      // =========================
      if (status === "completed") {
        totalRevenue += amount;
        completed++;
      }

      if (status === "pending") {
        pending++;
        pendingOrders.push(order);
      }

      if (status === "cancelled") {
        cancelled++;
      }

      // =========================
      // 📅 DAILY REVENUE
      // =========================
      if (order.createdAt?.toDate) {
        const date = order.createdAt.toDate();
        const day = date.toLocaleDateString("en-US", {
          weekday: "short"
        });

        if (revenueByDay[day] !== undefined) {
          revenueByDay[day] += amount;
        }
      }
    });

    updateKPIs(totalRevenue, totalOrders, pending);
    updateCharts(revenueByDay, { completed, pending, cancelled });
    renderPendingOrders(pendingOrders);
  });
}

// ===============================
// ⏳ PENDING ORDERS UI
// ===============================
function renderPendingOrders(orders) {

  const container = document.getElementById("pendingOrdersCard");
  if (!container) return;

  container.innerHTML = "";

  if (orders.length === 0) {
    container.innerHTML = `
      <p class="text-xs text-slate-500">No pending orders 🎉</p>
    `;
    return;
  }

  orders
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
    .slice(0, 6)
    .forEach(order => {

      const div = document.createElement("div");

      div.className =
        "p-2 rounded-lg bg-white/5 text-xs text-slate-300";

      div.innerHTML = `
        <div class="flex justify-between">
          <span>${order.product?.name || "Product"}</span>
          <span class="text-yellow-300">Pending</span>
        </div>

        <div class="text-slate-400">
          ${order.customer?.name || "Customer"} • Qty ${order.quantity || 1}
        </div>
      `;

      container.appendChild(div);
    });
}

// ===============================
// ⭐ PRODUCT STATS STREAM
// ===============================
function listenProductStats(vendorId) {

  const q = query(
    collection(db, "productStats"),
    where("vendor_id", "==", vendorId)
  );

  onSnapshot(q, (snapshot) => {

    const products = [];

    snapshot.forEach(docSnap => {
      products.push(docSnap.data());
    });

    const topRated = products
      .sort((a, b) =>
        (b.rating?.average || 0) - (a.rating?.average || 0)
      )
      .slice(0, 5);

    renderTopProducts(topRated);
  });
}

// ===============================
// 🏆 TOP PRODUCTS UI
// ===============================
function renderTopProducts(products) {

  const container = document.getElementById("topProductsCard");
  if (!container) return;

  container.innerHTML = "";

  if (products.length === 0) {
    container.innerHTML =
      `<p class="text-xs text-slate-500">No rated products yet</p>`;
    return;
  }

  products.forEach(p => {

    const div = document.createElement("div");

    div.className =
      "p-2 rounded-lg bg-white/5 text-xs text-slate-300";

    div.innerHTML = `
      <div class="flex justify-between">
        <span>${p.product_name || p.product_id}</span>
        <span class="text-yellow-400">
          ⭐ ${p.rating?.average || 0}
        </span>
      </div>

      <div class="text-slate-400">
        Orders: ${p.metrics?.totalOrders || 0} • 
        Revenue: KES ${p.metrics?.totalRevenue || 0} • 
        Views:  ${p.metrics?.totalViews || 0}
      </div>
    `;

    container.appendChild(div);
  });
}

// ===============================
// 📊 KPI UPDATE
// ===============================
function updateKPIs(revenue, orders, pending) {

  setText("kpiRevenue", `KES ${revenue}`);
  setText("kpiOrders", pending);
  setText('kpiRevenueAnalytics' , `KES ${revenue}`)
  setText('kpiOrdersAnalytics' , ` ${pending}`)


  const conversion = orders > 0
    ? ((orders - pending) / orders) * 100
    : 0;

  setText("kpiConversion", `${conversion.toFixed(1)}%`);
}

// ===============================
// 📈 CHART INIT
// ===============================
function initCharts() {

  const r = document.getElementById("revenueChart");
  const o = document.getElementById("ordersChart");

  if (!r || !o) return;

  revenueChart = new Chart(r, {
    type: "line",
    data: {
      labels: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"],
      datasets: [{
        data: [0,0,0,0,0,0,0],
        borderColor: "#6366f1",
        backgroundColor: "rgba(99,102,241,0.2)",
        fill: true,
        tension: 0.4
      }]
    }
  });

  ordersChart = new Chart(o, {
    type: "doughnut",
    data: {
      labels: ["Completed","Pending","Cancelled"],
      datasets: [{
        data: [0,0,0],
        backgroundColor: ["#22c55e","#facc15","#ef4444"]
      }]
    }
  });


}

// ===============================
// 📊 UPDATE CHARTS
// ===============================
function updateCharts(revenueByDay, orders) {

  if (revenueChart) {
    revenueChart.data.datasets[0].data =
      Object.values(revenueByDay);
    revenueChart.update();
  }

  if (ordersChart) {
    ordersChart.data.datasets[0].data = [
      orders.completed,
      orders.pending,
      orders.cancelled
    ];
    ordersChart.update();
  }
}

// ===============================
// 🧰 UTILITY
// ===============================
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}


async function getNumberOfStoreVisitors(vendorId){
 
  try{
const snap = await getDoc(doc(db , "vendorVisitors" , vendorId));
const data = snap.data();

document.getElementById("kpiVisitorsAnalytics").innerText = data.visitors;
document.getElementById("kpiDashboardVisitors").innerText = data.visitors;
  }catch(e){
    console.warn(e)
  }

}

