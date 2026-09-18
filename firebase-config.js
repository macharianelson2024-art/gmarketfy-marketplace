
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile 
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  getFirestore,
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
  orderBy,
  increment,
  Timestamp,
  getDocs,
  limit,
  startAfter
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ===============================
//  FIREBASE CONFIG
// ===============================
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

export {
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
  orderBy,
  increment,
  Timestamp,
  getDocs,
  limit,
  startAfter
}

export {
    app ,
    auth ,
    db,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut,
    updateProfile
}
