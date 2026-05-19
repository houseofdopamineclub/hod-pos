import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Link } from "wouter";
import {
  sha256, subscribeToHodReservations, diagnoseTableReservationDates, markGuestArrived, markRoundServed, markRoundActivated,
  ensureCoverForAggregatorArrival,
  markTablePaid, releaseTable, setReservationAggregator, updateRoundItems,
  recordBillPrint,
  printKOT, printBill, AGGREGATOR_OPTIONS, getAggregatorDiscount,
  createWalkInTable, addRoundToTable, reassignTable, createProxyTable,
  recordKotVoid, recordWalkInDiscountOverride, getTabletFloor, printKOTVoid,
  voidBill, printBillVoid, assertCaptainCanVoid, recordCaptainVoidUsage,
  recordSilentPrePrintEdit,
  computeHodBreakdown, lookupOrphanZomatoPaymentByName, type TabletFloor,
  type HodTableReservation, type HodTabRound, type HodOrderItem,
  type OrphanZomatoPayment,
  // 2026-05-15 — Captain × Cover wallet redemption (Khushi spec)
  redeemFromWalletAtTable, undoWalletRedemption, findCoverForRedemption,
  type WalletRedemption, type HodCover,
  // 2026-05-18 — Live menu category filtering (admin Menu CRM controls visibility + discount)
  subscribeToLiveMenuCategories, filterMenuByLiveCategories, type MenuCategory,
} from "@/lib/firestore-hod";
import { subscribeToMenuOverrides } from "@/lib/firestore";
import { QrScanner } from "@/components/QrScanner";
// 🔴 2026-05-09 — switched from menu-data.ts (314 legacy items) to canonical
// HOD_MENU_ITEMS (373) so Captain's picker matches Admin/Bar/wallet exactly.
// Without this, OOS/discount overrides set by manager can silently miss items
// the captain sees (or vice versa). Same shape — drop-in compatible.
import { HOD_MENU_ITEMS as MENU_ITEMS } from "@/lib/hod-menu";
import type { MenuItem, MenuOverride } from "@/lib/types";
import { formatINR } from "@/lib/utils-pos";
import { WaiterCallBanner } from "@/components/WaiterCallBanner";
// Shared with DoorMode so a single edit updates every WhatsApp message that
// includes the venue location. Plain Google Maps URL — never a Firebase
// Dynamic Link (those were shut down 2025-08-25).
import { HOD_LOCATION_URL } from "@/pages/DoorMode";

// Firebase Cloud Functions — replaces Replit /api/whatsapp/*
// Set this to your Firebase Functions URL after deploying:
//   https://asia-south1-hod-tickets.cloudfunctions.net
// During local dev with Firebase emulator:
//   http://localhost:5001/hod-tickets/asia-south1
const WHATSAPP_CF_BASE = "https://asia-south1-hod-tickets.cloudfunctions.net";
const CAPTAIN_HASH = "8eb63d4e8a9814c7f8d2af807808d010d4d2cc1930edae511792764ca53b679c";
// Manager PIN — guards: changing source after a bill is printed (L1/L7),
// marking paid without ever printing a bill (L9). Default PIN is 8888.
// Darshan: ask me to rotate this hash anytime; staff should never know it.
const MANAGER_HASH = "2926a2731f4b312c08982cacf8061eb14bf65c1a87cc5d70e864e079c6220731";
// Admin PIN — second-factor for the most dangerous moves: switching FROM an
// aggregator (e.g. Zomato 30%) → in-house mid-tab (which would otherwise
// silently strip the customer's pre-paid discount). Default Admin PIN is
// 9999; rotate by computing sha256(newPin) and replacing this hash.
const ADMIN_HASH = "888df25ae35772424a560c7152a1de794440e0ea5cfee62828333a456a506e05";
const GST_RATE = 0.05;
const SERVICE_CHARGE_RATE = 0.10;
// L6 — minimum gap between two thermal-bill prints for the same table; below
// this we ask the captain to confirm so they can't waste paper hammering the button.
const BILL_REPRINT_DEBOUNCE_MS = 10_000;
// D1 — manual discount % above this triggers Manager-PIN at Mark-Paid time.
// Aggregator-driven discounts (Zomato/EazyDiner) bypass this gate; only the
// captain-typed manualDiscount field is checked.
const HIGH_DISCOUNT_PIN_THRESHOLD = 25;
// D2 — waiving Service Charge on a tab above this rupee floor needs Manager PIN.
// Below this, comped SC is treated as a routine kindness (small chai/water tabs).
const SC_WAIVER_PIN_FLOOR = 1500;
// D3 — at walk-in creation, if customDiscount exceeds the source's implied
// discount by more than this many percentage points, Manager PIN is required.
const WALKIN_DISCOUNT_PIN_DELTA = 5;
// 🔴 2026-05-12 — D4: cap on every captain-typed discount field. Owners
// asked for a hard ceiling so the bouncer/captain can never exceed 15% on
// either in-house or aggregator tabs. Aggregator DEFAULTS (e.g. Zomato 30%)
// still flow through `aggregatorDiscount` from the booking, but a captain
// hand-typing into a discount input is locked at 15 and must enter the
// Manager PIN even for the very first 0 → N change.
const CAPTAIN_DISCOUNT_MAX = 15;
// 🔴 2026-05-13 (Khushi spec, round 6) — walk-in (Seat Walk-In Guest)
// modal is in-house only, discount capped at 10% (was 15%). Settle Bill
// still allows up to CAPTAIN_DISCOUNT_MAX since managers may need
// promo/loyalty headroom there.
const WALKIN_DISCOUNT_MAX = 10;

/** Clamp a captain-typed discount to the 15% cap; alert + return null if rejected. */
function clampCaptainDiscount(raw: number): number | null {
  const n = Math.max(0, Math.floor(Number(raw) || 0));
  if (n > CAPTAIN_DISCOUNT_MAX) {
    alert(`⚠ Captain discount is capped at ${CAPTAIN_DISCOUNT_MAX}%.\nAsk a manager to apply anything higher.`);
    return null;
  }
  return n;
}

/** Prompt for the Manager PIN and verify against MANAGER_HASH. Returns true on success. */
async function requireManagerPin(reason: string): Promise<boolean> {
  const pin = window.prompt(`🔒 Manager PIN required\n\n${reason}\n\nEnter 4-digit Manager PIN:`);
  if (!pin) return false;
  const h = await sha256(pin.trim());
  if (h !== MANAGER_HASH) { alert("❌ Wrong Manager PIN."); return false; }
  return true;
}

// V3 2026-05-10 — VOID BILL reasons. Distinct from item-void reasons because
// the failure modes are different: bill-void = customer/payment failure,
// item-void = kitchen/bar/staff failure.
const BILL_VOID_REASONS: string[] = [
  "CUSTOMER REFUSED TO PAY",
  "FOOD QUALITY ISSUE",
  "SERVICE ISSUE",
  "DISPUTED CHARGES",
  "GUEST WALKED OUT",
  "DUPLICATE BILL",
  "COMP — MGMT GIFT",
  "OTHER",
];

// V1 — Standard void reasons (Khushi-approved dropdown). "OTHER" forces a
// free-text note so we never lose the audit trail to a one-word category.
const VOID_REASONS: string[] = [
  "GUEST CHANGED MIND",
  "OUT OF STOCK",
  "WRONG ITEM SENT",
  "DAMAGED / SPILT",
  "STAFF ERROR",
  "COMP — GIFT TO GUEST",
  "GUEST DISSATISFIED",
  "OTHER",
];

/** V1 — VoidReasonModal: single-screen dialog that captures Manager PIN +
 *  reason dropdown + optional notes BEFORE the void is committed. Replaces
 *  the old prompt() / alert() chain so reasons are structured, audit-ready,
 *  and reportable. Mounts above the EditOrderModal. */
function VoidReasonModal({ voided, valueLost, roundNum, onCancel, onConfirm }: {
  voided: Array<{ n: string; qty: number; p: number }>;
  valueLost: number;
  roundNum: number;
  onCancel: () => void;
  onConfirm: (data: { pin: string; reason: string; notes: string }) => Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [reason, setReason] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr("");
    if (!reason) { setErr("Pick a reason."); return; }
    if (reason === "OTHER" && !notes.trim()) { setErr("Type a note for 'Other'."); return; }
    if (pin.length !== 4) { setErr("Manager PIN is 4 digits."); return; }
    const h = await sha256(pin.trim());
    if (h !== MANAGER_HASH) { setErr("❌ Wrong Manager PIN."); setPin(""); return; }
    setBusy(true);
    try {
      const finalReason = reason === "OTHER" ? notes.trim() : (notes.trim() ? `${reason} — ${notes.trim()}` : reason);
      await onConfirm({ pin, reason: finalReason, notes: notes.trim() });
    } catch (e: any) { setErr(e?.message || "Failed"); setBusy(false); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.92)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "rgba(20,18,30,1)", border: "2px solid rgba(239,68,68,.4)", borderRadius: 20, padding: 22, width: "100%", maxWidth: 420, maxHeight: "92vh", overflowY: "auto" }}>
        <div style={{ fontSize: 17, fontWeight: 900, color: "#EF4444", marginBottom: 6 }}>🚫 VOID FROM PRINTED KOT</div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 14 }}>Round {roundNum} · Bar/Kitchen will be auto-notified</div>

        <div style={{ background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.25)", borderRadius: 10, padding: "10px 12px", marginBottom: 14 }}>
          {voided.map((v, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#fff", padding: "3px 0" }}>
              <span>{v.qty}× {v.n}</span>
              <span style={{ color: "#EF4444", fontWeight: 700 }}>−₹{v.p * v.qty}</span>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, paddingTop: 6, borderTop: "1px dashed rgba(255,255,255,.1)", fontSize: 13, fontWeight: 900 }}>
            <span style={{ color: "#fff" }}>VALUE LOST</span>
            <span style={{ color: "#EF4444" }}>−₹{valueLost}</span>
          </div>
        </div>

        <div style={{ fontSize: 11, color: "rgba(255,255,255,.6)", marginBottom: 6, fontWeight: 700 }}>REASON *</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {VOID_REASONS.map((r) => (
            <button key={r} onClick={() => setReason(r)} disabled={busy}
              style={{ padding: "7px 11px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer",
                background: reason === r ? "rgba(242,199,68,.18)" : "rgba(255,255,255,.04)",
                border: `1px solid ${reason === r ? "rgba(242,199,68,.6)" : "rgba(255,255,255,.1)"}`,
                color: reason === r ? "#F2C744" : "rgba(255,255,255,.65)" }}>
              {r}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 11, color: "rgba(255,255,255,.6)", marginBottom: 6, fontWeight: 700 }}>
          NOTES {reason === "OTHER" ? "*" : "(optional)"}
        </div>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy}
          placeholder={reason === "OTHER" ? "Required — describe what happened" : "e.g. table 5 sent it back"}
          style={{ width: "100%", padding: "10px 12px", borderRadius: 10, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 13, outline: "none", marginBottom: 14, boxSizing: "border-box" }} />

        <div style={{ fontSize: 11, color: "rgba(255,255,255,.6)", marginBottom: 6, fontWeight: 700 }}>🔒 MANAGER PIN *</div>
        <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          autoFocus disabled={busy} placeholder="4-digit PIN"
          onKeyDown={(e) => e.key === "Enter" && submit()}
          style={{ width: "100%", padding: "12px 14px", borderRadius: 10, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 18, letterSpacing: 8, textAlign: "center", outline: "none", marginBottom: 12, boxSizing: "border-box" }} />

        {err && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 10, textAlign: "center" }}>{err}</div>}

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onCancel} disabled={busy}
            style={{ flex: 1, padding: 12, borderRadius: 10, background: "transparent", border: "1px solid rgba(255,255,255,.15)", color: "rgba(255,255,255,.6)", fontSize: 13, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer" }}>
            Cancel
          </button>
          <button onClick={submit} disabled={busy}
            style={{ flex: 1.4, padding: 12, borderRadius: 10, background: "rgba(239,68,68,.18)", border: "1px solid rgba(239,68,68,.5)", color: "#EF4444", fontSize: 13, fontWeight: 900, cursor: busy ? "not-allowed" : "pointer" }}>
            {busy ? "Voiding..." : "🚫 CONFIRM VOID"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** V3 2026-05-10 — VoidBillModal: Manager-PIN-gated dialog for voiding a
 *  WHOLE PRINTED BILL (customer refused to pay, food bad, etc.). Shows the
 *  bill total prominently so the manager understands the leakage they're
 *  approving. */
function VoidBillModal({ tableId, customerName, billTotal, onCancel, onConfirm }: {
  tableId: string;
  customerName: string;
  billTotal: number;
  onCancel: () => void;
  onConfirm: (data: { pin: string; reason: string; notes: string }) => Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [reason, setReason] = useState(BILL_VOID_REASONS[0]);
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setErr("");
    if (pin.length !== 4) { setErr("Enter 4-digit Manager PIN."); return; }
    if (reason === "OTHER" && !notes.trim()) { setErr("Notes required when reason is OTHER."); return; }
    setBusy(true);
    try { await onConfirm({ pin, reason, notes: notes.trim() }); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : "Failed to void bill."); setBusy(false); }
  };
  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", zIndex: 5000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 460, background: "#0A0A0A", border: "2px solid rgba(239,68,68,.5)", borderRadius: 14, padding: 20, color: "#fff" }}>
        <div style={{ fontSize: 17, fontWeight: 900, color: "#EF4444", marginBottom: 6 }}>🚫 VOID PRINTED BILL</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.6)", marginBottom: 10 }}>
          Use ONLY when the bill was printed but the customer cannot/will not pay. The bill stays on record for audit; the table is freed.
        </div>
        <div style={{ background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.25)", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.55)", marginBottom: 4 }}>TABLE / CUSTOMER</div>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#F2C744", marginBottom: 8 }}>{tableId} · {customerName || "—"}</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.55)", marginBottom: 4 }}>BILL TOTAL TO BE VOIDED (LEAKAGE)</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#EF4444" }}>₹{Math.round(billTotal)}</div>
        </div>

        <label style={{ fontSize: 11, color: "rgba(255,255,255,.6)", marginBottom: 4, display: "block" }}>REASON</label>
        <select value={reason} onChange={(e) => setReason(e.target.value)}
          style={{ width: "100%", padding: "10px 12px", borderRadius: 10, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 13, marginBottom: 12, boxSizing: "border-box" }}>
          {BILL_VOID_REASONS.map((r) => <option key={r} value={r} style={{ background: "#0A0A0A" }}>{r}</option>)}
        </select>

        <label style={{ fontSize: 11, color: "rgba(255,255,255,.6)", marginBottom: 4, display: "block" }}>
          NOTES {reason === "OTHER" ? "(REQUIRED)" : "(OPTIONAL)"}
        </label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
          placeholder="What happened? (Will be stored in the audit trail.)"
          style={{ width: "100%", padding: "10px 12px", borderRadius: 10, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 13, marginBottom: 12, boxSizing: "border-box", resize: "vertical" }} />

        <label style={{ fontSize: 11, color: "rgba(255,255,255,.6)", marginBottom: 4, display: "block" }}>MANAGER PIN (8888)</label>
        <input type="password" inputMode="numeric" pattern="[0-9]*" maxLength={4}
          value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          style={{ width: "100%", padding: "12px 14px", borderRadius: 10, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 18, letterSpacing: 8, textAlign: "center", outline: "none", marginBottom: 12, boxSizing: "border-box" }} />

        {err && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 10, textAlign: "center" }}>{err}</div>}

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onCancel} disabled={busy}
            style={{ flex: 1, padding: 12, borderRadius: 10, background: "transparent", border: "1px solid rgba(255,255,255,.15)", color: "rgba(255,255,255,.6)", fontSize: 13, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer" }}>
            Cancel
          </button>
          <button onClick={submit} disabled={busy}
            style={{ flex: 1.4, padding: 12, borderRadius: 10, background: "rgba(239,68,68,.18)", border: "1px solid rgba(239,68,68,.5)", color: "#EF4444", fontSize: 13, fontWeight: 900, cursor: busy ? "not-allowed" : "pointer" }}>
            {busy ? "Voiding..." : "🚫 CONFIRM VOID BILL"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Prompt for the Admin PIN and verify against ADMIN_HASH. Used as a second
 *  factor on the most dangerous moves (e.g. aggregator → in-house downgrade). */
async function requireAdminPin(reason: string): Promise<boolean> {
  const pin = window.prompt(`🛡️ ADMIN PIN ALSO REQUIRED\n\n${reason}\n\nEnter 4-digit Admin PIN:`);
  if (!pin) return false;
  const h = await sha256(pin.trim());
  if (h !== ADMIN_HASH) { alert("❌ Wrong Admin PIN."); return false; }
  return true;
}

// Brand-color palette for the booking-source pills (champagne gold for in-house,
// authentic brand colors for each aggregator). Used in the Source/Discount UI.
const AGG_BRAND: Record<string, { fg: string; bg: string; border: string }> = {
  inhouse:         { fg: "#F2C744", bg: "rgba(242,199,68,.14)", border: "rgba(242,199,68,.55)" },
  // 🔴 2026-05-12 — Brand palette intentionally collapsed to the venue's
  // 4 in-house colours (yellow / black / white / red). External brand reds
  // / oranges removed per owner request; aggregator identity is conveyed
  // by the label, not by colour.
  zomato:          { fg: "#EF4444", bg: "rgba(239,68,68,.14)",  border: "rgba(239,68,68,.55)"  },
  "swiggy-dineout":{ fg: "#EF4444", bg: "rgba(239,68,68,.14)",  border: "rgba(239,68,68,.55)"  },
  "swiggy-scenes": { fg: "#EF4444", bg: "rgba(239,68,68,.14)",  border: "rgba(239,68,68,.55)"  },
  eazydiner:       { fg: "#F2C744", bg: "rgba(242,199,68,.10)", border: "rgba(242,199,68,.45)" },
};

const TABLE_OPTIONS = [
  { floor: "dance", label: "Ground Floor", tables: ["C1","C2","C3","C4","CVIP1","CVIP2"] },
  { floor: "dining", label: "Dining", tables: ["FD1","FD2","FD3","FD4","FD5","FD6","FD7","FD8","FD9","FD10","FD11","FD12","FD13","FD14","FD15","FD16","FD17","FD18","SMK1","SMK2","SMK3","SMK4","SMK5","SMK6","SMK7","SMK8"] },
  { floor: "rooftop", label: "Rooftop", tables: ["T1","T2","T3","T4","T5","T6","T7","T8","T9","T10","T11","TVIP1","TVIP2","TVIP3","TVIP4","TVIP5","TVIP6","TVIP7","TEX1"] },
];

// 2026-05-13 (Khushi spec) — table picker boxes are now coloured GREEN
// (available) / RED (taken) per requested time slot, instead of the old
// white-grey + dim-red scheme. The same table can be booked twice in one
// night (e.g. 7pm dinner + 11pm party); a 11pm booking should NOT make the
// box look red at 7pm. Each reservation is treated as occupying its table
// for SLOT_MINUTES from arrivalTime, with a small 30-min lead-in buffer.
// Once the bill is paid the table is released immediately.
const SLOT_MINUTES = 120;
const SLOT_LEAD_IN_MIN = 30;

function parseClockToMinutes(t?: string): number | null {
  if (!t) return null;
  const s = String(t).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(h) || Number.isNaN(mm)) return null;
  const ampm = m[3]?.toUpperCase();
  if (ampm === "PM" && h < 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return h * 60 + mm;
}

function nowMinutesIST(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// Returns the reservation occupying `tableId` at the target wall-clock
// minutes (if any). Paid bookings are treated as released. Reservations with
// no parseable arrivalTime are conservatively treated as occupying NOW.
function tableOccupantAt(
  tableId: string,
  targetMin: number,
  reservations: HodTableReservation[]
): HodTableReservation | null {
  for (const r of reservations) {
    if (r.tableId !== tableId) continue;
    if (r.paymentStatus === "paid") continue;
    const start = parseClockToMinutes(r.arrivalTime);
    if (start == null) {
      // Unknown arrival time — treat as currently occupying so we don't
      // accidentally double-book on top of a captain-created walk-in that
      // never set arrivalTime. This matches the old, time-blind behaviour.
      return r;
    }
    const winStart = start - SLOT_LEAD_IN_MIN;
    const winEnd = start + SLOT_MINUTES;
    if (targetMin >= winStart && targetMin <= winEnd) return r;
  }
  return null;
}

function useAudioAlert() {
  const ctxRef = useRef<AudioContext | null>(null);
  return useCallback((urgent: boolean) => {
    try {
      if (!ctxRef.current) ctxRef.current = new AudioContext();
      const ctx = ctxRef.current;
      [urgent ? 880 : 660, urgent ? 1100 : 880].forEach((freq, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.frequency.value = freq; g.gain.value = 0.25;
        o.start(ctx.currentTime + i * 0.15);
        g.gain.setValueAtTime(0.25, ctx.currentTime + i * 0.15);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.3);
        o.stop(ctx.currentTime + i * 0.15 + 0.3);
      });
    } catch {}
  }, []);
}

function CaptainLogin({ onLogin }: { onLogin: (name: string) => void }) {
  const [name, setName] = useState(() => sessionStorage.getItem("hod_captain_name") || "");
  const [pwd, setPwd] = useState("");
  const [error, setError] = useState("");
  const [fails, setFails] = useState(() => parseInt(sessionStorage.getItem("hod_cap_fails") || "0"));
  const [lockUntil, setLockUntil] = useState(() => parseInt(sessionStorage.getItem("hod_cap_lock") || "0"));

  const tryLogin = async () => {
    const currentLock = parseInt(sessionStorage.getItem("hod_cap_lock") || "0");
    if (currentLock > Date.now()) {
      setLockUntil(currentLock);
      setError(`Too many attempts. Locked for ${Math.ceil((currentLock - Date.now()) / 60000)} min.`);
      return;
    }
    if (!name.trim()) { setError("Please enter your name"); return; }
    const hash = await sha256(pwd);
    if (hash === CAPTAIN_HASH) {
      sessionStorage.setItem("hod_captain_name", name.trim());
      sessionStorage.removeItem("hod_cap_fails");
      sessionStorage.removeItem("hod_cap_lock");
      onLogin(name.trim());
    } else {
      const f = fails + 1;
      setFails(f);
      sessionStorage.setItem("hod_cap_fails", String(f));
      if (f >= 5) {
        const lock = Date.now() + 5 * 60 * 1000;
        sessionStorage.setItem("hod_cap_lock", String(lock));
        setError("Too many attempts. Locked for 5 minutes.");
      } else {
        setError(`Incorrect password (${5 - f} attempts left)`);
      }
      setPwd("");
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0A0A0A", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 20, padding: "32px 28px", width: "100%", maxWidth: 360, textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🪩</div>
        <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 20, fontWeight: 900, color: "#F2C744", marginBottom: 6 }}>Captain Login</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginBottom: 24 }}>HOD — House of Dopamine</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (e.g. Ravi)"
          style={{ width: "100%", padding: "14px 16px", borderRadius: 12, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 15, outline: "none", marginBottom: 10, boxSizing: "border-box" }} />
        <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder="Enter captain password"
          onKeyDown={(e) => e.key === "Enter" && tryLogin()}
          style={{ width: "100%", padding: "14px 16px", borderRadius: 12, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 15, outline: "none", marginBottom: 12, boxSizing: "border-box" }} />
        {error && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 10 }}>{error}</div>}
        <button onClick={tryLogin}
          style={{ width: "100%", padding: 14, borderRadius: 12, background: "linear-gradient(135deg,rgba(242,199,68,.9),rgba(160,120,48,.8))", border: "none", color: "#000", fontSize: 15, fontWeight: 900, cursor: "pointer" }}>
          Enter
        </button>
      </div>
    </div>
  );
}

function EditOrderModal({ round, roundIndex, docId, captainName, bookingRef, tableId, floorLabel, customerName, onClose }: {
  round: HodTabRound; roundIndex: number; docId: string; captainName: string;
  bookingRef?: string;
  /** V1 — passed through so the KOT VOID PRINT can route to the same destinations
   *  the original order went to (bar/kitchen/floor printers). */
  tableId: string; floorLabel?: string; customerName?: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<HodOrderItem[]>([...round.items]);
  const [saving, setSaving] = useState(false);
  // V1 — track items that have been removed/reduced relative to the original
  // round so we can write a void log entry when the captain saves. Snapshot of
  // the original printed-KOT items so we can diff exactly what was voided.
  const originalItems = useRef<HodOrderItem[]>([...round.items]).current;
  const isPrintedKot = round.status === "activated" || round.status === "served";
  // V1 — pending void state. When non-null, the VoidReasonModal is shown over
  // the editor; on confirm we run commitChanges with the captured reason. On
  // cancel, we just clear it and let the captain keep editing.
  const [pendingVoid, setPendingVoid] = useState<{
    voided: Array<{ n: string; qty: number; p: number }>; valueLost: number;
  } | null>(null);

  const updateQty = (idx: number, delta: number) => {
    setItems((prev) => {
      const updated = prev.map((it, i) => i === idx ? { ...it, qty: it.qty + delta } : it);
      return updated.filter((it) => it.qty > 0);
    });
  };
  const removeItem = (idx: number) => setItems((prev) => prev.filter((_, i) => i !== idx));

  // V1 — diff originalItems vs current items by name+price; collect what was
  // voided (qty went down or item disappeared). Returns [] when nothing was
  // reduced. Used to gate the manager PIN and to write the void log.
  const computeVoided = (): { voided: Array<{ n: string; qty: number; p: number }>; valueLost: number } => {
    const voided: Array<{ n: string; qty: number; p: number }> = [];
    let valueLost = 0;
    for (const orig of originalItems) {
      const stillThere = items.find((it) => it.n === orig.n && it.p === orig.p);
      const newQty = stillThere?.qty || 0;
      const dropped = orig.qty - newQty;
      if (dropped > 0) {
        voided.push({ n: orig.n, qty: dropped, p: orig.p });
        valueLost += dropped * orig.p;
      }
    }
    return { voided, valueLost };
  };

  // V1 — actually persist the edit + (if voiding from printed KOT) write the
  // void log AND fire a KOT VOID PRINT to the same destinations the original
  // order went to. Apply the item update FIRST so a failed audit can't leave
  // a phantom void; print is fire-and-forget (Khushi fallback: if the void
  // print fails, the void is still in voidLog → Live Monitor + Reports → bar
  // sees it on next refresh; worst case = served drink caught at bill review).
  const commitChanges = async (
    voidedSnapshot: Array<{ n: string; qty: number; p: number }>,
    valueLost: number,
    reason: string,
  ) => {
    setSaving(true);
    try {
      const total = items.reduce((s, it) => s + it.p * it.qty, 0);
      await updateRoundItems(docId, roundIndex, items, total, captainName);
      // V3 anti-fraud #A1 — pre-print silent reductions get LOGGED (no PIN,
      // no friction) so an audit trail exists for "added 5, dropped 2 before
      // print" patterns. Best-effort: append failure must never block the
      // edit itself (captain UX > audit completeness for this silent path).
      if (!isPrintedKot && voidedSnapshot.length > 0) {
        recordSilentPrePrintEdit(docId, {
          by: captainName, roundNum: round.roundNum,
          removed: voidedSnapshot, valueRemoved: valueLost,
          tableId, customerName,
        }, bookingRef).catch((e) => console.warn("[silent-edit] log failed", e));
      }
      if (isPrintedKot && voidedSnapshot.length > 0) {
        await recordKotVoid(docId, {
          by: captainName, roundNum: round.roundNum, roundStatus: round.status || "activated",
          voided: voidedSnapshot, valueLost, reason: reason.trim() || undefined,
          customerName, customerPhone: undefined, tableId,
        }, bookingRef);
        // V3 anti-fraud #A2 — increment per-captain-per-night void counter.
        // Auto-suspends captain from FURTHER voids if cap reached. Best-effort:
        // failure here doesn't block the void itself (manager already approved).
        try {
          const stats = await recordCaptainVoidUsage(captainName, valueLost);
          if (stats.suspended) {
            alert(`🚫 ${captainName.toUpperCase()} HAS REACHED TONIGHT'S VOID CAP\n\n` +
              `${stats.voidCount} voids · ₹${stats.voidValue} total.\n\n` +
              `Further voids are LOCKED until an Admin unlocks from\nAdmin Panel → 🔓 Locks tab.`);
          }
        } catch (e) { console.warn("[void-cap] increment failed", e); }
        // Fire-and-forget VOID slip to the bar/kitchen printers. Map the
        // voided diff back into HodOrderItem shape so destination routing
        // (food vs drink, veg flag) lands on the right printer.
        printKOTVoid({
          tableId, floorLabel, customerName, staff: captainName,
          roundNum: round.roundNum, valueLost, reason: reason.trim() || undefined,
          voidedItems: voidedSnapshot.map((v) => {
            const orig = originalItems.find((o) => o.n === v.n && o.p === v.p);
            return { n: v.n, p: v.p, qty: v.qty, cat: orig?.cat, t: orig?.t, v: orig?.v };
          }),
        }).catch(() => {});
      }
      onClose();
    } catch (e: any) {
      alert(e.message);
      setSaving(false);
    }
  };

  const save = async () => {
    const { voided, valueLost } = computeVoided();
    // V3 anti-fraud #A1 — pre-print path: still SILENT for the captain (no
    // PIN, no slip), but the diff IS recorded into silentEditLog so admins
    // can spot the "add 5, drop 2 before print" pattern in Live Monitor +
    // Audit page. Pure additions (voided=[]) stay log-free.
    if (!isPrintedKot) {
      await commitChanges(voided, valueLost, "");
      return;
    }
    if (voided.length === 0) {
      await commitChanges([], 0, "");
      return;
    }
    // V3 anti-fraud #A2 — block immediately if this captain is already
    // suspended from voiding tonight. Surfaces the call-admin message before
    // captain wastes effort entering reason + PIN.
    try { await assertCaptainCanVoid(captainName); }
    catch (e: unknown) { alert(e instanceof Error ? e.message : "Void blocked."); return; }
    // V1 — post-print path: pop the structured Void Reason modal. PIN +
    // dropdown reason + optional notes captured before any write happens.
    setPendingVoid({ voided, valueLost });
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "rgba(20,18,30,1)", border: "1px solid rgba(242,199,68,.3)", borderRadius: 20, padding: 24, width: "100%", maxWidth: 400 }}>
        <div style={{ fontSize: 16, fontWeight: 900, color: "#F2C744", marginBottom: 16 }}>Edit Round {round.roundNum}</div>
        {items.map((it, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
            <div style={{ flex: 1, fontSize: 13, color: "#fff" }}>{it.n}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={() => updateQty(i, -1)} style={{ width: 28, height: 28, borderRadius: 6, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", cursor: "pointer" }}>−</button>
              <span style={{ fontSize: 14, fontWeight: 800, color: "#F2C744", minWidth: 20, textAlign: "center" }}>{it.qty}</span>
              <button onClick={() => updateQty(i, 1)} style={{ width: 28, height: 28, borderRadius: 6, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", cursor: "pointer" }}>+</button>
              <span style={{ fontSize: 13, color: "#F2C744", minWidth: 50, textAlign: "right" }}>₹{it.p * it.qty}</span>
              <button onClick={() => removeItem(i)} style={{ width: 28, height: 28, borderRadius: 6, background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.3)", color: "#EF4444", cursor: "pointer", fontSize: 14 }}>×</button>
            </div>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 0", fontWeight: 900, fontSize: 15 }}>
          <span style={{ color: "#fff" }}>Total</span>
          <span style={{ color: "#F2C744" }}>₹{items.reduce((s, it) => s + it.p * it.qty, 0)}</span>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button onClick={onClose} style={{ flex: 1, padding: 12, borderRadius: 10, background: "transparent", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.5)", fontSize: 13, cursor: "pointer" }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ flex: 1, padding: 12, borderRadius: 10, background: "rgba(242,199,68,.15)", border: "1px solid rgba(242,199,68,.3)", color: "#F2C744", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
      {pendingVoid && (
        <VoidReasonModal
          voided={pendingVoid.voided}
          valueLost={pendingVoid.valueLost}
          roundNum={round.roundNum}
          onCancel={() => setPendingVoid(null)}
          onConfirm={async ({ reason }) => {
            const snap = pendingVoid;
            setPendingVoid(null);
            await commitChanges(snap.voided, snap.valueLost, reason);
          }}
        />
      )}
    </div>
  );
}

function ReassignTableModal({ reservation, existingTables, allReservations, captainName, onClose }: {
  reservation: HodTableReservation; existingTables: string[]; allReservations: HodTableReservation[]; captainName: string; onClose: () => void;
}) {
  const [newTable, setNewTable] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const doReassign = async () => {
    if (!newTable) { setError("Select a new table"); return; }
    if (newTable === reservation.tableId) { setError("Same table selected"); return; }
    setSaving(true);
    try {
      const opt = TABLE_OPTIONS.find((g) => g.tables.includes(newTable));
      await reassignTable(reservation._docId, newTable, opt?.floor || "", opt?.label || "", captainName);
      onClose();
    } catch (e: any) { setError(e.message); }
    setSaving(false);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "rgba(20,18,30,1)", border: "1px solid rgba(242,199,68,.3)", borderRadius: 20, padding: 24, width: "100%", maxWidth: 400, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ fontSize: 18, fontWeight: 900, color: "#F2C744", marginBottom: 4 }}>🔄 Reassign Table</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginBottom: 4 }}>
          Moving <b>{reservation.customerName}</b> from <span style={{ color: "#EF4444", fontWeight: 800 }}>{reservation.tableId}</span>
        </div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,.3)", marginBottom: 16 }}>All orders move with the booking</div>

        <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 6 }}>Select New Table *</div>
        <div style={{ marginBottom: 16 }}>
          {TABLE_OPTIONS.map((group) => (
            <div key={group.floor} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,.3)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 }}>{group.label}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {group.tables.map((t) => {
                  // Time-aware: a table booked for an unrelated slot should
                  // NOT block reassignment to it for THIS reservation's slot.
                  const targetMin = parseClockToMinutes(reservation.arrivalTime) ?? nowMinutesIST();
                  const occupant = tableOccupantAt(t, targetMin, allReservations);
                  const occupied = !!occupant && occupant._docId !== reservation._docId;
                  const isCurrent = t === reservation.tableId;
                  const isSelected = newTable === t;
                  // Filled green = available for this slot; filled red = taken
                  // for this slot. Yellow ring = your current pick. Orange =
                  // the reservation's existing table.
                  const bg = isSelected ? "#F2C744"
                    : isCurrent ? "rgba(242,199,68,.18)"
                    : occupied ? "#DC2626" : "#16A34A";
                  const border = isSelected ? "#F2C744"
                    : isCurrent ? "#F2C744"
                    : occupied ? "#B91C1C" : "#15803D";
                  const color = isSelected ? "#0A0A0A"
                    : isCurrent ? "#F2C744"
                    : "#FFFFFF";
                  return (
                    <button key={t} onClick={() => !occupied && !isCurrent && setNewTable(t)} disabled={occupied || isCurrent}
                      title={occupied && occupant ? `Taken — ${occupant.customerName || ""} ${occupant.arrivalTime || ""}`.trim() : ""}
                      style={{ padding: "6px 10px", borderRadius: 8, fontSize: 11, fontWeight: 800,
                        cursor: occupied || isCurrent ? "not-allowed" : "pointer",
                        background: bg, border: `1px solid ${border}`, color,
                        opacity: occupied && !isCurrent ? 0.85 : 1 }}>
                      {t}{isCurrent ? " ●" : ""}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {newTable && (
          <div style={{ background: "rgba(242,199,68,.06)", border: "1px solid rgba(242,199,68,.2)", borderRadius: 10, padding: 10, marginBottom: 16, fontSize: 12, color: "#F2C744" }}>
            {reservation.tableId} → {newTable} ({TABLE_OPTIONS.find(g => g.tables.includes(newTable))?.label})
          </div>
        )}

        {error && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 10 }}>{error}</div>}
        <button onClick={doReassign} disabled={saving || !newTable}
          style={{ width: "100%", padding: 14, borderRadius: 12, background: newTable ? "linear-gradient(135deg,rgba(242,199,68,.9),rgba(160,40,32,.8))" : "rgba(255,255,255,.06)", border: "none", color: newTable ? "#fff" : "rgba(255,255,255,.3)", fontSize: 15, fontWeight: 900, cursor: newTable ? "pointer" : "not-allowed", marginBottom: 10 }}>
          {saving ? "Reassigning..." : "Confirm Reassignment"}
        </button>
        <button onClick={onClose} style={{ width: "100%", padding: 12, borderRadius: 12, background: "transparent", border: "none", color: "rgba(255,255,255,.4)", fontSize: 13, cursor: "pointer" }}>Cancel</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 2026-05-15 — WalletScanModal (Khushi: Captain × Cover wallet redemption)
// ────────────────────────────────────────────────────────────────────────
// Three lookup tabs: 📷 SCAN (camera) · 📱 PHONE · 🎟 REF. After lookup,
// shows wallet name + phone + balance + expiry. Confirm → calls
// redeemFromWalletAtTable which auto-clamps amount to min(remaining,
// balance) — no captain math, no partial entry. The reservation prop
// auto-refreshes from Firestore subscription so the parent modal sees
// the new walletRedemptions[] entry without manual re-read.
// ════════════════════════════════════════════════════════════════════════
function WalletScanModal({ reservation, remaining, captainName, onClose }: {
  reservation: HodTableReservation;
  remaining: number;
  captainName: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"scan" | "phone" | "ref">("scan");
  const [showCamera, setShowCamera] = useState(false);
  const [needle, setNeedle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [found, setFound] = useState<HodCover | null>(null);
  const [success, setSuccess] = useState<{ amount: number; newBalance: number; name: string } | null>(null);

  const lookup = async (raw: string) => {
    setError(""); setFound(null);
    if (!raw.trim()) { setError("Enter a phone or ref"); return; }
    setBusy(true);
    try {
      const r = await findCoverForRedemption(raw);
      if (!r.ok) { setError(r.reason); setBusy(false); return; }
      const c = r.cover;
      // Pre-flight validations (UX — backend re-checks these too).
      if (!c.coverBalance || c.coverBalance <= 0) {
        setError(`Wallet ${c.ref || c.id} has zero balance`);
      } else if (c.expiresAt && new Date(c.expiresAt).getTime() < Date.now()) {
        setError(`Wallet ${c.ref || c.id} expired at ${new Date(c.expiresAt).toLocaleString()}`);
      } else {
        // Loophole #10 / Q5 — already redeemed at this table?
        const already = (reservation.walletRedemptions || []).find((e) => e.walletRef === (c.ref || c.id));
        if (already) {
          setError(`This wallet is already redeemed here (₹${already.amount}). Undo it first to re-scan.`);
        } else {
          setFound(c);
        }
      }
    } catch (e: any) {
      setError(e.message || String(e));
    }
    setBusy(false);
  };

  const onScanResult = (raw: string) => {
    setShowCamera(false);
    setNeedle(raw);
    lookup(raw);
  };

  const confirmRedeem = async () => {
    if (!found) return;
    setBusy(true); setError("");
    try {
      // Pass the Firestore DOC ID (found.id) — NOT the public ref. Doc id and
      // ref differ for table-source covers; an orphan empty doc may exist at
      // the public-ref id and would 0-balance-throw if we wrote there.
      const docId = found.id;
      // billCap = remaining + walletPaidSoFar = the bill's TOTAL final amount.
      // Server-side guard prevents over-deduction even on stale modal / race.
      const walletPaidSoFar = (reservation.walletRedemptions || []).reduce((s, r) => s + (r.amount || 0), 0);
      const billCap = remaining + walletPaidSoFar;
      const result = await redeemFromWalletAtTable(reservation._docId, docId, remaining, captainName, billCap);
      setSuccess({ amount: result.amountRedeemed, newBalance: result.newWalletBalance, name: found.name || found.ref || docId });
    } catch (e: any) {
      setError(e.message || String(e));
    }
    setBusy(false);
  };

  // Loophole #2 — name/phone mismatch warning
  const nameMismatch = found && reservation.customerName &&
    String(found.name || "").toLowerCase().trim() !== String(reservation.customerName).toLowerCase().trim();
  const phoneMismatch = found && reservation.phone && found.phone &&
    String(found.phone).replace(/\D/g, "") !== String(reservation.phone).replace(/\D/g, "");

  if (showCamera) {
    return <QrScanner onResult={onScanResult} onClose={() => setShowCamera(false)} />;
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.92)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "rgba(20,18,30,1)", border: "1px solid rgba(242,199,68,.4)", borderRadius: 20, padding: 22, width: "100%", maxWidth: 400, maxHeight: "92vh", overflowY: "auto" }}>
        <div style={{ fontSize: 17, fontWeight: 900, color: "#F2C744", marginBottom: 4 }}>🎫 REDEEM FROM WALLET</div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 16 }}>
          Table {reservation.tableId} · Bill remaining: <span style={{ color: "#F2C744", fontWeight: 800 }}>{formatINR(remaining)}</span>
        </div>

        {success ? (
          <>
            <div style={{ background: "rgba(34,197,94,.12)", border: "1px solid rgba(34,197,94,.5)", borderRadius: 12, padding: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#22C55E", marginBottom: 6 }}>✅ REDEEMED {formatINR(success.amount)}</div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,.7)" }}>From <b>{success.name}</b>'s wallet</div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,.7)", marginTop: 4 }}>New balance: <b>{formatINR(success.newBalance)}</b></div>
            </div>
            <button onClick={onClose}
              style={{ width: "100%", padding: 14, borderRadius: 12, background: "linear-gradient(135deg,rgba(242,199,68,.9),rgba(160,40,32,.8))", border: "none", color: "#fff", fontSize: 14, fontWeight: 900, cursor: "pointer" }}>
              ← Back to Mark Paid
            </button>
          </>
        ) : (
          <>
            {/* Tabs */}
            <div style={{ display: "flex", gap: 4, marginBottom: 14, padding: 4, background: "rgba(0,0,0,.3)", borderRadius: 10 }}>
              {([
                { k: "scan", label: "📷 SCAN" },
                { k: "phone", label: "📱 PHONE" },
                { k: "ref", label: "🎟 REF" },
              ] as const).map((t) => (
                <button key={t.k} onClick={() => { setTab(t.k); setError(""); setFound(null); setNeedle(""); }}
                  style={{ flex: 1, padding: "8px 4px", borderRadius: 7, fontSize: 11, fontWeight: 800, cursor: "pointer", border: "none",
                    background: tab === t.k ? "rgba(242,199,68,.18)" : "transparent",
                    color: tab === t.k ? "#F2C744" : "rgba(255,255,255,.5)" }}>
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "scan" && (
              <button onClick={() => { setError(""); setFound(null); setShowCamera(true); }}
                style={{ width: "100%", padding: 18, borderRadius: 12, background: "rgba(242,199,68,.1)", border: "2px dashed rgba(242,199,68,.4)", color: "#F2C744", fontSize: 14, fontWeight: 800, cursor: "pointer", marginBottom: 14 }}>
                📷 OPEN CAMERA · POINT AT QR
              </button>
            )}

            {tab !== "scan" && (
              <div style={{ marginBottom: 14 }}>
                <input
                  value={needle}
                  onChange={(e) => setNeedle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") lookup(needle); }}
                  placeholder={tab === "phone" ? "9611111261" : "HOD-MP6KSRBR"}
                  inputMode={tab === "phone" ? "numeric" : "text"}
                  autoFocus
                  style={{ width: "100%", padding: "12px 14px", borderRadius: 10, background: "rgba(0,0,0,.3)", border: "1px solid rgba(255,255,255,.15)", color: "#fff", fontSize: 15, outline: "none", boxSizing: "border-box", marginBottom: 8 }} />
                <button onClick={() => lookup(needle)} disabled={busy || !needle.trim()}
                  style={{ width: "100%", padding: 12, borderRadius: 10, background: needle.trim() ? "rgba(242,199,68,.2)" : "rgba(255,255,255,.04)", border: "1px solid rgba(242,199,68,.4)", color: needle.trim() ? "#F2C744" : "rgba(255,255,255,.3)", fontSize: 13, fontWeight: 800, cursor: needle.trim() ? "pointer" : "not-allowed" }}>
                  {busy ? "Searching…" : "🔍 LOOK UP WALLET"}
                </button>
              </div>
            )}

            {error && (
              <div style={{ padding: 10, marginBottom: 12, borderRadius: 8, background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.4)", color: "#FCA5A5", fontSize: 12, fontWeight: 600 }}>
                ⚠ {error}
              </div>
            )}

            {found && (
              <div style={{ padding: 14, marginBottom: 14, borderRadius: 12, background: "rgba(34,197,94,.06)", border: "1px solid rgba(34,197,94,.3)" }}>
                <div style={{ fontSize: 14, fontWeight: 900, color: "#fff", marginBottom: 4 }}>{found.name || "—"}</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 2 }}>📱 {found.phone || "—"}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", marginBottom: 8, fontFamily: "monospace" }}>{found.ref || found.id}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: "rgba(0,0,0,.3)", borderRadius: 8 }}>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,.5)" }}>Available balance</span>
                  <span style={{ fontSize: 18, fontWeight: 900, color: "#22C55E" }}>{formatINR(found.coverBalance || 0)}</span>
                </div>
                {(nameMismatch || phoneMismatch) && (
                  <div style={{ marginTop: 10, padding: 8, borderRadius: 6, background: "rgba(245,158,11,.15)", border: "1px solid rgba(245,158,11,.5)", color: "#FBBF24", fontSize: 10, fontWeight: 700, lineHeight: 1.4 }}>
                    ⚠ NAME/PHONE DOESN'T MATCH TABLE ({reservation.customerName || "—"} · {reservation.phone || "—"}). Confirm with customer this is THEIR wallet before redeeming.
                  </div>
                )}
                <div style={{ marginTop: 12, padding: "8px 10px", background: "rgba(242,199,68,.1)", borderRadius: 6, fontSize: 11, color: "#F2C744", fontWeight: 700, textAlign: "center" }}>
                  Will deduct {formatINR(Math.min(remaining, found.coverBalance || 0))} ({remaining > (found.coverBalance || 0) ? "full balance" : "bill remaining"})
                </div>
              </div>
            )}

            {found && (
              <button onClick={confirmRedeem} disabled={busy}
                style={{ width: "100%", padding: 14, borderRadius: 12, background: "linear-gradient(135deg,#22C55E,#15803D)", border: "none", color: "#fff", fontSize: 15, fontWeight: 900, cursor: "pointer", marginBottom: 10 }}>
                {busy ? "Redeeming…" : `✅ REDEEM ${formatINR(Math.min(remaining, found.coverBalance || 0))}`}
              </button>
            )}

            <button onClick={onClose}
              style={{ width: "100%", padding: 12, borderRadius: 12, background: "transparent", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.5)", fontSize: 13, cursor: "pointer" }}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function MarkPaidModal({ reservation, captainName, onClose }: {
  reservation: HodTableReservation; captainName: string; onClose: () => void;
}) {
  // 🔴 BUG FIX 2026-05-07: tabTotal stored in Firestore is already grandTotal
  // (subtotal + SC + GST from computeHodBreakdown). The old code re-applied
  // SC + GST on top → double taxation (₹534 → ₹617 stored → ₹710 charged).
  // Fix: derive the TRUE subtotal from items, then recompute SC + GST
  // correctly via computeHodBreakdown (which excludes alcohol from GST).
  const allItems = (reservation.tabRounds || []).flatMap(r => r.items || []);
  const baseBreakdown = computeHodBreakdown(allItems);
  const subtotal = baseBreakdown.subtotal;
  // Legacy display field — keep `tabTotal` name for the UI label, but it now
  // means the items subtotal (pre-tax), not the stored grandTotal.
  const tabTotal = subtotal;
  const aggName = reservation.aggregator || "inhouse";
  const aggDiscount = reservation.aggregatorDiscount ?? getAggregatorDiscount(aggName);
  const isAggregator = aggName !== "inhouse" && aggDiscount > 0;

  const [payMethod, setPayMethod] = useState<string>(isAggregator ? "aggregator" : "cash");
  // Pre-fill manual discount with whatever the captain set on the table card (Apply panel),
  // so a custom discount applied at the table flows into Cash/Card/UPI bill calc.
  const [manualDiscount, setManualDiscount] = useState<number>(isAggregator ? 0 : (aggDiscount || 0));
  const [serviceCharge, setServiceCharge] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // 🔴 2026-05-15 — themed in-modal "Did you collect ₹X?" dialog (replaces
  // the ugly native window.confirm). Only shown on mixed wallet+cash path.
  const [showCollectConfirm, setShowCollectConfirm] = useState(false);
  // 🔀 Split payment — captain can split final amount across cash/card/upi.
  // Only available for non-aggregator paths. Sum must equal finalAmount.
  const [splitMode, setSplitMode] = useState(false);
  const [splitCash, setSplitCash] = useState<number>(0);
  const [splitCard, setSplitCard] = useState<number>(0);
  const [splitUpi, setSplitUpi] = useState<number>(0);

  // 🔴 2026-05-12 — Aggregator bills no longer have the discount baked into
  // the printed customer bill. The customer already saw the discount on
  // Zomato/Swiggy/EazyDiner before they walked in; the venue's tablet must
  // print the FULL invoice (no discount applied) so the receipt matches the
  // F&B order ledger. The aggregator-side discount is still recorded on the
  // payment so admin reports can compute "amount actually received from
  // aggregator" alongside the gross.
  const discountPct = payMethod === "aggregator" ? 0 : manualDiscount;
  const discountAmt = Math.round(subtotal * discountPct / 100);
  const afterDiscount = subtotal - discountAmt;
  // Scale all item prices by (1 - discount) and re-run computeHodBreakdown so
  // SC + GST are computed with the correct rules (GST excludes alcohol, SC
  // base is subtotal, GST base is food + non-alc + SC). This matches the
  // bill print engine exactly so the on-screen amount = printed bill amount.
  const scaleFactor = subtotal > 0 ? afterDiscount / subtotal : 1;
  const scaledItems = allItems.map(it => ({ ...it, p: (it.p || 0) * scaleFactor }));
  const discBreakdown = computeHodBreakdown(scaledItems);
  const scAmt = serviceCharge ? Math.round(discBreakdown.serviceCharge) : 0;
  // GST base must exclude SC if SC is waived → recompute against waived base.
  const taxAmt = serviceCharge
    ? Math.round(discBreakdown.gst)
    : Math.round((discBreakdown.foodSubtotal + discBreakdown.nonAlcSubtotal) * GST_RATE);
  const finalAmount = afterDiscount + scAmt + taxAmt;
  // 🔴 2026-05-12 — Aggregator-net (what the venue actually nets after the
  // platform's commission/discount) — used for reports only, NOT for the
  // customer bill. MUST be computed off `finalAmount` (subtotal + SC + GST),
  // because the customer pays the aggregator the FULL invoice and the
  // platform's commission is taken off that full amount — not off the bare
  // food/drink subtotal. (Earlier version used `subtotal` and underreported
  // venue-net by ~SC+GST × discount.)
  const aggregatorNetAmount = payMethod === "aggregator"
    ? Math.round(finalAmount * (1 - (aggDiscount || 0) / 100))
    : undefined;

  // ── 2026-05-15 — Khushi: Captain × Cover wallet redemption ──
  // walletRedemptions live on the reservation doc (written atomically by
  // redeemFromWalletAtTable). We READ them straight from the prop so the
  // Firestore subscription auto-refreshes the modal after each redeem/undo
  // — no local copy to drift out of sync.
  const walletRedemptions: WalletRedemption[] = reservation.walletRedemptions || [];
  const walletPaidSoFar = walletRedemptions.reduce((s, r) => s + (r.amount || 0), 0);
  // payable = what's still owed via cash/card/UPI/split AFTER wallet hits.
  // Zero = fully covered by wallet, payment buttons are hidden.
  const payable = Math.max(0, Math.round((finalAmount - walletPaidSoFar) * 100) / 100);
  const [showWalletScan, setShowWalletScan] = useState(false);
  const [undoBusy, setUndoBusy] = useState<string | null>(null);
  const [walletErr, setWalletErr] = useState("");
  // Q6 — aggregator BOOKINGS block wallet redemption entirely (separate
  // accounting — Zomato/Swiggy/EazyDiner already collected/discounted at the
  // platform). Source-level check (not just payMethod) so a captain switching
  // payChannel from aggregator → in-house can't bypass the block. (Architect
  // review 2026-05-15.)
  const walletAllowed = !isAggregator && payMethod !== "aggregator";

  const splitTotal = splitCash + splitCard + splitUpi;
  // Split must equal `payable` (NOT finalAmount) — the wallet slice already
  // settled separately. Captain only enters the cash/card/UPI remainder.
  const splitDiff = payable - splitTotal;

  const undoWallet = async (txId: string) => {
    setUndoBusy(txId); setWalletErr("");
    try { await undoWalletRedemption(reservation._docId, txId, captainName); }
    catch (e: any) { setWalletErr(e.message || String(e)); }
    setUndoBusy(null);
  };

  const confirm = async () => {
    if (finalAmount <= 0) { setError("Invalid amount"); return; }
    if (splitMode) {
      if (splitTotal !== payable) {
        setError(`Split total ₹${splitTotal} must equal remaining ₹${payable} (off by ₹${Math.abs(splitDiff)}).`);
        return;
      }
      const nonZero = [splitCash, splitCard, splitUpi].filter((n) => n > 0).length;
      if (nonZero < 2) { setError("Split needs at least 2 non-zero amounts. Use single payment instead."); return; }
    }
    // 2026-05-15 — Q6: aggregator + wallet must NOT mix (separate accounting).
    if (payMethod === "aggregator" && walletPaidSoFar > 0) {
      setError("Aggregator payments can't combine with wallet redemption. Undo the wallet redemption(s) first or switch to In-House.");
      return;
    }
    // D1/D2 — Manager-PIN gates for high manual discount and SC waiver. We
    // collect over-threshold actions into overrideEntries so they get logged
    // atomically with the payment in markTablePaid (audit-page surfaces them).
    const overrides: Array<{
      kind: "high-discount" | "sc-waiver";
      valueBefore: number; valueAfter: number; tabTotal: number; reason: string;
    }> = [];
    // D1 — gate the EFFECTIVE discount (discountPct) regardless of payment
    // path. Earlier version only gated `manualDiscount` on Cash/Card/UPI which
    // let a captain bypass via the aggregator path with a custom discount set
    // pre-bill on the table card. We now gate the live `discountPct`. The
    // setReservationAggregator panel (handleAggChange) also gates pre-bill so
    // a manager PIN approval there flows through here without re-prompting
    // (the panel writes the override log; we only re-prompt if the captain
    // somehow lands here with discountPct above threshold and NO panel
    // approval — defense in depth).
    if (discountPct > HIGH_DISCOUNT_PIN_THRESHOLD) {
      // Skip the prompt if this discount was already approved at the table-
      // card panel (override log entry exists for current pct). This avoids
      // double-prompting the captain. Conservative match: if any prior
      // override entry for this table has valueAfter == discountPct, trust it.
      const priorApprovals = Array.isArray(reservation.discountOverrideLog)
        ? reservation.discountOverrideLog : [];
      const alreadyApproved = priorApprovals.some(
        (o) => Number(o.valueAfter) === Number(discountPct)
      );
      // ALSO skip when payMethod = aggregator AND the discount EXACTLY
      // matches the aggregator's published rate (e.g. Zomato's standard
      // 30%). The customer paid that rate to Zomato — captain isn't deciding
      // anything. ANY deviation (e.g. 30% → 35%) keeps the popup so a
      // captain can't quietly inflate the discount under aggregator cover.
      // `aggDiscount` is sourced from the aggregator config above (line ~620).
      const aggregatorRateMatch =
        payMethod === "aggregator" &&
        aggName !== "inhouse" &&
        Number(discountPct) === Number(aggDiscount);
      if (!alreadyApproved && !aggregatorRateMatch) {
        const ok = await requireManagerPin(
          `High effective discount: ${discountPct}% on ₹${tabTotal} tab\n` +
          `(threshold ${HIGH_DISCOUNT_PIN_THRESHOLD}%, payment via ${payMethod === "aggregator" ? aggName : payMethod})\n` +
          `Discount value: ₹${discountAmt}`
        );
        if (!ok) { setError("Manager PIN required for this discount."); return; }
        const reason = window.prompt(`Reason for ${discountPct}% discount:`) || "";
        overrides.push({
          kind: "high-discount", valueBefore: 0, valueAfter: discountPct,
          tabTotal, reason: reason.trim() || "(no reason given)",
        });
      }
    }
    // D2 — Service Charge waiver on a sizeable tab needs Manager PIN.
    if (!serviceCharge && tabTotal >= SC_WAIVER_PIN_FLOOR) {
      const expectedSc = Math.round((tabTotal - discountAmt) * SERVICE_CHARGE_RATE);
      const ok = await requireManagerPin(
        `Service Charge WAIVED on ₹${tabTotal} tab\n` +
        `(floor ₹${SC_WAIVER_PIN_FLOOR})\n` +
        `SC value waived: ₹${expectedSc}`
      );
      if (!ok) { setError("Manager PIN required to waive Service Charge."); return; }
      const reason = window.prompt("Reason for waiving Service Charge:") || "";
      overrides.push({
        kind: "sc-waiver", valueBefore: expectedSc, valueAfter: 0,
        tabTotal, reason: reason.trim() || "(no reason given)",
      });
    }
    setSaving(true);
    try {
      const splits = splitMode && payable > 0
        ? [
            { method: "cash", amount: splitCash },
            { method: "card", amount: splitCard },
            { method: "upi",  amount: splitUpi  },
          ].filter((s) => s.amount > 0)
        : undefined;
      // 2026-05-15 — payable === 0 means wallet covered the whole bill, no
      // cash/card/UPI side. methodLabel reflects what the captain ACTUALLY
      // collected outside the wallet:
      //   wallet only           → "wallet"
      //   wallet + cash         → "wallet+cash"
      //   wallet + split:cash+upi → "wallet+split:cash+upi"
      const cashLabel = payable === 0
        ? ""
        : (splits
            ? `split:${splits.map((s) => s.method).join("+")}`
            : (payMethod === "aggregator" ? aggName : payMethod));
      const methodLabel = walletPaidSoFar > 0
        ? (cashLabel ? `wallet+${cashLabel}` : "wallet")
        : cashLabel;
      await markTablePaid(reservation._docId, {
        amount: finalAmount,
        method: methodLabel,
        captainName,
        // 2026-05-15 — sum of walletRedemptions[].amount; reports subtract this
        // from `amount` to get true cash/card/UPI collected for EOD reconcile.
        walletPaidAmount: walletPaidSoFar > 0 ? walletPaidSoFar : undefined,
        aggregator: payMethod === "aggregator" ? aggName : undefined,
        aggregatorDiscount: payMethod === "aggregator" ? aggDiscount : undefined,
        // 🔴 Net amount the venue receives from the aggregator after their
        // platform discount is settled. Reports show this side-by-side with
        // `amount` so admin can reconcile what was billed vs what was paid.
        aggregatorNetAmount,
        discountPercent: discountPct || undefined,
        discountAmount: discountAmt || undefined,
        serviceChargeAmount: scAmt || undefined,
        serviceChargeApplied: serviceCharge,
        taxAmount: taxAmt || undefined,
        overrideEntries: overrides.length > 0 ? overrides : undefined,
        splits,
      }, reservation.bookingRef);
      onClose();
    } catch (e: any) { setError(e.message); }
    setSaving(false);
  };

  const methods = payMethod === "aggregator"
    ? [{ key: "aggregator", label: `Via ${AGGREGATOR_OPTIONS.find((a) => a.value === aggName)?.label || aggName}` }]
    : [{ key: "cash", label: "💵 Cash" }, { key: "card", label: "💳 Card" }, { key: "upi", label: "📱 UPI" }];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "rgba(20,18,30,1)", border: "1px solid rgba(242,199,68,.3)", borderRadius: 20, padding: 24, width: "100%", maxWidth: 380, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ fontSize: 18, fontWeight: 900, color: "#fff", marginBottom: 4 }}>Mark Table Paid</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginBottom: 20 }}>
          {reservation.tableId} · {reservation.customerName}
        </div>

        <div style={{ background: "rgba(242,199,68,.06)", border: "1px solid rgba(242,199,68,.15)", borderRadius: 12, padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
            <span style={{ color: "rgba(255,255,255,.5)" }}>Tab Total</span>
            <span style={{ fontWeight: 800, color: "#F2C744" }}>{formatINR(tabTotal)}</span>
          </div>
          {discountPct > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
              <span style={{ color: "#A02820" }}>Discount ({discountPct}%)</span>
              <span style={{ fontWeight: 800, color: "#A02820" }}>-{formatINR(discountAmt)}</span>
            </div>
          )}
          {/* 🔴 2026-05-12 — Aggregator info-only line. Customer pays the
              full invoice; admin reports record the platform-net separately. */}
          {payMethod === "aggregator" && aggDiscount > 0 && (
            <div style={{ marginTop: 4, padding: "6px 8px", borderRadius: 4,
              background: "rgba(160,40,32,.10)", border: "1px solid rgba(160,40,32,.35)",
              fontSize: 10, color: "#FCA5A5", lineHeight: 1.5 }}>
              ℹ {aggName.toUpperCase()} discount ({aggDiscount}%) is NOT applied
              to the customer bill — full ₹{formatINR(subtotal)} is billed.
              Reports will show venue net ≈ {formatINR(aggregatorNetAmount || 0)}.
            </div>
          )}
          {serviceCharge && (
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
              <span style={{ color: "rgba(255,255,255,.5)" }}>Service Charge (10%)</span>
              <span style={{ fontWeight: 700, color: "rgba(255,255,255,.6)" }}>+{formatINR(scAmt)}</span>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
            <span style={{ color: "rgba(255,255,255,.5)" }}>GST (5%)</span>
            <span style={{ fontWeight: 700, color: "rgba(255,255,255,.6)" }}>+{formatINR(taxAmt)}</span>
          </div>
          <div style={{ borderTop: "1px solid rgba(255,255,255,.08)", paddingTop: 8, display: "flex", justifyContent: "space-between", fontSize: 16 }}>
            <span style={{ fontWeight: 900, color: "#fff" }}>Final Amount</span>
            <span style={{ fontWeight: 900, color: "#F2C744" }}>{formatINR(finalAmount)}</span>
          </div>
        </div>

        {/* ── 2026-05-15 — Khushi: Captain × Cover wallet redemption ── */}
        <div style={{ marginBottom: 16, padding: 12, borderRadius: 12,
          background: walletPaidSoFar > 0 ? "rgba(34,197,94,.06)" : "rgba(242,199,68,.04)",
          border: `1px solid ${walletPaidSoFar > 0 ? "rgba(34,197,94,.3)" : "rgba(242,199,68,.2)"}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: walletRedemptions.length > 0 ? 10 : 0 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: walletPaidSoFar > 0 ? "#22C55E" : "#F2C744", letterSpacing: 0.5 }}>
              🎫 CUSTOMER WALLET
            </span>
            {walletPaidSoFar > 0 && (
              <span style={{ fontSize: 11, fontWeight: 800, color: "#22C55E" }}>
                {formatINR(walletPaidSoFar)} REDEEMED
              </span>
            )}
          </div>

          {walletRedemptions.map((w) => (
            <div key={w.txId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", marginBottom: 4, borderRadius: 6, background: "rgba(0,0,0,.25)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {w.walletName || "—"} <span style={{ color: "rgba(255,255,255,.4)", fontWeight: 500 }}>· {w.walletPhone || "—"}</span>
                </div>
                <div style={{ fontSize: 9, color: "rgba(255,255,255,.4)", fontFamily: "monospace" }}>{w.walletRef}</div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 900, color: "#22C55E" }}>−{formatINR(w.amount)}</div>
              <button onClick={() => undoWallet(w.txId)} disabled={undoBusy === w.txId}
                title="Refund this wallet hit"
                style={{ padding: "4px 8px", borderRadius: 6, background: "rgba(239,68,68,.15)", border: "1px solid rgba(239,68,68,.4)", color: "#FCA5A5", fontSize: 10, fontWeight: 800, cursor: "pointer" }}>
                {undoBusy === w.txId ? "…" : "↶ UNDO"}
              </button>
            </div>
          ))}

          {walletErr && (
            <div style={{ marginTop: 6, padding: 6, borderRadius: 4, background: "rgba(239,68,68,.1)", color: "#FCA5A5", fontSize: 10, fontWeight: 600 }}>⚠ {walletErr}</div>
          )}

          {walletPaidSoFar > 0 && (
            payable === 0 ? (
              <div style={{ marginTop: 8, padding: "10px 12px", borderRadius: 8, background: "rgba(34,197,94,.12)", border: "1px solid rgba(34,197,94,.4)", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                <span style={{ color: "rgba(255,255,255,.7)", fontWeight: 700 }}>Remaining</span>
                <span style={{ fontWeight: 900, color: "#22C55E" }}>✅ FULLY PAID BY WALLET</span>
              </div>
            ) : (
              // 🔴 2026-05-15 (Khushi spec) — when wallet only PARTIALLY covers
              // the bill, the captain MUST physically collect ₹{payable} from
              // the customer in cash/card/UPI. Make this number unmissable so
              // bartenders/captains in a noisy floor don't accidentally close
              // a bill thinking the wallet covered everything.
              <div style={{ marginTop: 10, padding: "14px 16px", borderRadius: 10,
                background: "linear-gradient(135deg,rgba(242,199,68,.18),rgba(160,40,32,.12))",
                border: "2px solid rgba(242,199,68,.7)",
                boxShadow: "0 0 0 3px rgba(242,199,68,.08), 0 4px 16px rgba(242,199,68,.15)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: "#F2C744", letterSpacing: 0.6 }}>STILL TO COLLECT</span>
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,.55)", fontWeight: 600 }}>from customer · cash / card / UPI</span>
                  </div>
                  <span style={{ fontSize: 28, fontWeight: 900, color: "#F2C744", lineHeight: 1, letterSpacing: -0.5 }}>
                    {formatINR(payable)}
                  </span>
                </div>
              </div>
            )
          )}

          {payable > 0 && walletAllowed && (
            <button onClick={() => { setWalletErr(""); setShowWalletScan(true); }}
              style={{ marginTop: walletRedemptions.length > 0 ? 10 : 0, width: "100%", padding: 12, borderRadius: 10,
                background: "linear-gradient(135deg,rgba(242,199,68,.18),rgba(160,40,32,.18))",
                border: "1px solid rgba(242,199,68,.5)", color: "#F2C744", fontSize: 13, fontWeight: 900, cursor: "pointer" }}>
              {walletRedemptions.length === 0 ? `🎫 REDEEM FROM WALLET (${formatINR(payable)})` : "🎫 SCAN ANOTHER WALLET"}
            </button>
          )}

          {!walletAllowed && (
            <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: "rgba(160,40,32,.1)", border: "1px dashed rgba(160,40,32,.4)", fontSize: 10, color: "rgba(255,255,255,.5)", textAlign: "center", fontWeight: 600 }}>
              Wallet redemption blocked on aggregator bills (Q6 spec)
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <button onClick={() => setServiceCharge(!serviceCharge)}
            style={{ width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer", position: "relative",
              background: serviceCharge ? "rgba(242,199,68,.5)" : "rgba(255,255,255,.15)", transition: "background .2s" }}>
            <div style={{ width: 16, height: 16, borderRadius: 8, background: "#fff", position: "absolute", top: 3,
              left: serviceCharge ? 21 : 3, transition: "left .2s" }} />
          </button>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,.5)" }}>Service Charge (10%)</span>
        </div>

        {isAggregator && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 8 }}>Payment Channel</div>
            <div style={{ display: "flex", gap: 8 }}>
              {["aggregator", "inhouse"].map((ch) => (
                <button key={ch} onClick={() => setPayMethod(ch === "inhouse" ? "cash" : "aggregator")}
                  style={{ flex: 1, padding: 10, borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer", border: "1px solid",
                    background: (ch === "aggregator" ? payMethod === "aggregator" : payMethod !== "aggregator") ? "rgba(242,199,68,.15)" : "rgba(255,255,255,.04)",
                    borderColor: (ch === "aggregator" ? payMethod === "aggregator" : payMethod !== "aggregator") ? "rgba(242,199,68,.5)" : "rgba(255,255,255,.08)",
                    color: (ch === "aggregator" ? payMethod === "aggregator" : payMethod !== "aggregator") ? "#F2C744" : "rgba(255,255,255,.4)" }}>
                  {ch === "aggregator" ? `Pay via ${aggName}` : "Pay In-House"}
                </button>
              ))}
            </div>
          </div>
        )}

        {payMethod !== "aggregator" && payable > 0 && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,.5)" }}>Payment Method · ₹{payable} owed</span>
              <button onClick={() => { setSplitMode(!splitMode); setError(""); if (!splitMode) { setSplitCash(payable); setSplitCard(0); setSplitUpi(0); } }}
                style={{ padding: "4px 10px", borderRadius: 8, fontSize: 11, fontWeight: 800, cursor: "pointer",
                  background: splitMode ? "rgba(239,68,68,.2)" : "rgba(255,255,255,.04)",
                  border: `1px solid ${splitMode ? "rgba(239,68,68,.6)" : "rgba(255,255,255,.1)"}`,
                  color: splitMode ? "#EF4444" : "rgba(255,255,255,.5)" }}>
                {splitMode ? "✓ SPLIT MODE ON" : "🔀 SPLIT PAYMENT"}
              </button>
            </div>
            {!splitMode && (
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                {methods.map((m) => (
                  <button key={m.key} onClick={() => setPayMethod(m.key)}
                    style={{ flex: 1, padding: 10, borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer",
                      background: payMethod === m.key ? "rgba(242,199,68,.15)" : "rgba(255,255,255,.04)",
                      border: `1px solid ${payMethod === m.key ? "rgba(242,199,68,.5)" : "rgba(255,255,255,.08)"}`,
                      color: payMethod === m.key ? "#F2C744" : "rgba(255,255,255,.4)" }}>
                    {m.label}
                  </button>
                ))}
              </div>
            )}
            {splitMode && (
              <div style={{ marginBottom: 16, padding: 12, borderRadius: 10, background: "rgba(239,68,68,.05)", border: "1px solid rgba(239,68,68,.2)" }}>
                {([
                  { k: "cash", label: "💵 Cash", val: splitCash, set: setSplitCash },
                  { k: "card", label: "💳 Card", val: splitCard, set: setSplitCard },
                  { k: "upi",  label: "📱 UPI",  val: splitUpi,  set: setSplitUpi  },
                ] as const).map((row) => (
                  <div key={row.k} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <span style={{ width: 70, fontSize: 12, fontWeight: 700, color: "#fff" }}>{row.label}</span>
                    <span style={{ fontSize: 14, color: "rgba(255,255,255,.4)" }}>₹</span>
                    <input type="number" value={row.val || ""} onChange={(e) => row.set(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                      placeholder="0" min={0}
                      style={{ flex: 1, padding: "8px 10px", borderRadius: 8, background: "rgba(0,0,0,.3)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 14, outline: "none", boxSizing: "border-box" }} />
                  </div>
                ))}
                <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, borderTop: "1px solid rgba(239,68,68,.2)", fontSize: 12 }}>
                  <span style={{ color: "rgba(255,255,255,.5)" }}>Split sum</span>
                  <span style={{ fontWeight: 800, color: splitDiff === 0 ? "#F2C744" : "#EF4444" }}>
                    ₹{splitTotal} / ₹{payable} {splitDiff !== 0 && `(${splitDiff > 0 ? "short" : "over"} ₹${Math.abs(splitDiff)})`}
                  </span>
                </div>
              </div>
            )}
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 8 }}>Discount %</div>
            {/* 🔴 2026-05-12 — D4: input cap is 15%, blur fires the PIN gate. */}
            <input type="number" value={manualDiscount || ""}
              onChange={(e) => setManualDiscount(Math.min(CAPTAIN_DISCOUNT_MAX, Math.max(0, Number(e.target.value) || 0)))}
              onBlur={async (e) => {
                const raw = Number(e.target.value) || 0;
                const clamped = clampCaptainDiscount(raw);
                if (clamped === null) { setManualDiscount(0); return; }
                if (clamped !== 0 && clamped !== Number((e.target as HTMLInputElement).defaultValue || 0)) {
                  const ok = await requireManagerPin(`Apply ${clamped}% manual discount on this bill`);
                  if (!ok) { setManualDiscount(0); return; }
                }
                setManualDiscount(clamped);
              }}
              placeholder={`max ${CAPTAIN_DISCOUNT_MAX}%`} min={0} max={CAPTAIN_DISCOUNT_MAX}
              style={{ width: "100%", padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 14, outline: "none", marginBottom: 16, boxSizing: "border-box" }} />
          </>
        )}

        {error && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 10 }}>{error}</div>}

        <button onClick={() => {
            // 🔴 2026-05-15 (Khushi spec) — when wallet only partially covers
            // a bill, force the captain to acknowledge that the leftover
            // ₹{payable} was physically collected from the customer BEFORE
            // closing the bill. Plain wallet-only and no-wallet flows skip
            // the prompt — only mixed wallet+cash needs the double-check.
            if (payable > 0 && walletPaidSoFar > 0) { setShowCollectConfirm(true); return; }
            confirm();
          }} disabled={saving}
          style={{ width: "100%", padding: 14, borderRadius: 12, background: "linear-gradient(135deg,rgba(242,199,68,.9),rgba(160,40,32,.8))", border: "none", color: "#fff", fontSize: 15, fontWeight: 900, cursor: "pointer", marginBottom: 10 }}>
          {saving ? "Saving..." : (payable === 0 && walletPaidSoFar > 0 ? "✅ Close Bill (Wallet Paid)" : "✅ Confirm Payment")}
        </button>
        <button onClick={onClose} style={{ width: "100%", padding: 12, borderRadius: 12, background: "transparent", border: "none", color: "rgba(255,255,255,.4)", fontSize: 13, cursor: "pointer" }}>Cancel</button>
      </div>

      {showWalletScan && (
        <WalletScanModal
          reservation={reservation}
          remaining={payable}
          captainName={captainName}
          onClose={() => setShowWalletScan(false)}
        />
      )}

      {/* 🔴 2026-05-15 (Khushi spec) — themed in-modal "Did you collect ₹X?"
          double-confirm. Replaces native window.confirm which rendered as a
          stark black-on-white browser dialog that didn't match HOD theme.
          Black/red/gold gradient · ₹ amount HUGE · two big buttons. Sits at
          z-10001 (above MarkPaidModal 9999 + WalletScanModal 10000). */}
      {showCollectConfirm && (
        <div onClick={() => setShowCollectConfirm(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(3,3,5,.85)", backdropFilter: "blur(8px)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10001, padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 420, background: "linear-gradient(155deg,#1a0d0a 0%,#0a0606 70%,#030305 100%)",
              border: "2px solid rgba(242,199,68,.6)", borderRadius: 16,
              boxShadow: "0 0 0 4px rgba(242,199,68,.1), 0 20px 60px rgba(160,40,32,.4), 0 0 80px rgba(242,199,68,.15)",
              padding: 24, color: "#fff", fontFamily: "inherit" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
              <span style={{ fontSize: 22 }}>⚠️</span>
              <span style={{ fontSize: 13, fontWeight: 900, color: "#F2C744", letterSpacing: 1.2, textTransform: "uppercase" }}>Collect From Customer</span>
            </div>

            <div style={{ padding: "22px 16px", marginBottom: 16, borderRadius: 12,
              background: "linear-gradient(135deg,rgba(242,199,68,.18),rgba(160,40,32,.18))",
              border: "1px solid rgba(242,199,68,.45)", textAlign: "center" }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "rgba(255,255,255,.6)", letterSpacing: 0.8, marginBottom: 6 }}>STILL TO COLLECT</div>
              <div style={{ fontSize: 44, fontWeight: 900, color: "#F2C744", lineHeight: 1, letterSpacing: -1, textShadow: "0 0 20px rgba(242,199,68,.4)" }}>
                {formatINR(payable)}
              </div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", fontWeight: 600, marginTop: 8 }}>
                via {splitMode ? "SPLIT" : (payMethod || "cash").toUpperCase()}
              </div>
            </div>

            <div style={{ padding: "10px 12px", marginBottom: 14, borderRadius: 8,
              background: "rgba(34,197,94,.06)", border: "1px solid rgba(34,197,94,.25)",
              fontSize: 11, color: "rgba(255,255,255,.7)", fontWeight: 600, textAlign: "center" }}>
              Wallet already covered <span style={{ color: "#22C55E", fontWeight: 900 }}>{formatINR(walletPaidSoFar)}</span>
            </div>

            <div style={{ fontSize: 13, color: "rgba(255,255,255,.85)", fontWeight: 700, lineHeight: 1.5, marginBottom: 18, textAlign: "center" }}>
              Have you actually collected <span style={{ color: "#F2C744", fontWeight: 900 }}>{formatINR(payable)}</span> from the customer?
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setShowCollectConfirm(false)}
                style={{ flex: 1, padding: 14, borderRadius: 10, background: "rgba(255,255,255,.05)",
                  border: "1px solid rgba(255,255,255,.15)", color: "rgba(255,255,255,.8)",
                  fontSize: 13, fontWeight: 800, cursor: "pointer", letterSpacing: 0.5 }}>
                ❌ NOT YET
              </button>
              <button onClick={() => { setShowCollectConfirm(false); confirm(); }}
                style={{ flex: 1.4, padding: 14, borderRadius: 10,
                  background: "linear-gradient(135deg,#F2C744 0%,#A02820 100%)",
                  border: "none", color: "#fff", fontSize: 13, fontWeight: 900, cursor: "pointer", letterSpacing: 0.5,
                  boxShadow: "0 4px 14px rgba(160,40,32,.4)" }}>
                ✅ YES — CLOSE BILL
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function WalkInModal({ captainName, existingTables, allReservations, onClose }: {
  captainName: string; existingTables: string[]; allReservations: HodTableReservation[]; onClose: () => void;
}) {
  const [customerName, setCustomerName] = useState("");
  const [countryCode, setCountryCode] = useState("91");
  const [phone, setPhone] = useState("");
  const [partySize, setPartySize] = useState(2);
  const [selectedTable, setSelectedTable] = useState("");
  // 🔴 2026-05-13 (Khushi spec, round 6) — walk-in modal is in-house only.
  // Aggregator bookings come in pre-tagged from Zomato/Swiggy/EazyDiner via
  // the booking import path, never via captain-side seat-now. Hardcoding to
  // "inhouse" keeps the createWalkInTable signature stable.
  const aggValue = "inhouse";
  const [customDiscount, setCustomDiscount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [isProxy, setIsProxy] = useState(false);
  const [proxyFloor, setProxyFloor] = useState("dining");

  const discountPct = customDiscount;
  const nextProxyNum = existingTables.filter(t => t.startsWith("Proxy-")).length + 1;
  const proxyName = `Proxy-${nextProxyNum}`;

  // Phone is required so we can send the wallet/menu link via WhatsApp. We
  // store it as digits-only with country code prefix (e.g. "919686444906" or
  // "15551234567") — that format works for both wa.me and the WhatsApp Cloud API.
  // Normalize: strip non-digits, drop a leading 0 (national trunk prefix), and
  // if the user pasted the country code into the number field, drop it once
  // so we don't end up with "9191...".
  let phoneDigits = phone.replace(/\D/g, "");
  if (phoneDigits.startsWith("0")) phoneDigits = phoneDigits.replace(/^0+/, "");
  if (countryCode && phoneDigits.startsWith(countryCode)) {
    phoneDigits = phoneDigits.slice(countryCode.length);
  }
  const fullPhone = phoneDigits ? `${countryCode}${phoneDigits}` : "";

  const create = async () => {
    if (!customerName.trim()) { setError("Enter customer name"); return; }
    if (!phoneDigits || phoneDigits.length < 7) { setError("Enter a valid phone number (min 7 digits)"); return; }
    // E.164 caps total digits at 15. Catches paste accidents like extra digits.
    if (fullPhone.length > 15) { setError("Phone number too long — check the country code & number"); return; }
    if (!isProxy && !selectedTable) { setError("Select a table"); return; }
    if (!isProxy && tableOccupantAt(selectedTable, nowMinutesIST(), allReservations)) { setError("Table already occupied right now!"); return; }
    // D3 — when the captain types a customDiscount that exceeds the source's
    // implied discount by more than WALKIN_DISCOUNT_PIN_DELTA percentage points,
    // require a Manager PIN. This catches "in-house + 80% discount" abuse and
    // captures a free-text reason logged to discountOverrideLog.
    const impliedDisc = getAggregatorDiscount(aggValue) || 0;
    let overrideReason = "";
    if (customDiscount > impliedDisc + WALKIN_DISCOUNT_PIN_DELTA) {
      const ok = await requireManagerPin(
        `Walk-in discount: ${customDiscount}% on source "${aggValue}"\n` +
        `(implied ${impliedDisc}% + ${WALKIN_DISCOUNT_PIN_DELTA}pp tolerance)`
      );
      if (!ok) { setError("Manager PIN required for this discount."); return; }
      overrideReason = window.prompt(`Reason for ${customDiscount}% walk-in discount:`) || "";
    }
    setSaving(true);
    try {
      let createdRef = "";
      if (isProxy) {
        const floorOpt = TABLE_OPTIONS.find(g => g.floor === proxyFloor);
        createdRef = await createProxyTable(
          proxyName, proxyFloor, floorOpt?.label || proxyFloor,
          customerName.trim(), fullPhone, partySize, captainName,
          aggValue, discountPct
        );
      } else {
        const opt = TABLE_OPTIONS.find((g) => g.tables.includes(selectedTable));
        createdRef = await createWalkInTable(
          selectedTable, opt?.floor || "", opt?.label || "",
          customerName.trim(), fullPhone, partySize, captainName,
          aggValue, discountPct
        );
      }
      // D3 — log the over-threshold walk-in discount approval (best-effort,
      // outside the create txn so a logging glitch can't block table creation).
      if (createdRef && customDiscount > impliedDisc + WALKIN_DISCOUNT_PIN_DELTA) {
        await recordWalkInDiscountOverride(createdRef, {
          by: captainName, valueBefore: impliedDisc, valueAfter: customDiscount,
          reason: overrideReason.trim() || "(no reason given)",
        });
      }
      onClose();
    } catch (e: any) { setError(e.message); }
    setSaving(false);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "rgba(20,18,30,1)", border: "1px solid rgba(242,199,68,.3)", borderRadius: 20, padding: 24, width: "100%", maxWidth: 400, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ fontSize: 18, fontWeight: 900, color: "#F2C744", marginBottom: 4 }}>🚶 Seat Walk-In Guest</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginBottom: 16 }}>Create a new table for a walk-in customer</div>

        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          <button onClick={() => setIsProxy(false)}
            style={{ flex: 1, padding: "8px 12px", borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer",
              background: !isProxy ? "rgba(242,199,68,.15)" : "rgba(255,255,255,.04)",
              border: `1px solid ${!isProxy ? "rgba(242,199,68,.5)" : "rgba(255,255,255,.08)"}`,
              color: !isProxy ? "#F2C744" : "rgba(255,255,255,.5)" }}>
            🪑 Regular Table
          </button>
          <button onClick={() => setIsProxy(true)}
            style={{ flex: 1, padding: "8px 12px", borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer",
              background: isProxy ? "rgba(239,68,68,.15)" : "rgba(255,255,255,.04)",
              border: `1px solid ${isProxy ? "rgba(239,68,68,.5)" : "rgba(255,255,255,.08)"}`,
              color: isProxy ? "#EF4444" : "rgba(255,255,255,.5)" }}>
            📦 Proxy / Extra
          </button>
        </div>

        <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 6 }}>Customer Name *</div>
        <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="e.g. Karan"
          style={{ width: "100%", padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 14, outline: "none", marginBottom: 12, boxSizing: "border-box" }} />

        <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 6 }}>Phone * (for WhatsApp menu link)</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <select value={countryCode} onChange={(e) => setCountryCode(e.target.value)}
            style={{ width: 100, padding: "10px 8px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 13, outline: "none", fontFamily: "inherit", cursor: "pointer" }}>
            <option value="91">🇮🇳 +91</option>
            <option value="1">🇺🇸 +1</option>
            <option value="44">🇬🇧 +44</option>
            <option value="971">🇦🇪 +971</option>
            <option value="65">🇸🇬 +65</option>
            <option value="61">🇦🇺 +61</option>
            <option value="49">🇩🇪 +49</option>
            <option value="33">🇫🇷 +33</option>
            <option value="81">🇯🇵 +81</option>
            <option value="966">🇸🇦 +966</option>
            <option value="60">🇲🇾 +60</option>
            <option value="977">🇳🇵 +977</option>
            <option value="94">🇱🇰 +94</option>
            <option value="880">🇧🇩 +880</option>
            <option value="92">🇵🇰 +92</option>
            <option value="86">🇨🇳 +86</option>
          </select>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" type="tel" inputMode="tel"
            style={{ flex: 1, padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 14, outline: "none", boxSizing: "border-box" }} />
        </div>

        <div style={{ width: 100, marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 6 }}>Guests</div>
          <input type="number" value={partySize} onChange={(e) => setPartySize(Number(e.target.value) || 2)} min={1} max={20}
            style={{ width: "100%", padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 14, outline: "none", boxSizing: "border-box" }} />
        </div>

        {isProxy ? (
          <>
            <div style={{ background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.3)", borderRadius: 12, padding: 14, marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,.4)", marginBottom: 4 }}>Auto-assigned Name</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: "#EF4444" }}>{proxyName}</div>
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 6 }}>Floor *</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              {TABLE_OPTIONS.map(g => (
                <button key={g.floor} onClick={() => setProxyFloor(g.floor)}
                  style={{ flex: 1, padding: "8px 10px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer",
                    background: proxyFloor === g.floor ? "rgba(239,68,68,.15)" : "rgba(255,255,255,.04)",
                    border: `1px solid ${proxyFloor === g.floor ? "rgba(239,68,68,.5)" : "rgba(255,255,255,.08)"}`,
                    color: proxyFloor === g.floor ? "#EF4444" : "rgba(255,255,255,.5)" }}>
                  {g.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 6 }}>Select Table *</div>
            <div style={{ marginBottom: 12 }}>
              {TABLE_OPTIONS.map((group) => (
                <div key={group.floor} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,.3)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 }}>{group.label}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {group.tables.map((t) => {
                      // Walk-in is "now" — colour boxes by who occupies the
                      // table at this minute. A 11pm booking should NOT make
                      // the box red at 7pm.
                      const occupant = tableOccupantAt(t, nowMinutesIST(), allReservations);
                      const occupied = !!occupant;
                      const isSelected = selectedTable === t;
                      const bg = isSelected ? "#F2C744"
                        : occupied ? "#DC2626" : "#16A34A";
                      const border = isSelected ? "#F2C744"
                        : occupied ? "#B91C1C" : "#15803D";
                      const color = isSelected ? "#0A0A0A" : "#FFFFFF";
                      return (
                        <button key={t} onClick={() => !occupied && setSelectedTable(t)} disabled={occupied}
                          title={occupant ? `Taken — ${occupant.customerName || ""} ${occupant.arrivalTime || ""}`.trim() : "Available now"}
                          style={{ padding: "6px 10px", borderRadius: 8, fontSize: 11, fontWeight: 800, cursor: occupied ? "not-allowed" : "pointer",
                            background: bg, border: `1px solid ${border}`, color,
                            opacity: occupied ? 0.85 : 1 }}>
                          {t}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* 🔴 2026-05-13 (Khushi spec, round 6) — Source/Aggregator picker
            removed. Walk-ins are always in-house here; aggregator tabs come
            in via the booking import path with their discount pre-stamped.
            Discount default is 0 and capped at WALKIN_DISCOUNT_MAX (10%) —
            anything higher needs a manager override on the bill. */}
        <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 6 }}>Discount % (default 0 — max {WALKIN_DISCOUNT_MAX}%)</div>
        <input type="number" value={customDiscount || ""}
          onChange={(e) => setCustomDiscount(Math.min(WALKIN_DISCOUNT_MAX, Math.max(0, Number(e.target.value) || 0)))}
          placeholder="0"
          min={0} max={WALKIN_DISCOUNT_MAX}
          style={{ width: "100%", padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 14, outline: "none", marginBottom: 16, boxSizing: "border-box" }} />

        {error && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 10 }}>{error}</div>}

        <button onClick={create} disabled={saving}
          style={{ width: "100%", padding: 14, borderRadius: 12, background: "linear-gradient(135deg,rgba(242,199,68,.9),rgba(160,120,48,.8))", border: "none", color: "#000", fontSize: 15, fontWeight: 900, cursor: "pointer", marginBottom: 10 }}>
          {saving ? "Creating..." : isProxy ? `📦 Create ${proxyName}` : "🪑 Create Table"}
        </button>
        <button onClick={onClose} style={{ width: "100%", padding: 12, borderRadius: 12, background: "transparent", border: "none", color: "rgba(255,255,255,.4)", fontSize: 13, cursor: "pointer" }}>Cancel</button>
      </div>
    </div>
  );
}

function AddOrderModal({ docId, tableId, captainName, onClose }: {
  docId: string; tableId: string; captainName: string; onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  // 🔴 2026-05-12 — Wallet-style 4-tab layout (FOOD / LIQUOR / NAB / SMOKE)
  // mirroring rms-diner.digitory.com so captains see the same shape the
  // customer sees on hodclub.in. Tab is derived from group + isAlcohol.
  type WalletTab = "food" | "liquor" | "nab" | "smoke";
  const [tab, setTab] = useState<WalletTab>("food");
  const [cart, setCart] = useState<HodOrderItem[]>([]);
  const [saving, setSaving] = useState(false);

  // 🔴 2026-05-09 — Live OOS + discount overrides from Admin → Menu.
  // Keyed by slug(name) so it bridges menu-data.ts ↔ hod-menu.ts ↔ wallet.
  // Helper inline-redeclared (don't import to keep this section self-contained).
  const [menuOverrides, setMenuOverrides] = useState<Record<string, MenuOverride>>({});
  useEffect(() => subscribeToMenuOverrides(setMenuOverrides), []);
  // 2026-05-18 — Live menu categories (admin Menu CRM). When empty → fail-open
  // (show ALL items, no filtering). When non-empty → only those items show, with
  // category discounts applied automatically.
  const [liveCategories, setLiveCategories] = useState<MenuCategory[]>([]);
  useEffect(() => subscribeToLiveMenuCategories(setLiveCategories), []);
  const ovKey = (name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const effectivePrice = (m: { name: string; price: number }) => {
    const ov = menuOverrides[ovKey(m.name)];
    if (!ov) return m.price;
    if (ov.discountPercent) return Math.max(0, Math.round((m.price - m.price * ov.discountPercent / 100) * 100) / 100);
    if (ov.discountAmount) return Math.max(0, Math.round((m.price - ov.discountAmount) * 100) / 100);
    return m.price;
  };

  // Map every menu item to one of the 4 wallet tabs.
  // 🔴 2026-05-12 — Defensive against an item slipping through with an
  // unexpected `group` (e.g. typo or new SKU). Anything that isn't food/
  // smoke/drink-shaped falls back to its category-prefix as a last resort
  // so it doesn't silently land on FOOD.
  const tabOf = (m: { group: string; isAlcohol?: boolean; category?: string }): WalletTab => {
    const g = (m.group || "").toLowerCase();
    if (g === "food") return "food";
    if (g === "smoke" || g === "tobacco") return "smoke";
    if (g === "beer-wine" || g === "spirits" || g === "cocktails") return "liquor";
    if (g === "soft" || g === "non-alcoholic" || g === "nab" || g === "mocktails") return "nab";
    // Fall back to category prefix for any unknown group.
    const c = (m.category || "").toLowerCase();
    if (c.startsWith("food-")) return "food";
    if (c.startsWith("smoke-") || c.startsWith("tobacco")) return "smoke";
    if (c.startsWith("nab-") || c.startsWith("soft-") || c.startsWith("mock")) return "nab";
    if (c.startsWith("bar-") || c.startsWith("beer") || c.startsWith("wine") || c.startsWith("spirits") || c.startsWith("liquor") || c.startsWith("cocktail")) return "liquor";
    // Last resort: alcohol flag wins, else NAB (never silently bleed into FOOD).
    return m.isAlcohol ? "liquor" : "nab";
  };
  // Drop the "food-" / "bar-" prefix that's noise in the wallet view.
  const prettyCat = (c: string) =>
    c.replace(/^(food|bar|smoke|nab|liquor)-/i, "").replace(/-/g, " ").toUpperCase();

  // Sub-category pills shown under the active tab.
  const tabCategories = useMemo(() => {
    const inTab = MENU_ITEMS.filter((m) => tabOf(m) === tab);
    return [...new Set(inTab.map((m) => m.category))];
  }, [tab]);

  // Reset the sub-category pill whenever the user switches the big tab.
  useEffect(() => { setCategory(""); }, [tab]);

  // Fuzzy, typo-tolerant search — same algorithm as BarMode and customer wallet.
  const filtered = useMemo(() => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const lev = (a: string, b: string): number => {
      const m = a.length, n = b.length;
      if (!m) return n; if (!n) return m;
      const dp: number[][] = [];
      for (let i = 0; i <= m; i++) dp.push([i]);
      for (let j = 1; j <= n; j++) dp[0][j] = j;
      for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
        const c = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + c);
      }
      return dp[m][n];
    };
    const wordMatch = (word: string, hay: string) => {
      if (!word) return true;
      if (hay.indexOf(word) >= 0) return true;
      if (word.length < 4) return false;
      for (const t of hay.split(" ")) {
        if (!t) continue;
        if (t.indexOf(word) >= 0) return true;
        const allow = word.length >= 7 ? 2 : 1;
        if (lev(word, t) <= allow) return true;
      }
      return false;
    };
    // 2026-05-18 — Apply LIVE category filter first (admin Menu CRM). Fail-open when none live.
    const menuForPicker = liveCategories.length > 0 ? filterMenuByLiveCategories(MENU_ITEMS, liveCategories) : MENU_ITEMS;
    // Drop items that admin marked OUT OF STOCK (live-synced via overrides).
    let items = menuForPicker.filter((m) => m.available !== false && !menuOverrides[ovKey(m.name)]?.outOfStock);
    // Always scope to the active wallet tab first, then optional sub-category.
    items = items.filter((m) => tabOf(m) === tab);
    if (category) items = items.filter((m) => m.category === category);
    if (search) {
      const q = norm(search);
      const words = q.split(" ").filter(Boolean);
      items = items.filter((m) => {
        const hay = norm(`${m.name} ${m.category} ${m.group}`);
        return words.every((w) => wordMatch(w, hay));
      });
    }
    return items.slice(0, 80);
  }, [search, category, menuOverrides, tab, liveCategories]);

  // Accept any item shape with name+price+category+group — HodMenuItem widens
  // category to `string` while legacy MenuItem narrows it; both flow through
  // here so we use a structural type to keep both happy without runtime casts.
  const addToCart = (m: { name: string; price: number; category: string; group: string; isAlcohol?: boolean; isVeg?: boolean }) => {
    // 🔴 2026-05-09 — use the LIVE discounted price (admin can change at any
    // time; this snapshot locks in at add-to-cart so the round write matches
    // exactly what the captain saw on screen).
    const usePrice = effectivePrice({ name: m.name, price: m.price || 0 });
    setCart((prev) => {
      const existing = prev.find((c) => c.n === m.name);
      if (existing) return prev.map((c) => c.n === m.name ? { ...c, qty: c.qty + 1 } : c);
      // Tag tax class so cart total / round write / KOT all match BarMode + customer wallet.
      const t: "food" | "drink" = m.group === "food" ? "food" : "drink";
      const alc = m.group === "food" ? false : !!m.isAlcohol;
      return [...prev, { n: m.name, p: usePrice, qty: 1, cat: m.category, t, alc, v: m.isVeg }];
    });
  };

  const updateCartQty = (idx: number, delta: number) => {
    setCart((prev) => prev.map((c, i) => i === idx ? { ...c, qty: Math.max(0, c.qty + delta) } : c).filter((c) => c.qty > 0));
  };

  const cartBreakdown = computeHodBreakdown(cart);
  // 🔴 2026-05-07 — show CLEAN SUBTOTAL in cart (matches table card + menu
  // prices). SC + GST are added later at Mark Paid time, with toggle for
  // SC waiver. Cart breakdown still available via "view breakdown" expand.
  const cartTotal = cartBreakdown.subtotal;
  const fmt = (n: number) => `₹${(Math.round(n * 100) / 100).toLocaleString("en-IN", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

  const submit = async () => {
    if (cart.length === 0) return;
    setSaving(true);
    try {
      await addRoundToTable(docId, cart, captainName);
      onClose();
    } catch (e: any) { alert(e.message); }
    setSaving(false);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.9)", zIndex: 9999, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid rgba(242,199,68,.2)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900, color: "#F2C744" }}>Add Order — {tableId}</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.4)" }}>Captain: {captainName}</div>
        </div>
        <button onClick={onClose} style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 18, cursor: "pointer" }}>×</button>
      </div>

      {/* 🔴 2026-05-12 — Wallet-style search bar + 4 big tabs (FOOD/LIQUOR/NAB/SMOKE)
          + red sub-category strip. Mirrors rms-diner.digitory.com so captains
          see the same shape the customer sees on hodclub.in. */}
      <div style={{ padding: "10px 16px 0", background: "#0E0B14" }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search"
          style={{ width: "100%", padding: "12px 14px", borderRadius: 6, background: "transparent", border: "1px solid #F2C744", color: "#fff", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 10, textAlign: "center" }} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 8 }}>
          {(["food", "liquor", "nab", "smoke"] as const).map((t) => {
            const active = tab === t;
            return (
              <button key={t} onClick={() => setTab(t)}
                style={{
                  padding: "14px 6px", borderRadius: 4, fontSize: 12, fontWeight: 800, letterSpacing: 1, cursor: "pointer",
                  background: active ? "#F2C744" : "#7A1F18",
                  color: active ? "#1a1410" : "#F4D7A8",
                  border: "1px solid " + (active ? "#F2C744" : "#5A150F"),
                  textTransform: "uppercase",
                }}>{t}</button>
            );
          })}
        </div>
        {tabCategories.length > 1 && (
          <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 8, flexWrap: "wrap" }}>
            <button onClick={() => setCategory("")}
              style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 3, fontSize: 10, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
                background: !category ? "transparent" : "transparent",
                border: `1px solid ${!category ? "#F2C744" : "transparent"}`,
                color: !category ? "#F2C744" : "rgba(255,255,255,.55)" }}>ALL</button>
            {tabCategories.map((c) => (
              <button key={c} onClick={() => setCategory(c)}
                style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 3, fontSize: 10, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", letterSpacing: 0.5,
                  background: "transparent",
                  border: `1px solid ${category === c ? "#F2C744" : "transparent"}`,
                  color: category === c ? "#F2C744" : "rgba(255,255,255,.55)" }}>{prettyCat(c)}</button>
            ))}
          </div>
        )}
        <div style={{ height: 1, background: "rgba(255,255,255,.05)" }} />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 16px", background: "#0E0B14" }}>
        {category && (
          <div style={{ fontSize: 18, fontWeight: 800, color: "#fff", padding: "10px 0", letterSpacing: 0.5 }}>
            {prettyCat(category)}
          </div>
        )}
        {filtered.length === 0 && (
          <div style={{ padding: 40, textAlign: "center", color: "rgba(255,255,255,.4)", fontSize: 12 }}>
            No items{search ? ` matching "${search}"` : ""}.
          </div>
        )}
        {filtered.map((m) => {
          const ov = menuOverrides[ovKey(m.name)];
          const eff = effectivePrice({ name: m.name, price: m.price || 0 });
          const hasDisc = eff !== (m.price || 0);
          const showVeg = m.group === "food";
          // 🔴 2026-05-12 — Composite key: hod-menu.ts has duplicates by name
          // (e.g. "Kingfisher Ultra" exists in bottle-beer AND can-beer-500ml
          // categories). Using just `m.name` collapses them via React's key
          // dedupe; include id + category to keep them distinct.
          return (
            <div key={`${m.id || ""}-${m.category}-${m.name}`}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 0", borderBottom: "1px dashed rgba(255,255,255,.08)" }}>
              <div style={{ flex: 1, paddingRight: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#fff", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3 }}>
                  {showVeg && (
                    <span style={{
                      display: "inline-block", width: 12, height: 12, border: `1.5px solid ${m.isVeg ? "#22c55e" : "#dc2626"}`,
                      borderRadius: 2, position: "relative", flexShrink: 0,
                    }}>
                      <span style={{
                        position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
                        width: 5, height: 5, borderRadius: "50%", background: m.isVeg ? "#22c55e" : "#dc2626",
                      }} />
                    </span>
                  )}
                  {m.name}
                </div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,.55)", marginTop: 4, fontWeight: 600 }}>
                  {hasDisc ? (
                    <>
                      <span style={{ textDecoration: "line-through", color: "rgba(255,255,255,.35)", marginRight: 6 }}>₹{(m.price || 0).toFixed(2)}</span>
                      <span style={{ color: "#22c55e" }}>₹{eff.toFixed(2)}</span>
                    </>
                  ) : (
                    <>₹{(m.price || 0).toFixed(2)}</>
                  )}
                  {hasDisc && ov?.discountReason && (
                    <span style={{ marginLeft: 6, color: "rgba(255,255,255,.4)", fontWeight: 500 }}>· {ov.discountReason}</span>
                  )}
                </div>
              </div>
              <button onClick={() => addToCart(m)}
                style={{
                  padding: "8px 18px", borderRadius: 4, background: "#A02820", border: "none",
                  color: "#fff", fontSize: 12, fontWeight: 800, letterSpacing: 0.5, cursor: "pointer",
                }}>ADD +</button>
            </div>
          );
        })}
      </div>

      {cart.length > 0 && (
        <div style={{ borderTop: "2px solid rgba(242,199,68,.3)", background: "rgba(20,18,30,1)", padding: "12px 16px" }}>
          <div style={{ maxHeight: 150, overflowY: "auto", marginBottom: 8 }}>
            {cart.map((c, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0" }}>
                <span style={{ fontSize: 12, color: "#fff", flex: 1 }}>{c.n}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button onClick={(e) => { e.stopPropagation(); updateCartQty(i, -1); }} style={{ width: 24, height: 24, borderRadius: 6, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", cursor: "pointer", fontSize: 12 }}>−</button>
                  <span style={{ fontSize: 13, fontWeight: 800, color: "#F2C744", minWidth: 16, textAlign: "center" }}>{c.qty}</span>
                  <button onClick={(e) => { e.stopPropagation(); updateCartQty(i, 1); }} style={{ width: 24, height: 24, borderRadius: 6, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", cursor: "pointer", fontSize: 12 }}>+</button>
                  <span style={{ fontSize: 12, color: "#F2C744", minWidth: 50, textAlign: "right" }}>₹{c.p * c.qty}</span>
                </div>
              </div>
            ))}
          </div>
          <details style={{ borderTop: "1px solid rgba(255,255,255,.07)", paddingTop: 6, marginBottom: 10 }}>
            <summary style={{ display: "flex", justifyContent: "space-between", alignItems: "center", listStyle: "none", cursor: "pointer" }}>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,.55)", fontStyle: "italic" }}>
                Subtotal · SC + GST added at pay <span style={{ opacity: 0.6, fontSize: 9 }}>▾ view tax breakdown</span>
              </span>
              <span style={{ fontSize: 16, fontWeight: 900, color: "#F2C744" }}>{fmt(cartTotal)}</span>
            </summary>
            <div style={{ fontSize: 11, lineHeight: 1.7, paddingTop: 6, marginTop: 5, borderTop: "1px dashed rgba(255,255,255,.06)", color: "rgba(255,255,255,.6)" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span>Sub Total</span><span>{fmt(cartBreakdown.subtotal)}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span>Service Charge (10%)</span><span>{fmt(cartBreakdown.serviceCharge)}</span></div>
              {cartBreakdown.cgst > 0 && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><span>CGST (2.5%)</span><span>{fmt(cartBreakdown.cgst)}</span></div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><span>SGST (2.5%)</span><span>{fmt(cartBreakdown.sgst)}</span></div>
                </>
              )}
              {Math.abs(cartBreakdown.roundOff) >= 0.01 && (
                <div style={{ display: "flex", justifyContent: "space-between" }}><span>Round Off</span><span>{cartBreakdown.roundOff >= 0 ? "+" : ""}{fmt(cartBreakdown.roundOff)}</span></div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginTop: 4, color: "rgba(255,255,255,.4)" }}>
                <span>{cart.reduce((s, c) => s + c.qty, 0)} item(s)</span>
                <span>Total {fmt(cartBreakdown.grandTotal)}</span>
              </div>
            </div>
          </details>
          <button onClick={submit} disabled={saving}
            style={{ width: "100%", padding: 14, borderRadius: 12, background: "linear-gradient(135deg,rgba(242,199,68,.9),rgba(160,40,32,.8))", border: "none", color: "#fff", fontSize: 15, fontWeight: 900, cursor: "pointer" }}>
            {saving ? "Adding..." : `📝 Add Round · ${formatINR(cartBreakdown.grandTotal)} (${cart.reduce((s, c) => s + c.qty, 0)} items)`}
          </button>
        </div>
      )}
    </div>
  );
}

function TableCard({ r, captainName, playAlert, existingTables, allReservations }: {
  r: HodTableReservation; captainName: string; playAlert: (u: boolean) => void; existingTables: string[]; allReservations: HodTableReservation[];
}) {
  const [editRound, setEditRound] = useState<{ round: HodTabRound; index: number } | null>(null);
  const [showPaid, setShowPaid] = useState(false);
  const [showAddOrder, setShowAddOrder] = useState(false);
  const [showReassign, setShowReassign] = useState(false);
  const [showVoidBill, setShowVoidBill] = useState(false);
  const [busy, setBusy] = useState("");
  const [qrFallback, setQrFallback] = useState<{ url: string; reason: string } | null>(null);
  const [aggOpen, setAggOpen] = useState(false);
  const [customDiscInput, setCustomDiscInput] = useState<string>(() =>
    String(r.aggregatorDiscount ?? getAggregatorDiscount(r.aggregator || r.source || "inhouse"))
  );

  const pending = (r.tabRounds || []).filter((rd) => rd.status === "preparing").length;
  const billReq = r.paymentStatus === "bill_requested";
  // 🩹 v3.4 belt-and-suspenders: orphan zomato-txn-* payment doc fallback.
  // Captain Mode polls for a sibling pending-booking doc that matches this
  // guest's first name when the booking itself isn't yet PAID, so the green
  // badge appears even if the cloud-function v3.4 claim hasn't run yet.
  const [orphanPay, setOrphanPay] = useState<OrphanZomatoPayment | null>(null);
  const aggForFallback = r.aggregator || r.source || "inhouse";
  useEffect(() => {
    let cancelled = false;
    if (r.paymentStatus === "paid" || aggForFallback !== "zomato" || !r.customerName) {
      setOrphanPay(null);
      return () => { cancelled = true; };
    }
    const tick = async () => {
      const o = await lookupOrphanZomatoPaymentByName(r.customerName || "", r.phone || "");
      if (!cancelled) setOrphanPay(o);
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [r.paymentStatus, aggForFallback, r.customerName]);
  const paid = r.paymentStatus === "paid" || !!orphanPay;
  // V3 2026-05-10 — `voided` reflects a Manager-PIN-gated bill void (customer
  // refused/walked out/etc). When true: hide payment + edit actions, show a
  // loud red badge, and only allow Release Table (which archives + clears).
  const voided = (r as any).status === "voided";
  // 🔴 2026-05-07 — show CLEAN SUBTOTAL on the table card (items × qty),
  // NOT the stored grandTotal. SC + GST get applied at Mark Paid time only,
  // matching restaurant convention where the customer sees a clean bill
  // and tax is added on payment. Wallets/covers (door/bar mode) are
  // unaffected — they remain cash-and-carry with per-item tax baked in.
  const tabTotal = (r.tabRounds || []).reduce(
    (s, rd) => s + (rd.items || []).reduce((ss, it) => ss + (it.p || 0) * (it.qty || 0), 0),
    0
  );
  const aggName = r.aggregator || r.source || "inhouse";
  const aggDiscount = r.aggregatorDiscount ?? getAggregatorDiscount(aggName);
  const aggLabel = AGGREGATOR_OPTIONS.find((a) => a.value === aggName)?.label || aggName;
  const isAgg = aggName !== "inhouse";

  const borderColor = billReq ? "rgba(239,68,68,.6)" : pending > 0 ? "rgba(242,199,68,.5)" : "rgba(255,255,255,.08)";

  const handleArrive = async () => {
    if (!confirm(`Mark ${r.customerName || "this guest"} as arrived?`)) return;
    setBusy("arrive");
    try {
      await markGuestArrived(r._docId, r.bookingRef, captainName);
      // 🔴 2026-05-18 (Khushi CRITICAL bug) — Captain arrival MUST mint the cover
      // doc for ALL non-inhouse sources (WhatsApp bot, Zomato/Swiggy/EazyDiner),
      // otherwise the customer wallet page at hodclub.in/?wallet=<ref> stays
      // locked on "will be activated when you arrive" because checkedIn /
      // coverActivated are never set. Mint is IDEMPOTENT (returns existing doc),
      // so we run it even on a re-tap or already-arrived row — guarantees the
      // wallet unlocks NO MATTER WHAT (independent of WhatsApp).
      if (r.bookingRef) {
        const src = (r.aggregator || (r as any).source || "inhouse").toLowerCase();
        if (src !== "inhouse") {
          try {
            await ensureCoverForAggregatorArrival({
              bookingRef: r.bookingRef,
              name: r.customerName || "",
              phone: (r as any).phone || (r as any).customerPhone || "",
              source: src,
              partySize: r.partySize,
              tableId: r.tableId,
              staffName: captainName,
            });
          } catch (e) { console.warn("[captain] cover mint on arrive failed", e); }
        }
      }
    } catch {}
    setBusy("");
  };

  // 🔴 2026-05-13 — Khushi: Print KOT must NOT mark the round as served.
  // It only flips the round to "activated" (Ready to Serve) so the kitchen
  // sees the chit; the captain comes back and presses "Mark Served"
  // (handleMarkServed below) once food has actually reached the table.
  const handleMarkServed = async (roundIdx: number) => {
    setBusy(`served-${roundIdx}`);
    try { await markRoundServed(r._docId, roundIdx, r.bookingRef); } catch {}
    setBusy("");
  };

  const handleServe = async (roundIdx: number) => {
    setBusy(`serve-${roundIdx}`);
    try {
      await markRoundActivated(r._docId, roundIdx, captainName, r.bookingRef);
      const round = (r.tabRounds || [])[roundIdx];
      if (round) {
        // Derive floor from TABLE ID, not tablet localStorage — matches bill logic
        // and BarMode. Captain may use any tablet; routing must follow the table.
        const tid = (r.tableId || "").toUpperCase();
        let tableFloor: TabletFloor = "first";
        if (tid.startsWith("C")) tableFloor = "ground";
        else if (tid.startsWith("T")) tableFloor = "rooftop";
        else if (tid.startsWith("FD") || tid.startsWith("SMK")) tableFloor = "first";
        const floorName = tableFloor === "ground" ? "GROUND FLOOR"
          : tableFloor === "rooftop" ? "ROOFTOP"
          : "FIRST FLOOR";
        const hasFood = (round.items || []).some((it) => it.t === "food");
        const hasDrink = (round.items || []).some((it) => it.t !== "food");
        // Rooftop has no bar → drinks made at FF bar (runners carry up)
        const barLabel = tableFloor === "ground" ? "GF BAR"
          : tableFloor === "rooftop" ? "FF BAR (no bar at RT)"
          : "FF BAR";
        const dests: string[] = [];
        if (hasFood) dests.push("2F KITCHEN");
        if (hasDrink) dests.push(barLabel);
        const kotOk = await printKOT({
          tableId: r.tableId, floorLabel: r.floorLabel, customerName: r.customerName,
          customerPhone: (r as any).customerPhone || (r as any).phone,
          bookingRef: r.bookingRef, reservationId: r._docId,
          staff: captainName, roundNum: round.roundNum, items: round.items, roundTotal: round.roundTotal,
          tabletFloor: tableFloor,
        });
        if (!kotOk) {
          alert(`❌ KOT print failed — check printer connection.\n\nTable floor: ${floorName}`);
        } else {
          alert(`🖨 KOT sent to: ${dests.join(" + ")}\n\nTable floor: ${floorName}\n(Derived from table ${r.tableId})`);
        }
      }
    } catch {}
    setBusy("");
  };

  const handleServeAll = async () => {
    const pendingIdxs = (r.tabRounds || [])
      .map((rd, i) => ({ rd, i }))
      .filter(({ rd }) => rd.status === "preparing" || rd.status === "activated")
      .map(({ i }) => i);
    if (pendingIdxs.length === 0) return;
    setBusy("serve-all");
    // Derive floor from TABLE ID, not tablet localStorage — matches bill logic
    // and BarMode. Captain may use any tablet; routing must follow the table.
    const tid = (r.tableId || "").toUpperCase();
    let tableFloor: TabletFloor = "first";
    if (tid.startsWith("C")) tableFloor = "ground";
    else if (tid.startsWith("T")) tableFloor = "rooftop";
    else if (tid.startsWith("FD") || tid.startsWith("SMK")) tableFloor = "first";
    const floorName = tableFloor === "ground" ? "GROUND FLOOR"
      : tableFloor === "rooftop" ? "ROOFTOP"
      : "FIRST FLOOR";
    let okCount = 0, failCount = 0;
    let anyFood = false, anyDrink = false;
    try {
      for (const idx of pendingIdxs) {
        try {
          // 🔴 2026-05-13 — match handleServe: Print KOT activates only,
          // the captain marks served separately when food reaches the table.
          await markRoundActivated(r._docId, idx, captainName, r.bookingRef);
          const round = (r.tabRounds || [])[idx];
          if (!round) continue;
          if ((round.items || []).some((it) => it.t === "food")) anyFood = true;
          if ((round.items || []).some((it) => it.t !== "food")) anyDrink = true;
          const ok = await printKOT({
            tableId: r.tableId, floorLabel: r.floorLabel, customerName: r.customerName,
            customerPhone: (r as any).customerPhone || (r as any).phone,
            bookingRef: r.bookingRef, reservationId: r._docId,
            staff: captainName, roundNum: round.roundNum, items: round.items, roundTotal: round.roundTotal,
            tabletFloor: tableFloor,
          });
          if (ok) okCount++; else failCount++;
        } catch { failCount++; }
      }
      // Rooftop has no bar → drinks made at FF bar (runners carry up)
      const barLabel = tableFloor === "ground" ? "GF BAR"
        : tableFloor === "rooftop" ? "FF BAR (no bar at RT)"
        : "FF BAR";
      const dests: string[] = [];
      if (anyFood) dests.push("2F KITCHEN");
      if (anyDrink) dests.push(barLabel);
      if (failCount === 0) {
        alert(`🖨 ${okCount} KOT${okCount > 1 ? "s" : ""} sent to: ${dests.join(" + ")}\n\nTable floor: ${floorName}\n(Derived from table ${r.tableId})`);
      } else {
        alert(`⚠ ${okCount} KOT${okCount > 1 ? "s" : ""} sent OK, ${failCount} failed.\n\nTable floor: ${floorName}\n\nCheck printer connection and retry failed rounds individually.`);
      }
    } catch (e: any) {
      alert("❌ Print all failed: " + (e?.message || String(e)));
    }
    setBusy("");
  };

  const handleRelease = async () => {
    // 🔴 2026-05-13 (Khushi) — Bill MUST be printed before release.
    // Catches the new edge case introduced by Pay-Online: customer pays
    // via wallet, "Mark Paid" disappears (correctly), but captain could
    // previously skip Print Bill and release the table immediately —
    // leaving the guest without a paper bill and the venue without an
    // archived printed copy. Hard block; cannot be confirmed past.
    // Empty tables (no items) are still releasable so genuine no-shows
    // / accidental seatings don't get stuck.
    const printed = (r.billPrintCount || 0) > 0;
    const hasItems = tabTotal > 0 || (r.tabRounds || []).length > 0;
    if (hasItems && !printed) {
      alert(`🖨 BILL NOT PRINTED YET\n\nPrint the bill first, then release ${r.tableId}.\n\n(Tap "🖨 Print Bill" above.)`);
      return;
    }
    // Reprint required (items changed since last bill)? Same hard block —
    // the printed paper must reflect the final order.
    if (hasItems && r.billStale) {
      alert(`⚠ ITEMS CHANGED SINCE LAST BILL\n\nReprint the bill before releasing ${r.tableId}.`);
      return;
    }
    const preparingRounds = (r.tabRounds || []).filter(rd => rd.status === "preparing").length;
    if (preparingRounds > 0) {
      if (!confirm(`⚠️ ${preparingRounds} round(s) still PREPARING in kitchen!\n\nRelease anyway? Kitchen orders will be lost.`)) return;
    }
    const hasUnpaid = !paid && tabTotal > 0;
    const msg = hasUnpaid
      ? `⚠️ UNPAID TAB: ₹${tabTotal}\n\nRelease without payment?`
      : `Release ${r.tableId} for new guests?`;
    if (!confirm(msg)) return;
    setBusy("release");
    // 🔴 2026-05-13 v3 (Khushi clarification) — the thank-you message is
    // for the CUSTOMER's wallet, not the captain. The captain side stays
    // silent on success (table just disappears from the list, which is
    // the expected feedback). releaseTable now writes a marker doc to
    // `releasedReservations/{bookingRef}` so the customer's wallet shows
    // "🙏 Thank you for visiting" on next refresh. Errors still surface.
    try {
      await releaseTable(r._docId, r, captainName);
    } catch (e: any) {
      alert(`❌ Release failed: ${e?.message || String(e)}`);
    }
    setBusy("");
  };

  const handleThermalBill = async (_legacyIsDuplicate?: boolean) => {
    const allItems: HodOrderItem[] = ((r.tabRounds || []).flatMap((rd) => rd.items || []) as HodOrderItem[])
      .filter((it) => it && it.qty > 0);
    if (allItems.length === 0) { alert("No items to print on bill."); return; }
    // L6 — debounce/confirm rapid reprints.
    const prevCount = r.billPrintCount || 0;
    const lastAt = r.lastBillPrintedAt ? new Date(r.lastBillPrintedAt).getTime() : 0;
    if (prevCount > 0 && Date.now() - lastAt < BILL_REPRINT_DEBOUNCE_MS) {
      const secs = Math.ceil((BILL_REPRINT_DEBOUNCE_MS - (Date.now() - lastAt)) / 1000);
      if (!window.confirm(`⚠ A bill was just printed ${Math.ceil((Date.now()-lastAt)/1000)}s ago.\n\nReprint anyway? (Wait ${secs}s to skip this prompt.)`)) return;
    }
    // Derive floor from tableId prefix: C*/CVIP* = ground, FD*/SMK* = first, T*/TVIP*/TEX* = rooftop.
    const id = (r.tableId || "").toUpperCase();
    let floor: TabletFloor = "first";
    if (id.startsWith("C")) floor = "ground";
    else if (id.startsWith("T")) floor = "rooftop";
    else if (id.startsWith("FD") || id.startsWith("SMK")) floor = "first";
    // Mirror MarkPaidModal math EXACTLY so the printed bill matches what's
    // charged. Uses computeHodBreakdown which (1) bases SC on subtotal,
    // (2) bases GST on (food + non-alc + SC) — alcohol is GST-exempt per
    // Indian liquor licence rules — and (3) rounds correctly.
    const subtotal = allItems.reduce((s, it) => s + (it.p || 0) * (it.qty || 0), 0);
    const aggName = (r as any).aggregator || (r as any).source || "inhouse";
    const discountPct: number = (r as any).aggregatorDiscount ?? getAggregatorDiscount(aggName) ?? 0;
    const discountAmt = Math.round(subtotal * discountPct / 100);
    const afterDiscount = subtotal - discountAmt;
    const scaleFactor = subtotal > 0 ? afterDiscount / subtotal : 1;
    const scaledItems = allItems.map((it) => ({ ...it, p: (it.p || 0) * scaleFactor }));
    const bd = computeHodBreakdown(scaledItems);
    const scAmt = Math.round(bd.serviceCharge);
    const taxAmt = Math.round(bd.gst);
    const cgst = Math.round((taxAmt / 2) * 100) / 100;
    const sgst = Math.round((taxAmt / 2) * 100) / 100;
    const finalAmount = afterDiscount + scAmt + taxAmt;
    setBusy("printbill");
    try {
      // L3/L4/L5 — atomic record (count++, append log, snapshot lock, clear stale).
      const rec = await recordBillPrint(r._docId, {
        by: captainName, total: finalAmount, discountPct,
        aggregator: aggName, billNumberBase: r._docId.slice(-6).toUpperCase(),
      });
      const ok = await printBill({
        tableId: r.tableId,
        floorLabel: r.floorLabel,
        customerName: r.customerName,
        partySize: (r as any).partySize,
        staff: captainName,
        items: allItems.map((i) => ({ n: i.n, p: i.p, qty: i.qty })),
        amounts: { subtotal, serviceCharge: scAmt, cgst, sgst,
          discount: discountAmt, roundOff: 0, total: finalAmount },
        paymentMethod: (r as any).paymentMethod || (discountPct > 0 ? aggName : undefined),
        billNumber: rec.billNumber,            // L3 — always suffixed (-1, -2, -3…)
        isDuplicate: rec.isDuplicate,          // L4 — true on every reprint
        tabletFloor: floor,
      });
      const floorName = floor === "ground" ? "GROUND FLOOR" : floor === "first" ? "FIRST FLOOR" : "ROOFTOP";
      alert(ok
        ? `🖨 Bill #${rec.billNumber} sent to: ${floorName} BILL PRINTER${rec.isDuplicate ? "\n\n⚠ DUPLICATE REPRINT" : ""}\n\n(Floor derived from table ${r.tableId})`
        : "❌ Bill print failed — check console / Firestore.");
    } catch (e: any) { alert("❌ Bill print failed: " + e.message); }
    setBusy("");
  };

  const handleAggChange = async (value: string, customDisc?: number) => {
    const disc = customDisc !== undefined ? customDisc : getAggregatorDiscount(value);
    const fromSource = r.aggregator || r.source || "inhouse";
    const fromDisc = r.aggregatorDiscount ?? getAggregatorDiscount(fromSource);
    const sourceChanged = fromSource !== value;
    const discountChanged = fromDisc !== disc;
    // No-op? bail.
    if (!sourceChanged && !discountChanged) { setAggOpen(false); setCustomDiscInput(""); return; }

    let managerOverride = false;
    let reason = "";
    let kind: "captain-source-swap" | "captain-discount-edit" = sourceChanged ? "captain-source-swap" : "captain-discount-edit";
    const impliedDisc = getAggregatorDiscount(value) || 0;

    // L1/L7 — once a bill is printed, ANY source/discount swap needs Manager PIN
    // (this also runs the post-bill audit-log path inside setReservationAggregator).
    const isAggregatorDowngradePost = sourceChanged && fromSource !== "inhouse" && value === "inhouse";
    if ((r.billPrintCount || 0) > 0) {
      const ok = await requireManagerPin(
        `Bill already printed for ${r.tableId}.\nChanging source from "${fromSource}" (${fromDisc}%) → "${value}" (${disc}%) will FORCE A REPRINT and be logged for audit.` +
        (isAggregatorDowngradePost ? "\n\n⚠ DOWNGRADE FROM AGGREGATOR — extra Admin PIN required next." : ""));
      if (!ok) return;
      managerOverride = true;
      // Same Admin-PIN second-factor rule applies post-bill: stripping an
      // aggregator after the bill was already printed is even higher risk
      // (customer paid via Zomato, captain swaps to inhouse to pocket diff).
      if (isAggregatorDowngradePost) {
        const ok2 = await requireAdminPin(
          `POST-BILL switch on ${r.tableId} from "${fromSource}" (${fromDisc}%) → in-house.\nThis strips the aggregator discount AFTER the bill was already printed.`);
        if (!ok2) return;
      }
      reason = window.prompt(`Reason for post-bill source/discount change on ${r.tableId}:`)?.trim() || "(no reason)";
    } else {
      // L-A4 PRE-BILL: any source change needs Manager PIN + reason. The most
      // dangerous direction (aggregator → inhouse) ALSO needs Admin PIN per
      // Darshan's rule: customer pre-paid Zomato 30%, switching to in-house
      // would silently strip that discount.
      const isAggregatorDowngrade = fromSource !== "inhouse" && value === "inhouse";
      if (sourceChanged) {
        const ok = await requireManagerPin(
          `Pre-bill source change on ${r.tableId}:\n"${fromSource}" (${fromDisc}%) → "${value}" (${disc}%)\n\n` +
          (isAggregatorDowngrade ? "⚠ DOWNGRADE FROM AGGREGATOR — extra Admin PIN required next." : "Logged for audit."));
        if (!ok) return;
        managerOverride = true;
        if (isAggregatorDowngrade) {
          const ok2 = await requireAdminPin(
            `Switching ${r.tableId} from "${fromSource}" (paid via aggregator at ${fromDisc}%) → in-house.\nThis strips the aggregator discount.`);
          if (!ok2) return;
        }
        reason = window.prompt(`Reason for switching ${r.tableId} → "${value}":`)?.trim() || "(no reason)";
      }
      // D3-extension — pre-bill custom discount overshooting the source's
      // implied default by > +5pp also needs Manager PIN.
      if (customDisc !== undefined && customDisc > impliedDisc + WALKIN_DISCOUNT_PIN_DELTA) {
        const ok = await requireManagerPin(
          `Custom discount: ${customDisc}% on source "${value}"\n(implied ${impliedDisc}% + ${WALKIN_DISCOUNT_PIN_DELTA}pp tolerance)\nTable: ${r.tableId}`);
        if (!ok) return;
        managerOverride = true;
        kind = "captain-discount-edit";
        reason = window.prompt(`Reason for ${customDisc}% custom discount:`)?.trim() || (reason || "(no reason)");
      }
    }
    try {
      // Always logs to sourceOverrideLog now (any change pre or post-bill).
      await setReservationAggregator(r._docId, value, disc, { managerOverride, staffName: captainName, reason });
      // If the captain typed a custom discount that triggered the +5pp PIN
      // gate, ALSO write to discountOverrideLog so the Live Monitor's
      // "OVERRIDES" tile sees it (sourceOverrideLog is for source swaps).
      if (managerOverride && customDisc !== undefined && customDisc > impliedDisc + WALKIN_DISCOUNT_PIN_DELTA) {
        await recordWalkInDiscountOverride(r._docId, {
          by: captainName, valueBefore: impliedDisc, valueAfter: customDisc,
          reason: reason || "(no reason)", kind, sourceBefore: fromSource, sourceAfter: value,
        });
      }
    } catch (e: any) { alert(e.message); return; }
    setAggOpen(false);
    setCustomDiscInput("");
  };

  // L9 — Mark Paid is gated on at least one bill print; manager can override.
  const handleOpenMarkPaid = async () => {
    if ((r.billPrintCount || 0) === 0) {
      const ok = await requireManagerPin(
        `No thermal bill has been printed for ${r.tableId}.\nMarking paid without a printed bill skips the audit chit.`);
      if (!ok) return;
    }
    setShowPaid(true);
  };

  const sendWhatsApp = async () => {
    const custPhone = (r.phone || "").replace(/\D/g, "");
    if (!custPhone) {
      alert("No phone number for this customer.");
      return;
    }
    const ref = r.bookingRef || r._docId;
    const url = `https://hodclub.in/?wallet=${encodeURIComponent(ref)}`;
    const customerName = r.customerName || "Guest";
    // 🔴 2026-05-19 (Khushi LIVE-NIGHT FIX) — fallback every interpolated field.
    // Bot bookings & aggregator pre-arrival have no tableId / arrivalTime yet,
    // and rendered "Table: undefined" / empty "Time:" lines in WhatsApp. Default
    // to plain-language placeholders so the message ALWAYS reads cleanly.
    const tableLabel = r.tableId || "Your table";
    const floorLabel = r.floorLabel || r.floor || "";
    const dateLabel = r.date || new Date().toLocaleDateString("en-IN", { year: "numeric", month: "2-digit", day: "2-digit" });
    const timeLabel = r.arrivalTime || "On arrival";
    const guestsLabel = r.partySize || 2;
    // 2026-05-13 — fallback message format locked by Khushi. Order, emojis,
    // and spacing must match the spec exactly. Location link MUST be a plain
    // Google Maps URL — the previous `maps.app.goo.gl/...` short link routed
    // through Firebase Dynamic Links (shut down 2025-08-25) and showed
    // "Dynamic Link Not Found" when guests tapped it.
    const fallbackMessage =
      `Hi ${customerName}! 🎉 Your booking at HOD - House Of Dopamine is confirmed.\n\n` +
      `📅 Date: ${dateLabel}\n` +
      `🕐 Time: ${timeLabel}\n` +
      `🪑 Table: ${tableLabel}${floorLabel ? ` (${floorLabel})` : ""}\n` +
      `👥 Guests: ${guestsLabel}\n\n` +
      `View menu & pre-order: ${url}\n\n` +
      `See you soon!\n\n` +
      `📍 House of Dopamine, Koramangala\n${HOD_LOCATION_URL}`;

    // 🔴 2026-05-18 (Khushi CRITICAL — wallet unlock CANNOT depend on WhatsApp).
    // BEFORE we touch WhatsApp at all, mint the covers doc for non-inhouse
    // bookings (WA bot, Zomato, Swiggy, EazyDiner). This UNLOCKS the wallet at
    // hodclub.in/?wallet=<ref> instantly. After this, even if WhatsApp fails
    // 100% — the QR fallback below works, copy-link works, captain can share
    // the link any way (SMS, AirDrop, hand over phone) and the menu will open.
    // Mint is idempotent (no-op if cover already exists).
    setBusy("wa");
    if (r.bookingRef) {
      const src = (r.aggregator || (r as any).source || "inhouse").toLowerCase();
      if (src !== "inhouse") {
        try {
          await ensureCoverForAggregatorArrival({
            bookingRef: r.bookingRef,
            name: customerName,
            phone: custPhone,
            source: src,
            partySize: r.partySize,
            tableId: r.tableId,
            staffName: captainName,
          });
          console.log("[captain][send-menu] cover doc ensured for", r.bookingRef);
        } catch (e) { console.warn("[captain][send-menu] cover mint failed (continuing)", e); }
      }
    }

    // 🔴 2026-05-13 v2 (Khushi spec) — Send Menu must NOT open a wa.me tab
    // anymore. The previous wa.me-first flow popped open browser.whatsapp.com
    // on the captain's tablet AND fired a duplicate Meta send in the
    // background, so guests received two messages and the captain saw a
    // confusing browser tab. New flow mirrors Door Mode (BookingDetailModal
    // sendWhatsApp): Meta Cloud API first (silent), success → ✓ tick alert,
    // failure → QR popup with the wallet link (reuses WhatsAppQrFallbackModal,
    // same pattern Door Mode uses for Cover/Guestlist). No wa.me tab ever.
    try {
      // 2026-05-13 — order intentionally flipped. The Meta-approved
      // `table_ready` template body is LOCKED ("Your table is ready at HOD!
      // Hi {name}, table {tbl} on {floor} is set for you…") and Meta won't
      // re-approve text changes for days. Khushi's new spec lives in
      // `fallbackMessage` above, so we now try free-form text FIRST and only
      // fall back to the old-format template if Meta blocks the text (guest
      // outside the 24h customer-service reply window with no prior chat).
      // Most guests just booked via hodclub.in, which sends a Razorpay
      // confirmation — that opens the 24h window, so the new format wins.
      const fbRes = await fetch(`${WHATSAPP_CF_BASE}/sendWhatsAppText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: custPhone, message: fallbackMessage }),
      });
      const fbData = await fbRes.json();
      if (fbRes.ok && fbData.ok) {
        alert(`✅ WhatsApp menu sent to ${fbData.recipient}\n\nIf the guest doesn't see it in 30s, ask them to check spam or scan the QR fallback.`);
        setBusy("");
        return;
      }
      console.warn("Text send failed, falling back to template:", fbData);

      // Fallback: approved template (old format, but works outside the 24h
      // window for guests who haven't chatted with us yet).
      const tplRes = await fetch(`${WHATSAPP_CF_BASE}/sendWhatsAppTemplate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: custPhone,
          template: "table_ready",
          language: "en",
          params: [customerName, tableLabel, floorLabel, url],
        }),
      });
      const tplData = await tplRes.json();
      if (tplRes.ok && tplData.ok) {
        alert(`✓ WhatsApp sent to ${tplData.recipient}\n(used approved template — guest is outside the 24h reply window, so the new format couldn't be sent)`);
        setBusy("");
        return;
      }
      console.warn("Template fallback also failed:", tplData);

      // Last resort: show in-app QR popup so the guest scans the captain's
      // tablet directly. Avoids needing a separate "Show QR" button on the row.
      const tplCode = tplData.code;
      const isTemplateMissing = tplCode === 132001 || tplCode === 132000 || tplCode === 132012 || tplCode === 132015;
      const reason = isTemplateMissing
        ? `WhatsApp template not approved yet — show this QR for the guest to scan.`
        : `WhatsApp send failed${fbData.code ? ` (code ${fbData.code})` : ""} — show this QR for the guest to scan.`;
      setQrFallback({ url, reason });
    } catch (err) {
      console.error("WhatsApp send error", err);
      alert("Network error sending WhatsApp. Check your connection.");
    }
    setBusy("");
  };

  return (
    <>
      <div style={{ background: "rgba(255,255,255,.04)", border: `2px solid ${borderColor}`, borderRadius: 16, marginBottom: 14, overflow: "hidden", ...(billReq ? { boxShadow: "0 0 20px rgba(239,68,68,.15)" } : {}) }}>
        <div style={{ padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", background: billReq ? "rgba(239,68,68,.08)" : pending > 0 ? "rgba(242,199,68,.05)" : "" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
              <span style={{ fontSize: 18, fontWeight: 900, color: "#F2C744" }}>{r.tableId}</span>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,.4)" }}>{r.floorLabel || r.floor}</span>
              {r.actualArrivalTime ? (
                <span style={{ background: "rgba(242,199,68,.12)", border: "1px solid rgba(242,199,68,.3)", color: "#F2C744", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 10 }}>✓ ARRIVED {r.actualArrivalTime}</span>
              ) : (
                <span style={{ background: "rgba(251,191,36,.12)", border: "1px solid rgba(251,191,36,.3)", color: "#FBBF24", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 10 }}>⏳ NOT ARRIVED</span>
              )}
              {voided && <span title={`Bill voided by ${(r as any).voidedBy || "?"} — ${(r as any).voidReason || ""}${(r as any).voidNotes ? ` (${(r as any).voidNotes})` : ""}`} style={{ background: "rgba(239,68,68,.18)", border: "1px solid rgba(239,68,68,.5)", color: "#EF4444", fontSize: 10, fontWeight: 900, padding: "3px 8px", borderRadius: 10, cursor: "help" }}>🚫 BILL VOIDED · ₹{Math.round((r as any).voidedBillTotal || 0)}</span>}
              {paid && (() => {
                // ── 2026-05-13 round 9 (Khushi spec): when the customer
                // paid via the wallet's "Pay Online" button, Razorpay
                // success stamps `paymentMethod:'paid_online'` on the
                // reservation. Render that as a GREEN ✅ PAID ONLINE
                // chip so the captain instantly sees online settlements
                // distinct from captain-marked ones (yellow ✅ PAID).
                const pm = String((r as any).paymentMethod || (orphanPay ? orphanPay.paymentChannel : "")).toLowerCase();
                const isOnline = pm === "paid_online";
                const isAgg = ["zomato","swiggy","eazydiner","payeazy"].includes(pm);
                const pid = String((r as any).paymentId || "");
                const amt = (r as any).amountPaid;
                const paidAtIso = (r as any).paidAt as string | undefined;
                const paidAtStr = paidAtIso ? new Date(paidAtIso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "";
                const tip = isOnline
                  ? `Customer paid online via Razorpay${amt ? ` · ₹${amt}` : ""}${paidAtStr ? ` at ${paidAtStr}` : ""}${pid ? ` · ID …${pid.slice(-8)}` : ""}`
                  : (orphanPay && r.paymentStatus !== "paid"
                      ? `Auto-matched from an unclaimed Zomato payment of ₹${orphanPay.paidAmount}. Verify the amount before releasing the table.`
                      : "Marked paid by the captain.");
                const bg = isOnline ? "rgba(0,200,100,.18)" : "rgba(242,199,68,.12)";
                const bd = isOnline ? "rgba(0,200,100,.55)" : "rgba(242,199,68,.3)";
                const fg = isOnline ? "#00C864" : "#F2C744";
                const label = isOnline
                  ? "✅ PAID ONLINE"
                  : ("✅ PAID" + (isAgg ? ` · ${pm.toUpperCase()}` : ""));
                const showWarn = orphanPay && r.paymentStatus !== "paid" && !isOnline;
                return (
                  <span title={tip} style={{ background: bg, border: `1px solid ${bd}`, color: fg, fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 10, cursor: showWarn || isOnline ? "help" : "default" }}>
                    {label}{showWarn ? " ⚠︎" : ""}
                  </span>
                );
              })()}
              {billReq && <span style={{ background: "rgba(239,68,68,.15)", border: "1px solid rgba(239,68,68,.4)", color: "#EF4444", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 10 }}>🧾 BILL DUE</span>}
              {pending > 0 && <span style={{ background: "rgba(242,199,68,.12)", border: "1px solid rgba(242,199,68,.3)", color: "#F2C744", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 10 }}>🔴 {pending} PENDING</span>}
            </div>
            <div style={{ fontSize: 12, color: "#fff", fontWeight: 700 }}>{r.customerName}</div>
            <div style={{ display: "flex", gap: 12, fontSize: 11, color: "rgba(255,255,255,.4)", marginTop: 3 }}>
              <span>👥 {r.partySize || "?"}p</span>
              <span>🕐 {r.arrivalTime}</span>
              <span>📱 {r.phone}</span>
            </div>
            {isAgg && (
              <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {/* 🔴 2026-05-12 — Solid-red badge styled to match the menu's
                    ADD+ button (red fill #A02820 + white text, 4px radius,
                    Space Grotesk bold uppercase). The discount % is shown
                    so the captain knows what the aggregator will deduct
                    when settling — even though the door-printed bill is
                    the FULL amount. */}
                <div title={`Aggregator deducts ${aggDiscount}% commission. Door bill prints the FULL invoice; venue nets ${100 - aggDiscount}% after settlement.`}
                  style={{ fontSize: 10, fontWeight: 800, padding: "4px 10px", borderRadius: 4, display: "inline-block",
                    background: "#A02820", border: "1px solid #A02820", color: "#fff",
                    letterSpacing: ".5px", textTransform: "uppercase",
                    fontFamily: "'Space Grotesk', sans-serif" }}>
                  {aggLabel}{aggDiscount > 0 ? ` · ${aggDiscount}%` : ""}
                </div>
              </div>
            )}
            {/* Captain-modified in-house discount (PIN-gated) gets its own
                small red pill so the captain knows the bill carries a
                manual discount that WILL be applied at Mark-Paid. */}
            {!isAgg && aggDiscount > 0 && r.discountModifiedByCaptain && (
              <div style={{ marginTop: 6, fontSize: 10, fontWeight: 800, padding: "4px 10px", borderRadius: 4, display: "inline-block",
                background: "#A02820", color: "#fff", letterSpacing: ".5px",
                fontFamily: "'Space Grotesk', sans-serif", textTransform: "uppercase" }}>
                In-House · {aggDiscount}% discount
              </div>
            )}
          </div>
          <div style={{ textAlign: "right" }}>
            {tabTotal > 0 && (
              <>
                <div style={{ fontSize: 18, fontWeight: 900, color: "#F2C744" }}>₹{tabTotal}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)" }}>subtotal · +SC/GST at pay</div>
                {/* 🔴 2026-05-12 — Discount preview ONLY for non-aggregator
                    tabs that the captain has explicitly modified. Aggregator
                    bookings never preview a discount here because the
                    customer bill is printed at the FULL amount. */}
                {!isAgg && aggDiscount > 0 && r.discountModifiedByCaptain && (
                  <div style={{ fontSize: 10, color: "#A02820", fontWeight: 700 }}>-{aggDiscount}% = ₹{Math.round(tabTotal * (1 - aggDiscount / 100))}</div>
                )}
              </>
            )}
          </div>
        </div>

        {(() => {
          const pendingCount = (r.tabRounds || []).filter((rd) => rd.status === "preparing" || rd.status === "activated").length;
          if (pendingCount < 2) return null;
          return (
            <div style={{ padding: "8px 16px 0" }}>
              <button onClick={handleServeAll} disabled={busy === "serve-all"}
                style={{ width: "100%", padding: 12, borderRadius: 10, background: "linear-gradient(135deg,rgba(242,199,68,.9),rgba(160,40,32,.8))", border: "none", color: "#fff", fontSize: 14, fontWeight: 900, cursor: "pointer" }}>
                {busy === "serve-all" ? "..." : `🖨 PRINT ALL ${pendingCount} PENDING KOTs`}
              </button>
            </div>
          );
        })()}

        {r.tabRounds && r.tabRounds.length > 0 ? (
          <div style={{ padding: "0 16px 10px" }}>
            {r.tabRounds.map((rd, idx) => {
              const isPending = rd.status === "preparing";
              const isActivated = rd.status === "activated";
              const isServed = rd.status === "served";
              const needsAction = isPending || isActivated;
              return (
                <div key={idx} style={{ borderTop: "1px solid rgba(255,255,255,.06)", padding: "8px 0", ...(needsAction ? { background: isPending ? "rgba(242,199,68,.02)" : "rgba(242,199,68,.02)" } : { opacity: 0.6 }) }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5, gap: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: "#F2C744" }}>Round {rd.roundNum}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, color: "#F2C744" }}>
                        {isPending ? "🔴 Preparing" : isActivated ? "🔵 Ready to Serve" : "✅ Served"}
                      </span>
                      {needsAction && (
                        // 🔴 2026-05-13 — Khushi: pencil icon was too cryptic;
                        // captains kept missing it. Replaced with explicit
                        // "Edit Order" text button. Edit writes via
                        // updateRoundItems → mirrors to covers (see
                        // firestore-hod) so customer wallet sees the change.
                        <button onClick={() => setEditRound({ round: rd, index: idx })}
                          title="Edit this round"
                          style={{ padding: "5px 10px", borderRadius: 6, background: "rgba(242,199,68,.12)", border: "1px solid rgba(242,199,68,.4)", color: "#F2C744", fontSize: 10, fontWeight: 800, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif", letterSpacing: .4, textTransform: "uppercase", lineHeight: 1 }}>
                          ✏️ Edit Order
                        </button>
                      )}
                    </div>
                  </div>
                  {(rd.items || []).map((it, ii) => (
                    <div key={ii} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
                      <span style={{ color: "#fff" }}>{it.qty}× {it.n}</span>
                      <span style={{ color: "#F2C744" }}>₹{it.p * it.qty}</span>
                    </div>
                  ))}
                  {/* 🔴 2026-05-13 — Khushi: Print KOT was wrongly flipping
                      the customer wallet to "Served" the moment the kitchen
                      ticket printed. Split into two distinct actions:
                        - Print KOT (preparing → activated/Ready to Serve)
                        - Mark Served (activated → served, only when food has
                          actually reached the table)
                      The wallet now matches reality. */}
                  {isPending && (
                    <div style={{ marginTop: 8 }}>
                      <button onClick={() => handleServe(idx)} disabled={busy === `serve-${idx}`}
                        style={{ width: "100%", padding: 9, borderRadius: 8, background: "rgba(242,199,68,.1)", border: "1px solid rgba(242,199,68,.3)", color: "#F2C744", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif", letterSpacing: ".4px", textTransform: "uppercase" }}>
                        {busy === `serve-${idx}` ? "..." : "🖨 Print KOT"}
                      </button>
                    </div>
                  )}
                  {isActivated && (
                    <div style={{ marginTop: 8 }}>
                      <button onClick={() => handleMarkServed(idx)} disabled={busy === `served-${idx}`}
                        style={{ width: "100%", padding: 9, borderRadius: 8, background: "rgba(34,197,94,.12)", border: "1px solid rgba(34,197,94,.45)", color: "#22c55e", fontSize: 12, fontWeight: 800, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif", letterSpacing: ".4px", textTransform: "uppercase" }}>
                        {busy === `served-${idx}` ? "..." : "✅ Mark Served"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ padding: "8px 16px 10px", fontSize: 12, color: "rgba(255,255,255,.4)" }}>No orders yet</div>
        )}

        {r.billStale && !paid && (
          <div style={{ margin: "6px 16px 8px", padding: "10px 12px", borderRadius: 10,
            background: "linear-gradient(135deg, rgba(239,68,68,.18), rgba(239,68,68,.08))",
            border: "1px solid rgba(239,68,68,.55)",
            color: "#FCA5A5", fontSize: 11, fontWeight: 800, letterSpacing: ".4px",
            display: "flex", alignItems: "center", gap: 8,
            boxShadow: "0 0 16px rgba(239,68,68,.18)" }}
            data-testid="banner-bill-stale">
            <span style={{ fontSize: 16 }}>⚠</span>
            <span>ITEMS CHANGED SINCE LAST BILL · REPRINT REQUIRED before Mark Paid</span>
          </div>
        )}
        {(r.billPrintCount || 0) > 0 && !r.billStale && !paid && (
          <div style={{ margin: "6px 16px 8px", padding: "6px 10px", borderRadius: 8,
            background: "rgba(242,199,68,.08)", border: "1px solid rgba(242,199,68,.25)",
            color: "rgba(242,199,68,.85)", fontSize: 10, fontWeight: 700, letterSpacing: ".4px" }}>
            🔒 Bill #{r.billPrintCount} printed at {new Date(r.lastBillPrintedAt || "").toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"})} · source LOCKED to {r.billLockedSource || r.aggregator || "inhouse"} ({r.billLockedDiscount ?? r.aggregatorDiscount ?? 0}%)
          </div>
        )}
        {/* 🔴 2026-05-12 — Source/Discount panel removed. Aggregator identity
            is shown by the small red badge in the card header; non-aggregator
            tabs default to in-house and discount is set (PIN-gated, max 15%)
            at Mark-Paid time. Keeps the door tablet UI uncluttered. */}

        {/* 🔴 2026-05-12 — All action buttons unified to Space Grotesk
            uppercase to match the customer menu's typography. Destructive
            actions (Void Bill, Release Table) use the same solid-red
            #A02820 + white-text treatment as the aggregator badge so the
            captain reads "red box = serious action". */}
        <div style={{ padding: "6px 16px 14px", display: "flex", gap: 8, flexWrap: "wrap", fontFamily: "'Space Grotesk', sans-serif" }}>
          {/* 🔴 2026-05-13 — Guest Arrived button removed from modal; it now lives
              inline on the BookingRow itself (one-tap arrival without opening the
              full booking detail). Modal kept clean for ordering / billing actions. */}
          {!paid && (
            <button onClick={() => setShowAddOrder(true)}
              style={{ flex: 1, minWidth: 120, padding: "9px 12px", borderRadius: 9, background: "rgba(242,199,68,.1)", border: "1px solid rgba(242,199,68,.3)", color: "#F2C744", fontSize: 11, fontWeight: 700, cursor: "pointer", letterSpacing: ".5px", fontFamily: "inherit", textTransform: "uppercase" }}>
              📝 Add Order
            </button>
          )}
          <button onClick={sendWhatsApp}
            style={{ flex: 1, minWidth: 120, padding: "9px 12px", borderRadius: 9, background: "rgba(242,199,68,.06)", border: "1px solid rgba(242,199,68,.25)", color: "#F2C744", fontSize: 11, fontWeight: 700, cursor: "pointer", letterSpacing: ".5px", fontFamily: "inherit", textTransform: "uppercase" }}>
            📲 Send Menu
          </button>
          {(tabTotal > 0 || (r.tabRounds || []).length > 0) && (() => {
            const printedCount = r.billPrintCount || 0;
            const stale = !!r.billStale;
            const label = busy === "printbill"
              ? "..."
              : stale
                ? `⚠ REPRINT BILL (#${printedCount + 1})`
                : printedCount === 0
                  ? "🖨 Print Bill"
                  : `🖨 Reprint Bill (#${printedCount + 1})`;
            return (
              <button onClick={() => handleThermalBill(paid)} disabled={busy === "printbill"}
                style={{ flex: 1, minWidth: 110, padding: "9px 12px", borderRadius: 9,
                  background: stale ? "#A02820" : "rgba(242,199,68,.15)",
                  border: `1px solid ${stale ? "#A02820" : "rgba(242,199,68,.45)"}`,
                  color: stale ? "#fff" : "#F2C744",
                  fontSize: 11, fontWeight: 800, letterSpacing: ".5px",
                  fontFamily: "inherit", textTransform: "uppercase",
                  cursor: busy === "printbill" ? "wait" : "pointer",
                  boxShadow: stale ? "0 0 12px rgba(160,40,32,.4)" : "none" }}
                data-testid="button-thermal-bill-captain">
                {label}
              </button>
            );
          })()}
          {!paid && !voided && (tabTotal > 0 || billReq) && (
            <button onClick={handleOpenMarkPaid}
              style={{ flex: 1, minWidth: 100, padding: "9px 12px", borderRadius: 9, background: "linear-gradient(135deg,#F2C744,#B8951F)", border: "none", color: "#0A0A0A", fontSize: 11, fontWeight: 900, cursor: "pointer", letterSpacing: ".5px", fontFamily: "inherit", textTransform: "uppercase" }}>
              💰 Mark Paid
            </button>
          )}
          {!paid && !voided && (r.billPrintCount || 0) > 0 && (
            <button onClick={async () => {
              // V3 anti-fraud #A2 — pre-flight cap check; abort early w/ clear msg.
              try { await assertCaptainCanVoid(captainName); }
              catch (e: unknown) { alert(e instanceof Error ? e.message : "Void blocked."); return; }
              setShowVoidBill(true);
            }}
              title="Use ONLY when bill was printed but customer cannot/will not pay (Manager PIN required)"
              style={{ flex: 1, minWidth: 110, padding: "9px 12px", borderRadius: 9, background: "#A02820", border: "1px solid #A02820", color: "#fff", fontSize: 11, fontWeight: 900, cursor: "pointer", letterSpacing: ".5px", fontFamily: "inherit", textTransform: "uppercase" }}>
              🚫 Void Bill
            </button>
          )}
          <button onClick={handleRelease} disabled={busy === "release"}
            style={{ flex: 1, minWidth: 100, padding: "9px 12px", borderRadius: 9, background: "#A02820", border: "1px solid #A02820", color: "#fff", fontSize: 11, fontWeight: 900, cursor: "pointer", letterSpacing: ".5px", fontFamily: "inherit", textTransform: "uppercase" }}>
            {busy === "release" ? "..." : "🔓 Release Table"}
          </button>
        </div>
      </div>

      {editRound && <EditOrderModal round={editRound.round} roundIndex={editRound.index} docId={r._docId} captainName={captainName} bookingRef={r.bookingRef} tableId={r.tableId} floorLabel={r.floorLabel} customerName={r.customerName} onClose={() => setEditRound(null)} />}
      {showPaid && <MarkPaidModal reservation={r} captainName={captainName} onClose={() => setShowPaid(false)} />}
      {showAddOrder && <AddOrderModal docId={r._docId} tableId={r.tableId} captainName={captainName} onClose={() => setShowAddOrder(false)} />}
      {qrFallback && <WhatsAppQrFallbackModal url={qrFallback.url} reason={qrFallback.reason} customerName={r.customerName || "Guest"} tableId={r.tableId} onClose={() => setQrFallback(null)} />}
      {showReassign && <ReassignTableModal reservation={r} existingTables={existingTables} allReservations={allReservations} captainName={captainName} onClose={() => setShowReassign(false)} />}
      {showVoidBill && (() => {
        // Recompute the same final total the bill printer used so leakage in
        // Reports / voidLog matches the paper bill the customer was handed.
        const allItems: HodOrderItem[] = ((r.tabRounds || []).flatMap((rd) => rd.items || []) as HodOrderItem[])
          .filter((it) => it && it.qty > 0);
        const subtotal = allItems.reduce((s, it) => s + (it.p || 0) * (it.qty || 0), 0);
        const aggForVoid = (r as any).aggregator || (r as any).source || "inhouse";
        const discountPct: number = (r as any).aggregatorDiscount ?? getAggregatorDiscount(aggForVoid) ?? 0;
        const discountAmt = Math.round(subtotal * discountPct / 100);
        const afterDiscount = subtotal - discountAmt;
        const scaleFactor = subtotal > 0 ? afterDiscount / subtotal : 1;
        const scaledItems = allItems.map((it) => ({ ...it, p: (it.p || 0) * scaleFactor }));
        const bd = computeHodBreakdown(scaledItems);
        const billTotal = afterDiscount + Math.round(bd.serviceCharge) + Math.round(bd.gst);
        // Derive floor for void slip (matches handleThermalBill).
        const tid = (r.tableId || "").toUpperCase();
        let voidFloor: TabletFloor = "first";
        if (tid.startsWith("C")) voidFloor = "ground";
        else if (tid.startsWith("T")) voidFloor = "rooftop";
        else if (tid.startsWith("FD") || tid.startsWith("SMK")) voidFloor = "first";
        return (
          <VoidBillModal
            tableId={r.tableId}
            customerName={r.customerName || ""}
            billTotal={billTotal}
            onCancel={() => setShowVoidBill(false)}
            onConfirm={async ({ pin, reason, notes }) => {
              // Verify Manager PIN inline (don't reuse requireManagerPin's
              // window.prompt — the modal already collected it via masked input).
              const h = await sha256(pin);
              if (h !== MANAGER_HASH) throw new Error("Wrong Manager PIN.");
              // 1. Persist void (status=voided + voidLog audit). Throws on failure.
              await voidBill(r._docId, {
                by: captainName,
                reason,
                notes,
                billTotal,
                subtotal,
                billPrintCount: r.billPrintCount || 0,
              }, r.bookingRef);
              // 2. Fire void slip to bill printer (best-effort; void persists either way).
              await printBillVoid({
                tableId: r.tableId,
                floorLabel: r.floorLabel,
                customerName: r.customerName,
                staff: captainName,
                billTotal,
                reason,
                notes,
                tabletFloor: voidFloor,
              });
              // V3 anti-fraud #A2 — increment night counter; auto-suspend if cap.
              let suspendNote = "";
              try {
                const stats = await recordCaptainVoidUsage(captainName, billTotal);
                if (stats.suspended) {
                  suspendNote = `\n\n🚫 You have NOW HIT TONIGHT'S VOID CAP (${stats.voidCount} voids · ₹${stats.voidValue}).\nFurther voids are LOCKED until Admin unlocks via Admin Panel → 🔓 Locks tab.`;
                }
              } catch (e) { console.warn("[void-cap] increment failed", e); }
              setShowVoidBill(false);
              alert(`✅ BILL VOIDED — ${r.tableId}\n\n₹${Math.round(billTotal)} logged as leakage.\nReason: ${reason}\n\nTable now shows 🚫 VOIDED. Tap "🔓 Release Table" when guests leave.${suspendNote}`);
            }}
          />
        );
      })()}
    </>
  );
}


function WhatsAppQrFallbackModal({ url, reason, customerName, tableId, onClose }: {
  url: string; reason: string; customerName: string; tableId: string; onClose: () => void;
}) {
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    import("qrcode").then((QR) => {
      QR.toDataURL(url, { width: 320, margin: 1, color: { dark: "#0a0a0a", light: "#ffffff" } })
        .then((u: string) => { if (!cancelled) setQrDataUrl(u); })
        .catch((e: any) => console.warn("[captain][qr-fallback] generate failed", e));
    });
    return () => { cancelled = true; };
  }, [url]);

  // 🔴 2026-05-18 (Khushi CRITICAL) — captain MUST have multiple ways to share
  // the wallet link if WhatsApp from POS fails: (a) guest scans QR on tablet,
  // (b) copy-link to paste in captain's own WhatsApp/SMS, (c) Web Share API
  // (on a phone tablet, opens native share sheet — WhatsApp, SMS, AirDrop).
  // Wallet itself is ALREADY unlocked at this point (cover doc was minted
  // before WhatsApp was tried), so any of these paths opens the live menu.
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { alert("Copy failed — long-press the URL below to copy manually."); }
  };
  const shareLink = async () => {
    if (typeof navigator !== "undefined" && (navigator as any).share) {
      try { await (navigator as any).share({ title: "HOD Wallet", text: `Hi ${customerName}, open your HOD wallet:`, url }); return; }
      catch (e) { /* user cancelled or unsupported — fall through to copy */ }
    }
    copyLink();
  };

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "#0d0d0d", border: "1px solid rgba(242,199,68,.35)", borderRadius: 16,
          maxWidth: 360, width: "100%", padding: 20, fontFamily: "'Space Grotesk', sans-serif", color: "#fff" }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#00C864", letterSpacing: .5, marginBottom: 4 }}>
          ✓ WALLET UNLOCKED · Menu opens on any device
        </div>
        <div style={{ fontSize: 16, fontWeight: 900, color: "#F2C744", marginBottom: 4, letterSpacing: .3 }}>
          📱 Share with {customerName}
        </div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,.55)", marginBottom: 14 }}>
          Table {tableId} · WhatsApp from POS didn't go through: {reason}
        </div>
        <div style={{ background: "#fff", borderRadius: 12, padding: 12, display: "flex", justifyContent: "center", marginBottom: 14 }}>
          {qrDataUrl
            ? <img src={qrDataUrl} alt="Wallet QR" style={{ width: "100%", maxWidth: 280, display: "block" }} />
            : <div style={{ width: 280, height: 280, display: "flex", alignItems: "center", justifyContent: "center", color: "#666", fontSize: 12 }}>Generating QR…</div>}
        </div>
        <div style={{ fontSize: 10, color: "rgba(255,255,255,.5)", textAlign: "center", marginBottom: 12, wordBreak: "break-all", padding: 8, background: "rgba(255,255,255,.04)", borderRadius: 8 }}>
          {url}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
          <button onClick={copyLink}
            style={{ padding: "11px 10px", borderRadius: 9, background: "rgba(255,255,255,.06)",
              border: "1px solid rgba(255,255,255,.18)", color: "#fff", fontSize: 11, fontWeight: 800,
              cursor: "pointer", letterSpacing: .4, fontFamily: "inherit", textTransform: "uppercase" }}>
            {copied ? "✓ COPIED" : "📋 COPY LINK"}
          </button>
          <button onClick={shareLink}
            style={{ padding: "11px 10px", borderRadius: 9, background: "rgba(37,211,102,.15)",
              border: "1px solid rgba(37,211,102,.45)", color: "#25D366", fontSize: 11, fontWeight: 800,
              cursor: "pointer", letterSpacing: .4, fontFamily: "inherit", textTransform: "uppercase" }}>
            📤 SHARE
          </button>
        </div>
        <button onClick={onClose}
          style={{ width: "100%", padding: "11px 14px", borderRadius: 9,
            background: "linear-gradient(135deg,#F2C744,#B8951F)", border: "none",
            color: "#0a0a0a", fontSize: 12, fontWeight: 900, cursor: "pointer",
            letterSpacing: .5, fontFamily: "inherit", textTransform: "uppercase" }}>
          ✓ Done
        </button>
      </div>
    </div>
  );
}

function BookingRow({ r, captainName, existingTables, allReservations, onClick }: {
  r: HodTableReservation; captainName: string; existingTables: string[]; allReservations: HodTableReservation[]; onClick: () => void;
}) {
  const [showReassign, setShowReassign] = useState(false);
  const [arriving, setArriving] = useState(false);
  const aggName = r.aggregator || r.source || "inhouse";
  const isAgg = aggName !== "inhouse";
  const aggLabel = AGGREGATOR_OPTIONS.find((a) => a.value === aggName)?.label || aggName;
  // 🔴 2026-05-13 — Khushi: show the aggregator's discount % next to the
  // brand name so captains see "ZOMATO DINING -15%" at a glance and know
  // upfront how much will come off the bill (was just "ZOMATO DINING").
  const aggDiscount = r.aggregatorDiscount ?? getAggregatorDiscount(aggName);
  const pending = (r.tabRounds || []).filter((rd) => rd.status === "preparing").length;
  const billReq = r.paymentStatus === "bill_requested";
  const paid = r.paymentStatus === "paid";
  const voided = (r as any).status === "voided";
  const arrived = !!r.actualArrivalTime;
  const canReassign = !paid && !voided;

  const borderColor = billReq ? "rgba(239,68,68,.55)"
    : pending > 0 ? "rgba(242,199,68,.45)"
    : voided ? "rgba(239,68,68,.4)"
    : "rgba(255,255,255,.08)";
  const bg = billReq ? "rgba(239,68,68,.06)"
    : pending > 0 ? "rgba(242,199,68,.04)"
    : "rgba(255,255,255,.03)";

  return (
    <>
    <div onClick={onClick}
      className={billReq ? "pulse-red" : pending > 0 ? "pulse-gold" : ""}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "10px 12px", marginBottom: 6, borderRadius: 10,
        background: bg, border: `1px solid ${borderColor}`,
        cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif",
        transition: "background .15s",
      }}>
      {/* Table id pill — also tap-to-reassign */}
      <button
        onClick={(e) => { e.stopPropagation(); if (canReassign) setShowReassign(true); }}
        disabled={!canReassign}
        title={canReassign ? "Tap to reassign table" : ""}
        style={{ flexShrink: 0, minWidth: 46, textAlign: "center",
          padding: "6px 6px", borderRadius: 6,
          background: "rgba(242,199,68,.1)", border: "1px solid rgba(242,199,68,.25)",
          color: "#F2C744", fontSize: 11, fontWeight: 900, letterSpacing: .3,
          cursor: canReassign ? "pointer" : "default",
          fontFamily: "inherit", lineHeight: 1.1 }}>
        {r.tableId}
        {canReassign && <div style={{ fontSize: 8, fontWeight: 600, opacity: .7, marginTop: 2 }}>🔄 swap</div>}
      </button>

      {/* Name + meta line */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#fff",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {r.customerName || "—"}
          </span>
          {isAgg && (
            <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 3,
              background: "#A02820", color: "#fff", letterSpacing: .4, textTransform: "uppercase" }}>
              {aggLabel}{aggDiscount > 0 ? ` -${aggDiscount}%` : ""}
            </span>
          )}
          {!isAgg && (
            <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
              background: "rgba(255,255,255,.06)", color: "rgba(255,255,255,.55)",
              letterSpacing: .4, textTransform: "uppercase" }}>
              In-House
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, fontSize: 10, color: "rgba(255,255,255,.5)", marginTop: 2 }}>
          <span>👥 {r.partySize || "?"}p</span>
          <span>🕐 {r.arrivalTime || "—"}</span>
          {r.phone && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📱 {r.phone}</span>}
        </div>
      </div>

      {/* Status badges (right side) */}
      <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
        {voided ? (
          <span style={{ fontSize: 9, fontWeight: 900, padding: "2px 6px", borderRadius: 4,
            background: "#A02820", color: "#fff", letterSpacing: .3 }}>🚫 VOIDED</span>
        ) : paid ? (
          <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
            background: "rgba(242,199,68,.15)", border: "1px solid rgba(242,199,68,.3)",
            color: "#F2C744", letterSpacing: .3 }}>✅ PAID</span>
        ) : billReq ? (
          <span style={{ fontSize: 9, fontWeight: 900, padding: "2px 6px", borderRadius: 4,
            background: "rgba(239,68,68,.18)", border: "1px solid rgba(239,68,68,.5)",
            color: "#EF4444", letterSpacing: .3 }}>🧾 BILL DUE</span>
        ) : pending > 0 ? (
          <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
            background: "rgba(242,199,68,.12)", border: "1px solid rgba(242,199,68,.3)",
            color: "#F2C744", letterSpacing: .3 }}>🔴 {pending} PENDING</span>
        ) : arrived ? (
          <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
            background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)",
            color: "rgba(255,255,255,.6)", letterSpacing: .3 }}>✓ ARRIVED</span>
        ) : (
          <button
            onClick={async (e) => {
              e.stopPropagation();
              if (arriving) return;
              if (!confirm(`Mark ${r.customerName || "this guest"} as arrived?`)) return;
              setArriving(true);
              try {
                await markGuestArrived(r._docId, r.bookingRef, captainName);
                // 🔴 2026-05-18 (Khushi CRITICAL) — inline arrival tap MUST also
                // mint the cover doc for non-inhouse sources (WA bot, aggregators)
                // or the customer wallet page stays locked. Idempotent — safe to
                // run on re-tap or for an already-arrived row. Mirrors Door Mode.
                if (r.bookingRef) {
                  const src = (r.aggregator || (r as any).source || "inhouse").toLowerCase();
                  if (src !== "inhouse") {
                    try {
                      await ensureCoverForAggregatorArrival({
                        bookingRef: r.bookingRef,
                        name: r.customerName || "",
                        phone: (r as any).phone || (r as any).customerPhone || "",
                        source: src,
                        partySize: r.partySize,
                        tableId: r.tableId,
                        staffName: captainName,
                      });
                    } catch (e) { console.warn("[captain][inline-arrive] cover mint failed", e); }
                  }
                }
              } catch {}
              setArriving(false);
            }}
            disabled={arriving}
            style={{ fontSize: 10, fontWeight: 900, padding: "5px 9px", borderRadius: 6,
              background: "linear-gradient(135deg,#F2C744,#B8951F)", border: "none",
              color: "#0A0A0A", letterSpacing: .4, cursor: arriving ? "default" : "pointer",
              fontFamily: "'Space Grotesk', sans-serif", textTransform: "uppercase",
              opacity: arriving ? .6 : 1, lineHeight: 1.1 }}
            title="Tap to mark this guest as arrived"
          >
            {arriving ? "..." : "🚶 Guest Arrived"}
          </button>
        )}
        <span style={{ fontSize: 9, color: "rgba(255,255,255,.3)" }}>tap →</span>
      </div>
    </div>
    {showReassign && (
      <ReassignTableModal
        reservation={r}
        existingTables={existingTables}
        allReservations={allReservations}
        captainName={captainName}
        onClose={() => setShowReassign(false)}
      />
    )}
    </>
  );
}

function BookingDetailModal({ r, captainName, playAlert, existingTables, allReservations, onClose }: {
  r: HodTableReservation; captainName: string; playAlert: (u: boolean) => void;
  existingTables: string[]; allReservations: HodTableReservation[]; onClose: () => void;
}) {
  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 9998,
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "20px 12px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 640, position: "relative" }}>
        <button onClick={onClose}
          style={{ position: "sticky", top: 0, marginLeft: "auto", display: "block",
            padding: "8px 14px", borderRadius: 8, background: "#0A0A0A",
            border: "1px solid rgba(242,199,68,.4)", color: "#F2C744",
            fontSize: 12, fontWeight: 800, cursor: "pointer", marginBottom: 8,
            fontFamily: "'Space Grotesk', sans-serif", letterSpacing: .5,
            zIndex: 1 }}>
          ✕ CLOSE
        </button>
        <TableCard r={r} captainName={captainName} playAlert={playAlert} existingTables={existingTables} allReservations={allReservations} />
      </div>
    </div>
  );
}

function CaptainDashboard({ captainName }: { captainName: string }) {
  const [date, setDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [floor, setFloor] = useState("");
  const [reservations, setReservations] = useState<HodTableReservation[]>([]);
  const [showWalkIn, setShowWalkIn] = useState(false);
  const [allTableIds, setAllTableIds] = useState<string[]>([]);
  const [allReservations, setAllReservations] = useState<HodTableReservation[]>([]);
  const [alertBadge, setAlertBadge] = useState({ text: "● LIVE", color: "#F2C744", bg: "rgba(242,199,68,.12)" });
  const [pendingFilter, setPendingFilter] = useState<"" | "pending" | "bill">("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const prevSnapshot = useRef<Record<string, { rounds: number; status: string }>>({});
  const playAlert = useAudioAlert();
  const pendingCountRef = useRef(0);
  const billCountRef = useRef(0);
  const beepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 2026-05-16 one-shot diagnostic — on mount, dump ALL tableReservations
  // grouped by `date` so we can see if customer-site bookings are landing
  // under a date string different from what POS is querying for.
  useEffect(() => {
    diagnoseTableReservationDates()
      .then((r) => console.log("[captain][diag] tableReservations BY DATE", r.totals, "RECENT 20:", r.recent, "POS QUERIES:", date))
      .catch((e) => console.warn("[captain][diag] failed", e));
  }, [date]);

  useEffect(() => {
    const unsub = subscribeToHodReservations(date, (all) => {
      setAllTableIds(all.map(r => r.tableId));
      setAllReservations(all);

      all.forEach((r) => {
        const prev = prevSnapshot.current[r._docId];
        const curr = { rounds: (r.tabRounds || []).length, status: r.paymentStatus || "" };
        if (prev) {
          if (curr.rounds > prev.rounds) {
            playAlert(false);
            setAlertBadge({ text: `🛎 NEW ORDER — ${r.tableId}`, color: "#F2C744", bg: "rgba(242,199,68,.2)" });
            setTimeout(() => setAlertBadge({ text: "● LIVE", color: "#F2C744", bg: "rgba(242,199,68,.12)" }), 5000);
          }
          if (curr.status === "bill_requested" && prev.status !== "bill_requested") {
            playAlert(true);
            setAlertBadge({ text: `🧾 BILL REQUESTED — ${r.tableId}`, color: "#EF4444", bg: "rgba(239,68,68,.3)" });
            setTimeout(() => setAlertBadge({ text: "● LIVE", color: "#F2C744", bg: "rgba(242,199,68,.12)" }), 5000);
          }
        }
        prevSnapshot.current[r._docId] = curr;
      });

      pendingCountRef.current = all.reduce((s, r) => s + (r.tabRounds || []).filter((rd) => rd.status === "preparing").length, 0);
      billCountRef.current = all.filter((r) => r.paymentStatus === "bill_requested").length;

      const filtered = floor ? all.filter((r) => r.floor === floor) : all;
      setReservations(filtered);
    });
    return () => { unsub(); prevSnapshot.current = {}; };
  }, [date, floor, playAlert]);

  useEffect(() => {
    if (beepIntervalRef.current) clearInterval(beepIntervalRef.current);
    beepIntervalRef.current = setInterval(() => {
      if (billCountRef.current > 0) playAlert(true);
      else if (pendingCountRef.current > 0) playAlert(false);
    }, 12000);
    return () => { if (beepIntervalRef.current) clearInterval(beepIntervalRef.current); };
  }, [playAlert]);

  const pending = reservations.reduce((s, r) => s + (r.tabRounds || []).filter((rd) => rd.status === "preparing").length, 0);
  const billDue = reservations.filter((r) => r.paymentStatus === "bill_requested").length;

  const displayedReservations = useMemo(() => {
    let list = reservations;
    if (pendingFilter === "pending") list = list.filter(r => (r.tabRounds || []).some(rd => rd.status === "preparing"));
    else if (pendingFilter === "bill") list = list.filter(r => r.paymentStatus === "bill_requested");
    // 2026-05-13 — Khushi spec: customer search across name/phone/table/ref.
    // Case-insensitive substring match on any of the four fields so a
    // captain can find a guest by typing 4 digits of their phone, the
    // table id ("D5"), or the booking ref ("TBL-HIBH9").
    const q = customerSearch.trim().toLowerCase();
    if (q) {
      list = list.filter(r => {
        const hay = [r.customerName, r.phone, r.tableId, r.bookingRef]
          .filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      });
    }
    return list;
  }, [reservations, pendingFilter, customerSearch]);

  return (
    <div style={{ minHeight: "100vh", background: "#0A0A0A", color: "#fff", fontFamily: "'Space Grotesk', sans-serif" }}>
      <WaiterCallBanner staffName={captainName} role="captain" />
      <div style={{ background: "rgba(10,10,10,.98)", borderBottom: "1px solid rgba(242,199,68,.25)", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 10, gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Link href="/"
            style={{ padding: "8px 12px", borderRadius: 10, background: "#F2C744", border: "1.5px solid #F2C744", color: "#0A0A0A", fontSize: 12, fontWeight: 900, cursor: "pointer", textDecoration: "none", whiteSpace: "nowrap", letterSpacing: .3 }}>
            ← POS
          </Link>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 900, color: "#F2C744", letterSpacing: 0.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🪩 CAPTAIN</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.4)" }}>👤 {captainName}</div>
          <div style={{ fontSize: 11, background: alertBadge.bg, border: `1px solid ${alertBadge.color}40`, color: alertBadge.color, padding: "4px 10px", borderRadius: 20 }}>{alertBadge.text}</div>
        </div>
      </div>

      <div style={{ padding: "10px 16px", display: "flex", gap: 8, background: "rgba(255,255,255,.02)", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          style={{ flex: 1, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, padding: "8px 12px", color: "#fff", fontSize: 12, outline: "none" }} />
        <select value={floor} onChange={(e) => setFloor(e.target.value)}
          style={{ flex: 1, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, padding: "8px 12px", color: "#fff", fontSize: 12, outline: "none" }}>
          <option value="">All Floors</option>
          <option value="dance">Dance Floor</option>
          <option value="dining">Dining</option>
          <option value="rooftop">Rooftop</option>
        </select>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, padding: "10px 16px" }}>
        {[
          { label: "Tables", value: reservations.length, color: "#F2C744", filter: "" as const },
          { label: "Pending", value: pending, color: pending > 0 ? "#EF4444" : "#F2C744", filter: "pending" as const },
          { label: "Bill Due", value: billDue, color: billDue > 0 ? "#F2C744" : "rgba(255,255,255,.4)", filter: "bill" as const },
        ].map((s) => (
          <div key={s.label} onClick={() => setPendingFilter(prev => prev === s.filter ? "" : s.filter)}
            style={{ background: pendingFilter === s.filter && s.filter ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.04)",
              border: `1px solid ${pendingFilter === s.filter && s.filter ? s.color + "60" : "rgba(255,255,255,.08)"}`,
              borderRadius: 10, padding: 10, textAlign: "center", cursor: "pointer", transition: "all .2s" }}>
            <div style={{ fontSize: 20, fontWeight: 900, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>
      {pendingFilter && (
        <div style={{ padding: "0 16px", marginBottom: 4 }}>
          <button onClick={() => setPendingFilter("")}
            style={{ fontSize: 11, color: "#F2C744", background: "rgba(242,199,68,.08)", border: "1px solid rgba(242,199,68,.2)", borderRadius: 8, padding: "4px 12px", cursor: "pointer" }}>
            Showing {pendingFilter === "pending" ? "Pending" : "Bill Due"} only — tap to clear ✕
          </button>
        </div>
      )}

      {/* 2026-05-13 — Khushi spec: customer search bar.
          Searches name, phone, table id, and booking ref together. */}
      <div style={{ padding: "10px 16px 0", position: "relative" }}>
        <input
          value={customerSearch}
          onChange={(e) => setCustomerSearch(e.target.value)}
          placeholder="🔎 Search customer name, phone, table, or ref"
          style={{ width: "100%", boxSizing: "border-box", padding: "10px 36px 10px 14px", borderRadius: 10, background: "rgba(255,255,255,.04)", border: "1px solid rgba(242,199,68,.18)", color: "#fff", fontSize: 13, outline: "none", fontFamily: "'Space Grotesk', sans-serif" }}
        />
        {customerSearch && (
          <button onClick={() => setCustomerSearch("")}
            aria-label="Clear search"
            style={{ position: "absolute", right: 22, top: 16, background: "transparent", border: "none", color: "rgba(255,255,255,.6)", fontSize: 16, cursor: "pointer", padding: 4 }}>
            ✕
          </button>
        )}
      </div>

      <div style={{ padding: "10px 16px 0" }}>
        <button onClick={() => setShowWalkIn(true)}
          style={{ width: "100%", padding: 12, borderRadius: 12, background: "linear-gradient(135deg,rgba(242,199,68,.15),rgba(242,199,68,.08))", border: "1px solid rgba(242,199,68,.3)", color: "#F2C744", fontSize: 13, fontWeight: 800, cursor: "pointer", letterSpacing: 0.5 }}>
          🚶 + Seat Walk-In Guest
        </button>
      </div>

      <div style={{ padding: "10px 16px 120px" }}>
        {displayedReservations.length === 0 ? (
          <div style={{ textAlign: "center", padding: 60, color: "rgba(255,255,255,.4)" }}>{customerSearch ? `No matches for "${customerSearch}".` : pendingFilter ? "No matching tables." : "No reservations today."}</div>
        ) : (
          displayedReservations.map((r) => (
            <BookingRow key={r._docId} r={r}
              captainName={captainName}
              existingTables={allTableIds}
              allReservations={allReservations}
              onClick={() => setSelectedDocId(r._docId)} />
          ))
        )}
      </div>

      {showWalkIn && (
        <WalkInModal captainName={captainName}
          existingTables={allTableIds}
          allReservations={allReservations}
          onClose={() => setShowWalkIn(false)} />
      )}

      {selectedDocId && (() => {
        const sel = reservations.find((x) => x._docId === selectedDocId);
        if (!sel) { setSelectedDocId(null); return null; }
        return (
          <BookingDetailModal
            r={sel}
            captainName={captainName}
            playAlert={playAlert}
            existingTables={allTableIds}
            allReservations={allReservations}
            onClose={() => setSelectedDocId(null)}
          />
        );
      })()}
    </div>
  );
}

export default function CaptainMode() {
  const [captainName, setCaptainName] = useState<string | null>(() => {
    const token = `hod_cap_${CAPTAIN_HASH.slice(0, 16)}_${new Date().toISOString().split("T")[0]}`;
    if (sessionStorage.getItem("hod_captain_auth") === token) return sessionStorage.getItem("hod_captain_name") || "Captain";
    return null;
  });

  const handleLogin = (name: string) => {
    const token = `hod_cap_${CAPTAIN_HASH.slice(0, 16)}_${new Date().toISOString().split("T")[0]}`;
    sessionStorage.setItem("hod_captain_auth", token);
    setCaptainName(name);
  };

  if (!captainName) return <CaptainLogin onLogin={handleLogin} />;
  return <CaptainDashboard captainName={captainName} />;
}
