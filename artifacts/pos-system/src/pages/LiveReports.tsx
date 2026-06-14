// ─────────────────────────────────────────────────────────────────────
// 🆕 2026-06-06 — LIVE REPORTS (Boss Mode → Live Reports tab)
// Venue performance for ONE operational night, styled exactly like the
// Door / Bar / Agents reports (white card boxes, 2px black border, NIGHT
// date picker, CSV export). Most metrics are broken down into a small
// table inside the box for all 3 FLOORS: Ground · First · Rooftop.
//
// 🔴 FLOOR MAPPING (Khushi has 4 internal zones, wants 3 floors):
//   ground            → Ground
//   dining + smoking  → First      (smoking zone folded into First)
//   rooftop           → Rooftop
// Change `toFloor3` if smoking should sit under Ground/Rooftop instead.
//
// DATA SOURCES (read-only):
//   • tableReservations (subscribeToHodReservations) — the table bookings:
//     floor, paymentStatus, amountPaid, tabRounds (items), taxAmount,
//     serviceChargeAmount, discountAmount/Percent, captainName, source/
//     aggregator. Item food/drink split via HodOrderItem.t.
//   • covers (subscribeToCoversForNight) — coverUsed = ₹ redeemed from
//     the cover wallet; non-table covers feed the bar side of top-5 items.
//   • tableHistory (subscribeToTableHistory) — RELEASED tables. When the
//     captain taps RELEASE the reservation is archived here and the live
//     tableReservations + covers docs are DELETED, so without this source the
//     money totals (billed/discount/SC/net+gross/cover-wallet) would drop the
//     instant a table is released. Released tables count toward sales but NOT
//     occupancy/LIVE (the table is free again).
//   • Tax math reuses computeHodBreakdown (the app's single source of
//     truth) when a reservation hasn't persisted tax/SC (pre-v3.224).
//
// METRIC DEFINITIONS (shown as the hint under each box so Khushi can see
// exactly what each number means and ask for a tweak):
//   Live tables       — tables with a RUNNING order (≥1 ordered item); a table
//                       that is only booked/assigned with no order is NOT live.
//   Billed amount     — ₹ already collected (paymentStatus = paid).
//   Unbilled amount   — ₹ still open on tables with an OPEN bill (not paid).
//   Discount          — aggregator vs in-house ₹ knocked off the bill.
//   Service tax       — Service Charge ₹ + Tax (GST) ₹.
//   Tables available  — floor capacity − occupied (assigned/seated) tables.
//   Cover redeemed    — ₹ the CAPTAIN redeemed at tables (excludes bar mode).
//   Food / Drink sales— item subtotal split by t = food | drink.
//   NET sales         — item subtotal − discount (EXCLUDES SC + tax + disc).
//   Gross sales       — item subtotal + SC + tax.
// ─────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import {
  subscribeToCoversForNight, subscribeToHodReservations, subscribeToTableHistory,
  computeHodBreakdown,
  type HodCover, type HodTableReservation, type HodOrderItem,
} from "@/lib/firestore-hod";
import { getOperationalNightStr } from "@/lib/utils-pos";
import { DOOR_TABLE_OPTIONS, doorFloorForTable } from "@/lib/door-tables";

// ── helpers ───────────────────────────────────────────────────────────
const fmtRs = (n: number) => "₹" + Math.round(n || 0).toLocaleString("en-IN");
const fmtN = (n: number) => (n || 0).toLocaleString("en-IN");
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

// ── floors ────────────────────────────────────────────────────────────
type Floor3 = "Ground" | "First" | "Rooftop";
const FLOORS3: Floor3[] = ["Ground", "First", "Rooftop"];
const toFloor3 = (key?: string): Floor3 => {
  const k = (key || "").toLowerCase();
  if (k === "ground") return "Ground";
  if (k === "rooftop") return "Rooftop";
  return "First"; // dining + smoking + anything unmapped
};
const isProxyId = (id: string) => /-PX\d+$/.test(id);
// Real (non-proxy) table capacity per 3-floor bucket, derived from the
// shared door config so it never drifts from the picker.
const TOTAL_TABLES: Record<Floor3, number> = (() => {
  const o: Record<Floor3, number> = { Ground: 0, First: 0, Rooftop: 0 };
  for (const g of DOOR_TABLE_OPTIONS) {
    const f = toFloor3(g.floor);
    for (const id of g.tables) if (!isProxyId(id)) o[f] += 1;
  }
  return o;
})();
// 🆕 2026-06-08 (Khushi) — uppercase REAL table id → its 3-floor bucket, from
// the SAME shared door config as TOTAL_TABLES (proxies excluded). Used to count
// LIVE TABLES the way the Captain floor map does: a real table is "occupied"
// the instant a non-cancelled reservation maps to it (released = doc deleted),
// regardless of arrival/paid state. Keeps capacity + live in one universe so
// available = capacity − live can never go negative.
const REAL_TABLE_FLOOR: Map<string, Floor3> = (() => {
  const m = new Map<string, Floor3>();
  for (const g of DOOR_TABLE_OPTIONS) {
    const f = toFloor3(g.floor);
    for (const id of g.tables) if (!isProxyId(id)) m.set(id.toUpperCase(), f);
  }
  return m;
})();

// ── channels (aggregators + in-house) ─────────────────────────────────
type Channel = "Swiggy" | "Zomato" | "EazyDiner" | "In-house" | "Others";
const CHANNELS: Channel[] = ["Swiggy", "Zomato", "EazyDiner", "In-house", "Others"];
const channelOf = (r: HodTableReservation): Channel => {
  const s = ((r.aggregator || r.source || "") + "").toLowerCase();
  if (/swiggy/.test(s)) return "Swiggy";
  if (/zomato/.test(s)) return "Zomato";
  if (/eazydiner|eazydinner/.test(s)) return "EazyDiner";
  if (s === "" || s === "inhouse" || s === "in-house" || s === "corporate" || s === "walkin" || s === "walk-in") return "In-house";
  return "Others";
};

// ── per-floor accumulator ─────────────────────────────────────────────
interface FloorAgg {
  liveTables: number;     // tables with a RUNNING order (≥1 ordered item)
  occupiedTables: number; // tables assigned/seated (for available = capacity − occupied)
  billed: number;     // ₹ collected (paid)
  unfilled: number;   // ₹ open on live tables
  aggDisc: number; inhDisc: number;
  sc: number; tax: number;
  food: number; drink: number;
  net: number; gross: number;
}
const zeroFloor = (): FloorAgg => ({ liveTables: 0, occupiedTables: 0, billed: 0, unfilled: 0, aggDisc: 0, inhDisc: 0, sc: 0, tax: 0, food: 0, drink: 0, net: 0, gross: 0 });

export default function LiveReports() {
  const [night, setNight] = useState<string>(() => getOperationalNightStr());
  const [covers, setCovers] = useState<HodCover[]>([]);
  const [reservations, setReservations] = useState<HodTableReservation[]>([]);
  // 🆕 2026-06-08 (Khushi) — RELEASED tables, archived to `tableHistory` when the
  // captain taps RELEASE (the live reservation + cover docs are then deleted).
  // Without these the report's money totals (billed / discount / SC / net+gross /
  // cover-wallet redeemed) DROP the moment a table is released — the leakage
  // Khushi reported. Folded into the SAME aggregation as live reservations, but
  // they DON'T count toward occupancy/LIVE (a released table is genuinely free).
  const [history, setHistory] = useState<HodTableReservation[]>([]);
  const [loading, setLoading] = useState(true);

  const nextDay = useMemo(() => nextDayStr(night), [night]);

  // Covers (night + nextDay for the 7AM operational rollover).
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

  // Released-table history (night + nextDay) — see `history` state note above.
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

  // ── AGGREGATION ─────────────────────────────────────────────────────
  const agg = useMemo(() => {
    const floor: Record<Floor3, FloorAgg> = { Ground: zeroFloor(), First: zeroFloor(), Rooftop: zeroFloor() };
    const channel: Record<Channel, { amt: number; count: number }> =
      { Swiggy: { amt: 0, count: 0 }, Zomato: { amt: 0, count: 0 }, EazyDiner: { amt: 0, count: 0 }, "In-house": { amt: 0, count: 0 }, Others: { amt: 0, count: 0 } };
    const cap = new Map<string, { tables: number; amt: number }>();
    const foodItems = new Map<string, { qty: number; amt: number }>();
    const drinkItems = new Map<string, { qty: number; amt: number }>();
    // 🆕 2026-06-08 (Khushi) — LIVE TABLES = occupied REAL tiles (deduped by
    // table id), matching the Captain floor map's occupancy. Captain-mode cover
    // redemption is tracked here from each reservation's walletRedemptions[]
    // (written ONLY by redeemFromWalletAtTable — i.e. the captain settling a
    // table against a wallet), so bar-mode redemptions are excluded.
    const occupied: Record<Floor3, Set<string>> = { Ground: new Set(), First: new Set(), Rooftop: new Set() };
    // 🆕 2026-06-08 (Khushi) — LIVE = only tables with a RUNNING order (≥1 ordered
    // item). An assigned/booked table with no order placed yet is occupied (counts
    // against availability) but NOT "live". Deduped by table id, real tiles only.
    const liveOrdered: Record<Floor3, Set<string>> = { Ground: new Set(), First: new Set(), Rooftop: new Set() };
    const walletRefs = new Set<string>();
    let walletRedeemed = 0;
    // 🆕 2026-06-12 v3.267 (Khushi) — count/sum IN-HOUSE discounts applied to
    // AGGREGATOR bookings. Aggregator bills normally print full menu price, so a
    // house ₹-off on an aggregator table is unusual and means money collected is
    // below the printed bill (e.g. FD7). Surfaced as a warning in the DISCOUNT box.
    let aggInhouseDiscCount = 0;
    let aggInhouseDiscAmt = 0;

    const addItem = (it: HodOrderItem) => {
      const name = (it.n || "").trim();
      if (!name) return;
      const qty = it.qty || 0;
      const amt = (it.p || 0) * qty;
      const bucket = (it.t || "drink") === "food" ? foodItems : drinkItems;
      const e = bucket.get(name) || { qty: 0, amt: 0 };
      e.qty += qty; e.amt += amt; bucket.set(name, e);
    };

    // 🆕 2026-06-08 (Khushi) — process LIVE reservations AND released-table
    // history through the SAME money aggregation. A released table is settled
    // sales that must NOT vanish from the report (the leakage Khushi reported).
    // `countOccupancy` is true ONLY for live reservations: a released table is
    // genuinely free, so it must not inflate LIVE/occupied (and thus must not
    // shrink AVAILABLE). Dedupe by bookingRef so a doc that somehow appears in
    // both lists (shouldn't — release deletes the live doc) is counted once.
    const seenRefs = new Set<string>();
    const processRes = (r: HodTableReservation, countOccupancy: boolean) => {
      if ((r.status || "").toLowerCase() === "cancelled") return;
      // Dedupe across live + history. Prefer bookingRef (stable across the
      // archive copy). Fallback to a composite of identity fields so a row
      // WITHOUT a bookingRef still can't double-count between the two lists
      // (the live _docId and the `hist:`-prefixed archive _docId differ, so
      // _docId alone is unsafe for cross-list dedupe).
      const dedupeKey = r.bookingRef
        ? `ref:${r.bookingRef}`
        : `cmp:${(r.tableId || "").toUpperCase()}|${r.bookedAt || ""}|${r.amountPaid || 0}|${r.arrivalTime || ""}`;
      if (seenRefs.has(dedupeKey)) return;
      seenRefs.add(dedupeKey);
      const fkey = r.floor || doorFloorForTable(r.tableId || "")?.floor;
      const F = toFloor3(fkey);
      const A = floor[F];

      const items = (r.tabRounds || []).flatMap((rd) => rd.items || []);
      const bd = computeHodBreakdown(items);
      const subtotal = bd.subtotal;
      const foodSub = bd.foodSubtotal;
      const drinkSub = bd.drinkSubtotal;
      const isPaid = (r.paymentStatus || "").toLowerCase() === "paid";
      // 🔴 SC / tax / discount source:
      //   PAID bills → TRUST the persisted amounts (markTablePaid writes them,
      //     and a waived component is intentionally 0/absent → treat missing as
      //     0). Recomputing from items would WRONGLY restore a waived SC / tax.
      //   OPEN bills → nothing persisted yet (SC/tax are stamped at mark-paid),
      //     so estimate the running figure from the current items; honour an
      //     already-applied discount (captain/aggregator) if present.
      let sc: number, tax: number, disc: number;
      if (isPaid) {
        sc = (r as any).serviceChargeAmount || 0;
        tax = r.taxAmount || 0;
        disc = r.discountAmount || 0;
      } else {
        sc = bd.serviceCharge;
        tax = bd.gst;
        disc = (r.discountAmount || 0) > 0 ? (r.discountAmount || 0) : subtotal * ((r.discountPercent || 0) / 100);
      }
      const billFinal = Math.max(0, subtotal + sc + tax - disc);
      const realized = isPaid ? (r.amountPaid || billFinal) : 0;
      const value = isPaid ? realized : billFinal;          // bill value this table represents
      const arrived = !!r.actualArrivalTime || items.length > 0;
      const openBill = !isPaid && arrived;

      // 🆕 LIVE TABLES (floor-map parity): a REAL table is occupied the moment a
      // non-cancelled reservation maps to it (released = doc deleted), settled or
      // not — exactly what the Captain floor map shows. Dedupe by table id so a
      // tile booked twice in one night counts once. Bucket by the table's own
      // floor (REAL_TABLE_FLOOR) so it lands in the same floor as its capacity.
      const realFloor = countOccupancy ? REAL_TABLE_FLOOR.get((r.tableId || "").toUpperCase()) : undefined;
      if (realFloor) {
        const tid = (r.tableId || "").toUpperCase();
        occupied[realFloor].add(tid);
        // LIVE = this table has a running order (≥1 ordered item).
        if (items.length > 0) liveOrdered[realFloor].add(tid);
      }

      // billed / unfilled (unbilled = ₹ still open on tables with an OPEN bill)
      if (openBill) { A.unfilled += billFinal; }
      if (isPaid) { A.billed += realized; }

      // 🆕 CAPTAIN-MODE cover redemption only: walletRedemptions[] is written
      // solely by redeemFromWalletAtTable (captain settling a table against a
      // wallet). Bar-mode redemptions bump cover.coverUsed directly and never
      // appear here, so they are correctly excluded.
      for (const wr of r.walletRedemptions || []) {
        const amt = wr.amount || 0;
        if (amt > 0) { walletRedeemed += amt; if (wr.walletRef) walletRefs.add(wr.walletRef); }
      }

      // money (open + paid both count toward sales of the night)
      const ch = channelOf(r);
      if (ch === "In-house") A.inhDisc += disc; else A.aggDisc += disc;
      if (ch !== "In-house" && disc > 0) { aggInhouseDiscCount += 1; aggInhouseDiscAmt += disc; }
      A.sc += sc; A.tax += tax;
      A.food += foodSub; A.drink += drinkSub;
      A.net += Math.max(0, subtotal - disc);
      A.gross += subtotal + sc + tax;

      // channel
      if (value > 0) { channel[ch].amt += value; channel[ch].count += 1; }

      // captain
      if (r.captainName && (value > 0 || items.length > 0)) {
        const k = r.captainName.trim();
        const e = cap.get(k) || { tables: 0, amt: 0 };
        e.tables += 1; e.amt += value; cap.set(k, e);
      }

      // top items (table sales)
      for (const it of items) addItem(it);
    };

    // LIVE reservations count toward occupancy; RELEASED history does NOT
    // (the table is free again) but its settled sales still count.
    for (const r of reservations) processRes(r, true);
    for (const r of history) processRes(r, false);

    // 🆕 2026-06-08 (Khushi) — the cover-wallet REDEEMED figure is now
    // captain-mode-only (summed above from reservation.walletRedemptions), so we
    // NO LONGER add cover.coverUsed here (that pooled bar-mode + table redemptions
    // together). This loop now only feeds the venue-wide top-5 from bar / entry
    // covers (table covers' sales are already on the reservation — skip
    // isTableBooking to avoid double-counting).
    for (const c of covers) {
      if (!c.isTableBooking) {
        for (const rd of c.tabRounds || []) for (const it of rd.items || []) addItem(it);
      }
    }
    // LIVE = tables with a running order (≥1 item); OCCUPIED = assigned/seated
    // tiles (feeds available = capacity − occupied). Both deduped per floor.
    for (const f of FLOORS3) { floor[f].liveTables = liveOrdered[f].size; floor[f].occupiedTables = occupied[f].size; }
    const walletRedeemedCount = walletRefs.size;

    const topN = (m: Map<string, { qty: number; amt: number }>) =>
      Array.from(m.entries()).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.qty - a.qty).slice(0, 5);
    const topCaptain = Array.from(cap.entries()).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.amt - a.amt).slice(0, 5);

    return { floor, channel, topFood: topN(foodItems), topDrink: topN(drinkItems), topCaptain, walletRedeemed, walletRedeemedCount, aggInhouseDiscCount, aggInhouseDiscAmt };
  }, [reservations, history, covers]);

  const sumFloors = (pick: (a: FloorAgg) => number) => FLOORS3.reduce((s, f) => s + pick(agg.floor[f]), 0);

  // ── CSV ─────────────────────────────────────────────────────────────
  const downloadCsv = () => {
    const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const L: string[] = [];
    L.push(`HOD Live Reports,${esc(night)}`);
    L.push("");
    const floorBlock = (title: string, cols: Array<{ label: string; pick: (a: FloorAgg) => number }>) => {
      L.push(title);
      L.push(["Floor", ...cols.map((c) => c.label)].join(","));
      for (const f of FLOORS3) L.push([f, ...cols.map((c) => Math.round(c.pick(agg.floor[f])))].map(esc).join(","));
      L.push(["TOTAL", ...cols.map((c) => Math.round(sumFloors(c.pick)))].map(esc).join(","));
      L.push("");
    };
    floorBlock("LIVE TABLES", [{ label: "Live", pick: (a) => a.liveTables }]);
    // TABLES AVAILABLE uses the static per-floor capacity (not a FloorAgg pick).
    L.push("TABLES AVAILABLE");
    L.push(["Floor", "Capacity", "Live", "Available"].join(","));
    for (const f of FLOORS3) { const a = agg.floor[f]; L.push([f, TOTAL_TABLES[f], a.liveTables, Math.max(0, TOTAL_TABLES[f] - a.occupiedTables)].map(esc).join(",")); }
    L.push(["TOTAL", FLOORS3.reduce((s, f) => s + TOTAL_TABLES[f], 0), sumFloors((a) => a.liveTables), FLOORS3.reduce((s, f) => s + Math.max(0, TOTAL_TABLES[f] - agg.floor[f].occupiedTables), 0)].map(esc).join(","));
    L.push("");
    floorBlock("BILLED AMOUNT (collected)", [{ label: "Billed Rs", pick: (a) => a.billed }]);
    floorBlock("UNBILLED AMOUNT (open on live tables)", [{ label: "Unbilled Rs", pick: (a) => a.unfilled }]);
    floorBlock("DISCOUNT", [{ label: "Aggregator Rs", pick: (a) => a.aggDisc }, { label: "In-house Rs", pick: (a) => a.inhDisc }, { label: "Total Rs", pick: (a) => a.aggDisc + a.inhDisc }]);
    floorBlock("SERVICE CHARGE & TAX", [{ label: "Service Charge Rs", pick: (a) => a.sc }, { label: "Tax (GST) Rs", pick: (a) => a.tax }, { label: "Total Rs", pick: (a) => a.sc + a.tax }]);
    floorBlock("FOOD SALES", [{ label: "Food Rs", pick: (a) => a.food }]);
    floorBlock("DRINK SALES", [{ label: "Drink Rs", pick: (a) => a.drink }]);
    floorBlock("NET SALES (excl SC + Tax + Disc)", [{ label: "Net Rs", pick: (a) => a.net }]);
    floorBlock("GROSS SALES", [{ label: "Gross Rs", pick: (a) => a.gross }]);

    L.push("SALES BY CHANNEL");
    L.push(["Channel", "Tables", "Amount Rs"].join(","));
    for (const ch of CHANNELS) L.push([ch, agg.channel[ch].count, Math.round(agg.channel[ch].amt)].map(esc).join(","));
    L.push("");
    L.push("COVER WALLET REDEEMED (CAPTAIN MODE — excludes bar)");
    L.push(["Covers", "Amount Rs"].join(","));
    L.push([agg.walletRedeemedCount, Math.round(agg.walletRedeemed)].map(esc).join(","));
    L.push("");
    const topBlock = (title: string, rows: Array<{ name: string; qty?: number; amt: number; tables?: number }>, qtyLabel: string) => {
      L.push(title);
      L.push(["#", "Name", qtyLabel, "Amount Rs"].join(","));
      rows.forEach((r, i) => L.push([i + 1, r.name, r.qty ?? r.tables ?? 0, Math.round(r.amt)].map(esc).join(",")));
      L.push("");
    };
    topBlock("TOP 5 FOOD SOLD", agg.topFood, "Qty");
    topBlock("TOP 5 DRINKS SOLD", agg.topDrink, "Qty");
    topBlock("TOP 5 CAPTAIN SALE", agg.topCaptain, "Tables");

    const blob = new Blob(["\uFEFF" + L.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `HOD_LiveReports_${night}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── RENDER ──────────────────────────────────────────────────────────
  const C = { ink: "#000", grey: "#6B6B6B", bg: "#F4F4F0", card: "#fff", accent: "#23A094" };
  const NUM_FONT = "'Space Grotesk', sans-serif";

  const Th = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
    <th style={{ padding: "8px 11px", fontSize: 10.5, fontWeight: 800, color: C.grey, letterSpacing: 0.6, textTransform: "uppercase", textAlign: right ? "right" : "left", whiteSpace: "nowrap" }}>{children}</th>
  );
  const Cell = ({ children, bold, num, right }: { children: React.ReactNode; bold?: boolean; num?: boolean; right?: boolean }) => (
    <td style={{ padding: "8px 11px", fontSize: 13, fontWeight: bold ? 900 : 700, color: C.ink, fontFamily: num ? NUM_FONT : undefined, whiteSpace: "nowrap", textAlign: right ? "right" : "left", borderTop: `1px solid ${C.ink}` }}>{children}</td>
  );
  const Box = ({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) => (
    <div style={{ background: C.card, border: `2px solid ${C.ink}`, borderRadius: 14, padding: 16, marginBottom: 16, overflowX: "auto" }}>
      <div style={{ fontSize: 15, fontWeight: 900, color: C.ink, letterSpacing: 0.4 }}>{title}</div>
      <div style={{ fontSize: 11, color: C.grey, fontWeight: 700, marginBottom: 12 }}>{hint}</div>
      {children}
    </div>
  );

  // A per-floor money/count table (Ground / First / Rooftop + TOTAL).
  type Col = { label: string; pick: (a: FloorAgg) => number; money?: boolean };
  const FloorTable = ({ cols }: { cols: Col[] }) => (
    <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 320 }}>
      <thead><tr style={{ background: C.bg }}>
        <Th>Floor</Th>{cols.map((c) => <Th key={c.label} right>{c.label}</Th>)}
      </tr></thead>
      <tbody>
        {FLOORS3.map((f) => (
          <tr key={f}>
            <Cell bold>{f}</Cell>
            {cols.map((c) => <Cell key={c.label} num right>{c.money ? fmtRs(c.pick(agg.floor[f])) : fmtN(c.pick(agg.floor[f]))}</Cell>)}
          </tr>
        ))}
        <tr style={{ background: C.bg }}>
          <Cell bold>TOTAL</Cell>
          {cols.map((c) => <Cell key={c.label} num bold right>{c.money ? fmtRs(sumFloors(c.pick)) : fmtN(sumFloors(c.pick))}</Cell>)}
        </tr>
      </tbody>
    </table>
  );

  const AvailTable = () => (
    <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 320 }}>
      <thead><tr style={{ background: C.bg }}>
        <Th>Floor</Th><Th right>Capacity</Th><Th right>Live</Th><Th right>Available</Th>
      </tr></thead>
      <tbody>
        {FLOORS3.map((f) => {
          const a = agg.floor[f]; const avail = Math.max(0, TOTAL_TABLES[f] - a.occupiedTables);
          return (
            <tr key={f}>
              <Cell bold>{f}</Cell>
              <Cell num right>{fmtN(TOTAL_TABLES[f])}</Cell>
              <Cell num right>{fmtN(a.liveTables)}</Cell>
              <Cell num bold right>{fmtN(avail)}</Cell>
            </tr>
          );
        })}
        <tr style={{ background: C.bg }}>
          <Cell bold>TOTAL</Cell>
          <Cell num bold right>{fmtN(FLOORS3.reduce((s, f) => s + TOTAL_TABLES[f], 0))}</Cell>
          <Cell num bold right>{fmtN(sumFloors((a) => a.liveTables))}</Cell>
          <Cell num bold right>{fmtN(FLOORS3.reduce((s, f) => s + Math.max(0, TOTAL_TABLES[f] - agg.floor[f].occupiedTables), 0))}</Cell>
        </tr>
      </tbody>
    </table>
  );

  return (
    <div style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
      {/* HEADER */}
      <div style={{ fontSize: 22, fontWeight: 900, color: C.ink, letterSpacing: 0.4, marginBottom: 6 }}>📊 LIVE REPORTS</div>
      <div style={{ fontSize: 12, color: C.grey, fontWeight: 700, marginBottom: 14 }}>
        One operational night · table activity broken down by floor (Ground · First · Rooftop). Smoking-zone tables are counted under First.
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
          {/* two-column responsive grid of floor boxes */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 0, columnGap: 16 }}>
            {/* 🆕 2026-06-08 — Khushi merge: LIVE TABLES = capacity + live + available
                in ONE box (4 cols: Floor · Capacity · Live · Available). */}
            <Box title="🪑 LIVE TABLES" hint="Floor capacity, LIVE tables (a running order placed — at least 1 item; a table that's only booked/assigned with no order is NOT live), and available (capacity − occupied/assigned; real tables only, excludes proxy).">
              <AvailTable />
            </Box>
            {/* 🆕 merge: BILLED + UNBILLED in ONE box (3 cols: Floor · Billed · Unbilled). */}
            <Box title="💰 BILLED & UNBILLED" hint="Billed = ₹ collected from settled (paid) tables, INCLUDING tables already released this night. Unbilled = ₹ still open on live tables (bill generated but not settled yet).">
              <FloorTable cols={[
                { label: "Billed", pick: (a) => a.billed, money: true },
                { label: "Unbilled", pick: (a) => a.unfilled, money: true },
              ]} />
            </Box>
            <Box title="🏷 DISCOUNT (aggregators + in-house)" hint="₹ knocked off the bill, split by aggregator vs in-house.">
              <FloorTable cols={[
                { label: "Aggregator", pick: (a) => a.aggDisc, money: true },
                { label: "In-house", pick: (a) => a.inhDisc, money: true },
                { label: "Total", pick: (a) => a.aggDisc + a.inhDisc, money: true },
              ]} />
              {/* 🆕 2026-06-12 v3.267 (Khushi) — warn when an in-house discount was
                  applied to an AGGREGATOR booking. Aggregator bills normally print
                  full price, so this means money collected is below the printed bill. */}
              {agg.aggInhouseDiscCount > 0 && (
                <div style={{ marginTop: 8, fontSize: 12, fontWeight: 800, padding: "8px 10px", borderRadius: 8, background: "#FEF3C7", border: "1.5px solid #B45309", color: "#92400E", lineHeight: 1.4 }}>
                  ⚠ {agg.aggInhouseDiscCount} aggregator booking{agg.aggInhouseDiscCount > 1 ? "s" : ""} had an IN-HOUSE discount (₹{Math.round(agg.aggInhouseDiscAmt)} total). Aggregator bills normally charge full price — check this was intended.
                </div>
              )}
            </Box>
            <Box title="🧾 SERVICE CHARGE & TAX" hint="Service charge (10%) and tax / GST collected per floor.">
              <FloorTable cols={[
                { label: "Service Charge", pick: (a) => a.sc, money: true },
                { label: "Tax (GST)", pick: (a) => a.tax, money: true },
                { label: "Total", pick: (a) => a.sc + a.tax, money: true },
              ]} />
            </Box>
            {/* 🆕 merge: FOOD + DRINK in ONE box (3 cols: Floor · Food · Drinks). */}
            <Box title="🍽 FOOD & DRINK SALES" hint="Item subtotal of food and drink lines (before SC / tax / discount).">
              <FloorTable cols={[
                { label: "Food", pick: (a) => a.food, money: true },
                { label: "Drinks", pick: (a) => a.drink, money: true },
              ]} />
            </Box>
            {/* 🆕 merge: NET + GROSS in ONE box (3 cols: Floor · Net · Gross). */}
            <Box title="📈 NET & GROSS SALES" hint="Net = item subtotal − discount (excludes service charge & tax). Gross = item subtotal + service charge + tax.">
              <FloorTable cols={[
                { label: "Net", pick: (a) => a.net, money: true },
                { label: "Gross", pick: (a) => a.gross, money: true },
              ]} />
            </Box>
          </div>

          {/* SALES BY CHANNEL */}
          <Box title="🛵 SALES BY CHANNEL" hint="Total table sales split by Swiggy · Zomato · in-house · EazyDiner · others.">
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 360 }}>
              <thead><tr style={{ background: C.bg }}><Th>Channel</Th><Th right>Tables</Th><Th right>Amount</Th></tr></thead>
              <tbody>
                {CHANNELS.map((ch) => (
                  <tr key={ch}>
                    <Cell bold>{ch}</Cell>
                    <Cell num right>{fmtN(agg.channel[ch].count)}</Cell>
                    <Cell num right>{fmtRs(agg.channel[ch].amt)}</Cell>
                  </tr>
                ))}
                <tr style={{ background: C.bg }}>
                  <Cell bold>TOTAL</Cell>
                  <Cell num bold right>{fmtN(CHANNELS.reduce((s, ch) => s + agg.channel[ch].count, 0))}</Cell>
                  <Cell num bold right>{fmtRs(CHANNELS.reduce((s, ch) => s + agg.channel[ch].amt, 0))}</Cell>
                </tr>
              </tbody>
            </table>
          </Box>

          {/* COVER WALLET REDEEMED */}
          <Box title="👛 AMOUNT REDEEMED FROM COVER WALLET" hint="Cover wallet ₹ the captain redeemed against tables this night, INCLUDING tables already released. Bar-mode redemptions are NOT counted here.">
            <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
              <div style={{ fontSize: 34, fontWeight: 900, color: C.accent, fontFamily: NUM_FONT }}>{fmtRs(agg.walletRedeemed)}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.grey }}>across {fmtN(agg.walletRedeemedCount)} cover wallet{agg.walletRedeemedCount === 1 ? "" : "s"}</div>
            </div>
          </Box>

          {/* TOP 5 grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 0, columnGap: 16 }}>
            <Box title="🥇 TOP 5 FOOD SOLD" hint="By quantity sold (tables + bar).">
              <TopTable rows={agg.topFood} qtyLabel="Qty" C={C} numFont={NUM_FONT} />
            </Box>
            <Box title="🥇 TOP 5 DRINKS SOLD" hint="By quantity sold (tables + bar).">
              <TopTable rows={agg.topDrink} qtyLabel="Qty" C={C} numFont={NUM_FONT} />
            </Box>
            <Box title="🥇 TOP 5 CAPTAIN SALE" hint="Captains ranked by total ₹ billed on their tables.">
              <TopTable rows={agg.topCaptain.map((r) => ({ name: r.name, qty: r.tables, amt: r.amt }))} qtyLabel="Tables" C={C} numFont={NUM_FONT} />
            </Box>
          </div>
        </>
      )}
    </div>
  );
}

// Shared top-5 table (rank · name · qty/tables · amount).
function TopTable({ rows, qtyLabel, C, numFont }: {
  rows: Array<{ name: string; qty?: number; amt: number }>;
  qtyLabel: string; C: { ink: string; grey: string; bg: string }; numFont: string;
}) {
  const Th = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
    <th style={{ padding: "8px 11px", fontSize: 10.5, fontWeight: 800, color: C.grey, letterSpacing: 0.6, textTransform: "uppercase", textAlign: right ? "right" : "left", whiteSpace: "nowrap" }}>{children}</th>
  );
  const Cell = ({ children, bold, num, right }: { children: React.ReactNode; bold?: boolean; num?: boolean; right?: boolean }) => (
    <td style={{ padding: "8px 11px", fontSize: 13, fontWeight: bold ? 900 : 700, color: C.ink, fontFamily: num ? numFont : undefined, whiteSpace: "nowrap", textAlign: right ? "right" : "left", borderTop: `1px solid ${C.ink}` }}>{children}</td>
  );
  if (!rows.length) return <div style={{ padding: "14px 4px", fontSize: 13, fontWeight: 700, color: C.grey, textAlign: "center" }}>No sales recorded for this night.</div>;
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 320 }}>
      <thead><tr style={{ background: C.bg }}><Th>#</Th><Th>Name</Th><Th right>{qtyLabel}</Th><Th right>Amount</Th></tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.name}>
            <Cell bold num>{i + 1}</Cell>
            <Cell bold>{r.name}</Cell>
            <Cell num right>{(r.qty || 0).toLocaleString("en-IN")}</Cell>
            <Cell num right>{"₹" + Math.round(r.amt || 0).toLocaleString("en-IN")}</Cell>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
