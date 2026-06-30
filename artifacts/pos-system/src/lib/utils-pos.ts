export function nanoid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function formatINR(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatINRDecimal(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function getTimeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  return `${hours}h ${mins}m`;
}

export function getDuration(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  return `${hours}h ${mins}m`;
}

export function getDurationMinutes(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / 60000);
}

export function getTodayString(): string {
  return new Date().toISOString().slice(0, 10);
}

// Returns the IST calendar date of the current "operational night" as YYYY-MM-DD.
// HOD's window (per Khushi 02 Jun 2026): the operational night rolls over at
// 7 AM IST. Anything BEFORE 7 AM IST counts as the PREVIOUS operational night
// (so a 1–6 AM post-midnight door arrival still belongs to the prior evening's
// night), and from 7 AM IST onward the dashboard shows the new (current
// calendar) day — which is why a morning walk-in now correctly shows today's
// date instead of yesterday's.
// HISTORY: 6am→6am (shift -6h) → 12pm→12pm noon (shift -12h, 11 May 2026) →
// 7am→7am (shift -7h, 02 Jun 2026). NOTE: cover EXPIRY below is INTENTIONALLY
// left at next-day NOON so no cover ever expires earlier than before this
// change — covers created in the 7am–noon window simply get longer validity.
export function getOperationalNightStr(): string {
  const shifted = new Date(Date.now() - 7 * 60 * 60 * 1000);
  return shifted.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// ── PAYMENT-METHOD ("tender") breakdown ───────────────────────────────
// 🆕 2026-06-30 (Khushi) — shared by the Door / Bar / Captain reports so each
// shows how its collected money was actually paid. Six buckets she asked for:
// Cash · UPI · Card · Split · TOP UPS · Others.
// 🆕 2026-06-30 v2 (Khushi) — split online wallet top-ups out of "Others" into
// their OWN "TOP UPS" row. When a customer tops up their wallet through the
// online Razorpay link the tx type is `online_topup` → method "online"/"razorpay"
// → the "online" bucket (labelled TOP UPS). The gateway only tells us it was an
// online payment, NOT whether the customer chose UPI/card inside Razorpay, so it
// can't be split into UPI/Card. Aggregator / wallet / comp / unknown still fall
// into Others. Each report scopes the mix to the SAME money its headline
// "collected" total uses, so the buckets reconcile to that total.
export type TenderBucket = "cash" | "upi" | "card" | "split" | "online" | "other";
export const TENDER_BUCKETS: TenderBucket[] = ["cash", "upi", "card", "split", "online", "other"];
export const TENDER_LABELS: Record<TenderBucket, string> = {
  cash: "Cash", upi: "UPI", card: "Card", split: "Split", online: "TOP UPS", other: "Others",
};
export type TenderMix = Record<TenderBucket, number>;
export const zeroTenderMix = (): TenderMix => ({ cash: 0, upi: 0, card: 0, split: 0, online: 0, other: 0 });
export const tenderMixTotal = (m: TenderMix): number =>
  m.cash + m.upi + m.card + m.split + m.online + m.other;

// Classify any settlement-method string into one of the six buckets.
export function bucketTender(method?: string): TenderBucket {
  const m = (method || "").toLowerCase();
  if (m.includes("split")) return "split";
  if (m.includes("cash")) return "cash";
  if (m.includes("card")) return "card";
  if (m.includes("upi")) return "upi";
  if (m.includes("online") || m.includes("razorpay")) return "online"; // TOP UPS — online wallet top-up
  return "other"; // aggregator / wallet / comp / unknown
}

// Add ONE prepaid cover's REAL collected tender into a mix, budget-capped at
// coverActivated: each `${method}_topup` recharge is bucketed by its own method
// (consuming the budget first), then the leftover budget = the initial door/bar
// load, bucketed by the cover's own payment method. The mix ALWAYS sums to
// exactly coverActivated, even when malformed legacy `*_topup` sums disagree.
export function addCoverTender(mix: TenderMix, c: {
  coverActivated?: number; topUpTotal?: number;
  paymentMethod?: string; coverPaymentMethod?: string;
  transactions?: Array<{ type?: string; amount?: number }>;
}): void {
  const activated = Number(c.coverActivated) || 0;
  if (activated <= 0) return;
  // BUDGET-CAPPED so the per-cover contribution can NEVER exceed coverActivated
  // (guards malformed legacy docs where the `*_topup` tx sum disagrees with
  // topUpTotal). Recharges consume the budget first (bucketed by their own
  // method); whatever budget is left = the initial door/bar load, bucketed by
  // the cover's payment method. Sum of all buckets == coverActivated exactly.
  let remaining = activated;
  for (const tx of c.transactions || []) {
    const t = String(tx.type || "");
    if (!/_topup$/.test(t)) continue;
    const amt = Math.min(Math.max(0, Number(tx.amount) || 0), remaining);
    if (amt <= 0) continue;
    mix[bucketTender(t.replace(/_topup$/, ""))] += amt;
    remaining -= amt;
    if (remaining <= 0) return;
  }
  if (remaining > 0.5) mix[bucketTender(c.paymentMethod || c.coverPaymentMethod)] += remaining;
}

// Add ONE settled table reservation's collected tender into a mix. A multi-
// method split goes wholly into Split; a single method (paymentMode or a
// single-entry paymentSplits) buckets by that method. Aggregator settlements
// (mode = platform name) fall into Others; comp / unpaid (amountPaid 0) skip.
export function addReservationTender(mix: TenderMix, r: {
  paymentStatus?: string; amountPaid?: number; paymentMode?: string;
  paymentSplits?: Array<{ method?: string; amount?: number }>;
}, realizedOverride?: number): void {
  if ((r.paymentStatus || "").toLowerCase() !== "paid") return;
  // realizedOverride lets a caller pass the SAME value its headline total uses
  // (e.g. Captain's BILLED = amountPaid || billFinal) so the mix reconciles even
  // on legacy paid docs that lack amountPaid. Falls back to amountPaid.
  const realized = realizedOverride != null ? (Number(realizedOverride) || 0) : (Number(r.amountPaid) || 0);
  if (realized <= 0) return;
  const splits = r.paymentSplits;
  if (splits && splits.length > 1) { mix.split += realized; return; }
  if (splits && splits.length === 1) { mix[bucketTender(splits[0].method)] += realized; return; }
  mix[bucketTender(r.paymentMode)] += realized;
}

// Returns a Date set to 3:00 IST on the day AFTER the given YYYY-MM-DD
// operational night. Used as the cover/wallet expiry timestamp — ALL wallet
// QRs (covers + prepaid table bookings) stay valid until 3:00 AM the next
// morning (the end of the operational night) and then expire.
// 🆕 2026-06-15 (Khushi) — was next-day NOON; now 3:00 AM next day per request.
// 3:00 IST = the next IST date's 3 AM wall-clock minus the 5h30m IST offset
// (= 21:30 UTC on the operational-night calendar day itself).
export function getCoverExpiryFor(operationalNightStr: string): Date {
  const [y, m, d] = operationalNightStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1, 3, 0, 0) - (5 * 60 + 30) * 60 * 1000);
}

export function getCurrentHour(): number {
  return new Date().getHours();
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

export const SERVICE_CHARGE_RATE = 10;
export const CGST_RATE = 2.5;
export const SGST_RATE = 2.5;
export const GST_RATE = 5;

/** 2026-05-20 (Khushi spec) — DISPLAY-ONLY tax-inclusive helper. Returns the
 *  rounded "what the customer sees" price for a single menu item. Underlying
 *  Firestore data + reports continue to store the raw price; this is render
 *  layer only. Mirrors `computeHodBreakdown` exactly:
 *    SC 10% on ALL items.
 *    GST 5% on (food + non-alc + SC). Alcohol exempt from GST base.
 *  ⇒ food / non-alc drink: price × 1.155
 *  ⇒ alcohol             : price × 1.105
 *  Use this for menu list price chips and per-row cart amounts in Bar /
 *  Captain mode. Cart / round totals already use computeHodBreakdown
 *  (multi-item aware) and don't need this helper.                          */
export function priceWithTax(price: number, isAlcohol: boolean): number {
  const sc = price * 0.10;
  const gstBase = isAlcohol ? sc : (price + sc);
  const gst = gstBase * 0.05;
  return Math.round(price + sc + gst);
}
export const BOTTLE_DISCOUNT_PERCENT = 20;
export const GSTIN = "29AARFH2309E1ZC";
export const VENUE_NAME = "House of Dopamine";
export const VENUE_ADDRESS = "Koramangala, Bengaluru";
export const COMP_MAX_PER_NIGHT = 2000;
export const COMP_LIMIT_PER_CAPTAIN = 1;
export const DISCOUNT_PIN_THRESHOLD = 15;

export function calcBillAmounts(
  items: Array<{ price: number; qty: number; isAlcohol: boolean; status: string; isBottle?: boolean; bottleDiscount?: number; group?: string }>,
  serviceChargeRate: number,
  discountType: "percent" | "flat",
  discountValue: number,
  happyHourPercent: number = 0
) {
  const activeItems = items.filter((i) => i.status !== "void");

  const foodSubtotal = activeItems
    .filter((i) => i.group === "food")
    .reduce((s, i) => s + i.price * i.qty, 0);

  const alcSubtotal = activeItems
    .filter((i) => i.isAlcohol)
    .reduce((s, i) => {
      const base = i.price * i.qty;
      const bottleDisc = i.isBottle && i.bottleDiscount ? i.bottleDiscount : 0;
      return s + base - bottleDisc;
    }, 0);

  const nabSubtotal = activeItems
    .filter((i) => !i.isAlcohol && i.group !== "food")
    .reduce((s, i) => s + i.price * i.qty, 0);

  const subtotal = foodSubtotal + alcSubtotal + nabSubtotal;

  const happyHourDiscount = happyHourPercent > 0
    ? Math.round(subtotal * happyHourPercent / 100)
    : 0;

  const afterHappyHour = subtotal - happyHourDiscount;

  const serviceCharge = Math.round(afterHappyHour * serviceChargeRate / 100);
  const afterService = afterHappyHour + serviceCharge;

  const discountAmt =
    discountType === "percent"
      ? Math.round((afterService * discountValue) / 100)
      : Math.min(discountValue, afterService);

  const afterDiscount = afterService - discountAmt;

  const taxableBase = foodSubtotal + nabSubtotal - (happyHourPercent > 0 ? Math.round((foodSubtotal + nabSubtotal) * happyHourPercent / 100) : 0);
  const taxableAfterDiscount = discountType === "percent"
    ? taxableBase - Math.round(taxableBase * discountValue / 100)
    : Math.max(0, taxableBase - Math.round(discountAmt * taxableBase / (afterService || 1)));

  const cgst = Math.round(taxableAfterDiscount * CGST_RATE) / 100;
  const sgst = Math.round(taxableAfterDiscount * SGST_RATE) / 100;

  const preRound = afterDiscount + cgst + sgst;
  const roundOff = Math.round(preRound) - preRound;
  const total = Math.round(preRound);

  return {
    subtotal,
    foodSubtotal,
    alcSubtotal,
    nabSubtotal,
    serviceCharge,
    happyHourDiscount,
    discount: discountAmt,
    cgst: Math.round(cgst * 100) / 100,
    sgst: Math.round(sgst * 100) / 100,
    roundOff: Math.round(roundOff * 100) / 100,
    total,
  };
}

export function isHappyHourActive(config: {
  enabled: boolean;
  days: number[];
  startTime: string;
  endTime: string;
} | null): boolean {
  if (!config || !config.enabled) return false;
  const now = new Date();
  const day = now.getDay();
  if (!config.days.includes(day)) return false;
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return currentTime >= config.startTime && currentTime <= config.endTime;
}

export function generateBillNumber(date: Date, count: number): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `HOD-${y}${m}${d}-${String(count).padStart(4, "0")}`;
}

export function getBottlePrice(pegPrice: number): number {
  const fullBottle = pegPrice * 20;
  return Math.round(fullBottle * (1 - BOTTLE_DISCOUNT_PERCENT / 100));
}

export function get60mlPrice(price30ml: number): number {
  return price30ml * 2;
}
