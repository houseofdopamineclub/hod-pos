// 📋 REPORTS — comprehensive owner-facing log of EVERYTHING that happened
// tonight, with one-click CSV export (opens natively in Excel + Google Sheets).
//
// Two reports:
//   1) ALL TABLES tonight  — every reservation across GF / Dining / Rooftop
//      regardless of source (Zomato, Swiggy, EazyDiner, walk-in, in-house, etc).
//      Fields: source, name, phone, email, party size, table, floor, captain,
//              arrival, paid-at, time-on-table, sub/discount/tax/total, paid
//              status, payment method (with full aggregator amount when paid
//              via Zomato/Swiggy/etc), bill prints (RED if >1), modified-discount
//              flag, anti-fraud flags (overrides/voids/source-swaps), and an
//              overall AMBIGUITY rating: GREEN / ORANGE / RED.
//   2) WALLETS / GUESTLIST / NIGHTLIFE — every cover-wallet doc tonight (online
//      bookings + guestlist + walk-in covers + aggregator covers). Fields: name,
//      phone, email, ref, event, agent who activated, recharged, redeemed,
//      balance, table, arrival, last-bill-at.
//
// Ambiguity rating (tables):
//   RED    → bill printed >1× OR voids OR source-swap downgrade OR
//            unpaid > 60min after bill OR aggregator→inhouse override
//   ORANGE → modified discount OR any override/source-swap OR billStale
//            OR unpaid > 30min after bill
//   GREEN  → paid clean, single bill print, no overrides
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { collection, onSnapshot, query, where, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  subscribeToHodReservations, subscribeToBookings, subscribeToGuestlist,
  subscribeToBookingsForNights, subscribeToGuestlistInRange, subscribeToCoversForNight,
  AGGREGATOR_OPTIONS, getAggregatorDiscount,
  type HodTableReservation, type HodBooking, type HodGuestlistEntry, type HodCover,
} from "@/lib/firestore-hod";
import { getOperationalNightStr } from "@/lib/utils-pos";
import { refundEdcCharge } from "@/lib/edc-charge";
import {
  buildAllTallyRows, aggregateCaptainLeakage,
  type PosKotDoc, type TallyRow,
} from "@/lib/kot-bill-tally";
import {
  parseSettlementCsv, reconcile,
  type ReconResult, type SettlementVendor,
} from "@/lib/settlement-recon";

const GOLD = "#C9A84C";
const RED = "#ef4444";
const ORANGE = "#f59e0b";
const AMBER = "#f59e0b";
const GREEN = "#22c55e";

type Ambiguity = "green" | "orange" | "red";

interface TableRow {
  reservationId: string;
  source: string;
  sourceLabel: string;
  customerName: string;
  phone: string;
  email: string;
  partySize: number;
  tableId: string;
  floor: string;
  captain: string;
  arrival: string;
  paidAt: string;
  minutesOnTable: number;
  subtotal: number;
  discountPct: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
  /** 2026-05-15 — Khushi: ₹ slice of `amountPaid` settled via customer wallet
   *  redemption(s) at table close. Cash drawer = amountPaid − walletPaidAmount. */
  walletPaidAmount: number;
  /** Per-wallet breakdown for audit (max 4 wallets per table in practice). */
  walletRedemptionDetails: string;
  paymentStatus: string;
  paymentMethod: string;
  /** When paid via aggregator, the full aggregator-side amount (= total before
   *  discount strip if the aggregator absorbed it; for our case Zomato/Swiggy
   *  pay us the post-discount total). Logged separately for reconciliation. */
  aggregatorPaidAmount: number;
  /** 🔴 2026-05-12 — For aggregator orders the captain prints the FULL bill
   *  (no discount applied at the door); the aggregator's discount is shown
   *  here as the net amount the venue actually receives. `total` is what the
   *  customer was billed; `aggregatorNetAmount` is what the venue nets. */
  aggregatorNetAmount: number | null;
  /** Reconciliation: actual paid by aggregator MINUS what we expected (post-discount total).
   *  Only populated when we actually matched an `orphanZomatoPayments` row by phone.
   *  Positive = aggregator overpaid (rare), negative = short payment (likely captain over-discount fraud).
   *  null = no orphan match yet (don't show a misleading number). */
  aggregatorVariance: number | null;
  billPrintCount: number;
  modifiedDiscount: boolean;
  defaultDiscount: number;
  overrideCount: number;
  voidCount: number;
  voidValueLost: number;
  sourceSwapCount: number;
  hasDowngrade: boolean;
  unpaidMinutesAfterBill: number;
  ambiguity: Ambiguity;
  flags: string[];
}

interface WalletRow {
  coverId: string;
  ref: string;
  name: string;
  phone: string;
  email: string;
  eventTitle: string;
  date: string;
  // 🔴 UX 2026-05-10 — split "online-booking" into precise categories matching
  // hodclub.in's customer-side flows so dashboard reads like the customer sees it:
  //   guestlist | entry-only | cover | group-booking | walk-in | aggregator
  source: string;
  // For cover/entry-only/group-booking rows — what's the truth from hodclub.in?
  //   "paid_online"  = pay_*/order_* paymentId (Razorpay verified)
  //   "pay_at_venue" = cash_* paymentId (customer chose cash-at-door)
  //   "free_entry"   = free_*/free_entry_* paymentId OR LADIES (entryType=female/ladies/free) — complimentary
  //   "unknown"      = booking exists but NO paymentId at all (legacy / admin-created / abandoned checkout)
  //   ""             = N/A (guestlist/walkin/aggregator — no online payment ever expected)
  // 🔴 2026-05-25 v4 (Khushi screenshot) — WALK-IN now derives the actual
  // recharge method from cover.transactions and reports it as cash/upi/
  // card/split instead of the useless "WALKIN" duplicate label.
  payChannel: "" | "paid_online" | "pay_at_venue" | "free_entry" | "unknown" | "cash" | "upi" | "card" | "split";
  // Razorpay payment id (when present) — used for the "verify on Razorpay" link
  paymentId?: string;
  isGuestList: boolean;
  agent: string;
  activatedAt: string;
  checkedIn: boolean;
  arrival: string;
  coverActivated: number;
  topUpTotal: number;
  coverUsed: number;
  coverBalance: number;
  paymentMethod: string;
  tableId: string;
  walletBillPrints: number;
  lastBillAt: string;
  // 🆕 v3.226 (Khushi) — final-bill money breakdown surfaced from the cover's
  // walletBillPrintLog so the Admin Wallets tab (esp. bar walk-ins WALKIN-1/2…)
  // carries the actual BILL with all details and downloads it. Uses the LATEST
  // non-duplicate bill per cover (true cumulative total; same rule as Live Reports).
  billTotal: number;
  billSubtotal: number;
  billDiscount: number;
  billServiceCharge: number;
  billTax: number;
  billNumber: string;
  // 🆕 2026-06-24 (Khushi) — PER-RECHARGE DISCOUNT RECONCILIATION. Summed from
  // each recharge transaction's immutable stamp (tx.discountPct / tx.grossAmount),
  // NOT recomputed from the single overwriteable cover.billDiscountPct field — so
  // a 10% recharge followed by a 5% recharge keeps BOTH discounts on record and
  // the totals reconcile. `rechargeGross` = total pre-discount; `rechargeDiscount`
  // = total rupees discounted across all recharges (gross − net).
  rechargeGross: number;
  rechargeDiscount: number;
}

function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, day: "2-digit", month: "short" });
}
function csvEscape(v: any): string {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function downloadCSV(filename: string, rows: Array<Record<string, any>>): void {
  if (!rows.length) { alert("Nothing to export — no rows in current view."); return; }
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  // Prepend BOM so Excel opens UTF-8 (₹, emojis) cleanly.
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function buildTableRow(r: HodTableReservation, orphanByPhone: Map<string, any>): TableRow {
  const aggName = r.aggregator || r.source || "inhouse";
  const sourceLabel = AGGREGATOR_OPTIONS.find(a => a.value === aggName)?.label || aggName;
  const defDisc = getAggregatorDiscount(aggName);
  const actDisc = r.aggregatorDiscount ?? defDisc;
  const total = Number(r.tabTotal || 0);
  const subtotal = total > 0 && actDisc > 0 ? Math.round(total / (1 - actDisc / 100)) : total;
  const discountAmount = subtotal - total;
  const overrides = (r.discountOverrideLog || []).length;
  const sourceSwapLog = ((r as any).sourceOverrideLog as any[]) || [];
  const hasDowngrade = sourceSwapLog.some((s) => s.from && s.from !== "inhouse" && s.to === "inhouse");
  const voidValueLost = (r.voidLog || []).reduce((s, v) => s + Number(v.valueLost || 0), 0);
  const billPrintCount = r.billPrintCount || 0;
  // Only flag as "modified" if a captain explicitly changed it via the
  // Source/Discount panel. Online bookings created with non-default discount
  // by hodclub.in or admin.html are NOT captain edits and must not be flagged.
  const modifiedDiscount = !!(r as any).discountModifiedByCaptain && actDisc !== defDisc;

  // Compute time on table
  const arrIso = r.actualArrivalTime
    ? (r.actualArrivalTime.includes("T") ? r.actualArrivalTime : `${r.date}T${r.actualArrivalTime}`)
    : (r.arrivalTime ? `${r.date}T${r.arrivalTime}` : "");
  const arrMs = arrIso ? new Date(arrIso).getTime() : 0;
  const endMs = r.paidAt ? new Date(r.paidAt).getTime() : Date.now();
  const minutesOnTable = arrMs && !isNaN(arrMs) ? Math.max(0, Math.floor((endMs - arrMs) / 60_000)) : 0;

  // Unpaid-minutes-after-bill
  let unpaidMinAfterBill = 0;
  if (r.paymentStatus !== "paid" && r.lastBillPrintedAt) {
    unpaidMinAfterBill = Math.max(0, Math.floor((Date.now() - new Date(r.lastBillPrintedAt).getTime()) / 60_000));
  }

  // Payment method + aggregator-paid amount
  const isAggregatorSrc = aggName !== "inhouse";
  const orphan = orphanByPhone.get((r.phone || "").replace(/\D/g, "").slice(-10));
  const paymentMethod = (r as any).paymentMethod || (r as any).paymentMode || (orphan?.paymentChannel || (isAggregatorSrc ? aggName : ""));
  const aggregatorPaidAmount = orphan ? Number(orphan.paidAmount || 0) :
    (isAggregatorSrc && r.paymentStatus === "paid" ? total : 0);
  // Variance: only compute when we actually have an orphan-payment match for an aggregator tab.
  // Otherwise we'd just be subtracting total from itself.
  const aggregatorVariance = (orphan && isAggregatorSrc) ? (Number(orphan.paidAmount || 0) - total) : null;

  // Ambiguity
  const flags: string[] = [];
  if (billPrintCount > 1) flags.push(`bill-printed-${billPrintCount}x`);
  if (voidValueLost > 0) flags.push(`voids-₹${voidValueLost}`);
  if (overrides > 0) flags.push(`${overrides}-override(s)`);
  if (sourceSwapLog.length > 0) flags.push(`${sourceSwapLog.length}-source-swap(s)`);
  if (hasDowngrade) flags.push("AGG-DOWNGRADE");
  if (aggregatorVariance !== null && Math.abs(aggregatorVariance) >= 200) flags.push(`agg-variance-₹${aggregatorVariance}`);
  if (modifiedDiscount) flags.push(`modified-discount(${defDisc}%→${actDisc}%)`);
  if (r.billStale) flags.push("bill-stale");
  if (unpaidMinAfterBill >= 60) flags.push(`unpaid-${unpaidMinAfterBill}min`);
  else if (unpaidMinAfterBill >= 30) flags.push(`unpaid-${unpaidMinAfterBill}min`);
  // Khushi 23 May 2026: Zomato emails legitimately don't carry pax/phone/time
  // (full details come via SMS path). So `needsManualReview` on a Zomato row
  // is EXPECTED, not an alert. Soften it: show a yellow "add-details" hint
  // instead of a red "needs-review" siren, and don't push ambiguity to RED.
  // For non-Zomato sources, an actual auto-assign failure still surfaces red.
  const isZomatoNeedsDetails = r.needsManualReview && aggName === "zomato";
  if (r.needsManualReview && !isZomatoNeedsDetails) flags.push("needs-review");
  else if (isZomatoNeedsDetails) flags.push("add-details");

  let ambiguity: Ambiguity = "green";
  if (billPrintCount > 1 || voidValueLost > 0 || hasDowngrade || unpaidMinAfterBill >= 60 ||
      (r.needsManualReview && !isZomatoNeedsDetails) ||
      (aggregatorVariance !== null && aggregatorVariance <= -500)) ambiguity = "red";
  else if (overrides > 0 || sourceSwapLog.length > 0 || modifiedDiscount || r.billStale || unpaidMinAfterBill >= 30 ||
      isZomatoNeedsDetails ||
      (aggregatorVariance !== null && Math.abs(aggregatorVariance) >= 200)) ambiguity = "orange";

  return {
    reservationId: r._docId,
    source: aggName, sourceLabel,
    customerName: r.customerName || "",
    phone: r.phone || "",
    email: (r as any).email || (orphan?.email) || "",
    partySize: Number(r.partySize || 0),
    tableId: r.tableId || "",
    floor: r.floorLabel || r.floor || "",
    captain: r.captainName || "",
    arrival: arrIso,
    paidAt: r.paidAt || "",
    minutesOnTable,
    subtotal, discountPct: actDisc, discountAmount,
    taxAmount: Number(r.taxAmount || 0),
    total, amountPaid: Number(r.amountPaid || (r.paymentStatus === "paid" ? total : 0)),
    // 2026-05-15 — wallet redemption columns. `walletPaidAmount` is the cached
    // sum at markPaid (live filter); fall back to walking the array for legacy
    // rows where markPaid happened before the cache field was added.
    walletPaidAmount: Number(
      (r as any).walletPaidAmount ??
      (Array.isArray((r as any).walletRedemptions)
        ? (r as any).walletRedemptions.reduce((s: number, w: any) => s + Number(w.amount || 0), 0)
        : 0)
    ),
    walletRedemptionDetails: Array.isArray((r as any).walletRedemptions)
      ? (r as any).walletRedemptions
          .map((w: any) => `${w.walletRef}:₹${w.amount}${w.walletName ? ` (${w.walletName})` : ""}`)
          .join(" | ")
      : "",
    paymentStatus: r.paymentStatus || "open",
    paymentMethod, aggregatorPaidAmount, aggregatorVariance,
    // 🔴 2026-05-12 — Either trust the value the captain stamped at Mark
    // Paid time, or fall back to subtotal*(1-disc) for legacy rows that
    // pre-date the field.
    aggregatorNetAmount: (r as any).aggregatorNetAmount ?? (
      isAggregatorSrc && actDisc > 0 && total > 0
        ? Math.round(total * (1 - actDisc / 100))
        : null
    ),
    billPrintCount, modifiedDiscount, defaultDiscount: defDisc,
    overrideCount: overrides, voidCount: (r.voidLog || []).length, voidValueLost,
    sourceSwapCount: sourceSwapLog.length, hasDowngrade,
    unpaidMinutesAfterBill: unpaidMinAfterBill,
    ambiguity, flags,
  };
}

// 🔴 UX 2026-05-10 — shared classifier so cover-rows and synth-booking-rows
// land in the SAME 5 buckets that match hodclub.in's customer flows:
//   GUESTLIST · ENTRY ONLY · COVER · GROUP BOOKING · WALK-IN · AGGREGATOR
// payChannel ("paid_online" vs "pay_at_venue") is set for cover/entry-only/
// group-booking rows so the dashboard can show the badge next to the label.
// Fallback: anything we cannot confidently classify falls back to "cover" so
// nothing disappears from the report — matches the prior safe default.
function classifyWallet(args: {
  paymentId?: string; entryType: string; isGuestListFlag: boolean;
  hasGuestMatch: boolean; coverSource: string; aggregator?: any;
  bookingTotal?: number; paymentMethod?: string;
}): { source: string; payChannel: WalletRow["payChannel"]; isGuestList: boolean } {
  const et = (args.entryType || "").toLowerCase();
  const cs = (args.coverSource || "").toLowerCase();
  const pid = String(args.paymentId || "").trim();
  // 🔴 UX 2026-05-10 (v3) — payChannel reflects the TRUTH from the booking:
  //   pay_/order_ prefix             → 💚 PAID ONLINE  (Razorpay verified)
  //   cash_ prefix                   → 💵 PAY AT VENUE (customer chose cash-at-door)
  //   free_/free_entry_ prefix       → 🆓 FREE ENTRY   (ladies / complimentary)
  //   entryType ladies/female/free   → 🆓 FREE ENTRY   (intent — even if paymentId missing)
  //   bookingTotal === 0 (real)      → 🆓 FREE ENTRY   (free entry across the board)
  //   anything else (no paymentId)   → ⚠ UNKNOWN — booking has no payment record, NEEDS MANUAL CHECK
  // 🔴 PRECEDENCE: real payment proof beats free-entry heuristics. So if a LADIES
  // booking somehow has a real Razorpay pay_*, we honor the money trail (truth wins).
  let payChannel: WalletRow["payChannel"] = "";
  const isFreeEntryType = et === "female" || et === "ladies" || et === "free";
  if (pid.startsWith("cash_")) payChannel = "pay_at_venue";
  else if (pid.startsWith("pay_") || pid.startsWith("order_")) payChannel = "paid_online";
  else if (pid.startsWith("free_") || pid.startsWith("free_entry_")) payChannel = "free_entry";
  else if (isFreeEntryType) payChannel = "free_entry";
  else if (typeof args.bookingTotal === "number" && args.bookingTotal === 0) payChannel = "free_entry";
  else if (pid && pid.length >= 10 && !pid.startsWith("demo_")) payChannel = "paid_online";
  else payChannel = "unknown";
  // 🆕 2026-06-15 v3.301 (Khushi) — "PAY AT VENUE was showing ⚠ UNKNOWN". When
  // the paymentId carries no prefix proof (cash_/pay_/free_) we now fall back to
  // the booking/cover's RECORDED payment method/mode so a genuine cash-at-door
  // (or settled card/upi) row resolves instead of defaulting to UNKNOWN. Only
  // fires when we'd otherwise give up — real paymentId proof above always wins.
  if (payChannel === "unknown") {
    const pm = String(args.paymentMethod || "").toLowerCase().trim();
    if (pm === "cash" || pm === "pay_at_venue" || pm === "venue" || pm === "cash_pending" || pm === "pay at venue") payChannel = "pay_at_venue";
    else if (pm === "card") payChannel = "card";
    else if (pm === "upi") payChannel = "upi";
    else if (pm === "split") payChannel = "split";
    else if (pm === "paid_online" || pm === "online" || pm === "razorpay") payChannel = "paid_online";
  }
  // 1) Aggregator (Zomato/Swiggy/EazyDiner) — explicit marker
  if (args.aggregator || cs.startsWith("aggregator")) {
    return { source: "aggregator", payChannel: "", isGuestList: false };
  }
  // 2) Guestlist — flag, matched guest row, cover.source, or guestlist_* entryType
  if (args.isGuestListFlag || args.hasGuestMatch || cs === "guestlist" || cs.startsWith("guestlist_") || et.startsWith("guestlist_")) {
    return { source: "guestlist", payChannel: "", isGuestList: true };
  }
  // NOTE: `et === "free"` is NOT guestlist — that's the LADIES FREE ENTRY flow
  // on hodclub.in. It falls through to the cover branch with payChannel="free_entry".
  // 3) entryType-driven categories take PRIORITY over door-minted source flag
  //    (a door captain might mint cover for a customer who booked entry_only/group online —
  //     the customer-flow category should win over the staff-source label)
  if (et === "entryonly" || et === "entry_only") {
    return { source: "entry-only", payChannel, isGuestList: false };
  }
  if (et === "group") {
    return { source: "group-booking", payChannel, isGuestList: false };
  }
  // 4) True walk-in (door staff minted with NO booking entryType)
  if (cs.startsWith("walkin")) {
    return { source: "walk-in", payChannel: "", isGuestList: false };
  }
  // 5) Cover (default for everything with a wallet — stag, couple, female, etc.)
  return { source: "cover", payChannel, isGuestList: false };
}

function buildWalletRow(c: HodCover & { id: string }, bookings: Map<string, HodBooking>, guestlistByName: Map<string, HodGuestlistEntry>): WalletRow {
  // 🆕 v3.226 (Khushi) — surface the final BILL (with full breakdown) from the
  // cover's walletBillPrintLog. Bar bills re-print the FULL running tab each
  // round, so the TRUE final total is the LATEST non-duplicate entry — never the
  // sum (same rule Live Reports uses). Pre-v3.224 rows lack breakdown → treated 0.
  const latestBill = (() => {
    const log = Array.isArray(c.walletBillPrintLog) ? c.walletBillPrintLog : [];
    const real = log.filter((b) => b && !b.isDuplicate);
    const last = real.length ? real[real.length - 1] : undefined;
    return {
      billTotal: Number(last?.total || 0),
      billSubtotal: Number(last?.subtotal || 0),
      billDiscount: Number(last?.discount || 0),
      billServiceCharge: Number(last?.serviceCharge || 0),
      billTax: Number(last?.tax || 0),
      billNumber: String(last?.billNumber || ""),
    };
  })();
  const linkedBooking = c.bookingId ? bookings.get(c.bookingId) : undefined;
  const guest = guestlistByName.get((c.name || "").toLowerCase().trim());
  const recharged = Number(c.topUpTotal || 0);
  const used = Number(c.coverUsed || 0);
  const activated = Number(c.coverActivated || 0);
  // 🆕 2026-06-24 (Khushi) — reconcile discount from the IMMUTABLE per-recharge
  // stamps (tx.discountPct / tx.grossAmount), summing recorded transactions
  // instead of recomputing from the single overwriteable billDiscountPct field.
  let rechargeGross = 0, rechargeDiscount = 0;
  for (const t of ((c.transactions || []) as Array<{ type?: string; amount?: number; grossAmount?: number; discountPct?: number }>)) {
    const ty = String(t.type || "").toLowerCase();
    if (!ty.includes("topup")) continue;
    const net = Number(t.amount || 0);
    if (net <= 0) continue;
    const gross = Number(t.grossAmount) > net ? Number(t.grossAmount) : net;
    rechargeGross += gross;
    rechargeDiscount += (gross - net);
  }
  const balance = Number(c.coverBalance ?? (activated + recharged - used));
  const cAny = c as any;
  const paymentId = String(linkedBooking?.paymentId || cAny.paymentId || "");
  const cls = classifyWallet({
    paymentId,
    entryType: String((linkedBooking as any)?.entryType || cAny.entryType || ""),
    isGuestListFlag: !!c.isGuestList,
    hasGuestMatch: !!guest,
    coverSource: String(cAny.source || ""),
    aggregator: cAny.aggregator,
    bookingTotal: typeof (linkedBooking as any)?.total === "number" ? (linkedBooking as any).total : undefined,
    paymentMethod: String((linkedBooking as any)?.paymentMode || cAny.paymentMode || c.paymentMethod || ""),
  });
  let { source, payChannel } = cls;
  // 🔴 2026-05-25 v4 (Khushi screenshot) — WALK-IN pay column was showing
  // "WALKIN" (just the source repeated) which told the accountant nothing
  // about HOW the money came in. Derive the dominant recharge method from
  // the cover's own transaction log and surface it as cash/upi/card/split.
  if (source === "walk-in") {
    const txs = (c.transactions || []) as Array<{ type?: string; amount?: number }>;
    const tally: Record<string, number> = { cash: 0, upi: 0, card: 0, split: 0 };
    for (const t of txs) {
      const ty = String(t.type || "").toLowerCase();
      const amt = Number(t.amount || 0);
      if (amt <= 0) continue;
      if (ty.includes("split")) tally.split += amt;
      else if (ty.includes("cash")) tally.cash += amt;
      else if (ty.includes("upi")) tally.upi += amt;
      else if (ty.includes("card")) tally.card += amt;
    }
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] > 0) payChannel = top[0] as WalletRow["payChannel"];
  }
  // 🔴 2026-05-25 v5 (Khushi screenshot) — the 2nd PAY column (after
  // BALANCE) reads `c.paymentMethod` raw from Firestore. For walk-ins
  // that's hard-coded to literal "walkin" (firestore-hod.ts:1015) which
  // is useless to the accountant. Mirror the derived dominant method
  // so both PAY columns agree. If they ever disagree on a future row,
  // that's a tampering/data-quality flag worth investigating.
  let resolvedPaymentMethod = c.paymentMethod || "";
  if (source === "walk-in" && (resolvedPaymentMethod === "" || resolvedPaymentMethod.toLowerCase() === "walkin")) {
    if (payChannel === "cash" || payChannel === "upi" || payChannel === "card" || payChannel === "split") {
      resolvedPaymentMethod = payChannel;
    }
  }
  return {
    coverId: c.id, ref: c.ref || "",
    name: c.name || "",
    phone: c.phone || (linkedBooking?.phone || guest?.phone || ""),
    email: (linkedBooking as any)?.email || (c as any).email || "",
    eventTitle: c.eventTitle || linkedBooking?.eventTitle || "",
    date: c.date || linkedBooking?.date || "",
    source,
    payChannel,
    paymentId,
    isGuestList: !!c.isGuestList || !!guest,
    agent: c.lastActivatedBy || c.activatedBy || guest?.checkedInBy || "",
    activatedAt: c.lastActivatedAt || c.activatedAt || "",
    checkedIn: !!c.checkedIn,
    arrival: c.actualArrivalTime || "",
    coverActivated: activated, topUpTotal: recharged, coverUsed: used, coverBalance: balance,
    rechargeGross, rechargeDiscount,
    paymentMethod: resolvedPaymentMethod,
    tableId: c.tableId || "",
    walletBillPrints: c.walletBillPrintCount || 0,
    lastBillAt: c.lastWalletBillPrintedAt || "",
    ...latestBill,
  };
}

// 🆕 v3.105 — `embedded` hides the "← POS" link when Reports renders as a
// tab inside AdminPage (Boss Mode). Standalone /reports route keeps it.
export default function Reports({ embedded = false }: { embedded?: boolean } = {}) {
  const [reservations, setReservations] = useState<HodTableReservation[]>([]);
  const [bookings, setBookings] = useState<HodBooking[]>([]);
  const [guestlist, setGuestlist] = useState<HodGuestlistEntry[]>([]);
  const [covers, setCovers] = useState<Array<HodCover & { id: string }>>([]);
  const [orphans, setOrphans] = useState<any[]>([]);
  const [view, setView] = useState<"tables" | "wallets" | "tally" | "edc" | "settlement">("tables");
  // Settlement reconciliation: lazily populated when the accountant uploads
  // a Pine Labs (or Razorpay) settlement export. Lives in component state
  // because the file is local — never round-tripped to Firestore.
  const [reconVendor, setReconVendor] = useState<SettlementVendor>("pinelabs");
  const [reconResult, setReconResult] = useState<ReconResult | null>(null);
  const [reconFileName, setReconFileName] = useState<string>("");
  const [reconError, setReconError] = useState<string>("");
  // ── EDC Cloud transactions (Razorpay POS / Pine Labs) for the selected night.
  // Read-only ledger of every card-swipe pushed from Door Mode → EDC machine.
  // Each row is one charge attempt: pending / success / failed / cancelled,
  // with amount, vendor, card last-4, and EDC reference for reconciliation.
  // Pulled from Firestore `edcTransactions` collection (written by the cloud
  // function on dispatch + webhook). Falls back silently if collection absent.
  const [edcTxns, setEdcTxns] = useState<Array<{ id: string; [k: string]: any }>>([]);
  const [edcStatusFilter, setEdcStatusFilter] = useState<"all" | "success" | "failed" | "cancelled" | "pending" | "refunded" | "refund_failed">("all");
  // Per-row spinner so multiple refund buttons can't double-fire while one
  // is in flight. Keyed by edcTransactions doc id.
  const [edcRefunding, setEdcRefunding] = useState<Record<string, boolean>>({});
  const [edcVendorFilter, setEdcVendorFilter] = useState<string>("all");
  const [edcBouncerFilter, setEdcBouncerFilter] = useState<string>("all");
  // "mismatched" = combined leakage + phantom + minor (Khushi-requested merge —
  // 3 separate buttons confused her; the per-row chip still shows the actual
  // verdict so the underlying anti-fraud signal is never lost).
  const [tallyVerdictFilter, setTallyVerdictFilter] = useState<"all" | "mismatched" | "match" | "bill-voided">("all");
  const [tallyKots, setTallyKots] = useState<PosKotDoc[]>([]);
  const [tallyKotsStatus, setTallyKotsStatus] = useState<"loading" | "ok" | "error">("loading");
  const [expandedTally, setExpandedTally] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "green" | "orange" | "red">("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  // Date picker — default to tonight's operational night, allow last 7 nights.
  // Reports older than 7 days should live in Google Sheets archive (TODO).
  const todayNight = getOperationalNightStr();
  const [selectedDate, setSelectedDate] = useState<string>(todayNight);
  const today = selectedDate;
  // 🔴 2026-05-23 (Khushi COST FIX r3) — merge helper: replaces the prior
  // night-slice of covers (so removed/edited docs drop) without clobbering
  // covers from the *other* night that share the local state array.
  const mergeCoversByNight = (
    prev: Array<HodCover & { id: string }>,
    night: string,
    rows: HodCover[],
  ): Array<HodCover & { id: string }> => {
    const keep = prev.filter((c) => (c as any).date !== night);
    const next = rows.map((r) => ({ ...(r as any), id: (r as any).id })) as Array<HodCover & { id: string }>;
    return [...keep, ...next];
  };
  const last7Dates = useMemo(() => {
    const out: string[] = [];
    // 🆕 2026-05-30 v3.143 — RCB go-live: prepend TOMORROW so the boss can view
    // next-day (e.g. 31 May final) bookings, then today going back 6 nights.
    const tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
    out.push(tmr.toISOString().split("T")[0]);
    for (let i = 0; i < 7; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      out.push(d.toISOString().split("T")[0]);
    }
    return out;
  }, []);

  // 1) Reservations (real-time)
  // 🔴 BUGFIX 2026-05-09 — events run from one calendar day's evening into the
  // next morning (e.g. Sat 9pm → Sun 4am). hodclub.in writes tableReservations
  // with `date: ev.date` (the EVENT date, often tomorrow's calendar date when
  // viewed before midnight). Querying ONLY operational-night dropped every
  // upcoming-tonight booking from the Tables tab. Fix: subscribe to BOTH
  // operational-night AND next-calendar-day, merge results.
  useEffect(() => {
    const next = (() => {
      const [y, m, d] = today.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d + 1));
      return dt.toISOString().split("T")[0];
    })();
    let aRes: HodTableReservation[] = []; let bRes: HodTableReservation[] = [];
    let aHist: HodTableReservation[] = []; let bHist: HodTableReservation[] = [];
    const merge = () => {
      const seen = new Set<string>();
      const out: HodTableReservation[] = [];
      // Live reservations first → history rows for the SAME bookingRef are
      // ignored (a fresh release would otherwise double-count). Live docs
      // win on `_docId`; history docs win on `bookingRef` if no live match.
      for (const r of [...aRes, ...bRes]) {
        if (seen.has(r._docId)) continue;
        seen.add(r._docId);
        if (r.bookingRef) seen.add(`bref:${r.bookingRef}`);
        out.push(r);
      }
      for (const r of [...aHist, ...bHist]) {
        if (seen.has(r._docId)) continue;
        if (r.bookingRef && seen.has(`bref:${r.bookingRef}`)) continue;
        seen.add(r._docId);
        if (r.bookingRef) seen.add(`bref:${r.bookingRef}`);
        out.push(r);
      }
      setReservations(out);
    };
    const u1 = subscribeToHodReservations(today, (r) => { aRes = r; merge(); });
    const u2 = subscribeToHodReservations(next, (r) => { bRes = r; merge(); });
    // 🔴 2026-05-15 — released tables get archived to `tableHistory` and
    // DELETED from `tableReservations` (releaseTable in firestore-hod.ts).
    // Without this listener, Reports loses every paid+released table the
    // moment the captain taps RELEASE — which is exactly when EOD
    // reconciliation needs them most. Same date-pair logic as live res.
    // Doc-id is prefixed `hist:` so it never collides with a live res _docId.
    const subHist = (date: string, set: (r: HodTableReservation[]) => void) =>
      onSnapshot(
        query(collection(db, "tableHistory"), where("date", "==", date)),
        (snap) => set(snap.docs.map((d) => ({
          ...(d.data() as HodTableReservation),
          _docId: `hist:${d.id}`,
        }))),
        (e) => { console.warn("[Reports] tableHistory subscribe failed", e); set([]); }
      );
    const u3 = subHist(today, (r) => { aHist = r; merge(); });
    const u4 = subHist(next,  (r) => { bHist = r; merge(); });
    return () => { u1(); u2(); u3(); u4(); };
  }, [today]);
  // 🔴 2026-05-23 (Khushi COST FIX r3) — Bookings / Guestlist / Covers were
  // pulling the ENTIRE collection on every Reports page open. With 10K+ rows
  // of history that's the single biggest read-burner outside DoorMode. All
  // three are now scoped to the selected `today` night + next day (covers
  // events that straddle midnight). Re-subscribes when the date picker moves.
  // 🛟 FALLBACK: if a row's `date` field is missing it's silently excluded
  // here; the picker can rewind one night at a time to find historical data.
  useEffect(() => {
    const nextDay = (() => {
      const [y, m, d] = today.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().split("T")[0];
    })();
    const u1 = subscribeToBookingsForNights([today, nextDay], setBookings);
    const u2 = subscribeToGuestlistInRange(today, (() => {
      const [y, m, d] = today.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, d + 2)).toISOString().split("T")[0];
    })(), setGuestlist);
    const u3a = subscribeToCoversForNight(today,   (rows) => setCovers((prev) => mergeCoversByNight(prev, today, rows)));
    const u3b = subscribeToCoversForNight(nextDay, (rows) => setCovers((prev) => mergeCoversByNight(prev, nextDay, rows)));
    return () => { u1(); u2(); u3a(); u3b(); };
  }, [today]);
  // 4b) posKOTs for the selected night (Feature #2 — KOT-vs-Bill Tally).
  //     Window = 12pm (noon) selectedDate → 12pm next day (operational night,
  //     matches getOperationalNightStr cutoff per Khushi 11 May 2026).
  //     Read-only — analysis only.
  //     Fallback: subscription failure → tallyKots stays empty → tally view
  //     simply renders "no KOT data" rather than false-flagging anything.
  useEffect(() => {
    const [y, m, d] = today.split("-").map(Number);
    if (!y || !m || !d) return;
    // Local time 12pm (noon) selectedDate → 12pm next day
    const start = new Date(y, m - 1, d, 12, 0, 0, 0);
    const end = new Date(y, m - 1, d + 1, 12, 0, 0, 0);
    try {
      const q = query(
        collection(db, "posKOTs"),
        where("createdAt", ">=", Timestamp.fromDate(start)),
        where("createdAt", "<", Timestamp.fromDate(end)),
      );
      setTallyKotsStatus("loading");
      const unsub = onSnapshot(q, (snap) => {
        const out: PosKotDoc[] = snap.docs.map(dd => {
          const x = dd.data() as any;
          return {
            id: dd.id, tableId: x.tableId, items: x.items,
            bookingRef: x.bookingRef, reservationId: x.reservationId,
            customerName: x.customerName,
            voidNotice: x.voidNotice, kind: x.kind, billNumber: x.billNumber,
            staff: x.staff, createdAt: x.createdAt,
          };
        });
        setTallyKots(out);
        setTallyKotsStatus("ok");
      }, (e) => { console.warn("[Reports] posKOTs tally subscribe failed", e); setTallyKots([]); setTallyKotsStatus("error"); });
      return unsub;
    } catch (e) { console.warn("[Reports] posKOTs tally setup failed", e); setTallyKotsStatus("error"); return; }
  }, [today]);

  // 4c-pre) When the operator switches nights, the previously-loaded
  //         settlement reconciliation no longer applies (edcTxns is about
  //         to be repopulated for the new date). Clear it so the UI doesn't
  //         show stale matches against a different night's transactions.
  useEffect(() => {
    setReconResult(null);
    setReconFileName("");
    setReconError("");
  }, [today]);

  // 4c) EDC transactions for the selected night. Filter by `date` field
  //     (operational night string) so we don't pull weeks of history. The
  //     cloud function stamps `date` at dispatch time using the same
  //     getOperationalNightStr() the rest of the POS uses, so a charge made
  //     at 2am Sunday morning is correctly grouped with Saturday's night.
  useEffect(() => {
    try {
      const q = query(collection(db, "edcTransactions"), where("date", "==", today));
      const unsub = onSnapshot(q,
        (snap) => setEdcTxns(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))),
        (e) => { console.warn("[Reports] edcTransactions subscribe failed", e); setEdcTxns([]); });
      return unsub;
    } catch { setEdcTxns([]); return; }
  }, [today]);

  // 5) Orphan Zomato payments (read-only enrichment) — narrow to today's night
  //    so we don't pull weeks of paid emails. Falls back silently if collection missing.
  useEffect(() => {
    try {
      const q = query(collection(db, "orphanZomatoPayments"), where("nightDate", "==", today));
      const unsub = onSnapshot(q, (snap) => setOrphans(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
        () => setOrphans([]));
      return unsub;
    } catch { return; }
  }, [today]);

  const orphanByPhone = useMemo(() => {
    const m = new Map<string, any>();
    for (const o of orphans) {
      const p = String(o.paidPhone || o.phone || "").replace(/\D/g, "").slice(-10);
      if (p) m.set(p, o);
    }
    return m;
  }, [orphans]);

  // 🔴 BUGFIX 2026-06-19 — subscription fetches today+next (midnight-straddle),
  // but tomorrow's genuine bookings were leaking into today's report. Filter to
  // today's date only so the count matches Live Reports.
  const tableRows = useMemo(() => reservations
    .filter(r => !today || !(r.date) || (r.date as string).slice(0, 10) === today)
    .map(r => buildTableRow(r, orphanByPhone)), [reservations, orphanByPhone, today]);
  const bookingsById = useMemo(() => { const m = new Map<string, HodBooking>(); for (const b of bookings) m.set(b.id, b); return m; }, [bookings]);
  const guestByName = useMemo(() => { const m = new Map<string, HodGuestlistEntry>(); for (const g of guestlist) m.set((g.name || "").toLowerCase().trim(), g); return m; }, [guestlist]);
  const walletRows = useMemo(() => {
    // 🔴 BUGFIX 2026-05-09 — same rolling-night fix as Tables: accept covers
    // dated for the next calendar day too (events Sat night→Sun morning).
    const nextDay = (() => {
      const [y, m, d] = today.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().split("T")[0];
    })();
    // 🔴 UX 2026-05-10 (v7) — same TABLE-booking skip applied at the COVER level too.
    // Aggregator (Zomato Dining / Swiggy Dineout) syncs sometimes WRITE a cover doc
    // for each table booking (so they show as "checked in"). Those covers carry
    // eventTitle="FD8 - Dining - 2026-05-10" / tableId="FD8" / source aggregator —
    // they belong in Tables tab, NOT Wallets/Cover. Khushi's screenshot proved
    // the v6 synth-booking-loop fix wasn't enough; we need to filter here too.
    const isTableCover = (w: WalletRow, c: HodCover & { id: string }): boolean => {
      const cAny = c as any;
      if (cAny.tableType || cAny.tableId || cAny.bookMode === "tables") return true;
      const ev = String(w.eventTitle || "");
      if (/^\s*(FD|SMK|RT|VIP|GF|FF|2F)\d+/i.test(ev)) return true;
      if (/^\s*T\d+\b/i.test(ev)) return true;
      // Belt-and-braces: aggregator + table-shaped eventTitle
      if (cAny.aggregator && /\b(FD|SMK|T|RT|VIP|GF|FF|2F)\d+\b/i.test(ev)) return true;
      return false;
    };
    const coverById = new Map(covers.map(c => [c.id, c]));
    // 🔴 UX 2026-05-10 (v8) — drop GHOST cover docs (no name, no phone, no email,
    // no event, no money, not checked in). These are abandoned/half-failed syncs
    // that pollute the Wallets view as blank UNKNOWN rows. A real cover ALWAYS
    // has at least one identity field (name OR phone) OR money activity. Khushi
    // confirmed 8 such empty rows showed up under COVER filter on 10 May night.
    const isGhostCover = (w: WalletRow): boolean => {
      const hasIdentity = !!(w.name?.trim() || w.phone?.trim() || w.email?.trim() || w.eventTitle?.trim());
      const hasMoney = (w.coverActivated || 0) > 0 || (w.topUpTotal || 0) > 0 || (w.coverUsed || 0) > 0 || (w.coverBalance || 0) > 0;
      const hasActivity = w.checkedIn || !!w.activatedAt || !!w.agent?.trim();
      return !hasIdentity && !hasMoney && !hasActivity;
    };
    // 🆕 2026-06-24 (Khushi) — DROP EMPTY WALK-INS. A bar/cashier WALK-IN cover
    // (WALKIN-1, WALKIN-2…) exists solely to take an order; one created but never
    // used (no order redeemed, no bill printed, no money in/out) is just noise in
    // the Admin Wallets report. Only surface a walk-in once it carries real
    // activity: an order was placed/redeemed (coverUsed>0) OR a bill was printed
    // (billTotal>0 / walletBillPrints>0) OR any money moved (activated/topup/
    // balance>0). Scoped to source==="walk-in" ONLY — guestlist entries,
    // entry-only paid covers, and online/table covers are untouched.
    const isEmptyWalkin = (w: WalletRow): boolean => {
      if (w.source !== "walk-in") return false;
      const placedOrBilled =
        (w.coverUsed || 0) > 0 ||
        (w.billTotal || 0) > 0 ||
        (w.walletBillPrints || 0) > 0 ||
        (w.coverActivated || 0) > 0 ||
        (w.topUpTotal || 0) > 0 ||
        (w.coverBalance || 0) > 0;
      return !placedOrBilled;
    };
    const rows = covers
      .map(c => buildWalletRow(c, bookingsById, guestByName))
      .filter(w => !isTableCover(w, coverById.get(w.coverId)!))
      .filter(w => !isGhostCover(w))
      .filter(w => !isEmptyWalkin(w))
      .filter(w => !today || !w.date || w.date === today || w.date === nextDay);
    // ── BUGFIX 2026-05-08: synthesize guestlist rows for entries that never
    // had a cover wallet activated. Without this, guestlist-typed bookings
    // (entryType starts with "guestlist_") and raw guestlist entries that
    // never converted to covers are invisible in the Wallets/Guestlist view.
    // Two sources: (a) bookings.entryType startsWith "guestlist_" (customer
    // site), and (b) raw guestlist collection docs (legacy joinGuestList +
    // door-side adds). Dedup by ref against existing cover rows.
    // Dedup by ref ONLY. Test data shares phone numbers across many distinct
    // guestlist entries (e.g. 9611111261 = KHUSHI TRY + Khushi SG + DIG
    // GUESTLIST 1 + …). Phone-based dedup was collapsing them into one row.
    const seenRefs = new Set(rows.map(r => r.ref).filter(Boolean));
    for (const b of bookings) {
      const et = String((b as any).entryType || "");
      const bAny = b as any;
      // 🔴 UX 2026-05-10 (v4) — TABLE bookings live in the Tables tab, NOT Wallets.
      // hodclub.in writes table bookings with `tableType` set (FD8 / SMK4 / etc) and
      // bookMode='tables' even when entryType is stag/couple/female. Without this skip,
      // every table booking double-shows under Wallets/Cover too. Fixes Khushi's 10 May
      // report — Mathew / Aman / Amith etc. (FD8/FD3/FD12) were appearing in Cover.
      if (et === "table4" || et === "vip" || et === "table") continue;
      if (bAny.tableType || bAny.tableId || bAny.bookMode === "tables") continue;
      // 🔴 UX 2026-05-10 (v6) — Zomato/Swiggy Dineout aggregator table bookings
      // arrive in `bookings` with eventTitle like "FD1 Dining" / "SMK4 Dining" /
      // "T8 Rooftop" (no separator) and an `aggregator` field. Real events look
      // like "Red Room at H.O.D" — never start with FD/SMK/T/RT/VIP/GF/FF/2F + digit.
      // Skip those entirely; they're Tables tab rows, not Wallets/Cover.
      const evTitle = String(b.eventTitle || "");
      if (/^\s*(FD|SMK|RT|VIP|GF|FF|2F)\d+/i.test(evTitle)) continue;
      if (/^\s*T\d+\b/i.test(evTitle)) continue; // T1..T99 rooftop tables (word-boundary so "Tuesday" etc. don't match)
      // Belt-and-braces: aggregator + table-shaped eventTitle is always a table booking
      if (bAny.aggregator && /\b(FD|SMK|T|RT|VIP|GF|FF|2F)\d+\b/i.test(evTitle)) continue;
      if (!et) continue; // skip aggregator/legacy bookings without entryType
      const dateStr = (b.date || "").slice(0, 10) || ((b as any).bookedAt || "").slice(0, 10);
      if (today && dateStr && dateStr !== today) continue;
      const refKey = b.ref || b.id;
      if (refKey && seenRefs.has(refKey)) continue;
      // 🔴 UX 2026-05-10 — use shared classifier so synth rows match cover rows
      const bPid = String(b.paymentId || "");
      const cls = classifyWallet({
        paymentId: bPid, entryType: et,
        isGuestListFlag: et.startsWith("guestlist_"),
        hasGuestMatch: false, coverSource: "",
        aggregator: undefined,
        bookingTotal: typeof (b as any).total === "number" ? (b as any).total : undefined,
        paymentMethod: String((b as any).paymentMode || (b as any).paymentMethod || ""),
      });
      rows.push({
        coverId: "", ref: refKey, name: b.name || "", phone: b.phone || "",
        email: (b as any).email || "", eventTitle: b.eventTitle || "", date: dateStr,
        source: cls.source, payChannel: cls.payChannel, paymentId: bPid, isGuestList: cls.isGuestList,
        agent: "", activatedAt: "",
        checkedIn: !!b.checkedIn, arrival: "",
        coverActivated: 0, topUpTotal: 0, coverUsed: 0, coverBalance: 0,
        rechargeGross: 0, rechargeDiscount: 0,
        paymentMethod: (b as any).paymentMethod || (b.paymentId ? "online" : ""),
        tableId: "", walletBillPrints: 0, lastBillAt: "",
        billTotal: 0, billSubtotal: 0, billDiscount: 0, billServiceCharge: 0, billTax: 0, billNumber: "",
      });
      if (refKey) seenRefs.add(refKey);
    }
    for (const g of guestlist) {
      const dateStr = (g.joinedAt || "").slice(0, 10) || (g.entryTime || "").slice(0, 10);
      if (today && dateStr && dateStr !== today) continue;
      if (g.id && seenRefs.has(g.id)) continue;
      rows.push({
        coverId: "", ref: g.id, name: g.name || "", phone: g.phone || "",
        email: "", eventTitle: g.eventTitle || "", date: dateStr,
        source: "guestlist", payChannel: "", isGuestList: true, agent: g.checkedInBy || "",
        activatedAt: "", checkedIn: !!g.checkedIn, arrival: "",
        coverActivated: 0, topUpTotal: 0, coverUsed: 0, coverBalance: 0,
        rechargeGross: 0, rechargeDiscount: 0,
        paymentMethod: "", tableId: "", walletBillPrints: 0, lastBillAt: "",
        billTotal: 0, billSubtotal: 0, billDiscount: 0, billServiceCharge: 0, billTax: 0, billNumber: "",
      });
      if (g.id) seenRefs.add(g.id);
    }
    return rows.sort((a, b) => (b.activatedAt || "").localeCompare(a.activatedAt || ""));
  }, [covers, bookingsById, guestByName, today, bookings, guestlist]);

  // 🧾 KOT-vs-BILL tally rows for selected night (Feature #2). Filter to closed
  // tables only — open tabs are still ordering, comparison would be premature.
  const tallyRows = useMemo<TallyRow[]>(
    () => buildAllTallyRows(reservations, tallyKots, { closedOnly: true, kotsStatus: tallyKotsStatus }),
    [reservations, tallyKots, tallyKotsStatus],
  );
  const tallyByCaptain = useMemo(() => aggregateCaptainLeakage(tallyRows), [tallyRows]);
  const filteredTally = useMemo(() => tallyRows.filter(r => {
    if (tallyVerdictFilter === "mismatched") {
      if (r.verdict !== "leakage" && r.verdict !== "phantom" && r.verdict !== "minor") return false;
    } else if (tallyVerdictFilter !== "all" && r.verdict !== tallyVerdictFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      if (!`${r.tableId} ${r.customerName} ${r.captain} ${r.floor}`.toLowerCase().includes(q)) return false;
    }
    return true;
  }), [tallyRows, tallyVerdictFilter, search]);
  const tallyTotals = useMemo(() => {
    let leakageVal = 0, phantomVal = 0, leakageTables = 0, phantomTables = 0,
        matchTables = 0, billVoidedTables = 0, minorTables = 0;
    for (const r of tallyRows) {
      if (r.verdict === "leakage") { leakageTables++; leakageVal += r.leakageValue; }
      if (r.verdict === "phantom") { phantomTables++; phantomVal += r.phantomValue; }
      if (r.verdict === "match") matchTables++;
      if (r.verdict === "minor") minorTables++;
      if (r.verdict === "bill-voided") billVoidedTables++;
    }
    return { leakageVal, phantomVal, leakageTables, phantomTables, matchTables, billVoidedTables, minorTables };
  }, [tallyRows]);

  const sources = useMemo(() => {
    const s = new Set<string>(); tableRows.forEach(r => s.add(r.source));
    return Array.from(s).sort();
  }, [tableRows]);

  const filteredTables = useMemo(() => tableRows.filter(r => {
    if (filter !== "all" && r.ambiguity !== filter) return false;
    if (sourceFilter !== "all" && r.source !== sourceFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      if (!`${r.customerName} ${r.phone} ${r.tableId} ${r.captain} ${r.sourceLabel}`.toLowerCase().includes(q)) return false;
    }
    return true;
  }).sort((a, b) => (a.tableId || "").localeCompare(b.tableId || "")), [tableRows, filter, sourceFilter, search]);

  const filteredWallets = useMemo(() => walletRows.filter(w => {
    if (sourceFilter !== "all" && w.source !== sourceFilter) return false;
    if (eventFilter !== "all" && (w.eventTitle || "").trim() !== eventFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      if (!`${w.name} ${w.phone} ${w.email} ${w.ref} ${w.eventTitle} ${w.agent} ${w.tableId}`.toLowerCase().includes(q)) return false;
    }
    return true;
  }), [walletRows, sourceFilter, eventFilter, search]);

  const totals = useMemo(() => {
    let totalRevenue = 0, paidRevenue = 0, unpaid = 0, redCount = 0, orangeCount = 0, greenCount = 0;
    let inhouseCount = 0, aggCount = 0;
    for (const r of tableRows) {
      totalRevenue += r.total;
      if (r.paymentStatus === "paid") paidRevenue += r.amountPaid || r.total;
      else unpaid += r.total;
      if (r.ambiguity === "red") redCount++;
      else if (r.ambiguity === "orange") orangeCount++;
      else greenCount++;
      if (r.source === "inhouse" || r.source === "" || !r.source) inhouseCount++;
      else aggCount++;
    }
    return { totalRevenue, paidRevenue, unpaid, redCount, orangeCount, greenCount, inhouseCount, aggCount };
  }, [tableRows]);

  // Wallet-view summary: today's events list (always full so chip row shows all
  // events) + tile counts that respect source/event filters so they match the
  // visible table and the door's per-event view.
  const walletTotals = useMemo(() => {
    const eventTitles = new Set<string>();
    for (const w of walletRows) {
      if (w.eventTitle && w.eventTitle.trim()) eventTitles.add(w.eventTitle.trim());
    }
    let guestlistCount = 0, activatedCount = 0, coverSales = 0, walkInCount = 0, onlineCount = 0;
    for (const w of filteredWallets) {
      if (w.isGuestList) guestlistCount++;
      if (w.coverActivated > 0) activatedCount++;
      coverSales += w.coverActivated + w.topUpTotal;
      if (w.source === "walk-in") walkInCount++;
      if (w.source === "cover" || w.source === "entry-only" || w.source === "group-booking") onlineCount++;
    }
    return {
      events: Array.from(eventTitles),
      guestlistCount, activatedCount, coverSales, walkInCount, onlineCount,
      totalCovers: filteredWallets.length,
    };
  }, [walletRows, filteredWallets]);

  const exportTables = () => {
    const rows = filteredTables.map((r) => ({
      Date: today,
      Source: r.sourceLabel,
      "Source Code": r.source,
      Name: r.customerName,
      Phone: r.phone,
      Email: r.email,
      Party: r.partySize,
      Floor: r.floor,
      Table: r.tableId,
      Captain: r.captain,
      Arrival: fmtTime(r.arrival),
      "Paid At": fmtTime(r.paidAt),
      "Minutes on Table": r.minutesOnTable,
      "Subtotal ₹": r.subtotal,
      "Default Discount %": r.defaultDiscount,
      "Actual Discount %": r.discountPct,
      "Discount ₹": r.discountAmount,
      "Tax ₹": r.taxAmount,
      "Total ₹": r.total,
      "Amount Paid ₹": r.amountPaid,
      "Wallet Redeemed ₹": r.walletPaidAmount,
      "Cash/Card/UPI Collected ₹": Math.max(0, (r.amountPaid || 0) - (r.walletPaidAmount || 0)),
      "Wallet Redemption Details": r.walletRedemptionDetails,
      "Payment Status": r.paymentStatus,
      "Payment Method": r.paymentMethod,
      "Aggregator Paid ₹": r.aggregatorPaidAmount,
      "Customer-Bill ₹ (full, no discount)": r.total,
      "Customer-After-Discount Pays ₹": r.aggregatorNetAmount ?? "",
      "Aggregator Variance ₹": r.aggregatorVariance ?? "",
      "Aggregator Variance Flag": r.aggregatorVariance !== null && Math.abs(r.aggregatorVariance) >= 200 ? (r.aggregatorVariance < 0 ? "SHORT-PAID" : "OVER-PAID") : "",
      "Bill Prints": r.billPrintCount,
      "Bill Prints Flag": r.billPrintCount > 1 ? "DUPLICATE" : "",
      "Modified Discount": r.modifiedDiscount ? "YES" : "",
      "Override Count": r.overrideCount,
      "Source Swaps": r.sourceSwapCount,
      "Aggregator Downgrade": r.hasDowngrade ? "YES" : "",
      "Voids": r.voidCount,
      "Void Value Lost ₹": r.voidValueLost,
      "Unpaid Min After Bill": r.unpaidMinutesAfterBill,
      "Ambiguity": r.ambiguity.toUpperCase(),
      "Flags": r.flags.join("; "),
    }));
    downloadCSV(`HOD_Tables_${today}.csv`, rows);
  };

  // 📦 DIGIPOS ITEM EXPORT — one row per item per table for the night.
  // Inventory + recipe-cost engine (DigiPos / Digitory) needs item-level data,
  // not table-level totals. Walks every reservation's tabRounds, flattens
  // each line item to a row. Skips empty/cancelled rounds. Only includes
  // rounds whose KOT was at least activated (so kitchen actually got it).
  const exportItemsForDigiPos = () => {
    const rows: Array<Record<string, any>> = [];
    for (const tr of filteredTables) {
      const res = reservations.find(rr => rr._docId === tr.reservationId);
      if (!res) continue;
      const tabRounds = res.tabRounds || [];
      for (const rd of tabRounds) {
        // Only export rounds the kitchen / bar actually saw a KOT for.
        // "preparing" = captain hasn't printed KOT yet → not consumed → skip.
        if (rd.status === "preparing") continue;
        for (const it of (rd.items || [])) {
          const qty = Number(it.qty || 0);
          const unitPrice = Number(it.p || 0);
          if (!qty || !it.n) continue;
          rows.push({
            Date: today,
            "Floor": tr.floor,
            "Table": tr.tableId,
            "Source": tr.sourceLabel,
            "Source Code": tr.source,
            "Customer": tr.customerName,
            "Captain": tr.captain,
            "Round #": rd.roundNum,
            "KOT Status": rd.status,
            "KOT Placed At": fmtTime(rd.placedAt || ""),
            "Item Name": it.n,
            "Category": it.cat || "",
            "Type": it.t || "",
            "Veg": typeof (it as any).v === "boolean" ? ((it as any).v ? "VEG" : "NON-VEG") : "",
            "Qty": qty,
            "Unit Price ₹": unitPrice,
            "Line Total ₹": qty * unitPrice,
            "Payment Status": tr.paymentStatus,
            "Reservation ID": tr.reservationId,
          });
        }
      }
    }
    if (rows.length === 0) {
      alert("No KOT items printed yet for this date.\n\nItems only export AFTER captain hits Print KOT (status flips from 'preparing' to 'activated').");
      return;
    }
    downloadCSV(`HOD_Items_DigiPos_${today}.csv`, rows);
  };

  const exportWallets = () => {
    const rows = filteredWallets.map((w) => ({
      Date: w.date || today,
      Source: w.source,
      Ref: w.ref,
      Name: w.name,
      Phone: w.phone,
      Email: w.email,
      Event: w.eventTitle,
      "Is Guestlist": w.isGuestList ? "YES" : "",
      "Agent (activated by)": w.agent,
      "Activated At": fmtTime(w.activatedAt),
      "Checked In": w.checkedIn ? "YES" : "",
      "Arrival Time": w.arrival,
      "Cover Activated ₹": w.coverActivated,
      "Recharged ₹": w.topUpTotal,
      // 🆕 2026-06-24 (Khushi) — per-recharge discount reconciliation from the
      // immutable tx stamps (NOT the single overwriteable billDiscountPct field).
      "Recharge Gross ₹ (pre-discount)": w.rechargeGross,
      "Recharge Discount ₹ (total given)": w.rechargeDiscount,
      "Redeemed ₹": w.coverUsed,
      "Balance ₹": w.coverBalance,
      "Payment Method": w.paymentMethod,
      "Wallet Bill Prints": w.walletBillPrints,
      "Last Wallet Bill At": fmtTime(w.lastBillAt),
      // 🆕 v3.226 (Khushi) — final bill with all details (esp. bar walk-ins).
      "Bill No": w.billNumber,
      "Bill Subtotal ₹": w.billSubtotal,
      "Bill Discount ₹": w.billDiscount,
      "Bill Service Charge ₹": w.billServiceCharge,
      "Bill Tax ₹": w.billTax,
      "Bill Total ₹": w.billTotal,
    }));
    downloadCSV(`HOD_Wallets_${today}.csv`, rows);
  };

  // 🧾 KOT-vs-Bill tally CSV — one row per table, plus per-item breakdown of
  // mismatched items in a single string (so accountant can scan in Excel).
  const exportTally = () => {
    const rows: Array<Record<string, any>> = [];
    for (const t of filteredTally) {
      const itemBreakdown = t.itemDiffs.map(d =>
        `${d.name} [KOT ${d.kotQty}${d.voidQty > 0 ? ` − void ${d.voidQty}` : ""} → bill ${d.billQty} (${d.diffQty > 0 ? "+" : ""}${d.diffQty}) = ₹${d.diffValue.toFixed(0)}]`
      ).join(" | ");
      rows.push({
        Date: today,
        Verdict: t.verdict.toUpperCase(),
        Table: t.tableId, Floor: t.floor,
        Customer: t.customerName, Captain: t.captain,
        "Payment Status": t.paymentStatus,
        "Paid At": fmtTime(t.paidAt),
        "KOT Count": t.kotCount,
        "KOT Value ₹": Math.round(t.kotValue),
        "Voided Value ₹": Math.round(t.voidValue),
        "Expected Bill ₹": Math.round(t.expectedBillValue),
        "Actual Bill ₹": Math.round(t.billValue),
        "Diff ₹ (signed)": Math.round(t.diffValue),
        "Leakage ₹ (KOT > bill)": Math.round(t.leakageValue),
        "Phantom ₹ (bill > KOT)": Math.round(t.phantomValue),
        "Mismatched Items": itemBreakdown,
      });
    }
    downloadCSV(`HOD_KOT_vs_Bill_${today}.csv`, rows);
  };

  // 💳 EDC Cloud transactions export — every card-machine charge attempt
  // tonight (success / failed / cancelled / pending). Source of truth for
  // door card payments — accountant reconciles Razorpay settlement report
  // against this CSV instead of trusting hand-written cash sheets.
  const exportEdc = () => {
    const rows = edcTxns.map((t) => ({
      Date: t.date || today,
      "Created At": fmtTime(t.createdAt || ""),
      "Updated At": fmtTime(t.updatedAt || ""),
      Vendor: t.vendor || "",
      "Terminal ID": t.terminalId || "",
      Status: String(t.status || "").toUpperCase(),
      "Booking Ref": t.bookingRef || "",
      "Cover Ref": t.coverRef || "",
      "Amount ₹": Number(t.amount || 0),
      "Card Network": t.cardNetwork || "",
      "Card Last 4": t.last4 || "",
      "EDC Ref / Slip": t.edcRef || "",
      "Razorpay Payment ID": t.razorpayPaymentId || "",
      "Razorpay Intent ID": t.razorpayIntentId || "",
      "Pine Labs Ref": t.pineLabsRef || "",
      "Bouncer": t.bouncerName || "",
      "Bouncer PIN Hash": t.bouncerPin || "",
      "Failure Reason": t.errorReason || "",
      // Refund columns — populated when a manager has refunded the charge
      // from the Reports row. Status above already encodes refunded /
      // refund_failed; these add the audit trail the accountant needs to
      // reconcile against the vendor refund report.
      "Refund Amount ₹": Number(t.refundAmount || 0),
      "Refund ID": t.razorpayRefundId || "",
      "Refunded At": fmtTime(t.refundedAt || ""),
      "Refunded By": t.refundedBy || "",
      "Refund Error": t.refundError || "",
      "Txn ID": t.id,
    }));
    downloadCSV(`HOD_EDC_Card_${today}.csv`, rows);
  };

  // 🧮 Settlement reconciliation export — only the ISSUES (matched rows are
  // expected and noisy). Accountant pastes this into the morning standup
  // sheet so the operations lead can chase Pine Labs / Razorpay support
  // for missed webhooks and short-settlements.
  const exportReconIssues = () => {
    if (!reconResult) { alert("Upload a settlement file first."); return; }
    const rows = reconResult.issues.map((i) => ({
      Date: today,
      Vendor: reconResult.vendor,
      Issue: i.kind.replace(/_/g, " ").toUpperCase(),
      Ref: i.ref,
      "Settlement ₹": i.settlementAmount,
      "Firestore ₹": i.firestoreAmount,
      "Δ ₹": Math.round(i.firestoreAmount - i.settlementAmount),
      "Booking Ref": i.txn?.bookingRef || "",
      "Cover Ref": i.txn?.coverRef || "",
      "Card Last 4": i.txn?.last4 || i.settlement?.last4 || "",
      "Bouncer": i.txn?.bouncerName || "",
      "Txn ID": i.txn?.id || "",
      "Settled At (vendor)": i.settlement?.when || "",
      Detail: i.detail,
    }));
    downloadCSV(`HOD_Settlement_Issues_${reconResult.vendor}_${today}.csv`, rows);
  };

  // 🧮 Run the recon — wired to the file-input onChange below. Reads the
  // uploaded CSV as text, parses it leniently, and matches against the
  // current night's `edcTransactions` for the selected vendor.
  const handleSettlementFile = async (file: File) => {
    setReconError("");
    try {
      const text = await file.text();
      const { rows: parsed, unparsed } = parseSettlementCsv(text);
      if (parsed.length === 0) {
        setReconError(`Couldn't parse any rows from "${file.name}". Make sure the file has a header row with at least an RRN / Approval Code column and an Amount column.`);
        setReconResult(null);
        return;
      }
      const result = reconcile({ vendor: reconVendor, settlement: parsed, txns: edcTxns, unparsed });
      setReconResult(result);
      setReconFileName(file.name);
    } catch (e: any) {
      setReconError(`Failed to read file: ${e?.message || e}`);
      setReconResult(null);
    }
  };

  const ambColor = (a: Ambiguity) => a === "red" ? RED : a === "orange" ? ORANGE : GREEN;
  const dot = (a: Ambiguity) => (
    <span title={a.toUpperCase()} style={{ display: "inline-block", width: 10, height: 10, borderRadius: 5, background: ambColor(a), boxShadow: `0 0 6px ${ambColor(a)}aa` }} />
  );

  return (
    <div style={{ color: "#000" }}>
      {/* Header + view tabs + date picker */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* 2026-05-13 — Khushi spec: back-to-POS button so admins
              don't have to use the browser back arrow. Matches the
              ← POS link style used in CaptainMode. */}
          {!embedded && (
            <Link href="/"
              style={{ padding: "8px 12px", borderRadius: 10, background: "#F2C744", border: "2px solid #000", boxShadow: "2px 2px 0px #000", color: "#000", fontSize: 12, fontWeight: 900, cursor: "pointer", textDecoration: "none", whiteSpace: "nowrap", letterSpacing: .3 }}>
              ← POS
            </Link>
          )}
          <div>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#000" }}>📋 Reports</div>
            <div style={{ fontSize: 11, color: "#888" }}>
              {selectedDate === todayNight ? "🟢 LIVE — tonight" : `📅 Archive — ${selectedDate}`} · Live from Firestore · CSV export opens in Excel + Google Sheets.
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)}
            title="Pick a night (last 7 days kept; older nights live in Google Sheets archive)"
            style={{ padding: "8px 10px", borderRadius: 8, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 12, fontWeight: 700 }}>
            {last7Dates.map((d, i) => (
              <option key={d} value={d}>{i === 0 ? `Tomorrow (${d})` : i === 1 ? `Tonight (${d})` : i === 2 ? `Last night (${d})` : d}</option>
            ))}
          </select>
          <button onClick={() => setView("tables")} style={{ padding: "8px 14px", borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: "pointer",
            border: "2px solid #000", boxShadow: view === "tables" ? "3px 3px 0px #000" : "none", transform: view === "tables" ? "translate(-1px,-1px)" : "none",
            background: view === "tables" ? "#FF90E8" : "#fff", color: "#000" }}>
            🍽 All Tables ({tableRows.length})
          </button>
          <button onClick={() => setView("wallets")} style={{ padding: "8px 14px", borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: "pointer",
            border: "2px solid #000", boxShadow: view === "wallets" ? "3px 3px 0px #000" : "none", transform: view === "wallets" ? "translate(-1px,-1px)" : "none",
            background: view === "wallets" ? "#FF90E8" : "#fff", color: "#000" }}>
            🎟 Wallets / Guestlist ({walletRows.length})
          </button>
          <button onClick={() => setView("tally")}
            title="Compares every printed KOT against the final bill (subtracting manager-approved voids). Catches drinks served but never billed = cash-pocket leakage."
            style={{ padding: "8px 14px", borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: "pointer",
              border: "2px solid #000", boxShadow: view === "tally" ? "3px 3px 0px #000" : "none", transform: view === "tally" ? "translate(-1px,-1px)" : "none",
              background: view === "tally" ? "#FF90E8" : "#fff", color: "#000" }}>
            🧾 KOT vs Bill ({tallyRows.length})
            {tallyTotals.leakageTables > 0 && <span style={{ marginLeft: 6, color: RED, fontWeight: 900 }}>· 🔴 {tallyTotals.leakageTables}</span>}
          </button>
          <button onClick={() => setView("edc")}
            title="Card-machine charges pushed from Door Mode tonight. Source of truth for cover card payments — no manual reconciliation needed."
            style={{ padding: "8px 14px", borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: "pointer",
              border: "2px solid #000", boxShadow: view === "edc" ? "3px 3px 0px #000" : "none", transform: view === "edc" ? "translate(-1px,-1px)" : "none",
              background: view === "edc" ? "#FF90E8" : "#fff", color: "#000" }}>
            💳 EDC Card ({edcTxns.length})
          </button>
          <button onClick={() => setView("settlement")}
            title="Upload tonight's vendor settlement file (Pine Labs / Razorpay) to auto-match against EDC card swipes. Catches missed webhooks and short-settled txns."
            style={{ padding: "8px 14px", borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: "pointer",
              border: "2px solid #000", boxShadow: view === "settlement" ? "3px 3px 0px #000" : "none", transform: view === "settlement" ? "translate(-1px,-1px)" : "none",
              background: view === "settlement" ? "#FF90E8" : "#fff", color: "#000" }}>
            🧮 Settlement{reconResult ? ` (${reconResult.totals.issueCount} issue${reconResult.totals.issueCount === 1 ? "" : "s"})` : ""}
          </button>
        </div>
      </div>

      {/* Summary tiles — TABLES view */}
      {view === "tables" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12 }}>
          <Tile label="Tables booked" value={String(tableRows.length)} color={GOLD} />
          <Tile label="In-house" value={String(totals.inhouseCount)} color={GOLD} />
          <Tile label="Aggregator" value={String(totals.aggCount)} color="#a855f7" />
          <Tile label="Total revenue" value={`₹${totals.totalRevenue.toLocaleString()}`} color={GOLD} />
          <Tile label="Paid" value={`₹${totals.paidRevenue.toLocaleString()}`} color={GREEN} />
          <Tile label="Unpaid (open)" value={`₹${totals.unpaid.toLocaleString()}`} color={ORANGE} />
          <Tile label="🟢 Clean" value={String(totals.greenCount)} color={GREEN} />
          <Tile label="🟠 Watch" value={String(totals.orangeCount)} color={ORANGE} />
          <Tile label="🔴 Flagged" value={String(totals.redCount)} color={RED} />
        </div>
      )}

      {/* Summary tiles — WALLETS / GUESTLIST view */}
      {view === "wallets" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12 }}>
            <Tile label="Total wallets" value={String(walletTotals.totalCovers)} color={GOLD} />
            <Tile label="Activated" value={String(walletTotals.activatedCount)} color={GREEN} />
            <Tile label="🎟 Guestlist" value={String(walletTotals.guestlistCount)} color="#a855f7" />
            <Tile label="Online bookings" value={String(walletTotals.onlineCount)} color={GREEN} />
            <Tile label="Walk-in covers" value={String(walletTotals.walkInCount)} color={ORANGE} />
            <Tile label="Cover sales" value={`₹${walletTotals.coverSales.toLocaleString()}`} color={GOLD} />
          </div>
          {walletTotals.events.length > 0 && (
            <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: "#fff", border: "2px solid #000", boxShadow: "2px 2px 0px #000", fontSize: 11, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <span style={{ color: "#a855f7", fontWeight: 800, marginRight: 4 }}>🎤 EVENT:</span>
              <button onClick={() => setEventFilter("all")}
                style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 800, cursor: "pointer", border: "2px solid #000",
                  background: eventFilter === "all" ? "#a855f7" : "#fff", color: eventFilter === "all" ? "#fff" : "#000" }}>
                ALL ({walletRows.length})
              </button>
              {walletTotals.events.map(ev => {
                const count = walletRows.filter(w => (w.eventTitle || "").trim() === ev).length;
                const active = eventFilter === ev;
                return (
                  <button key={ev} onClick={() => setEventFilter(ev)}
                    style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: "pointer", border: "2px solid #000",
                      background: active ? "#a855f7" : "#fff", color: active ? "#fff" : "#000" }}>
                    {ev} ({count})
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* 🆕 2026-06-15 v3.301 (Khushi) — removed the standing "📡 DATA SOURCE"
          caption banner that sat above the filter bar (visual clutter). */}

      {/* Filter bar — search + ⚙ filter toggle + export */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 Search name / phone / table / captain / event"
          style={{ flex: "1 1 240px", padding: "8px 12px", borderRadius: 8, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 12 }} />
        <button onClick={() => setShowFilters(!showFilters)}
          title="Show / hide source + ambiguity filters"
          style={{ padding: "8px 14px", borderRadius: 8, border: "2px solid #000",
            background: showFilters ? "#F2C744" : "#fff", color: "#000", fontSize: 12, fontWeight: 800, cursor: "pointer",
            boxShadow: showFilters ? "3px 3px 0px #000" : "none", transform: showFilters ? "translate(-1px,-1px)" : "none" }}>
          ⚙ Filter & Sort {(filter !== "all" || sourceFilter !== "all") ? "•" : ""}
        </button>
        <button onClick={view === "tables" ? exportTables : view === "wallets" ? exportWallets : view === "edc" ? exportEdc : view === "settlement" ? exportReconIssues : exportTally}
          disabled={view === "settlement" && !reconResult}
          style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: GOLD, color: "#030305", fontWeight: 900, fontSize: 12, cursor: "pointer", opacity: (view === "settlement" && !reconResult) ? 0.4 : 1 }}>
          ⬇ Export CSV ({view === "tables" ? filteredTables.length : view === "wallets" ? filteredWallets.length : view === "edc" ? edcTxns.length : view === "settlement" ? (reconResult?.totals.issueCount || 0) : filteredTally.length} rows)
        </button>
        {view === "tables" && (
          <button onClick={exportItemsForDigiPos}
            title="One row per item per table (KOT-printed only). Upload this to DigiPos / Digitory each morning for inventory + recipe-cost reconciliation."
            style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#A855F7", color: "#fff", fontWeight: 900, fontSize: 12, cursor: "pointer" }}>
            📦 Export Items CSV (DigiPos)
          </button>
        )}
      </div>

      {/* Summary tiles + per-captain summary — TALLY view */}
      {view === "tally" && (
        <>
          {/* 5-tile dashboard (Khushi-requested simplification 11 May 2026):
              Tables Tallied · Match · Mismatched · Bill Voided · Leakage ₹.
              Mismatched = leakage + phantom + minor combined (per-row chip
              still shows the precise verdict). Leakage ₹ = cash-pocket risk
              total — the single most actionable number on the night. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12 }}>
            <Tile label="Tables tallied" value={String(tallyRows.length)} color={GOLD} />
            <Tile label="🟢 Match" value={String(tallyTotals.matchTables)} color={GREEN} />
            <Tile label="⚠ Mismatched" value={String(tallyTotals.leakageTables + tallyTotals.phantomTables + tallyTotals.minorTables)} color={tallyTotals.leakageTables > 0 ? RED : ORANGE} />
            <Tile label="⚫ Bill voided" value={String(tallyTotals.billVoidedTables)} color="#888" />
            <Tile label="🔴 Leakage ₹" value={`₹${tallyTotals.leakageVal.toLocaleString()}`} color={RED} />
          </div>
          <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: "#FFF3F3", border: "2px solid #000", boxShadow: "2px 2px 0px #000", fontSize: 11, color: "#333" }}>
            <strong style={{ color: RED }}>🧾 KOT vs BILL TALLY:</strong> Every printed KOT (drink/food slip) compared to the final bill,
            after subtracting manager-PIN-approved voids. <strong>🔴 LEAKAGE</strong> = items physically served but never charged
            (cash-pocket risk). <strong>👻 PHANTOM</strong> = items billed but no KOT (rare — usually a comp / bartender error).
            Threshold: ₹{500} = red. Open tabs are skipped (still ordering). <strong>If KOT data fails to load</strong>,
            the table simply shows "no data" — never false-flags.
          </div>
          {tallyByCaptain.filter(c => c.totalLeakage + c.totalPhantom > 0).length > 0 && (
            <div style={{ marginBottom: 12, padding: 10, borderRadius: 10, background: "#fff", border: "2px solid #000", boxShadow: "3px 3px 0px #000" }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: RED, marginBottom: 8 }}>👤 PER-CAPTAIN LEAKAGE — {selectedDate}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1.5fr 0.6fr 0.7fr 1fr 0.7fr 1fr", gap: 8, fontSize: 12 }}>
                <div style={{ fontWeight: 800, color: "#888", fontSize: 10 }}>CAPTAIN</div>
                <div style={{ fontWeight: 800, color: "#888", fontSize: 10, textAlign: "right" }}>TABLES</div>
                <div style={{ fontWeight: 800, color: RED, fontSize: 10, textAlign: "right" }}>🔴 LEAK#</div>
                <div style={{ fontWeight: 800, color: RED, fontSize: 10, textAlign: "right" }}>🔴 LEAK ₹</div>
                <div style={{ fontWeight: 800, color: ORANGE, fontSize: 10, textAlign: "right" }}>👻 PHAN#</div>
                <div style={{ fontWeight: 800, color: ORANGE, fontSize: 10, textAlign: "right" }}>👻 PHAN ₹</div>
                {tallyByCaptain.filter(c => c.totalLeakage + c.totalPhantom > 0).map(c => (
                  <Fragment key={c.captain}>
                    <div style={{ color: "#000", fontWeight: 700 }}>{c.captain}</div>
                    <div style={{ textAlign: "right", color: "#555" }}>{c.tables}</div>
                    <div style={{ textAlign: "right", color: c.leakageTables > 0 ? RED : "#ccc", fontWeight: 800 }}>{c.leakageTables || "—"}</div>
                    <div style={{ textAlign: "right", color: c.totalLeakage > 0 ? RED : "#ccc", fontWeight: 800 }}>{c.totalLeakage > 0 ? `₹${c.totalLeakage.toLocaleString()}` : "—"}</div>
                    <div style={{ textAlign: "right", color: c.phantomTables > 0 ? ORANGE : "#ccc", fontWeight: 800 }}>{c.phantomTables || "—"}</div>
                    <div style={{ textAlign: "right", color: c.totalPhantom > 0 ? ORANGE : "#ccc", fontWeight: 800 }}>{c.totalPhantom > 0 ? `₹${c.totalPhantom.toLocaleString()}` : "—"}</div>
                  </Fragment>
                ))}
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {([
              ["all", "ALL", "#F2C744"],
              ["mismatched",
                `⚠ MISMATCHED (${tallyTotals.leakageTables + tallyTotals.phantomTables + tallyTotals.minorTables})`,
                tallyTotals.leakageTables > 0 ? RED : ORANGE],
              ["match", `🟢 MATCH (${tallyTotals.matchTables})`, GREEN],
              ["bill-voided", `⚫ BILL VOIDED (${tallyTotals.billVoidedTables})`, "#888"],
            ] as const).map(([v, label, c]) => (
              <button key={v} onClick={() => setTallyVerdictFilter(v as any)}
                style={{ padding: "6px 12px", borderRadius: 6, border: "2px solid #000", cursor: "pointer", fontSize: 11, fontWeight: 800,
                  background: tallyVerdictFilter === v ? c : "#fff",
                  color: "#000",
                  boxShadow: tallyVerdictFilter === v ? "2px 2px 0px #000" : "none",
                  transform: tallyVerdictFilter === v ? "translate(-1px,-1px)" : "none" }}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Filter drawer (collapsed by default) */}
      {showFilters && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, padding: 10, borderRadius: 8, background: "#fff", border: "2px solid #000", boxShadow: "3px 3px 0px #000", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#000", fontWeight: 700, marginRight: 4 }}>SOURCE:</span>
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 12 }}>
            <option value="all">All sources</option>
            {(view === "tables" ? sources : ["guestlist", "entry-only", "cover", "group-booking", "walk-in", "aggregator"]).map(s => <option key={s} value={s}>{s.toUpperCase().replace("-", " ")}</option>)}
          </select>
          {view === "tables" && (
            <>
              <span style={{ fontSize: 11, color: "#000", fontWeight: 700, marginLeft: 8, marginRight: 4 }}>AMBIGUITY:</span>
              <div style={{ display: "flex", gap: 4 }}>
                {(["all", "green", "orange", "red"] as const).map((f) => (
                  <button key={f} onClick={() => setFilter(f)} style={{ padding: "6px 12px", borderRadius: 6, border: "2px solid #000", cursor: "pointer", fontSize: 11, fontWeight: 800,
                    background: filter === f ? (f === "all" ? "#F2C744" : ambColor(f as Ambiguity)) : "#fff",
                    color: "#000" }}>
                    {f === "all" ? "ALL" : f === "red" ? "🔴 RED" : f === "orange" ? "🟠 ORANGE" : "🟢 GREEN"}
                  </button>
                ))}
              </div>
            </>
          )}
          {(filter !== "all" || sourceFilter !== "all") && (
            <button onClick={() => { setFilter("all"); setSourceFilter("all"); }}
              style={{ padding: "6px 10px", borderRadius: 6, border: "2px solid #000", background: "#fff", color: "#000", fontSize: 11, cursor: "pointer", marginLeft: "auto" }}>
              Clear
            </button>
          )}
        </div>
      )}

      {/* 🆕 2026-06-15 v3.301 (Khushi) — Gumroad data-grid: hard 1px black
          horizontal + vertical lines on every cell, bigger base font (13px,
          headers 12px) and roomier padding so the Tables/Wallets reports read
          like a proper ledger instead of borderless rows. */}
      <style>{`
        .hod-rpt-grid { font-size: 13px; }
        .hod-rpt-grid thead tr { font-size: 12px !important; }
        .hod-rpt-grid th, .hod-rpt-grid td { border: 1px solid #000 !important; padding: 9px 8px !important; }
      `}</style>

      {/* TABLE VIEW */}
      {view === "tables" && (
        <div style={{ overflowX: "auto", border: "2px solid #000", borderRadius: 10, boxShadow: "4px 4px 0px #000" }}>
          <table className="hod-rpt-grid" style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: "#000" }}>
            <thead>
              <tr style={{ background: "#F2C744", color: "#000", fontSize: 10, textTransform: "uppercase", letterSpacing: ".5px" }}>
                {["", "Table", "Source", "Customer", "Phone", "Email", "Captain", "Party", "Arrival", "Min", "Bill ₹ (Full)", "Net ₹ (After Disc)", "Disc Δ ₹", "Disc%", "Status", "Pay Method", "Agg Paid ₹", "Agg Var ₹", "Bill ×", "Flags"].map((h) => (
                  <th key={h} style={{ padding: "8px 6px", textAlign: "left", borderBottom: "2px solid #000" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredTables.length === 0 ? (
                <tr><td colSpan={20} style={{ padding: 24, textAlign: "center", color: "#888" }}>No tables match filters.</td></tr>
              ) : filteredTables.map((r) => (
                <tr key={r.reservationId} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "6px 6px" }}>{dot(r.ambiguity)}</td>
                  <td style={{ padding: "6px 6px", color: "#000", fontWeight: 800 }}>{r.tableId}<div style={{ fontSize: 9, color: "#888" }}>{r.floor}</div></td>
                  <td style={{ padding: "6px 6px" }}>{r.sourceLabel}{r.modifiedDiscount && <span title={`Default ${r.defaultDiscount}% → ${r.discountPct}%`} style={{ marginLeft: 4, color: ORANGE, fontWeight: 800 }}>✎</span>}</td>
                  <td style={{ padding: "6px 6px" }}>{r.customerName || "—"}</td>
                  <td style={{ padding: "6px 6px", fontFamily: "monospace" }}>{r.phone || "—"}</td>
                  <td style={{ padding: "6px 6px", fontSize: 10, color: "#666" }}>{r.email || "—"}</td>
                  <td style={{ padding: "6px 6px" }}>{r.captain || "—"}</td>
                  <td style={{ padding: "6px 6px" }}>{r.partySize || "—"}</td>
                  <td style={{ padding: "6px 6px", color: "#555" }}>{fmtTime(r.arrival)}</td>
                  <td style={{ padding: "6px 6px", color: r.minutesOnTable > 240 ? ORANGE : "#555" }}>{r.minutesOnTable || "—"}</td>
                  {/* 🔴 2026-05-12 — `Bill ₹` is the FULL printed bill (no
                      discount applied at the door). `Net ₹` is what the
                      venue actually nets after the aggregator/captain
                      discount. `Disc Δ` is the leakage (Bill − Net) and
                      flips orange when material so admin can spot full-
                      bill-then-discount cases at a glance. */}
                  <td style={{ padding: "6px 6px", textAlign: "right", fontWeight: 800 }}>₹{r.total.toLocaleString()}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right", fontWeight: 800,
                    color: r.aggregatorNetAmount !== null && r.aggregatorNetAmount < r.total ? GREEN : "#555" }}
                    title={r.aggregatorNetAmount === null ? "No discount recorded — net == bill"
                      : `Venue nets ₹${r.aggregatorNetAmount.toLocaleString()} after ${r.discountPct}% ${r.paymentMethod || "discount"}`}>
                    {r.aggregatorNetAmount !== null ? `₹${r.aggregatorNetAmount.toLocaleString()}` : `₹${r.total.toLocaleString()}`}
                  </td>
                  <td style={{ padding: "6px 6px", textAlign: "right", fontWeight: 800,
                    color: r.aggregatorNetAmount !== null && (r.total - r.aggregatorNetAmount) >= 200 ? ORANGE
                      : r.aggregatorNetAmount !== null && (r.total - r.aggregatorNetAmount) > 0 ? "#555"
                      : "#ccc" }}
                    title="Discount leakage = Full bill − Net received">
                    {r.aggregatorNetAmount !== null && r.aggregatorNetAmount < r.total
                      ? `−₹${(r.total - r.aggregatorNetAmount).toLocaleString()}`
                      : "—"}
                  </td>
                  <td style={{ padding: "6px 6px", textAlign: "right", color: r.modifiedDiscount ? ORANGE : "#555" }}>{r.discountPct}%</td>
                  <td style={{ padding: "6px 6px", color: r.paymentStatus === "paid" ? GREEN : r.paymentStatus === "bill_requested" ? ORANGE : "#666" }}>
                    {r.paymentStatus === "paid" ? "✅ paid" : r.paymentStatus === "bill_requested" ? "🧾 bill due" : "open"}
                  </td>
                  <td style={{ padding: "6px 6px", textTransform: "uppercase", fontSize: 10 }}>{r.paymentMethod || "—"}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right", color: r.aggregatorPaidAmount ? "#a855f7" : "#ccc" }}>
                    {r.aggregatorPaidAmount ? `₹${r.aggregatorPaidAmount.toLocaleString()}` : "—"}
                  </td>
                  <td style={{ padding: "6px 6px", textAlign: "right", fontWeight: 800,
                    color: r.aggregatorVariance === null ? "#ccc"
                      : r.aggregatorVariance <= -500 ? RED
                      : Math.abs(r.aggregatorVariance) >= 200 ? ORANGE
                      : GREEN }}
                    title={r.aggregatorVariance === null ? "No aggregator-payment match yet — variance unknown"
                      : r.aggregatorVariance < 0 ? `Aggregator paid ₹${Math.abs(r.aggregatorVariance)} LESS than expected — possible over-discount`
                      : r.aggregatorVariance > 0 ? `Aggregator paid ₹${r.aggregatorVariance} MORE than expected — verify`
                      : "Matches expected"}>
                    {r.aggregatorVariance === null ? "—"
                      : r.aggregatorVariance === 0 ? "✓"
                      : `${r.aggregatorVariance > 0 ? "+" : ""}₹${r.aggregatorVariance.toLocaleString()}`}
                  </td>
                  <td style={{ padding: "6px 6px", color: r.billPrintCount > 1 ? RED : "#666", fontWeight: r.billPrintCount > 1 ? 900 : 400, textAlign: "center" }}>
                    {r.billPrintCount}{r.billPrintCount > 1 ? " ⚠" : ""}
                  </td>
                  <td style={{ padding: "6px 6px", fontSize: 10, color: ambColor(r.ambiguity) }}>{r.flags.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* WALLET VIEW */}
      {view === "wallets" && (
        <div style={{ overflowX: "auto", border: "2px solid #000", borderRadius: 10, boxShadow: "4px 4px 0px #000" }}>
          <table className="hod-rpt-grid" style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: "#000" }}>
            <thead>
              <tr style={{ background: "#F2C744", color: "#000", fontSize: 10, textTransform: "uppercase", letterSpacing: ".5px" }}>
                {["Source", "Pay Channel", "Name", "Phone", "Email", "Event", "Agent", "Activated", "✓In", "Cover ₹", "Recharged ₹", "Redeemed ₹", "Balance ₹", "Pay", "Bill ×", "Bill ₹"].map((h) => (
                  <th key={h} style={{ padding: "8px 6px", textAlign: "left", borderBottom: "2px solid #000" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredWallets.length === 0 ? (
                <tr><td colSpan={15} style={{ padding: 24, textAlign: "center", color: "#888" }}>No wallet/guestlist entries for this date.</td></tr>
              ) : filteredWallets.map((w) => {
                // 🔴 UX 2026-05-10 — color chip per category (matches hodclub.in flows)
                const sourceColor = w.source === "guestlist" ? "#a855f7"
                  : w.source === "entry-only" ? "#3b82f6"
                  : w.source === "cover" ? GOLD
                  : w.source === "group-booking" ? "#ec4899"
                  : w.source === "walk-in" ? "#94a3b8"
                  : w.source === "aggregator" ? ORANGE
                  : GREEN;
                const sourceLabel = w.source.toUpperCase().replace("-", " ");
                return (
                <tr key={w.coverId || `synth:${w.ref}` || `${w.source}:${w.name}:${w.phone}`} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "6px 6px" }}>
                    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 800, letterSpacing: ".5px",
                      background: `${sourceColor}22`, border: `1px solid ${sourceColor}55`, color: sourceColor }}>{sourceLabel}</span>
                  </td>
                  <td style={{ padding: "6px 6px", whiteSpace: "nowrap" }}>
                    {w.payChannel === "paid_online" ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 800, color: GREEN }}>💚 PAID ONLINE</span>
                        {w.paymentId && (w.paymentId.startsWith("pay_") || w.paymentId.startsWith("order_")) && (
                          <a href={w.paymentId.startsWith("order_")
                                ? `https://dashboard.razorpay.com/app/orders/${encodeURIComponent(w.paymentId)}`
                                : `https://dashboard.razorpay.com/app/payments/${encodeURIComponent(w.paymentId)}`}
                             target="_blank" rel="noopener noreferrer"
                             title={`Verify on Razorpay: ${w.paymentId}`}
                             style={{ fontSize: 10, color: "#3b82f6", textDecoration: "underline", fontWeight: 700 }}>
                            🔍 VERIFY
                          </a>
                        )}
                      </span>
                    ) : w.payChannel === "pay_at_venue" ? (
                      <span style={{ fontSize: 10, fontWeight: 800, color: "#F59E0B" }}>💵 PAY AT VENUE</span>
                    ) : w.payChannel === "free_entry" ? (
                      <span style={{ fontSize: 10, fontWeight: 800, color: "#a855f7" }}>🆓 FREE ENTRY</span>
                    ) : w.payChannel === "cash" ? (
                      <span style={{ fontSize: 10, fontWeight: 800, color: "#F59E0B" }}>💵 CASH</span>
                    ) : w.payChannel === "upi" ? (
                      <span style={{ fontSize: 10, fontWeight: 800, color: "#3b82f6" }}>📱 UPI</span>
                    ) : w.payChannel === "card" ? (
                      <span style={{ fontSize: 10, fontWeight: 800, color: GREEN }}>💳 CARD</span>
                    ) : w.payChannel === "split" ? (
                      <span style={{ fontSize: 10, fontWeight: 800, color: "#a855f7" }}>🔀 SPLIT</span>
                    ) : w.payChannel === "unknown" ? (
                      <span title="Booking has no payment record. Could be legacy data, admin-created, or an abandoned checkout. VERIFY MANUALLY before reconciling."
                            style={{ fontSize: 10, fontWeight: 800, color: RED, cursor: "help" }}>⚠ UNKNOWN</span>
                    ) : (
                      <span style={{ fontSize: 10, color: "#ccc" }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: "6px 6px", color: "#000", fontWeight: 700 }}>{w.name}</td>
                  <td style={{ padding: "6px 6px", fontFamily: "monospace" }}>{w.phone || "—"}</td>
                  <td style={{ padding: "6px 6px", fontSize: 10, color: "#666" }}>{w.email || "—"}</td>
                  <td style={{ padding: "6px 6px", fontSize: 10 }}>{w.eventTitle || "—"}</td>
                  <td style={{ padding: "6px 6px" }}>{w.agent || "—"}</td>
                  <td style={{ padding: "6px 6px", color: "#555" }}>{fmtTime(w.activatedAt)}</td>
                  <td style={{ padding: "6px 6px", color: w.checkedIn ? GREEN : "#ccc" }}>{w.checkedIn ? "✓" : "—"}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right" }}>₹{Math.max(0, w.coverActivated - w.topUpTotal).toLocaleString()}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right", color: w.topUpTotal > 0 ? GOLD : "#ccc" }}
                      title={w.rechargeDiscount > 0 ? `Recharge gross ₹${w.rechargeGross.toLocaleString()} · discount given ₹${w.rechargeDiscount.toLocaleString()} (per-transaction, never overwritten)` : "No recharge discount given"}>
                    {w.topUpTotal > 0 ? `₹${w.topUpTotal.toLocaleString()}` : "—"}{w.rechargeDiscount > 0 ? <span style={{ color: GREEN, fontSize: 10, fontWeight: 800 }}> −₹{w.rechargeDiscount.toLocaleString()}</span> : null}
                  </td>
                  <td style={{ padding: "6px 6px", textAlign: "right" }}>₹{w.coverUsed.toLocaleString()}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right", color: w.coverBalance > 0 ? GREEN : "#ccc", fontWeight: 800 }}>₹{w.coverBalance.toLocaleString()}</td>
                  <td style={{ padding: "6px 6px", fontSize: 10, textTransform: "uppercase" }}>{w.paymentMethod || "—"}</td>
                  <td style={{ padding: "6px 6px", textAlign: "center", color: w.walletBillPrints > 1 ? RED : "#666", fontWeight: w.walletBillPrints > 1 ? 900 : 400 }}>
                    {w.walletBillPrints || 0}{w.walletBillPrints > 1 ? " ⚠" : ""}
                  </td>
                  <td style={{ padding: "6px 6px", textAlign: "right", color: w.billTotal > 0 ? GOLD : "#ccc", fontWeight: 800 }}
                      title={w.billTotal > 0 ? `Subtotal ₹${w.billSubtotal.toLocaleString()} · Disc ₹${w.billDiscount.toLocaleString()} · SC ₹${w.billServiceCharge.toLocaleString()} · Tax ₹${w.billTax.toLocaleString()}${w.billNumber ? ` · ${w.billNumber}` : ""}` : "No bill printed"}>
                    {w.billTotal > 0 ? `₹${w.billTotal.toLocaleString()}` : "—"}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* EDC CARD VIEW — every cloud-card-machine charge attempt tonight */}
      {view === "edc" && (() => {
        const sorted = [...edcTxns].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
        // Filters: status / vendor / bouncer (Khushi-requested 12 May 2026 —
        // when she's reconciling at 3am she wants to isolate just the failed
        // ones, or just one bouncer's shift, before exporting to CSV).
        const filtered = sorted.filter(t => {
          if (edcStatusFilter !== "all" && t.status !== edcStatusFilter) return false;
          if (edcVendorFilter !== "all" && t.vendor !== edcVendorFilter) return false;
          if (edcBouncerFilter !== "all" && (t.bouncerName || "—") !== edcBouncerFilter) return false;
          if (search.trim() && !`${t.bookingRef} ${t.coverRef} ${t.bouncerName} ${t.last4} ${t.edcRef} ${t.razorpayPaymentId} ${t.pineLabsRef}`.toLowerCase().includes(search.toLowerCase())) return false;
          return true;
        });
        const successCount = sorted.filter(t => t.status === "success").length;
        const failCount = sorted.filter(t => t.status === "failed").length;
        const cancelCount = sorted.filter(t => t.status === "cancelled").length;
        const pendingCount = sorted.filter(t => t.status === "pending").length;
        const refundedCount = sorted.filter(t => t.status === "refunded").length;
        const refundFailedCount = sorted.filter(t => t.status === "refund_failed").length;
        // Success rate excludes still-pending charges (denominator = settled
        // attempts only). 0 attempts → "—" so we don't render NaN%. Note:
        // a refunded txn was originally captured successfully so it counts
        // as success here — the refund nets it out in `successAmt` below.
        const settled = successCount + failCount + cancelCount + refundedCount + refundFailedCount;
        const successishCount = successCount + refundedCount + refundFailedCount;
        const successRate = settled === 0 ? null : Math.round((successishCount / settled) * 100);
        // Net card revenue = captured ₹ minus refunded ₹. refund_failed leaves
        // the original capture standing, so still counts towards revenue.
        const successAmt = sorted
          .filter(t => t.status === "success" || t.status === "refund_failed")
          .reduce((s, t) => s + Number(t.amount || 0), 0);
        const refundedAmt = sorted
          .filter(t => t.status === "refunded")
          .reduce((s, t) => s + Number(t.refundAmount || t.amount || 0), 0);
        const vendors = Array.from(new Set(sorted.map(t => t.vendor).filter(Boolean))) as string[];
        const bouncers = Array.from(new Set(sorted.map(t => t.bouncerName || "—"))).sort();
        const statusColor = (s: string) =>
          s === "success" ? GREEN
          : s === "failed" ? RED
          : s === "cancelled" ? "#888"
          : s === "refunded" ? "#A855F7"
          : s === "refund_failed" ? "#EC4899"
          : ORANGE;
        const rateColor = successRate == null ? "#888" : successRate >= 90 ? GREEN : successRate >= 70 ? ORANGE : RED;
        return (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12 }}>
              <Tile label="Charges tonight" value={String(sorted.length)} color={GOLD} />
              <Tile label="✅ Successful" value={String(successCount)} color={GREEN} />
              <Tile label="❌ Declined" value={String(failCount)} color={RED} />
              <Tile label="🚫 Cancelled" value={String(cancelCount)} color="#888" />
              <Tile label="⏳ Pending" value={String(pendingCount)} color={ORANGE} />
              <Tile label="↩ Refunded" value={String(refundedCount)} color="#A855F7" />
              <Tile label="Success rate" value={successRate == null ? "—" : `${successRate}%`} color={rateColor} />
              <Tile label="Card revenue ₹" value={`₹${(successAmt - refundedAmt).toLocaleString()}`} color={GOLD} />
              {refundedAmt > 0 && (
                <Tile label="Refunded ₹" value={`₹${refundedAmt.toLocaleString()}`} color="#A855F7" />
              )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12, alignItems: "center" }}>
              <span style={{ fontSize: 10, color: "#888", fontWeight: 800, letterSpacing: ".5px" }}>STATUS:</span>
              {(["all", "success", "failed", "cancelled", "pending", "refunded", "refund_failed"] as const).map(s => (
                <button key={s} onClick={() => setEdcStatusFilter(s)}
                  style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 800, cursor: "pointer", border: "2px solid #000",
                    background: edcStatusFilter === s ? "#F2C744" : "#fff", color: "#000",
                    boxShadow: edcStatusFilter === s ? "2px 2px 0px #000" : "none",
                    transform: edcStatusFilter === s ? "translate(-1px,-1px)" : "none" }}>
                  {s.toUpperCase()}
                </button>
              ))}
              {vendors.length > 1 && (<>
                <span style={{ fontSize: 10, color: "#888", fontWeight: 800, letterSpacing: ".5px", marginLeft: 8 }}>VENDOR:</span>
                <select value={edcVendorFilter} onChange={e => setEdcVendorFilter(e.target.value)}
                  style={{ padding: "4px 8px", borderRadius: 6, fontSize: 11, background: "#fff", border: "2px solid #000", color: "#000" }}>
                  <option value="all">All vendors</option>
                  {vendors.map(v => <option key={v} value={v}>{v.toUpperCase()}</option>)}
                </select>
              </>)}
              {bouncers.length > 1 && (<>
                <span style={{ fontSize: 10, color: "#888", fontWeight: 800, letterSpacing: ".5px", marginLeft: 8 }}>BOUNCER:</span>
                <select value={edcBouncerFilter} onChange={e => setEdcBouncerFilter(e.target.value)}
                  style={{ padding: "4px 8px", borderRadius: 6, fontSize: 11, background: "#fff", border: "2px solid #000", color: "#000" }}>
                  <option value="all">All bouncers</option>
                  {bouncers.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </>)}
            </div>
            <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: "#F5EEFF", border: "2px solid #000", boxShadow: "2px 2px 0px #000", fontSize: 11, color: "#333" }}>
              <strong style={{ color: "#A855F7" }}>💳 EDC CLOUD:</strong> Bouncer-tapped Card payments dispatched to the door card machine via Razorpay POS Terminal API (or Pine Labs Plutus Cloud). Source of truth for door card revenue — the accountant should reconcile this against the vendor settlement report each morning, not the cash sheet.
            </div>
            <div style={{ overflowX: "auto", border: "2px solid #000", borderRadius: 10, boxShadow: "4px 4px 0px #000" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: "#000" }}>
                <thead>
                  <tr style={{ background: "#F2C744", color: "#000", fontSize: 10, textTransform: "uppercase", letterSpacing: ".5px" }}>
                    {["When", "Status", "Vendor", "Amount", "Booking Ref", "Card", "EDC Ref", "Bouncer", "Reason", "Refund"].map((h) => (
                      <th key={h} style={{ padding: "8px 6px", textAlign: "left", borderBottom: "2px solid #000" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr><td colSpan={10} style={{ padding: 24, textAlign: "center", color: "#888" }}>
                      {sorted.length === 0
                        ? "No card-machine charges yet for this night. Once Door Mode pushes a card payment, it'll appear here in real time."
                        : "No charges match this search."}
                    </td></tr>
                  ) : filtered.map((t) => {
                    const c = statusColor(String(t.status || ""));
                    return (
                      <tr key={t.id} style={{ borderBottom: "1px solid #eee" }}>
                        <td style={{ padding: "6px 6px", color: "#555", whiteSpace: "nowrap" }}>{fmtTime(t.createdAt || "")}</td>
                        <td style={{ padding: "6px 6px" }}>
                          <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 800, background: `${c}22`, border: `1px solid ${c}55`, color: c }}>
                            {String(t.status || "").toUpperCase()}
                          </span>
                        </td>
                        <td style={{ padding: "6px 6px", color: "#333" }}>{t.vendor || "—"}</td>
                        <td style={{ padding: "6px 6px", textAlign: "right", color: "#000", fontWeight: 800 }}>₹{Number(t.amount || 0).toLocaleString()}</td>
                        <td style={{ padding: "6px 6px", color: "#555", fontFamily: "monospace", fontSize: 10 }}>{t.bookingRef || "—"}</td>
                        <td style={{ padding: "6px 6px" }}>
                          {t.last4 ? <span>{t.cardNetwork || "CARD"} ••••{t.last4}</span> : <span style={{ color: "#ccc" }}>—</span>}
                        </td>
                        <td style={{ padding: "6px 6px", color: "#666", fontFamily: "monospace", fontSize: 10 }}>
                          {t.edcRef || t.razorpayPaymentId || t.pineLabsRef || "—"}
                        </td>
                        <td style={{ padding: "6px 6px", color: "#555" }}>{t.bouncerName || "—"}</td>
                        <td style={{ padding: "6px 6px", color: t.errorReason || t.refundError ? RED : "#ccc", fontSize: 10 }}>{t.errorReason || t.refundError || "—"}</td>
                        <td style={{ padding: "6px 6px" }}>
                          {/* Refund column — only successful captures are
                              refundable. Already-refunded txns surface the
                              refund id so reconciliation has a hard reference
                              against the vendor settlement report. */}
                          {t.status === "success" ? (
                            <button
                              onClick={async () => {
                                const pin = window.prompt(
                                  `🔒 Refund ₹${Number(t.amount || 0).toLocaleString()} to ${t.cardNetwork || "card"}${t.last4 ? ` ••••${t.last4}` : ""}?\n\nBooking: ${t.bookingRef || "—"}\n\nEnter Manager PIN to authorise:`,
                                );
                                if (!pin) return;
                                if (!/^\d{4,6}$/.test(pin.trim())) { alert("❌ Manager PIN must be 4–6 digits."); return; }
                                setEdcRefunding(prev => ({ ...prev, [t.id]: true }));
                                const r = await refundEdcCharge({ txnId: t.id, managerPin: pin.trim() });
                                setEdcRefunding(prev => { const n = { ...prev }; delete n[t.id]; return n; });
                                if (r.ok) {
                                  alert(`✅ Refund dispatched${r.refundId ? ` · ref ${r.refundId}` : ""}. Live status will update in a moment.`);
                                } else {
                                  const reasonMap: Record<string, string> = {
                                    bad_pin: "Manager PIN rejected.",
                                    not_refundable: "This charge can't be refunded (not in success state).",
                                    unknown_txn: "Transaction not found server-side.",
                                    vendor_error: r.errorMessage || "Vendor rejected the refund.",
                                    error: r.errorMessage || "Unexpected error.",
                                  };
                                  alert(`❌ Refund failed: ${reasonMap[r.reason || "error"] || r.errorMessage || r.reason || "error"}`);
                                }
                              }}
                              disabled={!!edcRefunding[t.id]}
                              style={{ padding: "4px 9px", borderRadius: 6, fontSize: 10, fontWeight: 800, cursor: edcRefunding[t.id] ? "wait" : "pointer", border: "2px solid #000", background: "#F5EEFF", color: "#A855F7" }}>
                              {edcRefunding[t.id] ? "…" : "↩ Refund"}
                            </button>
                          ) : t.status === "refunded" ? (
                            <span style={{ fontSize: 10, color: "#A855F7", fontFamily: "monospace" }}>
                              {t.razorpayRefundId || "refunded"}
                            </span>
                          ) : t.status === "refund_failed" ? (
                            <span style={{ fontSize: 10, color: "#EC4899" }}>
                              refund failed
                            </span>
                          ) : (
                            <span style={{ color: "#ccc", fontSize: 10 }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        );
      })()}

      {/* SETTLEMENT RECONCILIATION VIEW */}
      {view === "settlement" && (() => {
        const r = reconResult;
        const issueColor = (k: string) => k === "amount_mismatch" ? ORANGE : k === "settled_not_in_firestore" ? RED : AMBER;
        const issueLabel = (k: string) =>
          k === "amount_mismatch" ? "💰 AMOUNT DRIFT"
          : k === "settled_not_in_firestore" ? "🟥 MISSED WEBHOOK"
          : "🟧 NOT YET SETTLED";
        return (
          <>
            <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: "#E8FFF3", border: "2px solid #000", boxShadow: "2px 2px 0px #000", fontSize: 11, color: "#333" }}>
              <strong style={{ color: GREEN }}>🧮 SETTLEMENT RECONCILIATION:</strong> Upload tonight's settlement file (Pine Labs Plutus dashboard → Reports → Daily Settlement, or Razorpay Dashboard → Settlements → Export). Each row is matched against this night's <code style={{ color: "#000", background: "#F4F4F0", padding: "0 4px", borderRadius: 3 }}>edcTransactions</code> by RRN / Approval Code. Mismatches surface below — fix at standup, not month-end.
            </div>

            {/* Upload bar */}
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12, padding: 12, borderRadius: 10, background: "#fff", border: "2px solid #000", boxShadow: "3px 3px 0px #000" }}>
              <span style={{ fontSize: 11, color: "#000", fontWeight: 800, letterSpacing: ".5px" }}>VENDOR:</span>
              <select value={reconVendor} onChange={(e) => { setReconVendor(e.target.value as SettlementVendor); setReconResult(null); setReconFileName(""); }}
                style={{ padding: "6px 10px", borderRadius: 6, fontSize: 12, fontWeight: 700, background: "#fff", border: "2px solid #000", color: "#000" }}>
                <option value="pinelabs">Pine Labs (Plutus Smart Cloud)</option>
                <option value="razorpay">Razorpay (POS Settlement)</option>
              </select>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 14px", borderRadius: 8, background: "#F2C744", border: "2px solid #000", boxShadow: "2px 2px 0px #000", color: "#000", fontWeight: 900, fontSize: 12, cursor: "pointer" }}>
                📂 {reconFileName ? "Replace settlement file" : "Upload settlement file (.csv)"}
                <input type="file" accept=".csv,text/csv" style={{ display: "none" }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleSettlementFile(f); e.target.value = ""; }} />
              </label>
              {reconFileName && (
                <span style={{ fontSize: 11, color: "#555" }}>
                  📄 {reconFileName} · matched against <strong style={{ color: "#000" }}>{edcTxns.filter(t => (t.vendor || "").toLowerCase() === reconVendor).length}</strong> {reconVendor} txn(s) for {today}
                </span>
              )}
              {reconResult && (
                <button onClick={() => { setReconResult(null); setReconFileName(""); setReconError(""); }}
                  style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: "#fff", border: "2px solid #000", color: "#000", cursor: "pointer" }}>
                  Clear
                </button>
              )}
            </div>

            {reconError && (
              <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: "#FFF3F3", border: `2px solid ${RED}`, color: RED, fontSize: 12 }}>
                ⚠️ {reconError}
              </div>
            )}

            {!r && !reconError && (
              <div style={{ padding: 32, textAlign: "center", color: "#888", fontSize: 12, border: "2px dashed #000", borderRadius: 10 }}>
                No settlement file loaded yet. Pick a vendor above and upload its daily CSV to begin.
              </div>
            )}

            {r && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12 }}>
                  <Tile label="Settlement rows" value={String(r.totals.settlementCount)} color={GOLD} />
                  <Tile label="Settlement ₹" value={`₹${Math.round(r.totals.settlementAmount).toLocaleString()}`} color={GOLD} />
                  <Tile label="✅ Matched clean" value={String(r.totals.matchedCount)} color={GREEN} />
                  <Tile label="Matched ₹" value={`₹${Math.round(r.totals.matchedAmount).toLocaleString()}`} color={GREEN} />
                  <Tile label="⚠ Issues" value={String(r.totals.issueCount)} color={r.totals.issueCount > 0 ? RED : GREEN} />
                  <Tile label="Unparsed lines" value={String(r.unparsed.length)} color={r.unparsed.length > 0 ? ORANGE : "#888"} />
                </div>

                <div style={{ overflowX: "auto", border: "2px solid #000", borderRadius: 10, boxShadow: "4px 4px 0px #000" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: "#000" }}>
                    <thead>
                      <tr style={{ background: "#F2C744", color: "#000", fontSize: 10, textTransform: "uppercase", letterSpacing: ".5px" }}>
                        {["Issue", "Ref (RRN / Auth)", "Vendor ₹", "Firestore ₹", "Δ ₹", "Booking", "Card", "Bouncer", "What happened"].map((h) => (
                          <th key={h} style={{ padding: "8px 6px", textAlign: "left", borderBottom: "2px solid #000" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {r.issues.length === 0 ? (
                        <tr><td colSpan={9} style={{ padding: 24, textAlign: "center", color: GREEN }}>
                          🎉 Clean reconciliation — every {r.vendor} settlement row matches Firestore on amount.
                        </td></tr>
                      ) : r.issues.map((i, idx) => {
                        const c = issueColor(i.kind);
                        const drift = Math.round(i.firestoreAmount - i.settlementAmount);
                        return (
                          <tr key={`${i.kind}-${i.ref}-${idx}`} style={{ borderBottom: "1px solid #eee" }}>
                            <td style={{ padding: "6px 6px" }}>
                              <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 800, background: `${c}22`, border: `1px solid ${c}55`, color: c }}>
                                {issueLabel(i.kind)}
                              </span>
                            </td>
                            <td style={{ padding: "6px 6px", fontFamily: "monospace", fontSize: 10, color: "#333" }}>{i.ref}</td>
                            <td style={{ padding: "6px 6px", textAlign: "right", color: i.settlementAmount > 0 ? "#000" : "#ccc", fontWeight: 700 }}>
                              {i.settlementAmount > 0 ? `₹${i.settlementAmount.toLocaleString()}` : "—"}
                            </td>
                            <td style={{ padding: "6px 6px", textAlign: "right", color: i.firestoreAmount > 0 ? "#000" : "#ccc", fontWeight: 700 }}>
                              {i.firestoreAmount > 0 ? `₹${i.firestoreAmount.toLocaleString()}` : "—"}
                            </td>
                            <td style={{ padding: "6px 6px", textAlign: "right", color: drift === 0 ? "#ccc" : drift > 0 ? ORANGE : RED, fontWeight: 800 }}>
                              {drift === 0 ? "—" : `${drift > 0 ? "+" : ""}₹${drift.toLocaleString()}`}
                            </td>
                            <td style={{ padding: "6px 6px", color: "#666", fontFamily: "monospace", fontSize: 10 }}>{i.txn?.bookingRef || "—"}</td>
                            <td style={{ padding: "6px 6px" }}>
                              {(i.txn?.last4 || i.settlement?.last4)
                                ? <span>••••{i.txn?.last4 || i.settlement?.last4}</span>
                                : <span style={{ color: "#ccc" }}>—</span>}
                            </td>
                            <td style={{ padding: "6px 6px", color: "#555" }}>{i.txn?.bouncerName || "—"}</td>
                            <td style={{ padding: "6px 6px", color: "#555", fontSize: 10 }}>{i.detail}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {r.unparsed.length > 0 && (
                  <details style={{ marginTop: 12, padding: 10, borderRadius: 8, background: "#FFFBE6", border: `2px solid #000` }}>
                    <summary style={{ cursor: "pointer", fontSize: 11, fontWeight: 800, color: ORANGE }}>
                      ⚠ {r.unparsed.length} line(s) couldn't be parsed (no RRN / reference column found) — click to inspect
                    </summary>
                    <pre style={{ marginTop: 8, fontSize: 10, color: "#555", maxHeight: 200, overflow: "auto" }}>
                      {r.unparsed.slice(0, 20).map((u, i) => `${i + 1}. ${JSON.stringify(u)}`).join("\n")}
                      {r.unparsed.length > 20 ? `\n… and ${r.unparsed.length - 20} more` : ""}
                    </pre>
                  </details>
                )}
              </>
            )}
          </>
        );
      })()}

      {/* TALLY VIEW */}
      {view === "tally" && (
        <div style={{ overflowX: "auto", border: "2px solid #000", borderRadius: 10, boxShadow: "4px 4px 0px #000" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: "#000" }}>
            <thead>
              <tr style={{ background: "#F2C744", color: "#000", fontSize: 10, textTransform: "uppercase", letterSpacing: ".5px" }}>
                {["", "Verdict", "Table", "Customer", "Captain", "Paid At", "KOTs", "KOT ₹", "Void ₹", "Bill ₹", "Diff ₹", "Mismatched items"].map((h) => (
                  <th key={h} style={{ padding: "8px 6px", textAlign: "left", borderBottom: "2px solid #000" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredTally.length === 0 ? (
                <tr><td colSpan={12} style={{ padding: 24, textAlign: "center", color: "#888" }}>
                  {tallyKots.length === 0 && tallyRows.length === 0
                    ? "No closed tables yet for this night — once captains mark tables paid, they'll show here."
                    : "No tables match this filter."}
                </td></tr>
              ) : filteredTally.map((r) => {
                const vColor = r.verdict === "leakage" ? RED
                  : r.verdict === "phantom" ? ORANGE
                  : r.verdict === "minor" ? ORANGE
                  : r.verdict === "bill-voided" ? "#888"
                  : r.verdict === "unknown" ? AMBER : GREEN;
                const vLabel = r.verdict === "leakage" ? "🔴 LEAKAGE"
                  : r.verdict === "phantom" ? "👻 PHANTOM"
                  : r.verdict === "minor" ? "🟠 MINOR"
                  : r.verdict === "bill-voided" ? "⚫ BILL VOIDED"
                  : r.verdict === "unknown" ? "🟡 UNKNOWN" : "🟢 MATCH";
                const expanded = expandedTally === r.reservationId;
                return (
                  <Fragment key={r.reservationId}>
                    <tr style={{ borderBottom: "1px solid #eee", cursor: r.itemDiffs.length > 0 ? "pointer" : "default" }}
                      onClick={() => r.itemDiffs.length > 0 && setExpandedTally(expanded ? null : r.reservationId)}>
                      <td style={{ padding: "6px 6px" }}>
                        <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 5, background: vColor }} />
                      </td>
                      <td style={{ padding: "6px 6px" }}>
                        <span style={{ display: "inline-block", padding: "2px 6px", borderRadius: 4, fontSize: 10, fontWeight: 800, background: `${vColor}22`, border: `1px solid ${vColor}55`, color: vColor }}>
                          {vLabel}
                        </span>
                      </td>
                      <td style={{ padding: "6px 6px", color: "#000", fontWeight: 800 }}>{r.tableId}<div style={{ fontSize: 9, color: "#888" }}>{r.floor}</div></td>
                      <td style={{ padding: "6px 6px" }}>{r.customerName || "—"}</td>
                      <td style={{ padding: "6px 6px" }}>{r.captain || "—"}</td>
                      <td style={{ padding: "6px 6px", color: "#555" }}>{fmtTime(r.paidAt)}</td>
                      <td style={{ padding: "6px 6px", textAlign: "right" }}>{r.kotCount}</td>
                      <td style={{ padding: "6px 6px", textAlign: "right" }}>₹{Math.round(r.kotValue).toLocaleString()}</td>
                      <td style={{ padding: "6px 6px", textAlign: "right", color: r.voidValue > 0 ? AMBER : "#ccc" }}>
                        {r.voidValue > 0 ? `₹${Math.round(r.voidValue).toLocaleString()}` : "—"}
                      </td>
                      <td style={{ padding: "6px 6px", textAlign: "right" }}>₹{Math.round(r.billValue).toLocaleString()}</td>
                      <td style={{ padding: "6px 6px", textAlign: "right", color: vColor, fontWeight: 800 }}>
                        {Math.abs(r.diffValue) < 1 ? "✓" : `${r.diffValue > 0 ? "+" : ""}₹${Math.round(r.diffValue).toLocaleString()}`}
                      </td>
                      <td style={{ padding: "6px 6px", fontSize: 10, color: "#555" }}>
                        {r.itemDiffs.length === 0
                          ? <span style={{ color: "#ccc" }}>—</span>
                          : <span>{r.itemDiffs.length} item{r.itemDiffs.length !== 1 ? "s" : ""} · click {expanded ? "▲" : "▼"}</span>}
                      </td>
                    </tr>
                    {expanded && r.itemDiffs.length > 0 && (() => {
                      // Plain-English "WHY mismatched" sentence (Khushi-requested 11 May 2026).
                      // Build per-item phrases (UNDERCHARGED / OVERCHARGED) then a verdict explainer.
                      const under = r.itemDiffs.filter(d => d.diffQty < 0); // KOT > bill = LEAKAGE
                      const over  = r.itemDiffs.filter(d => d.diffQty > 0); // bill > KOT = PHANTOM
                      const phrases: string[] = [];
                      under.forEach(d => phrases.push(`served ${Math.abs(d.diffQty)}× ${d.name.toUpperCase()} but never billed (₹${Math.round(Math.abs(d.diffValue)).toLocaleString()} short)`));
                      over.forEach(d => phrases.push(`billed ${d.diffQty}× extra ${d.name.toUpperCase()} with no matching KOT (₹${Math.round(d.diffValue).toLocaleString()} extra)`));
                      const sentence = phrases.join(" · ");
                      const explainer = r.verdict === "leakage"
                        ? `🔴 LEAKAGE — items were physically served but the customer was NEVER charged for them. This is a CASH-POCKET RISK (captain may have taken cash without ringing it up). Total short: ₹${Math.round(r.leakageValue).toLocaleString()}.`
                        : r.verdict === "phantom"
                        ? `👻 PHANTOM — the customer was BILLED for items that were never made (no KOT printed). Usually a comp gone wrong, a manual bill add-on, or a captain over-charging. Total extra: ₹${Math.round(r.phantomValue).toLocaleString()}.`
                        : r.verdict === "minor"
                        ? `🟠 MINOR — small mismatch under ₹500 threshold. Likely a typo, a pricing tweak mid-night, or an unprinted comp. Worth a quick check but not a fraud red-flag.`
                        : "";
                      return (
                      <tr style={{ background: "#F9F9F9" }}>
                        <td colSpan={12} style={{ padding: "10px 14px" }}>
                          {explainer && (
                            <div style={{ marginBottom: 10, padding: "8px 10px", borderRadius: 6, background: `${vColor}11`, border: `2px solid ${vColor}55`, fontSize: 12, color: "#000", lineHeight: 1.45 }}>
                              <div style={{ fontWeight: 800, color: vColor, marginBottom: 4 }}>WHY THIS IS MISMATCHED</div>
                              <div style={{ marginBottom: phrases.length ? 6 : 0 }}>{explainer}</div>
                              {phrases.length > 0 && <div style={{ color: "#333", fontSize: 11.5 }}><strong style={{ color: vColor }}>What happened:</strong> {sentence}.</div>}
                            </div>
                          )}
                          <div style={{ fontSize: 10, color: "#888", marginBottom: 6, fontWeight: 800, letterSpacing: ".5px" }}>📋 ITEM-LEVEL BREAKDOWN — {r.tableId}</div>
                          <div style={{ display: "grid", gridTemplateColumns: "2fr 0.6fr 0.6fr 0.6fr 0.7fr 0.8fr 0.9fr", gap: 6, fontSize: 11 }}>
                            <div style={{ fontWeight: 800, color: "#888", fontSize: 10 }}>ITEM</div>
                            <div style={{ fontWeight: 800, color: "#888", fontSize: 10, textAlign: "right" }}>UNIT ₹</div>
                            <div style={{ fontWeight: 800, color: "#888", fontSize: 10, textAlign: "right" }}>KOT</div>
                            <div style={{ fontWeight: 800, color: AMBER, fontSize: 10, textAlign: "right" }}>VOIDED</div>
                            <div style={{ fontWeight: 800, color: "#888", fontSize: 10, textAlign: "right" }}>EXPECTED</div>
                            <div style={{ fontWeight: 800, color: "#888", fontSize: 10, textAlign: "right" }}>BILLED</div>
                            <div style={{ fontWeight: 800, color: vColor, fontSize: 10, textAlign: "right" }}>DIFF ₹</div>
                            {r.itemDiffs.map((d, i) => {
                              const dColor = d.diffValue > 0 ? RED : d.diffValue < 0 ? ORANGE : GREEN;
                              return (
                                <Fragment key={i}>
                                  <div style={{ color: "#000" }}>{d.name}</div>
                                  <div style={{ textAlign: "right", color: "#666" }}>₹{d.unitPrice.toLocaleString()}</div>
                                  <div style={{ textAlign: "right" }}>{d.kotQty}</div>
                                  <div style={{ textAlign: "right", color: d.voidQty > 0 ? AMBER : "#ccc" }}>{d.voidQty || "—"}</div>
                                  <div style={{ textAlign: "right", color: "#555" }}>{d.expectedBillQty}</div>
                                  <div style={{ textAlign: "right" }}>{d.billQty}</div>
                                  <div style={{ textAlign: "right", color: dColor, fontWeight: 800 }}>
                                    {d.diffQty > 0 ? `+${d.diffQty} = ₹${Math.round(d.diffValue).toLocaleString()}`
                                      : d.diffQty < 0 ? `${d.diffQty} = −₹${Math.abs(Math.round(d.diffValue)).toLocaleString()}`
                                      : "✓"}
                                  </div>
                                </Fragment>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                      );
                    })()}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 10, color: "#888" }}>
        Tip: filter by 🟠 / 🔴 then export to share with your accountant. Aggregator-paid amounts are matched from the Zomato email-parser (orphanZomatoPayments) by phone — verify before reconciling.
      </div>
    </div>
  );
}

function Tile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ padding: 12, borderRadius: 10, background: "#fff", border: "2px solid #000", boxShadow: "4px 4px 0px #000" }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: "#000", letterSpacing: ".5px" }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 20, fontWeight: 900, color, marginTop: 4 }}>{value}</div>
    </div>
  );
}
