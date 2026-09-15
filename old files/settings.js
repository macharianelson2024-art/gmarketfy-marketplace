mport {
  doc,
  updateDoc,
  serverTimestamp,
  db,
  onAuthStateChanged,
  auth,
  onSnapshot
} from "./firebase.js";

/* =========================
   GLOBAL STATE
========================= */

let currentVendorId = null;

let deliveryMode = "none";
let deliveryType = "none";
let deliveryEnabled = false;

let bannerFile = null;

/* =========================
   ALERT SYSTEM (INIT FIRST)
========================= */

const alertContainer = document.createElement("div");
alertContainer.id = "app-alert-container";

alertContainer.className = `
  fixed bottom-5 left-1/2 -translate-x-1/2
  z-[9999] space-y-3
  flex flex-col items-center
`;

document.body.appendChild(alertContainer);

function showAlert(message, type = "info", progress = null) {

  const id = "alert_" + Date.now();

  const colors = {
    success: "from-green-500/20 to-emerald-500/10 border-green-400/30 text-green-200",
    error: "from-red-500/20 to-rose-500/10 border-red-400/30 text-red-200",
    info: "from-indigo-500/20 to-blue-500/10 border-indigo-400/30 text-indigo-200",
    loading: "from-indigo-600/20 to-blue-600/10 border-indigo-400/40 text-indigo-100"
  };

  const el = document.createElement("div");

  el.className = `
    w-[280px] rounded-xl border backdrop-blur-md shadow-lg
    bg-gradient-to-br ${colors[type]}
    p-3 transform translate-x-full opacity-0
    transition-all duration-300
  `;

  el.innerHTML = `
    <div class="text-sm font-medium">${message}</div>
    <div class="mt-2 h-1 w-full bg-white/10 rounded-full overflow-hidden">
      <div class="h-full bg-indigo-400 transition-all duration-300"
           style="width:${progress ?? 0}%"></div>
    </div>
  `;

  alertContainer.appendChild(el);

  setTimeout(() => {
    el.classList.remove("translate-x-full", "opacity-0");
  }, 50);

  if (type !== "loading") {
    setTimeout(() => el.remove(), 3000);
  }

  return id;
}

/* =========================
   AUTH SAFE INIT
========================= */

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  currentVendorId = user.uid;
  bindVendorProfile(currentVendorId)
});

/* =========================
   SAFE ELEMENT HELPER
========================= */

function safe(id, fn) {
  const el = document.getElementById(id);
  if (el) fn(el);
}

/* =========================
   DELIVERY TOGGLE
========================= */

safe("deliveryToggle", (toggle) => {

  const knob = document.getElementById("deliveryKnob");

  toggle.addEventListener("click", () => {

    deliveryEnabled = !deliveryEnabled;

    if (!knob) return;

    if (deliveryEnabled) {
      toggle.classList.add("bg-indigo-500/30");
      knob.classList.add("translate-x-6", "bg-indigo-400");
    } else {
      toggle.classList.remove("bg-indigo-500/30");
      knob.classList.remove("translate-x-6", "bg-indigo-400");
    }

  });

});

/* =========================
   MODE DROPDOWN
========================= */

safe("modeDropdownBtn", (btn) => {

  const dropdown = document.getElementById("modeDropdown");
  const selected = document.getElementById("modeSelected");

  btn.addEventListener("click", () => {
    dropdown?.classList.toggle("hidden");
  });

  document.querySelectorAll(".mode-option").forEach(opt => {
    opt.addEventListener("click", () => {

      deliveryMode = opt.dataset.value;
      if (selected) selected.textContent = opt.textContent;

      dropdown?.classList.add("hidden");
    });
  });

});

/* =========================
   TYPE DROPDOWN
========================= */

safe("typeDropdownBtn", (btn) => {

  const dropdown = document.getElementById("typeDropdown");
  const selected = document.getElementById("typeSelected");

  btn.addEventListener("click", () => {
    dropdown?.classList.toggle("hidden");
  });

  document.querySelectorAll(".type-option").forEach(opt => {
    opt.addEventListener("click", () => {

      deliveryType = opt.dataset.value;
      if (selected) selected.textContent = opt.textContent;

      dropdown?.classList.add("hidden");
    });
  });

});

/* =========================
   CLICK OUTSIDE CLOSE
========================= */

document.addEventListener("click", (e) => {

  const modeBtn = document.getElementById("modeDropdownBtn");
  const modeDropdown = document.getElementById("modeDropdown");

  const typeBtn = document.getElementById("typeDropdownBtn");
  const typeDropdown = document.getElementById("typeDropdown");

  if (modeBtn && modeDropdown &&
      !modeBtn.contains(e.target) &&
      !modeDropdown.contains(e.target)) {
    modeDropdown.classList.add("hidden");
  }

  if (typeBtn && typeDropdown &&
      !typeBtn.contains(e.target) &&
      !typeDropdown.contains(e.target)) {
    typeDropdown.classList.add("hidden");
  }

});

/* =========================
   DELIVERY UPDATE
========================= */

safe("updateDeliveryBtn", (btn) => {

  btn.addEventListener("click", async () => {

    const fee = document.getElementById("deliveryFee")?.value || 0;

    const data = {
      enabled: deliveryEnabled,
      fee: Number(fee),
      mode: deliveryMode,
      type: deliveryType
    };

    if (!data.enabled) {
      showAlert("Turn on delivery before updating settings 🚚", "error");
      return;
    }

    if (data.mode === "none") {
      showAlert("Pick a delivery mode first 🚚", "error");
      return;
    }

    if (data.mode === "static" && (!data.fee || data.fee <= 0)) {
      showAlert("Add a delivery fee for static mode 🚚", "error");
      return;
    }

    try {

      const ref = doc(db, "vendors", currentVendorId);

      await updateDoc(ref, {
        delivery: data,
        updatedAt: serverTimestamp()
      });

      showAlert("Delivery updated 🚚", "success");

    } catch (err) {
      console.error(err);
      showAlert("Update failed 😬", "error");
    }

  });

});

/* =========================
   IMAGE UPLOAD + COMPRESS
========================= */

safe("image-preview", (box) => {

  const input = document.getElementById("bannerUpload");
  const preview = document.getElementById("bannerPreview");
  const placeholder = document.getElementById("upload-placeholder");

  box.addEventListener("click", () => input?.click());

  input?.addEventListener("change", async (e) => {

    const file = e.target.files[0];
    if (!file) return;

    try {

      const compressed = await compressImage(file, 400, 0.6);

      bannerFile = { compressed };

      if (preview) {
        preview.src = compressed;
        preview.classList.remove("hidden");
      }

      placeholder?.classList.add("hidden");

    } catch (err) {
      showAlert("Image processing failed 😬", "error");
    }

  });

});

/* =========================
   IMAGE COMPRESSION
========================= */

function compressImage(file, maxWidth = 400, quality = 0.6) {

  return new Promise((resolve, reject) => {

    const reader = new FileReader();

    reader.onload = (e) => {

      const img = new Image();

      img.onload = () => {

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        const scale = Math.min(1, maxWidth / img.width);

        canvas.width = img.width * scale;
        canvas.height = img.height * scale;

        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        resolve(canvas.toDataURL("image/jpeg", quality));

      };

      img.onerror = reject;
      img.src = e.target.result;

    };

    reader.onerror = reject;
    reader.readAsDataURL(file);

  });

}

/* =========================
   PROFILE HELPERS
========================= */

function getFilledFields() {

  const data = {};

  const name = document.getElementById("storeName")?.value;
  const phone = document.getElementById("phoneNumber")?.value;
  const desc = document.getElementById("storeDescription")?.value;

  if (name) data.storeName = name;
  if (phone) data.phone = phone;
  if (desc) data.storeDescription = desc;

  if (bannerFile?.compressed) {
    data.image = bannerFile.compressed;
  }

  return data;
}

function getAddressIfValid() {

  const street = document.getElementById("streetAddress")?.value;
  const city = document.getElementById("city")?.value;
  const region = document.getElementById("region")?.value;
  const postal = document.getElementById("postalCode")?.value;
  const country = document.getElementById("country")?.value;

  const touched = street || city || region || postal || country;

  if (!touched) return null;

  if (!street || !city || !region || !postal || !country) {
    showAlert("Please complete all address fields 🏠", "error");
    return undefined;
  }

  return { street, city, region, postalCode: postal, country };
}

/* =========================
   SAVE PROFILE
========================= */

safe("saveProfileBtn", (btn) => {

  btn.addEventListener("click", async () => {

    const vendorRef = doc(db, "vendors", currentVendorId);

    const profile = getFilledFields();
    const address = getAddressIfValid();

    if (address === undefined) return;

    const update = {};

if (Object.keys(profile).length) {
  Object.assign(update, profile);
}

    if (address) {
      update.address = address;
    }

    if (!Object.keys(update).length) {
      showAlert("Nothing to update 🙂", "info");
      return;
    }

    try {

      await updateDoc(vendorRef, update);

      showAlert("Profile updated 🧍", "success");

    } catch (err) {
      console.error(err);
      showAlert("Update failed 😬", "error");
    }

  });

});



function bindVendorProfile(vendorId) {

  const vendorRef = doc(db, "vendors", vendorId);

  return onSnapshot(vendorRef, (snap) => {

    if (!snap.exists()) return;

    const vendor = snap.data();

    /* =========================
       TEXT FIELDS
    ========================= */

    const setValue = (id, value) => {
      const el = document.getElementById(id);
      if (el && value !== undefined && value !== null) {
        el.value = value;
      }
    };

    setValue("storeName", vendor.storeName);
    setValue("phoneNumber", vendor.phone);
    setValue("storeDescription", vendor.storeDescription);
    setValue("ownerDescription", vendor.ownerDescriprion);

    /* =========================
       ADDRESS
    ========================= */

    if (vendor.address) {
      setValue("streetAddress", vendor.address.street);
      setValue("city", vendor.address.city);
      setValue("region", vendor.address.region);
      setValue("postalCode", vendor.address.postalCode);
      setValue("country", vendor.address.country);
    }

    /* =========================
       PROFILE IMAGE
    ========================= */

    const bannerImg = document.getElementById("bannerPreview");
const placeholder = document.getElementById("upload-placeholder");

if (bannerImg && vendor.image) {

  bannerImg.src = vendor.image;

  bannerImg.classList.remove("hidden");

  if (placeholder) {
    placeholder.classList.add("hidden");
  }
}

    /* =========================
       STATUS
    ========================= */

    const statusEl = document.getElementById("vendorStatus");
    if (statusEl) {
      statusEl.textContent = vendor.status ?? "active";
    }

  });
}