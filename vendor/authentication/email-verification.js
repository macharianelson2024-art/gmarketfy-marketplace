
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { doc, onSnapshot, getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// Firebase config
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

let progressInterval = null;

function animateProgress(duration = 2500) {
const bar = document.getElementById("alert-progress");
let start = 100;

if (!bar) return;

if (progressInterval) clearInterval(progressInterval);

bar.style.transition = "none";
bar.style.width = "100%";

const stepTime = 30;
const steps = duration / stepTime;
const decrement = 100 / steps;

progressInterval = setInterval(() => {
    start -= decrement;
    bar.style.width = `${Math.max(0, start)}%`;

    if (start <= 0) clearInterval(progressInterval);
}, stepTime);


}

const alertBox = document.getElementById("alert-box");
const alertText = document.getElementById("alert-text");

function showAlert(message, type = "info", duration = 2500, loading = false) {


if (!alertBox || !alertText) return;

alertText.textContent = message;

alertBox.className =
    `fixed bottom-6 left-1/2 px-5 py-3 rounded-xl text-sm text-white shadow-xl z-50`;

if (type === "error") {
    alertBox.style.background = "rgba(239, 68, 68, 0.95)";
}

if (type === "success") {
    alertBox.style.background = "rgba(34, 197, 94, 0.95)";
}

if (type === "loading") {
    alertBox.style.background = "rgba(99, 102, 241, 0.95)";
}

alertBox.style.opacity = "1";
alertBox.style.transform = "translate(-50%, 0px)";

if (loading) animateProgress(duration);

if (!loading) {
    animateProgress(duration);

    setTimeout(() => {
        dismissAlert();
    }, duration);
}


}

function dismissAlert() {
alertBox.style.transition = "all 0.25s ease";
alertBox.style.transform = "translate(-50%, 25px)";
alertBox.style.opacity = "0";


setTimeout(() => {
    alertBox.style.transition = "";
}, 300);


}

function getFirebaseErrorMessage(error) {
const code = error?.code || "";

const map = {
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/user-not-found": "No account found with this email.",
    "auth/too-many-requests": "Too many attempts. Try again later.",
    "auth/network-request-failed": "Network error. Check your connection.",
    "default": "Something went wrong. Please try again."
};

return map[code] || map["default"];

}


let btn = document.getElementById("sendBtn");
let emailInput = document.getElementById("email");

// click handler
btn.addEventListener("click", async () => {
const email = emailInput.value.trim();

if (!email || !email.includes("@")) {
    showAlert("Enter a valid email ", "error", 2500);
    return;
}

try {
    btn.disabled = true;

    // 🔵 loading state with progress bar
    showAlert("Sending reset link...", "loading", 6000, true);

const actionCodeSettings = {
  url: "https://marketfy-82c42.web.app/vendor/authentication/change-password.html",
  handleCodeInApp: true
};

await sendPasswordResetEmail(auth, email ,actionCodeSettings);

    // 🟢 success
    showAlert("Reset link sent! Check your email 🚀", "success", 4000);

} catch (err) {
    showAlert(getFirebaseErrorMessage(err), "error", 4000);

} finally {
    btn.disabled = false;
}

});

document.addEventListener("DOMContentLoaded", () => {

    const brandMessageEl = document.getElementById("brand-message");
    const brandRef = doc(db, "gressor", "gressor-report");


    onSnapshot(brandRef, (docSnap) => {
        if (docSnap.exists()) {
            const data = docSnap.data();
            brandMessageEl.textContent = "— " + data.message;
        }
    });

});

