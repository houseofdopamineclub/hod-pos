// ─────────────────────────────────────────────────────────────────────
// 🆕 2026-06-05 — AGENTS REPORT (Boss Mode → Agents tab)
// Per-agent performance for DOOR, BAR and CAPTAIN modes, scoped to one
// operational night. Every metric is attributed to the staffer who
// performed the action (the name stamped on the underlying Firestore doc)
// and displayed with their EMPLOYEE ID (mapped from the staff roster).
//
// ATTRIBUTION (the field that records WHO did each action):
//  • DOOR    — covers.activatedBy (check-in scan + cover activated),
//              tableReservations.createdBy (tables created at the door),
//              tableReservations.cancelledBy (bookings cancelled).
//  • BAR     — cover.transactions[].staff (recharge `*_topup` / redeem
//              `activate`), cover.activatedBy for walkin_bar covers,
//              cover.walletBillPrintLog[].by (reprints + discount),
//              cover.billVoidedBy (void bills), billDue.clearedBy (NC
//              discount — the leak this report also surfaces).
//  • CAPTAIN — tableReservations.captainName (handled + billed + discount
//              + SC + tax), voidLog[].by (void bills), cancelledBy.
//
// SCOPE: bar covers (!isTableBooking) are attributed under BAR; table
// covers feed CAPTAIN via the reservation. Door check-in covers are bar/
// table-agnostic entry covers (not walkin_bar, not table) attributed by
// activatedBy = the door staffer who scanned them in.
//
// ⚠️ LIMITS (told to Khushi): discount / SC / tax persist only from
// v3.224+ (older bills count 0 in those columns); a captain hand-off
// without a formal reassignment credits only the FINAL captainName.
// ─────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { useStaff } from "@/lib/staff-context";
import {
  subscribeToCoversForNight, subscribeToHodReservations,
  type HodCover, type HodTableReservation,
} from "@/lib/firestore-hod";
import { subscribeBillDue, fetchBillDueForNight, type BillDueDoc } from "@/lib/bill-due";
import { getOperationalNightStr } from "@/lib/utils-pos";

// ── helpers ───────────────────────────────────────────────────────────
const fmtRs = (n: number) => "₹" + Math.round(n || 0).toLocaleString("en-IN");
const fmtN = (n: number) => (n || 0).toLocaleString("en-IN");
// Normalize an actor name for grouping: drop a trailing "(...)" suffix
// (e.g. "Aman (bar wallet open)") and collapse whitespace.
const normName = (s?: string) => (s || "").replace(/\s*\(.*?\)\s*$/, "").replace(/\s+/g, " ").trim();
const keyName = (s?: string) => normName(s).toLowerCase();

const nextDayStr = (d: string) => {
  const dt = new Date(d + "T12:00:00");
  if (isNaN(dt.getTime())) return d;
  dt.setDate(dt.getDate() + 1);
  return dt.toISOString().slice(0, 10);
};
const mergeById = <T extends { _docId?: string; id?: string }>(a: T[], b: T[]): T[] => {
  const m = new Map<string, T>();
  for (const x of [...a, ...b]) {
    const k = (x as any)._docId || (x as any).id || JSON.stringify(x);
    m.set(k, x);
  }
  return Array.from(m.values());
};

// Per-agent metric buckets ----------------------------------------------
interface DoorAgg {
  scanned: number;
  covCount: number; covAmt: number;
  tables: number; wTable: number; wAggr: number; wCorp: number;
  cancCount: number; cancAmt: number;
}
interface BarAgg {
  rcCount: number; rcAmt: number;
  rdCount: number; rdAmt: number;
  wiCount: number; wiAmt: number;
  reprints: number;
  discCount: number; discAmt: number;
  voidCount: number; voidAmt: number;
}
interface CapAgg {
  handled: number;
  billCount: number; billAmt: number;
  discCount: number; discAmt: number;
  sc: number; tax: number;
  voidCount: number; voidAmt: number;
}
const zeroDoor = (): DoorAgg => ({ scanned: 0, covCount: 0, covAmt: 0, tables: 0, wTable: 0, wAggr: 0, wCorp: 0, cancCount: 0, cancAmt: 0 });
const zeroBar = (): BarAgg => ({ rcCount: 0, rcAmt: 0, rdCount: 0, rdAmt: 0, wiCount: 0, wiAmt: 0, reprints: 0, discCount: 0, discAmt: 0, voidCount: 0, voidAmt: 0 });
const zeroCap = (): CapAgg => ({ handled: 0, billCount: 0, billAmt: 0, discCount: 0, discAmt: 0, sc: 0, tax: 0, voidCount: 0, voidAmt: 0 });

function ensure<T>(map: Map<string, { name: string; v: T }>, name: string, zero: () => T) {
  const k = keyName(name);
  if (!k) return null;
  let e = map.get(k);
  if (!e) { e = { name: normName(name), v: zero() }; map.set(k, e); }
  return e.v;
}

// Classify a door/captain-created reservation into a walk-in bucket.
const isAggregatorRes = (r: HodTableReservation) =>
  !!(r.aggregator && r.aggregator !== "inhouse") || (r.source || "").toLowerCase() === "zomato" ||
  /swiggy|zomato|eazydiner|magicpin|dineout/i.test((r.source || "")) || (r as any).isManualAggregatorEntry === true;
const isCorporateRes = (r: HodTableReservation) =>
  (r.source || "").toLowerCase() === "corporate" || !!(r.companyName && r.companyName.trim());

const isWalkinBarCover = (c: HodCover) =>
  String((c as any).source || "").toLowerCase().startsWith("walkin_bar") ||
  String((c as any).paymentId || "").toLowerCase().startsWith("walkin_bar");

export default function AgentsReport() {
  const { allStaff } = useStaff();
  const [night, setNight] = useState<string>(() => getOperationalNightStr());
  const [covers, setCovers] = useState<HodCover[]>([]);
  const [reservations, setReservations] = useState<HodTableReservation[]>([]);
  const [ncRows, setNcRows] = useState<BillDueDoc[]>([]);
  const [loading, setLoading] = useState(true);

  const nextDay = useMemo(() => nextDayStr(night), [night]);

  // empId lookup by normalized name.
  const empIdByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of allStaff) {
      if (s.name && s.id) m.set(keyName(s.name), s.id);
    }
    return m;
  }, [allStaff]);
  // Role set per staffer (primary role + extra access levels) — used to keep a
  // CAPTAIN-only staffer's table creations OUT of the DOOR section (createdBy
  // is stamped by both door AND captain walk-in flows, so name alone is not
  // enough to tell which mode created a table).
  const rolesByName = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const s of allStaff) {
      if (!s.name) continue;
      const set = new Set<string>();
      if (s.role) set.add(String(s.role).toLowerCase());
      for (const r of ((s as any).roles || [])) set.add(String(r).toLowerCase());
      m.set(keyName(s.name), set);
    }
    return m;
  }, [allStaff]);
  // A creator is "captain-only" when they hold the captain role but none of the
  // door-side roles (hostess / admin / manager). Their createWalkInTable/
  // createProxyTable rows are captain work, not door work.
  const isCaptainOnly = (name: string) => {
    const set = rolesByName.get(keyName(name));
    if (!set || set.size === 0) return false;
    return set.has("captain") && !set.has("hostess") && !set.has("admin") && !set.has("manager");
  };
  const labelFor = (name: string) => {
    const id = empIdByName.get(keyName(name));
    return id ? `${id} · ${name}` : name;
  };

  // Covers (night + nextDay for events that straddle the 7AM rollover).
  useEffect(() => {
    setLoading(true);
    let a: HodCover[] = [], b: HodCover[] = [];
    const apply = () => setCovers(mergeById(a as any, b as any));
    let u1: (() => void) | undefined, u2: (() => void) | undefined;
    try {
      u1 = subscribeToCoversForNight(night, (cs) => { a = cs || []; apply(); setLoading(false); });
      u2 = subscribeToCoversForNight(nextDay, (cs) => { b = cs || []; apply(); });
    } catch { setCovers([]); setLoading(false); }
    return () => { try { u1 && u1(); } catch {} try { u2 && u2(); } catch {} };
  }, [night, nextDay]);

  // Reservations (night + nextDay).
  useEffect(() => {
    let a: HodTableReservation[] = [], b: HodTableReservation[] = [];
    const apply = () => setReservations(mergeById(a, b));
    let u1: (() => void) | undefined, u2: (() => void) | undefined;
    try {
      u1 = subscribeToHodReservations(night, (r) => { a = r || []; apply(); });
      u2 = subscribeToHodReservations(nextDay, (r) => { b = r || []; apply(); });
    } catch { setReservations([]); }
    return () => { try { u1 && u1(); } catch {} try { u2 && u2(); } catch {} };
  }, [night, nextDay]);

  // NC ledger — live subscribe for tonight, one-shot fetch for past nights.
  useEffect(() => {
    const today = getOperationalNightStr();
    if (night === today) {
      let unsub: (() => void) | undefined;
      try { unsub = subscribeBillDue(setNcRows); } catch { setNcRows([]); }
      return () => { try { unsub && unsub(); } catch {} };
    }
    let alive = true;
    fetchBillDueForNight(night).then((rows) => { if (alive) setNcRows(rows); }).catch(() => { if (alive) setNcRows([]); });
    return () => { alive = false; };
  }, [night]);

  // ── AGGREGATION ─────────────────────────────────────────────────────
  const { doorRows, barRows, capRows } = useMemo(() => {
    const door = new Map<string, { name: string; v: DoorAgg }>();
    const bar = new Map<string, { name: string; v: BarAgg }>();
    const cap = new Map<string, { name: string; v: CapAgg }>();

    // ---- COVERS → DOOR (entry covers) + BAR (transactions / bills) ----
    for (const c of covers) {
      const isTable = !!c.isTableBooking;
      const barWalkin = isWalkinBarCover(c);

      // DOOR: entry covers = non-table, non-bar-walkin. activatedBy = the
      // door staffer who scanned the guest in.
      if (!isTable && !barWalkin && c.activatedBy) {
        const d = ensure(door, c.activatedBy, zeroDoor);
        if (d) {
          d.scanned += 1;
          if ((c.coverActivated || 0) > 0) { d.covCount += 1; d.covAmt += c.coverActivated || 0; }
        }
      }

      // BAR: recharge / redeem transactions (any cover that saw bar txns).
      for (const tx of (c.transactions || [])) {
        if (!tx || !tx.staff) continue;
        if (typeof tx.type === "string" && tx.type.endsWith("_topup")) {
          const v = ensure(bar, tx.staff, zeroBar);
          if (v) { v.rcCount += 1; v.rcAmt += tx.amount || 0; }
        } else if (tx.type === "activate") {
          const v = ensure(bar, tx.staff, zeroBar);
          if (v) { v.rdCount += 1; v.rdAmt += tx.amount || 0; }
        }
      }

      // BAR: walk-ins CREATED at the bar (activatedBy stamps the creator).
      if (barWalkin && c.activatedBy) {
        const v = ensure(bar, c.activatedBy, zeroBar);
        if (v) { v.wiCount += 1; v.wiAmt += c.coverActivated || 0; }
      }

      // BAR: reprints + discount from walletBillPrintLog. Reprints =
      // duplicate entries. Discount = the LATEST non-duplicate bill per
      // cover (running tabs re-print the full bill each round, so summing
      // every entry would double-count — same rule the Live Reports use).
      const log = c.walletBillPrintLog || [];
      if (log.length) {
        for (const b of log) {
          if (b?.isDuplicate && b.by) {
            const v = ensure(bar, b.by, zeroBar);
            if (v) v.reprints += 1;
          }
        }
        const nonDup = log.filter((b) => !b.isDuplicate);
        if (nonDup.length) {
          const atMs = (b: any) => { const t = new Date(b?.at || 0).getTime(); return isNaN(t) ? 0 : t; };
          const last = nonDup.reduce((p, q) => (atMs(q) >= atMs(p) ? q : p));
          if ((last.discount || 0) > 0 && last.by) {
            const v = ensure(bar, last.by, zeroBar);
            if (v) { v.discCount += 1; v.discAmt += last.discount || 0; }
          }
        }
      }

      // BAR: void bills (cover-level void via voidWalletBill).
      if ((c as any).billVoided && (c as any).billVoidedBy) {
        const v = ensure(bar, (c as any).billVoidedBy, zeroBar);
        if (v) { v.voidCount += 1; v.voidAmt += (c as any).voidedBillTotal || 0; }
      }
    }

    // ---- BILL DUE (NC) → BAR discount (the leak) ----
    const nc = ncRows.filter((r) => r.operationalNight === night);
    for (const r of nc) {
      const disc = typeof r.finalAmount === "number" ? Math.max(0, (r.amountDue || 0) - r.finalAmount) : 0;
      if (disc > 0) {
        const actor = r.clearedBy || r.staff || "";
        const v = ensure(bar, actor, zeroBar);
        if (v) { v.discCount += 1; v.discAmt += disc; }
      }
    }

    // ---- RESERVATIONS → DOOR (created/cancelled) + CAPTAIN ----
    for (const r of reservations) {
      const createdBy = (r as any).createdBy as string | undefined;
      const cancelledBy = (r as any).cancelledBy as string | undefined;
      const isCancelled = (r.status || "").toLowerCase() === "cancelled";

      // DOOR: tables created at the door (createdBy stamps the creator).
      // EXCLUDE proxy/placeholder tables (unambiguously captain-side) and
      // tables created by a captain-only staffer (createdBy is shared by the
      // captain walk-in flow, so those are captain work, not door work).
      if (createdBy && !(r as any).isProxy && !isCaptainOnly(createdBy)) {
        const d = ensure(door, createdBy, zeroDoor);
        if (d) {
          d.tables += 1;
          if (isCorporateRes(r)) d.wCorp += 1;
          else if (isAggregatorRes(r)) d.wAggr += 1;
          else d.wTable += 1;
        }
      }

      // DOOR: bookings cancelled.
      if (isCancelled && cancelledBy) {
        const d = ensure(door, cancelledBy, zeroDoor);
        if (d) {
          d.cancCount += 1;
          d.cancAmt += (r.amountPaid || 0) || (r.advanceAmount || 0);
        }
      }

      // CAPTAIN: handled / billed / discount / SC / tax (by captainName).
      const cn = r.captainName;
      if (cn) {
        const v = ensure(cap, cn, zeroCap);
        if (v) {
          v.handled += 1;
          if ((r.paymentStatus || "").toLowerCase() === "paid") {
            v.billCount += 1;
            v.billAmt += r.amountPaid || 0;
          }
          if ((r.discountAmount || 0) > 0) { v.discCount += 1; v.discAmt += r.discountAmount || 0; }
          v.sc += (r as any).serviceChargeAmount || 0;
          v.tax += r.taxAmount || 0;
        }
      }

      // (Cancellations are reported ONCE — under DOOR, by cancelledBy. A single
      // cancel event has a single canceller, so attributing it to both DOOR and
      // CAPTAIN would double-show the same event; DOOR owns bookings/cancels.)

      // CAPTAIN: void bills (voidLog bill-void entries carry the actor).
      for (const e of ((r as any).voidLog || [])) {
        if (e && e.kind === "bill-void" && e.by) {
          const v = ensure(cap, e.by, zeroCap);
          if (v) { v.voidCount += 1; v.voidAmt += e.valueLost || 0; }
        }
      }
    }

    const sortRows = <T,>(m: Map<string, { name: string; v: T }>) =>
      Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
    return { doorRows: sortRows(door), barRows: sortRows(bar), capRows: sortRows(cap) };
  }, [covers, reservations, ncRows, night, rolesByName]);

  // ── CSV ─────────────────────────────────────────────────────────────
  const downloadCsv = () => {
    const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines: string[] = [];
    lines.push(`HOD Agents Report,${esc(night)}`);
    lines.push("");
    lines.push("DOOR AGENTS");
    lines.push(["Employee", "Scanned", "Covers Activated (#)", "Covers Activated (Rs)", "Tables Booked", "Walk-in Tables", "Walk-in Aggregators", "Walk-in Corporate", "Bookings Cancelled (#)", "Bookings Cancelled (Rs)"].join(","));
    for (const { name, v } of doorRows) lines.push([labelFor(name), v.scanned, v.covCount, Math.round(v.covAmt), v.tables, v.wTable, v.wAggr, v.wCorp, v.cancCount, Math.round(v.cancAmt)].map(esc).join(","));
    lines.push("");
    lines.push("BAR AGENTS");
    lines.push(["Employee", "Recharged (#)", "Recharged (Rs)", "Redeemed (#)", "Redeemed (Rs)", "Walk-ins (#)", "Walk-ins (Rs)", "Bills Reprinted", "Discount (#)", "Discount (Rs)", "Void Bills (#)", "Void Bills (Rs)"].join(","));
    for (const { name, v } of barRows) lines.push([labelFor(name), v.rcCount, Math.round(v.rcAmt), v.rdCount, Math.round(v.rdAmt), v.wiCount, Math.round(v.wiAmt), v.reprints, v.discCount, Math.round(v.discAmt), v.voidCount, Math.round(v.voidAmt)].map(esc).join(","));
    lines.push("");
    lines.push("CAPTAIN AGENTS");
    lines.push(["Employee", "Tables Handled", "Billed (#)", "Billed (Rs)", "Discount (#)", "Discount (Rs)", "Service Charge (Rs)", "Tax (Rs)", "Void Bills (#)", "Void Bills (Rs)"].join(","));
    for (const { name, v } of capRows) lines.push([labelFor(name), v.handled, v.billCount, Math.round(v.billAmt), v.discCount, Math.round(v.discAmt), Math.round(v.sc), Math.round(v.tax), v.voidCount, Math.round(v.voidAmt)].map(esc).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `HOD_Agents_${night}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── RENDER ──────────────────────────────────────────────────────────
  const C = { ink: "#000", grey: "#6B6B6B", bg: "#F4F4F0", card: "#fff" };
  const NUM_FONT = "'Space Grotesk', sans-serif";

  const Cell = ({ children, bold, num }: { children: React.ReactNode; bold?: boolean; num?: boolean }) => (
    <td style={{ padding: "9px 11px", fontSize: 13, fontWeight: bold ? 900 : 700, color: C.ink, fontFamily: num ? NUM_FONT : undefined, whiteSpace: "nowrap", borderTop: `1px solid ${C.ink}` }}>{children}</td>
  );
  const Th = ({ children }: { children: React.ReactNode }) => (
    <th style={{ padding: "9px 11px", fontSize: 10.5, fontWeight: 800, color: C.grey, letterSpacing: 0.6, textTransform: "uppercase", textAlign: "left", whiteSpace: "nowrap" }}>{children}</th>
  );

  const Section = ({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) => (
    <div style={{ background: C.card, border: `2px solid ${C.ink}`, borderRadius: 14, padding: 16, marginBottom: 18, overflowX: "auto" }}>
      <div style={{ fontSize: 16, fontWeight: 900, color: C.ink, letterSpacing: 0.4 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: C.grey, fontWeight: 700, marginBottom: 12 }}>{hint}</div>
      {children}
    </div>
  );
  const EmptyRow = ({ cols }: { cols: number }) => (
    <tr><td colSpan={cols} style={{ padding: "18px 11px", fontSize: 13, fontWeight: 700, color: C.grey, textAlign: "center" }}>No activity recorded for this night.</td></tr>
  );

  return (
    <div style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
      {/* HEADER */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        <div style={{ fontSize: 22, fontWeight: 900, color: C.ink, letterSpacing: 0.4 }}>👥 AGENTS — PER-STAFF REPORTS</div>
      </div>
      <div style={{ fontSize: 12, color: C.grey, fontWeight: 700, marginBottom: 14 }}>
        One operational night · attributed to the staffer who performed each action · Employee ID shown with name.
      </div>

      {/* CONTROLS */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <label style={{ fontSize: 12, fontWeight: 800, color: C.ink, letterSpacing: 0.5 }}>NIGHT</label>
        <input type="date" value={night} onChange={(e) => setNight(e.target.value || getOperationalNightStr())}
          style={{ padding: "9px 12px", borderRadius: 8, background: C.card, border: `2px solid ${C.ink}`, color: C.ink, fontSize: 13, fontWeight: 700, outline: "none" }} />
        <div style={{ flex: 1 }} />
        <button onClick={downloadCsv}
          style={{ padding: "10px 18px", borderRadius: 8, background: C.ink, border: `2px solid ${C.ink}`, color: "#fff", fontSize: 13, fontWeight: 900, letterSpacing: 0.6, cursor: "pointer", whiteSpace: "nowrap" }}>
          ⬇ DOWNLOAD CSV
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: C.grey, fontSize: 16, fontWeight: 700 }}>Loading this night's numbers…</div>
      ) : (
        <>
          {/* DOOR */}
          <Section title="🚪 DOOR AGENTS" hint="Wallets scanned in · covers activated · tables created at the door (broken down by type) · bookings cancelled.">
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 760 }}>
              <thead><tr style={{ background: C.bg }}>
                <Th>Employee</Th><Th>Scanned</Th><Th>Covers Activated</Th><Th>Tables Booked</Th>
                <Th>↳ Tables</Th><Th>↳ Aggregators</Th><Th>↳ Corporate</Th><Th>Bookings Cancelled</Th>
              </tr></thead>
              <tbody>
                {doorRows.length === 0 ? <EmptyRow cols={8} /> : doorRows.map(({ name, v }) => (
                  <tr key={name}>
                    <Cell bold>{labelFor(name)}</Cell>
                    <Cell num>{fmtN(v.scanned)}</Cell>
                    <Cell num>{fmtN(v.covCount)} · {fmtRs(v.covAmt)}</Cell>
                    <Cell num bold>{fmtN(v.tables)}</Cell>
                    <Cell num>{fmtN(v.wTable)}</Cell>
                    <Cell num>{fmtN(v.wAggr)}</Cell>
                    <Cell num>{fmtN(v.wCorp)}</Cell>
                    <Cell num>{fmtN(v.cancCount)} · {fmtRs(v.cancAmt)}</Cell>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          {/* BAR */}
          <Section title="🍸 BAR / CASHIER AGENTS" hint="Wallet recharges · redemptions · bar walk-ins created · bill reprints · discount applied (incl. NC tabs) · void bills.">
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 820 }}>
              <thead><tr style={{ background: C.bg }}>
                <Th>Employee</Th><Th>Recharged</Th><Th>Redeemed</Th><Th>Walk-ins</Th>
                <Th>Reprints</Th><Th>Discount</Th><Th>Void Bills</Th>
              </tr></thead>
              <tbody>
                {barRows.length === 0 ? <EmptyRow cols={7} /> : barRows.map(({ name, v }) => (
                  <tr key={name}>
                    <Cell bold>{labelFor(name)}</Cell>
                    <Cell num>{fmtN(v.rcCount)} · {fmtRs(v.rcAmt)}</Cell>
                    <Cell num>{fmtN(v.rdCount)} · {fmtRs(v.rdAmt)}</Cell>
                    <Cell num>{fmtN(v.wiCount)} · {fmtRs(v.wiAmt)}</Cell>
                    <Cell num>{fmtN(v.reprints)}</Cell>
                    <Cell num>{fmtN(v.discCount)} · {fmtRs(v.discAmt)}</Cell>
                    <Cell num>{fmtN(v.voidCount)} · {fmtRs(v.voidAmt)}</Cell>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          {/* CAPTAIN */}
          <Section title="🧑‍🍳 CAPTAIN AGENTS" hint="Tables handled · billed · discount · service charge · tax · void bills (attributed to the final captain on the table).">
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 760 }}>
              <thead><tr style={{ background: C.bg }}>
                <Th>Employee</Th><Th>Handled</Th><Th>Billed</Th><Th>Discount</Th>
                <Th>Service Charge</Th><Th>Tax</Th><Th>Void Bills</Th>
              </tr></thead>
              <tbody>
                {capRows.length === 0 ? <EmptyRow cols={7} /> : capRows.map(({ name, v }) => (
                  <tr key={name}>
                    <Cell bold>{labelFor(name)}</Cell>
                    <Cell num bold>{fmtN(v.handled)}</Cell>
                    <Cell num>{fmtN(v.billCount)} · {fmtRs(v.billAmt)}</Cell>
                    <Cell num>{fmtN(v.discCount)} · {fmtRs(v.discAmt)}</Cell>
                    <Cell num>{fmtRs(v.sc)}</Cell>
                    <Cell num>{fmtRs(v.tax)}</Cell>
                    <Cell num>{fmtN(v.voidCount)} · {fmtRs(v.voidAmt)}</Cell>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <div style={{ fontSize: 11, color: C.grey, fontWeight: 600, lineHeight: 1.5, marginTop: 4 }}>
            Note: discount / service-charge / tax persist from v3.224 onward — bills printed before that show ₹0 in those columns.
            A table that changed captains mid-shift credits only the final captain on record.
          </div>
        </>
      )}
    </div>
  );
}
