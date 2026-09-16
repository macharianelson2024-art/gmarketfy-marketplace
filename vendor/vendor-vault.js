/**
 * vendor-vault.js
 * -----------------------------------------------------------------------
 * Vault tab: balance, plan, payout destination, withdrawals.
 *
 * Django is the source of truth for money AND plans. Firebase holds only:
 *   - the "withdrawal" collection (live history list)
 *   - the "vendorsPaymentInformation" doc (payout destination)
 *   - the "vendors" doc (read-only, for phone prefill)
 *
 * Plans live entirely in Django's vendors_plans app. Firebase knows nothing
 * about which plan a vendor is on.
 * -----------------------------------------------------------------------
 */

import {
  doc,
  getDoc,
  setDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  db,
  auth,
} from "./firebase-config.js";
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
} from "./firebase-config.js";
import { cachedGet } from "./shared.js";

let vendorId = null;

// --- API endpoints ---------------------------------------------------------
// Dev: Live Server on :5500, Django on :8000. Prod: same origin.
const API_ORIGIN =
  window.location.origin.includes(":5500")
    ? "http://127.0.0.1:8000"
    : "";

const API_BASE = `${API_ORIGIN}/api/vault`;
const PLANS_API_BASE = `${API_ORIGIN}/api/vendors/plans`;  // plans (Django source of truth)

// --- Polling config --------------------------------------------------------
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 90000;

// --- Client-side fee preview only (Django recalculates authoritatively) ----
const GMARKETFY_FEE_RATE = 0.05;

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------
let state = {
  balance: 0,
  pendingBalance: 0,
  plan: null,             // current plan object from Django
  availablePlans: [],     // all active plans from Django
  payout: null,
  vendorPhone: null,      // for phone prefill in the upgrade modal
};

let withdrawalsUnsub = null;
let pendingPayoutSelection = null;

// Upgrade modal runtime
let upgradeEls = null;          // { overlay, panel, body }
let pollTimer = null;
let pollStartedAt = 0;
let currentUpgradeCtx = null;   // { plan, currentPlan, changeType, phone, transactionReference }

// -------------------------------------------------------------------------
// Init — call this when the Vault tab is opened / on dashboard load
// -------------------------------------------------------------------------
export async function initVault() {
  vendorId = window.vendorId;
  if (!vendorId) {
    console.error("Vault init failed: vendorId is not set.");
    window.showNotif?.({ type: "error", title: "Vault", message: "Vendor ID not found. Please refresh." });
    return;
  }

  injectUpgradeModalStyles();
  bindStaticListeners();
  injectPayoutHistoryButton();


  // Plans — critical, must succeed.
  const [currentPlan, plansList] = await Promise.all([
    fetchCurrentPlan().catch((e) => { console.error("current plan:", e); return null; }),
    fetchAvailablePlans().catch((e) => { console.error("plans list:", e); return []; }),
  ]);
  state.plan = currentPlan;
  state.availablePlans = plansList;
  renderPlan();



  // Payout destination from Django (source of truth for money).
  try {
    const payout = await fetchPayoutDestination();
    state.payout = payout;
    renderPayoutDestination();
  } catch (e) {
    console.error("payout fetch failed:", e);
  }

  // Vendor phone — still from Firebase (used for the plan-upgrade phone prefill).
  try {
    const vendorDoc = await getDoc(doc(db, "vendors", vendorId));
    state.vendorPhone = vendorDoc.exists() ? (vendorDoc.data().phone || null) : null;
  } catch (e) {
    console.error("vendor phone fetch failed:", e);
  }

  // Vault summary — separate app, not built yet. Fail soft.
  try {
    const summary = await fetchVaultSummary();
    state.balance = summary.balance ?? 0;
    state.pendingBalance = summary.pendingBalance ?? 0;
    renderBalance();
  } catch (e) {
    console.warn("vault summary not available (backend not built yet):", e);
    document.getElementById("vault-balance").textContent = "KSh —";
    document.getElementById("vault-pending-balance").textContent = "—";
  }

  // Withdrawals live feed — Firebase, fail soft.
  try {
    subscribeToWithdrawals();
  } catch (e) {
    console.error("withdrawals subscribe:", e);
  }

  // Resume an in-flight payment if one exists.
  try {
    const pending = await checkPendingPayment();
    if (pending) resumePendingPayment(pending);
  } catch (e) {
    console.error("resume pending payment:", e);
  }
}

async function fetchVaultSummary() {
  return cachedGet(`vault-summary:${vendorId}`, async () => {
    const idToken = await auth.currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/summary`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) throw new Error(`Vault summary failed: ${res.status}`);
    return res.json(); // { balance, pendingBalance, plan? }
  });
}

async function fetchCurrentPlan() {
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(`${PLANS_API_BASE}/current/`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) throw new Error(`Current plan fetch failed: ${res.status}`);
  const data = await res.json();
  return data.plan; // always present — Basic/Free is returned when no sub exists
}

async function fetchAvailablePlans() {
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(`${PLANS_API_BASE}/`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) throw new Error(`Plans list failed: ${res.status}`);
  const data = await res.json();
  return data.plans || [];
}

async function fetchPaymentStatus(transactionReference) {
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(`${PLANS_API_BASE}/payments/${transactionReference}/`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Payment status failed: ${res.status}`);
  return res.json();
}

async function fetchPayoutDestination() {
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(`${API_BASE}/payout-destination`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) throw new Error(`Payout fetch failed: ${res.status}`);
  const data = await res.json();
  return data.destination || null;
}

async function checkPendingPayment() {
  try {
    const idToken = await auth.currentUser.getIdToken();
    const res = await fetch(`${PLANS_API_BASE}/history/`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const recent = (data.payments || [])[0];
    if (!recent || recent.status !== "Initialized") return null;
    const age = Date.now() - new Date(recent.created_at).getTime();
    if (age > 15 * 60 * 1000) return null; // stale, don't resume
    return recent;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------
// Render: balance (unchanged)
// -------------------------------------------------------------------------
function renderBalance() {
  document.getElementById("vault-balance").textContent = formatKsh(state.balance);
  document.getElementById("vault-pending-balance").textContent = formatKsh(state.pendingBalance);
  const availEl = document.getElementById("withdraw-available-balance");
  if (availEl) availEl.textContent = formatKsh(state.balance);
}

// -------------------------------------------------------------------------
// Render: plan cards — uses state.plan.slug from Django
// -------------------------------------------------------------------------
function renderPlan() {
  const currentSlug = state.plan?.slug;

  document.querySelectorAll(".plan-card").forEach((card) => {
    const isCurrent = card.dataset.plan === currentSlug;

    const badge = card.querySelector(".plan-current-badge");
    if (badge) badge.classList.toggle("hidden", !isCurrent);

    card.classList.toggle("border-indigo-500/40", isCurrent);

    const btn = card.querySelector(".plan-select-btn");
    if (!btn) return;

    if (isCurrent) {
      btn.textContent = "Current Plan";
      btn.disabled = true;
      btn.classList.add("opacity-40", "cursor-not-allowed");
    } else {
      // Determine whether this is upgrade / downgrade / switch for the label
      const target = state.availablePlans.find((p) => p.slug === card.dataset.plan);
      const action = classifyChange(state.plan, target);
      btn.textContent =
        action === "downgrade" ? "Downgrade" :
        action === "upgrade"   ? "Upgrade"   :
        action === "renew"     ? "Renew"     : "Select";
      btn.disabled = false;
      btn.classList.remove("opacity-40", "cursor-not-allowed");
    }
  });
}

// Compare tier — never compare by price (promos, discounts, price changes).
function classifyChange(currentPlan, newPlan) {
  if (!newPlan) return "renew";
  if (!currentPlan || currentPlan.tier === 0) {
    return newPlan.tier === 0 ? "renew" : "new";
  }
  if (newPlan.tier === currentPlan.tier) return "renew";
  if (newPlan.tier > currentPlan.tier) return "upgrade";
  return "downgrade";
}

// -------------------------------------------------------------------------
// Plan selection — opens the upgrade modal
// -------------------------------------------------------------------------
function handlePlanSelect(targetSlug) {
  const currentSlug = state.plan?.slug;
  if (targetSlug === currentSlug) return;

  const targetPlan = state.availablePlans.find((p) => p.slug === targetSlug);
  if (!targetPlan) {
    window.showNotif?.("Plan not available. Refresh and try again.", "error");
    return;
  }

  currentUpgradeCtx = {
    plan: targetPlan,
    currentPlan: state.plan,
    changeType: classifyChange(state.plan, targetPlan),
    phone: state.vendorPhone || "",
    transactionReference: null,
  };

  openUpgradeModal();
  setModalState("confirm");
}

// -------------------------------------------------------------------------
// Upgrade modal — built dynamically in JS, themed to match the dashboard
// -------------------------------------------------------------------------
function injectUpgradeModalStyles() {
  if (document.getElementById("vault-plan-styles")) return;
  const style = document.createElement("style");
  style.id = "vault-plan-styles";
  style.textContent = `
    @keyframes vault-ring-pulse {
      0%   { transform: scale(0.85); opacity: 0.55; }
      100% { transform: scale(1.7);  opacity: 0; }
    }
    @keyframes vault-dot {
      0%, 80%, 100% { transform: scale(0.6); opacity: 0.35; }
      40%           { transform: scale(1);   opacity: 1; }
    }
    @keyframes vault-check-draw {
      from { stroke-dashoffset: 100; }
      to   { stroke-dashoffset: 0; }
    }
    @keyframes vault-phone-ring {
      0%, 100% { transform: rotate(0deg); }
      20%      { transform: rotate(-9deg); }
      40%      { transform: rotate(9deg); }
      60%      { transform: rotate(-6deg); }
      80%      { transform: rotate(6deg); }
    }
    @keyframes vault-fade-up {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .vault-anim-fade-up { animation: vault-fade-up 0.35s ease-out both; }
    .vault-ring-pulse   { animation: vault-ring-pulse 1.9s ease-out infinite; }
    .vault-phone-ring   { animation: vault-phone-ring 1.6s ease-in-out infinite; transform-origin: 50% 50%; }
    .vault-dot          { animation: vault-dot 1.2s ease-in-out infinite; }
    .vault-dot:nth-child(2) { animation-delay: 0.15s; }
    .vault-dot:nth-child(3) { animation-delay: 0.3s; }
    .vault-check-path   { stroke-dasharray: 100; animation: vault-check-draw 0.6s ease-out forwards; }
  `;
  document.head.appendChild(style);
}

function ensureUpgradeModal() {
  if (upgradeEls) return upgradeEls;

  const overlay = document.createElement("div");
  overlay.id = "plan-upgrade-overlay";
  overlay.className =
    "fixed inset-0 z-[80] bg-black/60 backdrop-blur-md hidden opacity-0 transition-opacity duration-300 flex items-end sm:items-center justify-center";

  const panel = document.createElement("div");
  panel.id = "plan-upgrade-panel";
  panel.className =
    "w-full sm:max-w-md bg-[#0f1115] border border-white/5 sm:rounded-[2rem] rounded-t-3xl p-6 md:p-8 " +
    "translate-y-full sm:translate-y-0 sm:scale-95 transition-all duration-300 " +
    "max-h-[88vh] overflow-y-auto shadow-2xl";

  const body = document.createElement("div");
  body.id = "plan-upgrade-body";

  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && isModalCancellable()) closeUpgradeModal();
  });

  upgradeEls = { overlay, panel, body };
  return upgradeEls;
}

function openUpgradeModal() {
  const { overlay, panel } = ensureUpgradeModal();
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => {
    overlay.classList.remove("opacity-0");
    panel.classList.remove("translate-y-full", "sm:scale-95");
  });
}

function closeUpgradeModal() {
  if (!upgradeEls) return;
  const { overlay, panel } = upgradeEls;

  // Stop any running poll
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  overlay.classList.add("opacity-0");
  panel.classList.add("translate-y-full", "sm:scale-95");
  setTimeout(() => {
    overlay.classList.add("hidden");
    upgradeEls.body.innerHTML = "";
  }, 300);

  currentUpgradeCtx = null;
}

function isModalCancellable() {
  // Don't let the user close while a poll is in flight awaiting a terminal result
  return !pollTimer;
}

// -- Modal state renderers --------------------------------------------------

function setModalState(stateName, payload = {}) {
  if (!upgradeEls) return;
  const renderers = {
    confirm: renderConfirmState,
    sending: renderSendingState,
    awaiting_pin: renderAwaitingPinState,
    success: renderSuccessState,
    failed: renderFailedState,
    timeout: renderTimeoutState,
  };
  upgradeEls.body.innerHTML = renderers[stateName](payload);
  upgradeEls.body.classList.remove("vault-anim-fade-up");
  // restart animation
  void upgradeEls.body.offsetWidth;
  upgradeEls.body.classList.add("vault-anim-fade-up");
  bindModalStateEvents(stateName);
}

function modalHeader(title, subtitle) {
  return `
    <div class="flex items-start justify-between mb-6">
      <div>
        <h2 class="text-xl font-extrabold text-white tracking-tight">${title}</h2>
        ${subtitle ? `<p class="text-slate-500 text-xs mt-1 font-medium">${subtitle}</p>` : ""}
      </div>
      <button class="plan-upgrade-close-btn w-10 h-10 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 transition text-white/60 hover:text-white shrink-0">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `;
}

function renderConfirmState() {
  const { plan, changeType, currentPlan } = currentUpgradeCtx;
  const isFree = Number(plan.price) === 0;

  const actionTitle = {
    upgrade: `Upgrade to ${plan.name}`,
    downgrade: `Switch to ${plan.name}`,
    renew: `Renew ${plan.name}`,
    new: `Activate ${plan.name}`,
  }[changeType];

  const subtitle =
    changeType === "upgrade"   ? `Replace your ${currentPlan?.name || "current"} plan.` :
    changeType === "downgrade" ? `Switch from ${currentPlan?.name || "current"} to ${plan.name}.` :
    changeType === "renew"     ? `Extend your ${plan.name} plan by ${plan.duration_days} days.` :
                                 `Start your ${plan.name} plan.`;

  const limits = plan.limits || {};
  const summaryRows = [
    ["Payout schedule", limits.payout_schedule],
    ["Commission",      limits.commission_label],
    ["Instant min.",    limits.instant_min ? `KSh ${Number(limits.instant_min).toLocaleString("en-KE")}` : null],
    ["Safaricom fee",   limits.safaricom_share_label],
  ].filter(([, v]) => v);

  return `
    ${modalHeader(actionTitle, subtitle)}

    <div class="rounded-2xl bg-white/[0.03] border border-white/5 p-4 mb-5">
      <div class="flex items-baseline justify-between mb-3 pb-3 border-b border-white/5">
        <span class="text-xs text-white/50">Amount to pay</span>
        <span class="text-lg font-black text-white">
          ${isFree ? "Free" : formatKsh(Number(plan.price))}
          ${!isFree ? `<span class="text-xs font-medium text-white/40">/ month</span>` : ""}
        </span>
      </div>
      <div class="space-y-2">
        ${summaryRows.map(([k, v]) => `
          <div class="flex justify-between text-xs">
            <span class="text-white/50">${k}</span>
            <span class="text-white/80 font-semibold text-right">${v}</span>
          </div>
        `).join("")}
      </div>
    </div>

    ${!isFree ? `
      <div class="space-y-2 mb-5">
        <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">M-Pesa Phone Number</label>
        <input id="plan-upgrade-phone" type="tel"
          class="w-full px-4 bg-white/[0.03] border border-white/10 rounded-xl text-white text-sm outline-none focus:border-indigo-500/50 h-12"
          placeholder="07XX XXX XXX"
          value="${escapeAttr(currentUpgradeCtx.phone || "")}" />
        <p class="text-[11px] text-white/30">You'll receive an STK prompt on this number.</p>
      </div>
    ` : `
      <div class="rounded-xl bg-amber-500/10 border border-amber-500/20 p-4 text-xs text-amber-300 mb-5">
        Switching to Free cancels your current paid plan immediately. No refund on unused time.
      </div>
    `}

    <div class="flex gap-3 pt-4 border-t border-white/5">
      <button id="plan-upgrade-confirm-btn"
        class="flex-1 h-12 bg-white hover:bg-slate-100 text-black font-extrabold rounded-xl text-sm transition-all shadow-xl active:scale-[0.98]">
        ${isFree ? "Switch to Free" : `Confirm & Pay ${formatKsh(Number(plan.price))}`}
      </button>
      <button class="plan-upgrade-close-btn px-6 h-12 rounded-xl bg-white/5 text-white/60 text-sm font-semibold hover:bg-white/10 transition">
        Cancel
      </button>
    </div>
  `;
}

function renderSendingState() {
  return `
    ${modalHeader("Sending request…", "Contacting M-Pesa")}
    <div class="flex flex-col items-center py-10">
      <div class="relative w-24 h-24 mb-6">
        <span class="absolute inset-0 rounded-full bg-indigo-500/20 vault-ring-pulse"></span>
        <span class="absolute inset-0 rounded-full bg-indigo-500/10 vault-ring-pulse" style="animation-delay:0.5s"></span>
        <div class="absolute inset-0 flex items-center justify-center">
          <div class="w-14 h-14 rounded-full bg-indigo-500/30 flex items-center justify-center text-2xl">💳</div>
        </div>
      </div>
      <p class="text-sm text-white/70 font-semibold">Initializing payment…</p>
      <p class="text-xs text-white/35 mt-1">This usually takes 1–3 seconds.</p>
      <div class="flex items-center gap-1.5 mt-5">
        <span class="vault-dot w-2 h-2 rounded-full bg-indigo-400"></span>
        <span class="vault-dot w-2 h-2 rounded-full bg-indigo-400"></span>
        <span class="vault-dot w-2 h-2 rounded-full bg-indigo-400"></span>
      </div>
    </div>
  `;
}

function renderAwaitingPinState() {
  const phone = currentUpgradeCtx?.phone || "";
  return `
    ${modalHeader("Check your phone", "Enter your M-Pesa PIN to confirm")}
    <div class="flex flex-col items-center py-8">
      <div class="relative w-28 h-28 mb-6">
        <span class="absolute inset-0 rounded-full bg-emerald-500/20 vault-ring-pulse"></span>
        <span class="absolute inset-0 rounded-full bg-emerald-500/10 vault-ring-pulse" style="animation-delay:0.6s"></span>
        <div class="absolute inset-0 flex items-center justify-center">
          <div class="w-16 h-16 rounded-full bg-emerald-500/25 flex items-center justify-center vault-phone-ring">
            <svg class="w-8 h-8 text-emerald-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="5" y="2" width="14" height="20" rx="3"/>
              <line x1="12" y1="18" x2="12" y2="18"/>
            </svg>
          </div>
        </div>
      </div>
      <p class="text-sm text-white font-semibold text-center">We sent a prompt to</p>
      <p class="text-lg font-black text-white mt-1 tracking-wide">${escapeHtml(formatPhoneDisplay(phone))}</p>
      <p class="text-xs text-white/40 mt-3 text-center max-w-xs">
        Enter your M-Pesa PIN on your phone to approve the payment.
        This window updates automatically.
      </p>
      <div class="flex items-center gap-1.5 mt-6">
        <span class="vault-dot w-2 h-2 rounded-full bg-emerald-400"></span>
        <span class="vault-dot w-2 h-2 rounded-full bg-emerald-400"></span>
        <span class="vault-dot w-2 h-2 rounded-full bg-emerald-400"></span>
      </div>
    </div>
    <button id="plan-upgrade-cancel-btn"
      class="w-full h-11 rounded-xl bg-white/5 text-white/50 text-xs font-semibold hover:bg-white/10 transition mt-2">
      Cancel and close
    </button>
  `;
}

function renderSuccessState(payload) {
  const plan = payload?.plan || currentUpgradeCtx?.plan;
  return `
    ${modalHeader("You're all set 🎉", plan ? `Now on ${plan.name}` : "")}
    <div class="flex flex-col items-center py-8">
      <div class="relative w-24 h-24 mb-5">
        <span class="absolute inset-0 rounded-full bg-emerald-500/20 vault-ring-pulse"></span>
        <div class="absolute inset-0 flex items-center justify-center">
          <div class="w-16 h-16 rounded-full bg-emerald-500/25 flex items-center justify-center">
            <svg class="w-9 h-9 text-emerald-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <path class="vault-check-path" d="M5 13l4 4L19 7"/>
            </svg>
          </div>
        </div>
      </div>
      <p class="text-sm text-white font-semibold">${plan ? `Your ${plan.name} plan is active.` : "Payment confirmed."}</p>
      ${payload?.receipt ? `<p class="text-xs text-white/40 mt-2">M-Pesa receipt: <span class="text-white/70 font-mono">${escapeHtml(payload.receipt)}</span></p>` : ""}
    </div>
    <button id="plan-upgrade-done-btn"
      class="w-full h-12 bg-white hover:bg-slate-100 text-black font-extrabold rounded-xl text-sm transition-all shadow-xl active:scale-[0.98]">
      Done
    </button>
  `;
}

function renderFailedState(payload) {
  const reason = payload?.reason || "Payment was not completed.";
  return `
    ${modalHeader("Payment failed", reason)}
    <div class="flex flex-col items-center py-8">
      <div class="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mb-5">
        <svg class="w-8 h-8 text-red-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
        </svg>
      </div>
      <p class="text-sm text-white/70 text-center max-w-xs">
        No changes were made to your plan. You can try again whenever you're ready.
      </p>
    </div>
    <div class="flex gap-3 pt-4 border-t border-white/5">
      <button id="plan-upgrade-retry-btn"
        class="flex-1 h-12 bg-white hover:bg-slate-100 text-black font-extrabold rounded-xl text-sm transition-all active:scale-[0.98]">
        Try again
      </button>
      <button class="plan-upgrade-close-btn px-6 h-12 rounded-xl bg-white/5 text-white/60 text-sm font-semibold hover:bg-white/10 transition">
        Close
      </button>
    </div>
  `;
}

function renderTimeoutState() {
  return `
    ${modalHeader("Taking longer than expected", "We haven't received a confirmation yet")}
    <div class="flex flex-col items-center py-8">
      <div class="w-16 h-16 rounded-full bg-amber-500/20 flex items-center justify-center mb-5 text-2xl">⏳</div>
      <p class="text-sm text-white/70 text-center max-w-xs">
        If you approved the M-Pesa prompt, your plan will update shortly.
        You can also check the status now.
      </p>
    </div>
    <div class="flex gap-3 pt-4 border-t border-white/5">
      <button id="plan-upgrade-recheck-btn"
        class="flex-1 h-12 bg-white hover:bg-slate-100 text-black font-extrabold rounded-xl text-sm transition-all active:scale-[0.98]">
        Check status
      </button>
      <button class="plan-upgrade-close-btn px-6 h-12 rounded-xl bg-white/5 text-white/60 text-sm font-semibold hover:bg-white/10 transition">
        Close
      </button>
    </div>
  `;
}

function bindModalStateEvents(stateName) {
  if (!upgradeEls) return;

  // Close buttons (present in confirm / failed / timeout states)
  upgradeEls.body.querySelectorAll(".plan-upgrade-close-btn").forEach((b) => {
    b.addEventListener("click", () => {
      if (isModalCancellable()) closeUpgradeModal();
    });
  });

  if (stateName === "confirm") {
    const btn = document.getElementById("plan-upgrade-confirm-btn");
    btn?.addEventListener("click", handleUpgradeConfirm);
  }

  if (stateName === "awaiting_pin") {
    document.getElementById("plan-upgrade-cancel-btn")?.addEventListener("click", () => {
      // User chose to close — cancel polling. Payment may still complete server-side,
      // so we refresh the plan on close to catch a late success.
      closeUpgradeModal();
      setTimeout(refreshCurrentPlanAndRender, 800);
    });
  }

  if (stateName === "success") {
    document.getElementById("plan-upgrade-done-btn")?.addEventListener("click", closeUpgradeModal);
  }

  if (stateName === "failed") {
    document.getElementById("plan-upgrade-retry-btn")?.addEventListener("click", () => {
      setModalState("confirm");
    });
  }

  if (stateName === "timeout") {
    document.getElementById("plan-upgrade-recheck-btn")?.addEventListener("click", async () => {
      const ref = currentUpgradeCtx?.transactionReference;
      if (!ref) return;
      try {
        const status = await fetchPaymentStatus(ref);
        handlePaymentStatusUpdate(status);
      } catch (err) {
        console.error(err);
      }
    });
  }
}

// -- Upgrade flow: POST → awaiting_pin → poll ------------------------------

async function handleUpgradeConfirm() {
  const { plan, changeType } = currentUpgradeCtx;
  const isFree = Number(plan.price) === 0;

  let phone = null;
  if (!isFree) {
    const input = document.getElementById("plan-upgrade-phone");
    phone = (input?.value || "").trim();
    if (!phone) {
      window.showNotif?.("Enter a valid M-Pesa phone number.", "error");
      return;
    }
    currentUpgradeCtx.phone = phone;
  }

  setModalState("sending");

  try {
    const idToken = await auth.currentUser.getIdToken();
    const res = await fetch(`${PLANS_API_BASE}/upgrade/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ plan_id: plan.id, phone: phone || "" }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // 409 duplicate, 400 bad input, 404 plan gone, 5xx Daraja down
      setModalState("failed", { reason: data.message || `Request failed (${res.status})` });
      return;
    }

    // ---- Free plan path: no PIN, immediate success ----------------------
    if (data.payment_required === false) {
      currentUpgradeCtx.transactionReference = null;
      setModalState("success", { plan: data.plan || plan });
      await refreshCurrentPlanAndRender();
      setTimeout(() => { if (!pollTimer) closeUpgradeModal(); }, 2200);
      return;
    }

    // ---- Paid plan path: awaiting PIN + poll ----------------------------
    currentUpgradeCtx.transactionReference = data.transaction_reference;
    setModalState("awaiting_pin");
    startPolling(data.transaction_reference);

  } catch (err) {
    console.error("Upgrade request failed:", err);
    setModalState("failed", { reason: "Network error. Please try again." });
  }
}

function startPolling(transactionReference) {
  if (pollTimer) clearInterval(pollTimer);
  pollStartedAt = Date.now();

  const tick = async () => {
    if (Date.now() - pollStartedAt > POLL_TIMEOUT_MS) {
      clearInterval(pollTimer);
      pollTimer = null;
      setModalState("timeout");
      return;
    }
    try {
      const status = await fetchPaymentStatus(transactionReference);
      handlePaymentStatusUpdate(status);
    } catch (err) {
      console.error("Poll failed:", err);
      // Silent — transient network errors shouldn't nuke the modal.
    }
  };

  // First check after a short grace period, then on interval.
  setTimeout(tick, POLL_INTERVAL_MS);
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

async function handlePaymentStatusUpdate(status) {
  if (!status) return;

  if (status.status === "Completed") {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    setModalState("success", {
      plan: status.plan,
      receipt: status.mpesa_receipt_number,
    });
    await refreshCurrentPlanAndRender();
    setTimeout(() => { if (!pollTimer) closeUpgradeModal(); }, 2400);
    return;
  }

  if (status.status === "Failed") {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    setModalState("failed", {
      reason: status.result_description || "Payment was not completed.",
    });
    return;
  }

  // status === "Initialized" → keep polling, stay on awaiting_pin
}

async function refreshCurrentPlanAndRender() {
  try {
    const [currentPlan, plansList] = await Promise.all([
      fetchCurrentPlan(),
      fetchAvailablePlans(),
    ]);
    state.plan = currentPlan;
    state.availablePlans = plansList;
    renderPlan();
  } catch (err) {
    console.error("Failed to refresh plan after payment:", err);
  }
}

function resumePendingPayment(payment) {
  // payment from /history/ — has transaction_reference, plan, change_type, phone_number
  const targetPlan = state.availablePlans.find((p) => p.id === payment.plan?.id)
    || payment.plan;

  currentUpgradeCtx = {
    plan: targetPlan,
    currentPlan: state.plan,
    changeType: payment.change_type,
    phone: payment.phone_number,
    transactionReference: payment.transaction_reference,
  };

  openUpgradeModal();
  setModalState("awaiting_pin");
  startPolling(payment.transaction_reference);
}

// -------------------------------------------------------------------------
// Render: payout destination (unchanged)
// -------------------------------------------------------------------------
function renderPayoutDestination() {
  const typeEl = document.getElementById("vault-payout-type");
  const numberEl = document.getElementById("vault-payout-number");

  if (!state.payout) {
    typeEl.textContent = "Not set";
    numberEl.textContent = "";
    return;
  }

  const label = state.payout.type === "till" ? "Till" : "Paybill";
  typeEl.textContent = label;
  typeEl.classList.remove("text-white/50");
  numberEl.textContent = ` • ${state.payout.number}`;
}

// -------------------------------------------------------------------------
// Render: withdrawals list (live, unchanged)
// -------------------------------------------------------------------------
function subscribeToWithdrawals() {
  if (withdrawalsUnsub) withdrawalsUnsub();

  const q = query(
    collection(db, "withdrawal"),
    where("vendor_id", "==", vendorId),
    orderBy("createdAt", "desc"),
    limit(20)
  );

  withdrawalsUnsub = onSnapshot(q, (snap) => {
    const listEl = document.getElementById("vault-withdrawals-list");
    const emptyEl = document.getElementById("vault-withdrawals-empty");

    if (snap.empty) {
      listEl.innerHTML = "";
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");

    const frag = document.createDocumentFragment();
    snap.forEach((d) => frag.appendChild(buildWithdrawalRow(d.id, d.data())));
    listEl.innerHTML = "";
    listEl.appendChild(frag);
  });
}

function buildWithdrawalRow(id, w) {
  const row = document.createElement("div");
  row.className =
    "flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-white/5";

  const statusColors = {
    completed: "text-emerald-400 bg-emerald-500/10",
    pending: "text-amber-400 bg-amber-500/10",
    failed: "text-red-400 bg-red-500/10",
  };
  const statusClass = statusColors[w.status] || "text-white/40 bg-white/5";

  row.innerHTML = `
    <div>
      <p class="text-sm font-semibold text-white">${formatKsh(w.amount)}</p>
      <p class="text-xs text-white/30 mt-0.5">${formatDate(w.createdAt)}</p>
    </div>
    <span class="text-[10px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full ${statusClass}">
      ${w.status || "pending"}
    </span>
  `;
  return row;
}

// -------------------------------------------------------------------------
// Withdraw modal (unchanged behaviour, but reads state.plan.slug now)
// -------------------------------------------------------------------------
function openWithdrawModal() {
  document.getElementById("withdraw-amount").value = "";
  document.getElementById("withdraw-fee-preview").classList.add("hidden");
  document.getElementById("withdraw-below-min-notice").classList.add("hidden");
  document.getElementById("withdraw-confirm-btn").disabled = true;
  openModal("withdraw-modal-overlay", "withdraw-modal");
}

function closeWithdrawModal() {
  closeModal("withdraw-modal-overlay", "withdraw-modal");
}

function onWithdrawAmountInput(e) {
  const amount = parseFloat(e.target.value) || 0;
  const confirmBtn = document.getElementById("withdraw-confirm-btn");
  const previewEl = document.getElementById("withdraw-fee-preview");
  const belowMinEl = document.getElementById("withdraw-below-min-notice");

  if (amount <= 0) {
    previewEl.classList.add("hidden");
    belowMinEl.classList.add("hidden");
    confirmBtn.disabled = true;
    return;
  }
  if (amount > state.balance) {
    confirmBtn.disabled = true;
    window.showNotif?.("Amount exceeds available balance.", "error");
    return;
  }

  const gmarketfyFee = amount * GMARKETFY_FEE_RATE;
  const estSafaricomFee = estimateSafaricomFeePreview(amount, state.plan?.slug);
  const receives = amount - gmarketfyFee - estSafaricomFee;

  document.getElementById("fee-gmarketfy").textContent = formatKsh(gmarketfyFee);
  document.getElementById("fee-safaricom").textContent = formatKsh(estSafaricomFee);
  document.getElementById("fee-total-receive").textContent = formatKsh(receives);
  previewEl.classList.remove("hidden");

  const minForPlan = Number(state.plan?.limits?.instant_min ?? 0);
  const belowMin = amount < minForPlan;
  belowMinEl.classList.toggle("hidden", !belowMin);

  confirmBtn.disabled = false;
}

function estimateSafaricomFeePreview(amount, planSlug) {
  const base = amount > 20000 ? 108 : amount > 1000 ? 55 : 13;
  const shareByPlan = { free: 1.1, medium: 0.7, premium: 0.4, ultimate: 0 };
  if (planSlug === "ultimate") return 15;
  return Math.round(base * (shareByPlan[planSlug] ?? 1));
}

async function handleWithdrawConfirm() {
  const amount = parseFloat(document.getElementById("withdraw-amount").value);
  if (!amount || amount <= 0) return;

  const btn = document.getElementById("withdraw-confirm-btn");
  btn.disabled = true;
  btn.textContent = "Processing...";

  try {
    const idToken = await auth.currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ amount }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Withdrawal failed: ${res.status}`);
    }

    state.balance -= amount;
    renderBalance();
    window.showNotif?.("Withdrawal initiated.", "success");
    closeWithdrawModal();
  } catch (err) {
    console.error(err);
    window.showNotif?.(err.message || "Withdrawal failed. Try again.", "error");
  } finally {
    btn.textContent = "Confirm Withdrawal";
    btn.disabled = false;
  }
}

// -------------------------------------------------------------------------
// Payout destination modal (unchanged)
// -------------------------------------------------------------------------
function openPayoutModal() {
  pendingPayoutSelection = null;
  document.getElementById("payout-step-details").classList.remove("hidden");
  document.getElementById("payout-step-verify").classList.add("hidden");
  document.getElementById("payout-type").value = "";
  document.getElementById("payout-number-input").value = "";
  document.getElementById("payout-account-input").value = "";
  document.getElementById("payout-account-field").classList.add("hidden");
  document.getElementById("payout-continue-btn").disabled = true;
  document
    .querySelectorAll(".payout-type-btn")
    .forEach((b) => b.classList.remove("border-indigo-500/50", "text-white/80"));
  openModal("payout-modal-overlay", "payout-modal");
}

function closePayoutModal() {
  closeModal("payout-modal-overlay", "payout-modal");
}

function onPayoutTypeSelect(e) {
  const btn = e.currentTarget;
  const type = btn.dataset.type;
  document.getElementById("payout-type").value = type;

  document
    .querySelectorAll(".payout-type-btn")
    .forEach((b) => b.classList.remove("border-indigo-500/50", "text-white/80"));
  btn.classList.add("border-indigo-500/50", "text-white/80");

  document.getElementById("payout-number-label").textContent =
    type === "till" ? "Till Number" : "Paybill Number";
  document
    .getElementById("payout-account-field")
    .classList.toggle("hidden", type !== "paybill");

  validatePayoutDetailsStep();
}

function validatePayoutDetailsStep() {
  const type = document.getElementById("payout-type").value;
  const number = document.getElementById("payout-number-input").value.trim();
  const account = document.getElementById("payout-account-input").value.trim();

  const valid = type && number && (type !== "paybill" || account);
  const btn = document.getElementById("payout-continue-btn");
  btn.disabled = !valid;
  btn.classList.toggle("bg-indigo-500", valid);
  btn.classList.toggle("text-white", valid);
  btn.classList.toggle("bg-white/10", !valid);
  btn.classList.toggle("text-white/40", !valid);
}

function onPayoutContinue() {
  pendingPayoutSelection = {
    type: document.getElementById("payout-type").value,
    number: document.getElementById("payout-number-input").value.trim(),
    accountNumber: document.getElementById("payout-account-input").value.trim() || null,
  };
  document.getElementById("payout-step-details").classList.add("hidden");
  document.getElementById("payout-step-verify").classList.remove("hidden");
  document.getElementById("payout-verify-error").classList.add("hidden");
  document.getElementById("payout-verify-password").value = "";

  validatePayoutVerifyStep();

}

function onPayoutBack() {
  document.getElementById("payout-step-verify").classList.add("hidden");
  document.getElementById("payout-step-details").classList.remove("hidden");
}

async function handlePayoutSave() {
  const password = document.getElementById("payout-verify-password").value;
  const errorEl = document.getElementById("payout-verify-error");
  const saveBtn = document.getElementById("payout-save-btn");

  if (!password) return;

  saveBtn.disabled = true;
  saveBtn.textContent = "Verifying...";
  errorEl.classList.add("hidden");

  try {
    // Re-verify identity before touching where money goes.
    const credential = EmailAuthProvider.credential(auth.currentUser.email, password);
    await reauthenticateWithCredential(auth.currentUser, credential);

    // Django is the source of truth — no Firestore write here.
    const idToken = await auth.currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/payout-destination`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(pendingPayoutSelection),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      errorEl.classList.remove("hidden");
      errorEl.textContent = data.message || "Could not save. Please try again.";
      return;
    }

    // Server-normalized values are the truth.
    state.payout = data.destination || pendingPayoutSelection;
    renderPayoutDestination();
    window.showNotif?.({ type: "success", title: "Saved", message: "Payout destination updated." });
    closePayoutModal();

  } catch (err) {
    console.error(err);
    errorEl.classList.remove("hidden");
    errorEl.textContent =
      err.code === "auth/wrong-password"
        ? "Incorrect password. Try again."
        : "Something went wrong. Try again.";
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Confirm & Save";
  }
}


// -------------------------------------------------------------------------
// Payout destination history — button + modal (built dynamically)
// -------------------------------------------------------------------------

function injectPayoutHistoryButton() {
  if (document.getElementById("vault-payout-history-btn")) return;

  const changeBtn = document.getElementById("vault-edit-payout-btn");
  if (!changeBtn || !changeBtn.parentElement) return;

  const btn = document.createElement("button");
  btn.id = "vault-payout-history-btn";
  btn.className =
    "text-xs px-4 py-2 rounded-lg bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition font-medium ml-2";
  btn.textContent = "History";
  btn.addEventListener("click", openPayoutHistoryModal);

  // Insert right after the "Change" button
  changeBtn.parentElement.insertBefore(btn, changeBtn.nextSibling);
}

function ensurePayoutHistoryModal() {
  if (document.getElementById("payout-history-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "payout-history-overlay";
  overlay.className =
    "fixed inset-0 z-[80] bg-black/60 backdrop-blur-md hidden opacity-0 transition-opacity duration-300 flex items-end sm:items-center justify-center";

  const panel = document.createElement("div");
  panel.id = "payout-history-panel";
  panel.className =
    "w-full sm:max-w-md bg-[#0f1115] border border-white/5 sm:rounded-[2rem] rounded-t-3xl p-6 md:p-8 " +
    "translate-y-full sm:translate-y-0 sm:scale-95 transition-all duration-300 " +
    "max-h-[88vh] overflow-y-auto shadow-2xl";

  panel.innerHTML = `
    <div class="flex items-start justify-between mb-6">
      <div>
        <h2 class="text-xl font-extrabold text-white tracking-tight">Payout History</h2>
        <p class="text-slate-500 text-xs mt-1 font-medium">Every change to your payout destination.</p>
      </div>
      <button class="payout-history-close-btn w-10 h-10 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 transition text-white/60 hover:text-white shrink-0">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div id="payout-history-body"></div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePayoutHistoryModal();
  });

  panel.querySelectorAll(".payout-history-close-btn").forEach((b) => {
    b.addEventListener("click", closePayoutHistoryModal);
  });
}

function openPayoutHistoryModal() {
  ensurePayoutHistoryModal();

  const overlay = document.getElementById("payout-history-overlay");
  const panel = document.getElementById("payout-history-panel");
  const body = document.getElementById("payout-history-body");

  body.innerHTML = `
    <div class="flex justify-center py-12">
      <div class="w-8 h-8 border-2 border-white/10 border-t-indigo-500 rounded-full animate-spin"></div>
    </div>`;

  overlay.classList.remove("hidden");
  requestAnimationFrame(() => {
    overlay.classList.remove("opacity-0");
    panel.classList.remove("translate-y-full", "sm:scale-95");
  });

  fetchPayoutHistoryAndRender();
}

function closePayoutHistoryModal() {
  const overlay = document.getElementById("payout-history-overlay");
  const panel = document.getElementById("payout-history-panel");
  if (!overlay || !panel) return;

  overlay.classList.add("opacity-0");
  panel.classList.add("translate-y-full", "sm:scale-95");
  setTimeout(() => overlay.classList.add("hidden"), 300);
}

async function fetchPayoutHistoryAndRender() {
  const body = document.getElementById("payout-history-body");
  if (!body) return;

  try {
    const idToken = await auth.currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/payout-destination/history`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) throw new Error(`History fetch failed: ${res.status}`);

    const data = await res.json();
    const changes = data.changes || [];

    if (changes.length === 0) {
      body.innerHTML = `
        <div class="text-center py-12 text-white/25">
          <p class="text-4xl mb-3">📜</p>
          <p class="text-sm">No changes yet.</p>
        </div>`;
      return;
    }

    body.innerHTML = `
      <div class="space-y-3">
        ${changes.map(renderPayoutHistoryRow).join("")}
      </div>`;
  } catch (err) {
    console.error("Payout history fetch failed:", err);
    body.innerHTML = `
      <div class="rounded-xl bg-red-500/10 border border-red-500/20 p-4 text-xs text-red-300 text-center">
        Could not load history. Try again.
      </div>`;
  }
}

function renderPayoutHistoryRow(change) {
  const { old: oldV, new: newV, changedAt } = change;

  const fmtDest = (d) => {
    if (!d) return "—";
    const label = d.type === "till" ? "Till" : "Paybill";
    const acct = d.accountNumber ? ` · ${escapeHtml(d.accountNumber)}` : "";
    return `${label} ${escapeHtml(d.number)}${acct}`;
  };

  const isFirstSet = !oldV;

  const dateStr = (() => {
    try {
      const d = new Date(changedAt);
      return d.toLocaleString("en-KE", {
        day: "numeric", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    } catch { return ""; }
  })();

  return `
    <div class="rounded-xl bg-white/[0.03] border border-white/5 p-3">
      <div class="flex items-center justify-between mb-2">
        <span class="text-[10px] font-bold uppercase tracking-widest ${
          isFirstSet ? "text-emerald-400" : "text-indigo-300"
        }">
          ${isFirstSet ? "First set" : "Changed"}
        </span>
        <span class="text-[10px] text-white/30">${escapeHtml(dateStr)}</span>
      </div>

      ${!isFirstSet ? `
        <div class="flex items-center gap-2 text-xs mb-1">
          <span class="text-white/35 line-through">${fmtDest(oldV)}</span>
        </div>
        <div class="flex items-center gap-2 text-xs">
          <span class="text-emerald-300">→</span>
          <span class="text-white/80 font-semibold">${fmtDest(newV)}</span>
        </div>
      ` : `
        <div class="flex items-center gap-2 text-xs">
          <span class="text-white/80 font-semibold">${fmtDest(newV)}</span>
        </div>
      `}
    </div>
  `;
}

function validatePayoutVerifyStep() {
  const password = document.getElementById("payout-verify-password").value;
  const btn = document.getElementById("payout-save-btn");
  btn.disabled = !password;
  btn.classList.toggle("opacity-40", !password);
  btn.classList.toggle("cursor-not-allowed", !password);
}

// -------------------------------------------------------------------------
// Generic modal open/close (unchanged)
// -------------------------------------------------------------------------
function openModal(overlayId, panelId) {
  const overlay = document.getElementById(overlayId);
  const panel = document.getElementById(panelId);
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => {
    overlay.classList.remove("opacity-0");
    panel.classList.remove("translate-y-full", "sm:scale-95");
  });
}

function closeModal(overlayId, panelId) {
  const overlay = document.getElementById(overlayId);
  const panel = document.getElementById(panelId);
  overlay.classList.add("opacity-0");
  panel.classList.add("translate-y-full", "sm:scale-95");
  setTimeout(() => overlay.classList.add("hidden"), 300);
}

// -------------------------------------------------------------------------
// Event binding
// -------------------------------------------------------------------------
function bindStaticListeners() {
  document.getElementById("vault-withdraw-btn").addEventListener("click", openWithdrawModal);
  document
    .querySelectorAll("#withdraw-modal-overlay .withdraw-modal-close-btn")
    .forEach((b) => b.addEventListener("click", closeWithdrawModal));
  document
    .getElementById("withdraw-amount")
    .addEventListener("input", onWithdrawAmountInput);
  document
    .getElementById("withdraw-confirm-btn")
    .addEventListener("click", handleWithdrawConfirm);

  document
    .getElementById("vault-edit-payout-btn")
    .addEventListener("click", openPayoutModal);
  document
    .querySelectorAll("#payout-modal-overlay .payout-modal-close-btn")
    .forEach((b) => b.addEventListener("click", closePayoutModal));
  document
    .querySelectorAll(".payout-type-btn")
    .forEach((b) => b.addEventListener("click", onPayoutTypeSelect));
  document
    .getElementById("payout-number-input")
    .addEventListener("input", validatePayoutDetailsStep);
  document
  .getElementById("payout-verify-password")
  .addEventListener("input", validatePayoutVerifyStep);

  document
    .getElementById("payout-account-input")
    .addEventListener("input", validatePayoutDetailsStep);
  document.getElementById("payout-continue-btn").addEventListener("click", onPayoutContinue);
  document.getElementById("payout-back-btn").addEventListener("click", onPayoutBack);
  document.getElementById("payout-save-btn").addEventListener("click", handlePayoutSave);

  document.querySelectorAll(".plan-select-btn").forEach((btn) => {
    btn.addEventListener("click", () => handlePlanSelect(btn.dataset.plan));
  });
}

// -------------------------------------------------------------------------
// Utils
// -------------------------------------------------------------------------
function formatKsh(n) {
  return `KSh ${Math.round(n).toLocaleString("en-KE")}`;
}

function formatDate(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" });
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function formatPhoneDisplay(phone) {
  const p = String(phone || "");
  // 2547XXXXXXXX → 07XX XXX XXX
  if (/^254\d{9}$/.test(p)) {
    return `0${p.slice(3, 6)} ${p.slice(6, 9)} ${p.slice(9, 12)}`;
  }
  return p;
}