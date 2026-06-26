import { useState, useEffect, useRef, useCallback, useMemo, type ReactElement, type CSSProperties } from "react";
import { Link } from "wouter";
import { useStaff } from "@/lib/staff-context";
import { StaffLogin } from "@/components/StaffLogin";
import {
  sha256, subscribeToHodReservations, subscribeToHodReservationsScoped, subscribeActiveWaiterCalls, markGuestArrived, markRoundServed, markRoundActivated,
  ensureCoverForAggregatorArrival,
  markTablePaid, releaseTable, setReservationAggregator, updateRoundItems,
  setSettleRequest, clearSettleRequest,
  recordBillPrint, runBillBookkeepingBg,
  printKOT, printBill, AGGREGATOR_OPTIONS, getAggregatorDiscount,
  createWalkInTable, addRoundToTable, reassignTable, createProxyTable,
  recordKotVoid, recordWalkInDiscountOverride, getTabletFloor, setTabletFloor, printKOTVoid,
  voidBill, printBillVoid, assertCaptainCanVoid, recordCaptainVoidUsage,
  recordSilentPrePrintEdit,
  computeHodBreakdown, computeHodBreakdownAdjusted, lookupOrphanZomatoPaymentByName, isTableBillSettled, type TabletFloor,
  type HodTableReservation, type HodTabRound, type HodOrderItem,
  type OrphanZomatoPayment,
  // 2026-05-15 — Captain × Cover wallet redemption (Khushi spec)
  redeemFromWalletAtTable, undoWalletRedemption, findCoverForRedemption,
  type WalletRedemption, type HodCover,
  // 2026-05-20 — COVER+TABLE linked-wallet live subscription (1-tap redeem path)
  subscribeToCoverById,
  // 2026-05-25 v3.4 (Khushi) — fallback resolver when door didn't write
  // linkedCoverDocId on the reservation; resolves cover by ref/bookingRef
  // so the 1-tap green button still shows at Mark Paid time.
  getCoverByRef,
  // 2026-05-20 — Customer-calls-captain: clear ping after captain acknowledges
  clearCustomerCallRequest,
  // 🆕 2026-05-28 v3.138 — Table-QR walk-in ordering (no payment). Customer
  // scans QR on table → fills name/phone → places order → captain banner.
  subscribeTableCallRequests, acknowledgeTableCallRequest, type HodTableCallRequest,
  // 2026-05-21 — KDS (Kitchen Display) — write food items to chef screen on KOT fire,
  // listen for ready-bumps to green-flash the table card, and let captain acknowledge.
  writeKDSItemsFromKOT, subscribeToReadyKDSItems, markKDSPickedUp, type HodKDSItem,
  // 2026-05-18 — Live menu category filtering (admin Menu CRM controls visibility + discount)
  subscribeToLiveMenuCategories, filterMenuByLiveCategories, type MenuCategory,
} from "@/lib/firestore-hod";
// 🆕 2026-05-20 (Khushi) — Floor-plan dashboard replaces the list view. The
// HOD_TABLES const is ported from hodclub-patched/index.html so what captain
// taps == what the customer booked. Floor keys: dance/dining/rooftop.
import { HOD_TABLES, TABLET_FLOOR_TO_FLOORKEY, type FloorKey, type FloorTable } from "@/lib/floor-plan";
// 🆕 2026-06-08 (Khushi) — Reassign/Assign-Table picker now uses the SAME shared
// door config + pax (capacity) grouping + live occupancy as Door Mode's "New
// Table Booking", so the captain sees tables grouped "4 PAX / 6 PAX / 8 PAX …".
import { DOOR_TABLE_OPTIONS, doorTableCapacity, doorTableOccupantAt, doorProxyLabel, doorFloorForTable } from "@/lib/door-tables";
import { subscribeToMenuOverrides } from "@/lib/firestore";
import { QrScanner } from "@/components/QrScanner";
// Captain's picker reads the EFFECTIVE menu via useEffectiveMenu() — the
// editable Menu Editor (venueMenu) merged over the canonical static baseline
// (hod-menu.ts) — so it matches Menu CRM / Bar / customer wallet exactly,
// including items Khushi adds or prices she changes in the Menu Editor. OOS /
// discount overrides set by a manager apply on top, same as before.
import { useEffectiveMenu } from "@/lib/use-effective-menu";
import type { MenuItem, MenuOverride } from "@/lib/types";
import { formatINR, getOperationalNightStr } from "@/lib/utils-pos";
import { WaiterCallBanner } from "@/components/WaiterCallBanner";
import { centeredPinPrompt, centeredAlert, centeredBusy, centeredConfirm, closeOnBackdrop } from "@/lib/centered-ui";
import { getManagerDiscountOtp, clearManagerDiscountOtp, verifyManagerDiscountOtp, type OtpContext } from "@/lib/manager-otp";
import { sendWhatsAppViaMetaShared } from "@/lib/wa-send";
// Shared with DoorMode so a single edit updates every WhatsApp message that
// includes the venue location. Plain Google Maps URL — never a Firebase
// Dynamic Link (those were shut down 2025-08-25).
import { HOD_LOCATION_URL } from "@/pages/DoorMode";
// 🆕 2026-06-07 (Khushi) — Captain Mode now has its own LIVE REPORTS (parity
// with Bar / Door). Reuses the Boss-mode LiveReports component verbatim (it is
// already table/floor-centric = the captain's domain, and its table accounting
// is architect-passed) rendered inside a fullscreen modal — identical numbers
// to Boss Mode, no duplicated/divergent accounting. Subscriptions only run
// while the modal is open (component mounts on open, unmounts on close).
import LiveReports from "./LiveReports";

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
const SERVICE_CHARGE_RATE = 0.10;
// 🆕 2026-06-25 (Khushi) — aggregator refs (AGG-ND-ARJUN-20260625-1415) are too
// long to read on the tablet. Strip the embedded 8-digit YYYYMMDD date block for
// DISPLAY only (keeps platform + name + HHMM time → AGG-ND-ARJUN-1415). The
// stored ref is never changed — this is purely a display shortener.
const shortRef = (ref?: string | null): string =>
  (ref || "").replace(/-\d{8}-/i, "-");
// L6 — minimum gap between two thermal-bill prints for the same table; below
// this we ask the captain to confirm so they can't waste paper hammering the button.
const BILL_REPRINT_DEBOUNCE_MS = 10_000;
// D1 — manual discount % above this triggers Manager-PIN at Mark-Paid time.
// Aggregator-driven discounts (Zomato/EazyDiner) bypass this gate; only the
// captain-typed manualDiscount field is checked.
// 🆕 2026-06-26 (Khushi) — raised 25→50 so it never fires at/below the new
// 50% cap: a captain discount needs ONLY the Manager OTP (any-discount gate),
// not an additional PIN. Left as defense-in-depth for any >50% edge.
const HIGH_DISCOUNT_PIN_THRESHOLD = 50;
// D2 — waiving Service Charge on a tab above this rupee floor needs Manager PIN.
// Below this, comped SC is treated as a routine kindness (small chai/water tabs).
const SC_WAIVER_PIN_FLOOR = 1500;
// 🔴 2026-05-12 — D4: cap on every captain-typed discount field. Owners
// asked for a hard ceiling. Aggregator DEFAULTS (e.g. Zomato 30%) still flow
// through `aggregatorDiscount` from the booking. 🆕 2026-06-26 (Khushi) — cap
// raised 15→50 and the captain-typed discount now needs only the Manager
// WhatsApp OTP (PIN stays as the silent network-fail fallback) for any
// 0 → N change; the extra >25% PIN step was dropped (see threshold above).
const CAPTAIN_DISCOUNT_MAX = 50;
// 🔴 2026-05-13 (Khushi spec, round 6) — walk-in (Seat Walk-In Guest)
// modal is in-house only, discount capped at 10% (was 15%). Settle Bill
// still allows up to CAPTAIN_DISCOUNT_MAX since managers may need
// promo/loyalty headroom there.
const WALKIN_DISCOUNT_MAX = 10;

/** Clamp a captain-typed discount to the 15% cap; alert + return null if rejected. */
// 🆕 2026-05-27 v3.76 (Khushi LIVE-NIGHT) — in-app styled alert. Khushi: "any
// pop up u give, please give it on the screen, no browser pop up please".
// Mirrors the DoorMode helper so captain alerts (table-assign gate, void cap
// errors, etc.) feel native to the gold HOD palette. Auto-dismiss on backdrop,
// OK, or Escape. Pure DOM so no React state plumbing required.
function showAppAlert(message: string, title?: string) {
  if (typeof document === "undefined") return;
  const lines = message.split("\n").map((s) => s.trim()).filter(Boolean);
  const head = title || lines.shift() || "NOTICE";
  const body = lines.join("\n\n");
  const overlay = document.createElement("div");
  overlay.setAttribute("data-hod-alert", "1");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);z-index:100000;display:flex;align-items:center;justify-content:center;padding:18px;font-family:'Manrope','Space Grotesk',sans-serif;animation:hodAlertFade .15s ease-out;";
  const card = document.createElement("div");
  card.style.cssText = "background:#fff;border:2px solid #000;border-radius:16px;max-width:420px;width:100%;box-shadow:none;color:#000;overflow:hidden;";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  card.innerHTML =
    '<div style="padding:18px 20px 8px;border-bottom:1px solid #000;">' +
      '<div style="font-size:17px;font-weight:900;color:#000;letter-spacing:.4px;line-height:1.3;">' + esc(head) + '</div>' +
    '</div>' +
    '<div style="padding:16px 20px 20px;font-size:14px;line-height:1.55;color:#6B6B6B;font-weight:500;white-space:pre-wrap;">' + esc(body) + '</div>' +
    '<div style="padding:0 16px 16px;">' +
      '<button id="hod-app-alert-ok" type="button" style="width:100%;padding:14px;border-radius:11px;background:#FF90E8;border:none;color:#000;font-size:14px;font-weight:900;letter-spacing:.6px;cursor:pointer;text-transform:uppercase;font-family:inherit;">OK</button>' +
    '</div>';
  overlay.appendChild(card);
  if (!document.getElementById("hod-app-alert-style")) {
    const st = document.createElement("style");
    st.id = "hod-app-alert-style";
    st.textContent = "@keyframes hodAlertFade{from{opacity:0}to{opacity:1}}";
    document.head.appendChild(st);
  }
  function close() {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e: KeyboardEvent) { if (e.key === "Escape" || e.key === "Enter") close(); }
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
  const okBtn = document.getElementById("hod-app-alert-ok");
  if (okBtn) okBtn.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
}

function clampCaptainDiscount(raw: number): number | null {
  const n = Math.max(0, Math.floor(Number(raw) || 0));
  if (n > CAPTAIN_DISCOUNT_MAX) {
    void centeredAlert(
      "DISCOUNT CAPPED",
      `Captain discount is capped at ${CAPTAIN_DISCOUNT_MAX}%.\nAsk a manager to apply anything higher.`,
      "error",
      true,
    );
    return null;
  }
  return n;
}

/** Prompt for the Manager PIN and verify against MANAGER_HASH. Returns true on success.
 *  2026-05-26 — uses centeredPinPrompt + centeredAlert (HOD-branded modal,
 *  no ugly browser popups). Fail-open: if DOM helpers throw, the helper
 *  itself falls back to window.prompt. */
async function requireManagerPin(reason: string): Promise<boolean> {
  const pin = await centeredPinPrompt(reason, true);
  if (!pin) return false;
  const h = await sha256(pin.trim());
  if (h !== MANAGER_HASH) { await centeredAlert("WRONG MANAGER PIN", "That PIN did not match. Action cancelled.", "error", true); return false; }
  return true;
}

/** 2026-06-25 (Khushi) — Manager approval for a captain discount via a one-time
 *  WhatsApp OTP. The server mints a 6-digit code (10-min, single-use) and sends
 *  it to the managers; the captain enters it here. The SAME box also accepts the
 *  Manager PIN, which stays as a SILENT FALLBACK: if the code can't be delivered
 *  (weak venue wifi) a manager who is present approves with the PIN. Returns true
 *  only on a confirmed OTP or PIN. Fail-open: a stalled/failed send never blocks —
 *  it just shows the "use the PIN" message. */
async function requireManagerApproval(reason: string, ctx: OtpContext): Promise<boolean> {
  // getManagerDiscountOtp REUSES this table's live code (one code per approval
  // session) so the captain never gets two OTPs where only one verifies.
  // 🔵 2026-06-26 (Khushi) — this server call takes ~5-6s; show a NON-DISMISSABLE
  // "sending code" spinner so the captain can't tap other buttons while waiting.
  const closeSendBusy = centeredBusy(
    "📲 Sending approval code to the manager…\n\nPlease wait — don't tap anything.",
    true,
  );
  let otp: Awaited<ReturnType<typeof getManagerDiscountOtp>>;
  try {
    otp = await getManagerDiscountOtp(ctx); // helper has its own timeout
  } finally {
    closeSendBusy();
  }
  const sent = otp.ok && otp.sentTo > 0;
  const head = sent
    ? `📲 A 6-digit code was sent to the manager's WhatsApp.\nEnter the CODE below — or the Manager PIN.\n\n`
    : `⚠️ Couldn't send the WhatsApp code (network).\nEnter the Manager PIN to approve.\n\n`;
  // Track whether approval came via the WhatsApp OTP (vs the silent PIN fallback)
  // so we can show the OTP-specific success popup Khushi asked for.
  let verifiedViaOtp = false;
  const entered = await centeredPinPrompt(head + reason, true, async (val) => {
    const v = (val || "").trim();
    if (!v) return false;
    // PIN fallback first — local, instant, always works for a present manager.
    if ((await sha256(v)) === MANAGER_HASH) return true;
    // Otherwise verify the OTP server-side (single-use, 10-min expiry).
    if (otp.otpId) {
      // 🔵 2026-06-26 (Khushi) — verify takes ~3-5s; show the spinner ON TOP of
      // the PIN prompt so the captain sees progress and can't tap elsewhere.
      const closeVerifyBusy = centeredBusy("🔐 Verifying code…\n\nPlease wait.", true);
      let okv = false;
      try {
        okv = await verifyManagerDiscountOtp(otp.otpId, v);
      } finally {
        closeVerifyBusy();
      }
      // Burned server-side on success — drop the cache so the NEXT discount on
      // this table mints a fresh code instead of reusing a now-dead one.
      if (okv) {
        clearManagerDiscountOtp(ctx);
        verifiedViaOtp = true;
      }
      return okv;
    }
    return false;
  });
  // OTP-verified success screen: a clear ✅ tick + a nudge to tap CONFIRM
  // PAYMENT next, so the captain knows the code worked and what to do.
  if (entered && verifiedViaOtp) {
    await centeredAlert(
      "OTP VERIFIED",
      "Manager approval confirmed.\n\nNow tap the CONFIRM PAYMENT button to proceed.",
      "success",
      true, // Gumroad-brutalist theme
    );
  }
  return !!entered;
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
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", border: "2px solid #FF5733", borderRadius: 20, padding: 22, width: "100%", maxWidth: 420, maxHeight: "92vh", overflowY: "auto" }}>
        <div style={{ fontSize: 20, fontWeight: 900, color: "#FF5733", marginBottom: 6 }}>🚫 VOID FROM PRINTED KOT</div>
        <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 14 }}>Round {roundNum} · Bar/Kitchen will be auto-notified</div>

        <div style={{ background: "#FFF0EC", border: "1px solid #FF5733", borderRadius: 10, padding: "10px 12px", marginBottom: 14 }}>
          {voided.map((v, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "#000", padding: "3px 0" }}>
              <span>{v.qty}× {v.n}</span>
              <span style={{ color: "#FF5733", fontWeight: 700 }}>−₹{v.p * v.qty}</span>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, paddingTop: 6, borderTop: "1px dashed #6B6B6B", fontSize: 16, fontWeight: 900 }}>
            <span style={{ color: "#000" }}>VALUE LOST</span>
            <span style={{ color: "#FF5733" }}>−₹{valueLost}</span>
          </div>
        </div>

        <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 6, fontWeight: 700 }}>REASON *</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {VOID_REASONS.map((r) => (
            <button key={r} onClick={() => setReason(r)} disabled={busy}
              style={{ padding: "7px 11px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer",
                background: reason === r ? "#FBF3D6" : "#fff",
                border: `1px solid ${reason === r ? "#000" : "#6B6B6B"}`,
                color: reason === r ? "#000" : "#6B6B6B" }}>
              {r}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 6, fontWeight: 700 }}>
          NOTES {reason === "OTHER" ? "*" : "(optional)"}
        </div>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy}
          placeholder={reason === "OTHER" ? "Required — describe what happened" : "e.g. table 5 sent it back"}
          style={{ width: "100%", padding: "10px 12px", borderRadius: 10, background: "#fff", border: "1px solid #000", color: "#000", fontSize: 16, outline: "none", marginBottom: 14, boxSizing: "border-box" }} />

        <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 6, fontWeight: 700 }}>🔒 MANAGER PIN *</div>
        <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          autoFocus disabled={busy} placeholder="4-digit PIN"
          onKeyDown={(e) => e.key === "Enter" && submit()}
          style={{ width: "100%", padding: "12px 14px", borderRadius: 10, background: "#fff", border: "1px solid #000", color: "#000", fontSize: 21, letterSpacing: 8, textAlign: "center", outline: "none", marginBottom: 12, boxSizing: "border-box" }} />

        {err && <div style={{ fontSize: 14, color: "#FF5733", marginBottom: 10, textAlign: "center" }}>{err}</div>}

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onCancel} disabled={busy}
            style={{ flex: 1, padding: 12, borderRadius: 10, background: "transparent", border: "1px solid #000", color: "#6B6B6B", fontSize: 16, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer" }}>
            Cancel
          </button>
          <button onClick={submit} disabled={busy}
            style={{ flex: 1.4, padding: 12, borderRadius: 10, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 16, fontWeight: 900, cursor: busy ? "not-allowed" : "pointer" }}>
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
    <div onClick={closeOnBackdrop(onCancel)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 5000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 460, background: "#fff", border: "2px solid #FF5733", borderRadius: 14, padding: 20, color: "#000" }}>
        <div style={{ fontSize: 20, fontWeight: 900, color: "#FF5733", marginBottom: 6 }}>🚫 VOID PRINTED BILL</div>
        <div style={{ fontSize: 14, color: "#6B6B6B", marginBottom: 10 }}>
          Use ONLY when the bill was printed but the customer cannot/will not pay. The bill stays on record for audit; the table is freed.
        </div>
        <div style={{ background: "#FFF0EC", border: "1px solid #FF5733", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 4 }}>TABLE / CUSTOMER</div>
          <div style={{ fontSize: 17, fontWeight: 800, color: "#000", marginBottom: 8 }}>{tableId} · {customerName || "—"}</div>
          <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 4 }}>BILL TOTAL TO BE VOIDED (LEAKAGE)</div>
          <div style={{ fontSize: 26, fontWeight: 900, color: "#FF5733" }}>₹{Math.round(billTotal)}</div>
        </div>

        <label style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 4, display: "block" }}>REASON</label>
        <select value={reason} onChange={(e) => setReason(e.target.value)}
          style={{ width: "100%", padding: "10px 12px", borderRadius: 10, background: "#fff", border: "1px solid #000", color: "#000", fontSize: 16, marginBottom: 12, boxSizing: "border-box" }}>
          {BILL_VOID_REASONS.map((r) => <option key={r} value={r} style={{ background: "#fff" }}>{r}</option>)}
        </select>

        <label style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 4, display: "block" }}>
          NOTES {reason === "OTHER" ? "(REQUIRED)" : "(OPTIONAL)"}
        </label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
          placeholder="What happened? (Will be stored in the audit trail.)"
          style={{ width: "100%", padding: "10px 12px", borderRadius: 10, background: "#fff", border: "1px solid #000", color: "#000", fontSize: 16, marginBottom: 12, boxSizing: "border-box", resize: "vertical" }} />

        <label style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 4, display: "block" }}>MANAGER PIN (8888)</label>
        <input type="password" inputMode="numeric" pattern="[0-9]*" maxLength={4}
          value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          style={{ width: "100%", padding: "12px 14px", borderRadius: 10, background: "#fff", border: "1px solid #000", color: "#000", fontSize: 21, letterSpacing: 8, textAlign: "center", outline: "none", marginBottom: 12, boxSizing: "border-box" }} />

        {err && <div style={{ fontSize: 14, color: "#FF5733", marginBottom: 10, textAlign: "center" }}>{err}</div>}

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onCancel} disabled={busy}
            style={{ flex: 1, padding: 12, borderRadius: 10, background: "transparent", border: "1px solid #000", color: "#6B6B6B", fontSize: 16, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer" }}>
            Cancel
          </button>
          <button onClick={submit} disabled={busy}
            style={{ flex: 1.4, padding: 12, borderRadius: 10, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 16, fontWeight: 900, cursor: busy ? "not-allowed" : "pointer" }}>
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
  const pin = await centeredPinPrompt(`🛡️ ADMIN PIN ALSO REQUIRED — ${reason}`, true);
  if (!pin) return false;
  const h = await sha256(pin.trim());
  if (h !== ADMIN_HASH) { await centeredAlert("WRONG ADMIN PIN", "That Admin PIN did not match. Action cancelled.", "error", true); return false; }
  return true;
}

// Brand-color palette for the booking-source pills (champagne gold for in-house,
// authentic brand colors for each aggregator). Used in the Source/Discount UI.
const AGG_BRAND: Record<string, { fg: string; bg: string; border: string }> = {
  inhouse:         { fg: "#000", bg: "#FBF3D6", border: "#000" },
  // 🔴 2026-05-12 — Brand palette intentionally collapsed to the venue's
  // 4 in-house colours (yellow / black / white / red). External brand reds
  // / oranges removed per owner request; aggregator identity is conveyed
  // by the label, not by colour.
  zomato:          { fg: "#FF5733", bg: "#FFF0EC",  border: "#FF5733"  },
  "swiggy-dineout":{ fg: "#FF5733", bg: "#FFF0EC",  border: "#FF5733"  },
  "swiggy-scenes": { fg: "#FF5733", bg: "#FFF0EC",  border: "#FF5733"  },
  eazydiner:       { fg: "#000", bg: "#FBF3D6", border: "#000" },
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

// 🆕 2026-06-25 (Khushi) — captain-created PROXY/EXTRA tables.
// Each proxy now gets a FLOOR-UNIQUE stored id (`Proxy-${n}-${CODE}`) so two
// floors can each hold their own "Proxy-1" without colliding on the floor map /
// occupancy (both key by tableId). The DISPLAY label strips the floor code back
// to the friendly "Proxy-N"; legacy plain "Proxy-N" ids still parse.
const PROXY_FLOOR_CODE: Record<string, string> = { dance: "GR", dining: "DN", rooftop: "RF" };
function proxyDisplayLabel(id: string): string | null {
  const m = String(id || "").match(/^proxy-(\d+)/i);
  return m ? `Proxy-${m[1]}` : null;
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
    // 🆕 2026-06-07 (Khushi) — a prepaid-cover table carries paymentStatus:"paid"
    // from the deposit while the guest is STILL SEATED (food tab open). Only a
    // truly SETTLED bill (markTablePaid → paymentMode/paidAt) means the table is
    // free; otherwise it stays occupied so we never double-book a seated guest.
    if (isTableBillSettled(r)) continue;
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

// 🆕 2026-05-25 (Khushi) — Captain login now uses the unified per-staff
// `StaffLogin` (HOD ID + 4-digit PIN). Legacy shared-password screen is
// retired. The wrapper bridges `currentStaff.name` → existing `captainName`
// state in the parent component so the rest of CaptainMode stays untouched.
function CaptainLogin({ onLogin }: { onLogin: (name: string) => void }) {
  const { currentStaff, isLoggedIn, hasRole, activeMode, needsModePicker } = useStaff();
  useEffect(() => {
    if (!isLoggedIn || !currentStaff || needsModePicker) return;
    // Allow if user has captain role (admin implicitly) AND has not switched
    // their active-mode away from captain (multi-role: Tejas/Ganesh).
    if (!hasRole("captain")) return;
    if (activeMode && activeMode !== "captain") return;
    onLogin(currentStaff.name);
  }, [isLoggedIn, currentStaff, hasRole, activeMode, needsModePicker, onLogin]);
  return <StaffLogin allowedRoles={["captain"]} title="CAPTAIN LOGIN" emoji="👨‍✈️" brutalist />;
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
  // 🆕 2026-06-26 (Khushi — "I added items in Edit Order but got no PRINT KOT")
  // — when items are added to an ALREADY-PRINTED round, their delta chit fires on
  // save; this shows an in-app confirmation (NOT a browser popup) so the captain
  // SEES the new items went to the printer instead of wondering if they printed.
  const [kotSent, setKotSent] = useState<{ count: number } | null>(null);

  // 🆕 2026-06-26 (Khushi) — ADD ITEM to this SAME round, now via the SAME
  // full 4-tab picker (FOOD/LIQUOR/NAB/SMOKE + sub-category chips + tappable
  // ADD+ grid) the captain uses in Add Order. The old version was a tiny
  // search box; Khushi wanted the full browse-and-tap grid here too. Reads the
  // live effective menu (out-of-stock hidden, live discount applied). Items
  // added on a printed KOT fire their own delta chit on Save (commitChanges).
  const MENU_ITEMS = useEffectiveMenu();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  type WalletTab = "food" | "liquor" | "nab" | "smoke";
  const [tab, setTab] = useState<WalletTab>("food");
  const [menuOverrides, setMenuOverrides] = useState<Record<string, MenuOverride>>({});
  useEffect(() => subscribeToMenuOverrides(setMenuOverrides), []);
  const [liveCategories, setLiveCategories] = useState<MenuCategory[]>([]);
  useEffect(() => subscribeToLiveMenuCategories(setLiveCategories), []);
  const ovKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const effPrice = (m: { name: string; price: number }) => {
    const ov = menuOverrides[ovKey(m.name)];
    if (!ov) return m.price;
    if (ov.discountPercent) return Math.max(0, Math.round((m.price - m.price * ov.discountPercent / 100) * 100) / 100);
    if (ov.discountAmount) return Math.max(0, Math.round((m.price - ov.discountAmount) * 100) / 100);
    return m.price;
  };
  // Map each menu item to one of the 4 wallet tabs (same logic as AddOrderModal).
  const tabOf = (m: { group: string; isAlcohol?: boolean; category?: string }): WalletTab => {
    const g = (m.group || "").toLowerCase();
    if (g === "food") return "food";
    if (g === "smoke" || g === "tobacco") return "smoke";
    if (g === "beer-wine" || g === "spirits" || g === "cocktails") return "liquor";
    if (g === "soft" || g === "non-alcoholic" || g === "nab" || g === "mocktails") return "nab";
    const c = (m.category || "").toLowerCase();
    if (c.startsWith("food-")) return "food";
    if (c.startsWith("smoke-") || c.startsWith("tobacco")) return "smoke";
    if (c.startsWith("nab-") || c.startsWith("soft-") || c.startsWith("mock")) return "nab";
    if (c.startsWith("bar-") || c.startsWith("beer") || c.startsWith("wine") || c.startsWith("spirits") || c.startsWith("liquor") || c.startsWith("cocktail")) return "liquor";
    return m.isAlcohol ? "liquor" : "nab";
  };
  const prettyCat = (c: string) =>
    c.replace(/^(food|bar|smoke|nab|liquor)-/i, "").replace(/-/g, " ").toUpperCase();
  const tabCategories = useMemo(() => {
    const inTab = MENU_ITEMS.filter((m) => tabOf(m) === tab);
    return [...new Set(inTab.map((m) => m.category))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, MENU_ITEMS]);
  useEffect(() => { setCategory(""); }, [tab]);
  // Fuzzy, typo-tolerant, GLOBAL search — same algorithm as AddOrderModal.
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
    const menuForPicker = liveCategories.length > 0 ? filterMenuByLiveCategories(MENU_ITEMS, liveCategories) : MENU_ITEMS;
    let list = menuForPicker.filter((m) => m.available !== false && !menuOverrides[ovKey(m.name)]?.outOfStock);
    if (search) {
      const q = norm(search);
      const words = q.split(" ").filter(Boolean);
      list = list.filter((m) => {
        const hay = norm(`${m.name} ${m.category} ${m.group}`);
        return words.every((w) => wordMatch(w, hay));
      });
    } else {
      list = list.filter((m) => tabOf(m) === tab);
      if (category) list = list.filter((m) => m.category === category);
    }
    return list.slice(0, 80);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, category, menuOverrides, tab, liveCategories, MENU_ITEMS]);
  // Auto-jump the highlighted tab to a search match living in another tab.
  useEffect(() => {
    if (!search.trim() || filtered.length === 0) return;
    const t = tabOf(filtered[0]);
    setTab((prev) => (prev === t ? prev : t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filtered]);
  const addMenuItem = (m: { name: string; price: number; category: string; group: string; isAlcohol?: boolean; isVeg?: boolean }) => {
    const usePrice = effPrice({ name: m.name, price: m.price || 0 });
    setItems((prev) => {
      const ex = prev.find((c) => c.n === m.name && c.p === usePrice);
      if (ex) return prev.map((c) => (c.n === m.name && c.p === usePrice) ? { ...c, qty: c.qty + 1 } : c);
      const t: "food" | "drink" = m.group === "food" ? "food" : "drink";
      const alc = m.group === "food" ? false : !!m.isAlcohol;
      return [...prev, { n: m.name, p: usePrice, qty: 1, cat: m.category, t, alc, v: m.isVeg }];
    });
    setSearch("");
  };

  const updateQty = (idx: number, delta: number) => {
    setItems((prev) => {
      const updated = prev.map((it, i) => i === idx ? { ...it, qty: it.qty + delta } : it);
      return updated.filter((it) => it.qty > 0);
    });
  };
  const removeItem = (idx: number) => setItems((prev) => prev.filter((_, i) => i !== idx));

  // 🆕 2026-06-26 (Khushi) — items ADDED relative to the original round (new
  // item, or a qty increase). On a printed KOT these need their OWN chit so the
  // kitchen/bar actually makes them (computed in commitChanges).
  const computeAdded = (): HodOrderItem[] => {
    const added: HodOrderItem[] = [];
    for (const it of items) {
      const orig = originalItems.find((o) => o.n === it.n && o.p === it.p);
      const addQty = it.qty - (orig?.qty || 0);
      if (addQty > 0) added.push({ ...it, qty: addQty });
    }
    return added;
  };

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
      // 🔴 2026-05-20 (Khushi LIVE BUG fix) — use computeHodBreakdown so the
      // saved roundTotal is TAX-INCLUSIVE, matching addRoundToTable +
      // customer wallet math. Before: this stored raw subtotal (185) while
      // every other code path stored inclusive (214) — so editing a round
      // silently DOWNGRADED its total on the customer phone.
      const total = computeHodBreakdown(items).grandTotal;
      await updateRoundItems(docId, roundIndex, items, total, captainName, isPrintedKot ? voidedSnapshot : undefined);
      // 🆕 2026-06-26 (Khushi) — items ADDED to an already-PRINTED KOT round need
      // their OWN chit so the kitchen/bar actually makes them. Pre-print rounds
      // skip this — the round's own PRINT KOT NOW button prints everything when
      // the captain is ready. Fire-and-forget: paper KOT is the fallback, the
      // edit is already saved, so a print hiccup never blocks the captain.
      let addedQty = 0;
      if (isPrintedKot) {
        const added = computeAdded();
        if (added.length > 0) {
          addedQty = added.reduce((s, a) => s + (a.qty || 0), 0);
          printKOT({
            tableId, floorLabel, customerName, staff: captainName,
            roundNum: round.roundNum, items: added,
            roundTotal: computeHodBreakdown(added).grandTotal,
            bookingRef, reservationId: docId,
          }).catch(() => {});
          if (added.some((a) => a.t === "food")) {
            writeKDSItemsFromKOT({
              reservationId: docId, coverDocId: "",
              tableId, tableLabel: tableId, floorLabel: floorLabel || "",
              customerName: customerName || "", bookingRef, staff: captainName,
              roundNum: round.roundNum, items: added,
              // unique per-edit token → a 2nd add to the same round writes NEW
              // kitchen rows instead of overwriting the original round's KDS docs.
              idNonce: `add${Date.now()}`,
            } as any).catch(() => {});
          }
        }
      }
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
      // When we just fired a delta KOT for added items, keep the editor mounted
      // and show the confirmation; OK closes it. Otherwise close straight away.
      if (addedQty > 0) { setSaving(false); setKotSent({ count: addedQty }); }
      else onClose();
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
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", border: "1px solid #000", borderRadius: 20, width: "100%", maxWidth: 440, maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ fontSize: 19, fontWeight: 900, color: "#000", padding: "20px 24px 12px" }}>Edit Round {round.roundNum}</div>
        {/* Scrollable body: current items + the full ADD picker. */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 24px" }}>
          {items.map((it, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #6B6B6B" }}>
              <div style={{ flex: 1, fontSize: 16, color: "#000" }}>{it.n}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={() => updateQty(i, -1)} style={{ width: 28, height: 28, borderRadius: 6, background: "#fff", border: "1px solid #000", color: "#000", cursor: "pointer" }}>−</button>
                <span style={{ fontSize: 17, fontWeight: 800, color: "#000", minWidth: 20, textAlign: "center" }}>{it.qty}</span>
                <button onClick={() => updateQty(i, 1)} style={{ width: 28, height: 28, borderRadius: 6, background: "#fff", border: "1px solid #000", color: "#000", cursor: "pointer" }}>+</button>
                {/* 🔴 2026-05-20 (Khushi Bug 4) — inclusive ₹ via computeHodBreakdown
                    so this line matches the Total below to the rupee. */}
                <span style={{ fontSize: 16, color: "#000", minWidth: 50, textAlign: "right" }}>₹{computeHodBreakdown([it]).grandTotal}</span>
                <button onClick={() => removeItem(i)} style={{ width: 28, height: 28, borderRadius: 6, background: "#FFF0EC", border: "1px solid #FF5733", color: "#000", cursor: "pointer", fontSize: 17 }}>×</button>
              </div>
            </div>
          ))}
          {/* 🆕 2026-06-26 (Khushi) — full 4-tab ADD picker (same browse-and-tap
              grid as Add Order). Search is GLOBAL (auto-jumps tab to the match);
              tap ADD+ to drop an item into THIS round. On a printed KOT the added
              item fires its own delta chit on Save (see commitChanges). */}
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "2px dashed #000" }}>
            <div style={{ fontSize: 13, fontWeight: 900, color: "#000", marginBottom: 8, letterSpacing: 0.5 }}>➕ ADD ITEMS TO THIS ROUND</div>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search the whole menu…"
              style={{ width: "100%", padding: "10px 12px", borderRadius: 6, background: "transparent", border: "1px solid #000", color: "#000", fontSize: 15, outline: "none", boxSizing: "border-box", marginBottom: 8, textAlign: "center", fontFamily: "'Manrope','Space Grotesk',sans-serif" }} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 8 }}>
              {([
                { id: "food", tint: "#FF90E8", fg: "#000" },
                { id: "liquor", tint: "#F2C744", fg: "#000" },
                { id: "nab", tint: "#23A094", fg: "#fff" },
                { id: "smoke", tint: "#60A5FA", fg: "#fff" },
              ] as const).map((t) => {
                const active = tab === t.id;
                return (
                  <button key={t.id} onClick={() => setTab(t.id)}
                    style={{ padding: "12px 4px", borderRadius: 6, fontSize: 13, fontWeight: 800, letterSpacing: 0.8, cursor: "pointer",
                      background: active ? t.tint : "#fff", color: active ? t.fg : "#000", border: "2px solid #000", textTransform: "uppercase" }}>{t.id}</button>
                );
              })}
            </div>
            {tabCategories.length > 1 && (
              <div style={{ display: "flex", gap: 6, paddingBottom: 8, flexWrap: "wrap", maxHeight: 72, overflowY: "auto" }}>
                <button onClick={() => setCategory("")}
                  style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 3, fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
                    background: !category ? "#FF90E8" : "#fff", border: "1.5px solid #000",
                    boxShadow: !category ? "none" : "2px 2px 0 #000", transform: !category ? "translate(2px,2px)" : "none", color: "#000" }}>ALL</button>
                {tabCategories.map((c) => (
                  <button key={c} onClick={() => setCategory(c)}
                    style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 3, fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", letterSpacing: 0.5,
                      background: category === c ? "#FF90E8" : "#fff", border: "1.5px solid #000",
                      boxShadow: category === c ? "none" : "2px 2px 0 #000", transform: category === c ? "translate(2px,2px)" : "none", color: "#000" }}>{prettyCat(c)}</button>
                ))}
              </div>
            )}
            {filtered.length === 0 && (
              <div style={{ padding: 24, textAlign: "center", color: "#6B6B6B", fontSize: 14 }}>
                No items{search ? ` matching "${search}"` : ""}.
              </div>
            )}
            {filtered.map((m) => {
              const ov = menuOverrides[ovKey(m.name)];
              const eff = effPrice({ name: m.name, price: m.price || 0 });
              const hasDisc = eff !== (m.price || 0);
              const showVeg = m.group === "food";
              return (
                <div key={`${m.id || ""}-${m.category}-${m.name}`}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px dashed #6B6B6B" }}>
                  <div style={{ flex: 1, paddingRight: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 15, color: "#000", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3 }}>
                      {showVeg && (
                        <span style={{ display: "inline-block", width: 12, height: 12, border: `1.5px solid ${m.isVeg ? "#23A094" : "#FF5733"}`, borderRadius: 2, position: "relative", flexShrink: 0 }}>
                          <span style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 5, height: 5, borderRadius: "50%", background: m.isVeg ? "#23A094" : "#FF5733" }} />
                        </span>
                      )}
                      {m.name}
                    </div>
                    <div style={{ fontSize: 18, color: "#000", marginTop: 4, fontWeight: 900 }}>
                      {hasDisc ? (
                        <>
                          <span style={{ textDecoration: "line-through", color: "#000", marginRight: 6 }}>₹{m.price || 0}</span>
                          <span style={{ color: "#23A094" }}>₹{eff}</span>
                        </>
                      ) : (<>₹{m.price || 0}</>)}
                      {hasDisc && ov?.discountReason && (
                        <span style={{ marginLeft: 6, color: "#6B6B6B", fontWeight: 500 }}>· {ov.discountReason}</span>
                      )}
                    </div>
                  </div>
                  <button onClick={() => addMenuItem(m)}
                    style={{ padding: "8px 18px", borderRadius: 4, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 14, fontWeight: 800, letterSpacing: 0.5, cursor: "pointer" }}>ADD +</button>
                </div>
              );
            })}
          </div>
        </div>
        {/* Fixed footer: total + actions. */}
        <div style={{ borderTop: "2px solid #000", padding: "12px 24px 20px", background: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "0 0 12px", fontWeight: 900, fontSize: 18 }}>
            <span style={{ color: "#000" }}>Total <span style={{ fontSize: 12, fontWeight: 600, opacity: .55 }}>inc. tax</span></span>
            <span style={{ color: "#000" }}>₹{computeHodBreakdown(items).grandTotal}</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={{ flex: 1, padding: 12, borderRadius: 10, background: "transparent", border: "1px solid #000", color: "#6B6B6B", fontSize: 16, cursor: "pointer" }}>Cancel</button>
            <button onClick={save} disabled={saving}
              style={{ flex: 1, padding: 12, borderRadius: 10,
                background: (isPrintedKot && computeAdded().length > 0) ? "#23A094" : "#FBF3D6",
                border: "1px solid #000",
                color: (isPrintedKot && computeAdded().length > 0) ? "#fff" : "#000",
                fontSize: 16, fontWeight: 800, cursor: "pointer" }}>
              {saving ? "Saving..." : (isPrintedKot && computeAdded().length > 0 ? "🖨 Save & Print KOT" : "Save Changes")}
            </button>
          </div>
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
      {kotSent && (
        <div onClick={() => { setKotSent(null); onClose(); }}
          style={{ position: "fixed", inset: 0, zIndex: 99999, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: "#fff", border: "2px solid #000", borderRadius: 16, boxShadow: "5px 5px 0 #000", width: "100%", maxWidth: 360, overflow: "hidden" }}>
            <div style={{ background: "#23A094", color: "#fff", fontWeight: 900, fontSize: 17, padding: "14px 18px", borderBottom: "2px solid #000" }}>🖨 KOT Printed</div>
            <div style={{ padding: "16px 18px", color: "#000", fontSize: 15, fontWeight: 600 }}>
              {kotSent.count} new item{kotSent.count === 1 ? "" : "s"} sent to the kitchen/bar printer for Round {round.roundNum}.
            </div>
            <div style={{ padding: "0 18px 16px" }}>
              <button onClick={() => { setKotSent(null); onClose(); }}
                style={{ width: "100%", padding: 12, borderRadius: 10, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 16, fontWeight: 900, cursor: "pointer", boxShadow: "2px 2px 0 #000" }}>OK</button>
            </div>
          </div>
        </div>
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
      const opt = doorFloorForTable(newTable);
      await reassignTable(reservation._docId, newTable, opt?.floor || "", opt?.label || "", captainName);
      onClose();
    } catch (e: any) { setError(e.message); }
    setSaving(false);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", border: "1px solid #000", borderRadius: 20, padding: 24, width: "100%", maxWidth: 400, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <button onClick={onClose} title="Back"
            style={{ flexShrink: 0, width: 44, height: 44, borderRadius: 12, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 22, fontWeight: 900, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Manrope','Space Grotesk',sans-serif" }}>←</button>
          <div style={{ fontSize: 21, fontWeight: 900, color: "#000" }}>🔄 Reassign Table</div>
        </div>
        <div style={{ fontSize: 14, color: "#6B6B6B", marginBottom: 4 }}>
          Moving <b>{reservation.customerName}</b> from <span style={{ color: "#FF5733", fontWeight: 800 }}>{reservation.tableId}</span>
        </div>
        <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 16 }}>All orders move with the booking</div>

        <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 6 }}>Select New Table · LIVE *</div>
        {/* 🆕 2026-06-08 (Khushi) — SAME layout as Door Mode "New Table Booking":
            per floor, tables grouped by seating capacity ("4 PAX / 6 PAX / 8 PAX
            …"), available (green) first then taken (red, disabled). Uses the
            shared DOOR_TABLE_OPTIONS + doorTableOccupantAt single source so the
            picker matches the door picker AND the backend reassign gate. */}
        <div style={{ marginBottom: 16 }}>
          {DOOR_TABLE_OPTIONS.map((group) => {
            // Time-aware: a table booked for an unrelated slot should NOT block
            // reassignment to it for THIS reservation's slot.
            const targetMin = parseClockToMinutes(reservation.arrivalTime) ?? nowMinutesIST();
            const rows = group.tables.map((t) => {
              const occupant = doorTableOccupantAt(t, targetMin, allReservations);
              const occupied = !!occupant && occupant._docId !== reservation._docId;
              return { t, occupant, occupied };
            });
            // capacity groups ascending; proxies (cap 0 = flexible) sort LAST.
            const caps = Array.from(new Set(rows.map((r) => doorTableCapacity(r.t))))
              .sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
            return (
              <div key={group.floor} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 900, color: "#000", marginBottom: 2, textTransform: "uppercase", letterSpacing: 1 }}>{group.label}</div>
                {caps.map((cap) => {
                  const grp = rows
                    .filter((r) => doorTableCapacity(r.t) === cap)
                    .sort((a, b) => Number(a.occupied) - Number(b.occupied));
                  const freeCount = grp.filter((r) => !r.occupied).length;
                  return (
                    <div key={cap} style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 10, fontWeight: 800, color: "#000", letterSpacing: "0.5px" }}>
                        {cap > 0 ? `${cap} PAX` : "PROXY · CAPTAIN ASSIGNS SEATS"}
                        <span style={{ color: "#23A094", marginLeft: 6 }}>· {freeCount} FREE</span>
                      </div>
                      <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 5 }}>
                        {grp.map(({ t, occupant, occupied }) => {
                          const isCurrent = t === reservation.tableId;
                          const isSelected = newTable === t;
                          // green = available · red = taken · pink = your pick ·
                          // cream = the booking's current table.
                          const bg = isSelected ? "#FF90E8"
                            : isCurrent ? "#FBF3D6"
                            : occupied ? "#FF5733" : "#23A094";
                          const color = isSelected || isCurrent ? "#000" : "#fff";
                          const title = occupied && occupant
                            ? `Taken — ${occupant.customerName || ""}${occupant.arrivalTime ? " @ " + occupant.arrivalTime : ""}`.trim()
                            : isCurrent ? "Current table" : "Available — tap to assign";
                          return (
                            <button key={t} onClick={() => !occupied && !isCurrent && setNewTable(isSelected ? "" : t)} disabled={occupied || isCurrent}
                              title={title}
                              style={{ padding: "10px 12px", borderRadius: 8, fontSize: 13, fontWeight: 900,
                                cursor: occupied || isCurrent ? "not-allowed" : "pointer",
                                background: bg, border: "2px solid #000", color,
                                opacity: occupied && !isCurrent ? 0.9 : 1, minWidth: 56 }}>
                              {doorProxyLabel(t) || t}{isCurrent ? " ●" : occupied ? " 🔒" : ""}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {newTable && (
          <div style={{ background: "#FBF3D6", border: "1px solid #000", borderRadius: 10, padding: 10, marginBottom: 16, fontSize: 14, color: "#000" }}>
            {reservation.tableId || "NO TABLE"} → {doorProxyLabel(newTable) || newTable} ({doorFloorForTable(newTable)?.label})
          </div>
        )}

        {error && <div style={{ fontSize: 14, color: "#FF5733", marginBottom: 10 }}>{error}</div>}
        <button onClick={doReassign} disabled={saving || !newTable}
          style={{ width: "100%", padding: 14, borderRadius: 12, background: newTable ? "#FF5733" : "#fff", border: newTable ? "2px solid #000" : "2px solid #6B6B6B", color: newTable ? "#fff" : "#6B6B6B", fontSize: 18, fontWeight: 900, cursor: newTable ? "pointer" : "not-allowed", marginBottom: 10 }}>
          {saving ? "Reassigning..." : "Confirm Reassignment"}
        </button>
        <button onClick={onClose} style={{ width: "100%", padding: 12, borderRadius: 12, background: "transparent", border: "none", color: "#6B6B6B", fontSize: 16, cursor: "pointer" }}>Cancel</button>
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
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "#fff", border: "1px solid #000", borderRadius: 20, padding: 22, width: "100%", maxWidth: 400, maxHeight: "92vh", overflowY: "auto" }}>
        <div style={{ fontSize: 20, fontWeight: 900, color: "#000", marginBottom: 4 }}>🎫 REDEEM FROM WALLET</div>
        <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 16 }}>
          Table {reservation.tableId} · Bill remaining: <span style={{ color: "#000", fontWeight: 800 }}>{formatINR(remaining)}</span>
        </div>

        {success ? (
          <>
            <div style={{ background: "#E6F5F2", border: "1px solid #23A094", borderRadius: 12, padding: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 26, fontWeight: 900, color: "#23A094", marginBottom: 6 }}>✅ REDEEMED {formatINR(success.amount)}</div>
              <div style={{ fontSize: 14, color: "#6B6B6B" }}>From <b>{success.name}</b>'s wallet</div>
              <div style={{ fontSize: 14, color: "#6B6B6B", marginTop: 4 }}>New balance: <b>{formatINR(success.newBalance)}</b></div>
            </div>
            <button onClick={onClose}
              style={{ width: "100%", padding: 14, borderRadius: 12, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 17, fontWeight: 900, cursor: "pointer" }}>
              ← Back to Settle Bill
            </button>
          </>
        ) : (
          <>
            {/* Tabs */}
            <div style={{ display: "flex", gap: 4, marginBottom: 14, padding: 4, background: "#F4F4F0", border: "1px solid #000", borderRadius: 10 }}>
              {([
                { k: "scan", label: "📷 SCAN" },
                { k: "phone", label: "📱 PHONE" },
                { k: "ref", label: "🎟 REF" },
              ] as const).map((t) => (
                <button key={t.k} onClick={() => { setTab(t.k); setError(""); setFound(null); setNeedle(""); }}
                  style={{ flex: 1, padding: "8px 4px", borderRadius: 7, fontSize: 13, fontWeight: 800, cursor: "pointer", border: "none",
                    background: tab === t.k ? "#FBF3D6" : "transparent",
                    color: tab === t.k ? "#000" : "#6B6B6B" }}>
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "scan" && (
              <button onClick={() => { setError(""); setFound(null); setShowCamera(true); }}
                style={{ width: "100%", padding: 18, borderRadius: 12, background: "#FBF3D6", border: "2px dashed #000", color: "#000", fontSize: 17, fontWeight: 800, cursor: "pointer", marginBottom: 14 }}>
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
                  style={{ width: "100%", padding: "12px 14px", borderRadius: 10, background: "#fff", border: "1px solid #000", color: "#000", fontSize: 18, outline: "none", boxSizing: "border-box", marginBottom: 8 }} />
                <button onClick={() => lookup(needle)} disabled={busy || !needle.trim()}
                  style={{ width: "100%", padding: 12, borderRadius: 10, background: needle.trim() ? "#FF90E8" : "#fff", border: "1px solid #000", color: needle.trim() ? "#000" : "#6B6B6B", fontSize: 16, fontWeight: 800, cursor: needle.trim() ? "pointer" : "not-allowed" }}>
                  {busy ? "Searching…" : "🔍 LOOK UP WALLET"}
                </button>
              </div>
            )}

            {error && (
              <div style={{ padding: 10, marginBottom: 12, borderRadius: 8, background: "#FFF0EC", border: "1px solid #FF5733", color: "#FF5733", fontSize: 14, fontWeight: 600 }}>
                ⚠ {error}
              </div>
            )}

            {found && (
              <div style={{ padding: 14, marginBottom: 14, borderRadius: 12, background: "#E6F5F2", border: "1px solid #23A094" }}>
                <div style={{ fontSize: 17, fontWeight: 900, color: "#000", marginBottom: 4 }}>{found.name || "—"}</div>
                <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 2 }}>📱 {found.phone || "—"}</div>
                <div style={{ fontSize: 12, color: "#6B6B6B", marginBottom: 8, fontFamily: "monospace" }}>{found.ref || found.id}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: "#F4F4F0", borderRadius: 8 }}>
                  <span style={{ fontSize: 13, color: "#6B6B6B" }}>Available balance</span>
                  <span style={{ fontSize: 21, fontWeight: 900, color: "#23A094" }}>{formatINR(found.coverBalance || 0)}</span>
                </div>
                {(nameMismatch || phoneMismatch) && (
                  <div style={{ marginTop: 10, padding: 8, borderRadius: 6, background: "#FBF3D6", border: "1px solid #000", color: "#000", fontSize: 12, fontWeight: 700, lineHeight: 1.4 }}>
                    ⚠ NAME/PHONE DOESN'T MATCH TABLE ({reservation.customerName || "—"} · {reservation.phone || "—"}). Confirm with customer this is THEIR wallet before redeeming.
                  </div>
                )}
                <div style={{ marginTop: 12, padding: "8px 10px", background: "#FBF3D6", borderRadius: 6, fontSize: 13, color: "#000", fontWeight: 700, textAlign: "center" }}>
                  Will deduct {formatINR(Math.min(remaining, found.coverBalance || 0))} ({remaining > (found.coverBalance || 0) ? "full balance" : "bill remaining"})
                </div>
              </div>
            )}

            {found && (
              <button onClick={confirmRedeem} disabled={busy}
                style={{ width: "100%", padding: 14, borderRadius: 12, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 18, fontWeight: 900, cursor: "pointer", marginBottom: 10 }}>
                {busy ? "Redeeming…" : `✅ REDEEM ${formatINR(Math.min(remaining, found.coverBalance || 0))}`}
              </button>
            )}

            <button onClick={onClose}
              style={{ width: "100%", padding: 12, borderRadius: 12, background: "transparent", border: "1px solid #000", color: "#6B6B6B", fontSize: 16, cursor: "pointer" }}>
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
  // 🔴 BUG FIX 2026-06-25 (Khushi) — MUST fall back to `source` (NOT just
  // `aggregator`) to match EVERY other call site (table card badge, void,
  // reports). Swiggy/Zomato bookings store the platform in `source` while
  // `aggregator` is empty; reading `aggregator` alone resolved to "inhouse",
  // so the settle modal showed Cash/Card/UPI + the discount field and fired
  // the Manager-PIN popup on an aggregator bill the captain never discounted.
  const aggName = reservation.aggregator || (reservation as any).source || "inhouse";
  const aggDiscount = reservation.aggregatorDiscount ?? getAggregatorDiscount(aggName);
  // 🆕 2026-06-25 (Khushi) — an aggregator booking is identified by its PLATFORM
  // name alone, NOT by a non-zero discount. A Swiggy/Zomato table booked at 0%
  // (no platform discount) is STILL an aggregator settle — the guest already
  // paid the platform — so it must show the "Paid by {platform}" channel and
  // block wallet redemption, never fall back to Cash/Card/UPI.
  const isAggregator = aggName !== "inhouse";
  // 🆕 2026-06-25 (Khushi) — short platform name for the "Paid by …" button on
  // aggregator bills (the customer settled on the platform, not at the venue).
  const aggShortName = (() => {
    // 🔴 2026-06-25 (Khushi) — match by KEYWORD, not an exact value, so EVERY
    // platform variant maps to its brand name: plain "swiggy", "swiggy-dineout",
    // "swiggy-scenes" → Swiggy; "zomato"/"zomato-district" → Zomato; etc. The
    // booking's source can be the bare brand ("swiggy") which no exact case
    // caught, so it fell back to the generic "Aggregator". Khushi: show the
    // actual brand (Swiggy/Zomato/...) on the "Paid by …" button, never "Aggregator".
    const n = (aggName || "").toLowerCase();
    if (n.includes("swiggy")) return "Swiggy";
    if (n.includes("zomato") || n.includes("district")) return "Zomato";
    if (n.includes("eazy")) return "EazyDiner";
    if (n.includes("magicpin") || n.includes("magic")) return "Magicpin";
    return AGGREGATOR_OPTIONS.find((a) => a.value === aggName)?.label || "Aggregator";
  })();

  const [payMethod, setPayMethod] = useState<string>(isAggregator ? "aggregator" : "cash");
  // Pre-fill manual discount with whatever the captain set on the table card (Apply panel),
  // so a custom discount applied at the table flows into Cash/Card/UPI bill calc.
  const [manualDiscount, setManualDiscount] = useState<number>(isAggregator ? 0 : (aggDiscount || 0));
  // 🆕 2026-06-26 (Khushi) — EDITABLE aggregator discount at settle. The guest
  // already paid the platform (Zomato/Swiggy/EazyDiner) the discounted price, so
  // the venue COLLECTS the discounted NET — not the full bill. Prefilled with the
  // platform's published rate (aggDiscount) but freely editable by the captain
  // (no Manager PIN — a gate can be added later). Only used on the aggregator
  // path; the printed customer bill still shows the FULL invoice (gross).
  const [aggEditDiscount, setAggEditDiscount] = useState<number>(aggDiscount || 0);
  // 🔴 2026-06-26 (Khushi) — track the RAW text the captain typed in the aggregator
  // discount box so confirm() can tell a BLANK field (cleared the prefilled %) apart
  // from a deliberate "0". A blank field must NOT silently settle at full price — it
  // pops a reminder of the platform's preset % so the captain enters the right value.
  const [aggDiscRaw, setAggDiscRaw] = useState<string>(aggDiscount != null ? String(aggDiscount) : "");
  // 🔴 2026-05-26 (Khushi) — track the discount % that was already approved
  // via Manager PIN, so confirm() can re-check at commit time without
  // double-prompting when the captain pre-approved in the input onBlur.
  // Cleared whenever the discount value changes again.
  const [discountApprovedPct, setDiscountApprovedPct] = useState<number | null>(null);
  const [serviceCharge, setServiceCharge] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // 🔴 2026-05-15 — themed in-modal "Did you collect ₹X?" dialog (replaces
  // the ugly native window.confirm). Only shown on mixed wallet+cash path.
  const [showCollectConfirm, setShowCollectConfirm] = useState(false);
  // 🔴 2026-06-26 (Khushi) — themed POPUP shown when the captain blanks the
  // aggregator discount and taps Confirm Payment. A small inline error was too
  // easy to miss, so this is a full Gumroad modal reminding them the platform %
  // applies; they dismiss it, type the right discount, then Confirm again.
  const [showAggDiscWarn, setShowAggDiscWarn] = useState(false);
  // 🔀 Split payment — captain can split final amount across cash/card/upi.
  // Only available for non-aggregator paths. Sum must equal finalAmount.
  const [splitMode, setSplitMode] = useState(false);
  const [splitCash, setSplitCash] = useState<number>(0);
  const [splitCard, setSplitCard] = useState<number>(0);
  const [splitUpi, setSplitUpi] = useState<number>(0);
  // 🆕 2026-06-25 (Khushi) — COMPLIMENTARY settle. Captain taps Complimentary →
  // gives a reason + who approved it → Manager OTP/PIN gate (same as discounts).
  // Settles ₹0 collected; the comped GROSS is recorded for Reports.
  const [compReason, setCompReason] = useState("");
  const [compApprovedBy, setCompApprovedBy] = useState("");
  const [compApproved, setCompApproved] = useState(false);

  // 🔴 2026-05-12 — Aggregator bills no longer have the discount baked into
  // the printed customer bill. The customer already saw the discount on
  // Zomato/Swiggy/EazyDiner before they walked in; the venue's tablet must
  // print the FULL invoice (no discount applied) so the receipt matches the
  // F&B order ledger. The aggregator-side discount is still recorded on the
  // payment so admin reports can compute "amount actually received from
  // aggregator" alongside the gross.
  const discountPct = payMethod === "aggregator" ? 0 : manualDiscount;
  // 🆕 2026-06-08 — route the ENTIRE settle bill through computeHodBreakdownAdjusted
  // (discount + SC-toggle aware, 2-decimal SC/GST, ONE final whole-rupee round) so the
  // captain's FINAL AMOUNT === the customer wallet's YOUR TAB === the printed bill, to
  // the rupee. The OLD path rounded SC and GST to whole rupees SEPARATELY and then
  // summed them, which drifted ₹1 BELOW the canonical grand (e.g. ₹910 vs the wallet's
  // ₹911). computeHodBreakdownAdjusted with scOn=false already excludes SC from the GST
  // base, so the waived-Service-Charge case is handled too.
  const discBreakdown = computeHodBreakdownAdjusted(allItems, discountPct, serviceCharge);
  const discountAmt = Math.round(discBreakdown.discount);
  const scAmt = discBreakdown.serviceCharge;
  const taxAmt = discBreakdown.gst;
  const finalAmount = discBreakdown.grandTotal;
  // 🔴 2026-05-12 — Aggregator-net (what the venue actually nets after the
  // platform's commission/discount) — used for reports only, NOT for the
  // customer bill. MUST be computed off `finalAmount` (subtotal + SC + GST),
  // because the customer pays the aggregator the FULL invoice and the
  // platform's commission is taken off that full amount — not off the bare
  // food/drink subtotal. (Earlier version used `subtotal` and underreported
  // venue-net by ~SC+GST × discount.)
  // 🆕 2026-06-26 (Khushi) — the venue NET = full bill (finalAmount/gross) minus
  // the EDITABLE aggregator discount the captain confirms at settle. This is the
  // amount actually COLLECTED and recorded as amountPaid; the gross is kept
  // separately (aggregatorGrossAmount) so Reports can show billed vs received.
  const aggregatorNetAmount = payMethod === "aggregator"
    ? Math.round(finalAmount * (1 - (aggEditDiscount || 0) / 100))
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
  // 🆕 2026-06-25 — if a wallet redemption lands while Complimentary is
  // selected, drop back to a normal method (complimentary can't mix with
  // wallet) so confirm() can't get stuck on the "undo wallet" error.
  useEffect(() => {
    if (walletPaidSoFar > 0 && payMethod === "complimentary") {
      setPayMethod(isAggregator ? "aggregator" : "cash");
    }
  }, [walletPaidSoFar, payMethod, isAggregator]);
  const [walletErr, setWalletErr] = useState("");
  // Q6 — aggregator BOOKINGS block wallet redemption entirely (separate
  // accounting — Zomato/Swiggy/EazyDiner already collected/discounted at the
  // platform). Source-level check (not just payMethod) so a captain switching
  // payChannel from aggregator → in-house can't bypass the block. Hoisted
  // above the linked-wallet block (2026-05-20) so showOneTap can read it.
  const walletAllowed = !isAggregator && payMethod !== "aggregator";
  // ── 2026-05-20 — COVER+TABLE LINKED WALLET 1-TAP REDEEM (Khushi spec) ──
  // Live-subscribe to the linked cover doc so the button shows the CURRENT
  // balance (auto-refreshes if customer also spent at the bar between
  // arrival and bill close). One-tap path skips the scanner / phone lookup
  // entirely — uses linkedCoverDocId directly.
  const [linkedCover, setLinkedCover] = useState<HodCover | null>(null);
  const [oneTapBusy, setOneTapBusy] = useState(false);
  // 🆕 2026-05-25 v3.4 (Khushi) — RESOLVED cover docId. Prefer
  // reservation.linkedCoverDocId (set by Door's COVER+TABLE button), but
  // fall back to a ref lookup using linkedCoverRef / bookingRef when
  // that field wasn't written (e.g. table booked first, wallet shared
  // separately, or pre-2026-05-20 reservations). This is what was
  // BLOCKING Khushi's captain from seeing the 1-tap green button at
  // settle-bill time for SMK2-style flows.
  const [resolvedCoverDocId, setResolvedCoverDocId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Direct path — door set linkedCoverDocId on the reservation.
    if (reservation.linkedCoverDocId) {
      setResolvedCoverDocId(reservation.linkedCoverDocId);
      return () => { cancelled = true; };
    }
    // Fallback path — try ref → cover lookup.
    const candidate = reservation.linkedCoverRef || reservation.bookingRef || "";
    if (!candidate) { setResolvedCoverDocId(null); return () => { cancelled = true; }; }
    getCoverByRef(candidate).then((cv) => {
      if (cancelled) return;
      setResolvedCoverDocId(cv ? cv.id : null);
    }).catch(() => { if (!cancelled) setResolvedCoverDocId(null); });
    return () => { cancelled = true; };
  }, [reservation.linkedCoverDocId, reservation.linkedCoverRef, reservation.bookingRef]);
  useEffect(() => {
    if (!resolvedCoverDocId) { setLinkedCover(null); return; }
    const u = subscribeToCoverById(resolvedCoverDocId, setLinkedCover);
    return () => u();
  }, [resolvedCoverDocId]);
  const linkedBal = linkedCover ? (linkedCover.coverBalance || 0) : (reservation.linkedCoverInitial || 0);
  // Has the linked wallet already been redeemed against THIS bill? (Prevents
  // double-tap. Captain can still hit "SCAN ANOTHER WALLET" for guest #2.)
  // Match against EVERY identifier we know about — doc id (most reliable),
  // stored linkedCoverRef, AND the live cover's ref (catches legacy
  // redemptions written before walletDocId existed, plus the rare case where
  // stored linkedCoverRef is stale/missing while the live doc has the truth).
  const linkedRefCandidates = new Set<string>([
    reservation.linkedCoverRef || "",
    linkedCover?.ref || "",
    reservation.linkedCoverDocId || "",
    resolvedCoverDocId || "",
  ].filter(Boolean));
  const linkedAlreadyRedeemed = walletRedemptions.some(
    (e) => (e.walletDocId && (e.walletDocId === reservation.linkedCoverDocId || e.walletDocId === resolvedCoverDocId)) ||
           (e.walletRef && linkedRefCandidates.has(e.walletRef))
  );
  // 🆕 2026-05-25 v3.4 (Khushi) — gate on RESOLVED doc id (covers both the
  // door-written path AND the fallback ref-lookup path). Auto-partial
  // redemption is already supported below (oneTapAmount = min(payable, bal)),
  // so wallet ₹1,000 against bill ₹1,443 will redeem ₹1,000 and leave ₹443
  // owing on cash/card/UPI/split. The bug was that the button never showed
  // because linkedCoverDocId was empty — now the fallback resolves it.
  const showOneTap = walletAllowed && !!resolvedCoverDocId && !reservation.linkedCoverPending;
  const oneTapDisabled = oneTapBusy || payable <= 0 || linkedBal <= 0 || linkedAlreadyRedeemed;
  const oneTapAmount = Math.min(payable, linkedBal);
  const oneTapRedeem = async () => {
    if (oneTapDisabled || !resolvedCoverDocId) return;
    setOneTapBusy(true); setWalletErr("");
    try {
      const billCap = payable + walletPaidSoFar;
      // Pass the redeem amount as MIN(payable, balance) so the cover never
      // overdrafts. redeemFromWalletAtTable's transaction also has its own
      // insufficient-balance guard — this is belt + suspenders.
      const redeemAmt = Math.min(payable, linkedBal);
      await redeemFromWalletAtTable(
        reservation._docId,
        resolvedCoverDocId,
        redeemAmt,
        captainName,
        billCap
      );
    } catch (e: any) {
      setWalletErr(e?.message || String(e));
    }
    setOneTapBusy(false);
  };
  // walletAllowed hoisted above linked-wallet block (see 2026-05-20 note).

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
    // 🆕 2026-06-25 (Khushi) — COMPLIMENTARY: comp the WHOLE bill to ₹0. Needs a
    // reason, who approved it, and a Manager OTP/PIN (same gate as discounts).
    // Self-contained money path: records amountPaid 0 + the comped gross value.
    if (payMethod === "complimentary") {
      if (walletPaidSoFar > 0) { setError("Undo the wallet redemption(s) before marking this bill complimentary."); return; }
      if (!compReason.trim()) { setError("Enter a reason for the complimentary bill."); return; }
      if (!compApprovedBy.trim()) { setError("Enter who approved the complimentary bill."); return; }
      if (!compApproved) {
        const ok = await requireManagerApproval(
          `COMPLIMENTARY — comp the WHOLE ₹${finalAmount} bill to ₹0.\n` +
          `Reason: ${compReason.trim()}\nApproved by: ${compApprovedBy.trim()}\n\n` +
          `Manager OTP/PIN required to give a complimentary bill.`,
          { by: captainName, tableId: reservation.tableId, amount: finalAmount },
        );
        if (!ok) { setError("Manager approval required for a complimentary bill."); return; }
        setCompApproved(true);
      }
      setSaving(true);
      try {
        await markTablePaid(reservation._docId, {
          amount: 0,
          method: "complimentary",
          captainName,
          complimentary: true,
          complimentaryReason: compReason.trim(),
          complimentaryApprovedBy: compApprovedBy.trim(),
          complimentaryValue: finalAmount,
          serviceChargeAmount: scAmt || undefined,
          serviceChargeApplied: serviceCharge,
          taxAmount: taxAmt || undefined,
        }, reservation.bookingRef);
        // Best-effort print: comped bill (₹0 due, COMPLIMENTARY stamp). Fire-and-
        // forget — settlement is already saved, a printer failure must not block.
        try {
          const printItems = allItems
            .filter((it) => it && (it.qty || 0) > 0)
            .map((it) => ({ n: it.n, p: it.p || 0, qty: it.qty || 0 }));
          if (printItems.length > 0) {
            const id = (reservation.tableId || "").toUpperCase();
            let floor: TabletFloor = "first";
            if (id.startsWith("C")) floor = "ground";
            else if (id.startsWith("T")) floor = "rooftop";
            else if (id.startsWith("FD") || id.startsWith("SMK")) floor = "first";
            const sBillBase = reservation._docId.slice(-6).toUpperCase();
            const sPrevCount = reservation.billPrintCount || 0;
            const sBillNumber = `${sBillBase}-${sPrevCount + 1}`;
            const sIsDuplicate = sPrevCount > 0;
            runBillBookkeepingBg(() => recordBillPrint(reservation._docId, {
              by: captainName, total: 0, discountPct: 0,
              aggregator: aggName, billNumberBase: sBillBase,
            }));
            printBill({
              tableId: reservation.tableId, floorLabel: reservation.floorLabel,
              customerName: reservation.customerName, partySize: (reservation as any).partySize, staff: captainName,
              items: printItems,
              amounts: {
                subtotal: discBreakdown.subtotal, serviceCharge: scAmt,
                cgst: discBreakdown.cgst, sgst: discBreakdown.sgst,
                discount: discountAmt, roundOff: 0, total: 0,
                discountPct,
              },
              paymentMethod: "COMPLIMENTARY",
              billNumber: sBillNumber, isDuplicate: sIsDuplicate, tabletFloor: floor,
            }).catch((e) => console.warn("[comp settle print] failed", e));
          }
        } catch { /* best-effort — settlement already saved */ }
        clearSettleRequest(reservation._docId);
        onClose();
      } catch (e: any) { setError(e.message || String(e)); }
      setSaving(false);
      return;
    }
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
    // 🔴 2026-06-26 (Khushi) — BLANK aggregator discount guard. If the captain
    // cleared the prefilled platform discount and left the field empty, don't
    // silently settle at full price. Remind them of the platform's preset % and
    // make them type the correct discount (30, 32, or 0) before Confirm Payment.
    if (payMethod === "aggregator" && aggDiscRaw.trim() === "") {
      setShowAggDiscWarn(true);
      // Persistent inline backup after the popup is dismissed — stays until the
      // captain types a discount (onChange clears it).
      setError(`⚠ Enter the ${aggShortName} discount % (this table is ${aggDiscount}%) — type ${aggDiscount}, 32, or 0, then Confirm Payment.`);
      return;
    }
    // 🆕 2026-06-26 (Khushi) — AGGREGATOR discount reminder. When a platform
    // discount is applied (e.g. Swiggy 30%), tapping Confirm Payment first shows
    // a branded "are you sure?" popup so the captain can't settle a discounted
    // aggregator bill by accident. A deliberate Yes proceeds; Cancel aborts with
    // nothing written. (Aggregators skip the Manager-OTP gate by design — this is
    // a confirmation, not an approval.)
    if (payMethod === "aggregator" && (aggEditDiscount || 0) > 0) {
      const proceed = await centeredConfirm(
        `${aggShortName} ${aggEditDiscount}% discount applied`,
        `The guest paid ${aggShortName} after a ${aggEditDiscount}% discount.\n` +
          `Venue collects ₹${aggregatorNetAmount ?? finalAmount} (net) — ₹${finalAmount} is printed for the guest.\n\n` +
          `Are you sure you want to settle this bill?`,
        "✓ Yes, Confirm",
        "Cancel",
        true,
      );
      if (!proceed) return;
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
    // 🔴 2026-05-26 (Khushi) — AUTHORITATIVE non-zero discount gate at commit
    // time (defense-in-depth — the onBlur PIN gate is a UX pre-check only).
    // Skip when: aggregator-published discount EXACTLY matches OR the captain
    // already cleared the PIN gate for THIS specific pct in the input field
    // (tracked via discountApprovedPct, invalidated on any keystroke).
    if (discountPct > 0 && payMethod !== "aggregator") {
      const aggRateMatchAtCommit =
        aggName !== "inhouse" && Number(discountPct) === Number(aggDiscount);
      const alreadyApprovedHere = discountApprovedPct === discountPct;
      if (!aggRateMatchAtCommit && !alreadyApprovedHere) {
        const ok = await requireManagerApproval(
          `Confirm ${discountPct}% discount on ₹${tabTotal} tab\n` +
          `(value: ₹${discountAmt})\n\n` +
          `Any non-zero discount needs a Manager OTP/PIN before billing.`,
          { by: captainName, tableId: reservation.tableId, discountPct, amount: tabTotal },
        );
        if (!ok) { setError("Manager approval required for this discount."); return; }
        setDiscountApprovedPct(discountPct);
        overrides.push({
          kind: "high-discount", valueBefore: 0, valueAfter: discountPct,
          tabTotal, reason: "any-discount commit-time gate",
        });
      }
    }
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
        // 🆕 2026-06-26 (Khushi) — aggregator bills now COLLECT the discounted
        // NET (the guest already paid the platform that price). amountPaid = net;
        // the full bill (gross) is kept in aggregatorGrossAmount for reports. Cash/
        // card/UPI/in-house paths are unchanged (collect the full finalAmount).
        amount: payMethod === "aggregator" ? (aggregatorNetAmount ?? finalAmount) : finalAmount,
        method: methodLabel,
        captainName,
        // 2026-05-15 — sum of walletRedemptions[].amount; reports subtract this
        // from `amount` to get true cash/card/UPI collected for EOD reconcile.
        walletPaidAmount: walletPaidSoFar > 0 ? walletPaidSoFar : undefined,
        aggregator: payMethod === "aggregator" ? aggName : undefined,
        aggregatorDiscount: payMethod === "aggregator" ? aggEditDiscount : undefined,
        // 🆕 2026-06-26 — the FULL printed invoice (gross) before the platform
        // discount. amountPaid is now the NET, so reports read this to show what
        // was BILLED to the guest vs what the venue RECEIVED.
        aggregatorGrossAmount: payMethod === "aggregator" ? finalAmount : undefined,
        // 🔴 Net amount the venue receives from the aggregator after their
        // platform discount is settled. Reports show this side-by-side with
        // the gross so admin can reconcile what was billed vs what was paid.
        aggregatorNetAmount,
        discountPercent: discountPct || undefined,
        discountAmount: discountAmt || undefined,
        serviceChargeAmount: scAmt || undefined,
        serviceChargeApplied: serviceCharge,
        taxAmount: taxAmt || undefined,
        overrideEntries: overrides.length > 0 ? overrides : undefined,
        splits,
      }, reservation.bookingRef);
      // 🆕 2026-06-12 v3.268 (Khushi) — SETTLE BILL now also prints the FINAL
      // settled bill (carrying the captain's discount / SC changes), mirroring
      // the dedicated "🖨 Print Bill" button. Best-effort & AFTER the money is
      // saved: a printer failure must NEVER block or reverse a completed
      // settlement. Uses the SAME discount-aware breakdown shown on this modal
      // (discBreakdown) so the paper === what the captain just settled.
      try {
        const printItems = allItems
          .filter((it) => it && (it.qty || 0) > 0)
          .map((it) => ({ n: it.n, p: it.p || 0, qty: it.qty || 0 }));
        if (printItems.length > 0) {
          const id = (reservation.tableId || "").toUpperCase();
          let floor: TabletFloor = "first";
          if (id.startsWith("C")) floor = "ground";
          else if (id.startsWith("T")) floor = "rooftop";
          else if (id.startsWith("FD") || id.startsWith("SMK")) floor = "first";
          // ⚡ 2026-06-25 — print the settled bill INSTANTLY. recordBillPrint is a
          // Firestore transaction that stalls on slow venue wifi; the bill number
          // + audit log are bookkeeping (no money), so derive the number from live
          // state and persist the record in the background (settlement is already
          // saved above). Fail-open: a failed bg write loses one audit row.
          const sBillBase = reservation._docId.slice(-6).toUpperCase();
          const sPrevCount = reservation.billPrintCount || 0;
          const sBillNumber = `${sBillBase}-${sPrevCount + 1}`;
          const sIsDuplicate = sPrevCount > 0;
          runBillBookkeepingBg(() => recordBillPrint(reservation._docId, {
            by: captainName, total: finalAmount, discountPct,
            aggregator: aggName, billNumberBase: sBillBase,
          }));
          // ⚡ 2026-06-25 — FIRE-AND-FORGET (see confirmAndPrint note). Don't block
          // settlement-complete on the print job's SERVER ack; the job is queued
          // durably the instant we call printBill. Settlement money is already saved.
          printBill({
            tableId: reservation.tableId, floorLabel: reservation.floorLabel,
            customerName: reservation.customerName, partySize: (reservation as any).partySize, staff: captainName,
            items: printItems,
            amounts: {
              subtotal: discBreakdown.subtotal, serviceCharge: scAmt,
              cgst: discBreakdown.cgst, sgst: discBreakdown.sgst,
              discount: discountAmt, roundOff: 0, total: finalAmount,
              discountPct,
            },
            paymentMethod: methodLabel,
            billNumber: sBillNumber, isDuplicate: sIsDuplicate, tabletFloor: floor,
          }).catch((e) => console.warn("[settle auto-print] bill print failed", e));
        }
      } catch { /* best-effort — settlement is already saved, printer is secondary */ }
      // 🆕 2026-06-25 (Khushi) — bill is settled, so drop any pending
      // "NOTIFY SUPERVISOR" flag (fire-and-forget, fail-open) so the SETTLE BILL
      // tab stops blinking for this table.
      clearSettleRequest(reservation._docId);
      onClose();
    } catch (e: any) { setError(e.message); }
    setSaving(false);
  };

  const methods = payMethod === "aggregator"
    ? [{ key: "aggregator", label: `💼 Paid by ${aggShortName}` }]
    : [{ key: "cash", label: "💵 Cash" }, { key: "card", label: "💳 Card" }, { key: "upi", label: "📱 UPI" }];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 20, padding: 24, width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto" }}>
        {/* 🆕 2026-06-25 (Khushi) — Gumroad header: ← BACK + title, 2px frame. */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, paddingBottom: 14, borderBottom: "2px solid #000" }}>
          <button onClick={onClose}
            style={{ flexShrink: 0, padding: "8px 14px", borderRadius: 10, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900, cursor: "pointer", letterSpacing: 0.4 }}>
            ← BACK
          </button>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#000", lineHeight: 1.1 }}>💸 Settle Bill</div>
            <div style={{ fontSize: 13, color: "#6B6B6B", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {reservation.tableId} · {reservation.customerName}
            </div>
          </div>
        </div>

        {/* ── 2026-05-20 — COVER+TABLE LINKED WALLET BANNER (Khushi spec) ──
            Surfaces the door-linked wallet at the TOP of Mark Paid so the
            captain can't miss it. Live balance · auto-hides once redeemed. */}
        {showOneTap && !linkedAlreadyRedeemed && linkedBal > 0 && (
          <div style={{ marginBottom: 16, padding: "10px 12px", borderRadius: 10,
            background: "linear-gradient(135deg,#E6F5F2,#E6F5F2)",
            border: "1px solid #23A094",
            display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 900, color: "#23A094", letterSpacing: 0.5, marginBottom: 2 }}>
                💰 WALLET LINKED AT DOOR
              </div>
              <div style={{ fontSize: 12, color: "#6B6B6B", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {(linkedCover?.name || reservation.customerName || "—")} · {reservation.linkedCoverRef || ""}
              </div>
            </div>
            <div style={{ fontSize: 21, fontWeight: 900, color: "#23A094", whiteSpace: "nowrap" }}>
              {formatINR(linkedBal)}
            </div>
          </div>
        )}

        <div style={{ background: "#FBF3D6", border: "1px solid #FBF3D6", borderRadius: 12, padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 16, marginBottom: 6 }}>
            <span style={{ color: "#6B6B6B" }}>Tab Total</span>
            <span style={{ fontWeight: 800, color: "#000" }}>{formatINR(tabTotal)}</span>
          </div>
          {discountPct > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 16, marginBottom: 6 }}>
              <span style={{ color: "#FF5733" }}>Discount ({discountPct}%)</span>
              <span style={{ fontWeight: 800, color: "#FF5733" }}>-{formatINR(discountAmt)}</span>
            </div>
          )}
          {/* 🔴 2026-05-12 — Aggregator info-only line. Customer pays the
              full invoice; admin reports record the platform-net separately. */}
          {/* 🆕 2026-06-26 (Khushi) — aggregator: the FULL bill is still PRINTED to
              the guest, but the venue COLLECTS the discounted net. Show both so the
              captain sees what was billed vs what the venue receives. */}
          {payMethod === "aggregator" && (
            <div style={{ marginTop: 4, padding: "6px 8px", borderRadius: 4,
              background: "#FFF0EC", border: "1px solid #FF5733",
              fontSize: 12, color: "#FF5733", lineHeight: 1.5 }}>
              ℹ Full ₹{formatINR(finalAmount)} is PRINTED to the guest.
              {aggEditDiscount > 0
                ? <> After {aggName.toUpperCase()} {aggEditDiscount}% — venue collects <b>{formatINR(aggregatorNetAmount || 0)}</b>.</>
                : <> No platform discount — venue collects the full ₹{formatINR(finalAmount)}.</>}
            </div>
          )}
          {serviceCharge && (
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 16, marginBottom: 6 }}>
              <span style={{ color: "#6B6B6B" }}>Service Charge (10%)</span>
              <span style={{ fontWeight: 700, color: "#6B6B6B" }}>+{formatINR(scAmt)}</span>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 16, marginBottom: 6 }}>
            <span style={{ color: "#6B6B6B" }}>GST (5%)</span>
            <span style={{ fontWeight: 700, color: "#6B6B6B" }}>+{formatINR(taxAmt)}</span>
          </div>
          <div style={{ borderTop: "1px solid #000", paddingTop: 8, display: "flex", justifyContent: "space-between", fontSize: 19 }}>
            <span style={{ fontWeight: 900, color: "#000" }}>Final Amount</span>
            <span style={{ fontWeight: 900, color: "#000" }}>{formatINR(finalAmount)}</span>
          </div>
        </div>

        {/* ── 2026-05-15 — Khushi: Captain × Cover wallet redemption ── */}
        <div style={{ marginBottom: 16, padding: 12, borderRadius: 12,
          background: walletPaidSoFar > 0 ? "#E6F5F2" : "#FBF3D6",
          border: `1px solid ${walletPaidSoFar > 0 ? "#23A094" : "#000"}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: walletRedemptions.length > 0 ? 10 : 0 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: walletPaidSoFar > 0 ? "#23A094" : "#000", letterSpacing: 0.5 }}>
              🎫 CUSTOMER WALLET
            </span>
            {walletPaidSoFar > 0 && (
              <span style={{ fontSize: 13, fontWeight: 800, color: "#23A094" }}>
                {formatINR(walletPaidSoFar)} REDEEMED
              </span>
            )}
          </div>

          {walletRedemptions.map((w) => (
            <div key={w.txId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", marginBottom: 4, borderRadius: 6, background: "#F4F4F0", border: "1px solid #000" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#000", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {w.walletName || "—"} <span style={{ color: "#6B6B6B", fontWeight: 500 }}>· {w.walletPhone || "—"}</span>
                </div>
                <div style={{ fontSize: 11, color: "#6B6B6B", fontFamily: "monospace" }}>{w.walletRef}</div>
              </div>
              <div style={{ fontSize: 16, fontWeight: 900, color: "#23A094" }}>−{formatINR(w.amount)}</div>
            </div>
          ))}

          {walletErr && (
            <div style={{ marginTop: 6, padding: 6, borderRadius: 4, background: "#FFF0EC", color: "#FF5733", fontSize: 12, fontWeight: 600 }}>⚠ {walletErr}</div>
          )}

          {walletPaidSoFar > 0 && (
            payable === 0 ? (
              <div style={{ marginTop: 8, padding: "10px 12px", borderRadius: 8, background: "#E6F5F2", border: "1px solid #23A094", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 16 }}>
                <span style={{ color: "#6B6B6B", fontWeight: 700 }}>Remaining</span>
                <span style={{ fontWeight: 900, color: "#23A094" }}>✅ FULLY PAID BY WALLET</span>
              </div>
            ) : (
              // 🔴 2026-05-15 (Khushi spec) — when wallet only PARTIALLY covers
              // the bill, the captain MUST physically collect ₹{payable} from
              // the customer in cash/card/UPI. Make this number unmissable so
              // bartenders/captains in a noisy floor don't accidentally close
              // a bill thinking the wallet covered everything.
              <div style={{ marginTop: 10, padding: "14px 16px", borderRadius: 10,
                background: "linear-gradient(135deg,#FBF3D6,#FFF0EC)",
                border: "2px solid #000",
                boxShadow: "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: "#000", letterSpacing: 0.6 }}>STILL TO COLLECT</span>
                    <span style={{ fontSize: 12, color: "#6B6B6B", fontWeight: 600 }}>from customer · cash / card / UPI</span>
                  </div>
                  <span style={{ fontSize: 32, fontWeight: 900, color: "#000", lineHeight: 1, letterSpacing: -0.5 }}>
                    {formatINR(payable)}
                  </span>
                </div>
              </div>
            )
          )}

          {/* ── 2026-05-20 — COVER+TABLE LINKED WALLET 1-TAP REDEEM (Khushi spec) ──
              Door girl already linked a wallet to this table. Show a BIG green
              1-tap button that calls redeemFromWalletAtTable directly with the
              known linkedCoverDocId — no QR scan, no phone lookup. The scanner
              button still appears below as a fallback (guest #2's wallet, or if
              the linked wallet is empty / already redeemed). */}
          {showOneTap && payable > 0 && !linkedAlreadyRedeemed && linkedBal > 0 && (
            <button onClick={oneTapRedeem} disabled={oneTapDisabled}
              style={{ marginTop: walletRedemptions.length > 0 ? 10 : 0, width: "100%", padding: 14, borderRadius: 10,
                background: oneTapDisabled
                  ? "#E6F5F2"
                  : "#23A094",
                border: "1px solid #000", color: oneTapDisabled ? "#000" : "#fff",
                fontSize: 17, fontWeight: 900, cursor: oneTapDisabled ? "not-allowed" : "pointer",
                boxShadow: "none",
                fontFamily: "'Manrope','Space Grotesk',sans-serif", letterSpacing: 0.3 }}>
              {oneTapBusy
                ? "Redeeming…"
                : `💰 USE LINKED WALLET · ${formatINR(oneTapAmount)} (1 TAP)`}
              <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.85, marginTop: 3, letterSpacing: 0.5 }}>
                {(linkedCover?.name || reservation.customerName || "—").toUpperCase()} · BAL {formatINR(linkedBal)}
              </div>
            </button>
          )}
          {showOneTap && linkedAlreadyRedeemed && (
            <div style={{ marginTop: walletRedemptions.length > 0 ? 10 : 0, padding: "8px 10px", borderRadius: 8,
              background: "#E6F5F2", border: "1px dashed #23A094",
              fontSize: 12, color: "#6B6B6B", textAlign: "center", fontWeight: 600 }}>
              ✓ LINKED WALLET ALREADY APPLIED TO THIS BILL
            </div>
          )}
          {showOneTap && linkedBal <= 0 && !linkedAlreadyRedeemed && (
            <div style={{ marginTop: walletRedemptions.length > 0 ? 10 : 0, padding: "8px 10px", borderRadius: 8,
              background: "#fff", border: "1px dashed #000",
              fontSize: 12, color: "#000", textAlign: "center", fontWeight: 600 }}>
              💰 LINKED WALLET FULLY SPENT (likely at GF BAR) — use scanner below for any other wallet
            </div>
          )}

          {payable > 0 && walletAllowed && (
            <button onClick={() => { setWalletErr(""); setShowWalletScan(true); }}
              style={{ marginTop: (walletRedemptions.length > 0 || showOneTap) ? 10 : 0, width: "100%", padding: 12, borderRadius: 10,
                background: "linear-gradient(135deg,#FBF3D6,#FFF0EC)",
                border: "1px solid #000", color: "#000", fontSize: 16, fontWeight: 900, cursor: "pointer" }}>
              {walletRedemptions.length === 0 && !showOneTap
                ? `🎫 REDEEM FROM WALLET (${formatINR(payable)})`
                : "🎫 SCAN ANOTHER WALLET"}
            </button>
          )}

          {!walletAllowed && (
            <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: "#FFF0EC", border: "1px dashed #FF5733", fontSize: 12, color: "#6B6B6B", textAlign: "center", fontWeight: 600 }}>
              Wallet redemption blocked on aggregator bills (Q6 spec)
            </div>
          )}
        </div>

        {/* 🔴 2026-05-26 (Khushi spec) — Service Charge MUST stay ON. To toggle
            OFF, the captain has to enter the Manager PIN via the centered modal
            (no browser popup). Turning back ON is free (1 tap). */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <button onClick={async () => {
            if (serviceCharge) {
              const ok = await requireManagerPin(
                "Service Charge is DEFAULT ON.\n\nTurning it OFF removes the 10% staff service charge from this bill.\n\nManager PIN required to disable.",
              );
              if (!ok) return;
            }
            setServiceCharge(!serviceCharge);
          }}
            style={{ width: 40, height: 22, borderRadius: 11, border: "2px solid #000", boxSizing: "border-box", cursor: "pointer", position: "relative",
              background: serviceCharge ? "#23A094" : "#fff", transition: "background .2s" }}>
            <div style={{ width: 16, height: 16, borderRadius: 8, background: "#fff", border: "1.5px solid #000", boxSizing: "border-box", position: "absolute", top: 1,
              left: serviceCharge ? 21 : 3, transition: "left .2s" }} />
          </button>
          <span style={{ fontSize: 14, color: "#6B6B6B" }}>
            Service Charge (10%) {!serviceCharge && <span style={{ color: "#FF5733", fontWeight: 800, fontSize: 11, marginLeft: 6 }}>· WAIVED</span>}
          </span>
        </div>

        {isAggregator && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 8 }}>Payment Channel</div>
            <div style={{ display: "flex", gap: 8 }}>
              {["aggregator", "inhouse"].map((ch) => (
                <button key={ch} onClick={() => setPayMethod(ch === "inhouse" ? "cash" : "aggregator")}
                  style={{ flex: 1, padding: 10, borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", border: "1px solid",
                    background: (ch === "aggregator" ? payMethod === "aggregator" : payMethod !== "aggregator") ? "#FBF3D6" : "#fff",
                    borderColor: (ch === "aggregator" ? payMethod === "aggregator" : payMethod !== "aggregator") ? "#000" : "#6B6B6B",
                    color: (ch === "aggregator" ? payMethod === "aggregator" : payMethod !== "aggregator") ? "#000" : "#6B6B6B" }}>
                  {ch === "aggregator" ? `💼 Paid by ${aggShortName}` : "Pay In-House"}
                </button>
              ))}
            </div>
            {/* 🆕 2026-06-26 (Khushi) — EDITABLE aggregator discount. Prefilled with
                the platform's published rate; the captain can change it freely (no
                Manager PIN). The guest's printed bill stays at full price; the venue
                COLLECTS gross − this %. Net shown live below. */}
            {payMethod === "aggregator" && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 6, fontWeight: 700 }}>
                  {aggShortName} discount % <span style={{ color: "#6B6B6B", fontWeight: 600, fontSize: 11 }}>· venue collects the net</span>
                </div>
                {/* 🔴 2026-06-26 (Khushi) — onWheel blur: a focused number input
                    changes its value on trackpad/mouse scroll, so the discount
                    silently crept up/down while the captain scrolled the modal.
                    Blurring on wheel makes the field STATIC — only typing changes it. */}
                <input type="number" value={aggDiscRaw}
                  onWheel={(e) => e.currentTarget.blur()}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setAggDiscRaw(raw);
                    setAggEditDiscount(Math.min(100, Math.max(0, Number(raw) || 0)));
                    if (error) setError("");
                  }}
                  placeholder={`e.g. ${aggDiscount}`} min={0} max={100}
                  style={{ width: "100%", padding: "10px 14px", borderRadius: 10, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 17, fontWeight: 800, outline: "none", boxSizing: "border-box", fontFamily: "'Manrope','Space Grotesk',sans-serif" }} />
                <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "#E6F5F2", border: "2px solid #23A094", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: "#23A094", letterSpacing: 0.3 }}>VENUE COLLECTS (NET)</span>
                  <span style={{ fontSize: 19, fontWeight: 900, color: "#23A094" }}>{formatINR(aggregatorNetAmount ?? finalAmount)}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 11, color: "#6B6B6B", fontWeight: 600 }}>
                  Full ₹{formatINR(finalAmount)} is still printed for the guest.
                </div>
              </div>
            )}
          </div>
        )}

        {payMethod !== "aggregator" && payMethod !== "complimentary" && payable > 0 && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 13, color: "#6B6B6B" }}>Payment Method · ₹{payable} owed</span>
              <button onClick={() => { setSplitMode(!splitMode); setError(""); if (!splitMode) { setSplitCash(payable); setSplitCard(0); setSplitUpi(0); } }}
                style={{ padding: "4px 10px", borderRadius: 8, fontSize: 13, fontWeight: 800, cursor: "pointer",
                  background: splitMode ? "#FF5733" : "#fff",
                  border: "1px solid #000",
                  color: splitMode ? "#fff" : "#6B6B6B" }}>
                {splitMode ? "✓ SPLIT MODE ON" : "🔀 SPLIT PAYMENT"}
              </button>
            </div>
            {!splitMode && (
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                {methods.map((m) => (
                  <button key={m.key} onClick={() => setPayMethod(m.key)}
                    style={{ flex: 1, padding: 10, borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer",
                      background: payMethod === m.key ? "#FBF3D6" : "#fff",
                      border: `1px solid ${payMethod === m.key ? "#000" : "#6B6B6B"}`,
                      color: payMethod === m.key ? "#000" : "#6B6B6B" }}>
                    {m.label}
                  </button>
                ))}
              </div>
            )}
            {splitMode && (
              <div style={{ marginBottom: 16, padding: 12, borderRadius: 10, background: "#FFF0EC", border: "1px solid #FF5733" }}>
                {([
                  { k: "cash", label: "💵 Cash", val: splitCash, set: setSplitCash },
                  { k: "card", label: "💳 Card", val: splitCard, set: setSplitCard },
                  { k: "upi",  label: "📱 UPI",  val: splitUpi,  set: setSplitUpi  },
                ] as const).map((row) => (
                  <div key={row.k} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <span style={{ width: 70, fontSize: 14, fontWeight: 700, color: "#000" }}>{row.label}</span>
                    <span style={{ fontSize: 17, color: "#6B6B6B" }}>₹</span>
                    <input type="number" value={row.val || ""} onChange={(e) => row.set(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                      placeholder="0" min={0}
                      style={{ flex: 1, padding: "8px 10px", borderRadius: 8, background: "#fff", border: "1px solid #000", color: "#000", fontSize: 17, outline: "none", boxSizing: "border-box" }} />
                  </div>
                ))}
                <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, borderTop: "1px solid #FF5733", fontSize: 14 }}>
                  <span style={{ color: "#6B6B6B" }}>Split sum</span>
                  <span style={{ fontWeight: 800, color: splitDiff === 0 ? "#000" : "#FF5733" }}>
                    ₹{splitTotal} / ₹{payable} {splitDiff !== 0 && `(${splitDiff > 0 ? "short" : "over"} ₹${Math.abs(splitDiff)})`}
                  </span>
                </div>
              </div>
            )}
            <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 4 }}>
              Discount % <span style={{ color: "#FF5733", fontWeight: 800, fontSize: 11 }}>· MANAGER PIN REQUIRED</span>
            </div>
            <div style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 8, lineHeight: 1.4 }}>
              Every discount — even 5% — needs a manager. Aggregator bills (Zomato/EazyDiner) bypass this.
            </div>
            {/* 🔴 2026-05-26 (Khushi spec) — D4 + ZERO TOLERANCE: ANY non-zero
                discount needs Manager PIN now. Old behaviour only gated >25%.
                Aggregator bills bypass (discount is preset by platform). */}
            <input type="number" value={manualDiscount || ""}
              onWheel={(e) => e.currentTarget.blur()}
              onChange={(e) => {
                setManualDiscount(Math.min(CAPTAIN_DISCOUNT_MAX, Math.max(0, Number(e.target.value) || 0)));
                // Any keystroke invalidates a prior PIN approval — confirm()
                // will re-prompt unless the captain re-approves the new value.
                setDiscountApprovedPct(null);
              }}
              onBlur={(e) => {
                // 🔴 BUG FIX 2026-06-25 (Khushi) — DO NOT fire the Manager-OTP/PIN
                // prompt on blur. It used to pop a SEPARATE approval here AND again
                // in confirm(), so after a successful OTP + pay the blur-triggered
                // prompt (rendered at app level) lingered on screen even after the
                // bill was PAID. The ONE authoritative approval now lives in
                // confirm() at commit time. On blur we only NORMALISE the value.
                const raw = Number(e.target.value) || 0;
                const clamped = clampCaptainDiscount(raw);
                setManualDiscount(clamped === null ? 0 : clamped);
                setDiscountApprovedPct(null);
              }}
              placeholder={`max ${CAPTAIN_DISCOUNT_MAX}%`} min={0} max={CAPTAIN_DISCOUNT_MAX}
              style={{ width: "100%", padding: "10px 14px", borderRadius: 10, background: "#fff", border: "1px solid #000", color: "#000", fontSize: 17, outline: "none", marginBottom: 16, boxSizing: "border-box" }} />
          </>
        )}

        {/* 🆕 2026-06-25 (Khushi) — COMPLIMENTARY: comp the whole bill to ₹0.
            Needs a reason + who approved + Manager OTP/PIN. Hidden once a wallet
            redemption is on the bill (undo it first). */}
        {walletPaidSoFar === 0 && (
          <div style={{ marginBottom: 16 }}>
            <button onClick={() => {
                if (payMethod === "complimentary") { setPayMethod(isAggregator ? "aggregator" : "cash"); setError(""); return; }
                setPayMethod("complimentary"); setSplitMode(false); setError("");
              }}
              style={{ width: "100%", padding: 12, borderRadius: 12, fontSize: 15, fontWeight: 900, cursor: "pointer",
                background: payMethod === "complimentary" ? "#FF90E8" : "#fff",
                border: "2px solid #000", color: "#000", letterSpacing: 0.3 }}>
              🎁 {payMethod === "complimentary" ? "COMPLIMENTARY — SELECTED" : "MARK COMPLIMENTARY (₹0)"}
            </button>
            {payMethod === "complimentary" && (
              <div style={{ marginTop: 10, padding: 14, borderRadius: 12, background: "#FFF0FA", border: "2px solid #FF90E8" }}>
                <div style={{ fontSize: 13, fontWeight: 900, color: "#000", marginBottom: 4, letterSpacing: 0.4 }}>
                  WHOLE BILL COMPED · {formatINR(finalAmount)} → ₹0
                </div>
                <div style={{ fontSize: 11, color: "#6B6B6B", fontWeight: 600, marginBottom: 12 }}>
                  Manager OTP/PIN required before confirming.
                </div>
                <div style={{ fontSize: 12, fontWeight: 800, color: "#000", marginBottom: 4 }}>Reason</div>
                <input value={compReason} onChange={(e) => { setCompReason(e.target.value); setCompApproved(false); }}
                  placeholder="e.g. owner's guest, service recovery"
                  style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 15, outline: "none", boxSizing: "border-box", marginBottom: 12 }} />
                <div style={{ fontSize: 12, fontWeight: 800, color: "#000", marginBottom: 4 }}>Approved by</div>
                <input value={compApprovedBy} onChange={(e) => { setCompApprovedBy(e.target.value); setCompApproved(false); }}
                  placeholder="manager name"
                  style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 15, outline: "none", boxSizing: "border-box" }} />
                {compApproved && (
                  <div style={{ marginTop: 12, padding: "6px 10px", borderRadius: 8, background: "#E6F5F2", border: "2px solid #23A094", fontSize: 12, fontWeight: 900, color: "#23A094", textAlign: "center" }}>
                    ✅ MANAGER APPROVED
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {error && <div style={{ fontSize: 14, color: "#FF5733", marginBottom: 10 }}>{error}</div>}

        <button onClick={() => {
            // 🔴 2026-05-15 (Khushi spec) — when wallet only partially covers
            // a bill, force the captain to acknowledge that the leftover
            // ₹{payable} was physically collected from the customer BEFORE
            // closing the bill. Plain wallet-only and no-wallet flows skip
            // the prompt — only mixed wallet+cash needs the double-check.
            if (payable > 0 && walletPaidSoFar > 0) { setShowCollectConfirm(true); return; }
            confirm();
          }} disabled={saving}
          style={{ width: "100%", padding: 14, borderRadius: 12, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 18, fontWeight: 900, cursor: "pointer", marginBottom: 10 }}>
          {saving ? "Saving..." : (payable === 0 && walletPaidSoFar > 0 ? "✅ Close Bill (Wallet Paid)" : "✅ Confirm Payment")}
        </button>
        <button onClick={onClose} style={{ width: "100%", padding: 12, borderRadius: 12, background: "transparent", border: "none", color: "#6B6B6B", fontSize: 16, cursor: "pointer" }}>Cancel</button>
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
        <div onClick={closeOnBackdrop(() => setShowCollectConfirm(false))}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", backdropFilter: "blur(8px)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10001, padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 420, background: "linear-gradient(155deg,#fff 0%,#fff 70%,#F4F4F0 100%)",
              border: "2px solid #000", borderRadius: 16,
              boxShadow: "none",
              padding: 24, color: "#000", fontFamily: "inherit" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
              <span style={{ fontSize: 26 }}>⚠️</span>
              <span style={{ fontSize: 16, fontWeight: 900, color: "#000", letterSpacing: 1.2, textTransform: "uppercase" }}>Collect From Customer</span>
            </div>

            <div style={{ padding: "22px 16px", marginBottom: 16, borderRadius: 12,
              background: "linear-gradient(135deg,#FBF3D6,#FFF0EC)",
              border: "1px solid #000", textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#6B6B6B", letterSpacing: 0.8, marginBottom: 6 }}>STILL TO COLLECT</div>
              <div style={{ fontSize: 48, fontWeight: 900, color: "#111", lineHeight: 1, letterSpacing: -1 }}>
                {formatINR(payable)}
              </div>
              <div style={{ fontSize: 13, color: "#6B6B6B", fontWeight: 600, marginTop: 8 }}>
                via {splitMode ? "SPLIT" : (payMethod || "cash").toUpperCase()}
              </div>
            </div>

            <div style={{ padding: "10px 12px", marginBottom: 14, borderRadius: 8,
              background: "#E6F5F2", border: "1px solid #23A094",
              fontSize: 13, color: "#6B6B6B", fontWeight: 600, textAlign: "center" }}>
              Wallet already covered <span style={{ color: "#23A094", fontWeight: 900 }}>{formatINR(walletPaidSoFar)}</span>
            </div>

            <div style={{ fontSize: 16, color: "#000", fontWeight: 700, lineHeight: 1.5, marginBottom: 18, textAlign: "center" }}>
              Have you actually collected <span style={{ color: "#000", fontWeight: 900 }}>{formatINR(payable)}</span> from the customer?
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setShowCollectConfirm(false)}
                style={{ flex: 1, padding: 14, borderRadius: 10, background: "#fff",
                  border: "1px solid #000", color: "#000",
                  fontSize: 16, fontWeight: 800, cursor: "pointer", letterSpacing: 0.5 }}>
                ❌ NOT YET
              </button>
              <button onClick={() => { setShowCollectConfirm(false); confirm(); }}
                style={{ flex: 1.4, padding: 14, borderRadius: 10,
                  background: "#FF90E8",
                  border: "none", color: "#000", fontSize: 16, fontWeight: 900, cursor: "pointer", letterSpacing: 0.5,
                  boxShadow: "none" }}>
                ✅ YES — CLOSE BILL
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🔴 2026-06-26 (Khushi) — BLANK aggregator-discount reminder POPUP. Fired
          from confirm() when the captain cleared the discount field on a Zomato/
          Swiggy/etc table and tapped Confirm Payment. Gumroad-themed (warning red
          header), sits above the MarkPaidModal (z 10001). They tap OK, type the
          right discount (e.g. 30/32/0), then Confirm Payment again. No money write
          happens until a discount is entered. */}
      {showAggDiscWarn && (
        <div onClick={closeOnBackdrop(() => setShowAggDiscWarn(false))}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", backdropFilter: "blur(8px)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10002, padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 420, background: "#fff",
              border: "2px solid #000", borderRadius: 16, boxShadow: "6px 6px 0 #000",
              padding: 24, color: "#000", fontFamily: "inherit" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <span style={{ fontSize: 26 }}>⚠️</span>
              <span style={{ fontSize: 16, fontWeight: 900, color: "#FF4D4D", letterSpacing: 1, textTransform: "uppercase" }}>Enter The Discount First</span>
            </div>

            <div style={{ padding: "18px 16px", marginBottom: 16, borderRadius: 12,
              background: "#FFF0EC", border: "2px solid #FF4D4D", textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#6B6B6B", letterSpacing: 0.6, marginBottom: 6 }}>{(aggShortName || "AGGREGATOR").toUpperCase()} TABLE</div>
              <div style={{ fontSize: 44, fontWeight: 900, color: "#111", lineHeight: 1 }}>{aggDiscount}%</div>
              <div style={{ fontSize: 13, color: "#6B6B6B", fontWeight: 600, marginTop: 6 }}>discount applies to this table</div>
            </div>

            <div style={{ fontSize: 16, color: "#000", fontWeight: 700, lineHeight: 1.5, marginBottom: 18, textAlign: "center" }}>
              The discount box is blank. Type the correct discount — <span style={{ fontWeight: 900 }}>{aggDiscount}</span>, 32, or <span style={{ fontWeight: 900 }}>0</span> for none — then tap Confirm Payment.
            </div>

            <button onClick={() => setShowAggDiscWarn(false)}
              style={{ width: "100%", padding: 14, borderRadius: 12, background: "#FF90E8",
                border: "2px solid #000", color: "#000", fontSize: 17, fontWeight: 900, cursor: "pointer", boxShadow: "3px 3px 0 #000" }}>
              OK — GOT IT
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function WalkInModal({ captainName, existingTables, allReservations, isPastDate, isFutureDate, onClose, onCreated, prefillTable }: {
  captainName: string; existingTables: string[]; allReservations: HodTableReservation[]; isPastDate?: boolean;
  // 🆕 2026-06-25 (Khushi) — when the dashboard date is a FUTURE operational
  // night, any arrival time is valid (the whole night is ahead). On TONIGHT,
  // an arrival time earlier than NOW is a past-time mistake and is blocked.
  isFutureDate?: boolean; onClose: () => void;
  // 🆕 2026-06-12 v3.270 (Khushi) — after a successful CREATE TABLE, hand the new
  // reservation's docId (== bookingRef returned by createWalkInTable/createProxyTable)
  // back to the parent so it can open that table's detail/ADD-ORDER view straight
  // away — captain no longer has to search the table number and tap it again.
  onCreated?: (docId: string) => void;
  // 🆕 2026-05-20 (Khushi) — when captain taps a FREE table on the floor-plan
  // dashboard, jump straight to walk-in modal with the table pre-selected.
  // Captain can still change the table if they typed by mistake.
  prefillTable?: string;
}) {
  const [customerName, setCustomerName] = useState("");
  const [countryCode, setCountryCode] = useState("91");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [partySize, setPartySize] = useState(2);
  // 🆕 2026-05-20 (Khushi) — arrival time captured up-front (defaults to "now"
  // in IST HH:MM). Captain can edit if the guest is being seated late.
  const [arrivalTime, setArrivalTime] = useState(() => {
    const d = new Date();
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
  });
  const [selectedTable, setSelectedTable] = useState(prefillTable || "");
  // If captain came from the floor-plan "+" tap, lock the table list out of
  // the UI — they already chose. Proxy tab still works (overrides selectedTable).
  const tablePrefilled = !!prefillTable;
  const prefillFloorLabel = useMemo(() => {
    if (!prefillTable) return "";
    const g = TABLE_OPTIONS.find(o => o.tables.includes(prefillTable));
    return g?.label || "";
  }, [prefillTable]);
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
  // 🆕 2026-06-26 (Khushi) — proxy auto-number = the LOWEST FREE slot 1..3 on
  // this floor, NOT count+1. The old count+1 collided after a release: with
  // Proxy-1 released and Proxy-2 still live, count=1 → it minted "Proxy-2"
  // AGAIN, re-using a live id (so the new booking landed as a second time-slot
  // on the existing Proxy-2). Computing the lowest UNUSED number instead:
  //   • reuses the freed gap (release Proxy-1 → next new proxy is Proxy-1), and
  //   • can never pick a number that's already live (no duplicate proxy id, so
  //     no accidental "multiple tables on the same proxy").
  // Cap is PROXY_MAX (3) per floor — when 1,2,3 are all live, creation blocks.
  const PROXY_MAX = 3;
  const proxyFloorCode = PROXY_FLOOR_CODE[proxyFloor] || "XX";
  const usedProxyNums = useMemo(() => {
    const s = new Set<number>();
    allReservations.forEach(r => {
      if (!(r as any).isProxy) return;
      if (((r as any).floor || "").toLowerCase() !== proxyFloor) return;
      if ((r as any).status === "cancelled") return;
      const m = /^proxy-(\d+)/i.exec((r as any).tableId || "");
      const n = m ? parseInt(m[1], 10) : 0;
      if (n > 0) s.add(n);
    });
    return s;
  }, [allReservations, proxyFloor]);
  let _freeProxyNum = 0;
  for (let i = 1; i <= PROXY_MAX; i++) { if (!usedProxyNums.has(i)) { _freeProxyNum = i; break; } }
  const proxyFull = _freeProxyNum === 0;                 // all 3 proxy slots in use on this floor
  const nextProxyNum = _freeProxyNum || PROXY_MAX;       // fallback only for the (disabled) label
  const proxyName = `Proxy-${nextProxyNum}`;            // friendly label shown in UI + WhatsApp
  const proxyTableId = `Proxy-${nextProxyNum}-${proxyFloorCode}`; // floor-unique stored id (no cross-floor collision)

  // 🆕 2026-06-25 (Khushi) — PAST-TIME GUARD. On tonight's operational night a
  // captain must not be able to seat a guest at a time that has already passed
  // (e.g. picking 14:02 when it's 8 PM). We measure "minutes since the 7 AM IST
  // operational-night start" so the late-night hours (00:00–07:00) correctly
  // count as the FUTURE part of the same night, not the past. Future nights are
  // exempt (the whole night is ahead); past nights are already blocked by
  // isPastDate. Recomputed every render so it stays live while the modal is open.
  const isPastTime = (() => {
    if (isPastDate || isFutureDate) return false;       // only guard TONIGHT
    const sel = parseClockToMinutes(arrivalTime);
    if (sel === null) return false;                     // unparseable → don't block
    const NIGHT_START = 420;                             // 07:00 IST
    const elapsed = (m: number) => (m - NIGHT_START + 1440) % 1440;
    return elapsed(sel) < elapsed(nowMinutesIST());
  })();

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
    if (isPastDate) { setError("⏪ Can't create a table on a past night. Switch the date to tonight first."); return; }
    if (isPastTime) { setError(`⏰ Arrival time ${arrivalTime} is in the PAST. Pick the current time or later — you can't seat a guest for a time that's already gone.`); return; }
    if (!customerName.trim()) { setError("Enter customer name"); return; }
    if (!phoneDigits || phoneDigits.length < 7) { setError("Enter a valid phone number (min 7 digits)"); return; }
    // E.164 caps total digits at 15. Catches paste accidents like extra digits.
    if (fullPhone.length > 15) { setError("Phone number too long — check the country code & number"); return; }
    if (isProxy && proxyFull) { setError(`All ${PROXY_MAX} proxy / extra tables on this floor are in use. Release one before adding another.`); return; }
    if (!isProxy && !selectedTable) { setError("Select a table"); return; }
    const _bookingMin = parseClockToMinutes(arrivalTime) ?? nowMinutesIST();
    const _clash = tableOccupantAt(selectedTable, _bookingMin, allReservations);
    if (!isProxy && _clash) { setError(`Table ${selectedTable} is already booked at ${_clash.arrivalTime || "that time"} — pick a different time or table`); return; }
    // D3 + ZERO TOLERANCE (Khushi 2026-06-24) — ANY captain-added discount
    // beyond the source's platform-implied discount requires a Manager PIN,
    // even 1%. In-house implied = 0 so every non-zero walk-in discount is
    // gated; aggregator sources only need a PIN for amounts ABOVE the preset.
    const impliedDisc = getAggregatorDiscount(aggValue) || 0;
    let overrideReason = "";
    if (customDiscount > impliedDisc) {
      const ok = await requireManagerPin(
        `Walk-in discount: ${customDiscount}% on source "${aggValue}"\n` +
        `(implied ${impliedDisc}%) — Manager approval required for ANY discount.`
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
          proxyTableId, proxyFloor, floorOpt?.label || proxyFloor,
          customerName.trim(), fullPhone, partySize, captainName,
          aggValue, discountPct, email.trim(), arrivalTime.trim()
        );
      } else {
        const opt = TABLE_OPTIONS.find((g) => g.tables.includes(selectedTable));
        createdRef = await createWalkInTable(
          selectedTable, opt?.floor || "", opt?.label || "",
          customerName.trim(), fullPhone, partySize, captainName,
          aggValue, discountPct, email.trim(), arrivalTime.trim()
        );
      }
      // D3 — log the over-threshold walk-in discount approval (best-effort,
      // outside the create txn so a logging glitch can't block table creation).
      if (createdRef && customDiscount > impliedDisc) {
        await recordWalkInDiscountOverride(createdRef, {
          by: captainName, valueBefore: impliedDisc, valueAfter: customDiscount,
          reason: overrideReason.trim() || "(no reason given)",
        });
      }
      // 🆕 2026-06-23 v3.377 — fire WhatsApp with menu/wallet link immediately
      // on creation. Walk-in = guest is physically present RIGHT NOW so we
      // send their digital menu link via WhatsApp the moment the booking lands.
      // Best-effort fire-and-forget: a WA failure MUST NOT block table creation
      // or closing the modal.
      if (createdRef && fullPhone) {
        const walletUrl = `https://hodclub.in/?wallet=${encodeURIComponent(createdRef)}`;
        const tableLabel = isProxy ? proxyName : (selectedTable || "Your table");
        const floorLabel = isProxy
          ? (TABLE_OPTIONS.find(g => g.floor === proxyFloor)?.label || proxyFloor || "")
          : (TABLE_OPTIONS.find(o => o.tables.includes(selectedTable))?.label || "");
        // 🆕 2026-06-25 (Khushi) — send the SAME booking-confirmation format the
        // customer site (hodclub.in) sends for an online table reservation, via
        // the approved `table_confirmed` template. Params (matching the live
        // customer-site call): [name, dateNice, arrival, tableId, floorLabel,
        // partySize, walletUrl].
        let dateNice = getOperationalNightStr();
        try {
          dateNice = new Date(getOperationalNightStr() + "T00:00:00+05:30")
            .toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
        } catch { /* fall back to YYYY-MM-DD */ }
        // arrivalTime is stored 24h ("HH:MM") — show 12h ("04:55 PM") in the message.
        const arr12 = (() => {
          const mm = parseClockToMinutes(arrivalTime);
          if (mm === null) return arrivalTime.trim() || "FROM NOW";
          const h = Math.floor(mm / 60), m = mm % 60;
          const ap = h >= 12 ? "PM" : "AM";
          const h12 = h % 12 === 0 ? 12 : h % 12;
          return `${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ap}`;
        })();
        const waText =
          `Hi ${customerName.trim()}, your HOD table is booked! 🍽️\n\n` +
          `📅 Date: ${dateNice}\n` +
          `🕘 Arrival: ${arr12}\n` +
          `🪑 Table: ${tableLabel}${floorLabel ? ` · ${floorLabel}` : ""}\n` +
          `👥 Guests: ${partySize}\n\n` +
          `Show your QR at the door — we will have your table ready.\n\n` +
          `View reservation: ${walletUrl}\n\n` +
          `See you tonight!\n\n` +
          `📍 House of Dopamine, Koramangala`;
        // A fresh walk-in has never messaged HOD (outside the 24h window) so a
        // free-form text is silently dropped by Meta — fire the approved template
        // first; the helper falls back to the free-form text if it's blocked.
        void sendWhatsAppViaMetaShared({
          phone: fullPhone,
          template: {
            name: "table_confirmed",
            language: "en",
            params: [customerName.trim(), dateNice, arr12, tableLabel, floorLabel || "your floor", String(partySize), walletUrl],
          },
          fallbackText: waText,
        });
      }
      // 🆕 2026-06-12 v3.270 (Khushi) — jump straight to the new table so the
      // captain can add an order immediately (no search-and-tap step). Best-effort:
      // a missing ref must never block closing the modal on a successful create.
      if (createdRef) { try { onCreated?.(createdRef); } catch { /* non-fatal */ } }
      onClose();
    } catch (e: any) { setError(e.message); }
    setSaving(false);
  };

  // 🆕 2026-06-03 v3.200 (Khushi) — Select Table is now grouped BY PAX
  // (capacity) like Door mode — "2 PAX → these tables, 4 PAX → these…" — so
  // captain picks by party size, not by floor. Seats come from HOD_TABLES;
  // any id without a known seat count falls into an "OTHER" bucket so nothing
  // is ever dropped from the picker.
  const seatsById = useMemo(() => {
    const m: Record<string, number> = {};
    (Object.keys(HOD_TABLES) as FloorKey[]).forEach(fk => {
      HOD_TABLES[fk].tables.forEach(t => { m[t.id] = t.seats; });
    });
    // FD13 / SMK3 are valid bookable tables in TABLE_OPTIONS but are NOT drawn
    // on the floor map (absent from HOD_TABLES). Seed their seat counts from
    // their neighbours (FD13 sits among 4-seat dining; SMK3 among 2-seat
    // smoking) so they land in the right PAX bucket instead of "OTHER".
    if (m["FD13"] == null) m["FD13"] = 4;
    if (m["SMK3"] == null) m["SMK3"] = 2;
    return m;
  }, []);
  const paxGroups = useMemo(() => {
    const buckets: Record<number, string[]> = {};
    TABLE_OPTIONS.forEach(g => g.tables.forEach(t => {
      const seats = seatsById[t] || 0;
      (buckets[seats] = buckets[seats] || []).push(t);
    }));
    const known = Object.keys(buckets).map(Number).filter(n => n > 0).sort((a, b) => a - b)
      .map(seats => ({ seats, label: `👥 ${seats} PAX`, tables: buckets[seats] }));
    if (buckets[0]?.length) known.push({ seats: 0, label: "👥 OTHER", tables: buckets[0] });
    return known;
  }, [seatsById]);

  // 🎨 2026-06-03 v3.200 (Khushi) — Gumroad field styling: every label is a
  // highlighted beige chip (2px black border) and every input/select sits in a
  // proper 2px black-bordered box so the form reads as clear Gumroad cards.
  const fieldLabel: CSSProperties = { fontSize: 12, fontWeight: 900, color: "#000", marginBottom: 7, textTransform: "uppercase", letterSpacing: .6, display: "inline-block", background: "#FBF3D6", border: "2px solid #000", borderRadius: 6, padding: "4px 9px", fontFamily: "'Manrope','Space Grotesk',sans-serif" };
  const fieldInput: CSSProperties = { width: "100%", padding: "11px 14px", borderRadius: 10, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 17, outline: "none", boxSizing: "border-box" };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 20, padding: 24, width: "100%", maxWidth: 600, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "stretch", gap: 10, marginBottom: 16 }}>
          <button onClick={onClose} title="Back"
            style={{ flexShrink: 0, width: 48, borderRadius: 12, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 22, fontWeight: 900, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Manrope','Space Grotesk',sans-serif" }}>←</button>
          <div style={{ flex: 1, background: "#FF90E8", border: "2px solid #000", borderRadius: 12, padding: "12px 14px" }}>
            <div style={{ fontSize: 21, fontWeight: 900, color: "#000", marginBottom: 2 }}>🚶 Seat Walk-In Guest</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#000" }}>
              {tablePrefilled ? "Fill in the guest details below — table already chosen." : "Create a new table for a walk-in customer"}
            </div>
          </div>
        </div>

        {/* Regular / Proxy tab toggle stays on top — captain might tap "+" on a
            real table but realise the guest needs a Proxy-N instead (e.g. table
            is held for a VIP coming in 10 min). Switching to Proxy clears the
            prefilled table since proxies don't live on the map. */}
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          <button onClick={() => setIsProxy(false)}
            style={{ flex: 1, padding: "8px 12px", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer",
              background: !isProxy ? "#FBF3D6" : "#fff",
              border: `1px solid #000`,
              color: !isProxy ? "#000" : "#6B6B6B" }}>
            🪑 Regular Table
          </button>
          <button onClick={() => setIsProxy(true)}
            style={{ flex: 1, padding: "8px 12px", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer",
              background: isProxy ? "#FFF0EC" : "#fff",
              border: `1px solid ${isProxy ? "#FF5733" : "#000"}`,
              color: isProxy ? "#000" : "#6B6B6B" }}>
            📦 Proxy / Extra
          </button>
        </div>

        {/* 🆕 Prefilled-table banner — replaces the entire table-picker grid
            when captain came from a "+" tap on the floor plan. Keeps modal
            short and prevents accidental re-selection. */}
        {tablePrefilled && !isProxy && (
          <div style={{ background: "linear-gradient(135deg,#FBF3D6,#FBF3D6)", border: "1.5px solid #000", borderRadius: 12, padding: 14, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#6B6B6B", letterSpacing: 1, marginBottom: 2 }}>SEATING AT</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#000", fontFamily: "inherit", lineHeight: 1 }}>
                {selectedTable || prefillTable}
              </div>
              {prefillFloorLabel && (
                <div style={{ fontSize: 12, fontWeight: 700, color: "#6B6B6B", marginTop: 3, letterSpacing: 0.6 }}>
                  {prefillFloorLabel.toUpperCase()}
                </div>
              )}
            </div>
            <button onClick={onClose}
              style={{ background: "transparent", border: "1px solid #6B6B6B", color: "#6B6B6B", fontSize: 11, fontWeight: 800, padding: "6px 10px", borderRadius: 8, cursor: "pointer", letterSpacing: 0.5 }}>
              CHANGE
            </button>
          </div>
        )}

        <div style={fieldLabel}>Customer Name *</div>
        <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="e.g. Karan"
          style={{ ...fieldInput, marginBottom: 14 }} />

        <div style={fieldLabel}>Email <span style={{ color: "#000", fontWeight: 600 }}>(optional)</span></div>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="guest@example.com" type="email" inputMode="email" autoCapitalize="none"
          style={{ ...fieldInput, marginBottom: 14 }} />

        <div style={fieldLabel}>Phone * <span style={{ color: "#000", fontWeight: 600 }}>(for WhatsApp menu link)</span></div>
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          <select value={countryCode} onChange={(e) => setCountryCode(e.target.value)}
            style={{ width: 100, padding: "10px 8px", borderRadius: 10, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 16, outline: "none", fontFamily: "inherit", cursor: "pointer" }}>
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
            style={{ ...fieldInput, flex: 1, width: "auto" }} />
        </div>

        {/* Guests + Arrival Time side-by-side — keeps the form short on phones
            and groups the "when + how many" fields visually. */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 10, marginBottom: 12 }}>
          <div>
            <div style={fieldLabel}>Guests *</div>
            <input type="number" value={partySize} onChange={(e) => setPartySize(Number(e.target.value) || 2)} min={1} max={20}
              style={fieldInput} />
          </div>
          <div>
            <div style={fieldLabel}>Arrival Time *</div>
            <input type="time" value={arrivalTime} onChange={(e) => { setArrivalTime(e.target.value); setError(""); }}
              style={{ ...fieldInput, fontFamily: "inherit",
                border: isPastTime ? "2px solid #FF5733" : (fieldInput as any).border,
                background: isPastTime ? "#FFF0EC" : (fieldInput as any).background }} />
            {isPastTime && (
              <div style={{ fontSize: 12, fontWeight: 800, color: "#FF5733", marginTop: 4, lineHeight: 1.35 }}>
                ⏰ That time has already passed — pick now or later.
              </div>
            )}
          </div>
        </div>

        {isProxy ? (
          <>
            {proxyFull ? (
              <div style={{ background: "#FFE5E0", border: "2px solid #FF5733", borderRadius: 12, padding: 14, marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: "#FF5733", marginBottom: 4 }}>📦 All {PROXY_MAX} proxy tables in use</div>
                <div style={{ fontSize: 13, color: "#000" }}>This floor already has Proxy-1, Proxy-2 and Proxy-3 live. Release one before adding another.</div>
              </div>
            ) : (
              <div style={{ background: "#FFF0EC", border: "1px solid #FF5733", borderRadius: 12, padding: 14, marginBottom: 12 }}>
                <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 4 }}>Auto-assigned Name</div>
                <div style={{ fontSize: 23, fontWeight: 900, color: "#FF5733" }}>{proxyName}</div>
              </div>
            )}
            <div style={fieldLabel}>Floor *</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              {TABLE_OPTIONS.map(g => (
                <button key={g.floor} onClick={() => setProxyFloor(g.floor)}
                  style={{ flex: 1, padding: "8px 10px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer",
                    background: proxyFloor === g.floor ? "#FFF0EC" : "#fff",
                    border: `1px solid ${proxyFloor === g.floor ? "#FF5733" : "#6B6B6B"}`,
                    color: proxyFloor === g.floor ? "#000" : "#6B6B6B" }}>
                  {g.label}
                </button>
              ))}
            </div>
          </>
        ) : tablePrefilled ? null : (
          <>
            <div style={fieldLabel}>Select Table * <span style={{ color: "#000", fontWeight: 600 }}>(by party size)</span></div>
            <div style={{ marginBottom: 12 }}>
              {paxGroups.map((group) => (
                <div key={group.seats} style={{ marginBottom: 12, border: "2px solid #000", borderRadius: 12, padding: 10, background: "#fff" }}>
                  <div style={{ display: "inline-block", fontSize: 12, fontWeight: 900, color: "#000", background: "#FBF3D6", border: "2px solid #000", borderRadius: 6, padding: "3px 9px", marginBottom: 8, letterSpacing: .6, fontFamily: "'Manrope','Space Grotesk',sans-serif" }}>{group.label}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {group.tables.map((t) => {
                      // Colour by the SELECTED arrival time, not the current time.
                      // A 3 PM unsettled booking should not red-out SMK4 for an
                      // 11 PM slot — only colour red when the windows actually overlap.
                      const _pickerMin = parseClockToMinutes(arrivalTime) ?? nowMinutesIST();
                      const occupant = tableOccupantAt(t, _pickerMin, allReservations);
                      const occupied = !!occupant;
                      const isSelected = selectedTable === t;
                      const bg = isSelected ? "#FF90E8"
                        : occupied ? "#FF5733" : "#1B7A70";
                      const color = isSelected ? "#000" : "#fff";
                      return (
                        <button key={t} onClick={() => { if (!occupied) { setSelectedTable(t); setError(""); } }} disabled={occupied}
                          title={occupant ? `Taken — ${occupant.customerName || ""} ${occupant.arrivalTime || ""}`.trim() : "Available now"}
                          style={{ padding: "7px 12px", borderRadius: 8, fontSize: 13, fontWeight: 800, cursor: occupied ? "not-allowed" : "pointer",
                            background: bg, border: "2px solid #000", color,
                            opacity: occupied ? 0.9 : 1 }}>
                          {t}{occupied ? " 🔒" : ""}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* 🔴 2026-06-25 (Khushi) — Discount field REMOVED from the Create Table /
            Seat Walk-In modal. Captains should not set a discount at table
            creation; any discount is applied later at Settle Bill (Manager-PIN
            gated). customDiscount stays 0 so the create flow passes no discount. */}

        {error && <div style={{ fontSize: 14, fontWeight: 800, color: "#FF5733", marginBottom: 10 }}>{error}</div>}

        {(() => {
          const blockProxyFull = isProxy && proxyFull;
          const disabled = saving || isPastTime || blockProxyFull;
          return (
        <button onClick={create} disabled={disabled}
          style={{ width: "100%", padding: 14, borderRadius: 12, background: (isPastTime || blockProxyFull) ? "#E5E5E5" : "#FF90E8", border: "2px solid #000", color: (isPastTime || blockProxyFull) ? "#888" : "#000", fontSize: 18, fontWeight: 900, cursor: disabled ? "not-allowed" : "pointer", marginBottom: 10, opacity: (isPastTime || blockProxyFull) ? 0.7 : 1 }}>
          {saving ? "Creating..." : blockProxyFull ? `📦 All ${PROXY_MAX} proxies in use` : isPastTime ? "⏰ Past time — pick now or later" : isProxy ? `📦 Create ${proxyName}` : "🪑 Create Table"}
        </button>
          );
        })()}
      </div>
    </div>
  );
}

function AddOrderModal({ docId, tableId, captainName, isPastDate, onClose }: {
  docId: string; tableId: string; captainName: string; isPastDate?: boolean; onClose: () => void;
}) {
  const MENU_ITEMS = useEffectiveMenu();
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
  }, [tab, MENU_ITEMS]);

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
    // 🆕 2026-06-26 (Khushi) — GLOBAL search. When the captain types a query we
    // search the ENTIRE menu, ignoring the active FOOD/LIQUOR/NAB/SMOKE tab and
    // sub-category, so e.g. "kingfisher" typed under the FOOD tab still finds the
    // beer (it lives in LIQUOR). The tab highlight auto-jumps to the match via
    // the effect below. With no query we scope to the active tab + sub-category.
    if (search) {
      const q = norm(search);
      const words = q.split(" ").filter(Boolean);
      items = items.filter((m) => {
        const hay = norm(`${m.name} ${m.category} ${m.group}`);
        return words.every((w) => wordMatch(w, hay));
      });
    } else {
      items = items.filter((m) => tabOf(m) === tab);
      if (category) items = items.filter((m) => m.category === category);
    }
    return items.slice(0, 80);
  }, [search, category, menuOverrides, tab, liveCategories, MENU_ITEMS]);

  // 🆕 2026-06-26 (Khushi) — when a search surfaces matches that live in another
  // tab, light up that tab so the captain sees e.g. LIQUOR highlight while
  // searching "kingfisher". No-op once already on the right tab (prevents loops).
  useEffect(() => {
    if (!search.trim() || filtered.length === 0) return;
    const t = tabOf(filtered[0]);
    setTab((prev) => (prev === t ? prev : t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filtered]);

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
    if (isPastDate) { alert("⏪ Can't add an order on a past night. Switch the date to tonight first."); return; }
    setSaving(true);
    try {
      await addRoundToTable(docId, cart, captainName);
      onClose();
    } catch (e: any) { alert(e.message); }
    setSaving(false);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 9999, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid #000", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 900, color: "#000" }}>Add Order — {tableId}</div>
          <div style={{ fontSize: 13, color: "#6B6B6B" }}>Captain: {captainName}</div>
        </div>
        <button onClick={onClose} style={{ width: 36, height: 36, borderRadius: 10, background: "#fff", border: "1px solid #000", color: "#000", fontSize: 21, cursor: "pointer" }}>×</button>
      </div>

      {/* 🔴 2026-05-12 — Wallet-style search bar + 4 big tabs (FOOD/LIQUOR/NAB/SMOKE)
          + red sub-category strip. Mirrors rms-diner.digitory.com so captains
          see the same shape the customer sees on hodclub.in. */}
      <div style={{ padding: "10px 16px 0", background: "#fff" }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search"
          style={{ width: "100%", padding: "12px 14px", borderRadius: 6, background: "transparent", border: "1px solid #000", color: "#000", fontSize: 16, outline: "none", boxSizing: "border-box", marginBottom: 10, textAlign: "center" }} />
        {/* 🆕 2026-06-03 v3.206 (Khushi) — each tab is a black-outlined Gumroad
            box; when selected it prefills with its own brand color (food pink,
            liquor gold, nab teal, smoke blue). Contrast: pink/gold bg → #000,
            teal/blue bg → #fff. Idle = white box + 2px black outline. */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 8 }}>
          {([
            { id: "food", tint: "#FF90E8", fg: "#000" },
            { id: "liquor", tint: "#F2C744", fg: "#000" },
            { id: "nab", tint: "#23A094", fg: "#fff" },
            { id: "smoke", tint: "#60A5FA", fg: "#fff" },
          ] as const).map((t) => {
            const active = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                style={{
                  padding: "14px 6px", borderRadius: 6, fontSize: 14, fontWeight: 800, letterSpacing: 1, cursor: "pointer",
                  background: active ? t.tint : "#fff",
                  color: active ? t.fg : "#000",
                  border: "2px solid #000",
                  textTransform: "uppercase",
                }}>{t.id}</button>
            );
          })}
        </div>
        {/* 🆕 2026-06-05 v3.223 (Khushi) — the sub-category chips used to wrap
            into 6+ rows for big tabs (LIQUOR etc.) and ate the WHOLE screen, so
            captains could only see 2-3 items and had to scroll forever to add.
            Cap the chip strip to ~2 rows with its own internal scroll so the
            ITEM LIST below always gets the rest of the screen. */}
        {tabCategories.length > 1 && (
          <div style={{ display: "flex", gap: 6, paddingBottom: 8, flexWrap: "wrap", maxHeight: 72, overflowY: "auto" }}>
            {/* 🆕 2026-06-26 (Khushi) — chips recolored: pink looked weak. Now a
                BLACK border on a white chip with a hard Gumroad shadow when idle;
                the SELECTED chip fills pink and "presses" into its shadow
                (shadow removed + translate) so the active category is obvious. */}
            <button onClick={() => setCategory("")}
              style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 3, fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
                background: !category ? "#FF90E8" : "#fff",
                border: "1.5px solid #000",
                boxShadow: !category ? "none" : "2px 2px 0 #000",
                transform: !category ? "translate(2px,2px)" : "none",
                color: "#000" }}>ALL</button>
            {tabCategories.map((c) => (
              <button key={c} onClick={() => setCategory(c)}
                style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 3, fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", letterSpacing: 0.5,
                  background: category === c ? "#FF90E8" : "#fff",
                  border: "1.5px solid #000",
                  boxShadow: category === c ? "none" : "2px 2px 0 #000",
                  transform: category === c ? "translate(2px,2px)" : "none",
                  color: "#000" }}>{prettyCat(c)}</button>
            ))}
          </div>
        )}
        <div style={{ height: 1, background: "#6B6B6B" }} />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 16px", background: "#fff" }}>
        {category && (
          <div style={{ fontSize: 21, fontWeight: 800, color: "#000", padding: "10px 0", letterSpacing: 0.5 }}>
            {prettyCat(category)}
          </div>
        )}
        {filtered.length === 0 && (
          <div style={{ padding: 40, textAlign: "center", color: "#6B6B6B", fontSize: 14 }}>
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
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 0", borderBottom: "1px dashed #6B6B6B" }}>
              <div style={{ flex: 1, paddingRight: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 16, color: "#000", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3 }}>
                  {showVeg && (
                    <span style={{
                      display: "inline-block", width: 12, height: 12, border: `1.5px solid ${m.isVeg ? "#23A094" : "#FF5733"}`,
                      borderRadius: 2, position: "relative", flexShrink: 0,
                    }}>
                      <span style={{
                        position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
                        width: 5, height: 5, borderRadius: "50%", background: m.isVeg ? "#23A094" : "#FF5733",
                      }} />
                    </span>
                  )}
                  {m.name}
                </div>
                <div style={{ fontSize: 20, color: "#000", marginTop: 4, fontWeight: 900 }}>
                  {/* 🔴 2026-05-20 (Khushi clarification) — menu list shows
                      RAW menu price (matches the printed menu the customer
                      sees in their hand). Tax-inclusive only kicks in once
                      item enters the cart / bill — same as the customer site.
                      🆕 2026-06-03 v3.205 — price bumped to 20px bold BLACK. */}
                  {hasDisc ? (
                    <>
                      <span style={{ textDecoration: "line-through", color: "#000", marginRight: 6 }}>₹{m.price || 0}</span>
                      <span style={{ color: "#23A094" }}>₹{eff}</span>
                    </>
                  ) : (
                    <>₹{m.price || 0}</>
                  )}
                  {hasDisc && ov?.discountReason && (
                    <span style={{ marginLeft: 6, color: "#6B6B6B", fontWeight: 500 }}>· {ov.discountReason}</span>
                  )}
                </div>
              </div>
              <button onClick={() => addToCart(m)}
                style={{
                  padding: "8px 18px", borderRadius: 4, background: "#FF5733", border: "2px solid #000",
                  color: "#fff", fontSize: 14, fontWeight: 800, letterSpacing: 0.5, cursor: "pointer",
                }}>ADD +</button>
            </div>
          );
        })}
      </div>

      {cart.length > 0 && (
        <div style={{ borderTop: "2px solid #000", background: "#fff", padding: "12px 16px" }}>
          <div style={{ maxHeight: 150, overflowY: "auto", marginBottom: 8 }}>
            {cart.map((c, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0" }}>
                <span style={{ fontSize: 14, color: "#000", flex: 1 }}>{c.n}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button onClick={(e) => { e.stopPropagation(); updateCartQty(i, -1); }} style={{ width: 24, height: 24, borderRadius: 6, background: "#fff", border: "1px solid #000", color: "#000", cursor: "pointer", fontSize: 14 }}>−</button>
                  <span style={{ fontSize: 16, fontWeight: 800, color: "#000", minWidth: 16, textAlign: "center" }}>{c.qty}</span>
                  <button onClick={(e) => { e.stopPropagation(); updateCartQty(i, 1); }} style={{ width: 24, height: 24, borderRadius: 6, background: "#fff", border: "1px solid #000", color: "#000", cursor: "pointer", fontSize: 14 }}>+</button>
                  <span style={{ fontSize: 14, color: "#000", minWidth: 50, textAlign: "right" }}>₹{computeHodBreakdown([c]).grandTotal}</span>
                </div>
              </div>
            ))}
          </div>
          <details style={{ borderTop: "1px solid #6B6B6B", paddingTop: 6, marginBottom: 10 }}>
            <summary style={{ display: "flex", justifyContent: "space-between", alignItems: "center", listStyle: "none", cursor: "pointer" }}>
              <span style={{ fontSize: 13, color: "#6B6B6B", fontStyle: "italic" }}>
                Total · inclusive of all taxes <span style={{ opacity: 0.6, fontSize: 11 }}>▾ view tax breakdown</span>
              </span>
              <span style={{ fontSize: 19, fontWeight: 900, color: "#000" }}>{fmt(cartTotal)}</span>
            </summary>
            <div style={{ fontSize: 13, lineHeight: 1.7, paddingTop: 6, marginTop: 5, borderTop: "1px dashed #6B6B6B", color: "#6B6B6B" }}>
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
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginTop: 4, color: "#6B6B6B" }}>
                <span>{cart.reduce((s, c) => s + c.qty, 0)} item(s)</span>
                <span>Total {fmt(cartBreakdown.grandTotal)}</span>
              </div>
            </div>
          </details>
          <button onClick={submit} disabled={saving}
            style={{ width: "100%", padding: 14, borderRadius: 12, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 18, fontWeight: 900, cursor: "pointer" }}>
            {saving ? "Adding..." : `📝 Add Round · ${formatINR(cartBreakdown.grandTotal)} (${cart.reduce((s, c) => s + c.qty, 0)} items)`}
          </button>
        </div>
      )}
    </div>
  );
}

function TableCard({ r, captainName, playAlert, existingTables, allReservations, isPastDate, canSettle = true, onSeatAnother }: {
  r: HodTableReservation; captainName: string; playAlert: (u: boolean) => void; existingTables: string[]; allReservations: HodTableReservation[]; isPastDate?: boolean;
  /** 🆕 2026-06-25 (Khushi) — when FALSE, this captain may only NOTIFY a
   *  supervisor to settle; the Settle Bill button + mark-paid flow are blocked.
   *  Defaults TRUE so any caller that hasn't threaded the prop keeps old behavior. */
  canSettle?: boolean;
  /** 🆕 2026-06-25 (Khushi) — opens the Seat Walk-In / Create Table modal
   *  pre-filled with THIS table id, so the captain can create a fresh booking
   *  for the same table's next time slot straight from the detail view. */
  onSeatAnother?: (tableId: string) => void;
}) {
  const [notified, setNotified] = useState(false);
  const [editRound, setEditRound] = useState<{ round: HodTabRound; index: number } | null>(null);
  const [showPaid, setShowPaid] = useState(false);
  const [showAddOrder, setShowAddOrder] = useState(false);
  const [showReassign, setShowReassign] = useState(false);
  const [showVoidBill, setShowVoidBill] = useState(false);
  // 🆕 2026-05-20 (Khushi) — bill preview state. Captain sees the EXACT bill
  // before the printer fires. CANCEL → nothing printed, no bill # consumed,
  // no audit row. CONFIRM → existing recordBillPrint + printBill flow.
  const [previewBill, setPreviewBill] = useState<null | {
    items: HodOrderItem[]; subtotal: number; discountPct: number; discountAmt: number;
    afterDiscount: number; scAmt: number; cgst: number; sgst: number; taxAmt: number;
    finalAmount: number; aggName: string; floor: TabletFloor; isReprint: boolean;
    reprintNumber: number; stale: boolean;
  }>(null);
  const [busy, setBusy] = useState("");
  // 🆕 2026-06-26 (Khushi) — in-app Gumroad notice for KOT print result. Replaces
  // the native browser alert() (which showed an ugly "embedded page says…" popup).
  // kind drives the accent color (ok = teal, warn = red).
  const [kotNotice, setKotNotice] = useState<{ kind: "ok" | "warn"; title: string; lines: string[] } | null>(null);
  // ⚡ 2026-06-25 — OPTIMISTIC BILL-PRINTED LOCK. recordBillPrint now persists in
  // the BACKGROUND so the chit prints instantly, which means live r.billPrintCount
  // can lag a few seconds. The post-bill source/discount lock + Mark-Paid gate
  // must NOT open during that lag, so we flip this local flag the instant a bill
  // prints on THIS tablet and treat it as "bill printed" alongside billPrintCount.
  const [justPrintedBill, setJustPrintedBill] = useState(false);
  const lastPrintAtRef = useRef(0);
  const [qrFallback, setQrFallback] = useState<{ url: string; reason: string } | null>(null);
  // 🍳 2026-05-21 — KDS ready items for THIS table. Chef bumps in Kitchen Mode
  // → these populate within 1s → green banner below pulses with chime so
  // captain serves hot. Filter from the global ready stream (single Firestore
  // listener for the whole captain dashboard via dedup at SDK level).
  const [readyKDSAll, setReadyKDSAll] = useState<HodKDSItem[]>([]);
  useEffect(() => {
    const unsub = subscribeToReadyKDSItems(setReadyKDSAll);
    return () => unsub();
  }, []);
  const readyKDSForThisTable = useMemo(
    () => readyKDSAll.filter((it) => it.reservationId === r._docId),
    [readyKDSAll, r._docId]
  );
  // Soft chime when ready count transitions 0 → N (uses captain's existing
  // playAlert helper so we get the same audio behavior as waiter calls).
  const prevReadyCountRef = useRef(0);
  useEffect(() => {
    if (readyKDSForThisTable.length > prevReadyCountRef.current && prevReadyCountRef.current === 0) {
      try { playAlert(false); } catch {}
    }
    prevReadyCountRef.current = readyKDSForThisTable.length;
  }, [readyKDSForThisTable.length, playAlert]);
  // 🆕 2026-05-20 (Khushi spec) — captain always needs a way to share the
  // wallet/menu link in case Meta WhatsApp delivery fails. This opens a
  // local QR popup with the hodclub.in/?wallet=<ref> URL the customer can
  // scan or the captain can copy/share via the device share sheet.
  // Fallback layers: copy-link button + WhatsApp deep-link button.
  const [shareWalletQr, setShareWalletQr] = useState(false);
  const [aggOpen, setAggOpen] = useState(false);
  const [customDiscInput, setCustomDiscInput] = useState<string>(() =>
    String(r.aggregatorDiscount ?? getAggregatorDiscount(r.aggregator || r.source || "inhouse"))
  );

  const pending = (r.tabRounds || []).filter((rd) => rd.status === "preparing").length;
  const billReq = r.paymentStatus === "bill_requested";
  // ── 2026-05-20 — COVER+TABLE LINKED WALLET (Khushi spec) ──
  // Door girl's "💰 ACTIVATE COVER + TABLE" path writes linkedCoverDocId on
  // this reservation. We live-subscribe to that cover doc so the badge
  // shows the LIVE balance (auto-updates if customer also redeems at GF
  // bar). Fallback: linkedCoverInitial if the live subscription hasn't
  // fired yet or the cover doc is unreadable.
  const [linkedCover, setLinkedCover] = useState<HodCover | null>(null);
  useEffect(() => {
    if (!r.linkedCoverDocId) { setLinkedCover(null); return; }
    const u = subscribeToCoverById(r.linkedCoverDocId, setLinkedCover);
    return () => u();
  }, [r.linkedCoverDocId]);
  const linkedCoverBalance = linkedCover ? (linkedCover.coverBalance || 0) : (r.linkedCoverInitial || 0);
  const linkedCoverActive = !!r.linkedCoverDocId && !r.linkedCoverPending && linkedCoverBalance > 0;
  const linkedCoverEmpty = !!r.linkedCoverDocId && !r.linkedCoverPending && linkedCoverBalance <= 0;
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
    // 💰 READ-COST FIX 2026-06-16 — lookupOrphanZomatoPaymentByName runs an
    // UNBOUNDED `aggregatorBookings WHERE source==zomato AND status==pending-booking`
    // scan. This used to fire every 30s FOREVER, per unpaid Zomato table, per
    // tablet — thousands of Firestore reads/night for a badge that only needs
    // to flip ONCE. Now: (1) STOP polling the instant the orphan payment is
    // found, (2) idle poll slowed 30s → 3min. Badge behaviour is unchanged.
    let id: ReturnType<typeof setInterval> | null = null;
    const stop = () => { if (id !== null) { clearInterval(id); id = null; } };
    const tick = async () => {
      const o = await lookupOrphanZomatoPaymentByName(r.customerName || "", r.phone || "");
      if (cancelled) return;
      setOrphanPay(o);
      if (o) stop();  // payment matched — badge has flipped, no need to keep scanning
    };
    tick();
    id = setInterval(tick, 180000);
    return () => { cancelled = true; stop(); };
  }, [r.paymentStatus, aggForFallback, r.customerName]);
  const paid = r.paymentStatus === "paid" || !!orphanPay;
  // 🆕 2026-06-07 (Khushi) — a table booked online with a PREPAID COVER carries
  // paymentStatus:"paid" from the cover deposit while its FOOD TAB is still OPEN
  // (the guest keeps self-ordering). `paid` above stays true so the cover-PAID
  // badge/display is unchanged, but ordering/settlement ACTIONS must key off the
  // TRUE settlement stamp (markTablePaid writes paymentMode/paidAt) — otherwise
  // the captain can't ADD ORDER or SETTLE the real food bill. orphanPay (zomato
  // pre-claim) is still treated as locked, exactly as before.
  const billSettled = isTableBillSettled(r) || !!orphanPay;
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
  // 🔴 2026-05-20 (Khushi Bug 3+4) — DISPLAY-ONLY tax-inclusive total for the
  // table card. The raw `tabTotal` above stays untouched (used by anti-fraud
  // caps, discount math, reports). `tabTotalInclusive` is shown on the card
  // header so captain ₹X = customer wallet ₹X = bar screen ₹X from the
  // moment the order is placed (instead of only matching at Mark-Paid).
  const tabTotalInclusive = (() => {
    const allItems = (r.tabRounds || []).flatMap((rd) => rd.items || []);
    if (!allItems.length) return 0;
    return computeHodBreakdown(allItems).grandTotal;
  })();
  const aggName = r.aggregator || r.source || "inhouse";
  const aggDiscount = r.aggregatorDiscount ?? getAggregatorDiscount(aggName);
  // Guard against a pathological stored NaN so the badge never renders "NaN%".
  const safeAggDiscount = Number.isFinite(Number(aggDiscount)) ? Number(aggDiscount) : 0;
  const aggLabel = AGGREGATOR_OPTIONS.find((a) => a.value === aggName)?.label || aggName;
  const isAgg = aggName !== "inhouse";
  // 🆕 2026-06-12 v3.267 (Khushi) — flag an IN-HOUSE discount applied to an
  // AGGREGATOR booking. Aggregator bills normally print at the FULL menu price
  // (the platform takes its commission separately), so an in-house ₹-off is
  // unusual and means the amount actually collected is BELOW the menu total —
  // exactly the FD7 case (SWIGGY 0% booking, settled by card with a 10% house
  // discount → menu ₹1161 but collected ₹1045). Detected via a captain-modified
  // discount % OR a persisted discountAmount on a settled aggregator table.
  const inhouseDiscPct = r.discountPercent || 0;
  const inhouseDiscOnAgg = isAgg && (
    (!!r.discountModifiedByCaptain && inhouseDiscPct > 0) ||
    (r.paymentStatus === "paid" && (r.discountAmount || 0) > 0)
  );

  const borderColor = billReq
    ? "#FF5733"
    : pending > 0
      ? "#000"
      // 2026-05-20 — gold glow on tables with an active linked wallet so the
      // captain spots them at a glance walking up to the floor.
      : linkedCoverActive
        ? "#000"
        // 🆕 2026-06-03 v3.203 (Khushi) — the detail card sits on the now-light
        // beige backdrop; an idle/arrived table used to fall through to a WHITE
        // border (invisible on light). Default to solid #000 so the card always
        // has a clear black frame.
        : "#000";

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
    if (isPastDate) { setKotNotice({ kind: "warn", title: "⏪ Past night", lines: ["Can't print KOT on a past night.", "Switch the date to tonight first."] }); return; }
    // ⚡ 2026-06-25 — FULLY OPTIMISTIC KOT. The round we're printing is already in
    // the live `r.tabRounds` prop, so we don't need to read it back. markRoundActivated
    // (a getDoc + updateDoc + customer-wallet mirror) and printKOT (an addDoc) all
    // resolve only on SERVER ack — awaiting them stacked 2-3 round-trips and stalled
    // the chit 7-30s on the preview proxy / shaky venue wifi. Both are DISPLAY/print
    // writes (no money): the status flip + chit are queued durably the instant we call
    // them, so we fire-and-forget and confirm to the captain immediately.
    const round = (r.tabRounds || [])[roundIdx];
    if (!round) return;
    if (busy === `serve-${roundIdx}`) return;
    setBusy(`serve-${roundIdx}`);
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
    // Fire the status flip in the background (display-only; durably queued).
    markRoundActivated(r._docId, roundIdx, captainName, r.bookingRef)
      .catch((e) => console.warn("[serve] markRoundActivated failed", e));
    // Fire the chit in the background; only a genuine async failure pops a notice.
    printKOT({
      tableId: r.tableId, floorLabel: r.floorLabel, customerName: r.customerName,
      customerPhone: (r as any).customerPhone || (r as any).phone,
      bookingRef: r.bookingRef, reservationId: r._docId,
      staff: captainName, roundNum: round.roundNum, items: round.items, roundTotal: round.roundTotal,
      tabletFloor: tableFloor,
    }).then((ok) => {
      if (!ok) setKotNotice({ kind: "warn", title: "⚠ KOT may not have printed", lines: ["Check the printer or tap PRINT KOT again.", `Table floor: ${floorName}`] });
    }).catch(() => {
      setKotNotice({ kind: "warn", title: "⚠ KOT may not have printed", lines: ["Check the printer or tap PRINT KOT again.", `Table floor: ${floorName}`] });
    });
    // 🍳 KDS — mirror food items to kitchen screen. Best-effort; paper KOT already
    // fired so chef has a fallback if this write fails.
    if (hasFood) {
      writeKDSItemsFromKOT({
        reservationId: r._docId,
        coverDocId: (r as any).linkedCoverDocId || "",
        tableId: r.tableId,
        tableLabel: r.tableId,
        floorLabel: floorName,
        customerName: r.customerName || "",
        bookingRef: r.bookingRef,
        staff: captainName,
        roundNum: round.roundNum,
        items: round.items,
      } as any).catch((e) => console.warn("[KDS] captain serve write failed", e));
    }
    setKotNotice({ kind: "ok", title: "🖨 KOT Sent", lines: [`Sent to: ${dests.join(" + ")}`, `Table floor: ${floorName}`, `Table ${r.tableId}`] });
    // Cooldown clear: block impatient double-taps, re-enable for a deliberate retry.
    window.setTimeout(() => setBusy(""), 4000);
  };

  const handleServeAll = async () => {
    if (isPastDate) { setKotNotice({ kind: "warn", title: "⏪ Past night", lines: ["Can't print KOT on a past night.", "Switch the date to tonight first."] }); return; }
    const pendingIdxs = (r.tabRounds || [])
      .map((rd, i) => ({ rd, i }))
      .filter(({ rd }) => rd.status === "preparing" || rd.status === "activated")
      .map(({ i }) => i);
    if (pendingIdxs.length === 0) return;
    if (busy === "serve-all") return;
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
    // ⚡ 2026-06-25 — FULLY OPTIMISTIC (same reasoning as handleServe). Fire every
    // round's status flip + chit in the background and confirm immediately. The
    // rounds are already in the live `r.tabRounds` prop, so no read-back is needed;
    // both writes are display/print only (no money) and queue durably the instant
    // they're called. A genuine async print failure pops a per-round notice.
    let anyFood = false, anyDrink = false;
    let sentCount = 0;
    for (const idx of pendingIdxs) {
      const round = (r.tabRounds || [])[idx];
      if (!round) continue;
      sentCount++;
      if ((round.items || []).some((it) => it.t === "food")) anyFood = true;
      if ((round.items || []).some((it) => it.t !== "food")) anyDrink = true;
      markRoundActivated(r._docId, idx, captainName, r.bookingRef)
        .catch((e) => console.warn("[serveAll] markRoundActivated failed", e));
      printKOT({
        tableId: r.tableId, floorLabel: r.floorLabel, customerName: r.customerName,
        customerPhone: (r as any).customerPhone || (r as any).phone,
        bookingRef: r.bookingRef, reservationId: r._docId,
        staff: captainName, roundNum: round.roundNum, items: round.items, roundTotal: round.roundTotal,
        tabletFloor: tableFloor,
      }).then((ok) => {
        if (!ok) setKotNotice({ kind: "warn", title: "⚠ KOT may not have printed", lines: [`Round ${round.roundNum} — retry that round if needed.`, `Table floor: ${floorName}`] });
      }).catch(() => {
        setKotNotice({ kind: "warn", title: "⚠ KOT may not have printed", lines: [`Round ${round.roundNum} — retry that round if needed.`, `Table floor: ${floorName}`] });
      });
      // 🍳 KDS — mirror food to kitchen screen (best-effort; paper KOT already fired).
      if ((round.items || []).some((it) => it.t === "food")) {
        writeKDSItemsFromKOT({
          reservationId: r._docId,
          coverDocId: (r as any).linkedCoverDocId || "",
          tableId: r.tableId,
          tableLabel: r.tableId,
          floorLabel: floorName,
          customerName: r.customerName || "",
          bookingRef: r.bookingRef,
          staff: captainName,
          roundNum: round.roundNum,
          items: round.items,
        } as any).catch((e) => console.warn("[KDS] captain serveAll write failed", e));
      }
    }
    // Rooftop has no bar → drinks made at FF bar (runners carry up)
    const barLabel = tableFloor === "ground" ? "GF BAR"
      : tableFloor === "rooftop" ? "FF BAR (no bar at RT)"
      : "FF BAR";
    const dests: string[] = [];
    if (anyFood) dests.push("2F KITCHEN");
    if (anyDrink) dests.push(barLabel);
    setKotNotice({ kind: "ok", title: `🖨 ${sentCount} KOT${sentCount > 1 ? "s" : ""} Sent`, lines: [`Sent to: ${dests.join(" + ")}`, `Table floor: ${floorName}`, `Table ${r.tableId}`] });
    // Cooldown clear: keep the button locked briefly so an impatient double-tap
    // can't enqueue duplicate chits, but re-enable for a deliberate retry.
    window.setTimeout(() => setBusy(""), 4000);
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
    const hasUnpaid = !billSettled && tabTotal > 0;
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
      // Best-effort: drop any pending settle-request flag so it can't linger as
      // a phantom row if the table was released without a normal settle pass.
      // (Release deletes the doc, so the list drops it anyway — this is belt &
      // braces, fire-and-forget, fail-open.)
      try { clearSettleRequest(r._docId); } catch {}
    } catch (e: any) {
      alert(`❌ Release failed: ${e?.message || String(e)}`);
    }
    setBusy("");
  };

  // 🆕 2026-05-20 (Khushi) — split into TWO steps:
  //   1. openBillPreview() — compute totals, open preview modal (NO print, NO Firestore write).
  //   2. confirmAndPrint() — fired by the modal's CONFIRM button; runs the original
  //      recordBillPrint + printBill path.
  // 🛟 FALLBACK: if the preview modal crashes for any reason, captain still has the
  // "🖨 PRINT WITHOUT PREVIEW" link inside the modal that bypasses preview and prints
  // directly (same as old behavior).
  const computeBillSnapshot = () => {
    const allItems: HodOrderItem[] = ((r.tabRounds || []).flatMap((rd) => rd.items || []) as HodOrderItem[])
      .filter((it) => it && it.qty > 0);
    if (allItems.length === 0) return null;
    const id = (r.tableId || "").toUpperCase();
    let floor: TabletFloor = "first";
    if (id.startsWith("C")) floor = "ground";
    else if (id.startsWith("T")) floor = "rooftop";
    else if (id.startsWith("FD") || id.startsWith("SMK")) floor = "first";
    const subtotal = allItems.reduce((s, it) => s + (it.p || 0) * (it.qty || 0), 0);
    const aggName = (r as any).aggregator || (r as any).source || "inhouse";
    // 🆕 2026-06-26 (Khushi) — the PRINTED bill for an aggregator booking must show
    // the FULL menu price. The guest/platform is invoiced in full; the platform's
    // commission ("30% off") is a SETTLE-time concept (what the venue collects NET),
    // applied only inside the Settle Bill modal — it must NEVER reduce the printed
    // invoice. So force the print discount to 0 for aggregator bookings. (In-house
    // discounts are also given at settle, never auto on print, so this stays 0.)
    const discountPct: number = aggName !== "inhouse"
      ? 0
      : ((r as any).aggregatorDiscount ?? getAggregatorDiscount(aggName) ?? 0);
    // 🆕 2026-06-08 — canonical single-final-round grand (see Mark-Paid note) so the
    // PRINTED bill total === the customer wallet === Mark Paid, to the rupee. Print
    // always applies SC (there is no waiver toggle on the print path).
    const bd = computeHodBreakdownAdjusted(allItems, discountPct, true);
    const discountAmt = Math.round(bd.discount);
    const afterDiscount = subtotal - bd.discount;
    const scAmt = bd.serviceCharge;
    const taxAmt = bd.gst;
    const cgst = bd.cgst;
    const sgst = bd.sgst;
    const finalAmount = bd.grandTotal;
    const prevCount = r.billPrintCount || 0;
    return {
      items: allItems, subtotal, discountPct, discountAmt, afterDiscount,
      scAmt, cgst, sgst, taxAmt, finalAmount, aggName, floor,
      isReprint: prevCount > 0, reprintNumber: prevCount + 1, stale: !!r.billStale,
    };
  };

  const handleThermalBill = async (_legacyIsDuplicate?: boolean) => {
    const snap = computeBillSnapshot();
    if (!snap) { setKotNotice({ kind: "warn", title: "Nothing to print", lines: ["This table has no items to put on a bill yet."] }); return; }
    // L6 — debounce/confirm rapid reprints (kept BEFORE the preview opens
    // so captain doesn't accidentally double-fire within 10s).
    const prevCount = (r.billPrintCount || 0) || (justPrintedBill ? 1 : 0);
    const lastAt = Math.max(r.lastBillPrintedAt ? new Date(r.lastBillPrintedAt).getTime() : 0, lastPrintAtRef.current);
    if (prevCount > 0 && Date.now() - lastAt < BILL_REPRINT_DEBOUNCE_MS) {
      const secs = Math.ceil((BILL_REPRINT_DEBOUNCE_MS - (Date.now() - lastAt)) / 1000);
      if (!window.confirm(`⚠ A bill was just printed ${Math.ceil((Date.now()-lastAt)/1000)}s ago.\n\nReprint anyway? (Wait ${secs}s to skip this prompt.)`)) return;
    }
    setPreviewBill(snap);
  };

  const confirmAndPrint = async () => {
    const snap = previewBill;
    if (!snap) return;
    // 🛡 2026-05-20 (architect) — FRESHNESS GUARD. If the tab changed between
    // preview-open and confirm (another captain edited a round, kitchen marked
    // served, etc.), the live `r` prop will have moved on via the Firestore
    // subscription. Recompute and compare item signatures + total. On drift,
    // abort with a clear alert and force the captain to re-open preview so
    // the printed paper reflects the current order.
    const fresh = computeBillSnapshot();
    const sig = (s: typeof snap | null) => s ? s.items.map(i => `${i.n}|${i.p}|${i.qty}`).join("§") + `=${s.finalAmount}` : "";
    if (!fresh || sig(fresh) !== sig(snap)) {
      setPreviewBill(null);
      setKotNotice({ kind: "warn", title: "⚠ Bill changed since preview", lines: ["Items or totals were updated.", "Tap PRINT BILL again to see the current bill."] });
      return;
    }
    setBusy("printbill");
    try {
      // ⚡ 2026-06-25 — print the bill INSTANTLY. recordBillPrint is a Firestore
      // transaction (live server round-trip, no cache) that stalls the chit on
      // slow venue wifi; the bill number + audit log are bookkeeping (no money),
      // so derive the number from live state and persist the record in the
      // background. Fail-open: a failed bg write loses one audit row, not the bill.
      // NOTE: this optimistic number/duplicate flag is NON-AUTHORITATIVE under
      // concurrency — two tablets printing the same cover within the bg-write
      // window can both derive the same suffix. Cosmetic only (audit label); the
      // canonical order is the backend bill-print log, and no money depends on it.
      const billBaseC = r._docId.slice(-6).toUpperCase();
      const prevCountC = r.billPrintCount || 0;
      const optBillNumberC = `${billBaseC}-${prevCountC + 1}`;
      const optIsDuplicateC = prevCountC > 0;
      runBillBookkeepingBg(() => recordBillPrint(r._docId, {
        by: captainName, total: snap.finalAmount, discountPct: snap.discountPct,
        aggregator: snap.aggName, billNumberBase: billBaseC,
      }));
      // ⚡ 2026-06-25 — FIRE-AND-FORGET the print job. printBill is a plain addDoc
      // whose Promise only resolves on SERVER ack; awaiting it stalled the chit
      // 10-30s on the preview proxy / shaky venue wifi. The job is written to the
      // tablet's durable offline queue the instant we call printBill and the floor
      // print-agent pulls it from the server once it syncs — so we DON'T wait. UI
      // confirms instantly; a genuine async failure pops a follow-up "tap again".
      // Same fail-open pattern already used for printKOT in Bar mode. No money write.
      printBill({
        tableId: r.tableId, floorLabel: r.floorLabel,
        customerName: r.customerName, partySize: (r as any).partySize, staff: captainName,
        items: snap.items.map((i) => ({ n: i.n, p: i.p, qty: i.qty })),
        amounts: { subtotal: snap.subtotal, serviceCharge: snap.scAmt, cgst: snap.cgst, sgst: snap.sgst,
          discount: snap.discountAmt, roundOff: 0, total: snap.finalAmount, discountPct: snap.discountPct },
        paymentMethod: (r as any).paymentMethod || (snap.aggName !== "inhouse" ? snap.aggName : undefined),
        billNumber: optBillNumberC, isDuplicate: optIsDuplicateC, tabletFloor: snap.floor,
      }).then((ok) => {
        if (!ok) setKotNotice({ kind: "warn", title: "⚠ Bill may not have printed", lines: ["Check the printer or tap 🖨 PRINT BILL again."] });
      }).catch(() => {
        setKotNotice({ kind: "warn", title: "⚠ Bill may not have printed", lines: ["Check the printer or tap 🖨 PRINT BILL again."] });
      });
      // Engage the post-bill lock INSTANTLY so a source/discount swap or no-print
      // Mark-Paid can't slip through the lag.
      setJustPrintedBill(true);
      lastPrintAtRef.current = Date.now();
      const floorName = snap.floor === "ground" ? "GROUND FLOOR" : snap.floor === "first" ? "FIRST FLOOR" : "ROOFTOP";
      setKotNotice({ kind: "ok", title: `🖨 Bill #${optBillNumberC} sent`, lines: [
        `To: ${floorName} BILL PRINTER`,
        ...(optIsDuplicateC ? ["⚠ DUPLICATE REPRINT"] : []),
        `Floor derived from table ${r.tableId}`,
      ] });
    } catch (e: any) { setKotNotice({ kind: "warn", title: "❌ Bill print failed", lines: [e?.message || String(e)] }); }
    setBusy("");
    setPreviewBill(null);
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
    if ((r.billPrintCount || 0) > 0 || justPrintedBill) {
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
      // D3-extension + ZERO TOLERANCE (Khushi 2026-06-24) — ANY pre-bill custom
      // discount beyond the source's implied default needs Manager PIN, even 1%.
      if (customDisc !== undefined && customDisc > impliedDisc) {
        const ok = await requireManagerPin(
          `Custom discount: ${customDisc}% on source "${value}"\n(implied ${impliedDisc}%) — Manager approval required for ANY discount.\nTable: ${r.tableId}`);
        if (!ok) return;
        managerOverride = true;
        kind = "captain-discount-edit";
        reason = window.prompt(`Reason for ${customDisc}% custom discount:`)?.trim() || (reason || "(no reason)");
      }
    }
    try {
      // Always logs to sourceOverrideLog now (any change pre or post-bill).
      await setReservationAggregator(r._docId, value, disc, { managerOverride, staffName: captainName, reason });
      // If the captain typed a custom discount beyond the implied rate (which
      // triggered the Manager-PIN gate above), ALSO write to discountOverrideLog
      // so the Live Monitor's "OVERRIDES" tile sees it (sourceOverrideLog is
      // for source swaps).
      if (managerOverride && customDisc !== undefined && customDisc > impliedDisc) {
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
    // 🆕 2026-06-25 (Khushi) — defense-in-depth: a captain without settle
    // permission can never open the mark-paid flow; they NOTIFY instead.
    if (!canSettle) {
      setSettleRequest(r._docId, { by: captainName, floor: r.floorLabel || r.floor || "" });
      setNotified(true);
      return;
    }
    // 🆕 2026-06-26 (Khushi) — a bill MUST be printed before it can be settled.
    // (Was a Manager-PIN override; she wants a HARD "print first" block instead so
    // no table is ever settled without the audit chit.) In-app Gumroad notice, not
    // a browser popup; captain prints, then Settle Bill opens normally.
    if ((r.billPrintCount || 0) === 0 && !justPrintedBill) {
      setKotNotice({ kind: "warn", title: "🖨 Print the bill first", lines: [
        `No bill has been printed for ${r.tableId}.`,
        "Tap 🖨 Print Bill, then settle the bill.",
      ] });
      return;
    }
    setShowPaid(true);
  };

  const sendWhatsApp = async () => {
    // 🔴 2026-06-26 (Khushi — "Send Menu not reaching guest") — proxy / walk-in
    // tables created on the POS store the number in customerPhone, while online
    // bookings use phone. Reading only r.phone made Send Menu silently hit the
    // "No phone number" branch for captain-created tables. Pick the FIRST field
    // that holds a real (>=10-digit) number — don't blindly prefer r.phone, since
    // a stale/blank phone could shadow a valid customerPhone on mixed records.
    const phoneCandidates = [r.phone, (r as any).customerPhone]
      .map((p) => String(p || "").replace(/\D/g, ""));
    const custPhone = phoneCandidates.find((p) => p.length >= 10) || "";
    if (!custPhone) {
      setKotNotice({ kind: "warn", title: "⚠ No phone number", lines: ["This booking has no phone number on file.", "Use SHARE WALLET QR instead."] });
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
      // 🔴 2026-06-26 (Khushi — "WhatsApp not reaching the guest") — DELIVERY FIX.
      // We used to send the free-form text FIRST. Problem: a free-form message
      // ONLY delivers inside the 24h customer-service window (the guest must have
      // messaged US recently). A hodclub.in booking confirmation is a
      // business-INITIATED template, which does NOT open that window — so for
      // most guests Meta ACCEPTED the free-form call (ok:true) but SILENTLY
      // DROPPED it. The captain saw "sent" while the guest got nothing.
      // Fix: send the approved TEMPLATE first (it delivers to EVERYONE,
      // in-window or not), then fall back to free-form (richer format, only for
      // in-window guests), then the in-app QR. Single message either way.
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
        setKotNotice({ kind: "ok", title: "✅ Menu Sent", lines: [`WhatsApp menu sent to ${tplData.recipient || custPhone}`, "If not seen in 30s, ask them to check spam."] });
        setBusy("");
        return;
      }
      console.warn("Template send failed, trying free-form text:", tplData);

      // Fallback: free-form text (delivers ONLY if the guest is inside the 24h
      // reply window, but carries Khushi's richer booking-confirmation format).
      const fbRes = await fetch(`${WHATSAPP_CF_BASE}/sendWhatsAppText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: custPhone, message: fallbackMessage }),
      });
      const fbData = await fbRes.json();
      if (fbRes.ok && fbData.ok) {
        setKotNotice({ kind: "ok", title: "✅ Menu Sent", lines: [`WhatsApp menu sent to ${fbData.recipient || custPhone}`, "If not seen in 30s, ask them to check spam."] });
        setBusy("");
        return;
      }
      console.warn("Free-form fallback also failed:", fbData);

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
      setKotNotice({ kind: "warn", title: "⚠ Network error", lines: ["Couldn't send the WhatsApp menu.", "Check your connection and try again."] });
    }
    setBusy("");
  };

  return (
    <>
      <div style={{ background: "#fff", border: `2px solid ${(r.customerCallRequest ? "#FF5733" : borderColor)}`, borderRadius: 16, marginBottom: 14, overflow: "hidden",
        ...(r.customerCallRequest
          // 2026-05-20 — customer pinged "🍽 I'M AT MY TABLE" from the
          // wallet site → take precedence over all other glow states so the
          // captain can't miss it. Pulses via inline keyframes below.
          ? { boxShadow: "none", animation: "hodCallPulse 1.2s ease-in-out infinite" }
          : billReq
            ? { boxShadow: "none" }
            // 2026-05-20 — gold glow when a linked wallet is active (matches
            // the gold border) so captain spots wallet-attached tables at a
            // glance. billReq red glow takes precedence.
            : linkedCoverActive
              ? { boxShadow: "none" }
              : {}) }}>
        {/* 🔔 CUSTOMER CALLING banner — pulsing red, shown ONLY when the
            customer tapped "I'M AT MY TABLE" on their wallet page. Sits at
            the very top so it's the first thing captain sees. "✓ ON IT"
            clears the ping (writes null on the reservation doc).
            🛟 Fallback: if clear fails, the banner stays — captain can
            re-tap, or it auto-clears next time the customer pings. */}
        {r.customerCallRequest && (() => {
          const cr = r.customerCallRequest;
          const mins = Math.max(0, Math.floor((Date.now() - new Date(cr.at).getTime()) / 60000));
          return (
            <div style={{ background: "linear-gradient(90deg,#FF5733,#FF5733,#FF5733)", color: "#fff", padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, borderBottom: "1px solid rgba(0,0,0,.3)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 2 }}>🔔 CUSTOMER CALLING · {mins === 0 ? "JUST NOW" : `${mins} MIN AGO`}</div>
                <div style={{ fontSize: 13, opacity: 0.92, lineHeight: 1.4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  Wants to order{cr.itemsPreview ? `: ${cr.itemsPreview}` : ""}{cr.total ? ` · ₹${cr.total.toLocaleString("en-IN")}` : ""}
                </div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); if (r._docId) clearCustomerCallRequest(r._docId, captainName, cr.at); }}
                style={{ background: "#FF5733", color: "#fff", border: "2px solid #000", padding: "8px 14px", borderRadius: 8, fontSize: 14, fontWeight: 900, letterSpacing: 0.5, cursor: "pointer", flexShrink: 0, textTransform: "uppercase" }}
              >✓ ON IT</button>
            </div>
          );
        })()}
        {/* 🍳 2026-05-21 — KDS FOOD-READY banner. Chef bumped this table's
            food from Kitchen Mode → captain sees a green pulsing banner with
            the dish list and a ✓ PICKED UP button. Tap clears the row (status
            → picked_up). 🛟 If clear write fails, banner stays — next bump
            elsewhere doesn't break this one. Audio chime via playAlert. */}
        {readyKDSForThisTable.length > 0 && (
          <div
            style={{
              background: "#23A094",
              color: "#fff", padding: "10px 14px", borderBottom: "1px solid rgba(0,0,0,.3)",
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
              animation: "hodKdsReady 1.4s ease-in-out infinite",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 2 }}>
                🍽 FOOD READY — GO SERVE
              </div>
              <div style={{ fontSize: 13, opacity: 0.95, lineHeight: 1.4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {readyKDSForThisTable.map((it) => `${it.qty}× ${it.itemName}`).join(" · ")}
              </div>
            </div>
            <button
              onClick={async (e) => {
                e.stopPropagation();
                for (const it of readyKDSForThisTable) {
                  if (it.id) { try { await markKDSPickedUp(it.id, captainName); } catch {} }
                }
              }}
              style={{
                background: "#fff", color: "#1B7A70", border: "none", padding: "8px 14px",
                borderRadius: 8, fontSize: 14, fontWeight: 900, letterSpacing: 0.5,
                cursor: "pointer", flexShrink: 0, textTransform: "uppercase",
              }}
            >✓ PICKED UP</button>
          </div>
        )}
        {/* 🔴 2026-05-20 (Khushi Bug 1 fix) — LAST CALL RECAP strip.
            Shows the MOST RECENT dismissed customer call for 30 min after
            captain tapped ✓ ON IT, so the captain doesn't lose the item
            list while walking to the table. Only shown when there is NO
            active call (the red banner above takes precedence). Auto-hides
            after 30 min so the card doesn't get cluttered. */}
        {!r.customerCallRequest && Array.isArray(r.customerCallHistory) && r.customerCallHistory.length > 0 && (() => {
          const last = r.customerCallHistory[r.customerCallHistory.length - 1];
          if (!last || !last.dismissedAt) return null;
          const ageMin = Math.floor((Date.now() - new Date(last.dismissedAt).getTime()) / 60000);
          if (ageMin > 30) return null;
          return (
            <div style={{ background: "#FBF3D6", borderBottom: "1px solid #000", padding: "7px 14px", display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#000" }}>
              <span style={{ fontWeight: 900, letterSpacing: 0.5, textTransform: "uppercase", flexShrink: 0 }}>📜 LAST CALL · {ageMin === 0 ? "JUST NOW" : `${ageMin} MIN AGO`}</span>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", opacity: 0.9 }}>
                {last.itemsPreview || "—"}{last.total ? ` · ₹${last.total.toLocaleString("en-IN")}` : ""}
              </span>
            </div>
          );
        })()}
        {/* 🔴 2026-05-20 (Khushi Bug 1 fix) — CUSTOMER SELF-ORDERED panel.
            Lists every round the customer placed from their phone (the wallet
            link) with status: 🟡 ORDERED (preparing) / ✅ SERVED. Captain can
            see the full self-order history at a glance without needing the
            banner. Only renders when a linked wallet exists and has rounds. */}
        {linkedCover && Array.isArray(linkedCover.tabRounds) && linkedCover.tabRounds.length > 0 && (() => {
          const rounds = linkedCover.tabRounds;
          const recent = rounds.slice(-3);
          const anyPreparing = recent.some((rd) => rd && (rd.status === "preparing" || rd.status === "activated"));
          return (
            <div style={{ background: anyPreparing ? "#FBF3D6" : "#fff", borderBottom: "1px solid #6B6B6B", padding: "8px 14px" }}>
              <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: 1, textTransform: "uppercase", color: anyPreparing ? "#000" : "#6B6B6B", marginBottom: 4 }}>📜 CUSTOMER SELF-ORDERED · {rounds.length} ROUND{rounds.length === 1 ? "" : "S"}</div>
              {recent.map((rd, idx) => {
                const isPreparing = rd && (rd.status === "preparing" || rd.status === "activated");
                const itemsStr = Array.isArray(rd?.items) ? rd.items.map((it: { qty?: number; n?: string }) => `${it.qty || 1}× ${it.n || "?"}`).join(", ") : "";
                return (
                  <div key={idx} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: isPreparing ? "#000" : "#6B6B6B", lineHeight: 1.5 }}>
                    <span style={{ flexShrink: 0, fontWeight: 800 }}>{isPreparing ? "🟡" : "✅"}</span>
                    <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{itemsStr || "—"}</span>
                    <span style={{ flexShrink: 0, fontWeight: 800 }}>₹{(() => {
                      // 🔴 2026-05-20 (Khushi Bug 4) — show tax-inclusive ₹ so
                      // this strip matches the customer's wallet screen.
                      try {
                        const items = Array.isArray(rd?.items) ? rd.items : [];
                        return items.length ? computeHodBreakdown(items).grandTotal.toLocaleString("en-IN") : Number(rd?.roundTotal || 0).toLocaleString("en-IN");
                      } catch { return Number(rd?.roundTotal || 0).toLocaleString("en-IN"); }
                    })()}</span>
                  </div>
                );
              })}
            </div>
          );
        })()}
        <div style={{ padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", background: billReq ? "#FFF0EC" : pending > 0 ? "#FBF3D6" : "" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
              {/* 🆕 2026-05-20 (Khushi) — header meta enlarged: tableId 26px gold,
                  floor 15px white, arrival chip 13px. */}
              {/* 🆕 2026-05-20 (Khushi) — tableId uses Space Grotesk (sans, not
                  the cursive Playfair) so digits read as clean block numbers. */}
              <span style={{ fontSize: 26, fontWeight: 900, color: "#000", letterSpacing: 0.4, fontFamily: "'Space Grotesk','Manrope',sans-serif" }}>{r.tableId}</span>
              <span style={{ fontSize: 15, color: "#6B6B6B", fontWeight: 700, letterSpacing: 0.3 }}>{r.floorLabel || r.floor}</span>
              {r.actualArrivalTime ? (
                <span style={{ background: "#E6F5F2", border: "1.5px solid #23A094", color: "#23A094", fontSize: 13, fontWeight: 900, padding: "4px 10px", borderRadius: 10, letterSpacing: 0.5 }}>✓ ARRIVED {r.actualArrivalTime}</span>
              ) : (
                // 🆕 2026-05-20 (Khushi) — restored the clickable "GUEST ARRIVED"
                // button (was previously a passive ⏳ chip). Now captain can mark
                // arrival in one tap from the booking detail modal. 🛟 FALLBACK:
                // failures are swallowed silently so a network blip never blocks
                // captain from moving on to taking the order.
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    try { await markGuestArrived(r._docId, r.bookingRef, captainName); } catch (err) { console.warn("markGuestArrived failed", err); }
                  }}
                  style={{ background: "#23A094", border: "1.5px solid #000", color: "#fff", fontSize: 13, fontWeight: 900, padding: "6px 12px", borderRadius: 10, cursor: "pointer", letterSpacing: 0.6, boxShadow: "none", fontFamily: "'Manrope','Space Grotesk',sans-serif" }}>
                  ✓ GUEST ARRIVED
                </button>
              )}
              {voided && <span title={`Bill voided by ${(r as any).voidedBy || "?"} — ${(r as any).voidReason || ""}${(r as any).voidNotes ? ` (${(r as any).voidNotes})` : ""}`} style={{ background: "#FFF0EC", border: "1px solid #FF5733", color: "#FF5733", fontSize: 12, fontWeight: 900, padding: "3px 8px", borderRadius: 10, cursor: "help" }}>🚫 BILL VOIDED · ₹{Math.round((r as any).voidedBillTotal || 0)}</span>}
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
                const bg = isOnline ? "#E6F5F2" : "#FBF3D6";
                const bd = isOnline ? "#23A094" : "#000";
                const fg = isOnline ? "#23A094" : "#000";
                const label = isOnline
                  ? "✅ PAID ONLINE"
                  : ("✅ PAID" + (isAgg ? ` · ${pm.toUpperCase()}` : ""));
                const showWarn = orphanPay && r.paymentStatus !== "paid" && !isOnline;
                return (
                  <span title={tip} style={{ background: bg, border: `1px solid ${bd}`, color: fg, fontSize: 12, fontWeight: 800, padding: "3px 8px", borderRadius: 10, cursor: showWarn || isOnline ? "help" : "default" }}>
                    {label}{showWarn ? " ⚠︎" : ""}
                  </span>
                );
              })()}
              {billReq && <span style={{ background: "#FFF0EC", border: "1px solid #FF5733", color: "#FF5733", fontSize: 12, fontWeight: 800, padding: "3px 8px", borderRadius: 10 }}>🧾 BILL DUE</span>}
              {pending > 0 && <span style={{ background: "#FBF3D6", border: "1px solid #000", color: "#000", fontSize: 12, fontWeight: 800, padding: "3px 8px", borderRadius: 10 }}>🔴 {pending} PENDING</span>}
            </div>
            {/* 🆕 2026-05-20 (Khushi) — guest name + meta enlarged to BOLD WHITE
                so captain reads them from across the floor without squinting. */}
            <div style={{ fontSize: 22, color: "#6B6B6B", fontWeight: 900, letterSpacing: 0.2, lineHeight: 1.15, marginTop: 2 }}>{r.customerName}</div>
            <div style={{ display: "flex", gap: 16, fontSize: 16, color: "#6B6B6B", fontWeight: 800, marginTop: 6, flexWrap: "wrap" }}>
              <span>👥 {r.partySize || "?"}p</span>
              <span>🕐 {r.arrivalTime}</span>
              <span>📱 {r.phone}</span>
            </div>
            {/* 🆕 2026-06-25 (Khushi) — always-visible REFERENCE NUMBER so the
                captain can see the booking ref on EVERY table — HOD-… (hodclub.in),
                TBL-… (captain walk-in/in-house) or AGG-… (Swiggy/Zomato). */}
            {(r.bookingRef || r.linkedCoverRef) && (
              <div style={{ marginTop: 8 }}>
                <span style={{ display: "inline-block", background: "#FBF3D6", border: "2px solid #000", borderRadius: 8, padding: "4px 10px", fontSize: 14, fontWeight: 900, color: "#000", letterSpacing: 0.5, fontFamily: "'Manrope','Space Grotesk',monospace" }}>
                  REF: {shortRef(r.bookingRef || r.linkedCoverRef)}
                </span>
              </div>
            )}
            {/* 2026-05-20 — COVER+TABLE LINKED-WALLET BADGE (Khushi spec).
                Surfaces the linked wallet so captain knows BEFORE taking the
                order that ₹X is pre-paid at the door. Two visual states:
                  • ACTIVE (balance > 0)  → bold gold pill, captain spots it
                  • USED UP (balance = 0) → dim grey pill, no glow, but still
                    shown so captain knows a wallet WAS attached (audit). */}
            {linkedCoverActive && (
              <div title={`Wallet ${r.linkedCoverRef || ""} linked at door. Available to redeem at Settle Bill in 1 tap.`}
                style={{ marginTop: 6, display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "5px 10px", borderRadius: 6,
                  background: "#E6F5F2",
                  border: "1px solid #000",
                  fontSize: 12, fontWeight: 900, color: "#000",
                  letterSpacing: 0.5, textTransform: "uppercase",
                  fontFamily: "'Manrope','Space Grotesk',sans-serif",
                  boxShadow: "none" }}>
                💰 WALLET ATTACHED · {formatINR(linkedCoverBalance)} AVAILABLE
              </div>
            )}
            {linkedCoverEmpty && (
              <div title={`Wallet ${r.linkedCoverRef || ""} was linked at door but is now fully spent (likely redeemed at GF bar).`}
                style={{ marginTop: 6, display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "5px 10px", borderRadius: 6,
                  background: "#fff",
                  border: "1px dashed #000",
                  fontSize: 12, fontWeight: 800, color: "#6B6B6B",
                  letterSpacing: 0.5, textTransform: "uppercase",
                  fontFamily: "'Manrope','Space Grotesk',sans-serif" }}>
                💰 WALLET USED UP
              </div>
            )}
            {/* 🆕 2026-05-25 (Khushi) — LIVE-AT-BAR badge. When the customer
                (table+wallet) opens hodclub.in and places an order with the
                "🍸 I'M AT THE BAR" picker, the customer site writes a
                preparing round to covers.tabRounds tagged
                source:'customer_self_order_bar'. We surface that LIVE on the
                captain card so captain knows:
                  (a) the customer is ordering at the bar RIGHT NOW
                  (b) NOT to add the same items to the table tab
                  (c) NOT to release the table / close the cover
                Captain does NOT see a "Print KOT" CTA for this round (the
                bartender handles bar drinks); badge is purely informational. */}
            {linkedCover && Array.isArray(linkedCover.tabRounds) && linkedCover.tabRounds.some((rd: any) => rd && rd.status === 'preparing' && rd.source === 'customer_self_order_bar') && (
              <div title="Customer is placing an order at the bar via their phone right now. Bartender will ring it on Bar POS. Do NOT add same items to table tab."
                className="pulse-green"
                style={{ marginTop: 6, marginLeft: 6, display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "5px 10px", borderRadius: 6,
                  background: "linear-gradient(135deg,rgba(123,47,190,.35),rgba(123,47,190,.15))",
                  border: "1.5px solid rgba(168,85,247,.85)",
                  fontSize: 12, fontWeight: 900, color: "#E9D5FF",
                  letterSpacing: 0.5, textTransform: "uppercase",
                  fontFamily: "'Manrope','Space Grotesk',sans-serif",
                  boxShadow: "none" }}>
                🍸 LIVE · CUSTOMER ORDERING AT BAR
              </div>
            )}
            {/* 🆕 2026-05-20 (Khushi spec) — ALWAYS-VISIBLE SHARE-WALLET-QR
                button so captain can hand customer the wallet link even when
                Meta WhatsApp delivery fails. Shows whenever ANY ref exists
                (linkedCoverRef from COVER+TABLE flow, or bookingRef). */}
            {(r.linkedCoverRef || r.bookingRef) && (
              <button
                onClick={(e) => { e.stopPropagation(); setShareWalletQr(true); }}
                style={{ marginTop: 6, marginLeft: 6, display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "5px 10px", borderRadius: 6, cursor: "pointer",
                  background: "#60A5FA",
                  border: "1px solid #000",
                  fontSize: 12, fontWeight: 900, color: "#000",
                  letterSpacing: 0.5, textTransform: "uppercase",
                  fontFamily: "'Manrope','Space Grotesk',sans-serif" }}>
                📲 SHARE WALLET QR
              </button>
            )}
            {isAgg && (
              <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {/* 🔴 2026-05-12 — Solid-red badge styled to match the menu's
                    ADD+ button (red fill #FF5733 + white text, 4px radius,
                    Space Grotesk bold uppercase). The discount % is shown
                    so the captain knows what the aggregator will deduct
                    when settling — even though the door-printed bill is
                    the FULL amount. */}
                <div title={`Aggregator deducts ${aggDiscount}% commission. Door bill prints the FULL invoice; venue nets ${100 - aggDiscount}% after settlement.`}
                  style={{ fontSize: 12, fontWeight: 800, padding: "4px 10px", borderRadius: 4, display: "inline-block",
                    background: "#FF5733", border: "1px solid #000", color: "#fff",
                    letterSpacing: ".5px", textTransform: "uppercase",
                    fontFamily: "'Manrope','Space Grotesk',sans-serif" }}>
                  {aggLabel} · {safeAggDiscount}%
                </div>
              </div>
            )}
            {/* Captain-modified in-house discount (PIN-gated) gets its own
                small red pill so the captain knows the bill carries a
                manual discount that WILL be applied at Mark-Paid. */}
            {!isAgg && aggDiscount > 0 && r.discountModifiedByCaptain && (
              <div style={{ marginTop: 6, fontSize: 12, fontWeight: 800, padding: "4px 10px", borderRadius: 4, display: "inline-block",
                background: "#FF5733", color: "#fff", letterSpacing: ".5px",
                fontFamily: "'Manrope','Space Grotesk',sans-serif", textTransform: "uppercase" }}>
                In-House · {aggDiscount}% discount
              </div>
            )}
            {/* 🆕 2026-06-12 v3.267 (Khushi) — UNUSUAL: an in-house discount on an
                AGGREGATOR booking. Amber flag so the captain/boss knows the amount
                actually collected is BELOW the full menu bill printed for the
                aggregator (e.g. FD7: menu ₹1161, collected ₹1045 after −10%). */}
            {inhouseDiscOnAgg && (
              <div title="Unusual: an in-house discount was applied to an AGGREGATOR booking. Aggregator bills normally print at the FULL price — here the amount actually collected is below the menu total."
                style={{ marginTop: 6, fontSize: 12, fontWeight: 800, padding: "4px 10px", borderRadius: 4, display: "inline-block",
                  background: "#FEF3C7", border: "1.5px solid #B45309", color: "#92400E",
                  letterSpacing: ".3px", fontFamily: "'Manrope','Space Grotesk',sans-serif" }}>
                ⚠ IN-HOUSE {inhouseDiscPct > 0 ? `${inhouseDiscPct}% ` : ""}DISCOUNT (rare on aggregator)
              </div>
            )}
          </div>
          <div style={{ textAlign: "right" }}>
            {tabTotal > 0 && (
              <>
                <div style={{ fontSize: 21, fontWeight: 900, color: "#000" }}>₹{tabTotalInclusive}</div>
                <div style={{ fontSize: 12, color: "#6B6B6B" }}>inclusive of all taxes</div>
                {/* 🔴 2026-05-12 — Discount preview ONLY for non-aggregator
                    tabs that the captain has explicitly modified. Aggregator
                    bookings never preview a discount here because the
                    customer bill is printed at the FULL amount. */}
                {!isAgg && aggDiscount > 0 && r.discountModifiedByCaptain && (
                  <div style={{ fontSize: 12, color: "#FF5733", fontWeight: 700 }}>-{aggDiscount}% = ₹{Math.round(tabTotalInclusive * (1 - aggDiscount / 100))}</div>
                )}
                {/* 🆕 2026-06-12 v3.267 (Khushi) — for a SETTLED aggregator table that
                    carried an in-house discount, show the amount ACTUALLY collected
                    beneath the full menu total so the captain card reconciles with
                    the TABLE TRANSACTIONS panel (which sources amountPaid). */}
                {inhouseDiscOnAgg && r.paymentStatus === "paid" && (r.amountPaid || 0) > 0 && (
                  <div style={{ fontSize: 12, color: "#B45309", fontWeight: 800 }}>collected ₹{Math.round(r.amountPaid || 0)}{inhouseDiscPct > 0 ? ` (−${inhouseDiscPct}% in-house)` : " (in-house discount)"}</div>
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
              <button onClick={handleServeAll} disabled={busy === "serve-all" || isPastDate}
                style={{ width: "100%", padding: 12, borderRadius: 10, background: isPastDate ? "#E5E5E5" : "#23A094", border: "2px solid #000", color: isPastDate ? "#888" : "#fff", fontSize: 17, fontWeight: 900, cursor: isPastDate ? "not-allowed" : "pointer", opacity: isPastDate ? 0.7 : 1 }}>
                {busy === "serve-all" ? "..." : `🖨 PRINT ALL ${pendingCount} PENDING KOTs`}
              </button>
            </div>
          );
        })()}

        {(() => {
          /* 🔴 2026-06-08 v3.253 (Khushi) — UNIFIED ROUND SEQUENCE.
             The captain list used to show ONLY the table-doc rounds, numbered by
             the stored roundNum — which (a) renders out of order / DUPLICATED
             ("ROUND 3 twice") because every writer computes roundNum off a
             DIFFERENT array (collisions + gaps), and (b) hides the guest's BAR
             rounds entirely, so the captain's bill didn't match the customer
             wallet. We now build ONE chronological list:
               • TABLE rounds — from r.tabRounds, keep their ORIGINAL array index
                 (`idx`) so every handler (handleServe / handleMarkServed /
                 setEditRound) still acts on the correct live round.
               • BAR rounds — the cover-only rounds (source contains "bar":
                 customer_self_order_bar / recharge_at_bar / bartender_bar) pulled
                 from linkedCover.tabRounds. These are already redeemed at the bar,
                 so they render READ-ONLY (no Print KOT / Edit) with a 🍸 badge.
             Sort by placedAt (the only reliable order), then RENUMBER the DISPLAY
             1..N — identical to the customer wallet — so it always reads
             R1 bar → R2 bar → R3 table → R4 table … with no dup, no gap. */
          const tableEntries = (r.tabRounds || []).map((rd, idx) => ({ rd, idx, coverOnly: false }));
          const barEntries = ((linkedCover && Array.isArray(linkedCover.tabRounds)) ? linkedCover.tabRounds : [])
            .filter((rd: HodTabRound) => rd && typeof rd.source === "string" && rd.source.toLowerCase().indexOf("bar") !== -1)
            .map((rd: HodTabRound) => ({ rd, idx: -1, coverOnly: true }));
          const allEntries = [...tableEntries, ...barEntries]
            // 🔴 2026-06-26 (Khushi) — drop EMPTY rounds (a captain added a round
            // then removed every item before printing → a useless husk: empty items
            // table + a pointless "PREPARING" badge + EDIT ORDER). Filtering here (not
            // in the map) keeps the displayed R1..N numbering contiguous and lets the
            // "No orders yet" fallback fire when every round is empty. Voided rounds
            // stay (voidedItems present) for the struck-through VOID record.
            .filter(({ rd }) => (rd.items || []).length > 0 || (rd.voidedItems || []).length > 0)
            .sort((a, b) =>
            String(a.rd.placedAt || "").localeCompare(String(b.rd.placedAt || "")));
          if (!allEntries.length) {
            return <div style={{ padding: "8px 16px 10px", fontSize: 14, color: "#6B6B6B" }}>No orders yet</div>;
          }
          return (
          <div style={{ padding: "0 16px 10px" }}>
            {allEntries.map(({ rd, idx, coverOnly }, dispIdx) => {
              const isPending = rd.status === "preparing";
              const isActivated = rd.status === "activated";
              const isServed = rd.status === "served";
              const needsAction = !coverOnly && (isPending || isActivated);
              return (
                <div key={coverOnly ? `bar-${dispIdx}` : `tbl-${idx}`} style={{ border: "2px solid #000", borderRadius: 12, padding: 14, marginTop: dispIdx === 0 ? 0 : 10, background: needsAction ? "#FBF3D6" : "#fff", ...((isServed || coverOnly) ? { opacity: 0.92 } : {}) }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 }}>
                    <span style={{ fontSize: 17, fontWeight: 900, color: "#000", letterSpacing: .6, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      ● ROUND {dispIdx + 1}
                      {coverOnly && (
                        <span style={{ fontSize: 10, fontWeight: 900, padding: "2px 7px", borderRadius: 6, background: "#A855F7", color: "#fff", letterSpacing: .3, textTransform: "uppercase" }}>🍸 AT BAR</span>
                      )}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 800, color: coverOnly ? "#23A094" : isPending ? "#000" : isActivated ? "#60A5FA" : "#23A094", letterSpacing: .3 }}>
                        {coverOnly ? "✅ REDEEMED" : isPending ? "🔴 PREPARING" : isActivated ? "🔵 READY TO SERVE" : "✅ SERVED"}
                      </span>
                      {needsAction && (
                        // 🔴 2026-05-13 — Khushi: pencil icon was too cryptic;
                        // captains kept missing it. Replaced with explicit
                        // "Edit Order" text button. Edit writes via
                        // updateRoundItems → mirrors to covers (see
                        // firestore-hod) so customer wallet sees the change.
                        <button onClick={() => setEditRound({ round: rd, index: idx })}
                          title="Edit this round"
                          style={{ padding: "5px 10px", borderRadius: 6, background: "#FBF3D6", border: "1px solid #000", color: "#000", fontSize: 12, fontWeight: 800, cursor: "pointer", fontFamily: "'Manrope','Space Grotesk',sans-serif", letterSpacing: .4, textTransform: "uppercase", lineHeight: 1 }}>
                          ✏️ Edit Order
                        </button>
                      )}
                    </div>
                  </div>
                  {/* 🆕 2026-06-03 v3.206 (Khushi) — each round's items now render
                      as a proper TABLE (Qty · Item · Amount) with a black header
                      row + black cell borders, instead of plain flex rows. */}
                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 4, background: "#fff" }}>
                    <thead>
                      <tr>
                        <th style={{ width: 44, textAlign: "center", fontSize: 11, fontWeight: 900, color: "#000", background: "#fff", padding: "5px 6px", border: "1px solid #000", textTransform: "uppercase", letterSpacing: .4 }}>Qty</th>
                        <th style={{ textAlign: "left", fontSize: 11, fontWeight: 900, color: "#000", background: "#fff", padding: "5px 8px", border: "1px solid #000", textTransform: "uppercase", letterSpacing: .4 }}>Item</th>
                        <th style={{ width: 78, textAlign: "right", fontSize: 11, fontWeight: 900, color: "#000", background: "#fff", padding: "5px 8px", border: "1px solid #000", textTransform: "uppercase", letterSpacing: .4 }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(rd.items || []).map((it, ii) => (
                        <tr key={ii}>
                          <td style={{ textAlign: "center", border: "1px solid #000", padding: "6px 6px", fontSize: 14, fontWeight: 800, color: "#000" }}>{it.qty}×</td>
                          <td style={{ border: "1px solid #000", padding: "6px 8px", fontSize: 14, fontWeight: 600, color: "#000" }}>{it.n}</td>
                          {/* 🔴 2026-06-26 (Khushi) — show the BASE menu price (qty×price)
                              so the round card matches the printed bill EXACTLY
                              (Caesar ₹285, Toit ₹530), not the per-item tax-inclusive
                              total. Tax + SC live in the ONE global dropdown at the
                              bottom of all rounds. */}
                          <td style={{ textAlign: "right", border: "1px solid #000", padding: "6px 8px", fontSize: 14, fontWeight: 800, color: "#000", fontVariantNumeric: "tabular-nums" }}>₹{(it.p || 0) * (it.qty || 0)}</td>
                        </tr>
                      ))}
                      {/* 🆕 2026-06-26 (Khushi) — items VOIDED out of an already-printed
                          KOT round stay VISIBLE here (struck-through + red VOID badge)
                          so a round whose item was removed never looks empty and staff
                          can see what was voided. Display-only — never in the bill. */}
                      {(rd.voidedItems || []).map((vi, vii) => (
                        <tr key={`void-${vii}`} style={{ background: "#FFF0EC" }}>
                          <td style={{ textAlign: "center", border: "1px solid #000", padding: "6px 6px", fontSize: 14, fontWeight: 800, color: "#B91C1C", textDecoration: "line-through" }}>{vi.qty}×</td>
                          <td style={{ border: "1px solid #000", padding: "6px 8px", fontSize: 14, fontWeight: 700, color: "#B91C1C" }}>
                            <span style={{ textDecoration: "line-through" }}>{vi.n}</span>
                            <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 900, padding: "1px 6px", borderRadius: 4, background: "#FF4D4D", color: "#fff", letterSpacing: .4, verticalAlign: "middle" }}>VOID</span>
                          </td>
                          <td style={{ textAlign: "right", border: "1px solid #000", padding: "6px 8px", fontSize: 14, fontWeight: 800, color: "#B91C1C", textDecoration: "line-through", fontVariantNumeric: "tabular-nums" }}>₹{(vi.p || 0) * (vi.qty || 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {/* 🔴 2026-05-13 — Khushi: Print KOT was wrongly flipping
                      the customer wallet to "Served" the moment the kitchen
                      ticket printed. Split into two distinct actions:
                        - Print KOT (preparing → activated/Ready to Serve)
                        - Mark Served (activated → served, only when food has
                          actually reached the table)
                      The wallet now matches reality. Bar rounds are already
                      redeemed at the bar → no action buttons. */}
                  {/* 🔴 2026-06-26 (Khushi) — only show PRINT KOT NOW when the round
                      actually HAS items. If the captain added a round, then removed
                      every item before printing, the round is empty and there is
                      nothing to send to the kitchen — the blinking button must
                      disappear instead of printing a blank chit. */}
                  {!coverOnly && isPending && (rd.items || []).length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      {/* 🆕 2026-05-20 (Khushi) — blinking GREEN Print KOT.
                          As soon as a round exists in preparing state (customer
                          self-order OR captain add-order), this button pulses
                          green to demand immediate attention. */}
                      <button onClick={() => handleServe(idx)} disabled={busy === `serve-${idx}` || isPastDate}
                        className={(busy === `serve-${idx}` || isPastDate) ? "" : "pulse-green"}
                        style={{ width: "100%", padding: 13, borderRadius: 10,
                          background: isPastDate ? "#E5E5E5" : "#23A094",
                          border: "2px solid #000", color: isPastDate ? "#888" : "#fff",
                          fontSize: 16, fontWeight: 900, cursor: "pointer",
                          fontFamily: "'Manrope','Space Grotesk',sans-serif",
                          letterSpacing: ".6px", textTransform: "uppercase" }}>
                        {busy === `serve-${idx}` ? "..." : "🖨 PRINT KOT NOW"}
                      </button>
                    </div>
                  )}
                  {!coverOnly && isActivated && (
                    <div style={{ marginTop: 8 }}>
                      <button onClick={() => handleMarkServed(idx)} disabled={busy === `served-${idx}`}
                        style={{ width: "100%", padding: 9, borderRadius: 8, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 14, fontWeight: 800, cursor: "pointer", fontFamily: "'Manrope','Space Grotesk',sans-serif", letterSpacing: ".4px", textTransform: "uppercase" }}>
                        {busy === `served-${idx}` ? "..." : "✅ Mark Served"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {/* 🆕 2026-06-26 (Khushi) — ONE global TAXES & SERVICE CHARGE
                disclosure for the WHOLE table (was per-round, too noisy). Sums
                EVERY round's items so the breakdown matches the printed bill:
                Subtotal, SC 10%, CGST, SGST, Grand Total. CGST/SGST hidden when
                0 (all-alcohol GST-exempt). Collapsed by default. */}
            {(() => {
              const allItems = allEntries.flatMap((e) => e.rd.items || []);
              if (!allItems.length) return null;
              const bd = computeHodBreakdown(allItems);
              const taxRow: CSSProperties = { display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 13, color: "#000" };
              const amt: CSSProperties = { fontVariantNumeric: "tabular-nums" };
              return (
                <details style={{ marginTop: 10 }}>
                  <summary style={{ cursor: "pointer", listStyle: "none", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 12px", border: "2px solid #000", borderRadius: 10, background: "#F4F4F0", fontSize: 13, fontWeight: 900, color: "#000", letterSpacing: .4, textTransform: "uppercase", boxShadow: "2px 2px 0 #000" }}>
                    <span>🧾 Taxes &amp; Service Charge</span>
                    <span style={amt}>₹{bd.grandTotal} ▾</span>
                  </summary>
                  <div style={{ border: "2px solid #000", borderTop: "none", borderRadius: "0 0 10px 10px", padding: "10px 12px", background: "#fff" }}>
                    <div style={taxRow}><span>Subtotal</span><span style={amt}>₹{bd.subtotal}</span></div>
                    <div style={taxRow}><span>Service Charge (10%)</span><span style={amt}>₹{bd.serviceCharge}</span></div>
                    {bd.cgst > 0 && <div style={taxRow}><span>CGST</span><span style={amt}>₹{bd.cgst}</span></div>}
                    {bd.sgst > 0 && <div style={taxRow}><span>SGST</span><span style={amt}>₹{bd.sgst}</span></div>}
                    <div style={{ ...taxRow, fontWeight: 900, borderTop: "1.5px solid #000", marginTop: 4, paddingTop: 6 }}><span>Grand Total</span><span style={amt}>₹{bd.grandTotal}</span></div>
                  </div>
                </details>
              );
            })()}
          </div>
          );
        })()}

        {r.billStale && !billSettled && (
          <div style={{ margin: "6px 16px 8px", padding: "10px 12px", borderRadius: 10,
            background: "linear-gradient(135deg, #FFF0EC, #FFF0EC)",
            border: "1px solid #FF5733",
            color: "#FF5733", fontSize: 13, fontWeight: 800, letterSpacing: ".4px",
            display: "flex", alignItems: "center", gap: 8,
            boxShadow: "none" }}
            data-testid="banner-bill-stale">
            <span style={{ fontSize: 19 }}>⚠</span>
            <span>ITEMS CHANGED SINCE LAST BILL · REPRINT REQUIRED before Settle Bill</span>
          </div>
        )}
        {(r.billPrintCount || 0) > 0 && !r.billStale && !billSettled && (
          <div style={{ margin: "6px 16px 8px", padding: "6px 10px", borderRadius: 8,
            background: "#FBF3D6", border: "1px solid #000",
            color: "#000", fontSize: 12, fontWeight: 700, letterSpacing: ".4px" }}>
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
            #FF5733 + white-text treatment as the aggregator badge so the
            captain reads "red box = serious action". */}
        <div style={{ padding: "6px 16px 14px", display: "flex", gap: 8, flexWrap: "wrap", fontFamily: "'Manrope','Space Grotesk',sans-serif" }}>
          {/* 🔴 2026-05-13 — Guest Arrived button removed from modal; it now lives
              inline on the BookingRow itself (one-tap arrival without opening the
              full booking detail). Modal kept clean for ordering / billing actions. */}
          {!billSettled && (
            <button onClick={() => {
              if (isPastDate) { alert("⏪ Can't add an order on a past night. Switch the date to tonight first."); return; }
              // 🆕 2026-05-27 v3.68 (Khushi LIVE-NIGHT) — table-assigned gate.
              // Bill-due rows sometimes land in the captain's modal with no
              // table assigned (aggregator pre-arrival, walk-in waitlist) —
              // ADD ORDER without a table id leaves KOTs unrouted and bills
              // unprintable. Hard-block here with a popup so the captain
              // (or door girl) assigns a table FIRST via the floor map.
              if (!String(r.tableId || "").trim()) {
                showAppAlert(
                  "This guest has no table assigned yet. Tap REASSIGN TABLE below to pick a table from the floor map — KOTs need a table to route to the right printer.",
                  "🪑 PLEASE ASSIGN THE TABLE FIRST"
                );
                return;
              }
              setShowAddOrder(true);
            }}
              disabled={isPastDate}
              style={{ flex: 1, minWidth: 120, padding: "9px 12px", borderRadius: 9, background: isPastDate ? "#E5E5E5" : "#FBF3D6", border: "2px solid #000", color: isPastDate ? "#888" : "#000", fontSize: 13, fontWeight: 700, cursor: isPastDate ? "not-allowed" : "pointer", letterSpacing: ".5px", fontFamily: "inherit", textTransform: "uppercase", opacity: isPastDate ? 0.7 : 1 }}>
              📝 Add Order
            </button>
          )}
          {/* 🆕 2026-05-27 v3.76 (Khushi LIVE-NIGHT) — REASSIGN TABLE button
              always visible on captain modal so a tableless booking (HODTAB
              with no table assigned at door) can be moved to a real table
              from captain side too. Without this captain was stuck — couldn't
              ADD ORDER (gated above), couldn't print KOTs, had to walk to
              door girl. Reuses the existing ReassignTableModal which lists
              available tables across all 3 floors with time-aware occupancy. */}
          {!billSettled && (
            <button onClick={() => setShowReassign(true)}
              style={{ flex: 1, minWidth: 120, padding: "9px 12px", borderRadius: 9,
                background: !String(r.tableId || "").trim() ? "#23A094" : "#60A5FA",
                border: "2px solid #000",
                color: "#fff",
                fontSize: 13, fontWeight: 900, cursor: "pointer", letterSpacing: ".5px",
                fontFamily: "inherit", textTransform: "uppercase",
                boxShadow: "none" }}>
              🔄 {!String(r.tableId || "").trim() ? "Assign Table" : "Reassign Table"}
            </button>
          )}
          {/* 🆕 2026-06-25 (Khushi) — Seat Walk-In / Create Table was MOVED out of
              this booking-action row to the modal header (next to ✕ CLOSE), so it
              reads as a separate "new booking for this table" action, not a
              booking-management button. See BookingDetailModal header. */}
          <button onClick={sendWhatsApp}
            style={{ flex: 1, minWidth: 120, padding: "9px 12px", borderRadius: 9, background: "#F2C744", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 800, cursor: "pointer", letterSpacing: ".5px", fontFamily: "inherit", textTransform: "uppercase" }}>
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
                  background: stale ? "#FF5733" : "#23A094",
                  border: "2px solid #000",
                  color: "#fff",
                  fontSize: 13, fontWeight: 800, letterSpacing: ".5px",
                  fontFamily: "inherit", textTransform: "uppercase",
                  cursor: busy === "printbill" ? "wait" : "pointer",
                  boxShadow: "none" }}
                data-testid="button-thermal-bill-captain">
                {label}
              </button>
            );
          })()}
          {!billSettled && !voided && (tabTotal > 0 || billReq) && (
            canSettle ? (
              <button onClick={handleOpenMarkPaid}
                style={{ flex: 1, minWidth: 100, padding: "9px 12px", borderRadius: 9, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 900, cursor: "pointer", letterSpacing: ".5px", fontFamily: "inherit", textTransform: "uppercase" }}>
                💰 Settle Bill
              </button>
            ) : (r.settleRequested || notified) ? (
              <div
                style={{ flex: 1, minWidth: 100, padding: "9px 12px", borderRadius: 9, background: "#E6F5F2", border: "2px solid #23A094", color: "#0B7", fontSize: 12, fontWeight: 900, letterSpacing: ".3px", fontFamily: "inherit", textTransform: "uppercase", textAlign: "center" }}>
                ✅ Supervisor Notified
              </div>
            ) : (
              <button onClick={() => {
                setSettleRequest(r._docId, { by: captainName, floor: r.floorLabel || r.floor || "" });
                setNotified(true);
              }}
                style={{ flex: 1, minWidth: 100, padding: "9px 12px", borderRadius: 9, background: "#F2C744", border: "2px solid #000", color: "#000", fontSize: 12, fontWeight: 900, cursor: "pointer", letterSpacing: ".3px", fontFamily: "inherit", textTransform: "uppercase" }}>
                🔔 Notify Supervisor To Settle Bill
              </button>
            )
          )}
          {!billSettled && !voided && (r.billPrintCount || 0) > 0 && (
            <button onClick={async () => {
              // V3 anti-fraud #A2 — pre-flight cap check; abort early w/ clear msg.
              try { await assertCaptainCanVoid(captainName); }
              catch (e: unknown) { alert(e instanceof Error ? e.message : "Void blocked."); return; }
              setShowVoidBill(true);
            }}
              title="Use ONLY when bill was printed but customer cannot/will not pay (Manager PIN required)"
              style={{ flex: 1, minWidth: 110, padding: "9px 12px", borderRadius: 9, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 13, fontWeight: 900, cursor: "pointer", letterSpacing: ".5px", fontFamily: "inherit", textTransform: "uppercase" }}>
              🚫 Void Bill
            </button>
          )}
          <button onClick={handleRelease} disabled={busy === "release"}
            style={{ flex: 1, minWidth: 100, padding: "9px 12px", borderRadius: 9, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 13, fontWeight: 900, cursor: "pointer", letterSpacing: ".5px", fontFamily: "inherit", textTransform: "uppercase" }}>
            {busy === "release" ? "..." : "🔓 Release Table"}
          </button>
        </div>
      </div>

      {editRound && <EditOrderModal round={editRound.round} roundIndex={editRound.index} docId={r._docId} captainName={captainName} bookingRef={r.bookingRef} tableId={r.tableId} floorLabel={r.floorLabel} customerName={r.customerName} onClose={() => setEditRound(null)} />}
      {showPaid && <MarkPaidModal reservation={r} captainName={captainName} onClose={() => setShowPaid(false)} />}
      {showAddOrder && <AddOrderModal docId={r._docId} tableId={r.tableId} captainName={captainName} isPastDate={isPastDate} onClose={() => setShowAddOrder(false)} />}
      {previewBill && (
        <BillPreviewModal
          r={r} captainName={captainName} snap={previewBill} busy={busy === "printbill"}
          onCancel={() => setPreviewBill(null)}
          onConfirm={confirmAndPrint}
        />
      )}
      {qrFallback && <WhatsAppQrFallbackModal url={qrFallback.url} reason={qrFallback.reason} customerName={r.customerName || "Guest"} tableId={r.tableId} onClose={() => setQrFallback(null)} />}
      {kotNotice && (
        <div onClick={() => setKotNotice(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 99999,
            display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: "#fff", border: "2px solid #000", borderRadius: 14,
              boxShadow: "5px 5px 0 #000", maxWidth: 380, width: "100%", overflow: "hidden",
              fontFamily: "'ABC Favorit','Helvetica Neue',Arial,sans-serif" }}>
            <div style={{ background: kotNotice.kind === "ok" ? "#23A094" : "#FF4D4D",
              color: "#fff", padding: "16px 20px", fontWeight: 800, fontSize: 18,
              borderBottom: "2px solid #000" }}>{kotNotice.title}</div>
            <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 6 }}>
              {kotNotice.lines.map((ln, i) => (
                <div key={i} style={{ fontSize: 15, fontWeight: i === 0 ? 700 : 500, color: "#111" }}>{ln}</div>
              ))}
              <button onClick={() => setKotNotice(null)}
                style={{ marginTop: 14, alignSelf: "flex-end", background: "#FF90E8", color: "#000",
                  border: "2px solid #000", borderRadius: 10, boxShadow: "2px 2px 0 #000",
                  padding: "10px 22px", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>OK</button>
            </div>
          </div>
        </div>
      )}
      {shareWalletQr && (r.linkedCoverRef || r.bookingRef) && (
        <WhatsAppQrFallbackModal
          url={`https://hodclub.in/?wallet=${encodeURIComponent(r.linkedCoverRef || r.bookingRef || "")}`}
          reason="captain shared on demand"
          customerName={r.customerName || "Guest"}
          tableId={r.tableId}
          onClose={() => setShareWalletQr(false)}
        />
      )}
      {showReassign && <ReassignTableModal reservation={r} existingTables={existingTables} allReservations={allReservations} captainName={captainName} onClose={() => setShowReassign(false)} />}
      {showVoidBill && (() => {
        // Recompute the same final total the bill printer used so leakage in
        // Reports / voidLog matches the paper bill the customer was handed.
        const allItems: HodOrderItem[] = ((r.tabRounds || []).flatMap((rd) => rd.items || []) as HodOrderItem[])
          .filter((it) => it && it.qty > 0);
        const subtotal = allItems.reduce((s, it) => s + (it.p || 0) * (it.qty || 0), 0);
        const aggForVoid = (r as any).aggregator || (r as any).source || "inhouse";
        const discountPct: number = (r as any).aggregatorDiscount ?? getAggregatorDiscount(aggForVoid) ?? 0;
        // 🆕 2026-06-08 — canonical grand so the VOID slip / leakage figure matches the
        // paper bill the customer was handed (and the wallet), to the rupee.
        const bd = computeHodBreakdownAdjusted(allItems, discountPct, true);
        const billTotal = bd.grandTotal;
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


// 🆕 2026-05-20 (Khushi) — BILL PREVIEW MODAL.
// Shows the EXACT bill that will print. CONFIRM → real print + Firestore write.
// CANCEL → nothing happens (no bill # consumed, no audit row).
// 🛟 FALLBACK: "PRINT WITHOUT PREVIEW" link bypasses the modal — fires the
// same confirm path directly. Use if the preview ever looks wrong.
function BillPreviewModal({ r, captainName, snap, busy, onCancel, onConfirm }: {
  r: HodTableReservation;
  captainName: string;
  snap: {
    items: HodOrderItem[]; subtotal: number; discountPct: number; discountAmt: number;
    afterDiscount: number; scAmt: number; cgst: number; sgst: number; taxAmt: number;
    finalAmount: number; aggName: string; floor: TabletFloor; isReprint: boolean;
    reprintNumber: number; stale: boolean;
  };
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const floorName = snap.floor === "ground" ? "GROUND FLOOR" : snap.floor === "first" ? "FIRST FLOOR" : "ROOFTOP";
  const billNumPreview = `${r._docId.slice(-6).toUpperCase()}-${snap.reprintNumber}`;
  const row = (label: string, val: string, bold = false) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: bold ? 16 : 14, fontWeight: bold ? 900 : 600, color: "#000" }}>
      <span>{label}</span><span>{val}</span>
    </div>
  );
  return (
    <div onClick={closeOnBackdrop(() => { if (!busy) onCancel(); })}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: "'Manrope','Space Grotesk',sans-serif" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "#fff", border: "2px solid #000", borderRadius: 14, maxWidth: 460, width: "100%", maxHeight: "92vh", overflow: "auto", boxShadow: "none" }}>
        {/* HEADER */}
        <div style={{ padding: "16px 18px", borderBottom: "1px solid #000" }}>
          <div style={{ fontSize: 12, color: "#000", fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>📋 BILL PREVIEW · NOT YET PRINTED</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#000", fontFamily: "inherit" }}>HOUSE OF DOPAMINE</div>
          <div style={{ fontSize: 11, color: "#6B6B6B", marginTop: 2 }}>{floorName} · BILL # {billNumPreview}{snap.isReprint ? ` · REPRINT #${snap.reprintNumber}` : ""}</div>
        </div>
        {/* WARNING BANNERS */}
        {snap.stale && (
          <div style={{ background: "#FF5733", color: "#fff", padding: "10px 18px", fontSize: 13, fontWeight: 800, letterSpacing: .5, textAlign: "center" }}>
            ⚠ BILL CHANGED — RE-CHECK ITEMS BEFORE PRINTING
          </div>
        )}
        {snap.isReprint && !snap.stale && (
          <div style={{ background: "#FBF3D6", color: "#000", padding: "8px 18px", fontSize: 12, fontWeight: 700, letterSpacing: .5, textAlign: "center" }}>
            ⚠ REPRINT — bill #{snap.reprintNumber} for this table
          </div>
        )}
        {/* META — outlined box */}
        <div style={{ padding: "12px 18px" }}>
          <div style={{ border: "1px solid #000", borderRadius: 10, padding: "10px 12px", background: "#fff", fontSize: 13, color: "#000", fontWeight: 600 }}>
            <div><b style={{ color: "#000" }}>TABLE:</b> {r.tableId} · {r.floorLabel || ""}</div>
            <div><b style={{ color: "#000" }}>GUEST:</b> {r.customerName || "—"}{(r as any).partySize ? ` · ${(r as any).partySize} PAX` : ""}</div>
            <div><b style={{ color: "#000" }}>CAPTAIN:</b> {captainName}</div>
            {snap.aggName && snap.aggName !== "inhouse" && (
              <div><b style={{ color: "#000" }}>SOURCE:</b> {snap.aggName.toUpperCase()}{snap.discountPct > 0 ? ` (${snap.discountPct}% off)` : ""}</div>
            )}
          </div>
        </div>
        {/* ITEMS — thin-lined table */}
        <div style={{ padding: "0 18px 12px" }}>
          <div style={{ fontSize: 12, color: "#000", fontWeight: 700, letterSpacing: 1, marginBottom: 8 }}>ITEMS</div>
          <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff" }}>
            <thead>
              <tr>
                <th style={{ width: 44, textAlign: "center", fontSize: 11, fontWeight: 900, color: "#000", background: "#fff", padding: "5px 6px", border: "1px solid #000", textTransform: "uppercase", letterSpacing: .4 }}>Qty</th>
                <th style={{ textAlign: "left", fontSize: 11, fontWeight: 900, color: "#000", background: "#fff", padding: "5px 8px", border: "1px solid #000", textTransform: "uppercase", letterSpacing: .4 }}>Item</th>
                <th style={{ width: 78, textAlign: "right", fontSize: 11, fontWeight: 900, color: "#000", background: "#fff", padding: "5px 8px", border: "1px solid #000", textTransform: "uppercase", letterSpacing: .4 }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {snap.items.map((it, i) => (
                <tr key={i}>
                  <td style={{ textAlign: "center", fontSize: 13, color: "#000", padding: "5px 6px", border: "1px solid #000", fontVariantNumeric: "tabular-nums" }}>{it.qty}×</td>
                  <td style={{ textAlign: "left", fontSize: 13, color: "#000", padding: "5px 8px", border: "1px solid #000" }}>{it.n}</td>
                  <td style={{ textAlign: "right", fontSize: 13, color: "#000", padding: "5px 8px", border: "1px solid #000", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>₹{Math.round((it.p || 0) * (it.qty || 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* TOTALS — outlined box */}
        <div style={{ padding: "0 18px 12px" }}>
          <div style={{ border: "1px solid #000", borderRadius: 10, padding: "8px 14px", background: "#fff" }}>
            {row("Subtotal", `₹${Math.round(snap.subtotal)}`)}
            {snap.discountAmt > 0 && row(`Discount (${snap.discountPct}%)`, `−₹${Math.round(snap.discountAmt)}`)}
            {row("Service Charge (10%)", `₹${snap.scAmt}`)}
            {row("CGST", `₹${snap.cgst.toFixed(2)}`)}
            {row("SGST", `₹${snap.sgst.toFixed(2)}`)}
            <div style={{ height: 1, background: "#000", margin: "8px 0" }} />
            {row("GRAND TOTAL", `₹${Math.round(snap.finalAmount)}`, true)}
          </div>
        </div>
        {/* BUTTONS */}
        <div style={{ padding: 14, display: "flex", gap: 10, flexDirection: "column" }}>
          <button onClick={onConfirm} disabled={busy}
            data-testid="button-confirm-print-bill"
            style={{ padding: "16px", borderRadius: 10, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 17, fontWeight: 900, letterSpacing: 1, cursor: busy ? "wait" : "pointer", textTransform: "uppercase", boxShadow: "none" }}>
            {busy ? "PRINTING..." : "✓ CONFIRM & PRINT"}
          </button>
          <button onClick={onCancel} disabled={busy}
            style={{ padding: "12px", borderRadius: 10, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 700, letterSpacing: .5, cursor: busy ? "wait" : "pointer", textTransform: "uppercase" }}>
            ✗ CANCEL
          </button>
        </div>
      </div>
    </div>
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
      QR.toDataURL(url, { width: 320, margin: 1, color: { dark: "#000", light: "#ffffff" } })
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
    <div onClick={closeOnBackdrop(onClose)}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "#fff", border: "1px solid #000", borderRadius: 16,
          maxWidth: 360, width: "100%", padding: 20, fontFamily: "'Manrope','Space Grotesk',sans-serif", color: "#000" }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "#23A094", letterSpacing: .5, marginBottom: 4 }}>
          ✓ WALLET UNLOCKED · Menu opens on any device
        </div>
        <div style={{ fontSize: 19, fontWeight: 900, color: "#000", marginBottom: 4, letterSpacing: .3 }}>
          📱 Share with {customerName}
        </div>
        <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 14 }}>
          Table {tableId} · WhatsApp from POS didn't go through: {reason}
        </div>
        <div style={{ background: "#fff", borderRadius: 12, padding: 12, display: "flex", justifyContent: "center", marginBottom: 14 }}>
          {qrDataUrl
            ? <img src={qrDataUrl} alt="Wallet QR" style={{ width: "100%", maxWidth: 280, display: "block" }} />
            : <div style={{ width: 280, height: 280, display: "flex", alignItems: "center", justifyContent: "center", color: "#666", fontSize: 14 }}>Generating QR…</div>}
        </div>
        <div style={{ fontSize: 12, color: "#6B6B6B", textAlign: "center", marginBottom: 12, wordBreak: "break-all", padding: 8, background: "#fff", borderRadius: 8 }}>
          {url}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
          <button onClick={copyLink}
            style={{ padding: "11px 10px", borderRadius: 9, background: "#fff",
              border: "1px solid #000", color: "#000", fontSize: 13, fontWeight: 800,
              cursor: "pointer", letterSpacing: .4, fontFamily: "inherit", textTransform: "uppercase" }}>
            {copied ? "✓ COPIED" : "📋 COPY LINK"}
          </button>
          <button onClick={shareLink}
            style={{ padding: "11px 10px", borderRadius: 9, background: "rgba(37,211,102,.15)",
              border: "1px solid rgba(37,211,102,.45)", color: "#25D366", fontSize: 13, fontWeight: 800,
              cursor: "pointer", letterSpacing: .4, fontFamily: "inherit", textTransform: "uppercase" }}>
            📤 SHARE
          </button>
        </div>
        <button onClick={onClose}
          style={{ width: "100%", padding: "11px 14px", borderRadius: 9,
            background: "#FF90E8", border: "none",
            color: "#000", fontSize: 14, fontWeight: 900, cursor: "pointer",
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
  const safeAggDiscount = Number.isFinite(Number(aggDiscount)) ? Number(aggDiscount) : 0;
  const pending = (r.tabRounds || []).filter((rd) => rd.status === "preparing").length;
  const billReq = r.paymentStatus === "bill_requested";
  const paid = r.paymentStatus === "paid";
  // 🆕 2026-06-07 (Khushi) — prepaid-cover tables carry paymentStatus:"paid" from
  // the cover deposit while the food tab is still OPEN. `paid` stays for the PAID
  // badge, but reassign/overlap/occupancy must key off the TRUE settlement stamp
  // so a still-seated prepaid-cover table isn't treated as free/done.
  const billSettled = isTableBillSettled(r);
  const voided = (r as any).status === "voided";
  const arrived = !!r.actualArrivalTime;
  const canReassign = !billSettled && !voided;
  // 🔴 2026-05-20 (Khushi) — customer-calling outranks bill_due AND pending
  // for visual priority. Captain must see this from the LIST, not just after
  // opening the card.
  const calling = !!r.customerCallRequest;
  // 🆕 2026-05-20 (Khushi) — DOUBLE-BOOKING WARNING.
  // Same table assigned across different time slots (12:40 → 02:50 → 06:35)
  // is BY DESIGN — sequential parties across the night. But if TWO of those
  // are simultaneously active (arrived but not paid/voided), that's a real
  // double-seating conflict. Surface it as a red badge so captain can resolve.
  const activeOnSameTable = (allReservations || []).filter((x) =>
    x.tableId === r.tableId && x._docId !== r._docId &&
    !!x.actualArrivalTime &&
    !isTableBillSettled(x) &&
    (x as any).status !== "voided"
  ).length;
  const hasOverlap = arrived && !billSettled && !voided && activeOnSameTable > 0;

  const borderColor = calling ? "#FF5733"
    : hasOverlap ? "#FF5733"
    : billReq ? "#FF5733"
    : pending > 0 ? "#000"
    : voided ? "#FF5733"
    : "#fff";
  const bg = calling ? "#FFF0EC"
    : hasOverlap ? "#FFF0EC"
    : billReq ? "#FFF0EC"
    : pending > 0 ? "#FBF3D6"
    : "#fff";

  return (
    <>
    <div onClick={onClick}
      className={(calling || billReq) && String(r.tableId || "").trim() ? "pulse-red" : pending > 0 ? "pulse-gold" : ""}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "10px 12px", marginBottom: 6, borderRadius: 10,
        background: bg, border: `1px solid ${borderColor}`,
        cursor: "pointer", fontFamily: "'Manrope','Space Grotesk',sans-serif",
        transition: "background .15s",
      }}>
      {/* Table id pill — also tap-to-reassign */}
      <button
        onClick={(e) => { e.stopPropagation(); if (canReassign) setShowReassign(true); }}
        disabled={!canReassign}
        title={canReassign ? "Tap to reassign table" : ""}
        style={{ flexShrink: 0, minWidth: 66, textAlign: "center",
          padding: "10px 8px", borderRadius: 10,
          background: "#FF90E8",
          border: "2px solid #F2C744",
          color: "#000", fontSize: 20, fontWeight: 900, letterSpacing: .5,
          cursor: canReassign ? "pointer" : "default",
          fontFamily: "inherit", lineHeight: 1.1,
          boxShadow: "none" }}>
        {r.tableId}
        {canReassign && <div style={{ fontSize: 9, fontWeight: 800, opacity: .85, marginTop: 3, letterSpacing: .5 }}>🔄 SWAP</div>}
      </button>

      {/* Name + meta line */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 18, fontWeight: 900, color: "#6B6B6B",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            letterSpacing: .3 }}>
            {r.customerName || "—"}
          </span>
          {isAgg && (
            <span style={{ fontSize: 11, fontWeight: 800, padding: "2px 6px", borderRadius: 3,
              background: "#FF5733", color: "#fff", letterSpacing: .4, textTransform: "uppercase" }}>
              {aggLabel} · {safeAggDiscount}%
            </span>
          )}
          {!isAgg && (
            <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
              background: "#fff", color: "#6B6B6B",
              letterSpacing: .4, textTransform: "uppercase" }}>
              In-House
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 10, fontSize: 13, color: "#000", marginTop: 3, fontWeight: 600 }}>
          <span>👥 {r.partySize || "?"}p</span>
          <span>🕐 {r.arrivalTime || "—"}</span>
          {r.phone && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📱 {r.phone}</span>}
        </div>
        {hasOverlap && (
          <div style={{ marginTop: 4, fontSize: 11, fontWeight: 900, color: "#FF5733", letterSpacing: .4, textTransform: "uppercase" }}>
            ⚠ {activeOnSameTable + 1} GUESTS ACTIVE ON {r.tableId} — REASSIGN ONE
          </div>
        )}
      </div>

      {/* Status badges (right side) */}
      <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
        {calling && (
          <span style={{ fontSize: 12, fontWeight: 900, padding: "3px 8px", borderRadius: 4,
            background: "#FF5733", color: "#fff", letterSpacing: .4, boxShadow: "none" }}>🔔 CALLING</span>
        )}
        {voided ? (
          <span style={{ fontSize: 11, fontWeight: 900, padding: "2px 6px", borderRadius: 4,
            background: "#FF5733", color: "#fff", letterSpacing: .3 }}>🚫 VOIDED</span>
        ) : paid ? (
          <span style={{ fontSize: 11, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
            background: "#FBF3D6", border: "1px solid #000",
            color: "#000", letterSpacing: .3 }}>✅ PAID</span>
        ) : billReq ? (
          <span style={{ fontSize: 11, fontWeight: 900, padding: "2px 6px", borderRadius: 4,
            background: "#FFF0EC", border: "1px solid #FF5733",
            color: "#FF5733", letterSpacing: .3 }}>🧾 BILL DUE</span>
        ) : pending > 0 ? (
          <span style={{ fontSize: 11, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
            background: "#FBF3D6", border: "1px solid #000",
            color: "#000", letterSpacing: .3 }}>🔴 {pending} PENDING</span>
        ) : arrived ? (
          <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
            background: "#fff", border: "1px solid #000",
            color: "#6B6B6B", letterSpacing: .3 }}>✓ ARRIVED</span>
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
            style={{ fontSize: 12, fontWeight: 900, padding: "5px 9px", borderRadius: 6,
              background: "#FF90E8", border: "none",
              color: "#000", letterSpacing: .4, cursor: arriving ? "default" : "pointer",
              fontFamily: "'Manrope','Space Grotesk',sans-serif", textTransform: "uppercase",
              opacity: arriving ? .6 : 1, lineHeight: 1.1 }}
            title="Tap to mark this guest as arrived"
          >
            {arriving ? "..." : "🚶 Guest Arrived"}
          </button>
        )}
        <span style={{ fontSize: 11, color: "#6B6B6B" }}>tap →</span>
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

function BookingDetailModal({ r, captainName, playAlert, existingTables, allReservations, isPastDate, canSettle = true, onClose, onSeatAnother }: {
  r: HodTableReservation; captainName: string; playAlert: (u: boolean) => void;
  existingTables: string[]; allReservations: HodTableReservation[]; isPastDate?: boolean; canSettle?: boolean; onClose: () => void;
  onSeatAnother?: (tableId: string) => void;
}) {
  return (
    <div onClick={closeOnBackdrop(onClose)}
      style={{ position: "fixed", inset: 0,
        background: "#F4F4F0",
        zIndex: 9998,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start",
        padding: "10px 8px" }}>
      {/* 🆕 2026-06-03 v3.200 (Khushi) — the table detail used to render in a
          narrow 640px centred card; captains wanted it to FILL THE SCREEN so
          rounds + action buttons are big and easy to tap on the tablet. Now
          full-width (maxWidth 1280) + light #F4F4F0 backdrop (was a dark
          rgba(0,0,0,.55) scrim Khushi read as a "black background"). */}
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 1280, height: "calc(100vh - 20px)", position: "relative", display: "flex", flexDirection: "column" }}>
        {/* 🆕 2026-06-25 (Khushi) — header row: Seat Walk-In / Create Table sits at
            the TOP of the popup next to ✕ CLOSE, kept SEPARATE from the booking's
            own action buttons (ADD ORDER / REASSIGN / SEND MENU / RELEASE) below.
            It opens the WalkInModal pre-filled with THIS table so the captain can
            book the same table's next slot without backing out. */}
        {/* 🆕 2026-06-25 (Khushi) — header lives OUTSIDE the scroll area (flex
            child, not sticky) and the booking content scrolls in its own body
            below, so rounds can NEVER bleed through behind these buttons. */}
        <div style={{ flexShrink: 0, zIndex: 5, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8, background: "#F4F4F0", paddingBottom: 10, borderBottom: "2px solid #000" }}>
          {!!String(r.tableId || "").trim() && onSeatAnother && !isPastDate ? (
            <button onClick={() => onSeatAnother(String(r.tableId || "").trim())}
              style={{ padding: "10px 18px", borderRadius: 8, background: "#FF90E8",
                border: "2px solid #000", color: "#000",
                fontSize: 14, fontWeight: 900, cursor: "pointer",
                fontFamily: "'Manrope','Space Grotesk',sans-serif", letterSpacing: .5 }}>
              🚶 Seat Walk-In / Create Table
            </button>
          ) : <span />}
          <button onClick={onClose}
            style={{ padding: "10px 18px", borderRadius: 8, background: "#FF5733",
              border: "2px solid #000", color: "#fff",
              fontSize: 14, fontWeight: 900, cursor: "pointer",
              fontFamily: "'Manrope','Space Grotesk',sans-serif", letterSpacing: .5 }}>
            ✕ CLOSE
          </button>
        </div>
        {/* 🆕 2026-05-20 (Khushi) — soft gold glow ONLY, no outer border.
            TableCard already paints its own 2px status-driven border; adding
            another here caused the dual-outline Khushi flagged. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <div style={{ boxShadow: "none", borderRadius: 16 }}>
            <TableCard r={r} captainName={captainName} playAlert={playAlert} existingTables={existingTables} allReservations={allReservations} isPastDate={isPastDate} canSettle={canSettle} onSeatAnother={onSeatAnother} />
          </div>
        </div>
      </div>
    </div>
  );
}

// 🆕 2026-05-20 (Khushi spec) — Floor-plan dashboard replaces the list view.
// 3 tabs (Ground/Dining/Rooftop) over the SAME SVG layout the customer site
// uses, with 4 status states per table:
//   WHITE  + plus    = free  (tap → walk-in modal pre-filled w/ tableId+floor)
//   RED    blinking  = bill due / customer calling (shows queue # by oldest-first)
//   ORANGE blinking  = waiting kitchen (shows mins since earliest preparing round)
//   GREEN            = eating (shows running tab ₹ inclusive of taxes)
// Tap any occupied table = open existing BookingDetailModal (no backend change).
// 🛟 FALLBACK: if floor-plan crashes, KPI tiles + search bar remain functional
// and captain can still open tables via the orphan-calls strip + waiter-call
// banner. Walk-in CTA above is unchanged so seating still works.
// 🆕 2026-06-25 — shared known-floor set for proxy-on-map homing (used by both
// proxyTiles and the off-map exclusion). Hoisted so we don't allocate per row.
const KNOWN_FLOOR_KEYS = new Set<string>(["dance", "dining", "rooftop"]);

type FloorTableStatus =
  | { state: "free" }
  | { state: "red"; r: HodTableReservation; ts: number; queue?: number }
  | { state: "orange"; r: HodTableReservation; since: number }
  | { state: "green"; r: HodTableReservation; tab: number };

function FloorPlanView({
  reservations, customerSearch, pendingFilter, activeWaiterCallTableIds,
  readyKDSResIds,
  onSelectReservation, onSelectFreeTable,
  focusFloorKey, focusModeOn, tabletFloorLabel, onToggleFocusMode,
}: {
  reservations: HodTableReservation[];
  customerSearch: string;
  // 🔴 2026-05-20 — when captain taps a KPI tile (Calling/Pending/Bill Due),
  // we narrow the visual map to matching tables AND auto-jump to the floor
  // that has at least one match, so a ping on the rooftop can't hide while
  // captain stares at dining.
  pendingFilter: "" | "pending" | "bill" | "calling" | "ready";
  activeWaiterCallTableIds: Set<string>;
  // 🍳 2026-05-21 (Khushi) — set of reservation _docIds with at least one
  // KDS item in status="ready" (chef bumped, captain hasn't picked up yet).
  // Used to pulse those table tiles GREEN on the floor map so captain spots
  // ready food from across the room without opening the card.
  readyKDSResIds: Set<string>;
  onSelectReservation: (docId: string) => void;
  onSelectFreeTable: (tableId: string, floorKey: FloorKey, floorLabel: string) => void;
  // 🆕 2026-05-26 v3.10 — Focus Mode. focusFloorKey is non-null only when ON
  // AND the tablet has a floor set. Used to (a) render the gold status pill
  // above the floor tabs and (b) auto-pin the SVG tab to that floor so the
  // captain doesn't see empty-looking floors they don't own.
  focusFloorKey: FloorKey | null;
  focusModeOn: boolean;
  tabletFloorLabel: string | null;
  onToggleFocusMode: () => void;
}) {
  const [activeFloor, setActiveFloor] = useState<FloorKey>(focusFloorKey || "dining");
  // 🆕 2026-05-26 v3.10 — when focus mode flips ON (or the tablet's floor
  // changes), snap the SVG to that floor so captain isn't staring at an empty
  // dining map when their tablet owns rooftop. When focus mode flips OFF the
  // captain keeps whichever tab they last had — no surprise jumps.
  useEffect(() => { if (focusFloorKey) setActiveFloor(focusFloorKey); }, [focusFloorKey]);
  // Tick every 30s so ORANGE timers refresh on screen without re-querying Firestore.
  const [, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 30000); return () => clearInterval(id); }, []);

  const q = customerSearch.trim().toLowerCase();

  // 🔴 2026-05-20 — Reservations are matched by tableId ONLY (case-insensitive).
  // Strict floor match was previously failing for legacy/aggregator rows whose
  // `floor` field is missing or stale — those tables falsely showed as FREE.
  // tableId is globally unique across all 3 floors (no collisions in
  // TABLE_OPTIONS), so a tableId-only match is safe AND fail-open.
  // 🛟 FALLBACK: reservations whose tableId is unknown to HOD_TABLES (e.g. POS
  // has FD13/SMK3 but customer-site SVG never added those nodes, or a Proxy-N
  // walk-in, or a typo) get surfaced in the off-map overflow strip below.
  // 🆕 2026-06-12 v3.257 — same-table conflict resolution. A table can end up
  // with TWO non-cancelled reservations (e.g. an 8pm advance assignment + a
  // 7:40pm walk-in seated on the SAME table). The old code did m.set(id,r) in
  // raw array order, so the LAST row won the floor tile — which could be the
  // stale EMPTY assignment, HIDING the booking that actually has live orders
  // (captain clicks the table → sees the no-transaction 8pm row while the real
  // orders/KOT/bill sit invisible). Now the reservation with the most "live"
  // activity wins the tile (orders-to-fire > orders > bill/call > seated >
  // stale assignment), so the table the guest is really sitting at is what
  // blinks. The shadowed booking (if it has its OWN live activity) is surfaced
  // in the off-map strip below so a second active booking is never hidden.
  const _occScore = (r: HodTableReservation): number => {
    let s = 0;
    const rounds = r.tabRounds || [];
    if (rounds.some(rd => rd.status === "preparing")) s += 16; // KOT not yet printed
    if (rounds.length) s += 8;                                  // has any orders
    if (r.paymentStatus === "bill_requested") s += 8;
    if (r.customerCallRequest) s += 8;
    if (r.actualArrivalTime) s += 4;                            // physically seated
    return s;
  };
  const reservationByTableId = useMemo(() => {
    const m = new Map<string, HodTableReservation>();
    reservations.forEach(r => {
      if ((r as any).status === "cancelled") return;
      const id = (r.tableId || "").toUpperCase();
      if (!id) return;
      const prev = m.get(id);
      // Higher live-activity score wins the tile; ties keep the first seen
      // (stable, no churn). An empty assignment can never displace a table
      // that already has orders/bill/call.
      if (!prev || _occScore(r) > _occScore(prev)) m.set(id, r);
    });
    return m;
  }, [reservations]);

  // Compute red-state score (min of all known event timestamps) for a reservation.
  const redEventTs = (r: HodTableReservation): number => {
    const cands: number[] = [];
    const callAtRaw = r.customerCallRequest && (r.customerCallRequest as any).at;
    if (callAtRaw) { const t = new Date(callAtRaw).getTime(); if (t) cands.push(t); }
    const billAtRaw = (r as any).billRequestedAt;
    if (billAtRaw) { const t = new Date(billAtRaw).getTime(); if (t) cands.push(t); }
    if (!cands.length) {
      const t = new Date((r as any).bookedAt || 0).getTime();
      if (t) cands.push(t);
    }
    return cands.length ? Math.min(...cands) : Date.now();
  };

  // Per-floor occupancy + per-floor matches for the active filter.
  const floorStats = useMemo(() => {
    const out: Record<FloorKey, { occ: number; matches: number }> = {
      dance: { occ: 0, matches: 0 }, dining: { occ: 0, matches: 0 }, rooftop: { occ: 0, matches: 0 },
    };
    (Object.keys(HOD_TABLES) as FloorKey[]).forEach(fk => {
      HOD_TABLES[fk].tables.forEach(t => {
        const r = reservationByTableId.get(t.id.toUpperCase());
        if (!r) return;
        out[fk].occ += 1;
        const isCalling = !!r.customerCallRequest || activeWaiterCallTableIds.has(t.id.toLowerCase());
        const isBill = r.paymentStatus === "bill_requested";
        const isPending = (r.tabRounds || []).some(rd => rd.status === "preparing");
        const matchesQ = q && [r.customerName, r.phone, r.tableId, r.bookingRef].filter(Boolean).join(" ").toLowerCase().includes(q);
        if (pendingFilter === "calling" && isCalling) out[fk].matches += 1;
        else if (pendingFilter === "bill" && isBill) out[fk].matches += 1;
        else if (pendingFilter === "pending" && isPending) out[fk].matches += 1;
        else if (pendingFilter === "ready" && readyKDSResIds.has(r._docId)) out[fk].matches += 1;
        else if (!pendingFilter && matchesQ) out[fk].matches += 1;
      });
    });
    return out;
  // 🆕 2026-05-26 v3.10 (code-review fix) — include readyKDSResIds so the
  // READY KPI count + auto-jump re-fire when chef bumps a new item; without
  // this, ready-state changes were stale until another dep churned.
  }, [reservationByTableId, activeWaiterCallTableIds, pendingFilter, q, readyKDSResIds]);

  // Auto-jump to floor with the first match when filter/search changes OR
  // when a NEW realtime match arrives on another floor while a filter is on
  // (e.g., new customerCallRequest on rooftop while captain stares at dining).
  // Deps include floorStats so incoming pings re-trigger the jump check.
  useEffect(() => {
    if (!pendingFilter && !q) return;
    if (floorStats[activeFloor].matches > 0) return;
    const target = (["dance","dining","rooftop"] as FloorKey[]).find(k => floorStats[k].matches > 0);
    if (target && target !== activeFloor) setActiveFloor(target);
  }, [pendingFilter, q, floorStats, activeFloor]);

  const floorData = HOD_TABLES[activeFloor];

  // 🆕 2026-06-25 (Khushi) — PROXY / EXTRA tables now render as circles ON the
  // floor map (named "Proxy-N") and behave like any real table (red/orange/
  // green states, tap-to-open), instead of only living in the off-map strip.
  // A proxy is matched to its floor by the `floor` field it was created with
  // (dance/dining/rooftop). They're laid out in a band BELOW the room layout
  // (the viewBox is extended at render time) so they never overlap real tiles.
  const proxyTiles = useMemo<FloorTable[]>(() => {
    const out: FloorTable[] = [];
    const seen = new Set<string>();
    reservations.forEach((r) => {
      if ((r as any).status === "cancelled") return;
      const id = r.tableId || "";
      if (!/^proxy-/i.test(id)) return;
      const fk = (r.floor || "").toLowerCase();
      if (!KNOWN_FLOOR_KEYS.has(fk) || fk !== activeFloor) return; // legacy/unknown-floor proxies stay in off-map strip
      const up = id.toUpperCase();
      if (seen.has(up)) return;
      seen.add(up);
      out.push({ id, seats: r.partySize || 2, sh: "circle", cx: 0, cy: 0, r: 34 });
    });
    out.sort((a, b) => (parseInt(a.id.replace(/\D/g, ""), 10) || 0) - (parseInt(b.id.replace(/\D/g, ""), 10) || 0));
    const parts = floorData.vb.split(/\s+/).map(Number);
    const vbW = parts[2] || 500, vbH = parts[3] || 430;
    const perRow = Math.max(1, Math.floor((vbW - 40) / 96));
    out.forEach((t, i) => {
      const col = i % perRow, row = Math.floor(i / perRow);
      t.cx = 52 + col * 96;
      t.cy = vbH + 74 + row * 84;
    });
    return out;
  }, [reservations, activeFloor, floorData.vb]);
  const renderTables = useMemo<FloorTable[]>(() => [...floorData.tables, ...proxyTiles], [floorData.tables, proxyTiles]);

  const statuses = useMemo(() => {
    const m = new Map<string, FloorTableStatus>();
    renderTables.forEach((t) => {
      const r = reservationByTableId.get(t.id.toUpperCase());
      if (!r) { m.set(t.id, { state: "free" }); return; }
      // Waiter-call header taps mirror to customerCallRequest but can fail
      // silently (no linkedTableRef / prod rules) — so we also flip the table
      // to RED if there's an active unmatched waiterCall keyed to this table.
      const calling = !!r.customerCallRequest || activeWaiterCallTableIds.has(t.id.toLowerCase());
      const billDue = r.paymentStatus === "bill_requested";
      if (calling || billDue) {
        m.set(t.id, { state: "red", r, ts: redEventTs(r) });
        return;
      }
      // 🆕 2026-05-20 (Khushi spec correction) — RED vs ORANGE means:
      //   RED    = round PLACED but KOT NOT YET PRINTED (status="preparing")
      //            → captain action needed: HIT PRINT KOT
      //   ORANGE = KOT printed, kitchen cooking (status="activated")
      //            → waiting timer ticks from activatedAt
      //   GREEN  = all rounds served (or no rounds)
      // Previously preparing = orange, activated never surfaced as orange so a
      // table whose KOT was already fired showed GREEN (FD17 bug Khushi caught).
      const preparing = (r.tabRounds || []).filter(rd => rd.status === "preparing");
      if (preparing.length) {
        const earliest = preparing.reduce((min, rd) => {
          const t = new Date((rd as any).placedAt || 0).getTime();
          return t && t < min ? t : min;
        }, Date.now());
        m.set(t.id, { state: "red", r, ts: earliest });
        return;
      }
      const activated = (r.tabRounds || []).filter(rd => rd.status === "activated");
      if (activated.length) {
        const earliest = activated.reduce((min, rd) => {
          const t = new Date((rd as any).activatedAt || (rd as any).placedAt || 0).getTime();
          return t && t < min ? t : min;
        }, Date.now());
        m.set(t.id, { state: "orange", r, since: earliest });
        return;
      }
      // Reservation exists but no preparing/billed → seated & eating. Tab total
      // is inclusive of taxes via computeHodBreakdown (same math the customer
      // wallet shows, so captain ₹ == customer ₹).
      const allItems = (r.tabRounds || []).flatMap(rd => rd.items || []);
      const tab = allItems.length ? computeHodBreakdown(allItems).grandTotal : 0;
      m.set(t.id, { state: "green", r, tab });
    });
    // Assign queue # to RED tables (oldest event first = #1).
    const reds: Array<[string, FloorTableStatus]> = [];
    m.forEach((s, id) => { if (s.state === "red") reds.push([id, s]); });
    reds.sort((a, b) => (a[1] as any).ts - (b[1] as any).ts);
    reds.forEach(([id, s], i) => m.set(id, { ...(s as any), queue: i + 1 }));
    return m;
  }, [renderTables, reservationByTableId, activeWaiterCallTableIds]);

  // Filter-match set — tables matching the active KPI filter OR the search
  // query. When non-empty, non-matching tables get dimmed so the captain's eye
  // jumps straight to the action. Matched tables also get a dashed gold ring.
  const filterMatches = useMemo(() => {
    const s = new Set<string>();
    renderTables.forEach((t) => {
      const st = statuses.get(t.id);
      if (!st || st.state === "free") return;
      const r = (st as any).r as HodTableReservation;
      if (pendingFilter === "calling" && st.state === "red" &&
          (!!r.customerCallRequest || activeWaiterCallTableIds.has(t.id.toLowerCase()))) {
        s.add(t.id); return;
      }
      if (pendingFilter === "bill" && r.paymentStatus === "bill_requested") { s.add(t.id); return; }
      // 🐛 2026-05-25 v3.6 (Khushi BUG REPORT) — was `state === "orange"` which
      // is WRONG per the 2026-05-20 state semantics fix above:
      //   RED   = preparing (KOT NOT yet printed) ← what "Pending" means
      //   ORANGE = activated (cooking)
      // The KPI counter (line ~4440) correctly sums `preparing` rounds, so
      // the badge said "1 PENDING" but the floor map highlighted nothing
      // because no table was in state==="orange". Fix: gate on the actual
      // preparing-round predicate, identical to floorStats (line ~3928).
      if (pendingFilter === "pending" && (r.tabRounds || []).some(rd => rd.status === "preparing")) { s.add(t.id); return; }
      if (pendingFilter === "ready" && readyKDSResIds.has(r._docId)) { s.add(t.id); return; }
      if (!pendingFilter && q) {
        const hay = [r.customerName, r.phone, r.tableId, r.bookingRef].filter(Boolean).join(" ").toLowerCase();
        if (hay.includes(q)) s.add(t.id);
      }
    });
    return s;
  // 🆕 2026-05-26 v3.10 (code-review fix) — include readyKDSResIds so map
  // highlighting refreshes the moment chef bumps an item (was stale before).
  }, [q, pendingFilter, statuses, renderTables, activeWaiterCallTableIds, readyKDSResIds]);
  const hasActiveFilter = !!pendingFilter || !!q;

  // 🛟 Off-map reservations: any non-cancelled reservation whose tableId is NOT
  // a node on any floor of HOD_TABLES. Sources: POS-only tables (FD13/SMK3),
  // Proxy-N walk-ins, typos, legacy aggregator imports. Surface as a strip
  // below the map so captain can still open them — never silently hidden.
  const allMapTableIds = useMemo(() => {
    const s = new Set<string>();
    (Object.keys(HOD_TABLES) as FloorKey[]).forEach(fk =>
      HOD_TABLES[fk].tables.forEach(t => s.add(t.id.toUpperCase())));
    return s;
  }, []);
  const offMapReservations = useMemo(() => {
    return reservations.filter(r => {
      if ((r as any).status === "cancelled") return false;
      const id = (r.tableId || "").toUpperCase();
      // No table assigned → surface so captain can assign one.
      if (!id) return true;
      // HOD_TABLES tile (regular floor SVG): captain accesses this booking via
      // the floor tile + multi-slot picker (v3371). Never duplicate it here.
      if (allMapTableIds.has(id)) return false;
      // 🆕 2026-06-25 (Khushi) — a Proxy-N with a valid floor now renders ON the
      // floor map (see proxyTiles), so its WINNER must NOT also appear in the
      // off-map strip (it would duplicate). Shadow bookings on the same proxy
      // with their own live activity still surface here so nothing is hidden.
      const isHomedProxy = /^proxy-/i.test(r.tableId || "") &&
        KNOWN_FLOOR_KEYS.has((r.floor || "").toLowerCase());
      const winner = reservationByTableId.get(id);
      if (winner && winner._docId === r._docId) return isHomedProxy ? false : true;
      return _occScore(r) > 0;
    });
  }, [reservations, allMapTableIds, reservationByTableId]);

  const colorFor = (state: FloorTableStatus["state"]) => {
    if (state === "free")   return { stroke: "#000", fill: "#fff", text: "#000" };
    if (state === "red")    return { stroke: "#FF5733", fill: "#FF5733",   text: "#fff" };
    if (state === "orange") return { stroke: "#F59E0B", fill: "#F2C744",  text: "#000" };
    return                       { stroke: "#23A094", fill: "#E6F5F2",   text: "#23A094" };
  };
  const fmtMins = (since: number) => {
    const m = Math.max(0, Math.floor((Date.now() - since) / 60000));
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h${m % 60 ? (m % 60) + "m" : ""}`;
  };

  const renderTable = (t: FloorTable) => {
    const s = statuses.get(t.id) || { state: "free" as const };
    const c = colorFor(s.state);
    const blink = s.state === "red" || s.state === "orange";
    const matched = filterMatches.has(t.id);
    // Dim when a filter is on AND this table isn't a match — but never dim a
    // RED state (a customer-calling table must stay loud even outside filter).
    const dimmed = hasActiveFilter && !matched && s.state !== "red";
    let cx = 0, cy = 0;
    let shape: ReactElement;
    const shapeProps = {
      fill: c.fill, stroke: c.stroke, strokeWidth: 2.2,
      style: { cursor: "pointer", filter: blink ? `drop-shadow(0 0 6px ${c.stroke})` : undefined },
    };
    if (t.sh === "circle") {
      cx = t.cx!; cy = t.cy!;
      shape = <circle cx={cx} cy={cy} r={t.r} {...shapeProps} />;
    } else if (t.sh === "rect") {
      cx = (t.x || 0) + (t.w || 0) / 2;
      cy = (t.y || 0) + (t.h || 0) / 2;
      shape = <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={6} {...shapeProps} />;
    } else {
      cx = t.cx!; cy = t.cy!;
      const r = t.r!;
      const points = `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
      shape = <polygon points={points} {...shapeProps} />;
    }
    // 🆕 2026-05-20 (Khushi) — badge updates:
    //   RED   → "Q#N" (was "#N") so captain reads "Queue #1" without guessing
    //   ORANGE → running tab ₹ + mins-since-KOT, e.g. "₹1185 · 29m"
    //   GREEN  → running tab ₹ if there's a bill, else "A" (assigned, customer
    //            not arrived yet) so captain can tell an assigned-but-empty
    //            table from one that's actively eating with no order yet.
    let badge = "";
    // 🆕 2026-05-20 (Khushi) — free tiles show pax capacity ("2p", "4p", "6p")
    // so captain reads seat counts at a glance without tapping in.
    if (s.state === "free") badge = `${t.seats}p`;
    else if (s.state === "red" && (s as any).queue) badge = `#Q${(s as any).queue}`;
    else if (s.state === "orange") {
      // 🆕 2026-05-20 (Khushi) — orange: timer in the middle slot, ₹ moves to
      // top-right corner (rendered separately below as `cornerPrice`).
      badge = fmtMins((s as any).since);
    }
    else if (s.state === "green") {
      const r = (s as any).r as HodTableReservation;
      const tab = (s as any).tab;
      if (tab > 0) badge = `₹${tab}`;
      // 🆕 2026-05-20 (Khushi) — any green tile WITHOUT an order = "A"
      // (assigned). Don't show "4p" for "arrived but not ordered" — Khushi
      // found it confusing vs "FD2: A" / "SMK8: 4p" on the same screen.
      else badge = "A";
    }

    const onClick = () => {
      if (s.state === "free") onSelectFreeTable(t.id, activeFloor, floorData.label);
      else onSelectReservation(((s as any).r as HodTableReservation)._docId);
    };

    // 🆕 2026-05-20 (Khushi) — top-right ₹ corner label for ORANGE tables.
    // Captain sees running tab ₹ even while the timer occupies the middle slot.
    let cornerPrice = "";
    let cornerX = cx, cornerY = cy;
    if (s.state === "orange") {
      const orgR = (s as any).r as HodTableReservation;
      const items = (orgR.tabRounds || []).flatMap(rd => rd.items || []);
      const tab = items.length ? computeHodBreakdown(items).grandTotal : 0;
      if (tab > 0) {
        cornerPrice = `₹${tab}`;
        if (t.sh === "rect") {
          cornerX = (t.x || 0) + (t.w || 0) - 3;
          cornerY = (t.y || 0) + 9;
        } else if (t.sh === "circle") {
          const rad = t.r || 0;
          cornerX = cx + rad * 0.62;
          cornerY = cy - rad * 0.55;
        } else {
          const rad = t.r || 0;
          cornerX = cx + rad * 0.45;
          cornerY = cy - rad * 0.35;
        }
      }
    }

    // 🍳 2026-05-21 (Khushi) — pulse animations for tile-level alerts.
    // GREEN pulse trumps amber: a table with ready food needs immediate
    // service even if some other dish is still cooking.
    const resForTile = (s as any).r as HodTableReservation | undefined;
    const tileReady = !!(resForTile && readyKDSResIds.has(resForTile._docId));
    const tileClasses: string[] = [];
    if (blink) tileClasses.push("hod-flash");
    if (tileReady) tileClasses.push("hod-tile-ready");
    else if (s.state === "orange") tileClasses.push("hod-tile-orange");
    return (
      <g key={t.id} onClick={onClick} className={tileClasses.join(" ") || undefined} style={{ cursor: "pointer", opacity: dimmed ? 0.28 : 1, transition: "opacity .2s" }}>
        {matched && t.sh === "circle" && <circle cx={cx} cy={cy} r={(t.r || 0) + 4} fill="none" stroke="#000" strokeWidth={1.5} strokeDasharray="3 3" />}
        {matched && t.sh === "rect" && <rect x={(t.x || 0) - 4} y={(t.y || 0) - 4} width={(t.w || 0) + 8} height={(t.h || 0) + 8} rx={8} fill="none" stroke="#000" strokeWidth={1.5} strokeDasharray="3 3" />}
        {shape}
        {/* 🍳 2026-05-21 (Khushi) — marching-dash green ring around the tile
            when food is READY at the pass. Swaps the previous green dot for
            a more eye-catching rotating dashed outline. Disappears the moment
            captain taps ✓ PICKED UP (or ✓ MARK SERVED inside the card) because
            tileReady recomputes from the live posKDSItems subscription. */}
        {tileReady && t.sh === "circle" && (
          <circle cx={cx} cy={cy} r={(t.r || 0) + 5} className="hod-tile-ready-ring" />
        )}
        {tileReady && t.sh === "rect" && (
          <rect x={(t.x || 0) - 5} y={(t.y || 0) - 5} width={(t.w || 0) + 10} height={(t.h || 0) + 10} rx={8} className="hod-tile-ready-ring" />
        )}
        {tileReady && t.sh !== "circle" && t.sh !== "rect" && (
          /* Diamond / polygon — ring rendered as a slightly larger polygon. */
          <polygon
            points={`${cx},${cy - ((t.r || 0) + 5)} ${cx + ((t.r || 0) + 5)},${cy} ${cx},${cy + ((t.r || 0) + 5)} ${cx - ((t.r || 0) + 5)},${cy}`}
            className="hod-tile-ready-ring"
          />
        )}
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize="11" fontWeight={900}
          fill={c.text} fontFamily="'Manrope','Space Grotesk',sans-serif" style={{ pointerEvents: "none" }}>
          {proxyDisplayLabel(t.id) || t.id}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" fontSize="10" fontWeight={800}
          fill={s.state === "green" && badge.startsWith("₹") ? "#000" : c.text}
          fontFamily="'Manrope','Space Grotesk',sans-serif" opacity={0.95} style={{ pointerEvents: "none" }}>
          {badge || `${t.seats}p`}
        </text>
        {cornerPrice && (
          // 🆕 2026-05-20 (Khushi) — ₹ in BOLD WHITE for max contrast on orange.
          <text x={cornerX} y={cornerY} textAnchor="end" fontSize="9" fontWeight={900}
            fill="#000" fontFamily="'Space Grotesk','Manrope',sans-serif" style={{ pointerEvents: "none" }}>
            {cornerPrice}
          </text>
        )}
      </g>
    );
  };

  return (
    <div style={{ padding: "0 12px 120px" }}>
      <style>{`@keyframes hodFlash { 0%,100%{opacity:1} 50%{opacity:.55} } .hod-flash { animation: hodFlash 1.2s ease-in-out infinite; }`}</style>

      {/* 🆕 2026-05-26 v3.10 — FOCUS MODE pill. Off-by-default per-tablet flag
          that scopes Firestore listeners + the floor map to this tablet's
          assigned floor only. Tap to toggle. If the tablet has no floor set
          OR focusModeOn but focusFloorKey===null (fail-safe), we show a small
          gray "SET FLOOR FIRST" hint instead of an active pill so captain is
          never silently hiding rows. */}
      {/* 🙈 2026-06-03 v3.205 (Khushi) — focus-mode control (SHOWING ALL FLOORS ·
          TAP TO FOCUS + the set-floor fallback) HIDDEN for now per her request.
          Flip `false` back to `true` to restore it when she asks. */}
      {false && (tabletFloorLabel ? (
        <button onClick={onToggleFocusMode}
          style={{
            width: "100%", marginTop: 8, padding: "8px 12px", borderRadius: 10,
            background: focusModeOn && focusFloorKey ? "#FBF3D6" : "#fff",
            border: `1.5px solid ${focusModeOn && focusFloorKey ? "#000" : "#6B6B6B"}`,
            color: focusModeOn && focusFloorKey ? "#000" : "#6B6B6B",
            fontSize: 11, fontWeight: 900, letterSpacing: 0.6, cursor: "pointer",
            textAlign: "center",
          }}>
          {focusModeOn && focusFloorKey
            ? `🎯 FOCUS: ${tabletFloorLabel} ONLY · TAP TO SHOW ALL FLOORS`
            : `👁 SHOWING ALL FLOORS · TAP TO FOCUS ON ${tabletFloorLabel} ONLY`}
        </button>
      ) : (
        // 🆕 2026-05-26 v3.10 — tablet has no floor set. Show 3 tap-to-set
        // buttons INLINE so non-technical staff (Khushi, captains) can pick
        // their floor without touching the browser console. Writes through
        // setTabletFloor() → same localStorage key the rest of the app reads,
        // so it persists across reloads. Page reload after click ensures
        // every Firestore listener picks up the new floor.
        <div style={{
          marginTop: 8, padding: "8px 12px", borderRadius: 10,
          background: focusModeOn ? "#FFF0EC" : "#fff",
          border: `1.5px solid ${focusModeOn ? "#FF5733" : "#6B6B6B"}`,
        }}>
          <div style={{
            color: focusModeOn ? "#FF5733" : "#6B6B6B",
            fontSize: 11, fontWeight: 900, letterSpacing: 0.6, textAlign: "center",
            marginBottom: 8,
          }}>
            {focusModeOn
              ? "⚠ FOCUS MODE IS ON BUT TABLET FLOOR NOT SET — SHOWING ALL FLOORS"
              : "🎯 SET THIS TABLET'S FLOOR TO ENABLE FOCUS MODE"}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6 }}>
            {([
              { key: "ground", label: "GROUND" },
              { key: "first", label: "DINING (FF)" },
              { key: "rooftop", label: "ROOFTOP" },
            ] as { key: TabletFloor; label: string }[]).map((b) => (
              <button key={b.key}
                onClick={() => { setTabletFloor(b.key); location.reload(); }}
                style={{
                  padding: "8px 6px", borderRadius: 8,
                  background: "#FBF3D6", border: "1.5px solid #000",
                  color: "#000", fontSize: 11, fontWeight: 900, letterSpacing: 0.4,
                  cursor: "pointer",
                }}>📍 {b.label}</button>
            ))}
          </div>
        </div>
      ))}


      {/* Floor tabs — Ground/Dining/Rooftop */}
      {/* 🆕 2026-05-26 v3.10 (code-review fix) — when Focus Mode is locked to
          a floor, the OTHER tabs become disabled. Reason: their reservations
          have been filtered upstream by the scoped sub, so tapping them would
          render those floors as "all free" and let captain accidentally start
          a walk-in on a table that's actually occupied. We KEEP the disabled
          tabs visible (gray, no counter) so captain knows what they're
          missing — clearer than hiding them entirely. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6, padding: "10px 0" }}>
        {(["dance","dining","rooftop"] as FloorKey[]).map(k => {
          const active = k === activeFloor;
          const label = k === "dance" ? "GROUND" : k === "dining" ? "DINING" : "ROOFTOP";
          const locked = !!(focusModeOn && focusFloorKey && k !== focusFloorKey);
          // Show occupancy counter per tab. Uses the same tableId-only matching
          // as the map itself (via floorStats) so legacy/aggregator rows with
          // stale or missing `floor` aren't undercounted vs the visible state.
          const occ = floorStats[k].occ;
          return (
            <button key={k} onClick={() => { if (!locked) setActiveFloor(k); }}
              disabled={locked}
              title={locked ? "Focus Mode is ON — tap the gold pill above to see all floors" : undefined}
              style={{
                padding: "10px 8px", borderRadius: 10,
                background: locked ? "#F4F4F0" : active ? "#FF90E8" : "#fff",
                color: locked ? "#6B6B6B" : "#000",
                border: "1.5px solid #000",
                fontSize: 13, fontWeight: 900, letterSpacing: 0.6,
                cursor: locked ? "not-allowed" : "pointer",
              }}>{locked ? "🔒 " : ""}{label}{locked ? "" : <> <span style={{ opacity: 0.7, fontWeight: 700 }}>{occ}/{HOD_TABLES[k].tables.length}</span></>}</button>
          );
        })}
      </div>

      {/* Legend — 🆕 2026-06-25 (Khushi) font bumped 10→14px + swatch 12→16px for tablet readability */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 14, fontWeight: 800, color: "#6B6B6B", padding: "0 2px 10px", letterSpacing: 0.4 }}>
        <span><span style={{ display: "inline-block", width: 16, height: 16, background: "#fff", border: "2px solid #000", borderRadius: 3, verticalAlign: "middle", marginRight: 6 }} />TABLE AVAILABLE</span>
        <span style={{ color: "#FF5733" }}><span style={{ display: "inline-block", width: 16, height: 16, background: "#FF5733", border: "1.5px solid #FF5733", borderRadius: 3, verticalAlign: "middle", marginRight: 6 }} />TAKE ORDER / BILL</span>
        <span style={{ color: "#000" }}><span style={{ display: "inline-block", width: 16, height: 16, background: "#F59E0B", border: "1.5px solid #F59E0B", borderRadius: 3, verticalAlign: "middle", marginRight: 6 }} />WAITING FOR F&amp;B</span>
        <span style={{ color: "#23A094" }}><span style={{ display: "inline-block", width: 16, height: 16, background: "#23A094", border: "1.5px solid #23A094", borderRadius: 3, verticalAlign: "middle", marginRight: 6 }} />RUNNING TABLE</span>
      </div>

      {/* SVG floor plan */}
      <div style={{ background: "#F4F4F0", borderRadius: 14, border: "2px solid #000", padding: 8 }}>
        {(() => {
          // 🆕 2026-06-25 (Khushi) — when proxy/extra tables exist on this floor,
          // extend the viewBox downward to fit a "PROXY / EXTRA TABLES" band so
          // the synthetic proxy circles never overlap the real room layout.
          const parts = floorData.vb.split(/\s+/).map(Number);
          const vx = parts[0] || 0, vy = parts[1] || 0, vbW = parts[2] || 500, vbH = parts[3] || 430;
          const perRow = Math.max(1, Math.floor((vbW - 40) / 96));
          const proxyRows = proxyTiles.length ? Math.ceil(proxyTiles.length / perRow) : 0;
          const extH = proxyRows ? vbH + 30 + proxyRows * 84 + 12 : vbH;
          const mapVb = proxyRows ? `${vx} ${vy} ${vbW} ${extH}` : floorData.vb;
          return (
            <svg viewBox={mapVb} style={{ width: "100%", height: "auto", display: "block" }}
              xmlns="http://www.w3.org/2000/svg">
              {/* Background (stairs, walls, BAR labels) copied verbatim from the
                  customer site so the captain sees the same room layout the guest
                  sees when booking. Static SVG — no event handlers. */}
              <g dangerouslySetInnerHTML={{ __html: floorData.bg }} />
              {proxyRows > 0 && (
                <g>
                  <line x1={10} y1={vbH + 16} x2={vbW - 10} y2={vbH + 16} stroke="#000" strokeWidth={1} strokeDasharray="4 4" />
                  <text x={14} y={vbH + 36} fontSize="11" fontWeight={900} fill="#000"
                    fontFamily="'Manrope','Space Grotesk',sans-serif">📦 PROXY / EXTRA TABLES</text>
                </g>
              )}
              {renderTables.map(renderTable)}
            </svg>
          );
        })()}
      </div>

      {/* 🛟 Off-map reservations strip — tables that exist in POS but have no
          node on the SVG (FD13/SMK3, Proxy-N walk-ins, typos, legacy imports).
          Without this, taking a phone call for "Karthik on FD13" would leave
          captain wondering where the table went. */}
      {offMapReservations.length > 0 && (
        <div style={{ marginTop: 12, background: "#F4F4F0", border: "2px solid #000", borderRadius: 12, padding: 12, boxShadow: "3px 3px 0 rgba(0,0,0,0.1)" }}>
          <div style={{ fontSize: 12, fontWeight: 900, color: "#000", letterSpacing: 0.8, marginBottom: 10, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ background: "#FF90E8", border: "2px solid #000", borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 900 }}>{offMapReservations.length}</span>
            Tables Not On Map — Tap To Open
          </div>
          {/* 🆕 2026-06-08 (Khushi) — off-map list re-laid as full-width Gumroad
              rows (one table per row, white card + 2px black border + colored
              left edge) instead of cramped wrap-pills, so the captain can read
              and locate each table fast. The 3-color priority logic is unchanged:
                RED    = customer calling, bill requested, OR KOT pending
                ORANGE = KOT printed, kitchen cooking (activated rounds)
                GREEN  = served / assigned / no action needed */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {offMapReservations.map(r => {
              const callOrBill = !!r.customerCallRequest || r.paymentStatus === "bill_requested";
              const preparing = (r.tabRounds || []).some(rd => rd.status === "preparing");
              const activated = (r.tabRounds || []).some(rd => rd.status === "activated");
              let state: "red" | "orange" | "green" = "green";
              if (callOrBill || preparing) state = "red";
              else if (activated) state = "orange";
              const accent = state === "red" ? "#E11900" : state === "orange" ? "#FF5733" : "#23A094";
              const allItems = (r.tabRounds || []).flatMap(rd => rd.items || []);
              const tab = allItems.length ? computeHodBreakdown(allItems).grandTotal : 0;
              let statusLabel = "";
              if (state === "red" && callOrBill) statusLabel = r.paymentStatus === "bill_requested" ? "BILL REQUESTED" : "CALLING";
              else if (state === "red") statusLabel = "KOT PENDING";
              else if (state === "orange") statusLabel = "PREPARING";
              // 🆕 2026-06-08 (Khushi) — row re-laid: customer NAME is the bold
              // primary; a clean "NO TABLE" badge (no ⚠️) sits under it (or the
              // table id when one IS set); the right side is an explicit CTA —
              // "ASSIGN TABLE" when no table yet, else "OPEN". The urgent status
              // chip (CALLING / BILL REQUESTED / KOT PENDING / PREPARING) only
              // shows when there's something to act on (green/idle hides it so it
              // never contradicts the NO TABLE badge). Priority dot + left edge +
              // flash are unchanged.
              const ctaLabel = r.tableId ? "OPEN ›" : "ASSIGN TABLE ›";
              return (
                <button key={r._docId} onClick={() => onSelectReservation(r._docId)}
                  className={state !== "green" ? "hod-flash" : undefined}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
                    background: "#fff", border: "2px solid #000", borderLeft: `6px solid ${accent}`,
                    borderRadius: 8, padding: "10px 12px", color: "#000", cursor: "pointer",
                    boxShadow: "2px 2px 0 rgba(0,0,0,0.1)",
                  }}>
                  <span style={{ width: 11, height: 11, borderRadius: "50%", background: accent, border: "1.5px solid #000", flexShrink: 0 }} />
                  <span style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0, flex: 1 }}>
                    <span style={{ fontSize: 14, fontWeight: 900, color: "#000", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {r.customerName || "Guest"}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      {r.tableId ? (
                        <span style={{ fontSize: 10, fontWeight: 900, color: "#0B6B5E", background: "#D7F2EC", border: "1.5px solid #23A094", borderRadius: 5, padding: "2px 7px", letterSpacing: 0.4, textTransform: "uppercase", whiteSpace: "nowrap" }}>
                          {proxyDisplayLabel(r.tableId || "") || r.tableId}
                        </span>
                      ) : (
                        <span style={{ fontSize: 10, fontWeight: 900, color: "#B91C1C", background: "#FFF1F0", border: "1.5px solid #E11900", borderRadius: 5, padding: "2px 7px", letterSpacing: 0.4, textTransform: "uppercase", whiteSpace: "nowrap" }}>
                          No Table
                        </span>
                      )}
                      {state !== "green" && (
                        <span style={{ fontSize: 9.5, fontWeight: 900, color: "#fff", background: accent, border: "1.5px solid #000", borderRadius: 5, padding: "2px 6px", letterSpacing: 0.4, whiteSpace: "nowrap" }}>
                          {statusLabel}
                        </span>
                      )}
                      {tab > 0 && <span style={{ fontSize: 12, fontWeight: 800, color: "#000" }}>₹{tab}</span>}
                    </span>
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 900, color: "#000", background: "#FF90E8", border: "2px solid #000", borderRadius: 7, padding: "8px 12px", letterSpacing: 0.4, textTransform: "uppercase", whiteSpace: "nowrap", flexShrink: 0, boxShadow: "2px 2px 0 rgba(0,0,0,0.18)" }}>
                    {ctaLabel}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function CaptainDashboard({ captainName }: { captainName: string }) {
  // 🆕 2026-06-25 (Khushi) — LOGOUT from Captain. Clearing the global staff
  // session makes the parent CaptainMode effect detect stillCaptain=false and
  // drop back to the login screen (it also nukes the local hod_captain_* keys).
  const { logout } = useStaff();
  // 🆕 2026-06-08 — default to the OPERATIONAL NIGHT (rolls 7AM IST), NOT the
  // UTC/calendar date. Just after midnight the calendar date is already the next
  // day while the night is still the previous date; defaulting to UTC made the
  // captain miss tables seated after midnight (they file under the operational
  // night, same as the cover/wallet). getOperationalNightStr keeps all three in sync.
  const [date, setDate] = useState(() => getOperationalNightStr());
  // 🆕 2026-06-14 v3.294 (Khushi) — PAST-NIGHT GUARD. Viewing past operational
  // nights stays allowed (reports/history), but CREATING tables, ADDING orders,
  // or PRINTING KOT on a past date is blocked — those write live activity to a
  // night that's already closed (a real source of mistaken late entries). String
  // compare is safe: both sides are YYYY-MM-DD (en-CA) from the same 7AM-rollover
  // operational-night helper. Threaded down to FloorPlanView → TableCard and the
  // walk-in / add-order modals; KOT + add-order buttons grey out, handlers hard-block.
  const isPastDate = date < getOperationalNightStr();
  // 🆕 2026-06-25 (Khushi) — limit the date picker to a ±3-day window around
  // tonight's operational night; every other future/past date is greyed out
  // (native min/max) + clamped on change (typed entry can bypass min/max).
  // Computed EACH render (NOT a mount-time useMemo) so the window shifts with
  // the 7AM-IST operational-night rollover on an always-on venue tablet — the
  // live reservation feed re-renders the dashboard continuously, keeping it fresh.
  const dateBounds = (() => {
    const base = getOperationalNightStr(); // YYYY-MM-DD
    const [y, m, d] = base.split("-").map(Number);
    const pad = (n: number) => String(n).padStart(2, "0");
    const mk = (off: number) => {
      const dt = new Date(y, m - 1, d + off);
      return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    };
    return { min: mk(-3), max: mk(3) };
  })();
  // 🆕 2026-05-20 (Khushi) — floor filter retired; the new FloorPlanView has
  // 3 floor tabs of its own. Kept as "" so existing filter logic below is a no-op.
  const floor = "";
  const [reservations, setReservations] = useState<HodTableReservation[]>([]);
  const [showWalkIn, setShowWalkIn] = useState(false);
  // 🆕 2026-05-20 (Khushi) — when captain taps a FREE table on the floor plan,
  // we open the walk-in modal with the tableId pre-selected. State drives the
  // `prefillTable` prop on <WalkInModal/>.
  const [walkInPrefill, setWalkInPrefill] = useState<string | undefined>(undefined);
  const [allTableIds, setAllTableIds] = useState<string[]>([]);
  const [allReservations, setAllReservations] = useState<HodTableReservation[]>([]);
  // 🆕 2026-05-26 v3.10 (Khushi — Fix #1 Listener Scoping).
  // FOCUS MODE = "this tablet shows ONLY its assigned floor's reservations".
  // Default OFF (zero behavior change) so the deployed code is dormant until
  // a manager flips it ON via the toggle pill above the floor tabs. State is
  // persisted in localStorage per-tablet (key: hod_captain_focus_mode) so a
  // tablet restart preserves the choice.
  //
  // 🛟 FALLBACK: if the tablet's floor isn't set (getTabletFloor()===null),
  // focus mode silently falls back to "show all" — we never accidentally hide
  // all reservations from a tablet whose floor wasn't configured yet.
  // 🆕 2026-05-26 v3.38 (Khushi: "FIX MY READ ISSUES NOW, GOING IN MILLIONS")
  // — flipped default from "off" → "on" for any tablet that has a
  // tablet_floor configured. v3.10 shipped Focus Mode as opt-in; with 930K
  // reads/hr observed at ~9pm we can't wait for captains to tap the pill
  // one by one. Now: explicit "on" or "off" in localStorage wins (so a
  // captain who DID toggle it keeps their choice). UNSET → default ON when
  // tablet floor is configured; OFF when not (fail-safe so an unconfigured
  // tablet never accidentally hides all reservations).
  const [focusMode, setFocusMode] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem("hod_captain_focus_mode");
      if (v === "on") return true;
      if (v === "off") return false;
      return !!getTabletFloor();
    } catch { return false; }
  });
  const tabletFloor = getTabletFloor();
  // 🚫 2026-06-06 (Khushi) — FOCUS MODE DISABLED. It was locking/blurring the
  // first-floor + Dining tables until a refresh. Forcing focusFloorKey to null
  // neutralises ALL focus-mode behaviour (the table lock at the floor map, the
  // auto-floor-snap, and the initial-floor pick) in one place while leaving the
  // toggle/state plumbing intact so it can be reintroduced cleanly later.
  const focusFloorKey: FloorKey | null = null;
  // (was: (focusMode && tabletFloor) ? TABLET_FLOOR_TO_FLOORKEY[tabletFloor] : null)
  void tabletFloor;
  // 🆕 2026-05-26 v3.10 (Khushi req) — Manager PIN gate on turning Focus OFF.
  // Reason: without it, a captain who finds focus mode "annoying" can quietly
  // toggle it off all night and we lose the perf win without anyone knowing.
  // Turning Focus ON is free (no PIN) — that's the safe direction.
  // 🛟 FALLBACK: PIN prompt failure (cancel / wrong PIN) → state stays ON,
  // captain sees the standard "❌ Wrong Manager PIN." alert, can retry.
  const toggleFocusMode = useCallback(async () => {
    if (focusMode) {
      const ok = await requireManagerPin("Turning OFF Focus Mode lets this tablet load all 3 floors again. This can slow the tablet on busy nights (1000+ bookings).");
      if (!ok) return;
    }
    setFocusMode((prev) => {
      const next = !prev;
      try { localStorage.setItem("hod_captain_focus_mode", next ? "on" : "off"); } catch {}
      return next;
    });
  }, [focusMode]);
  const [alertBadge, setAlertBadge] = useState({ text: "● LIVE", color: "#000", bg: "#FBF3D6" });
  const [pendingFilter, setPendingFilter] = useState<"" | "pending" | "bill" | "calling" | "ready">("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  // 🆕 2026-06-23 — multi-slot table picker: when captain taps an ASSIGNED table
  // that has >1 non-cancelled bookings for different time slots, we show a list
  // of all slots first instead of auto-opening the "winner" reservation.
  const [tableSlotPick, setTableSlotPick] = useState<{ tableId: string; slots: HodTableReservation[] } | null>(null);
  // 🆕 2026-06-12 v3.270 (Khushi) — after CREATE TABLE we want to open the new
  // table's detail/ADD-ORDER view straight away. The just-written reservation may
  // not be in the live `reservations` feed for a render or two (latency), so we
  // stash its docId here and an effect below opens it the moment it arrives.
  const [pendingOpenDocId, setPendingOpenDocId] = useState<string | null>(null);
  // Fixed wall-clock deadline set ONCE when a create requests an auto-open, so the
  // 6s give-up window can't be extended indefinitely by a busy feed re-running the
  // effect (which would risk a stale "surprise" open much later).
  const pendingOpenDeadlineRef = useRef<number>(0);
  // 🔴 2026-05-20 (Khushi) — track customerCallRequest in prev snapshot so we
  // fire a LOUD alert + badge flash + red border on the list row + dashboard
  // tile + auto-jump to that table. Without this, the red banner only shows
  // INSIDE the opened card — captain never sees it from the dashboard view.
  const prevSnapshot = useRef<Record<string, { rounds: number; status: string; calling: boolean }>>({});
  const playAlert = useAudioAlert();
  const pendingCountRef = useRef(0);
  const billCountRef = useRef(0);
  const callingCountRef = useRef(0);
  const beepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 🆕 2026-06-25 (Khushi) — ROLE-BASED SETTLEMENT (authorized side). Admins &
  // managers always qualify; a plain captain qualifies only with the per-staff
  // canSettle permission set in Boss → Staff. Only authorized captains see the
  // SETTLE BILL tab + the live "Settle Bill" button on a table card.
  const { currentStaff, hasRole } = useStaff();
  const canSettle = hasRole("admin", "manager") || !!currentStaff?.canSettle;
  const [settleTabOpen, setSettleTabOpen] = useState(false);
  // Waiting list rides the EXISTING all-floors reservation feed (zero new
  // listeners): any table a normal captain flagged via "NOTIFY SUPERVISOR".
  // Drops once the bill is settled (flag cleared) or the doc is released.
  const settleRequests = useMemo(() => {
    return (allReservations || [])
      .filter((x) => x.settleRequested && !(x.paymentStatus === "paid" && (!!x.paymentMode || !!x.paidAt)))
      .map((x) => {
        const items = (x.tabRounds || []).flatMap((rd) => rd.items || []);
        const amount = items.length ? computeHodBreakdown(items).grandTotal : 0;
        return { r: x, amount };
      })
      .sort((a, b) => (a.r.settleRequestedAt || "").localeCompare(b.r.settleRequestedAt || ""));
  }, [allReservations]);
  // BEEP on a NEW request (count rose), only for authorized captains. The
  // baseline is primed on the FIRST loaded snapshot (allReservations non-empty)
  // so a pre-existing backlog at login / date-switch / hydration NEVER beeps —
  // only genuinely new requests raised while the captain is watching.
  const prevSettleCountRef = useRef(0);
  const settleBaselineSetRef = useRef(false);
  useEffect(() => {
    const n = settleRequests.length;
    if (!settleBaselineSetRef.current) {
      if ((allReservations || []).length > 0) {
        settleBaselineSetRef.current = true;
        prevSettleCountRef.current = n;
      }
      return;
    }
    if (canSettle && n > prevSettleCountRef.current) {
      try { playAlert(true); } catch {}
    }
    prevSettleCountRef.current = n;
  }, [settleRequests.length, canSettle, playAlert, allReservations]);
  // 🔔 2026-05-20 (Khushi bug) — Calling tile must also count active waiterCalls
  // (header "Call Waiter" button), not just tableReservations.customerCallRequest.
  // The mirror to customerCallRequest can fail silently (prod rules / no
  // linkedTableRef), but the waiterCalls write always succeeds and drives the
  // red banner. Subscribing here gives the tile a second source of truth that
  // matches what the captain SEES (banner on → count ≥ 1; ACK → count drops).
  const [activeWaiterCallsList, setActiveWaiterCallsList] = useState<Array<{ id: string; tableId: string | null; floorLabel: string | null; customerName: string; coverRef: string }>>([]);
  useEffect(() => {
    const unsub = subscribeActiveWaiterCalls((calls) => {
      // Only pending = unacknowledged. Acknowledged tails (≤90s) still appear
      // in the banner but should NOT keep the tile lit — captain has handled it.
      const pending = calls.filter((c) => c.status === "pending").map((c) => ({
        id: c.id, tableId: c.tableId ?? null, floorLabel: c.floorLabel ?? null, customerName: c.customerName, coverRef: c.coverRef,
      }));
      setActiveWaiterCallsList(pending);
    });
    return () => unsub();
  }, []);
  const activeWaiterCalls = activeWaiterCallsList.length;

  // 🍳 2026-05-21 (Khushi) — Dashboard-level KDS-ready subscription. Single
  // Firestore listener powers: (a) pulsing green TILES on the floor map, and
  // (b) the global "🍽 FOOD READY" strip below the KPIs. TableCard keeps its
  // own per-reservation subscription for the in-card banner — small dupe, but
  // both work in isolation if either fails (fail-open).
  const [readyKDSAllDash, setReadyKDSAllDash] = useState<HodKDSItem[]>([]);
  useEffect(() => {
    const unsub = subscribeToReadyKDSItems(setReadyKDSAllDash);
    return () => unsub();
  }, []);
  const readyKDSResIds = useMemo(
    () => new Set(readyKDSAllDash.map((it) => it.reservationId).filter(Boolean)),
    [readyKDSAllDash]
  );
  // Group ready items by reservationId so the strip renders one row per table
  // with stacked item names. coverDocId-only items (bar walk-in) get bucketed
  // under their coverDocId so the bar's runner can see them too.
  const readyGroups = useMemo(() => {
    const m = new Map<string, { key: string; tableLabel: string; floorLabel: string; customerName: string; items: HodKDSItem[]; resId: string }>();
    readyKDSAllDash.forEach((it) => {
      const key = it.reservationId || `cover:${it.coverDocId}`;
      const g = m.get(key);
      if (g) { g.items.push(it); }
      else m.set(key, {
        key, tableLabel: it.tableLabel || it.reservationId || "—",
        floorLabel: it.floorLabel || "",
        customerName: it.customerName || "",
        items: [it], resId: it.reservationId || "",
      });
    });
    return Array.from(m.values());
  }, [readyKDSAllDash]);

  // 🆕 2026-05-21 (Khushi cost-burn fix) — REMOVED the May-16 diagnostic call
  // that fetched the ENTIRE `tableReservations` collection on every dashboard
  // mount + every date change. With 1,000+ docs × 3-4 tablets × dozens of
  // navigations per night this was burning ~4M Firestore reads/day and was the
  // root cause of the ₹1,886 May bill. The real listener below is already
  // date-filtered via `subscribeToHodReservations(date, ...)` so we lose
  // nothing by deleting the diag. The helper function `diagnoseTableReservationDates`
  // is kept in firestore-hod.ts as a manual debug tool (call it from devtools
  // if a date-mismatch bug reappears).

  useEffect(() => {
    // 🆕 2026-05-26 v3.10 — when Focus Mode is ON, use the scoped subscriber
    // so this tablet only ingests its own floor's reservations. Off-map IDs
    // still pass through (fail-open). When OFF (default), behaves identically
    // to today — zero risk to existing tablets that haven't opted in.
    const cb = (all: HodTableReservation[]) => {
      setAllTableIds(all.map(r => r.tableId));
      setAllReservations(all);

      all.forEach((r) => {
        const prev = prevSnapshot.current[r._docId];
        const curr = { rounds: (r.tabRounds || []).length, status: r.paymentStatus || "", calling: !!r.customerCallRequest };
        if (prev) {
          if (curr.rounds > prev.rounds) {
            playAlert(false);
            setAlertBadge({ text: `🛎 NEW ORDER — ${r.tableId}`, color: "#fff", bg: "#000" });
            setTimeout(() => setAlertBadge({ text: "● LIVE", color: "#000", bg: "#FBF3D6" }), 5000);
          }
          if (curr.status === "bill_requested" && prev.status !== "bill_requested") {
            // 🆕 2026-05-27 v3.69 (Khushi LIVE-NIGHT) — orphan rows (no
            // tableId) are unactionable here — captain can't open ADD ORDER
            // / PRINT BILL / RELEASE without a table, so the chime + flashing
            // red row just gives him a sound he can't silence. Skip the
            // alert for tableless rows; door girl assigns table first via
            // the floor map, then the next snapshot fires the chime as today.
            if (String(r.tableId || "").trim()) {
              playAlert(true);
              setAlertBadge({ text: `🧾 BILL REQUESTED — ${r.tableId}`, color: "#fff", bg: "#FF5733" });
              setTimeout(() => setAlertBadge({ text: "● LIVE", color: "#000", bg: "#FBF3D6" }), 5000);
            }
          }
          // 🔴 2026-05-20 (Khushi) — LOUD alert + 8-sec red top-bar flash when
          // a customer-at-table self-orders and pings captain. Fires only on
          // transition (no-call → call) so it doesn't re-beep on every snapshot.
          if (curr.calling && !prev.calling) {
            playAlert(true);
            setAlertBadge({ text: `🔔 CUSTOMER CALLING — ${r.tableId} · ${r.customerName || "Guest"}`, color: "#fff", bg: "#FF5733" });
            setTimeout(() => setAlertBadge({ text: "● LIVE", color: "#000", bg: "#FBF3D6" }), 8000);
          }
        }
        prevSnapshot.current[r._docId] = curr;
      });

      pendingCountRef.current = all.reduce((s, r) => s + (r.tabRounds || []).filter((rd) => rd.status === "preparing").length, 0);
      // 🆕 v3.69 — exclude orphan rows (no tableId). They drive an unsilenceable
      // 12s chime via the interval below and the captain has no way to clear
      // them (modal ADD ORDER / PRINT BILL / RELEASE all need a table).
      billCountRef.current = all.filter((r) => r.paymentStatus === "bill_requested" && String(r.tableId || "").trim()).length;
      callingCountRef.current = all.filter((r) => !!r.customerCallRequest).length;

      const filtered = floor ? all.filter((r) => r.floor === floor) : all;
      setReservations(filtered);
    };
    const unsub = focusFloorKey
      ? subscribeToHodReservationsScoped(date, [focusFloorKey], cb)
      : subscribeToHodReservations(date, cb);
    return () => { unsub(); prevSnapshot.current = {}; };
  }, [date, floor, playAlert, focusFloorKey]);

  // 🆕 2026-06-12 v3.270 (Khushi) — open the freshly-created table the instant it
  // appears in the live feed, so CREATE TABLE lands the captain straight on the
  // table's detail / ADD ORDER view (no search-and-tap). A 6s safety timeout
  // clears the pending state if the row never arrives (e.g. Focus Mode is pinned
  // to a different floor than the new table) so we never get stuck.
  useEffect(() => {
    if (!pendingOpenDocId) return;
    if (reservations.some((r) => r._docId === pendingOpenDocId)) {
      setSelectedDocId(pendingOpenDocId);
      setPendingOpenDocId(null);
      return;
    }
    // Deadline is fixed at create time — re-running on each feed update just
    // recomputes the REMAINING time against it, never resets the window.
    const remaining = pendingOpenDeadlineRef.current - Date.now();
    if (remaining <= 0) { setPendingOpenDocId(null); return; }
    const t = setTimeout(() => setPendingOpenDocId(null), remaining);
    return () => clearTimeout(t);
  }, [pendingOpenDocId, reservations]);

  useEffect(() => {
    if (beepIntervalRef.current) clearInterval(beepIntervalRef.current);
    beepIntervalRef.current = setInterval(() => {
      // 🔴 2026-05-20 (Khushi) — customer-calling outranks bill_due AND pending.
      // Captain must walk to that table NOW.
      if (callingCountRef.current > 0) playAlert(true);
      else if (billCountRef.current > 0) playAlert(true);
      else if (pendingCountRef.current > 0) playAlert(false);
    }, 12000);
    return () => { if (beepIntervalRef.current) clearInterval(beepIntervalRef.current); };
  }, [playAlert]);

  // 🆕 2026-05-28 v3.138 — TABLE-QR walk-in call requests (see firestore-hod.ts).
  // Pending list (scoped to tonight, status==pending). Chime on NEW row arrival
  // via prev-id-set diff — same pattern as the customerCallRequest detector
  // above but for the standalone tableCallRequests collection. Banner UI is
  // rendered as a fixed-position overlay below — zero impact on floor plan.
  // 🛟 FAIL-OPEN: subscribe → [] on error; chime guarded by try/catch.
  const [tableCallRequests, setTableCallRequests] = useState<HodTableCallRequest[]>([]);
  // 🆕 v3.139 (Khushi 28-May) — TABLE QR moved from floating banner to a
  // dedicated TAB above the floor selector. Tab pulses red when pending > 0.
  // Click → fullscreen modal with the same row + ACKNOWLEDGE UI we already had.
  const [showTableQrModal, setShowTableQrModal] = useState(false);
  // 🆕 2026-06-07 (Khushi) — LIVE REPORTS modal toggle (Captain parity).
  const [reportsOpen, setReportsOpen] = useState(false);
  // 🆕 2026-06-12 v3.266 (Khushi) — TABLE TRANSACTIONS panel (mirror of Bar
  // Mode's RECENT TRANSACTIONS, but for tables). Collapsible; reuses the
  // already-subscribed allReservations feed → ZERO extra Firestore reads.
  const [txOpen, setTxOpen] = useState(false);
  const [txFull, setTxFull] = useState(false);
  const [txExpanded, setTxExpanded] = useState<Record<string, boolean>>({});
  // 🆕 2026-06-12 v3.268 (Khushi) — OPEN / CLEARED tables filter for the panel.
  const [txFilter, setTxFilter] = useState<"all" | "open" | "cleared">("all");
  const prevTableCallIdsRef = useRef<Set<string>>(new Set());
  // 🔴 Architect-fix: separate "hydrated" flag from "prev set size". If the
  // initial snapshot is empty (no pending calls at mount), the OLD `size>0`
  // gate would silently swallow the FIRST real incoming request — captain
  // never chimes for it. Use an explicit hydrated flag so the first new row
  // after the initial snapshot ALWAYS chimes, regardless of prior size.
  const hasHydratedTableCallsRef = useRef(false);
  useEffect(() => {
    const unsub = subscribeTableCallRequests((rows) => {
      const nextIds = new Set(rows.map((r) => r.id));
      const fresh = rows.filter((r) => !prevTableCallIdsRef.current.has(r.id));
      if (hasHydratedTableCallsRef.current && fresh.length > 0) {
        try { playAlert(true); } catch {}
        const f = fresh[0];
        const label = f.type === "place_order" ? `📋 NEW ORDER · ${f.tableId}` : `🛎 CALL WAITER · ${f.tableId}`;
        setAlertBadge({ text: `${label} · ${f.customerName || "Guest"}`, color: "#fff", bg: "#FF5733" });
        setTimeout(() => setAlertBadge({ text: "● LIVE", color: "#000", bg: "#FBF3D6" }), 8000);
      }
      hasHydratedTableCallsRef.current = true;
      prevTableCallIdsRef.current = nextIds;
      // Sort: place_order first, then oldest-first so captain works the queue FIFO.
      const sorted = [...rows].sort((a, b) => {
        if (a.type !== b.type) return a.type === "place_order" ? -1 : 1;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
      setTableCallRequests(sorted);
    });
    return () => { unsub(); prevTableCallIdsRef.current = new Set(); hasHydratedTableCallsRef.current = false; };
  }, [playAlert]);

  const pending = reservations.reduce((s, r) => s + (r.tabRounds || []).filter((rd) => rd.status === "preparing").length, 0);
  // 🆕 v3.74 — KEEP all bill_requested rows in the KPI counter (including
  // those without a tableId — e.g. HODTAB customer just hit "GET BILL" but
  // door hasn't assigned a physical table yet). Khushi 7:33am: v3.69's
  // tableId filter was suppressing the count too aggressively → captain saw
  // "Bill Due 0" while the customer's wallet-funded bill_requested write
  // was waiting in Firestore. Captain still needs to SEE the number so he
  // knows to walk over (or call door girl to assign the table). The chime
  // + row pulse gates above stay filtered (no unsilenceable beep for
  // tableless rows) — visual only on the KPI tile.
  const billDue = reservations.filter((r) => r.paymentStatus === "bill_requested").length;
  // 🔔 Combine both signals so the tile matches the banner. customerCallRequest
  // = "AT MY TABLE" pings (linked tables only). activeWaiterCalls = header
  // Call Waiter button (every cover). Sum is an UPPER BOUND — a single header
  // tap can write BOTH (mirror + waiterCalls.add), so one real-world call may
  // show as 2 on the tile. Acceptable: still tells captain "walk over now".
  // Clearing: banner ACK drops the waiterCalls contribution; ✓ ON IT on the
  // table card drops customerCallRequest. Tile hits 0 only when BOTH are clear.
  const calling = reservations.filter((r) => !!r.customerCallRequest).length + activeWaiterCalls;

  // 🔔 2026-05-20 (Khushi) — Calling filter must match what's drawn the tile.
  // The tile counts customerCallRequest tables + pending waiterCalls. So the
  // filtered list must also include reservations whose tableId matches an
  // active waiterCall (case-insensitive, since hodclub.in may write "fd10"
  // while POS stores "FD10"). Unmatched waiterCalls (e.g. bar walk-in with no
  // table, or a typo) get surfaced in a separate "orphan calls" strip above
  // the list — handled below in render via `orphanWaiterCalls`.
  const waiterCallTableIds = useMemo(
    () => new Set(activeWaiterCallsList.map((c) => (c.tableId || "").toLowerCase()).filter(Boolean)),
    [activeWaiterCallsList]
  );
  const displayedReservations = useMemo(() => {
    let list = reservations;
    if (pendingFilter === "pending") list = list.filter(r => (r.tabRounds || []).some(rd => rd.status === "preparing"));
    else if (pendingFilter === "bill") list = list.filter(r => r.paymentStatus === "bill_requested");
    else if (pendingFilter === "calling") {
      list = list.filter(r => !!r.customerCallRequest || waiterCallTableIds.has((r.tableId || "").toLowerCase()));
    }
    else if (pendingFilter === "ready") list = list.filter(r => readyKDSResIds.has(r._docId));
    // 🔴 2026-05-20 (Khushi) — always sort customer-calling tables to the TOP
    // of the list regardless of filter, so a ping is impossible to miss even
    // if dozens of tables are open. Stable sort preserves prior order otherwise.
    list = [...list].sort((a, b) => Number(!!b.customerCallRequest) - Number(!!a.customerCallRequest));
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
  }, [reservations, pendingFilter, customerSearch, waiterCallTableIds, readyKDSResIds]);

  // 🆕 2026-06-25 (Khushi) — SEARCH RESULTS dropdown. Typing a guest name (or
  // phone / table / ref) surfaces matching bookings ACROSS ALL FLOORS as a
  // tappable list — each row shows the guest, table + floor, ref, and arrival
  // time/date. Tapping a row opens that exact booking's detail (works whether
  // it sits on Ground/Dance, Dining, or Rooftop). Rides the already-subscribed
  // `reservations` feed — ZERO extra Firestore reads. Cancelled rows excluded.
  const searchMatches = useMemo(() => {
    const q = customerSearch.trim().toLowerCase();
    if (!q) return [] as HodTableReservation[];
    return reservations
      .filter((r) => (r as any).status !== "cancelled")
      .filter((r) =>
        [r.customerName, r.phone, r.tableId, r.bookingRef, (r as any).linkedCoverRef]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q)
      )
      .slice(0, 25);
  }, [reservations, customerSearch]);

  // 🆕 2026-06-12 v3.266 (Khushi) — CAPTAIN · TABLE TRANSACTIONS data shaping.
  // Mirrors Bar Mode's RECENT TRANSACTIONS but for TABLE bookings. Reuses the
  // ALREADY-subscribed `allReservations` feed (the floor-map data) → ZERO extra
  // Firestore reads (no new listener, unlike Bar's gated covers feed). Scope =
  // the operational night: allReservations is filtered by `date`, which defaults
  // to getOperationalNightStr() (rolls 7 AM IST). In FOCUS mode the tablet is
  // pinned to one floor, so the list reflects that floor's tables.
  //
  // A table bill is settled ONCE over ALL its items (single discount %, single
  // SC, single GST round) — exactly what computeHodBreakdownAdjusted models.
  // (Bar had to go per-round because each bar round is charged separately.)
  //
  // MONEY TRUTH (architect-fix): for a PAID table the breakdown is driven by the
  // PERSISTED settlement fields written at markTablePaid (amountPaid,
  // discountAmount, serviceChargeAmount, taxAmount, serviceChargeApplied) — so a
  // manager-PIN SC waiver / override is honoured and the panel matches the
  // printed/paid bill to the rupee. We compute from items ONLY as a fallback
  // when those fields are absent. For an UNSETTLED table we show the computed
  // standard-rate "EST. BILL" (clearly labelled — it's an estimate, not money
  // collected). An `override` flag is set when the standard computed total ≠
  // amountPaid (SC waiver / manual adjustment) so the row can flag it and the
  // owner never misreads it as a discrepancy. Display/EXPORT ONLY — no writes.
  const _txTime = (ms: number) =>
    ms ? new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true }) : "—";
  const txRows = allReservations
    .map((r) => {
      const rounds = r.tabRounds || [];
      const allItems = rounds.flatMap((rd) => rd.items || []);
      const discPct = r.discountPercent || 0;
      const isPaid = r.paymentStatus === "paid";
      const amountPaid = r.amountPaid || 0;
      const walletPaid = r.walletPaidAmount || 0;
      // Standard-rate computed bill (SC on) — used for unsettled tables and as
      // the override-detector baseline for settled ones.
      const std = computeHodBreakdownAdjusted(allItems, discPct, true);
      let billed: number, subtotal: number, discount: number, serviceCharge: number, tax: number, estimated: boolean, override: boolean;
      if (isPaid) {
        billed = amountPaid;
        estimated = false;
        // Override = the actual money collected ≠ standard-rate bill (SC waiver /
        // manual adjustment captured at settlement).
        override = Math.round(std.grandTotal) !== Math.round(amountPaid);
        const scAmt = r.serviceChargeAmount;
        const taxAmt = r.taxAmount;
        const discAmt = r.discountAmount;
        if (scAmt !== undefined && taxAmt !== undefined) {
          // Persisted truth — reconciles: subtotal − discount + SC + GST = paid.
          serviceCharge = scAmt;
          tax = taxAmt;
          discount = discAmt !== undefined ? discAmt : Math.max(0, std.discount);
          subtotal = amountPaid - scAmt - taxAmt + discount;
        } else {
          // Fallback: honour a stored SC-waiver flag if present, else standard.
          const scOn = r.serviceChargeApplied !== false;
          const bd = scOn ? std : computeHodBreakdownAdjusted(allItems, discPct, false);
          subtotal = bd.subtotal; discount = bd.discount; serviceCharge = bd.serviceCharge; tax = bd.gst;
        }
      } else {
        // Unsettled — estimated current bill at the standard rate.
        billed = std.grandTotal;
        subtotal = std.subtotal; discount = std.discount; serviceCharge = std.serviceCharge; tax = std.gst;
        estimated = true;
        override = false;
      }
      // 🆕 2026-06-12 v3.267 (Khushi) — flag an IN-HOUSE discount applied to an
      // AGGREGATOR booking (unusual; aggregator bills normally print full price).
      // discount>0 on an aggregator table = a house ₹-off was applied (e.g. FD7
      // SWIGGY, settled by card with −10%). Normal aggregator bookings carry no
      // in-house discount, so discount is 0 and this stays false.
      const _aggNm = (r.aggregator || r.source || "inhouse").toLowerCase();
      const _isAggBooking = /swiggy|zomato|eazydiner|eazydinner|payeazy/.test(_aggNm);
      const inhouseDiscOnAgg = _isAggBooking && (discount > 0 || ((r.discountPercent || 0) > 0 && !!r.discountModifiedByCaptain) || (r.paymentStatus === "paid" && (r.discountAmount || 0) > 0));
      let ms = 0;
      const bump = (iso?: string) => { if (iso) { const t = new Date(iso).getTime(); if (!isNaN(t) && t > ms) ms = t; } };
      bump(r.bookedAt); bump(r.actualArrivalTime); bump(r.paidAt); bump(r.advancePaidAt); bump(r.lastBillPrintedAt); bump(r.billFirstPrintedAt);
      rounds.forEach((rd) => { bump(rd.placedAt); bump(rd.activatedAt); });
      // 🆕 2026-06-12 v3.268 (Khushi) — discount % for the breakdown label
      // ("Discount (10%) −₹104"). Derived from the ₹ discount vs the pre-discount
      // subtotal so it is correct regardless of source (captain or aggregator).
      const discountPct = subtotal > 0 && discount > 0 ? Math.round((discount / subtotal) * 100) : 0;
      return {
        r, rounds, allItems, billed, subtotal, discount, discountPct, serviceCharge, tax,
        isPaid, amountPaid, walletPaid, estimated, override, inhouseDiscOnAgg,
        status: r.paymentStatus || "open", ms,
      };
    })
    // Only tables that actually transacted (≥1 round = food/drink ordered). A
    // bare reservation with no orders is not a "transaction".
    .filter((row) => row.rounds.length > 0 || row.billed > 0)
    .sort((a, b) => b.ms - a.ms);
  // 🆕 2026-06-12 v3.268 (Khushi) — OPEN = unsettled tables; CLEARED = settled
  // (paid) tables. When a specific filter is chosen we show ALL of them (no
  // 10-row cap) so "OPEN TABLES" / "CLEARED TABLES" is a complete list.
  const txOpenCount = txRows.filter((r) => !r.isPaid).length;
  const txClearedCount = txRows.filter((r) => r.isPaid).length;
  const txFiltered =
    txFilter === "open" ? txRows.filter((r) => !r.isPaid)
    : txFilter === "cleared" ? txRows.filter((r) => r.isPaid)
    : txRows;
  const txShown = (txFull || txFilter !== "all") ? txFiltered : txFiltered.slice(0, 10);
  const _txStatusPill = (status: string, mode?: string) => {
    if (status === "paid") return { label: mode ? `✅ PAID · ${mode.toUpperCase()}` : "✅ PAID", bg: "#23A094", fg: "#fff" };
    if (status === "bill_requested") return { label: "🧾 BILL REQUESTED", bg: "#FF5733", fg: "#fff" };
    return { label: "🟡 OPEN", bg: "#F2C744", fg: "#000" };
  };
  const downloadTxCsv = () => {
    const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const night = getOperationalNightStr();
    const L: string[] = [];
    L.push(`HOD Table Transactions,${esc(night)}`);
    L.push("");
    L.push(["Date & Time", "Table", "Floor", "Customer", "Phone", "Ref", "Subtotal Rs", "Discount Rs", "Service Charge Rs", "GST Tax Rs", "Bill Total Rs", "Amount Paid Rs", "Wallet Redeemed Rs", "Payment Mode", "Status", "Items Ordered"].join(","));
    for (const row of txRows) {
      const r = row.r;
      const items = row.rounds.flatMap((rd) => (rd.items || []).map((it) => `${it.qty}x ${it.n}`)).join("; ");
      L.push([
        _txTime(row.ms), r.tableId || "", r.floorLabel || r.floor || "", r.customerName || "", r.phone || "", r.bookingRef || "",
        Math.round(row.subtotal), Math.round(row.discount), Math.round(row.serviceCharge), Math.round(row.tax), Math.round(row.billed),
        row.isPaid ? Math.round(row.amountPaid) : "", Math.round(row.walletPaid), r.paymentMode || "",
        row.estimated ? `${row.status} (estimated)` : row.override ? `${row.status} (SC waiver/adjusted)` : row.status, items,
      ].map(esc).join(","));
    }
    const blob = new Blob(["\uFEFF" + L.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `HOD_TableTransactions_${night}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="captain-v2" style={{ minHeight: "100vh", background: "#F4F4F0", color: "#000", fontFamily: "'Manrope','Space Grotesk',sans-serif" }}>
      <WaiterCallBanner staffName={captainName} role="captain" />
      {/* 🆕 v3.139 (Khushi 28-May) — TABLE QR fullscreen modal. Opens from the
          pulsing TABLE QR pill below the floor tabs. Same row + ACKNOWLEDGE
          design as the previous floating banner — just bigger and accessed
          on-demand via the tab pill so it doesn't permanently eat real estate.
          Captain still gets the chime + 8s alert badge on new rows. */}
      {/* 🆕 2026-06-07 (Khushi) — CAPTAIN LIVE REPORTS (fullscreen modal).
          Renders the same Boss-mode LiveReports component (table activity by
          floor) so the captain sees identical, architect-passed numbers. The
          component mounts here only while open → its Firestore subscriptions
          run only while the modal is open (cost-safe). */}
      {reportsOpen && (
        <div style={{ position: "fixed", inset: 0, background: "#F4F4F0", zIndex: 100010, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
          <div style={{ position: "sticky", top: 0, zIndex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "12px 16px", background: "#fff", borderBottom: "2px solid #000" }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: "#000", letterSpacing: 0.4, fontFamily: "'Space Grotesk',sans-serif" }}>🪩 CAPTAIN · LIVE REPORTS</div>
            <button onClick={() => setReportsOpen(false)}
              style={{ flexShrink: 0, width: 40, height: 40, borderRadius: 10, background: "#000", border: "2px solid #000", color: "#fff", fontSize: 22, fontWeight: 900, cursor: "pointer", lineHeight: 1 }}>×</button>
          </div>
          <div style={{ padding: 16 }}>
            <LiveReports />
          </div>
        </div>
      )}
      {showTableQrModal && (
        <div onClick={closeOnBackdrop(() => setShowTableQrModal(false))} style={{
          position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,.55)",
          display: "flex", alignItems: "flex-start", justifyContent: "center",
          padding: "60px 12px 24px", overflowY: "auto",
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            width: "100%", maxWidth: 560,
            background: "#F4F4F0",
            border: "2px solid #FF5733", borderRadius: 16,
            boxShadow: "none",
          }}>
            <div style={{
              padding: "14px 18px", background: "linear-gradient(90deg,#FF5733,#FF5733,#FF5733)",
              color: "#fff", fontSize: 15, fontWeight: 900, letterSpacing: 1.2,
              textTransform: "uppercase", borderTopLeftRadius: 14, borderTopRightRadius: 14,
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <span>🛎 TABLE QR · {tableCallRequests.length} PENDING</span>
              <button onClick={() => setShowTableQrModal(false)} style={{
                background: "#fff", border: "1px solid #000",
                color: "#000", borderRadius: 8, padding: "5px 12px",
                fontSize: 11, fontWeight: 900, letterSpacing: 0.6, cursor: "pointer",
              }}>✕ CLOSE</button>
            </div>
            <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, maxHeight: "78vh", overflowY: "auto" }}>
              {tableCallRequests.length === 0 ? (
                <div style={{ padding: "40px 16px", textAlign: "center", color: "#6B6B6B", fontSize: 13, fontWeight: 700 }}>
                  No pending table-QR requests right now.
                </div>
              ) : tableCallRequests.map((r) => {
                const mins = Math.max(0, Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 60000));
                const isOrder = r.type === "place_order";
                const itemSummary = (r.items || []).map((i) => `${i.name}×${i.qty}`).join(" · ");
                const total = (r.items || []).reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);
                return (
                  <div key={r.id} style={{
                    background: "#fff", border: `1.5px solid ${isOrder ? "#F2C744" : "#FF5733"}`,
                    borderRadius: 10, padding: "12px 14px",
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <div style={{ fontSize: 13, fontWeight: 900, color: isOrder ? "#000" : "#FF5733", letterSpacing: 0.6 }}>
                        {isOrder ? "📋 NEW ORDER" : "🛎 CALL WAITER"} · {r.tableId}
                      </div>
                      <div style={{ fontSize: 10, color: "#6B6B6B", fontWeight: 700 }}>
                        {mins === 0 ? "JUST NOW" : `${mins}m ago`}
                      </div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: "#000", marginBottom: 2 }}>
                      {r.customerName || "Guest"} · {r.customerPhone || "—"}
                    </div>
                    {r.customerEmail && (
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6B6B", marginBottom: 4 }}>
                        {r.customerEmail}
                      </div>
                    )}
                    {isOrder && itemSummary && (
                      <div style={{ fontSize: 12, color: "#6B6B6B", lineHeight: 1.5, marginBottom: 8, wordBreak: "break-word" }}>
                        {itemSummary}{total > 0 ? ` · ₹${total.toLocaleString("en-IN")}` : ""}
                      </div>
                    )}
                    <button
                      onClick={() => acknowledgeTableCallRequest(r.id, captainName)}
                      style={{
                        width: "100%", padding: "10px 12px", marginTop: 4,
                        background: "#F2C744", color: "#000", border: "none", borderRadius: 8,
                        fontSize: 13, fontWeight: 900, letterSpacing: 0.8, textTransform: "uppercase",
                        cursor: "pointer", fontFamily: "'Space Grotesk',sans-serif",
                      }}
                    >✓ ACKNOWLEDGE · ON IT</button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      <div style={{ background: "#fff", borderBottom: "1px solid #000", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 10, gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Link href="/"
            style={{ padding: "8px 12px", borderRadius: 10, background: "#FF90E8", border: "1.5px solid #000", color: "#000", fontSize: 14, fontWeight: 900, cursor: "pointer", textDecoration: "none", whiteSpace: "nowrap", letterSpacing: .3 }}>
            ← POS
          </Link>
          <div style={{ fontFamily: "'Manrope','Space Grotesk',sans-serif", fontSize: 18, fontWeight: 900, color: "#000", letterSpacing: 0.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🪩 CAPTAIN</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <div style={{ fontSize: 13, color: "#6B6B6B" }}>👤 {captainName}</div>
          <div style={{ fontSize: 13, background: alertBadge.bg, border: `1px solid ${alertBadge.color}40`, color: alertBadge.color, padding: "4px 10px", borderRadius: 20 }}>{alertBadge.text}</div>
          {/* 🆕 2026-06-25 (Khushi) — LOGOUT button (was missing on Captain). */}
          <button onClick={() => logout()}
            title="Log out of Captain Mode"
            style={{ padding: "6px 12px", borderRadius: 10, background: "#fff", border: "1.5px solid #000", color: "#000", fontSize: 13, fontWeight: 900, cursor: "pointer", whiteSpace: "nowrap", letterSpacing: .3, boxShadow: "2px 2px 0px #000" }}>
            ⎋ LOGOUT
          </button>
        </div>
      </div>

      <div style={{ padding: "10px 16px", background: "#fff", borderBottom: "2px solid #000", display: "flex", gap: 8, alignItems: "center" }}>
        <input type="date" value={date} min={dateBounds.min} max={dateBounds.max}
          onChange={(e) => {
            let v = e.target.value;
            if (v) { if (v < dateBounds.min) v = dateBounds.min; else if (v > dateBounds.max) v = dateBounds.max; }
            setDate(v);
          }}
          style={{ flex: 1, minWidth: 0, boxSizing: "border-box", background: "#fff", border: "1px solid #000", borderRadius: 8, padding: "8px 12px", color: "#000", fontSize: 14, outline: "none" }} />
        {/* 🆕 2026-06-07 (Khushi) — LIVE REPORTS button (parity with Bar / Door). */}
        <button onClick={() => setReportsOpen(true)}
          title="Live Reports — tonight's table numbers by floor"
          style={{ flexShrink: 0, padding: "8px 14px", borderRadius: 8, background: "#000", border: "1px solid #000", color: "#fff", fontSize: 13, fontWeight: 900, letterSpacing: 0.5, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "'Space Grotesk',sans-serif" }}>
          📊 LIVE REPORTS
        </button>
      </div>

      {/* 🆕 2026-06-14 v3.294 (Khushi) — PAST-NIGHT banner. Makes it obvious why
          create/add-order/print-KOT are disabled when an older date is selected. */}
      {isPastDate && (
        <div style={{ margin: "0 16px 10px", padding: "10px 14px", background: "#FFF3CD", border: "2px solid #000", borderRadius: 10, color: "#000", fontSize: 13, fontWeight: 800, letterSpacing: 0.3 }}>
          ⏪ VIEWING A PAST NIGHT — creating tables, adding orders & printing KOT are disabled. Switch to tonight to make changes.
        </div>
      )}

      {/* 🍳 2026-05-21 (Khushi) — KPI tiles bumped from 4 → 5 to add FOOD READY
          tab next to BILL DUE. Tap it to filter the floor map + list down to
          tables with bumped-but-not-picked-up food. Tile auto-pulses green
          (custom class — distinct from calling's red pulse-red). */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${canSettle ? 7 : 6},1fr)`, gap: 6, padding: "10px 16px" }}>
        {/* 🆕 2026-06-03 v3.207 (Khushi) — KPI tiles are WHITE by default; the
            color only fills in when a tile is SELECTED (active filter). Selected
            colors: Calling + Bill Due → RED (no purple/blue), Tables pink,
            Pending yellow, Food Ready green. Active tile = its color + 3px frame
            + slight scale. Alert pulse glow (pulse-red/hod-tile-ready) stays. */}
        {[
          { label: "Tables", value: reservations.length, filter: "" as const, tint: "#FF90E8", fg: "#000", kind: "default" as const, pulse: false },
          { label: "Calling", value: calling, filter: "calling" as const, tint: "#FF5733", fg: "#fff", kind: "red" as const, pulse: calling > 0 },
          { label: "Pending", value: pending, filter: "pending" as const, tint: "#F2C744", fg: "#000", kind: "default" as const, pulse: pending > 0 },
          { label: "Bill Due", value: billDue, filter: "bill" as const, tint: "#FF5733", fg: "#fff", kind: "default" as const, pulse: billDue > 0 },
          ...(canSettle ? [{ label: "Settle Bill", value: settleRequests.length, filter: "__settle__" as const, tint: "#FF5733", fg: "#fff", kind: "settle" as const, pulse: settleRequests.length > 0 }] : []),
          { label: "Food Ready", value: readyGroups.length, filter: "ready" as const, tint: "#23A094", fg: "#fff", kind: "green" as const, pulse: readyGroups.length > 0 },
        ].map((s) => {
          // 🆕 2026-06-15 v3.301 (Khushi) — (1) the TABLES tile (the "show all"
          // default, filter="") now highlights pink whenever no other filter is
          // active, so the selected tab is always visible. (2) BILL DUE + PENDING
          // now BLINK red (pulse-red) whenever their count > 0, matching CALLING —
          // so an open bill or a preparing order is impossible to miss.
          // 🆕 2026-06-25 (Khushi) — the SETTLE BILL tile must be a FILLED red
          // that BLINKS (not a faint shadow glow) whenever a request is waiting,
          // so it's impossible to miss. pulse-red-fill animates the background +
          // forces white text below; other tiles keep the shadow-glow pulse.
          const settleBlinking = s.kind === "settle" && s.pulse;
          // 🆕 2026-06-26 (Khushi) — the FOOD READY tile must PREFILL green the
          // instant the kitchen bumps an item (count > 0), not just glow while
          // staying white. Mirrors the settle tile's filled-red behavior so a
          // waiting dish is impossible to miss without tapping the tile first.
          const greenReady = s.kind === "green" && s.pulse;
          // 🆕 2026-06-26 (Khushi) — the PENDING tile must PREFILL gold the instant a
          // round is preparing (count > 0), not just glow red while staying white.
          // Mirrors the settle/food-ready filled behavior so a preparing order is
          // impossible to miss. pulse-gold-fill animates the gold background + keeps
          // the black tile text readable.
          const pendingFill = s.filter === "pending" && s.pulse;
          const pulseClass = s.pulse ? (s.kind === "green" ? "hod-tile-ready" : settleBlinking ? "pulse-red-fill" : pendingFill ? "pulse-gold-fill" : "pulse-red") : "";
          const isActive = s.kind === "settle" ? settleTabOpen : pendingFilter === s.filter;
          // 🆕 2026-06-25 (Khushi) — the SETTLE tile turns alarm-RED (+ pulse) ONLY
          // when a bill is actually waiting (settleBlinking). Merely OPENING the
          // empty settle tab no longer paints it red — it shows a neutral pink
          // "selected" fill so an empty list never looks like a pending alarm.
          const settleEmptyActive = s.kind === "settle" && isActive && !s.pulse;
          const filled = isActive || settleBlinking || greenReady || pendingFill;
          const tileBg = !filled ? "#fff" : settleEmptyActive ? "#FFD6EF" : s.tint;
          const tileFg = !filled ? "#000" : settleEmptyActive ? "#000" : s.fg;
          return (
            <div key={s.label} onClick={() => { if (s.kind === "settle") { setPendingFilter(""); setSettleTabOpen(o => !o); return; } setSettleTabOpen(false); setPendingFilter(prev => prev === s.filter ? "" : (s.filter as typeof prev)); }}
              className={pulseClass}
              style={{ background: tileBg, border: `${isActive ? 3 : 2}px solid #000`, borderRadius: 10, padding: 10, textAlign: "center", cursor: "pointer", transition: "all .2s", transform: isActive ? "scale(1.03)" : "none" }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: tileFg }}>{s.value}</div>
              <div style={{ fontSize: 10, color: tileFg, marginTop: 2, fontWeight: 800, letterSpacing: .5 }}>
                {s.kind === "red" && "🔔 "}{s.kind === "green" && "🍽 "}{s.kind === "settle" && "💰 "}{s.label}
              </div>
            </div>
          );
        })}
        {/* 🆕 2026-06-03 v3.204 (Khushi) — TABLE QR moved from the full-width
            pill above the floor map into a horizontal tile right next to FOOD
            READY. Tap → opens the same fullscreen table-QR call modal. Pulses
            red with a count when any call_waiter/place_order row is pending. */}
        {(() => {
          const qrCount = tableCallRequests.length;
          const qrActive = qrCount > 0;
          return (
            <div onClick={() => { setSettleTabOpen(false); setPendingFilter(""); setShowTableQrModal(true); }}
              className={qrActive ? "pulse-red" : ""}
              style={{ background: qrActive ? "#FF5733" : "#fff", border: "2px solid #000", borderRadius: 10, padding: 10, textAlign: "center", cursor: "pointer", transition: "all .2s" }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: qrActive ? "#fff" : "#000" }}>{qrCount}</div>
              <div style={{ fontSize: 10, color: qrActive ? "#fff" : "#000", marginTop: 2, fontWeight: 800, letterSpacing: .5 }}>
                🛎 Table QR
              </div>
            </div>
          );
        })()}
      </div>
      {/* 🆕 2026-06-25 (Khushi) — SETTLE list, opened by the square 💰 Settle KPI
          tile above (next to Bill Due). Visible ONLY to authorized captains
          (canSettle / admin / manager). The tile blinks red + BEEPs (effect above)
          whenever a normal captain has flagged a table "NOTIFY SUPERVISOR TO SETTLE
          BILL". Lists waiting tables across ALL floors; tapping a row opens that
          table's card to settle + release, which clears the flag. Rides the
          existing all-floors reservation feed → ZERO new listeners. */}
      {canSettle && settleTabOpen && (
        <div style={{ padding: "0 16px 4px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {settleRequests.length === 0 ? (
              <div style={{ padding: "16px", textAlign: "center", color: "#6B6B6B", fontSize: 13, fontWeight: 700, background: "#fff", border: "2px solid #000", borderRadius: 10 }}>
                No tables are waiting to be settled.
              </div>
            ) : settleRequests.map(({ r: req, amount }) => {
              const mins = req.settleRequestedAt
                ? Math.max(0, Math.floor((Date.now() - new Date(req.settleRequestedAt).getTime()) / 60000))
                : null;
              const floorTxt = req.settleRequestFloor || req.floorLabel || req.floor || "";
              return (
                <button key={req._docId}
                  onClick={() => { setSettleTabOpen(false); setSelectedDocId(req._docId); }}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                    width: "100%", textAlign: "left", padding: "12px 14px", borderRadius: 10,
                    background: "#fff", border: "2px solid #FF5733", cursor: "pointer",
                  }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 900, color: "#000", letterSpacing: 0.3 }}>
                      🪑 {req.tableId}{floorTxt ? ` · ${floorTxt}` : ""}{req.customerName ? ` · ${req.customerName}` : ""}
                    </div>
                    <div style={{ fontSize: 11, color: "#6B6B6B", fontWeight: 700, marginTop: 2 }}>
                      Requested by {req.settleRequestedBy || "captain"}{mins === null ? "" : mins === 0 ? " · just now" : ` · ${mins}m ago`}
                    </div>
                  </div>
                  <div style={{ flexShrink: 0, textAlign: "right" }}>
                    <div style={{ fontSize: 16, fontWeight: 900, color: "#FF5733", fontVariantNumeric: "tabular-nums" }}>₹{amount.toLocaleString("en-IN")}</div>
                    <div style={{ fontSize: 11, fontWeight: 900, color: "#23A094", letterSpacing: 0.5 }}>SETTLE ›</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {pendingFilter && (
        <div style={{ padding: "0 16px", marginBottom: 4 }}>
          <button onClick={() => setPendingFilter("")}
            style={{ fontSize: 13, color: "#000", background: "#FBF3D6", border: "1px solid #000", borderRadius: 8, padding: "4px 12px", cursor: "pointer" }}>
            Showing {pendingFilter === "pending" ? "Pending" : pendingFilter === "calling" ? "🔔 Customer Calling" : pendingFilter === "ready" ? "🍽 Food Ready" : "Bill Due"} only — tap to clear ✕
          </button>
        </div>
      )}

      {/* 🆕 2026-05-26 v3.8 (Khushi BUG) — When PENDING filter is on, explicitly
          list EVERY reservation with a preparing round so an off-map walk-in
          (Proxy-N, typo, legacy aggregator import) or a hidden-floor table is
          never invisible. Tap a chip to open the booking modal. Mirrors the
          orphan-calls strip for the Calling filter above. */}
      {pendingFilter === "pending" && (() => {
        const pendingRes = reservations.filter(r => (r.tabRounds || []).some(rd => rd.status === "preparing"));
        const mapIds = new Set<string>();
        (Object.keys(HOD_TABLES) as FloorKey[]).forEach(fk =>
          HOD_TABLES[fk].tables.forEach(t => mapIds.add(t.id.toUpperCase())));
        if (pendingRes.length === 0) {
          return (
            <div style={{ padding: "0 16px", marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: "#6B6B6B", padding: "8px 12px", background: "#fff", border: "1px dashed #6B6B6B", borderRadius: 8 }}>
                No tables with preparing rounds found.
              </div>
            </div>
          );
        }
        return (
          <div style={{ padding: "0 16px", marginBottom: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {pendingRes.map((r) => {
              const tid = (r.tableId || "—").toUpperCase();
              const pcount = (r.tabRounds || []).filter(rd => rd.status === "preparing").length;
              const onMap = mapIds.has(tid);
              return (
                <button key={r._docId} onClick={() => setSelectedDocId(r._docId)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: 10,
                    background: "#FFF0EC", border: `1.5px solid ${onMap ? "#FF5733" : "#F59E0B"}`,
                    color: "#000", fontWeight: 800, fontSize: 13, cursor: "pointer" }}>
                  🔴 {tid}{!onMap && " ⚠ off-map"} · {pcount} KOT{pcount > 1 ? "s" : ""} pending
                </button>
              );
            })}
          </div>
        );
      })()}

      {/* 🔔 2026-05-20 (Khushi) — surface waiterCalls that don't map to any
          open reservation today (bar walk-in / closed table / typo / different
          date). Without this, the Calling tile would show "1" but the list
          would say "No matching tables". The strip mirrors the top banner so
          captain can ACK from here too. Only shown when Calling filter is on. */}
      {pendingFilter === "calling" && (() => {
        const reservedIds = new Set(reservations.map((r) => (r.tableId || "").toLowerCase()));
        const orphans = activeWaiterCallsList.filter((c) => {
          const tid = (c.tableId || "").toLowerCase();
          return !tid || !reservedIds.has(tid);
        });
        if (orphans.length === 0) return null;
        return (
          <div style={{ padding: "0 16px", marginBottom: 8 }}>
            {orphans.map((c) => (
              <div key={c.id}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                  background: "#FFF0EC", border: "1.5px solid #FF5733", borderRadius: 10,
                  padding: "10px 12px", marginBottom: 6 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 900, color: "#000", letterSpacing: 0.4 }}>
                    🛎 CALL · {c.customerName || "Guest"}
                  </div>
                  <div style={{ fontSize: 11, color: "#6B6B6B", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.tableId ? `Table ${c.tableId}` : "No table linked"}
                    {c.floorLabel ? ` · ${c.floorLabel}` : ""}
                    {c.coverRef ? ` · ${c.coverRef}` : ""}
                    {" — not in today's open tables. Walk over or use top banner ACK."}
                  </div>
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* 2026-05-13 — Khushi spec: customer search bar.
          Searches name, phone, table id, and booking ref together. */}
      <div style={{ padding: "10px 16px 0", position: "relative" }}>
        <input
          value={customerSearch}
          onChange={(e) => setCustomerSearch(e.target.value)}
          placeholder="🔎 Search customer name, phone, table, or ref"
          style={{ width: "100%", boxSizing: "border-box", padding: "10px 36px 10px 14px", borderRadius: 10, background: "#fff", border: "1px solid #000", color: "#000", fontSize: 16, outline: "none", fontFamily: "'Manrope','Space Grotesk',sans-serif" }}
        />
        {customerSearch && (
          <button onClick={() => setCustomerSearch("")}
            aria-label="Clear search"
            style={{ position: "absolute", right: 22, top: 16, background: "transparent", border: "none", color: "#6B6B6B", fontSize: 19, cursor: "pointer", padding: 4 }}>
            ✕
          </button>
        )}
        {/* 🆕 2026-06-25 (Khushi) — tappable SEARCH RESULTS dropdown. Floats over
            the content below the box; each row → opens that booking's detail. */}
        {customerSearch.trim() && (
          <div style={{ position: "absolute", left: 16, right: 16, top: "100%", marginTop: 6, zIndex: 40, background: "#fff", border: "2px solid #000", borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.18)", maxHeight: 340, overflowY: "auto" }}>
            {searchMatches.length === 0 ? (
              <div style={{ padding: "18px 14px", textAlign: "center", fontSize: 13, fontWeight: 700, color: "#6B6B6B" }}>
                No matching booking tonight.
              </div>
            ) : (
              searchMatches.map((r, i) => {
                const ref = r.bookingRef || (r as any).linkedCoverRef || "";
                const fmtDate = (d?: string) => {
                  if (!d) return "";
                  const [y, m, day] = d.split("-").map(Number);
                  if (!y || !m || !day) return d;
                  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1] || "";
                  return `${day} ${mon}`;
                };
                return (
                  <button
                    key={r._docId}
                    onClick={() => { setSelectedDocId(r._docId); setCustomerSearch(""); }}
                    style={{ width: "100%", textAlign: "left", display: "block", padding: "11px 14px", background: "#fff", border: "none", borderTop: i === 0 ? "none" : "1px solid #EEE", cursor: "pointer", fontFamily: "'Manrope','Space Grotesk',sans-serif" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 900, color: "#000", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        👤 {r.customerName || "—"}
                      </span>
                      {ref && (
                        <span style={{ flexShrink: 0, background: "#FBF3D6", border: "1.5px solid #000", borderRadius: 7, padding: "2px 7px", fontSize: 11, fontWeight: 900, color: "#000", letterSpacing: 0.3, fontFamily: "'Manrope','Space Grotesk',monospace" }}>
                          {shortRef(ref)}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12.5, fontWeight: 700, color: "#6B6B6B", marginTop: 4 }}>
                      <span>🪑 {r.tableId || "—"}{r.floorLabel ? ` · ${r.floorLabel}` : ""}</span>
                      {r.arrivalTime && <span>🕐 {r.arrivalTime}</span>}
                      {r.date && <span>📅 {fmtDate(r.date)}</span>}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* 🆕 2026-06-12 v3.266 (Khushi) — TABLE TRANSACTIONS panel. Mirror of Bar
          Mode's RECENT TRANSACTIONS, in the white area below the search box.
          Collapsed by default; tap the header to view the night's TABLE bills.
          Reads from the already-subscribed allReservations feed (ZERO extra
          Firestore reads). Latest 10 first; "View full" shows all; ⬇ exports a
          CSV. Each row taps open into a bill-style breakdown. Auto-clears at the
          7 AM operational-night rollover. Display/export ONLY — no writes. */}
      <div style={{ padding: "10px 16px 0" }}>
        <div style={{ border: "2px solid #000", borderRadius: 12, overflow: "hidden" }}>
          <button onClick={() => setTxOpen((v) => !v)}
            style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", background: txOpen ? "#000" : "#fff", border: "none", cursor: "pointer" }}>
            <span style={{ fontSize: 14, fontWeight: 900, letterSpacing: 0.4, color: txOpen ? "#fff" : "#000", fontFamily: "'Space Grotesk',sans-serif" }}>
              🧾 TABLE TRANSACTIONS
            </span>
            <span style={{ fontSize: 13, fontWeight: 800, color: txOpen ? "#FF90E8" : "#6B6B6B" }}>
              {txOpen ? "▲ HIDE" : "▼ TAP TO VIEW"}
            </span>
          </button>

          {txOpen && (
            <div style={{ padding: 12, background: "#fff" }}>
              {txRows.length === 0 ? (
                <div style={{ padding: "18px 8px", textAlign: "center", fontSize: 13, color: "#6B6B6B", fontWeight: 700 }}>
                  No table transactions yet tonight.
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: "#6B6B6B" }}>
                      {txFilter === "open" ? `${txFiltered.length} OPEN table${txFiltered.length === 1 ? "" : "s"}`
                        : txFilter === "cleared" ? `${txFiltered.length} CLEARED table${txFiltered.length === 1 ? "" : "s"}`
                        : txFull ? `All ${txRows.length} tonight`
                        : `Showing latest ${Math.min(10, txRows.length)} of ${txRows.length}`}
                    </div>
                    <button onClick={downloadTxCsv}
                      style={{ padding: "7px 12px", borderRadius: 8, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 12, fontWeight: 900, cursor: "pointer", whiteSpace: "nowrap" }}>
                      ⬇ Download
                    </button>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 900, color: "#000", background: "#EAF7F5", border: "1.5px solid #000", borderRadius: 8, padding: "9px 11px", marginBottom: 10, lineHeight: 1.5 }}>
                    🔒 VIEW ONLY — the real numbers can't be changed here.
                  </div>

                  {/* 🆕 2026-06-12 v3.268 (Khushi) — OPEN / CLEARED tables tabs.
                      OPEN = tables still running (not settled); CLEARED = settled
                      (paid) tables. Tap a tab to see that complete list. */}
                  <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                    {([
                      { key: "all", label: `ALL (${txRows.length})` },
                      { key: "open", label: `🟡 OPEN (${txOpenCount})` },
                      { key: "cleared", label: `✅ CLEARED (${txClearedCount})` },
                    ] as const).map((t) => {
                      const active = txFilter === t.key;
                      return (
                        <button key={t.key} onClick={() => { setTxFilter(t.key); setTxFull(false); }}
                          style={{ flex: 1, padding: "9px 6px", borderRadius: 9, border: "2px solid #000", cursor: "pointer",
                            background: active ? "#FF90E8" : "#fff", color: "#000",
                            fontSize: 12, fontWeight: 900, letterSpacing: 0.2, whiteSpace: "nowrap", fontFamily: "'Space Grotesk',sans-serif" }}>
                          {t.label}
                        </button>
                      );
                    })}
                  </div>

                  {txShown.length === 0 && (
                    <div style={{ padding: "16px 8px", textAlign: "center", fontSize: 13, color: "#6B6B6B", fontWeight: 700 }}>
                      {txFilter === "open" ? "No open tables right now." : txFilter === "cleared" ? "No cleared tables yet tonight." : "No table transactions yet tonight."}
                    </div>
                  )}

                  {txShown.map((row) => {
                    const r = row.r;
                    const open = !!txExpanded[r._docId];
                    const pill = _txStatusPill(row.status, r.paymentMode);
                    return (
                      <div key={r._docId} style={{ border: "1.5px solid #000", borderRadius: 10, marginBottom: 12, overflow: "hidden", borderLeft: open ? "5px solid #FF90E8" : "1.5px solid #000", boxShadow: "3px 3px 0px #000" }}>
                        <button onClick={() => setTxExpanded((m) => ({ ...m, [r._docId]: !m[r._docId] }))}
                          style={{ width: "100%", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, padding: "12px 14px", background: open ? "#FFEAF7" : "#fff", border: "none", cursor: "pointer" }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 17, fontWeight: 900, color: "#000", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              🪑 {r.tableId || "—"}{r.customerName ? ` · ${r.customerName}` : ""}
                            </div>
                            <div style={{ fontSize: 13, color: "#6B6B6B", fontWeight: 700, marginTop: 3 }}>
                              {r.phone || "—"}{r.bookingRef ? ` · ${shortRef(r.bookingRef)}` : ""}
                            </div>
                            <div style={{ fontSize: 13, color: "#6B6B6B", marginTop: 2 }}>{_txTime(row.ms)}</div>
                            <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 5 }}>
                              <span style={{ display: "inline-block", fontSize: 10, fontWeight: 900, letterSpacing: 0.4, padding: "3px 8px", borderRadius: 6, background: pill.bg, color: pill.fg }}>
                                {pill.label}
                              </span>
                              {row.override && (
                                <span style={{ display: "inline-block", fontSize: 10, fontWeight: 900, letterSpacing: 0.4, padding: "3px 8px", borderRadius: 6, background: "#7C3AED", color: "#fff" }}>
                                  ⚠ SC WAIVER / ADJUSTED
                                </span>
                              )}
                              {row.inhouseDiscOnAgg && (
                                <span title="Unusual: an in-house discount was applied to an AGGREGATOR booking. The amount collected is below the full menu bill printed for the aggregator."
                                  style={{ display: "inline-block", fontSize: 10, fontWeight: 900, letterSpacing: 0.4, padding: "3px 8px", borderRadius: 6, background: "#FEF3C7", border: "1px solid #B45309", color: "#92400E" }}>
                                  ⚠ IN-HOUSE DISC ON AGGREGATOR
                                </span>
                              )}
                            </div>
                          </div>
                          <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                            <div style={{ fontSize: 11, fontWeight: 800, color: "#6B6B6B", letterSpacing: 0.3 }}>{row.estimated ? "EST. BILL" : "BILLED"}</div>
                            <div style={{ fontSize: 22, fontWeight: 900, color: "#000" }}>₹{Math.round(row.billed)}</div>
                            <div style={{ fontSize: 13, fontWeight: 800, color: "#23A094", marginTop: 2 }}>{open ? "▲" : "▼ details"}</div>
                          </div>
                        </button>

                        {open && (
                          <div style={{ padding: "12px 14px", background: "#F4F4F0", borderTop: "1.5px solid #000" }}>
                            <div style={{ fontSize: 13, fontWeight: 900, color: "#000", letterSpacing: 0.4, marginBottom: 6 }}>ITEMS ORDERED</div>
                            {row.allItems.length === 0 ? (
                              <div style={{ fontSize: 14, color: "#6B6B6B", fontWeight: 700 }}>No items ordered on this table.</div>
                            ) : (
                              <div style={{ marginBottom: 4 }}>
                                {row.allItems.map((it, i) => (
                                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 15, color: "#000", fontWeight: 700, padding: "3px 0" }}>
                                    <span>{it.qty}× {it.n}</span>
                                    <span>₹{Math.round((it.p || 0) * (it.qty || 0))}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed #000" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, color: "#3A3A3A", fontWeight: 700, padding: "3px 0" }}>
                                <span>Subtotal</span><span>₹{Math.round(row.subtotal)}</span>
                              </div>
                              {row.discount > 0 && (
                                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, color: "#C0392B", fontWeight: 700, padding: "3px 0" }}>
                                  <span>Discount{row.discountPct > 0 ? ` (${row.discountPct}%)` : ""}</span><span>−₹{Math.round(row.discount)}</span>
                                </div>
                              )}
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, color: "#3A3A3A", fontWeight: 700, padding: "3px 0" }}>
                                <span>Service charge (10%)</span><span>₹{Math.round(row.serviceCharge)}</span>
                              </div>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, color: "#3A3A3A", fontWeight: 700, padding: "3px 0" }}>
                                <span>GST / tax (5%)</span><span>₹{Math.round(row.tax)}</span>
                              </div>
                            </div>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 800, color: "#000", marginTop: 6, paddingTop: 6, borderTop: "1px solid #000" }}>
                              <span>{row.estimated ? "Estimated bill (not settled)" : "Amount billed"}</span><span>₹{Math.round(row.billed)}</span>
                            </div>
                            {row.walletPaid > 0 && (
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 800, color: "#000", marginTop: 4 }}>
                                <span>Wallet redeemed</span><span>₹{Math.round(row.walletPaid)}</span>
                              </div>
                            )}
                            {row.isPaid && (
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 16, fontWeight: 900, color: "#23A094", marginTop: 4 }}>
                                <span>✅ Paid{r.paymentMode ? ` · ${r.paymentMode}` : ""}</span><span>₹{Math.round(row.amountPaid)}</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {txFilter === "all" && txRows.length > 10 && (
                    <button onClick={() => setTxFull((v) => !v)}
                      style={{ width: "100%", padding: 12, borderRadius: 10, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 900, cursor: "pointer", marginTop: 4 }}>
                      {txFull ? "▲ Show latest 10 only" : `▼ View full transactions (${txRows.length})`}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 🍳 2026-05-21 (Khushi) — FOOD READY strip now ONLY renders when the
          Food Ready tab is active. Previously it auto-showed any time food
          was ready, which Khushi felt cluttered the dashboard. The 5th KPI
          tile (green pulse) is the always-visible cue; tap it → strip opens.
          🛟 FALLBACK: in-card green banner + pulsing green ring on the tile
          still fire independently, so captain can't miss ready food even if
          they never tap the Food Ready tab. */}
      {pendingFilter === "ready" && readyGroups.length > 0 && (
        <div style={{ padding: "10px 16px 0" }}>
          <div className="hod-tile-ready"
            style={{
              borderRadius: 12, border: "1.5px solid #23A094",
              background: "linear-gradient(135deg,#E6F5F2,#E6F5F2)",
              padding: "10px 12px",
            }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div style={{ fontSize: 13, fontWeight: 900, color: "#23A094", letterSpacing: 0.6 }}>
                🍽 FOOD READY · {readyGroups.length} TABLE{readyGroups.length > 1 ? "S" : ""}
              </div>
              <div style={{ fontSize: 10, color: "#23A094", fontWeight: 800, letterSpacing: 0.4 }}>
                OPEN TABLE → ✓ PICKED UP
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {readyGroups.map((g) => {
                const isOpenableTable = !!g.resId && reservations.some((r) => r._docId === g.resId);
                // 🔴 2026-05-25 (Khushi) — Captain MUST be able to clear food-ready
                // rows whose source cover/reservation is gone (e.g. a bar wallet
                // that auto-archived 2 days ago, leaving a zombie KDS doc that
                // nothing in the UI can dismiss). Tap the green ✓ button → all
                // items in this group flip to picked_up via the same Firestore
                // helper bartender uses. 🛟 FALLBACK: any single item write that
                // fails is swallowed by markKDSPickedUp (already try/catch);
                // strip auto-redraws when at least one succeeds.
                const clearGroup = async (e: React.MouseEvent) => {
                  e.stopPropagation();
                  for (const it of g.items) {
                    if (it.id) { try { await markKDSPickedUp(it.id, captainName); } catch {} }
                  }
                };
                return (
                  <div key={g.key}
                    onClick={() => { if (isOpenableTable) setSelectedDocId(g.resId); }}
                    style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
                      background: "#E6F5F2", border: "1px solid #23A094",
                      borderRadius: 8, padding: "8px 10px", cursor: isOpenableTable ? "pointer" : "default",
                    }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 900, color: "#6B6B6B", letterSpacing: 0.3 }}>
                        {g.tableLabel}{g.floorLabel ? ` · ${g.floorLabel}` : ""}{g.customerName ? ` · ${g.customerName}` : ""}
                      </div>
                      <div style={{ fontSize: 11, color: "#6B6B6B", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {g.items.map((it) => `${it.itemName} ×${it.qty}`).join(" · ")}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                      {isOpenableTable ? (
                        // 🆕 2026-06-26 (Khushi) — the strip no longer marks PICKED UP
                        // directly; it OPENS the table so the captain confirms pickup
                        // from inside the table card (the "🍽 FOOD READY — GO SERVE"
                        // banner there has the ✓ PICKED UP button). Avoids a captain
                        // clearing the kitchen row without actually opening the table.
                        <button
                          onClick={(e) => { e.stopPropagation(); setSelectedDocId(g.resId); }}
                          title="Open this table to mark the food picked up"
                          style={{
                            background: "#23A094", color: "#fff", border: "2px solid #000",
                            padding: "6px 10px", borderRadius: 6, fontSize: 11, fontWeight: 900,
                            letterSpacing: 0.5, cursor: "pointer", whiteSpace: "nowrap",
                            fontFamily: "'Space Grotesk', sans-serif",
                          }}
                        >OPEN TABLE →</button>
                      ) : (
                        // 🛟 Orphan KDS row (its source table/cover is gone) — no table
                        // to open, so KEEP the direct clear so the captain can still
                        // dismiss a zombie food-ready row.
                        <button
                          onClick={clearGroup}
                          title="Mark this food as picked up — clears the row"
                          style={{
                            background: "#23A094", color: "#fff", border: "2px solid #000",
                            padding: "6px 10px", borderRadius: 6, fontSize: 11, fontWeight: 900,
                            letterSpacing: 0.5, cursor: "pointer", whiteSpace: "nowrap",
                            fontFamily: "'Space Grotesk', sans-serif",
                          }}
                        >✓ PICKED UP</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}


      <div style={{ padding: "10px 16px 0" }}>
        <button onClick={() => {
          if (isPastDate) { alert("⏪ Can't seat a walk-in on a past night. Switch the date to tonight first."); return; }
          setPendingOpenDocId(null); setWalkInPrefill(undefined); setShowWalkIn(true);
        }}
          disabled={isPastDate}
          style={{ width: "100%", padding: 12, borderRadius: 12, background: isPastDate ? "#E5E5E5" : "#F2C744", border: "2px solid #000", color: isPastDate ? "#888" : "#000", fontSize: 16, fontWeight: 800, cursor: isPastDate ? "not-allowed" : "pointer", letterSpacing: 0.5, opacity: isPastDate ? 0.7 : 1 }}>
          🚶 + Seat Walk-In Guest
        </button>
      </div>

      {/* 🆕 2026-05-20 (Khushi) — FLOOR-PLAN dashboard replaces the list. Same
          SVG layout the customer sees on hodclub.in/?book=table. KPI tiles,
          search bar, and Seat Walk-In CTA above remain unchanged. Tap a free
          table = walk-in modal pre-filled. Tap an occupied table = existing
          BookingDetailModal opens (no backend change). */}
      <FloorPlanView
        reservations={reservations}
        customerSearch={pendingFilter ? "" : customerSearch /* KPI filters override search highlighting */}
        pendingFilter={pendingFilter}
        activeWaiterCallTableIds={waiterCallTableIds}
        readyKDSResIds={readyKDSResIds}
        onSelectReservation={(docId) => {
          const clicked = reservations.find(x => x._docId === docId);
          if (!clicked) { setSelectedDocId(docId); return; }
          const siblings = clicked.tableId ? reservations.filter(x =>
            (x.tableId || "").toUpperCase() === clicked.tableId!.toUpperCase() &&
            (x as any).status !== "cancelled"
          ) : [];
          if (siblings.length > 1) {
            setTableSlotPick({ tableId: clicked.tableId!.toUpperCase(), slots: siblings });
          } else {
            setSelectedDocId(docId);
          }
        }}
        onSelectFreeTable={(tableId) => {
          if (isPastDate) { alert("⏪ Can't seat a walk-in on a past night. Switch the date to tonight first."); return; }
          setPendingOpenDocId(null); setWalkInPrefill(tableId); setShowWalkIn(true);
        }}
        focusFloorKey={focusFloorKey}
        focusModeOn={focusMode}
        tabletFloorLabel={tabletFloor ? (tabletFloor === "ground" ? "GROUND" : tabletFloor === "first" ? "DINING" : "ROOFTOP") : null}
        onToggleFocusMode={toggleFocusMode}
      />

      {showWalkIn && (
        <WalkInModal captainName={captainName}
          existingTables={allTableIds}
          allReservations={allReservations}
          isPastDate={isPastDate}
          isFutureDate={date > getOperationalNightStr()}
          prefillTable={walkInPrefill}
          onCreated={(docId) => { pendingOpenDeadlineRef.current = Date.now() + 6000; setPendingOpenDocId(docId); }}
          onClose={() => { setShowWalkIn(false); setWalkInPrefill(undefined); }} />
      )}

      {/* 🆕 2026-06-23 — Multi-slot picker: shown when captain taps a table that
          has ≥2 non-cancelled bookings for different time slots tonight. */}
      {tableSlotPick && (() => {
        // Helper: format any time to 12h "3:15 PM"
        const fmtSlotTime = (t?: string): string => {
          if (!t) return "—";
          const m12 = t.match(/^(\d+):(\d+)\s*(AM|PM)$/i);
          if (m12) return `${m12[1]}:${m12[2]} ${m12[3].toUpperCase()}`;
          const m24 = t.match(/^(\d{1,2}):(\d{2})$/);
          if (!m24) return t;
          let h = parseInt(m24[1]); const min = parseInt(m24[2]);
          const period = h >= 12 ? "PM" : "AM";
          if (h > 12) h -= 12; if (h === 0) h = 12;
          return `${h}:${String(min).padStart(2, "0")} ${period}`;
        };
        const toMinSlot = (t?: string) => {
          if (!t) return 9999;
          const m12 = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
          if (m12) {
            let h = parseInt(m12[1]); const min = parseInt(m12[2]); const pm = m12[3].toUpperCase() === "PM";
            if (pm && h !== 12) h += 12; if (!pm && h === 12) h = 0;
            return h * 60 + min;
          }
          const m24 = t.match(/^(\d{1,2}):(\d{2})$/);
          if (m24) return parseInt(m24[1]) * 60 + parseInt(m24[2]);
          return 9999;
        };
        const sorted = tableSlotPick.slots.slice().sort((a, b) => toMinSlot(a.arrivalTime) - toMinSlot(b.arrivalTime));
        return (
          <div
            onClick={(e) => { if (e.target === e.currentTarget) setTableSlotPick(null); }}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px 16px" }}>
            {/* Centered card — avoids safe-area bottom-crop */}
            <div style={{ background: "#fff", borderRadius: 20, border: "2.5px solid #000", width: "100%", maxWidth: 500, display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 40px)", overflow: "hidden" }}>
              {/* Header */}
              <div style={{ padding: "18px 20px 14px", borderBottom: "2px solid #000", display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexShrink: 0 }}>
                <div>
                  <div style={{ fontWeight: 900, fontSize: 21, color: "#000" }}>🪑 Table {tableSlotPick.tableId}</div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "#666", marginTop: 3 }}>{sorted.length} BOOKINGS TONIGHT · tap a row to open</div>
                </div>
                <button onClick={() => setTableSlotPick(null)} style={{ marginLeft: 12, background: "#F0F0F0", border: "2px solid #000", borderRadius: 10, width: 36, height: 36, fontSize: 18, cursor: "pointer", fontWeight: 900, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
              </div>
              {/* Scrollable rows — overscrollBehavior contains scroll within this div */}
              <div style={{ overflowY: "auto", flex: 1, overscrollBehavior: "contain" } as React.CSSProperties}>
                {sorted.map((slot, idx) => {
                  const name = (slot as any).customerName || (slot as any).name || "Guest";
                  const rawRef = (slot as any).bookingRef || slot._docId.slice(-6).toUpperCase();
                  const cleanRef = rawRef.replace(/-\d{8}-\d{4}$/, "").replace(/-\d{8}$/, "");
                  const displayTime = fmtSlotTime(slot.arrivalTime);
                  const isArrived = !!(slot.actualArrivalTime || (slot as any).hasLinkedCover);
                  const hasBill = slot.paymentStatus === "bill_requested";
                  const hasOrders = (slot.tabRounds || []).length > 0;
                  let statusLabel = "PENDING";
                  let statusBg = "#F3F3F3"; let statusBorder = "#CCC"; let statusTxt = "#555";
                  if (hasBill) { statusLabel = "BILL DUE"; statusBg = "#FEE2E2"; statusBorder = "#DC2626"; statusTxt = "#DC2626"; }
                  else if (hasOrders) { statusLabel = "ORDERING"; statusBg = "#FEF3C7"; statusBorder = "#D97706"; statusTxt = "#D97706"; }
                  else if (isArrived) { statusLabel = "ARRIVED"; statusBg = "#D1FAE5"; statusBorder = "#059669"; statusTxt = "#059669"; }
                  return (
                    <button key={slot._docId}
                      onClick={() => { setTableSlotPick(null); setSelectedDocId(slot._docId); }}
                      style={{ display: "flex", alignItems: "center", width: "100%", padding: "15px 20px", background: "transparent", borderLeft: "none", borderRight: "none", borderTop: "none", borderBottom: idx < sorted.length - 1 ? "1.5px solid #EBEBEB" : "none", cursor: "pointer", textAlign: "left", gap: 14 }}>
                      <div style={{ minWidth: 76, background: "#FF90B3", border: "2px solid #000", borderRadius: 10, padding: "7px 6px", textAlign: "center", fontWeight: 900, fontSize: 13, color: "#000", flexShrink: 0 }}>{displayTime}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 900, fontSize: 16, color: "#000", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
                        <div style={{ fontWeight: 700, fontSize: 12, color: "#777", marginTop: 2 }}>REF: {cleanRef}</div>
                      </div>
                      <div style={{ fontWeight: 800, fontSize: 11, color: statusTxt, background: statusBg, border: `1.5px solid ${statusBorder}`, borderRadius: 8, padding: "4px 9px", whiteSpace: "nowrap", flexShrink: 0 }}>{statusLabel}</div>
                      <span style={{ color: "#CCC", fontSize: 20, flexShrink: 0 }}>›</span>
                    </button>
                  );
                })}
              </div>
              {/* Footer: + Add New Slot + Close */}
              <div style={{ padding: "14px 20px 18px", borderTop: "2px solid #000", display: "flex", flexDirection: "column", gap: 10, flexShrink: 0 }}>
                {!isPastDate && (
                  <button
                    onClick={() => { setTableSlotPick(null); setWalkInPrefill(tableSlotPick!.tableId); setShowWalkIn(true); }}
                    style={{ width: "100%", padding: "13px", borderRadius: 12, background: "#FF90B3", border: "2.5px solid #000", color: "#000", fontSize: 15, fontWeight: 900, cursor: "pointer", letterSpacing: 0.3 }}>
                    + NEW BOOKING FOR THIS TABLE
                  </button>
                )}
                <button onClick={() => setTableSlotPick(null)}
                  style={{ width: "100%", padding: "12px", borderRadius: 12, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 15, fontWeight: 800, cursor: "pointer" }}>
                  CLOSE
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {selectedDocId && (() => {
        // 🆕 2026-06-25 — fall back to allReservations so a SETTLE BILL tab tap on
        // an OFF-floor table (the floor-scoped `reservations` may not hold it)
        // still opens its card instead of silently closing.
        const sel = reservations.find((x) => x._docId === selectedDocId)
          || allReservations.find((x) => x._docId === selectedDocId);
        if (!sel) { setSelectedDocId(null); return null; }
        return (
          <BookingDetailModal
            r={sel}
            captainName={captainName}
            playAlert={playAlert}
            existingTables={allTableIds}
            allReservations={allReservations}
            isPastDate={isPastDate}
            canSettle={canSettle}
            onClose={() => setSelectedDocId(null)}
            onSeatAnother={(tableId) => { setSelectedDocId(null); setPendingOpenDocId(null); setWalkInPrefill(tableId); setShowWalkIn(true); }}
          />
        );
      })()}
    </div>
  );
}

export default function CaptainMode() {
  const { isLoggedIn, currentStaff, hasRole, activeMode } = useStaff();
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

  // 🔴 2026-05-25 (code review fix) — Force local logout whenever the global
  // staff session is cleared (idle-lock 5-wrong, manual logout, 10hr expiry,
  // OR mode-picker switches away from captain). Without this, the dashboard
  // remained reachable from stale local state. Belt-and-suspenders security.
  useEffect(() => {
    if (!captainName) return;
    const stillCaptain = isLoggedIn && currentStaff && hasRole("captain") && (!activeMode || activeMode === "captain");
    if (!stillCaptain) {
      sessionStorage.removeItem("hod_captain_auth");
      sessionStorage.removeItem("hod_captain_name");
      setCaptainName(null);
    }
  }, [isLoggedIn, currentStaff, hasRole, activeMode, captainName]);

  if (!captainName) return <CaptainLogin onLogin={handleLogin} />;
  return <CaptainDashboard captainName={captainName} />;
}
