// ============================================
// SHARED UTILITIES — VENDOR DASHBOARD
// ============================================

// ----- NOTIFICATION SYSTEM -----
(function() {
  const style = document.createElement("style");
  style.textContent = `
    #notif-container {
      position: fixed; top: 20px; right: 20px; z-index: 99999;
      display: flex; flex-direction: column; gap: 10px; pointer-events: none;
    }
    .notif {
      pointer-events: all; min-width: 280px; max-width: 360px;
      padding: 14px 16px; border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.08); background: #0d1117;
      display: flex; align-items: flex-start; gap: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      opacity: 0; transform: translateX(30px);
      transition: opacity 0.25s ease, transform 0.25s ease;
      position: relative; overflow: hidden;
    }
    .notif.show { opacity: 1; transform: translateX(0); }
    .notif.hide { opacity: 0; transform: translateX(30px); }
    .notif-icon { font-size: 18px; line-height: 1; flex-shrink: 0; margin-top: 1px; }
    .notif-body { flex: 1; }
    .notif-title { font-size: 13px; font-weight: 600; color: #f1f5f9; margin: 0 0 2px; }
    .notif-message { font-size: 12px; color: #94a3b8; margin: 0; line-height: 1.5; }
    .notif-close { background: none; border: none; color: #475569; cursor: pointer; font-size: 14px; padding: 0; line-height: 1; flex-shrink: 0; transition: color 0.15s; }
    .notif-close:hover { color: #94a3b8; }
    .notif-progress { position: absolute; bottom: 0; left: 0; height: 2px; border-radius: 0 0 14px 14px; width: 100%; transform-origin: left; animation: notif-shrink linear forwards; }
    @keyframes notif-shrink { from { transform: scaleX(1); } to { transform: scaleX(0); } }
    .notif.success { border-color: rgba(16,185,129,0.2); }
    .notif.success .notif-progress { background: #10b981; }
    .notif.error { border-color: rgba(239,68,68,0.2); }
    .notif.error .notif-progress { background: #ef4444; }
    .notif.warning { border-color: rgba(245,158,11,0.2); }
    .notif.warning .notif-progress { background: #f59e0b; }
    .notif.info { border-color: rgba(99,102,241,0.2); }
    .notif.info .notif-progress { background: #6366f1; }
  `;
  document.head.appendChild(style);

  const container = document.createElement("div");
  container.id = "notif-container";
  document.body.appendChild(container);

  const icons = { success: "✅", error: "❌", warning: "⚠️", info: "💬" };
  const titles = { success: "Success", error: "Error", warning: "Warning", info: "Info" };

  window.showNotif = function({ type = "info", title, message, duration = 4000 } = {}) {
    const notif = document.createElement("div");
    notif.className = `notif ${type}`;
    notif.innerHTML = `
      <span class="notif-icon">${icons[type]}</span>
      <div class="notif-body">
        <p class="notif-title">${title || titles[type]}</p>
        <p class="notif-message">${message}</p>
      </div>
      <button class="notif-close">✕</button>
      <div class="notif-progress" style="animation-duration:${duration}ms"></div>
    `;
    container.appendChild(notif);
    requestAnimationFrame(() => requestAnimationFrame(() => notif.classList.add("show")));

    const dismiss = () => {
      notif.classList.replace("show", "hide");
      notif.addEventListener("transitionend", () => notif.remove(), { once: true });
    };
    notif.querySelector(".notif-close").addEventListener("click", dismiss);
    setTimeout(dismiss, duration);
  };
})();

// ----- DIALOG SYSTEM -----
(function() {
  const style = document.createElement("style");
  style.textContent = `
    #app-dialog-overlay {
      position: fixed; inset: 0; z-index: 99998;
      background: rgba(0,0,0,0.6); backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center; padding: 20px;
      opacity: 0; pointer-events: none; transition: opacity 0.25s ease;
    }
    #app-dialog-overlay.open { opacity: 1; pointer-events: all; }
    #app-dialog-box {
      width: 100%; max-width: 400px; background: #0d1117;
      border: 1px solid rgba(255,255,255,0.08); border-radius: 20px;
      overflow: hidden; box-shadow: 0 24px 80px rgba(0,0,0,0.6);
      transform: scale(0.92) translateY(16px);
      transition: transform 0.3s cubic-bezier(0.34,1.56,0.64,1);
    }
    #app-dialog-overlay.open #app-dialog-box { transform: scale(1) translateY(0); }
    .dialog-visual {
      width: 100%; height: 100px; display: flex; align-items: center;
      justify-content: center; font-size: 44px; position: relative; overflow: hidden;
    }
    .dialog-visual::before { content: ''; position: absolute; inset: 0; opacity: 0.15; }
    .dialog-visual.type-warn  { background: #110d00; }
    .dialog-visual.type-warn::before  { background: radial-gradient(circle at 50% 100%, #f59e0b, transparent 70%); opacity: 0.4; }
    .dialog-visual.type-info  { background: #060d1f; }
    .dialog-visual.type-info::before  { background: radial-gradient(circle at 50% 100%, #6366f1, transparent 70%); opacity: 0.4; }
    .dialog-visual.type-danger { background: #130606; }
    .dialog-visual.type-danger::before { background: radial-gradient(circle at 50% 100%, #ef4444, transparent 70%); opacity: 0.4; }
    .dialog-visual.type-success { background: #051209; }
    .dialog-visual.type-success::before { background: radial-gradient(circle at 50% 100%, #10b981, transparent 70%); opacity: 0.4; }
    .dialog-emoji { position: relative; z-index: 1; filter: drop-shadow(0 4px 24px rgba(0,0,0,0.5)); animation: dialog-float 3s ease-in-out infinite; }
    @keyframes dialog-float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
    .dialog-body { padding: 20px 24px 16px; }
    .dialog-tag { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 3px 10px; border-radius: 20px; margin-bottom: 10px; }
    .dialog-tag.type-warn    { background: rgba(245,158,11,0.12); color: #f59e0b; }
    .dialog-tag.type-info    { background: rgba(99,102,241,0.12);  color: #818cf8; }
    .dialog-tag.type-danger  { background: rgba(239,68,68,0.12);   color: #f87171; }
    .dialog-tag.type-success { background: rgba(16,185,129,0.12);  color: #34d399; }
    .dialog-title { font-size: 17px; font-weight: 700; color: #f1f5f9; margin: 0 0 6px; line-height: 1.3; }
    .dialog-message { font-size: 13px; color: #64748b; margin: 0; line-height: 1.65; }
    .dialog-actions { display: flex; flex-direction: column; gap: 8px; padding: 0 24px 20px; }
    .dialog-btn { width: 100%; padding: 12px; border-radius: 12px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; transition: opacity 0.15s, transform 0.15s; }
    .dialog-btn:active { transform: scale(0.98); }
    .dialog-btn.primary { background: #6366f1; color: #fff; }
    .dialog-btn.primary:hover { opacity: 0.88; }
    .dialog-btn.secondary { background: rgba(255,255,255,0.05); color: #94a3b8; border: 1px solid rgba(255,255,255,0.07); }
    .dialog-btn.secondary:hover { background: rgba(255,255,255,0.08); }
    .dialog-btn.danger { background: rgba(239,68,68,0.12); color: #f87171; border: 1px solid rgba(239,68,68,0.15); }
    .dialog-btn.danger:hover { background: rgba(239,68,68,0.18); }
    .dialog-dismiss { position: absolute; top: 12px; right: 12px; width: 30px; height: 30px; border-radius: 50%; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08); color: #64748b; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: color 0.15s, background 0.15s; z-index: 2; }
    .dialog-dismiss:hover { background: rgba(255,255,255,0.08); color: #f1f5f9; }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement("div");
  overlay.id = "app-dialog-overlay";
  overlay.innerHTML = `
    <div id="app-dialog-box">
      <div class="dialog-visual" id="dialog-visual"><span class="dialog-emoji" id="dialog-emoji"></span></div>
      <button class="dialog-dismiss" id="dialog-dismiss">✕</button>
      <div class="dialog-body">
        <span class="dialog-tag" id="dialog-tag"></span>
        <h2 class="dialog-title" id="dialog-title"></h2>
        <p class="dialog-message" id="dialog-message"></p>
      </div>
      <div class="dialog-actions" id="dialog-actions"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeDialog(); });
  document.getElementById("dialog-dismiss").addEventListener("click", closeDialog);

  function closeDialog() { overlay.classList.remove("open"); }

  window.showDialog = function({ type = "info", emoji = "💬", tag = "", title = "", message = "", actions = [] } = {}) {
    document.getElementById("dialog-visual").className = `dialog-visual type-${type}`;
    document.getElementById("dialog-emoji").textContent = emoji;
    const tagEl = document.getElementById("dialog-tag");
    tagEl.className = `dialog-tag type-${type}`;
    tagEl.textContent = tag;
    tagEl.style.display = tag ? "inline-block" : "none";
    document.getElementById("dialog-title").textContent = title;
    document.getElementById("dialog-message").textContent = message;
    const actionsEl = document.getElementById("dialog-actions");
    actionsEl.innerHTML = "";
    actions.forEach(({ label, style = "secondary", onClick }) => {
      const btn = document.createElement("button");
      btn.className = `dialog-btn ${style}`;
      btn.textContent = label;
      btn.addEventListener("click", () => { closeDialog(); if (typeof onClick === "function") onClick(); });
      actionsEl.appendChild(btn);
    });
    overlay.classList.add("open");
  };
  window.closeDialog = closeDialog;
})();

// ----- LOADING DOTS -----
window.showLoadingDots = function(message = "Please wait...") {
  const bar = document.getElementById("loading-dots-bar");
  const msg = document.getElementById("loading-dots-message");
  if (msg) msg.textContent = message;
  if (bar) bar.classList.remove("hidden");
};

window.hideLoadingDots = function() {
  const bar = document.getElementById("loading-dots-bar");
  if (bar) bar.classList.add("hidden");
};

// ----- MODAL HELPERS -----
window.openModal = function(overlayId) {
  const overlay = document.getElementById(overlayId);
  if (!overlay) return;
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => {
    overlay.classList.add("open");
    const panel = overlay.querySelector("[id$='-modal'], #product-modal, #driver-modal, #assign-driver-modal");
    if (panel) panel.classList.remove("scale-95");
  });
};

window.closeModal = function(overlayId) {
  const overlay = document.getElementById(overlayId);
  if (!overlay) return;
  overlay.classList.remove("open");
  const panel = overlay.querySelector("[id$='-modal'], #product-modal, #driver-modal, #assign-driver-modal");
  if (panel) panel.classList.add("scale-95");
  setTimeout(() => overlay.classList.add("hidden"), 300);
};

// Attach close buttons to all modals
document.addEventListener("click", (e) => {
  if (e.target.classList.contains("modal-close-btn") || e.target.closest(".modal-close-btn")) {
    const overlay = e.target.closest("[id$='-overlay']");
    if (overlay) window.closeModal(overlay.id);
  }
  if (e.target.classList.contains("assign-close-btn")) {
    window.closeModal("assign-driver-overlay");
  }
});

// Close modals on overlay click
document.querySelectorAll("[id$='-overlay']").forEach(overlay => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) window.closeModal(overlay.id);
  });
});

// ----- FORMAT TIME AGO -----
window.formatTimeAgo = function(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} mins ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hrs ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
};

// -------------------------------------------------------------------------
// cachedGet — simple Map-based cache with TTL, dedupes in-flight requests
// -------------------------------------------------------------------------
const _cache = new Map(); // key -> { value, expiresAt }
const _inFlight = new Map(); // key -> Promise (dedupe concurrent calls)

const DEFAULT_TTL_MS = 30_000; // 30s — tune per call site if needed

export async function cachedGet(key, fetchFn, ttlMs = DEFAULT_TTL_MS) {
  const cached = _cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  // If a call for this key is already in flight, piggyback on it instead
  // of firing a duplicate request (e.g. two tabs mounting at once).
  if (_inFlight.has(key)) {
    return _inFlight.get(key);
  }

  const promise = (async () => {
    try {
      const value = await fetchFn();
      _cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      _inFlight.delete(key);
    }
  })();

  _inFlight.set(key, promise);
  return promise;
}

// Call this after any write that should invalidate a cached read
// (e.g. after handlePlanSelect succeeds, invalidateCache(`vault-summary:${vendorId}`))
export function invalidateCache(key) {
  _cache.delete(key);
  _inFlight.delete(key);
}

// Wipe everything — useful on logout
export function clearCache() {
  _cache.clear();
  _inFlight.clear();
}
