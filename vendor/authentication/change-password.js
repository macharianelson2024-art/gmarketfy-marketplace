import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, confirmPasswordReset } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore, doc, updateDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";


// ==========================
// FIREBASE INIT
// ==========================
const firebaseConfig = {
  apiKey: "AIzaSyAUErMIjiQgnprmqYd6wiscOa8CIAAELi8",
  authDomain: "marketfy-82c42.firebaseapp.com",
  projectId: "marketfy-82c42",
  storageBucket: "marketfy-82c42.firebasestorage.app",
  messagingSenderId: "321190245217",
  appId: "1:321190245217:web:b9eb39db0a9a2056a30b20",
  measurementId: "G-07W1D4H9JB"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);


// ==========================
// GET RESET CODE FROM URL
// ==========================
const params = new URLSearchParams(window.location.search);
const oobCode = params.get("oobCode");


// ==========================
// UI ELEMENTS
// ==========================
const newPassword = document.getElementById("newPassword");
const confirmPassword = document.getElementById("confirmPassword");
const saveBtn = document.getElementById("saveBtn");
const status = document.getElementById("status");


// ==========================
// RESET PASSWORD LOGIC
// ==========================
saveBtn.addEventListener("click", async () => {

  const pass1 = newPassword.value.trim();
  const pass2 = confirmPassword.value.trim();

  // validation
  if (!pass1 || !pass2) {
    status.textContent = "⚠️ Please fill all fields";
    return;
  }

  if (pass1 !== pass2) {
    status.textContent = "❌ Passwords do not match";
    return;
  }

  if (pass1.length < 6) {
    status.textContent = "⚠️ Password must be at least 6 characters";
    return;
  }

  if (!oobCode) {
    status.textContent = "❌ Invalid or expired reset link";
    return;
  }

  try {
    saveBtn.disabled = true;
    status.textContent = "Updating password...";

    // 🔥 Firebase reset password flow
    await confirmPasswordReset(auth, oobCode, pass1);

    
    status.textContent = "✅ Password updated successfully";

    // redirect
    setTimeout(() => {
      window.location.href = "/vendor/authentication/authentication.html";
    }, 1200);

  } catch (err) {
    console.error(err);
    status.textContent = "❌ " + (err.message || "Something went wrong");
  } finally {
    saveBtn.disabled = false;
  }
});


// ==========================
// BRAND MESSAGE LISTENER
// ==========================
document.addEventListener("DOMContentLoaded", () => {

  const brandMessageEl = document.getElementById("brand-message");

  if (!brandMessageEl) return;

  const brandRef = doc(db, "gressor", "gressor-report");

  onSnapshot(brandRef, (docSnap) => {
    if (docSnap.exists()) {
      brandMessageEl.textContent = "— " + docSnap.data().message;
    }
  });

});