/**
 * live-tracking.js
 * Driver-side location broadcasting (writes to Realtime Database) + client-
 * side live preview map with a scroll-triggered "open in Google Maps" handoff.
 *
 * Realtime Database structure:
 *   /driverLocations/{driverId}
 *       lat: number
 *       lng: number
 *       heading: number | null
 *       speed: number | null
 *       updatedAt: RTDB server timestamp
 *       activeOrderId: string | null
 *
 * One node per driver (not per-order) — a driver only has one physical
 * location at a time. activeOrderId lets the client's tracking screen
 * confirm it's watching the right delivery, and gets cleared via
 * onDisconnect() if the driver's connection drops mid-delivery.
 *
 * Usage (driver dashboard, on dispatch):
 *   import { startDriverLocationSharing, stopDriverLocationSharing } from './live-tracking.js';
 *   startDriverLocationSharing(driverId, orderId);
 *   // ...later, on proof-of-delivery / order completion:
 *   stopDriverLocationSharing(driverId);
 *
 * Usage (client dashboard, pending-order tracking screen):
 *   import { initLiveTrackingPreview } from './live-tracking.js';
 *   const tracker = await initLiveTrackingPreview(document.getElementById('track-slot'), {
 *     driverId: order.driverId,
 *     clientLat: order.delivery.address.lat,
 *     clientLng: order.delivery.address.lng,
 *   });
 *   // on unmount:
 *   tracker.destroy();
 */

import {
  getDatabase, ref, update, onValue, onDisconnect, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

const WRITE_INTERVAL_MS = 5000;   // baseline cadence
const MIN_MOVE_METERS = 10;       // ...but skip the write if the driver hasn't moved this far
const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';

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
    script.onload = () => resolve(window.L);
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
  const db = getDatabase();
  const locRef = ref(db, `driverLocations/${driverId}`);

  // if the driver's connection drops mid-delivery, stop presenting them as
  // actively tracked rather than leaving a stale pin on the client's map
  onDisconnect(locRef).update({ activeOrderId: null });

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const now = Date.now();
      const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
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
  const db = getDatabase();
  update(ref(db, `driverLocations/${driverId}`), { activeOrderId: null });
}

// ---------------------------------------------------------------------------
// Client side — preview map on the pending-order tracking screen
// ---------------------------------------------------------------------------

function injectGlowStyles() {
  if (document.getElementById('glt-styles')) return;
  const style = document.createElement('style');
  style.id = 'glt-styles';
  style.textContent = `
    @keyframes glt-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(99,102,241,0.45), 0 4px 14px rgba(99,102,241,0.25); }
      50% { box-shadow: 0 0 0 10px rgba(99,102,241,0), 0 4px 14px rgba(99,102,241,0.35); }
    }
    .glt-glow-btn { animation: glt-pulse 1.8s ease-in-out infinite; }
  `;
  document.head.appendChild(style);
}

function buildShell(container) {
  container.innerHTML = `
    <div class="glt-wrap relative rounded-2xl overflow-hidden border border-white/10 bg-[#14161c]">
      <div class="glt-map" style="height:220px;"></div>
      <div class="glt-status absolute top-3 left-3 flex items-center gap-1.5 rounded-lg bg-[#0f1115]/80
        backdrop-blur border border-white/10 px-2.5 py-1 text-[11px] text-white/70">
        <span class="glt-dot w-1.5 h-1.5 rounded-full bg-white/30"></span>
        <span class="glt-status-text">Locating driver…</span>
      </div>
      <button type="button" class="glt-expand absolute left-1/2 -translate-x-1/2 bottom-4
        opacity-0 pointer-events-none translate-y-2 transition-all duration-300
        flex items-center gap-2 rounded-full bg-gradient-to-r from-indigo-500 to-violet-500
        px-4 py-2 text-xs font-semibold text-white">
        View full route in Google Maps
      </button>
    </div>
  `;
  return {
    mapEl: container.querySelector('.glt-map'),
    statusText: container.querySelector('.glt-status-text'),
    statusDot: container.querySelector('.glt-dot'),
    expandBtn: container.querySelector('.glt-expand'),
    wrap: container.querySelector('.glt-wrap'),
  };
}

function driverIcon(L) {
  return L.divIcon({
    className: '',
    html: `<div style="width:18px;height:18px;border-radius:50%;
      background:radial-gradient(circle at 35% 30%, #a78bfa, #6366f1);
      box-shadow:0 0 0 5px rgba(99,102,241,0.22), 0 2px 8px rgba(0,0,0,0.45);"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function clientIcon(L) {
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:50%;
      background:#f4f4f5;box-shadow:0 0 0 4px rgba(244,244,245,0.18), 0 2px 6px rgba(0,0,0,0.4);"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

/**
 * @param {HTMLElement} container
 * @param {Object} opts
 * @param {string} opts.driverId
 * @param {number} opts.clientLat
 * @param {number} opts.clientLng
 * @returns {Promise<{ destroy: () => void }>}
 */
export async function initLiveTrackingPreview(container, { driverId, clientLat, clientLng }) {
  const L = await loadLeaflet();
  injectGlowStyles();
  const db = getDatabase();
  const { mapEl, statusText, statusDot, expandBtn, wrap } = buildShell(container);

  const map = L.map(mapEl, {
    zoomControl: false,
    attributionControl: false,
    maxZoom: 16,   // preview only, capped on purpose — full nav happens in Google Maps
    minZoom: 11,
    dragging: true,
    scrollWheelZoom: false,   // this is a card in a scrolling page, not a full map
  }).setView([clientLat, clientLng], 14);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 17 }).addTo(map);

  const clientMarker = L.marker([clientLat, clientLng], { icon: clientIcon(L) }).addTo(map);
  let driverMarker = null;
  let lastDriverPos = null;

  const locRef = ref(db, `driverLocations/${driverId}`);
  const unsubscribe = onValue(locRef, (snap) => {
    const data = snap.val();
    if (!data || data.lat == null || data.lng == null) {
      statusText.textContent = 'Waiting for driver location…';
      statusDot.classList.remove('bg-emerald-400', 'bg-amber-400');
      statusDot.classList.add('bg-white/30');
      return;
    }

    const stale = data.updatedAt && Date.now() - data.updatedAt > 30000;
    statusText.textContent = stale ? 'Signal lost — reconnecting…' : 'Driver is on the way';
    statusDot.classList.remove('bg-white/30', 'bg-emerald-400', 'bg-amber-400');
    statusDot.classList.add(stale ? 'bg-amber-400' : 'bg-emerald-400');

    const pos = { lat: data.lat, lng: data.lng };
    if (!driverMarker) {
      driverMarker = L.marker([pos.lat, pos.lng], { icon: driverIcon(L) }).addTo(map);
      const bounds = L.latLngBounds([[pos.lat, pos.lng], [clientLat, clientLng]]);
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
    } else {
      // glide instead of jump — CSS transition on the marker's own element
      if (driverMarker._icon) driverMarker._icon.style.transition = 'transform 1s linear';
      driverMarker.setLatLng([pos.lat, pos.lng]);
    }
    lastDriverPos = pos;
  });

  // glowing CTA appears once this card has scrolled ~60% into view
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
    if (!lastDriverPos) return;
    const url = `https://www.google.com/maps/dir/?api=1&origin=${lastDriverPos.lat},${lastDriverPos.lng}&destination=${clientLat},${clientLng}&travelmode=driving`;
    window.open(url, '_blank', 'noopener');
  });

  return {
    destroy: () => {
      unsubscribe();
      observer.disconnect();
      map.remove();
    },
  };
}
