// 🍳 KITCHEN DISPLAY SYSTEM (KDS) — 2026-05-21 (Khushi-requested)
//
// Full-screen kitchen tablet view. Shows grouped pending food items with
// BUMP buttons. When chef bumps, captain/bar tablets light up GREEN within
// 1 second so they walk once and serve hot.
//
// FAIL-OPEN: paper KOTs still print regardless. If this screen / Firestore
// dies, kitchen works the old way from paper. Zero regression.
//
// Designed for a wall-mounted 10"+ tablet near the pass. Chunky touch
// targets, big fonts, color-coded age so urgent orders SCREAM.

import { useEffect, useState, useMemo, useRef } from "react";
import { Link } from "wouter";
import { useStaff } from "@/lib/staff-context";
import {
  subscribeToActiveKDSItems,
  bumpKDSItem,
  bumpKDSGroup,
  type HodKDSItem,
} from "@/lib/firestore-hod";

// 🔐 PIN prompt for kitchen tablet — chef enters 4-digit PIN to access the
// screen. Uses the shared staff context (same one captain/bar/admin use)
// so seeded chefs (PIN 7001 / 7002) and any manager/admin work out-of-box.
// 🛟 Fallback: if Firestore staff list is empty AND fallback list also
// missing (rare), the staff context surfaces the error; chef can refresh.
function KitchenLogin() {
  const { login, allStaff } = useStaff();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const tryLogin = () => {
    setError("");
    if (pin.length < 4) { setError("PIN must be 4 digits"); return; }
    const ok = login(pin);
    if (!ok) { setError("Wrong PIN — try again"); setPin(""); inputRef.current?.focus(); }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#030305", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, position: "relative" }}>
      {/* 🚪 2026-05-26 (Khushi) — BACK button on KITCHEN LOGIN too so chef
          tablet isn't trapped if opened by mistake. Mirrors StaffLogin. */}
      <Link href="/"
        style={{ position: "absolute", top: 16, left: 16, padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(201,168,76,.4)", color: "#C9A84C", fontWeight: 800, fontSize: 13, textDecoration: "none", letterSpacing: 0.5, cursor: "pointer", zIndex: 10 }}>
        ← BACK
      </Link>
      <div style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(201,168,76,.3)", borderRadius: 20, padding: "36px 32px", width: "100%", maxWidth: 380, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🍳</div>
        <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 26, fontWeight: 900, color: "#C9A84C", marginBottom: 6, letterSpacing: 1 }}>KITCHEN LOGIN</div>
        <div style={{ fontSize: 13, color: "rgba(242,235,211,.7)", marginBottom: 24 }}>HOD — House of Dopamine</div>
        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && tryLogin()}
          placeholder="ENTER 4-DIGIT PIN"
          style={{ width: "100%", padding: "16px 18px", borderRadius: 12, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", color: "#F2EBD3", fontSize: 22, textAlign: "center", letterSpacing: 8, outline: "none", marginBottom: 14, boxSizing: "border-box" }}
        />
        {error && <div style={{ fontSize: 14, color: "#EF4444", marginBottom: 12 }}>{error}</div>}
        <button
          onClick={tryLogin}
          style={{ width: "100%", padding: 16, borderRadius: 12, background: "linear-gradient(135deg,#C9A84C,#9c7c2c)", border: "none", color: "#000", fontSize: 18, fontWeight: 900, letterSpacing: 1, cursor: "pointer" }}
        >ENTER KITCHEN</button>
        <div style={{ fontSize: 11, color: "rgba(242,235,211,.4)", marginTop: 16 }}>
          {allStaff.length === 0 ? "⏳ Loading staff list…" : "🛟 Default chef PINs: 7001 · 7002"}
        </div>
      </div>
    </div>
  );
}

function ageMinutes(it: HodKDSItem): number {
  const t = (it.firedAt as any)?.toDate?.()?.getTime?.() || Date.now();
  return Math.max(0, Math.floor((Date.now() - t) / 60000));
}

function ageColors(mins: number): { bg: string; border: string; pulse: boolean; label: string } {
  if (mins < 5) return { bg: "hsl(120 40% 8%)", border: "#22c55e", pulse: false, label: "🟢 FRESH" };
  if (mins < 10) return { bg: "hsl(45 60% 10%)", border: "#eab308", pulse: false, label: "🟡 NOTICE" };
  if (mins < 15) return { bg: "hsl(0 50% 12%)", border: "#ef4444", pulse: true, label: "🔴 URGENT" };
  return { bg: "hsl(0 80% 18%)", border: "#dc2626", pulse: true, label: "🚨 LATE" };
}

interface GroupedCard {
  itemKey: string;
  itemName: string;
  totalQty: number;
  oldestMins: number;
  perTable: Array<{
    id: string;
    tableLabel: string;
    floorLabel: string;
    customerName: string;
    qty: number;
    mins: number;
    roundNum: number;
  }>;
  allIds: string[];
}

export default function KitchenMode() {
  const { currentStaff, hasRole, logout } = useStaff();
  const [items, setItems] = useState<HodKDSItem[]>([]);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [, setTick] = useState(0);

  // Re-render every 30s so age colors update without new Firestore writes.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const unsub = subscribeToActiveKDSItems(setItems);
    return () => unsub();
  }, []);

  const grouped: GroupedCard[] = useMemo(() => {
    const map = new Map<string, GroupedCard>();
    for (const it of items) {
      if (!it.id) continue;
      const key = it.itemKey || it.itemName;
      const mins = ageMinutes(it);
      let g = map.get(key);
      if (!g) {
        g = {
          itemKey: key,
          itemName: it.itemName,
          totalQty: 0,
          oldestMins: 0,
          perTable: [],
          allIds: [],
        };
        map.set(key, g);
      }
      g.totalQty += it.qty || 1;
      g.oldestMins = Math.max(g.oldestMins, mins);
      g.allIds.push(it.id);
      g.perTable.push({
        id: it.id,
        tableLabel: it.tableLabel || "—",
        floorLabel: it.floorLabel || "",
        customerName: it.customerName || "",
        qty: it.qty || 1,
        mins,
        roundNum: it.roundNum || 1,
      });
    }
    // Sort cards by oldest first (FIFO fairness)
    return Array.from(map.values()).sort((a, b) => b.oldestMins - a.oldestMins);
  }, [items]);

  const handleBump = async (id: string) => {
    if (!currentStaff) return;
    setBusyIds((p) => new Set(p).add(id));
    try {
      await bumpKDSItem(id, currentStaff.name);
    } catch (e) {
      console.error("[KDS] bump failed", e);
      alert("❌ BUMP FAILED — TRY AGAIN. (Paper KOT still works.)");
    } finally {
      setBusyIds((p) => {
        const n = new Set(p);
        n.delete(id);
        return n;
      });
    }
  };

  const handleBumpAll = async (ids: string[]) => {
    if (!currentStaff) return;
    setBusyIds((p) => {
      const n = new Set(p);
      ids.forEach((id) => n.add(id));
      return n;
    });
    try {
      const res = await bumpKDSGroup(ids, currentStaff.name);
      if (res.fail > 0) {
        alert(`⚠ BUMPED ${res.ok}, FAILED ${res.fail}. RETRY FAILED ONES INDIVIDUALLY.`);
      }
    } finally {
      setBusyIds((p) => {
        const n = new Set(p);
        ids.forEach((id) => n.delete(id));
        return n;
      });
    }
  };

  // Not logged in → show PIN prompt. Logged in but wrong role → access screen.
  if (!currentStaff) return <KitchenLogin />;
  if (!hasRole("chef", "manager", "admin")) {
    return (
      <div style={{ minHeight: "100vh", background: "#030305", color: "#C9A84C", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
        <div>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🍳</div>
          <div style={{ fontFamily: "Playfair Display, serif", fontSize: 28, fontWeight: 900, marginBottom: 8 }}>KITCHEN ACCESS ONLY</div>
          <div style={{ color: "hsl(36 29% 60%)" }}>Logged in as <b>{currentStaff.name}</b> ({currentStaff.role}). Need CHEF / MANAGER / ADMIN PIN.</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#030305", color: "#fafafa", padding: 12 }}>
      {/* Header */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "12px 16px", marginBottom: 12,
        background: "hsl(240 12% 6%)", border: "1px solid #C9A84C", borderRadius: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* 🚪 Back to main login (Khushi requested 2026-05-21). Logs the chef
              out of the staff context AND navigates home so the next person
              must re-enter a PIN. Fallback: if logout fails, the Link href
              still navigates away. */}
          <Link
            href="/"
            onClick={() => { try { logout(); } catch {} }}
            style={{ background: "rgba(255,255,255,.06)", border: "1px solid rgba(201,168,76,.4)", borderRadius: 10, padding: "10px 14px", color: "#C9A84C", fontWeight: 800, fontSize: 13, textDecoration: "none", letterSpacing: 0.5, cursor: "pointer" }}
          >← BACK</Link>
          <div>
            <div style={{ fontFamily: "Playfair Display, serif", fontSize: 28, fontWeight: 900, color: "#C9A84C", letterSpacing: 2 }}>
              🍳 HOD KITCHEN
            </div>
            <div style={{ fontSize: 12, color: "hsl(36 29% 60%)" }}>
              {currentStaff?.name?.toUpperCase()} · {new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
            </div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 42, fontWeight: 900, color: grouped.length > 0 ? "#22c55e" : "#737373" }}>
            {grouped.length}
          </div>
          <div style={{ fontSize: 10, color: "hsl(36 29% 60%)", letterSpacing: 1 }}>ACTIVE DISHES</div>
        </div>
      </div>

      {/* Empty state */}
      {grouped.length === 0 && (
        <div style={{
          padding: 48, textAlign: "center", background: "hsl(240 12% 6%)",
          border: "1px dashed hsl(240 8% 18%)", borderRadius: 12, marginTop: 40,
        }}>
          <div style={{ fontSize: 64, marginBottom: 16 }}>🍽</div>
          <div style={{ fontSize: 22, color: "hsl(36 29% 70%)", fontWeight: 700, letterSpacing: 1 }}>
            ALL CLEAR — NO PENDING ORDERS
          </div>
          <div style={{ fontSize: 13, color: "hsl(36 29% 50%)", marginTop: 8 }}>
            New KOTs will appear here automatically.
          </div>
        </div>
      )}

      {/* Grid of grouped cards */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
        gap: 12,
      }}>
        {grouped.map((g) => {
          const c = ageColors(g.oldestMins);
          const busy = g.allIds.every((id) => busyIds.has(id));
          return (
            <div
              key={g.itemKey}
              style={{
                background: c.bg, border: `3px solid ${c.border}`, borderRadius: 12, padding: 14,
                animation: c.pulse ? "hodKdsUrgent 1.2s ease-in-out infinite" : "none",
              }}
            >
              {/* Title row */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: 0.5, lineHeight: 1.1 }}>
                    {g.itemName.toUpperCase()}
                  </div>
                  <div style={{ fontSize: 36, fontWeight: 900, color: c.border, lineHeight: 1, marginTop: 4 }}>
                    × {g.totalQty}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 11, color: c.border, fontWeight: 700, letterSpacing: 1 }}>{c.label}</div>
                  <div style={{ fontSize: 24, fontWeight: 900, color: "#fafafa" }}>{g.oldestMins}m</div>
                </div>
              </div>

              {/* Per-table breakdown */}
              <div style={{ marginBottom: 10, fontSize: 13 }}>
                {g.perTable.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "6px 8px", marginBottom: 4,
                      background: "rgba(0,0,0,0.35)", borderRadius: 6,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, color: "#C9A84C" }}>
                        {p.tableLabel}{p.floorLabel ? ` · ${p.floorLabel.split(" ")[0]}` : ""} {p.roundNum > 1 ? `· R${p.roundNum}` : ""}
                      </div>
                      {p.customerName && (
                        <div style={{ fontSize: 11, color: "hsl(36 29% 60%)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {p.customerName} · ×{p.qty} · {p.mins}m
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => handleBump(p.id)}
                      disabled={busyIds.has(p.id)}
                      style={{
                        padding: "8px 14px", borderRadius: 8, border: "none",
                        background: busyIds.has(p.id) ? "#52525b" : "#22c55e",
                        color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer",
                        marginLeft: 8, minWidth: 70,
                      }}
                    >
                      {busyIds.has(p.id) ? "..." : "✓ BUMP"}
                    </button>
                  </div>
                ))}
              </div>

              {/* Bump all */}
              {g.perTable.length > 1 && (
                <button
                  onClick={() => handleBumpAll(g.allIds)}
                  disabled={busy}
                  style={{
                    width: "100%", padding: "14px", borderRadius: 8, border: "none",
                    background: busy ? "#52525b" : "#16a34a",
                    color: "#fff", fontSize: 16, fontWeight: 900, letterSpacing: 1, cursor: "pointer",
                  }}
                >
                  {busy ? "BUMPING..." : `✓ BUMP ALL × ${g.totalQty}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer hint */}
      {grouped.length > 0 && (
        <div style={{ marginTop: 16, padding: 10, textAlign: "center", fontSize: 11, color: "hsl(36 29% 50%)" }}>
          🛟 PAPER KOTS STILL PRINT — IF THIS SCREEN FREEZES, WORK FROM THE PAPER RAIL.
        </div>
      )}
    </div>
  );
}
