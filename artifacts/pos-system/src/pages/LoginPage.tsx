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

const TILES: PendingMode[] = [
  { key: "bar",     href: "/bar",     label: "Bar Mode",     roles: ["bartender"],          authMode: "id-pin" },
  { key: "captain", href: "/captain", label: "Captain Mode", roles: ["captain"],            authMode: "id-pin" },
  { key: "boss",    href: "/admin",   label: "Boss Mode",    roles: ["admin", "manager"],   authMode: "pin"    },
  { key: "door",    href: "/door",    label: "Door Mode",    roles: ["hostess"],            authMode: "id-pin" },
  { key: "kds",     href: "/kitchen", label: "KDS",          roles: ["chef", "captain"],    authMode: "id-pin" },
];

// Per-tile abstract orb palette — three-stop conic gradient + glow color.
// These are deliberately distinct so a glance tells you which mode you're on.
const ORB_PALETTE: Record<ModeKey, { a: string; b: string; c: string; glow: string; emoji: string }> = {
  bar:     { a: "#f97316", b: "#ec4899", c: "#fde68a", glow: "rgba(236,72,153,.45)", emoji: "🍸" },
  captain: { a: "#6366f1", b: "#22d3ee", c: "#a78bfa", glow: "rgba(99,102,241,.45)", emoji: "🎩" },
  boss:    { a: "#C9A84C", b: "#fde68a", c: "#92400e", glow: "rgba(201,168,76,.55)", emoji: "👑" },
  door:    { a: "#10b981", b: "#06b6d4", c: "#34d399", glow: "rgba(16,185,129,.45)", emoji: "🚪" },
  kds:     { a: "#f59e0b", b: "#ef4444", c: "#fbbf24", glow: "rgba(239,68,68,.45)", emoji: "🍳" },
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
.tile-card { transition: transform .25s ease, box-shadow .25s ease, border-color .25s ease; }
.tile-card:hover { transform: translateY(-3px); }
.tile-card:active { transform: scale(.96); }
.tile-card-boss { box-shadow: 0 0 0 1px rgba(201,168,76,.4), 0 0 40px rgba(201,168,76,.18); }
.tile-card-boss:hover { box-shadow: 0 0 0 1px rgba(201,168,76,.7), 0 0 60px rgba(201,168,76,.32); }
@keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.tile-card { animation: fadeUp .4s ease both; }
.tile-card:nth-child(2) { animation-delay: .05s; }
.tile-card:nth-child(3) { animation-delay: .10s; }
.tile-card:nth-child(4) { animation-delay: .15s; }
.tile-card:nth-child(5) { animation-delay: .20s; }
`;

export default function LoginPage() {
  const { login, loginByStaffId, allStaff, currentStaff, hasRole, isLoggedIn, logout } = useStaff();
  const [, setLocation] = useLocation();
  const [pin, setPin] = useState("");
  const [staffId, setStaffId] = useState("");
  const [error, setError] = useState("");
  const [seeding, setSeeding] = useState(false);
  const [pendingMode, setPendingMode] = useState<PendingMode | null>(null);
  const idInputRef = useRef<HTMLInputElement>(null);

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
  const tryLogin = (fullPin: string) => {
    if (!pendingMode) return;
    if (pendingMode.authMode === "pin") {
      // Boss Mode: PIN-only against admin/manager-tier staff.
      const ok = login(fullPin);
      if (!ok) { flashError("WRONG PIN"); return; }
      // login() already set currentStaff. Re-check role; should always pass
      // for admin/manager PINs, but a manager tapping Boss is fine too.
      // Navigation handled in the effect below.
      return;
    }
    // Staff mode: must have an employee ID typed.
    const id = staffId.trim().toUpperCase();
    if (!id) { flashError("ENTER EMPLOYEE ID"); return; }
    const found = loginByStaffId(id, fullPin);
    if (!found) { flashError("WRONG ID OR PIN"); return; }
    // Role-gate: ensure this staff can actually enter the chosen mode.
    const allowed = hasRoleOnStaff(found.role, found.roles, ["admin", ...pendingMode.roles]);
    if (!allowed) {
      flashError(`NOT AUTHORISED FOR ${pendingMode.label.toUpperCase()}`);
      logout();
      return;
    }
  };

  // Navigate when login succeeds AND a pending mode is set.
  useEffect(() => {
    if (isLoggedIn && pendingMode) {
      const target = pendingMode.href;
      setPendingMode(null);
      setPin(""); setStaffId("");
      setLocation(target);
    }
  }, [isLoggedIn, pendingMode, setLocation]);

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
      style={{ background: "#030305" }}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <style>{ORB_CSS}</style>

      {pendingMode && (
        <button
          onClick={cancel}
          className="fixed top-4 left-4 text-sm font-bold tracking-widest px-4 py-2 rounded-lg transition-all hover:brightness-125 active:scale-95"
          style={{
            background: "rgba(201,168,76,.08)",
            border: "1.5px solid #C9A84C",
            color: "#C9A84C",
            zIndex: 50,
          }}
        >
          ← BACK
        </button>
      )}

      <div className="text-center mb-10">
        <h1
          className="text-5xl font-bold tracking-wider mb-2"
          style={{ color: "#C9A84C", fontFamily: "Playfair Display, serif" }}
        >
          H.O.D
        </h1>
        <p className="text-sm tracking-widest" style={{ color: "hsl(36 29% 70%)" }}>
          HOUSE OF DOPAMINE
        </p>
        <p className="text-xs mt-1" style={{ color: "hsl(36 29% 50%)" }}>
          Point of Sale System
        </p>
      </div>

      {/* ────────── PIN / LOGIN VIEW (after tile tap) ────────── */}
      {pendingMode ? (
        <div className="flex flex-col items-center w-full" style={{ maxWidth: 360 }}>
          <div className="flex flex-col items-center gap-3 mb-5">
            <AnimatedOrb mode={pendingMode.key} size={64} highlight />
            <span className="text-base font-semibold tracking-wide" style={{ color: "#C9A84C" }}>
              {pendingMode.label.toUpperCase()}
            </span>
          </div>

          {/* Boss = PIN only. Staff modes = ID + PIN. */}
          {pendingMode.authMode === "id-pin" && (
            <div className="w-full mb-4">
              <label className="block text-[11px] mb-1 tracking-widest" style={{ color: "hsl(36 29% 60%)" }}>
                EMPLOYEE ID
              </label>
              <input
                ref={idInputRef}
                type="text"
                value={staffId}
                onChange={(e) => { setStaffId(e.target.value.toUpperCase()); setError(""); }}
                placeholder="HOD001"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                className="w-full px-3 py-3 rounded-lg text-center text-lg tracking-widest font-mono"
                style={{
                  background: "hsl(240 12% 8%)",
                  border: "1px solid hsl(240 8% 18%)",
                  color: "#C9A84C",
                  letterSpacing: "0.18em",
                }}
              />
            </div>
          )}

          <div className="w-full mb-3">
            <label className="block text-[11px] mb-1 tracking-widest" style={{ color: "hsl(36 29% 60%)" }}>
              {pendingMode.authMode === "pin" ? "BOSS PIN (0000)" : "PIN"}
            </label>
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              value={pin}
              maxLength={6}
              onChange={(e) => { setPin(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") tryLogin(pin); }}
              placeholder=""
              className="w-full px-3 py-3 rounded-lg text-center text-xl tracking-widest font-mono"
              style={{
                background: "hsl(240 12% 8%)",
                border: `1px solid ${error ? "#ef4444" : "hsl(240 8% 18%)"}`,
                color: "#C9A84C",
                letterSpacing: "0.4em",
              }}
            />
          </div>

          {error && (
            <p className="text-center text-xs mb-2 font-semibold tracking-wide" style={{ color: "#ef4444" }}>
              {error}
            </p>
          )}

          <button
            onClick={() => tryLogin(pin)}
            disabled={pin.length < 4}
            className="w-full py-3 rounded-lg text-sm font-bold tracking-widest transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: "#C9A84C",
              color: "#030305",
            }}
          >
            LOGIN →
          </button>
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
                  background: m.key === "boss"
                    ? "radial-gradient(circle at 50% 0%, hsl(240 12% 12%), hsl(240 12% 4%))"
                    : "linear-gradient(180deg, hsl(240 12% 8%), hsl(240 12% 4%))",
                  border: `1px solid ${m.key === "boss" ? "rgba(201,168,76,.35)" : "hsl(240 8% 14%)"}`,
                  cursor: "pointer",
                }}
              >
                <AnimatedOrb mode={m.key} size={80} highlight={m.key === "boss"} />
                <span
                  className="text-[11px] font-semibold tracking-[0.18em] uppercase"
                  style={{ color: m.key === "boss" ? "#C9A84C" : "hsl(36 29% 78%)" }}
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
        <p className="text-xs mt-8" style={{ color: "hsl(36 29% 40%)" }}>
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
