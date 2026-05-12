import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Link } from "wouter";
import {
  sha256, subscribeToHodReservations, markGuestArrived, markRoundServed,
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
} from "@/lib/firestore-hod";
import { subscribeToMenuOverrides } from "@/lib/firestore";
// 🔴 2026-05-09 — switched from menu-data.ts (314 legacy items) to canonical
// HOD_MENU_ITEMS (373) so Captain's picker matches Admin/Bar/wallet exactly.
// Without this, OOS/discount overrides set by manager can silently miss items
// the captain sees (or vice versa). Same shape — drop-in compatible.
import { HOD_MENU_ITEMS as MENU_ITEMS } from "@/lib/hod-menu";
import type { MenuItem, MenuOverride } from "@/lib/types";
import { formatINR } from "@/lib/utils-pos";

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
                background: reason === r ? "rgba(201,168,76,.18)" : "rgba(255,255,255,.04)",
                border: `1px solid ${reason === r ? "rgba(201,168,76,.6)" : "rgba(255,255,255,.1)"}`,
                color: reason === r ? "#C9A84C" : "rgba(255,255,255,.65)" }}>
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
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 460, background: "#0a0a0c", border: "2px solid rgba(239,68,68,.5)", borderRadius: 14, padding: 20, color: "#fff" }}>
        <div style={{ fontSize: 17, fontWeight: 900, color: "#EF4444", marginBottom: 6 }}>🚫 VOID PRINTED BILL</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.6)", marginBottom: 10 }}>
          Use ONLY when the bill was printed but the customer cannot/will not pay. The bill stays on record for audit; the table is freed.
        </div>
        <div style={{ background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.25)", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.55)", marginBottom: 4 }}>TABLE / CUSTOMER</div>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#C9A84C", marginBottom: 8 }}>{tableId} · {customerName || "—"}</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.55)", marginBottom: 4 }}>BILL TOTAL TO BE VOIDED (LEAKAGE)</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#EF4444" }}>₹{Math.round(billTotal)}</div>
        </div>

        <label style={{ fontSize: 11, color: "rgba(255,255,255,.6)", marginBottom: 4, display: "block" }}>REASON</label>
        <select value={reason} onChange={(e) => setReason(e.target.value)}
          style={{ width: "100%", padding: "10px 12px", borderRadius: 10, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 13, marginBottom: 12, boxSizing: "border-box" }}>
          {BILL_VOID_REASONS.map((r) => <option key={r} value={r} style={{ background: "#0a0a0c" }}>{r}</option>)}
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
  inhouse:         { fg: "#C9A84C", bg: "rgba(201,168,76,.14)", border: "rgba(201,168,76,.55)" },
  zomato:          { fg: "#E23744", bg: "rgba(226,55,68,.14)",  border: "rgba(226,55,68,.55)"  },
  "swiggy-dineout":{ fg: "#FC8019", bg: "rgba(252,128,25,.14)", border: "rgba(252,128,25,.55)" },
  "swiggy-scenes": { fg: "#FC8019", bg: "rgba(252,128,25,.14)", border: "rgba(252,128,25,.55)" },
  eazydiner:       { fg: "#F5F5F5", bg: "rgba(245,245,245,.10)",border: "rgba(245,245,245,.45)" },
};

const TABLE_OPTIONS = [
  { floor: "dance", label: "Ground Floor", tables: ["C1","C2","C3","C4","CVIP1","CVIP2"] },
  { floor: "dining", label: "Dining", tables: ["FD1","FD2","FD3","FD4","FD5","FD6","FD7","FD8","FD9","FD10","FD11","FD12","FD13","FD14","FD15","FD16","FD17","FD18","SMK1","SMK2","SMK3","SMK4","SMK5","SMK6","SMK7","SMK8"] },
  { floor: "rooftop", label: "Rooftop", tables: ["T1","T2","T3","T4","T5","T6","T7","T8","T9","T10","T11","TVIP1","TVIP2","TVIP3","TVIP4","TVIP5","TVIP6","TVIP7","TEX1"] },
];

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
    <div style={{ minHeight: "100vh", background: "#030305", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 20, padding: "32px 28px", width: "100%", maxWidth: 360, textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🪩</div>
        <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 20, fontWeight: 900, color: "#C9A84C", marginBottom: 6 }}>Captain Login</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginBottom: 24 }}>HOD — House of Dopamine</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (e.g. Ravi)"
          style={{ width: "100%", padding: "14px 16px", borderRadius: 12, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 15, outline: "none", marginBottom: 10, boxSizing: "border-box" }} />
        <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder="Enter captain password"
          onKeyDown={(e) => e.key === "Enter" && tryLogin()}
          style={{ width: "100%", padding: "14px 16px", borderRadius: 12, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 15, outline: "none", marginBottom: 12, boxSizing: "border-box" }} />
        {error && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 10 }}>{error}</div>}
        <button onClick={tryLogin}
          style={{ width: "100%", padding: 14, borderRadius: 12, background: "linear-gradient(135deg,rgba(201,168,76,.9),rgba(160,120,48,.8))", border: "none", color: "#000", fontSize: 15, fontWeight: 900, cursor: "pointer" }}>
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
      <div style={{ background: "rgba(20,18,30,1)", border: "1px solid rgba(201,168,76,.3)", borderRadius: 20, padding: 24, width: "100%", maxWidth: 400 }}>
        <div style={{ fontSize: 16, fontWeight: 900, color: "#C9A84C", marginBottom: 16 }}>Edit Round {round.roundNum}</div>
        {items.map((it, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
            <div style={{ flex: 1, fontSize: 13, color: "#fff" }}>{it.n}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={() => updateQty(i, -1)} style={{ width: 28, height: 28, borderRadius: 6, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", cursor: "pointer" }}>−</button>
              <span style={{ fontSize: 14, fontWeight: 800, color: "#C9A84C", minWidth: 20, textAlign: "center" }}>{it.qty}</span>
              <button onClick={() => updateQty(i, 1)} style={{ width: 28, height: 28, borderRadius: 6, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", cursor: "pointer" }}>+</button>
              <span style={{ fontSize: 13, color: "#C9A84C", minWidth: 50, textAlign: "right" }}>₹{it.p * it.qty}</span>
              <button onClick={() => removeItem(i)} style={{ width: 28, height: 28, borderRadius: 6, background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.3)", color: "#EF4444", cursor: "pointer", fontSize: 14 }}>×</button>
            </div>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 0", fontWeight: 900, fontSize: 15 }}>
          <span style={{ color: "#fff" }}>Total</span>
          <span style={{ color: "#C9A84C" }}>₹{items.reduce((s, it) => s + it.p * it.qty, 0)}</span>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button onClick={onClose} style={{ flex: 1, padding: 12, borderRadius: 10, background: "transparent", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.5)", fontSize: 13, cursor: "pointer" }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ flex: 1, padding: 12, borderRadius: 10, background: "rgba(0,200,100,.15)", border: "1px solid rgba(0,200,100,.3)", color: "#00C864", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
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

function ReassignTableModal({ reservation, existingTables, captainName, onClose }: {
  reservation: HodTableReservation; existingTables: string[]; captainName: string; onClose: () => void;
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
      <div style={{ background: "rgba(20,18,30,1)", border: "1px solid rgba(201,168,76,.3)", borderRadius: 20, padding: 24, width: "100%", maxWidth: 400, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ fontSize: 18, fontWeight: 900, color: "#C9A84C", marginBottom: 4 }}>🔄 Reassign Table</div>
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
                  const occupied = existingTables.includes(t);
                  const isCurrent = t === reservation.tableId;
                  return (
                    <button key={t} onClick={() => !occupied && !isCurrent && setNewTable(t)} disabled={occupied || isCurrent}
                      style={{ padding: "6px 10px", borderRadius: 8, fontSize: 11, fontWeight: 700,
                        cursor: occupied || isCurrent ? "not-allowed" : "pointer",
                        background: newTable === t ? "rgba(0,200,100,.15)" : isCurrent ? "rgba(239,68,68,.15)" : occupied ? "rgba(239,68,68,.06)" : "rgba(255,255,255,.04)",
                        border: `1px solid ${newTable === t ? "rgba(0,200,100,.5)" : isCurrent ? "rgba(239,68,68,.4)" : occupied ? "rgba(239,68,68,.15)" : "rgba(255,255,255,.08)"}`,
                        color: newTable === t ? "#00C864" : isCurrent ? "#EF4444" : occupied ? "rgba(239,68,68,.3)" : "rgba(255,255,255,.5)",
                        opacity: occupied && !isCurrent ? 0.5 : 1 }}>
                      {t}{isCurrent ? " ●" : ""}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {newTable && (
          <div style={{ background: "rgba(0,200,100,.06)", border: "1px solid rgba(0,200,100,.2)", borderRadius: 10, padding: 10, marginBottom: 16, fontSize: 12, color: "#00C864" }}>
            {reservation.tableId} → {newTable} ({TABLE_OPTIONS.find(g => g.tables.includes(newTable))?.label})
          </div>
        )}

        {error && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 10 }}>{error}</div>}
        <button onClick={doReassign} disabled={saving || !newTable}
          style={{ width: "100%", padding: 14, borderRadius: 12, background: newTable ? "linear-gradient(135deg,rgba(0,200,100,.9),rgba(0,160,80,.8))" : "rgba(255,255,255,.06)", border: "none", color: newTable ? "#fff" : "rgba(255,255,255,.3)", fontSize: 15, fontWeight: 900, cursor: newTable ? "pointer" : "not-allowed", marginBottom: 10 }}>
          {saving ? "Reassigning..." : "Confirm Reassignment"}
        </button>
        <button onClick={onClose} style={{ width: "100%", padding: 12, borderRadius: 12, background: "transparent", border: "none", color: "rgba(255,255,255,.4)", fontSize: 13, cursor: "pointer" }}>Cancel</button>
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
  // 🔀 Split payment — captain can split final amount across cash/card/upi.
  // Only available for non-aggregator paths. Sum must equal finalAmount.
  const [splitMode, setSplitMode] = useState(false);
  const [splitCash, setSplitCash] = useState<number>(0);
  const [splitCard, setSplitCard] = useState<number>(0);
  const [splitUpi, setSplitUpi] = useState<number>(0);

  const discountPct = payMethod === "aggregator" ? aggDiscount : manualDiscount;
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

  const splitTotal = splitCash + splitCard + splitUpi;
  const splitDiff = finalAmount - splitTotal;

  const confirm = async () => {
    if (finalAmount <= 0) { setError("Invalid amount"); return; }
    if (splitMode) {
      if (splitTotal !== finalAmount) {
        setError(`Split total ₹${splitTotal} must equal final amount ₹${finalAmount} (off by ₹${splitDiff}).`);
        return;
      }
      const nonZero = [splitCash, splitCard, splitUpi].filter((n) => n > 0).length;
      if (nonZero < 2) { setError("Split needs at least 2 non-zero amounts. Use single payment instead."); return; }
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
      const splits = splitMode
        ? [
            { method: "cash", amount: splitCash },
            { method: "card", amount: splitCard },
            { method: "upi",  amount: splitUpi  },
          ].filter((s) => s.amount > 0)
        : undefined;
      const methodLabel = splitMode
        ? `split:${splits!.map((s) => s.method).join("+")}`
        : (payMethod === "aggregator" ? aggName : payMethod);
      await markTablePaid(reservation._docId, {
        amount: finalAmount,
        method: methodLabel,
        captainName,
        aggregator: payMethod === "aggregator" ? aggName : undefined,
        aggregatorDiscount: payMethod === "aggregator" ? aggDiscount : undefined,
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
      <div style={{ background: "rgba(20,18,30,1)", border: "1px solid rgba(201,168,76,.3)", borderRadius: 20, padding: 24, width: "100%", maxWidth: 380, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ fontSize: 18, fontWeight: 900, color: "#fff", marginBottom: 4 }}>Mark Table Paid</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginBottom: 20 }}>
          {reservation.tableId} · {reservation.customerName}
        </div>

        <div style={{ background: "rgba(201,168,76,.06)", border: "1px solid rgba(201,168,76,.15)", borderRadius: 12, padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
            <span style={{ color: "rgba(255,255,255,.5)" }}>Tab Total</span>
            <span style={{ fontWeight: 800, color: "#C9A84C" }}>{formatINR(tabTotal)}</span>
          </div>
          {discountPct > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
              <span style={{ color: "#A855F7" }}>Discount ({discountPct}%{payMethod === "aggregator" ? ` - ${aggName}` : ""})</span>
              <span style={{ fontWeight: 800, color: "#A855F7" }}>-{formatINR(discountAmt)}</span>
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
            <span style={{ fontWeight: 900, color: "#00C864" }}>{formatINR(finalAmount)}</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <button onClick={() => setServiceCharge(!serviceCharge)}
            style={{ width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer", position: "relative",
              background: serviceCharge ? "rgba(0,200,100,.5)" : "rgba(255,255,255,.15)", transition: "background .2s" }}>
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
                    background: (ch === "aggregator" ? payMethod === "aggregator" : payMethod !== "aggregator") ? "rgba(201,168,76,.15)" : "rgba(255,255,255,.04)",
                    borderColor: (ch === "aggregator" ? payMethod === "aggregator" : payMethod !== "aggregator") ? "rgba(201,168,76,.5)" : "rgba(255,255,255,.08)",
                    color: (ch === "aggregator" ? payMethod === "aggregator" : payMethod !== "aggregator") ? "#C9A84C" : "rgba(255,255,255,.4)" }}>
                  {ch === "aggregator" ? `Pay via ${aggName}` : "Pay In-House"}
                </button>
              ))}
            </div>
          </div>
        )}

        {payMethod !== "aggregator" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,.5)" }}>Payment Method</span>
              <button onClick={() => { setSplitMode(!splitMode); setError(""); if (!splitMode) { setSplitCash(finalAmount); setSplitCard(0); setSplitUpi(0); } }}
                style={{ padding: "4px 10px", borderRadius: 8, fontSize: 11, fontWeight: 800, cursor: "pointer",
                  background: splitMode ? "rgba(168,85,247,.2)" : "rgba(255,255,255,.04)",
                  border: `1px solid ${splitMode ? "rgba(168,85,247,.6)" : "rgba(255,255,255,.1)"}`,
                  color: splitMode ? "#A855F7" : "rgba(255,255,255,.5)" }}>
                {splitMode ? "✓ SPLIT MODE ON" : "🔀 SPLIT PAYMENT"}
              </button>
            </div>
            {!splitMode && (
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                {methods.map((m) => (
                  <button key={m.key} onClick={() => setPayMethod(m.key)}
                    style={{ flex: 1, padding: 10, borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer",
                      background: payMethod === m.key ? "rgba(201,168,76,.15)" : "rgba(255,255,255,.04)",
                      border: `1px solid ${payMethod === m.key ? "rgba(201,168,76,.5)" : "rgba(255,255,255,.08)"}`,
                      color: payMethod === m.key ? "#C9A84C" : "rgba(255,255,255,.4)" }}>
                    {m.label}
                  </button>
                ))}
              </div>
            )}
            {splitMode && (
              <div style={{ marginBottom: 16, padding: 12, borderRadius: 10, background: "rgba(168,85,247,.05)", border: "1px solid rgba(168,85,247,.2)" }}>
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
                <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, borderTop: "1px solid rgba(168,85,247,.2)", fontSize: 12 }}>
                  <span style={{ color: "rgba(255,255,255,.5)" }}>Split sum</span>
                  <span style={{ fontWeight: 800, color: splitDiff === 0 ? "#00C864" : "#EF4444" }}>
                    ₹{splitTotal} / ₹{finalAmount} {splitDiff !== 0 && `(${splitDiff > 0 ? "short" : "over"} ₹${Math.abs(splitDiff)})`}
                  </span>
                </div>
              </div>
            )}
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 8 }}>Discount %</div>
            <input type="number" value={manualDiscount || ""} onChange={(e) => setManualDiscount(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
              placeholder="e.g. 50 for 50% off" min={0} max={100}
              style={{ width: "100%", padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 14, outline: "none", marginBottom: 16, boxSizing: "border-box" }} />
          </>
        )}

        {error && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 10 }}>{error}</div>}

        <button onClick={confirm} disabled={saving}
          style={{ width: "100%", padding: 14, borderRadius: 12, background: "linear-gradient(135deg,rgba(0,200,100,.9),rgba(0,160,80,.8))", border: "none", color: "#fff", fontSize: 15, fontWeight: 900, cursor: "pointer", marginBottom: 10 }}>
          {saving ? "Saving..." : "✅ Confirm Payment"}
        </button>
        <button onClick={onClose} style={{ width: "100%", padding: 12, borderRadius: 12, background: "transparent", border: "none", color: "rgba(255,255,255,.4)", fontSize: 13, cursor: "pointer" }}>Cancel</button>
      </div>
    </div>
  );
}

function WalkInModal({ captainName, existingTables, onClose }: {
  captainName: string; existingTables: string[]; onClose: () => void;
}) {
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [partySize, setPartySize] = useState(2);
  const [selectedTable, setSelectedTable] = useState("");
  const [aggValue, setAggValue] = useState("inhouse");
  const [customDiscount, setCustomDiscount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [isProxy, setIsProxy] = useState(false);
  const [proxyFloor, setProxyFloor] = useState("dining");

  const discountPct = customDiscount;
  const nextProxyNum = existingTables.filter(t => t.startsWith("Proxy-")).length + 1;
  const proxyName = `Proxy-${nextProxyNum}`;

  const create = async () => {
    if (!customerName.trim()) { setError("Enter customer name"); return; }
    if (!isProxy && !selectedTable) { setError("Select a table"); return; }
    if (!isProxy && existingTables.includes(selectedTable)) { setError("Table already occupied!"); return; }
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
          customerName.trim(), phone.trim(), partySize, captainName,
          aggValue, discountPct
        );
      } else {
        const opt = TABLE_OPTIONS.find((g) => g.tables.includes(selectedTable));
        createdRef = await createWalkInTable(
          selectedTable, opt?.floor || "", opt?.label || "",
          customerName.trim(), phone.trim(), partySize, captainName,
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
      <div style={{ background: "rgba(20,18,30,1)", border: "1px solid rgba(201,168,76,.3)", borderRadius: 20, padding: 24, width: "100%", maxWidth: 400, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ fontSize: 18, fontWeight: 900, color: "#C9A84C", marginBottom: 4 }}>🚶 Seat Walk-In Guest</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginBottom: 16 }}>Create a new table for a walk-in customer</div>

        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          <button onClick={() => setIsProxy(false)}
            style={{ flex: 1, padding: "8px 12px", borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer",
              background: !isProxy ? "rgba(201,168,76,.15)" : "rgba(255,255,255,.04)",
              border: `1px solid ${!isProxy ? "rgba(201,168,76,.5)" : "rgba(255,255,255,.08)"}`,
              color: !isProxy ? "#C9A84C" : "rgba(255,255,255,.5)" }}>
            🪑 Regular Table
          </button>
          <button onClick={() => setIsProxy(true)}
            style={{ flex: 1, padding: "8px 12px", borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer",
              background: isProxy ? "rgba(168,85,247,.15)" : "rgba(255,255,255,.04)",
              border: `1px solid ${isProxy ? "rgba(168,85,247,.5)" : "rgba(255,255,255,.08)"}`,
              color: isProxy ? "#A855F7" : "rgba(255,255,255,.5)" }}>
            📦 Proxy / Extra
          </button>
        </div>

        <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 6 }}>Customer Name *</div>
        <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="e.g. Karan"
          style={{ width: "100%", padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 14, outline: "none", marginBottom: 12, boxSizing: "border-box" }} />

        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 6 }}>Phone</div>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional"
              style={{ width: "100%", padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 14, outline: "none", boxSizing: "border-box" }} />
          </div>
          <div style={{ width: 80 }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 6 }}>Guests</div>
            <input type="number" value={partySize} onChange={(e) => setPartySize(Number(e.target.value) || 2)} min={1} max={20}
              style={{ width: "100%", padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 14, outline: "none", boxSizing: "border-box" }} />
          </div>
        </div>

        {isProxy ? (
          <>
            <div style={{ background: "rgba(168,85,247,.08)", border: "1px solid rgba(168,85,247,.3)", borderRadius: 12, padding: 14, marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,.4)", marginBottom: 4 }}>Auto-assigned Name</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: "#A855F7" }}>{proxyName}</div>
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 6 }}>Floor *</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              {TABLE_OPTIONS.map(g => (
                <button key={g.floor} onClick={() => setProxyFloor(g.floor)}
                  style={{ flex: 1, padding: "8px 10px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer",
                    background: proxyFloor === g.floor ? "rgba(168,85,247,.15)" : "rgba(255,255,255,.04)",
                    border: `1px solid ${proxyFloor === g.floor ? "rgba(168,85,247,.5)" : "rgba(255,255,255,.08)"}`,
                    color: proxyFloor === g.floor ? "#A855F7" : "rgba(255,255,255,.5)" }}>
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
                      const occupied = existingTables.includes(t);
                      return (
                        <button key={t} onClick={() => !occupied && setSelectedTable(t)} disabled={occupied}
                          style={{ padding: "6px 10px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: occupied ? "not-allowed" : "pointer",
                            background: selectedTable === t ? "rgba(201,168,76,.2)" : occupied ? "rgba(239,68,68,.1)" : "rgba(255,255,255,.04)",
                            border: `1px solid ${selectedTable === t ? "rgba(201,168,76,.5)" : occupied ? "rgba(239,68,68,.2)" : "rgba(255,255,255,.08)"}`,
                            color: selectedTable === t ? "#C9A84C" : occupied ? "rgba(239,68,68,.4)" : "rgba(255,255,255,.5)",
                            opacity: occupied ? 0.5 : 1 }}>
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

        <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 6 }}>Source / Aggregator</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {AGGREGATOR_OPTIONS.map((agg) => (
            <button key={agg.value} onClick={() => { setAggValue(agg.value); setCustomDiscount(agg.discount); }}
              style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer",
                background: aggValue === agg.value ? "rgba(168,85,247,.15)" : "rgba(255,255,255,.04)",
                border: `1px solid ${aggValue === agg.value ? "rgba(168,85,247,.5)" : "rgba(255,255,255,.08)"}`,
                color: aggValue === agg.value ? "#A855F7" : "rgba(255,255,255,.5)" }}>
              {agg.label}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 6 }}>Discount % (editable)</div>
        <input type="number" value={customDiscount || ""} onChange={(e) => setCustomDiscount(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
          placeholder="e.g. 50" min={0} max={100}
          style={{ width: "100%", padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 14, outline: "none", marginBottom: 16, boxSizing: "border-box" }} />

        {error && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 10 }}>{error}</div>}

        <button onClick={create} disabled={saving}
          style={{ width: "100%", padding: 14, borderRadius: 12, background: "linear-gradient(135deg,rgba(201,168,76,.9),rgba(160,120,48,.8))", border: "none", color: "#000", fontSize: 15, fontWeight: 900, cursor: "pointer", marginBottom: 10 }}>
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
  const [cart, setCart] = useState<HodOrderItem[]>([]);
  const [saving, setSaving] = useState(false);

  // 🔴 2026-05-09 — Live OOS + discount overrides from Admin → Menu.
  // Keyed by slug(name) so it bridges menu-data.ts ↔ hod-menu.ts ↔ wallet.
  // Helper inline-redeclared (don't import to keep this section self-contained).
  const [menuOverrides, setMenuOverrides] = useState<Record<string, MenuOverride>>({});
  useEffect(() => subscribeToMenuOverrides(setMenuOverrides), []);
  const ovKey = (name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const effectivePrice = (m: { name: string; price: number }) => {
    const ov = menuOverrides[ovKey(m.name)];
    if (!ov) return m.price;
    if (ov.discountPercent) return Math.max(0, Math.round((m.price - m.price * ov.discountPercent / 100) * 100) / 100);
    if (ov.discountAmount) return Math.max(0, Math.round((m.price - ov.discountAmount) * 100) / 100);
    return m.price;
  };

  const categories = useMemo(() => [...new Set(MENU_ITEMS.map((m) => m.category))], []);

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
    // Drop items that admin marked OUT OF STOCK (live-synced via overrides).
    let items = MENU_ITEMS.filter((m) => m.available !== false && !menuOverrides[ovKey(m.name)]?.outOfStock);
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
  }, [search, category, menuOverrides]);

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
      <div style={{ padding: "14px 16px", borderBottom: "1px solid rgba(201,168,76,.2)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900, color: "#C9A84C" }}>Add Order — {tableId}</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.4)" }}>Captain: {captainName}</div>
        </div>
        <button onClick={onClose} style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 18, cursor: "pointer" }}>×</button>
      </div>

      <div style={{ padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search menu..."
          style={{ width: "100%", padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 8 }} />
        <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4 }}>
          <button onClick={() => setCategory("")}
            style={{ flexShrink: 0, padding: "5px 12px", borderRadius: 20, fontSize: 10, fontWeight: 700, cursor: "pointer",
              background: !category ? "rgba(201,168,76,.15)" : "rgba(255,255,255,.04)",
              border: `1px solid ${!category ? "rgba(201,168,76,.5)" : "rgba(255,255,255,.08)"}`,
              color: !category ? "#C9A84C" : "rgba(255,255,255,.5)" }}>All</button>
          {categories.map((c) => (
            <button key={c} onClick={() => setCategory(c)}
              style={{ flexShrink: 0, padding: "5px 12px", borderRadius: 20, fontSize: 10, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
                background: category === c ? "rgba(201,168,76,.15)" : "rgba(255,255,255,.04)",
                border: `1px solid ${category === c ? "rgba(201,168,76,.5)" : "rgba(255,255,255,.08)"}`,
                color: category === c ? "#C9A84C" : "rgba(255,255,255,.5)" }}>{c}</button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 16px" }}>
        {filtered.map((m) => {
          const ov = menuOverrides[ovKey(m.name)];
          const eff = effectivePrice({ name: m.name, price: m.price || 0 });
          const hasDisc = eff !== (m.price || 0);
          return (
            <div key={m.name} onClick={() => addToCart(m)}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,.04)", cursor: "pointer" }}>
              <div>
                <div style={{ fontSize: 13, color: "#fff", fontWeight: 600 }}>{m.isVeg ? "🟢" : "🔴"} {m.name}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,.3)" }}>
                  {m.category}{hasDisc && ov?.discountReason ? ` · 💰 ${ov.discountReason}` : ""}
                </div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#C9A84C", textAlign: "right" }}>
                {hasDisc ? (
                  <>
                    <span style={{ textDecoration: "line-through", color: "rgba(255,255,255,.35)", fontSize: 11, fontWeight: 600, marginRight: 6 }}>₹{m.price || 0}</span>
                    <span style={{ color: "#22c55e" }}>₹{eff}</span>
                  </>
                ) : (
                  <>₹{m.price || 0}</>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {cart.length > 0 && (
        <div style={{ borderTop: "2px solid rgba(201,168,76,.3)", background: "rgba(20,18,30,1)", padding: "12px 16px" }}>
          <div style={{ maxHeight: 150, overflowY: "auto", marginBottom: 8 }}>
            {cart.map((c, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0" }}>
                <span style={{ fontSize: 12, color: "#fff", flex: 1 }}>{c.n}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button onClick={(e) => { e.stopPropagation(); updateCartQty(i, -1); }} style={{ width: 24, height: 24, borderRadius: 6, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", cursor: "pointer", fontSize: 12 }}>−</button>
                  <span style={{ fontSize: 13, fontWeight: 800, color: "#C9A84C", minWidth: 16, textAlign: "center" }}>{c.qty}</span>
                  <button onClick={(e) => { e.stopPropagation(); updateCartQty(i, 1); }} style={{ width: 24, height: 24, borderRadius: 6, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", cursor: "pointer", fontSize: 12 }}>+</button>
                  <span style={{ fontSize: 12, color: "#C9A84C", minWidth: 50, textAlign: "right" }}>₹{c.p * c.qty}</span>
                </div>
              </div>
            ))}
          </div>
          <details style={{ borderTop: "1px solid rgba(255,255,255,.07)", paddingTop: 6, marginBottom: 10 }}>
            <summary style={{ display: "flex", justifyContent: "space-between", alignItems: "center", listStyle: "none", cursor: "pointer" }}>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,.55)", fontStyle: "italic" }}>
                Subtotal · SC + GST added at pay <span style={{ opacity: 0.6, fontSize: 9 }}>▾ view tax breakdown</span>
              </span>
              <span style={{ fontSize: 16, fontWeight: 900, color: "#C9A84C" }}>{fmt(cartTotal)}</span>
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
            style={{ width: "100%", padding: 14, borderRadius: 12, background: "linear-gradient(135deg,rgba(0,200,100,.9),rgba(0,160,80,.8))", border: "none", color: "#fff", fontSize: 15, fontWeight: 900, cursor: "pointer" }}>
            {saving ? "Adding..." : `📝 Add Round · ${formatINR(cartTotal)} (${cart.reduce((s, c) => s + c.qty, 0)} items)`}
          </button>
        </div>
      )}
    </div>
  );
}

function TableCard({ r, captainName, playAlert, existingTables }: {
  r: HodTableReservation; captainName: string; playAlert: (u: boolean) => void; existingTables: string[];
}) {
  const [editRound, setEditRound] = useState<{ round: HodTabRound; index: number } | null>(null);
  const [showPaid, setShowPaid] = useState(false);
  const [showAddOrder, setShowAddOrder] = useState(false);
  const [showReassign, setShowReassign] = useState(false);
  const [showVoidBill, setShowVoidBill] = useState(false);
  const [busy, setBusy] = useState("");
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

  const borderColor = billReq ? "rgba(239,68,68,.6)" : pending > 0 ? "rgba(255,200,0,.5)" : "rgba(255,255,255,.08)";

  const handleArrive = async () => {
    if (!confirm(`Mark ${r.customerName || "this guest"} as arrived?`)) return;
    setBusy("arrive");
    try { await markGuestArrived(r._docId, r.bookingRef); } catch {}
    setBusy("");
  };

  const handleServe = async (roundIdx: number) => {
    setBusy(`serve-${roundIdx}`);
    try {
      await markRoundServed(r._docId, roundIdx, r.bookingRef);
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
          await markRoundServed(r._docId, idx, r.bookingRef);
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
    try { await releaseTable(r._docId, r, captainName); } catch {}
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
    const tableLabel = r.tableId;
    const floorLabel = r.floorLabel || r.floor || "";
    const fallbackMessage = `🪩 *Your Table is Ready at HOD!*\n\nHi *${customerName}*!\n\n📍 *${tableLabel} · ${floorLabel}*\n🕐 Arrives *${r.arrivalTime || ""}*\n\n🍷 Browse our menu & pre-order:\n${url}\n\nYour captain will be with you shortly. Enjoy your evening! 🌟`;
    setBusy("wa");
    try {
      // 1) Try approved template first (works outside 24h customer service window)
      const tplRes = await fetch("/api/whatsapp/send-template", {
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
        alert(`✓ WhatsApp template sent to ${tplData.recipient}`);
        setBusy("");
        return;
      }
      console.warn("Template send failed, falling back to text:", tplData);

      // 2) Fall back to free-form text (works inside 24h customer service window)
      const fbRes = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: custPhone, message: fallbackMessage }),
      });
      const fbData = await fbRes.json();
      if (fbRes.ok && fbData.ok) {
        alert(`✓ WhatsApp text sent to ${fbData.recipient}\n(template not approved yet — used text fallback)`);
        setBusy("");
        return;
      }
      console.warn("Text fallback also failed:", fbData);

      // 3) Last resort: open wa.me on captain's device
      const tplCode = tplData.code;
      const isTemplateMissing = tplCode === 132001 || tplCode === 132000 || tplCode === 132012 || tplCode === 132015;
      const reason = isTemplateMissing
        ? `Template "table_ready" not yet approved by Meta, and customer is outside 24h reply window.`
        : `WhatsApp API failed: ${fbData.error || "Send failed"}${fbData.code ? ` (code ${fbData.code})` : ""}`;
      if (confirm(`${reason}\n\nOpen wa.me link to send manually?`)) {
        const p = custPhone.length === 10 ? `91${custPhone}` : custPhone;
        window.open(`https://wa.me/${p}?text=${encodeURIComponent(fallbackMessage)}`, "_blank");
      }
    } catch (err) {
      console.error("WhatsApp send error", err);
      alert("Network error sending WhatsApp. Check your connection.");
    }
    setBusy("");
  };

  return (
    <>
      <div style={{ background: "rgba(255,255,255,.04)", border: `2px solid ${borderColor}`, borderRadius: 16, marginBottom: 14, overflow: "hidden", ...(billReq ? { boxShadow: "0 0 20px rgba(239,68,68,.15)" } : {}) }}>
        <div style={{ padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", background: billReq ? "rgba(239,68,68,.08)" : pending > 0 ? "rgba(255,200,0,.05)" : "" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
              <span style={{ fontSize: 18, fontWeight: 900, color: "#C9A84C" }}>{r.tableId}</span>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,.4)" }}>{r.floorLabel || r.floor}</span>
              {r.actualArrivalTime ? (
                <span style={{ background: "rgba(0,200,100,.12)", border: "1px solid rgba(0,200,100,.3)", color: "#00C864", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 10 }}>✓ ARRIVED {r.actualArrivalTime}</span>
              ) : (
                <span style={{ background: "rgba(251,191,36,.12)", border: "1px solid rgba(251,191,36,.3)", color: "#FBBF24", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 10 }}>⏳ NOT ARRIVED</span>
              )}
              {voided && <span title={`Bill voided by ${(r as any).voidedBy || "?"} — ${(r as any).voidReason || ""}${(r as any).voidNotes ? ` (${(r as any).voidNotes})` : ""}`} style={{ background: "rgba(239,68,68,.18)", border: "1px solid rgba(239,68,68,.5)", color: "#EF4444", fontSize: 10, fontWeight: 900, padding: "3px 8px", borderRadius: 10, cursor: "help" }}>🚫 BILL VOIDED · ₹{Math.round((r as any).voidedBillTotal || 0)}</span>}
              {paid && <span title={orphanPay && r.paymentStatus !== "paid" ? `Auto-matched from an unclaimed Zomato payment of ₹${orphanPay.paidAmount}. Verify the amount before releasing the table.` : "Marked paid by the captain."} style={{ background: "rgba(0,200,100,.12)", border: "1px solid rgba(0,200,100,.3)", color: "#00C864", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 10, cursor: orphanPay && r.paymentStatus !== "paid" ? "help" : "default" }}>✅ PAID{(() => {
                const pm = (r as any).paymentMethod || (orphanPay ? orphanPay.paymentChannel : "");
                return pm && ["zomato","swiggy","eazydiner","payeazy"].includes(String(pm).toLowerCase()) ? ` · ${String(pm).toUpperCase()}` : "";
              })()}{orphanPay && r.paymentStatus !== "paid" ? " ⚠︎" : ""}</span>}
              {billReq && <span style={{ background: "rgba(239,68,68,.15)", border: "1px solid rgba(239,68,68,.4)", color: "#EF4444", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 10 }}>🧾 BILL DUE</span>}
              {pending > 0 && <span style={{ background: "rgba(255,200,0,.12)", border: "1px solid rgba(255,200,0,.3)", color: "#ffc800", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 10 }}>🔴 {pending} PENDING</span>}
            </div>
            <div style={{ fontSize: 12, color: "#fff", fontWeight: 700 }}>{r.customerName}</div>
            <div style={{ display: "flex", gap: 12, fontSize: 11, color: "rgba(255,255,255,.4)", marginTop: 3 }}>
              <span>👥 {r.partySize || "?"}p</span>
              <span>🕐 {r.arrivalTime}</span>
              <span>📱 {r.phone}</span>
            </div>
            {isAgg && (
              <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                <div style={{ fontSize: 11, fontWeight: 800, padding: "3px 8px", borderRadius: 8, display: "inline-block",
                  background: "rgba(168,85,247,.1)", border: "1px solid rgba(168,85,247,.3)", color: "#A855F7" }}>
                  {aggLabel} · {aggDiscount}% discount
                </div>
                {r.discountModifiedByCaptain && aggDiscount !== getAggregatorDiscount(aggName) && (
                  <div title={`Default for ${aggLabel} is ${getAggregatorDiscount(aggName)}% — a captain edited this tab to ${aggDiscount}%.`}
                    style={{ fontSize: 10, fontWeight: 900, padding: "3px 8px", borderRadius: 8,
                      background: "rgba(255,200,0,.12)", border: "1px solid rgba(255,200,0,.45)", color: "#ffc800", cursor: "help" }}>
                    ✎ MODIFIED ({getAggregatorDiscount(aggName)}% → {aggDiscount}%)
                  </div>
                )}
              </div>
            )}
            {!isAgg && aggDiscount > 0 && r.discountModifiedByCaptain && (
              <div style={{ marginTop: 6, fontSize: 10, fontWeight: 900, padding: "3px 8px", borderRadius: 8, display: "inline-block",
                background: "rgba(255,200,0,.12)", border: "1px solid rgba(255,200,0,.45)", color: "#ffc800" }}>
                ✎ MODIFIED (in-house · {aggDiscount}% discount)
              </div>
            )}
          </div>
          <div style={{ textAlign: "right" }}>
            {tabTotal > 0 && (
              <>
                <div style={{ fontSize: 18, fontWeight: 900, color: "#C9A84C" }}>₹{tabTotal}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)" }}>subtotal · +SC/GST at pay</div>
                {aggDiscount > 0 && (
                  <div style={{ fontSize: 10, color: "#A855F7", fontWeight: 700 }}>-{aggDiscount}% = ₹{Math.round(tabTotal * (1 - aggDiscount / 100))}</div>
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
                style={{ width: "100%", padding: 12, borderRadius: 10, background: "linear-gradient(135deg,rgba(0,200,100,.9),rgba(0,160,80,.8))", border: "none", color: "#fff", fontSize: 14, fontWeight: 900, cursor: "pointer" }}>
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
                <div key={idx} style={{ borderTop: "1px solid rgba(255,255,255,.06)", padding: "8px 0", ...(needsAction ? { background: isPending ? "rgba(255,200,0,.02)" : "rgba(0,200,100,.02)" } : { opacity: 0.6 }) }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: "#C9A84C" }}>Round {rd.roundNum}</span>
                    <span style={{ fontSize: 11, color: isPending ? "#ffc800" : isActivated ? "#38BDF8" : "#00C864" }}>
                      {isPending ? "🔴 Preparing" : isActivated ? "🔵 Activated — Ready to Serve" : "✅ Served"}
                    </span>
                  </div>
                  {(rd.items || []).map((it, ii) => (
                    <div key={ii} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
                      <span style={{ color: "#fff" }}>{it.qty}× {it.n}</span>
                      <span style={{ color: "#C9A84C" }}>₹{it.p * it.qty}</span>
                    </div>
                  ))}
                  {needsAction && (
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <button onClick={() => setEditRound({ round: rd, index: idx })}
                        style={{ flex: 1, padding: 8, borderRadius: 8, background: "rgba(255,200,0,.08)", border: "1px solid rgba(255,200,0,.3)", color: "#ffc800", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                        ✏️ Edit Order
                      </button>
                      <button onClick={() => handleServe(idx)} disabled={busy === `serve-${idx}`}
                        style={{ flex: 1, padding: 8, borderRadius: 8, background: "rgba(0,200,100,.1)", border: "1px solid rgba(0,200,100,.3)", color: "#00C864", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                        {busy === `serve-${idx}` ? "..." : "🖨 Print KOT"}
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
            background: "rgba(201,168,76,.08)", border: "1px solid rgba(201,168,76,.25)",
            color: "rgba(201,168,76,.85)", fontSize: 10, fontWeight: 700, letterSpacing: ".4px" }}>
            🔒 Bill #{r.billPrintCount} printed at {new Date(r.lastBillPrintedAt || "").toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"})} · source LOCKED to {r.billLockedSource || r.aggregator || "inhouse"} ({r.billLockedDiscount ?? r.aggregatorDiscount ?? 0}%)
          </div>
        )}
        {!paid && (
          <div style={{ padding: "6px 16px 10px" }}>
            <button onClick={() => setAggOpen(!aggOpen)}
              style={{ width: "100%", padding: 10, borderRadius: 10, background: isAgg ? `${AGG_BRAND[aggName]?.bg || "rgba(201,168,76,.08)"}` : "rgba(201,168,76,.06)",
                border: `1px solid ${isAgg ? (AGG_BRAND[aggName]?.border || "rgba(201,168,76,.3)") : "rgba(201,168,76,.25)"}`,
                color: isAgg ? (AGG_BRAND[aggName]?.fg || "#C9A84C") : "#C9A84C",
                fontSize: 12, fontWeight: 800, cursor: "pointer", marginBottom: 6, letterSpacing: ".3px",
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: AGG_BRAND[aggName]?.fg || "#C9A84C", boxShadow: `0 0 8px ${AGG_BRAND[aggName]?.fg || "#C9A84C"}` }} />
                {isAgg ? `${aggLabel}` : "Assign Source / Discount"}
              </span>
              <span style={{ fontSize: 11, fontWeight: 900, padding: "3px 9px", borderRadius: 6, background: "rgba(0,0,0,.35)", color: AGG_BRAND[aggName]?.fg || "#C9A84C" }}>
                {aggDiscount}% OFF
              </span>
            </button>
            {aggOpen && (
              <div style={{ background: "linear-gradient(180deg,rgba(0,0,0,.35),rgba(20,18,30,.6))", border: "1px solid rgba(201,168,76,.18)", borderRadius: 12, padding: 12, marginBottom: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "rgba(201,168,76,.7)", letterSpacing: "1.2px", textTransform: "uppercase", marginBottom: 8 }}>
                  Booking Source
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(110px,1fr))", gap: 6, marginBottom: 12 }}>
                  {AGGREGATOR_OPTIONS.map((agg) => {
                    const selected = aggName === agg.value;
                    const brand = AGG_BRAND[agg.value] || { fg: "#C9A84C", bg: "rgba(201,168,76,.10)", border: "rgba(201,168,76,.4)" };
                    return (
                      <button key={agg.value} onClick={() => handleAggChange(agg.value)}
                        style={{ padding: "9px 8px", borderRadius: 9, fontSize: 11, fontWeight: 800, cursor: "pointer",
                          background: selected ? brand.bg : "rgba(255,255,255,.03)",
                          border: `1.5px solid ${selected ? brand.border : "rgba(255,255,255,.08)"}`,
                          color: selected ? brand.fg : "rgba(255,255,255,.55)",
                          boxShadow: selected ? `0 0 0 1px ${brand.border} inset, 0 2px 8px ${brand.bg}` : "none",
                          transition: "all .15s", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                        <span>{agg.label.split(" (")[0]}</span>
                        <span style={{ fontSize: 9, fontWeight: 700, opacity: .75 }}>{agg.discount}% def.</span>
                      </button>
                    );
                  })}
                </div>
                <div style={{ borderTop: "1px solid rgba(201,168,76,.15)", paddingTop: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "rgba(201,168,76,.7)", letterSpacing: "1.2px", textTransform: "uppercase", marginBottom: 6 }}>
                    Custom Discount %
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input type="number" value={customDiscInput} onChange={(e) => setCustomDiscInput(e.target.value)}
                      placeholder={String(getAggregatorDiscount(aggName))} min={0} max={100}
                      style={{ flex: 1, padding: "9px 12px", borderRadius: 9, background: "rgba(0,0,0,.45)", border: "1px solid rgba(201,168,76,.3)", color: "#C9A84C", fontSize: 14, fontWeight: 800, outline: "none", textAlign: "center", letterSpacing: "1px" }} />
                    <button onClick={() => { const v = Math.min(100, Math.max(0, Number(customDiscInput) || 0)); handleAggChange(aggName, v); }}
                      style={{ padding: "9px 18px", borderRadius: 9, background: "linear-gradient(135deg,#C9A84C,#9C7E2E)", border: "none", color: "#0A0A0A", fontSize: 12, fontWeight: 900, cursor: "pointer", letterSpacing: ".5px", boxShadow: "0 2px 8px rgba(201,168,76,.3)" }}>
                      APPLY
                    </button>
                  </div>
                  {aggDiscount !== getAggregatorDiscount(aggName) && (
                    <div style={{ fontSize: 10, color: "#ffc800", marginTop: 6, fontWeight: 700 }}>
                      ✎ Custom — default for {aggLabel} is {getAggregatorDiscount(aggName)}%
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div style={{ padding: "6px 16px 14px", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {!r.actualArrivalTime && (
            <button onClick={handleArrive} disabled={busy === "arrive"}
              style={{ flex: 1, minWidth: 120, padding: "9px 12px", borderRadius: 9, background: "linear-gradient(135deg,#00C864,#00A050)", border: "none", color: "#fff", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
              {busy === "arrive" ? "..." : "🚶 Guest Arrived"}
            </button>
          )}
          {!paid && (
            <button onClick={() => setShowAddOrder(true)}
              style={{ flex: 1, minWidth: 120, padding: "9px 12px", borderRadius: 9, background: "rgba(201,168,76,.1)", border: "1px solid rgba(201,168,76,.3)", color: "#C9A84C", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              📝 Add Order
            </button>
          )}
          <button onClick={sendWhatsApp}
            style={{ flex: 1, minWidth: 120, padding: "9px 12px", borderRadius: 9, background: "rgba(37,211,102,.1)", border: "1px solid rgba(37,211,102,.3)", color: "#25D366", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
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
                  background: stale ? "rgba(239,68,68,.18)" : "rgba(201,168,76,.15)",
                  border: `1px solid ${stale ? "rgba(239,68,68,.6)" : "rgba(201,168,76,.45)"}`,
                  color: stale ? "#EF4444" : "#C9A84C",
                  fontSize: 11, fontWeight: 800,
                  cursor: busy === "printbill" ? "wait" : "pointer",
                  boxShadow: stale ? "0 0 12px rgba(239,68,68,.25)" : "none" }}
                data-testid="button-thermal-bill-captain">
                {label}
              </button>
            );
          })()}
          {!paid && !voided && (tabTotal > 0 || billReq) && (
            <button onClick={handleOpenMarkPaid}
              style={{ flex: 1, minWidth: 100, padding: "9px 12px", borderRadius: 9, background: "rgba(0,200,100,.1)", border: "1px solid rgba(0,200,100,.3)", color: "#00C864", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
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
              style={{ flex: 1, minWidth: 110, padding: "9px 12px", borderRadius: 9, background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.4)", color: "#EF4444", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
              🚫 Void Bill
            </button>
          )}
          {!paid && !voided && (
            <button onClick={() => setShowReassign(true)}
              style={{ flex: 1, minWidth: 100, padding: "9px 12px", borderRadius: 9, background: "rgba(56,189,248,.1)", border: "1px solid rgba(56,189,248,.3)", color: "#38BDF8", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              🔄 Reassign
            </button>
          )}
          <button onClick={handleRelease} disabled={busy === "release"}
            style={{ flex: 1, minWidth: 100, padding: "9px 12px", borderRadius: 9, background: "rgba(168,85,247,.1)", border: "1px solid rgba(168,85,247,.3)", color: "#A855F7", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
            {busy === "release" ? "..." : "🔓 Release Table"}
          </button>
        </div>
      </div>

      {editRound && <EditOrderModal round={editRound.round} roundIndex={editRound.index} docId={r._docId} captainName={captainName} bookingRef={r.bookingRef} tableId={r.tableId} floorLabel={r.floorLabel} customerName={r.customerName} onClose={() => setEditRound(null)} />}
      {showPaid && <MarkPaidModal reservation={r} captainName={captainName} onClose={() => setShowPaid(false)} />}
      {showAddOrder && <AddOrderModal docId={r._docId} tableId={r.tableId} captainName={captainName} onClose={() => setShowAddOrder(false)} />}
      {showReassign && <ReassignTableModal reservation={r} existingTables={existingTables} captainName={captainName} onClose={() => setShowReassign(false)} />}
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


function CaptainDashboard({ captainName }: { captainName: string }) {
  const [date, setDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [floor, setFloor] = useState("");
  const [reservations, setReservations] = useState<HodTableReservation[]>([]);
  const [showWalkIn, setShowWalkIn] = useState(false);
  const [allTableIds, setAllTableIds] = useState<string[]>([]);
  const [alertBadge, setAlertBadge] = useState({ text: "● LIVE", color: "#00C864", bg: "rgba(0,200,100,.12)" });
  const [pendingFilter, setPendingFilter] = useState<"" | "pending" | "bill">("");
  const prevSnapshot = useRef<Record<string, { rounds: number; status: string }>>({});
  const playAlert = useAudioAlert();
  const pendingCountRef = useRef(0);
  const billCountRef = useRef(0);
  const beepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const unsub = subscribeToHodReservations(date, (all) => {
      setAllTableIds(all.map(r => r.tableId));

      all.forEach((r) => {
        const prev = prevSnapshot.current[r._docId];
        const curr = { rounds: (r.tabRounds || []).length, status: r.paymentStatus || "" };
        if (prev) {
          if (curr.rounds > prev.rounds) {
            playAlert(false);
            setAlertBadge({ text: `🛎 NEW ORDER — ${r.tableId}`, color: "#ffc800", bg: "rgba(255,200,0,.2)" });
            setTimeout(() => setAlertBadge({ text: "● LIVE", color: "#00C864", bg: "rgba(0,200,100,.12)" }), 5000);
          }
          if (curr.status === "bill_requested" && prev.status !== "bill_requested") {
            playAlert(true);
            setAlertBadge({ text: `🧾 BILL REQUESTED — ${r.tableId}`, color: "#EF4444", bg: "rgba(239,68,68,.3)" });
            setTimeout(() => setAlertBadge({ text: "● LIVE", color: "#00C864", bg: "rgba(0,200,100,.12)" }), 5000);
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
    if (pendingFilter === "pending") return reservations.filter(r => (r.tabRounds || []).some(rd => rd.status === "preparing"));
    if (pendingFilter === "bill") return reservations.filter(r => r.paymentStatus === "bill_requested");
    return reservations;
  }, [reservations, pendingFilter]);

  return (
    <div style={{ minHeight: "100vh", background: "#030305", color: "#fff" }}>
      <div style={{ background: "rgba(12,8,22,.98)", borderBottom: "1px solid rgba(201,168,76,.2)", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 10, gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Link href="/"
            style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.7)", fontSize: 11, fontWeight: 700, cursor: "pointer", textDecoration: "none", whiteSpace: "nowrap" }}>
            ← POS
          </Link>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 15, fontWeight: 900, color: "#C9A84C", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🪩 Captain</div>
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
          { label: "Tables", value: reservations.length, color: "#C9A84C", filter: "" as const },
          { label: "Pending", value: pending, color: pending > 0 ? "#EF4444" : "#00C864", filter: "pending" as const },
          { label: "Bill Due", value: billDue, color: billDue > 0 ? "#ffc800" : "rgba(255,255,255,.4)", filter: "bill" as const },
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
            style={{ fontSize: 11, color: "#ffc800", background: "rgba(255,200,0,.08)", border: "1px solid rgba(255,200,0,.2)", borderRadius: 8, padding: "4px 12px", cursor: "pointer" }}>
            Showing {pendingFilter === "pending" ? "Pending" : "Bill Due"} only — tap to clear ✕
          </button>
        </div>
      )}

      <div style={{ padding: "10px 16px 0" }}>
        <button onClick={() => setShowWalkIn(true)}
          style={{ width: "100%", padding: 12, borderRadius: 12, background: "linear-gradient(135deg,rgba(201,168,76,.15),rgba(201,168,76,.08))", border: "1px solid rgba(201,168,76,.3)", color: "#C9A84C", fontSize: 13, fontWeight: 800, cursor: "pointer", letterSpacing: 0.5 }}>
          🚶 + Seat Walk-In Guest
        </button>
      </div>

      <div style={{ padding: "10px 16px 120px" }}>
        {displayedReservations.length === 0 ? (
          <div style={{ textAlign: "center", padding: 60, color: "rgba(255,255,255,.4)" }}>{pendingFilter ? "No matching tables." : "No reservations today."}</div>
        ) : (
          displayedReservations.map((r) => <TableCard key={r._docId} r={r} captainName={captainName} playAlert={playAlert} existingTables={allTableIds} />)
        )}
      </div>

      {showWalkIn && (
        <WalkInModal captainName={captainName}
          existingTables={allTableIds}
          onClose={() => setShowWalkIn(false)} />
      )}
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
