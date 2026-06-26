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
    <div style={{ minHeight: "100vh", background: "#F4F4F0", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, position: "relative" }}>
      {/* 🚪 2026-05-26 (Khushi) — BACK button on KITCHEN LOGIN too so chef
          tablet isn't trapped if opened by mistake. Mirrors StaffLogin. */}
      <Link href="/"
        style={{ position: "absolute", top: 16, left: 16, padding: "10px 14px", borderRadius: 6, background: "#FF90E8", border: "2px solid #000", color: "#000", fontWeight: 800, fontSize: 13, textDecoration: "none", letterSpacing: 0.5, cursor: "pointer", zIndex: 10 }}>
        ← BACK
      </Link>
      <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: "36px 32px", width: "100%", maxWidth: 380, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🍳</div>
        <div style={{ fontSize: 26, fontWeight: 900, color: "#000", marginBottom: 6, letterSpacing: 1 }}>KITCHEN LOGIN</div>
        <div style={{ fontSize: 13, color: "#6B6B6B", marginBottom: 24 }}>HOD — House of Dopamine</div>
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
          style={{ width: "100%", padding: "16px 18px", borderRadius: 6, background: "#fff", border: "2px solid #000", color: "#000", fontSize: 22, textAlign: "center", letterSpacing: 8, outline: "none", marginBottom: 14, boxSizing: "border-box" }}
        />
        {error && <div style={{ fontSize: 14, color: "#FF5733", fontWeight: 700, marginBottom: 12 }}>{error}</div>}
        <button
          onClick={tryLogin}
          style={{ width: "100%", padding: 16, borderRadius: 6, background: "#FF90E8", border: "2px solid #000", color: "#000", fontSize: 18, fontWeight: 900, letterSpacing: 1, cursor: "pointer" }}
        >ENTER KITCHEN</button>
        <div style={{ fontSize: 11, color: "#6B6B6B", marginTop: 16 }}>
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
  if (mins < 5) return { bg: "#ECF7F5", border: "#23A094", pulse: false, label: "🟢 FRESH" };
  if (mins < 10) return { bg: "#FEF9E7", border: "#F2C744", pulse: false, label: "🟡 NOTICE" };
  if (mins < 15) return { bg: "#FFF0EC", border: "#FF5733", pulse: true, label: "🔴 URGENT" };
  return { bg: "#FFD9D0", border: "#FF5733", pulse: true, label: "🚨 LATE" };
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
      <div style={{ minHeight: "100vh", background: "#F4F4F0", color: "#000", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
        <div style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: "36px 32px", maxWidth: 440 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🍳</div>
          <div style={{ fontSize: 28, fontWeight: 900, marginBottom: 8, letterSpacing: 1 }}>KITCHEN ACCESS ONLY</div>
          <div style={{ color: "#6B6B6B" }}>Logged in as <b style={{ color: "#000" }}>{currentStaff.name}</b> ({currentStaff.role}). Need CHEF / MANAGER / ADMIN PIN.</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#F4F4F0", color: "#000", padding: 12 }}>
      {/* Header */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "12px 16px", marginBottom: 12,
        background: "#fff", border: "2px solid #000", borderRadius: 8,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* 🚪 Back to main login (Khushi requested 2026-05-21). Logs the chef
              out of the staff context AND navigates home so the next person
              must re-enter a PIN. Fallback: if logout fails, the Link href
              still navigates away. */}
          <Link
            href="/"
            onClick={() => { try { logout(); } catch {} }}
            style={{ background: "#FF90E8", border: "2px solid #000", borderRadius: 6, padding: "10px 14px", color: "#000", fontWeight: 800, fontSize: 13, textDecoration: "none", letterSpacing: 0.5, cursor: "pointer" }}
          >← BACK</Link>
          <div>
            <div style={{ fontSize: 28, fontWeight: 900, color: "#000", letterSpacing: 2 }}>
              🍳 HOD KITCHEN
            </div>
            <div style={{ fontSize: 12, color: "#6B6B6B" }}>
              {currentStaff?.name?.toUpperCase()} · {new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
            </div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 42, fontWeight: 900, color: grouped.length > 0 ? "#23A094" : "#6B6B6B" }}>
            {grouped.length}
          </div>
          <div style={{ fontSize: 10, color: "#6B6B6B", letterSpacing: 1 }}>ACTIVE DISHES</div>
        </div>
      </div>

      {/* Empty state */}
      {grouped.length === 0 && (
        <div style={{
          padding: 48, textAlign: "center", background: "#fff",
          border: "2px dashed #000", borderRadius: 8, marginTop: 40,
        }}>
          <div style={{ fontSize: 64, marginBottom: 16 }}>🍽</div>
          <div style={{ fontSize: 22, color: "#000", fontWeight: 800, letterSpacing: 1 }}>
            ALL CLEAR — NO PENDING ORDERS
          </div>
          <div style={{ fontSize: 13, color: "#6B6B6B", marginTop: 8 }}>
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
                  <div style={{ fontSize: 11, color: c.border, fontWeight: 800, letterSpacing: 1 }}>{c.label}</div>
                  <div style={{ fontSize: 24, fontWeight: 900, color: "#000" }}>{g.oldestMins}m</div>
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
                      background: "#fff", border: "1.5px solid #000", borderRadius: 6,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        {/* 🪧 Table = the ONE thing the runner needs — big, boxed, hard
                            shadow so it reads across the kitchen. Updates live on reassign. */}
                        <span
                          style={{
                            display: "inline-block", padding: "3px 12px", borderRadius: 6,
                            border: "2px solid #000", background: "#FF90E8", color: "#000",
                            fontSize: 22, fontWeight: 900, lineHeight: 1.15,
                            boxShadow: "2px 2px 0 #000", letterSpacing: 0.5,
                          }}
                        >
                          {p.tableLabel}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 800, color: "#000" }}>
                          {p.floorLabel ? p.floorLabel.split(" ")[0] : ""}{p.roundNum > 1 ? ` · R${p.roundNum}` : ""}
                        </span>
                      </div>
                      {p.customerName && (
                        // 🪧 2026-06-26 (Khushi) — guest name is what the runner
                        // calls out, so make it BIG + BOLD + black; the ×qty·mins
                        // stay small and muted beside it.
                        <div style={{ marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          <span style={{ fontSize: 17, fontWeight: 900, color: "#000" }}>{p.customerName}</span>
                          <span style={{ fontSize: 12, fontWeight: 700, color: "#6B6B6B" }}> · ×{p.qty} · {p.mins}m</span>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => handleBump(p.id)}
                      disabled={busyIds.has(p.id)}
                      style={{
                        padding: "8px 14px", borderRadius: 6, border: "2px solid #000",
                        background: busyIds.has(p.id) ? "#B0B0B0" : "#23A094",
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
                    width: "100%", padding: "14px", borderRadius: 6, border: "2px solid #000",
                    background: busy ? "#B0B0B0" : "#23A094",
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
        <div style={{ marginTop: 16, padding: 10, textAlign: "center", fontSize: 11, color: "#6B6B6B" }}>
          🛟 PAPER KOTS STILL PRINT — IF THIS SCREEN FREEZES, WORK FROM THE PAPER RAIL.
        </div>
      )}
    </div>
  );
}
