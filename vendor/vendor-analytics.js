// ============================================
// VENDOR DASHBOARD — ANALYTICS TAB
// ============================================

import {
  db, collection, query, where, orderBy,
  getDocs, getDoc, doc
} from './firebase-config.js';

// =========================
// CHART.JS — load once via CDN
// =========================
function loadChartJS() {
  return new Promise((resolve) => {
    if (window.Chart) return resolve();
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js";
    s.onload = resolve;
    document.head.appendChild(s);
  });
}

// =========================
// CHART INSTANCES (destroy before recreate)
// =========================
const _charts = {};

function destroyChart(id) {
  if (_charts[id]) {
    _charts[id].destroy();
    delete _charts[id];
  }
}

// =========================
// SHARED CHART DEFAULTS
// =========================
const CHART_DEFAULTS = {
  color: "rgba(255,255,255,0.5)",
  font: { family: "inherit", size: 11 },
  grid: "rgba(255,255,255,0.04)",
  accent: "#6366f1",        // indigo
  emerald: "#10b981",
  orange: "#f59e0b",
  pink: "#ec4899",
  purple: "#a855f7",
  blue: "#3b82f6",
  red: "#ef4444"
};

function baseScales(yLabel = "") {
  return {
    x: {
      grid: { color: CHART_DEFAULTS.grid },
      ticks: { color: CHART_DEFAULTS.color, font: CHART_DEFAULTS.font }
    },
    y: {
      grid: { color: CHART_DEFAULTS.grid },
      ticks: {
        color: CHART_DEFAULTS.color,
        font: CHART_DEFAULTS.font,
        callback: yLabel === "KSh"
          ? v => `KSh ${v.toLocaleString()}`
          : v => v
      },
      beginAtZero: true
    }
  };
}

function baseLegend() {
  return {
    labels: { color: CHART_DEFAULTS.color, font: CHART_DEFAULTS.font, boxWidth: 12, padding: 16 }
  };
}

function baseTooltip(prefix = "") {
  return {
    backgroundColor: "rgba(10,11,15,0.95)",
    borderColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    titleColor: "#fff",
    bodyColor: "rgba(255,255,255,0.6)",
    padding: 12,
    callbacks: prefix === "KSh"
      ? { label: ctx => ` KSh ${ctx.parsed.y?.toLocaleString() ?? ctx.parsed.toLocaleString()}` }
      : {}
  };
}

// =========================
// STATE
// =========================
let activePeriod = "daily";
let activeDate = new Date();
let analyticsLoaded = false;

// =========================
// ENTRY POINT
// =========================
window.loadAnalyticsTab = async function () {
  const vendorId = window.vendorId;
  if (!vendorId) return;

  await loadChartJS();

  // Init controls (once)
  if (!analyticsLoaded) {
    analyticsLoaded = true;
    initAnalyticsControls();
  }

  // Set today's date in picker if empty
  const datePicker = document.getElementById("analytics-date");
  if (datePicker && !datePicker.value) {
    datePicker.value = toDateString(new Date());
  }

  fetchAndRender();
};

// =========================
// INIT CONTROLS
// =========================
function initAnalyticsControls() {
  // Period buttons
  document.querySelectorAll(".period-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      activePeriod = btn.dataset.period;
      document.querySelectorAll(".period-btn").forEach(b => {
        b.classList.remove("bg-white/8", "text-white", "border-white/15");
        b.classList.add("text-white/40", "border-white/8");
      });
      btn.classList.add("bg-white/8", "text-white", "border-white/15");
      btn.classList.remove("text-white/40", "border-white/8");
      fetchAndRender();
    });
  });

  // Date picker
  document.getElementById("analytics-date")?.addEventListener("change", (e) => {
    activeDate = e.target.value ? new Date(e.target.value) : new Date();
    fetchAndRender();
  });

  // Print
  document.getElementById("print-report-btn")?.addEventListener("click", () => {
    window.print();
  });
}

// =========================
// FETCH & RENDER (all in parallel)
// =========================
async function fetchAndRender() {
  const vendorId = window.vendorId;
  if (!vendorId) return;

  showSkeletons();

  try {
    // Fetch completed orders and active orders in parallel
    const [historySnap, activeSnap] = await Promise.all([
      getDocs(query(
        collection(db, "orderingHistory"),
        where("vendor_id", "==", vendorId),
        orderBy("completedAt", "desc")
      )),
      getDocs(query(
        collection(db, "orders"),
        where("vendor_id", "==", vendorId)
      ))
    ]);

    const allCompleted = historySnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const allActive = activeSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Filter by selected period
    const filtered = filterByPeriod(allCompleted, activePeriod, activeDate);

    // Compute stats
    const totalRevenue = filtered.reduce((s, o) => s + (o.subtotal || 0), 0);
    const totalOrders = filtered.length;
    const avgOrder = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;
    const topDay = getTopDay(filtered);

    // Animate stat cards
    animateValue("an-revenue", totalRevenue, true);
    animateValue("an-orders", totalOrders, false);
    animateValue("an-avg", avgOrder, true);
    document.getElementById("an-top-day").textContent = topDay || "—";

    // Enrich product names in parallel (with cache)
    const enriched = await enrichOrders(filtered);

    // Render all 4 charts simultaneously
    renderRevenueChart(enriched, activePeriod);
    renderStatusChart(allActive);
    renderProductsChart(enriched);
    await renderDriversChart(allActive);

  } catch (err) {
    console.error("Analytics load failed:", err);
  }
}

// =========================
// PERIOD FILTER
// =========================
function filterByPeriod(orders, period, date) {
  return orders.filter(o => {
    const d = o.completedAt?.toDate?.() || new Date(o.completedAt || 0);
    if (period === "daily") {
      return isSameDay(d, date);
    } else if (period === "monthly") {
      return d.getFullYear() === date.getFullYear() && d.getMonth() === date.getMonth();
    } else {
      return d.getFullYear() === date.getFullYear();
    }
  });
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function toDateString(d) {
  return d.toISOString().split("T")[0];
}

// =========================
// TOP DAY
// =========================
function getTopDay(orders) {
  const dayMap = {};
  orders.forEach(o => {
    const d = o.completedAt?.toDate?.() || new Date(o.completedAt || 0);
    const key = d.toLocaleDateString("en-KE", { weekday: "short", month: "short", day: "numeric" });
    dayMap[key] = (dayMap[key] || 0) + (o.subtotal || 0);
  });
  if (!Object.keys(dayMap).length) return null;
  return Object.entries(dayMap).sort((a, b) => b[1] - a[1])[0][0];
}

// =========================
// ENRICH — product names (cached)
// =========================
const _nameCache = new Map();

async function enrichOrders(orders) {
  const uniqueProductIds = [...new Set(orders.map(o => o.product_id).filter(Boolean))];

  await Promise.all(uniqueProductIds.map(async (pid) => {
    if (_nameCache.has(pid)) return;
    try {
      const snap = await getDoc(doc(db, "products", pid));
      _nameCache.set(pid, snap.exists() ? (snap.data().name || "Product") : "Product");
    } catch {
      _nameCache.set(pid, "Product");
    }
  }));

  return orders.map(o => ({
    ...o,
    productName: _nameCache.get(o.product_id) || o.name || "Product"
  }));
}

// =========================
// ANIMATE STAT CARDS
// =========================
function animateValue(id, target, isCurrency) {
  const el = document.getElementById(id);
  if (!el) return;
  const duration = 900;
  const start = performance.now();

  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const val = Math.round(target * eased);
    el.textContent = isCurrency ? `KSh ${val.toLocaleString()}` : val.toLocaleString();
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// =========================
// SKELETON PLACEHOLDERS
// =========================
function showSkeletons() {
  ["an-revenue", "an-orders", "an-avg"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = "—";
  });
  document.getElementById("an-top-day").textContent = "—";
}

// =========================
// CHART 1 — REVENUE TREND (Line)
// =========================
function renderRevenueChart(orders, period) {
  destroyChart("revenue");
  const ctx = document.getElementById("chart-revenue");
  if (!ctx) return;

  let labels = [];
  let data = [];

  if (period === "daily") {
    // Hours 0–23
    const hourMap = Array(24).fill(0);
    orders.forEach(o => {
      const d = o.completedAt?.toDate?.() || new Date(o.completedAt || 0);
      hourMap[d.getHours()] += (o.subtotal || 0);
    });
    labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
    data = hourMap;

  } else if (period === "monthly") {
    const daysInMonth = new Date(activeDate.getFullYear(), activeDate.getMonth() + 1, 0).getDate();
    const dayMap = Array(daysInMonth).fill(0);
    orders.forEach(o => {
      const d = o.completedAt?.toDate?.() || new Date(o.completedAt || 0);
      dayMap[d.getDate() - 1] += (o.subtotal || 0);
    });
    labels = Array.from({ length: daysInMonth }, (_, i) => `${i + 1}`);
    data = dayMap;

  } else {
    // Yearly — months
    const monthMap = Array(12).fill(0);
    orders.forEach(o => {
      const d = o.completedAt?.toDate?.() || new Date(o.completedAt || 0);
      monthMap[d.getMonth()] += (o.subtotal || 0);
    });
    labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    data = monthMap;
  }

  const gradient = ctx.getContext("2d").createLinearGradient(0, 0, 0, 200);
  gradient.addColorStop(0, "rgba(99,102,241,0.35)");
  gradient.addColorStop(1, "rgba(99,102,241,0)");

  _charts["revenue"] = new window.Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Revenue",
        data,
        borderColor: CHART_DEFAULTS.accent,
        backgroundColor: gradient,
        borderWidth: 2.5,
        pointRadius: 3,
        pointHoverRadius: 6,
        pointBackgroundColor: CHART_DEFAULTS.accent,
        tension: 0.4,
        fill: true
      }]
    },
    options: {
      responsive: true,
      animation: { duration: 900, easing: "easeOutQuart" },
      plugins: {
        legend: { display: false },
        tooltip: baseTooltip("KSh")
      },
      scales: baseScales("KSh")
    }
  });
}

// =========================
// CHART 2 — ORDERS BY STATUS (Doughnut)
// =========================
function renderStatusChart(activeOrders) {
  destroyChart("status");
  const ctx = document.getElementById("chart-status");
  if (!ctx) return;

  const statusGroups = {
    pending: 0,
    confirmed: 0,
    assigned: 0,
    "out for delivery": 0,
    "proof uploaded": 0,
    packaging: 0,
    ready: 0,
    delivered: 0,
    "picked up": 0,
    cancelled: 0,
    paid: 0
  };

  activeOrders.forEach(o => {
    const s = o.status || "pending";
    if (s in statusGroups) statusGroups[s]++;
    else statusGroups[s] = (statusGroups[s] || 0) + 1;
  });

  // Filter out zeros
  const entries = Object.entries(statusGroups).filter(([, v]) => v > 0);
  const labels = entries.map(([k]) => k.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()));
  const data = entries.map(([, v]) => v);
  const colors = [
    CHART_DEFAULTS.orange, CHART_DEFAULTS.blue, CHART_DEFAULTS.purple,
    CHART_DEFAULTS.accent, CHART_DEFAULTS.pink, "#06b6d4",
    "#8b5cf6", CHART_DEFAULTS.emerald, "#14b8a6",
    CHART_DEFAULTS.red, "#22c55e"
  ];

  if (!data.length) {
    const c = ctx.getContext("2d");
    c.clearRect(0, 0, ctx.width, ctx.height);
    c.fillStyle = "rgba(255,255,255,0.15)";
    c.font = "13px inherit";
    c.textAlign = "center";
    c.fillText("No orders yet", ctx.width / 2, ctx.height / 2);
    return;
  }

  _charts["status"] = new window.Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors.slice(0, data.length),
        borderColor: "#111318",
        borderWidth: 3,
        hoverOffset: 10
      }]
    },
    options: {
      responsive: true,
      cutout: "65%",
      animation: { duration: 900, easing: "easeOutQuart" },
      plugins: {
        legend: { ...baseLegend(), position: "bottom" },
        tooltip: baseTooltip()
      }
    }
  });
}

// =========================
// CHART 3 — TOP PRODUCTS (Horizontal Bar)
// =========================
function renderProductsChart(orders) {
  destroyChart("products");
  const ctx = document.getElementById("chart-products");
  if (!ctx) return;

  const productMap = {};
  orders.forEach(o => {
    const name = o.productName || "Product";
    productMap[name] = (productMap[name] || 0) + (o.subtotal || 0);
  });

  const sorted = Object.entries(productMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const labels = sorted.map(([k]) => k.length > 20 ? k.slice(0, 18) + "…" : k);
  const data = sorted.map(([, v]) => v);

  const colors = [
    CHART_DEFAULTS.accent, CHART_DEFAULTS.emerald, CHART_DEFAULTS.orange,
    CHART_DEFAULTS.pink, CHART_DEFAULTS.purple, CHART_DEFAULTS.blue,
    "#14b8a6", "#f97316"
  ];

  if (!data.length) {
    ctx.getContext("2d").fillStyle = "rgba(255,255,255,0.15)";
    ctx.getContext("2d").font = "13px inherit";
    ctx.getContext("2d").textAlign = "center";
    ctx.getContext("2d").fillText("No data", ctx.width / 2, 100);
    return;
  }

  _charts["products"] = new window.Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Revenue",
        data,
        backgroundColor: colors.slice(0, data.length).map(c => c + "cc"),
        borderColor: colors.slice(0, data.length),
        borderWidth: 1.5,
        borderRadius: 8,
        borderSkipped: false
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      animation: { duration: 1000, easing: "easeOutQuart" },
      plugins: {
        legend: { display: false },
        tooltip: baseTooltip("KSh")
      },
      scales: {
        x: {
          grid: { color: CHART_DEFAULTS.grid },
          ticks: {
            color: CHART_DEFAULTS.color,
            font: CHART_DEFAULTS.font,
            callback: v => `KSh ${v >= 1000 ? (v / 1000).toFixed(1) + "k" : v}`
          },
          beginAtZero: true
        },
        y: {
          grid: { display: false },
          ticks: { color: CHART_DEFAULTS.color, font: CHART_DEFAULTS.font }
        }
      }
    }
  });
}

// =========================
// CHART 4 — DRIVER PERFORMANCE (Bar)
// =========================
async function renderDriversChart(activeOrders) {
  destroyChart("drivers");
  const ctx = document.getElementById("chart-drivers");
  if (!ctx) return;

  // Count deliveries per driverId
  const driverMap = {};
  activeOrders.forEach(o => {
    if (!o.driverId) return;
    driverMap[o.driverId] = (driverMap[o.driverId] || 0) + 1;
  });

  if (!Object.keys(driverMap).length) {
    const c = ctx.getContext("2d");
    c.fillStyle = "rgba(255,255,255,0.15)";
    c.font = "13px inherit";
    c.textAlign = "center";
    c.fillText("No driver data yet", ctx.width / 2, 100);
    return;
  }

  // Resolve driver names in parallel
  const driverIds = Object.keys(driverMap);
  const nameMap = {};

  await Promise.all(driverIds.map(async (id) => {
    try {
      const snap = await getDoc(doc(db, "drivers", id));
      nameMap[id] = snap.exists() ? (snap.data().name || "Driver") : "Driver";
    } catch {
      nameMap[id] = "Driver";
    }
  }));

  const sorted = Object.entries(driverMap)
    .map(([id, count]) => ({ name: nameMap[id], count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const labels = sorted.map(d => d.name.length > 14 ? d.name.slice(0, 12) + "…" : d.name);
  const data = sorted.map(d => d.count);

  _charts["drivers"] = new window.Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Deliveries",
        data,
        backgroundColor: "rgba(168,85,247,0.25)",
        borderColor: CHART_DEFAULTS.purple,
        borderWidth: 2,
        borderRadius: 8,
        borderSkipped: false
      }]
    },
    options: {
      responsive: true,
      animation: { duration: 1000, easing: "easeOutQuart" },
      plugins: {
        legend: { display: false },
        tooltip: baseTooltip()
      },
      scales: baseScales()
    }
  });
}