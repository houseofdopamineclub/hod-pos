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

const MODE_LABEL: Record<string, { label: string; emoji: string; path: string; accent: string; sub: string }> = {
  hostess:   { label: "DOOR MODE",    emoji: "🚪", path: "/door",    accent: "#FF90E8", sub: "Front desk · reservations · check-in" },
  captain:   { label: "CAPTAIN MODE", emoji: "👨‍✈️", path: "/captain", accent: "#F2C744", sub: "Floor tables · orders · billing" },
  bartender: { label: "BAR MODE",     emoji: "🍸", path: "/bar",     accent: "#23A094", sub: "Bar tabs · recharge · quick serve" },
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
      position: "fixed", inset: 0, zIndex: 99998,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      background: "#F4F4F0",
    }}>
      <style>{`
        @keyframes hodPickIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        .hod-pick-card{animation:hodPickIn .2s ease both}
        .hod-mode-tile{transition:transform .08s ease, box-shadow .08s ease}
        .hod-mode-tile:hover{transform:translate(2px,2px); box-shadow:2px 2px 0 #000 !important}
        .hod-mode-tile:active{transform:translate(5px,5px); box-shadow:0 0 0 #000 !important}
        .hod-mode-tile:hover .hod-mode-chev{transform:translateX(3px)}
        .hod-ghost-btn{transition:transform .08s ease, box-shadow .08s ease}
        .hod-ghost-btn:hover{transform:translate(2px,2px); box-shadow:1px 1px 0 #000 !important}
        .hod-ghost-btn:active{transform:translate(3px,3px); box-shadow:0 0 0 #000 !important}
      `}</style>
      <div className="hod-pick-card" style={{
        position: "relative", background: "#FFFFFF",
        border: "2px solid #000", borderRadius: 16,
        padding: "32px 26px 26px", width: "100%", maxWidth: 460, textAlign: "center",
        boxShadow: "8px 8px 0 #000",
      }}>
        {/* Logo badge */}
        <div style={{
          width: 72, height: 72, margin: "0 auto 16px", borderRadius: 16,
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 34,
          background: "#FF90E8", border: "2px solid #000", boxShadow: "4px 4px 0 #000",
        }}>🪩</div>

        <div style={{
          fontFamily: "'Playfair Display',serif", fontSize: 27, fontWeight: 900,
          letterSpacing: .3, color: "#000",
        }}>
          PICK YOUR MODE
        </div>
        <div style={{ fontSize: 13, color: "#555", marginTop: 7, marginBottom: 26 }}>
          Logged in as <strong style={{ color: "#000" }}>{currentStaff.name}</strong>
          <span style={{ color: "#555" }}> · {currentStaff.id}</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {allowed.map((role) => {
            const def = MODE_LABEL[role];
            if (!def) return null;
            return (
              <button
                key={role}
                className="hod-mode-tile"
                onClick={() => pick(role)}
                style={{
                  display: "flex", alignItems: "center", gap: 14,
                  padding: "14px 16px", borderRadius: 14, cursor: "pointer",
                  textAlign: "left", width: "100%",
                  background: "#fff", border: "2px solid #000", color: "#000",
                  boxShadow: "4px 4px 0 #000",
                }}
              >
                <span style={{
                  flex: "0 0 auto", width: 48, height: 48, borderRadius: 12, fontSize: 24,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: def.accent, border: "2px solid #000",
                }}>{def.emoji}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 16, fontWeight: 800, letterSpacing: .4 }}>{def.label}</span>
                  <span style={{ display: "block", fontSize: 12, color: "#666", marginTop: 2 }}>{def.sub}</span>
                </span>
                <span className="hod-mode-chev" style={{
                  flex: "0 0 auto", fontSize: 22, fontWeight: 900, color: "#000",
                  transition: "transform .1s ease",
                }}>›</span>
              </button>
            );
          })}
        </div>

        {isAdmin && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6, marginTop: 20,
            padding: "6px 14px", borderRadius: 999, fontSize: 11, fontWeight: 800,
            letterSpacing: .3, color: "#000",
            background: "#F2C744", border: "2px solid #000",
          }}>
            🛡 Admin tier — full access to the /admin dashboard
          </div>
        )}

        <div style={{ marginTop: 22 }}>
          <button
            className="hod-ghost-btn"
            onClick={() => { logout(); goto("/"); }}
            style={{
              padding: "9px 20px", background: "#fff",
              color: "#000", border: "2px solid #000",
              borderRadius: 999, fontSize: 12, fontWeight: 800, cursor: "pointer", letterSpacing: 1,
              boxShadow: "3px 3px 0 #000",
            }}
          >
            LOG OUT
          </button>
        </div>
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
