//This code was part of the earier ersion of this site , i added it here so me and you as developers can track where the site originally started.... 😅😅 ....'By Nelson Macharia'
/*

document.getElementById("submitOrder").onclick = async() => {

  // 🧠 BASIC INPUTS
  const name = document.getElementById("customerName").value.trim();
  const phone = document.getElementById("customerPhone").value.trim();
  const location = document.getElementById("delivery_place").value.trim();
  // 🚨 VALIDATION (simple but important)
  if (!name || !phone) {
    alert("Please fill in your name and phone number");
    return;
  }

  if (!selectedDate) {
    alert("Please select a  delivery/ fetching date");
    return;
  }

  if (!selectedTime) {
    alert("Please select a delivery / fetching time");
    return;
  }

  // 🧠 DELIVERY LOGIC
  let deliveryData = null;

  if (deliverySelected) {
  if(!location){alert("please enter the Location of delivery"); return}
    if (currentVendor?.delivery?.enabled) {
      if (currentVendor.delivery.mode  === "static") {
        deliveryData = {
          type: "static",
          fee: currentVendor.delivery.fee,
          location : location
        };
      } 
      
      else if (currentVendor.delivery.mode  === "dynamic") {
        deliveryData = {
          type: "dynamic",
          fee: currentVendor.delivery.fee, // calculated later
          location : location
        };
      }

    }
  }

  // 🧠 BUILD ORDER OBJECT (VERY IMPORTANT STRUCTURE)
  const order = {
    vendor_id: currentVendor.vendor_id,
    customer: {
      name: name,
      phone: phone
    },

    product: {
      id: currentProduct.product_id,
      name: currentProduct.name,
      price: currentProduct.price
    },

    status : "pending",
    statusPriority: 0,
    vendor: {
      id: currentVendor.vendor_id,
      name: currentVendor.storeName
    },

    quantity: selectedQty,

    delivery: deliverySelected ? deliveryData : null,

    schedule: {
      date: selectedDate,
      time: selectedTime
    },

    total: document.getElementById("orderTotal").textContent,

    createdAt: Timestamp.now()
  };


await  createOrder(order)
};




let selectedQty = 1;
let selectedTime = null;
let selectedDate = null;
let deliverySelected = true;
let currentProduct = null;
let deliveryInfo = document.getElementById("deliveryInfo")


// OPEN MODAL
function openOrderModal(product , vendor) {
  currentProduct = product;
  currentVendor = vendor;
  const modal = document.getElementById("orderModal");
  const box = document.getElementById("orderBox");




  // RESET STATE (IMPORTANT)
  selectedQty = 1;
  qtyValue.textContent = "1";
  selectedTime = null;
  selectedDate = null;

  document.querySelectorAll(".timeCard").forEach(c => c.classList.remove("active"));
  document.querySelectorAll("#calendar div").forEach(c => c.classList.remove("active"));

  // SHOW MODAL
  modal.classList.remove("hidden");

  // ANIMATE IN
  setTimeout(() => {
    box.classList.remove("scale-95", "opacity-0");
    box.classList.add("scale-100", "opacity-100");
  }, 10);

  // PRODUCT INFO
  orderProductImage.src = product.image;
  orderProductName.textContent = product.name;
  orderProductPrice.textContent = "KES " + product.price;

  // DELIVERY LOGIC (SAFE + CLEAN)
  if (vendor.delivery?.enabled) {

    deliverySection.classList.remove("hidden");

const type = vendor.delivery.mode; 

if (type === "static") {
  deliveryInfo.textContent = `Delivery Fee: KES ${vendor.delivery.fee}`;
} else if (type === "dynamic") {
  deliveryInfo.textContent = "Delivery Fee calculated at checkout";
}

    deliveryNote.textContent = "This vendor supports delivery.";
    deliverySelected = true;

  } else {
    deliverySection.classList.add("hidden");
    deliveryNote.textContent = "This vendor does NOT support delivery.";
    deliverySelected = false;
  }

  // CALENDAR + TOTAL
  generateCalendar();
  updateTotal();
}

// QUANTITY
plusQty.onclick = () => {
  selectedQty++;
  qtyValue.textContent = selectedQty;
  updateTotal();
};

minusQty.onclick = () => {
  if (selectedQty > 1) {
    selectedQty--;
    qtyValue.textContent = selectedQty;
    updateTotal();
  }
};

// DELIVERY BUTTONS
document.querySelectorAll(".deliveryBtn").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".deliveryBtn").forEach(b => b.classList.remove("active-delivery-btn"));
    btn.classList.add("active-delivery-btn");
    deliverySelected = btn.dataset.choice === "yes";
    updateTotal();
  };
});

// TIME SELECT
document.querySelectorAll(".timeCard").forEach(card => {
  card.onclick = () => {
    document.querySelectorAll(".timeCard").forEach(c => c.classList.remove("active-time"));
    card.classList.add("active-time");
    selectedTime = card.dataset.time;
  };
});

// CALENDAR (30 DAYS)
function generateCalendar() {
  const calendar = document.getElementById("calendar");
  calendar.innerHTML = "";

  const today = new Date();
  const monthNames = [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December"
  ];

  let currentMonth = -1;

  for (let i = 0; i < 30; i++) {
    const date = new Date();
    date.setDate(today.getDate() + i);

    const day = date.getDate();
    const month = date.getMonth();

    // 👉 MONTH HEADER (only when month changes)
    if (month !== currentMonth) {
      currentMonth = month;

      const monthLabel = document.createElement("div");
      monthLabel.className = "col-span-5 text-xs text-indigo-300/70 mt-2 mb-1 font-semibold tracking-wide min-w-40";
      monthLabel.textContent = monthNames[month];

      calendar.appendChild(monthLabel);
    }

    // 👉 DATE BUTTON
    const btn = document.createElement("div");
    btn.className = "dateBtn";
    btn.textContent = day;

btn.onclick = () => {
  document.querySelectorAll(".dateBtn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");

  const fullDate = new Date(date);

  const options = { 
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  };

  const formatted = fullDate.toLocaleDateString("en-US", options);

  selectedDate = formatted;

  document.getElementById("datePreview").textContent = formatted;
};

    calendar.appendChild(btn);
  }
}

// TOTAL CALC
function updateTotal() {
  if (!currentProduct) return;

  let baseTotal = currentProduct.price * selectedQty;

  let deliveryFee = 0;

  // 🚚 ADD DELIVERY IF SELECTED
  if (deliverySelected && currentVendor?.delivery?.enabled) {
    
if (currentVendor.delivery.mode === "static") {
  deliveryFee = currentVendor.delivery.fee;
}

    // dynamic stays 0 for now (we calculate later)
  }

  const finalTotal = baseTotal + deliveryFee;

  document.getElementById("orderTotal").textContent = `KES ${finalTotal}`;
  document.getElementById("subtotalText").textContent = `Subtotal: KES ${baseTotal}`;
  document.getElementById("deliveryText").textContent = `Delivery: KES ${deliveryFee}`;
  if (deliverySelected && deliveryFee === 0 && currentVendor?.delivery?.enabled && currentVendor.delivery.mode === "dynamic") {
    document.getElementById("deliveryText").textContent = `Delivery :  starts from KES ${currentVendor.delivery.fee}`;
  }
}


document.getElementById('closeOrderBtn').addEventListener('click', () => {
closeOrderModel();
});

function closeOrderModel(){

  const modal = document.getElementById("orderModal");

  // 🧼 Hide modal
  modal.classList.add("hidden");

  // 🔁 RESET STATE
  selectedQty = 1;
  selectedDate = null;
  selectedTime = null;
  deliverySelected = false;

  // 🧼 Reset UI
  document.getElementById("datePreview").textContent = "No date selected";

  document.querySelectorAll(".dateBtn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".timeBtn").forEach(b => b.classList.remove("active"));

  // Reset total
  updateTotal();

}

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
  el.id = id;

  el.className = `
    w-[280px] rounded-xl border backdrop-blur-md shadow-lg
    bg-gradient-to-br ${colors[type]}
    p-3 transform translate-x-full opacity-0
    transition-all duration-300
  `;

  el.innerHTML = `
    <div class="text-sm font-medium">${message}</div>

    <div class="mt-2 h-1 w-full bg-white/10 rounded-full overflow-hidden">
      <div id="${id}-bar"
           class="h-full bg-indigo-400 transition-all duration-300"
           style="width:${progress ?? 0}%">
      </div>
    </div>
  `;

  alertContainer.appendChild(el);

  // animate in
  setTimeout(() => {
    el.classList.remove("translate-x-full", "opacity-0");
  }, 50);

  // auto remove if not loading
  if (type !== "loading") {
    setTimeout(() => {
      removeAlert(id);
    }, 3000);
  }

  return id;
}


function updateAlertProgress(id, value) {
  const bar = document.getElementById(id + "-bar");
  if (bar) bar.style.width = value + "%";
}

function removeAlert(id) {
  const el = document.getElementById(id);
  if (!el) return;

  el.classList.add("translate-x-full", "opacity-0");

  setTimeout(() => {
    el.remove();
  }, 300);
}


async function createOrder(order) {
  const alertId = showAlert("Creating your order...", "loading", 10);

  try {
    updateAlertProgress(alertId, 30);

    const ordersRef = collection(db, "orders");

    updateAlertProgress(alertId, 60);

    await addDoc(ordersRef, {
      ...order,
      createdAt: Timestamp.now(),
      status: "pending"
    });
    // Get product stats doc reference
    
    const productStatsRef = doc(db, "productStats", order.product.id);

  try {
  await updateDoc(productStatsRef, {
    "metrics.totalOrders": increment(1),
    updatedAt: serverTimestamp()
  });
} catch (e) {
  console.error("Stats update failed:", e);
}
    updateAlertProgress(alertId, 100);

    setTimeout(() => {
      removeAlert(alertId);
      showAlert("Order created successfully 🚀", "success");
      closeOrderModel()
    }, 400);

  } catch (err) {
    console.error(err);

    removeAlert(alertId);
    showAlert("Failed to create order 😬", "error");
  }
}


signOut(auth).then(() => {
  // Sign-out successful.
  window.showNotif({ type: "success", title: "Signed Out", message: "You have been signed out successfully." });
}).catch((error) => {
  // An error happened.
  console.warn("Sign out failed: ", error);
  window.showNotif({ type: "error", title: "Sign Out Failed", message: "An error occurred while signing out. Please try again." });
}
);

*/