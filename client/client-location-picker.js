/**
 * client-location-picker.js
 * Inline OpenStreetMap (Leaflet) location picker for the order placement /
 * delivery address flow. Drop the returned lat/lng straight onto
 * delivery.address as { lat, lng } alongside the existing address fields.
 *
 * Usage:
 *   import { initLocationPicker } from './client-location-picker.js';
 *
 *   const picker = await initLocationPicker(document.getElementById('map-pin-slot'), {
 *     savedLat: address?.lat,
 *     savedLng: address?.lng,
 *     onLocationChange: (coords) => {
 *       addressDraft.lat = coords.lat;
 *       addressDraft.lng = coords.lng;
 *     }
 *   });
 *
 *   // on step-back / unmount:
 *   picker.destroy();
 */

const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
const NAIROBI_FALLBACK = { lat: -1.286389, lng: 36.817223 };

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

function buildShell(container, height) {
  container.innerHTML = `
    <div class="relative rounded-2xl overflow-hidden border border-white/10 bg-[#14161c] flex flex-col" style="height:${height};">
      <div class="glp-toolbar flex items-center justify-between gap-2 px-3 py-2.5 border-b border-white/5 shrink-0 bg-[#14161c]">
        <div class="glp-hint text-[11px] text-white/50 transition-colors duration-300">
          Drag the pin to fine-tune
        </div>
        <button type="button" class="glp-locate flex items-center gap-1.5 rounded-lg
          bg-white/5 border border-white/10 px-2.5 py-1.5 text-xs font-medium text-white/90
          hover:border-indigo-400/40 hover:bg-white/10 transition-all duration-200 active:scale-95 shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3"></path>
          </svg>
          Use my location
        </button>
      </div>
      <div class="glp-map flex-1 min-h-0"></div>
    </div>
  `;
  return {
    mapEl: container.querySelector('.glp-map'),
    locateBtn: container.querySelector('.glp-locate'),
    hint: container.querySelector('.glp-hint'),
  };
}

const LOW_ACCURACY_METERS = 500; // above this, treat the fix as "probably wrong, tell them"
const DEFAULT_HINT_TEXT = 'Drag the pin to fine-tune';

function pulseHint(hintEl, text) {
  hintEl.textContent = text;
  hintEl.classList.remove('text-white/50');
  hintEl.classList.add('text-indigo-300');
  setTimeout(() => {
    hintEl.classList.remove('text-indigo-300');
    hintEl.classList.add('text-white/50');
    hintEl.textContent = DEFAULT_HINT_TEXT;
  }, 900);
}

function warnLowAccuracy(hintEl, accuracyMeters) {
  const km = (accuracyMeters / 1000).toFixed(1);
  hintEl.textContent = `Approximate (~${km}km off) — drag the pin to fix it`;
  hintEl.classList.remove('text-white/50', 'text-indigo-300');
  hintEl.classList.add('text-amber-400');
  // stays up longer than the normal pulse — this one matters more, don't let
  // it flash past before they read it, and don't auto-revert to the generic
  // hint since the imprecise pin is still sitting there needing a fix
  setTimeout(() => {
    hintEl.classList.remove('text-amber-400');
    hintEl.classList.add('text-white/50');
  }, 5000);
}

/**
 * @param {HTMLElement} container - empty slot element to render the picker into
 * @param {Object} opts
 * @param {number} [opts.savedLat] - existing lat, if editing a saved address
 * @param {number} [opts.savedLng] - existing lng, if editing a saved address
 * @param {string} [opts.height] - CSS height for the WHOLE picker incl. toolbar ('220px' for an inline card, '100%' inside a modal)
 * @param {(coords: {lat:number,lng:number}) => void} opts.onLocationChange
 * @returns {Promise<{ getLocation: () => {lat:number,lng:number}, destroy: () => void }>}
 */
export async function initLocationPicker(container, { savedLat, savedLng, height = '220px', onLocationChange } = {}) {
  const L = await loadLeaflet();
  const { mapEl, locateBtn, hint } = buildShell(container, height);

  const start = (savedLat != null && savedLng != null)
    ? { lat: savedLat, lng: savedLng }
    : NAIROBI_FALLBACK;

  const map = L.map(mapEl, {
    zoomControl: false,
    attributionControl: false,
    maxZoom: 17,   // capped on purpose — this is a preview, full detail happens in Google Maps
    minZoom: 12,
  }).setView([start.lat, start.lng], 15);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
  }).addTo(map);

  const pinIcon = L.divIcon({
    className: '',
    html: `<div style="width:16px;height:16px;border-radius:50%;
      background:radial-gradient(circle at 35% 30%, #a78bfa, #6366f1);
      box-shadow:0 0 0 4px rgba(99,102,241,0.25), 0 2px 6px rgba(0,0,0,0.4);"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

  const marker = L.marker([start.lat, start.lng], { icon: pinIcon, draggable: true }).addTo(map);

  const emit = () => {
    const { lat, lng } = marker.getLatLng();
    onLocationChange?.({ lat, lng });
  };

  marker.on('dragend', () => {
    pulseHint(hint, 'Pinned');
    emit();
  });

  // seed the parent with the initial position immediately, so a client who
  // never touches the pin still submits a valid lat/lng
  emit();

  locateBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      pulseHint(hint, 'Geolocation not supported');
      return;
    }
    locateBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        console.log('geolocation accuracy (meters):', accuracy);
        map.setView([latitude, longitude], 16);
        marker.setLatLng([latitude, longitude]);
        if (accuracy > LOW_ACCURACY_METERS) {
          warnLowAccuracy(hint, accuracy);
        } else {
          pulseHint(hint, 'Located you');
        }
        emit();
        locateBtn.disabled = false;
      },
      (err) => {
        // err.code: 1 = permission denied, 2 = position unavailable, 3 = timeout
        console.error('geolocation failed:', err.code, err.message);
        const messages = {
          1: 'Location permission blocked',
          2: 'Location unavailable',
          3: 'Location request timed out',
        };
        pulseHint(hint, messages[err.code] || "Couldn't get your location");
        locateBtn.disabled = false;
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });

  return {
    getLocation: () => marker.getLatLng(),
    destroy: () => map.remove(),
  };
}
