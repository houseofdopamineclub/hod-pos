import { useState, useMemo, useEffect } from "react";
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
}

const LOCK_KEY_PREFIX = "hod_stafflogin_lock_";
const FAIL_KEY_PREFIX = "hod_stafflogin_fails_";
const PIN_LEN = 4;

/** Match staff if their role OR roles[] includes any allowed role. Admin = always. */
function staffAllowed(s: StaffMember, allowed: Set<StaffRole>): boolean {
  const own = s.roles && s.roles.length > 0 ? s.roles : [s.role];
  for (const r of own) {
    if (r === "admin") return true;
    if (allowed.has(r)) return true;
  }
  return false;
}

export function StaffLogin({ allowedRoles, title, subtitle, emoji = "🪩", onSuccess }: Props) {
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
    if (pin.length !== PIN_LEN) { setError(`Enter your ${PIN_LEN}-digit PIN.`); return; }

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

  return (
    <div style={{ minHeight: "100vh", background: "#0A0A0A", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      {/* form with autoComplete=off + a hidden honeypot field block the "save password" prompt across Chrome/Safari/Edge */}
      <form
        autoComplete="off"
        onSubmit={(e) => { e.preventDefault(); tryLogin(); }}
        style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 20, padding: "32px 28px", width: "100%", maxWidth: 380, textAlign: "center" }}
      >
        {/* hidden honeypot — diverts browser password manager autofill */}
        <input type="text" name="username" autoComplete="username" style={{ display: "none" }} />
        <input type="password" name="password" autoComplete="new-password" style={{ display: "none" }} />

        <div style={{ fontSize: 36, marginBottom: 12 }}>{emoji}</div>
        <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 900, color: "#C9A84C", marginBottom: 6 }}>{title}</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginBottom: 24 }}>{subtitle || "HOD — House of Dopamine"}</div>

        {eligibleStaff.length === 0 ? (
          <div style={{ fontSize: 13, color: "rgba(255,255,255,.6)", padding: "20px 0" }}>
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
                width: "100%", padding: "14px 16px", borderRadius: 12,
                background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)",
                color: "#fff", fontSize: 16, letterSpacing: 2, textAlign: "center",
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
              maxLength={PIN_LEN}
              name="hodpin"
              autoComplete="off"
              data-form-type="other"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, PIN_LEN))}
              onKeyDown={(e) => e.key === "Enter" && tryLogin()}
              disabled={isLocked && !isOverrideStaff(selectedStaff)}
              placeholder={`Enter ${PIN_LEN}-digit PIN`}
              style={{
                width: "100%", padding: "14px 16px", borderRadius: 12,
                background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)",
                color: "#fff", fontSize: 22, letterSpacing: 8, textAlign: "center",
                outline: "none", marginBottom: 12, boxSizing: "border-box",
                WebkitTextSecurity: "disc",
              } as React.CSSProperties}
            />

            {error && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 10 }}>{error}</div>}
            {isLocked && <div style={{ fontSize: 11, color: "#F59E0B", marginBottom: 10 }}>Locked — wait {lockMinLeft} min, or get manager.</div>}

            <button
              type="submit"
              disabled={buttonDisabled}
              style={{ width: "100%", padding: 14, borderRadius: 12, background: buttonDisabled ? "rgba(255,255,255,.1)" : "linear-gradient(135deg,#C9A84C,#A07830)", border: "none", color: buttonDisabled ? "rgba(255,255,255,.4)" : "#000", fontSize: 15, fontWeight: 900, cursor: buttonDisabled ? "not-allowed" : "pointer" }}
            >
              {buttonDisabled ? `🔒 LOCKED (${lockMinLeft} MIN)` : (isLocked && isOverrideStaff(selectedStaff) ? "🔓 ENTER (MGR OVERRIDE)" : "ENTER")}
            </button>

            <div style={{ fontSize: 10, color: "rgba(255,255,255,.35)", marginTop: 16 }}>
              Session lasts 10 hours. Re-PIN after 25 min idle.
            </div>
          </>
        )}
      </form>
    </div>
  );
}
