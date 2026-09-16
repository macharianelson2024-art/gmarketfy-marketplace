// ─────────────────────────────────────────────
//  DELIVERY PANELS — Driver + Proof
//  Drop this file in your project and call:
//    openDriverPanel(driverId)
//    openProofPanel(orderId)
// ─────────────────────────────────────────────

import {
  db, collection, query, where, orderBy, getDocs,
  Timestamp, getDoc, doc, updateDoc, setDoc,
  auth, onAuthStateChanged, onSnapshot, deleteDoc
} from './firebase-config.js'


// ── 1. INJECT STYLES (once) ──────────────────
function injectDeliveryStyles() {
  if (document.getElementById("dp-styles")) return;
  document.head.insertAdjacentHTML("beforeend", `
  <style id="dp-styles">
    #dp-driver-overlay,
    #dp-proof-overlay {
      position: fixed;
      inset: 0;
      z-index: 400;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0);
      backdrop-filter: blur(0px);
      pointer-events: none;
      transition: background 0.3s ease, backdrop-filter 0.3s ease;
    }
    #dp-driver-overlay.dp-active,
    #dp-proof-overlay.dp-active {
      background: rgba(0,0,0,0.65);
      backdrop-filter: blur(8px);
      pointer-events: all;
    }

    .dp-panel {
      width: 100%;
      max-width: 460px;
      background: #111318;
      border-radius: 24px;
      border: 1px solid rgba(255,255,255,0.07);
      overflow: hidden;
      transform: scale(0.92) translateY(12px);
      opacity: 0;
      transition: transform 0.42s cubic-bezier(0.34,1.56,0.64,1),
                  opacity 0.3s cubic-bezier(0.16,1,0.3,1);
      max-height: 92vh;
      display: flex;
      flex-direction: column;
      margin: 16px;
    }
    .dp-panel.dp-open {
      transform: scale(1) translateY(0);
      opacity: 1;
    }

    .dp-drag-handle {
      width: 36px;
      height: 4px;
      border-radius: 99px;
      background: rgba(255,255,255,0.12);
      margin: 12px auto 0;
      flex-shrink: 0;
    }

    .dp-panel-header {
      padding: 16px 20px 0;
      flex-shrink: 0;
    }
    .dp-panel-header-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .dp-title-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .dp-panel-icon {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 17px;
    }
    .dp-panel-title {
      font-size: 15px;
      font-weight: 600;
      color: #f0f2f8;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .dp-close-btn {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: #1e2129;
      border: 1px solid rgba(255,255,255,0.07);
      color: #9ca3af;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.15s, color 0.15s, transform 0.2s;
      line-height: 1;
    }
    .dp-close-btn:hover {
      background: #181b22;
      color: #f0f2f8;
      transform: rotate(90deg);
    }

    /* ── DRIVER HERO ── */
    .dp-driver-hero {
      padding: 0 20px 20px;
      display: flex;
      align-items: center;
      gap: 16px;
      border-bottom: 1px solid rgba(255,255,255,0.07);
      flex-shrink: 0;
    }
    .dp-avatar-wrap { position: relative; flex-shrink: 0; }
    .dp-avatar {
      width: 68px;
      height: 68px;
      border-radius: 18px;
      object-fit: cover;
      border: 2px solid rgba(255,255,255,0.12);
      cursor: pointer;
      transition: transform 0.2s, border-color 0.2s;
      display: block;
    }
    .dp-avatar:hover {
      transform: scale(1.04);
      border-color: #818cf8;
    }
    .dp-avatar-ring {
      position: absolute;
      inset: -3px;
      border-radius: 21px;
      border: 1.5px solid #6366f1;
      opacity: 0;
      transform: scale(1.1);
      pointer-events: none;
      transition: opacity 0.2s, transform 0.3s cubic-bezier(0.16,1,0.3,1);
    }
    .dp-avatar-wrap:hover .dp-avatar-ring {
      opacity: 0.5;
      transform: scale(1);
    }
    .dp-driver-name {
      font-size: 17px;
      font-weight: 600;
      color: #f0f2f8;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dp-status-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      margin-top: 4px;
      font-size: 11px;
      font-weight: 500;
      padding: 3px 9px;
      border-radius: 99px;
      letter-spacing: 0.03em;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .dp-status-badge.on-road {
      background: rgba(245,158,11,0.15);
      color: #fcd34d;
      border: 1px solid rgba(245,158,11,0.2);
    }
    .dp-status-badge.offline {
      background: rgba(107,114,128,0.15);
      color: #9ca3af;
      border: 1px solid rgba(107,114,128,0.2);
    }
    .dp-status-badge.available {
      background: rgba(16,185,129,0.15);
      color: #6ee7b7;
      border: 1px solid rgba(16,185,129,0.2);
    }
    .dp-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }

    /* ── PANEL BODY ── */
    .dp-panel-body {
      overflow-y: auto;
      flex: 1;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .dp-panel-body::-webkit-scrollbar { width: 0; }

    /* ── INFO GRID ── */
    .dp-info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .dp-info-cell {
      background: #181b22;
      border-radius: 13px;
      padding: 12px 14px;
      border: 1px solid rgba(255,255,255,0.07);
      transition: background 0.15s;
    }
    .dp-info-cell:hover { background: #1e2129; }
    .dp-info-cell.dp-full { grid-column: 1 / -1; }
    .dp-info-label {
      font-size: 10px;
      color: #6b7280;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 5px;
      font-family: 'JetBrains Mono', 'Courier New', monospace;
    }
    .dp-info-value {
      font-size: 14px;
      color: #9ca3af;
      font-weight: 500;
      line-height: 1.4;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }

    /* ── NOTE BOX ── */
    .dp-note-box {
      background: rgba(99,102,241,0.06);
      border: 1px solid rgba(99,102,241,0.15);
      border-radius: 13px;
      padding: 14px;
    }
    .dp-note-label {
      font-size: 10px;
      color: rgba(165,180,252,0.6);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 6px;
      font-family: 'JetBrains Mono', 'Courier New', monospace;
    }
    .dp-note-text {
      font-size: 13px;
      color: #c7d2fe;
      line-height: 1.6;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }

    /* ── PROOF CONTENT ── */
    .dp-proof-img-wrap {
      border-radius: 16px;
      overflow: hidden;
      position: relative;
      background: #181b22;
      border: 1px solid rgba(255,255,255,0.07);
      cursor: pointer;
    }
    .dp-proof-img-wrap::after {
      content: '🔍  View full size';
      position: absolute;
      bottom: 0; left: 0; right: 0;
      padding: 32px 16px 14px;
      background: linear-gradient(transparent, rgba(0,0,0,0.72));
      font-size: 12px;
      color: rgba(255,255,255,0.75);
      font-weight: 500;
      opacity: 0;
      transition: opacity 0.2s;
      letter-spacing: 0.03em;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .dp-proof-img-wrap:hover::after { opacity: 1; }
    .dp-proof-img {
      width: 100%;
      max-height: 300px;
      object-fit: cover;
      display: block;
      transition: transform 0.3s cubic-bezier(0.16,1,0.3,1);
    }
    .dp-proof-img-wrap:hover .dp-proof-img { transform: scale(1.02); }

    .dp-caption-box {
      background: #181b22;
      border-radius: 13px;
      padding: 12px 14px;
      border: 1px solid rgba(255,255,255,0.07);
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }
    .dp-caption-icon { font-size: 14px; margin-top: 1px; opacity: 0.6; }
    .dp-caption-text {
      font-size: 13px;
      color: #9ca3af;
      line-height: 1.6;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }

    /* ── LOADING ── */
    .dp-loading {
      padding: 40px 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
    }
    .dp-spinner {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 2px solid rgba(255,255,255,0.12);
      border-top-color: #818cf8;
      animation: dp-spin 0.7s linear infinite;
    }
    .dp-spinner.dp-green { border-top-color: #34d399; }
    @keyframes dp-spin { to { transform: rotate(360deg); } }
    .dp-loading-text {
      font-size: 13px;
      color: #6b7280;
      font-family: 'JetBrains Mono', 'Courier New', monospace;
    }

    /* ── LIGHTBOX ── */
    #dp-lightbox {
      position: fixed;
      inset: 0;
      z-index: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0.85);
      backdrop-filter: blur(12px);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s;
    }
    #dp-lightbox.dp-open {
      opacity: 1;
      pointer-events: all;
    }
    #dp-lightbox-img {
      max-width: 90%;
      max-height: 88vh;
      border-radius: 16px;
      transform: scale(0.9);
      transition: transform 0.35s cubic-bezier(0.34,1.56,0.64,1);
      box-shadow: 0 40px 80px rgba(0,0,0,0.8);
      object-fit: contain;
    }
    #dp-lightbox.dp-open #dp-lightbox-img { transform: scale(1); }
    #dp-lightbox-close {
      position: absolute;
      top: 20px; right: 20px;
      width: 36px; height: 36px;
      border-radius: 50%;
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(4px);
      border: 1px solid rgba(255,255,255,0.15);
      color: rgba(255,255,255,0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      transition: background 0.15s, transform 0.2s;
    }
    #dp-lightbox-close:hover {
      background: rgba(255,255,255,0.2);
      transform: rotate(90deg);
    }
  </style>
  `);
}

// ── 2. INJECT DRIVER PANEL HTML (once) ───────
function injectDriverPanel() {
  if (document.getElementById("dp-driver-overlay")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="dp-driver-overlay">
      <div class="dp-panel" id="dp-driver-panel">

        <div class="dp-drag-handle"></div>

        <div class="dp-panel-header">
          <div class="dp-panel-header-top">
            <div class="dp-title-group">
              <div class="dp-panel-icon" style="background:rgba(99,102,241,0.15)">🚚</div>
              <span class="dp-panel-title">Driver Profile</span>
            </div>
            <button class="dp-close-btn" onclick="closeDriverPanel()">✕</button>
          </div>

          <div class="dp-driver-hero">
            <div class="dp-avatar-wrap">
              <img class="dp-avatar" id="dp-driver-avatar" src="" alt="Driver photo"
                onclick="dpOpenLightbox(this.src)" />
              <div class="dp-avatar-ring"></div>
            </div>
            <div style="flex:1;min-width:0">
              <div class="dp-driver-name" id="dp-driver-name">—</div>
              <div class="dp-status-badge" id="dp-driver-status"></div>
            </div>
          </div>
        </div>

        <div class="dp-loading" id="dp-driver-loading">
          <div class="dp-spinner"></div>
          <span class="dp-loading-text">fetching driver…</span>
        </div>

        <div class="dp-panel-body" id="dp-driver-body" style="display:none">
          <div class="dp-info-grid">
            <div class="dp-info-cell">
              <div class="dp-info-label">Phone</div>
              <div class="dp-info-value" id="dp-driver-phone">—</div>
            </div>
            <div class="dp-info-cell">
              <div class="dp-info-label">Vehicle</div>
              <div class="dp-info-value" id="dp-driver-vehicle">—</div>
            </div>
            <div class="dp-info-cell dp-full">
              <div class="dp-info-label">Plate number</div>
              <div class="dp-info-value" id="dp-driver-plate">—</div>
            </div>
          </div>
          <div class="dp-note-box">
            <div class="dp-note-label">Note</div>
            <div class="dp-note-text" id="dp-driver-note">—</div>
          </div>
        </div>

      </div>
    </div>
  `);

  // close on backdrop click
  document.getElementById("dp-driver-overlay").addEventListener("click", (e) => {
    if (e.target.id === "dp-driver-overlay") closeDriverPanel();
  });
}

// ── 3. INJECT PROOF PANEL HTML (once) ────────
function injectProofPanel() {
  if (document.getElementById("dp-proof-overlay")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="dp-proof-overlay">
      <div class="dp-panel" id="dp-proof-panel">

        <div class="dp-drag-handle"></div>

        <div class="dp-panel-header">
          <div class="dp-panel-header-top">
            <div class="dp-title-group">
              <div class="dp-panel-icon" style="background:rgba(16,185,129,0.12)">📸</div>
              <span class="dp-panel-title" style="color:#a7f3d0">Delivery Proof</span>
            </div>
            <button class="dp-close-btn" onclick="closeProofPanel()">✕</button>
          </div>
        </div>

        <div class="dp-loading" id="dp-proof-loading">
          <div class="dp-spinner dp-green"></div>
          <span class="dp-loading-text">loading proof…</span>
        </div>

        <div class="dp-panel-body" id="dp-proof-body" style="display:none">
          <div class="dp-proof-img-wrap"
            onclick="dpOpenLightbox(document.getElementById('dp-proof-img').src)">
            <img class="dp-proof-img" id="dp-proof-img" src="" alt="Delivery proof photo" />
          </div>
          <div class="dp-caption-box">
            <span class="dp-caption-icon">💬</span>
            <span class="dp-caption-text" id="dp-proof-caption">—</span>
          </div>
        </div>

      </div>
    </div>
  `);

  document.getElementById("dp-proof-overlay").addEventListener("click", (e) => {
    if (e.target.id === "dp-proof-overlay") closeProofPanel();
  });
}

// ── 4. INJECT LIGHTBOX (once) ────────────────
function injectLightbox() {
  if (document.getElementById("dp-lightbox")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="dp-lightbox" onclick="dpCloseLightbox()">
      <button id="dp-lightbox-close" onclick="dpCloseLightbox()">✕</button>
      <img id="dp-lightbox-img" src="" alt="Full size preview" onclick="event.stopPropagation()" />
    </div>
  `);
}

// ── 5. OVERLAY OPEN / CLOSE HELPERS ──────────
function dpOpenOverlay(overlayId, panelId) {
  const ov = document.getElementById(overlayId);
  const pn = document.getElementById(panelId);
  ov.classList.add("dp-active");
  // double rAF ensures transition triggers after display
  requestAnimationFrame(() => {
    requestAnimationFrame(() => pn.classList.add("dp-open"));
  });
}

function dpCloseOverlay(overlayId, panelId) {
  const ov = document.getElementById(overlayId);
  const pn = document.getElementById(panelId);
  pn.classList.remove("dp-open");
  setTimeout(() => ov.classList.remove("dp-active"), 320);
}

function closeDriverPanel() {
  dpCloseOverlay("dp-driver-overlay", "dp-driver-panel");
}

function closeProofPanel() {
  dpCloseOverlay("dp-proof-overlay", "dp-proof-panel");
}

// ── 6. OPEN DRIVER PANEL ─────────────────────
async function openDriverPanel(driverId) {
  if(!driverId || driverId === "undefined") {
    window.showNotif?.({ type: "error", title: "Error", message: "could not process request." });
    return;
  }

  console.log(driverId);
  
  injectDeliveryStyles();
  injectDriverPanel();
  injectLightbox();

  const loading = document.getElementById("dp-driver-loading");
  const body    = document.getElementById("dp-driver-body");

  loading.style.display = "flex";
  body.style.display    = "none";

  dpOpenOverlay("dp-driver-overlay", "dp-driver-panel");

  try {
    
    const snap = await getDoc(doc(db, "drivers", driverId));

    if (!snap.exists()) {
      window.showNotif?.({ type: "error", title: "Not found", message: "Driver not found." });
      closeDriverPanel();
      return;
    }

    const d = snap.data();

    // avatar
    document.getElementById("dp-driver-avatar").src =
      d?.image ||
      `https://ui-avatars.com/api/?name=${encodeURIComponent(d?.name || "Driver")}&background=3730a3&color=c7d2fe&size=128`;

    // name
    document.getElementById("dp-driver-name").textContent = d?.name || "Unknown Driver";

    // status badge
    const statusMap = {
      "on-road":   ["on-road",   "🟠 On road"],
      "offline":   ["offline",   "⚫ Offline"],
      "available": ["available", "🟢 Available"],
    };
    const [cls, label] = statusMap[d?.status] || ["offline", "⚫ Offline"];
    const badge = document.getElementById("dp-driver-status");
    badge.className = `dp-status-badge ${cls}`;
    badge.innerHTML = `<span class="dp-status-dot"></span> ${label.split(" ").slice(1).join(" ")}`;

    // info cells
    document.getElementById("dp-driver-phone").textContent   = d?.phone        || "N/A";
    document.getElementById("dp-driver-vehicle").textContent = d?.vehicleType   || "N/A";
    document.getElementById("dp-driver-plate").textContent   = d?.plateNumber   || "N/A";
    document.getElementById("dp-driver-note").textContent    = d?.note          || "—";

  } catch (err) {
    console.error("openDriverPanel error:", err);
    window.showNotif?.({ type: "error", title: "Error", message: "Failed to load driver." });
  }

  loading.style.display = "none";
  body.style.display    = "flex";
}

// ── 7. OPEN PROOF PANEL ──────────────────────
async function openProofPanel(orderId) {
  injectDeliveryStyles();
  injectProofPanel();
  injectLightbox();

  const loading = document.getElementById("dp-proof-loading");
  const body    = document.getElementById("dp-proof-body");

  loading.style.display = "flex";
  body.style.display    = "none";

  dpOpenOverlay("dp-proof-overlay", "dp-proof-panel");

  // always reset stale data
  document.getElementById("dp-proof-img").src           = "";
  document.getElementById("dp-proof-caption").textContent = "";

  try {
    const snap = await getDoc(doc(db, "proofs", orderId));

    if (!snap.exists()) {
      document.getElementById("dp-proof-caption").textContent = "No proof found for this order.";
      loading.style.display = "none";
      body.style.display    = "flex";
      return;
    }

    const data = snap.data();
    document.getElementById("dp-proof-img").src             = data?.image   || "";
    document.getElementById("dp-proof-caption").textContent = data?.caption || "—";

  } catch (err) {
    console.error("openProofPanel error:", err);
    document.getElementById("dp-proof-caption").textContent = "Failed to load proof.";
  }

  loading.style.display = "none";
  body.style.display    = "flex";
}

// ── 8. LIGHTBOX ──────────────────────────────
function dpOpenLightbox(src) {
  if (!src) return;
  injectLightbox();
  document.getElementById("dp-lightbox-img").src = src;
  document.getElementById("dp-lightbox").classList.add("dp-open");
}

function dpCloseLightbox() {
  document.getElementById("dp-lightbox")?.classList.remove("dp-open");
}

// ── 9. GETRELEVANTDELIVERYINFO (unchanged API) 
function getRelevantDeliveryInfo(order, orderId) {
  if (!order.delivery?.enabled) return "";

  const blocks = [];

  // Driver row: show while a driver is associated with a live delivery
  const DRIVER_VISIBLE_STATUSES = [
    "assigned",
    "out for delivery",
    "proof uploaded",
    "delivered",
  ];
  if (DRIVER_VISIBLE_STATUSES.includes(order.status) && order.driverId) {
    blocks.push(`
      <div class="dp-action-row dp-action-driver"
           data-driver-id="${order.driverId}"
           onclick="openDriverPanel('${order.driverId}')">
        <div class="dp-action-left">
          <div class="dp-action-icon dp-icon-driver">🚚</div>
          <span class="dp-action-label dp-label-driver">View delivery personnel</span>
        </div>
        <span class="dp-action-chevron">›</span>
      </div>
    `);
  }

  // Proof row: show from the moment proof exists through completion
  const PROOF_VISIBLE_STATUSES = [
    "proof uploaded",
    "delivered",
    "paid & delivered",
  ];
  if (PROOF_VISIBLE_STATUSES.includes(order.status)) {
    blocks.push(`
      <div class="dp-action-row dp-action-proof"
           data-proof-id="${orderId}"
           onclick="openProofPanel('${orderId}')">
        <div class="dp-action-left">
          <div class="dp-action-icon dp-icon-proof">📸</div>
          <span class="dp-action-label dp-label-proof">View delivery proof</span>
        </div>
        <span class="dp-action-chevron dp-chevron-proof">›</span>
      </div>
    `);
  }

  // Inject action row styles once
  if (!document.getElementById("dp-action-styles")) {
    document.head.insertAdjacentHTML("beforeend", `
      <style id="dp-action-styles">
        .dp-action-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 11px 14px;
          border-radius: 12px;
          cursor: pointer;
          border: 1px solid transparent;
          transition: background 0.18s, border-color 0.18s, transform 0.15s;
          position: relative;
          overflow: hidden;
          margin-bottom: 8px;
        }
        .dp-action-row:active { transform: scale(0.98); }
        .dp-action-driver {
          background: rgba(99,102,241,0.07);
          border-color: rgba(99,102,241,0.15);
        }
        .dp-action-driver:hover {
          background: rgba(99,102,241,0.12);
          border-color: rgba(99,102,241,0.25);
        }
        .dp-action-proof {
          background: rgba(16,185,129,0.07);
          border-color: rgba(16,185,129,0.15);
        }
        .dp-action-proof:hover {
          background: rgba(16,185,129,0.12);
          border-color: rgba(16,185,129,0.25);
        }
        .dp-action-left {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .dp-action-icon {
          width: 32px; height: 32px;
          border-radius: 9px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 15px;
          flex-shrink: 0;
        }
        .dp-icon-driver { background: rgba(99,102,241,0.2); }
        .dp-icon-proof  { background: rgba(16,185,129,0.2); }
        .dp-action-label {
          font-size: 13px;
          font-weight: 500;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        .dp-label-driver { color: #c7d2fe; }
        .dp-label-proof  { color: #a7f3d0; }
        .dp-action-chevron {
          font-size: 16px;
          color: #6b7280;
          transition: transform 0.2s cubic-bezier(0.16,1,0.3,1);
        }
        .dp-action-row:hover .dp-action-chevron { transform: translateX(3px); }
      </style>
    `);
  }

  return blocks.join("");
}


window.getRelevantDeliveryInfo = getRelevantDeliveryInfo;
window.openDriverPanel = openDriverPanel;
window.openProofPanel = openProofPanel;
window.dpOpenLightbox = dpOpenLightbox;
window.dpCloseLightbox = dpCloseLightbox;
window.closeDriverPanel = closeDriverPanel;
window.closeProofPanel = closeProofPanel;


// ── 10. ESCAPE KEY ───────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    dpCloseLightbox();
    closeDriverPanel();
    closeProofPanel();
  }
});
