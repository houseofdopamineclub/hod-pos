// 🧾 KOT-vs-BILL TALLY — anti-fraud leakage detector.
//
// PURPOSE
// ────────────────────────────────────────────────────────────────────────────
// Catch the cash-pocket scam: bartender/kitchen prints a KOT (item physically
// leaves the bar/kitchen and reaches the customer), but the captain never adds
// it to the bill. Customer pays cash → captain pockets it → drink served, no
// money in the till, no audit trail.
//
// SCAM SHAPE
// ────────────────────────────────────────────────────────────────────────────
// 1) KOT printed: VODKA × 3, BEER × 2     (bartender hands over 3+2 = 5 drinks)
// 2) Bill at payment: VODKA × 2, BEER × 2 (only 4 drinks billed)
// 3) Vodka × 1 NOT in voidLog (= no manager-approved void)
// 4) → ₹leakage = 1 × vodka price = pocketed cash
//
// LEGITIMATE GAPS WE MUST SUBTRACT (else we'd false-flag every night):
// ────────────────────────────────────────────────────────────────────────────
//  • voidLog entries     → manager-PIN-approved post-print voids (refund/comp)
//  • silentEditLog        → PRE-print typo fixes (item never made it onto a KOT)
//
// ALGORITHM
// ────────────────────────────────────────────────────────────────────────────
// For each PAID or VOIDED reservation tonight:
//   kotQty(item)   = Σ qty across all posKOTs for this tableId, excluding
//                    docs with voidNotice:true or kind:"bill"
//   voidQty(item)  = Σ qty across all voidLog[].voided entries
//   billQty(item)  = Σ qty across all tabRounds[].items (current snapshot at
//                    payment; bill voids zero this out)
//   expectedBillQty(item) = kotQty - voidQty
//   leakageQty(item)      = expectedBillQty - billQty
//   leakageValue(item)    = leakageQty × item.unitPrice
//
// If leakageQty > 0 → KOT > BILL → 🔴 LEAKAGE (served, not billed)
// If leakageQty < 0 → BILL > KOT → 👻 PHANTOM BILL (billed, not served)
// If leakageQty = 0 → 🟢 MATCH
//
// FALLBACKS
// ────────────────────────────────────────────────────────────────────────────
//  • Item names normalised (trim + lowercase) to absorb minor drift.
//  • If posKOTs query fails (rules / network) → row falls back to "🟡 UNKNOWN
//    — manual review", never blocks the page.
//  • Read-only — zero writes — pure analysis. Worst case = wrong number on
//    screen, never breaks the POS.
//  • Bill-voided tables → tagged separately (the void itself is the loss event).

import type { HodTableReservation, HodOrderItem, HodTabRound } from "./firestore-hod";

export const TALLY_MINOR_THRESHOLD = 500;   // <₹500 leakage → 🟠 MINOR
export const TALLY_LEAK_THRESHOLD = 500;    // ≥₹500 leakage → 🔴 LEAKAGE

export type TallyVerdict =
  | "match"           // 🟢 KOT == bill (legit voids accounted)
  | "minor"           // 🟠 small ₹ gap (rounding / comp / water)
  | "leakage"         // 🔴 KOT > bill — items served, not billed (CASH POCKET RISK)
  | "phantom"         // 👻 bill > KOT — items billed, never served (PHANTOM CHARGE)
  | "bill-voided"     // ⚫ entire bill voided (separate audit trail)
  | "unknown";        // 🟡 KOT subscription failed — manual review

/** Minimal shape we need from a posKOTs doc. Robust to extra fields. */
export interface PosKotDoc {
  id: string;
  tableId?: string;
  /** Reservation/wallet ref so we can match KOTs to bookings that have NO
   *  tableId assigned (wallet/cover flows). printKOT writes both when known. */
  bookingRef?: string | null;
  reservationId?: string | null;
  customerName?: string | null;
  items?: Array<HodOrderItem & { dest?: string }>;
  voidNotice?: boolean;
  kind?: string;          // "bill" docs are bill prints, not real KOTs
  billNumber?: string;    // belt-and-braces — bill prints sometimes lack `kind`
  staff?: string;
  createdAt?: any;
}

export interface ItemDiff {
  /** Display name (original casing from the first source we saw it in). */
  name: string;
  unitPrice: number;
  kotQty: number;
  voidQty: number;
  billQty: number;
  expectedBillQty: number;   // kotQty - voidQty
  diffQty: number;           // expectedBillQty - billQty (positive = leakage)
  diffValue: number;         // diffQty × unitPrice (positive = leakage)
}

export interface TallyRow {
  reservationId: string;
  tableId: string;
  floor: string;
  customerName: string;
  captain: string;
  paymentStatus: string;          // "paid" | "voided" | etc.
  paidAt: string;
  kotCount: number;               // # of posKOTs docs for this table tonight
  kotValue: number;               // Σ all printed KOT items @ unit price
  voidValue: number;              // Σ voidLog valueLost
  billValue: number;              // Σ tabRounds items @ unit price (bill subtotal)
  expectedBillValue: number;      // kotValue - voidValue
  diffValue: number;              // signed — positive = leakage, negative = phantom
  leakageValue: number;           // max(diffValue, 0) — for sorting
  phantomValue: number;           // max(-diffValue, 0)
  itemDiffs: ItemDiff[];          // only items where diffQty !== 0
  matchedItems: ItemDiff[];       // items where diffQty === 0 (for drill-down)
  verdict: TallyVerdict;
}

export interface CaptainLeakageSummary {
  captain: string;
  tables: number;          // total tables tallied for this captain
  leakageTables: number;   // tables flagged 🔴 leakage
  phantomTables: number;   // tables flagged 👻 phantom
  totalLeakage: number;    // Σ ₹ leakage across their tables (positive only)
  totalPhantom: number;    // Σ ₹ phantom across their tables
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Normalise item name for matching across sources (KOT vs bill vs void).
 *  Bartenders/captains can type with subtle whitespace/case differences —
 *  "VODKA SHOT  " vs "vodka shot" — they're the same drink. */
function normName(n: string | undefined): string {
  return String(n || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Sum item quantities AND value into a name-keyed bucket.
 *  CRITICAL: we track both qty and totalValue separately because the same
 *  normalized item can be sold at different prices in one night (happy-hour,
 *  per-item discount, manual price override). If we collapsed to one
 *  unitPrice and multiplied at the end, ₹ diff would drift and could cross
 *  the ₹500 leakage threshold spuriously.
 *  Display unitPrice = totalValue/qty (qty-weighted average) for the UI. */
function bucketAdd(
  bucket: Map<string, { name: string; qty: number; totalValue: number }>,
  items: Array<{ n?: string; p?: number; qty?: number }>,
): void {
  for (const it of items || []) {
    const key = normName(it.n);
    if (!key) continue;
    const qty = Number(it.qty || 0);
    if (qty <= 0) continue;
    const price = Number(it.p || 0);
    const cur = bucket.get(key);
    if (cur) {
      cur.qty += qty;
      cur.totalValue += qty * price;
    } else {
      bucket.set(key, {
        name: String(it.n || "").trim() || key,
        qty,
        totalValue: qty * price,
      });
    }
  }
}

/** Should a posKOTs doc be counted as a real food/drink KOT?
 *  Excludes void slips and bill prints. */
export function isRealKot(k: PosKotDoc): boolean {
  if (k.voidNotice) return false;
  if (k.kind === "bill") return false;
  if (k.billNumber) return false;
  return Array.isArray(k.items) && k.items.length > 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Core: build one tally row for one reservation
// ────────────────────────────────────────────────────────────────────────────

export function computeTallyRow(
  r: HodTableReservation,
  kotsForTable: PosKotDoc[],
  opts?: { kotsStatus?: KotsStatus },
): TallyRow {
  const kotsStatus: KotsStatus = opts?.kotsStatus || "ok";
  const kotBucket = new Map<string, { name: string; qty: number; totalValue: number }>();
  const voidBucket = new Map<string, { name: string; qty: number; totalValue: number }>();
  const billBucket = new Map<string, { name: string; qty: number; totalValue: number }>();

  // 1) KOT items (only real KOTs — exclude void slips + bill prints)
  for (const k of kotsForTable) {
    if (!isRealKot(k)) continue;
    bucketAdd(kotBucket, k.items || []);
  }

  // 2) Void items (manager-approved post-print voids — legitimate gap)
  const voidLog = Array.isArray((r as any).voidLog) ? (r as any).voidLog : [];
  for (const v of voidLog) {
    // Bill-voids carry no item-level breakdown (the whole bill is voided);
    // skip them here, they're handled by the bill-voided verdict path.
    if (v.kind === "bill-void") continue;
    bucketAdd(voidBucket, Array.isArray(v.voided) ? v.voided : []);
  }

  // 3) Bill items (tabRounds = current snapshot at payment time)
  const rounds: HodTabRound[] = Array.isArray(r.tabRounds) ? r.tabRounds : [];
  for (const round of rounds) {
    bucketAdd(billBucket, round.items || []);
  }

  // 4) Walk the union of all item names, compute diffs USING SUMMED ₹ VALUES
  //    (not qty * one merged price — see bucketAdd doc for why).
  const allNames = new Set<string>([...kotBucket.keys(), ...voidBucket.keys(), ...billBucket.keys()]);
  const itemDiffs: ItemDiff[] = [];
  const matchedItems: ItemDiff[] = [];
  let kotValue = 0, voidValue = 0, billValue = 0;
  for (const key of allNames) {
    const k = kotBucket.get(key);
    const v = voidBucket.get(key);
    const b = billBucket.get(key);
    const display = (k || b || v)!;
    const kotQty = k?.qty || 0;
    const voidQty = v?.qty || 0;
    const billQty = b?.qty || 0;
    const kotVal = k?.totalValue || 0;
    const voidVal = v?.totalValue || 0;
    const billVal = b?.totalValue || 0;
    const expectedBillQty = kotQty - voidQty;
    const expectedBillVal = kotVal - voidVal;
    const diffQty = expectedBillQty - billQty;
    const diffValue = expectedBillVal - billVal;
    // Display unit price = qty-weighted average across the source we trust most
    const totalQtySeen = kotQty + voidQty + billQty;
    const totalValSeen = kotVal + voidVal + billVal;
    const unitPrice = totalQtySeen > 0 ? Math.round(totalValSeen / totalQtySeen) : 0;
    kotValue += kotVal;
    voidValue += voidVal;
    billValue += billVal;
    const row: ItemDiff = {
      name: display.name, unitPrice,
      kotQty, voidQty, billQty,
      expectedBillQty, diffQty, diffValue,
    };
    if (diffQty === 0) matchedItems.push(row);
    else itemDiffs.push(row);
  }
  itemDiffs.sort((a, b) => Math.abs(b.diffValue) - Math.abs(a.diffValue));

  const expectedBillValue = kotValue - voidValue;
  const diffValue = expectedBillValue - billValue;
  const leakageValue = Math.max(diffValue, 0);
  const phantomValue = Math.max(-diffValue, 0);

  // Verdict — bill-voided always wins; UNKNOWN when KOT data unavailable AND
  // bill has items (we'd otherwise spuriously flag PHANTOM). When bill is also
  // empty, the row is filtered out upstream in buildAllTallyRows.
  let verdict: TallyVerdict;
  if ((r as any).status === "voided") verdict = "bill-voided";
  else if (kotsStatus !== "ok" && kotValue === 0 && billValue > 0) verdict = "unknown";
  else if (Math.abs(diffValue) < 1) verdict = "match";
  else if (diffValue > 0 && diffValue >= TALLY_LEAK_THRESHOLD) verdict = "leakage";
  else if (diffValue > 0) verdict = "minor";
  else if (diffValue < 0 && Math.abs(diffValue) >= TALLY_LEAK_THRESHOLD) verdict = "phantom";
  else verdict = "minor"; // small phantom (<₹500) → still amber, not red

  return {
    reservationId: (r as any)._docId || (r as any).id || r.tableId || "",
    tableId: r.tableId || "",
    floor: r.floorLabel || r.floor || "",
    customerName: r.customerName || "",
    captain: r.captainName || "",
    paymentStatus: r.paymentStatus || "open",
    paidAt: r.paidAt || "",
    kotCount: kotsForTable.filter(isRealKot).length,
    kotValue, voidValue, billValue,
    expectedBillValue, diffValue,
    leakageValue, phantomValue,
    itemDiffs, matchedItems,
    verdict,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Bulk: tally every closed reservation tonight + per-captain summary
// ────────────────────────────────────────────────────────────────────────────

export type KotsStatus = "ok" | "loading" | "error";

/** Reservation lifecycle window helper. Used to scope KOTs to the SPECIFIC
 *  party at a table, not all parties that used the table tonight.
 *  Anchors: actualArrivalTime → bookedAt → arrivalTime → null.
 *  End anchor: paidAt + 30min buffer (late KOTs / void slips). */
function reservationStartMs(r: HodTableReservation): number | null {
  const cands = [
    (r as any).actualArrivalTime, (r as any).seatedAt, r.arrivalTime,
    r.bookedAt, (r as any).createdAt,
  ];
  for (const c of cands) {
    if (!c) continue;
    const t = typeof c === "string" ? Date.parse(c) : (c?.toMillis?.() || (typeof c === "number" ? c : NaN));
    if (Number.isFinite(t) && t > 0) return t;
  }
  return null;
}
function reservationEndMs(r: HodTableReservation): number | null {
  if (r.paidAt) { const t = Date.parse(r.paidAt); if (Number.isFinite(t)) return t + 30 * 60_000; }
  return null;
}
function kotMs(k: PosKotDoc): number {
  const t = k.createdAt;
  return t?.toMillis?.() || (typeof t === "number" ? t : (typeof t === "string" ? Date.parse(t) : 0));
}

export function buildAllTallyRows(
  reservations: HodTableReservation[],
  kots: PosKotDoc[],
  opts?: { closedOnly?: boolean; kotsStatus?: KotsStatus },
): TallyRow[] {
  const closedOnly = opts?.closedOnly ?? true;
  const kotsStatus: KotsStatus = opts?.kotsStatus || "ok";

  // Bucket KOTs by tableId for O(N+M) instead of O(N*M).
  // FALLBACK BUCKETS for KOTs with no tableId (wallet/cover flows where the
  // customer never had a real table assigned): also index by bookingRef and
  // reservationId so the per-reservation matcher below can still find them.
  // Each KOT gets indexed in EVERY bucket key it has — the matcher dedups by
  // KOT.id so we never double-count.
  const byTable = new Map<string, PosKotDoc[]>();
  const byBookingRef = new Map<string, PosKotDoc[]>();
  const byReservationId = new Map<string, PosKotDoc[]>();
  const pushTo = (m: Map<string, PosKotDoc[]>, key: string, k: PosKotDoc) => {
    let arr = m.get(key); if (!arr) { arr = []; m.set(key, arr); }
    arr.push(k);
  };
  for (const k of kots) {
    const tid = String(k.tableId || "").trim();
    const bref = String(k.bookingRef || "").trim();
    const rid = String(k.reservationId || "").trim();
    if (tid) pushTo(byTable, tid, k);
    if (bref) pushTo(byBookingRef, bref, k);
    if (rid) pushTo(byReservationId, rid, k);
  }

  // ── Per-reservation time-window scoping (table-reuse safe) ────────────────
  // A single tableId can host 2-3 parties on a busy night. If we naively
  // bucket all KOTs by tableId, the late party gets blamed for the early
  // party's drinks → false leakage. Strategy: order reservations by their
  // paidAt for each tableId, and assign each KOT to the earliest reservation
  // whose [start, end+buffer] window contains the KOT's createdAt. KOTs that
  // don't fit any window (no timestamps, or pre-arrival prep) fall back to
  // the LAST reservation in that table's queue — same behavior as before, but
  // only when nothing better is known.
  const kotByReservation = new Map<string, PosKotDoc[]>();
  const addUnique = (rid: string, ks: PosKotDoc[]) => {
    let arr = kotByReservation.get(rid);
    if (!arr) { arr = []; kotByReservation.set(rid, arr); }
    const seen = new Set(arr.map(x => x.id));
    for (const k of ks) if (!seen.has(k.id)) { arr.push(k); seen.add(k.id); }
  };
  for (const [tid, tableKots] of byTable.entries()) {
    const reservationsForTable = reservations
      .filter(r => String(r.tableId || "").trim() === tid)
      .map(r => ({ r, start: reservationStartMs(r), end: reservationEndMs(r), id: (r as any)._docId || r.tableId }))
      .sort((a, b) => (a.end || a.start || 0) - (b.end || b.start || 0));
    if (reservationsForTable.length === 0) continue;
    if (reservationsForTable.length === 1) {
      addUnique(reservationsForTable[0].id, tableKots);
      continue;
    }
    // Multi-party table — assign each KOT to the first window it falls into.
    const fallback = reservationsForTable[reservationsForTable.length - 1];
    for (const k of tableKots) {
      const ts = kotMs(k);
      let assigned: typeof reservationsForTable[number] | null = null;
      if (ts > 0) {
        for (const slot of reservationsForTable) {
          const startOk = slot.start == null || ts >= slot.start - 5 * 60_000; // 5min pre-arrival buffer
          const endOk = slot.end == null || ts <= slot.end;
          if (startOk && endOk) { assigned = slot; break; }
        }
      }
      const bucket = assigned || fallback;
      addUnique(bucket.id, [k]);
    }
  }
  // FALLBACK PASS — pick up any KOTs that didn't bucket via tableId (e.g.
  // wallet/cover orders with no table assigned). Match by Firestore
  // reservation _docId first, then bookingRef. Dedup by KOT.id so a KOT
  // already attributed via tableId is never counted twice.
  for (const r of reservations) {
    const rid = (r as any)._docId || "";
    if (rid && byReservationId.has(rid)) addUnique(rid, byReservationId.get(rid)!);
    const bref = String(r.bookingRef || "").trim();
    if (rid && bref && byBookingRef.has(bref)) addUnique(rid, byBookingRef.get(bref)!);
  }

  const out: TallyRow[] = [];
  for (const r of reservations) {
    if (closedOnly) {
      const isPaid = r.paymentStatus === "paid";
      const isVoided = (r as any).status === "voided";
      if (!isPaid && !isVoided) continue;
    }
    const rid = (r as any)._docId || r.tableId || "";
    const kotsForReservation = kotByReservation.get(rid) || [];
    // Skip totally empty tables (no KOTs + no bill) — likely abandoned bookings
    const hasAnyActivity =
      kotsForReservation.some(isRealKot) ||
      (Array.isArray(r.tabRounds) && r.tabRounds.some(x => Array.isArray(x.items) && x.items.length > 0));
    if (!hasAnyActivity) continue;
    out.push(computeTallyRow(r, kotsForReservation, { kotsStatus }));
  }
  // Sort: leakage desc, then phantom desc, then bill-voided, then matches
  const order: Record<TallyVerdict, number> = {
    leakage: 0, phantom: 1, "bill-voided": 2, minor: 3, unknown: 4, match: 5,
  };
  out.sort((a, b) => {
    if (order[a.verdict] !== order[b.verdict]) return order[a.verdict] - order[b.verdict];
    return Math.abs(b.diffValue) - Math.abs(a.diffValue);
  });
  return out;
}

export function aggregateCaptainLeakage(rows: TallyRow[]): CaptainLeakageSummary[] {
  const map = new Map<string, CaptainLeakageSummary>();
  for (const r of rows) {
    const cap = r.captain || "—";
    let cur = map.get(cap);
    if (!cur) {
      cur = { captain: cap, tables: 0, leakageTables: 0, phantomTables: 0, totalLeakage: 0, totalPhantom: 0 };
      map.set(cap, cur);
    }
    cur.tables += 1;
    cur.totalLeakage += r.leakageValue;
    cur.totalPhantom += r.phantomValue;
    if (r.verdict === "leakage") cur.leakageTables += 1;
    if (r.verdict === "phantom") cur.phantomTables += 1;
  }
  return Array.from(map.values()).sort(
    (a, b) => (b.totalLeakage + b.totalPhantom) - (a.totalLeakage + a.totalPhantom),
  );
}
