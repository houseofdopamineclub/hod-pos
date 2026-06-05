import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useStaff } from "@/lib/staff-context";
import { seedDefaultStaff, seedDefaultAggregatorSettings } from "@/lib/firestore";
import { FEATURES } from "@/lib/feature-flags";
import type { StaffRole } from "@/lib/types";

// 🆕 2026-05-27 v3.107 (Khushi LIVE) — TWO-FIELD STAFF LOGIN + abstract orbs.
// Khushi clarification (with hand-drawn architecture screenshot):
//   • Bar / Captain / Door / KDS → require **Employee ID + PIN** (use the
//     existing `loginByStaffId(id, pin)` flow that the per-mode PIN pads
//     used historically — staffId is the canonical attribution key for audit
//     trails, voids, captain stats, etc).
//   • Boss Mode → single 4-digit PIN (Owner backdoor PIN 0000 in
//     FALLBACK_STAFF, or any admin/manager PIN). No staff ID required —
//     Khushi taps Boss + 0000 and lands in the admin tab grid.
//
// Tile icons: replaced flat emoji with animated abstract CSS orbs — conic
// gradient + slow rotation + border-radius morph + drop-shadow glow. Each
// tile has a unique palette so they're instantly distinguishable.
//
// 🛟 FAIL-OPEN:
//   • Role-mismatch login (e.g. bartender tries Boss Mode tile) → red error
//     in-line, logs them out, stays on PIN view. Never strands them.
//   • Empty employee ID at PIN completion → red error, doesn't even call
//     loginByStaffId (avoids leaking which IDs exist via timing).
//   • Escape / ← BACK always returns to the tile grid.

type ModeKey = "bar" | "captain" | "boss" | "door" | "kds";
type PendingMode = {
  key: ModeKey;
  href: string;
  label: string;
  /** roles that are allowed to enter this mode (admin always allowed). */
  roles: StaffRole[];
  /** boss = single PIN; others = id + pin. */
  authMode: "pin" | "id-pin";
};

// 🆕 2026-06-05 v3.229 (Khushi) — the mode each tile commits the staffer to.
// Passed into login()/loginByStaffId() as the session's activeMode so the
// app-level "PICK YOUR MODE" overlay never asks again after they already
// chose a tile + entered their PIN. Boss → "admin" (suppresses picker; the
// admin dashboard has no floor-mode gate).
const TILE_MODE: Record<ModeKey, StaffRole> = {
  bar: "bartender",
  captain: "captain",
  boss: "admin",
  door: "hostess",
  kds: "chef",
};

const TILES: PendingMode[] = [
  { key: "bar",     href: "/bar",     label: "Bar/Cashier Mode", roles: ["bartender"],      authMode: "id-pin" },
  { key: "captain", href: "/captain", label: "Captain Mode", roles: ["captain"],            authMode: "id-pin" },
  { key: "boss",    href: "/admin",   label: "Boss Mode",    roles: ["admin", "manager"],   authMode: "pin"    },
  { key: "door",    href: "/door",    label: "Door Mode",    roles: ["hostess"],            authMode: "id-pin" },
  { key: "kds",     href: "/kitchen", label: "KDS",          roles: ["chef", "captain"],    authMode: "id-pin" },
];

// Per-tile abstract orb palette — three-stop conic gradient + glow color.
// These are deliberately distinct so a glance tells you which mode you're on.
const ORB_PALETTE: Record<ModeKey, { a: string; b: string; c: string; glow: string; emoji: string }> = {
  bar:     { a: "#FF90E8", b: "#F2C744", c: "#FF5733", glow: "rgba(255,144,232,.45)", emoji: "🍸" },
  captain: { a: "#23A094", b: "#60A5FA", c: "#F2C744", glow: "rgba(35,160,148,.45)",  emoji: "🎩" },
  boss:    { a: "#F2C744", b: "#FFE08A", c: "#FF90E8", glow: "rgba(242,199,68,.55)",  emoji: "👑" },
  door:    { a: "#60A5FA", b: "#23A094", c: "#90E0C8", glow: "rgba(96,165,250,.45)",  emoji: "🚪" },
  kds:     { a: "#FF5733", b: "#F2C744", c: "#FF90E8", glow: "rgba(255,87,51,.45)",   emoji: "🍳" },
};

// ──────────────────────────────────────────────────────────────────────────
// AnimatedOrb — pure-CSS abstract icon. NO emoji, NO image asset. Built from
// a conic gradient (slow spin) layered with a radial highlight (slow morph
// via border-radius keyframes). Tasteful, performant (transform + opacity
// only, no layout thrash).
// ──────────────────────────────────────────────────────────────────────────
function AnimatedOrb({ mode, size = 72, highlight = false }: { mode: ModeKey; size?: number; highlight?: boolean }) {
  const p = ORB_PALETTE[mode];
  return (
    <div
      className="orb-wrap"
      style={{
        width: size,
        height: size,
        position: "relative",
        filter: `drop-shadow(0 0 ${highlight ? 28 : 16}px ${p.glow})`,
      }}
    >
      <div
        className={`orb-conic orb-spin-${mode}`}
        style={{
          position: "absolute",
          inset: 0,
          background: `conic-gradient(from 0deg, ${p.a}, ${p.b}, ${p.c}, ${p.a})`,
        }}
      />
      <div
        className={`orb-blob orb-morph-${mode}`}
        style={{
          position: "absolute",
          inset: "12%",
          background: `radial-gradient(circle at 30% 30%, ${p.b}, ${p.a} 65%, ${p.c})`,
          mixBlendMode: "screen",
          opacity: 0.85,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: "30%",
          borderRadius: "50%",
          background: "radial-gradient(circle at 35% 30%, rgba(255,255,255,.55), rgba(255,255,255,0) 60%)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: Math.round(size * 0.42),
          lineHeight: 1,
          filter: "drop-shadow(0 2px 4px rgba(0,0,0,.55))",
          pointerEvents: "none",
        }}
      >
        {p.emoji}
      </div>
    </div>
  );
}

// One-shot inject of @keyframes + orb classes. Done via a <style> child so
// we don't need a global CSS edit and the rules tear down with the page.
const ORB_CSS = `
@keyframes orb-rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes orb-rotate-rev { from { transform: rotate(360deg); } to { transform: rotate(0deg); } }
@keyframes orb-morph-a {
  0%, 100% { border-radius: 58% 42% 47% 53% / 52% 46% 54% 48%; transform: scale(1) rotate(0deg); }
  33%      { border-radius: 42% 58% 53% 47% / 46% 60% 40% 54%; transform: scale(1.04) rotate(40deg); }
  66%      { border-radius: 50% 50% 60% 40% / 55% 45% 55% 45%; transform: scale(.97) rotate(-30deg); }
}
@keyframes orb-morph-b {
  0%, 100% { border-radius: 45% 55% 60% 40% / 50% 50% 50% 50%; transform: scale(1.02) rotate(0deg); }
  50%      { border-radius: 60% 40% 45% 55% / 60% 40% 60% 40%; transform: scale(.96) rotate(-60deg); }
}
@keyframes orb-pulse {
  0%, 100% { opacity: .85; }
  50%      { opacity: 1; }
}
.orb-conic   { border-radius: 50%; animation: orb-rotate 8s linear infinite; }
.orb-blob    { animation: orb-morph-a 7s ease-in-out infinite, orb-pulse 4s ease-in-out infinite; }
.orb-spin-bar     { animation-duration: 9s; }
.orb-spin-captain { animation-duration: 7s; animation-direction: reverse; }
.orb-spin-boss    { animation-duration: 12s; }
.orb-spin-door    { animation-duration: 10s; animation-direction: reverse; }
.orb-spin-kds     { animation-duration: 6s; }
.orb-morph-boss   { animation: orb-morph-b 9s ease-in-out infinite, orb-pulse 5s ease-in-out infinite; }
.orb-morph-captain { animation: orb-morph-b 7s ease-in-out infinite, orb-pulse 3.5s ease-in-out infinite; }
.tile-card { transition: transform .12s ease, box-shadow .12s ease; box-shadow: 0 0 0 #000; }
.tile-card:hover { transform: translate(-4px,-4px); box-shadow: 7px 7px 0 #000; }
.tile-card:active { transform: translate(0,0); box-shadow: 2px 2px 0 #000; }
.tile-card-boss { box-shadow: 0 0 0 #000; }
.tile-card-boss:hover { box-shadow: 7px 7px 0 #000; }
.tile-card-boss:active { box-shadow: 2px 2px 0 #000; }
.orb-wrap { transition: transform .2s cubic-bezier(.34,1.56,.64,1); }
.tile-card:hover .orb-wrap { transform: scale(1.12) rotate(-8deg); }
.tile-card:active .orb-wrap { transform: scale(1.04) rotate(4deg); }
@keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.tile-card { animation: fadeUp .4s ease both; }
.tile-card:nth-child(2) { animation-delay: .05s; }
.tile-card:nth-child(3) { animation-delay: .10s; }
.tile-card:nth-child(4) { animation-delay: .15s; }
.tile-card:nth-child(5) { animation-delay: .20s; }
`;

export default function LoginPage() {
  const { login, loginByStaffId, allStaff, currentStaff, hasRole, isLoggedIn, logout, setActiveMode } = useStaff();
  const [, setLocation] = useLocation();
  const [pin, setPin] = useState("");
  const [staffId, setStaffId] = useState("");
  const [error, setError] = useState("");
  const [seeding, setSeeding] = useState(false);
  const [pendingMode, setPendingMode] = useState<PendingMode | null>(null);
  const idInputRef = useRef<HTMLInputElement>(null);

  // 🆕 2026-06-05 v3.227 (Khushi) — WRONG-PIN LOCKOUT. 5 wrong attempts (across
  // Boss + any staff mode, this device/session) → 60s lockout before the LOGIN
  // button works again. Counters live in sessionStorage so they survive the
  // tile-picker ↔ PIN-view remounts but clear on app close. Fail-open: any
  // storage error just means no lockout (never strands a real staffer).
  const MAX_FAILS = 5;
  const LOCK_MS = 60 * 1000;
  const readLock = (): number => {
    try { const v = Number(sessionStorage.getItem("hod_login_lock") || 0); return v > Date.now() ? v : 0; } catch { return 0; }
  };
  const [lockUntil, setLockUntil] = useState<number>(readLock);
  const [, setNowTick] = useState(0);
  const lockedNow = lockUntil > Date.now();
  const lockSecs = lockedNow ? Math.ceil((lockUntil - Date.now()) / 1000) : 0;

  const registerFail = () => {
    try {
      const fails = Number(sessionStorage.getItem("hod_login_fails") || 0) + 1;
      if (fails >= MAX_FAILS) {
        const until = Date.now() + LOCK_MS;
        sessionStorage.setItem("hod_login_lock", String(until));
        sessionStorage.setItem("hod_login_fails", "0");
        setLockUntil(until);
      } else {
        sessionStorage.setItem("hod_login_fails", String(fails));
      }
    } catch { /* fail-open: no lockout */ }
  };
  const clearFails = () => {
    try { sessionStorage.removeItem("hod_login_fails"); sessionStorage.removeItem("hod_login_lock"); } catch {}
    setLockUntil(0);
  };

  // Tick once a second while locked so the countdown + button re-enable live.
  useEffect(() => {
    if (!lockUntil) return;
    const t = setInterval(() => {
      if (Date.now() >= lockUntil) { setLockUntil(0); }
      setNowTick((n) => n + 1);
    }, 500);
    return () => clearInterval(t);
  }, [lockUntil]);

  // ── Build visible tiles, respecting feature flags + Boss role gating.
  const tiles = TILES.filter((t) => {
    if (t.key === "bar")     return FEATURES.barMode;
    if (t.key === "captain") return FEATURES.captainMode;
    if (t.key === "boss")    return FEATURES.admin && (!currentStaff || hasRole("admin", "manager"));
    if (t.key === "door")    return FEATURES.doorMode;
    if (t.key === "kds")     return FEATURES.kitchenMode;
    return false;
  });

  // ── Seed default staff/aggregator settings on a fresh DB.
  useEffect(() => {
    if (allStaff.length === 0 && !seeding) {
      setSeeding(true);
      Promise.all([
        seedDefaultStaff().catch(() => {}),
        seedDefaultAggregatorSettings().catch(() => {}),
      ]).finally(() => setSeeding(false));
    }
  }, [allStaff.length, seeding]);

  // ── When PIN entry view opens, auto-focus the appropriate field.
  useEffect(() => {
    if (!pendingMode) return;
    if (pendingMode.authMode === "id-pin") idInputRef.current?.focus();
  }, [pendingMode]);

  // ── Reset to tile picker
  const cancel = () => { setPendingMode(null); setPin(""); setStaffId(""); setError(""); };

  const handleTileTap = (m: PendingMode) => {
    // If currently logged in AND the active staff can enter this mode, skip
    // PIN entirely (same convenience as v3.106).
    if (isLoggedIn && (hasRole("admin") || hasRole(...m.roles))) {
      // Commit to the chosen mode so the picker stays suppressed AND the
      // target mode page auto-logs in (mode pages gate on activeMode).
      setActiveMode(TILE_MODE[m.key]);
      setLocation(m.href);
      return;
    }
    // Else (logged out, OR logged in as a role that can't enter this mode):
    // start fresh — clear any stale session so the new login owns attribution.
    if (isLoggedIn) logout();
    setPin(""); setStaffId(""); setError("");
    setPendingMode(m);
  };

  // ── Submit logic — branches on Boss (PIN only) vs staff modes (id + PIN).
  // 🆕 v3.113: navigate IMMEDIATELY on success (was: deferred to useEffect on
  // isLoggedIn). The previous effect-based nav was racing the parent
  // <AuthGate> in App.tsx — when isLoggedIn flipped true, AuthGate swapped
  // <LoginPage/> for <POSRouter/> on the SAME render, unmounting LoginPage
  // before its effect could fire. POSRouter then matched the current URL
  // ("/") and re-rendered LoginPage (tile picker). User had to tap twice.
  // setLocation BEFORE login() ensures the URL is "/bar" by the time the
  // parent swap happens → POSRouter mounts BarMode directly.
  const navigateAndClear = (target: string) => {
    setLocation(target);
    setPendingMode(null);
    setPin(""); setStaffId(""); setError("");
  };

  const tryLogin = (fullPin: string) => {
    if (!pendingMode) return;
    // 🆕 v3.227 — hard stop while locked out after too many wrong PINs.
    if (lockUntil > Date.now()) {
      flashError(`LOCKED — WAIT ${Math.ceil((lockUntil - Date.now()) / 1000)}S`);
      return;
    }
    if (pendingMode.authMode === "pin") {
      // Boss Mode: PIN-only against admin/manager-tier staff.
      const target = pendingMode.href;
      const ok = login(fullPin, TILE_MODE[pendingMode.key]);
      if (!ok) { registerFail(); flashError("WRONG PIN"); return; }
      clearFails();
      navigateAndClear(target);
      return;
    }
    // Staff mode: must have an employee ID typed.
    const id = staffId.trim().toUpperCase();
    if (!id) { flashError("ENTER EMPLOYEE ID"); return; }
    const target = pendingMode.href;
    const modeLabel = pendingMode.label;
    const modeRoles = pendingMode.roles;
    const found = loginByStaffId(id, fullPin, TILE_MODE[pendingMode.key]);
    if (!found) { registerFail(); flashError("WRONG ID OR PIN"); return; }
    // Role-gate: ensure this staff can actually enter the chosen mode.
    const allowed = hasRoleOnStaff(found.role, found.roles, ["admin", ...modeRoles]);
    if (!allowed) {
      registerFail();
      flashError(`NOT AUTHORISED FOR ${modeLabel.toUpperCase()}`);
      logout();
      return;
    }
    clearFails();
    navigateAndClear(target);
  };

  const flashError = (msg: string) => {
    setError(msg);
    setTimeout(() => { setPin(""); setError(""); }, 1100);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!pendingMode) return;
    if (e.key === "Escape") cancel();
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-4"
      style={{ background: "#F4F4F0" }}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <style>{ORB_CSS}</style>

      {pendingMode && (
        <button
          onClick={cancel}
          className="fixed top-4 left-4 text-sm font-bold tracking-widest px-4 py-2 rounded-lg transition-all active:scale-95"
          style={{
            background: "#fff",
            border: "2px solid #000",
            color: "#000",
            zIndex: 50,
          }}
        >
          ← BACK
        </button>
      )}

      <div className="text-center mb-10">
        <h1
          className="text-5xl font-bold tracking-wider mb-2"
          style={{ color: "#000", fontFamily: "Playfair Display, serif" }}
        >
          H.O.D
        </h1>
        <p className="text-sm tracking-widest font-bold" style={{ color: "#000" }}>
          HOUSE OF DOPAMINE
        </p>
        <p className="text-xs mt-1 tracking-wide" style={{ color: "#6B6B6B" }}>
          Point of Sale System
        </p>
      </div>

      {/* ────────── PIN / LOGIN VIEW (after tile tap) ────────── */}
      {pendingMode ? (
        <div className="flex flex-col items-center w-full" style={{ maxWidth: 360 }}>
          <div className="flex flex-col items-center gap-3 mb-5">
            <AnimatedOrb mode={pendingMode.key} size={64} highlight />
            <span className="text-base font-bold tracking-wide" style={{ color: "#000" }}>
              {pendingMode.label.toUpperCase()}
            </span>
          </div>

          {/* 🆕 v3.113: wrap inputs in a fake form with autocomplete="off" +
              use type="text" with CSS dot-masking on the PIN field. This
              kills the Chrome/Safari "Save password?" prompt that fires on
              every login. Visual masking is identical to type="password". */}
          <form
            className="w-full contents"
            autoComplete="off"
            onSubmit={(e) => { e.preventDefault(); tryLogin(pin); }}
          >
          {/* Decoy fields — some browsers ignore autoComplete=off unless
              there's a dummy username+password pair to "save" instead. */}
          <input type="text" name="username" autoComplete="username" tabIndex={-1} aria-hidden="true" style={{ position: "absolute", left: -9999, width: 1, height: 1, opacity: 0 }} />
          <input type="password" name="password" autoComplete="new-password" tabIndex={-1} aria-hidden="true" style={{ position: "absolute", left: -9999, width: 1, height: 1, opacity: 0 }} />

          {/* Boss = PIN only. Staff modes = ID + PIN. */}
          {pendingMode.authMode === "id-pin" && (
            <div className="w-full mb-4">
              <label className="block text-[11px] mb-1 tracking-widest font-bold" style={{ color: "#000" }}>
                EMPLOYEE ID
              </label>
              <input
                ref={idInputRef}
                type="text"
                name="hod-staff-id"
                value={staffId}
                onChange={(e) => { setStaffId(e.target.value.toUpperCase()); setError(""); }}
                placeholder="HOD001"
                autoCapitalize="characters"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                data-lpignore="true"
                data-1p-ignore=""
                data-form-type="other"
                className="w-full px-3 py-3 rounded-lg text-center text-lg tracking-widest font-mono"
                style={{
                  background: "#fff",
                  border: "2px solid #000",
                  color: "#000",
                  letterSpacing: "0.18em",
                }}
              />
            </div>
          )}

          <div className="w-full mb-3">
            <label className="block text-[11px] mb-1 tracking-widest font-bold" style={{ color: "#000" }}>
              {pendingMode.authMode === "pin" ? "BOSS PIN" : "PIN"}
            </label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              name="hod-pin-code"
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore=""
              data-form-type="other"
              value={pin}
              maxLength={6}
              onChange={(e) => { setPin(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); tryLogin(pin); } }}
              placeholder=""
              className="w-full px-3 py-3 rounded-lg text-center text-xl tracking-widest font-mono"
              style={{
                background: "#fff",
                border: `2px solid ${error ? "#FF5733" : "#000"}`,
                color: "#000",
                letterSpacing: "0.4em",
                WebkitTextSecurity: "disc",
                textSecurity: "disc",
              } as React.CSSProperties}
            />
          </div>

          {error && (
            <p className="text-center text-xs mb-2 font-bold tracking-wide" style={{ color: "#FF5733" }}>
              {error}
            </p>
          )}

          {lockedNow && (
            <p className="text-center text-xs mb-2 font-bold tracking-wide" style={{ color: "#FF5733" }}>
              🔒 TOO MANY WRONG ATTEMPTS — WAIT {lockSecs}S
            </p>
          )}

          <button
            type="submit"
            disabled={pin.length < 4 || lockedNow}
            className="w-full py-3 rounded-lg text-sm font-bold tracking-widest transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: "#FF90E8",
              color: "#000",
              border: "2px solid #000",
            }}
          >
            {lockedNow ? `LOCKED ${lockSecs}S` : "LOGIN →"}
          </button>
          </form>
        </div>
      ) : (
        // ────────── TILE GRID (default landing) ──────────
        // 2-1-2 layout: top row [Bar · Captain], middle row [Boss centered],
        // bottom row [Door · KDS]. Boss is the regal centrepiece.
        (() => {
          const byKey = Object.fromEntries(tiles.map((t) => [t.key, t])) as Record<ModeKey, PendingMode | undefined>;
          const renderTile = (m?: PendingMode) => {
            if (!m) return null;
            return (
              <button
                key={m.key}
                onClick={() => handleTileTap(m)}
                className={`tile-card flex flex-col items-center justify-center gap-3 rounded-2xl ${m.key === "boss" ? "tile-card-boss" : ""}`}
                style={{
                  width: 160,
                  height: 178,
                  background: "#fff",
                  border: `${m.key === "boss" ? "3px" : "2px"} solid #000`,
                  cursor: "pointer",
                }}
              >
                <AnimatedOrb mode={m.key} size={80} highlight={m.key === "boss"} />
                <span
                  className="text-[11px] font-bold tracking-[0.18em] uppercase"
                  style={{ color: "#000" }}
                >
                  {m.label}
                </span>
              </button>
            );
          };
          return (
            <div className="flex flex-col items-center gap-5">
              <div className="flex gap-6">
                {renderTile(byKey.bar)}
                {renderTile(byKey.captain)}
              </div>
              <div className="flex gap-6">
                {renderTile(byKey.boss)}
              </div>
              <div className="flex gap-6">
                {renderTile(byKey.door)}
                {renderTile(byKey.kds)}
              </div>
            </div>
          );
        })()
      )}

      {seeding && (
        <p className="text-xs mt-8" style={{ color: "#6B6B6B" }}>
          Setting up initial data...
        </p>
      )}
    </div>
  );
}

// ─── Helper: role check against a StaffMember's role/roles WITHOUT depending
// on a logged-in currentStaff (we may be checking the result of a fresh
// loginByStaffId before any context state has settled).
function hasRoleOnStaff(role: StaffRole, roles: StaffRole[] | undefined, allowed: StaffRole[]): boolean {
  const mine = new Set<StaffRole>(roles && roles.length > 0 ? roles : [role]);
  if (mine.has("admin")) return true;  // admin = universal
  return allowed.some((r) => mine.has(r));
}
