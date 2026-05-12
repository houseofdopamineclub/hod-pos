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

// ── edcChargeRazorpay ──────────────────────────────────────────────────────
export const edcChargeRazorpay = functionsV1
  .region("asia-south1")
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST")    { res.status(405).json({ ok: false, reason: "method" }); return; }

    try {
      const { bookingId, bookingRef, coverRef, bouncerPin, bouncerName, expectedAmount } = (req.body || {}) as {
        bookingId?: string; bookingRef?: string; coverRef?: string; bouncerPin?: string;
        bouncerName?: string; expectedAmount?: number;
      };
      if (!bookingId || !bookingRef || !coverRef || !bouncerPin) {
        res.status(400).json({ ok: false, reason: "bad_request" }); return;
      }
      if (!RZP_TERMINAL_ID || !RZP_KEY_ID || !RZP_KEY_SECRET || !PIN_SALT) {
        functionsV1.logger.error("edcChargeRazorpay misconfigured: missing required secrets");
        res.status(500).json({ ok: false, reason: "no_terminal", error: "misconfigured" }); return;
      }

      // Per-IP PIN attempt throttling — 5 failed PINs / 10 min locks
      // the source IP. Mitigates online brute-force on the 4–6 digit
      // bouncer PIN. App Check should also be enabled at the function
      // config level (see README) for full hardening.
      const ip = (req.headers["x-forwarded-for"] as string || req.ip || "").split(",")[0].trim() || "unknown";
      const throttleRef = db.collection("edcPinThrottle").doc(ip);
      const throttle = await throttleRef.get();
      const tdata = throttle.exists ? (throttle.data() as { fails: number; firstAt: number }) : { fails: 0, firstAt: Date.now() };
      if (Date.now() - tdata.firstAt > 10 * 60_000) { tdata.fails = 0; tdata.firstAt = Date.now(); }
      if (tdata.fails >= 5) { res.status(429).json({ ok: false, reason: "bad_pin", error: "too_many_attempts" }); return; }

      const pinCheck = await verifyBouncerPin(bouncerPin);
      if (!pinCheck.ok) {
        await throttleRef.set({ fails: tdata.fails + 1, firstAt: tdata.firstAt }, { merge: true });
        res.status(403).json({ ok: false, reason: "bad_pin" }); return;
      }
      if (tdata.fails > 0) await throttleRef.delete().catch(() => {});

      const canonical = await readCanonicalAmount(bookingId, bookingRef, coverRef);
      if (canonical == null || canonical <= 0) {
        res.status(400).json({ ok: false, reason: "no_amount" }); return;
      }
      // Refuse if client-displayed amount diverges from server canonical.
      if (typeof expectedAmount === "number" && expectedAmount > 0 && Math.abs(expectedAmount - canonical) > 0.5) {
        res.status(409).json({ ok: false, reason: "amount_mismatch", canonical }); return;
      }

      const txnId = deriveTxnId(bookingRef, coverRef);
      const txnRef = db.collection("edcTransactions").doc(txnId);
      const existing = await txnRef.get();
      if (existing.exists) {
        // Idempotency: never re-dispatch for terminal states within the
        // same minute bucket — pending/success returns existing txnId,
        // failed/cancelled requires operator to wait or change input.
        const status = existing.data()?.status;
        if (status === "pending" || status === "success") {
          res.json({ txnId }); return;
        }
        if (status === "failed" || status === "cancelled") {
          res.status(409).json({ ok: false, reason: "vendor_error", error: `previous_${status}_in_same_minute` });
          return;
        }
      }

      // Dispatch to Razorpay POS Terminal API. (Pseudo — wire to your Razorpay client.)
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
      if (!dispatch.ok) {
        await txnRef.set({
          bookingRef, coverRef, vendor: "razorpay", terminalId: RZP_TERMINAL_ID,
          amount: canonical, status: "failed",
          errorReason: dispatchJson?.error?.description || `razorpay_${dispatch.status}`,
          bouncerPin: hashPin(bouncerPin), bouncerName: bouncerName || pinCheck.name || "",
          date: getOperationalNightStr(),
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        res.status(502).json({ ok: false, reason: "vendor_error", error: dispatchJson?.error?.description }); return;
      }

      await txnRef.set({
        bookingRef, coverRef, vendor: "razorpay", terminalId: RZP_TERMINAL_ID,
        amount: canonical, status: "pending",
        razorpayIntentId: dispatchJson?.id || "",
        bouncerPin: hashPin(bouncerPin), bouncerName: bouncerName || pinCheck.name || "",
        date: getOperationalNightStr(),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      res.json({ txnId });
    } catch (e: any) {
      functionsV1.logger.error("edcChargeRazorpay error", e);
      res.status(500).json({ ok: false, reason: "error", error: String(e?.message || e) });
    }
  });

// ── edcChargePineLabs (Phase 2 placeholder) ────────────────────────────────
export const edcChargePineLabs = functionsV1
  .region("asia-south1")
  .https.onRequest(async (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.json({ ok: false, reason: "vendor_disabled", error: "Pine Labs integration arrives in Phase 2." });
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

// ── pineLabsEdcWebhook (Phase 2 placeholder) ───────────────────────────────
export const pineLabsEdcWebhook = functionsV1
  .region("asia-south1")
  .https.onRequest(async (_req, res) => { res.status(200).send("phase2"); });
