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

// 🆕 2026-05-27 v3.115 — MANAGER added to the role list (Khushi: floor
// managers eat/drink on the house too; need their own audit bucket).
export type NcRole = "DJ" | "OWNER" | "INFLUENCER" | "PROMOTER" | "MANAGER" | "OTHER";

// 🆕 2026-05-27 v3.115 — payment method captured on settlement so the
// morning report can split NC RECOVERED (cash/upi/card) vs NC WAIVED
// (manager wrote it off). Optional for back-compat with v3.114 rows.
export type NcPaymentMethod = "cash" | "upi" | "card" | "waived";

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
}

const COL = "billDue";

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
): Promise<{ ok: boolean; combined?: BillDueItem[]; amountDue?: number; compApplied?: number }> {
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
      const gross = combined.reduce((s, it) => s + (it.p || 0) * (it.qty || 0), 0);
      const compApplied = Math.min(compCap, gross);
      const amountDue = Math.max(0, gross - compApplied);
      txn.update(ref, { items: combined, amountDue, compApplied });
      return { ok: true, combined, amountDue, compApplied };
    });
  } catch (e) {
    // FAIL-SAFE: any transaction error → tell the caller to open a fresh row
    // rather than risk a lost/duplicated write.
    console.warn("[billDue.append] txn failed", e);
    return { ok: false };
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
    const msg =
      `🍸 HOUSE OF DOPAMINE\n\n` +
      `Hi ${name || "Guest"} —\n\n` +
      `Tonight's NC tab${token ? ` (TOKEN ${token})` : ""}:\n${lines}\n\n` +
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
