import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc,
  onSnapshot, query, where, orderBy, limit, increment, arrayUnion,
  serverTimestamp, runTransaction, type Unsubscribe,
} from "firebase/firestore";
import { db, authReady } from "./firebase";
import { getOperationalNightStr, getCoverExpiryFor } from "./utils-pos";

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

export interface HodTabRound {
  roundNum: number;
  items: HodOrderItem[];
  roundTotal: number;
  status: "preparing" | "activated" | "served";
  placedAt?: string;
  activatedBy?: string;
  activatedAt?: string;
  placedBy?: string;
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
}

export interface HodTableReservation {
  _docId: string;
  tableId: string;
  floor?: string;
  floorLabel?: string;
  date: string;
  customerName?: string;
  phone?: string;
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
  needsManualReview?: boolean;
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
  return onSnapshot(collection(db, EVENTS_COL), (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() } as HodEvent));
    list.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    cb(list);
  }, () => cb([]));
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
  { value: "eazydiner", label: "EazyDiner", discount: 15 },
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
  if (amount > 5000) throw new Error("Cover amount cannot exceed ₹5,000");
  const bookingId = booking.id || booking.ref;
  if (!bookingId) throw new Error("Booking has no id/ref");
  const docId = coverDocIdFor(bookingId);
  const ref = doc(db, COVERS_COL, docId);

  const existing = await getDoc(ref);
  if (existing.exists()) throw new Error("Cover already activated for this booking");

  const isCash = booking.paymentId && booking.paymentId.startsWith("cash_");
  const paidOnline = isCash ? 0 : (booking.total || 0);
  const diff = Math.max(0, amount - paidOnline);
  const today = getOperationalNightStr();
  const expDate = getCoverExpiryFor(today);

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
    source: "walkin_door_cover",
  };
  await setDoc(ref, cover);

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

  // Race-safe atomic create: if another tap/device beat us, the txn read sees the
  // existing doc and we no-op. No TOCTOU window between getDoc + setDoc.
  const created = await runTransaction(db, async (txn) => {
    const snap = await txn.get(ref);
    if (snap.exists()) return false;
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
      activatedAt: new Date().toISOString(),
      activatedBy: input.staffName,
      transactions: [],
      expiresAt: expDate.toISOString(),
      checkedIn: true,
      actualArrivalTime: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
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

export async function editCoverAmount(coverId: string, newAmount: number, staffName: string): Promise<void> {
  if (newAmount > 5000) throw new Error("Cover amount cannot exceed ₹5,000");
  const ref = doc(db, COVERS_COL, coverId);
  await runTransaction(db, async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists()) throw new Error("Cover not found");
    const data = snap.data();
    const used = data.coverUsed || 0;
    const oldAmount = data.coverActivated || 0;
    if (newAmount < used) throw new Error(`Amount cannot be less than ₹${used} (already used)`);
    const newBal = newAmount - used;
    txn.update(ref, {
      coverActivated: newAmount,
      coverBalance: Math.max(0, newBal),
      transactions: arrayUnion({
        amount: newAmount, oldAmount, note: `Edit: ₹${oldAmount}→₹${newAmount}`,
        timestamp: new Date().toISOString(), type: "edit", staff: staffName,
      } as HodTransaction),
    });
  });
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
  const snap = await getDocs(collection(db, COVERS_COL));
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
    if ((cv.name || "").toLowerCase().includes(q) || (cv.phone || "").includes(q)) results.push(cv);
  });
  return results;
}

export type RechargeMethod = "cash" | "upi" | "card" | "split";
export interface RechargeSplit { cash?: number; upi?: number; card?: number; }

export async function rechargeCover(
  coverId: string, amount: number, method: RechargeMethod, staffName: string,
  split?: RechargeSplit
): Promise<number> {
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
  const tx: HodTransaction = {
    amount, note, timestamp: new Date().toISOString(),
    type: txType, staff: staffName,
    ...(method === "split" && split ? { split } : {}),
  } as HodTransaction;
  const newBal = await runTransaction(db, async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists()) throw new Error("Cover not found");
    const data = snap.data();
    const bal = (data.coverBalance || 0) + amount;
    txn.update(ref, {
      coverBalance: bal,
      coverActivated: (data.coverActivated || 0) + amount,
      topUpTotal: (data.topUpTotal || 0) + amount,
      transactions: arrayUnion(tx),
    });
    return bal;
  });
  return newBal;
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
      txn.update(ref, { tabRounds: rounds, pendingOrder: null });
      return { roundTotal: 0, removed: true };
    }
    const roundTotal = computeHodBreakdown(cleaned).grandTotal;
    const prevItems = rounds[idx].items || [];
    const editHistory = (rounds[idx] as { editHistory?: unknown[] }).editHistory || [];
    rounds[idx] = {
      ...rounds[idx],
      items: cleaned.map((it) => ({ n: it.n, p: it.p, qty: it.qty, cat: it.cat || "", t: it.t || "drink", v: it.v })),
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

  const result = await runTransaction(db, async (txn) => {
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
              items: items.map((it) => ({ n: it.n, p: it.p, qty: it.qty, cat: it.cat || "" })), roundTotal: total }
          : r
      );
    } else {
      updRounds = [
        ...freshRounds,
        {
          roundNum: freshRounds.length + 1,
          items: items.map((it) => ({ n: it.n, p: it.p, qty: it.qty, cat: it.cat || "" })),
          roundTotal: total, status: "activated" as const,
          placedAt: now, activatedBy: staffName, activatedAt: now, placedBy: staffName,
        },
      ];
    }

    txn.update(ref, {
      coverBalance: freshNewBal, coverUsed: (fd.coverUsed || 0) + total, pendingOrder: null,
      lastActivatedAt: now, lastActivatedBy: staffName,
      transactions: arrayUnion(tx), tabRounds: updRounds,
    });
    return { newBalance: freshNewBal, updatedRounds: updRounds };
  });
  return result;
}

export function subscribeToHodReservations(
  date: string, cb: (reservations: HodTableReservation[]) => void
): Unsubscribe {
  const q = query(collection(db, TABLE_RES_COL), where("date", "==", date));
  return onSnapshot(q, (snap) => {
    const all: HodTableReservation[] = [];
    snap.forEach((d) => all.push({ _docId: d.id, ...d.data() } as HodTableReservation));
    all.sort((a, b) => (a.arrivalTime || "").localeCompare(b.arrivalTime || ""));
    cb(all);
  }, () => cb([]));
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

export async function markRoundServed(docId: string, roundIndex: number, bookingRef?: string): Promise<void> {
  const snap = await getDoc(doc(db, TABLE_RES_COL, docId));
  if (!snap.exists()) throw new Error("Reservation not found");
  const rounds = [...(snap.data().tabRounds || [])];
  if (rounds[roundIndex]) rounds[roundIndex].status = "served";
  await updateDoc(doc(db, TABLE_RES_COL, docId), { tabRounds: rounds });
  if (bookingRef) {
    const cs = await getDoc(doc(db, COVERS_COL, bookingRef));
    if (cs.exists()) {
      const cr = [...(cs.data().tabRounds || [])];
      if (cr[roundIndex]) cr[roundIndex].status = "served";
      await updateDoc(doc(db, COVERS_COL, bookingRef), { tabRounds: cr });
    }
  }
}

export async function updateRoundItems(
  docId: string, roundIndex: number, items: HodOrderItem[], roundTotal: number, editedBy?: string
): Promise<void> {
  const snap = await getDoc(doc(db, TABLE_RES_COL, docId));
  if (!snap.exists()) throw new Error("Reservation not found");
  const data = snap.data();
  if (data.paymentStatus === "paid") throw new Error("Cannot edit orders on a paid table");
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
  },
  bookingRef?: string
): Promise<void> {
  const upd: Record<string, unknown> = {
    paymentStatus: "paid", paymentMode: payment.method, amountPaid: payment.amount,
    paidAt: new Date().toISOString(), captainName: payment.captainName,
  };
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
  if (bookingRef) await setDoc(doc(db, COVERS_COL, bookingRef), upd, { merge: true }).catch(() => {});
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
  }> = [];
  snap.forEach((d) => {
    const data = d.data() as Record<string, unknown>;
    if (data.kind === "bill") return; // bills come through getRecentBillPrints
    const items = Array.isArray(data.items) ? data.items as Array<{ qty?: number }> : [];
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
  if (data.paymentStatus === "paid") throw new Error("Cannot change source on a paid table");
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
}
export async function getRecentBillPrints(maxRows = 200): Promise<BillAuditRow[]> {
  const rows: BillAuditRow[] = [];
  // Wallets
  const coverSnap = await getDocs(collection(db, COVERS_COL));
  coverSnap.forEach((d) => {
    const data = d.data() as HodCover & { id?: string };
    const log = data.walletBillPrintLog;
    if (!Array.isArray(log) || log.length === 0) return;
    log.forEach((e, i) => {
      rows.push({
        at: e.at, source: "wallet", docId: d.id,
        ref: (data.ref || d.id).toUpperCase(), customerName: data.name || "",
        by: e.by, total: e.total, itemCount: e.itemCount,
        isDuplicate: e.isDuplicate, billNumber: e.billNumber, printIndex: i + 1,
      });
    });
  });
  // Table reservations
  const tableSnap = await getDocs(collection(db, TABLE_RES_COL));
  tableSnap.forEach((d) => {
    const data = d.data() as HodTableReservation;
    const log = data.billPrintLog;
    if (!Array.isArray(log) || log.length === 0) return;
    log.forEach((e: typeof log[number] & { itemCount?: number }, i) => {
      rows.push({
        at: e.at, source: "table", docId: d.id,
        ref: (data.tableId || d.id).toUpperCase(), customerName: data.customerName || "",
        by: e.by, total: e.total, itemCount: e.itemCount ?? 0,
        isDuplicate: e.isDuplicate, billNumber: e.billNumber, printIndex: i + 1,
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

export async function recordWalletBillPrint(
  coverId: string,
  entry: { by: string; total: number; itemCount: number; billNumberBase: string }
): Promise<{ count: number; isDuplicate: boolean; billNumber: string }> {
  const ref = doc(db, COVERS_COL, coverId);
  return await runTransaction(db, async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists()) throw new Error("Wallet not found");
    const data = snap.data();
    const prev = (data.walletBillPrintCount as number) || 0;
    const next = prev + 1;
    const isDuplicate = prev > 0;
    const billNumber = `${entry.billNumberBase}-${next}`;
    const now = new Date().toISOString();
    const log = Array.isArray(data.walletBillPrintLog) ? [...data.walletBillPrintLog] : [];
    log.push({ at: now, by: entry.by, total: entry.total,
      itemCount: entry.itemCount, isDuplicate, billNumber });
    const upd: Record<string, unknown> = {
      walletBillPrintCount: next,
      lastWalletBillPrintedAt: now,
      walletBillPrintLog: log,
    };
    if (prev === 0) upd.walletBillFirstPrintedAt = now;
    txn.update(ref, upd);
    return { count: next, isDuplicate, billNumber };
  });
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
  aggregator = "inhouse", aggregatorDiscount = 0
): Promise<string> {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const arrTime = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const ref = `WALK-${tableId}-${Date.now().toString(36).toUpperCase()}`;

  const q2 = query(collection(db, TABLE_RES_COL), where("tableId", "==", tableId), where("date", "==", date), limit(1));
  const existing = await getDocs(q2);
  if (!existing.empty) throw new Error(`Table ${tableId} is already occupied today`);

  const d = doc(db, TABLE_RES_COL, ref);
  await setDoc(d, {
    tableId, floor, floorLabel, date, customerName, phone: phone || "",
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
    await setDoc(doc(db, COVERS_COL, bookingRef), {
      notificationStatus: outcome.status,
      notificationDetails: outcome,
      notificationAt: serverTimestamp(),
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
  tier?: string;             // e.g. "Stag", "Couple", "Ladies"
  type?: string;             // mirrors customer-site `type` field
  eventId?: string;
  eventTitle?: string;
  partySize?: number;        // for group/VIP table flows
  tableType?: string;        // "VIP", "Standard" etc — group flow only
  notes?: string;
  staffName: string;
}): Promise<{ ref: string }> {
  const { kind, name, email, phone, guests, total, tier, type, eventId, eventTitle,
    partySize, tableType, notes, staffName } = input;
  if (!name?.trim()) throw new Error("Enter customer name");
  if (!phone?.trim()) throw new Error("Enter phone number");

  const ref = `WI-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000).toString(36).toUpperCase()}`;
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
    paymentMethod: total > 0 ? "cash_door" : "comp_door",
    paymentId: total > 0 ? `cash_${ref}` : `comp_${ref}`,
    paidAt: new Date().toISOString(),
    bookedAt: new Date().toISOString(),
    createdAt: serverTimestamp(),
    isWalkIn: true,
    walkInBy: staffName,
    source: "walkin",
    notes: notes || "",
    status: "confirmed",
  };
  if (entryType) docPayload.entryType = entryType;
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

  const ref = `GL-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000).toString(36).toUpperCase()}`;
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
    createdAt: serverTimestamp(),
    isWalkIn: true,
    walkInBy: staffName,
    source: "walkin",
  });
  return { ref };
}

export async function createAggregatorTableBooking(input: {
  aggregator: string;          // "zomato" | "swiggy-dineout" | "swiggy-scenes" | "eazydiner"
  discountPercent?: number;    // override aggregator default if door staff agrees a different %
  customerName: string;
  phone: string;
  partySize: number;
  date: string;                // YYYY-MM-DD
  arrivalTime: string;         // "HH:MM" or e.g. "10:30 PM"
  tableId?: string;            // optional — leave blank if not yet assigned
  floor?: string;
  floorLabel?: string;
  externalRef?: string;        // e.g. Zomato booking ID, if known
  notes?: string;
  staffName: string;
}): Promise<string> {
  const { aggregator, discountPercent, customerName, phone, partySize, date, arrivalTime,
    tableId, floor, floorLabel, externalRef, notes, staffName } = input;
  if (!aggregator || aggregator === "inhouse") throw new Error("Pick an aggregator");
  if (!customerName?.trim()) throw new Error("Enter customer name");
  if (!date) throw new Error("Pick a date");

  // If a table was assigned, ensure it's free for that date
  if (tableId) {
    const q2 = query(collection(db, TABLE_RES_COL), where("tableId", "==", tableId), where("date", "==", date), limit(1));
    const existing = await getDocs(q2);
    if (!existing.empty) throw new Error(`Table ${tableId} is already booked on ${date}`);
  }

  const aggShort = aggregator.split("-")[0].toUpperCase();
  const ref = `${aggShort}-MAN-${Date.now().toString(36).toUpperCase()}`;
  const aggDiscount = (discountPercent !== undefined && discountPercent >= 0)
    ? discountPercent
    : getAggregatorDiscount(aggregator);

  await setDoc(doc(db, TABLE_RES_COL, ref), {
    tableId: tableId || "",
    floor: floor || "",
    floorLabel: floorLabel || "",
    date,
    customerName: customerName.trim(),
    phone: (phone || "").replace(/\D/g, "").slice(-10),
    partySize: partySize || 2,
    arrivalTime,
    bookingRef: ref,
    bookedAt: new Date().toISOString(),
    source: aggregator,
    aggregator,
    aggregatorDiscount: aggDiscount,
    externalRef: externalRef || "",
    notes: notes || "",
    tabRounds: [],
    tabTotal: 0,
    status: "confirmed",
    createdBy: staffName,
    isManualAggregatorEntry: true,
  });
  return ref;
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
  if (data.paymentStatus === "paid") throw new Error("Cannot reassign a paid table");
  const date = data.date || getOperationalNightStr();
  const oldTableId = data.tableId;
  const q2 = query(collection(db, TABLE_RES_COL), where("tableId", "==", newTableId), where("date", "==", date), limit(1));
  const existing = await getDocs(q2);
  if (!existing.empty) throw new Error(`Table ${newTableId} is already occupied`);
  await updateDoc(doc(db, TABLE_RES_COL, docId), {
    tableId: newTableId, floor: newFloor, floorLabel: newFloorLabel,
    reassignedFrom: oldTableId, reassignedAt: new Date().toISOString(), reassignedBy: captainName,
  });
}

export async function createProxyTable(
  proxyName: string, floor: string, floorLabel: string,
  customerName: string, phone: string, partySize: number, captainName: string,
  aggregator = "inhouse", aggregatorDiscount = 0
): Promise<string> {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const arrTime = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const ref = `PROXY-${proxyName.replace(/\s+/g, "-")}-${Date.now().toString(36).toUpperCase()}`;
  const d = doc(db, TABLE_RES_COL, ref);
  await setDoc(d, {
    tableId: proxyName, floor, floorLabel, date, customerName, phone: phone || "",
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
    if (data.paymentStatus === "paid") throw new Error("Cannot add orders to a paid table");
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
  });
}

export async function releaseTable(
  docId: string, reservation: HodTableReservation, captainName: string
): Promise<void> {
  const archive: Record<string, unknown> = {};
  Object.keys(reservation).forEach((k) => { if (k !== "_docId") archive[k] = (reservation as any)[k]; });
  archive.releasedAt = new Date().toISOString();
  archive.sessionDuration = reservation.bookedAt
    ? Math.round((Date.now() - new Date(reservation.bookedAt).getTime()) / 60000) : null;
  archive.captainName = captainName;
  await addDoc(collection(db, TABLE_HISTORY_COL), archive);
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
  const q1 = query(collection(db, BOOKINGS_COL), where("ref", "==", ref), limit(1));
  const s1 = await getDocs(q1);
  if (!s1.empty) return { id: s1.docs[0].id, ...s1.docs[0].data() } as HodBooking;

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
  if (glDoc.exists()) return { id: glDoc.id, ...glDoc.data(), _isGuestList: true } as HodBooking;
  return null;
}

export function subscribeToBookings(cb: (bookings: HodBooking[]) => void): Unsubscribe {
  return onSnapshot(collection(db, BOOKINGS_COL), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() } as HodBooking)));
  }, () => cb([]));
}

export function subscribeToGuestlist(cb: (guests: HodGuestlistEntry[]) => void): Unsubscribe {
  return onSnapshot(collection(db, GUESTLIST_COL), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() } as HodGuestlistEntry)));
  }, () => cb([]));
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
