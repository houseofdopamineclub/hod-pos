# 🚀 DEPLOY — WHATSAPP SEND ON FIREBASE CLOUD FUNCTIONS

**Goal (Wed 14 May 2026):** kill the Replit dependency for booking /
guestlist / table-reservation WhatsApp confirmations. Move the same
Meta Cloud API call into Firebase Cloud Functions so it runs always-on,
free, and never sleeps.

**What this ships:**
- ✅ NEW `sendWhatsAppTemplate` cloud function — drop-in replacement
  for the Replit `/api/whatsapp/send-template` endpoint. Same body
  shape (`{to, template, language, params}`), same response shape
  (`{ok:true, recipient, data}`).
- ✅ NEW `sendWhatsAppText` cloud function — bonus, plain-text version
  (replaces Replit `/api/whatsapp/send`). Useful for void notifier /
  admin tools later. Customer site does NOT use this one.
- ✅ Customer site (`hodclub-patched/index.html`) URL flipped from the
  Replit dev preview to the Firebase Functions URL.

**Pre-req:** the Meta Cloud API token + phone number ID. You ALREADY
have these in Replit secrets (`WHATSAPP_ACCESS_TOKEN` and
`WHATSAPP_PHONE_NUMBER_ID`). We just need to copy them into Firebase
secrets ONCE — see Step 1.

---

## ✅ STEP 1 — Copy the WhatsApp secrets into Firebase (ONE TIME)

On Khushi's Mac:

```bash
cd ~/Desktop/hod-functions-backend
firebase functions:secrets:set WHATSAPP_ACCESS_TOKEN
# Paste the EAA... token from Meta Business Manager when prompted.
# (Same value that's in the Replit "Secrets" tab.)

firebase functions:secrets:set WHATSAPP_PHONE_NUMBER_ID
# Paste the 15-digit phone number ID (same value as Replit).
```

Confirm both stuck:
```bash
firebase functions:secrets:access WHATSAPP_ACCESS_TOKEN
firebase functions:secrets:access WHATSAPP_PHONE_NUMBER_ID
```

If either errors with "secret not found", re-run the `set` command above.

**FALLBACK:** if you don't have the values handy, open the Replit
project → Secrets tab → copy them from there (Replit DOES show secret
values, unlike Firebase). Or grab them from Meta Business Manager:
- Token: https://business.facebook.com/settings/system-users → HOD POS → Generate Token
- Phone Number ID: https://business.facebook.com/wa/manage/phone-numbers/

---

## ✅ STEP 2 — Drop the file in

On Khushi's Mac:
```bash
cd ~/Desktop/hod-functions-backend/functions
cp /path/to/repl/hod-functions-patch/whatsappSend.js ./whatsappSend.js
```

(If you sync the repo via GitHub: `git pull` will bring it in alongside
the existing `walletRechargeWebhook.js` etc.)

---

## ✅ STEP 3 — Wire it into index.js

Open `~/Desktop/hod-functions-backend/functions/index.js`. Find where
the other patch files are required (look for the line you already added
for `walletRechargeWebhook` — usually near the top with the other
`require()`s). Right BELOW it, add:

```js
const wa = require('./whatsappSend');
exports.sendWhatsAppTemplate = wa.sendWhatsAppTemplate;
exports.sendWhatsAppText     = wa.sendWhatsAppText;
```

That's it — no other index.js changes needed.

---

## ✅ STEP 4 — Deploy the new functions

```bash
cd ~/Desktop/hod-functions-backend
firebase deploy --only functions:sendWhatsAppTemplate,functions:sendWhatsAppText
```

~3 minutes. Watch for green `✔ functions: deploy complete`.

After it finishes, the Firebase Console → Functions tab should show:
- `sendWhatsAppTemplate (asia-south1)`  HTTP trigger
- `sendWhatsAppText (asia-south1)`      HTTP trigger

Each will have a **Trigger URL** like:
`https://asia-south1-hod-tickets.cloudfunctions.net/sendWhatsAppTemplate`

This URL is ALREADY hardcoded in the customer site (Step 6 below).

---

## ✅ STEP 5 — Smoke test (1 WhatsApp to your own number)

From the Mac terminal (no need to touch the customer site yet):

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"to":"YOUR-10-DIGIT-NUMBER","template":"cover_confirmed","language":"en","params":["TEST","HOD-TEST123","1","₹1000","Test Event","Tonight"]}' \
  https://asia-south1-hod-tickets.cloudfunctions.net/sendWhatsAppTemplate
```

**Expected:** within 5 seconds your phone gets the cover_confirmed
WhatsApp template message AND the curl returns:
```json
{"ok":true,"recipient":"91XXXXXXXXXX","data":{"messages":[{"id":"wamid...."}]}}
```

If you get `{"ok":false,...}`:
- `WhatsApp not configured` → secrets didn't deploy (re-run Step 1).
- `Template not found` → use a template name that actually exists in your
  Meta Business account. Working ones today: `cover_confirmed`,
  `booking_confirmed`, `guestlist_confirmed`, `wallet_ready`,
  `guestlist_ready`. (Number of params MUST match the template definition,
  otherwise Meta returns `132000` parameter mismatch.)
- `Recipient not in allowed list` → Meta sandbox restriction. Add your
  number under Meta Business → WhatsApp Manager → Phone Numbers →
  Configuration → Test Numbers (or graduate the app out of sandbox).

---

## ✅ STEP 6 — Deploy customer site to Netlify

The customer site URL has already been updated in the repo
(`hodclub-patched/index.html` line ~740). Just push it live:

1. Open Netlify dashboard → hodclub.in site.
2. Drag-and-drop `hodclub-patched/index.html` into the deploy area
   (or push to GitHub if Netlify auto-builds).
3. Wait ~30 sec for "Published".
4. Hard-refresh hodclub.in on your phone (Ctrl+Shift+R / clear cache).

**FALLBACK:** if the Firebase function ever errors and you need to
revert to Replit api-server in 30 sec, edit `hodclub-patched/index.html`
line ~740 back to:
```js
var _HOD_POS_API = 'https://004e052d-65c7-4893-9c29-a0792e72f989-00-1dpoyzy5gqg80.janeway.replit.dev/api/whatsapp/send-template';
```
…and re-deploy to Netlify. The Replit api-server route is left intact
exactly so this rollback path stays open.

---

## ✅ STEP 7 — End-to-end test from a real booking

1. Open hodclub.in incognito on your phone.
2. Book a ₹1 event ticket OR join the guestlist OR reserve a table.
3. Within 5 sec your phone should ping with the WhatsApp template.
4. Open Firebase Console → Functions → `sendWhatsAppTemplate` → Logs.
   You should see one `[sendWhatsAppTemplate] sent` line per booking.

**Now you can SHUT THE REPLIT TAB** during venue hours. WhatsApp keeps
flowing.

---

## 🛟 What happens if things go wrong?

| Scenario | What happens | Recovery |
|---|---|---|
| Customer books, Firebase Function returns 500 | Customer site logs `WA failed` to browser console. **Booking itself is unaffected** — it was already saved to Firestore BEFORE the WhatsApp call fires. Customer just doesn't get the WA. | Check `firebase functions:log --only sendWhatsAppTemplate`. Most common cause: Meta token expired (regenerate in Meta Business → System Users → HOD POS → Generate Token → re-run Step 1). |
| Meta token expired (60-day system token, or rotated) | Function returns 401 with Meta's "Session has expired" message. NO WhatsApp sends until the token is refreshed. | Re-run Step 1 with the new token, then `firebase deploy --only functions:sendWhatsAppTemplate,functions:sendWhatsAppText`. **TIP:** in Meta Business → System Users, generate a *never-expires* system token (admin role) so this never bites again. |
| Firebase Functions region down (rare) | Function returns 5xx. | Flip customer site URL back to Replit (Step 6 fallback) and re-deploy to Netlify. |
| Customer phone number invalid (less than 10 digits) | Function returns 400, customer site logs `WA skip — bad phone`. No WhatsApp sent (correct behaviour). | Nothing to do — bad phone in the booking form. |
| Template name doesn't exist or wrong param count | Function forwards Meta's 400 with code `132000` / `132001`. | Use a template name that IS approved in your Meta account. List of working ones is at top of this doc. |
| You forgot to set the secrets (Step 1) | Function returns 500 `WhatsApp not configured on server`. | Run Step 1 + redeploy (Step 4). |
| You forgot to update index.js (Step 3) | `firebase deploy` succeeds but the function isn't there in the console. | Add the 3 lines from Step 3, redeploy. |

---

## 🔌 Replit api-server — leave it ALONE

We are NOT deleting `artifacts/api-server/src/routes/whatsapp.ts`. It
stays as a silent fallback so:
- (a) The 30-sec URL flip in Step 6 fallback works.
- (b) Anything else that might be calling the Replit URL (admin tools,
  test scripts) keeps working unchanged.

Once you've watched a week of bookings flow through Firebase Functions
WITHOUT a single failure, we can revisit retiring the Replit route.
For now: belt and braces.

---

## 💸 Cost — is this really free?

Firebase Cloud Functions free tier: **2 million invocations/month** +
**400,000 GB-seconds compute** + **5 GB egress**. Each WhatsApp send is
~1 invocation, ~256 MB × ~500 ms = ~0.13 GB-seconds, negligible egress.

Even at 10,000 bookings/month, you'd use:
- 10,000 invocations (0.5% of free tier)
- 1,300 GB-seconds (0.3% of free tier)

You will NEVER pay a paisa for this at HOD's volume. Same as the
existing `verifyRechargePayment` and `razorpayWebhook` functions.

The Meta WhatsApp Cloud API is also free for the first 1,000 conversations
per month per business (then ~₹0.34 per business-initiated conversation
after that — a "conversation" = 24 hr window).

---

## 📋 Recap — what changed where

| File | Change |
|---|---|
| `hod-functions-patch/whatsappSend.js` | NEW — 2 cloud functions (template + text). |
| `hodclub-patched/index.html` line ~740 | URL flipped from Replit to Firebase. |
| `~/Desktop/hod-functions-backend/functions/whatsappSend.js` | NEW — copy of the patch file (Step 2). |
| `~/Desktop/hod-functions-backend/functions/index.js` | +3 lines exporting the new functions (Step 3). |
| Firebase Secrets | NEW — `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` (Step 1). |
| Netlify deploy of `hodclub.in` | NEW build with the updated URL (Step 6). |
| `artifacts/api-server/src/routes/whatsapp.ts` | UNCHANGED — kept as silent fallback. |
