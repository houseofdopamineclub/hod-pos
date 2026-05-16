# 📧 DEPLOY — AUTO-EMAIL BOOKING CONFIRMATION

**WHAT THIS DOES**
Every time a customer books on hodclub.in OR the door girl saves a walk-in
in POS, this Cloud Function fires automatically and sends a beautiful HTML
confirmation email from `houseofdopamineclub@gmail.com` to the customer's
inbox. NO Replit tab, NO manual sending.

**WHEN IT RUNS** — instantly on `bookings/{id}` Firestore doc create.

**FAIL-OPEN BEHAVIOR (per your rule)** — if the email send breaks, the
booking is STILL saved. Customer just doesn't get the email. Door girl
can SEND MENU on WhatsApp instead.

---

## 🟢 STEP 1 — GET A GMAIL APP PASSWORD (3 minutes, one-time)

1. Open https://myaccount.google.com/apppasswords
2. Sign in as **houseofdopamineclub@gmail.com**
3. (If asked) Turn ON 2-Step Verification first — required by Google.
4. Click **Select app** → **Mail**.
5. Click **Select device** → **Other (Custom name)** → type **HOD Cloud Function**.
6. Click **Generate**.
7. Google shows you a yellow box with a **16-character password** like
   `abcd efgh ijkl mnop`. **Copy it (no spaces)** — you'll never see
   it again.

---

## 🟢 STEP 2 — STORE THE PASSWORD AS A FIREBASE SECRET

On your Mac, in your `hod-functions-backend` folder:

```bash
firebase functions:secrets:set GMAIL_APP_PASSWORD
```

When it asks "Enter a value for GMAIL_APP_PASSWORD:" → paste the
16 characters from Step 1 → press Enter.

You'll see: `✓ Created a new secret version`. Done.

---

## 🟢 STEP 3 — DROP THE FILE INTO YOUR BACKEND REPO

Copy `sendBookingEmail.js` from this `hod-functions-patch/` folder into:

```
~/Desktop/hod-functions-backend/sendBookingEmail.js
```

---

## 🟢 STEP 4 — INSTALL nodemailer (one-time)

```bash
cd ~/Desktop/hod-functions-backend
npm install nodemailer
```

---

## 🟢 STEP 5 — WIRE IT INTO `index.js`

Open `~/Desktop/hod-functions-backend/index.js` and add this line **at
the very bottom** (anywhere after the other `exports.X` lines):

```js
exports.sendBookingEmail = require("./sendBookingEmail").sendBookingEmail;
```

---

## 🟢 STEP 6 — DEPLOY

```bash
cd ~/Desktop/hod-functions-backend
firebase deploy --only functions:sendBookingEmail
```

Wait ~2 minutes. You'll see:
```
✔  functions[sendBookingEmail(asia-south1)] Successful create operation.
```

---

## 🟢 STEP 7 — SMOKE TEST

1. Go to hodclub.in → make a real test booking with **your own email**.
2. Within 5–10 seconds you should get a beautiful gold-on-black email.
3. Check Firebase Console → Firestore → `_meta/emailLog/events/<ref>`
   should show `status: "sent"`.

If nothing arrives within 30 seconds:
- Firebase Console → Functions → `sendBookingEmail` → Logs
- Look for `[email] send failed` or `[email] skip`
- The most common issue is the App Password being wrong — re-do Step 2.

---

## 🛑 ROLLBACK (if anything breaks)

Bookings are NEVER blocked by this function — if email fails, the
booking still saves and the customer can still arrive normally.

To fully remove:
```bash
firebase functions:delete sendBookingEmail --region asia-south1
```

(This also removes the Door Mode auto-email — door girl can still SEND
MENU on WhatsApp from the success screen as fallback.)

---

## 📝 NOTES

- Gmail's free tier allows ~500 emails/day from a single account, more
  than enough for HOD's ~50–100 bookings/night.
- If you ever migrate to a custom domain (e.g. `noreply@hodclub.in`),
  switch `service: "gmail"` to `host/port/secure` config and store the
  new SMTP credentials the same way.
- All sent emails are logged at `_meta/emailLog/events/{ref}` — visible
  in Firebase Console for audit.
