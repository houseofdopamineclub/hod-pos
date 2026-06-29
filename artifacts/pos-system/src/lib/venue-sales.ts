// ─────────────────────────────────────────────────────────────────────────
//  VENUE SALES  —  Boss Mode "💰 Sales" tab data layer
// ─────────────────────────────────────────────────────────────────────────
//  ONE place to know the WHOLE-VENUE sales for a date RANGE (day / week /
//  month / previous months), combining every revenue stream:
//    • TABLES  — tableReservations (live) ∪ tableHistory (released)
//    • BAR     — covers (!isTableBooking, tableId !== "NC")
//    • NC      — billDue ledger (₹1000 comp; the chargeable overage bills like
//                a normal bar bill and folds into the bar NET/GROSS/SC/TAX)
//
//  This module RE-USES the exact money math of the two per-night sources of
//  truth so a single-day range reconciles with them to the rupee:
//    • LiveReports.tsx  (tables)  →  computeHodBreakdown + persisted settle fields
//    • BarMode  BarReportsModal   →  walletBillPrintLog latest-non-dup + computeNcBill
//
//  EVERYTHING fails open (fetch error → [], never throws) so Boss Mode never
//  white-screens. Reads are ONE-SHOT range getDocs (NO live listeners) and are
//  only fired when the owner taps LOAD — idle Boss Mode pays zero read cost.
//
//  ⚠️ DOUBLE-COUNT DISCIPLINE (the whole point of "100% accurate"):
//    • Tables and Bar are DISJOINT collections → their NET/GROSS simply add.
//    • Cover redemption is NOT added to NET/GROSS (it's how a bill was paid,
//      not extra sales). It only feeds the wallet-economics tiles.
//    • The payment-method pie shows REAL TENDER COLLECTED (cash / card / upi /
//      other) — the money that physically entered the drawer. For bar/cover
//      wallets that means the LOADING tender (door activation + recharges, by
//      method), NOT the wallet redemption (redemption just spends pre-paid
//      money; counting it would double-count the cash that loaded it). Direct
//      table settlement + NC settlement add their own cash/card/upi. So pie
//      cash+card+upi+other == Cover-Charges-at-Door + Recharges + table-direct
//      + NC-collected. Wallet/aggregator/comp are tracked on `pay` but are NOT
//      shown in the 4-tender pie (they are not drawer tender).
// ─────────────────────────────────────────────────────────────────────────
import { collection, doc, getDocs, query, setDoc, where } from "firebase/firestore";
import { db } from "./firebase";
import {
  computeHodBreakdown,
  type HodCover,
  type HodTableReservation,
  type HodTransaction,
} from "./firestore-hod";
import { computeNcBill, type BillDueDoc } from "./bill-due";

// ── raw range data ────────────────────────────────────────────────────────
export interface VenueRaw {
  reservations: HodTableReservation[];
  history: HodTableReservation[];
  covers: HodCover[];
  nc: BillDueDoc[];
}

/** One-shot range fetch on the operational-night field (`date` for most
 *  collections, `operationalNight` for billDue). Single-field range → NO
 *  composite index needed. Each collection fails open to []. */
export async function fetchVenueRange(
  startNight: string,
  endNight: string,
): Promise<VenueRaw> {
  const rangeDocs = async <T,>(col: string, field: string): Promise<T[]> => {
    try {
      const q = query(
        collection(db, col),
        where(field, ">=", startNight),
        where(field, "<=", endNight),
      );
      const snap = await getDocs(q);
      return snap.docs.map((d) => ({ id: d.id, _docId: d.id, ...(d.data() as object) })) as T[];
    } catch {
      return []; // 🛟 fail-open
    }
  };
  const [reservations, history, covers, nc] = await Promise.all([
    rangeDocs<HodTableReservation>("tableReservations", "date"),
    rangeDocs<HodTableReservation>("tableHistory", "date"),
    rangeDocs<HodCover>("covers", "date"),
    rangeDocs<BillDueDoc>("billDue", "operationalNight"),
  ]);
  return { reservations, history, covers, nc };
}

// ── aggregated shape ──────────────────────────────────────────────────────
export interface PaymentMix {
  wallet: number;     // bills settled by pre-loaded cover wallet
  cash: number;
  card: number;
  upi: number;
  online: number;     // paid_online (website / razorpay direct)
  aggregator: number; // Zomato / Swiggy / EazyDiner net received
  comp: number;       // complimentary + NC comp + NC waived
  other: number;
}

export interface VenueSales {
  night: string;            // "" for a range total

  // ── sales (disjoint streams add up) ──
  netSales: number;         // tables + bar (+ NC chargeable folded into bar)
  grossSales: number;
  tableNet: number;
  tableGross: number;
  barNet: number;
  barGross: number;

  serviceCharge: number;
  tax: number;

  discount: number;
  inhouseDiscount: number;
  aggregatorDiscount: number;

  foodSales: number;
  drinkSales: number;

  // ── counts ──
  orders: number;
  guests: number;

  // ── wallet economics (all covers) ──
  coverChargesAtDoor: number; // initial entry load = coverActivated − topUpTotal
  recharges: number;          // subsequent top-ups = topUpTotal
  redeemed: number;           // coverActivated − coverBalance
  notRedeemed: number;        // leftover coverBalance (breakage, kept by house)
  ncComp: number;             // ₹1000 comp lines given away on NC tabs
  ncDiscount: number;         // discounts given on settled NC tabs
  ncWaived: number;           // full NC bills written off (waived)
  ncDue: number;              // chargeable overage billed on NC tabs (must be collected)

  // ── settlement-tender split (whole venue) ──
  pay: PaymentMix;
}

const zeroPay = (): PaymentMix => ({
  wallet: 0, cash: 0, card: 0, upi: 0, online: 0, aggregator: 0, comp: 0, other: 0,
});
const zeroSales = (night: string): VenueSales => ({
  night,
  netSales: 0, grossSales: 0,
  tableNet: 0, tableGross: 0, barNet: 0, barGross: 0,
  serviceCharge: 0, tax: 0,
  discount: 0, inhouseDiscount: 0, aggregatorDiscount: 0,
  foodSales: 0, drinkSales: 0,
  orders: 0, guests: 0,
  coverChargesAtDoor: 0, recharges: 0, redeemed: 0, notRedeemed: 0,
  ncComp: 0, ncDiscount: 0, ncWaived: 0, ncDue: 0,
  pay: zeroPay(),
});

// ── helpers ───────────────────────────────────────────────────────────────
const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);

// Mirror LiveReports.channelOf: a booking is IN-HOUSE unless its aggregator/
// source names a platform or is an unknown non-empty source ("Others").
const isInhouse = (r: HodTableReservation): boolean => {
  const s = ((r.aggregator || r.source || "") + "").toLowerCase();
  if (/swiggy|zomato|eazydiner|eazydinner/.test(s)) return false;
  return s === "" || s === "inhouse" || s === "in-house" || s === "corporate" || s === "walkin" || s === "walk-in";
};

const SMOKE_RE = /smoke|hookah|hooka|tobacco|sheesha|shisha|cigar|cigarette|\bpaan\b|vape/i;
const normName = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// Bucket a tender string into a PaymentMix key.
const tenderKey = (method: string): keyof PaymentMix => {
  const m = (method || "").toLowerCase();
  if (m.includes("cash")) return "cash";
  if (m.includes("card")) return "card";
  if (m.includes("upi")) return "upi";
  if (m.includes("paid_online") || m.includes("online") || m.includes("razorpay")) return "online";
  return "other";
};

/** Aggregate ONE operational night from its already-sliced docs.
 *  `foodNames` (optional) is the live-menu food-name set so the bar food/drink
 *  split is exact; without it, only it.t/cat tags + the smoke regex classify
 *  (NET/GROSS/SC/TAX are classification-independent, so they stay exact). */
export function aggregateNight(
  night: string,
  res: HodTableReservation[],
  hist: HodTableReservation[],
  covers: HodCover[],
  ncRows: BillDueDoc[],
  foodNames?: Set<string>,
): VenueSales {
  const out = zeroSales(night);

  // ── TABLES (live ∪ released, deduped) — mirrors LiveReports.processRes ──
  const seen = new Set<string>();
  const processRes = (r: HodTableReservation) => {
    if ((r.status || "").toLowerCase() === "cancelled") return;
    const dedupeKey = r.bookingRef
      ? `ref:${r.bookingRef}`
      : `cmp:${(r.tableId || "").toUpperCase()}|${r.bookedAt || ""}|${num(r.amountPaid)}|${r.arrivalTime || ""}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const items = (r.tabRounds || []).flatMap((rd) => rd.items || []);
    const bd = computeHodBreakdown(items);
    const subtotal = bd.subtotal;
    const isPaid = (r.paymentStatus || "").toLowerCase() === "paid";

    let sc: number, tax: number, disc: number;
    if (isPaid) {
      sc = num((r as { serviceChargeAmount?: number }).serviceChargeAmount);
      tax = num(r.taxAmount);
      disc = num(r.discountAmount);
    } else {
      sc = bd.serviceCharge;
      tax = bd.gst;
      disc = num(r.discountAmount) > 0 ? num(r.discountAmount) : subtotal * (num(r.discountPercent) / 100);
    }
    const billFinal = Math.max(0, subtotal + sc + tax - disc);
    const realized = isPaid ? (num(r.amountPaid) || billFinal) : 0;
    const value = isPaid ? realized : billFinal;

    // guests: every non-cancelled deduped table (party size).
    out.guests += num(r.partySize);

    // sales
    out.tableNet += Math.max(0, subtotal - disc);
    out.tableGross += subtotal + sc + tax;
    out.serviceCharge += sc;
    out.tax += tax;
    out.foodSales += bd.foodSubtotal;
    out.drinkSales += bd.drinkSubtotal;
    if (value > 0) out.orders += 1;

    // discount split (mirrors LiveReports: in-house vs aggregator)
    if (isInhouse(r)) {
      out.inhouseDiscount += disc;
    } else {
      out.aggregatorDiscount += disc;
      if (isPaid) {
        const aggGross = num((r as { aggregatorGrossAmount?: number }).aggregatorGrossAmount) || (num(r.amountPaid) || billFinal);
        const aggNet = (r as { aggregatorNetAmount?: number }).aggregatorNetAmount ?? (r.amountPaid ?? aggGross);
        out.aggregatorDiscount += Math.max(0, aggGross - num(aggNet));
      }
    }

    // payment mix — settlement tender (only settled bills tender money)
    const comp = (r as { complimentary?: boolean }).complimentary;
    if (comp) {
      out.pay.comp += num((r as { complimentaryValue?: number }).complimentaryValue) || (subtotal + sc + tax - disc);
    } else if (isPaid) {
      if (!isInhouse(r)) {
        const aggGross = num((r as { aggregatorGrossAmount?: number }).aggregatorGrossAmount) || (num(r.amountPaid) || billFinal);
        const aggNet = (r as { aggregatorNetAmount?: number }).aggregatorNetAmount ?? (r.amountPaid ?? aggGross);
        out.pay.aggregator += num(aggNet);
      } else {
        // walletSlice = the part paid from a pre-loaded cover. We do NOT add it
        // to pay.wallet — that money's real tender (cash/card/upi) is counted at
        // wallet-LOADING time in the cover tender loop below; counting it here
        // too would double-count. Only the `direct` remainder is fresh tender.
        const walletSlice = num((r as { walletPaidAmount?: number }).walletPaidAmount);
        const direct = Math.max(0, num(r.amountPaid) - walletSlice);
        const splits = (r as { paymentSplits?: Array<{ method: string; amount: number }> }).paymentSplits;
        if (splits && splits.length) {
          const sum = splits.reduce((s, sp) => s + num(sp.amount), 0);
          const f = sum > 0 ? direct / sum : 0;
          for (const sp of splits) out.pay[tenderKey(sp.method)] += num(sp.amount) * f;
        } else if (direct > 0) {
          out.pay[tenderKey(r.paymentMode || "")] += direct;
        }
      }
    }
  };
  for (const r of res) processRes(r);
  for (const r of hist) processRes(r);

  // ── BAR (covers, !isTableBooking & tableId !== "NC") — mirrors BarMode ──
  const bar = covers.filter((c) => !c.isTableBooking && (c.tableId || "").toUpperCase() !== "NC");
  const activated = bar.filter((c) => num(c.coverActivated) > 0);

  // item-level food/drink/other from served|activated tab rounds
  let drinkSales = 0, foodSales = 0, otherSales = 0;
  const classify = (name: string, cat: string, t?: string) => {
    const isSmoke = SMOKE_RE.test(cat) || SMOKE_RE.test(name);
    const isFood = t === "food" || (foodNames?.has(normName(name)) ?? false) || /^food/i.test(cat);
    return isSmoke ? "other" : isFood ? "food" : "drink";
  };
  for (const c of bar) {
    for (const rd of c.tabRounds || []) {
      if (!rd || (rd.status !== "activated" && rd.status !== "served")) continue;
      for (const it of rd.items || []) {
        const line = num(it.p) * num(it.qty);
        const k = classify(it.n || "—", String((it as { cat?: string }).cat || ""), it.t);
        if (k === "other") otherSales += line;
        else if (k === "food") foodSales += line;
        else drinkSales += line;
      }
    }
  }

  // NC chargeable (>₹1000) folds into the bar sales like a normal bar bill
  let ncChargeSC = 0, ncChargeTax = 0, ncChargeGross = 0, ncChargeBillCount = 0;
  const nc = ncRows.filter((r) => r.operationalNight === night);
  for (const r of nc) {
    const items = r.items || [];
    const rb = computeNcBill(items, 1000);
    ncChargeSC += rb.serviceCharge;
    ncChargeTax += rb.gst;
    ncChargeGross += rb.amountDue;
    if (rb.amountDue > 0) ncChargeBillCount += 1;
    const fracR = rb.subtotal > 0 ? Math.min(1, Math.max(0, (rb.subtotal - rb.compApplied) / rb.subtotal)) : 0;
    if (fracR <= 0) continue;
    for (const it of items) {
      const chargeLine = num(it.p) * num(it.qty) * fracR;
      if (chargeLine <= 0) continue;
      const k = classify(it.n || "—", "", (it as { t?: string }).t);
      if (k === "other") otherSales += chargeLine;
      else if (k === "food") foodSales += chargeLine;
      else drinkSales += chargeLine;
    }
  }
  const baseSales = drinkSales + foodSales + otherSales;

  // bar SC / tax / discount + bill count from walletBillPrintLog (latest
  // non-duplicate entry per wallet = the final cumulative bill).
  let billCount = 0, discountTotal = 0, scTotal = 0, taxTotal = 0;
  const atMs = (b: { at?: string }) => { const t = new Date(b?.at || 0).getTime(); return isNaN(t) ? 0 : t; };
  for (const c of bar) {
    const log = (c.walletBillPrintLog || []).filter((b) => !b.isDuplicate);
    if (log.length === 0) continue;
    const last = log.reduce((a, b) => (atMs(b) >= atMs(a) ? b : a));
    billCount += 1;
    discountTotal += num((last as { discount?: number }).discount);
    scTotal += num((last as { serviceCharge?: number }).serviceCharge);
    taxTotal += num((last as { tax?: number }).tax);
  }
  scTotal += ncChargeSC;
  taxTotal += ncChargeTax;

  // NC settle discounts (live on billDue ledger, not walletBillPrintLog)
  const ncDiscount = nc
    .filter((r) => r.status !== "open" && r.paymentMethod !== "waived" && typeof r.finalAmount === "number" && num(r.amountDue) - num(r.finalAmount) > 0)
    .reduce((s, r) => s + (num(r.amountDue) - num(r.finalAmount)), 0);

  const barRedeemed = activated.reduce((s, c) => s + Math.max(0, num(c.coverActivated) - num(c.coverBalance)), 0);

  out.barNet = Math.max(0, baseSales - discountTotal);
  out.barGross = barRedeemed + ncChargeGross;
  out.serviceCharge += scTotal;
  out.tax += taxTotal;
  out.inhouseDiscount += discountTotal + ncDiscount;
  out.ncDiscount += ncDiscount;
  out.ncDue += ncChargeGross;
  out.foodSales += foodSales;
  out.drinkSales += drinkSales;
  out.orders += billCount + ncChargeBillCount;

  // NOTE: bar bills settle by wallet REDEMPTION (barRedeemed) — that is NOT
  // fresh tender, it spends money already collected when the wallet was loaded.
  // The real cash/card/upi for bar covers is attributed in the cover tender
  // loop below (door activation + recharges). So we deliberately do NOT add
  // barRedeemed to the payment-method pie (it would double-count).
  // NC cash actually collected (settled, non-waived) by method; comp + waived → comp
  for (const r of nc) {
    if (r.status === "open") continue;
    if (r.paymentMethod === "waived") { out.pay.comp += num(r.amountDue); out.ncWaived += num(r.amountDue); continue; }
    const collected = typeof r.finalAmount === "number" ? num(r.finalAmount) : num(r.amountDue);
    out.pay[tenderKey(String(r.paymentMethod || ""))] += collected;
  }

  // ── WALLET ECONOMICS (ALL covers: bar + table + entry/guestlist) ──
  for (const c of covers) {
    const activatedAmt = num(c.coverActivated);
    if (activatedAmt <= 0) continue;
    const topUps = num(c.topUpTotal);
    out.coverChargesAtDoor += Math.max(0, activatedAmt - topUps);
    out.recharges += topUps;
    out.redeemed += Math.max(0, activatedAmt - num(c.coverBalance));
    out.notRedeemed += Math.max(0, num(c.coverBalance));
    // entry/bar (non-table) cover guests — table guests already counted via reservation
    if (!c.isTableBooking) {
      out.guests += num((c as { partySize?: number }).partySize) || num((c as { guests?: number }).guests) || 1;
    }

    // ── REAL TENDER COLLECTED to LOAD this wallet (door activation + recharges) ──
    // This is the cash/card/upi that physically entered the drawer. The recharge
    // transactions carry their own method (`<method>_topup` / `split_topup`); the
    // remaining (= original door/booking activation) uses the activation method.
    // We force the per-cover tender to sum to `activatedAmt` so the pie reconciles
    // EXACTLY to (Cover Charges at Door + Recharges) — any unknown method → other.
    let assigned = 0;
    const txns = (c as { transactions?: HodTransaction[] }).transactions || [];
    for (const tx of txns) {
      const ty = String((tx as { type?: string }).type || "");
      const amt = num((tx as { amount?: number }).amount);
      if (ty === "split_topup") {
        const sp = (tx as { split?: { cash?: number; upi?: number; card?: number } }).split || {};
        out.pay.cash += num(sp.cash); out.pay.upi += num(sp.upi); out.pay.card += num(sp.card);
        assigned += num(sp.cash) + num(sp.upi) + num(sp.card);
      } else if (/_topup$/.test(ty) && amt > 0) {
        out.pay[tenderKey(ty.replace(/_topup$/, ""))] += amt;
        assigned += amt;
      }
    }
    // door / original activation remainder, split by the activation method/split
    const rest = activatedAmt - assigned;
    if (rest > 0.5) {
      const aSplit = (c as { coverPaymentSplit?: { cash?: number; upi?: number; card?: number } }).coverPaymentSplit;
      const aSum = aSplit ? num(aSplit.cash) + num(aSplit.upi) + num(aSplit.card) : 0;
      if (aSum > 0) {
        // distribute `rest` by the recorded split ratio so it sums to `rest` exactly
        const fc = num(aSplit!.cash) / aSum, fu = num(aSplit!.upi) / aSum;
        const rc = rest * fc, ru = rest * fu;
        out.pay.cash += rc; out.pay.upi += ru; out.pay.card += rest - rc - ru;
      } else {
        out.pay[tenderKey(String(
          (c as { coverPaymentMethod?: string }).coverPaymentMethod || c.paymentMethod || "",
        ))] += rest;
      }
    }
  }

  // NC comp (given away) + roll-ups — mirror BarMode ncCompOf: prefer the
  // stored compApplied, else (legacy rows) sum the value of `free` lines so
  // previous-month NC tabs reconcile to the rupee.
  const ncCompOf = (r: BillDueDoc): number => {
    if (typeof r.compApplied === "number") return num(r.compApplied);
    return (r.items || [])
      .filter((it) => (it as { free?: boolean }).free)
      .reduce((s, it) => s + num(it.qty) * num(it.p ?? (it as { price?: number }).price), 0);
  };
  out.ncComp = nc.reduce((s, r) => s + ncCompOf(r), 0);
  out.pay.comp += out.ncComp;

  out.netSales = out.tableNet + out.barNet;
  out.grossSales = out.tableGross + out.barGross;
  out.discount = out.inhouseDiscount + out.aggregatorDiscount;
  return out;
}

/** Sum a set of per-night summaries into a single total (night ""). */
function sumSales(nights: VenueSales[]): VenueSales {
  const t = zeroSales("");
  for (const n of nights) {
    t.netSales += n.netSales; t.grossSales += n.grossSales;
    t.tableNet += n.tableNet; t.tableGross += n.tableGross;
    t.barNet += n.barNet; t.barGross += n.barGross;
    t.serviceCharge += n.serviceCharge; t.tax += n.tax;
    t.discount += n.discount; t.inhouseDiscount += n.inhouseDiscount; t.aggregatorDiscount += n.aggregatorDiscount;
    t.foodSales += n.foodSales; t.drinkSales += n.drinkSales;
    t.orders += n.orders; t.guests += n.guests;
    t.coverChargesAtDoor += n.coverChargesAtDoor; t.recharges += n.recharges;
    t.redeemed += n.redeemed; t.notRedeemed += n.notRedeemed;
    t.ncComp += n.ncComp; t.ncDiscount += n.ncDiscount; t.ncWaived += n.ncWaived; t.ncDue += n.ncDue;
    t.pay.wallet += n.pay.wallet; t.pay.cash += n.pay.cash; t.pay.card += n.pay.card;
    t.pay.upi += n.pay.upi; t.pay.online += n.pay.online; t.pay.aggregator += n.pay.aggregator;
    t.pay.comp += n.pay.comp; t.pay.other += n.pay.other;
  }
  return t;
}

export interface VenueSalesResult {
  total: VenueSales;
  perNight: VenueSales[]; // sorted ascending by night (daily trend)
}

/** Group raw range docs by operational night, aggregate each night, and sum. */
export function aggregateVenueSales(raw: VenueRaw, foodNames?: Set<string>): VenueSalesResult {
  const nights = new Set<string>();
  for (const r of raw.reservations) if (r.date) nights.add(r.date);
  for (const r of raw.history) if (r.date) nights.add(r.date);
  for (const c of raw.covers) if (c.date) nights.add(c.date);
  for (const n of raw.nc) if (n.operationalNight) nights.add(n.operationalNight);

  const byNight = (arr: HodTableReservation[], n: string) => arr.filter((d) => d.date === n);
  const perNight = Array.from(nights).sort().map((n) =>
    aggregateNight(
      n,
      byNight(raw.reservations, n),
      byNight(raw.history, n),
      raw.covers.filter((c) => c.date === n),
      raw.nc.filter((d) => d.operationalNight === n),
      foodNames,
    ),
  );
  return { total: sumSales(perNight), perNight };
}

// ─────────────────────────────────────────────────────────────────────────
//  LAZY AUTO-CACHE  —  daily_summaries (one tiny doc per operational night)
// ─────────────────────────────────────────────────────────────────────────
//  Reading a month/year of RAW reservations + covers + NC ledgers costs one
//  Firestore read PER DOC (thousands). That's the only real read cost left.
//  Fix: the first time anyone views a CLOSED (past) night, we compute it once
//  from raw and write a single summary doc to `daily_summaries/{night}`. Every
//  later view of that night reads ONE doc instead of re-scanning everything.
//
//  • CLOSED nights (night < today) are cacheable — they never change again.
//  • The CURRENT night (and any future) is ALWAYS computed live (still moving),
//    never cached.
//  • Empty closed nights are cached as zeros too, so a dead night is scanned
//    only once, ever.
//  • EVERYTHING fails open: if the cache read/write is denied (e.g. rules not
//    yet published) the feature simply falls back to live compute every time —
//    same correct numbers, just not cheaper. Nothing breaks.
//
//  Bump SUMMARY_SCHEMA whenever the aggregation MATH changes so stale cached
//  summaries are ignored and recomputed (old docs with a lower _schema = miss).
// ─────────────────────────────────────────────────────────────────────────
export const SUMMARY_SCHEMA = 2;
const SUMMARY_COL = "daily_summaries";

/** Inclusive list of YYYY-MM-DD nights from `start` to `end` (calendar days). */
function listNights(start: string, end: string): string[] {
  const out: string[] = [];
  const [ys, ms, ds] = start.split("-").map(Number);
  const [ye, me, de] = end.split("-").map(Number);
  if (!ys || !ms || !ds || !ye || !me || !de) return out;
  const cur = new Date(ys, ms - 1, ds);
  const last = new Date(ye, me - 1, de);
  const p = (n: number) => String(n).padStart(2, "0");
  let guard = 0;
  while (cur <= last && guard++ < 1000) {
    out.push(`${cur.getFullYear()}-${p(cur.getMonth() + 1)}-${p(cur.getDate())}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/** Rebuild a VenueSales from a stored summary doc, defaulting every field so a
 *  partial/legacy doc can never NaN the dashboard. */
function summaryFromDoc(night: string, data: Record<string, unknown>): VenueSales {
  const base = zeroSales(night);
  const n = (k: keyof VenueSales) => num((data as Record<string, unknown>)[k as string]);
  const p = (data.pay || {}) as Record<string, unknown>;
  return {
    ...base,
    night,
    netSales: n("netSales"), grossSales: n("grossSales"),
    tableNet: n("tableNet"), tableGross: n("tableGross"),
    barNet: n("barNet"), barGross: n("barGross"),
    serviceCharge: n("serviceCharge"), tax: n("tax"),
    discount: n("discount"), inhouseDiscount: n("inhouseDiscount"), aggregatorDiscount: n("aggregatorDiscount"),
    foodSales: n("foodSales"), drinkSales: n("drinkSales"),
    orders: n("orders"), guests: n("guests"),
    coverChargesAtDoor: n("coverChargesAtDoor"), recharges: n("recharges"),
    redeemed: n("redeemed"), notRedeemed: n("notRedeemed"),
    ncComp: n("ncComp"), ncDiscount: n("ncDiscount"), ncWaived: n("ncWaived"), ncDue: n("ncDue"),
    pay: {
      wallet: num(p.wallet), cash: num(p.cash), card: num(p.card), upi: num(p.upi),
      online: num(p.online), aggregator: num(p.aggregator), comp: num(p.comp), other: num(p.other),
    },
  };
}

/** Read cached summaries for [start,end] whose schema matches. Fail-open → {}. */
async function readSummaryCache(start: string, end: string): Promise<Map<string, VenueSales>> {
  const m = new Map<string, VenueSales>();
  try {
    const q = query(
      collection(db, SUMMARY_COL),
      where("night", ">=", start),
      where("night", "<=", end),
    );
    const snap = await getDocs(q);
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>;
      if (num(data._schema) !== SUMMARY_SCHEMA) continue; // stale → treat as miss
      const night = typeof data.night === "string" ? data.night : d.id;
      m.set(night, summaryFromDoc(night, data));
    }
  } catch {
    /* 🛟 denied / offline → empty cache → falls back to live compute */
  }
  return m;
}

/** Write one night's summary (fire-and-forget, fail-open). */
async function writeSummaryCache(night: string, s: VenueSales): Promise<void> {
  try {
    await setDoc(doc(db, SUMMARY_COL, night), {
      ...s,
      night,
      _schema: SUMMARY_SCHEMA,
      _computedAt: Date.now(),
    });
  } catch {
    /* 🛟 rules not published yet / offline → silently skip, recompute next time */
  }
}

export interface CachedVenueSalesResult extends VenueSalesResult {
  /** how each night in the range was sourced (transparency + read-cost note) */
  fromCache: number;  // read from a saved summary doc (cheap)
  computed: number;   // closed night computed from raw this time, then saved
  live: number;       // current/future night computed live (never cached)
}

/** Read-cost-safe range load: reads saved summaries for closed nights, computes
 *  + saves any missing closed night ONCE, and always computes the current night
 *  live. Reconciles to the rupee with aggregateVenueSales for the same range. */
export async function getVenueSalesCached(
  start: string,
  end: string,
  today: string,
  foodNames?: Set<string>,
): Promise<CachedVenueSalesResult> {
  let s = start, e = end;
  if (s > e) { const t = s; s = e; e = t; }
  const nights = listNights(s, e);
  const cache = await readSummaryCache(s, e);

  const perNight: VenueSales[] = [];
  const closedMissing: string[] = [];
  const liveNights: string[] = [];
  let fromCache = 0;

  for (const n of nights) {
    if (n >= today) { liveNights.push(n); continue; } // current/future → live
    const c = cache.get(n);
    if (c) { perNight.push(c); fromCache++; }
    else closedMissing.push(n);
  }

  // compute + persist missing CLOSED nights (one bounding-range raw fetch)
  let computed = 0;
  if (closedMissing.length) {
    const lo = closedMissing[0];
    const hi = closedMissing[closedMissing.length - 1];
    const raw = await fetchVenueRange(lo, hi);
    const agg = aggregateVenueSales(raw, foodNames);
    const byNight = new Map(agg.perNight.map((p) => [p.night, p]));
    for (const n of closedMissing) {
      const summ = byNight.get(n) || zeroSales(n);
      perNight.push(summ);
      computed++;
      void writeSummaryCache(n, summ); // fire-and-forget, fail-open
    }
  }

  // current / future nights — always live, never cached
  let live = 0;
  if (liveNights.length) {
    const lo = liveNights[0];
    const hi = liveNights[liveNights.length - 1];
    const raw = await fetchVenueRange(lo, hi);
    const agg = aggregateVenueSales(raw, foodNames);
    const byNight = new Map(agg.perNight.map((p) => [p.night, p]));
    for (const n of liveNights) { perNight.push(byNight.get(n) || zeroSales(n)); live++; }
  }

  perNight.sort((a, b) => (a.night < b.night ? -1 : a.night > b.night ? 1 : 0));
  // Drop synthetic all-zero nights from the RETURNED rows so per-night output
  // matches aggregateVenueSales (which only emits nights that had activity).
  // The zero summaries are still WRITTEN to cache above so a dead night is
  // never re-scanned. Totals are identical (empties contribute 0).
  const nonEmpty = perNight.filter((s) => !isEmptyNight(s));
  return { total: sumSales(nonEmpty), perNight: nonEmpty, fromCache, computed, live };
}

/** True when a night carries no money/activity at all (venue closed / dead). */
function isEmptyNight(s: VenueSales): boolean {
  return s.netSales === 0 && s.grossSales === 0 && s.serviceCharge === 0 && s.tax === 0 &&
    s.discount === 0 && s.orders === 0 && s.guests === 0 && s.recharges === 0 &&
    s.redeemed === 0 && s.notRedeemed === 0 && s.coverChargesAtDoor === 0 &&
    s.ncComp === 0 && s.ncDiscount === 0 && s.ncWaived === 0 && s.ncDue === 0;
}
