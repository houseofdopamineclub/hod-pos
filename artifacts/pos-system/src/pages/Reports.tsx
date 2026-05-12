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
import { collection, onSnapshot, query, where, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  subscribeToHodReservations, subscribeToBookings, subscribeToGuestlist,
  AGGREGATOR_OPTIONS, getAggregatorDiscount,
  type HodTableReservation, type HodBooking, type HodGuestlistEntry, type HodCover,
} from "@/lib/firestore-hod";
import { getOperationalNightStr } from "@/lib/utils-pos";
import {
  buildAllTallyRows, aggregateCaptainLeakage,
  type PosKotDoc, type TallyRow,
} from "@/lib/kot-bill-tally";

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
  paymentStatus: string;
  paymentMethod: string;
  /** When paid via aggregator, the full aggregator-side amount (= total before
   *  discount strip if the aggregator absorbed it; for our case Zomato/Swiggy
   *  pay us the post-discount total). Logged separately for reconciliation. */
  aggregatorPaidAmount: number;
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
  payChannel: "" | "paid_online" | "pay_at_venue" | "free_entry" | "unknown";
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
  if (r.needsManualReview) flags.push("needs-review");

  let ambiguity: Ambiguity = "green";
  if (billPrintCount > 1 || voidValueLost > 0 || hasDowngrade || unpaidMinAfterBill >= 60 || r.needsManualReview ||
      (aggregatorVariance !== null && aggregatorVariance <= -500)) ambiguity = "red";
  else if (overrides > 0 || sourceSwapLog.length > 0 || modifiedDiscount || r.billStale || unpaidMinAfterBill >= 30 ||
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
    paymentStatus: r.paymentStatus || "open",
    paymentMethod, aggregatorPaidAmount, aggregatorVariance,
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
  bookingTotal?: number;
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
  const linkedBooking = c.bookingId ? bookings.get(c.bookingId) : undefined;
  const guest = guestlistByName.get((c.name || "").toLowerCase().trim());
  const recharged = Number(c.topUpTotal || 0);
  const used = Number(c.coverUsed || 0);
  const activated = Number(c.coverActivated || 0);
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
  });
  const { source, payChannel } = cls;
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
    paymentMethod: c.paymentMethod || "",
    tableId: c.tableId || "",
    walletBillPrints: c.walletBillPrintCount || 0,
    lastBillAt: c.lastWalletBillPrintedAt || "",
  };
}

export default function Reports() {
  const [reservations, setReservations] = useState<HodTableReservation[]>([]);
  const [bookings, setBookings] = useState<HodBooking[]>([]);
  const [guestlist, setGuestlist] = useState<HodGuestlistEntry[]>([]);
  const [covers, setCovers] = useState<Array<HodCover & { id: string }>>([]);
  const [orphans, setOrphans] = useState<any[]>([]);
  const [view, setView] = useState<"tables" | "wallets" | "tally">("tables");
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
  const last7Dates = useMemo(() => {
    const out: string[] = [];
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
    const merge = () => {
      const seen = new Set<string>();
      const out: HodTableReservation[] = [];
      for (const r of [...aRes, ...bRes]) { if (!seen.has(r._docId)) { seen.add(r._docId); out.push(r); } }
      setReservations(out);
    };
    const u1 = subscribeToHodReservations(today, (r) => { aRes = r; merge(); });
    const u2 = subscribeToHodReservations(next, (r) => { bRes = r; merge(); });
    return () => { u1(); u2(); };
  }, [today]);
  // 2) Bookings (real-time, all)
  useEffect(() => subscribeToBookings(setBookings), []);
  // 3) Guestlist (real-time, all)
  useEffect(() => subscribeToGuestlist(setGuestlist), []);
  // 4) Covers (real-time — query the whole collection; small enough for a club night)
  useEffect(() => {
    const unsub = onSnapshot(collection(db, "covers"), (snap) => {
      setCovers(snap.docs.map(d => ({ ...(d.data() as HodCover), id: d.id })));
    }, (e) => console.warn("[Reports] covers subscribe failed", e));
    return unsub;
  }, []);
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

  const tableRows = useMemo(() => reservations.map(r => buildTableRow(r, orphanByPhone)), [reservations, orphanByPhone]);
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
    const rows = covers
      .map(c => buildWalletRow(c, bookingsById, guestByName))
      .filter(w => !isTableCover(w, coverById.get(w.coverId)!))
      .filter(w => !isGhostCover(w))
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
      });
      rows.push({
        coverId: "", ref: refKey, name: b.name || "", phone: b.phone || "",
        email: (b as any).email || "", eventTitle: b.eventTitle || "", date: dateStr,
        source: cls.source, payChannel: cls.payChannel, paymentId: bPid, isGuestList: cls.isGuestList,
        agent: "", activatedAt: "",
        checkedIn: !!b.checkedIn, arrival: "",
        coverActivated: 0, topUpTotal: 0, coverUsed: 0, coverBalance: 0,
        paymentMethod: (b as any).paymentMethod || (b.paymentId ? "online" : ""),
        tableId: "", walletBillPrints: 0, lastBillAt: "",
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
        paymentMethod: "", tableId: "", walletBillPrints: 0, lastBillAt: "",
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
      "Payment Status": r.paymentStatus,
      "Payment Method": r.paymentMethod,
      "Aggregator Paid ₹": r.aggregatorPaidAmount,
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
      "Redeemed ₹": w.coverUsed,
      "Balance ₹": w.coverBalance,
      "Payment Method": w.paymentMethod,
      "Wallet Bill Prints": w.walletBillPrints,
      "Last Wallet Bill At": fmtTime(w.lastBillAt),
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

  const ambColor = (a: Ambiguity) => a === "red" ? RED : a === "orange" ? ORANGE : GREEN;
  const dot = (a: Ambiguity) => (
    <span title={a.toUpperCase()} style={{ display: "inline-block", width: 10, height: 10, borderRadius: 5, background: ambColor(a), boxShadow: `0 0 6px ${ambColor(a)}aa` }} />
  );

  return (
    <div style={{ color: "#fff" }}>
      {/* Header + view tabs + date picker */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 900, color: GOLD, fontFamily: "'Playfair Display', serif" }}>📋 Reports</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)" }}>
            {selectedDate === todayNight ? "🟢 LIVE — tonight" : `📅 Archive — ${selectedDate}`} · Live from Firestore · CSV export opens in Excel + Google Sheets.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)}
            title="Pick a night (last 7 days kept; older nights live in Google Sheets archive)"
            style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(255,255,255,.06)", border: "1px solid rgba(201,168,76,.3)", color: "#fff", fontSize: 12, fontWeight: 700 }}>
            {last7Dates.map((d, i) => (
              <option key={d} value={d}>{i === 0 ? `Tonight (${d})` : i === 1 ? `Last night (${d})` : d}</option>
            ))}
          </select>
          <button onClick={() => setView("tables")} style={{ padding: "8px 14px", borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: "pointer", border: "none",
            background: view === "tables" ? GOLD : "rgba(255,255,255,.06)", color: view === "tables" ? "#030305" : "#fff" }}>
            🍽 All Tables ({tableRows.length})
          </button>
          <button onClick={() => setView("wallets")} style={{ padding: "8px 14px", borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: "pointer", border: "none",
            background: view === "wallets" ? GOLD : "rgba(255,255,255,.06)", color: view === "wallets" ? "#030305" : "#fff" }}>
            🎟 Wallets / Guestlist ({walletRows.length})
          </button>
          <button onClick={() => setView("tally")}
            title="Compares every printed KOT against the final bill (subtracting manager-approved voids). Catches drinks served but never billed = cash-pocket leakage."
            style={{ padding: "8px 14px", borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: "pointer", border: "none",
              background: view === "tally" ? GOLD : "rgba(255,255,255,.06)",
              color: view === "tally" ? "#030305" : "#fff",
              boxShadow: tallyTotals.leakageTables > 0 && view !== "tally" ? `0 0 0 2px ${RED}88` : "none" }}>
            🧾 KOT vs Bill ({tallyRows.length})
            {tallyTotals.leakageTables > 0 && <span style={{ marginLeft: 6, color: view === "tally" ? RED : RED, fontWeight: 900 }}>· 🔴 {tallyTotals.leakageTables}</span>}
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
            <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: "rgba(168, 85, 247, .08)", border: "1px solid rgba(168, 85, 247, .3)", fontSize: 11, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <span style={{ color: "#a855f7", fontWeight: 800, marginRight: 4 }}>🎤 EVENT:</span>
              <button onClick={() => setEventFilter("all")}
                style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 800, cursor: "pointer", border: "1px solid rgba(168,85,247,.4)",
                  background: eventFilter === "all" ? "#a855f7" : "transparent", color: eventFilter === "all" ? "#fff" : "rgba(255,255,255,.85)" }}>
                ALL ({walletRows.length})
              </button>
              {walletTotals.events.map(ev => {
                const count = walletRows.filter(w => (w.eventTitle || "").trim() === ev).length;
                const active = eventFilter === ev;
                return (
                  <button key={ev} onClick={() => setEventFilter(ev)}
                    style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: "pointer", border: "1px solid rgba(168,85,247,.4)",
                      background: active ? "#a855f7" : "transparent", color: active ? "#fff" : "rgba(255,255,255,.85)" }}>
                    {ev} ({count})
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Data-source warning — surfaced once so Darshan knows what's real vs gap */}
      <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: "rgba(245, 158, 11, .08)", border: "1px solid rgba(245, 158, 11, .25)", fontSize: 11, color: "rgba(255,255,255,.75)" }}>
        <strong style={{ color: ORANGE }}>📡 DATA SOURCE:</strong> Real-time from Firestore (`tableReservations` + `covers` + `bookings` + `guestlist`).
        <strong> Email</strong> appears only when hodclub.in passes it in the booking — walk-ins captured at the door without a website booking will show "—".
        Aggregator-paid amounts are matched from the Zomato email parser by phone (last 10 digits) — verify before reconciling.
      </div>

      {/* Filter bar — search + ⚙ filter toggle + export */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 Search name / phone / table / captain / event"
          style={{ flex: "1 1 240px", padding: "8px 12px", borderRadius: 8, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 12 }} />
        <button onClick={() => setShowFilters(!showFilters)}
          title="Show / hide source + ambiguity filters"
          style={{ padding: "8px 14px", borderRadius: 8, border: showFilters ? `1px solid ${GOLD}` : "1px solid rgba(255,255,255,.1)",
            background: showFilters ? "rgba(201,168,76,.15)" : "rgba(255,255,255,.06)", color: showFilters ? GOLD : "#fff", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
          ⚙ Filter & Sort {(filter !== "all" || sourceFilter !== "all") ? "•" : ""}
        </button>
        <button onClick={view === "tables" ? exportTables : view === "wallets" ? exportWallets : exportTally}
          style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: GOLD, color: "#030305", fontWeight: 900, fontSize: 12, cursor: "pointer" }}>
          ⬇ Export CSV ({view === "tables" ? filteredTables.length : view === "wallets" ? filteredWallets.length : filteredTally.length} rows)
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
            <Tile label="⚫ Bill voided" value={String(tallyTotals.billVoidedTables)} color="rgba(255,255,255,.5)" />
            <Tile label="🔴 Leakage ₹" value={`₹${tallyTotals.leakageVal.toLocaleString()}`} color={RED} />
          </div>
          <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: "rgba(239, 68, 68, .06)", border: "1px solid rgba(239, 68, 68, .25)", fontSize: 11, color: "rgba(255,255,255,.78)" }}>
            <strong style={{ color: RED }}>🧾 KOT vs BILL TALLY:</strong> Every printed KOT (drink/food slip) compared to the final bill,
            after subtracting manager-PIN-approved voids. <strong>🔴 LEAKAGE</strong> = items physically served but never charged
            (cash-pocket risk). <strong>👻 PHANTOM</strong> = items billed but no KOT (rare — usually a comp / bartender error).
            Threshold: ₹{500} = red. Open tabs are skipped (still ordering). <strong>If KOT data fails to load</strong>,
            the table simply shows "no data" — never false-flags.
          </div>
          {tallyByCaptain.filter(c => c.totalLeakage + c.totalPhantom > 0).length > 0 && (
            <div style={{ marginBottom: 12, padding: 10, borderRadius: 10, background: "rgba(239,68,68,.05)", border: "1px solid rgba(239,68,68,.25)" }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: RED, marginBottom: 8 }}>👤 PER-CAPTAIN LEAKAGE — {selectedDate}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1.5fr 0.6fr 0.7fr 1fr 0.7fr 1fr", gap: 8, fontSize: 12 }}>
                <div style={{ fontWeight: 800, color: "rgba(255,255,255,.6)", fontSize: 10 }}>CAPTAIN</div>
                <div style={{ fontWeight: 800, color: "rgba(255,255,255,.6)", fontSize: 10, textAlign: "right" }}>TABLES</div>
                <div style={{ fontWeight: 800, color: RED, fontSize: 10, textAlign: "right" }}>🔴 LEAK#</div>
                <div style={{ fontWeight: 800, color: RED, fontSize: 10, textAlign: "right" }}>🔴 LEAK ₹</div>
                <div style={{ fontWeight: 800, color: ORANGE, fontSize: 10, textAlign: "right" }}>👻 PHAN#</div>
                <div style={{ fontWeight: 800, color: ORANGE, fontSize: 10, textAlign: "right" }}>👻 PHAN ₹</div>
                {tallyByCaptain.filter(c => c.totalLeakage + c.totalPhantom > 0).map(c => (
                  <Fragment key={c.captain}>
                    <div style={{ color: "#fff", fontWeight: 700 }}>{c.captain}</div>
                    <div style={{ textAlign: "right", color: "rgba(255,255,255,.7)" }}>{c.tables}</div>
                    <div style={{ textAlign: "right", color: c.leakageTables > 0 ? RED : "rgba(255,255,255,.3)", fontWeight: 800 }}>{c.leakageTables || "—"}</div>
                    <div style={{ textAlign: "right", color: c.totalLeakage > 0 ? RED : "rgba(255,255,255,.3)", fontWeight: 800 }}>{c.totalLeakage > 0 ? `₹${c.totalLeakage.toLocaleString()}` : "—"}</div>
                    <div style={{ textAlign: "right", color: c.phantomTables > 0 ? ORANGE : "rgba(255,255,255,.3)", fontWeight: 800 }}>{c.phantomTables || "—"}</div>
                    <div style={{ textAlign: "right", color: c.totalPhantom > 0 ? ORANGE : "rgba(255,255,255,.3)", fontWeight: 800 }}>{c.totalPhantom > 0 ? `₹${c.totalPhantom.toLocaleString()}` : "—"}</div>
                  </Fragment>
                ))}
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {([
              ["all", "ALL", GOLD],
              ["mismatched",
                `⚠ MISMATCHED (${tallyTotals.leakageTables + tallyTotals.phantomTables + tallyTotals.minorTables})`,
                tallyTotals.leakageTables > 0 ? RED : ORANGE],
              ["match", `🟢 MATCH (${tallyTotals.matchTables})`, GREEN],
              ["bill-voided", `⚫ BILL VOIDED (${tallyTotals.billVoidedTables})`, "rgba(255,255,255,.5)"],
            ] as const).map(([v, label, c]) => (
              <button key={v} onClick={() => setTallyVerdictFilter(v as any)}
                style={{ padding: "6px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 800,
                  background: tallyVerdictFilter === v ? c : "rgba(255,255,255,.06)",
                  color: tallyVerdictFilter === v ? "#030305" : "#fff" }}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Filter drawer (collapsed by default) */}
      {showFilters && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, padding: 10, borderRadius: 8, background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.08)", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,.6)", fontWeight: 700, marginRight: 4 }}>SOURCE:</span>
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 6, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 12 }}>
            <option value="all">All sources</option>
            {(view === "tables" ? sources : ["guestlist", "entry-only", "cover", "group-booking", "walk-in", "aggregator"]).map(s => <option key={s} value={s}>{s.toUpperCase().replace("-", " ")}</option>)}
          </select>
          {view === "tables" && (
            <>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,.6)", fontWeight: 700, marginLeft: 8, marginRight: 4 }}>AMBIGUITY:</span>
              <div style={{ display: "flex", gap: 4 }}>
                {(["all", "green", "orange", "red"] as const).map((f) => (
                  <button key={f} onClick={() => setFilter(f)} style={{ padding: "6px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 800,
                    background: filter === f ? (f === "all" ? GOLD : ambColor(f as Ambiguity)) : "rgba(255,255,255,.06)",
                    color: filter === f ? "#030305" : "#fff" }}>
                    {f === "all" ? "ALL" : f === "red" ? "🔴 RED" : f === "orange" ? "🟠 ORANGE" : "🟢 GREEN"}
                  </button>
                ))}
              </div>
            </>
          )}
          {(filter !== "all" || sourceFilter !== "all") && (
            <button onClick={() => { setFilter("all"); setSourceFilter("all"); }}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,.15)", background: "transparent", color: "rgba(255,255,255,.7)", fontSize: 11, cursor: "pointer", marginLeft: "auto" }}>
              Clear
            </button>
          )}
        </div>
      )}

      {/* TABLE VIEW */}
      {view === "tables" && (
        <div style={{ overflowX: "auto", border: "1px solid rgba(201,168,76,.2)", borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: "#fff" }}>
            <thead>
              <tr style={{ background: "rgba(201,168,76,.1)", color: GOLD, fontSize: 10, textTransform: "uppercase", letterSpacing: ".5px" }}>
                {["", "Table", "Source", "Customer", "Phone", "Email", "Captain", "Party", "Arrival", "Min", "Total ₹", "Disc%", "Status", "Pay Method", "Agg Paid ₹", "Agg Var ₹", "Bill ×", "Flags"].map((h) => (
                  <th key={h} style={{ padding: "8px 6px", textAlign: "left", borderBottom: "1px solid rgba(201,168,76,.3)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredTables.length === 0 ? (
                <tr><td colSpan={18} style={{ padding: 24, textAlign: "center", color: "rgba(255,255,255,.4)" }}>No tables match filters.</td></tr>
              ) : filteredTables.map((r) => (
                <tr key={r.reservationId} style={{ borderBottom: "1px solid rgba(255,255,255,.04)" }}>
                  <td style={{ padding: "6px 6px" }}>{dot(r.ambiguity)}</td>
                  <td style={{ padding: "6px 6px", color: GOLD, fontWeight: 800 }}>{r.tableId}<div style={{ fontSize: 9, color: "rgba(255,255,255,.4)" }}>{r.floor}</div></td>
                  <td style={{ padding: "6px 6px" }}>{r.sourceLabel}{r.modifiedDiscount && <span title={`Default ${r.defaultDiscount}% → ${r.discountPct}%`} style={{ marginLeft: 4, color: ORANGE, fontWeight: 800 }}>✎</span>}</td>
                  <td style={{ padding: "6px 6px" }}>{r.customerName || "—"}</td>
                  <td style={{ padding: "6px 6px", fontFamily: "monospace" }}>{r.phone || "—"}</td>
                  <td style={{ padding: "6px 6px", fontSize: 10, color: "rgba(255,255,255,.6)" }}>{r.email || "—"}</td>
                  <td style={{ padding: "6px 6px" }}>{r.captain || "—"}</td>
                  <td style={{ padding: "6px 6px" }}>{r.partySize || "—"}</td>
                  <td style={{ padding: "6px 6px", color: "rgba(255,255,255,.7)" }}>{fmtTime(r.arrival)}</td>
                  <td style={{ padding: "6px 6px", color: r.minutesOnTable > 240 ? ORANGE : "rgba(255,255,255,.7)" }}>{r.minutesOnTable || "—"}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right", fontWeight: 800 }}>₹{r.total.toLocaleString()}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right", color: r.modifiedDiscount ? ORANGE : "rgba(255,255,255,.7)" }}>{r.discountPct}%</td>
                  <td style={{ padding: "6px 6px", color: r.paymentStatus === "paid" ? GREEN : r.paymentStatus === "bill_requested" ? ORANGE : "rgba(255,255,255,.6)" }}>
                    {r.paymentStatus === "paid" ? "✅ paid" : r.paymentStatus === "bill_requested" ? "🧾 bill due" : "open"}
                  </td>
                  <td style={{ padding: "6px 6px", textTransform: "uppercase", fontSize: 10 }}>{r.paymentMethod || "—"}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right", color: r.aggregatorPaidAmount ? "#a855f7" : "rgba(255,255,255,.4)" }}>
                    {r.aggregatorPaidAmount ? `₹${r.aggregatorPaidAmount.toLocaleString()}` : "—"}
                  </td>
                  <td style={{ padding: "6px 6px", textAlign: "right", fontWeight: 800,
                    color: r.aggregatorVariance === null ? "rgba(255,255,255,.3)"
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
                  <td style={{ padding: "6px 6px", color: r.billPrintCount > 1 ? RED : "rgba(255,255,255,.6)", fontWeight: r.billPrintCount > 1 ? 900 : 400, textAlign: "center" }}>
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
        <div style={{ overflowX: "auto", border: "1px solid rgba(201,168,76,.2)", borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: "#fff" }}>
            <thead>
              <tr style={{ background: "rgba(201,168,76,.1)", color: GOLD, fontSize: 10, textTransform: "uppercase", letterSpacing: ".5px" }}>
                {["Source", "Pay Channel", "Name", "Phone", "Email", "Event", "Agent", "Activated", "✓In", "Cover ₹", "Recharged ₹", "Redeemed ₹", "Balance ₹", "Pay", "Bill ×"].map((h) => (
                  <th key={h} style={{ padding: "8px 6px", textAlign: "left", borderBottom: "1px solid rgba(201,168,76,.3)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredWallets.length === 0 ? (
                <tr><td colSpan={15} style={{ padding: 24, textAlign: "center", color: "rgba(255,255,255,.4)" }}>No wallet/guestlist entries for this date.</td></tr>
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
                <tr key={w.coverId || `synth:${w.ref}` || `${w.source}:${w.name}:${w.phone}`} style={{ borderBottom: "1px solid rgba(255,255,255,.04)" }}>
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
                    ) : w.payChannel === "unknown" ? (
                      <span title="Booking has no payment record. Could be legacy data, admin-created, or an abandoned checkout. VERIFY MANUALLY before reconciling."
                            style={{ fontSize: 10, fontWeight: 800, color: RED, cursor: "help" }}>⚠ UNKNOWN</span>
                    ) : (
                      <span style={{ fontSize: 10, color: "rgba(255,255,255,.3)" }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: "6px 6px", color: "#fff", fontWeight: 700 }}>{w.name}</td>
                  <td style={{ padding: "6px 6px", fontFamily: "monospace" }}>{w.phone || "—"}</td>
                  <td style={{ padding: "6px 6px", fontSize: 10, color: "rgba(255,255,255,.6)" }}>{w.email || "—"}</td>
                  <td style={{ padding: "6px 6px", fontSize: 10 }}>{w.eventTitle || "—"}</td>
                  <td style={{ padding: "6px 6px" }}>{w.agent || "—"}</td>
                  <td style={{ padding: "6px 6px", color: "rgba(255,255,255,.7)" }}>{fmtTime(w.activatedAt)}</td>
                  <td style={{ padding: "6px 6px", color: w.checkedIn ? GREEN : "rgba(255,255,255,.4)" }}>{w.checkedIn ? "✓" : "—"}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right" }}>₹{w.coverActivated.toLocaleString()}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right", color: w.topUpTotal > 0 ? GOLD : "rgba(255,255,255,.4)" }}>{w.topUpTotal > 0 ? `₹${w.topUpTotal.toLocaleString()}` : "—"}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right" }}>₹{w.coverUsed.toLocaleString()}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right", color: w.coverBalance > 0 ? GREEN : "rgba(255,255,255,.4)", fontWeight: 800 }}>₹{w.coverBalance.toLocaleString()}</td>
                  <td style={{ padding: "6px 6px", fontSize: 10, textTransform: "uppercase" }}>{w.paymentMethod || "—"}</td>
                  <td style={{ padding: "6px 6px", textAlign: "center", color: w.walletBillPrints > 1 ? RED : "rgba(255,255,255,.6)", fontWeight: w.walletBillPrints > 1 ? 900 : 400 }}>
                    {w.walletBillPrints || 0}{w.walletBillPrints > 1 ? " ⚠" : ""}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* TALLY VIEW */}
      {view === "tally" && (
        <div style={{ overflowX: "auto", border: "1px solid rgba(201,168,76,.2)", borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: "#fff" }}>
            <thead>
              <tr style={{ background: "rgba(201,168,76,.1)", color: GOLD, fontSize: 10, textTransform: "uppercase", letterSpacing: ".5px" }}>
                {["", "Verdict", "Table", "Customer", "Captain", "Paid At", "KOTs", "KOT ₹", "Void ₹", "Bill ₹", "Diff ₹", "Mismatched items"].map((h) => (
                  <th key={h} style={{ padding: "8px 6px", textAlign: "left", borderBottom: "1px solid rgba(201,168,76,.3)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredTally.length === 0 ? (
                <tr><td colSpan={12} style={{ padding: 24, textAlign: "center", color: "rgba(255,255,255,.4)" }}>
                  {tallyKots.length === 0 && tallyRows.length === 0
                    ? "No closed tables yet for this night — once captains mark tables paid, they'll show here."
                    : "No tables match this filter."}
                </td></tr>
              ) : filteredTally.map((r) => {
                const vColor = r.verdict === "leakage" ? RED
                  : r.verdict === "phantom" ? ORANGE
                  : r.verdict === "minor" ? ORANGE
                  : r.verdict === "bill-voided" ? "rgba(255,255,255,.5)"
                  : r.verdict === "unknown" ? AMBER : GREEN;
                const vLabel = r.verdict === "leakage" ? "🔴 LEAKAGE"
                  : r.verdict === "phantom" ? "👻 PHANTOM"
                  : r.verdict === "minor" ? "🟠 MINOR"
                  : r.verdict === "bill-voided" ? "⚫ BILL VOIDED"
                  : r.verdict === "unknown" ? "🟡 UNKNOWN" : "🟢 MATCH";
                const expanded = expandedTally === r.reservationId;
                return (
                  <Fragment key={r.reservationId}>
                    <tr style={{ borderBottom: "1px solid rgba(255,255,255,.04)", cursor: r.itemDiffs.length > 0 ? "pointer" : "default" }}
                      onClick={() => r.itemDiffs.length > 0 && setExpandedTally(expanded ? null : r.reservationId)}>
                      <td style={{ padding: "6px 6px" }}>
                        <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 5, background: vColor, boxShadow: `0 0 6px ${vColor}aa` }} />
                      </td>
                      <td style={{ padding: "6px 6px" }}>
                        <span style={{ display: "inline-block", padding: "2px 6px", borderRadius: 4, fontSize: 10, fontWeight: 800, background: `${vColor}22`, border: `1px solid ${vColor}55`, color: vColor }}>
                          {vLabel}
                        </span>
                      </td>
                      <td style={{ padding: "6px 6px", color: GOLD, fontWeight: 800 }}>{r.tableId}<div style={{ fontSize: 9, color: "rgba(255,255,255,.4)" }}>{r.floor}</div></td>
                      <td style={{ padding: "6px 6px" }}>{r.customerName || "—"}</td>
                      <td style={{ padding: "6px 6px" }}>{r.captain || "—"}</td>
                      <td style={{ padding: "6px 6px", color: "rgba(255,255,255,.7)" }}>{fmtTime(r.paidAt)}</td>
                      <td style={{ padding: "6px 6px", textAlign: "right" }}>{r.kotCount}</td>
                      <td style={{ padding: "6px 6px", textAlign: "right" }}>₹{Math.round(r.kotValue).toLocaleString()}</td>
                      <td style={{ padding: "6px 6px", textAlign: "right", color: r.voidValue > 0 ? AMBER : "rgba(255,255,255,.4)" }}>
                        {r.voidValue > 0 ? `₹${Math.round(r.voidValue).toLocaleString()}` : "—"}
                      </td>
                      <td style={{ padding: "6px 6px", textAlign: "right" }}>₹{Math.round(r.billValue).toLocaleString()}</td>
                      <td style={{ padding: "6px 6px", textAlign: "right", color: vColor, fontWeight: 800 }}>
                        {Math.abs(r.diffValue) < 1 ? "✓" : `${r.diffValue > 0 ? "+" : ""}₹${Math.round(r.diffValue).toLocaleString()}`}
                      </td>
                      <td style={{ padding: "6px 6px", fontSize: 10, color: "rgba(255,255,255,.7)" }}>
                        {r.itemDiffs.length === 0
                          ? <span style={{ color: "rgba(255,255,255,.3)" }}>—</span>
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
                      <tr style={{ background: "rgba(0,0,0,.25)" }}>
                        <td colSpan={12} style={{ padding: "10px 14px" }}>
                          {explainer && (
                            <div style={{ marginBottom: 10, padding: "8px 10px", borderRadius: 6, background: `${vColor}11`, border: `1px solid ${vColor}44`, fontSize: 12, color: "#fff", lineHeight: 1.45 }}>
                              <div style={{ fontWeight: 800, color: vColor, marginBottom: 4 }}>WHY THIS IS MISMATCHED</div>
                              <div style={{ marginBottom: phrases.length ? 6 : 0 }}>{explainer}</div>
                              {phrases.length > 0 && <div style={{ color: "rgba(255,255,255,.85)", fontSize: 11.5 }}><strong style={{ color: vColor }}>What happened:</strong> {sentence}.</div>}
                            </div>
                          )}
                          <div style={{ fontSize: 10, color: "rgba(255,255,255,.5)", marginBottom: 6, fontWeight: 800, letterSpacing: ".5px" }}>📋 ITEM-LEVEL BREAKDOWN — {r.tableId}</div>
                          <div style={{ display: "grid", gridTemplateColumns: "2fr 0.6fr 0.6fr 0.6fr 0.7fr 0.8fr 0.9fr", gap: 6, fontSize: 11 }}>
                            <div style={{ fontWeight: 800, color: "rgba(255,255,255,.5)", fontSize: 10 }}>ITEM</div>
                            <div style={{ fontWeight: 800, color: "rgba(255,255,255,.5)", fontSize: 10, textAlign: "right" }}>UNIT ₹</div>
                            <div style={{ fontWeight: 800, color: "rgba(255,255,255,.5)", fontSize: 10, textAlign: "right" }}>KOT</div>
                            <div style={{ fontWeight: 800, color: AMBER, fontSize: 10, textAlign: "right" }}>VOIDED</div>
                            <div style={{ fontWeight: 800, color: "rgba(255,255,255,.5)", fontSize: 10, textAlign: "right" }}>EXPECTED</div>
                            <div style={{ fontWeight: 800, color: "rgba(255,255,255,.5)", fontSize: 10, textAlign: "right" }}>BILLED</div>
                            <div style={{ fontWeight: 800, color: vColor, fontSize: 10, textAlign: "right" }}>DIFF ₹</div>
                            {r.itemDiffs.map((d, i) => {
                              const dColor = d.diffValue > 0 ? RED : d.diffValue < 0 ? ORANGE : GREEN;
                              return (
                                <Fragment key={i}>
                                  <div style={{ color: "#fff" }}>{d.name}</div>
                                  <div style={{ textAlign: "right", color: "rgba(255,255,255,.6)" }}>₹{d.unitPrice.toLocaleString()}</div>
                                  <div style={{ textAlign: "right" }}>{d.kotQty}</div>
                                  <div style={{ textAlign: "right", color: d.voidQty > 0 ? AMBER : "rgba(255,255,255,.3)" }}>{d.voidQty || "—"}</div>
                                  <div style={{ textAlign: "right", color: "rgba(255,255,255,.7)" }}>{d.expectedBillQty}</div>
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

      <div style={{ marginTop: 10, fontSize: 10, color: "rgba(255,255,255,.4)" }}>
        Tip: filter by 🟠 / 🔴 then export to share with your accountant. Aggregator-paid amounts are matched from the Zomato email-parser (orphanZomatoPayments) by phone — verify before reconciling.
      </div>
    </div>
  );
}

function Tile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ padding: 12, borderRadius: 10, background: `linear-gradient(135deg, ${color}1a, ${color}0a)`, border: `1px solid ${color}55` }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,.65)", letterSpacing: ".5px" }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 20, fontWeight: 900, color, marginTop: 4 }}>{value}</div>
    </div>
  );
}
