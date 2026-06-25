import { initializeApp, getApps } from "firebase/app";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { getStorage } from "firebase/storage";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";

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

// 🆕 2026-05-28 v3.137 — L1 Firebase App Check (reCAPTCHA Enterprise).
// Attaches a per-request token proving this is the real POS app (not a bot
// scraping or a stolen API key). Backend enforcement on Firestore must be
// flipped ON separately in Firebase Console → App Check after metrics show
// 99%+ of real traffic is sending valid tokens (typically 24-48hr observation).
// Without that flip, this code is purely additive — every request just carries
// an extra header that the server ignores. ZERO risk to existing traffic.
//
// 🛟 FAIL-OPEN: If VITE_APPCHECK_SITE_KEY is unset (dev tablet, missing env),
// we skip init entirely. Firestore/Auth still work — server just won't see
// an App Check header on this client. Same effect as not having App Check.
//
// DEBUG MODE: in dev, set window.FIREBASE_APPCHECK_DEBUG_TOKEN=true BEFORE
// the SDK loads to get a debug token printed to console, which you whitelist
// in Firebase Console → App Check → Apps → ⋮ → Manage debug tokens.
if (isFirstInit) {
  const siteKey = (import.meta as { env?: Record<string, string | undefined> })
    .env?.VITE_APPCHECK_SITE_KEY;
  if (siteKey && siteKey.length > 10) {
    try {
      initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(siteKey),
        isTokenAutoRefreshEnabled: true,
      });
      console.log("[firebase] App Check initialized (reCAPTCHA Enterprise)");
    } catch (e) {
      // Silent fail — wrong site key, debug token mismatch, etc. Worst case
      // = same as no App Check, which is the current production state.
      console.warn("[firebase] App Check init failed (continuing without)", e);
    }
  } else {
    console.log("[firebase] App Check skipped — VITE_APPCHECK_SITE_KEY not set");
  }
}

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
      // 🆕 2026-06-04 v3.220 — venue WiFi / Android WebViews frequently block the
      // streaming (WebChannel) transport, leaving realtime listeners stalled
      // ~30s ("hung in between"). Auto-detect and fall back to long-polling so
      // covers/wallets/KOTs keep flowing on flaky venue networks.
      // 🔁 2026-06-25 — REVERTED a v3.394 experiment that FORCED long-polling:
      // it made the preview WORSE (~30s). Auto-detect is the better default here.
      experimentalAutoDetectLongPolling: true,
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (e) {
    console.warn("[firebase] persistent cache unavailable, falling back to memory-only", e);
    return initializeFirestore(app, {
      ignoreUndefinedProperties: true,
      experimentalAutoDetectLongPolling: true,
    });
  }
}
export const db = initDb();
export const auth = getAuth(app);
// 🆕 2026-05-26 v3.40 — Firebase Storage export for StaffManagement.tsx
// (staff avatar uploads). Build was failing on Cloudflare Pages because
// the page imports { storage } here. firebase/storage SDK is already in
// the firebase npm package — no new dependency needed.
export const storage = getStorage(app);

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
