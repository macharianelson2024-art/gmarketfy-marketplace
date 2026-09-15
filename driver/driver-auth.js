// ============================================
// DRIVER DASHBOARD — AUTH / LOGIN
// ============================================
// Drivers never self-register — vendors create their account (see
// vendor-drivers.js: createDriverAuthAccount). This page only handles:
//   1. Logging in with phone + PIN
//   2. Detecting first-login (driverLoginActivated === false) and
//      forcing a PIN reset before entering the dashboard

import { db, firebaseConfig } from './firebase-config.js';
import { doc, getDoc, updateDoc, serverTimestamp } from './firebase-config.js';
import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  updatePassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// =========================
// HELPERS — must mirror vendor-drivers.js exactly
// =========================
function normalizePhone(phone) {
  return phone.replace(/[^\d]/g, "");
}

function driverEmailFromPhone(phone) {
  return `${normalizePhone(phone)}@drivers.gmarketfy.app`;
}

function isValidPin(pin) {
  return /^\d{6}$/.test(pin);
}

// =========================
// STEP SWITCHING
// =========================
const steps = ["checking", "login", "reset", "success"];
function showStep(name) {
  steps.forEach(s => {
    document.getElementById(`step-${s}`)?.classList.toggle("hidden", s !== name);
  });
}

function shakeCard() {
  const card = document.getElementById("auth-card");
  card.classList.remove("shake");
  void card.offsetWidth; // restart animation
  card.classList.add("shake");
}

function setError(elId, message) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!message) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.textContent = message;
  el.classList.remove("hidden");
  shakeCard();
}

function setBusy(prefix, busy, busyLabel) {
  const btn = document.getElementById(`${prefix}-submit-btn`);
  const text = document.getElementById(`${prefix}-submit-text`);
  const spinner = document.getElementById(`${prefix}-spinner`);
  if (!btn) return;
  btn.disabled = busy;
  if (busy) {
    text.dataset.original = text.dataset.original || text.textContent;
    text.textContent = busyLabel;
    spinner.classList.remove("hidden");
  } else {
    text.textContent = text.dataset.original || text.textContent;
    spinner.classList.add("hidden");
  }
}

// =========================
// DRIVER DOC LOOKUP
// =========================
async function fetchDriverDoc(uid) {
  const snap = await getDoc(doc(db, "drivers", uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

function goToDashboard() {
  showStep("success");
  setTimeout(() => { window.location.href = "./driver-dashboard.html"; }, 600);
}

// =========================
// SESSION CHECK ON LOAD
// =========================
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    showStep("login");
    return;
  }

  const driver = await fetchDriverDoc(user.uid);

  if (!driver) {
    // Auth account exists but no matching driver doc — not a valid driver session
    await signOut(auth);
    showStep("login");
    return;
  }

  if (driver.driverLoginActivated === false) {
    // Already authenticated but still on their temp PIN
    showStep("reset");
  } else {
    goToDashboard();
  }
});

// =========================
// LOGIN FORM
// =========================
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("login-error", null);

  const phone = document.getElementById("login-phone").value.trim();
  const pin = document.getElementById("login-pin").value.trim();

  if (!phone) { setError("login-error", "Enter your phone number."); return; }
  if (!isValidPin(pin)) { setError("login-error", "PIN must be 6 digits."); return; }

  setBusy("login", true, "Logging in…");

  try {
    const email = driverEmailFromPhone(phone);
    const cred = await signInWithEmailAndPassword(auth, email, pin);
    const driver = await fetchDriverDoc(cred.user.uid);

    if (!driver) {
      await signOut(auth);
      setError("login-error", "No driver account found for this number. Contact your vendor.");
      return;
    }

    if (driver.driverLoginActivated === false) {
      showStep("reset");
    } else {
      goToDashboard();
    }
  } catch (err) {
    console.error("Driver login failed:", err);
    if (err.code === "auth/invalid-credential" || err.code === "auth/wrong-password" || err.code === "auth/user-not-found") {
      setError("login-error", "Phone number or PIN is incorrect.");
    } else if (err.code === "auth/too-many-requests") {
      setError("login-error", "Too many attempts. Please wait a moment and try again.");
    } else {
      setError("login-error", "Couldn't log in. Please try again.");
    }
  } finally {
    setBusy("login", false);
  }
});

// =========================
// PIN RESET FORM (first login)
// =========================
document.getElementById("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("reset-error", null);

  const newPin = document.getElementById("reset-pin").value.trim();
  const confirmPin = document.getElementById("reset-pin-confirm").value.trim();

  if (!isValidPin(newPin)) { setError("reset-error", "PIN must be 6 digits."); return; }
  if (newPin !== confirmPin) { setError("reset-error", "PINs don't match."); return; }

  const user = auth.currentUser;
  if (!user) { showStep("login"); return; }

  setBusy("reset", true, "Saving…");

  try {
    await updatePassword(user, newPin);
    await updateDoc(doc(db, "drivers", user.uid), {
      driverLoginActivated: true,
      status: "free",
      updatedAt: serverTimestamp()
    });
    goToDashboard();
  } catch (err) {
    console.error("PIN reset failed:", err);
    if (err.code === "auth/requires-recent-login") {
      setError("reset-error", "Session expired — please log in again.");
      await signOut(auth);
      setTimeout(() => showStep("login"), 1200);
    } else {
      setError("reset-error", "Couldn't set your new PIN. Please try again.");
    }
  } finally {
    setBusy("reset", false);
  }
});

// Auto-uppercase not needed for phone/PIN; keep PIN fields numeric-only
["login-pin", "reset-pin", "reset-pin-confirm"].forEach(id => {
  document.getElementById(id)?.addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/[^\d]/g, "").slice(0, 6);
  });
});
