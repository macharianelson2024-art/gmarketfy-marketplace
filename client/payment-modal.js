/**
 * payment-modal.js
 * -----------------------------------------------------------------------
 * Animated modal shown when a client pays for an order.
 *
 * States: confirm → sending → awaiting_pin → success | failed | timeout
 *
 * Talks to Django for status (polling), not Firestore — Firestore updates
 * the order doc via the callback, and the pending list already listens
 * for that via onSnapshot. This modal is purely about "did the money
 * leave the client's phone yet?"
 * -----------------------------------------------------------------------
 */

import { auth } from "./firebase-config.js";

// ----- API base (matches vendor-vault.js pattern) -----
const API_ORIGIN =
  window.location.origin.includes(":5500")
    ? "http://127.0.0.1:8000"
    : "";

// ----- Polling config -----
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 90000;      // hard timeout on visible poll
const BACKGROUND_POLL_MS = 60000;   // if user closes mid-flight, keep polling this long

// ----- Module state -----
let modalEls = null;
let pollTimer = null;
let pollStartedAt = 0;
let backgroundPollUntil = 0;
let current = null;    // { order, phone, transactionReference }

// -------------------------------------------------------------------------
// Styles — injected once
// -------------------------------------------------------------------------
function injectStyles() {
  if (document.getElementById("payment-modal-styles")) return;
  const style = document.createElement("style");
  style.id = "payment-modal-styles";
  style.textContent = `
    @keyframes pm-ring-pulse {
      0%   { transform: scale(0.85); opacity: 0.55; }
      100% { transform: scale(1.7);  opacity: 0; }
    }
    @keyframes pm-dot {
      0%, 80%, 100% { transform: scale(0.6); opacity: 0.35; }
      40%           { transform: scale(1);   opacity: 1; }
    }
    @keyframes pm-check-draw {
      from { stroke-dashoffset: 100; }
      to   { stroke-dashoffset: 0; }
    }
    @keyframes pm-phone-ring {
      0%, 100% { transform: rotate(0deg); }
      20%      { transform: rotate(-9deg); }
      40%      { transform: rotate(9deg); }
      60%      { transform: rotate(-6deg); }
      80%      { transform: rotate(6deg); }
    }
    @keyframes pm-fade-up {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .pm-anim-fade-up { animation: pm-fade-up 0.35s ease-out both; }
    .pm-ring-pulse   { animation: pm-ring-pulse 1.9s ease-out infinite; }
    .pm-phone-ring   { animation: pm-phone-ring 1.6s ease-in-out infinite; transform-origin: 50% 50%; }
    .pm-dot          { animation: pm-dot 1.2s ease-in-out infinite; }
    .pm-dot:nth-child(2) { animation-delay: 0.15s; }
    .pm-dot:nth-child(3) { animation-delay: 0.3s; }
    .pm-check-path   { stroke-dasharray: 100; animation: pm-check-draw 0.6s ease-out forwards; }
  `;
  document.head.appendChild(style);
}

// -------------------------------------------------------------------------
// Modal shell — created once
// -------------------------------------------------------------------------
function ensureModal() {
  if (modalEls) return modalEls;

  const overlay = document.createElement("div");
  overlay.id = "payment-modal-overlay";
  overlay.className =
    "fixed inset-0 z-[80] bg-black/60 backdrop-blur-md hidden opacity-0 " +
    "transition-opacity duration-300 flex items-end sm:items-center justify-center";

  const panel = document.createElement("div");
  panel.id = "payment-modal-panel";
  panel.className =
    "w-full sm:max-w-md bg-[#0f1115] border border-white/5 sm:rounded-[2rem] " +
    "rounded-t-3xl p-6 md:p-8 translate-y-full sm:translate-y-0 sm:scale-95 " +
    "transition-all duration-300 max-h-[88vh] overflow-y-auto shadow-2xl";

  const body = document.createElement("div");
  body.id = "payment-modal-body";

  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) tryClose();
  });

  modalEls = { overlay, panel, body };
  return modalEls;
}

function openModal() {
  const { overlay, panel } = ensureModal();
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => {
    overlay.classList.remove("opacity-0");
    panel.classList.remove("translate-y-full", "sm:scale-95");
  });
}

function closeModal() {
  if (!modalEls) return;
  const { overlay, panel } = modalEls;

  // If we're still in-flight, keep polling in the background so a
  // late-landing callback can still notify the user.
  if (pollTimer && current?.transactionReference) {
    backgroundPollUntil = Date.now() + BACKGROUND_POLL_MS;
  } else {
    stopPoll();
  }

  overlay.classList.add("opacity-0");
  panel.classList.add("translate-y-full", "sm:scale-95");
  setTimeout(() => {
    overlay.classList.add("hidden");
    modalEls.body.innerHTML = "";
  }, 300);

  // Note: `current` is intentionally not cleared here — background poll needs it.
  if (!pollTimer) current = null;
}

function tryClose() {
  // Always allowed. If polling, it'll continue in background.
  closeModal();
}

// -------------------------------------------------------------------------
// Public entry point
// -------------------------------------------------------------------------
export function openPaymentModal(order) {
  injectStyles();

  current = {
    order,
    phone: resolveInitialPhone(order),
    phoneMode: resolveInitialPhone(order) ? "saved" : "custom",
    transactionReference: null,
  };

  stopPoll();
  openModal();
  setState("confirm");
}

// -------------------------------------------------------------------------
// Phone helpers
// -------------------------------------------------------------------------
function resolveInitialPhone(order) {
  const p = order?.delivery?.address?.phoneNumber;
  return typeof p === "string" && p.trim() ? p.trim() : null;
}

function normalizePhone(raw) {
  const p = String(raw || "").replace(/[\s-]/g, "");
  if (/^\+254\d{9}$/.test(p)) return "254" + p.slice(4);
  if (/^0\d{9}$/.test(p))     return "254" + p.slice(1);
  if (/^254\d{9}$/.test(p))   return p;
  return null;
}

function formatPhoneDisplay(p) {
  if (!p) return "";
  const n = normalizePhone(p);
  if (!n) return p;
  return `0${n.slice(3, 6)} ${n.slice(6, 9)} ${n.slice(9, 12)}`;
}

// -------------------------------------------------------------------------
// Rendering — one function per state
// -------------------------------------------------------------------------
function setState(name, payload = {}) {
  if (!modalEls) return;
  const renderers = {
    confirm: renderConfirm,
    sending: renderSending,
    awaiting_pin: renderAwaitingPin,
    success: renderSuccess,
    failed: renderFailed,
    timeout: renderTimeout,
  };
  modalEls.body.innerHTML = renderers[name](payload);
  modalEls.body.classList.remove("pm-anim-fade-up");
  void modalEls.body.offsetWidth;   // restart animation
  modalEls.body.classList.add("pm-anim-fade-up");
  bindEvents(name, payload);
}

function header(title, subtitle, closable = true) {
  return `
    <div class="flex items-start justify-between mb-6">
      <div>
        <h2 class="text-xl font-extrabold text-white tracking-tight">${title}</h2>
        ${subtitle ? `<p class="text-slate-500 text-xs mt-1 font-medium">${subtitle}</p>` : ""}
      </div>
      ${closable ? `
        <button class="pm-close-btn w-10 h-10 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 transition text-white/60 hover:text-white shrink-0">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>` : ""}
    </div>`;
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatKsh(n) {
  const num = Number(n) || 0;
  return `KSh ${num.toLocaleString("en-KE")}`;
}

// ---- confirm -------------------------------------------------------------
function renderConfirm() {
  const { order, phone, phoneMode } = current;
  const savedPhone = resolveInitialPhone(order);
  const showChoice = savedPhone && phoneMode === "saved";

  return `
    ${header("Complete payment", "Confirm the amount and number")}

    <!-- Order summary -->
    <div class="rounded-2xl bg-white/[0.03] border border-white/5 p-4 mb-5">
      <div class="flex items-center gap-3 mb-3 pb-3 border-b border-white/5">
        <div class="w-11 h-11 rounded-xl bg-white/5 flex-shrink-0 overflow-hidden">
          ${order.image ? `<img src="${escHtml(order.image)}" class="w-full h-full object-cover" onerror="this.style.opacity='0'"/>` : ""}
        </div>
        <div class="min-w-0">
          <p class="text-sm font-semibold text-white truncate">${escHtml(order.name || "Order")}</p>
          <p class="text-xs text-white/40 truncate">🏪 ${escHtml(order.vendorName || "Vendor")} · x${escHtml(order.quantity)}</p>
        </div>
      </div>
      <div class="flex justify-between text-sm">
        <span class="text-white/50">Total</span>
        <span class="font-black text-white">${formatKsh(order.subtotal)}</span>
      </div>
    </div>

    <!-- Phone selection -->
    <div class="mb-5">
      <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">M-Pesa number</label>

      ${showChoice ? `
        <div class="space-y-2">
          <button class="pm-use-saved-btn w-full flex items-center justify-between px-4 h-12 rounded-xl bg-white/[0.03] border border-indigo-500/40 hover:border-indigo-500/70 transition text-left">
            <div>
              <p class="text-sm font-semibold text-white">${escHtml(formatPhoneDisplay(savedPhone))}</p>
              <p class="text-[10px] text-indigo-300">Saved on this order</p>
            </div>
            <span class="text-indigo-400 text-lg">✓</span>
          </button>
          <button class="pm-use-other-btn w-full px-4 h-12 rounded-xl bg-white/[0.02] border border-white/10 hover:border-white/20 transition text-sm font-semibold text-white/60">
            Use a different number
          </button>
        </div>
      ` : `
        <input id="pm-phone-input" type="tel" inputmode="numeric"
          class="w-full px-4 bg-white/[0.03] border border-white/10 rounded-xl text-white text-sm outline-none focus:border-indigo-500/50 h-12"
          placeholder="07XX XXX XXX"
          value="${escHtml(phone || "")}" />
        <p id="pm-phone-error" class="hidden text-xs text-red-400 mt-2">Enter a valid Kenyan number (07/01/254).</p>
      `}
    </div>

    <div class="flex gap-3 pt-4 border-t border-white/5">
      <button id="pm-pay-btn"
        class="flex-1 h-12 bg-white hover:bg-slate-100 text-black font-extrabold rounded-xl text-sm transition-all shadow-xl active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
        ${showChoice ? "" : "disabled"}>
        Pay ${formatKsh(order.subtotal)}
      </button>
      <button class="pm-close-btn px-6 h-12 rounded-xl bg-white/5 text-white/60 text-sm font-semibold hover:bg-white/10 transition">
        Cancel
      </button>
    </div>
  `;
}

// ---- sending -------------------------------------------------------------
function renderSending() {
  return `
    ${header("Sending request…", "Contacting M-Pesa", false)}
    <div class="flex flex-col items-center py-10">
      <div class="relative w-24 h-24 mb-6">
        <span class="absolute inset-0 rounded-full bg-indigo-500/20 pm-ring-pulse"></span>
        <span class="absolute inset-0 rounded-full bg-indigo-500/10 pm-ring-pulse" style="animation-delay:0.5s"></span>
        <div class="absolute inset-0 flex items-center justify-center">
          <div class="w-14 h-14 rounded-full bg-indigo-500/30 flex items-center justify-center text-2xl">💳</div>
        </div>
      </div>
      <p class="text-sm text-white/70 font-semibold">Initializing payment…</p>
      <p class="text-xs text-white/35 mt-1">This usually takes 1–3 seconds.</p>
      <div class="flex items-center gap-1.5 mt-5">
        <span class="pm-dot w-2 h-2 rounded-full bg-indigo-400"></span>
        <span class="pm-dot w-2 h-2 rounded-full bg-indigo-400"></span>
        <span class="pm-dot w-2 h-2 rounded-full bg-indigo-400"></span>
      </div>
    </div>
  `;
}

// ---- awaiting_pin --------------------------------------------------------
function renderAwaitingPin() {
  return `
    ${header("Check your phone", "Enter your M-Pesa PIN to confirm")}
    <div class="flex flex-col items-center py-8">
      <div class="relative w-28 h-28 mb-6">
        <span class="absolute inset-0 rounded-full bg-emerald-500/20 pm-ring-pulse"></span>
        <span class="absolute inset-0 rounded-full bg-emerald-500/10 pm-ring-pulse" style="animation-delay:0.6s"></span>
        <div class="absolute inset-0 flex items-center justify-center">
          <div class="w-16 h-16 rounded-full bg-emerald-500/25 flex items-center justify-center pm-phone-ring">
            <svg class="w-8 h-8 text-emerald-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="5" y="2" width="14" height="20" rx="3"/>
              <line x1="12" y1="18" x2="12" y2="18"/>
            </svg>
          </div>
        </div>
      </div>
      <p class="text-sm text-white font-semibold text-center">We sent a prompt to</p>
      <p class="text-lg font-black text-white mt-1 tracking-wide">${escHtml(formatPhoneDisplay(current.phone))}</p>
      <p class="text-xs text-white/40 mt-3 text-center max-w-xs">
        Enter your M-Pesa PIN on your phone. This window updates automatically.
      </p>
      <div class="flex items-center gap-1.5 mt-6">
        <span class="pm-dot w-2 h-2 rounded-full bg-emerald-400"></span>
        <span class="pm-dot w-2 h-2 rounded-full bg-emerald-400"></span>
        <span class="pm-dot w-2 h-2 rounded-full bg-emerald-400"></span>
      </div>
    </div>
    <button class="pm-close-btn w-full h-11 rounded-xl bg-white/5 text-white/50 text-xs font-semibold hover:bg-white/10 transition mt-2">
      Cancel and close
    </button>
  `;
}

// ---- success -------------------------------------------------------------
function renderSuccess(payload) {
  const receipt = payload?.receipt ? escHtml(payload.receipt) : null;
  return `
    ${header("Payment received 🎉", "Your order is now paid", false)}
    <div class="flex flex-col items-center py-8">
      <div class="relative w-24 h-24 mb-5">
        <span class="absolute inset-0 rounded-full bg-emerald-500/20 pm-ring-pulse"></span>
        <div class="absolute inset-0 flex items-center justify-center">
          <div class="w-16 h-16 rounded-full bg-emerald-500/25 flex items-center justify-center">
            <svg class="w-9 h-9 text-emerald-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <path class="pm-check-path" d="M5 13l4 4L19 7"/>
            </svg>
          </div>
        </div>
      </div>
      <p class="text-sm text-white font-semibold">Payment confirmed.</p>
      ${receipt ? `<p class="text-xs text-white/40 mt-2">M-Pesa receipt: <span class="text-white/70 font-mono">${receipt}</span></p>` : ""}
    </div>
    <button id="pm-done-btn"
      class="w-full h-12 bg-white hover:bg-slate-100 text-black font-extrabold rounded-xl text-sm transition-all shadow-xl active:scale-[0.98]">
      Done
    </button>
  `;
}

// ---- failed --------------------------------------------------------------
function renderFailed(payload) {
  const reason = payload?.reason || "Payment was not completed.";
  return `
    ${header("Payment failed", "No charge was made")}
    <div class="flex flex-col items-center py-8">
      <div class="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mb-5">
        <svg class="w-8 h-8 text-red-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
        </svg>
      </div>
      <p class="text-sm text-white/70 text-center max-w-xs">${escHtml(reason)}</p>
      <p class="text-xs text-white/35 text-center mt-2 max-w-xs">You can try again whenever you're ready.</p>
    </div>
    <div class="flex gap-3 pt-4 border-t border-white/5">
      <button id="pm-retry-btn"
        class="flex-1 h-12 bg-white hover:bg-slate-100 text-black font-extrabold rounded-xl text-sm transition-all active:scale-[0.98]">
        Try again
      </button>
      <button class="pm-close-btn px-6 h-12 rounded-xl bg-white/5 text-white/60 text-sm font-semibold hover:bg-white/10 transition">
        Close
      </button>
    </div>
  `;
}

// ---- timeout -------------------------------------------------------------
function renderTimeout() {
  return `
    ${header("Taking longer than expected", "We haven't heard back from M-Pesa yet")}
    <div class="flex flex-col items-center py-8">
      <div class="w-16 h-16 rounded-full bg-amber-500/20 flex items-center justify-center mb-5 text-2xl">⏳</div>
      <p class="text-sm text-white/70 text-center max-w-xs">
        If you approved the prompt, your payment will still complete. Check status now, or come back later.
      </p>
    </div>
    <div class="flex gap-3 pt-4 border-t border-white/5">
      <button id="pm-recheck-btn"
        class="flex-1 h-12 bg-white hover:bg-slate-100 text-black font-extrabold rounded-xl text-sm transition-all active:scale-[0.98]">
        Check status
      </button>
      <button class="pm-close-btn px-6 h-12 rounded-xl bg-white/5 text-white/60 text-sm font-semibold hover:bg-white/10 transition">
        Close
      </button>
    </div>
  `;
}

// -------------------------------------------------------------------------
// Event binding per state
// -------------------------------------------------------------------------
function bindEvents(stateName) {
  if (!modalEls) return;

  modalEls.body.querySelectorAll(".pm-close-btn").forEach((b) =>
    b.addEventListener("click", tryClose)
  );

  if (stateName === "confirm") {
    const input = document.getElementById("pm-phone-input");
    const payBtn = document.getElementById("pm-pay-btn");

    if (input) {
      const validate = () => {
        const ok = !!normalizePhone(input.value);
        payBtn.disabled = !ok;
        document.getElementById("pm-phone-error").classList.toggle("hidden", ok || !input.value);
      };
      input.addEventListener("input", validate);
      validate();
    }

    // "Use saved" → jump straight to pay
    document.querySelector(".pm-use-saved-btn")?.addEventListener("click", () => {
      current.phone = resolveInitialPhone(current.order);
      handleConfirm();
    });

    // "Use other" → swap to input mode
    document.querySelector(".pm-use-other-btn")?.addEventListener("click", () => {
      current.phoneMode = "custom";
      current.phone = "";
      setState("confirm");
      setTimeout(() => document.getElementById("pm-phone-input")?.focus(), 50);
    });

    payBtn?.addEventListener("click", () => {
      if (input) {
        const n = normalizePhone(input.value);
        if (!n) return;
        current.phone = n;
      }
      handleConfirm();
    });
  }

  if (stateName === "success") {
    document.getElementById("pm-done-btn")?.addEventListener("click", () => {
      current = null;
      closeModal();
    });
  }

  if (stateName === "failed") {
    document.getElementById("pm-retry-btn")?.addEventListener("click", () => {
      stopPoll();
      current.transactionReference = null;
      setState("confirm");
    });
  }

  if (stateName === "timeout") {
    document.getElementById("pm-recheck-btn")?.addEventListener("click", async () => {
      const ref = current?.transactionReference;
      if (!ref) return;
      try {
        const status = await fetchStatus(ref);
        handleStatus(status);
      } catch (err) {
        console.warn("recheck failed:", err);
      }
    });
  }
}

// -------------------------------------------------------------------------
// Confirm handler → POST /pay/<order_id>/
// -------------------------------------------------------------------------
async function handleConfirm() {
  setState("sending");

  try {
    const idToken = await auth.currentUser.getIdToken();
    const res = await fetch(`${API_ORIGIN}/pay/${current.order.id}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ phone: current.phone }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      setState("failed", {
        reason: data.message || `Request failed (${res.status})`,
      });
      return;
    }

    // Backend may return status: "Failed" on immediate Daraja rejection
    if (data.status === "Failed") {
      setState("failed", {
        reason: data.message || "M-Pesa rejected the request.",
      });
      return;
    }

    // Success path: transaction_reference + status Initialized
    current.transactionReference = data.transaction_reference;
    setState("awaiting_pin");
    startPolling(data.transaction_reference);
  } catch (err) {
    console.error("pay request failed:", err);
    setState("failed", { reason: "Network error. Please try again." });
  }
}

// -------------------------------------------------------------------------
// Polling
// -------------------------------------------------------------------------
async function fetchStatus(transactionReference) {
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(
    `${API_ORIGIN}/payments/status/${transactionReference}/`,
    { headers: { Authorization: `Bearer ${idToken}` } }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Status failed: ${res.status}`);
  return res.json();
}

function startPolling(transactionReference) {
  stopPoll();
  pollStartedAt = Date.now();
  backgroundPollUntil = 0;

  const tick = async () => {
    // Stop conditions
    const inBackground = !modalEls || modalEls.overlay.classList.contains("hidden");
    const deadline = inBackground ? backgroundPollUntil : pollStartedAt + POLL_TIMEOUT_MS;

    if (Date.now() > deadline) {
      stopPoll();
      if (!inBackground) setState("timeout");
      return;
    }

    try {
      const status = await fetchStatus(transactionReference);
      handleStatus(status, inBackground);
    } catch (err) {
      console.warn("poll tick failed:", err);
    }
  };

  setTimeout(tick, POLL_INTERVAL_MS);
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function handleStatus(status, inBackground = false) {
  if (!status) return;

  if (status.status === "Completed") {
    stopPoll();

    if (inBackground) {
      // Modal was closed, but payment landed. Notify.
      window.showNotif?.({
        type: "success",
        title: "Payment received",
        message: `Your order is now paid. Receipt: ${status.mpesa_receipt_number || "—"}`,
      });
      current = null;
      return;
    }

    setState("success", { receipt: status.mpesa_receipt_number });
    // Firestore listener on the pending list will handle removing the card.
    return;
  }

  if (status.status === "Failed") {
    stopPoll();
    if (inBackground) {
      window.showNotif?.({
        type: "error",
        title: "Payment failed",
        message: status.result_description || "The payment was not completed.",
      });
      current = null;
      return;
    }
    setState("failed", { reason: status.result_description || "Payment was not completed." });
    return;
  }

  // status === "Initialized" → keep polling silently
}