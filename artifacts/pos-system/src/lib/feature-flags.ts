// Phase switch — controls which features are visible to this venue.
//
// HOW TO USE:
//   - Set VITE_PHASE=1 in your build env  → Phase 1 only (Door + Bookings + Covers + Aggregator sync)
//                                            Hides: Captain, Bar, KOT, Billing, Floor View, Reports, Shift
//   - Set VITE_PHASE=2 (or leave unset)   → Full Phase 2 POS (everything you have today)
//   - Set VITE_PHASE=3                    → Phase 3 (adds inventory + recipes — not built yet)
//
// FOR APK BUILD (Phase 1 offline):
//   Build with `VITE_PHASE=1 pnpm --filter @workspace/pos-system run build`
//   Then wrap the dist/ folder with Capacitor or Tauri to ship as an APK.
//
// FOR HOD (your own venue):
//   Leave VITE_PHASE unset (defaults to "2") — nothing changes for you.

const RAW_PHASE = (import.meta.env.VITE_PHASE || "2").toString().trim();
export const PHASE: 1 | 2 | 3 = (parseInt(RAW_PHASE, 10) || 2) as 1 | 2 | 3;

export const FEATURES = {
  // Phase 1 — door / bookings / covers / aggregator sync (always on)
  doorMode: PHASE >= 1,
  onlineBookings: PHASE >= 1,
  covers: PHASE >= 1,
  aggregatorSync: PHASE >= 1,
  admin: PHASE >= 1, // admin needed in Phase 1 too (events, staff, settings)

  // Phase 2 — captain / bar / KOT / billing
  captainMode: PHASE >= 2,
  barMode: PHASE >= 2,
  kitchenMode: PHASE >= 2,
  floorView: PHASE >= 2,
  tablePos: PHASE >= 2,
  billing: PHASE >= 2,
  kot: PHASE >= 2,
  reports: PHASE >= 2,
  shift: PHASE >= 2,
  audit: PHASE >= 2,

  // Phase 3 — inventory / recipes (not built yet)
  inventory: PHASE >= 3,
  recipes: PHASE >= 3,

  // ── EDC Cloud (Razorpay POS Terminal API + Pine Labs Plutus Smart Cloud) ──
  // Pushes cover-charge bill amounts straight to a card-swipe machine over the
  // internet so customer taps card → POS auto-detects success → cover marked
  // paid. Closes the cash-fudging fraud hole on door card payments.
  // OFF by default. Flip on in this build (or via VITE_EDC=1) ONLY once vendor
  // (Razorpay or Pine Labs) has enabled POS Terminal API on the merchant
  // account AND the live Terminal ID is wired in `cloud-functions/edc/`.
  // See `replit.md` → "EDC Cloud Integration" for rollout checklist.
  edc:
    String(import.meta.env.VITE_EDC || "").toLowerCase() === "1" ||
    String(import.meta.env.VITE_EDC || "").toLowerCase() === "true",
} as const;

export const IS_PHASE_1_ONLY = PHASE === 1;
