import { useState, useMemo, useEffect } from "react";
import { Link } from "wouter";
import { useStaff } from "@/lib/staff-context";
import type { StaffMember, StaffRole } from "@/lib/types";

// 🆕 2026-05-25 — Per-staff login v2 (Khushi):
//   • 4-digit PIN only (new roster: HOD###).
//   • input type="text" + WebkitTextSecurity:disc → masked AND no browser
//     "save password?" popup at the door tablet (Khushi specifically asked
//     for this).
//   • autoComplete="off" + name="hodpin" — extra belt-and-suspenders against
//     password manager autofill.
//   • Mode picker shown by ModePickerOverlay at App level when multi-role
//     user logs in — this component just commits the PIN.
//   • Admin + manager auto-included as override so a manager can always
//     rescue a tablet if every staff PIN is forgotten (fail-open per replit.md).

interface Props {
  /** Role(s) that can use THIS mode. Admin + manager are auto-allowed as override. */
  allowedRoles: StaffRole[];
  /** Headline shown above the dropdown, e.g. "DOOR LOGIN". */
  title: string;
  subtitle?: string;
  emoji?: string;
  /** Called after successful login. */
  onSuccess?: () => void;
  /** @deprecated No longer affects theme — every login is Gumroad now (2026-06-25). Kept for call-site backward-compat. */
  brutalist?: boolean;
}

const LOCK_KEY_PREFIX = "hod_stafflogin_lock_";
const FAIL_KEY_PREFIX = "hod_stafflogin_fails_";
// 🆕 2026-06-05 v3.228 — PINs are now VARIABLE length. Legacy seed staff have
// 4-digit PINs; the v3.227 Staff CRM issues 5-digit PINs. Accept 4–6 and let the
// exact-match (loginByStaffId) decide correctness — never hard-cap at one length.
const MIN_PIN = 4;
const MAX_PIN = 6;

/** Match staff if their role OR roles[] includes any allowed role. Admin = always. */
function staffAllowed(s: StaffMember, allowed: Set<StaffRole>): boolean {
  const own = s.roles && s.roles.length > 0 ? s.roles : [s.role];
  for (const r of own) {
    if (r === "admin") return true;
    if (allowed.has(r)) return true;
  }
  return false;
}

export function StaffLogin({ allowedRoles, title, subtitle, emoji = "🪩", onSuccess, brutalist = false }: Props) {
  const { allStaff, loginByStaffId } = useStaff();
  // Admin + manager are auto-allowed as override (revenue never blocked).
  const effectiveRoles = useMemo<Set<StaffRole>>(() => {
    const set = new Set<StaffRole>(allowedRoles);
    set.add("admin"); set.add("manager");
    return set;
  }, [allowedRoles]);

  const eligibleStaff = useMemo(
    () => allStaff
      .filter((s) => s.active && !!s.id && staffAllowed(s, effectiveRoles))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [allStaff, effectiveRoles],
  );

  const lockKey = LOCK_KEY_PREFIX + allowedRoles.join(",");
  const failKey = FAIL_KEY_PREFIX + allowedRoles.join(",");

  const [staffId, setStaffId] = useState<string>("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [fails, setFails] = useState(() => parseInt(sessionStorage.getItem(failKey) || "0"));
  const [lockUntil, setLockUntil] = useState(() => parseInt(sessionStorage.getItem(lockKey) || "0"));

  const [, force] = useState(0);
  useEffect(() => {
    if (lockUntil <= Date.now()) return;
    const i = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [lockUntil]);

  const isOverrideStaff = (s?: StaffMember): boolean => {
    if (!s) return false;
    const own = s.roles && s.roles.length > 0 ? s.roles : [s.role];
    return own.includes("admin") || own.includes("manager");
  };

  const tryLogin = () => {
    const normalizedId = staffId.trim().toUpperCase();
    const selected = allStaff.find((s) => !!s.id && s.id.toUpperCase() === normalizedId);
    const isOverride = isOverrideStaff(selected);

    const currentLock = parseInt(sessionStorage.getItem(lockKey) || "0");
    if (!isOverride && currentLock > Date.now()) {
      setLockUntil(currentLock);
      const min = Math.ceil((currentLock - Date.now()) / 60000);
      setError(`Too many attempts. Locked for ${min} min. (Manager/admin can still log in.)`);
      return;
    }
    if (!normalizedId) { setError("Enter your Employee ID (e.g. HOD001)."); return; }
    if (pin.length < MIN_PIN) { setError("Enter your PIN (4–6 digits)."); return; }

    // 🔐 2026-05-25 (Khushi) — security: do NOT leak whether the ID exists.
    // Treat unknown ID + wrong-role-for-this-mode the same as wrong PIN, and
    // count both against the lockout counter.
    if (!selected || !staffAllowed(selected, effectiveRoles) || !selected.active) {
      const f = fails + 1;
      setFails(f);
      sessionStorage.setItem(failKey, String(f));
      if (f >= 5) {
        const lock = Date.now() + 5 * 60 * 1000;
        sessionStorage.setItem(lockKey, String(lock));
        setLockUntil(lock);
        setError("Too many attempts. Locked for 5 minutes. Get a manager.");
      } else {
        setError(`Wrong ID or PIN (${5 - f} left)`);
      }
      setPin("");
      return;
    }

    const result = loginByStaffId(selected.id as string, pin);
    if (result) {
      sessionStorage.removeItem(failKey);
      sessionStorage.removeItem(lockKey);
      setError("");
      onSuccess?.();
    } else {
      if (isOverride) { setError("Wrong PIN."); setPin(""); return; }
      const f = fails + 1;
      setFails(f);
      sessionStorage.setItem(failKey, String(f));
      if (f >= 5) {
        const lock = Date.now() + 5 * 60 * 1000;
        sessionStorage.setItem(lockKey, String(lock));
        setLockUntil(lock);
        setError("Too many attempts. Locked for 5 minutes. Get a manager (they can still log in).");
      } else {
        setError(`Wrong PIN (${5 - f} left)`);
      }
      setPin("");
    }
  };

  const isLocked = lockUntil > Date.now();
  const lockMinLeft = Math.ceil((lockUntil - Date.now()) / 60000);
  const selectedStaff = allStaff.find((s) => !!s.id && s.id.toUpperCase() === staffId.trim().toUpperCase());
  const buttonDisabled = isLocked && !isOverrideStaff(selectedStaff);

  // 🎨 2026-06-25 (Khushi) — ONE Gumroad theme for EVERY staff login. The old
  // dark-gold theme is removed entirely: Bar/Captain/Kitchen/Admin used to fall
  // back to it (the "black & gold" screen Khushi wanted gone). Now every mode
  // shows the same Gumroad-brutalist look. The `brutalist` prop is kept for
  // backward-compat but no longer changes the theme — it's always Gumroad.
  const t = {
    pageBg: "#F4F4F0",
    backBg: "#FF90E8", backBorder: "2px solid #000", backColor: "#000",
    formBg: "#FFFFFF", formBorder: "2px solid #000", formRadius: 8,
    titleFont: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
    titleColor: "#000", subColor: "#6B6B6B", loadingColor: "#6B6B6B",
    inputBg: "#FFFFFF", inputBorder: "2px solid #000", inputColor: "#000", inputRadius: 6,
    errColor: "#FF5733", lockColor: "#FF5733",
    btnOn: "#FF90E8", btnOnColor: "#000", btnBorder: "2px solid #000",
    btnOff: "#B0B0B0", btnOffColor: "#6B6B6B", footColor: "#6B6B6B",
  };

  return (
    <div style={{ minHeight: "100vh", background: t.pageBg, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, position: "relative" }}>
      {/* 🚪 2026-05-26 (Khushi) — BACK button on every staff login screen so
          a tablet isn't trapped in DOOR/BAR/CAPTAIN login if the wrong mode
          was opened by mistake. Fixed top-left, takes you to the POS mode
          picker at "/". No logout side-effect — login flow simply aborts. */}
      <Link href="/"
        style={{ position: "absolute", top: 16, left: 16, padding: "10px 14px", borderRadius: 6, background: t.backBg, border: t.backBorder, color: t.backColor, fontWeight: 800, fontSize: 13, textDecoration: "none", letterSpacing: 0.5, cursor: "pointer", zIndex: 10 }}>
        ← BACK
      </Link>
      {/* form with autoComplete=off + a hidden honeypot field block the "save password" prompt across Chrome/Safari/Edge */}
      <form
        autoComplete="off"
        onSubmit={(e) => { e.preventDefault(); tryLogin(); }}
        style={{ background: t.formBg, border: t.formBorder, borderRadius: t.formRadius, padding: "32px 28px", width: "100%", maxWidth: 380, textAlign: "center", fontFamily: t.titleFont }}
      >
        {/* hidden honeypot — diverts browser password manager autofill */}
        <input type="text" name="username" autoComplete="username" style={{ display: "none" }} />
        <input type="password" name="password" autoComplete="new-password" style={{ display: "none" }} />

        <div style={{ fontSize: 36, marginBottom: 12 }}>{emoji}</div>
        <div style={{ fontFamily: t.titleFont, fontSize: 22, fontWeight: 900, color: t.titleColor, marginBottom: 6 }}>{title}</div>
        <div style={{ fontSize: 12, color: t.subColor, marginBottom: 24 }}>{subtitle || "HOD — House of Dopamine"}</div>

        {eligibleStaff.length === 0 ? (
          <div style={{ fontSize: 13, color: t.loadingColor, padding: "20px 0" }}>
            Loading staff list...<br />
            <span style={{ fontSize: 11, opacity: .6 }}>If this stays stuck, ask admin to add staff in Admin → Staff tab.</span>
          </div>
        ) : (
          <>
            {/* 🔐 2026-05-25 (Khushi) — Employee ID is typed (not picked from a
                dropdown) so the staff list is NEVER leaked at the login screen.
                Both ID and PIN must be entered. Auto-uppercased on submit. */}
            <input
              type="text"
              value={staffId}
              onChange={(e) => { setStaffId(e.target.value.toUpperCase().slice(0, 12)); setError(""); }}
              onKeyDown={(e) => e.key === "Enter" && tryLogin()}
              disabled={isLocked}
              name="hodempid"
              autoComplete="off"
              data-form-type="other"
              placeholder="EMPLOYEE ID (e.g. HOD001)"
              style={{
                width: "100%", padding: "14px 16px", borderRadius: t.inputRadius,
                background: t.inputBg, border: t.inputBorder,
                color: t.inputColor, fontSize: 16, letterSpacing: 2, textAlign: "center",
                outline: "none", marginBottom: 10, boxSizing: "border-box",
                textTransform: "uppercase",
              }}
            />

            {/* type="text" + WebkitTextSecurity:disc masks PIN visually AND
                stops Chrome/Safari from offering to save the password */}
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={MAX_PIN}
              name="hodpin"
              autoComplete="off"
              data-form-type="other"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, MAX_PIN))}
              onKeyDown={(e) => e.key === "Enter" && tryLogin()}
              disabled={isLocked && !isOverrideStaff(selectedStaff)}
              placeholder="Enter your PIN"
              style={{
                width: "100%", padding: "14px 16px", borderRadius: t.inputRadius,
                background: t.inputBg, border: t.inputBorder,
                color: t.inputColor, fontSize: 22, letterSpacing: 8, textAlign: "center",
                outline: "none", marginBottom: 12, boxSizing: "border-box",
                WebkitTextSecurity: "disc",
              } as React.CSSProperties}
            />

            {error && <div style={{ fontSize: 12, color: t.errColor, marginBottom: 10 }}>{error}</div>}
            {isLocked && <div style={{ fontSize: 11, color: t.lockColor, marginBottom: 10 }}>Locked — wait {lockMinLeft} min, or get manager.</div>}

            <button
              type="submit"
              disabled={buttonDisabled}
              style={{ width: "100%", padding: 14, borderRadius: 6, background: buttonDisabled ? t.btnOff : t.btnOn, border: t.btnBorder, color: buttonDisabled ? t.btnOffColor : t.btnOnColor, fontSize: 15, fontWeight: 900, cursor: buttonDisabled ? "not-allowed" : "pointer" }}
            >
              {buttonDisabled ? `🔒 LOCKED (${lockMinLeft} MIN)` : (isLocked && isOverrideStaff(selectedStaff) ? "🔓 ENTER (MGR OVERRIDE)" : "ENTER")}
            </button>

            <div style={{ fontSize: 10, color: t.footColor, marginTop: 16 }}>
              Session lasts 10 hours. Auto-logout after 15 min idle.
            </div>
          </>
        )}
      </form>
    </div>
  );
}
