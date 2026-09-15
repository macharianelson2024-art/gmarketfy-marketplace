// ===============================
// 🔥 FIREBASE IMPORTS
// ===============================

import { app , db } from "./firebase.js";

import {
  auth,
  onAuthStateChanged
} from "./firebase.js";

import {
  collection,
  addDoc,
  updateDoc,
  doc,
  serverTimestamp,
  query,
  onSnapshot,
  where,
  setDoc,
  getDoc,
  deleteField
} from "./firebase.js";

import { initAnalytics ,getNumberOfStoreVisitors } from "./analytics.js";

let currentVendorId = null;
let productImageBase64 = "";
let editingProductId = null;

// ===============================
// 🧭 NAVIGATION SYSTEM
// ===============================

const VIEW_IDS = ["dashboard", "products", "orders", "analytics", "settings"];

const views = {};
const buttons = {};
const mobileButtons = {};

VIEW_IDS.forEach(id => {
  views[id] = document.getElementById(`view${capitalize(id)}`);
  buttons[id] = document.getElementById(`btn${capitalize(id)}`);
  mobileButtons[id] = document.getElementById(`m${capitalize(id)}`);
});

let active = "dashboard";
const indicator = document.getElementById("navIndicator");



function updateUI() {
  VIEW_IDS.forEach(id => {
    const isActive = id === active;
    buttons[id]?.classList.toggle("active", isActive);
    mobileButtons[id]?.classList.toggle("active", isActive);
  });

  requestAnimationFrame(() => {
    moveIndicator(buttons[active]);
  });
}

function moveIndicator(el) {
  if (!indicator || !el) return;

  const rect = el.getBoundingClientRect();
  const parentRect = el.parentElement.getBoundingClientRect();

  indicator.style.width = `${rect.width}px`;
  indicator.style.transform = `translateX(${rect.left - parentRect.left}px)`;
}

// bind events
VIEW_IDS.forEach(id => {
  buttons[id]?.addEventListener("click", () => switchView(id));
  mobileButtons[id]?.addEventListener("click", () => switchView(id));
});


// ===============================
// 📱 MOBILE MENU
// ===============================

const menu = document.getElementById("mobileMenu");
const toggle = document.getElementById("btnMenuToggle");

let menuOpen = false;

function openMenu() {
  menuOpen = true;
  menu.classList.remove("hidden");
}

function closeMenu() {
  menuOpen = false;
  menu.classList.add("hidden");
}

toggle?.addEventListener("click", () => {
  menuOpen ? closeMenu() : openMenu();
});





// ===============================
// 🔥 AUTH LISTENER
// ===============================

let currentVendor = null;

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "./authentication/authentication.html";
    return;
  }

  try {
    currentVendorId = user.uid;
    listenToProducts(currentVendorId);
    getNumberOfStoreVisitors(currentVendorId);
    initAnalytics(currentVendorId);

  } catch (err) {
    console.error("Auth init error:", err);
  }
});

// ===============================
// ➕ PRODUCT MODAL
// ===============================

const modal = document.getElementById("addProductModal");
const modalBox = document.getElementById("productModalBox");



document.getElementById("btnCloseModal").onclick = closeModal;

function closeModal() {

  editingProductId = null; // ✅ reset mode

  document.getElementById("btnSaveProduct").textContent = "Save Product";

  clearProductFormAnimated();

  setTimeout(() => {
    modalBox.classList.add("scale-95", "opacity-0");

    setTimeout(() => {
      modal.classList.add("opacity-0", "pointer-events-none");
    }, 200);
  }, 1000);
}

// ===============================
// 💾 SAVE PRODUCT
// ===============================

document.getElementById("btnSaveProduct").addEventListener("click", async () => {
  const rawPrice = priceInput.value.replace(/,/g, "");
  const numericPrice = Number(rawPrice);


  const name = productName.value.trim();
  const price = numericPrice;
  const stock = Number(productStock.value) || 0;
  const description = productDesc.value.trim();
  const category = productCategory.value.trim();
  const image = productImageBase64;

  if (!name || !price || !image || !category) {
    alert("Name, price, image and category required");
    return;
  }



  try {

    // =========================
    // 🆕 CREATE MODE
    // =========================
    if (!editingProductId) {

      const productRef = doc(collection(db, "products"));

      await setDoc(productRef, {
        product_id: productRef.id,
        vendor_id: currentVendorId,
        name,
        price,
        currency: activeCurrency,
        stock,
        description,
        image,
        category,
        available: stock > 0,
        createdAt: serverTimestamp()
      });

      await setDoc(doc(db, "productStats", productRef.id), {
        product_id: productRef.id,
        vendor_id: currentVendorId,
         product_name : name ,
        rating: {
          average: 0,
          totalRatings: 0,
          breakdown: {1:0,2:0,3:0,4:0,5:0}
        },
        metrics: {
          totalViews: 0,
          totalOrders: 0,
          totalRevenue: 0
        },
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

    }

    // =========================
    // ✏️ EDIT MODE
    // =========================
    else {

      const productRef = doc(db, "products", editingProductId);

      await updateDoc(productRef, {
        name,
        price,
        currency: activeCurrency,
        stock,
        description,
        image,
        category,
        available: stock > 0,
        updatedAt: serverTimestamp()
      });

      // also update stats timestamp
      await updateDoc(doc(db, "productStats", editingProductId), {
        updatedAt: serverTimestamp()
      });

    }

 

  } catch (err) {
    console.error(err);
  }
  finally{
   closeModal();
  }
});

// ===============================
// 🖼 IMAGE UPLOAD + VALIDATION
// ===============================

document.getElementById("productImageInput").addEventListener("change", async (e) => {

  const file = e.target.files[0];
  if (!file) return;

  // ✅ validation
  if (!file.type.startsWith("image/")) {
    alert("Please select an image file");
    e.target.value = "";
    return;
  }

  if (file.size > 2 * 1024 * 1024) {
    alert("Image too large (max 2MB)");
    e.target.value = "";
    return;
  }

  // 🔥 compress
  const compressed = await compressImage(file);

  productImageBase64 = compressed;

  const img = document.getElementById("product-preview-img");
  const placeholder = document.getElementById("product-upload-placeholder");

  img.src = compressed;
  img.classList.remove("hidden");
  placeholder.classList.add("hidden");
});


const priceInput = document.getElementById("productPrice");

priceInput.addEventListener("input", (e) => {
  let value = e.target.value;

  // Remove anything that's not a number
  value = value.replace(/\D/g, "");

  // Add commas
  value = new Intl.NumberFormat().format(value);

  e.target.value = value;
});

// ===============================
// 🧠 IMAGE COMPRESSION
// ===============================

function compressImage(file, maxWidth = 400, quality = 0.6) {
  return new Promise((resolve) => {

    const reader = new FileReader();

    reader.onload = (event) => {

      const img = new Image();

      img.onload = () => {

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        const scale = Math.min(1, maxWidth / img.width);

        const width = img.width * scale;
        const height = img.height * scale;

        canvas.width = width;
        canvas.height = height;

        ctx.drawImage(img, 0, 0, width, height);

        resolve(canvas.toDataURL("image/jpeg", quality));
      };

      img.src = event.target.result;
    };

    reader.readAsDataURL(file);
  });
}


// ===============================
// 🚀 INIT
// ===============================

function init() {
  updateUI();

  requestAnimationFrame(() => {
    moveIndicator(buttons[active]);
  });

}

window.addEventListener("load", init);

window.addEventListener("resize", () => {
  moveIndicator(buttons[active]);
});


// ===============================
// 🧰 UTIL
// ===============================

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ===============================
// STOCK CUSTOM STEPPER
// ===============================

const stockInput = document.getElementById("productStock");
const plusBtn = document.getElementById("stockPlus");
const minusBtn = document.getElementById("stockMinus");

plusBtn.onclick = () => {
  stockInput.value = Number(stockInput.value || 0) + 1;
};

minusBtn.onclick = () => {
  const val = Number(stockInput.value || 0);
  stockInput.value = val > 0 ? val - 1 : 0;
};

const imageBox = document.getElementById("product-image-preview");
const fileInput = document.getElementById("productImageInput");

imageBox.addEventListener("click", () => {
  fileInput.click();
});

// ===============================
// 💱 CURRENCY SYSTEM
// ===============================

const currencyBtn = document.getElementById("currencyBtn");
const currencyDropdown = document.getElementById("currencyDropdown");
const selectedCurrency = document.getElementById("selectedCurrency");

let activeCurrency = "KES";

// 👉 you can expand this anytime (or fetch from API later)
const currencies = [
  // Africa
  "KES", "UGX", "TZS", "RWF", "ETB", "NGN", "ZAR", "GHS", "ZMW", "BWP", "NAD", "XOF", "XAF", "MAD", "EGP", "DZD", "LYD", "SDG", "SOS", "MWK", "MZN",

  // Americas
  "USD", "CAD", "MXN", "BRL", "ARS", "CLP", "COP", "PEN", "UYU", "BOB", "GTQ", "CRC", "DOP", "JMD",

  // Europe
  "EUR", "GBP", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "BGN", "HRK", "RSD", "UAH",

  // Asia
  "INR", "PKR", "BDT", "LKR", "NPR", "CNY", "JPY", "KRW", "THB", "VND", "MYR", "IDR", "PHP", "SGD", "HKD", "TWD", "KZT", "UZS", "AFN", "IRR", "IQD", "SAR", "AED", "QAR", "KWD", "BHD", "OMR", "ILS",

  // Oceania
  "AUD", "NZD", "FJD", "PGK", "SBD",

  // Crypto (optional but useful for future expansion 👀)
  "BTC", "ETH", "USDT", "BNB", "SOL", "XRP", "DOGE"
];

// ===============================
// BUILD DROPDOWN
// ===============================

function renderCurrencies(list) {
  currencyDropdown.innerHTML = "";

  list.forEach(curr => {
    const item = document.createElement("div");

    item.className =
      "px-4 py-2 text-sm text-white/80 hover:bg-white/10 cursor-pointer transition";

    item.textContent = curr;

    item.onclick = () => {
      activeCurrency = curr;
      selectedCurrency.textContent = curr;
      currencyDropdown.classList.add("hidden");
    };

    currencyDropdown.appendChild(item);
  });
}

// ===============================
// TOGGLE DROPDOWN
// ===============================

currencyBtn.onclick = () => {
  currencyDropdown.classList.toggle("hidden");
};

// close when clicking outside
document.addEventListener("click", (e) => {
  if (!currencyBtn.contains(e.target) &&
      !currencyDropdown.contains(e.target)) {
    currencyDropdown.classList.add("hidden");
  }
});

// init
renderCurrencies(currencies);




function renderProductCard(product, stats = null) {

  const card = document.createElement("div");

  const isOutOfStock = product.stock <= 0;

  card.className =
    "glass p-4 rounded-2xl flex flex-col gap-3 fade-up transition-all duration-300 hover:scale-[1.02]";

  card.innerHTML = `
    <!-- IMAGE -->
    <div class="h-40 bg-white/5 rounded-xl overflow-hidden">
      <img src="${product.image}" 
        class="w-full h-full object-cover"
        alt="${product.name}">
    </div>

    <!-- INFO -->
    <div class="flex flex-col gap-1">
      <h3 class="text-white font-medium truncate">${product.name}</h3>
      <p class="text-sm text-green-400 font-semibold">
        ${product.currency} ${product.price}
      </p>
    </div>

    <!-- META -->
    <div class="flex justify-between text-xs text-slate-400">
      <span>Stock: ${product.stock}</span>
      <span>Views: ${stats?.metrics?.totalViews ?? 0}</span>
    </div>

    <!-- RATING -->
    <div class="text-xs text-yellow-400">
      ⭐ ${stats?.rating?.average?.toFixed?.(1) ?? "0.0"} 
      <span class="text-white/40">
        (${stats?.rating?.totalRatings ?? 0})
      </span>
    </div>

    <!-- STATUS -->
    <div>
      <span class="text-xs px-2 py-1 rounded-full ${
        isOutOfStock ? "bg-red-500/20 text-red-300" : "bg-green-500/20 text-green-300"
      }">
        ${isOutOfStock ? "Out of Stock" : "Active"}
      </span>
    </div>

    <!-- ACTIONS -->
<div class="flex gap-2 mt-2">
  <button class="edit-btn text-xs bg-white/10 hover:bg-white/20 px-3 py-1 rounded-lg">
    Edit
  </button>
</div>
  `;
  card.classList.add("product-card");
  card.querySelector(".edit-btn").addEventListener("click", () => {
  openEditModal(product);
});

  return card;
}

function openEditModal(product) {

  editingProductId = product.product_id;

  // fill inputs
  productName.value = product.name;
  productPrice.value = product.price;
  productStock.value = product.stock;
  productDesc.value = product.description || "";
  productCategory.value = product.category || "";

  activeCurrency = product.currency || "KES";
  selectedCurrency.textContent = activeCurrency;

  productImageBase64 = product.image;

  // show preview
  const img = document.getElementById("product-preview-img");
  const placeholder = document.getElementById("product-upload-placeholder");

  img.src = product.image;
  img.classList.remove("hidden");
  placeholder.classList.add("hidden");

  // open modal
  modal.classList.remove("hidden");
  modal.classList.remove("pointer-events-none", "opacity-0");

  modalBox.classList.remove("scale-95", "opacity-0");
  modalBox.classList.add("scale-100", "opacity-100");

  // optional: change button text
  document.getElementById("btnSaveProduct").textContent = "Update Product";
}

let productsNumber = 0;
let isRendering = false;

function listenToProducts(currentVendorId) {

  const q = query(
    collection(db, "products"),
    where("vendor_id", "==", currentVendorId)
  );

  onSnapshot(q, async (snapshot) => {
    if (isRendering) return;
      isRendering = true;
    const count = snapshot.size;
    const grid = document.getElementById("productsGrid");
    const empty = document.getElementById("emptyProducts");
      grid.innerHTML = "";
      productsNumber = count;

    const products = [];

    snapshot.forEach(docSnap => {
      products.push(docSnap.data());
    });

    // handle empty state
    if (products.length === 0) {
      grid.innerHTML = "";
      empty.classList.remove("hidden");
      isRendering = false; 
      return;
    }

    empty.classList.add("hidden");

    await renderProductsBatch(products, grid);
    isRendering = false;
  });
}


async function renderProductsBatch(products, grid) {

  grid.innerHTML = "";

  const statsResults = await Promise.all(
    products.map(p =>
      getDoc(doc(db, "productStats", p.product_id))
    )
  );

  const fragment = document.createDocumentFragment();

  products.forEach((product, i) => {

    const stats = statsResults[i].exists()
      ? statsResults[i].data()
      : null;

    const card = renderProductCard(product, stats);

    // 👇 animation delay per card
    card.classList.add("fade-up");
    card.style.animationDelay = `${i * 60}ms`;

    fragment.appendChild(card);
  });

  grid.appendChild(fragment);
  document.getElementById("kpiProducts").innerText = productsNumber;
}


document.getElementById("btnOpenAddProduct").addEventListener('click', () => {

  modal.classList.remove("hidden"); // ✅ ADD THIS

  modal.classList.remove("pointer-events-none", "opacity-0");

  modalBox.classList.remove("scale-95", "opacity-0");
  modalBox.classList.add("scale-100", "opacity-100");
});



async function clearProductFormAnimated() {

  const inputs = [
    productName,
    productPrice,
    productStock,
    productDesc,
    productCategory
  ];

  // include image reset as a "step"
  const clearImage = () => {
    productImageBase64 = "";

    const img = document.getElementById("product-preview-img");
    const placeholder = document.getElementById("product-upload-placeholder");

    img.src = "";
    img.classList.add("hidden");
    placeholder.classList.remove("hidden");

    document.getElementById("productImageInput").value = "";
  };

  // 🎲 random direction
  const reverse = Math.random() > 0.5;

  const orderedInputs = reverse ? [...inputs].reverse() : inputs;

  for (let i = 0; i < orderedInputs.length; i++) {

    const input = orderedInputs[i];

    // little fade effect (optional but sexy)
    input.style.transition = "all 0.2s ease";
    input.style.opacity = "0.3";

    await new Promise(res => setTimeout(res, 80));

    input.value = "";

    input.style.opacity = "1";
  }

  // clear image last (or first depending on direction 😏)
  await new Promise(res => setTimeout(res, 100));
  clearImage();
}




const loader = document.getElementById("globalLoader");

function showLoader() {
  loader.classList.remove("hidden");
}

function hideLoader() {
  loader.classList.add("hidden");
}

async function switchView(view) {
  if (!views[view]) return;

  showLoader();

  // hide all views
  VIEW_IDS.forEach(id => views[id]?.classList.add("hidden"));

  active = view;
  updateUI();
  closeMenu();

  await new Promise(res => setTimeout(res, 400)); // shorter delay is fine

  views[view].classList.remove("hidden");

  // trigger data load per view
  if (view === "orders")    window.dispatchEvent(new CustomEvent("loadOrders"));
  if (view === "analytics") window.dispatchEvent(new CustomEvent("loadAnalytics"));
  if (view === "settings")  window.dispatchEvent(new CustomEvent("loadSettings"));

  hideLoader();
}



document.getElementById("home").addEventListener('click' ,()=>{
  window.location.href = '../index.html';
})