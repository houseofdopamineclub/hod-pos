// EDC Cloud — reference implementation skeleton.
// COPY this file into the separate `hod-tickets` Firebase Functions project
// (under e.g. `functions/src/edc/index.ts`) and wire the exports from
// `functions/src/index.ts`. It does NOT live in this monorepo's runtime.
//
// Region: asia-south1 (matches the existing `createWalletOrder` /
// `verifyRechargePayment` / `razorpayWebhook` set).
//
// All functions are 2nd-gen HTTPS. Adjust to `onRequest` from
// `firebase-functions/v2/https` if your project pins v2.

import * as functionsV1 from "firebase-functions";
import * as admin from "firebase-admin";
import * as crypto from "crypto";

if (admin.apps.length === 0) admin.initializeApp();
const db = admin.firestore();

// ── Secrets / config ───────────────────────────────────────────────────────
const RZP_KEY_ID         = process.env.RAZORPAY_KEY_ID         || "";
const RZP_KEY_SECRET     = process.env.RAZORPAY_KEY_SECRET     || "";
const RZP_TERMINAL_ID    = process.env.RAZORPAY_EDC_TERMINAL_ID|| "";
const RZP_WEBHOOK_SECRET = process.env.RAZORPAY_EDC_WEBHOOK_SECRET || "";
const PIN_SALT           = process.env.EDC_BOUNCER_PIN_SALT    || "";

// Pine Labs Plutus Smart Cloud — set via `firebase functions:secrets:set`.
// Default base URL points at production; override with PINELABS_BASE_URL
// when testing against UAT (https://www.plutuscloudserviceuat.in:8201).
const PL_BASE_URL        = process.env.PINELABS_BASE_URL       || "https://www.plutuscloudservice.in:8201";
const PL_MERCHANT_ID     = process.env.PINELABS_MERCHANT_ID    || "";
const PL_STORE_ID        = process.env.PINELABS_STORE_ID       || "";
const PL_CLIENT_ID       = process.env.PINELABS_CLIENT_ID      || "";
const PL_SECURITY_TOKEN  = process.env.PINELABS_SECURITY_TOKEN || "";
const PL_WEBHOOK_SECRET  = process.env.PINELABS_WEBHOOK_SECRET || "";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Operational night "YYYY-MM-DD" — 12pm IST cutover, matches POS
 *  `getOperationalNightStr` (shift IST by -12h then take the date). */
function getOperationalNightStr(now = new Date()): string {
  const istShifted = new Date(now.getTime() + (5 * 60 + 30) * 60_000 - 12 * 3600_000);
  return istShifted.toISOString().slice(0, 10);
}

/** SHA-256 with project salt — never store the raw PIN. */
function hashPin(pin: string): string {
  return crypto.createHmac("sha256", PIN_SALT).update(pin).digest("hex");
}

/** Derive a deterministic txnId so refresh mid-flow does NOT double-charge. */
function deriveTxnId(bookingRef: string, coverRef: string): string {
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const raw = `${bookingRef}|${coverRef}|${minuteBucket}`;
  const h = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `edc_${getOperationalNightStr()}_${h}`;
}

/** Verify a bouncer PIN against `hodStaffPins/{name}` (same store the door-manager-PIN flow uses). */
async function verifyBouncerPin(pin: string): Promise<{ ok: boolean; name?: string }> {
  if (!/^\d{4,6}$/.test(pin)) return { ok: false };
  const hashed = hashPin(pin);
  const snap = await db.collection("hodStaffPins").where("pinHash", "==", hashed).limit(1).get();
  if (snap.empty) return { ok: false };
  const doc = snap.docs[0];
  return { ok: true, name: (doc.data().name as string) || doc.id };
}

/** Server-side canonical amount lookup — derived ONLY from trusted
 *  backend documents. Browser inputs (including expectedAmount) are
 *  never used as the source. Order:
 *    1. covers/{coverRef}.coverBalance — top-up / re-charge
 *    2. bookings/{bookingId}.total     — first-time activation
 *  Returns null if no source carries a positive amount; the caller then
 *  rejects with `no_amount` and the operator must use cash/UPI or have
 *  an admin update the booking total before retrying. */
async function readCanonicalAmount(
  bookingId: string,
  bookingRef: string,
  coverRef: string,
): Promise<number | null> {
  const cover = await db.collection("covers").doc(coverRef).get();
  if (cover.exists) {
    const d = cover.data() as any;
    if (d.bookingRef && bookingRef && d.bookingRef !== bookingRef) return null;
    const due = Number(d.coverBalance ?? d.amountDue ?? d.coverActivated ?? 0);
    if (due > 0) return due;
  }
  if (!bookingId) return null;
  const booking = await db.collection("bookings").doc(bookingId).get();
  if (!booking.exists) return null;
  const b = booking.data() as any;
  if (bookingRef && b.ref && b.ref !== bookingRef) return null;
  const bookingTotal = Number(b.total ?? b.coverPrice ?? 0);
  return bookingTotal > 0 ? bookingTotal : null;
}

// ── Shared charge preflight ────────────────────────────────────────────────
// Validates the inbound POST shared by both `edcChargeRazorpay` and
// `edcChargePineLabs`: PIN throttle + verify, canonical amount lookup,
// expectedAmount sanity check, and per-minute idempotency reservation.
// On success returns the txnId + canonical amount; on failure writes the
// HTTP response and returns null so the caller can early-exit.
//
// Both vendor functions share this so a future third vendor only needs
// to wire its own dispatch + webhook code.

type PreflightResult =
  | { ok: true; txnId: string; canonical: number; bouncerName: string }
  | { ok: false };

async function preflightAndReserve(
  req: functionsV1.https.Request,
  res: functionsV1.Response,
): Promise<PreflightResult> {
  const { bookingId, bookingRef, coverRef, bouncerPin, bouncerName, expectedAmount } = (req.body || {}) as {
    bookingId?: string; bookingRef?: string; coverRef?: string; bouncerPin?: string;
    bouncerName?: string; expectedAmount?: number;
  };
  if (!bookingId || !bookingRef || !coverRef || !bouncerPin) {
    res.status(400).json({ ok: false, reason: "bad_request" }); return { ok: false };
  }
  if (!PIN_SALT) {
    functionsV1.logger.error("EDC charge misconfigured: EDC_BOUNCER_PIN_SALT unset");
    res.status(500).json({ ok: false, reason: "no_terminal", error: "misconfigured" }); return { ok: false };
  }

  const ip = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim() || "unknown";
  const throttleRef = db.collection("edcPinThrottle").doc(ip);
  const throttle = await throttleRef.get();
  const tdata = throttle.exists ? (throttle.data() as { fails: number; firstAt: number }) : { fails: 0, firstAt: Date.now() };
  if (Date.now() - tdata.firstAt > 10 * 60_000) { tdata.fails = 0; tdata.firstAt = Date.now(); }
  if (tdata.fails >= 5) { res.status(429).json({ ok: false, reason: "bad_pin", error: "too_many_attempts" }); return { ok: false }; }

  const pinCheck = await verifyBouncerPin(bouncerPin);
  if (!pinCheck.ok) {
    await throttleRef.set({ fails: tdata.fails + 1, firstAt: tdata.firstAt }, { merge: true });
    res.status(403).json({ ok: false, reason: "bad_pin" }); return { ok: false };
  }
  if (tdata.fails > 0) await throttleRef.delete().catch(() => {});

  const canonical = await readCanonicalAmount(bookingId, bookingRef, coverRef);
  if (canonical == null || canonical <= 0) {
    res.status(400).json({ ok: false, reason: "no_amount" }); return { ok: false };
  }
  if (typeof expectedAmount === "number" && expectedAmount > 0 && Math.abs(expectedAmount - canonical) > 0.5) {
    res.status(409).json({ ok: false, reason: "amount_mismatch", canonical }); return { ok: false };
  }

  const txnId = deriveTxnId(bookingRef, coverRef);
  const txnRef = db.collection("edcTransactions").doc(txnId);
  const existing = await txnRef.get();
  if (existing.exists) {
    const status = existing.data()?.status;
    if (status === "pending" || status === "success") {
      res.json({ txnId }); return { ok: false };
    }
    if (status === "failed" || status === "cancelled") {
      res.status(409).json({ ok: false, reason: "vendor_error", error: `previous_${status}_in_same_minute` });
      return { ok: false };
    }
  }

  return { ok: true, txnId, canonical, bouncerName: bouncerName || pinCheck.name || "" };
}

function setCors(res: functionsV1.Response) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

// ── edcChargeRazorpay ──────────────────────────────────────────────────────
export const edcChargeRazorpay = functionsV1
  .region("asia-south1")
  .https.onRequest(async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST")    { res.status(405).json({ ok: false, reason: "method" }); return; }

    try {
      if (!RZP_TERMINAL_ID || !RZP_KEY_ID || !RZP_KEY_SECRET) {
        functionsV1.logger.error("edcChargeRazorpay misconfigured: missing required secrets");
        res.status(500).json({ ok: false, reason: "no_terminal", error: "misconfigured" }); return;
      }

      const pre = await preflightAndReserve(req, res);
      if (!pre.ok) return;
      const { txnId, canonical, bouncerName } = pre;
      const { bouncerPin, bookingRef, coverRef } = req.body as {
        bouncerPin: string; bookingRef: string; coverRef: string;
      };

      // Dispatch to Razorpay POS Terminal API.
      // POST https://api.razorpay.com/v1/terminals/{terminal_id}/payments
      // Auth: Basic base64(RZP_KEY_ID:RZP_KEY_SECRET)
      // Body: { amount: canonical*100, currency: "INR", reference_id: txnId, description: bookingRef }
      const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");
      const dispatch = await fetch(
        `https://api.razorpay.com/v1/terminals/${RZP_TERMINAL_ID}/payments`,
        {
          method: "POST",
          headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: Math.round(canonical * 100),
            currency: "INR",
            reference_id: txnId,
            description: `HOD cover ${bookingRef}`,
          }),
        },
      );
      const dispatchJson: any = await dispatch.json().catch(() => ({}));
      const txnRef = db.collection("edcTransactions").doc(txnId);
      if (!dispatch.ok) {
        await txnRef.set({
          bookingRef, coverRef, vendor: "razorpay", terminalId: RZP_TERMINAL_ID,
          amount: canonical, status: "failed",
          errorReason: dispatchJson?.error?.description || `razorpay_${dispatch.status}`,
          bouncerPin: hashPin(bouncerPin), bouncerName,
          date: getOperationalNightStr(),
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        res.status(502).json({ ok: false, reason: "vendor_error", error: dispatchJson?.error?.description }); return;
      }

      await txnRef.set({
        bookingRef, coverRef, vendor: "razorpay", terminalId: RZP_TERMINAL_ID,
        amount: canonical, status: "pending",
        razorpayIntentId: dispatchJson?.id || "",
        bouncerPin: hashPin(bouncerPin), bouncerName,
        date: getOperationalNightStr(),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      res.json({ txnId });
    } catch (e: any) {
      functionsV1.logger.error("edcChargeRazorpay error", e);
      res.status(500).json({ ok: false, reason: "error", error: String(e?.message || e) });
    }
  });

// ── edcChargePineLabs ──────────────────────────────────────────────────────
// Dispatches a sale to Pine Labs Plutus Smart Cloud (the cloud-paired
// variant of the Plutus terminal — no on-prem POS-bridge daemon needed).
// API contract: POST {PL_BASE_URL}/API/CloudBasedIntegration/V1/UploadBilledTransaction
// with the standard MerchantID + StoreID + ClientID + SecurityToken auth
// envelope. Amount is in paise. The terminal then prompts the customer
// to tap, and Pine Labs POSTs the result to `pineLabsEdcWebhook`.
//
// We treat `PlutusTransactionReferenceID` as the vendor intent id (mirrors
// `razorpayIntentId`). The webhook later writes `pineLabsRef` (the human-
// readable RRN/auth code printed on the slip) once the swipe completes.
export const edcChargePineLabs = functionsV1
  .region("asia-south1")
  .https.onRequest(async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST")    { res.status(405).json({ ok: false, reason: "method" }); return; }

    try {
      if (!PL_MERCHANT_ID || !PL_STORE_ID || !PL_CLIENT_ID || !PL_SECURITY_TOKEN) {
        functionsV1.logger.error("edcChargePineLabs misconfigured: missing PINELABS_* secrets");
        res.status(500).json({ ok: false, reason: "vendor_disabled", error: "Pine Labs not configured for this venue." }); return;
      }

      const pre = await preflightAndReserve(req, res);
      if (!pre.ok) return;
      const { txnId, canonical, bouncerName } = pre;
      const { bouncerPin, bookingRef, coverRef } = req.body as {
        bouncerPin: string; bookingRef: string; coverRef: string;
      };

      // Plutus Smart Cloud "UploadBilledTransaction" — TransactionType "1"
      // = Sale, AllowedPaymentMode "0" = All (card networks accepted by
      // the terminal). AutoCancelDurationInMinutes mirrors the client-side
      // 60s tap window so a stuck transaction self-aborts on the EDC.
      const dispatch = await fetch(
        `${PL_BASE_URL}/API/CloudBasedIntegration/V1/UploadBilledTransaction`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            Header: { ApplicationId: PL_CLIENT_ID, MethodId: "1001", VersionNo: "1.0" },
            Detail: {
              MerchantID: PL_MERCHANT_ID,
              StoreID: PL_STORE_ID,
              ClientID: PL_CLIENT_ID,
              SecurityToken: PL_SECURITY_TOKEN,
              AutoCancelDurationInMinutes: 1,
              TransactionType: "1",
              AllowedPaymentMode: "0",
              BilledAmount: Math.round(canonical * 100),
              PaymentAmount: Math.round(canonical * 100),
              BillingRefNo: txnId,
              TransactionRefNo: txnId,
            },
          }),
        },
      );
      const dispatchJson: any = await dispatch.json().catch(() => ({}));
      const txnRef = db.collection("edcTransactions").doc(txnId);
      // Plutus returns ResponseCode `0` for accepted dispatch; anything
      // else is a vendor-side reject (terminal offline, bad token, etc).
      const responseCode = Number(dispatchJson?.ResponseCode ?? -1);
      const accepted = dispatch.ok && responseCode === 0;
      if (!accepted) {
        await txnRef.set({
          bookingRef, coverRef, vendor: "pinelabs", terminalId: PL_STORE_ID,
          amount: canonical, status: "failed",
          errorReason: dispatchJson?.ResponseMessage || `pinelabs_${dispatch.status}_code_${responseCode}`,
          bouncerPin: hashPin(bouncerPin), bouncerName,
          date: getOperationalNightStr(),
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        res.status(502).json({
          ok: false, reason: "vendor_error",
          error: dispatchJson?.ResponseMessage || `Pine Labs rejected the charge (code ${responseCode}).`,
        });
        return;
      }

      await txnRef.set({
        bookingRef, coverRef, vendor: "pinelabs", terminalId: PL_STORE_ID,
        amount: canonical, status: "pending",
        // Plutus ref id is numeric — store as string for consistency.
        pineLabsIntentId: String(dispatchJson?.PlutusTransactionReferenceID || ""),
        bouncerPin: hashPin(bouncerPin), bouncerName,
        date: getOperationalNightStr(),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      res.json({ txnId });
    } catch (e: any) {
      functionsV1.logger.error("edcChargePineLabs error", e);
      res.status(500).json({ ok: false, reason: "error", error: String(e?.message || e) });
    }
  });

// ── edcCancelCharge ────────────────────────────────────────────────────────
export const edcCancelCharge = functionsV1
  .region("asia-south1")
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    try {
      const { txnId } = (req.body || {}) as { txnId?: string };
      if (!txnId) { res.status(400).json({ ok: false }); return; }
      const ref = db.collection("edcTransactions").doc(txnId);
      const snap = await ref.get();
      if (!snap.exists) { res.status(404).json({ ok: false }); return; }
      const d = snap.data() as any;
      if (d.status !== "pending") { res.json({ ok: true, status: d.status }); return; }
      // Best-effort vendor cancel — Razorpay POS supports DELETE on the intent.
      if (d.vendor === "razorpay" && d.razorpayIntentId) {
        const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");
        await fetch(`https://api.razorpay.com/v1/payments/${d.razorpayIntentId}/cancel`, {
          method: "POST", headers: { Authorization: `Basic ${auth}` },
        }).catch(() => {});
      }
      // Pine Labs Plutus Smart Cloud — `CancelTransactionForceCloud` with
      // the same MerchantID/StoreID/ClientID/SecurityToken envelope and
      // the original PlutusTransactionReferenceID.
      if (d.vendor === "pinelabs" && d.pineLabsIntentId && PL_MERCHANT_ID) {
        await fetch(
          `${PL_BASE_URL}/API/CloudBasedIntegration/V1/CancelTransactionForce`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              Header: { ApplicationId: PL_CLIENT_ID, MethodId: "1003", VersionNo: "1.0" },
              Detail: {
                MerchantID: PL_MERCHANT_ID,
                StoreID: PL_STORE_ID,
                ClientID: PL_CLIENT_ID,
                SecurityToken: PL_SECURITY_TOKEN,
                PlutusTransactionReferenceID: d.pineLabsIntentId,
              },
            }),
          },
        ).catch(() => {});
      }
      await ref.update({ status: "cancelled", updatedAt: new Date().toISOString(), errorReason: "cancelled_by_user" });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

// ── razorpayEdcWebhook ─────────────────────────────────────────────────────
// Razorpay POS Terminal webhooks land here. We HMAC-verify against the raw
// request body (NOT JSON.stringify(req.body) — re-serialization changes
// whitespace and breaks the signature) then promote the matching
// `edcTransactions` doc to success / failed / cancelled.
//
// Razorpay POS Terminal emits `transaction.captured`, `transaction.failed`,
// `transaction.cancelled` events with `payload.transaction.entity` carrying
// the txn fields. We also accept the legacy `payment.*` event names so a
// single webhook can ingest both POS Terminal and standard Razorpay
// payment events from the same merchant account.
//
// IMPORTANT: in `firebase-functions` v1, `req.rawBody` is a Buffer of the
// untouched bytes. Always sign that, not a re-stringified body.
export const razorpayEdcWebhook = functionsV1
  .region("asia-south1")
  .https.onRequest(async (req, res) => {
    try {
      // Hard guard: refuse to process webhooks if the secret is unset,
      // otherwise an empty key would let any caller forge a "success".
      if (!RZP_WEBHOOK_SECRET) {
        functionsV1.logger.error("razorpayEdcWebhook misconfigured: RAZORPAY_EDC_WEBHOOK_SECRET unset");
        res.status(500).send("misconfigured"); return;
      }
      const signature = req.get("x-razorpay-signature") || "";
      const rawBody = (req as any).rawBody as Buffer | undefined;
      if (!rawBody) { res.status(400).send("no_raw_body"); return; }
      const expected = crypto.createHmac("sha256", RZP_WEBHOOK_SECRET).update(rawBody).digest("hex");
      if (signature !== expected) { res.status(401).send("bad_signature"); return; }

      const evt = req.body || {};
      const evtName: string = evt.event || "";
      // POS Terminal events use `payload.transaction.entity`; standard
      // Razorpay payment events use `payload.payment.entity`. Accept either
      // so we don't silently drop the event we actually need.
      const txn = evt?.payload?.transaction?.entity || evt?.payload?.payment?.entity || {};
      const refId = txn.reference_id || txn.notes?.txnId || "";
      if (!refId) { res.status(200).send("no_ref"); return; }

      const ref = db.collection("edcTransactions").doc(refId);
      const snap = await ref.get();
      if (!snap.exists) { res.status(200).send("unknown_txn"); return; }

      const isCaptured  = evtName === "transaction.captured"  || evtName === "payment.captured"  || txn.status === "captured" || txn.status === "success";
      const isFailed    = evtName === "transaction.failed"    || evtName === "payment.failed"    || txn.status === "failed"   || txn.status === "declined";
      const isCancelled = evtName === "transaction.cancelled" || evtName === "payment.cancelled" || txn.status === "cancelled";
      const status = isCaptured ? "success" : isFailed ? "failed" : isCancelled ? "cancelled" : (snap.data()?.status || "pending");

      await ref.update({
        status,
        razorpayPaymentId: txn.payment_id || txn.id || "",
        last4:       txn.card?.last4   || "",
        cardNetwork: txn.card?.network || "",
        edcRef:      txn.acquirer_data?.rrn || txn.acquirer_data?.auth_code || txn.terminal?.reference_id || "",
        errorReason: isFailed ? (txn.error_description || txn.error_reason || "declined") : "",
        updatedAt: new Date().toISOString(),
      });
      res.status(200).send("ok");
    } catch (e: any) {
      functionsV1.logger.error("razorpayEdcWebhook error", e);
      res.status(500).send("error");
    }
  });

// ── pineLabsEdcWebhook ─────────────────────────────────────────────────────
// Pine Labs Plutus Smart Cloud posts the swipe result here ("Status
// Notification URL" configured on the Pine Labs merchant dashboard).
// HMAC-SHA256 over the raw request body, signed with PINELABS_WEBHOOK_SECRET,
// is sent in the `X-PineLabs-Signature` header (some merchant accounts use
// `X-Plutus-Signature` — we accept either).
//
// The payload mirrors `GetCloudBasedTxnStatus`:
//   { BillingRefNo, PlutusTransactionReferenceID, ResponseCode,
//     ResponseMessage, TransactionData: { ApprovalCode, RRN,
//     CardNumber: "************1234", CardType, ... } }
// ResponseCode 0 = Approved, 1 = Cancelled, anything else = Failed.
export const pineLabsEdcWebhook = functionsV1
  .region("asia-south1")
  .https.onRequest(async (req, res) => {
    try {
      if (!PL_WEBHOOK_SECRET) {
        functionsV1.logger.error("pineLabsEdcWebhook misconfigured: PINELABS_WEBHOOK_SECRET unset");
        res.status(500).send("misconfigured"); return;
      }
      const signature = (req.get("x-pinelabs-signature") || req.get("x-plutus-signature") || "").trim();
      const rawBody = (req as any).rawBody as Buffer | undefined;
      if (!rawBody) { res.status(400).send("no_raw_body"); return; }
      const expected = crypto.createHmac("sha256", PL_WEBHOOK_SECRET).update(rawBody).digest("hex");
      // Constant-time compare to avoid a timing oracle on the secret.
      const sigBuf = Buffer.from(signature, "hex");
      const expBuf = Buffer.from(expected, "hex");
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        res.status(401).send("bad_signature"); return;
      }

      const body = (req.body || {}) as any;
      const refId: string = body.BillingRefNo || body.TransactionRefNo || "";
      if (!refId) { res.status(200).send("no_ref"); return; }

      const ref = db.collection("edcTransactions").doc(refId);
      const snap = await ref.get();
      if (!snap.exists) { res.status(200).send("unknown_txn"); return; }

      const code = Number(body.ResponseCode ?? -1);
      const txData = (body.TransactionData || {}) as any;
      const status: "success" | "failed" | "cancelled" | "pending" =
        code === 0 ? "success"
        : code === 1 ? "cancelled"
        : code > 0 ? "failed"
        : (snap.data()?.status || "pending");

      // Pine Labs masks the PAN as "************1234" — strip to last 4.
      const pan: string = String(txData.CardNumber || txData.MaskedCardNo || "");
      const last4 = pan.replace(/\D/g, "").slice(-4);

      await ref.update({
        status,
        pineLabsRef: String(txData.RRN || txData.ApprovalCode || body.PlutusTransactionReferenceID || ""),
        last4,
        cardNetwork: String(txData.CardType || txData.AcquirerName || ""),
        edcRef: String(txData.RRN || txData.ApprovalCode || ""),
        errorReason: status === "failed" ? (body.ResponseMessage || "declined") : "",
        updatedAt: new Date().toISOString(),
      });
      res.status(200).send("ok");
    } catch (e: any) {
      functionsV1.logger.error("pineLabsEdcWebhook error", e);
      res.status(500).send("error");
    }
  });
