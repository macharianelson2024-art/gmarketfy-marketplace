// ============================================
// DRIVER DASHBOARD — PROFILE TAB (driver-profile.js)
// ============================================
// Assumptions (adjust if they don't match your driver doc / vendor-drivers.js):
//   - driver doc field for photo is `image` (base64 string, same convention as proofImage)
//   - driver doc field for vehicle is `vehicleType`, one of:
//     'motorbike' | 'bicycle' | 'car' | 'van' | 'foot'
//   - firebase-config.js re-exports: EmailAuthProvider, reauthenticateWithCredential, updatePassword
//     (needed for "change PIN" — same pattern as the writeBatch/increment note in driver-dashboard.js)
// Status (free/off-duty) is intentionally NOT editable here — per your setup, only the
// vendor can toggle that; the driver dashboard just displays it.

import {
  updateDoc,
  doc,
  serverTimestamp,
  EmailAuthProvider,       // ⬅ must be exported from firebase-config.js
  reauthenticateWithCredential, // ⬅ must be exported from firebase-config.js
  updatePassword            // ⬅ must be exported from firebase-config.js
} from "./firebase-config.js";

const $ = (id) => document.getElementById(id);

const VEHICLE_OPTIONS = [
  { value: 'motorbike', label: 'Motorbike', icon: 'fa-motorcycle' },
  { value: 'bicycle', label: 'Bicycle', icon: 'fa-bicycle' },
  { value: 'car', label: 'Car', icon: 'fa-car' },
  { value: 'van', label: 'Van', icon: 'fa-truck' },
  { value: 'foot', label: 'On Foot', icon: 'fa-person-walking' }
];

const DRIVER_STATUS_LABELS = {
  free: { label: 'Available', color: 'text-emerald-400', dot: 'free' },
  'on-road': { label: 'On Road', color: 'text-orange-400', dot: 'on-road' },
  'off-duty': { label: 'Off Duty', color: 'text-slate-400', dot: 'off-duty' },
  'not-active': { label: 'Not Active', color: 'text-slate-500', dot: 'off-duty' }
};

let profileInitialized = false;
let pendingPhotoData = null; // holds compressed base64 while unsaved
let selectedVehicle = null;

function vehicleChipClass(isSelected) {
  return `vehicle-chip flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-medium transition border ${
    isSelected
      ? 'bg-indigo-500 border-indigo-400 text-white shadow-md shadow-indigo-500/20 selected'
      : 'bg-white/[0.03] border-white/10 text-white/50 hover:bg-white/[0.06] hover:text-white/70'
  }`;
}

function haptic(ms = 10) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

function escHTML(str) {
  if (window.escHTML) return window.escHTML(str);
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function safeImgSrc(src) {
  if (!src) return '';
  if (/^https?:\/\//i.test(src) || /^data:image\//i.test(src)) return src;
  return '';
}

function fmtJoinDate(driver) {
  const raw = driver?.createdAt?.toDate?.() || driver?.createdAt;
  if (!raw) return '—';
  return new Date(raw).toLocaleDateString('en-KE', { month: 'long', year: 'numeric' });
}

// ============================
// RENDER
// ============================
function renderProfile() {
  const driver = window.driverData;
  if (!driver) return;

  const root = $('profile-container');
  if (!root) return;

  selectedVehicle = driver.vehicleType || null;
  pendingPhotoData = null;

  const statusInfo = DRIVER_STATUS_LABELS[driver.status] || DRIVER_STATUS_LABELS['off-duty'];
  const photoSrc = safeImgSrc(driver.image || '');

  root.innerHTML = `
    <!-- Header card -->
      <div class="glass rounded-3xl p-6 flex flex-col items-center text-center">
        <div class="relative">
          <div id="profile-photo-wrap" class="w-24 h-24 rounded-full overflow-hidden bg-white/[0.04] border border-white/10 flex items-center justify-center cursor-pointer">
            ${photoSrc
              ? `<img id="profile-photo-img" src="${photoSrc}" class="w-full h-full object-cover" alt="Profile photo" />`
              : `<span class="text-3xl opacity-30">👤</span>`}
          </div>
          <button id="profile-photo-edit-btn" class="absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center text-sm border-2 border-[#0f1115]" aria-label="Change photo">
            📸
          </button>
          <input id="profile-photo-input" type="file" accept="image/*" capture="environment" class="hidden" />
        </div>

        <h2 class="text-lg font-bold text-white mt-4">${escHTML(driver.name || 'Driver')}</h2>
        <p class="text-sm text-white/40 mt-0.5">${escHTML(driver.phone || '')}</p>

        <div class="flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-full glass">
          <span class="driver-status-dot ${statusInfo.dot}"></span>
          <span class="text-xs font-medium ${statusInfo.color}">${statusInfo.label}</span>
        </div>
      </div>

      <!-- Stats -->
      <div class="grid grid-cols-2 gap-3">
        <div class="glass rounded-2xl p-4 text-center">
          <p class="text-2xl font-black text-white">${driver.totalDeliveries || 0}</p>
          <p class="text-[10px] text-white/30 uppercase tracking-wider mt-1">Total Deliveries</p>
        </div>
        <div class="glass rounded-2xl p-4 text-center">
          <p class="text-sm font-bold text-white">${fmtJoinDate(driver)}</p>
          <p class="text-[10px] text-white/30 uppercase tracking-wider mt-1">Driving Since</p>
        </div>
      </div>

      <!-- Vehicle -->
      <div class="glass rounded-2xl p-4">
        <h3 class="text-[10px] font-bold text-white/30 uppercase tracking-wider mb-3">🚚 Vehicle</h3>
        <div id="vehicle-chip-row" class="flex flex-wrap gap-2">
          ${VEHICLE_OPTIONS.map(v => `
            <button type="button" class="${vehicleChipClass(v.value === selectedVehicle)}" data-vehicle="${v.value}">
              <i class="fas ${v.icon}"></i> ${v.label}
            </button>
          `).join('')}
        </div>
        <button id="vehicle-save-btn" class="action-btn primary mt-4 hidden">Save Vehicle</button>
      </div>

      <!-- Security -->
      <div class="glass rounded-2xl p-4">
        <h3 class="text-[10px] font-bold text-white/30 uppercase tracking-wider mb-3">🔐 Security</h3>
        <button id="change-pin-open-btn" class="w-full flex items-center justify-between text-sm text-white/70 py-2">
          <span>Change PIN</span>
          <i class="fas fa-chevron-right text-xs text-white/20"></i>
        </button>
      </div>

      <!-- Logout -->
      <button id="profile-logout-btn" class="w-full text-center text-sm text-red-400/80 py-3">
        🚪 Log Out
      </button>
  `;

  bindProfileEvents();
}
window.renderProfile = renderProfile;

// ============================
// EVENTS
// ============================
function bindProfileEvents() {
  // Photo
  const photoWrap = $('profile-photo-wrap');
  const photoEditBtn = $('profile-photo-edit-btn');
  const photoInput = $('profile-photo-input');

  const triggerPhotoPick = () => photoInput?.click();
  photoWrap?.addEventListener('click', triggerPhotoPick);
  photoEditBtn?.addEventListener('click', (e) => { e.stopPropagation(); triggerPhotoPick(); });

  photoInput?.addEventListener('change', (e) => handlePhotoSelect(e.target.files?.[0]));

  // Vehicle chips
  document.querySelectorAll('.vehicle-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      haptic(8);
      selectedVehicle = chip.dataset.vehicle;
      document.querySelectorAll('.vehicle-chip').forEach(c => {
        c.className = vehicleChipClass(c.dataset.vehicle === selectedVehicle);
      });
      const saveBtn = $('vehicle-save-btn');
      const driver = window.driverData;
      saveBtn.classList.toggle('hidden', selectedVehicle === (driver?.vehicleType || null));
    });
  });

  $('vehicle-save-btn')?.addEventListener('click', saveVehicle);

  // Security
  $('change-pin-open-btn')?.addEventListener('click', openChangePinModal);

  // Logout
  $('profile-logout-btn')?.addEventListener('click', openLogoutConfirm);
}

// ============================
// PHOTO SAVE
// ============================
async function handlePhotoSelect(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    window.showToast?.({ type: 'error', title: 'Invalid File', message: 'Please select an image file' });
    return;
  }

  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const compressed = window.compressImage
        ? await window.compressImage(ev.target.result, 400, 0.75)
        : ev.target.result;

      pendingPhotoData = compressed;

      const img = $('profile-photo-img');
      const wrap = $('profile-photo-wrap');
      if (img) {
        img.src = compressed;
      } else if (wrap) {
        wrap.innerHTML = `<img id="profile-photo-img" src="${compressed}" class="w-full h-full object-cover" alt="Profile photo" />`;
      }

      await savePhoto();
    } catch (err) {
      console.error('Photo processing failed:', err);
      window.showToast?.({ type: 'error', title: 'Photo Failed', message: 'Could not process that image' });
    }
  };
  reader.onerror = () => window.showToast?.({ type: 'error', title: 'Read Failed', message: 'Could not read the image file' });
  reader.readAsDataURL(file);
}

async function savePhoto() {
  const driver = window.driverData;
  if (!driver || !pendingPhotoData) return;

  try {
    await updateDoc(doc(window.db, 'drivers', driver.id), {
      image: pendingPhotoData,
      updatedAt: serverTimestamp()
    });
    window.driverData = { ...driver, image: pendingPhotoData };
    pendingPhotoData = null;
    window.showToast?.({ type: 'success', title: 'Photo Updated', message: 'Your profile photo was saved' });
    haptic(15);
  } catch (err) {
    console.error('Photo save failed:', err);
    window.showToast?.({ type: 'error', title: 'Save Failed', message: err.message || 'Could not save photo' });
  }
}

// ============================
// VEHICLE SAVE
// ============================
async function saveVehicle() {
  const driver = window.driverData;
  if (!driver || !selectedVehicle) return;

  const btn = $('vehicle-save-btn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    await updateDoc(doc(window.db, 'drivers', driver.id), {
      vehicleType: selectedVehicle,
      updatedAt: serverTimestamp()
    });
    window.driverData = { ...driver, vehicleType: selectedVehicle };
    btn.classList.add('hidden');
    window.showToast?.({ type: 'success', title: 'Vehicle Updated', message: 'Your vehicle type was saved' });
    haptic(15);
  } catch (err) {
    console.error('Vehicle save failed:', err);
    selectedVehicle = driver.vehicleType || null;
    document.querySelectorAll('.vehicle-chip').forEach(c => {
      c.className = vehicleChipClass(c.dataset.vehicle === selectedVehicle);
    });
    window.showToast?.({ type: 'error', title: 'Save Failed', message: err.message || 'Could not save vehicle' });
    btn.classList.add('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ============================
// CHANGE PIN MODAL (built on the fly — no HTML dependency)
// ============================
function openChangePinModal() {
  const overlay = document.createElement('div');
  overlay.className = 'proof-fullview open';
  overlay.innerHTML = `
    <div class="proof-fullview-inner glass rounded-3xl p-6 max-w-sm w-full" style="height:auto;">
      <h3 class="text-base font-bold text-white mb-4">🔐 Change PIN</h3>
      <div class="space-y-3">
        <input id="pin-current" type="password" inputmode="numeric" maxlength="6" placeholder="Current PIN" class="w-full bg-white/[0.04] border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-white/30" />
        <input id="pin-new" type="password" inputmode="numeric" maxlength="6" placeholder="New PIN (6 digits)" class="w-full bg-white/[0.04] border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-white/30" />
        <input id="pin-confirm" type="password" inputmode="numeric" maxlength="6" placeholder="Confirm New PIN" class="w-full bg-white/[0.04] border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-white/30" />
      </div>
      <p id="pin-error" class="text-xs text-red-400 mt-2 hidden"></p>
      <div class="flex gap-2 mt-5">
        <button id="pin-cancel-btn" class="action-btn secondary flex-1">Cancel</button>
        <button id="pin-submit-btn" class="action-btn primary flex-1">Update PIN</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  const close = () => {
    overlay.remove();
    document.body.style.overflow = '';
  };

  $('pin-cancel-btn') // note: querying by id after append works since ids are unique in DOM at this point
    ?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  overlay.querySelector('#pin-submit-btn').addEventListener('click', async () => {
    const current = overlay.querySelector('#pin-current').value.trim();
    const next = overlay.querySelector('#pin-new').value.trim();
    const confirm = overlay.querySelector('#pin-confirm').value.trim();
    const errorEl = overlay.querySelector('#pin-error');
    const showError = (msg) => { errorEl.textContent = msg; errorEl.classList.remove('hidden'); };

    if (!current || !next || !confirm) return showError('Fill in all fields');
    if (!/^\d{6}$/.test(next)) return showError('New PIN must be 6 digits');
    if (next !== confirm) return showError('New PIN and confirmation do not match');

    const btn = overlay.querySelector('#pin-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Updating...';

    try {
      const user = window.auth.currentUser;
      const credential = EmailAuthProvider.credential(user.email, current);
      await reauthenticateWithCredential(user, credential);
      await updatePassword(user, next);

      window.showToast?.({ type: 'success', title: 'PIN Updated', message: 'Use your new PIN next time you log in' });
      close();
    } catch (err) {
      console.error('PIN update failed:', err);
      const msg = err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password'
        ? 'Current PIN is incorrect'
        : (err.message || 'Could not update PIN');
      showError(msg);
      btn.disabled = false;
      btn.textContent = 'Update PIN';
    }
  });
}

// ============================
// LOGOUT CONFIRM (built on the fly)
// ============================
function openLogoutConfirm() {
  const overlay = document.createElement('div');
  overlay.className = 'proof-fullview open';
  overlay.innerHTML = `
    <div class="proof-fullview-inner glass rounded-3xl p-6 max-w-sm w-full text-center" style="height:auto;">
      <p class="text-3xl mb-2">🚪</p>
      <h3 class="text-base font-bold text-white mb-1">Log out?</h3>
      <p class="text-sm text-white/40 mb-5">You'll need your phone number and PIN to log back in.</p>
      <div class="flex gap-2">
        <button id="logout-cancel-btn" class="action-btn secondary flex-1">Cancel</button>
        <button id="logout-confirm-btn" class="action-btn danger flex-1">Log Out</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  const close = () => {
    overlay.remove();
    document.body.style.overflow = '';
  };

  overlay.querySelector('#logout-cancel-btn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#logout-confirm-btn').addEventListener('click', () => {
    close();
    // Reuses the same logout flow already wired in driver-dashboard.js
    $('logout-btn')?.click();
  });
}

// ============================
// INIT — hook into the existing nav, no core file edits needed
// ============================
function initProfileTab() {
  if (profileInitialized) return;
  profileInitialized = true;

  const profileNavItem = document.querySelector('.nav-item[data-tab="profile"]');
  profileNavItem?.addEventListener('click', () => {
    // driverData is set by the time nav is interactive (checkAuth runs first in initDashboard)
    renderProfile();
  });
}

document.addEventListener('DOMContentLoaded', initProfileTab);
