import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Link } from "wouter";
import { useStaff } from "@/lib/staff-context";
import { StaffLogin } from "@/components/StaffLogin";
import {
  sha256, lookupBooking, subscribeToBookings, subscribeToGuestlist,
  subscribeToBookingsForNights, subscribeToGuestlistInRange,
  subscribeToHodReservations, checkInGuest, reassignTable, cancelTableReservation,
  updateReservationDetails,
  ensureZeroBalanceCoverForGuest,
  subscribeToHodEvents, subscribeToHodEventsRecent, type HodEvent,
  getCoverForBooking, activateCoverForBooking, editCoverAmount,
  ensureCoverForAggregatorArrival, createAggregatorTableBooking,
  createWalkInTicketBooking, createWalkInGuestlistEntry, createWalkInTableReservation,
  createCorporateTableBooking,
  DEFAULT_BOOKING_AMENITIES, type BookingAmenity,
  AGGREGATOR_OPTIONS, getAggregatorDiscount, recordWalkInDiscountOverride,
  logNotificationOutcome, subscribeToWalletScan,
  searchBookingsAndAggregators, type CrossSourceBooking,
  type HodBooking, type HodGuestlistEntry, type HodTableReservation, type HodCover,
} from "@/lib/firestore-hod";
import { subscribeToEdcDefaultVendor } from "@/lib/firestore";

// L-A1 — Manager PIN gate for door-side aggregator booking creation when
// the door agent applies a discount higher than the source's default by more
// than 5pp. Default Manager PIN is 8888 (rotate via sha256(newPin)).
const DOOR_MANAGER_HASH = "2926a2731f4b312c08982cacf8061eb14bf65c1a87cc5d70e864e079c6220731";
const DOOR_DISCOUNT_PIN_DELTA = 5;
async function requireDoorManagerPin(reason: string): Promise<boolean> {
  const pin = window.prompt(`🔒 Manager PIN required\n\n${reason}\n\nEnter 4-digit Manager PIN:`);
  if (!pin) return false;
  const h = await sha256(pin.trim());
  if (h !== DOOR_MANAGER_HASH) { alert("❌ Wrong Manager PIN."); return false; }
  return true;
}
import { ALL_TABLES, SECTION_LABELS } from "@/lib/tables-config";
import {
  DOOR_TABLE_OPTIONS, doorProxyLabel, doorTableCapacity,
  doorParseClockToMinutes, doorNowMinutesIST, doorTableOccupantAt,
} from "@/lib/door-tables";
import { FEATURES } from "@/lib/feature-flags";
import {
  startEdcCharge, subscribeToEdcTransaction, cancelEdcCharge,
  getActiveEdcVendor, setActiveEdcVendor, hasEdcVendorOverride, edcVendorLabel,
  EDC_CLIENT_TIMEOUT_MS,
  type EdcVendor, type EdcTransactionDoc,
} from "@/lib/edc-charge";
import { getOperationalNightStr } from "@/lib/utils-pos";
import { unmarkGuestArrived, markGuestArrived, addToWaitlist, linkCoverToTable, subscribeToDoorPricingSettings, subscribeToCoversForNight, subscribeWaitlist } from "@/lib/firestore-hod";
import WaitlistView from "@/components/WaitlistView";
import WaitlistAutoMatch from "@/components/WaitlistAutoMatch";
import { useToast } from "@/hooks/use-toast";

// 🆕 2026-05-27 v3.72 (Khushi LIVE-NIGHT) — in-app styled alert overlay.
// Replaces native browser `alert()` (ugly grey "An embedded page at … says"
// chrome on tablets, blocks the whole event loop, looks like a phishing
// popup). Pure DOM so it works in any component scope without React state
// refactors. Auto-dismisses on backdrop tap, OK tap, or Escape. Reuses
// the gold HOD palette so it feels native to the POS.
function showAppAlert(message: string, title?: string) {
  if (typeof document === "undefined") return;
  // Strip leading emoji from title for the badge if title not provided.
  const lines = message.split("\n").map((s) => s.trim()).filter(Boolean);
  const head = title || lines.shift() || "NOTICE";
  const body = lines.join("\n\n");
  const overlay = document.createElement("div");
  overlay.setAttribute("data-hod-alert", "1");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100000;display:flex;align-items:center;justify-content:center;padding:18px;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;animation:hodAlertFade .15s ease-out;";
  const card = document.createElement("div");
  card.style.cssText = "background:#F4F4F0;border:2px solid #000;border-radius:8px;max-width:420px;width:100%;color:#000;overflow:hidden;";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  card.innerHTML =
    '<div style="padding:18px 20px 8px;border-bottom:2px solid #000;">' +
      '<div style="font-size:17px;font-weight:900;color:#000;letter-spacing:.4px;line-height:1.3;">' + esc(head) + '</div>' +
    '</div>' +
    '<div style="padding:16px 20px 20px;font-size:14px;line-height:1.55;color:#6B6B6B;font-weight:500;white-space:pre-wrap;">' + esc(body) + '</div>' +
    '<div style="padding:0 16px 16px;">' +
      '<button id="hod-app-alert-ok" type="button" style="width:100%;padding:14px;border-radius:6px;background:#FF90E8;border:2px solid #000;color:#000;font-size:14px;font-weight:900;letter-spacing:.6px;cursor:pointer;text-transform:uppercase;font-family:inherit;">OK</button>' +
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

// Firebase Cloud Functions — replaces Replit /api/whatsapp/*
// Set this to your Firebase Functions URL after deploying:
//   https://asia-south1-hod-tickets.cloudfunctions.net
// During local dev with Firebase emulator:
//   http://localhost:5001/hod-tickets/asia-south1
const WHATSAPP_CF_BASE = "https://asia-south1-hod-tickets.cloudfunctions.net";

// 🆕 2026-06-02 (Khushi) — booking-confirmation EMAIL endpoint. This is the
// SAME ZeptoMail Cloud Function the customer site (hodclub.in) already POSTs
// to; the door walk-in flow never called it (it only sent WhatsApp), so
// walk-in guests never got a confirmation email. Note the region is
// us-central1 (NOT asia-south1 like the WhatsApp fns). Fire-and-forget,
// fail-open — email must NEVER block or break a door check-in.
const EMAIL_CF_URL = "https://us-central1-hod-tickets.cloudfunctions.net/sendBookingEmail";

import { ToastAction } from "@/components/ui/toast";
import { QrScanner } from "@/components/QrScanner";
import { centeredAlert, centeredPinPrompt } from "@/lib/centered-ui";
import { sendWhatsAppTextMessage } from "@/lib/wa-send";

// 🔄 2026-05-24 (Khushi) — REVERTED per-staff login back to shared name+password.
// Khushi is rebuilding the staff/attendance module separately tonight, so the
// door tablet uses the simple Name + Password gate for go-live tomorrow.
// Password hash below is sha256("hod2025") — rotate via Admin → Settings.
const DOOR_HASH = "f3deb7cb025897c8b29bc9c0603c35909616f8d6a0c32ddb774683accf394cb9";

// 🆕 2026-05-25 (Khushi) — Door login now uses unified per-staff `StaffLogin`
// (HOD ID + 4-digit PIN). Wrapper bridges `currentStaff.name` → existing
// `agentName` state in the parent DoorMode so the rest of DoorMode stays
// untouched. `hostess` role is allowed; admin implicitly allowed.
// 🆕 2026-06-02 v3.179 (Khushi) — small reusable "← BACK" button so the door
// girl can ALWAYS escape any modal. White pill, 2px black border (Gumroad).
function BackBtn({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <div style={{ display: "flex", marginBottom: 12 }}>
      <button onClick={onClick} disabled={disabled}
        style={{ background: "#fff", border: "2px solid #000", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 900, color: "#000", cursor: disabled ? "not-allowed" : "pointer", letterSpacing: 0.5, opacity: disabled ? 0.5 : 1, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
        ← BACK
      </button>
    </div>
  );
}

function DoorLogin({ onLogin }: { onLogin: (name: string) => void }) {
  const { currentStaff, isLoggedIn, hasRole, activeMode, needsModePicker } = useStaff();
  useEffect(() => {
    if (!isLoggedIn || !currentStaff || needsModePicker) return;
    if (!hasRole("hostess")) return;
    if (activeMode && activeMode !== "hostess") return;
    sessionStorage.setItem("hod_door_name", currentStaff.name);
    sessionStorage.setItem("hod_door_auth", "1");
    onLogin(currentStaff.name);
  }, [isLoggedIn, currentStaff, hasRole, activeMode, needsModePicker, onLogin]);
  return <StaffLogin allowedRoles={["hostess"]} title="DOOR LOGIN" emoji="🚪" brutalist />;
}

function CoverActivationModal({ booking, agentName, onClose }: { booking: HodBooking; agentName: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [existing, setExisting] = useState<HodCover | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const today = getOperationalNightStr();
  // 🔴 BUGFIX 2026-05-19 (Khushi LIVE-NIGHT) — bot-created tickets (e.g.
  // TICKET-AJAY-19MAY-776) store date as "19/05/2026" / "19-05-2026" /
  // "Tuesday, 19 May 2026". Naive string < comparison treats those as
  // "past" (e.g. "19/05/2026" < "2026-05-19" → true) and the modal blocks
  // activation with "⛔ Past event". Normalise to YYYY-MM-DD first; if we
  // cannot parse the date at all, treat as NOT past (fail-open — door staff
  // can always charge cover, never lose a ₹1000 sale to a string mismatch).
  const parseAnyDate = (s?: string): string | null => {
    if (!s) return null;
    const t = String(s).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const m = t.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    const d = new Date(t);
    if (!isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    return null;
  };
  const normalisedDate = parseAnyDate(booking.date);
  const isPast = !!normalisedDate && normalisedDate < today;

  // Activation form state
  const isCash = booking.paymentId && booking.paymentId.startsWith("cash_");
  const paidOnline = isCash ? 0 : (booking.total || 0);
  const [amount, setAmount] = useState<string>(String(booking.total || paidOnline || ""));
  const [method, setMethod] = useState<"cash" | "upi" | "card" | "paid_online" | "split" | "">(
    paidOnline > 0 ? "paid_online" : (booking._isGuestList ? "cash" : "")
  );
  const [splitCash, setSplitCash] = useState("");
  const [splitUpi, setSplitUpi] = useState("");
  const [splitCard, setSplitCard] = useState("");
  // ── EDC Cloud (Razorpay POS / Pine Labs Plutus) — bouncer PIN + live dialog
  // We only show the PIN field + dialog when:
  //   1. FEATURES.edc is on AND
  //   2. method === "card" (split payments still go through the legacy flow —
  //      EDC for the card portion of a split adds too much UX/edge-case
  //      complexity for first ship; revisit once both vendors are proven).
  // Vendor defaults to the build-time `VITE_EDC_VENDOR` (or razorpay) and
  // can be toggled per-device from the picker below — covers the case where
  // a venue runs both card machines and the bouncer picks whichever is free.
  const [edcPin, setEdcPin] = useState("");
  // Initial value uses build-default + any per-device override; the
  // venue-wide Firestore default arrives via subscription below and only
  // overrides state when this device has NOT explicitly picked a vendor.
  const [venueDefaultVendor, setVenueDefaultVendor] = useState<EdcVendor | null>(null);
  const [edcVendor, setEdcVendor] = useState<EdcVendor>(() => getActiveEdcVendor(null));
  useEffect(() => {
    if (!FEATURES.edc) return;
    const unsub = subscribeToEdcDefaultVendor((v) => {
      setVenueDefaultVendor(v);
      // Only follow the venue default when this device has not explicitly
      // overridden the vendor — preserves bouncer's mid-shift toggle.
      if (v && !hasEdcVendorOverride()) setEdcVendor(v);
    });
    return () => unsub();
  }, []);
  // dueAmount = what the EDC machine actually charges (cover − online prepayment).
  // fullAmount = the cover amount to record on activation (covers add-ons + prepaid).
  // We must NOT pass dueAmount to activation, or the wallet under-activates
  // for partially prepaid bookings.
  const [edcTxn, setEdcTxn] = useState<{ txnId: string; vendor: EdcVendor; dueAmount: number; fullAmount: number } | null>(null);
  // Snapshot of the inputs that produced `edcTxn`, kept so the "Retry on
  // machine" button on the failed/cancelled dialog can re-dispatch with the
  // same booking + bouncer + amount without forcing the operator to retype
  // the PIN. Cleared on success/cancel/close to avoid stale-state replays.
  const [edcRetryArgs, setEdcRetryArgs] = useState<{
    bookingId: string; bookingRef: string; coverRef: string; vendor: EdcVendor;
    bouncerPin: string; bouncerName: string; expectedAmount: number;
    dueAmount: number; fullAmount: number;
  } | null>(null);

  // Edit existing state
  const [editMode, setEditMode] = useState(false);
  const [editAmt, setEditAmt] = useState<string>("");
  // 🆕 2026-05-26 v3.24 (Khushi) — in-app confirm instead of window.confirm.
  // Floor tablets are in PWA-style fullscreen — the browser-native confirm
  // popup looks alien and jarring. When non-null, render a styled overlay.
  const [confirmNewAmt, setConfirmNewAmt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cv = await getCoverForBooking(booking.ref || booking.id);
        if (!cancelled) {
          // 🔴 BUGFIX 2026-05-19 (Khushi LIVE-NIGHT) — TWO things create an
          // EMPTY covers stub doc BEFORE real activation:
          //   1. Cloud-function `logNotificationOutcome` (auto-WA bookkeeping)
          //   2. Door check-in auto-mint `ensureZeroBalanceCoverForGuest`
          //      (guestlist + entry-only — added 2026-05-19 for wallet menu)
          // Both leave coverActivated=0 / coverBalance=0. Without this guard
          // the modal sees ANY existing doc and jumps to the ALREADY-ACTIVATED
          // edit UI — door staff then have NO way to charge ₹1000 cover +
          // collect cash/UPI/card. Treat empty stubs as "not yet activated"
          // so the activation form (amount + payment method) renders instead.
          const isRealActivation = !!cv && ((cv.coverActivated || 0) > 0 || (cv.coverBalance || 0) > 0);
          setExisting(isRealActivation ? cv : null);
          if (cv) setEditAmt(String(cv.coverActivated || 0));
        }
      } catch {}
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [booking.id, booking.ref]);

  const sendWhatsApp = (cover: HodCover) => {
    const phone = (booking.phone || "").replace(/\D/g, "").slice(-10);
    if (phone.length !== 10) return;
    const link = `https://hodclub.in/?wallet=${encodeURIComponent(booking.ref || cover.id)}`;
    const msg = encodeURIComponent(
      `Hi ${booking.name || "there"}! 🥳\n\nYour HOD Cover Wallet of ₹${cover.coverActivated.toLocaleString("en-IN")} is now ACTIVE! 🎉\n\n💰 Wallet Balance: ₹${cover.coverActivated.toLocaleString("en-IN")}\n100% redeemable on Food & Drinks\n\n📲 Pre-order here:\n${link}\n\nHouse of Dopamine | Koramangala 🎵`
    );
    window.open(`https://wa.me/91${phone}?text=${msg}`, "_blank", "noopener");
  };

  // Shared finalizer — writes the cover doc once payment (EDC or otherwise) is settled.
  const finalizeActivation = async (
    amt: number,
    pm: "cash" | "upi" | "card" | "paid_online" | "split",
    paymentSplit: { cash?: number; upi?: number; card?: number; paid_online?: number } | undefined,
    edcRef?: string,
  ) => {
    const { cover } = await activateCoverForBooking({ booking, amount: amt, paymentMethod: pm, paymentSplit, staffName: agentName });
    setExisting(cover);
    const diff = amt - paidOnline;
    const collectMsg = pm === "split"
      ? `Collect: ${paymentSplit?.cash ? `₹${paymentSplit.cash} cash ` : ""}${paymentSplit?.upi ? `+ ₹${paymentSplit.upi} UPI ` : ""}${paymentSplit?.card ? `+ ₹${paymentSplit.card} card` : ""}`.trim()
      : edcRef
        ? `💳 EDC charged ₹${diff > 0 ? diff : amt} (ref ${edcRef}).`
        : diff > 0 ? `Collect ₹${diff} ${pm === "cash" ? "cash" : pm === "upi" ? "UPI" : "card"}.` : "Nothing further to collect.";
    // 🔴 2026-05-26 (Khushi) — centered branded confirmation, no browser alert.
    await centeredAlert(
      "COVER ACTIVATED",
      `₹${amt.toLocaleString("en-IN")} cover for ${booking.name || "guest"} is now LIVE.\n\n${collectMsg}\n\n100% redeemable on Food & Drinks.`,
      "success",
      true,
    );
  };

  const handleActivate = async () => {
    setErr("");
    const amt = parseInt(amount, 10);
    if (!amt || amt < 1) { setErr("Enter a valid cover amount"); return; }
    if (amt > 50000) { setErr("Max ₹50,000"); return; }
    if (!method) { setErr("Select a payment method"); return; }
    let paymentSplit: { cash?: number; upi?: number; card?: number; paid_online?: number } | undefined;
    if (method === "split") {
      const c = parseInt(splitCash || "0", 10) || 0;
      const u = parseInt(splitUpi || "0", 10) || 0;
      const cd = parseInt(splitCard || "0", 10) || 0;
      const sum = c + u + cd + paidOnline;
      if (sum !== amt) { setErr(`Split total ₹${sum} must equal cover ₹${amt}`); return; }
      if (c < 0 || u < 0 || cd < 0) { setErr("Split amounts cannot be negative"); return; }
      paymentSplit = { cash: c, upi: u, card: cd, paid_online: paidOnline };
    }

    // ── EDC Cloud branch ──────────────────────────────────────────────────
    // Pure-card payment with EDC enabled → push the bill to the card-swipe
    // machine BEFORE writing the cover doc. We dispatch the charge, open
    // the live status dialog, and let onSuccess (in the dialog) call
    // finalizeActivation once the customer has tapped their card.
    if (FEATURES.edc && method === "card") {
      if (!/^\d{4,6}$/.test(edcPin)) { setErr("Enter a valid 4–6 digit bouncer PIN"); return; }
      // bookingId = Firestore doc id; bookingRef = human-readable ref.
      const bookingId  = booking.id  || booking.ref || "";
      const bookingRef = booking.ref || booking.id  || "";
      const coverRef   = bookingRef;
      if (!bookingId || !bookingRef) { setErr("Missing booking reference"); return; }
      // Reject EDC dispatch when nothing is owed (e.g. fully paid online).
      // Without this guard, switching method to Card on a zero-due booking
      // would push the gross amount to the EDC machine and double-charge.
      const quoteAmt = amt - paidOnline;
      if (quoteAmt <= 0) {
        setErr("Nothing due — this booking is already paid online. Use 'Mark paid' instead.");
        return;
      }
      setBusy(true);
      // Note: cloud function derives canonical amount strictly from
      // covers/bookings; expectedAmount below is only a client sanity
      // check and is rejected server-side if it diverges.
      const dispatch = await startEdcCharge({
        bookingId,
        bookingRef,
        coverRef,
        vendor: edcVendor,
        bouncerPin: edcPin,
        bouncerName: agentName,
        expectedAmount: amt - paidOnline > 0 ? amt - paidOnline : amt,
      });
      setBusy(false);
      if (!dispatch.ok || !dispatch.txnId) {
        const vendorName = edcVendorLabel(edcVendor);
        const reasonMap: Record<string, string> = {
          vendor_disabled: `${vendorName} is not yet enabled on this merchant account. Ask owner to enable it, or switch vendor.`,
          bad_pin: "Bouncer PIN rejected. Try again or get a manager.",
          no_amount: "Server couldn't determine the cover amount for this booking. Refresh and retry, or use cash/UPI.",
          amount_mismatch: dispatch.canonical
            ? `Amount mismatch — booking actually owes ₹${dispatch.canonical}. Update the cover amount and retry.`
            : "Amount mismatch — refresh the booking and retry.",
          vendor_error: dispatch.errorMessage || `${vendorName} rejected the charge — try again or use cash/UPI.`,
          no_terminal: `No ${vendorName} machine paired. Configure a Terminal ID in cloud function settings.`,
          error: dispatch.errorMessage || "Could not reach the EDC machine.",
        };
        setErr(reasonMap[dispatch.reason || "error"] || dispatch.errorMessage || "EDC dispatch failed");
        return;
      }
      setEdcTxn({ txnId: dispatch.txnId, vendor: edcVendor, dueAmount: quoteAmt, fullAmount: amt });
      // Snapshot dispatch args so the "Retry on machine" button on the EDC
      // dialog can re-dispatch with retry:true without re-prompting the
      // bouncer. Vendor is captured from the per-device toggle at dispatch
      // time so a mid-shift vendor flip doesn't retry on the wrong machine.
      setEdcRetryArgs({
        bookingId, bookingRef, coverRef, vendor: edcVendor,
        bouncerPin: edcPin, bouncerName: agentName,
        expectedAmount: amt - paidOnline > 0 ? amt - paidOnline : amt,
        dueAmount: quoteAmt, fullAmount: amt,
      });
      return; // dialog drives the rest
    }

    setBusy(true);
    try {
      await finalizeActivation(amt, method, paymentSplit);
    } catch (e: any) { setErr(e?.message || "Failed to activate"); }
    setBusy(false);
  };

  const handleEditSave = () => {
    if (!existing) return;
    const newAmt = parseInt(editAmt, 10);
    const used = existing.coverUsed || 0;
    if (!newAmt || newAmt < used) { setErr(`Min ₹${used} (already used)`); return; }
    if (newAmt > 50000) { setErr("Max ₹50,000"); return; }
    if (newAmt === existing.coverActivated) { setErr("Amount unchanged"); return; }
    // 🆕 2026-05-26 v3.24 (Khushi) — open in-app confirm overlay instead of
    // window.confirm (which renders as an alien browser-native popup on the
    // floor tablet).
    setErr("");
    setConfirmNewAmt(newAmt);
  };

  const doEditSave = async () => {
    if (!existing || confirmNewAmt == null) return;
    const newAmt = confirmNewAmt;
    setBusy(true); setErr("");
    try {
      await editCoverAmount(existing.id, newAmt, agentName);
      const cv = await getCoverForBooking(booking.ref || booking.id);
      if (cv) setExisting(cv);
      setEditMode(false);
      setConfirmNewAmt(null);
    } catch (e: any) { setErr(e?.message || "Failed to edit"); }
    setBusy(false);
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 24, width: "100%", maxWidth: 440, maxHeight: "92vh", overflowY: "auto", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
        <BackBtn onClick={onClose} />
        <div style={{ fontSize: 14, fontWeight: 900, color: "#000", letterSpacing: 2, marginBottom: 12 }}>💰 COVER CHARGE</div>
        <div style={{ fontSize: 20, fontWeight: 900, color: "#000", letterSpacing: .5 }}>{(booking.name || "GUEST").toUpperCase()}</div>
        <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 18, marginTop: 4 }}>
          {booking.eventTitle || ""}{booking._isGuestList ? " · Guest List" : paidOnline > 0 ? ` · Paid online ₹${paidOnline}` : isCash ? ` · 💵 Pay at venue ₹${booking.total || 0}` : ""}
        </div>

        {isPast ? (
          <div style={{ background: "#FF5733", border: "2px solid #000", borderRadius: 8, padding: 14, color: "#fff", fontSize: 13, textAlign: "center", marginBottom: 12 }}>
            ⛔ Past event ({booking.date}) — cover cannot be activated.
          </div>
        ) : loading ? (
          <div style={{ textAlign: "center", padding: 24, color: "#6B6B6B", fontSize: 12 }}>Checking cover status…</div>
        ) : existing ? (
          <>
            <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: 16, marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#000", letterSpacing: 1.5, marginBottom: 10 }}>✅ ALREADY ACTIVATED</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, textAlign: "center" }}>
                <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6B6B", letterSpacing: .8 }}>ACTIVATED</div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: "#000", marginTop: 2 }}>₹{(existing.coverActivated || 0).toLocaleString("en-IN")}</div>
                </div>
                <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6B6B", letterSpacing: .8 }}>USED</div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: "#000", marginTop: 2 }}>₹{(existing.coverUsed || 0).toLocaleString("en-IN")}</div>
                </div>
                <div style={{ background: "#FFD700", border: "2px solid #000", borderRadius: 8, padding: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6B6B", letterSpacing: .8 }}>BALANCE</div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: "#000", marginTop: 2 }}>₹{(existing.coverBalance || 0).toLocaleString("en-IN")}</div>
                </div>
              </div>
              {(existing.paymentMethod || existing.activatedBy) && (
                <div style={{ fontSize: 12, color: "#6B6B6B", marginTop: 10, textAlign: "center" }}>
                  {existing.paymentMethod ? `PAID VIA ${String(existing.paymentMethod).toUpperCase()}` : ""}{existing.activatedBy ? ` · BY ${String(existing.activatedBy).toUpperCase()}` : ""}
                </div>
              )}
            </div>
            {editMode ? (
              <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: 14, marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: "#000", marginBottom: 10, letterSpacing: 1 }}>EDIT AMOUNT — MIN ₹{existing.coverUsed || 0} · MAX ₹5,000</div>
                <input type="number" inputMode="numeric" value={editAmt} onChange={(e) => setEditAmt(e.target.value)}
                  style={{ width: "100%", padding: 14, borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 22, fontWeight: 800, outline: "none", marginBottom: 10, boxSizing: "border-box", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }} />
                <button onClick={handleEditSave} disabled={busy}
                  style={{ width: "100%", padding: 14, borderRadius: 6, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 15, fontWeight: 900, letterSpacing: 1, cursor: "pointer" }}>
                  {busy ? "SAVING…" : "SAVE NEW AMOUNT"}
                </button>
              </div>
            ) : (
              <button onClick={() => { setEditMode(true); setErr(""); }}
                style={{ width: "100%", padding: 14, borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 15, fontWeight: 800, letterSpacing: 1, cursor: "pointer", marginBottom: 10 }}>
                ✏️ EDIT COVER AMOUNT
              </button>
            )}
            <button onClick={() => sendWhatsApp(existing)}
              style={{ width: "100%", padding: 14, borderRadius: 6, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 15, fontWeight: 800, letterSpacing: 1, cursor: "pointer", marginBottom: 10 }}>
              📲 SEND WHATSAPP WALLET LINK
            </button>
            {/* 🔴 2026-05-21 (Khushi) — Void Cover button REMOVED per request.
                Mistakes during check-in are now reverted via the existing
                ✏️ Edit Cover Amount button just above (set back to ₹0 or
                whatever was originally collected). */}
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#000", letterSpacing: 1.5, marginBottom: 8 }}>TONIGHT'S COVER (₹)</div>
            <input type="number" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 1499" min={0} max={50000}
              style={{ width: "100%", padding: "16px 16px", borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 26, fontWeight: 900, outline: "none", marginBottom: 16, boxSizing: "border-box", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }} />

            <div style={{ fontSize: 13, fontWeight: 800, color: "#000", letterSpacing: 1.5, marginBottom: 10 }}>PAYMENT METHOD</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              {([
                { id: "cash" as const, label: "💵 CASH" },
                { id: "upi" as const, label: "📱 UPI" },
                { id: "card" as const, label: FEATURES.edc ? "💳 CARD (EDC)" : "💳 CARD" },
                { id: "paid_online" as const, label: "✅ PAID ONLINE" },
              ]).map((pm) => {
                const sel = method === pm.id;
                return (
                  <button key={pm.id} onClick={() => setMethod(pm.id)}
                    style={{ padding: "14px 10px", borderRadius: 6, border: `2px solid #000`, background: sel ? "#FF90E8" : "#fff", color: "#000", fontSize: 15, fontWeight: 900, letterSpacing: 1, cursor: "pointer" }}>
                    {pm.label}
                  </button>
                );
              })}
            </div>
            <button onClick={() => setMethod("split")}
              style={{ width: "100%", padding: "14px 10px", borderRadius: 6, border: `2px solid #000`, background: method === "split" ? "#FF90E8" : "#fff", color: "#000", fontSize: 15, fontWeight: 900, letterSpacing: 1, cursor: "pointer", marginBottom: 14 }}>
              ➗ SPLIT PAYMENT
            </button>

            {method === "split" && (() => {
              const amt = parseInt(amount || "0", 10) || 0;
              const c = parseInt(splitCash || "0", 10) || 0;
              const u = parseInt(splitUpi || "0", 10) || 0;
              const cd = parseInt(splitCard || "0", 10) || 0;
              const total = c + u + cd + paidOnline;
              const remain = amt - total;
              return (
                <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: 14, marginBottom: 14 }}>
                  <div style={{ fontSize: 12, color: "#000", marginBottom: 10, fontWeight: 800, letterSpacing: 1 }}>SPLIT BREAKDOWN (MUST TOTAL ₹{amt})</div>
                  {paidOnline > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 12px", borderRadius: 8, background: "#23A094", border: "2px solid #000", fontSize: 14, color: "#fff", marginBottom: 8, fontWeight: 800 }}>
                      <span>✅ PAID ONLINE (LOCKED)</span><span>₹{paidOnline}</span>
                    </div>
                  )}
                  {([
                    { lbl: "💵 CASH", val: splitCash, set: setSplitCash },
                    { lbl: "📱 UPI", val: splitUpi, set: setSplitUpi },
                    { lbl: "💳 CARD", val: splitCard, set: setSplitCard },
                  ]).map((row) => (
                    <div key={row.lbl} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 8, alignItems: "center", marginBottom: 8 }}>
                      <span style={{ fontSize: 14, color: "#000", fontWeight: 800, minWidth: 90, letterSpacing: .5 }}>{row.lbl}</span>
                      <input type="number" inputMode="numeric" value={row.val} onChange={(e) => row.set(e.target.value)} placeholder="0"
                        style={{ padding: "12px 12px", borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 18, fontWeight: 800, outline: "none", textAlign: "right", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }} />
                    </div>
                  ))}
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 12px", borderRadius: 8, background: remain === 0 ? "#23A094" : "#fff", border: `2px solid #000`, fontSize: 15, fontWeight: 900, color: remain === 0 ? "#fff" : "#000", marginTop: 6, letterSpacing: .5 }}>
                    <span>{remain === 0 ? "✓ BALANCED" : remain > 0 ? "REMAINING" : "OVER BY"}</span>
                    <span>₹{Math.abs(remain).toLocaleString("en-IN")}</span>
                  </div>
                </div>
              );
            })()}

            {paidOnline > 0 && parseInt(amount || "0", 10) > paidOnline && method !== "split" && (
              <div style={{ padding: "10px 12px", borderRadius: 6, background: "#FFD700", border: "2px solid #000", fontSize: 12, color: "#000", marginBottom: 12 }}>
                ⚠️ Additional ₹{(parseInt(amount, 10) - paidOnline).toLocaleString("en-IN")} to collect (₹{paidOnline} paid online)
              </div>
            )}

            {/* EDC bouncer-PIN gate. Only on the pure-Card path so cash/UPI/split
                flows are unaffected. PIN keeps the card machine from firing on
                a phone someone else picked up off the door podium. */}
            {FEATURES.edc && method === "card" && (
              <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: 14, marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: "#000", letterSpacing: 1, fontWeight: 800, marginBottom: 8 }}>💳 EDC CLOUD — BOUNCER PIN</div>
                <div style={{ fontSize: 13, color: "#3D3D3D", marginBottom: 10 }}>
                  We'll push ₹{Math.max(parseInt(amount || "0", 10) - paidOnline, parseInt(amount || "0", 10) || 0).toLocaleString("en-IN")} to the {edcVendorLabel(edcVendor)} machine. Enter your 4-digit PIN to authorise.
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                  {(["razorpay", "pinelabs"] as const).map((v) => {
                    const sel = edcVendor === v;
                    const isVenueDefault = venueDefaultVendor === v;
                    return (
                      <button key={v} type="button"
                        onClick={() => { setEdcVendor(v); setActiveEdcVendor(v); }}
                        style={{ padding: "10px 8px", borderRadius: 6, border: `2px solid #000`, background: sel ? "#FF90E8" : "#fff", color: "#000", fontSize: 13, fontWeight: 800, letterSpacing: .5, cursor: "pointer" }}>
                        {v === "razorpay" ? "RAZORPAY POS" : "PINE LABS"}{isVenueDefault ? " ★" : ""}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="password" inputMode="numeric" autoComplete="off"
                  maxLength={6} value={edcPin}
                  onChange={(e) => setEdcPin(e.target.value.replace(/\D/g, ""))}
                  placeholder="• • • •"
                  style={{ width: "100%", padding: 14, borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 24, letterSpacing: 8, textAlign: "center", outline: "none", boxSizing: "border-box", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}
                />
              </div>
            )}

            <button onClick={handleActivate} disabled={busy}
              style={{ width: "100%", padding: 18, borderRadius: 8, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 17, fontWeight: 900, letterSpacing: 1.2, cursor: "pointer", marginBottom: 10 }}>
              {busy ? "ACTIVATING…" : "⚡ ACTIVATE COVER WALLET"}
            </button>
          </>
        )}

        {err && <div style={{ color: "#FF5733", fontSize: 14, marginBottom: 10, textAlign: "center", fontWeight: 800 }}>{err}</div>}

        <button onClick={onClose}
          style={{ width: "100%", padding: 14, borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 15, fontWeight: 800, letterSpacing: 1, cursor: "pointer" }}>
          CLOSE
        </button>
      </div>

      {edcTxn && (
        <EDCPaymentDialog
          txnId={edcTxn.txnId}
          vendor={edcTxn.vendor}
          amount={edcTxn.dueAmount}
          customerName={booking.name || "Guest"}
          // "Retry on machine" — only enabled when we still have the input
          // snapshot from the original dispatch. Re-runs startEdcCharge with
          // retry:true so the cloud function bypasses the same-minute
          // idempotency guard and produces a fresh txnId. The dialog then
          // rebinds its Firestore subscription to the new doc.
          canRetry={!!edcRetryArgs}
          onRetry={async () => {
            if (!edcRetryArgs) return { ok: false, errorMessage: "Retry context lost — close and run again." };
            const r = await startEdcCharge({
              bookingId: edcRetryArgs.bookingId,
              bookingRef: edcRetryArgs.bookingRef,
              coverRef: edcRetryArgs.coverRef,
              vendor: edcRetryArgs.vendor,
              bouncerPin: edcRetryArgs.bouncerPin,
              bouncerName: edcRetryArgs.bouncerName,
              expectedAmount: edcRetryArgs.expectedAmount,
              retry: true,
            });
            if (r.ok && r.txnId) {
              setEdcTxn({ txnId: r.txnId, vendor: edcRetryArgs.vendor, dueAmount: edcRetryArgs.dueAmount, fullAmount: edcRetryArgs.fullAmount });
              return { ok: true };
            }
            return { ok: false, errorMessage: r.errorMessage || `EDC retry failed (${r.reason || "error"})` };
          }}
          onSuccess={async (txn) => {
            // Record FULL cover amount on activation (so coverActivated
            // reflects the whole cover incl. any prepaid online portion);
            // the EDC machine only charged the dueAmount.
            const full = edcTxn.fullAmount;
            setEdcTxn(null);
            setEdcRetryArgs(null);
            setBusy(true);
            try {
              await finalizeActivation(full, "card", undefined, txn.edcRef || txn.razorpayPaymentId || txn.pineLabsRef);
            } catch (e: any) {
              setErr(`Card swiped OK but cover write failed: ${e?.message || ""}. Owner can manually activate from admin.`);
            }
            setBusy(false);
          }}
          onFailed={(reason) => {
            setEdcTxn(null);
            setEdcRetryArgs(null);
            setErr(`💳 EDC charge failed: ${reason}. Try cash/UPI or run the card again.`);
          }}
          onCancelled={() => {
            setEdcTxn(null);
            setEdcRetryArgs(null);
            setErr("Card charge cancelled.");
          }}
        />
      )}

      {/* 🆕 2026-05-26 v3.24 (Khushi) — in-app confirm overlay for cover edit.
          Replaces window.confirm so the floor tablet stays inside the HOD UI
          (no alien grey browser popup). Fail-open: tapping the dark backdrop
          OR the gold CANCEL button closes without saving. */}
      {confirmNewAmt != null && existing && (
        <div onClick={(e) => { e.stopPropagation(); setConfirmNewAmt(null); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 10001, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 22, width: "100%", maxWidth: 340, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", boxShadow: "none" }}>
            <div style={{ fontSize: 11, fontWeight: 900, color: "#000", letterSpacing: 1.5, marginBottom: 12, textAlign: "center" }}>⚠️ CONFIRM COVER EDIT</div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 6 }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#6B6B6B", textDecoration: "line-through", fontVariantNumeric: "tabular-nums" }}>₹{(existing.coverActivated || 0).toLocaleString("en-IN")}</div>
              <div style={{ fontSize: 18, color: "#000" }}>→</div>
              <div style={{ fontSize: 26, fontWeight: 900, color: "#000", fontVariantNumeric: "tabular-nums" }}>₹{confirmNewAmt.toLocaleString("en-IN")}</div>
            </div>
            <div style={{ fontSize: 11, color: "#6B6B6B", textAlign: "center", marginBottom: 16, letterSpacing: .3 }}>
              {confirmNewAmt > (existing.coverActivated || 0) ? "COLLECT EXTRA AT DOOR" : "REFUND DIFFERENCE TO GUEST"}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button onClick={() => setConfirmNewAmt(null)} disabled={busy}
                style={{ padding: 14, borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 900, letterSpacing: .5, cursor: "pointer", textTransform: "uppercase" }}>
                CANCEL
              </button>
              <button onClick={doEditSave} disabled={busy}
                style={{ padding: 14, borderRadius: 6, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 900, letterSpacing: .5, cursor: "pointer", textTransform: "uppercase" }}>
                {busy ? "SAVING…" : "YES, CHANGE"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── EDC Payment Dialog ─────────────────────────────────────────────────────
// Full-screen modal that subscribes to Firestore `edcTransactions/{txnId}`
// and reflects live status from the card-swipe machine. States:
//   • pending   — card machine waiting for tap (default; auto-times-out at 60s)
//   • success   — vendor webhook confirmed payment → fires onSuccess(txn)
//   • failed    — card declined / EDC reported error → fires onFailed(reason)
//   • cancelled — bouncer hit Cancel OR vendor webhook reported cancellation
// The dialog NEVER auto-confirms on its own — every transition is driven by
// Firestore writes from the cloud function (which itself only writes after
// HMAC-verifying the vendor webhook). This keeps the door tablet honest:
// no way to forge a "success" by tampering with the browser.
function EDCPaymentDialog({
  txnId, vendor, amount, customerName,
  canRetry, onRetry,
  onSuccess, onFailed, onCancelled,
}: {
  txnId: string;
  vendor: EdcVendor;
  amount: number;
  customerName: string;
  /** When true, the failed/cancelled screens show a "Retry on machine"
   *  button. The parent owns the retry semantics; the dialog just calls
   *  onRetry() and lets the parent re-bind the dialog to the new txnId. */
  canRetry?: boolean;
  onRetry?: () => Promise<{ ok: boolean; errorMessage?: string }>;
  onSuccess: (txn: EdcTransactionDoc) => void;
  onFailed: (reason: string) => void;
  onCancelled: () => void;
}) {
  const [txn, setTxn] = useState<EdcTransactionDoc | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryErr, setRetryErr] = useState("");
  // Local pseudo-status for the client-side timeout — the server may still
  // settle the txn later via webhook, but visually we promote to a failed
  // screen so the operator can use the new Retry button instead of being
  // stranded on the spinning "Tap card" view.
  const [timedOut, setTimedOut] = useState(false);
  const startRef = useRef(Date.now());
  // Guard so the success/failure callback only fires once even if Firestore
  // sends a duplicate snapshot (e.g. metadata-only updates). Reset on retry
  // so the new txn's terminal status fires onSuccess/onFailed normally.
  const settledRef = useRef(false);

  useEffect(() => {
    // Re-arm the settled guard whenever the parent re-binds us to a new
    // txnId (i.e. operator clicked Retry). Without this the second swipe's
    // success snapshot would be dropped because settledRef stayed true.
    settledRef.current = false;
    setTxn(null);
    setElapsedMs(0);
    setRetryErr("");
    setTimedOut(false);
    startRef.current = Date.now();
    const unsub = subscribeToEdcTransaction(txnId, (latest) => {
      if (!latest) return;
      setTxn(latest);
      if (settledRef.current) return;
      // Delay parent callback so the success/failure screen is actually
      // visible before the dialog unmounts.
      if (latest.status === "success") {
        settledRef.current = true;
        setTimeout(() => onSuccess(latest), 2000);
      }
      // Note: failed / cancelled deliberately do NOT auto-fire the parent
      // callback. The new "Retry on machine" UX needs the dialog to stay
      // open so the operator can either tap Retry (which re-binds us to a
      // fresh txnId) or tap Close (which fires onFailed/onCancelled
      // explicitly). Auto-closing here would unmount the dialog mid-tap and
      // make retry unusable in practice.
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txnId]);

  // Tick the countdown and self-cancel after the client-side timeout. The
  // server still owns the source of truth — if a webhook later reports
  // success the cover will be activated by the admin reconciliation job.
  useEffect(() => {
    const t = setInterval(() => {
      const e = Date.now() - startRef.current;
      setElapsedMs(e);
      if (e >= EDC_CLIENT_TIMEOUT_MS && !settledRef.current) {
        // Only promote to TIMEOUT if the server hasn't already reported a
        // terminal status. Otherwise a genuine decline left on screen would
        // get its errorReason overwritten with "TIMEOUT — customer didn't
        // tap in time" the moment the timer crossed 60s.
        const serverStatus = txn?.status;
        if (serverStatus && serverStatus !== "pending") return;
        // Settle locally and best-effort cancel vendor side, but DO NOT
        // unmount the dialog — operator should see the timeout and decide
        // whether to retry or close. The server still owns the source of
        // truth: if a webhook later reports success, the admin reconciliation
        // job will activate the cover.
        settledRef.current = true;
        setTimedOut(true);
        cancelEdcCharge(txnId).catch(() => {});
      }
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txnId]);

  const handleCancel = async () => {
    if (settledRef.current) return;
    if (!window.confirm("Cancel this card charge? If the customer has already tapped, the charge may still go through and admin will reverse it.")) return;
    setCancelling(true);
    settledRef.current = true;
    await cancelEdcCharge(txnId);
    onCancelled();
  };

  const rawStatus = txn?.status || "pending";
  // Promote a client-side timeout to a "failed" view so the operator gets
  // the Retry / Close affordances instead of the spinning Tap-card screen.
  const status: typeof rawStatus = timedOut && rawStatus === "pending" ? "failed" : rawStatus;
  const timeoutReason = "TIMEOUT — customer didn't tap in time";
  const remaining = Math.max(0, Math.ceil((EDC_CLIENT_TIMEOUT_MS - elapsedMs) / 1000));
  const vendorLabel = vendor === "razorpay" ? "Razorpay POS" : "Pine Labs Plutus";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.92)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 26, width: "100%", maxWidth: 380, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: "#000", letterSpacing: 1.5, fontWeight: 900, marginBottom: 14 }}>💳 {vendorLabel} — CARD MACHINE</div>

        <div style={{ fontSize: 36, fontWeight: 900, color: "#000", marginBottom: 4 }}>
          ₹{amount.toLocaleString("en-IN")}
        </div>
        <div style={{ fontSize: 12, color: "#6B6B6B", marginBottom: 22 }}>
          for {customerName}
        </div>

        {status === "pending" && (
          <>
            <div style={{ fontSize: 60, marginBottom: 14, animation: "pulse 1.4s ease-in-out infinite" }}>📡</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#000", marginBottom: 4 }}>Tap card on the EDC machine</div>
            <div style={{ fontSize: 12, color: "#6B6B6B", marginBottom: 18 }}>
              {remaining}s remaining
            </div>
            <div style={{ height: 4, background: "#B0B0B0", borderRadius: 2, overflow: "hidden", marginBottom: 18 }}>
              <div style={{ width: `${Math.min(100, (elapsedMs / EDC_CLIENT_TIMEOUT_MS) * 100)}%`, height: "100%", background: "#FF90E8", transition: "width .25s linear" }} />
            </div>
            <button onClick={handleCancel} disabled={cancelling}
              style={{ width: "100%", padding: 12, borderRadius: 6, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
              {cancelling ? "Cancelling…" : "✕ Cancel"}
            </button>
          </>
        )}

        {status === "success" && (
          <>
            <div style={{ fontSize: 60, marginBottom: 12 }}>✅</div>
            <div style={{ fontSize: 16, fontWeight: 900, color: "#23A094", marginBottom: 4 }}>Approved</div>
            <div style={{ fontSize: 11, color: "#6B6B6B" }}>
              {txn?.cardNetwork || "Card"}{txn?.last4 ? ` ••••${txn.last4}` : ""}
              {txn?.edcRef ? ` · Ref ${txn.edcRef}` : ""}
            </div>
          </>
        )}

        {(status === "failed" || status === "cancelled") && (() => {
          const isFailed = status === "failed";
          // "Retry on machine" — disable if the parent didn't supply onRetry,
          // or while a retry is already in flight, or if the previous retry
          // attempt errored at the dispatch layer (e.g. server still
          // rejected). settledRef will be re-armed once the new txn binds.
          const handleRetry = async () => {
            if (!onRetry || retrying) return;
            setRetrying(true); setRetryErr("");
            // Re-arm settled BEFORE the new subscription binds so the new
            // txn's terminal status doesn't get dropped between the dispatch
            // returning and the parent flipping txnId.
            settledRef.current = false;
            const r = await onRetry();
            setRetrying(false);
            if (!r.ok) {
              // Re-lock so the leftover failed snapshot doesn't immediately
              // re-fire onFailed and unmount us.
              settledRef.current = true;
              setRetryErr(r.errorMessage || "Retry failed");
            }
          };
          return (
            <>
              <div style={{ fontSize: 60, marginBottom: 12 }}>{isFailed ? "❌" : "🚫"}</div>
              <div style={{ fontSize: 14, fontWeight: 900, color: isFailed ? "#FF5733" : "#6B6B6B", marginBottom: 12 }}>
                {isFailed ? (timedOut ? timeoutReason : (txn?.errorReason || "DECLINED")) : "Cancelled"}
              </div>
              {retryErr && (
                <div style={{ fontSize: 11, color: "#FF5733", marginBottom: 10 }}>{retryErr}</div>
              )}
              {canRetry && onRetry && (
                <button onClick={handleRetry} disabled={retrying}
                  style={{ width: "100%", padding: 12, borderRadius: 6, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 800, cursor: retrying ? "wait" : "pointer", marginBottom: 8 }}>
                  {retrying ? "Re-dispatching…" : "🔁 Retry on machine"}
                </button>
              )}
              <button onClick={() => isFailed ? onFailed(timedOut ? timeoutReason : (txn?.errorReason || "DECLINED")) : onCancelled()}
                style={{ width: "100%", padding: 12, borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
                Close
              </button>
            </>
          );
        })()}
      </div>
    </div>
  );
}

// 🔴 2026-05-21 (Khushi) — CheckInPaymentModal
// Opens for EVERY check-in (tickets, guestlist, entry-only, group, table).
// Door girl picks amount + payment method, then wallet activates with that
// amount. Entry-only: wallet is HARD-LOCKED to ₹0 (entry fee is not redeemable
// on F&B), but the amount + method are still recorded for audit.
function CheckInPaymentModal({
  booking, isEntryOnly, source, sourceKey, agentName, onClose, onConfirmed,
}: {
  booking: HodBooking;
  isEntryOnly: boolean;
  source: "booking" | "guestlist" | "table";
  sourceKey: string;
  agentName: string;
  onClose: () => void;
  onConfirmed: (result: { checkedInAt: string; wasNew: boolean }) => void;
}) {
  const isCash = !!(booking.paymentId && booking.paymentId.startsWith("cash_"));
  const paidOnline = isCash ? 0 : (booking.total || 0);
  const defaultAmt = isEntryOnly
    ? String(booking.total || 0)            // record entry-fee collected; wallet stays ₹0
    : String(booking.total || paidOnline || 0);
  const defaultMethod: "cash" | "upi" | "card" | "paid_online" | "split" =
    paidOnline > 0 ? "paid_online" : (booking._isGuestList ? "cash" : "cash");

  const [amount, setAmount] = useState(defaultAmt);
  const [method, setMethod] = useState<"cash" | "upi" | "card" | "paid_online" | "split">(defaultMethod);
  const [splitCash, setSplitCash] = useState("");
  const [splitUpi, setSplitUpi] = useState("");
  const [splitCard, setSplitCard] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const amt = parseInt(amount || "0", 10) || 0;
  const walletAmt = isEntryOnly ? 0 : amt;   // ⚡ HARD LOCK for entry-only

  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      // Validation
      if (method === "split" && !isEntryOnly && walletAmt > 0) {
        const c = parseInt(splitCash || "0", 10) || 0;
        const u = parseInt(splitUpi || "0", 10) || 0;
        const cd = parseInt(splitCard || "0", 10) || 0;
        const total = c + u + cd + paidOnline;
        if (total !== walletAmt) {
          throw new Error(`Split total ₹${total} must equal wallet ₹${walletAmt}`);
        }
      }

      // STEP 1 — check in (always runs first; this is the critical move).
      // ⚠️ Pass "table" through as-is — it's the ONLY source that updates
      // tableReservations.actualArrivalTime. Coercing to "booking" would
      // mark the wrong doc and the Tables tab "Arrived" counter would never
      // move. (architect flagged 2026-05-21)
      const { checkedInAt, wasNew } = await checkInGuest(sourceKey, source, agentName);

      // STEP 2 — wallet (fail-open: errors here do NOT block the check-in)
      try {
        if (walletAmt > 0 && !isEntryOnly) {
          // Real wallet activation
          const split = method === "split" ? {
            cash: parseInt(splitCash || "0", 10) || 0,
            upi: parseInt(splitUpi || "0", 10) || 0,
            card: parseInt(splitCard || "0", 10) || 0,
            paid_online: paidOnline,
          } : undefined;
          await activateCoverForBooking({
            booking,
            amount: walletAmt,
            paymentMethod: method,
            paymentSplit: split,
            staffName: agentName,
          });
        } else {
          // ₹0 wallet stub (entry-only OR door girl typed 0)
          const mintSource: "booking" | "guestlist" =
            source === "guestlist" ? "guestlist" : "booking";
          await ensureZeroBalanceCoverForGuest({
            bookingRef: booking.ref || booking.id,
            sourceDocId: booking.id || booking.ref,
            name: booking.name || "Guest",
            phone: booking.phone || "",
            source: mintSource,
            eventId: (booking as any).eventId || "",
            eventTitle: booking.eventTitle || "",
            staffName: agentName,
          });
        }
      } catch (walletErr: any) {
        // Wallet failed but check-in succeeded — log + let user retry via ACTIVATE COVER
        console.warn("[CheckInPaymentModal] wallet write failed (non-fatal)", walletErr);
      }

      // 🆕 2026-05-26 (Khushi) — RECHARGE SUCCESS POPUP. Mirrors the walk-in
      // flow's confirmation feel — door girl MUST see a clear ✅ popup before
      // the check-in modal closes so she's never unsure if the wallet went
      // through. Fires for every hodclub.in booking kind:
      //   • BUY COVERS / TABLE  → "✅ WALLET LIVE · ₹X READY"
      //   • ENTRY-ONLY          → "✅ CHECKED IN · ENTRY ₹X COLLECTED (wallet ₹0)"
      //   • GUESTLIST           → "✅ CHECKED IN · ₹0 WALLET CREATED"
      // FAIL-OPEN: if the centeredAlert helper throws (SSR / no DOM) it falls
      // back to window.alert — never blocks the check-in completion.
      try {
        const guestName = (booking.name || "GUEST").toUpperCase();
        if (walletAmt > 0 && !isEntryOnly) {
          const collectMsg = method === "split"
            ? `COLLECT: ${splitCash ? `₹${splitCash} CASH ` : ""}${splitUpi ? `+ ₹${splitUpi} UPI ` : ""}${splitCard ? `+ ₹${splitCard} CARD` : ""}`.trim()
            : method === "paid_online"
              ? "ALREADY PAID ONLINE — NOTHING TO COLLECT."
              : `COLLECT ₹${walletAmt} ${method === "cash" ? "CASH" : method === "upi" ? "UPI" : "CARD"}.`;
          await centeredAlert(
            "RECHARGE SUCCESSFUL",
            `✅ ${guestName} CHECKED IN.\n\nWALLET LIVE · ₹${walletAmt.toLocaleString("en-IN")}\n100% REDEEMABLE ON FOOD & DRINKS.\n\n${collectMsg}`,
            "success",
            true,
          );
        } else if (isEntryOnly) {
          await centeredAlert(
            "CHECK-IN SUCCESSFUL",
            `✅ ${guestName} CHECKED IN.\n\nENTRY FEE ₹${amt.toLocaleString("en-IN")} ${method === "paid_online" ? "ALREADY PAID ONLINE" : `COLLECTED (${method.toUpperCase()})`}.\n\nWALLET ₹0 · GUEST CAN TOP UP AT BAR ANYTIME.`,
            "success",
            true,
          );
        } else {
          await centeredAlert(
            "CHECK-IN SUCCESSFUL",
            `✅ ${guestName} CHECKED IN.\n\nWALLET ₹0 CREATED · GUEST CAN TOP UP AT BAR / PHONE.`,
            "success",
            true,
          );
        }
      } catch (alertErr) {
        console.warn("[CheckInPaymentModal] success alert failed (non-fatal)", alertErr);
      }

      onConfirmed({ checkedInAt, wasNew });
    } catch (e: any) {
      setErr(e?.message || "Check-in failed");
      setBusy(false);
    }
  };

  // 🆕 2026-06-08 (Khushi) — PORTAL to <body>. This modal is rendered inside
  // BookingDetailModal, whose overlay uses `backdrop-filter`; a CSS-fixed child
  // of a backdrop-filter/transform ancestor is positioned relative to THAT
  // ancestor, not the viewport — so the overlay couldn't cover the whole screen
  // and appeared as a black box overlapping the ticket modal underneath.
  // Portaling to document.body lets `position:fixed` cover the full viewport,
  // dim the ticket modal cleanly, and centre the white check-in card.
  return createPortal(
    <div onClick={() => { if (!busy) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.62)", zIndex: 4000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, backdropFilter: "blur(4px)" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 440, background: "#FFFFFF", border: "2px solid #000", borderRadius: 14, padding: 22, maxHeight: "92vh", overflowY: "auto", boxShadow: "0 24px 60px rgba(0,0,0,.45)" }}>
        <BackBtn onClick={onClose} disabled={busy} />
        <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontSize: 20, fontWeight: 900, color: "#000", marginBottom: 4 }}>
          ✅ CHECK IN
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#000", marginBottom: 2 }}>{booking.name || "Guest"}</div>
        <div style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 14 }}>
          {booking.ref}{booking.phone ? ` · ${booking.phone}` : ""}
        </div>

        {isEntryOnly && (
          <div style={{ background: "#FFD700", border: "2px solid #000", borderRadius: 8, padding: 10, marginBottom: 14, fontSize: 12, color: "#000", fontWeight: 700, lineHeight: 1.4 }}>
            ⚠️ ENTRY-ONLY TICKET — WALLET WILL BE ₹0<br/>
            <span style={{ fontWeight: 500, fontSize: 11 }}>
              Type the entry fee below for audit (e.g. ₹599) and pick payment method.
              Wallet is NOT redeemable on F&B.
            </span>
          </div>
        )}

        {paidOnline > 0 && !isEntryOnly && (
          <div style={{ background: "#23A094", border: "2px solid #000", borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 14, color: "#fff", fontWeight: 800, letterSpacing: .5 }}>
            ✅ ₹{paidOnline.toLocaleString("en-IN")} ALREADY PAID ONLINE
          </div>
        )}

        <div style={{ fontSize: 13, fontWeight: 800, color: "#000", letterSpacing: 1.5, marginBottom: 8 }}>
          {isEntryOnly ? "ENTRY FEE COLLECTED (₹)" : "WALLET AMOUNT (₹)"}
        </div>
        <input type="number" inputMode="numeric" value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
          style={{ width: "100%", padding: "16px 16px", borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 26, fontWeight: 900, outline: "none", marginBottom: 16, boxSizing: "border-box", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }} />

        {isEntryOnly && amt > 0 && (
          <div style={{ fontSize: 13, color: "#000", marginBottom: 12, marginTop: -8, fontWeight: 700 }}>
            ↳ Wallet activates at ₹0 · entry fee ₹{amt} logged for audit only.
          </div>
        )}

        <div style={{ fontSize: 13, fontWeight: 800, color: "#000", letterSpacing: 1.5, marginBottom: 10 }}>PAYMENT METHOD</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
          {([
            { id: "cash" as const, label: "💵 CASH" },
            { id: "upi" as const, label: "📱 UPI" },
            { id: "card" as const, label: "💳 CARD" },
            { id: "paid_online" as const, label: "✅ PAID ONLINE" },
          ]).map((pm) => {
            const sel = method === pm.id;
            return (
              <button key={pm.id} type="button" onClick={() => setMethod(pm.id)}
                style={{ padding: "14px 10px", borderRadius: 6, border: `2px solid #000`, background: sel ? "#FF90E8" : "#fff", color: "#000", fontSize: 15, fontWeight: 900, letterSpacing: 1, cursor: "pointer" }}>
                {pm.label}
              </button>
            );
          })}
        </div>
        <button type="button" onClick={() => setMethod("split")}
          style={{ width: "100%", padding: "14px 10px", borderRadius: 6, border: `2px solid #000`, background: method === "split" ? "#FF90E8" : "#fff", color: "#000", fontSize: 15, fontWeight: 900, letterSpacing: 1, cursor: "pointer", marginBottom: 14 }}>
          ➗ SPLIT PAYMENT
        </button>

        {method === "split" && (() => {
          const c = parseInt(splitCash || "0", 10) || 0;
          const u = parseInt(splitUpi || "0", 10) || 0;
          const cd = parseInt(splitCard || "0", 10) || 0;
          const total = c + u + cd + paidOnline;
          const target = isEntryOnly ? amt : walletAmt;
          const remain = target - total;
          return (
            <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: 14, marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: "#000", marginBottom: 10, fontWeight: 800, letterSpacing: 1 }}>SPLIT (MUST TOTAL ₹{target})</div>
              {paidOnline > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 12px", borderRadius: 8, background: "#23A094", border: "2px solid #000", fontSize: 14, color: "#fff", marginBottom: 8, fontWeight: 800 }}>
                  <span>✅ PAID ONLINE (LOCKED)</span><span>₹{paidOnline}</span>
                </div>
              )}
              {([
                { lbl: "💵 CASH", val: splitCash, set: setSplitCash },
                { lbl: "📱 UPI", val: splitUpi, set: setSplitUpi },
                { lbl: "💳 CARD", val: splitCard, set: setSplitCard },
              ]).map((row) => (
                <div key={row.lbl} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 14, color: "#000", fontWeight: 800, minWidth: 90, letterSpacing: .5 }}>{row.lbl}</span>
                  <input type="number" inputMode="numeric" value={row.val} onChange={(e) => row.set(e.target.value)} placeholder="0"
                    style={{ padding: "12px 12px", borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 18, fontWeight: 800, outline: "none", textAlign: "right", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }} />
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 12px", borderRadius: 8, background: remain === 0 ? "#23A094" : "#fff", border: `2px solid #000`, fontSize: 15, fontWeight: 900, color: remain === 0 ? "#fff" : "#000", marginTop: 6, letterSpacing: .5 }}>
                <span>{remain === 0 ? "✓ BALANCED" : remain > 0 ? "REMAINING" : "OVER BY"}</span>
                <span>₹{Math.abs(remain).toLocaleString("en-IN")}</span>
              </div>
            </div>
          );
        })()}

        {err && <div style={{ color: "#FF5733", fontSize: 14, marginBottom: 12, textAlign: "center", fontWeight: 800 }}>⚠️ {err}</div>}

        <button onClick={handleConfirm} disabled={busy}
          style={{ width: "100%", padding: 18, borderRadius: 8, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 17, fontWeight: 900, cursor: busy ? "wait" : "pointer", marginBottom: 10, letterSpacing: 1.2 }}>
          {busy ? "CHECKING IN…" : `✅ CONFIRM CHECK-IN${walletAmt > 0 ? ` · ₹${walletAmt} WALLET` : isEntryOnly ? " · ₹0 WALLET" : ""}`}
        </button>
        <button onClick={onClose} disabled={busy}
          style={{ width: "100%", padding: 14, borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 15, fontWeight: 800, letterSpacing: 1, cursor: "pointer" }}>
          ✗ CANCEL
        </button>
      </div>
    </div>,
    document.body
  );
}

function LookupResult({ booking, agentName, onDone: _onDone, hideIdentity, cover, tableIdOverride }: { booking: HodBooking; agentName: string; onDone: () => void; hideIdentity?: boolean; cover?: HodCover | null; tableIdOverride?: string }) {
  // 🆕 2026-05-27 v3.51 (Khushi LIVE-NIGHT) — table bookings track arrival on
  // `tableReservations.actualArrivalTime` / `arrived` / `coverActivated`, NOT
  // on `booking.checkedIn`. v3.50 lookupBooking now passes `checkedIn` through
  // for tables; this fallback also flips `done` true the moment the live
  // cover subscription reports `coverActivated > 0` (covers the case where
  // door activated the cover from a row tap in the TABLES tab while the
  // modal is still open from a stale scan).
  const _tableAlreadyArrived = !!(
    (booking as any)._isTable && (
      (booking as any)._arrived
      || (booking as any)._actualArrivalTime
      || Number((booking as any)._coverActivated || 0) > 0
    )
  );
  const [done, setDone] = useState(booking.checkedIn || _tableAlreadyArrived || false);
  const [err, setErr] = useState("");
  const [showCheckInModal, setShowCheckInModal] = useState(false);
  // 🆕 2026-05-27 v3.102 (Khushi) — BUY COVERS "Ladies Free" (entryType "female",
  // price 0) is functionally a free entry. Show the same FREE ENTRY flow as
  // guestlist (v3.99) instead of opening the payment modal — there's nothing
  // to charge. ACTIVATE COVER stays as a sibling for the case where door girl
  // wants to collect cover anyway. Paid BUY COVERS (Stag/Couple) are UNCHANGED.
  const [showFreeConfirm, setShowFreeConfirm] = useState(false);
  const [freeBusy, setFreeBusy] = useState(false);
  const { toast } = useToast();
  // Cross-collection search may surface an aggregator booking that has not
  // yet been assigned a table (auto-assign still pending or flagged for
  // manual review). For those we cannot run checkInGuest — there is no
  // tableReservation to mutate. Show a clear notice instead.
  const pendingAssignment = (booking as CrossSourceBooking)._pendingAssignment === true;
  const aggLabel = (booking as CrossSourceBooking)._aggregator;

  // Sync local "done" with subscription updates (so list-row check-ins reflect here too)
  useEffect(() => { if (booking.checkedIn) setDone(true); }, [booking.checkedIn]);
  // v3.51: live cover subscription → coverActivated > 0 also flips done.
  useEffect(() => {
    if ((booking as any)._isTable && Number(cover?.coverActivated || 0) > 0) setDone(true);
  }, [cover?.coverActivated, booking]);

  const isCash = !!(booking.paymentId && booking.paymentId.startsWith("cash_"));
  const isGuestList = !!booking._isGuestList;
  const paidOnline = isGuestList ? 0 : (isCash ? 0 : (booking.total || 0));
  const payAtVenue = isCash ? (booking.total || 0) : 0;

  // 🔴 2026-05-21 (Khushi) — Check-in now opens CheckInPaymentModal instead
  // of running silently. Door girl picks amount + payment method, then
  // wallet activates with that amount (₹0 for entry-only).
  const isModalTable = !!(booking as any).tableType || (booking as any).bookMode === "group";
  const ciSource: "booking" | "guestlist" | "table" =
    (booking._isTable || isModalTable) ? "table" : booking._isGuestList ? "guestlist" : "booking";
  const ciKey = ciSource === "booking" ? (booking.id || booking.ref) : (booking.ref || booking.id);
  const isEntryOnly = isOnlyEntryBooking(booking);

  // 🆕 2026-05-27 v3.102 — Ladies Free detection. Customer site (hodclub-patched
  // /index.html ~line 2599) sets `entryType: 'female'` on the BUY COVERS Ladies
  // option, which is always price 0. NOT guestlist (those start with
  // 'guestlist_'), NOT a table. We additionally require total === 0 as belt-
  // and-braces in case future paid 'female' tiers ever ship.
  const _entryTypeLc = String((booking as any).entryType || "").toLowerCase();
  // Architect-flagged tightening: also exclude any record that smells like a
  // table (tableType set OR bookMode==='group') — mirrors `isModalTable` below
  // so future table-shaped 'female' records can never accidentally land here.
  const _smellsLikeTable = !!(booking as any).tableType || (booking as any).bookMode === "group";
  const isLadiesFreeCovers =
    !booking._isGuestList
    && !(booking as any)._isTable
    && !_smellsLikeTable
    && (_entryTypeLc === "female" || _entryTypeLc === "ladies")
    && Number(booking.total || 0) === 0;

  const handleLadiesFreeEntry = async () => {
    if (freeBusy) return;
    setFreeBusy(true);
    try {
      const docId = booking.id || booking.ref;
      const refKey = booking.ref || booking.id;
      await ensureZeroBalanceCoverForGuest({
        bookingRef: refKey,
        sourceDocId: docId,
        name: booking.name || "Guest",
        phone: booking.phone || "",
        source: "booking",
        eventId: booking.eventId || "",
        eventTitle: booking.eventTitle || "",
        staffName: agentName,
      });
      // Mirror is best-effort inside ensureZeroBalance; call checkInGuest too so
      // the bookings doc gets checkedInBy=agentName (mirror writes a generic
      // "(bar wallet open)" suffix). Idempotent — already-checked-in returns wasNew=false.
      await checkInGuest(docId, "booking", agentName).catch(() => {});
      setDone(true);
      setShowFreeConfirm(false);
      toast({
        title: `🎁 Free entry: ${booking.name || "Guest"}`,
        description: "₹0 wallet activated · checked in. Customer can top up at the bar or via hodclub.in.",
        duration: 6000,
      });
    } catch (e: any) {
      toast({ title: "Free entry failed", description: e?.message || "Try again", variant: "destructive" });
    }
    setFreeBusy(false);
  };

  const openCheckInModal = () => {
    if (done) {
      toast({ title: `Already checked in: ${booking.name || "Guest"}`, description: "No action taken.", duration: 3000 });
      return;
    }
    // 🆕 2026-05-27 v3.73 (Khushi LIVE-NIGHT) — scanner table-assigned gate.
    // Khushi 7:30am: scanned a TABLE OF 4 (HODTAB) QR → tapped CHECK IN +
    // ACTIVATE COVER without assigning a table → cover went live with no
    // table id → captain has no floor-map tile, no chime, can't take orders.
    // Same root cause as v3.68 (captain ADD ORDER) and v3.71 (handleArrived).
    // Block here when this is a TABLE booking with no tableId assigned.
    // Walk-in / guestlist / entry-only HODTIC unchanged (no _isTable flag).
    const _isTbl = !!((booking as any)._isTable || (booking as any).tableType || (booking as any).bookMode === "group");
    // 🆕 v3.88 — tableIdOverride wins (set by BookingDetailModal after door
    // girl successfully reassigns from within this same modal). Without this
    // override the booking prop stays frozen with tableId="" and the gate
    // fires forever even though Firestore has been updated.
    // 🆕 2026-05-27 v3.91 (Khushi LIVE-NIGHT) — TBL-KDMCK gate misfire fix.
    // Customer-side TBL- bookings store the chosen table on the
    // tableReservation as `tableId` (e.g. "FD5"); lookupBooking surfaces it
    // on the booking shim as `_tableId` (underscore). The gate was only
    // reading `.tableId`, so every customer-pre-chosen TBL- table fell
    // through to "PLEASE ASSIGN THE TABLE FIRST" even though FD5 was
    // already locked in at booking time. Fall back to `_tableId` too.
    const _effectiveTableId = String(tableIdOverride || (booking as any).tableId || (booking as any)._tableId || "").trim();
    if (_isTbl && !_effectiveTableId) {
      showAppAlert(
        "This is a TABLE BOOKING but no table has been assigned yet — tap REASSIGN TABLE below (or pick a table from the floor map) BEFORE you check the guest in.\n\nThe captain needs a table to take orders, route KOTs, and print the bill.",
        "🪑 PLEASE ASSIGN THE TABLE FIRST"
      );
      return;
    }
    setErr("");
    setShowCheckInModal(true);
  };

  const handleModalConfirmed = ({ checkedInAt, wasNew }: { checkedInAt: string; wasNew: boolean }) => {
    setShowCheckInModal(false);
    setDone(true);
    if (wasNew) {
      toast({
        title: `✅ Checked in: ${booking.name || "Guest"}`,
        description: "Tap Undo within 30 seconds if this was a mistake.",
        duration: 30000,
        action: (
          <ToastAction altText="Undo check-in" onClick={async () => {
            try {
              const r = await checkInGuest(ciKey, ciSource, agentName, true, checkedInAt);
              if (r.undone) {
                setDone(false);
                toast({ title: "↩️ Check-in reversed", duration: 4000 });
              } else {
                toast({ title: "Cannot undo", description: "Record was modified — ask a manager.", variant: "destructive", duration: 6000 });
              }
            } catch (e: any) {
              toast({ title: "Undo failed", description: e?.message || "Try the admin dashboard", variant: "destructive" });
            }
          }}>Undo</ToastAction>
        ),
      });
    } else {
      toast({ title: `Already checked in: ${booking.name || "Guest"}`, description: "No new action taken.", duration: 4000 });
    }
  };

  // 🆕 2026-05-26 v3.20 (Khushi) — when embedded in BookingDetailModal
  // (hideIdentity=true) drop the outer card chrome so the layout matches
  // the guestlist modal exactly: PENDING pill → structured list box →
  // green CHECK IN GUEST button → action grid (no box-within-a-box).
  // Standalone search-row callers keep the outer card.
  const containerStyle: React.CSSProperties = hideIdentity
    ? { marginBottom: 4 }
    : { background: "#FFFFFF", border: "2px solid #000", borderRadius: 8, padding: 20, marginBottom: 16 };
  return (
    <div style={containerStyle}>
      {/* 🆕 2026-05-26 (Khushi) — when embedded inside BookingDetailModal,
          skip the duplicate name/ref/phone row (modal header already shows
          it boldly). Just float the CHECKED IN / PENDING badge to the right
          so the door girl never loses the status. */}
      {hideIdentity ? (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
          {done ? (
            <span style={{ background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 11, fontWeight: 800, padding: "4px 10px", borderRadius: 6, whiteSpace: "nowrap" }}>✅ CHECKED IN</span>
          ) : (
            <span style={{ background: "#FFD700", border: "2px solid #000", color: "#000", fontSize: 11, fontWeight: 800, padding: "4px 10px", borderRadius: 6 }}>PENDING</span>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: "#000", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{booking.name || "Guest"}</div>
            <div style={{ fontSize: 12, color: "#6B6B6B", marginTop: 2 }}>{booking.ref} · {booking.phone}</div>
          </div>
          {done ? (
            <span style={{ background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 11, fontWeight: 800, padding: "4px 10px", borderRadius: 6, whiteSpace: "nowrap" }}>✅ CHECKED IN</span>
          ) : (
            <span style={{ background: "#FFD700", border: "2px solid #000", color: "#000", fontSize: 11, fontWeight: 800, padding: "4px 10px", borderRadius: 6 }}>PENDING</span>
          )}
        </div>
      )}

      {/* 🆕 2026-05-26 (Khushi) — STRUCTURED INFO LIST. Replaces the loose
          category-row card with a "label → value" list so even a brand-new
          door girl reads the booking at a glance:
            EVENT NAME, NAME, REFERENCE, PHONE, TICKET TYPE, QTY, PAYMENT.
          Font: Space Grotesk (matches the customer menu scanner — Khushi
          loves it). NO Playfair cursive anywhere here. Bigger sizes (14–17px).
          Colors: muted-ivory labels, white values, gold/green/amber accents. */}
      {(() => {
        const desc = describeBooking(booking);
        // 🆕 2026-05-26 v3.18 (Khushi) — PAYMENT must reflect what was ACTUALLY
        // collected, not the original booking total. Customer booked Stag
        // "Pay at venue ₹500" but at the door the girl activated a ₹999 cover
        // and collected ₹999. So once the cover is activated, show
        // "✓ COVER ACTIVATED · ₹{coverActivated}" — that's the real money
        // taken. Only fall back to ticket amounts if cover is NOT yet active.
        const coverActivated = Number(cover?.coverActivated || 0);
        // 🆕 2026-05-26 v3.21 (Khushi) — ENTRY-ONLY tickets are a special case.
        // The entry charge (e.g. ₹599) is what the door collects at check-in
        // and is the BASELINE payment. If the door girl then ALSO activates
        // a cover on top, both amounts matter — show ENTRY + COVER together,
        // never let the cover hide the entry collection. For non-entry tickets,
        // keep v3.18 behavior (cover replaces the ticket amount).
        // 🆕 2026-06-12 (Khushi) — entry fee must EXCLUDE the cover. For an
        // entry-only booking that ALSO carries a cover wallet, `booking.total`
        // is the COMBINED amount collected (entry + cover) — both the door
        // walk-in flow (total = coverAmount + entryTicket) and an online
        // entry-only booking that had a cover added at the door write it this
        // way. So the non-redeemable ENTRY portion = total − coverActivated.
        // (Cover ₹0 → entryAmt = total, unchanged.) Was showing ₹799 ENTRY
        // for a ₹599 entry + ₹200 cover.
        const entryAmt = isEntryOnly ? Math.max(0, (booking.total || 0) - coverActivated) : 0;
        const paymentLabel = (() => {
          if (isEntryOnly && entryAmt > 0) {
            // Entry-only ticket: entry charge is the primary payment.
            // Treat as PAID once the guest is checked in OR the booking was paid online.
            const entryPaid = done || paidOnline > 0;
            if (entryPaid && coverActivated > 0) {
              return { txt: `✓ PAID ₹${entryAmt.toLocaleString("en-IN")} ENTRY  +  ✓ COVER ₹${coverActivated.toLocaleString("en-IN")}`, color: "#fff", bg: "#23A094", bd: "#000" };
            }
            if (entryPaid) {
              return { txt: `✓ PAID ₹${entryAmt.toLocaleString("en-IN")} ENTRY`, color: "#fff", bg: "#23A094", bd: "#000" };
            }
            // Not yet checked in → original PAY AT VENUE / PAID ONLINE
            return payAtVenue > 0
              ? { txt: `💵 PAY AT VENUE · ₹${payAtVenue.toLocaleString("en-IN")}`, color: "#000", bg: "#FFD700", bd: "#000" }
              : { txt: `✓ PAID ONLINE · ₹${entryAmt.toLocaleString("en-IN")}`, color: "#fff", bg: "#23A094", bd: "#000" };
          }
          if (coverActivated > 0) {
            // 🆕 v3.86 — pre-paid table that hasn't physically arrived yet:
            // amber "PRE-PAID · AWAITING ARRIVAL", not green "ACTIVATED".
            // Triggers when this is a HODTAB / TBL- / AGG- table booking
            // (tablePrePaid flag set on covers at booking time) AND the door
            // hasn't marked the guest arrived. Green only once they're in.
            const _isPrePaidTable = !!((booking as any)._isTable) && !!((cover as any)?.tablePrePaid || (booking as any)._tablePrePaid);
            const _physicallyArrived = !!(booking as any)._arrived || !!booking.checkedIn;
            if (_isPrePaidTable && !_physicallyArrived) {
              return { txt: `💳 PRE-PAID · ₹${coverActivated.toLocaleString("en-IN")} (AWAITING ARRIVAL)`, color: "#000", bg: "#FFD700", bd: "#000" };
            }
            return { txt: `✓ COVER ACTIVATED · ₹${coverActivated.toLocaleString("en-IN")}`, color: "#fff", bg: "#23A094", bd: "#000" };
          }
          if (isGuestList) {
            return { txt: "🎁 GUEST LIST · FREE ENTRY", color: "#3D3D3D", bg: "#fff", bd: "#000" };
          }
          if (payAtVenue > 0) {
            return { txt: `💵 PAY AT VENUE · ₹${payAtVenue.toLocaleString("en-IN")}`, color: "#000", bg: "#FFD700", bd: "#000" };
          }
          if (paidOnline > 0) {
            return { txt: `✓ PAID ONLINE · ₹${paidOnline.toLocaleString("en-IN")}`, color: "#fff", bg: "#23A094", bd: "#000" };
          }
          return { txt: "— NO PAYMENT —", color: "#6B6B6B", bg: "#fff", bd: "#000" };
        })();
        const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
          <div style={{ display: "grid", gridTemplateColumns: "115px 1fr", gap: 10, padding: "10px 0", borderBottom: "2px solid #000", alignItems: "center" }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, color: "#6B6B6B", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>{label}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#000", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", wordBreak: "break-word" }}>{children}</div>
          </div>
        );
        return (
          <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: "4px 14px", marginBottom: 14, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
            {booking.eventTitle && (
              <Row label="EVENT">
                <span style={{ color: "#000" }}>🎵 {booking.eventTitle}</span>
              </Row>
            )}
            <Row label="NAME">{booking.name || "—"}</Row>
            {booking.ref && (
              <Row label="REF #">
                <span style={{ fontFamily: "monospace", color: "#000", letterSpacing: .5 }}>#{booking.ref}</span>
              </Row>
            )}
            {booking.phone && (
              <Row label="PHONE">
                {/* 🆕 2026-05-27 v3.91 (Khushi LIVE-NIGHT) — customer site
                    stores phone as "+91 9611111261" (cc + ' ' + digits) so
                    re-prepending "+91 " here printed "+91 +91 9611111261".
                    Strip any leading +91 / 91 / spaces, then re-prefix once. */}
                <span style={{ color: "#000" }}>📞 +91 {String(booking.phone || "").replace(/^\s*(?:\+?91)?[\s-]*/, "")}</span>
              </Row>
            )}
            <Row label="TICKET TYPE">
              <span style={{ background: "#fff", border: "2px solid #000", color: desc.categoryColor, fontSize: 13, fontWeight: 900, padding: "4px 12px", borderRadius: 6, letterSpacing: .6, display: "inline-block" }}>
                {desc.category}
              </span>
            </Row>
            <Row label="QUANTITY">
              <span style={{ fontSize: 17, fontWeight: 900, color: "#000" }}>{desc.breakdown}</span>
            </Row>
            {booking.tier && (
              <Row label="TIER">
                <span style={{ color: "#000" }}>{booking.tier}</span>
              </Row>
            )}
            <Row label="PAYMENT">
              <span style={{ background: paymentLabel.bg, border: `2px solid ${paymentLabel.bd}`, color: paymentLabel.color, fontSize: 14, fontWeight: 900, padding: "6px 12px", borderRadius: 6, letterSpacing: .5, display: "inline-block" }}>
                {paymentLabel.txt}
              </span>
            </Row>
          </div>
        );
      })()}

      {err && (
        <div style={{ background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 12, padding: 10, borderRadius: 6, marginBottom: 10 }}>
          ⚠️ {err}
        </div>
      )}

      {pendingAssignment && (
        <div style={{ background: "#fff", border: "2px solid #000", color: "#3D3D3D", fontSize: 12, padding: 10, borderRadius: 6, marginBottom: 10, fontWeight: 700 }}>
          ⏳ {aggLabel?.toUpperCase() || "AGGREGATOR"} booking — table not yet assigned. Open Captain Mode to assign a table, then check the guest in.
        </div>
      )}

      {!done && !pendingAssignment && (
        // 🆕 2026-05-27 v3.102 (Khushi) — Ladies Free BUY COVERS swaps the
        // primary CTA to FREE ENTRY (matches the guestlist v3.99 pattern).
        // Everything else (Stag/Couple BUY COVERS, entry-only, tables, etc.)
        // keeps the existing CHECK IN GUEST → payment modal flow.
        isLadiesFreeCovers ? (
          <button onClick={() => setShowFreeConfirm(true)} disabled={freeBusy}
            style={{ width: "100%", padding: 16, borderRadius: 8, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 16, fontWeight: 900, cursor: "pointer", letterSpacing: .4, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", boxShadow: "none" }}>
            {freeBusy ? "ACTIVATING…" : "🎁 FREE ENTRY"}
          </button>
        ) : (
          <button onClick={openCheckInModal}
            style={{ width: "100%", padding: 16, borderRadius: 8, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 16, fontWeight: 900, cursor: "pointer", letterSpacing: .4, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", boxShadow: "none" }}>
            ✅ CHECK IN GUEST
          </button>
        )
      )}

      {showCheckInModal && (
        <CheckInPaymentModal
          booking={booking}
          isEntryOnly={isEntryOnly}
          source={ciSource}
          sourceKey={ciKey}
          agentName={agentName}
          onClose={() => setShowCheckInModal(false)}
          onConfirmed={handleModalConfirmed}
        />
      )}

      {/* 🆕 2026-05-27 v3.102 (Khushi) — in-app FREE ENTRY confirm overlay
          for Ladies Free BUY COVERS. Mirrors the v3.99 guestlist overlay
          (no alien browser popup). zIndex 10001 so it sits above the
          BookingDetailModal (zIndex 100). Backdrop tap = cancel (gated
          by freeBusy so it can't dismiss mid-activation). */}
      {showFreeConfirm && (
        <div onClick={() => { if (!freeBusy) setShowFreeConfirm(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", zIndex: 10001, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 22, width: "100%", maxWidth: 360, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", boxShadow: "none" }}>
            <div style={{ fontSize: 11, fontWeight: 900, color: "#000", letterSpacing: 1.5, marginBottom: 14, textAlign: "center" }}>🎁 CONFIRM FREE ENTRY</div>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#000", textAlign: "center", marginBottom: 4 }}>
              {booking.name || "Guest"}
            </div>
            <div style={{ fontSize: 12, color: "#6B6B6B", textAlign: "center", marginBottom: 16, letterSpacing: .4 }}>
              BUY COVERS · LADIES · FREE
            </div>
            <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: 12, marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: "#000", lineHeight: 1.55 }}>
                ✅ Activate ₹0 wallet for the customer<br/>
                ✅ Mark guest checked-in
              </div>
              <div style={{ fontSize: 11, color: "#6B6B6B", marginTop: 8, fontStyle: "italic" }}>
                Tap ACTIVATE COVER instead if you want to collect cover at door.
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button onClick={() => setShowFreeConfirm(false)} disabled={freeBusy}
                style={{ padding: 14, borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 900, letterSpacing: .5, cursor: "pointer", textTransform: "uppercase" }}>
                CANCEL
              </button>
              <button onClick={handleLadiesFreeEntry} disabled={freeBusy}
                style={{ padding: 14, borderRadius: 6, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 13, fontWeight: 900, letterSpacing: .5, cursor: "pointer", textTransform: "uppercase", boxShadow: "none" }}>
                {freeBusy ? "ACTIVATING…" : "YES, FREE ENTRY"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const TODAY_STR = () => getOperationalNightStr();
// Calendar date in IST (not shifted). Before noon IST this differs from TODAY_STR,
// because getOperationalNightStr subtracts 12h so it still returns yesterday.
// Bookings from hodclub.in use ev.date (calendar date), so we must match both.
const CALENDAR_TODAY_STR = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
// 🆕 2026-05-30 v3.143 — RCB go-live: surface NEXT-DAY (e.g. 31 May final) TABLE
// reservations in Door Mode + Boss views. Scoped DELIBERATELY to table rosters:
// TABLE_WINDOW_DATES drives the tableReservations subscriptions only. TODAY_DATE_SET
// (Tickets / Guestlist / booking counters) stays TONIGHT-only so tomorrow's
// un-arrived pre-bookings never inflate live door counts (architect-flagged).
// Table views iterate tableResByDate UNFILTERED, so widening only the table subs
// is enough to show them. Reversible: drop CALENDAR_TOMORROW_STR() below.
// (uses addDaysStr below — only invoked at runtime, so the forward ref is safe.)
const CALENDAR_TOMORROW_STR = () => addDaysStr(CALENDAR_TODAY_STR(), 1);
// 🆕 2026-06-02 v3.171 (Khushi) — EVENT TAB 3-NIGHT WINDOW. Tapping a future
// event chip (tomorrow / day-after) must surface THAT night's bookings,
// guestlist & tables — so the data has to be LOADED for those dates. The
// booking / guestlist / table subscriptions now span tonight + the next 2
// nights. The dashboard COUNTERS and the ALL view stay TONIGHT-only
// (TODAY_DATE_SET) — Khushi's choice — so live "arriving tonight" counts never
// inflate; the wider data only becomes VISIBLE once a specific future chip is
// selected (then the view scopes to that event's date via eventDateScope).
const CALENDAR_DAY_AFTER_STR = () => addDaysStr(CALENDAR_TODAY_STR(), 2);
const TABLE_WINDOW_DATES = () => Array.from(new Set([TODAY_STR(), CALENDAR_TODAY_STR(), CALENDAR_TOMORROW_STR(), CALENDAR_DAY_AFTER_STR()]));
// 3-night window for booking / guestlist subscriptions (so a future event's
// pre-bookings are in memory the moment its chip is tapped).
const BOOKING_WINDOW_DATES = () => Array.from(new Set([TODAY_STR(), CALENDAR_TODAY_STR(), CALENDAR_TOMORROW_STR(), CALENDAR_DAY_AFTER_STR()]));
const TODAY_DATE_SET = () => new Set([TODAY_STR(), CALENDAR_TODAY_STR()]);
// Date scope for a tab / counter view: TONIGHT when "all" is selected, else the
// SELECTED EVENT's date (so tapping tomorrow's chip shows tomorrow's roster).
// Falls back to TONIGHT if a selected event has no date (defensive).
const eventDateScope = (selectedEventId: string, selectedEventDate: string): Set<string> =>
  selectedEventId === "all" || !selectedEventDate
    ? TODAY_DATE_SET()
    : new Set([selectedEventDate]);
// 🔴 2026-05-23 (Khushi COST FIX r2) — Add N days to a YYYY-MM-DD string.
// Used to build [from, to) windows for guestlist range queries that cover
// the operational night spanning calendar midnight.
const addDaysStr = (yyyyMmDd: string, days: number): string => {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};

function matchQuery(q: string, ...fields: Array<string | undefined | null>): boolean {
  if (!q) return true;
  const needle = q.toLowerCase().trim();
  const digits = needle.replace(/\D/g, "");
  return fields.some((f) => {
    if (!f) return false;
    const s = String(f).toLowerCase();
    if (s.includes(needle)) return true;
    if (digits && digits.length >= 3) {
      const fd = String(f).replace(/\D/g, "");
      if (fd && fd.includes(digits)) return true;
    }
    return false;
  });
}

// ─── QR Wallet Popup ─────────────────────────────────────────────────────────
// Shown when Meta WhatsApp send fails (template not approved, customer outside
// 24h window, blocked, etc). Floor tablets have no SIM so we can't use wa.me —
// instead the guest scans this QR with their own phone camera and the wallet
// link opens directly. Auto-closes when the customer site writes
// `walletOpenedAt` on covers/{ref} (one-line addition needed on hodclub.in).
function WalletQrModal({
  bookingRef, walletUrl, customerName, reason, onClose,
}: { bookingRef: string; walletUrl: string; customerName: string; reason: string; onClose: () => void; }) {
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [scanned, setScanned] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import("qrcode").then((QR) => {
      QR.toDataURL(walletUrl, { width: 320, margin: 1, color: { dark: "#0a0a0a", light: "#ffffff" } })
        .then((url: string) => { if (!cancelled) setQrDataUrl(url); })
        .catch((e: any) => console.warn("[door][qr] generate failed", e));
    });
    return () => { cancelled = true; };
  }, [walletUrl]);

  // Auto-close on real scan (customer site updates covers/{ref}.walletOpenedAt)
  useEffect(() => {
    if (!bookingRef) return;
    const unsub = subscribeToWalletScan(bookingRef, () => {
      setScanned(true);
      setTimeout(() => onClose(), 1500);
    });
    return unsub;
  }, [bookingRef, onClose]);

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(walletUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard may be blocked in iframe; user can long-press the URL */ }
  };

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 22, width: "100%", maxWidth: 380, color: "#000", textAlign: "center" }}>
        <BackBtn onClick={onClose} />

        {scanned ? (
          <>
            <div style={{ fontSize: 56, marginBottom: 8 }}>✅</div>
            <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontSize: 22, fontWeight: 800, color: "#23A094", marginBottom: 4 }}>Guest Scanned!</div>
            <div style={{ fontSize: 12, color: "#6B6B6B" }}>Wallet opened on their phone. You can move on.</div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#FF5733", letterSpacing: 1, marginBottom: 4 }}>📵 WHATSAPP COULDN'T BE SENT</div>
            <div style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 14, lineHeight: 1.4 }}>{reason}</div>
            <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontSize: 20, fontWeight: 800, color: "#000", marginBottom: 6 }}>
              Show this QR to {customerName}
            </div>
            <div style={{ fontSize: 12, color: "#6B6B6B", marginBottom: 14 }}>
              Ask them to scan with their phone camera — wallet & menu open instantly.
            </div>

            <div style={{ background: "#fff", border: "2px solid #000", padding: 12, borderRadius: 8, display: "inline-block", marginBottom: 14 }}>
              {qrDataUrl
                ? <img src={qrDataUrl} alt="Wallet QR" style={{ width: 280, height: 280, display: "block" }} />
                : <div style={{ width: 280, height: 280, display: "flex", alignItems: "center", justifyContent: "center", color: "#B0B0B0" }}>Generating QR…</div>}
            </div>

            <div style={{ fontSize: 10, fontFamily: "monospace", color: "#6B6B6B", wordBreak: "break-all", marginBottom: 12, padding: 8, background: "#fff", border: "2px solid #000", borderRadius: 6 }}>
              {walletUrl}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <button onClick={copyLink}
                style={{ padding: "12px 14px", borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
                {copied ? "✓ COPIED" : "📋 COPY LINK"}
              </button>
              <button onClick={onClose}
                style={{ padding: "12px 14px", borderRadius: 6, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 12, fontWeight: 900, cursor: "pointer" }}>
                ✓ DONE
              </button>
            </div>

            <div style={{ marginTop: 10, fontSize: 10, color: "#B0B0B0" }}>
              Modal will auto-close when guest scans
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Try Meta WhatsApp Cloud API (template → text → fail). Returns true if Meta accepted
// the send. Caller decides whether to fall back to wa.me on `false`.
// Mirrors the proven pattern from CaptainMode.sendWhatsApp.
// Read response as text first, then attempt JSON.parse. Empty/non-JSON bodies
// (e.g. a 404 from a missing route) used to throw "Unexpected end of JSON input"
// which surfaced as a cryptic alert. Now they fall through to a clean reason.
async function readJsonSafe(r: Response): Promise<{ data: any; parseError?: string }> {
  const text = await r.text();
  if (!text) {
    return { data: null, parseError: `Server returned an empty/invalid response (HTTP ${r.status})` };
  }
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { data: null, parseError: `Server returned an empty/invalid response (HTTP ${r.status})` };
  }
}


async function sendWhatsAppViaMeta(opts: {
  phone: string;
  template?: { name: string; params: string[]; language?: string };
  fallbackText: string;
}): Promise<{ ok: boolean; via?: "template" | "text"; error?: string; code?: number }> {
  let digits = (opts.phone || "").replace(/\D/g, ""); if (digits.length === 10) digits = "91" + digits;
  if (digits.length < 10) return { ok: false, error: "Invalid phone" };

  // 1) Approved template (works outside the 24h customer-service window)
  if (opts.template) {
    try {
      const r = await fetch(`${WHATSAPP_CF_BASE}/sendWhatsAppTemplate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: digits, template: opts.template.name,
          language: opts.template.language || "en", params: opts.template.params,
        }),
      });
      const { data, parseError } = await readJsonSafe(r);
      if (r.ok && data?.ok) return { ok: true, via: "template" };
      console.warn("[door][wa] template send failed, trying text:", parseError || data);
    } catch (e) { console.warn("[door][wa] template request error", e); }
  }

  // 2) Free-form text (only delivered if customer messaged HOD in last 24h)
  console.warn("[door][wa] >>> TEXT FALLBACK STARTING...");
  try {
    const r = await fetch(`${WHATSAPP_CF_BASE}/sendWhatsAppText`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: digits, message: opts.fallbackText }),
    });
    const { data, parseError } = await readJsonSafe(r);
    if (r.ok && data?.ok) return { ok: true, via: "text" };
    if (parseError) return { ok: false, error: parseError };
    return { ok: false, error: data?.error || "Send failed", code: data?.code };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Network error" };
  }
}
export const HOD_LOCATION_URL = "https://www.google.com/maps/search/?api=1&query=House+of+Dopamine+Koramangala+Bangalore";
function formatBookingDateNice(raw?: string): string {
  if (!raw) return "Tonight";
  // Accept YYYY-MM-DD; fall back to the raw string otherwise.
  const d = new Date(raw.length === 10 ? `${raw}T00:00:00` : raw);
  if (isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
function bookingEntryLabel(b: HodBooking): string {
  const tier = (b.tier || "").trim();
  const type = (b.type || "").trim();
  const guests = b.guests || 1;
  if (tier) return tier.toUpperCase();
  if (type) return type.toUpperCase();
  return guests > 1 ? `${guests} GUESTS` : "STAG";
}

// 🔴 2026-05-21 (Khushi) — category-aware WhatsApp templates. Routes by
// booking type (ticket / group / entry-only / guestlist) AND payment status
// (paid online vs pay-at-venue). Single source of truth so the Meta template
// fallback `fallbackText` and any future template params stay in sync.
type HodWaCategory = "ticket" | "group" | "entryonly" | "guestlist";
function detectWaCategory(b: HodBooking): HodWaCategory {
  const et = ((b as any).entryType || "").toLowerCase();
  if (b._isGuestList || et.startsWith("guestlist_")) return "guestlist";
  if (et === "entryonly") return "entryonly";
  if (et === "group" || ((b as any).bookMode || "") === "group") return "group";
  const tier = ((b.tier || "") + " " + (b.type || "")).toLowerCase();
  if (tier.indexOf("group") >= 0) return "group";
  return "ticket";
}
function detectWaPaid(b: HodBooking): { paid: boolean; amount: number } {
  const pid = (b.paymentId || "").trim();
  const amount = Math.max(0, Math.round(Number(b.total) || 0));
  const paid = !!pid && pid.startsWith("pay_");
  return { paid, amount };
}
function fmtINR(n: number): string {
  // 1499 → "1,499" — Indian numbering, no decimals for whole rupees.
  return n.toLocaleString("en-IN");
}
function paymentLine(b: HodBooking): string {
  const { paid, amount } = detectWaPaid(b);
  if (amount <= 0) return "";
  // Walk-ins are collected at the door (cash/UPI/card) — say "PAID", not
  // "PAID ONLINE" (which is only accurate for Razorpay web bookings).
  const atDoor = !!(b as any).isWalkIn;
  if (paid) return atDoor ? `✅ PAID: ₹${fmtINR(amount)}` : `✅ PAID ONLINE: ₹${fmtINR(amount)}`;
  return `💵 PAY AT VENUE: ₹${fmtINR(amount)}`;
}
function entryLineForTicket(b: HodBooking): string {
  // "COUPLE × 1" / "STAG × 2" — qty makes the line useful at the door.
  const label = bookingEntryLabel(b);
  const qty = Math.max(1, Number((b as any).qty) || Number(b.guests) || 1);
  return `${label} × ${qty}`;
}
function entryLineForGroup(b: HodBooking): string {
  const size = Number((b as any).partySize) || Number(b.guests) || 0;
  return size > 0 ? `GROUP OF ${size}` : "GROUP";
}
// 🔴 2026-05-21 (Khushi) — picks the right approved Meta template per
// (category × paid status). Returns null when no suitable template exists
// (e.g. amount ≤ 0 for non-guestlist) so the caller falls back to free-form
// text — avoids sending nonsense like "PAY AT VENUE: ₹0".
//
// Approved templates (created via API 2026-05-21, PENDING Meta review):
//   guestlist_entry_confirmed          [name, eventTitle, dateNice, tierLabel, link]
//   ticket_confirmed_paid    [name, eventTitle, dateNice, entryLabel, amount, link]
//   ticket_confirmed_unpaid  [name, eventTitle, dateNice, entryLabel, amount, link]
//   group_confirmed_paid     [name, eventTitle, dateNice, partySize, amount, link]
//   group_confirmed_unpaid   [name, eventTitle, dateNice, partySize, amount, link]
//   entry_only_paid          [name, eventTitle, dateNice, qty, amount, link]
//   entry_only_unpaid        [name, eventTitle, dateNice, qty, amount, link]
function pickBookingTemplate(
  b: HodBooking,
  link: string,
): { name: string; params: string[] } | null {
  const cat = detectWaCategory(b);
  const { paid, amount } = detectWaPaid(b);
  const name = b.name || "Guest";
  const eventTitle = b.eventTitle || "Tonight at H.O.D";
  const dateNice = formatBookingDateNice(b.date);

  if (cat === "guestlist") {
    const type = ((b.type || "") as string).toLowerCase();
    const tierLabel = type === "couple" ? "COUPLE" : type === "ladies" || type === "female" ? "LADIES" : "STAG";
    return { name: "guestlist_entry_confirmed", params: [name, eventTitle, dateNice, tierLabel, link] };
  }
  // Paid/unpaid templates all require an amount param ({{5}}). If amount is
  // 0 (free comp, malformed booking), skip the template so we don't render
  // "₹0" in the customer's message — caller will fall back to free-form text.
  if (amount <= 0) return null;
  const amountStr = fmtINR(amount);

  if (cat === "entryonly") {
    const qty = String(Math.max(1, Number((b as any).qty) || 1));
    return {
      name: paid ? "entry_only_paid" : "entry_only_unpaid",
      params: [name, eventTitle, dateNice, qty, amountStr, link],
    };
  }
  if (cat === "group") {
    const size = String(Number((b as any).partySize) || Number(b.guests) || 1);
    return {
      name: paid ? "group_confirmed_paid" : "group_confirmed_unpaid",
      params: [name, eventTitle, dateNice, size, amountStr, link],
    };
  }
  // ticket (default)
  const entryLabel = entryLineForTicket(b);
  return {
    name: paid ? "ticket_confirmed_paid" : "ticket_confirmed_unpaid",
    params: [name, eventTitle, dateNice, entryLabel, amountStr, link],
  };
}

// One central builder so the Meta template-missing fallback never drifts
// from the desired copy. Returns the full message body.
function buildBookingWhatsAppText(b: HodBooking, walletUrl: string): string {
  const cat = detectWaCategory(b);
  const customerName = b.name || "Guest";
  const eventTitle = b.eventTitle || "Tonight at H.O.D";
  const dateNice = formatBookingDateNice(b.date);
  const footer = `\n📍 House of Dopamine, Koramangala\n${HOD_LOCATION_URL}`;
  const meta =
    `🎉 Event: ${eventTitle}\n` +
    `📅 Date: ${dateNice}\n`;

  if (cat === "guestlist") {
    // Guestlist is always free — no payment line. Cover-after-9 rule per
    // Khushi 2026-05-21 spec.
    const type = ((b.type || "") as string).toLowerCase();
    const tierLabel = type === "couple" ? "COUPLE" : type === "ladies" || type === "female" ? "LADIES" : "STAG";
    return (
      `Hi ${customerName}, you're on the HOD Guest List! ✨\n\n` +
      meta +
      `🚪 Entry: GUEST LIST · ${tierLabel}\n` +
      `🎁 FREE ENTRY TILL 9:00 PM\n\n` +
      `After 9 PM, cover charges apply for couples and ladies (redeemable on food & drinks).\n\n` +
      `Show your QR at the door for guest list entry.\n\n` +
      `View pass: ${walletUrl}\n\n` +
      `See you tonight!\n` +
      footer
    );
  }

  if (cat === "entryonly") {
    const pay = paymentLine(b);
    return (
      `Hi ${customerName}, your HOD entry pass is booked! 🎟️\n\n` +
      meta +
      `🚪 Entry: ENTRY ONLY × ${Math.max(1, Number((b as any).qty) || 1)}\n` +
      (pay ? pay + "\n" : "") +
      `\n⚠️ IMPORTANT: This is an ENTRY-ONLY pass.\n` +
      `The amount paid is NOT redeemable on food or drinks. F&B is charged separately at the venue.\n\n` +
      `Show your QR at the door to enter.\n\n` +
      `View ticket: ${walletUrl}\n\n` +
      `See you tonight!\n` +
      footer
    );
  }

  if (cat === "group") {
    const pay = paymentLine(b);
    return (
      `Hi ${customerName}, your HOD group booking is confirmed! 🎟️\n\n` +
      meta +
      `🚪 Entry: ${entryLineForGroup(b)}\n` +
      (pay ? pay + "\n" : "") +
      `\nShow your QR at the door — your wallet activates when you arrive at HOD.\n\n` +
      `View ticket: ${walletUrl}\n\n` +
      `See you tonight!\n` +
      footer
    );
  }

  // Default: ticket (stag / couple / ladies / regular event ticket)
  const pay = paymentLine(b);
  return (
    `Hi ${customerName}, your HOD ticket is booked! 🎟️\n\n` +
    meta +
    `🚪 Entry: ${entryLineForTicket(b)}\n` +
    (pay ? pay + "\n" : "") +
    `\nShow your QR at the door — your wallet activates when you arrive at HOD.\n\n` +
    `View ticket: ${walletUrl}\n\n` +
    `See you tonight!\n` +
    footer
  );
}

async function sendBookingWhatsApp(
  b: HodBooking,
  onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void,
) {
  const phone = (b.phone || "").replace(/\D/g, "").slice(-10);
  const ref = b.ref || b.id;
  const link = `https://hodclub.in/?wallet=${encodeURIComponent(ref)}`;
  const customerName = b.name || "Guest";
  // 🔴 2026-05-21 (Khushi) — category + paid-status aware template routing.
  // pickBookingTemplate picks one of the 7 approved templates (or returns
  // null → text-only fallback for ₹0 bookings). fallbackText is what Meta
  // delivers if the template is rejected / unapproved / outside 24h window.
  const tpl = pickBookingTemplate(b, link);
  const fallbackText = buildBookingWhatsAppText(b, link);
  if (phone.length !== 10) {
    if (ref) await logNotificationOutcome(ref, { status: "no_phone" });
    onShowQr({ bookingRef: ref, walletUrl: link, customerName,
      reason: "No valid phone on file. Show this QR to the guest instead." });
    return;
  }
  const result = await sendWhatsAppViaMeta({
    phone,
    template: tpl ? { name: tpl.name, params: tpl.params } : undefined,
    fallbackText,
  });
  if (result.ok) {
    if (ref) await logNotificationOutcome(ref, result.via === "template"
      ? { status: "sent_template", recipient: phone }
      : { status: "sent_text", recipient: phone });
    alert(`✅ WHATSAPP SENT TO +91${phone}\n\n(${result.via === "template" ? "Template" : "Text"} delivered to Meta. If guest doesn't see it in 30s, use 📱 to show QR.)`);
  } else {
    const isTemplateMissing = result.code === 132001 || result.code === 132000 || result.code === 132012 || result.code === 132015;
    const reason = isTemplateMissing
      ? `Template "${tpl?.name || "(text-only)"}" not approved by Meta yet, and the guest is outside the 24h reply window.`
      : `Meta WhatsApp: ${result.error || "send failed"}${result.code ? ` (code ${result.code})` : ""}`;
    if (ref) await logNotificationOutcome(ref, { status: "qr_shown", reason, code: result.code });
    // 2026-05-10 (Khushi) — ALWAYS show a popup so door staff knows the
    // outcome. Success → alert above. Failure → QR modal below (feasible fallback).
    alert(`⚠ WHATSAPP DID NOT SEND\n\n${reason}\n\nShowing QR instead — guest can scan it from your screen.`);
    onShowQr({ bookingRef: ref, walletUrl: link, customerName, reason });
  }
}

// Guestlist 📲: same Meta-first/QR-fallback pattern.
async function sendGuestlistWhatsApp(
  g: HodGuestlistEntry,
  onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void,
) {
  const phone = (g.phone || "").replace(/\D/g, "").slice(-10);
  // 🔴 BUGFIX 2026-05-10 (Khushi spotted) — hodclub.in ONLY handles `?wallet=`.
  // The customer site itself stores guestlist with `wallet_link: ?wallet=<glRef>`,
  // so the wallet route already knows how to resolve guestlist IDs. Old `?gl=`
  // links opened a blank home page. Fallback: use ref → id so legacy guestlist
  // entries (no ref field) still get a working URL.
  const glRef = (g as any).ref || g.id;
  const link = `https://hodclub.in/?wallet=${encodeURIComponent(glRef)}`;
  const customerName = g.name || "Guest";
  const eventTitle = g.eventTitle || "Tonight at H.O.D";
  const dateNice = formatBookingDateNice((g as any).date);
  // 🔴 2026-05-21 (Khushi) — use the central builder so guestlist copy stays
  // in sync with the FREE-till-9-PM rule. Synthesize a minimal HodBooking
  // shape with _isGuestList:true so detectWaCategory routes correctly.
  const synthetic: HodBooking = {
    id: g.id,
    ref: glRef,
    name: customerName,
    phone: g.phone || "",
    eventId: g.eventId,
    eventTitle: eventTitle,
    type: g.type as any,
    total: 0,
    date: (g as any).date || dateNice,
    _isGuestList: true,
  } as any;
  const fallbackText = buildBookingWhatsAppText(synthetic, link);
  if (phone.length !== 10) {
    await logNotificationOutcome(g.id, { status: "no_phone" });
    onShowQr({ bookingRef: g.id, walletUrl: link, customerName,
      reason: "No valid phone on file. Show this QR to the guest instead." });
    return;
  }
  // 🔴 2026-05-21 (Khushi) — guestlist_entry_confirmed template now takes 5 params
  // [name, eventTitle, dateNice, tierLabel, link]. Picker handles tier mapping.
  const tpl = pickBookingTemplate(synthetic, link);
  const result = await sendWhatsAppViaMeta({
    phone,
    template: tpl ? { name: tpl.name, params: tpl.params } : undefined,
    fallbackText,
  });
  if (result.ok) {
    await logNotificationOutcome(g.id, result.via === "template"
      ? { status: "sent_template", recipient: phone }
      : { status: "sent_text", recipient: phone });
    alert(`✅ WHATSAPP SENT TO +91${phone}\n\n(${result.via === "template" ? "Template" : "Text"} delivered to Meta. If guest doesn't see it in 30s, use 📱 to show QR.)`);
  } else {
    const isTemplateMissing = result.code === 132001 || result.code === 132000 || result.code === 132012 || result.code === 132015;
    const reason = isTemplateMissing
      ? `Template "${tpl?.name || "guestlist_entry_confirmed"}" not approved by Meta yet, and the guest is outside the 24h reply window.`
      : `Meta WhatsApp: ${result.error || "send failed"}${result.code ? ` (code ${result.code})` : ""}`;
    await logNotificationOutcome(g.id, { status: "qr_shown", reason, code: result.code });
    // 2026-05-10 (Khushi) — failure popup so door staff doesn't think it sent.
    alert(`⚠ WHATSAPP DID NOT SEND\n\n${reason}\n\nShowing QR instead — guest can scan it from your screen.`);
    onShowQr({ bookingRef: g.id, walletUrl: link, customerName, reason });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-05-12 Door Mode redesign — shared row + customer-detail modal.
// Slim row keeps name/phone/ref + Call. All operational actions (Check-In,
// Activate Cover, WhatsApp, QR) live in the modal so the door tablet can fit
// 5 tabs of dense lists without a wall of buttons per row.
// ─────────────────────────────────────────────────────────────────────────────

function PaidBadge({ booking, cover }: { booking: HodBooking; cover?: HodCover | null }) {
  // Per Khushi spec: only two states. Anything paid through the customer
  // site's online checkout (Razorpay) is "Paid online"; everything else —
  // walk-ins (cash_*), guestlist comps, aggregator bookings, zero-total
  // entries — falls into "Pay at venue" so door staff knows to confirm
  // the cover/entry charge at the door.
  // 🔴 2026-05-21 (Khushi) — GUESTLIST shows a dedicated "FREE ENTRY" badge.
  // Guest list is always comp/free; the old "Paid online" was misleading
  // (Razorpay never processed a payment) and hiding the badge entirely lost
  // visual signal that this entry costs nothing.
  // 🔴 2026-05-21 (Khushi v2) — once a guest is CHECKED IN, the badge must
  // reflect what was actually collected at the door:
  //   • cover activated (>0)            → "PAID ₹<amt>" (gold)
  //   • entry-only ticket sold at door  → "ENTRY ONLY · PAID ₹<amt>" (gold)
  //   • ₹0 wallet activated / ticket-only walk-through → "FREE ENTRY" (blue)
  //   • pre-paid online                 → "✓ PAID ONLINE ₹<amt>" (green)
  // Fallback (no cover doc, not checked in) → "Pay at venue".
  const checkedIn = !!booking.checkedIn;
  const pid = booking.paymentId || "";
  // 🔴 2026-05-23 (Khushi) — exclude free_/free_entry_ prefixes from "paid
  // online" too. Guestlist tickets booked via customer site get a synthetic
  // `free_<rand>` paymentId so the booking flow has a non-empty paymentId,
  // but Razorpay never processed money. Treating these as "paid online"
  // was misleading door staff.
  const paidOnline =
    !!pid &&
    !pid.startsWith("cash_") &&
    !pid.startsWith("comp_") &&
    !pid.startsWith("free_");
  const total = Number((booking as any).total || 0);
  const coverAmt = Number(cover?.coverActivated || 0);
  const isEntryOnly = isOnlyEntryBooking(booking);
  // 🔴 2026-05-23 (Khushi) — `_isGuestList` is only set when adapting from
  // the guestlist collection. When door staff SEARCHES by phone, the same
  // person can come back from the bookings collection with `entryType =
  // "guestlist_female" / "guestlist_couple"` but no `_isGuestList` flag.
  // Use the same detection rule as describeBooking() so badges agree.
  const entryType = String((booking as any).entryType || "").toLowerCase();
  const isGuestListBooking = !!booking._isGuestList || entryType.startsWith("guestlist_");

  // Shared pill styles.
  const goldPill: React.CSSProperties = { background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 6, whiteSpace: "nowrap", letterSpacing: .3 };
  const greenPill: React.CSSProperties = { background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 6, whiteSpace: "nowrap", letterSpacing: .3 };
  const bluePill: React.CSSProperties = { background: "#fff", border: "2px solid #000", color: "#3D3D3D", fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 6, whiteSpace: "nowrap", letterSpacing: .3 };
  const dimGoldPill: React.CSSProperties = { background: "#FFD700", border: "2px solid #000", color: "#000", fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 6, whiteSpace: "nowrap", letterSpacing: .3 };

  // ── CHECKED-IN states (evaluated FIRST so post-arrival actions win over
  //    pre-arrival shortcuts like guestlist/paidOnline). ──────────────────
  if (checkedIn) {
    // Cover wallet activated at the door (works for guestlist + tickets alike).
    if (coverAmt > 0) {
      return <span style={goldPill}>✓ PAID ₹{coverAmt.toLocaleString("en-IN")}</span>;
    }
    // Entry-only pass — cover not collected, entry was (walk-in or prepaid).
    if (isEntryOnly && total > 0) {
      return <span style={goldPill}>ENTRY ONLY · PAID ₹{total.toLocaleString("en-IN")}</span>;
    }
    // Pre-paid via Razorpay (non-entry-only ticket) — keep the green "PAID
    // ONLINE" pill so door staff can see money already changed hands.
    if (paidOnline) {
      const amt = total > 0 ? ` ₹${total.toLocaleString("en-IN")}` : "";
      return <span style={greenPill}>✓ PAID ONLINE{amt}</span>;
    }
    // 🔴 2026-05-26 (Khushi v3.9) — TICKET with money owed (Stag/Couple/etc.
    // bought on hodclub.in as "Pay at venue", entryType = "stag" / "couple"
    // / "male" — NOT "entryonly"). After check-in we MUST assume the ₹X
    // was collected at the door, else badge falsely reads "FREE ENTRY"
    // and door staff thinks the guest owes nothing. Catches every paid
    // ticket type without us maintaining an enum list.
    if (total > 0 && !isGuestListBooking) {
      return <span style={goldPill}>✓ PAID ₹{total.toLocaleString("en-IN")}</span>;
    }
    // ₹0 wallet / guestlist / ticket-only walk-through — nothing collected.
    return <span style={bluePill}>🎁 FREE ENTRY</span>;
  }

  // ── PRE-CHECK-IN states ───────────────────────────────────────────────
  // Guestlist comp — always free until check-in upgrades it via cover.
  // Use combined flag so phone-search lookups (which come from BOOKINGS_COL
  // without the `_isGuestList` flag set) still render FREE ENTRY correctly.
  if (isGuestListBooking) {
    return <span style={bluePill}>🎁 FREE ENTRY</span>;
  }
  // Pre-paid via Razorpay.
  if (paidOnline) {
    const amt = total > 0 ? ` ₹${total.toLocaleString("en-IN")}` : "";
    return <span style={greenPill}>✓ PAID ONLINE{amt}</span>;
  }
  // Default — not checked in yet, no online payment recorded.
  return <span style={dimGoldPill}>₹ Pay at venue</span>;
}

// 🔴 2026-05-21 (Khushi) — Derive ticket category + breakdown for the
// LookupResult info card. Reads the same Firestore fields the customer
// site writes (entryType, tableType, bookMode, qty, guests, partySize).
function describeBooking(b: HodBooking): { category: string; categoryColor: string; breakdown: string } {
  const any = b as any;
  const entryType = String(any.entryType || "").toLowerCase();
  const tableType = String(any.tableType || "").toLowerCase();
  const bookMode = String(any.bookMode || "").toLowerCase();
  const qty = Number(any.qty || 0);
  const guests = Number(b.guests || 0);
  const partySize = Number(any.partySize || 0);

  // GUESTLIST (free entry tab on customer site)
  if (b._isGuestList || entryType.startsWith("guestlist_")) {
    const isLadies = entryType === "guestlist_female" || (b.type || "").toLowerCase().includes("ladies") || (b.type || "").toLowerCase().includes("female");
    return {
      category: "📋 GUESTLIST",
      categoryColor: "#23A094",
      breakdown: isLadies ? `${qty || guests || 1} × Ladies` : `${qty || guests || 1} × Couple`,
    };
  }

  // ENTRY ONLY (door entry pass, non-redeemable)
  if (entryType === "entryonly" || entryType === "only_entry" || entryType === "entry_only") {
    return { category: "🎟 ENTRY ONLY", categoryColor: "#FF5733", breakdown: `${qty || 1} × Entry pass` };
  }

  // TABLE / VIP / GROUP TABLE — show actual guest count (no hardcoded
  // capacity, so Khushi-edited oversize tables aren't mislabelled).
  if (b._isTable || tableType) {
    const n = guests || partySize || qty || 1;
    if (tableType === "vip" || tableType === "vvip") {
      return { category: "👑 VVIP TABLE", categoryColor: "#FF90E8", breakdown: `${n} guest(s)` };
    }
    if (tableType === "table4") {
      return { category: "🍽 TABLE FOR 4", categoryColor: "#FF90E8", breakdown: `${n} guest(s)` };
    }
    return { category: "🍽 TABLE BOOKING", categoryColor: "#FF90E8", breakdown: `${n} guest(s)${tableType ? ` · ${tableType.toUpperCase()}` : ""}` };
  }

  // GROUP BOOKING (per-head group flow)
  if (bookMode === "group" || entryType === "group" || entryType === "group_booking") {
    return { category: "👥 GROUP BOOKING", categoryColor: "#3D3D3D", breakdown: `${guests || qty || 1} person(s)` };
  }

  // TICKETS — stag / couple / female via cover tab
  if (entryType === "stag" || (b.type || "").toLowerCase() === "stag") {
    return { category: "🎫 TICKET", categoryColor: "#000", breakdown: `${qty || 1} × Stag` };
  }
  if (entryType === "couple" || (b.type || "").toLowerCase().includes("couple")) {
    return { category: "🎫 TICKET", categoryColor: "#000", breakdown: `${qty || 1} × Couple` };
  }
  if (entryType === "female" || (b.type || "").toLowerCase().includes("ladies") || (b.type || "").toLowerCase().includes("female")) {
    return { category: "🎫 TICKET", categoryColor: "#000", breakdown: `${qty || 1} × Ladies` };
  }

  // Fallback — show whatever we have
  return {
    category: "🎫 TICKET",
    categoryColor: "#000",
    breakdown: `${qty || guests || 1} guest(s)${b.type ? ` · ${b.type}` : ""}`,
  };
}

function BookingRow({ booking, cover, onOpen }: { booking: HodBooking; cover?: HodCover | null; onOpen: (b: HodBooking) => void }) {
  const phoneClean = (booking.phone || "").replace(/[^\d+]/g, "");
  return (
    <div onClick={() => onOpen(booking)}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 14px", borderRadius: 8,
        background: "#fff",
        border: "2px solid #000",
        marginBottom: 8, cursor: "pointer", transition: "background .12s" }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.3px", color: "#000", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {booking.name || "Guest"}
          </div>
          {booking.checkedIn && <span style={{ color: "#23A094", fontSize: 12, fontWeight: 900 }}>✓</span>}
        </div>
        <div style={{ fontSize: 12, color: "#6B6B6B", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {booking.phone || "no phone"}{booking.ref ? ` · ${booking.ref}` : ""}
        </div>
      </div>
      <PaidBadge booking={booking} cover={cover} />
      {phoneClean && (
        <a href={`tel:${phoneClean}`} onClick={(e) => e.stopPropagation()} title="Call guest"
          style={{ flexShrink: 0, width: 38, height: 38, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 16, textDecoration: "none" }}>
          📞
        </a>
      )}
    </div>
  );
}

function BookingDetailModal({
  booking, agentName, onClose, onCover, onShowQr, onSendWhatsApp,
}: {
  booking: HodBooking;
  agentName: string;
  onClose: () => void;
  onCover: (b: HodBooking) => void;
  onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void;
  onSendWhatsApp?: (b: HodBooking) => void;
}) {
  const phoneClean = (booking.phone || "").replace(/[^\d+]/g, "");
  // 🆕 2026-05-27 v3.67 (Khushi LIVE-NIGHT) — REASSIGN button surfaced on the
  // scanner / tickets BookingDetailModal for ground-floor table bookings
  // (TABLE FOR 4 + VVIP TABLE FOR 6). Door girl scans QR → sees this modal →
  // can now move the guest to a different table without leaving for TABLES tab.
  // Gate: `_isTable: true` (set by lookupBooking for HODTAB/TBL-/AGG- refs)
  // AND floor label / tableId indicates ground floor (C* / V* prefixes).
  // Locked once guest has arrived — KOTs are tagged to the table, captain
  // handles moves after arrival (same rule as TABLES tab).
  const _floorLabelStr = String((booking as any)._floorLabel || (booking as any).floorLabel || "").toLowerCase();
  const _tableIdStr = String((booking as any)._tableId || (booking as any).tableId || "").toUpperCase();
  // 🆕 2026-05-27 v3.83 (Khushi LIVE-NIGHT) — was gated to ground-floor only;
  // a TABLELESS HODTAB scan (auto-assign failed, no tableId yet, no floor
  // label) failed BOTH branches → REASSIGN button never rendered, leaving
  // the door girl with the alert "tap REASSIGN below" but nothing to tap.
  // Now: ALSO show REASSIGN whenever it's a table booking with no tableId.
  // The ReassignModal already lists every table across all floors so the
  // door girl can place them anywhere.
  const _isGroundFloorTable = !!(booking as any)._isTable && (
    _floorLabelStr.includes("ground") ||
    (!_floorLabelStr && (/^C\d/.test(_tableIdStr) || /^V\d/.test(_tableIdStr))) ||
    !_tableIdStr
  );
  const _alreadyArrived = !!(booking as any)._arrived || !!booking.checkedIn;
  const [reassignOpen, setReassignOpen] = useState(false);
  // 🆕 2026-05-27 v3.88 (Khushi LIVE-NIGHT) — door girl scanned MALIKA's
  // HODTAB835111 (no table assigned), tapped CHECK IN GUEST → alert told her
  // to reassign. She tapped REASSIGN TABLE, picked a table, came back, tapped
  // CHECK IN GUEST again → SAME alert. Root cause: the `booking` prop here is
  // the FROZEN search-result snapshot; Firestore was updated but React never
  // re-rendered with the new tableId. Track the reassigned id locally and
  // pass it down so both the inline ACTIVATE COVER gate AND the LookupResult
  // CHECK IN GUEST gate read the override after a successful reassign.
  const [reassignedTableId, setReassignedTableId] = useState<string>("");
  // v3.91 — also read `_tableId` (lookupBooking sets this on TBL-/HODTAB
  // scanner results; `.tableId` is empty on the shim).
  const _liveTableIdRaw = reassignedTableId || String((booking as any).tableId || (booking as any)._tableId || "").trim();
  // 🔴 2026-05-21 (Khushi) — Live cover lookup so the modal's PaidBadge
  // matches the row badge (was showing "FREE ENTRY" while row showed
  // "✓ PAID ₹999"). Subscribe to the tonight-wide covers feed and pick
  // the matching one by ref/bookingId. Fail-open: if subscription dies,
  // badge falls back to its legacy logic (paymentId / guestlist).
  const [modalCover, setModalCover] = useState<HodCover | null>(null);
  useEffect(() => {
    // 🔴 2026-05-22 — tonight-scoped feed (was reading WHOLE covers collection).
    const unsub = subscribeToCoversForNight(getOperationalNightStr(), (all) => {
      // Match EITHER booking identifier (ref or doc id) against EITHER cover
      // identifier (ref or bookingId) — covers all 4 cross-mapping cases.
      const keys = new Set([booking.ref, booking.id].filter(Boolean) as string[]);
      const c = all.find((x) => (x.ref && keys.has(x.ref)) || (x.bookingId && keys.has(x.bookingId))) || null;
      setModalCover(c);
    });
    return unsub;
  }, [booking.ref, booking.id]);
  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", zIndex: 100, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto", backdropFilter: "blur(4px)" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 520, marginTop: 32, background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 18, boxShadow: "none" }}>
        {/* 🆕 2026-05-26 v3.17 (Khushi) — removed top PaidBadge: it duplicated
            the PAYMENT row from the structured list below (top showed wallet
            ₹999, list showed ticket ₹500 → confusing). Payment now lives ONLY
            in the PAYMENT row, which auto-swaps PAY AT VENUE → PAID once
            collected. Name only in header. */}
        <BackBtn onClick={onClose} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 10, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 26, fontWeight: 900, color: "#000", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: "-0.3px", textTransform: "uppercase" }}>
              {booking.name || "Guest"}
            </div>
          </div>
        </div>

        <LookupResult booking={booking} agentName={agentName} onDone={onClose} hideIdentity cover={modalCover} tableIdOverride={reassignedTableId} />

        {/* 🆕 2026-05-26 (Khushi v3.15) — bigger buttons + Space Grotesk.
            🆕 2026-05-26 v3.23 (Khushi) — bumped marginTop 4→10 so the gap
            between CHECK IN GUEST and the 2×2 action grid matches the
            guestlist modal exactly (which uses marginBottom:10 on its own
            CHECK IN GUEST button — same breathing room). */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
          {/* 🆕 2026-05-27 v3.51 (Khushi LIVE-NIGHT) — hide ACTIVATE COVER when a
              cover is already live (`modalCover.coverActivated > 0`). Was
              showing for Putti's HODTAB after door already activated ₹5,000 →
              door girl could double-tap and either re-prompt or surface a
              "Cover already activated" error. Cover editing (top-up / refund)
              lives on the TABLES tab row tap (✏️ Edit Cover Amount), not here.
              Cover already-activated also means the guest is on premises (Khushi
              rule), so the modal becomes view-only: SHOW QR + CALL only. */}
          {!booking._isGuestList && Number(modalCover?.coverActivated || 0) <= 0 && (() => {
            // 🆕 2026-05-27 v3.63 (Khushi LIVE-NIGHT) — ENTRY ONLY bookings MUST go
            // through CHECK IN GUEST first so the ₹599 entry charge is recorded and
            // a ₹0-balance wallet is created. If door girl taps ACTIVATE COVER first
            // it bypasses that flow and only the cover gets activated (entry charge
            // is lost from audit). Grey out the button until check-in is done.
            // Post-check-in, the parent's booking snapshot may be stale (modal
            // holds a frozen prop). The live `modalCover` subscription is our
            // source of truth: `ensureZeroBalanceCoverForGuest` (entry-only) and
            // `activateCoverForBooking` (paid) BOTH write a covers doc inside
            // CheckInPaymentModal.handleConfirm — so once `modalCover` exists,
            // check-in has happened and ACTIVATE COVER is safe to enable.
            const isEntryOnly = isOnlyEntryBooking(booking) && !booking.checkedIn && !modalCover;
            return (
              <button
                onClick={() => {
                  if (isEntryOnly) return;
                  // 🆕 v3.73 — table-assigned gate (mirror openCheckInModal).
                  const _isTbl = !!((booking as any)._isTable || (booking as any).tableType || (booking as any).bookMode === "group");
                  // v3.88 — use _liveTableIdRaw so post-reassign state wins.
                  if (_isTbl && !_liveTableIdRaw) {
                    showAppAlert(
                      "This is a TABLE BOOKING but no table has been assigned yet — tap REASSIGN TABLE below (or pick a table from the floor map) BEFORE you activate the cover.\n\nThe captain needs a table to take orders, route KOTs, and print the bill.",
                      "🪑 PLEASE ASSIGN THE TABLE FIRST"
                    );
                    return;
                  }
                  // 🆕 2026-05-27 v3.102 (Khushi) — was `onClose()` after
                  // onCover, which dismissed the parent modal as soon as
                  // door girl tapped ACTIVATE COVER. If she then cancelled
                  // the cover sub-modal, nothing was left on screen.
                  // Now the parent modal stays open underneath the cover
                  // sub-flow; only the explicit CLOSE button at the bottom
                  // of this modal dismisses it.
                  onCover(booking);
                }}
                disabled={isEntryOnly}
                title={isEntryOnly ? "CHECK IN GUEST FIRST — entry charge must be collected before cover" : undefined}
                style={{
                  padding: "16px 12px", borderRadius: 6,
                  background: isEntryOnly ? "#fff" : "#FF90E8",
                  border: isEntryOnly ? "2px dashed #000" : "2px solid #000",
                  color: isEntryOnly ? "#6B6B6B" : "#000",
                  fontSize: 15, fontWeight: 900,
                  cursor: isEntryOnly ? "not-allowed" : "pointer",
                  letterSpacing: .4,
                  lineHeight: 1.15,
                }}>
                {isEntryOnly ? <>💰 ACTIVATE COVER<div style={{ fontSize: 9, fontWeight: 800, marginTop: 4, letterSpacing: .6 }}>CHECK IN FIRST</div></> : "💰 ACTIVATE COVER"}
              </button>
            );
          })()}
          {onSendWhatsApp && (
            <button onClick={() => onSendWhatsApp(booking)}
              style={{ padding: "16px 12px", borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900, cursor: "pointer", letterSpacing: .4 }}>
              📲 SEND WALLET LINK
            </button>
          )}
          <button onClick={() => onShowQr({
            bookingRef: booking.ref || booking.id,
            walletUrl: `https://hodclub.in/?wallet=${encodeURIComponent(booking.ref || booking.id)}`,
            customerName: booking.name || "Guest",
            reason: "Show this QR — guest scans to open their wallet & menu instantly.",
          })}
            style={{ padding: "16px 12px", borderRadius: 6, background: "#FFD700", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900, cursor: "pointer", letterSpacing: .4 }}>
            📱 SHOW WALLET QR
          </button>
          {phoneClean && (
            <a href={`tel:${phoneClean}`}
              style={{ padding: "16px 12px", borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900, cursor: "pointer", textAlign: "center", textDecoration: "none", letterSpacing: .4 }}>
              📞 CALL
            </a>
          )}
          {/* 🆕 v3.67 (Khushi) — REASSIGN TABLE for ground-floor table bookings.
              Spans both columns so it never wraps under the 2-col grid. Locked
              once arrived — same rule as TABLES tab (KOTs tagged to table). */}
          {/* 🆕 2026-05-27 v3.88 (Khushi LIVE-NIGHT) — REASSIGN TABLE button
              was purple/lavender; Khushi: "CHANGE COLOR TO YELLOW AND BLACK
              LIKE OTHER BUTTONS AND MAKE IT FLASHY SO DOOR GIRL KNOWS SHE
              NEEDS TO CLICK IT AFTER THE POPUP". Now gold→black gradient
              with pulsing gold halo + scale-bounce animation. Pulse ONLY
              fires when no table is assigned yet (the "you must reassign"
              state). Once a table exists or guest has arrived, button drops
              to calm gold so it doesn't keep flashing. */}
          {_isGroundFloorTable && (
            <>
              <style>{`@keyframes hod_reassign_pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,144,232,.85),0 0 0 0 rgba(255,144,232,.5);transform:scale(1)}50%{box-shadow:0 0 0 10px rgba(255,144,232,0),0 0 22px 4px rgba(255,144,232,.7);transform:scale(1.025)}}`}</style>
              <button
                onClick={() => {
                  if (_alreadyArrived) {
                    showAppAlert("Reassign locked here — KOTs are tagged to this table.\n\nAsk the CAPTAIN to move the guest from Captain Mode (re-stamps active rounds).", "🪑 GUEST ALREADY ARRIVED AT THIS TABLE");
                    return;
                  }
                  setReassignOpen(true);
                }}
                disabled={_alreadyArrived}
                title={_alreadyArrived ? "Guest already arrived — captain handles table moves" : "Move guest to a different table"}
                style={{
                  gridColumn: "1 / -1",
                  padding: "18px 12px", borderRadius: 6,
                  background: _alreadyArrived
                    ? "#fff"
                    : (!_liveTableIdRaw
                        ? "#FF90E8"
                        : "#FF90E8"),
                  border: _alreadyArrived ? "2px dashed #000" : "2px solid #000",
                  color: _alreadyArrived ? "#6B6B6B" : "#000",
                  fontSize: 16, fontWeight: 900, letterSpacing: .6,
                  cursor: _alreadyArrived ? "not-allowed" : "pointer",
                  animation: (!_alreadyArrived && !_liveTableIdRaw) ? "hod_reassign_pulse 1.1s ease-in-out infinite" : undefined,
                  textShadow: undefined,
                }}>
                🔄 REASSIGN TABLE
              </button>
            </>
          )}
        </div>

        <button onClick={onClose}
          style={{ marginTop: 14, width: "100%", padding: 14, borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 800, cursor: "pointer", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", letterSpacing: .5 }}>
          CLOSE
        </button>
      </div>
      {/* 🆕 v3.67 — Reassign overlay. Reservation shim built from the
          lookupBooking output: `booking.id` IS the tableReservation doc id
          (set on line 3946 of firestore-hod.ts). `bookedTableIds` is empty —
          the reassignTable Firestore transaction rejects double-booking
          server-side, so worst case the user sees an "already booked" error
          inline (fail-open per Khushi rule; no extra subscription cost). */}
      {reassignOpen && (
        <ReassignModal
          reservation={{
            _docId: booking.id,
            customerName: booking.name || "Guest",
            tableId: reassignedTableId || _tableIdStr || ((booking as any)._tableId || ""),
          } as any}
          bookedTableIds={new Set<string>()}
          agentName={agentName}
          onClose={() => setReassignOpen(false)}
          onReassigned={(tid) => {
            // v3.88 — mirror the new id onto the frozen booking prop AND into
            // local state so the CHECK IN GUEST / ACTIVATE COVER gates stop
            // firing immediately. The Firestore write already happened inside
            // ReassignModal.submit; this just unlocks the UI without forcing
            // the door girl to close + re-search.
            try { (booking as any).tableId = tid; } catch (_) {}
            setReassignedTableId(tid);
          }}
        />
      )}
    </div>
  );
}

// Predicate helpers — keep filter logic in one spot so the 5 tabs stay in sync.
function isGuestlistBooking(b: HodBooking) {
  return ((b as any).entryType || "").startsWith("guestlist_");
}
function isGroupBooking(b: HodBooking) {
  // True group bookings only. Recognised signals:
  //   - explicit `bookMode: "group"` (customer site + door walk-in)
  //   - explicit `entryType: "group_booking"` (door walk-in)
  //   - `tableType` containing "group" (e.g. "group", "group_table") — this
  //     keeps standard table reservations (tableType "Standard"/"VIP"/etc)
  //     out of the Group tab while catching the explicit group marker.
  if ((b as any).bookMode === "group") return true;
  if ((b as any).entryType === "group_booking") return true;
  // 🔴 BUGFIX 2026-05-19 (Khushi LIVE-NIGHT) — customer site (hodclub.in)
  // does NOT persist `bookMode` on the bookings doc; instead it sets
  //   • `entryType: "group"`  (per-head GROUP option)
  //   • `tableType: "table4"` (TABLE FOR 4)
  //   • `tableType: "vip"`    (VVIP TABLE FOR 6)
  // Match those explicitly so customer-side group bookings land in the
  // Group tab instead of falling through to the generic Tickets tab.
  const et = String((b as any).entryType || "").toLowerCase();
  if (et === "group") return true;
  const tt = String((b as any).tableType || "").toLowerCase();
  if (tt === "table4" || tt === "vip" || tt === "vvip") return true;
  if (tt && tt.includes("group")) return true;
  return false;
}
// 🔴 2026-05-20 (Khushi) — CORPORATE bookings live in `tableReservations`
// (created via createCorporateTableBooking which writes source="corporate" +
// isCorporateBooking:true). This helper recognises them so the new CORPORATE
// dashboard tab can pull them out of the tables stream — and the TABLES tab
// can exclude them so they don't double-count.
function isCorporateTableRes(r: HodTableReservation) {
  if ((r as any).isCorporateBooking === true) return true;
  const s = String((r as any).source || "").toLowerCase();
  return s === "corporate";
}
function isOnlyEntryBooking(b: HodBooking) {
  // Source of truth: the customer wallet (separate `hodclub.in` repo) writes
  // `entryType: "entryonly"` (no underscore, lowercase) on the booking doc
  // when a guest buys a Door Entry pass. The value is the option `id` from
  // the wallet's entry-type picker (the `entryonly` row in the booking modal's
  // entry options table) and is persisted as `entryType: String(d.entryType||'')`
  // on the Razorpay/booking payload. If hodclub.in ever changes that id, this
  // predicate must be updated to match.
  // The Tickets tab uses `!isOnlyEntryBooking(b)` to exclude these rows, so
  // both filters stay in sync via this single predicate.
  // Legacy tolerance: older POS walk-ins minted `"only_entry"` / `"entry_only"`,
  // so we still accept those to keep historical bookings classified correctly.
  const et = String((b as any).entryType || "").toLowerCase();
  return et === "entryonly" || et === "only_entry" || et === "entry_only";
}
// True if this booking represents a table reservation (so it belongs in the
// Tables tab, not the generic Tickets list). Bookings created via the
// customer site's "book a table" flow carry a `tableType` field; the
// adapter that surfaces table reservations into the bookings stream sets
// `_isTable`. Either signal disqualifies it from Tickets.
function isTableBooking(b: HodBooking) {
  if ((b as any)._isTable) return true;
  const tt = String((b as any).tableType || "").trim();
  return !!tt;
}

function TicketsTab({ agentName, query, eventId, eventDate, onCover, onShowQr }: { agentName: string; query: string; eventId: string; eventDate: string; onCover: (b: HodBooking) => void; onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void }) {
  return <BookingsListTab kind="tickets" agentName={agentName} query={query} eventId={eventId} eventDate={eventDate} onCover={onCover} onShowQr={onShowQr} />;
}

function GroupBookingsTab({ agentName, query, eventId, eventDate, onCover, onShowQr }: { agentName: string; query: string; eventId: string; eventDate: string; onCover: (b: HodBooking) => void; onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void }) {
  return <BookingsListTab kind="group" agentName={agentName} query={query} eventId={eventId} eventDate={eventDate} onCover={onCover} onShowQr={onShowQr} />;
}

function OnlyEntryTab({ agentName, query, eventId, eventDate, onCover, onShowQr }: { agentName: string; query: string; eventId: string; eventDate: string; onCover: (b: HodBooking) => void; onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void }) {
  return <BookingsListTab kind="onlyentry" agentName={agentName} query={query} eventId={eventId} eventDate={eventDate} onCover={onCover} onShowQr={onShowQr} />;
}

function BookingsListTab({ kind, agentName, query, eventId, eventDate, onCover, onShowQr }: {
  kind: "tickets" | "group" | "onlyentry";
  agentName: string; query: string; eventId: string; eventDate: string;
  onCover: (b: HodBooking) => void;
  onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void;
}) {
  const [bookings, setBookings] = useState<HodBooking[]>([]);
  const [covers, setCovers] = useState<HodCover[]>([]);
  const [detail, setDetail] = useState<HodBooking | null>(null);
  const [viewMode, setViewMode] = useState<"all" | "pending" | "checked">("pending");

  // Tab-specific copy
  const COPY = kind === "group"
    ? { all: "Group Bookings", empty: "No group bookings for today" }
    : kind === "onlyentry"
    ? { all: "Only-Entry Bookings", empty: "No only-entry bookings for today" }
    : { all: "Today's Bookings", empty: "No bookings for today" };


  // 🔴 2026-05-23 (Khushi COST FIX r2) — tonight-scoped bookings (was full collection).
  // Same filter rules as parent tabCounts: today + calendar today.
  // 🆕 2026-06-02 v3.171 — 3-night window so a future event chip's pre-bookings
  // are in memory; the view itself is scoped below (TONIGHT for "all", else the
  // selected event's date).
  useEffect(() => {
    const unsub = subscribeToBookingsForNights(BOOKING_WINDOW_DATES(), setBookings);
    return unsub;
  }, []);
  // 🔴 2026-05-21 (Khushi) — covers feed so PaidBadge can switch from
  // "Pay at venue" → "PAID ₹<amt>" / "FREE ENTRY" / "ENTRY ONLY · PAID ₹<amt>"
  // live, the moment door staff activates a wallet or marks check-in.
  // 🔴 2026-05-22 (Khushi COST FIX) — tonight-scoped covers (was full collection).
  // Covers (wallets) are minted at ARRIVAL, so future nights have none — keep
  // this tonight-only (no value widening it, and it's the costly onSnapshot one).
  useEffect(() => subscribeToCoversForNight(getOperationalNightStr(), setCovers), []);
  const coverByRef = new Map<string, HodCover>();
  for (const c of covers) {
    if (c.ref) coverByRef.set(c.ref, c);
    if (c.bookingId) coverByRef.set(c.bookingId, c);
  }

  const todayDates = eventDateScope(eventId, eventDate);
  let todayBookings = bookings.filter((b) => todayDates.has((b.date || "").slice(0, 10)));
  // Always exclude guestlist-typed bookings — they live under the Guest List tab.
  todayBookings = todayBookings.filter((b) => !isGuestlistBooking(b));
  // Then narrow to this tab's segment.
  if (kind === "tickets") {
    // 🔴 2026-05-20 (Khushi) — GROUP dashboard tab removed. All group bookings
    // now flow into TICKETS (they're just regular party-size bookings — no need
    // for a dedicated tab). Per-head GROUP, bookMode:group, etc. all land here.
    todayBookings = todayBookings.filter((b) => !isOnlyEntryBooking(b) && !isTableBooking(b));
  } else if (kind === "group") {
    todayBookings = todayBookings.filter((b) => isGroupBooking(b));
  } else if (kind === "onlyentry") {
    todayBookings = todayBookings.filter((b) => isOnlyEntryBooking(b));
  }
  if (eventId !== "all") todayBookings = todayBookings.filter((b) => !b.eventId || b.eventId === eventId);
  const checked = todayBookings.filter((b) => b.checkedIn).length;
  const pending = todayBookings.length - checked;
  // Tri-state filter: ALL / YET TO CHECK IN / CHECKED IN. Default = pending (operationally most useful at the door).
  const visibleBookings = viewMode === "checked"
    ? todayBookings.filter((b) => b.checkedIn)
    : viewMode === "pending"
      ? todayBookings.filter((b) => !b.checkedIn)
      : todayBookings;
  const filtered = visibleBookings.filter((b) => matchQuery(query, b.name, b.phone, b.ref));
  // 🔴 2026-05-21 (Khushi) — checked-in rows drop to BOTTOM so new arrivals
  // always sit at the top of every tab (TICKETS / GROUP / ENTRY PASS).
  filtered.sort((a, b) => {
    const ad = !!a.checkedIn, bd = !!b.checkedIn;
    if (ad !== bd) return ad ? 1 : -1;
    const at = String((a as any).bookedAt || a.date || "");
    const bt = String((b as any).bookedAt || b.date || "");
    if (!at) return 1;
    if (!bt) return -1;
    return bt.localeCompare(at);
  });

  return (
    <div>
      {detail && (
        <BookingDetailModal
          booking={detail}
          agentName={agentName}
          onClose={() => setDetail(null)}
          onCover={onCover}
          onShowQr={onShowQr}
          onSendWhatsApp={(b) => sendBookingWhatsApp(b, onShowQr)}
        />
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
        <div onClick={() => setViewMode("all")}
          style={{ background: viewMode === "all" ? "#FF90E8" : "#fff",
            border: "2px solid #000",
            borderRadius: 8, padding: 12, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontVariantNumeric: "tabular-nums", fontSize: 26, fontWeight: 900, color: "#000", lineHeight: 1 }}>{todayBookings.length}</div>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "1px", textTransform: "uppercase", color: "#6B6B6B", marginTop: 6 }}>{COPY.all.toUpperCase()} {viewMode === "all" ? "•" : ""}</div>
        </div>
        <div onClick={() => setViewMode("pending")}
          style={{ background: viewMode === "pending" ? "#FFD700" : "#fff",
            border: "2px solid #000",
            borderRadius: 8, padding: 12, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontVariantNumeric: "tabular-nums", fontSize: 26, fontWeight: 900, color: "#000", lineHeight: 1 }}>{pending}</div>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "1px", textTransform: "uppercase", color: "#6B6B6B", marginTop: 6 }}>YET TO CHECK IN {viewMode === "pending" ? "•" : ""}</div>
        </div>
        <div onClick={() => setViewMode("checked")}
          style={{ background: viewMode === "checked" ? "#23A094" : "#fff",
            border: "2px solid #000",
            borderRadius: 8, padding: 12, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontVariantNumeric: "tabular-nums", fontSize: 26, fontWeight: 900, color: "#000", lineHeight: 1 }}>{checked}</div>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "1px", textTransform: "uppercase", color: "#6B6B6B", marginTop: 6 }}>CHECKED IN {viewMode === "checked" ? "•" : ""}</div>
        </div>
      </div>

      {filtered.map((b) => (
        <BookingRow key={b.id} booking={b} cover={coverByRef.get(b.ref) || coverByRef.get(b.id) || null} onOpen={setDetail} />
      ))}
      {filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: 36, color: "#6B6B6B", fontSize: 13, fontWeight: 500 }}>
          {query ? `No matches for "${query}"`
            : viewMode === "checked" ? "No one checked in yet — tap YET TO CHECK IN to see remaining guests"
            : viewMode === "pending" ? "Everyone's checked in! 🎉 Tap CHECKED IN or ALL to see them."
            : COPY.empty}
        </div>
      )}
    </div>
  );
}

function GuestlistTab({ agentName, query, eventId, eventDate, onCover, onShowQr }: { agentName: string; query: string; eventId: string; eventDate: string; onCover: (b: HodBooking) => void; onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void }) {
  const [guests, setGuests] = useState<HodGuestlistEntry[]>([]);
  const [bookings, setBookings] = useState<HodBooking[]>([]);
  const [covers, setCovers] = useState<HodCover[]>([]);
  const [busyId, setBusyId] = useState("");
  const [viewMode, setViewMode] = useState<"all" | "pending" | "checked">("pending");
  const [detail, setDetail] = useState<HodBooking | null>(null);
  const { toast } = useToast();

  // 🔴 2026-05-23 (Khushi COST FIX r2) — tonight-scoped guestlist via joinedAt
  // range query (was full collection). Window = [calToday-1, calToday+2) so
  // the operational night straddling calendar midnight is fully covered.
  // 🆕 2026-06-02 v3.171 — widen to [calToday-1, calToday+3) so tomorrow AND
  // day-after guestlist entries are loaded for future event chips. View is
  // scoped below (TONIGHT for "all", else the selected event's date).
  useEffect(() => {
    const c = CALENDAR_TODAY_STR();
    const unsub = subscribeToGuestlistInRange(addDaysStr(c, -1), addDaysStr(c, 3), setGuests);
    return unsub;
  }, []);
  // 🔴 2026-05-21 (Khushi) — covers feed so PaidBadge can switch guestlist
  // rows from FREE ENTRY → PAID ₹<amt> the moment a wallet is activated.
  // 🔴 2026-05-22 (Khushi COST FIX) — tonight-scoped covers (was full collection).
  useEffect(() => subscribeToCoversForNight(getOperationalNightStr(), setCovers), []);
  // ── BUGFIX 2026-05-08: also subscribe to bookings so guestlist-typed entries
  // that landed in `bookings` (Firestore rules / cache / pre-fix HTML) still
  // show up under "📋 Guest List". Mapped to HodGuestlistEntry shape, deduped
  // by id with the canonical guestlist collection.
  // 🔴 2026-05-23 (Khushi COST FIX r2) — tonight-scoped (was full collection).
  useEffect(() => {
    const unsub = subscribeToBookingsForNights(BOOKING_WINDOW_DATES(), setBookings);
    return unsub;
  }, []);

  // 🔴 2026-05-21 (Khushi) — modal state for row check-in
  const [checkInTarget, setCheckInTarget] = useState<HodGuestlistEntry | null>(null);

  const handleToggle = async (g: HodGuestlistEntry) => {
    const wasCheckedIn = g.checkedIn;
    const _source: "booking" | "guestlist" = (g as any)._source === "booking" ? "booking" : "guestlist";

    // CHECK-IN path → open modal (amount + payment method)
    if (!wasCheckedIn) {
      if (busyId === g.id) return;
      setCheckInTarget(g);
      return;
    }

    // UN-CHECK path → direct call (no modal — just reverse the check-in)
    setBusyId(g.id);
    try {
      await checkInGuest(g.id, _source, agentName, wasCheckedIn);
      toast({ title: `↩️ Un-checked: ${g.name || "Guest"}`, duration: 3000 });
    } catch {}
    setBusyId("");
  };

  const handleCheckInModalConfirmed = (g: HodGuestlistEntry, checkedInAt: string, wasNew: boolean) => {
    setCheckInTarget(null);
    const _source: "booking" | "guestlist" = (g as any)._source === "booking" ? "booking" : "guestlist";
    if (wasNew) {
      toast({
        title: `✅ Checked in: ${g.name || "Guest"}`,
        description: "Tap Undo within 30 seconds if this was a mistake.",
        duration: 30000,
        action: (
          <ToastAction altText="Undo check-in" onClick={async () => {
            try {
              const r = await checkInGuest(g.id, _source, agentName, true, checkedInAt);
              if (r.undone) {
                toast({ title: "↩️ Check-in reversed", duration: 4000 });
              } else {
                toast({ title: "Cannot undo", description: "Record was modified — ask a manager.", variant: "destructive", duration: 6000 });
              }
            } catch (e: any) {
              toast({ title: "Undo failed", description: e?.message || "Try again", variant: "destructive" });
            }
          }}>Undo</ToastAction>
        ),
      });
    } else {
      toast({ title: `Already checked in: ${g.name || "Guest"}`, duration: 3000 });
    }
  };

  const today = TODAY_STR();
  // Today only: entry must have joinedAt OR entryTime stamped today.
  // If neither field exists (very old/legacy entry), exclude from door view.
  const todayDates = eventDateScope(eventId, eventDate);
  let todayGuests = guests.filter((g) => {
    const ja = (g.joinedAt || "").slice(0, 10);
    const et = (g.entryTime || "").slice(0, 10);
    return todayDates.has(ja) || todayDates.has(et);
  });
  // Pull guestlist-typed bookings (entryType starts with "guestlist_") that
  // live in the `bookings` collection and adapt them to HodGuestlistEntry.
  const guestIds = new Set(todayGuests.map((g) => g.id));
  const adaptedFromBookings: HodGuestlistEntry[] = bookings
    .filter((b) => ((b as any).entryType || "").startsWith("guestlist_"))
    .filter((b) => todayDates.has((b.date || "").slice(0, 10)) || todayDates.has(((b as any).bookedAt || "").slice(0, 10)))
    .filter((b) => eventId === "all" || !b.eventId || b.eventId === eventId)
    .filter((b) => !guestIds.has(b.id))
    .map((b) => ({
      // 🔴 BUGFIX 2026-05-09 — use public ref (HOD-XXX) as the id so the
      // cover gets keyed at covers/HOD-XXX (matching the wallet link the
      // customer opens). Previous code used b.id (firestore auto-id) which
      // wrote covers under an unfindable key. _bookingDocId preserved so the
      // bookings doc itself can still be updated on check-in.
      id: b.ref || b.id,
      name: b.name || "",
      phone: b.phone || "",
      eventId: b.eventId,
      eventTitle: b.eventTitle,
      type: ((b as any).entryType === "guestlist_female" ? "ladies" : "couple") as any,
      joinedAt: (b as any).bookedAt,
      checkedIn: !!b.checkedIn,
      _source: "booking",
      _bookingDocId: b.id,
    } as HodGuestlistEntry & { _bookingDocId: string }));
  todayGuests = [...todayGuests, ...adaptedFromBookings];
  // Permissive: keep entries with no eventId (legacy / unscoped guest list adds)
  if (eventId !== "all") todayGuests = todayGuests.filter((g) => !g.eventId || g.eventId === eventId);
  const checkedIn = todayGuests.filter((g) => g.checkedIn).length;
  const pendingGuests = todayGuests.length - checkedIn;
  // Tri-state filter: ALL / YET TO CHECK IN / CHECKED IN. Default = pending (door operations).
  const visibleGuests = viewMode === "checked"
    ? todayGuests.filter((g) => g.checkedIn)
    : viewMode === "pending"
      ? todayGuests.filter((g) => !g.checkedIn)
      : todayGuests;
  const filtered = visibleGuests.filter((g) => matchQuery(query, g.name, g.phone));
  // 🔴 2026-05-21 (Khushi) — checked-in guests drop to BOTTOM so new arrivals
  // appear at the top. Within each group: newest joinedAt/entryTime first.
  filtered.sort((a, b) => {
    const ad = !!a.checkedIn, bd = !!b.checkedIn;
    if (ad !== bd) return ad ? 1 : -1;
    const at = String(a.joinedAt || a.entryTime || "");
    const bt = String(b.joinedAt || b.entryTime || "");
    if (!at) return 1;
    if (!bt) return -1;
    return bt.localeCompare(at);
  });
  // Find the underlying guestlist entry for the open detail modal so we can
  // wire the per-row free-entry / cover / WA flows through the modal.
  const detailGuest = detail ? todayGuests.find((g) => g.id === detail.id) || null : null;
  // Adapt guest to HodBooking-shape so the shared row + detail modal can render it.
  const adapt = (g: HodGuestlistEntry): HodBooking => ({
    id: g.id,
    ref: (g as any).ref || g.id,
    name: g.name,
    phone: g.phone,
    eventId: g.eventId,
    eventTitle: g.eventTitle,
    type: g.type as any,
    total: 0,
    checkedIn: !!g.checkedIn,
    _isGuestList: true,
    _glDocId: (g as any)._bookingDocId || g.id,
    date: (g.joinedAt || g.entryTime || "").slice(0, 10),
  } as any);

  // 🆕 2026-05-27 v3.99 (Khushi) — in-app confirm overlay for FREE ENTRY
  // (replaces the v3.98 window.confirm which rendered as an alien grey
  // browser popup on the floor tablet — matches the v3.24 cover-edit
  // overlay pattern at line ~640).
  const [confirmFreeEntry, setConfirmFreeEntry] = useState<HodGuestlistEntry | null>(null);

  const handleFreeEntry = async (g: HodGuestlistEntry) => {
    if (busyId === g.id) return;
    setBusyId(g.id);
    try {
      const _source: "booking" | "guestlist" = (g as any)._source === "booking" ? "booking" : "guestlist";
      await ensureZeroBalanceCoverForGuest({
        bookingRef: g.id, sourceDocId: g.id, name: g.name || "Guest", phone: g.phone || "",
        source: _source, eventId: g.eventId || "", eventTitle: g.eventTitle || "", staffName: agentName,
      });
      await checkInGuest(g.id, _source, agentName).catch(() => {});
      toast({
        title: `🎁 Free entry: ${g.name || "Guest"}`,
        description: "₹0 wallet activated · checked in. Customer can top up at bar or via hodclub.in.",
        duration: 6000,
      });
      setDetail(null);
    } catch (e: any) {
      toast({ title: "Free entry failed", description: e?.message || "Try again", variant: "destructive" });
    }
    setBusyId("");
  };

  return (
    <div>
      {checkInTarget && (
        <CheckInPaymentModal
          booking={adapt(checkInTarget)}
          isEntryOnly={false}
          source={((checkInTarget as any)._source === "booking" ? "booking" : "guestlist") as "booking" | "guestlist"}
          sourceKey={checkInTarget.id}
          agentName={agentName}
          onClose={() => setCheckInTarget(null)}
          onConfirmed={({ checkedInAt, wasNew }) => handleCheckInModalConfirmed(checkInTarget, checkedInAt, wasNew)}
        />
      )}
      {detail && detailGuest && (() => {
        // 🆕 2026-05-26 v3.19 (Khushi) — guestlist modal mirrors the v3.15+
        // ticket/table booking modal: Space Grotesk everywhere, structured
        // label→value list (EVENT / NAME / REF / PHONE / TICKET TYPE /
        // QUANTITY / PAYMENT), bigger buttons, NO duplicate top badge.
        // PAYMENT row checks cover.coverActivated (door girl may activate
        // a wallet on a guestlist guest) and shows the actual amount.
        const desc = describeBooking(adapt(detailGuest));
        const cov = covers.find((c) => c.id === detailGuest.id || c.id === (detailGuest as any).ref) || null;
        const coverActivated = Number(cov?.coverActivated || 0);
        const paymentLabel = coverActivated > 0
          ? { txt: `✓ COVER ACTIVATED · ₹${coverActivated.toLocaleString("en-IN")}`, color: "#23A094", bg: "#fff", bd: "#000" }
          : { txt: "🎁 GUEST LIST · FREE ENTRY", color: "#3D3D3D", bg: "#fff", bd: "#000" };
        const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
          <div style={{ display: "grid", gridTemplateColumns: "115px 1fr", gap: 10, padding: "10px 0", borderBottom: "2px solid #000", alignItems: "center" }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, color: "#6B6B6B", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>{label}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#000", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", wordBreak: "break-word" }}>{children}</div>
          </div>
        );
        const phoneClean = (detailGuest.phone || "").replace(/[^\d+]/g, "");
        return (
        <div onClick={() => setDetail(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", zIndex: 100, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto", backdropFilter: "blur(4px)" }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 520, marginTop: 32, background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 18, boxShadow: "none", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
            {/* Header: name only (no duplicate badge, payment lives in list below) */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 26, fontWeight: 900, color: "#000", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: -.3, textTransform: "uppercase" }}>
                {detailGuest.name || "Guest"}
              </div>
            </div>

            {/* CHECKED IN / PENDING status pill */}
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
              {detailGuest.checkedIn ? (
                <span style={{ background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 11, fontWeight: 800, padding: "4px 10px", borderRadius: 6, whiteSpace: "nowrap" }}>✅ CHECKED IN</span>
              ) : (
                <span style={{ background: "#FFD700", border: "2px solid #000", color: "#000", fontSize: 11, fontWeight: 800, padding: "4px 10px", borderRadius: 6 }}>PENDING</span>
              )}
            </div>

            {/* Structured info list */}
            <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: "4px 14px", marginBottom: 14 }}>
              {detailGuest.eventTitle && (
                <Row label="EVENT"><span style={{ color: "#000" }}>🎵 {detailGuest.eventTitle}</span></Row>
              )}
              <Row label="NAME">{detailGuest.name || "—"}</Row>
              {(detailGuest as any).ref && (
                <Row label="REF #"><span style={{ fontFamily: "monospace", color: "#000", letterSpacing: .5 }}>#{(detailGuest as any).ref}</span></Row>
              )}
              {/* v3.91 — strip pre-existing +91 to avoid double-prefix. */}
              {detailGuest.phone && (
                <Row label="PHONE"><span style={{ color: "#000" }}>📞 +91 {String(detailGuest.phone || "").replace(/^\s*(?:\+?91)?[\s-]*/, "")}</span></Row>
              )}
              <Row label="TICKET TYPE">
                <span style={{ background: "#fff", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 900, padding: "4px 12px", borderRadius: 6, letterSpacing: .6, display: "inline-block" }}>
                  {desc.category}
                </span>
              </Row>
              <Row label="QUANTITY">
                <span style={{ fontSize: 17, fontWeight: 900, color: "#000" }}>{desc.breakdown}</span>
              </Row>
              {(detailGuest as any).joinedAt && (
                <Row label="ADDED">
                  <span style={{ color: "#6B6B6B" }}>{String((detailGuest as any).joinedAt).slice(0, 16).replace("T", " ")}</span>
                </Row>
              )}
              <Row label="PAYMENT">
                <span style={{ background: paymentLabel.bg, border: `2px solid ${paymentLabel.bd}`, color: paymentLabel.color, fontSize: 14, fontWeight: 900, padding: "6px 12px", borderRadius: 6, letterSpacing: .5, display: "inline-block" }}>
                  {paymentLabel.txt}
                </span>
              </Row>
            </div>

            {!detailGuest.checkedIn && (
              // 🆕 2026-05-27 v3.99 (Khushi) — guestlist detail modal: green
              // primary CTA opens the in-app FREE ENTRY confirm overlay
              // (rendered below). v3.98 used window.confirm; v3.99 swaps to
              // the v3.24-style in-app overlay so the floor tablet stays in
              // the HOD UI (no alien browser popup).
              <button onClick={() => setConfirmFreeEntry(detailGuest)} disabled={busyId === detailGuest.id}
                style={{ width: "100%", padding: 16, borderRadius: 6, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 16, fontWeight: 900, cursor: "pointer", marginBottom: 10, letterSpacing: .4, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", boxShadow: "none" }}>
                {busyId === detailGuest.id ? "ACTIVATING…" : "🎁 FREE ENTRY"}
              </button>
            )}

            {/* 🆕 2026-05-27 v3.99 — in-app FREE ENTRY confirm overlay (v3.24-style).
                Fail-open: tapping the dark backdrop OR CANCEL closes without
                activating. Uses zIndex 10001 to sit above the booking detail
                modal. ACTIVATE COVER button below remains untouched — door
                girl can use that path if she wants to collect cover instead. */}
            {confirmFreeEntry && (
              <div onClick={() => { if (busyId !== confirmFreeEntry.id) setConfirmFreeEntry(null); }}
                style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", zIndex: 10001, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
                <div onClick={(e) => e.stopPropagation()}
                  style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 22, width: "100%", maxWidth: 360, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", boxShadow: "none" }}>
                  <div style={{ fontSize: 11, fontWeight: 900, color: "#23A094", letterSpacing: 1.5, marginBottom: 14, textAlign: "center" }}>🎁 CONFIRM FREE ENTRY</div>
                  <div style={{ fontSize: 20, fontWeight: 900, color: "#000", textAlign: "center", marginBottom: 4 }}>
                    {confirmFreeEntry.name || "Guest"}
                  </div>
                  <div style={{ fontSize: 12, color: "#6B6B6B", textAlign: "center", marginBottom: 16, letterSpacing: .4 }}>
                    GUESTLIST · NO COVER
                  </div>
                  <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: 12, marginBottom: 16 }}>
                    <div style={{ fontSize: 12, color: "#000", lineHeight: 1.55 }}>
                      ✅ Activate ₹0 wallet for the customer<br/>
                      ✅ Mark guest checked-in
                    </div>
                    <div style={{ fontSize: 11, color: "#6B6B6B", marginTop: 8, fontStyle: "italic" }}>
                      Tap ACTIVATE COVER instead if you want to collect cover at door.
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <button onClick={() => setConfirmFreeEntry(null)} disabled={busyId === confirmFreeEntry.id}
                      style={{ padding: 14, borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 900, letterSpacing: .5, cursor: "pointer", textTransform: "uppercase" }}>
                      CANCEL
                    </button>
                    <button onClick={async () => {
                      const g = confirmFreeEntry;
                      await handleFreeEntry(g);
                      setConfirmFreeEntry(null);
                    }} disabled={busyId === confirmFreeEntry.id}
                      style={{ padding: 14, borderRadius: 6, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 13, fontWeight: 900, letterSpacing: .5, cursor: "pointer", textTransform: "uppercase", boxShadow: "none" }}>
                      {busyId === confirmFreeEntry.id ? "ACTIVATING…" : "YES, FREE ENTRY"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {/* 🆕 2026-05-27 v3.102 (Khushi) — was `setDetail(null)` after
                  onCover, which dismissed the guestlist modal as soon as door
                  girl tapped ACTIVATE COVER. Now the modal stays open under
                  the cover sub-flow; explicit CLOSE button below dismisses it. */}
              <button onClick={() => { onCover(adapt(detailGuest)); }}
                style={{ padding: "16px 12px", borderRadius: 6, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900, cursor: "pointer", letterSpacing: .4 }}>
                💰 ACTIVATE COVER
              </button>
              <button onClick={() => sendGuestlistWhatsApp(detailGuest, onShowQr)}
                style={{ padding: "16px 12px", borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 900, cursor: "pointer", letterSpacing: .4 }}>
                📲 SEND WALLET LINK
              </button>
              <button onClick={() => onShowQr({
                bookingRef: detailGuest.id,
                walletUrl: `https://hodclub.in/?wallet=${encodeURIComponent((detailGuest as any).ref || detailGuest.id)}`,
                customerName: detailGuest.name || "Guest",
                reason: "Show this QR — guest scans to open their guest-list pass instantly.",
              })}
                style={{ padding: "16px 12px", borderRadius: 6, background: "#FFD700", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900, cursor: "pointer", letterSpacing: .4 }}>
                📱 SHOW WALLET QR
              </button>
              {phoneClean && (
                <a href={`tel:${phoneClean}`}
                  style={{ padding: "16px 12px", borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900, cursor: "pointer", textAlign: "center", textDecoration: "none", letterSpacing: .4 }}>
                  📞 CALL
                </a>
              )}
            </div>

            <button onClick={() => setDetail(null)}
              style={{ marginTop: 14, width: "100%", padding: 14, borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 800, cursor: "pointer", letterSpacing: .5 }}>
              CLOSE
            </button>
          </div>
        </div>
        );
      })()}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
        <div onClick={() => setViewMode("all")}
          style={{ background: viewMode === "all" ? "#FF90E8" : "#fff",
            border: "2px solid #000",
            borderRadius: 8, padding: 12, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontVariantNumeric: "tabular-nums", fontSize: 26, fontWeight: 900, color: "#000", lineHeight: 1 }}>{todayGuests.length}</div>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "1px", textTransform: "uppercase", color: "#6B6B6B", marginTop: 6 }}>TONIGHT'S LIST {viewMode === "all" ? "•" : ""}</div>
        </div>
        <div onClick={() => setViewMode("pending")}
          style={{ background: viewMode === "pending" ? "#FFD700" : "#fff",
            border: "2px solid #000",
            borderRadius: 8, padding: 12, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontVariantNumeric: "tabular-nums", fontSize: 26, fontWeight: 900, color: "#000", lineHeight: 1 }}>{pendingGuests}</div>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "1px", textTransform: "uppercase", color: "#6B6B6B", marginTop: 6 }}>YET TO CHECK IN {viewMode === "pending" ? "•" : ""}</div>
        </div>
        <div onClick={() => setViewMode("checked")}
          style={{ background: viewMode === "checked" ? "#23A094" : "#fff",
            border: "2px solid #000",
            borderRadius: 8, padding: 12, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontVariantNumeric: "tabular-nums", fontSize: 26, fontWeight: 900, color: "#000", lineHeight: 1 }}>{checkedIn}</div>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "1px", textTransform: "uppercase", color: "#6B6B6B", marginTop: 6 }}>CHECKED IN {viewMode === "checked" ? "•" : ""}</div>
        </div>
      </div>

      {(() => {
        // Build cover lookup map once per render (parity with BookingsListTab).
        const coverByRef = new Map<string, HodCover>();
        for (const c of covers) {
          if (c.ref) coverByRef.set(c.ref, c);
          if (c.bookingId) coverByRef.set(c.bookingId, c);
        }
        return filtered.map((g) => {
          const adapted = adapt(g);
          const cov = coverByRef.get(adapted.ref) || coverByRef.get(g.id) || null;
          return <BookingRow key={g.id} booking={adapted} cover={cov} onOpen={(b) => setDetail(b)} />;
        });
      })()}
      {filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: 36, color: "#6B6B6B", fontSize: 13, fontWeight: 500 }}>
          {query ? `No matches for "${query}" in today's guest list`
            : viewMode === "checked" ? "No one checked in yet — tap YET TO CHECK IN to see remaining guests"
            : viewMode === "pending" ? "Everyone's checked in! 🎉"
            : "No guests for today"}
        </div>
      )}
    </div>
  );
}

const SRC_STYLES: Record<string, { label: string; color: string; bg: string; border: string }> = {
  swiggy:       { label: "SWIGGY",      color: "#FC8019", bg: "#fff", border: "#000" },
  eazydiner:    { label: "EAZYDINER",   color: "#E73C7E", bg: "#fff", border: "#000" },
  zomato:       { label: "ZOMATO",      color: "#E23744", bg: "#fff", border: "#000" },
  whatsapp_bot: { label: "WA BOT",      color: "#23A094", bg: "#fff", border: "#000" },
  inhouse:      { label: "IN-HOUSE",    color: "#3D3D3D", bg: "#fff", border: "#000" },
};

function ReassignModal({ reservation, agentName, onClose, onReassigned }: {
  reservation: HodTableReservation;
  bookedTableIds?: Set<string>;
  agentName: string;
  onClose: () => void;
  onReassigned?: (tableId: string, section: string) => void;
}) {
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // 🆕 2026-05-27 v3.65 (Khushi LIVE-NIGHT) — keep modal open on success +
  // show inline ✅ banner with the new table. Was auto-closing immediately so
  // door girl couldn't visually confirm the move landed. Door girl now taps
  // CLOSE (or backdrop) when she's done.
  const [successTable, setSuccessTable] = useState<{ id: string; section: string } | null>(null);
  // 🆕 2026-06-02 (Khushi) — replace the native <select> with the SAME live,
  // floor-wise grid picker the door/waitlist already use: GREEN = free,
  // RED 🔒 = taken (shows the pax sitting there), CURRENT = this booking's
  // table. Subscribe across the night window so it mirrors the TABLES tab and
  // updates in real time as guests are seated/moved.
  const [reservations, setReservations] = useState<HodTableReservation[]>([]);
  const [, setTick] = useState(0);
  useEffect(() => {
    const byNight: Record<string, HodTableReservation[]> = {};
    const merge = () => {
      const seen = new Map<string, HodTableReservation>();
      Object.values(byNight).forEach((rows) => rows.forEach((r) => seen.set(r._docId, r)));
      setReservations(Array.from(seen.values()));
    };
    const unsubs = TABLE_WINDOW_DATES().map((n) =>
      subscribeToHodReservations(n, (rows) => { byNight[n] = rows; merge(); }));
    const iv = setInterval(() => setTick((t) => t + 1), 60000); // keep slot-window occupancy fresh
    return () => { unsubs.forEach((u) => { try { u(); } catch (_) {} }); clearInterval(iv); };
  }, []);

  const sectionLabelOf = (sec?: string) => sec ? (SECTION_LABELS[sec] || sec) : "";

  const nowMin = doorNowMinutesIST();
  const pickerGroups = DOOR_TABLE_OPTIONS.map((g) => ({
    floor: g.floor,
    label: g.label,
    tables: g.tables
      .map((id) => {
        const occupant = doorTableOccupantAt(id, nowMin, reservations);
        const isCurrent = id === reservation.tableId;
        const occByOther = !!occupant && (occupant as any)._docId !== reservation._docId;
        return { id, cap: doorTableCapacity(id), isProxy: !!doorProxyLabel(id), occupant, isCurrent, occByOther };
      })
      // FREE first, then taken; within each, smaller capacity first (proxies last).
      .sort((a, b) => {
        const av = a.occByOther ? 1 : 0, bv = b.occByOther ? 1 : 0;
        if (av !== bv) return av - bv;
        return ((a.cap || 999) - (b.cap || 999)) || a.id.localeCompare(b.id);
      }),
  }));
  const freeCount = pickerGroups.reduce((n, g) => n + g.tables.filter((t) => !t.occByOther && !t.isCurrent).length, 0);
  const takenCount = pickerGroups.reduce((n, g) => n + g.tables.filter((t) => t.occByOther).length, 0);

  const submit = async () => {
    if (!picked) { setErr("Pick a table"); return; }
    const t = ALL_TABLES.find((x) => x.id === picked);
    if (!t) { setErr("Invalid table"); return; }
    setBusy(true); setErr("");
    try {
      await reassignTable(reservation._docId, t.id, t.section, sectionLabelOf(t.section), agentName);
      setSuccessTable({ id: t.id, section: sectionLabelOf(t.section) });
      setBusy(false);
      // v3.88 — notify parent so frozen booking prop's gates unlock.
      try { onReassigned && onReassigned(t.id, sectionLabelOf(t.section)); } catch (_) {}
    } catch (e: any) { setErr(e?.message || "Failed"); setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.88)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 22, width: "100%", maxWidth: 420, maxHeight: "85vh", overflow: "auto", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
        <BackBtn onClick={onClose} />
        <div style={{ fontSize: 16, fontWeight: 900, color: "#000", marginBottom: 4 }}>🔄 Reassign Table</div>
        <div style={{ fontSize: 12, color: "#6B6B6B", marginBottom: 14 }}>
          {reservation.customerName || "Guest"} · Currently: <b style={{ color: "#000" }}>{successTable?.id || reservation.tableId || "—"}</b>
        </div>

        {successTable ? (
          <>
            <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: 18, textAlign: "center", marginBottom: 14 }}>
              <div style={{ fontSize: 38, marginBottom: 6 }}>✅</div>
              <div style={{ fontSize: 15, fontWeight: 900, color: "#23A094", letterSpacing: .4, marginBottom: 6 }}>REASSIGN SUCCESSFUL</div>
              <div style={{ fontSize: 13, color: "#000", lineHeight: 1.55 }}>
                {(reservation.customerName || "Guest").toUpperCase()} moved to <b style={{ color: "#000" }}>{successTable.id}</b>{successTable.section ? <> on <b style={{ color: "#000" }}>{successTable.section}</b></> : null}.
              </div>
            </div>
            <button onClick={onClose}
              style={{ width: "100%", padding: 14, borderRadius: 6, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900, cursor: "pointer", letterSpacing: .5 }}>
              CLOSE
            </button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 6, fontWeight: 700, letterSpacing: ".5px" }}>SELECT AVAILABLE TABLE</div>
            <div style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 8, fontWeight: 600, lineHeight: 1.5 }}>
              <span style={{ color: "#23A094", fontWeight: 900 }}>GREEN = free now</span> (tap to pick) ·{" "}
              <span style={{ color: "#FF5733", fontWeight: 900 }}>RED 🔒 = taken</span> (shows pax). Live floor — updates in real time.
            </div>
            <div style={{ fontSize: 12, fontWeight: 900, marginBottom: 12, letterSpacing: ".3px" }}>
              <span style={{ color: "#23A094" }}>✅ {freeCount} FREE</span>
              &nbsp;·&nbsp;
              <span style={{ color: "#FF5733" }}>🔒 {takenCount} TAKEN</span>
            </div>

            {freeCount === 0 && (
              <div style={{ textAlign: "center", padding: 16, border: "2px solid #000", borderRadius: 6, background: "#fff", color: "#FF5733", fontWeight: 900, fontSize: 13, marginBottom: 14 }}>
                NO TABLES FREE RIGHT NOW<br/>
                <span style={{ color: "#6B6B6B", fontWeight: 600, fontSize: 11 }}>Every other table is taken — wait for one to open.</span>
              </div>
            )}

            {pickerGroups.map((g) => (
              <div key={g.floor} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 900, color: "#6B6B6B", letterSpacing: ".5px", marginBottom: 6 }}>{g.label}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                  {g.tables.map((t) => {
                    const disabled = t.occByOther || t.isCurrent;
                    const selected = picked === t.id;
                    const title = t.occByOther && t.occupant
                      ? `TAKEN — ${t.occupant.customerName || ""}${t.occupant.partySize ? " · " + t.occupant.partySize + " pax" : ""}`.trim()
                      : t.isCurrent ? "Current table — pick a different one to move" : "Free — tap to pick";
                    return (
                      <button key={t.id} type="button" disabled={disabled}
                        onClick={() => { setPicked(t.id); setErr(""); }} title={title}
                        style={{
                          padding: "9px 4px", borderRadius: 6,
                          border: "2px solid #000",
                          outline: selected ? "3px solid #FFD700" : "none", outlineOffset: selected ? "-5px" : 0,
                          background: t.occByOther ? "#FF5733" : t.isCurrent ? "#E8E8E0" : selected ? "#FF90E8" : "#23A094",
                          color: t.isCurrent ? "#6B6B6B" : t.occByOther ? "#fff" : selected ? "#000" : "#fff",
                          cursor: disabled ? "not-allowed" : "pointer",
                          fontWeight: 900, fontSize: 12, opacity: t.occByOther ? 0.9 : 1,
                          display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
                        }}>
                        <span>{t.isProxy ? doorProxyLabel(t.id) : t.id}{t.occByOther ? " 🔒" : t.isCurrent ? "" : selected ? " ✓" : ""}</span>
                        <span style={{ fontSize: 9, fontWeight: 700, opacity: 0.9 }}>
                          {t.occByOther ? `${t.occupant?.partySize ?? "?"} pax` : t.isCurrent ? "CURRENT" : t.isProxy ? "flexible" : `${t.cap} seats`}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            {err && <div style={{ fontSize: 12, color: "#FF5733", marginBottom: 10 }}>{err}</div>}

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={onClose} disabled={busy}
                style={{ flex: 1, padding: 12, borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                Cancel
              </button>
              <button onClick={submit} disabled={busy || !picked}
                style={{ flex: 1, padding: 12, borderRadius: 6, background: picked ? "#FF90E8" : "#fff", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 900, cursor: picked ? "pointer" : "not-allowed", opacity: busy ? 0.6 : 1 }}>
                {busy ? "Reassigning..." : "Reassign"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}


// 🔴 2026-05-25 (Khushi LIVE-NIGHT) — TablesTab now accepts `onCover`. Khushi:
// "booked a table for Chiru, he arrived LATE, want to charge cover too —
// guest should have BOTH the table reservation AND a wallet balance".
// We adapt the HodTableReservation → HodBooking (with `_isTable: true` so
// activateCoverForBooking skips the eventTitle copy + the `bookings`-coll
// mirror write — both wrong for table-source rows) and hand off to the
// existing CoverActivationModal. Fallback: if the modal write fails, the
// table reservation + arrival mark stay intact — no data lost.
function TablesTab({ query, agentName, eventId, eventDate, onShowQr, onCover, focusDocId, onFocusConsumed, sourceFilter }: { query: string; agentName: string; eventId: string; eventDate: string; onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void; onCover: (b: HodBooking) => void; focusDocId?: string | null; onFocusConsumed?: () => void; sourceFilter?: "corporate" | "non-corporate" }) {
  const { toast } = useToast();
  const [reservations, setReservations] = useState<HodTableReservation[]>([]);
  const [aggFilter, setAggFilter] = useState<string>("all");
  // Tri-state arrival filter: "" = all, "arrived" = only arrived, "pending" = not yet.
  const [arrivalFilter, setArrivalFilter] = useState<"" | "arrived" | "pending">("");
  // 🆕 NEEDS REVIEW — when ON, narrow the list to aggregator bookings flagged
  // needsManualReview (missing pax/time/phone), mirroring the admin "needs-review"
  // flag at the door so staff can complete them before the guest arrives.
  const [reviewOnly, setReviewOnly] = useState(false);
  const [reassignFor, setReassignFor] = useState<HodTableReservation | null>(null);
  const [arrBusy, setArrBusy] = useState("");
  const [cancelBusy, setCancelBusy] = useState("");
  // 🔴 2026-05-16 (Khushi): door tables redesign — compact rows mirroring
  // captain mode (BookingRow in CaptainMode.tsx ~2842). Selected row opens
  // a detail modal with the full meta + action buttons.
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
  // 🔴 Khushi 16 May — Zomato/aggregator email parsers only reliably extract
  // the guest's name. Pax / arrival time / date must be hand-edited at the
  // door, so the modal has inline-editable inputs backed by these drafts.
  const [editPax, setEditPax] = useState<string>("");
  const [editTime, setEditTime] = useState<string>("");
  const [editDate, setEditDate] = useState<string>("");
  const [editPhone, setEditPhone] = useState<string>(""); // 🔴 Khushi 16 May — Zomato parser leaves phone blank.
  const [editBusy, setEditBusy] = useState(false);
  // 🆕 2026-06-13 (Khushi) — reschedule/save feedback popup. The shared toast
  // rendered BEHIND the expanded booking card (toast viewport z-100 == card
  // z-index) and looked off-brand. This is a self-contained Gumroad-style
  // popup portaled to document.body at a very high z-index so it ALWAYS sits
  // in front (the card root has backdrop-filter, which would trap a non-portal
  // fixed child). Auto-dismisses; tap to close.
  const [editPopup, setEditPopup] = useState<{ kind: "error" | "success"; title: string; body?: string } | null>(null);
  useEffect(() => {
    if (!editPopup) return;
    const t = setTimeout(() => setEditPopup(null), editPopup.kind === "error" ? 5000 : 3500);
    return () => clearTimeout(t);
  }, [editPopup]);
  const today = TODAY_STR();
  const calToday = CALENDAR_TODAY_STR();

  useEffect(() => {
    // Subscribe to both the operational night date AND the calendar today date.
    // Before noon IST they differ: operational night = yesterday, calendar = today.
    // hodclub.in table reservations are written with the calendar date, so we
    // must merge both snapshots to avoid showing zero reservations before noon.
    // v3.143 — RCB go-live: also include NEXT calendar day so tomorrow's table
    // reservations (e.g. 31 May final) show in the Tables tab. Same per-date
    // dedup-and-evict logic, generalised over the night window.
    const seen = new Map<string, HodTableReservation>();
    const merge = () => setReservations(Array.from(seen.values()));
    const nights = Array.from(new Set([today, calToday, addDaysStr(calToday, 1), addDaysStr(calToday, 2)]));
    const unsubs = nights.map((n) =>
      subscribeToHodReservations(n, (rows) => {
        rows.forEach((r) => seen.set(r._docId || r.bookingRef || Math.random().toString(), r));
        // Evict rows that belonged to THIS night but vanished from its snapshot.
        for (const [k, v] of seen) { if ((v.date || "") === n && !rows.find((r) => (r._docId || r.bookingRef) === k)) seen.delete(k); }
        merge();
      }),
    );
    return () => { unsubs.forEach((u) => u()); };
  }, [today, calToday]);

  // 🔴 Reset edit drafts ONLY when the modal opens for a different doc —
  // NOT on every `reservations` snapshot, or live Firestore updates would
  // clobber the captain's in-progress typing (architect review 16 May).
  // We snapshot the row once on open via a ref so this effect's dep array
  // is just [expandedDocId].
  const reservationsRef = useRef(reservations);
  reservationsRef.current = reservations;
  useEffect(() => {
    if (!expandedDocId) return;
    const r = reservationsRef.current.find((x) => x._docId === expandedDocId);
    if (!r) return;
    setEditPax(String(r.partySize || ""));
    setEditTime(r.arrivalTime || "");
    setEditDate(r.date || "");
    setEditPhone(r.phone || "");
  }, [expandedDocId]);

  // 🎯 2026-05-19 (Khushi LIVE-NIGHT) — open a specific table's detail modal
  // when the parent search panel asks us to. Clears arrival/aggregator filters
  // so the row is guaranteed visible underneath the modal, then consumes the
  // token so it doesn't re-open if the user closes the modal.
  useEffect(() => {
    if (!focusDocId) return;
    setAggFilter("all");
    setArrivalFilter("");
    setReviewOnly(false);
    setExpandedDocId(focusDocId);
    onFocusConsumed?.();
  }, [focusDocId, onFocusConsumed]);

  // 2026-05-16 diagnostic — log what tableReservations are loading and why filters drop them.
  // Helps Khushi confirm "0 tables" = no bookings today vs. date-format mismatch vs. status:cancelled.
  useEffect(() => {
    const sources = reservations.reduce((m, r) => {
      const s = (r.source || "(blank)").toLowerCase();
      m[s] = (m[s] || 0) + 1;
      return m;
    }, {} as Record<string, number>);
    const cancelled = reservations.filter((r) => (r as any).status === "cancelled").length;
    console.log("[door][tables] LOADED",
      { total: reservations.length, cancelled, today, calToday, sources },
      reservations.map((r) => ({ ref: r.bookingRef, src: r.source, date: r.date, name: r.customerName, status: (r as any).status }))
    );
  }, [reservations, today, calToday]);

  const activeAllPreFilter = reservations.filter((r) => (r as any).status !== "cancelled");
  // 🔴 2026-05-20 (Khushi) — corporate split. Corporate bookings now have their
  // own dashboard tab; TABLES tab excludes them so they don't double-count.
  const activeAll = sourceFilter === "corporate"
    ? activeAllPreFilter.filter(isCorporateTableRes)
    : sourceFilter === "non-corporate"
      ? activeAllPreFilter.filter((r) => !isCorporateTableRes(r))
      : activeAllPreFilter;
  // 🆕 2026-06-02 v3.171 (Khushi) — EVENT-SCOPED tables. Previously the tables
  // tab showed EVERY reservation across the whole subscription window regardless
  // of the event chip. Now it scopes by date: ALL → TONIGHT only (matching the
  // top counters); a specific event chip → that event's date (so tapping
  // tomorrow's chip shows tomorrow's tables, not tonight's). Tables are physical
  // assets so the eventId match stays lenient (walk-in tables have no eventId);
  // the date scope does the real narrowing.
  const tableDates = eventDateScope(eventId, eventDate);
  const active = activeAll.filter((r) => {
    // 🆕 2026-06-02 v3.181 (Khushi) — a corporate group writes ONE master
    // reservation (carries pax/advance + the full tableIds list) plus one
    // lightweight HOLD doc per EXTRA table. The holds exist ONLY so each held
    // table shows occupied on the floor/captain maps (which read tableReservations
    // via their own subscriptions). In THIS list they must NOT appear as separate
    // rows — collapse the group to the single master row so a 4-table booking for
    // one company shows as ONE entry (pax 60), not four.
    if ((r as any).isGroupHold) return false;
    if (!tableDates.has((r.date || "").slice(0, 10))) return false;
    return eventId === "all" || !(r as any).eventId || (r as any).eventId === eventId;
  });
  const bookedTableIds = new Set(active.map((r) => r.tableId).filter(Boolean) as string[]);

  // 🔴 BUGFIX 2026-05-16 v2 (Khushi) — first fix used a strict equality on
  // ["swiggy","eazydiner","zomato"]. But actual aggregator values written by
  // the email parsers are "swiggy-dineout" / "swiggy-scenes" / "eazydiner" /
  // "zomato" (see AGGREGATOR_OPTIONS in firestore-hod.ts). Strict match meant
  // "swiggy-dineout" fell into IN-HOUSE — that's why SWIGGY=0 and IN-HOUSE
  // showed 23 inflated rows in the screenshot. canonicalAggKey collapses ALL
  // brand variants down to one of 4 buckets used by the chips + dashboard.
  // 2026-05-18 — `whatsapp_bot` added as a 4th aggregator-style source so bot
  // bookings get the green WA BOT chip + auto cover-mint on arrival path
  // instead of being misclassified as in-house in the source filter chips.
  const AGG_KEYS = new Set(["swiggy", "eazydiner", "zomato", "whatsapp_bot"]);
  const canonicalAggKey = (raw: string): "zomato" | "swiggy" | "eazydiner" | "whatsapp_bot" | "inhouse" => {
    const s = (raw || "").toLowerCase().trim();
    if (!s) return "inhouse";
    if (s.includes("zomato")) return "zomato";
    if (s.includes("swiggy")) return "swiggy";          // catches swiggy-dineout, swiggy-scenes
    if (s.includes("eazy") || s.includes("easydiner")) return "eazydiner";
    if (s.includes("whatsapp") || s === "wa_bot") return "whatsapp_bot";
    return "inhouse";
  };
  const effectiveSrc = (r: HodTableReservation) =>
    canonicalAggKey(r.aggregator || r.source || "inhouse");
  const byAgg = aggFilter === "all"
    ? active
    : aggFilter === "inhouse"
      ? active.filter((r) => !AGG_KEYS.has(effectiveSrc(r)))
      : active.filter((r) => effectiveSrc(r) === aggFilter);
  const byArrival =
    arrivalFilter === "arrived" ? byAgg.filter((r) => r.actualArrivalTime) :
    arrivalFilter === "pending" ? byAgg.filter((r) => !r.actualArrivalTime) :
    byAgg;
  // 🆕 NEEDS REVIEW filter — when toggled on, show only rows flagged for manual
  // review. Fail-open: undefined flag → falsy → not in the review subset.
  const byReview = reviewOnly ? byArrival.filter((r) => r.needsManualReview) : byArrival;
  const filtered = byReview.filter((r) => matchQuery(query, r.customerName, r.phone, r.tableId, r.bookingRef));
  // 🔴 2026-05-21 (Khushi) — arrived tables drop to BOTTOM so new arrivals
  // sit at the top. Within each group: earliest arrivalTime (slot) first so
  // the captain sees the next expected guest at the top.
  filtered.sort((a, b) => {
    const ad = !!a.actualArrivalTime, bd = !!b.actualArrivalTime;
    if (ad !== bd) return ad ? 1 : -1;
    const at = String(a.arrivalTime || "");
    const bt = String(b.arrivalTime || "");
    if (!at) return 1;
    if (!bt) return -1;
    return at.localeCompare(bt);
  });

  const arrivedCount = active.filter((r) => r.actualArrivalTime).length;
  const pendingCount = active.length - arrivedCount;
  // 🆕 Count of rows still needing manual review (missing pax/time/phone etc).
  const reviewCount = active.filter((r) => r.needsManualReview).length;
  // 🛟 Anti-lockout: the NEEDS REVIEW banner only renders while reviewCount > 0.
  // If the last flagged row gets resolved (here or on another device) while the
  // review filter is ON, auto-clear it so the list never gets stuck empty with
  // no visible toggle to switch back to ALL.
  useEffect(() => {
    if (reviewOnly && reviewCount === 0) setReviewOnly(false);
  }, [reviewOnly, reviewCount]);

  // Per-aggregator booking counts for the chip badges + mini dashboard.
  const countBySrc: Record<string, number> = { all: active.length, inhouse: 0, swiggy: 0, eazydiner: 0, zomato: 0 };
  active.forEach((r) => {
    const s = effectiveSrc(r);
    if (AGG_KEYS.has(s)) countBySrc[s] = (countBySrc[s] || 0) + 1;
    else countBySrc.inhouse += 1;
  });

  // 🆕 2026-05-27 v3.101 (Khushi) — in-app overlay shown after a successful
  // ARRIVED tap. Replaces the silent toast-only flow with an explicit "GUEST
  // ARRIVED ON <time> · <date>" confirmation so the door girl gets visible
  // closure on a 1-tap action that has irreversible side effects (cover mint
  // + WhatsApp for aggregators). Backdrop tap = dismiss; OK button = dismiss.
  const [arrivedConfirm, setArrivedConfirm] = useState<{ name: string; arrTime: string; date: string; tableId: string } | null>(null);

  const handleArrived = async (r: HodTableReservation) => {
    // 🆕 2026-05-27 v3.71 (Khushi LIVE-NIGHT) — table-assigned gate at the door.
    // Same root cause as v3.68 captain ADD ORDER block: marking a guest
    // arrived without a table id leaves the cover orphaned — captain can't
    // see them on the floor map and the v3.69 chime filter silently
    // suppresses any later BILL DUE alert. Hard-block here with a popup so
    // door girl assigns the table FIRST (Reassign / floor map), THEN marks
    // arrived. Walk-in / aggregator flows unchanged once a table is assigned.
    if (!String(r.tableId || "").trim()) {
      showAppAlert(
        "This guest has no table assigned yet — tap REASSIGN (or pick a table from the floor map) before marking ARRIVED.\n\nThe captain needs a table to take orders and print the bill.",
        "🪑 PLEASE ASSIGN THE TABLE FIRST"
      );
      return;
    }
    // 🔴 Use aggregator-aware resolver — manually created aggregator bookings
    // carry source="inhouse"/"walkin" with the brand on r.aggregator. Without
    // this, isAggregator=false → cover NOT minted, WA NOT sent (silent miss).
    const src = (r.aggregator || r.source || "inhouse").toLowerCase();
    const isAggregator = src !== "inhouse";
    // Aggregator arrival mints a cover + sends WhatsApp = irreversible side effects.
    // Require explicit confirmation to prevent accidental fire.
    if (isAggregator) {
      const srcLabel = SRC_STYLES[src]?.label || src.toUpperCase();
      const confirmed = confirm(
        `Mark ${r.customerName || "guest"} as arrived?\n\n` +
        `This will mint a wallet and send a WhatsApp to ${r.phone || "(no phone)"} ` +
        `via ${srcLabel}. This action cannot be undone from the door tablet.`
      );
      if (!confirmed) return;
    }
    setArrBusy(r._docId);
    let arrTime = "";
    let processedAt = "";
    try {
      // Transactional gate: only fires aggregator side effects (cover mint + WhatsApp)
      // if THIS call was the one that flipped the record from not-arrived → arrived.
      // Concurrent double-taps and retries see wasNew=false and skip side effects.
      const result = await markGuestArrived(r._docId, r.bookingRef, agentName);
      arrTime = result.arrivalTime;
      processedAt = result.processedAt;
      if (!result.wasNew) {
        // 🆕 2026-05-27 v3.101 — even on a no-op re-tap, show the in-app overlay
        // so the door girl gets the same visible confirmation (with the original
        // arrival time) instead of just a silent toast.
        setArrivedConfirm({ name: r.customerName || "Guest", arrTime, date: r.date || "", tableId: r.tableId || "" });
        toast({
          title: `Already arrived: ${r.customerName || "Guest"}`,
          description: `Marked ${arrTime} earlier — no new WhatsApp sent.`,
          duration: 4000,
        });
        setArrBusy("");
        return;
      }
      // 🆕 2026-05-27 v3.101 — surface the in-app overlay as the primary
      // confirmation (toast below stays as the Undo affordance for inhouse).
      setArrivedConfirm({ name: r.customerName || "Guest", arrTime, date: r.date || "", tableId: r.tableId || "" });

      // Aggregator arrivals: customer never went through hodclub.in, so they have
      // no covers doc and never got a HOD WhatsApp. Mint a zero-balance wallet
      // (so the menu URL unlocks for them) and fire WhatsApp via Meta Cloud API.
      if (isAggregator && r.bookingRef) {
        try {
          await ensureCoverForAggregatorArrival({
            bookingRef: r.bookingRef,
            name: r.customerName || "",
            phone: r.phone || "",
            source: src,
            partySize: r.partySize,
            tableId: r.tableId,
            staffName: agentName,
          });
        } catch (e) { console.warn("[door] aggregator cover mint failed", e); }

        const phone = (r.phone || "").replace(/\D/g, "").slice(-10);
        const link = `https://hodclub.in/?wallet=${encodeURIComponent(r.bookingRef)}`;
        const customerName = r.customerName || "Guest";
        const tableLabel = r.tableId || "your table";
        const floorLabel = r.floorLabel || r.floor || "";
        const srcLabel = SRC_STYLES[src]?.label || src.toUpperCase();
        // 🆕 2026-06-02 v3.178 (Khushi) — the arrival WhatsApp now uses the SAME
        // rich "table_confirmed" format as the booking-confirmation message
        // (📅 Date / 🕘 Arrival / 🪑 Table / 👥 Guests / View reservation) instead
        // of the old "table_ready" template ("🪩 Your table is ready… Browse the
        // menu & pre-order"). Khushi wants ONE consistent, scannable layout.
        const dateNice = formatBookingDateNice(r.date);
        const arrivalTime = (r.arrivalTime || "").trim() || "FROM NOW";
        const partySizeStr = String(Math.max(1, Number(r.partySize) || 1));
        const fallbackText =
          `Hi ${customerName}, your HOD table is booked! 🍽️\n\n` +
          `📅 Date: ${dateNice}\n` +
          `🕘 Arrival: ${arrivalTime}\n` +
          `🪑 Table: ${tableLabel} · ${floorLabel}\n` +
          `👥 Guests: ${partySizeStr}\n\n` +
          `Show your QR at the door — we'll have your table ready.\n\n` +
          `View reservation: ${link}\n\n` +
          `See you tonight!\n` +
          `📍 House of Dopamine, Koramangala\n${HOD_LOCATION_URL}`;

        if (phone.length !== 10) {
          // No phone at all — open the QR modal so the guest can scan to get their wallet
          await logNotificationOutcome(r.bookingRef, { status: "no_phone" });
          onShowQr({ bookingRef: r.bookingRef, walletUrl: link, customerName,
            reason: `No valid phone on file from ${srcLabel}. Show this QR to the guest instead.` });
        } else {
          // Send via Meta Cloud API (template → text). On failure show QR popup (NOT wa.me — tablet has no SIM).
          const result = await sendWhatsAppViaMeta({
            phone,
            template: { name: "table_confirmed", params: [customerName, dateNice, arrivalTime, tableLabel, floorLabel, partySizeStr, link] },
            fallbackText,
          });
          if (result.ok) {
            console.log(`[door] WA ${result.via} sent to ${phone}`);
            await logNotificationOutcome(r.bookingRef,
              result.via === "template"
                ? { status: "sent_template", recipient: phone }
                : { status: "sent_text", recipient: phone });
          } else {
            const isTemplateMissing = result.code === 132001 || result.code === 132000 || result.code === 132012 || result.code === 132015;
            const reason = isTemplateMissing
              ? `Template "table_confirmed" not approved by Meta yet, and the guest is outside the 24h reply window.`
              : `Meta WhatsApp: ${result.error || "send failed"}${result.code ? ` (code ${result.code})` : ""}`;
            await logNotificationOutcome(r.bookingRef, { status: "qr_shown", reason, code: result.code });
            onShowQr({ bookingRef: r.bookingRef, walletUrl: link, customerName, reason });
          }
        }
      }
      // Undo toast — only for inhouse (aggregator side effects are irreversible)
      if (!isAggregator) {
        toast({
          title: `🚶 Arrived: ${r.customerName || "Guest"}`,
          description: `Marked at ${arrTime}. Tap Undo within 30s if this was a mistake.`,
          duration: 30000,
          action: (
            <ToastAction altText="Undo arrival" onClick={async () => {
              try {
                // Pass processedAt token so undo only fires if state hasn't changed
                const reversed = await unmarkGuestArrived(r._docId, processedAt, r.bookingRef);
                if (reversed) {
                  toast({ title: "↩️ Arrival reversed", duration: 4000 });
                } else {
                  toast({ title: "Cannot undo", description: "Record was modified — ask a manager.", variant: "destructive", duration: 6000 });
                }
              } catch (e: any) {
                toast({ title: "Undo failed", description: e?.message || "Try the admin dashboard", variant: "destructive" });
              }
            }}>Undo</ToastAction>
          ),
        });
      } else {
        toast({
          title: `🚶 Arrived: ${r.customerName || "Guest"}`,
          description: `Wallet minted, WhatsApp sent. Manager required to reverse.`,
          duration: 6000,
        });
      }
    } catch (e: any) { alert("Failed: " + (e?.message || "")); }
    setArrBusy("");
  };

  const handleCancel = async (r: HodTableReservation) => {
    // 🆕 Khushi: Cancel must be MANAGER-PIN gated via the in-app centered modal
    // (no browser confirm()/prompt()/alert() chrome on the door tablet).
    const who = r.customerName || "guest";
    const tbl = r.tableId ? ` (${r.tableId})` : "";
    const pin = await centeredPinPrompt(`Cancel table booking for ${who}${tbl}? This removes it from tonight's list.`, true);
    if (!pin) return; // CANCEL on the PIN modal = action stays blocked
    let h = "";
    try { h = await sha256(pin.trim()); } catch (_) { h = ""; }
    if (h !== DOOR_MANAGER_HASH) { await centeredAlert("ACCESS DENIED", "Wrong Manager PIN. Booking was NOT cancelled.", "error", true); return; }
    setCancelBusy(r._docId);
    try {
      await cancelTableReservation(r._docId, agentName);
      setExpandedDocId(null);
      await centeredAlert("BOOKING CANCELLED", `${who}${tbl} has been removed from tonight's list.`, "success", true);
    } catch (e: any) {
      await centeredAlert("CANCEL FAILED", e?.message || "Please try again.", "error", true);
    }
    setCancelBusy("");
  };

  const handleWhatsapp = async (r: HodTableReservation) => {
    const phone = (r.phone || "").replace(/\D/g, "").slice(-10);
    const ref = r.bookingRef || "";
    const link = ref ? `https://hodclub.in/?wallet=${encodeURIComponent(ref)}` : "https://hodclub.in";
    const customerName = r.customerName || "Guest";
    const tableLabel = r.tableId || "your table";
    const floorLabel = r.floorLabel || "";
    // 🔴 2026-05-21 (Khushi) — tables now use the new `table_confirmed`
    // template (PENDING Meta approval). 7 params, no payment line because
    // tables don't take pre-payment at the door.
    // Params: [name, dateNice, arrivalTime, tableLabel, floorLabel, partySize, link]
    const dateNice = formatBookingDateNice(r.date);
    const arrivalTime = (r.arrivalTime || "").trim() || "FROM NOW";
    const partySizeStr = String(Math.max(1, Number(r.partySize) || 1));
    const fallbackText =
      `Hi ${customerName}, your HOD table is booked! 🍽️\n\n` +
      `📅 Date: ${dateNice}\n` +
      `🕘 Arrival: ${arrivalTime}\n` +
      `🪑 Table: ${tableLabel} · ${floorLabel}\n` +
      `👥 Guests: ${partySizeStr}\n\n` +
      `Show your QR at the door — we'll have your table ready.\n\n` +
      `View reservation: ${link}\n\n` +
      `See you tonight!\n` +
      `📍 House of Dopamine, Koramangala\n${HOD_LOCATION_URL}`;
    if (phone.length !== 10) {
      if (ref) await logNotificationOutcome(ref, { status: "no_phone" });
      onShowQr({ bookingRef: ref, walletUrl: link, customerName,
        reason: "No valid phone on file. Show this QR to the guest instead." });
      return;
    }
    const result = await sendWhatsAppViaMeta({
      phone,
      template: { name: "table_confirmed", params: [customerName, dateNice, arrivalTime, tableLabel, floorLabel, partySizeStr, link] },
      fallbackText,
    });
    if (result.ok) {
      if (ref) await logNotificationOutcome(ref, result.via === "template"
        ? { status: "sent_template", recipient: phone }
        : { status: "sent_text", recipient: phone });
      alert(`✓ WhatsApp ${result.via === "template" ? "template" : "text"} sent to +91${phone}`);
    } else {
      const isTemplateMissing = result.code === 132001 || result.code === 132000 || result.code === 132012 || result.code === 132015;
      const reason = isTemplateMissing
        ? `Template "table_confirmed" not approved by Meta yet, and the guest is outside the 24h reply window.`
        : `Meta WhatsApp: ${result.error || "send failed"}${result.code ? ` (code ${result.code})` : ""}`;
      if (ref) await logNotificationOutcome(ref, { status: "qr_shown", reason, code: result.code });
      onShowQr({ bookingRef: ref, walletUrl: link, customerName, reason });
    }
  };

  const handleCall = (r: HodTableReservation) => {
    const phone = (r.phone || "").replace(/\D/g, "").slice(-10);
    if (phone.length !== 10) { alert("No valid phone number on file."); return; }
    window.location.href = `tel:+91${phone}`;
  };

  return (
    <div>
      {/* 🆕 2026-06-13 (Khushi) — Gumroad-style save/reschedule popup, portaled
          to document.body so it's ALWAYS in front of the expanded booking card
          (the shared toast rendered behind it). Tap the popup / × to dismiss,
          or it auto-dismisses. Wrapper is pointer-events:none so it never
          blocks taps on the card behind it. */}
      {editPopup && createPortal(
        <div
          style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 2147483000,
            display: "flex", justifyContent: "center", padding: 16, pointerEvents: "none" }}>
          <div onClick={() => setEditPopup(null)}
            style={{ pointerEvents: "auto", cursor: "pointer", width: "100%", maxWidth: 420, marginTop: 10,
              background: "#FFFFFF", border: "3px solid #000", borderRadius: 8,
              boxShadow: "5px 5px 0 #000", overflow: "hidden" }}>
            <div style={{ height: 8, background: editPopup.kind === "error" ? "#FF4D4D" : "#23A094" }} />
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "14px 16px" }}>
              <div style={{ fontSize: 22, lineHeight: 1 }}>{editPopup.kind === "error" ? "⛔" : "✅"}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 900, color: "#000", letterSpacing: .3, textTransform: "uppercase" }}>{editPopup.title}</div>
                {editPopup.body && <div style={{ fontSize: 13, fontWeight: 600, color: "#3D3D3D", marginTop: 3 }}>{editPopup.body}</div>}
              </div>
              <button onClick={() => setEditPopup(null)}
                style={{ background: "#000", color: "#fff", border: "none", borderRadius: 4,
                  width: 26, height: 26, fontSize: 14, fontWeight: 900, cursor: "pointer", lineHeight: 1, flexShrink: 0 }}>×</button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* 🔴 2026-05-16 (Khushi) — mini dashboard. 3 status tiles (tap to filter)
          + per-aggregator strip showing booked-count per source.
          🆕 2026-05-26 v3.25 — bigger fonts (v3.22 pattern). BOOKED/ARRIVED/
          NOT YET numbers bumped 26→32 with Space Grotesk + tabular-nums and
          label 10→11. Tiles sized for both bar tablet and Android phone
          (3-col grid stays responsive — fits even on a 320px viewport). */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
        {([
          { key: "",        label: "Booked",     val: active.length,  color: "#FFD700" },
          { key: "arrived", label: "Arrived",    val: arrivedCount,   color: "#23A094" },
          { key: "pending", label: "Not Yet",    val: pendingCount,   color: "#FF5733" },
        ] as const).map((t) => {
          const on = arrivalFilter === t.key;
          return (
            <div key={t.label} onClick={() => setArrivalFilter((prev) => (prev === t.key ? "" : t.key))}
              style={{
                background: on ? t.color : "#fff",
                border: "2px solid #000",
                borderRadius: 8, padding: "14px 8px", textAlign: "center", cursor: "pointer",
                fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
              }}>
              <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontVariantNumeric: "tabular-nums", fontSize: 32, fontWeight: 900, color: "#000", lineHeight: 1 }}>{t.val}</div>
              <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: "1.2px", textTransform: "uppercase", color: on ? "#000" : "#6B6B6B", marginTop: 6 }}>{t.label} {on ? "•" : ""}</div>
            </div>
          );
        })}
      </div>

      {/* 🆕 2026-06-02 v3.179 (Khushi) — the source breakdown strip is now the
          SOURCE FILTER itself: tap IN-HOUSE / ZOMATO / SWIGGY / EAZYDINER to show
          ONLY that source's bookings; tap the active one again to clear back to
          ALL (same toggle UX as the BOOKED/ARRIVED/NOT-YET cards above). Active
          chip fills with the brand colour. This replaces the old separate
          (easily-missed) AGG_FILTERS chip row — one obvious filter, no dupes.
          ALL is reachable by re-tapping the active chip; a dedicated ALL chip
          is kept on the left so it's always one tap away. */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {(["all", "inhouse", "zomato", "swiggy", "eazydiner"] as const).map((k) => {
          const ss = k === "all" ? null : SRC_STYLES[k];
          const c = ss?.color || "#000";
          const on = aggFilter === k;
          const label = k === "all" ? "ALL" : (ss?.label || k);
          return (
            <button key={k}
              onClick={() => { setAggFilter((prev) => (prev === k ? "all" : k)); setReviewOnly(false); }}
              style={{
                flex: 1, minWidth: 64, cursor: "pointer",
                background: on ? (k === "all" ? "#FF90E8" : c) : "#fff",
                border: "2px solid #000",
                borderRadius: 8, padding: "8px 6px", textAlign: "center",
                fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
              }}>
              <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: "0.6px", color: on ? "#fff" : c, textTransform: "uppercase" }}>{label} {on ? "•" : ""}</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: on ? "#fff" : "#000", marginTop: 4, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{countBySrc[k] || 0}</div>
            </button>
          );
        })}
      </div>

      {/* 🆕 NEEDS REVIEW banner — surfaces the admin "needs-review" flag at the
          door so staff complete missing pax/time/phone before the guest arrives.
          Only shown when ≥1 row is flagged. Tap to filter to just those rows. */}
      {reviewCount > 0 && (
        <button onClick={() => { const next = !reviewOnly; setReviewOnly(next); if (next) setAggFilter("all"); }}
          style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            padding: "12px 14px", marginBottom: 12, borderRadius: 8, cursor: "pointer",
            background: reviewOnly ? "#FFD700" : "#fff",
            border: "2px solid #000",
            color: "#000", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
            fontSize: 13, fontWeight: 900, letterSpacing: .6, textTransform: "uppercase", lineHeight: 1.3 }}>
          ⚠️ {reviewCount} NEED{reviewCount === 1 ? "S" : ""} REVIEW {reviewOnly ? "· SHOWING ONLY THESE — TAP FOR ALL" : "· TAP TO COMPLETE DETAILS"}
        </button>
      )}

      {/* 🔴 2026-05-16 (Khushi) — COMPACT ROWS mirroring captain mode:
          [table pill] [name + agg badge w/ discount + meta] [status pill] [📞 call]
          Tap the row → detail modal with full meta + Arrived/Reassign/WA/Cancel. */}
      {filtered.map((r) => {
        // Canonical aggregator bucket (zomato/swiggy/eazydiner/inhouse) — drives
        // chip filter membership + styling. We keep `aggName` as the RAW brand
        // string so the badge can still show "Swiggy Dineout -30%" etc.
        const src = canonicalAggKey(r.aggregator || r.source || "inhouse");
        const aggName = (r.aggregator || r.source || "inhouse").toLowerCase();
        const isAggregator = src !== "inhouse";
        const aggLabel = AGGREGATOR_OPTIONS.find((a) => a.value === aggName)?.label || aggName.toUpperCase();
        const aggDiscount = (r as any).aggregatorDiscount ?? getAggregatorDiscount(aggName);
        const arrived = !!r.actualArrivalTime;
        const needsReview = !!r.needsManualReview;
        // 🆕 2026-06-02 v3.181 (Khushi) — a corporate group master holds MULTIPLE
        // tables. Show "<n>🪑" in the pill + the full table list in the meta line
        // so one row clearly represents the whole group (not one table per row).
        const grpTables = (Array.isArray((r as any).tableIds) ? (r as any).tableIds : []).filter(Boolean) as string[];
        const isGroupMaster = grpTables.length > 1;
        const tableLabel = isGroupMaster ? `${grpTables.length}🪑` : (r.tableId || "—");

        // 🆕 v3.25 — bigger row fonts to match v3.22 modal pattern.
        // Name 13→15, table pill 11→14, source badge 9→11, meta 10→12,
        // status pill 9→12, padding bumped for thumb taps. PENDING text
        // switches to orange #FB923C (matches v3.22 status color).
        return (
          <div key={r._docId} onClick={() => setExpandedDocId(r._docId)}
            style={{ display: "flex", alignItems: "center", gap: 10,
              padding: "12px 12px", marginBottom: 6, borderRadius: 8,
              background: "#fff",
              border: "2px solid #000",
              cursor: "pointer", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", transition: "background .15s" }}>
            {/* Table id pill */}
            <div style={{ flexShrink: 0, minWidth: 52, textAlign: "center",
              padding: "8px 6px", borderRadius: 6,
              background: "#FFD700", border: "2px solid #000",
              color: "#000", fontSize: 14, fontWeight: 900, letterSpacing: .3, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
              {tableLabel}
            </div>

            {/* Name + agg badge + meta */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 15, fontWeight: 800, color: "#000",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: .2 }}>
                  {r.customerName || "—"}
                </span>
                {isAggregator ? (
                  <span style={{ fontSize: 11, fontWeight: 900, padding: "3px 7px", borderRadius: 6,
                    background: "#fff", border: "2px solid #000", color: "#3D3D3D", letterSpacing: .4, textTransform: "uppercase", fontVariantNumeric: "tabular-nums" }}>
                    {aggLabel}{aggDiscount > 0 ? ` -${aggDiscount}%` : ""}
                  </span>
                ) : (
                  <span style={{ fontSize: 11, fontWeight: 800, padding: "3px 7px", borderRadius: 6,
                    background: "#fff", border: "2px solid #000", color: "#3D3D3D",
                    letterSpacing: .4, textTransform: "uppercase" }}>
                    In-House
                  </span>
                )}
                {needsReview && (
                  <span style={{ fontSize: 10, fontWeight: 900, padding: "3px 7px", borderRadius: 6,
                    background: "#FFD700", color: "#000", letterSpacing: .4, textTransform: "uppercase" }}>
                    ⚠ Review
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: 10, fontSize: 12, color: "#6B6B6B", marginTop: 4, fontWeight: 700, fontVariantNumeric: "tabular-nums", flexWrap: "wrap" }}>
                <span>👥 {r.partySize || "?"}p</span>
                <span>🕐 {r.arrivalTime || "—"}</span>
                {isGroupMaster && <span style={{ color: "#000", fontWeight: 800 }}>🪑 {grpTables.join(", ")}</span>}
                {arrived && <span style={{ color: "#23A094", fontWeight: 800 }}>✓ {r.actualArrivalTime}</span>}
              </div>
            </div>

            {/* Right side: status pill + Call button */}
            <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6 }}>
              {arrived ? (
                <span style={{ fontSize: 11, fontWeight: 900, padding: "4px 9px", borderRadius: 6,
                  background: "#23A094", border: "2px solid #000",
                  color: "#fff", letterSpacing: .4, textTransform: "uppercase" }}>✓ ARRIVED</span>
              ) : (
                <span style={{ fontSize: 11, fontWeight: 900, padding: "4px 9px", borderRadius: 6,
                  background: "#FFD700", border: "2px solid #000",
                  color: "#000", letterSpacing: .4, textTransform: "uppercase" }}>PENDING</span>
              )}
              <button onClick={(e) => { e.stopPropagation(); handleCall(r); }}
                title="Call guest"
                style={{ flexShrink: 0, padding: "8px 11px", borderRadius: 6,
                  background: "#23A094", border: "2px solid #000",
                  color: "#fff", fontSize: 15, fontWeight: 900, cursor: "pointer", lineHeight: 1 }}>
                📞
              </button>
            </div>
          </div>
        );
      })}
      {filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: "#6B6B6B", fontSize: 13, fontWeight: 500 }}>
          {query ? `No matches for "${query}"` : aggFilter !== "all" ? `No ${aggFilter} tables today` : "No table reservations today"}
        </div>
      )}

      {reassignFor && (
        <ReassignModal reservation={reassignFor} bookedTableIds={bookedTableIds} agentName={agentName} onClose={() => setReassignFor(null)} />
      )}

      {/* 🆕 2026-05-27 v3.101 (Khushi) — in-app GUEST ARRIVED confirmation
          overlay. Shown after handleArrived succeeds. zIndex 10002 so it
          sits above the detail modal (9998) AND the reassign modal. */}
      {arrivedConfirm && (
        <div onClick={() => setArrivedConfirm(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", zIndex: 10002, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 24, width: "100%", maxWidth: 360, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", boxShadow: "none", textAlign: "center" }}>
            <div style={{ fontSize: 44, marginBottom: 6 }}>🚶</div>
            <div style={{ fontSize: 11, fontWeight: 900, color: "#23A094", letterSpacing: 1.5, marginBottom: 10 }}>GUEST ARRIVED</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#000", marginBottom: 4, textTransform: "uppercase", wordBreak: "break-word" }}>
              {arrivedConfirm.name}
            </div>
            {arrivedConfirm.tableId && (
              <div style={{ fontSize: 13, color: "#6B6B6B", letterSpacing: .5, marginBottom: 14 }}>
                TABLE {arrivedConfirm.tableId}
              </div>
            )}
            <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: 14, marginBottom: 18 }}>
              <div style={{ fontSize: 11, color: "#6B6B6B", letterSpacing: 1, marginBottom: 4 }}>ARRIVED AT</div>
              <div style={{ fontSize: 26, fontWeight: 900, color: "#23A094", fontVariantNumeric: "tabular-nums", letterSpacing: .5 }}>
                {arrivedConfirm.arrTime || "—"}
              </div>
              {arrivedConfirm.date && (
                <div style={{ fontSize: 12, fontWeight: 700, color: "#6B6B6B", marginTop: 4, letterSpacing: .5 }}>
                  {arrivedConfirm.date}
                </div>
              )}
            </div>
            <button onClick={() => setArrivedConfirm(null)}
              style={{ width: "100%", padding: 14, borderRadius: 6, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 14, fontWeight: 900, letterSpacing: .6, cursor: "pointer", textTransform: "uppercase", boxShadow: "none" }}>
              ✓ OK
            </button>
          </div>
        </div>
      )}

      {/* 🔴 Detail modal — opens on row tap, shows full meta + actions.
          Khushi 16 May: aggregator emails (esp. Zomato) only carry name reliably —
          PAX/TIME/DATE must be hand-editable here at the door. Audit trail kept
          on the doc via lastEditedAt/lastEditedBy (see updateReservationDetails). */}
      {expandedDocId && (() => {
        const r = filtered.find((x) => x._docId === expandedDocId);
        if (!r) return null;
        // Canonical bucket for styling; raw brand name for label lookups.
        const src = canonicalAggKey(r.aggregator || r.source || "inhouse");
        const ss = SRC_STYLES[src] || SRC_STYLES.inhouse;
        const arrived = !!r.actualArrivalTime;
        const tableLabel = r.tableId || "(unassigned)";
        const isAggregator = src !== "inhouse";
        const aggName = (r.aggregator || r.source || "inhouse").toLowerCase();
        const aggDiscount = (r as any).aggregatorDiscount ?? getAggregatorDiscount(aggName);
        return (
          <div onClick={() => setExpandedDocId(null)}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 9998,
              display: "flex", alignItems: "flex-start", justifyContent: "center",
              padding: "20px 12px", overflowY: "auto" }}>
            <div onClick={(e) => e.stopPropagation()}
              style={{ width: "100%", maxWidth: 520, background: "#F4F4F0",
                border: "2px solid #000", borderRadius: 8, padding: 18,
                fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
              {/* 🆕 2026-05-26 v3.22 (Khushi) — Tables detail modal header
                  rebuilt to match the tickets/guestlist pattern: NO cursive
                  (dropped Playfair), Space Grotesk everywhere, BIG sizes so a
                  brand-new door girl reads it at a glance. Top row: TABLE # +
                  source badge (SWIGGY -30% / ZOMATO / EAZYDINER / IN-HOUSE)
                  on the left, CLOSE on the right. Below: guest name 26px 900
                  UPPERCASE in white, floor as a small subtitle. The old
                  separate customer-card removed (name is in the header now). */}
              <BackBtn onClick={() => setExpandedDocId(null)} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0 }}>
                  <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontSize: 26, fontWeight: 900, color: "#000", letterSpacing: 1, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                    {tableLabel}
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 900, letterSpacing: ".8px", padding: "5px 10px", borderRadius: 6, background: ss.bg, border: `2px solid ${ss.border}`, color: ss.color, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", textTransform: "uppercase" }}>
                    {ss.label}{isAggregator && aggDiscount > 0 ? ` -${aggDiscount}%` : ""}
                  </span>
                </div>
                <button onClick={() => setExpandedDocId(null)}
                  style={{ padding: "8px 14px", borderRadius: 6, background: "#fff",
                    border: "2px solid #000", color: "#000",
                    fontSize: 13, fontWeight: 900, cursor: "pointer", letterSpacing: .6,
                    fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", textTransform: "uppercase" }}>
                  ✕ CLOSE
                </button>
              </div>

              {/* Guest name (BIG) + floor subtitle */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontSize: 26, fontWeight: 900, color: "#000", letterSpacing: .5, lineHeight: 1.1, textTransform: "uppercase", wordBreak: "break-word" }}>
                  {r.customerName || "—"}
                </div>
                {(r.floorLabel || r.floor) && (
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#6B6B6B", marginTop: 6, letterSpacing: .8, textTransform: "uppercase", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
                    {r.floorLabel || r.floor}
                  </div>
                )}
              </div>

              {/* Aggregator warning */}
              {isAggregator && !r.tableId && (
                <div style={{ background: "#FFD700", border: "2px solid #000", color: "#000", fontSize: 12, fontWeight: 700, padding: "8px 12px", borderRadius: 8, marginBottom: 12 }}>
                  ⚠️ Check {src === "zomato" ? "Zomato/District" : src} app for full details
                </div>
              )}

              {/* ── EDITABLE META (Khushi: Zomato parser only gets name, so
                  pax / expected time / date must be hand-editable here). */}
              {(() => {
                const paxNum = parseInt(editPax || "0", 10);
                const phoneTrim = (editPhone || "").trim();
                const dirty =
                  paxNum !== (r.partySize || 0) ||
                  (editTime || "") !== (r.arrivalTime || "") ||
                  (editDate || "") !== (r.date || "") ||
                  phoneTrim !== (r.phone || "");
                // 🆕 2026-05-26 v3.22 (Khushi) — bigger Space Grotesk labels
                // + inputs so the door girl can read pax / time / date / phone
                // at a glance. tabular-nums keeps numbers aligned and non-cursive.
                const editLabel: React.CSSProperties = { fontSize: 12, fontWeight: 900, color: "#000", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" };
                const editInput: React.CSSProperties = {
                  width: "100%", padding: "10px 12px", borderRadius: 6,
                  background: "#fff", border: "2px solid #000",
                  color: "#000", fontSize: 17, fontWeight: 800, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", outline: "none",
                  fontVariantNumeric: "tabular-nums",
                };
                return (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                      <div style={{ padding: 10, background: "#fff", border: "2px solid #000", borderRadius: 8 }}>
                        <div style={editLabel}>👥 Party (edit)</div>
                        <input type="number" min={1} max={50} value={editPax}
                          onChange={(e) => setEditPax(e.target.value)} style={editInput} />
                      </div>
                      <div style={{ padding: 10, background: "#fff", border: "2px solid #000", borderRadius: 8 }}>
                        <div style={editLabel}>🕐 Expected (edit)</div>
                        <input type="time" value={doorTo24h(editTime)}
                          onChange={(e) => setEditTime(doorTo12h(e.target.value))} style={editInput} />
                      </div>
                      <div style={{ padding: 10, background: "#fff", border: "2px solid #000", borderRadius: 8 }}>
                        <div style={editLabel}>📅 Date (edit)</div>
                        <input type="date" value={editDate} min={CALENDAR_TODAY_STR()}
                          onChange={(e) => setEditDate(e.target.value)} style={editInput} />
                      </div>
                      <div style={{ padding: 10, background: "#fff", border: "2px solid #000", borderRadius: 8 }}>
                        <div style={editLabel}>Status</div>
                        <div style={{ fontSize: 17, fontWeight: 900, color: arrived ? "#23A094" : "#FF5733", marginTop: 4, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", letterSpacing: .6, textTransform: "uppercase", fontVariantNumeric: "tabular-nums" }}>
                          {/* 🆕 2026-05-27 v3.101 (Khushi) — was `✓ ${arrived}`
                              which rendered as "✓ TRUE" (arrived is a boolean).
                              Now shows the actual stamped arrival time. */}
                          {arrived ? `✓ ${r.actualArrivalTime}` : "PENDING"}
                        </div>
                      </div>
                    </div>

                    {/* 📞 PHONE (Khushi 16 May) — Zomato parser leaves this
                        blank; door staff types it in here. Saves to the same
                        Firestore doc that admin/reports/Sheets sync all read,
                        so the number propagates everywhere automatically. */}
                    <div style={{ padding: 10, background: "#fff", border: "2px solid #000", borderRadius: 8, marginBottom: 10 }}>
                      <div style={editLabel}>📞 Phone (edit)</div>
                      <input type="tel" inputMode="tel" placeholder="10-digit mobile e.g. 9611111261"
                        value={editPhone}
                        onChange={(e) => setEditPhone(e.target.value)}
                        style={editInput} />
                      {phoneTrim && !/^[+\d][\d\s-]{8,18}$/.test(phoneTrim) && (
                        <div style={{ fontSize: 10, color: "#FF5733", marginTop: 4, fontWeight: 700 }}>
                          ⚠ Doesn't look like a valid phone — save will be rejected.
                        </div>
                      )}
                    </div>

                    {/* Save bar — only appears once a field is dirty so staff
                        never push accidental writes. Fallback: if save fails
                        the alert tells the captain to retry or note manually. */}
                    {dirty && (
                      <button
                        disabled={editBusy}
                        onClick={async () => {
                          if (editBusy) return;
                          // 🆕 2026-06-13 (Khushi) — block RESCHEDULING into the past.
                          // The edit DATE/TIME pickers let staff move a booking to an
                          // earlier date, or (on today) an earlier clock time, which
                          // then resurfaced as a stale past booking. ONLY validate when
                          // the date/time was actually CHANGED — a pax/phone-only edit on
                          // an already-old booking must still be allowed to save.
                          {
                            const dateChanged = (editDate || "") !== (r.date || "");
                            const timeChanged = (editTime || "") !== (r.arrivalTime || "");
                            const todayStr = CALENDAR_TODAY_STR();
                            if ((dateChanged || timeChanged) && editDate && editDate < todayStr) {
                              setEditPopup({ kind: "error", title: "Can't reschedule to the past", body: "Pick today or a future date." });
                              return;
                            }
                            if ((dateChanged || timeChanged) && editDate === todayStr && editTime) {
                              const m = doorParseClockToMinutes(editTime);
                              if (m != null && m < doorNowMinutesIST()) {
                                setEditPopup({ kind: "error", title: "That time has already passed", body: "Pick a time from now onward." });
                                return;
                              }
                            }
                          }
                          setEditBusy(true);
                          try {
                            await updateReservationDetails(r._docId, {
                              partySize: paxNum > 0 ? paxNum : undefined,
                              arrivalTime: editTime || undefined,
                              date: editDate || undefined,
                              phone: phoneTrim || undefined,
                            }, agentName);
                            setEditPopup({ kind: "success", title: "Updated", body: "Pax / time / date / phone saved everywhere." });
                          } catch (err: any) {
                            setEditPopup({ kind: "error", title: "Save failed", body: err?.message || "Try again or note on paper." });
                          }
                          setEditBusy(false);
                        }}
                        style={{ width: "100%", padding: "12px", borderRadius: 6, marginBottom: 12,
                          background: "#FF90E8", border: "2px solid #000",
                          color: "#000", fontSize: 13, fontWeight: 900, letterSpacing: .6, cursor: "pointer" }}>
                        {editBusy ? "Saving…" : "💾 SAVE CHANGES"}
                      </button>
                    )}
                  </>
                );
              })()}

              {/* ── ACTION BUTTONS (Khushi 16 May: Arrived + Reassign.
                  Call stays as the icon on the row itself; WA + Cancel removed.)
                  🔴 2026-05-25 (Khushi LIVE-NIGHT) — added 💰 ACTIVATE COVER
                  so a late-arriving table guest can be charged a cover wallet
                  on top of their reservation. Builds a synthetic HodBooking
                  (ref = bookingRef, _isTable: true → activateCoverForBooking
                  skips the eventTitle copy + bookings-coll mirror) and pipes
                  it through the existing CoverActivationModal. Result: the
                  guest now has BOTH a table reservation AND a wallet balance.
                  Disabled until Arrived is marked (cover requires the guest
                  to actually be inside the venue — fail-safe against bouncer
                  pre-charging a no-show). Fallback: cover write failures
                  leave the arrival mark + reservation intact, no data lost. */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {!arrived && (
                  <button onClick={() => handleArrived(r)} disabled={arrBusy === r._docId}
                    style={{ padding: "15px 6px", borderRadius: 6, background: "#23A094", border: "2px solid #000", color: "#fff", fontSize: 15, fontWeight: 900, letterSpacing: .3, lineHeight: 1.15, cursor: "pointer", boxShadow: "none" }}>
                    {arrBusy === r._docId ? "Marking…" : "🚶 Arrived"}
                  </button>
                )}
                <button
                  onClick={() => {
                    if (!arrived) {
                      alert("⚠️ Mark guest as 🚶 Arrived first, THEN activate cover.");
                      return;
                    }
                    const refId = r.bookingRef || r._docId;
                    // Synthetic HodBooking for CoverActivationModal. _isTable
                    // is the critical flag — activateCoverForBooking branches
                    // on it (skips bookings-coll mirror + eventTitle copy).
                    const syntheticBooking: HodBooking = {
                      id: refId,
                      ref: refId,
                      name: r.customerName || "Guest",
                      phone: r.phone || "",
                      date: r.date || "",
                      total: 0,           // no online prepayment on tables
                      paymentId: "",      // → activateCover treats paidOnline=0
                      checkedIn: true,
                      _isTable: true,
                      _isGuestList: false,
                      eventId: "",
                      eventTitle: "",
                      // 🆕 2026-06-02 v3.178 (Khushi) — carry the TABLE onto the
                      // synthetic booking so activateCoverForBooking stamps
                      // tableId/floorLabel onto the covers doc. Without these the
                      // activated wallet showed a balance but NO table number.
                      // activateCoverForBooking reads `_tableId||tableId` +
                      // `_floorLabel||floorLabel` (firestore-hod.ts ~L916).
                      _tableId: r.tableId || "",
                      tableId: r.tableId || "",
                      _floorLabel: r.floorLabel || r.floor || "",
                      floorLabel: r.floorLabel || r.floor || "",
                    } as HodBooking;
                    onCover(syntheticBooking);
                    setExpandedDocId(null);
                  }}
                  title={arrived ? "Charge a cover wallet (e.g. late arrival)" : "Mark Arrived first"}
                  style={{
                    padding: "15px 6px", borderRadius: 6,
                    background: arrived ? "#FFD700" : "#fff",
                    border: "2px solid #000",
                    color: arrived ? "#000" : "#6B6B6B",
                    fontSize: 15, fontWeight: 900, letterSpacing: .3, lineHeight: 1.15, cursor: "pointer",
                    opacity: arrived ? 1 : 0.7,
                    boxShadow: "none",
                  }}>
                  💰 Activate Cover
                </button>
                {/* 🆕 2026-05-27 v3.48 (Khushi LIVE-NIGHT) — Reassign locks
                    once the guest is ARRIVED. Once seated, KOTs are tagged to
                    their table and any reassignment from the door tablet
                    would leave kitchen/bar tickets pointing at the wrong
                    table. Captain has their own table-move flow that also
                    re-stamps in-flight rounds. Disabled state still renders
                    so door staff sees WHY (avoid silent missing button). */}
                <button
                  onClick={() => {
                    if (arrived) {
                      alert("🪑 GUEST ALREADY ARRIVED AT THIS TABLE.\n\nReassign locked here — KOTs are tagged to this table.\n\nAsk the CAPTAIN to move the guest from Captain Mode (re-stamps active rounds).");
                      return;
                    }
                    // 🆕 v3.66 Khushi: keep the detail modal mounted under the
                    // ReassignModal so CLOSE on the success banner lands the
                    // door girl back on the customer row (C3 → CHICHU), not
                    // the bare dashboard. Reservation prop is live from
                    // Firestore so the new table # is reflected.
                    setReassignFor(r);
                  }}
                  disabled={arrived}
                  title={arrived ? "Guest already arrived — captain handles table moves" : "Move guest to a different table"}
                  style={{
                    padding: "15px 6px", borderRadius: 6,
                    background: arrived ? "#F4F4F0" : "#fff",
                    border: arrived ? "2px dashed #000" : "2px solid #000",
                    color: arrived ? "#B0B0B0" : "#000",
                    fontSize: 15, fontWeight: 900, letterSpacing: .3, lineHeight: 1.15,
                    cursor: arrived ? "not-allowed" : "pointer",
                    opacity: arrived ? 0.6 : 1,
                  }}>
                  {arrived ? "🔒 Reassign" : "🔄 Reassign"}
                </button>
                {/* 🆕 Khushi 2026-06-02 — SHOW QR. Opens the scannable wallet QR
                    so the door girl can let a guest scan to open their menu/tab
                    on the spot (e.g. no phone on file / WhatsApp didn't land).
                    Pink Gumroad accent. Always available — no arrival gate. */}
                <button
                  onClick={() => {
                    const refId = r.bookingRef || r._docId;
                    const link = `https://hodclub.in/?wallet=${encodeURIComponent(refId)}`;
                    onShowQr({
                      bookingRef: refId,
                      walletUrl: link,
                      customerName: r.customerName || "Guest",
                      reason: "Show this QR to the guest — scan to open the menu & tab.",
                    });
                  }}
                  title="Show the guest a scannable QR for their menu & tab"
                  style={{
                    padding: "15px 6px", borderRadius: 6,
                    background: "#FF90E8", border: "2px solid #000",
                    color: "#000", fontSize: 15, fontWeight: 900, letterSpacing: .3, lineHeight: 1.15,
                    cursor: "pointer", boxShadow: "none",
                  }}>
                  📷 Show QR
                </button>
              </div>

              {/* 🆕 Khushi — CANCEL BOOKING. Manager-PIN gated via the in-app
                  centered modal (no browser popups). Removes the reservation
                  from tonight's list (e.g. test/dummy bookings). Full-width
                  row of its own so it never gets mis-tapped with Arrived. */}
              <button onClick={() => handleCancel(r)} disabled={cancelBusy === r._docId}
                style={{ marginTop: 8, width: "100%", padding: "13px 6px", borderRadius: 6, background: "#FF5733", border: "2px solid #000", color: "#fff", fontSize: 14, fontWeight: 900, letterSpacing: .3, lineHeight: 1.15, cursor: cancelBusy === r._docId ? "wait" : "pointer", opacity: cancelBusy === r._docId ? 0.6 : 1 }}>
                {cancelBusy === r._docId ? "Cancelling…" : "✕ Cancel Booking"}
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

const HOD_SITE = "https://hodclub.in";

// 2026-05-12 (Khushi spec) — full walk-in redesign. 5 boxes, yellow/black
// palette, in-house form modals (no more bouncing to hodclub.in). Each
// non-aggregator flow collects name/email/phone + flow-specific fields and
// writes directly to Firestore via createWalkIn{Ticket,Guestlist} so the
// new bookings appear in tonight's tabs immediately.
type WalkInChoice = "guestlist" | "cover" | "onlyentry" | "group" | "agg";

// 2026-05-12 (Khushi): rebuilt to mirror the hodclub.in customer modal
// (see screenshot in chat). One unified sheet: 2×2 category grid at top
// acts as a tab switcher, ENTRY TYPE pricing cards in the middle, then
// "ENTER YOUR DETAILS" form, ticket stepper, total summary, single CTA.
// Switching categories preserves name/email/phone. Aggregator stays
// reachable via a small link below the CTA (kept out of the 2×2 grid
// because the customer-facing modal only shows 4 cards).
// 🔴 2026-05-19 (Khushi LIVE-NIGHT) — door-side WALK-IN TABLE BOOKING modal.
// Quick capture: name, phone, party size, arrival time, optional table picker.
// Writes via createWalkInTableReservation -> tableReservations (source=inhouse).
// Fallback: leave table blank if customer hasn't picked one; Captain can
// assign it from Captain Mode later. Date defaults to operational night.
// 🔴 2026-05-20 (Khushi LIVE-NIGHT) — authoritative floor layout per Khushi
// GF: C1-C4 + 2 VVIP only. FF/DINING: all FD* + SMK*. ROOFTOP: T1-T11 +
// TVIP* + TEX1. Removed phantom FD13 + SMK3 which don't exist on venue.
// 🆕 2026-06-02 (Khushi) — 4 distinct floors in the door picker:
// GROUND · FIRST/DINING · SMOKING ZONE · ROOFTOP. Smoking is now its own
// floor (was merged into Dining). VIP tables sit UNDER their parent floor
// (Ground: CVIP1/2 · Rooftop: TVIP1-7 + TEX1) and group into the same
// capacity rows. FD13 + SMK3 stay excluded (phantom — not on the venue).
// 🆕 2026-06-02 (Khushi) — TEMPORARY flexible proxy tables added to EVERY real
// floor (NOT a separate floor). Each floor gets 3 generic proxies shown to the
// door girl as "PROXY 1 / PROXY 2 / PROXY 3". Their seating capacity is
// flexible (2, 3, 4, 6 or 8 — the Captain adjusts/assigns the real seats),
// so they group into their OWN "PROXY" section, not a fixed PAX row.
// Internally each proxy uses a floor-unique id (GR-PX1 …) so availability
// never collides across floors, but the DISPLAY label is just "PROXY N".
// They live ONLY in the door picker — NOT added to tables-config — so
// Captain/Admin floor plans are untouched. Real small-table plan comes later.
// 🆕 2026-06-02 (Khushi) — DOOR_TABLE_OPTIONS + doorProxyLabel/doorTableCapacity +
// the time-aware occupancy helpers (doorParseClockToMinutes / doorNowMinutesIST /
// doorTableOccupantAt) now live in @/lib/door-tables so the WAITLIST assign-table
// picker shares the EXACT same config + availability logic (imported at top).

// 🆕 2026-06-12 v3.268 (Khushi) — native clock-picker helpers. The Door form
// stores arrival as a friendly 12-hour string ("9:30 PM") used VERBATIM in the
// WhatsApp templates + every display, but <input type="time"> works in 24-hour
// "HH:MM". These convert between the two so the captain/door girl gets the
// native clock dropdown while everything downstream keeps the 12-hour text.
function doorTo24h(s: string): string {
  const min = doorParseClockToMinutes(s);
  if (min == null) return "";
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function doorTo12h(s: string): string {
  const min = doorParseClockToMinutes(s);
  if (min == null) return "";
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;
}

type TableBookingTab = "tables" | "aggregator" | "corporate";

function NewTableBookingModal({ agentName, onClose, onActivateCoverTable }: {
  agentName: string;
  onClose: () => void;
  // 🔴 2026-05-20 (Khushi) — COVER+TABLE flow. Door girl creates the table
  // AND opens the standard wallet layout to recharge cover. Parent opens
  // UnifiedWalkInModal pre-filled + linked to the just-created table ref.
  onActivateCoverTable: (ctx: {
    tableResRef: string;
    arrivalTime: string;
    prefill: { name: string; phone: string; email: string; pax: number; girls: number; boys: number };
    tableInfo: { tableId?: string; floorLabel?: string; amenitiesTotal: number; amenitiesLabel: string };
  }) => void;
}) {
  const [tab, setTab] = useState<TableBookingTab>("tables");

  // Shared fields across all 3 tabs
  const [name, setName]   = useState("");
  const [phone, setPhone] = useState("");
  // 🆕 2026-06-02 (Khushi) — phone country code (default +91 India), mirrors
  // the walk-in modal. The booking still stores the bare 10-digit number;
  // the door table WhatsApp path is +91-only, so this is for parity/intent.
  const [countryCode, setCountryCode] = useState("+91");
  const [email, setEmail] = useState("");
  // 🆕 2026-06-02 (Khushi) — split party size into GIRLS + BOYS (was a single
  // "Pax" box). Total pax = girls + boys, fed into capacity/availability.
  const [girls, setGirls] = useState(1);
  const [boys, setBoys]   = useState(1);
  const pax = Math.max(1, (Number(girls) || 0) + (Number(boys) || 0));
  // 🆕 2026-06-02 — custom Gumroad floor dropdown open/closed state.
  const [floorMenuOpen, setFloorMenuOpen] = useState(false);
  const [aggMenuOpen, setAggMenuOpen] = useState(false);
  const [advanceModeMenuOpen, setAdvanceModeMenuOpen] = useState(false);
  // 🆕 2026-06-02 (Khushi) — in-app success screen (replaces the browser
  // alert()). Holds the booking details + WhatsApp/email outcome + wallet QR.
  const [tableDone, setTableDone] = useState<null | {
    ref: string; summary: string; date: string; guest: string;
    pax: number; arrival: string; tableLabel: string; floorLabel: string;
    walletUrl: string; waStatus: string; emailStatus: string;
    // 🆕 2026-06-02 (Khushi) — corporate bookings get NO wallet/QR (their menu
    // differs); the done screen shows a confirmation summary instead.
    isCorporate?: boolean; companyName?: string; advanceLine?: string;
    // 🆕 2026-06-02 v3.181 (Khushi) — special-amenities (e.g. Valet) total +
    // labels, shown as an ADD-ONS row on the confirmation card.
    amenitiesLine?: string;
    // 🆕 2026-06-02 v3.182 (Khushi) — contact phone on the confirmation card so
    // the door girl can read back / call the person who made the booking.
    contactPhone?: string;
  }>(null);
  // 🔴 2026-05-19 — editable booking date (defaults to tonight's operational
  // night). Khushi: door can take a phone reservation for a future night.
  // 🔴 2026-05-20 (Khushi) — must use IST calendar date, not operational-night.
  // TODAY_STR() shifts back to yesterday before noon IST (operational night
  // logic) which made the booking calendar show 19th when India was already
  // on the 20th. CALENDAR_TODAY_STR() = true IST date.
  const [bookingDate, setBookingDate] = useState<string>(() => CALENDAR_TODAY_STR());
  // 🆕 2026-06-02 (Khushi) — arrival must reflect the LIVE clock at the moment
  // the table is created, NOT the moment the modal opened. Door girls fill the
  // form + chit-chat for several minutes; previously the time stayed frozen at
  // open-time. We now tick the field live every 15s while the girl hasn't
  // hand-edited it; once she types her own time we stop auto-updating it.
  const fmtNowArrival = () => {
    const d = new Date();
    let mins = d.getHours() * 60 + d.getMinutes();
    mins = Math.ceil(mins / 5) * 5;
    const h24 = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    const ampm = h24 >= 12 ? "PM" : "AM";
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;
  };
  const [arrival, setArrival] = useState(fmtNowArrival);
  const [arrivalEdited, setArrivalEdited] = useState(false);
  useEffect(() => {
    if (arrivalEdited) return;
    const id = setInterval(() => setArrival(fmtNowArrival()), 15000);
    return () => clearInterval(id);
  }, [arrivalEdited]);
  const [floor, setFloor]   = useState("");
  const [tableId, setTable] = useState("");
  // 🆕 2026-06-02 (Khushi) — CORPORATE bookings can hold 1 OR MULTIPLE tables on
  // the SAME floor (single-select stays for Tables/Aggregator via tableId).
  const [corpTableIds, setCorpTableIds] = useState<string[]>([]);
  const [notes, setNotes]   = useState("");

  // AGGREGATOR-only fields
  const [aggregator, setAggregator] = useState<string>("zomato");
  const [aggDiscount, setAggDiscount] = useState<number>(0);
  const [externalRef, setExternalRef] = useState("");

  // CORPORATE-only fields
  const [companyName, setCompanyName] = useState("");
  // 🔴 2026-05-20 (Khushi) — advance paid by the group BEFORE the night
  const [advanceAmount, setAdvanceAmount] = useState<number>(0);
  const [advanceMode, setAdvanceMode]     = useState<"" | "cash" | "upi" | "bank-transfer" | "card" | "other">("");
  const [advanceRef, setAdvanceRef]       = useState("");

  // 🔴 2026-05-19 (Khushi LIVE-NIGHT) — Special Amenities checklist (Valet,
  // Decor, Cake, DJ, …). Tick to include, edit price/qty, add custom row.
  // Same UI for all 3 tabs — stored in `amenities[]` + `amenitiesTotal` so
  // Reports can attribute add-on revenue per booking source.
  type AmRow = { name: string; price: number; qty: number; included: boolean };
  const [amenitiesOpen, setAmenitiesOpen] = useState(false);
  const [amenities, setAmenities] = useState<AmRow[]>(() =>
    DEFAULT_BOOKING_AMENITIES.map((a) => ({ ...a, included: false }))
  );
  const [customAmName, setCustomAmName] = useState("");
  const [customAmPrice, setCustomAmPrice] = useState<number>(0);
  const updateAm = (i: number, patch: Partial<AmRow>) =>
    setAmenities((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeAm = (i: number) =>
    setAmenities((rows) => rows.filter((_, idx) => idx !== i));
  const addCustomAm = () => {
    const n = customAmName.trim();
    if (!n) return;
    setAmenities((rows) => [...rows, { name: n, price: Math.max(0, customAmPrice || 0), qty: 1, included: true }]);
    setCustomAmName(""); setCustomAmPrice(0);
  };
  const includedAmenities: BookingAmenity[] = amenities
    .filter((r) => r.included)
    .map((r) => ({ name: r.name, price: Math.max(0, Number(r.price) || 0), qty: Math.max(1, Number(r.qty) || 1) }));
  const amenitiesTotal = includedAmenities.reduce((s, a) => s + a.price * a.qty, 0);

  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState("");

  const floorOpt = DOOR_TABLE_OPTIONS.find((g) => g.floor === floor);

  // 🔴 2026-05-19 (Khushi LIVE-NIGHT) — live table availability across all
  // 3 tabs. Subscribes to the picked booking date (not "today"), so future
  // reservations honor the chosen night. Same time-window logic as CaptainMode.
  const [liveReservations, setLiveReservations] = useState<HodTableReservation[]>([]);
  useEffect(() => {
    if (!bookingDate) return;
    const unsub = subscribeToHodReservations(bookingDate, (rows) => setLiveReservations(rows));
    return () => unsub();
  }, [bookingDate]);
  const targetMin = doorParseClockToMinutes(arrival) ?? doorNowMinutesIST();

  // Aggregator dropdown options (exclude in-house — that's the Tables tab)
  const aggOptions = AGGREGATOR_OPTIONS.filter((a) => a.value !== "inhouse");

  const switchTab = (t: TableBookingTab) => {
    setErr("");
    setTab(t);
    // 🆕 2026-06-02 (Khushi) — aggregator discount ALWAYS defaults to 0; the
    // door girl types the real % manually (no auto-applied per-aggregator %).
    if (t === "aggregator") {
      setAggDiscount(0);
    }
    // Leaving the corporate tab clears any multi-table selection.
    if (t !== "corporate") setCorpTableIds([]);
  };

  // 🆕 2026-06-13 (Khushi) — block PAST-dated bookings. The native <input type=date>
  // `min` only greys out earlier days in the calendar popup; it does NOT stop a
  // typed or programmatically-set past date, so a door girl was able to book the
  // 10th on the 13th. Enforce it here at submit for EVERY create path. Floor =
  // IST calendar today (same value the input min uses), compared as ISO
  // YYYY-MM-DD strings (lexicographic === chronological for that format).
  const pastBookingDateErr = (): string | null => {
    const floor = CALENDAR_TODAY_STR();
    return bookingDate && bookingDate < floor
      ? `Booking date can't be in the past — earliest is ${formatBookingDateNice(floor)}.`
      : null;
  };

  // 🆕 2026-06-13 (Khushi) — auto-unlock the customer menu for a table that is
  // HAPPENING NOW. Creating a table only writes the reservation; the menu stays
  // LOCKED until staff scan the table & tap ARRIVED (which stamps arrival + the
  // cover doc). That's correct for an advance booking, but pointless for a guest
  // standing at the door right now. So unlock at create time ONLY when:
  //   • the booking is for TODAY (calendar IST) — any future DATE stays locked; and
  //   • the arrival time is at/around the PRESENT time — "now or already due"
  //     (arrival minutes-since-midnight <= now + UNLOCK_GRACE_MIN). A booking
  //     made this morning for an EVENING slot is far in the future → stays locked
  //     and unlocks normally when the guest actually arrives.
  // Comparing minutes-since-midnight (both IST) keeps it a pure wall-clock check.
  const UNLOCK_GRACE_MIN = 30;
  const shouldUnlockNow = (): boolean => {
    if (bookingDate !== CALENDAR_TODAY_STR()) return false;
    const arrMin = doorParseClockToMinutes(arrival);
    if (arrMin == null) return false;
    return arrMin <= doorNowMinutesIST() + UNLOCK_GRACE_MIN;
  };

  const submit = async () => {
    setErr("");
    if (!name.trim())  { setErr(tab === "corporate" ? "Enter contact name" : "Enter guest name"); return; }
    if (!phone.trim() || phone.replace(/\D/g, "").length < 10) { setErr("Enter valid 10-digit phone"); return; }
    if (!bookingDate) { setErr("Pick a booking date"); return; }
    { const pd = pastBookingDateErr(); if (pd) { setErr(pd); return; } }
    if (!arrival.trim()) { setErr("Enter arrival time"); return; }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setErr("Email looks invalid — leave blank or fix"); return; }
    if (tab === "corporate" && !companyName.trim()) { setErr("Enter company name"); return; }
    if (tab === "corporate" && advanceAmount > 0 && !advanceMode) { setErr("Pick how the advance was paid"); return; }
    setBusy(true);
    try {
      let refId = "";
      let summary = "";
      const sharedExtras = {
        email: email.trim() || undefined,
        amenities: includedAmenities.length ? includedAmenities : undefined,
      };
      if (tab === "tables") {
        const unlockNow = shouldUnlockNow();
        refId = await createWalkInTableReservation({
          customerName: name.trim(), phone: phone.trim(), partySize: pax,
          date: bookingDate, arrivalTime: arrival.trim(),
          tableId: tableId || undefined, floor: floor || undefined,
          floorLabel: floorOpt?.label || undefined,
          notes: notes.trim() || undefined, staffName: agentName,
          // Same-day, happening-now table → unlock the customer menu immediately
          // (stamp arrival + write the cover doc). A future date or a later-tonight
          // slot stays locked and unlocks normally on scan + ARRIVED.
          markArrived: unlockNow, unlockMenu: unlockNow,
          ...sharedExtras,
        });
        summary = "TABLE BOOKING (IN-HOUSE)";
      } else if (tab === "aggregator") {
        refId = await createAggregatorTableBooking({
          aggregator,
          discountPercent: aggDiscount,
          customerName: name.trim(), phone: phone.trim(), partySize: pax,
          date: bookingDate, arrivalTime: arrival.trim(),
          tableId: tableId || undefined, floor: floor || undefined,
          floorLabel: floorOpt?.label || undefined,
          externalRef: externalRef.trim() || undefined,
          notes: notes.trim() || undefined, staffName: agentName,
          ...sharedExtras,
        });
        const aggLabel = aggOptions.find((a) => a.value === aggregator)?.label || aggregator;
        summary = `AGGREGATOR (${aggLabel.toUpperCase()})`;
      } else {
        refId = await createCorporateTableBooking({
          customerName: name.trim(), phone: phone.trim(),
          companyName: companyName.trim(), partySize: pax,
          date: bookingDate, arrivalTime: arrival.trim(),
          tableId: corpTableIds[0] || undefined,
          tableIds: corpTableIds.length ? corpTableIds : undefined,
          floor: floor || undefined,
          floorLabel: floorOpt?.label || undefined,
          notes: notes.trim() || undefined, staffName: agentName,
          advanceAmount: advanceAmount > 0 ? advanceAmount : undefined,
          advanceMode: advanceAmount > 0 ? (advanceMode || undefined) : undefined,
          advanceRef: advanceAmount > 0 ? (advanceRef.trim() || undefined) : undefined,
          ...sharedExtras,
        });
        summary = `CORPORATE (${companyName.trim().toUpperCase()})${advanceAmount > 0 ? ` · ADVANCE ₹${advanceAmount.toLocaleString("en-IN")}` : ""}`;
      }
      // 🆕 2026-06-02 (Khushi) — the moment the table is created, fire BOTH
      // WhatsApp AND email to the customer with the wallet link, then show an
      // IN-APP success screen (no more browser alert()). All sends are
      // fail-open: a notification problem must never block the booking.
      const walletUrl = `https://hodclub.in/?wallet=${encodeURIComponent(refId)}`;
      const cleanPhone = phone.replace(/\D/g, "").slice(-10);
      const tableLabel = tableId ? (doorProxyLabel(tableId) || tableId) : "your table";
      const floorLabelStr = floorOpt?.label || "";
      // 🆕 2026-06-02 (Khushi) — CORPORATE multi-table: a readable list of every
      // table held for the group (e.g. "T1, T2, SMK2"). Empty when none picked.
      const corpTablesLabel = corpTableIds.map((t) => doorProxyLabel(t) || t).join(", ");

      // 🆕 2026-06-02 (Khushi) — CORPORATE bookings get NO wallet / NO menu QR
      // (their food menu differs) — only a clean confirmation (date, time, pax,
      // company, advance). Tables/Aggregator keep the wallet + QR flow.
      const isCorporate = tab === "corporate";
      const dateNice = formatBookingDateNice(bookingDate);
      const arrivalTime = arrival.trim() || "FROM NOW";
      const partySizeStr = String(Math.max(1, pax));
      const advanceLine = advanceAmount > 0
        ? `₹${advanceAmount.toLocaleString("en-IN")}${advanceMode ? ` · ${advanceMode.toUpperCase()}` : ""}`
        : "";
      // 🆕 2026-06-02 v3.181 (Khushi) — surface the SPECIAL AMENITIES total
      // (e.g. Valet Parking ×5 = ₹1,000) on the confirmation card + customer
      // messages as an ADDITIONAL non-redeemable charge. Corporate bookings have
      // no cover screen, so without this the valet amount was captured on the
      // doc but never shown back to the door girl or the guest.
      const amenitiesLine = includedAmenities.length
        ? `₹${amenitiesTotal.toLocaleString("en-IN")} · ${includedAmenities.map((a) => a.qty > 1 ? `${a.name} ×${a.qty}` : a.name).join(", ")}`
        : "";

      // ── EMAIL (fire-and-forget) ──
      let emailStatus = "—";
      const emailAddr = email.trim();
      if (emailAddr) {
        emailStatus = `Sent to ${emailAddr}`;
        try {
          // 🆕 2026-06-02 (Khushi) — CORPORATE email must MIRROR the door
          // confirmation card: Company, Contact, Date, Arrival, Pax, Tables and
          // the Advance line (e.g. "₹10,000 paid by UPI"). The dedicated
          // company/contact/tables/advance fields drive the new rows in the CF;
          // event_title/total also carry the same info so even the CURRENT
          // (pre-redeploy) CF email already shows company + advance + mode.
          const corpAdvanceLine = advanceAmount > 0
            ? `₹${advanceAmount.toLocaleString("en-IN")} paid by ${(advanceMode || "advance").toUpperCase()}`
            : "No advance — settle the full bill at the venue";
          const emailBody = isCorporate
            ? {
                to_email:     emailAddr,
                to_name:      name.trim(),
                ref:          refId,
                event_title:  `Corporate · ${companyName.trim()}`,
                event_date:   bookingDate,
                event_time:   arrivalTime,
                event_venue:  "Koramangala 7th Block, Bengaluru",
                entry_type:   "corporate table booking",
                qty:          pax || 1,
                total:        corpAdvanceLine,
                phone:        cleanPhone,
                club_name:    "HOD — House of Dopamine",
                club_phone:   "+91 96864 44906",
                club_address: "Koramangala 7th Block, Bengaluru",
                // Dedicated rows for the enriched CF (ignored by older CF builds).
                company:      companyName.trim(),
                contact:      name.trim(),
                tables:       corpTablesLabel,
                advance:      corpAdvanceLine,
                // 🆕 2026-06-02 v3.181 — special-amenities total (e.g. Valet ×5).
                // Harmless to older CF builds (ignored); rendered once CF updated.
                addons:       amenitiesLine,
                // Corporate: NO wallet, NO menu QR (their menu differs).
                // no_wallet tells the email CF to OMIT the QR + wallet button
                // entirely — empty strings alone fall back to defaults in the CF.
                no_wallet:    true,
                wallet_link:  "",
                qr_url:       "",
              }
            : {
                to_email:     emailAddr,
                to_name:      name.trim(),
                ref:          refId,
                event_title:  summary,
                event_date:   bookingDate,
                event_time:   arrivalTime,
                event_venue:  "Koramangala 7th Block, Bengaluru",
                entry_type:   `Table${tableId ? ` ${doorProxyLabel(tableId) || tableId}` : ""}${floorLabelStr ? ` · ${floorLabelStr}` : ""} · ${pax} guests`,
                qty:          pax || 1,
                total:        includedAmenities.length ? `Add-ons ₹${amenitiesTotal.toLocaleString("en-IN")}` : "Table Reservation",
                phone:        cleanPhone,
                club_name:    "HOD — House of Dopamine",
                club_phone:   "+91 96864 44906",
                club_address: "Koramangala 7th Block, Bengaluru",
                wallet_link:  walletUrl,
                qr_url:       `https://hodclub.in/?verify=${encodeURIComponent(refId)}`,
              };
          fetch(EMAIL_CF_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(emailBody),
          })
            .then((r) => {
              if (r.ok) console.log("[door][table][email] sent to", emailAddr);
              else console.warn("[door][table][email] HTTP", r.status, "— not sent");
            })
            .catch((e) => console.warn("[door][table][email] network error", e));
        } catch (e) { console.warn("[door][table][email] threw", e); emailStatus = "Email failed"; }
      }

      // ── WHATSAPP ──
      // Corporate: free-form confirmation TEXT (no wallet, no template).
      // Tables/Aggregator: approved table_confirmed template + wallet link.
      let waStatus = "";
      const fallbackText = isCorporate
        ? `Hi ${name.trim()}, your HOD corporate booking is confirmed! 🎉\n\n` +
          `🏢 Company: ${companyName.trim()}\n` +
          `📅 Date: ${dateNice}\n` +
          `🕘 Arrival: ${arrivalTime}\n` +
          `👥 Guests: ${partySizeStr}\n` +
          (amenitiesLine ? `🅿️ Add-ons: ${amenitiesLine}\n` : "") +
          (advanceAmount > 0
            ? `💰 Advance paid: ₹${advanceAmount.toLocaleString("en-IN")}${advanceMode ? ` (${advanceMode.toUpperCase()})` : ""}\n`
            : `💳 No advance paid — settle the full bill at the venue\n`) +
          `\nOur team will have your group's setup ready. See you soon!\n📍 House of Dopamine, Koramangala\n${HOD_LOCATION_URL}`
        : `Hi ${name.trim()}, your HOD table is booked! 🍽️\n\n` +
          `📅 Date: ${dateNice}\n` +
          `🕘 Arrival: ${arrivalTime}\n` +
          `🪑 Table: ${tableLabel}${floorLabelStr ? ` · ${floorLabelStr}` : ""}\n` +
          `👥 Guests: ${partySizeStr}\n\n` +
          `Show your QR at the door — we'll have your table ready.\n\n` +
          `View reservation: ${walletUrl}\n\n` +
          `See you tonight!\n📍 House of Dopamine, Koramangala\n${HOD_LOCATION_URL}`;
      // 🆕 2026-06-02 (Khushi) — AGGREGATOR bookings send only ONE WhatsApp:
      // the "your table is ready, order now" message at GUEST ARRIVED. NO
      // booking-time confirmation WhatsApp (it duplicated the arrival message).
      const isAggregator = tab === "aggregator";
      if (isAggregator) {
        waStatus = "📲 No confirmation now — guest gets the 'order now' WhatsApp when you tap GUEST ARRIVED";
      } else if (cleanPhone.length === 10) {
        try {
          const res = await sendWhatsAppViaMeta({
            phone: cleanPhone,
            template: isCorporate
              ? undefined
              : { name: "table_confirmed", params: [name.trim(), dateNice, arrivalTime, tableLabel, floorLabelStr, partySizeStr, walletUrl] },
            fallbackText,
          });
          if (res.ok) {
            waStatus = `✅ WhatsApp ${res.via === "template" ? "sent" : "text sent"} to +91${cleanPhone}`;
            await logNotificationOutcome(refId, res.via === "template"
              ? { status: "sent_template", recipient: cleanPhone }
              : { status: "sent_text", recipient: cleanPhone });
          } else {
            waStatus = isCorporate ? "⚠ WhatsApp pending — call the guest" : "⚠ WhatsApp pending — show the QR below";
            await logNotificationOutcome(refId, { status: "qr_shown", reason: res.error || "send failed", code: res.code });
          }
        } catch (e: any) {
          waStatus = isCorporate ? "⚠ WhatsApp failed — call the guest" : "⚠ WhatsApp failed — show the QR below";
        }
      } else {
        waStatus = isCorporate ? "⚠ No valid phone" : "⚠ No valid phone — show the QR below";
        try { await logNotificationOutcome(refId, { status: "no_phone" }); } catch { /* ignore */ }
      }

      setTableDone({
        ref: refId, summary, date: bookingDate, guest: name.trim(), pax,
        arrival: arrivalTime,
        tableLabel: isCorporate ? corpTablesLabel : (tableId ? tableLabel : ""),
        floorLabel: floorLabelStr,
        walletUrl, waStatus, emailStatus,
        isCorporate, companyName: companyName.trim(), advanceLine,
        amenitiesLine,
        contactPhone: cleanPhone,
      });
    } catch (e: any) {
      setErr(e?.message || "Could not create booking");
    } finally { setBusy(false); }
  };

  // 🔴 2026-05-20 (Khushi PREMIUM REDESIGN) — softer, less-shouty input chrome.
  // Was: bright gold 1.5px borders on every field (felt like a tax form). Now:
  // subtle warm border + warmer fill so the gold accent is RESERVED for the
  // active tab + CTA. Same legibility (white 16px), but premium not loud.
  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "13px 14px", borderRadius: 6,
    background: "#FFFFFF", border: "2px solid #000",
    color: "#000", fontSize: 15.5, fontWeight: 600, marginTop: 6, boxSizing: "border-box",
    outline: "none", transition: "border-color .15s ease",
  };
  // 🔴 2026-05-20 (Khushi PREMIUM REDESIGN) — labels are now muted ivory caps
  // (was bright gold). They read as quiet section headers, not screaming chips.
  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 800, letterSpacing: "1.4px", textTransform: "uppercase",
    color: "#6B6B6B",
  };
  // 🔴 2026-05-20 (Khushi PREMIUM REDESIGN) — flat segmented pill (was a
  // double-bordered file-folder tab look that doubled up the yellow chrome).
  // Active tab gets a soft gold fill + black text; inactive is transparent
  // with a faint warm tint. One border line under the whole strip.
  const tabBtn = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: "11px 6px",
    borderRadius: 6,
    background: active ? "#FF90E8" : "#FFFFFF",
    border: "2px solid #000",
    color: "#000",
    fontSize: 12.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.6px",
    cursor: "pointer",
    boxShadow: "none",
    transition: "all .18s ease",
  });

  const subtitle =
    tab === "tables"     ? "In-house · walk-in · phone reservation" :
    tab === "aggregator" ? "Zomato · Swiggy · Magicpin · EazyDiner · more" :
                           "Company event · pre-booked party · corporate billing";

  const nameLabel = tab === "corporate" ? "Contact Name" : "Guest Name";
  const ctaLabel  =
    tab === "tables"     ? "✅ Create Table Booking"     :
    tab === "aggregator" ? "✅ Create Aggregator Booking" :
                           "✅ Create Corporate Booking";

  // 🆕 2026-06-02 (Khushi) — IN-APP success screen (replaces the old browser
  // alert()). Shows the booking details, the WhatsApp + email outcome, and a
  // big wallet QR the door girl can show if a message didn't land.
  if (tableDone) {
    const td = tableDone;
    const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=10&data=${encodeURIComponent(td.walletUrl)}`;
    const rowS: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 0", borderBottom: "2px solid #000", fontSize: 13 };
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto" }}>
        <div style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 20, maxWidth: 440, width: "100%", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", marginTop: 24 }}>
          <BackBtn onClick={onClose} />
          <div style={{ background: "#23A094", border: "2px solid #000", borderRadius: 6, padding: "10px 12px", textAlign: "center", fontSize: 16, fontWeight: 900, color: "#000", marginBottom: 14 }}>
            {td.isCorporate ? "✅ CORPORATE BOOKING CONFIRMED" : "✅ TABLE BOOKED"}
          </div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "#6B6B6B", letterSpacing: 1, marginBottom: 6 }}>{td.summary}</div>
          <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 6, padding: "4px 12px", marginBottom: 14 }}>
            <div style={rowS}><span style={{ color: "#6B6B6B", fontWeight: 700 }}>REF</span><span style={{ fontWeight: 900, fontFamily: "monospace" }}>{td.ref}</span></div>
            {td.isCorporate && td.companyName && (
              <div style={rowS}><span style={{ color: "#6B6B6B", fontWeight: 700 }}>COMPANY</span><span style={{ fontWeight: 800 }}>{td.companyName}</span></div>
            )}
            <div style={rowS}><span style={{ color: "#6B6B6B", fontWeight: 700 }}>{td.isCorporate ? "CONTACT" : "GUEST"}</span><span style={{ fontWeight: 800 }}>{td.guest}</span></div>
            {td.contactPhone && (
              <div style={rowS}><span style={{ color: "#6B6B6B", fontWeight: 700 }}>CONTACT NO</span><span style={{ fontWeight: 800, fontFamily: "monospace" }}>+91 {td.contactPhone}</span></div>
            )}
            <div style={rowS}><span style={{ color: "#6B6B6B", fontWeight: 700 }}>DATE</span><span style={{ fontWeight: 800 }}>{td.date}</span></div>
            <div style={rowS}><span style={{ color: "#6B6B6B", fontWeight: 700 }}>ARRIVAL</span><span style={{ fontWeight: 800 }}>{td.arrival}</span></div>
            <div style={td.isCorporate ? rowS : { ...rowS, borderBottom: td.isCorporate ? "2px solid #000" : "none" }}><span style={{ color: "#6B6B6B", fontWeight: 700 }}>PAX</span><span style={{ fontWeight: 800 }}>{td.pax}</span></div>
            {td.isCorporate ? (
              <>
                <div style={rowS}><span style={{ color: "#6B6B6B", fontWeight: 700 }}>TABLES</span><span style={{ fontWeight: 800 }}>{td.tableLabel ? `${td.tableLabel}${td.floorLabel ? ` · ${td.floorLabel}` : ""}` : "Not assigned — Captain assigns on arrival"}</span></div>
                {td.amenitiesLine && (
                  <div style={rowS}><span style={{ color: "#6B6B6B", fontWeight: 700 }}>ADD-ONS</span><span style={{ fontWeight: 800, color: "#FF5733", textAlign: "right" }}>{td.amenitiesLine}</span></div>
                )}
                <div style={{ ...rowS, borderBottom: "none" }}><span style={{ color: "#6B6B6B", fontWeight: 700 }}>ADVANCE</span><span style={{ fontWeight: 800, color: td.advanceLine ? "#23A094" : "#6B6B6B" }}>{td.advanceLine || "No advance — pay at venue"}</span></div>
              </>
            ) : (
              <>
                <div style={{ ...rowS, borderBottom: td.amenitiesLine ? "2px solid #000" : "none" }}><span style={{ color: "#6B6B6B", fontWeight: 700 }}>TABLE</span><span style={{ fontWeight: 800 }}>{td.tableLabel ? `${td.tableLabel}${td.floorLabel ? ` · ${td.floorLabel}` : ""}` : "Not assigned — Captain can assign"}</span></div>
                {td.amenitiesLine && (
                  <div style={{ ...rowS, borderBottom: "none" }}><span style={{ color: "#6B6B6B", fontWeight: 700 }}>ADD-ONS</span><span style={{ fontWeight: 800, color: "#FF5733", textAlign: "right" }}>{td.amenitiesLine}</span></div>
                )}
              </>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
            <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 6, padding: "8px 12px", fontSize: 12, fontWeight: 700, color: "#000" }}>📲 {td.waStatus}</div>
            <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 6, padding: "8px 12px", fontSize: 12, fontWeight: 700, color: "#000" }}>✉️ Email: {td.emailStatus}</div>
          </div>

          {td.isCorporate ? (
            <div style={{ background: "#FFD700", border: "2px solid #000", borderRadius: 6, padding: "10px 12px", marginBottom: 14, fontSize: 12, fontWeight: 800, color: "#000", textAlign: "center" }}>
              📋 Confirmation sent — corporate guests do NOT get a menu wallet/QR. {td.tableLabel ? `Tables ${td.tableLabel} held for the group.` : "Captain assigns tables on arrival."}
            </div>
          ) : (
            <div style={{ textAlign: "center", marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#6B6B6B", letterSpacing: 1, marginBottom: 6 }}>SHOW THIS QR TO THE GUEST (WALLET)</div>
              <div style={{ background: "#fff", padding: 10, borderRadius: 6, border: "2px solid #000", display: "inline-block" }}>
                <img src={qrSrc} alt="Wallet QR" style={{ width: 240, height: 240, display: "block" }} />
              </div>
              <div style={{ fontSize: 10, color: "#6B6B6B", wordBreak: "break-all", marginTop: 8, fontFamily: "monospace" }}>{td.walletUrl}</div>
            </div>
          )}

          <button onClick={onClose} style={{ width: "100%", padding: 14, borderRadius: 6, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto" }}>
      {/* 🔴 2026-05-20 (Khushi PREMIUM REDESIGN) — single hairline gold border,
          deeper black fill, subtle inner glow. Less "yellow box" — more
          "blacked-out lounge menu". */}
      <div onClick={(e) => e.stopPropagation()} style={{
        background: "#F4F4F0",
        border: "2px solid #000",
        borderRadius: 8, padding: 20, maxWidth: 460, width: "100%", marginTop: 16,
        boxShadow: "none",
        fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
      }}>
        <BackBtn onClick={onClose} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <h2 style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", color: "#000", fontSize: 22, fontWeight: 900, margin: 0, letterSpacing: 0.3 }}>New Table Booking</h2>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#000", fontSize: 26, cursor: "pointer", lineHeight: 1, padding: "0 4px" }}>×</button>
        </div>
        <div style={{ fontSize: 11, color: "#6B6B6B", letterSpacing: 1.2, textTransform: "uppercase", fontWeight: 700, marginBottom: 16 }}>
          Reservations · House of Dopamine
        </div>

        {/* 🔴 2026-05-20 (Khushi PREMIUM REDESIGN) — segmented pill control on a
            single dark track. No double border, no heading-band duplication. */}
        <div style={{
          display: "flex", gap: 4, padding: 4, marginBottom: 10,
          background: "#FFFFFF", borderRadius: 8,
          border: "2px solid #000",
        }}>
          <button onClick={() => switchTab("tables")}     style={tabBtn(tab === "tables")}>Tables</button>
          <button onClick={() => switchTab("aggregator")} style={tabBtn(tab === "aggregator")}>Aggregator</button>
          <button onClick={() => switchTab("corporate")}  style={tabBtn(tab === "corporate")}>Corporate</button>
        </div>
        <div style={{ fontSize: 11.5, color: "#6B6B6B", marginBottom: 18, textAlign: "center", fontWeight: 600, letterSpacing: 0.3 }}>
          {subtitle}
        </div>

        {/* 🔴 2026-05-20 (Khushi) — big tappable calendar field + quick-pick
            chips (TONIGHT / TMRW / DAY AFTER / +1 WEEK). Native browser
            calendar pops up on tap; chips are the fallback if she's in a hurry. */}
        {(() => {
          // 🔴 IST calendar date — see note on bookingDate state above.
          const today = CALENDAR_TODAY_STR();
          const addDays = (n: number) => {
            // Parse today as IST noon, add days, then re-render in IST.
            const d = new Date(today + "T12:00:00+05:30");
            d.setDate(d.getDate() + n);
            return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
          };
          const fmtPretty = (s: string) => {
            try {
              const d = new Date(s + "T12:00:00+05:30");
              return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
            } catch { return s; }
          };
          const chips = [
            { label: "TONIGHT",   value: addDays(0) },
            { label: "TMRW",      value: addDays(1) },
            { label: "DAY AFTER", value: addDays(2) },
          ];
          const chipBtn = (active: boolean): React.CSSProperties => ({
            flex: 1, padding: "8px 4px", borderRadius: 6, cursor: "pointer",
            background: active ? "#FF90E8" : "#FFFFFF",
            border: "2px solid #000",
            color: "#000",
            fontSize: 11, fontWeight: 900, letterSpacing: "0.5px",
          });
          // 🔴 2026-05-20 (Khushi) — opens the native calendar. showPicker()
          // can throw inside Replit's iframe preview (NotAllowedError), so we
          // wrap in try/catch and fall back to focus+click. Either way the
          // big <input> below is fully visible & tappable as the last resort.
          const openCalendar = () => {
            const el = document.getElementById("door-booking-date") as HTMLInputElement | null;
            if (!el) return;
            try { (el as any).showPicker?.(); } catch {}
            try { el.focus(); el.click(); } catch {}
          };
          return (
            <div style={{ marginBottom: 12, border: "2px solid #000", borderRadius: 8, padding: 12, background: "#FFFFFF" }}>
              <div style={{ ...labelStyle, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Booking Date</span>
                <span style={{ color: "#000", fontSize: 11.5, letterSpacing: 0.3, fontWeight: 700, textTransform: "none" }}>{fmtPretty(bookingDate)}</span>
              </div>
              {/* Quick-pick chips + PICK DATE (opens calendar) */}
              <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                {chips.map((c) => (
                  <button key={c.label} type="button"
                    onClick={() => setBookingDate(c.value)}
                    style={chipBtn(bookingDate === c.value)}>{c.label}</button>
                ))}
                <button type="button" onClick={openCalendar}
                  style={{ ...chipBtn(false), background: "#FFD700" }}>
                  📅 PICK
                </button>
              </div>
              {/* 🔴 2026-05-20 (Khushi) — REAL visible native input. The old
                  fancy overlay trick (transparent input on top of a div) broke
                  inside Replit's sandboxed iframe — taps reached the wrapper,
                  not the input. Now the input itself is the big tappable
                  control, styled gold, so the browser handles opening
                  natively (rock-solid on iPad/Chrome/Safari). */}
              <div style={{ marginTop: 8, position: "relative" }}>
                <span style={{
                  position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)",
                  fontSize: 22, pointerEvents: "none", zIndex: 1,
                }}>🗓️</span>
                <input id="door-booking-date" type="date" value={bookingDate} min={today}
                  onChange={(e) => setBookingDate(e.target.value || today)}
                  style={{
                    width: "100%", boxSizing: "border-box",
                    padding: "14px 14px 14px 44px",
                    border: "2px solid #000", borderRadius: 6,
                    background: "#FFFFFF",
                    color: "#000", fontSize: 16, fontWeight: 800,
                    letterSpacing: "0.3px", cursor: "pointer",
                    colorScheme: "light",
                    fontFamily: "inherit",
                  } as React.CSSProperties} />
                <div style={{ marginTop: 4, fontSize: 11, color: "#000", fontWeight: 700 }}>
                  → {fmtPretty(bookingDate)}
                </div>
              </div>
            </div>
          );
        })()}

        {/* AGGREGATOR-only: pick source + discount */}
        {tab === "aggregator" && (
          <>
            <div style={{ marginBottom: 10 }}>
              <div style={labelStyle}>Aggregator Source</div>
              {/* 🆕 2026-06-02 (Khushi) — Gumroad-brutalist dropdown (replaces the
                  native <select>): mirrors the floor picker below. */}
              <div style={{ position: "relative", marginTop: 6 }}>
                <button type="button" onClick={() => setAggMenuOpen((v) => !v)}
                  style={{ ...inputStyle, marginTop: 0, display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", textAlign: "left" }}>
                  <span style={{ color: "#000" }}>
                    {(aggOptions.find((a) => a.value === aggregator)?.label) || "— Pick a source —"}
                  </span>
                  <span style={{ fontSize: 12, color: "#000" }}>{aggMenuOpen ? "▲" : "▼"}</span>
                </button>
                {aggMenuOpen && (
                  <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 6,
                    background: "#FFFFFF", border: "2px solid #000", borderRadius: 6, overflow: "hidden" }}>
                    {aggOptions.map((a, i) => {
                      const active = a.value === aggregator;
                      return (
                        <button key={a.value} type="button"
                          onClick={() => { setAggregator(a.value); setAggMenuOpen(false); }}
                          style={{ width: "100%", textAlign: "left", padding: "12px 14px",
                            background: active ? "#FF90E8" : "#FFFFFF", color: "#000",
                            border: "none", borderTop: i === 0 ? "none" : "2px solid #000",
                            fontSize: 14, fontWeight: 800, cursor: "pointer" }}>
                          {a.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <div>
                <div style={labelStyle}>Discount %</div>
                <input value={aggDiscount}
                  onChange={(e) => setAggDiscount(Math.max(0, Math.min(50, parseInt(e.target.value || "0", 10) || 0)))}
                  inputMode="numeric" max={50} style={inputStyle} />
              </div>
              <div>
                <div style={labelStyle}>Aggregator Booking ID</div>
                <input value={externalRef} onChange={(e) => setExternalRef(e.target.value)} placeholder="optional" style={inputStyle} />
              </div>
            </div>
          </>
        )}

        {/* CORPORATE-only: company name + advance */}
        {tab === "corporate" && (
          <>
            <div style={{ marginBottom: 10 }}>
              <div style={labelStyle}>Company / Group Name</div>
              <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Acme Corp, Bengaluru Bachelor Party, etc." style={inputStyle} />
            </div>

            {/* 🔴 2026-05-20 (Khushi PREMIUM REDESIGN) — softened chrome to match
                the main modal frame; gold reserved for accents not enclosures. */}
            <div style={{ marginBottom: 12, border: "2px solid #000", borderRadius: 8, padding: 12, background: "#FFFFFF" }}>
              <div style={{ ...labelStyle, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Advance Paid (optional)</span>
                <span style={{ color: advanceAmount > 0 ? "#23A094" : "#6B6B6B", letterSpacing: 0, fontWeight: 800, textTransform: "none", fontSize: 12 }}>
                  ₹{advanceAmount.toLocaleString("en-IN")}
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 6 }}>
                <div>
                  <div style={{ ...labelStyle, fontSize: 10 }}>Amount (₹)</div>
                  {/* 🆕 2026-06-02 (Khushi) — show empty (not a stuck "0") so the
                      door girl can type the amount cleanly without a leading 0. */}
                  <input type="number" min={0} inputMode="numeric"
                    value={advanceAmount === 0 ? "" : advanceAmount}
                    onChange={(e) => setAdvanceAmount(Math.max(0, parseInt(e.target.value || "0", 10) || 0))}
                    placeholder="0" style={inputStyle} />
                </div>
                <div>
                  <div style={{ ...labelStyle, fontSize: 10 }}>Mode</div>
                  {/* 🆕 2026-06-02 (Khushi) — Gumroad-brutalist dropdown (replaces
                      the native <select>). */}
                  {(() => {
                    const MODE_OPTS: { v: typeof advanceMode; l: string }[] = [
                      { v: "cash", l: "Cash" },
                      { v: "upi", l: "UPI" },
                      { v: "bank-transfer", l: "Bank Transfer" },
                      { v: "card", l: "Card" },
                      { v: "other", l: "Other" },
                    ];
                    const disabled = advanceAmount <= 0;
                    const cur = MODE_OPTS.find((m) => m.v === advanceMode);
                    return (
                      <div style={{ position: "relative", marginTop: 6 }}>
                        <button type="button" disabled={disabled}
                          onClick={() => setAdvanceModeMenuOpen((v) => !v)}
                          style={{ ...inputStyle, marginTop: 0, display: "flex", justifyContent: "space-between", alignItems: "center",
                            cursor: disabled ? "not-allowed" : "pointer", textAlign: "left", opacity: disabled ? 0.5 : 1 }}>
                          <span style={{ color: cur ? "#000" : "#6B6B6B" }}>{cur ? cur.l : "— Pick —"}</span>
                          <span style={{ fontSize: 12, color: "#000" }}>{advanceModeMenuOpen ? "▲" : "▼"}</span>
                        </button>
                        {advanceModeMenuOpen && !disabled && (
                          <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 6,
                            background: "#FFFFFF", border: "2px solid #000", borderRadius: 6, overflow: "hidden" }}>
                            {MODE_OPTS.map((m, i) => {
                              const active = m.v === advanceMode;
                              return (
                                <button key={m.v} type="button"
                                  onClick={() => { setAdvanceMode(m.v); setAdvanceModeMenuOpen(false); }}
                                  style={{ width: "100%", textAlign: "left", padding: "12px 14px",
                                    background: active ? "#FF90E8" : "#FFFFFF", color: "#000",
                                    border: "none", borderTop: i === 0 ? "none" : "2px solid #000",
                                    fontSize: 14, fontWeight: 800, cursor: "pointer" }}>
                                  {m.l}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                <div style={{ ...labelStyle, fontSize: 10 }}>Reference / Receipt # (optional)</div>
                <input value={advanceRef} onChange={(e) => setAdvanceRef(e.target.value)}
                  placeholder="UPI ref, cheque #, etc." style={inputStyle} disabled={advanceAmount <= 0} />
              </div>
              <div style={{ fontSize: 10, color: "#6B6B6B", marginTop: 6, lineHeight: 1.5 }}>
                Saved on the reservation — Captain & Admin will see it and deduct from final bill.
              </div>
            </div>
          </>
        )}

        <div style={{ marginBottom: 10 }}>
          <div style={labelStyle}>{nameLabel}</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" style={inputStyle} />
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={labelStyle}>Phone (10-digit)</div>
          <div style={{ display: "flex", alignItems: "stretch", marginTop: 6 }}>
            <select value={countryCode} onChange={(e) => setCountryCode(e.target.value)} style={{
              padding: "13px 8px", borderRadius: "6px 0 0 6px",
              background: "#FFFFFF", border: "2px solid #000", borderRight: "none",
              color: "#000", fontSize: 14, fontWeight: 700, fontFamily: "inherit", outline: "none", cursor: "pointer",
            }}>
              {(["+91", "+1", "+44", "+971", "+61", "+65", "+60", "+49", "+33", "+966", "+974"]).map((c) => (
                <option key={c} value={c} style={{ background: "#FFFFFF", color: "#000" }}>{c}</option>
              ))}
            </select>
            <input value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
              inputMode="numeric" type="tel" placeholder="98XXXXXXXX"
              style={{ ...inputStyle, marginTop: 0, borderRadius: "0 6px 6px 0" }} />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
          <div>
            <div style={labelStyle}>No. of Girls</div>
            <input value={girls} onChange={(e) => setGirls(Math.max(0, Math.min(50, parseInt(e.target.value || "0", 10) || 0)))} inputMode="numeric" style={inputStyle} />
          </div>
          <div>
            <div style={labelStyle}>No. of Boys</div>
            <input value={boys} onChange={(e) => setBoys(Math.max(0, Math.min(50, parseInt(e.target.value || "0", 10) || 0)))} inputMode="numeric" style={inputStyle} />
          </div>
        </div>
        <div style={{ fontSize: 11, color: "#6B6B6B", marginTop: -4, marginBottom: 10, fontWeight: 700 }}>
          Total party: {pax} {pax === 1 ? "guest" : "guests"}
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={labelStyle}>Email (optional)</div>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="guest@example.com" style={inputStyle} />
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ ...labelStyle, display: "flex", justifyContent: "space-between" }}>
            <span>Arrival Time (e.g. 10:30 PM)</span>
            {!arrivalEdited && <span style={{ color: "#23A094", fontSize: 10 }}>🟢 LIVE · auto</span>}
          </div>
          <input type="time" value={doorTo24h(arrival)}
            onChange={(e) => { setArrivalEdited(true); setArrival(doorTo12h(e.target.value)); }}
            style={inputStyle} />
        </div>

        {/* 🔴 2026-05-20 (Khushi) — ASSIGN TABLE section. Floor dropdown +
            live table grid in ONE gold-outlined card so it reads as a single
            step. Khushi missed this earlier because the floor select looked
            optional/skippable. */}
        <div style={{ marginBottom: 10, border: "2px solid #000", borderRadius: 8, padding: 10, background: "#FFFFFF" }}>
          <div style={labelStyle}>Assign Table</div>

          {/* 🆕 2026-06-02 (Khushi) — custom Gumroad-brutalist floor dropdown
              (replaces the native <select>): big black-bordered toggle that
              opens a flat option list. */}
          <div style={{ position: "relative", marginTop: 6 }}>
            <button type="button" onClick={() => setFloorMenuOpen((v) => !v)}
              style={{ ...inputStyle, marginTop: 0, display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", textAlign: "left" }}>
              <span style={{ color: floorOpt ? "#000" : "#6B6B6B" }}>
                {floorOpt ? floorOpt.label : "— Pick a floor —"}
              </span>
              <span style={{ fontSize: 12, color: "#000" }}>{floorMenuOpen ? "▲" : "▼"}</span>
            </button>
            {floorMenuOpen && (
              <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 5,
                background: "#FFFFFF", border: "2px solid #000", borderRadius: 6, overflow: "hidden" }}>
                {DOOR_TABLE_OPTIONS.map((g, i) => {
                  const active = g.floor === floor;
                  return (
                    <button key={g.floor} type="button"
                      onClick={() => { setFloor(g.floor); setTable(""); setCorpTableIds([]); setFloorMenuOpen(false); }}
                      style={{ width: "100%", textAlign: "left", padding: "12px 14px",
                        background: active ? "#FF90E8" : "#FFFFFF", color: "#000",
                        border: "none", borderTop: i === 0 ? "none" : "2px solid #000",
                        fontSize: 14, fontWeight: 800, cursor: "pointer" }}>
                      {g.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {floorOpt && (() => {
          // 🔴 2026-05-20 (Khushi) — split tables into AVAILABLE vs BLOCKED so
          // the door girl sees only what she can actually give out at the top.
          // Same Firestore subscription as CaptainMode → instant sync both ways.
          const rows = floorOpt.tables.map((t) => {
            const occupant = doorTableOccupantAt(t, targetMin, liveReservations);
            return { t, occupant, occupied: !!occupant };
          });
          const available = rows.filter((r) => !r.occupied);
          const blocked   = rows.filter((r) => r.occupied);
          // 🆕 2026-06-02 (Khushi) — CORPORATE = MULTI-select (hold several
          // tables on this floor for one group); Tables/Aggregator = single.
          const isCorpMulti = tab === "corporate";
          const renderBtn = ({ t, occupant, occupied }: typeof rows[number]) => {
            const isSelected = isCorpMulti ? corpTableIds.includes(t) : tableId === t;
            const bg = isSelected ? "#FFD700" : occupied ? "#FF5733" : "#23A094";
            const border = "#000";
            const color = isSelected ? "#000" : "#fff";
            const title = occupied && occupant
              ? `BLOCKED — ${occupant.customerName || ""}${occupant.arrivalTime ? " @ " + occupant.arrivalTime : ""}${occupant.partySize ? " · " + occupant.partySize + " pax" : ""}${occupant.source ? " · " + occupant.source : ""}`.trim()
              : isCorpMulti ? "Available — tap to add / remove" : "Available — tap to assign";
            return (
              <button key={t} type="button" disabled={occupied}
                onClick={() => {
                  if (isCorpMulti) {
                    setCorpTableIds((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]);
                  } else {
                    setTable(isSelected ? "" : t);
                  }
                }} title={title}
                style={{ padding: "10px 12px", borderRadius: 8, fontSize: 13, fontWeight: 900,
                  cursor: occupied ? "not-allowed" : "pointer",
                  background: bg, border: `2px solid ${border}`, color,
                  opacity: occupied ? 0.9 : 1, minWidth: 56 }}>
                {doorProxyLabel(t) || t}{occupied ? " 🔒" : ""}
              </button>
            );
          };
          return (
            <div style={{ marginBottom: 10, border: "2px solid #000", borderRadius: 8, padding: 10, background: "#FFFFFF" }}>
              <div style={{ ...labelStyle, display: "flex", justifyContent: "space-between" }}>
                <span>🪑 Assign Table · LIVE</span>
                <span style={{ letterSpacing: 0, fontSize: 11 }}>
                  <span style={{ color: "#23A094" }}>✅ {available.length} FREE</span>
                  &nbsp;·&nbsp;
                  <span style={{ color: "#FF5733" }}>🔒 {blocked.length} BLOCKED</span>
                </span>
              </div>

              {/* 🆕 2026-06-02 (Khushi) — group tables by seating capacity:
                  one row per capacity ("4 PAX", "6 PAX", "8 PAX", "12 PAX").
                  VIP tables sit under their parent floor in the same rows.
                  Within a row: available (green) shown first, then blocked
                  (red, disabled). */}
              {(() => {
                // Sort capacity groups ascending; proxies (cap 0 = flexible)
                // always sort LAST so the real PAX rows come first.
                const caps = Array.from(new Set(rows.map((r) => doorTableCapacity(r.t))))
                  .sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
                return caps.map((cap) => {
                  const group = rows
                    .filter((r) => doorTableCapacity(r.t) === cap)
                    .sort((a, b) => Number(a.occupied) - Number(b.occupied));
                  const freeCount = group.filter((r) => !r.occupied).length;
                  return (
                    <div key={cap} style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 10, fontWeight: 800, color: "#000", letterSpacing: "0.5px" }}>
                        {cap > 0 ? `${cap} PAX` : "PROXY · CAPTAIN ASSIGNS SEATS"}
                        <span style={{ color: "#23A094", marginLeft: 6 }}>· {freeCount} FREE</span>
                      </div>
                      <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 5 }}>
                        {group.map(renderBtn)}
                      </div>
                    </div>
                  );
                });
              })()}

              {isCorpMulti ? (
                corpTableIds.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 12, color: "#000", fontWeight: 800 }}>
                    ✓ {corpTableIds.length} table{corpTableIds.length > 1 ? "s" : ""} held: {corpTableIds.map((t) => doorProxyLabel(t) || t).join(", ")} · tap a table to add / remove
                  </div>
                )
              ) : (
                tableId && (
                  <div style={{ marginTop: 8, fontSize: 12, color: "#000", fontWeight: 800 }}>
                    ✓ Selected: {tableId} · tap again to clear
                  </div>
                )
              )}
            </div>
          );
        })()}

        {/* 🔴 2026-05-20 (Khushi) — WAITLIST alt-path moved ABOVE amenities so
            door girl sees it before scrolling past the add-ons block. */}
        {tab === "tables" && (
          <button
            onClick={async () => {
              setErr("");
              if (!name.trim())  { setErr("Enter guest name"); return; }
              if (!phone.trim() || phone.replace(/\D/g, "").length < 10) { setErr("Enter valid 10-digit phone"); return; }
              if (!bookingDate) { setErr("Pick a booking date"); return; }
              { const pd = pastBookingDateErr(); if (pd) { setErr(pd); return; } }
              setBusy(true);
              try {
                const { ref } = await addToWaitlist({
                  customerName: name.trim(), phone: phone.trim(), partySize: pax,
                  notes: notes.trim() || undefined,
                  preferredFloor: floorOpt?.label || undefined,
                  date: bookingDate, staffName: agentName,
                });
                // 🆕 2026-06-02 (Khushi) — NO browser popup. Fire a WhatsApp to the
                // guest (fire-and-forget, fail-open) then show an in-app message.
                void sendWhatsAppTextMessage(
                  phone.trim(),
                  `🪑 HOD — YOU'RE ON THE WAITLIST!\n\nHi ${name.trim()}, you're in the queue for a table (${pax} ${pax === 1 ? "guest" : "guests"}). Your reference is ${ref}.\n\nWe'll WhatsApp & call you the MOMENT a table opens. Please stay close to the door. — House of Dopamine`,
                ).then((res) => {
                  if (res.ok) console.log("[door][waitlist][wa] sent to", phone.trim());
                  else console.warn("[door][waitlist][wa] not sent:", res.error);
                });
                await centeredAlert(
                  "ADDED TO WAITLIST",
                  `Reference: ${ref}\n\n${name.trim()} · ${pax} PAX\n\nWe've WhatsApp'd ${name.trim()} and will message + call the moment a table opens. Track the live timer in the WAITLIST tab.`,
                  "success",
                  true,
                );
                onClose();
              } catch (e: any) {
                setErr(e?.message || "Failed to add to waitlist");
              } finally { setBusy(false); }
            }}
            disabled={busy}
            style={{ width: "100%", padding: 12, borderRadius: 6, background: "#FFD700", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.5px", cursor: busy ? "wait" : "pointer", marginBottom: 12, opacity: busy ? 0.6 : 1 }}>
            ADD TO WAITLIST
          </button>
        )}

        {/* 🔴 2026-05-19 — Special Amenities checklist (Valet, Decor, Cake, DJ, custom)
            🔴 2026-05-20 — collapsed into a dropdown (closed by default) so the
            modal stays short. Click the header row to toggle. */}
        <div style={{ marginBottom: 12, border: "2px solid #000", borderRadius: 8, padding: 10, background: "#FFFFFF" }}>
          <button type="button" onClick={() => setAmenitiesOpen((v) => !v)}
            style={{ ...labelStyle, display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", color: "#000" }}>
            <span>✨ Special Amenities</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: amenitiesTotal > 0 ? "#000" : "#6B6B6B", letterSpacing: 0 }}>
                {includedAmenities.length > 0 ? `${includedAmenities.length} added · ` : ""}Total: ₹{amenitiesTotal.toLocaleString("en-IN")}
              </span>
              <span style={{ fontSize: 12, color: "#000" }}>{amenitiesOpen ? "▲" : "▼"}</span>
            </span>
          </button>
          {amenitiesOpen && (<>
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
            {amenities.map((row, i) => {
              const lineTotal = (Number(row.price) || 0) * (Number(row.qty) || 1);
              return (
                <div key={i} style={{
                  display: "grid", gridTemplateColumns: "auto 1fr 70px 50px auto auto", gap: 6,
                  alignItems: "center",
                  background: "#FFFFFF",
                  border: `2px solid ${row.included ? "#23A094" : "#000"}`,
                  borderRadius: 8, padding: "6px 8px",
                }}>
                  <input type="checkbox" checked={row.included} onChange={(e) => updateAm(i, { included: e.target.checked })}
                    style={{ width: 16, height: 16, cursor: "pointer" }} />
                  <input value={row.name} onChange={(e) => updateAm(i, { name: e.target.value })}
                    style={{ background: "transparent", border: "none", color: "#000", fontSize: 12, fontWeight: 700, padding: 0, outline: "none" }} />
                  <input type="number" min={0} value={row.price}
                    onChange={(e) => updateAm(i, { price: Math.max(0, parseInt(e.target.value || "0", 10) || 0) })}
                    style={{ background: "#FFFFFF", border: "2px solid #000", color: "#000", borderRadius: 6, padding: "4px 6px", fontSize: 11, width: "100%", boxSizing: "border-box" }} />
                  <input type="number" min={1} value={row.qty}
                    onChange={(e) => updateAm(i, { qty: Math.max(1, parseInt(e.target.value || "1", 10) || 1) })}
                    title="Quantity"
                    style={{ background: "#FFFFFF", border: "2px solid #000", color: "#000", borderRadius: 6, padding: "4px 6px", fontSize: 11, width: "100%", boxSizing: "border-box" }} />
                  <span style={{ fontSize: 11, fontWeight: 800, color: row.included ? "#000" : "#6B6B6B", minWidth: 56, textAlign: "right" }}>
                    ₹{lineTotal.toLocaleString("en-IN")}
                  </span>
                  <button type="button" onClick={() => removeAm(i)} title="Remove row"
                    style={{ background: "transparent", border: "none", color: "#FF5733", fontSize: 16, cursor: "pointer", padding: "0 4px" }}>×</button>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 80px auto", gap: 6 }}>
            <input value={customAmName} onChange={(e) => setCustomAmName(e.target.value)} placeholder="+ Add custom add-on…"
              style={{ ...inputStyle, marginTop: 0, padding: "8px 10px", fontSize: 12 }} />
            <input type="number" min={0} value={customAmPrice}
              onChange={(e) => setCustomAmPrice(Math.max(0, parseInt(e.target.value || "0", 10) || 0))}
              placeholder="₹"
              style={{ ...inputStyle, marginTop: 0, padding: "8px 10px", fontSize: 12 }} />
            <button type="button" onClick={addCustomAm} disabled={!customAmName.trim()}
              style={{ background: customAmName.trim() ? "#FF90E8" : "#FFFFFF", border: "2px solid #000", color: customAmName.trim() ? "#000" : "#6B6B6B", borderRadius: 6, padding: "8px 12px", fontSize: 11, fontWeight: 900, cursor: customAmName.trim() ? "pointer" : "not-allowed" }}>
              ADD
            </button>
          </div>
          </>)}
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={labelStyle}>Notes (optional)</div>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Birthday, VIP, etc." style={inputStyle} />
        </div>

        {err && (
          <div style={{ background: "#FF5733", border: "2px solid #000", color: "#fff", padding: 10, borderRadius: 8, fontSize: 12, marginBottom: 10 }}>
            ⚠ {err}
          </div>
        )}

        <button onClick={submit} disabled={busy}
          style={{ width: "100%", padding: 14, borderRadius: 6, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.5px", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Creating..." : ctaLabel}
        </button>

        {/* 🔴 2026-05-20 — WAITLIST button moved ABOVE Special Amenities (see top of modal). */}

        {/* 🔴 2026-05-20 (Khushi) — COVER + TABLE combo. Books the table now,
            then opens the SAME wallet layout (BUY COVER) to recharge cover.
            Customer can redeem at GF BAR (bar redeem flow) OR at the TABLE
            (captain redeem flow). TABLES tab only. */}
        {tab === "tables" && (
          <button
            onClick={async () => {
              setErr("");
              if (!name.trim())  { setErr("Enter guest name"); return; }
              if (!phone.trim() || phone.replace(/\D/g, "").length < 10) { setErr("Enter valid 10-digit phone"); return; }
              if (!bookingDate) { setErr("Pick a booking date"); return; }
              { const pd = pastBookingDateErr(); if (pd) { setErr(pd); return; } }
              if (!arrival.trim()) { setErr("Enter arrival time"); return; }
              if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setErr("Email looks invalid — leave blank or fix"); return; }
              setBusy(true);
              try {
                const refId = await createWalkInTableReservation({
                  customerName: name.trim(), phone: phone.trim(), partySize: pax,
                  date: bookingDate, arrivalTime: arrival.trim(),
                  tableId: tableId || undefined, floor: floor || undefined,
                  floorLabel: floorOpt?.label || undefined,
                  notes: notes.trim() || undefined, staffName: agentName,
                  email: email.trim() || undefined,
                  amenities: includedAmenities.length ? includedAmenities : undefined,
                  hasLinkedCover: true,
                });
                onClose();
                // Open the standard wallet recharge modal (same UI as BUY COVER)
                // pre-filled + linked back to this reservation so activation
                // patches both docs.
                onActivateCoverTable({
                  tableResRef: refId,
                  arrivalTime: arrival.trim(),
                  prefill: { name: name.trim(), phone: phone.trim(), email: email.trim(), pax, girls: Number(girls) || 0, boys: Number(boys) || 0 },
                  tableInfo: {
                    tableId: tableId || undefined,
                    floorLabel: floorOpt?.label || undefined,
                    amenitiesTotal,
                    amenitiesLabel: includedAmenities.map((a) => a.qty > 1 ? `${a.name} ×${a.qty}` : a.name).join(", "),
                  },
                });
              } catch (e: any) {
                setErr(e?.message || "Could not create table");
                setBusy(false);
              }
            }}
            disabled={busy}
            style={{ width: "100%", padding: 14, borderRadius: 6, background: "#FFD700", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.5px", cursor: busy ? "wait" : "pointer", marginTop: 10, opacity: busy ? 0.6 : 1, boxShadow: "none" }}>
            💰 Activate Cover + Table (Wallet)
          </button>
        )}
      </div>
    </div>
  );
}

function NewWalkInModal({ agentName, onClose, onActivateCover }: { agentName: string; onClose: () => void; onActivateCover: (b: HodBooking) => void }) {
  const [showAgg, setShowAgg] = useState(false);
  if (showAgg) {
    return <AddAggregatorBookingModal agentName={agentName} onClose={onClose} onBack={() => setShowAgg(false)} />;
  }
  return <UnifiedWalkInModal agentName={agentName} onClose={onClose} onAggregator={() => setShowAgg(true)} onActivateCover={onActivateCover} />;
}

type WalkInKind = "guestlist" | "onlyentry" | "cover" | "group";

// Tier preset DEFAULTS — used only when the selected event has no
// stagPrice / couplePrice configured. Real prices come from the event
// doc (see `tierPrices` derived below) so changing prices in Events
// Admin instantly flows to BOTH the customer site (hodclub.in) and the
// door tablet — no double-edit required.
const TIER_PRICE_DEFAULTS: Record<"Stag" | "Couple" | "Ladies", { price: number; label: string; sub: string }> = {
  Stag:   { price: 999,  label: "STAG",   sub: "1 Person · Cover Redeemable" },
  Couple: { price: 1499, label: "COUPLE", sub: "2 Persons · Cover Redeemable" },
  Ladies: { price: 0,    label: "LADIES", sub: "Complimentary Entry" },
};

// ── Walk-In modal helpers (Khushi spec 16 May 2026) ─────────────────────────
// actionBtn: success-screen button factory in the chosen accent color.
// QrPopup:   shows a scannable QR for any URL (uses public api.qrserver.com
//            so we don't ship a QR npm dep — fallback: URL is rendered as
//            plain text below the image so the door girl can read it out).
// openClientSideRazorpay: amount-only Razorpay popup mirroring the customer
//            site (hodclub.in). Used for "ONLINE" payment in the door modal.
//            The bartender-side Bar Mode recharge keeps using the server-
//            verified createWalletOrder flow — that's a separate fraud
//            surface and out of scope here. Server-verified upgrade for
//            door bookings is queued for the next chunk (will bind paymentId
//            → bookingRef in Firestore via createWalletOrder).
// Gumroad-style action button: flat colour fill, hard 2px black border, no
// shadow, black label (the brand colours — pink/teal/yellow — are all light).
const _actionBtn = (color: string): React.CSSProperties => ({
  padding: "12px 8px", borderRadius: 6, border: "2px solid #000",
  background: color, color: "#000", fontFamily: "inherit",
  fontSize: 12, fontWeight: 900, letterSpacing: .4, cursor: "pointer",
});

function QrPopup({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=10&data=${encodeURIComponent(url)}`;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 10001, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 22, maxWidth: 380, width: "100%", textAlign: "center" }}>
        <BackBtn onClick={onClose} />
        <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontSize: 18, fontWeight: 900, color: "#000", marginBottom: 12 }}>{title}</div>
        <div style={{ background: "#fff", padding: 10, borderRadius: 6, border: "2px solid #000", display: "inline-block", marginBottom: 12 }}>
          <img src={qrSrc} alt="QR" style={{ width: 280, height: 280, display: "block" }} />
        </div>
        <div style={{ fontSize: 11, color: "#6B6B6B", wordBreak: "break-all", marginBottom: 14, fontFamily: "monospace" }}>{url}</div>
        <button onClick={onClose} style={{ width: "100%", padding: 12, borderRadius: 6, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 900, cursor: "pointer" }}>Done</button>
      </div>
    </div>
  );
}

// Auto-fire WhatsApp confirmation right after the booking lands. Uses the
// correct approved Meta template for each booking type so it's delivered
// even if the customer hasn't pinged HOD in the last 24h. Fire-and-forget
// — never blocks the UI; logs result to console for debugging.
function _autoFireBookingWhatsApp(opts: {
  ref: string; name: string; cleanPhone: string;
  kind: WalkInKind; eventTitle: string;
  tier: string; partySize: number; tableType: string;
  total: number;
}) {
  const { ref, name, cleanPhone, kind, eventTitle, tier, partySize, total } = opts;
  const link = `https://hodclub.in/?wallet=${encodeURIComponent(ref)}`;
  // 🔴 2026-05-21 (Khushi) — route through the new category-aware template
  // picker. Walk-ins are always pay-at-venue (cash collected at door) so
  // paymentId stays empty → detectWaPaid returns paid:false → unpaid variants.
  const synthetic: HodBooking = {
    id: ref,
    ref,
    name,
    phone: cleanPhone,
    eventId: "",
    eventTitle: eventTitle || "Tonight at H.O.D",
    tier: kind === "cover" || kind === "guestlist" ? tier : "",
    type: kind === "guestlist" ? (tier || "stag") : (tier as any),
    total: Math.max(0, Math.round(Number(total) || 0)),
    guests: partySize,
    date: TODAY_STR(),
    paymentId: "",
    _isGuestList: kind === "guestlist",
    ...(kind === "group"     ? { entryType: "group",     partySize, bookMode: "group" } : {}),
    ...(kind === "onlyentry" ? { entryType: "entryonly", qty: 1 } : {}),
  } as any;
  const tpl = pickBookingTemplate(synthetic, link);
  const fallbackText = buildBookingWhatsAppText(synthetic, link);
  sendWhatsAppViaMeta({
    phone: cleanPhone,
    template: tpl ? { name: tpl.name, params: tpl.params } : undefined,
    fallbackText,
  }).then((res) => {
    console.log("[door][auto-wa]", tpl?.name || "(text-only)", res.ok ? `✓ via ${res.via}` : `✗ ${res.error}`);
    if (ref && res.ok) logNotificationOutcome(ref, res.via === "template"
      ? { status: "sent_template", recipient: cleanPhone }
      : { status: "sent_text", recipient: cleanPhone });
  }).catch((e) => console.warn("[door][auto-wa] error", e));
}

type WalkInPayMethod = "cash" | "upi" | "card" | "split";

function UnifiedWalkInModal({
  agentName, onClose, onAggregator, onActivateCover,
  prefill, linkToTable,
}: {
  agentName: string;
  onClose: () => void;
  onAggregator: () => void;
  onActivateCover: (b: HodBooking) => void;
  // 🔴 2026-05-20 (Khushi) — COVER+TABLE flow. When set:
  //   • kind is locked to "cover" (no tab switcher shown)
  //   • a gold banner shows the linked table info at the top
  //   • after the wallet is activated, the cover doc is bidirectionally
  //     linked to the table reservation via linkCoverToTable().
  prefill?: { name: string; phone: string; email: string; girls?: number; boys?: number };
  linkToTable?: { tableResRef: string; arrivalTime?: string; tableId?: string; floorLabel?: string; amenitiesTotal?: number; amenitiesLabel?: string };
}) {
  // Default tab = Buy Covers (matches the screenshot's active state).
  // Cover+Table flow locks to "cover" so door girl can't change category.
  const [kind, setKind] = useState<WalkInKind>("cover");

  // Shared identity fields persist across tab switches.
  // Prefill from caller (COVER+TABLE flow) so door girl doesn't re-type.
  const [name, setName] = useState(prefill?.name || "");
  const [email, setEmail] = useState(prefill?.email || "");
  const [phone, setPhone] = useState(prefill?.phone || "");

  // Phone country code (default +91 India). 🆕 2026-06-02 (Khushi).
  const [countryCode, setCountryCode] = useState("+91");

  // 🆕 2026-06-02 (Khushi) — NEW WALK-IN redesign. Two tabs only
  // (GUEST LIST + BUY COVERS). Door girl types a free COVER AMOUNT
  // (the redeemable wallet) and an optional ENTRY TICKET (non-redeemable
  // door fee, ₹0 default). The old STAG/COUPLE/LADIES tier selector is
  // gone — headcount is captured as No. of Girls / No. of Boys.
  //   • TOTAL collected at the door = cover + entry.
  //   • Wallet balance activated      = cover ONLY (entry not redeemable).
  //   • GUEST LIST                     = free entry; cover & entry forced
  //                                      ₹0; a ₹0 wallet is minted + sent.
  const [coverAmountStr, setCoverAmountStr] = useState("");
  const [entryTicketStr, setEntryTicketStr] = useState("0");
  const [numGirls, setNumGirls] = useState(Number(prefill?.girls) || 0);
  const [numBoys, setNumBoys] = useState(Number(prefill?.boys) || 0);

  // Hoisted activating-state (kept for the success-screen resend path).
  const [activating, setActivating] = useState(false);

  // Payment method picker — cash / upi / card / split. EDC machine prints
  // its own receipt for upi/card so no txn ref is typed at the door.
  const [payMethod, setPayMethod] = useState<WalkInPayMethod>("cash");
  const [splitCash, setSplitCash] = useState(0);
  const [splitUpi, setSplitUpi] = useState(0);
  const [splitCard, setSplitCard] = useState(0);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ ref: string; phone: string; isCover: boolean; total: number; coverAmount: number } | null>(null);
  const [showQrModal, setShowQrModal] = useState<{ url: string; title: string } | null>(null);
  const [actionMsg, setActionMsg] = useState("");
  // 🆕 2026-06-02 (Khushi) — surface the email outcome on the success screen so
  // the door girl can SEE whether the confirmation email fired (mirrors the
  // "Table Booked" screen). Email is OPTIONAL: blank → "No email entered".
  const [emailStatus, setEmailStatus] = useState("—");

  const [events, setEvents] = useState<HodEvent[]>([]);
  const [eventId, setEventId] = useState<string>("");
  useEffect(() => {
    // 2026-05-16 (Khushi v2): silently auto-pick tonight's first event.
    // Door girl never books for a future date — the EVENT dropdown was
    // removed. If multiple events tonight, take the first; if none, leave
    // empty (booking still saves with eventTitle="").
    // v3.96 — scoped to last 7 days + future (was unfiltered). Door only
    // ever auto-picks TONIGHT's event; historical events are never relevant.
    const unsub = subscribeToHodEventsRecent(7, (all) => {
      setEvents(all);
      const today = TODAY_STR();
      const tonight = all.filter((e) => (e.date || "") === today);
      if (tonight.length > 0) setEventId(tonight[0].id);
    });
    return unsub;
  }, []);

  const eventTitle = events.find((e) => e.id === eventId)?.title || "";

  // ── Money model (Khushi 2026-06-02) ───────────────────────────────────────
  //  • COVER AMOUNT  → redeemable wallet balance.
  //  • ENTRY TICKET  → non-redeemable door fee (₹0 default).
  //  • TOTAL collected at the door = cover + entry.
  //  • GUEST LIST forces both to ₹0 (free entry; ₹0 wallet minted on confirm).
  const coverAmount = kind === "guestlist" ? 0 : (parseInt(coverAmountStr || "0", 10) || 0);
  const entryTicket = kind === "guestlist" ? 0 : (parseInt(entryTicketStr || "0", 10) || 0);
  // 🆕 2026-06-02 (Khushi) — AMENITIES from the table screen (e.g. Valet ₹200)
  // also get collected on this cover screen. Like the entry ticket, they are
  // a NON-redeemable add-on: they're added to the Total to Collect but NEVER
  // enter the wallet balance (wallet = cover only). Only applies in the
  // COVER+TABLE flow; the plain BUY-COVERS / GUEST LIST flow has none.
  const amenitiesTotal = kind === "guestlist" ? 0 : Math.max(0, Number(linkToTable?.amenitiesTotal) || 0);
  const amenitiesLabel = (linkToTable?.amenitiesLabel || "").trim();
  // Sum of every NON-redeemable add-on (entry ticket + amenities). Used by the
  // split-payment guard below — split must equal the wallet (cover) amount, so
  // any non-redeemable extra makes split unsafe.
  const nonRedeemable = entryTicket + amenitiesTotal;
  const total = Math.max(0, coverAmount + entryTicket + amenitiesTotal);
  const guests = Math.max(1, (numGirls || 0) + (numBoys || 0));

  // Payment validation helpers.
  const splitTotal = (splitCash || 0) + (splitUpi || 0) + (splitCard || 0);
  const splitOk = payMethod !== "split" || splitTotal === total;

  // "+ NEXT WALK-IN" — preserves tab + event + payMethod, clears identity
  // fields and counters so the next customer starts clean without making
  // the door girl re-pick the booking type.
  const resetForNext = () => {
    setName(""); setEmail(""); setPhone("");
    setCoverAmountStr(""); setEntryTicketStr("0");
    setNumGirls(0); setNumBoys(0);
    setSplitCash(0); setSplitUpi(0); setSplitCard(0);
    setErr(""); setActionMsg(""); setEmailStatus("—"); setDone(null); setBusy(false); setActivating(false);
  };

  // 🆕 2026-06-02 (Khushi) — UNIFIED CONFIRM. One tap does everything:
  //   1. create the booking (cover) / guestlist entry
  //   2. activate the wallet — balance = COVER ONLY (entry ticket is a
  //      non-redeemable door fee); guestlist mints a ₹0 wallet
  //   3. read-back verify the wallet actually saved (fail-loud)
  //   4. link to the table (COVER+TABLE flow only)
  //   5. send WhatsApp (awaited) + email; auto-show the QR fallback the
  //      instant WhatsApp isn't confirmed so the door girl always has a
  //      working handoff
  // → success popup: "COVER ACTIVATION OF ₹X IS SUCCESSFUL".
  const submit = async () => {
    setErr("");
    if (!name.trim()) { setErr("Enter guest name"); return; }
    const cleanPhone = phone.replace(/\D/g, "").slice(-10);
    if (cleanPhone.length < 10) { setErr("Enter a 10-digit phone number"); return; }
    // For WhatsApp: the helper auto-prepends "91" to 10-digit numbers, so
    // only build a full international number when a non-+91 code is chosen.
    const ccDigits = (countryCode || "+91").replace(/\D/g, "");
    const waPhone = ccDigits && ccDigits !== "91" ? ccDigits + cleanPhone : cleanPhone;
    // activateCoverForBooking() rejects amount > ₹50,000 — surface it cleanly
    // here instead of a cryptic throw mid-flow. ENTRY ONLY can also carry an
    // optional cover wallet, so guard that path too (else a >₹50k entry-only
    // wallet saves the booking THEN fails activation = partial state).
    if ((kind === "cover" || kind === "onlyentry") && coverAmount > 50000) {
      setErr("Cover amount can't exceed ₹50,000 per wallet"); return;
    }
    if (kind === "cover" && total > 0 && payMethod === "split") {
      // 🛟 SPLIT + NON-REDEEMABLE guard. The wallet is credited with COVER ONLY,
      // but the split is collected against the TOTAL (cover + entry + amenities).
      // activateCoverForBooking() hard-requires split-sum === amount(=cover),
      // so a split with any non-redeemable add-on (entry ticket OR amenities)
      // would throw mid-flow AFTER the booking is already saved. Block it up
      // front (rare: entry ticket + amenities both default to ₹0).
      if (nonRedeemable > 0) {
        setErr("Split payment can't be combined with an entry ticket or amenities. Collect those separately, or use a single payment method (Cash / UPI / Card).");
        return;
      }
      if (splitCash < 0 || splitUpi < 0 || splitCard < 0) {
        setErr("Split amounts cannot be negative"); return;
      }
      if (!splitOk) {
        setErr(`Split adds to ₹${splitTotal.toLocaleString("en-IN")} — must equal ₹${total.toLocaleString("en-IN")}`);
        return;
      }
    }
    setBusy(true);
    try {
      // Audit breakdown lives in `notes` (no dedicated cover/entry/girls/boys
      // columns) so Reports + Sheets show exactly what the door girl entered.
      const noteBits = [`GIRLS:${numGirls} · BOYS:${numBoys}`];
      if (kind === "cover") {
        noteBits.push(`COVER(redeemable):₹${coverAmount}`);
        if (entryTicket > 0) noteBits.push(`ENTRY-TICKET(non-redeemable):₹${entryTicket}`);
        if (amenitiesTotal > 0) noteBits.push(`AMENITIES(non-redeemable):₹${amenitiesTotal}${amenitiesLabel ? ` [${amenitiesLabel}]` : ""}`);
      }
      noteBits.push(`by ${agentName}`);
      const noteStr = noteBits.join(" · ");

      let savedRef = "";
      if (kind === "guestlist") {
        const r = await createWalkInGuestlistEntry({
          name, email, phone, eventId, eventTitle,
          type: "stag",
          staffName: agentName,
        });
        savedRef = r.ref;
      } else {
        const r = await createWalkInTicketBooking({
          kind: kind === "onlyentry" ? "onlyentry" : kind === "group" ? "group" : "cover",
          name, email, phone,
          guests,
          total,            // cover + entry = total collected at the door
          tier: "",
          type: kind === "onlyentry" ? "onlyentry" : "cover",
          eventId, eventTitle,
          notes: noteStr,
          staffName: agentName,
          paymentMethod: total === 0 ? "comp" : payMethod,
          paymentRef: "",   // EDC machine prints its own receipt
          paymentSplit: payMethod === "split"
            ? { cash: splitCash, upi: splitUpi, card: splitCard }
            : undefined,
          ...(kind === "onlyentry" ? { entryType: "entryonly", qty: 1 } : {}),
        });
        savedRef = r.ref;
      }

      // ── Activate the wallet. Balance = COVER ONLY. Two write paths because
      // activateCoverForBooking() rejects amount < 1 (₹0 → ensureZero stub).
      // onlyentry may also carry an optional cover wallet (coverAmount > 0).
      const walletAmount = (kind === "cover" || kind === "onlyentry") ? coverAmount : 0;
      if (walletAmount > 0) {
        const booking: HodBooking = {
          id: savedRef, ref: savedRef, name: name.trim(), phone: cleanPhone, email,
          eventId, eventTitle, date: TODAY_STR(),
          total: walletAmount,
          paymentId: payMethod === "cash" ? `cash_${savedRef}` : "",
        } as HodBooking;
        try {
          await activateCoverForBooking({
            booking, amount: walletAmount,
            paymentMethod: payMethod === "split" ? "split" : payMethod,
            paymentSplit: payMethod === "split"
              ? { cash: splitCash, upi: splitUpi, card: splitCard, paid_online: 0 }
              : undefined,
            staffName: agentName,
          });
        } catch (writeErr: any) {
          const m = String(writeErr?.message || writeErr);
          if (!/already activated/i.test(m)) throw writeErr;
        }
      } else {
        await ensureZeroBalanceCoverForGuest({
          bookingRef: savedRef, sourceDocId: savedRef,
          name: name.trim(), phone: cleanPhone,
          source: kind === "guestlist" ? "guestlist" : "booking",
          eventId: eventId || "", eventTitle: eventTitle || "", staffName: agentName,
        });
      }

      // ── Read-back verify the wallet exists (fail-loud on silent write fail).
      const verify = await getCoverForBooking(savedRef);
      if (!verify) throw new Error("Wallet did not save — check internet and retry");
      const okAmount = Math.max(0, Math.round(Number(verify.coverBalance) || walletAmount || 0));

      // ── COVER+TABLE flow: bind the wallet to the table reservation.
      // Fail-open: a link failure never blocks the wallet (bar can still find
      // it by phone / ref / QR).
      let linkMsg = "";
      if (linkToTable) {
        const tblBit = linkToTable.tableId ? ` TABLE ${linkToTable.tableId}` : " TABLE";
        try {
          const lr = await linkCoverToTable(
            linkToTable.tableResRef, savedRef, verify.id, okAmount,
            { tableId: linkToTable.tableId, floorLabel: linkToTable.floorLabel },
          );
          linkMsg = (lr.tableOk && lr.coverOk)
            ? ` ·${tblBit} LINKED`
            : ` · ⚠ PARTIAL${tblBit} LINK (wallet still works at bar by phone/QR)`;
        } catch (linkErr: any) {
          console.warn("[door][cover+table] link failed", linkErr);
          linkMsg = ` · ⚠${tblBit} LINK FAILED (wallet still works at bar by phone/QR)`;
        }
      }

      setDone({ ref: savedRef, phone: waPhone, isCover: kind === "cover" || (kind === "onlyentry" && walletAmount > 0), total, coverAmount: walletAmount });
      setActionMsg(kind === "guestlist"
        ? `✅ GUEST LIST CONFIRMED · ₹0 WALLET SENT${linkMsg}`
        : kind === "onlyentry"
        ? walletAmount > 0
          ? `✅ ENTRY ONLY + COVER WALLET ₹${okAmount.toLocaleString("en-IN")} ACTIVATED · ₹${total.toLocaleString("en-IN")} COLLECTED${linkMsg}`
          : `✅ ENTRY ONLY · ₹${total.toLocaleString("en-IN")} COLLECTED${linkMsg}`
        : `✅ COVER ACTIVATION OF ₹${okAmount.toLocaleString("en-IN")} IS SUCCESSFUL${linkMsg}`);

      // ── Notify the customer. WhatsApp is AWAITED so we can auto-show the QR
      // the instant it isn't confirmed (cold walk-ins can only be reached by
      // an APPROVED Meta template; free text can't deliver outside the 24h
      // window — so the QR is the reliable handoff).
      const walletUrl = `https://hodclub.in/?wallet=${encodeURIComponent(savedRef)}`;

      // 🆕 2026-06-02 (Khushi) — EMAIL the confirmation. Previously the door
      // walk-in flow ONLY sent WhatsApp; the email Cloud Function was never
      // called (a stale comment wrongly claimed it was "auto-sent server-side").
      // Mirror the customer-site payload to the SAME sendBookingEmail endpoint.
      // Fire-and-forget + fail-open: an email problem must never block check-in.
      const emailAddr = email.trim();
      if (!emailAddr) {
        setEmailStatus("No email entered");
      }
      if (emailAddr) {
        setEmailStatus(`Sending to ${emailAddr}…`);
        try {
          const totalStr = walletAmount > 0
            ? `₹${walletAmount.toLocaleString("en-IN")} Paid`
            : total > 0 ? `₹${total.toLocaleString("en-IN")} Paid` : "FREE";
          const entryType = kind === "guestlist"
            ? "Guest List · Free Entry · ₹0 Wallet"
            : kind === "onlyentry"
            ? walletAmount > 0
              ? `Entry Only · ₹${entryTicket.toLocaleString("en-IN")} door fee + Cover Wallet ₹${walletAmount.toLocaleString("en-IN")} (Redeemable on F&B)`
              : `Entry Only · ₹${total.toLocaleString("en-IN")} (Non-redeemable door fee · wallet ₹0)`
            : `Cover · ₹${walletAmount.toLocaleString("en-IN")} (Redeemable on F&B)`;
          fetch(EMAIL_CF_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              to_email:     emailAddr,
              to_name:      name.trim(),
              ref:          savedRef,
              event_title:  eventTitle || "Tonight at H.O.D",
              event_date:   TODAY_STR(),
              event_time:   (linkToTable?.arrivalTime || "").trim(),
              event_venue:  "Koramangala 7th Block, Bengaluru",
              entry_type:   entryType,
              qty:          guests || 1,
              total:        totalStr,
              phone:        waPhone,
              club_name:    "HOD — House of Dopamine",
              club_phone:   "+91 96864 44906",
              club_address: "Koramangala 7th Block, Bengaluru",
              wallet_link:  walletUrl,
              qr_url:       `https://hodclub.in/?verify=${encodeURIComponent(savedRef)}`,
            }),
          })
            .then((r) => {
              if (r.ok) { console.log("[door][email] sent to", emailAddr); setEmailStatus(`Sent to ${emailAddr}`); }
              else { console.warn("[door][email] HTTP", r.status, "— not sent"); setEmailStatus("Email failed — show QR"); }
            })
            .catch((e) => { console.warn("[door][email] network error", e); setEmailStatus("Email failed — show QR"); });
        } catch (e) { console.warn("[door][email] threw", e); setEmailStatus("Email failed — show QR"); }
      }
      // For entry-only walk-ins, walletAmount is always ₹0 (entry fee is
      // non-redeemable). The WhatsApp template needs the ACTUAL collected amount
      // (entry fee) as `total` so pickBookingTemplate doesn't see ₹0 and bail,
      // and `entryType: "entryonly"` so detectWaCategory routes to entry_only_*
      // templates instead of ticket_confirmed_* (wrong param count → Meta rejects).
      const waTotal = kind === "onlyentry" ? total : walletAmount;
      const synthForWa: HodBooking = {
        id: savedRef, ref: savedRef, name: name.trim(), phone: waPhone,
        eventId: "", eventTitle: eventTitle || "Tonight at H.O.D",
        tier: "", type: kind === "guestlist" ? "stag" : "cover",
        total: waTotal, guests, date: TODAY_STR(),
        // The door girl ALREADY collected the money and confirmed the payment
        // mode, so the customer must NOT see "PAY AT VENUE". Mark this synthetic
        // booking PAID so WhatsApp template reads "✅ PAID". `isWalkIn` makes
        // the wording "PAID" (door) instead of "PAID ONLINE" (Razorpay only).
        // Throwaway object — never persisted.
        paymentId: waTotal > 0 ? `pay_walkin_${savedRef}` : "",
        isWalkIn: true,
        _isGuestList: kind === "guestlist",
        ...(kind === "onlyentry" ? { entryType: "entryonly" } : {}),
      } as any;
      let tpl = pickBookingTemplate(synthForWa, walletUrl);
      let fallbackText = buildBookingWhatsAppText(synthForWa, walletUrl);
      // 🆕 2026-06-02 (Khushi) — when this cover is linked to a TABLE, the guest's
      // WhatsApp must NAME the table (e.g. "SMK1 · Smoking Zone"). The synthetic
      // booking has no table fields, so the entry line read "COVER × N" only.
      // Append the table to the entry line in BOTH the approved template (entry
      // param is index 3 of the ticket_* templates) and the free-form fallback.
      if (linkToTable?.tableId) {
        const tblStr = `${doorProxyLabel(linkToTable.tableId) || linkToTable.tableId}${linkToTable.floorLabel ? ` · ${linkToTable.floorLabel}` : ""}`;
        if (tpl && /^ticket_/.test(tpl.name) && tpl.params.length >= 4) {
          const p = [...tpl.params];
          p[3] = `${p[3]} · 🪑 Table ${tblStr}`;
          tpl = { ...tpl, params: p };
        }
        // fallback free-form: insert a dedicated table line right after Entry.
        fallbackText = fallbackText.replace(/(🚪 Entry: .*\n)/, `$1🪑 Table: ${tblStr}\n`);
      }
      try {
        const waRes = await sendWhatsAppViaMeta({
          phone: waPhone,
          template: tpl ? { name: tpl.name, params: tpl.params } : undefined,
          fallbackText,
        });
        if (waRes.ok) {
          setActionMsg((m) => `${m} · 📲 SENT ON WHATSAPP`);
          logNotificationOutcome(savedRef, waRes.via === "template"
            ? { status: "sent_template", recipient: waPhone }
            : { status: "sent_text", recipient: waPhone });
        } else {
          // 🛟 SMART FALLBACK — auto-pop the QR so the door girl always has a
          // working way to hand over the wallet.
          setActionMsg((m) => `${m} · ⚠ WHATSAPP NOT CONFIRMED — SHOW THIS QR`);
          setShowQrModal({ url: walletUrl, title: "📷 SCAN WALLET" });
          logNotificationOutcome(savedRef, { status: "qr_shown", reason: "wa_failed", code: (waRes as any).code || "" });
        }
      } catch (waErr: any) {
        console.warn("[door][auto-wa] error", waErr);
        setActionMsg((m) => `${m} · ⚠ WHATSAPP FAILED — SHOW THIS QR`);
        setShowQrModal({ url: walletUrl, title: "📷 SCAN WALLET" });
      }
    } catch (e: any) {
      setErr(e?.message || "Could not save booking");
    } finally {
      setBusy(false);
    }
  };

  const ctaLabel = (() => {
    if (busy) return "⏳ Processing…";
    if (kind === "guestlist") return "✓ Add to Guest List & Send ₹0 Wallet";
    if (total === 0) return "✓ Confirm (No Charge) & Activate Wallet";
    return `✅ Confirm Payment of ₹${total.toLocaleString("en-IN")}`;
  })();

  // ── Reusable styles ──────────────────────────────────────────────────────
  const lbl: React.CSSProperties = { fontSize: 10, fontWeight: 800, color: "#000", letterSpacing: 1.2, marginBottom: 8, textTransform: "uppercase" };
  const inp: React.CSSProperties = { width: "100%", padding: "13px 14px", borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 600, outline: "none", boxSizing: "border-box", fontFamily: "inherit" };

  // Big 2×2 category card — yellow filled when active, dark+border when not.
  const catCard = (active: boolean, mini = false): React.CSSProperties => ({
    padding: mini ? "12px 10px" : "16px 12px",
    borderRadius: 12,
    // 2026-05-16 (Khushi v3): all 4 tabs now have a soft gold outline so
    // they read as "tappable cards" even when not selected. Active state
    // promotes to a thicker solid gold border + filled background.
    border: "2px solid #000",
    background: active ? "#FF90E8" : "#fff",
    cursor: "pointer", color: "#000", fontFamily: "inherit",
    textAlign: "center", transition: "transform .12s",
  });

  // Done screen (success confirmation, unchanged).
  if (done) {
    // 2026-05-16 (Khushi v2): /menu page doesn't exist on hodclub.in yet —
    // point at the customer site root which has menu + wallet inline.
    // 2026-05-16 (Khushi v3): SEND MENU + SHOW QR now both use the WALLET
    // link (https://hodclub.in/?wallet=REF), matching the auto-fired
    // WhatsApp message exactly. The customer's wallet page on hodclub.in
    // already shows the menu, so 1 link covers both. No more 2 messages.
    const walletUrl = `https://hodclub.in/?wallet=${encodeURIComponent(done.ref)}`;

    // 📲 RESEND WALLET — fallback in case the auto-fire WhatsApp didn't
    // land (Meta rate limit / customer blocked etc). Re-uses the SAME
    // approved template the auto-fire used — guarantees same message.
    // FALLBACK: if Meta rejects we open the QR popup as offline path.
    //
    // 🔴 2026-05-18 (Khushi CRITICAL) — wallet unlock CANNOT depend on WhatsApp.
    // ALWAYS ensure the cover doc exists FIRST (idempotent — no-op if already
    // there). After this, even if WhatsApp fails 100%, the QR popup + copy-link
    // path will unlock the menu the moment the guest scans/opens the link.
    const sendMenu = async () => {
      setActionMsg("Re-sending wallet link on WhatsApp…");
      // Guarantee wallet is unlocked — mint cover doc independent of WA outcome
      try {
        const cleanPh = (phone || "").replace(/\D/g, "").slice(-10);
        await ensureZeroBalanceCoverForGuest({
          bookingRef: done.ref, sourceDocId: done.ref,
          name, phone: cleanPh,
          source: kind === "guestlist" ? "guestlist" : "booking",
          eventId, eventTitle, staffName: agentName,
        });
      } catch (e) { console.warn("[door][sendMenu] cover ensure failed (continuing)", e); }
      // 🔴 2026-05-21 (Khushi) — route through pickBookingTemplate so the
      // RESEND uses the SAME approved template the auto-fire used. Walk-in
      // bookings (paymentId="") → unpaid variants per detectWaPaid.
      const synthetic: HodBooking = {
        id: done.ref,
        ref: done.ref,
        name: name || "Guest",
        phone: done.phone,
        eventId: eventId || "",
        eventTitle: eventTitle || "Tonight at H.O.D",
        tier: "",
        type: kind === "guestlist" ? "stag" : "cover",
        total: Math.max(0, Math.round(Number(done.coverAmount) || 0)),
        guests: Math.max(1, guests),
        date: TODAY_STR(),
        // 🆕 2026-06-02 (Khushi) — money was already collected at the door, so
        // the RESEND must match the auto-fire and read "✅ PAID" (never
        // "PAY AT VENUE"). Mark paid for cover (>0); guestlist stays ₹0/unpaid.
        paymentId: Number(done.coverAmount) > 0 ? `pay_walkin_${done.ref}` : "",
        isWalkIn: true,
        _isGuestList: kind === "guestlist",
      } as any;
      const tpl = pickBookingTemplate(synthetic, walletUrl);
      const fallbackText = buildBookingWhatsAppText(synthetic, walletUrl);
      const r = await sendWhatsAppViaMeta({
        phone: done.phone,
        template: tpl ? { name: tpl.name, params: tpl.params } : undefined,
        fallbackText,
      });
      if (r.ok) setActionMsg(`✅ Wallet link re-sent on WhatsApp (${r.via})`);
      else { setActionMsg("⚠ WhatsApp failed — showing QR fallback"); setShowQrModal({ url: walletUrl, title: "📷 SCAN WALLET" }); }
    };

    // 📷 SHOW QR — instant offline path. Customer scans the WALLET URL
    // (not menu) — opens their personal wallet page on hodclub.in.
    const showMenuQr = () => setShowQrModal({ url: walletUrl, title: "📷 SCAN WALLET" });

    // 🆕 2026-06-02 (Khushi) — the wallet is ALREADY created + activated in
    // submit() (cover credited, ₹0 minted for guest list, table linked, QR/
    // WhatsApp fired). This screen just confirms + offers RESEND / QR / NEXT.
    const headline = kind === "guestlist"
      ? "Guest List Confirmed"
      : `Cover Activation of ₹${(done.coverAmount || 0).toLocaleString("en-IN")} Successful`;

    return (
      <>
        <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", backdropFilter: "blur(8px)", zIndex: 9999, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 24, width: "100%", maxWidth: 420, textAlign: "center", marginTop: 24, marginBottom: 24 }}>
            {/* 🆕 2026-06-02 (Khushi) — top BACK button so the door girl can always
                dismiss this screen even on a short tablet where the bottom Close
                scrolled off; whole overlay is now scrollable (alignItems flex-start
                + overflowY auto) so nothing is cropped top/bottom. */}
            <div style={{ textAlign: "left", marginBottom: 10 }}>
              <button onClick={onClose} style={{ background: "#fff", border: "2px solid #000", borderRadius: 6, padding: "8px 14px", fontSize: 12, fontWeight: 800, color: "#000", cursor: "pointer" }}>← BACK</button>
            </div>
            <div style={{ fontSize: 56, marginBottom: 6 }}>✅</div>
            <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontSize: 20, fontWeight: 900, color: "#000", marginBottom: 4, lineHeight: 1.25 }}>{headline}</div>
            <div style={{ fontSize: 13, color: "#3D3D3D", fontWeight: 600, marginBottom: 2 }}>{name}{done.total > 0 ? ` · ₹${done.total.toLocaleString("en-IN")} collected` : ""}</div>
            <div style={{ fontSize: 11, fontFamily: "monospace", color: "#6B6B6B", marginBottom: 14 }}>{done.ref}</div>

            {/* 🆕 2026-06-02 (Khushi) — DETAILS popup + inline wallet QR, mirroring
                the "Table Booked" success screen so the cover/cover+table flow
                shows the full breakdown and a scannable QR in one place. */}
            {(() => {
              const rowS: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 0", borderBottom: "2px solid #000", fontSize: 13, textAlign: "left" };
              const lblS: React.CSSProperties = { color: "#6B6B6B", fontWeight: 700 };
              const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=10&data=${encodeURIComponent(walletUrl)}`;
              return (
                <>
                  <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 6, padding: "4px 12px", marginBottom: 14 }}>
                    <div style={rowS}><span style={lblS}>REF</span><span style={{ fontWeight: 900, fontFamily: "monospace" }}>{done.ref}</span></div>
                    <div style={rowS}><span style={lblS}>GUEST</span><span style={{ fontWeight: 800 }}>{name || "—"}</span></div>
                    {(numGirls > 0 || numBoys > 0) && (
                      <div style={rowS}><span style={lblS}>PAX</span><span style={{ fontWeight: 800 }}>{guests} ({numGirls}G · {numBoys}B)</span></div>
                    )}
                    {linkToTable && (
                      <div style={rowS}><span style={lblS}>TABLE</span><span style={{ fontWeight: 800 }}>{linkToTable.tableId ? `${linkToTable.tableId}${linkToTable.floorLabel ? ` · ${linkToTable.floorLabel}` : ""}` : "Unassigned — Captain assigns"}</span></div>
                    )}
                    {done.isCover && (
                      <div style={rowS}><span style={lblS}>COVER (redeemable)</span><span style={{ fontWeight: 800 }}>₹{(done.coverAmount || 0).toLocaleString("en-IN")}</span></div>
                    )}
                    <div style={rowS}><span style={lblS}>TOTAL COLLECTED</span><span style={{ fontWeight: 900 }}>₹{(done.total || 0).toLocaleString("en-IN")}</span></div>
                    <div style={{ ...rowS, borderBottom: "none" }}><span style={lblS}>✉️ EMAIL</span><span style={{ fontWeight: 800, color: emailStatus === "Email failed — show QR" ? "#FF5733" : emailStatus === "No email entered" ? "#6B6B6B" : "#23A094" }}>{emailStatus}</span></div>
                  </div>

                  <div style={{ textAlign: "center", marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: "#6B6B6B", letterSpacing: 1, marginBottom: 6 }}>SHOW THIS QR TO THE GUEST (WALLET)</div>
                    <div style={{ background: "#fff", padding: 10, borderRadius: 6, border: "2px solid #000", display: "inline-block" }}>
                      <img src={qrSrc} alt="Wallet QR" style={{ width: 240, height: 240, display: "block" }} />
                    </div>
                    <div style={{ fontSize: 10, color: "#6B6B6B", wordBreak: "break-all", marginTop: 8, fontFamily: "monospace" }}>{walletUrl}</div>
                  </div>
                </>
              );
            })()}

            {/* Wallet is already live — RESEND / SHOW QR / NEXT WALK-IN only. */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
              <button onClick={sendMenu}     style={_actionBtn("#23A094")}>📲 RESEND WALLET</button>
              <button onClick={showMenuQr}   style={_actionBtn("#FFD700")}>📷 SHOW QR</button>
              <button onClick={resetForNext} style={{ ..._actionBtn("#FF90E8"), gridColumn: "1 / span 2" }}>+ NEXT WALK-IN</button>
            </div>

            {actionMsg && (
              <div style={{ background: "#fff", border: "2px solid #000", color: "#000", padding: 10, borderRadius: 6, fontSize: 11.5, marginBottom: 12, lineHeight: 1.4, fontWeight: 600 }}>
                {actionMsg}
              </div>
            )}

            <button onClick={onClose} style={{ width: "100%", padding: 12, borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Close</button>
          </div>
        </div>
        {showQrModal && <QrPopup url={showQrModal.url} title={showQrModal.title} onClose={() => setShowQrModal(null)} />}
      </>
    );
  }

  // ── Main sheet ────────────────────────────────────────────────────────────
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", backdropFilter: "blur(8px)", zIndex: 9999, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 18, width: "100%", maxWidth: 440, marginTop: 24, marginBottom: 24, boxShadow: "none", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
        {/* Close button (top-right only — no title bar; the cards ARE the title) */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <BackBtn onClick={onClose} />
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#000", fontSize: 22, cursor: "pointer", lineHeight: 1, padding: 4 }}>✕</button>
        </div>

        {/* 🔴 2026-05-20 (Khushi) — COVER+TABLE flow: gold banner showing
            the linked table at the top. Replaces the 2×2 category grid so
            the door girl can't accidentally switch out of "BUY COVER". */}
        {linkToTable && (
          <div style={{
            background: "#FF90E8",
            border: "2px solid #000", borderRadius: 6, padding: "12px 14px", marginBottom: 14,
          }}>
            <div style={{ fontSize: 10, fontWeight: 900, letterSpacing: 1.2, color: "#000", marginBottom: 4 }}>
              💰 ACTIVATE COVER + TABLE
            </div>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#000" }}>
              {linkToTable.tableId ? `TABLE ${linkToTable.tableId}` : "TABLE (UNASSIGNED)"}
              {linkToTable.floorLabel ? ` · ${linkToTable.floorLabel}` : ""}
            </div>
            <div style={{ fontSize: 10.5, color: "#000", marginTop: 4, lineHeight: 1.45, fontWeight: 600 }}>
              CUSTOMER PAYS COVER NOW · REDEEM AT GF BAR OR AT THE TABLE.<br />
              🛟 FALLBACK: IF THIS SCREEN FAILS, WALLET STILL WORKS AT BAR — TABLE LINK CAN BE ADDED LATER.
            </div>
          </div>
        )}

        {/* THREE TABS: GUEST LIST · ENTRY ONLY · BUY COVERS.
            Hidden in COVER+TABLE flow (locked to "cover" by design). */}
        {!linkToTable && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
          <button onClick={() => setKind("guestlist")} style={catCard(kind === "guestlist", true)}>
            <div style={{ fontWeight: 900, fontSize: 11, letterSpacing: .5, color: "#000" }}>GUEST LIST</div>
            <div style={{ fontSize: 9, marginTop: 4, color: "#23A094", fontWeight: 800, letterSpacing: .5 }}>FREE ENTRY</div>
          </button>
          <button onClick={() => setKind("onlyentry")} style={catCard(kind === "onlyentry", true)}>
            <div style={{ fontWeight: 900, fontSize: 11, letterSpacing: .5, color: "#000" }}>ENTRY ONLY</div>
            <div style={{ fontSize: 9, marginTop: 4, color: "#FF5733", fontWeight: 800, letterSpacing: .5 }}>NON-REDEEMABLE</div>
          </button>
          <button onClick={() => setKind("cover")} style={catCard(kind === "cover", true)}>
            <div style={{ fontWeight: 900, fontSize: 11, letterSpacing: .5, color: "#000" }}>BUY COVERS</div>
            <div style={{ fontSize: 9, marginTop: 4, color: "#3D3D3D", fontWeight: 700, letterSpacing: .5 }}>REDEEMABLE F&amp;B</div>
          </button>
        </div>
        )}

        {/* Reassuring caption — hidden in COVER+TABLE flow (the gold banner
            above already explains what's happening). */}
        {!linkToTable && kind === "guestlist" && (
        <div style={{ fontSize: 11.5, color: "#23A094", marginBottom: 16, fontWeight: 700 }}>
          ✅ Free entry · A ₹0 wallet is created &amp; sent so they can top up to order
        </div>
        )}

        {/* ── ENTER YOUR DETAILS ─────────────────────────────────────────── */}
        <div style={lbl}>ENTER YOUR DETAILS</div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ ...lbl, fontSize: 9.5, marginBottom: 6 }}>FULL NAME</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer's full name" style={inp} autoFocus />
        </div>

        {/* PHONE — country-code dropdown (default +91) + 10-digit number. */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ ...lbl, fontSize: 9.5, marginBottom: 6 }}>PHONE NUMBER</div>
          <div style={{ display: "flex", alignItems: "stretch" }}>
            <select value={countryCode} onChange={(e) => setCountryCode(e.target.value)} style={{
              padding: "13px 8px", borderRadius: "6px 0 0 6px",
              background: "#fff", border: "2px solid #000", borderRight: "none",
              color: "#000", fontSize: 14, fontWeight: 700, fontFamily: "inherit", outline: "none", cursor: "pointer",
            }}>
              {(["+91", "+1", "+44", "+971", "+61", "+65", "+60", "+49", "+33", "+966", "+974"]).map((c) => (
                <option key={c} value={c} style={{ background: "#fff", color: "#000" }}>{c}</option>
              ))}
            </select>
            <input value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
              placeholder="XXXXX XXXXX" type="tel" inputMode="numeric"
              style={{ ...inp, borderRadius: "0 6px 6px 0" }} />
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ ...lbl, fontSize: 9.5, marginBottom: 6 }}>EMAIL ADDRESS <span style={{ color: "#B0B0B0", fontWeight: 600 }}>(optional)</span></div>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your@email.com" type="email" style={inp} />
        </div>

        {/* ── ENTRY FEE — dedicated input for ENTRY ONLY kind ────────────────── */}
        {kind === "onlyentry" && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ ...lbl, fontSize: 9.5, marginBottom: 6 }}>
              ENTRY FEE (₹) <span style={{ color: "#FF5733", fontWeight: 800 }}>· NOT REDEEMABLE ON F&amp;B</span>
            </div>
            <input type="text" inputMode="numeric" pattern="[0-9]*" value={entryTicketStr}
              onChange={(e) => setEntryTicketStr(e.target.value.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, ""))}
              placeholder="e.g. 599" style={{ ...inp, fontSize: 18, fontWeight: 800 }} />
            <div style={{ marginTop: 5, fontSize: 10, color: "#6B6B6B", lineHeight: 1.4 }}>
              Door entry charge only. This amount is NOT added to the wallet — it cannot be used on F&amp;B.
            </div>
          </div>
        )}

        {/* ── ENTRY TICKET (non-redeemable door fee, ₹0 default) — cover tab ─ */}
        {kind === "cover" && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ ...lbl, fontSize: 9.5, marginBottom: 6 }}>
              ENTRY TICKET (₹) <span style={{ color: "#B0B0B0", fontWeight: 700 }}>· NON-REDEEMABLE · OPTIONAL</span>
            </div>
            <input type="text" inputMode="numeric" pattern="[0-9]*" value={entryTicketStr}
              onChange={(e) => setEntryTicketStr(e.target.value.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, ""))}
              placeholder="0" style={inp} />
            <div style={{ marginTop: 5, fontSize: 10, color: "#6B6B6B", lineHeight: 1.4 }}>
              A flat door fee that is NOT added to the wallet. Leave 0 if there's no entry charge.
            </div>
          </div>
        )}

        {/* ── HEADCOUNT — No. of Girls / No. of Boys (both tabs) ───────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
          <div>
            <div style={{ ...lbl, fontSize: 9.5, marginBottom: 6 }}>NO. OF GIRLS</div>
            <input type="text" inputMode="numeric" pattern="[0-9]*" value={numGirls ? String(numGirls) : ""}
              onChange={(e) => setNumGirls(Math.max(0, parseInt(e.target.value.replace(/[^0-9]/g, "") || "0", 10) || 0))}
              placeholder="0" style={inp} />
          </div>
          <div>
            <div style={{ ...lbl, fontSize: 9.5, marginBottom: 6 }}>NO. OF BOYS</div>
            <input type="text" inputMode="numeric" pattern="[0-9]*" value={numBoys ? String(numBoys) : ""}
              onChange={(e) => setNumBoys(Math.max(0, parseInt(e.target.value.replace(/[^0-9]/g, "") || "0", 10) || 0))}
              placeholder="0" style={inp} />
          </div>
        </div>

        {/* ── COVER AMOUNT (redeemable wallet) — BUY COVERS + ENTRY ONLY tabs ─ */}
        {(kind === "cover" || kind === "onlyentry") && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ ...lbl, fontSize: 9.5, marginBottom: 6 }}>
              COVER AMOUNT (₹){" "}
              {kind === "onlyentry"
                ? <span style={{ color: "#B0B0B0", fontWeight: 700 }}>· OPTIONAL · REDEEMABLE WALLET</span>
                : <span style={{ color: "#23A094", fontWeight: 800 }}>· REDEEMABLE WALLET</span>}
            </div>
            <input type="text" inputMode="numeric" pattern="[0-9]*" value={coverAmountStr}
              onChange={(e) => setCoverAmountStr(e.target.value.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, ""))}
              placeholder={kind === "onlyentry" ? "0 (leave blank for entry-only)" : "Type any amount, e.g. 1000"}
              style={{ ...inp, fontSize: 18, fontWeight: 800 }} />
            <div style={{ marginTop: 5, fontSize: 10, color: "#6B6B6B", lineHeight: 1.4 }}>
              {kind === "onlyentry"
                ? "Optional: add a redeemable wallet on top of the entry fee. Leave 0 if entry-only."
                : "100% redeemable on food & drinks. Goes straight into the customer's wallet."}
            </div>
          </div>
        )}

        {/* ── Total Amount summary (hidden when total = 0) ─────────────────── */}
        {total > 0 && (
          <div style={{
            background: "#FFD700", border: "2px solid #000",
            borderRadius: 6, padding: "12px 14px", marginBottom: 14,
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <div>
              <div style={{ fontSize: 12, color: "#000", fontWeight: 800 }}>Total to Collect</div>
              <div style={{ fontSize: 10, color: "#3D3D3D", marginTop: 2, fontWeight: 600 }}>
                Cover ₹{coverAmount.toLocaleString("en-IN")}{entryTicket > 0 ? ` + Entry ₹${entryTicket.toLocaleString("en-IN")}` : ""}{amenitiesTotal > 0 ? ` + Amenities ₹${amenitiesTotal.toLocaleString("en-IN")}` : ""}
              </div>
              {amenitiesTotal > 0 && amenitiesLabel && (
                <div style={{ fontSize: 9.5, color: "#6B6B6B", marginTop: 2, fontWeight: 600 }}>
                  🅿️ {amenitiesLabel} · non-redeemable
                </div>
              )}
            </div>
            <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontVariantNumeric: "tabular-nums", fontSize: 22, fontWeight: 900, color: "#000" }}>
              ₹{total.toLocaleString("en-IN")}
            </div>
          </div>
        )}

        {/* PAYMENT METHOD ROW — only when there's actually money to collect.
            Guestlist is free (₹0) so it skips this. 4 chips:
            Cash · UPI · Card · Split. UPI/Card use the EDC machine. */}
        {kind === "cover" && total > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={lbl}>HOW IS THE CUSTOMER PAYING?</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6 }}>
              {([
                { k: "cash"  as const, ic: "💵", txt: "CASH" },
                { k: "upi"   as const, ic: "📱", txt: "UPI" },
                { k: "card"  as const, ic: "💳", txt: "CARD" },
                { k: "split" as const, ic: "🪓", txt: "SPLIT" },
              ]).map((m) => {
                const active = payMethod === m.k;
                return (
                  <button key={m.k} onClick={() => setPayMethod(m.k)} style={{
                    padding: "10px 4px", borderRadius: 6, fontFamily: "inherit", cursor: "pointer",
                    border: "2px solid #000",
                    background: active ? "#FF90E8" : "#fff",
                    color: "#000", textAlign: "center",
                  }}>
                    <div style={{ fontSize: 16, lineHeight: 1 }}>{m.ic}</div>
                    <div style={{ fontSize: 9, fontWeight: 800, marginTop: 4, letterSpacing: .5 }}>{m.txt}</div>
                  </button>
                );
              })}
            </div>

            {(payMethod === "upi" || payMethod === "card") && (
              <div style={{ marginTop: 8, fontSize: 10.5, color: "#3D3D3D", fontWeight: 600, lineHeight: 1.4 }}>
                💳 Use the EDC machine — receipt prints automatically. No need to type anything.
              </div>
            )}
            {payMethod === "split" && (
              <div style={{ marginTop: 8, padding: 10, borderRadius: 6, background: "#fff", border: "2px solid #000" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 6 }}>
                  <div>
                    <div style={{ fontSize: 9, color: "#000", marginBottom: 3, fontWeight: 700 }}>💵 CASH</div>
                    <input type="number" min={0} value={splitCash || ""} onChange={(e) => setSplitCash(parseInt(e.target.value || "0"))} placeholder="0" style={{ ...inp, padding: "10px 10px", fontSize: 13 }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 9, color: "#000", marginBottom: 3, fontWeight: 700 }}>📱 UPI</div>
                    <input type="number" min={0} value={splitUpi || ""} onChange={(e) => setSplitUpi(parseInt(e.target.value || "0"))} placeholder="0" style={{ ...inp, padding: "10px 10px", fontSize: 13 }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 9, color: "#000", marginBottom: 3, fontWeight: 700 }}>💳 CARD</div>
                    <input type="number" min={0} value={splitCard || ""} onChange={(e) => setSplitCard(parseInt(e.target.value || "0"))} placeholder="0" style={{ ...inp, padding: "10px 10px", fontSize: 13 }} />
                  </div>
                </div>
                <div style={{ fontSize: 11, color: splitOk ? "#23A094" : "#FF5733", textAlign: "right", fontWeight: 800 }}>
                  Split: ₹{splitTotal.toLocaleString("en-IN")} / ₹{total.toLocaleString("en-IN")} {splitOk ? "✓" : "✗"}
                </div>
              </div>
            )}
          </div>
        )}

        {err && <div style={{ background: "#FF5733", border: "2px solid #000", color: "#fff", padding: 10, borderRadius: 6, fontSize: 12, marginBottom: 12, fontWeight: 700 }}>{err}</div>}

        {/* CTA — single full-width flat pink button (label flips by payMethod) */}
        <button onClick={submit} disabled={busy} style={{
          width: "100%", padding: 16, borderRadius: 6,
          background: busy ? "#F0B8E4" : "#FF90E8",
          border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900,
          cursor: busy ? "wait" : "pointer", letterSpacing: .3,
          boxShadow: "none",
        }}>
          {busy ? "Saving…" : ctaLabel}
        </button>

        <div style={{ marginTop: 12, textAlign: "center", fontSize: 10, color: "#6B6B6B" }}>
          Logged by <b style={{ color: "#000" }}>{agentName}</b> · {getOperationalNightStr()}
        </div>
      </div>
    </div>
  );
}

const DISCOUNT_CHOICES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 50];

function AddAggregatorBookingModal({ agentName, onClose, onBack }: { agentName: string; onClose: () => void; onBack: () => void }) {
  const today = getOperationalNightStr();
  const [aggregator, setAggregator] = useState<string>("zomato");
  const [discountPct, setDiscountPct] = useState<number>(getAggregatorDiscount("zomato"));
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [partySize, setPartySize] = useState(2);
  const [date, setDate] = useState(today);
  const [arrivalTime, setArrivalTime] = useState("21:00");
  const [tableId, setTableId] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [bookedTableIds, setBookedTableIds] = useState<Set<string>>(new Set());
  const [bookedDetails, setBookedDetails] = useState<Map<string, string>>(new Map());

  // Live-subscribe to reservations for the selected date so the table picker
  // greys out / labels tables already taken on that date.
  useEffect(() => {
    if (!date) return;
    const unsub = subscribeToHodReservations(date, (rows) => {
      const ids = new Set<string>();
      const details = new Map<string, string>();
      rows.forEach((r) => {
        if ((r as any).status === "cancelled") return;
        if (!r.tableId) return;
        ids.add(r.tableId);
        const who = r.customerName || "Booked";
        const src = (r.source || "in-house").toString().toUpperCase();
        details.set(r.tableId, `${who} · ${src}${r.arrivalTime ? ` · ${r.arrivalTime}` : ""}`);
      });
      setBookedTableIds(ids);
      setBookedDetails(details);
      // If the currently picked table just became taken, clear it
      if (tableId && ids.has(tableId)) setTableId("");
    });
    return unsub;
  }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the staff changes aggregator, suggest its default discount but don't lock it
  const handleAggregatorChange = (v: string) => {
    setAggregator(v);
    setDiscountPct(getAggregatorDiscount(v));
  };

  const submit = async () => {
    setErr("");
    if (!name.trim()) { setErr("Enter customer name"); return; }
    if (tableId && bookedTableIds.has(tableId)) { setErr(`Table ${tableId} is no longer available on ${date}`); return; }
    // L-A1 — door-side fraud gate: if the door agent picked an aggregator and
    // bumped the discount above the source's hardcoded default by more than
    // +5pp (e.g. Zomato default 30%, agent typed 50%), require Manager PIN +
    // reason and log to discountOverrideLog so it appears on the Live Monitor.
    // Lowering the discount (or matching the default) is allowed freely.
    const implied = getAggregatorDiscount(aggregator) || 0;
    let needOverrideLog = false;
    let overrideReason = "";
    if (discountPct > implied + DOOR_DISCOUNT_PIN_DELTA) {
      const ok = await requireDoorManagerPin(
        `Door booking on "${aggregator}" with ${discountPct}% discount\n(default ${implied}% + ${DOOR_DISCOUNT_PIN_DELTA}pp tolerance).\n\nGuest: ${name}\nTable: ${tableId || "(unassigned)"}`);
      if (!ok) return;
      overrideReason = window.prompt(`Reason for ${discountPct}% discount on this ${aggregator} booking:`)?.trim() || "(no reason given)";
      needOverrideLog = true;
    }
    setBusy(true);
    try {
      const t = tableId ? ALL_TABLES.find((x) => x.id === tableId) : undefined;
      const ref = await createAggregatorTableBooking({
        aggregator, discountPercent: discountPct,
        customerName: name, phone, partySize: Number(partySize) || 2,
        date, arrivalTime,
        tableId: t?.id, floor: t?.section, floorLabel: t ? (SECTION_LABELS[t.section] || t.section) : "",
        externalRef, notes, staffName: agentName,
      });
      // Log the manager override to the freshly-created reservation. The
      // helper throws on failure (no silent drop) — caught below so the door
      // agent sees the booking succeeded but the audit didn't (rare).
      if (needOverrideLog) {
        try {
          await recordWalkInDiscountOverride(ref, {
            by: agentName, valueBefore: implied, valueAfter: discountPct,
            reason: overrideReason, kind: "door-aggregator",
            sourceBefore: aggregator, sourceAfter: aggregator,
          });
        } catch (logErr: any) {
          alert(`⚠ Booking created but audit log FAILED:\n${logErr.message}\n\nNotify a manager so they can record this manually.`);
        }
      }
      alert(`✓ Booking added\n\nRef: ${ref}\nDiscount: ${discountPct}%${needOverrideLog ? "\n🔒 Manager-approved override logged." : ""}\nIt will appear in the Tables tab when ${date === today ? "active" : "the date arrives"}.`);
      onClose();
    } catch (e: any) {
      setErr(e?.message || "Failed to add booking");
      setBusy(false);
    }
  };

  // Filter aggregators (exclude in-house)
  const aggOpts = AGGREGATOR_OPTIONS.filter((a) => a.value !== "inhouse");

  const lbl = { fontSize: 10, fontWeight: 800, letterSpacing: ".5px", color: "#000", marginBottom: 4 } as const;
  const inp = { width: "100%", padding: 10, borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.88)", backdropFilter: "blur(8px)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 22, width: "100%", maxWidth: 440, maxHeight: "90vh", overflow: "auto", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <button onClick={onBack} style={{ background: "transparent", border: "none", color: "#000", fontSize: 18, cursor: "pointer", padding: 0 }}>←</button>
          <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontSize: 18, fontWeight: 900, color: "#000" }}>📲 Add Aggregator Booking</div>
        </div>
        <div style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 16 }}>
          Use this when a Zomato / Swiggy / EazyDiner booking didn't appear automatically. Transcribe from the aggregator's confirmation.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 10, marginBottom: 10 }}>
          <div>
            <div style={lbl}>AGGREGATOR *</div>
            <select value={aggregator} onChange={(e) => handleAggregatorChange(e.target.value)} style={inp}>
              {aggOpts.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </div>
          <div>
            <div style={lbl}>DISCOUNT % *</div>
            <select value={discountPct} onChange={(e) => setDiscountPct(Number(e.target.value))} style={inp}>
              {DISCOUNT_CHOICES.map((p) => (
                <option key={p} value={p}>{p}%{p === getAggregatorDiscount(aggregator) ? " (default)" : ""}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div>
            <div style={lbl}>CUSTOMER NAME *</div>
            <input value={name} onChange={(e) => setName(e.target.value)} style={inp} placeholder="Full name" />
          </div>
          <div>
            <div style={lbl}>PHONE</div>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} style={inp} placeholder="10-digit (optional)" inputMode="numeric" />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div>
            <div style={lbl}>PARTY *</div>
            <input type="number" min={1} max={30} value={partySize} onChange={(e) => setPartySize(Number(e.target.value))} style={inp} />
          </div>
          <div>
            <div style={lbl}>DATE *</div>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} min={today} style={inp} />
          </div>
          <div>
            <div style={lbl}>TIME *</div>
            <input type="time" value={arrivalTime} onChange={(e) => setArrivalTime(e.target.value)} style={inp} />
          </div>
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={lbl}>
            TABLE (optional — leave blank if unassigned)
            <span style={{ marginLeft: 8, color: bookedTableIds.size > 0 ? "#FF5733" : "#6B6B6B", fontWeight: 700 }}>
              · {bookedTableIds.size} taken on {date}
            </span>
          </div>
          <select value={tableId} onChange={(e) => setTableId(e.target.value)} style={inp}>
            <option value="">— Unassigned (assign later) —</option>
            {ALL_TABLES.map((t) => {
              const taken = bookedTableIds.has(t.id);
              const why = taken ? bookedDetails.get(t.id) : "";
              return (
                <option key={t.id} value={t.id} disabled={taken}
                  style={taken ? { color: "#B0B0B0", background: "#fff" } : undefined}>
                  {taken ? "🔒 " : ""}{t.id} · {t.name} · {SECTION_LABELS[t.section] || t.section} · {t.capacity} seats{t.isVIP ? " · VIP" : ""}{taken ? ` — ${why}` : ""}
                </option>
              );
            })}
          </select>
          {tableId && bookedTableIds.has(tableId) && (
            <div style={{ marginTop: 6, fontSize: 11, color: "#FF5733" }}>⚠️ Just got booked by someone else — pick another</div>
          )}
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={lbl}>AGGREGATOR REF / BOOKING ID (optional)</div>
          <input value={externalRef} onChange={(e) => setExternalRef(e.target.value)} style={inp} placeholder="e.g. ZOM-12345" />
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={lbl}>NOTES (optional)</div>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} style={inp} placeholder="e.g. anniversary, prefers rooftop" />
        </div>

        {err && <div style={{ background: "#FF5733", border: "2px solid #000", color: "#fff", padding: 10, borderRadius: 6, fontSize: 12, marginBottom: 10, fontWeight: 700 }}>{err}</div>}

        <button onClick={submit} disabled={busy}
          style={{ width: "100%", padding: 14, borderRadius: 6, background: busy ? "#F0B8E4" : "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 14, fontWeight: 900, cursor: busy ? "wait" : "pointer", letterSpacing: ".5px" }}>
          {busy ? "Adding..." : "✓ Add Booking"}
        </button>
        <button onClick={onClose} style={{ width: "100%", marginTop: 8, padding: 11, borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 12, cursor: "pointer", fontWeight: 700 }}>Cancel</button>
      </div>
    </div>
  );
}

function DoorDashboard({ agentName, onLogout }: { agentName: string; onLogout: () => void }) {
  const [tab, setTab] = useState<"all" | "tickets" | "guestlist" | "tables" | "corporate" | "onlyentry" | "waitlist">("all");
  // 🆕 2026-06-02 (Khushi) — LIVE waitlist count for the WAITLIST tab badge.
  // Track the operational-night date in state so the badge re-subscribes across
  // the overnight rollover (the door tablet stays open all night).
  const [waitlistCount, setWaitlistCount] = useState(0);
  const [waitlistDate, setWaitlistDate] = useState<string>(() => CALENDAR_TODAY_STR());
  useEffect(() => {
    const h = setInterval(() => {
      const d = CALENDAR_TODAY_STR();
      setWaitlistDate((prev) => (prev === d ? prev : d));
    }, 60000);
    return () => clearInterval(h);
  }, []);
  useEffect(() => {
    if (!waitlistDate) return;
    const unsub = subscribeWaitlist(waitlistDate, (rows) => {
      setWaitlistCount(rows.filter((r) => r.status === "waiting" || r.status === "offered").length);
    });
    return () => unsub();
  }, [waitlistDate]);
  // 🔴 2026-05-20 (Khushi) — LIVE REPORTS modal toggle. Header button opens this.
  const [liveReportsOpen, setLiveReportsOpen] = useState(false);
  // 🔴 2026-05-22 (Khushi COST FIX) — Live Reports covers subscription MOVED
  // INTO the modal itself (see LiveReportsModal). Parent no longer subscribes
  // — modal opens rarely + needs night-picker support, so dashboard-wide
  // subscription was both wasteful AND broken for past-night rewind.
  const [qrModal, setQrModal] = useState<{ bookingRef: string; walletUrl: string; customerName: string; reason: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [tableBookingOpen, setTableBookingOpen] = useState(false);
  const [lookupResult, setLookupResult] = useState<HodBooking | null>(null);
  const [searchInput, setSearchInput] = useState("");
  // 🔎 v3.4 — cross-collection Find Booking results (debounced, queries
  // `bookings` + `aggregatorBookings` so walk-ups with future-date or
  // not-yet-loaded reservations are findable).
  const [crossResults, setCrossResults] = useState<CrossSourceBooking[]>([]);
  const [crossLoading, setCrossLoading] = useState(false);
  useEffect(() => {
    const q = searchInput.trim();
    if (q.length < 2) { setCrossResults([]); setCrossLoading(false); return; }
    setCrossLoading(true);
    const handle = setTimeout(async () => {
      try {
        const r = await searchBookingsAndAggregators(q);
        setCrossResults(r);
      } finally { setCrossLoading(false); }
    }, 350);
    return () => clearTimeout(handle);
  }, [searchInput]);
  const [coverFor, setCoverFor] = useState<HodBooking | null>(null);
  // 🔴 2026-05-20 (Khushi) — COVER+TABLE flow. When set, opens UnifiedWalkInModal
  // pre-filled and locked to "cover" so door girl can recharge the wallet
  // attached to the table she just created. Bidirectional doc link is
  // patched in after the wallet is activated (see linkCoverToTable).
  const [coverTableCtx, setCoverTableCtx] = useState<{
    tableResRef: string;
    arrivalTime: string;
    prefill: { name: string; phone: string; email: string; pax: number; girls: number; boys: number };
    tableInfo: { tableId?: string; floorLabel?: string; amenitiesTotal: number; amenitiesLabel: string };
  } | null>(null);
  // 🎯 2026-05-19 (Khushi LIVE-NIGHT) — when search-panel TONIGHT MATCH for a
  // table is tapped, we set this so TablesTab pops open the table's detail
  // modal. Consumed (set null) by TablesTab once it opens, so closing the
  // modal doesn't re-open it.
  const [tablesFocusDocId, setTablesFocusDocId] = useState<string | null>(null);
  const [events, setEvents] = useState<HodEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>("all");
  const [allPickerOpen, setAllPickerOpen] = useState(false);

  // Persist agent name as door staff in sessionStorage so check-ins pick it up too
  useEffect(() => {
    sessionStorage.setItem("hod_door_staff", agentName);
  }, [agentName]);

  useEffect(() => {
    // v3.96 — scoped to last 7 days + future (was unfiltered). Renders the
    // tonight + upcoming chips below; never needs historical events.
    const unsub = subscribeToHodEventsRecent(7, (all) => setEvents(all));
    return unsub;
  }, []);

  const today = TODAY_STR();
  // Tonight's events first, then upcoming (next 7 days), capped at 5 chips total
  const tonight = events.filter((e) => (e.date || "") === today);
  const upcoming = events.filter((e) => (e.date || "") > today).slice(0, Math.max(0, 5 - tonight.length));
  const eventChips = [...tonight, ...upcoming];
  // 🆕 2026-06-02 v3.171 — the selected event's DATE drives the per-event view
  // scope (passed to every tab + used by the counters). Empty for "all".
  const selectedEventDate = selectedEventId === "all"
    ? ""
    : (events.find((e) => e.id === selectedEventId)?.date || "");

  // Auto-select tonight's event if exactly one — only on first load, not on
  // every Firestore refresh, so user can explicitly click ALL to see the picker.
  const hasAutoSelected = useRef(false);
  useEffect(() => {
    if (!hasAutoSelected.current && selectedEventId === "all" && tonight.length === 1) {
      setSelectedEventId(tonight[0].id);
      hasAutoSelected.current = true;
    }
    // If selected event no longer in chip list (e.g. data refreshed), reset to all
    if (selectedEventId !== "all" && eventChips.length && !eventChips.find((e) => e.id === selectedEventId)) {
      setSelectedEventId("all");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length]);

  // 2026-05-12 (Khushi spec) — QR scans now open the full BookingDetailModal
  // (Check-In · Activate Cover · WhatsApp · Show QR · Call) instead of the
  // inline LookupResult, matching the row-tap behaviour everywhere else in
  // Door Mode.
  const [scanDetail, setScanDetail] = useState<HodBooking | null>(null);
  const handleQrResult = async (data: string) => {
    setScanning(false);
    let ref = data;
    // 🐛 FIX 2026-05-08: customer-site QRs encode `?verify=REF` (not `?ref=`),
    // so without this key we'd pass the full URL into lookupBooking → "Lookup failed".
    try { const url = new URL(data); ref = url.searchParams.get("verify") || url.searchParams.get("ref") || url.searchParams.get("wallet") || url.searchParams.get("id") || data; } catch {}
    try {
      const b = await lookupBooking(ref);
      if (!b) { alert("No booking found for this QR code"); return; }
      // 🆕 2026-05-27 v3.100 (Khushi LIVE-NIGHT) — TABLE bookings (TBL-/HODTAB/
      // AGG-) opened the generic BookingDetailModal which showed "CHECK IN
      // GUEST" + "Activate Cover" — wrong for tables (tables have a richer
      // detail modal with editable pax/time/date/phone + Arrived + Reassign,
      // same one used when you tap a row in the TABLES tab). Now: detect
      // _isTable, find the matching tableReservation doc in tonight's
      // subscription, switch to TABLES/CORPORATE tab, and pop that exact
      // modal via the existing focusDocId mechanism.
      // 🛟 FAIL-OPEN: if the table doc isn't in tonight's subscription (e.g.
      // cross-night, or subscription hasn't loaded yet), fall back to the
      // legacy BookingDetailModal — door girl is NEVER stranded.
      if ((b as any)._isTable) {
        const allTables: HodTableReservation[] = [];
        const seen = new Set<string>();
        Object.values(tableResByDate).forEach((rows) => rows.forEach((r) => {
          if (!r._docId || seen.has(r._docId)) return;
          seen.add(r._docId); allTables.push(r);
        }));
        const match = allTables.find((r) => r.bookingRef === b.id || r.bookingRef === b.ref || r._docId === b.id);
        if (match && match._docId) {
          setTab(isCorporateTableRes(match) ? "corporate" : "tables");
          setTablesFocusDocId(match._docId);
          return;
        }
      }
      setScanDetail(b);
    } catch { alert("Lookup failed"); }
  };

  // 🔴 2026-05-16 (Khushi) — MINI DASHBOARD ON MAIN PAGE.
  // Subscribe at parent level once so the tab buttons show live counts of
  // tonight's bookings per category. Same data sources + filter rules as the
  // child tabs (so the numbers match exactly what the door girl sees inside).
  const [allBookings, setAllBookings] = useState<HodBooking[]>([]);
  const [allGuests, setAllGuests] = useState<HodGuestlistEntry[]>([]);
  // Per-date map so removals (cancellations / date edits) evict stale rows
  // instead of sticking around forever in the accumulator.
  const [tableResByDate, setTableResByDate] = useState<Record<string, HodTableReservation[]>>({});
  // 🔴 2026-05-23 (Khushi COST FIX r2) — DoorDashboard tabCounts only needs
  // TONIGHT'S bookings + guestlist (see line ~5314, 5318 filters). The
  // unfiltered subscriptions were burning ~entire-collection reads every
  // single time any door PC loaded, all night long. Now scoped to today.
  // 🆕 2026-06-02 v3.171 — 3-night window so a future event chip's counts can
  // be computed. The COUNTERS still show TONIGHT for "all" (see tabCounts
  // dateScope below) — only a selected future chip scopes them to its date.
  useEffect(() => {
    const u = subscribeToBookingsForNights(BOOKING_WINDOW_DATES(), setAllBookings);
    return () => u();
  }, []);
  useEffect(() => {
    const c = CALENDAR_TODAY_STR();
    const u = subscribeToGuestlistInRange(addDaysStr(c, -1), addDaysStr(c, 3), setAllGuests);
    return () => u();
  }, []);
  useEffect(() => {
    // v3.143 — subscribe to every night in the window (op-night, calendar today,
    // tomorrow) so the dashboard table counters include next-day pre-bookings.
    const unsubs = TABLE_WINDOW_DATES().map((n) =>
      subscribeToHodReservations(n, (rows) => setTableResByDate((m) => ({ ...m, [n]: rows }))),
    );
    return () => { unsubs.forEach((u) => u()); };
  }, []);

  const tabCounts = (() => {
    // 🆕 2026-06-02 v3.171 — counters scoped like the tabs: ALL → TONIGHT,
    // a specific event chip → that event's date.
    const todayDates = eventDateScope(selectedEventId, selectedEventDate);
    // Bookings — match BookingsListTab filter rules exactly.
    const today = allBookings.filter((b) => todayDates.has((b.date || "").slice(0, 10)) && !isGuestlistBooking(b));
    const inEvent = (b: HodBooking) => selectedEventId === "all" || !b.eventId || b.eventId === selectedEventId;
    // 🔴 Guestlist — match GuestlistTab logic: filter by today (joinedAt|entryTime)
    // and dedupe against guestlist-typed bookings (line ~1590).
    const todayGuests = allGuests.filter((g) => {
      const ja = ((g as any).joinedAt || "").slice(0, 10);
      const et = ((g as any).entryTime || "").slice(0, 10);
      return todayDates.has(ja) || todayDates.has(et);
    });
    const glIds = new Set(todayGuests.map((g) => g.id));
    // 🆕 2026-06-02 (Khushi) — chip-vs-list parity. GuestlistTab ALSO filters the
    // guests collection by the selected event (line ~2825); this counter did NOT,
    // so a guest whose date matched tonight but whose eventId differed from the
    // selected event was COUNTED in the chip yet HIDDEN in the list → "1" vs "0".
    // Apply the SAME permissive event filter (keep entries with no eventId).
    const todayGuestsInEvent = todayGuests.filter((g) => inEvent(g as any));
    const guestlistFromBookings = allBookings.filter((b) =>
      isGuestlistBooking(b) &&
      (todayDates.has((b.date || "").slice(0, 10)) || todayDates.has(((b as any).bookedAt || "").slice(0, 10))) &&
      !glIds.has(b.id) &&
      inEvent(b)
    );
    // 🆕 2026-06-02 v3.171 — Tables count now matches TablesTab's date/event
    // scope (ALL → tonight, specific chip → that event's date; lenient eventId
    // since walk-in tables carry none). De-dupe via _docId across nights.
    const tableSeen = new Set<string>();
    const allTables: HodTableReservation[] = [];
    Object.values(tableResByDate).forEach((rows) => rows.forEach((r) => {
      if (!r._docId || tableSeen.has(r._docId)) return;
      if (!todayDates.has((r.date || "").slice(0, 10))) return;
      if (!(selectedEventId === "all" || !(r as any).eventId || (r as any).eventId === selectedEventId)) return;
      tableSeen.add(r._docId); allTables.push(r);
    }));
    // 🔴 2026-05-20 (Khushi) — GROUP merged into TICKETS; new CORPORATE tab
    // pulled out of tableReservations. Tables count now excludes corporate so
    // a reservation is only counted once across the dashboard.
    const activeTables = allTables.filter((r) => (r as any).status !== "cancelled");
    const tickets   = today.filter((b) => !isOnlyEntryBooking(b) && !isTableBooking(b) && inEvent(b)).length;
    const guestlist = todayGuestsInEvent.length + guestlistFromBookings.length;
    const tables    = activeTables.filter((r) => !isCorporateTableRes(r)).length;
    const corporate = activeTables.filter(isCorporateTableRes).length;
    const onlyentry = today.filter((b) => isOnlyEntryBooking(b) && inEvent(b)).length;
    return {
      tickets, guestlist, tables, corporate, onlyentry,
      // 🔴 2026-05-20 (Khushi) — ALL tab count = sum of every category.
      all: tickets + guestlist + tables + corporate + onlyentry,
    };
  })();

  const tabs = [
    { key: "all" as const,       label: "ALL",            count: tabCounts.all },
    { key: "tickets" as const,   label: "TICKETS",        count: tabCounts.tickets },
    { key: "guestlist" as const, label: "GUEST LIST",     count: tabCounts.guestlist },
    { key: "tables" as const,    label: "TABLES",         count: tabCounts.tables },
    { key: "corporate" as const, label: "CORPORATE",      count: tabCounts.corporate },
    { key: "onlyentry" as const, label: "ENTRY PASS",     count: tabCounts.onlyentry },
    { key: "waitlist" as const,  label: "WAITLIST",       count: waitlistCount },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#F4F4F0", color: "#000", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
      <div style={{ background: "#F4F4F0", borderBottom: "2px solid #000", padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <Link href="/"
            style={{ padding: "8px 12px", borderRadius: 6, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 12, fontWeight: 900, cursor: "pointer", textDecoration: "none", whiteSpace: "nowrap", letterSpacing: .3 }}>
            ← POS
          </Link>
          <div style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontSize: 22, fontWeight: 900, color: "#000", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: -.5 }}>
            Door
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <span style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontSize: 12, color: "#6B6B6B", fontWeight: 800 }}>{agentName}</span>
          {/* 🔴 2026-05-20 (Khushi) — LIVE REPORTS button, sits LEFT of LOGOUT.
              Opens a full-screen modal with real-time KPI tiles + CSV export. */}
          <button onClick={() => setLiveReportsOpen(true)}
            style={{ padding: "8px 12px", borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 11, fontWeight: 900, cursor: "pointer", letterSpacing: .4, display: "flex", alignItems: "center", gap: 4 }}
            title="Live Reports — real-time KPIs for tonight">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#23A094", boxShadow: "none", display: "inline-block" }} />
            LIVE REPORTS
          </button>
          <button onClick={onLogout}
            style={{ padding: "8px 12px", borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#FF5733", fontSize: 11, fontWeight: 800, cursor: "pointer", letterSpacing: .3 }}>
            LOGOUT
          </button>
        </div>
      </div>

      <div style={{ padding: "12px 16px" }}>
        {/* Search bar */}
        <div style={{ position: "relative", marginBottom: 10 }}>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search"
            style={{ width: "100%", padding: "13px 16px", borderRadius: 8, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 14, outline: "none", boxSizing: "border-box", textAlign: "center" }}
          />
          {searchInput && (
            <button onClick={() => setSearchInput("")}
              style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", padding: "4px 10px", borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              ✕ Clear
            </button>
          )}
        </div>

        {/* Action row: Scan + New Walk-in + (below) New Table Booking */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
          <button onClick={() => setScanning(true)}
            style={{ padding: 14, borderRadius: 8, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.5px", cursor: "pointer" }}>
            Scan QR
          </button>
          <button onClick={() => setWalkInOpen(true)}
            style={{ padding: 14, borderRadius: 8, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.5px", cursor: "pointer" }}>
            New Walk-in
          </button>
        </div>
        {/* 🔴 2026-05-19 (Khushi LIVE-NIGHT) — NEW TABLE BOOKING button, full
            width, sits directly under NEW WALK IN per door staff request. */}
        <button onClick={() => setTableBookingOpen(true)}
          style={{ width: "100%", padding: 14, borderRadius: 8, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 13, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.5px", cursor: "pointer", marginBottom: 14 }}>
          🍽 New Table Booking
        </button>

        {lookupResult && (
          <LookupResult booking={lookupResult} agentName={agentName} onDone={() => setLookupResult(null)} />
        )}

        {/* 🔴 SEARCH PANEL — 2026-05-19 (Khushi LIVE-NIGHT) REWRITE.
            OLD behaviour: only searched the CURRENT tab + a cross-collection
            ALL-DATES list that surfaced 6-month-old bookings on top of
            tonight's. Door staff typing "ajay" got last-month's Ajay instead
            of tonight's Ajay sitting at the door right now.
            NEW behaviour:
              1. TONIGHT MATCHES — in-memory scan across ALL tabs (tickets,
                 guestlist, tables, group, entry-pass) filtered to today's
                 operational night. Tapping jumps the user straight to the
                 right tab. Zero network — instant.
              2. OTHER DATES — the existing Firestore cross-collection
                 search, with tonight's matches subtracted (so no dupes).
                 Hidden behind a smaller heading so it never out-competes
                 tonight's data. */}
        {searchInput.trim().length >= 2 && !lookupResult && (() => {
          const q = searchInput.trim();
          const ql = q.toLowerCase();
          const qd = q.replace(/\D/g, "");
          const matchText = (s?: string) => !!s && String(s).toLowerCase().includes(ql);
          const matchPhone = (p?: string) => {
            if (!qd || qd.length < 4) return false;
            const pd = String(p || "").replace(/\D/g, "");
            return !!pd && pd.includes(qd);
          };
          const matches = (name?: string, phone?: string, ref?: string) =>
            matchText(name) || matchPhone(phone) || matchText(ref);

          const todayDates = TODAY_DATE_SET();
          const inDate = (d?: string) => todayDates.has((d || "").slice(0, 10));

          // 1. TICKETS / GROUP / ENTRY PASS (bookings, today, non-guestlist)
          // 🔴 BUGFIX 2026-05-19 (Khushi LIVE-NIGHT) — STRICT date match only.
          // Was: inDate(b.date) || inDate(b.bookedAt). Problem: `bookedAt` is
          // when the guest PAID, not when their event is. A booking paid today
          // for next Saturday was leaking into TONIGHT MATCHES. Now we match
          // ONLY against the event date `b.date`, same as the actual Tickets
          // tab filter at line ~1495. If `b.date` is missing, the booking is
          // ignored — it can still be found via "OTHER DATES" below or the
          // explicit ref/phone lookup.
          const todayBookings = allBookings.filter((b) =>
            inDate(b.date) && !isGuestlistBooking(b)
          );
          type Hit = { key: string; tab: typeof tab; label: string; name: string; phone: string; subtitle: string; ref: string; onClick: () => void; tone: string };
          const hits: Hit[] = [];
          // 🆕 2026-05-27 v3.50 (Khushi LIVE-NIGHT) — collect refs that ALREADY
          // exist in tonight's tableReservations FIRST. v3.47 alone was not
          // enough: if a HODTAB booking's `tableType` field wasn't set on the
          // `bookings` doc (legacy / cash-pending paths), isTableBooking(b)
          // returned false and the TICKET badge slipped through alongside the
          // TABLE badge. Now we also dedup by ref: any booking whose ref is
          // already on a tableReservations row tonight is skipped under
          // TICKETS, guaranteed. TABLE badge always wins.
          const tonightTableRefs = new Set<string>();
          for (const rows of Object.values(tableResByDate)) {
            for (const r of rows) {
              if ((r as any).status === "cancelled") continue;
              const tref = String((r as any).bookingRef || "").toLowerCase();
              if (tref) tonightTableRefs.add(tref);
            }
          }
          for (const b of todayBookings) {
            if (!matches(b.name, b.phone, b.ref)) continue;
            // 🆕 2026-05-27 v3.47 (Khushi LIVE-NIGHT) — TABLE bookings (HODTAB
            // table4/vip) must NOT appear under TONIGHT MATCHES as a TICKETS
            // badge. Post-v3.44 they also exist in tableReservations and
            // surface in the TABLES tab — the door girl was getting TWO
            // entries for the same guest with TWO separate "Activate Cover"
            // paths → double/triple ₹15K activations. Skip here; the
            // tableReservations match below still surfaces them under TABLES.
            if (isTableBooking(b)) continue;
            // v3.50 ref-based safety net (covers legacy/cash-pending HODTABs).
            if (b.ref && tonightTableRefs.has(b.ref.toLowerCase())) continue;
            // 🔴 2026-05-20 (Khushi) — GROUP tab removed; group bookings route
            // to TICKETS alongside the rest.
            const tabKey: typeof tab = isOnlyEntryBooking(b) ? "onlyentry" : "tickets";
            const tabLabel = tabKey === "onlyentry" ? "ENTRY PASS" : "TICKETS";
            hits.push({
              key: `b-${b.id}`, tab: tabKey, label: tabLabel,
              name: b.name || "(no name)", phone: b.phone || "",
              subtitle: `${b.eventTitle || ""} · ${b.ref || ""}`.replace(/^ · | · $/g, "").trim() || (b.ref || ""),
              ref: b.ref || b.id, tone: "#60A5FA",
              // 2026-05-19 — Khushi: tapping a TONIGHT MATCH must open the
              // full BookingDetailModal (Check-In · Activate Cover · WhatsApp
              // · QR · Call) — same modal as tapping the card in its tab.
              // Same path used by QR scans (`scanDetail`).
              onClick: () => { setScanDetail(b); },
            });
          }
          // 2. GUESTLIST (today)
          // 🔴 BUGFIX 2026-05-19 (Khushi LIVE-NIGHT) — also enforce date if
          // present on the guestlist doc. Some legacy entries have only
          // `joinedAt` (creation timestamp). If the entry has an explicit
          // `date` field, use THAT as the gate so future-night guests added
          // today don't leak into tonight.
          const todayGuests = allGuests.filter((g) => {
            const d = ((g as any).date || "").slice(0, 10);
            if (d) return todayDates.has(d);
            const ja = ((g as any).joinedAt || "").slice(0, 10);
            const et = ((g as any).entryTime || "").slice(0, 10);
            return todayDates.has(ja) || todayDates.has(et);
          });
          const adaptGuest = (g: any): HodBooking => ({
            id: g.id, ref: g.ref || g.id, name: g.name, phone: g.phone,
            eventId: g.eventId, eventTitle: g.eventTitle, type: g.type,
            total: 0, checkedIn: !!g.checkedIn,
            _isGuestList: true, _glDocId: g._bookingDocId || g.id,
            date: (g.joinedAt || g.entryTime || "").slice(0, 10),
          } as any);
          for (const g of todayGuests) {
            if (!matches(g.name, g.phone, (g as any).ref)) continue;
            hits.push({
              key: `g-${g.id}`, tab: "guestlist", label: "GUEST LIST",
              name: g.name || "(no name)", phone: g.phone || "",
              subtitle: ((g as any).entryType || "guestlist").toString(),
              ref: (g as any).ref || g.id, tone: "#34D399",
              onClick: () => { setScanDetail(adaptGuest(g)); },
            });
          }
          // Also include guestlist-typed bookings (parity with GuestlistTab merge)
          // 🔴 BUGFIX 2026-05-19 (Khushi LIVE-NIGHT) — same fix as above: drop
          // the `bookedAt` fallback so future-date guestlist bookings paid
          // today don't show under TONIGHT.
          const glIds = new Set(todayGuests.map((g) => g.id));
          for (const b of allBookings) {
            if (!isGuestlistBooking(b)) continue;
            if (!inDate(b.date)) continue;
            if (glIds.has(b.id)) continue;
            if (!matches(b.name, b.phone, b.ref)) continue;
            hits.push({
              key: `gb-${b.id}`, tab: "guestlist", label: "GUEST LIST",
              name: b.name || "(no name)", phone: b.phone || "",
              subtitle: b.ref || "", ref: b.ref || b.id, tone: "#34D399",
              onClick: () => { setScanDetail(b); },
            });
          }
          // 3. TABLES (today, dedup by _docId)
          const tableSeen = new Set<string>();
          for (const rows of Object.values(tableResByDate)) {
            for (const r of rows) {
              if (!r._docId || tableSeen.has(r._docId)) continue;
              tableSeen.add(r._docId);
              if ((r as any).status === "cancelled") continue;
              if (!matches((r as any).customerName, (r as any).phone, (r as any).bookingRef)) continue;
              // 🔴 2026-05-20 (Khushi) — corporate reservations route to the
              // CORPORATE tab, regular tables route to TABLES.
              const isCorp = isCorporateTableRes(r);
              hits.push({
                key: `t-${r._docId}`, tab: isCorp ? "corporate" : "tables", label: isCorp ? "CORPORATE" : "TABLE",
                name: (r as any).customerName || "(no name)", phone: (r as any).phone || "",
                subtitle: `${(r as any).tableId || ""} · ${(r as any).floorLabel || (r as any).floor || ""} · ${(r as any).arrivalTime || ""}`.replace(/ +/g, " ").trim(),
                ref: (r as any).bookingRef || r._docId, tone: isCorp ? "#A78BFA" : "#F59E0B",
                onClick: () => { setTab(isCorp ? "corporate" : "tables"); setTablesFocusDocId(r._docId!); },
              });
            }
          }
          // De-dup hits by ref so the same booking doesn't appear twice when
          // the bookings + guestlist collections both contain it.
          const seenRefs = new Set<string>();
          const tonightHits = hits.filter((h) => {
            const k = (h.ref || h.key).toLowerCase();
            if (seenRefs.has(k)) return false;
            seenRefs.add(k);
            return true;
          });
          // OTHER DATES = cross-collection results minus tonight's refs
          const otherDateHits = crossResults.filter((r) =>
            !seenRefs.has((r.ref || r.id).toLowerCase()) && !inDate(r.date)
          );

          return (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#000", letterSpacing: 1, marginBottom: 6 }}>
                🎯 TONIGHT MATCHES ({tonightHits.length})
              </div>
              {tonightHits.length === 0 ? (
                <div style={{ background: "#fff", border: "2px dashed #000", borderRadius: 8, padding: 10, fontSize: 11, color: "#6B6B6B", marginBottom: 10 }}>
                  No tonight bookings match "{q}" — check OTHER DATES below or use Find Booking.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                  {tonightHits.slice(0, 12).map((h) => (
                    <button key={h.key} onClick={h.onClick}
                      style={{ textAlign: "left", padding: "10px 12px", borderRadius: 8,
                        background: "#fff", border: "2px solid #000",
                        color: "#000", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 800, color: "#000", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {h.name} <span style={{ color: "#6B6B6B", fontWeight: 500, fontSize: 11 }}>· {h.phone || "no phone"}</span>
                        </div>
                        <div style={{ fontSize: 11, color: "#6B6B6B", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {h.subtitle || h.ref}
                        </div>
                      </div>
                      <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 6,
                        background: "#fff", color: h.tone, border: "2px solid #000" }}>
                        {h.label}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {(otherDateHits.length > 0 || crossLoading) && (
                <details>
                  <summary style={{ cursor: "pointer", fontSize: 10, fontWeight: 700, color: "#6B6B6B", letterSpacing: 1, marginBottom: 6, listStyle: "none" }}>
                    📅 OTHER DATES ({otherDateHits.length}){crossLoading ? " · searching…" : ""}
                  </summary>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
                    {otherDateHits.map((r) => {
                      const isAgg = r._src === "aggregator";
                      return (
                        <button key={`${r._src}-${r.id}`} onClick={() => setLookupResult(r)}
                          style={{ textAlign: "left", padding: "10px 12px", borderRadius: 8,
                            background: "#fff",
                            border: "2px solid #000",
                            color: "#000", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 800, color: "#000", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {r.name || "(no name)"} <span style={{ color: "#6B6B6B", fontWeight: 500, fontSize: 11 }}>· {r.phone || "no phone"}</span>
                            </div>
                            <div style={{ fontSize: 11, color: "#6B6B6B", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {r.date || ""} · {r.eventTitle || r.ref}
                            </div>
                          </div>
                          <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 6,
                            background: "#fff",
                            color: isAgg ? "#FF90E8" : "#3D3D3D",
                            border: "2px solid #000" }}>
                            {isAgg ? (r._aggregator || "AGG").toUpperCase() : "BOOKING"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </details>
              )}
            </div>
          );
        })()}

        {/* Event selector chips
            🆕 v3.25 — label 10→12, chips 11→13, padding 7→9. Horizontal scroll
            so any number of events stays one row on narrow Android. */}
        {eventChips.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 900, color: "#000", letterSpacing: "1.2px", textTransform: "uppercase", marginBottom: 8, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>EVENT</div>
            <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, scrollbarWidth: "none" }}>
              <button onClick={() => {
                  if (selectedEventId !== "all") { setSelectedEventId("all"); setAllPickerOpen(false); }
                  else { setAllPickerOpen(p => !p); }
                }}
                style={{ flexShrink: 0, padding: "9px 14px", borderRadius: 6, fontSize: 13, fontWeight: 900, cursor: "pointer", whiteSpace: "nowrap",
                  textTransform: "uppercase", letterSpacing: "0.5px", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
                  background: selectedEventId === "all" ? "#FF90E8" : "#fff",
                  border: selectedEventId === "all" && allPickerOpen ? "2px solid #FF90E8" : "2px solid #000",
                  color: selectedEventId === "all" ? "#000" : "#6B6B6B",
                  display: "flex", alignItems: "center", gap: 5 }}>
                ALL <span style={{ fontSize: 10, opacity: 0.7 }}>{allPickerOpen ? "▴" : "▾"}</span>
              </button>
              {eventChips.map((ev) => {
                const on = selectedEventId === ev.id;
                const isTonight = ev.date === today;
                const d = ev.date ? new Date(ev.date + "T00:00:00") : null;
                const dateLabel = isTonight ? "Tonight" : (d ? d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) : "");
                const title = (ev.title || "Event").length > 18 ? (ev.title || "").slice(0, 18) + "…" : (ev.title || "Event");
                return (
                  <button key={ev.id} onClick={() => { setSelectedEventId(ev.id); setAllPickerOpen(false); }}
                    style={{ flexShrink: 0, padding: "9px 14px", borderRadius: 6, fontSize: 13, fontWeight: 900, cursor: "pointer", whiteSpace: "nowrap",
                      textTransform: "uppercase", letterSpacing: "0.5px", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
                      background: on ? "#FF90E8" : "#fff",
                      border: "2px solid #000",
                      color: on ? "#000" : "#6B6B6B" }}>
                    {title}<span style={{ opacity: .55, marginLeft: 6, fontWeight: 600 }}>· {dateLabel}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {selectedEventId === "all" && allPickerOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
            {eventChips.length === 0 && (
              <div style={{ padding: 14, borderRadius: 8, background: "#fff", border: "2px dashed #000", fontSize: 13, color: "#6B6B6B", textAlign: "center" }}>
                No events tonight.
              </div>
            )}
            {eventChips.map((ev) => {
              const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
              const isTonight = ev.date === todayStr;
              const d = ev.date ? new Date(ev.date + "T00:00:00") : null;
              const dateLabel = isTonight ? "TONIGHT" : (d ? d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }).toUpperCase() : "");
              return (
                <button key={ev.id}
                  onClick={() => { setSelectedEventId(ev.id); setAllPickerOpen(false); }}
                  style={{ textAlign: "left", padding: "14px 16px", borderRadius: 8, background: "#fff",
                    border: "2px solid #000", color: "#000", cursor: "pointer",
                    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: 0.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {ev.title || "Event"}
                  </span>
                  <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 900, padding: "4px 10px", borderRadius: 6,
                    background: isTonight ? "#FF90E8" : "#F4F4F0",
                    border: "2px solid #000", letterSpacing: 0.8, textTransform: "uppercase", color: "#000" }}>
                    {dateLabel}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {selectedEventId !== "all" && (<>
        {/* 🆕 2026-05-26 v3.25 (Khushi) — bigger dashboard fonts (v3.22 pattern).
            CONSTRAINT: 7 chips on a 331px Android phone = ~43px each, so the
            text labels stay at 10px (any bigger and GUEST LIST / ENTRY PASS
            wrap or clip). Only the count + padding grow — count goes 18→22,
            padding 8→11 → bigger tap target + the number jumps out from
            across the door. */}
        <div style={{ display: "flex", gap: 6, marginBottom: 14, paddingBottom: 4, width: "100%" }}>
          {tabs.map((t) => {
            const on = tab === t.key;
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                style={{ flex: 1, minWidth: 0, padding: "11px 2px", borderRadius: 8, cursor: "pointer", border: "2px solid #000", overflow: "hidden",
                  background: on ? "#FF90E8" : "#fff",
                  color: "#000",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 3, lineHeight: 1.1 }}>
                {/* 🆕 v3.25 — architect-flagged overflow guard. Real chip width
                    on a 331px Android iframe is ~37px (parent padding 12/16 +
                    gap 6 × 7 chips), not 43px. Label letter-spacing tightened
                    0.6→0.2, button padding 4→2 horizontal, overflow:hidden +
                    textOverflow:ellipsis on the label so GUEST LIST/ENTRY PASS
                    truncate gracefully instead of bleeding into the next chip. */}
                <span style={{ fontSize: 10, fontWeight: 900, letterSpacing: "0.2px", textTransform: "uppercase", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
                  maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.label}</span>
                <span style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", fontVariantNumeric: "tabular-nums", fontSize: 22, fontWeight: 900,
                  color: "#000" }}>{t.count}</span>
              </button>
            );
          })}
        </div>

        {tab === "all" && <AllBookingsTab
          allBookings={allBookings}
          allGuests={allGuests}
          tableResByDate={tableResByDate}
          query={searchInput}
          eventId={selectedEventId}
          eventChips={eventChips}
          onBookingClick={(b) => setScanDetail(b)}
          onTableClick={(r, isCorp) => { setTab(isCorp ? "corporate" : "tables"); setTablesFocusDocId(r._docId!); }}
        />}
        {tab === "tickets"   && <TicketsTab        agentName={agentName} query={searchInput} eventId={selectedEventId} eventDate={selectedEventDate} onCover={setCoverFor} onShowQr={setQrModal} />}
        {tab === "guestlist" && <GuestlistTab      agentName={agentName} query={searchInput} eventId={selectedEventId} eventDate={selectedEventDate} onCover={setCoverFor} onShowQr={setQrModal} />}
        {tab === "tables"    && <TablesTab         agentName={agentName} query={searchInput} eventId={selectedEventId} eventDate={selectedEventDate} onShowQr={setQrModal} onCover={setCoverFor} focusDocId={tablesFocusDocId} onFocusConsumed={() => setTablesFocusDocId(null)} sourceFilter="non-corporate" />}
        {tab === "corporate" && <TablesTab         agentName={agentName} query={searchInput} eventId={selectedEventId} eventDate={selectedEventDate} onShowQr={setQrModal} onCover={setCoverFor} focusDocId={tablesFocusDocId} onFocusConsumed={() => setTablesFocusDocId(null)} sourceFilter="corporate" />}
        {tab === "onlyentry" && <OnlyEntryTab      agentName={agentName} query={searchInput} eventId={selectedEventId} eventDate={selectedEventDate} onCover={setCoverFor} onShowQr={setQrModal} />}
        {tab === "waitlist"  && <WaitlistView      date={CALENDAR_TODAY_STR()} />}
        </>)}
      </div>

      {/* 🔴 2026-05-20 (Khushi LIVE-NIGHT) — auto-match popup mounted at
          dashboard level so it fires regardless of which tab is active. */}
      <WaitlistAutoMatch date={CALENDAR_TODAY_STR()} />

      {scanning && <QrScanner onResult={handleQrResult} onClose={() => setScanning(false)} brutalist />}
      {scanDetail && (
        <BookingDetailModal
          booking={scanDetail}
          agentName={agentName}
          onClose={() => setScanDetail(null)}
          onCover={(b) => setCoverFor(b)}
          onShowQr={setQrModal}
          onSendWhatsApp={(b) => sendBookingWhatsApp(b, setQrModal)}
        />
      )}
      {walkInOpen && <NewWalkInModal agentName={agentName} onClose={() => setWalkInOpen(false)} onActivateCover={(b) => setCoverFor(b)} />}
      {tableBookingOpen && <NewTableBookingModal
        agentName={agentName}
        onClose={() => setTableBookingOpen(false)}
        onActivateCoverTable={(ctx) => setCoverTableCtx(ctx)}
      />}
      {coverTableCtx && <UnifiedWalkInModal
        agentName={agentName}
        onClose={() => setCoverTableCtx(null)}
        onAggregator={() => { /* not used in cover+table flow */ }}
        onActivateCover={() => { /* not used — wallet activation is inline */ }}
        prefill={{ name: coverTableCtx.prefill.name, phone: coverTableCtx.prefill.phone, email: coverTableCtx.prefill.email, girls: coverTableCtx.prefill.girls, boys: coverTableCtx.prefill.boys }}
        linkToTable={{
          tableResRef: coverTableCtx.tableResRef,
          arrivalTime: coverTableCtx.arrivalTime,
          tableId: coverTableCtx.tableInfo.tableId,
          floorLabel: coverTableCtx.tableInfo.floorLabel,
          amenitiesTotal: coverTableCtx.tableInfo.amenitiesTotal,
          amenitiesLabel: coverTableCtx.tableInfo.amenitiesLabel,
        }}
      />}
      {coverFor && <CoverActivationModal booking={coverFor} agentName={agentName} onClose={() => setCoverFor(null)} />}
      {liveReportsOpen && <LiveReportsModal
        agentName={agentName}
        tableResByDate={tableResByDate}
        selectedEventId={selectedEventId}
        eventChips={eventChips}
        onClose={() => setLiveReportsOpen(false)}
      />}
      {qrModal && (
        <WalletQrModal
          bookingRef={qrModal.bookingRef} walletUrl={qrModal.walletUrl}
          customerName={qrModal.customerName} reason={qrModal.reason}
          onClose={() => setQrModal(null)}
        />
      )}
    </div>
  );
}

// 🔴 ═════════════════════════════════════════════════════════════════════════
// 🔴 2026-05-20 (Khushi) — ALL TAB + LIVE REPORTS DASHBOARD
// 🔴 ═════════════════════════════════════════════════════════════════════════
// ALL tab = one unified scrolling list across tickets / guestlist / tables /
// corporate / entry-pass — same data sources as the per-category tabs so
// numbers always reconcile. Search + event filter respected. Tap a row to
// jump to its native tab (or open the booking detail modal).
//
// LIVE REPORTS = full-screen modal with KPI tiles + CSV export. Uses the
// same parent-level subscriptions (allBookings, allGuests, tableResByDate,
// allCovers) so data is live and matches the dashboard counters.
//
// 🛟 FALLBACK: both views are pure read-only React — if they crash the door
// girl can hard-refresh and keep working. No Firestore writes happen here.
// 🔴 ═════════════════════════════════════════════════════════════════════════

type AllBookingsTabProps = {
  allBookings: HodBooking[];
  allGuests: HodGuestlistEntry[];
  tableResByDate: Record<string, HodTableReservation[]>;
  query: string;
  eventId: string;
  eventChips: HodEvent[];
  onBookingClick: (b: HodBooking) => void;
  onTableClick: (r: HodTableReservation, isCorporate: boolean) => void;
};

function AllBookingsTab({ allBookings, allGuests, tableResByDate, query, eventId, eventChips, onBookingClick, onTableClick }: AllBookingsTabProps) {
  const [pickedId, setPickedId] = useState<string>("");
  // Reset local pick when parent switches to a specific event
  useEffect(() => { if (eventId !== "all") setPickedId(""); }, [eventId]);
  const effectiveEventId = eventId === "all" ? pickedId : eventId;

  const todayDates = TODAY_DATE_SET();
  const ql = (query || "").trim().toLowerCase();
  const qd = (query || "").replace(/\D/g, "");
  const matchText = (s?: string) => !ql || (!!s && String(s).toLowerCase().includes(ql));
  const matchPhone = (p?: string) => {
    if (!qd || qd.length < 4) return false;
    const pd = String(p || "").replace(/\D/g, "");
    return !!pd && pd.includes(qd);
  };
  const matches = (name?: string, phone?: string, ref?: string) =>
    !ql ? true : (matchText(name) || matchPhone(phone) || matchText(ref));
  const inEvent = (b: HodBooking) => !effectiveEventId || effectiveEventId === "all" || !b.eventId || b.eventId === effectiveEventId;

  type Row =
    | { kind: "ticket" | "entry" | "group"; key: string; booking: HodBooking; label: string; tone: string; sortAt: string }
    | { kind: "guestlist"; key: string; booking: HodBooking; label: string; tone: string; sortAt: string }
    | { kind: "table" | "corporate"; key: string; res: HodTableReservation; label: string; tone: string; sortAt: string };

  const rows: Row[] = [];

  // 🆕 2026-05-27 v3.50 (Khushi LIVE-NIGHT) — collect refs that already exist
  // in tonight's tableReservations so we can suppress the duplicate TICKET row
  // for HODTAB bookings. Same belt-and-braces logic as the TONIGHT MATCHES
  // search dedup: TABLE badge wins, TICKET row hidden. Covers legacy /
  // cash-pending HODTABs whose `bookings` doc lacks `tableType` and therefore
  // slip past the isTableBooking(b) check below.
  const tonightTableRefs = new Set<string>();
  for (const list of Object.values(tableResByDate)) {
    for (const r of list) {
      if ((r as any).status === "cancelled") continue;
      const tref = String((r as any).bookingRef || "").toLowerCase();
      if (tref) tonightTableRefs.add(tref);
    }
  }

  // TICKETS / ENTRY PASS / GROUP (non-guestlist bookings)
  for (const b of allBookings) {
    const d = (b.date || "").slice(0, 10);
    if (!todayDates.has(d)) continue;
    if (isGuestlistBooking(b)) continue;
    if (!inEvent(b)) continue;
    if (!matches(b.name, b.phone, b.ref)) continue;
    // v3.50: skip TABLE bookings here — they render below under TABLES with
    // floor/table info. Belt-and-braces: isTableBooking check (catches
    // bookings with tableType set) + ref-set check (catches legacy bookings
    // where tableType wasn't written).
    if (isTableBooking(b)) continue;
    if (b.ref && tonightTableRefs.has(b.ref.toLowerCase())) continue;
    const isEntry = isOnlyEntryBooking(b);
    rows.push({
      kind: isEntry ? "entry" : "ticket",
      key: `b-${b.id}`,
      booking: b,
      label: isEntry ? "ENTRY PASS" : "TICKET",
      tone: isEntry ? "#FF5733" : "#FF90E8",
      sortAt: (b as any).bookedAt || b.date || "",
    });
  }

  // GUESTLIST (collection) — architect-flagged: must apply event filter for
  // parity with GuestlistTab, and accept bookedAt fallback below for parity
  // with the typed-booking merge.
  const todayGuests = allGuests.filter((g) => {
    const d = ((g as any).date || "").slice(0, 10);
    if (d) { if (!todayDates.has(d)) return false; }
    else {
      const ja = ((g as any).joinedAt || "").slice(0, 10);
      const et = ((g as any).entryTime || "").slice(0, 10);
      if (!todayDates.has(ja) && !todayDates.has(et)) return false;
    }
    if (eventId !== "all" && (g as any).eventId && (g as any).eventId !== eventId) return false;
    return true;
  });
  const glIds = new Set(todayGuests.map((g) => g.id));
  for (const g of todayGuests) {
    if (!matches(g.name, g.phone, (g as any).ref)) continue;
    const adapted: HodBooking = {
      id: g.id, ref: (g as any).ref || g.id, name: g.name, phone: g.phone,
      eventId: g.eventId, eventTitle: g.eventTitle, type: g.type,
      total: 0, checkedIn: !!g.checkedIn,
      _isGuestList: true, _glDocId: (g as any)._bookingDocId || g.id,
      date: ((g as any).joinedAt || (g as any).entryTime || "").slice(0, 10),
    } as any;
    rows.push({
      kind: "guestlist",
      key: `g-${g.id}`,
      booking: adapted,
      label: "GUEST LIST",
      tone: "#23A094",
      sortAt: (g as any).joinedAt || (g as any).entryTime || "",
    });
  }
  // GUESTLIST (typed bookings — parity with GuestlistTab)
  // Architect-flagged: GuestlistTab accepts EITHER b.date OR b.bookedAt; we
  // were only accepting b.date and dropping legacy rows. Also apply event filter.
  for (const b of allBookings) {
    if (!isGuestlistBooking(b)) continue;
    const d = (b.date || "").slice(0, 10);
    const ba = ((b as any).bookedAt || "").slice(0, 10);
    if (!todayDates.has(d) && !todayDates.has(ba)) continue;
    if (glIds.has(b.id)) continue;
    if (!inEvent(b)) continue;
    if (!matches(b.name, b.phone, b.ref)) continue;
    rows.push({
      kind: "guestlist",
      key: `gb-${b.id}`,
      booking: b,
      label: "GUEST LIST",
      tone: "#23A094",
      sortAt: (b as any).bookedAt || b.date || "",
    });
  }

  // TABLES + CORPORATE (dedupe by _docId across the dual-date subscription)
  const tableSeen = new Set<string>();
  for (const list of Object.values(tableResByDate)) {
    for (const r of list) {
      if (!r._docId || tableSeen.has(r._docId)) continue;
      tableSeen.add(r._docId);
      if ((r as any).status === "cancelled") continue;
      if (!matches((r as any).customerName, (r as any).phone, (r as any).bookingRef)) continue;
      const isCorp = isCorporateTableRes(r);
      rows.push({
        kind: isCorp ? "corporate" : "table",
        key: `t-${r._docId}`,
        res: r,
        label: isCorp ? "CORPORATE" : "TABLE",
        tone: isCorp ? "#3D3D3D" : "#000",
        sortAt: (r as any).arrivalTime || (r as any).bookedAt || "",
      });
    }
  }

  // 🔴 2026-05-21 (Khushi) — checked-in rows drop to the BOTTOM so new
  // arrivals always appear at the top. Tables/corporate don't have a
  // checkedIn field on the row → treat as not-checked-in. Within each
  // group, keep newest-first by sortAt (empty sorts last within group).
  const isDone = (r: Row) => (r.kind === "ticket" || r.kind === "entry" || r.kind === "group" || r.kind === "guestlist")
    ? !!(r.booking as any).checkedIn
    : false;
  rows.sort((a, b) => {
    const ad = isDone(a), bd = isDone(b);
    if (ad !== bd) return ad ? 1 : -1;
    if (!a.sortAt) return 1;
    if (!b.sortAt) return -1;
    return b.sortAt.localeCompare(a.sortAt);
  });


  // 🆕 ALL-tab dropdown gate: when "ALL" event is selected and no specific
  // event has been picked yet, show a picker instead of dumping everything.
  if (eventId === "all" && !pickedId) {
    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
        <div style={{ padding: "14px 16px", borderRadius: 8, background: "#F4F4F0",
          border: "2px solid #000", fontSize: 13, color: "#000", fontWeight: 700, lineHeight: 1.5 }}>
          📋 Select an event to view its bookings:
        </div>
        {eventChips.length === 0 && (
          <div style={{ padding: 14, borderRadius: 8, background: "#fff", border: "2px dashed #000",
            fontSize: 13, color: "#6B6B6B", textAlign: "center" }}>
            No events tonight.
          </div>
        )}
        {eventChips.map((ev) => {
          const isTonight = ev.date === todayStr;
          const d = ev.date ? new Date(ev.date + "T00:00:00") : null;
          const dateLabel = isTonight ? "TONIGHT" : (d ? d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }).toUpperCase() : "");
          return (
            <button key={ev.id} onClick={() => setPickedId(ev.id)}
              style={{ textAlign: "left", padding: "14px 16px", borderRadius: 8, background: "#fff",
                border: "2px solid #000", color: "#000", cursor: "pointer",
                display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: 0.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {ev.title || "Event"}
              </span>
              <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 900, padding: "4px 10px", borderRadius: 6,
                background: isTonight ? "#FF90E8" : "#F4F4F0",
                border: "2px solid #000", letterSpacing: 0.8, textTransform: "uppercase", color: "#000" }}>
                {dateLabel}
              </span>
            </button>
          );
        })}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div style={{ background: "#fff", border: "2px dashed #000", borderRadius: 8, padding: 24, textAlign: "center", color: "#6B6B6B", fontSize: 13 }}>
        No bookings tonight{ql ? ` match "${query}"` : ""} yet.
      </div>
    );
  }

  // Khushi 2026-05-20: removed the category chip strip inside ALL — the tab
  // counters in the dashboard header already show the same split, having them
  // twice was redundant.
  // 🆕 2026-05-26 v3.25 (Khushi) — bigger row fonts (v3.22 pattern). Name
  // 13→15, phone 11→12, subtitle 11→12, kind badge 10→11, padding 10→12.
  // Space Grotesk + tabular-nums everywhere so the door tablet OR a phone
  // both read big and crisp from across the lobby.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
      {eventId === "all" && pickedId && (
        <button onClick={() => setPickedId("")}
          style={{ textAlign: "left", padding: "10px 14px", borderRadius: 8, background: "#FF90E8",
            border: "2px solid #000", color: "#000", fontSize: 12, fontWeight: 900, cursor: "pointer",
            display: "flex", alignItems: "center", gap: 8, letterSpacing: 0.5 }}>
          ← ALL EVENTS
          <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, opacity: 0.7 }}>
            {eventChips.find(e => e.id === pickedId)?.title || pickedId}
          </span>
        </button>
      )}
      {rows.map((row) => {
        if (row.kind === "table" || row.kind === "corporate") {
          const r = row.res;
          const isCorp = row.kind === "corporate";
          const pax = (r as any).partySize || 0;
          const arr = (r as any).arrivalTime || "";
          const subtitle = `${(r as any).tableId || "?"} · ${(r as any).floorLabel || (r as any).floor || ""} · ${arr || "no time"}${pax ? ` · ${pax}p` : ""}`;
          return (
            <button key={row.key} onClick={() => onTableClick(r, isCorp)}
              style={{ textAlign: "left", padding: "12px 12px", borderRadius: 8,
                background: "#fff", border: "2px solid #000",
                color: "#000", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#000", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: .2 }}>
                  {(r as any).customerName || "(no name)"} <span style={{ color: "#6B6B6B", fontWeight: 600, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>· {(r as any).phone || "no phone"}</span>
                </div>
                <div style={{ fontSize: 12, color: "#6B6B6B", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                  {subtitle}
                </div>
              </div>
              <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 900, padding: "4px 9px", borderRadius: 6, letterSpacing: .4, textTransform: "uppercase",
                background: "#fff", color: row.tone, border: "2px solid #000" }}>
                {row.label}
              </span>
            </button>
          );
        }
        if (row.kind !== "ticket" && row.kind !== "entry" && row.kind !== "group" && row.kind !== "guestlist") return null;
        const b = row.booking;
        const subtitle = `${b.eventTitle || ""}${b.ref ? " · " + b.ref : ""}`.replace(/^ · /, "").trim() || (b.ref || "");
        return (
          <button key={row.key} onClick={() => onBookingClick(b)}
            style={{ textAlign: "left", padding: "12px 12px", borderRadius: 8,
              background: "#fff", border: "2px solid #000",
              color: "#000", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#000", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: .2 }}>
                {b.name || "(no name)"} <span style={{ color: "#6B6B6B", fontWeight: 600, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>· {b.phone || "no phone"}</span>
                {b.checkedIn && <span style={{ marginLeft: 6, fontSize: 11, color: "#23A094", fontWeight: 900, letterSpacing: .4 }}>✓ IN</span>}
              </div>
              <div style={{ fontSize: 12, color: "#6B6B6B", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {subtitle}
              </div>
            </div>
            <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 900, padding: "4px 9px", borderRadius: 6, letterSpacing: .4, textTransform: "uppercase",
              background: "#fff", color: row.tone, border: "2px solid #000" }}>
              {row.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// LIVE REPORTS MODAL
// ─────────────────────────────────────────────────────────────────────────
// KPI tiles for Khushi's nightly summary. Operational window per Khushi
// 2026-05-20: 12 NOON IST → 03:00 IST next day. Default = TONIGHT. Date
// picker lets her scroll back to past operational nights.
//
// Aggregator buckets (Khushi 2026-05-20): show EVERY discount % that
// occurred, not just 50/30. e.g. "30% × 2 tables", "50% × 15", "60% × 2".
// Lunch / Dinner split: arrival < 17:00 IST = lunch, ≥ 17:00 = dinner.
// Checked-out KPI: skipped (no schema field yet).

type LiveReportsModalProps = {
  agentName: string;
  tableResByDate: Record<string, HodTableReservation[]>;
  selectedEventId: string;
  eventChips: Array<{ id: string; title: string; date: string }>;
  onClose: () => void;
};

function LiveReportsModal({ agentName, tableResByDate, selectedEventId, eventChips, onClose }: LiveReportsModalProps) {
  // Operational night = the YYYY-MM-DD that represents the night. Today's
  // op night by default; date picker can rewind.
  const [nightDate, setNightDate] = useState<string>(getOperationalNightStr());
  // 🔴 2026-05-22 (Khushi COST FIX) — Subscribe to covers for the SELECTED
  // night. Was a parent-level full-collection subscription that broke when
  // the date picker rewound (parent only had tonight's covers). Now follows
  // nightDate dynamically — saves dashboard cost AND fixes historical view.
  const [allCovers, setAllCovers] = useState<HodCover[]>([]);
  useEffect(() => {
    const u = subscribeToCoversForNight(nightDate, setAllCovers);
    return () => u();
  }, [nightDate]);
  // 🔴 2026-05-23 (Khushi COST FIX r2) — Same treatment for bookings + guestlist.
  // Parent now only subscribes to TONIGHT (for tab counters); modal needs to
  // follow the date picker independently. Both refresh when nightDate changes.
  const [allBookings, setAllBookings] = useState<HodBooking[]>([]);
  useEffect(() => {
    const u = subscribeToBookingsForNights([nightDate], setAllBookings);
    return () => u();
  }, [nightDate]);
  const [allGuests, setAllGuests] = useState<HodGuestlistEntry[]>([]);
  useEffect(() => {
    // Operational night straddles calendar midnight — fetch a 2-day window
    // to safely catch entries joined either side of it; JS filter narrows.
    const u = subscribeToGuestlistInRange(addDaysStr(nightDate, 0), addDaysStr(nightDate, 2), setAllGuests);
    return () => u();
  }, [nightDate]);
  // Subscribe to the picked night's table reservations if it's not already
  // in the parent's tableResByDate map.
  const [pickedTables, setPickedTables] = useState<HodTableReservation[] | null>(null);
  useEffect(() => {
    if (tableResByDate[nightDate]) { setPickedTables(null); return; }
    const u = subscribeToHodReservations(nightDate, (rows) => setPickedTables(rows));
    return () => u();
  }, [nightDate, tableResByDate]);

  // Operational window in ms: noon IST on nightDate → 03:00 IST next day.
  // IST = UTC+5:30, so 12:00 IST = 06:30 UTC same day; 03:00 IST next day
  // = 21:30 UTC same day (NOT the next UTC date).
  const [y, m, d] = nightDate.split("-").map(Number);
  const winStartMs = Date.UTC(y, m - 1, d, 6, 30, 0);          // noon IST
  const winEndMs   = Date.UTC(y, m - 1, d, 21, 30, 0);         // 03:00 IST next day = 21:30 UTC same day
  const inWindowIso = (iso?: string) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    if (isNaN(t)) return false;
    return t >= winStartMs && t < winEndMs;
  };

  const dateLabel = new Date(y, m - 1, d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const eventLabel = (() => {
    if (selectedEventId === "all") return "All Events";
    const ev = eventChips.find((e) => e.id === selectedEventId);
    return ev ? (ev.title || "Event") : "Event";
  })();

  const [searchQ, setSearchQ] = useState("");
  const ql = searchQ.trim().toLowerCase();
  const passSearch = (...fields: (string | undefined)[]) => {
    if (!ql) return true;
    return fields.some((f) => !!f && String(f).toLowerCase().includes(ql));
  };

  // Tables for picked night — Khushi 2026-05-20: previous logic double-counted
  // (showed 93 when door tab showed 47, admin showed 50) because BOTH
  // `tableResByDate[nightDate]` AND `pickedTables` were briefly non-null during
  // the parent-subscription race window. New approach mirrors the dashboard
  // counter at line 4709 EXACTLY:
  //   1. Walk every parent-subscribed date key (dedupe by _docId across all)
  //   2. Also walk `pickedTables` (only ever set for past-night picker)
  //   3. STRICT filter `r.date === nightDate` so only rows that actually belong
  //      to the picked operational night are counted — kills any stale rows
  //      that linger from a previous night's subscription.
  //   4. Drop status:"cancelled" and apply search filter.
  // Result: matches door TABLES tab + admin Reports for the same night.
  const tablesForNight: HodTableReservation[] = (() => {
    const seen = new Set<string>();
    const out: HodTableReservation[] = [];
    const consider = (list: HodTableReservation[] | undefined) => {
      if (!list) return;
      for (const r of list) {
        const id = r._docId || (r as any).bookingRef || "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if ((r as any).status === "cancelled") continue;
        if ((r.date || "").slice(0, 10) !== nightDate) continue;
        if (!passSearch((r as any).customerName, (r as any).phone, (r as any).bookingRef, (r as any).companyName)) continue;
        out.push(r);
      }
    };
    Object.values(tableResByDate).forEach(consider);
    consider(pickedTables ?? undefined);
    return out;
  })();

  // Bookings filtered to picked night
  const bookingsForNight = allBookings.filter((b) => {
    const d = (b.date || "").slice(0, 10);
    if (d !== nightDate) return false;
    if (selectedEventId !== "all" && b.eventId && b.eventId !== selectedEventId) return false;
    return passSearch(b.name, b.phone, b.ref, b.eventTitle);
  });

  // Guestlist filtered to picked night
  const guestsForNight = allGuests.filter((g) => {
    const d = ((g as any).date || "").slice(0, 10);
    if (d) { if (d !== nightDate) return false; }
    else {
      const ja = ((g as any).joinedAt || "").slice(0, 10);
      const et = ((g as any).entryTime || "").slice(0, 10);
      if (ja !== nightDate && et !== nightDate) return false;
    }
    if (selectedEventId !== "all" && g.eventId && g.eventId !== selectedEventId) return false;
    return passSearch(g.name, g.phone, (g as any).ref);
  });

  // Split categories
  const ticketBookings = bookingsForNight.filter((b) => !isGuestlistBooking(b) && !isOnlyEntryBooking(b) && !isTableBooking(b));
  const entryBookings  = bookingsForNight.filter((b) => !isGuestlistBooking(b) && isOnlyEntryBooking(b));
  const guestlistFromBookingsRaw = bookingsForNight.filter((b) => isGuestlistBooking(b));
  // Architect-flagged: same guest may exist in BOTH the guestlist collection
  // and a guestlist-typed booking. Dedupe by stable key (ref → id → phone+name)
  // so Total Pax and Guestlist tiles don't double-count.
  const guestlistKey = (x: { ref?: string; id?: string; phone?: string; name?: string }) =>
    (x.ref || "").toLowerCase()
      || (x.id || "").toLowerCase()
      || `${(x.phone || "").replace(/\D/g, "")}|${(x.name || "").toLowerCase().trim()}`;
  const guestlistSeen = new Set(guestsForNight.map(guestlistKey));
  const guestlistFromBookings = guestlistFromBookingsRaw.filter((b) => {
    const k = guestlistKey({ ref: b.ref, id: b.id, phone: b.phone, name: b.name });
    if (!k || guestlistSeen.has(k)) return false;
    guestlistSeen.add(k);
    return true;
  });
  const corporateTables = tablesForNight.filter(isCorporateTableRes);
  const regularTables   = tablesForNight.filter((r) => !isCorporateTableRes(r));

  // PAX TOTALS — booking.guests for tickets/entry, partySize for tables,
  // 1 per guestlist entry.
  const ticketPax    = ticketBookings.reduce((s, b) => s + (Number(b.guests) || 1), 0);
  const entryPax     = entryBookings.reduce((s, b) => s + (Number(b.guests) || 1), 0);
  const tablePax     = regularTables.reduce((s, r) => s + (Number((r as any).partySize) || 0), 0);
  const corpPax      = corporateTables.reduce((s, r) => s + (Number((r as any).partySize) || 0), 0);
  const guestlistPax = guestsForNight.length + guestlistFromBookings.length;
  const totalPax     = ticketPax + entryPax + tablePax + corpPax + guestlistPax;

  // COVERS — collected + redeemed across the operational window.
  // A cover belongs to this night if its `date` field matches OR if
  // `activatedAt` falls in the noon-to-3am window (handles legacy docs
  // missing `date`).
  const coversForNight = allCovers.filter((c) => {
    if ((c as any).date === nightDate) return true;
    const at = (c as any).activatedAt || (c as any).createdAt;
    return inWindowIso(at);
  });
  const totalCoversCollected = coversForNight.reduce((s, c) => s + (Number(c.coverActivated) || 0), 0);
  const totalAmountRedeemed  = coversForNight.reduce((s, c) => s + Math.max(0, (Number(c.coverActivated) || 0) - (Number(c.coverBalance) || 0)), 0);

  // LUNCH / DINNER split for ALL tables (regular + corporate). Cutoff = 17:00.
  const allTablesForNight = [...regularTables, ...corporateTables];
  const isLunch = (arr?: string) => {
    if (!arr) return false;
    const m = arr.match(/^(\d{1,2}):/);
    if (!m) return false;
    return Number(m[1]) < 17;
  };
  const lunchTables  = allTablesForNight.filter((r) => isLunch((r as any).arrivalTime)).length;
  const dinnerTables = allTablesForNight.filter((r) => !isLunch((r as any).arrivalTime)).length;

  // AGGREGATOR breakdown — for each source bucket, list every discount %
  // that appears and the count of tables + sum of pax at that discount.
  const aggSources: Array<"zomato" | "swiggy" | "eazydiner" | "whatsapp_bot" | "inhouse"> = ["zomato", "swiggy", "eazydiner", "whatsapp_bot", "inhouse"];
  const aggLabels: Record<string, string> = { zomato: "ZOMATO", swiggy: "SWIGGY", eazydiner: "EAZYDINER", whatsapp_bot: "DINEOUT", inhouse: "IN-HOUSE" };
  const canonical = (raw: string): "zomato" | "swiggy" | "eazydiner" | "whatsapp_bot" | "inhouse" => {
    const v = (raw || "inhouse").toLowerCase();
    if (v.includes("zomato")) return "zomato";
    if (v.includes("swiggy")) return "swiggy";
    if (v.includes("eazy") || v.includes("easy")) return "eazydiner";
    if (v.includes("dineout") || v.includes("whatsapp")) return "whatsapp_bot";
    return "inhouse";
  };
  const aggBuckets: Record<string, { total: number; pax: number; byDiscount: Map<number, { tables: number; pax: number }> }> = {};
  for (const k of aggSources) aggBuckets[k] = { total: 0, pax: 0, byDiscount: new Map() };
  for (const r of allTablesForNight) {
    const rawSrc = (r as any).aggregator || (r as any).source || "inhouse";
    const src = canonical(rawSrc);
    const pax = Number((r as any).partySize) || 0;
    // 🐛 Khushi-flagged: was reading `discountPercent` which never exists on
    // table reservations → every card showed 0%. Real field is
    // `aggregatorDiscount`, with `getAggregatorDiscount(name)` as the
    // canonical default fallback (mirrors line 2334 logic). Also accept the
    // few legacy fallback names just in case.
    const discRaw = (r as any).aggregatorDiscount
      ?? (r as any).discountPercent
      ?? (r as any).discount
      ?? (src === "inhouse" ? 0 : getAggregatorDiscount(String(rawSrc).toLowerCase()));
    const disc = Math.round(Number(discRaw) || 0);
    aggBuckets[src].total += 1;
    aggBuckets[src].pax += pax;
    const cur = aggBuckets[src].byDiscount.get(disc) || { tables: 0, pax: 0 };
    cur.tables += 1; cur.pax += pax;
    aggBuckets[src].byDiscount.set(disc, cur);
  }

  // ENTRY KPIs
  // 🐛 Khushi-flagged 23 May 2026: was summing b.total for EVERY ticket/entry
  // booking, including "pay at venue" cash bookings where money hasn't been
  // collected yet → false ₹4,496 with no one having paid. Fix: count a
  // booking only if money has ACTUALLY moved —
  //   (a) Online Razorpay paid → paymentId exists and does NOT start "cash_"
  //   (b) Cash at door → checkedIn = true (door agent collected)
  const isActuallyPaid = (b: any) => {
    const pid = String(b?.paymentId || "");
    const paidOnline = pid && !pid.startsWith("cash_");
    const cashCollected = pid.startsWith("cash_") && !!b?.checkedIn;
    return paidOnline || cashCollected;
  };
  const paidTicketBookings = ticketBookings.filter(isActuallyPaid);
  const paidEntryBookings  = entryBookings.filter(isActuallyPaid);
  const totalPaidEntry = paidTicketBookings.reduce((s, b) => s + (Number(b.total) || 0), 0)
                      + paidEntryBookings.reduce((s, b) => s + (Number(b.total) || 0), 0);
  const totalEntryOnly = entryBookings.length;
  // CHECK-INS across all sources
  const totalCheckedIn =
      ticketBookings.filter((b) => b.checkedIn).length
    + entryBookings.filter((b) => b.checkedIn).length
    + guestsForNight.filter((g) => g.checkedIn).length
    + guestlistFromBookings.filter((b) => b.checkedIn).length
    + allTablesForNight.filter((r) => !!(r as any).actualArrivalTime).length;

  // CSV EXPORT — flatten every tile + every aggregator discount row.
  const downloadCsv = () => {
    const lines: string[] = [];
    const push = (label: string, value: string | number) => lines.push(`"${label.replace(/"/g, '""')}",${typeof value === "number" ? value : `"${String(value).replace(/"/g, '""')}"`}`);
    lines.push("Metric,Value");
    push("Date", nightDate);
    push("Event", eventLabel);
    push("Generated", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));
    push("Generated By", agentName);
    push("", "");
    push("TOTAL PAX", totalPax);
    push("  Pax (Tickets)", ticketPax);
    push("  Pax (Entry-only)", entryPax);
    push("  Pax (Tables)", tablePax);
    push("  Pax (Corporate)", corpPax);
    push("  Pax (Guestlist)", guestlistPax);
    push("", "");
    push("TOTAL COVER CHARGES COLLECTED (Rs)", totalCoversCollected);
    push("TOTAL AMOUNT REDEEMED (Rs)", totalAmountRedeemed);
    push("", "");
    push("TOTAL TABLES BOOKED", allTablesForNight.length);
    push("  Lunch (< 5pm)", lunchTables);
    push("  Dinner (>= 5pm)", dinnerTables);
    push("", "");
    for (const k of aggSources) {
      const bk = aggBuckets[k];
      push(`${aggLabels[k]} — tables`, bk.total);
      push(`${aggLabels[k]} — pax`, bk.pax);
      const sorted = Array.from(bk.byDiscount.entries()).sort((a, b) => b[0] - a[0]);
      for (const [disc, v] of sorted) {
        push(`  ${aggLabels[k]} ${disc}% — tables`, v.tables);
        push(`  ${aggLabels[k]} ${disc}% — pax`, v.pax);
      }
    }
    push("", "");
    push("CORPORATE BOOKINGS", corporateTables.length);
    push("GUESTLIST / FREE ENTRY", guestlistPax);
    push("TOTAL PAID ENTRY (Rs)", totalPaidEntry);
    push("TOTAL ENTRY-ONLY BOOKINGS", totalEntryOnly);
    push("TOTAL CHECKED IN", totalCheckedIn);

    // UTF-8 BOM for Excel friendliness
    const csv = "\uFEFF" + lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `HOD-LiveReport-${nightDate}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Palette: ONLY yellow (gold), black, white, red. Numbers/headings use
  // Space Grotesk (non-cursive, monospaced-feel digits via tnum). Khushi
  // explicitly rejected Playfair italics for numeric KPIs.
  const NUM_FONT = "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
  const NUM_STYLE: React.CSSProperties = { fontFamily: NUM_FONT, fontVariantNumeric: "tabular-nums", fontFeatureSettings: "'tnum'" };
  const Tile = ({ label, value, tone = "#000", sub, children }: { label: string; value: string | number; tone?: string; sub?: string; children?: any }) => (
    <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 6, minHeight: 92 }}>
      <div style={{ fontSize: 12, fontWeight: 900, color: tone, letterSpacing: 1, textTransform: "uppercase", fontFamily: NUM_FONT }}>{label}</div>
      <div style={{ ...NUM_STYLE, fontSize: 32, fontWeight: 800, color: "#000", lineHeight: 1, letterSpacing: -.5 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#6B6B6B", fontWeight: 700, fontFamily: NUM_FONT }}>{sub}</div>}
      {children}
    </div>
  );
  // Small "chip" used inside the TOTAL PAX tile so the split is readable
  // rather than a single dot-separated string.
  const PaxChip = ({ label, n }: { label: string; n: number }) => (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 4, padding: "3px 7px", borderRadius: 6, background: "#fff", border: "2px solid #000" }}>
      <span style={{ fontSize: 9, fontWeight: 900, color: "#000", letterSpacing: .6 }}>{label}</span>
      <span style={{ ...NUM_STYLE, fontSize: 12, fontWeight: 800, color: "#000" }}>{n}</span>
    </span>
  );

  const fmtRs = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.88)", zIndex: 9999, overflow: "auto", padding: "12px 0", WebkitOverflowScrolling: "touch" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 980, margin: "0 auto", background: "#F4F4F0", border: "2px solid #000", borderRadius: 8, padding: 16, color: "#000" }}>
        <BackBtn onClick={onClose} />
        {/* HEADER */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontFamily: NUM_FONT, fontSize: 28, fontWeight: 900, color: "#000", letterSpacing: 1.5, display: "flex", alignItems: "center", gap: 10, textTransform: "uppercase" }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#FF5733", boxShadow: "none", display: "inline-block" }} />
              LIVE REPORTS
            </div>
            <div style={{ fontSize: 13, color: "#6B6B6B", marginTop: 4, fontFamily: NUM_FONT, fontWeight: 700 }}>
              <b style={{ color: "#000" }}>{eventLabel}</b> · {dateLabel} <span style={{ opacity: .6 }}>· 12:00pm → 3:00am IST</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0, flexWrap: "wrap" }}>
            <input type="date" value={nightDate} onChange={(e) => setNightDate(e.target.value)}
              style={{ background: "#fff", border: "2px solid #000", color: "#000", padding: "6px 8px", borderRadius: 6, fontSize: 12, fontWeight: 700 }}
              title="Pick operational night" />
            <button onClick={downloadCsv}
              style={{ padding: "7px 12px", borderRadius: 6, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 11, fontWeight: 900, cursor: "pointer", letterSpacing: .4 }}
              title="Download CSV of all tiles">
              ⬇ EXPORT CSV
            </button>
            <button onClick={onClose}
              style={{ padding: "7px 12px", borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
              ✕ CLOSE
            </button>
          </div>
        </div>

        {/* SEARCH */}
        <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)}
          placeholder="Search bookings (name, phone, ref) — narrows all tiles below"
          style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 14 }} />

        {/* TOP TILES */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 16 }}>
          <Tile label="TOTAL PAX" value={totalPax} tone="#000">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 4 }}>
              {/* Khushi 2026-05-20: relabelled as "… PAX" so the chips inside
                  the TOTAL PAX tile aren't misread as booking counts. Booking
                  counts live in the dashboard tab headers + the TOTAL TABLES
                  BOOKED tile below. */}
              <PaxChip label="TICKET PAX" n={ticketPax} />
              <PaxChip label="TABLE PAX" n={tablePax} />
              <PaxChip label="CORP PAX" n={corpPax} />
              <PaxChip label="ENTRY PAX" n={entryPax} />
              <PaxChip label="GUEST PAX" n={guestlistPax} />
            </div>
          </Tile>
          {/* 🆕 2026-05-23 (Khushi) — strict count: only covers where money was
              actually collected (`coverActivated > 0`) are "activated".
              Stubs created at booking time (₹0) don't count. */}
          <Tile label="COVER CHARGES COLLECTED" value={fmtRs(totalCoversCollected)} tone="#000"
            sub={(() => {
              const paid = coversForNight.filter((c) => (Number(c.coverActivated) || 0) > 0).length;
              return `${paid} cover${paid === 1 ? "" : "s"} activated`;
            })()} />
          <Tile label="TOTAL AMOUNT REDEEMED" value={fmtRs(totalAmountRedeemed)} tone="#FF5733"
            sub={`Wallet spend across all covers`} />
          <Tile label="TOTAL TABLES BOOKED" value={allTablesForNight.length} tone="#000">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 4 }}>
              <PaxChip label="LUNCH" n={lunchTables} />
              <PaxChip label="DINNER" n={dinnerTables} />
            </div>
          </Tile>
        </div>

        {/* AGGREGATOR BUCKETS */}
        <div style={{ fontSize: 16, fontWeight: 900, color: "#000", letterSpacing: 2, marginBottom: 10, fontFamily: NUM_FONT, textTransform: "uppercase" }}>📍 BOOKINGS BY SOURCE</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 16 }}>
          {aggSources.map((k) => {
            const bk = aggBuckets[k];
            const sortedDiscs = Array.from(bk.byDiscount.entries()).sort((a, b) => b[0] - a[0]);
            // Palette restricted to yellow/red/white. Zomato = red accent
            // (its brand colour), everyone else = gold.
            const tone = k === "zomato" ? "#E23744" : "#000";
            const bgRGBA = "#fff";
            return (
              <div key={k} style={{ background: bgRGBA, border: "2px solid #000", borderRadius: 8, padding: 14 }}>
                {/* HEADER: brand + totals */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 10, paddingBottom: 8, borderBottom: "2px solid #000" }}>
                  <div style={{ fontSize: 16, fontWeight: 900, color: tone, letterSpacing: 1.2, fontFamily: NUM_FONT, textTransform: "uppercase" }}>
                    {aggLabels[k]}
                  </div>
                  <div style={{ display: "flex", gap: 14 }}>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ ...NUM_STYLE, fontSize: 22, fontWeight: 800, color: "#000", lineHeight: 1 }}>{bk.total}</div>
                      <div style={{ fontSize: 9, fontWeight: 900, color: "#6B6B6B", letterSpacing: .8, marginTop: 2, fontFamily: NUM_FONT }}>TABLES</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ ...NUM_STYLE, fontSize: 22, fontWeight: 800, color: "#000", lineHeight: 1 }}>{bk.pax}</div>
                      <div style={{ fontSize: 9, fontWeight: 900, color: "#6B6B6B", letterSpacing: .8, marginTop: 2, fontFamily: NUM_FONT }}>PAX</div>
                    </div>
                  </div>
                </div>
                {/* DISCOUNT BREAKDOWN ROWS */}
                {sortedDiscs.length === 0 ? (
                  <div style={{ fontSize: 12, color: "#6B6B6B", fontWeight: 700, textAlign: "center", padding: "12px 0", fontFamily: NUM_FONT }}>NO BOOKINGS YET</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {sortedDiscs.map(([disc, v]) => (
                      <div key={disc} style={{ display: "grid", gridTemplateColumns: "60px 1fr auto", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 6, background: "#F4F4F0" }}>
                        <span style={{ ...NUM_STYLE, color: tone, fontWeight: 900, fontSize: 15 }}>{disc}%</span>
                        <span style={{ fontSize: 11, color: "#6B6B6B", fontWeight: 700, fontFamily: NUM_FONT, letterSpacing: .5 }}>OFF</span>
                        <span style={{ ...NUM_STYLE, fontSize: 12, color: "#000", fontWeight: 700 }}>
                          <b style={{ ...NUM_STYLE, color: "#000", fontSize: 14, fontWeight: 800 }}>{v.tables}</b>
                          <span style={{ color: "#6B6B6B", fontWeight: 700, margin: "0 4px" }}>·</span>
                          <b style={{ ...NUM_STYLE, color: "#000", fontSize: 14, fontWeight: 800 }}>{v.pax}</b>
                          <span style={{ color: "#6B6B6B", fontSize: 10, fontWeight: 700, marginLeft: 4 }}>PAX</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* BOTTOM TILES */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
          <Tile label="CORPORATE BOOKINGS" value={corporateTables.length} tone="#000" sub={`${corpPax} pax`} />
          <Tile label="GUESTLIST / FREE ENTRY" value={guestlistPax} tone="#000" sub="comp entries" />
          <Tile label="TOTAL PAID ENTRY" value={fmtRs(totalPaidEntry)} tone="#000" sub={`${paidTicketBookings.length + paidEntryBookings.length} paid${(ticketBookings.length + entryBookings.length) > (paidTicketBookings.length + paidEntryBookings.length) ? ` · ${(ticketBookings.length + entryBookings.length) - (paidTicketBookings.length + paidEntryBookings.length)} unpaid` : ""}`} />
          <Tile label="TOTAL ENTRY-ONLY" value={totalEntryOnly} tone="#000" sub="entry-pass bookings" />
          <Tile label="TOTAL CHECKED IN" value={totalCheckedIn} tone="#FF5733" sub="across all sources" />
        </div>

        <div style={{ marginTop: 14, fontSize: 10, color: "#6B6B6B", textAlign: "center", lineHeight: 1.5 }}>
          🛟 Window: 12:00 pm → 3:00 am IST on {nightDate}. Lunch &lt; 5pm · Dinner ≥ 5pm. All numbers update live as bookings arrive.
        </div>
      </div>
    </div>
  );
}

export default function DoorMode() {
  // 🔄 2026-05-25 (Khushi) — Per-staff HOD-ID + 4-digit PIN login (StaffLogin)
  // bridges into `agentName` via the DoorLogin wrapper above.
  const { isLoggedIn, currentStaff, hasRole, activeMode, logout } = useStaff();
  const [agentName, setAgentName] = useState<string | null>(() =>
    sessionStorage.getItem("hod_door_auth") === "1" ? sessionStorage.getItem("hod_door_name") : null
  );

  // 🔴 2026-05-25 (code review fix) — Force local logout when global session
  // clears OR multi-role user switches away from hostess (door) mode.
  useEffect(() => {
    if (!agentName) return;
    const stillHostess = isLoggedIn && currentStaff && hasRole("hostess") && (!activeMode || activeMode === "hostess");
    if (!stillHostess) {
      sessionStorage.removeItem("hod_door_auth");
      sessionStorage.removeItem("hod_door_name");
      setAgentName(null);
    }
  }, [isLoggedIn, currentStaff, hasRole, activeMode, agentName]);

  if (!agentName) return <DoorLogin onLogin={setAgentName} />;
  // 🆕 2026-06-05 v3.228 — logout must clear the CONTEXT session (not just the
  // local door keys), otherwise DoorLogin's auto-login effect re-logs in instantly
  // (= "logout button does nothing"). Context logout() also nukes the door keys.
  const doLogout = () => {
    logout();
    sessionStorage.removeItem("hod_door_auth");
    sessionStorage.removeItem("hod_door_name");
    setAgentName(null);
  };
  return <DoorDashboard agentName={agentName} onLogout={doLogout} />;
}
