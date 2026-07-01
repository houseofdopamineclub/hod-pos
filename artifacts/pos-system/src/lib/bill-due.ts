// 💸 BILL DUE — Bar Mode helper for "pay later" / NC (No Charge with overage)
// orders. When the bartender uses the NC button, the FIRST food + FIRST drink
// item are comped; the rest get logged here, WhatsApp goes out to the guest,
// and Manager PIN is required later to mark them cleared.
//
// Also exposes a per-operational-night token generator so EVERY KOT printed
// from the bar carries a "TOKEN: T-007" header and the matching Bill chit
// carries the SAME token — runners + cashier can pair them at a glance even
// during 1500-booking-night chaos.
//
// FAIL-OPEN PHILOSOPHY (Khushi house rule):
//   – WhatsApp send is fire-and-forget. If the customer's phone is bad / API
//     down, the bill is STILL logged → no revenue lost.
//   – If localStorage is sandboxed (private window), token falls back to a
//     short timestamp suffix → unique enough for one night.
//
// Khushi UX: ALL-CAPS labels. ONE STEP AT A TIME.

import {
  addDoc, collection, doc, getDocs, onSnapshot, orderBy, query,
  runTransaction, serverTimestamp, updateDoc, where,
} from "firebase/firestore";
import { db } from "./firebase";
import { getOperationalNightStr } from "./utils-pos";
import { computeHodBreakdown, type HodOrderItem } from "./firestore-hod";

// 🆕 2026-05-27 v3.115 — MANAGER added to the role list (Khushi: floor
// managers eat/drink on the house too; need their own audit bucket).
export type NcRole = "DJ" | "OWNER" | "INFLUENCER" | "PROMOTER" | "MANAGER" | "OTHER";

// 🆕 2026-06-30 (Khushi NC rework) — the TYPE of NC entry. Replaces the old
// single "first ₹1000 comp + charge overage" model with 3 explicit kinds, ALL
// Manager-PIN gated:
//   • "comp"    — pure give-away, MAX ₹1000, NO SC/GST, NEVER in Net/Gross.
//                 Over ₹1000 is BLOCKED (use billdue instead). The
//                 "Complimentary" payment option lives here (influencer comps).
//   • "billdue" — REAL chargeable bill, full SC+GST, COUNTS in Net/Gross/GST on
//                 the night punched. PERSISTENT cross-day per-person running tab
//                 (rounds[] keep adding across nights; partial payments[] until
//                 the balance is cleared).
//   • "owner"   — owner consumption, item price only (NO SC/GST), NEVER in
//                 Net/Gross, with a "Waive off" to zero it. Own dashboard tab.
// Legacy rows (pre-v3.4xx) omit `kind` → treated as the old comp+overage model.
export type NcKind = "comp" | "billdue" | "owner";

// 🆕 2026-05-27 v3.115 — payment method captured on settlement so the
// morning report can split NC RECOVERED (cash/upi/card) vs NC WAIVED
// (manager wrote it off). Optional for back-compat with v3.114 rows.
// 🆕 2026-06-30 — "salary" (NC bill due cleared from staff salary) + a marker
// "complimentary" (NC comp give-away) added.
export type NcPaymentMethod = "cash" | "upi" | "card" | "waived" | "salary" | "complimentary";

/** 🆕 2026-06-30 — one round punched onto a PERSISTENT NC BILL DUE tab. Each
 *  round is stamped with the operational night it was ordered so the Sales
 *  report can recognise the sale (Net/Gross/SC/GST) on the CONSUMPTION night
 *  even though the guest may pay days later. */
export interface NcRound {
  night: string;            // operationalNight this round was punched
  at: string;               // ISO timestamp
  items: BillDueItem[];
  subtotal: number;
  serviceCharge: number;
  tax: number;              // GST (₹)
  total: number;            // tax-inclusive grand total for this round
  note?: string | null;
  by?: string | null;       // staff who punched the round
}

/** 🆕 2026-06-30 — a PARTIAL (or full) payment against an NC BILL DUE tab.
 *  Stamped with the night it was collected so the "payment methods collected"
 *  pie counts the real tender on the PAY night, not the consumption night. */
export interface NcPayment {
  amount: number;
  method: NcPaymentMethod;
  at: string;               // ISO timestamp
  by: string;               // staff who took the payment
  night: string;            // operationalNight the payment was collected
}

export interface BillDueItem {
  n: string;        // item name
  p: number;        // unit price (₹)
  qty: number;
  t?: "food" | "drink";
  free?: boolean;   // true for the 2 comped lines (1 food + 1 drink)
}

export interface BillDueDoc {
  id?: string;
  operationalNight: string;
  customerName: string;
  customerPhone: string;
  role: NcRole;
  approvedBy: string;
  items: BillDueItem[];
  /** Sum of NON-FREE items only (the amount actually owed). */
  amountDue: number;
  staff: string;
  /** 🆕 2026-07-01 (Khushi) — employee id of the logged-in staff who opened a
   *  captain BILL DUE (staff friends & family) tab, for salary-deduction
   *  attribution. Null/absent on bar-NC-opened rows. */
  staffEmployeeId?: string | null;
  status: "open" | "cleared" | "voided";
  createdAt?: { seconds: number; nanoseconds: number } | null;
  clearedAt?: string | null;
  clearedBy?: string | null;
  /** 🆕 v3.115 — how the guest paid when settling. `waived` = manager wrote it
   *  off (still needs Manager PIN). Reports tab buckets by this. */
  paymentMethod?: NcPaymentMethod | null;
  /** 🆕 v3.120 — bartender-applied discount on this row at clear time.
   *  0–50 is bartender-only; >50 needs Manager PIN. WAIVE = 100. */
  discountPct?: number | null;
  /** 🆕 v3.120 — amount actually collected after discount (₹). */
  finalAmount?: number | null;
  token?: string | null;
  /** 🆕 v3.184 — flat NC comp applied to THIS tab (₹, capped at ₹1000 per
   *  guest per night). Replaces the old per-item `free` 1-drink+1-food model.
   *  amountDue = (gross of all items) − compApplied. Legacy rows omit this
   *  and fall back to summing `free` line values. */
  compApplied?: number | null;
  /** 🆕 2026-06-24 (Khushi) — NC tabs now carry SERVICE CHARGE + GST like every
   *  other bill. These persist the tax breakdown so the settle modal, reports
   *  and WhatsApp can show it. `totalBill` = tax-INCLUSIVE grand total (subtotal
   *  + serviceCharge + tax), and amountDue = totalBill − compApplied. Legacy
   *  rows (pre-v3.388) omit these and fall back to raw item math. */
  subtotal?: number | null;
  serviceCharge?: number | null;
  tax?: number | null;       // GST (₹) — alcohol GST-exempt, food 5%
  totalBill?: number | null; // tax-inclusive grand total (₹)

  // ───────── 🆕 2026-06-30 NC rework fields (all OPTIONAL → legacy-safe) ─────────
  /** Which of the 3 NC kinds this row is. Undefined = legacy comp+overage row. */
  kind?: NcKind | null;
  /** Slug of customerName used to MATCH a person's persistent NC BILL DUE tab
   *  across nights (lower-cased, alnum-hyphenated). */
  nameKey?: string | null;
  /** PERSISTENT NC BILL DUE only — every round punched, stamped with its night.
   *  The Sales report recognises each round's sale on round.night (accrual). */
  rounds?: NcRound[] | null;
  /** PERSISTENT NC BILL DUE only — partial/full payments against the tab. */
  payments?: NcPayment[] | null;
  /** Sum of payments[] (₹). */
  amountPaid?: number | null;
  /** totalBill − amountPaid (₹). status stays "open" until this hits ~0. */
  balanceDue?: number | null;
  /** OWNER only — true once the owner's consumption was written off to ₹0. */
  waived?: boolean | null;
  /** Distinct operational nights that have a round (array-contains query for the
   *  per-night Sales accrual without scanning the whole collection). */
  roundNights?: string[] | null;
  /** Distinct operational nights a payment was collected (per-night tender pie). */
  paymentNights?: string[] | null;
  /** Newest round's night — used to sort the open-tabs picker. */
  lastRoundNight?: string | null;
  updatedAt?: { seconds: number; nanoseconds: number } | null;
}

const COL = "billDue";

/** 🆕 2026-06-28 (Khushi / accountant rule) — SINGLE SOURCE OF TRUTH for NC bill
 *  math. The FIRST ₹1000 of ITEM VALUE (subtotal) is COMP — NO service charge,
 *  NO tax on that part ("we don't calculate SC & taxes until ₹1000, which is
 *  comp"). Only the item value ABOVE ₹1000 (the chargeable overage) is billed
 *  like a NORMAL bar bill: 10% service charge + GST (food 5%, alcohol exempt).
 *  So `amountDue` = (item value − ₹1000) + SC + GST on that overage, and the
 *  ₹1000 comp is pure give-away (no tax). For mixed food+drink tabs the comp is
 *  applied PROPORTIONALLY across items, so SC/GST scale by the chargeable
 *  fraction and the per-item attribution stays exact (used by the bar report to
 *  fold the chargeable part into NET/GROSS/SC/TAX).
 *
 *  `totalBill` = compApplied + amountDue (= subtotal + SC + tax on the overage),
 *  so the invariant `amountDue = totalBill − compApplied` still holds.
 *
 *  Item tax class mirrors the rest of the bar: `t==="food"` → GST-applicable;
 *  any drink (no `alc` flag on NC items) → treated as alcohol → GST-exempt. */
export interface NcBill {
  subtotal: number;
  serviceCharge: number;
  gst: number;
  cgst: number;
  sgst: number;
  roundOff: number;
  totalBill: number;   // tax-inclusive grand total
  compApplied: number;
  amountDue: number;   // totalBill − compApplied
}
export function computeNcBill(items: BillDueItem[], compCap = 1000): NcBill {
  const mapped: HodOrderItem[] = (items || []).map((it) => ({
    n: it.n, p: it.p || 0, qty: it.qty || 0, cat: "",
    t: it.t === "food" ? "food" : "drink",
    // NC items don't carry an `alc` flag; mirror the bar default — food is
    // GST-applicable, every drink is treated as alcohol (GST-exempt).
    alc: it.t === "food" ? false : true,
  }));
  const b = computeHodBreakdown(mapped);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const subtotal = b.subtotal;
  // First ₹1000 of item value is comp (no SC/tax); SC + GST apply only to the
  // chargeable overage, scaled proportionally so mixed food/drink stay correct.
  const compApplied = Math.min(compCap, subtotal);
  const chargeableBase = Math.max(0, subtotal - compApplied);
  const frac = subtotal > 0 ? chargeableBase / subtotal : 0;
  const serviceCharge = r2(b.serviceCharge * frac);
  const gst = r2(b.gst * frac);
  const cgst = r2(b.cgst * frac);
  const sgst = r2(b.sgst * frac);
  const dueRaw = chargeableBase + serviceCharge + gst;
  const amountDue = Math.round(dueRaw);
  const roundOff = r2(amountDue - dueRaw);
  // Keep the invariant amountDue = totalBill − compApplied (comp is tax-free).
  const totalBill = compApplied + amountDue;
  return {
    subtotal, serviceCharge, gst, cgst, sgst, roundOff,
    totalBill, compApplied, amountDue,
  };
}

/** Stable monotonic per-night token. Format `T-007` (zero-padded to 3).
 *  Resets at operational-night boundary (12pm → 12pm IST handled by
 *  getOperationalNightStr). Persists across reloads via localStorage. */
export function getNextToken(): string {
  try {
    const night = getOperationalNightStr();
    const key = `hod_bar_token_${night}`;
    const prev = parseInt(localStorage.getItem(key) || "0", 10) || 0;
    const next = prev + 1;
    localStorage.setItem(key, String(next));
    return `T-${String(next).padStart(3, "0")}`;
  } catch {
    // private-browsing / sandboxed → still return SOMETHING unique enough.
    return `T-${String(Math.floor(Date.now() / 1000) % 1000).padStart(3, "0")}`;
  }
}

export async function createBillDue(input: Omit<BillDueDoc, "status" | "createdAt" | "id" | "operationalNight">): Promise<string> {
  const ref = await addDoc(collection(db, COL), {
    ...input,
    operationalNight: getOperationalNightStr(),
    status: "open",
    createdAt: serverTimestamp(),
    clearedAt: null,
    clearedBy: null,
  });
  return ref.id;
}

/** 🆕 v3.184 — RUNNING TAB append. When the same NC guest orders another
 *  round, we DON'T create a second row (avoids duplicates + lets the single
 *  ₹1000 comp span the whole tab). Instead we merge the open row's items with
 *  the new round and recompute amountDue/compApplied tab-wide. The original
 *  token / approvedBy / createdAt stay put for audit.
 *
 *  🔒 v3.184 (architect hardening) — runs inside a TRANSACTION that re-reads
 *  the row and RE-CHECKS both (a) status is still "open" and (b) the guest
 *  identity still matches, BEFORE writing. This closes two races:
 *    1. another operator SETTLES the tab between the picker preselect and this
 *       write → we must NOT re-open a cleared/voided tab;
 *    2. the in-memory row drifted from the guest currently on screen.
 *  If either guard fails we return `{ ok:false }` and the caller opens a FRESH
 *  row instead (fail-safe — never merges into the wrong / closed tab).
 *  The combined items + recomputed totals are returned so the caller can use
 *  them for the WhatsApp ledger without re-reading. */
const _digits10 = (s: string) => (s || "").replace(/\D/g, "").slice(-10);
export async function appendBillDue(
  id: string,
  newItems: BillDueItem[],
  expect: { phoneKey: string; nameKey: string; role: NcRole },
  compCap = 1000,
): Promise<{ ok: boolean; combined?: BillDueItem[]; amountDue?: number; compApplied?: number; totalBill?: number; subtotal?: number; serviceCharge?: number; tax?: number }> {
  try {
    return await runTransaction(db, async (txn) => {
      const ref = doc(db, COL, id);
      const snap = await txn.get(ref);
      if (!snap.exists()) return { ok: false };
      const data = snap.data() as BillDueDoc;
      if (data.status !== "open") return { ok: false };
      // Re-verify identity against the persisted row (not the stale in-memory
      // copy): phone is authoritative when present, else name+role.
      if (expect.phoneKey.length >= 10) {
        if (_digits10(data.customerPhone || "") !== expect.phoneKey) return { ok: false };
      } else {
        if ((data.customerName || "").trim().toLowerCase() !== expect.nameKey || data.role !== expect.role) {
          return { ok: false };
        }
      }
      const combined: BillDueItem[] = [...(data.items || []), ...newItems];
      // 🆕 2026-06-24 (Khushi) — tab-wide SC + GST via the shared NC bill engine.
      const b = computeNcBill(combined, compCap);
      txn.update(ref, {
        items: combined,
        amountDue: b.amountDue,
        compApplied: b.compApplied,
        subtotal: b.subtotal,
        serviceCharge: b.serviceCharge,
        tax: b.gst,
        totalBill: b.totalBill,
      });
      return {
        ok: true, combined, amountDue: b.amountDue, compApplied: b.compApplied,
        totalBill: b.totalBill, subtotal: b.subtotal, serviceCharge: b.serviceCharge, tax: b.gst,
      };
    });
  } catch (e) {
    // FAIL-SAFE: any transaction error → tell the caller to open a fresh row
    // rather than risk a lost/duplicated write.
    console.warn("[billDue.append] txn failed", e);
    return { ok: false };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 🆕 2026-06-30 — NC REWORK helpers (3 kinds: comp / billdue / owner)
// ════════════════════════════════════════════════════════════════════════════

/** Hard cap on an NC COMP give-away (₹). Over this is BLOCKED → use NC BILL DUE. */
export const NC_COMP_CAP = 1000;

const _slugName = (s: string) =>
  (s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "guest";
const _round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** Raw item value (₹), NO SC/GST — used by the NC COMP cap check and OWNER amount. */
export function computeItemSubtotal(items: BillDueItem[]): number {
  return _round2((items || []).reduce((s, it) => s + (it.p || 0) * (it.qty || 0), 0));
}

/** Full chargeable bill (10% SC + GST, alcohol exempt, NO comp) for an NC BILL
 *  DUE round — i.e. a NORMAL bar bill. */
export function computeChargeBill(items: BillDueItem[]) {
  const b = computeNcBill(items, 0); // compCap 0 → no comp → full SC + GST
  return {
    subtotal: b.subtotal, serviceCharge: b.serviceCharge, gst: b.gst,
    cgst: b.cgst, sgst: b.sgst, roundOff: b.roundOff, total: b.totalBill,
  };
}

/** NC COMP cap check. ok=false when item value exceeds the ₹1000 give-away cap. */
export function checkCompCap(items: BillDueItem[], cap = NC_COMP_CAP): { ok: boolean; subtotal: number; over: number } {
  const subtotal = computeItemSubtotal(items);
  const over = _round2(Math.max(0, subtotal - cap));
  return { ok: over <= 0, subtotal, over };
}

function _sumRounds(rounds: NcRound[] | null | undefined) {
  return (rounds || []).reduce(
    (a, r) => ({
      subtotal: a.subtotal + (r.subtotal || 0),
      serviceCharge: a.serviceCharge + (r.serviceCharge || 0),
      tax: a.tax + (r.tax || 0),
      total: a.total + (r.total || 0),
    }),
    { subtotal: 0, serviceCharge: 0, tax: 0, total: 0 },
  );
}
function _sumPayments(payments: NcPayment[] | null | undefined) {
  return (payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
}
const _uniqPush = (arr: string[] | null | undefined, v: string): string[] => {
  const a = Array.isArray(arr) ? [...arr] : [];
  if (!a.includes(v)) a.push(v);
  return a;
};

/** Append a round to a PERSISTENT NC BILL DUE tab — or open a fresh one.
 *  When `existingOpenId` is supplied (operator picked an open person), the round
 *  is merged INSIDE a transaction that re-checks status==="open" + identity; on
 *  any mismatch it FAILS OPEN to creating a brand-new tab so a round is never
 *  lost or merged into the wrong/closed tab. Returns the tab id + new balance. */
export async function upsertOpenBillDueRound(
  person: { name: string; phone: string; role: NcRole; approvedBy: string; staff: string; employeeId?: string },
  roundItems: BillDueItem[],
  note?: string,
  existingOpenId?: string,
): Promise<{ id: string; balanceDue: number; totalBill: number; created: boolean }> {
  const night = getOperationalNightStr();
  const at = new Date().toISOString();
  const cb = computeChargeBill(roundItems);
  const round: NcRound = {
    night, at, items: roundItems,
    subtotal: cb.subtotal, serviceCharge: cb.serviceCharge, tax: cb.gst, total: cb.total,
    note: note || null, by: person.staff || null,
  };
  const nameKey = _slugName(person.name);

  if (existingOpenId) {
    try {
      const res = await runTransaction(db, async (txn) => {
        const ref = doc(db, COL, existingOpenId);
        const snap = await txn.get(ref);
        if (!snap.exists()) return null;
        const data = snap.data() as BillDueDoc;
        if (data.kind !== "billdue" || data.status !== "open") return null;
        const wantPhone = _digits10(person.phone || "");
        if (wantPhone.length >= 10) {
          if (_digits10(data.customerPhone || "") !== wantPhone) return null;
        } else if ((data.nameKey || _slugName(data.customerName || "")) !== nameKey) {
          return null;
        }
        const rounds = [...(data.rounds || []), round];
        const sums = _sumRounds(rounds);
        const amountPaid = _sumPayments(data.payments || []);
        const totalBill = _round2(sums.total);
        const balanceDue = _round2(totalBill - amountPaid);
        txn.update(ref, {
          rounds,
          roundNights: _uniqPush(data.roundNights, night),
          items: rounds.flatMap((r) => r.items),
          subtotal: _round2(sums.subtotal),
          serviceCharge: _round2(sums.serviceCharge),
          tax: _round2(sums.tax),
          totalBill, amountDue: balanceDue, amountPaid, balanceDue,
          status: balanceDue <= 0.5 ? "cleared" : "open",
          lastRoundNight: night, updatedAt: serverTimestamp(),
        });
        return { id: existingOpenId, balanceDue, totalBill, created: false };
      });
      if (res) return res;
    } catch (e) {
      console.warn("[billDue.upsert] append txn failed, opening fresh tab", e);
    }
    // fall through → open a fresh tab (fail-open)
  }

  const totalBill = _round2(cb.total);
  const ref = await addDoc(collection(db, COL), {
    kind: "billdue",
    operationalNight: night,
    customerName: person.name || "",
    customerPhone: person.phone || "",
    nameKey,
    role: person.role,
    approvedBy: person.approvedBy || "",
    staff: person.staff || "",
    // 🆕 2026-07-01 (Khushi) — logged-in staff EMPLOYEE ID for a captain BILL DUE
    // (staff friends & family). Stamped so the salary-deduction settlement + Boss
    // NC dashboard can attribute the tab to the exact staff member. Null on rows
    // opened from the bar NC flow (no employee id passed).
    staffEmployeeId: person.employeeId || null,
    items: roundItems,
    rounds: [round],
    roundNights: [night],
    payments: [],
    paymentNights: [],
    subtotal: cb.subtotal, serviceCharge: cb.serviceCharge, tax: cb.gst,
    totalBill, amountDue: totalBill, amountPaid: 0, balanceDue: totalBill,
    status: "open",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastRoundNight: night,
    clearedAt: null, clearedBy: null,
  });
  return { id: ref.id, balanceDue: totalBill, totalBill, created: true };
}

/** 🆕 2026-06-30 (Khushi) — OWNER running tab. Mirrors upsertOpenBillDueRound but
 *  item-price only (NO SC/GST). When the SAME owner name (phone optional) already
 *  has an OPEN, non-waived owner tab, this round is MERGED into it inside a
 *  transaction that re-checks kind==="owner" + status==="open" + !waived + identity;
 *  on any mismatch it FAILS OPEN to a brand-new owner tab (a round is never lost or
 *  merged into the wrong/closed/waived tab). Returns the tab id + new total owed. */
export async function upsertOpenOwnerRound(
  person: { name: string; phone: string; approvedBy: string; staff: string },
  roundItems: BillDueItem[],
  note?: string,
  existingOpenId?: string,
): Promise<{ id: string; amountDue: number; created: boolean }> {
  const night = getOperationalNightStr();
  const at = new Date().toISOString();
  const sub = computeItemSubtotal(roundItems); // item price only, NO tax
  const round: NcRound = {
    night, at, items: roundItems,
    subtotal: sub, serviceCharge: 0, tax: 0, total: sub,
    note: note || null, by: person.staff || null,
  };
  const nameKey = _slugName(person.name);

  if (existingOpenId) {
    try {
      const res = await runTransaction(db, async (txn) => {
        const ref = doc(db, COL, existingOpenId);
        const snap = await txn.get(ref);
        if (!snap.exists()) return null;
        const data = snap.data() as BillDueDoc;
        if (data.kind !== "owner" || data.status !== "open" || data.waived) return null;
        const wantPhone = _digits10(person.phone || "");
        if (wantPhone.length >= 10) {
          if (_digits10(data.customerPhone || "") !== wantPhone) return null;
        } else if ((data.nameKey || _slugName(data.customerName || "")) !== nameKey) {
          return null;
        }
        const rounds = [...(data.rounds || []), round];
        const sums = _sumRounds(rounds);
        const totalBill = _round2(sums.subtotal); // owner = item price only, no tax
        txn.update(ref, {
          rounds,
          roundNights: _uniqPush(data.roundNights, night),
          items: rounds.flatMap((r) => r.items),
          subtotal: totalBill, serviceCharge: 0, tax: 0,
          totalBill, amountDue: totalBill, balanceDue: totalBill,
          lastRoundNight: night, updatedAt: serverTimestamp(),
        });
        return { id: existingOpenId, amountDue: totalBill, created: false };
      });
      if (res) return res;
    } catch (e) {
      console.warn("[owner.upsert] append txn failed, opening fresh tab", e);
    }
    // fall through → open a fresh owner tab (fail-open)
  }

  const totalBill = _round2(sub);
  const ref = await addDoc(collection(db, COL), {
    kind: "owner",
    operationalNight: night,
    customerName: person.name || "",
    customerPhone: person.phone || "",
    nameKey,
    role: "OWNER",
    approvedBy: person.approvedBy || "",
    staff: person.staff || "",
    items: roundItems,
    rounds: [round],
    roundNights: [night],
    payments: [],
    paymentNights: [],
    subtotal: sub, serviceCharge: 0, tax: 0,
    totalBill, amountDue: totalBill, amountPaid: 0, balanceDue: totalBill,
    compApplied: 0,
    waived: false,
    status: "open",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastRoundNight: night,
    clearedAt: null, clearedBy: null,
  });
  return { id: ref.id, amountDue: totalBill, created: true };
}

/** Record a PARTIAL (or full) payment against an NC BILL DUE tab. Recomputes the
 *  balance + status inside a transaction. Overpay is clamped to the balance. */
export async function addBillDuePayment(
  id: string, amountInput: number, method: NcPaymentMethod, by: string,
): Promise<{ ok: boolean; balanceDue?: number; applied?: number }> {
  const night = getOperationalNightStr();
  try {
    return await runTransaction(db, async (txn) => {
      const ref = doc(db, COL, id);
      const snap = await txn.get(ref);
      if (!snap.exists()) return { ok: false };
      const data = snap.data() as BillDueDoc;
      const totalBill = _round2(
        typeof data.totalBill === "number" ? data.totalBill : _sumRounds(data.rounds || []).total,
      );
      const paidSoFar = _sumPayments(data.payments || []);
      const balance = _round2(totalBill - paidSoFar);
      const applied = _round2(Math.max(0, Math.min(Number(amountInput) || 0, balance)));
      if (applied <= 0) return { ok: false, balanceDue: balance, applied: 0 };
      const payments = [
        ...(data.payments || []),
        { amount: applied, method, at: new Date().toISOString(), by: by || "", night },
      ];
      const amountPaid = _round2(paidSoFar + applied);
      const balanceDue = _round2(totalBill - amountPaid);
      const cleared = balanceDue <= 0.5;
      txn.update(ref, {
        payments,
        paymentNights: _uniqPush(data.paymentNights, night),
        amountPaid, balanceDue, amountDue: balanceDue,
        status: cleared ? "cleared" : "open",
        clearedAt: cleared ? new Date().toISOString() : null,
        clearedBy: cleared ? (by || "") : null,
        updatedAt: serverTimestamp(),
      });
      return { ok: true, balanceDue, applied };
    });
  } catch (e) {
    console.warn("[billDue.payment] txn failed", e);
    return { ok: false };
  }
}

/** Owner WAIVE-OFF — zero the owner's owed amount. Manager-PIN gated upstream. */
export async function waiveOwnerBillDue(id: string, by: string): Promise<void> {
  await updateDoc(doc(db, COL, id), {
    waived: true, status: "cleared", paymentMethod: "waived",
    clearedAt: new Date().toISOString(), clearedBy: by || "",
    balanceDue: 0, amountPaid: 0, updatedAt: serverTimestamp(),
  });
}

/** Live list of ALL currently-OPEN NC BILL DUE tabs (NOT night-scoped — these
 *  carry across days until settled). Single-field where("status","==","open")
 *  (no composite index) + client-side kind filter. FAIL-OPEN → []. */
export function subscribeOpenNcBillDue(cb: (rows: BillDueDoc[]) => void) {
  const q = query(collection(db, COL), where("status", "==", "open"));
  return onSnapshot(q, (snap) => {
    const out: BillDueDoc[] = [];
    snap.forEach((d) => {
      const data = d.data() as Omit<BillDueDoc, "id">;
      if (data.kind === "billdue") out.push({ id: d.id, ...data });
    });
    out.sort((a, b) => (b.lastRoundNight || "").localeCompare(a.lastRoundNight || ""));
    cb(out);
  }, (err) => {
    console.warn("[billDue.subscribeOpenBillDue] failed", err);
    cb([]);
  });
}

/** 🆕 2026-06-30 — Live list of ALL currently-OPEN NC docs of EVERY kind
 *  (billdue + owner; comp is logged settled so it's not "open"). Single-field
 *  where("status","==","open") (no composite index) — caller splits by kind.
 *  Used by the Boss→Sales→NC dashboard's "who owes / who's owed now" sections.
 *  FAIL-OPEN → []. */
export function subscribeOpenNc(cb: (rows: BillDueDoc[]) => void) {
  const q = query(collection(db, COL), where("status", "==", "open"));
  return onSnapshot(q, (snap) => {
    const out: BillDueDoc[] = [];
    snap.forEach((d) => out.push({ id: d.id, ...(d.data() as Omit<BillDueDoc, "id">) }));
    out.sort((a, b) =>
      (b.lastRoundNight || b.operationalNight || "").localeCompare(a.lastRoundNight || a.operationalNight || ""));
    cb(out);
  }, (err) => {
    console.warn("[billDue.subscribeOpenNc] failed", err);
    cb([]);
  });
}

/** 🆕 2026-06-30 — ONE-SHOT fetch of every NC doc CREATED on any night in the
 *  inclusive [start,end] range (loops the night list, single-field
 *  operationalNight== per night, deduped by id). On-demand only (the dashboard
 *  taps LOAD) so idle Boss Mode pays zero reads. Used for the NC COMP list +
 *  range-scoped owner/billdue history. FAIL-OPEN → []. */
export async function fetchNcForRange(start: string, end: string): Promise<BillDueDoc[]> {
  try {
    const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); };
    const fmt = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    const nights: string[] = [];
    let cur = parse(start); const last = parse(end); let guard = 0;
    while (cur <= last && guard++ < 400) { nights.push(fmt(cur)); cur.setDate(cur.getDate() + 1); }
    const byId = new Map<string, BillDueDoc>();
    for (const n of nights) {
      const rows = await fetchBillDueForNight(n);
      for (const r of rows) if (r.id) byId.set(r.id, r);
    }
    return Array.from(byId.values());
  } catch (e) {
    console.warn("[billDue.fetchForRange] failed", e);
    return [];
  }
}

/** All NC BILL DUE tabs that have a ROUND on `night` (array-contains, single
 *  field, auto-indexed). The Sales report recognises the sale on the consumption
 *  night via this. FAIL-OPEN → []. */
export async function fetchNcBillDueRoundsForNight(night: string): Promise<BillDueDoc[]> {
  try {
    const q = query(collection(db, COL), where("roundNights", "array-contains", night));
    const snap = await getDocs(q);
    const out: BillDueDoc[] = [];
    snap.forEach((d) => out.push({ id: d.id, ...(d.data() as Omit<BillDueDoc, "id">) }));
    return out;
  } catch (e) {
    console.warn("[billDue.fetchRoundsForNight] failed", e);
    return [];
  }
}

/** All NC BILL DUE tabs that had a PAYMENT on `night` (array-contains). The
 *  "payment methods collected" pie counts the real tender on the pay night. */
export async function fetchNcBillDuePaymentsForNight(night: string): Promise<BillDueDoc[]> {
  try {
    const q = query(collection(db, COL), where("paymentNights", "array-contains", night));
    const snap = await getDocs(q);
    const out: BillDueDoc[] = [];
    snap.forEach((d) => out.push({ id: d.id, ...(d.data() as Omit<BillDueDoc, "id">) }));
    return out;
  } catch (e) {
    console.warn("[billDue.fetchPaymentsForNight] failed", e);
    return [];
  }
}

/** 🆕 2026-06-05 — ONE-SHOT fetch of a SPECIFIC operational night's bill-due
 *  rows. subscribeBillDue() is hard-scoped to TONIGHT, so back-dated Live
 *  Reports need this to show historical NC. Same single-field `where` (no
 *  composite index) + client-side sort. FAIL-OPEN → [] on any error. */
export async function fetchBillDueForNight(night: string): Promise<BillDueDoc[]> {
  try {
    const q = query(collection(db, COL), where("operationalNight", "==", night));
    const snap = await getDocs(q);
    const out: BillDueDoc[] = [];
    snap.forEach((d) => out.push({ id: d.id, ...(d.data() as Omit<BillDueDoc, "id">) }));
    out.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    return out;
  } catch (e) {
    console.warn("[billDue.fetchForNight] failed", e);
    return [];
  }
}

export function subscribeBillDue(cb: (rows: BillDueDoc[]) => void) {
  // Scoped to TONIGHT only so the badge count doesn't accumulate over time.
  // 🔴 v3.116 BUGFIX — REMOVED the `orderBy("createdAt","desc")` from the
  // query. Composite-index `operationalNight ASC + createdAt DESC` did not
  // exist on hod-tickets → the query failed silently → fail-open returned
  // an empty list → BILL DUE tab showed ₹0 even though rows were being
  // written. Now we sort client-side (max ~50 rows per night, trivial cost)
  // so the single-field `where` works on every Firebase project out of the
  // box with NO index setup.
  const night = getOperationalNightStr();
  const q = query(
    collection(db, COL),
    where("operationalNight", "==", night),
  );
  return onSnapshot(q, (snap) => {
    const out: BillDueDoc[] = [];
    snap.forEach((d) => out.push({ id: d.id, ...(d.data() as Omit<BillDueDoc, "id">) }));
    // Sort newest-first client-side (replaces removed orderBy).
    out.sort((a, b) => {
      const aT = a.createdAt?.seconds || 0;
      const bT = b.createdAt?.seconds || 0;
      return bT - aT;
    });
    cb(out);
  }, (err) => {
    // FAIL-OPEN: surface as empty list rather than crashing the bar tab.
    console.warn("[billDue.subscribe] failed", err);
    cb([]);
  });
}

export async function clearBillDue(
  id: string, staff: string, paymentMethod: NcPaymentMethod = "cash",
  discountPct = 0, finalAmount?: number,
): Promise<void> {
  await updateDoc(doc(db, COL, id), {
    status: "cleared",
    clearedAt: new Date().toISOString(),
    clearedBy: staff,
    paymentMethod,
    discountPct: discountPct || 0,
    finalAmount: typeof finalAmount === "number" ? finalAmount : null,
  });
}

const WHATSAPP_CF_BASE = "https://asia-south1-hod-tickets.cloudfunctions.net";

/** Fire-and-forget WhatsApp text to the guest with the bill-due ledger.
 *  Returns boolean ok — caller can show a toast but should NEVER block
 *  the workflow on this (some phones reject; that's fine). */
export async function sendBillDueWhatsApp(
  phone: string, name: string, amount: number, items: BillDueItem[], token?: string,
): Promise<boolean> {
  try {
    const cleaned = (phone || "").replace(/\D/g, "");
    if (cleaned.length < 10) return false;
    const to = cleaned.length === 10 ? `91${cleaned}` : cleaned;
    const lines = items.map((it) => {
      const tot = (it.p || 0) * (it.qty || 0);
      return `• ${it.qty}× ${it.n}${it.free ? " (COMPED)" : ` — ₹${tot}`}`;
    }).join("\n");
    // 🆕 2026-06-24 (Khushi) — clearly itemise SERVICE CHARGE + GST so the guest
    // sees exactly what they're being taxed on (NC tabs now collect SC + tax).
    const b = computeNcBill(items);
    const fmt = (n: number) => `₹${n.toLocaleString("en-IN")}`;
    const taxLines =
      `Subtotal: ${fmt(b.subtotal)}\n` +
      `Service charge (10%): ${fmt(b.serviceCharge)}\n` +
      `GST: ${fmt(b.gst)}\n` +
      `Total bill: ${fmt(b.totalBill)}\n` +
      (b.compApplied > 0 ? `Comp: −${fmt(b.compApplied)}\n` : "");
    const msg =
      `🍸 HOUSE OF DOPAMINE\n\n` +
      `Hi ${name || "Guest"} —\n\n` +
      `Tonight's NC tab${token ? ` (TOKEN ${token})` : ""}:\n${lines}\n\n` +
      `${taxLines}` +
      `Amount due: ₹${amount.toLocaleString("en-IN")}\n\n` +
      `Please settle at the bar before you leave. 🙏`;
    const r = await fetch(`${WHATSAPP_CF_BASE}/sendWhatsAppText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, message: msg }),
    });
    return r.ok;
  } catch (e) {
    console.warn("[billDue.whatsapp] send failed", e);
    return false;
  }
}
