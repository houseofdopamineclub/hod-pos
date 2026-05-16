// hod-functions-patch/sendBookingEmail.js
// ────────────────────────────────────────────────────────────────────────────
// HOD — auto-email booking confirmation to the customer the moment a Walk-In
// or customer-site booking lands in Firestore. Triggers on `bookings/{id}`
// onCreate. FROM = houseofdopamineclub@gmail.com (Khushi's verified Gmail).
//
// CRITICAL — Gmail App Password setup (one-time, takes ~3 minutes):
//   1) https://myaccount.google.com/apppasswords  (sign in as
//      houseofdopamineclub@gmail.com)
//   2) Pick "Mail" → "Other (Custom)" → name it "HOD Cloud Function"
//   3) Copy the 16-char password Google shows you (keep no spaces)
//   4) Set the secret in Firebase:
//        firebase functions:secrets:set GMAIL_APP_PASSWORD
//      (paste the 16-char password when prompted)
//
// FALLBACK behavior (per Khushi's "fail-open" rule):
//   - If GMAIL_APP_PASSWORD is missing, function logs a warning + returns
//     OK so the booking write isn't blocked.
//   - If SMTP send fails, error is logged to `_meta/emailLog/events/{id}`
//     and returns OK (booking is still saved, customer just doesn't get
//     the email — door girl can still SEND MENU on WhatsApp manually).
//   - If `email` field is empty / invalid, function exits silently.
// ────────────────────────────────────────────────────────────────────────────

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
const FROM_ADDRESS = "houseofdopamineclub@gmail.com";

// Tiny HTML escaper (we don't ship a full template engine for one email).
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function buildEmailHtml(b) {
  const name = esc(b.name || "Guest");
  const ref = esc(b.ref || "");
  const total = Number(b.total || 0);
  const guests = Number(b.guests || 1);
  const eventTitle = esc(b.eventTitle || "Tonight at H.O.D");
  const date = esc(b.date || "");
  const tier = esc(b.tier || b.type || "");
  const walletUrl = `https://hodclub.in/?wallet=${encodeURIComponent(b.ref || "")}`;
  const menuUrl = "https://hodclub.in/";
  const totalLine = total > 0 ? `<tr><td style="padding:6px 0;color:#888">Amount</td><td style="padding:6px 0;font-weight:700;color:#C9A84C">₹${total.toLocaleString("en-IN")}</td></tr>` : "";

  return `<!doctype html>
<html><body style="margin:0;background:#0a0a0a;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#f5f5f5">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <div style="text-align:center;font-family:'Playfair Display',serif;font-size:28px;font-weight:900;color:#C9A84C;letter-spacing:2px;margin-bottom:8px">H.O.D</div>
    <div style="text-align:center;font-size:11px;color:#888;letter-spacing:3px;margin-bottom:32px">HOUSE OF DOPAMINE</div>
    <div style="background:#141414;border:1px solid #2a2a2a;border-radius:14px;padding:24px;margin-bottom:20px">
      <div style="font-size:22px;font-weight:900;color:#C9A84C;margin-bottom:6px">✅ Booking Confirmed</div>
      <div style="font-size:14px;color:#bbb;margin-bottom:18px">Hi ${name}, you're on the list.</div>
      <table style="width:100%;font-size:13px;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#888">Reference</td><td style="padding:6px 0;font-family:monospace;color:#fff">${ref}</td></tr>
        <tr><td style="padding:6px 0;color:#888">Event</td><td style="padding:6px 0;color:#fff">${eventTitle}</td></tr>
        ${date ? `<tr><td style="padding:6px 0;color:#888">Date</td><td style="padding:6px 0;color:#fff">${date}</td></tr>` : ""}
        ${tier ? `<tr><td style="padding:6px 0;color:#888">Entry</td><td style="padding:6px 0;color:#fff">${tier}</td></tr>` : ""}
        <tr><td style="padding:6px 0;color:#888">Guests</td><td style="padding:6px 0;color:#fff">${guests}</td></tr>
        ${totalLine}
      </table>
    </div>
    <div style="text-align:center;margin-bottom:18px">
      <a href="${walletUrl}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#C9A84C,#A07830);color:#0a0a0a;text-decoration:none;border-radius:10px;font-weight:900;font-size:14px;letter-spacing:.5px">View Your Ticket</a>
    </div>
    <div style="text-align:center;font-size:12px;color:#888;margin-bottom:8px">Browse the menu before you arrive:<br><a href="${menuUrl}" style="color:#C9A84C">${menuUrl}</a></div>
    <div style="text-align:center;font-size:11px;color:#666;margin-top:30px;line-height:1.6">
      📍 House of Dopamine, Koramangala, Bangalore<br>
      Doors open 9:00 PM · No entry after 1:30 AM
    </div>
  </div>
</body></html>`;
}

exports.sendBookingEmail = onDocumentCreated(
  {
    document: "bookings/{id}",
    region: "asia-south1",
    secrets: [GMAIL_APP_PASSWORD],
  },
  async (event) => {
    const b = event.data?.data();
    if (!b) return null;

    const email = String(b.email || "").trim();
    if (!email || !email.includes("@") || email.length < 5) {
      console.log("[email] skip — no valid email", b.ref);
      return null;
    }

    // Fail-open: missing secret = warn + return OK.
    const pwd = GMAIL_APP_PASSWORD.value();
    if (!pwd) {
      console.warn("[email] GMAIL_APP_PASSWORD not set — skipping send for", b.ref);
      return null;
    }

    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: FROM_ADDRESS, pass: pwd },
      });

      const info = await transporter.sendMail({
        from: `"H.O.D — House of Dopamine" <${FROM_ADDRESS}>`,
        to: email,
        subject: `✅ Your H.O.D booking is confirmed — ${b.ref || ""}`.trim(),
        html: buildEmailHtml(b),
      });

      // Best-effort audit. Don't throw if this write fails — the email
      // already left the building.
      try {
        await admin.firestore()
          .collection("_meta").doc("emailLog")
          .collection("events").doc(b.ref || event.params.id)
          .set({
            ref: b.ref || event.params.id,
            to: email,
            messageId: info.messageId || "",
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            status: "sent",
          }, { merge: true });
      } catch (e) {
        console.warn("[email] audit write failed", e);
      }

      console.log("[email] sent to", email, "ref", b.ref);
      return null;
    } catch (e) {
      console.error("[email] send failed", b.ref, e);
      try {
        await admin.firestore()
          .collection("_meta").doc("emailLog")
          .collection("events").doc(b.ref || event.params.id)
          .set({
            ref: b.ref || event.params.id,
            to: email,
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            status: "failed",
            error: String(e?.message || e).slice(0, 500),
          }, { merge: true });
      } catch (_) {}
      return null;
    }
  }
);
