// ── HOD POS — Razorpay Checkout helper for Bar Mode UPI/Card recharges.
// ─────────────────────────────────────────────────────────────────────
// Built Mon 11 May 2026 to close the bartender-side fraud hole where
// "UPI" and "Card" tap-to-recharge instantly credited the wallet WITHOUT
// any actual payment — a bartender could pocket cash and mark "UPI ₹2k"
// with one tap. Now those two methods open Razorpay Checkout right on
// the tablet, customer pays via UPI app or card, server signature-
// verifies, AND THEN the wallet credits with `serverVerified:true`.
//
// FLOW:
//   1. Bartender taps UPI or Card → Recharge in BarMode
//   2. We POST to createWalletOrder (server writes ledger {orderId →
//      coverRef, amount, kind})
//   3. window.Razorpay (loaded in index.html) opens with order_id
//   4. Customer pays UPI/card on the bartender's tablet
//   5. Razorpay handler() fires → POST verifyRechargePayment with
//      {order_id, payment_id, signature} ONLY (no client-trusted amount
//      or coverRef — server reads them from its own ledger)
//   6. Server credits wallet → Firestore subscription on the cover
//      auto-updates the bartender's UI within ~1 sec
//
// FALLBACKS:
//   - createWalletOrder fails    → reject with toast, no charge
//   - Razorpay popup dismissed   → reject silently (customer cancelled)
//   - verifyRechargePayment fails → still resolved (webhook backstop
//     credits within ~5s) but caller shows yellow warning toast
//
// SECURITY: this code path is identical to the customer-site one — the
// fraud hole closed there (no client-trusted amount/coverRef) is closed
// here too. Bartender CANNOT spoof a recharge by tampering with the
// browser console because the server ignores everything except the
// signed order_id/payment_id/signature triplet.

const HOD_FUNCTIONS_BASE = "https://asia-south1-hod-tickets.cloudfunctions.net";
const CREATE_ORDER_URL = `${HOD_FUNCTIONS_BASE}/createWalletOrder`;
const VERIFY_RECHARGE_URL = `${HOD_FUNCTIONS_BASE}/verifyRechargePayment`;

// Razorpay LIVE key (publishable — safe to embed). Same key used by
// customer site (hodclub.in). Listed in replit.md for reference.
const RAZORPAY_KEY = "rzp_live_Sgf6ON1mQY95kT";

declare global {
  interface Window {
    Razorpay?: any;
  }
}

export type RazorpayMethod = "upi" | "card";

export interface RazorpayRechargeOpts {
  amount: number;       // INR, integer ≥ 1, ≤ 50000
  coverRef: string;     // Firestore cover doc ID (e.g. cover.id)
  method: RazorpayMethod;
  customerName?: string;
  customerPhone?: string;
}

export interface RazorpayRechargeResult {
  ok: boolean;
  /** Set on ok=true OR on payment-captured-but-verify-failed (webhook
   *  will still credit) — bartender can show this to customer. */
  paymentId?: string;
  /** New wallet balance, only when verify succeeded synchronously. */
  newBalance?: number;
  /** Set when ok=false. "cancelled" = user closed Razorpay popup
   *  (no charge); "verify_failed" = paid but server-side verify errored
   *  (webhook backstop will credit); "error" = pre-payment failure. */
  reason?: "cancelled" | "verify_failed" | "error";
  errorMessage?: string;
}

/**
 * Open Razorpay Checkout on the bartender's tablet for a wallet recharge.
 * The customer pays via UPI or card right there. Returns when payment
 * lifecycle ends (success / cancel / failure).
 */
export function openRazorpayRecharge(
  opts: RazorpayRechargeOpts
): Promise<RazorpayRechargeResult> {
  return new Promise((resolve) => {
    const amount = Math.round(opts.amount);
    if (!amount || amount < 1) {
      return resolve({ ok: false, reason: "error", errorMessage: "Min ₹1" });
    }
    if (amount > 50000) {
      return resolve({ ok: false, reason: "error", errorMessage: "Max ₹50,000" });
    }
    if (!opts.coverRef) {
      return resolve({ ok: false, reason: "error", errorMessage: "Wallet not identified" });
    }
    if (!window.Razorpay) {
      return resolve({
        ok: false, reason: "error",
        errorMessage: "Razorpay SDK not loaded — check internet",
      });
    }

    // Step 1 — server creates an order_id and writes the ledger entry
    // {orderId → coverRef, amount, kind:'topup'}. The verify endpoint
    // will trust ONLY this ledger, never anything we send back.
    fetch(CREATE_ORDER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount,
        coverRef: String(opts.coverRef),
        kind: "topup",
        name: opts.customerName || "",
        phone: opts.customerPhone || "",
      }),
    })
      .then((r) => r.json())
      .then((orderResp) => {
        if (!orderResp || !orderResp.orderId) {
          throw new Error(orderResp?.error || "Could not create order");
        }

        // Step 2 — open Razorpay Checkout. We restrict the visible
        // payment methods to match the bartender's choice (UPI or
        // card) so the popup is single-purpose.
        const rzOpts: any = {
          key: RAZORPAY_KEY,
          order_id: orderResp.orderId,
          amount: amount * 100, // Razorpay wants paise
          currency: "INR",
          name: "HOD — House of Dopamine",
          description: `Wallet Recharge ₹${amount}`,
          image: "https://hodclub.in/logo.png",
          prefill: {
            name: opts.customerName || "",
            contact: opts.customerPhone || "",
          },
          theme: { color: "#C9A84C" },
          // Lock the popup to the bartender's chosen rail. UPI Intent
          // (Indian UPI apps) for "upi", Card-only for "card".
          method: opts.method === "upi"
            ? { upi: true, card: false, netbanking: false, wallet: false, paylater: false, emi: false }
            : { upi: false, card: true, netbanking: false, wallet: false, paylater: false, emi: false },
          handler: function (resp: any) {
            // Step 3 — server signature-verify + Razorpay-API-fetch +
            // credit (idempotent on paymentId). NO client-trusted amount
            // or coverRef — server reads them from its own ledger.
            fetch(VERIFY_RECHARGE_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                razorpay_order_id: resp.razorpay_order_id,
                razorpay_payment_id: resp.razorpay_payment_id,
                razorpay_signature: resp.razorpay_signature,
              }),
            })
              .then((r) => r.json())
              .then((v) => {
                if (v && v.ok) {
                  resolve({
                    ok: true,
                    paymentId: resp.razorpay_payment_id,
                    newBalance: v.newBalance,
                  });
                } else {
                  // Verify failed — webhook backstop will still credit.
                  resolve({
                    ok: false,
                    reason: "verify_failed",
                    paymentId: resp.razorpay_payment_id,
                    errorMessage:
                      v?.error || "Verify failed — webhook backstop will credit within 30s",
                  });
                }
              })
              .catch((e) => {
                resolve({
                  ok: false,
                  reason: "verify_failed",
                  paymentId: resp.razorpay_payment_id,
                  errorMessage: `Network error verifying — webhook backstop will credit. ${e.message || e}`,
                });
              });
          },
          modal: {
            ondismiss: function () {
              resolve({
                ok: false,
                reason: "cancelled",
                errorMessage: "Customer cancelled payment",
              });
            },
          },
        };

        try {
          new window.Razorpay(rzOpts).open();
        } catch (e: any) {
          resolve({
            ok: false,
            reason: "error",
            errorMessage: `Could not open Razorpay: ${e.message || e}`,
          });
        }
      })
      .catch((e) => {
        resolve({
          ok: false,
          reason: "error",
          errorMessage: `Could not start payment: ${e.message || e}`,
        });
      });
  });
}
