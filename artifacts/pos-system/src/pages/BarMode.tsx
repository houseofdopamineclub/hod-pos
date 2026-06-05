import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Link } from "wouter";
import { useStaff } from "@/lib/staff-context";
import { StaffLogin } from "@/components/StaffLogin";
import {
  sha256, searchCovers, searchBookingsAndGuestlist, subscribeToCover, rechargeCover, activateCoverOrder,
  logBarSession, printKOT, printBill, recordWalletBillPrint, voidWalletBill, printBillVoid, printKOTVoid,
  recordPendingPaymentScreenshot,
  getCoverByRef, computeHodBreakdown, updatePreparingRoundItems, createBarWalkinCover,
  coverDocIdFor,
  // 2026-05-21 — KDS (Kitchen Display) — write food items to chef screen on KOT fire,
  // listen for ready-bumps so bartender can run-the-pass when food is up.
  writeKDSItemsFromKOT, subscribeToReadyKDSItems, markKDSPickedUp, type HodKDSItem,
  type HodCover, type HodOrderItem, type TabletFloor, type HodGuestSearchHit, type HodTransaction, type HodTabRound,
  type HodTableReservation,
} from "@/lib/firestore-hod";
import { db } from "@/lib/firebase";
import { doc as fsDoc, getDoc as fsGetDoc, collection as fsCollection, query as fsQuery, where as fsWhere, limit as fsLimit, getDocs as fsGetDocs } from "firebase/firestore";
import { getOperationalNightStr } from "@/lib/utils-pos";
import { centeredPinPrompt, centeredAlert } from "@/lib/centered-ui";
import {
  getNextToken, createBillDue, appendBillDue, subscribeBillDue, clearBillDue, sendBillDueWhatsApp,
  type BillDueDoc, type BillDueItem, type NcRole, type NcPaymentMethod,
} from "@/lib/bill-due";
// 🔄 2026-05-25 (Khushi) — WaiterCallBanner removed from BarMode. Bartender
// should ONLY see food-ready KDS popups (already wired below), NOT
// floor-customer "Call Waiter" pings — those are for captains only.
// import { WaiterCallBanner } from "@/components/WaiterCallBanner";

// V3 2026-05-11 — Manager PIN hash (sha256('8888')). Same constant as CaptainMode.
// Kept inline (not imported) so BarMode stays self-contained — rotating this
// constant in CaptainMode would also need an update here. Acceptable cost for
// page-isolation; if ever rotated, search both files.
const BAR_MANAGER_HASH = "2926a2731f4b312c08982cacf8061eb14bf65c1a87cc5d70e864e079c6220731";

const BAR_BILL_VOID_REASONS: string[] = [
  "CUSTOMER REFUSED TO PAY",
  "DRINK POURED WRONG",
  "FOOD/DRINK QUALITY ISSUE",
  "SERVICE COMPLAINT",
  "DUPLICATE BILL — REPRINT ERROR",
  "WALKED OUT",
  "COMP — MGMT DISCRETION",
  "OTHER",
];

/** V3 2026-05-11 — VoidWalletBillModal: Bar-side counterpart of CaptainMode's
 *  VoidBillModal. Refunds ALL activated rounds back into the wallet balance.
 *  Manager PIN gated. Renders refund amount prominently so the manager
 *  understands exactly how much ₹ is going back to the customer's wallet. */
function VoidWalletBillModal({ tableId, customerName, refundAmount, walletBalance, onCancel, onConfirm }: {
  tableId: string;
  customerName: string;
  refundAmount: number;
  walletBalance: number;
  onCancel: () => void;
  onConfirm: (data: { pin: string; reason: string; notes: string }) => Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [reason, setReason] = useState(BAR_BILL_VOID_REASONS[0]);
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
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 460, background: "#fff", border: "2px solid #000", borderRadius: 14, padding: 20, color: "#000" }}>
        <div style={{ fontSize: 17, fontWeight: 900, color: "#FF5733", marginBottom: 6 }}>🚫 VOID WALLET BILL</div>
        <div style={{ fontSize: 12, color: "#6B6B6B", marginBottom: 10 }}>
          Cancels every activated round on this bill. Use ONLY when the bill must be undone (refused / wrong drink / quality / printer mistake). Audit trail captured.
        </div>
        <div style={{ background: "#FF5733", border: "2px solid #000", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 4 }}>WALLET / CUSTOMER</div>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#000", marginBottom: 8 }}>{tableId || "WALLET"} · {customerName || "—"}</div>
          <div style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 4 }}>BILL AMOUNT TO VOID</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#FF5733" }}>₹{Math.round(refundAmount).toLocaleString("en-IN")}</div>
        </div>
        <label style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 4, display: "block" }}>REASON</label>
        <select value={reason} onChange={(e) => setReason(e.target.value)}
          style={{ width: "100%", padding: "10px 12px", borderRadius: 10, background: "#F4F4F0", border: "2px solid #000", color: "#000", fontSize: 13, marginBottom: 12, boxSizing: "border-box" }}>
          {BAR_BILL_VOID_REASONS.map((r) => <option key={r} value={r} style={{ background: "#fff" }}>{r}</option>)}
        </select>
        <label style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 4, display: "block" }}>
          NOTES {reason === "OTHER" ? "(REQUIRED)" : "(OPTIONAL)"}
        </label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
          placeholder="What happened? (Stored in audit trail.)"
          style={{ width: "100%", padding: "10px 12px", borderRadius: 10, background: "#F4F4F0", border: "2px solid #000", color: "#000", fontSize: 13, marginBottom: 12, boxSizing: "border-box", resize: "vertical" }} />
        <label style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 4, display: "block" }}>MANAGER PIN (8888)</label>
        <input type="password" inputMode="numeric" pattern="[0-9]*" maxLength={4}
          value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          style={{ width: "100%", padding: "12px 14px", borderRadius: 10, background: "#F4F4F0", border: "2px solid #000", color: "#000", fontSize: 18, letterSpacing: 8, textAlign: "center", outline: "none", marginBottom: 12, boxSizing: "border-box" }} />
        {err && <div style={{ fontSize: 12, color: "#FF5733", marginBottom: 10, textAlign: "center" }}>{err}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onCancel} disabled={busy}
            style={{ flex: 1, padding: 12, borderRadius: 10, background: "transparent", border: "2px solid #000", color: "#6B6B6B", fontSize: 13, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer" }}>
            Cancel
          </button>
          <button onClick={submit} disabled={busy}
            style={{ flex: 1.4, padding: 12, borderRadius: 10, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 13, fontWeight: 900, cursor: busy ? "not-allowed" : "pointer" }}>
            {busy ? "Voiding..." : "🚫 CONFIRM VOID BILL"}
          </button>
        </div>
      </div>
    </div>
  );
}
import { subscribeToMenuOverrides } from "@/lib/firestore";
import { QrScanner } from "@/components/QrScanner";

// Min gap between two wallet-bill prints. Below this, bartender gets a confirm
// prompt — prevents double-print fraud / paper waste from accidental re-tap.
const WALLET_BILL_DEBOUNCE_MS = 15_000;
// HOD_MENU_ITEMS is auto-generated from admin.html HOD_FOOD_MENU + HOD_BAR_MENU so the
// bartender screen prices ALWAYS match what the customer was shown / charged. Do NOT import
// MENU_ITEMS here — that's the legacy enum and its prices drift from production.
import { HOD_MENU_ITEMS as MENU_ITEMS } from "@/lib/hod-menu";
import type { MenuItem, MenuOverride } from "@/lib/types";

/** Map a MenuItem to its HOD wallet tax class. Only the "food" group is taxable. */
const taxClassFor = (m: { group: string }): "food" | "drink" => (m.group === "food" ? "food" : "drink");

const BAR_PIN_HASH = "cd5b375fcca729d3d4cefb6567863052dc0492ab4cf4bad829fac633def8a96c";
const BAR_SALT = "HOD_BAR_2026";
const BAR_STAFF = ["Arjun", "Siddharth", "Priya", "Rahul", "Meghna"];

const GROUP_LABELS: Record<string, string> = {
  spirits: "🥃 Spirits",
  "beer-wine": "🍺 Beer & Wine",
  cocktails: "🍹 Cocktails",
  soft: "🥤 Soft Drinks",
  food: "🍽️ Food",
};
const GROUP_ORDER = ["spirits", "beer-wine", "cocktails", "soft", "food"];
// 🆕 Captain-match: ADD-ORDER category tabs are white-outlined boxes that
// prefill their brand tint ONLY when selected (mirrors CaptainMode's
// FOOD/LIQUOR/NAB/SMOKE tabs). Contrast rule: light/gold bg → #000 text,
// teal/blue/red bg → #fff text.
const BAR_GROUP_TINT: Record<string, { bg: string; fg: string }> = {
  spirits: { bg: "#F2C744", fg: "#000" },
  "beer-wine": { bg: "#60A5FA", fg: "#fff" },
  cocktails: { bg: "#FF90E8", fg: "#000" },
  soft: { bg: "#23A094", fg: "#fff" },
  food: { bg: "#FF5733", fg: "#fff" },
};

interface CartItem {
  n: string;
  p: number;
  qty: number;
  cat: string;
  menuId: string;
  isVeg?: boolean;
  t: "food" | "drink";
}

// 🆕 2026-05-25 (Khushi) — Bar login now uses unified per-staff `StaffLogin`
// (HOD ID + 4-digit PIN). Wrapper bridges `currentStaff.name` → existing
// `staffName` state in BarMain so the rest of BarMode stays untouched.
// `bartender` role is allowed; admin implicitly allowed via hasRole().
function BarLogin({ onLogin }: { onLogin: (staff: string) => void }) {
  const { currentStaff, isLoggedIn, hasRole, activeMode, needsModePicker } = useStaff();
  useEffect(() => {
    if (!isLoggedIn || !currentStaff || needsModePicker) return;
    if (!hasRole("bartender")) return;
    if (activeMode && activeMode !== "bartender") return;
    logBarSession(currentStaff.name).catch(() => {});
    sessionStorage.setItem("hod_bar_staff", currentStaff.name);
    onLogin(currentStaff.name);
  }, [isLoggedIn, currentStaff, hasRole, activeMode, needsModePicker, onLogin]);
  return <StaffLogin allowedRoles={["bartender"]} title="BAR LOGIN" emoji="🍸" />;
}

// v3.114 — In-app discount picker. Quick-chip grid (0/10/20/30/40/50%) + custom %
// input. Above 50% reveals Manager PIN field (validated via BAR_MANAGER_HASH).
// No browser popups. Fail-open: Cancel always closes without changing state.
function DiscountModal({ current, onApply, onClose }: {
  current: number; onApply: (pct: number) => void; onClose: () => void;
}) {
  const [pctStr, setPctStr] = useState(String(current));
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const pct = Math.max(0, Math.min(100, parseFloat(pctStr) || 0));
  const needsMgr = pct > 50;
  const handleApply = async () => {
    setErr("");
    if (pct < 0 || pct > 100) { setErr("ENTER A % BETWEEN 0 AND 100"); return; }
    if (!needsMgr) { onApply(pct); return; }
    if (pin.length !== 4) { setErr("ENTER 4-DIGIT MANAGER PIN (8888)"); return; }
    setBusy(true);
    const h = await sha256(pin);
    setBusy(false);
    if (h !== BAR_MANAGER_HASH) { setErr("WRONG MANAGER PIN"); setPin(""); return; }
    onApply(pct);
  };
  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(3,3,5,.85)", zIndex: 100000, display: "flex", justifyContent: "center", alignItems: "center", padding: 16, backdropFilter: "blur(3px)", fontFamily: "'Space Grotesk',sans-serif" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 420, background: "#fff", border: "2px solid #000", borderRadius: 18, padding: 22, position: "relative", boxShadow: "none", color: "#000" }}>
        <button onClick={onClose} title="Close"
          style={{ position: "absolute", top: 12, right: 14, width: 36, height: 36, borderRadius: 10, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 22, cursor: "pointer", lineHeight: 1, padding: 0, fontWeight: 900 }}>×</button>
        <div style={{ fontSize: 20, fontWeight: 900, color: "#000", marginBottom: 14, paddingRight: 42, letterSpacing: .5 }}>
          🏷️ APPLY DISCOUNT
        </div>
        <div style={{ fontSize: 12, color: "#6B6B6B", marginBottom: 14, fontWeight: 700, letterSpacing: .3 }}>
          UP TO 50% — BARTENDER · ABOVE 50% — MANAGER PIN
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 14 }}>
          {[0, 10, 20, 30, 40, 50].map((q) => {
            const sel = pct === q;
            return (
              <button key={q} onClick={() => { setPctStr(String(q)); setPin(""); setErr(""); }}
                style={{ padding: "14px 6px", borderRadius: 10, fontSize: 18, fontWeight: 900, cursor: "pointer",
                  background: sel ? "#FF90E8" : "#F4F4F0",
                  border: "2px solid #000",
                  color: sel ? "#000" : "#6B6B6B" }}>
                {q}%
              </button>
            );
          })}
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "#000", letterSpacing: 1.2, marginBottom: 6 }}>OR ENTER CUSTOM %</div>
          <div style={{ display: "flex", alignItems: "center", background: "#fff", border: "2px solid #000", borderRadius: 12, padding: "4px 14px" }}>
            <input type="number" value={pctStr} onChange={(e) => { setPctStr(e.target.value); setErr(""); if (parseFloat(e.target.value) <= 50) setPin(""); }} placeholder="0"
              style={{ flex: 1, background: "transparent", border: "none", padding: "12px 0", color: "#000", fontSize: 26, fontWeight: 900, outline: "none", minWidth: 0 }} />
            <span style={{ fontSize: 26, fontWeight: 900, color: "#000", marginLeft: 6 }}>%</span>
          </div>
        </div>
        {needsMgr && (
          <div style={{ marginBottom: 14, background: "#FF5733", border: "2px solid #000", borderRadius: 12, padding: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#FF5733", letterSpacing: 1.2, marginBottom: 6 }}>
              🔒 MANAGER PIN REQUIRED ({pct}% &gt; 50%)
            </div>
            <input type="text" inputMode="numeric" pattern="[0-9]*" maxLength={4}
              value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setErr(""); }}
              placeholder="• • • •"
              style={{ width: "100%", boxSizing: "border-box", padding: "14px 12px", borderRadius: 10, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 22, letterSpacing: 12, textAlign: "center", outline: "none", fontWeight: 900, ...({ WebkitTextSecurity: "disc", textSecurity: "disc" } as React.CSSProperties) }} />
          </div>
        )}
        {err && <div style={{ fontSize: 13, color: "#FF5733", marginBottom: 10, textAlign: "center", fontWeight: 800 }}>{err}</div>}
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onClose} disabled={busy}
            style={{ flex: 1, padding: "14px 10px", borderRadius: 12, background: "transparent", border: "2px solid #000", color: "#6B6B6B", fontSize: 14, fontWeight: 800, cursor: busy ? "not-allowed" : "pointer", letterSpacing: .5 }}>
            CANCEL
          </button>
          <button onClick={handleApply} disabled={busy}
            style={{ flex: 1.6, padding: "14px 10px", borderRadius: 12, background: busy ? "#FF90E8" : "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 15, fontWeight: 900, cursor: busy ? "not-allowed" : "pointer", letterSpacing: .5, boxShadow: "none"}}>
            {busy ? "..." : `✓ APPLY ${pct}%`}
          </button>
        </div>
      </div>
    </div>
  );
}

function WalletOverlay({ cover, staffName, onClose }: {
  cover: HodCover; staffName: string; onClose: () => void;
}) {
  const [cv, setCv] = useState<HodCover>(cover);
  const [cart, setCart] = useState<Record<string, CartItem>>({});
  // 🔴 2026-05-09 — Admin → Menu live OOS + discount sync. Keyed by slug(name).
  const [menuOverrides, setMenuOverrides] = useState<Record<string, MenuOverride>>({});
  useEffect(() => subscribeToMenuOverrides(setMenuOverrides), []);
  const ovKey = (name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const effectivePrice = (name: string, basePrice: number) => {
    const ov = menuOverrides[ovKey(name)];
    if (!ov) return basePrice;
    if (ov.discountPercent) return Math.max(0, Math.round((basePrice - basePrice * ov.discountPercent / 100) * 100) / 100);
    if (ov.discountAmount) return Math.max(0, Math.round((basePrice - ov.discountAmount) * 100) / 100);
    return basePrice;
  };
  const [activeGroup, setActiveGroup] = useState<string>("spirits");
  const [subCategory, setSubCategory] = useState<string>("");
  const [searchTerm, setSearchTerm] = useState("");
  const [rcAmt, setRcAmt] = useState("");
  const [rcMethod, setRcMethod] = useState<"cash" | "upi" | "card" | "split">("cash");
  const [rcSplit, setRcSplit] = useState<{ cash: string; upi: string; card: string }>({ cash: "", upi: "", card: "" });
  const [rcBusy, setRcBusy] = useState(false);
  const [actBusy, setActBusy] = useState(false);
  const [billBusy, setBillBusy] = useState(false);
  const [billDone, setBillDone] = useState<{ billNumber: string; total: number; itemCount: number; isDuplicate: boolean; withKot?: boolean } | null>(null);
  const [actDone, setActDone] = useState(false);
  const [actResult, setActResult] = useState<{ total: number; newBal: number; note: string } | null>(null);
  const [toast, setToast] = useState("");
  const [lastRcAmt, setLastRcAmt] = useState(0);
  const [lastRcTime, setLastRcTime] = useState(0);
  const [editBusy, setEditBusy] = useState(false);
  const [showVoidBill, setShowVoidBill] = useState(false);
  // V4 2026-05-11 — screenshot collection at 60-sec fail-open. Holds the
  // pending tx the bartender is being asked to back up with a phone screenshot.
  const [screenshotPrompt, setScreenshotPrompt] = useState<null | {
    paymentId: string; expectedAmount: number;
  }>(null);
  const [ssUpiRef, setSsUpiRef] = useState("");
  const [ssPhoneSeen, setSsPhoneSeen] = useState("");
  const [ssNote, setSsNote] = useState("");
  const [ssBusy, setSsBusy] = useState(false);
  // V3 2026-05-11 — track whether the bartender has manually edited the
  // recharge amount this session. If they have, we never auto-overwrite their
  // typed value (would feel buggy). If they haven't, the deficit auto-prefill
  // (below) is free to update as the cart changes.
  const [rcAmtTouched, setRcAmtTouched] = useState(false);
  // 2026-05-14 (Khushi UX) — collapse recharge panel by default so the items
  // list gets the full screen height. Auto-expands when balance is low or
  // bartender hits a deficit. Tap "💰 Recharge" header to toggle manually.
  const [rechargeOpen, setRechargeOpen] = useState(false);
  // 🔴 2026-05-25 (Khushi) — explicit success popup AFTER a recharge so the
  // bartender must click OK before moving on. Stops the "did the recharge
  // actually go through?" moment of doubt that toasts allowed. Once OK is
  // tapped, the recharge panel auto-closes and PRINT KOT + BILL is one tap
  // away.
  const [rechargeSuccess, setRechargeSuccess] = useState<{ amount: number; newBalance: number; method: string } | null>(null);
  // 🔴 2026-05-25 (Khushi) — collapsible "previous orders + transactions"
  // panel so the bartender can see exactly what the customer ordered + paid
  // earlier in the night. Mirrors the customer's wallet history view.
  const [historyOpen, setHistoryOpen] = useState(false);
  const rechargeRowRef = useRef<HTMLDivElement | null>(null);

  // 🆕 2026-05-26 (Khushi big-night batch) — BAR-SIDE DISCOUNT + SC TOGGLE.
  // Applied to the PRINTED bill chit only (cosmetic). Wallet debit math is
  // untouched (customer already paid up-front via wallet model). Bartender
  // can self-approve discounts ≤ 50%; anything above triggers Manager PIN.
  // SC defaults OFF; turning ON also requires Manager PIN (Khushi rule —
  // SC must be a deliberate decision, not a tap-by-accident).
  const [barDiscPct, setBarDiscPct] = useState(0);
  const [scOn, setScOn] = useState(true);
  // Per-session token for KOT↔Bill pairing. Fresh per print. Displayed in
  // the success overlay so bartender can call it out to the runner / cashier.
  const [lastToken, setLastToken] = useState<string | null>(null);
  const [reprintBusy, setReprintBusy] = useState(false);
  // 🆕 2026-05-26 v3.26 (Khushi) — Captain-style card flow. Menu picker
  // is hidden by default; bartender taps ADD ORDER in the bottom button
  // row to reveal it. Keeps the wallet a clean ticket-style read at a glance.
  const [showAddOrder, setShowAddOrder] = useState(false);
  // v3.114 — over-balance acknowledgement: shows a one-shot popup the moment
  // the cart total exceeds wallet balance. OK dismisses it AND suppresses
  // the inline disabled banner. Re-arms automatically the next time cart goes
  // back under balance (so a fresh overage shows the popup again).
  const [overAck, setOverAck] = useState(false);

  // v3.114 — in-app discount picker (replaces window.prompt). Bartender can
  // apply 0/10/20/30/40/50% in one tap or type a custom %; above 50% reveals
  // an in-app Manager PIN field (no browser popups anywhere).
  const [discOpen, setDiscOpen] = useState(false);
  const requestDiscount = useCallback(() => { setDiscOpen(true); }, []);

  // v3.114 (Khushi) — SC defaults ON. ON→OFF needs Manager PIN (revenue
  // protection). OFF→ON is free (re-enabling the default). Uses in-app
  // centeredPinPrompt + centeredAlert — NO browser popups.
  const requestScToggle = useCallback(async () => {
    if (!scOn) { setScOn(true); showToast("✅ Service Charge ON"); return; }
    const pin = await centeredPinPrompt("Turning Service Charge OFF needs Manager PIN.", true);
    if (!pin) return;
    const h = await sha256(pin);
    if (h !== BAR_MANAGER_HASH) { await centeredAlert("WRONG PIN", "Service Charge stays ON.", "error", true); return; }
    setScOn(false);
    showToast("⚠ Service Charge OFF (manager-approved)");
  }, [scOn]);

  /** Single source of truth for the printed-bill math. Honors barDiscPct +
   *  scOn toggles. Pure function — does NOT touch wallet balance. */
  const computePrintAmounts = useCallback((items: HodOrderItem[]) => {
    const sub = items.reduce((s, it) => s + (it.p || 0) * (it.qty || 0), 0);
    const disc = Math.round(sub * (Math.min(100, Math.max(0, barDiscPct)) / 100));
    const taxBase = Math.max(0, sub - disc);
    const sc = scOn ? Math.round(taxBase * 0.10) : 0;
    const taxAmt = Math.round((taxBase + sc) * 0.05);
    const cgst = Math.round((taxAmt / 2) * 100) / 100;
    const sgst = Math.round((taxAmt / 2) * 100) / 100;
    const total = taxBase + sc + taxAmt;
    return { subtotal: sub, discount: disc, serviceCharge: sc, cgst, sgst, taxAmt, total };
  }, [barDiscPct, scOn]);

  // 🆕 2026-06-02 v3.195 (Khushi) — RECHARGE honors the DISCOUNT dropdown.
  // She picked "discount lowers both" (pay ₹240 / credit ₹240 on a ₹300 + 20%).
  // So the net recharge = entered amount minus the discount %, rounded. Service
  // tax is NOT applied to a top-up (you don't tax adding money to a wallet).
  // rcAmtNum = the RAW typed amount; rcNet = what the bartender collects AND
  // what is credited to the wallet.
  const rcAmtNum = parseInt(rcAmt) || 0;
  const rcDiscAmt = Math.round(rcAmtNum * (Math.min(100, Math.max(0, barDiscPct)) / 100));
  const rcNet = Math.max(0, rcAmtNum - rcDiscAmt);

  useEffect(() => {
    const unsub = subscribeToCover(cover.id, (fresh) => { if (fresh) setCv(fresh); });
    return unsub;
  }, [cover.id]);

  // 🍳 2026-05-21 — KDS ready-flash for THIS cover. Chef bumps food → green
  // banner inside the wallet so bartender knows to run the pass. Filter from
  // the global ready stream by coverDocId. Fail-open: if listener errors, no
  // banner shows — bartender falls back to walking to the kitchen.
  const [readyKDSAll, setReadyKDSAll] = useState<HodKDSItem[]>([]);
  useEffect(() => {
    const unsub = subscribeToReadyKDSItems(setReadyKDSAll);
    return () => unsub();
  }, []);
  const readyKDSForThisCover = readyKDSAll.filter((it) => it.coverDocId === cover.id);

  const bal = cv.coverBalance || 0;
  const isExpired = cv.expiresAt ? new Date(cv.expiresAt).getTime() < Date.now() : false;

  // The customer wallet writes new orders into tabRounds[status='preparing'] (current flow).
  // Legacy aggregator flow used cv.pendingOrder. Surface BOTH so bartender always sees the order.
  // 🆕 2026-06-02 v3.196 (Khushi BUG — Aditya) — SKIP pure TABLE self-orders
  // (source 'customer_self_order'): those belong to the CAPTAIN, never the
  // bartender. Without this, a guest who chose "I'M AT MY TABLE" still had the
  // round prefill here as a bartender pre-order (showing in BOTH bar + captain).
  // Bar self-orders ('customer_self_order_bar'), recharge-at-bar
  // ('recharge_at_bar') and sourceless legacy rounds still surface as before.
  const _preparing = (cv.tabRounds || []).find(
    (r) => r && r.status === "preparing" && String((r as any).source || "").toLowerCase() !== "customer_self_order",
  );
  const preOrderItems: HodOrderItem[] = (_preparing?.items as HodOrderItem[] | undefined) || cv.pendingOrder?.items || [];
  // Tax-inclusive totals so customer-app cart total === bartender screen === wallet debit.
  const preOrderTotal = computeHodBreakdown(preOrderItems).grandTotal;

  const cartItemsForTax: HodOrderItem[] = Object.values(cart).map((c) => ({ n: c.n, p: c.p, qty: c.qty, cat: c.cat, t: c.t }));
  const cartBreakdown = computeHodBreakdown(cartItemsForTax);
  const cartTotal = cartBreakdown.grandTotal;
  // v3.114 — activeTotal now honors barDiscPct + scOn so the "RECHARGE
  // REQUIRED" amount Khushi sees matches EXACTLY what the bill will charge.
  // Mirrors computePrintAmounts() math (line 363) so deficit, recharge
  // suggestion, ADD ROUND button, and printed bill all agree to the rupee.
  const activeTotal = (() => {
    const allItems: HodOrderItem[] = [...preOrderItems, ...Object.values(cart).map((c) => ({ n: c.n, p: c.p, qty: c.qty, cat: c.cat, t: c.t }))];
    const sub = allItems.reduce((s, it) => s + (it.p || 0) * (it.qty || 0), 0);
    const disc = Math.round(sub * (Math.min(100, Math.max(0, barDiscPct)) / 100));
    const taxBase = Math.max(0, sub - disc);
    const sc = scOn ? Math.round(taxBase * 0.10) : 0;
    const taxAmt = Math.round((taxBase + sc) * 0.05);
    return taxBase + sc + taxAmt;
  })();
  const hasItems = preOrderItems.length > 0 || Object.keys(cart).length > 0;

  // v3.114 — auto-rearm the over-balance popup whenever cart drops back under
  // balance (so a fresh overage on the NEXT item add fires the popup again).
  useEffect(() => {
    if (activeTotal <= bal && overAck) setOverAck(false);
  }, [activeTotal, bal, overAck]);

  const cooldownKey = `hod_act_${cover.id}`;
  const recentAct = sessionStorage.getItem(cooldownKey);
  const blocked = !!(recentAct && Date.now() - new Date(recentAct).getTime() < 30000);

  const canActivate = !blocked && !isExpired && bal > 0 && (activeTotal === 0 || activeTotal <= bal) && hasItems;

  // ════════════════════════════════════════════════════════════════════
  // V4 2026-05-11 — RAZORPAY WEBHOOK TICK GATE (Khushi anti-fraud feature)
  // ────────────────────────────────────────────────────────────────────
  // When a customer pays online (Razorpay) the customer site calls our
  // `verifyRechargePayment` cloud function which signature-verifies the
  // payment and writes a transaction with `serverVerified:true`. Until
  // that flag lands on the cover doc, the recharge is UNPROVEN — could be
  // a customer-side spoof, a payment that bounced, or simply the verify
  // call hasn't completed yet.
  //
  // Rule: if the most recent online recharge transaction (last 5 min) is
  // NOT yet serverVerified, the bartender cannot ACTIVATE the KOT — they
  // see "AWAITING WEBHOOK ✅ TICK · Xs". After 60 sec the gate auto-fail-
  // opens (KOT activates with `pendingWebhookTick:true` flag → admin Live
  // Monitor surfaces it as a yellow tile + next-day leakage report flags
  // it). Cash / UPI / card recharges via the bartender's own panel are
  // ALWAYS verified instantly (they don't touch Razorpay) — no gate.
  // ════════════════════════════════════════════════════════════════════
  const PENDING_TICK_LOOKBACK_MS = 5 * 60 * 1000;  // only consider very recent
  const PENDING_TICK_FAIL_OPEN_MS = 60 * 1000;     // 60 sec then allow
  const _txs = (cv as unknown as { transactions?: HodTransaction[] }).transactions || [];
  // The "most recent online recharge in last 5 min that lacks server tick".
  // Walks newest→oldest. Stops early on (a) a NEWER cash/UPI/card recharge
  // (means the customer has moved on — don't keep blocking on stale online
  // attempt), or (b) anything older than the lookback window. We compare
  // against the cv doc's lastVerifiedTopUpAt as a clock-skew anchor —
  // if that's older than the candidate, we ignore the candidate (we're
  // probably looking at a stale local cv before the realtime sync caught up).
  const pendingOnlineTopUp = (() => {
    const cutoff = Date.now() - PENDING_TICK_LOOKBACK_MS;
    for (let i = _txs.length - 1; i >= 0; i--) {
      const t = _txs[i];
      if (!t || !t.timestamp) continue;
      const ts = new Date(t.timestamp).getTime();
      if (ts < cutoff) return null; // newest→oldest, nothing left in window
      // A newer cash/UPI/card recharge supersedes any older unverified online tx.
      // 🆕 2026-06-03 v3.217 (Khushi BUG) — rechargeCover writes `${method}_topup`
      // (cash_topup / upi_topup / card_topup / split_topup), NOT the bare
      // "topup"/"manual_topup" this check originally listed — so a bartender's
      // manual recharge NEVER cleared a stale "AWAIT TICK" gate and PRINT
      // KOT+BILL stayed hidden. Recognize every manual top-up type here.
      if (
        t.type === "topup" || t.type === "manual_topup" ||
        t.type === "cash_topup" || t.type === "upi_topup" ||
        t.type === "card_topup" || t.type === "split_topup"
      ) return null;
      if (t.type === "online_topup" || t.type === "diff_paid") {
        return t.serverVerified !== true ? t : null;
      }
    }
    return null;
  })();
  // Use Math.max(0, ...) so a future-dated tx (clock skew) doesn't read as a
  // negative age and look "fresh" forever — it'll register as 0ms and start
  // the 60-sec block from now, which is the safe default.
  const pendingTickAgeMs = pendingOnlineTopUp
    ? Math.max(0, Date.now() - new Date(pendingOnlineTopUp.timestamp).getTime()) : 0;
  const pendingTickStillBlocking = !!pendingOnlineTopUp && pendingTickAgeMs < PENDING_TICK_FAIL_OPEN_MS;
  const pendingTickFailOpen = !!pendingOnlineTopUp && pendingTickAgeMs >= PENDING_TICK_FAIL_OPEN_MS;

  // V4 2026-05-11 — most recent serverVerified online tx in the last 5 min.
  // Drives the GREEN ✅ "VERIFIED BY RAZORPAY" badge above PRINT KOT — gives
  // the bartender positive feedback that the money is real (vs. just
  // "balance went up" which could be a stale browser cache).
  const lastVerifiedOnlineTick = (() => {
    const cutoff = Date.now() - PENDING_TICK_LOOKBACK_MS;
    for (let i = _txs.length - 1; i >= 0; i--) {
      const t = _txs[i];
      if (!t || !t.timestamp) continue;
      const ts = new Date(t.timestamp).getTime();
      if (ts < cutoff) return null;
      if ((t.type === "online_topup" || t.type === "diff_paid") && t.serverVerified === true) return t;
    }
    return null;
  })();
  // Persistent PENDING badge — count of online txs on this cover that are
  // still unverified at ANY age (not just last 5 min). Survives across
  // sessions so end-of-night reconciliation works even if the bartender
  // closed and reopened the wallet.
  // V4 BUGFIX 2026-05-11 — only count txs that ALSO carry an `orderId` OR
  // an explicit `pendingWebhookTick:true` flag. Both fields are V4-only,
  // so legacy historical online txs (which never had `serverVerified`
  // either) won't be falsely flagged as PENDING forever. Once the rules
  // lock + webhook are live, every new online tx WILL carry orderId, so
  // the badge will work correctly going forward.
  const persistentPendingTicks = _txs.filter((t) => {
    if (t.type !== "online_topup" && t.type !== "diff_paid") return false;
    if (t.serverVerified === true) return false;
    return !!t.orderId || t.pendingWebhookTick === true;
  });
  const persistentPendingTotal = persistentPendingTicks.reduce((s, t) => s + (t.amount || 0), 0);
  // Force a re-render every second while a pending tick is in the window
  // so the countdown label updates and the gate auto-opens at 60 sec.
  const [, _setNow] = useState(0);
  useEffect(() => {
    if (!pendingOnlineTopUp) return;
    const id = setInterval(() => _setNow((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [pendingOnlineTopUp?.paymentId]);
  // 🆕 2026-06-03 v3.219 (Khushi BUG — "after round 3, PRINT KOT+BILL is delayed,
  // I have to click something and come back") — `blocked` (the 30s anti-double-
  // tap activation cooldown, L456) is computed from sessionStorage + Date.now()
  // at RENDER time and has NO reactive trigger. After activating a round the
  // button correctly shows "✅ PRINTED — RESCAN" for 30s, but once the window
  // lapses NOTHING re-renders, so it stays stuck on that label until the
  // bartender taps another control and forces a repaint (her exact symptom).
  // Mirror the pending-tick timer above: while blocked, schedule a one-shot
  // re-render at the EXACT cooldown expiry so PRINT KOT+BILL re-appears on its
  // own. (Re-runs whenever recentAct changes — i.e. the next activation resets
  // the cooldown and reschedules.)
  useEffect(() => {
    if (!blocked || !recentAct) return;
    const remaining = 30000 - (Date.now() - new Date(recentAct).getTime());
    const id = setTimeout(() => _setNow((n) => n + 1), Math.max(250, remaining + 50));
    return () => clearTimeout(id);
  }, [blocked, recentAct]);
  const tickGateBlocked = pendingTickStillBlocking;
  const canActivateFinal = canActivate && !tickGateBlocked;

  // V3 2026-05-11 — Khushi feature: auto-prefill the recharge amount with the
  // EXACT deficit when the customer's order exceeds wallet balance. Saves the
  // bartender from doing math under pressure ("how much more do they need?")
  // and standardises the recharge to the round-up nearest ₹50 so customer
  // doesn't end with awkward ₹3 leftover. Only auto-fills when bartender
  // hasn't typed in the field yet — never stomp on their input.
  const deficit = hasItems && activeTotal > bal ? Math.max(0, activeTotal - bal) : 0;
  // 2026-05-11 (Khushi) — pre-fill MUST equal the EXACT shortfall.
  // Customers refuse to pay even ₹10 extra. No round-up to ₹50.
  const suggestedRecharge = deficit > 0 ? Math.ceil(deficit) : 0;
  useEffect(() => {
    if (!rcAmtTouched && suggestedRecharge > 0 && (rcAmt === "" || rcAmt === "0")) {
      setRcAmt(String(suggestedRecharge));
    }
    // Clear the auto-fill once balance is sufficient so the field doesn't
    // confusingly stay populated after the deficit is gone.
    if (!rcAmtTouched && suggestedRecharge === 0 && rcAmt !== "") {
      setRcAmt("");
    }
    // 2026-05-15 (Khushi BUG FIX) — when deficit GROWS past what's currently
    // typed (cash-and-carry: bartender pre-typed ₹500, customer added more
    // items → deficit jumps to ₹884), bump the field up. This stops the
    // misleading "pre-filled ₹884" banner showing alongside a stale ₹87
    // in the input. Only bumps UP, never down — so bartender's deliberate
    // larger amount is never shrunk.
    const currentAmt = parseInt(rcAmt) || 0;
    if (suggestedRecharge > 0 && currentAmt < suggestedRecharge) {
      setRcAmt(String(suggestedRecharge));
      setRcAmtTouched(false);
    }
  }, [suggestedRecharge, rcAmtTouched]); // eslint-disable-line react-hooks/exhaustive-deps

  // 2026-05-15 (Khushi BUG FIX) — when the recharge modal OPENS, reset to a
  // clean state synced to the current deficit. Prevents leftover input from
  // a previous flow showing alongside a fresh deficit hint.
  useEffect(() => {
    if (rechargeOpen) {
      setRcAmtTouched(false);
      setRcAmt(suggestedRecharge > 0 ? String(suggestedRecharge) : "");
    }
  }, [rechargeOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(""), 3000); };

  const addToCart = (item: MenuItem | (Omit<MenuItem, "category"> & { category: string })) => {
    const key = item.id;
    // Lock in admin's discounted price at add-to-cart time.
    const usePrice = effectivePrice(item.name, item.price);
    setCart((prev) => {
      const existing = prev[key];
      if (existing) return { ...prev, [key]: { ...existing, qty: existing.qty + 1 } };
      return { ...prev, [key]: { n: item.name, p: usePrice, qty: 1, cat: item.category, menuId: item.id, isVeg: item.isVeg, t: taxClassFor(item) } };
    });
  };

  const updateCartQty = (key: string, delta: number) => {
    setCart((prev) => {
      const item = prev[key];
      if (!item) return prev;
      const newQty = item.qty + delta;
      if (newQty <= 0) { const next = { ...prev }; delete next[key]; return next; }
      return { ...prev, [key]: { ...item, qty: newQty } };
    });
  };

  // 2026-05-15 (Khushi UX) — quick cart-chip × delete (wipe wrong tap from anywhere)
  const removeFromCart = (key: string) => {
    setCart((prev) => { const next = { ...prev }; delete next[key]; return next; });
  };

  const doRecharge = async () => {
    const raw = parseInt(rcAmt) || 0;
    if (raw < 1) { showToast("Enter a recharge amount"); return; }
    // 🆕 v3.195 — collect AND credit the DISCOUNT-adjusted net (rcNet), not the
    // raw typed amount. ₹300 + 20% discount → ₹240 collected & credited.
    const amt = rcNet;
    if (amt < 1) { showToast("Discount brings the recharge to ₹0"); return; }
    if (amt > 10000) { showToast("Max recharge is ₹10,000"); return; }
    let splitArg: { cash?: number; upi?: number; card?: number } | undefined;
    if (rcMethod === "split") {
      const c = parseInt(rcSplit.cash) || 0;
      const u = parseInt(rcSplit.upi) || 0;
      const k = parseInt(rcSplit.card) || 0;
      if (c < 0 || u < 0 || k < 0) { showToast("Split parts cannot be negative"); return; }
      const sum = c + u + k;
      if (sum !== amt) { showToast(`Split must total ₹${amt} (currently ₹${sum})`); return; }
      const nonZero = [c, u, k].filter(v => v > 0).length;
      if (nonZero < 2) { showToast("Split needs at least 2 methods"); return; }
      splitArg = {};
      if (c) splitArg.cash = c;
      if (u) splitArg.upi = u;
      if (k) splitArg.card = k;
    }
    if (amt === lastRcAmt && Date.now() - lastRcTime < 60000) {
      if (!confirm(`You just recharged ₹${amt} less than a minute ago.\n\nRecharge ₹${amt} again?`)) return;
    }

    // 🔴 2026-05-25 (Khushi) — Razorpay tablet-checkout flow REMOVED for
    // all bar-side recharges. Pine Labs / online integration coming later;
    // until then ALL methods (Cash / UPI / Card / Split) are MANUAL — the
    // bartender collects the money physically and taps the matching button.
    // This is intentionally fail-open: trust the bartender, audit later.
    setRcBusy(true);
    try {
      // 🆕 2026-06-05 v3.222 — pass the known local balance so rechargeCover can
      // return the optimistic new balance WITHOUT a server read (it now writes via
      // atomic increment/arrayUnion → resolves from cache, no growing round-trip).
      const { newBalance: newBal, tx: rcTx } = await rechargeCover(cover.id, amt, rcMethod, staffName, splitArg, bal);
      // 🆕 2026-06-03 v3.217 (Khushi BUG) — COMPLETE optimistic update. Previously we
      // only patched coverBalance; the transactions array waited on the realtime
      // listener (which stalls on venue wifi). The "AWAIT TICK" gate reads
      // cv.transactions, so a fresh bartender recharge didn't supersede a stale
      // unverified online top-up until the listener caught up → PRINT KOT+BILL
      // wouldn't appear until the bartender tapped another button. Now we append
      // the exact tx Firestore wrote so the gate clears instantly.
      setCv((prev) => {
        const prevTxs = (prev as unknown as { transactions?: HodTransaction[] }).transactions || [];
        // Idempotent: if the realtime listener already delivered this exact tx
        // (same timestamp + type + amount), don't append a duplicate.
        const already = prevTxs.some(
          (t) => t && t.timestamp === rcTx.timestamp && t.type === rcTx.type && t.amount === rcTx.amount,
        );
        const nextTxs = already ? prevTxs : [...prevTxs, rcTx];
        // 🆕 2026-06-05 v3.222 — `newBal` is the OPTIMISTIC balance (our local
        // balance + amount). If the live listener already delivered a FRESHER
        // value (e.g. another tablet recharged this cover first), don't stomp it
        // with a stale-lower number — take the max. The next snapshot carries the
        // authoritative server total either way (increment keeps it correct).
        const prevBal = (prev as unknown as { coverBalance?: number }).coverBalance || 0;
        return { ...prev, coverBalance: Math.max(prevBal, newBal), transactions: nextTxs } as typeof prev;
      });
      setLastRcAmt(amt);
      setLastRcTime(Date.now());
      setRcAmt("");
      setRcAmtTouched(false); // allow deficit auto-prefill to work again next time
      setRcSplit({ cash: "", upi: "", card: "" });
      // 🔴 2026-05-25 (Khushi) — show an explicit OK-popup instead of a toast.
      // Bartender MUST click OK to continue. After OK, recharge panel auto-
      // closes and PRINT KOT + BILL is right there.
      // 🔴 2026-05-25 v2 (Khushi screenshot) — CLOSE the yellow recharge
      // popover BEFORE showing the green popup, otherwise the yellow panel
      // visibly stays behind/around the popup and confuses the bartender.
      setRechargeOpen(false);
      setRechargeSuccess({ amount: amt, newBalance: newBal, method: rcMethod });
    } catch (e: any) {
      // 🆕 2026-06-05 v3.221 — a stalled-network transaction now REJECTS with
      // NETWORK_SLOW (instead of hanging forever and freezing the screen). Tell
      // the bartender plainly + nudge them to RESCAN before re-charging, because
      // the first attempt may still land server-side (the 60s duplicate-confirm
      // guard above protects against an accidental double if they retry).
      const m = String(e?.message || e);
      if (m.includes("NETWORK_SLOW")) {
        showToast("⚠ NETWORK SLOW — recharge may still be processing. Wait ~10s & RESCAN the wallet before charging again.");
      } else {
        showToast(`Error: ${e.message}`);
      }
    }
    setRcBusy(false);
  };

  const handleThermalBill = async () => {
    if (billBusy) return;
    // B7 — block bill if a KOT is still "preparing" (customer pre-order not yet
    // activated by bartender). Otherwise the bill would undercharge the guest.
    const preparing = (cv.tabRounds || []).filter((r) => r && r.status === "preparing");
    if (preparing.length > 0) {
      showToast("⏳ A KOT is still preparing — activate it first, then print bill.");
      return;
    }
    // Aggregate all activated/served items from the wallet's tab rounds.
    const allItems: HodOrderItem[] = ((cv.tabRounds || [])
      .filter((rd) => rd && (rd.status === "activated" || rd.status === "served"))
      .flatMap((rd) => rd.items || []) as HodOrderItem[])
      .filter((it) => it && it.qty > 0);
    if (allItems.length === 0) { showToast("No activated items yet — print a KOT first."); return; }
    // B1/B6 — debounce/confirm rapid reprints (anti double-print).
    // 2026-05-15 (Khushi UX) — CASH & CARRY. If a new round was activated
    // AFTER the last bill print, this is a fresh round bill (not a duplicate).
    // Skip the duplicate-confirm dialog so bartender flow stays one-tap.
    const prevCount = cv.walletBillPrintCount || 0;
    const lastAt = cv.lastWalletBillPrintedAt ? new Date(cv.lastWalletBillPrintedAt).getTime() : 0;
    const billableForCheck = (cv.tabRounds || []).filter((r) => r && (r.status === "activated" || r.status === "served"));
    const latestActivatedAt = billableForCheck.reduce((max, r) => {
      const t = r.activatedAt ? new Date(r.activatedAt).getTime() : 0;
      return t > max ? t : max;
    }, 0);
    const hasNewRoundSinceLastBill = prevCount > 0 && lastAt > 0 && latestActivatedAt > lastAt;
    if (prevCount > 0 && Date.now() - lastAt < WALLET_BILL_DEBOUNCE_MS && !hasNewRoundSinceLastBill) {
      const ago = Math.ceil((Date.now() - lastAt) / 1000);
      if (!window.confirm(`⚠ A bill was just printed for this wallet ${ago}s ago.\n\nPrint AGAIN? (Guest will get a DUPLICATE chit.)`)) return;
    } else if (prevCount > 0 && !hasNewRoundSinceLastBill) {
      // True reprint of same items — guest already has paper. Confirm.
      if (!window.confirm(`This wallet already has ${prevCount} printed bill${prevCount > 1 ? "s" : ""} for the SAME items.\n\nPrint another DUPLICATE chit?`)) return;
    }
    // Floor: prefer cv.tableId prefix; fall back to bartender's saved tablet floor.
    const id = (cv.tableId || "").toUpperCase();
    let floor: TabletFloor | null = null;
    if (id.startsWith("C")) floor = "ground";
    else if (id.startsWith("T")) floor = "rooftop";
    else if (id.startsWith("FD") || id.startsWith("SMK")) floor = "first";
    // 🆕 2026-05-26 (Khushi batch) — honor bartender discount % + SC toggle.
    const amts = computePrintAmounts(allItems);
    const finalAmount = amts.total;
    const tokenForPrint = getNextToken();
    setLastToken(tokenForPrint);
    setBillBusy(true);
    try {
      // Atomic record (count++, log, isDuplicate flag, BILL-N suffix).
      const rec = await recordWalletBillPrint(cover.id, {
        by: staffName, total: finalAmount, itemCount: allItems.length,
        billNumberBase: (cv.ref || cv.id.slice(-6)).toUpperCase(),
      });
      const ok = await printBill({
        tableId: cv.tableId || cv.ref || "WALLET",
        floorLabel: cv.floorLabel || "Wallet",
        customerName: cv.name,
        staff: staffName,
        items: allItems.map((i) => ({ n: i.n, p: i.p, qty: i.qty })),
        amounts: { subtotal: amts.subtotal, serviceCharge: amts.serviceCharge, cgst: amts.cgst, sgst: amts.sgst, discount: amts.discount, roundOff: 0, total: finalAmount },
        billNumber: rec.billNumber,
        isDuplicate: rec.isDuplicate,
        tabletFloor: floor,
        token: tokenForPrint,
      });
      if (ok) {
        // B2/B9 — full-screen success overlay so bartender CANNOT miss it.
        setBillDone({ billNumber: rec.billNumber, total: finalAmount, itemCount: allItems.length, isDuplicate: rec.isDuplicate });
      } else {
        showToast("❌ Bill print failed — check Firestore.");
      }
    } catch (e: any) { showToast("❌ Bill print failed: " + e.message); }
    setBillBusy(false);
  };

  const doActivate = async (alsoBill: boolean = false) => {
    const allItems: HodOrderItem[] = [];
    // Carry tax class `t` end-to-end so wallet debit matches what the customer was shown.
    preOrderItems.forEach((it) => allItems.push({ n: it.n, p: it.p, qty: it.qty, cat: it.cat || "", t: it.t || "drink", v: it.v }));
    Object.values(cart).forEach((ci) => {
      const existing = allItems.find((a) => a.n === ci.n && a.p === ci.p && (a.t || "drink") === ci.t);
      if (existing) existing.qty += ci.qty;
      else allItems.push({ n: ci.n, p: ci.p, qty: ci.qty, cat: ci.cat || "", t: ci.t });
    });
    if (!allItems.length) { showToast("Select items first"); return; }
    if (isExpired) { showToast("Wallet has expired. Cannot activate."); return; }
    // v3.114 — SINGLE SOURCE OF TRUTH for activation total. Uses
    // computePrintAmounts so it honors barDiscPct + scOn, matching exactly
    // what the canActivate gate, ADD ROUND label, deficit/recharge prefill,
    // and the printed bill all use. Pre-v3.114 this used computeHodBreakdown
    // which ignored discount/SC → wallet would debit more than the bill.
    const total = computePrintAmounts(allItems).total;
    if (total > bal) { showToast("Insufficient balance. Recharge first."); return; }

    // V4 2026-05-11 — webhook tick gate. If a recent online recharge has not
    // yet been server-verified AND we're inside the 60-sec block window,
    // refuse to activate with a friendly countdown message. After 60 sec the
    // activation IS allowed but lands with `pendingWebhookTick:true` so the
    // admin sees it (handled inside activateCoverOrder via the staff arg
    // suffix below — keeps the activation path single-source-of-truth).
    if (pendingTickStillBlocking) {
      const sLeft = Math.ceil((PENDING_TICK_FAIL_OPEN_MS - pendingTickAgeMs) / 1000);
      showToast(`⏳ AWAITING ✅ WEBHOOK TICK — ${sLeft}s left (or accept and flag)`);
      return;
    }
    // V4 2026-05-11 — fail-open: open the SCREENSHOT modal BEFORE letting
    // the bartender activate. Forces them to visually confirm the customer's
    // UPI app shows success (with ref ID) so Khushi can reconcile next
    // morning. We do NOT proceed with activate() yet — the modal's submit
    // handler will set screenshotPrompt to null AND re-trigger doActivate.
    if (pendingTickFailOpen && !screenshotPrompt) {
      setScreenshotPrompt({
        paymentId: pendingOnlineTopUp?.paymentId || "",
        expectedAmount: pendingOnlineTopUp?.amount || 0,
      });
      setSsUpiRef("");
      setSsPhoneSeen((cv as any).phone || (cv as any).customerPhone || "");
      setSsNote("");
      return;
    }
    // Mark staff with PENDING-TICK suffix when we're fail-opening so the
    // tx audit row + downstream Reports/Live-Monitor can detect it without
    // a schema change to activateCoverOrder. Hoisted OUT of the try block
    // so the COOLDOWN retry path below can also reuse it (V4 audit fix).
    const staffArg = pendingTickFailOpen
      ? `${staffName} [PENDING-TICK pay_${(pendingOnlineTopUp?.paymentId || "").slice(-8)}${
          ssUpiRef ? ` SCREENSHOT upi_${ssUpiRef.replace(/\s+/g, "").slice(-12)}` : " NO-SCREENSHOT"
        }]`
      : staffName;
    setActBusy(true);
    try {
      const result = await activateCoverOrder(cover.id, allItems, total, staffArg);
      sessionStorage.setItem(cooldownKey, new Date().toISOString());
      setCart({});
      // V3 2026-05-11 BUGFIX — sync local cv state IMMEDIATELY after activate
      // so the wallet header shows the correct new balance + rounds without
      // waiting for subscribeToCover's next snapshot (which can be 1-2s late
      // and may serve stale cached data first → caused "₹0 balance / Guest
      // name" flash that Khushi reported). Mirrors what doRecharge does at
      // line ~373. Subscription will overwrite this with the canonical server
      // value when it arrives — no harm in pre-applying the same value here.
      setCv((prev) => ({
        ...prev,
        coverBalance: result.newBalance,
        coverUsed: (prev.coverUsed || 0) + total,
        tabRounds: result.updatedRounds,
        lastActivatedAt: new Date().toISOString(),
        lastActivatedBy: staffName,
        pendingOrder: null,
      }));
      setActResult({ total, newBal: result.newBalance, note: allItems.map((it) => `${it.qty}x ${it.n}`).join(", ") });

      // 🆕 2026-05-26 — pairing token. SAME token rides the matching Bill
      // chit below (alsoBill path) so cashier/runner can pair at a glance.
      const tokenForActivate = getNextToken();
      setLastToken(tokenForActivate);
      printKOT({
        tableId: cv.tableId || cv.ref || "", floorLabel: cv.floorLabel || "",
        customerName: cv.name || "", staff: staffName,
        bookingRef: cv.ref || "", reservationId: cover.id,
        customerPhone: (cv as any).phone || (cv as any).customerPhone || "",
        roundNum: (cv.transactions || []).filter((t) => t.type === "activate").length + 1,
        items: allItems, roundTotal: total,
        token: tokenForActivate,
      }).catch(() => {});

      // 🍳 KDS — mirror food items to kitchen screen for bar walk-in orders.
      // Best-effort; paper KOT already handled by printKOT above. Drinks
      // are silently filtered inside writeKDSItemsFromKOT.
      if ((allItems || []).some((it) => it.t === "food")) {
        writeKDSItemsFromKOT({
          coverDocId: cover.id,
          reservationId: "",
          tableId: cv.tableId || cv.ref || "BAR",
          tableLabel: cv.tableId ? cv.tableId : "BAR",
          floorLabel: cv.floorLabel || "BAR",
          customerName: cv.name || "",
          bookingRef: cv.ref || "",
          staff: staffName,
          roundNum: (cv.transactions || []).filter((t) => t.type === "activate").length + 1,
          items: allItems,
        } as any).catch((e) => console.warn("[KDS] bar write failed", e));
      }

      // 2026-05-14 — COMBINED "PRINT KOT + BILL" path. Used by ground-floor
      // cash-and-carry where bartender wants both prints in one tap. Bills
      // ALL activated rounds (the just-activated one + any prior ones) so
      // the customer chit reflects the running tab. Falls back to actDone
      // (KOT-only success screen) if billing fails — KOT is already printed
      // and wallet already debited so we never lose audit.
      if (alsoBill) {
        try {
          const updated = (result.updatedRounds || []).filter((r: any) => r && (r.status === "activated" || r.status === "served"));
          const billItems = updated.flatMap((r: any) => r.items || []);
          // 🆕 2026-05-26 — honor discount + SC toggle on the printed bill.
          const amtsB = computePrintAmounts(billItems as HodOrderItem[]);
          const finalB = amtsB.total;
          const idB = (cv.tableId || "").toUpperCase();
          let floorB: TabletFloor | null = null;
          if (idB.startsWith("C")) floorB = "ground";
          else if (idB.startsWith("T")) floorB = "rooftop";
          else if (idB.startsWith("FD") || idB.startsWith("SMK")) floorB = "first";
          // 2026-05-15 (Khushi UX) — CASH & CARRY. Combined PRINT KOT+BILL
          // ALWAYS includes the round we just activated → by definition a
          // fresh round bill, never a duplicate of the prior one.
          const recB = await recordWalletBillPrint(cover.id, {
            by: staffName, total: finalB, itemCount: billItems.length,
            billNumberBase: (cv.ref || cv.id.slice(-6)).toUpperCase(),
            hasNewRoundSinceLastBill: true,
          });
          const okB = await printBill({
            tableId: cv.tableId || cv.ref || "WALLET",
            floorLabel: cv.floorLabel || "Wallet",
            customerName: cv.name,
            staff: staffName,
            items: billItems.map((i: any) => ({ n: i.n, p: i.p, qty: i.qty })),
            amounts: { subtotal: amtsB.subtotal, serviceCharge: amtsB.serviceCharge, cgst: amtsB.cgst, sgst: amtsB.sgst, discount: amtsB.discount, roundOff: 0, total: finalB },
            billNumber: recB.billNumber,
            isDuplicate: recB.isDuplicate,
            tabletFloor: floorB,
            token: tokenForActivate,
          });
          if (okB) {
            setBillDone({ billNumber: recB.billNumber, total: finalB, itemCount: billItems.length, isDuplicate: recB.isDuplicate, withKot: true });
          } else {
            showToast("✅ KOT printed but ❌ bill print failed — try PRINT BILL");
            setActDone(true);
          }
        } catch (e: any) {
          showToast(`✅ KOT printed but bill failed: ${e?.message || e}`);
          setActDone(true);
        }
      } else {
        setActDone(true);
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.startsWith("COOLDOWN:")) {
        const [, secs, by] = msg.split(":");
        if (confirm(`This wallet was activated ${secs}s ago by ${by}.\n\nActivate again for ₹${total}?`)) {
          try {
            // V4 BUGFIX 2026-05-11 — preserve the PENDING-TICK / SCREENSHOT
            // suffix in this retry path too (was a real audit hole — cooldown
            // retries during fail-open used to drop the marker).
            const result = await activateCoverOrder(cover.id, allItems, total, staffArg);
            sessionStorage.setItem(cooldownKey, new Date().toISOString());
            setCart({});
            // Same local-state sync as the primary path above (fixes ₹0 / Guest flash).
            setCv((prev) => ({
              ...prev,
              coverBalance: result.newBalance,
              coverUsed: (prev.coverUsed || 0) + total,
              tabRounds: result.updatedRounds,
              lastActivatedAt: new Date().toISOString(),
              lastActivatedBy: staffName,
              pendingOrder: null,
            }));
            setActResult({ total, newBal: result.newBalance, note: allItems.map((it) => `${it.qty}x ${it.n}`).join(", ") });
            setActDone(true);
          } catch (e2: any) { showToast(e2?.message || String(e2)); }
        }
      } else if (msg.includes("NETWORK_SLOW")) {
        // 🆕 2026-06-05 v3.221 — stalled-network activate now rejects (vs freezing
        // the screen forever). The 30s in-transaction cooldown guard protects
        // against an accidental double-activate if the bartender retries.
        showToast("⚠ NETWORK SLOW — the KOT may still be processing. Wait ~10s & check the round before printing again.");
      } else {
        showToast(msg);
      }
    }
    setActBusy(false);
  };

  if (billDone) {
    const goldBg = billDone.isDuplicate ? "#FF5733" : "#23A094";
    const goldFg = billDone.isDuplicate ? "#FF5733" : "#23A094";
    return (
      <div style={{ position: "fixed", inset: 0, background: "#fff", zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 24, padding: "36px 28px", width: "100%", maxWidth: 380, textAlign: "center", boxShadow: "none"}}>
          <div style={{ fontSize: 56, marginBottom: 12 }}>{billDone.isDuplicate ? "⚠️" : (billDone.withKot ? "🖨✨" : "🖨")}</div>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 900, color: goldFg, marginBottom: 6 }}>
            {billDone.isDuplicate ? "DUPLICATE Bill Printed" : (billDone.withKot ? "KOT + BILL Printed!" : "Bill Printed!")}
          </div>
          <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 14 }}>{cv.name}</div>
          <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 10, padding: "10px 12px", marginBottom: 18, fontFamily: "monospace" }}>
            <div style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 4 }}>BILL #</div>
            <div style={{ fontSize: 18, fontWeight: 900, color: goldFg, letterSpacing: 1 }}>{billDone.billNumber}</div>
          </div>
          <div style={{ display: "flex", justifyContent: "center", gap: 24, marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 4 }}>Items</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#000" }}>{billDone.itemCount}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 4 }}>Total</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: goldFg }}>₹{billDone.total.toLocaleString("en-IN")}</div>
            </div>
          </div>
          {billDone.isDuplicate && (
            <div style={{ fontSize: 12, color: "#FF5733", marginBottom: 14, fontWeight: 700 }}>
              ⚠ Chit will print "DUPLICATE / REPRINT" header.<br/>Do NOT hand a 2nd copy to the guest.
            </div>
          )}
          {/* v3.114 — Khushi: success modal must NOT auto-close the wallet.
              Bartender taps "DONE" to dismiss this confirmation and returns
              to the wallet view (still has its own × close button up top). */}
          {/* 🆕 v3.189 (Khushi) — was color:goldFg on background:goldBg (same
              teal → INVISIBLE "✓ DONE" label). Now WHITE text on the solid
              green/red surface + black border (Gumroad, high-contrast). */}
          <button onClick={() => { setBillDone(null); setActDone(false); setCart({}); }}
            style={{ width: "100%", padding: 14, borderRadius: 12, background: goldBg, border: "2px solid #000", color: "#fff", fontSize: 15, fontWeight: 900, cursor: "pointer" }}>
            ✓ DONE
          </button>
        </div>
      </div>
    );
  }

  if (actDone && actResult) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "#fff", zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 24, padding: "36px 28px", width: "100%", maxWidth: 380, textAlign: "center", boxShadow: "none"}}>
          <div style={{ fontSize: 56, marginBottom: 16 }}>✅</div>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 24, fontWeight: 900, color: "#23A094", marginBottom: 8 }}>KOT Printed!</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#000", marginBottom: 4 }}>{cv.name}</div>
          <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 20, wordBreak: "break-word" }}>{actResult.note}</div>
          <div style={{ display: "flex", justifyContent: "center", gap: 24, marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 4 }}>Deducted</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#FF5733" }}>-₹{actResult.total.toLocaleString("en-IN")}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 4 }}>Remaining</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#23A094" }}>₹{actResult.newBal.toLocaleString("en-IN")}</div>
            </div>
          </div>
          {/* v3.114 — stay on wallet view after KOT print; bartender closes
              manually via the × on the wallet header. */}
          <button onClick={() => { setActDone(false); setActResult(null); setCart({}); }}
            style={{ width: "100%", padding: 14, borderRadius: 12, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 15, fontWeight: 900, cursor: "pointer", marginBottom: 10 }}>
            ✓ DONE
          </button>
        </div>
      </div>
    );
  }

  const menuGroups = GROUP_ORDER.filter((g) => MENU_ITEMS.some((m) => m.group === g));
  // Fuzzy, typo-tolerant search across name, category, and group label.
  const _norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const _lev = (a: string, b: string): number => {
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
  const _wordMatch = (word: string, hay: string) => {
    if (!word) return true;
    if (hay.indexOf(word) >= 0) return true;
    if (word.length < 4) return false;
    const tokens = hay.split(" ");
    for (const t of tokens) {
      if (!t) continue;
      if (t.indexOf(word) >= 0) return true;
      const allow = word.length >= 7 ? 2 : 1;
      if (_lev(word, t) <= allow) return true;
    }
    return false;
  };
  const filteredItems = MENU_ITEMS.filter((m) => {
    if (!m.available) return false;
    // Admin OOS — drop from picker (matches captain + customer wallet behavior).
    if (menuOverrides[ovKey(m.name)]?.outOfStock) return false;
    if (searchTerm) {
      const q = _norm(searchTerm);
      if (!q) return false;
      const groupLabel = (GROUP_LABELS[m.group] || m.group).toLowerCase();
      const hay = _norm(`${m.name} ${m.category} ${groupLabel}`);
      const words = q.split(" ").filter(Boolean);
      return words.every((w) => _wordMatch(w, hay));
    }
    return m.group === activeGroup;
  });
  const categories = [...new Set(filteredItems.map((m) => m.category))];

  return (
    <div style={{ position: "fixed", inset: 0, background: "#fff", zIndex: 9998, display: "flex", flexDirection: "column", color: "#000" }}>
      {toast && (
        <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", background: "#000", border: "2px solid #000", borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 700, color: "#fff", zIndex: 99999, maxWidth: 320 }}>{toast}</div>
      )}

      {/* 2026-05-15 (Khushi UX) — pulse keyframe for low/over balance recharge nudge */}
      <style>{`@keyframes hodPulseRed{0%,100%{box-shadow:0 0 0 0 rgba(255,87,51,.65);}50%{box-shadow:0 0 0 8px rgba(255,87,51,0);}}@keyframes hodPulseGold{0%,100%{box-shadow:0 0 0 0 rgba(255,144,232,.65);}50%{box-shadow:0 0 0 8px rgba(255,144,232,0);}}`}</style>

      {/* 🆕 2026-05-26 v3.28 (Khushi screenshot — captain parity, take 2) —
          Header now clones CaptainMode TableCard header (CaptainMode.tsx
          lines ~3038-3224) 1:1: top row = REF (big gold) + WALLET label
          + ✅ ACTIVE / 🚫 EXPIRED status pill; BIG guest name (22px); stats
          row 👥 pax · 🕐 arrivalTime · 📱 phone (matches captain's exact
          icons & sizing — only the bits that exist on cv are rendered, so
          walk-in covers with no pax/time gracefully drop those slots);
          SHARE WALLET QR blue button (when cv.bookingRef present — copies
          hodclub.in/wallet?ref=X to clipboard and shows toast since bar
          has no QR modal yet — Khushi can paste straight into WhatsApp);
          AGGREGATOR red badge (when cv.aggregator/cv.source matches
          swiggy/zomato/eazydiner — parses from cv.source string like
          'aggregator_arrival_swiggy'). Right column unchanged: × close
          + ₹balance gold + 'inclusive of all taxes'. */}
      {(() => {
        const anyCv2 = cv as any;
        const aggRaw = (anyCv2.aggregator || anyCv2.source || "").toLowerCase();
        const aggMatch = ["swiggy", "zomato", "eazydiner", "dineout"].find((k) => aggRaw.includes(k)) || "";
        const aggLabel = aggMatch === "dineout" || aggMatch === "swiggy" ? "SWIGGY DINEOUT" : aggMatch ? aggMatch.toUpperCase() : "";
        const hasBookingRef = !!(anyCv2.bookingRef || cv.tableId);
        const onShareWallet = () => {
          const url = `https://hodclub.in/wallet?ref=${encodeURIComponent(cv.ref || "")}`;
          const cb = (navigator as any)?.clipboard;
          if (cb && typeof cb.writeText === "function") {
            try {
              const p = cb.writeText(url);
              if (p && typeof p.then === "function") {
                p.then(() => setToast("📲 WALLET LINK COPIED · paste in WhatsApp"))
                 .catch(() => setToast(`📲 ${url}`));
              } else {
                setToast("📲 WALLET LINK COPIED · paste in WhatsApp");
              }
            } catch { setToast(`📲 ${url}`); }
          } else {
            setToast(`📲 ${url}`);
          }
        };
        return (
          <div style={{ background: "#fff", borderBottom: "2px solid #000", padding: "14px 16px 12px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexShrink: 0, gap: 10, fontFamily: "'Space Grotesk','Manrope',sans-serif" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                <span style={{ fontSize: 22, fontWeight: 900, color: "#000", letterSpacing: 0.4, fontVariantNumeric: "tabular-nums" }}>🪪 {cv.ref}</span>
                <span style={{ fontSize: 14, color: "#000", fontWeight: 700, letterSpacing: 0.3 }}>WALLET</span>
                {isExpired ? (
                  <span style={{ background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 12, fontWeight: 900, padding: "4px 10px", borderRadius: 10, letterSpacing: 0.5 }}>🚫 EXPIRED</span>
                ) : (
                  <span style={{ background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 12, fontWeight: 900, padding: "4px 10px", borderRadius: 10, letterSpacing: 0.5 }}>✓ ACTIVE</span>
                )}
                {cv.tier && <span style={{ fontSize: 11, fontWeight: 900, color: "#000", background: "#FF5733", padding: "3px 8px", borderRadius: 6, letterSpacing: 0.4, textTransform: "uppercase" }}>{cv.tier}</span>}
              </div>
              <div style={{ fontSize: 22, color: "#000", fontWeight: 900, letterSpacing: 0.2, lineHeight: 1.15, marginTop: 2, textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cv.name || "WALK-IN"}</div>
              {(() => {
                const anyCv = cv as any;
                const pax = anyCv.groupSize || anyCv.partySize || anyCv.pax;
                const arr = anyCv.actualArrivalTime || anyCv.arrivalTime || anyCv.bookingTime;
                if (!pax && !arr && !cv.phone) return null;
                return (
                  <div style={{ display: "flex", gap: 16, fontSize: 15, color: "#000", fontWeight: 800, marginTop: 6, flexWrap: "wrap", fontVariantNumeric: "tabular-nums" }}>
                    {pax && <span>👥 {pax}p</span>}
                    {arr && <span>🕐 {arr}</span>}
                    {cv.phone && <span>📱 {cv.phone}</span>}
                  </div>
                );
              })()}
              {hasBookingRef && (
                <button onClick={onShareWallet}
                  style={{ marginTop: 8, display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 6, cursor: "pointer", background: "#23A094", border: "2px solid #000", fontSize: 12, fontWeight: 900, color: "#fff", letterSpacing: 0.5, textTransform: "uppercase", fontFamily: "'Manrope','Space Grotesk',sans-serif" }}>
                  📲 SHARE WALLET QR
                </button>
              )}
              {aggLabel && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, padding: "4px 10px", borderRadius: 4, display: "inline-block", background: "#FF5733", border: "2px solid #000", color: "#fff", letterSpacing: 0.5, textTransform: "uppercase" }}>
                    {aggLabel}
                  </div>
                </div>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, flexShrink: 0 }}>
              <button onClick={onClose} aria-label="Close"
                style={{ width: 32, height: 32, borderRadius: 8, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 18, fontWeight: 900, cursor: "pointer", lineHeight: 1, padding: 0 }}>×</button>
              {/* 🆕 2026-05-26 v3.34 (Khushi: "SHOW AVAILABLE BALANCE IN BIG
                  FONT AND IN GREEN — CUSTOMER BALANCE — PLEASE MENTION
                  BALANCE 'SO AND SO AMOUNT' ON TOP") — customer balance now
                  bumped from 22px gold → 30px GREEN with explicit "BALANCE"
                  label above. Bartender + customer can both read it across
                  a dim bar without leaning in. Goes RED when bal ≤ 0 so the
                  recharge prompt is impossible to miss. */}
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 10, fontWeight: 900, color: "#6B6B6B", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 2 }}>BALANCE</div>
                <div style={{ fontSize: 30, fontWeight: 900, color: bal <= 0 ? "#FF5733" : "#23A094", lineHeight: 1.05, fontVariantNumeric: "tabular-nums", letterSpacing: 0.3, textShadow: "none"}}>₹{bal.toLocaleString("en-IN")}</div>
                <div style={{ fontSize: 10, color: "#6B6B6B", fontWeight: 600, marginTop: 3, letterSpacing: 0.3 }}>inclusive of all taxes</div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 🆕 2026-05-26 v3.26 (Khushi) — Captain-style ROUNDS list. Renders
          activated + served rounds at the top of the card so bartender sees
          AT A GLANCE what's been ordered without expanding the timeline.
          Each round shows ●  ROUND N + status pill (SERVED green / ACTIVATED gold)
          + items with prices in gold tabular-nums. Same exact visual as
          captain table card. Empty when no rounds yet. */}
      {(() => {
        const rounds = (cv.tabRounds || []).filter((r) => r && (r.status === "activated" || r.status === "served"));
        if (rounds.length === 0) return null;
        return (
          /* 🆕 2026-05-26 v3.37 (Khushi screenshot 9:59pm: "WHEN I CLICK ON
              INCLUSIVE OF TAX DROP DOWN I CANNOT SCROLL, NO BACK OPTION")
              — every WalletOverlay body section (rounds / cart / action box
              / footer) was flexShrink:0, so once 3+ rounds with the v3.35
              tax breakdown expanded pushed past viewport, NOTHING could
              shrink and NOTHING could scroll → action buttons + × close
              were stranded off-screen on her tablet. Fix: this rounds-list
              wrapper is now the flex grow + internal scroll container
              (`flex: 1 1 0, minHeight: 0, overflowY: auto`). It absorbs
              remaining vertical space and scrolls its OWN contents (long
              rounds list, expanded tax breakdown), while the header (top)
              and cart bar / action box (below, still flexShrink:0) stay
              pinned and always reachable. */
          <div style={{ padding: "2px 16px 8px", background: "#fff", borderBottom: "2px solid #000", fontFamily: "'Space Grotesk',sans-serif", flex: "1 1 0", minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
            {rounds.map((rd, idx) => {
              const isServed = rd.status === "served";
              // 🆕 2026-05-26 v3.35 (Khushi): round header must show the
              // tax-inclusive grand total next to status pill — "🟡 Ordered
              // ₹444" — while the per-item rows keep showing the BASE menu
              // price (e.g. ₹402 for Toit Tint Wit) so customer + bartender
              // can both see what each drink costs vs. the final bill total.
              const rdBreak = computeHodBreakdown(rd.items || []);
              const rdTotal = rdBreak.grandTotal;
              return (
                // 🆕 Captain-match: each ROUND in its own box — beige #FBF3D6
                // while not served, white once served — with items rendered as
                // a bordered Qty·Item·Amount table (identical to CaptainMode).
                <div key={idx} style={{ border: "2px solid #000", borderRadius: 12, background: isServed ? "#fff" : "#FBF3D6", padding: "10px 12px 8px", marginTop: 10, ...(isServed ? { opacity: 0.92 } : {}) }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontSize: 17, fontWeight: 900, color: "#000", letterSpacing: 0.6, textTransform: "uppercase", fontVariantNumeric: "tabular-nums" }}>● ROUND {rd.roundNum || idx + 1}</span>
                    <span style={{ fontSize: 13, fontWeight: 900, color: isServed ? "#23A094" : "#000", letterSpacing: 0.4, display: "inline-flex", alignItems: "center", gap: 6, fontVariantNumeric: "tabular-nums" }}>
                      <span>{isServed ? "✅ SERVED" : "🟡 ORDERED"}</span>
                      <span style={{ color: "#000" }}>₹{rdTotal.toLocaleString("en-IN")}</span>
                    </span>
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 4, background: "#fff" }}>
                    <thead>
                      <tr>
                        <th style={{ width: 44, textAlign: "center", fontSize: 11, fontWeight: 900, color: "#000", background: "#fff", padding: "5px 6px", border: "1px solid #000", textTransform: "uppercase", letterSpacing: .4 }}>Qty</th>
                        <th style={{ textAlign: "left", fontSize: 11, fontWeight: 900, color: "#000", background: "#fff", padding: "5px 8px", border: "1px solid #000", textTransform: "uppercase", letterSpacing: .4 }}>Item</th>
                        <th style={{ width: 78, textAlign: "right", fontSize: 11, fontWeight: 900, color: "#000", background: "#fff", padding: "5px 8px", border: "1px solid #000", textTransform: "uppercase", letterSpacing: .4 }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(rd.items || []).map((it: HodOrderItem, j: number) => (
                        <tr key={j}>
                          <td style={{ textAlign: "center", border: "1px solid #000", padding: "6px 6px", fontSize: 14, fontWeight: 800, color: "#000" }}>{it.qty}×</td>
                          <td style={{ border: "1px solid #000", padding: "6px 8px", fontSize: 14, fontWeight: 600, color: "#000" }}>{it.n}</td>
                          <td style={{ textAlign: "right", border: "1px solid #000", padding: "6px 8px", fontSize: 14, fontWeight: 800, color: "#000", fontVariantNumeric: "tabular-nums" }}>₹{computeHodBreakdown([it]).grandTotal}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
            {/* 🆕 2026-05-26 v3.35 (Khushi: "ADD TAX INFO BELOW A DROP DOWN
                OF INCLUSIVE OF ALL TAXES SO THAT TOTAL IS DISPLAYED") —
                collapsible tax breakdown across ALL rounds so bartender can
                show the customer Sub Total / SC / CGST / SGST / Round Off /
                Grand Total in one place. Same dashed-row style as the cart
                bar breakdown so it reads as part of the same family. */}
            {(() => {
              const allItems = rounds.flatMap(r => r.items || []);
              if (allItems.length === 0) return null;
              const b = computeHodBreakdown(allItems);
              const fmt = (n: number) => `₹${(Math.round(n * 100) / 100).toLocaleString("en-IN", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
              return (
                <details style={{ borderTop: "2px solid #000", paddingTop: 8, marginTop: 6 }}>
                  <summary style={{ display: "flex", justifyContent: "space-between", alignItems: "center", listStyle: "none", cursor: "pointer", padding: "2px 0" }}>
                    <span style={{ fontSize: 11, color: "#6B6B6B", fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", fontFamily: "'Space Grotesk',sans-serif" }}>
                      INCLUSIVE OF ALL TAXES <span style={{ opacity: 0.6, fontSize: 10 }}>▾ VIEW BREAKDOWN</span>
                    </span>
                    {/* v3.114 — Khushi: total amount must be BOLD WHITE and
                        bigger so bartender + customer can read the grand total
                        across the bar without leaning in. */}
                    <span style={{ fontSize: 26, fontWeight: 900, color: "#000", fontVariantNumeric: "tabular-nums", fontFamily: "'Space Grotesk',sans-serif", letterSpacing: 0.5 }}>
                      ₹{b.grandTotal.toLocaleString("en-IN")}
                    </span>
                  </summary>
                  <div style={{ fontSize: 12, lineHeight: 1.8, paddingTop: 6, marginTop: 6, borderTop: "2px solid #000", color: "#6B6B6B", fontFamily: "'Space Grotesk',sans-serif", fontVariantNumeric: "tabular-nums" }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}><span>SUB TOTAL</span><span>{fmt(b.subtotal)}</span></div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}><span>SERVICE CHARGE (10%)</span><span>{fmt(b.serviceCharge)}</span></div>
                    {b.cgst > 0 && (
                      <>
                        <div style={{ display: "flex", justifyContent: "space-between" }}><span>CGST (2.5%)</span><span>{fmt(b.cgst)}</span></div>
                        <div style={{ display: "flex", justifyContent: "space-between" }}><span>SGST (2.5%)</span><span>{fmt(b.sgst)}</span></div>
                      </>
                    )}
                    {Math.abs(b.roundOff) >= 0.01 && (
                      <div style={{ display: "flex", justifyContent: "space-between" }}><span>ROUND OFF</span><span>{b.roundOff >= 0 ? "+" : ""}{fmt(b.roundOff)}</span></div>
                    )}
                    <div style={{ display: "flex", justifyContent: "space-between", borderTop: "2px solid #000", marginTop: 6, paddingTop: 6, fontWeight: 900, color: "#000", fontSize: 13 }}>
                      <span>GRAND TOTAL</span><span>₹{b.grandTotal.toLocaleString("en-IN")}</span>
                    </div>
                  </div>
                </details>
              );
            })()}
          </div>
        );
      })()}

      {/* 🆕 2026-05-26 v3.32 (Khushi screenshot "MOVE ITEM UP AND WALLET
          ACTIONS BELOW — JUST SWAP") — PENDING ORDER cart bar relocated
          from the sticky bottom footer to here so it sits directly ABOVE
          the WALLET ACTIONS card. Bartender's eye now flows top→bottom:
          rounds list → pending order → wallet actions → recharge. The
          sticky footer at the bottom now holds only the recharge portal
          trigger. Same dashed-gold list-row styling as v3.30. */}
      {Object.keys(cart).length > 0 && (() => {
        const fmt = (n: number) => `₹${(Math.round(n * 100) / 100).toLocaleString("en-IN", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
        // 🆕 2026-06-03 v3.214 (Khushi): PENDING ORDER card was loud PINK → now
        // EXACT Captain-style beige #FBF3D6 round card with a white bordered
        // Qty/Item/Amount table (mirrors CaptainMode round table).
        return (
          <div style={{ padding: "0 12px 4px", background: "#fff", flexShrink: 0, fontFamily: "'Space Grotesk',sans-serif" }}>
            <div style={{ background: "#FBF3D6", border: "2px solid #000", borderRadius: 12, padding: 14, marginBottom: 0 }}>
              <div style={{ fontSize: 17, fontWeight: 900, color: "#000", letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 8 }}>
                ● PENDING ORDER
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 4, background: "#fff" }}>
                <thead>
                  <tr>
                    <th style={{ width: 44, textAlign: "center", fontSize: 11, fontWeight: 900, color: "#000", background: "#fff", padding: "5px 6px", border: "1px solid #000", textTransform: "uppercase", letterSpacing: 0.4 }}>Qty</th>
                    <th style={{ textAlign: "left", fontSize: 11, fontWeight: 900, color: "#000", background: "#fff", padding: "5px 8px", border: "1px solid #000", textTransform: "uppercase", letterSpacing: 0.4 }}>Item</th>
                    <th style={{ width: 78, textAlign: "right", fontSize: 11, fontWeight: 900, color: "#000", background: "#fff", padding: "5px 8px", border: "1px solid #000", textTransform: "uppercase", letterSpacing: 0.4 }}>Amount</th>
                    <th style={{ width: 34, border: "1px solid #000", background: "#fff" }} />
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(cart).map(([key, it]) => (
                    <tr key={key}>
                      <td style={{ textAlign: "center", border: "1px solid #000", padding: "6px 6px", fontSize: 14, fontWeight: 800, color: "#000" }}>{it.qty}×</td>
                      <td style={{ border: "1px solid #000", padding: "6px 8px", fontSize: 14, fontWeight: 600, color: "#000" }}>{it.n}</td>
                      <td style={{ textAlign: "right", border: "1px solid #000", padding: "6px 8px", fontSize: 14, fontWeight: 800, color: "#000", fontVariantNumeric: "tabular-nums" }}>₹{computeHodBreakdown([it]).grandTotal}</td>
                      <td style={{ textAlign: "center", border: "1px solid #000", padding: 4 }}>
                        <button onClick={() => removeFromCart(key)} title="Remove from cart"
                          style={{ width: 22, height: 22, borderRadius: "50%", background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 13, fontWeight: 900, cursor: "pointer", padding: 0, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto" }}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <details style={{ borderTop: "2px solid #000", paddingTop: 5, marginTop: 5 }}>
                <summary style={{ display: "flex", justifyContent: "space-between", alignItems: "center", listStyle: "none", cursor: "pointer" }}>
                  <span style={{ fontSize: 11, color: "#6B6B6B", fontStyle: "italic" }}>
                    Inclusive of all taxes <span style={{ opacity: 0.6, fontSize: 9 }}>▾ view breakdown</span>
                  </span>
                  <span style={{ fontSize: 15, fontWeight: 900, color: activeTotal > bal ? "#FF5733" : "#23A094" }}>
                    ₹{activeTotal.toLocaleString("en-IN")}
                    {activeTotal > bal && <span style={{ fontSize: 10 }}> (+₹{activeTotal - bal} over)</span>}
                  </span>
                </summary>
                <div style={{ fontSize: 11, lineHeight: 1.7, paddingTop: 6, marginTop: 5, borderTop: "2px solid #000", color: "#6B6B6B" }}>
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
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginTop: 4, color: "#6B6B6B" }}>
                    <span>{Object.values(cart).reduce((s, i) => s + i.qty, 0)} item(s)</span>
                    <span>Total {fmt(cartBreakdown.grandTotal)}</span>
                  </div>
                </div>
              </details>
            </div>
          </div>
        );
      })()}

      {/* 🆕 v3.114 (Khushi LIVE): customer pre-order list moved ABOVE the
          WALLET ACTIONS card. Bartender reads what was ordered FIRST, then
          taps PRINT KOT+BILL below — natural top-to-bottom flow. */}
      {preOrderItems.length > 0 && (
        <div style={{ background: "rgba(255,200,0,.10)", borderBottom: "2px solid #000", padding: "14px 16px", fontFamily: "'Space Grotesk',sans-serif" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 900, color: "#000", letterSpacing: 0.3, textTransform: "uppercase" }}>📋 CUSTOMER PRE-ORDER — TAP −/+ IF OUT OF STOCK</div>
            {editBusy && <div style={{ fontSize: 12, fontWeight: 800, color: "#000" }}>Saving…</div>}
          </div>
          {preOrderItems.map((it, i) => {
            const adjust = async (delta: number) => {
              if (editBusy) return;
              const next = preOrderItems.map((x, ix) => ix === i ? { ...x, qty: Math.max(0, (x.qty || 0) + delta) } : x);
              const cleaned = next.filter((x) => (x.qty || 0) > 0);
              if (cleaned.length === 0 && !confirm("Removing the last item will cancel the customer's order. Continue?")) return;
              setEditBusy(true);
              try { await updatePreparingRoundItems(cover.id, next, staffName); }
              catch (e: any) { showToast(e?.message || "Edit failed"); }
              setEditBusy(false);
            };
            const remove = async () => {
              if (editBusy) return;
              if (!confirm(`Remove "${it.n}" from customer's order? (out of stock / unavailable)`)) return;
              const next = preOrderItems.map((x, ix) => ix === i ? { ...x, qty: 0 } : x);
              const cleaned = next.filter((x) => (x.qty || 0) > 0);
              if (cleaned.length === 0 && !confirm("This was the last item — the entire order will be cancelled. Continue?")) return;
              setEditBusy(true);
              try { await updatePreparingRoundItems(cover.id, next, staffName); }
              catch (e: any) { showToast(e?.message || "Remove failed"); }
              setEditBusy(false);
            };
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "2px solid #000"}}>
                <div style={{ flex: 1, fontSize: 17, fontWeight: 800, color: "#000" }}>{it.n}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button onClick={() => adjust(-1)} disabled={editBusy}
                    style={{ width: 34, height: 34, borderRadius: 8, background: "#F4F4F0", border: "2px solid #000", color: "#000", fontSize: 18, fontWeight: 900, cursor: editBusy ? "not-allowed" : "pointer" }}>−</button>
                  <span style={{ fontSize: 18, fontWeight: 900, color: "#000", minWidth: 24, textAlign: "center" }}>{it.qty}</span>
                  <button onClick={() => adjust(1)} disabled={editBusy}
                    style={{ width: 34, height: 34, borderRadius: 8, background: "#F4F4F0", border: "2px solid #000", color: "#000", fontSize: 18, fontWeight: 900, cursor: editBusy ? "not-allowed" : "pointer" }}>+</button>
                </div>
                <div style={{ minWidth: 70, textAlign: "right", fontSize: 16, fontWeight: 900, color: "#000" }}>₹{computeHodBreakdown([it]).grandTotal}</div>
                <button onClick={remove} disabled={editBusy} title="Out of stock — remove"
                  style={{ width: 34, height: 34, borderRadius: 8, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 15, fontWeight: 900, cursor: editBusy ? "not-allowed" : "pointer" }}>🗑</button>
              </div>
            );
          })}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 18, fontWeight: 900, color: "#000", marginTop: 10, letterSpacing: 0.3, textTransform: "uppercase" }}>
            <span>ORDER TOTAL (INCL. TAX)</span><span>₹{preOrderTotal.toLocaleString("en-IN")}</span>
          </div>
        </div>
      )}

      {/* 🆕 2026-05-26 v3.29 (Khushi screenshot: "MOVE THIS UP IN THE CENTER /
          LIKE HOW WE HAVE BOX IN THE CAPATIN MODE") — Captain-style ACTION
          BOX. Sits right under the rounds list, ALWAYS visible (flexShrink:0,
          not in scroll body). Bordered gold box (mirrors captain's table
          card action footer). 5 buttons per Khushi's explicit list:
            1. ADD ORDER     → opens v3.27 fullscreen menu overlay
            2. PRINT KOT+BILL → smart: doActivate(true) when cart has items,
                                else handleThermalBill for activated rounds
            3. PRINT BILL    → reprint chit (DUPLICATE marker auto-applied)
            4. VOID BILL     → opens VoidBillModal (refunds + void slip +
                                WhatsApp); hidden until ≥1 bill printed and
                                not already voided
            5. RECHARGE      → opens recharge portal; pulses RED + shows
                                deficit when bal ≤ 0 or cart > bal
          DISC/SC + reprint moved out of always-visible chrome per Khushi
          rule. v3.27 BIG GREEN CTA collapsed into PRINT KOT+BILL slot
          (button turns green when ready, gold when bill-only path active,
          red when over-balance). */}
      {(() => {
        const billableRounds = (cv.tabRounds || []).filter((r) => r && (r.status === "activated" || r.status === "served"));
        const hasPreparing = (cv.tabRounds || []).some((r) => r && r.status === "preparing");
        const printedCount = cv.walletBillPrintCount || 0;
        const billVoided = !!(cv as unknown as { billVoided?: boolean }).billVoided;
        const refundAmtIfVoid = billableRounds.reduce((s, r) => s + Number(r.roundTotal || 0), 0);
        const canActivateNew = hasItems && canActivateFinal && !actBusy;
        const canPrintBillOnly = !hasItems && billableRounds.length > 0 && !billBusy && !hasPreparing;
        const canPrintKotBill = canActivateNew || canPrintBillOnly;
        const canReprint = printedCount > 0 && !reprintBusy && !billBusy;
        const canVoid = printedCount > 0 && !billVoided && refundAmtIfVoid > 0;
        const over = activeTotal > bal;
        const zero = bal <= 0;
        const rechargePulseRed = over || zero;
        const rechargeBg = rechargePulseRed ? "#FF5733" : "#FF90E8";
        const rechargeBorder = rechargePulseRed ? "2px solid #000" : "2px solid #000";
        const rechargeColor = rechargePulseRed ? "#fff" : "#000";
        const rechargeAnim = rechargePulseRed ? "hodPulseRed 1.2s infinite" : "none";
        const rechargeLabel = over ? `➕ RECHARGE ₹${activeTotal - bal}` : zero ? "➕ RECHARGE NOW" : "➕ RECHARGE";
        // PRINT KOT+BILL label — bill-only path always safe (no activation gate).
        let kotLabel: string;
        if (actBusy) kotLabel = "PRINTING…";
        else if (billBusy) kotLabel = "BILLING…";
        else if (canPrintBillOnly) kotLabel = "🖨 PRINT BILL CHIT";
        else if (blocked) kotLabel = "✅ PRINTED — RESCAN";
        else if (tickGateBlocked) kotLabel = `⏳ AWAIT TICK · ${Math.max(0, Math.ceil((PENDING_TICK_FAIL_OPEN_MS - pendingTickAgeMs) / 1000))}s`;
        else if (canActivateNew) kotLabel = `🖨 PRINT KOT+BILL · ₹${activeTotal.toLocaleString("en-IN")}`;
        else if (over) kotLabel = `❌ RECHARGE ₹${activeTotal - bal}`;
        else if (!hasItems && !billableRounds.length) kotLabel = "ADD ORDER FIRST";
        else kotLabel = "NO BALANCE";
        const onKotBillTap = () => {
          if (canActivateNew) { doActivate(true); return; }
          if (canPrintBillOnly) { handleThermalBill(); return; }
        };
        // Green when ready to activate fresh KOT+BILL; gold when print-bill-only path active.
        const kotIsGreen = canActivateNew;
        const kotBg = kotIsGreen
          ? "#23A094"
          : canPrintKotBill
            ? "#FF90E8"
            : "rgba(0,0,0,.08)";
        const kotBorder = kotIsGreen ? "2px solid #000" : canPrintKotBill ? "2px solid #000" : "2px solid rgba(0,0,0,.2)";
        const kotColor = kotIsGreen ? "#fff" : canPrintKotBill ? "#000" : "rgba(0,0,0,.4)";
        const kotShadow = undefined;
        return (
          // 🆕 2026-05-26 v3.30 (Khushi screenshot: "MOVE ADD ORDER, RECHARGE
          // PRINT BILL VOID BILL IN CENTER NOT SO UP AND GIVE A OUTLINE BOX
          // FOR ALL INFO - OUTER LINE") — wrapped in gold-outlined card with
          // top margin so the action grid sits visually centered under the
          // info block (not glued to the rounds list). Outer line = the gold
          // border. Action box still flexShrink:0 so it stays visible.
          /* 🆕 2026-06-03 v3.218 (Khushi: "PLACE THIS ON TOP NOT BELOW INITIALLY,
             AND AFTER THE BARTENDER CLICKS ADD ORDER AND A ROUND IS INITIATED THEN
             IT MUST MOVE BELOW") — the overlay is a full-height flex column. The
             rounds-list (flex:1 1 0) only renders once ≥1 round is activated; when
             there are NO rounds it's absent, so the prior unconditional
             marginTop:"auto" pushed this card to the BOTTOM even on a fresh wallet
             (the bug she screenshotted: actions glued to the bottom with a big gap
             above). Fix: marginTop stays 0; marginBottom is "auto" ONLY while there
             are no activated/served rounds → free space goes BELOW the card so it
             sits at the TOP (right under the header/pending order). Once a round is
             initiated, the rounds list (flex:1) absorbs the free space and naturally
             pushes this card to the BOTTOM (marginBottom:0). Exactly one auto-margin
             is ever active → deterministic placement, footer untouched. */
          <div style={{ padding: "8px 12px 8px", background: "#fff", flexShrink: 0, marginTop: 0, marginBottom: billableRounds.length > 0 ? 0 : "auto", fontFamily: "'Space Grotesk',sans-serif" }}>
            {/* 🆕 v3.186 (Khushi) — WALLET ACTIONS section fill → Gumroad YELLOW (gold) */}
            {/* 🆕 2026-06-03 v3.216 (Khushi) — card COMPACTED (padding + button
                heights trimmed) so with multiple rounds it no longer covers
                ~half the screen; the scrollable rounds list above gets more
                room, making it easier to add more rounds. */}
            <div style={{ background: "#F2C744", border: "2px solid #000", borderRadius: 14, padding: "9px 10px", boxShadow: "none"}}>
            <div style={{ fontSize: 10, fontWeight: 900, color: "#000", letterSpacing: 0.8, textTransform: "uppercase", textAlign: "center", marginBottom: 5, opacity: 0.75 }}>
              · WALLET ACTIONS ·
            </div>
            {/* 🆕 2026-05-26 v3.31 (Khushi screenshot — "BIG BUTTON FULL WIDTH
                AFTER ITEM IS SELECTED · INCREASE TEXT FONT OF ALL BUTTONS")
                — PRIMARY CTA on top spans the full card width whenever
                there's something to print (cart items → PRINT KOT+BILL green;
                already-activated rounds with no new cart → PRINT BILL gold).
                When neither path is active we hide it; the 4-button row below
                still has ADD ORDER / RECHARGE / etc. for the next step. */}
            {canPrintKotBill && (
              <button onClick={onKotBillTap}
                style={{
                  width: "100%", padding: "13px 14px", marginBottom: 7, borderRadius: 12,
                  fontSize: 17, fontWeight: 900, cursor: "pointer", letterSpacing: 0.5,
                  textTransform: "uppercase", lineHeight: 1.2, fontFamily: "'Space Grotesk',sans-serif",
                  background: kotBg, border: "2px solid #000", color: kotColor,
                  boxShadow: "none",
                }}>
                {kotLabel}
              </button>
            )}
            {/* Disabled-state hint banner. v3.114 — for over-balance we now
                show a one-shot popup (see overAck modal below) and SUPPRESS
                this inline banner once acknowledged. Other disabled states
                (busy, blocked, tick gate) still surface inline. */}
            {!canPrintKotBill && (actBusy || billBusy || blocked || tickGateBlocked) && (
              <div style={{
                width: "100%", padding: "14px 12px", marginBottom: 10, borderRadius: 12,
                fontSize: 14, fontWeight: 900, letterSpacing: 0.4, textTransform: "uppercase",
                textAlign: "center", fontFamily: "'Space Grotesk',sans-serif",
                background: tickGateBlocked ? "#FF90E8" : "rgba(107,107,138,.15)",
                border: "2px solid #000",
                color: tickGateBlocked ? "#000" : "rgba(220,220,220,.7)",
              }}>
                {kotLabel}
              </div>
            )}
            {/* 🆕 2026-05-26 v3.36 (Khushi: "REMOVE PURPLE PRINT BILL AND
                SWAP RECHARGE IN BETWEEN AND VOID BILL NEXT TO IT — ADD
                ORDER, RECHARGE, VOID BILL") — dropped from 4 to 3 buttons.
                PRINT BILL reprint button removed entirely (DUPLICATE
                reprint is still reachable via PRINT KOT+BILL primary CTA on
                top once a bill has been printed). New order: ADD ORDER →
                RECHARGE (middle, biggest pull) → VOID BILL. RECHARGE keeps
                its 1.3× width so the pulsing red deficit label stays
                readable. */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1.3fr 1fr", gap: 6, alignItems: "stretch" }}>
              {/* 1. ADD ORDER — 🆕 v3.186 (Khushi) → Gumroad GREEN (white text) */}
              <button onClick={() => setShowAddOrder(true)}
                style={{ padding: "12px 4px", borderRadius: 10, fontSize: 13, fontWeight: 900, cursor: "pointer", letterSpacing: 0.4,
                  background: "#23A094", border: "2px solid #000", color: "#fff", textTransform: "uppercase", lineHeight: 1.15 }}>
                ➕ ADD<br />ORDER
              </button>
              {/* 2. RECHARGE (middle, big, pulses red on deficit) */}
              <button onClick={() => { setRechargeOpen(true); setTimeout(() => rechargeRowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50); }}
                style={{ padding: "12px 4px", borderRadius: 10, fontSize: 14, fontWeight: 900, cursor: "pointer",
                  letterSpacing: 0.4, textTransform: "uppercase", lineHeight: 1.15,
                  background: rechargeBg, border: "2px solid #000", color: rechargeColor, animation: rechargeAnim,
                  boxShadow: "none"}}>
                {rechargeLabel}
              </button>
              {/* 3. VOID BILL (post-print only; hidden once voided) */}
              <button onClick={canVoid ? () => setShowVoidBill(true) : undefined} disabled={!canVoid}
                title={billVoided ? "Already voided" : printedCount === 0 ? "Void only after a bill is printed" : "Refund all rounds + print void slip"}
                style={{ padding: "12px 4px", borderRadius: 10, fontSize: 13, fontWeight: 900,
                  cursor: canVoid ? "pointer" : "not-allowed", letterSpacing: 0.4, textTransform: "uppercase", lineHeight: 1.15,
                  // 🆕 v3.185 (Khushi) — VOID BILL was RED TEXT ON RED BG → invisible.
                  // Gumroad: RED surface → WHITE text when actionable/voided; a
                  // disabled void reads as a muted grey pill (still legible).
                  background: (billVoided || canVoid) ? "#FF5733" : "#F4F4F0",
                  border: (billVoided || canVoid) ? "2px solid #000" : "2px solid rgba(0,0,0,.15)",
                  color: (billVoided || canVoid) ? "#fff" : "#6B6B6B" }}>
                {billVoided ? <>🚫 BILL<br />VOIDED</> : <>🚫 VOID<br />BILL</>}
              </button>
            </div>
            </div>
          </div>
        );
      })()}

      {/* V4 2026-05-11 — persistent PENDING TICK badge. Lives on the cover
          header until the webhook tick arrives. Khushi can spot any wallet
          at end-of-night with unverified online recharges and reconcile. */}
      {persistentPendingTicks.length > 0 && (
        <div style={{ background: "rgba(255,200,0,.10)", borderBottom: "2px solid #000", padding: "8px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#ffc800" }}>
            🟡 PENDING ✅ TICK — ₹{persistentPendingTotal.toLocaleString("en-IN")} ({persistentPendingTicks.length} online recharge{persistentPendingTicks.length > 1 ? "s" : ""})
          </div>
          <div style={{ fontSize: 10, color: "rgba(255,200,0,.7)", fontStyle: "italic" }}>verify EOD</div>
        </div>
      )}

      {/* 🍳 2026-05-21 — KDS FOOD-READY banner for bar wallet flow. Chef
          bumped this cover's food → bartender sees pulsing green strip with
          dish list and a ✓ PICKED UP button. Same UX as captain side. */}
      {readyKDSForThisCover.length > 0 && (
        <div
          style={{
            background: "#00C864",
            color: "#000", padding: "10px 16px", borderBottom: "2px solid #000",
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
            animation: "hodKdsReady 1.4s ease-in-out infinite",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 900, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 2 }}>
              🍽 FOOD READY — RUN THE PASS
            </div>
            <div style={{ fontSize: 12, opacity: 0.95, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {readyKDSForThisCover.map((it) => `${it.qty}× ${it.itemName}`).join(" · ")}
            </div>
          </div>
          <button
            onClick={async (e) => {
              e.stopPropagation();
              for (const it of readyKDSForThisCover) {
                if (it.id) { try { await markKDSPickedUp(it.id, staffName); } catch {} }
              }
            }}
            style={{
              background: "#fff", color: "#16a34a", border: "none", padding: "8px 14px",
              borderRadius: 8, fontSize: 13, fontWeight: 900, letterSpacing: 0.5,
              cursor: "pointer", flexShrink: 0, textTransform: "uppercase",
            }}
          >✓ PICKED UP</button>
        </div>
      )}

      {/* 🆕 2026-05-26 v3.35 (Khushi) — WALLET TIMELINE block deleted.
          The v3.26 rounds list above already shows every active/served
          round (with round total + per-item base price + tax breakdown);
          recharges/voids/bills are surfaced elsewhere (header BALANCE pill,
          recharge portal, VOID BILL action). Khushi: "AS ITS CLEARLY
          VISIBLE IN BETWEEN". */}

      {/* v3.114: original preOrderItems block here moved ABOVE the WALLET
          ACTIONS card (top-to-bottom flow: read order → tap PRINT KOT+BILL). */}

      {/* 🆕 2026-05-26 v3.27 (Khushi screenshots — captain-parity fix) — Menu
          picker is now a FIXED FULL-SCREEN OVERLAY (z-index 80) on top of the
          wallet card, exactly like Captain Mode's "Add Order — FD7" screen.
          Header: 🍽 ADD ORDER — REF + × CLOSE button. Body: search + tabs +
          items list (unchanged). Footer (when cart has items): gold "ADD
          ROUND · ₹X (N items)" CTA that closes the overlay — cart items
          PERSIST and surface as a pending preview in the wallet card with a
          big GREEN "🖨 PRINT KOT + BILL" button (captain shows "PRINT KOT
          NOW" — bar mode is cash-and-carry so it always says + BILL).
          × CLOSE and ADD ROUND both ONLY toggle the overlay — neither
          clears cart/preOrderItems, so the bartender can tap × to step
          away and come back. Cart is only consumed by PRINT KOT+BILL
          (doActivate). */}
      {showAddOrder && (
      <div style={{ position: "fixed", inset: 0, zIndex: 80, background: "#fff", display: "flex", flexDirection: "column", fontFamily: "'Space Grotesk',sans-serif" }}>
        <div style={{ padding: "14px 16px 12px", background: "#fff", borderBottom: "2px solid #000", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexShrink: 0 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#000", letterSpacing: 0.4, textTransform: "uppercase", lineHeight: 1.15, fontVariantNumeric: "tabular-nums" }}>🍽 ADD ORDER — {cv.ref}</div>
            <div style={{ fontSize: 12, color: "#6B6B6B", fontWeight: 700, marginTop: 4, letterSpacing: 0.3, textTransform: "uppercase" }}>{cv.name || "WALK-IN"}{staffName ? ` · ${staffName}` : ""}</div>
          </div>
          <button onClick={() => setShowAddOrder(false)} aria-label="Close menu"
            style={{ padding: "8px 12px", borderRadius: 10, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 12, fontWeight: 900, cursor: "pointer", letterSpacing: 0.5, flexShrink: 0 }}>× CLOSE</button>
        </div>
      <div style={{ padding: "10px 16px 0", background: "#fff", flexShrink: 0 }}>
        <input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder="Search"
          style={{ width: "100%", padding: "12px 14px", borderRadius: 6, background: "transparent", border: "2px solid #000", color: "#000", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 10, textAlign: "center" }} />
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${menuGroups.length}, 1fr)`, gap: 6, marginBottom: 8 }}>
          {menuGroups.map((g) => {
            const active = activeGroup === g;
            const tint = BAR_GROUP_TINT[g] || { bg: "#FF90E8", fg: "#000" };
            return (
              <button key={g} onClick={() => { setActiveGroup(g); setSubCategory(""); }}
                style={{
                  padding: "14px 6px", borderRadius: 6, fontSize: 12, fontWeight: 800, letterSpacing: 1, cursor: "pointer",
                  background: active ? tint.bg : "#fff",
                  color: active ? tint.fg : "#000",
                  border: "2px solid #000",
                  textTransform: "uppercase",
                }}>{GROUP_LABELS[g] || g}</button>
            );
          })}
        </div>
        {/* 2026-05-15 (Khushi UX) — sub-category strip removed. Search bar now
            covers ALL groups (FOOD/LIQUOR/NAB/SMOKE) globally — bartender
            doesn't need to switch tabs. Tabs above still work as a quick
            visual filter when not searching. */}
        <div style={{ height: 1, background: "#F4F4F0" }} />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 16px", background: "#fff" }}>
        {(() => {
          const visibleItems = subCategory ? filteredItems.filter((m) => m.category === subCategory) : filteredItems;
          if (visibleItems.length === 0) {
            return <div style={{ textAlign: "center", padding: 30, color: "#6B6B6B", fontSize: 13 }}>No items found</div>;
          }
          return visibleItems.map((item) => {
            const inCart = cart[item.id];
            const qty = inCart?.qty || 0;
            const ov = menuOverrides[ovKey(item.name)];
            const eff = effectivePrice(item.name, item.price);
            const hasDisc = eff !== item.price;
            const showVeg = item.group === "food";
            return (
              <div key={`${item.id}-${item.category}-${item.name}`}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "2px solid #000"}}>
                <div style={{ flex: 1, paddingRight: 8, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 16, color: "#000", fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.2, lineHeight: 1.25 }}>
                    {showVeg && (
                      <span style={{ display: "inline-block", width: 12, height: 12, border: "2px solid #000", borderRadius: 2, position: "relative", flexShrink: 0 }}>
                        <span style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 5, height: 5, borderRadius: "50%", background: item.isVeg ? "#23A094" : "#dc2626" }} />
                      </span>
                    )}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
                  </div>
                  <div style={{ fontSize: 20, color: "#000", marginTop: 4, fontWeight: 900, lineHeight: 1.2 }}>
                    {/* 🔴 menu list shows RAW menu price (matches the printed bar
                        menu); tax-inclusive only kicks in once item enters the
                        cart. 🆕 Captain-match: 20px bold BLACK. */}
                    {hasDisc ? (
                      <>
                        <span style={{ textDecoration: "line-through", color: "#000", marginRight: 6 }}>₹{item.price}</span>
                        <span style={{ color: "#23A094" }}>₹{eff}</span>
                      </>
                    ) : (
                      <>₹{item.price}</>
                    )}
                  </div>
                </div>
                {/* 🆕 Captain-match: row always shows a red ADD + (mirrors
                    CaptainMode AddOrderModal). A small white qty badge appears
                    once in cart; qty is edited via the bottom cart panel. */}
                <button onClick={() => addToCart(item)}
                  style={{ padding: "8px 18px", borderRadius: 4, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 14, fontWeight: 800, letterSpacing: 0.5, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", gap: 6 }}>
                  {inCart && <span style={{ background: "#fff", color: "#000", borderRadius: 999, padding: "0 7px", fontSize: 12, fontWeight: 900, lineHeight: "18px", minWidth: 18, textAlign: "center" }}>{qty}</span>}
                  ADD +
                </button>
              </div>
            );
          });
        })()}
      </div>
        {/* 🆕 v3.27 — overlay footer: gold ADD ROUND CTA. Closes the overlay,
            cart items PERSIST. Wallet card behind shows them as a pending
            preview with a big green PRINT KOT + BILL button. */}
        <div style={{ flexShrink: 0, background: "#fff", borderTop: "2px solid #000" }}>
          {hasItems ? (
            // 🆕 Captain-match: bottom cart panel lists the selected items with
            // white −/+ steppers + a teal "Add Round" CTA (mirrors CaptainMode
            // AddOrderModal cart). Closing the overlay keeps the cart.
            <div style={{ padding: "12px 16px 18px" }}>
              <div style={{ maxHeight: 150, overflowY: "auto", marginBottom: 8 }}>
                {Object.entries(cart).map(([key, c]) => (
                  <div key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0" }}>
                    <span style={{ fontSize: 14, color: "#000", flex: 1 }}>{c.n}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button onClick={(e) => { e.stopPropagation(); updateCartQty(key, -1); }} style={{ width: 24, height: 24, borderRadius: 6, background: "#fff", border: "1px solid #000", color: "#000", cursor: "pointer", fontSize: 14 }}>−</button>
                      <span style={{ fontSize: 16, fontWeight: 800, color: "#000", minWidth: 16, textAlign: "center" }}>{c.qty}</span>
                      <button onClick={(e) => { e.stopPropagation(); updateCartQty(key, 1); }} style={{ width: 24, height: 24, borderRadius: 6, background: "#fff", border: "1px solid #000", color: "#000", cursor: "pointer", fontSize: 14 }}>+</button>
                      <span style={{ fontSize: 14, color: "#000", minWidth: 50, textAlign: "right" }}>₹{computeHodBreakdown([c]).grandTotal}</span>
                    </div>
                  </div>
                ))}
              </div>
              <button onClick={() => setShowAddOrder(false)}
                style={{ width: "100%", padding: 14, borderRadius: 12, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 18, fontWeight: 900, cursor: "pointer" }}>
                📝 Add Round · ₹{activeTotal.toLocaleString("en-IN")} ({Object.values(cart).reduce((s, i) => s + i.qty, 0)} items)
              </button>
            </div>
          ) : (
            <div style={{ padding: "10px 14px 18px" }}>
              <div style={{ width: "100%", padding: "14px 10px", borderRadius: 12, fontSize: 13, fontWeight: 800, textAlign: "center", letterSpacing: 0.5,
                background: "#F4F4F0", border: "2px solid #000", color: "#000" }}>
                CART EMPTY · PICK ITEMS TO ADD
              </div>
            </div>
          )}
        </div>
      </div>)}

      {/* 🆕 2026-05-26 v3.26 (Khushi) — sticky-footer fix. When showAddOrder=false
          there's no flex:1 child pushing the bottom bar to the viewport bottom,
          so the 4-button row would float up. marginTop:"auto" pins it to the
          bottom of the flex column regardless. backdropFilter blur keeps the
          earlier sticky-glass look when the timeline scrolls behind it. */}
      {/* 🆕 2026-06-03 v3.215 — marginTop:"auto" REMOVED here and moved to the
          WALLET ACTIONS card above. Two auto-margin siblings in a flex column
          SPLIT the free space (leaving a gap), so the actions card never fully
          anchored to the bottom. With the single auto margin now on the actions
          card, IT absorbs all free space and this footer sits immediately below
          it at the very bottom. */}
      <div style={{ background: "#fff", borderTop: "2px solid #000", padding: "12px 16px 24px", flexShrink: 0, position: "sticky", bottom: 0, zIndex: 5, backdropFilter: "blur(8px)" }}>
        {/* 🆕 2026-05-26 v3.32 — PENDING ORDER cart bar relocated UP above
            WALLET ACTIONS (per Khushi screenshot "JUST SWAP"). Sticky bottom
            footer now holds only the recharge portal trigger. */}

        {/* 2026-05-15 (Khushi UX) — recharge panel is a TOP-anchored POPOVER
            OVERLAY portaled to document.body. PORTAL IS REQUIRED: the cart
            container at line ~1102 has `backdropFilter: blur(8px)`, which
            in modern browsers makes that element a containing block for any
            descendant `position: fixed` element. Without the portal the
            popover gets trapped inside the bottom cart bar and renders
            squished at the bottom (Khushi bug 2026-05-15 PM). Portaling
            escapes that trap and lets it float over the entire viewport. */}
        {rechargeOpen && typeof document !== "undefined" && document.body && createPortal(
          <div onClick={() => setRechargeOpen(false)}
            style={{ position: "fixed", inset: 0, background: "rgba(3,3,5,.78)", zIndex: 99990, display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: 40, paddingBottom: 20, paddingLeft: 12, paddingRight: 12, backdropFilter: "blur(3px)", overflowY: "auto", fontFamily: "'Space Grotesk',sans-serif" }}>
            <div ref={rechargeRowRef} onClick={(e) => e.stopPropagation()}
              style={{ width: "100%", maxWidth: 460, maxHeight: "calc(100vh - 60px)", overflowY: "auto", background: "#fff", border: "2px solid #000", borderRadius: 18, padding: 22, position: "relative", boxShadow: "none"}}>
              <button onClick={() => setRechargeOpen(false)} title="Close"
                style={{ position: "absolute", top: 12, right: 14, width: 36, height: 36, borderRadius: 10, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 22, cursor: "pointer", lineHeight: 1, padding: 0, fontWeight: 900 }}>×</button>

              {/* HEADER */}
              <div style={{ fontSize: 20, fontWeight: 900, color: "#000", marginBottom: 14, paddingRight: 42, letterSpacing: .5 }}>
                ➕ RECHARGE WALLET
              </div>

              {/* GREEN BALANCE CARD — customer's available balance */}
              <div style={{ background: "#23A094", border: "2px solid #000", borderRadius: 12, padding: "14px 16px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "none"}}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#23A094", letterSpacing: 1.2, marginBottom: 4 }}>AVAILABLE BALANCE</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#6B6B6B" }}>{cv.name || cv.tableId || "WALLET"}</div>
                </div>
                <div style={{ fontSize: 30, fontWeight: 900, color: "#23A094", textShadow: "none"}}>
                  ₹{bal.toLocaleString("en-IN")}
                </div>
              </div>

              {/* DEFICIT BANNER (if any) */}
              {deficit > 0 && (() => {
                const currentAmt = parseInt(rcAmt) || 0;
                const matches = currentAmt === suggestedRecharge;
                return (
                  <div style={{ background: "#FF5733", border: "2px solid #000", borderRadius: 10, padding: "10px 12px", marginBottom: 14, fontSize: 13, fontWeight: 800, color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span>⚠ SHORT ₹{Math.round(deficit).toLocaleString("en-IN")} · {matches ? `set to ₹${suggestedRecharge.toLocaleString("en-IN")}` : `tap RESET → ₹${suggestedRecharge.toLocaleString("en-IN")}`}</span>
                    <button onClick={() => { setRcAmt(String(suggestedRecharge)); setRcAmtTouched(false); }}
                      style={{ padding: "6px 10px", borderRadius: 8, background: matches ? "#FF90E8" : "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 12, fontWeight: 900, cursor: "pointer", whiteSpace: "nowrap" }}>
                      ↻ RESET
                    </button>
                  </div>
                );
              })()}

              {/* AMOUNT INPUT — big */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#000", letterSpacing: 1.2, marginBottom: 6 }}>ENTER AMOUNT</div>
                <div style={{ display: "flex", alignItems: "center", background: "#fff", border: "2px solid #000", borderRadius: 12, padding: "4px 14px" }}>
                  <span style={{ fontSize: 26, fontWeight: 900, color: "#000", marginRight: 6 }}>₹</span>
                  <input type="number" value={rcAmt} onChange={(e) => { setRcAmt(e.target.value); setRcAmtTouched(true); }} placeholder="0"
                    style={{ flex: 1, background: "transparent", border: "none", padding: "12px 0", color: "#000", fontSize: 26, fontWeight: 900, outline: "none", minWidth: 0 }} />
                </div>
              </div>

              {/* PAYMENT METHOD */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#000", letterSpacing: 1.2, marginBottom: 8 }}>PAYMENT METHOD</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
                  {(["cash", "upi", "card", "split"] as const).map((m) => (
                    <button key={m} onClick={() => setRcMethod(m)}
                      style={{ padding: "14px 6px", borderRadius: 10, fontSize: 13, fontWeight: 900, cursor: "pointer", letterSpacing: .3,
                        background: rcMethod === m ? "#FF90E8" : "#F4F4F0",
                        border: "2px solid #000",
                        color: rcMethod === m ? "#000" : "#6B6B6B" }}>
                      <div style={{ fontSize: 20, marginBottom: 4 }}>{m === "cash" ? "💵" : m === "upi" ? "📱" : m === "card" ? "💳" : "🔀"}</div>
                      {m === "cash" ? "CASH" : m === "upi" ? "UPI" : m === "card" ? "CARD" : "SPLIT"}
                    </button>
                  ))}
                </div>
                {rcMethod === "split" && (
                  <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    {(["cash", "upi", "card"] as const).map((k) => (
                      <div key={k}>
                        <div style={{ fontSize: 10, color: "#6B6B6B", textTransform: "uppercase", letterSpacing: .8, marginBottom: 4, textAlign: "center", fontWeight: 800 }}>
                          {k === "cash" ? "💵 CASH" : k === "upi" ? "📱 UPI" : "💳 CARD"}
                        </div>
                        <input type="number" value={rcSplit[k]} onChange={(e) => setRcSplit(s => ({ ...s, [k]: e.target.value }))} placeholder="0"
                          style={{ width: "100%", boxSizing: "border-box", background: "#fff", border: "2px solid #000", borderRadius: 8, padding: "10px 8px", color: "#000", fontSize: 16, fontWeight: 800, textAlign: "center", outline: "none" }} />
                      </div>
                    ))}
                    {(() => {
                      // 🆕 v3.195 — split must total the DISCOUNT-adjusted net (rcNet).
                      const amt = rcNet;
                      const sum = (parseInt(rcSplit.cash) || 0) + (parseInt(rcSplit.upi) || 0) + (parseInt(rcSplit.card) || 0);
                      const ok = amt > 0 && sum === amt;
                      return (
                        <div style={{ gridColumn: "1 / -1", fontSize: 12, textAlign: "center", marginTop: 4, color: ok ? "#23A094" : "#6B6B6B", fontWeight: 800 }}>
                          SUM: ₹{sum} {amt > 0 && `/ ₹${amt}`} {ok ? "✓" : sum > amt ? "(OVER)" : ""}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>

              {/* DISCOUNT — opt-in dropdown. Default 0% (no discount) so
                  bartender has to deliberately pick one per order. Presets up
                  to 50% apply on the spot; CUSTOM (> 50%) opens in-app
                  Manager PIN modal. */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#000", letterSpacing: 1.2, marginBottom: 6 }}>DISCOUNT (OPTIONAL)</div>
                <select value={barDiscPct <= 50 ? String(barDiscPct) : "custom"}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "custom") { setBarDiscPct(0); requestDiscount(); return; }
                    setBarDiscPct(Math.max(0, Math.min(50, parseInt(v) || 0)));
                  }}
                  style={{ width: "100%", boxSizing: "border-box", background: "#fff", border: "2px solid #000", borderRadius: 12, padding: "14px 14px", color: barDiscPct > 0 ? "#000" : "#000", fontSize: 16, fontWeight: 900, outline: "none", cursor: "pointer", appearance: "none", WebkitAppearance: "none", backgroundImage: "linear-gradient(45deg, transparent 50%, #000 50%), linear-gradient(135deg, #000 50%, transparent 50%)", backgroundPosition: "calc(100% - 18px) center, calc(100% - 12px) center", backgroundSize: "6px 6px, 6px 6px", backgroundRepeat: "no-repeat" }}>
                  {[0, 5, 10, 15, 20, 25, 30, 40, 50].map((q) => (
                    <option key={q} value={String(q)} style={{ background: "#fff", color: "#000" }}>
                      {q === 0 ? "NO DISCOUNT (0%)" : `${q}%`}
                    </option>
                  ))}
                  <option value="custom" style={{ background: "#fff", color: "#000" }}>CUSTOM % (MANAGER PIN)</option>
                </select>
                {/* 🆕 v3.195 (Khushi) — live discount breakdown so the bartender
                    SEES the recharge change: ₹300 − 20% = ₹240 to collect. */}
                {barDiscPct > 0 && rcAmtNum > 0 && (
                  <div style={{ marginTop: 8, padding: "8px 12px", background: "#F4F4F0", border: "2px solid #000", borderRadius: 10, fontSize: 13, fontWeight: 900, color: "#000", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>₹{rcAmtNum.toLocaleString("en-IN")} − {barDiscPct}% (−₹{rcDiscAmt.toLocaleString("en-IN")})</span>
                    <span style={{ color: "#23A094" }}>= ₹{rcNet.toLocaleString("en-IN")}</span>
                  </div>
                )}
              </div>

              {/* SERVICE TAX toggle — default ON. OFF needs Manager PIN. */}
              <button onClick={requestScToggle}
                style={{ width: "100%", padding: "12px 14px", marginBottom: 14, borderRadius: 12, background: scOn ? "#FF90E8" : "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900, cursor: "pointer", letterSpacing: .5, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>🧾 SERVICE TAX (10%)</span>
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 900, opacity: .95 }}>{scOn ? "ON" : "OFF (MGR)"}</span>
                  {/* 🆕 v3.191 (Khushi) — track was pink-on-pink (same as the
                      button) → invisible. Now a contrasting GREEN (ON) / WHITE
                      (OFF) pill with a 2px black border so the state is clear. */}
                  <span style={{ width: 46, height: 26, borderRadius: 999, background: scOn ? "#23A094" : "#fff", border: "2px solid #000", boxSizing: "border-box", position: "relative", transition: "background .15s" }}>
                    <span style={{ position: "absolute", top: 2, left: scOn ? 22 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", border: "1.5px solid #000", boxShadow: "none", transition: "left .15s" }} />
                  </span>
                </span>
              </button>

              {/* BIG RECHARGE CTA */}
              <button onClick={doRecharge} disabled={rcBusy || !rcAmt || rcNet < 1}
                style={{ width: "100%", padding: "16px 14px", borderRadius: 14, background: rcBusy || !rcAmt ? "#FF90E8" : "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 17, fontWeight: 900, cursor: rcBusy ? "not-allowed" : "pointer", letterSpacing: .6, boxShadow: "none"}}>
                {rcBusy ? "PROCESSING..." : `➕ RECHARGE ₹${rcNet}`}
              </button>
            </div>
          </div>,
          document.body
        )}

        {/* v3.114 — DISCOUNT modal (in-app, no browser popup). Quick chips
            0/10/20/30/40/50% one-tap; custom % input; above 50% reveals
            inline Manager PIN field (validated via BAR_MANAGER_HASH). */}
        {discOpen && typeof document !== "undefined" && document.body && createPortal(
          <DiscountModal
            current={barDiscPct}
            onApply={(pct) => { setBarDiscPct(pct); setDiscOpen(false); showToast(`✅ Discount set to ${pct}%`); }}
            onClose={() => setDiscOpen(false)}
          />,
          document.body
        )}

        {/* 🆕 2026-05-26 v3.26 (Khushi) — Inline PRINT BILL button REMOVED.
            Combined PRINT KOT+BILL lives in the sticky footer button row
            below; it falls through to handleThermalBill() automatically
            when there are billable rounds but no new cart items. */}
        {/* 🆕 2026-06-03 v3.216 (Khushi: "remove this line 'bill 1 printed
            wait 14s'") — the post-print cooldown "✅ Bill #N just printed ·
            wait Xs" indicator block was REMOVED entirely. The
            WALLET_BILL_DEBOUNCE_MS guard in the print handler still prevents
            accidental duplicate reprints; it just no longer renders a banner. */}

        {/* 🆕 2026-05-26 v3.29 — standalone VOID BILL block REMOVED.
            VOID BILL now lives in the centered 5-button action box at the top
            of the wallet card. The "🚫 BILL VOIDED" status indicator is also
            removed (the ACTIVE/EXPIRED pill in the header already conveys
            wallet state; the action box hides VOID BILL once voided). */}

        {/* V4 2026-05-11 — GREEN ✅ verified banner. Shown when the most
            recent online recharge in the last 5 min IS server-verified. Gives
            the bartender positive feedback that the money is real BEFORE they
            tap PRINT KOT (per Khushi's request — turn the button explicitly
            green on verification). Suppressed if there's also a pending tick
            (the warning banner takes priority). */}
        {lastVerifiedOnlineTick && !pendingOnlineTopUp && (
          <div style={{
            marginBottom: 10, padding: "8px 12px", borderRadius: 10,
            background: "#23A094", border: "2px solid #000",
            color: "#23A094", fontSize: 12, fontWeight: 800, textAlign: "center", lineHeight: 1.5,
          }}>
            ✅ RAZORPAY VERIFIED — ₹{(lastVerifiedOnlineTick.amount || 0).toLocaleString("en-IN")} online recharge confirmed
            <div style={{ fontSize: 10, fontWeight: 600, marginTop: 2, opacity: .8 }}>
              pay …{(lastVerifiedOnlineTick.paymentId || "").slice(-8)} · safe to print KOT
            </div>
          </div>
        )}

        {/* V4 2026-05-11 — pending webhook tick banner. Shown ONLY while a
            recent online recharge is unverified. Gold pulse while inside the
            60-sec block window; turns yellow/warning when we're auto-fail-
            opening (bartender can activate but it'll be flagged in admin). */}
        {pendingOnlineTopUp && (
          <div style={{
            marginBottom: 10, padding: "10px 12px", borderRadius: 10,
            background: pendingTickStillBlocking ? "#FF90E8" : "rgba(245,158,11,.12)",
            border: "2px solid #000",
            color: pendingTickStillBlocking ? "#000" : "#F59E0B",
            fontSize: 12, fontWeight: 800, textAlign: "center", lineHeight: 1.5,
          }}>
            {pendingTickStillBlocking ? (
              <>
                ⏳ AWAITING ✅ WEBHOOK TICK FOR ₹{pendingOnlineTopUp.amount} ONLINE RECHARGE
                <div style={{ fontSize: 10, fontWeight: 600, marginTop: 3, opacity: .8 }}>
                  Auto-allow in {Math.max(0, Math.ceil((PENDING_TICK_FAIL_OPEN_MS - pendingTickAgeMs) / 1000))}s · pay ID …{(pendingOnlineTopUp.paymentId || "").slice(-8)}
                </div>
              </>
            ) : (
              <>
                ⚠ NO WEBHOOK TICK YET — ACTIVATING WILL FLAG AS PENDING
                <div style={{ fontSize: 10, fontWeight: 600, marginTop: 3, opacity: .85 }}>
                  Pay ID …{(pendingOnlineTopUp.paymentId || "").slice(-8)} · admin will see this in Live Monitor
                </div>
              </>
            )}
          </div>
        )}

        {/* 🆕 2026-05-26 v3.29 — v3.27 BIG GREEN block + v3.11 DISC/SC strip
            REMOVED. Khushi: "REMOVE DISC AND SC OFF BUTTONS HERE". The
            5-button captain-style action box at the top of the wallet card
            (inserted right after the rounds list) now carries PRINT KOT+BILL
            as a dedicated button — no need for a separate big-green CTA.
            DISC/SC state (barDiscPct, scOn) and `computePrintAmounts` LEFT
            INTACT so backend bill math defaults work (0% disc, no SC); the
            user-facing toggles are gone. If Khushi wants discount UI back,
            it returns as a small chip inside the ADD ORDER overlay later. */}

        {/* 🆕 2026-05-26 v3.29 — bottom 4-button grid REMOVED. The action
            buttons (now 5: ADD ORDER · PRINT KOT+BILL · PRINT BILL · VOID
            BILL · RECHARGE) live in the centered captain-style action box
            at the TOP of the wallet card — see v3.29 block inserted right
            after the rounds list. */}
      </div>
      {/* V4 2026-05-11 — SCREENSHOT COLLECTION MODAL. Triggered when bartender
          taps PRINT KOT during the 60-sec fail-open window (Razorpay payment
          claimed by customer but our server tick never landed). Forces them
          to visually confirm the customer's UPI app shows a successful
          payment with a ref ID — Khushi reconciles next morning against
          the Razorpay dashboard. Submit proceeds with activation; SKIP also
          activates but with a NO-SCREENSHOT marker so admin sees the gap. */}
      {screenshotPrompt && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(3,3,5,.92)", zIndex: 99999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 22, width: "100%", maxWidth: 380, color: "#000", boxShadow: "none"}}>
            <div style={{ fontSize: 28, textAlign: "center", marginBottom: 6 }}>📸</div>
            <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 19, fontWeight: 900, color: "#F59E0B", textAlign: "center", marginBottom: 8 }}>
              COLLECT PAYMENT SCREENSHOT
            </div>
            <div style={{ fontSize: 12, color: "#6B6B6B", lineHeight: 1.55, marginBottom: 14, textAlign: "center" }}>
              Customer paid <b style={{ color: "#F59E0B" }}>₹{screenshotPrompt.expectedAmount.toLocaleString("en-IN")}</b> online but our server tick hasn't arrived in 60s.
              <br /><b>Look at the customer's phone.</b> Their UPI app should show ✅ SUCCESS with a reference number. Type that ref below — Khushi will cross-check Razorpay tomorrow morning.
            </div>

            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "rgba(245,158,11,.85)", textTransform: "uppercase", letterSpacing: .8, marginBottom: 4 }}>
                UPI / Bank Reference Number *
              </div>
              <input value={ssUpiRef} onChange={(e) => setSsUpiRef(e.target.value)}
                placeholder="e.g. 412856907321"
                style={{ width: "100%", boxSizing: "border-box", background: "#fff", border: "2px solid #000", borderRadius: 8, padding: "10px 12px", color: "#000", fontSize: 14, outline: "none", fontWeight: 700 }} />
            </div>

            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "rgba(245,158,11,.85)", textTransform: "uppercase", letterSpacing: .8, marginBottom: 4 }}>
                Customer Phone (verify shown on screen)
              </div>
              <input value={ssPhoneSeen} onChange={(e) => setSsPhoneSeen(e.target.value)}
                placeholder="e.g. 98xxxxxx21"
                style={{ width: "100%", boxSizing: "border-box", background: "#fff", border: "2px solid #000", borderRadius: 8, padding: "10px 12px", color: "#000", fontSize: 14, outline: "none" }} />
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#6B6B6B", textTransform: "uppercase", letterSpacing: .8, marginBottom: 4 }}>
                Notes (optional — bank name, time, anything odd)
              </div>
              <input value={ssNote} onChange={(e) => setSsNote(e.target.value)}
                placeholder="e.g. HDFC GPay 11:42pm"
                style={{ width: "100%", boxSizing: "border-box", background: "#fff", border: "2px solid #000", borderRadius: 8, padding: "9px 12px", color: "#000", fontSize: 13, outline: "none" }} />
            </div>

            <button
              onClick={async () => {
                if (!ssUpiRef.trim()) { showToast("Type the UPI ref number from the customer's phone"); return; }
                setSsBusy(true);
                try {
                  await recordPendingPaymentScreenshot(cover.id, {
                    by: staffName,
                    paymentId: screenshotPrompt.paymentId,
                    expectedAmount: screenshotPrompt.expectedAmount,
                    upiRef: ssUpiRef,
                    customerPhoneSeen: ssPhoneSeen,
                    note: ssNote,
                  });
                } catch (e: any) {
                  // Fail-open philosophy — if the audit write fails, we still
                  // let activation proceed (the [PENDING-TICK …] suffix is
                  // already in the staff string so admin sees it either way).
                  showToast(`Screenshot save failed (${e?.message || "network"}) — activating anyway`);
                }
                setSsBusy(false);
                setScreenshotPrompt(null);
                // Re-trigger activate; ssUpiRef is now set so the staff suffix
                // will include the SCREENSHOT marker.
                setTimeout(() => { doActivate(); }, 50);
              }}
              disabled={ssBusy || !ssUpiRef.trim()}
              style={{ width: "100%", padding: 14, marginBottom: 8, borderRadius: 12, fontSize: 14, fontWeight: 900, cursor: (ssBusy || !ssUpiRef.trim()) ? "not-allowed" : "pointer",
                background: (ssBusy || !ssUpiRef.trim()) ? "rgba(245,158,11,.18)" : "#F59E0B",
                border: "2px solid #000", color: (ssBusy || !ssUpiRef.trim()) ? "rgba(245,158,11,.5)" : "#000" }}>
              {ssBusy ? "SAVING..." : "✓ SAVED — PROCEED & PRINT KOT"}
            </button>

            <button
              onClick={() => {
                if (!confirm("Activate WITHOUT screenshot proof?\n\nIf the payment is fake, we may not be able to recover the money. Use only if customer's phone is unavailable.")) return;
                setScreenshotPrompt(null);
                // ssUpiRef stays empty → staff suffix will say NO-SCREENSHOT.
                setTimeout(() => { doActivate(); }, 50);
              }}
              disabled={ssBusy}
              style={{ width: "100%", padding: 10, marginBottom: 8, borderRadius: 10, fontSize: 12, fontWeight: 800, cursor: ssBusy ? "not-allowed" : "pointer",
                background: "#FF5733", border: "2px solid #000", color: "#fff" }}>
              ⚠ Skip — Activate without proof
            </button>

            <button onClick={() => setScreenshotPrompt(null)} disabled={ssBusy}
              style={{ width: "100%", padding: 10, borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: ssBusy ? "not-allowed" : "pointer",
                background: "transparent", border: "2px solid #000", color: "#6B6B6B" }}>
              ← Cancel (don't activate)
            </button>
          </div>
        </div>
      )}

      {/* v3.114 — OVER-BALANCE popup. Fires the moment cart total exceeds
          wallet balance. OK dismisses and suppresses the inline disabled
          banner; the RECHARGE button below keeps pulsing red. Re-arms when
          cart goes back under balance. Fail-open: never blocks any action. */}
      {activeTotal > bal && !overAck && !showAddOrder && (
        <div
          onClick={() => setOverAck(true)}
          style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,.78)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'Space Grotesk',sans-serif" }}>
          {/* 🆕 v3.190 (Khushi) — was a dark (#1a0e0e) card with a ⚠️ warning +
              red title that read like an alarm. Now a friendly Gumroad WHITE
              card, no warning icon (calm 💳), INK title — reads as a message. */}
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: "#fff", border: "2px solid #000", borderRadius: 16, padding: "28px 24px", maxWidth: 420, width: "100%", textAlign: "center", boxShadow: "none"}}>
            <div style={{ fontSize: 44, marginBottom: 8 }}>💳</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#000", letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 12 }}>
              RECHARGE OF ₹{(activeTotal - bal).toLocaleString("en-IN")} TO CONTINUE
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#6B6B6B", lineHeight: 1.5, marginBottom: 20 }}>
              Cart total ₹{activeTotal.toLocaleString("en-IN")} is more than the wallet balance of ₹{bal.toLocaleString("en-IN")}.
              <br /><br />
              Tap the <span style={{ color: "#23A094", fontWeight: 900 }}>RECHARGE ₹{(activeTotal - bal).toLocaleString("en-IN")}</span> button below to top up the wallet.
            </div>
            <button onClick={() => setOverAck(true)}
              style={{ width: "100%", padding: "16px 14px", borderRadius: 12, fontSize: 17, fontWeight: 900, cursor: "pointer", letterSpacing: 0.5, textTransform: "uppercase",
                background: "#FF90E8", border: "2px solid #000", color: "#000", boxShadow: "none"}}>
              ✓ OK, GOT IT
            </button>
          </div>
        </div>
      )}

      {showVoidBill && (() => {
        const billable = (cv.tabRounds || []).filter((r) => r && (r.status === "activated" || r.status === "served"));
        const refundAmt = billable.reduce((s, r) => s + Number(r.roundTotal || 0), 0);
        // Floor for void slip routing — same logic as handleThermalBill.
        const idUp = (cv.tableId || "").toUpperCase();
        let voidFloor: TabletFloor | null = null;
        if (idUp.startsWith("C")) voidFloor = "ground";
        else if (idUp.startsWith("T")) voidFloor = "rooftop";
        else if (idUp.startsWith("FD") || idUp.startsWith("SMK")) voidFloor = "first";
        return (
          <VoidWalletBillModal
            tableId={cv.tableId || cv.ref || ""}
            customerName={cv.name || ""}
            refundAmount={refundAmt}
            walletBalance={bal}
            onCancel={() => setShowVoidBill(false)}
            onConfirm={async ({ pin, reason, notes }) => {
              const h = await sha256(pin);
              if (h !== BAR_MANAGER_HASH) throw new Error("Wrong Manager PIN.");
              // 1. Refund + void (atomic). Throws on failure → modal shows error.
              const result = await voidWalletBill(cv.id, {
                by: staffName, reason, notes,
                billPrintCount: cv.walletBillPrintCount || 0,
              });
              // 2. Loud BILL VOIDED slip to the floor's bill printer.
              await printBillVoid({
                tableId: cv.tableId || cv.ref || "WALLET",
                floorLabel: cv.floorLabel || "Wallet",
                customerName: cv.name,
                staff: staffName,
                billTotal: result.refundedAmount,
                reason, notes,
                tabletFloor: voidFloor,
              }).catch(() => {});
              // 3. Per-round VOID NOTICE slips to the bar/kitchen printers so
              //    runners see "DO NOT POUR" if drink hasn't left the bar yet.
              //    Best-effort — slip failure must not block the void itself.
              for (const rd of result.voidedRounds) {
                if (!Array.isArray(rd.items) || rd.items.length === 0) continue;
                const valueLost = Number(rd.roundTotal || 0);
                printKOTVoid({
                  tableId: cv.tableId || cv.ref || "WALLET",
                  floorLabel: cv.floorLabel || "Wallet",
                  customerName: cv.name || "",
                  staff: staffName,
                  roundNum: Number((rd as { roundNum?: number }).roundNum || 0),
                  voidedItems: rd.items as HodOrderItem[],
                  valueLost,
                  reason,
                  tabletFloor: voidFloor,
                }).catch(() => {});
              }
              setShowVoidBill(false);
              showToast(`✅ BILL VOIDED — ₹${Math.round(result.refundedAmount)} refunded · New bal ₹${Math.round(result.newBalance)}`);
            }}
          />
        );
      })()}

      {/* 🔴 2026-05-25 (Khushi) — RECHARGE SUCCESS POPUP. Bartender MUST
          click OK to dismiss. Replaces the easy-to-miss toast so the
          bartender (and ideally the customer looking at the tablet) get
          explicit confirmation before moving on to PRINT KOT + BILL. */}
      {rechargeSuccess && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 100000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 18, padding: 22, width: "100%", maxWidth: 360, boxShadow: "none", textAlign: "center" }}>
            <div style={{ fontSize: 44, marginBottom: 6 }}>✅</div>
            <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 900, color: "#23A094", marginBottom: 6, letterSpacing: 0.4 }}>
              RECHARGE SUCCESSFUL
            </div>
            <div style={{ fontSize: 14, color: "#6B6B6B", marginBottom: 4 }}>
              ₹{rechargeSuccess.amount.toLocaleString("en-IN")} added via {rechargeSuccess.method === "cash" ? "💵 CASH" : rechargeSuccess.method === "upi" ? "📱 UPI" : rechargeSuccess.method === "card" ? "💳 CARD" : "🔀 SPLIT"}
            </div>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#000", marginBottom: 18 }}>
              New balance: ₹{rechargeSuccess.newBalance.toLocaleString("en-IN")}
            </div>
            <button onClick={() => { setRechargeSuccess(null); setRechargeOpen(false); }}
              style={{ width: "100%", padding: 14, borderRadius: 10, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 16, fontWeight: 900, letterSpacing: 1, cursor: "pointer", boxShadow: "none"}}>
              OK — continue
            </button>
            <div style={{ fontSize: 10, color: "#6B6B6B", marginTop: 10 }}>
              Then tap 🖨 PRINT KOT + BILL below
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 🆕 2026-05-26 (Khushi) — BAR-SIDE BOOKING PREVIEW MODAL.
// Mirrors Captain Mode's BookingDetailModal feel. When bartender scans a
// table-linked wallet QR (or taps a TABLE WALLET row in search results),
// we FIRST show a compact preview of the booking — table id, floor,
// guest name, party size, arrival time, phone, aggregator badge, list of
// rounds-so-far, wallet balance — so the bartender knows EXACTLY which
// table the wallet belongs to before they start ringing drinks. Then
// 🍸 OPEN WALLET advances to the existing WalletOverlay (cart flow).
//
// FAIL-OPEN: if the reservation can't be fetched (network blip, off-map
// walk-in, pure cover wallet that isn't a table booking), we still show
// the modal with whatever cover fields we have — and OPEN WALLET still
// works. Bartender is NEVER blocked from serving.
// ─────────────────────────────────────────────────────────────────────
function BarBookingPreviewModal({ cover, onCancel, onOpen }: {
  cover: HodCover; onCancel: () => void; onOpen: () => void;
}) {
  const [resv, setResv] = useState<HodTableReservation | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const bid = cover.bookingId || "";
        if (!bid) { if (alive) setLoading(false); return; }
        // 1) Try the deterministic doc id first (covers + reservations share
        // the same coverDocIdFor mapping for table-source bookings).
        const direct = await fsGetDoc(fsDoc(db, "tableReservations", coverDocIdFor(bid)));
        if (direct.exists()) {
          if (alive) { setResv({ _docId: direct.id, ...direct.data() } as HodTableReservation); setLoading(false); }
          return;
        }
        // 2) Fallback: query by bookingRef.
        const q = fsQuery(fsCollection(db, "tableReservations"), fsWhere("bookingRef", "==", bid), fsLimit(1));
        const snap = await fsGetDocs(q);
        if (!snap.empty) {
          const d = snap.docs[0];
          if (alive) { setResv({ _docId: d.id, ...d.data() } as HodTableReservation); setLoading(false); }
          return;
        }
        if (alive) setLoading(false);
      } catch {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [cover.bookingId]);

  const tableId = (resv?.tableId || cover.tableId || cover.ref || "WALLET").toUpperCase();
  const floor = resv?.floorLabel || cover.floorLabel || "";
  const name = resv?.customerName || cover.name || "—";
  const phone = resv?.phone || cover.phone || "";
  const partySize = resv?.partySize || 0;
  const arrival = resv?.arrivalTime || "";
  const source = (resv?.source || "").toLowerCase();
  const aggregator = resv?.aggregator || "";
  const discountPct = resv?.discountPercent || 0;
  const balance = cover.coverBalance || 0;
  const rounds = resv?.tabRounds || cover.tabRounds || [];
  const checkedIn = !!resv?.actualArrivalTime;

  const sourceBadge = (() => {
    if (source === "swiggy-dineout" || aggregator === "swiggy-dineout") return { label: `SWIGGY DINEOUT · ${discountPct || 30}%`, bg: "#E13B36", fg: "#fff" };
    if (source === "zomato" || aggregator === "zomato") return { label: `ZOMATO · ${discountPct || 30}%`, bg: "#CB202D", fg: "#fff" };
    if (source === "eazydiner" || aggregator === "eazydiner") return { label: `EAZYDINER · ${discountPct || 25}%`, bg: "#F7941D", fg: "#fff" };
    if (source === "corporate") return { label: "CORPORATE", bg: "#3B82F6", fg: "#fff" };
    if (source === "walkin" || source === "walk-in") return { label: "WALK-IN", bg: "#6B7280", fg: "#fff" };
    return null;
  })();

  return createPortal(
    <div onClick={onCancel}
      style={{ position: "fixed", inset: 0, background: "rgba(3,3,5,.97)", backdropFilter: "blur(14px) saturate(120%)", WebkitBackdropFilter: "blur(14px) saturate(120%)", zIndex: 9998, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "20px 12px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 540, position: "relative", fontFamily: "'Space Grotesk', sans-serif" }}>
        <button onClick={onCancel}
          style={{ position: "sticky", top: 0, marginLeft: "auto", display: "block", padding: "8px 14px", borderRadius: 8, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 800, cursor: "pointer", marginBottom: 8, letterSpacing: .5, zIndex: 1 }}>
          ✕ CLOSE
        </button>
        <div style={{ boxShadow: "none", borderRadius: 16, background: "#fff", border: "2px solid #000", padding: 20, color: "#000" }}>
          {/* Header row — table id + floor + balance */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, gap: 12 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ fontSize: 32, fontWeight: 900, color: "#000", letterSpacing: 1 }}>{tableId}</div>
                {floor && <div style={{ fontSize: 13, color: "#6B6B6B", fontWeight: 600 }}>{floor}</div>}
                {checkedIn && (
                  <span style={{ fontSize: 11, fontWeight: 800, padding: "4px 10px", borderRadius: 999, background: "#23A094", border: "2px solid #000", color: "#fff" }}>
                    ✓ GUEST ARRIVED
                  </span>
                )}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: balance > 0 ? "#23A094" : "#FF5733" }}>₹{balance.toLocaleString("en-IN")}</div>
              <div style={{ fontSize: 10, color: "#6B6B6B", fontWeight: 700, letterSpacing: .5 }}>WALLET BALANCE</div>
            </div>
          </div>

          {/* Guest name */}
          <div style={{ fontSize: 26, fontWeight: 900, color: "#000", marginBottom: 10, fontFamily: "'Space Grotesk', sans-serif", textTransform: "uppercase", letterSpacing: -.3 }}>{name}</div>

          {/* Meta strip — party, arrival, phone, ref.
              🆕 2026-05-26 (Khushi) — phone + ref promoted to bold gold pills
              so bartender spots them instantly at the well; no duplication. */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12, alignItems: "center" }}>
            {partySize > 0 && <span style={{ fontSize: 13, color: "#6B6B6B" }}>👥 {partySize}p</span>}
            {arrival && <span style={{ fontSize: 13, color: "#6B6B6B" }}>🕘 {arrival}</span>}
            {phone && (
              <span style={{ background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 12, fontWeight: 800, padding: "4px 10px", borderRadius: 8, letterSpacing: .3 }}>
                📱 +91 {phone}
              </span>
            )}
            {cover.ref && (
              <span style={{ background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 12, fontWeight: 800, padding: "4px 10px", borderRadius: 8, fontFamily: "monospace", letterSpacing: .5 }}>
                #{cover.ref}
              </span>
            )}
          </div>

          {/* Source / aggregator badge */}
          {sourceBadge && (
            <div style={{ display: "inline-block", padding: "6px 12px", borderRadius: 8, background: sourceBadge.bg, color: sourceBadge.fg, fontSize: 11, fontWeight: 900, letterSpacing: .8, marginBottom: 14 }}>
              {sourceBadge.label}
            </div>
          )}

          {/* Rounds list */}
          <div style={{ borderTop: "2px solid #000", paddingTop: 12, marginBottom: 14 }}>
            {loading && <div style={{ fontSize: 12, color: "#6B6B6B", textAlign: "center", padding: 12 }}>Loading rounds…</div>}
            {!loading && rounds.length === 0 && (
              <div style={{ fontSize: 12, color: "#6B6B6B", textAlign: "center", padding: 12 }}>No rounds yet — first order of the night.</div>
            )}
            {!loading && rounds.length > 0 && rounds.map((rd, i) => {
              const items: HodOrderItem[] = Array.isArray(rd.items) ? (rd.items as HodOrderItem[]) : [];
              const status = (rd.status || "").toLowerCase();
              const statusColor = status === "served" || status === "activated" ? "#22C55E"
                : status === "preparing" ? "#F59E0B"
                : status === "voided" ? "#EF4444" : "#6B6B6B";
              const statusLabel = status === "served" || status === "activated" ? "✓ SERVED"
                : status === "preparing" ? "🟠 PREPARING"
                : status === "voided" ? "✗ VOIDED" : (status || "—").toUpperCase();
              return (
                <div key={(rd as { id?: string }).id || i} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: "#000" }}>● ROUND {i + 1}</div>
                    <div style={{ fontSize: 11, fontWeight: 800, color: statusColor }}>{statusLabel}</div>
                  </div>
                  {items.map((it, j) => (
                    <div key={j} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#6B6B6B", padding: "2px 4px" }}>
                      <span>{it.qty}× {it.n}</span>
                      <span style={{ color: "#000", fontWeight: 700 }}>₹{Math.round((it.p || 0) * (it.qty || 1)).toLocaleString("en-IN")}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onCancel}
              style={{ flex: 1, padding: "14px 12px", borderRadius: 10, background: "transparent", border: "2px solid #000", color: "#6B6B6B", fontSize: 13, fontWeight: 800, cursor: "pointer", letterSpacing: .5 }}>
              ✕ CANCEL
            </button>
            <button onClick={onOpen}
              style={{ flex: 2, padding: "14px 12px", borderRadius: 10, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900, cursor: "pointer", letterSpacing: .8 }}>
              🍸 OPEN WALLET
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function BarMain({ staffName, onLogout }: { staffName: string; onLogout: () => void }) {
  const [scanning, setScanning] = useState(false);
  // 🆕 2026-05-26 (Khushi big-night batch) — NC + BILL DUE.
  const [ncOpen, setNcOpen] = useState(false);
  // 🆕 v3.114 (Khushi LIVE): in-app modal for no-wallet-found scans (replaces tiny top toast).
  const [noWalletQr, setNoWalletQr] = useState<string | null>(null);
  const [billDueOpen, setBillDueOpen] = useState(false);
  const [billDueRows, setBillDueRows] = useState<BillDueDoc[]>([]);
  useEffect(() => subscribeBillDue(setBillDueRows), []);
  const openBillDueCount = billDueRows.filter((r) => r.status === "open").length;
  const [searchQ, setSearchQ] = useState("");
  const [results, setResults] = useState<HodCover[]>([]);
  const [guestHits, setGuestHits] = useState<HodGuestSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeCover, setActiveCover] = useState<HodCover | null>(null);
  // 🆕 2026-05-26 (Khushi) — Captain-style booking preview FIRST, then wallet.
  const [previewCover, setPreviewCover] = useState<HodCover | null>(null);
  const [toast, setToast] = useState("");
  // 🚶 2026-05-25 (Khushi GO-LIVE) — NEW WALK-IN button busy flag.
  const [walkinBusy, setWalkinBusy] = useState(false);

  // 🍽 2026-05-25 v2 (Khushi safety net) — DASHBOARD-LEVEL food-ready listener.
  // Strip inside an open wallet only fires when bartender is LOOKING at that
  // cover. If wallet is closed → bartender misses it. This badge sits in the
  // header at all times, pulses when ANY bar wallet has food ready, opens a
  // popover with one-tap ✓ PICKED UP per row. 🛟 FALLBACK: failure mode is
  // already covered by captain dashboard Fix C — both screens can clear, so
  // a stuck row is impossible going forward. Filtered to bar covers only
  // (coverDocId present) to avoid showing table reservations the captain owns.
  const [readyKDSBar, setReadyKDSBar] = useState<HodKDSItem[]>([]);
  const [readyPopoverOpen, setReadyPopoverOpen] = useState(false);
  useEffect(() => {
    const unsub = subscribeToReadyKDSItems((all) => {
      setReadyKDSBar(all.filter((it) => !!it.coverDocId));
    });
    return () => unsub();
  }, []);

  // 🆕 2026-05-25 (Khushi STRATEGY C) — DASHBOARD INCOMING CUSTOMER ORDERS.
  // Backstop for orphan/stale wallets: customer site writes preparing rounds
  // with source:'customer_self_order_bar' (or _table). If bartender doesn't
  // have that wallet open AND captain card isn't fresh (e.g. table was
  // released + re-seated), nobody sees the order. This tile subscribes to
  // tonight's covers, filters for ANY cover with a preparing
  // customer_self_order_* round, and surfaces one tappable tile per cover.
  // Tapping opens the wallet — bartender then rings/voids the round as
  // usual via WalletOverlay. The tile auto-disappears when the round flips
  // out of "preparing" (existing activate/void flow handles this).
  // 🆕 2026-05-25 v2 (READ-COST FIX) — switched from subscribeToCoversForNight
  // to subscribeIncomingCustomerOrders. The night-scoped feed was charging
  // reads for ALL covers on every cover update (recharges, KOTs, balance
  // changes) — pushing Firestore reads up by 4-5x. The new helper queries
  // only covers with `hasIncomingCustomerOrder == true` (set by customer
  // site at-bar write, cleared in activateCoverOrder). Typical result set
  // is 0-3 docs, so cost is proportional to actual pending self-orders.
  // 🆕 2026-05-27 v3.104 (Khushi LIVE) — INCOMING CUSTOMER ORDERS tile REMOVED
  // from Bar Mode. Bartender is busy all night and the purple "table for 4"
  // notification was unclickable noise (taps did nothing because the tile only
  // opens the wallet; customer self-orders flow through captain-side activate).
  // Listener killed too so this Bar tablet pays ZERO reads on the
  // hasIncomingCustomerOrder query (was a permanent onSnapshot). Tile JSX
  // below is also gated `false &&` to keep the code archeology intact for
  // future revival if Khushi changes her mind.
  const [incoming] = useState<HodCover[]>([]);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(""), 3000); };

  // 🛡 BUGFIX 2026-05-08: Bar Mode must refuse table bookings (TABLE FOR 4 /
  // VVIP TABLE FOR 6). Those bills run through Captain Mode where GST + 5%
  // service charge is applied at end of night. Bar Mode is pay-and-go for
  // cover wallets only. Reject at every entry point: QR scan + search click.
  //
  // 🆕 2026-05-27 v3.42 (Khushi) — SUPERSEDES the 2026-05-25 "I'M AT THE BAR"
  // exception. With customer-site v3.42 pre-crediting table wallets at booking
  // time (coverActivated = ₹5,000 / ₹15,000 the moment Razorpay clears), every
  // single HODTAB / TBL- / AGG- now has coverActivated > 0 — which would
  // funnel ALL table guests into Bar Mode under the old exception, exactly
  // opposite of the intended "tables = captain-served, single deduction at
  // DONE ORDERING" flow. New rule: tables ALWAYS bounce to captain regardless
  // of activation. The old workaround (cover-on-table for tables without a
  // captain yet) is obsolete now that wallet pre-credit happens at booking.
  // 🆕 2026-06-02 v3.180 (Khushi BUG) — re-introduce the "I'M AT THE BAR"
  // exception, but gated on an EXPLICIT customer choice flag (`atBar`), NOT on
  // coverActivated (the v3.42 trap where pre-credit made EVERY table auto-qualify
  // for bar service). The customer site sets `atBar:true` on the cover ONLY when
  // the guest taps "I'M AT THE BAR". So: tables still bounce to captain by
  // default; a guest who explicitly chose the bar can now be served there.
  const tryOpenCover = (cover: HodCover) => {
    if (cover.isTableBooking && !(cover as any).atBar) {
      showToast("🪑 TABLE BOOKING — ASK CUSTOMER'S CAPTAIN TO TAKE ORDER");
      return;
    }
    // 🆕 2026-05-26 v3.16 (Khushi) — REVERTED the v3.12 preview-first step.
    // Khushi screenshot showed the preview was a dead-end with only an OPEN
    // WALLET button — she wants Captain-style: ONE box with ALL action
    // buttons (ADD ORDER, RECHARGE, SEND MENU, PRINT BILL, SETTLE, RELEASE).
    // The existing WalletOverlay already IS that box. Skip the preview and
    // open the wallet directly on every scan/click.
    setActiveCover(cover);
  };

  const handleQrResult = async (data: string) => {
    setScanning(false);
    let ref = data;
    // 🐛 FIX 2026-05-08: customer-site QRs encode `?verify=REF` (not `?wallet=`/`?ref=`).
    try { const url = new URL(data); ref = url.searchParams.get("verify") || url.searchParams.get("wallet") || url.searchParams.get("ref") || data; } catch {}
    try {
      const cover = await getCoverByRef(ref);
      if (cover) tryOpenCover(cover);
      else setNoWalletQr(ref);
    } catch { setNoWalletQr(ref); }
  };

  const handleSearch = async () => {
    if (!searchQ.trim()) return;
    setSearching(true);
    try {
      // Search covers (drinkable wallets) AND bookings/guestlist (find anyone)
      // in parallel. Guestlist hits without a wallet are surfaced read-only so
      // bartender knows the guest exists and can ask them to top-up at the door.
      // V3 2026-05-11 — scoped to tonight's operational night (12pm→12pm window).
      // Drops EXPIRED wallets (past nights) and bookings for other dates so the
      // bartender doesn't accidentally open a stale wallet from last weekend.
      const tonight = getOperationalNightStr();
      const [covers, guests] = await Promise.all([
        searchCovers(searchQ.trim(), tonight),
        searchBookingsAndGuestlist(searchQ.trim(), tonight),
      ]);
      // 2026-05-15 (Khushi UX) — DO NOT filter out ₹0 balance wallets.
      // Entry-only / "Pay at venue" guests show up with coverBalance:0 until
      // they recharge — bartender MUST be able to find them to top up. Only
      // expired wallets (past nights) are dropped.
      setResults(covers.filter((c) => !c.expiresAt || new Date(c.expiresAt).getTime() >= Date.now()));
      // Hide guest hits that already have a matching cover wallet (by ref)
      // to avoid showing the same person twice.
      const coverRefs = new Set(covers.map((c) => c.ref));
      setGuestHits(guests.filter((g) => !coverRefs.has(g.ref)));
      if (covers.length === 0 && guests.length === 0) showToast("No results found");
    } catch { showToast("Search failed"); }
    setSearching(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: "#fff", color: "#000", fontFamily: "'Space Grotesk', sans-serif" }}>
      {toast && (
        <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", background: "#fff", border: "2px solid #000", borderRadius: 12, padding: "10px 20px", fontSize: 13, fontWeight: 700, color: "#000", zIndex: 99999, fontFamily: "'Space Grotesk', sans-serif" }}>{toast}</div>
      )}

      {/* 🔄 2026-05-25 (Khushi) — WaiterCallBanner removed; bar only sees food-ready KDS popups. */}

      <div style={{ background: "#fff", borderBottom: "2px solid #000", padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Link href="/"
            style={{ padding: "8px 12px", borderRadius: 10, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 12, fontWeight: 900, cursor: "pointer", textDecoration: "none", whiteSpace: "nowrap", letterSpacing: .3 }}>
            ← POS
          </Link>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 16, fontWeight: 900, color: "#000", letterSpacing: 0.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🍸 BAR</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {/* 🍽 2026-05-25 v2 (Khushi) — always-visible food-ready badge.
              Pulses green when ANY bar wallet has food ready. Tap → popover
              with one-tap ✓ PICKED UP per row. Closes the bar-side gap
              where the in-wallet strip is invisible until bartender opens
              that specific wallet. */}
          {readyKDSBar.length > 0 && (
            <button
              onClick={() => setReadyPopoverOpen(true)}
              className="pulse-green"
              title="Food ready from kitchen — tap to view + clear"
              style={{
                padding: "6px 10px", borderRadius: 8,
                background: "#23A094", border: "2px solid #000",
                color: "#23A094", fontSize: 11, fontWeight: 900, cursor: "pointer",
                letterSpacing: 0.4, whiteSpace: "nowrap",
              }}>
              🍽 {readyKDSBar.length} READY
            </button>
          )}
          <span style={{ fontSize: 11, color: "#6B6B6B" }}>👤 {staffName}</span>
          <button onClick={onLogout}
            style={{ padding: "6px 10px", borderRadius: 8, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
            Logout
          </button>
        </div>
      </div>

      {/* 🍽 2026-05-25 v2 (Khushi) — FOOD READY popover. Lists every bar-side
          KDS item with status="ready" across all open bar wallets. Each row
          shows customer name + dish + qty + ✓ PICKED UP. Tap clears just
          that item (or all items for that cover). Audit trail kept (KDS
          doc flips ready → picked_up). 🛟 FALLBACK: write errors are
          swallowed by markKDSPickedUp (already try/catch); popover refreshes
          live so a failed write reappears next snapshot. */}
      {readyPopoverOpen && (
        <div
          onClick={() => setReadyPopoverOpen(false)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,.7)",
            zIndex: 100000, display: "flex", alignItems: "flex-start",
            justifyContent: "center", padding: "60px 16px 16px",
          }}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%", maxWidth: 520, maxHeight: "80vh", overflow: "auto",
              background: "#fff", border: "2px solid #000",
              borderRadius: 16, padding: 16, fontFamily: "'Space Grotesk', sans-serif",
              boxShadow: "none",
            }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 16, fontWeight: 900, color: "#23A094", letterSpacing: 0.5 }}>
                🍽 FOOD READY · {readyKDSBar.length} ITEM{readyKDSBar.length > 1 ? "S" : ""}
              </div>
              <button
                onClick={() => setReadyPopoverOpen(false)}
                style={{ width: 32, height: 32, borderRadius: 8, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 18, cursor: "pointer" }}>×</button>
            </div>
            {readyKDSBar.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: "#6B6B6B", fontSize: 13 }}>
                Nothing ready right now.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {readyKDSBar.map((it) => (
                  <div key={it.id}
                    style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      gap: 10, padding: "10px 12px", borderRadius: 10,
                      background: "#23A094", border: "2px solid #000",
                    }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 900, color: "#000", marginBottom: 2 }}>
                        {it.itemName} ×{it.qty}
                      </div>
                      <div style={{ fontSize: 11, color: "#6B6B6B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {it.customerName || "—"}
                        {it.tableLabel ? ` · ${it.tableLabel}` : ""}
                        {it.staff ? ` · fired by ${it.staff}` : ""}
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        if (it.id) {
                          try { await markKDSPickedUp(it.id, staffName); }
                          catch { showToast("Could not clear — try again"); }
                        }
                      }}
                      style={{
                        background: "#23A094", color: "#000", border: "none",
                        padding: "8px 12px", borderRadius: 8, fontSize: 11, fontWeight: 900,
                        letterSpacing: 0.4, cursor: "pointer", whiteSpace: "nowrap",
                      }}>
                      ✓ PICKED UP
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 12, padding: 10, background: "#F4F4F0", borderRadius: 8, fontSize: 11, color: "#6B6B6B", lineHeight: 1.5 }}>
              🛟 Tip: each tap clears ONE item. If a customer ordered 2 dishes, you'll see 2 rows — pick them up one at a time as they leave the kitchen.
            </div>
          </div>
        </div>
      )}

      <div style={{ padding: 16 }}>
        <button onClick={() => setScanning(true)}
          style={{ width: "100%", padding: 20, borderRadius: 16, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 18, fontWeight: 900, cursor: "pointer", marginBottom: 12 }}>
          📷 Scan Customer QR
        </button>

        {/* 🚶 2026-05-25 (Khushi GO-LIVE) — NEW WALK-IN.
            Customer with no phone / no QR / no booking. One tap → mints a
            zero-balance cover (WALKIN-N, sequence per operational night) and
            opens the menu/order screen. Bartender recharges with cash/UPI/card
            before activating KOT (same flow as a regular wallet). */}
        <button
          onClick={async () => {
            if (walkinBusy) return;
            setWalkinBusy(true);
            try {
              const cv = await createBarWalkinCover(staffName);
              showToast(`✅ ${cv.name} created — add items, then RECHARGE`);
              setActiveCover(cv);
            } catch (e) {
              showToast(`❌ Walk-in failed: ${(e as Error).message || "try again"}`);
            } finally {
              setWalkinBusy(false);
            }
          }}
          disabled={walkinBusy}
          style={{ width: "100%", padding: 18, borderRadius: 16, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 17, fontWeight: 900, cursor: walkinBusy ? "wait" : "pointer", marginBottom: 16, opacity: walkinBusy ? 0.6 : 1 }}>
          {walkinBusy ? "Creating…" : "🚶 + NEW WALK-IN (no phone / no QR)"}
        </button>

        {/* 🆕 2026-05-26 (Khushi big-night batch) — NC + BILL DUE row.
            NC = "No Charge" with auto-cap: first food + first drink lines
            go free, anything beyond is logged as BILL DUE and WhatsApp'd
            to the guest. BILL DUE tab shows tonight's open ledger.
            Manager PIN gates "Mark Cleared" on each row. */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button onClick={() => setNcOpen(true)}
            style={{ flex: 1, padding: 14, borderRadius: 12, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900, letterSpacing: 0.5, cursor: "pointer" }}>
            🎁 NC — DJ / OWNER / PROMOTER
          </button>
          <button onClick={() => setBillDueOpen(true)}
            style={{ flex: 1, padding: 14, borderRadius: 12,
              background: openBillDueCount > 0 ? "#F59E0B" : "#F4F4F0",
              border: "2px solid #000",
              // 🆕 v3.187 (Khushi) — BILL DUE label was light-yellow on amber (unreadable) → BLACK
              color: "#000",
              fontSize: 14, fontWeight: 900, letterSpacing: 0.5, cursor: "pointer" }}>
            💸 BILL DUE ({openBillDueCount})
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Search by name or phone"
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            style={{ flex: 1, padding: "12px 14px", borderRadius: 10, background: "#F4F4F0", border: "2px solid #000", color: "#000", fontSize: 14, outline: "none" }} />
          <button onClick={handleSearch} disabled={searching}
            style={{ padding: "12px 18px", borderRadius: 10, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
            {searching ? "..." : "Search"}
          </button>
        </div>

        {/* 🆕 2026-05-25 (Khushi STRATEGY C) — INCOMING CUSTOMER ORDERS tile.
            Always-on backstop. Surfaces every cover whose customer has just
            placed an order from hodclub.in (bar OR table choice). Bartender
            taps to open the wallet and ring/void as usual. Pulsing border
            so it can't be missed even if bartender is mid-search. */}
        {false && incoming.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 900, color: "#A855F7", marginBottom: 10, letterSpacing: ".6px", textTransform: "uppercase" }}>
              📥 INCOMING CUSTOMER ORDERS · {incoming.length}
            </div>
            {incoming.map((cv) => {
              const preparingRound: any = (cv.tabRounds || []).find((rd: any) => rd && rd.status === 'preparing' && typeof rd.source === 'string' && rd.source.indexOf('customer_self_order') === 0);
              const isBar = preparingRound?.source === 'customer_self_order_bar';
              const items: HodOrderItem[] = (preparingRound?.items as HodOrderItem[]) || [];
              const total = preparingRound?.roundTotal || 0;
              const placedAtMs = preparingRound?.placedAt ? new Date(preparingRound.placedAt).getTime() : 0;
              const ageSec = placedAtMs ? Math.max(0, Math.floor((Date.now() - placedAtMs) / 1000)) : 0;
              const ageLabel = ageSec < 60 ? `${ageSec}s ago` : `${Math.floor(ageSec/60)}m ${ageSec%60}s ago`;
              return (
                <button key={cv.id} onClick={() => tryOpenCover(cv)}
                  className="pulse-green"
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "14px 16px", borderRadius: 12,
                    background: "#fff",
                    border: "2px solid #000",
                    marginBottom: 8, cursor: "pointer",
                    boxShadow: "none"}}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <div style={{ fontSize: 15, fontWeight: 900, color: "#000" }}>{cv.name || cv.ref}</div>
                    <span style={{ fontSize: 10, fontWeight: 900, padding: "3px 8px", borderRadius: 6, background: "#A855F7", color: "#fff", whiteSpace: "nowrap", letterSpacing: ".4px" }}>
                      {isBar ? "🍸 AT BAR" : "🍽 AT TABLE"}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 12, fontSize: 11, color: "#6B6B6B", marginBottom: 6 }}>
                    <span>{cv.ref}</span>
                    <span>{cv.phone}</span>
                    <span style={{ color: "#FF5733", fontWeight: 800 }}>⏱ {ageLabel}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "#6B6B6B", fontWeight: 700 }}>
                    {items.map((it, i) => <span key={i}>{i > 0 ? ", " : ""}{it.qty}× {it.n}</span>)}
                    <span style={{ color: "#000", fontWeight: 900, marginLeft: 8 }}>₹{total}</span>
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 800, color: "#A855F7", marginTop: 6, letterSpacing: ".4px", textTransform: "uppercase" }}>
                    ▸ TAP TO OPEN WALLET & RING IN
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {results.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#6B6B6B", marginBottom: 10 }}>{results.length} result(s)</div>
            {results.map((cv) => {
              // 🔴 2026-05-25 (Khushi GO-LIVE) — Visual differentiation:
              //   • TABLE + ACTIVATED COVER  → gold pill "🍽+🍸 TABLE WALLET", looks live (full opacity).
              //   • TABLE + no cover yet     → purple dashed disabled look + "TABLE → CAPTAIN" pill (unchanged).
              //   • Pure cover wallet        → normal look.
              const tableActivated = !!cv.isTableBooking && (cv.coverActivated || 0) > 0;
              const tableBlocked   = !!cv.isTableBooking && !tableActivated;
              const bg     = tableActivated ? "#FDF0C9"  : tableBlocked ? "#F3E8FF"        : "#fff";
              const border = tableActivated ? "2px solid #000" : tableBlocked ? "2px dashed #A855F7" : "2px solid #000";
              const opacity = tableBlocked ? 0.7 : 1;
              // 🆕 v3.183 (T006) — flag covers whose customer parked an order from
              // hodclub.in (self-order at bar OR "recharge at bar") so the bartender
              // sees it BEFORE opening. Surfaces the preparing round (any customer
              // source: customer_self_order_* or recharge_at_bar). Fail-open: no
              // round → no badge, normal result row.
              const _parked: any = (cv.tabRounds || []).find((rd: any) => rd && rd.status === "preparing" && typeof rd.source === "string" && (rd.source.indexOf("customer_self_order") === 0 || rd.source === "recharge_at_bar"));
              const parkedIsRecharge = _parked?.source === "recharge_at_bar";
              // 🆕 v3.183 (T007) — show the wallet's activation time so the bartender
              // can tell a fresh activation from an old one. lastActivatedAt wins
              // (most recent round), else first activatedAt. Formatted IST.
              const _actIso = cv.lastActivatedAt || cv.activatedAt || "";
              let actTime = "";
              if (_actIso) { const d = new Date(_actIso); if (!isNaN(d.getTime())) actTime = d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }); }
              return (
              <button key={cv.id} onClick={() => tryOpenCover(cv)}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "14px 16px", borderRadius: 12, background: bg, border, marginBottom: 8, cursor: "pointer", opacity }}>
                {/* 🆕 v3.187 (Khushi) — name LEFT, available balance RIGHT in BOLD */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#000", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cv.name}</div>
                  <div style={{ fontSize: 18, fontWeight: 900, color: (cv.coverBalance || 0) > 0 ? "#23A094" : "#FF5733", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>₹{(cv.coverBalance || 0).toLocaleString("en-IN")}</div>
                </div>
                {(_parked || tableActivated || tableBlocked) && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                    {_parked && (
                      <span style={{ fontSize: 10, fontWeight: 900, padding: "3px 7px", borderRadius: 6, background: parkedIsRecharge ? "#00C864" : "#A855F7", color: "#fff", whiteSpace: "nowrap", letterSpacing: ".3px", animation: "hodPulseGold 1.2s infinite" }}>{parkedIsRecharge ? "💳 RECHARGE @ BAR" : "📥 PARKED ORDER"}</span>
                    )}
                    {tableActivated && (
                      <span style={{ fontSize: 10, fontWeight: 800, padding: "3px 7px", borderRadius: 6, background: "#FF90E8", color: "#000", whiteSpace: "nowrap" }}>🍽+🍸 TABLE WALLET</span>
                    )}
                    {tableBlocked && (
                      <span style={{ fontSize: 10, fontWeight: 800, padding: "3px 7px", borderRadius: 6, background: "#A855F7", color: "#fff", whiteSpace: "nowrap" }}>🪑 TABLE → CAPTAIN</span>
                    )}
                  </div>
                )}
                <div style={{ display: "flex", gap: 12, fontSize: 12, color: "#6B6B6B", marginTop: 4, flexWrap: "wrap" }}>
                  <span>{cv.ref}</span>
                  <span>{cv.phone}</span>
                  {actTime && <span style={{ color: "#6B6B6B", fontWeight: 700 }}>⚡ {actTime}</span>}
                </div>
              </button>
              );
            })}
          </div>
        )}

        {/* guests without wallet hidden — bar mode only shows active wallets */}

        {results.length === 0 && guestHits.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "#6B6B6B" }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>📷</div>
            <div style={{ fontSize: 14 }}>Scan a customer QR code or search by name/phone to open their wallet</div>
          </div>
        )}
      </div>

      {scanning && <QrScanner onResult={handleQrResult} onClose={() => setScanning(false)} />}
      {previewCover && !activeCover && (
        <BarBookingPreviewModal
          cover={previewCover}
          onCancel={() => setPreviewCover(null)}
          onOpen={() => { setActiveCover(previewCover); setPreviewCover(null); }}
        />
      )}
      {activeCover && <WalletOverlay key={activeCover.id} cover={activeCover} staffName={staffName} onClose={() => { setActiveCover(null); setResults([]); }} />}
      {ncOpen && <NcModal staffName={staffName} priorRows={billDueRows} onClose={() => setNcOpen(false)} />}

      {/* 🆕 v3.114 (Khushi LIVE): in-app modal for "no wallet found" QR scans.
          Was a tiny top-of-screen toast — bartender misread or missed it.
          Now: centered red-bordered card, clear instruction to activate in
          Door Mode, big dismiss button. Fail-open: scan again any time. */}
      {noWalletQr && (
        <div
          onClick={() => setNoWalletQr(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10003, padding: 24 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 380, width: "100%", background: "#fff", border: "2px solid #000", borderRadius: 18, padding: 28, textAlign: "center", boxShadow: "none"}}
          >
            <div style={{ fontSize: 48, marginBottom: 12 }}>⚠️</div>
            <div style={{ fontSize: 18, fontWeight: 900, color: "#FF5733", marginBottom: 10, letterSpacing: 0.5 }}>
              NO WALLET FOUND
            </div>
            <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 6, fontFamily: "monospace", wordBreak: "break-all" }}>
              QR: {noWalletQr}
            </div>
            <div style={{ fontSize: 15, color: "#000", lineHeight: 1.5, marginBottom: 22, marginTop: 14 }}>
              This QR is <b>not activated yet</b>.<br />
              Please ask the guest to <b style={{ color: "#000" }}>activate at DOOR MODE</b> first, then scan again here.
            </div>
            <button
              onClick={() => setNoWalletQr(null)}
              style={{ width: "100%", padding: 14, borderRadius: 12, background: "#FF90E8", color: "#000", fontSize: 15, fontWeight: 900, letterSpacing: 1, border: "none", cursor: "pointer" }}
            >
              OK, GOT IT
            </button>
          </div>
        </div>
      )}
      {billDueOpen && <BillDueModal rows={billDueRows} staffName={staffName} onClose={() => setBillDueOpen(false)} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 🆕 2026-05-26 (Khushi big-night batch) — NC MODAL.
// Comp 1 food + 1 drink free (house rule). Rest of the items:
//   - print KOT (so kitchen/bar pour everything),
//   - log a BILL DUE ledger row with amountDue = sum of non-free items,
//   - fire a WhatsApp text to the guest with the breakdown.
// Manager PIN is NOT required to open NC (Khushi: VIPs are spontaneous);
// the audit trail comes from billDue + KOT + staff name on the doc.
// FAIL-OPEN: WhatsApp send failure does NOT block the KOT or the
// ledger row — guest still has paper KOT, ledger row will show on the
// BILL DUE tab.
// ─────────────────────────────────────────────────────────────────────
// 🆕 2026-05-27 v3.115 — NC v2 (Khushi LIVE):
// 1) ITEM PICKER reuses the SAME modal layout as ADD ORDER (category tabs,
//    search, qty steppers) — bartender muscle memory unchanged. No more
//    typed name/price/qty boxes (fat-finger risk eliminated).
// 2) COMP RULE NOW PER-UNIT: 1 free DRINK + 1 free FOOD per NC ticket.
//    If guest orders 3× Old Monk → 1 free + 2 charged. Previously the whole
//    line was free regardless of qty — silent revenue leak.
// 3) MANAGER PIN gate ONLY when BILL DUE > ₹0. Clean comps (1+1, due = 0)
//    are friction-free. Fast path for the common case.
// 4) MANAGER added to role dropdown.
// 5) NC ALSO supported via custom typed line (off-menu items like
//    "OWNER's special bottle" still possible) — small button below picker.
function NcModal({ staffName, priorRows, onClose }: { staffName: string; priorRows: BillDueDoc[]; onClose: () => void }) {
  const GOLD = "#FF90E8";
  const GREEN = "#23A094"; // 🆕 v3.188 — ADD + buttons (Khushi: green like the ADD ORDER menu)
  const RED = "#FF5733";   // 🆕 v3.188 — − decrement stepper
  type NcItem = { n: string; p: number; qty: number; t: "food" | "drink" };
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<NcRole>("DJ");
  const [approvedBy, setApprovedBy] = useState("");
  const [lines, setLines] = useState<NcItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Item picker state (mirrors BarMain ADD ORDER overlay — same UX).
  const [showPicker, setShowPicker] = useState(false);
  const [pickSearch, setPickSearch] = useState("");
  const [pickGroup, setPickGroup] = useState<string>(GROUP_ORDER[0] || "spirits");
  // 🔴 v3.115 (architect fix) — lineKey includes `t` so a custom off-menu
  // "WATER" priced ₹50 as DRINK doesn't collide with a "WATER" ₹50 FOOD
  // (would silently merge and corrupt the comp split).
  const lineKey = (n: string, p: number, t: "food" | "drink") => `${n}::${p}::${t}`;
  const lineMap = (() => {
    const m: Record<string, NcItem> = {};
    lines.forEach((l) => { m[lineKey(l.n, l.p, l.t)] = l; });
    return m;
  })();

  const bumpLine = (it: { n: string; p: number; t: "food" | "drink" }, delta: number) => {
    setLines((L) => {
      const key = lineKey(it.n, it.p, it.t);
      const existing = L.find((l) => lineKey(l.n, l.p, l.t) === key);
      if (!existing) {
        if (delta <= 0) return L;
        return [...L, { n: it.n, p: it.p, qty: delta, t: it.t }];
      }
      const nextQty = existing.qty + delta;
      if (nextQty <= 0) return L.filter((l) => lineKey(l.n, l.p, l.t) !== key);
      return L.map((l) => lineKey(l.n, l.p, l.t) === key ? { ...l, qty: nextQty } : l);
    });
  };
  const removeLine = (key: string) => setLines((L) => L.filter((l) => lineKey(l.n, l.p, l.t) !== key));

  // 🆕 v3.184 — FLAT ₹1000 COMP + RUNNING TAB (Khushi). The old per-unit
  // "1 free drink + 1 free food" model is gone. Now every NC guest gets a
  // flat ₹1000 knocked off their WHOLE tab (item mix is irrelevant), and a
  // repeat order is APPENDED to their existing open tab instead of opening a
  // second row — so the ₹1000 spans all their rounds and there are no dupes.
  //   comp        = min(₹1000, gross of all items on the tab)
  //   amountDue   = gross − comp
  // Guest match: phone (10-digit) first, else name+role. Only OPEN rows are
  // appended to; a settled tab starts fresh (new ₹1000).
  const COMP_CAP = 1000;
  const _digits = (s: string) => (s || "").replace(/\D/g, "").slice(-10);
  const phoneKey = _digits(phone);
  const nameKey = name.trim().toLowerCase();
  const existingOpenRow = (priorRows || []).find((r) => {
    if (r.status !== "open") return false;
    if (phoneKey.length >= 10) return _digits(r.customerPhone || "") === phoneKey;
    return nameKey.length > 0 && (r.customerName || "").trim().toLowerCase() === nameKey && r.role === role;
  }) || null;
  const existingItems: NcItem[] = (existingOpenRow?.items || []).map((it) => ({
    n: it.n, p: it.p || 0, qty: it.qty || 0, t: it.t === "food" ? "food" : "drink",
  }));
  const existingTotal = existingItems.reduce((s, it) => s + it.p * it.qty, 0);
  // 🆕 v3.188 (Khushi) — the existing tab's CURRENT amount DUE (after the flat
  // ₹1000 comp), recomputed from its items so it always reconciles with the
  // BILL DUE tab. The old banner showed RUNNING TOTAL = gross (e.g. ₹1,492)
  // which looked wrong next to the tab's net due (e.g. ₹919). Now the banner
  // shows this net due. Any stale stored amountDue self-heals on the next
  // append (appendBillDue rewrites amountDue from the combined items).
  const existingDue = Math.max(0, existingTotal - Math.min(COMP_CAP, existingTotal));
  const newTotal = lines.reduce((s, it) => s + it.p * it.qty, 0);
  const grandTotal = existingTotal + newTotal;
  const compApplied = Math.min(COMP_CAP, grandTotal);
  const amountDue = Math.max(0, grandTotal - compApplied);

  // 🆕 v3.188 (Khushi) — RUNNING TAB: don't make the bartender re-type phone /
  // approved-by for a repeat order. When an open tab is matched, carry its
  // phone + approver into the (otherwise empty) fields. Guarded on empty so it
  // runs once and never clobbers anything the bartender typed.
  useEffect(() => {
    if (!existingOpenRow) return;
    if (!phone && existingOpenRow.customerPhone) setPhone(existingOpenRow.customerPhone);
    if (!approvedBy && existingOpenRow.approvedBy) setApprovedBy(existingOpenRow.approvedBy);
  }, [existingOpenRow, phone, approvedBy]);

  // Picker filter — same normalisation + groups as ADD ORDER.
  const normLocal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const pickerItems = MENU_ITEMS.filter((m) => {
    if (pickSearch) {
      const q = normLocal(pickSearch);
      const groupLabel = (GROUP_LABELS[m.group] || m.group).toLowerCase();
      const hay = normLocal(`${m.name} ${m.category} ${groupLabel}`);
      return hay.includes(q);
    }
    return m.group === pickGroup;
  });
  const pickerGroups = GROUP_ORDER.filter((g) => MENU_ITEMS.some((m) => m.group === g));

  const submit = async () => {
    if (busy) return; // 🔴 v3.115 (architect fix) — hard re-entry guard.
    setErr("");
    if (!name.trim()) { setErr("Guest name required."); return; }
    // 🆕 v3.188 (Khushi) — RUNNING TAB inherits the approver from the open tab,
    // so 'Approved by' is only required when opening a FRESH tab.
    if (!approvedBy.trim() && !existingOpenRow) { setErr("'Approved by' required."); return; }
    if (lines.length === 0) { setErr("Add at least one item."); return; }
    // 🆕 v3.115 — Manager PIN gate ONLY when BILL DUE > 0 (option B). Clean
    // comps (1 drink + 1 food, due = 0) skip the prompt entirely.
    if (amountDue > 0) {
      const pin = await centeredPinPrompt(
        `MANAGER PIN — ₹${amountDue.toLocaleString("en-IN")} will be added to BILL DUE for ${name.trim()} (${role}).`,
        true,
      );
      if (!pin) return;
      const h = await sha256(pin);
      if (h !== BAR_MANAGER_HASH) {
        await centeredAlert("WRONG PIN", "NC NOT LOGGED.", "error", true);
        return;
      }
    }
    setBusy(true);
    try {
      const token = getNextToken();
      const newItemsForDoc: BillDueItem[] = lines.map((it) => ({ n: it.n, p: it.p, qty: it.qty, t: it.t }));
      // 1) KOT — print THIS round's items. Comp is now a flat tab-level
      //    discount, so there's no per-item (COMP) tag to print.
      const kotItems: HodOrderItem[] = lines.map((it) => ({ n: it.n, p: it.p, qty: it.qty, t: it.t, cat: "" }));
      printKOT({
        tableId: "NC", floorLabel: `NC · ${role}`,
        customerName: name.trim(),
        staff: staffName,
        roundNum: 1,
        items: kotItems,
        roundTotal: newTotal,
        token,
      }).catch(() => {});
      // 2) Ledger — APPEND to this guest's open tab, or open a new one. The
      //    ₹1000 comp + amountDue are computed tab-wide (existing + new). The
      //    append runs in a transaction that re-checks status==="open" + the
      //    guest identity; if it lost the race (tab settled / drifted) it
      //    returns ok:false and we open a FRESH row instead (never re-open a
      //    cleared tab, never merge the wrong guest).
      let appended = false;
      let ledgerItems: BillDueItem[] = newItemsForDoc;
      let ledgerDue = amountDue;
      if (existingOpenRow?.id) {
        const res = await appendBillDue(
          existingOpenRow.id,
          newItemsForDoc,
          { phoneKey, nameKey, role },
          COMP_CAP,
        );
        if (res.ok) {
          appended = true;
          ledgerItems = res.combined || newItemsForDoc;
          ledgerDue = typeof res.amountDue === "number" ? res.amountDue : amountDue;
        }
      }
      if (!appended) {
        // Fresh row — comp is computed on THIS round only (existing tab was
        // settled or no longer matches). amountDue here may be ≤ the optimistic
        // figure the PIN approved, which is safe.
        const freshComp = Math.min(COMP_CAP, newTotal);
        const freshDue = Math.max(0, newTotal - freshComp);
        await createBillDue({
          customerName: name.trim(),
          customerPhone: phone.replace(/\D/g, ""),
          role, approvedBy: approvedBy.trim(),
          items: newItemsForDoc,
          amountDue: freshDue,
          compApplied: freshComp,
          staff: staffName,
          token,
        });
        ledgerItems = newItemsForDoc;
        ledgerDue = freshDue;
      }
      if (ledgerDue > 0 && phone.replace(/\D/g, "").length >= 10) {
        sendBillDueWhatsApp(phone, name.trim(), ledgerDue, ledgerItems, token).catch(() => {});
      }
      // 3) Simple confirmation — the ACTUAL amount on the tab after the
      //    append/fresh-row decision (Khushi v3.184).
      await centeredAlert(
        "✅ NC LOGGED",
        `₹${ledgerDue.toLocaleString("en-IN")} DUE`,
        "success",
        true,
      );
      onClose();
    } catch (e: any) {
      // 🔴 v3.116 — surface the actual error via a big in-app alert so the
      // bartender doesn't miss it on a screen full of items (was tiny red
      // inline text → easy to miss → row lost without anyone noticing).
      const msg = e?.message || "Failed to log NC. Try again.";
      setErr(msg);
      await centeredAlert("⚠️ NC NOT LOGGED", msg, "error", true);
    }
    setBusy(false);
  };

  // ── PICKER OVERLAY (same modal style as ADD ORDER) ─────────────────────
  if (showPicker) {
    return createPortal(
      <div style={{ position: "fixed", inset: 0, zIndex: 10001, background: "#fff", display: "flex", flexDirection: "column", fontFamily: "'Space Grotesk',sans-serif" }}>
        <div style={{ padding: "14px 16px 12px", background: "#fff", borderBottom: "2px solid #000", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexShrink: 0 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#000", letterSpacing: 0.4, textTransform: "uppercase", lineHeight: 1.15 }}>🎁 NC — ADD ITEMS</div>
            <div style={{ fontSize: 12, color: "#6B6B6B", fontWeight: 700, marginTop: 4, letterSpacing: 0.3, textTransform: "uppercase" }}>{name || "GUEST"} · {role}{staffName ? ` · ${staffName}` : ""}</div>
          </div>
          <button onClick={() => setShowPicker(false)} aria-label="Close menu"
            style={{ padding: "8px 12px", borderRadius: 10, background: "transparent", border: "2px solid #000", color: "#000", fontSize: 12, fontWeight: 900, cursor: "pointer", letterSpacing: 0.5, flexShrink: 0 }}>× DONE</button>
        </div>
        <div style={{ padding: "10px 16px 0", background: "#fff", flexShrink: 0 }}>
          <input value={pickSearch} onChange={(e) => setPickSearch(e.target.value)} placeholder="Search"
            style={{ width: "100%", padding: "12px 14px", borderRadius: 6, background: "transparent", border: "2px solid #000", color: "#000", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 10, textAlign: "center" }} />
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${pickerGroups.length}, 1fr)`, gap: 6, marginBottom: 8 }}>
            {pickerGroups.map((g) => {
              const active = pickGroup === g;
              return (
                <button key={g} onClick={() => setPickGroup(g)}
                  style={{
                    padding: "14px 6px", borderRadius: 4, fontSize: 12, fontWeight: 800, letterSpacing: 1, cursor: "pointer",
                    background: active ? GOLD : "transparent",
                    color: active ? "#000" : "#000",
                    border: "2px solid #000",
                    textTransform: "uppercase",
                  }}>{GROUP_LABELS[g] || g}</button>
              );
            })}
          </div>
          <div style={{ height: 1, background: "#F4F4F0" }} />
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 16px", background: "#fff" }}>
          {pickerItems.length === 0 && (
            <div style={{ textAlign: "center", padding: 30, color: "#6B6B6B", fontSize: 13 }}>No items found</div>
          )}
          {pickerItems.map((item) => {
            const t: "food" | "drink" = item.group === "food" ? "food" : "drink";
            const existing = lineMap[lineKey(item.name, item.price, t)];
            const qty = existing?.qty || 0;
            const showVeg = item.group === "food";
            return (
              <div key={`${item.id}-${item.category}-${item.name}`}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "2px solid #000"}}>
                <div style={{ flex: 1, paddingRight: 8, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 16, color: "#000", fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.2, lineHeight: 1.25 }}>
                    {showVeg && (
                      <span style={{ display: "inline-block", width: 12, height: 12, border: "2px solid #000", borderRadius: 2, position: "relative", flexShrink: 0 }}>
                        <span style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 5, height: 5, borderRadius: "50%", background: item.isVeg ? "#23A094" : "#dc2626" }} />
                      </span>
                    )}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
                  </div>
                  <div style={{ fontSize: 14, color: "#6B6B6B", marginTop: 4, fontWeight: 700, lineHeight: 1.2 }}>₹{item.price}</div>
                </div>
                {qty === 0 ? (
                  <button onClick={() => bumpLine({ n: item.name, p: item.price, t }, 1)}
                    style={{ padding: "10px 18px", borderRadius: 6, background: GREEN, border: "2px solid #000", color: "#fff", fontSize: 14, fontWeight: 900, letterSpacing: 0.5, cursor: "pointer", flexShrink: 0 }}>ADD +</button>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    <button onClick={() => bumpLine({ n: item.name, p: item.price, t }, -1)}
                      style={{ width: 34, height: 34, borderRadius: 6, background: RED, border: "2px solid #000", color: "#fff", fontSize: 18, fontWeight: 900, cursor: "pointer", padding: 0 }}>−</button>
                    <span style={{ fontSize: 17, fontWeight: 900, color: "#000", minWidth: 22, textAlign: "center" }}>{qty}</span>
                    <button onClick={() => bumpLine({ n: item.name, p: item.price, t }, 1)}
                      style={{ width: 34, height: 34, borderRadius: 6, background: GREEN, border: "2px solid #000", color: "#fff", fontSize: 18, fontWeight: 900, cursor: "pointer", padding: 0 }}>+</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ flexShrink: 0, padding: "10px 14px 18px", background: "#fff", borderTop: "2px solid #000"}}>
          <button onClick={() => setShowPicker(false)}
            style={{ width: "100%", padding: "16px 12px", borderRadius: 12, fontSize: 16, fontWeight: 900, cursor: "pointer", letterSpacing: 0.5, textTransform: "uppercase",
              background: GOLD, border: "2px solid #000", color: "#000" }}>
            ✓ DONE · {lines.reduce((s, l) => s + l.qty, 0)} ITEMS · ₹{amountDue.toLocaleString("en-IN")} DUE
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  // ── REVIEW SCREEN ──────────────────────────────────────────────────────
  return createPortal(
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "relative", width: "100%", maxWidth: 640, maxHeight: "94vh", overflowY: "auto", background: "#fff", border: "2px solid #000", borderRadius: 18, padding: 26, color: "#000" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 18 }}>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#000", letterSpacing: 0.5, textTransform: "uppercase" }}>🎁 NC — NO CHARGE</div>
          <button type="button" onClick={onClose}
            style={{ background: "transparent", border: "2px solid #000", color: "#6B6B6B", fontSize: 11, fontWeight: 800, letterSpacing: 1, padding: "8px 14px", borderRadius: 6, cursor: "pointer" }}>
            ✕ CANCEL
          </button>
        </div>
        {/* 🛡 v3.121 — decoy + form-level autocomplete kill browser "Save password?" prompt */}
        <form autoComplete="off" onSubmit={(e) => e.preventDefault()}>
        <div style={{ position: "absolute", left: -9999, top: -9999, opacity: 0, pointerEvents: "none" }} aria-hidden="true">
          <input type="text" name="username" autoComplete="username" tabIndex={-1} />
          <input type="password" name="password" autoComplete="new-password" tabIndex={-1} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <div>
            <label style={{ display: "block", fontSize: 10.5, fontWeight: 800, color: "#000", letterSpacing: 1.2, marginBottom: 6, textTransform: "uppercase" }}>Guest Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} name="hod-nc-guest" autoComplete="off" data-lpignore="true" data-1p-ignore="" data-form-type="other"
              style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 8, background: "#F4F4F0", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 600 }} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 10.5, fontWeight: 800, color: "#000", letterSpacing: 1.2, marginBottom: 6, textTransform: "uppercase" }}>Phone (10 digits)</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="numeric" name="hod-nc-phone" autoComplete="off" data-lpignore="true" data-1p-ignore="" data-form-type="other"
              style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 8, background: "#F4F4F0", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 600 }} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 10.5, fontWeight: 800, color: "#000", letterSpacing: 1.2, marginBottom: 6, textTransform: "uppercase" }}>Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value as NcRole)} name="hod-nc-role" autoComplete="off"
              style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 8, background: "#F4F4F0", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 700 }}>
              {(["DJ","INFLUENCER","PROMOTER","MANAGER","OWNER","OTHER"] as NcRole[]).map((r) =>
                <option key={r} value={r} style={{ background: "#fff" }}>{r}</option>
              )}
            </select>
          </div>
          <div>
            <label style={{ display: "block", fontSize: 10.5, fontWeight: 800, color: "#000", letterSpacing: 1.2, marginBottom: 6, textTransform: "uppercase" }}>Approved By *</label>
            <input value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} name="hod-nc-approver" autoComplete="off" data-lpignore="true" data-1p-ignore="" data-form-type="other"
              style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 8, background: "#F4F4F0", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 600 }} />
          </div>
        </div>

        {existingOpenRow && (
          // 🆕 v3.188 (Khushi) — TAPPABLE: opens the menu picker straight away
          // (was a dead green box). Shows the tab's CURRENT DUE (net, matches
          // the BILL DUE tab) + the carried-over approver, not the gross total.
          <button type="button" onClick={() => setShowPicker(true)}
            style={{ width: "100%", textAlign: "left", background: "#23A094", border: "2px solid #000", borderRadius: 8, padding: "10px 12px", marginBottom: 10, fontSize: 12, color: "#fff", fontWeight: 700, letterSpacing: 0.3, cursor: "pointer" }}>
            ➕ ADDING TO {((existingOpenRow.customerName || name).trim() || "THIS GUEST").toUpperCase()}'S OPEN TAB · CURRENT DUE ₹{existingDue.toLocaleString("en-IN")}{existingOpenRow.approvedBy ? ` · APPROVED BY ${existingOpenRow.approvedBy.toUpperCase()}` : ""}
            <span style={{ display: "block", marginTop: 5, fontSize: 12, fontWeight: 900, letterSpacing: 0.5 }}>👉 TAP TO ADD ITEMS</span>
          </button>
        )}
        <button type="button" onClick={() => setShowPicker(true)}
          style={{ width: "100%", padding: "14px 12px", borderRadius: 10, marginBottom: 10, background: GOLD, border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900, cursor: "pointer", letterSpacing: 0.5, textTransform: "uppercase" }}>
          + ADD ITEMS FROM MENU
        </button>

        {lines.length > 0 && (
          <div style={{ background: "#F4F4F0", borderRadius: 8, padding: 10, marginBottom: 10 }}>
            {lines.map((it) => {
              const key = lineKey(it.n, it.p, it.t);
              return (
                <div key={key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", fontSize: 13 }}>
                  <span style={{ color: "#000" }}>
                    {it.t === "food" ? "🍴" : "🍸"} {it.qty}× {it.n}
                  </span>
                  <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <span style={{ color: "#000", fontWeight: 800 }}>₹{(it.p * it.qty).toLocaleString("en-IN")}</span>
                    <button onClick={() => removeLine(key)}
                      title="Remove this line"
                      style={{ background: "transparent", border: "none", color: "#FF5733", cursor: "pointer", fontSize: 16 }}>×</button>
                  </span>
                </div>
              );
            })}
            {existingTotal > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", borderTop: "2px solid #000", marginTop: 8, paddingTop: 8, fontSize: 12, color: "#6B6B6B", fontWeight: 700 }}>
                <span>PREVIOUS ON TAB</span><span>₹{existingTotal.toLocaleString("en-IN")}</span>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: existingTotal > 0 ? 4 : 8, paddingTop: existingTotal > 0 ? 0 : 8, borderTop: existingTotal > 0 ? "none" : "2px solid #000", fontSize: 13, color: "#000", fontWeight: 800 }}>
              <span>TOTAL</span><span>₹{grandTotal.toLocaleString("en-IN")}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 12, color: "#23A094", fontWeight: 800 }}>
              <span>🎁 COMP (₹1000 MAX)</span><span>− ₹{compApplied.toLocaleString("en-IN")}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 15, fontWeight: 900 }}>
              <span style={{ color: "#6B6B6B" }}>💸 BILL DUE</span>
              <span style={{ color: amountDue > 0 ? "#F59E0B" : "#23A094" }}>₹{amountDue.toLocaleString("en-IN")}</span>
            </div>
          </div>
        )}

        {err && <div style={{ fontSize: 12, color: "#FF5733", marginBottom: 10 }}>{err}</div>}
        <button type="button" onClick={submit} disabled={busy}
          style={{ width: "100%", padding: "16px 12px", borderRadius: 10, background: GOLD, border: "2px solid #000", color: "#000", fontSize: 15, fontWeight: 900, cursor: busy ? "wait" : "pointer", letterSpacing: 0.6, textTransform: "uppercase" }}>
          {busy ? "LOGGING…" : amountDue > 0 ? "🖨 PRINT NC KOT + LOG (MANAGER PIN)" : "🖨 PRINT NC KOT + LOG"}
        </button>
        </form>

        {/* 🆕 v3.128 — BUSY OVERLAY. Covers the NC modal body during the
            Firestore write so nothing red (BILL DUE ₹, × remove buttons,
            prior-comp banner) can flash between the PIN prompt closing and
            the success popup opening. */}
        {busy && (
          <div style={{
            position: "absolute", inset: 0, background: "#fff", borderRadius: 18,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, zIndex: 5,
          }}>
            <div style={{ width: 44, height: 44, border: "2px solid #000", borderTopColor: "#000", borderRadius: "50%", animation: "ncSpin 0.8s linear infinite" }} />
            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 900, color: "#000", letterSpacing: 0.5 }}>LOGGING NC…</div>
            <div style={{ fontSize: 11, color: "#6B6B6B", letterSpacing: 0.5, textTransform: "uppercase" }}>Printing KOT · writing ledger</div>
            <style>{`@keyframes ncSpin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ─────────────────────────────────────────────────────────────────────
// 🆕 2026-05-26 (Khushi big-night batch) — BILL DUE MODAL.
// Scrolling list of TONIGHT's open NC ledger rows. Each row shows guest
// name, role, amount due, items, and a "MARK CLEARED" button (Manager
// PIN gate). Cleared rows fade to bottom for one night, then drop off
// after operational-night rollover (subscribeBillDue is night-scoped).
// ─────────────────────────────────────────────────────────────────────
function BillDueModal({ rows, staffName, onClose }: { rows: BillDueDoc[]; staffName: string; onClose: () => void }) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // 🔴 v3.117 — clean comps (₹0 due) NEVER need settlement, so they don't
  // belong in BILL DUE at all. Filter them out at the view layer (the
  // ledger row still exists for audit, just not surfaced as "to clear").
  const open = rows.filter((r) => r.status === "open" && (r.amountDue || 0) > 0);
  const cleared = rows.filter((r) => r.status !== "open" && (r.amountDue || 0) > 0);
  const totalOpen = open.reduce((s, r) => s + (r.amountDue || 0), 0);

  // 🆕 v3.120 — GROUP open rows by phone (same guest = one row). Falls
  // back to name+role when phone missing. ONE MARK CLEARED button per
  // guest clears every tab in the group atomically.
  type Group = {
    key: string;
    ids: string[];
    customerName: string;
    customerPhone: string;
    role: NcRole;
    tokens: string[];
    approvedBys: string[];
    staffs: string[];
    items: BillDueItem[];
    amountDue: number;
    totalBill: number;
    compValue: number;
    perRowDue: Record<string, number>;
  };
  const groups: Group[] = (() => {
    const m = new Map<string, Group>();
    for (const r of open) {
      const cleanPhone = (r.customerPhone || "").replace(/\D/g, "");
      const key = cleanPhone.length >= 10 ? cleanPhone : `name:${r.customerName}|${r.role}`;
      let g = m.get(key);
      if (!g) {
        g = { key, ids: [], customerName: r.customerName, customerPhone: r.customerPhone, role: r.role, tokens: [], approvedBys: [], staffs: [], items: [], amountDue: 0, totalBill: 0, compValue: 0, perRowDue: {} };
        m.set(key, g);
      }
      if (r.id) { g.ids.push(r.id); g.perRowDue[r.id] = r.amountDue || 0; }
      if (r.token && !g.tokens.includes(r.token)) g.tokens.push(r.token);
      if (r.approvedBy && !g.approvedBys.includes(r.approvedBy)) g.approvedBys.push(r.approvedBy);
      if (r.staff && !g.staffs.includes(r.staff)) g.staffs.push(r.staff);
      g.items.push(...(r.items || []));
      g.amountDue += r.amountDue || 0;
      // 🆕 v3.124 — totalBill = gross value (if nothing was comped), compValue = freebie value.
      // 🆕 v3.184 — flat tab-level comp (`compApplied`) is authoritative when
      // present; legacy rows fall back to summing per-item `free` line values.
      let rowFreeVal = 0;
      for (const it of (r.items || [])) {
        const lineValue = (it.p || 0) * (it.qty || 0);
        g.totalBill += lineValue;
        if (it.free) rowFreeVal += lineValue;
      }
      g.compValue += (typeof r.compApplied === "number" ? r.compApplied : rowFreeVal);
    }
    return Array.from(m.values());
  })();

  // 🆕 2026-05-27 v3.115 — payment method captured at settlement so the
  // morning Reports tab can split NC RECOVERED (cash/upi/card) vs NC
  // WAIVED (manager wrote off). `pendingClear` holds the group mid-flow.
  // 🆕 v3.120 — discount picker now lives in the inline panel; ≤50 is
  // bartender-only, >50 needs Manager PIN. WAIVE always needs PIN.
  const [pendingClear, setPendingClear] = useState<Group | null>(null);
  const [discPct, setDiscPct] = useState<number>(0);
  const [discInput, setDiscInput] = useState<string>("0");
  // 🆕 v3.126 — two-step settlement: tap a payment method to SELECT it (live
  // highlight), then a single CONFIRM "SETTLE BILL" button triggers the
  // PIN/clear flow. Prevents accidental settles from a stray tap.
  const [selectedMethod, setSelectedMethod] = useState<NcPaymentMethod | null>(null);
  // 🆕 v3.131 — internal two-tab toggle ("OPEN" vs "NC REPORTS / HISTORY")
  // inside this same modal. Khushi wanted the cleared transaction history
  // accessible from inside BILL DUE, not as a separate top-level button.
  const [tab, setTab] = useState<"open" | "history">("open");
  const [expandedClearedId, setExpandedClearedId] = useState<string | null>(null);
  const tsOf = (r: BillDueDoc): number => {
    if (r.clearedAt) { const t = Date.parse(r.clearedAt); if (!isNaN(t)) return t; }
    if (r.createdAt && typeof (r.createdAt as any).seconds === "number") return (r.createdAt as any).seconds * 1000;
    return 0;
  };
  const fmtTime = (r: BillDueDoc): string => {
    const t = tsOf(r);
    return t ? new Date(t).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" }) : "—";
  };
  const allHistory = [...rows].sort((a, b) => tsOf(b) - tsOf(a));
  const clearedAll = allHistory.filter((r) => r.status !== "open");
  // 🔴 v3.131 architect fix — RECOVERED must include legacy cleared rows that
  // were written before paymentMethod was added (v3.114 and earlier). Treat
  // ANY non-waived cleared row as recovered; only paymentMethod === "waived"
  // is genuinely written off.
  const totalRecovered = clearedAll
    .filter((r) => r.paymentMethod !== "waived")
    .reduce((s, r) => s + (typeof r.finalAmount === "number" ? r.finalAmount : (r.amountDue || 0)), 0);
  const totalWaived = clearedAll
    .filter((r) => r.paymentMethod === "waived")
    .reduce((s, r) => s + (r.amountDue || 0), 0);

  const openPanel = (g: Group) => { setPendingClear(g); setDiscPct(0); setDiscInput("0"); setSelectedMethod(null); };
  // 🆕 v3.126 — live discount: typing the % immediately recomputes the breakdown.
  // Empty input → 0%. Clamp to 0–100.
  const onDiscChange = (v: string) => {
    setDiscInput(v);
    const raw = v.trim();
    const n = raw === "" ? 0 : Math.max(0, Math.min(100, parseInt(raw, 10) || 0));
    setDiscPct(n);
  };
  const applyDiscount = () => {
    const n = Math.max(0, Math.min(100, parseInt(discInput, 10) || 0));
    setDiscPct(n);
    setDiscInput(String(n));
  };

  const finalizeClear = async (g: Group, method: NcPaymentMethod) => {
    if (!g.ids.length) return;
    if (busyKey) return; // 🔴 v3.115 (architect fix) — hard re-entry guard.
    const effPct = method === "waived" ? 100 : Math.max(0, Math.min(100, discPct));
    const needPin = method === "waived" || effPct > 50;
    const finalAmt = Math.round(g.amountDue * (1 - effPct / 100));
    const verb = method === "waived" ? "WAIVE" : "SETTLE BILL";
    if (needPin) {
      const reason = method === "waived"
        ? `WRITE-OFF ₹${g.amountDue.toLocaleString("en-IN")} for ${g.customerName}`
        : `${effPct}% DISCOUNT on ₹${g.amountDue.toLocaleString("en-IN")} → collect ₹${finalAmt.toLocaleString("en-IN")} (${method.toUpperCase()}) for ${g.customerName}`;
      const pin = await centeredPinPrompt(`Manager PIN to ${verb}. ${reason}.`, true);
      if (!pin) return;
      const h = await sha256(pin);
      if (h !== BAR_MANAGER_HASH) { await centeredAlert("WRONG PIN", "Bill stays OPEN.", "error", true); return; }
    }
    setBusyKey(g.key);
    setPendingClear(null);
    try {
      for (const id of g.ids) {
        const rowDue = g.perRowDue[id] || 0;
        const rowFinal = Math.round(rowDue * (1 - effPct / 100));
        await clearBillDue(id, staffName, method, effPct, rowFinal);
      }
      const msg = method === "waived"
        ? `${g.customerName} written off by ${staffName} (${g.ids.length} ${g.ids.length === 1 ? "tab" : "tabs"}).`
        : effPct > 0
          ? `${g.customerName} paid ₹${finalAmt.toLocaleString("en-IN")} (${method.toUpperCase()}) · ${effPct}% off`
          : `${g.customerName} paid ₹${finalAmt.toLocaleString("en-IN")} (${method.toUpperCase()}).`;
      await centeredAlert(method === "waived" ? "🕊 WAIVED" : "✅ CLEARED", msg, "success", true);
    } catch (e: any) {
      await centeredAlert("FAILED", e?.message || "Could not settle bill.", "error", true);
    }
    setBusyKey(null);
  };

  // 🔴 v3.117 — DASHBOARD-style fullscreen table (Khushi: "PROPER TABLE
  // INSTEAD OF DIALOGUE BOX … SAME THEME, SAME FONT, NO PURPLE, ONE FOOD
  // ITEM PER ROW, LOOK LIKE A DASHBOARD"). HOD palette: black #030305 +
  // gold #C9A84C, Playfair Display + Space Grotesk. Items render vertically
  // (one per line) inside the ITEMS cell.
  const GOLD = "#FF90E8";
  const RED = "#FF5733";

  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "#fff", color: "#000", display: "flex", flexDirection: "column", fontFamily: "'Space Grotesk', sans-serif" }}>
      {/* HEADER — 🆕 v3.193 (Khushi) Gumroad PINK band + white counter pills + red CLOSE */}
      <div style={{ padding: "18px 24px 14px", borderBottom: "2px solid #000", background: "#FF90E8", display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 900, color: "#000", letterSpacing: 0.5, lineHeight: 1 }}>BILL DUE — TONIGHT</div>
          <div style={{ fontSize: 12, color: "#000", marginTop: 6, letterSpacing: 0.4, textTransform: "uppercase", fontWeight: 700 }}>
            NC tabs awaiting payment · Manager PIN required to clear
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ textAlign: "center", background: "#fff", border: "2px solid #000", borderRadius: 10, padding: "6px 14px" }}>
            <div style={{ fontSize: 10, color: "#6B6B6B", letterSpacing: 1, fontWeight: 700 }}>OPEN</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#000" }}>{open.length}</div>
          </div>
          <div style={{ textAlign: "center", background: "#fff", border: "2px solid #000", borderRadius: 10, padding: "6px 14px" }}>
            <div style={{ fontSize: 10, color: "#6B6B6B", letterSpacing: 1, fontWeight: 700 }}>TOTAL DUE</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: RED }}>₹{totalOpen.toLocaleString("en-IN")}</div>
          </div>
          <button onClick={onClose}
            style={{ marginLeft: 6, padding: "10px 18px", borderRadius: 8, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 12, fontWeight: 900, cursor: "pointer", letterSpacing: 1 }}>
            ✕ CLOSE
          </button>
        </div>
      </div>

      {/* 🆕 v3.131 — INTERNAL TAB STRIP inside the BILL DUE modal. */}
      <div style={{ display: "flex", gap: 8, padding: "10px 24px", background: "#fff", borderBottom: "2px solid #000"}}>
        {([
          { id: "open" as const, label: `🟡 OPEN (${open.length})` },
          { id: "history" as const, label: `📊 CLEARED (${clearedAll.length})` },
        ]).map((t) => {
          const active = tab === t.id;
          return (
            <button key={t.id} type="button" onClick={() => setTab(t.id)}
              style={{
                padding: "8px 18px", borderRadius: 8, fontSize: 12, fontWeight: 900, letterSpacing: 0.8, textTransform: "uppercase",
                background: active ? (t.id === "open" ? "#F2C744" : "#23A094") : "#fff",
                border: "2px solid #000",
                color: active ? (t.id === "open" ? "#000" : "#fff") : "#6B6B6B",
                cursor: "pointer",
              }}>{t.label}</button>
          );
        })}
      </div>

      {/* TABLE */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 24px 24px" }}>
        {tab === "open" && open.length === 0 && (
          <div style={{ textAlign: "center", padding: "80px 20px", color: "#6B6B6B", fontSize: 16, fontStyle: "italic", fontFamily: "'Playfair Display', serif" }}>
            No NC tabs awaiting settlement tonight.
            <div style={{ fontSize: 12, marginTop: 12, fontFamily: "'Space Grotesk', sans-serif", letterSpacing: 0.5, fontStyle: "normal", color: "#6B6B6B" }}>
              Cleared transactions live under the 📊 CLEARED tab above.
            </div>
          </div>
        )}

        {tab === "open" && open.length > 0 && (
          <>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "18px 0 8px" }}>
              <div style={{ fontSize: 11, color: "#000", letterSpacing: 1.5, fontWeight: 800 }}>OPEN — AWAITING SETTLEMENT</div>
              <div style={{ fontSize: 11, color: "#6B6B6B", letterSpacing: 0.5 }}>{open.length} {open.length === 1 ? "tab" : "tabs"}</div>
            </div>
            <div style={{ border: "2px solid #000", borderRadius: 8, overflow: "hidden", background: "#fff" }}>
              {/* 🆕 v3.134 — horizontal scroll on mobile for the OPEN table too.
                  Same pattern as the CLEARED tab — 6 columns don't fit on a
                  phone, so wrap in overflowX:auto + a minWidth on the grid. */}
              <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              <div style={{ minWidth: 820 }}>
              {/* COLUMN HEADERS */}
              <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.7fr 1fr 2.2fr 0.7fr 1.1fr", gap: 14, padding: "12px 16px", background: "#F4F4F0", borderBottom: "2px solid #000", fontSize: 10, fontWeight: 800, color: "#000", letterSpacing: 1.2, whiteSpace: "nowrap" }}>
                <div>GUEST</div>
                <div>ROLE · TOKEN</div>
                <div>APPROVED BY</div>
                <div>ITEMS</div>
                <div style={{ textAlign: "right" }}>DUE</div>
                <div style={{ textAlign: "center" }}>ACTION</div>
              </div>
              {/* ROWS — grouped by guest (phone). 🆕 v3.120 */}
              {groups.map((g, idx) => {
                const isBusy = busyKey === g.key;
                const isPending = pendingClear?.key === g.key;
                const effPct = Math.max(0, Math.min(100, discPct));
                const finalAmt = Math.round(g.amountDue * (1 - effPct / 100));
                return (
                <div key={g.key}>
                  <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.7fr 1fr 2.2fr 0.7fr 1.1fr", gap: 14, padding: "14px 16px", borderTop: "2px solid #000", alignItems: "start" }}>
                    {/* GUEST */}
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 800, color: "#000", letterSpacing: 0.3, textTransform: "uppercase" }}>{g.customerName}</div>
                      <div style={{ fontSize: 11, color: "#6B6B6B", marginTop: 2, fontWeight: 600 }}>{g.customerPhone || "—"}</div>
                      {g.ids.length > 1 && (
                        <div style={{ fontSize: 10, color: "#000", marginTop: 4, fontWeight: 800, letterSpacing: 0.5 }}>{g.ids.length} TABS</div>
                      )}
                    </div>
                    {/* ROLE + TOKEN(S) — 🆕 v3.123 unified lineHeight so baselines match APPROVED BY */}
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 800, color: "#000", letterSpacing: 0.5, lineHeight: 1.2, height: 14 }}>{g.role}</div>
                      <div style={{ fontSize: 11, color: "#6B6B6B", marginTop: 4, fontWeight: 700, lineHeight: 1.2, minHeight: 13 }}>{g.tokens.join(" · ") || ""}</div>
                    </div>
                    {/* APPROVED BY + STAFF */}
                    <div>
                      <div style={{ fontSize: 12, color: "#000", fontWeight: 700, textTransform: "uppercase", lineHeight: 1.2, height: 14 }}>{g.approvedBys.join(" · ") || "—"}</div>
                      <div style={{ fontSize: 11, color: "#6B6B6B", marginTop: 4, letterSpacing: 0.3, lineHeight: 1.2, minHeight: 13 }}>by {g.staffs.join(", ")}</div>
                    </div>
                    {/* ITEMS — one per line, combined across tabs */}
                    <div>
                      {g.items.map((it, i) => (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, color: "#6B6B6B", padding: "2px 0", fontWeight: 700 }}>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {it.qty}× {it.n}
                          </span>
                          <span style={{ flexShrink: 0, color: "#6B6B6B" }}>
                            ₹{((it.p || 0) * (it.qty || 0)).toLocaleString("en-IN")}
                          </span>
                        </div>
                      ))}
                    </div>
                    {/* DUE */}
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 18, fontWeight: 900, color: RED, lineHeight: 1, whiteSpace: "nowrap" }}>
                        ₹{g.amountDue.toLocaleString("en-IN")}
                      </div>
                    </div>
                    {/* ACTION */}
                    <div style={{ textAlign: "center" }}>
                      <button onClick={() => openPanel(g)} disabled={isBusy}
                        style={{ padding: "10px 8px", borderRadius: 6, background: isBusy ? "#F4F4F0" : "#23A094", border: "2px solid #000", color: isBusy ? "#6B6B6B" : "#fff", fontSize: 10.5, fontWeight: 900, cursor: isBusy ? "wait" : "pointer", letterSpacing: 0.6, width: "100%", whiteSpace: "nowrap" }}>
                        {isBusy ? "SETTLING…" : "SETTLE BILL"}
                      </button>
                    </div>
                  </div>
                </div>
              );})}
              </div>
              </div>
            </div>
          </>
        )}

        {tab === "history" && (
          <NcReportsTab
            rows={allHistory}
            clearedAll={clearedAll}
            totalRecovered={totalRecovered}
            totalWaived={totalWaived}
            expandedId={expandedClearedId}
            onToggleExpand={(id) => setExpandedClearedId((prev) => prev === id ? null : id)}
            fmtTime={fmtTime}
            tsOf={tsOf}
          />
        )}

      </div>

      {/* 🆕 v3.124 — SETTLEMENT POPUP MODAL (separate from row, full breakdown) */}
      {pendingClear && (() => {
        const g = pendingClear;
        const effPct = Math.max(0, Math.min(100, discPct));
        const finalAmt = Math.round(g.amountDue * (1 - effPct / 100));
        const discountSaved = g.amountDue - finalAmt;
        return (
          <div onClick={(e) => { e.stopPropagation(); setPendingClear(null); }}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 10001, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
            <div onClick={(e) => e.stopPropagation()}
              style={{ width: "100%", maxWidth: 560, maxHeight: "94vh", overflowY: "auto", background: "#fff", border: "2px solid #000", borderRadius: 18, padding: 26, color: "#000", boxShadow: "none"}}>
              {/* HEADER — 🆕 v3.192 (Khushi) colorful Gumroad header: gold ← BACK
                  (returns to the BILL DUE list) + red ✕ CLOSE on a pink title band. */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 14, background: "#FF90E8", border: "2px solid #000", borderRadius: 12, padding: "10px 12px" }}>
                <button type="button" onClick={() => setPendingClear(null)}
                  style={{ background: "#F2C744", border: "2px solid #000", color: "#000", fontSize: 11, fontWeight: 900, letterSpacing: 1, padding: "8px 12px", borderRadius: 8, cursor: "pointer", flexShrink: 0 }}>← BACK</button>
                <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 900, color: "#000", letterSpacing: 0.5, flex: 1, textAlign: "center" }}>SETTLE BILL</div>
                <button type="button" onClick={() => setPendingClear(null)}
                  style={{ background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 11, fontWeight: 900, letterSpacing: 1, padding: "8px 12px", borderRadius: 8, cursor: "pointer", flexShrink: 0 }}>✕ CLOSE</button>
              </div>
              <div style={{ fontSize: 14, color: "#000", fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.3 }}>{g.customerName} <span style={{ color: "#000", fontWeight: 700 }}>· {g.role}</span></div>
              <div style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 14 }}>{g.customerPhone || "—"} · {g.ids.length} {g.ids.length === 1 ? "TAB" : "TABS"} · APPROVED BY {g.approvedBys.join(" · ") || "—"}</div>

              {/* 🆕 v3.127 — ITEMS ORDERED list so bartender + guest can see exactly what's on the tab before settling. */}
              <div style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 10, padding: "10px 14px", marginBottom: 14, maxHeight: 180, overflowY: "auto" }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: "#000", letterSpacing: 1.2, marginBottom: 6, textTransform: "uppercase" }}>ITEMS ORDERED</div>
                {g.items.length === 0 && <div style={{ fontSize: 11, color: "#6B6B6B", fontStyle: "italic" }}>No items recorded.</div>}
                {g.items.map((it, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 13, color: "#000" }}>
                    <span style={{ fontWeight: 600 }}>{it.qty}× {it.n}</span>
                    <span style={{ fontFamily: "'Space Grotesk', monospace", fontWeight: 700 }}>
                      ₹{((it.p || 0) * (it.qty || 0)).toLocaleString("en-IN")}
                    </span>
                  </div>
                ))}
              </div>

              {/* BREAKDOWN BLOCK */}
              <div style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 10, padding: "14px 16px", marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13, color: "#6B6B6B", fontWeight: 700 }}>
                  <span>TOTAL BILL</span><span style={{ fontFamily: "'Space Grotesk', monospace" }}>₹{g.totalBill.toLocaleString("en-IN")}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13, color: "#23A094", fontWeight: 700 }}>
                  <span>COMP GIVEN</span><span style={{ fontFamily: "'Space Grotesk', monospace" }}>− ₹{g.compValue.toLocaleString("en-IN")}</span>
                </div>
                <div style={{ borderTop: "2px solid #000", margin: "6px 0" }} />
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 14, color: "#000", fontWeight: 800 }}>
                  <span>BILL DUE</span><span style={{ fontFamily: "'Space Grotesk', monospace", color: "#F59E0B" }}>₹{g.amountDue.toLocaleString("en-IN")}</span>
                </div>
                {effPct > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13, color: "#000", fontWeight: 700 }}>
                    <span>DISCOUNT ({effPct}%)</span><span style={{ fontFamily: "'Space Grotesk', monospace" }}>− ₹{discountSaved.toLocaleString("en-IN")}</span>
                  </div>
                )}
                <div style={{ borderTop: "2px solid #000", margin: "8px 0 10px" }} />
                {/* 🆕 v3.192 (Khushi) — COLLECT as a solid GREEN Gumroad block (was plain ink-on-white). */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: "#23A094", border: "2px solid #000", borderRadius: 10 }}>
                  <span style={{ fontSize: 15, color: "#fff", fontWeight: 900, letterSpacing: 0.6, textTransform: "uppercase" }}>COLLECT</span>
                  <span style={{ fontFamily: "'Space Grotesk', monospace", fontSize: 30, fontWeight: 900, color: "#fff" }}>₹{finalAmt.toLocaleString("en-IN")}</span>
                </div>
              </div>

              {/* DISCOUNT INPUT — 🆕 v3.126 live-recompute, no APPLY needed */}
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#000", letterSpacing: 1.2, marginBottom: 8, textTransform: "uppercase" }}>DISCOUNT %</div>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <input type="number" min={0} max={100} value={discInput}
                    onChange={(e) => onDiscChange(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    placeholder="0"
                    style={{ width: 140, padding: "14px 16px", borderRadius: 8, background: "#F4F4F0", border: "2px solid #000", color: "#000", fontSize: 22, fontWeight: 900, textAlign: "center", fontFamily: "'Space Grotesk', monospace" }} />
                  {discPct > 0 && (<div style={{ fontSize: 12, color: "#000", fontWeight: 800, letterSpacing: 0.5 }}>✓ {discPct}% LIVE</div>)}
                  {discPct > 50 && (<div style={{ fontSize: 10, color: "#FACC15", fontWeight: 800, letterSpacing: 0.5 }}>⚠ MANAGER PIN</div>)}
                </div>
              </div>

              {/* PAYMENT METHOD GRID — 🆕 v3.126 select-then-confirm (no auto-clear) */}
              <div style={{ fontSize: 11, fontWeight: 800, color: "#000", letterSpacing: 1.2, marginBottom: 8, textTransform: "uppercase" }}>PAID BY</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
                {(["cash","upi","card","waived"] as NcPaymentMethod[]).map((m) => {
                  const sel = selectedMethod === m;
                  // 🆕 v3.192 (Khushi) — each method gets its own Gumroad color when picked.
                  const mc = m === "cash" ? "#23A094" : m === "upi" ? "#FF90E8" : m === "card" ? "#F2C744" : "#FF5733";
                  const mtext = (m === "cash" || m === "waived") ? "#fff" : "#000";
                  return (
                    <button key={m} type="button" onClick={() => setSelectedMethod(m)}
                      style={{
                        padding: "16px 8px", borderRadius: 8, fontSize: 13, fontWeight: 900, cursor: "pointer", letterSpacing: 1, textTransform: "uppercase",
                        background: sel ? mc : "#fff",
                        border: "2px solid #000",
                        color: sel ? mtext : "#000",
                        boxShadow: "none",
                        transition: "all .15s",
                      }}>{m === "waived" ? "WAIVE" : m}</button>
                  );
                })}
              </div>

              {/* 🆕 v3.126 — SINGLE CONFIRM CTA. Disabled until a method is picked. */}
              <button type="button" disabled={!selectedMethod || !!busyKey}
                onClick={() => selectedMethod && finalizeClear(g, selectedMethod)}
                style={{
                  width: "100%", padding: "18px 16px", borderRadius: 10, fontSize: 16, fontWeight: 900, letterSpacing: 1.4, textTransform: "uppercase",
                  background: selectedMethod ? "#23A094" : "#F4F4F0",
                  border: "2px solid #000",
                  color: selectedMethod ? "#000" : "#6B6B6B",
                  cursor: selectedMethod && !busyKey ? "pointer" : "not-allowed",
                }}>
                {busyKey ? "SETTLING…" : selectedMethod
                  ? `SETTLE BILL · ₹${finalAmt.toLocaleString("en-IN")} · ${selectedMethod === "waived" ? "WAIVE" : selectedMethod.toUpperCase()}`
                  : "SELECT PAYMENT METHOD"}
              </button>
            </div>
          </div>
        );
      })()}
    </div>,
    document.body,
  );
}

// ─────────────────────────────────────────────────────────────────────
// 🆕 v3.131 (2026-05-27) — NC REPORTS as an INTERNAL TAB of BillDueModal.
// Full transaction history of every NC logged during the current
// operational night. Read-only dashboard with expandable rows + CSV
// download. Lives INSIDE the BILL DUE modal so the bartender doesn't
// have to leave/re-enter — toggle pill at the top switches OPEN <-> HISTORY.
// ─────────────────────────────────────────────────────────────────────
function NcReportsTab({
  rows, clearedAll, totalRecovered, totalWaived,
  expandedId, onToggleExpand, fmtTime, tsOf,
}: {
  rows: BillDueDoc[];
  clearedAll: BillDueDoc[];
  totalRecovered: number;
  totalWaived: number;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  fmtTime: (r: BillDueDoc) => string;
  tsOf: (r: BillDueDoc) => number;
}) {
  const GOLD = "#FF90E8";
  void clearedAll;
  const compGiven = rows.reduce((s, r) => {
    const items = (r.items || []) as Array<{ qty?: number; p?: number; price?: number; free?: boolean }>;
    return s + items.filter((it) => it.free).reduce((ss, it) => ss + (it.qty || 0) * (it.p ?? it.price ?? 0), 0);
  }, 0);

  const downloadCsv = () => {
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const cols = ["Time","Status","Guest","Phone","Role","Token","ApprovedBy","LoggedBy","ClearedBy","Method","Items","TotalBill","CompValue","Due","DiscountPct","FinalPaid"];
    const lines = [cols.join(",")];
    for (const r of rows) {
      const items = (r.items || []) as Array<{ qty?: number; n?: string; name?: string; p?: number; price?: number; free?: boolean }>;
      const itemStr = items.map((it) => `${it.qty || 0}x ${it.n ?? it.name ?? ""}${it.free ? " (COMP)" : ""}`).join(" | ");
      const totalBill = items.reduce((s, it) => s + (it.qty || 0) * (it.p ?? it.price ?? 0), 0);
      const compVal = items.filter((it) => it.free).reduce((s, it) => s + (it.qty || 0) * (it.p ?? it.price ?? 0), 0);
      const ts = tsOf(r);
      lines.push([
        ts ? new Date(ts).toISOString() : "",
        r.status === "open" ? "OPEN" : (r.paymentMethod === "waived" ? "WAIVED" : "PAID"),
        r.customerName || "",
        r.customerPhone || "",
        r.role || "",
        r.token || "",
        r.approvedBy || "",
        r.staff || "",
        r.clearedBy || "",
        r.paymentMethod || "",
        itemStr,
        totalBill,
        compVal,
        r.amountDue || 0,
        typeof r.discountPct === "number" ? r.discountPct : "",
        typeof r.finalAmount === "number" ? r.finalAmount : "",
      ].map(esc).join(","));
    }
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `HOD-NC-Reports-${getOperationalNightStr()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const statusBadge = (r: BillDueDoc) => {
    if (r.status === "open") return { label: "OPEN", bg: "rgba(245,158,11,.18)", fg: "#F59E0B", brd: "#F59E0B" };
    if (r.paymentMethod === "waived") return { label: "WAIVED", bg: "rgba(160,160,160,.18)", fg: "#6B6B6B", brd: "#6B6B6B" };
    return { label: "PAID", bg: "rgba(35,160,148,.18)", fg: "#1B7A70", brd: "#23A094" };
  };

  return (
    <>
      {/* KPI strip + CSV button */}
      <div style={{ display: "flex", gap: 12, margin: "18px 0 12px", flexWrap: "wrap", alignItems: "stretch" }}>
        {[
          { l: "LOGGED",      v: String(rows.length),                              c: "#000" },
          { l: "RECOVERED",   v: `₹${totalRecovered.toLocaleString("en-IN")}`,    c: "#23A094" },
          { l: "WAIVED",      v: `₹${totalWaived.toLocaleString("en-IN")}`,       c: "#F59E0B" },
          { l: "COMP GIVEN",  v: `₹${compGiven.toLocaleString("en-IN")}`,         c: GOLD },
        ].map((k) => (
          <div key={k.l} style={{ flex: "1 1 140px", padding: "14px 16px", background: "#fff", border: "2px solid #000", borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: "#6B6B6B", letterSpacing: 1, fontWeight: 800 }}>{k.l}</div>
            <div style={{ fontSize: 26, fontWeight: 900, color: k.c, marginTop: 6, fontFamily: "'Space Grotesk', sans-serif", letterSpacing: 0.3 }}>{k.v}</div>
          </div>
        ))}
        <button onClick={downloadCsv} disabled={!rows.length}
          style={{ padding: "0 22px", borderRadius: 8, background: rows.length ? GOLD : "#FF90E8", border: "none",
            color: "#000", fontSize: 14, fontWeight: 900, letterSpacing: 1, cursor: rows.length ? "pointer" : "not-allowed",
            opacity: rows.length ? 1 : 0.5, whiteSpace: "nowrap" }}>
          ⬇ DOWNLOAD CSV
        </button>
      </div>

      {rows.length === 0 && (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "#6B6B6B", fontSize: 17, fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}>
          No NC tabs logged tonight.
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ border: "2px solid #000", borderRadius: 8, overflow: "hidden", background: "#fff" }}>
          {/* 🆕 v3.133 — horizontal scroll on mobile so all 8 columns are reachable.
              Below ~780px the grid no longer fits; this wrapper keeps the grid
              layout intact and lets the bartender swipe left-right to see
              METHOD + AMOUNT instead of having columns silently cut off. */}
          <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          <div style={{ minWidth: 780 }}>
          {/* COLUMN HEADERS */}
          <div style={{ display: "grid", gridTemplateColumns: "26px 0.7fr 0.5fr 1fr 0.6fr 0.9fr 0.7fr 0.8fr", gap: 10, padding: "14px 16px", background: "#F4F4F0", borderBottom: "2px solid #000", fontSize: 12, fontWeight: 800, color: "#000", letterSpacing: 1.2, whiteSpace: "nowrap" }}>
            <div></div>
            <div>TIME</div>
            <div>STATUS</div>
            <div>GUEST</div>
            <div>ROLE</div>
            <div>HANDLED BY</div>
            <div>METHOD</div>
            <div style={{ textAlign: "right" }}>AMOUNT</div>
          </div>
          {rows.map((r, idx) => {
            const id = r.id || String(idx);
            const isOpen = expandedId === id;
            const badge = statusBadge(r);
            const items = (r.items || []) as Array<{ qty?: number; n?: string; name?: string; p?: number; price?: number; free?: boolean }>;
            const totalBill = items.reduce((s, it) => s + (it.qty || 0) * (it.p ?? it.price ?? 0), 0);
            const showAmt = typeof r.finalAmount === "number" ? r.finalAmount : (r.amountDue || 0);
            const amtColor = r.status === "open" ? "#F59E0B" : (r.paymentMethod === "waived" ? "#6B6B6B" : "#23A094");
            return (
              <div key={id} style={{ borderTop: "2px solid #000"}}>
                <button type="button" onClick={() => onToggleExpand(id)}
                  style={{ width: "100%", display: "grid", gridTemplateColumns: "26px 0.7fr 0.5fr 1fr 0.6fr 0.9fr 0.7fr 0.8fr", gap: 10, padding: "16px 16px", alignItems: "center", background: isOpen ? "#FF90E8" : "transparent", border: "none", color: "#000", textAlign: "left", cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" }}>
                  <div style={{ color: "#000", fontSize: 16, fontWeight: 900 }}>{isOpen ? "▾" : "▸"}</div>
                  <div style={{ fontSize: 13, color: "#6B6B6B", fontWeight: 700 }}>{fmtTime(r)}</div>
                  <div>
                    <span style={{ display: "inline-block", padding: "4px 10px", borderRadius: 4, background: badge.bg, border: `1px solid ${badge.brd}`, color: badge.fg, fontSize: 11, fontWeight: 900, letterSpacing: 0.8 }}>{badge.label}</span>
                  </div>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.3 }}>{r.customerName || "—"}</div>
                    <div style={{ fontSize: 12, color: "#6B6B6B", marginTop: 3, fontWeight: 600 }}>{r.customerPhone || ""}</div>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#000", letterSpacing: 0.4 }}>{r.role || "—"}</div>
                  <div style={{ fontSize: 13, color: "#6B6B6B", fontWeight: 600 }}>
                    {r.clearedBy ? <>cleared: <span style={{ color: "#000", fontWeight: 800 }}>{r.clearedBy}</span></> : <span style={{ color: "#6B6B6B" }}>—</span>}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: r.paymentMethod ? "#000" : "#6B6B6B", textTransform: "uppercase", letterSpacing: 0.6 }}>{r.paymentMethod || "—"}</div>
                  <div style={{ textAlign: "right", fontSize: 18, fontWeight: 900, color: amtColor, fontFamily: "'Space Grotesk', sans-serif", letterSpacing: 0.3 }}>₹{showAmt.toLocaleString("en-IN")}</div>
                </button>
                {isOpen && (
                  <div style={{ padding: "16px 20px 18px 44px", background: "#fff", borderTop: "2px solid #000", display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 28 }}>
                    <div>
                      <div style={{ fontSize: 12, color: "#000", fontWeight: 800, letterSpacing: 1.2, marginBottom: 8 }}>ITEMS</div>
                      {items.length === 0 && <div style={{ fontSize: 14, color: "#6B6B6B" }}>—</div>}
                      {items.map((it, i) => (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "3px 0", color: it.free ? "#000" : "#6B6B6B", fontWeight: it.free ? 600 : 700 }}>
                          <span>{it.qty || 0}× {it.n ?? it.name ?? ""}{it.free ? " · COMP" : ""}</span>
                          <span style={{ color: it.free ? "#000" : "#6B6B6B" }}>{it.free ? "FREE" : `₹${((it.qty || 0) * (it.p ?? it.price ?? 0)).toLocaleString("en-IN")}`}</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: "#000", fontWeight: 800, letterSpacing: 1.2, marginBottom: 8 }}>BREAKDOWN</div>
                      {[
                        ["Token", r.token || "—"],
                        ["Approved by", r.approvedBy || "—"],
                        ["Logged by", r.staff || "—"],
                        ["Total bill", `₹${totalBill.toLocaleString("en-IN")}`],
                        ["Due", `₹${(r.amountDue || 0).toLocaleString("en-IN")}`],
                        ...(typeof r.discountPct === "number" && r.discountPct > 0 ? [["Discount", `${r.discountPct}%`]] : []),
                        ...(typeof r.finalAmount === "number" ? [["Final paid", `₹${r.finalAmount.toLocaleString("en-IN")}`]] : []),
                        ...(r.clearedAt ? [["Cleared at", new Date(r.clearedAt).toLocaleString("en-IN")]] : []),
                      ].map(([k, v], i) => (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "3px 0", color: "#6B6B6B" }}>
                          <span style={{ color: "#6B6B6B", fontWeight: 600 }}>{k}</span>
                          <span style={{ fontWeight: 800 }}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function BarMode() {
  const { isLoggedIn, currentStaff, hasRole, activeMode } = useStaff();
  const [staffName, setStaffName] = useState<string | null>(() => sessionStorage.getItem("hod_bar_staff") || null);

  // 🔴 2026-05-25 (code review fix) — Force local logout when global session
  // clears OR multi-role user switches away from bartender mode.
  useEffect(() => {
    if (!staffName) return;
    const stillBartender = isLoggedIn && currentStaff && hasRole("bartender") && (!activeMode || activeMode === "bartender");
    if (!stillBartender) {
      sessionStorage.removeItem("hod_bar_staff");
      setStaffName(null);
    }
  }, [isLoggedIn, currentStaff, hasRole, activeMode, staffName]);

  if (!staffName) return <BarLogin onLogin={setStaffName} />;
  return <BarMain staffName={staffName} onLogout={() => { sessionStorage.removeItem("hod_bar_staff"); setStaffName(null); }} />;
}
