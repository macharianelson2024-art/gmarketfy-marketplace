// ============================================
// VENDOR DASHBOARD — PRODUCTS TAB
// ============================================

import {
  db, collection, query, where, orderBy,
  getDocs, getDoc, doc, addDoc, updateDoc, deleteDoc, setDoc,
  serverTimestamp
} from './firebase-config.js';

// =========================
// LOCAL HELPERS
// =========================
function escHTML(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function setVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value ?? "";
}

function openModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.classList.remove("hidden");
  void overlay.offsetWidth;
  overlay.style.opacity = "1";
  const panel = overlay.querySelector("div");
  if (panel) panel.classList.remove("scale-95");
}

function closeModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.style.opacity = "0";
  const panel = overlay.querySelector("div");
  if (panel) panel.classList.add("scale-95");
  setTimeout(() => overlay.classList.add("hidden"), 300);
}


// =========================
// IMAGE COMPRESSION (local fallback)
// =========================
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const maxW = 600;
        const scale = Math.min(1, maxW / img.width);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.6));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// =========================
// STATE
// =========================
let editingProductId = null;
let selectedPaymentTiming = "before";
let isUploading = false;
let currentImageData = null;

// =========================
// LOAD PRODUCTS
// =========================
window.loadProductsTab = async function() {
  const vendorId = window.vendorId;
  if (!vendorId) { console.log("no vendor id"); return; }

  console.log("starting service");

  const grid = document.getElementById("products-grid");
  const empty = document.getElementById("products-empty");

  if (!grid) return;

  grid.innerHTML = `
    <div class="col-span-full flex justify-center py-16">
      <div class="w-8 h-8 border-2 border-white/10 border-t-indigo-500 rounded-full animate-spin"></div>
    </div>`;
  if (empty) empty.classList.add("hidden");

  try {
    const snap = await getDocs(query(
      collection(db, "products"),
      where("vendor_id", "==", vendorId),
      orderBy("createdAt", "desc")
    ));

    if (snap.empty) {
      grid.innerHTML = "";
      if (empty) empty.classList.remove("hidden");
      return;
    }

    grid.innerHTML = "";
    snap.forEach(d => renderProductCard({ id: d.id, ...d.data() }));

  } catch (e) {
    console.error("Products load failed:", e);
    grid.innerHTML = `
      <div class="col-span-full text-center py-12">
        <p class="text-red-400 text-sm">Failed to load products</p>
        <button onclick="window.loadProductsTab()" class="mt-3 text-xs text-indigo-400 hover:underline">Try again</button>
      </div>`;
  }
};

// =========================
// RENDER PRODUCT CARD
// =========================
function renderProductCard(product) {
  const grid = document.getElementById("products-grid");
  if (!grid) return;

  const stockLow = product.stock < 5;
  const stockOut = product.stock <= 0;

  const card = document.createElement("div");
  card.className = "w-full max-w-xs bg-[#111318] rounded-2xl overflow-hidden border border-white/5 hover:border-white/10 transition-all duration-300 group flex flex-col";
  card.innerHTML = `
    <div class="relative h-44 overflow-hidden bg-gradient-to-b from-white/5 to-transparent">
      ${product.image
        ? `<img src="${product.image}" alt="" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" onerror="this.style.opacity='0.2'" />`
        : `<div class="w-full h-full flex items-center justify-center text-white/10 text-5xl">📦</div>`
      }
      <div class="absolute top-2 right-2 flex flex-col gap-1.5 items-end">
        <span class="text-[10px] px-2 py-1 rounded-full bg-black/60 text-white/70 backdrop-blur-sm font-medium">
          ${product.paymentTiming === "after" ? "💳 Pay After" : "💳 Pay Before"}
        </span>
      </div>
      ${stockLow ? `
        <div class="absolute top-2 left-2">
          <span class="text-[10px] px-2 py-1 rounded-full font-medium backdrop-blur-sm
            ${stockOut ? 'bg-red-500/30 text-red-300' : 'bg-amber-500/20 text-amber-300'}">
            ${stockOut ? '🚫 Out of Stock' : '⚠️ Low Stock'}
          </span>
        </div>` : ''}
    </div>
    <div class="p-4 space-y-2.5 flex-1 flex flex-col">
      <h3 class="text-sm font-semibold text-white truncate" title="${escHTML(product.name)}">${escHTML(product.name)}</h3>
      <p class="text-emerald-400 font-bold text-base">${product.currency || "KSh"} ${(product.price || 0).toLocaleString()}</p>
      <div class="flex items-center gap-3 text-[11px] text-white/30">
        <span class="flex items-center gap-1">
          📦 <span class="${stockOut ? 'text-red-400' : stockLow ? 'text-amber-400' : 'text-white/50'}">${product.stock} in stock</span>
        </span>
        <span class="flex items-center gap-1">🏷️ ${escHTML(product.category || "—")}</span>
      </div>
      ${product.description ? `<p class="text-xs text-white/35 line-clamp-2 leading-relaxed">${escHTML(product.description)}</p>` : ''}
      <div class="flex gap-2 pt-2 mt-auto">
        <button class="edit-product-btn flex-1 py-2.5 rounded-lg bg-indigo-500/10 text-indigo-300 text-[11px] font-semibold hover:bg-indigo-500/20 border border-indigo-500/10 transition-all duration-200" data-id="${product.id}">✏️ Edit</button>
        <button class="delete-product-btn py-2.5 px-3 rounded-lg bg-red-500/8 text-red-400 text-[11px] font-semibold hover:bg-red-500/15 border border-red-500/8 transition-all duration-200" data-id="${product.id}" data-name="${escHTML(product.name)}">🗑️</button>
      </div>
    </div>`;

  card.querySelector(".edit-product-btn").addEventListener("click", () => openProductModal(product));
  card.querySelector(".delete-product-btn").addEventListener("click", () => confirmDeleteProduct(product));

  const img = card.querySelector("img");
  if (img && product.image) {
    img.addEventListener("click", () => previewImage(product.image, product.name));
    img.style.cursor = "pointer";
  }

  grid.appendChild(card);
}

// =========================
// CUSTOM DROPDOWNS
// =========================
function setupCustomDropdown(wrapperId, valId, listId, itemSelector) {
  const wrapper = document.getElementById(wrapperId);
  const valEl = document.getElementById(valId);
  const listEl = document.getElementById(listId);
  if (!wrapper || !valEl || !listEl) return;

  valEl.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".options-menu.active").forEach(menu => {
      if (menu !== listEl) menu.classList.remove("active");
    });
    listEl.classList.toggle("active");
  });

  listEl.querySelectorAll(itemSelector).forEach(item => {
    item.addEventListener("click", () => {
      valEl.textContent = item.textContent;
      valEl.setAttribute("data-selected", item.textContent);
      listEl.classList.remove("active");
    });
  });

  document.addEventListener("click", () => {
    listEl.classList.remove("active");
  });
}

// Init dropdowns
setupCustomDropdown("pf-currency-wrapper", "pf-currency-val", "pf-currency-list", ".cur-opt");
setupCustomDropdown("pf-category-wrapper", "pf-category-val", "pf-category-list", ".cat_opt");

// =========================
// IMAGE UPLOAD — CUSTOM
// =========================
const imageInput = document.getElementById("pf-image");
const previewArea = document.getElementById("pf-image-preview-area");
const previewImg = document.getElementById("pf-image-preview");
const imageOverlay = document.getElementById("pf-image-overlay");
const removeBtn = document.getElementById("pf-remove-image");

imageInput?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > 2 * 1024 * 1024) {
    window.showNotif?.({ type: "warning", title: "Large Image", message: "Image will be compressed." });
  }

  const reader = new FileReader();
  reader.onload = (ev) => {
    currentImageData = ev.target.result;
    previewImg.src = currentImageData;
    previewArea.classList.add("has-image");
    removeBtn.classList.remove("hidden");
  };
  reader.readAsDataURL(file);
});

removeBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  currentImageData = null;
  imageInput.value = "";
  previewImg.src = "";
  previewArea.classList.remove("has-image");
  removeBtn.classList.add("hidden");
});

// =========================
// PRICE INPUT — FORMAT WITH COMMAS (LIVE)
// =========================
function formatPriceInput() {
  const input = document.getElementById("pf-price");
  if (!input) return;

  const newInput = input.cloneNode(true);
  input.parentNode.replaceChild(newInput, input);

  // Format live as user types
  newInput.addEventListener("input", () => {
    // Save cursor position
    const cursorPos = newInput.selectionStart;
    const prevLen = newInput.value.length;

    // Strip everything except digits and one decimal point
    let raw = newInput.value.replace(/,/g, "").replace(/[^\d.]/g, "");

    // Only one decimal allowed
    const parts = raw.split(".");
    if (parts.length > 2) raw = parts[0] + "." + parts.slice(1).join("");

    // Format integer part with commas
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const formatted = parts.length === 2 ? intPart + "." + parts[1] : intPart;

    newInput.value = formatted;

    // Restore cursor position (adjusted for added/removed commas)
    const newLen = newInput.value.length;
    const diff = newLen - prevLen;
    newInput.setSelectionRange(cursorPos + diff, cursorPos + diff);
  });

  // Strip commas on focus, select all for easy replacement
  newInput.addEventListener("focus", () => {
    setTimeout(() => newInput.select(), 10);
  });

  // Clean up on blur (tidy trailing decimals)
  newInput.addEventListener("blur", () => {
    const raw = newInput.value.replace(/,/g, "").trim();
    if (!raw || raw === ".") { newInput.value = ""; return; }
    const num = parseFloat(raw);
    if (!isNaN(num) && num >= 0) {
      newInput.value = num.toLocaleString("en-US");
    }
  });
}

formatPriceInput();


// =========================
// OPEN PRODUCT MODAL
// =========================
function openProductModal(product = null) {
  editingProductId = product?.id || null;
  selectedPaymentTiming = product?.paymentTiming || "before";

  document.getElementById("product-modal-title").textContent = product ? "Edit Product" : "Add Product";
  document.getElementById("pf-submit-btn").textContent = product ? "Update Product" : "Add Product";

  setVal("pf-product-id", product?.id || "");
  setVal("pf-name", product?.name || "");
  setVal("pf-stock", product?.stock || "");
  setVal("pf-description", product?.description || "");
  setVal("pf-paymentTiming", selectedPaymentTiming);


  
  // Price — display with commas
  const priceInput = document.getElementById("pf-price");
  if (priceInput) {
    const rawPrice = product?.price;
    if (rawPrice || rawPrice === 0) {
      priceInput.value = Number(rawPrice).toLocaleString("en-US");
    } else {
      priceInput.value = "";
    }
  }


  // Currency dropdown
  const currencyVal = document.getElementById("pf-currency-val");
  if (currencyVal) {
    currencyVal.textContent = product?.currency || "KSh";
    currencyVal.setAttribute("data-selected", product?.currency || "KSh");
  }

  // Category dropdown
  const categoryVal = document.getElementById("pf-category-val");
  if (categoryVal) {
    categoryVal.textContent = product?.category || "Digital Art";
    categoryVal.setAttribute("data-selected", product?.category || "Digital Art");
  }

  // Reset image
  currentImageData = null;
  imageInput.value = "";
  removeBtn.classList.add("hidden");

  if (product?.image) {
    currentImageData = product.image;
    previewImg.src = product.image;
    previewArea.classList.add("has-image");
    removeBtn.classList.remove("hidden");
  } else {
    previewImg.src = "";
    previewArea.classList.remove("has-image");
  }

  // Payment timing buttons
  document.querySelectorAll(".payment-timing-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.timing === selectedPaymentTiming);
  });

  // Close any open dropdowns
  document.querySelectorAll(".options-menu.active").forEach(m => m.classList.remove("active"));

  openModal("product-modal-overlay");
}



// =========================
// DELETE PRODUCT
// =========================
function confirmDeleteProduct(product) {
  if (typeof window.showDialog === "function") {
    window.showDialog({
      type: "danger",
      emoji: "🗑️",
      tag: "Delete Product",
      title: `Delete "${product.name}"?`,
      message: "This action cannot be undone. All data for this product including ratings and stats will be permanently removed.",
      actions: [
        {
          label: "Yes, delete it",
          style: "danger",
          onClick: async () => {
            window.showLoadingDots?.("Deleting product and related data...");
            try {
              await deleteDoc(doc(db, "products", product.id));
              await deleteDoc(doc(db, "productStats", product.id));

              const ratingsSnap = await getDocs(query(
                collection(db, "ratings"),
                where("targetId", "==", product.id),
                where("targetType", "==", "product")
              ));
              const ratingDeletes = [];
              ratingsSnap.forEach(d => ratingDeletes.push(deleteDoc(doc(db, "ratings", d.id))));
              await Promise.all(ratingDeletes);

              window.hideLoadingDots?.();
              window.showNotif?.({ type: "success", title: "Deleted", message: `"${product.name}" and all related data has been removed.` });
              await window.loadProductsTab();
              if (typeof window.loadOverviewTab === "function") await window.loadOverviewTab();
            } catch (e) {
              console.error("Delete failed:", e);
              window.hideLoadingDots?.();
              window.showNotif?.({ type: "error", title: "Failed", message: "Could not delete product completely." });
            }
          }
        },
        { label: "Cancel", style: "secondary", onClick: () => {} }
      ]
    });
  } else {
    if (!confirm(`Delete "${product.name}"? This cannot be undone.`)) return;
    Promise.all([
      deleteDoc(doc(db, "products", product.id)),
      deleteDoc(doc(db, "productStats", product.id))
    ]).then(() => {
      window.loadProductsTab();
      if (typeof window.loadOverviewTab === "function") window.loadOverviewTab();
    }).catch(err => alert("Failed to delete product."));
  }
}

// =========================
// IMAGE PREVIEW (FULL SIZE)
// =========================
function previewImage(src, name) {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex items-center justify-center p-4 cursor-pointer";
  overlay.innerHTML = `
    <div class="relative max-w-3xl max-h-[90vh]">
      <img src="${src}" alt="${escHTML(name)}" class="max-w-full max-h-[85vh] object-contain rounded-xl" />
      <p class="text-center text-white/60 text-sm mt-3">${escHTML(name)}</p>
      <button class="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center text-sm transition">✕</button>
    </div>`;

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.tagName === "BUTTON") {
      overlay.remove();
      document.body.style.overflow = "";
    }
  });

  document.addEventListener("keydown", function closeOnEsc(e) {
    if (e.key === "Escape") {
      overlay.remove();
      document.body.style.overflow = "";
      document.removeEventListener("keydown", closeOnEsc);
    }
  });

  document.body.style.overflow = "hidden";
  document.body.appendChild(overlay);
}

// =========================
// EVENT BINDINGS
// =========================

// Add product button
document.getElementById("add-product-btn")?.addEventListener("click", () => openProductModal(null));

// Payment timing toggle
document.querySelectorAll(".payment-timing-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    selectedPaymentTiming = btn.dataset.timing;
    setVal("pf-paymentTiming", selectedPaymentTiming);
    document.querySelectorAll(".payment-timing-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
  });
});

// =========================
// SAVE PRODUCT
// =========================
document.getElementById("product-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!window.vendorId || isUploading) return;

  const submitBtn = document.getElementById("pf-submit-btn");
  if (!submitBtn) return;

  // Read form
  const rawName = document.getElementById("pf-name")?.value || "";
  const rawPrice = document.getElementById("pf-price")?.value || "";
  const rawStock = document.getElementById("pf-stock")?.value || "";
  const rawDescription = document.getElementById("pf-description")?.value || "";
  const imageFile = document.getElementById("pf-image")?.files?.[0];

  // Read dropdowns
  const currency = document.getElementById("pf-currency-val")?.textContent?.trim() || "KSh";
  const category = document.getElementById("pf-category-val")?.textContent?.trim() || "";

  // Sanitize
  const name = rawName.trim().slice(0, 100);
  const price = parseFloat(rawPrice.replace(/,/g, ""));
  const stock = parseInt(rawStock);
  const description = rawDescription.trim().slice(0, 1000);

  // Validate
  const errors = validateProduct({ name, price, stock });

  if (errors.length > 0) {
    window.showNotif?.({
      type: "error",
      title: errors[0].field.charAt(0).toUpperCase() + errors[0].field.slice(1),
      message: errors[0].message
    });
    const fieldEl = document.getElementById(`pf-${errors[0].field}`);
    if (fieldEl) fieldEl.focus();
    return;
  }

  // Lock
  isUploading = true;
  submitBtn.disabled = true;
  const originalText = submitBtn.textContent;
  submitBtn.textContent = "Saving...";
  window.showLoadingDots?.("Saving product...");

  try {
    // Resolve image
    let imageData = "";
    if (currentImageData && imageFile) {
      imageData = await compressImage(imageFile);
    } else if (currentImageData && !imageFile) {
      imageData = currentImageData;
    } else if (editingProductId) {
      const snap = await getDoc(doc(db, "products", editingProductId));
      imageData = snap.exists() ? (snap.data().image || "") : "";
    }

    const productData = {
      vendor_id: window.vendorId,
      name,
      price,
      currency,
      stock,
      category,
      description,
      image: imageData,
      paymentTiming: selectedPaymentTiming,
      updatedAt: serverTimestamp()
    };

    if (editingProductId) {
      await updateDoc(doc(db, "products", editingProductId), productData);
      window.showNotif?.({ type: "success", title: "Updated", message: `"${name}" has been updated.` });
    } else {
      productData.createdAt = serverTimestamp();
      const newDoc = await addDoc(collection(db, "products"), productData);
      await updateDoc(doc(db, "products", newDoc.id), { product_id: newDoc.id });

      await setDoc(doc(db, "productStats", newDoc.id), {
        metrics: { totalViews: 0 },
        rating: {
          average: 0,
          totalRatings: 0,
          breakdown: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
        },
        updatedAt: serverTimestamp()
      });

      window.showNotif?.({ type: "success", title: "Added", message: `"${name}" has been added to your store.` });
    }

    closeModal("product-modal-overlay");
    editingProductId = null;
    currentImageData = null;
    await window.loadProductsTab();
    if (typeof window.loadOverviewTab === "function") await window.loadOverviewTab();

  } catch (err) {
    console.error("Save product failed:", err);
    window.showNotif?.({ type: "error", title: "Save Failed", message: err.message || "Could not save product. Please try again." });
  } finally {
    isUploading = false;
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
    window.hideLoadingDots?.();
  }
});

// =========================
// VALIDATION & IMAGE HELPERS
// =========================
function validateProduct({ name, price, stock }) {
  const errors = [];
  if (!name) errors.push({ field: "name", message: "Product name is required." });
  if (isNaN(price)) errors.push({ field: "price", message: "Enter a valid price." });
  else if (price < 0) errors.push({ field: "price", message: "Price cannot be negative." });
  if (isNaN(stock)) errors.push({ field: "stock", message: "Enter a valid stock quantity." });
  else if (stock < 0) errors.push({ field: "stock", message: "Stock cannot be negative." });
  return errors;
}