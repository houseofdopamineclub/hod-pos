import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc,
  onSnapshot, query, where, orderBy, limit, increment, arrayUnion,
  serverTimestamp, runTransaction, Timestamp, type Unsubscribe,
} from "firebase/firestore";
import { db, authReady } from "./firebase";
import { getOperationalNightStr, getCoverExpiryFor } from "./utils-pos";
// 🆕 2026-05-26 v3.10 (Fix #1 Listener Scoping) — floor lookup for the scoped
// reservations listener. getFloorFromTableId() returns null for off-map IDs;
// the scoped subscriber MUST fail-open and keep those rows visible.
import { getFloorFromTableId, type FloorKey } from "./floor-plan";
// 🆕 2026-06-02 (Khushi) — reuse the EXACT door/waitlist/reassign picker
// occupancy helper so the backend reassign conflict check agrees with what the
// picker paints GREEN (free) vs RED (taken). Previously the backend rejected on
// ANY reservation for the table that night (no time-window, no paid filter),
// while the picker is time-windowed + skips paid → a GREEN table got rejected as
// "already occupied". Import is runtime-safe: door-tables only TYPE-imports back.
import { doorTableOccupantAt, doorNowMinutesIST, isTableReservationSettled } from "./door-tables";

// 🆕 2026-05-27 v3.94 — SHARED SUBSCRIPTION CACHE (Khushi LIVE-NIGHT: 13M
// reads / 305 listeners observed 2026-05-27 ~2PM). DoorMode alone mounts
// `subscribeToHodReservations` 7×, `subscribeToCoversForNight` 3×,
// `subscribeToBookingsForNights` 3×, `subscribeToHodEvents` 2× per tablet
// load — 15 phone lines for what should be ~4. Each duplicate is a billable
// Firestore listener that pushes the same payload N times per change.
//
// This helper collapses N onSnapshot() calls with the same query KEY into a
// SINGLE underlying Firestore listener that fans out to all in-process
// subscribers. Zero call-site changes (each subscribe* function builds its
// own key and delegates here). When the last subscriber unsubs, the shared
// listener closes — same lifecycle as if no sharing existed.
//
// 🛟 FAIL-OPEN: subscriber callback errors are caught + logged so one bad
// subscriber can't break the others. Replay-on-join (lastData) ensures a
// late subscriber doesn't have to wait for the next Firestore push.
//
// Out of scope (intentionally NOT shared): subscribeToDoorPricingSettings
// (single doc, complex localStorage seeding), per-doc covers/bookings
// queries inside customer-site flow, anything outside this file.
interface _SharedSub<T> {
  unsub: Unsubscribe;
  subscribers: Set<(data: T) => void>;
  lastData: T | undefined;
  hasData: boolean;
}
const _sharedSubs = new Map<string, _SharedSub<unknown>>();

function _shareSubscription<T>(
  key: string,
  factory: (push: (data: T) => void) => Unsubscribe,
  cb: (data: T) => void,
): Unsubscribe {
  let entry = _sharedSubs.get(key) as _SharedSub<T> | undefined;
  if (!entry) {
    const subscribers = new Set<(data: T) => void>();
    const unsub = factory((data: T) => {
      const e = _sharedSubs.get(key) as _SharedSub<T> | undefined;
      if (!e) return;
      e.lastData = data;
      e.hasData = true;
      e.subscribers.forEach((s) => {
        try { s(data); } catch (err) { console.warn("[sharedSub] subscriber cb threw", key, err); }
      });
    });
    entry = { unsub, subscribers, lastData: undefined, hasData: false };
    _sharedSubs.set(key, entry as _SharedSub<unknown>);
  }
  entry.subscribers.add(cb);
  // Replay last-known payload immediately so the new subscriber sees data
  // without waiting for the next Firestore push (matches onSnapshot's own
  // cached-first-emit semantics for fresh subscribers).
  if (entry.hasData) {
    try { cb(entry.lastData as T); } catch (err) { console.warn("[sharedSub] replay cb threw", key, err); }
  }
  return () => {
    const e = _sharedSubs.get(key) as _SharedSub<T> | undefined;
    if (!e) return;
    e.subscribers.delete(cb);
    if (e.subscribers.size === 0) {
      try { e.unsub(); } catch {}
      _sharedSubs.delete(key);
    }
  };
}

export interface HodCover {
  id: string;
  ref: string;
  bookingId?: string;
  name: string;
  phone?: string;
  /** Captured from hodclub.in booking flow when available. Empty string when
   *  customer is a walk-in or aggregator arrival. UI MUST tolerate "—". */
  email?: string;
  eventId?: string;
  eventTitle?: string;
  date?: string;
  tier?: string;
  coverBalance: number;
  coverActivated: number;
  coverUsed: number;
  coverPaid?: number;
  topUpTotal?: number;
  paymentMethod?: string;
  checkedIn?: boolean;
  actualArrivalTime?: string;
  activatedAt?: string;
  activatedBy?: string;
  expiresAt?: string;
  lastActivatedAt?: string;
  lastActivatedBy?: string;
  pendingOrder?: { items: HodOrderItem[]; total: number } | null;
  tabRounds?: HodTabRound[];
  transactions?: HodTransaction[];
  tableId?: string;
  floorLabel?: string;
  isGuestList?: boolean;
  /** True when this cover was auto-created from a TABLE FOR 4 / VVIP TABLE FOR 6
   *  booking. Bar Mode MUST refuse to open the wallet for these — table bills
   *  go through Captain Mode (tax + service charge calculated at end of night).
   *  Bar Mode is pay-and-go for cover wallets only. */
  isTableBooking?: boolean;
  // ── Wallet thermal-bill audit / anti-fraud (Bar Mode hardening) ──
  walletBillPrintCount?: number;
  walletBillFirstPrintedAt?: string;
  lastWalletBillPrintedAt?: string;
  walletBillPrintLog?: Array<{
    at: string; by: string; total: number; itemCount: number;
    isDuplicate: boolean; billNumber: string;
    // 🆕 2026-06-05 — money breakdown persisted at print time so Bar Mode's
    // LIVE REPORTS can total discount / service-charge / tax accurately.
    // Optional for back-compat with pre-v3.224 bill rows (treated as 0).
    subtotal?: number; discount?: number; serviceCharge?: number; tax?: number;
  }>;
}

export interface HodOrderItem {
  n: string;
  p: number;
  qty: number;
  cat?: string;
  /** Tax class — "food" lines incur 5% GST + 10% SC; "drink" lines are tax-exempt. Defaults to "drink". */
  t?: "food" | "drink";
  /** Veg flag (food only) — surfaced for KOT printing convenience. */
  v?: boolean;
  /** Alcoholic flag (drinks only) — alcoholic drinks are exempt from GST but still pay SC. */
  alc?: boolean;
}

/** HOD wallet tax — matches printed restaurant bills.
 *  SC 10% on ALL items (food + alcohol + non-alc).
 *  GST 5% (split CGST 2.5% / SGST 2.5%) on (food + non-alcoholic + entire SC).
 *  Alcohol is exempt from GST. */
export const HOD_GST_RATE = 0.05;
export const HOD_SC_RATE = 0.10;
export interface HodCartBreakdown {
  foodSubtotal: number;
  alcSubtotal: number;
  nonAlcSubtotal: number;
  drinkSubtotal: number;
  subtotal: number;
  serviceCharge: number;
  gst: number;
  cgst: number;
  sgst: number;
  roundOff: number;
  grandTotal: number;
}
/** Single source of truth for tax math — mirrors index.html hodComputeBreakdown. */
export function computeHodBreakdown(items: HodOrderItem[]): HodCartBreakdown {
  let foodSub = 0, alcSub = 0, nonAlcSub = 0;
  for (const it of items || []) {
    const line = (it.p || 0) * (it.qty || 0);
    const t = it.t || "drink";
    if (t === "food") foodSub += line;
    else if (it.alc === false) nonAlcSub += line;
    else alcSub += line;
  }
  const subtotal = foodSub + alcSub + nonAlcSub;
  const sc = Math.round(subtotal * HOD_SC_RATE * 100) / 100;
  const gstBase = foodSub + nonAlcSub + sc;
  const gst = Math.round(gstBase * HOD_GST_RATE * 100) / 100;
  const cgst = Math.round(gst * 50) / 100;
  const sgst = Math.round((gst - cgst) * 100) / 100;
  const raw = subtotal + sc + gst;
  const grandTotal = Math.round(raw);
  const roundOff = Math.round((grandTotal - raw) * 100) / 100;
  return { foodSubtotal: foodSub, alcSubtotal: alcSub, nonAlcSubtotal: nonAlcSub,
           drinkSubtotal: alcSub + nonAlcSub, subtotal,
           serviceCharge: sc, gst, cgst, sgst, roundOff, grandTotal };
}

export interface HodCartBreakdownAdjusted extends HodCartBreakdown {
  discount: number;     // ₹ taken off the subtotal by the discount %
  discountPct: number;  // the clamped discount % actually applied
}
/** Discount + Service-Charge-toggle aware variant of computeHodBreakdown.
 *  Used by BarMode so the RECHARGE-required amount, the on-screen tax
 *  breakdown, the wallet debit and the printed bill all agree to the rupee
 *  AND match the customer wallet.
 *
 *  CRITICAL: with discPct=0 and scOn=true this is IDENTICAL to
 *  computeHodBreakdown (same alcohol-GST-exemption, same 2-decimal SC/GST,
 *  same final whole-rupee round) — so the customer total === bar total.
 *
 *  The discount is applied PROPORTIONALLY across food/alcohol/non-alc so the
 *  alcohol GST-exemption is preserved after the discount. */
export function computeHodBreakdownAdjusted(
  items: HodOrderItem[], discPct: number = 0, scOn: boolean = true,
): HodCartBreakdownAdjusted {
  let foodSub = 0, alcSub = 0, nonAlcSub = 0;
  for (const it of items || []) {
    const line = (it.p || 0) * (it.qty || 0);
    const t = it.t || "drink";
    if (t === "food") foodSub += line;
    else if (it.alc === false) nonAlcSub += line;
    else alcSub += line;
  }
  const subtotal = foodSub + alcSub + nonAlcSub;
  const pct = Math.min(100, Math.max(0, discPct || 0));
  const factor = (100 - pct) / 100;
  const dFood = foodSub * factor, dAlc = alcSub * factor, dNonAlc = nonAlcSub * factor;
  const discountedSub = dFood + dAlc + dNonAlc;
  const discount = Math.round((subtotal - discountedSub) * 100) / 100;
  const sc = scOn ? Math.round(discountedSub * HOD_SC_RATE * 100) / 100 : 0;
  const gstBase = dFood + dNonAlc + sc; // alcohol is GST-exempt
  const gst = Math.round(gstBase * HOD_GST_RATE * 100) / 100;
  const cgst = Math.round(gst * 50) / 100;
  const sgst = Math.round((gst - cgst) * 100) / 100;
  const raw = discountedSub + sc + gst;
  const grandTotal = Math.round(raw);
  const roundOff = Math.round((grandTotal - raw) * 100) / 100;
  return { foodSubtotal: foodSub, alcSubtotal: alcSub, nonAlcSubtotal: nonAlcSub,
           drinkSubtotal: alcSub + nonAlcSub, subtotal,
           serviceCharge: sc, gst, cgst, sgst, roundOff, grandTotal,
           discount, discountPct: pct };
}

export interface HodTabRound {
  roundNum: number;
  items: HodOrderItem[];
  roundTotal: number;
  status: "preparing" | "activated" | "served";
  placedAt?: string;
  activatedBy?: string;
  activatedAt?: string;
  placedBy?: string;
  /** Origin of the round. Customer self-orders set
   *  `customer_self_order` (table) / `customer_self_order_bar` (bar);
   *  recharge-at-bar sets `recharge_at_bar`; a bartender-created manual
   *  round sets `bartender_bar`. Any value containing the substring "bar"
   *  marks a COVER-ONLY (instant-redeemed-at-bar) round that must never be
   *  dropped by the table→cover mirror. */
  source?: string;
}

export interface HodTransaction {
  amount: number;
  note: string;
  timestamp: string;
  type: string;
  staff?: string;
  paymentId?: string;
  split?: { cash?: number; upi?: number; card?: number };
  /** Server-side Razorpay-signature-verified credit. Set by the
   *  `verifyRechargePayment` / `razorpayWebhook` cloud functions only —
   *  customer-site direct writes can NEVER set this true. POS Bar Mode
   *  shows a green ✅ tick when this is true; gates KOT activation
   *  until tick lands or 60-sec auto-fail-open elapses. */
  serverVerified?: boolean;
  /** ISO timestamp when the server verified the payment. */
  verifiedAt?: string;
  /** "verify" (synchronous client→server call) or "webhook" (Razorpay→
   *  cloud function backstop, fires when client browser closes mid-pay). */
  verifiedSource?: "verify" | "webhook";
  /** Razorpay order_id (set by createOrder, used for signature verify). */
  orderId?: string;
  /** Set true when an ACTIVATE happened during the 60-sec auto-fail-open
   *  window (recharge transaction was online but tick hadn't landed yet).
   *  Surfaces in the admin Pending Webhook tile + next-day leakage report. */
  pendingWebhookTick?: boolean;
  /** 🆕 2026-06-24 (Khushi) — PER-TRANSACTION DISCOUNT TRUTH. The discount %
   *  that was applied to THIS recharge at the moment it happened, stamped
   *  immutably here so it can NEVER be overwritten by a later recharge that
   *  picks a different discount (the old `cover.billDiscountPct` is a single
   *  field — recharge #2's 5% used to wipe recharge #1's 10% everywhere,
   *  including retroactively in Live Reports). Only set when > 0. `amount`
   *  remains the NET collected/credited; `grossAmount` is the pre-discount
   *  figure so reports can reconcile (discount given = grossAmount − amount). */
  discountPct?: number;
  grossAmount?: number;
}

export interface HodTableReservation {
  _docId: string;
  tableId: string;
  floor?: string;
  floorLabel?: string;
  date: string;
  customerName?: string;
  phone?: string;
  email?: string;
  companyName?: string;
  amenities?: Array<{ name: string; price: number; qty: number }>;
  amenitiesTotal?: number;
  advanceAmount?: number;
  advanceMode?: string;
  advanceRef?: string;
  advancePaidAt?: string;
  partySize?: number;
  arrivalTime?: string;
  actualArrivalTime?: string;
  bookingRef?: string;
  bookedAt?: string;
  source?: string;
  tabRounds?: HodTabRound[];
  tabTotal?: number;
  orderTotal?: number;
  paymentStatus?: string;
  paymentMode?: string;
  amountPaid?: number;
  paidAt?: string;
  captainName?: string;
  status?: string;
  /** 🆕 2026-06-25 (Khushi) — role-based settlement. A normal captain (no
   *  canSettle permission) taps "NOTIFY SUPERVISOR TO SETTLE BILL", which sets
   *  this flag; authorized captains see it in the SETTLE BILL tab (pulsing red +
   *  beep) and settle + release. Cleared on settle/release. Display/flag only —
   *  never a money field. */
  settleRequested?: boolean;
  settleRequestedBy?: string;
  settleRequestedAt?: string;
  settleRequestFloor?: string;
  needsManualReview?: boolean;
  /** Free-text reason shown on a NEEDS-REVIEW row (e.g. why it needs attention). */
  manualReviewReason?: string;
  /** 🆕 2026-06-17 — TRUE when this NEEDS-REVIEW row is an UNMATCHED CANCELLATION
   *  (an aggregator cancel email/SMS that could not be auto-matched to a booking).
   *  Door staff must find the guest and free the right table by hand. Rendered with
   *  a loud red "CANCELLED — VERIFY" badge, distinct from a normal ⚠ Review row. */
  isCancellationReview?: boolean;
  aggregator?: string;
  aggregatorDiscount?: number;
  /** TRUE only when a captain explicitly edited the discount % via the
   *  Source/Discount panel APPLY button (or markTablePaid manualDiscount).
   *  FALSE/undefined when the booking was created with a non-default discount
   *  by the website (hodclub.in) or admin.html — those are NOT captain edits
   *  and must NOT show the ✎ MODIFIED chip. */
  discountModifiedByCaptain?: boolean;
  discountPercent?: number;
  discountAmount?: number;
  taxAmount?: number;
  /** ₹ service charge actually applied at settlement (markTablePaid). May be
   *  absent on older/unsettled docs. */
  serviceChargeAmount?: number;
  /** FALSE only when a manager-PIN SC waiver was applied at settlement; TRUE/
   *  undefined otherwise. Lets read-only views (e.g. TABLE TRANSACTIONS) honour
   *  the waiver instead of recomputing SC at the standard rate. */
  serviceChargeApplied?: boolean;
  // ── Bill-print audit / anti-fraud (added in print-server v3.5 hardening) ──
  /** How many times a thermal bill has been printed for this reservation. */
  billPrintCount?: number;
  /** ISO timestamp of the FIRST bill print (used to compute "duplicate" flag). */
  billFirstPrintedAt?: string;
  /** ISO timestamp of the most recent bill print. */
  lastBillPrintedAt?: string;
  /** Append-only audit trail: every bill print lands here. */
  billPrintLog?: Array<{
    at: string; by: string; total: number; discountPct: number;
    aggregator: string; isDuplicate: boolean; billNumber: string;
  }>;
  /** Set to true when items are added/edited AFTER a bill has been printed.
   *  Captain card shows a red "REPRINT REQUIRED" banner while this is true. */
  billStale?: boolean;
  /** D1/D2 — Manager-PIN-approved discount or service-charge waivers, append-only.
   *  Each entry = one over-threshold approval at Mark-Paid time. */
  discountOverrideLog?: Array<{
    at: string; by: string; kind: "high-discount" | "sc-waiver" | "walkin-discount";
    valueBefore: number; valueAfter: number; tabTotal: number; reason: string;
  }>;
  /** V1 — Append-only log of items voided AFTER a KOT was already activated/served.
   *  Captures who removed what, when, and the value lost. */
  voidLog?: Array<{
    at: string; by: string; roundNum: number; roundStatus: string;
    voided: Array<{ n: string; qty: number; p: number }>;
    valueLost: number; reason?: string;
  }>;
  /** Snapshot of source/discount taken at first bill print — captains who try
   *  to swap aggregator after this point need a Manager PIN. */
  billLockedSource?: string;
  billLockedDiscount?: number;
  // ── 2026-05-15 — CAPTAIN × COVER WALLET REDEMPTION (Khushi spec) ──
  /** Append-only ledger of every wallet redemption against this table.
   *  Each entry = one customer's wallet hit. Captain Mode shows the running
   *  list inside Mark-Paid modal; Reports + Sheets sync read this to show
   *  the wallet/cash split so cash-drawer EOD reconciles cleanly. */
  walletRedemptions?: WalletRedemption[];
  /** Convenience: sum of `walletRedemptions[].amount` cached at markPaid time
   *  so Reports can sort/filter without unrolling the array. */
  walletPaidAmount?: number;
  // ── 2026-05-20 — COVER+TABLE LINKED WALLET (Khushi spec) ──
  /** TRUE when door girl created this table via "💰 ACTIVATE COVER + TABLE"
   *  flow and the linked cover doc was successfully written. Drives captain
   *  UX: gold badge on table card + banner in bill drawer + 1-tap redeem
   *  button in Mark Paid modal (skips QR scan / phone lookup). */
  hasLinkedCover?: boolean;
  /** Public ref of the linked cover (HOD-XXX) — surfaced in captain UI. */
  linkedCoverRef?: string;
  /** Firestore doc id of the linked cover. Used by 1-tap redeem to call
   *  redeemFromWalletAtTable without lookup. */
  linkedCoverDocId?: string;
  /** Initial wallet balance at link time — used as cheap fallback display
   *  when the live cover doc hasn't loaded yet. */
  linkedCoverInitial?: number;
  /** ISO timestamp of when link was committed. */
  linkedCoverLinkedAt?: string;
  /** TRUE between table-create and cover-activate; FALSE once linked. The
   *  door flow flips this to FALSE inside linkCoverToTable. */
  linkedCoverPending?: boolean;
  // ── 2026-05-20 — CUSTOMER-CALLS-CAPTAIN (Khushi spec) ──
  /** Set by the customer site when a LINKED-WALLET guest taps the "🍽 I'M AT
   *  MY TABLE — CALL MY CAPTAIN" button on hodclub.in/?wallet=XXX. Captain
   *  tablet pulses RED on the table card with "🔔 CUSTOMER CALLING" until
   *  captain taps "✓ ON IT" (which clears the field).
   *
   *  Fail-open: if write fails, customer site shows a fallback hint; if
   *  read fails on captain tablet, table card just doesn't pulse (same as
   *  before this feature). Customer can still walk over / wave. */
  customerCallRequest?: {
    /** ISO timestamp of when customer tapped CALL CAPTAIN. */
    at: string;
    /** Optional cart preview ("2× Kingfisher, 1× Fries") for context. */
    itemsPreview?: string;
    /** Optional cart total in rupees. */
    total?: number;
  } | null;
  /** 2026-05-20 — append-only log of every customer call captain dismissed.
   *  Captain can re-read what the customer wanted AFTER tapping ✓ ON IT, so
   *  they never lose context if they forget the items between dismiss and
   *  walking to the table. UI shows the most-recent entry as a yellow
   *  "📜 LAST CALL · N MIN AGO" strip for 30 min after dismissal. */
  customerCallHistory?: Array<{
    at: string;
    itemsPreview?: string;
    total?: number;
    dismissedAt: string;
    dismissedBy?: string;
  }>;
}

/** 2026-05-15 — One redemption hit against a customer wallet at table close.
 *  Multiple entries allowed per table (Rahul + friend each redeeming separately).
 *  Race-safe: written atomically inside redeemFromWalletAtTable runTransaction. */
export interface WalletRedemption {
  /** Public customer-facing wallet ref (HOD-XXX) — used for display, dedup,
   *  and the per-table "already redeemed" check. NOT necessarily the
   *  Firestore doc id. */
  walletRef: string;
  /** Firestore doc id of the cover (HodCover.id). For table-source bookings
   *  this differs from `walletRef`. Required for `undoWalletRedemption` to
   *  refund the correct doc. Optional for backward-compat with legacy entries
   *  written before 2026-05-15 (those fall back to walletRef as the doc id). */
  walletDocId?: string;
  /** Customer name snapshot at redemption time (so guest renames don't rewrite history). */
  walletName: string;
  /** Phone snapshot — surfaced in audit + Reports. */
  walletPhone?: string;
  /** ₹ deducted from this wallet (already auto-clamped to min(requested, balance)). */
  amount: number;
  /** ISO timestamp of redemption. */
  redeemedAt: string;
  /** Captain who tapped REDEEM. */
  redeemedBy: string;
  /** Idempotency / undo key — `${tableDocId}-${walletRef}-${epochMs}`. */
  txId: string;
}

export interface HodBooking {
  id: string;
  ref: string;
  name?: string;
  phone?: string;
  /** Captured by hodclub.in booking form. Required field on the website but
   *  legacy bookings may be missing it — UI defaults to "—". */
  email?: string;
  guests?: number;
  type?: string;
  tier?: string;
  eventId?: string;
  eventTitle?: string;
  total?: number;
  paymentId?: string;
  checkedIn?: boolean;
  date?: string;
  _isTable?: boolean;
  _isGuestList?: boolean;
}

export interface HodGuestlistEntry {
  id: string;
  name: string;
  phone?: string;
  eventId?: string;
  eventTitle?: string;
  type?: string;
  checkedIn?: boolean;
  entryType?: string;
  entryTime?: string;
  checkedInBy?: string;
  joinedAt?: string;
}

export async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const KOT_ENDPOINT_KEY = "hod_kot_print_endpoint";
const DEFAULT_KOT_ENDPOINT = "http://192.168.0.97:3001/print";

export function getKotEndpoint(): string {
  return localStorage.getItem(KOT_ENDPOINT_KEY) || DEFAULT_KOT_ENDPOINT;
}
export function setKotEndpoint(url: string): void {
  localStorage.setItem(KOT_ENDPOINT_KEY, url);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tablet-floor binding (Cloud-Routed Printing). Each tablet stores which floor
// it's "based on" so drinks/bills route to the correct floor's printer when a
// captain fires a KOT. Set ONCE per tablet via admin → "Set This Tablet's Floor".
// ─────────────────────────────────────────────────────────────────────────────
export type TabletFloor = "ground" | "first" | "rooftop";
const TABLET_FLOOR_KEY = "hod_tablet_floor";
export function getTabletFloor(): TabletFloor | null {
  const v = localStorage.getItem(TABLET_FLOOR_KEY);
  return v === "ground" || v === "first" || v === "rooftop" ? v : null;
}
export function setTabletFloor(f: TabletFloor): void {
  localStorage.setItem(TABLET_FLOOR_KEY, f);
}
function floorTag(f: TabletFloor | null, kind: "bar" | "bill"): string {
  const map: Record<TabletFloor, string> = { ground: "gf", first: "ff", rooftop: "rt" };
  const prefix = f ? map[f] : "ff"; // safe default — FF has confirmed working printer
  return `${prefix}_${kind}`;
}
/** Derive cloud-print destination for a KOT line item.
 *  Food → kitchen (2F handles all floors' food).
 *  Drink → floor's own bar — Darshan venue map (2026-05-08):
 *    - GROUND tablet → gf_bar (.55)  — GF has large bar
 *    - FIRST  tablet → ff_bar (.15)  — FF has bar
 *    - ROOFTOP tablet → ff_bar (.15) — RT has NO bar; FF bar (one floor down) makes it, runners carry up
 *  Override-able by `it.dest`. */
export function deriveItemDestination(it: HodOrderItem & { dest?: string }, tabletFloor: TabletFloor | null): string {
  if (it.dest) return it.dest;
  if (it.t === "food") return "kitchen";
  // Rooftop has no bar → drinks made at FF bar
  if (tabletFloor === "rooftop") return "ff_bar";
  return floorTag(tabletFloor, "bar");
}

const COVERS_COL = "covers";
const TABLE_RES_COL = "tableReservations";

// 🆕 2026-06-05 v3.221 — CRITICAL RELIABILITY (Khushi BUG: "click RECHARGE / PRINT
// KOT and nothing happens, screen frozen, taps do nothing, had to close & reopen
// the app — then the recharge had gone through").
// ROOT CAUSE: Firestore `runTransaction` REQUIRES a live server round-trip; it does
// NOT resolve from the offline/persistent cache. On stalled venue WiFi / Android
// WebView transports the transaction's `txn.get()` can hang indefinitely, so the
// awaiting call site (doRecharge/doActivate) never resolves AND never rejects →
// setRcBusy/setActBusy stays true forever → the screen looks frozen. The write
// often DID commit server-side, which is why it appeared after a force-restart
// (fresh connection delivered it).
// FIX: race every money/print transaction against a timeout so a stalled transport
// becomes a clean REJECTION (caught at the call site → busy flag reset → friendly
// "network slow, rescan before retrying" message) instead of an infinite hang.
// Safe against the rare case where it times out client-side but commits anyway:
// recharge has a 60s same-amount duplicate-confirm guard, and activate has a 30s
// in-transaction cooldown guard — both prevent an accidental double on retry.
export const TXN_TIMEOUT_MS = 15000;
export function withTxnTimeout<T>(
  p: Promise<T>,
  ms: number = TXN_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error("NETWORK_SLOW")), ms);
    p.then(
      (v) => { clearTimeout(id); resolve(v); },
      (e) => { clearTimeout(id); reject(e); },
    );
  });
}

// 🔴 2026-05-21 (Khushi) — easy-to-read category-prefixed refs (6 digits).
// TIC=ticket · GL=guestlist · ENT=entry-only · TAB=table · GRP=group.
// Legacy refs (HOD-XXXXXXXX, WALK-…, WI-…, GL-…, CORP-…) keep working — all
// Firestore reads are key-based, not prefix-parsed. Wallet routing on the
// customer site was updated to accept both old and new TAB/GL formats.
// AGG- / PROXY- refs intentionally NOT switched: AGG- is parsed by the
// aggregator-detection filter (`startsWith('AGG-')`) at several read sites
// and PROXY- encodes the proxy operator's name in the ref for the audit
// trail. Both stay as-is.
export type HodRefCategory = "ticket" | "guestlist" | "entryonly" | "table" | "group";
export function mintHodRef(cat: HodRefCategory): string {
  const P: Record<HodRefCategory, string> = { ticket: "TIC", guestlist: "GL", entryonly: "ENT", table: "TAB", group: "GRP" };
  // 6 digits — 900k space per category. Collision probability is negligible
  // (≪0.001% per night at typical volume). Caller can retry on setDoc
  // conflict; fail-open philosophy.
  const n = Math.floor(100000 + Math.random() * 900000);
  return `HOD${P[cat]}${n}`;
}
const TABLE_HISTORY_COL = "tableHistory";
const BOOKINGS_COL = "bookings";
const GUESTLIST_COL = "guestlist";
const BAR_SESSIONS_COL = "barSessions";
const EVENTS_COL = "events";

/** Full event schema — mirrors hodclub.in `events` collection 1:1.
 *  Customers booking on hodclub.in read these fields; admin edits flow back
 *  to the same Firestore doc so the website updates instantly. */
export interface HodEvent {
  id: string;
  title: string;
  dj?: string;
  date: string;            // YYYY-MM-DD
  time?: string;           // "9:00 PM"
  endTime?: string;        // "3:00 AM"
  venue?: string;
  genre?: string;
  capacity?: number;
  price?: number;          // base cover charge
  stagPrice?: number;
  couplePrice?: number;
  groupPrice?: number;     // legacy 4-pax flat price
  groupPerHeadPrice?: number;
  entryOnlyPrice?: number; // door entry, NOT redeemable on F&B
  table4Price?: number;    // GF table for 4 (redeemable)
  vipPrice?: number;       // VVIP table (redeemable)
  gf4Stock?: number;       // nightly stock — resets 6AM
  vvipStock?: number;      // nightly stock — resets 6AM
  _gf4Default?: number;    // snapshot for 6AM reset
  _vvipDefault?: number;
  sold?: number;
  description?: string;
  color?: string;          // hex
  image?: string;          // URL or base64 data:image/...
  published?: boolean;
  // legacy single-field artist support (some old docs)
  artist?: string;
  startTime?: string;
}

export function subscribeToHodEvents(cb: (events: HodEvent[]) => void): () => void {
  // v3.94 shared listener — collapses N callers to 1 Firestore phone line.
  // UNFILTERED — returns entire events collection. KEPT for EventsAdmin only
  // (admin needs to manage historical events). Door/Captain/Bar should use
  // subscribeToHodEventsRecent below — see v3.96 note.
  return _shareSubscription<HodEvent[]>(
    "events:all",
    (push) => onSnapshot(collection(db, EVENTS_COL), (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() } as HodEvent));
      list.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      push(list);
    }, () => push([])),
    cb,
  );
}

// 🆕 2026-05-27 v3.96 — Date-scoped events subscription for operational
// surfaces (Door/Captain/Bar). Mirrors the customer-site cutoff in v3.95:
// only events whose `date` >= (today − daysBack) are returned. EventsAdmin
// continues to use subscribeToHodEvents (unfiltered) because admins need to
// edit historical events.
//
// Why: subscribeToHodEvents returns the ENTIRE events collection on every
// mount + on every event doc write. As the venue accumulates months of past
// events, every Door tablet pays 100+ reads on initial subscribe just to see
// tonight's gig. This bounded variant caps the read cost at ~14 docs (one
// week of past + future events).
//
// Shared-listener key includes daysBack so different callers with different
// windows don't collide. Single-field index on `date` is auto-created by
// Firestore (no composite index needed).
//
// 🛟 FAIL-OPEN: error callback pushes [] — caller treats as "no events", same
// as the unfiltered variant. Calling code already tolerates empty events
// arrays (renders cached/localStorage fallback).
export function subscribeToHodEventsRecent(
  daysBack: number,
  cb: (events: HodEvent[]) => void,
): () => void {
  const cutoff = (() => {
    const d = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  })();
  return _shareSubscription<HodEvent[]>(
    `events:recent:${cutoff}`,
    (push) => onSnapshot(
      query(collection(db, EVENTS_COL), where("date", ">=", cutoff), orderBy("date")),
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() } as HodEvent));
        push(list);
      },
      () => push([]),
    ),
    cb,
  );
}

/** Create a new event (auto-generated id). Returns the new id. */
export async function createHodEvent(data: Partial<HodEvent>): Promise<string> {
  const id = `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const clean = normalizeEvent({ ...data, id });
  // Snapshot defaults for 6AM auto-reset
  clean._gf4Default = clean.gf4Stock;
  clean._vvipDefault = clean.vvipStock;
  await setDoc(doc(db, EVENTS_COL, id), clean);
  return id;
}

/** Update an existing event. Re-snapshots stock defaults so 6AM reset
 *  always restores to the latest admin-saved values.
 *
 *  ⚠️ MONEY-CRITICAL: NEVER write `sold` here. Customers book on hodclub.in
 *  in real time; if we send a stale `sold` back, paid bookings are erased
 *  and the door staff lets in too many people. Same for `_gf4Default`/
 *  `_vvipDefault` snapshots — only re-derived from gf4Stock/vvipStock when
 *  the admin actually edits stock numbers (handled below by whitelist). */
export async function updateHodEvent(id: string, data: Partial<HodEvent>): Promise<void> {
  const clean = normalizeEvent({ ...data, id });
  // Whitelist of fields the admin form is allowed to overwrite.
  // `sold` is intentionally excluded — only Firestore txns from the booking
  // flow (increment) may touch it.
  const patch: Record<string, unknown> = {
    title: clean.title,
    dj: clean.dj,
    date: clean.date,
    time: clean.time,
    endTime: clean.endTime,
    venue: clean.venue,
    genre: clean.genre,
    capacity: clean.capacity,
    price: clean.price,
    stagPrice: clean.stagPrice,
    couplePrice: clean.couplePrice,
    groupPrice: clean.groupPrice,
    groupPerHeadPrice: clean.groupPerHeadPrice,
    entryOnlyPrice: clean.entryOnlyPrice,
    table4Price: clean.table4Price,
    vipPrice: clean.vipPrice,
    description: clean.description,
    color: clean.color,
    image: clean.image,
    published: clean.published,
  };
  // Stock + 6AM-reset snapshots only update if the admin actually edited
  // the stock fields. Detected by data containing the key (vs undefined).
  if (data.gf4Stock !== undefined) {
    patch.gf4Stock = clean.gf4Stock;
    patch._gf4Default = clean.gf4Stock;
  }
  if (data.vvipStock !== undefined) {
    patch.vvipStock = clean.vvipStock;
    patch._vvipDefault = clean.vvipStock;
  }
  await updateDoc(doc(db, EVENTS_COL, id), patch);
}

/** Toggle published flag (live → hidden or hidden → live). */
export async function toggleHodEventPublished(id: string, next: boolean): Promise<void> {
  await updateDoc(doc(db, EVENTS_COL, id), { published: next });
}

/** ⚡ Image-only patch — does NOT touch any other field. Safe to run during
 *  live bookings (no race with stock decrement / sold counter). Used by the
 *  Optimize Posters bulk re-compressor. */
export async function updateHodEventImageOnly(id: string, image: string): Promise<void> {
  await updateDoc(doc(db, EVENTS_COL, id), { image });
}

/** Bar-mode helper: search BOTH bookings + guestlist by name/phone/ref so the
 *  bartender can find any guest (not just cover wallets). Capped to 20 results. */
export interface HodGuestSearchHit {
  id: string; ref: string; name: string; phone: string;
  source: "booking" | "guestlist";
  eventId?: string; eventTitle?: string; type?: string; total?: number; checkedIn?: boolean; date?: string;
}
export async function searchBookingsAndGuestlist(needle: string, tonightDate?: string): Promise<HodGuestSearchHit[]> {
  const raw = String(needle || "").trim();
  if (raw.length < 2) return [];
  const lower = raw.toLowerCase();
  const digits = raw.replace(/\D/g, "");
  const out: HodGuestSearchHit[] = [];
  const matchPhone = (p?: string) => digits.length >= 4 && String(p || "").replace(/\D/g, "").includes(digits);
  const matchText = (s?: string) => !!s && String(s).toLowerCase().includes(lower);
  // V3 2026-05-11 — tonight-only scope. If tonightDate is provided, drop any
  // booking/guestlist entry whose event date isn't tonight. Fallback (Khushi):
  // entries with NO date field at all are kept (legitimate matches must never
  // disappear due to missing data — better to show 1 stale row than hide a
  // real customer).
  const isTonight = (d?: string) => !tonightDate || !d || String(d).slice(0, 10) === tonightDate;

  try {
    const [bSnap, gSnap] = await Promise.all([
      getDocs(query(collection(db, BOOKINGS_COL), limit(500))),
      getDocs(query(collection(db, GUESTLIST_COL), limit(500))),
    ]);
    for (const d of bSnap.docs) {
      const b = d.data() as any;
      if (!isTonight(b.date)) continue;
      if (matchText(b.name) || matchPhone(b.phone) || matchText(b.ref)) {
        out.push({
          id: d.id, ref: b.ref || d.id, name: b.name || "", phone: b.phone || "",
          source: "booking", eventId: b.eventId || "", eventTitle: b.eventTitle || "", type: b.entryType || b.type || "",
          total: b.total || 0, checkedIn: !!b.checkedIn, date: b.date || "",
        });
      }
    }
    for (const d of gSnap.docs) {
      const g = d.data() as any;
      // Guestlist may have `date` (event date) OR fall back to `joinedAt` slice.
      const gDate = g.date || (g.joinedAt || "").slice(0, 10);
      if (!isTonight(gDate)) continue;
      if (matchText(g.name) || matchPhone(g.phone) || matchText(g.ref)) {
        out.push({
          id: d.id, ref: g.ref || d.id, name: g.name || "", phone: g.phone || "",
          source: "guestlist", eventId: g.eventId || "", eventTitle: g.eventTitle || "",
          type: g.type || "", checkedIn: !!g.checkedIn,
          date: gDate,
        });
      }
    }
  } catch (e) {
    console.warn("[searchBookingsAndGuestlist] failed", e);
  }
  const seen = new Set<string>();
  return out.filter((r) => { if (seen.has(r.id)) return false; seen.add(r.id); return true; }).slice(0, 20);
}

/** Delete an event permanently. Caller must confirm with the user. */
export async function deleteHodEvent(id: string): Promise<void> {
  await deleteDoc(doc(db, EVENTS_COL, id));
}

// 🆕 2026-05-24 (Khushi) — Auto-cleanup of expired event posters. Khushi wants
// posters auto-removed once an event is over so old events don't clutter the
// customer site or door tablet (and don't bloat the events collection, which
// every page subscribes to). Runs on EventsAdmin mount + can be called manually.
//
// Deletes events where `date` is more than `graceDays` days in the past
// (default 2 — gives operator a one-day window after the event to fix any
// reconciliation before the poster vanishes).
//
// 🛟 Fail-open: if any single delete fails (rules / network), it's logged and
// skipped — the rest still delete. Returns { deleted, skipped, errors }.
// Note: if the poster was uploaded to Firebase Storage and the doc only had
// a URL reference, the storage object is NOT deleted here (would need
// admin SDK / storage delete API). Firestore-side cleanup is enough for the
// app to stop showing it.
export async function deleteExpiredHodEvents(
  graceDays: number = 2,
): Promise<{ deleted: number; skipped: number; errors: string[] }> {
  const errors: string[] = [];
  let deleted = 0;
  let skipped = 0;
  try {
    const cutoffMs = Date.now() - graceDays * 24 * 60 * 60 * 1000;
    const cutoffDate = new Date(cutoffMs);
    const cutoffStr =
      `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, "0")}-${String(cutoffDate.getDate()).padStart(2, "0")}`;
    const snap = await getDocs(collection(db, EVENTS_COL));
    for (const d of snap.docs) {
      const data = d.data() as Partial<HodEvent>;
      const evDate = String(data.date || "").trim();
      // Only delete if we can confidently parse a YYYY-MM-DD that is strictly
      // older than the cutoff. Unparseable dates are SKIPPED (fail-open — never
      // delete an event whose date format we don't understand).
      if (!/^\d{4}-\d{2}-\d{2}$/.test(evDate)) { skipped++; continue; }
      if (evDate >= cutoffStr) { skipped++; continue; }
      try {
        await deleteDoc(doc(db, EVENTS_COL, d.id));
        deleted++;
      } catch (e: any) {
        errors.push(`${d.id}: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    errors.push(`scan failed: ${e?.message || e}`);
  }
  return { deleted, skipped, errors };
}

/** Coerce + default all fields the same way hodclub does, so the customer
 *  page never sees NaN/undefined and Razorpay always gets a real number. */
function normalizeEvent(d: Partial<HodEvent>): HodEvent {
  const n = (v: unknown, fb: number) => {
    const x = Number(v); return isFinite(x) && x >= 0 ? x : fb;
  };
  return {
    id: d.id || "",
    title: (d.title || "").trim() || "Untitled Event",
    dj: d.dj || "",
    date: d.date || "",
    time: d.time || "9:00 PM",
    endTime: d.endTime || "3:00 AM",
    venue: d.venue || "HOD Rooftop — Koramangala, 7th Block",
    genre: d.genre || "",
    capacity: n(d.capacity, 150),
    price: n(d.price, 999),
    stagPrice: n(d.stagPrice, 999),
    couplePrice: n(d.couplePrice, 1499),
    groupPrice: n(d.groupPrice, 2999),
    groupPerHeadPrice: n(d.groupPerHeadPrice, 500),
    entryOnlyPrice: n(d.entryOnlyPrice, 599),
    table4Price: n(d.table4Price, 5000),
    vipPrice: n(d.vipPrice, 15000),
    gf4Stock: n(d.gf4Stock, 4),
    vvipStock: n(d.vvipStock, 2),
    sold: n(d.sold, 0),
    description: d.description || "",
    color: d.color || "#C9A84C",
    image: d.image || "",
    published: d.published === true,
  };
}
const MENU_OVERRIDES_COL = "posMenuOverrides";

export const AGGREGATOR_OPTIONS = [
  { value: "inhouse", label: "In-House (Walk-in)", discount: 0 },
  { value: "zomato", label: "Zomato Dining", discount: 30 },
  { value: "swiggy-dineout", label: "Swiggy Dineout", discount: 30 },
  { value: "swiggy-scenes", label: "Swiggy Scenes", discount: 0 },
  { value: "magicpin", label: "Magicpin", discount: 0 },
  { value: "eazydiner", label: "EazyDiner", discount: 15 },
  { value: "others", label: "Other Aggregator", discount: 0 },
] as const;

export function getAggregatorDiscount(name: string): number {
  const agg = AGGREGATOR_OPTIONS.find((a) => a.value === name);
  return agg?.discount ?? 0;
}

export function coverDocIdFor(bookingId: string): string {
  return (bookingId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

export async function getCoverForBooking(bookingId: string): Promise<HodCover | null> {
  if (!bookingId) return null;
  const docId = coverDocIdFor(bookingId);
  const direct = await getDoc(doc(db, COVERS_COL, docId));
  if (direct.exists()) return { id: direct.id, ...direct.data() } as HodCover;
  const q = query(collection(db, COVERS_COL), where("bookingId", "==", bookingId), limit(1));
  const snap = await getDocs(q);
  if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() } as HodCover;
  return null;
}

export interface PaymentSplit {
  cash?: number;
  upi?: number;
  card?: number;
  paid_online?: number;
}

export interface ActivateCoverInput {
  booking: HodBooking & { _glDocId?: string };
  amount: number;
  paymentMethod: "cash" | "upi" | "card" | "paid_online" | "split";
  paymentSplit?: PaymentSplit;
  staffName: string;
}

export async function activateCoverForBooking(input: ActivateCoverInput): Promise<{ id: string; cover: HodCover }> {
  const { booking, amount, paymentMethod, paymentSplit, staffName } = input;
  if (paymentMethod === "split") {
    if (!paymentSplit) throw new Error("Payment split breakdown required");
    const sum = (paymentSplit.cash || 0) + (paymentSplit.upi || 0) + (paymentSplit.card || 0) + (paymentSplit.paid_online || 0);
    if (sum !== amount) throw new Error(`Split total ₹${sum} must equal cover amount ₹${amount}`);
  }
  if (!amount || amount < 1) throw new Error("Enter a valid cover amount");
  if (amount > 50000) throw new Error("Cover amount cannot exceed ₹50,000");
  // 🔴 BUGFIX 2026-05-19 (Khushi LIVE-NIGHT) — PREFER booking.ref (HOD-XXX)
  // over booking.id (firestore auto-uid). Customer site saves bookings with
  // id=uid() and ref='HOD-XXX', and ALWAYS keys cover docs by ref. Wallet
  // URL hodclub.in/?wallet=HOD-XXX reads `where ref==HOD-XXX`. If we key by
  // booking.id (UUID), we write to a DIFFERENT doc and the wallet never
  // updates (it keeps reading the cloud-function/customer-side 0-stub).
  const bookingId = booking.ref || booking.id;
  if (!bookingId) throw new Error("Booking has no id/ref");
  const docId = coverDocIdFor(bookingId);
  const ref = doc(db, COVERS_COL, docId);

  // 2026-05-16 — `logNotificationOutcome` (auto-WA) writes a NOTIFICATION-ONLY
  // stub doc immediately after booking save (no ref/balance/activated fields).
  // We must NOT mistake that stub for a real activation. Real activation =
  // `coverActivated > 0`. If the stub is here we upsert the real cover OVER it.
  const existing = await getDoc(ref);
  if (existing.exists()) {
    const ex = existing.data() as any;
    const alreadyReal = (ex?.coverActivated || 0) > 0 || (ex?.coverBalance || 0) > 0;
    if (alreadyReal) throw new Error("Cover already activated for this booking");
  }

  const isCash = booking.paymentId && booking.paymentId.startsWith("cash_");
  const paidOnline = isCash ? 0 : (booking.total || 0);
  const diff = Math.max(0, amount - paidOnline);
  const today = getOperationalNightStr();
  const expDate = getCoverExpiryFor(today);

  // 🆕 2026-05-27 v3.50 (Khushi LIVE-NIGHT) — detect table bookings EARLY so we
  // can stamp `isTableBooking: true` onto the covers doc itself. Bug we're
  // fixing: customer site wallet listener (`hodclub-patched/index.html` line
  // 7625) picks up the COVERS doc once it exists. If isTableBooking isn't on
  // that doc, the order-placed popup falls to bartender copy ("show to
  // bartender") instead of captain copy ("captain will be with you shortly").
  // Same detection logic as the mirror block below — kept duplicated here
  // because we need the flag at cover-write time, and we want both writes to
  // succeed/fail independently (fail-open).
  const _earlyTtype = String((booking as any).tableType || "").toLowerCase();
  const _earlyRefStr = String(booking.ref || "");
  const _earlyLooksLikeTableRef = _earlyRefStr.startsWith("HODTAB") || _earlyRefStr.startsWith("TBL-") || _earlyRefStr.startsWith("AGG-");
  const _coverIsTable = !!booking._isTable
    || _earlyTtype === "table4" || _earlyTtype === "vip" || _earlyTtype === "vvip"
    || _earlyLooksLikeTableRef;

  const cover: Record<string, unknown> = {
    bookingId,
    ref: booking.ref || bookingId,
    name: booking.name || "",
    phone: (booking.phone || "").replace(/\D/g, "").slice(-10),
    email: (booking as any).email || "",
    eventId: booking.eventId || "",
    // Skip eventTitle for table-source bookings — they have no event, and
    // earlier code copied the table id into here by mistake (see lookupBooking).
    eventTitle: booking._isTable ? "" : (booking.eventTitle || ""),
    // v3.50: stamp the table flag so customer-side covers listener routes the
    // order-placed popup to the captain branch (cv.isTableBooking check at
    // hodclub-patched/index.html ~line 6515).
    isTableBooking: _coverIsTable,
    ...(_coverIsTable ? {
      tableId: String((booking as any)._tableId || (booking as any).tableId || ""),
      floorLabel: String((booking as any)._floorLabel || (booking as any).floorLabel || ""),
      bookingRef: booking.ref || bookingId,
    } : {}),
    coverPaid: paidOnline,
    coverActivated: amount,
    coverBalance: amount,
    pendingTopUp: 0,
    coverUsed: 0,
    diffAmount: diff,
    diffMethod: paymentMethod === "paid_online" ? "none" : paymentMethod,
    paymentMethod,
    ...(paymentSplit ? { paymentSplit } : {}),
    isGuestList: !!booking._isGuestList,
    activatedAt: new Date().toISOString(),
    activatedBy: staffName,
    transactions: [],
    expiresAt: expDate.toISOString(),
    checkedIn: true,
    date: booking.date || today,
    topUpTotal: 0,
    groupSize: (booking as any).qty || 1,
    coverDocId: docId,
    // 🔴 2026-05-29 (Khushi) — was hardcoded "walkin_door_cover", which made
    // Reports.classifyWallet() (startsWith("walkin")) tag EVERY door-activated
    // cover as WALK-IN — including online "buy covers" bookings. By Khushi's
    // definition, WALK-IN means ONLY a door-minted "+ NEW WALK-IN" (those use
    // createWalkInTable / createBarWalkinCover, which keep their own walkin_*
    // source). A cover activated against an EXISTING booking is an in-house
    // COVER. Derive from origin so Reports buckets it correctly: guestlist →
    // GUESTLIST, entry-only/group → their buckets (via entryType + isGuestList
    // flag, both already on this doc), stag/couple/female → COVER (default).
    source: booking._isGuestList ? "guestlist" : "inhouse_cover",
  };
  // merge:true → upserts cleanly OVER the notification-only stub if it exists.
  await setDoc(ref, cover, { merge: true });

  // If guestlist, log payment method on the GL doc too
  if (booking._isGuestList && (booking as any)._glDocId) {
    await updateDoc(doc(db, GUESTLIST_COL, (booking as any)._glDocId), {
      paymentMethod, coverAmount: amount, checkedIn: true, entryType: "cover",
      entryTime: new Date().toISOString(), checkedInBy: staffName,
    }).catch(() => {});
  }

  // 2026-05-12 — also mirror checkedIn onto the booking doc itself so the
  // Door Mode tabs (which filter on `booking.checkedIn`) move the row out
  // of PENDING and into CHECKED-IN counters live. Without this mirror,
  // activating a cover only marked the cover doc, leaving the booking row
  // stuck in the pending list.
  if (!booking._isGuestList && !booking._isTable) {
    const targetCol = BOOKINGS_COL;
    const targetId = booking.id || booking.ref;
    if (targetId) {
      await updateDoc(doc(db, targetCol, targetId), {
        checkedIn: true,
        checkedInAt: new Date().toISOString(),
        checkedInBy: staffName,
      }).catch(() => {});
    }
  }

  // 🔴 2026-05-25 (Khushi LIVE-NIGHT) — TABLE-BOOKING COVER MIRROR.
  // hodclub.in/?wallet=TBL-XXX reads coverBalance/coverActivated from
  // the tableReservations doc (NOT the covers doc — see customer site
  // _startTableListener line ~6952). Without this mirror, activating a
  // ₹1000 cover on a table writes to `covers` but the customer page
  // keeps reading `tableReservations.coverBalance=0` and shows nothing.
  // Lookup is by `bookingRef` (TBL-XXXXX) since the doc id is the
  // composite slot key (date_tableId_HHMM). Fail-open: if the lookup
  // misses or the write fails, the covers doc is still active and the
  // captain Bar Mode tab can still redeem against it — only the
  // customer-side visibility breaks.
  // 🆕 2026-05-27 v3.49 (Khushi LIVE-NIGHT) — broadened gate. HODTAB Razorpay
  // bookings loaded from `bookings` carry `tableType: 'table4'|'vip'|'vvip'`
  // but DO NOT carry the `_isTable` flag (that flag is only set by paths
  // that synthesise a booking from a tableReservations doc — DoorMode line
  // 3448, BookingDetailModal). Door's scanner check-in path → handleConfirm
  // → activateCoverForBooking with the raw bookings-coll object, so the
  // mirror never fired for cash-pending or even Razorpay-paid HODTAB bookings
  // checked in via the QR scanner. Result: POS showed "✓ COVER ACTIVATED
  // ₹5,000" (reads `covers`) but customer wallet stayed at ₹0 (reads
  // `tableReservations.coverBalance`). Now we also trigger the mirror when
  // (a) tableType is set, or (b) the ref looks like a table ref (HODTAB/
  // TBL-/AGG-). Same defensive lookup `where bookingRef==ref` so a non-
  // table ref that accidentally matches one of these patterns still no-ops
  // safely on `snap.empty`.
  const _ttype = String((booking as any).tableType || "").toLowerCase();
  const _refStr = String(booking.ref || "");
  const _looksLikeTableRef = _refStr.startsWith("HODTAB") || _refStr.startsWith("TBL-") || _refStr.startsWith("AGG-");
  const _isTableForMirror = !!booking._isTable
    || _ttype === "table4" || _ttype === "vip" || _ttype === "vvip"
    || _looksLikeTableRef;
  if (_isTableForMirror && booking.ref) {
    try {
      const q = query(collection(db, TABLE_RES_COL), where("bookingRef", "==", booking.ref), limit(1));
      const snap = await getDocs(q);
      if (!snap.empty) {
        const tableDocRef = snap.docs[0].ref;
        await updateDoc(tableDocRef, {
          coverActivated: amount,
          coverBalance: amount,
          coverPaid: paidOnline,
          coverUsed: 0,
          coverPaymentMethod: paymentMethod,
          ...(paymentSplit ? { coverPaymentSplit: paymentSplit } : {}),
          coverActivatedAt: new Date().toISOString(),
          coverActivatedBy: staffName,
          coverDocId: docId,
        });
      } else {
        console.warn("[activateCoverForBooking] no tableReservations doc found for bookingRef", booking.ref);
      }
    } catch (mirrorErr) {
      console.warn("[activateCoverForBooking] table mirror write failed (non-fatal)", mirrorErr);
    }
  }

  return { id: docId, cover: { id: docId, ...cover } as HodCover };
}

// For aggregator (Zomato/Swiggy/EazyDiner) arrivals at the door:
// the customer never went through hodclub.in, so no covers doc exists and no
// HOD WhatsApp was ever sent. When door staff marks them "arrived", we mint a
// zero-balance covers doc so the wallet/menu URL (hodclub.in/?wallet=<ref>)
// resolves for them. Idempotent: returns existing doc if one is already there.
export async function ensureCoverForAggregatorArrival(input: {
  bookingRef: string;
  name: string;
  phone: string;
  source: string;          // "zomato" | "swiggy" | "eazydiner" | etc.
  partySize?: number;
  tableId?: string;
  staffName: string;
}): Promise<{ created: boolean; docId: string }> {
  const docId = input.bookingRef;
  if (!docId) throw new Error("Missing bookingRef");
  const ref = doc(db, COVERS_COL, docId);
  const existing = await getDoc(ref);
  if (existing.exists()) return { created: false, docId };

  const today = getOperationalNightStr();
  const expDate = getCoverExpiryFor(today);

  const cover: Record<string, unknown> = {
    bookingId: docId,
    ref: docId,
    name: input.name || "Guest",
    phone: (input.phone || "").replace(/\D/g, "").slice(-10),
    eventId: "",
    eventTitle: "",
    coverPaid: 0,
    coverActivated: 0,
    coverBalance: 0,
    pendingTopUp: 0,
    coverUsed: 0,
    diffAmount: 0,
    diffMethod: "none",
    paymentMethod: "aggregator",
    isGuestList: false,
    activatedAt: new Date().toISOString(),
    activatedBy: input.staffName,
    transactions: [],
    expiresAt: expDate.toISOString(),
    checkedIn: true,
    actualArrivalTime: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
    date: today,
    topUpTotal: 0,
    groupSize: input.partySize || 1,
    coverDocId: docId,
    source: `aggregator_arrival_${(input.source || "").toLowerCase()}`,
    aggregator: input.source,
    tableId: input.tableId || "",
    // 🔴 2026-05-19 (Khushi CRITICAL — live tonight) — aggregator arrivals
    // (Zomato/Swiggy/EazyDiner) AND WhatsApp-bot bookings (aggregator="whatsapp_bot")
    // are ALWAYS table bookings. Without this flag the customer site's wallet
    // page falls through to COVER-WALLET view (locked menu, "pay to top up")
    // instead of TABLE-TAB view (open menu, order freely). Table guests should
    // never see a cover wallet — they pay at the bill, not up-front.
    isTableBooking: true,
  };
  await setDoc(ref, cover);
  return { created: true, docId };
}

// 🎁 GUESTLIST FREE-ENTRY (2026-05-08): Door staff lets specific regulars in
// without activating a paid cover. They arrive at the bar and try to order —
// previously bartender saw "no wallet" and was stuck. This helper mints a
// zero-balance covers doc on the spot so:
//   • Bartender can immediately top them up at the bar (rechargeCover), OR
//   • Customer can self-top-up from hodclub.in/?topup=<ref>
// Idempotent — returns existing doc if one already exists.
export async function ensureZeroBalanceCoverForGuest(input: {
  bookingRef: string;
  sourceDocId: string;     // doc id in bookings/guestlist collection (used to mirror check-in)
  name: string;
  phone: string;
  source: "guestlist" | "booking";  // origin collection (guestlist = free entry, booking = ticket-only)
  eventId?: string;
  eventTitle?: string;
  staffName: string;
}): Promise<{ created: boolean; docId: string; mirroredCheckIn: boolean }> {
  const docId = input.bookingRef;
  if (!docId) throw new Error("Missing bookingRef");
  await authReady;
  const ref = doc(db, COVERS_COL, docId);
  const today = getOperationalNightStr();
  const expDate = getCoverExpiryFor(today);
  const isFreeEntry = input.source === "guestlist";

  // Race-safe atomic upsert.
  //   • Doc missing → create the full ₹0 cover (original behavior).
  //   • Doc exists & already arrived (checkedIn:true OR actualArrivalTime set)
  //       → no-op, idempotent (concurrent double-taps / retries).
  //   • Doc exists but pre-arrival stub (v3.92 customer-site floor-picker TBL-*
  //       writes a ₹0 cover at booking time so `?wallet=TBL-XXX` resolves;
  //       that stub has NO checkedIn / actualArrivalTime) → STAMP arrival
  //       fields onto the existing doc. Without this stamp, customer's covers
  //       onSnapshot never fires on scanner check-in → wallet stays "locked"
  //       until manual refresh (Khushi LIVE-NIGHT 2026-05-27 v3.93).
  const created = await runTransaction(db, async (txn) => {
    const snap = await txn.get(ref);
    const nowIso = new Date().toISOString();
    const arrivalLabel = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    if (snap.exists()) {
      const ex = snap.data() as any;
      const alreadyArrived = !!ex?.checkedIn || !!ex?.actualArrivalTime;
      if (alreadyArrived) return false;
      // Pre-arrival stub from v3.92 — stamp arrival fields so the customer
      // wallet listener fires immediately. We only touch arrival-related
      // fields; balance / paymentMethod / source / activator stay as-is so
      // we never accidentally overwrite a real activation that raced in.
      txn.update(ref, {
        checkedIn: true,
        actualArrivalTime: arrivalLabel,
        activatedAt: nowIso,
        activatedBy: input.staffName,
        // Backfill identity in case the stub was written with sparse fields.
        ...(ex?.name ? {} : { name: input.name || "Guest" }),
        ...(ex?.phone ? {} : { phone: (input.phone || "").replace(/\D/g, "").slice(-10) }),
      } as any);
      return true;
    }
    const cover: Record<string, unknown> = {
      bookingId: docId,
      ref: docId,
      name: input.name || "Guest",
      phone: (input.phone || "").replace(/\D/g, "").slice(-10),
      eventId: input.eventId || "",
      eventTitle: input.eventTitle || "",
      coverPaid: 0,
      coverActivated: 0,
      coverBalance: 0,
      pendingTopUp: 0,
      coverUsed: 0,
      diffAmount: 0,
      diffMethod: "free_entry",
      paymentMethod: isFreeEntry ? "free_entry" : "ticket_only",
      isGuestList: isFreeEntry,
      activatedAt: nowIso,
      activatedBy: input.staffName,
      transactions: [],
      expiresAt: expDate.toISOString(),
      checkedIn: true,
      actualArrivalTime: arrivalLabel,
      date: today,
      topUpTotal: 0,
      groupSize: 1,
      coverDocId: docId,
      source: isFreeEntry ? "guestlist_free_entry" : "ticket_only_arrival",
    };
    txn.set(ref, cover);
    return true;
  });

  // Mirror check-in back to the source booking/guestlist doc so Door tabs and
  // Bar stay in sync. Best-effort — wallet creation is the source of truth, but
  // we prefer the source doc to also reflect "arrived" so reports/audits are
  // coherent. Idempotent: only writes if not already checked in.
  let mirroredCheckIn = false;
  try {
    const srcCol = input.source === "guestlist" ? GUESTLIST_COL : BOOKINGS_COL;
    const srcRef = doc(db, srcCol, input.sourceDocId);
    const srcSnap = await getDoc(srcRef);
    if (srcSnap.exists() && !srcSnap.data().checkedIn) {
      await updateDoc(srcRef, {
        checkedIn: true,
        checkedInAt: new Date().toISOString(),
        checkedInBy: `${input.staffName} (bar wallet open)`,
      } as any);
      mirroredCheckIn = true;
    }
  } catch (e) {
    console.warn("[ensureZeroBalanceCoverForGuest] mirror check-in failed", e);
  }

  return { created, docId, mirroredCheckIn };
}

// 🚶 2026-05-25 (Khushi GO-LIVE) — BAR WALK-IN.
// Customer arrives at the bar with NO phone / NO QR / NO booking. Bartender
// hits "+ NEW WALK-IN" → this mints a fresh zero-balance cover doc with an
// auto-sequenced name (WALKIN-1, WALKIN-2, ... per operational night) and
// returns the full HodCover so the WalletOverlay (menu/order screen) opens
// immediately. Bartender then RECHARGES with cash/UPI/card and proceeds
// through the normal pay-and-go flow.
// Sequence is race-safe via a Firestore transaction on a per-night counter
// doc at `posCounters/walkin-<YYYY-MM-DD>` — two bartenders tapping at the
// same moment get distinct numbers, never the same.
// 🆕 2026-06-24 (Khushi) — a walk-in counts as EMPTY (reusable) only if it has
// NO order and NO money: no round carries items, no transactions, and every
// money field is ₹0. Conservative on purpose — ANY sign of activity makes it
// NOT empty, so a number with a real order/payment is never recycled.
function _isEmptyWalkin(d: Record<string, unknown> | undefined): boolean {
  if (!d) return false;
  const rounds = Array.isArray(d.tabRounds) ? (d.tabRounds as Array<{ items?: unknown[] }>) : [];
  const hasItems = rounds.some((r) => r && Array.isArray(r.items) && r.items.length > 0);
  const pend = d.pendingOrder as { items?: unknown[] } | undefined;
  const hasPending = !!pend && Array.isArray(pend.items) && pend.items.length > 0;
  const txns = Array.isArray(d.transactions) ? (d.transactions as unknown[]) : [];
  const money =
    (Number(d.coverBalance) || 0) + (Number(d.coverUsed) || 0) +
    (Number(d.coverPaid) || 0) + (Number(d.coverActivated) || 0) +
    (Number(d.topUpTotal) || 0) + (Number(d.pendingTopUp) || 0);
  return !hasItems && !hasPending && txns.length === 0 && money === 0;
}

export async function createBarWalkinCover(staffName: string): Promise<HodCover> {
  await authReady;
  const today = getOperationalNightStr();
  const expDate = getCoverExpiryFor(today);
  const counterRef = doc(db, "posCounters", `walkin-${today}`);
  const ymd = today.replace(/-/g, "");
  // 🆕 2026-06-24 (Khushi) — RECLAIM an abandoned walk-in number instead of
  // climbing 16→17→18 forever. If the MOST-RECENT walk-in for tonight is still
  // EMPTY (created then CANCELLED, no order/no money) reuse that same number; if
  // it already carries an order/payment (e.g. another bar tablet ordered on it)
  // it is NOT empty, so skip it and bump to the next number. Race-safe: the
  // counter doc serialises concurrent taps via the Firestore transaction.
  // 🛡 The cover write lives INSIDE the transaction (not a later setDoc) so the
  // reuse is atomic: because we READ the candidate walk-in doc in this txn, any
  // concurrent order/payment landing on it makes Firestore RETRY the txn — on the
  // retry we re-read it, see it is no longer empty, and bump to a fresh number
  // instead of overwriting that now-active wallet back to ₹0.
  const { docId, cover } = await runTransaction(db, async (txn) => {
    const snap = await txn.get(counterRef);
    const cur = (snap.exists() ? (snap.data().seq as number) : 0) || 0;
    let seq = cur + 1;
    if (cur > 0) {
      const topRef = doc(db, COVERS_COL, `WALKIN-${ymd}-${cur}`);
      const topSnap = await txn.get(topRef);
      if (topSnap.exists() && _isEmptyWalkin(topSnap.data() as Record<string, unknown>)) {
        seq = cur; // reuse the abandoned (empty) number
      }
    }
    // ── all reads done; writes below (Firestore requires reads-before-writes) ──
    const refStr = `WALKIN-${ymd}-${seq}`;
    const cv: Record<string, unknown> = {
      bookingId: refStr,
      ref: refStr,
      name: `WALKIN-${seq}`,
      phone: "",
      email: "",
      eventId: "",
      eventTitle: "",
      coverPaid: 0,
      coverActivated: 0,
      coverBalance: 0,
      pendingTopUp: 0,
      coverUsed: 0,
      diffAmount: 0,
      diffMethod: "none",
      paymentMethod: "walkin",
      isGuestList: false,
      isTableBooking: false,
      activatedAt: new Date().toISOString(),
      activatedBy: staffName,
      transactions: [],
      expiresAt: expDate.toISOString(),
      checkedIn: true,
      actualArrivalTime: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
      date: today,
      topUpTotal: 0,
      groupSize: 1,
      coverDocId: refStr,
      // 🔴 2026-05-25 (Khushi BUG FIX) — must start with "walkin" so Reports
      // classifyWallet() treats it as a true walk-in (source:"walk-in",
      // payChannel:""). Previously "bar_walkin" → did NOT match
      // startsWith("walkin") → fell through to cover branch → "⚠ UNKNOWN"
      // pay-channel badge on the wallet row. "walkin_bar" matches cleanly.
      source: "walkin_bar",
      // No payment was collected at creation — bartender will recharge after.
      // Setting paymentId="walkin_bar_<seq>" stops the cover branch from
      // tagging this as UNKNOWN if anything ever re-classifies it.
      paymentId: `walkin_bar_${seq}`,
    };
    txn.set(counterRef, { seq, updatedAt: new Date().toISOString() }, { merge: true });
    txn.set(doc(db, COVERS_COL, refStr), cv);
    return { docId: refStr, cover: cv };
  });
  return { id: docId, ...cover } as HodCover;
}

/** 🆕 2026-06-07 — Persist the bartender's bill-level DISCOUNT % + SC toggle
 *  onto the cover (and, for table refs, mirror onto the tableReservations doc
 *  the customer wallet reads) so the customer's "VIEW BILL" preview shows the
 *  EXACT same discounted grand total the bar charges — no more ₹2,000 (bar) vs
 *  ₹2,105 (phone) mismatch. Read by the customer site's hodComputeBreakdown.
 *  Fail-open: a write error never blocks the bartender — the bill still prints. */
export async function setCoverBillDiscount(
  coverId: string, ref: string, discPct: number, scOn: boolean,
): Promise<boolean> {
  // NOTE: store the RAW float pct (no integer rounding) — BarMode's billing math
  // (computeHodBreakdownAdjusted) and the customer site both use the unrounded
  // value, so a fractional bartender discount (e.g. 12.5%) stays bit-for-bit in
  // parity. Rounding here would have made the bar charge 12.5% but the phone 13%.
  const pct = Math.min(100, Math.max(0, discPct || 0));
  const sc = !!scOn;
  // Fail-open: never THROW (the bill must always print), but RETURN whether every
  // required write landed so the caller can clear its dedupe key and retry on a
  // transient failure (a stale persisted discount silently breaks bill parity).
  let coverOk = false;
  try {
    await updateDoc(doc(db, COVERS_COL, coverId), { billDiscountPct: pct, billScOn: sc });
    coverOk = true;
  } catch (e) {
    console.warn("[setCoverBillDiscount] cover write failed (non-fatal)", e);
  }
  // Table bookings: the customer wallet reads tableReservations, not covers
  // (see editCoverAmount). Mirror the discount there too so those guests match.
  const looksLikeTableRef = !!ref && (ref.startsWith("HODTAB") || ref.startsWith("TBL-") || ref.startsWith("AGG-"));
  if (!looksLikeTableRef) return coverOk;
  let mirrorOk = false;
  try {
    const q = query(collection(db, TABLE_RES_COL), where("bookingRef", "==", ref), limit(1));
    const snap = await getDocs(q);
    if (snap.empty) {
      mirrorOk = true; // no table doc to mirror to — nothing more required
    } else {
      await updateDoc(snap.docs[0].ref, { billDiscountPct: pct, billScOn: sc });
      mirrorOk = true;
    }
  } catch (mErr) {
    console.warn("[setCoverBillDiscount] table mirror failed (non-fatal)", mErr);
  }
  return coverOk && mirrorOk;
}

export async function editCoverAmount(coverId: string, newAmount: number, staffName: string): Promise<void> {
  if (newAmount > 50000) throw new Error("Cover amount cannot exceed ₹50,000");
  const ref = doc(db, COVERS_COL, coverId);
  let _coverRef = ""; let _newBalAfter = 0;
  await runTransaction(db, async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists()) throw new Error("Cover not found");
    const data = snap.data();
    const used = data.coverUsed || 0;
    const oldAmount = data.coverActivated || 0;
    if (newAmount < used) throw new Error(`Amount cannot be less than ₹${used} (already used)`);
    const newBal = newAmount - used;
    _coverRef = String(data.ref || "");
    _newBalAfter = Math.max(0, newBal);
    txn.update(ref, {
      coverActivated: newAmount,
      coverBalance: Math.max(0, newBal),
      transactions: arrayUnion({
        amount: newAmount, oldAmount, note: `Edit: ₹${oldAmount}→₹${newAmount}`,
        timestamp: new Date().toISOString(), type: "edit", staff: staffName,
      } as HodTransaction),
    });
  });
  // 🆕 2026-05-27 v3.49 — mirror edits to tableReservations for table refs so
  // customer wallet (which reads tableReservations.coverBalance, not covers)
  // stays in sync. Fail-open: if mirror fails, cover edit still succeeded.
  const _looksLikeTableRef = _coverRef.startsWith("HODTAB") || _coverRef.startsWith("TBL-") || _coverRef.startsWith("AGG-");
  if (_coverRef && _looksLikeTableRef) {
    try {
      const q = query(collection(db, TABLE_RES_COL), where("bookingRef", "==", _coverRef), limit(1));
      const snap = await getDocs(q);
      if (!snap.empty) {
        await updateDoc(snap.docs[0].ref, {
          coverActivated: newAmount,
          coverBalance: _newBalAfter,
        });
      }
    } catch (mErr) {
      console.warn("[editCoverAmount] table mirror failed (non-fatal)", mErr);
    }
  }
}

export function subscribeToCover(coverId: string, cb: (cover: HodCover | null) => void): Unsubscribe {
  return onSnapshot(doc(db, COVERS_COL, coverId), (snap) => {
    if (!snap.exists()) { cb(null); return; }
    cb({ id: snap.id, ...snap.data() } as HodCover);
  }, () => cb(null));
}

export async function getCoverByRef(ref: string): Promise<HodCover | null> {
  const q = query(collection(db, COVERS_COL), where("ref", "==", ref), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() } as HodCover;
}

export async function searchCovers(searchQuery: string, tonightDate?: string): Promise<HodCover[]> {
  const q = searchQuery.toLowerCase();
  // 💰 COST FIX 2026-05-21 — scope to tonight's operational night + IST calendar
  // today (so a cover written near the 12-noon rollover is still visible). HodCover.date
  // is OPTIONAL on the interface — covers written before this migration WILL be missed
  // by this filtered query, so callers that need historical reach (Reports >7-day view)
  // must use a separate unfiltered helper. Day-to-day Door/Bar redemption only ever
  // touches tonight's wallets so this is safe for the live ops path.
  const tonight = tonightDate || getOperationalNightStr();
  const calToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const dates = Array.from(new Set([tonight, calToday]));
  let snap;
  try {
    snap = await getDocs(query(collection(db, COVERS_COL), where("date", "in", dates)));
  } catch (e) {
    // 🛟 FALLBACK: composite index missing or 'date' field absent everywhere — fall back
    // to full scan so search never silently returns blank. Logs to console for ops visibility.
    console.warn("[searchCovers] date-filtered query failed, falling back to full scan", e);
    snap = await getDocs(collection(db, COVERS_COL));
  }
  const results: HodCover[] = [];
  const nowMs = Date.now();
  snap.forEach((d) => {
    const cv = { id: d.id, ...d.data() } as HodCover;
    // V3 2026-05-11 — tonight-only scope. Drop covers where:
    //   (a) expiresAt is set AND has already passed (expired wallet from a past night), OR
    //   (b) tonightDate is provided AND cv.date doesn't match tonight's operational date.
    // Fallback (Khushi-style): if BOTH expiresAt AND date are missing, KEEP it
    // (legacy/walk-in cover with no date metadata — better to show than hide).
    if (cv.expiresAt) {
      const exp = new Date(cv.expiresAt).getTime();
      if (Number.isFinite(exp) && exp < nowMs) return; // expired — past night
    }
    if (tonightDate && cv.date && cv.date !== tonightDate) return; // wrong night
    // 2026-05-15 — tighten stale-stub rule. If BOTH date AND expiresAt are
    // missing (legacy / orphan table-booking cover stubs), only keep them
    // when they carry an actual balance. Prevents past-night noise leaking
    // into tonight's Bar/Captain search now that the ₹0 filter is gone.
    if (!cv.date && !cv.expiresAt && (cv.coverBalance || 0) <= 0) return;
    // 2026-05-15 (Khushi UX) — also match by wallet REF (e.g. HOD-MP6KSRBR)
    // so bartender can paste it from the door printout / customer's screen.
    if (
      (cv.name || "").toLowerCase().includes(q)
      || (cv.phone || "").includes(q)
      || (cv.ref || "").toLowerCase().includes(q)
    ) results.push(cv);
  });
  return results;
}

export type RechargeMethod = "cash" | "upi" | "card" | "split";
export interface RechargeSplit { cash?: number; upi?: number; card?: number; }

export async function rechargeCover(
  coverId: string, amount: number, method: RechargeMethod, staffName: string,
  split?: RechargeSplit, currentBalance = 0,
  meta?: { discountPct?: number; grossAmount?: number }
): Promise<{ newBalance: number; tx: HodTransaction }> {
  const ref = doc(db, COVERS_COL, coverId);
  let note: string;
  let txType: string;
  if (method === "split") {
    if (!split) throw new Error("Split breakdown required");
    const c = split.cash || 0, u = split.upi || 0, k = split.card || 0;
    if (![c, u, k].every(v => Number.isInteger(v) && v >= 0)) {
      throw new Error("Split parts must be non-negative whole rupees");
    }
    const sum = c + u + k;
    if (sum !== amount) throw new Error(`Split sum ₹${sum} ≠ amount ₹${amount}`);
    const parts: string[] = [];
    if (split.cash) parts.push(`Cash ₹${split.cash}`);
    if (split.upi) parts.push(`UPI ₹${split.upi}`);
    if (split.card) parts.push(`Card ₹${split.card}`);
    note = `Split recharge (${parts.join(" + ")})`;
    txType = "split_topup";
  } else {
    const label = method === "cash" ? "Cash" : method === "upi" ? "UPI" : "Card";
    note = `${label} recharge`;
    txType = `${method}_topup`;
  }
  // 🆕 2026-06-24 (Khushi) — stamp the discount IMMUTABLY on THIS recharge so a
  // later recharge with a different % can never rewrite its history. Only when a
  // real discount was given (>0); grossAmount only when it genuinely exceeds the
  // net (a discount existed). Keeps no-discount recharges byte-clean.
  const _discPct = meta && Number(meta.discountPct) > 0 ? Number(meta.discountPct) : 0;
  const _gross = meta && Number(meta.grossAmount) > amount ? Math.round(Number(meta.grossAmount)) : 0;
  const tx: HodTransaction = {
    amount, note, timestamp: new Date().toISOString(),
    type: txType, staff: staffName,
    ...(method === "split" && split ? { split } : {}),
    ...(_discPct > 0 ? { discountPct: _discPct } : {}),
    ...(_gross > 0 ? { grossAmount: _gross } : {}),
  } as HodTransaction;
  // 🆕 2026-06-05 v3.222 (Khushi BUG — "recharge → PRINT KOT+BILL appears 5→6→8-10s
  // later, growing every round; we want INSTANT on a busy multi-tablet night").
  // ROOT CAUSE: a recharge is a pure ADD, but this used `runTransaction` which
  // REQUIRES a live server round-trip AND does a `txn.get()` that reads the WHOLE
  // cover doc — and that doc grows every round (transactions[] / tabRounds[]), so
  // the read got slower and slower (the growth she saw). The button only appears
  // after this resolves.
  // FIX: replace the read-modify-write txn with ATOMIC field transforms
  // (`increment` + `arrayUnion`). These need NO read, are still server-atomic /
  // concurrency-safe across tablets, and — critically — apply to the LOCAL CACHE
  // synchronously so the cover's onSnapshot listener repaints the gate INSTANTLY
  // via latency compensation, before the server even ACKs. The new balance is
  // computed optimistically from the caller's known balance (the listener carries
  // the authoritative value moments later; `increment` keeps the server correct
  // even under concurrent recharges). No transaction → no hang → no NETWORK_SLOW
  // timeout needed on this path.
  await updateDoc(ref, {
    coverBalance: increment(amount),
    coverActivated: increment(amount),
    topUpTotal: increment(amount),
    transactions: arrayUnion(tx),
  });
  return { newBalance: currentBalance + amount, tx };
}

/**
 * Edit the items in the customer's PREPARING tabRound on the cover doc.
 * Used by BarMode when an item is out of stock or the bartender needs to adjust qty
 * before printing the KOT. Persists immediately so the customer sees the change live.
 * If `newItems` is empty, the preparing round is removed (effectively cancelling the order).
 */
export async function updatePreparingRoundItems(
  coverId: string, newItems: HodOrderItem[], editedBy: string
): Promise<{ roundTotal: number; removed: boolean }> {
  const ref = doc(db, COVERS_COL, coverId);
  return await runTransaction(db, async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists()) throw new Error("Cover not found");
    const data = snap.data();
    const rounds: HodTabRound[] = Array.isArray(data.tabRounds) ? [...data.tabRounds] : [];
    const idx = rounds.findIndex((r) => r && r.status === "preparing");
    if (idx === -1) throw new Error("No pending order to edit");
    const cleaned = newItems.filter((it) => (it.qty || 0) > 0);
    const now = new Date().toISOString();
    if (cleaned.length === 0) {
      rounds.splice(idx, 1);
      // 🆕 2026-05-25 v2 (READ-COST FIX) — also clear the incoming-order
      // flag when the preparing round is fully removed, so the BarMode
      // dashboard tile doesn't keep showing an orphan with no items.
      txn.update(ref, { tabRounds: rounds, pendingOrder: null, hasIncomingCustomerOrder: false });
      return { roundTotal: 0, removed: true };
    }
    const roundTotal = computeHodBreakdown(cleaned).grandTotal;
    const prevItems = rounds[idx].items || [];
    const editHistory = (rounds[idx] as { editHistory?: unknown[] }).editHistory || [];
    rounds[idx] = {
      ...rounds[idx],
      items: cleaned.map((it) => ({ n: it.n, p: it.p, qty: it.qty, cat: it.cat || "", t: it.t || "drink", alc: it.alc === false ? false : (it.t === "food" ? false : true), v: it.v })),
      roundTotal,
      editHistory: [...editHistory, { prevItems, editedBy, editedAt: now }],
    } as HodTabRound;
    txn.update(ref, { tabRounds: rounds });
    return { roundTotal, removed: false };
  });
}

export async function activateCoverOrder(
  coverId: string, items: HodOrderItem[], total: number, staffName: string
): Promise<{ newBalance: number; updatedRounds: HodTabRound[] }> {
  const ref = doc(db, COVERS_COL, coverId);
  const note = items.map((it) => `${it.qty}x ${it.n}`).join(", ");
  const now = new Date().toISOString();
  const tx: HodTransaction = { amount: total, note, timestamp: now, type: "activate", staff: staffName };

  const result = await withTxnTimeout(runTransaction(db, async (txn) => {
    const freshSnap = await txn.get(ref);
    if (!freshSnap.exists()) throw new Error("Cover not found");
    const fd = freshSnap.data();
    const freshBal = fd.coverBalance || 0;
    const freshNewBal = freshBal - total;
    if (freshNewBal < 0) throw new Error(`Insufficient balance (₹${freshBal} available, ₹${total} needed)`);

    const lastAct = fd.lastActivatedAt ? new Date(fd.lastActivatedAt).getTime() : 0;
    if (Date.now() - lastAct < 30000) {
      throw new Error(`COOLDOWN:${Math.round((Date.now() - lastAct) / 1000)}:${fd.lastActivatedBy || "another bartender"}`);
    }

    const freshRounds: HodTabRound[] = Array.isArray(fd.tabRounds) ? fd.tabRounds : [];
    let updRounds: HodTabRound[];
    const hasPreparing = freshRounds.some((r) => r.status === "preparing");

    if (hasPreparing) {
      updRounds = freshRounds.map((r) =>
        r.status === "preparing"
          ? { ...r, status: "activated" as const, activatedBy: staffName, activatedAt: now,
              items: items.map((it) => ({ n: it.n, p: it.p, qty: it.qty, cat: it.cat || "", t: it.t || "drink", alc: it.alc === false ? false : (it.t === "food" ? false : true) })), roundTotal: total }
          : r
      );
    } else {
      updRounds = [
        ...freshRounds,
        {
          roundNum: freshRounds.length + 1,
          items: items.map((it) => ({ n: it.n, p: it.p, qty: it.qty, cat: it.cat || "", t: it.t || "drink", alc: it.alc === false ? false : (it.t === "food" ? false : true) })),
          roundTotal: total, status: "activated" as const,
          placedAt: now, activatedBy: staffName, activatedAt: now, placedBy: staffName,
          // 🆕 2026-06-08 v3.253 (Khushi) — TAG bartender-created bar rounds with a
          // bar source. These live ONLY on the cover (never the table doc); without
          // a "bar" source _mergeCoverRoundsPreserveBarOnly would DROP them the
          // moment a captain action mirrors the table rounds back (silent loss —
          // Khushi's "missing Round 2 that the bartender added" bug). The substring
          // "bar" is what _isBarRoundSource matches, so this round now survives.
          source: "bartender_bar",
        },
      ];
    }

    txn.update(ref, {
      coverBalance: freshNewBal, coverUsed: (fd.coverUsed || 0) + total, pendingOrder: null,
      lastActivatedAt: now, lastActivatedBy: staffName,
      transactions: arrayUnion(tx), tabRounds: updRounds,
      // 🆕 2026-05-25 (Khushi READ-COST FIX) — Clear the incoming-order
      // flag so the BarMode dashboard tile (subscribeIncomingCustomerOrders)
      // auto-dismisses without re-reading every cover. See helper below.
      hasIncomingCustomerOrder: false,
    });
    return { newBalance: freshNewBal, updatedRounds: updRounds };
  }));
  return result;
}

// 🆕 2026-05-25 (Khushi READ-COST FIX) — NARROW subscription for BarMode's
// "📥 INCOMING CUSTOMER ORDERS" tile. The previous implementation used
// subscribeToCoversForNight, which fans out reads = (all tonight's covers)
// × (every update to any cover) × (every Bar Mode tablet). With ~100
// covers/night and frequent transactions, this drove Firestore reads up
// by 4-5x on test nights. This helper queries a single boolean field
// `hasIncomingCustomerOrder` set by customer-site at-bar writes and
// cleared in activateCoverOrder. Result-set size is typically 0-3 docs,
// so read cost is proportional to ACTUAL pending self-orders, not the
// whole night's covers. No composite index required (single-field where).
// 🛟 FALLBACK: on error returns []; tile silently disappears (orphans
// then fall back to the bartender scanning the QR + "show to bartender"
// popup on the customer site).
export function subscribeIncomingCustomerOrders(cb: (covers: HodCover[]) => void): Unsubscribe {
  const q = query(collection(db, COVERS_COL), where("hasIncomingCustomerOrder", "==", true));
  return onSnapshot(q,
    (snap) => {
      // 🛡 2026-05-25 v2 DEFENSIVE FILTER (architect review): only surface
      // covers that ACTUALLY have a preparing customer_self_order round
      // right now. Protects against orphan flags (e.g. legacy docs, manual
      // edits, race where flag was set but round never wrote) so the tile
      // never shows a stale/blank entry. Cost is still O(small) because
      // the Firestore query already narrows to flagged docs.
      const rows = snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as HodCover))
        .filter((cv) =>
          Array.isArray(cv.tabRounds) && cv.tabRounds.some((rd: any) =>
            rd && rd.status === "preparing" &&
            typeof rd.source === "string" &&
            rd.source.indexOf("customer_self_order") === 0
          )
        );
      cb(rows);
    },
    () => cb([])
  );
}

export function subscribeToHodReservations(
  date: string, cb: (reservations: HodTableReservation[]) => void
): Unsubscribe {
  // v3.94 shared listener keyed on date — DoorMode mounts this 7× per tablet
  // (today, calToday, bookingDate, ReassignModal date, ×2 cross-night, picked
  // tables). All same-date subscribers now share ONE Firestore phone line.
  // subscribeToHodReservationsScoped also benefits transparently since it
  // wraps this function.
  return _shareSubscription<HodTableReservation[]>(
    `res:${date || "_blank"}`,
    (push) => {
      const q = query(collection(db, TABLE_RES_COL), where("date", "==", date));
      return onSnapshot(q, (snap) => {
        const all: HodTableReservation[] = [];
        snap.forEach((d) => all.push({ _docId: d.id, ...d.data() } as HodTableReservation));
        all.sort((a, b) => (a.arrivalTime || "").localeCompare(b.arrivalTime || ""));
        push(all);
      }, () => push([]));
    },
    cb,
  );
}

// 🆕 2026-06-08 (Khushi) — RELEASED-TABLE history listener. releaseTable()
// archives the full reservation to `tableHistory` (every field copied, incl.
// tabRounds/amountPaid/walletRedemptions/discount/SC/tax) and then DELETES the
// live `tableReservations` + `covers` docs. Any report that reads ONLY the live
// collections therefore LOSES a table's sales the instant the captain taps
// RELEASE — billed / discount / SC / net+gross / cover-wallet redeemed all drop.
// This listener replays tonight's released tables so the live report can add
// them back. Same `date == night` scoping as subscribeToHodReservations and the
// same shape (HodTableReservation), so callers feed it through the identical
// aggregation. Fail-open (error → []) and shared via _shareSubscription. The
// `_docId` is prefixed `hist:` so it can never collide with a live res _docId.
export function subscribeToTableHistory(
  date: string, cb: (reservations: HodTableReservation[]) => void
): Unsubscribe {
  return _shareSubscription<HodTableReservation[]>(
    `hist:${date || "_blank"}`,
    (push) => {
      const q = query(collection(db, TABLE_HISTORY_COL), where("date", "==", date));
      return onSnapshot(q, (snap) => {
        const all: HodTableReservation[] = [];
        snap.forEach((d) => all.push({ ...(d.data() as HodTableReservation), _docId: `hist:${d.id}` }));
        push(all);
      }, () => push([]));
    },
    cb,
  );
}

// 🆕 2026-05-26 v3.10 — Scoped reservations listener (Fix #1: Listener Scoping).
// Wraps subscribeToHodReservations and ADDITIONALLY filters client-side to
// reservations whose tableId belongs to one of `allowedFloors`. Used by Captain
// "Focus Mode" so a tablet locked to one floor doesn't render the other floors'
// tables/updates — cuts React re-renders ~70% on a 1500-booking night and stops
// the JS heap from ballooning past midnight.
//
// 🛟 FAIL-OPEN: off-map reservations (tableId NOT in HOD_TABLES — walk-ins on
// Proxy-N, aggregator-imported typos, deleted SVG nodes like FD13/SMK3) are
// ALWAYS PASSED THROUGH so they never become invisible. Same fail-open
// philosophy as the off-map strip below the floor plan.
//
// Why client-side filter (not Firestore where()):
//   Reservations don't store a denormalized `floor` field today. Adding one
//   means touching ~10+ write call sites + a migration script. v1 ships the
//   safer client-side version — same UX win (fewer renders), zero write-path
//   risk. v2 (later) can add denormalized floor + a real Firestore where() for
//   read-cost reduction on top.
//
// allowedFloors=null OR empty → no filtering (behaves identically to base sub).
export function subscribeToHodReservationsScoped(
  date: string,
  allowedFloors: FloorKey[] | null,
  cb: (reservations: HodTableReservation[]) => void,
): Unsubscribe {
  const filterSet = allowedFloors && allowedFloors.length > 0 ? new Set(allowedFloors) : null;
  return subscribeToHodReservations(date, (all) => {
    if (!filterSet) { cb(all); return; }
    const filtered = all.filter((r) => {
      const fk = getFloorFromTableId(r.tableId || "");
      if (fk === null) return true; // off-map → fail-open, keep visible
      return filterSet.has(fk);
    });
    cb(filtered);
  });
}

// 2026-05-16 one-shot diagnostic — fetches ALL tableReservations and groups by
// `date` field so we can see if customer-site bookings are landing under a
// different date string than POS is querying for.
export async function diagnoseTableReservationDates(): Promise<{ totals: Record<string, number>; recent: Array<{ id: string; date: string; src: string; name: string; ref: string }> }> {
  const snap = await getDocs(collection(db, TABLE_RES_COL));
  const totals: Record<string, number> = {};
  const recent: Array<{ id: string; date: string; src: string; name: string; ref: string }> = [];
  snap.forEach((d) => {
    const x = d.data() as any;
    const dateKey = x.date || "(blank)";
    totals[dateKey] = (totals[dateKey] || 0) + 1;
    recent.push({ id: d.id, date: dateKey, src: x.source || "(blank)", name: x.customerName || "", ref: x.bookingRef || "" });
  });
  recent.sort((a, b) => b.date.localeCompare(a.date));
  return { totals, recent: recent.slice(0, 20) };
}

// Transactionally mark guest as arrived. Returns { arrivalTime, wasNew }.
// If `wasNew === false`, the reservation was ALREADY arrived (concurrent or
// double-tap). Callers MUST check wasNew before firing irreversible side effects
// like minting a cover or sending WhatsApp.
// Also stamps `arrivalProcessedAt` (full ISO timestamp) used as an undo token.
export async function markGuestArrived(
  docId: string, bookingRef?: string, arrivedBy?: string
): Promise<{ arrivalTime: string; wasNew: boolean; processedAt: string }> {
  const arrTime = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const processedAt = new Date().toISOString();
  const ref = doc(db, TABLE_RES_COL, docId);

  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("Reservation not found");
    const data = snap.data();
    if (data.actualArrivalTime) {
      // Already arrived — return existing without overwriting
      return { arrivalTime: data.actualArrivalTime as string, wasNew: false, processedAt: (data.arrivalProcessedAt as string) || "" };
    }
    const updates: Record<string, unknown> = { actualArrivalTime: arrTime, arrivalProcessedAt: processedAt };
    if (arrivedBy) updates.arrivedBy = arrivedBy;
    tx.update(ref, updates);
    return { arrivalTime: arrTime, wasNew: true, processedAt };
  });

  // Mirror to covers doc only on a NEW arrival (best-effort, outside the txn)
  if (result.wasNew && bookingRef) {
    await updateDoc(doc(db, COVERS_COL, bookingRef), { actualArrivalTime: arrTime }).catch(() => {});
  }
  return result;
}

// Undo a "guest arrived" mark with optimistic-concurrency check.
// `expectedProcessedAt` is the token returned by markGuestArrived; we only
// reverse if the current record still matches that exact mutation. Prevents
// a stale 30-second toast from clobbering a fresh re-arrival by another agent.
// Returns true if reversed, false if state moved on (caller should toast a
// "cannot undo — state changed" message).
export async function unmarkGuestArrived(
  docId: string, expectedProcessedAt: string, bookingRef?: string
): Promise<boolean> {
  const ref = doc(db, TABLE_RES_COL, docId);
  const reversed = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return false;
    const data = snap.data();
    if (!data.actualArrivalTime) return false; // already cleared
    if (expectedProcessedAt && data.arrivalProcessedAt !== expectedProcessedAt) return false;
    tx.update(ref, { actualArrivalTime: null, arrivedBy: null, arrivalProcessedAt: null });
    return true;
  });
  if (reversed && bookingRef) {
    await updateDoc(doc(db, COVERS_COL, bookingRef), { actualArrivalTime: null }).catch(() => {});
  }
  return reversed;
}

// 🆕 2026-06-08 (Khushi LIVE BUG) — captain "MARK SERVED" / "Ready to Serve"
// didn't reach the customer wallet on COVER+TABLE bookings (Door "Activate
// Table + Cover", guest "I am at table") — the round stayed "Ordered" on the
// phone even after the captain marked it served. ROOT CAUSE: that flow stores
// the customer wallet under `linkedCoverDocId`, NOT `bookingRef`, so the
// legacy single bookingRef mirror below never touched the cover the wallet
// actually reads. `updateRoundItems` + the captain ADD-ORDER path were already
// fixed (2026-05-20) to ALSO mirror to `linkedCoverDocId` — mark-served /
// mark-activated were simply missed. This helper applies that same dual mirror
// (full rounds array → covers/{bookingRef} AND covers/{linkedCoverDocId}).
// Best-effort: the tableReservations write above is the source of truth.
// 🔴 2026-06-08 v3.252 (Khushi LIVE BUG — round-loss) — BAR rounds vanished
// from the customer wallet the moment the captain touched the table (PRINT KOT
// / MARK SERVED / ADD ORDER / edit). ROOT CAUSE: a guest's "I'M AT THE BAR"
// rounds are written ONLY to the cover (source 'customer_self_order_bar' /
// 'recharge_at_bar') — they are NEVER copied to the tableReservations doc. But
// every cover mirror below used to REPLACE covers.tabRounds with the table
// doc's rounds, which contain only the table/captain rounds → the bar rounds
// were silently overwritten and lost. The customer-site v3.220 read-time merge
// can't resurrect them once the cover itself has been clobbered. FIX: when
// mirroring the table doc's rounds onto a cover, UNION them with the cover's
// own BAR-only rounds (never drop a cover-only bar round). Table rounds stay
// authoritative (they exist on the table doc with the SAME placedAt, so the
// placedAt|roundNum|roundTotal dedupe — identical to the customer-site key —
// collapses the overlap and the table-doc copy/status wins). No round is ever
// dropped or duplicated.
function _isBarRoundSource(s?: unknown): boolean {
  return typeof s === "string" && s.toLowerCase().indexOf("bar") !== -1;
}
function _mergeCoverRoundsPreserveBarOnly(coverRounds: any[], tableRounds: any[]): any[] {
  const tbl = Array.isArray(tableRounds) ? tableRounds : [];
  const cov = Array.isArray(coverRounds) ? coverRounds : [];
  // Preserve the cover's BAR rounds — these live ONLY on the cover and would
  // otherwise be overwritten by the table-doc rounds.
  const barOnly = cov.filter((r) => r && _isBarRoundSource(r.source));
  const keyOf = (r: any) =>
    `${(r && r.placedAt) || ""}|${(r && r.roundNum) || ""}|${(r && r.roundTotal) || ""}`;
  const seen = new Set<string>();
  const merged: any[] = [];
  // Table-doc rounds are authoritative (carry the latest status); add first so a
  // bar round that ALSO reached the table doc (overlap) keeps the table version.
  for (const r of [...tbl, ...barOnly]) {
    if (!r) continue;
    const k = keyOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(r);
  }
  // 🆕 2026-06-08 v3.253 (Khushi) — sort CHRONOLOGICALLY by placedAt, NOT by
  // roundNum. Every writer (customer bar/table, bartender, captain) computes
  // roundNum as <its own array>.length+1 from a DIFFERENT array, so the numbers
  // COLLIDE (two "Round 3") and GAP (missing "Round 2"). placedAt is the only
  // reliable ordering signal; the customer wallet + captain renumber the DISPLAY
  // 1..N from this order so the bill always reads R1 bar → R2 bar → R3 table → …
  merged.sort((a, b) => {
    const at = String((a && a.placedAt) || ""), bt = String((b && b.placedAt) || "");
    if (at !== bt) return at.localeCompare(bt);
    return Number((a && a.roundNum) || 0) - Number((b && b.roundNum) || 0);
  });
  return merged;
}
async function _mirrorRoundsToCovers(
  rounds: any[], bookingRef?: string, linkedCoverDocId?: string
): Promise<void> {
  const refs: string[] = [];
  if (bookingRef) refs.push(bookingRef);
  if (linkedCoverDocId && linkedCoverDocId !== bookingRef) refs.push(linkedCoverDocId);
  for (const ref of refs) {
    try {
      const cRef = doc(db, COVERS_COL, ref);
      const cs = await getDoc(cRef);
      if (!cs.exists()) continue;
      const coverRounds: any[] = Array.isArray(cs.data()?.tabRounds) ? cs.data()!.tabRounds : [];
      const merged = _mergeCoverRoundsPreserveBarOnly(coverRounds, rounds);
      const tabTotal = merged.reduce((s, r) => s + (Number(r?.roundTotal) || 0), 0);
      await updateDoc(cRef, { tabRounds: merged, tabTotal });
    } catch (e) {
      console.warn("[HOD] round-status cover mirror failed for", ref, e);
    }
  }
}

export async function markRoundServed(docId: string, roundIndex: number, bookingRef?: string): Promise<void> {
  const snap = await getDoc(doc(db, TABLE_RES_COL, docId));
  if (!snap.exists()) throw new Error("Reservation not found");
  const data = snap.data();
  const rounds = [...(data.tabRounds || [])];
  if (rounds[roundIndex]) rounds[roundIndex].status = "served";
  await updateDoc(doc(db, TABLE_RES_COL, docId), { tabRounds: rounds });
  await _mirrorRoundsToCovers(rounds, bookingRef, (data as { linkedCoverDocId?: string }).linkedCoverDocId);
}

// 🆕 2026-06-25 (Khushi) — ROLE-BASED SETTLEMENT.
// A normal captain (no canSettle permission) cannot collect a bill; instead they
// tap "NOTIFY SUPERVISOR TO SETTLE BILL", which raises this flag on the table's
// reservation doc. Authorized captains (canSettle / admin / manager) already
// subscribe to the live reservation feed, so the flag surfaces in the blinking
// SETTLE BILL tab with ZERO new listeners (cost-safe). Both writes are
// fire-and-forget + fail-open: a failed flag write must never block a guest or
// throw at the staff — the worst case is the supervisor is not auto-notified and
// is told verbally instead.
export function setSettleRequest(docId: string, info: { by: string; floor?: string }): void {
  if (!docId) return;
  try {
    const ref = doc(db, TABLE_RES_COL, docId);
    void updateDoc(ref, {
      settleRequested: true,
      settleRequestedBy: info.by || "",
      settleRequestedAt: new Date().toISOString(),
      settleRequestFloor: info.floor || "",
    }).catch((e) => console.warn("[setSettleRequest] non-fatal", e));
  } catch (e) {
    console.warn("[setSettleRequest] threw (non-fatal)", e);
  }
}

export function clearSettleRequest(docId: string): void {
  if (!docId) return;
  try {
    const ref = doc(db, TABLE_RES_COL, docId);
    void updateDoc(ref, { settleRequested: false }).catch((e) =>
      console.warn("[clearSettleRequest] non-fatal", e));
  } catch (e) {
    console.warn("[clearSettleRequest] threw (non-fatal)", e);
  }
}

// 🔴 2026-05-13 — Khushi: Print KOT used to call markRoundServed which
// flipped the customer wallet straight to "✅ Served" the moment the kitchen
// ticket printed (long before the food actually reached the table). Split
// the flow so Print KOT now sets status="activated" (wallet shows
// "🔵 Ready to Serve") and a separate Mark Served button later sets
// status="served". Mirrors to covers/{bookingRef} so the customer wallet
// (which subscribes to covers for in-house HOD- bookings) sees it live.
export async function markRoundActivated(
  docId: string, roundIndex: number, staffName: string, bookingRef?: string
): Promise<void> {
  const now = new Date().toISOString();
  const snap = await getDoc(doc(db, TABLE_RES_COL, docId));
  if (!snap.exists()) throw new Error("Reservation not found");
  const rounds = [...(snap.data().tabRounds || [])];
  if (rounds[roundIndex]) {
    rounds[roundIndex] = {
      ...rounds[roundIndex],
      status: "activated",
      activatedBy: staffName,
      activatedAt: now,
    };
  }
  await updateDoc(doc(db, TABLE_RES_COL, docId), { tabRounds: rounds });
  // 🆕 2026-06-08 — dual mirror (covers/{bookingRef} AND covers/{linkedCoverDocId})
  // so the "Ready to Serve" status reaches the customer wallet on COVER+TABLE
  // bookings too. See _mirrorRoundsToCovers comment above.
  await _mirrorRoundsToCovers(rounds, bookingRef, (snap.data() as { linkedCoverDocId?: string }).linkedCoverDocId);
}

/**
 * 🆕 2026-06-07 (Khushi) — TRUE bill-settled gate.
 * A table-cover booking PREPAID online carries `paymentStatus:"paid"` from the
 * COVER deposit (written by the customer site `_finalizeReserve` and the
 * `razorpayBookingWebhook`) even while its FOOD TAB is still OPEN and the guest
 * keeps self-ordering. `markTablePaid` is the SOLE writer of `paymentMode` /
 * `paidAt`, so a table is genuinely SETTLED (and must lock ordering/editing/
 * reassign/source) ONLY once one of those settlement stamps is present. Without
 * this distinction, prepaid-cover tables looked "paid" and the captain could
 * neither ADD ORDER nor SETTLE the real food bill.
 */
export function isTableBillSettled(
  data: { paymentStatus?: string; paymentMode?: string; paidAt?: string } | null | undefined
): boolean {
  // Delegate to the canonical rule in door-tables.ts (single source of truth —
  // door-tables is a lower-level lib, so this import is not circular).
  return isTableReservationSettled(data);
}

export async function updateRoundItems(
  docId: string, roundIndex: number, items: HodOrderItem[], roundTotal: number, editedBy?: string
): Promise<void> {
  const snap = await getDoc(doc(db, TABLE_RES_COL, docId));
  if (!snap.exists()) throw new Error("Reservation not found");
  const data = snap.data();
  if (isTableBillSettled(data)) throw new Error("Cannot edit orders on a settled table");
  const rounds = [...(data.tabRounds || [])];
  if (rounds[roundIndex]) {
    const prevItems = [...(rounds[roundIndex].items || [])];
    rounds[roundIndex].items = items;
    rounds[roundIndex].roundTotal = roundTotal;
    const editHistory = rounds[roundIndex].editHistory || [];
    editHistory.push({ prevItems, editedBy: editedBy || "unknown", editedAt: new Date().toISOString() });
    rounds[roundIndex].editHistory = editHistory;
  }
  const tabTotal = rounds.reduce((s: number, r: any) => s + (r.roundTotal || 0), 0);
  // L8: editing items after a bill print invalidates the printed chit.
  const upd: Record<string, unknown> = { tabRounds: rounds, tabTotal };
  if ((data.billPrintCount || 0) > 0) upd.billStale = true;
  await updateDoc(doc(db, TABLE_RES_COL, docId), upd);
  // 🔴 2026-05-13 — Khushi: edits done by the captain weren't reaching the
  // customer wallet (wallet subscribes to covers/{ref}.tabRounds for
  // in-house bookings). Mirror the full rounds array to covers (dual: bookingRef
  // AND linkedCoverDocId). 🔴 2026-06-08 v3.252 — routed through the shared
  // _mirrorRoundsToCovers so the cover's BAR-only rounds are PRESERVED (union,
  // not replace) — a captain edit no longer wipes a guest's "I'M AT THE BAR"
  // rounds. Best-effort; safe to skip when no cover doc exists.
  await _mirrorRoundsToCovers(rounds, data.bookingRef, (data as { linkedCoverDocId?: string }).linkedCoverDocId);
}

// ════════════════════════════════════════════════════════════════════════
// 2026-05-15 — CAPTAIN × COVER WALLET REDEMPTION (Khushi spec)
// ────────────────────────────────────────────────────────────────────────
// Customer flow: Rahul + friend activate ₹2000 each at GF door. They sit
// upstairs at FF table. Captain bills ₹3500. At Mark-Paid, captain taps
// "🎫 REDEEM WALLET" → scans/types Rahul's QR/phone/ref → ₹2000 deducted
// (full balance) → modal shows ₹1500 remaining → captain scans friend's
// → only ₹1500 deducted (smart auto-fit, friend's wallet keeps ₹500) →
// remaining = ₹0 → bill closed. NO partial-amount entry by captain — the
// system always deducts min(remaining, walletBalance).
//
// Anti-fraud: full audit log on BOTH the cover doc (transactions[]) and
// the reservation doc (walletRedemptions[]) — race-safe via runTransaction
// so concurrent Bar Mode drink-rounds never over-deduct the same wallet.
// Server-side billCap (passed by caller) prevents any combo of redemptions
// across stale/concurrent terminals from exceeding the bill total.
//
// ⚠ DEPLOY NOTE — Razorpay STAGE 4 wallet rules-lock will deny browser-side
// writes to covers.{coverBalance,coverUsed,transactions}. When that lands,
// `redeemFromWalletAtTable` + `undoWalletRedemption` STOP WORKING from the
// captain tablet and must be moved to a Cloud Function (Admin SDK bypasses
// rules). Plan: ship a `redeemTableWallet` callable alongside
// `verifyRechargePayment` BEFORE the rules-lock deploy. Same logic as below,
// just executed server-side. Until then this client-side path works.
// ════════════════════════════════════════════════════════════════════════

/** 2026-05-20 — Live-subscribe to ONE cover doc by Firestore id. Used by
 *  Captain Mode (TableCard + MarkPaidModal) to render the linked-cover
 *  balance badge / 1-tap redeem button with live balance (auto-updates
 *  when customer also spent at the bar). Returns the unsubscribe fn. */
export function subscribeToCoverById(
  docId: string,
  onChange: (cover: HodCover | null) => void
): Unsubscribe {
  if (!docId) { onChange(null); return () => {}; }
  return onSnapshot(
    doc(db, COVERS_COL, docId),
    (snap) => {
      if (!snap.exists()) { onChange(null); return; }
      onChange({ id: snap.id, ...(snap.data() as Omit<HodCover, "id">) });
    },
    (err) => {
      console.warn("[subscribeToCoverById] snapshot error", err);
      onChange(null);
    }
  );
}

/** 2026-05-20 — Clear a customer's CALL CAPTAIN ping after captain
 *  acknowledges it. Writes `customerCallRequest: null` on the reservation.
 *  Fail-open: errors are logged but not thrown — the worst case is the
 *  banner stays on screen and captain re-taps "✓ ON IT". */
export async function clearCustomerCallRequest(
  reservationDocId: string,
  dismissedBy?: string,
  /** ISO timestamp of the call the UI is dismissing. Required for safety:
   *  if a NEW call arrived between render and tap, we must NOT clear it.
   *  Captain will see the new banner appear and can re-tap. */
  expectedAt?: string
): Promise<void> {
  if (!reservationDocId) return;
  try {
    // 🔴 2026-05-20 (Khushi Bug 1) — push dismissed call into `customerCallHistory`
    // so captain can re-read items AFTER tapping ✓ ON IT. Done inside a
    // runTransaction so a concurrent NEW customerCallRequest write between
    // read and write is detected (Firestore retries) — and we only clear
    // when the in-doc call's `at` still matches the UI's `expectedAt`.
    // Without that guard, a brand-new call could be silently cleared.
    const ref = doc(db, TABLE_RES_COL, reservationDocId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const data = snap.data() as Partial<HodTableReservation>;
      const cr = data.customerCallRequest;
      // Guard: if the in-doc call's `at` doesn't match what the captain
      // saw on screen, a new call has landed — leave it alone.
      if (expectedAt && cr && cr.at && cr.at !== expectedAt) return;
      // Guard: if no call at all, nothing to do.
      if (!cr || !cr.at) return;
      const history = Array.isArray(data.customerCallHistory) ? data.customerCallHistory : [];
      const entry: { at: string; dismissedAt: string; itemsPreview?: string; total?: number; dismissedBy?: string } = {
        at: cr.at,
        dismissedAt: new Date().toISOString(),
      };
      if (cr.itemsPreview) entry.itemsPreview = cr.itemsPreview;
      if (typeof cr.total === "number") entry.total = cr.total;
      if (dismissedBy) entry.dismissedBy = dismissedBy;
      tx.update(ref, {
        customerCallRequest: null,
        customerCallHistory: [...history, entry].slice(-20),
      });
    });
  } catch (e) {
    console.warn("[clearCustomerCallRequest] failed (non-fatal)", e);
  }
}

/** Find a cover wallet by ref (HOD-XXX), bookingId, or phone. Returns the
 *  best match (highest balance, checked-in preferred) or a clear failure
 *  reason. Used by Captain Mode wallet-scan modal — supports all 3 lookup
 *  paths (QR scan → ref / typed phone / typed ref). */
export async function findCoverForRedemption(
  needle: string
): Promise<{ ok: true; cover: HodCover } | { ok: false; reason: string }> {
  const raw = String(needle || "").trim();
  if (!raw) return { ok: false, reason: "Empty input" };
  // Strip URL wrapper if QR was https://hodclub.in/?wallet=HOD-XXX
  let probe = raw;
  const urlMatch = raw.match(/wallet=([A-Za-z0-9-]+)/i);
  if (urlMatch) probe = urlMatch[1];
  const upper = probe.toUpperCase();

  // Helper: pick best cover from a list (checked-in + highest balance first).
  const pickBest = (cands: HodCover[]): HodCover | null => {
    if (!cands.length) return null;
    cands.sort((a, b) => {
      const aIn = a.checkedIn ? 1 : 0;
      const bIn = b.checkedIn ? 1 : 0;
      if (aIn !== bIn) return bIn - aIn;
      return (b.coverBalance || 0) - (a.coverBalance || 0);
    });
    return cands[0];
  };

  // 1. HOD-XXX ref lookup. The active cover doc id is `coverDocIdFor(bookingId)`
  //    NOT the public ref — for table-source bookings or aggregator-mint covers
  //    the doc id can differ entirely from `ref`. So we query the `ref` FIELD
  //    first (primary), then fall back to doc-id (legacy / direct cover docs).
  //    This also dodges stale 0-balance orphan docs that happen to share the id.
  if (/^HOD-/i.test(upper) || /^[A-Z0-9_-]{6,}$/i.test(upper)) {
    const candidates: HodCover[] = [];
    try {
      const q = query(collection(db, COVERS_COL), where("ref", "==", upper), limit(10));
      const snap = await getDocs(q);
      snap.docs.forEach((d) => candidates.push({ id: d.id, ...(d.data() as Omit<HodCover, "id">) }));
    } catch (e) {
      console.warn("[findCoverForRedemption] ref query failed", e);
    }
    try {
      const direct = await getDoc(doc(db, COVERS_COL, upper));
      if (direct.exists()) candidates.push({ id: direct.id, ...(direct.data() as Omit<HodCover, "id">) });
    } catch { /* ignore */ }
    // Dedupe by doc id.
    const seen = new Set<string>();
    const unique = candidates.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
    const best = pickBest(unique);
    if (best) {
      // Prefer the one with balance > 0 if tied — orphan stubs at 0 must lose.
      const withBal = unique.filter((c) => (c.coverBalance || 0) > 0);
      const final = pickBest(withBal) || best;
      return { ok: true, cover: final };
    }
  }
  // 2. Phone fallback — try exact + last-10-digits (covers store either form).
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 6) {
    const tail10 = digits.slice(-10);
    const variants = Array.from(new Set([digits, tail10].filter((s) => s.length >= 6)));
    const candidates: HodCover[] = [];
    for (const v of variants) {
      try {
        const q = query(collection(db, COVERS_COL), where("phone", "==", v), limit(10));
        const snap = await getDocs(q);
        snap.docs.forEach((d) => candidates.push({ id: d.id, ...(d.data() as Omit<HodCover, "id">) }));
      } catch (e) {
        console.warn("[findCoverForRedemption] phone query failed", e);
      }
    }
    const seen = new Set<string>();
    const unique = candidates.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
    const withBal = unique.filter((c) => (c.coverBalance || 0) > 0);
    const best = pickBest(withBal) || pickBest(unique);
    if (best) return { ok: true, cover: best };
  }
  return { ok: false, reason: "No wallet found for that QR / phone / ref" };
}

/** Captain Mode: redeem `requested` ₹ from a customer wallet (cover) against
 *  an open table reservation. Atomic via runTransaction — race-safe with Bar
 *  Mode drink-round activations and other Captain redemptions on the same
 *  wallet (Loophole #1).
 *
 *  Smart auto-fit (Khushi spec): actual deduction = min(requested, walletBalance).
 *  Caller passes the bill REMAINING and we deduct only what's available — the
 *  friend's ₹2000 wallet hit by a ₹1500 remainder ends up at ₹500, not ₹0.
 *
 *  Idempotency: same {tableDocId, walletRef, amount} within 60 sec is treated
 *  as a duplicate scan and returns the prior entry without re-deducting
 *  (Loophole #10).
 *
 *  Throws on: wallet not found · wallet expired · zero balance · reservation
 *  paid/voided · same wallet already redeemed at this table (use undo first). */
export async function redeemFromWalletAtTable(
  reservationDocId: string,
  /** Firestore DOC ID of the cover (HodCover.id) — NOT the public HOD-XXX ref.
   *  For table-source / aggregator-mint covers the doc id is derived from the
   *  bookingId via `coverDocIdFor()` and differs from the public `ref` field.
   *  An orphan empty doc may exist at the public-ref id, so we MUST write to
   *  the doc id returned by findCoverForRedemption. The public ref is read
   *  out of the doc itself inside the transaction and stored on the
   *  WalletRedemption entry for display/dedup. */
  walletDocId: string,
  requested: number,
  captainName: string,
  /** Caller (Mark-Paid modal) passes the bill's TOTAL final amount (subtotal +
   *  SC + GST after discount). Inside the transaction we enforce the invariant
   *  `sum(existing walletRedemptions) + amountRedeemed <= billCap` so a stale
   *  modal / concurrent redeem on a second terminal can't drain a wallet past
   *  the bill total. Without this, the captain's local `remaining` was the
   *  only ceiling — vulnerable to race/staleness/tampering (see architect
   *  review 2026-05-15). Pass `0` or omit for legacy callers (no cap). */
  billCap?: number
): Promise<{ amountRedeemed: number; newWalletBalance: number; redemption: WalletRedemption }> {
  if (!reservationDocId || !walletDocId) throw new Error("Missing reservation or wallet doc id");
  if (!requested || requested <= 0) throw new Error("Amount must be > 0");
  const want = Math.round(requested * 100) / 100;
  const at = new Date().toISOString();
  const txId = `${reservationDocId}-${walletDocId}-${Date.now()}`;
  const resvRef = doc(db, TABLE_RES_COL, reservationDocId);
  const coverRef = doc(db, COVERS_COL, walletDocId);
  let amountRedeemed = 0;
  let newWalletBalance = 0;
  let redemption: WalletRedemption | null = null;

  await runTransaction(db, async (tx) => {
    const [resvSnap, coverSnap] = await Promise.all([tx.get(resvRef), tx.get(coverRef)]);
    if (!resvSnap.exists()) throw new Error("Table reservation not found");
    if (!coverSnap.exists()) throw new Error("Wallet not found");
    const resv = resvSnap.data();
    const cover = coverSnap.data();
    if (isTableBillSettled(resv)) throw new Error("Bill already settled — cannot redeem more");
    if (resv.status === "voided") throw new Error("Bill is voided — cannot redeem");
    // Loophole #5 — wallet expired
    if (cover.expiresAt) {
      const exp = new Date(cover.expiresAt).getTime();
      if (exp && exp < Date.now()) {
        throw new Error(`Wallet expired at ${new Date(exp).toLocaleString()}`);
      }
    }
    // Public ref (HOD-XXX) is read from the cover doc itself. We dedup/store
    // by this string so a customer's wallet is uniquely identified across
    // any orphan/duplicate doc-id quirks.
    const publicRef = String(cover.ref || walletDocId);
    const balance = Number(cover.coverBalance || 0);
    if (balance <= 0) throw new Error(`Wallet ${publicRef} has zero balance`);

    const existing: WalletRedemption[] = Array.isArray(resv.walletRedemptions) ? resv.walletRedemptions : [];
    // Loophole #10 — duplicate scan within 60 sec → return prior entry, no re-deduct.
    const dupe = existing.find((r) =>
      r.walletRef === publicRef &&
      Math.abs(r.amount - want) < 0.01 &&
      Date.now() - new Date(r.redeemedAt).getTime() < 60_000
    );
    if (dupe) {
      amountRedeemed = dupe.amount;
      newWalletBalance = balance;
      redemption = dupe;
      return;
    }
    // Block re-redemption from same wallet at same table — caller should call
    // undo first. (Different from idempotency above: this catches a deliberate
    // 2nd scan after the first one settled.)
    if (existing.some((r) => r.walletRef === publicRef)) {
      throw new Error(`Wallet ${publicRef} already redeemed at this table — undo first to re-scan`);
    }

    // Smart auto-fit: deduct min(requested, balance, billCap-already-redeemed).
    // The billCap arm closes the architect-flagged race: two concurrent redeems
    // on the same table (different terminals / stale modal) can't combine to
    // exceed the bill total. If existing redemptions already hit the cap we
    // throw — captain must undo first or the customer was over-charged earlier.
    const existingTotal = existing.reduce((s, r) => s + (r.amount || 0), 0);
    const capRemaining = billCap && billCap > 0
      ? Math.max(0, Math.round((billCap - existingTotal) * 100) / 100)
      : Infinity;
    if (capRemaining <= 0) {
      throw new Error(`Bill already fully covered by wallets (${existingTotal} of ${billCap}). Undo a prior redemption first.`);
    }
    amountRedeemed = Math.round(Math.min(want, balance, capRemaining) * 100) / 100;
    newWalletBalance = Math.round((balance - amountRedeemed) * 100) / 100;
    const oldUsed = Number(cover.coverUsed || 0);
    redemption = {
      walletRef: publicRef, walletDocId, walletName: String(cover.name || ""),
      walletPhone: String(cover.phone || ""),
      amount: amountRedeemed, redeemedAt: at, redeemedBy: captainName, txId,
    };
    // 🔴 2026-05-20 (Khushi Bug 2 fix) — when captain settles bill against
    // this wallet, ALSO mark customer self-order rounds (status
    // "preparing"/"activated") as "served". Without this, the customer site
    // keeps subtracting those old rounds from coverBalance forever and shows
    // "INSUFFICIENT BALANCE · need ₹X more" on the customer's next order,
    // even though the captain has already taken the money. Single source of
    // truth: coverBalance after this update.
    //
    // ⚠️ Concurrency guard (architect 2026-05-20): only convert rounds that
    // existed BEFORE this transaction started (placedAt <= txStartAt). If a
    // customer self-orders a NEW round while captain is settling, Firestore
    // will retry the transaction and the new round will appear here too —
    // we MUST NOT serve it, because it wasn't in the captain's bill cap.
    // The new round stays "preparing" so customer site still subtracts it
    // and bartender/captain settles it later.
    const existingRounds: Array<{ status?: string; servedAt?: string; servedBy?: string; placedAt?: string }> = Array.isArray(cover.tabRounds) ? cover.tabRounds : [];
    const txStartAt = at; // ISO captured before tx — see line ~1467
    let roundsTouched = false;
    const settledRounds = existingRounds.map((r) => {
      if (r && (r.status === "preparing" || r.status === "activated")) {
        // If placedAt is missing (legacy round) treat as pre-existing.
        const placedAt = r.placedAt || "";
        if (!placedAt || placedAt <= txStartAt) {
          roundsTouched = true;
          return { ...r, status: "served", servedAt: at, servedBy: captainName };
        }
      }
      return r;
    });
    const coverUpdate: Record<string, unknown> = {
      coverBalance: newWalletBalance,
      coverUsed: Math.round((oldUsed + amountRedeemed) * 100) / 100,
      transactions: arrayUnion({
        type: "table-redemption",
        amount: amountRedeemed,
        note: `Redeemed at table ${resv.tableId || "?"} by ${captainName}`,
        timestamp: at,
        staff: captainName,
        paymentId: txId,
      }),
    };
    if (roundsTouched) coverUpdate.tabRounds = settledRounds;
    tx.update(coverRef, coverUpdate);
    tx.update(resvRef, { walletRedemptions: [...existing, redemption] });
  });
  return { amountRedeemed, newWalletBalance, redemption: redemption! };
}

/** Captain Mode: undo a wallet redemption that hasn't been bill-closed yet.
 *  Refunds the ₹ to the wallet and removes the entry from the reservation.
 *  Used when captain scans wrong wallet or customer changes mind BEFORE bill
 *  close. Throws if bill already marked paid — Khushi Q3 spec: post-paid
 *  refunds happen via Void Bill + manager-approved cash refund, NOT wallet. */
export async function undoWalletRedemption(
  reservationDocId: string,
  txId: string,
  captainName: string
): Promise<void> {
  const resvRef = doc(db, TABLE_RES_COL, reservationDocId);
  const at = new Date().toISOString();
  await runTransaction(db, async (tx) => {
    const resvSnap = await tx.get(resvRef);
    if (!resvSnap.exists()) throw new Error("Reservation not found");
    const resv = resvSnap.data();
    if (isTableBillSettled(resv)) {
      throw new Error("Bill already settled — use Void Bill + cash refund, not wallet undo");
    }
    const list: WalletRedemption[] = Array.isArray(resv.walletRedemptions) ? resv.walletRedemptions : [];
    const idx = list.findIndex((r) => r.txId === txId);
    if (idx < 0) throw new Error("Redemption not found (already undone?)");
    const entry = list[idx];
    // Use stored doc id (correct one written from 2026-05-15 onward); fall
    // back to walletRef for legacy entries that pre-date the field.
    const coverDocId = entry.walletDocId || entry.walletRef;
    const coverRef = doc(db, COVERS_COL, coverDocId);
    const coverSnap = await tx.get(coverRef);
    if (!coverSnap.exists()) throw new Error("Wallet not found (deleted?)");
    const cover = coverSnap.data();
    const balance = Number(cover.coverBalance || 0);
    const used = Number(cover.coverUsed || 0);
    tx.update(coverRef, {
      coverBalance: Math.round((balance + entry.amount) * 100) / 100,
      coverUsed: Math.max(0, Math.round((used - entry.amount) * 100) / 100),
      transactions: arrayUnion({
        type: "table-redemption-undo",
        amount: entry.amount,
        note: `Undone by ${captainName} at table ${resv.tableId || "?"}`,
        timestamp: at,
        staff: captainName,
        paymentId: `undo-${entry.txId}`,
      }),
    });
    tx.update(resvRef, { walletRedemptions: [...list.slice(0, idx), ...list.slice(idx + 1)] });
  });
}

export async function markTablePaid(
  docId: string,
  payment: {
    amount: number; method: string; captainName: string;
    aggregator?: string; aggregatorDiscount?: number;
    /** 🔴 2026-05-12 — Net amount the venue receives from the aggregator
     *  after their platform discount/commission. Stored ONLY for reporting:
     *  `amount` is what the customer was billed (full invoice, no discount
     *  applied for aggregator orders); `aggregatorNetAmount` is what the
     *  venue actually nets so admin can reconcile in Reports. */
    aggregatorNetAmount?: number;
    discountPercent?: number; discountAmount?: number;
    serviceChargeAmount?: number; serviceChargeApplied?: boolean;
    taxAmount?: number;
    /** D1/D2 — when the captain triggers a manager-PIN-gated override
     *  (high-discount or service-charge waiver), pass the entries here so they
     *  get appended to discountOverrideLog atomically with the payment. */
    overrideEntries?: Array<{
      kind: "high-discount" | "sc-waiver";
      valueBefore: number; valueAfter: number; tabTotal: number; reason: string;
    }>;
    /** Split payment — captain can split the bill across cash/card/upi. Sum
     *  MUST equal `amount`. Caller validates sum before calling. Stored on
     *  doc as `paymentSplits` for Reports + audit. `method` field becomes a
     *  summary like "split:cash+card". */
    splits?: Array<{ method: string; amount: number }>;
    /** 2026-05-15 — Sum of `walletRedemptions[].amount` already deducted at this
     *  table BEFORE markPaid. Reports + cash-drawer reconciliation use this:
     *  `amount` = TOTAL bill (cash+wallet); `walletPaidAmount` = the wallet
     *  slice. Cash collected = amount − walletPaidAmount. Pass `undefined` (not
     *  0) to keep doc clean when no wallet redemption happened. */
    walletPaidAmount?: number;
  },
  bookingRef?: string
): Promise<void> {
  const upd: Record<string, unknown> = {
    paymentStatus: "paid", paymentMode: payment.method, amountPaid: payment.amount,
    paidAt: new Date().toISOString(), captainName: payment.captainName,
  };
  if (payment.walletPaidAmount !== undefined && payment.walletPaidAmount > 0) {
    upd.walletPaidAmount = payment.walletPaidAmount;
  }
  if (payment.splits && payment.splits.length > 0) {
    upd.paymentSplits = payment.splits.map((s) => ({ method: s.method, amount: s.amount }));
  }
  if (payment.aggregator) upd.aggregator = payment.aggregator;
  if (payment.aggregatorDiscount) upd.aggregatorDiscount = payment.aggregatorDiscount;
  if (payment.aggregatorNetAmount !== undefined) upd.aggregatorNetAmount = payment.aggregatorNetAmount;
  if (payment.discountPercent) upd.discountPercent = payment.discountPercent;
  if (payment.discountAmount) upd.discountAmount = payment.discountAmount;
  if (payment.serviceChargeAmount !== undefined) upd.serviceChargeAmount = payment.serviceChargeAmount;
  if (payment.serviceChargeApplied !== undefined) upd.serviceChargeApplied = payment.serviceChargeApplied;
  if (payment.taxAmount) upd.taxAmount = payment.taxAmount;
  // D1/D2 — append override approvals atomically (read-then-write so we don't
  // clobber any prior entries from earlier approvals on the same table).
  if (payment.overrideEntries && payment.overrideEntries.length > 0) {
    const snap = await getDoc(doc(db, TABLE_RES_COL, docId));
    const existing = snap.exists() && Array.isArray(snap.data().discountOverrideLog)
      ? (snap.data().discountOverrideLog as unknown[]) : [];
    const now = new Date().toISOString();
    const newEntries = payment.overrideEntries.map((e) => ({
      at: now, by: payment.captainName, kind: e.kind,
      valueBefore: e.valueBefore, valueAfter: e.valueAfter,
      tabTotal: e.tabTotal, reason: e.reason,
    }));
    upd.discountOverrideLog = [...existing, ...newEntries];
  }
  await updateDoc(doc(db, TABLE_RES_COL, docId), upd);
  // 🔴 2026-05-19 (Khushi LIVE FIX) — if no covers doc exists yet (race), this
  // merge:true write would create a stub without isTableBooking, kicking the
  // customer's wallet view back into cover-mode. Force the flag since this
  // function is only called for TABLE bills.
  if (bookingRef) await setDoc(doc(db, COVERS_COL, bookingRef), { ...upd, isTableBooking: true, date: getOperationalNightStr() }, { merge: true }).catch(() => {});
}

/** V1 — Record a void event when items are removed from an already-activated
 *  or served round (i.e. KOT was already printed). Append-only, atomic.
 *  Caller is responsible for separately calling updateRoundItems to actually
 *  apply the change. */
export async function recordKotVoid(
  docId: string,
  entry: {
    by: string; roundNum: number; roundStatus: string;
    voided: Array<{ n: string; qty: number; p: number }>;
    valueLost: number; reason?: string;
    /** V3 2026-05-10 — customer/contact snapshot baked in so the audit page
     *  can render full context without a second Firestore read. Captured at
     *  void-time (not derived) so guest renames don't rewrite history. */
    customerName?: string; customerPhone?: string; tableId?: string;
  },
  bookingRef?: string
): Promise<void> {
  const ref = doc(db, TABLE_RES_COL, docId);
  const at = new Date().toISOString();
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("Reservation not found");
    const data = snap.data();
    const log = Array.isArray(data.voidLog) ? [...data.voidLog] : [];
    // Belt-and-braces: if caller didn't pass identity fields, fill from doc so
    // the audit row never lands blank (e.g. legacy callers).
    const enriched = {
      at, kind: "items-void",
      customerName: entry.customerName || (data.customerName as string) || "",
      customerPhone: entry.customerPhone || (data.phone as string) || "",
      tableId: entry.tableId || (data.tableId as string) || "",
      ...entry,
    };
    log.push(enriched);
    tx.update(ref, { voidLog: log });
  });
  if (bookingRef) {
    await updateDoc(doc(db, COVERS_COL, bookingRef), {
      voidLog: arrayUnion({ at, kind: "items-void", ...entry }),
    }).catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════════════════
// V3 2026-05-10 — SILENT PRE-PRINT EDIT LOG (Anti-Fraud #A1)
// ────────────────────────────────────────────────────────────────────────
// PROBLEM: When a captain edits a round BEFORE the KOT is printed, today
// there is NO audit trail. Captain can quietly add 5 drinks then drop 2
// before printing → those 2 are never recorded → cash-pocket scam vector.
// SOLUTION: Append-only `silentEditLog` array on the reservation. Pre-print
// reductions (qty down or item removed) are logged automatically — no PIN,
// no manager friction, no slip print (Khushi-approved: captain MUST be able
// to fix typos freely; we just want the receipts). Live Monitor shows a
// "🔇 SILENT PRE-PRINT EDITS" tile that pulses red on activity in last 15min.
// Audit page lists each one with full diff + customer + table context.
// FALLBACK: if the append fails, the underlying item update still goes
// through (try/catch logs warn). Worst case = missing audit row, never a
// blocked legitimate edit.
// ════════════════════════════════════════════════════════════════════════
export async function recordSilentPrePrintEdit(
  docId: string,
  entry: {
    by: string; roundNum: number;
    /** Items that disappeared or had qty reduced from the round before print. */
    removed: Array<{ n: string; qty: number; p: number }>;
    /** Sum of (qty × p) for the removed slice — the "would-have-been" tab impact. */
    valueRemoved: number;
    tableId?: string; customerName?: string;
  },
  bookingRef?: string
): Promise<void> {
  if (!entry.removed || entry.removed.length === 0) return;
  const ref = doc(db, TABLE_RES_COL, docId);
  const at = new Date().toISOString();
  const enriched = { at, ...entry };
  // Use arrayUnion for cheap append; we don't need read-modify-write here
  // because each entry has a unique `at` ISO timestamp = no dedupe collisions.
  await updateDoc(ref, { silentEditLog: arrayUnion(enriched) });
  if (bookingRef) {
    await updateDoc(doc(db, COVERS_COL, bookingRef), {
      silentEditLog: arrayUnion(enriched),
    }).catch(() => {});
  }
}

/** V3 — VOID BILL (Khushi 2026-05-10).
 *  Marks the reservation as voided AFTER a bill has been printed but BEFORE
 *  payment was collected. Use case: customer refuses to pay (food bad, service
 *  issue, walked out, dispute). The bill stays on record for audit; the table
 *  is freed for the next guest. Manager-PIN gated at the UI; this fn just
 *  persists.
 *
 *  Writes:
 *    1. reservation.status="voided", voidedAt, voidedBy, voidReason, voidNotes,
 *       voidedBillTotal (so we can sum leakage in Reports)
 *    2. appends a voidLog entry (kind="bill-void") so it shows in audit timeline
 *    3. mirrors voidLog to the linked cover doc for cross-tab consistency
 *
 *  🛡 Fallback: if the cover-doc mirror fails (no bookingRef, deleted, etc.)
 *  the table-side void is STILL persisted — this is what the audit relies on.
 *  Cover mirror is a nice-to-have, not the source of truth. */
export async function voidBill(
  docId: string,
  entry: {
    by: string;
    reason: string;
    notes?: string;
    /** Final bill total (post tax + discount) at the moment of void — for leakage report. */
    billTotal: number;
    /** Subtotal (pre-tax) — useful for Reports tally. */
    subtotal: number;
    /** Bill print count at void-time. */
    billPrintCount: number;
  },
  bookingRef?: string
): Promise<void> {
  const ref = doc(db, TABLE_RES_COL, docId);
  const at = new Date().toISOString();
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("Reservation not found");
    const data = snap.data();
    const log = Array.isArray(data.voidLog) ? [...data.voidLog] : [];
    // V3 2026-05-10 — write `valueLost` (not just billTotal) so the existing
    // AuditPage/Reports rollups that sum voidLog[].valueLost pick this up
    // without a second code change. Also bake customer + table identity into
    // the entry so the audit row renders full context with one read.
    const enriched = {
      at,
      kind: "bill-void",
      valueLost: entry.billTotal,
      customerName: (data.customerName as string) || "",
      customerPhone: (data.phone as string) || "",
      tableId: (data.tableId as string) || "",
      ...entry,
    };
    log.push(enriched);
    tx.update(ref, {
      status: "voided",
      voidedAt: at,
      voidedBy: entry.by,
      voidReason: entry.reason,
      voidNotes: entry.notes || "",
      voidedBillTotal: entry.billTotal,
      voidLog: log,
    });
  });
  if (bookingRef) {
    await updateDoc(doc(db, COVERS_COL, bookingRef), {
      voidLog: arrayUnion({ at, kind: "bill-void", valueLost: entry.billTotal, ...entry }),
      billVoided: true,
      billVoidedAt: at,
      billVoidReason: entry.reason,
    }).catch(() => {});
  }
  // V3 2026-05-10 — Anti-Fraud #A3: enqueue WhatsApp notice to the customer
  // so they're aware their bill was voided. Closes the cash-pocket scam where
  // captain pockets cash + voids the bill — customer learns immediately and
  // can call Khushi if they DID pay. Best-effort: queue write failure must
  // NEVER block the void itself (else captain might not retry the void).
  // Queue is processed by `voidNotifyCustomer` cloud function (code-drop in
  // hod-functions-patch). If phone is missing, queue still records with
  // status="skipped-no-phone" so the audit shows the gap.
  try {
    // Single re-read — read once and pluck all 3 fields, vs. 3 round-trips.
    const fresh = (await getDoc(ref)).data() || {};
    const phone = fresh.phone as string | undefined;
    const custName = fresh.customerName as string | undefined;
    const tableId = fresh.tableId as string | undefined;
    await addDoc(collection(db, "voidNotificationsQueue"), {
      type: "bill-void",
      tableId: tableId || "",
      customerName: custName || "",
      customerPhone: phone || "",
      billTotal: entry.billTotal,
      voidedBy: entry.by,
      voidReason: entry.reason,
      voidNotes: entry.notes || "",
      reservationDocId: docId,
      bookingRef: bookingRef || "",
      createdAt: at,
      status: phone ? "pending" : "skipped-no-phone",
    });
  } catch (e) {
    console.warn("[voidBill] customer notification queue failed (best-effort)", e);
  }
}

/** V3 2026-05-11 — voidWalletBill (BAR MODE counterpart of voidBill).
 *  When a wallet/cover-driven bill needs to be voided (drink poured wrong /
 *  customer refused / quality issue / printer mistake), this:
 *   1. Sums every activated/served round's roundTotal → that's the ₹ already
 *      debited from the wallet at activation time.
 *   2. REFUNDS that total back into coverBalance (so customer's wallet is
 *      restored to what they actually paid in).
 *   3. Marks each activated/served round status:'voided' + pushes a per-round
 *      voidLog entry with reason + by + at + valueLost.
 *   4. Sets cover-level billVoided + voidedBy + voidedAt + voidReason +
 *      voidNotes + voidedBillTotal (mirrors the captain-side voidBill fields).
 *   5. Pushes a {type:'void-refund', amount, by, reason} transaction so the
 *      audit timeline shows the refund alongside recharges/activations.
 *   6. Best-effort enqueues a WhatsApp notice to the customer (Anti-Fraud #A3
 *      pattern — closes the cash-pocket scam where bartender voids the bill
 *      and pockets cash). Never blocks the void on queue failure.
 *  Fallback: WhatsApp queue write failure → console.warn only; the actual
 *  refund + void persists. Worst case = customer doesn't get a WA ping; the
 *  audit row is intact and Khushi sees it on the next morning's digest. */
export async function voidWalletBill(
  coverId: string,
  entry: {
    by: string;
    reason: string;
    notes?: string;
    /** Bill print count at void-time (informational, prints on the slip). */
    billPrintCount: number;
  }
): Promise<{ refundedAmount: number; newBalance: number; voidedRounds: HodTabRound[] }> {
  const ref = doc(db, COVERS_COL, coverId);
  const at = new Date().toISOString();
  let refundedAmount = 0;
  let newBalance = 0;
  let voidedRounds: HodTabRound[] = [];
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("Wallet not found");
    const data = snap.data();
    const rounds: HodTabRound[] = Array.isArray(data.tabRounds) ? [...data.tabRounds] : [];
    // Refund every round that ALREADY DEBITED the wallet (activated or served).
    // 'preparing' rounds haven't debited yet — leave them alone (bartender can
    // discard separately). 'voided' rounds were already refunded — skip.
    const targetIdxs: number[] = [];
    let refund = 0;
    rounds.forEach((rd, i) => {
      if (!rd) return;
      if (rd.status === "activated" || rd.status === "served") {
        targetIdxs.push(i);
        refund += Number(rd.roundTotal || 0);
      }
    });
    if (targetIdxs.length === 0) throw new Error("No activated rounds to void");
    targetIdxs.forEach((i) => {
      const rd = rounds[i];
      const rdLoose = rd as unknown as { voidLog?: unknown[] };
      const log = Array.isArray(rdLoose.voidLog) ? [...rdLoose.voidLog] : [];
      log.push({ at, by: entry.by, reason: entry.reason, notes: entry.notes || "", valueLost: Number(rd.roundTotal || 0), kind: "bill-void" });
      // 'voided' is a valid runtime status (mirrors captain-side void semantics)
      // even though HodTabRound's status union doesn't list it. Cast via unknown.
      rounds[i] = { ...rd, status: "voided" as unknown as HodTabRound["status"], voidLog: log } as unknown as HodTabRound;
    });
    refundedAmount = Math.round(refund * 100) / 100;
    const oldBal = Number(data.coverBalance || 0);
    const oldUsed = Number(data.coverUsed || 0);
    newBalance = Math.round((oldBal + refundedAmount) * 100) / 100;
    voidedRounds = targetIdxs.map((i) => rounds[i]);
    tx.update(ref, {
      tabRounds: rounds,
      coverBalance: newBalance,
      coverUsed: Math.max(0, Math.round((oldUsed - refundedAmount) * 100) / 100),
      billVoided: true,
      billVoidedAt: at,
      billVoidedBy: entry.by,
      billVoidReason: entry.reason,
      billVoidNotes: entry.notes || "",
      voidedBillTotal: refundedAmount,
      voidLog: arrayUnion({ at, kind: "bill-void", valueLost: refundedAmount, by: entry.by, reason: entry.reason, notes: entry.notes || "", customerName: data.name || "", customerPhone: data.phone || "" }),
      transactions: arrayUnion({ type: "void-refund", amount: refundedAmount, by: entry.by, reason: entry.reason, at }),
    });
  });
  // Best-effort customer notification (mirror voidBill's Anti-Fraud #A3 path).
  try {
    const fresh = (await getDoc(ref)).data() || {};
    const phone = (fresh.phone as string | undefined) || "";
    const custName = (fresh.name as string | undefined) || "";
    const tableId = (fresh.tableId as string | undefined) || "";
    await addDoc(collection(db, "voidNotificationsQueue"), {
      type: "wallet-bill-void",
      tableId,
      customerName: custName,
      customerPhone: phone,
      billTotal: refundedAmount,
      voidedBy: entry.by,
      voidReason: entry.reason,
      voidNotes: entry.notes || "",
      coverId,
      bookingRef: (fresh.ref as string | undefined) || "",
      createdAt: at,
      status: phone ? "pending" : "skipped-no-phone",
    });
  } catch (e) {
    console.warn("[voidWalletBill] customer notification queue failed (best-effort)", e);
  }
  return { refundedAmount, newBalance, voidedRounds };
}

// ════════════════════════════════════════════════════════════════════════
// V3 2026-05-10 — CAPTAIN VOID CAP + AUTO-SUSPEND (Anti-Fraud #A2)
// ────────────────────────────────────────────────────────────────────────
// Per-captain, per-operational-night caps. Crossing EITHER cap auto-locks
// that captain from FURTHER voids until an Admin (9999) unlocks them.
// The triggering void itself completes — Manager already approved it; we
// just stop the bleeding for the rest of the night.
//
// Storage: captainVoidStats/{nightStr}_{captainKey}. Composite key so each
// new operational night starts clean and we can query "today's locks".
// ════════════════════════════════════════════════════════════════════════
const VOID_CAP_COUNT = 5;
const VOID_CAP_VALUE = 3000;
const CAPTAIN_VOID_STATS_COL = "captainVoidStats";

const captainKey = (name: string) =>
  String(name || "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "") || "unknown";

export interface CaptainVoidStats {
  id: string;            // {nightStr}_{captainKey}
  captainName: string;
  nightStr: string;
  voidCount: number;
  voidValue: number;
  suspended: boolean;
  suspendedAt?: string;
  suspendReason?: string;
  unlockedBy?: string;
  unlockedAt?: string;
  lastVoidAt?: string;
}

/** Throws a clear human-readable error if the captain is currently suspended
 *  from voiding. Call this BEFORE opening the void modal so the captain
 *  doesn't waste effort entering reason/PIN. */
export async function assertCaptainCanVoid(captainName: string): Promise<void> {
  const night = getOperationalNightStr();
  const key = `${night}_${captainKey(captainName)}`;
  const ref = doc(db, CAPTAIN_VOID_STATS_COL, key);
  // V3 2026-05-10 FAIL-OPEN: anti-fraud cap is a NICE-TO-HAVE; voiding the
  // bill is a CRITICAL revenue-correction flow. If Firestore rules deny the
  // read (e.g. rules patch not yet deployed on Khushi's project), we MUST
  // NOT block the captain from voiding — log a warn and let it through.
  // Worst case = no daily-cap enforcement; correct behaviour preserved.
  let snap;
  try {
    snap = await getDoc(ref);
  } catch (e: any) {
    const msg = String(e?.code || e?.message || e);
    if (msg.includes("permission") || msg.includes("insufficient") || e?.code === "permission-denied") {
      console.warn("[assertCaptainCanVoid] rules deny captainVoidStats read — failing OPEN (cap disabled until rules patch deployed)", e);
      return;
    }
    throw e;
  }
  if (snap.exists() && (snap.data() as CaptainVoidStats).suspended) {
    const d = snap.data() as CaptainVoidStats;
    throw new Error(
      `🚫 ${captainName.toUpperCase()} IS SUSPENDED FROM VOIDING TONIGHT.\n\n` +
      `Reason: ${d.suspendReason || "Daily void cap reached"}\n` +
      `Tonight's voids: ${d.voidCount} · ₹${d.voidValue}\n\n` +
      `Call Admin to unlock from Admin Panel → 🔓 Locks tab.`
    );
  }
}

/** Atomically increments today's void counters for this captain. If the new
 *  totals cross EITHER cap, sets suspended=true so the next void is blocked.
 *  This call happens AFTER the manager-approved void persists, so the current
 *  void is never blocked retroactively. */
export async function recordCaptainVoidUsage(
  captainName: string, valueLost: number
): Promise<{ voidCount: number; voidValue: number; suspended: boolean }> {
  const night = getOperationalNightStr();
  const key = `${night}_${captainKey(captainName)}`;
  const ref = doc(db, CAPTAIN_VOID_STATS_COL, key);
  const at = new Date().toISOString();
  // V3 2026-05-10 FAIL-OPEN: increment is best-effort. If rules deny, the
  // void itself has already persisted — we just lose this counter row.
  // Returning a synthetic "not-suspended" result keeps the caller's UX intact.
  try {
    return await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const prev = snap.exists() ? (snap.data() as CaptainVoidStats) : null;
      const voidCount = (prev?.voidCount || 0) + 1;
      const voidValue = (prev?.voidValue || 0) + Math.max(0, Math.round(valueLost));
      const willSuspend = voidCount >= VOID_CAP_COUNT || voidValue >= VOID_CAP_VALUE;
      const next: CaptainVoidStats = {
        id: key,
        captainName,
        nightStr: night,
        voidCount,
        voidValue,
        suspended: prev?.suspended || willSuspend,
        lastVoidAt: at,
        ...(willSuspend && !prev?.suspended ? {
          suspendedAt: at,
          suspendReason: voidCount >= VOID_CAP_COUNT
            ? `Hit count cap (${voidCount}/${VOID_CAP_COUNT} voids tonight)`
            : `Hit value cap (₹${voidValue} ≥ ₹${VOID_CAP_VALUE} tonight)`,
        } : {}),
      };
      tx.set(ref, next, { merge: true });
      return { voidCount, voidValue, suspended: next.suspended };
    });
  } catch (e: any) {
    const msg = String(e?.code || e?.message || e);
    if (msg.includes("permission") || msg.includes("insufficient") || e?.code === "permission-denied") {
      console.warn("[recordCaptainVoidUsage] rules deny captainVoidStats write — counter skipped (cap disabled until rules patch deployed)", e);
      return { voidCount: 0, voidValue: 0, suspended: false };
    }
    throw e;
  }
}

/** Admin tool — list all captains suspended on the CURRENT operational night.
 *  Used by AdminPage → 🔓 Locks tab. */
/** Sentinel error code so the Locks tab UI can show a friendly "rules patch
 *  not yet deployed" copy-paste message instead of a generic red error. */
export class CaptainVoidStatsRulesError extends Error {
  code = "captain-void-stats-rules-missing" as const;
  constructor() { super("Firestore rules block captainVoidStats reads. Deploy the rules patch from hod-functions-patch/firestore.rules.patch.md to enable this tab."); }
}

export async function listSuspendedCaptainsToday(): Promise<CaptainVoidStats[]> {
  const night = getOperationalNightStr();
  const q = query(
    collection(db, CAPTAIN_VOID_STATS_COL),
    where("nightStr", "==", night),
    where("suspended", "==", true),
  );
  try {
    const snap = await getDocs(q);
    const out: CaptainVoidStats[] = [];
    snap.forEach((d) => out.push({ ...(d.data() as CaptainVoidStats), id: d.id }));
    return out;
  } catch (e: any) {
    const msg = String(e?.code || e?.message || e);
    if (msg.includes("permission") || msg.includes("insufficient") || e?.code === "permission-denied") {
      throw new CaptainVoidStatsRulesError();
    }
    throw e;
  }
}

/** Admin unlock — clears suspension for the rest of the night. Resets count
 *  to 0 so the captain gets a fresh cap (Khushi-approved: "they called me,
 *  I trust them now"). Logged with admin name + timestamp for the audit. */
export async function unlockCaptainVoids(statsDocId: string, unlockedBy: string): Promise<void> {
  const ref = doc(db, CAPTAIN_VOID_STATS_COL, statsDocId);
  await updateDoc(ref, {
    suspended: false,
    unlockedBy,
    unlockedAt: new Date().toISOString(),
    voidCount: 0,
    voidValue: 0,
  });
}

/** V3 — VOID BILL PRINT SLIP.
 *  Prints a loud "🚫 BILL VOIDED" notice on the floor's bill printer so the
 *  paper trail matches the digital one. Fire-and-forget — if printer is down,
 *  the void is still recorded in voidLog (caller already wrote to Firestore). */
export async function printBillVoid(data: {
  tableId: string; floorLabel?: string; customerName?: string; staff: string;
  billTotal: number; reason: string; notes?: string;
  tabletFloor?: TabletFloor | null;
}): Promise<boolean> {
  try {
    const tabletFloor = data.tabletFloor ?? getTabletFloor();
    const dest = floorTag(tabletFloor, "bill");
    const items = [
      { n: `*** BILL VOIDED — ${data.tableId} ***`, p: 0, qty: 1, t: "food" as const, dest },
      { n: `REASON: ${(data.reason || "").toUpperCase()}`, p: 0, qty: 1, t: "food" as const, dest },
      ...(data.notes ? [{ n: `NOTES: ${data.notes}`, p: 0, qty: 1, t: "food" as const, dest }] : []),
      { n: `LOST VALUE: ₹${Math.round(data.billTotal)}`, p: 0, qty: 1, t: "food" as const, dest },
      { n: `BY: ${data.staff} · ${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`, p: 0, qty: 1, t: "food" as const, dest },
    ];
    await addDoc(collection(db, "posKOTs"), {
      tableId: data.tableId,
      floorLabel: data.floorLabel || null,
      customerName: data.customerName || null,
      staff: data.staff,
      roundNum: 0,
      items,
      roundTotal: -Math.abs(data.billTotal),
      voidNotice: true,
      billVoidNotice: true,
      voidReason: data.reason,
      time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
      tabletFloor: tabletFloor || null,
      destinations: [dest],
      prints: { [dest]: { status: "pending", claimedBy: null, printedAt: null, attempts: 0 } },
      status: "pending",
      createdAt: serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.error("[printBillVoid] failed", e);
    return false;
  }
}

/** D3 / L-A1 / L-A4 — Record a discount or source override on a reservation.
 *  Used by walk-in creation (D3), door-side aggregator booking (L-A1), and
 *  captain's pre-bill Source/Discount panel (L-A4). All overrides appear
 *  together in the Live Monitor + /audit timeline. */
export async function recordWalkInDiscountOverride(
  docId: string,
  entry: {
    by: string; valueBefore: number; valueAfter: number; reason: string;
    kind?: "walkin-discount" | "door-aggregator" | "captain-source-swap" | "captain-discount-edit";
    sourceBefore?: string; sourceAfter?: string;
  }
): Promise<void> {
  // Do NOT swallow errors here — a silently-dropped audit log on an over-
  // threshold discount is exactly the loophole D3 was meant to close.
  // Caller (WalkInModal / handleAggChange / DoorMode) will surface via alert().
  await updateDoc(doc(db, TABLE_RES_COL, docId), {
    discountOverrideLog: arrayUnion({
      at: new Date().toISOString(), by: entry.by, kind: entry.kind || "walkin-discount",
      valueBefore: entry.valueBefore, valueAfter: entry.valueAfter,
      sourceBefore: entry.sourceBefore || "",
      sourceAfter: entry.sourceAfter || "",
      tabTotal: 0, reason: entry.reason,
    }),
  });
}

/** Audit-page helper: pull the most recent KOT print docs (kind != "bill")
 *  from posKOTs. Used by AuditPage to surface KOT activity alongside bill
 *  prints and voids. Returns lightweight rows ordered newest-first. */
export async function getRecentKotPrints(maxRows = 200): Promise<Array<{
  id: string; tableId: string; customerName?: string; staff: string;
  roundNum: number; itemCount: number; roundTotal: number; time: string;
  destinations: string[]; createdAt: number; isDuplicate: boolean;
  items: HodOrderItem[];
}>> {
  const q = query(
    collection(db, "posKOTs"),
    orderBy("createdAt", "desc"),
    limit(maxRows),
  );
  const snap = await getDocs(q);
  const rows: Array<{
    id: string; tableId: string; customerName?: string; staff: string;
    roundNum: number; itemCount: number; roundTotal: number; time: string;
    destinations: string[]; createdAt: number; isDuplicate: boolean;
    items: HodOrderItem[];
  }> = [];
  snap.forEach((d) => {
    const data = d.data() as Record<string, unknown>;
    if (data.kind === "bill") return; // bills come through getRecentBillPrints
    const rawItems = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
    const items: HodOrderItem[] = rawItems.map((it) => ({
      n: String(it.n ?? it.name ?? ""),
      p: Number(it.p ?? it.price) || 0,
      qty: Number(it.qty) || 0,
      t: (it.t === "food" ? "food" : it.t === "drink" ? "drink" : undefined),
      v: it.v === true ? true : undefined,
      alc: it.alc === true ? true : it.alc === false ? false : undefined,
    }));
    const itemCount = items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
    const ts = data.createdAt as { toMillis?: () => number } | undefined;
    rows.push({
      id: d.id,
      tableId: String(data.tableId || ""),
      customerName: data.customerName ? String(data.customerName) : undefined,
      staff: String(data.staff || ""),
      roundNum: Number(data.roundNum) || 0,
      itemCount,
      roundTotal: Number(data.roundTotal) || 0,
      time: String(data.time || ""),
      destinations: Array.isArray(data.destinations) ? (data.destinations as string[]) : [],
      createdAt: ts?.toMillis ? ts.toMillis() : 0,
      isDuplicate: Boolean(data.isDuplicate),
      items,
    });
  });
  return rows;
}

export async function setReservationAggregator(
  docId: string, aggregator: string, discountPercent: number,
  opts?: { managerOverride?: boolean; staffName?: string; reason?: string }
): Promise<void> {
  const snap = await getDoc(doc(db, TABLE_RES_COL, docId));
  if (!snap.exists()) throw new Error("Reservation not found");
  const data = snap.data();
  if (isTableBillSettled(data)) throw new Error("Cannot change source on a settled table");
  // L1/L7: once a bill has been printed the source/discount is locked. Caller must
  // pass `managerOverride: true` (UI requires Manager PIN) to change it.
  if ((data.billPrintCount || 0) > 0 && !opts?.managerOverride) {
    throw new Error("Bill already printed — Manager PIN required to change source.");
  }
  const fromSource = data.aggregator || "inhouse";
  const fromDiscount = data.aggregatorDiscount || 0;
  const sourceChanged = fromSource !== aggregator;
  const discountChanged = fromDiscount !== discountPercent;
  const upd: Record<string, unknown> = {
    aggregator, aggregatorDiscount: discountPercent,
    source: aggregator === "inhouse" ? "inhouse" : aggregator,
  };
  // Mark as captain-modified ONLY when the discount actually changed via this
  // captain-driven path. Booking creation (website/admin.html) does NOT call
  // setAggregatorAndDiscount, so legacy/un-arrived bookings stay clean.
  if (discountChanged) upd.discountModifiedByCaptain = true;
  // L-A4 + audit: log EVERY source/discount change so the Live Monitor sees
  // pre-bill swaps too (not just post-bill ones). Pre-bill entries get
  // afterBillCount=0; post-bill entries also flip billStale=true.
  if (sourceChanged || discountChanged) {
    const log = Array.isArray(data.sourceOverrideLog) ? [...data.sourceOverrideLog] : [];
    log.push({
      at: new Date().toISOString(),
      by: opts?.staffName || "unknown",
      from: fromSource,
      fromDiscount,
      to: aggregator,
      toDiscount: discountPercent,
      afterBillCount: data.billPrintCount || 0,
      managerApproved: !!opts?.managerOverride,
      reason: opts?.reason || "",
    });
    upd.sourceOverrideLog = log;
    if ((data.billPrintCount || 0) > 0 && opts?.managerOverride) {
      upd.billStale = true;  // force a reprint after a manager-approved post-bill swap
    }
  }
  await updateDoc(doc(db, TABLE_RES_COL, docId), upd);
}

/**
 * Audit helper — gathers every bill-print event across wallets + table reservations,
 * flattens the per-doc logs, sorts newest-first. Used by /audit page so the owner
 * can see exactly when, by whom, for how much, and whether each chit was a duplicate.
 */
export interface BillAuditRow {
  at: string;            // ISO timestamp
  source: "wallet" | "table";
  docId: string;         // cover.id or tableReservation.id
  ref: string;           // human-friendly: cover.ref or tableId
  customerName: string;
  by: string;            // staffName who printed
  total: number;
  itemCount: number;
  isDuplicate: boolean;
  billNumber: string;
  printIndex: number;    // 1 = original, 2+ = reprint
  // 🆕 2026-06-16 v3.302 — item lines + persisted tax breakdown so the Audit
  // page can show the FULL bill (items + GST/SC/discount) when a row is tapped.
  // Items are the cumulative running tab (all tabRounds flattened), matching
  // the printed chit. Tax fields come from the bill log (0 for pre-v3.224 rows).
  items: HodOrderItem[];
  subtotal: number;
  discount: number;
  serviceCharge: number;
  tax: number;
}
/** Flatten every round's items into ONE merged line list (qty-summed by
 *  name+price) — mirrors the cumulative running-tab a printed bill shows. */
function flattenRoundItems(rounds?: HodTabRound[]): HodOrderItem[] {
  if (!Array.isArray(rounds) || rounds.length === 0) return [];
  const byKey = new Map<string, HodOrderItem>();
  for (const rd of rounds) {
    for (const it of (Array.isArray(rd.items) ? rd.items : [])) {
      const key = `${it.n}|${it.p}|${it.t || ""}|${it.alc ?? ""}`;
      const ex = byKey.get(key);
      if (ex) ex.qty += Number(it.qty) || 0;
      else byKey.set(key, { ...it, qty: Number(it.qty) || 0 });
    }
  }
  return Array.from(byKey.values());
}
export async function getRecentBillPrints(maxRows = 200): Promise<BillAuditRow[]> {
  const rows: BillAuditRow[] = [];
  // Wallets — 💰 COST FIX 2026-05-21: cap at 500 covers (was: full collection scan
  // growing unbounded). No orderBy because not every cover doc has a guaranteed
  // 'createdAt' field — adding it would fail the query. limit(500) alone returns
  // Firestore's natural order which is close-enough for an audit page that's
  // already paginated by `maxRows` below.
  const coverSnap = await getDocs(query(collection(db, COVERS_COL), limit(500)));
  coverSnap.forEach((d) => {
    const data = d.data() as HodCover & { id?: string };
    const log = data.walletBillPrintLog;
    if (!Array.isArray(log) || log.length === 0) return;
    const items = flattenRoundItems(data.tabRounds);
    log.forEach((e, i) => {
      rows.push({
        at: e.at, source: "wallet", docId: d.id,
        ref: (data.ref || d.id).toUpperCase(), customerName: data.name || "",
        by: e.by, total: e.total, itemCount: e.itemCount,
        isDuplicate: e.isDuplicate, billNumber: e.billNumber, printIndex: i + 1,
        items, subtotal: e.subtotal ?? 0, discount: e.discount ?? 0,
        serviceCharge: e.serviceCharge ?? 0, tax: e.tax ?? 0,
      });
    });
  });
  // Table reservations
  const tableSnap = await getDocs(collection(db, TABLE_RES_COL));
  tableSnap.forEach((d) => {
    const data = d.data() as HodTableReservation;
    const log = data.billPrintLog;
    if (!Array.isArray(log) || log.length === 0) return;
    const items = flattenRoundItems(data.tabRounds);
    log.forEach((e: typeof log[number] & { itemCount?: number; subtotal?: number; discount?: number; serviceCharge?: number; tax?: number }, i) => {
      rows.push({
        at: e.at, source: "table", docId: d.id,
        ref: (data.tableId || d.id).toUpperCase(), customerName: data.customerName || "",
        by: e.by, total: e.total, itemCount: e.itemCount ?? 0,
        isDuplicate: e.isDuplicate, billNumber: e.billNumber, printIndex: i + 1,
        items, subtotal: e.subtotal ?? 0, discount: e.discount ?? 0,
        serviceCharge: e.serviceCharge ?? 0, tax: e.tax ?? 0,
      });
    });
  });
  rows.sort((a, b) => (b.at > a.at ? 1 : -1));
  return rows.slice(0, maxRows);
}

/**
 * Bar-Mode mirror of `recordBillPrint` — atomically bumps the wallet's bill-print
 * count, appends a log entry, and stamps timestamps. Returns the new count so the
 * caller can build the BILL-N suffix and isDuplicate flag for the chit.
 */
/**
 * V4 2026-05-11 — bartender screenshot collection at 60-sec fail-open.
 * Customer paid online via Razorpay, but the verify/webhook tick never
 * landed within our 60-sec window. Bartender visually confirms the
 * payment on the customer's phone (UPI app shows ✅ + ref ID + amount)
 * and records the proof here. Khushi reconciles next morning against
 * the Razorpay dashboard:
 *   - If the payment IS in Razorpay (just slow webhook) → already
 *     auto-credited by the webhook backstop. Nothing to do.
 *   - If the payment is NOT in Razorpay (true PSP/bank-side failure,
 *     extremely rare) → either manually credit via Firestore Console
 *     using the screenshot proof, OR ask the customer to dispute with
 *     their bank for a refund.
 *
 * Stores under cover.pendingScreenshots[] (append-only) so multiple
 * pending-tick events on the same wallet across the night are all
 * preserved for audit. NEVER blocks legitimate revenue ops — failure
 * here just surfaces a toast (fail-open philosophy).
 */
export async function recordPendingPaymentScreenshot(
  coverId: string,
  entry: {
    by: string;
    paymentId: string;
    expectedAmount: number;
    upiRef: string;
    customerPhoneSeen: string;
    note: string;
  }
): Promise<void> {
  const ref = doc(db, COVERS_COL, coverId);
  await runTransaction(db, async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists()) throw new Error("Wallet not found");
    const data = snap.data();
    const log = Array.isArray(data.pendingScreenshots) ? [...data.pendingScreenshots] : [];
    log.push({
      at: new Date().toISOString(),
      by: entry.by,
      paymentId: entry.paymentId,
      expectedAmount: entry.expectedAmount,
      upiRef: entry.upiRef.trim(),
      customerPhoneSeen: entry.customerPhoneSeen.trim(),
      note: entry.note.trim(),
      resolved: false,
    });
    txn.update(ref, { pendingScreenshots: log });
  });
}

// ⚡ 2026-06-25 (Khushi — "PRINT KOT+BILL is 15-30s slow, used to be instant")
// ROOT CAUSE: the bill chit was gated behind recordWalletBillPrint /
// recordBillPrint — Firestore TRANSACTIONS that REQUIRE a live server
// round-trip (they read-modify-write, so they cannot resolve from the offline
// cache). On stalled venue wifi / Android WebView each crawls to its 15s
// timeout; the bar's combined KOT+BILL runs the money debit AND this
// bookkeeping txn back-to-back → the 15s (one slow) / 30s (both slow) delay.
// FIX: the bill NUMBER + audit log are pure bookkeeping (NOT money), so the
// call sites derive the number optimistically from live state, print the chit
// IMMEDIATELY, and persist the canonical record through this best-effort
// background runner (a few spaced retries so the audit row still lands).
// Fail-open: a permanently-failed write loses ONE audit row, never the print.
export function runBillBookkeepingBg(fn: () => Promise<unknown>, attempts = 4): void {
  let n = 0;
  const go = () => {
    fn().catch((e) => {
      n += 1;
      if (n < attempts) setTimeout(go, 1500 * n);
      else console.warn("[bill-bookkeeping] background write gave up", e);
    });
  };
  go();
}

export async function recordWalletBillPrint(
  coverId: string,
  entry: { by: string; total: number; itemCount: number; billNumberBase: string;
    /** 2026-05-15 (Khushi UX) — CASH & CARRY AWARENESS. When the caller knows
     *  a NEW round was activated since the last bill print (round-by-round
     *  bar service), pass `hasNewRoundSinceLastBill:true` so this print is
     *  recorded as a fresh bill, NOT a duplicate. Default false → legacy
     *  behavior (any 2nd+ print = duplicate). */
    hasNewRoundSinceLastBill?: boolean;
    /** 🆕 2026-06-05 — money breakdown for LIVE REPORTS (optional). */
    subtotal?: number; discount?: number; serviceCharge?: number; tax?: number;
  }
): Promise<{ count: number; isDuplicate: boolean; billNumber: string }> {
  const ref = doc(db, COVERS_COL, coverId);
  return await withTxnTimeout(runTransaction(db, async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists()) throw new Error("Wallet not found");
    const data = snap.data();
    const prev = (data.walletBillPrintCount as number) || 0;
    const next = prev + 1;
    // True duplicate ONLY if there's a prior bill AND no new round since.
    const isDuplicate = prev > 0 && !entry.hasNewRoundSinceLastBill;
    const billNumber = `${entry.billNumberBase}-${next}`;
    const now = new Date().toISOString();
    const log = Array.isArray(data.walletBillPrintLog) ? [...data.walletBillPrintLog] : [];
    log.push({ at: now, by: entry.by, total: entry.total,
      itemCount: entry.itemCount, isDuplicate, billNumber,
      subtotal: entry.subtotal ?? 0, discount: entry.discount ?? 0,
      serviceCharge: entry.serviceCharge ?? 0, tax: entry.tax ?? 0 });
    const upd: Record<string, unknown> = {
      walletBillPrintCount: next,
      lastWalletBillPrintedAt: now,
      walletBillPrintLog: log,
    };
    if (prev === 0) upd.walletBillFirstPrintedAt = now;
    txn.update(ref, upd);
    return { count: next, isDuplicate, billNumber };
  }));
}

/**
 * L3/L4/L5 — Atomically record a thermal-bill print event.
 *  - Bumps `billPrintCount` (used to make every reprint show DUPLICATE on the chit)
 *  - Stamps `billFirstPrintedAt` once, `lastBillPrintedAt` always
 *  - Appends to `billPrintLog` (append-only audit trail)
 *  - On the first print: snapshots source+discount into `billLockedSource/Discount`
 *  - Clears `billStale` (any added items have now been re-billed)
 * Returns the new count so the caller can build "BILL-N" suffix + isDuplicate flag.
 */
export async function recordBillPrint(
  docId: string,
  entry: { by: string; total: number; discountPct: number; aggregator: string; billNumberBase: string }
): Promise<{ count: number; isDuplicate: boolean; billNumber: string }> {
  const ref = doc(db, TABLE_RES_COL, docId);
  return await runTransaction(db, async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists()) throw new Error("Reservation not found");
    const data = snap.data();
    const prev = (data.billPrintCount as number) || 0;
    const next = prev + 1;
    const isDuplicate = prev > 0;
    const billNumber = `${entry.billNumberBase}-${next}`;
    const now = new Date().toISOString();
    const log = Array.isArray(data.billPrintLog) ? [...data.billPrintLog] : [];
    log.push({
      at: now, by: entry.by, total: entry.total, discountPct: entry.discountPct,
      aggregator: entry.aggregator, isDuplicate, billNumber,
    });
    const upd: Record<string, unknown> = {
      billPrintCount: next,
      lastBillPrintedAt: now,
      billPrintLog: log,
      billStale: false,
    };
    if (prev === 0) {
      upd.billFirstPrintedAt = now;
      upd.billLockedSource = entry.aggregator;
      upd.billLockedDiscount = entry.discountPct;
    }
    txn.update(ref, upd);
    return { count: next, isDuplicate, billNumber };
  });
}

export async function createWalkInTable(
  tableId: string, floor: string, floorLabel: string,
  customerName: string, phone: string, partySize: number, captainName: string,
  aggregator = "inhouse", aggregatorDiscount = 0,
  // 🆕 2026-05-20 (Khushi) — optional email + arrival time captured by the
  // simplified floor-plan walk-in modal. Empty/blank values fall through to
  // the existing auto-now arrivalTime so legacy callers are unaffected.
  email = "", arrivalTimeOverride = ""
): Promise<string> {
  const now = new Date();
  // 🆕 2026-06-08 (Khushi MIDNIGHT BUG) — operational night (rolls 7AM IST), NOT
  // the UTC calendar date. A live walk-in is always for the current night; UTC
  // disagrees with the operational night in the 5:30–7AM IST window and would
  // file the table under a different date than its cover + the captain view.
  const date = getOperationalNightStr();
  const arrTime = arrivalTimeOverride.trim() || now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const ref = mintHodRef("table");

  // Check for a TIME-SLOT conflict, not merely any same-day doc.
  // A 3 PM booking on SMK4 must not block an 11 PM walk-in.
  // Window: [arrTime − 30 min, arrTime + 120 min] — same as CaptainMode occupancy.
  const _parseMin = (t?: string): number | null => {
    if (!t) return null;
    const m = String(t).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
    if (!m) return null;
    let h = parseInt(m[1], 10); const mm = parseInt(m[2], 10);
    const ap = m[3]?.toUpperCase();
    if (ap === "PM" && h < 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    return h * 60 + mm;
  };
  const _LEAD = 30; const _SLOT = 120;
  const newMin = _parseMin(arrTime);
  const q2 = query(collection(db, TABLE_RES_COL), where("tableId", "==", tableId), where("date", "==", date));
  const existing = await getDocs(q2);
  for (const snap of existing.docs) {
    const d2 = snap.data();
    if (isTableBillSettled(d2)) continue;
    if (d2.isGroupHold) continue;
    const exMin = _parseMin(d2.arrivalTime as string | undefined);
    if (exMin === null || newMin === null) {
      throw new Error(`Table ${tableId} is already occupied today`);
    }
    const exWinStart = exMin - _LEAD; const exWinEnd = exMin + _SLOT;
    const nwWinStart = newMin - _LEAD; const nwWinEnd = newMin + _SLOT;
    if (nwWinStart < exWinEnd && exWinStart < nwWinEnd) {
      throw new Error(`Table ${tableId} is already booked at ${d2.arrivalTime} — time slot overlaps`);
    }
  }

  // Write covers doc FIRST so if rules/network reject it, the tableReservations
  // write below never runs and the captain sees the failure instead of getting
  // a half-created booking with a permanently locked customer menu.
  // The wallet (hodclub.in) reads this to unlock the menu immediately —
  // walk-ins are by definition "arrived" with no separate "Guest Arrived" step.
  // `name` mirrors `customerName` since some wallet code paths read `name`.
  await setDoc(doc(db, COVERS_COL, ref), {
    isTableBooking: true, tableId, floor, floorLabel,
    customerName, name: customerName, phone: phone || "", partySize: partySize || 2,
    ...(email.trim() ? { email: email.trim() } : {}),
    arrivalTime: arrTime, actualArrivalTime: arrTime,
    bookingRef: ref, ref, isWalkIn: true,
    // 🔴 2026-05-22 (Khushi COST FIX) — date is REQUIRED so tonight-scoped
    // covers feed (subscribeToCoversForNight) catches this walk-in.
    date: getOperationalNightStr(),
  }, { merge: true });

  const d = doc(db, TABLE_RES_COL, ref);
  await setDoc(d, {
    tableId, floor, floorLabel, date, customerName, phone: phone || "",
    ...(email.trim() ? { email: email.trim() } : {}),
    partySize: partySize || 2, arrivalTime: arrTime, actualArrivalTime: arrTime,
    bookingRef: ref, bookedAt: now.toISOString(), source: aggregator,
    aggregator, aggregatorDiscount, tabRounds: [], tabTotal: 0,
    status: "confirmed", createdBy: captainName, isWalkIn: true,
  });
  return ref;
}

// Door-side fallback for when a Zomato/Swiggy/EazyDiner booking didn't sync into
// Firestore via webhook/Cloud Function. Door staff transcribes from the aggregator
// app/email so the booking is visible in the day's list. Supports future dates and
// unassigned tables (which is fine — the existing UI already shows a "Check
// {aggregator} app for full details" banner for aggregator rows without tableId).
// ── WhatsApp / wallet-scan logging on the covers doc ────────────────────────
// Door staff need an audit trail of which arrivals got auto-WhatsApp vs which
// fell back to the QR popup, plus the failure reason. The customer site (when
// it's updated) writes `walletOpenedAt` when ?wallet=<ref> is opened — we
// subscribe so the QR popup can auto-close the moment a guest scans.

export type NotificationOutcome =
  | { status: "sent_template"; recipient: string }
  | { status: "sent_text"; recipient: string }
  | { status: "qr_shown"; reason: string; code?: number }
  | { status: "no_phone" };

export async function logNotificationOutcome(bookingRef: string, outcome: NotificationOutcome) {
  if (!bookingRef) return;
  try {
    // 🔴 2026-05-22 (Khushi COST FIX) — read-then-write to avoid clobbering
    // a real `date` on a pre-existing covers doc. Only inject tonight's
    // night-string if the doc is brand new OR truly missing `date`.
    const ref = doc(db, COVERS_COL, bookingRef);
    const snap = await getDoc(ref).catch(() => null);
    const needsDate = !snap?.exists() || !(snap.data() as any)?.date;
    await setDoc(ref, {
      notificationStatus: outcome.status,
      notificationDetails: outcome,
      notificationAt: serverTimestamp(),
      ...(needsDate ? { date: getOperationalNightStr() } : {}),
      ...(outcome.status === "qr_shown" ? { qrShownAt: serverTimestamp() } : {}),
    }, { merge: true });
  } catch (e) {
    console.warn("[firestore-hod] logNotificationOutcome failed", e);
  }
}

// Listen for the customer scanning the QR / opening the wallet link. The
// hodclub.in site needs to write `walletOpenedAt` on the covers doc when it
// loads with ?wallet=<ref>; until that one-line addition ships, the callback
// simply never fires (no harm done — staff close the modal manually).
export function subscribeToWalletScan(bookingRef: string, cb: (openedAt: any) => void): Unsubscribe {
  const ref = doc(db, COVERS_COL, bookingRef);
  return onSnapshot(ref, (snap) => {
    const data = snap.data();
    if (data && data["walletOpenedAt"]) cb(data["walletOpenedAt"]);
  });
}

// ─── Door-side walk-in booking helpers ─────────────────────────────────────
// 2026-05-12 (Khushi spec) — door tablet creates in-house walk-in bookings
// without round-tripping through hodclub.in. Mirrors the shape the customer
// site writes so they show up in the existing tabs/tickets/guestlist UI
// (and CaptainMode/BarMode) without any decoder changes.
//
// Walk-in marker: `isWalkIn: true` + ref prefix `WI-…`. Pay-at-venue cash
// flows set `paymentMethod: "cash_door"` and `paymentId: "cash_<ref>"` so
// the existing PaidBadge renders as paid (not pending Razorpay).
type WalkInBookingKind = "cover" | "onlyentry" | "group";

export async function createWalkInTicketBooking(input: {
  kind: WalkInBookingKind;
  name: string;
  email?: string;
  phone: string;
  guests: number;
  total: number;             // ₹ collected at the door (0 = comp)
  entryFee?: number;         // non-redeemable entry portion when cover is bundled
  tier?: string;             // e.g. "Stag", "Couple", "Ladies"
  type?: string;             // mirrors customer-site `type` field
  eventId?: string;
  eventTitle?: string;
  partySize?: number;        // for group/VIP table flows
  tableType?: string;        // "VIP", "Standard" etc — group flow only
  notes?: string;
  staffName: string;
  // 2026-05-16 (Khushi) — door girl picks how the customer paid. Drives the
  // paymentMethod / paymentId / paymentSplit fields on the booking doc so
  // Reports / Live Monitor / Sheets sync attribute revenue correctly.
  // Defaults to "cash" for backward compatibility with older callers.
  paymentMethod?: "cash" | "upi" | "card" | "split" | "online" | "comp";
  paymentRef?: string;       // UPI txn ID / card auth / Razorpay paymentId
  paymentSplit?: { cash?: number; upi?: number; card?: number; online?: number };
}): Promise<{ ref: string }> {
  const { kind, name, email, phone, guests, total, entryFee, tier, type, eventId, eventTitle,
    partySize, tableType, notes, staffName, paymentMethod, paymentRef, paymentSplit } = input;
  if (!name?.trim()) throw new Error("Enter customer name");
  if (!phone?.trim()) throw new Error("Enter phone number");

  const ref = mintHodRef(kind === "group" ? "group" : "entryonly");
  const date = getOperationalNightStr();
  const cleanPhone = phone.replace(/\D/g, "").slice(-10);

  // entryType discriminator — mirrors hodclub.in conventions so the existing
  // tab predicates (`isOnlyEntryBooking`, `isGroupBooking`, etc.) classify
  // these correctly. Canonical "entryonly" (no underscore) matches the value
  // hodclub.in writes from its booking payload — see the comment on
  // `isOnlyEntryBooking` in `DoorMode.tsx` for the source-of-truth reference.
  let entryType: string | undefined;
  if (kind === "onlyentry") entryType = "entryonly";
  else if (kind === "group") entryType = "group_booking";
  // cover flow leaves entryType undefined (goes to the Tickets tab).

  // 2026-05-16 — payment method resolution. If caller passes paymentMethod
  // explicitly we honor it; else fall back to legacy cash_door / comp_door
  // behavior so older callers (existing tests, aggregator-arrival flows)
  // keep working unchanged.
  const pm = paymentMethod || (total > 0 ? "cash" : "comp");
  const pmField =
    pm === "cash"   ? "cash_door"  :
    pm === "upi"    ? "upi_door"   :
    pm === "card"   ? "card_door"  :
    pm === "split"  ? "split_door" :
    pm === "online" ? "online_door" :
    "comp_door";
  const pidField = paymentRef
    ? `${pm}_${paymentRef}`
    : (total > 0 ? `${pm}_${ref}` : `comp_${ref}`);

  const docPayload: Record<string, any> = {
    ref,
    name: name.trim(),
    email: (email || "").trim(),
    phone: cleanPhone,
    guests: guests || 1,
    total: Math.max(0, Math.round(total || 0)),
    date,
    tier: tier || "",
    type: type || "",
    eventId: eventId || "",
    eventTitle: eventTitle || "",
    paymentMethod: pmField,
    paymentId: pidField,
    paymentRef: paymentRef || "",
    paidAt: new Date().toISOString(),
    bookedAt: new Date().toISOString(),
    createdAt: serverTimestamp(),
    isWalkIn: true,
    walkInBy: staffName,
    source: "walkin",
    notes: notes || "",
    status: "confirmed",
  };
  if (paymentSplit && pm === "split") {
    docPayload.paymentSplit = {
      cash:   Math.max(0, Math.round(paymentSplit.cash   || 0)),
      upi:    Math.max(0, Math.round(paymentSplit.upi    || 0)),
      card:   Math.max(0, Math.round(paymentSplit.card   || 0)),
      online: Math.max(0, Math.round(paymentSplit.online || 0)),
    };
  }
  if (entryType) docPayload.entryType = entryType;
  if (entryFee && entryFee > 0) docPayload.entryFee = Math.round(entryFee);
  if (kind === "group") {
    docPayload.bookMode = "group";
    if (tableType) docPayload.tableType = tableType;
    if (partySize) docPayload.partySize = partySize;
  }

  await setDoc(doc(db, BOOKINGS_COL, ref), docPayload);
  return { ref };
}

export async function createWalkInGuestlistEntry(input: {
  name: string;
  email?: string;
  phone: string;
  eventId?: string;
  eventTitle?: string;
  type?: string;            // "stag" | "couple" | "ladies" — mirrors hodclub.in
  staffName: string;
}): Promise<{ ref: string }> {
  const { name, email, phone, eventId, eventTitle, type, staffName } = input;
  if (!name?.trim()) throw new Error("Enter guest name");
  if (!phone?.trim()) throw new Error("Enter phone number");

  const ref = mintHodRef("guestlist");
  const cleanPhone = phone.replace(/\D/g, "").slice(-10);
  const entryType = type ? `guestlist_${type}` : "guestlist_stag";

  await setDoc(doc(db, GUESTLIST_COL, ref), {
    ref,
    name: name.trim(),
    email: (email || "").trim(),
    phone: cleanPhone,
    eventId: eventId || "",
    eventTitle: eventTitle || "",
    type: type || "stag",
    entryType,
    joinedAt: new Date().toISOString(),
    // 🔴 2026-05-23 (Khushi COST FIX r2) — operational-night stamp so the
    // tonight-scoped Door view can find this entry even if a future query
    // switches to date-equality instead of joinedAt range.
    date: getOperationalNightStr(),
    createdAt: serverTimestamp(),
    isWalkIn: true,
    walkInBy: staffName,
    source: "walkin",
  });
  return { ref };
}

// 🔴 2026-05-19 (Khushi LIVE-NIGHT) — shared amenity row shape used by all 3
// booking creators (in-house, aggregator, corporate). `price` is per unit in
// INR; `qty` defaults to 1. Door staff can tick from a default catalog or
// type a custom row. Totals roll up into `amenitiesTotal` for Reports.
export interface BookingAmenity {
  name: string;
  price: number;
  qty: number;
}
function sumAmenities(items?: BookingAmenity[]): number {
  if (!items || !items.length) return 0;
  return items.reduce((s, a) => s + (Number(a.price) || 0) * (Number(a.qty) || 1), 0);
}

// 🔴 2026-05-19 — shared time-window conflict check used by all 3 creators.
// Matches the UI's `doorTableOccupantAt` logic in DoorMode.tsx so the green/red
// picker can't disagree with the write-time gate. Returns the conflicting
// reservation if the slot collides, else null. A table frees ONLY when RELEASED
// (its reservation doc is deleted), not when the bill is paid/settled.
// Reservations with no parseable arrivalTime are conservatively treated as
// blocking (matches old date-only behaviour).
const SLOT_MIN_DEFAULT = 120;
const SLOT_LEAD_IN_DEFAULT = 30;
function parseClock(t?: string): number | null {
  if (!t) return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(h) || Number.isNaN(mm)) return null;
  const ampm = m[3]?.toUpperCase();
  if (ampm === "PM" && h < 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return h * 60 + mm;
}
async function findTableSlotConflict(
  tableId: string, date: string, arrivalTime?: string
): Promise<{ customerName?: string; arrivalTime?: string } | null> {
  const q2 = query(collection(db, TABLE_RES_COL),
    where("tableId", "==", tableId), where("date", "==", date));
  const snap = await getDocs(q2);
  if (snap.empty) return null;
  const target = parseClock(arrivalTime);
  for (const d of snap.docs) {
    const r = d.data() as any;
    // A table frees ONLY when RELEASED (its doc is deleted), not when the bill is
    // paid/settled — so a settled-but-seated guest must still block a new booking
    // here, exactly as the door picker now shows it occupied. (No settled-skip.)
    // 🔴 2026-06-08 (Khushi) — ACTIVE occupancy ignores the scheduled-time window
    // (parity with doorTableOccupantAt): a guest who has ARRIVED or has a running
    // tab is seated NOW and holds the table until RELEASE regardless of the booked
    // arrivalTime (e.g. FD2 booked 20:30 but arrived early at 17:53 with an open
    // tab must still block a 17:55 booking).
    const seatedNow = !!r.actualArrivalTime || (Array.isArray(r.tabRounds) && r.tabRounds.length > 0);
    if (seatedNow) {
      return { customerName: r.customerName, arrivalTime: r.arrivalTime };
    }
    const start = parseClock(r.arrivalTime);
    if (start == null || target == null) {
      // Unknown time on either side → fall back to old date-only blocking.
      return { customerName: r.customerName, arrivalTime: r.arrivalTime };
    }
    const winStart = start - SLOT_LEAD_IN_DEFAULT;
    const winEnd   = start + SLOT_MIN_DEFAULT;
    if (target >= winStart && target <= winEnd) {
      return { customerName: r.customerName, arrivalTime: r.arrivalTime };
    }
  }
  return null;
}

// 🆕 2026-06-14 — POST-WRITE double-booking reconcile helper (audit finding #6).
// Like findTableSlotConflict but (a) skips our OWN just-written doc and (b) only
// reports a conflict created BEFORE us (earlier bookedAt; ref-string tiebreak on
// an exact tie) — i.e. the booking that legitimately won a same-second race.
async function findEarlierTableConflict(
  tableId: string, date: string, arrivalTime: string | undefined,
  selfRef: string, selfBookedAt: string,
): Promise<{ customerName?: string; arrivalTime?: string } | null> {
  const q2 = query(collection(db, TABLE_RES_COL),
    where("tableId", "==", tableId), where("date", "==", date));
  const snap = await getDocs(q2);
  if (snap.empty) return null;
  const target = parseClock(arrivalTime);
  const selfT = Date.parse(selfBookedAt) || 0;
  for (const d of snap.docs) {
    if (d.id === selfRef) continue; // never conflict with ourselves
    const r = d.data() as any;
    // Deterministic first-writer-wins: the other doc beats us only if it was
    // created earlier (or the same instant but a lower ref id breaks the tie).
    const otherT = Date.parse(r.bookedAt || "") || 0;
    const otherWins = otherT > 0 && (otherT < selfT || (otherT === selfT && String(d.id) < String(selfRef)));
    if (!otherWins) continue;
    const seatedNow = !!r.actualArrivalTime || (Array.isArray(r.tabRounds) && r.tabRounds.length > 0);
    if (seatedNow) return { customerName: r.customerName, arrivalTime: r.arrivalTime };
    const start = parseClock(r.arrivalTime);
    if (start == null || target == null) return { customerName: r.customerName, arrivalTime: r.arrivalTime };
    const winStart = start - SLOT_LEAD_IN_DEFAULT;
    const winEnd = start + SLOT_MIN_DEFAULT;
    if (target >= winStart && target <= winEnd) return { customerName: r.customerName, arrivalTime: r.arrivalTime };
  }
  return null;
}

export async function createAggregatorTableBooking(input: {
  aggregator: string;          // "zomato" | "swiggy-dineout" | "swiggy-scenes" | "eazydiner"
  discountPercent?: number;    // override aggregator default if door staff agrees a different %
  customerName: string;
  phone: string;
  email?: string;
  partySize: number;
  date: string;                // YYYY-MM-DD
  arrivalTime: string;         // "HH:MM" or e.g. "10:30 PM"
  tableId?: string;            // optional — leave blank if not yet assigned
  floor?: string;
  floorLabel?: string;
  externalRef?: string;        // e.g. Zomato booking ID, if known
  notes?: string;
  amenities?: BookingAmenity[];
  amenitiesPaymentMode?: string;
  staffName: string;
  /** When true (same-day, arriving now): stamp actualArrivalTime + write the cover doc
   *  so the customer menu unlocks immediately — same as createWalkInTableReservation. */
  markArrived?: boolean;
  unlockMenu?: boolean;
}): Promise<string> {
  const { aggregator, discountPercent, customerName, phone, email, partySize, date, arrivalTime,
    tableId, floor, floorLabel, externalRef, notes, amenities, amenitiesPaymentMode, staffName,
    markArrived, unlockMenu } = input;
  if (!aggregator || aggregator === "inhouse") throw new Error("Pick an aggregator");
  if (!customerName?.trim()) throw new Error("Enter customer name");
  if (!date) throw new Error("Pick a date");

  // If a table was assigned, ensure it's free for that date + slot.
  if (tableId) {
    const conflict = await findTableSlotConflict(tableId, date, arrivalTime);
    if (conflict) throw new Error(`Table ${tableId} is already booked on ${date}${conflict.arrivalTime ? " @ " + conflict.arrivalTime : ""}${conflict.customerName ? " (" + conflict.customerName + ")" : ""}`);
  }

  // 🆕 2026-06-02 v3.182 (Khushi) — short, readable aggregator refs.
  // Was: "SWIGGY-MAN-MPWM43UA" (19 chars, ugly). Now: "HOD<AGG3><6 digits>"
  // — e.g. "HODSWI234156" — matching the HOD<CAT><6digits> family produced by
  // mintHodRef (HODTAB…/HODGRP…). The first 3 letters of the aggregator name
  // encode the source (SWIGGY→SWI, ZOMATO→ZOM, EAZYDINER→EAZ, MAGICPIN→MAG,
  // DINEOUT→DIN). The customer site's table/aggregator detection was widened to
  // recognise this HOD-prefixed form (it still accepts the legacy "-MAN-" /
  // "SWIGGY-…" refs already live in Firestore).
  const aggShort = aggregator.split("-")[0].toUpperCase();
  const agg3 = aggShort.slice(0, 3);
  const aggDiscount = (discountPercent !== undefined && discountPercent >= 0)
    ? discountPercent
    : getAggregatorDiscount(aggregator);

  // The ref IS the Firestore doc id, so a 6-digit-random collision would
  // otherwise silently OVERWRITE an existing booking. Allocate ATOMICALLY:
  // inside a transaction, probe candidate ids (reads-before-write) and only
  // set the first one that doesn't exist. Firestore auto-retries the whole
  // transaction on write contention, so two staff who pick the same candidate
  // in the same instant can never clobber each other. Fail closed (throw) if
  // every attempt collides — never overwrite (the old timestamp ref couldn't
  // collide; the new short readable ref needs this guard).
  let ref = "";
  await runTransaction(db, async (txn) => {
    let candidate = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const c = `HOD${agg3}${Math.floor(100000 + Math.random() * 900000)}`;
      const snap = await txn.get(doc(db, TABLE_RES_COL, c));
      if (!snap.exists()) { candidate = c; break; }
    }
    if (!candidate) throw new Error("Could not generate a unique booking reference — please try again");
    txn.set(doc(db, TABLE_RES_COL, candidate), {
      tableId: tableId || "",
      floor: floor || "",
      floorLabel: floorLabel || "",
      date,
      customerName: customerName.trim(),
      phone: (phone || "").replace(/\D/g, "").slice(-10),
      partySize: partySize || 2,
      arrivalTime,
      bookingRef: candidate,
      bookedAt: new Date().toISOString(),
      source: aggregator,
      aggregator,
      aggregatorDiscount: aggDiscount,
      externalRef: externalRef || "",
      notes: notes || "",
      email: (email || "").trim(),
      amenities: amenities || [],
      amenitiesTotal: sumAmenities(amenities),
      ...(amenitiesPaymentMode ? { amenitiesPaymentMode } : {}),
      tabRounds: [],
      tabTotal: 0,
      status: "confirmed",
      createdBy: staffName,
      isManualAggregatorEntry: true,
    });
    ref = candidate;
  });
  return ref;
}

// 🔴 2026-05-19 (Khushi LIVE-NIGHT) — door staff walk-in TABLE booking.
// In-house (non-aggregator) reservation written straight to tableReservations.
// Mirrors createAggregatorTableBooking shape but with source="inhouse" and
// no aggregator discount. Validates that the chosen table is free for `date`.
export async function createWalkInTableReservation(input: {
  customerName: string;
  phone: string;
  email?: string;
  partySize: number;
  date: string;                // YYYY-MM-DD
  arrivalTime: string;         // "HH:MM" or "10:30 PM"
  tableId?: string;            // optional — leave blank if not yet assigned
  floor?: string;
  floorLabel?: string;
  notes?: string;
  amenities?: BookingAmenity[];
  amenitiesPaymentMode?: string;
  staffName: string;
  // 🔴 2026-05-20 (Khushi) — COVER+TABLE flow. Marks that this reservation
  // is paired with a cover/wallet so captain UI shows "wallet available" hint.
  // Linked cover ref is patched in via linkCoverToTable() after activation.
  hasLinkedCover?: boolean;
  // 🆕 2026-06-02 v3.172 (Khushi WAITLIST) — seating a guest straight off the
  // waitlist must replicate a normal walk-in seating in ONE tap (the door girl
  // can't do the separate "menu unlock" + "guest arrived" steps for waitlist —
  // too time-consuming). Both default false → all existing callers unaffected.
  //   • markArrived → stamps arrival on the reservation so it shows CHECKED-IN
  //     in the TABLES tab (same fields markGuestArrived writes).
  //   • unlockMenu  → ALSO writes the table-cover doc (isTableBooking +
  //     actualArrivalTime) so the customer's wallet/menu opens immediately,
  //     exactly like createWalkInTable does.
  markArrived?: boolean;
  unlockMenu?: boolean;
}): Promise<string> {
  const { customerName, phone, email, partySize, date, arrivalTime,
    tableId, floor, floorLabel, notes, amenities, amenitiesPaymentMode, staffName, hasLinkedCover,
    markArrived, unlockMenu } = input;
  if (!customerName?.trim()) throw new Error("Enter customer name");
  if (!date) throw new Error("Pick a date");
  if (!arrivalTime?.trim()) throw new Error("Enter arrival time");

  // 🆕 2026-06-08 (Khushi MIDNIGHT BUG) — a guest seated just after midnight got
  // a TABLE dated with the IST CALENDAR date (e.g. June 9) while the cover/wallet
  // (line below) + the captain's view both use getOperationalNightStr() (the
  // operational night that rolls at 7AM = still June 8). Result: the captain saw
  // 0 pending and never served the order. FIX: for a LIVE SEATING happening NOW
  // whose passed date is TODAY's IST calendar date, normalize to the operational
  // night so table.date === cover.date === captain view.
  //   A live seating is identified by one of markArrived / unlockMenu /
  //   hasLinkedCover (guest is arriving / menu opening / a cover is paired now).
  // We do NOT normalize a pure ADVANCE reservation: it carries none of those
  // flags, so a booking made between 00:00–06:59 IST FOR that same calendar
  // evening keeps its real date instead of being pushed onto the prior night.
  const _calTodayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const _isLiveSeating = !!(markArrived || unlockMenu || hasLinkedCover);
  const effDate = _isLiveSeating && date === _calTodayIST ? getOperationalNightStr() : date;

  if (tableId) {
    const conflict = await findTableSlotConflict(tableId, effDate, arrivalTime);
    if (conflict) throw new Error(`Table ${tableId} is already booked on ${effDate}${conflict.arrivalTime ? " @ " + conflict.arrivalTime : ""}${conflict.customerName ? " (" + conflict.customerName + ")" : ""}`);
  }

  const ref = mintHodRef("table");
  const nowIso = new Date().toISOString();
  const phone10 = (phone || "").replace(/\D/g, "").slice(-10);

  // 🆕 v3.172 — MENU UNLOCK. Write the table-cover doc FIRST (mirrors
  // createWalkInTable): if rules/network reject it we never end up with a
  // booking whose customer menu is permanently locked. The wallet (hodclub.in)
  // reads this covers doc to open the menu immediately. `date` uses the
  // operational-night string so the tonight-scoped covers feed catches it.
  if (unlockMenu) {
    await setDoc(doc(db, COVERS_COL, ref), {
      isTableBooking: true,
      tableId: tableId || "",
      floor: floor || "",
      floorLabel: floorLabel || "",
      customerName: customerName.trim(),
      name: customerName.trim(),
      phone: phone10,
      partySize: partySize || 2,
      ...((email || "").trim() ? { email: (email || "").trim() } : {}),
      arrivalTime,
      actualArrivalTime: arrivalTime,
      bookingRef: ref,
      ref,
      isWalkIn: true,
      date: getOperationalNightStr(),
    }, { merge: true });
  }

  await setDoc(doc(db, TABLE_RES_COL, ref), {
    tableId: tableId || "",
    floor: floor || "",
    floorLabel: floorLabel || "",
    date: effDate,
    customerName: customerName.trim(),
    phone: phone10,
    partySize: partySize || 2,
    arrivalTime,
    bookingRef: ref,
    bookedAt: nowIso,
    source: "inhouse",
    notes: notes || "",
    email: (email || "").trim(),
    amenities: amenities || [],
    amenitiesTotal: sumAmenities(amenities),
    ...(amenitiesPaymentMode ? { amenitiesPaymentMode } : {}),
    tabRounds: [],
    tabTotal: 0,
    status: "confirmed",
    createdBy: staffName,
    isWalkIn: true,
    walkInBy: staffName,
    // 🆕 v3.172 — CHECK-IN. Stamp arrival so the reservation shows as arrived
    // in the TABLES tab without a separate "Guest Arrived" tap.
    ...(markArrived ? { actualArrivalTime: arrivalTime, arrivalProcessedAt: nowIso, arrivedBy: staffName } : {}),
    // unlockMenu means the cover already exists (not pending) → flag it linked.
    ...(unlockMenu ? { hasLinkedCover: true } : {}),
    ...(hasLinkedCover ? { hasLinkedCover: true, linkedCoverPending: true } : {}),
  });

  // 🆕 2026-06-14 — DOUBLE-BOOKING RECONCILE (audit finding #6). The pre-write
  // findTableSlotConflict is read-before-write, so two tablets can both pass it
  // and seat the SAME table in the same second. The client SDK can't query
  // inside a transaction, so we reconcile AFTER the write: if another booking
  // for this table+slot was created BEFORE ours, we lost the race — remove our
  // just-written docs and ask the hostess to re-pick. FAIL-OPEN: we only throw
  // when our rollback actually succeeded; any other error keeps our booking so
  // the guest is never stranded at the door.
  if (tableId) {
    try {
      const winner = await findEarlierTableConflict(tableId, effDate, arrivalTime, ref, nowIso);
      if (winner) {
        let rolledBack = true;
        try { await deleteDoc(doc(db, TABLE_RES_COL, ref)); } catch { rolledBack = false; }
        // Only remove the cover/menu-unlock doc if the reservation delete itself
        // succeeded — otherwise we'd strip the cover off a booking we're KEEPING
        // (true fail-open consistency: keep both docs together, or neither).
        if (rolledBack && unlockMenu) { try { await deleteDoc(doc(db, COVERS_COL, ref)); } catch {} }
        if (rolledBack) {
          throw new Error(`Table ${tableId} was just taken${winner.customerName ? " by " + winner.customerName : ""}${winner.arrivalTime ? " @ " + winner.arrivalTime : ""}. Please pick another table.`);
        }
        console.warn("[createWalkInTableReservation] double-book detected but rollback failed — keeping booking", ref);
      }
    } catch (e: any) {
      if (/just taken/i.test(String((e as any)?.message || ""))) throw e;
      console.warn("[createWalkInTableReservation] reconcile error (fail-open)", e);
    }
  }
  return ref;
}

// ════════════════════════════════════════════════════════════════════════
// 🧠 2026-05-31 v3.146 — AI AGGREGATOR "NEEDS REVIEW" TRAY
// Anything the email/SMS parser + AI brain could not confidently read is written
// (server-side, by Cloud Functions) to `unparsedBookings`. The POS surfaces these
// so staff can one-tap add them to tableReservations — nothing is ever lost.
// All fns here are FAIL-OPEN (subscribe error → cb([])).
// ════════════════════════════════════════════════════════════════════════
const UNPARSED_BOOKINGS_COL = "unparsedBookings";

export interface HodUnparsedBooking {
  id: string;
  channel?: "email" | "sms";
  reason?: "ai_unavailable" | "low_confidence" | string;
  status?: "pending" | "resolved" | "dismissed";
  source?: string;            // detected aggregator or "unknown"
  guessGuestName?: string;
  guessGuestPhone?: string;
  guessPartySize?: number;
  guessBookingDate?: string;  // YYYY-MM-DD
  guessArrivalTime?: string;
  aiConfidence?: number | null;
  rawFrom?: string;
  rawSubject?: string;
  rawBody?: string;
  rawMessageId?: string;
  createdAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  tableReservationId?: string;
}

// Live tray feed — only items still awaiting a human decision.
export function subscribeToUnparsedBookings(
  cb: (items: HodUnparsedBooking[]) => void,
): Unsubscribe {
  return _shareSubscription<HodUnparsedBooking[]>(
    "unparsedBookings:pending",
    (push) =>
      onSnapshot(
        query(collection(db, UNPARSED_BOOKINGS_COL), where("status", "==", "pending")),
        (snap) => {
          const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as HodUnparsedBooking));
          // Newest first (createdAt is an ISO string).
          rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
          push(rows);
        },
        () => push([]),
      ),
    cb,
  );
}

// One-tap convert a flagged item into a real tableReservation, then mark the
// unparsed doc resolved (it drops out of the pending tray). Mirrors the walk-in
// write so the booking behaves identically to a manually-added one.
export async function resolveUnparsedBooking(
  item: HodUnparsedBooking,
  edits: {
    customerName: string;
    phone: string;
    partySize: number;
    date: string;        // YYYY-MM-DD
    arrivalTime: string;
  },
  staffName: string,
): Promise<string> {
  const customerName = (edits.customerName || "").trim();
  const date = (edits.date || "").trim();
  const arrivalTime = (edits.arrivalTime || "").trim();
  if (!customerName) throw new Error("Enter customer name");
  if (!date) throw new Error("Pick a date");
  if (!arrivalTime) throw new Error("Enter arrival time");

  const src = (item.source && item.source !== "unknown") ? item.source : "aggregator";
  // Deterministic reservation id derived from the unparsed doc id, so a retry
  // after a partial failure overwrites the SAME reservation instead of creating
  // a duplicate. The whole thing runs in ONE transaction guarded on status ==
  // 'pending', so a double-tap / race can never create two reservations.
  const ref = `unp-${item.id}`;
  const resvRef = doc(db, TABLE_RES_COL, ref);
  const unpRef = doc(db, UNPARSED_BOOKINGS_COL, item.id);

  const finalRef = await runTransaction(db, async (txn) => {
    const unpSnap = await txn.get(unpRef);
    if (!unpSnap.exists()) throw new Error("This item no longer exists.");
    const st = (unpSnap.data() as any).status;
    if (st && st !== "pending") {
      // Already handled by someone else / an earlier tap — return the existing
      // reservation id so the UI succeeds idempotently (no duplicate).
      const existing = (unpSnap.data() as any).tableReservationId;
      if (existing) return existing as string;
      throw new Error("This item was already handled.");
    }

    txn.set(resvRef, {
      tableId: "",
      floor: "",
      floorLabel: "",
      date,
      customerName,
      phone: (edits.phone || "").replace(/\D/g, "").slice(-10),
      partySize: edits.partySize || 2,
      arrivalTime,
      bookingRef: ref,
      bookedAt: new Date().toISOString(),
      source: src,
      notes: `Added from Needs Review (${item.reason || "manual"})`,
      email: "",
      amenities: [],
      amenitiesTotal: 0,
      tabRounds: [],
      tabTotal: 0,
      status: "confirmed",
      createdBy: staffName,
      isWalkIn: false,
      fromUnparsed: true,
      unparsedRef: item.id,
    });
    txn.update(unpRef, {
      status: "resolved",
      resolvedAt: new Date().toISOString(),
      resolvedBy: staffName,
      tableReservationId: ref,
    });
    return ref;
  });
  return finalRef;
}

// Throw away a non-booking (promo/junk that slipped through) — leaves the tray.
export async function dismissUnparsedBooking(id: string, staffName: string): Promise<void> {
  await updateDoc(doc(db, UNPARSED_BOOKINGS_COL, id), {
    status: "dismissed",
    resolvedAt: new Date().toISOString(),
    resolvedBy: staffName,
  });
}

// 🔴 2026-05-20 (Khushi) — COVER+TABLE LINK. Patches both docs so:
//   • table reservation knows its linked wallet ref + initial balance
//   • cover doc knows which table it belongs to (so captain wallet redeem
//     can offer this wallet by table id, and bar can offer by cover ref).
// Idempotent — safe to call multiple times.
//
// Returns per-doc status. Throws iff BOTH patches fail (so the caller can
// distinguish "no link at all" — operator must retry — from a partial
// link, where one side is correct and bar/captain can still find the
// wallet by phone/ref). Caller is responsible for surfacing partial state.
export type CoverTableLinkResult = {
  tableOk: boolean;
  coverOk: boolean;
  tableError?: string;
  coverError?: string;
};
export async function linkCoverToTable(
  tableResDocId: string, coverRef: string, coverDocId: string, initialBalance: number,
  tableInfo: { tableId?: string; floorLabel?: string },
): Promise<CoverTableLinkResult> {
  await authReady;
  const now = new Date().toISOString();
  const out: CoverTableLinkResult = { tableOk: false, coverOk: false };
  // Update table reservation
  try {
    await updateDoc(doc(db, TABLE_RES_COL, tableResDocId), {
      hasLinkedCover: true,
      linkedCoverRef: coverRef,
      linkedCoverDocId: coverDocId,
      linkedCoverInitial: initialBalance,
      linkedCoverLinkedAt: now,
      linkedCoverPending: false,
    });
    out.tableOk = true;
  } catch (e: any) {
    out.tableError = String(e?.message || e);
    console.warn("[linkCoverToTable] table patch failed", e);
  }
  // Update cover doc with table back-reference
  try {
    await updateDoc(doc(db, COVERS_COL, coverDocId), {
      linkedTableRef: tableResDocId,
      linkedTableId: tableInfo.tableId || "",
      linkedFloorLabel: tableInfo.floorLabel || "",
      linkedAt: now,
      source: "walkin_door_cover_table",
    });
    out.coverOk = true;
  } catch (e: any) {
    out.coverError = String(e?.message || e);
    console.warn("[linkCoverToTable] cover patch failed", e);
  }
  if (!out.tableOk && !out.coverOk) {
    throw new Error(`Both link writes failed — table: ${out.tableError || "?"} · cover: ${out.coverError || "?"}`);
  }
  return out;
}

// 🔴 2026-05-19 (Khushi LIVE-NIGHT) — door-side CORPORATE / GROUP table booking.
// Writes to tableReservations with source="corporate" and companyName for
// reporting. Same shape as walk-in but tagged corporate so Reports can split
// in-house vs corporate revenue. Optional eventTitle for themed nights.
export async function createCorporateTableBooking(input: {
  customerName: string;
  phone: string;
  email?: string;
  companyName: string;
  partySize: number;
  date: string;                // YYYY-MM-DD
  arrivalTime: string;
  tableId?: string;
  // 🆕 2026-06-02 (Khushi) — a corporate group can hold MULTIPLE tables on the
  // same floor. When >1 table is passed, one master reservation (carrying the
  // bill/advance/pax) is created plus a lightweight HOLD doc per extra table so
  // EVERY held table shows occupied on the door + captain + floor maps.
  tableIds?: string[];
  floor?: string;
  floorLabel?: string;
  notes?: string;
  amenities?: BookingAmenity[];
  amenitiesPaymentMode?: string;
  // 🔴 2026-05-20 (Khushi) — corporate groups often pay an ADVANCE before
  // the night. Captured here, stored on the reservation, and surfaced in
  // Captain/Admin so it can be deducted from the final bill.
  advanceAmount?: number;
  advanceMode?: "cash" | "upi" | "bank-transfer" | "card" | "other" | "";
  advanceRef?: string;
  staffName: string;
}): Promise<string> {
  const { customerName, phone, email, companyName, partySize, date, arrivalTime,
    tableId, tableIds, floor, floorLabel, notes, amenities, amenitiesPaymentMode,
    advanceAmount, advanceMode, advanceRef, staffName } = input;
  if (!customerName?.trim()) throw new Error("Enter contact name");
  if (!companyName?.trim()) throw new Error("Enter company name");
  if (!date) throw new Error("Pick a date");
  if (!arrivalTime?.trim()) throw new Error("Enter arrival time");

  // 🆕 2026-06-02 (Khushi) — resolve the full set of tables to hold for this
  // group (dedup, drop blanks). Falls back to the single tableId for callers
  // that don't pass tableIds. Empty = no table (Captain assigns on arrival).
  const allTables = Array.from(new Set(
    [...(tableIds || []), ...(tableId ? [tableId] : [])]
      .map((t) => (t || "").trim())
      .filter(Boolean),
  ));

  // Conflict-check EVERY table FIRST so we never half-create a group.
  for (const tId of allTables) {
    const conflict = await findTableSlotConflict(tId, date, arrivalTime);
    if (conflict) throw new Error(`Table ${tId} is already booked on ${date}${conflict.arrivalTime ? " @ " + conflict.arrivalTime : ""}${conflict.customerName ? " (" + conflict.customerName + ")" : ""}`);
  }

  const ref = mintHodRef("group");
  const nowIso = new Date().toISOString();
  const phoneClean = (phone || "").replace(/\D/g, "").slice(-10);
  const masterTable = allTables[0] || "";

  // MASTER doc: carries the bill, advance, pax, amenities for the whole group.
  await setDoc(doc(db, TABLE_RES_COL, ref), {
    tableId: masterTable,
    tableIds: allTables,            // full list for reference / future grouping
    floor: floor || "",
    floorLabel: floorLabel || "",
    date,
    customerName: customerName.trim(),
    companyName: companyName.trim(),
    phone: phoneClean,
    partySize: partySize || 2,
    arrivalTime,
    bookingRef: ref,
    groupRef: ref,
    bookedAt: nowIso,
    source: "corporate",
    bookMode: "group",
    notes: notes || "",
    email: (email || "").trim(),
    amenities: amenities || [],
    amenitiesTotal: sumAmenities(amenities),
    ...(amenitiesPaymentMode ? { amenitiesPaymentMode } : {}),
    advanceAmount: Math.max(0, Number(advanceAmount) || 0),
    advanceMode: advanceMode || "",
    advanceRef: (advanceRef || "").trim(),
    advancePaidAt: (Number(advanceAmount) || 0) > 0 ? nowIso : "",
    tabRounds: [],
    tabTotal: 0,
    status: "confirmed",
    createdBy: staffName,
    isCorporateBooking: true,
  });

  // HOLD docs: one per EXTRA table so every table shows occupied on the floor
  // maps. They carry NO advance and partySize 0 (the master owns those) so
  // counters/billing are never double-counted. Linked back via groupRef.
  for (const tId of allTables.slice(1)) {
    const holdRef = `${ref}-T-${tId.replace(/[^A-Za-z0-9]/g, "")}`;
    await setDoc(doc(db, TABLE_RES_COL, holdRef), {
      tableId: tId,
      floor: floor || "",
      floorLabel: floorLabel || "",
      date,
      customerName: customerName.trim(),
      companyName: companyName.trim(),
      phone: phoneClean,
      partySize: 0,
      arrivalTime,
      bookingRef: holdRef,
      groupRef: ref,
      bookedAt: nowIso,
      source: "corporate",
      bookMode: "group",
      notes: notes || "",
      email: "",
      amenities: [],
      amenitiesTotal: 0,
      advanceAmount: 0,
      advanceMode: "",
      advanceRef: "",
      advancePaidAt: "",
      tabRounds: [],
      tabTotal: 0,
      status: "confirmed",
      createdBy: staffName,
      isCorporateBooking: true,
      isGroupHold: true,
    });
  }
  return ref;
}

// 🔴 2026-05-19 (Khushi LIVE-NIGHT) — default amenity catalog. Door staff can
// tick any of these (price is editable per booking) and/or add a custom row.
export const DEFAULT_BOOKING_AMENITIES: BookingAmenity[] = [
  { name: "Valet Parking",   price: 200,  qty: 1 },
  { name: "Special Decor",   price: 2500, qty: 1 },
  { name: "Celebration Cake", price: 1500, qty: 1 },
  { name: "Custom DJ Request", price: 5000, qty: 1 },
];

// 🔴 2026-05-16 (Khushi) — door staff need to FIX aggregator bookings whose
// parser-extracted data is incomplete (Zomato emails only give us the
// customer name; pax/time/date often get defaults). This is an audit-trailed
// edit so any later disputes have a clear paper trail of who edited what.
// Idempotent — only writes fields the caller passed in.
export async function updateReservationDetails(
  docId: string,
  patch: { partySize?: number; arrivalTime?: string; date?: string; phone?: string },
  staffName: string
): Promise<void> {
  const cleaned: Record<string, unknown> = {};
  if (typeof patch.partySize === "number" && patch.partySize > 0 && patch.partySize <= 50) {
    cleaned.partySize = Math.floor(patch.partySize);
  }
  if (typeof patch.arrivalTime === "string" && patch.arrivalTime.trim().length > 0 && patch.arrivalTime.length <= 20) {
    cleaned.arrivalTime = patch.arrivalTime.trim();
  }
  // Strict date validation: must be YYYY-MM-DD AND parse to a real calendar date
  // (rejects 2026-99-99 etc.) AND within ±60 days of today (defends against typos).
  if (typeof patch.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(patch.date)) {
    const d = new Date(patch.date + "T12:00:00Z");
    if (!isNaN(d.getTime()) && d.toISOString().slice(0, 10) === patch.date) {
      const deltaDays = Math.abs((d.getTime() - Date.now()) / 86400000);
      if (deltaDays <= 60) cleaned.date = patch.date;
    }
  }
  // 🔴 2026-05-16 (Khushi) — phone added so door staff can fill in numbers
  // missing from Zomato emails. Accept 10-15 digits with optional + prefix
  // and forgiving spaces/dashes; we strip non-digits on save so the canonical
  // form (used by WhatsApp + Sheets sync + admin search) is consistent.
  if (typeof patch.phone === "string" && patch.phone.trim().length > 0) {
    const raw = patch.phone.trim();
    const digitsOnly = raw.replace(/[^\d]/g, "");
    if (digitsOnly.length >= 10 && digitsOnly.length <= 15) {
      cleaned.phone = digitsOnly;
    } else {
      throw new Error("Phone must be 10–15 digits (e.g. 9611111261 or +919611111261).");
    }
  }
  if (Object.keys(cleaned).length === 0) {
    throw new Error("Nothing valid to save — check your inputs (pax 1–50, valid time, date within 60 days).");
  }
  cleaned.lastEditedAt = new Date().toISOString();
  cleaned.lastEditedBy = staffName;
  await updateDoc(doc(db, TABLE_RES_COL, docId), cleaned);
}

export async function cancelTableReservation(docId: string, staffName: string): Promise<void> {
  await updateDoc(doc(db, TABLE_RES_COL, docId), {
    status: "cancelled",
    cancelledAt: new Date().toISOString(),
    cancelledBy: staffName,
  });
}

export async function reassignTable(
  docId: string, newTableId: string, newFloor: string, newFloorLabel: string, captainName: string
): Promise<void> {
  const snap = await getDoc(doc(db, TABLE_RES_COL, docId));
  if (!snap.exists()) throw new Error("Reservation not found");
  const data = snap.data();
  if (isTableBillSettled(data)) throw new Error("Cannot reassign a settled table");
  const date = data.date || getOperationalNightStr();
  const oldTableId = data.tableId;
  // 🆕 2026-06-02 (Khushi BUG) — align the conflict check with the GRID PICKER.
  // The picker (doorTableOccupantAt) only treats a table as TAKEN when it has a
  // NON-paid reservation whose arrival window overlaps NOW. The old check here
  // rejected on ANY reservation for that table that night (incl. paid / earlier
  // or later non-overlapping slots) → a table the picker showed GREEN got an
  // "already occupied" error. Fetch the table's reservations and run the SAME
  // helper so green == assignable. Exclude this booking's own doc.
  const q2 = query(collection(db, TABLE_RES_COL), where("tableId", "==", newTableId), where("date", "==", date));
  const existing = await getDocs(q2);
  const others = existing.docs
    .filter((d) => d.id !== docId)
    .map((d) => ({ _docId: d.id, ...(d.data() as any) })) as HodTableReservation[];
  if (doorTableOccupantAt(newTableId, doorNowMinutesIST(), others)) {
    throw new Error(`Table ${newTableId} is already occupied`);
  }
  await updateDoc(doc(db, TABLE_RES_COL, docId), {
    tableId: newTableId, floor: newFloor, floorLabel: newFloorLabel,
    reassignedFrom: oldTableId, reassignedAt: new Date().toISOString(), reassignedBy: captainName,
  });
}

// 🆕 2026-06-19 (Khushi) — corporate bookings hold N tables via a master doc +
// hold docs. When the door girl taps REASSIGN on a corporate booking she can
// pick a NEW set of tables. This function:
//   1. Conflict-checks each newly added table (skips tables already held by us).
//   2. Updates the master doc (tableId = first table, tableIds = full new set).
//   3. Deletes ALL old hold docs for this group.
//   4. Creates fresh hold docs for each extra table (same shape as createCorporateTableBooking).
// Fail-safe: the settled-table guard prevents reassigning after a bill is paid.
export async function reassignCorporateTables(
  masterDocId: string,
  newTableIds: string[],
  staffName: string,
): Promise<void> {
  if (!newTableIds.length) throw new Error("Pick at least one table");
  const masterSnap = await getDoc(doc(db, TABLE_RES_COL, masterDocId));
  if (!masterSnap.exists()) throw new Error("Reservation not found");
  const master = masterSnap.data() as Record<string, any>;
  if (!master.isCorporateBooking) throw new Error("Not a corporate booking");
  if (isTableBillSettled(master as any)) throw new Error("Cannot reassign a settled table");
  const date = (master.date as string) || getOperationalNightStr();
  const groupRef = (master.groupRef as string) || masterDocId;
  const nowMin = doorNowMinutesIST();
  // All doc ids belonging to this group — excluded from conflict checks.
  const holdSnap = await getDocs(
    query(collection(db, TABLE_RES_COL), where("groupRef", "==", groupRef), where("isGroupHold", "==", true)),
  );
  const groupDocIds = new Set([masterDocId, ...holdSnap.docs.map((d) => d.id)]);
  const currentTableIds = new Set<string>(
    ((master.tableIds as string[] | undefined) || (master.tableId ? [master.tableId as string] : [])),
  );
  // Conflict-check tables that are NEW to this group.
  for (const tId of newTableIds) {
    if (currentTableIds.has(tId)) continue;
    const q2 = query(collection(db, TABLE_RES_COL), where("tableId", "==", tId), where("date", "==", date));
    const existing = await getDocs(q2);
    const others = existing.docs
      .filter((d) => !groupDocIds.has(d.id))
      .map((d) => ({ _docId: d.id, ...(d.data() as any) })) as HodTableReservation[];
    if (doorTableOccupantAt(tId, nowMin, others)) throw new Error(`Table ${tId} is already occupied`);
  }
  const masterTable = newTableIds[0];
  const nowIso = new Date().toISOString();
  await updateDoc(doc(db, TABLE_RES_COL, masterDocId), {
    tableId: masterTable, tableIds: newTableIds,
    reassignedAt: nowIso, reassignedBy: staffName,
  });
  // Delete all old hold docs.
  for (const hd of holdSnap.docs) await deleteDoc(doc(db, TABLE_RES_COL, hd.id));
  // Create new hold docs for each extra table.
  for (const tId of newTableIds.slice(1)) {
    const holdRef = `${groupRef}-T-${tId.replace(/[^A-Za-z0-9]/g, "")}`;
    await setDoc(doc(db, TABLE_RES_COL, holdRef), {
      tableId: tId,
      floor: master.floor || "", floorLabel: master.floorLabel || "",
      date,
      customerName: master.customerName || "", companyName: master.companyName || "",
      phone: master.phone || "", partySize: 0,
      arrivalTime: master.arrivalTime || "",
      bookingRef: holdRef, groupRef,
      bookedAt: nowIso, source: "corporate", bookMode: "group",
      notes: master.notes || "", email: "",
      amenities: [], amenitiesTotal: 0,
      advanceAmount: 0, advanceMode: "", advanceRef: "", advancePaidAt: "",
      tabRounds: [], tabTotal: 0, status: "confirmed",
      createdBy: staffName, isCorporateBooking: true, isGroupHold: true,
    });
  }
}

export async function createProxyTable(
  proxyName: string, floor: string, floorLabel: string,
  customerName: string, phone: string, partySize: number, captainName: string,
  aggregator = "inhouse", aggregatorDiscount = 0,
  // 🆕 2026-05-20 (Khushi) — see createWalkInTable.
  email = "", arrivalTimeOverride = ""
): Promise<string> {
  const now = new Date();
  // 🆕 2026-06-08 (Khushi MIDNIGHT BUG) — operational night (rolls 7AM IST), NOT
  // the UTC calendar date. A live walk-in is always for the current night; UTC
  // disagrees with the operational night in the 5:30–7AM IST window and would
  // file the table under a different date than its cover + the captain view.
  const date = getOperationalNightStr();
  const arrTime = arrivalTimeOverride.trim() || now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const ref = `PROXY-${proxyName.replace(/\s+/g, "-")}-${Date.now().toString(36).toUpperCase()}`;
  // Write covers doc FIRST (see createWalkInTable for rationale).
  await setDoc(doc(db, COVERS_COL, ref), {
    isTableBooking: true, tableId: proxyName, floor, floorLabel,
    customerName, name: customerName, phone: phone || "", partySize: partySize || 2,
    ...(email.trim() ? { email: email.trim() } : {}),
    arrivalTime: arrTime, actualArrivalTime: arrTime,
    bookingRef: ref, ref, isWalkIn: true, isProxy: true,
    // 🔴 2026-05-22 (Khushi COST FIX) — date REQUIRED for tonight-scoped feed.
    date: getOperationalNightStr(),
  }, { merge: true });
  const d = doc(db, TABLE_RES_COL, ref);
  await setDoc(d, {
    tableId: proxyName, floor, floorLabel, date, customerName, phone: phone || "",
    ...(email.trim() ? { email: email.trim() } : {}),
    partySize: partySize || 2, arrivalTime: arrTime, actualArrivalTime: arrTime,
    bookingRef: ref, bookedAt: now.toISOString(), source: aggregator,
    aggregator, aggregatorDiscount, tabRounds: [], tabTotal: 0,
    status: "confirmed", createdBy: captainName, isWalkIn: true, isProxy: true,
  });
  return ref;
}

export async function addRoundToTable(
  docId: string, items: HodOrderItem[], staffName: string
): Promise<void> {
  const ref = doc(db, TABLE_RES_COL, docId);
  await runTransaction(db, async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists()) throw new Error("Reservation not found");
    const data = snap.data();
    if (isTableBillSettled(data)) throw new Error("Cannot add orders to a settled table");
    const rounds: HodTabRound[] = Array.isArray(data.tabRounds) ? [...data.tabRounds] : [];
    const normItems = items.map((it) => ({
      n: it.n, p: it.p, qty: it.qty, cat: it.cat || "",
      t: it.t || "drink",
      alc: it.alc === false ? false : (it.t === "food" ? false : true),
      ...(typeof it.v === "boolean" ? { v: it.v } : {}),
    }));
    // 🆕 MERGE-INTO-PENDING: if the last round is still "preparing" (KOT not
    // yet printed to kitchen), append these items into THAT round instead of
    // creating a brand-new round. Prevents the multi-KOT-per-table mess where
    // captain adds items in 3 separate taps and kitchen gets 3 tickets for one
    // order. Once the round is printed (status=activated), the next add
    // correctly starts a fresh Round N+1 — kitchen already has the prior one.
    const lastIdx = rounds.length - 1;
    const canMerge = lastIdx >= 0 && rounds[lastIdx].status === "preparing";
    if (canMerge) {
      const merged: any[] = [...(rounds[lastIdx].items || [])];
      // Dedupe by name + price + veg flag — same item tapped again → bump qty.
      for (const ni of normItems) {
        const matchIdx = merged.findIndex((mi) =>
          mi.n === ni.n && Number(mi.p) === Number(ni.p) && (mi.v ?? null) === (ni.v ?? null)
        );
        if (matchIdx >= 0) merged[matchIdx] = { ...merged[matchIdx], qty: Number(merged[matchIdx].qty || 0) + Number(ni.qty || 0) };
        else merged.push(ni);
      }
      const newRoundTotal = computeHodBreakdown(merged as HodOrderItem[]).grandTotal;
      rounds[lastIdx] = {
        ...rounds[lastIdx],
        items: merged,
        roundTotal: newRoundTotal,
        // Refresh placedAt so the kitchen sees the LATEST add time when KOT prints.
        placedAt: new Date().toISOString(),
        placedBy: staffName,
      };
    } else {
      // Tax-inclusive total — matches BarMode + customer wallet so KOT, billing, and tab totals all agree.
      const roundTotal = computeHodBreakdown(items).grandTotal;
      rounds.push({
        roundNum: rounds.length + 1,
        items: normItems,
        roundTotal, status: "preparing",
        placedAt: new Date().toISOString(), placedBy: staffName,
      });
    }
    const tabTotal = rounds.reduce((s, r) => s + (r.roundTotal || 0), 0);
    // L8: if a bill has already been printed, mark the tab stale so the captain
    // card shows a red "REPRINT REQUIRED" banner.
    const upd: Record<string, unknown> = { tabRounds: rounds, tabTotal };
    if ((data.billPrintCount || 0) > 0) upd.billStale = true;
    txn.update(ref, upd);
    // 🔴 2026-05-13 — Khushi: captain-added items weren't reaching the
    // customer wallet because the wallet (for in-house HOD- bookings)
    // subscribes to covers/{bookingRef}.tabRounds, but addRoundToTable only
    // wrote to tableReservations. Mirror the full rounds array to covers so
    // the wallet receives it live. Stash bookingRef + rounds for the
    // post-txn mirror below (can't do a second collection write inside the
    // same transaction without enrolling the covers doc, which would
    // serialize unrelated wallet writes).
    (upd as any).__mirror = { bookingRef: data.bookingRef, rounds, tabTotal };
  });
  // Best-effort mirror to covers (dual: bookingRef AND linkedCoverDocId) — never
  // fail the captain-side write if the cover doc doesn't exist (table-only flows
  // e.g. walk-ins). 🔴 2026-06-08 v3.252 — routed through the shared
  // _mirrorRoundsToCovers so the cover's BAR-only rounds are PRESERVED (union,
  // not replace): a captain "ADD ORDER" / merge-into-pending no longer wipes a
  // guest's "I'M AT THE BAR" rounds off the wallet.
  try {
    const freshSnap = await getDoc(ref);
    const fd = freshSnap.exists() ? freshSnap.data() : null;
    if (fd) {
      await _mirrorRoundsToCovers(
        Array.isArray(fd.tabRounds) ? fd.tabRounds : [],
        fd.bookingRef,
        (fd as { linkedCoverDocId?: string }).linkedCoverDocId
      );
    }
  } catch {}
}

export async function releaseTable(
  docId: string, reservation: HodTableReservation, captainName: string
): Promise<void> {
  const archive: Record<string, unknown> = {};
  Object.keys(reservation).forEach((k) => { if (k !== "_docId") archive[k] = (reservation as any)[k]; });
  const releasedAtIso = new Date().toISOString();
  archive.releasedAt = releasedAtIso;
  archive.sessionDuration = reservation.bookedAt
    ? Math.round((Date.now() - new Date(reservation.bookedAt).getTime()) / 60000) : null;
  archive.captainName = captainName;
  await addDoc(collection(db, TABLE_HISTORY_COL), archive);
  // 🔴 2026-05-13 (Khushi spec) — leave a tiny marker doc keyed by the
  // bookingRef so the customer's wallet can render the "🙏 Thank you for
  // visiting" screen on next refresh, even if they never opened the wallet
  // during the live session (breadcrumb missing). Without this marker the
  // wallet can't tell "captain released" apart from "table never created
  // yet" — both look like an empty `tableReservations` query. Marker is
  // intentionally small (no PII beyond what's already in tableHistory) and
  // long-lived; wallet does a one-shot get(), so cost is negligible.
  if (reservation.bookingRef) {
    try {
      await setDoc(doc(db, "releasedReservations", reservation.bookingRef), {
        bookingRef: reservation.bookingRef,
        tableId: reservation.tableId || "",
        floorLabel: reservation.floorLabel || reservation.floor || "",
        releasedAt: releasedAtIso,
        releasedBy: captainName,
      });
    } catch {}
  }
  await deleteDoc(doc(db, TABLE_RES_COL, docId));
  if (reservation.bookingRef) await deleteDoc(doc(db, COVERS_COL, reservation.bookingRef)).catch(() => {});
}

// 🩹 v3.4 belt-and-suspenders — when a Zomato Dining Partner payment email
// arrives BEFORE the booking, the cloud function stashes it as a sibling
// `aggregatorBookings/zomato-txn-*` doc with status='pending-booking'. The
// v3.4 cloud-function patch claims those orphans into the real booking, but
// in case the deploy hasn't landed yet (or a race left one behind),
// CaptainMode uses this helper to render the PAID badge from the orphan.
//
// Returns the orphan's pendingPayment + discountPercent if exactly one
// pending-booking Zomato sibling matches the guest's first name. Returns
// null on zero / ambiguous matches so we never auto-PAID the wrong table.
export interface OrphanZomatoPayment {
  paidAmount: number;
  paymentChannel: string;
  paidAt: string;
  discountPercent: number | null;
  orphanDocId: string;
}
export async function lookupOrphanZomatoPaymentByName(
  guestName: string,
  guestPhone?: string,
): Promise<OrphanZomatoPayment | null> {
  const fn = String(guestName || "").trim().split(/\s+/)[0].toLowerCase();
  // Phone: keep only digits and use the last 10 (Indian mobile). Empty if too short.
  const phoneDigits = String(guestPhone || "").replace(/\D/g, "");
  const phoneSuffix = phoneDigits.length >= 10 ? phoneDigits.slice(-10) : "";
  if (!fn && !phoneSuffix) return null;
  try {
    const q = query(
      collection(db, "aggregatorBookings"),
      where("source", "==", "zomato"),
      where("status", "==", "pending-booking"),
    );
    const snap = await getDocs(q);
    // Phone-first match (more reliable when two bookings share a first name).
    let matches = phoneSuffix ? snap.docs.filter((d) => {
      const dp = String((d.data() as any).guestPhone || "").replace(/\D/g, "");
      return dp.length >= 10 && dp.slice(-10) === phoneSuffix;
    }) : [];
    // Fall back to first-name match only if phone produced nothing.
    if (matches.length === 0 && fn) {
      matches = snap.docs.filter((d) => {
        const dn = String((d.data() as any).guestName || "").trim().split(/\s+/)[0].toLowerCase();
        return dn === fn;
      });
    }
    if (matches.length !== 1) return null;
    const data = matches[0].data() as any;
    const pp = data.pendingPayment || {};
    return {
      paidAmount: Number(pp.paidAmount || 0),
      paymentChannel: String(pp.paymentChannel || "zomato"),
      paidAt: String(pp.paidAt || ""),
      discountPercent: typeof data.discountPercent === "number" ? data.discountPercent : null,
      orphanDocId: matches[0].id,
    };
  } catch (e) {
    console.warn("[lookupOrphanZomatoPaymentByName] failed", e);
    return null;
  }
}

// 🔎 v3.4 Door Mode — Find Booking across collections. The on-screen lists
// only show TODAY, but a guest might walk up with a booking made tonight that
// hasn't appeared on the door tablet yet, OR with a future-date reservation
// they want to confirm. This helper queries `bookings` and `aggregatorBookings`
// directly so the door agent never has to say "we don't see you".
//
// Matches against name (case-insensitive substring), phone (digit suffix),
// or booking ref/externalId. Returns up to 8 best matches across both
// collections, normalized into HodBooking shape so the existing LookupResult
// component can render them.
export interface CrossSourceBooking extends HodBooking {
  _src?: "bookings" | "aggregator";
  _aggregator?: string;
  _bookingDate?: string;
  _arrivalTime?: string;
  _partySize?: number;
  // Aggregator-only: true when the booking is still waiting for a table to
  // be auto-assigned (or flagged needsManualEntry). LookupResult must NOT
  // call checkInGuest in that case — there is no tableReservation yet.
  _pendingAssignment?: boolean;
  _tableId?: string;
  _floorLabel?: string;
}
export async function searchBookingsAndAggregators(
  needle: string
): Promise<CrossSourceBooking[]> {
  const raw = String(needle || "").trim();
  if (raw.length < 2) return [];
  const lower = raw.toLowerCase();
  const digits = raw.replace(/\D/g, "");
  const results: CrossSourceBooking[] = [];

  const matchPhone = (p?: string) => {
    if (!digits || digits.length < 4) return false;
    const pd = String(p || "").replace(/\D/g, "");
    return !!pd && pd.includes(digits);
  };
  const matchText = (s?: string) => !!s && String(s).toLowerCase().includes(lower);

  try {
    const [bSnap, aSnap] = await Promise.all([
      getDocs(query(collection(db, BOOKINGS_COL), limit(500))),
      getDocs(query(collection(db, "aggregatorBookings"), limit(500))),
    ]);

    for (const d of bSnap.docs) {
      const b = d.data() as any;
      if (matchText(b.name) || matchPhone(b.phone) || matchText(b.ref)) {
        results.push({
          id: d.id, ref: b.ref || d.id, name: b.name || "", phone: b.phone || "",
          guests: b.guests || 0, type: b.type || "", tier: b.tier || "",
          eventTitle: b.eventTitle || "", total: b.total || 0,
          paymentId: b.paymentId || "", checkedIn: !!b.checkedIn, date: b.date || "",
          _src: "bookings",
        });
      }
    }
    // Collect matching aggregator hits first so we can resolve their linked
    // tableReservations in a single batched pass (so check-in routes correctly).
    const aggHits: Array<{ id: string; b: any }> = [];
    for (const d of aSnap.docs) {
      const b = d.data() as any;
      if (b.status === "pending-booking" || b.status === "cancelled") continue;
      const ext = b.externalId || "";
      if (matchText(b.guestName) || matchPhone(b.guestPhone) || matchText(ext) || matchText(d.id)) {
        aggHits.push({ id: d.id, b });
      }
    }

    // Resolve linked tableReservation docs for aggregator hits that have one,
    // so we can mark them _isTable + ref=bookingRef (the only key checkInGuest
    // accepts for source='table'). Aggregator docs without a tableReservation
    // are surfaced with _pendingAssignment so the UI shows an explicit notice
    // instead of a non-functional check-in button.
    const tableResIds = aggHits.map(({ b }) => b.tableReservationId).filter(Boolean) as string[];
    const tableResMap = new Map<string, any>();
    await Promise.all(tableResIds.map(async (tid) => {
      try {
        const tSnap = await getDoc(doc(db, TABLE_RES_COL, tid));
        if (tSnap.exists()) tableResMap.set(tid, tSnap.data());
      } catch { /* swallow per-doc */ }
    }));

    for (const { id, b } of aggHits) {
      const tRes = b.tableReservationId ? tableResMap.get(b.tableReservationId) : null;
      const aggLabel = (b.aggregatorKey || b.source || "agg").toUpperCase();
      if (tRes && tRes.bookingRef && tRes.status !== "cancelled") {
        // Routable to existing tableReservation → check-in path works.
        results.push({
          id: tRes.bookingRef, ref: tRes.bookingRef,
          name: tRes.customerName || b.guestName || "", phone: tRes.phone || b.guestPhone || "",
          guests: tRes.partySize || b.partySize || 0, type: "Aggregator Table",
          eventTitle: `${aggLabel} · ${tRes.tableId || ""} · ${tRes.floorLabel || tRes.floor || ""} · ${tRes.arrivalTime || ""}`.replace(/ +/g, " ").trim(),
          checkedIn: !!tRes.actualArrivalTime, date: tRes.date || b.bookingDate || "",
          _isTable: true,
          _src: "aggregator", _aggregator: b.aggregatorKey || b.source || "",
          _bookingDate: tRes.date || b.bookingDate || "", _arrivalTime: tRes.arrivalTime || b.arrivalTime || "",
          _partySize: tRes.partySize || b.partySize || 0,
          _tableId: tRes.tableId || "", _floorLabel: tRes.floorLabel || tRes.floor || "",
        });
      } else {
        // Pending assignment / needs manual review — show but don't allow check-in.
        results.push({
          id, ref: id, name: b.guestName || "", phone: b.guestPhone || "",
          guests: b.partySize || 0, type: "Aggregator (pending table)",
          eventTitle: `${aggLabel} · awaiting table · ${b.bookingDate || ""} ${b.arrivalTime || ""}`.trim(),
          checkedIn: false, date: b.bookingDate || "",
          _src: "aggregator", _aggregator: b.aggregatorKey || b.source || "",
          _bookingDate: b.bookingDate || "", _arrivalTime: b.arrivalTime || "",
          _partySize: b.partySize || 0,
          _pendingAssignment: true,
        });
      }
    }
  } catch (e) {
    console.warn("[searchBookingsAndAggregators] failed", e);
  }

  // De-dup by id and cap to 8 best
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  }).slice(0, 8);
}

export async function lookupBooking(ref: string): Promise<HodBooking | null> {
  // 🆕 2026-05-27 v3.50 (Khushi LIVE-NIGHT) — TABLE refs (HODTAB/TBL-/AGG-)
  // resolve to the tableReservations doc FIRST. Without this, scanning a
  // HODTAB QR at the door opened the TICKET modal (because saveBooking also
  // writes a bookings doc, which q1 was finding first) — bypassing the table
  // flow (floor/table label, captain-flow cover activation). Now scanner +
  // search + row-tap all land on the same TABLE BookingDetailModal for table
  // refs. Non-table refs are unchanged (q1 still runs first).
  const _r = String(ref || "");
  const _isTableRef = _r.startsWith("HODTAB") || _r.startsWith("TBL-") || _r.startsWith("AGG-");
  if (_isTableRef) {
    const qt = query(collection(db, TABLE_RES_COL), where("bookingRef", "==", ref), limit(1));
    const st = await getDocs(qt);
    if (!st.empty) {
      const d = st.docs[0].data() as any;
      // 🆕 2026-05-27 v3.86 (Khushi LIVE-NIGHT) — `coverActivated > 0` is NO
      // LONGER a valid arrival heuristic. v3.42 pre-credits coverActivated =
      // tableTotal (₹5,000 / ₹15,000) at BOOKING TIME for HODTAB / TBL-, so
      // every freshly-booked table now ships with coverActivated > 0 BEFORE
      // any check-in. The old v3.51 heuristic (kept for legacy door-activated
      // covers) was making the scanner say "✓ COVER ACTIVATED" for guests
      // who hadn't physically arrived yet. Truth is now: arrived = explicit
      // `arrived` flag OR a non-empty `actualArrivalTime`. Pre-paid balance
      // alone proves nothing about whether the guest is on premises.
      const _arrived = !!(d.arrived || d.actualArrivalTime);
      return { id: st.docs[0].id, ref: d.bookingRef || ref, name: d.customerName || "",
        phone: d.phone || "",
        email: d.email || "",
        eventTitle: "",
        _isTable: true,
        checkedIn: _arrived,
        ...({
          _tableId: d.tableId || "",
          _floorLabel: d.floorLabel || "",
          _arrived,
          _actualArrivalTime: d.actualArrivalTime || "",
          _tablePrePaid: !!d.tablePrePaid,
          _coverActivated: Number(d.coverActivated) || 0,
          _coverBalance: Number(d.coverBalance) || 0,
        } as object),
      } as HodBooking;
    }
  }

  const q1 = query(collection(db, BOOKINGS_COL), where("ref", "==", ref), limit(1));
  const s1 = await getDocs(q1);
  if (!s1.empty) {
    const _d = s1.docs[0].data() as any;
    // 🆕 2026-06-18 v3.315 (Khushi) — a GUESTLIST signup ALSO writes a bookings
    // doc (entryType "guestlist_*"). This BOOKINGS query matches BEFORE the
    // guestlist-collection branch below, so a SCANNED guestlist QR used to
    // return WITHOUT `_isGuestList` — the door scan modal then showed the paid
    // "CHECK IN GUEST" flow instead of the FREE-ENTRY guestlist modal. Tag the
    // origin here so the scan modal matches the search-row guestlist modal
    // exactly: `_isGuestList` flips the CTA to FREE ENTRY; `_glSource:"booking"`
    // tells the FREE ENTRY handler to check in via the bookings collection (the
    // guestlist collection has no doc for these); `_glDocId` mirrors adapt()
    // (the bookings doc id) so cover-activation's check-in mirror is identical;
    // `joinedAt` (from bookedAt) feeds the SIGNED UP row. Fail-open: a
    // non-guestlist booking is byte-unchanged.
    const _isGl = String(_d.entryType || "").startsWith("guestlist_");
    return {
      id: s1.docs[0].id,
      ..._d,
      ...(_isGl ? { _isGuestList: true, _glSource: "booking", _glDocId: s1.docs[0].id, joinedAt: _d.joinedAt || _d.bookedAt || "" } : {}),
    } as HodBooking;
  }

  const q2 = query(collection(db, TABLE_RES_COL), where("bookingRef", "==", ref), limit(1));
  const s2 = await getDocs(q2);
  if (!s2.empty) {
    const d = s2.docs[0].data();
    return { id: s2.docs[0].id, ref: d.bookingRef || ref, name: d.customerName || "",
      phone: d.phone || "",
      email: d.email || "",
      // 🐛 FIX (2026-05-07): previously stored "<tableId> · <floor>" in
      //   eventTitle so the door card could show table info, but downstream
      //   `activateCoverForBooking` blindly copied that string into the
      //   covers doc, making the Reports "Event" column show "FD8 · Dining"
      //   for every walk-in. Table info is already on the reservation doc and
      //   surfaced separately. Leave eventTitle blank for table-source bookings.
      eventTitle: "",
      _isTable: true,
      // Pass through table info via dedicated fields for the door card to read
      // (cast to any so the synthetic shim can carry transient props).
      ...({ _tableId: d.tableId || "", _floorLabel: d.floorLabel || "" } as object),
    } as HodBooking;
  }

  const glDoc = await getDoc(doc(db, GUESTLIST_COL, ref));
  if (glDoc.exists()) {
    const _gd = glDoc.data() as any;
    return { id: glDoc.id, ..._gd, _isGuestList: true, _glSource: "guestlist", _glDocId: glDoc.id } as HodBooking;
  }
  return null;
}

export function subscribeToBookings(cb: (bookings: HodBooking[]) => void): Unsubscribe {
  return onSnapshot(collection(db, BOOKINGS_COL), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() } as HodBooking)));
  }, () => cb([]));
}

// 🔴 2026-05-23 (Khushi COST FIX round 2) — Date-scoped bookings feed. The
// unfiltered `subscribeToBookings` pulls the entire bookings collection
// (every booking ever made on hodclub.in) on EVERY subscriber — this is the
// #1 remaining read-burner. Pass tonight's operational-night date(s).
// Firestore `in` supports up to 10 values; we de-dupe + clamp defensively.
// Fail-open: empty array → returns [] (door staff sees no rows but no crash).
export function subscribeToBookingsForNights(
  nights: string[],
  cb: (bookings: HodBooking[]) => void,
): Unsubscribe {
  const unique = Array.from(new Set((nights || []).filter(Boolean))).slice(0, 10);
  if (unique.length === 0) { cb([]); return () => {}; }
  // v3.94 shared listener — keyed on the SORTED unique-nights tuple so two
  // callers passing [today, calToday] in either order share one phone line.
  const key = `bk:${[...unique].sort().join(",")}`;
  // 🆕 2026-05-27 v3.97 — CONVERTED FROM onSnapshot → one-shot get() + 30s
  // poll + visibilitychange (mirrors customer-site v3.95 events pattern).
  //
  // WHY: Query Insights 2026-05-27 ~14:55 ranked this query #1 by read load
  // — `tableReservations WHERE date IN [?]` at 646 reads/sample with only
  // ~7 writes/hr in the entire database. The reads were almost ENTIRELY
  // initial-read cost on listener re-subscribe (mobile network blips +
  // tablet sleep/wake) NOT write-fanout. onSnapshot here is the wrong tool:
  // door staff don't need sub-second freshness on booking lists (bookings
  // arrive over hours; the door view is a roster, not a live ticker).
  //
  // TRADEOFF (accepted): door girl sees a new walk-in / aggregator booking
  // up to 30s after it lands in Firestore. Foreground return → instant
  // refresh via visibilitychange. Captain alerts that DO need real-time
  // (cover activated, KOT printed) are on separate, narrower listeners.
  //
  // 🛟 FAIL-OPEN: try/catch around every getDocs → push([]). Tab-hidden →
  // ZERO reads (visibilitychange-gated). Cleanup returns clearInterval +
  // removeEventListener so calling unsub twice is safe.
  return _shareSubscription<HodBooking[]>(
    key,
    (push) => {
      let stopped = false;
      const fetchAndPush = async () => {
        if (stopped) return;
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        try {
          const snap = await getDocs(query(collection(db, BOOKINGS_COL), where("date", "in", unique)));
          if (stopped) return;
          push(snap.docs.map((d) => ({ id: d.id, ...d.data() } as HodBooking)));
        } catch (e) {
          console.warn("[subscribeToBookingsForNights] poll failed", e);
          if (!stopped) push([]);
        }
      };
      // Initial fetch (no gate — caller mounted; fetch even if backgrounded
      // so callers get their first paint).
      void (async () => {
        try {
          const snap = await getDocs(query(collection(db, BOOKINGS_COL), where("date", "in", unique)));
          if (stopped) return;
          push(snap.docs.map((d) => ({ id: d.id, ...d.data() } as HodBooking)));
        } catch (e) {
          console.warn("[subscribeToBookingsForNights] initial fetch failed", e);
          if (!stopped) push([]);
        }
      })();
      const id = setInterval(fetchAndPush, 30_000);
      const onVis = () => { if (typeof document !== "undefined" && document.visibilityState === "visible") void fetchAndPush(); };
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
      return () => {
        stopped = true;
        clearInterval(id);
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
      };
    },
    cb,
  );
}

export function subscribeToGuestlist(cb: (guests: HodGuestlistEntry[]) => void): Unsubscribe {
  return onSnapshot(collection(db, GUESTLIST_COL), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() } as HodGuestlistEntry)));
  }, () => cb([]));
}

// 🔴 2026-05-23 (Khushi COST FIX round 2) — Date-scoped guestlist feed.
// Guestlist entries (POS + customer-site) all carry `joinedAt` as an ISO
// string. We use a string-range query on that field — this only requires
// Firestore's built-in single-field index (no composite index needed).
// Pass a [from, to) window of YYYY-MM-DD strings, e.g. [calYesterday,
// calTomorrow) to safely cover the operational night which straddles UTC
// midnight. Fail-open: returns [] on error.
export function subscribeToGuestlistInRange(
  fromDateInclusive: string,
  toDateExclusive: string,
  cb: (guests: HodGuestlistEntry[]) => void,
): Unsubscribe {
  if (!fromDateInclusive || !toDateExclusive) { cb([]); return () => {}; }
  // v3.94 shared listener — keyed on [from, to) window.
  return _shareSubscription<HodGuestlistEntry[]>(
    `gl:${fromDateInclusive}:${toDateExclusive}`,
    (push) => onSnapshot(
      query(
        collection(db, GUESTLIST_COL),
        where("joinedAt", ">=", fromDateInclusive),
        where("joinedAt", "<", toDateExclusive),
      ),
      (snap) => push(snap.docs.map((d) => ({ id: d.id, ...d.data() } as HodGuestlistEntry))),
      () => push([]),
    ),
    cb,
  );
}

// 🔴 2026-05-20 (Khushi LIVE REPORTS) — subscribe to ALL covers so the Door
// Live Reports dashboard can show: total cover charges collected + total
// amount redeemed (= activated − balance) across BOTH linked-table covers
// AND walk-in bar covers. Returns the full covers collection — caller is
// responsible for date-filtering. Fail-open: on error returns [].
export function subscribeToAllCovers(cb: (covers: HodCover[]) => void): Unsubscribe {
  return onSnapshot(collection(db, COVERS_COL), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() } as HodCover)));
  }, () => cb([]));
}

// 🔴 2026-05-22 (Khushi COST FIX) — Date-filtered covers feed. The unfiltered
// `subscribeToAllCovers` was the #1 read-burner in the app (each open Door
// Mode tab subscribed to the WHOLE covers collection — months of history —
// every refresh). This variant scopes to a single operational night via the
// `date` field that every cover doc carries (see activateCoverForBooking,
// ensureZeroBalanceCoverForGuest, ensureCoverForAggregatorArrival).
// Pass `getOperationalNightStr()` for tonight. Fail-open: on error returns [].
export function subscribeToCoversForNight(
  night: string,
  cb: (covers: HodCover[]) => void,
): Unsubscribe {
  if (!night) { cb([]); return () => {}; }
  // v3.94 shared listener — keyed on night. DoorMode mounts this 3× per
  // tablet (allCovers + 2 distinct setCovers state hooks); all now share
  // ONE Firestore phone line.
  return _shareSubscription<HodCover[]>(
    `cov:${night}`,
    (push) => onSnapshot(
      query(collection(db, COVERS_COL), where("date", "==", night)),
      (snap) => push(snap.docs.map((d) => ({ id: d.id, ...d.data() } as HodCover))),
      () => push([]),
    ),
    cb,
  );
}

// Check in a guest. Returns { checkedInAt, wasNew, undone }.
//   - On a fresh check-in: wasNew=true, checkedInAt=new timestamp (use as undo token).
//   - On idempotent re-check (already checked in): wasNew=false, checkedInAt=existing.
//     Callers MUST gate "undo" UI on wasNew=true so a stale UI cannot offer to undo
//     someone else's prior check-in.
//   - On undo: pass `expectedCheckedInAt`; only reverses if current matches.
//     undone=true on success, false if state moved on (caller toasts "cannot undo").
export async function checkInGuest(
  guestId: string,
  source: "booking" | "guestlist" | "table",
  agentName: string,
  undo = false,
  expectedCheckedInAt?: string,
): Promise<{ checkedInAt: string; wasNew: boolean; undone: boolean }> {
  // Wait for anonymous auth — bookings collection rules require request.auth != null
  await authReady;
  const checkedInAt = new Date().toISOString();
  const checkinData = !undo
    ? { checkedInAt, checkedInBy: agentName }
    : { checkedInAt: "" };

  // Resolve the target doc ref (booking has fast/slow path).
  let targetRef: ReturnType<typeof doc> | null = null;
  if (source === "booking") {
    const directRef = doc(db, BOOKINGS_COL, guestId);
    const directSnap = await getDoc(directRef);
    if (directSnap.exists()) {
      targetRef = directRef;
    } else {
      const q = query(collection(db, BOOKINGS_COL), where("ref", "==", guestId), limit(1));
      const snap = await getDocs(q);
      if (!snap.empty) targetRef = snap.docs[0].ref;
    }
    if (!targetRef) throw new Error(`Booking not found for ref/id: ${guestId}`);
  } else if (source === "table") {
    const q = query(collection(db, TABLE_RES_COL), where("bookingRef", "==", guestId), limit(1));
    const snap = await getDocs(q);
    if (snap.empty) return { checkedInAt: "", wasNew: false, undone: false };
    targetRef = snap.docs[0].ref;
  } else {
    targetRef = doc(db, GUESTLIST_COL, guestId);
  }

  // Transactional check-and-set so undo can't clobber a newer mutation,
  // and double-tap check-in is idempotent on the timestamp/by fields.
  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(targetRef!);
    if (!snap.exists() && source === "guestlist") {
      // Some legacy guestlist rows may not exist as standalone docs; skip silently.
      return { checkedInAt: "", wasNew: false, undone: false };
    }
    const data = snap.exists() ? snap.data() : {};

    if (undo) {
      // Only undo if the record still has the exact timestamp we set
      if (expectedCheckedInAt && data.checkedInAt !== expectedCheckedInAt) {
        return { checkedInAt: "", wasNew: false, undone: false }; // state moved on
      }
      const updates: Record<string, unknown> = { checkedIn: false, checkedInAt: "" };
      if (source === "table") updates.actualArrivalTime = null;
      tx.update(targetRef!, updates);
      return { checkedInAt: "", wasNew: false, undone: true };
    }

    // Fresh check-in: if already checked in, return existing timestamp (idempotent, wasNew=false)
    if (data.checkedIn && data.checkedInAt) {
      return { checkedInAt: data.checkedInAt as string, wasNew: false, undone: false };
    }

    const updates: Record<string, unknown> = { checkedIn: true, ...checkinData };
    if (source === "table") {
      updates.actualArrivalTime = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    } else if (source === "guestlist") {
      updates.entryType = "free";
      updates.entryTime = checkedInAt;
    }
    tx.update(targetRef!, updates);
    return { checkedInAt, wasNew: true, undone: false };
  });
}

export async function logBarSession(staffName: string): Promise<void> {
  const ts = new Date().toISOString();
  await addDoc(collection(db, BAR_SESSIONS_COL), { staff: staffName, loginAt: ts, date: ts.split("T")[0] });
}

/** Cloud-Routed KOT printing.
 *  Writes ONE doc to `posKOTs`. Each item is tagged with `dest`. Each floor PC
 *  runs print-server/index.js, subscribes to this collection, claims items
 *  whose `dest` matches its config, and prints to its local Ethernet printer.
 *  See replit.md → "🖨 KOT PRINTING ARCHITECTURE" for the full design. */
export async function printKOT(data: {
  tableId: string; floorLabel?: string; customerName?: string; staff: string;
  roundNum: number; items: HodOrderItem[]; roundTotal: number;
  /** Optional override; defaults to tablet-floor binding from localStorage. */
  tabletFloor?: TabletFloor | null;
  /** If true, ALSO route a bill copy to the tablet floor's bill printer. */
  includeBill?: boolean;
  /** Reservation/wallet ref so the KOT-vs-Bill tally can match KOTs to
   *  bookings even when tableId is empty (wallet/cover flows). Also stash
   *  reservationId for belt-and-braces matching by Firestore doc id. */
  bookingRef?: string;
  reservationId?: string;
  customerPhone?: string;
  /** Optional human-friendly pairing token (e.g. "T-007"). When set, the
   *  print server renders it as a giant TOKEN line at the top of each
   *  KOT chit — runners + bartenders pair KOT↔Bill at a glance. */
  token?: string;
}): Promise<boolean> {
  try {
    const tabletFloor = data.tabletFloor ?? getTabletFloor();
    // Tag every item with a destination
    const itemsTagged = (data.items || []).map((it) => ({
      ...it, dest: deriveItemDestination(it, tabletFloor),
    }));
    if (data.includeBill) {
      itemsTagged.push({
        n: "Bill copy", p: 0, qty: 1, t: "food",
        dest: floorTag(tabletFloor, "bill"),
      } as HodOrderItem & { dest: string });
    }
    // Unique destinations on this KOT — drives the array-contains-any subscription
    const destinations = Array.from(new Set(itemsTagged.map((i) => (i as { dest: string }).dest)));
    // Initialise per-destination print slots so each floor PC has a claim target
    const prints: Record<string, { status: string; claimedBy: null; printedAt: null; attempts: number }> = {};
    for (const d of destinations) {
      prints[d] = { status: "pending", claimedBy: null, printedAt: null, attempts: 0 };
    }
    await addDoc(collection(db, "posKOTs"), {
      tableId: data.tableId,
      floorLabel: data.floorLabel || null,
      customerName: data.customerName || null,
      customerPhone: data.customerPhone || null,
      bookingRef: data.bookingRef || null,
      reservationId: data.reservationId || null,
      staff: data.staff,
      roundNum: data.roundNum,
      items: itemsTagged,
      roundTotal: data.roundTotal,
      time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
      tabletFloor: tabletFloor || null,
      destinations,
      prints,
      status: "pending",
      token: data.token || null,
      createdAt: serverTimestamp(),
    });
    return true; // Firestore SDK queues offline writes — always succeeds locally
  } catch (e) {
    console.error("[printKOT] failed", e);
    return false;
  }
}

/** V1 — KOT VOID PRINT.
 *  When a captain/bartender voids items from an already-printed KOT, the bar
 *  & kitchen MUST be told to scrap those items. We post a fresh "VOID KOT"
 *  to the same destinations the original items were routed to, with item
 *  names loud-prefixed "🚫 VOID — ..." so floor staff can't miss it.
 *
 *  Fallback design: written as a regular KOT (no `kind` field) so the
 *  existing print-server handles it without code changes. If Firestore /
 *  print fails, the void is STILL recorded in voidLog (separate call) and
 *  shows up on Live Monitor + Reports — floor staff just won't get a paper
 *  alert. Worst case = bar serves a voided drink → caught at bill review. */
export async function printKOTVoid(data: {
  tableId: string; floorLabel?: string; customerName?: string; staff: string;
  roundNum: number;
  /** Items that were voided — same shape as printKOT items. */
  voidedItems: HodOrderItem[];
  /** Total ₹ value of the voided items (informational, prints on slip). */
  valueLost: number;
  /** Optional reason captured from the void modal — prints in caps under the banner. */
  reason?: string;
  /** Optional override; defaults to tablet-floor binding from localStorage. */
  tabletFloor?: TabletFloor | null;
}): Promise<boolean> {
  try {
    const tabletFloor = data.tabletFloor ?? getTabletFloor();
    // Tag each voided item with its original destination so the right printer fires.
    const itemsTagged = (data.voidedItems || []).map((it) => ({
      ...it,
      n: `🚫 VOID — ${it.n}`,
      dest: deriveItemDestination(it, tabletFloor),
    }));
    if (itemsTagged.length === 0) return false;
    // Banner item rides to every destination so each printer prints a clear header.
    const destinations = Array.from(new Set(itemsTagged.map((i) => (i as { dest: string }).dest)));
    const banner = destinations.map((d) => ({
      n: `*** VOID NOTICE — ROUND ${data.roundNum} ***${data.reason ? ` (${data.reason.toUpperCase()})` : ""}`,
      p: 0, qty: 1, t: "food" as const, dest: d,
    }));
    const allItems = [...banner, ...itemsTagged];
    const prints: Record<string, { status: string; claimedBy: null; printedAt: null; attempts: number }> = {};
    for (const d of destinations) {
      prints[d] = { status: "pending", claimedBy: null, printedAt: null, attempts: 0 };
    }
    await addDoc(collection(db, "posKOTs"), {
      tableId: data.tableId,
      floorLabel: data.floorLabel || null,
      customerName: data.customerName || null,
      staff: data.staff,
      roundNum: data.roundNum,
      items: allItems,
      roundTotal: -Math.abs(data.valueLost), // negative so reports can spot voids
      voidNotice: true,                       // soft flag for UI filters (not used by print server)
      voidReason: data.reason || null,
      time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
      tabletFloor: tabletFloor || null,
      destinations,
      prints,
      status: "pending",
      createdAt: serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.error("[printKOTVoid] failed", e);
    return false;
  }
}

/** Cloud-Routed Thermal Bill printing.
 *  Writes ONE doc to `posKOTs` with kind:"bill". The print server detects
 *  this and uses formatBill() for full itemized invoice with prices, GST,
 *  total. Routes to the tablet floor's bill printer (gf_bill / ff_bill /
 *  rt_bill). */
export async function printBill(data: {
  tableId: string;
  floorLabel?: string;
  customerName?: string;
  partySize?: number;
  staff: string;
  items: Array<{ n: string; p: number; qty: number }>;
  amounts: {
    subtotal: number; serviceCharge: number; cgst: number; sgst: number;
    discount: number; roundOff: number; total: number; happyHourDiscount?: number;
  };
  paymentMethod?: string;
  billNumber?: string;
  isDuplicate?: boolean;
  tabletFloor?: TabletFloor | null;
  /** Optional pairing token — printed alongside the bill so cashier can
   *  match it to the KOT chit(s) carrying the same token. */
  token?: string;
}): Promise<boolean> {
  try {
    const tabletFloor = data.tabletFloor ?? getTabletFloor();
    const dest = floorTag(tabletFloor, "bill");
    const itemsTagged = data.items.map((i) => ({ ...i, dest }));
    const prints = {
      [dest]: { status: "pending", claimedBy: null, printedAt: null, attempts: 0 },
    };
    await addDoc(collection(db, "posKOTs"), {
      kind: "bill",
      tableId: data.tableId,
      floorLabel: data.floorLabel || null,
      customerName: data.customerName || null,
      partySize: data.partySize || null,
      staff: data.staff,
      items: itemsTagged,
      amounts: data.amounts,
      paymentMethod: data.paymentMethod || null,
      billNumber: data.billNumber || null,
      isDuplicate: !!data.isDuplicate,
      gstin: "29AARFH2309E1ZC",
      time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
      tabletFloor: tabletFloor || null,
      destinations: [dest],
      prints,
      status: "pending",
      token: data.token || null,
      createdAt: serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.error("[printBill] failed", e);
    return false;
  }
}

export async function syncMenuAvailability(menuItemId: string, outOfStock: boolean, staffName?: string): Promise<void> {
  await setDoc(doc(db, MENU_OVERRIDES_COL, menuItemId), {
    menuItemId, outOfStock, updatedBy: staffName || "system", updatedAt: serverTimestamp(),
  }, { merge: true });
}

// ───────────────────────────────────────────────────────────────────
// 🛎 Waiter Calls (customer wallet → captain/bar live notification)
// Customer hits "Call Waiter" on hodclub.in/?wallet=… → writes a doc
// to `waiterCalls/{auto}` with {coverRef, name, tableId?, status:'pending', createdAt}.
// CaptainMode + BarMode subscribe via subscribeActiveWaiterCalls →
// play a beep + show a red banner with an Acknowledge button.
// Acknowledged calls (ack'd within last 90s) auto-clear from the banner.
// ───────────────────────────────────────────────────────────────────
export interface WaiterCall {
  id: string;
  coverRef: string;
  customerName: string;
  tableId?: string | null;
  floorLabel?: string | null;
  status: "pending" | "acknowledged" | "cancelled";
  createdAt?: { seconds: number; nanoseconds: number } | null;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
}

const WAITER_CALLS_COL = "waiterCalls";

export async function createWaiterCall(input: {
  coverRef: string;
  customerName: string;
  tableId?: string | null;
  floorLabel?: string | null;
}): Promise<string> {
  await authReady;
  const ref = await addDoc(collection(db, WAITER_CALLS_COL), {
    coverRef: input.coverRef,
    customerName: input.customerName || "Guest",
    tableId: input.tableId || null,
    floorLabel: input.floorLabel || null,
    status: "pending",
    createdAt: serverTimestamp(),
    acknowledgedAt: null,
    acknowledgedBy: null,
  });
  return ref.id;
}

export function subscribeActiveWaiterCalls(cb: (calls: WaiterCall[]) => void): Unsubscribe {
  // Pending OR recently-acknowledged (< 90 s) — surfaces a brief "✓ ack'd by X" tail
  // so two staff don't both run to the same table thinking nobody answered.
  const q = query(collection(db, WAITER_CALLS_COL), orderBy("createdAt", "desc"), limit(20));
  return onSnapshot(q, (snap) => {
    const now = Date.now();
    const out: WaiterCall[] = [];
    snap.forEach((d) => {
      const data = d.data() as Record<string, unknown>;
      const status = (data.status as WaiterCall["status"]) || "pending";
      if (status === "cancelled") return;
      if (status === "acknowledged") {
        const ackAt = data.acknowledgedAt ? new Date(String(data.acknowledgedAt)).getTime() : 0;
        if (!ackAt || now - ackAt > 90_000) return;
      }
      out.push({
        id: d.id,
        coverRef: String(data.coverRef || ""),
        customerName: String(data.customerName || "Guest"),
        tableId: (data.tableId as string | null) || null,
        floorLabel: (data.floorLabel as string | null) || null,
        status,
        createdAt: (data.createdAt as WaiterCall["createdAt"]) || null,
        acknowledgedAt: (data.acknowledgedAt as string | null) || null,
        acknowledgedBy: (data.acknowledgedBy as string | null) || null,
      });
    });
    cb(out);
  }, (e) => {
    console.error("[subscribeActiveWaiterCalls] failed", e);
  });
}

export async function acknowledgeWaiterCall(id: string, staffName: string): Promise<void> {
  await authReady;
  await updateDoc(doc(db, WAITER_CALLS_COL, id), {
    status: "acknowledged",
    acknowledgedAt: new Date().toISOString(),
    acknowledgedBy: staffName || "Staff",
  });
}

// ════════════════════════════════════════════════════════════════════════
// MENU CRM — MenuCategory + MenuCategoryItem
// Live menu categories with discount-aware item pricing for POS menu views.
// Admin (8888) toggles a category LIVE → its items appear (with discount)
// on Captain/Bar menus. NO live categories → ALL items show (fail-open).
// ════════════════════════════════════════════════════════════════════════

export interface MenuCategoryItem {
  id: string;        // real HOD item id (e.g. "hod1") — used for stable cross-ref
  name: string;      // exact item name from HOD_MENU_ITEMS
  price: number;     // base price (pre-discount)
  categoryType: "food" | "drink";
  veg?: boolean;
  alc?: boolean;
}

export interface MenuCategory {
  id: string;
  name: string;
  discountPercent: number;
  items: MenuCategoryItem[];
  isLive: boolean;
  createdAt?: any;
  updatedAt?: any;
}

const MENU_CATEGORIES_COL = "menuCategories";

export async function createMenuCategory(data: Omit<MenuCategory, "id">): Promise<MenuCategory> {
  const now = new Date().toISOString();
  const docRef = await addDoc(collection(db, MENU_CATEGORIES_COL), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return { id: docRef.id, ...data, createdAt: now, updatedAt: now };
}

export async function updateMenuCategory(id: string, data: Partial<Omit<MenuCategory, "id">>): Promise<void> {
  await updateDoc(doc(db, MENU_CATEGORIES_COL, id), {
    ...data,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteMenuCategory(id: string): Promise<void> {
  await deleteDoc(doc(db, MENU_CATEGORIES_COL, id));
}

export async function toggleMenuCategoryLive(id: string, isLive: boolean): Promise<void> {
  await updateDoc(doc(db, MENU_CATEGORIES_COL, id), { isLive, updatedAt: serverTimestamp() });
}

export async function listMenuCategories(): Promise<MenuCategory[]> {
  const q = query(collection(db, MENU_CATEGORIES_COL), orderBy("name"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as MenuCategory));
}

export function subscribeToMenuCategories(cb: (categories: MenuCategory[]) => void): Unsubscribe {
  const q = query(collection(db, MENU_CATEGORIES_COL), orderBy("name"));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() } as MenuCategory)));
  }, () => cb([]));
}

export function subscribeToLiveMenuCategories(cb: (categories: MenuCategory[]) => void): Unsubscribe {
  // No composite index needed: filter live + sort client-side.
  const q = query(collection(db, MENU_CATEGORIES_COL), orderBy("name"));
  return onSnapshot(q, (snap) => {
    const all = snap.docs.map((d) => ({ id: d.id, ...d.data() } as MenuCategory));
    cb(all.filter((c) => c.isLive));
  }, () => cb([]));
}

/**
 * Filter menu items to only those in LIVE categories AND apply discount.
 * Generic over item shape: works for HodMenuItem, MenuItem, and MenuCategoryItem.
 * Matching is by lowercased trimmed name (so HOD ids like "hod1" don't matter).
 * Returns items with discounted prices; original objects are NOT mutated.
 *
 * NOTE: the caller should NO-OP when liveCategories.length === 0 to fail-open
 * (show all items). This function strictly returns ONLY items in live cats.
 */
export function filterMenuByLiveCategories<T extends { name: string; price: number }>(
  allItems: T[],
  liveCategories: MenuCategory[],
): T[] {
  if (liveCategories.length === 0) return allItems;
  // Build map: lowercased-name -> max discount % across categories the item appears in
  const nameToDiscount = new Map<string, number>();
  for (const cat of liveCategories) {
    for (const it of cat.items || []) {
      const key = (it.name || "").toLowerCase().trim();
      if (!key) continue;
      const prev = nameToDiscount.get(key) ?? -1;
      if ((cat.discountPercent || 0) > prev) nameToDiscount.set(key, cat.discountPercent || 0);
    }
  }
  if (nameToDiscount.size === 0) return [];
  const out: T[] = [];
  for (const it of allItems) {
    const key = (it.name || "").toLowerCase().trim();
    if (!nameToDiscount.has(key)) continue;
    const disc = nameToDiscount.get(key) ?? 0;
    if (disc > 0) {
      out.push({ ...it, price: Math.round(it.price * (1 - disc / 100) * 100) / 100 } as T);
    } else {
      out.push(it);
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// 🔴 2026-05-20 (Khushi) — WAITLIST FEATURE
// First-come-first-served queue for parties when no table fits.
// Hybrid algorithm: capacity-efficient match by default; any party waiting
// > WAITLIST_PRIORITY_MIN (20 min default) jumps the queue and gets the
// next table they fit on, regardless of efficiency.
// Same Firestore subscription strategy as tableReservations so Captain,
// Door, and Admin all stay in sync.
// ════════════════════════════════════════════════════════════════════════════

// Authoritative table capacity map — extracted from hodclub-patched/index.html
// and corrected per Khushi 20 May 2026 (GF = only C1-C4 + 2 VVIP).
export const TABLE_CAPACITY: Record<string, number> = {
  // Ground Floor (dance) — Khushi confirmed: C1-C4 + 2 VVIP only
  C1: 4, C2: 4, C3: 4, C4: 4,
  CVIP1: 8, CVIP2: 8,
  // First Floor / Dining
  FD1: 4, FD2: 4, FD3: 3, FD4: 6, FD5: 4, FD6: 6,
  FD7: 3, FD8: 2, FD9: 2, FD10: 2, FD11: 2, FD12: 4,
  FD14: 4, FD15: 4, FD16: 3, FD17: 3, FD18: 3,
  // 2F Smoking (lives on first-floor/dining)
  SMK1: 4, SMK2: 8, SMK4: 2, SMK5: 2, SMK6: 2, SMK7: 2, SMK8: 4,
  // Rooftop
  T1: 2, T2: 2, T3: 2, T4: 4, T5: 4, T6: 4, T7: 4, T11: 4,
  T8: 5, T9: 5, T10: 6,
  TEX1: 2, TVIP7: 2,
  TVIP1: 6, TVIP2: 6, TVIP5: 6, TVIP6: 6,
  TVIP3: 7, TVIP4: 7,
};

export function getTableCapacity(tableId: string): number {
  return TABLE_CAPACITY[tableId] || 0;
}

export type HodWaitlistStatus = "waiting" | "offered" | "seated" | "no-show" | "cancelled";

export interface HodWaitlistEntry {
  _docId?: string;
  customerName: string;
  phone: string;
  partySize: number;
  notes?: string;
  preferredFloor?: string;
  date: string;                // YYYY-MM-DD (IST calendar date)
  bookingRef: string;          // short ref shown to customer
  joinedAt: string;            // ISO timestamp — used for FCFS sort
  status: HodWaitlistStatus;
  offeredTableId?: string;
  offeredAt?: string;
  seatedTableId?: string;
  seatedAt?: string;
  skipCount?: number;
  staffName: string;
}

const WAITLIST_COL = "tableWaitlist";
export const WAITLIST_PRIORITY_MIN = 20;   // hybrid threshold

// Add a party to the waitlist.
export async function addToWaitlist(input: {
  customerName: string;
  phone: string;
  partySize: number;
  notes?: string;
  preferredFloor?: string;
  date: string;
  staffName: string;
}): Promise<{ id: string; ref: string }> {
  if (!input.customerName?.trim()) throw new Error("Enter guest name");
  if (!input.phone?.trim() || input.phone.replace(/\D/g, "").length < 10) throw new Error("Enter valid 10-digit phone");
  if (!input.partySize || input.partySize < 1) throw new Error("Enter party size");
  if (!input.date) throw new Error("Pick a date");
  const ref = "WL-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  await authReady;
  const docRef = await addDoc(collection(db, WAITLIST_COL), {
    customerName: input.customerName.trim(),
    phone: input.phone.trim(),
    partySize: Math.max(1, Math.min(50, input.partySize | 0)),
    notes: (input.notes || "").trim(),
    preferredFloor: (input.preferredFloor || "").trim(),
    date: input.date,
    bookingRef: ref,
    joinedAt: new Date().toISOString(),
    status: "waiting" as HodWaitlistStatus,
    skipCount: 0,
    staffName: input.staffName || "DOOR",
  });
  return { id: docRef.id, ref };
}

export function subscribeWaitlist(date: string, cb: (rows: HodWaitlistEntry[]) => void): Unsubscribe {
  const q = query(collection(db, WAITLIST_COL), where("date", "==", date));
  return onSnapshot(q, (snap) => {
    const all: HodWaitlistEntry[] = [];
    snap.forEach((d) => all.push({ _docId: d.id, ...(d.data() as any) }));
    // FCFS — oldest first
    all.sort((a, b) => (a.joinedAt || "").localeCompare(b.joinedAt || ""));
    cb(all);
  }, () => cb([]));
}

export async function removeFromWaitlist(id: string, reason: "cancelled" | "no-show" = "cancelled"): Promise<void> {
  await authReady;
  await updateDoc(doc(db, WAITLIST_COL, id), { status: reason, removedAt: new Date().toISOString() });
}

export async function markWaitlistSeated(id: string, tableId: string): Promise<void> {
  await authReady;
  await updateDoc(doc(db, WAITLIST_COL, id), {
    status: "seated" as HodWaitlistStatus,
    seatedTableId: tableId,
    seatedAt: new Date().toISOString(),
  });
}

export async function bumpWaitlistSkip(id: string): Promise<void> {
  await authReady;
  const snap = await getDoc(doc(db, WAITLIST_COL, id));
  const cur = (snap.data()?.skipCount as number) || 0;
  await updateDoc(doc(db, WAITLIST_COL, id), { skipCount: cur + 1, lastSkipAt: new Date().toISOString() });
}

// 🔴 2026-05-20 (Khushi) — RACE-SAFE CLAIM. Two door tablets can both watch
// the same freed table; only ONE may open the offer popup. Transactionally
// flips waiting→offered and stamps tablet owner. Returns false if another
// tablet already claimed (caller must NOT show the popup in that case).
export async function tryClaimWaitlistOffer(
  entryId: string, tableId: string, tabletOwner: string,
): Promise<boolean> {
  await authReady;
  const ref = doc(db, WAITLIST_COL, entryId);
  try {
    return await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return false;
      const data = snap.data() as any;
      if (data.status !== "waiting") return false;
      tx.update(ref, {
        status: "offered" as HodWaitlistStatus,
        offeredTableId: tableId,
        offeredAt: new Date().toISOString(),
        offeredBy: tabletOwner,
      });
      return true;
    });
  } catch { return false; }
}

// Revert offered→waiting (skip / timeout / user cancel). Only succeeds if
// the offer is still owned by us — protects against late revert after
// another tablet has already seated the party.
export async function releaseWaitlistOffer(
  entryId: string, tabletOwner: string,
): Promise<void> {
  await authReady;
  const ref = doc(db, WAITLIST_COL, entryId);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const data = snap.data() as any;
      if (data.status !== "offered" || data.offeredBy !== tabletOwner) return;
      tx.update(ref, {
        status: "waiting" as HodWaitlistStatus,
        offeredTableId: null,
        offeredAt: null,
        offeredBy: null,
        skipCount: (data.skipCount || 0) + 1,
        lastSkipAt: new Date().toISOString(),
      });
    });
  } catch {}
}

export async function updateWaitlistEntry(id: string, patch: Partial<HodWaitlistEntry>): Promise<void> {
  await authReady;
  await updateDoc(doc(db, WAITLIST_COL, id), patch as any);
}

// HYBRID match algorithm (Khushi-approved Option C).
// Given: freed table capacity + active waitlist (sorted oldest first).
// Returns the entry that should be offered the table, or null.
//
// Rules:
//   1. Anyone waiting > WAITLIST_PRIORITY_MIN minutes → priority queue.
//      Walk priority queue oldest first; first party that fits, gets it.
//   2. Otherwise → walk full queue oldest first; first party where
//      table capacity is "efficient" (capacity ≤ pax + 2 wasted seats)
//      AND fits (pax ≤ capacity). If none "efficient", fall back to
//      first-fits in FCFS order so we never starve the queue.
export function findBestWaitlistMatch(
  freedTableCapacity: number,
  waiting: HodWaitlistEntry[],
  nowIso: string = new Date().toISOString(),
): HodWaitlistEntry | null {
  const active = waiting.filter((w) => w.status === "waiting");
  if (active.length === 0 || freedTableCapacity <= 0) return null;
  const nowMs = new Date(nowIso).getTime();
  const minutesWaiting = (w: HodWaitlistEntry) =>
    Math.max(0, Math.floor((nowMs - new Date(w.joinedAt).getTime()) / 60000));

  // 1) Priority override — anyone over the threshold gets next-fit
  const priority = active.filter((w) => minutesWaiting(w) > WAITLIST_PRIORITY_MIN);
  for (const w of priority) {
    if (w.partySize <= freedTableCapacity) return w;
  }
  // 2) Efficient match — pax ≤ cap ≤ pax + 2
  for (const w of active) {
    if (w.partySize <= freedTableCapacity && freedTableCapacity <= w.partySize + 2) return w;
  }
  // 3) Fallback — first FCFS fit (never starve)
  for (const w of active) {
    if (w.partySize <= freedTableCapacity) return w;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 2026-05-20 — DOOR PRICING OVERRIDE (Khushi-requested)
// Singleton doc at appSettings/doorPricing.
//   { priceOverrideEnabled: boolean, updatedAt: ts, updatedBy: string }
// When true, door staff can edit per-walk-in prices (cover / entry-only /
// group / table-4 / vvip-6) to handle Koramangala bargain customers. When
// false (default), prices lock to the event's published values. Manager
// toggles this from Admin → 💰 Door Pricing.
// ═══════════════════════════════════════════════════════════════════════════

export interface DoorPricingSettings {
  priceOverrideEnabled: boolean;
  updatedAt?: any;
  updatedBy?: string;
}

const APP_SETTINGS_COL = "appSettings";
const DOOR_PRICING_DOC = "doorPricing";
// 🛟 2026-05-20 (Khushi bug — "Missing or insufficient permissions"):
// Prod Firestore rules don't allow writes to `appSettings/*`, so the toggle
// failed and stayed OFF. Adding a rule on Khushi's Mac would fix this server-
// side, but in the meantime we dual-write to localStorage so the admin tablet
// still works end-to-end. localStorage is the source of truth for "did this
// tablet flip it?"; Firestore is the source of truth for "did any tablet flip
// it cross-device?". Whichever returns ON, we honor ON (failing-open toward
// the staff's most recent intent on this device).
const DOOR_PRICING_LS_KEY = "hod.doorPricing.priceOverrideEnabled";
const lsGet = (): boolean | null => {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const v = window.localStorage.getItem(DOOR_PRICING_LS_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
    return null;
  } catch { return null; }
};
const lsSet = (v: boolean) => {
  try { if (typeof window !== "undefined" && window.localStorage) window.localStorage.setItem(DOOR_PRICING_LS_KEY, v ? "1" : "0"); } catch {}
};

export function subscribeToDoorPricingSettings(
  cb: (s: DoorPricingSettings) => void
): () => void {
  // Seed from localStorage immediately so the UI doesn't flash OFF→ON.
  const seeded = lsGet();
  if (seeded !== null) cb({ priceOverrideEnabled: seeded });
  try {
    return onSnapshot(
      doc(db, APP_SETTINGS_COL, DOOR_PRICING_DOC),
      (snap) => {
        const data = snap.exists() ? (snap.data() as Partial<DoorPricingSettings>) : {};
        const fsVal = !!data.priceOverrideEnabled;
        const lsVal = lsGet();
        // If both sources exist, OR them (most-recent-intent wins). If only
        // localStorage exists (rules blocked write), honor that.
        const merged = lsVal === null ? fsVal : (fsVal || lsVal);
        cb({ priceOverrideEnabled: merged });
      },
      (err) => {
        // 🛟 Firestore subscription rejected → fall back to localStorage.
        console.warn("[doorPricing] subscribe failed, using localStorage:", err?.message);
        cb({ priceOverrideEnabled: lsGet() ?? false });
      }
    );
  } catch (e: any) {
    console.warn("[doorPricing] subscribe threw, using localStorage:", e?.message);
    cb({ priceOverrideEnabled: lsGet() ?? false });
    return () => {};
  }
}

export async function updateDoorPricingSettings(
  patch: Partial<DoorPricingSettings>,
  updatedBy?: string
): Promise<void> {
  // Always persist locally so the toggle reflects on THIS tablet immediately,
  // even if Firestore rejects (prod rules may not allow appSettings writes).
  if (typeof patch.priceOverrideEnabled === "boolean") {
    lsSet(patch.priceOverrideEnabled);
  }
  try {
    await setDoc(
      doc(db, APP_SETTINGS_COL, DOOR_PRICING_DOC),
      { ...patch, updatedAt: serverTimestamp(), updatedBy: updatedBy || "" },
      { merge: true }
    );
  } catch (e: any) {
    // 🛟 Permission-denied is expected until Khushi deploys the appSettings
    // rule on Mac. Don't throw — localStorage already has the new value, so
    // this tablet works end-to-end. Other tablets won't sync until rules ship.
    const msg = String(e?.message || e || "");
    if (msg.toLowerCase().includes("permission") || msg.toLowerCase().includes("insufficient")) {
      console.warn("[doorPricing] Firestore write blocked by rules (using local only):", msg);
      return;
    }
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 2026-05-31 v3.148 → v3.155 — TABLE COVER PRICING (Khushi-requested CRM)
// Singleton doc at appSettings/tablePricing. Per-TIER per-head weekend cover
// charge read by the CUSTOMER SITE (Fri/Sat/Sun, when enabled).
// v3.155: Ground floor split into PREMIUM (C1–C4) + VVIP (VIP1/VIP2); EVERY tier
// now carries its OWN per-head price AND its OWN cover start time (startMin =
// minutes since midnight; 1260 = 9 PM, 1140 = 7 PM). Doc shape:
//   { enabled:boolean,
//     groundPremium:{price,startMin}, groundVvip:{price,startMin},
//     dining:{price,startMin}, rooftop:{price,startMin},
//     updatedAt: ts, updatedBy: string }
// Back-compat: an OLD doc with flat numeric ground/dining/rooftop still seeds the
// per-tier prices on read (startMin falls back to the 9 PM default).
// Manager edits this from Admin → 🎟️ Table Cover Pricing. Defaults ₹2500/head @
// 9 PM everywhere, enabled.
// 🛟 Dual-writes localStorage like doorPricing so the admin tablet works even
// if prod rules block appSettings writes; fail-open everywhere.
// ═══════════════════════════════════════════════════════════════════════════

export interface TierPricing {
  price: number;
  startMin: number;
}
export interface TablePricingSettings {
  enabled: boolean;
  groundPremium: TierPricing;
  groundVvip: TierPricing;
  dining: TierPricing;
  rooftop: TierPricing;
  // Per-table PRICE overrides (price only; start time stays per-tier). Keyed by
  // table id (C1–C4, VIP1, VIP2). A value of 0 or a missing key means "no override
  // → use the tier price". Customer site reads this first, falls back to tier price.
  tableOverrides?: Record<string, number>;
  updatedAt?: any;
  updatedBy?: string;
}
export type TablePricingTierKey = "groundPremium" | "groundVvip" | "dining" | "rooftop";
// Tables that support a per-table custom price (Ground floor only). Dining & Rooftop
// stay one price each (their tier price). tier = which tier price is the fallback.
export const TABLE_PRICING_OVERRIDE_TABLES: { key: string; label: string; tier: TablePricingTierKey }[] = [
  { key: "C1", label: "C1", tier: "groundPremium" },
  { key: "C2", label: "C2", tier: "groundPremium" },
  { key: "C3", label: "C3", tier: "groundPremium" },
  { key: "C4", label: "C4", tier: "groundPremium" },
  { key: "VIP1", label: "VIP 1", tier: "groundVvip" },
  { key: "VIP2", label: "VIP 2", tier: "groundVvip" },
];

const TABLE_PRICING_DOC = "tablePricing";
const TABLE_PRICING_DEFAULTS: TablePricingSettings = {
  enabled: true,
  groundPremium: { price: 2500, startMin: 1260 },
  groundVvip: { price: 2500, startMin: 1260 },
  dining: { price: 2500, startMin: 1260 },
  rooftop: { price: 2500, startMin: 1260 },
  tableOverrides: {},
};
const TABLE_PRICING_LS_KEY = "hod.tablePricing.v1";

const tpLsGet = (): Partial<TablePricingSettings> | null => {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const v = window.localStorage.getItem(TABLE_PRICING_LS_KEY);
    if (!v) return null;
    const p = JSON.parse(v);
    return p && typeof p === "object" ? p : null;
  } catch { return null; }
};
const tpLsSet = (s: Partial<TablePricingSettings>) => {
  try { if (typeof window !== "undefined" && window.localStorage) window.localStorage.setItem(TABLE_PRICING_LS_KEY, JSON.stringify(s)); } catch {}
};
// Deep-clone defaults so per-tier objects are never shared by reference.
function _tpCloneDefaults(): TablePricingSettings {
  return {
    enabled: TABLE_PRICING_DEFAULTS.enabled,
    groundPremium: { ...TABLE_PRICING_DEFAULTS.groundPremium },
    groundVvip: { ...TABLE_PRICING_DEFAULTS.groundVvip },
    dining: { ...TABLE_PRICING_DEFAULTS.dining },
    rooftop: { ...TABLE_PRICING_DEFAULTS.rooftop },
    tableOverrides: {},
  };
}
function _tpApplyTier(out: TablePricingSettings, key: TablePricingTierKey, src: any) {
  const o = src && src[key];
  if (o && typeof o === "object") {
    if (typeof o.price === "number" && o.price >= 0) out[key].price = o.price;
    if (typeof o.startMin === "number" && o.startMin >= 0) out[key].startMin = o.startMin;
  }
}
// Merge partials over defaults, coercing only valid types (fail-open). Accepts both
// the new structured shape and the legacy flat-number shape (ground/dining/rooftop).
function _tpMerge(...parts: Array<any>): TablePricingSettings {
  const out = _tpCloneDefaults();
  for (const p of parts) {
    if (!p) continue;
    if (typeof p.enabled === "boolean") out.enabled = p.enabled;
    // Legacy flat numbers (old doc shape) seed prices; structured tiers below override.
    if (typeof p.ground === "number" && p.ground >= 0) { out.groundPremium.price = p.ground; out.groundVvip.price = p.ground; }
    if (typeof p.dining === "number" && p.dining >= 0) { out.dining.price = p.dining; }
    if (typeof p.rooftop === "number" && p.rooftop >= 0) { out.rooftop.price = p.rooftop; }
    _tpApplyTier(out, "groundPremium", p);
    _tpApplyTier(out, "groundVvip", p);
    _tpApplyTier(out, "dining", p);
    _tpApplyTier(out, "rooftop", p);
    // Per-table price overrides (price only). Later parts (Firestore) win per-key.
    if (p.tableOverrides && typeof p.tableOverrides === "object") {
      for (const k of Object.keys(p.tableOverrides)) {
        const v = (p.tableOverrides as any)[k];
        if (typeof v === "number" && v >= 0) (out.tableOverrides as any)[k] = v;
      }
    }
  }
  return out;
}

export function subscribeToTablePricingSettings(
  cb: (s: TablePricingSettings) => void
): () => void {
  // Seed from localStorage immediately so the UI doesn't flash defaults.
  const seeded = tpLsGet();
  if (seeded) cb(_tpMerge(seeded));
  try {
    return onSnapshot(
      doc(db, APP_SETTINGS_COL, TABLE_PRICING_DOC),
      (snap) => {
        const data = snap.exists() ? (snap.data() as Partial<TablePricingSettings>) : null;
        // Firestore (cross-device truth) wins; fall back to localStorage, then defaults.
        cb(_tpMerge(tpLsGet(), data));
      },
      (err: any) => {
        console.warn("[tablePricing] subscribe failed, using localStorage:", err?.message);
        cb(_tpMerge(tpLsGet()));
      }
    );
  } catch (e: any) {
    console.warn("[tablePricing] subscribe threw, using localStorage:", e?.message);
    cb(_tpMerge(tpLsGet()));
    return () => {};
  }
}

export async function updateTablePricingSettings(
  patch: Partial<TablePricingSettings>,
  updatedBy?: string
): Promise<void> {
  // Persist locally first so this tablet reflects immediately even if rules block.
  tpLsSet(_tpMerge(tpLsGet(), patch));
  try {
    await setDoc(
      doc(db, APP_SETTINGS_COL, TABLE_PRICING_DOC),
      { ...patch, updatedAt: serverTimestamp(), updatedBy: updatedBy || "" },
      { merge: true }
    );
  } catch (e: any) {
    const msg = String(e?.message || e || "");
    if (msg.toLowerCase().includes("permission") || msg.toLowerCase().includes("insufficient")) {
      console.warn("[tablePricing] Firestore write blocked by rules (using local only):", msg);
      return;
    }
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🍳 KDS — KITCHEN DISPLAY SYSTEM (2026-05-21, Khushi-requested)
// Adds a real-time kitchen screen showing grouped pending food items with a
// BUMP button. When chef bumps, captain/bar tablets get an instant green
// "FOOD READY" banner so they walk once and serve hot.
// Paper KOTs are UNCHANGED — KDS rows are written ALONGSIDE printKOT, never
// replacing it. If KDS write or screen fails, kitchen falls back to paper
// (today's flow). Fail-open per Khushi philosophy.
// Drinks bypass KDS entirely (bar makes them at the bar — same as today).
// ═══════════════════════════════════════════════════════════════════════════

const KDS_COL = "posKDSItems";

export type HodKDSStatus = "pending" | "ready" | "picked_up" | "voided";

export interface HodKDSItem {
  id?: string;
  itemName: string;
  /** Lowercase + trimmed for grouping. E.g. "paneer tikka". */
  itemKey: string;
  qty: number;
  /** Always "food" today (drinks excluded). Future: per-station routing. */
  itemType: string;
  /** Pretty table label for chef display: "T3", "FD2", "BAR". */
  tableLabel: string;
  /** Floor name for chef context. */
  floorLabel: string;
  /** Customer first name for chef context (helps re-fire requests). */
  customerName: string;
  /** Captain/Bartender who fired this. */
  staff: string;
  /** TableReservations doc id — captain tablet listens by this for green flash. */
  reservationId: string;
  /** Covers doc id (bar walk-in flow) — bar tablet listens by this. */
  coverDocId: string;
  /** Back-link to the posKOTs doc so reports can join. */
  kotId: string;
  /** Round number on that table — chef uses to spot re-fires. */
  roundNum: number;
  /** Status lifecycle. */
  status: HodKDSStatus;
  firedAt?: any;
  readyAt?: any;
  readyBy?: string;
  pickedUpAt?: any;
  pickedUpBy?: string;
  /** Operational-night stamp for end-of-night reports + auto-cleanup. */
  opNight?: string;
}

function normalizeItemKey(name: string): string {
  return (name || "").toLowerCase().trim().replace(/\s+/g, " ");
}

/** Writes one KDS row PER food line on a KOT. Called AFTER printKOT succeeds
 *  from Captain Mode + Bar Mode. Drinks are silently skipped (bar handles
 *  those). Idempotent via stable doc id (resId/coverId + roundNum + itemIdx)
 *  so a re-fire never duplicates KDS rows. Best-effort try/catch — if KDS
 *  write fails, paper KOT already printed and kitchen works the old way. */
export async function writeKDSItemsFromKOT(input: {
  reservationId?: string;
  coverDocId?: string;
  kotId?: string;
  tableId: string;
  tableLabel?: string;
  floorLabel?: string;
  customerName?: string;
  staff: string;
  roundNum: number;
  items: HodOrderItem[];
}): Promise<number> {
  try {
    const foodOnly = (input.items || []).filter((i) => (i.t || "").toLowerCase() === "food");
    if (foodOnly.length === 0) return 0;
    const opNight = getOperationalNightStr();
    const idBase = input.reservationId || input.coverDocId || `${input.tableId}_${Date.now()}`;
    let written = 0;
    for (let idx = 0; idx < foodOnly.length; idx++) {
      const it = foodOnly[idx];
      const stableId = `${idBase}_r${input.roundNum}_i${idx}_${normalizeItemKey(it.n).slice(0, 24).replace(/[^a-z0-9]/g, "")}`;
      try {
        await setDoc(doc(db, KDS_COL, stableId), {
          itemName: it.n,
          itemKey: normalizeItemKey(it.n),
          qty: it.qty || 1,
          itemType: "food",
          tableLabel: input.tableLabel || input.tableId || "—",
          floorLabel: input.floorLabel || "",
          customerName: input.customerName || "",
          staff: input.staff,
          reservationId: input.reservationId || "",
          coverDocId: input.coverDocId || "",
          kotId: input.kotId || "",
          roundNum: input.roundNum,
          status: "pending" as HodKDSStatus,
          firedAt: serverTimestamp(),
          opNight,
        });
        written++;
      } catch (e) {
        console.warn("[KDS] write skipped (will fall back to paper)", e);
      }
    }
    return written;
  } catch (e) {
    console.warn("[KDS] writeKDSItemsFromKOT failed", e);
    return 0;
  }
}

/** Kitchen tablet subscribes to all non-bumped items for today.
 *  🛟 NOTE: single-field `where` only — NO orderBy on firedAt. The composite
 *  index (status + firedAt) is NOT deployed and would silently break the
 *  whole subscription (kitchen would forever show "ALL CLEAR" even when KOTs
 *  fire). Sorting is done client-side in KitchenMode.tsx instead. */
export function subscribeToActiveKDSItems(
  cb: (items: HodKDSItem[]) => void
): Unsubscribe {
  const q = query(
    collection(db, KDS_COL),
    where("status", "==", "pending"),
    limit(200)
  );
  return onSnapshot(
    q,
    (snap) => {
      const items: HodKDSItem[] = [];
      snap.forEach((d) => items.push({ id: d.id, ...(d.data() as any) }));
      // Client-side sort: oldest fired first (matches the dropped orderBy asc).
      items.sort((a, b) => {
        const ta = a.firedAt?.toMillis ? a.firedAt.toMillis() : 0;
        const tb = b.firedAt?.toMillis ? b.firedAt.toMillis() : 0;
        return ta - tb;
      });
      cb(items);
    },
    (err) => {
      console.warn("[KDS] active subscribe failed", err);
      cb([]);
    }
  );
}

/** Captain/Bar tablets subscribe to all READY items so green-flash banners
 *  can render on the matching table card or bar cover row.
 *  🛟 Same composite-index avoidance as subscribeToActiveKDSItems above. */
export function subscribeToReadyKDSItems(
  cb: (items: HodKDSItem[]) => void
): Unsubscribe {
  const q = query(
    collection(db, KDS_COL),
    where("status", "==", "ready"),
    limit(100)
  );
  return onSnapshot(
    q,
    (snap) => {
      const items: HodKDSItem[] = [];
      snap.forEach((d) => items.push({ id: d.id, ...(d.data() as any) }));
      // Client-side sort: newest ready first (matches the dropped orderBy desc).
      items.sort((a, b) => {
        const ta = a.readyAt?.toMillis ? a.readyAt.toMillis() : 0;
        const tb = b.readyAt?.toMillis ? b.readyAt.toMillis() : 0;
        return tb - ta;
      });
      cb(items);
    },
    (err) => {
      console.warn("[KDS] ready subscribe failed", err);
      cb([]);
    }
  );
}

/** Chef taps BUMP on one item. */
export async function bumpKDSItem(id: string, chef: string): Promise<void> {
  await updateDoc(doc(db, KDS_COL, id), {
    status: "ready" as HodKDSStatus,
    readyAt: serverTimestamp(),
    readyBy: chef,
  });
}

/** Chef taps BUMP ALL on a grouped card → bump every item with that itemKey. */
export async function bumpKDSGroup(ids: string[], chef: string): Promise<{ ok: number; fail: number }> {
  let ok = 0, fail = 0;
  for (const id of ids) {
    try { await bumpKDSItem(id, chef); ok++; } catch { fail++; }
  }
  return { ok, fail };
}

/** Captain/Bar taps ✓ PICKED UP — clears the green banner. */
export async function markKDSPickedUp(id: string, by: string): Promise<void> {
  try {
    await updateDoc(doc(db, KDS_COL, id), {
      status: "picked_up" as HodKDSStatus,
      pickedUpAt: serverTimestamp(),
      pickedUpBy: by,
    });
  } catch (e) {
    console.warn("[KDS] pickup failed", e);
  }
}

/** Recall a bumped item (chef hit BUMP by mistake — 60-sec undo). */
export async function recallKDSItem(id: string): Promise<void> {
  try {
    await updateDoc(doc(db, KDS_COL, id), {
      status: "pending" as HodKDSStatus,
      readyAt: null,
      readyBy: null,
    });
  } catch (e) {
    console.warn("[KDS] recall failed", e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 2026-05-28 v3.138 — TABLE QR → CALL CAPTAIN (no-payment ordering)
// ═══════════════════════════════════════════════════════════════════════════
// Walk-in customers scan a per-table QR sticker → land on hodclub.in/table.html?id=FD5
// → fill name/phone (email optional) → browse menu read-only → tap PLACE ORDER
// → writes a doc here → captain's tablet shows a floating BANNER + chime.
// 
// Separate from `customerCallRequest` (which lives on cover docs) because
// walk-ins have no cover. ONE collection, TWO event types so captain side has
// a single subscription to manage.
//
// 🛟 FAIL-OPEN: create returns boolean; subscribe → [] on error; acknowledge
// → swallows errors (worst case banner stays + captain re-taps).
// ═══════════════════════════════════════════════════════════════════════════
export const TABLE_CALL_REQUESTS_COL = "tableCallRequests";

export interface HodTableCallRequest {
  id: string;
  tableId: string;                    // "FD5", "C2", "TVIP3"
  type: "call_waiter" | "place_order";
  customerName: string;
  customerPhone: string;
  customerEmail?: string;             // optional
  items: Array<{ name: string; qty: number; price?: number; category?: string }>;
  status: "pending" | "acknowledged";
  createdAt: string;                  // ISO
  operationalNight: string;           // YYYY-MM-DD via getOperationalNightStr
  acknowledgedBy?: string | null;
  acknowledgedAt?: string | null;
}

/** Customer-side writer (used by hodclub.in/table.html). Returns true on success. */
export async function createTableCallRequest(
  tableId: string,
  type: "call_waiter" | "place_order",
  customerName: string,
  customerPhone: string,
  items: Array<{ name: string; qty: number; price?: number; category?: string }>,
  customerEmail?: string,
): Promise<boolean> {
  try {
    await authReady;
    await addDoc(collection(db, TABLE_CALL_REQUESTS_COL), {
      tableId: String(tableId || "").toUpperCase().trim(),
      type,
      customerName: String(customerName || "").trim().slice(0, 60),
      customerPhone: String(customerPhone || "").trim().slice(0, 20),
      customerEmail: String(customerEmail || "").trim().slice(0, 80),
      items: (items || []).slice(0, 40).map((it) => ({
        name: String(it.name || "").slice(0, 80),
        qty: Math.max(1, Math.min(99, Number(it.qty) || 1)),
        ...(typeof it.price === "number" ? { price: it.price } : {}),
        ...(it.category ? { category: String(it.category).slice(0, 30) } : {}),
      })),
      status: "pending",
      createdAt: new Date().toISOString(),
      operationalNight: getOperationalNightStr(),
      acknowledgedBy: null,
      acknowledgedAt: null,
    });
    return true;
  } catch (e) {
    console.warn("[createTableCallRequest] failed", e);
    return false;
  }
}

/** Captain-side live feed of PENDING table calls for tonight. Shared listener. */
export function subscribeTableCallRequests(
  cb: (rows: HodTableCallRequest[]) => void,
): Unsubscribe {
  const night = getOperationalNightStr();
  return _shareSubscription<HodTableCallRequest[]>(
    `tcr:${night}`,
    (push) => onSnapshot(
      query(
        collection(db, TABLE_CALL_REQUESTS_COL),
        where("operationalNight", "==", night),
        where("status", "==", "pending"),
      ),
      (snap) => push(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<HodTableCallRequest, "id">) }))),
      (err) => { console.warn("[subscribeTableCallRequests] error", err); push([]); },
    ),
    cb,
  );
}

/** Captain taps ACKNOWLEDGE → flips status, banner row disappears. Fail-open. */
export async function acknowledgeTableCallRequest(
  id: string,
  staffName: string,
): Promise<void> {
  if (!id) return;
  try {
    await updateDoc(doc(db, TABLE_CALL_REQUESTS_COL, id), {
      status: "acknowledged",
      acknowledgedBy: String(staffName || "").slice(0, 60),
      acknowledgedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("[acknowledgeTableCallRequest] failed (non-fatal)", e);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 🆕 2026-05-28 v3.140 — DIGITORY (DigiPoS) item-code mapping.
// ─────────────────────────────────────────────────────────────────────
// Digitory's POS engine identifies items by numeric `item_number`. HOD
// stores items by slug(name) (`menuOverrideKey`). To push closed bills
// from HOD → Digitory via their internal /sale/* REST API, we need a
// mapping table keyed by HOD slug → Digitory item_number (+ optional
// modifier codes, tax class, category code — extensible).
//
// Collection: `digitoryItemMap/{hodSlug}` (slug from menuOverrideKey).
// 🛟 FAIL-OPEN: subscribe returns {} on error; upsert errors surface to
// the admin UI as a banner — never silently lost.
// ═══════════════════════════════════════════════════════════════════════
const DIGITORY_MAP_COL = "digitoryItemMap";

export interface DigitoryItemMapping {
  hodSlug: string;            // = menuOverrideKey(name) — primary key
  hodName: string;            // human-readable copy for audit
  digitoryItemNumber: string; // Digitory's numeric item_number (string-safe)
  digitoryCategoryCode?: string;
  digitoryTaxClass?: string;
  notes?: string;
  updatedBy?: string;
  updatedAt?: Timestamp;
}

export function subscribeToDigitoryMappings(
  cb: (byHodSlug: Record<string, DigitoryItemMapping>) => void,
): Unsubscribe {
  try {
    return onSnapshot(
      collection(db, DIGITORY_MAP_COL),
      (snap) => {
        const out: Record<string, DigitoryItemMapping> = {};
        snap.forEach((d) => {
          const data = d.data() as DigitoryItemMapping;
          out[d.id] = { ...data, hodSlug: d.id };
        });
        cb(out);
      },
      (err) => {
        console.warn("[digitoryItemMap] subscribe error (returning empty):", err.message);
        cb({});
      },
    );
  } catch (err) {
    console.warn("[digitoryItemMap] subscribe threw (returning empty):", err);
    cb({});
    return () => {};
  }
}

export async function upsertDigitoryMapping(
  hodSlug: string,
  patch: Partial<Omit<DigitoryItemMapping, "hodSlug" | "updatedAt">>,
  updatedBy: string,
): Promise<void> {
  if (!hodSlug) throw new Error("hodSlug required");
  await setDoc(
    doc(db, DIGITORY_MAP_COL, hodSlug),
    { ...patch, hodSlug, updatedBy, updatedAt: serverTimestamp() },
    { merge: true },
  );
}

export async function deleteDigitoryMapping(hodSlug: string): Promise<void> {
  if (!hodSlug) return;
  await deleteDoc(doc(db, DIGITORY_MAP_COL, hodSlug));
}
