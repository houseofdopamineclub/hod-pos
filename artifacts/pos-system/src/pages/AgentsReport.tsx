// ─────────────────────────────────────────────────────────────────────
// 🆕 2026-06-05 — AGENTS REPORT (Boss Mode → Agents tab)
// Per-agent performance for DOOR, BAR and CAPTAIN modes, scoped to one
// operational night. Every metric is attributed to the staffer who
// performed the action (the name stamped on the underlying Firestore doc)
// and displayed with their EMPLOYEE ID (mapped from the staff roster).
//
// ATTRIBUTION (the field that records WHO did each action):
//  • DOOR    — covers.activatedBy (check-in scan + cover activated),
//              tableReservations.createdBy (tables created at the door),
//              tableReservations.cancelledBy (bookings cancelled).
//  • BAR     — cover.transactions[].staff (recharge `*_topup` / redeem
//              `activate`), cover.activatedBy for walkin_bar covers,
//              cover.walletBillPrintLog[].by (reprints + discount),
//              cover.billVoidedBy (void bills), billDue.clearedBy (NC
//              discount — the leak this report also surfaces).
//  • CAPTAIN — tableReservations.captainName (handled + billed + discount
//              + SC + tax), voidLog[].by (void bills), cancelledBy.
//
// SCOPE: bar covers (!isTableBooking) are attributed under BAR; table
// covers feed CAPTAIN via the reservation. Door check-in covers are bar/
// table-agnostic entry covers (not walkin_bar, not table) attributed by
// activatedBy = the door staffer who scanned them in.
//
// ⚠️ LIMITS (told to Khushi): discount / SC / tax persist only from
// v3.224+ (older bills count 0 in those columns); a captain hand-off
// without a formal reassignment credits only the FINAL captainName.
// ─────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { useStaff } from "@/lib/staff-context";
import {
  subscribeToCoversForNight, subscribeToHodReservations, subscribeToTableHistory,
  computeHodBreakdown, computeHodBreakdownAdjusted,
  type HodCover, type HodTableReservation,
} from "@/lib/firestore-hod";
import { subscribeBillDue, fetchBillDueForNight, type BillDueDoc } from "@/lib/bill-due";
import { getOperationalNightStr } from "@/lib/utils-pos";

// ── helpers ───────────────────────────────────────────────────────────
const fmtRs = (n: number) => "₹" + Math.round(n || 0).toLocaleString("en-IN");
const fmtN = (n: number) => (n || 0).toLocaleString("en-IN");
// 🆕 2026-07-01 (Khushi) — compact duration for the captain "Avg Settle" col.
const fmtDur = (ms: number) => {
  if (!ms || ms < 0 || !isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), ss = s % 60;
  if (m < 60) return ss ? `${m}m ${ss}s` : `${m}m`;
  const h = Math.floor(m / 60), mm = m % 60;
  return `${h}h ${mm}m`;
};
// Normalize an actor name for grouping: drop a trailing "(...)" suffix
// (e.g. "Aman (bar wallet open)") and collapse whitespace.
const normName = (s?: string) => (s || "").replace(/\s*\(.*?\)\s*$/, "").replace(/\s+/g, " ").trim();
const keyName = (s?: string) => normName(s).toLowerCase();

const nextDayStr = (d: string) => {
  const dt = new Date(d + "T12:00:00");
  if (isNaN(dt.getTime())) return d;
  dt.setDate(dt.getDate() + 1);
  return dt.toISOString().slice(0, 10);
};
const mergeById = <T extends { _docId?: string; id?: string }>(a: T[], b: T[]): T[] => {
  const m = new Map<string, T>();
  for (const x of [...a, ...b]) {
    const k = (x as any)._docId || (x as any).id || JSON.stringify(x);
    m.set(k, x);
  }
  return Array.from(m.values());
};

// Per-agent metric buckets ----------------------------------------------
interface DoorAgg {
  scanned: number;
  covCount: number; covAmt: number;
  tables: number; wTable: number; wAggr: number; wCorp: number;
  cancCount: number; cancAmt: number;
}
interface BarAgg {
  rcCount: number; rcAmt: number;
  rdCount: number; rdAmt: number;
  wiCount: number; wiAmt: number;
  reprints: number;
  discCount: number; discAmt: number;
  voidCount: number; voidAmt: number;
}
interface CapAgg {
  // #1 tables handled (every non-cancelled deduped table with this captainName).
  handled: number;
  // #4/#7 BILLED = settled AT THE TABLE. Excludes bill-due ₹0 moves + comps so
  // the ₹ is real money the captain actually collected.
  billCount: number; billAmt: number;
  // #3 AMOUNT SPENT (gross consumption = subtotal+SC+tax) + #5 NET (subtotal−disc).
  // Mirrors venue-sales tableGross / tableNet so Agents reconciles with the Boss
  // Sales dashboard. Accrues on every non-cancelled table (settled or open).
  grossAmt: number; netAmt: number;
  // #2 DISCOUNT split — IN-HOUSE vs AGGREGATOR, each with a ₹ value AND an
  // effective % (amt / base × 100, base = the gross the discount applied to).
  discInAmt: number; discInBase: number;
  discAggAmt: number; discAggBase: number;
  // Legacy combined discount count/₹ (kept for continuity; = in-house + comp).
  discCount: number; discAmt: number;
  sc: number; tax: number;
  // #6 PAID BY tender — cash / card / UPI actually collected at the table
  // (in-house, non-comp only; wallet slice excluded — see walletAmt).
  cashAmt: number; cardAmt: number; upiAmt: number;
  // #8 UNBILLED — tables still OPEN (handled, not settled, not cancelled); ₹ is
  // the estimated running bill (subtotal+SC+tax−disc).
  unbilledCount: number; unbilledAmt: number;
  // #10 BILL DUE — settled by moving to a staff friends&family tab (movedToBillDue,
  // settled later via salary); kept OUT of billCount/billAmt so table money is clean.
  billDueCount: number; billDueAmt: number;
  // #11 WALLET REDEEMED — the pre-loaded cover slice used on this table's bill.
  walletCount: number; walletAmt: number;
  // #9 voids (whole-bill + item-level) …
  voidCount: number; voidAmt: number;
  // 🆕 2026-07-01 (Khushi) — LEAKAGE: whole-bill voids ONLY (kind "bill-void" —
  // a printed bill the customer refused to pay / was written off). Distinct from
  // voidCount/voidAmt above which ALSO folds in item-level voids. This is the
  // pure money-lost figure Khushi asked to surface per captain.
  leakCount: number; leakAmt: number;
  // 🆕 2026-07-01 (Khushi) — #12 settle SPEED: how long from a guest requesting
  // the bill (billRequestedAt, stamped when the customer taps "Call Captain to
  // Settle") to the captain actually marking it paid (paidAt). Averaged per
  // captain across their settled tables that carry BOTH timestamps.
  settleMsSum: number; settleCount: number;
}
const zeroDoor = (): DoorAgg => ({ scanned: 0, covCount: 0, covAmt: 0, tables: 0, wTable: 0, wAggr: 0, wCorp: 0, cancCount: 0, cancAmt: 0 });
const zeroBar = (): BarAgg => ({ rcCount: 0, rcAmt: 0, rdCount: 0, rdAmt: 0, wiCount: 0, wiAmt: 0, reprints: 0, discCount: 0, discAmt: 0, voidCount: 0, voidAmt: 0 });
const zeroCap = (): CapAgg => ({ handled: 0, billCount: 0, billAmt: 0, grossAmt: 0, netAmt: 0, discInAmt: 0, discInBase: 0, discAggAmt: 0, discAggBase: 0, discCount: 0, discAmt: 0, sc: 0, tax: 0, cashAmt: 0, cardAmt: 0, upiAmt: 0, unbilledCount: 0, unbilledAmt: 0, billDueCount: 0, billDueAmt: 0, walletCount: 0, walletAmt: 0, voidCount: 0, voidAmt: 0, leakCount: 0, leakAmt: 0, settleMsSum: 0, settleCount: 0 });

// #6 tender bucketing (mirrors venue-sales tenderKey) — cash / card / UPI only;
// 'other' (online/razorpay etc.) is not shown in the per-captain tender cols.
const addCapTender = (v: CapAgg, method: string, amt: number) => {
  if (!(amt > 0)) return;
  const m = (method || "").toLowerCase();
  if (m.includes("cash")) v.cashAmt += amt;
  else if (m.includes("card")) v.cardAmt += amt;
  else if (m.includes("upi")) v.upiAmt += amt;
};
// Effective discount % for a value/base pair.
const fmtPct = (amt: number, base: number) => (base > 0 ? `${(amt / base * 100).toFixed(1)}%` : "0%");

function ensure<T>(map: Map<string, { name: string; v: T }>, name: string, zero: () => T) {
  const k = keyName(name);
  if (!k) return null;
  let e = map.get(k);
  if (!e) { e = { name: normName(name), v: zero() }; map.set(k, e); }
  return e.v;
}

// Classify a door/captain-created reservation into a walk-in bucket.
const isAggregatorRes = (r: HodTableReservation) =>
  !!(r.aggregator && r.aggregator !== "inhouse") || (r.source || "").toLowerCase() === "zomato" ||
  /swiggy|zomato|eazydiner|magicpin|dineout/i.test((r.source || "")) || (r as any).isManualAggregatorEntry === true;
const isCorporateRes = (r: HodTableReservation) =>
  (r.source || "").toLowerCase() === "corporate" || !!(r.companyName && r.companyName.trim());

// Mirror venue-sales.isInhouse EXACTLY so the captain money split (discount +
// tender) reconciles with the Boss → Sales dashboard. A booking is IN-HOUSE
// unless its aggregator/source names a platform or is an unknown non-empty
// source. (Do NOT reuse isAggregatorRes here — that classifies unknown sources
// as in-house, the OPPOSITE of the dashboard, and would skew the split.)
const isInhouseRes = (r: HodTableReservation): boolean => {
  const s = (((r as any).aggregator || r.source || "") + "").toLowerCase();
  if (/swiggy|zomato|eazydiner|eazydinner/.test(s)) return false;
  return s === "" || s === "inhouse" || s === "in-house" || s === "corporate" || s === "walkin" || s === "walk-in";
};

const isWalkinBarCover = (c: HodCover) =>
  String((c as any).source || "").toLowerCase().startsWith("walkin_bar") ||
  String((c as any).paymentId || "").toLowerCase().startsWith("walkin_bar");

export default function AgentsReport() {
  const { allStaff } = useStaff();
  const [night, setNight] = useState<string>(() => getOperationalNightStr());
  const [covers, setCovers] = useState<HodCover[]>([]);
  const [reservations, setReservations] = useState<HodTableReservation[]>([]);
  // 🆕 2026-07-01 (Khushi) — RELEASED tables. releaseTable() archives a settled
  // table to `tableHistory` and DELETES the live doc, so a report reading only
  // live `tableReservations` LOSES every captain's settled bills the moment the
  // table is released — the "data not replicating" bug. Read history too and
  // merge (deduped) into the captain aggregation, exactly like venue-sales.
  const [history, setHistory] = useState<HodTableReservation[]>([]);
  const [ncRows, setNcRows] = useState<BillDueDoc[]>([]);
  const [loading, setLoading] = useState(true);

  const nextDay = useMemo(() => nextDayStr(night), [night]);

  // empId lookup by normalized name.
  const empIdByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of allStaff) {
      if (s.name && s.id) m.set(keyName(s.name), s.id);
    }
    return m;
  }, [allStaff]);
  // Role set per staffer (primary role + extra access levels) — used to keep a
  // CAPTAIN-only staffer's table creations OUT of the DOOR section (createdBy
  // is stamped by both door AND captain walk-in flows, so name alone is not
  // enough to tell which mode created a table).
  const rolesByName = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const s of allStaff) {
      if (!s.name) continue;
      const set = new Set<string>();
      if (s.role) set.add(String(s.role).toLowerCase());
      for (const r of ((s as any).roles || [])) set.add(String(r).toLowerCase());
      m.set(keyName(s.name), set);
    }
    return m;
  }, [allStaff]);
  // A creator is "captain-only" when they hold the captain role but none of the
  // door-side roles (hostess / admin / manager). Their createWalkInTable/
  // createProxyTable rows are captain work, not door work.
  const isCaptainOnly = (name: string) => {
    const set = rolesByName.get(keyName(name));
    if (!set || set.size === 0) return false;
    return set.has("captain") && !set.has("hostess") && !set.has("admin") && !set.has("manager");
  };
  const labelFor = (name: string) => {
    const id = empIdByName.get(keyName(name));
    return id ? `${id} · ${name}` : name;
  };

  // Covers (night + nextDay for events that straddle the 7AM rollover).
  useEffect(() => {
    setLoading(true);
    let a: HodCover[] = [], b: HodCover[] = [];
    const apply = () => setCovers(mergeById(a as any, b as any));
    let u1: (() => void) | undefined, u2: (() => void) | undefined;
    try {
      u1 = subscribeToCoversForNight(night, (cs) => { a = cs || []; apply(); setLoading(false); });
      u2 = subscribeToCoversForNight(nextDay, (cs) => { b = cs || []; apply(); });
    } catch { setCovers([]); setLoading(false); }
    return () => { try { u1 && u1(); } catch {} try { u2 && u2(); } catch {} };
  }, [night, nextDay]);

  // Reservations (night + nextDay).
  useEffect(() => {
    let a: HodTableReservation[] = [], b: HodTableReservation[] = [];
    const apply = () => setReservations(mergeById(a, b));
    let u1: (() => void) | undefined, u2: (() => void) | undefined;
    try {
      u1 = subscribeToHodReservations(night, (r) => { a = r || []; apply(); });
      u2 = subscribeToHodReservations(nextDay, (r) => { b = r || []; apply(); });
    } catch { setReservations([]); }
    return () => { try { u1 && u1(); } catch {} try { u2 && u2(); } catch {} };
  }, [night, nextDay]);

  // Released tables (tableHistory, night + nextDay) — same shape as reservations.
  useEffect(() => {
    let a: HodTableReservation[] = [], b: HodTableReservation[] = [];
    const apply = () => setHistory(mergeById(a, b));
    let u1: (() => void) | undefined, u2: (() => void) | undefined;
    try {
      u1 = subscribeToTableHistory(night, (r) => { a = r || []; apply(); });
      u2 = subscribeToTableHistory(nextDay, (r) => { b = r || []; apply(); });
    } catch { setHistory([]); }
    return () => { try { u1 && u1(); } catch {} try { u2 && u2(); } catch {} };
  }, [night, nextDay]);

  // NC ledger — live subscribe for tonight, one-shot fetch for past nights.
  useEffect(() => {
    const today = getOperationalNightStr();
    if (night === today) {
      let unsub: (() => void) | undefined;
      try { unsub = subscribeBillDue(setNcRows); } catch { setNcRows([]); }
      return () => { try { unsub && unsub(); } catch {} };
    }
    let alive = true;
    fetchBillDueForNight(night).then((rows) => { if (alive) setNcRows(rows); }).catch(() => { if (alive) setNcRows([]); });
    return () => { alive = false; };
  }, [night]);

  // ── AGGREGATION ─────────────────────────────────────────────────────
  const { doorRows, barRows, capRows } = useMemo(() => {
    const door = new Map<string, { name: string; v: DoorAgg }>();
    const bar = new Map<string, { name: string; v: BarAgg }>();
    const cap = new Map<string, { name: string; v: CapAgg }>();

    // ---- COVERS → DOOR (entry covers) + BAR (transactions / bills) ----
    for (const c of covers) {
      const isTable = !!c.isTableBooking;
      const barWalkin = isWalkinBarCover(c);

      // DOOR: entry covers = non-table, non-bar-walkin. activatedBy = the
      // door staffer who scanned the guest in.
      if (!isTable && !barWalkin && c.activatedBy) {
        const d = ensure(door, c.activatedBy, zeroDoor);
        if (d) {
          d.scanned += 1;
          if ((c.coverActivated || 0) > 0) { d.covCount += 1; d.covAmt += c.coverActivated || 0; }
        }
      }

      // BAR: recharge / redeem transactions (any cover that saw bar txns).
      for (const tx of (c.transactions || [])) {
        if (!tx || !tx.staff) continue;
        if (typeof tx.type === "string" && tx.type.endsWith("_topup")) {
          const v = ensure(bar, tx.staff, zeroBar);
          if (v) { v.rcCount += 1; v.rcAmt += tx.amount || 0; }
        } else if (tx.type === "activate") {
          const v = ensure(bar, tx.staff, zeroBar);
          if (v) { v.rdCount += 1; v.rdAmt += tx.amount || 0; }
        }
      }

      // BAR: walk-ins CREATED at the bar (activatedBy stamps the creator).
      if (barWalkin && c.activatedBy) {
        const v = ensure(bar, c.activatedBy, zeroBar);
        if (v) { v.wiCount += 1; v.wiAmt += c.coverActivated || 0; }
      }

      // BAR: reprints + discount from walletBillPrintLog. Reprints =
      // duplicate entries. Discount = the LATEST non-duplicate bill per
      // cover (running tabs re-print the full bill each round, so summing
      // every entry would double-count — same rule the Live Reports use).
      const log = c.walletBillPrintLog || [];
      let barDiscCaptured = false;
      let barBillActor = "";
      if (log.length) {
        for (const b of log) {
          if (b?.isDuplicate && b.by) {
            const v = ensure(bar, b.by, zeroBar);
            if (v) v.reprints += 1;
          }
        }
        const nonDup = log.filter((b) => !b.isDuplicate);
        if (nonDup.length) {
          const atMs = (b: any) => { const t = new Date(b?.at || 0).getTime(); return isNaN(t) ? 0 : t; };
          const last = nonDup.reduce((p, q) => (atMs(q) >= atMs(p) ? q : p));
          if (last.by) barBillActor = last.by;
          if ((last.discount || 0) > 0 && last.by) {
            const v = ensure(bar, last.by, zeroBar);
            if (v) { v.discCount += 1; v.discAmt += last.discount || 0; }
            barDiscCaptured = true;
          }
        }
      }

      // 🆕 2026-06-28 (Khushi) — BAR discount FALLBACK. The print-log block
      // above only counts a discount that rode a PRINTED non-duplicate bill.
      // But a bartender can apply a discount and then settle by wallet
      // redemption WITHOUT a fresh bill print — the % still persists on the
      // cover (billDiscountPct via setCoverBillDiscount) yet no print-log entry
      // carries the ₹ value, so the discount silently read ₹0 in this report
      // (Khushi: "I gave a bar discount today, I don't see it here"). When the
      // print-log path captured nothing AND billDiscountPct>0, recompute the ₹
      // discount from the cover's own tab items with the SAME bill math the bar
      // uses, so the figure matches the wallet. Gated to BAR covers (!isTable)
      // so table discounts (counted under CAPTAIN via reservation) never
      // double-count here.
      if (!isTable && !barDiscCaptured) {
        const pct = Number((c as any).billDiscountPct) || 0;
        if (pct > 0) {
          const rounds = Array.isArray(c.tabRounds) ? c.tabRounds : [];
          const items = rounds
            .filter((rd) => rd && rd.status !== "preparing")
            .flatMap((rd) => (Array.isArray(rd.items) ? rd.items : []));
          if (items.length) {
            const scOn = (c as any).billScOn !== false;
            const disc = computeHodBreakdownAdjusted(items, pct, scOn).discount || 0;
            const actor = barBillActor || c.activatedBy ||
              (rounds.length ? (rounds[rounds.length - 1].activatedBy || rounds[rounds.length - 1].placedBy) : "") || "";
            if (disc > 0 && actor) {
              const v = ensure(bar, actor, zeroBar);
              if (v) { v.discCount += 1; v.discAmt += disc; }
            }
          }
        }
      }

      // BAR: void bills (cover-level void via voidWalletBill).
      if ((c as any).billVoided && (c as any).billVoidedBy) {
        const v = ensure(bar, (c as any).billVoidedBy, zeroBar);
        if (v) { v.voidCount += 1; v.voidAmt += (c as any).voidedBillTotal || 0; }
      }
    }

    // ---- BILL DUE (NC) → BAR discount (the leak) ----
    const nc = ncRows.filter((r) => r.operationalNight === night);
    for (const r of nc) {
      const disc = typeof r.finalAmount === "number" ? Math.max(0, (r.amountDue || 0) - r.finalAmount) : 0;
      if (disc > 0) {
        const actor = r.clearedBy || r.staff || "";
        const v = ensure(bar, actor, zeroBar);
        if (v) { v.discCount += 1; v.discAmt += disc; }
      }
    }

    // ---- RESERVATIONS → DOOR (created/cancelled) + CAPTAIN ----
    for (const r of reservations) {
      const createdBy = (r as any).createdBy as string | undefined;
      const cancelledBy = (r as any).cancelledBy as string | undefined;
      const isCancelled = (r.status || "").toLowerCase() === "cancelled";

      // DOOR: tables created at the door (createdBy stamps the creator).
      // EXCLUDE proxy/placeholder tables (unambiguously captain-side) and
      // tables created by a captain-only staffer (createdBy is shared by the
      // captain walk-in flow, so those are captain work, not door work).
      if (createdBy && !(r as any).isProxy && !isCaptainOnly(createdBy)) {
        const d = ensure(door, createdBy, zeroDoor);
        if (d) {
          d.tables += 1;
          if (isCorporateRes(r)) d.wCorp += 1;
          else if (isAggregatorRes(r)) d.wAggr += 1;
          else d.wTable += 1;
        }
      }

      // DOOR: bookings cancelled.
      if (isCancelled && cancelledBy) {
        const d = ensure(door, cancelledBy, zeroDoor);
        if (d) {
          d.cancCount += 1;
          d.cancAmt += (r.amountPaid || 0) || (r.advanceAmount || 0);
        }
      }

      // (Cancellations are reported ONCE — under DOOR, by cancelledBy. A single
      // cancel event has a single canceller, so attributing it to both DOOR and
      // CAPTAIN would double-show the same event; DOOR owns bookings/cancels.)
    }

    // ---- CAPTAIN — the full per-captain money breakdown (by captainName) ----
    // Runs over LIVE reservations ∪ RELEASED history, DEDUPED exactly like
    // venue-sales.processRes so a released table never double-counts and a
    // settled+released table is not lost. All bill math mirrors venue-sales so
    // the Agents figures reconcile with the Boss Sales dashboard. READ-ONLY.
    const seenCap = new Set<string>();
    for (const r of [...reservations, ...history]) {
      const isCancelled = (r.status || "").toLowerCase() === "cancelled";
      if (isCancelled) continue;
      const dedupeKey = r.bookingRef
        ? `ref:${r.bookingRef}`
        : `cmp:${(r.tableId || "").toUpperCase()}|${(r as any).bookedAt || ""}|${r.amountPaid || 0}|${r.arrivalTime || ""}`;
      if (seenCap.has(dedupeKey)) continue;
      seenCap.add(dedupeKey);

      // CAPTAIN voids — whole-bill (kind "bill-void") AND item-level (kind
      // "items-void") voids. Attributed to whoever performed them (e.by), which
      // may differ from captainName; independent of the handled/billed block.
      for (const e of ((r as any).voidLog || [])) {
        if (e && (e.kind === "bill-void" || e.kind === "items-void") && e.by) {
          const vv = ensure(cap, e.by, zeroCap);
          if (vv) {
            vv.voidCount += 1; vv.voidAmt += e.valueLost || 0;
            // A whole-bill void is pure LEAKAGE (customer refused / written off).
            if (e.kind === "bill-void") { vv.leakCount += 1; vv.leakAmt += e.valueLost || 0; }
          }
        }
      }

      const cn = r.captainName;
      if (!cn) continue;
      const v = ensure(cap, cn, zeroCap);
      if (!v) continue;

      // #1 TABLES HANDLED (every non-cancelled deduped table with this captain).
      v.handled += 1;

      // Shared bill math — mirrors venue-sales.processRes EXACTLY.
      const items = (r.tabRounds || []).flatMap((rd) => rd.items || []);
      const bd = computeHodBreakdown(items);
      const subtotal = bd.subtotal;
      const isPaid = (r.paymentStatus || "").toLowerCase() === "paid";
      const isBillDue = !!(r as any).movedToBillDue;
      const inhouse = isInhouseRes(r);       // SAME predicate as venue-sales
      const comp = !!(r as any).complimentary;
      let sc: number, tax: number, disc: number;
      if (isPaid) {
        sc = (r as any).serviceChargeAmount || 0;
        tax = r.taxAmount || 0;
        disc = r.discountAmount || 0;
      } else {
        sc = bd.serviceCharge; tax = bd.gst;
        disc = (r.discountAmount || 0) > 0 ? (r.discountAmount || 0) : subtotal * ((r.discountPercent || 0) / 100);
      }
      const billFinal = Math.max(0, subtotal + sc + tax - disc);

      // #10 BILL DUE — table moved to a staff friends&family tab (settle via
      // salary). venue-sales EXCLUDES movedToBillDue from table Net/Gross (its
      // consumption accrues on the NC billdue tab instead), so to RECONCILE we
      // record ONLY the captain-only bill-due KPI here and skip all other
      // accrual (gross/net/discount/tender). handled++ already counted it.
      if (isBillDue) {
        v.billDueCount += 1;
        v.billDueAmt += (r as any).billDueValue || billFinal;
        continue;
      }

      // #3 AMOUNT SPENT (gross) + #5 NET — accrual value (mirrors tableGross/Net).
      v.grossAmt += subtotal + sc + tax;
      v.netAmt += Math.max(0, subtotal - disc);
      // #(SC/tax) — use the SAME paid-vs-open branch value as venue-sales, not
      // the persisted field only (open tables have no persisted SC/tax yet).
      v.sc += sc;
      v.tax += tax;

      // #2 DISCOUNT split — IN-HOUSE vs AGGREGATOR (value + base for the %).
      if (!inhouse) {
        let aggDisc = disc;
        let aggBase = subtotal + sc + tax;
        if (isPaid) {
          const aggGross = (r as any).aggregatorGrossAmount || ((r.amountPaid || 0) || billFinal);
          const aggNet = (r as any).aggregatorNetAmount ?? (r.amountPaid ?? aggGross);
          aggDisc = Math.max(0, aggGross - aggNet);
          aggBase = aggGross;
        }
        if (aggDisc > 0) { v.discAggAmt += aggDisc; v.discAggBase += aggBase; }
      } else {
        // in-house discount = explicit discount + comp-to-₹0 (a 100% discount).
        const compVal = (r as any).complimentaryValue || 0;
        const inDisc = disc + compVal;
        if (inDisc > 0) { v.discInAmt += inDisc; v.discInBase += subtotal + sc + tax; }
      }
      // Legacy combined discount count/₹ (continuity with the old column).
      if ((r.discountAmount || 0) > 0) { v.discCount += 1; v.discAmt += r.discountAmount || 0; }
      if (((r as any).complimentaryValue || 0) > 0) { v.discCount += 1; v.discAmt += (r as any).complimentaryValue || 0; }

      // Settlement buckets.
      if (isPaid) {
        // #4/#7 BILLED / SETTLED at the table (real money collected). Mirror
        // venue-sales `realized = amountPaid || billFinal`; a comp bill collects
        // ₹0 at the table (its written-off value shows under discount).
        v.billCount += 1;
        v.billAmt += comp ? 0 : ((r.amountPaid || 0) || billFinal);
        // #12 settle SPEED — needs BOTH billRequestedAt (guest asked) and paidAt.
        const reqStr = (r as any).billRequestedAt, paidStr = (r as any).paidAt;
        if (reqStr && paidStr) {
          const reqMs = new Date(reqStr).getTime(), paidMs = new Date(paidStr).getTime();
          if (isFinite(reqMs) && isFinite(paidMs) && paidMs > reqMs) { v.settleMsSum += (paidMs - reqMs); v.settleCount += 1; }
        }
        // #11 WALLET REDEEMED — the pre-loaded cover slice used on this bill.
        const wal = (r as any).walletPaidAmount ||
          (Array.isArray((r as any).walletRedemptions) ? (r as any).walletRedemptions.reduce((s: number, x: any) => s + (x?.amount || 0), 0) : 0);
        if (wal > 0) { v.walletCount += 1; v.walletAmt += wal; }
        // #6 CASH / CARD / UPI — in-house, non-comp fresh tender only (mirror
        // venue-sales: aggregator + comp settle elsewhere; wallet slice was
        // already tendered at wallet-LOADING time, so only `direct` is fresh).
        if (!comp && inhouse) {
          const walletSlice = (r as any).walletPaidAmount || 0;
          const direct = Math.max(0, (r.amountPaid || 0) - walletSlice);
          const splits = (r as any).paymentSplits as Array<{ method: string; amount: number }> | undefined;
          if (splits && splits.length) {
            const sum = splits.reduce((s, sp) => s + (sp.amount || 0), 0);
            const f = sum > 0 ? direct / sum : 0;
            for (const sp of splits) addCapTender(v, sp.method, (sp.amount || 0) * f);
          } else if (direct > 0) {
            addCapTender(v, r.paymentMode || "", direct);
          }
        }
      } else {
        // #8 UNBILLED — table still OPEN (handled, not settled).
        if (subtotal > 0 || billFinal > 0) { v.unbilledCount += 1; v.unbilledAmt += billFinal; }
      }
    }

    const sortRows = <T,>(m: Map<string, { name: string; v: T }>) =>
      Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
    return { doorRows: sortRows(door), barRows: sortRows(bar), capRows: sortRows(cap) };
  }, [covers, reservations, history, ncRows, night, rolesByName]);

  // ── CSV ─────────────────────────────────────────────────────────────
  const downloadCsv = () => {
    const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines: string[] = [];
    lines.push(`HOD Agents Report,${esc(night)}`);
    lines.push("");
    lines.push("DOOR AGENTS");
    lines.push(["Employee", "Scanned", "Covers Activated (#)", "Covers Activated (Rs)", "Tables Booked", "Walk-in Tables", "Walk-in Aggregators", "Walk-in Corporate", "Bookings Cancelled (#)", "Bookings Cancelled (Rs)"].join(","));
    for (const { name, v } of doorRows) lines.push([labelFor(name), v.scanned, v.covCount, Math.round(v.covAmt), v.tables, v.wTable, v.wAggr, v.wCorp, v.cancCount, Math.round(v.cancAmt)].map(esc).join(","));
    lines.push("");
    lines.push("BAR AGENTS");
    lines.push(["Employee", "Recharged (#)", "Recharged (Rs)", "Redeemed (#)", "Redeemed (Rs)", "Walk-ins (#)", "Walk-ins (Rs)", "Bills Reprinted", "Discount (#)", "Discount (Rs)", "Void Bills (#)", "Void Bills (Rs)"].join(","));
    for (const { name, v } of barRows) lines.push([labelFor(name), v.rcCount, Math.round(v.rcAmt), v.rdCount, Math.round(v.rdAmt), v.wiCount, Math.round(v.wiAmt), v.reprints, v.discCount, Math.round(v.discAmt), v.voidCount, Math.round(v.voidAmt)].map(esc).join(","));
    lines.push("");
    lines.push("CAPTAIN AGENTS");
    lines.push([
      "Employee", "Tables Handled",
      "Amount Spent / Gross (Rs)", "Net Amount (Rs)",
      "Billed / Settled (#)", "Billed / Settled (Rs)",
      "Unbilled / Open (#)", "Unbilled / Open (Rs)",
      "Bill Due — Staff Tab (#)", "Bill Due — Staff Tab (Rs)",
      "Wallet Redeemed (#)", "Wallet Redeemed (Rs)",
      "Cash (Rs)", "Card (Rs)", "UPI (Rs)",
      "In-house Discount (Rs)", "In-house Discount (%)",
      "Aggregator Discount (Rs)", "Aggregator Discount (%)",
      "Service Charge (Rs)", "Tax (Rs)",
      "Voids (#)", "Voids (Rs)", "Voided Bills (#)", "Leakage (Rs)",
      "Avg Settle Time", "Settle Samples (#)",
    ].join(","));
    for (const { name, v } of capRows) lines.push([
      labelFor(name), v.handled,
      Math.round(v.grossAmt), Math.round(v.netAmt),
      v.billCount, Math.round(v.billAmt),
      v.unbilledCount, Math.round(v.unbilledAmt),
      v.billDueCount, Math.round(v.billDueAmt),
      v.walletCount, Math.round(v.walletAmt),
      Math.round(v.cashAmt), Math.round(v.cardAmt), Math.round(v.upiAmt),
      Math.round(v.discInAmt), fmtPct(v.discInAmt, v.discInBase),
      Math.round(v.discAggAmt), fmtPct(v.discAggAmt, v.discAggBase),
      Math.round(v.sc), Math.round(v.tax),
      v.voidCount, Math.round(v.voidAmt), v.leakCount, Math.round(v.leakAmt),
      v.settleCount > 0 ? fmtDur(v.settleMsSum / v.settleCount) : "", v.settleCount,
    ].map(esc).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `HOD_Agents_${night}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── RENDER ──────────────────────────────────────────────────────────
  const C = { ink: "#000", grey: "#6B6B6B", bg: "#F4F4F0", card: "#fff" };
  const NUM_FONT = "'Space Grotesk', sans-serif";

  const Cell = ({ children, bold, num }: { children: React.ReactNode; bold?: boolean; num?: boolean }) => (
    <td style={{ padding: "9px 11px", fontSize: 13, fontWeight: bold ? 900 : 700, color: C.ink, fontFamily: num ? NUM_FONT : undefined, whiteSpace: "nowrap", borderTop: `1px solid ${C.ink}` }}>{children}</td>
  );
  const Th = ({ children }: { children: React.ReactNode }) => (
    <th style={{ padding: "9px 11px", fontSize: 10.5, fontWeight: 800, color: C.grey, letterSpacing: 0.6, textTransform: "uppercase", textAlign: "left", whiteSpace: "nowrap" }}>{children}</th>
  );

  const Section = ({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) => (
    <div style={{ background: C.card, border: `2px solid ${C.ink}`, borderRadius: 14, padding: 16, marginBottom: 18, overflowX: "auto" }}>
      <div style={{ fontSize: 16, fontWeight: 900, color: C.ink, letterSpacing: 0.4 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: C.grey, fontWeight: 700, marginBottom: 12 }}>{hint}</div>
      {children}
    </div>
  );
  const EmptyRow = ({ cols }: { cols: number }) => (
    <tr><td colSpan={cols} style={{ padding: "18px 11px", fontSize: 13, fontWeight: 700, color: C.grey, textAlign: "center" }}>No activity recorded for this night.</td></tr>
  );

  return (
    <div style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
      {/* HEADER */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        <div style={{ fontSize: 22, fontWeight: 900, color: C.ink, letterSpacing: 0.4 }}>👥 AGENTS — PER-STAFF REPORTS</div>
      </div>
      <div style={{ fontSize: 12, color: C.grey, fontWeight: 700, marginBottom: 14 }}>
        One operational night · attributed to the staffer who performed each action · Employee ID shown with name.
      </div>

      {/* CONTROLS */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <label style={{ fontSize: 12, fontWeight: 800, color: C.ink, letterSpacing: 0.5 }}>NIGHT</label>
        <input type="date" value={night} onChange={(e) => setNight(e.target.value || getOperationalNightStr())}
          style={{ padding: "9px 12px", borderRadius: 8, background: C.card, border: `2px solid ${C.ink}`, color: C.ink, fontSize: 13, fontWeight: 700, outline: "none" }} />
        <div style={{ flex: 1 }} />
        <button onClick={downloadCsv}
          style={{ padding: "10px 18px", borderRadius: 8, background: C.ink, border: `2px solid ${C.ink}`, color: "#fff", fontSize: 13, fontWeight: 900, letterSpacing: 0.6, cursor: "pointer", whiteSpace: "nowrap" }}>
          ⬇ DOWNLOAD CSV
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: C.grey, fontSize: 16, fontWeight: 700 }}>Loading this night's numbers…</div>
      ) : (
        <>
          {/* DOOR */}
          <Section title="🚪 DOOR AGENTS" hint="Wallets scanned in · covers activated · tables created at the door (broken down by type) · bookings cancelled.">
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 760 }}>
              <thead><tr style={{ background: C.bg }}>
                <Th>Employee</Th><Th>Scanned</Th><Th>Covers Activated</Th><Th>Tables Booked</Th>
                <Th>↳ Tables</Th><Th>↳ Aggregators</Th><Th>↳ Corporate</Th><Th>Bookings Cancelled</Th>
              </tr></thead>
              <tbody>
                {doorRows.length === 0 ? <EmptyRow cols={8} /> : doorRows.map(({ name, v }) => (
                  <tr key={name}>
                    <Cell bold>{labelFor(name)}</Cell>
                    <Cell num>{fmtN(v.scanned)}</Cell>
                    <Cell num>{fmtN(v.covCount)} · {fmtRs(v.covAmt)}</Cell>
                    <Cell num bold>{fmtN(v.tables)}</Cell>
                    <Cell num>{fmtN(v.wTable)}</Cell>
                    <Cell num>{fmtN(v.wAggr)}</Cell>
                    <Cell num>{fmtN(v.wCorp)}</Cell>
                    <Cell num>{fmtN(v.cancCount)} · {fmtRs(v.cancAmt)}</Cell>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          {/* BAR */}
          <Section title="🍸 BAR / CASHIER AGENTS" hint="Wallet recharges · redemptions · bar walk-ins created · bill reprints · discount applied (incl. NC tabs) · void bills.">
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 820 }}>
              <thead><tr style={{ background: C.bg }}>
                <Th>Employee</Th><Th>Recharged</Th><Th>Redeemed</Th><Th>Walk-ins</Th>
                <Th>Reprints</Th><Th>Discount</Th><Th>Void Bills</Th>
              </tr></thead>
              <tbody>
                {barRows.length === 0 ? <EmptyRow cols={7} /> : barRows.map(({ name, v }) => (
                  <tr key={name}>
                    <Cell bold>{labelFor(name)}</Cell>
                    <Cell num>{fmtN(v.rcCount)} · {fmtRs(v.rcAmt)}</Cell>
                    <Cell num>{fmtN(v.rdCount)} · {fmtRs(v.rdAmt)}</Cell>
                    <Cell num>{fmtN(v.wiCount)} · {fmtRs(v.wiAmt)}</Cell>
                    <Cell num>{fmtN(v.reprints)}</Cell>
                    <Cell num>{fmtN(v.discCount)} · {fmtRs(v.discAmt)}</Cell>
                    <Cell num>{fmtN(v.voidCount)} · {fmtRs(v.voidAmt)}</Cell>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          {/* CAPTAIN */}
          <Section title="🧑‍🍳 CAPTAIN AGENTS" hint="Full per-captain breakdown — tables handled · amount spent (gross) · net · billed/settled · unbilled (open) · bill due (staff tab) · wallet redeemed · cash/card/UPI · in-house vs aggregator discount (₹ + %) · SC · tax · voids · leakage · settle speed. Includes RELEASED tables. Scroll sideways for all columns →">
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 1680 }}>
              <thead><tr style={{ background: C.bg }}>
                <Th>Employee</Th><Th>Handled</Th><Th>Amount Spent</Th><Th>Net</Th>
                <Th>Billed / Settled</Th><Th>Unbilled (Open)</Th><Th>Bill Due (Staff)</Th><Th>Wallet Redeemed</Th>
                <Th>Cash</Th><Th>Card</Th><Th>UPI</Th>
                <Th>In-house Disc</Th><Th>Aggregator Disc</Th>
                <Th>Service Charge</Th><Th>Tax</Th><Th>Voids</Th><Th>Voided Bills · Leakage</Th><Th>Avg Settle</Th>
              </tr></thead>
              <tbody>
                {capRows.length === 0 ? <EmptyRow cols={18} /> : capRows.map(({ name, v }) => (
                  <tr key={name}>
                    <Cell bold>{labelFor(name)}</Cell>
                    <Cell num bold>{fmtN(v.handled)}</Cell>
                    <Cell num>{fmtRs(v.grossAmt)}</Cell>
                    <Cell num>{fmtRs(v.netAmt)}</Cell>
                    <Cell num bold>{fmtN(v.billCount)} · {fmtRs(v.billAmt)}</Cell>
                    <Cell num>{v.unbilledCount > 0 ? <span style={{ color: "#B36B00", fontWeight: 900 }}>{fmtN(v.unbilledCount)} · {fmtRs(v.unbilledAmt)}</span> : <span>{fmtN(0)} · {fmtRs(0)}</span>}</Cell>
                    <Cell num>{fmtN(v.billDueCount)} · {fmtRs(v.billDueAmt)}</Cell>
                    <Cell num>{fmtN(v.walletCount)} · {fmtRs(v.walletAmt)}</Cell>
                    <Cell num>{fmtRs(v.cashAmt)}</Cell>
                    <Cell num>{fmtRs(v.cardAmt)}</Cell>
                    <Cell num>{fmtRs(v.upiAmt)}</Cell>
                    <Cell num>{fmtRs(v.discInAmt)} · {fmtPct(v.discInAmt, v.discInBase)}</Cell>
                    <Cell num>{fmtRs(v.discAggAmt)} · {fmtPct(v.discAggAmt, v.discAggBase)}</Cell>
                    <Cell num>{fmtRs(v.sc)}</Cell>
                    <Cell num>{fmtRs(v.tax)}</Cell>
                    <Cell num>{fmtN(v.voidCount)} · {fmtRs(v.voidAmt)}</Cell>
                    <Cell num>{v.leakCount > 0 ? <span style={{ color: "#FF5733", fontWeight: 900 }}>{fmtN(v.leakCount)} · {fmtRs(v.leakAmt)}</span> : <span>{fmtN(0)} · {fmtRs(0)}</span>}</Cell>
                    <Cell num>{v.settleCount > 0 ? `${fmtDur(v.settleMsSum / v.settleCount)} (${fmtN(v.settleCount)})` : "—"}</Cell>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <div style={{ fontSize: 11, color: C.grey, fontWeight: 600, lineHeight: 1.5, marginTop: 4 }}>
            Note: this report now includes RELEASED tables (a table archived to history the moment the captain frees it) so past nights and freed tonight-tables no longer disappear.
            "Amount Spent" = gross consumption (items + service charge + tax, before discount); "Net" = items after discount — both reconcile with the Boss → Sales dashboard. "Billed / Settled" = money actually collected at the table; "Unbilled (Open)" = tables still running (estimated); "Bill Due (Staff)" = tables moved to a staff friends-&-family tab (settled later via salary, kept out of Billed). "Wallet Redeemed" = the pre-loaded cover money used on the bill (its cash/card/UPI is counted when the wallet was loaded, so it is NOT re-counted under Cash/Card/UPI here). "Cash / Card / UPI" = fresh tender collected at the table only.
            "In-house Disc" and "Aggregator Disc" each show ₹ and the effective % (aggregator % = the platform's commission, gross − net). "Voids" = whole-bill + item-level voids; "Voided Bills · Leakage" = whole-bill write-offs only (pure money lost).
            Discount / service-charge / tax persist from v3.224 onward — bills printed before that show ₹0 in those columns. "Avg Settle" = average time from a guest tapping "Call Captain to Settle Bill" to the captain marking it paid (sample count in brackets); only in-app bill requests count, so it can be blank. A table that changed captains mid-shift credits only the final captain on record.
          </div>
        </>
      )}
    </div>
  );
}
