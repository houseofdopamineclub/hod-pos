# 🚀 DEPLOY — RAZORPAY WALLET WEBHOOK + SERVER-VERIFIED RECHARGE

**What this ships (Mon 11 May 2026):**
- ✅ NEW `verifyRechargePayment` cloud function — Razorpay-signature-checked wallet credit.
  Customer site + bartender QR flow call this instead of touching Firestore directly.
- ✅ EXTEND `razorpayWebhook` — now ALSO handles wallet recharges as a backstop
  (catches the case where the customer's browser closes mid-payment).
- ✅ Idempotent by `paymentId` — no double-credit even if both verify call AND
  webhook fire for the same payment.
- ✅ Audit log to `_meta/razorpayWalletLog/events/{paymentId}` for every hit.
- ✅ Fail-open philosophy — POS Bar Mode auto-allows ACTIVATE after 60-sec wait
  so a webhook delay never blocks legitimate revenue (lands with `pendingWebhookTick:true`
  flag → admin Pending tile + next-day leakage report).
- ✅ Firestore rules patch — locks money fields so client SDK can no longer
  credit wallets directly (closes the EXISTING fraud hole).

**Pre-req:** the existing `RAZORPAY_SECRET` Firebase secret (already set —
used by `verifyPayment` and the existing `razorpayWebhook`). No new secrets.

---

## ✅ STEP 1 — Drop the file in

On Khushi's Mac:
```bash
cd ~/Desktop/hod-functions-backend/functions
cp /path/to/repl/hod-functions-patch/walletRechargeWebhook.js ./walletRechargeWebhook.js
```

## ✅ STEP 2 — Wire it into index.js

In `~/Desktop/hod-functions-backend/functions/index.js`, find this near the top:
```js
const crypto = require('crypto');
```
Right BELOW it (or anywhere near the other `require`s), add:
```js
const wrw = require('./walletRechargeWebhook');
exports.createWalletOrder       = wrw.createWalletOrder;
exports.verifyRechargePayment   = wrw.verifyRechargePayment;
```

Now find the existing `razorpayWebhook` block (line ~534, comment header
"7. Razorpay Webhook — payment.captured backstop"). Inside the handler,
right AFTER this block:
```js
      const paymentId = payment.id;
      const amountInr = (payment.amount || 0) / 100;
      const notes = payment.notes || {};
```
INSERT these 7 lines:
```js
      // ── Wallet recharge backstop (Mon 11 May 2026) — if Razorpay notes
      //    flag this as a wallet top-up, credit the cover and STOP. The
      //    booking branch below is for ticket bookings only.
      const walletResult = await wrw.handleWalletWebhookBranch(payment);
      if (walletResult.handled) {
        console.log(`[razorpayWebhook] handled as wallet recharge (${walletResult.credited ? 'credited' : 'skip'}) ${paymentId}`);
        return res.status(200).send('OK (wallet)');
      }
```

The existing booking branch below stays untouched — it now only runs for
ticket bookings (which carry `notes.eventId`, NOT `notes.type=wallet_topup`).

## ✅ STEP 3 — Deploy the new functions

```bash
cd ~/Desktop/hod-functions-backend
firebase deploy --only functions:createWalletOrder,functions:verifyRechargePayment,functions:razorpayWebhook
```

~3 minutes. Watch for green "✔ functions: deploy complete".

**The two new functions reuse the EXISTING `RAZORPAY_KEY_ID` and
`RAZORPAY_SECRET` Firebase secrets — no new secrets to create.** If the
deploy log says "secret not found", run:
```bash
firebase functions:secrets:access RAZORPAY_KEY_ID
firebase functions:secrets:access RAZORPAY_SECRET
```
If either errors, the secret was never set — re-add via
`firebase functions:secrets:set RAZORPAY_KEY_ID` (paste the live key
when prompted). The existing `verifyPayment` function already uses both,
so they're almost certainly already there.

## ✅ STEP 4 — Smoke test (₹100 dry-run on YOUR phone)

1. Open hodclub.in on your phone (or any wallet you control).
2. Tap recharge → enter ₹100 → pay with UPI.
3. **Expected:** the success screen appears AND your `coverBalance` jumps by ₹100.
4. Open Firestore Console → `covers/<your-ref>` → check the latest entry
   in `transactions`:
   - `serverVerified: true` ✅
   - `paymentId: "pay_xxx"` ✅
   - `verifiedSource: "verify"` ✅ (or `"webhook"` if your browser closed first)
5. ALSO open `_meta/razorpayWalletLog/events/<that-pay-id>` → audit row exists.
6. ALSO open `_meta/walletOrders/orders/<that-order-id>` → SHOULD show
   `{coverRef, amount, kind, createdAt}` — this is the server-side
   ledger that lets verify + webhook ignore client-claimed values.

## ✅ STEP 5 — (After 24 hr soak) Set POS custom claims, THEN apply rules lock

⚠️ **DO NOT do this step until you've done both of these first:**

  **5a.** Set the `pos: true` custom claim for every POS user (today the
  POS app signs in ANONYMOUSLY — anonymous users have NO claim). See
  `firestore.rules.wallet-lock.md` → "Option B (correct)" section.
  If you skip this, publishing the rule lock will break the bartender's
  cash/UPI/card recharge button immediately. Fallback if you can't get
  to it tonight: use Option A (email allow-list) for the same effect.

  **5b.** Smoke-test bartender cash recharge ₹100 AFTER setting claims
  but BEFORE publishing the rules lock — confirm `coverBalance` updates.

→ Then open `hod-functions-patch/firestore.rules.wallet-lock.md` and
publish the patch. It denies client-side `coverBalance` mutations. After
this, the existing customer-site Firestore-direct-write fallback STOPS
working — only `verifyRechargePayment` (admin SDK) can credit wallets.

**Rollback in 30 sec** if anything breaks → Firebase Console → Firestore
→ Rules → History → previous version → Publish.

---

## 🛟 What happens if things go wrong?

| Scenario | What happens |
|---|---|
| Customer pays + browser CRASHES before verify call lands | Razorpay's webhook fires within ~5s → `razorpayWebhook` extension credits the wallet → bartender sees green tick within ~10s. |
| Customer pays + verify call lands, THEN webhook lands | Verify credits first (with serverVerified:true). Webhook arrives, sees paymentId already in transactions[], skips. No double-credit. |
| Webhook lands FIRST (rare, network blip), then verify call lands | Webhook credits with serverVerified:true. Verify call sees paymentId already there, returns ok with `credited:false`. No double-credit. |
| RAZORPAY_SECRET missing or rotated | Verify endpoint returns 500. Customer sees error toast. **Bartender CAN still recharge via cash / UPI / card** (those don't touch Razorpay). Online recharge dies until secret is restored. |
| Razorpay payment captured but webhook arrives at the WRONG payload (e.g. `notes.type` not set) | `handleWalletWebhookBranch` returns `{handled:false}` → falls through to existing ticket-booking branch, which idempotency-skips because there's no booking with that paymentId. No harm. |
| Cover doc deleted between order and verify | Verify returns 404. Customer sees "wallet not found". Webhook also fails the same way → audit row written. Khushi can manually re-credit via Firestore Console. |
| Payment amount mismatch (Razorpay says ₹500, server ledger says ₹1000) | `verifyRechargePayment` server-fetches the payment from Razorpay's API, compares vs. the amount written into `_meta/walletOrders` at order-creation time, and rejects with 400 on mismatch. Client-claimed amount is no longer trusted at all. |
| Attacker calls `verifyRechargePayment` with someone else's paymentId/orderId | Server reads coverRef from `_meta/walletOrders/{orderId}` (server-written at createWalletOrder time). Attacker cannot redirect a payment to a different wallet — they'd need write access to `_meta`, which client SDK doesn't have. |
| Attacker calls `createWalletOrder` 1000 times to cause noise | Razorpay charges nothing until the order is paid; orders auto-expire if unpaid. `_meta/walletOrders` will collect orphan order docs (cheap; can be GC'd later). Add per-coverRef rate-limit if it becomes a real problem. |

---

## ❓ "WHAT IF UPI SUCCEEDS BUT RAZORPAY NEVER CAPTURES?" — Khushi's question answered

**Short answer:** rare, but it CAN happen. The system is designed to make
the loss probability very small — not zero — and to give you a paper
trail for any case where you have to recover money manually.

### How Razorpay actually works (the part that protects us)

Every recharge starts with `createWalletOrder` writing an `order_id` into
Razorpay's books AND into our private `_meta/walletOrders/{orderId}` ledger.
The customer's UPI app completes the payment against that order_id. When
the bank confirms the debit, Razorpay receives a "payment captured" event
and fires the webhook to our backend. If the first webhook fails, Razorpay
retries with backoff over roughly 24 hours.

The "real" failure modes split into three buckets:

| Failure | What actually happened | Our recovery path |
|---|---|---|
| **Webhook delayed (most common)** | Customer paid, Razorpay captured, webhook is slow (network blip / cold-start). Tick lands seconds-to-minutes later. | 60-sec fail-open lets the bartender pour. Once the webhook arrives, the new tx is written with `serverVerified:true` — newer txs supersede the unverified one. Badge clears for that round; older entries may need manual mark-resolved. |
| **Customer's app showed success, payment never reached Razorpay** | PSP/bank-side failure. Bank may auto-reverse the debit within hours-to-days, OR may have never debited at all (UPI app showed false-positive success). | Bartender's screenshot + UPI ref are saved to `cover.pendingScreenshots[]`. Khushi cross-checks Razorpay dashboard next morning. NOT FOUND + UPI ref present → ask customer to share their bank statement; if debit reversed → no action; if debit stuck → customer raises bank-level dispute (UPI rules typically require refund within 5 working days but is not guaranteed). |
| **Bank glitch — debit stuck, no Razorpay capture** | The rarest case. Bank shows debit but Razorpay never received it. | Khushi manually credits via Firestore Console using the screenshot proof, then files a refund claim with Razorpay support. The audit log + screenshot are your evidence. |

### What the bartender's screen does automatically (V4)

1. **Pre-60-sec:** PRINT KOT shows gold countdown. Bartender waits.
2. **At 60-sec fail-open:** Tapping PRINT KOT opens the SCREENSHOT MODAL. Bartender must type the UPI ref number from the customer's phone, OR explicitly Skip (confirm dialog → activation lands with `NO-SCREENSHOT` marker).
3. **Post-activation:** Cover header shows persistent 🟡 PENDING ✅ TICK badge with total ₹ and count. Tracks any V4-era online tx that lacks `serverVerified:true`.
4. **When the webhook lands:** The webhook writes a NEW tx with `serverVerified:true`. The yellow banner above PRINT KOT clears for that recharge; the GREEN ✅ banner appears for the next 5 minutes. Note: the persistent header badge counts every unverified V4 tx, so older entries with `[PENDING-TICK …]` markers will keep showing until you mark them resolved (planned future Reports UI; today, edit the cover doc field `pendingScreenshots[].resolved=true` via Firestore Console).
5. **End of night:** Open Reports → Wallets → look for staff strings containing `[PENDING-TICK …]`. The paymentId + UPI ref give you everything to cross-check.

### Realistic numbers

- Razorpay's published payment-success rate is in the high-90s%; webhook delivery (within their 24-hour retry window) is similarly high, but **not 100%**.
- True "money debited at bank but never reached Razorpay" cases are uncommon but real.
- Most refund disputes go through the customer's bank, not us — but **we do not have a guarantee** that every PSP failure will be auto-recovered. The screenshot + UPI ref are what protect us in those rare cases.

### Fallback if Khushi forgets to reconcile

If you don't open the dashboard, Razorpay's retry window means most
webhooks WILL land within 24 hours and the per-recharge banner will
clear automatically. The persistent header badge is your backstop —
treat any wallet still showing 🟡 PENDING the next morning as
"check Razorpay dashboard before next service." Set a daily 10 AM
reminder; that's enough.

## 🔁 Future hardening (not in this drop)

- Migrate `walletOperation` (legacy admin-key endpoint in the deployed
  index.js) to require Razorpay signature for `recharge` — or retire it
  entirely (the customer site no longer calls it post-this-drop).
- Wire up POS Live Monitor "PENDING WEBHOOK" tile (counts activations
  flagged `pendingWebhookTick:true` via the staff string suffix) and a
  next-day Reports leakage column for the same — already in the data
  model, just needs UI.
- Optional rate-limit on `createWalletOrder` per coverRef (currently
  caps via Razorpay's own per-key rate limits). Not urgent — the cover
  doc existence check + ₹50k cap already block obvious abuse.

---

## ⏰ Cron timezone fix (separate, also pending)

Sheets sync currently runs at us-central1 06:00 UTC = 11:30 IST. Khushi
wants Asia/Kolkata 06:00. Patch in `sheetsSync.js`:
```js
.timeZone('Asia/Kolkata')   // add this
.pubsub.schedule('0 6 * * *')   // already exists
```
Re-deploy `archiveToSheets`. Verify with `firebase functions:log --only archiveToSheets`.
