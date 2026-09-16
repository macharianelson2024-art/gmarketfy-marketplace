/**
 * live-tracking.js
 * -----------------------------------------------------------------------
 * Driver-side location broadcasting (writes to Realtime Database) +
 * client-side live preview map with real road routes and labeled markers.
 *
 * Realtime Database structure:
 *   /driverLocations/{driverId}
 *       lat, lng, heading, speed
 *       updatedAt: RTDB server timestamp
 *       activeOrderId: string | null
 *
 * Driver usage (driver dashboard):
 *   import { startDriverLocationSharing, stopDriverLocationSharing, onDriverPosition } from './live-tracking.js';
 *   startDriverLocationSharing(driverId, orderId);
 *   const off = onDriverPosition((coords, meta) => { ... });  // for the driver map
 *   stopDriverLocationSharing(driverId);
 *
 * Client usage (order tracking card / modal):
 *   import { initLiveTrackingPreview } from './live-tracking.js';
 *   const tracker = await initLiveTrackingPreview(slotEl, {
 *     driverId: order.driverId,
 *     orderId: order.id,
 *     destination: { lat: 1.23, lng: 4.56 },
 *     height: 420,          // optional — default 240
 *     driverName: "John",   // optional — labels the driver pin with their name
 *   });
 *   tracker.destroy();
 * -----------------------------------------------------------------------
 */

import {
  getDatabase, ref, update, onValue, onDisconnect, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

const WRITE_INTERVAL_MS = 5000;
const MIN_MOVE_METERS   = 10;

const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
const LEAFLET_JS  = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';

// ---------------------------------------------------------------------------
// GPS position listeners — let other components (e.g. driver-map.js) share
// the same GPS watcher instead of starting their own.
// ---------------------------------------------------------------------------
const positionListeners = new Set();

export function onDriverPosition(callback) {
  positionListeners.add(callback);
  return () => positionListeners.delete(callback);
}

function emitPosition(coords, meta) {
  positionListeners.forEach((cb) => {
    try { cb(coords, meta); } catch (e) { console.error('driver position listener failed:', e); }
  });
}

// ---------------------------------------------------------------------------
// Leaflet loader
// ---------------------------------------------------------------------------
let leafletLoadPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = LEAFLET_JS;
    script.onload  = () => resolve(window.L);
    script.onerror = () => reject(new Error('Failed to load Leaflet'));
    document.head.appendChild(script);
  });
  return leafletLoadPromise;
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
// Driver side
// ---------------------------------------------------------------------------
let watchId = null;
let lastWrite = { pos: null, time: 0 };

export function startDriverLocationSharing(driverId, orderId) {
  if (!navigator.geolocation) return;

  // Already running? Just refresh the active order id and bail.
  if (watchId != null) {
    const db = getDatabase();
    update(ref(db, `driverLocations/${driverId}`), { activeOrderId: orderId });
    return;
  }

  const db = getDatabase();
  const locRef = ref(db, `driverLocations/${driverId}`);

  // If the driver's connection drops mid-delivery, clear the active order
  // so clients don't show a stale pin thinking they're being tracked.
  onDisconnect(locRef).update({ activeOrderId: null });

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const now = Date.now();
      const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const meta = { heading: pos.coords.heading, speed: pos.coords.speed };

      // Always notify UI listeners, even if we skip the RTDB write —
      // the map should move even when the driver is parked.
      emitPosition(coords, meta);

      const movedEnough = !lastWrite.pos || haversineMeters(lastWrite.pos, coords) >= MIN_MOVE_METERS;
      const enoughTimePassed = now - lastWrite.time >= WRITE_INTERVAL_MS;
      if (!movedEnough && !enoughTimePassed) return;

      lastWrite = { pos: coords, time: now };
      update(locRef, {
        lat: coords.lat,
        lng: coords.lng,
        heading: pos.coords.heading ?? null,
        speed: pos.coords.speed ?? null,
        updatedAt: serverTimestamp(),
        activeOrderId: orderId,
      });
    },
    (err) => console.error('driver location watch failed:', err),
    { enableHighAccuracy: true, maximumAge: 4000, timeout: 10000 }
  );
}

export function stopDriverLocationSharing(driverId) {
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  lastWrite = { pos: null, time: 0 };
  const db = getDatabase();
  update(ref(db, `driverLocations/${driverId}`), { activeOrderId: null });
}

// ---------------------------------------------------------------------------
// Client side — preview map on the pending-order tracking screen
// ---------------------------------------------------------------------------

const PREVIEW_OSRM      = 'https://router.project-osrm.org/route/v1/driving';
const PREVIEW_RECALC_M  = 60;
const PREVIEW_RECALC_MS = 20000;

function injectPreviewStyles() {
  if (document.getElementById('glt-styles')) return;
  const style = document.createElement('style');
  style.id = 'glt-styles';
  style.textContent = `
    .glt-wrap { position: relative; }

    .glt-status-pill {
      position: absolute; top: 10px; left: 10px;
      display: inline-flex; align-items: center; gap: 6px;
      background: rgba(15,17,21,0.92);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      color: #e8eaed;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      z-index: 300;
      max-width: calc(100% - 20px);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .glt-status-dot {
      width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
      transition: background 0.2s;
    }
    .glt-status-dot.live    { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
    .glt-status-dot.stale   { background: #f59e0b; }
    .glt-status-dot.waiting { background: rgba(255,255,255,0.4); }

    @keyframes glt-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(99,102,241,0.45), 0 4px 14px rgba(99,102,241,0.25); }
      50%      { box-shadow: 0 0 0 10px rgba(99,102,241,0), 0 4px 14px rgba(99,102,241,0.35); }
    }
    .glt-glow-btn { animation: glt-pulse 1.8s ease-in-out infinite; }

    @keyframes glt-driver-ring {
      0%   { transform: scale(0.6); opacity: 0.55; }
      100% { transform: scale(2.2); opacity: 0; }
    }
    .glt-driver-wrap { position: relative; width: 100%; height: 100%; }
    .glt-driver-pulse {
      position: absolute; inset: -3px;
      border-radius: 50%; background: #1a73e8;
      opacity: 0.25;
      animation: glt-driver-ring 2.2s ease-out infinite;
    }
    .glt-driver-dot {
      position: absolute; inset: 0;
      border-radius: 50%; background: #1a73e8;
      border: 2px solid #fff;
      box-shadow: 0 2px 5px rgba(0,0,0,0.35);
    }
    .glt-dest-pin {
      width: 22px; height: 22px;
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
      background: #1a73e8;
      border: 2px solid #fff;
      box-shadow: 0 2px 6px rgba(0,0,0,0.35);
      display: flex; align-items: center; justify-content: center;
    }
    .glt-dest-pin span {
      transform: rotate(45deg);
      font-size: 11px;
      color: #fff;
      line-height: 1;
    }

    /* Permanent marker labels — "You" (destination) + driver name */
    .leaflet-tooltip.glt-label {
      background: rgba(15,17,21,0.94);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: none;
      color: #fff;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.02em;
      box-shadow: 0 3px 10px rgba(0,0,0,0.4);
      white-space: nowrap;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .leaflet-tooltip.glt-label::before { display: none; }

    .leaflet-tooltip.glt-label--you {
      background: #1a73e8;
      box-shadow: 0 3px 12px rgba(26,115,232,0.45);
    }
    .leaflet-tooltip.glt-label--driver {
      background: #16a34a;
      box-shadow: 0 3px 12px rgba(22,163,74,0.45);
    }
  `;
  document.head.appendChild(style);
}

function driverIconSmall(L) {
  return L.divIcon({
    className: '',
    html: `
      <div class="glt-driver-wrap">
        <div class="glt-driver-pulse"></div>
        <div class="glt-driver-dot"></div>
      </div>
    `,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function destinationIcon(L) {
  return L.divIcon({
    className: '',
    html: `<div class="glt-dest-pin"><span>🏠</span></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 22],
  });
}

/**
 * @param {HTMLElement} container
 * @param {Object} opts
 * @param {string} opts.driverId
 * @param {string} opts.orderId      — scopes this preview to one specific order
 * @param {{lat:number,lng:number}} opts.destination
 * @param {number} [opts.height=240] — map pixel height
 * @param {string} [opts.driverName] — first name shown on the driver label
 * @returns {Promise<{ destroy: () => void }>}
 */
export async function initLiveTrackingPreview(container, {
  driverId,
  orderId,
  destination,
  height = 240,
  driverName = '',
}) {
  if (!container) return { destroy: () => {} };
  if (!driverId || !orderId || !destination || destination.lat == null || destination.lng == null) {
    console.warn('initLiveTrackingPreview: missing driverId / orderId / destination');
    return { destroy: () => {} };
  }

  const L = await loadLeaflet();
  injectPreviewStyles();

  container.innerHTML = `
    <div class="glt-wrap rounded-2xl overflow-hidden border border-white/10 bg-[#14161c]">
      <div class="glt-map" style="height:${height}px;"></div>
      <div class="glt-status-pill">
        <span class="glt-status-dot waiting" id="glt-dot"></span>
        <span id="glt-status-text">Locating driver…</span>
      </div>
      <button type="button" class="glt-expand absolute left-1/2 -translate-x-1/2 bottom-4
        opacity-0 pointer-events-none translate-y-2 transition-all duration-300
        flex items-center gap-2 rounded-full bg-gradient-to-r from-indigo-500 to-violet-500
        px-4 py-2 text-xs font-semibold text-white z-[400]">
        Open in Google Maps
      </button>
    </div>
  `;

  const mapEl      = container.querySelector('.glt-map');
  const statusText = container.querySelector('#glt-status-text');
  const statusDot  = container.querySelector('#glt-dot');
  const expandBtn  = container.querySelector('.glt-expand');
  const wrap       = container.querySelector('.glt-wrap');

  const map = L.map(mapEl, {
    zoomControl: false,
    attributionControl: false,
    dragging: true,
    scrollWheelZoom: false,
    zoomSnap: 0.25,
  }).setView([destination.lat, destination.lng], 14);

  // Esri tiles — matches the driver dashboard look, no API key needed
  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19 }
  ).addTo(map);

  // Destination pin — always visible, permanently labeled "You"
  const destinationMarker = L.marker([destination.lat, destination.lng], {
    icon: destinationIcon(L),
    interactive: false,
    zIndexOffset: 100,
  }).addTo(map);

  destinationMarker.bindTooltip('You', {
    permanent: true,
    direction: 'top',
    offset: [0, -26],
    className: 'glt-label glt-label--you',
    opacity: 1,
  });

  let driverMarker = null;
  let routeShadow = null;
  let routeCasing = null;
  let routeCore = null;
  let lastDriverPos = null;
  let lastRouteFrom = null;
  let lastRouteAt = 0;
  let boundsFitted = false;

  const db = getDatabase();
  const locRef = ref(db, `driverLocations/${driverId}`);

  const unsubscribe = onValue(locRef, (snap) => {
    const data = snap.val();

    // Ignore updates for other orders this driver might be running
    if (data && data.activeOrderId && data.activeOrderId !== orderId) {
      setStatus('waiting', 'Waiting for driver…');
      return;
    }

    if (!data || data.lat == null || data.lng == null) {
      setStatus('waiting', 'Locating driver…');
      return;
    }

    const stale = data.updatedAt && Date.now() - data.updatedAt > 30000;
    const pos = { lat: data.lat, lng: data.lng };
    lastDriverPos = pos;

    if (!driverMarker) {
      driverMarker = L.marker([pos.lat, pos.lng], {
        icon: driverIconSmall(L),
        interactive: false,
        zIndexOffset: 1000,
      }).addTo(map);

      // Permanent label — driver's first name if we got it, else "Driver"
      driverMarker.bindTooltip(driverName ? driverName : 'Driver', {
        permanent: true,
        direction: 'bottom',
        offset: [0, 12],
        className: 'glt-label glt-label--driver',
        opacity: 1,
      });
    } else {
      if (driverMarker._icon) driverMarker._icon.style.transition = 'transform 0.9s linear';
      driverMarker.setLatLng([pos.lat, pos.lng]);
    }

    if (!stale) {
      fetchRouteIfNeeded(pos);
    } else {
      setStatus('stale', 'Signal lost — reconnecting…');
    }

    if (!boundsFitted) {
      const b = L.latLngBounds([[pos.lat, pos.lng], [destination.lat, destination.lng]]);
      map.fitBounds(b, { padding: [40, 40], maxZoom: 15.5 });
      boundsFitted = true;
    }
  });

  async function fetchRouteIfNeeded(from) {
    const moved = lastRouteFrom ? haversineMeters(lastRouteFrom, from) : Infinity;
    const elapsed = Date.now() - lastRouteAt;
    if (moved < PREVIEW_RECALC_M && elapsed < PREVIEW_RECALC_MS) return;

    lastRouteFrom = { ...from };
    lastRouteAt = Date.now();

    const url =
      `${PREVIEW_OSRM}/${from.lng},${from.lat};${destination.lng},${destination.lat}` +
      `?overview=full&geometries=geojson&steps=false`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OSRM ${res.status}`);
      const data = await res.json();
      const route = data?.routes?.[0];
      if (!route?.geometry?.coordinates) throw new Error('no route');

      const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      drawRoute(latlngs);
      setStatus('live', `Driver is ${formatDist(route.distance)} away · ~${formatDur(route.duration)}`);
    } catch (err) {
      console.warn('preview route fetch failed:', err);
      drawRoute([[from.lat, from.lng], [destination.lat, destination.lng]], true);
      setStatus('live', 'Driver is on the way');
    }
  }

  function drawRoute(latlngs, fallback = false) {
    const w = fallback ? 3 : 5;
    const caseW = w + 3;
    const shadowW = w + 5;

    if (routeCore) {
      routeCore.setLatLngs(latlngs);
      routeCasing.setLatLngs(latlngs);
      routeShadow.setLatLngs(latlngs);
      if (fallback) {
        routeCore.setStyle({ dashArray: '6 8', weight: w });
        routeCasing.setStyle({ dashArray: '6 8', weight: caseW });
        routeShadow.setStyle({ dashArray: '6 8', weight: shadowW });
      }
      return;
    }

    const dash = fallback ? '6 8' : null;

    routeShadow = L.polyline(latlngs, {
      color: '#000', weight: shadowW, opacity: 0.16,
      lineCap: 'round', lineJoin: 'round', interactive: false,
      dashArray: dash,
    }).addTo(map);

    routeCasing = L.polyline(latlngs, {
      color: '#fff', weight: caseW, opacity: 0.95,
      lineCap: 'round', lineJoin: 'round', interactive: false,
      dashArray: dash,
    }).addTo(map);

    routeCore = L.polyline(latlngs, {
      color: '#1a73e8', weight: w, opacity: 1,
      lineCap: 'round', lineJoin: 'round', interactive: false,
      dashArray: dash,
    }).addTo(map);
  }

  function setStatus(kind, text) {
    statusText.textContent = text;
    statusDot.classList.remove('live', 'stale', 'waiting');
    statusDot.classList.add(kind);
  }

  const observer = new IntersectionObserver(
    ([entry]) => {
      const show = entry.isIntersecting && entry.intersectionRatio >= 0.6;
      expandBtn.classList.toggle('opacity-0', !show);
      expandBtn.classList.toggle('pointer-events-none', !show);
      expandBtn.classList.toggle('translate-y-2', !show);
      expandBtn.classList.toggle('glt-glow-btn', show);
    },
    { threshold: [0.6] }
  );
  observer.observe(wrap);

  expandBtn.addEventListener('click', () => {
    const origin = lastDriverPos || destination;
    const url =
      `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}` +
      `&destination=${destination.lat},${destination.lng}&travelmode=driving`;
    window.open(url, '_blank', 'noopener');
  });

  return {
    destroy: () => {
      try { unsubscribe(); } catch {}
      try { observer.disconnect(); } catch {}
      try { map.remove(); } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------
function formatDist(m) {
  if (m == null) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function formatDur(s) {
  if (s == null) return '—';
  const mins = Math.round(s / 60);
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const r = mins % 60;
  return `${h}h ${r}m`;
}