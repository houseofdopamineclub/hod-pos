// EDC (card-swipe machine) cloud-charge client. POSTs to the Firebase
// cloud function which dispatches the charge to a Razorpay/Pine Labs
// POS Terminal; status is observed via Firestore subscription.
// Canonical amount is server-derived; webhook is HMAC-verified.

import { onSnapshot, doc, type Unsubscribe } from "firebase/firestore";
import { db } from "./firebase";

// All EDC functions live in the existing `hod-tickets` Firebase project,
// same region as the wallet recharge endpoints (asia-south1). The cloud
// function source for these endpoints lives in `cloud-functions/edc/` in
// THIS repo — copy into the hod-tickets functions deployment to ship.
const HOD_FUNCTIONS_BASE = "https://asia-south1-hod-tickets.cloudfunctions.net";
const EDC_CHARGE_RAZORPAY_URL = `${HOD_FUNCTIONS_BASE}/edcChargeRazorpay`;
const EDC_CHARGE_PINELABS_URL = `${HOD_FUNCTIONS_BASE}/edcChargePineLabs`;
const EDC_CANCEL_URL = `${HOD_FUNCTIONS_BASE}/edcCancelCharge`;

export type EdcVendor = "razorpay" | "pinelabs";

/** Per-night vendor override key — bouncer can flip between vendors mid-shift
 *  from Door Mode if the venue runs both card machines. Survives a tab
 *  refresh but is intentionally NOT cross-device-synced (different tablets
 *  may be paired to different EDCs). */
const EDC_VENDOR_LS_KEY = "hod.edc.vendor";

/** Build-time default vendor — set `VITE_EDC_VENDOR=pinelabs` to flip the
 *  default for a venue that runs only Pine Labs. Defaults to Razorpay so
 *  Phase 1 deployments are unaffected. */
function getBuildDefaultVendor(): EdcVendor {
  const raw = String(import.meta.env.VITE_EDC_VENDOR || "razorpay").toLowerCase().trim();
  return raw === "pinelabs" ? "pinelabs" : "razorpay";
}

/** Returns the vendor to use for the next charge — runtime localStorage
 *  override (set by the Door Mode toggle) wins over the build-time default.
 *  Safe to call during SSR / non-browser contexts. */
export function getActiveEdcVendor(): EdcVendor {
  if (typeof window === "undefined") return getBuildDefaultVendor();
  try {
    const stored = window.localStorage.getItem(EDC_VENDOR_LS_KEY);
    if (stored === "razorpay" || stored === "pinelabs") return stored;
  } catch {}
  return getBuildDefaultVendor();
}

/** Persist the bouncer-chosen vendor for this device. */
export function setActiveEdcVendor(vendor: EdcVendor): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(EDC_VENDOR_LS_KEY, vendor); } catch {}
}

/** Human-readable vendor label — used in the dialog header and toggle UI. */
export function edcVendorLabel(vendor: EdcVendor): string {
  return vendor === "razorpay" ? "Razorpay POS" : "Pine Labs Plutus";
}

export type EdcStatus = "pending" | "success" | "failed" | "cancelled";

export interface EdcTransactionDoc {
  bookingRef: string;
  coverRef: string;
  amount: number;
  vendor: EdcVendor;
  terminalId?: string;
  status: EdcStatus;
  /** Razorpay POS Terminal payment intent id (vendor=razorpay only). */
  razorpayIntentId?: string;
  /** Razorpay payment id once captured (vendor=razorpay only). */
  razorpayPaymentId?: string;
  /** Pine Labs txn ref once captured (vendor=pinelabs only). */
  pineLabsRef?: string;
  /** Last 4 digits of card, when EDC reports them. */
  last4?: string;
  /** Card network (VISA / MASTERCARD / RUPAY / AMEX), when reported. */
  cardNetwork?: string;
  /** Vendor-side reference shown on the printed slip. */
  edcRef?: string;
  /** Failure reason from EDC (e.g. "DECLINED", "INSUFFICIENT FUNDS", "TIMEOUT"). */
  errorReason?: string;
  /** SHA-256 hash of bouncer PIN (server already verified — kept for audit). */
  bouncerPin?: string;
  /** Display name of the bouncer who initiated the charge. */
  bouncerName?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface StartEdcChargeOpts {
  /** Firestore doc id of the booking; distinct from `bookingRef`. */
  bookingId: string;
  bookingRef: string;
  coverRef: string;
  vendor: EdcVendor;
  /** 4-digit bouncer PIN — SENT IN PLAINTEXT over HTTPS to the cloud function,
   *  which hashes + verifies before dispatch. Never logged client-side. */
  bouncerPin: string;
  bouncerName?: string;
  /** Display-only — server reads the canonical amount from Firestore. We send
   *  this so the UI confirmation dialog matches what the server charged; if
   *  they ever diverge that's a server-side bug worth catching. */
  expectedAmount: number;
}

export interface StartEdcChargeResult {
  ok: boolean;
  txnId?: string;
  /** When ok=false. "vendor_disabled" = vendor not yet enabled on merchant
   *  account; "bad_pin" = bouncer PIN rejected; "no_amount" = server could
   *  not derive a canonical amount from the booking/cover; "vendor_error"
   *  = the EDC vendor (Razorpay POS / Pine Labs) returned an error;
   *  "no_terminal" = no live Terminal ID configured; "error" = unexpected. */
  reason?: "vendor_disabled" | "bad_pin" | "no_amount" | "amount_mismatch" | "vendor_error" | "no_terminal" | "error";
  /** Server-side canonical amount when reason="amount_mismatch". */
  canonical?: number;
  errorMessage?: string;
}

/** Fire-and-poll: POSTs to the cloud function which dispatches the charge to
 *  the EDC machine and returns a txnId. Caller then subscribes to the
 *  Firestore doc for status updates. */
export async function startEdcCharge(opts: StartEdcChargeOpts): Promise<StartEdcChargeResult> {
  if (!opts.bookingRef) return { ok: false, reason: "error", errorMessage: "Missing bookingRef" };
  if (!opts.coverRef) return { ok: false, reason: "error", errorMessage: "Missing coverRef" };
  if (!opts.bouncerPin || opts.bouncerPin.length < 4) {
    return { ok: false, reason: "bad_pin", errorMessage: "Bouncer PIN required" };
  }
  const url = opts.vendor === "razorpay" ? EDC_CHARGE_RAZORPAY_URL : EDC_CHARGE_PINELABS_URL;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookingId: opts.bookingId,
        bookingRef: opts.bookingRef,
        coverRef: opts.coverRef,
        bouncerPin: opts.bouncerPin,
        bouncerName: opts.bouncerName || "",
        expectedAmount: opts.expectedAmount,
      }),
    });
    const data = await r.json().catch(() => ({} as any));
    if (r.ok && data?.txnId) {
      return { ok: true, txnId: String(data.txnId) };
    }
    const reason = (data?.reason as StartEdcChargeResult["reason"]) || "error";
    return {
      ok: false,
      reason,
      errorMessage: data?.error || `HTTP ${r.status}`,
      canonical: typeof data?.canonical === "number" ? data.canonical : undefined,
    };
  } catch (e: any) {
    return { ok: false, reason: "error", errorMessage: e?.message || "Network error" };
  }
}

/** Subscribe to live status updates on an EDC transaction. Returns an
 *  unsubscribe handle. Callback fires once with the current snapshot
 *  (may be `null` if the doc hasn't propagated yet) and again on every
 *  status flip. */
export function subscribeToEdcTransaction(
  txnId: string,
  cb: (txn: (EdcTransactionDoc & { id: string }) | null) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, "edcTransactions", txnId),
    (snap) => {
      if (!snap.exists()) { cb(null); return; }
      cb({ id: snap.id, ...(snap.data() as EdcTransactionDoc) });
    },
    (err) => {
      console.warn("[edc] subscription error", err);
      cb(null);
    },
  );
}

/** Best-effort cancel — used when the bouncer hits "Cancel" in the dialog
 *  before the customer has tapped their card. The cloud function tells the
 *  EDC to abort if it can; if the customer was already mid-tap, the
 *  vendor webhook will still land and the txn will end up success/failed. */
export async function cancelEdcCharge(txnId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(EDC_CANCEL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txnId }),
    });
    const data = await r.json().catch(() => ({} as any));
    if (r.ok) return { ok: true };
    return { ok: false, error: data?.error || `HTTP ${r.status}` };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Network error" };
  }
}

/** Default client-side timeout — matches the EDC's customer-tap window.
 *  After this elapses with no terminal status, the dialog gives up and
 *  surfaces a "timeout — try again" state to the bouncer. The server
 *  will eventually reconcile via webhook either way. */
export const EDC_CLIENT_TIMEOUT_MS = 60_000;
