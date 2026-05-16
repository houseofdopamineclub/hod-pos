import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Link } from "wouter";
import {
  sha256, searchCovers, searchBookingsAndGuestlist, subscribeToCover, rechargeCover, activateCoverOrder,
  logBarSession, printKOT, printBill, recordWalletBillPrint, voidWalletBill, printBillVoid, printKOTVoid,
  recordPendingPaymentScreenshot,
  getCoverByRef, computeHodBreakdown, updatePreparingRoundItems,
  type HodCover, type HodOrderItem, type TabletFloor, type HodGuestSearchHit, type HodTransaction,
} from "@/lib/firestore-hod";
import { getOperationalNightStr } from "@/lib/utils-pos";
import { WaiterCallBanner } from "@/components/WaiterCallBanner";

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
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 460, background: "#0A0A0A", border: "2px solid rgba(239,68,68,.5)", borderRadius: 14, padding: 20, color: "#fff" }}>
        <div style={{ fontSize: 17, fontWeight: 900, color: "#EF4444", marginBottom: 6 }}>🚫 VOID WALLET BILL</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.6)", marginBottom: 10 }}>
          Cancels every activated round on this bill. Use ONLY when the bill must be undone (refused / wrong drink / quality / printer mistake). Audit trail captured.
        </div>
        <div style={{ background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.25)", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.55)", marginBottom: 4 }}>WALLET / CUSTOMER</div>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#F2C744", marginBottom: 8 }}>{tableId || "WALLET"} · {customerName || "—"}</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.55)", marginBottom: 4 }}>BILL AMOUNT TO VOID</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#EF4444" }}>₹{Math.round(refundAmount).toLocaleString("en-IN")}</div>
        </div>
        <label style={{ fontSize: 11, color: "rgba(255,255,255,.6)", marginBottom: 4, display: "block" }}>REASON</label>
        <select value={reason} onChange={(e) => setReason(e.target.value)}
          style={{ width: "100%", padding: "10px 12px", borderRadius: 10, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 13, marginBottom: 12, boxSizing: "border-box" }}>
          {BAR_BILL_VOID_REASONS.map((r) => <option key={r} value={r} style={{ background: "#0A0A0A" }}>{r}</option>)}
        </select>
        <label style={{ fontSize: 11, color: "rgba(255,255,255,.6)", marginBottom: 4, display: "block" }}>
          NOTES {reason === "OTHER" ? "(REQUIRED)" : "(OPTIONAL)"}
        </label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
          placeholder="What happened? (Stored in audit trail.)"
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

interface CartItem {
  n: string;
  p: number;
  qty: number;
  cat: string;
  menuId: string;
  isVeg?: boolean;
  t: "food" | "drink";
}

function BarLogin({ onLogin }: { onLogin: (staff: string) => void }) {
  const [pwd, setPwd] = useState("");
  const [staff, setStaff] = useState("");
  const [error, setError] = useState("");
  const [fails, setFails] = useState(() => parseInt(sessionStorage.getItem("hod_bar_fails") || "0"));
  const [lockUntil, setLockUntil] = useState(() => parseInt(sessionStorage.getItem("hod_bar_lock") || "0"));

  const tryLogin = async () => {
    const currentLock = parseInt(sessionStorage.getItem("hod_bar_lock") || "0");
    if (currentLock > Date.now()) {
      setLockUntil(currentLock);
      setError(`Locked for ${Math.ceil((currentLock - Date.now()) / 60000)} min.`);
      return;
    }
    if (!staff) { setError("Select your name"); return; }
    if (!pwd) { setError("Enter password"); return; }
    const hash = await sha256(pwd + BAR_SALT);
    if (hash === BAR_PIN_HASH) {
      sessionStorage.removeItem("hod_bar_fails");
      sessionStorage.removeItem("hod_bar_lock");
      sessionStorage.setItem("hod_bar_staff", staff);
      logBarSession(staff).catch(() => {});
      onLogin(staff);
    } else {
      const f = fails + 1;
      setFails(f);
      sessionStorage.setItem("hod_bar_fails", String(f));
      if (f >= 5) {
        const lock = Date.now() + 30 * 60 * 1000;
        sessionStorage.setItem("hod_bar_lock", String(lock));
        setError("Too many attempts. Locked for 30 minutes.");
      } else {
        setError(`Wrong password (${5 - f} attempts left)`);
      }
      setPwd("");
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0A0A0A", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 20, padding: "32px 24px", width: "100%", maxWidth: 340, textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🍸</div>
        <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 20, fontWeight: 900, color: "#F2C744", marginBottom: 4 }}>Bar Mode</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginBottom: 20 }}>HOD — House of Dopamine</div>

        <div style={{ fontSize: 11, color: "rgba(255,255,255,.4)", marginBottom: 8, textAlign: "left" }}>Staff</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 20 }}>
          {BAR_STAFF.map((s) => (
            <button key={s} onClick={() => setStaff(s)}
              style={{ padding: "8px 14px", borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer",
                background: staff === s ? "rgba(242,199,68,.15)" : "rgba(255,255,255,.04)",
                border: `1px solid ${staff === s ? "rgba(242,199,68,.5)" : "rgba(255,255,255,.08)"}`,
                color: staff === s ? "#F2C744" : "rgba(255,255,255,.5)" }}>
              {s}
            </button>
          ))}
        </div>

        <input type="password" placeholder="Enter bar password" value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") tryLogin(); }}
          style={{ width: "100%", padding: "12px 16px", borderRadius: 12, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 14, outline: "none", marginBottom: 16, boxSizing: "border-box" }} />

        <button onClick={tryLogin}
          style={{ width: "100%", padding: "14px 0", borderRadius: 12, border: "none", background: "linear-gradient(135deg, #F2C744, #B8951F)", color: "#0A0A0A", fontSize: 15, fontWeight: 800, cursor: "pointer", letterSpacing: 1 }}>
          Enter
        </button>

        {error && <div style={{ fontSize: 12, color: "#EF4444", marginTop: 12 }}>{error}</div>}
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
  const rechargeRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const unsub = subscribeToCover(cover.id, (fresh) => { if (fresh) setCv(fresh); });
    return unsub;
  }, [cover.id]);

  const bal = cv.coverBalance || 0;
  const isExpired = cv.expiresAt ? new Date(cv.expiresAt).getTime() < Date.now() : false;

  // The customer wallet writes new orders into tabRounds[status='preparing'] (current flow).
  // Legacy aggregator flow used cv.pendingOrder. Surface BOTH so bartender always sees the order.
  const _preparing = (cv.tabRounds || []).find((r) => r && r.status === "preparing");
  const preOrderItems: HodOrderItem[] = (_preparing?.items as HodOrderItem[] | undefined) || cv.pendingOrder?.items || [];
  // Tax-inclusive totals so customer-app cart total === bartender screen === wallet debit.
  const preOrderTotal = computeHodBreakdown(preOrderItems).grandTotal;

  const cartItemsForTax: HodOrderItem[] = Object.values(cart).map((c) => ({ n: c.n, p: c.p, qty: c.qty, cat: c.cat, t: c.t }));
  const cartBreakdown = computeHodBreakdown(cartItemsForTax);
  const cartTotal = cartBreakdown.grandTotal;
  const activeTotal = preOrderTotal + cartTotal;
  const hasItems = preOrderItems.length > 0 || Object.keys(cart).length > 0;

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
      if (t.type === "topup" || t.type === "manual_topup") return null;
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
    const amt = parseInt(rcAmt) || 0;
    if (amt < 1) { showToast("Enter a recharge amount"); return; }
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

    // ── 2026-05-11 (Khushi Phase B anti-fraud) — UPI / CARD recharges
    // are now REAL Razorpay-verified transactions. Bartender's tap
    // opens Razorpay Checkout on the tablet, customer pays via their
    // UPI app or by card, and the wallet credits ONLY after server-side
    // signature verification. This closes the "tap-to-credit" hole
    // where a bartender could mark fake UPI/Card payments.
    //
    // CASH and SPLIT remain manual (cash is physical; split is a mixed
    // bag and needs its own UX — pending followup).
    if (rcMethod === "upi" || rcMethod === "card") {
      setRcBusy(true);
      try {
        const { openRazorpayRecharge } = await import("../lib/razorpay-checkout");
        showToast(rcMethod === "upi"
          ? "📱 Opening UPI payment — show tablet to customer"
          : "💳 Opening card payment — swipe customer's card");
        const result = await openRazorpayRecharge({
          amount: amt,
          coverRef: cover.id,
          method: rcMethod,
          customerName: cv.name,
          customerPhone: cv.phone,
        });
        if (result.ok) {
          // Server already credited the wallet & wrote the transaction
          // with serverVerified:true. The Firestore subscription on the
          // cover will refresh balance within ~1 sec — no need to
          // overwrite local state here. We DO update lastRc* for the
          // duplicate-recharge guard.
          setLastRcAmt(amt);
          setLastRcTime(Date.now());
          setRcAmt("");
          setRcAmtTouched(false);
          showToast(
            `✅ ${rcMethod === "upi" ? "UPI" : "CARD"} VERIFIED ₹${amt}` +
            (typeof result.newBalance === "number"
              ? ` — New balance: ₹${result.newBalance}`
              : "")
          );
        } else if (result.reason === "cancelled") {
          showToast("⚠ Customer cancelled — no charge made");
        } else if (result.reason === "verify_failed") {
          // Razorpay charged but our verify endpoint errored. Webhook
          // backstop will credit within 30s. Surface the payment ID so
          // bartender can confirm with customer.
          showToast(
            `⚠ Paid (ID: …${(result.paymentId || "").slice(-8)}) — verify slow, wallet will credit in 30s. Show this ID to customer.`
          );
        } else {
          showToast(`❌ ${result.errorMessage || "Payment failed"}`);
        }
      } catch (e: any) {
        showToast(`❌ Razorpay error: ${e.message || e}`);
      }
      setRcBusy(false);
      return;
    }

    // CASH or SPLIT — original direct-credit path (unchanged).
    setRcBusy(true);
    try {
      const newBal = await rechargeCover(cover.id, amt, rcMethod, staffName, splitArg);
      setCv((prev) => ({ ...prev, coverBalance: newBal }));
      setLastRcAmt(amt);
      setLastRcTime(Date.now());
      setRcAmt("");
      setRcAmtTouched(false); // allow deficit auto-prefill to work again next time
      setRcSplit({ cash: "", upi: "", card: "" });
      showToast(`✅ Recharged ₹${amt} — New balance: ₹${newBal}`);
    } catch (e: any) { showToast(`Error: ${e.message}`); }
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
    // Wallet bills have no aggregator discount — guest already paid the discounted cover.
    const subtotal = allItems.reduce((s, it) => s + (it.p || 0) * (it.qty || 0), 0);
    const scAmt = Math.round(subtotal * 0.10);
    const taxAmt = Math.round(subtotal * 0.05);
    const cgst = Math.round((taxAmt / 2) * 100) / 100;
    const sgst = Math.round((taxAmt / 2) * 100) / 100;
    const finalAmount = subtotal + scAmt + taxAmt;
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
        amounts: { subtotal, serviceCharge: scAmt, cgst, sgst, discount: 0, roundOff: 0, total: finalAmount },
        billNumber: rec.billNumber,
        isDuplicate: rec.isDuplicate,
        tabletFloor: floor,
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
    const breakdown = computeHodBreakdown(allItems);
    const total = breakdown.grandTotal;
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

      printKOT({
        tableId: cv.tableId || cv.ref || "", floorLabel: cv.floorLabel || "",
        customerName: cv.name || "", staff: staffName,
        bookingRef: cv.ref || "", reservationId: cover.id,
        customerPhone: (cv as any).phone || (cv as any).customerPhone || "",
        roundNum: (cv.transactions || []).filter((t) => t.type === "activate").length + 1,
        items: allItems, roundTotal: total,
      }).catch(() => {});

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
          const subtotalB = billItems.reduce((s: number, it: any) => s + (it.p || 0) * (it.qty || 0), 0);
          const scAmtB = Math.round(subtotalB * 0.10);
          const taxAmtB = Math.round(subtotalB * 0.05);
          const cgstB = Math.round((taxAmtB / 2) * 100) / 100;
          const sgstB = Math.round((taxAmtB / 2) * 100) / 100;
          const finalB = subtotalB + scAmtB + taxAmtB;
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
            amounts: { subtotal: subtotalB, serviceCharge: scAmtB, cgst: cgstB, sgst: sgstB, discount: 0, roundOff: 0, total: finalB },
            billNumber: recB.billNumber,
            isDuplicate: recB.isDuplicate,
            tabletFloor: floorB,
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
      } else {
        showToast(msg);
      }
    }
    setActBusy(false);
  };

  if (billDone) {
    const goldBg = billDone.isDuplicate ? "rgba(239,68,68,.5)" : "rgba(242,199,68,.5)";
    const goldFg = billDone.isDuplicate ? "#EF4444" : "#F2C744";
    return (
      <div style={{ position: "fixed", inset: 0, background: "#0A0A0A", zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ background: "rgba(255,255,255,.04)", border: `2px solid ${goldBg}`, borderRadius: 24, padding: "36px 28px", width: "100%", maxWidth: 380, textAlign: "center", boxShadow: `0 8px 40px ${goldBg}` }}>
          <div style={{ fontSize: 56, marginBottom: 12 }}>{billDone.isDuplicate ? "⚠️" : (billDone.withKot ? "🖨✨" : "🖨")}</div>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 900, color: goldFg, marginBottom: 6 }}>
            {billDone.isDuplicate ? "DUPLICATE Bill Printed" : (billDone.withKot ? "KOT + BILL Printed!" : "Bill Printed!")}
          </div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,.6)", marginBottom: 14 }}>{cv.name}</div>
          <div style={{ background: "rgba(0,0,0,.4)", border: `1px dashed ${goldBg}`, borderRadius: 10, padding: "10px 12px", marginBottom: 18, fontFamily: "monospace" }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 4 }}>BILL #</div>
            <div style={{ fontSize: 18, fontWeight: 900, color: goldFg, letterSpacing: 1 }}>{billDone.billNumber}</div>
          </div>
          <div style={{ display: "flex", justifyContent: "center", gap: 24, marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 4 }}>Items</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#fff" }}>{billDone.itemCount}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 4 }}>Total</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: goldFg }}>₹{billDone.total.toLocaleString("en-IN")}</div>
            </div>
          </div>
          {billDone.isDuplicate && (
            <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 14, fontWeight: 700 }}>
              ⚠ Chit will print "DUPLICATE / REPRINT" header.<br/>Do NOT hand a 2nd copy to the guest.
            </div>
          )}
          <button onClick={() => { setBillDone(null); onClose(); }}
            style={{ width: "100%", padding: 14, borderRadius: 12, background: `${goldBg.replace(",.5)", ",.15)")}`, border: `1.5px solid ${goldBg}`, color: goldFg, fontSize: 15, fontWeight: 900, cursor: "pointer" }}>
            ✓ Done — Close Wallet
          </button>
        </div>
      </div>
    );
  }

  if (actDone && actResult) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "#0A0A0A", zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ background: "rgba(255,255,255,.04)", border: "2px solid rgba(0,200,100,.4)", borderRadius: 24, padding: "36px 28px", width: "100%", maxWidth: 380, textAlign: "center", boxShadow: "0 8px 40px rgba(0,200,100,.15)" }}>
          <div style={{ fontSize: 56, marginBottom: 16 }}>✅</div>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 24, fontWeight: 900, color: "#00C864", marginBottom: 8 }}>KOT Printed!</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 4 }}>{cv.name}</div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,.5)", marginBottom: 20, wordBreak: "break-word" }}>{actResult.note}</div>
          <div style={{ display: "flex", justifyContent: "center", gap: 24, marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 4 }}>Deducted</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#EF4444" }}>-₹{actResult.total.toLocaleString("en-IN")}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 4 }}>Remaining</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#00C864" }}>₹{actResult.newBal.toLocaleString("en-IN")}</div>
            </div>
          </div>
          <button onClick={onClose}
            style={{ width: "100%", padding: 14, borderRadius: 12, background: "rgba(0,200,100,.12)", border: "1.5px solid rgba(0,200,100,.3)", color: "#00C864", fontSize: 15, fontWeight: 900, cursor: "pointer", marginBottom: 10 }}>
            ✓ Done
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
    <div style={{ position: "fixed", inset: 0, background: "#0A0A0A", zIndex: 9998, display: "flex", flexDirection: "column", color: "#fff" }}>
      {toast && (
        <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", background: "rgba(20,18,30,.98)", border: "1px solid rgba(242,199,68,.4)", borderRadius: 12, padding: "10px 20px", fontSize: 13, fontWeight: 700, color: "#F2C744", zIndex: 99999, maxWidth: 320 }}>{toast}</div>
      )}

      {/* 2026-05-15 (Khushi UX) — pulse keyframe for low/over balance recharge nudge */}
      <style>{`@keyframes hodPulseRed{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.65);}50%{box-shadow:0 0 0 8px rgba(239,68,68,0);}}@keyframes hodPulseGold{0%,100%{box-shadow:0 0 0 0 rgba(242,199,68,.55);}50%{box-shadow:0 0 0 8px rgba(242,199,68,0);}}`}</style>

      <div style={{ background: "rgba(12,8,22,.98)", borderBottom: "1px solid rgba(242,199,68,.2)", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0, gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 900, color: "#F2C744", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cv.name}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)" }}>{cv.ref} · {cv.tier || "Standard"}{isExpired ? " · EXPIRED" : ""}</div>
        </div>
        {/* 2026-05-15 (Khushi UX) — TOP recharge button. Pulses RED when bal≤0
            or cart exceeds balance; pulses GOLD when bal<100. Tap → opens
            (and scrolls to) the recharge panel below. */}
        {(() => {
          const over = activeTotal > bal;
          const zero = bal <= 0;
          const low = bal < 100 && !zero;
          const healthy = !over && !zero && !low;
          // 2026-05-15 (Khushi UX) — bal in BIG GREEN text when healthy
          // (₹100+ and cart fits). Pulses RED on deficit / zero, GOLD on low.
          const anim = over || zero ? "hodPulseRed 1.2s infinite" : low ? "hodPulseGold 1.6s infinite" : "none";
          const bg = over || zero
            ? "linear-gradient(135deg,#EF4444,#7A1F18)"
            : low
              ? "linear-gradient(135deg,#F2C744,#A07F2E)"
              : "rgba(0,200,100,.10)";
          const border = over || zero
            ? "1.5px solid #EF4444"
            : low
              ? "1.5px solid #F2C744"
              : "1.5px solid rgba(0,200,100,.55)";
          const balColor = healthy ? "#00E676" : (low ? "#000" : "#fff");
          const ctaColor = healthy ? "#F2C744" : (low ? "#000" : "#fff");
          return (
            <button onClick={() => { setRechargeOpen(true); setTimeout(() => rechargeRowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50); }}
              style={{ padding: "6px 14px", borderRadius: 12, background: bg, border, cursor: "pointer", textAlign: "center", lineHeight: 1.1, animation: anim, whiteSpace: "nowrap", boxShadow: healthy ? "0 2px 14px rgba(0,200,100,.18)" : undefined }}>
              <div style={{ fontSize: 16, fontWeight: 900, color: balColor, letterSpacing: 0.3 }}>
                ₹{bal.toLocaleString("en-IN")}
              </div>
              <div style={{ fontSize: 10, fontWeight: 800, color: ctaColor, marginTop: 1, letterSpacing: 0.4 }}>
                {over ? `➕ RECHARGE ₹${activeTotal - bal}` : zero ? "➕ RECHARGE NOW" : "➕ RECHARGE"}
              </div>
            </button>
          );
        })()}
        <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.3)", color: "#EF4444", fontSize: 18, cursor: "pointer", flexShrink: 0 }}>×</button>
      </div>

      {/* V4 2026-05-11 — persistent PENDING TICK badge. Lives on the cover
          header until the webhook tick arrives. Khushi can spot any wallet
          at end-of-night with unverified online recharges and reconcile. */}
      {persistentPendingTicks.length > 0 && (
        <div style={{ background: "rgba(255,200,0,.10)", borderBottom: "1px solid rgba(255,200,0,.35)", padding: "8px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#ffc800" }}>
            🟡 PENDING ✅ TICK — ₹{persistentPendingTotal.toLocaleString("en-IN")} ({persistentPendingTicks.length} online recharge{persistentPendingTicks.length > 1 ? "s" : ""})
          </div>
          <div style={{ fontSize: 10, color: "rgba(255,200,0,.7)", fontStyle: "italic" }}>verify EOD</div>
        </div>
      )}

      {preOrderItems.length > 0 && (
        <div style={{ background: "rgba(255,200,0,.06)", borderBottom: "1px solid rgba(255,200,0,.15)", padding: "10px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#ffc800" }}>📋 Customer Pre-Order — tap −/+ if out of stock</div>
            {editBusy && <div style={{ fontSize: 10, color: "rgba(255,200,0,.6)" }}>Saving…</div>}
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
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
                <div style={{ flex: 1, fontSize: 13, color: "#fff" }}>{it.n}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button onClick={() => adjust(-1)} disabled={editBusy}
                    style={{ width: 26, height: 26, borderRadius: 6, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 14, fontWeight: 700, cursor: editBusy ? "not-allowed" : "pointer" }}>−</button>
                  <span style={{ fontSize: 13, fontWeight: 800, color: "#ffc800", minWidth: 18, textAlign: "center" }}>{it.qty}</span>
                  <button onClick={() => adjust(1)} disabled={editBusy}
                    style={{ width: 26, height: 26, borderRadius: 6, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 14, fontWeight: 700, cursor: editBusy ? "not-allowed" : "pointer" }}>+</button>
                </div>
                <div style={{ minWidth: 56, textAlign: "right", fontSize: 12, fontWeight: 700, color: "#F2C744" }}>₹{it.p * it.qty}</div>
                <button onClick={remove} disabled={editBusy} title="Out of stock — remove"
                  style={{ width: 26, height: 26, borderRadius: 6, background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.3)", color: "#EF4444", fontSize: 12, cursor: editBusy ? "not-allowed" : "pointer" }}>🗑</button>
              </div>
            );
          })}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 800, color: "#ffc800", marginTop: 6 }}>
            <span>Order Total (incl. tax)</span><span>₹{preOrderTotal.toLocaleString("en-IN")}</span>
          </div>
        </div>
      )}

      {/* 🔴 2026-05-13 v3 (Khushi) — Bar Mode menu now mirrors Captain Mode
          1:1: centered search bar with gold border, then 4 BIG tabs
          (FOOD / LIQUOR / NAB / SMOKE) — gold for active, dark red for
          inactive — then a sub-category strip (ALL / SINGLE MALT / etc.)
          underlined in gold for the active one, then a flat item list with
          red ADD+ buttons. Same shape the customer sees on hodclub.in. */}
      <div style={{ padding: "10px 16px 0", background: "#0E0B14", flexShrink: 0 }}>
        <input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder="Search"
          style={{ width: "100%", padding: "12px 14px", borderRadius: 6, background: "transparent", border: "1px solid #F2C744", color: "#fff", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 10, textAlign: "center" }} />
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${menuGroups.length}, 1fr)`, gap: 6, marginBottom: 8 }}>
          {menuGroups.map((g) => {
            const active = activeGroup === g;
            return (
              <button key={g} onClick={() => { setActiveGroup(g); setSubCategory(""); }}
                style={{
                  padding: "14px 6px", borderRadius: 4, fontSize: 12, fontWeight: 800, letterSpacing: 1, cursor: "pointer",
                  background: active ? "#F2C744" : "#7A1F18",
                  color: active ? "#1a1410" : "#F4D7A8",
                  border: "1px solid " + (active ? "#F2C744" : "#5A150F"),
                  textTransform: "uppercase",
                }}>{GROUP_LABELS[g] || g}</button>
            );
          })}
        </div>
        {/* 2026-05-15 (Khushi UX) — sub-category strip removed. Search bar now
            covers ALL groups (FOOD/LIQUOR/NAB/SMOKE) globally — bartender
            doesn't need to switch tabs. Tabs above still work as a quick
            visual filter when not searching. */}
        <div style={{ height: 1, background: "rgba(255,255,255,.05)" }} />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 16px", background: "#0E0B14" }}>
        {(() => {
          const visibleItems = subCategory ? filteredItems.filter((m) => m.category === subCategory) : filteredItems;
          if (visibleItems.length === 0) {
            return <div style={{ textAlign: "center", padding: 30, color: "rgba(255,255,255,.4)", fontSize: 13 }}>No items found</div>;
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
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px dashed rgba(255,255,255,.06)" }}>
                <div style={{ flex: 1, paddingRight: 8, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#fff", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.2, lineHeight: 1.2 }}>
                    {showVeg && (
                      <span style={{ display: "inline-block", width: 10, height: 10, border: `1.5px solid ${item.isVeg ? "#22c55e" : "#dc2626"}`, borderRadius: 2, position: "relative", flexShrink: 0 }}>
                        <span style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 4, height: 4, borderRadius: "50%", background: item.isVeg ? "#22c55e" : "#dc2626" }} />
                      </span>
                    )}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
                  </div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,.5)", marginTop: 1, fontWeight: 600, lineHeight: 1.2 }}>
                    {hasDisc ? (
                      <>
                        <span style={{ textDecoration: "line-through", color: "rgba(255,255,255,.35)", marginRight: 4 }}>₹{item.price.toFixed(0)}</span>
                        <span style={{ color: "#22c55e" }}>₹{eff.toFixed(0)}</span>
                      </>
                    ) : (
                      <>₹{item.price.toFixed(0)}</>
                    )}
                  </div>
                </div>
                {qty === 0 ? (
                  <button onClick={() => addToCart(item)}
                    style={{ padding: "5px 12px", borderRadius: 4, background: "#A02820", border: "none", color: "#fff", fontSize: 11, fontWeight: 800, letterSpacing: 0.3, cursor: "pointer", flexShrink: 0 }}>ADD +</button>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                    <button onClick={() => updateCartQty(item.id, -1)}
                      style={{ width: 24, height: 24, borderRadius: 4, background: "#A02820", border: "none", color: "#fff", fontSize: 14, fontWeight: 800, cursor: "pointer", padding: 0 }}>−</button>
                    <span style={{ fontSize: 13, fontWeight: 900, color: "#F2C744", minWidth: 16, textAlign: "center" }}>{qty}</span>
                    <button onClick={() => updateCartQty(item.id, 1)}
                      style={{ width: 24, height: 24, borderRadius: 4, background: "#A02820", border: "none", color: "#fff", fontSize: 14, fontWeight: 800, cursor: "pointer", padding: 0 }}>+</button>
                  </div>
                )}
              </div>
            );
          });
        })()}
      </div>

      <div style={{ background: "rgba(8,8,18,.96)", borderTop: "1px solid rgba(255,255,255,.08)", padding: "12px 16px 24px", flexShrink: 0, backdropFilter: "blur(8px)" }}>
        {Object.keys(cart).length > 0 && (() => {
          const fmt = (n: number) => `₹${(Math.round(n * 100) / 100).toLocaleString("en-IN", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
          return (
            <div style={{ background: "rgba(242,199,68,.06)", borderRadius: 12, padding: "8px 12px", marginBottom: 10 }}>
              {/* 2026-05-15 (Khushi UX) — every cart item now shows as a chip
                  with × delete. Bartender can wipe a wrong-tap from anywhere
                  without scrolling back up to the menu row. */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {Object.entries(cart).map(([key, it]) => (
                  <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "rgba(242,199,68,.12)", border: "1px solid rgba(242,199,68,.3)", borderRadius: 14, padding: "3px 4px 3px 9px", fontSize: 11, fontWeight: 700, color: "#F2C744" }}>
                    <span>{it.qty}× {it.n} ₹{it.p * it.qty}</span>
                    <button onClick={() => removeFromCart(key)} title="Remove from cart"
                      style={{ width: 18, height: 18, borderRadius: "50%", background: "rgba(239,68,68,.25)", border: "1px solid rgba(239,68,68,.5)", color: "#fff", fontSize: 12, fontWeight: 900, cursor: "pointer", padding: 0, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
                  </span>
                ))}
              </div>
              <details style={{ borderTop: "1px solid rgba(255,255,255,.07)", paddingTop: 5, marginTop: 5 }}>
                <summary style={{ display: "flex", justifyContent: "space-between", alignItems: "center", listStyle: "none", cursor: "pointer" }}>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,.55)", fontStyle: "italic" }}>
                    Inclusive of all taxes <span style={{ opacity: 0.6, fontSize: 9 }}>▾ view breakdown</span>
                  </span>
                  <span style={{ fontSize: 15, fontWeight: 900, color: activeTotal > bal ? "#EF4444" : "#00C864" }}>
                    ₹{activeTotal.toLocaleString("en-IN")}
                    {activeTotal > bal && <span style={{ fontSize: 10 }}> (+₹{activeTotal - bal} over)</span>}
                  </span>
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
                    <span>{Object.values(cart).reduce((s, i) => s + i.qty, 0)} item(s)</span>
                    <span>Total {fmt(cartBreakdown.grandTotal)}</span>
                  </div>
                </div>
              </details>
            </div>
          );
        })()}

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
            style={{ position: "fixed", inset: 0, background: "rgba(3,3,5,.55)", zIndex: 99990, display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: 60, paddingBottom: 20, paddingLeft: 12, paddingRight: 12, backdropFilter: "blur(2px)", overflowY: "auto" }}>
        <div ref={rechargeRowRef} onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 380, maxHeight: "calc(100vh - 80px)", overflowY: "auto", background: "linear-gradient(135deg, rgba(35,28,12,.99), rgba(15,10,5,.99))", border: "1.5px solid rgba(242,199,68,.55)", borderRadius: 14, padding: 14, position: "relative", boxShadow: "0 12px 48px rgba(0,0,0,.7)" }}>
          <button onClick={() => setRechargeOpen(false)} title="Close"
            style={{ position: "absolute", top: 8, right: 10, width: 28, height: 28, borderRadius: 8, background: "rgba(239,68,68,.15)", border: "1px solid rgba(239,68,68,.4)", color: "#EF4444", fontSize: 16, cursor: "pointer", lineHeight: 1, padding: 0, fontWeight: 900 }}>×</button>
          <div style={{ fontSize: 13, fontWeight: 900, color: "#F2C744", marginBottom: 10, paddingRight: 32 }}>
            ➕ RECHARGE WALLET · Bal ₹{bal.toLocaleString("en-IN")}
          </div>
          {/* V3 2026-05-11 — deficit hint banner. Surfaces the EXACT shortfall
              (and the auto-rounded ₹50 recharge suggestion) so the bartender
              can just hit ➕ Recharge. Pulses gold to grab attention. */}
          {deficit > 0 && (() => {
            // 2026-05-15 (Khushi BUG FIX) — banner now truthful. If input
            // matches the exact shortfall, say "pre-filled". Otherwise prompt
            // bartender to tap RESET (no more "pre-filled ₹884" lie next to
            // a stale ₹87 in the input).
            const currentAmt = parseInt(rcAmt) || 0;
            const matches = currentAmt === suggestedRecharge;
            return (
              <div style={{ background: "rgba(239,68,68,.10)", border: "1px solid rgba(239,68,68,.35)", borderRadius: 8, padding: "8px 10px", marginBottom: 8, fontSize: 12, fontWeight: 800, color: "#EF4444", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span>⚠ SHORT ₹{Math.round(deficit).toLocaleString("en-IN")} · {matches ? `pre-filled ₹${suggestedRecharge.toLocaleString("en-IN")}` : `tap RESET → ₹${suggestedRecharge.toLocaleString("en-IN")}`}</span>
                <button onClick={() => { setRcAmt(String(suggestedRecharge)); setRcAmtTouched(false); }}
                  style={{ padding: "4px 8px", borderRadius: 6, background: matches ? "rgba(242,199,68,.15)" : "rgba(242,199,68,.30)", border: "1px solid rgba(242,199,68,.4)", color: "#F2C744", fontSize: 11, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>
                  ↻ RESET
                </button>
              </div>
            );
          })()}
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input type="number" value={rcAmt} onChange={(e) => { setRcAmt(e.target.value); setRcAmtTouched(true); }} placeholder="Recharge amount"
              style={{ flex: 1, background: "rgba(0,0,0,.55)", border: `1px solid ${deficit > 0 ? "rgba(239,68,68,.5)" : "rgba(242,199,68,.35)"}`, borderRadius: 8, padding: "10px 12px", color: "#fff", fontSize: 15, outline: "none", fontWeight: deficit > 0 ? 800 : 400 }} />
            <button onClick={doRecharge} disabled={rcBusy}
              style={{ padding: "10px 16px", borderRadius: 8, background: "linear-gradient(135deg,#F2C744,#A07F2E)", border: "1px solid rgba(242,199,68,.6)", color: "#000", fontSize: 13, fontWeight: 900, cursor: "pointer", whiteSpace: "nowrap", boxShadow: "0 2px 12px rgba(242,199,68,.3)" }}>
              {rcBusy ? "..." : "➕ Recharge"}
            </button>
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
            {[500, 999, 1499, 2000].map((a) => (
              <button key={a} onClick={() => { setRcAmt(String(a)); setRcAmtTouched(true); }}
                style={{ padding: "6px 10px", borderRadius: 7, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "rgba(255,255,255,.5)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                +₹{a}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {(["cash", "upi", "card", "split"] as const).map((m) => {
              // 2026-05-11 (Khushi): Pine Labs Plutus card-machine integration
              // is coming. Until then, "Card" is disabled — bartender uses
              // Cash or UPI (Razorpay-verified). This avoids the awkward
              // "type your card number on the tablet" UX that Razorpay
              // Checkout falls back to without a real terminal.
              const isCardDisabled = m === "card";
              const handleClick = () => {
                if (isCardDisabled) {
                  showToast("💳 Card coming soon — Pine Labs machine integration in progress. Use 📱 UPI or 💵 Cash.");
                  return;
                }
                setRcMethod(m);
              };
              return (
                <button key={m} onClick={handleClick}
                  title={isCardDisabled ? "Pine Labs Plutus machine integration in progress — use UPI or Cash for now" : undefined}
                  style={{ flex: 1, padding: 8, borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: isCardDisabled ? "not-allowed" : "pointer",
                    background: isCardDisabled ? "rgba(255,255,255,.02)" : (rcMethod === m ? "rgba(242,199,68,.12)" : "rgba(255,255,255,.06)"),
                    border: `1px solid ${isCardDisabled ? "rgba(255,255,255,.04)" : (rcMethod === m ? "rgba(242,199,68,.4)" : "rgba(255,255,255,.08)")}`,
                    color: isCardDisabled ? "rgba(255,255,255,.25)" : (rcMethod === m ? "#F2C744" : "rgba(255,255,255,.5)"),
                    opacity: isCardDisabled ? 0.55 : 1,
                    position: "relative" }}>
                  {m === "cash" ? "💵 Cash" : m === "upi" ? "📱 UPI" : m === "card" ? "💳 Card · soon" : "🔀 Split"}
                </button>
              );
            })}
          </div>
          {rcMethod === "split" && (
            <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
              {(["cash", "upi", "card"] as const).map((k) => (
                <div key={k}>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,.4)", textTransform: "uppercase", letterSpacing: .6, marginBottom: 3, textAlign: "center" }}>
                    {k === "cash" ? "💵 Cash" : k === "upi" ? "📱 UPI" : "💳 Card"}
                  </div>
                  <input type="number" value={rcSplit[k]} onChange={(e) => setRcSplit(s => ({ ...s, [k]: e.target.value }))} placeholder="0"
                    style={{ width: "100%", boxSizing: "border-box", background: "rgba(0,0,0,.55)", border: "1px solid rgba(242,199,68,.3)", borderRadius: 7, padding: "7px 8px", color: "#fff", fontSize: 13, textAlign: "center", outline: "none" }} />
                </div>
              ))}
              {(() => {
                const amt = parseInt(rcAmt) || 0;
                const sum = (parseInt(rcSplit.cash) || 0) + (parseInt(rcSplit.upi) || 0) + (parseInt(rcSplit.card) || 0);
                const ok = amt > 0 && sum === amt;
                return (
                  <div style={{ gridColumn: "1 / -1", fontSize: 10, textAlign: "center", marginTop: 2, color: ok ? "#00C864" : "rgba(255,255,255,.5)", fontWeight: 700 }}>
                    Sum: ₹{sum} {amt > 0 && `/ ₹${amt}`} {ok ? "✓" : sum > amt ? "(over)" : ""}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
          </div>,
          document.body
        )}

        {(() => {
          const billableRounds = (cv.tabRounds || []).filter((r) => r && (r.status === "activated" || r.status === "served"));
          const hasPreparing = (cv.tabRounds || []).some((r) => r && r.status === "preparing");
          const printedCount = cv.walletBillPrintCount || 0;
          const lastBillAt = cv.lastWalletBillPrintedAt ? new Date(cv.lastWalletBillPrintedAt).getTime() : 0;
          const cooldownLeft = lastBillAt ? Math.max(0, Math.ceil((WALLET_BILL_DEBOUNCE_MS - (Date.now() - lastBillAt)) / 1000)) : 0;
          const inCooldown = cooldownLeft > 0;
          const canBill = billableRounds.length > 0 && !billBusy && !hasPreparing;
          const billSubtotal = billableRounds.flatMap((r) => r.items || []).reduce((s, it) => s + (it.p || 0) * (it.qty || 0), 0);
          const billTotal = billSubtotal > 0 ? Math.round(billSubtotal * 1.155) : 0;
          // 2026-05-15 (Khushi UX) — hide the "Print Bill (no activated items yet)"
          // disabled placeholder entirely. It only shows once there's something
          // to bill, freeing ~70px on a quiet wallet.
          if (!billableRounds.length && !billBusy && !hasPreparing) return null;
          // 2026-05-15 (Khushi UX) — CASH & CARRY FIX. Bar mode is round-by-round
          // cash-and-carry: customer orders Round 1, bartender prints KOT+BILL,
          // customer pays/leaves; later orders Round 2, prints KOT+BILL AGAIN.
          // That second print is NOT a duplicate — it's a NEW round bill.
          // Only flag as DUPLICATE if there is NO new activated round since
          // the last bill print (i.e. bartender genuinely tapping print twice
          // for the same items).
          const latestActivatedAt = billableRounds.reduce((max, r) => {
            const t = r.activatedAt ? new Date(r.activatedAt).getTime() : 0;
            return t > max ? t : max;
          }, 0);
          const hasNewRoundSinceLastBill = printedCount > 0 && lastBillAt > 0 && latestActivatedAt > lastBillAt;
          const isTrueReprint = printedCount > 0 && !hasNewRoundSinceLastBill;
          const dimAfterPrint = isTrueReprint && !billBusy;
          let label: string;
          if (billBusy) label = "Sending bill...";
          else if (hasPreparing) label = "⏳ Activate pending KOT first";
          else if (!billableRounds.length) label = "Print Bill (no activated items yet)";
          else if (isTrueReprint && inCooldown) label = `✅ Bill #${printedCount} just printed · wait ${cooldownLeft}s`;
          else if (isTrueReprint) label = `⚠ REPRINT SAME BILL (DUPLICATE) — #${printedCount + 1}`;
          else if (hasNewRoundSinceLastBill) label = `🖨 PRINT BILL — ₹${billTotal.toLocaleString("en-IN")} · Round ${printedCount + 1}`;
          else label = `🖨 PRINT BILL — ₹${billTotal.toLocaleString("en-IN")}`;
          const style = !canBill
            ? { background: "rgba(242,199,68,.06)", border: "1px solid rgba(242,199,68,.18)", color: "rgba(242,199,68,.4)", cursor: "not-allowed" as const }
            : dimAfterPrint
              ? { background: "rgba(239,68,68,.08)", border: "1.5px dashed rgba(239,68,68,.55)", color: "#EF4444", cursor: "pointer" as const }
              : { background: "linear-gradient(135deg,#F2C744,#A07F2E)", border: "1px solid rgba(242,199,68,.6)", color: "#000", cursor: "pointer" as const, boxShadow: "0 3px 18px rgba(242,199,68,.28)" };
          return (
            <button onClick={canBill ? handleThermalBill : undefined} disabled={!canBill}
              style={{ width: "100%", padding: 14, marginBottom: 10, borderRadius: 12, fontSize: 14, fontWeight: 900, transition: "all .2s", ...style }}>
              {label}
            </button>
          );
        })()}

        {/* V3 2026-05-11 — VOID BILL (Bar Mode counterpart of Captain's button).
            Shown only after a bill has been printed AND the wallet is not already
            voided. Refunds all activated rounds → wallet balance, prints void
            slip to that floor's bill printer, fires WhatsApp notice to customer. */}
        {(cv.walletBillPrintCount || 0) > 0 && !(cv as unknown as { billVoided?: boolean }).billVoided && (() => {
          const billable = (cv.tabRounds || []).filter((r) => r && (r.status === "activated" || r.status === "served"));
          const refundAmt = billable.reduce((s, r) => s + Number(r.roundTotal || 0), 0);
          if (refundAmt <= 0) return null;
          return (
            <button onClick={() => setShowVoidBill(true)}
              style={{ width: "100%", padding: 12, marginBottom: 10, borderRadius: 12, fontSize: 13, fontWeight: 900,
                background: "rgba(239,68,68,.10)", border: "1.5px solid rgba(239,68,68,.45)", color: "#EF4444", cursor: "pointer", transition: "all .2s" }}>
              🚫 VOID BILL
            </button>
          );
        })()}
        {(cv as unknown as { billVoided?: boolean }).billVoided && (
          <div style={{ width: "100%", padding: 10, marginBottom: 10, borderRadius: 10, background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.3)", color: "#EF4444", fontSize: 12, fontWeight: 800, textAlign: "center" }}>
            🚫 BILL VOIDED
          </div>
        )}

        {/* V4 2026-05-11 — GREEN ✅ verified banner. Shown when the most
            recent online recharge in the last 5 min IS server-verified. Gives
            the bartender positive feedback that the money is real BEFORE they
            tap PRINT KOT (per Khushi's request — turn the button explicitly
            green on verification). Suppressed if there's also a pending tick
            (the warning banner takes priority). */}
        {lastVerifiedOnlineTick && !pendingOnlineTopUp && (
          <div style={{
            marginBottom: 10, padding: "8px 12px", borderRadius: 10,
            background: "rgba(0,200,100,.10)", border: "1.5px solid rgba(0,200,100,.45)",
            color: "#00C864", fontSize: 12, fontWeight: 800, textAlign: "center", lineHeight: 1.5,
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
            background: pendingTickStillBlocking ? "rgba(242,199,68,.10)" : "rgba(245,158,11,.12)",
            border: `1.5px solid ${pendingTickStillBlocking ? "rgba(242,199,68,.5)" : "rgba(245,158,11,.55)"}`,
            color: pendingTickStillBlocking ? "#F2C744" : "#F59E0B",
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

        {/* 2026-05-14 (Khushi UX) — hide both PRINT KOT buttons when cart +
            pre-order are both empty. Frees ~140px of vertical space so the
            items list above can show 4-5 more rows. Buttons reappear the
            instant the bartender adds the first item. */}
        {hasItems && (<>
        {/* 2026-05-14 — COMBINED "PRINT KOT + BILL" button. One-tap shortcut
            for ground-floor cash-and-carry. Same activation guards as
            standard PRINT KOT (balance, expired, pending-tick) — just also
            prints the bill chit immediately after. Shown side-by-side with
            standard PRINT KOT so bartender keeps the choice when running a
            real tab on rooftop / FF. */}
        {/* 2026-05-15 (Khushi UX) — single combined button only. PRINT KOT ONLY
            removed per Khushi: bartenders kept tapping wrong one. One button
            = one decision, faster service. */}
        <button onClick={canActivateFinal ? () => doActivate(true) : undefined} disabled={actBusy || !canActivateFinal}
          style={{ width: "100%", padding: "12px 12px", borderRadius: 10, fontSize: 14, fontWeight: 900, transition: "all .2s",
            ...(canActivateFinal
              ? { background: "linear-gradient(135deg,#F2C744,#A07F2E)", border: "1px solid rgba(242,199,68,.6)", color: "#000", cursor: "pointer", boxShadow: "0 4px 24px rgba(242,199,68,.3)" }
              : tickGateBlocked
                ? { background: "rgba(242,199,68,.10)", border: "1.5px solid rgba(242,199,68,.4)", color: "#F2C744", cursor: "not-allowed" }
                : { background: "rgba(107,107,138,.15)", border: "1px solid rgba(107,107,138,.3)", color: "rgba(107,107,138,.6)", cursor: "not-allowed" }) }}>
          {actBusy ? "Printing KOT + BILL..." :
            blocked ? "✅ Printed — Rescan to refresh" :
            tickGateBlocked ? `⏳ AWAITING ✅ TICK · ${Math.max(0, Math.ceil((PENDING_TICK_FAIL_OPEN_MS - pendingTickAgeMs) / 1000))}s` :
            canActivate ? (lastVerifiedOnlineTick ? "🖨 ✅ PRINT KOT + BILL" : "🖨 PRINT KOT + BILL") :
            activeTotal > bal ? `❌ Recharge ₹${activeTotal - bal} first` :
            !hasItems ? "Select items first" :
            "PRINT KOT + BILL (No Balance)"}
        </button>
        </>)}
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
          <div style={{ background: "rgba(20,18,30,.98)", border: "2px solid rgba(245,158,11,.55)", borderRadius: 20, padding: 22, width: "100%", maxWidth: 380, color: "#fff", boxShadow: "0 8px 40px rgba(245,158,11,.25)" }}>
            <div style={{ fontSize: 28, textAlign: "center", marginBottom: 6 }}>📸</div>
            <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 19, fontWeight: 900, color: "#F59E0B", textAlign: "center", marginBottom: 8 }}>
              COLLECT PAYMENT SCREENSHOT
            </div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,.7)", lineHeight: 1.55, marginBottom: 14, textAlign: "center" }}>
              Customer paid <b style={{ color: "#F59E0B" }}>₹{screenshotPrompt.expectedAmount.toLocaleString("en-IN")}</b> online but our server tick hasn't arrived in 60s.
              <br /><b>Look at the customer's phone.</b> Their UPI app should show ✅ SUCCESS with a reference number. Type that ref below — Khushi will cross-check Razorpay tomorrow morning.
            </div>

            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "rgba(245,158,11,.85)", textTransform: "uppercase", letterSpacing: .8, marginBottom: 4 }}>
                UPI / Bank Reference Number *
              </div>
              <input value={ssUpiRef} onChange={(e) => setSsUpiRef(e.target.value)}
                placeholder="e.g. 412856907321"
                style={{ width: "100%", boxSizing: "border-box", background: "rgba(0,0,0,.55)", border: "1px solid rgba(245,158,11,.45)", borderRadius: 8, padding: "10px 12px", color: "#fff", fontSize: 14, outline: "none", fontWeight: 700 }} />
            </div>

            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "rgba(245,158,11,.85)", textTransform: "uppercase", letterSpacing: .8, marginBottom: 4 }}>
                Customer Phone (verify shown on screen)
              </div>
              <input value={ssPhoneSeen} onChange={(e) => setSsPhoneSeen(e.target.value)}
                placeholder="e.g. 98xxxxxx21"
                style={{ width: "100%", boxSizing: "border-box", background: "rgba(0,0,0,.55)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 8, padding: "10px 12px", color: "#fff", fontSize: 14, outline: "none" }} />
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,.5)", textTransform: "uppercase", letterSpacing: .8, marginBottom: 4 }}>
                Notes (optional — bank name, time, anything odd)
              </div>
              <input value={ssNote} onChange={(e) => setSsNote(e.target.value)}
                placeholder="e.g. HDFC GPay 11:42pm"
                style={{ width: "100%", boxSizing: "border-box", background: "rgba(0,0,0,.55)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 8, padding: "9px 12px", color: "#fff", fontSize: 13, outline: "none" }} />
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
                background: (ssBusy || !ssUpiRef.trim()) ? "rgba(245,158,11,.18)" : "linear-gradient(135deg,#F59E0B,#B45309)",
                border: "1.5px solid rgba(245,158,11,.6)", color: (ssBusy || !ssUpiRef.trim()) ? "rgba(245,158,11,.5)" : "#000" }}>
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
                background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.35)", color: "#EF4444" }}>
              ⚠ Skip — Activate without proof
            </button>

            <button onClick={() => setScreenshotPrompt(null)} disabled={ssBusy}
              style={{ width: "100%", padding: 10, borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: ssBusy ? "not-allowed" : "pointer",
                background: "transparent", border: "1px solid rgba(255,255,255,.15)", color: "rgba(255,255,255,.6)" }}>
              ← Cancel (don't activate)
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
    </div>
  );
}

function BarMain({ staffName, onLogout }: { staffName: string; onLogout: () => void }) {
  const [scanning, setScanning] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [results, setResults] = useState<HodCover[]>([]);
  const [guestHits, setGuestHits] = useState<HodGuestSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeCover, setActiveCover] = useState<HodCover | null>(null);
  const [toast, setToast] = useState("");

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(""), 3000); };

  // 🛡 BUGFIX 2026-05-08: Bar Mode must refuse table bookings (TABLE FOR 4 /
  // VVIP TABLE FOR 6). Those bills run through Captain Mode where GST + 5%
  // service charge is applied at end of night. Bar Mode is pay-and-go for
  // cover wallets only. Reject at every entry point: QR scan + search click.
  const tryOpenCover = (cover: HodCover) => {
    if (cover.isTableBooking) {
      showToast("🪑 Table booking — open in Captain Mode (tax + service charge applies). Bar Mode is for cover wallets only.");
      return;
    }
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
      else showToast("No wallet found for this QR code");
    } catch { showToast("Error looking up QR code"); }
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
    <div style={{ minHeight: "100vh", background: "#0A0A0A", color: "#fff", fontFamily: "'Space Grotesk', sans-serif" }}>
      {toast && (
        <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", background: "rgba(10,10,10,.98)", border: "1px solid rgba(242,199,68,.4)", borderRadius: 12, padding: "10px 20px", fontSize: 13, fontWeight: 700, color: "#F2C744", zIndex: 99999, fontFamily: "'Space Grotesk', sans-serif" }}>{toast}</div>
      )}

      <WaiterCallBanner staffName={staffName} role="bar" />

      <div style={{ background: "rgba(10,10,10,.98)", borderBottom: "1px solid rgba(242,199,68,.25)", padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Link href="/"
            style={{ padding: "8px 12px", borderRadius: 10, background: "#F2C744", border: "1.5px solid #F2C744", color: "#0A0A0A", fontSize: 12, fontWeight: 900, cursor: "pointer", textDecoration: "none", whiteSpace: "nowrap", letterSpacing: .3 }}>
            ← POS
          </Link>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 16, fontWeight: 900, color: "#F2C744", letterSpacing: 0.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🍸 BAR</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,.4)" }}>👤 {staffName}</span>
          <button onClick={onLogout}
            style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.3)", color: "#EF4444", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
            Logout
          </button>
        </div>
      </div>

      <div style={{ padding: 16 }}>
        <button onClick={() => setScanning(true)}
          style={{ width: "100%", padding: 20, borderRadius: 16, background: "linear-gradient(135deg,rgba(242,199,68,.15),rgba(242,199,68,.05))", border: "2px solid rgba(242,199,68,.4)", color: "#F2C744", fontSize: 18, fontWeight: 900, cursor: "pointer", marginBottom: 16 }}>
          📷 Scan Customer QR
        </button>

        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Search by name or phone"
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            style={{ flex: 1, padding: "12px 14px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 14, outline: "none" }} />
          <button onClick={handleSearch} disabled={searching}
            style={{ padding: "12px 18px", borderRadius: 10, background: "rgba(242,199,68,.12)", border: "1px solid rgba(242,199,68,.3)", color: "#F2C744", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
            {searching ? "..." : "Search"}
          </button>
        </div>

        {results.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, color: "rgba(255,255,255,.5)", marginBottom: 10 }}>{results.length} result(s)</div>
            {results.map((cv) => (
              <button key={cv.id} onClick={() => tryOpenCover(cv)}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "14px 16px", borderRadius: 12, background: cv.isTableBooking ? "rgba(168,85,247,.06)" : "rgba(255,255,255,.04)", border: cv.isTableBooking ? "1px dashed rgba(168,85,247,.35)" : "1px solid rgba(255,255,255,.08)", marginBottom: 8, cursor: "pointer", opacity: cv.isTableBooking ? 0.7 : 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>{cv.name}</div>
                  {cv.isTableBooking && (
                    <span style={{ fontSize: 10, fontWeight: 800, padding: "3px 7px", borderRadius: 6, background: "rgba(168,85,247,.15)", color: "#A855F7", whiteSpace: "nowrap" }}>🪑 TABLE → CAPTAIN</span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 12, fontSize: 12, color: "rgba(255,255,255,.4)", marginTop: 4 }}>
                  <span>{cv.ref}</span>
                  <span>{cv.phone}</span>
                  <span style={{ color: (cv.coverBalance || 0) > 0 ? "#00C864" : "#EF4444", fontWeight: 800 }}>₹{(cv.coverBalance || 0).toLocaleString("en-IN")}</span>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* guests without wallet hidden — bar mode only shows active wallets */}

        {results.length === 0 && guestHits.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "rgba(255,255,255,.3)" }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>📷</div>
            <div style={{ fontSize: 14 }}>Scan a customer QR code or search by name/phone to open their wallet</div>
          </div>
        )}
      </div>

      {scanning && <QrScanner onResult={handleQrResult} onClose={() => setScanning(false)} />}
      {activeCover && <WalletOverlay cover={activeCover} staffName={staffName} onClose={() => { setActiveCover(null); setResults([]); }} />}
    </div>
  );
}

export default function BarMode() {
  const [staffName, setStaffName] = useState<string | null>(() => sessionStorage.getItem("hod_bar_staff") || null);

  if (!staffName) return <BarLogin onLogin={setStaffName} />;
  return <BarMain staffName={staffName} onLogout={() => { sessionStorage.removeItem("hod_bar_staff"); setStaffName(null); }} />;
}
