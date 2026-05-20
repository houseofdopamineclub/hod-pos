// 🔴 2026-05-20 (Khushi LIVE-NIGHT) — WAITLIST TAB
// First-come-first-served queue with hybrid auto-match (Option C).
// Shows: name · pax · phone · ref · ⏱ waited · 📞 CALL · 📲 WA · ✅ SEAT · ❌
// Live subscription to Firestore — instantly syncs across Door & Captain.
import { useEffect, useState } from "react";
import {
  subscribeWaitlist, removeFromWaitlist, getTableCapacity,
  WAITLIST_PRIORITY_MIN,
  type HodWaitlistEntry,
} from "@/lib/firestore-hod";

function minsAgo(iso: string): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

function fmtWaited(iso: string): string {
  const m = minsAgo(iso);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function WaitlistView({ date }: { date: string }) {
  const [rows, setRows] = useState<HodWaitlistEntry[]>([]);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!date) return;
    const unsub = subscribeWaitlist(date, setRows);
    return () => unsub();
  }, [date]);

  // Tick every 30s so "waited" labels stay fresh.
  useEffect(() => {
    const h = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(h);
  }, []);

  const active = rows.filter((r) => r.status === "waiting" || r.status === "offered");
  const history = rows.filter((r) => r.status === "seated" || r.status === "cancelled" || r.status === "no-show");

  const handleRemove = async (id: string, reason: "cancelled" | "no-show") => {
    if (!confirm(reason === "cancelled" ? "Remove this party from the waitlist?" : "Mark as no-show?")) return;
    try { await removeFromWaitlist(id, reason); }
    catch (e: any) { alert("Failed: " + (e?.message || "unknown")); }
  };

  if (rows.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: "center", border: "1.5px dashed rgba(200,166,69,0.45)", borderRadius: 12, background: "rgba(200,166,69,0.04)" }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>🪑</div>
        <div style={{ color: "#F2C744", fontWeight: 900, fontSize: 16, letterSpacing: ".5px" }}>WAITLIST EMPTY</div>
        <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>
          When all tables are blocked, tap <b style={{ color: "#C8A645" }}>ADD TO WAITLIST</b> in the booking modal.<br/>
          As tables free up, the door girl gets a popup matching the next-in-line party.
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Active queue */}
      <div style={{ marginBottom: 12, padding: "10px 12px", border: "2px solid #C8A645", borderRadius: 10, background: "rgba(200,166,69,0.08)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 18, fontWeight: 900, color: "#F2C744" }}>
            ⏳ WAITING NOW
          </div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#F2C744" }}>{active.length}</div>
        </div>
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.55)", marginTop: 2 }}>
          First-come-first-served. Anyone over {WAITLIST_PRIORITY_MIN} min waits gets priority match.
        </div>
      </div>

      {active.map((r, i) => {
        const waited = minsAgo(r.joinedAt);
        const isPriority = waited > WAITLIST_PRIORITY_MIN;
        const isOffered = r.status === "offered";
        const offeredBy = (r as any).offeredBy as string | undefined;
        return (
          <div key={r._docId}
            style={{
              border: `2px solid ${isOffered ? "#22C55E" : isPriority ? "#EF4444" : "#C8A645"}`,
              borderRadius: 10, padding: 10, marginBottom: 8,
              background: isOffered ? "rgba(34,197,94,0.1)" : isPriority ? "rgba(239,68,68,0.06)" : "rgba(0,0,0,0.4)",
            }}>
            {isOffered && offeredBy && (
              <div style={{ marginBottom: 6, fontSize: 10, color: "#22C55E", fontWeight: 800, letterSpacing: ".5px" }}>
                🔒 OFFER CLAIMED BY {offeredBy}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ background: "#C8A645", color: "#0A0A0A", padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 900 }}>
                    #{i + 1}
                  </span>
                  <span style={{ color: "#FFFFFF", fontSize: 16, fontWeight: 900, letterSpacing: ".3px" }}>
                    {r.customerName}
                  </span>
                  <span style={{ background: "rgba(200,166,69,0.2)", color: "#F2C744", padding: "2px 8px", borderRadius: 6, fontSize: 12, fontWeight: 900 }}>
                    {r.partySize}p
                  </span>
                  {isOffered && (
                    <span style={{ background: "#22C55E", color: "#0A0A0A", padding: "2px 8px", borderRadius: 6, fontSize: 10, fontWeight: 900, letterSpacing: ".5px" }}>
                      🟢 TABLE OFFERED ({r.offeredTableId})
                    </span>
                  )}
                  {isPriority && !isOffered && (
                    <span style={{ background: "#EF4444", color: "#FFFFFF", padding: "2px 8px", borderRadius: 6, fontSize: 10, fontWeight: 900, letterSpacing: ".5px" }}>
                      ⚠️ PRIORITY
                    </span>
                  )}
                </div>
                <div style={{ marginTop: 5, fontSize: 12, color: "rgba(255,255,255,0.7)", letterSpacing: ".2px" }}>
                  📱 {r.phone} · 🎫 {r.bookingRef} · ⏱ {fmtWaited(r.joinedAt)}
                  {r.preferredFloor && <> · 🏢 {r.preferredFloor}</>}
                </div>
                {r.notes && (
                  <div style={{ marginTop: 4, fontSize: 11, color: "rgba(255,255,255,0.5)", fontStyle: "italic" }}>
                    📝 {r.notes}
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginTop: 10 }}>
              <a href={`tel:${r.phone.replace(/\D/g, "")}`}
                style={{ padding: "10px 6px", borderRadius: 8, background: "#22C55E", border: "none", color: "#0A0A0A", fontSize: 12, fontWeight: 900, textAlign: "center", textDecoration: "none", letterSpacing: ".3px" }}>
                📞 CALL
              </a>
              <a href={`https://wa.me/${r.phone.replace(/\D/g, "").replace(/^91?/, "91")}?text=${encodeURIComponent(`🪑 HOD: Hi ${r.customerName}, your table is being arranged. Please come to the door. — ${r.bookingRef}`)}`}
                target="_blank" rel="noreferrer"
                style={{ padding: "10px 6px", borderRadius: 8, background: "#25D366", border: "none", color: "#FFFFFF", fontSize: 12, fontWeight: 900, textAlign: "center", textDecoration: "none", letterSpacing: ".3px" }}>
                📲 WA
              </a>
              <button onClick={() => r._docId && handleRemove(r._docId, "cancelled")}
                style={{ padding: "10px 6px", borderRadius: 8, background: "transparent", border: "1.5px solid #EF4444", color: "#EF4444", fontSize: 11, fontWeight: 900, cursor: "pointer", letterSpacing: ".3px" }}>
                ❌ REMOVE
              </button>
            </div>
          </div>
        );
      })}

      {history.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: "pointer", color: "rgba(255,255,255,0.55)", fontSize: 11, fontWeight: 800, letterSpacing: ".5px", textTransform: "uppercase" }}>
            ✅ HISTORY ({history.length}) — seated / cancelled / no-show
          </summary>
          <div style={{ marginTop: 8 }}>
            {history.map((r) => (
              <div key={r._docId} style={{ padding: "8px 10px", borderRadius: 8, marginBottom: 6, background: "rgba(255,255,255,0.04)", fontSize: 11, color: "rgba(255,255,255,0.7)" }}>
                <b>{r.customerName}</b> · {r.partySize}p · {r.bookingRef} · {" "}
                {r.status === "seated" ? `✅ Seated at ${r.seatedTableId}` :
                 r.status === "cancelled" ? "❌ Cancelled" : "👻 No-show"}
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Footer — capacity legend reminder */}
      <div style={{ marginTop: 14, padding: 10, borderRadius: 8, background: "rgba(200,166,69,0.04)", border: "1px dashed rgba(200,166,69,0.3)", fontSize: 10, color: "rgba(255,255,255,0.55)", lineHeight: 1.6 }}>
        💡 When Captain releases a table, the door girl gets a 60-sec popup with the best match.
        Algorithm = capacity-efficient FCFS, with priority bump after {WAITLIST_PRIORITY_MIN} min.
        Table capacities are auto-detected from venue layout.
        <span style={{ display: "none" }}>{getTableCapacity("T1")}</span>
      </div>
    </div>
  );
}
