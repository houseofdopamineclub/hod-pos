# EDC Cloud — Firebase Functions reference (Razorpay POS + Pine Labs)

These functions live in the **separate `hod-tickets` Firebase project**, not in this repo. The POS code in this monorepo (`artifacts/pos-system`) calls them by URL. This folder is the canonical, documented source — copy the contents into the `hod-tickets` `functions/` folder and deploy with `firebase deploy --only functions:edcChargeRazorpay,functions:edcChargePineLabs,functions:edcCancelCharge,functions:razorpayEdcWebhook,functions:pineLabsEdcWebhook`.

## Endpoints

All functions are HTTPS, region `asia-south1` (same as the existing `createWalletOrder` / `verifyRechargePayment` / `razorpayWebhook` set). All POSTs accept `application/json`.

| Function | Trigger | Purpose |
| --- | --- | --- |
| `edcChargeRazorpay` | HTTPS POST | Phase 1 — dispatches a charge to the door EDC machine via Razorpay POS Terminal API. Returns `{ txnId }`. Writes `edcTransactions/{txnId}` with `status: "pending"`. |
| `edcChargePineLabs` | HTTPS POST | Phase 2 placeholder — same contract, routes to Pine Labs Plutus Smart Cloud. Currently returns `{ ok: false, reason: "vendor_disabled" }` until Pine Labs onboarding completes. |
| `edcCancelCharge` | HTTPS POST | Best-effort cancel of an in-flight charge. Tells the vendor to abort if it can; webhook still authoritative. |
| `razorpayEdcWebhook` | HTTPS POST | Razorpay POS Terminal callback. HMAC-verifies `X-Razorpay-Signature` against `RAZORPAY_EDC_WEBHOOK_SECRET`, then writes the matching `edcTransactions` doc with `status: "success"` / `"failed"` / `"cancelled"` plus card metadata. |
| `pineLabsEdcWebhook` | HTTPS POST | Same idea for Pine Labs (Phase 2). |

## Request schema (frontend → function)

```jsonc
// POST /edcChargeRazorpay  (and /edcChargePineLabs)
{
  "bookingRef": "BK_2026_05_12_AB12",   // required
  "coverRef":   "BK_2026_05_12_AB12",   // required (often same as bookingRef)
  "bouncerPin": "4321",                 // required, 4–6 digits, plaintext over HTTPS
  "bouncerName": "Vinod (Door)",        // for audit
  "expectedAmount": 1500                 // for sanity-check ONLY; server reads canonical from Firestore
}
```

## Response schema (function → frontend)

Success:
```json
{ "txnId": "edc_2026_05_12_xxxxx" }
```

Failure:
```json
{ "ok": false, "reason": "vendor_disabled|bad_pin|amount_mismatch|no_terminal|error", "error": "human-readable" }
```

## Firestore doc — `edcTransactions/{txnId}`

```ts
{
  bookingRef: string,
  coverRef: string,
  amount: number,                       // canonical, read from cover doc by the function
  vendor: "razorpay" | "pinelabs",
  terminalId?: string,
  status: "pending" | "success" | "failed" | "cancelled",
  razorpayIntentId?: string,            // razorpay only
  razorpayPaymentId?: string,           // razorpay only, set on webhook
  pineLabsRef?: string,                 // pinelabs only
  last4?: string,                       // when reported by EDC
  cardNetwork?: string,                 // VISA / MASTERCARD / RUPAY / AMEX
  edcRef?: string,                      // vendor-side reference (printed on slip)
  errorReason?: string,                 // when status=failed
  bouncerPin?: string,                  // SHA-256 hash, audit only
  bouncerName?: string,
  date: string,                         // operational night YYYY-MM-DD (so Reports can filter)
  createdAt: string,                    // ISO
  updatedAt: string,                    // ISO
}
```

## Required secrets (set via `firebase functions:config:set` or Functions runtime env)

| Variable | Purpose |
| --- | --- |
| `RAZORPAY_KEY_ID` | Already exists for the wallet-recharge flow — reuse. |
| `RAZORPAY_KEY_SECRET` | Same. |
| `RAZORPAY_EDC_TERMINAL_ID` | Razorpay POS Terminal ID for the door card machine. **Required**. |
| `RAZORPAY_EDC_WEBHOOK_SECRET` | HMAC secret for `razorpayEdcWebhook` signature verification. **Required**. |
| `PINELABS_MERCHANT_ID` | Phase 2. |
| `PINELABS_TERMINAL_ID` | Phase 2. |
| `PINELABS_WEBHOOK_SECRET` | Phase 2. |
| `EDC_BOUNCER_PIN_SALT` | Random 32-byte hex string used to hash bouncer PINs server-side. |

## Security model

1. **Browser never sends amount as authoritative input.** The function reads
   the cover doc by `bookingRef`, computes the actual amount due, and only
   uses the browser-sent `expectedAmount` for a sanity check (returns
   `amount_mismatch` if they diverge by more than ₹0).
2. **Bouncer PIN is verified server-side** against the staff PINs collection
   (`hodStaffPins/{name}` — same as the door-manager-pin flow elsewhere in
   the POS). Wrong PIN → `bad_pin`, no charge dispatched.
3. **Webhooks are HMAC-verified** before any `status: success` write. A
   random POST to the webhook URL cannot mark a booking as paid.
4. **Idempotency:** the txn id is derived from
   `bookingRef + coverRef + minute_bucket` so a refresh-mid-flow re-dispatch
   in the same minute reuses the same `edcTransactions` doc instead of
   double-charging.

## Deploy checklist

1. Razorpay dashboard → enable POS Terminal API, register the door EDC's
   Terminal ID, add the webhook URL with the secret above.
2. Set the secrets above via `firebase functions:secrets:set` (preferred)
   or `functions:config:set`.
3. Copy `index.ts` from this folder into `hod-tickets/functions/src/edc/`,
   wire it from `hod-tickets/functions/src/index.ts`, and deploy.
4. In this repo, set `VITE_EDC=1` for the pos-system build, restart the
   `artifacts/pos-system: web` workflow, and verify the EDC PIN field
   appears on the Door Mode "Card" payment selection.
5. End-to-end test with a ₹1 cover before going live.

## Reference implementation skeleton

See `index.ts` in this folder for a TypeScript skeleton you can lift into
the `hod-tickets` functions project. It is intentionally kept minimal —
add monitoring, retry policies, and structured logging to match the rest
of the `hod-tickets` functions codebase.
