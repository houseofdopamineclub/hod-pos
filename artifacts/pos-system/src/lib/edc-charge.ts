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
const EDC_REFUND_URL = `${HOD_FUNCTIONS_BASE}/edcRefundCharge`;

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

/** Returns true iff this device has a bouncer-chosen vendor override. When
 *  false, Door Mode should follow the venue-wide Firestore default (and
 *  fall back to the build-time default if Firestore hasn't loaded yet). */
export function hasEdcVendorOverride(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const stored = window.localStorage.getItem(EDC_VENDOR_LS_KEY);
    return stored === "razorpay" || stored === "pinelabs";
  } catch { return false; }
}

/** Returns the vendor to use for the next charge — priority is:
 *    1. per-device localStorage override (bouncer toggle in Door Mode)
 *    2. venue-wide Firestore default (set in Admin → Settings; passed in here)
 *    3. build-time `VITE_EDC_VENDOR` (legacy fallback)
 *  Safe to call during SSR / non-browser contexts. */
export function getActiveEdcVendor(venueDefault?: EdcVendor | null): EdcVendor {
  if (typeof window === "undefined") return venueDefault || getBuildDefaultVendor();
  try {
    const stored = window.localStorage.getItem(EDC_VENDOR_LS_KEY);
    if (stored === "razorpay" || stored === "pinelabs") return stored;
  } catch {}
  return venueDefault || getBuildDefaultVendor();
}

/** Persist the bouncer-chosen vendor for this device. */
export function setActiveEdcVendor(vendor: EdcVendor): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(EDC_VENDOR_LS_KEY, vendor); } catch {}
}

/** Clear the per-device override so Door Mode falls back to the venue-wide
 *  default. Useful when a tablet was paired to a specific machine and is
 *  now shared again. */
export function clearActiveEdcVendor(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(EDC_VENDOR_LS_KEY); } catch {}
}

/** Human-readable vendor label — used in the dialog header and toggle UI. */
export function edcVendorLabel(vendor: EdcVendor): string {
  return vendor === "razorpay" ? "Razorpay POS" : "Pine Labs Plutus";
}

export type EdcStatus =
  | "pending"
  | "success"
  | "failed"
  | "cancelled"
  // Set after a manager-PIN-gated refund completes successfully.
  | "refunded"
  // Set when a refund attempt was dispatched but the vendor rejected it.
  // The original `success` charge still stands; operator must retry the
  // refund or process it manually via the vendor dashboard.
  | "refund_failed";

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
  /** Refund amount in INR (currently always equals `amount` — partial refunds
   *  are not supported in Phase 1). Set on status=refunded / refund_failed. */
  refundAmount?: number;
  /** Razorpay refund id once the vendor confirms the refund (vendor=razorpay). */
  razorpayRefundId?: string;
  /** Vendor-side reason on status=refund_failed. */
  refundError?: string;
  /** ISO timestamp the refund was dispatched. */
  refundedAt?: string;
  /** Display name of the manager whose PIN authorised the refund. */
  refundedBy?: string;
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
  /** Set true when the operator explicitly retried after a failed/cancelled
   *  attempt. Bypasses the same-minute idempotency guard server-side so the
   *  cloud function generates a fresh txnId instead of rejecting with
   *  `previous_failed_in_same_minute`. Refresh-mid-flow MUST NOT set this. */
  retry?: boolean;
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
        retry: opts.retry === true,
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

export interface RefundEdcChargeOpts {
  txnId: string;
  /** 4-digit manager PIN — verified server-side against the manager-role
   *  entries in `hodStaffPins`. Plaintext over HTTPS, never logged. */
  managerPin: string;
  /** Display name of the manager initiating the refund (for audit). */
  managerName?: string;
}

export interface RefundEdcChargeResult {
  ok: boolean;
  /** Vendor-side refund id once the cloud function dispatched the refund. */
  refundId?: string;
  /** "bad_pin" — manager PIN rejected; "not_refundable" — txn is not in
   *  status=success (e.g. already refunded, never captured); "vendor_error"
   *  — vendor returned an error (rare, surface to user with errorMessage);
   *  "unknown_txn" — txnId not found in Firestore; "error" — unexpected. */
  reason?: "bad_pin" | "not_refundable" | "vendor_error" | "unknown_txn" | "error";
  errorMessage?: string;
}

/** Refund a previously-successful EDC charge end-to-end. The cloud function
 *  verifies the manager PIN, dispatches a refund to the vendor (Razorpay
 *  refunds API for vendor=razorpay), and writes the result back to the
 *  same `edcTransactions/{txnId}` doc with status=`refunded` (or
 *  `refund_failed` on vendor reject). The caller's existing Firestore
 *  subscription will pick up the new status — there's no separate listener
 *  to wire up. */
export async function refundEdcCharge(opts: RefundEdcChargeOpts): Promise<RefundEdcChargeResult> {
  if (!opts.txnId) return { ok: false, reason: "error", errorMessage: "Missing txnId" };
  if (!opts.managerPin || opts.managerPin.length < 4) {
    return { ok: false, reason: "bad_pin", errorMessage: "Manager PIN required" };
  }
  try {
    const r = await fetch(EDC_REFUND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txnId: opts.txnId,
        managerPin: opts.managerPin,
        managerName: opts.managerName || "",
      }),
    });
    const data = await r.json().catch(() => ({} as any));
    if (r.ok && data?.ok) {
      return { ok: true, refundId: data.refundId ? String(data.refundId) : undefined };
    }
    const reason = (data?.reason as RefundEdcChargeResult["reason"]) || "error";
    return { ok: false, reason, errorMessage: data?.error || `HTTP ${r.status}` };
  } catch (e: any) {
    return { ok: false, reason: "error", errorMessage: e?.message || "Network error" };
  }
}

/** Default client-side timeout — matches the EDC's customer-tap window.
 *  After this elapses with no terminal status, the dialog gives up and
 *  surfaces a "timeout — try again" state to the bouncer. The server
 *  will eventually reconcile via webhook either way. */
export const EDC_CLIENT_TIMEOUT_MS = 60_000;
