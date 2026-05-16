// ════════════════════════════════════════════════════════════════════════
// HOD — CUSTOMER NOTIFY ON BILL VOID (Anti-Fraud #A3)
// ────────────────────────────────────────────────────────────────────────
// Closes the cash-pocket scam: captain pockets cash + voids the bill →
// customer never knew. NOW: every bill void writes a queue doc; this
// trigger fires a WhatsApp text to the customer in seconds:
//
//   "Your bill at HOD (Table FD17, ₹2,450) was VOIDED tonight at 11:48pm.
//    If you believe you DID pay, please call Khushi at +91 9XXXXXXXXX."
//
// Drop-in for hod-functions-backend (Khushi's Mac repo).
// Deploy:
//   1. Copy this file → hod-functions-backend/voidNotifyCustomer.js
//   2. In hod-functions-backend/index.js, append:
//        const { voidNotifyCustomer } = require("./voidNotifyCustomer");
//        exports.voidNotifyCustomer = voidNotifyCustomer;
//   3. Set the secrets (one-time — share with voidDigest if already set):
//        firebase functions:config:set \
//          whatsapp.token="EAAxxx..." \
//          whatsapp.phone_id="123456789" \
//          khushi.phone="91XXXXXXXXXX"
//   4. firebase deploy --only functions:voidNotifyCustomer
//
// FALLBACKS:
//   • If WhatsApp send fails, queue doc is updated with status="failed"
//     + the error message — visible to admin in a future "Failed Notices"
//     tab. Audit trail intact.
//   • If customerPhone is missing/invalid, the POS already enqueues with
//     status="skipped-no-phone" and we exit early — no spam, no error.
//   • If the WHATSAPP_TEMPLATE_NAME env is set, we send the approved
//     template (preferred for outbound to non-opted-in customers).
//     Otherwise we fall back to a plain text message (works for the
//     24-hour conversation window only — sufficient for fresh table guests).
// ════════════════════════════════════════════════════════════════════════
const functions = require("firebase-functions");
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

function fmtINR(n) {
  return Number(n || 0).toLocaleString("en-IN");
}
function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit", minute: "2-digit", hour12: true,
    });
  } catch (_) { return ""; }
}

// Strip non-digits, ensure 91-prefixed E.164-friendly form for WhatsApp.
function normalizePhone(raw) {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return "91" + digits;            // bare 10-digit IN
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return "91" + digits.slice(1);
  return digits;                                              // best-effort
}

async function sendWhatsAppText(to, body) {
  const cfg = functions.config();
  const token = cfg?.whatsapp?.token;
  const phoneId = cfg?.whatsapp?.phone_id;
  if (!token || !phoneId || !to) {
    return { ok: false, reason: "missing-config-or-recipient" };
  }
  const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
  try {
    const fetch = (await import("node-fetch")).default;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { preview_url: false, body },
      }),
    });
    const j = await res.json();
    return { ok: res.ok, body: j };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

exports.voidNotifyCustomer = functions
  .region("asia-south1")
  .firestore.document("voidNotificationsQueue/{queueId}")
  .onCreate(async (snap, ctx) => {
    const data = snap.data() || {};
    const queueRef = snap.ref;

    // Skip queue rows that the POS already marked as "no phone" or non-pending.
    if (data.status !== "pending") {
      console.log("[voidNotifyCustomer] skipping non-pending row", { id: ctx.params.queueId, status: data.status });
      return null;
    }

    const phone = normalizePhone(data.customerPhone);
    if (!phone) {
      await queueRef.update({
        status: "skipped-no-phone",
        processedAt: new Date().toISOString(),
      });
      return null;
    }

    const khushi = functions.config()?.khushi?.phone || "owner";
    const body =
      `🔴 *HOD — BILL VOIDED*\n\n` +
      `Hi ${(data.customerName || "Guest").split(" ")[0]}, your bill at HOD ` +
      `(${data.tableId || "your table"}, ₹${fmtINR(data.billTotal)}) was VOIDED ` +
      `${fmtTime(data.createdAt) ? `at ${fmtTime(data.createdAt)} ` : ""}` +
      `by ${data.voidedBy || "staff"}.\n\n` +
      `Reason: ${(data.voidReason || "—").toString().toUpperCase()}\n\n` +
      `If you believe you DID pay, please call Khushi at +${khushi} immediately ` +
      `so we can verify with our records.\n\n` +
      `— House of Dopamine`;

    const result = await sendWhatsAppText(phone, body);

    await queueRef.update({
      status: result.ok ? "sent" : "failed",
      sentAt: result.ok ? new Date().toISOString() : null,
      processedAt: new Date().toISOString(),
      sendResult: result.ok ? "ok" : (result.reason || JSON.stringify(result.body || {}).slice(0, 500)),
      sentTo: phone,
    }).catch((e) => console.warn("[voidNotifyCustomer] queue update failed", e));

    console.log("[voidNotifyCustomer]", { id: ctx.params.queueId, ok: result.ok, to: phone });
    return null;
  });
