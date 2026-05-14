import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import {
  sha256, lookupBooking, subscribeToBookings, subscribeToGuestlist,
  subscribeToHodReservations, checkInGuest, reassignTable, cancelTableReservation,
  ensureZeroBalanceCoverForGuest,
  subscribeToHodEvents, type HodEvent,
  getCoverForBooking, activateCoverForBooking, editCoverAmount,
  ensureCoverForAggregatorArrival, createAggregatorTableBooking,
  createWalkInTicketBooking, createWalkInGuestlistEntry,
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
import { FEATURES } from "@/lib/feature-flags";
import {
  startEdcCharge, subscribeToEdcTransaction, cancelEdcCharge,
  getActiveEdcVendor, setActiveEdcVendor, hasEdcVendorOverride, edcVendorLabel,
  EDC_CLIENT_TIMEOUT_MS,
  type EdcVendor, type EdcTransactionDoc,
} from "@/lib/edc-charge";
import { getOperationalNightStr } from "@/lib/utils-pos";
import { unmarkGuestArrived, markGuestArrived } from "@/lib/firestore-hod";
import { useToast } from "@/hooks/use-toast";

// Firebase Cloud Functions — replaces Replit /api/whatsapp/*
// Set this to your Firebase Functions URL after deploying:
//   https://asia-south1-hod-tickets.cloudfunctions.net
// During local dev with Firebase emulator:
//   http://localhost:5001/hod-tickets/asia-south1
const WHATSAPP_CF_BASE = "https://asia-south1-hod-tickets.cloudfunctions.net";

import { ToastAction } from "@/components/ui/toast";
import { QrScanner } from "@/components/QrScanner";

const DOOR_HASH = "f3deb7cb025897c8b29bc9c0603c35909616f8d6a0c32ddb774683accf394cb9";

function DoorLogin({ onLogin }: { onLogin: (name: string) => void }) {
  const [name, setName] = useState(() => sessionStorage.getItem("hod_door_name") || "");
  const [pwd, setPwd] = useState("");
  const [error, setError] = useState("");
  const [fails, setFails] = useState(() => parseInt(sessionStorage.getItem("hod_door_fails") || "0"));
  const [lockUntil, setLockUntil] = useState(() => parseInt(sessionStorage.getItem("hod_door_lock") || "0"));

  const tryLogin = async () => {
    const currentLock = parseInt(sessionStorage.getItem("hod_door_lock") || "0");
    if (currentLock > Date.now()) {
      setLockUntil(currentLock);
      setError(`Too many attempts. Locked for ${Math.ceil((currentLock - Date.now()) / 60000)} min.`);
      return;
    }
    if (!name.trim()) { setError("Enter your name"); return; }
    const hash = await sha256(pwd);
    if (hash === DOOR_HASH) {
      sessionStorage.setItem("hod_door_name", name.trim());
      sessionStorage.setItem("hod_door_auth", "1");
      sessionStorage.removeItem("hod_door_fails");
      onLogin(name.trim());
    } else {
      const f = fails + 1;
      setFails(f);
      sessionStorage.setItem("hod_door_fails", String(f));
      if (f >= 5) {
        const lock = Date.now() + 5 * 60 * 1000;
        sessionStorage.setItem("hod_door_lock", String(lock));
        setLockUntil(lock);
        setError("Too many attempts. Locked for 5 minutes.");
      } else {
        setError(`Wrong password (${5 - f} left)`);
      }
      setPwd("");
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0A0A0A", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 20, padding: "32px 28px", width: "100%", maxWidth: 360, textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🚪</div>
        <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 20, fontWeight: 900, color: "#C8A645", marginBottom: 6 }}>Door Agent Login</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginBottom: 24 }}>HOD — House of Dopamine</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name"
          style={{ width: "100%", padding: "14px 16px", borderRadius: 12, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 15, outline: "none", marginBottom: 10, boxSizing: "border-box" }} />
        <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder="Enter door password"
          onKeyDown={(e) => e.key === "Enter" && tryLogin()}
          style={{ width: "100%", padding: "14px 16px", borderRadius: 12, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 15, outline: "none", marginBottom: 12, boxSizing: "border-box" }} />
        {error && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 10 }}>{error}</div>}
        <button onClick={tryLogin}
          style={{ width: "100%", padding: 14, borderRadius: 12, background: "linear-gradient(135deg,#C8A645,#A07830)", border: "none", color: "#000", fontSize: 15, fontWeight: 900, cursor: "pointer" }}>
          Enter
        </button>
      </div>
    </div>
  );
}

function CoverActivationModal({ booking, agentName, onClose }: { booking: HodBooking; agentName: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [existing, setExisting] = useState<HodCover | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const today = getOperationalNightStr();
  const isPast = !!booking.date && booking.date < today;

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cv = await getCoverForBooking(booking.id || booking.ref);
        if (!cancelled) { setExisting(cv); if (cv) setEditAmt(String(cv.coverActivated || 0)); }
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
      ? `\n\nCollect: ${paymentSplit?.cash ? `₹${paymentSplit.cash} cash ` : ""}${paymentSplit?.upi ? `+ ₹${paymentSplit.upi} UPI ` : ""}${paymentSplit?.card ? `+ ₹${paymentSplit.card} card` : ""}`.trim()
      : edcRef
        ? `\n\n💳 EDC charged ₹${diff > 0 ? diff : amt} (ref ${edcRef}).`
        : diff > 0 ? `\n\nCollect ₹${diff} ${pm === "cash" ? "cash" : pm === "upi" ? "UPI" : "card"}.` : "";
    alert(`✅ Cover ₹${amt} activated for ${booking.name || "guest"}.${collectMsg}`);
  };

  const handleActivate = async () => {
    setErr("");
    const amt = parseInt(amount, 10);
    if (!amt || amt < 1) { setErr("Enter a valid cover amount"); return; }
    if (amt > 5000) { setErr("Max ₹5,000"); return; }
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

  const handleEditSave = async () => {
    if (!existing) return;
    const newAmt = parseInt(editAmt, 10);
    const used = existing.coverUsed || 0;
    if (!newAmt || newAmt < used) { setErr(`Min ₹${used} (already used)`); return; }
    if (newAmt > 5000) { setErr("Max ₹5,000"); return; }
    if (newAmt === existing.coverActivated) { setErr("Amount unchanged"); return; }
    if (!window.confirm(`Change cover ₹${existing.coverActivated} → ₹${newAmt}?`)) return;
    setBusy(true); setErr("");
    try {
      await editCoverAmount(existing.id, newAmt, agentName);
      const cv = await getCoverForBooking(booking.id || booking.ref);
      if (cv) setExisting(cv);
      setEditMode(false);
    } catch (e: any) { setErr(e?.message || "Failed to edit"); }
    setBusy(false);
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0C0816", border: "1.5px solid rgba(200,166,69,0.3)", borderRadius: 18, padding: 22, width: "100%", maxWidth: 380, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#C8A645", letterSpacing: 1.5, marginBottom: 10 }}>💰 COVER CHARGE</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>{booking.name || "Guest"}</div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 16 }}>
          {booking.eventTitle || ""}{booking._isGuestList ? " · Guest List" : paidOnline > 0 ? ` · Paid online ₹${paidOnline}` : isCash ? ` · 💵 Pay at venue ₹${booking.total || 0}` : ""}
        </div>

        {isPast ? (
          <div style={{ background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.3)", borderRadius: 12, padding: 14, color: "#EF4444", fontSize: 13, textAlign: "center", marginBottom: 12 }}>
            ⛔ Past event ({booking.date}) — cover cannot be activated.
          </div>
        ) : loading ? (
          <div style={{ textAlign: "center", padding: 24, color: "rgba(255,255,255,.5)", fontSize: 12 }}>Checking cover status…</div>
        ) : existing ? (
          <>
            <div style={{ background: "rgba(0,200,100,.06)", border: "1px solid rgba(0,200,100,.25)", borderRadius: 14, padding: 14, marginBottom: 10 }}>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,.5)", letterSpacing: 1, marginBottom: 8 }}>✅ ALREADY ACTIVATED</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, textAlign: "center" }}>
                <div style={{ background: "rgba(255,255,255,.04)", borderRadius: 8, padding: 8 }}>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,.5)" }}>ACTIVATED</div>
                  <div style={{ fontSize: 16, fontWeight: 900, color: "#C8A645" }}>₹{(existing.coverActivated || 0).toLocaleString("en-IN")}</div>
                </div>
                <div style={{ background: "rgba(255,255,255,.04)", borderRadius: 8, padding: 8 }}>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,.5)" }}>USED</div>
                  <div style={{ fontSize: 16, fontWeight: 900, color: "#EF4444" }}>₹{(existing.coverUsed || 0).toLocaleString("en-IN")}</div>
                </div>
                <div style={{ background: "rgba(255,255,255,.04)", borderRadius: 8, padding: 8 }}>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,.5)" }}>BALANCE</div>
                  <div style={{ fontSize: 16, fontWeight: 900, color: (existing.coverBalance || 0) > 0 ? "#00C864" : "rgba(255,255,255,.5)" }}>₹{(existing.coverBalance || 0).toLocaleString("en-IN")}</div>
                </div>
              </div>
              {(existing.paymentMethod || existing.activatedBy) && (
                <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", marginTop: 8, textAlign: "center" }}>
                  {existing.paymentMethod ? `Paid via ${existing.paymentMethod}` : ""}{existing.activatedBy ? ` · by ${existing.activatedBy}` : ""}
                </div>
              )}
            </div>
            {editMode ? (
              <div style={{ background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.25)", borderRadius: 12, padding: 12, marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: "#F59E0B", marginBottom: 8 }}>EDIT AMOUNT — Min ₹{existing.coverUsed || 0} · Max ₹5,000</div>
                <input type="number" value={editAmt} onChange={(e) => setEditAmt(e.target.value)}
                  style={{ width: "100%", padding: 10, borderRadius: 8, background: "rgba(255,255,255,.06)", border: "1.5px solid rgba(245,158,11,.4)", color: "#fff", fontSize: 16, fontWeight: 800, outline: "none", marginBottom: 8, boxSizing: "border-box" }} />
                <button onClick={handleEditSave} disabled={busy}
                  style={{ width: "100%", padding: 11, borderRadius: 9, background: "rgba(245,158,11,.15)", border: "1px solid rgba(245,158,11,.4)", color: "#F59E0B", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
                  {busy ? "Saving…" : "Save New Amount"}
                </button>
              </div>
            ) : (
              <button onClick={() => { setEditMode(true); setErr(""); }}
                style={{ width: "100%", padding: 11, borderRadius: 10, background: "rgba(245,158,11,.08)", border: "1px solid rgba(245,158,11,.25)", color: "#F59E0B", fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 8 }}>
                ✏️ Edit Cover Amount
              </button>
            )}
            <button onClick={() => sendWhatsApp(existing)}
              style={{ width: "100%", padding: 11, borderRadius: 10, background: "rgba(37,211,102,0.12)", border: "1px solid rgba(37,211,102,0.4)", color: "#25D366", fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 8 }}>
              📲 Send WhatsApp Wallet Link
            </button>
            {/* 🔴 2026-05-13 (Khushi) — Void Cover (door equivalent of
                Captain Mode's Void Bill). Manager-PIN gated. Zeros the
                remaining cover balance with an audit-logged edit. The
                cash refund itself is handled out-of-band by the manager
                (per HOD policy — same as Captain Mode void bills). The
                amount-already-used remains attributed to the cover so
                Reports / EOD reconciliation stays accurate. */}
            <button onClick={async () => {
              const used = existing.coverUsed || 0;
              const remaining = (existing.coverActivated || 0) - used;
              if (remaining <= 0) { alert("Nothing to void — cover has no remaining balance."); return; }
              const pin = window.prompt(`🚫 VOID COVER\n\nThis will zero the remaining wallet balance of ₹${remaining.toLocaleString("en-IN")} for ${booking.name || "guest"}.\n\nThe ₹${used.toLocaleString("en-IN")} already used stays attributed.\nCash refund (if any) must be handled by the manager separately.\n\nEnter MANAGER PIN to confirm:`)?.trim();
              if (!pin) return;
              const h = await sha256(pin);
              if (h !== DOOR_MANAGER_HASH) { alert("❌ Wrong Manager PIN."); return; }
              const reason = window.prompt("Reason for void (e.g. customer left without entering, double-charge, manager call):")?.trim();
              if (!reason) { alert("Void cancelled — reason required."); return; }
              setBusy(true); setErr("");
              try {
                await editCoverAmount(existing.id, used, `${agentName} VOID: ${reason}`);
                const cv = await getCoverForBooking(booking.id || booking.ref);
                setExisting(cv);
                alert(`✅ Cover voided. Remaining ₹${remaining.toLocaleString("en-IN")} cleared.\nManager: please process the cash refund (if any).`);
              } catch (e: unknown) {
                setErr(e instanceof Error ? e.message : "Void failed.");
              }
              setBusy(false);
            }} disabled={busy}
              title="Use ONLY when cover was charged in error / customer left (Manager PIN required)"
              style={{ width: "100%", padding: 11, borderRadius: 10, background: "#A02820", border: "1px solid #A02820", color: "#fff", fontSize: 12, fontWeight: 800, cursor: busy ? "wait" : "pointer", marginBottom: 8, letterSpacing: .4, textTransform: "uppercase" }}>
              🚫 Void Cover
            </button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", letterSpacing: 1, marginBottom: 6 }}>TONIGHT'S COVER (₹)</div>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 1499" min={0} max={5000}
              style={{ width: "100%", padding: "12px 14px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1.5px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 18, fontWeight: 800, outline: "none", marginBottom: 12, boxSizing: "border-box" }} />

            <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", letterSpacing: 1, marginBottom: 8 }}>PAYMENT METHOD</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
              {([
                { id: "cash" as const, label: "💵 Cash", color: "#00C864" },
                { id: "upi" as const, label: "📱 UPI", color: "#00C4FF" },
                { id: "card" as const, label: FEATURES.edc ? "💳 Card (EDC)" : "💳 Card", color: "#A855F7" },
                { id: "paid_online" as const, label: "✅ Paid Online", color: "#F59E0B" },
              ]).map((pm) => {
                const sel = method === pm.id;
                return (
                  <button key={pm.id} onClick={() => setMethod(pm.id)}
                    style={{ padding: 10, borderRadius: 8, border: `${sel ? 2.5 : 1.5}px solid ${pm.color}55`, background: `${pm.color}${sel ? "26" : "0d"}`, color: pm.color, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                    {pm.label}
                  </button>
                );
              })}
            </div>
            <button onClick={() => setMethod("split")}
              style={{ width: "100%", padding: 10, borderRadius: 8, border: `${method === "split" ? 2.5 : 1.5}px solid #EC489955`, background: `#EC4899${method === "split" ? "26" : "0d"}`, color: "#EC4899", fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 12 }}>
              ➗ Split Payment
            </button>

            {method === "split" && (() => {
              const amt = parseInt(amount || "0", 10) || 0;
              const c = parseInt(splitCash || "0", 10) || 0;
              const u = parseInt(splitUpi || "0", 10) || 0;
              const cd = parseInt(splitCard || "0", 10) || 0;
              const total = c + u + cd + paidOnline;
              const remain = amt - total;
              return (
                <div style={{ background: "rgba(236,72,153,.06)", border: "1px solid rgba(236,72,153,.25)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                  <div style={{ fontSize: 10, color: "#EC4899", marginBottom: 8, fontWeight: 800, letterSpacing: ".5px" }}>SPLIT BREAKDOWN (must total ₹{amt})</div>
                  {paidOnline > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", borderRadius: 7, background: "rgba(245,158,11,.08)", border: "1px solid rgba(245,158,11,.25)", fontSize: 12, color: "#F59E0B", marginBottom: 6 }}>
                      <span>✅ Paid online (locked)</span><span style={{ fontWeight: 800 }}>₹{paidOnline}</span>
                    </div>
                  )}
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 6, alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 12, color: "#00C864", fontWeight: 700 }}>💵 Cash</span>
                    <input type="number" inputMode="numeric" value={splitCash} onChange={(e) => setSplitCash(e.target.value)} placeholder="0"
                      style={{ padding: "8px 10px", borderRadius: 7, background: "rgba(255,255,255,.05)", border: "1px solid rgba(0,200,100,.3)", color: "#fff", fontSize: 13, fontWeight: 700, outline: "none", textAlign: "right" }} />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 6, alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 12, color: "#00C4FF", fontWeight: 700 }}>📱 UPI&nbsp;&nbsp;</span>
                    <input type="number" inputMode="numeric" value={splitUpi} onChange={(e) => setSplitUpi(e.target.value)} placeholder="0"
                      style={{ padding: "8px 10px", borderRadius: 7, background: "rgba(255,255,255,.05)", border: "1px solid rgba(0,196,255,.3)", color: "#fff", fontSize: 13, fontWeight: 700, outline: "none", textAlign: "right" }} />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 6, alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: "#A855F7", fontWeight: 700 }}>💳 Card</span>
                    <input type="number" inputMode="numeric" value={splitCard} onChange={(e) => setSplitCard(e.target.value)} placeholder="0"
                      style={{ padding: "8px 10px", borderRadius: 7, background: "rgba(255,255,255,.05)", border: "1px solid rgba(168,85,247,.3)", color: "#fff", fontSize: 13, fontWeight: 700, outline: "none", textAlign: "right" }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 10px", borderRadius: 8, background: remain === 0 ? "rgba(0,200,100,.1)" : "rgba(239,68,68,.08)", border: `1px solid ${remain === 0 ? "rgba(0,200,100,.4)" : "rgba(239,68,68,.3)"}`, fontSize: 12, fontWeight: 800, color: remain === 0 ? "#00C864" : "#EF4444" }}>
                    <span>{remain === 0 ? "✓ Balanced" : remain > 0 ? "Remaining" : "Over by"}</span>
                    <span>₹{Math.abs(remain).toLocaleString("en-IN")}</span>
                  </div>
                </div>
              );
            })()}

            {paidOnline > 0 && parseInt(amount || "0", 10) > paidOnline && method !== "split" && (
              <div style={{ padding: "10px 12px", borderRadius: 9, background: "rgba(245,158,11,.08)", border: "1px solid rgba(245,158,11,.3)", fontSize: 12, color: "#F59E0B", marginBottom: 12 }}>
                ⚠️ Additional ₹{(parseInt(amount, 10) - paidOnline).toLocaleString("en-IN")} to collect (₹{paidOnline} paid online)
              </div>
            )}

            {/* EDC bouncer-PIN gate. Only on the pure-Card path so cash/UPI/split
                flows are unaffected. PIN keeps the card machine from firing on
                a phone someone else picked up off the door podium. */}
            {FEATURES.edc && method === "card" && (
              <div style={{ background: "rgba(168,85,247,.06)", border: "1px solid rgba(168,85,247,.3)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: "#A855F7", letterSpacing: ".5px", fontWeight: 800, marginBottom: 6 }}>💳 EDC CLOUD — BOUNCER PIN</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,.55)", marginBottom: 8 }}>
                  We'll push ₹{Math.max(parseInt(amount || "0", 10) - paidOnline, parseInt(amount || "0", 10) || 0).toLocaleString("en-IN")} to the {edcVendorLabel(edcVendor)} machine. Enter your 4-digit PIN to authorise.
                </div>
                {/* Per-device vendor picker — saved to localStorage so a tablet
                    paired to a specific machine remembers its choice across
                    refreshes. Hidden when only one vendor is realistically
                    available; we still render both so a venue running both
                    can flip mid-shift if one terminal goes offline. */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
                  {(["razorpay", "pinelabs"] as const).map((v) => {
                    const sel = edcVendor === v;
                    const isVenueDefault = venueDefaultVendor === v;
                    return (
                      <button key={v} type="button"
                        onClick={() => { setEdcVendor(v); setActiveEdcVendor(v); }}
                        style={{ padding: "7px 8px", borderRadius: 7, border: `${sel ? 2 : 1}px solid ${sel ? "#A855F7" : "rgba(168,85,247,.3)"}`, background: sel ? "rgba(168,85,247,.18)" : "rgba(255,255,255,.04)", color: sel ? "#fff" : "rgba(255,255,255,.65)", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                        {v === "razorpay" ? "Razorpay POS" : "Pine Labs"}{isVenueDefault ? " ★" : ""}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="password" inputMode="numeric" autoComplete="off"
                  maxLength={6} value={edcPin}
                  onChange={(e) => setEdcPin(e.target.value.replace(/\D/g, ""))}
                  placeholder="• • • •"
                  style={{ width: "100%", padding: 10, borderRadius: 8, background: "rgba(255,255,255,.05)", border: "1px solid rgba(168,85,247,.4)", color: "#fff", fontSize: 18, letterSpacing: 6, textAlign: "center", outline: "none", boxSizing: "border-box" }}
                />
              </div>
            )}

            <button onClick={handleActivate} disabled={busy}
              style={{ width: "100%", padding: 14, borderRadius: 12, background: "linear-gradient(135deg,#C8A645,#A07830)", border: "none", color: "#000", fontSize: 14, fontWeight: 900, cursor: "pointer", marginBottom: 8 }}>
              {busy ? "Activating…" : "⚡ Activate Cover Wallet"}
            </button>
          </>
        )}

        {err && <div style={{ color: "#EF4444", fontSize: 12, marginBottom: 8, textAlign: "center" }}>{err}</div>}

        <button onClick={onClose}
          style={{ width: "100%", padding: 11, borderRadius: 10, background: "transparent", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.55)", fontSize: 13, cursor: "pointer" }}>
          Close
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
      <div style={{ background: "#0C0816", border: "1.5px solid rgba(168,85,247,0.4)", borderRadius: 18, padding: 26, width: "100%", maxWidth: 380, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: "#A855F7", letterSpacing: 1.5, fontWeight: 900, marginBottom: 14 }}>💳 {vendorLabel} — CARD MACHINE</div>

        <div style={{ fontSize: 36, fontWeight: 900, color: "#fff", marginBottom: 4 }}>
          ₹{amount.toLocaleString("en-IN")}
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.55)", marginBottom: 22 }}>
          for {customerName}
        </div>

        {status === "pending" && (
          <>
            <div style={{ fontSize: 60, marginBottom: 14, animation: "pulse 1.4s ease-in-out infinite" }}>📡</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#A855F7", marginBottom: 4 }}>Tap card on the EDC machine</div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginBottom: 18 }}>
              {remaining}s remaining
            </div>
            <div style={{ height: 4, background: "rgba(255,255,255,.06)", borderRadius: 2, overflow: "hidden", marginBottom: 18 }}>
              <div style={{ width: `${Math.min(100, (elapsedMs / EDC_CLIENT_TIMEOUT_MS) * 100)}%`, height: "100%", background: "linear-gradient(90deg,#A855F7,#EC4899)", transition: "width .25s linear" }} />
            </div>
            <button onClick={handleCancel} disabled={cancelling}
              style={{ width: "100%", padding: 12, borderRadius: 10, background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.35)", color: "#EF4444", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
              {cancelling ? "Cancelling…" : "✕ Cancel"}
            </button>
          </>
        )}

        {status === "success" && (
          <>
            <div style={{ fontSize: 60, marginBottom: 12 }}>✅</div>
            <div style={{ fontSize: 16, fontWeight: 900, color: "#00C864", marginBottom: 4 }}>Approved</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)" }}>
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
              <div style={{ fontSize: 14, fontWeight: 900, color: isFailed ? "#EF4444" : "rgba(255,255,255,.6)", marginBottom: 12 }}>
                {isFailed ? (timedOut ? timeoutReason : (txn?.errorReason || "DECLINED")) : "Cancelled"}
              </div>
              {retryErr && (
                <div style={{ fontSize: 11, color: "#EF4444", marginBottom: 10 }}>{retryErr}</div>
              )}
              {canRetry && onRetry && (
                <button onClick={handleRetry} disabled={retrying}
                  style={{ width: "100%", padding: 12, borderRadius: 10, background: "rgba(168,85,247,.15)", border: "1px solid rgba(168,85,247,.4)", color: "#A855F7", fontSize: 13, fontWeight: 800, cursor: retrying ? "wait" : "pointer", marginBottom: 8 }}>
                  {retrying ? "Re-dispatching…" : "🔁 Retry on machine"}
                </button>
              )}
              <button onClick={() => isFailed ? onFailed(timedOut ? timeoutReason : (txn?.errorReason || "DECLINED")) : onCancelled()}
                style={{ width: "100%", padding: 12, borderRadius: 10, background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.35)", color: "#EF4444", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
                Close
              </button>
            </>
          );
        })()}
      </div>
    </div>
  );
}

function LookupResult({ booking, agentName, onDone }: { booking: HodBooking; agentName: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(booking.checkedIn || false);
  const [err, setErr] = useState("");
  const { toast } = useToast();
  // Cross-collection search may surface an aggregator booking that has not
  // yet been assigned a table (auto-assign still pending or flagged for
  // manual review). For those we cannot run checkInGuest — there is no
  // tableReservation to mutate. Show a clear notice instead.
  const pendingAssignment = (booking as CrossSourceBooking)._pendingAssignment === true;
  const aggLabel = (booking as CrossSourceBooking)._aggregator;

  // Sync local "done" with subscription updates (so list-row check-ins reflect here too)
  useEffect(() => { if (booking.checkedIn) setDone(true); }, [booking.checkedIn]);

  const isCash = !!(booking.paymentId && booking.paymentId.startsWith("cash_"));
  const isGuestList = !!booking._isGuestList;
  const paidOnline = isGuestList ? 0 : (isCash ? 0 : (booking.total || 0));
  const payAtVenue = isCash ? (booking.total || 0) : 0;

  const handleCheckIn = async () => {
    setBusy(true); setErr("");
    try {
      // 🛡 BUGFIX 2026-05-08: TABLE FOR 4 / VVIP TABLE FOR 6 bookings dual-write
      // to both `bookings` and `tableReservations`. lookupBooking finds them in
      // `bookings` first (so _isTable=false) — but we need the check-in to land
      // on the tableReservations doc so the Tables tab "Arrived" counter moves
      // and the row flips to actualArrivalTime. Detect via tableType / bookMode.
      const isModalTable = !!(booking as any).tableType || (booking as any).bookMode === "group";
      const source = (booking._isTable || isModalTable) ? "table" : booking._isGuestList ? "guestlist" : "booking";
      // For table source, key MUST be the booking ref (matches tableReservations.bookingRef).
      // For booking source, prefer docId (fast path); checkInGuest falls back to ref query.
      const key = source === "booking" ? (booking.id || booking.ref) : (booking.ref || booking.id);
      const { checkedInAt, wasNew } = await checkInGuest(key, source, agentName);
      setDone(true);
      // Only offer undo if THIS call was the actual check-in mutation. If the guest
      // was already checked in (e.g., another agent did it earlier), show an
      // informational toast — undoing it from a stale screen would clobber their work.
      if (wasNew) {
        toast({
          title: `✅ Checked in: ${booking.name || "Guest"}`,
          description: "Tap Undo within 30 seconds if this was a mistake.",
          duration: 30000,
          action: (
            <ToastAction altText="Undo check-in" onClick={async () => {
              try {
                const r = await checkInGuest(key, source, agentName, true, checkedInAt);
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
        toast({
          title: `Already checked in: ${booking.name || "Guest"}`,
          description: "No new action taken.",
          duration: 4000,
        });
      }
    } catch (e: any) {
      setErr(e?.message || "Check-in failed — see admin dashboard");
    }
    setBusy(false);
  };

  return (
    <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(200,166,69,0.3)", borderRadius: 16, padding: 20, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 900, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{booking.name || "Guest"}</div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,.4)", marginTop: 2 }}>{booking.ref} · {booking.phone}</div>
        </div>
        {done ? (
          <span style={{ background: "rgba(0,200,100,.15)", border: "1px solid rgba(0,200,100,.3)", color: "#00C864", fontSize: 11, fontWeight: 800, padding: "4px 10px", borderRadius: 10, whiteSpace: "nowrap" }}>✅ CHECKED IN</span>
        ) : (
          <span style={{ background: "rgba(251,191,36,.1)", border: "1px solid rgba(251,191,36,.3)", color: "#FBBF24", fontSize: 11, fontWeight: 800, padding: "4px 10px", borderRadius: 10 }}>PENDING</span>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
        {booking.type && <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)" }}>Type: <span style={{ color: "#C8A645", fontWeight: 700 }}>{booking.type}</span></div>}
        {booking.tier && <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)" }}>Tier: <span style={{ color: "#C8A645", fontWeight: 700 }}>{booking.tier}</span></div>}
        {booking.guests && <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)" }}>Guests: <span style={{ color: "#fff", fontWeight: 700 }}>{booking.guests}</span></div>}
        {booking.eventTitle && <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)" }}>Event: <span style={{ color: "#fff", fontWeight: 700 }}>{booking.eventTitle}</span></div>}
        {isGuestList ? (
          <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", gridColumn: "1 / -1" }}>Entry: <span style={{ color: "#60A5FA", fontWeight: 700 }}>📋 Free guest list</span></div>
        ) : payAtVenue > 0 ? (
          <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", gridColumn: "1 / -1" }}>Status: <span style={{ color: "#FBBF24", fontWeight: 700 }}>💵 Pay at venue ₹{payAtVenue}</span></div>
        ) : paidOnline > 0 ? (
          <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", gridColumn: "1 / -1" }}>Paid online: <span style={{ color: "#00C864", fontWeight: 700 }}>✅ ₹{paidOnline}</span></div>
        ) : null}
      </div>

      {err && (
        <div style={{ background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.3)", color: "#EF4444", fontSize: 12, padding: 10, borderRadius: 9, marginBottom: 10 }}>
          ⚠️ {err}
        </div>
      )}

      {pendingAssignment && (
        <div style={{ background: "rgba(168,85,247,.08)", border: "1px solid rgba(168,85,247,.3)", color: "#A855F7", fontSize: 12, padding: 10, borderRadius: 9, marginBottom: 10, fontWeight: 700 }}>
          ⏳ {aggLabel?.toUpperCase() || "AGGREGATOR"} booking — table not yet assigned. Open Captain Mode to assign a table, then check the guest in.
        </div>
      )}

      {!done && !pendingAssignment && (
        <button onClick={handleCheckIn} disabled={busy}
          style={{ width: "100%", padding: 14, borderRadius: 12, background: "linear-gradient(135deg,rgba(0,200,100,.9),rgba(0,160,80,.8))", border: "none", color: "#fff", fontSize: 15, fontWeight: 900, cursor: "pointer" }}>
          {busy ? "Checking in..." : "✅ Check In Guest"}
        </button>
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
const TODAY_DATE_SET = () => new Set([TODAY_STR(), CALENDAR_TODAY_STR()]);

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
        style={{ background: "linear-gradient(180deg,#0e0e14,#070710)", border: "1.5px solid rgba(242,199,68,.3)", borderRadius: 18, padding: 22, width: "100%", maxWidth: 380, color: "#fff", textAlign: "center" }}>

        {scanned ? (
          <>
            <div style={{ fontSize: 56, marginBottom: 8 }}>✅</div>
            <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 800, color: "#00C864", marginBottom: 4 }}>Guest Scanned!</div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)" }}>Wallet opened on their phone. You can move on.</div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#FCA5A5", letterSpacing: 1, marginBottom: 4 }}>📵 WHATSAPP COULDN'T BE SENT</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 14, lineHeight: 1.4 }}>{reason}</div>
            <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 20, fontWeight: 800, color: "#C8A645", marginBottom: 6 }}>
              Show this QR to {customerName}
            </div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,.6)", marginBottom: 14 }}>
              Ask them to scan with their phone camera — wallet & menu open instantly.
            </div>

            <div style={{ background: "#fff", padding: 12, borderRadius: 12, display: "inline-block", marginBottom: 14 }}>
              {qrDataUrl
                ? <img src={qrDataUrl} alt="Wallet QR" style={{ width: 280, height: 280, display: "block" }} />
                : <div style={{ width: 280, height: 280, display: "flex", alignItems: "center", justifyContent: "center", color: "#999" }}>Generating QR…</div>}
            </div>

            <div style={{ fontSize: 10, fontFamily: "monospace", color: "rgba(255,255,255,.4)", wordBreak: "break-all", marginBottom: 12, padding: 8, background: "rgba(255,255,255,.04)", borderRadius: 8 }}>
              {walletUrl}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <button onClick={copyLink}
                style={{ padding: "12px 14px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.15)", color: "#fff", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
                {copied ? "✓ COPIED" : "📋 COPY LINK"}
              </button>
              <button onClick={onClose}
                style={{ padding: "12px 14px", borderRadius: 10, background: "rgba(0,200,100,.18)", border: "1.5px solid rgba(0,200,100,.5)", color: "#00C864", fontSize: 12, fontWeight: 900, cursor: "pointer" }}>
                ✓ DONE
              </button>
            </div>

            <div style={{ marginTop: 10, fontSize: 10, color: "rgba(255,255,255,.35)" }}>
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
  const digits = (opts.phone || "").replace(/\D/g, "");
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
async function sendBookingWhatsApp(
  b: HodBooking,
  onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void,
) {
  const phone = (b.phone || "").replace(/\D/g, "").slice(-10);
  const ref = b.ref || b.id;
  const link = `https://hodclub.in/?wallet=${encodeURIComponent(ref)}`;
  const customerName = b.name || "Guest";
  const eventTitle = b.eventTitle || "Tonight at H.O.D";
  const dateNice = formatBookingDateNice(b.date);
  const entryLabel = bookingEntryLabel(b);
  const fallbackText =
    `Hi ${customerName}, your HOD cover is booked! 🎟️\n\n` +
    `🎉 Event: ${eventTitle}\n` +
    `📅 Date: ${dateNice}\n` +
    `🚪 Entry: ${entryLabel}\n\n` +
    `Show your QR at the door — your wallet activates when you arrive at HOD.\n\n` +
    `View ticket: ${link}\n\n` +
    `See you tonight!\n\n` +
    `📍 House of Dopamine, Koramangala\n${HOD_LOCATION_URL}`;
  if (phone.length !== 10) {
    if (ref) await logNotificationOutcome(ref, { status: "no_phone" });
    onShowQr({ bookingRef: ref, walletUrl: link, customerName,
      reason: "No valid phone on file. Show this QR to the guest instead." });
    return;
  }
  const result = await sendWhatsAppViaMeta({
    phone,
    template: { name: "wallet_ready", params: [customerName, eventTitle, dateNice, entryLabel, link] },
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
      ? `Template "wallet_ready" not approved by Meta yet, and the guest is outside the 24h reply window.`
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
  const fallbackText =
    `Hi ${customerName}, you're on the HOD guest list! 🎟️\n\n` +
    `🎉 Event: ${eventTitle}\n` +
    `📅 Date: ${dateNice}\n` +
    `🚪 Entry: FREE (Guest List)\n\n` +
    `Show your QR at the door — entry is complimentary.\n\n` +
    `View pass: ${link}\n\n` +
    `See you tonight!\n\n` +
    `📍 House of Dopamine, Koramangala\n${HOD_LOCATION_URL}`;
  if (phone.length !== 10) {
    await logNotificationOutcome(g.id, { status: "no_phone" });
    onShowQr({ bookingRef: g.id, walletUrl: link, customerName,
      reason: "No valid phone on file. Show this QR to the guest instead." });
    return;
  }
  const result = await sendWhatsAppViaMeta({
    phone,
    template: { name: "guestlist_ready", params: [customerName, eventTitle, link] },
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
      ? `Template "guestlist_ready" not approved by Meta yet, and the guest is outside the 24h reply window.`
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

function PaidBadge({ booking }: { booking: HodBooking }) {
  // Per Khushi spec: only two states. Anything paid through the customer
  // site's online checkout (Razorpay) is "Paid online"; everything else —
  // walk-ins (cash_*), guestlist comps, aggregator bookings, zero-total
  // entries — falls into "Pay at venue" so door staff knows to confirm
  // the cover/entry charge at the door.
  const pid = booking.paymentId || "";
  const paidOnline = pid && !pid.startsWith("cash_") && !pid.startsWith("comp_");
  if (paidOnline) {
    return <span style={{ background: "rgba(0,200,100,.15)", border: "1px solid rgba(0,200,100,.45)", color: "#00C864", fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 999, whiteSpace: "nowrap", letterSpacing: .3 }}>✓ Paid online</span>;
  }
  return <span style={{ background: "rgba(200,166,69,0.18)", border: "1px solid rgba(200,166,69,0.55)", color: "#C8A645", fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 999, whiteSpace: "nowrap", letterSpacing: .3 }}>₹ Pay at venue</span>;
}

function BookingRow({ booking, onOpen }: { booking: HodBooking; onOpen: (b: HodBooking) => void }) {
  const phoneClean = (booking.phone || "").replace(/[^\d+]/g, "");
  return (
    <div onClick={() => onOpen(booking)}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 14px", borderRadius: 10,
        background: booking.checkedIn ? "rgba(0,200,100,0.05)" : "rgba(255,255,255,0.03)",
        border: `1px solid ${booking.checkedIn ? "rgba(0,200,100,0.25)" : "rgba(255,255,255,0.06)"}`,
        marginBottom: 8, cursor: "pointer", transition: "background .12s" }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.3px", color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {booking.name || "Guest"}
          </div>
          {booking.checkedIn && <span style={{ color: "#00C864", fontSize: 12, fontWeight: 900 }}>✓</span>}
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {booking.phone || "no phone"}{booking.ref ? ` · ${booking.ref}` : ""}
        </div>
      </div>
      <PaidBadge booking={booking} />
      {phoneClean && (
        <a href={`tel:${phoneClean}`} onClick={(e) => e.stopPropagation()} title="Call guest"
          style={{ flexShrink: 0, width: 38, height: 38, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: "#B83227", border: "none", color: "#fff", fontSize: 16, textDecoration: "none" }}>
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
  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", zIndex: 100, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto", backdropFilter: "blur(4px)" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 520, marginTop: 32, background: "#111", border: "1.5px solid rgba(200,166,69,0.35)", borderRadius: 18, padding: 18, boxShadow: "0 24px 48px rgba(0,0,0,.6)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 900, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: "-0.3px" }}>
              {booking.name || "Guest"}
            </div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,.55)", marginTop: 4 }}>
              {booking.phone || "no phone"}{booking.ref ? ` · ${booking.ref}` : ""}
            </div>
          </div>
          <PaidBadge booking={booking} />
        </div>

        <LookupResult booking={booking} agentName={agentName} onDone={onClose} />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 4 }}>
          {!booking._isGuestList && (
            <button onClick={() => { onCover(booking); onClose(); }}
              style={{ padding: "12px 10px", borderRadius: 10, background: "#B83227", border: "none", color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
              💰 Activate Cover
            </button>
          )}
          {onSendWhatsApp && (
            <button onClick={() => onSendWhatsApp(booking)}
              style={{ padding: "12px 10px", borderRadius: 10, background: "rgba(37,211,102,0.12)", border: "1px solid rgba(37,211,102,0.4)", color: "#25D366", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
              📲 WhatsApp Link
            </button>
          )}
          <button onClick={() => onShowQr({
            bookingRef: booking.ref || booking.id,
            walletUrl: `https://hodclub.in/?wallet=${encodeURIComponent(booking.ref || booking.id)}`,
            customerName: booking.name || "Guest",
            reason: "Show this QR — guest scans to open their wallet & menu instantly.",
          })}
            style={{ padding: "12px 10px", borderRadius: 10, background: "rgba(200,166,69,0.12)", border: "1px solid rgba(200,166,69,0.4)", color: "#C8A645", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
            📱 Show QR
          </button>
          {phoneClean && (
            <a href={`tel:${phoneClean}`}
              style={{ padding: "12px 10px", borderRadius: 10, background: "rgba(37,211,102,0.12)", border: "1px solid rgba(37,211,102,0.4)", color: "#25D366", fontSize: 13, fontWeight: 800, cursor: "pointer", textAlign: "center", textDecoration: "none" }}>
              📞 Call
            </a>
          )}
        </div>

        <button onClick={onClose}
          style={{ marginTop: 12, width: "100%", padding: 12, borderRadius: 12, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.7)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
          Close
        </button>
      </div>
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
  const tt = String((b as any).tableType || "").toLowerCase();
  if (tt && tt.includes("group")) return true;
  return false;
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

function TicketsTab({ agentName, query, eventId, onCover, onShowQr }: { agentName: string; query: string; eventId: string; onCover: (b: HodBooking) => void; onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void }) {
  return <BookingsListTab kind="tickets" agentName={agentName} query={query} eventId={eventId} onCover={onCover} onShowQr={onShowQr} />;
}

function GroupBookingsTab({ agentName, query, eventId, onCover, onShowQr }: { agentName: string; query: string; eventId: string; onCover: (b: HodBooking) => void; onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void }) {
  return <BookingsListTab kind="group" agentName={agentName} query={query} eventId={eventId} onCover={onCover} onShowQr={onShowQr} />;
}

function OnlyEntryTab({ agentName, query, eventId, onCover, onShowQr }: { agentName: string; query: string; eventId: string; onCover: (b: HodBooking) => void; onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void }) {
  return <BookingsListTab kind="onlyentry" agentName={agentName} query={query} eventId={eventId} onCover={onCover} onShowQr={onShowQr} />;
}

function BookingsListTab({ kind, agentName, query, eventId, onCover, onShowQr }: {
  kind: "tickets" | "group" | "onlyentry";
  agentName: string; query: string; eventId: string;
  onCover: (b: HodBooking) => void;
  onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void;
}) {
  const [bookings, setBookings] = useState<HodBooking[]>([]);
  const [detail, setDetail] = useState<HodBooking | null>(null);
  const [showOnlyCheckedIn, setShowOnlyCheckedIn] = useState(false);

  // Tab-specific copy
  const COPY = kind === "group"
    ? { all: "Group Bookings", empty: "No group bookings for today" }
    : kind === "onlyentry"
    ? { all: "Only-Entry Bookings", empty: "No only-entry bookings for today" }
    : { all: "Today's Bookings", empty: "No bookings for today" };


  useEffect(() => {
    const unsub = subscribeToBookings((all) => setBookings(all));
    return unsub;
  }, []);

  const todayDates = TODAY_DATE_SET();
  let todayBookings = bookings.filter((b) => todayDates.has((b.date || "").slice(0, 10)));
  // Always exclude guestlist-typed bookings — they live under the Guest List tab.
  todayBookings = todayBookings.filter((b) => !isGuestlistBooking(b));
  // Then narrow to this tab's segment.
  if (kind === "tickets") {
    todayBookings = todayBookings.filter((b) => !isGroupBooking(b) && !isOnlyEntryBooking(b) && !isTableBooking(b));
  } else if (kind === "group") {
    todayBookings = todayBookings.filter((b) => isGroupBooking(b));
  } else if (kind === "onlyentry") {
    todayBookings = todayBookings.filter((b) => isOnlyEntryBooking(b));
  }
  if (eventId !== "all") todayBookings = todayBookings.filter((b) => !b.eventId || b.eventId === eventId);
  const checked = todayBookings.filter((b) => b.checkedIn).length;
  // Hide checked-in / activated rows from the default view; surface them via the toggle.
  const visibleBookings = showOnlyCheckedIn ? todayBookings.filter((b) => b.checkedIn) : todayBookings.filter((b) => !b.checkedIn);
  const filtered = visibleBookings.filter((b) => matchQuery(query, b.name, b.phone, b.ref));

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

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <div onClick={() => setShowOnlyCheckedIn(false)}
          style={{ background: !showOnlyCheckedIn ? "rgba(200,166,69,0.12)" : "rgba(255,255,255,.04)",
            border: `2px solid ${!showOnlyCheckedIn ? "#C8A645" : "transparent"}`,
            borderRadius: 10, padding: 14, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 28, fontWeight: 900, color: "#F2C744", lineHeight: 1 }}>{todayBookings.length}</div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "1.2px", textTransform: "uppercase", color: "rgba(255,255,255,0.5)", marginTop: 6 }}>{COPY.all.toUpperCase()} {!showOnlyCheckedIn ? "•" : ""}</div>
        </div>
        <div onClick={() => setShowOnlyCheckedIn(true)}
          style={{ background: showOnlyCheckedIn ? "rgba(0,200,100,0.12)" : "rgba(255,255,255,.04)",
            border: `2px solid ${showOnlyCheckedIn ? "#00C864" : "transparent"}`,
            borderRadius: 10, padding: 14, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 28, fontWeight: 900, color: "#00C864", lineHeight: 1 }}>{checked}</div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "1.2px", textTransform: "uppercase", color: "rgba(255,255,255,0.5)", marginTop: 6 }}>CHECKED IN {showOnlyCheckedIn ? "•" : ""}</div>
        </div>
      </div>

      {filtered.map((b) => (
        <BookingRow key={b.id} booking={b} onOpen={setDetail} />
      ))}
      {filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: 36, color: "rgba(255,255,255,0.35)", fontSize: 13, fontWeight: 500 }}>
          {query ? `No matches for "${query}"`
            : showOnlyCheckedIn ? "No one checked in yet — tap PENDING to see remaining guests"
            : COPY.empty}
        </div>
      )}
    </div>
  );
}

function GuestlistTab({ agentName, query, eventId, onCover, onShowQr }: { agentName: string; query: string; eventId: string; onCover: (b: HodBooking) => void; onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void }) {
  const [guests, setGuests] = useState<HodGuestlistEntry[]>([]);
  const [bookings, setBookings] = useState<HodBooking[]>([]);
  const [busyId, setBusyId] = useState("");
  const [showOnlyCheckedIn, setShowOnlyCheckedIn] = useState(false);
  const [detail, setDetail] = useState<HodBooking | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const unsub = subscribeToGuestlist((all) => setGuests(all));
    return unsub;
  }, []);
  // ── BUGFIX 2026-05-08: also subscribe to bookings so guestlist-typed entries
  // that landed in `bookings` (Firestore rules / cache / pre-fix HTML) still
  // show up under "📋 Guest List". Mapped to HodGuestlistEntry shape, deduped
  // by id with the canonical guestlist collection.
  useEffect(() => {
    const unsub = subscribeToBookings((all) => setBookings(all));
    return unsub;
  }, []);

  const handleToggle = async (g: HodGuestlistEntry) => {
    setBusyId(g.id);
    const wasCheckedIn = g.checkedIn;
    // Adapted bookings live in `bookings`, not `guestlist` — route check-in there.
    const _source: "booking" | "guestlist" = (g as any)._source === "booking" ? "booking" : "guestlist";
    try {
      const { checkedInAt, wasNew } = await checkInGuest(g.id, _source, agentName, wasCheckedIn);
      // Only show undo for a fresh check-in mutation (not idempotent no-ops, not un-checks).
      // Prevents stale-UI undo from clobbering a re-check-in by another agent.
      if (!wasCheckedIn && wasNew) {
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
      }
    } catch {}
    setBusyId("");
  };

  const today = TODAY_STR();
  // Today only: entry must have joinedAt OR entryTime stamped today.
  // If neither field exists (very old/legacy entry), exclude from door view.
  const todayDates = TODAY_DATE_SET();
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
  // Hide checked-in / activated rows from the default view; surface them via the toggle.
  const visibleGuests = showOnlyCheckedIn
    ? todayGuests.filter((g) => g.checkedIn)
    : todayGuests.filter((g) => !g.checkedIn);
  const filtered = visibleGuests.filter((g) => matchQuery(query, g.name, g.phone));
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
      {detail && detailGuest && (
        <div onClick={() => setDetail(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", zIndex: 100, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto", backdropFilter: "blur(4px)" }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 520, marginTop: 32, background: "#111", border: "1.5px solid rgba(200,166,69,0.35)", borderRadius: 18, padding: 18, boxShadow: "0 24px 48px rgba(0,0,0,.6)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 900, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: -.3 }}>
                  {detailGuest.name || "Guest"}
                </div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,.55)", marginTop: 4 }}>
                  {detailGuest.phone || "no phone"} · 📋 Guest list{detailGuest.type ? ` · ${detailGuest.type}` : ""}
                </div>
              </div>
              <PaidBadge booking={adapt(detailGuest)} />
            </div>

            {detailGuest.checkedIn ? (
              <div style={{ background: "rgba(0,200,100,.12)", border: "1px solid rgba(0,200,100,.35)", color: "#00C864", padding: 14, borderRadius: 12, fontSize: 13, fontWeight: 800, textAlign: "center", marginBottom: 12 }}>
                ✅ Checked in
              </div>
            ) : (
              <button onClick={() => handleToggle(detailGuest)} disabled={busyId === detailGuest.id}
                style={{ width: "100%", padding: 14, borderRadius: 12, background: "linear-gradient(135deg,rgba(0,200,100,.9),rgba(0,160,80,.8))", border: "none", color: "#fff", fontSize: 15, fontWeight: 900, cursor: "pointer", marginBottom: 10 }}>
                {busyId === detailGuest.id ? "Checking…" : "✅ Check In Guest"}
              </button>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <button onClick={() => { onCover(adapt(detailGuest)); setDetail(null); }}
                style={{ padding: "12px 10px", borderRadius: 10, background: "#B83227", border: "none", color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
                💰 Activate Cover
              </button>
              <button onClick={() => sendGuestlistWhatsApp(detailGuest, onShowQr)}
                style={{ padding: "12px 10px", borderRadius: 10, background: "rgba(37,211,102,0.12)", border: "1px solid rgba(37,211,102,0.4)", color: "#25D366", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
                📲 WhatsApp Link
              </button>
              <button onClick={() => onShowQr({
                bookingRef: detailGuest.id,
                walletUrl: `https://hodclub.in/?wallet=${encodeURIComponent((detailGuest as any).ref || detailGuest.id)}`,
                customerName: detailGuest.name || "Guest",
                reason: "Show this QR — guest scans to open their guest-list pass instantly.",
              })}
                style={{ padding: "12px 10px", borderRadius: 10, background: "rgba(200,166,69,0.12)", border: "1px solid rgba(200,166,69,0.4)", color: "#C8A645", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
                📱 Show QR
              </button>
              {!detailGuest.checkedIn && (
                <button onClick={() => handleFreeEntry(detailGuest)} disabled={busyId === detailGuest.id}
                  style={{ padding: "12px 10px", borderRadius: 10, background: "rgba(96,165,250,.12)", border: "1px solid rgba(96,165,250,.45)", color: "#60A5FA", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
                  {busyId === detailGuest.id ? "…" : "🎁 Free Entry"}
                </button>
              )}
              {detailGuest.phone && (
                <a href={`tel:${(detailGuest.phone || "").replace(/[^\d+]/g, "")}`}
                  style={{ padding: "12px 10px", borderRadius: 10, background: "rgba(37,211,102,0.12)", border: "1px solid rgba(37,211,102,0.4)", color: "#25D366", fontSize: 13, fontWeight: 800, cursor: "pointer", textAlign: "center", textDecoration: "none" }}>
                  📞 Call
                </a>
              )}
            </div>

            <button onClick={() => setDetail(null)}
              style={{ marginTop: 12, width: "100%", padding: 12, borderRadius: 12, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.7)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              Close
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <div onClick={() => setShowOnlyCheckedIn(false)}
          style={{ background: !showOnlyCheckedIn ? "rgba(200,166,69,0.12)" : "rgba(255,255,255,.04)",
            border: `2px solid ${!showOnlyCheckedIn ? "#C8A645" : "transparent"}`,
            borderRadius: 10, padding: 14, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 28, fontWeight: 900, color: "#F2C744", lineHeight: 1 }}>{todayGuests.length}</div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "1.2px", textTransform: "uppercase", color: "rgba(255,255,255,0.5)", marginTop: 6 }}>TONIGHT'S GUEST LIST {!showOnlyCheckedIn ? "•" : ""}</div>
        </div>
        <div onClick={() => setShowOnlyCheckedIn(true)}
          style={{ background: showOnlyCheckedIn ? "rgba(0,200,100,0.12)" : "rgba(255,255,255,.04)",
            border: `2px solid ${showOnlyCheckedIn ? "#00C864" : "transparent"}`,
            borderRadius: 10, padding: 14, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 28, fontWeight: 900, color: "#00C864", lineHeight: 1 }}>{checkedIn}</div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "1.2px", textTransform: "uppercase", color: "rgba(255,255,255,0.5)", marginTop: 6 }}>CHECKED IN {showOnlyCheckedIn ? "•" : ""}</div>
        </div>
      </div>

      {filtered.map((g) => (
        <BookingRow key={g.id} booking={adapt(g)} onOpen={(b) => setDetail(b)} />
      ))}
      {filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: 36, color: "rgba(255,255,255,0.35)", fontSize: 13, fontWeight: 500 }}>
          {query ? `No matches for "${query}" in today's guest list`
            : showOnlyCheckedIn ? "No one checked in yet — tap PENDING to see remaining guests"
            : "No guests for today"}
        </div>
      )}
    </div>
  );
}

const SRC_STYLES: Record<string, { label: string; color: string; bg: string; border: string }> = {
  swiggy:    { label: "SWIGGY",    color: "#FC8019", bg: "rgba(252,128,25,.18)", border: "rgba(252,128,25,.5)" },
  eazydiner: { label: "EAZYDINER", color: "#E73C7E", bg: "rgba(231,60,126,.18)", border: "rgba(231,60,126,.5)" },
  zomato:    { label: "ZOMATO",    color: "#E23744", bg: "rgba(226,55,68,.18)",  border: "rgba(226,55,68,.5)" },
  inhouse:   { label: "IN-HOUSE",  color: "rgba(255,255,255,.7)", bg: "rgba(255,255,255,.05)", border: "rgba(255,255,255,.18)" },
};

function ReassignModal({ reservation, bookedTableIds, agentName, onClose }: {
  reservation: HodTableReservation;
  bookedTableIds: Set<string>;
  agentName: string;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const sectionLabelOf = (sec?: string) => sec ? (SECTION_LABELS[sec] || sec) : "";

  const submit = async () => {
    if (!picked) { setErr("Pick a table"); return; }
    const t = ALL_TABLES.find((x) => x.id === picked);
    if (!t) { setErr("Invalid table"); return; }
    setBusy(true); setErr("");
    try {
      await reassignTable(reservation._docId, t.id, t.section, sectionLabelOf(t.section), agentName);
      onClose();
    } catch (e: any) { setErr(e?.message || "Failed"); setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.88)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0C0816", border: "1px solid rgba(200,166,69,0.35)", borderRadius: 18, padding: 22, width: "100%", maxWidth: 420, maxHeight: "85vh", overflow: "auto" }}>
        <div style={{ fontSize: 16, fontWeight: 900, color: "#C8A645", marginBottom: 4 }}>🔄 Reassign Table</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.55)", marginBottom: 14 }}>
          {reservation.customerName || "Guest"} · Currently: <b style={{ color: "#fff" }}>{reservation.tableId || "—"}</b>
        </div>

        <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 6, fontWeight: 700, letterSpacing: ".5px" }}>SELECT AVAILABLE TABLE</div>
        <select value={picked} onChange={(e) => setPicked(e.target.value)}
          style={{ width: "100%", padding: 12, borderRadius: 10, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 13, marginBottom: 14, outline: "none" }}>
          <option value="">Choose a table...</option>
          {ALL_TABLES.map((t) => {
            const isCurrent = t.id === reservation.tableId;
            const isBooked = bookedTableIds.has(t.id) && !isCurrent;
            return (
              <option key={t.id} value={t.id} disabled={isBooked} style={{ background: "#0C0816" }}>
                {t.name} — {sectionLabelOf(t.section)} ({t.capacity} seats){isCurrent ? " [Current]" : isBooked ? " [Booked]" : ""}
              </option>
            );
          })}
        </select>

        {err && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 10 }}>{err}</div>}

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} disabled={busy}
            style={{ flex: 1, padding: 12, borderRadius: 10, background: "transparent", border: "1px solid rgba(255,255,255,.15)", color: "rgba(255,255,255,.6)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={submit} disabled={busy || !picked}
            style={{ flex: 1, padding: 12, borderRadius: 10, background: picked ? "linear-gradient(135deg,#C8A645,#A07830)" : "rgba(242,199,68,.2)", border: "none", color: "#fff", fontSize: 13, fontWeight: 900, cursor: picked ? "pointer" : "not-allowed", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Reassigning..." : "Reassign"}
          </button>
        </div>
      </div>
    </div>
  );
}

const AGG_FILTERS: Array<{ key: string; label: string }> = [
  { key: "all",       label: "ALL" },
  { key: "inhouse",   label: "IN-HOUSE" },
  { key: "swiggy",    label: "SWIGGY" },
  { key: "eazydiner", label: "EAZYDINER" },
  { key: "zomato",    label: "ZOMATO" },
];

function TablesTab({ query, agentName, eventId, onShowQr }: { query: string; agentName: string; eventId: string; onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void }) {
  const { toast } = useToast();
  const [reservations, setReservations] = useState<HodTableReservation[]>([]);
  const [aggFilter, setAggFilter] = useState<string>("all");
  const [showOnlyArrived, setShowOnlyArrived] = useState(false);
  const [reassignFor, setReassignFor] = useState<HodTableReservation | null>(null);
  const [arrBusy, setArrBusy] = useState("");
  const [cancelBusy, setCancelBusy] = useState("");
  const today = TODAY_STR();
  const calToday = CALENDAR_TODAY_STR();

  useEffect(() => {
    // Subscribe to both the operational night date AND the calendar today date.
    // Before noon IST they differ: operational night = yesterday, calendar = today.
    // hodclub.in table reservations are written with the calendar date, so we
    // must merge both snapshots to avoid showing zero reservations before noon.
    const seen = new Map<string, HodTableReservation>();
    const merge = () => setReservations(Array.from(seen.values()));
    const unsub1 = subscribeToHodReservations(today, (rows) => {
      rows.forEach((r) => seen.set(r._docId || r.bookingRef || Math.random().toString(), r));
      // Remove any that belong to today's date range and were removed from snapshot
      for (const [k, v] of seen) { if ((v.date || "") === today && !rows.find((r) => (r._docId || r.bookingRef) === k)) seen.delete(k); }
      merge();
    });
    if (calToday === today) return unsub1;
    const unsub2 = subscribeToHodReservations(calToday, (rows) => {
      rows.forEach((r) => seen.set(r._docId || r.bookingRef || Math.random().toString(), r));
      for (const [k, v] of seen) { if ((v.date || "") === calToday && !rows.find((r) => (r._docId || r.bookingRef) === k)) seen.delete(k); }
      merge();
    });
    return () => { unsub1(); unsub2(); };
  }, [today, calToday]);

  const activeAll = reservations.filter((r) => (r as any).status !== "cancelled");
  // Tables are physical assets, not per-event — door staff need to see EVERY
  // reservation arriving tonight regardless of which event chip is selected.
  // The dual-date subscription above already constrains to tonight's window,
  // so we deliberately ignore the eventId filter here. (Reports
  // also ignores event when listing tables for the same reason.)
  void eventId;
  const active = activeAll;
  const bookedTableIds = new Set(active.map((r) => r.tableId).filter(Boolean) as string[]);

  // IN-HOUSE = anything that ISN'T a known aggregator (covers "inhouse", "online",
  // "walkin", "website", blank, legacy values from hodclub.in, etc.). Aggregator
  // chips still strict-match their key.
  const AGG_KEYS = new Set(["swiggy", "eazydiner", "zomato"]);
  const byAgg = aggFilter === "all"
    ? active
    : aggFilter === "inhouse"
      ? active.filter((r) => !AGG_KEYS.has((r.source || "").toLowerCase()))
      : active.filter((r) => (r.source || "").toLowerCase() === aggFilter);
  const byArrival = showOnlyArrived ? byAgg.filter((r) => r.actualArrivalTime) : byAgg;
  const filtered = byArrival.filter((r) => matchQuery(query, r.customerName, r.phone, r.tableId, r.bookingRef));

  const arrivedCount = active.filter((r) => r.actualArrivalTime).length;
  const totalGuests = active.reduce((s, r) => s + (r.partySize || 0), 0);

  const handleArrived = async (r: HodTableReservation) => {
    const src = (r.source || "inhouse").toLowerCase();
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
        toast({
          title: `Already arrived: ${r.customerName || "Guest"}`,
          description: `Marked ${arrTime} earlier — no new WhatsApp sent.`,
          duration: 4000,
        });
        setArrBusy("");
        return;
      }

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
        const fallbackText = `🪩 *Welcome to HOD!*\n\nHi *${customerName}*!\n\n📍 *${tableLabel} · ${floorLabel}* (booked via ${srcLabel})\n\n🍷 Browse menu & view your tab:\n${link}\n\nEnjoy your evening! 🌟`;

        if (phone.length !== 10) {
          // No phone at all — open the QR modal so the guest can scan to get their wallet
          await logNotificationOutcome(r.bookingRef, { status: "no_phone" });
          onShowQr({ bookingRef: r.bookingRef, walletUrl: link, customerName,
            reason: `No valid phone on file from ${srcLabel}. Show this QR to the guest instead.` });
        } else {
          // Send via Meta Cloud API (template → text). On failure show QR popup (NOT wa.me — tablet has no SIM).
          const result = await sendWhatsAppViaMeta({
            phone,
            template: { name: "table_ready", params: [customerName, tableLabel, floorLabel, link] },
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
              ? `Template "table_ready" not approved by Meta yet, and the guest is outside the 24h reply window.`
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
    if (!confirm(`Cancel table booking for ${r.customerName || "guest"}?`)) return;
    setCancelBusy(r._docId);
    try { await cancelTableReservation(r._docId, agentName); }
    catch (e: any) { alert("Failed: " + (e?.message || "")); }
    setCancelBusy("");
  };

  const handleWhatsapp = async (r: HodTableReservation) => {
    const phone = (r.phone || "").replace(/\D/g, "").slice(-10);
    const ref = r.bookingRef || "";
    const link = ref ? `https://hodclub.in/?wallet=${encodeURIComponent(ref)}` : "https://hodclub.in";
    const customerName = r.customerName || "Guest";
    const tableLabel = r.tableId || "your table";
    const floorLabel = r.floorLabel || "";
    const fallbackText = `🪩 *Your Table at HOD*\n\nHi *${customerName}*!\n\n📍 *${tableLabel} · ${floorLabel}* | 🕐 ${r.arrivalTime || ""}\n\n🍷 Browse menu & view your tab:\n${link}\n\nSee you tonight! 🌟`;
    if (phone.length !== 10) {
      if (ref) await logNotificationOutcome(ref, { status: "no_phone" });
      onShowQr({ bookingRef: ref, walletUrl: link, customerName,
        reason: "No valid phone on file. Show this QR to the guest instead." });
      return;
    }
    const result = await sendWhatsAppViaMeta({
      phone,
      template: { name: "table_ready", params: [customerName, tableLabel, floorLabel, link] },
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
        ? `Template "table_ready" not approved by Meta yet, and the guest is outside the 24h reply window.`
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
      {/* Stats — first two tiles toggle the arrival filter */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
        <div onClick={() => setShowOnlyArrived(false)}
          style={{ background: !showOnlyArrived ? "rgba(200,166,69,0.12)" : "rgba(255,255,255,.04)",
            border: `2px solid ${!showOnlyArrived ? "#C8A645" : "transparent"}`,
            borderRadius: 10, padding: 10, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 28, fontWeight: 900, color: "#F2C744" }}>{active.length}</div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "1.2px", textTransform: "uppercase", color: "rgba(255,255,255,0.5)" }}>Tables {!showOnlyArrived ? "•" : ""}</div>
        </div>
        <div onClick={() => setShowOnlyArrived(true)}
          style={{ background: showOnlyArrived ? "rgba(0,200,100,0.12)" : "rgba(255,255,255,.04)",
            border: `2px solid ${showOnlyArrived ? "#00C864" : "transparent"}`,
            borderRadius: 10, padding: 10, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 28, fontWeight: 900, color: "#00C864" }}>{arrivedCount}</div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "1.2px", textTransform: "uppercase", color: "rgba(255,255,255,0.5)" }}>Arrived {showOnlyArrived ? "•" : ""}</div>
        </div>
        <div style={{ background: "rgba(255,255,255,.04)", borderRadius: 10, padding: 10, textAlign: "center" }}>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 28, fontWeight: 900, color: "rgba(255,255,255,.6)" }}>{totalGuests}</div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "1.2px", textTransform: "uppercase", color: "rgba(255,255,255,0.5)" }}>Guests</div>
        </div>
      </div>

      {/* Aggregator chips */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {AGG_FILTERS.map((f) => {
          const on = aggFilter === f.key;
          const ss = f.key === "all" ? null : SRC_STYLES[f.key];
          return (
            <button key={f.key} onClick={() => setAggFilter(f.key)}
              style={{
                padding: "7px 14px", borderRadius: 20, fontSize: 11, fontWeight: 800, letterSpacing: "0.5px", cursor: "pointer",
                textTransform: "uppercase",
                background: "transparent",
                border: on ? (ss ? `2px solid ${ss.color}` : "2px solid #C8A645") : "1px solid rgba(255,255,255,0.1)",
                color: on ? (ss ? ss.color : "#C8A645") : "rgba(255,255,255,0.5)",
              }}>
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Cards */}
      {filtered.map((r) => {
        const src = (r.source || "inhouse").toLowerCase();
        const ss = SRC_STYLES[src] || SRC_STYLES.inhouse;
        const arrived = r.actualArrivalTime;
        const tableLabel = r.tableId || "(unassigned)";
        const isAggregator = src !== "inhouse";

        return (
          <div key={r._docId} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: "12px 14px", marginBottom: 10 }}>
            {/* Header row */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8, gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 14, fontWeight: 900, color: "#C8A645", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {tableLabel}
                  <span style={{ fontSize: 9, fontWeight: 900, letterSpacing: ".8px", padding: "2px 6px", borderRadius: 5, background: ss.bg, border: `1px solid ${ss.border}`, color: ss.color }}>{ss.label}</span>
                </div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,.4)", marginTop: 2 }}>{r.floorLabel || r.floor || ""}</div>
              </div>
              <div style={{ textAlign: "right", minWidth: 0, flex: "0 0 auto" }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>{r.customerName || "—"}</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,.45)" }}>{r.phone || "—"}</div>
              </div>
            </div>

            {/* Aggregator manual review banner */}
            {isAggregator && !r.tableId && (
              <div style={{ background: "rgba(255,200,0,.08)", border: "1px solid rgba(255,200,0,.35)", color: "#FFC800", fontSize: 11, fontWeight: 700, padding: "6px 10px", borderRadius: 8, marginBottom: 8 }}>
                ⚠️ Check {src === "zomato" ? "Zomato/District" : src} app for full details
              </div>
            )}

            {/* Meta row */}
            <div style={{ display: "flex", gap: 14, fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 10, flexWrap: "wrap" }}>
              <span>👥 {r.partySize || "?"}</span>
              <span>📅 {r.date}</span>
              <span>🕐 Expected: {r.arrivalTime || "—"}</span>
              {arrived && <span style={{ color: "#00C864", fontWeight: 700 }}>✓ Arrived: {arrived}</span>}
            </div>

            {/* Action row */}
            <div style={{ display: "grid", gridTemplateColumns: arrived ? "1fr 1fr 1fr 1fr" : "1.1fr 1fr 1fr 1fr 1fr", gap: 6 }}>
              {!arrived && (
                <button onClick={() => handleArrived(r)} disabled={arrBusy === r._docId}
                  style={{ padding: "9px 4px", borderRadius: 8, background: "linear-gradient(135deg,#B83227,#8B2520)", border: "none", color: "#fff", fontSize: 11, fontWeight: 900, cursor: "pointer" }}>
                  {arrBusy === r._docId ? "Marking…" : "🚶 Arrived"}
                </button>
              )}
              <button onClick={() => setReassignFor(r)}
                style={{ padding: "9px 4px", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.7)", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                🔄 Reassign
              </button>
              <button onClick={() => handleCall(r)}
                style={{ padding: "9px 4px", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.7)", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                📞 Call
              </button>
              <button onClick={() => handleWhatsapp(r)}
                style={{ padding: "9px 4px", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.7)", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                📲 WA
              </button>
              <button onClick={() => handleCancel(r)} disabled={cancelBusy === r._docId}
                style={{ padding: "9px 4px", borderRadius: 8, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#EF4444", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                {cancelBusy === r._docId ? "..." : "✕ Cancel"}
              </button>
            </div>
          </div>
        );
      })}
      {filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: "rgba(255,255,255,0.35)", fontSize: 13, fontWeight: 500 }}>
          {query ? `No matches for "${query}"` : aggFilter !== "all" ? `No ${aggFilter} tables today` : "No table reservations today"}
        </div>
      )}

      {reassignFor && (
        <ReassignModal reservation={reassignFor} bookedTableIds={bookedTableIds} agentName={agentName} onClose={() => setReassignFor(null)} />
      )}
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
function NewWalkInModal({ agentName, onClose }: { agentName: string; onClose: () => void }) {
  const [showAgg, setShowAgg] = useState(false);
  if (showAgg) {
    return <AddAggregatorBookingModal agentName={agentName} onClose={onClose} onBack={() => setShowAgg(false)} />;
  }
  return <UnifiedWalkInModal agentName={agentName} onClose={onClose} onAggregator={() => setShowAgg(true)} />;
}

type WalkInKind = "guestlist" | "onlyentry" | "cover" | "group";

// Tier presets mirror the hodclub.in modal exactly.
const TIER_PRICES: Record<"Stag" | "Couple" | "Ladies", { price: number; label: string; sub: string }> = {
  Stag:   { price: 500, label: "STAG",   sub: "1 Person · Cover Redeemable" },
  Couple: { price: 999, label: "COUPLE", sub: "2 Persons · Cover Redeemable" },
  Ladies: { price: 0,   label: "LADIES", sub: "Complimentary Entry" },
};

function UnifiedWalkInModal({
  agentName, onClose, onAggregator,
}: { agentName: string; onClose: () => void; onAggregator: () => void }) {
  // Default tab = Buy Covers (matches the screenshot's active state).
  const [kind, setKind] = useState<WalkInKind>("cover");

  // Shared identity fields persist across tab switches.
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const [tier, setTier] = useState<"Stag" | "Couple" | "Ladies">("Stag");
  const [tickets, setTickets] = useState(1);

  // Entry-Only flat price (₹500 default) and Group min-spend.
  const [entryPrice, setEntryPrice] = useState(500);
  const [partySize, setPartySize] = useState(4);
  const [tableType, setTableType] = useState<"Standard" | "VIP">("Standard");
  const [groupMinSpend, setGroupMinSpend] = useState(15000);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ ref: string } | null>(null);

  const [events, setEvents] = useState<HodEvent[]>([]);
  const [eventId, setEventId] = useState<string>("");
  useEffect(() => {
    const unsub = subscribeToHodEvents((all) => {
      setEvents(all);
      const today = TODAY_STR();
      const tonight = all.filter((e) => (e.date || "") === today);
      if (tonight.length === 1) setEventId(tonight[0].id);
    });
    return unsub;
  }, []);

  // ── Derived totals ────────────────────────────────────────────────────────
  // Buy Covers: tier price × tickets (Ladies always free regardless of qty).
  // Entry Only: entryPrice × tickets.
  // Guest List: free.
  // Group: min spend / deposit (single line item).
  const unit =
    kind === "cover" ? TIER_PRICES[tier].price :
    kind === "onlyentry" ? entryPrice :
    kind === "group" ? groupMinSpend : 0;
  const qty = kind === "group" ? 1 : tickets;
  const total = Math.max(0, unit * qty);
  const eventTitle = events.find((e) => e.id === eventId)?.title || "";

  const guestsForFlow =
    kind === "cover" ? (tier === "Couple" ? tickets * 2 : tickets) :
    kind === "group" ? partySize :
    tickets;

  const submit = async () => {
    setErr("");
    if (!name.trim()) { setErr("Enter guest name"); return; }
    const cleanPhone = phone.replace(/\D/g, "");
    if (cleanPhone.length < 10) { setErr("Enter a 10-digit phone number"); return; }
    setBusy(true);
    try {
      if (kind === "guestlist") {
        const r = await createWalkInGuestlistEntry({
          name, email, phone, eventId, eventTitle,
          type: tier.toLowerCase(),
          staffName: agentName,
        });
        setDone({ ref: r.ref });
      } else {
        const r = await createWalkInTicketBooking({
          kind: kind === "group" ? "group" : kind === "onlyentry" ? "onlyentry" : "cover",
          name, email, phone,
          guests: guestsForFlow,
          total,
          tier: kind === "cover" ? tier : "",
          type: kind === "cover" ? tier.toLowerCase() : kind,
          eventId, eventTitle,
          partySize: kind === "group" ? partySize : undefined,
          tableType: kind === "group" ? tableType : undefined,
          notes: "",
          staffName: agentName,
        });
        setDone({ ref: r.ref });
      }
    } catch (e: any) {
      setErr(e?.message || "Could not save booking");
    } finally {
      setBusy(false);
    }
  };

  const ctaLabel =
    kind === "guestlist" ? "✓ Add to Guest List" :
    total === 0 ? "✓ Confirm (No Charge)" :
    `💵 Collect ₹${total.toLocaleString("en-IN")} & Confirm`;

  // ── Reusable styles ──────────────────────────────────────────────────────
  const lbl: React.CSSProperties = { fontSize: 10, fontWeight: 800, color: "rgba(200,166,69,0.85)", letterSpacing: 1.2, marginBottom: 8 };
  const inp: React.CSSProperties = { width: "100%", padding: "13px 14px", borderRadius: 10, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" };

  // Big 2×2 category card — yellow filled when active, dark+border when not.
  const catCard = (active: boolean, mini = false): React.CSSProperties => ({
    padding: mini ? "12px 10px" : "16px 12px",
    borderRadius: 12,
    border: active ? "2px solid #C8A645" : "1.5px solid rgba(255,255,255,.1)",
    background: active ? "linear-gradient(160deg,rgba(242,199,68,.18),rgba(242,199,68,.06))" : "rgba(255,255,255,.025)",
    cursor: "pointer", color: "#fff", fontFamily: "inherit",
    textAlign: "center", transition: "transform .12s, border-color .12s",
  });

  // Done screen (success confirmation, unchanged).
  if (done) {
    return (
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", backdropFilter: "blur(8px)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
        <div onClick={(e) => e.stopPropagation()} style={{ background: "#0C0816", border: "1.5px solid #C8A645", borderRadius: 22, padding: 28, width: "100%", maxWidth: 380, textAlign: "center" }}>
          <div style={{ fontSize: 64, marginBottom: 10 }}>✅</div>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 24, fontWeight: 900, color: "#C8A645", marginBottom: 6 }}>Booking Confirmed</div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,.7)", marginBottom: 4 }}>{name}</div>
          <div style={{ fontSize: 11, fontFamily: "monospace", color: "rgba(255,255,255,.5)", marginBottom: 18 }}>{done.ref}</div>
          <button onClick={onClose} style={{ width: "100%", padding: 14, borderRadius: 12, background: "linear-gradient(135deg,#C8A645,#A07830)", border: "none", color: "#0a0a0a", fontSize: 14, fontWeight: 900, cursor: "pointer" }}>Done</button>
        </div>
      </div>
    );
  }

  // ── Main sheet ────────────────────────────────────────────────────────────
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.88)", backdropFilter: "blur(8px)", zIndex: 9999, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0C0816", border: "1.5px solid rgba(200,166,69,0.45)", borderRadius: 22, padding: 18, width: "100%", maxWidth: 440, marginTop: 24, marginBottom: 24, boxShadow: "0 24px 48px rgba(0,0,0,.7)" }}>
        {/* Close button (top-right only — no title bar; the cards ARE the title) */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "rgba(255,255,255,.55)", fontSize: 22, cursor: "pointer", lineHeight: 1, padding: 4 }}>✕</button>
        </div>

        {/* 2×2 CATEGORY GRID — matches hodclub.in modal exactly */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
          <button onClick={() => setKind("guestlist")} style={catCard(kind === "guestlist")}>
            <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: .8, color: kind === "guestlist" ? "#C8A645" : "rgba(255,255,255,.85)" }}>GUEST LIST</div>
            <div style={{ fontSize: 9.5, marginTop: 4, color: "rgba(252,165,165,.85)", fontWeight: 700, letterSpacing: .8 }}>CLOSED · 8PM</div>
          </button>
          <button onClick={() => setKind("onlyentry")} style={catCard(kind === "onlyentry")}>
            <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: .8, color: kind === "onlyentry" ? "#C8A645" : "rgba(255,255,255,.85)" }}>ENTRY ONLY</div>
            <div style={{ fontSize: 9.5, marginTop: 4, color: "rgba(255,255,255,.5)", fontWeight: 700, letterSpacing: .8 }}>ENTRY AFTER 11:30PM</div>
          </button>
          <button onClick={() => setKind("cover")} style={catCard(kind === "cover")}>
            <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: .8, color: kind === "cover" ? "#C8A645" : "rgba(255,255,255,.85)" }}>BUY COVERS</div>
            <div style={{ fontSize: 9.5, marginTop: 4, color: "rgba(255,255,255,.5)", fontWeight: 700, letterSpacing: .8 }}>REDEEMABLE F&amp;B</div>
          </button>
          <button onClick={() => setKind("group")} style={catCard(kind === "group")}>
            <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: .8, color: kind === "group" ? "#C8A645" : "rgba(255,255,255,.85)" }}>VIP TABLES / GROUP</div>
            <div style={{ fontSize: 9.5, marginTop: 4, color: "rgba(255,255,255,.5)", fontWeight: 700, letterSpacing: .8 }}>FULLY REDEEMABLE</div>
          </button>
        </div>

        {/* Reassuring caption */}
        <div style={{ fontSize: 11.5, color: "rgba(0,200,100,.95)", marginBottom: 16, fontWeight: 600 }}>
          ✅ Skip the queue · Cover charge 100% redeemable on F&amp;B
        </div>

        {/* Optional event picker (door-only, not in customer modal) */}
        {events.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={lbl}>EVENT</div>
            <select value={eventId} onChange={(e) => setEventId(e.target.value)} style={inp}>
              <option value="">— No event —</option>
              {events.slice(0, 12).map((e) => (
                <option key={e.id} value={e.id}>{e.title}{e.date ? ` · ${e.date}` : ""}</option>
              ))}
            </select>
          </div>
        )}

        {/* ENTRY TYPE — three pricing cards (cover + guestlist) */}
        {(kind === "cover" || kind === "guestlist") && (
          <div style={{ marginBottom: 16 }}>
            <div style={lbl}>ENTRY TYPE</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {(["Stag", "Couple", "Ladies"] as const).map((t) => {
                const active = tier === t;
                const tp = TIER_PRICES[t];
                const isFree = tp.price === 0 || kind === "guestlist";
                return (
                  <button key={t} onClick={() => setTier(t)} style={{
                    padding: "12px 8px", borderRadius: 10,
                    border: active ? "2px solid #C8A645" : "1.5px solid rgba(255,255,255,.1)",
                    background: active ? "linear-gradient(160deg,rgba(242,199,68,.16),rgba(242,199,68,.04))" : "rgba(255,255,255,.025)",
                    cursor: "pointer", color: "#fff", fontFamily: "inherit", textAlign: "center",
                  }}>
                    <div style={{ fontWeight: 900, fontSize: 12, color: active ? "#C8A645" : "#fff", letterSpacing: .6 }}>{tp.label}</div>
                    <div style={{ fontSize: 14, fontWeight: 900, color: isFree ? "#00C864" : "#F2C744", marginTop: 4 }}>
                      {isFree ? "FREE" : `₹${tp.price}`}
                    </div>
                    <div style={{ fontSize: 8.5, color: "rgba(255,255,255,.5)", marginTop: 3, lineHeight: 1.3 }}>
                      {kind === "guestlist" ? "Complimentary entry" : tp.sub}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Entry-Only price + Group fields */}
        {kind === "onlyentry" && (
          <div style={{ marginBottom: 16 }}>
            <div style={lbl}>PRICE PER ENTRY (₹)</div>
            <input type="number" min={0} step={50} value={entryPrice}
              onChange={(e) => setEntryPrice(Math.max(0, parseInt(e.target.value || "0")))} style={inp} />
          </div>
        )}
        {kind === "group" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
              <div>
                <div style={lbl}>PARTY SIZE</div>
                <input type="number" min={2} max={50} value={partySize}
                  onChange={(e) => setPartySize(Math.max(2, parseInt(e.target.value || "2")))} style={inp} />
              </div>
              <div>
                <div style={lbl}>TABLE</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  {(["Standard", "VIP"] as const).map((t) => {
                    const active = tableType === t;
                    return (
                      <button key={t} onClick={() => setTableType(t)} style={{
                        padding: "13px 8px", borderRadius: 10, fontSize: 12, fontWeight: 800, cursor: "pointer",
                        border: active ? "2px solid #C8A645" : "1px solid rgba(255,255,255,.12)",
                        background: active ? "linear-gradient(135deg,#C8A645,#A07830)" : "rgba(255,255,255,.04)",
                        color: active ? "#0a0a0a" : "rgba(255,255,255,.75)",
                      }}>{t}</button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={lbl}>MIN SPEND / DEPOSIT (₹)</div>
              <input type="number" min={0} step={500} value={groupMinSpend}
                onChange={(e) => setGroupMinSpend(Math.max(0, parseInt(e.target.value || "0")))} style={inp} />
            </div>
          </>
        )}

        {/* ── ENTER YOUR DETAILS ─────────────────────────────────────────── */}
        <div style={lbl}>ENTER YOUR DETAILS</div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ ...lbl, fontSize: 9.5, marginBottom: 6 }}>FULL NAME</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your full name" style={inp} autoFocus />
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ ...lbl, fontSize: 9.5, marginBottom: 6 }}>EMAIL ADDRESS</div>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your@email.com" type="email" style={inp} />
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ ...lbl, fontSize: 9.5, marginBottom: 6 }}>PHONE NUMBER</div>
          <div style={{ display: "flex", alignItems: "stretch" }}>
            <div style={{
              padding: "13px 12px", borderRadius: "10px 0 0 10px",
              background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)", borderRight: "none",
              color: "rgba(255,255,255,.6)", fontSize: 14, fontWeight: 700,
            }}>+91</div>
            <input value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
              placeholder="XXXXX XXXXX" type="tel" inputMode="numeric"
              style={{ ...inp, borderRadius: "0 10px 10px 0" }} />
          </div>
        </div>

        {/* ── NUMBER OF TICKETS stepper (hidden for Group) ────────────────── */}
        {kind !== "group" && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ ...lbl, fontSize: 9.5, marginBottom: 6 }}>
              NUMBER OF {kind === "cover" ? "TICKETS" : kind === "onlyentry" ? "PASSES" : "GUESTS"}
            </div>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "8px 8px", borderRadius: 10,
              background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)",
            }}>
              <button onClick={() => setTickets(Math.max(1, tickets - 1))} style={{
                width: 38, height: 38, borderRadius: 8, border: "1px solid rgba(255,255,255,.15)",
                background: "rgba(255,255,255,.04)", color: "#fff", fontSize: 18, cursor: "pointer",
              }}>−</button>
              <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 900, color: "#fff" }}>{tickets}</div>
              <button onClick={() => setTickets(Math.min(20, tickets + 1))} style={{
                width: 38, height: 38, borderRadius: 8, border: "1px solid rgba(242,199,68,.4)",
                background: "rgba(200,166,69,0.12)", color: "#C8A645", fontSize: 18, fontWeight: 900, cursor: "pointer",
              }}>+</button>
            </div>
          </div>
        )}

        {/* ── Total Amount summary (hidden when total = 0) ─────────────────── */}
        {total > 0 && (
          <div style={{
            background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)",
            borderRadius: 10, padding: "12px 14px", marginBottom: 14,
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,.85)", fontWeight: 700 }}>Total Amount</div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,.45)", marginTop: 2 }}>
                {kind === "group" ? "Min spend / deposit" : `${qty} × ₹${unit.toLocaleString("en-IN")}`}
              </div>
            </div>
            <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 900, color: "#F2C744" }}>
              ₹{total.toLocaleString("en-IN")}
            </div>
          </div>
        )}

        {err && <div style={{ background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.3)", color: "#FCA5A5", padding: 10, borderRadius: 10, fontSize: 12, marginBottom: 12 }}>{err}</div>}

        {/* CTA — single full-width yellow button */}
        <button onClick={submit} disabled={busy} style={{
          width: "100%", padding: 16, borderRadius: 12,
          background: busy ? "rgba(242,199,68,.4)" : "linear-gradient(135deg,#C8A645,#A07830)",
          border: "none", color: "#0a0a0a", fontSize: 14, fontWeight: 900,
          cursor: busy ? "wait" : "pointer", letterSpacing: .3,
          boxShadow: busy ? "none" : "0 6px 18px rgba(242,199,68,.35)",
        }}>
          {busy ? "Saving…" : ctaLabel}
        </button>

        {/* Door-only escape hatch to the aggregator manual-entry flow */}
        <button onClick={onAggregator} style={{
          marginTop: 12, width: "100%", padding: 10, borderRadius: 10,
          background: "transparent", border: "1px dashed rgba(255,255,255,.18)",
          color: "rgba(255,255,255,.55)", fontSize: 11, fontWeight: 700, cursor: "pointer", letterSpacing: .5,
        }}>
          📲 Aggregator booking (Zomato · Swiggy · EazyDiner) →
        </button>

        <div style={{ marginTop: 12, textAlign: "center", fontSize: 10, color: "rgba(255,255,255,.35)" }}>
          Logged by <b style={{ color: "rgba(242,199,68,.7)" }}>{agentName}</b> · {getOperationalNightStr()}
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

  const lbl = { fontSize: 10, fontWeight: 800, letterSpacing: ".5px", color: "rgba(255,255,255,.55)", marginBottom: 4 } as const;
  const inp = { width: "100%", padding: 10, borderRadius: 9, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.88)", backdropFilter: "blur(8px)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0C0816", border: "1px solid rgba(242,199,68,.35)", borderRadius: 18, padding: 22, width: "100%", maxWidth: 440, maxHeight: "90vh", overflow: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <button onClick={onBack} style={{ background: "transparent", border: "none", color: "rgba(255,255,255,.5)", fontSize: 18, cursor: "pointer", padding: 0 }}>←</button>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 18, fontWeight: 900, color: "#C8A645" }}>📲 Add Aggregator Booking</div>
        </div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginBottom: 16 }}>
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
            <span style={{ marginLeft: 8, color: bookedTableIds.size > 0 ? "#FCA5A5" : "rgba(255,255,255,.4)", fontWeight: 700 }}>
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
                  style={taken ? { color: "#888", background: "#1a1a1a" } : undefined}>
                  {taken ? "🔒 " : ""}{t.id} · {t.name} · {SECTION_LABELS[t.section] || t.section} · {t.capacity} seats{t.isVIP ? " · VIP" : ""}{taken ? ` — ${why}` : ""}
                </option>
              );
            })}
          </select>
          {tableId && bookedTableIds.has(tableId) && (
            <div style={{ marginTop: 6, fontSize: 11, color: "#FCA5A5" }}>⚠️ Just got booked by someone else — pick another</div>
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

        {err && <div style={{ background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.3)", color: "#FCA5A5", padding: 10, borderRadius: 8, fontSize: 12, marginBottom: 10 }}>{err}</div>}

        <button onClick={submit} disabled={busy}
          style={{ width: "100%", padding: 14, borderRadius: 11, background: busy ? "rgba(242,199,68,.3)" : "linear-gradient(135deg,#C8A645,#A07830)", border: "none", color: "#0C0816", fontSize: 14, fontWeight: 900, cursor: busy ? "wait" : "pointer", letterSpacing: ".5px" }}>
          {busy ? "Adding..." : "✓ Add Booking"}
        </button>
        <button onClick={onClose} style={{ width: "100%", marginTop: 8, padding: 11, borderRadius: 9, background: "transparent", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.5)", fontSize: 12, cursor: "pointer" }}>Cancel</button>
      </div>
    </div>
  );
}

function DoorDashboard({ agentName, onLogout }: { agentName: string; onLogout: () => void }) {
  const [tab, setTab] = useState<"tickets" | "guestlist" | "tables" | "group" | "onlyentry">("tickets");
  const [qrModal, setQrModal] = useState<{ bookingRef: string; walletUrl: string; customerName: string; reason: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [walkInOpen, setWalkInOpen] = useState(false);
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
  const [events, setEvents] = useState<HodEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>("all");

  // Persist agent name as door staff in sessionStorage so check-ins pick it up too
  useEffect(() => {
    sessionStorage.setItem("hod_door_staff", agentName);
  }, [agentName]);

  useEffect(() => {
    const unsub = subscribeToHodEvents((all) => setEvents(all));
    return unsub;
  }, []);

  const today = TODAY_STR();
  // Tonight's events first, then upcoming (next 7 days), capped at 5 chips total
  const tonight = events.filter((e) => (e.date || "") === today);
  const upcoming = events.filter((e) => (e.date || "") > today).slice(0, Math.max(0, 5 - tonight.length));
  const eventChips = [...tonight, ...upcoming];

  // Auto-select tonight's event if exactly one
  useEffect(() => {
    if (selectedEventId === "all" && tonight.length === 1) setSelectedEventId(tonight[0].id);
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
      if (b) setScanDetail(b);
      else alert("No booking found for this QR code");
    } catch { alert("Lookup failed"); }
  };

  const tabs = [
    { key: "tickets" as const,   label: "TICKETS",        icon: "" },
    { key: "guestlist" as const, label: "GUEST LIST",     icon: "" },
    { key: "tables" as const,    label: "TABLES",         icon: "" },
    { key: "group" as const,     label: "GROUP",          icon: "" },
    { key: "onlyentry" as const, label: "ENTRY PASS",     icon: "" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#0A0A0A", color: "#fff" }}>
      <div style={{ background: "#0A0A0A", borderBottom: "2px solid #C8A645", padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <Link href="/"
            style={{ padding: "8px 12px", borderRadius: 6, background: "#C8A645", border: "1.5px solid #C8A645", color: "#0A0A0A", fontSize: 12, fontWeight: 900, cursor: "pointer", textDecoration: "none", whiteSpace: "nowrap", letterSpacing: .3 }}>
            ← POS
          </Link>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 900, color: "#C8A645", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: -.5 }}>
            Door
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <span style={{ fontFamily: "'Inter',system-ui,sans-serif", fontSize: 12, color: "rgba(255,255,255,0.7)", fontWeight: 800 }}>{agentName}</span>
          <button onClick={onLogout}
            style={{ padding: "8px 12px", borderRadius: 10, background: "transparent", border: "1.5px solid rgba(239,68,68,.5)", color: "#EF4444", fontSize: 11, fontWeight: 800, cursor: "pointer", letterSpacing: .3 }}>
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
            style={{ width: "100%", padding: "13px 16px", borderRadius: 10, background: "#0A0A0A", border: "2px solid #C8A645", color: "#fff", fontSize: 14, outline: "none", boxSizing: "border-box", textAlign: "center" }}
          />
          {searchInput && (
            <button onClick={() => setSearchInput("")}
              style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", padding: "4px 10px", borderRadius: 8, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.12)", color: "rgba(255,255,255,.6)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              ✕ Clear
            </button>
          )}
        </div>

        {/* Action row: Scan + New Walk-in */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
          <button onClick={() => setScanning(true)}
            style={{ padding: 14, borderRadius: 10, background: "transparent", border: "2px solid #C8A645", color: "#C8A645", fontSize: 13, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.5px", cursor: "pointer" }}>
            Scan QR
          </button>
          <button onClick={() => setWalkInOpen(true)}
            style={{ padding: 14, borderRadius: 10, background: "#C8A645", border: "none", color: "#0A0A0A", fontSize: 13, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.5px", cursor: "pointer" }}>
            New Walk-in
          </button>
        </div>

        {lookupResult && (
          <LookupResult booking={lookupResult} agentName={agentName} onDone={() => setLookupResult(null)} />
        )}

        {/* 🔎 Cross-collection Find Booking results (walk-up reservations) */}
        {searchInput.trim().length >= 2 && !lookupResult && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,.4)", letterSpacing: 1, marginBottom: 6, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>🔎 FIND BOOKING (ALL DATES)</span>
              {crossLoading && <span style={{ color: "rgba(242,199,68,.7)", fontWeight: 600 }}>searching…</span>}
            </div>
            {!crossLoading && crossResults.length === 0 && (
              <div style={{ background: "rgba(255,255,255,.03)", border: "1px dashed rgba(255,255,255,.08)", borderRadius: 10, padding: 10, fontSize: 11, color: "rgba(255,255,255,.45)" }}>
                No bookings or aggregator reservations match "{searchInput.trim()}".
              </div>
            )}
            {crossResults.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {crossResults.map((r) => {
                  const isAgg = r._src === "aggregator";
                  return (
                    <button key={`${r._src}-${r.id}`} onClick={() => setLookupResult(r)}
                      style={{ textAlign: "left", padding: "10px 12px", borderRadius: 10,
                        background: isAgg ? "rgba(168,85,247,.06)" : "rgba(96,165,250,.06)",
                        border: `1px solid ${isAgg ? "rgba(168,85,247,.25)" : "rgba(96,165,250,.25)"}`,
                        color: "#fff", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 800, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.name || "(no name)"} <span style={{ color: "rgba(255,255,255,.4)", fontWeight: 500, fontSize: 11 }}>· {r.phone || "no phone"}</span>
                        </div>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,.55)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.eventTitle || r.ref}
                        </div>
                      </div>
                      <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 10,
                        background: isAgg ? "rgba(168,85,247,.15)" : "rgba(96,165,250,.15)",
                        color: isAgg ? "#A855F7" : "#60A5FA",
                        border: `1px solid ${isAgg ? "rgba(168,85,247,.4)" : "rgba(96,165,250,.4)"}` }}>
                        {isAgg ? (r._aggregator || "AGG").toUpperCase() : "BOOKING"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Event selector chips */}
        {eventChips.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#C8A645", letterSpacing: "1.2px", textTransform: "uppercase", marginBottom: 6 }}>EVENT</div>
            <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, scrollbarWidth: "none" }}>
              <button onClick={() => setSelectedEventId("all")}
                style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 20, fontSize: 11, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap",
                  textTransform: "uppercase", letterSpacing: "0.5px",
                  background: selectedEventId === "all" ? "transparent" : "transparent",
                  border: `2px solid ${selectedEventId === "all" ? "#C8A645" : "rgba(255,255,255,0.1)"}`,
                  color: selectedEventId === "all" ? "#C8A645" : "rgba(255,255,255,0.5)" }}>
                ALL
              </button>
              {eventChips.map((ev) => {
                const on = selectedEventId === ev.id;
                const isTonight = ev.date === today;
                const d = ev.date ? new Date(ev.date + "T00:00:00") : null;
                const dateLabel = isTonight ? "Tonight" : (d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "");
                const title = (ev.title || "Event").length > 18 ? (ev.title || "").slice(0, 18) + "…" : (ev.title || "Event");
                return (
                  <button key={ev.id} onClick={() => setSelectedEventId(ev.id)}
                    style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 20, fontSize: 11, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap",
                      textTransform: "uppercase", letterSpacing: "0.5px",
                      background: on ? "transparent" : "transparent",
                      border: `2px solid ${on ? "#C8A645" : "rgba(255,255,255,0.1)"}`,
                      color: on ? "#C8A645" : "rgba(255,255,255,0.5)" }}>
                    {title}<span style={{ opacity: .55, marginLeft: 6, fontWeight: 500 }}>· {dateLabel}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 6, marginBottom: 14, overflowX: "auto", paddingBottom: 4, scrollbarWidth: "none" }}>
          {tabs.map((t) => {
            const on = tab === t.key;
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                style={{ flexShrink: 0, padding: "12px 8px", borderRadius: 8, fontSize: 13, fontWeight: 900, cursor: "pointer", whiteSpace: "nowrap",
                  letterSpacing: "0.8px", textTransform: "uppercase", border: "none",
                  background: on ? "#C8A645" : "#5C2525",
                  color: on ? "#0A0A0A" : "#FFFFFF" }}>
                {t.label}
              </button>
            );
          })}
        </div>

        {tab === "tickets"   && <TicketsTab        agentName={agentName} query={searchInput} eventId={selectedEventId} onCover={setCoverFor} onShowQr={setQrModal} />}
        {tab === "guestlist" && <GuestlistTab      agentName={agentName} query={searchInput} eventId={selectedEventId} onCover={setCoverFor} onShowQr={setQrModal} />}
        {tab === "tables"    && <TablesTab         agentName={agentName} query={searchInput} eventId={selectedEventId} onShowQr={setQrModal} />}
        {tab === "group"     && <GroupBookingsTab  agentName={agentName} query={searchInput} eventId={selectedEventId} onCover={setCoverFor} onShowQr={setQrModal} />}
        {tab === "onlyentry" && <OnlyEntryTab      agentName={agentName} query={searchInput} eventId={selectedEventId} onCover={setCoverFor} onShowQr={setQrModal} />}
      </div>

      {scanning && <QrScanner onResult={handleQrResult} onClose={() => setScanning(false)} />}
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
      {walkInOpen && <NewWalkInModal agentName={agentName} onClose={() => setWalkInOpen(false)} />}
      {coverFor && <CoverActivationModal booking={coverFor} agentName={agentName} onClose={() => setCoverFor(null)} />}
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

export default function DoorMode() {
  const [agentName, setAgentName] = useState<string | null>(() => {
    if (sessionStorage.getItem("hod_door_auth") === "1") return sessionStorage.getItem("hod_door_name") || null;
    return null;
  });

  if (!agentName) return <DoorLogin onLogin={setAgentName} />;
  return <DoorDashboard agentName={agentName} onLogout={() => { sessionStorage.removeItem("hod_door_auth"); setAgentName(null); }} />;
}
