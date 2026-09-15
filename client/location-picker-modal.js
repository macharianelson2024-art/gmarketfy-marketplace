/**
 * location-picker-modal.js
 * A 90vw x 90vh rounded overlay that hosts the location picker instead of
 * a form. Client taps "Add address" (or similar) -> this opens -> they drag
 * the pin or tap "Use my current location" -> tap Confirm -> you get
 * {lat, lng} back.
 *
 * Usage:
 *   import { openLocationPickerModal } from './location-picker-modal.js';
 *
 *   addAddressBtn.addEventListener('click', async () => {
 *     const coords = await openLocationPickerModal({ savedLat, savedLng });
 *     if (!coords) return; // they cancelled
 *     addressDraft.lat = coords.lat;
 *     addressDraft.lng = coords.lng;
 *     // ...continue your existing save-address flow
 *   });
 */

import { initLocationPicker } from './client-location-picker.js';

let overlayEl = null;

function ensureOverlay() {
  if (overlayEl) return overlayEl;

  overlayEl = document.createElement('div');
  overlayEl.id = 'lp-overlay';
  overlayEl.className = `fixed inset-0 z-[999] flex items-center justify-center
    bg-black/70 backdrop-blur-sm opacity-0 pointer-events-none transition-opacity duration-300`;

  overlayEl.innerHTML = `
    <div class="lp-modal relative w-[90vw] h-[90vh] max-w-3xl rounded-3xl border border-white/10
      bg-[#0f1115] overflow-hidden flex flex-col scale-95 transition-transform duration-300 ease-out">

      <div class="flex items-center justify-between px-5 py-4 border-b border-white/5 shrink-0">
        <div>
          <h3 class="text-white text-sm font-semibold">Pin your delivery location</h3>
          <p class="text-white/50 text-xs mt-0.5">Drag the pin, or use your current location</p>
        </div>
        <button type="button" class="lp-close w-8 h-8 flex items-center justify-center rounded-full
          bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors duration-200">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"></path>
          </svg>
        </button>
      </div>

      <div class="lp-map-slot flex-1 min-h-0"></div>

      <div class="px-5 py-4 border-t border-white/5 shrink-0 flex gap-3">
        <button type="button" class="lp-cancel flex-1 rounded-xl border border-white/10 bg-white/5
          text-white/70 text-sm font-medium py-3 hover:bg-white/10 transition-colors duration-200">
          Cancel
        </button>
        <button type="button" class="lp-confirm flex-[2] rounded-xl bg-gradient-to-r from-indigo-500
          to-violet-500 text-white text-sm font-semibold py-3 hover:brightness-110
          active:scale-[0.98] transition-all duration-200">
          Confirm this location
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlayEl);
  return overlayEl;
}

function show(overlay) {
  const modal = overlay.querySelector('.lp-modal');
  overlay.classList.remove('opacity-0', 'pointer-events-none');
  requestAnimationFrame(() => modal.classList.remove('scale-95'));
}

function hide(overlay) {
  const modal = overlay.querySelector('.lp-modal');
  modal.classList.add('scale-95');
  overlay.classList.add('opacity-0', 'pointer-events-none');
}

/**
 * @param {Object} [opts]
 * @param {number} [opts.savedLat] - pre-fill if the client is editing an existing pin
 * @param {number} [opts.savedLng]
 * @returns {Promise<{lat:number,lng:number}|null>} resolves with the picked
 *   coords on confirm, or null if the client cancels/closes the modal
 */
export function openLocationPickerModal({ savedLat, savedLng } = {}) {
  return new Promise(async (resolve) => {
    const overlay = ensureOverlay();
    const slot = overlay.querySelector('.lp-map-slot');
    const closeBtn = overlay.querySelector('.lp-close');
    const cancelBtn = overlay.querySelector('.lp-cancel');
    const confirmBtn = overlay.querySelector('.lp-confirm');

    show(overlay);

    // wait one frame so the modal has its real on-screen size before Leaflet
    // measures the container — otherwise the map can init at 0 height
    await new Promise((r) => requestAnimationFrame(r));

    const picker = await initLocationPicker(slot, {
      savedLat,
      savedLng,
      height: '100%',
    });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      hide(overlay);
      picker.destroy();
      closeBtn.removeEventListener('click', onCancel);
      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
      resolve(result);
    };

    const onCancel = () => finish(null);
    const onConfirm = () => {
      const { lat, lng } = picker.getLocation();
      finish({ lat, lng });
    };

    closeBtn.addEventListener('click', onCancel);
    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
  });
}
