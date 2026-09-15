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
  sessionStorage.setItem("gressor_gmarketfy_user_role", "null");
// =========================
// FIREBASE CONFIG
// =========================

window.POST_ACTIONS = []

document.getElementById("home").addEventListener('click' ,()=>{
  window.location.href = './index.html';
})

const userredirection = {
  event_id : "evRedirectUser" , // unique id for this action (used for tracking and debugging)
  after_event : "Authentication",
  purpose : "redirect User",
  action : ()=>{
    window.location.href = './client/dashboard.html'
  }
}

let signInRequest = JSON.parse(localStorage.getItem('Gressor-gmarketfy-client-log-in-request'));
if(signInRequest){
  window.POST_ACTIONS.push(userredirection) 
  console.log(window.POST_ACTIONS);
  
  localStorage.removeItem('Gressor-gmarketfy-client-log-in-request');  
  openAuthModal();
}

initUserCart();

// =========================
// SYNC SEARCH SECTION POSITION
// =========================
function syncSearchOffset() {
  const header = document.querySelector("header");
  const searchSection = document.getElementById("searchSection");
  const main = document.querySelector("main");

  if (!header || !searchSection) return;

  const headerHeight = header.getBoundingClientRect().height;
  searchSection.style.top = headerHeight + "px";

  // push main content below both fixed bars
  if (main) {
    const searchHeight = searchSection.getBoundingClientRect().height;
    main.style.paddingTop = (headerHeight + searchHeight) + "px";
  }
}

syncSearchOffset();
window.addEventListener("resize", syncSearchOffset);

const productsView = document.getElementById("productsGrid");
const storesView = document.getElementById("storesGrid");

const btnProducts = document.querySelectorAll("#btnProducts, #btnProductsMobile");
const btnStores = document.querySelectorAll("#btnStores, #btnStoresMobile");
const slider = document.getElementById("slider");
const sliderMobile = document.getElementById("sliderMobile");
const modalContent = document.getElementById('vendorMobileContent');

const vendorPanel = document.getElementById("vendorPanel");

const vendorLoading = document.getElementById("vendorLoading");
const vendorContent = document.getElementById("vendorContent");


let suggested_username = null;




let activeVendorFilter = null;

let currentVendor = null;



// Product Service State
const ProductService = {
  productsList: [],
  productsMap: {},
  isFetching: false
};
const VendorService = {
  isFetching: false,
  LIMIT: 20,

  lastVisible: null,
  hasMore: true,
  loaded: false,

  vendorsMap: {},
  vendorsList: []
};

window.VendorService = VendorService;




function ensureVendorContext(vendorId) {
  if (!ProductService.contexts.vendors[vendorId]) {
    ProductService.contexts.vendors[vendorId] = {
      lastVisible: null,
      hasMore: true,
      loaded: false
    };
  }
}

async function switchVendor(vendorId) {

  ensureVendorContext(vendorId);

  const ctx = ProductService.contexts.vendors[vendorId];

  clearGrid(productsView);
  showLoaderInside(productsView);

  // 🧠 ONLY FETCH FIRST TIME
  if (!ctx.loaded) {

    const newProducts = await fetchProducts({ vendorId });

    ctx.loaded = true;

    renderProducts(productsView, newProducts);

  } else {
    // ⚡ already loaded → instant render from cache
    const cached = ProductService.productsList.filter(
      p => p.vendorId === vendorId
    );

    renderProducts(productsView, cached);
  }

}


async function fetchProducts({ max = 20, vendorId = null } = {}) {
  try {
    let baseQuery = collection(db, "products");

    if (vendorId) {
      baseQuery = query(
        baseQuery,
        where("vendor_id", "==", vendorId),
        orderBy("createdAt", "desc"),
      );
    } else {
      baseQuery = query(
        baseQuery,
        orderBy("createdAt", "desc"),
      );
    }

    const snapshot = await getDocs(baseQuery);

    const products = [];

    snapshot.forEach((docSnap) => {
      products.push({
        id: docSnap.id,
        ...docSnap.data()
      });
    });

    return products;

  } catch (err) {
    console.error("fetchProducts error:", err);
    return [];
  }
}

async function loadProducts(type = "all", vendor_id) {
  if (ProductService.isFetching) return;
  ProductService.isFetching = true;

  showLoaderInside(productsView);

  try {
    let prods = [];

    if (type === "all") {
      prods = await fetchProducts();
    }

    else if (type === "vendor" && vendor_id) {
      prods = await fetchProducts({
        max: 20,
        vendorId: vendor_id
      });
    }

    // 🧠 reset or append logic (simple version = reset)
    ProductService.productsList = prods;

    // 🧠 rebuild map
    ProductService.productsMap = {};

    prods.forEach(p => {
      ProductService.productsMap[p.product_id] = p;
    });

    clearGrid(productsView);
    renderProducts(productsView, ProductService.productsList);

  } catch (err) {
    console.error(err);
  } finally {
    ProductService.isFetching = false;
  }
}


async function loadStores() {
  // 🚫 prevent double calls
  if (VendorService.isFetching) return;

  VendorService.isFetching = true;

  try {

    clearGrid(storesView);   
    showLoaderInside(storesView);

    // 🧠 if already loaded → use cache instantly
    if (VendorService.loaded) {      
      setTimeout(()=>{
      clearGrid(storesView)
      renderStores(storesView, VendorService.vendorsList);
      },1000)
      return;
    }

    // 🔥 build query
    let q = query(
      collection(db, "vendors"),
      orderBy("createdAt", "desc"),
    );


const snapshot = await getDocs(q);

    // 🚫 no more data
    if (snapshot.empty) {
      VendorService.hasMore = false;      
      renderStores(storesView , [])
      return;
    }

   
const newVendors = [];

snapshot.forEach(docSnap => {

  const vendor = {
    id: docSnap.id,
    ...docSnap.data()
  };

  // 🔑 single source of truth ID
  const vendorId = vendor.vendor_id || docSnap.id;

  // 🧠 store in map (fast lookup)
  VendorService.vendorsMap[vendorId] = vendor;

  // 🧠 avoid duplicates using MAP (fast + reliable)
  if (!VendorService.vendorsList.some(v => v.vendor_id === vendorId)) {
    VendorService.vendorsList.push(vendor);
  }

  newVendors.push(vendor);
});

    // 🚀 mark loaded ONLY after successful fetch
    VendorService.loaded = true;

    clearGrid(storesView);
    renderStores(storesView, VendorService.vendorsList);

  } catch (err) {
    console.error("loadStores error:", err);
  } finally {
    VendorService.isFetching = false;
  }
}

  function showLoaderInside(view) {
    view.innerHTML += `
      <div id="localLoader" class="flex justify-center py-10">
        <div class="w-9 h-9 border-2 border-white/10 border-t-indigo-500 rounded-full spin"></div>
      </div>
    `;
  }




  
  // helper: reset grid before loading new data

function clearGrid(view) {
  view.innerHTML = "";
}

  // helper: simulate render (replace later with Firestore)
function renderProducts(view, products) {
 if (!Array.isArray(products) || products.length === 0) {
    view.innerHTML = noProductsFound;
    return;
  }

  
  products.forEach((product, i) => {

    const card = document.createElement("div");

    card.className =
      "fade-up group bg-white/5 backdrop-blur-lg rounded-2xl overflow-hidden border border-white/10 hover:scale-[1.02] transition-all duration-300 w-full max-w-[260px] mx-auto";

    card.style.animationDelay = (i * 0.05) + "s";

    card.innerHTML = `
      <!-- IMAGE -->
      <div class="relative w-full h-44 md:h-52 lg:h-56 overflow-hidden">
        <img 
          src="${product.image}" 
          alt="${product.name}"
          loading="lazy"
          class="w-full h-full object-cover transform group-hover:scale-110 transition-transform duration-700 ease-out product_image"
        />
      </div>

      <!-- CONTENT -->
      <div class="p-3 space-y-2">

        <!-- NAME -->
        <h3 class="text-sm md:text-base font-semibold truncate">
          ${product.name}
        </h3>

        <!-- PRICE -->
        <p class="text-green-400 font-bold text-sm md:text-base">
         ${product.currency} ${product.price}
        </p>
       <!-- RATING --> 
      <div class="flex items-center gap-2 mt-2 text-xs text-white/70">
      <span  id="product-rating-${product.product_id}">Loading ⭐</span>
      </div>

        <!-- VENDOR -->
        <p class="text-xs text-gray-400 truncate">
          by Vendor ${product.name}
        </p>

        <!-- ACTIONS -->
        <div class="flex items-center justify-between pt-1">

          <!-- VIEW VENDOR -->
          <button 
            class="text-xs text-blue-400 hover:underline view-vendor-info" data-vendor-rating=""
            data-vendor-id="${product.vendor_id}">
            Vendor
          </button>
          <button
            class="text-xs text-yellow-400 hover:text-yellow-300 rate-product-btn"
            data-product-id="${product.product_id}"
            data-vendor-id="${product.vendor_id}">
            Rate
          </button>

          <!-- ORDER -->
      <button vendor-id="${product.vendor_id}" product-id="${product.product_id}"
            class="text-xs bg-blue-500 hover:bg-blue-600 px-3 py-1 rounded-lg transition" id="add-to-cart">
            Add to Cart
      </button>

        </div>
      </div>
    `;

  view.appendChild(card);
  const img = card.querySelector(".product_image");

    img.addEventListener("click", () => {
      openProductModal(product);

    });


  getProductRating(product.product_id).then(r => {
  const element = document.getElementById(`product-rating-${product.product_id}`);
  
  if (!element) return;
    element.dataset.average = r.average.toFixed(1);
    element.dataset.total = r.totalRatings;
    element.innerHTML = `
    ⭐ ${r.average.toFixed(1)}
    <span class="text-white/40" > -> ${r.totalRatings}</span>
  `;
});

getVendorRating(product.vendor_id).then(r => {  
    try{
   const ratingattr = document.querySelector('.view-vendor-info');   
   ratingattr.setAttribute("data-vendor-rating" , `${r.average.toFixed(1)}(${r.totalRatings})`)
    }
    catch{
        console.warn("Failed to set vendor rating attribute for product " + product.product_id);
    }
})


  });

  // attach vendor click handlers after render
  activateVendorListening();
}

function setActive(tab) {
  if (tab === "products") {
    document.getElementById('searchInput').setAttribute('placeholder', 'What are you looking for today?');
    // show products view
    storesView.classList.add("hidden");
    productsView.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });

    // slider
    slider.style.transform = "translateX(0%)";
    if (sliderMobile) sliderMobile.style.transform = "translateX(0%)";

    // button states
    btnProducts.forEach(btn => btn.classList.remove("text-white/40"));
    btnStores.forEach(btn => btn.classList.add("text-white/40"));
  }

else {
    document.getElementById('searchInput').setAttribute('placeholder', 'Search for your favorite stores');
  productsView.classList.add("hidden");
  storesView.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });

  slider.style.transform = "translateX(100%)";
  if (sliderMobile) sliderMobile.style.transform = "translateX(100%)";

  btnStores.forEach(btn => btn.classList.remove("text-white/40"));
  btnProducts.forEach(btn => btn.classList.add("text-white/40"));

  // IMPORTANT: trigger store load
  loadStores();
}
}

const loader_template = 
`
<div id="loader"
     class="items-center justify-center bg-black/80  z-50 transition-opacity dynamic-loader">
  <div class="w-10 h-10 border-2 border-white/10 border-t-indigo-500 rounded-full spin"></div>
</div>

`
const content_template = 
`<div class="glow-animation text-xs">Loading info...</div>

`;

const closePanelButtonTemplate = `
  <div class="sticky bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/90 to-transparent backdrop-blur-md">
    <button id="closeVendorPanelBtn"
            class="w-full py-2 rounded-xl
                   bg-indigo-500/10 hover:bg-indigo-500/20
                   border border-indigo-400/20
                   text-indigo-200 hover:text-white
                   shadow-[0_0_12px_rgba(99,102,241,0.15)]
                   transition-all duration-200">
      Close Panel
    </button>
  </div>
`;

const noProductsFound =  `
  <div class="flex flex-col items-center justify-center py-12 text-center text-white/70">
    
    <div class="w-14 h-14 rounded-full bg-white/5 flex items-center justify-center mb-3">
      <svg xmlns="http://www.w3.org/2000/svg" class="w-7 h-7 text-white/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 13V7a2 2 0 00-2-2h-4l-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2h6" />
      </svg>
    </div>

    <h2 class="text-lg font-semibold text-white/80">No Products Found</h2>
    
    <p class="text-sm text-white/50 mt-1 max-w-xs">
      We couldn’t find any products in this section right now.
    </p>

    <button class="mt-4 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm text-white/80 transition refresh-btn">
      Refresh
    </button>

  </div>
`;


const noStoresFound = `
  <div class="flex flex-col items-center justify-center py-14 text-center text-white/70">

    <div class="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
      <svg xmlns="http://www.w3.org/2000/svg" class="w-8 h-8 text-white/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" />
      </svg>
    </div>

    <h2 class="text-lg font-semibold text-white/80">No Stores Found</h2>

    <p class="text-sm text-white/50 mt-1 max-w-xs">
      There are no registered stores yet. New vendors will appear here once they join the platform.
    </p>

    <button class="mt-4 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm text-white/80 transition refresh-btn">
      Refresh
    </button>

  </div>
`;
function getVerifiedBadge(isVerified) {
  return `
    <span class="text-[10px] px-2 py-1 rounded-full border
      ${isVerified 
        ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.15)]"
        : "border-yellow-400/40 bg-yellow-500/10 text-yellow-300 shadow-[0_0_10px_rgba(234,179,8,0.15)]"
      }">
      ${isVerified ? "✓ Verified" : "Unverified"}
    </span>
  `;
}

function renderStores(view , vendors) {    
     if (!Array.isArray(vendors) || vendors.length === 0) {
    view.innerHTML = noStoresFound;
    return;
  }
  for (let i = 0; i < vendors.length; i++) {
    
    let vendor = vendors[i]
    let vendor_id = vendor.vendor_id;
    let img = vendor.image;
    let storename = vendor.storeName
    let store_description = vendor.storeDescription;
    let isVerified = vendor.emailVerified;
    const card = document.createElement("div");

   card.className =
      "fade-up group bg-white/5 backdrop-blur-lg rounded-2xl overflow-hidden border border-white/10 hover:scale-[1.02] transition-all duration-300 w-full max-w-[260px] mx-auto";

    card.style.animationDelay = (i * 0.05) + "s";

    card.innerHTML = `

      <!-- BANNER -->
      <div class="relative w-full h-28 md:h-32 overflow-hidden">
        <img src="${img}"
             class="w-full h-full object-cover transform group-hover:scale-110 transition-transform duration-700 ease-out"/>
      </div>

      <!-- CONTENT -->
      <div class="p-3 space-y-2">

        <!-- STORE NAME -->
        <h3 class="text-sm md:text-base font-semibold truncate">
          ${storename}
        </h3>

        <div class="flex items-center gap-2 mt-2 text-xs text-white/70">
      <span id="rating-${vendor_id}">Loading ⭐</span>
      </div>
        <!-- DESCRIPTION -->
        <p class="text-xs text-gray-400 line-clamp-2">
          ${store_description}
        </p>

       <!-- ACTIONS -->
<div class="flex items-center justify-between gap-2 pt-1">

  <!-- VIEW STORE -->
  <button class="text-xs text-blue-400 hover:underline viewStoreBtn"
          data-vendor-id="${vendor_id}">
    View Store
  </button>

  <button
  class="text-[11px] px-2 py-1 rounded-md bg-yellow-500/10 border border-yellow-400/20 hover:bg-yellow-500/20 transition rate-vendor-btn"
  data-vendor-id="${vendor_id}">
  Rate
</button>

  <div class="flex items-center gap-2">

    <!-- ABOUT STORE -->
    <button class="text-[11px] px-2 py-1 rounded-md bg-white/5 border border-white/10 hover:bg-white/10 transition aboutStoreBtn"
            data-vendor-id="${vendor_id}" data-vendor-rating="">
      About
    </button>

    <!-- VERIFIED BADGE (always visible, changes style if not verified later) -->
    ${getVerifiedBadge(isVerified)}

  </div>

</div>

      </div>
    `;

    view.appendChild(card);
  }

  attachStoreEvents();
}

async function getProduct(product_id){
let docSnap =  await getDoc(doc(db, "products", product_id));
if (!docSnap.exists()) {
  console.warn("Product not found: " + product_id);
  return null;
}
else {
  return docSnap.data();
}
}

const pending_cart =[];
const cart =[];

window.POST_ACTIONS = []

window.getTotalCartCost = () => {
  return cart.reduce((total, item) => {
    const price = parseFloat(item.price) || 0;
    const quantity = parseInt(item.quantity) || 1;
    return total + price * quantity;
  }, 0);
};

//example of a post action that runs after login/signup to add pending cart items to the user's cart in Firestore
let updateCartAction = {
  event_id : "evCartUpdate" , // unique id for this action (used for tracking and debugging)
  after_event : "Authentication",
  purpose : "add to cart",
  action : async function(){
    for (let index = 0; index < pending_cart.length; index++) {
      const element = pending_cart[index];
      let product_id = element.product_id;
      let product = await getProduct(product_id);

      
      if(product){
        if(auth.currentUser.uid && element.vendor_id){
          product.quantity = element.quantity || 1;
         cart.push(product);
       try{
         let cart1 = { 
          product_id: product_id,
          vendor_id: product.vendor_id,
          clientId: auth.currentUser.uid,
          price: product.price || 0,
          quantity:  1
        }
         await setDoc(doc(db, "carts", auth.currentUser.uid), {
         clientId: auth.currentUser.uid, 
         carts : [cart1]
        } , { merge: true });
        pending_cart.splice(index,1);
       window.updateCart(window.getCartCount(), window.getTotalCartCost());
      }
       catch(e){
        console.warn("Failed to add pending cart item to Firestore cart: " , e);
      }
      }
    }
    }
  }
}

let createClientFromVendor = {
  event_id : "evCreateClientFromVendor" , // unique id for this action (used for tracking)
  after_event : "Authentication",
  purpose : "create a client account from vendor account after authentication",
  action : async function(){
      let userID = auth.currentUser.uid;
      if(userID){
       let vendor = await getVendorByUserID(userID)
       if(vendor){
        let username = vendor.storeName + " Client";
        let email = auth.currentUser.email;
        let location = vendor.address.state || "Unknown";
        let phone = vendor.phone || "N/A";
        try{
        await setDoc(doc(db, "clients", userID), {
          user_id: userID,
          first_name: suggested_username || username,
          second_name: "",
          email: email,
          location: location,
          phone: phone
        });
      }catch(e){
        console.warn(e)
      }
       }
      }
  }
}





function activateVendorListening(){  
  document.querySelectorAll('.view-vendor-info').forEach(btn => {
    btn.onclick = () => {
      let vendorId = btn.getAttribute('data-vendor-id');
      let vendorRatings = btn.getAttribute('data-vendor-rating');

      
      openVendorPanel(vendorId ,vendorRatings)
    };
  })

document.querySelectorAll('#add-to-cart').forEach(btn => {
  btn.addEventListener('click', async() => {

    
    const product_id = btn.getAttribute('product-id');
    window.showLoadingDots("Getting product details...")
    const product = await getProduct(product_id);
    let vendor_id = btn.getAttribute('vendor-id')
    
    let vendor = VendorService.vendorsMap[vendor_id]
  

    if(!vendor){
      window.showLoadingDots("Getting vendor details...")
      vendor = await getVendor(vendor_id)
    }   

    
  
    if (!product){window.showNotif({ type: "error", title: "Product not found", message: "The selected product could not be found." }); window.hideLoadingDots(); return;}
   
    //add to cart logic here (create cart item in Firestore, or update local state, etc.)
  window.showLoadingDots("Working...")    
  let userRole = await getCurrentUserRole();

  if (!userRole) {
    window.hideLoadingDots();
  pending_cart.push({ product_id, vendor_id });
  window.POST_ACTIONS.push(updateCartAction);
  window.showDialog({
  type:    "warn",
  emoji:   "✖️",
  tag:     "No Account",
  title:   "You're not logged in",
  message: "you are not currently logged in. you will need an account to place orders.",
  actions: [
    {
      label: "Create Client Account",
      style: "primary",
      onClick: () => {
      window.openAuthModal("signup");
      }
    },
    {
      label: "Log in with an existing account",
      style: "secondary",
      onClick: () => {
        window.openAuthModal("login");
      }
    },
    {
      label: "Cancel",
      style: "danger",
      onClick: () => {} // just closes
    }
  ]
})

  }

else if (userRole === "client") {
  try {
    let userCartRef = doc(db, "carts", auth.currentUser.uid);
    let userCartSnap = await getDoc(userCartRef);
    let price = product.price || 0;

    let newItem = {
      product_id: product_id,
      vendor_id: vendor_id,
      clientId: auth.currentUser.uid,
      price: price,
      quantity: 1
    };

    if (userCartSnap.exists()) {
      window.showLoadingDots("Updating cart...");
      let existingCart = userCartSnap.data().carts || [];
      let existingIndex = existingCart.findIndex(item => item.product_id === product_id);

      if (existingIndex !== -1) {
        // increment quantity in Firestore
        existingCart[existingIndex].quantity += 1;
        await updateDoc(userCartRef, { carts: existingCart });

        // increment quantity in local cart too
        const localIndex = cart.findIndex(c => c.product_id === product_id);
        if (localIndex !== -1) {
          cart[localIndex].quantity += 1;
        }
    
      } else {
        // new item → add to Firestore and local cart
        existingCart.push(newItem);
        await updateDoc(userCartRef, { carts: existingCart });
        product.quantity = 1;
        cart.push(product);
      }

    } else {
      window.showLoadingDots("Creating cart...");
      // no cart yet → create it
      await setDoc(userCartRef, {
        clientId: auth.currentUser.uid,
        carts: [newItem]
      });
      product.quantity = 1;
      cart.push(product);
    }
   window.showLoadingDots("Finalizing...");
   window.updateCart(window.getCartCount(), window.getTotalCartCost());
    setTimeout(() => {
      window.showLoadingDots("Added to cart!");
      window.showNotif({ type: "success", title: "Added to Cart", message: `${product.name} has been added to your cart.` });
    }, 500);
    setTimeout(() => {
      window.hideLoadingDots();
    }, 1000);
  } catch (e) {
    console.warn("Failed to update cart:", e);
    showNotif({ type: "error", title: "Cart Update Failed", message: "There was an issue adding the product to your cart. Please try again." });
    window.hideLoadingDots();
  }
}

else if(userRole === "vendor"){
  showNotif({ type: "error", title: "Action not allowed", message: "Vendors cannot place orders. Please create a client account to shop." });
  window.showLoadingDots("Waiting for client Authentication...");
  pending_cart.push({ product_id, vendor_id });
  window.POST_ACTIONS.push(updateCartAction);
  window.openAuthModal("signup");
}

    
  });
});
}

function attachVendorPanelClose() {
  const btn = document.getElementById("closeVendorPanelBtn");

  if (!btn) return;

  btn.onclick = () => {
    // DESKTOP
    vendorPanel.classList.remove("show-wide-screen-vendor-info-panel");

    // MOBILE
    const modal = document.getElementById("vendorMobileModal");
    if (!modal.classList.contains("hidden")) {
      closeModal();
    }
  };
}

btnProducts.forEach(btn => {
  btn.onclick = () => setActive("products");
});

btnStores.forEach(btn => {
  btn.onclick = () => setActive("stores");
});



// OPEN PANEL
async function openVendorPanel(vendorId , rating=null) {
  
  const isDesktop = window.matchMedia("(min-width: 768px)").matches;

  
let vendor = VendorService.vendorsMap[vendorId];
  
  if (!vendor) {
   try {
    
const vendorSnap = await getDoc(doc(db, "vendors", vendorId));

if (!vendorSnap.exists()) {
  console.warn("Vendor not found");
  return;
}

vendor = vendorSnap.data();

const vendor_store = vendor.vendor_id || vendorSnap.id;

VendorService.vendorsMap[vendor_store] = vendor
 if (!VendorService.vendorsList.some(v => v.vendor_id === vendorId)) {  
    VendorService.vendorsList.push(vendor);
  }
}

   catch(e){
    console.warn(e)
    return;
   }
  
  }

  if (isDesktop) {
    // ===== DESKTOP PANEL =====
    vendorPanel.classList.add('show-wide-screen-vendor-info-panel');
    vendorPanel.classList.add("loading-state");

    vendorPanel.innerHTML = loader_template;

    setTimeout(() => {
  vendorPanel.classList.remove("loading-state");

  vendorPanel.innerHTML =
    getVendorContent(vendor , rating) + closePanelButtonTemplate;

  attachVendorPanelClose();
}, 400);


  } // ===== MOBILE MODAL =====
else {
  const modal = document.getElementById("vendorMobileModal");
  const modalContentWrapper = modal.querySelector(".p-4.space-y-4");

modal.classList.remove("hidden");

// reset starting state (IMPORTANT)
modal.classList.add("opacity-0", "scale-95");
modal.classList.remove("opacity-100", "scale-100");

// force reflow so transition always triggers
modal.offsetHeight;

// trigger animation
modal.classList.remove("opacity-0", "scale-95");
modal.classList.add("opacity-100", "scale-100");


  // loading state
  modalContentWrapper.innerHTML = `
    <div class="flex justify-center py-10">
      <div class="w-8 h-8 border-2 border-white/10 border-t-indigo-500 rounded-full spin"></div>
    </div>
  `;
setTimeout(() => {
  modalContent.innerHTML =
  getVendorContent(vendor , rating);

  attachVendorPanelClose();
}, 400);
}
}

function vendorVerified(status){
 if (status) {
  return '<span class="text-green-400 text-sm font-medium">Verified</span>';
} else {
  return '<span class="text-orange-400 text-sm font-medium">Unverified</span>';
}
}


function getVendorContent(vendor , rating=null) {

  return `
    <div class="p-4 space-y-5 fade-switch show">

      <!-- IMAGE -->
      <div class="w-full h-40 rounded-xl overflow-hidden bg-white/5">
        <img src="${vendor.image}" class="w-full h-full object-cover"/>
      </div>

      <!-- BASIC INFO -->
      <div>
        <h2 class="text-lg font-semibold">${vendor.storeName}</h2>
        <p class="text-sm text-white/60 mt-1">
          ${vendor.storeDescription}
        </p>
      </div>

      <!-- OWNER -->
      ${vendor.ownerDescriprion ? `
        <div>
          <h3 class="text-xs text-white/40 mb-1">Owner</h3>
          <p class="text-xs text-white/70">${vendor.ownerDescriprion}</p>
        </div>
      ` : ""}
      <div class="space-y-2 pb-3">
        <h3 class="text-xs text-white/40">Vendor Verification</h3>
        ${infoRow("Status " , vendorVerified(vendor.emailVerified))}

      </div>
        <div class="space-y-2 pb-3">
        <h3 class="text-xs text-white/40" id="about_rating">Vendor Rating</h3>
        ${infoRow("Rating ⭐" , rating || "unable to get")}
      </div>

      <!-- DELIVERY -->
      <div class="space-y-2">
  <h3 class="text-xs text-white/40">Delivery</h3>

  <div class="bg-white/5 rounded-lg p-3">
    ${getDeliveryInfo(vendor.delivery)}
  </div>

</div>

      <!-- STORE DETAILS -->
      <div class="space-y-2">
        <h3 class="text-xs text-white/40">Store Details</h3>

        ${infoRow("Category", vendor.category)}
        ${infoRow("Currency", vendor.currency)}
        ${infoRow("Payout", vendor.payoutMethod)}
        ${infoRow("Phone", vendor.phone)}
        ${infoRow("Email", vendor.email)}

      </div>

      <!-- PHYSICAL STORE -->
      <div class="space-y-2">
        <h3 class="text-xs text-white/40">Location</h3>

        ${
          vendor.hasPhysicalStore && vendor.address
            ? `
              ${infoRow("Street", vendor.address.street)}
              ${infoRow("City", vendor.address.city)}
              ${infoRow("Country", vendor.address.country)}
              ${infoRow("Apartment", vendor.address.building || "Not Provided")}
              ${infoRow("State", vendor.address.state || "Not Provided")}
              ${infoRow("Postal Code", vendor.address.postalCode || "Not Provided")}
             
            `
            : `<span class="text-xs text-white/30">No physical store</span>`
        }
      </div>

    </div>
  `;

}

async function addRatingToPanel(ID){
 
    let rating = getVendorRating(ID);
    document.getElementById('about_rating').innerHTML = rating;
}


function getAllProducts() {
  products.forEach(product => {
  productsMap[product.product_id] = product;
});
  return Promise.resolve(products);
}


async function getVendor(vendor_id = null){
  let vendor = null;
  if(!vendor_id) return;
  
  try{ 
  let data =  await getDoc(doc(db ,'vendors' , vendor_id));   vendor = data.data()} catch(e){console.warn(e)}
  return vendor
}





function infoRow(label, value) {
  if (!value) return "";

  return `
    <div class="flex justify-between text-xs border-b border-white/5 pb-1">
      <span class="text-white/40">${label}</span>
      <span class="text-white/80 text-right max-w-[60%] truncate">${value}</span>
    </div>
  `;
}



function getDeliveryInfo(delivery) {

  
  if (!delivery || !delivery.enabled) {
    return `<span class="text-xs text-white/30">Delivery not available</span>`;
  }

  let typeLabel = "";
  let feeText = "";

  // TYPE
  if (delivery.mode === "static") {
    typeLabel = "Standard Delivery";
    feeText = `KES ${delivery.fee}`;
  } 
  else if (delivery.mode === "dynamic") {
    typeLabel = "Dynamic Delivery";
    feeText = `Starts from KES ${delivery.fee}`;
  } 
  else {
    typeLabel = "Unknown";
    feeText = "-";
  }

  return `
    <div class="text-xs text-white/70 space-y-1">
      ${infoRow("Type", typeLabel)}
      ${infoRow("Fee", feeText)}
      ${infoRow("Mode", delivery.mode)}
    </div>
  `;
}
// CLOSE PANEL
window.addEventListener("resize", () => {
  const isDesktop = window.matchMedia("(min-width: 768px)").matches;
  const modal = document.getElementById("vendorMobileModal");

  if (isDesktop) {
    modal.classList.add("hidden");
  } else {
    vendorPanel.classList.remove("show-wide-screen-vendor-info-panel");
  }
});
// EVENTS


const modal = document.getElementById("vendorMobileModal");
const closeModalBtn = document.getElementById("close-less-width-screen-modal");

closeModalBtn.onclick = () => {
  modal.classList.add("hidden");
};


function closeModal() {

  modal.classList.remove("opacity-100", "scale-100");
  modal.classList.add("opacity-0", "scale-95");

  setTimeout(() => {
    modal.classList.add("hidden");
  }, 200); // match duration
}

closeModalBtn.onclick = closeModal;

modal.onclick = (e) => {
  if (e.target === modal) closeModal();
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

function attachStoreEvents() {
  document.querySelectorAll(".aboutStoreBtn").forEach(btn => {

    btn.onclick = () => {openVendorPanel(btn.dataset.vendorId , btn.getAttribute('data-vendor-rating'), )};
  });

document.querySelectorAll(".viewStoreBtn").forEach(btn => {
btn.onclick = async() => {
  const vendorId = btn.dataset.vendorId;
  activeVendorFilter = vendorId;

  // clear search so it doesn't interfere with vendor filter
  searchInput.value = "";
  clearSearch.classList.add("hidden");
  searchResultsBadge.classList.add("hidden");
  activeTab = "products"; // 👈 add this

  setActive("products");
  loadProducts("vendor", vendorId);
  await incrementVisitors(vendorId);
  showBackToAllButton();
};
  });

  document.querySelectorAll('.rate-vendor-btn').forEach(btn=>{
    btn.addEventListener('click' , async()=>{
      let vendor_id = btn.getAttribute('data-vendor-id');
      openRatingModal(
      "vendor",
      getGuestId(),
       vendor_id
    );
      
      
    })
  })
}


async function incrementVisitors(vendorId) {
  try{
  await updateDoc(doc(db ,"vendorVisitors" , vendorId) , {"visitors" : increment(1)})
  }catch(e){
    console.warn("update failed!")
  }
}

function showBackToAllButton() {

  if (document.getElementById("resetProductsBtn")) return;

  const btn = document.createElement("button");

  btn.id = "resetProductsBtn";

  btn.className = `
    floating-back-btn
    fixed bottom-5 left-1/2 -translate-x-1/2
    px-5 py-2 rounded-full
    bg-indigo-500 hover:bg-indigo-600
    text-white text-sm font-semibold
    shadow-lg z-50
    transition-all duration-300
  `;

  btn.innerText = "Back to all products";

btn.onclick = () => {
    activeVendorFilter = null;

    // clear search on reset too
    searchInput.value = "";
    clearSearch.classList.add("hidden");
    searchResultsBadge.classList.add("hidden");

    btn.remove();
    setActive("products");
    loadProducts("all");
  };

  document.body.appendChild(btn);
}




document.addEventListener("click", (e) => {
  if (e.target.classList.contains("refresh-btn")) {
    location.reload();
  }
});

// =========================
// RATING STATE
// =========================
let ratingContext = {
  type: null, // "product" | "vendor"
  id: null,
  vendorId: null,
  rating: 0
};

const ratingModal = document.getElementById("ratingModal");
const ratingTitle = document.getElementById("ratingTitle");
const stars = document.querySelectorAll(".star");
const reviewBox = document.getElementById("ratingReview");

// =========================
// OPEN MODAL
function openRatingModal(type, id, vendorId = null) {
  ratingContext = { type, id, vendorId, rating: 0 };

  ratingTitle.textContent =
    type === "product" ? "Rate Product" : "Rate Store";

  reviewBox.value = "";
  resetStars();

  // Show backdrop + card
  ratingModal.classList.add("visible");

  const card = ratingModal.querySelector("div");
  card.classList.remove("modal-exit");
  card.classList.add("modal-enter");
}

function closeRatingModal() {
  const card = ratingModal.querySelector("div");
  card.classList.remove("modal-enter");
  card.classList.add("modal-exit");

  // Fade out backdrop at the same time
  ratingModal.classList.remove("visible");

  // Wait for card animation before fully hiding (optional but clean)
  card.addEventListener("animationend", () => {
    // nothing needed — opacity:0 + pointer-events:none is enough
  }, { once: true });
}



// =========================
// STAR SELECT
// =========================
stars.forEach(star => {
  star.addEventListener("click", () => {
    const value = parseInt(star.dataset.value);
    ratingContext.rating = value;
    updateStars(value);
  });
});

function updateStars(value) {
  stars.forEach(star => {
    const starValue = parseInt(star.dataset.value);

    if (starValue <= value) {
      star.textContent = "★";
      star.classList.add("text-yellow-400");
      star.classList.remove("text-white/40");
    } else {
      star.textContent = "☆";
      star.classList.add("text-white/40");
      star.classList.remove("text-yellow-400");
    }
  });
}
function resetStars() {
  stars.forEach(star => {
    star.textContent = "☆";
    star.classList.remove("text-yellow-400");
    star.classList.add("text-white/40");
  });
}

// =========================
// BUTTON EVENTS (PRODUCTS)
// =========================
document.addEventListener("click", (e) => {

  // PRODUCT RATING
  if (e.target.classList.contains("rate-product-btn")) {
    openRatingModal(
      "product",
      e.target.dataset.productId,
      e.target.dataset.vendorId
    );
  }

  // VENDOR RATING
  if (e.target.classList.contains("rate-vendor-btn")) {
  
   
  }
});

// =========================
// CLOSE MODAL EVENTS
// =========================
document.getElementById("closeRatingModal")
  .addEventListener("click", closeRatingModal);

ratingModal.addEventListener("click", (e) => {
  if (e.target === ratingModal) closeRatingModal();
});

function getGuestId() {
  let id = localStorage.getItem("gmarketfy_guest_id");

  if (!id) {
    id = crypto.randomUUID(); // modern browser-safe unique ID
    localStorage.setItem("gmarketfy_guest_id", id);
  }

  return id;
}

document.getElementById("submitRating").addEventListener("click", async () => {
  if (ratingContext.rating === 0) {
    window.showNotif({ type: "error", title: "Invalid Rating", message: "Please select a rating" });
    return;
  }


 const payload = {
  targetId: ratingContext.id,
  targetType: ratingContext.type,
  vendorId: ratingContext.vendorId || null,
  rating: ratingContext.rating,
  review: reviewBox.value.trim(),
  createdAt: Timestamp.now(),
  username: auth.currentUser ? auth.currentUser.displayName || "Anonymous" : "Guest",
};
    
  try {

    await submitRating(payload);
    closeRatingModal();
    window.showNotif({ type: "success", title: "Rating Submitted", message: "Thanks for your feedback!" });
  } catch (err) {
    console.error(err);
    window.showNotif({ type: "error", title: "Rating Failed", message: err.message || "An error occurred while submitting your rating. Please try again." });
  }
    
  
});



async function updateVendorRating(vendorId, newRating) {
  const ref = doc(db, "vendorStats", vendorId);
  const snap = await getDoc(ref);

  let rating = {
    average: 0,
    totalRatings: 0,
    breakdown: { 1:0, 2:0, 3:0, 4:0, 5:0 }
  };

  // ✅ merge existing data safely
  if (snap.exists()) {
    const data = snap.data();

    if (data.rating) {
      rating = {
        average: data.rating.average || 0,
        totalRatings: data.rating.totalRatings || 0,
        breakdown: data.rating.breakdown || rating.breakdown
      };
    }
  }

  // 🔥 ensure key exists
  if (!rating.breakdown[newRating]) {
    rating.breakdown[newRating] = 0;
  }

  rating.breakdown[newRating]++;

  rating.totalRatings++;

  // recompute average
  let totalScore = 0;
  let totalCount = 0;

  for (let i = 1; i <= 5; i++) {
    totalScore += (rating.breakdown[i] || 0) * i;
    totalCount += (rating.breakdown[i] || 0);
  }

  rating.average = totalCount ? totalScore / totalCount : 0;

  await updateDoc(ref, {
    rating,
    updatedAt: Timestamp.now()
  });
}



async function updateProductRating(productId, newRating) {
  const ref = doc(db, "productStats", productId);
  const snap = await getDoc(ref);

  let rating = {
    average: 0,
    totalRatings: 0,
    breakdown: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  };

  // =========================
  // MERGE EXISTING DATA
  // =========================
  if (snap.exists()) {
    const data = snap.data();

    if (data.rating) {
rating = {
  average: data.rating.average || 0,
  totalRatings: data.rating.totalRatings || 0,
  breakdown: {
    1: data.rating.breakdown?.[1] || 0,
    2: data.rating.breakdown?.[2] || 0,
    3: data.rating.breakdown?.[3] || 0,
    4: data.rating.breakdown?.[4] || 0,
    5: data.rating.breakdown?.[5] || 0
  }
};
    }
  }

  // =========================
  // UPDATE BREAKDOWN
  // =========================
  if (!rating.breakdown[newRating]) {
    rating.breakdown[newRating] = 0;
  }

  rating.breakdown[newRating]++;

  rating.totalRatings++;

  // =========================
  // RECALCULATE AVERAGE
  // =========================
  let totalScore = 0;
  let totalCount = 0;

  for (let i = 1; i <= 5; i++) {
    const count = rating.breakdown[i] || 0;
    totalScore += count * i;
    totalCount += count;
  }

  rating.average = totalCount ? totalScore / totalCount : 0;

  // =========================
  // SAVE BACK
  // =========================
  await updateDoc(ref, {
    rating,
    updatedAt: Timestamp.now()
  });
}

async function submitRating(payload) {
  window.showLoadingDots("Submitting your rating...");
  const { targetId, targetType } = payload;

  // =========================
  // STEP 1: AUTH CHECK
  // =========================
  const user = auth.currentUser;

  if (!user) {
    window.showLoadingDots("Waiting for Authentication...");
    let rateItemAfterAuthentication = {
  event_id : "evRateItem" , // unique id for this action (used for tracking)
  after_event : "Authentication",
  purpose : "rate a product or vendor after authentication",
  action : async function(){
      let userID = auth.currentUser.uid;
      if(userID){
       let data = payload;
        submitRating(data);
       }
      }
  }


    window.showDialog({
      type: "warn",
      emoji: "🔐",
      tag: "Not Logged In",
      title: "Hold up!",
      message: `You need to be logged in to rate a ${targetType}. Create an account or log in to share your experience!`,
      actions: [
        {
          label: "Log In",
          style: "primary",
          onClick: () => {window.openAuthModal("login"); closeRatingModal(); window.POST_ACTIONS.push(rateItemAfterAuthentication);}
        },
        {
          label: "Create Account",
          style: "secondary",
          onClick: () => {window.openAuthModal("signup"); closeRatingModal(); window.POST_ACTIONS.push(rateItemAfterAuthentication);}
        },
        {
          label: "Maybe Later",
          style: "danger",
          onClick: () => {closeRatingModal(); window.hideLoadingDots();}
        }
      ]
    });
    throw new Error("User not authenticated");
  }


  // =========================
  // STEP 2: ANTI-SPAM CHECK
  // =========================
  const q = query(
    collection(db, "ratings"),
    where("userId", "==", user.uid),
    where("targetId", "==", targetId),
    where("targetType", "==", targetType)
  );

  const snap = await getDocs(q);

  if (!snap.empty) {
    window.showDialog({
      type: "warn",
      emoji: "⭐",
      tag: "Already Rated",
      title: "You've rated this before!",
      message: `You've already dropped a rating on this ${targetType}. We only allow one rating per ${targetType} to keep things fair 🙏`,
      actions: [
        {
          label: "Got it",
          style: "primary",
          onClick: () => {closeRatingModal();}
        }
      ]
    });
    throw new Error("You already rated this item");
    window.hideLoadingDots();
  }

  // =========================
  // STEP 3: WRITE RATING
  // =========================
  await addDoc(collection(db, "ratings"), {
    ...payload,
    userId: user.uid,   // 🔑 use auth uid instead of guestId
    guestId: null,      // clear the old guestId
    createdAt: Timestamp.now()
  });

  // =========================
  // STEP 4: ROUTE UPDATE
  // =========================
  if (targetType === "vendor") {
    await updateVendorRating(ratingContext.vendorId, payload.rating);
    window.hideLoadingDots();
  }

  if (targetType === "product") {
    await updateProductRating(targetId, payload.rating);
    updateUIforRating(targetId, payload.rating);
    window.hideLoadingDots();
  }
};



async function getVendorRating(vendorId) {
  try {
    const snap = await getDoc(doc(db, "vendorStats", vendorId));

    if (!snap.exists()) {
      return { average: 0, totalRatings: 0 };
    }

    const data = snap.data()?.rating;

    return {
      average: data?.average || 0,
      totalRatings: data?.totalRatings || 0
    };

  } catch (err) {
    console.warn("rating fetch failed:", err);
    return { average: 0, totalRatings: 0 };
  }
}

async function getProductRating(productid) {try {
  const snap = await getDoc(doc(db, "productStats", productid));

  if (!snap.exists()) {
    return { average: 0, totalRatings: 0 };
  }

  const data = snap.data();
  const rating = data?.rating || {};
  return {
    average: rating.average ?? 0,
    totalRatings: rating.totalRatings ?? 0
  };

} catch (err) {
  console.warn("rating fetch failed:", err);
  return { average: 0, totalRatings: 0 };
}}


async function openProductModal(product) {


  const modal = document.getElementById("productModal");
  const content = document.getElementById("productModalContent");

  // Fill data
  document.getElementById("modalImage").src = product.image;
  document.getElementById("modalName").textContent = product.name;
  document.getElementById("modalCategory").textContent = "Category  :  " + product.category || "No category";
  document.getElementById("modalPrice").textContent = "Price  :  " + `${product.currency} ${product.price}`;
  document.getElementById("modalStock").textContent = `In Stock   :   ${product.stock}`;
  document.getElementById("modalDescription").textContent = "Description   :   " + product.description || "No description";

  // Show modal
  modal.classList.remove("opacity-0", "pointer-events-none");

  // Animate in
  setTimeout(() => {
    content.classList.remove("scale-90", "opacity-0");
    content.classList.add("scale-100", "opacity-100");
  }, 10);

  
try {
    const productStatsRef = doc(db, "productStats", product.product_id);

    await updateDoc(productStatsRef, {
      "metrics.totalViews": increment(1),
      updatedAt: serverTimestamp()
    });

  } catch (e) {
    console.error("View update failed:", e);
  }

  await loadProductReviews(product.product_id);
}


document.getElementById("closeProductModal").addEventListener("click", () => {
 closeProductModal();
});

const productModal = document.getElementById("productModal");
const content = document.getElementById("productModalContent");

productModal.addEventListener("click", (e) => {
  // if click is OUTSIDE the content box
  if (!content.contains(e.target)) {
    closeProductModal();
  }
});


productModal.addEventListener("wheel", (e) => {

  // if scroll happened inside modal content → ignore
  if (content.contains(e.target)) return;

  closeProductModal();
}, { passive: true });

function closeProductModal() {

  const modal = document.getElementById("productModal");
  const content = document.getElementById("productModalContent");

  content.classList.remove("scale-100", "opacity-100", "translate-y-0");
  content.classList.add("scale-90", "opacity-0", "translate-y-6");

  setTimeout(() => {
    modal.classList.add("opacity-0", "pointer-events-none");
  }, 200);
}


// =========================
// SEARCH FEATURE
// =========================

const searchInput = document.getElementById("searchInput");
const clearSearch = document.getElementById("clearSearch");
const searchResultsBadge = document.getElementById("searchResultsBadge");

let searchDebounceTimer = null;
let activeTab = "products"; // track which tab we're on

// Track tab switches to reset search
const originalSetActive = setActive;
// (wrap setActive to track active tab)
btnProducts.forEach(btn => {
  btn.addEventListener("click", () => {
    activeTab = "products";
    if (searchInput.value.trim()) runSearch(searchInput.value.trim());
  });
});
btnStores.forEach(btn => {
  btn.addEventListener("click", () => {
    activeTab = "stores";
    if (searchInput.value.trim()) runSearch(searchInput.value.trim());
  });
});

// Live search on input
searchInput.addEventListener("input", () => {
  const query = searchInput.value.trim();

  // show/hide clear button
  clearSearch.classList.toggle("hidden", query.length === 0);

  clearTimeout(searchDebounceTimer);

  if (query.length === 0) {
    clearSearchResults();
    return;
  }

  // debounce 200ms for snappy but not jittery feel
  searchDebounceTimer = setTimeout(() => {
    runSearch(query);
  }, 200);
});

// Clear button
clearSearch.addEventListener("click", () => {
  searchInput.value = "";
  clearSearch.classList.add("hidden");
  clearSearchResults();
  searchInput.focus();
});

function runSearch(query) {
  const q = query.toLowerCase();

  if (activeTab === "products") {
    searchProducts(q);
  } else {
    searchStores(q);
  }
}

function searchProducts(q) {
  const results = ProductService.productsList.filter(p => {
    return (
      (p.name && p.name.toLowerCase().includes(q)) ||
      (p.category && p.category.toLowerCase().includes(q)) ||
      (p.description && p.description.toLowerCase().includes(q))
    );
  });

  clearGrid(productsView);

  if (results.length === 0) {
    productsView.innerHTML = `
      <div class="flex flex-col items-center justify-center py-12 text-center text-white/70 col-span-full">
        <div class="w-14 h-14 rounded-full bg-white/5 flex items-center justify-center mb-3">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-7 h-7 text-white/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"/>
          </svg>
        </div>
        <h2 class="text-base font-semibold text-white/80">No products found</h2>
        <p class="text-sm text-white/40 mt-1">Try a different keyword</p>
      </div>
    `;
    showBadge(0, "products");
  } else {
    renderProducts(productsView, results);
    showBadge(results.length, "products");
  }
}

function searchStores(q) {
  const results = VendorService.vendorsList.filter(v => {
    return (
      (v.storeName && v.storeName.toLowerCase().includes(q)) ||
      (v.storeDescription && v.storeDescription.toLowerCase().includes(q)) ||
      (v.category && v.category.toLowerCase().includes(q))
    );
  });

  clearGrid(storesView);

  if (results.length === 0) {
    storesView.innerHTML = `
      <div class="flex flex-col items-center justify-center py-12 text-center text-white/70 col-span-full">
        <div class="w-14 h-14 rounded-full bg-white/5 flex items-center justify-center mb-3">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-7 h-7 text-white/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"/>
          </svg>
        </div>
        <h2 class="text-base font-semibold text-white/80">No stores found</h2>
        <p class="text-sm text-white/40 mt-1">Try a different keyword</p>
      </div>
    `;
    showBadge(0, "stores");
  } else {
    renderStores(storesView, results);
    showBadge(results.length, "stores");
  }
}

function showBadge(count, type) {
  searchResultsBadge.classList.remove("hidden");
  searchResultsBadge.textContent = count === 0
    ? `No ${type} matched`
    : `${count} ${type} found`;
}

function clearSearchResults() {
  searchResultsBadge.classList.add("hidden");

  // restore full list for whichever tab is active
  if (activeTab === "products") {
    clearGrid(productsView);
    renderProducts(productsView, ProductService.productsList);
  } else {
    clearGrid(storesView);
    renderStores(storesView, VendorService.vendorsList);
  }
}




async function getCurrentUserRole() {
  return new Promise((resolve) => {
    // 1. FAST PATH (cache)
    const cached = sessionStorage.getItem("usgressor_gmarketfy_user_roleer_role");
    if (JSON.parse(cached)) return resolve(JSON.parse(cached));

    // 2. AUTH LISTENER
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      unsubscribe(); // stop listening immediately

      if (!user) return resolve(null);

      try {
        // check client first (most common)
        const clientSnap = await getDoc(doc(db, "clients", user.uid));
        if (clientSnap.exists()) {
          sessionStorage.setItem("gressor_gmarketfy_user_role", "client");
          return resolve("client");
        }

        // then vendor
        const vendorSnap = await getDoc(doc(db, "vendors", user.uid));
        if (vendorSnap.exists()) {
          sessionStorage.setItem("gressor_gmarketfy_user_role", "vendor");
          return resolve("vendor");
        }

        return resolve(null);
      } catch (err) {
        console.warn("Role check failed:", err);
        return resolve(null);
      }
    });
  });
}

async function getClientByEmail(email) { 
  try {
    const q = query(
      collection(db, "clients"),
      where("email", "==", email),
      limit(1)
    );

    const snap = await getDocs(q);
console.log("snap is : " , snap );

    if (snap.empty) return null;

    return snap.docs[0].data();
  } catch (error) {
    console.error("Error fetching client by email:", error);
    return null;
  }
}

async function getVendorByEmail(email) {
  try {
    const q = query(
      collection(db, "vendors"),
      where("email", "==", email),
      limit(1)
    );

    const snap = await getDocs(q);

    if (snap.empty) return null;

    return snap.docs[0].data();
  } catch (error) {
    console.error("Error fetching vendor by email:", error);
    return null;
  }
}


async function getVendorByUserID(userID) {
  try {
    const ref = doc(db, "vendors", userID);
    const snap = await getDoc(ref);

    if (!snap.exists()) return null;

    return snap.data();
  } catch (error) {
    console.error("Error fetching vendor by userID:", error);
    return null;
  }
}

//activates the input section when user clicks the input holder
document.getElementById('searchBar').addEventListener('click' ,()=>{
  document.getElementById('searchInput').focus();
})

document.querySelector(".client-form").addEventListener("submit",  async(e)=> {
  e.preventDefault();

  const result = collectFormData();

  if (!result.ok) {
    // show each error as its own notification
    result.errors.forEach((msg, i) => {
      setTimeout(() => window.showNotif({ type: "error", message: msg }), i * 120);
    });
    return;
  }

  if (result.mode === "login") {
    let email = result.data.email;
    let password = result.data.password;
    let username = email.split("@")[0]; // get part before @ for display name
  
    window.showAuthProgress("Checking your credentials...", 30);
    let client = await getClientByEmail(email);

    if (!client) {
      window.showAuthProgress("Still checking...", 60);
      let vendor = await getVendorByEmail(email);     
      if (vendor) {username = vendor.storeName; vendorDetectionAfterMath(email , password , username); window.showAuthProgress("Done", 100); window.hideAuthProgress(); return;}
      else {
        window.showNotif({ type: "info", title: "Login failed", message: "No account found , create one" });
        window.openAuthModal("signup");
      return;
      }
    } else if(client) {
      window.showAuthProgress("Found your account...", 60);
      signInUser(email, password );
    }

  }

  else if (result.mode === "signup") {
    try{
      //for app fluidity first check if the email the user enters to register is already being used in nother client account,
      //if yes provide them with an option of loggin in using it (like how we handled log in)
      //and also if the email is registered by a vendor again ask them to use the same email to creat a client account
      //now if the email is neither registered by the vendor nor any client , now we can directly create a client account from the same email
      let email = result.data.email;
      let password = result.data.password;
      let username = result.data.firstName + " " + result.data.secondName;
      let phonenumber = result.data.phone;
      let countryCode = result.data.countryCode;
      let location = result.data.location;

      let clientObject = {
        email,
        username,
        phone: phonenumber,
        countryCode,
        location
      }

        window.showAuthProgress("Checking your email...", 30);
        let existingClient = await getClientByEmail(email);

        if (existingClient) {
          window.showAuthProgress("Email already in use...", 60);
          window.showNotif({ type: "info", title: "Email in use", message: "An account with this email already exists. Please log in." });
          window.openAuthModal("login");
          window.hideAuthProgress();
          return;
        }
        window.showAuthProgress("Still checking...", 80);
        let existingVendor = await getVendorByEmail(email);

        if (existingVendor) {
          window.showAuthProgress("Email already in use by a vendor...", 90);
          window.showDialog({
                    type:    "warn",
                    emoji:   "✖️",
                    tag:     "Email in Use",
                    title:   "Email already registered",
                    message: "This email is already associated with a vendor account. Would you like to use the same email to create a client account?",
                    actions: [
                      {
                        label: "Yes, use same email",
                        style: "primary",
                        onClick: () => {
                        suggested_username = username;
                        window.POST_ACTIONS.push(createClientFromVendor);
                        signInUser(email, password, username);
                        
                        }
                      },
                      {
                        label: "No - Use another email",
                        style: "secondary",
                        onClick: () => {
                          window.closeDialog();
                          window.openAuthModal("signup");
                        }
                      },
                      {
                        label: "Cancel",
                        style: "danger",
                        onClick: () => {} // just closes
                      }
                    ]
                  });
          window.hideAuthProgress();
          return;
        }
        else {
          window.showAuthProgress("Creating your account...", 90);
          await createClientAccount(email, password, clientObject);
          window.showAuthProgress("Done", 100);
          setTimeout(() => {
            window.hideAuthProgress();
            window.showNotif({ type: "success", title: "Account Created", message: "Your client account has been created , now finish setting it up!" });
          }, 500);
        }
      }catch(e){
        console.warn("Signup pre-check failed:", e);
        window.showNotif({ type: "error", title: "Error", message: "An error occurred while checking your email. Please try again." });
        window.hideAuthProgress();
        return;
      }

  }

}
);

async function createClientAccount(email, password, clientObject) {
  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    await setDoc(doc(db, "clients", user.uid), {
          user_id: user.uid,
          username: clientObject.username,
          email: clientObject.email,
          location: clientObject.location,
          countryCode: clientObject.countryCode,
          phone: clientObject.phone,
          lastUpdateSeenTime : serverTimestamp.now()
    });

  await signInUser(email, password, clientObject.username);
  } catch (error) {
    console.error("Error creating client account:", error);
    window.hideAuthProgress();
      window.showNotif({ type: "error", title: "Signup Failed", message: error.message || "An error occurred while creating your account. Please try again." });
    throw error;
  }
}





async function signInUser(email, password , username = null) {

  window.showAuthProgress("Signing you in...", 20);

  signInWithEmailAndPassword(auth, email, password)
    .then(async (userCredential) => {
      const user = userCredential.user;

      window.showAuthProgress("Checking your account...", 50);

      const actionsToRun = [...window.POST_ACTIONS];
      window.POST_ACTIONS = [];

      for (let i = 0; i < actionsToRun.length; i++) {
        const action = actionsToRun[i];
        window.showAuthProgress(`Running: ${action.purpose}...`, 60 + (i + 1) * 10);
        try {
          await action.action();
        } catch (e) {
          console.warn("Post action failed:", action.event_id, e);
        }
      }

      if(username) await updateUserDisplayName(user, username);
      window.showAuthProgress("All done!", 100);

      setTimeout(() => {
        window.hideAuthProgress();
        sessionStorage.setItem("gressor_gmarketfy_user_role", "client");
        window.showNotif({ type: "success", title: "Welcome back!", message: "You're now logged in." });
      }, 500);

    })
    .catch((error) => {
      window.hideAuthProgress();

      const errorMap = {
        "Firebase: Error (auth/user-not-found).": "Authentication failed.",
        "Firebase: Error (auth/wrong-password).": "Incorrect password. Please try again.",
        "Firebase: Error (auth/invalid-email).": "The email address is not valid.",
        "Firebase: Error (auth/user-disabled).": "This account has been disabled."
      };

      const userFriendlyMessage = errorMap[error.message] || error.message;
      window.showNotif({ type: "error", title: "Login failed", message: userFriendlyMessage });
    })
    .finally(() => {
      window.closeAuthModal();
      window.showAuthProgress("Done", 100);
      window.updateCart(window.getCartCount(), window.getTotalCartCost());
      setTimeout(() => {
        window.hideAuthProgress();
      }, 500);

    });
}

async function initUserCart() {
  try {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      unsubscribe();

      if (!user) return;

      const userCartRef = doc(db, "carts", user.uid);
      const userCartSnap = await getDoc(userCartRef);

      if (!userCartSnap.exists()) return;

      const firestoreCart = userCartSnap.data().carts || [];

      if (firestoreCart.length === 0) return;

      firestoreCart.forEach((cartItem) => {
        const alreadyInCart = cart.some(c => c.product_id === cartItem.product_id);
        if (!alreadyInCart) {
          cart.push({
            product_id: cartItem.product_id,
            price: cartItem.price || 0,
            quantity: cartItem.quantity || 1,
          });
        }
      });

    window.updateCart(window.getCartCount(), window.getTotalCartCost());
    });
  } catch (e) {
    console.warn("initUserCart failed:", e);
  }
}

window.getCartCount = () => {
  return cart.reduce((total, item) => {
    return total + (parseInt(item.quantity) || 1);
  }, 0);
};


async function vendorDetectionAfterMath(email , password , username) {
        window.showDialog({
  type:    "warn",
  emoji:   "🏪",
  tag:     "Vendor Account",
  title:   "Vendor account detected",
  message: "We found a vendor account with this email. would you like to use the same email to create a client account ?",
  actions: [
    {
      label: "Sure, use same email",
      style: "primary",
      onClick: () => {
        // pull vendor data and auto-register as client
        // you handle this part
    console.log("creating client account from vendor data...");
        window.POST_ACTIONS.push(createClientFromVendor);
        signInUser(email, password, username);
      }
    },
    {
      label: "Use another account",
      style: "secondary",
      onClick: () => {
        window.openAuthModal("signup");
      }
    },
    {
      label: "Cancel",
      style: "danger",
      onClick: () => {} // just closes
    }
  ]
})
window.updateCart(window.getCartCount(), window.getTotalCartCost());
}


async function updateUserDisplayName(user, newName) {
  await updateProfile(user, {
    displayName: newName
  });
}

function updateUIforRating(productId , newRating) {
const element = document.getElementById(`product-rating-${productId}`);

const previousAverage = parseFloat(element.dataset.average);
const totalRatings = parseInt(element.dataset.total);

const newAverage = ((previousAverage * totalRatings) + newRating) / (totalRatings + 1);
const newTotal = totalRatings + 1;

animateRatingUpdate(element, newAverage, newTotal);
}

function animateRatingUpdate(element, newAverage, newTotal) {
  const prevAverage = parseFloat(element.dataset.average) || 0;
  const prevTotal = parseInt(element.dataset.total) || 0;

  const duration = 600; // ms
  const start = performance.now();

  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);

    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);

    const currentAvg = (prevAverage + (newAverage - prevAverage) * eased).toFixed(1);
    const currentTotal = Math.round(prevTotal + (newTotal - prevTotal) * eased);

    element.innerHTML = `
      ⭐ ${currentAvg}
      <span class="text-white/40"> -> ${currentTotal}</span>
    `;

    if (progress < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);

  // Update data attributes at the end
  element.dataset.average = newAverage.toFixed(1);
  element.dataset.total = newTotal;
}



async function loadProductReviews(productId) {
  const reviewsList = document.getElementById("reviewsList");
  const reviewsSummary = document.getElementById("reviewsSummary");

  reviewsList.innerHTML = "Loading reviews...";

  const q = query(
    collection(db, "ratings"),
    where("targetId", "==", productId),
    where("targetType", "==", "product")
  );

  const snap = await getDocs(q);

  if (snap.empty) {
    reviewsSummary.textContent = "No reviews yet 😕";
    reviewsList.innerHTML = "";
    return;
  }

  let total = 0;
  let count = snap.size;

  let html = "";

  snap.forEach(doc => {
    const r = doc.data();

    total += r.rating;

    html += `
      <div class="p-3 rounded-lg bg-white/5 border border-white/10">
        <div class="flex justify-between text-sm">
          <span class="text-white font-medium">${r.username || "Anonymous"}</span>
          <span class="text-yellow-400">${"★".repeat(r.rating)}</span>
        </div>

        <p class="text-white/70 text-sm mt-1">
          ${r.review || "No comment"}
        </p>
      </div>
    `;
  });

  const avg = (total / count).toFixed(1);

  reviewsSummary.textContent = `⭐ ${avg} average • ${count} reviews`;

  reviewsList.innerHTML = html;
}



async function initProductsApp() {

loadProducts("all")
document.getElementById('cart-fab').addEventListener('click' ,()=>{
window.location.href = "./client/dashboard.html"
})
}

initProductsApp()