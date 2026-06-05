// 🔴 2026-05-20 (Khushi LIVE-NIGHT) — WAITLIST TAB
// First-come-first-served queue with hybrid auto-match (Option C).
// 🎨 2026-06-02 (Khushi) — GUMROAD-BRUTALIST restyle + big LIVE timer per party,
// CALL / ASSIGN TABLE / REMOVE CTAs, in-app confirms (NO browser popups), and a
// WhatsApp notification fired to the guest the moment a table is assigned.
// Live subscription to Firestore — instantly syncs across Door & Captain.
import { useEffect, useRef, useState } from "react";
import {
  subscribeWaitlist, removeFromWaitlist, markWaitlistSeated,
  subscribeToHodReservations, createWalkInTableReservation,
  WAITLIST_PRIORITY_MIN,
  type HodWaitlistEntry, type HodTableReservation,
} from "@/lib/firestore-hod";
import { centeredAlert } from "@/lib/centered-ui";
import { sendWhatsAppViaMetaShared } from "@/lib/wa-send";
import {
  DOOR_TABLE_OPTIONS, doorProxyLabel, doorTableCapacity,
  doorFloorForTable, doorNowMinutesIST, doorTableOccupantAt,
} from "@/lib/door-tables";

// ─── Gumroad-brutalist palette ───────────────────────────────────────────────
const SURFACE = "#F4F4F0";
const WHITE   = "#FFFFFF";
const INK     = "#000000";
const PINK    = "#FF90E8";
const TEAL    = "#23A094";
const YELLOW  = "#FFD700";
const ERROR   = "#FF5733";
const MUTED   = "#6B6B6B";
const FONT    = "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";

function minsAgo(iso: string): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

// Big running timer — h/m/s. Updates every second so it visibly ticks.
function fmtTimer(iso: string): string {
  if (!iso) return "0m 00s";
  const totalSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// Human-friendly date for the WhatsApp message ("Monday, 2 June 2026").
// Accepts YYYY-MM-DD; falls back to the raw string if unparseable.
function formatDateNice(raw?: string): string {
  if (!raw) return "Today";
  const d = new Date(raw.length === 10 ? `${raw}T00:00:00` : raw);
  if (isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

// Current IST clock "HH:MM" (5-min ceil) for the assigned booking's arrival.
function nowArrivalIST(): string {
  const d = new Date();
  let h = d.getHours();
  let m = Math.ceil(d.getMinutes() / 5) * 5;
  if (m >= 60) { m = 0; h = (h + 1) % 24; }
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ─── Table picker groups (assign-a-table) ────────────────────────────────────
// Shares the EXACT door config (DOOR_TABLE_OPTIONS) + availability logic
// (doorTableOccupantAt) so the waitlist picker shows the SAME real-time floor
// state the door table-picker shows.
// 🆕 2026-06-02 (Khushi) — mirror the DOOR picker's proven colour scheme instead
// of the old pink(fits)/white(too-small) encoding she misread as available/taken:
// every table is shown, GREEN = free now (selectable), RED 🔒 = taken (disabled).
// "Fits the party" is a secondary text hint, not a colour, so a free-but-small
// table is never mistaken for an unavailable one.
type PickTable = {
  id: string; cap: number; isProxy: boolean;
  occupied: boolean; occupant: HodTableReservation | null;
};
function tablePickerGroups(
  reservations: HodTableReservation[],
): { floor: string; label: string; tables: PickTable[] }[] {
  const nowMin = doorNowMinutesIST();
  return DOOR_TABLE_OPTIONS.map((g) => ({
    floor: g.floor,
    label: g.label,
    tables: g.tables
      .map((id) => {
        const occupant = doorTableOccupantAt(id, nowMin, reservations);
        return {
          id, cap: doorTableCapacity(id), isProxy: !!doorProxyLabel(id),
          occupied: !!occupant, occupant,
        };
      })
      // FREE first, then real PAX tables by capacity (proxies cap 0 → last).
      .sort((a, b) => {
        if (a.occupied !== b.occupied) return a.occupied ? 1 : -1;
        const ca = a.cap || 999;
        const cb = b.cap || 999;
        return (ca - cb) || a.id.localeCompare(b.id);
      }),
  }));
}

export default function WaitlistView({ date }: { date: string }) {
  const [rows, setRows] = useState<HodWaitlistEntry[]>([]);
  const [reservations, setReservations] = useState<HodTableReservation[]>([]);
  const [, setTick] = useState(0);
  const [pickFor, setPickFor] = useState<HodWaitlistEntry | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const removeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!date) return;
    const unsub = subscribeWaitlist(date, setRows);
    return () => unsub();
  }, [date]);

  // Live reservations for the assign-table availability filter (same source the
  // door table-picker uses → identical real-time availability).
  useEffect(() => {
    if (!date) return;
    const unsub = subscribeToHodReservations(date, setReservations);
    return () => unsub();
  }, [date]);

  // Tick every second so the LIVE timers visibly run.
  useEffect(() => {
    const h = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(h);
  }, []);

  // Auto-reset the 2-tap REMOVE confirm after 4s of inaction.
  useEffect(() => {
    if (!confirmRemove) return;
    removeTimer.current = setTimeout(() => setConfirmRemove(null), 4000);
    return () => { if (removeTimer.current) clearTimeout(removeTimer.current); };
  }, [confirmRemove]);

  const active = rows.filter((r) => r.status === "waiting" || r.status === "offered");
  const history = rows.filter((r) => r.status === "seated" || r.status === "cancelled" || r.status === "no-show");

  const doRemove = async (id: string) => {
    setConfirmRemove(null);
    try {
      await removeFromWaitlist(id, "cancelled");
    } catch (e: any) {
      await centeredAlert("REMOVE FAILED", e?.message || "Please try again.", "error", true);
    }
  };

  const handleAssign = async (entry: HodWaitlistEntry, tableId: string) => {
    if (!entry._docId) return;
    setAssigning(true);
    const friendlyTable = doorProxyLabel(tableId) || tableId;
    const fl = doorFloorForTable(tableId);
    try {
      // 1) CREATE the real table reservation — this is what makes it appear in
      // the TABLES tab and behave like any normal walk-in table booking. Throws
      // on a slot conflict (someone grabbed the table first) → handled below.
      const arrivalTime = nowArrivalIST();
      const refId = await createWalkInTableReservation({
        customerName: entry.customerName,
        phone: entry.phone,
        partySize: entry.partySize,
        date,
        arrivalTime,
        tableId,
        floor: fl?.floor || undefined,
        floorLabel: fl?.label || undefined,
        notes: `Seated from WAITLIST (${entry.bookingRef})${entry.notes ? ` — ${entry.notes}` : ""}`,
        staffName: entry.staffName || "DOOR",
        // 🆕 v3.172 (Khushi) — one-tap seating off the waitlist: auto check-in
        // (guest arrived) + unlock the customer menu, so the door girl doesn't
        // have to do those two steps separately.
        markArrived: true,
        unlockMenu: true,
      });

      // 2) Mark the waitlist entry seated (fail-open — booking already exists).
      try { await markWaitlistSeated(entry._docId, tableId); }
      catch (e) { console.warn("[waitlist] markSeated failed (booking created OK)", e); }

      // 3) WhatsApp the guest the SAME table_confirmed template a normal booking
      // sends (fire-and-forget, fail-open). Reliable outside the 24h window.
      const walletUrl = `https://hodclub.in/?wallet=${encodeURIComponent(refId)}`;
      const dateNice = formatDateNice(date);
      const tableLabelFull = `${friendlyTable}${fl?.label ? ` · ${fl.label}` : ""}`;
      const partySizeStr = String(Math.max(1, entry.partySize));
      const fallbackText =
        `Hi ${entry.customerName}, your HOD table is ready! 🍽️\n\n` +
        `📅 Date: ${dateNice}\n` +
        `🕘 Arrival: ${arrivalTime}\n` +
        `🪑 Table: ${tableLabelFull}\n` +
        `👥 Guests: ${partySizeStr}\n\n` +
        `Please come to the door now — we'll have your table ready.\n\n` +
        `View reservation: ${walletUrl}\n\n` +
        `See you tonight!\n📍 House of Dopamine, Koramangala`;
      void sendWhatsAppViaMetaShared({
        phone: entry.phone,
        template: {
          name: "table_confirmed",
          params: [entry.customerName, dateNice, arrivalTime, friendlyTable, fl?.label || "", partySizeStr, walletUrl],
        },
        fallbackText,
      }).then((res) => {
        if (res.ok) console.log("[waitlist][wa] assign notify", res.via, "→", entry.phone);
        else console.warn("[waitlist][wa] assign notify not sent:", res.error);
      });

      setPickFor(null);
      await centeredAlert(
        "TABLE BOOKED & GUEST SEATED",
        `${entry.customerName} → ${friendlyTable}${fl?.label ? ` · ${fl.label}` : ""}\n\n✅ Checked in (marked arrived)\n✅ Menu unlocked for the guest\n\nShows in the TABLES tab. We've WhatsApp'd the guest to come to the door.`,
        "success",
        true,
      );
    } catch (e: any) {
      await centeredAlert(
        "COULD NOT BOOK TABLE",
        e?.message || "That table may have just been taken. Pick another available table.",
        "error",
        true,
      );
    } finally {
      setAssigning(false);
    }
  };

  // ─── Empty state ───────────────────────────────────────────────────────────
  if (rows.length === 0) {
    return (
      <div style={{ padding: 28, textAlign: "center", border: `2px solid ${INK}`, borderRadius: 8, background: WHITE, fontFamily: FONT }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>🪑</div>
        <div style={{ color: INK, fontWeight: 900, fontSize: 18, letterSpacing: ".5px" }}>WAITLIST EMPTY</div>
        <div style={{ color: MUTED, fontSize: 13, marginTop: 8, lineHeight: 1.6, fontWeight: 600 }}>
          When all tables are full, tap <b style={{ color: INK }}>ADD TO WAITLIST</b> in the booking modal.<br/>
          Parties show here with a live timer — and the door girl gets a popup the moment a table opens.
        </div>
      </div>
    );
  }

  const tableGroups = tablePickerGroups(reservations);
  const freeCount = tableGroups.reduce((n, g) => n + g.tables.filter((t) => !t.occupied).length, 0);
  const takenCount = tableGroups.reduce((n, g) => n + g.tables.filter((t) => t.occupied).length, 0);

  return (
    <div style={{ fontFamily: FONT }}>
      {/* WAITING NOW header */}
      <div style={{ marginBottom: 12, padding: "12px 14px", border: `2px solid ${INK}`, borderRadius: 8, background: YELLOW }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 900, color: INK, letterSpacing: ".5px" }}>
            ⏳ WAITING NOW
          </div>
          <div style={{ fontSize: 24, fontWeight: 900, color: INK, background: WHITE, border: `2px solid ${INK}`, borderRadius: 6, minWidth: 42, textAlign: "center", padding: "2px 8px" }}>
            {active.length}
          </div>
        </div>
        <div style={{ fontSize: 11, color: INK, marginTop: 4, fontWeight: 600 }}>
          First-come-first-served. Anyone waiting over {WAITLIST_PRIORITY_MIN} min gets priority.
        </div>
      </div>

      {active.map((r, i) => {
        const waited = minsAgo(r.joinedAt);
        const isPriority = waited > WAITLIST_PRIORITY_MIN;
        const isOffered = r.status === "offered";
        const offeredBy = (r as any).offeredBy as string | undefined;
        const accent = isOffered ? TEAL : isPriority ? ERROR : INK;
        return (
          <div key={r._docId}
            style={{
              border: `2px solid ${INK}`, borderLeft: `8px solid ${accent}`,
              borderRadius: 8, padding: 12, marginBottom: 10, background: WHITE,
            }}>
            {isOffered && offeredBy && (
              <div style={{ marginBottom: 8, fontSize: 11, color: TEAL, fontWeight: 900, letterSpacing: ".5px" }}>
                🔒 OFFER CLAIMED BY {offeredBy}
              </div>
            )}

            {/* Name + badges */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
              <span style={{ background: INK, color: WHITE, padding: "3px 9px", borderRadius: 6, fontSize: 12, fontWeight: 900 }}>
                #{i + 1}
              </span>
              <span style={{ color: INK, fontSize: 20, fontWeight: 900, letterSpacing: ".3px" }}>
                {r.customerName}
              </span>
              <span style={{ background: PINK, color: INK, border: `2px solid ${INK}`, padding: "2px 9px", borderRadius: 6, fontSize: 12, fontWeight: 900 }}>
                {r.partySize}P
              </span>
              {isOffered && (
                <span style={{ background: TEAL, color: WHITE, border: `2px solid ${INK}`, padding: "2px 8px", borderRadius: 6, fontSize: 10, fontWeight: 900, letterSpacing: ".5px" }}>
                  🟢 TABLE OFFERED ({r.offeredTableId})
                </span>
              )}
              {isPriority && !isOffered && (
                <span style={{ background: ERROR, color: WHITE, border: `2px solid ${INK}`, padding: "2px 8px", borderRadius: 6, fontSize: 10, fontWeight: 900, letterSpacing: ".5px" }}>
                  ⚠️ PRIORITY
                </span>
              )}
            </div>

            {/* Phone + ref */}
            <div style={{ fontSize: 13, color: INK, fontWeight: 700, marginBottom: 8 }}>
              📱 {r.phone} · 🎫 {r.bookingRef}
              {r.preferredFloor && <> · 🏢 {r.preferredFloor}</>}
            </div>
            {r.notes && (
              <div style={{ fontSize: 12, color: MUTED, fontStyle: "italic", marginBottom: 8 }}>
                📝 {r.notes}
              </div>
            )}

            {/* BIG live timer */}
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              background: SURFACE, border: `2px solid ${INK}`, borderRadius: 6, padding: "10px 12px", marginBottom: 10,
            }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: MUTED, letterSpacing: ".5px" }}>⏱ WAITING</span>
              <span style={{ fontSize: 30, fontWeight: 900, color: isPriority ? ERROR : INK, letterSpacing: "1px", fontVariantNumeric: "tabular-nums" }}>
                {fmtTimer(r.joinedAt)}
              </span>
            </div>

            {/* CTAs: CALL · ASSIGN TABLE · REMOVE */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <a href={`tel:${r.phone.replace(/\D/g, "")}`}
                style={{ padding: "12px 6px", borderRadius: 6, background: TEAL, border: `2px solid ${INK}`, color: WHITE, fontSize: 13, fontWeight: 900, textAlign: "center", textDecoration: "none", letterSpacing: ".3px" }}>
                📞 CALL
              </a>
              <button onClick={() => setPickFor(r)}
                style={{ padding: "12px 6px", borderRadius: 6, background: PINK, border: `2px solid ${INK}`, color: INK, fontSize: 13, fontWeight: 900, cursor: "pointer", letterSpacing: ".3px" }}>
                🪑 ASSIGN TABLE
              </button>
              <button onClick={() => (confirmRemove === r._docId ? doRemove(r._docId!) : setConfirmRemove(r._docId || null))}
                style={{ padding: "12px 6px", borderRadius: 6, background: confirmRemove === r._docId ? ERROR : WHITE, border: `2px solid ${INK}`, color: confirmRemove === r._docId ? WHITE : ERROR, fontSize: confirmRemove === r._docId ? 11 : 13, fontWeight: 900, cursor: "pointer", letterSpacing: ".3px" }}>
                {confirmRemove === r._docId ? "TAP AGAIN" : "✕ REMOVE"}
              </button>
            </div>
          </div>
        );
      })}

      {/* History */}
      {history.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: "pointer", color: MUTED, fontSize: 12, fontWeight: 800, letterSpacing: ".5px", textTransform: "uppercase" }}>
            ✅ HISTORY ({history.length}) — seated / cancelled / no-show
          </summary>
          <div style={{ marginTop: 8 }}>
            {history.map((r) => (
              <div key={r._docId} style={{ padding: "9px 11px", borderRadius: 6, marginBottom: 6, background: WHITE, border: `2px solid ${INK}`, fontSize: 12, color: INK, fontWeight: 600 }}>
                <b>{r.customerName}</b> · {r.partySize}P · {r.bookingRef} · {" "}
                {r.status === "seated" ? `✅ Seated at ${r.seatedTableId}` :
                 r.status === "cancelled" ? "✕ Cancelled" : "👻 No-show"}
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Footer note */}
      <div style={{ marginTop: 14, padding: 11, borderRadius: 6, background: WHITE, border: `2px solid ${INK}`, fontSize: 11, color: MUTED, lineHeight: 1.6, fontWeight: 600 }}>
        💡 When a table frees, the door girl gets a 60-sec popup with the best match.
        You can also tap <b style={{ color: INK }}>ASSIGN TABLE</b> any time — the guest is WhatsApp'd instantly.
      </div>

      {/* ─── ASSIGN-TABLE picker overlay (in-app, no browser popup) ─── */}
      {pickFor && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: FONT }}>
          <div style={{ width: "100%", maxWidth: 440, maxHeight: "88vh", overflowY: "auto", background: SURFACE, border: `2px solid ${INK}`, borderRadius: 8, padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div style={{ fontSize: 18, fontWeight: 900, color: INK }}>🪑 ASSIGN A TABLE</div>
              <button onClick={() => !assigning && setPickFor(null)}
                style={{ background: WHITE, border: `2px solid ${INK}`, borderRadius: 6, fontSize: 14, fontWeight: 900, color: INK, cursor: "pointer", padding: "4px 10px" }}>✕</button>
            </div>
            <div style={{ fontSize: 13, color: INK, fontWeight: 700, marginBottom: 4 }}>
              {pickFor.customerName} · {pickFor.partySize}P · {pickFor.phone}
            </div>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 10, fontWeight: 600 }}>
              <span style={{ color: TEAL, fontWeight: 900 }}>GREEN = free now</span> (tap to seat) ·{" "}
              <span style={{ color: ERROR, fontWeight: 900 }}>RED 🔒 = taken</span>. Live floor — updates in real time.
              Tables that fit {pickFor.partySize} PAX show a ✓. Picking books the table (shows in TABLES) and WhatsApps the guest.
            </div>
            {/* Live free/taken summary — same wording as the door picker. */}
            <div style={{ fontSize: 12, fontWeight: 900, marginBottom: 14, letterSpacing: ".3px" }}>
              <span style={{ color: TEAL }}>✅ {freeCount} FREE</span>
              &nbsp;·&nbsp;
              <span style={{ color: ERROR }}>🔒 {takenCount} TAKEN</span>
            </div>

            {assigning && (
              <div style={{ textAlign: "center", padding: 16, fontWeight: 900, color: INK }}>BOOKING…</div>
            )}

            {!assigning && freeCount === 0 && (
              <div style={{ textAlign: "center", padding: 20, border: `2px solid ${INK}`, borderRadius: 6, background: WHITE, color: ERROR, fontWeight: 900, fontSize: 14, marginBottom: 14 }}>
                NO TABLES FREE RIGHT NOW<br/>
                <span style={{ color: MUTED, fontWeight: 600, fontSize: 12 }}>Every table is taken — keep the guest waiting and try again when one opens.</span>
              </div>
            )}

            {!assigning && tableGroups.map((g) => (
              <div key={g.floor} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 900, color: MUTED, letterSpacing: ".5px", marginBottom: 6 }}>{g.label}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                  {g.tables.map((t) => {
                    const fits = t.isProxy || t.cap >= pickFor.partySize;
                    const title = t.occupied && t.occupant
                      ? `TAKEN — ${t.occupant.customerName || ""}${t.occupant.arrivalTime ? " @ " + t.occupant.arrivalTime : ""}${t.occupant.partySize ? " · " + t.occupant.partySize + " pax" : ""}`.trim()
                      : "Free — tap to seat this guest here";
                    return (
                      <button key={t.id} type="button" disabled={t.occupied}
                        onClick={() => handleAssign(pickFor, t.id)} title={title}
                        style={{
                          padding: "9px 4px", borderRadius: 6,
                          border: `2px solid ${INK}`,
                          outline: !t.occupied && fits ? `2px solid ${YELLOW}` : "none",
                          outlineOffset: !t.occupied && fits ? "-4px" : 0,
                          background: t.occupied ? ERROR : TEAL,
                          color: WHITE, cursor: t.occupied ? "not-allowed" : "pointer",
                          fontWeight: 900, fontSize: 12, opacity: t.occupied ? 0.85 : 1,
                          display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
                        }}>
                        <span>{t.isProxy ? doorProxyLabel(t.id) : t.id}{t.occupied ? " 🔒" : fits ? " ✓" : ""}</span>
                        <span style={{ fontSize: 9, fontWeight: 700, color: WHITE, opacity: 0.85 }}>
                          {t.occupied ? "TAKEN" : t.isProxy ? "flexible" : `${t.cap} seats`}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
