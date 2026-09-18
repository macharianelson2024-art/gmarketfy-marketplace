/**
 * client-mobile-nav.js
 * -----------------------------------------------------------------------
 * Floating bottom navigation for the client dashboard on mobile.
 *
 *  - Glass pill fixed to the bottom, respects iOS safe-area
 *  - 5 tabs, animated gradient background pill slides between them
 *  - Badges for Pending + Cart, mirror the desktop badges via the
 *    .cart-notif / .pending-notif class (shared with the patched
 *    dashboard.js selectors)
 *  - Haptic feedback on tap
 *  - Hide-on-scroll-down, show-on-scroll-up
 *  - Desktop nav (#nav) is hidden via CSS on small screens
 *
 * Requires: window.switchClientTab(index) — exposed from dashboard.js
 * -----------------------------------------------------------------------
 */

const MOBILE_BREAKPOINT = 768;
const SCROLL_DELTA = 6;
const SCROLL_HIDE_MIN = 120;
const HAPTIC_MS = 10;

const TABS = [
  { index: 0, icon: "home",     label: "Home" },
  { index: 1, icon: "package",  label: "Pending", badgeKey: "pending" },
  { index: 2, icon: "clock",    label: "History" },
  { index: 3, icon: "cart",     label: "Cart",    badgeKey: "cart" },
  { index: 4, icon: "settings", label: "Settings" },
];

const ICONS = {
  home: `<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>`,
  package: `<path d="M16.5 9.4L7.5 4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>`,
  clock: `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`,
  cart: `<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>`,
  settings: `<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>`,
};

let navWrap = null;
let pillEl = null;
let activeIndex = 0;
let lastY = 0;
let ticking = false;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
function injectStyles() {
  if (document.getElementById("client-mobile-nav-styles")) return;
  const style = document.createElement("style");
  style.id = "client-mobile-nav-styles";
  style.textContent = `
    /* Hide the desktop nav on small screens — the mobile nav replaces it */
    @media (max-width: 767px) {
      #nav { display: none !important; }
      .header-wrap {
        flex-direction: row !important;
        align-items: center !important;
        justify-content: space-between !important;
      }
      #browse-explore { display: block !important; width: auto !important; }
      body { padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 104px); }
    }

    .cmn-wrap {
      position: fixed;
      left: 0; right: 0; bottom: 0;
      z-index: 8000;
      padding: 0 12px calc(env(safe-area-inset-bottom, 0px) + 12px);
      display: none;
      pointer-events: none;
      transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.3s ease;
      will-change: transform, opacity;
    }
    @media (max-width: 767px) { .cmn-wrap { display: block; } }

    .cmn-wrap.cmn-hidden {
      transform: translateY(calc(100% + 24px));
      opacity: 0;
    }

    .cmn {
      max-width: 420px;
      margin: 0 auto;
      pointer-events: auto;
      background: rgba(15, 17, 21, 0.82);
      backdrop-filter: blur(24px) saturate(160%);
      -webkit-backdrop-filter: blur(24px) saturate(160%);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 22px;
      box-shadow:
        0 10px 40px rgba(0, 0, 0, 0.55),
        0 0 0 1px rgba(255, 255, 255, 0.02) inset,
        0 1px 0 rgba(255, 255, 255, 0.06) inset;
      padding: 6px;
      animation: cmn-enter 0.55s cubic-bezier(0.22, 1, 0.36, 1) both;
    }

    @keyframes cmn-enter {
      from { transform: translateY(20px); opacity: 0; }
      to   { transform: translateY(0);    opacity: 1; }
    }

    .cmn-inner {
      position: relative;
      display: flex;
      align-items: stretch;
    }

    /* Sliding gradient pill behind the active tab */
    .cmn-pill {
      position: absolute;
      top: 4px;
      bottom: 4px;
      left: 0;
      border-radius: 16px;
      background:
        linear-gradient(135deg,
          rgba(99, 102, 241, 0.28) 0%,
          rgba(168, 85, 247, 0.20) 55%,
          rgba(236, 72, 153, 0.14) 100%);
      border: 1px solid rgba(99, 102, 241, 0.35);
      box-shadow:
        0 4px 20px rgba(99, 102, 241, 0.25),
        0 0 0 1px rgba(255, 255, 255, 0.03) inset;
      pointer-events: none;
      z-index: 0;
      transition:
        transform 0.44s cubic-bezier(0.34, 1.56, 0.64, 1),
        width     0.44s cubic-bezier(0.34, 1.56, 0.64, 1);
      will-change: transform, width;
    }

    .cmn-item {
      flex: 1 1 0;
      min-width: 0;
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 9px 4px 8px;
      background: transparent;
      border: none;
      cursor: pointer;
      color: rgba(255, 255, 255, 0.38);
      font-family: inherit;
      -webkit-tap-highlight-color: transparent;
      transition: color 0.25s ease;
    }
    .cmn-item.is-active { color: #fff; }

    .cmn-icon {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    transition:
      transform 0.28s ease-out,
      width     0.28s ease-out;    .cmn-item:active .cmn-icon      { transform: scale(0.9); }

    .cmn-icon svg {
      width: 22px;
      height: 22px;
      transition: stroke 0.2s ease, filter 0.2s ease;
    }
    .cmn-item.is-active .cmn-icon svg {
      filter: drop-shadow(0 0 8px rgba(99, 102, 241, 0.65));
      stroke: #c7d2fe;
    }

    .cmn-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.02em;
      line-height: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
      transition: color 0.2s ease, transform 0.2s ease;
    }
    .cmn-item.is-active .cmn-label { color: #fff; }

    /* Badge — matches the desktop .badge treatment but positioned inside
       the icon area so it stays glued to the bell/cart glyph */
    .cmn-badge {
      position: absolute;
      top: -5px;
      right: -7px;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      border-radius: 999px;
      background: #ef4444;
      color: #fff;
      font-size: 10px;
      font-weight: 800;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 2px solid #0b0d12;
      box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4);
      animation: cmn-badge-pop 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .cmn-badge.hidden { display: none; }

    @keyframes cmn-badge-pop {
      from { transform: scale(0.5); opacity: 0; }
      to   { transform: scale(1);   opacity: 1; }
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Build the nav
// ---------------------------------------------------------------------------
function buildNav() {
  if (document.getElementById("client-mobile-nav")) return;

  navWrap = document.createElement("div");
  navWrap.id = "client-mobile-nav";
  navWrap.className = "cmn-wrap";
  navWrap.setAttribute("role", "navigation");
  navWrap.setAttribute("aria-label", "Primary");

  const nav = document.createElement("div");
  nav.className = "cmn";

  const inner = document.createElement("div");
  inner.className = "cmn-inner";

  pillEl = document.createElement("div");
  pillEl.className = "cmn-pill";
  inner.appendChild(pillEl);

  TABS.forEach(tab => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cmn-item" + (tab.index === 0 ? " is-active" : "");
    btn.dataset.tabIndex = tab.index;
    btn.setAttribute("aria-label", tab.label);
    btn.innerHTML = `
      <span class="cmn-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          ${ICONS[tab.icon]}
        </svg>
        ${tab.badgeKey ? `<span class="cmn-badge ${tab.badgeKey}-notif hidden" data-badge="${tab.badgeKey}">0</span>` : ""}
      </span>
      <span class="cmn-label">${tab.label}</span>
    `;
    btn.addEventListener("click", () => handleTabClick(tab.index));
    inner.appendChild(btn);
  });

  nav.appendChild(inner);
  navWrap.appendChild(nav);
  document.body.appendChild(navWrap);

  // Position the pill over the initially-active tab once layout has settled
  requestAnimationFrame(() => movePill(0));
}

// ---------------------------------------------------------------------------
// Pill movement
// ---------------------------------------------------------------------------
function movePill(index) {
  if (!pillEl || !navWrap) return;
  const items = navWrap.querySelectorAll(".cmn-item");
  const item = items[index];
  if (!item) return;
  pillEl.style.width = `${item.offsetWidth}px`;
  pillEl.style.transform = `translateX(${item.offsetLeft}px)`;
}

// ---------------------------------------------------------------------------
// Tab click
// ---------------------------------------------------------------------------
function handleTabClick(index) {
  if (index === activeIndex) {
    // Re-tapping the active tab — soft "go to top" behaviour
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  if (navigator.vibrate) navigator.vibrate(HAPTIC_MS);

  activeIndex = index;

  navWrap.querySelectorAll(".cmn-item").forEach((el, i) => {
    el.classList.toggle("is-active", i === index);
  });
  movePill(index);

  // Hand off to the shared tab switcher exposed by dashboard.js
  if (typeof window.switchClientTab === "function") {
    window.switchClientTab(index);
  } else {
    console.warn("client-mobile-nav: window.switchClientTab is not defined");
  }
}

// ---------------------------------------------------------------------------
// Scroll hide / show
// ---------------------------------------------------------------------------
function initScrollBehaviour() {
  lastY = window.scrollY;

  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;

    requestAnimationFrame(() => {
      const y = window.scrollY;
      const dy = y - lastY;

      if (Math.abs(dy) > SCROLL_DELTA) {
        if (dy > 0 && y > SCROLL_HIDE_MIN) {
          navWrap?.classList.add("cmn-hidden");
        } else {
          navWrap?.classList.remove("cmn-hidden");
        }
        lastY = y;
      }

      ticking = false;
    });
  }, { passive: true });
}

// ---------------------------------------------------------------------------
// Keep the pill aligned on resize / orientation change
// ---------------------------------------------------------------------------
function initResizeBehaviour() {
  let rid;
  const onResize = () => {
    clearTimeout(rid);
    rid = setTimeout(() => movePill(activeIndex), 60);
  };
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);

  // Also realign once webfonts have finished swapping in (labels can
  // change width momentarily if the label is wider than the icon)
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => movePill(activeIndex));
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  injectStyles();
  buildNav();
  initScrollBehaviour();
  initResizeBehaviour();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}