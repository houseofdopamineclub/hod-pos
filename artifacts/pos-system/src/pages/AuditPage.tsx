import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, RefreshCw } from "lucide-react";
import {
  getRecentBillPrints, getRecentKotPrints,
  type BillAuditRow, type HodOrderItem,
} from "@/lib/firestore-hod";
import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { closeOnBackdrop } from "@/lib/centered-ui";

const GOLD = "#C9A84C";
const RED = "#EF4444";
const AMBER = "#F59E0B";
const BLUE = "#6B9BE8";
const PURPLE = "#A855F7";

type AuditEvent =
  | { kind: "bill"; at: string; row: BillAuditRow }
  | { kind: "kot"; at: string; id: string; tableId: string; staff: string;
      roundNum: number; itemCount: number; roundTotal: number; destinations: string[];
      isDuplicate: boolean; customerName?: string; items: HodOrderItem[] }
  | { kind: "void"; at: string; tableId: string; by: string; roundNum: number;
      voided: Array<{ n: string; qty: number; p: number }>; valueLost: number; reason?: string;
      voidKind?: "bill-void" | "items-void"; customerName?: string; customerPhone?: string;
      notes?: string; billPrintCount?: number }
  | { kind: "override"; at: string; tableId: string; by: string;
      overrideKind: string; valueBefore: number; valueAfter: number; reason: string }
  | { kind: "silent-edit"; at: string; tableId: string; by: string; roundNum: number;
      removed: Array<{ n: string; qty: number; p: number }>; valueRemoved: number;
      customerName?: string };

type Filter = "all" | "today" | "duplicates" | "voids" | "overrides" | "kots" | "bills" | "silent-edits";

export default function AuditPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("today");
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<AuditEvent | null>(null);

  const load = async () => {
    setLoading(true); setError("");
    try {
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
          customerName: k.customerName, items: k.items,
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
    <div style={{ color: "#000", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        {!embedded && (
          <Link href="/" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#000", textDecoration: "none", fontWeight: 700, border: "2px solid #000", padding: "6px 12px" }}>
            <ArrowLeft size={16} /> Back
          </Link>
        )}
        <h1 style={{ fontSize: 22, fontWeight: 900, color: "#000", margin: 0, flex: 1, textTransform: "uppercase", letterSpacing: "-.5px" }}>
          🔍 Operations Audit
        </h1>
        <button onClick={load} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#F4F4F0", border: "2px solid #000", color: "#000", padding: "8px 14px", cursor: "pointer", fontWeight: 700, boxShadow: "2px 2px 0px #000", fontSize: 13 }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Filter tab bar */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {([
          { id: "today",        label: `Today (${counts.today})`,           color: "#000",    bg: "#FF90E8" },
          { id: "voids",        label: `❌ Voids (${counts.voids})`,        color: "#fff",    bg: RED },
          { id: "silent-edits", label: `🔇 Silent Edits (${counts.silentEdits})`, color: "#000", bg: AMBER },
          { id: "overrides",    label: `🔒 Overrides (${counts.overrides})`,color: "#fff",    bg: PURPLE },
          { id: "duplicates",   label: `⚠ Duplicates (${counts.duplicates})`,color: "#000",  bg: AMBER },
          { id: "kots",         label: `🍳 KOTs (${counts.kots})`,          color: "#000",    bg: BLUE },
          { id: "bills",        label: `🖨 Bills (${counts.bills})`,         color: "#000",    bg: "#F2C744" },
          { id: "all",          label: `All (${events.length})`,             color: "#000",    bg: "#F4F4F0" },
        ] as Array<{ id: Filter; label: string; color: string; bg: string }>).map((t) => (
          <button key={t.id} onClick={() => setFilter(t.id)}
            style={{
              padding: "7px 13px", fontSize: 12, fontWeight: 700, cursor: "pointer",
              background: filter === t.id ? t.bg : "#fff",
              color: filter === t.id ? t.color : "#000",
              border: "2px solid #000",
              boxShadow: filter === t.id ? "3px 3px 0px #000" : "2px 2px 0px rgba(0,0,0,.15)",
              transform: filter === t.id ? "translate(-1px,-1px)" : "none",
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {loading && <div style={{ textAlign: "center", padding: 40, color: "#888", fontWeight: 500 }}>Loading audit log...</div>}
      {error && <div style={{ background: "#FFF0EE", border: "2px solid #EF4444", color: "#EF4444", padding: 14, fontWeight: 600 }}>Error: {error}</div>}

      {!loading && !error && filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: "#888", border: "2px dashed #ccc", fontWeight: 500 }}>
          No matching events.
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((ev, i) => <AuditRow key={`${ev.kind}-${i}`} ev={ev} fmt={fmt} onSelect={setDetail} />)}
        </div>
      )}

      <div style={{ marginTop: 24, fontSize: 11, color: "#aaa", textAlign: "center" }}>
        Showing the most recent bill prints, KOT prints, voids, and manager-PIN overrides. Append-only — staff cannot delete. Tap a KOT or Bill to see its items.
      </div>

      {detail && <DetailModal ev={detail} fmt={fmt} onClose={() => setDetail(null)} />}
    </div>
  );
}

/** Tap-to-view detail for a KOT (item list) or Bill (items + full tax breakdown).
 *  Reuses already-fetched data — no extra Firestore reads. */
function DetailModal({ ev, fmt, onClose }: { ev: AuditEvent; fmt: (iso: string) => string; onClose: () => void }) {
  const isBill = ev.kind === "bill";
  const items: HodOrderItem[] = isBill ? ev.row.items : ev.kind === "kot" ? ev.items : [];
  // Bill line items reflect the CURRENT full running tab. If this row is a
  // reprint, or the tab was edited after this print, the items can sum to a
  // different value than this row's SAVED subtotal — show an honest note so the
  // (always-from-saved-log) totals are never silently contradicted.
  const itemsSum = items.reduce((s, it) => s + (it.p || 0) * (it.qty || 0), 0);
  const itemsMismatch = isBill && ev.row.subtotal > 0 && Math.abs(itemsSum - ev.row.subtotal) > 1;
  const title = isBill ? (ev.row.billNumber || "BILL") : ev.kind === "kot" ? `KOT · R${ev.roundNum}` : "DETAILS";
  const sub = isBill ? `${ev.row.ref}${ev.row.customerName ? ` · ${ev.row.customerName}` : ""}`
                     : ev.kind === "kot" ? `${ev.tableId}${ev.customerName ? ` · ${ev.customerName}` : ""}` : "";
  const money = (n: number) => `₹${(Math.round(n * 100) / 100).toLocaleString("en-IN")}`;
  return (
    <div onClick={closeOnBackdrop(onClose)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", border: "3px solid #000", boxShadow: "6px 6px 0px #000", width: "100%", maxWidth: 460, maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: "2px solid #000", background: isBill ? "#F2C744" : "#6B9BE8" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: "monospace", fontSize: 16, fontWeight: 900, color: "#000" }}>{title}</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#000", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>
          </div>
          <button onClick={onClose} style={{ border: "2px solid #000", background: "#fff", fontWeight: 900, fontSize: 16, lineHeight: 1, padding: "4px 10px", cursor: "pointer", boxShadow: "2px 2px 0px #000" }}>✕</button>
        </div>
        <div style={{ padding: 16 }}>
          {items.length === 0 ? (
            <div style={{ textAlign: "center", color: "#888", fontWeight: 600, padding: 20 }}>No item details available for this record.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", border: "1px solid #000", padding: "7px 8px", fontWeight: 900, fontSize: 12, background: "#F4F4F0" }}>ITEM</th>
                  <th style={{ textAlign: "center", border: "1px solid #000", padding: "7px 8px", fontWeight: 900, fontSize: 12, background: "#F4F4F0" }}>QTY</th>
                  <th style={{ textAlign: "right", border: "1px solid #000", padding: "7px 8px", fontWeight: 900, fontSize: 12, background: "#F4F4F0" }}>RATE</th>
                  <th style={{ textAlign: "right", border: "1px solid #000", padding: "7px 8px", fontWeight: 900, fontSize: 12, background: "#F4F4F0" }}>AMT</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i}>
                    <td style={{ border: "1px solid #000", padding: "7px 8px", fontWeight: 600 }}>
                      {it.n}
                      {it.t === "food" && <span style={{ marginLeft: 5, fontSize: 9, color: "#16a34a", fontWeight: 800 }}>FOOD</span>}
                      {it.alc === true && <span style={{ marginLeft: 5, fontSize: 9, color: "#9333ea", fontWeight: 800 }}>ALC</span>}
                    </td>
                    <td style={{ border: "1px solid #000", padding: "7px 8px", textAlign: "center", fontWeight: 700 }}>{it.qty}</td>
                    <td style={{ border: "1px solid #000", padding: "7px 8px", textAlign: "right" }}>{money(it.p)}</td>
                    <td style={{ border: "1px solid #000", padding: "7px 8px", textAlign: "right", fontWeight: 700 }}>{money(it.p * it.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {isBill && (
            <div style={{ marginTop: 14, borderTop: "2px solid #000", paddingTop: 10, fontSize: 13 }}>
              {ev.row.subtotal > 0 && <BillLine label="Subtotal" value={money(ev.row.subtotal)} />}
              {ev.row.discount > 0 && <BillLine label="Discount" value={`−${money(ev.row.discount)}`} red />}
              {ev.row.serviceCharge > 0 && <BillLine label="Service Charge (10%)" value={money(ev.row.serviceCharge)} />}
              {ev.row.tax > 0 && <BillLine label="GST (5%)" value={money(ev.row.tax)} />}
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, paddingTop: 8, borderTop: "1px dashed #000", fontWeight: 900, fontSize: 16 }}>
                <span>TOTAL</span><span>{money(ev.row.total)}</span>
              </div>
              {ev.row.subtotal === 0 && (
                <div style={{ marginTop: 8, fontSize: 11, color: "#888", fontStyle: "italic" }}>
                  Tax breakdown was not saved for this older bill — only the printed total is on record.
                </div>
              )}
              {itemsMismatch && (
                <div style={{ marginTop: 8, fontSize: 11, color: "#b45309", fontStyle: "italic" }}>
                  Item lines show the latest tab; this may differ from a reprint or an edited table. The totals above are this bill's saved figures.
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: 12, fontSize: 11, color: "#888" }}>
            {isBill
              ? `${fmt(ev.row.at)} · by ${ev.row.by || "unknown"}${ev.row.printIndex > 1 ? ` · reprint #${ev.row.printIndex}` : ""}`
              : ev.kind === "kot" ? `${fmt(ev.at)} · by ${ev.staff || "unknown"} · ${ev.destinations.join(", ")}` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}

function BillLine({ label, value, red }: { label: string; value: string; red?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: red ? "#EF4444" : "#000" }}>
      <span style={{ color: "#555" }}>{label}</span><span style={{ fontWeight: 700 }}>{value}</span>
    </div>
  );
}

function AuditRow({ ev, fmt, onSelect }: { ev: AuditEvent; fmt: (iso: string) => string; onSelect: (ev: AuditEvent) => void }) {
  if (ev.kind === "bill") {
    const r = ev.row;
    const isDup = r.isDuplicate;
    const accent = isDup ? RED : "#000";
    return (
      <div onClick={() => onSelect(ev)} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, padding: 14, cursor: "pointer",
        background: isDup ? "#FFF0EE" : "#fff",
        border: `2px solid ${isDup ? RED : "#000"}`,
        boxShadow: isDup ? `3px 3px 0px ${RED}` : "2px 2px 0px rgba(0,0,0,.12)" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 52 }}>
          <div style={{ fontSize: 10, color: "#888", fontWeight: 600 }}>#{r.printIndex}</div>
          <div style={{ fontSize: 22 }}>{isDup ? "⚠️" : "🖨"}</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 900, color: accent }}>{r.billNumber}</span>
            {isDup && <span style={{ background: "#FFF0EE", color: RED, fontSize: 10, fontWeight: 900, padding: "2px 6px", border: `1px solid ${RED}`, letterSpacing: .5 }}>DUPLICATE</span>}
            <span style={{ background: r.source === "wallet" ? "#EFF6FF" : "#F5F0FF", color: r.source === "wallet" ? BLUE : PURPLE, fontSize: 10, fontWeight: 800, padding: "2px 6px", textTransform: "uppercase", border: `1px solid ${r.source === "wallet" ? BLUE : PURPLE}` }}>{r.source}</span>
          </div>
          <div style={{ fontSize: 13, color: "#000", fontWeight: 700, marginBottom: 2 }}>
            {r.ref} {r.customerName && `· ${r.customerName}`}
          </div>
          <div style={{ fontSize: 12, color: "#666" }}>
            {fmt(r.at)} · by <strong style={{ color: "#000" }}>{r.by || "unknown"}</strong>
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
    const accent = ev.isDuplicate ? RED : BLUE;
    return (
      <div onClick={() => onSelect(ev)} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, padding: 14, cursor: "pointer",
        background: "#F0F6FF",
        border: `2px solid ${ev.isDuplicate ? RED : BLUE}`,
        boxShadow: "2px 2px 0px rgba(0,0,0,.12)" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 52 }}>
          <div style={{ fontSize: 10, color: "#888", fontWeight: 600 }}>R{ev.roundNum}</div>
          <div style={{ fontSize: 22 }}>{ev.isDuplicate ? "⚠️" : "🍳"}</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ background: "#EFF6FF", color: BLUE, fontSize: 10, fontWeight: 900, padding: "2px 6px", border: `1px solid ${BLUE}`, letterSpacing: .5 }}>KOT</span>
            {ev.destinations.map((d) => (
              <span key={d} style={{ background: "#F4F4F0", color: "#555", fontSize: 10, fontWeight: 700, padding: "2px 6px", border: "1px solid #ccc" }}>{d}</span>
            ))}
            {ev.isDuplicate && <span style={{ background: "#FFF0EE", color: RED, fontSize: 10, fontWeight: 900, padding: "2px 6px", border: `1px solid ${RED}` }}>REPRINT</span>}
          </div>
          <div style={{ fontSize: 13, color: "#000", fontWeight: 700, marginBottom: 2 }}>
            {ev.tableId} {ev.customerName && `· ${ev.customerName}`}
          </div>
          <div style={{ fontSize: 12, color: "#666" }}>
            {fmt(ev.at)} · by <strong style={{ color: "#000" }}>{ev.staff || "unknown"}</strong> · {ev.itemCount} items
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
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, padding: 14,
        background: isBillVoid ? "#FFF0EE" : "#FFF5F5",
        border: `2px solid ${RED}`,
        boxShadow: isBillVoid ? `3px 3px 0px ${RED}` : "2px 2px 0px rgba(239,68,68,.3)" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 52 }}>
          <div style={{ fontSize: 10, color: RED, fontWeight: 700 }}>{isBillVoid ? "BILL" : `R${ev.roundNum}`}</div>
          <div style={{ fontSize: 22 }}>{isBillVoid ? "🚫" : "❌"}</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ background: "#FFF0EE", color: RED, fontSize: 10, fontWeight: 900, padding: "2px 6px", border: `1px solid ${RED}`, letterSpacing: .5 }}>
              {isBillVoid ? "BILL VOID" : "ITEMS VOID"}
            </span>
            <span style={{ background: "#F4F4F0", color: "#444", fontSize: 10, fontWeight: 700, padding: "2px 6px", border: "1px solid #ccc" }}>{ev.tableId}</span>
            {customerLabel && <span style={{ background: "#FFFBEB", color: "#000", fontSize: 10, fontWeight: 700, padding: "2px 6px", border: "1px solid #F2C744" }}>👤 {customerLabel}</span>}
            {phoneLabel && <span style={{ background: "#F0FFF4", color: "#22c55e", fontSize: 10, fontWeight: 700, padding: "2px 6px", fontFamily: "monospace", border: "1px solid #22c55e" }}>📱 {phoneLabel}</span>}
            {isBillVoid && ev.billPrintCount !== undefined && ev.billPrintCount > 0 && (
              <span style={{ background: "#FFFBEB", color: AMBER, fontSize: 10, fontWeight: 700, padding: "2px 6px", border: `1px solid ${AMBER}` }}>
                Bill #{ev.billPrintCount} printed
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: "#000", fontWeight: 700, marginBottom: 2 }}>
            {isBillVoid
              ? `WHOLE BILL VOIDED · ${ev.reason ? ev.reason.toUpperCase() : "—"}`
              : ev.voided.map((v) => `${v.qty}× ${v.n}`).join(", ") || "—"}
          </div>
          {ev.notes && (
            <div style={{ fontSize: 11, color: "#555", fontStyle: "italic", marginBottom: 2 }}>
              📝 {ev.notes}
            </div>
          )}
          <div style={{ fontSize: 12, color: "#666" }}>
            {fmt(ev.at)} · voided by <strong style={{ color: "#000" }}>{ev.by}</strong>
            {!isBillVoid && ev.reason && ` · "${ev.reason}"`}
          </div>
        </div>
        <div style={{ textAlign: "right", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: 10, color: "#888", marginBottom: 2, fontWeight: 500 }}>{isBillVoid ? "bill leakage" : "value lost"}</div>
          <div style={{ fontSize: 18, fontWeight: 900, color: RED }}>−₹{ev.valueLost.toLocaleString("en-IN")}</div>
        </div>
      </div>
    );
  }
  if (ev.kind === "silent-edit") {
    const customerLabel = (ev.customerName || "").trim();
    return (
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, padding: 14,
        background: "#FFFBEB",
        border: `2px solid ${AMBER}`,
        boxShadow: "2px 2px 0px rgba(0,0,0,.12)" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 52 }}>
          <div style={{ fontSize: 10, color: AMBER, fontWeight: 700 }}>R{ev.roundNum}</div>
          <div style={{ fontSize: 22 }}>🔇</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ background: "#FFFBEB", color: AMBER, fontSize: 10, fontWeight: 900, padding: "2px 6px", border: `1px solid ${AMBER}`, letterSpacing: .5 }}>
              SILENT PRE-PRINT EDIT
            </span>
            <span style={{ background: "#F4F4F0", color: "#444", fontSize: 10, fontWeight: 700, padding: "2px 6px", border: "1px solid #ccc" }}>{ev.tableId}</span>
            {customerLabel && <span style={{ background: "#FFFBEB", color: "#000", fontSize: 10, fontWeight: 700, padding: "2px 6px", border: "1px solid #F2C744" }}>👤 {customerLabel}</span>}
          </div>
          <div style={{ fontSize: 13, color: "#000", fontWeight: 700, marginBottom: 2 }}>
            Removed before print: {ev.removed.map((v) => `${v.qty}× ${v.n}`).join(", ") || "—"}
          </div>
          <div style={{ fontSize: 12, color: "#666" }}>
            {fmt(ev.at)} · by <strong style={{ color: "#000" }}>{ev.by}</strong> · no manager PIN required (pre-print)
          </div>
        </div>
        <div style={{ textAlign: "right", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: 10, color: "#888", marginBottom: 2, fontWeight: 500 }}>silently dropped</div>
          <div style={{ fontSize: 16, fontWeight: 900, color: AMBER }}>−₹{ev.valueRemoved.toLocaleString("en-IN")}</div>
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
    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, padding: 14,
      background: "#F9F0FF",
      border: `2px solid ${PURPLE}`,
      boxShadow: "2px 2px 0px rgba(0,0,0,.12)" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 52 }}>
        <div style={{ fontSize: 22 }}>🔒</div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
          <span style={{ background: "#F9F0FF", color: PURPLE, fontSize: 10, fontWeight: 900, padding: "2px 6px", border: `1px solid ${PURPLE}`, letterSpacing: .5 }}>
            {labelMap[(ev as any).overrideKind] || (ev as any).overrideKind.toUpperCase()}
          </span>
          <span style={{ background: "#F4F4F0", color: "#444", fontSize: 10, fontWeight: 700, padding: "2px 6px", border: "1px solid #ccc" }}>{(ev as any).tableId}</span>
        </div>
        <div style={{ fontSize: 13, color: "#000", fontWeight: 700, marginBottom: 2 }}>
          {(ev as any).valueBefore || (ev as any).valueBefore === 0 ? `${(ev as any).valueBefore} → ${(ev as any).valueAfter}` : `→ ${(ev as any).valueAfter}`}
          {(ev as any).overrideKind !== "sc-waiver" ? "%" : ""}
          {(ev as any).reason && ` · "${(ev as any).reason}"`}
        </div>
        <div style={{ fontSize: 12, color: "#666" }}>
          {fmt(ev.at)} · approved by <strong style={{ color: "#000" }}>{(ev as any).by}</strong>
        </div>
      </div>
    </div>
  );
}

async function fetchRecentReservationAuditEvents(): Promise<AuditEvent[]> {
  const out: AuditEvent[] = [];
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split("T")[0]);
  }
  const q = query(
    collection(db, "tableReservations"),
    where("date", "in", dates.slice(0, 10)),
  );
  const snap = await getDocs(q);
  snap.forEach((d) => {
    const data = d.data() as Record<string, unknown>;
    const tableId = String(data.tableId || "");
    const docCustomer = String(data.customerName || "");
    const docPhone = String((data as any).phone || "");
    const voidLog = Array.isArray(data.voidLog) ? data.voidLog as Array<Record<string, unknown>> : [];
    for (const v of voidLog) {
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
