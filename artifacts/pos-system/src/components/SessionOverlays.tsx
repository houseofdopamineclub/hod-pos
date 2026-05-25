import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useStaff } from "@/lib/staff-context";
import type { StaffRole } from "@/lib/types";

// 🆕 2026-05-25 (Khushi) — Two app-level overlays:
//
//   1) ModePickerOverlay
//      Shown when a multi-role staff has logged in but not yet picked which
//      mode (door / captain / bar). After pick → setActiveMode + navigate.
//
//   2) IdleLockOverlay
//      Shown after 25 min of no activity. Re-enter current staff's PIN to
//      unlock. Does NOT reset the absolute 10-hr session — just a fast
//      re-auth so a walked-away tablet can't be hijacked.

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const goto = (path: string) => {
  // Use full document navigation so the URL prefix (BASE) is respected
  // across artifacts. wouter's setLocation does NOT include BASE.
  window.location.href = BASE + path;
};

const MODE_LABEL: Record<string, { label: string; emoji: string; path: string; bg: string }> = {
  hostess:   { label: "DOOR MODE",    emoji: "🚪", path: "/door",    bg: "linear-gradient(135deg,#7B61FF,#4F38C9)" },
  captain:   { label: "CAPTAIN MODE", emoji: "👨‍✈️", path: "/captain", bg: "linear-gradient(135deg,#C9A84C,#8B6F2C)" },
  bartender: { label: "BAR MODE",     emoji: "🍸", path: "/bar",     bg: "linear-gradient(135deg,#F2C744,#B8951F)" },
};

export function ModePickerOverlay() {
  const { currentStaff, needsModePicker, setActiveMode, hasRole, logout } = useStaff();
  const [, setLoc] = useLocation();

  if (!needsModePicker || !currentStaff) return null;

  // Which modes can this user actually pick? Admin gets all three.
  const own: StaffRole[] = currentStaff.roles && currentStaff.roles.length > 0
    ? currentStaff.roles
    : [currentStaff.role];
  const isAdmin = own.includes("admin");
  const allowed: StaffRole[] = isAdmin
    ? ["hostess", "captain", "bartender"]
    : (["hostess", "captain", "bartender"] as StaffRole[]).filter((r) => own.includes(r));

  const pick = (role: StaffRole) => {
    setActiveMode(role);
    const def = MODE_LABEL[role];
    if (def) {
      // Use wouter for in-app routing so we don't drop unrelated state.
      setLoc(def.path);
      // Belt-and-suspenders for hard refreshes / different artifact paths.
      setTimeout(() => {
        if (window.location.pathname.indexOf(def.path) === -1) goto(def.path);
      }, 50);
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(5,5,10,.92)", zIndex: 99998,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div style={{
        background: "#0E0E14", border: "1px solid rgba(201,168,76,.3)", borderRadius: 24,
        padding: "36px 28px", width: "100%", maxWidth: 440, textAlign: "center",
        boxShadow: "0 20px 60px rgba(0,0,0,.7)",
      }}>
        <div style={{ fontSize: 38, marginBottom: 10 }}>🪩</div>
        <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 900, color: "#C9A84C" }}>
          PICK YOUR MODE
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.55)", marginTop: 6, marginBottom: 28 }}>
          Logged in as <strong style={{ color: "#fff" }}>{currentStaff.name}</strong> ({currentStaff.id})
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {allowed.map((role) => {
            const def = MODE_LABEL[role];
            if (!def) return null;
            return (
              <button
                key={role}
                onClick={() => pick(role)}
                style={{
                  padding: "18px 16px", borderRadius: 14, border: "none",
                  background: def.bg, color: "#0A0A0A", fontSize: 17, fontWeight: 900,
                  letterSpacing: 1, cursor: "pointer", textAlign: "center",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
                }}
              >
                <span style={{ fontSize: 22 }}>{def.emoji}</span> {def.label}
              </button>
            );
          })}
        </div>

        {isAdmin && (
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", marginTop: 18 }}>
            🛡 Admin tier — you also have access to /admin dashboard.
          </div>
        )}

        <button
          onClick={() => { logout(); goto("/"); }}
          style={{
            marginTop: 22, padding: "10px 14px", background: "transparent",
            color: "rgba(255,255,255,.5)", border: "1px solid rgba(255,255,255,.1)",
            borderRadius: 10, fontSize: 11, cursor: "pointer", letterSpacing: 1,
          }}
        >
          LOG OUT
        </button>
        {/* fallback for unused import */}
        {false && <span>{String(hasRole)}</span>}
      </div>
    </div>
  );
}

export function IdleLockOverlay() {
  const { isIdleLocked, currentStaff, unlockIdle, logout } = useStaff();
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [fails, setFails] = useState(0);

  // Clear local state when the lock clears or staff changes.
  useEffect(() => {
    if (!isIdleLocked) { setPin(""); setErr(""); setFails(0); }
  }, [isIdleLocked, currentStaff?.id]);

  if (!isIdleLocked || !currentStaff) return null;

  const submit = () => {
    if (pin.length !== 4) { setErr("Enter your 4-digit PIN."); return; }
    const ok = unlockIdle(pin);
    if (!ok) {
      const f = fails + 1;
      setFails(f);
      setErr(`Wrong PIN (${f} wrong)`);
      setPin("");
      // 5 wrong → force full logout for safety.
      if (f >= 5) { logout(); }
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,.9)", zIndex: 99999,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      backdropFilter: "blur(8px)",
    }}>
      <form
        autoComplete="off"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        style={{
          background: "#0E0E14", border: "1px solid rgba(201,168,76,.35)", borderRadius: 20,
          padding: "32px 28px", width: "100%", maxWidth: 360, textAlign: "center",
          boxShadow: "0 20px 60px rgba(0,0,0,.8)",
        }}
      >
        <input type="text" name="username" autoComplete="username" style={{ display: "none" }} />
        <input type="password" name="password" autoComplete="new-password" style={{ display: "none" }} />

        <div style={{ fontSize: 38, marginBottom: 10 }}>🔒</div>
        <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 20, fontWeight: 900, color: "#C9A84C" }}>
          SCREEN LOCKED
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginTop: 6, marginBottom: 4 }}>
          25 min of no activity — re-enter your PIN.
        </div>
        <div style={{ fontSize: 13, color: "#fff", marginBottom: 20, fontWeight: 700 }}>
          {currentStaff.name} ({currentStaff.id})
        </div>

        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={4}
          name="hodpin"
          autoComplete="off"
          data-form-type="other"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          autoFocus
          placeholder="4-digit PIN"
          style={{
            width: "100%", padding: "14px 16px", borderRadius: 12,
            background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.12)",
            color: "#fff", fontSize: 22, letterSpacing: 10, textAlign: "center",
            outline: "none", marginBottom: 12, boxSizing: "border-box",
            WebkitTextSecurity: "disc",
          } as React.CSSProperties}
        />
        {err && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 10 }}>{err}</div>}

        <button
          type="submit"
          style={{
            width: "100%", padding: 14, borderRadius: 12,
            background: "linear-gradient(135deg,#C9A84C,#A07830)", border: "none",
            color: "#000", fontSize: 15, fontWeight: 900, cursor: "pointer",
          }}
        >
          🔓 UNLOCK
        </button>

        <button
          type="button"
          onClick={() => logout()}
          style={{
            marginTop: 14, padding: "8px 14px", background: "transparent",
            color: "rgba(255,255,255,.5)", border: "1px solid rgba(255,255,255,.1)",
            borderRadius: 10, fontSize: 11, cursor: "pointer", letterSpacing: 1,
          }}
        >
          LOG OUT INSTEAD
        </button>

        <div style={{ fontSize: 10, color: "rgba(255,255,255,.35)", marginTop: 14 }}>
          5 wrong attempts → automatic logout.
        </div>
      </form>
    </div>
  );
}
