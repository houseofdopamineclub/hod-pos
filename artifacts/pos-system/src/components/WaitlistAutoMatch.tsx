// 🔴 2026-05-20 (Khushi LIVE-NIGHT) — WAITLIST AUTO-MATCH POPUP
// Watches table reservations + waitlist on the Door tablet.
// When an active reservation transitions to a terminal status (table freed),
// we run findBestWaitlistMatch and pop a 60-sec confirm modal.
//
// 🔒 Cross-tablet safety (added after architect review 20 May 2026):
//   1. We tryClaimWaitlistOffer in a Firestore transaction BEFORE showing the
//      popup. If another tablet already claimed the party, our popup never
//      opens — the offered status is mirrored in WaitlistView with the
//      owning tablet name.
//   2. Freed tables are queued, not dropped. If a 2nd table frees while
//      the popup is open, we offer it next.
//   3. We require at least one good snapshot before computing freed deltas,
//      and we ignore subscription error events (which come through as empty
//      arrays from subscribeToHodReservations).
//   4. On unmount / skip / timeout we releaseWaitlistOffer so another
//      tablet can pick up the party. Fail-open: never block the queue.
import { useEffect, useRef, useState } from "react";
import {
  subscribeWaitlist, subscribeToHodReservations,
  findBestWaitlistMatch, markWaitlistSeated,
  tryClaimWaitlistOffer, releaseWaitlistOffer,
  getTableCapacity,
  type HodWaitlistEntry, type HodTableReservation,
} from "@/lib/firestore-hod";

type Offer = { freedTableId: string; entry: HodWaitlistEntry };

// "Active" = a reservation still occupies the table. Once status moves to
// any of these terminal values we treat the table as freed.
const FREED_STATUSES = new Set([
  "left", "cancelled", "no-show", "completed", "closed", "voided", "paid",
]);

function isActive(r: HodTableReservation): boolean {
  const s = String((r as any).status || "").toLowerCase();
  if (!s) return true;                  // unknown → assume still active
  return !FREED_STATUSES.has(s);
}

// Persist a tablet ID per browser so cross-tablet ownership has a stable key.
function getTabletOwnerId(): string {
  try {
    let id = localStorage.getItem("hod_tablet_id");
    if (!id) {
      id = "T-" + Math.random().toString(36).slice(2, 8).toUpperCase();
      localStorage.setItem("hod_tablet_id", id);
    }
    const staff = sessionStorage.getItem("hod_door_staff") || "DOOR";
    return `${staff}/${id}`;
  } catch { return "DOOR/anon"; }
}

export default function WaitlistAutoMatch({ date }: { date: string }) {
  const [waitlist, setWaitlist] = useState<HodWaitlistEntry[]>([]);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(60);

  const prevActiveTablesRef = useRef<Set<string> | null>(null);
  const haveFirstSnapshotRef = useRef(false);
  const freedQueueRef = useRef<string[]>([]);
  const waitlistRef = useRef<HodWaitlistEntry[]>([]);
  const offerRef = useRef<Offer | null>(null);
  const tabletOwner = useRef<string>(getTabletOwnerId()).current;
  const releaseOnUnmountRef = useRef<{ id: string } | null>(null);

  useEffect(() => { waitlistRef.current = waitlist; }, [waitlist]);
  useEffect(() => {
    offerRef.current = offer;
    releaseOnUnmountRef.current = offer ? { id: offer.entry._docId || "" } : null;
  }, [offer]);

  // Subscribe to waitlist — used by both the popup and the auto-match logic.
  useEffect(() => {
    if (!date) return;
    const unsub = subscribeWaitlist(date, setWaitlist);
    return () => unsub();
  }, [date]);

  // Try to surface the next offer from the freed-table queue. Walks queue
  // and waitlist until it finds a match it can claim transactionally.
  const tryShowNextOffer = async () => {
    if (offerRef.current) return;             // popup already open
    while (freedQueueRef.current.length > 0) {
      const tid = freedQueueRef.current.shift()!;
      const cap = getTableCapacity(tid);
      if (cap <= 0) continue;
      // Re-query each loop — waitlist may have changed mid-iteration.
      let match = findBestWaitlistMatch(cap, waitlistRef.current);
      // Walk candidates in case the top match has been claimed by another tablet.
      const tried = new Set<string>();
      while (match && match._docId && !tried.has(match._docId)) {
        tried.add(match._docId);
        const claimed = await tryClaimWaitlistOffer(match._docId, tid, tabletOwner);
        if (claimed) {
          setOffer({ freedTableId: tid, entry: match });
          setSecondsLeft(60);
          try { (navigator as any).vibrate?.([200, 100, 200]); } catch {}
          return;
        }
        // Someone else got that party — try the next one for this same table.
        const remaining = waitlistRef.current.filter((w) => !tried.has(w._docId || ""));
        match = findBestWaitlistMatch(cap, remaining);
      }
    }
  };

  // Subscribe to reservations and detect freed tables.
  useEffect(() => {
    if (!date) return;
    const unsub = subscribeToHodReservations(date, (rows: HodTableReservation[]) => {
      // Guard: subscribeToHodReservations emits cb([]) on subscription errors.
      // We can't reliably distinguish "no docs" from "snapshot error" without
      // upstream changes, so on an empty payload we DON'T trust it as a
      // diff source — just bail. Worst case: we wait one good snapshot.
      if (rows.length === 0 && haveFirstSnapshotRef.current) return;

      const activeNow = new Set<string>();
      rows.forEach((r) => {
        const tid = (r as any).tableId;
        if (tid && isActive(r)) activeNow.add(tid);
      });
      const prev = prevActiveTablesRef.current;
      prevActiveTablesRef.current = activeNow;
      // First snapshot — establish baseline only. No "freed" yet.
      if (!haveFirstSnapshotRef.current) {
        haveFirstSnapshotRef.current = true;
        return;
      }
      if (!prev) return;
      const newlyFreed: string[] = [];
      prev.forEach((tid) => { if (!activeNow.has(tid)) newlyFreed.push(tid); });
      if (newlyFreed.length === 0) return;
      // Append to queue (avoid duplicates) — fires after to keep state sane.
      newlyFreed.forEach((tid) => {
        if (!freedQueueRef.current.includes(tid)) freedQueueRef.current.push(tid);
      });
      // Fire-and-forget — async claim attempt
      void tryShowNextOffer();
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  // Countdown — auto-skip (fail-open) on timeout.
  useEffect(() => {
    if (!offer) return;
    setSecondsLeft(60);
    const handle = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(handle);
          void handleSkip("timeout");
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer?.entry._docId, offer?.freedTableId]);

  // Release the claim if the tablet unmounts (logout / nav away) while a
  // popup is open. Prevents a party from getting stuck in "offered" forever.
  useEffect(() => {
    return () => {
      const pending = releaseOnUnmountRef.current;
      if (pending?.id) void releaseWaitlistOffer(pending.id, tabletOwner);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSkip = async (_reason: "manual" | "timeout") => {
    const cur = offerRef.current;
    setOffer(null);
    if (cur?.entry._docId) {
      // Release first (re-opens to other tablets), then try our own queue.
      await releaseWaitlistOffer(cur.entry._docId, tabletOwner);
      // Put the same table back at the head of OUR queue so we try the
      // next candidate locally too (in case there are more freed tables).
      if (!freedQueueRef.current.includes(cur.freedTableId)) {
        freedQueueRef.current.unshift(cur.freedTableId);
      }
    }
    void tryShowNextOffer();
  };

  const handleConfirm = async () => {
    const cur = offerRef.current;
    if (!cur || !cur.entry._docId) return;
    try {
      await markWaitlistSeated(cur.entry._docId, cur.freedTableId);
      setOffer(null);
      // After seating, drain any remaining freed tables for other parties.
      void tryShowNextOffer();
    } catch (e: any) {
      alert("Failed to mark seated: " + (e?.message || "unknown") + ". Reservation NOT updated — re-assign manually in TABLES tab.");
    }
  };

  if (!offer) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 9999,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div style={{
        width: "100%", maxWidth: 420, background: "#0A0A0A",
        border: "3px solid #22C55E", borderRadius: 16, padding: 18,
        boxShadow: "0 0 40px rgba(34,197,94,0.4)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 900, color: "#22C55E" }}>
            🪑 TABLE FREE
          </div>
          <div style={{
            background: secondsLeft <= 10 ? "#EF4444" : "#C8A645", color: "#0A0A0A",
            padding: "4px 10px", borderRadius: 8, fontSize: 14, fontWeight: 900,
          }}>
            ⏱ {secondsLeft}s
          </div>
        </div>

        <div style={{
          padding: 12, background: "rgba(34,197,94,0.08)", border: "1.5px solid rgba(34,197,94,0.4)",
          borderRadius: 10, marginBottom: 12,
        }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", fontWeight: 800, letterSpacing: ".5px", marginBottom: 4 }}>
            TABLE JUST FREED
          </div>
          <div style={{ fontSize: 26, fontWeight: 900, color: "#22C55E", letterSpacing: ".5px" }}>
            {offer.freedTableId} <span style={{ fontSize: 14, color: "rgba(255,255,255,0.7)", fontWeight: 700 }}>· seats {getTableCapacity(offer.freedTableId)}</span>
          </div>
        </div>

        <div style={{
          padding: 12, background: "rgba(200,166,69,0.06)", border: "2px solid #C8A645",
          borderRadius: 10, marginBottom: 14,
        }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", fontWeight: 800, letterSpacing: ".5px", marginBottom: 4 }}>
            NEXT IN LINE
          </div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#FFFFFF", letterSpacing: ".3px" }}>
            {offer.entry.customerName}
          </div>
          <div style={{ marginTop: 4, fontSize: 13, color: "rgba(255,255,255,0.8)" }}>
            🧑‍🤝‍🧑 {offer.entry.partySize} pax · 📱 {offer.entry.phone}
          </div>
          <div style={{ marginTop: 2, fontSize: 11, color: "rgba(255,255,255,0.55)" }}>
            🎫 {offer.entry.bookingRef}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
          <a href={`tel:${offer.entry.phone.replace(/\D/g, "")}`}
            style={{ padding: "12px 4px", borderRadius: 8, background: "#22C55E", color: "#0A0A0A", fontSize: 12, fontWeight: 900, textAlign: "center", textDecoration: "none" }}>
            📞 CALL
          </a>
          <a href={`https://wa.me/${offer.entry.phone.replace(/\D/g, "").replace(/^91?/, "91")}?text=${encodeURIComponent(`🪑 HOD: Your table ${offer.freedTableId} is ready! Please come to the door now. — ${offer.entry.bookingRef}`)}`}
            target="_blank" rel="noreferrer"
            style={{ padding: "12px 4px", borderRadius: 8, background: "#25D366", color: "#FFFFFF", fontSize: 12, fontWeight: 900, textAlign: "center", textDecoration: "none" }}>
            📲 WA
          </a>
          <button onClick={() => handleSkip("manual")}
            style={{ padding: "12px 4px", borderRadius: 8, background: "transparent", border: "1.5px solid rgba(239,68,68,.6)", color: "#EF4444", fontSize: 11, fontWeight: 900, cursor: "pointer" }}>
            ⏭ SKIP
          </button>
        </div>

        <button onClick={handleConfirm}
          style={{
            width: "100%", padding: 16, borderRadius: 10,
            background: "#22C55E", border: "none", color: "#0A0A0A",
            fontSize: 15, fontWeight: 900, letterSpacing: ".5px", cursor: "pointer",
          }}>
          ✅ CONFIRM SEAT AT {offer.freedTableId}
        </button>

        <div style={{ marginTop: 10, fontSize: 10, color: "rgba(255,255,255,0.45)", textAlign: "center", lineHeight: 1.5 }}>
          If no action in {secondsLeft}s — auto-skips to next party (fail-open).<br/>
          ⚠️ Fallback: if Firestore is offline, mark seated manually in TABLES tab.
        </div>
      </div>
    </div>
  );
}
