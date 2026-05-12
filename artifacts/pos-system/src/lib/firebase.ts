import { initializeApp, getApps } from "firebase/app";
import { getFirestore, initializeFirestore } from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyB6YfM1DyVq0NTEWXpMdbCYuWwr9cWwbt0",
  authDomain: "hod-tickets.firebaseapp.com",
  projectId: "hod-tickets",
  storageBucket: "hod-tickets.firebasestorage.app",
  messagingSenderId: "86190418978",
  appId: "1:86190418978:web:8b1eafc784c4986fd3ee7b",
};

const isFirstInit = getApps().length === 0;
const app = isFirstInit ? initializeApp(firebaseConfig) : getApps()[0];
// `ignoreUndefinedProperties: true` prevents Firestore from rejecting writes that
// contain undefined fields (e.g. optional KOT item fields like notes/modifiers).
// Without this, printKOT() fails with code "invalid-argument".
export const db = isFirstInit
  ? initializeFirestore(app, { ignoreUndefinedProperties: true })
  : getFirestore(app);
export const auth = getAuth(app);

// Firestore rules on `bookings` (and a few other collections) require `request.auth != null`
// for updates/deletes. The customer site authenticates via email/password admin login;
// the POS uses anonymous sign-in to satisfy the rule without needing admin credentials.
// Resolves once auth is ready (signed in or already signed in from previous session).
export const authReady: Promise<void> = new Promise((resolve) => {
  const unsub = onAuthStateChanged(auth, (user) => {
    if (user) { unsub(); resolve(); }
  });
  if (!auth.currentUser) {
    signInAnonymously(auth).catch((e) => {
      console.error("[firebase] anonymous sign-in failed — enable Anonymous auth in Firebase Console → Authentication → Sign-in method", e);
    });
  }
});

export default app;
