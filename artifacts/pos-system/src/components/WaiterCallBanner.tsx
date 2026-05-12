import { useEffect, useRef, useState } from "react";
import {
  subscribeActiveWaiterCalls,
  acknowledgeWaiterCall,
  type WaiterCall,
} from "@/lib/firestore-hod";

/**
 * 🛎 Live "Call Waiter" listener for staff modes.
 *
 * Subscribes to Firestore `waiterCalls` and renders a sticky red banner
 * at the top of the screen whenever a customer's wallet (hodclub.in)
 * fires the Call Waiter button. Plays a Web Audio beep on each NEW
 * pending call so staff hear it even if the tablet is locked-screen
 * or the page is scrolled. One-tap "ACK" dismisses the call (stamped
 * with the staff name so a second tablet sees who responded).
 *
 * Mounted at the top of BarMode and CaptainMode (both should hear).
 */
export function WaiterCallBanner({ staffName, role }: { staffName: string; role: "bar" | "captain" }) {
  const [calls, setCalls] = useState<WaiterCall[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const firstSnapshotRef = useRef<boolean>(true);
  const audioRef = useRef<AudioContext | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Beep — same shape as CaptainMode's useAudioAlert(true) so it's already
  // familiar to staff. Triple-tone urgent ring (660 → 880 → 1100 Hz).
  const beep = () => {
    try {
      if (!audioRef.current) audioRef.current = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const ctx = audioRef.current;
      [660, 880, 1100].forEach((freq, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.frequency.value = freq;
        o.start(ctx.currentTime + i * 0.18);
        g.gain.setValueAtTime(0.32, ctx.currentTime + i * 0.18);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.35);
        o.stop(ctx.currentTime + i * 0.18 + 0.35);
      });
    } catch {}
  };

  useEffect(() => {
    return subscribeActiveWaiterCalls((next) => {
      // Beep ONLY for pending calls we haven't seen before. The very first
      // snapshot from Firestore is treated as "already seen" (we seed
      // seenRef with its IDs) so a tablet opening to existing pending
      // calls doesn't fire a stale beep. Subsequent snapshots beep on
      // any never-before-seen pending id. The flag is a ref (not derived
      // from `calls`) because the captured `calls` here is the closure
      // value at subscription time and would always read [].
      const isFirstSnapshot = firstSnapshotRef.current;
      firstSnapshotRef.current = false;
      next.forEach((c) => {
        if (c.status === "pending" && !seenRef.current.has(c.id)) {
          seenRef.current.add(c.id);
          if (!isFirstSnapshot) beep();
        }
      });
      // Garbage-collect IDs no longer in the active set so a new call with
      // the same id (impossible in practice, but cheap insurance) can re-beep.
      const live = new Set(next.map((c) => c.id));
      seenRef.current.forEach((id) => { if (!live.has(id)) seenRef.current.delete(id); });
      setCalls(next);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-ring every 15 s while ANY call is still pending — staff should never
  // miss this. Stops automatically when last pending call is ack'd.
  // Hook MUST run on every render (Rules of Hooks) so it lives ABOVE the
  // empty-state early return. Re-uses the same `beep` closure as the
  // first-snapshot listener.
  useEffect(() => {
    const anyPending = calls.some((c) => c.status === "pending");
    if (!anyPending) return;
    const id = setInterval(() => {
      if (calls.some((c) => c.status === "pending")) beep();
    }, 15_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calls]);

  if (calls.length === 0) return null;

  const ack = async (id: string) => {
    setBusyId(id);
    try { await acknowledgeWaiterCall(id, staffName); }
    catch (e) { console.error("[WaiterCallBanner] ack failed", e); }
    setBusyId(null);
  };

  return (
    <div style={{
      position: "sticky", top: 0, zIndex: 50,
      display: "flex", flexDirection: "column", gap: 6,
      padding: "8px 10px",
      background: "linear-gradient(180deg,#0A0A0A 0%, rgba(10,10,10,.96) 100%)",
      borderBottom: "1px solid rgba(184,50,39,.5)",
    }}>
      {calls.map((c) => {
        const isAck = c.status === "acknowledged";
        return (
          <div key={c.id}
            className={isAck ? "" : "pulse-red"}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 10, padding: "10px 14px", borderRadius: 12,
              background: isAck ? "rgba(0,200,100,.10)" : "rgba(184,50,39,.18)",
              border: `1.5px solid ${isAck ? "rgba(0,200,100,.5)" : "#B83227"}`,
              fontFamily: "'Space Grotesk', sans-serif",
            }}>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 900, color: isAck ? "#00C864" : "#F2C744",
                  letterSpacing: 0.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {isAck ? "✓ ACK" : "🛎 CALL WAITER"} · {c.customerName}
              </div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,.7)",
                  marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.tableId ? `Table ${c.tableId}` : "No table"}
                {c.floorLabel ? ` · ${c.floorLabel}` : ""}
                {" · "}
                {c.coverRef}
                {isAck && c.acknowledgedBy ? ` · by ${c.acknowledgedBy}` : ""}
              </div>
            </div>
            {!isAck && (
              <button
                onClick={() => ack(c.id)}
                disabled={busyId === c.id}
                style={{
                  flexShrink: 0,
                  padding: "8px 16px", borderRadius: 10,
                  background: "#F2C744",
                  border: "none",
                  color: "#0A0A0A", fontSize: 12, fontWeight: 900, letterSpacing: 1,
                  cursor: busyId === c.id ? "wait" : "pointer",
                  fontFamily: "'Space Grotesk', sans-serif",
                }}>
                {busyId === c.id ? "..." : `ACK · ${role === "bar" ? "BAR" : "CAP"}`}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default WaiterCallBanner;
