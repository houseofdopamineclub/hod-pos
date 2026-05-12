import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import {
  sha256, lookupBooking, subscribeToBookings, subscribeToGuestlist,
  subscribeToHodReservations, checkInGuest, reassignTable, cancelTableReservation,
  ensureZeroBalanceCoverForGuest,
  subscribeToHodEvents, type HodEvent,
  getCoverForBooking, activateCoverForBooking, editCoverAmount,
  ensureCoverForAggregatorArrival, createAggregatorTableBooking,
  AGGREGATOR_OPTIONS, getAggregatorDiscount, recordWalkInDiscountOverride,
  logNotificationOutcome, subscribeToWalletScan,
  searchBookingsAndAggregators, type CrossSourceBooking,
  type HodBooking, type HodGuestlistEntry, type HodTableReservation, type HodCover,
} from "@/lib/firestore-hod";

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
import { getOperationalNightStr } from "@/lib/utils-pos";
import { unmarkGuestArrived, markGuestArrived } from "@/lib/firestore-hod";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";

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
    <div style={{ minHeight: "100vh", background: "#030305", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 20, padding: "32px 28px", width: "100%", maxWidth: 360, textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🚪</div>
        <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 20, fontWeight: 900, color: "#C9A84C", marginBottom: 6 }}>Door Agent Login</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginBottom: 24 }}>HOD — House of Dopamine</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name"
          style={{ width: "100%", padding: "14px 16px", borderRadius: 12, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 15, outline: "none", marginBottom: 10, boxSizing: "border-box" }} />
        <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder="Enter door password"
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

function QrScanner({ onResult, onClose }: { onResult: (data: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanRef = useRef(true);

  useEffect(() => {
    let raf = 0;
    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        if ("BarcodeDetector" in window) {
          const detector = new (window as any).BarcodeDetector({ formats: ["qr_code"] });
          const scan = async () => {
            if (!scanRef.current || !videoRef.current) return;
            try {
              const codes = await detector.detect(videoRef.current);
              if (codes.length > 0) { scanRef.current = false; onResult(codes[0].rawValue); return; }
            } catch {}
            raf = requestAnimationFrame(scan);
          };
          scan();
        }
      } catch {}
    };
    start();
    return () => { scanRef.current = false; cancelAnimationFrame(raf); streamRef.current?.getTracks().forEach((t) => t.stop()); };
  }, [onResult]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.95)", zIndex: 9999, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", width: "100%", maxWidth: 360, aspectRatio: "1", borderRadius: 20, overflow: "hidden", border: "3px solid rgba(201,168,76,.4)" }}>
        <video ref={videoRef} style={{ width: "100%", height: "100%", objectFit: "cover" }} playsInline muted />
        <div style={{ position: "absolute", inset: "20%", border: "3px solid rgba(201,168,76,.6)", borderRadius: 16, pointerEvents: "none" }} />
      </div>
      <div style={{ color: "rgba(255,255,255,.5)", fontSize: 13, marginTop: 16 }}>Point camera at QR code</div>
      <button onClick={onClose}
        style={{ marginTop: 20, padding: "12px 28px", borderRadius: 12, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.1)", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
        Close Scanner
      </button>
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
    setBusy(true);
    try {
      const { cover } = await activateCoverForBooking({ booking, amount: amt, paymentMethod: method, paymentSplit, staffName: agentName });
      setExisting(cover);
      const diff = amt - paidOnline;
      const collectMsg = method === "split"
        ? `\n\nCollect: ${paymentSplit?.cash ? `₹${paymentSplit.cash} cash ` : ""}${paymentSplit?.upi ? `+ ₹${paymentSplit.upi} UPI ` : ""}${paymentSplit?.card ? `+ ₹${paymentSplit.card} card` : ""}`.trim()
        : diff > 0 ? `\n\nCollect ₹${diff} ${method === "cash" ? "cash" : method === "upi" ? "UPI" : "card"}.` : "";
      // Just show success — user can hit the "📲 Send WhatsApp Wallet Link" button below if they want to message the customer
      alert(`✅ Cover ₹${amt} activated for ${booking.name || "guest"}.${collectMsg}`);
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
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0C0816", border: "1px solid rgba(201,168,76,.3)", borderRadius: 18, padding: 22, width: "100%", maxWidth: 380, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#C9A84C", letterSpacing: 1.5, marginBottom: 10 }}>💰 COVER CHARGE</div>
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
                  <div style={{ fontSize: 16, fontWeight: 900, color: "#C9A84C" }}>₹{(existing.coverActivated || 0).toLocaleString("en-IN")}</div>
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
              style={{ width: "100%", padding: 11, borderRadius: 10, background: "rgba(37,211,102,.1)", border: "1px solid rgba(37,211,102,.35)", color: "#25D366", fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 8 }}>
              📲 Send WhatsApp Wallet Link
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
                { id: "card" as const, label: "💳 Card", color: "#A855F7" },
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

            <button onClick={handleActivate} disabled={busy}
              style={{ width: "100%", padding: 14, borderRadius: 12, background: "linear-gradient(135deg,#C9A84C,#A07830)", border: "none", color: "#000", fontSize: 14, fontWeight: 900, cursor: "pointer", marginBottom: 8 }}>
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
    <div style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(201,168,76,.3)", borderRadius: 16, padding: 20, marginBottom: 16 }}>
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
        {booking.type && <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)" }}>Type: <span style={{ color: "#C9A84C", fontWeight: 700 }}>{booking.type}</span></div>}
        {booking.tier && <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)" }}>Tier: <span style={{ color: "#C9A84C", fontWeight: 700 }}>{booking.tier}</span></div>}
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
        style={{ background: "linear-gradient(180deg,#0e0e14,#070710)", border: "1.5px solid rgba(201,168,76,.3)", borderRadius: 18, padding: 22, width: "100%", maxWidth: 380, color: "#fff", textAlign: "center" }}>

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
            <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 20, fontWeight: 800, color: "#C9A84C", marginBottom: 6 }}>
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
      const r = await fetch("/api/whatsapp/send-template", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: digits, template: opts.template.name,
          language: opts.template.language || "en", params: opts.template.params,
        }),
      });
      const data = await r.json();
      if (r.ok && data.ok) return { ok: true, via: "template" };
      console.warn("[door][wa] template send failed, trying text:", data);
    } catch (e) { console.warn("[door][wa] template request error", e); }
  }

  // 2) Free-form text (only delivered if customer messaged HOD in last 24h)
  try {
    const r = await fetch("/api/whatsapp/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: digits, message: opts.fallbackText }),
    });
    const data = await r.json();
    if (r.ok && data.ok) return { ok: true, via: "text" };
    return { ok: false, error: data.error || "Send failed", code: data.code };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Network error" };
  }
}

// Booking 📲: try Meta template `wallet_ready` → text → QR popup. Tablets have
// no SIM so wa.me is removed entirely. Outcome is logged to covers/{ref}.
async function sendBookingWhatsApp(
  b: HodBooking,
  onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void,
) {
  const phone = (b.phone || "").replace(/\D/g, "").slice(-10);
  const ref = b.ref || b.id;
  const link = `https://hodclub.in/?wallet=${encodeURIComponent(ref)}`;
  const customerName = b.name || "Guest";
  const eventTitle = b.eventTitle || "tonight";
  const guests = String(b.guests || 1);
  const fallbackText = `Hi ${customerName}! 🎉\n\nYour HOD ${b._isGuestList ? "guest list pass" : "ticket"} for ${eventTitle} is confirmed.\n\n🎫 Ref: ${ref}\n👥 Guests: ${guests}\n\n📲 Show this at the door:\n${link}\n\nHouse of Dopamine | Koramangala 🎵`;
  if (phone.length !== 10) {
    if (ref) await logNotificationOutcome(ref, { status: "no_phone" });
    onShowQr({ bookingRef: ref, walletUrl: link, customerName,
      reason: "No valid phone on file. Show this QR to the guest instead." });
    return;
  }
  const result = await sendWhatsAppViaMeta({
    phone,
    template: { name: "wallet_ready", params: [customerName, eventTitle, ref, guests, link] },
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
  const eventTitle = g.eventTitle || "tonight";
  const fallbackText = `Hi ${customerName}! 🎉\n\nYou're on tonight's HOD guest list${g.eventTitle ? ` for ${g.eventTitle}` : ""}.\n\n📋 Free entry · just show this at the door\n${link}\n\nHouse of Dopamine | Koramangala 🎵`;
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

function TicketsTab({ agentName, query, eventId, onCover, onShowQr }: { agentName: string; query: string; eventId: string; onCover: (b: HodBooking) => void; onShowQr: (m: { bookingRef: string; walletUrl: string; customerName: string; reason: string }) => void }) {
  const [bookings, setBookings] = useState<HodBooking[]>([]);
  const [lookupResult, setLookupResult] = useState<HodBooking | null>(null);
  const [showOnlyCheckedIn, setShowOnlyCheckedIn] = useState(false);

  useEffect(() => {
    const unsub = subscribeToBookings((all) => setBookings(all));
    return unsub;
  }, []);

  const today = TODAY_STR();
  const todayDates = TODAY_DATE_SET();
  let todayBookings = bookings.filter((b) => todayDates.has((b.date || "").slice(0, 10)));
  // ── BUGFIX 2026-05-08: route guestlist-typed bookings out of Tickets tab.
  // hodclub.in customer flow writes to `bookings` for ALL paths; the dual-write
  // to `guestlist` may be blocked by Firestore rules or by browser/CDN cache
  // serving the pre-fix HTML. Door-side filter here is the source-of-truth so
  // the operational tab assignment never depends on customer-site state.
  todayBookings = todayBookings.filter((b) => !((b as any).entryType || "").startsWith("guestlist_"));
  // 🛡 BUGFIX 2026-05-08: TABLE FOR 4 / VVIP TABLE FOR 6 bookings dual-write to
  // both `bookings` and `tableReservations`. Tables tab is the operational view
  // for these (shows floor, Reassign, party size); hide them from Tickets to
  // avoid double-entry. Detect via tableType field (set by saveBooking) or
  // bookMode==='group' (legacy fallback).
  todayBookings = todayBookings.filter((b) => {
    const tt = (b as any).tableType;
    const bm = (b as any).bookMode;
    return !tt && bm !== "group";
  });
  // Event filter is permissive: keep entries that match the selected event OR have no eventId
  // (aggregator bookings and legacy entries without eventId should always be visible for today)
  if (eventId !== "all") todayBookings = todayBookings.filter((b) => !b.eventId || b.eventId === eventId);
  const checked = todayBookings.filter((b) => b.checkedIn).length;
  const visibleBookings = showOnlyCheckedIn ? todayBookings.filter((b) => b.checkedIn) : todayBookings;
  const filtered = visibleBookings.filter((b) => matchQuery(query, b.name, b.phone, b.ref));

  return (
    <div>
      {lookupResult && <LookupResult booking={lookupResult} agentName={agentName} onDone={() => setLookupResult(null)} />}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
        <div onClick={() => setShowOnlyCheckedIn(false)}
          style={{ background: !showOnlyCheckedIn ? "rgba(201,168,76,.12)" : "rgba(255,255,255,.04)",
            border: `1px solid ${!showOnlyCheckedIn ? "rgba(201,168,76,.5)" : "transparent"}`,
            borderRadius: 10, padding: 12, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#C9A84C" }}>{todayBookings.length}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)" }}>Today's Bookings {!showOnlyCheckedIn ? "•" : ""}</div>
        </div>
        <div onClick={() => setShowOnlyCheckedIn(true)}
          style={{ background: showOnlyCheckedIn ? "rgba(0,200,100,.15)" : "rgba(255,255,255,.04)",
            border: `1px solid ${showOnlyCheckedIn ? "rgba(0,200,100,.5)" : "transparent"}`,
            borderRadius: 10, padding: 12, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#00C864" }}>{checked}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)" }}>Checked In {showOnlyCheckedIn ? "•" : ""}</div>
        </div>
      </div>

      {filtered.map((b) => (
        <div key={b.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,.06)", gap: 8 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.ref} · {b.phone || ""} · {b.type || ""}{b.tier ? ` · ${b.tier}` : ""}</div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
            <button onClick={() => onCover(b)} title="Cover wallet"
              style={{ padding: "6px 10px", borderRadius: 7, background: "rgba(201,168,76,.1)", border: "1px solid rgba(201,168,76,.35)", color: "#C9A84C", fontSize: 11, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>
              💰
            </button>
            <button onClick={() => sendBookingWhatsApp(b, onShowQr)} title="Re-send WhatsApp wallet/QR link"
              style={{ padding: "6px 10px", borderRadius: 7, background: "rgba(37,211,102,.1)", border: "1px solid rgba(37,211,102,.35)", color: "#25D366", fontSize: 11, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>
              📲
            </button>
            {/* 2026-05-10 (Khushi) — direct QR button. Same fallback flow as
                Tables tab: bypasses WhatsApp entirely so guest can scan
                instantly when Meta is flaky / phone missing / card cold. */}
            <button onClick={() => onShowQr({
              bookingRef: b.ref || b.id,
              walletUrl: `https://hodclub.in/?wallet=${encodeURIComponent(b.ref || b.id)}`,
              customerName: b.name || "Guest",
              reason: "Show this QR — guest scans to open their wallet & menu instantly.",
            })} title="Show QR for guest to scan (skip WhatsApp)"
              style={{ padding: "6px 10px", borderRadius: 7, background: "rgba(201,168,76,.1)", border: "1px solid rgba(201,168,76,.35)", color: "#C9A84C", fontSize: 11, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>
              📱
            </button>
            {b.checkedIn ? (
              <span style={{ fontSize: 11, color: "#00C864", fontWeight: 800 }}>✅</span>
            ) : (
              <button onClick={() => setLookupResult(b)}
                style={{ padding: "6px 12px", borderRadius: 8, background: "rgba(0,200,100,.1)", border: "1px solid rgba(0,200,100,.3)", color: "#00C864", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                Check In
              </button>
            )}
          </div>
        </div>
      ))}
      {filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: "rgba(255,255,255,.3)", fontSize: 13 }}>
          {query ? `No matches for "${query}" in today's bookings`
            : showOnlyCheckedIn ? "No one checked in yet — tap the gold tile to see all bookings"
            : "No bookings for today"}
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
  const visibleGuests = showOnlyCheckedIn ? todayGuests.filter((g) => g.checkedIn) : todayGuests;
  const filtered = visibleGuests.filter((g) => matchQuery(query, g.name, g.phone));

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
        <div onClick={() => setShowOnlyCheckedIn(false)}
          style={{ background: !showOnlyCheckedIn ? "rgba(201,168,76,.12)" : "rgba(255,255,255,.04)",
            border: `1px solid ${!showOnlyCheckedIn ? "rgba(201,168,76,.5)" : "transparent"}`,
            borderRadius: 10, padding: 12, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#C9A84C" }}>{todayGuests.length}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)" }}>Today's Guests {!showOnlyCheckedIn ? "•" : ""}</div>
        </div>
        <div onClick={() => setShowOnlyCheckedIn(true)}
          style={{ background: showOnlyCheckedIn ? "rgba(0,200,100,.15)" : "rgba(255,255,255,.04)",
            border: `1px solid ${showOnlyCheckedIn ? "rgba(0,200,100,.5)" : "transparent"}`,
            borderRadius: 10, padding: 12, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#00C864" }}>{checkedIn}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)" }}>Checked In {showOnlyCheckedIn ? "•" : ""}</div>
        </div>
      </div>

      {filtered.map((g) => (
        <div key={g.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{g.name}</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.4)" }}>
              {g.phone || ""} {g.type ? `· ${g.type}` : ""} {g.eventTitle ? `· ${g.eventTitle}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
            <button onClick={() => onCover({ id: g.id, ref: g.id, name: g.name, phone: g.phone, eventId: g.eventId, eventTitle: g.eventTitle, _isGuestList: true, _glDocId: g.id } as any)} title="Cover wallet"
              style={{ padding: "6px 10px", borderRadius: 7, background: "rgba(201,168,76,.1)", border: "1px solid rgba(201,168,76,.35)", color: "#C9A84C", fontSize: 11, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>
              💰
            </button>
            <button onClick={() => sendGuestlistWhatsApp(g, onShowQr)} title="Re-send WhatsApp guest-list link"
              style={{ padding: "6px 10px", borderRadius: 7, background: "rgba(37,211,102,.1)", border: "1px solid rgba(37,211,102,.35)", color: "#25D366", fontSize: 11, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>
              📲
            </button>
            {/* 2026-05-10 (Khushi) — direct QR button. Skips WhatsApp so the
                door staff can show the guestlist link instantly even when
                Meta is flaky, the guest's phone is dead, or no number on file. */}
            <button onClick={() => onShowQr({
              bookingRef: g.id,
              // 🔴 BUGFIX 2026-05-10 — `?wallet=` is the only param hodclub.in
              // handles. `?gl=` opened a blank page. See sendGuestlistWhatsApp.
              walletUrl: `https://hodclub.in/?wallet=${encodeURIComponent((g as any).ref || g.id)}`,
              customerName: g.name || "Guest",
              reason: "Show this QR — guest scans to open their guest-list pass instantly.",
            })} title="Show QR for guest to scan (skip WhatsApp)"
              style={{ padding: "6px 10px", borderRadius: 7, background: "rgba(201,168,76,.1)", border: "1px solid rgba(201,168,76,.35)", color: "#C9A84C", fontSize: 11, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>
              📱
            </button>
            {/* 🎁 BUGFIX 2026-05-08: Door staff comps regulars in WITHOUT activating a paid
                cover. One tap: mints a ₹0 wallet (so Bar can serve & top up later) AND
                checks the guest in. Customer can self-recharge via hodclub.in/?topup=<ref>
                or bartender tops up in person. Hidden once already in. */}
            {!g.checkedIn && (
              <button onClick={async () => {
                if (busyId === g.id) return;
                setBusyId(g.id);
                try {
                  const _source: "booking" | "guestlist" = (g as any)._source === "booking" ? "booking" : "guestlist";
                  // Wallet first (atomic + idempotent), then check-in. If wallet
                  // creation fails (rules / network), abort BEFORE check-in so
                  // door doesn't see "checked in" without a usable wallet.
                  await ensureZeroBalanceCoverForGuest({
                    bookingRef: g.id,
                    sourceDocId: g.id,
                    name: g.name || "Guest",
                    phone: g.phone || "",
                    source: _source,
                    eventId: g.eventId || "",
                    eventTitle: g.eventTitle || "",
                    staffName: agentName,
                  });
                  // ensureZero already mirrors checkedIn back to source — but call
                  // checkInGuest too to write the canonical checkedInAt/checkedInBy
                  // audit fields (mirror sets only checkedIn flag).
                  await checkInGuest(g.id, _source, agentName).catch(() => {});
                  toast({
                    title: `🎁 Free entry: ${g.name || "Guest"}`,
                    description: "₹0 wallet activated · checked in. Customer can top up at bar or via hodclub.in.",
                    duration: 6000,
                  });
                } catch (e: any) {
                  toast({ title: "Free entry failed", description: e?.message || "Try again", variant: "destructive" });
                }
                setBusyId("");
              }}
                disabled={busyId === g.id}
                title="Free entry — creates ₹0 cover wallet + checks in"
                style={{ padding: "6px 10px", borderRadius: 7, background: "rgba(96,165,250,.12)", border: "1px solid rgba(96,165,250,.4)", color: "#60A5FA", fontSize: 11, fontWeight: 800, cursor: busyId === g.id ? "default" : "pointer", whiteSpace: "nowrap" }}>
                {busyId === g.id ? "…" : "🎁 FREE"}
              </button>
            )}
            <button onClick={() => handleToggle(g)} disabled={busyId === g.id || g.checkedIn}
              style={{ padding: "6px 14px", borderRadius: 8, fontSize: 11, fontWeight: 700,
                cursor: g.checkedIn ? "default" : "pointer",
                background: g.checkedIn ? "rgba(0,200,100,.12)" : "rgba(255,255,255,.06)",
                border: `1px solid ${g.checkedIn ? "rgba(0,200,100,.3)" : "rgba(255,255,255,.1)"}`,
                color: g.checkedIn ? "#00C864" : "rgba(255,255,255,.5)" }}
              title={g.checkedIn ? "Already checked in — manager required to reverse" : ""}>
              {busyId === g.id ? "Checking…" : g.checkedIn ? "✅ In" : "Check In"}
            </button>
          </div>
        </div>
      ))}
      {filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: "rgba(255,255,255,.3)", fontSize: 13 }}>
          {query ? `No matches for "${query}" in today's guest list`
            : showOnlyCheckedIn ? "No one checked in yet — tap the gold tile to see all guests"
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
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0C0816", border: "1px solid rgba(201,168,76,.35)", borderRadius: 18, padding: 22, width: "100%", maxWidth: 420, maxHeight: "85vh", overflow: "auto" }}>
        <div style={{ fontSize: 16, fontWeight: 900, color: "#C9A84C", marginBottom: 4 }}>🔄 Reassign Table</div>
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
            style={{ flex: 1, padding: 12, borderRadius: 10, background: picked ? "linear-gradient(135deg,#C9A84C,#8B6914)" : "rgba(201,168,76,.2)", border: "none", color: "#fff", fontSize: 13, fontWeight: 900, cursor: picked ? "pointer" : "not-allowed", opacity: busy ? 0.6 : 1 }}>
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
          style={{ background: !showOnlyArrived ? "rgba(201,168,76,.12)" : "rgba(255,255,255,.04)",
            border: `1px solid ${!showOnlyArrived ? "rgba(201,168,76,.5)" : "transparent"}`,
            borderRadius: 10, padding: 10, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontSize: 20, fontWeight: 900, color: "#C9A84C" }}>{active.length}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)" }}>Tables {!showOnlyArrived ? "•" : ""}</div>
        </div>
        <div onClick={() => setShowOnlyArrived(true)}
          style={{ background: showOnlyArrived ? "rgba(0,200,100,.15)" : "rgba(255,255,255,.04)",
            border: `1px solid ${showOnlyArrived ? "rgba(0,200,100,.5)" : "transparent"}`,
            borderRadius: 10, padding: 10, textAlign: "center", cursor: "pointer" }}>
          <div style={{ fontSize: 20, fontWeight: 900, color: "#00C864" }}>{arrivedCount}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)" }}>Arrived {showOnlyArrived ? "•" : ""}</div>
        </div>
        <div style={{ background: "rgba(255,255,255,.04)", borderRadius: 10, padding: 10, textAlign: "center" }}>
          <div style={{ fontSize: 20, fontWeight: 900, color: "rgba(255,255,255,.6)" }}>{totalGuests}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)" }}>Guests</div>
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
                padding: "6px 12px", borderRadius: 14, fontSize: 10, fontWeight: 800, letterSpacing: ".5px", cursor: "pointer",
                background: on ? (ss ? ss.bg : "rgba(201,168,76,.18)") : "rgba(255,255,255,.04)",
                border: `1px solid ${on ? (ss ? ss.border : "rgba(201,168,76,.4)") : "rgba(255,255,255,.1)"}`,
                color: on ? (ss ? ss.color : "#C9A84C") : "rgba(255,255,255,.55)",
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
          <div key={r._docId} style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 14, padding: "12px 14px", marginBottom: 10 }}>
            {/* Header row */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8, gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 900, color: "#C9A84C", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
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
                  style={{ padding: "9px 4px", borderRadius: 9, background: "linear-gradient(135deg,#00C864,#00A050)", border: "none", color: "#fff", fontSize: 11, fontWeight: 900, cursor: "pointer" }}>
                  {arrBusy === r._docId ? "Marking…" : "🚶 Arrived"}
                </button>
              )}
              <button onClick={() => setReassignFor(r)}
                style={{ padding: "9px 4px", borderRadius: 9, background: "rgba(201,168,76,.1)", border: "1px solid rgba(201,168,76,.35)", color: "#C9A84C", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                🔄 Reassign
              </button>
              <button onClick={() => handleCall(r)}
                style={{ padding: "9px 4px", borderRadius: 9, background: "rgba(96,165,250,.1)", border: "1px solid rgba(96,165,250,.35)", color: "#60A5FA", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                📞 Call
              </button>
              <button onClick={() => handleWhatsapp(r)}
                style={{ padding: "9px 4px", borderRadius: 9, background: "rgba(37,211,102,.1)", border: "1px solid rgba(37,211,102,.35)", color: "#25D366", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                📲 WA
              </button>
              <button onClick={() => handleCancel(r)} disabled={cancelBusy === r._docId}
                style={{ padding: "9px 4px", borderRadius: 9, background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.3)", color: "#EF4444", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                {cancelBusy === r._docId ? "..." : "✕ Cancel"}
              </button>
            </div>
          </div>
        );
      })}
      {filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: "rgba(255,255,255,.3)", fontSize: 13 }}>
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

function NewWalkInModal({ agentName, onClose }: { agentName: string; onClose: () => void }) {
  const [aggOpen, setAggOpen] = useState(false);

  const openHod = (mode: "guestlist" | "cover" | "table") => {
    const params = new URLSearchParams({
      staff: agentName, mode: "walkin", type: mode, ts: String(Date.now()),
    });
    window.open(`${HOD_SITE}/?${params.toString()}`, "_blank", "noopener");
    onClose();
  };

  if (aggOpen) {
    return <AddAggregatorBookingModal agentName={agentName} onClose={onClose} onBack={() => setAggOpen(false)} />;
  }

  const cards: Array<{ key: "guestlist" | "cover" | "table" | "agg"; emoji: string; title: string; sub: string; tint: string }> = [
    { key: "guestlist", emoji: "📋", title: "Guest List", sub: "Free entry — name + phone only", tint: "rgba(96,165,250,.15)" },
    { key: "cover",     emoji: "💰", title: "Cover Booking", sub: "Pre-paid cover (₹) for tonight", tint: "rgba(168,85,247,.15)" },
    { key: "table",     emoji: "🪑", title: "Table Booking", sub: "Live floor map · pick available table", tint: "rgba(201,168,76,.18)" },
    { key: "agg",       emoji: "📲", title: "Aggregator Booking", sub: "Missed sync from Zomato / Swiggy / EazyDiner — add manually", tint: "rgba(231,60,126,.15)" },
  ];

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", backdropFilter: "blur(8px)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0C0816", border: "1px solid rgba(201,168,76,.3)", borderRadius: 20, padding: 24, width: "100%", maxWidth: 380, maxHeight: "90vh", overflow: "auto" }}>
        <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 900, color: "#C9A84C", marginBottom: 4 }}>➕ New Walk-in</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginBottom: 18 }}>
          Booking by <b style={{ color: "#fff" }}>{agentName}</b> · auto-tagged in admin
        </div>
        {cards.map((c) => (
          <button key={c.key} onClick={() => c.key === "agg" ? setAggOpen(true) : openHod(c.key)}
            style={{ display: "block", width: "100%", textAlign: "left", padding: 14, borderRadius: 14, background: c.tint, border: "1px solid rgba(255,255,255,.08)", marginBottom: 10, cursor: "pointer", color: "#fff", fontFamily: "inherit" }}>
            <div style={{ fontSize: 22, marginBottom: 4 }}>{c.emoji}</div>
            <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 2 }}>{c.title}</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.55)" }}>{c.sub}</div>
          </button>
        ))}
        <div style={{ fontSize: 10, color: "rgba(255,255,255,.35)", textAlign: "center", marginTop: 12, lineHeight: 1.5 }}>
          Guest List / Cover / Table cards open hodclub.in. Aggregator card stays here — for entries that didn't sync.
        </div>
        <button onClick={onClose} style={{ width: "100%", marginTop: 12, padding: 12, borderRadius: 10, background: "transparent", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.5)", fontSize: 13, cursor: "pointer" }}>Cancel</button>
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
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0C0816", border: "1px solid rgba(201,168,76,.35)", borderRadius: 18, padding: 22, width: "100%", maxWidth: 440, maxHeight: "90vh", overflow: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <button onClick={onBack} style={{ background: "transparent", border: "none", color: "rgba(255,255,255,.5)", fontSize: 18, cursor: "pointer", padding: 0 }}>←</button>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 18, fontWeight: 900, color: "#C9A84C" }}>📲 Add Aggregator Booking</div>
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
          style={{ width: "100%", padding: 14, borderRadius: 11, background: busy ? "rgba(201,168,76,.3)" : "linear-gradient(135deg,#C9A84C,#A88838)", border: "none", color: "#0C0816", fontSize: 14, fontWeight: 900, cursor: busy ? "wait" : "pointer", letterSpacing: ".5px" }}>
          {busy ? "Adding..." : "✓ Add Booking"}
        </button>
        <button onClick={onClose} style={{ width: "100%", marginTop: 8, padding: 11, borderRadius: 9, background: "transparent", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.5)", fontSize: 12, cursor: "pointer" }}>Cancel</button>
      </div>
    </div>
  );
}

function DoorDashboard({ agentName, onLogout }: { agentName: string; onLogout: () => void }) {
  const [tab, setTab] = useState<"tickets" | "guestlist" | "tables">("tickets");
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

  const handleQrResult = async (data: string) => {
    setScanning(false);
    let ref = data;
    // 🐛 FIX 2026-05-08: customer-site QRs encode `?verify=REF` (not `?ref=`),
    // so without this key we'd pass the full URL into lookupBooking → "Lookup failed".
    try { const url = new URL(data); ref = url.searchParams.get("verify") || url.searchParams.get("ref") || url.searchParams.get("wallet") || url.searchParams.get("id") || data; } catch {}
    try {
      const b = await lookupBooking(ref);
      if (b) setLookupResult(b);
      else alert("No booking found for this QR code");
    } catch { alert("Lookup failed"); }
  };

  const tabs = [
    { key: "tickets" as const, label: "🎫 Tickets" },
    { key: "guestlist" as const, label: "📋 Guest List" },
    { key: "tables" as const, label: "🪑 Tables" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#030305", color: "#fff" }}>
      <div style={{ background: "rgba(12,8,22,.98)", borderBottom: "1px solid rgba(201,168,76,.2)", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Link href="/"
            style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", color: "rgba(255,255,255,.7)", fontSize: 11, fontWeight: 700, cursor: "pointer", textDecoration: "none", whiteSpace: "nowrap" }}>
            ← POS
          </Link>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 15, fontWeight: 900, color: "#C9A84C", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🚪 Door</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,.4)" }}>👤 {agentName}</span>
          <button onClick={onLogout}
            style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.3)", color: "#EF4444", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
            Logout
          </button>
        </div>
      </div>

      <div style={{ padding: "12px 16px" }}>
        {/* Search bar */}
        <div style={{ position: "relative", marginBottom: 10 }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontSize: 16, color: "rgba(255,255,255,.4)", pointerEvents: "none" }}>🔍</span>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search name, phone or ref in today's list..."
            style={{ width: "100%", padding: "13px 14px 13px 38px", borderRadius: 12, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)", color: "#fff", fontSize: 14, outline: "none", boxSizing: "border-box" }}
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
            style={{ padding: 14, borderRadius: 12, background: "linear-gradient(135deg,rgba(201,168,76,.18),rgba(201,168,76,.06))", border: "1.5px solid rgba(201,168,76,.4)", color: "#C9A84C", fontSize: 13, fontWeight: 900, cursor: "pointer" }}>
            📷 Scan QR
          </button>
          <button onClick={() => setWalkInOpen(true)}
            style={{ padding: 14, borderRadius: 12, background: "linear-gradient(135deg,rgba(0,200,100,.2),rgba(0,200,100,.06))", border: "1.5px solid rgba(0,200,100,.4)", color: "#00C864", fontSize: 13, fontWeight: 900, cursor: "pointer" }}>
            ➕ New Walk-in
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
              {crossLoading && <span style={{ color: "rgba(201,168,76,.7)", fontWeight: 600 }}>searching…</span>}
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
            <div style={{ fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,.4)", letterSpacing: 1, marginBottom: 6 }}>🎤 EVENT</div>
            <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, scrollbarWidth: "none" }}>
              <button onClick={() => setSelectedEventId("all")}
                style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 18, fontSize: 11, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap",
                  background: selectedEventId === "all" ? "rgba(201,168,76,.15)" : "rgba(255,255,255,.04)",
                  border: `1px solid ${selectedEventId === "all" ? "rgba(201,168,76,.5)" : "rgba(255,255,255,.1)"}`,
                  color: selectedEventId === "all" ? "#C9A84C" : "rgba(255,255,255,.5)" }}>
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
                    style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 18, fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
                      background: on ? "rgba(201,168,76,.15)" : "rgba(255,255,255,.04)",
                      border: `1px solid ${on ? "rgba(201,168,76,.5)" : "rgba(255,255,255,.1)"}`,
                      color: on ? "#C9A84C" : "rgba(255,255,255,.55)" }}>
                    {title}<span style={{ opacity: .55, marginLeft: 6, fontWeight: 500 }}>· {dateLabel}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {tabs.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ flex: 1, padding: "10px 8px", borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer",
                background: tab === t.key ? "rgba(201,168,76,.12)" : "rgba(255,255,255,.04)",
                border: `1px solid ${tab === t.key ? "rgba(201,168,76,.4)" : "rgba(255,255,255,.08)"}`,
                color: tab === t.key ? "#C9A84C" : "rgba(255,255,255,.5)" }}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === "tickets" && <TicketsTab agentName={agentName} query={searchInput} eventId={selectedEventId} onCover={setCoverFor} onShowQr={setQrModal} />}
        {tab === "guestlist" && <GuestlistTab agentName={agentName} query={searchInput} eventId={selectedEventId} onCover={setCoverFor} onShowQr={setQrModal} />}
        {tab === "tables" && <TablesTab agentName={agentName} query={searchInput} eventId={selectedEventId} onShowQr={setQrModal} />}
      </div>

      {scanning && <QrScanner onResult={handleQrResult} onClose={() => setScanning(false)} />}
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
