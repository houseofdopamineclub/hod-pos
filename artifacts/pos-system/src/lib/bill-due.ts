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
  serverTimestamp, updateDoc, where,
} from "firebase/firestore";
import { db } from "./firebase";
import { getOperationalNightStr } from "./utils-pos";

export type NcRole = "DJ" | "OWNER" | "INFLUENCER" | "PROMOTER" | "OTHER";

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
  token?: string | null;
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

export function subscribeBillDue(cb: (rows: BillDueDoc[]) => void) {
  // Scoped to TONIGHT only so the badge count doesn't accumulate over time.
  const night = getOperationalNightStr();
  const q = query(
    collection(db, COL),
    where("operationalNight", "==", night),
    orderBy("createdAt", "desc"),
  );
  return onSnapshot(q, (snap) => {
    const out: BillDueDoc[] = [];
    snap.forEach((d) => out.push({ id: d.id, ...(d.data() as Omit<BillDueDoc, "id">) }));
    cb(out);
  }, (err) => {
    // FAIL-OPEN: surface as empty list rather than crashing the bar tab.
    console.warn("[billDue.subscribe] failed", err);
    cb([]);
  });
}

export async function clearBillDue(id: string, staff: string): Promise<void> {
  await updateDoc(doc(db, COL, id), {
    status: "cleared",
    clearedAt: new Date().toISOString(),
    clearedBy: staff,
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
