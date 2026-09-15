// =========================
// SETTINGS TAB
// =========================

  import {
  db,
  collection,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  getDocs,
  Timestamp,
  getDoc,
  doc,
  addDoc,
  updateDoc,
  increment,
  serverTimestamp,
  onAuthStateChanged,
  auth,
  signInWithEmailAndPassword,
  signOut,
  setDoc,
  updateProfile,
  createUserWithEmailAndPassword,
}from './firebase-config.js'

let deliveryEnabled = false;

// =========================
// ADDRESS VALIDATION
// =========================
function validateAddress(addr) {
  const required = {
    clientName:    "Name",
    phoneNumber:   "Phone Number",
    country:       "County",
    region:        "Region",
    city:          "City",
    streetAddress: "Street Address",
    Apartment:     "Apartment",
    HouseNo:       "House Number"
  };

  return Object.entries(required)
    .filter(([key]) => !addr[key] || addr[key].trim() === "")
    .map(([, label]) => label);
}

async function loadSettingsTab() {
  if (!auth.currentUser) return;

  window.showLoadingDots("Loading your settings...");

  try {
    const uid = auth.currentUser.uid;

    // Fetch both docs in parallel
    const [clientSnap, addressSnap] = await Promise.all([
      getDoc(doc(db, "clients", uid)),
      getDoc(doc(db, "clientAddresses", uid))
    ]);

    const clientData = clientSnap.exists() ? clientSnap.data() : {};
    const addressData = addressSnap.exists() ? addressSnap.data() : {};

    // Autofill address inputs
    const fields = ["clientName", "phoneNumber", "country", "region", "city", "streetAddress", "Apartment", "HouseNo"];
    fields.forEach(field => {
      const el = document.getElementById(field);
      if (el && addressData[field]) el.value = addressData[field];
    });

    // Set delivery toggle state
    deliveryEnabled = clientData.autoEnableDelivery || false;
    const toggle = document.getElementById("deliveryToggle");
    const knob = document.getElementById("deliveryKnob");

    if (toggle && knob) {
      if (deliveryEnabled) {
        toggle.classList.add("bg-indigo-500/30");
        knob.classList.add("translate-x-6", "bg-indigo-400");
        knob.classList.remove("bg-slate-400");
      } else {
        toggle.classList.remove("bg-indigo-500/30");
        knob.classList.remove("translate-x-6", "bg-indigo-400");
        knob.classList.add("bg-slate-400");
      }
    }

    window.hideLoadingDots();

  } catch (e) {
    console.warn("loadSettingsTab failed:", e);
    window.hideLoadingDots();
    window.showNotif({ type: "error", title: "Failed to load", message: "Could not load your settings." });
  }
}

window.loadSettingsTab = loadSettingsTab;

// =========================
// DELIVERY TOGGLE
// =========================
function safe(id, fn) {
  const el = document.getElementById(id);
  if (el) fn(el);
}

safe("deliveryToggle", (toggle) => {
  const knob = document.getElementById("deliveryKnob");

  toggle.addEventListener("click", async () => {
    if (!auth.currentUser) return;

    deliveryEnabled = !deliveryEnabled;

    // Optimistic UI update
    if (deliveryEnabled) {
      toggle.classList.add("bg-indigo-500/30");
      knob.classList.add("translate-x-6", "bg-indigo-400");
      knob.classList.remove("bg-slate-400");
    } else {
      toggle.classList.remove("bg-indigo-500/30");
      knob.classList.remove("translate-x-6", "bg-indigo-400");
      knob.classList.add("bg-slate-400");
    }

    // Persist to Firestore
    try {
      await updateDoc(doc(db, "clients", auth.currentUser.uid), {
        autoEnableDelivery: deliveryEnabled
      });

      window.showNotif({
        type: "success",
        title: "Delivery Updated",
        message: `Delivery by default is now ${deliveryEnabled ? "enabled" : "disabled"}.`
      });

    } catch (e) {
      console.warn("Delivery toggle sync failed:", e);

      // Revert UI on failure
      deliveryEnabled = !deliveryEnabled;
      if (deliveryEnabled) {
        toggle.classList.add("bg-indigo-500/30");
        knob.classList.add("translate-x-6", "bg-indigo-400");
        knob.classList.remove("bg-slate-400");
      } else {
        toggle.classList.remove("bg-indigo-500/30");
        knob.classList.remove("translate-x-6", "bg-indigo-400");
        knob.classList.add("bg-slate-400");
      }

      window.showNotif({ type: "error", title: "Sync Failed", message: "Could not update delivery setting." });
    }
  });
});


// =========================
// SAVE PROFILE (address)
// =========================
safe("saveProfileBtn", (btn) => {
  btn.addEventListener("click", async () => {
    if (!auth.currentUser) return;

    const address = {
      clientName:    document.getElementById("clientName")?.value?.trim(),
      phoneNumber:   document.getElementById("phoneNumber")?.value?.trim(),
      country:       document.getElementById("country")?.value?.trim(),
      region:        document.getElementById("region")?.value?.trim(),
      city:          document.getElementById("city")?.value?.trim(),
      streetAddress: document.getElementById("streetAddress")?.value?.trim(),
      Apartment:     document.getElementById("Apartment")?.value?.trim(),
      HouseNo:       document.getElementById("HouseNo")?.value?.trim(),
    };

    const missing = validateAddress(address);
    if (missing.length > 0) {
      window.showNotif({
        type: "warning",
        title: "Incomplete Profile",
        message: `Please fill in: ${missing.join(", ")}`
      });
      return;
    }

    btn.disabled = true;
    btn.textContent = "Saving...";

    try {
      await setDoc(doc(db, "clientAddresses", auth.currentUser.uid), {
        ...address,
        updatedAt: Timestamp.now()
      });

      window.showNotif({ type: "success", title: "Profile Saved", message: "Your delivery address has been saved." });

    } catch (e) {
      console.warn("Save profile failed:", e);
      window.showNotif({ type: "error", title: "Save Failed", message: "Could not save your profile." });
    } finally {
      btn.disabled = false;
      btn.textContent = "Save Profile";
    }
  });
});


// =========================
// UPDATE DELIVERY OPTIONS
// =========================
safe("updateDeliveryBtn", (btn) => {
  btn.addEventListener("click", async () => {
    if (!auth.currentUser) return;

    btn.disabled = true;
    btn.textContent = "Updating...";

    try {
      await updateDoc(doc(db, "clients", auth.currentUser.uid), {
        autoEnableDelivery: deliveryEnabled,
        updatedAt: Timestamp.now()
      });

      window.showNotif({ type: "success", title: "Delivery Options Updated", message: "Your delivery preferences have been saved." });

    } catch (e) {
      console.warn("updateDeliveryBtn failed:", e);
      window.showNotif({ type: "error", title: "Update Failed", message: "Could not update delivery options." });
    } finally {
      btn.disabled = false;
      btn.textContent = "Update Delivery Options";
    }
  });
});

window.loadSettingsTab = loadSettingsTab;