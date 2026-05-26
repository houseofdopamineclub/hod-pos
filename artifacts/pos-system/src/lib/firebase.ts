import { initializeApp, getApps } from "firebase/app";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
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
//
// `persistentLocalCache` enables IndexedDB-backed offline persistence:
//   - every Firestore doc the tablet has ever read is cached locally
//   - WiFi drop → tablet keeps showing covers/wallets/menu, writes queue locally
//   - WiFi back → queued writes auto-sync, no data loss
//   - `persistentMultipleTabManager` lets POS run in multiple tabs without conflict
// Wrapped in try/catch because some browsers (Safari private mode, very old Android
// WebView) reject IndexedDB — we fall back to in-memory cache so POS still loads.
function initDb() {
  if (!isFirstInit) return getFirestore(app);
  try {
    return initializeFirestore(app, {
      ignoreUndefinedProperties: true,
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (e) {
    console.warn("[firebase] persistent cache unavailable, falling back to memory-only", e);
    return initializeFirestore(app, { ignoreUndefinedProperties: true });
  }
}
export const db = initDb();
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
