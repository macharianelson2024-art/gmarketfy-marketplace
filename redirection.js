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
  orderBy,
  increment
} from './firebase-config.js'

import {
    app ,
    auth ,
    db,
    onAuthStateChanged
} from './firebase-config.js'
let authenticated = false;
onAuthStateChanged(auth , (user)=>{
    if(user){
        authenticated = true;
    }
})


document.getElementById('log_in_button').addEventListener('click',()=>{
if(authenticated){
    window.location.href = './vendor/dashboard.html'
} else {
    window.location.href = '/vendor/authentication/authentication.html';
}
})