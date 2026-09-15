
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getFirestore, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";


const firebaseConfig = { 
  apiKey: "AIzaSyAUErMIjiQgnprmqYd6wiscOa8CIAAELi8",
  authDomain: "marketfy-82c42.firebaseapp.com",
  projectId: "marketfy-82c42",
  storageBucket: "marketfy-82c42.firebasestorage.app",
  messagingSenderId: "321190245217",
  appId: "1:321190245217:web:b9eb39db0a9a2056a30b20",
  measurementId: "G-07W1D4H9JB"
}


document.querySelectorAll('.btn-primary').forEach(btn => {

  btn.addEventListener('click', () => {

    const loader = document.getElementById("landing-loader");
    const text = document.getElementById("loader-text");
    const bar = document.getElementById("loader-bar");

    // 1. set intent
    localStorage.setItem('vendorOnboarding', 'true');

    // 2. small safety delay (state sync buffer)
    setTimeout(() => {

      // show loader
      loader.classList.remove("opacity-0", "pointer-events-none");

      // stage 1
      text.textContent = "Setting state...";
      bar.style.width = "40%";

      // stage 2
      setTimeout(() => {
        text.textContent = "Preparing authentication...";
        bar.style.width = "75%";
      }, 500);

      // stage 3 → redirect
      setTimeout(() => {
        text.textContent = "Redirecting...";
        bar.style.width = "100%";

        setTimeout(() => {
          window.location.href = "/vendor/authentication/authentication.html";
        }, 300);

      }, 1000);

    }, 200); // small intentional buffer

  });

});




const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const footer = document.getElementById("footer-brand");

onSnapshot(doc(db, "gressor", "gressor-report"), (snap) => {
  if (snap.exists()) {
    const text = "— " + snap.data().message;
    footer.textContent = text;
  }
});


const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {

    if (entry.isIntersecting) {
      entry.target.classList.add("show");
    } 
    else {
      entry.target.classList.remove("show");
    }

  });
}, {
  threshold: 0.15
});

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".fade-up").forEach(el => {
    observer.observe(el);
  });
});


import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const grid = document.getElementById("store-grid");

async function loadStores() {

  const snap = await getDocs(collection(db, "vendors"));
  
    
  let stores = [];

  snap.forEach(doc => {
    const data = doc.data();

    if (data) {
      stores.push({
        name: data.storeName || "Unnamed Store",
        image: data.image || "",
        storeDescription: data.storeDescription || "",
        emailVerified: data.emailVerified || false
      });
    }
  });

  // shuffle
  stores = stores.sort(() => Math.random() - 0.5);

  // take max 3
  stores = stores.slice(0, 3);

  renderStores(stores);
}

function renderStores(stores) {

  grid.innerHTML = "";

  if (stores.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full text-center text-slate-500 text-sm">
        No stores available yet.
      </div>
    `;
    return;
  }

  stores.forEach(store => {
    
    const card = document.createElement("div");

   card.className =
  "rounded-3xl overflow-hidden bg-white/5 border border-white/5 group transition-all duration-300 hover:scale-[1.02] fade-up";

    card.innerHTML = `<div class="glass rounded-3xl overflow-hidden group transition-all duration-300 hover:scale-[1.02]">

  <!-- IMAGE FULL COVER -->
  <div class="h-56 w-full overflow-hidden relative">
    ${store.image 
      ? `<img src="${store.image}" 
          class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110">`
      : ""}
    
    <!-- subtle dark gradient for readability -->
    <div class="absolute inset-0 bg-gradient-to-t from-black/40 via-black/10 to-transparent"></div>

    <!-- VERIFICATION BADGE -->
    <div class="absolute top-3 right-3">
      <span class="px-3 py-1 text-xs rounded-full font-semibold
        ${store.emailVerified 
          ? "bg-green-500/90 text-white" 
          : "bg-red-500/80 text-white"}">
        
        ${store.emailVerified ? "Verified" : "Not Verified"}
      </span>
    </div>

  </div>

  <!-- TEXT OVERLAY SECTION -->
  <div class="p-5 text-center">

    <h3 class="text-sm font-semibold text-white">
      ${store.name}
    </h3>

    <p class="text-xs text-white mt-2 tracking-wide">
      ${store.storeDescription || "No description provided."}
    </p>

    <!-- subtle mini preview (optional identity feel) -->
    <div class="flex gap-2 mt-3 justify-center opacity-60">
      <div class="w-8 h-8 bg-white/5 rounded-md"></div>
      <div class="w-8 h-8 bg-white/5 rounded-md"></div>
      <div class="w-8 h-8 bg-white/5 rounded-md"></div>
    </div>

  </div>

</div>
    `;

    grid.appendChild(card);

  });

  // re-trigger fade animation
  document.querySelectorAll(".fade-up").forEach(el => {
    observer.observe(el);
  });
}

loadStores();
