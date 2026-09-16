/**
 * driver-map.js
 * -----------------------------------------------------------------------
 * Driver-side map — Google-Maps-style live navigation.
 *
 *   - CartoDB Voyager tiles (Google-like aesthetic)
 *   - Driver marker always visible (GPS fallback if stream silent)
 *   - Follow mode: map tracks the driver at street zoom
 *   - Routes ordered by proximity: closest stop = pin #1, thickest route
 *   - Casing style: dark shadow + white outline + colored core (Google look)
 *   - Turn-by-turn banner: next maneuver + distance + ETA to stop #1
 *   - Tap a pin to preview that route; recenter button rejoins follow mode
 * -----------------------------------------------------------------------
 */

import { onDriverPosition } from "./live-tracking.js";

const LEAFLET_CSS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
const LEAFLET_JS  = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
const OSRM_URL    = "https://router.project-osrm.org/route/v1/driving";
const NAIROBI     = { lat: -1.286389, lng: 36.817223 };

const ROUTE_COLORS = [
  "#1a73e8", // google blue (primary / closest)
  "#f43f5e", // rose
  "#f59e0b", // amber
  "#06b6d4", // cyan
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#14b8a6", // teal
  "#84cc16", // lime
];


const FOLLOW_ZOOM       = 16.5;
const OVERVIEW_PADDING  = [70, 70];

// Primary (closest) order — recalculates often so turn-by-turn stays fresh
const PRIMARY_RECALC_MOVE_M = 80;
const PRIMARY_RECALC_MS     = 30000;

// Non-primary orders — just need a route line; no reason to hammer OSRM
const NONPRIMARY_RECALC_MOVE_M = 150;
const NONPRIMARY_RECALC_MS     = 90000;

let L = null;
let map = null;
let driverMarker = null;
let driverFallbackWatchId = null;
let lastDriverPos = null;
let lastDriverHeading = null;
let unsubscribePosition = null;
let currentOrders = [];
let stylesInjected = false;
let followMode = true;
let hasSeenFirstFix = false;

// orderId -> { marker, tooltip, halos[], core, legShadow, steps, distanceM, durationS, cachedFrom, cachedAt, rank }
const orderRoutes = new Map();
// orderId -> color idx (stable per session)
// Persist across page reloads so a driver's mental map of colors survives a refresh
const COLORS_STORAGE_KEY = "driver-map:orderColors";
let orderColorIdx = new Map(
  (() => {
    try {
      const raw = sessionStorage.getItem(COLORS_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  })()
);
let nextColorIdx = orderColorIdx.size;

function persistOrderColors() {
  try {
    sessionStorage.setItem(COLORS_STORAGE_KEY, JSON.stringify([...orderColorIdx]));
  } catch {}
}

let routeFlushTimer = null;
let turnBannerEl = null;

// ---------------------------------------------------------------------------
// Leaflet loader
// ---------------------------------------------------------------------------
let leafletPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = LEAFLET_JS;
    script.onload  = () => resolve(window.L);
    script.onerror = () => reject(new Error("Failed to load Leaflet"));
    document.head.appendChild(script);
  });
  return leafletPromise;
}

// ---------------------------------------------------------------------------
// Injected styles
// ---------------------------------------------------------------------------
function injectMapStyles() {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement("style");
  style.id = "driver-map-styles";
  style.textContent = `
    .leaflet-container { background: #e8eaed; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }

    /* Permanent name label under each order pin */
    .leaflet-tooltip.route-label {
      background: #ffffff;
      border: 1px solid rgba(0,0,0,0.08);
      color: #202124;
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 600;
      line-height: 1.2;
      box-shadow: 0 2px 6px rgba(0,0,0,0.15);
      white-space: nowrap;
      pointer-events: none;
    }
    .leaflet-tooltip.route-label::before { display: none; }
    .route-label-phone {
      font-size: 10px;
      font-weight: 500;
      color: #5f6368;
      margin-top: 1px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    /* Popup — Google-ish */
    .leaflet-popup-content-wrapper {
      border-radius: 12px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.22);
      padding: 0;
    }
    .leaflet-popup-content { margin: 0; }
    .leaflet-popup-tip { box-shadow: 0 3px 12px rgba(0,0,0,0.15); }

    /* Driver marker — Google-style blue dot */
    @keyframes gmap-driver-pulse {
      0%   { transform: scale(0.6); opacity: 0.55; }
      100% { transform: scale(2.2); opacity: 0; }
    }
    .gmap-driver-wrap { position: relative; width: 100%; height: 100%; }
    .gmap-driver-ring {
      position: absolute; inset: -4px;
      border-radius: 50%;
      background: #1a73e8;
      opacity: 0.25;
      animation: gmap-driver-pulse 2.2s ease-out infinite;
    }
    .gmap-driver-dot {
      position: absolute; inset: 0;
      border-radius: 50%;
      background: #1a73e8;
      border: 3px solid #ffffff;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4), 0 0 0 1px rgba(0,0,0,0.05);
    }
    .gmap-driver-heading {
      position: absolute;
      top: 50%; left: 50%;
      width: 0; height: 0;
      transform-origin: 0 0;
      pointer-events: none;
    }
    .gmap-driver-heading::before {
      content: '';
      position: absolute;
      left: -14px; top: -34px;
      border-left: 14px solid transparent;
      border-right: 14px solid transparent;
      border-bottom: 22px solid #1a73e8;
      filter: drop-shadow(0 2px 3px rgba(0,0,0,0.3));
    }

    /* Turn-by-turn banner */
    .gmap-turn-banner {
      position: absolute;
      left: 12px; right: 12px; bottom: 82px;
      background: #ffffff;
      border-radius: 14px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.22);
      padding: 12px 14px;
      display: flex;
      align-items: center;
      gap: 12px;
      z-index: 500;
      transition: transform 0.25s ease, opacity 0.25s ease;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .gmap-turn-banner.hidden {
      transform: translateY(20px);
      opacity: 0;
      pointer-events: none;
    }
    .gmap-turn-icon {
      flex-shrink: 0;
      width: 44px; height: 44px;
      border-radius: 12px;
      background: #1a73e8;
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
    }
    .gmap-turn-text { flex: 1; min-width: 0; }
    .gmap-turn-primary {
      font-size: 14px;
      font-weight: 700;
      color: #202124;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .gmap-turn-sub {
      font-size: 12px;
      color: #5f6368;
      margin-top: 2px;
    }
    .gmap-turn-eta {
      flex-shrink: 0;
      text-align: right;
      font-size: 13px;
      font-weight: 700;
      color: #188038;
    }
    .gmap-turn-eta small {
      display: block;
      font-size: 10px;
      font-weight: 500;
      color: #5f6368;
      margin-top: 1px;
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Coordinate resolution
// ---------------------------------------------------------------------------
function extractCoords(order) {
  const addr = order?.delivery?.address;
  if (!addr) return null;
  const candidates = [addr.addressDraft, addr];
  for (const c of candidates) {
    if (!c) continue;
    const lat = Number(c.lat);
    const lng = Number(c.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
      return { lat, lng };
    }
  }
  return null;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ---------------------------------------------------------------------------
// Color + icon
// ---------------------------------------------------------------------------
function getOrderColor(orderId, rank = 0) {
  if (!orderColorIdx.has(orderId)) {
    orderColorIdx.set(orderId, nextColorIdx % ROUTE_COLORS.length);
    nextColorIdx++;
    persistOrderColors();   
  }
  if (rank === 0) return ROUTE_COLORS[0];
  const idx = orderColorIdx.get(orderId);
  return ROUTE_COLORS[idx === 0 ? 1 : idx];
}

function driverIcon() {
  const heading = lastDriverHeading;
  const showHeading = Number.isFinite(heading);
  return L.divIcon({
    className: "",
    html: `
      <div class="gmap-driver-wrap">
        <div class="gmap-driver-ring"></div>
        ${showHeading ? `<div class="gmap-driver-heading" style="transform:rotate(${heading}deg);"></div>` : ""}
        <div class="gmap-driver-dot"></div>
      </div>
    `,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function orderPinIcon(label, color, isPrimary) {
  const size = isPrimary ? 40 : 32;
  const fontSize = isPrimary ? 15 : 13;
  return L.divIcon({
    className: "",
    html: `
      <div style="
        width:${size}px;height:${size}px;border-radius:50% 50% 50% 0;
        transform:rotate(-45deg);
        background:${color};
        border:3px solid #ffffff;
        box-shadow:0 3px 10px rgba(0,0,0,0.35);
        display:flex;align-items:center;justify-content:center;
      ">
        <span style="transform:rotate(45deg);color:#fff;font-weight:900;font-size:${fontSize}px;
                     text-shadow:0 1px 2px rgba(0,0,0,0.35);">${label}</span>
      </div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
  });
}

// ---------------------------------------------------------------------------
// Map init
// ---------------------------------------------------------------------------
export async function initDriverMap(containerId) {
  if (map) return map;

  const container = document.getElementById(containerId);
  if (!container) {
    console.error(`driver-map: container #${containerId} not found`);
    return null;
  }

  L = await loadLeaflet();
  injectMapStyles();

  map = L.map(container, {
    zoomControl: false,
    attributionControl: false,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
  }).setView([NAIROBI.lat, NAIROBI.lng], 13);

    // Esri World Street Map — free, no API key, Google-Maps-like palette.
  // Note the {z}/{y}/{x} order — Esri uses Y before X, unlike most providers.
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "",
    }
  ).addTo(map);

  // Follow mode tracking — if the user pans away, drop out of follow mode
  map.on("dragstart", () => { followMode = false; });
  map.on("zoomstart", (e) => {
    // Only user-initiated zooms cancel follow (not our own setView)
    if (e.hard) followMode = false;
  });

  // Mount turn banner
  turnBannerEl = document.createElement("div");
  turnBannerEl.className = "gmap-turn-banner hidden";
  turnBannerEl.innerHTML = `
    <div class="gmap-turn-icon" id="gmap-turn-icon">⬆</div>
    <div class="gmap-turn-text">
      <div class="gmap-turn-primary" id="gmap-turn-primary">Locating…</div>
      <div class="gmap-turn-sub" id="gmap-turn-sub">—</div>
    </div>
    <div class="gmap-turn-eta" id="gmap-turn-eta">—<small>ETA</small></div>
  `;
  container.parentElement.appendChild(turnBannerEl);

  // Subscribe to the shared GPS stream
  unsubscribePosition = onDriverPosition((coords, meta) => {
    applyDriverFix(coords, meta);
  });

  // Fallback: if live-tracking hasn't emitted in 3s, self-start a watch so
  // the driver marker still appears (e.g. no active orders yet).
  setTimeout(() => {
    if (lastDriverPos) return;
    startFallbackWatch();
  }, 3000);

  if (currentOrders.length) renderOrderMarkers();

  return map;
}

function startFallbackWatch() {
  if (!navigator.geolocation || driverFallbackWatchId != null) return;
  driverFallbackWatchId = navigator.geolocation.watchPosition(
    (pos) => applyDriverFix(
      { lat: pos.coords.latitude, lng: pos.coords.longitude },
      { heading: pos.coords.heading, speed: pos.coords.speed }
    ),
    (err) => console.warn("fallback geolocation failed:", err),
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
  );
}

function applyDriverFix(coords, meta) {
  lastDriverPos = coords;
  if (meta && Number.isFinite(meta.heading)) lastDriverHeading = meta.heading;

  if (!driverMarker) {
    driverMarker = L.marker([coords.lat, coords.lng], {
      icon: driverIcon(),
      zIndexOffset: 1000,
      interactive: false,
    }).addTo(map);

    // First fix — jump to street-level zoom and fit any existing routes
    hasSeenFirstFix = true;
    if (orderRoutes.size > 0) {
      fitAllRoutes();
    } else {
      map.setView([coords.lat, coords.lng], FOLLOW_ZOOM, { animate: true });
    }
  } else {
    if (driverMarker._icon) {
      driverMarker._icon.style.transition = "transform 0.9s linear";
    }
    driverMarker.setLatLng([coords.lat, coords.lng]);
    driverMarker.setIcon(driverIcon()); // refresh heading rotation
  }

  // Follow mode — recenter on driver
  if (followMode) {
    map.setView([coords.lat, coords.lng], Math.max(map.getZoom(), FOLLOW_ZOOM), {
      animate: true,
      duration: 0.6,
    });
  }

  queueRouteRefresh();
}

// ---------------------------------------------------------------------------
// Orders sync
// ---------------------------------------------------------------------------
export function setDriverMapOrders(orders) {
  currentOrders = Array.isArray(orders) ? orders : [];
  if (!map) return;
  renderOrderMarkers();
}

function computeOrderRanks() {
  // Rank orders by straight-line distance from the driver.
  // Rank 0 = closest = primary destination (thicker route, blue pin).
  if (!lastDriverPos) {
    // No driver position yet — keep original order
    currentOrders.forEach((o, i) => { o.__rank = i; });
    return currentOrders;
  }

  const withDist = currentOrders
    .map((o) => {
      const c = extractCoords(o);
      return {
        order: o,
        dist: c ? haversineMeters(lastDriverPos, c) : Number.POSITIVE_INFINITY,
      };
    })
    .sort((a, b) => a.dist - b.dist);

  withDist.forEach((item, i) => { item.order.__rank = i; });
  return withDist.map((x) => x.order);
}

function renderOrderMarkers() {
  if (!map || !L) return;

  const ranked = computeOrderRanks();
  const seenIds = new Set();

  ranked.forEach((order) => {
    const coords = extractCoords(order);
    if (!coords) return;

    seenIds.add(order.id);

    const rank = order.__rank ?? 0;
    const label = String(rank + 1);
    const color = getOrderColor(order.id, rank);
    const isPrimary = rank === 0;
    const isActive = ["assigned", "out for delivery"].includes(
      (order.status || "").toLowerCase()
    );

    const entry = orderRoutes.get(order.id);
    const icon = orderPinIcon(label, color, isPrimary);

    if (entry?.marker) {
      entry.marker.setLatLng([coords.lat, coords.lng]);
      entry.marker.setIcon(icon);
      entry.marker.setTooltipContent(buildTooltipHtml(order));
      entry.marker.setPopupContent(buildPopupHtml(order, coords, color));
      entry.rank = rank;
    } else {
      const marker = L.marker([coords.lat, coords.lng], {
        icon,
        riseOnHover: true,
        zIndexOffset: isPrimary ? 500 : 0,
      }).addTo(map);

      marker.bindTooltip(buildTooltipHtml(order), {
        permanent: true,
        direction: "bottom",
        offset: [0, 6],
        className: "route-label",
        opacity: 1,
      });

      marker.bindPopup(buildPopupHtml(order, coords, color), {
        closeButton: false,
        autoPan: true,
        maxWidth: 260,
        offset: [0, -12],
      });

      marker.on("click", () => {
        followMode = false;
        focusOnOrder(order.id);
      });

      orderRoutes.set(order.id, {
        marker,
        halos: null,
        core: null,
        legShadow: null,
        steps: null,
        distanceM: null,
        durationS: null,
        cachedFrom: null,
        cachedAt: 0,
        rank,
      });
    }
  });

  // Remove markers/routes for orders that completed
  for (const [id, entry] of orderRoutes.entries()) {
    if (!seenIds.has(id)) {
      if (entry.marker) map.removeLayer(entry.marker);
      if (entry.halos) entry.halos.forEach((h) => map.removeLayer(h));
      if (entry.core) map.removeLayer(entry.core);
      if (entry.legShadow) map.removeLayer(entry.legShadow);
      orderRoutes.delete(id);
    }
  }

  queueRouteRefresh();
}

function buildTooltipHtml(order) {
  const addr = order.delivery?.address || {};
  const clientName = addr.clientName || "Customer";
  const phone = addr.phoneNumber || "";
  const firstName = clientName.split(" ")[0];
  return `
    <div>${escHtml(firstName)}</div>
    ${phone ? `<div class="route-label-phone">${escHtml(phone)}</div>` : ""}
  `;
}

function buildPopupHtml(order, coords, color) {
  const addr = order.delivery?.address || {};
  const clientName = addr.clientName || "Customer";
  const phone = addr.phoneNumber || "";
  const street = addr.streetAddress || "";
  const city = addr.city || "";
  const productName = order.name || "Order";
  const entry = orderRoutes.get(order.id);

  const distTxt = entry?.distanceM != null ? formatDistance(entry.distanceM) : "—";
  const durTxt  = entry?.durationS != null ? formatDuration(entry.durationS) : "—";
  const addressLine = [street, city].filter(Boolean).join(", ");

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:14px 16px;min-width:220px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};"></span>
        <span style="font-size:14px;font-weight:700;color:#202124;">${escHtml(productName)}</span>
      </div>
      <div style="font-size:13px;color:#3c4043;">${escHtml(clientName)}</div>
      ${phone ? `<div style="font-size:12px;color:#5f6368;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:2px;">${escHtml(phone)}</div>` : ""}
      ${addressLine ? `<div style="font-size:12px;color:#5f6368;margin-top:6px;">${escHtml(addressLine)}</div>` : ""}
      <div style="font-size:12px;color:#188038;font-weight:600;margin-top:8px;">
        ${distTxt} · ${durTxt}
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;">
        <a href="https://www.google.com/maps/dir/?api=1&destination=${coords.lat},${coords.lng}&travelmode=driving"
           target="_blank" rel="noopener"
           style="flex:1;text-align:center;font-size:12px;font-weight:600;
                  background:#1a73e8;color:#fff;padding:9px 10px;border-radius:8px;text-decoration:none;">
          Navigate
        </a>
        ${phone ? `
          <a href="tel:${escHtml(phone)}"
             style="flex:1;text-align:center;font-size:12px;font-weight:600;
                    background:#188038;color:#fff;padding:9px 10px;border-radius:8px;text-decoration:none;">
            Call
          </a>
        ` : ""}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Route fetching (OSRM)
// ---------------------------------------------------------------------------
function queueRouteRefresh() {
  if (!lastDriverPos || orderRoutes.size === 0) return;
  if (routeFlushTimer) return;
  routeFlushTimer = setTimeout(() => {
    routeFlushTimer = null;
    refreshAllRoutes();
  }, 400);
}
async function refreshAllRoutes() {
  if (!lastDriverPos) return;

  // Re-rank based on current driver position, then update pin visuals
  const ranked = computeOrderRanks();
  ranked.forEach((order) => {
    const rank = order.__rank ?? 0;
    const entry = orderRoutes.get(order.id);
    if (!entry?.marker) return;
    if (entry.rank !== rank) {
      const coords = extractCoords(order);
      if (!coords) return;
      entry.marker.setIcon(
        orderPinIcon(String(rank + 1), getOrderColor(order.id, rank), rank === 0)
      );
      entry.rank = rank;
    }
  });

  for (const [orderId, entry] of orderRoutes.entries()) {
    if (!entry.marker) continue;

    const isPrimary = entry.rank === 0;
    const minMove = isPrimary ? PRIMARY_RECALC_MOVE_M : NONPRIMARY_RECALC_MOVE_M;
    const minMs   = isPrimary ? PRIMARY_RECALC_MS     : NONPRIMARY_RECALC_MS;

    // Skip if we routed to roughly this spot recently enough
    if (entry.cachedFrom && entry.cachedAt) {
      const moved = haversineMeters(entry.cachedFrom, lastDriverPos);
      const elapsed = Date.now() - entry.cachedAt;
      if (moved < minMove && elapsed < minMs) continue;
    }

    const dest = entry.marker.getLatLng();
    fetchAndDrawRoute(orderId, lastDriverPos, { lat: dest.lat, lng: dest.lng });
  }

  updateTurnBanner();
}

async function fetchAndDrawRoute(orderId, from, to) {
  if (!map || !L) return;
  const entry = orderRoutes.get(orderId);
  if (!entry) return;

  const color = getOrderColor(orderId, entry.rank);
  const rank = entry.rank ?? 0;
  const primary = rank === 0;

  const url =
    `${OSRM_URL}/${from.lng},${from.lat};${to.lng},${to.lat}` +
    `?overview=full&geometries=geojson&steps=true&annotations=false`;

  let latlngs = null;
  let steps = null;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM ${res.status}`);
    const data = await res.json();
    const route = data?.routes?.[0];
    if (!route?.geometry?.coordinates) throw new Error("No route in OSRM response");

    latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    entry.distanceM = route.distance;
    entry.durationS = route.duration;
    steps = route.legs?.[0]?.steps || null;
  } catch (err) {
    console.warn(`route fetch failed for order ${orderId}:`, err);
    latlngs = [[from.lat, from.lng], [to.lat, to.lng]];
    entry.distanceM = haversineMeters(from, to);
    entry.durationS = Math.round(entry.distanceM / 8);
    steps = null;
  }

  entry.cachedFrom = { ...from };
  entry.cachedAt = Date.now();
  entry.steps = steps;

  // Google-style casing:
  //   Layer 1 (bottom): dark shadow, slightly wider
  //   Layer 2 (mid):    white casing
  //   Layer 3 (top):    colored route
  const w = primary ? 7 : 5;
  const wShadow = w + 4;
  const wCase = w + 2;

  if (entry.core && entry.halos) {
    entry.core.setLatLngs(latlngs);
    entry.core.setStyle({ color, weight: w });
    entry.halos[0].setLatLngs(latlngs);
    entry.halos[0].setStyle({ weight: wShadow });
    entry.halos[1].setLatLngs(latlngs);
    entry.halos[1].setStyle({ weight: wCase });
  } else {
    const shadow = L.polyline(latlngs, {
      color: "#000000",
      weight: wShadow,
      opacity: 0.18,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }).addTo(map);

    const casing = L.polyline(latlngs, {
      color: "#ffffff",
      weight: wCase,
      opacity: 0.95,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }).addTo(map);

    const core = L.polyline(latlngs, {
      color,
      weight: w,
      opacity: 1,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }).addTo(map);

    entry.halos = [shadow, casing];
    entry.core = core;
  }

  // Refresh popup + tooltip with new info
  const order = currentOrders.find((o) => o.id === orderId);
  if (entry.marker && order) {
    const coords = extractCoords(order);
    if (coords) entry.marker.setPopupContent(buildPopupHtml(order, coords, color));
  }

  updateTurnBanner();
}

// ---------------------------------------------------------------------------
// Turn-by-turn banner
// ---------------------------------------------------------------------------
function updateTurnBanner() {
  if (!turnBannerEl) return;

  // Find primary order (rank 0)
  let primaryId = null;
  for (const [id, entry] of orderRoutes.entries()) {
    if (entry.rank === 0) { primaryId = id; break; }
  }

  // Nothing to navigate to — hide cleanly
  if (orderRoutes.size === 0) {
    turnBannerEl.classList.add("hidden");
    return;
  }

  if (primaryId == null) {
    turnBannerEl.classList.add("hidden");
    return;
  }

  const entry = orderRoutes.get(primaryId);
  const order = currentOrders.find((o) => o.id === primaryId);
  if (!entry || !order) {
    turnBannerEl.classList.add("hidden");
    return;
  }

  const addr = order.delivery?.address || {};
  const firstName = (addr.clientName || "Customer").split(" ")[0];
  const productName = order.name || "Order";

  const distTxt = entry.distanceM != null ? formatDistance(entry.distanceM) : "—";
  const durTxt  = entry.durationS != null ? formatDuration(entry.durationS) : "—";

  // Next maneuver — parse OSRM steps
  let icon = "⬆";
  let primary = `Head to ${firstName}`;
  let sub = `${productName} · ${distTxt} away`;

  if (entry.steps && entry.steps.length > 1) {
    // step[0] is the very first "depart" step; step[1] is the first real maneuver
    const s = entry.steps[1];
    const m = s.maneuver || {};
    icon = maneuverIcon(m);
    primary = maneuverText(m, s.name);
    sub = `in ${formatDistance(s.distance ?? 0)}`;
  }

  turnBannerEl.classList.remove("hidden");
  turnBannerEl.querySelector("#gmap-turn-icon").textContent = icon;
  turnBannerEl.querySelector("#gmap-turn-primary").textContent = primary;
  turnBannerEl.querySelector("#gmap-turn-sub").textContent = sub;
  turnBannerEl.querySelector("#gmap-turn-eta").innerHTML = `${durTxt}<small>ETA · ${distTxt}</small>`;
}

function maneuverIcon(m) {
  const t = m.type;
  const mod = m.modifier || "";
  if (t === "arrive") return "🏁";
  if (t === "depart") return "⬆";
  if (t === "roundabout" || t === "rotary") return "🔄";
  if (t === "merge") return "⇗";
  if (t === "fork") return mod.includes("left") ? "↖" : "↗";
  if (t === "turn" || t === "new name" || t === "continue") {
    if (mod.includes("sharp left")) return "↰";
    if (mod.includes("sharp right")) return "↱";
    if (mod.includes("left")) return "↰";
    if (mod.includes("right")) return "↱";
    if (mod.includes("uturn")) return "↺";
    return "⬆";
  }
  return "⬆";
}

function maneuverText(m, streetName) {
  const t = m.type;
  const mod = m.modifier || "";
  const road = streetName ? ` onto ${streetName}` : "";

  if (t === "arrive") return "Arrive at destination";
  if (t === "depart") return "Head out";
  if (t === "roundabout" || t === "rotary") {
    const exit = m.exit ? `Take exit ${m.exit}` : "Take the roundabout";
    return `${exit}${road}`;
  }
  if (t === "merge") return `Merge${road}`;
  if (t === "fork") return mod.includes("left") ? `Keep left${road}` : `Keep right${road}`;
  if (t === "turn" || t === "continue" || t === "new name") {
    if (mod.includes("uturn")) return `Make a U-turn${road}`;
    if (mod.includes("sharp left")) return `Sharp left${road}`;
    if (mod.includes("sharp right")) return `Sharp right${road}`;
    if (mod.includes("slight left")) return `Slight left${road}`;
    if (mod.includes("slight right")) return `Slight right${road}`;
    if (mod.includes("left")) return `Turn left${road}`;
    if (mod.includes("right")) return `Turn right${road}`;
    return `Continue${road}`;
  }
  return `Continue${road}`;
}

// ---------------------------------------------------------------------------
// Focus / recenter
// ---------------------------------------------------------------------------
function focusOnOrder(orderId) {
  if (!map || !L) return;
  const entry = orderRoutes.get(orderId);
  const points = [];

  if (lastDriverPos) points.push([lastDriverPos.lat, lastDriverPos.lng]);
  if (entry?.marker) points.push(entry.marker.getLatLng());
  if (entry?.core) {
    entry.core.getLatLngs().forEach((pt) => points.push(pt));
  }

  if (points.length) {
    map.fitBounds(L.latLngBounds(points), { padding: OVERVIEW_PADDING, maxZoom: 16.5 });
  }
}

function fitAllRoutes() {
  if (!map || !L) return;
  const points = [];
  if (lastDriverPos) points.push([lastDriverPos.lat, lastDriverPos.lng]);
  orderRoutes.forEach((entry) => {
    if (entry.marker) points.push(entry.marker.getLatLng());
  });
  if (points.length < 2) {
    if (lastDriverPos) map.setView([lastDriverPos.lat, lastDriverPos.lng], FOLLOW_ZOOM);
    return;
  }
  map.fitBounds(L.latLngBounds(points), { padding: OVERVIEW_PADDING, maxZoom: 15.5 });
}

export function recenterDriverMap() {
  if (!map || !L) return;
  followMode = true;
  if (lastDriverPos) {
    map.setView([lastDriverPos.lat, lastDriverPos.lng], FOLLOW_ZOOM, { animate: true });
  } else {
    fitAllRoutes();
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function formatDistance(m) {
  if (m == null) return "—";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function formatDuration(s) {
  if (s == null) return "—";
  const mins = Math.round(s / 60);
  if (mins < 1) return "<1 min";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const r = mins % 60;
  return `${h}h ${r}m`;
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
export function destroyDriverMap() {
  if (routeFlushTimer) {
    clearTimeout(routeFlushTimer);
    routeFlushTimer = null;
  }
  if (driverFallbackWatchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(driverFallbackWatchId);
    driverFallbackWatchId = null;
  }
  if (unsubscribePosition) {
    unsubscribePosition();
    unsubscribePosition = null;
  }
  if (turnBannerEl) {
    turnBannerEl.remove();
    turnBannerEl = null;
  }
  if (map) {
    map.remove();
    map = null;
  }
  driverMarker = null;
  orderRoutes.clear();
  orderColorIdx.clear();
  nextColorIdx = 0;
  currentOrders = [];
  lastDriverPos = null;
  lastDriverHeading = null;
  hasSeenFirstFix = false;
  followMode = true;
}