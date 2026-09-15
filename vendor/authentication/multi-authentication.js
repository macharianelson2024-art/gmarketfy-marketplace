// Importing Firebase modules

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getFirestore, doc, onSnapshot ,setDoc , Timestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { 
  getAuth, 
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { serverTimestamp } from "../../client/firebase-config.js";




const firebaseConfig = { 
  apiKey: "AIzaSyAUErMIjiQgnprmqYd6wiscOa8CIAAELi8",
  authDomain: "marketfy-82c42.firebaseapp.com",
  projectId: "marketfy-82c42",
  storageBucket: "marketfy-82c42.firebasestorage.app",
  messagingSenderId: "321190245217",
  appId: "1:321190245217:web:b9eb39db0a9a2056a30b20",
  measurementId: "G-07W1D4H9JB"
}


// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Initialize Firebase Authentication and get a reference to the service
const auth = getAuth(app);



// Example: Setting a brand message from Firestore for branding purposes
document.addEventListener("DOMContentLoaded", () => {

    const brandMessageEl = document.getElementById("brand-message");
    const brandRef = doc(db,"gressor" , "gressor-report", );


    onSnapshot(brandRef, (docSnap) => {
        if (docSnap.exists()) {
            const data = docSnap.data();
            brandMessageEl.textContent = "— " + data.message;
        }
    });

});



        function toggleSelect(id) {
            console.log("called called....");
            
            document.querySelectorAll('.options-menu').forEach(m => m.id !== id && m.classList.remove('active'));
            document.getElementById(id).classList.toggle('active');
        }
        function setVal(id, val) {
            document.getElementById(id).innerText = val;
            document.getElementById(id).setAttribute('data-selected', val);
            document.getElementById(id).classList.add('text-white');
        }

        const trigger = document.getElementById('mode-trigger');
        const pill = document.getElementById('pill');
        const tabLogin = document.getElementById('tab-login');
        const tabSignup = document.getElementById('tab-signup');
        const extras = document.getElementById('signup-extra-fields');
        const submit = document.getElementById('submit-btn');
        let imageBase64 = null;
        let isSignUp = false;

let userRedirectedToSignUp = JSON.parse(localStorage.getItem('vendorOnboarding'));

if (userRedirectedToSignUp) {
            isSignUp = true;
            
            // Back to Original Fluid Motion
                pill.style.transform = isSignUp ? 'translateX(calc(100% + 0px))' : 'translateX(0)';
                pill.style.backgroundColor = isSignUp ? '#6366f1' : '#fff';

                document.querySelector('.forgot-password').classList.add('hide-forgot-password');
                tabLogin.classList.replace('text-black', 'text-slate-500');
                tabSignup.classList.replace('text-slate-500', 'text-white');
                submit.innerText = "Launch Marketplace";
                submit.className = "h-11 px-16 bg-indigo-600 hover:bg-indigo-500 text-white font-extrabold rounded-xl text-sm transition-all shadow-xl w-full md:w-auto active:scale-95";
                extras.classList.remove('hidden');
                localStorage.removeItem('vendorOnboarding');
}


        trigger.addEventListener('click', () => {
            isSignUp = !isSignUp;
            
            // Back to Original Fluid Motion
            pill.style.transform = isSignUp ? 'translateX(calc(100% + 0px))' : 'translateX(0)';
            pill.style.backgroundColor = isSignUp ? '#6366f1' : '#fff';
            
            // Text Color Swapping
            if (isSignUp) {
                document.querySelector('.forgot-password').classList.add('hide-forgot-password');
                tabLogin.classList.replace('text-black', 'text-slate-500');
                tabSignup.classList.replace('text-slate-500', 'text-white');
                submit.innerText = "Launch Marketplace";
                submit.className = "h-11 px-16 bg-indigo-600 hover:bg-indigo-500 text-white font-extrabold rounded-xl text-sm transition-all shadow-xl w-full md:w-auto active:scale-95";
                extras.classList.remove('hidden');
                document.getElementById('title').innerText = "Create Your Empire";
            } else {
                document.querySelector('.forgot-password').classList.remove('hide-forgot-password');
                tabSignup.classList.replace('text-white', 'text-slate-500');
                tabLogin.classList.replace('text-slate-500', 'text-black');
                submit.innerText = "Sign In to Dashboard";
                submit.className = "h-11 px-16 bg-white hover:bg-slate-100 text-black font-extrabold rounded-xl text-sm transition-all shadow-xl w-full md:w-auto active:scale-95";
                extras.classList.add('hidden');
                document.getElementById('title').innerText = "Merchant Access";
            }
        });

        // Image Preview Logic
        document.getElementById('logo-upload').addEventListener('change', function() {
            const file = this.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const prev = document.getElementById('image-preview');
                    prev.style.backgroundImage = `url(${e.target.result})`;
                    prev.innerHTML = '';
                    prev.style.borderStyle = 'solid';
                    prev.style.borderColor = 'rgba(99, 102, 241, 0.4)';
                };
                reader.readAsDataURL(file);
            }
        });

        window.onclick = (e) => {
            if (!e.target.closest('.custom-select-wrapper')) {
                document.querySelectorAll('.options-menu').forEach(m => m.classList.remove('active'));
            }
        };

// Country Data (code, name, flag)
const countries = [
    { name: "KEN", code: "+93", flag: "🇦🇫" }, // Afghanistan
    { name: "ALB", code: "+355", flag: "🇦🇱" },
    { name: "DZA", code: "+213", flag: "🇩🇿" },
    { name: "USA", code: "+1", flag: "🇺🇸" },
    { name: "CAN", code: "+1", flag: "🇨🇦" },
    { name: "MEX", code: "+52", flag: "🇲🇽" },
    { name: "BRA", code: "+55", flag: "🇧🇷" },
    { name: "ARG", code: "+54", flag: "🇦🇷" },

    { name: "GBR", code: "+44", flag: "🇬🇧" },
    { name: "FRA", code: "+33", flag: "🇫🇷" },
    { name: "DEU", code: "+49", flag: "🇩🇪" },
    { name: "ITA", code: "+39", flag: "🇮🇹" },
    { name: "ESP", code: "+34", flag: "🇪🇸" },
    { name: "NLD", code: "+31", flag: "🇳🇱" },
    { name: "BEL", code: "+32", flag: "🇧🇪" },
    { name: "SWE", code: "+46", flag: "🇸🇪" },
    { name: "NOR", code: "+47", flag: "🇳🇴" },
    { name: "FIN", code: "+358", flag: "🇫🇮" },

    { name: "RUS", code: "+7", flag: "🇷🇺" },
    { name: "UKR", code: "+380", flag: "🇺🇦" },
    { name: "TUR", code: "+90", flag: "🇹🇷" },
    { name: "SAU", code: "+966", flag: "🇸🇦" },
    { name: "ARE", code: "+971", flag: "🇦🇪" },
    { name: "ISR", code: "+972", flag: "🇮🇱" },

    { name: "IND", code: "+91", flag: "🇮🇳" },
    { name: "PAK", code: "+92", flag: "🇵🇰" },
    { name: "BGD", code: "+880", flag: "🇧🇩" },
    { name: "CHN", code: "+86", flag: "🇨🇳" },
    { name: "JPN", code: "+81", flag: "🇯🇵" },
    { name: "KOR", code: "+82", flag: "🇰🇷" },

    { name: "NGA", code: "+234", flag: "🇳🇬" },
    { name: "KEN", code: "+254", flag: "🇰🇪" },
    { name: "ZAF", code: "+27", flag: "🇿🇦" },
    { name: "ETH", code: "+251", flag: "🇪🇹" },
    { name: "GHA", code: "+233", flag: "🇬🇭" },
    { name: "UGA", code: "+256", flag: "🇺🇬" },

    { name: "AUS", code: "+61", flag: "🇦🇺" },
    { name: "NZL", code: "+64", flag: "🇳🇿" }
];

const list = document.getElementById("country-list");
const selected = document.getElementById("country-selected");
const trigger1 = document.getElementById("country-trigger");

let currentCode = "+254";

// build dropdown
countries.forEach(c => {
    const item = document.createElement("div");
    item.className = "px-3 py-2 text-sm text-slate-300 hover:bg-white/5 cursor-pointer";
    item.innerText = `${c.code} ${c.flag} ${c.name}`;

    item.addEventListener("click", () => {
        currentCode = c.code;
        selected.innerText = `${c.code} ${c.flag}`;
        list.classList.add("hidden");
    });

    list.appendChild(item);
});

trigger1.addEventListener("click", () => {
    list.classList.toggle("hidden");
});

// close when clicking outside
window.addEventListener("click", (e) => {
    if (!e.target.closest("#country-trigger")) {
        list.classList.add("hidden");
    }
});




        
// IMAGE CLICK (same as onclick before)
document.getElementById('image-preview').addEventListener('click', () => {
    document.getElementById('logo-upload').click();
});

// CATEGORY DROPDOWN
document.getElementById('cat-wrapper').addEventListener('click', () => {
    toggleSelect('cat-list');
});

document.querySelectorAll('.cat_opt').forEach(opt => {
    opt.addEventListener('click', (e) => {
        setVal('cat-val', opt.textContent);
    });
});


// CURRENCY
document.getElementById('cur-wrapper').addEventListener('click', () => {    
    toggleSelect('cur-list');
});



document.querySelectorAll('.cur-opt').forEach(opt => {
    opt.addEventListener('click', (e) => {
        setVal('cur-val', opt.textContent);
    });
});

// PAYOUT
document.getElementById('pay-wrapper').addEventListener('click', (e) => {
        toggleSelect('pay-list');
});


    document.querySelectorAll('.pay_opt').forEach(opt => {
        opt.addEventListener('click', (e) => {
            setVal('pay-val', opt.textContent);     
        });
})

const storeToggle = document.getElementById('store-toggle');
const storeDot = document.getElementById('store-toggle-dot');
const storeFields = document.getElementById('store-fields');

let storeActive = false;

storeToggle.addEventListener('click', () => {
    storeActive = !storeActive;

    if (storeActive) {
        storeToggle.classList.add('bg-indigo-600');
        storeDot.style.transform = 'translateX(24px)';
        storeFields.classList.add('active');
    } else {
        storeToggle.classList.remove('bg-indigo-600');
        storeDot.style.transform = 'translateX(0)';
        storeFields.classList.remove('active');
    }
});

// IMAGE COMPRESSION FUNCTION
function compressImage(file, maxWidth = 400, quality = 0.6) {
  return new Promise((resolve) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      const img = new Image();

      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        // 🧠 prevent upscaling
        const scale = Math.min(1, maxWidth / img.width);

        const width = img.width * scale;
        const height = img.height * scale;

        canvas.width = width;
        canvas.height = height;

        ctx.drawImage(img, 0, 0, width, height);

        const base64 = canvas.toDataURL("image/jpeg", quality);
        resolve(base64);
      };

      img.src = event.target.result;
    };

    reader.readAsDataURL(file);
  });
}

// Listen for image selection and compress
document.getElementById("logo-upload").addEventListener("change", async function () {
    const file = this.files[0];
    if (!file) return;

    imageBase64 = await compressImage(file, 600, 0.6);

    console.log("Compressed image ready");
});


// FORM VALIDATION & COLLECTION
function validateAndCollectForm() {

    const phoneNumber = document.getElementById("phone-number").value.trim();
    const phoneRegex = /^\+?\d{7,15}$/;

    const fullPhone = currentCode + phoneNumber;

    const email = document.querySelector('input[type="email"]');
    const password = document.querySelector('input[type="password"]');
    const storeName = document.querySelector('input[placeholder="e.g. Nexus Global"]');
    const storeDescription = document.getElementById("store_description")
    const ownerDescriprion = document.getElementById("owner_description")
    const logo = document.getElementById('logo-upload');

    const storeActive = document.getElementById('store-fields').classList.contains('active');

    const street = storeActive
        ? document.querySelector('input[placeholder="Street name, building number"]')
        : null;

    const city = storeActive
        ? document.querySelector('input[placeholder="e.g. Nairobi"]')
        : null;

    const country = storeActive
        ? document.querySelector('input[placeholder="e.g. Kenya"]')
        : null;

    const Apartment = storeActive
    ? document.querySelector('input[placeholder="Apartment, suite, unit, etc."]')
    : null;

    const state = storeActive
    ? document.querySelector('input[placeholder="e.g. Kiambu County"]')
    : null;
    
     const postalCode = storeActive
    ? document.querySelector('input[placeholder="e.g. 00100"]')
    : null;
    
    
    const category = document.getElementById('cat-val').getAttribute('data-selected');
    const currency = document.getElementById('cur-val').getAttribute('data-selected');
    const payout = document.getElementById('pay-val').getAttribute('data-selected');


    
    // ======================
    // VALIDATION FLOW
    // ======================

    if (!email.value || !email.value.includes("@")) {
        showAlert("Enter a valid email", "error", 100);
        email.focus();
        return null;
    }

    if (!password.value || password.value.length < 6) {
        showAlert("Password must be at least 6 characters", "error", 100);
        password.focus();
        return null;
    }

    if (!phoneNumber || !phoneRegex.test(fullPhone)) {
        showAlert("Enter a valid phone number", "error", 100);
        document.getElementById("phone-number").focus();
        return null;
    }

    if (!storeName.value.trim()) {
        showAlert("Store name is required", "error", 100);
        storeName.focus();
        return null;
    }

    if (!storeDescription.value.trim()) {
        showAlert("Store description is required", "error", 100);
        storeDescription.focus();
        return null;
    }
    if (!ownerDescriprion.value.trim()) {   
        showAlert("Owner description is required", "error", 100);
        ownerDescriprion.focus();
        return null;
    }

    if (!imageBase64) {
        showAlert("Please upload a store image", "error", 100);
        document.getElementById("logo-upload").focus();
        return null;
    }

    if (storeActive) {
        if (!street.value.trim()) {
            showAlert("Street address is required", "error", 100);
            street.focus();
            return null;
        }

        if (!city.value.trim()) {
            showAlert("City is required", "error", 100);
            city.focus();
            return null;
        }

        if (!country.value.trim()) {
            showAlert("Country is required", "error", 100);
            country.focus();
            return null;
        }
    }

    // ======================
    // CLEAN RETURN OBJECT
    // ======================

    return {
        email: email.value.trim(),
        password: password.value,
        phone: fullPhone,
        storeName: storeName.value.trim(),
        hasPhysicalStore: storeActive,
        image: imageBase64,
        storeDescription: storeDescription.value.trim(),
        ownerDescriprion: ownerDescriprion.value.trim(),
        category: category || null,
        currency: currency || null,
        payoutMethod: payout || null,

        delivery: {
        enabled: false,
        mode: "none",
        type: "none",
        fee: 0
        },
        address: storeActive
            ? {
                street: street.value.trim(),
                city: city.value.trim(),
                country: country.value.trim(),
                building : Apartment.value.trim(),
                state : state.value.trim(),
                postalCode : postalCode.value.trim()
            }
            : null
    };
}


// FORM SUBMISSION
document.getElementById("vendor-form").addEventListener("submit", (e) => {
    e.preventDefault();

    if (isSignUp) {
        signUpVendor();
    } else {
        signInVendor();
    }
});


// SIGN UP FUNCTION
async function signUpVendor() {
    const data = validateAndCollectForm();
    if (!data) return;

    
    try {
        // STEP 1: Start signup
        showAlert("Creating account...", "loading", 20);

        const userCred = await createUserWithEmailAndPassword(
            auth,
            data.email,
            data.password
        );

        const uid = userCred.user.uid;
        const user = userCred.user;
        // 🔥 allow Firebase auth to fully settle
        await new Promise(r => setTimeout(r, 1200));

        // STEP 2: Send verification email (more stable now)

        const actionCodeSettings = {
            url: "https://marketfy-82c42.web.app/vendor/authentication/email-verified.html",
            handleCodeInApp: false
            };

                sendEmailVerification(user, actionCodeSettings)
               

        showAlert("📩 Sending verification email...", "loading", 50);

        // STEP 3: Prepare vendor data
        const refinedData = {
            vendor_id : uid,
            storeName: data.storeName,
            email: data.email,
            phone: data.phone,
            image: data.image,
            hasPhysicalStore: data.hasPhysicalStore,
            address: data.address,
            createdAt: Timestamp.now(),
            category: data.category,
            currency: data.currency,
            payoutMethod: data.payoutMethod,
            storeDescription: data.storeDescription,
            ownerDescriprion: data.ownerDescriprion,
            emailVerified: false,
            delivery:data.delivery,
            status: "active",
            lastUpdateSeenTime : serverTimestamp.now()
        };

    const stats = {
 vendor_id : uid,        
  visitors: {
    totalViews: 0,
    uniqueViews: 0,
    lastVisitors: []
  },

  rating: {
    average: 0,
    totalRatings: 0,
    breakdown: {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0
    }
  },

  metrics: {
    totalOrders: 0,
    completedOrders: 0,
    totalRevenue: 0
  },

  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
};

        console.log("Refined Data:", refinedData);

        // STEP 4: Save to Firestore
        await setDoc(doc(db, "vendors", uid), refinedData);
        await setDoc(doc(db , "vendorStats" , uid) , stats)
        await setDoc(doc(db ,"vendorVisitors" , uid) ,{visitors : 0})
        
        // STEP 5: User feedback flow
        showAlert("Verification email sent 📩 Check your inbox", "success", 70);

        await new Promise(res => setTimeout(res, 2000));

        showAlert("Account created successfully 🚀", "success", 100);

        await new Promise(res => setTimeout(res, 1500));

        resetFormAnimated();

        showAlert(
            "Please verify your email to activate your vendor account.",
            "info",
            100
        );
        alert("Check your inbox to verify your vendor account. Don't forget to peek in your spam folder if it’s missing!")
    } catch (err) {
        showAlert(getFirebaseErrorMessage(err), "error", 100);
        console.error(err);
    }

}

async function safeSendVerification(user) {
  try {
    await sendEmailVerification(user, {
      url: "https://marketfy-82c42.web.app/vendors/authentication/email-verified.html",
      handleCodeInApp: true
    });
  } catch (err) {
    console.warn("Retrying email verification...");

    await new Promise(r => setTimeout(r, 2000));

    await sendEmailVerification(user, {
      url: "https://marketfy-82c42.web.app/vendors/authentication/email-verified.html",
      handleCodeInApp: true
    });
  }
}

// SIGN IN FUNCTION
async function signInVendor() {
    const email = document.querySelector('input[type="email"]').value;
    const password = document.querySelector('input[type="password"]').value;

    if (!email || !password) {
        showAlert("Enter email and password", "error", 100);
        return;
    }

    try {
        showAlert("Signing you in...", "loading", 40);

        await signInWithEmailAndPassword(auth, email, password);
        resetFormAnimated();
        showAlert("Welcome back 🚀", "success", 100);
        
        window.location.href = "../vendor.html"
    } catch (err) {
        showAlert(getFirebaseErrorMessage(err), "error", 100);
        console.error(err);
    }
}

let progressInterval = null;

function animateProgress(duration = 2500) {
    const bar = document.getElementById("alert-progress");
    let start = 100;

    if (progressInterval) clearInterval(progressInterval);

    bar.style.transition = "none";
    bar.style.width = "100%";

    const stepTime = 30;
    const steps = duration / stepTime;
    const decrement = 100 / steps;

    progressInterval = setInterval(() => {
        start -= decrement;
        bar.style.width = `${Math.max(0, start)}%`;

        if (start <= 0) {
            clearInterval(progressInterval);
        }
    }, stepTime);
}



const alertBox = document.getElementById("alert-box");


let alertTimeout = null;

function showAlert(message, type = "info", duration = 2500) {

    const alertBox = document.getElementById("alert-box");
    const alertText = document.getElementById("alert-text");

    alertText.textContent = message;

    alertBox.className =
        `fixed bottom-6 left-1/2 px-5 py-3 rounded-xl text-sm text-white shadow-xl z-50`;

    if (type === "error") {
        alertBox.style.background = "rgba(239, 68, 68, 0.95)";
        duration = Math.max(duration, 3500);
    }

    if (type === "success") {
        alertBox.style.background = "rgba(34, 197, 94, 0.95)";
    }

    if (type === "loading") {
        alertBox.style.background = "rgba(99, 102, 241, 0.95)";
    }

    alertBox.style.opacity = "1";
    alertBox.style.transform = "translate(-50%, 0px)";

    animateProgress(duration);

    if (type !== "loading") {
        setTimeout(() => {
            dismissAlert();
        }, duration);
    }
}

function showProgressAlert(message = "Processing...") {
    const container = document.getElementById("alert-container");

    const alert = document.createElement("div");
    alert.className = "alert info";

    alert.innerHTML = `
        <div>${message}</div>
        <div class="alert-bar">
            <div class="alert-bar-fill bg-indigo-500 animate-pulse"></div>
        </div>
    `;

    container.appendChild(alert);

    return alert;
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

    const errorMap = {
        // =====================
        // AUTH ERRORS
        // =====================
        "auth/invalid-email": "Please enter a valid email address.",
        "auth/user-disabled": "This account has been disabled.",
        "auth/user-not-found": "No account found with this email.",
        "auth/wrong-password": "Incorrect password. Please try again.",
        "auth/email-already-in-use": "This email is already registered.",
        "auth/weak-password": "Password should be at least 6 characters.",
        "auth/too-many-requests": "Too many attempts. Try again later.",
        "auth/network-request-failed": "Network error. Check your connection.",

        //incorrect credentials can sometimes return different codes based on context, so we cover multiple possibilities
        "auth/invalid-credential": "Incorrect email or password. Please try again.",
        "auth/invalid-login-credentials": "Incorrect email or password. Please try again.",

        // =====================
        // FIRESTORE ERRORS
        // =====================
        "permission-denied": "You don’t have permission to perform this action.",
        "unavailable": "Service is temporarily unavailable. Try again.",
        "not-found": "Requested data was not found.",

        // =====================
        // GENERAL / EDGE CASES
        // =====================
        "auth/operation-not-allowed": "This login method is not enabled.",
        "auth/account-exists-with-different-credential": "Account exists with a different sign-in method.",

        // fallback
        "default": "Something went wrong. Please try again."
    };

    return errorMap[code] || errorMap["default"];
}


function resetFormAnimated(containerSelector = "form") {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    // Get all inputs, textareas, selects
    let fields = Array.from(
        container.querySelectorAll("input, textarea, select")
    );

    // Randomize direction
    const topToBottom = Math.random() > 0.5;

    if (!topToBottom) {
        fields.reverse();
    }

    // Animation timing
    let delay = 0;

    fields.forEach((field, index) => {
        setTimeout(() => {

            // Optional: fade effect
            field.style.transition = "opacity 0.2s ease, transform 0.2s ease";
            field.style.opacity = "0.3";
            field.style.transform = "translateY(5px)";

            setTimeout(() => {
                // Clear value
                if (field.type === "checkbox" || field.type === "radio") {
                    field.checked = false;
                } else if (field.tagName === "SELECT") {
                    field.selectedIndex = 0;
                } else {
                    field.value = "";
                }

                // Restore style
                field.style.opacity = "1";
                field.style.transform = "translateY(0)";

            }, 150);

        }, delay);

        delay += 80; // speed between fields
    });
}

document.getElementById("home").addEventListener('click' ,()=>{
  window.location.href = '../../index.html';
})