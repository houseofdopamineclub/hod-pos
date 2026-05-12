import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, RefreshCw } from "lucide-react";
import {
  getRecentBillPrints, getRecentKotPrints,
  type BillAuditRow,
} from "@/lib/firestore-hod";
// We pull voidLog + discountOverrideLog directly off reservation docs via the
// same fetch pipeline that powers getRecentBillPrints (see firestore-hod.ts).
// Each event is normalised below into a single AuditEvent timeline.
import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";

const GOLD = "#C9A84C";

type AuditEvent =
  | { kind: "bill"; at: string; row: BillAuditRow }
  | { kind: "kot"; at: string; id: string; tableId: string; staff: string;
      roundNum: number; itemCount: number; roundTotal: number; destinations: string[];
      isDuplicate: boolean; customerName?: string }
  | { kind: "void"; at: string; tableId: string; by: string; roundNum: number;
      voided: Array<{ n: string; qty: number; p: number }>; valueLost: number; reason?: string;
      // V3 2026-05-10 — enriched audit context (customer + phone + bill-vs-item).
      voidKind?: "bill-void" | "items-void"; customerName?: string; customerPhone?: string;
      notes?: string; billPrintCount?: number }
  | { kind: "override"; at: string; tableId: string; by: string;
      overrideKind: string; valueBefore: number; valueAfter: number; reason: string }
  // V3 anti-fraud #A1 — silent pre-print reduction (no PIN, no slip; just a
  // breadcrumb so admins can spot "added 5, dropped 2 before print" patterns).
  | { kind: "silent-edit"; at: string; tableId: string; by: string; roundNum: number;
      removed: Array<{ n: string; qty: number; p: number }>; valueRemoved: number;
      customerName?: string };

type Filter = "all" | "today" | "duplicates" | "voids" | "overrides" | "kots" | "bills" | "silent-edits";

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("today");
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true); setError("");
    try {
      // Fan out: bills, KOTs, plus a fresh scan for voidLog/discountOverrideLog
      // on recent reservations. We cap each source so no single rogue table
      // can flood the audit page.
      const [bills, kots, reservationEvents] = await Promise.all([
        getRecentBillPrints(500),
        getRecentKotPrints(300),
        fetchRecentReservationAuditEvents(),
      ]);
      const out: AuditEvent[] = [];
      for (const b of bills) out.push({ kind: "bill", at: b.at, row: b });
      for (const k of kots) {
        out.push({
          kind: "kot",
          at: k.createdAt ? new Date(k.createdAt).toISOString() : new Date().toISOString(),
          id: k.id, tableId: k.tableId, staff: k.staff, roundNum: k.roundNum,
          itemCount: k.itemCount, roundTotal: k.roundTotal,
          destinations: k.destinations, isDuplicate: k.isDuplicate,
          customerName: k.customerName,
        });
      }
      out.push(...reservationEvents);
      out.sort((a, b) => (a.at < b.at ? 1 : -1));
      setEvents(out);
    } catch (e: any) { setError(e?.message || String(e)); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const filtered = useMemo(() => events.filter((ev) => {
    if (filter === "today") return new Date(ev.at).getTime() >= todayStart.getTime();
    if (filter === "duplicates") return (ev.kind === "bill" && ev.row.isDuplicate) || (ev.kind === "kot" && ev.isDuplicate);
    if (filter === "voids") return ev.kind === "void";
    if (filter === "overrides") return ev.kind === "override";
    if (filter === "kots") return ev.kind === "kot";
    if (filter === "bills") return ev.kind === "bill";
    if (filter === "silent-edits") return ev.kind === "silent-edit";
    return true;
  }), [events, filter, todayStart]);

  const counts = {
    today: events.filter((e) => new Date(e.at).getTime() >= todayStart.getTime()).length,
    duplicates: events.filter((e) => (e.kind === "bill" && e.row.isDuplicate) || (e.kind === "kot" && e.isDuplicate)).length,
    voids: events.filter((e) => e.kind === "void").length,
    overrides: events.filter((e) => e.kind === "override").length,
    kots: events.filter((e) => e.kind === "kot").length,
    bills: events.filter((e) => e.kind === "bill").length,
    silentEdits: events.filter((e) => e.kind === "silent-edit").length,
  };

  const fmt = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  };

  return (
    <div style={{ minHeight: "100vh", background: "#030305", color: "#fff", fontFamily: "'Space Grotesk',sans-serif", padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <Link href="/" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: GOLD, textDecoration: "none", fontWeight: 700 }}>
          <ArrowLeft size={18} /> Back
        </Link>
        <h1 style={{ fontFamily: "'Playfair Display',serif", fontSize: 24, fontWeight: 900, color: GOLD, margin: 0, flex: 1 }}>
          🔍 Operations Audit
        </h1>
        <button onClick={load} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(201,168,76,.12)", border: `1px solid ${GOLD}`, color: GOLD, padding: "8px 14px", borderRadius: 10, cursor: "pointer", fontWeight: 700 }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {([
          { id: "today", label: `Today (${counts.today})`, color: GOLD },
          { id: "voids", label: `❌ Voids (${counts.voids})`, color: "#EF4444" },
          { id: "silent-edits", label: `🔇 Silent Edits (${counts.silentEdits})`, color: "#F59E0B" },
          { id: "overrides", label: `🔒 Overrides (${counts.overrides})`, color: "#A855F7" },
          { id: "duplicates", label: `⚠ Duplicates (${counts.duplicates})`, color: "#F59E0B" },
          { id: "kots", label: `🍳 KOTs (${counts.kots})`, color: "#6B9BE8" },
          { id: "bills", label: `🖨 Bills (${counts.bills})`, color: GOLD },
          { id: "all", label: `All (${events.length})`, color: GOLD },
        ] as Array<{ id: Filter; label: string; color: string }>).map((t) => (
          <button key={t.id} onClick={() => setFilter(t.id)}
            style={{ padding: "8px 14px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer",
              background: filter === t.id ? t.color : "rgba(255,255,255,.04)",
              color: filter === t.id ? "#000" : "#fff",
              border: `1px solid ${filter === t.id ? t.color : "rgba(255,255,255,.1)"}` }}>
            {t.label}
          </button>
        ))}
      </div>

      {loading && <div style={{ textAlign: "center", padding: 40, color: "rgba(255,255,255,.5)" }}>Loading audit log...</div>}
      {error && <div style={{ background: "rgba(239,68,68,.12)", border: "1px solid #EF4444", color: "#EF4444", padding: 14, borderRadius: 10 }}>Error: {error}</div>}

      {!loading && !error && filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: "rgba(255,255,255,.5)", border: "1px dashed rgba(255,255,255,.1)", borderRadius: 12 }}>
          No matching events.
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((ev, i) => <AuditRow key={`${ev.kind}-${i}`} ev={ev} fmt={fmt} />)}
        </div>
      )}

      <div style={{ marginTop: 24, fontSize: 11, color: "rgba(255,255,255,.35)", textAlign: "center" }}>
        Showing the most recent bill prints, KOT prints, voids, and manager-PIN overrides. Append-only — staff cannot delete.
      </div>
    </div>
  );
}

function AuditRow({ ev, fmt }: { ev: AuditEvent; fmt: (iso: string) => string }) {
  if (ev.kind === "bill") {
    const r = ev.row;
    const isDup = r.isDuplicate;
    const accent = isDup ? "#EF4444" : GOLD;
    return (
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, padding: 14, borderRadius: 12,
        background: isDup ? "rgba(239,68,68,.06)" : "rgba(255,255,255,.03)",
        border: `1px solid ${isDup ? "rgba(239,68,68,.4)" : "rgba(255,255,255,.08)"}` }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 60 }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)" }}>#{r.printIndex}</div>
          <div style={{ fontSize: 24 }}>{isDup ? "⚠️" : "🖨"}</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 900, color: accent }}>{r.billNumber}</span>
            {isDup && <span style={{ background: "rgba(239,68,68,.2)", color: "#EF4444", fontSize: 10, fontWeight: 900, padding: "2px 6px", borderRadius: 4, letterSpacing: .5 }}>DUPLICATE</span>}
            <span style={{ background: r.source === "wallet" ? "rgba(107,155,232,.15)" : "rgba(155,107,232,.15)", color: r.source === "wallet" ? "#6B9BE8" : "#9B6BE8", fontSize: 10, fontWeight: 800, padding: "2px 6px", borderRadius: 4, textTransform: "uppercase" }}>{r.source}</span>
          </div>
          <div style={{ fontSize: 13, color: "#fff", fontWeight: 700, marginBottom: 2 }}>
            {r.ref} {r.customerName && `· ${r.customerName}`}
          </div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,.55)" }}>
            {fmt(r.at)} · by <strong style={{ color: "#fff" }}>{r.by || "unknown"}</strong>
            {r.itemCount > 0 && ` · ${r.itemCount} items`}
          </div>
        </div>
        <div style={{ textAlign: "right", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 900, color: accent }}>₹{r.total.toLocaleString("en-IN")}</div>
        </div>
      </div>
    );
  }
  if (ev.kind === "kot") {
    const accent = ev.isDuplicate ? "#EF4444" : "#6B9BE8";
    return (
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, padding: 14, borderRadius: 12,
        background: "rgba(107,155,232,.05)", border: `1px solid ${ev.isDuplicate ? "rgba(239,68,68,.4)" : "rgba(107,155,232,.2)"}` }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 60 }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)" }}>R{ev.roundNum}</div>
          <div style={{ fontSize: 24 }}>{ev.isDuplicate ? "⚠️" : "🍳"}</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ background: "rgba(107,155,232,.18)", color: "#6B9BE8", fontSize: 10, fontWeight: 900, padding: "2px 6px", borderRadius: 4, letterSpacing: .5 }}>KOT</span>
            {ev.destinations.map((d) => (
              <span key={d} style={{ background: "rgba(255,255,255,.06)", color: "rgba(255,255,255,.7)", fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4 }}>{d}</span>
            ))}
            {ev.isDuplicate && <span style={{ background: "rgba(239,68,68,.2)", color: "#EF4444", fontSize: 10, fontWeight: 900, padding: "2px 6px", borderRadius: 4 }}>REPRINT</span>}
          </div>
          <div style={{ fontSize: 13, color: "#fff", fontWeight: 700, marginBottom: 2 }}>
            {ev.tableId} {ev.customerName && `· ${ev.customerName}`}
          </div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,.55)" }}>
            {fmt(ev.at)} · by <strong style={{ color: "#fff" }}>{ev.staff || "unknown"}</strong> · {ev.itemCount} items
          </div>
        </div>
        <div style={{ textAlign: "right", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 900, color: accent }}>₹{ev.roundTotal.toLocaleString("en-IN")}</div>
        </div>
      </div>
    );
  }
  if (ev.kind === "void") {
    const isBillVoid = ev.voidKind === "bill-void";
    const customerLabel = (ev.customerName || "").trim();
    const phoneLabel = (ev.customerPhone || "").trim();
    return (
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, padding: 14, borderRadius: 12,
        background: isBillVoid ? "rgba(239,68,68,.12)" : "rgba(239,68,68,.08)",
        border: `1px solid ${isBillVoid ? "rgba(239,68,68,.6)" : "rgba(239,68,68,.4)"}`,
        boxShadow: isBillVoid ? "0 0 14px rgba(239,68,68,.18)" : "none" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 60 }}>
          <div style={{ fontSize: 11, color: "rgba(239,68,68,.7)" }}>{isBillVoid ? "BILL" : `R${ev.roundNum}`}</div>
          <div style={{ fontSize: 24 }}>{isBillVoid ? "🚫" : "❌"}</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ background: "rgba(239,68,68,.25)", color: "#EF4444", fontSize: 10, fontWeight: 900, padding: "2px 6px", borderRadius: 4, letterSpacing: .5 }}>
              {isBillVoid ? "BILL VOID" : "ITEMS VOID"}
            </span>
            <span style={{ background: "rgba(255,255,255,.06)", color: "rgba(255,255,255,.7)", fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4 }}>{ev.tableId}</span>
            {customerLabel && <span style={{ background: "rgba(201,168,76,.12)", color: "#C9A84C", fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4 }}>👤 {customerLabel}</span>}
            {phoneLabel && <span style={{ background: "rgba(37,211,102,.12)", color: "#25D366", fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, fontFamily: "monospace" }}>📱 {phoneLabel}</span>}
            {isBillVoid && ev.billPrintCount !== undefined && ev.billPrintCount > 0 && (
              <span style={{ background: "rgba(245,158,11,.15)", color: "#F59E0B", fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4 }}>
                Bill #{ev.billPrintCount} printed
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: "#fff", fontWeight: 700, marginBottom: 2 }}>
            {isBillVoid
              ? `WHOLE BILL VOIDED · ${ev.reason ? ev.reason.toUpperCase() : "—"}`
              : ev.voided.map((v) => `${v.qty}× ${v.n}`).join(", ") || "—"}
          </div>
          {ev.notes && (
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.7)", fontStyle: "italic", marginBottom: 2 }}>
              📝 {ev.notes}
            </div>
          )}
          <div style={{ fontSize: 12, color: "rgba(255,255,255,.55)" }}>
            {fmt(ev.at)} · voided by <strong style={{ color: "#fff" }}>{ev.by}</strong>
            {!isBillVoid && ev.reason && ` · "${ev.reason}"`}
          </div>
        </div>
        <div style={{ textAlign: "right", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)" }}>{isBillVoid ? "bill leakage" : "value lost"}</div>
          <div style={{ fontSize: 18, fontWeight: 900, color: "#EF4444" }}>−₹{ev.valueLost.toLocaleString("en-IN")}</div>
        </div>
      </div>
    );
  }
  if (ev.kind === "silent-edit") {
    const customerLabel = (ev.customerName || "").trim();
    return (
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, padding: 14, borderRadius: 12,
        background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.35)" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 60 }}>
          <div style={{ fontSize: 11, color: "rgba(245,158,11,.7)" }}>R{ev.roundNum}</div>
          <div style={{ fontSize: 24 }}>🔇</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ background: "rgba(245,158,11,.2)", color: "#F59E0B", fontSize: 10, fontWeight: 900, padding: "2px 6px", borderRadius: 4, letterSpacing: .5 }}>
              SILENT PRE-PRINT EDIT
            </span>
            <span style={{ background: "rgba(255,255,255,.06)", color: "rgba(255,255,255,.7)", fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4 }}>{ev.tableId}</span>
            {customerLabel && <span style={{ background: "rgba(201,168,76,.12)", color: "#C9A84C", fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4 }}>👤 {customerLabel}</span>}
          </div>
          <div style={{ fontSize: 13, color: "#fff", fontWeight: 700, marginBottom: 2 }}>
            Removed before print: {ev.removed.map((v) => `${v.qty}× ${v.n}`).join(", ") || "—"}
          </div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,.55)" }}>
            {fmt(ev.at)} · by <strong style={{ color: "#fff" }}>{ev.by}</strong> · no manager PIN required (pre-print)
          </div>
        </div>
        <div style={{ textAlign: "right", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)" }}>silently dropped</div>
          <div style={{ fontSize: 16, fontWeight: 900, color: "#F59E0B" }}>−₹{ev.valueRemoved.toLocaleString("en-IN")}</div>
        </div>
      </div>
    );
  }
  // override
  const labelMap: Record<string, string> = {
    "high-discount": "HIGH DISCOUNT",
    "sc-waiver": "SC WAIVED",
    "walkin-discount": "WALK-IN DISCOUNT",
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, padding: 14, borderRadius: 12,
      background: "rgba(168,85,247,.08)", border: "1px solid rgba(168,85,247,.4)" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 60 }}>
        <div style={{ fontSize: 24 }}>🔒</div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
          <span style={{ background: "rgba(168,85,247,.2)", color: "#A855F7", fontSize: 10, fontWeight: 900, padding: "2px 6px", borderRadius: 4, letterSpacing: .5 }}>
            {labelMap[ev.overrideKind] || ev.overrideKind.toUpperCase()}
          </span>
          <span style={{ background: "rgba(255,255,255,.06)", color: "rgba(255,255,255,.7)", fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4 }}>{ev.tableId}</span>
        </div>
        <div style={{ fontSize: 13, color: "#fff", fontWeight: 700, marginBottom: 2 }}>
          {ev.valueBefore || ev.valueBefore === 0 ? `${ev.valueBefore} → ${ev.valueAfter}` : `→ ${ev.valueAfter}`}
          {ev.overrideKind !== "sc-waiver" ? "%" : ""}
          {ev.reason && ` · "${ev.reason}"`}
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.55)" }}>
          {fmt(ev.at)} · approved by <strong style={{ color: "#fff" }}>{ev.by}</strong>
        </div>
      </div>
    </div>
  );
}

/** Pull voidLog + discountOverrideLog off recent reservation docs and flatten
 *  into AuditEvent rows. We scope to ~last 7 days by querying on the `date`
 *  field (string yyyy-mm-dd) so we don't read the entire collection. */
async function fetchRecentReservationAuditEvents(): Promise<AuditEvent[]> {
  const out: AuditEvent[] = [];
  // Build a list of date strings for the last 7 nights and OR them in chunks
  // of 10 (Firestore `in` clause cap). For tonight's go-live a single query on
  // today's date is enough — keep the structure here so we can extend later.
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split("T")[0]);
  }
  // NOTE: We intentionally do NOT add `orderBy("bookedAt", "desc")` here.
  // Firestore requires a composite index for `where("date", "in", ...)` + an
  // orderBy on a different field, and we can't deploy indexes from the app.
  // Instead we rely on the caller to sort the merged AuditEvent list by `at`
  // client-side. `limit(maxDocs)` is left off so we don't drop recent rows
  // arbitrarily — a 7-day window of reservations is small enough to scan.
  const q = query(
    collection(db, "tableReservations"),
    where("date", "in", dates.slice(0, 10)),
  );
  const snap = await getDocs(q);
  snap.forEach((d) => {
    const data = d.data() as Record<string, unknown>;
    const tableId = String(data.tableId || "");
    // Doc-level fallbacks for legacy void entries that didn't snapshot identity.
    const docCustomer = String(data.customerName || "");
    const docPhone = String((data as any).phone || "");
    const voidLog = Array.isArray(data.voidLog) ? data.voidLog as Array<Record<string, unknown>> : [];
    for (const v of voidLog) {
      // V3 — bill-void entries store ₹ as `billTotal`; older entries as
      // `valueLost`. Take whichever is present so the audit row never lands ₹0.
      const dollars = Number(v.valueLost ?? v.billTotal) || 0;
      const vk = String(v.kind || "items-void") as "bill-void" | "items-void";
      out.push({
        kind: "void",
        at: String(v.at || new Date().toISOString()),
        tableId: String(v.tableId || tableId), by: String(v.by || "unknown"),
        roundNum: Number(v.roundNum) || 0,
        voided: Array.isArray(v.voided) ? (v.voided as Array<{ n: string; qty: number; p: number }>) : [],
        valueLost: dollars,
        reason: v.reason ? String(v.reason) : undefined,
        voidKind: vk,
        customerName: String(v.customerName || docCustomer),
        customerPhone: String(v.customerPhone || docPhone),
        notes: v.notes ? String(v.notes) : undefined,
        billPrintCount: v.billPrintCount !== undefined ? Number(v.billPrintCount) : undefined,
      });
    }
    // V3 anti-fraud #A1 — silent pre-print edits.
    const seLog = Array.isArray(data.silentEditLog) ? data.silentEditLog as Array<Record<string, unknown>> : [];
    for (const s of seLog) {
      out.push({
        kind: "silent-edit",
        at: String(s.at || new Date().toISOString()),
        tableId: String(s.tableId || tableId), by: String(s.by || "unknown"),
        roundNum: Number(s.roundNum) || 0,
        removed: Array.isArray(s.removed) ? (s.removed as Array<{ n: string; qty: number; p: number }>) : [],
        valueRemoved: Number(s.valueRemoved) || 0,
        customerName: String(s.customerName || docCustomer),
      });
    }
    const ovLog = Array.isArray(data.discountOverrideLog) ? data.discountOverrideLog as Array<Record<string, unknown>> : [];
    for (const o of ovLog) {
      out.push({
        kind: "override",
        at: String(o.at || new Date().toISOString()),
        tableId, by: String(o.by || "unknown"),
        overrideKind: String(o.kind || "unknown"),
        valueBefore: Number(o.valueBefore) || 0,
        valueAfter: Number(o.valueAfter) || 0,
        reason: String(o.reason || ""),
      });
    }
  });
  return out;
}
