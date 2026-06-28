// 🔴 LIVE MONITOR — real-time anti-fraud dashboard for owner/admin.
// Subscribes to reservations + posKOTs + posAuditLog scoped to TONIGHT and
// shows red-alerting tiles with click-to-drill-down event lists. Replaces
// the old iframe-to-/admin.html dashboard for the actual operational view.
//
// Sources of truth:
//   • tableReservations.discountOverrideLog  (D1, D3, L-A1, L-A4)
//   • tableReservations.sourceOverrideLog    (L1, L7, L-A4)
//   • tableReservations.voidLog              (V1)
//   • tableReservations.{billStale,paymentStatus,lastBillPrintedAt,tabTotal}
//   • posKOTs.isDuplicate (kind="bill")      (L4)
//   • posAuditLog                            (admin-side menu/staff/HH/etc.)
import { Fragment, useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where, orderBy, limit, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { subscribeToHodReservations, AGGREGATOR_OPTIONS, getAggregatorDiscount, type HodTableReservation } from "@/lib/firestore-hod";
import { getOperationalNightStr } from "@/lib/utils-pos";
import { buildAllTallyRows, aggregateCaptainLeakage, type PosKotDoc, type TallyRow } from "@/lib/kot-bill-tally";

const RED = "#ef4444"; const AMBER = "#f59e0b"; const GREEN = "#22c55e"; const GOLD = "#C9A84C";

type Severity = "red" | "amber" | "green" | "info";
type Event = {
  id: string; at: number; staff: string; table: string;
  kind: string; severity: Severity; details: string; amount?: number; reason?: string;
};

function fmtRel(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.max(0, Math.floor(d / 1000))}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(ms).toLocaleString();
}
function isRecent(ms: number, windowMin = 15): boolean {
  return Date.now() - ms < windowMin * 60_000;
}
function startOfTonightMs(): number {
  // Operational-night window boundary. Must match getOperationalNightStr()'s
  // rollover, which subtracts 7h (rolls over at 7AM IST) as of 2026-06-02.
  const d = new Date(); d.setHours(7, 0, 0, 0); // 7AM IST cutoff (matches getOperationalNightStr)
  if (Date.now() < d.getTime()) d.setDate(d.getDate() - 1);
  return d.getTime();
}

export function LiveMonitor() {
  const [reservations, setReservations] = useState<HodTableReservation[]>([]);
  const [kotEvents, setKotEvents] = useState<Event[]>([]);
  // Raw KOT docs (for KOT-vs-Bill leakage tally — Feature #2). Kept separate
  // from kotEvents (which is only "duplicate bill" events) so each tile owns
  // its derivation cleanly. One Firestore subscription, two consumers.
  const [kots, setKots] = useState<PosKotDoc[]>([]);
  // Track posKOTs subscription health so the tally can switch to "unknown"
  // verdict on rules/network failure instead of false-flagging phantom bills.
  const [kotsStatus, setKotsStatus] = useState<"loading" | "ok" | "error">("loading");
  const [auditEvents, setAuditEvents] = useState<Event[]>([]);
  const [drill, setDrill] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // tick every 30s so "Xm ago" labels + unpaid-30min thresholds refresh
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 30_000); return () => clearInterval(id); }, []);

  // 🆕 2026-05-27 v3.96 — operational-night key. Recomputed every 5 minutes;
  // when the string flips (12pm IST rollover) all listeners below re-mount
  // with a fresh `since` and a fresh `today`. Was previously captured ONCE
  // at mount with `[]` deps — meaning if an admin left LiveMonitor open
  // across days the `since` Timestamp stayed pinned to the mount day and
  // the listener's window grew unboundedly (after 48h the posKOTs cap of
  // 3000 would still re-pull thousands of stale docs on every snapshot).
  // 5-min recompute is conservative — rollover only triggers once per
  // 24h, so worst-case the listener re-mounts ~288×/day but only ACTUALLY
  // re-subscribes when the date string changes (state setter is a no-op
  // when the value is identical to the previous one).
  const [nightKey, setNightKey] = useState(getOperationalNightStr());
  useEffect(() => {
    const id = setInterval(() => setNightKey(getOperationalNightStr()), 5 * 60_000);
    return () => clearInterval(id);
  }, []);

  // 1) Live reservations for tonight
  useEffect(() => {
    return subscribeToHodReservations(nightKey, setReservations);
  }, [nightKey]);

  // 2) Live posKOTs (last ~12h, captures bill/kot prints + duplicates)
  useEffect(() => {
    const since = Timestamp.fromMillis(startOfTonightMs());
    // Cap = 3000 (busy-night ceiling: ~80 tables × ~25 KOTs + bills + voids).
    // Old cap 500 silently truncated tally inputs on real club nights → false
    // phantom/leakage classifications. 3000 keeps the duplicate-bill stream
    // honest AND gives the tally enough data to be trusted.
    const q = query(collection(db, "posKOTs"), where("createdAt", ">=", since), orderBy("createdAt", "desc"), limit(3000));
    return onSnapshot(q, (snap) => {
      const evts: Event[] = [];
      const allKots: PosKotDoc[] = [];
      snap.docs.forEach((d) => {
        const x = d.data() as any;
        const at = x.createdAt?.toMillis?.() || Date.now();
        const isBill = x.kind === "bill" || x.billNumber;
        if (isBill && x.isDuplicate) {
          evts.push({
            id: d.id, at, staff: x.staff || "?", table: x.tableId || "?",
            kind: "duplicate-bill", severity: "red",
            details: `Duplicate bill #${x.billNumber || "?"} reprinted`,
            amount: Number(x.total || 0),
          });
        }
        // Capture every doc raw — the leakage tally needs full item lists.
        // The lib filters out bill prints + void slips internally (isRealKot).
        allKots.push({
          id: d.id, tableId: x.tableId, items: x.items,
          bookingRef: x.bookingRef, reservationId: x.reservationId,
          customerName: x.customerName,
          voidNotice: x.voidNotice, kind: x.kind, billNumber: x.billNumber,
          staff: x.staff, createdAt: x.createdAt,
        });
      });
      setKotEvents(evts);
      setKots(allKots);
      setKotsStatus("ok");
    }, (e) => { console.warn("[LiveMonitor] posKOTs subscribe failed", e); setKotsStatus("error"); });
  }, [nightKey]);

  // 3) Live posAuditLog (admin-side actions: menu OOS, staff add/edit, HH change)
  useEffect(() => {
    const since = Timestamp.fromMillis(startOfTonightMs());
    const q = query(collection(db, "posAuditLog"), where("timestamp", ">=", since), orderBy("timestamp", "desc"), limit(300));
    return onSnapshot(q, (snap) => {
      const evts: Event[] = [];
      snap.docs.forEach((d) => {
        const x = d.data() as any;
        const at = x.timestamp?.toMillis?.() || Date.now();
        evts.push({
          id: d.id, at, staff: x.staffName || "?", table: "—",
          kind: `admin:${x.action}`, severity: "info",
          details: `${x.action} (by ${x.staffName} · ${x.staffRole})${x.details ? " · " + JSON.stringify(x.details).slice(0, 80) : ""}`,
        });
      });
      setAuditEvents(evts);
    }, (e) => console.warn("[LiveMonitor] posAuditLog subscribe failed", e));
  }, [nightKey]);

  // ── derive event streams from reservations ───────────────────────────────
  const { discountOverrides, sourceOverrides, voids, silentEdits, staleBills, unpaid30, openTabs, paidToday, modifiedDiscount } = useMemo(() => {
    void tick; // re-run on tick
    const now = Date.now();
    const discountOverrides: Event[] = [];
    const sourceOverrides: Event[] = [];
    const voids: Event[] = [];
    // V3 anti-fraud #A1 — pre-print silent reductions stream.
    const silentEdits: Event[] = [];
    const staleBills: Event[] = [];
    const unpaid30: Event[] = [];
    const openTabs: Array<{ id: string; tableId: string; customerName: string; tabTotal: number; aggregator: string; mins: number }> = [];
    const modifiedDiscount: Array<{ id: string; tableId: string; customerName: string; aggregator: string; defaultDisc: number; actualDisc: number }> = [];
    let paidTotal = 0; let paidCount = 0;

    reservations.forEach((r) => {
      const id = (r as any)._docId || (r as any).id || r.tableId || "";
      // Discount overrides
      ((r as any).discountOverrideLog as Array<any> | undefined)?.forEach((e, i) => {
        const at = new Date(e.at).getTime();
        discountOverrides.push({
          id: `${id}:do:${i}`, at, staff: e.by || "?", table: r.tableId || "?",
          kind: e.kind || "discount-override",
          severity: isRecent(at) ? "red" : "amber",
          details: `${e.kind}: ${e.valueBefore}% → ${e.valueAfter}%${e.sourceBefore && e.sourceAfter && e.sourceBefore !== e.sourceAfter ? ` (${e.sourceBefore} → ${e.sourceAfter})` : ""}`,
          reason: e.reason || "",
        });
      });
      // Source overrides (separate stream; can overlap with above for D3-extension)
      ((r as any).sourceOverrideLog as Array<any> | undefined)?.forEach((e, i) => {
        const at = new Date(e.at).getTime();
        const downgrade = e.from && e.from !== "inhouse" && e.to === "inhouse";
        sourceOverrides.push({
          id: `${id}:so:${i}`, at, staff: e.by || "?", table: r.tableId || "?",
          kind: e.afterBillCount > 0 ? "post-bill-source-swap" : "pre-bill-source-swap",
          severity: downgrade || isRecent(at) ? "red" : "amber",
          details: `${e.from} (${e.fromDiscount}%) → ${e.to} (${e.toDiscount}%)${e.afterBillCount > 0 ? ` [post-bill #${e.afterBillCount}]` : ""}${downgrade ? " ⚠ DOWNGRADE" : ""}${e.managerApproved ? " ✓ManagerPIN" : " (no PIN)"}`,
          reason: e.reason || "",
        });
      });
      // V3 anti-fraud #A1 — pre-print silent edits (qty reduced or item
      // dropped before KOT print). No PIN, no friction at the captain end —
      // but every reduction lands here for owner-side visibility.
      ((r as any).silentEditLog as Array<any> | undefined)?.forEach((e, i) => {
        const at = new Date(e.at).getTime();
        const removed = Array.isArray(e.removed) ? e.removed : [];
        silentEdits.push({
          id: `${id}:se:${i}`, at, staff: e.by || "?", table: r.tableId || "?",
          kind: "silent-pre-print-edit",
          severity: e.valueRemoved > 1500 ? "red" : isRecent(at) ? "amber" : "info",
          details: `Pre-print drop · R${e.roundNum}: ${removed.map((x: any) => `${x.qty}× ${x.n}`).join(", ").slice(0, 80)}`,
          amount: Number(e.valueRemoved || 0),
        });
      });
      // KOT voids
      ((r as any).voidLog as Array<any> | undefined)?.forEach((e, i) => {
        const at = new Date(e.at).getTime();
        voids.push({
          id: `${id}:v:${i}`, at, staff: e.by || "?", table: r.tableId || "?",
          kind: "kot-void", severity: e.valueLost > 1000 ? "red" : "amber",
          details: `Voided round #${e.roundNum} (${e.roundStatus}): ${(e.voided || []).map((x: any) => `${x.qty}× ${x.n}`).join(", ").slice(0, 80)}`,
          amount: Number(e.valueLost || 0), reason: e.reason || "",
        });
      });
      // Stale bills
      if ((r as any).billStale && r.paymentStatus !== "paid") {
        const at = new Date((r as any).lastBillPrintedAt || 0).getTime() || now;
        staleBills.push({
          id: `${id}:stale`, at, staff: r.captainName || "?", table: r.tableId || "?",
          kind: "stale-bill", severity: "amber",
          details: `Bill stale — items added/edited after print. Reprint required.`,
          amount: Number(r.tabTotal || 0),
        });
      }
      // Unpaid > 30min after bill print
      if (r.paymentStatus === "bill_requested" && (r as any).lastBillPrintedAt) {
        const billAt = new Date((r as any).lastBillPrintedAt).getTime();
        const mins = Math.floor((now - billAt) / 60_000);
        if (mins >= 30) {
          unpaid30.push({
            id: `${id}:unpaid`, at: billAt, staff: r.captainName || "?", table: r.tableId || "?",
            kind: "unpaid-30min", severity: mins >= 60 ? "red" : "amber",
            details: `Bill printed ${mins}m ago, still unpaid. Customer may have left.`,
            amount: Number(r.tabTotal || 0),
          });
        }
      }
      // Open tab tracking
      if (r.paymentStatus !== "paid" && (r as any).status !== "cancelled" && (r.tabTotal || 0) > 0) {
        const arrAt = (r as any).actualArrivalTimeMs || new Date(`${r.date}T${r.actualArrivalTime || r.arrivalTime || "21:00"}`).getTime();
        openTabs.push({
          id, tableId: r.tableId || "?", customerName: r.customerName || "?",
          tabTotal: r.tabTotal || 0, aggregator: r.aggregator || "inhouse",
          mins: arrAt && !isNaN(arrAt) ? Math.floor((now - arrAt) / 60_000) : 0,
        });
      }
      if (r.paymentStatus === "paid") { paidTotal += Number(r.tabTotal || 0); paidCount += 1; }
      // Modified-discount tracker (visible chip on cards already, but list it too)
      const aggName = r.aggregator || (r as any).source || "inhouse";
      const defDisc = getAggregatorDiscount(aggName);
      const actDisc = r.aggregatorDiscount ?? defDisc;
      // Only count if a captain actually edited it (discountModifiedByCaptain).
      // Bookings created by website/admin.html with non-default discount don't qualify.
      if ((r as any).discountModifiedByCaptain && actDisc !== defDisc) {
        modifiedDiscount.push({
          id, tableId: r.tableId || "?", customerName: r.customerName || "?",
          aggregator: AGGREGATOR_OPTIONS.find(a => a.value === aggName)?.label || aggName,
          defaultDisc: defDisc, actualDisc: actDisc,
        });
      }
    });

    discountOverrides.sort((a, b) => b.at - a.at);
    sourceOverrides.sort((a, b) => b.at - a.at);
    voids.sort((a, b) => b.at - a.at);
    silentEdits.sort((a, b) => b.at - a.at);
    return { discountOverrides, sourceOverrides, voids, silentEdits, staleBills, unpaid30, openTabs, paidToday: { total: paidTotal, count: paidCount }, modifiedDiscount };
  }, [reservations, tick]);

  // 🧾 KOT-vs-BILL LEAKAGE TALLY (Feature #2 — anti-fraud cash-pocket detector)
  // ──────────────────────────────────────────────────────────────────────────
  // Compares physically-printed KOTs vs final bill items per closed table.
  // Subtracts manager-approved voids so only TRUE leakage surfaces.
  // Read-only — pure derivation. If posKOTs subscription failed (rules / net),
  // tallyRows is just empty; tile shows ✓ instead of false-flagging.
  // Note: intentionally NOT depending on `tick` — tally inputs are pure
  // (reservations + kots), so re-running every 30s wasted CPU on a busy night
  // (~80 tables × ~1600 KOTs). The render parent does re-render on tick for
  // other tiles' "Xm ago" labels — tally just doesn't need the recompute.
  const tallyRows = useMemo<TallyRow[]>(() => {
    return buildAllTallyRows(reservations, kots, { closedOnly: true, kotsStatus });
  }, [reservations, kots, kotsStatus]);
  const tallyTotals = useMemo(() => {
    let leakageVal = 0, phantomVal = 0, leakageTables = 0, phantomTables = 0, billVoidedTables = 0;
    for (const t of tallyRows) {
      if (t.verdict === "leakage") { leakageTables += 1; leakageVal += t.leakageValue; }
      if (t.verdict === "phantom") { phantomTables += 1; phantomVal += t.phantomValue; }
      if (t.verdict === "bill-voided") billVoidedTables += 1;
    }
    return { leakageVal, phantomVal, leakageTables, phantomTables, billVoidedTables };
  }, [tallyRows]);
  const tallyByCaptain = useMemo(() => aggregateCaptainLeakage(tallyRows), [tallyRows]);

  // Per-staff Leakage Score — normalises raw flag counts by tables handled so we
  // can surface captains who have a HIGH RATE of exceptions, not just absolute volume.
  // Scenario: Rahul does 25 tables / 4 overrides = 16% leakage; Vikram does 8/3 = 37.5%.
  // Vikram is the one to talk to even though Rahul has more raw count.
  const perStaff = useMemo(() => {
    const map = new Map<string, { overrides: number; voids: number; duplicates: number; sourceSwaps: number; total: number; tables: number }>();
    const ensure = (name: string) => {
      if (!name || name === "?") return null;
      let cur = map.get(name);
      if (!cur) { cur = { overrides: 0, voids: 0, duplicates: 0, sourceSwaps: 0, total: 0, tables: 0 }; map.set(name, cur); }
      return cur;
    };
    const bump = (name: string, key: "overrides" | "voids" | "duplicates" | "sourceSwaps") => {
      const cur = ensure(name); if (!cur) return;
      cur[key] += 1; cur.total += 1;
    };
    // Tables-handled denominator (any tab the captain owned tonight, paid or open)
    reservations.forEach((r) => {
      const cur = ensure(r.captainName || "");
      if (cur) cur.tables += 1;
    });
    discountOverrides.forEach((e) => bump(e.staff, "overrides"));
    sourceOverrides.forEach((e) => bump(e.staff, "sourceSwaps"));
    voids.forEach((e) => bump(e.staff, "voids"));
    kotEvents.forEach((e) => bump(e.staff, "duplicates"));
    return Array.from(map.entries())
      .map(([name, s]) => ({ name, ...s, leakagePct: s.tables > 0 ? Math.round((s.total / s.tables) * 1000) / 10 : 0 }))
      .sort((a, b) => b.leakagePct - a.leakagePct || b.total - a.total);
  }, [reservations, discountOverrides, sourceOverrides, voids, kotEvents]);

  // Discount Drift Heatmap — captain × source grid showing avg (actual - default) discount.
  // Catches the captain who systematically over-discounts a single source (e.g. Zomato 35% when default is 30%).
  // Scenario: Rahul averaged 34.5% on Zomato (default 30%) across 25 tables → ~₹1.5L bleed.
  const driftHeatmap = useMemo(() => {
    void tick;
    type Cell = { sumDelta: number; count: number; extraRs: number };
    const grid = new Map<string, Map<string, Cell>>(); // captain -> source -> cell
    const sourcesUsed = new Set<string>();
    let totalExtraRs = 0;
    type DriftWorst = { captain: string; source: string; avgDelta: number; count: number; extraRs: number };
    let worst: DriftWorst | null = null;
    reservations.forEach((r) => {
      const captain = r.captainName || "—";
      const aggName = r.aggregator || (r as any).source || "inhouse";
      const defDisc = getAggregatorDiscount(aggName);
      const actDisc = r.aggregatorDiscount ?? defDisc;
      const delta = actDisc - defDisc;
      // Approx ₹ over-given on this table = extra discount points × the table's
      // bill. Only OVER-discount (delta > 0) costs money; under-discount is free.
      const extraRs = delta > 0 ? (delta / 100) * Number(r.tabTotal || 0) : 0;
      sourcesUsed.add(aggName);
      let row = grid.get(captain); if (!row) { row = new Map(); grid.set(captain, row); }
      let cell = row.get(aggName); if (!cell) { cell = { sumDelta: 0, count: 0, extraRs: 0 }; row.set(aggName, cell); }
      cell.sumDelta += delta;
      cell.count += 1;
      cell.extraRs += extraRs;
      totalExtraRs += extraRs;
    });
    const sources = Array.from(sourcesUsed).sort();
    const captains = Array.from(grid.keys()).filter(c => c && c !== "—" && c !== "?").sort();
    // Single worst captain×source by ₹ over-given — drives the plain-English callout.
    captains.forEach((cap) => {
      const row = grid.get(cap); if (!row) return;
      row.forEach((cell, src) => {
        const avgDelta = cell.count > 0 ? cell.sumDelta / cell.count : 0;
        if (avgDelta >= 1 && (!worst || cell.extraRs > worst.extraRs)) {
          worst = { captain: cap, source: src, avgDelta: Math.round(avgDelta * 10) / 10, count: cell.count, extraRs: Math.round(cell.extraRs) };
        }
      });
    });
    return { sources, captains, grid, totalExtraRs: Math.round(totalExtraRs), worst: worst as DriftWorst | null };
  }, [reservations, tick]);

  const tiles: Array<{ id: string; label: string; count: number; severity: Severity; sub: string; recentRed: boolean }> = [
    {
      id: "overrides", label: "🚨 DISCOUNT OVERRIDES", count: discountOverrides.length,
      severity: discountOverrides.length === 0 ? "green" : (discountOverrides.some(e => isRecent(e.at)) ? "red" : "amber"),
      sub: discountOverrides.length === 0 ? "All clean" : `${discountOverrides.filter(e => isRecent(e.at)).length} in last 15min`,
      recentRed: discountOverrides.some(e => isRecent(e.at)),
    },
    {
      id: "sourceSwaps", label: "🔀 SOURCE SWAPS", count: sourceOverrides.length,
      severity: sourceOverrides.length === 0 ? "green" : (sourceOverrides.some(e => isRecent(e.at) || e.severity === "red") ? "red" : "amber"),
      sub: sourceOverrides.length === 0 ? "No swaps" : `${sourceOverrides.filter(e => e.severity === "red").length} downgrade(s)`,
      recentRed: sourceOverrides.some(e => isRecent(e.at)),
    },
    {
      id: "voids", label: "✂️ KOT VOIDS", count: voids.length,
      severity: voids.length === 0 ? "green" : (voids.some(e => isRecent(e.at)) ? "red" : "amber"),
      sub: voids.length === 0 ? "No voids" : `₹${voids.reduce((s, e) => s + (e.amount || 0), 0)} value lost`,
      recentRed: voids.some(e => isRecent(e.at)),
    },
    {
      // V3 anti-fraud #A1 — silent pre-print edit drift tile.
      id: "silentEdits", label: "🔇 SILENT PRE-PRINT EDITS", count: silentEdits.length,
      severity: silentEdits.length === 0 ? "green" : (silentEdits.some(e => isRecent(e.at)) ? "red" : "amber"),
      sub: silentEdits.length === 0 ? "No drops" : `₹${silentEdits.reduce((s, e) => s + (e.amount || 0), 0).toLocaleString("en-IN")} silently dropped`,
      recentRed: silentEdits.some(e => isRecent(e.at)),
    },
    {
      id: "duplicates", label: "📑 DUPLICATE BILLS", count: kotEvents.length,
      severity: kotEvents.length === 0 ? "green" : kotEvents.length > 5 ? "red" : "amber",
      sub: kotEvents.length === 0 ? "No reprints" : `${kotEvents.length} reprint(s)`,
      recentRed: kotEvents.some(e => isRecent(e.at)),
    },
    {
      id: "stale", label: "⚠️ STALE BILLS", count: staleBills.length,
      severity: staleBills.length === 0 ? "green" : "amber",
      sub: staleBills.length === 0 ? "All current" : `Reprint needed`,
      recentRed: false,
    },
    {
      id: "unpaid30", label: "⏰ UNPAID >30min", count: unpaid30.length,
      severity: unpaid30.length === 0 ? "green" : "red",
      sub: unpaid30.length === 0 ? "All settled" : `₹${unpaid30.reduce((s, e) => s + (e.amount || 0), 0)} at risk`,
      recentRed: unpaid30.length > 0,
    },
    {
      id: "modified", label: "✎ MODIFIED DISCOUNTS", count: modifiedDiscount.length,
      severity: modifiedDiscount.length === 0 ? "green" : "amber",
      sub: modifiedDiscount.length === 0 ? "All defaults" : `${modifiedDiscount.length} non-default`,
      recentRed: false,
    },
    {
      id: "openTabs", label: "🪑 OPEN TABS", count: openTabs.length,
      severity: "info",
      sub: `₹${openTabs.reduce((s, t) => s + t.tabTotal, 0).toLocaleString()} open · ₹${paidToday.total.toLocaleString()} paid (${paidToday.count})`,
      recentRed: false,
    },
    {
      // Feature #2 — KOT-vs-BILL leakage. RED if any leakage tonight.
      // "n tables" subtitle so owner knows how many drill into.
      id: "kotBillTally", label: "🧾 KOT-BILL LEAKAGE",
      count: tallyTotals.leakageTables + tallyTotals.phantomTables,
      severity: (tallyTotals.leakageVal + tallyTotals.phantomVal) === 0 ? "green"
        : tallyTotals.leakageVal >= 500 ? "red" : "amber",
      sub: (tallyTotals.leakageTables + tallyTotals.phantomTables) === 0
        ? `${tallyRows.length} tables tallied · all clean`
        : `🔴 ₹${tallyTotals.leakageVal.toLocaleString()} unbilled` +
          (tallyTotals.phantomVal > 0 ? ` · 👻 ₹${tallyTotals.phantomVal.toLocaleString()} phantom` : ""),
      recentRed: tallyTotals.leakageVal >= 500,
    },
  ];

  const sevColor = (s: Severity) => s === "red" ? RED : s === "amber" ? AMBER : s === "green" ? GREEN : GOLD;
  const tileBg = (s: Severity, alert: boolean) => {
    const c = sevColor(s);
    return {
      background: `${c}18`,
      border: `2px solid ${c}`,
      boxShadow: alert ? `4px 4px 0px #000` : "3px 3px 0px rgba(0,0,0,.15)",
      animation: alert ? "hodPulse 2s ease-in-out infinite" : undefined,
    } as const;
  };

  const drillEvents: Event[] = useMemo(() => {
    if (!drill) return [];
    if (drill === "overrides") return discountOverrides;
    if (drill === "sourceSwaps") return sourceOverrides;
    if (drill === "voids") return voids;
    if (drill === "silentEdits") return silentEdits;
    if (drill === "duplicates") return kotEvents;
    if (drill === "stale") return staleBills;
    if (drill === "unpaid30") return unpaid30;
    if (drill === "audit") return auditEvents;
    return [];
  }, [drill, discountOverrides, sourceOverrides, voids, silentEdits, kotEvents, staleBills, unpaid30, auditEvents]);

  return (
    <div style={{ color: "#000" }}>
      <style>{`@keyframes hodPulse { 0%,100% { transform: scale(1);} 50% { transform: scale(1.015);} }`}</style>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 900, color: "#000", letterSpacing: "-.5px" }}>🔴 LIVE MONITOR</div>
          <div style={{ fontSize: 11, color: "#666", fontWeight: 500, marginTop: 2 }}>
            Operational night: {getOperationalNightStr()} · Auto-refreshes from Firestore · Red tiles = activity in last 15 min
          </div>
        </div>
        <div style={{ fontSize: 11, color: "#888", fontWeight: 600 }}>
          {reservations.length} reservation(s) · {discountOverrides.length + sourceOverrides.length + voids.length + kotEvents.length} flagged event(s)
        </div>
      </div>

      {/* Metric tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10, marginBottom: 16 }}>
        {tiles.map((t) => (
          <button key={t.id} onClick={() => setDrill(t.id === drill ? null : t.id)}
            style={{ textAlign: "left", padding: 14, cursor: "pointer", color: "#000",
              ...tileBg(t.severity, t.recentRed && t.severity === "red"),
              outline: drill === t.id ? `3px solid ${sevColor(t.severity)}` : "none",
              outlineOffset: 2 }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".6px", color: "#333", marginBottom: 6, textTransform: "uppercase" }}>{t.label}</div>
            <div style={{ fontSize: 28, fontWeight: 900, color: sevColor(t.severity), lineHeight: 1 }}>{t.count}</div>
            <div style={{ fontSize: 10, color: "#666", marginTop: 6, fontWeight: 500 }}>{t.sub}</div>
          </button>
        ))}
      </div>

      {/* Per-staff Leakage Score */}
      <div style={{ background: "#fff", border: "2px solid #000", padding: 14, marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 900, color: "#000", marginBottom: 6, textTransform: "uppercase", letterSpacing: "-.2px" }}>👥 Per-Staff Leakage Score (tonight)</div>
        <div style={{ fontSize: 11, color: "#444", marginBottom: 8, fontWeight: 600, lineHeight: 1.5 }}>
          <b>What it shows:</b> which captain is raising the most money-touching exceptions <i>relative to how busy they were</i>.
          A "flag" is any of: a discount changed by hand, a booking's source switched, a printed order (KOT) cancelled, or a
          bill reprinted. We divide a captain's total flags by the tables they handled, so a busy captain isn't punished for volume.
        </div>
        <div style={{ fontSize: 11, color: "#444", marginBottom: 8, fontWeight: 600, lineHeight: 1.5 }}>
          <b>How to read it:</b> <b>Leakage %</b> = flags ÷ tables handled. Lower is better.
          Example — Rahul: 5 flags on 30 tables = <b>17%</b> (fine). Vikram: 3 flags on 5 tables = <b>60%</b> (talk to Vikram).
          <span style={{ color: "#888" }}> "Low data" means too few tables (&lt;3) to judge fairly yet.</span>
        </div>
        {/* Column key + status legend (so the abbreviations aren't a guessing game) */}
        <div style={{ fontSize: 10, color: "#666", marginBottom: 6, fontWeight: 600 }}>
          Columns: <b>OVRD</b> = discount overrides · <b>SWAPS</b> = source swaps · <b>VOIDS</b> = cancelled KOTs · <b>DUPS</b> = duplicate bills · <b>FLAGS</b> = all of those added up.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {[
            { c: GREEN, t: "✓ Clean (under 15%)", white: true },
            { c: AMBER, t: "Keep an eye (15–30%)", white: false },
            { c: RED, t: "🚩 Review now (30%+)", white: true },
            { c: "#aaa", t: "Low data (<3 tables)", white: true },
          ].map((l) => (
            <span key={l.t} style={{ fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 999, background: l.c, color: l.white ? "#fff" : "#000", border: "1.5px solid #000" }}>{l.t}</span>
          ))}
        </div>
        {perStaff.length === 0 ? (
          <div style={{ fontSize: 12, color: "#888", fontWeight: 600 }}>No staff activity yet — clean shift so far.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1.3fr repeat(6, 0.56fr) 0.78fr 1.15fr", gap: 6, fontSize: 12, alignItems: "center" }}>
            <div style={{ fontWeight: 800, color: "#444", fontSize: 10, textTransform: "uppercase" }}>STAFF</div>
            <div style={{ fontWeight: 800, color: "#444", textAlign: "right", fontSize: 10, textTransform: "uppercase" }}>TABLES</div>
            <div style={{ fontWeight: 800, color: "#444", textAlign: "right", fontSize: 10, textTransform: "uppercase" }}>OVRD</div>
            <div style={{ fontWeight: 800, color: "#444", textAlign: "right", fontSize: 10, textTransform: "uppercase" }}>SWAPS</div>
            <div style={{ fontWeight: 800, color: "#444", textAlign: "right", fontSize: 10, textTransform: "uppercase" }}>VOIDS</div>
            <div style={{ fontWeight: 800, color: "#444", textAlign: "right", fontSize: 10, textTransform: "uppercase" }}>DUPS</div>
            <div style={{ fontWeight: 800, color: "#444", textAlign: "right", fontSize: 10, textTransform: "uppercase" }}>FLAGS</div>
            <div style={{ fontWeight: 800, color: "#444", textAlign: "right", fontSize: 10, textTransform: "uppercase" }}>LEAKAGE%</div>
            <div style={{ fontWeight: 800, color: "#444", textAlign: "right", fontSize: 10, textTransform: "uppercase" }}>STATUS</div>
            {perStaff.map((s) => {
              const lowData = s.tables < 3;
              const leakSev = lowData ? "#aaa" : s.leakagePct >= 30 ? RED : s.leakagePct >= 15 ? AMBER : GREEN;
              const status = lowData
                ? { c: "#aaa", t: "Low data", white: true }
                : s.leakagePct >= 30 ? { c: RED, t: "🚩 Review", white: true }
                : s.leakagePct >= 15 ? { c: AMBER, t: "Watch", white: false }
                : { c: GREEN, t: "✓ Clean", white: true };
              return (
                <Fragment key={s.name}>
                  <div style={{ color: "#000", fontWeight: 600 }}>{s.name}</div>
                  <div style={{ textAlign: "right", color: "#555" }}>{s.tables}</div>
                  <div style={{ textAlign: "right", color: s.overrides > 0 ? AMBER : "#bbb" }}>{s.overrides}</div>
                  <div style={{ textAlign: "right", color: s.sourceSwaps > 0 ? AMBER : "#bbb" }}>{s.sourceSwaps}</div>
                  <div style={{ textAlign: "right", color: s.voids > 0 ? AMBER : "#bbb" }}>{s.voids}</div>
                  <div style={{ textAlign: "right", color: s.duplicates > 0 ? AMBER : "#bbb" }}>{s.duplicates}</div>
                  <div style={{ textAlign: "right", fontWeight: 900, color: s.total >= 5 ? RED : s.total >= 3 ? AMBER : GREEN }}>{s.total}</div>
                  <div style={{ textAlign: "right", fontWeight: 900, color: leakSev, fontSize: 14 }}>
                    {s.tables === 0 ? "—" : `${s.leakagePct}%`}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 999, background: status.c, color: status.white ? "#fff" : "#000", border: "1.5px solid #000", whiteSpace: "nowrap" }}>{status.t}</span>
                  </div>
                </Fragment>
              );
            })}
          </div>
        )}
      </div>

      {/* Discount Drift Heatmap */}
      {driftHeatmap.captains.length > 0 && driftHeatmap.sources.length > 0 && (
        <div style={{ background: "#fff", border: "2px solid #000", padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 900, color: "#000", marginBottom: 6, textTransform: "uppercase" }}>🌡 Discount Drift Heatmap (tonight)</div>
          <div style={{ fontSize: 11, color: "#444", marginBottom: 8, fontWeight: 600, lineHeight: 1.5 }}>
            <b>What it shows:</b> every booking source (in-house, Zomato, etc.) has a <i>set discount</i>. This grid shows how much
            <b> extra</b> each captain gave on top of that set rate, on average. It catches the captain who quietly gives more
            discount than allowed on one channel — small per table, but it adds up over a night.
          </div>
          <div style={{ fontSize: 11, color: "#444", marginBottom: 10, fontWeight: 600, lineHeight: 1.5 }}>
            <b>How to read it:</b> each cell shows <b>"pp"</b> = extra discount points above the set rate (e.g. <b>+4pp</b> = gave 34% where 30% was set),
            how many tables it covers, and the <b>≈₹</b> extra that cost you. <span style={{ color: "#888" }}>Giving <i>less</i> than the set rate is fine and shown grey.</span>
          </div>
          {/* Plain-English headline: the single biggest leak + tonight's total */}
          {(() => {
            const w = driftHeatmap.worst;
            const srcLabel = (v: string) => AGGREGATOR_OPTIONS.find(a => a.value === v)?.label || v;
            return (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                {w ? (
                  <div style={{ flex: "1 1 280px", background: `${RED}14`, border: `2px solid ${RED}`, padding: "8px 12px", fontSize: 12, color: "#000", fontWeight: 600 }}>
                    🚩 <b>Biggest drift:</b> {w.captain} gave <b style={{ color: RED }}>+{w.avgDelta}pp</b> extra on <b>{srcLabel(w.source)}</b> across {w.count} table{w.count > 1 ? "s" : ""} — about <b style={{ color: RED }}>₹{w.extraRs.toLocaleString("en-IN")}</b> more than the set rate.
                  </div>
                ) : (
                  <div style={{ flex: "1 1 280px", background: `${GREEN}14`, border: `2px solid ${GREEN}`, padding: "8px 12px", fontSize: 12, color: "#000", fontWeight: 700 }}>
                    ✓ No captain is over-discounting tonight — everyone is at or below the set rates.
                  </div>
                )}
                <div style={{ flex: "0 1 auto", background: driftHeatmap.totalExtraRs > 0 ? `${AMBER}14` : "#f4f4f4", border: `2px solid ${driftHeatmap.totalExtraRs > 0 ? AMBER : "#ccc"}`, padding: "8px 12px", fontSize: 12, color: "#000", fontWeight: 700 }}>
                  Est. extra discount given tonight: <b style={{ color: driftHeatmap.totalExtraRs > 0 ? AMBER : "#000", fontSize: 14 }}>₹{driftHeatmap.totalExtraRs.toLocaleString("en-IN")}</b>
                </div>
              </div>
            );
          })()}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {[
              { c: GREEN, t: "At the set rate", white: true },
              { c: AMBER, t: "Slightly over (+1 to +3pp)", white: false },
              { c: RED, t: "Well over (+3pp or more)", white: true },
              { c: "#aaa", t: "Under the set rate (fine)", white: true },
            ].map((l) => (
              <span key={l.t} style={{ fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 999, background: l.c, color: l.white ? "#fff" : "#000", border: "1.5px solid #000" }}>{l.t}</span>
            ))}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 11, color: "#000", minWidth: "100%" }}>
              <thead>
                <tr>
                  <th style={{ padding: "6px 10px", textAlign: "left", borderBottom: "2px solid #000", color: "#444", fontWeight: 800, fontSize: 10, textTransform: "uppercase" }}>CAPTAIN ↓ / SOURCE →</th>
                  {driftHeatmap.sources.map((s) => (
                    <th key={s} style={{ padding: "6px 10px", textAlign: "center", borderBottom: "2px solid #000", color: "#000", textTransform: "uppercase", fontSize: 10, letterSpacing: ".3px", fontWeight: 900 }}>
                      {AGGREGATOR_OPTIONS.find(a => a.value === s)?.label || s}
                      <div style={{ fontSize: 9, color: "#888", fontWeight: 500, marginTop: 2 }}>def {getAggregatorDiscount(s)}%</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {driftHeatmap.captains.map((cap) => (
                  <tr key={cap}>
                    <td style={{ padding: "6px 10px", color: "#000", fontWeight: 700, borderBottom: "1px solid #eee" }}>{cap}</td>
                    {driftHeatmap.sources.map((s) => {
                      const cell = driftHeatmap.grid.get(cap)?.get(s);
                      if (!cell || cell.count === 0) {
                        return <td key={s} style={{ padding: "6px 10px", textAlign: "center", color: "#ccc", borderBottom: "1px solid #eee" }}>—</td>;
                      }
                      const avgDelta = Math.round((cell.sumDelta / cell.count) * 10) / 10;
                      const sevColor = avgDelta >= 3 ? RED : avgDelta >= 1 ? AMBER : avgDelta <= -1 ? "#aaa" : GREEN;
                      const bgAlpha = Math.min(0.35, Math.abs(avgDelta) * 0.06);
                      const extraRs = Math.round(cell.extraRs);
                      return (
                        <td key={s} style={{ padding: "6px 10px", textAlign: "center", background: avgDelta > 0 ? `${sevColor}${Math.round(bgAlpha * 255).toString(16).padStart(2, "0")}` : "transparent", color: sevColor, fontWeight: 800, borderBottom: "1px solid #eee" }}>
                          {avgDelta > 0 ? "+" : ""}{avgDelta}pp
                          <div style={{ fontSize: 9, color: "#999", fontWeight: 400, marginTop: 2 }}>{cell.count} tab{cell.count > 1 ? "s" : ""}</div>
                          {extraRs >= 1 && <div style={{ fontSize: 9, color: sevColor, fontWeight: 700, marginTop: 1 }}>≈₹{extraRs.toLocaleString("en-IN")}</div>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Drill-down — KOT vs Bill leakage */}
      {drill === "kotBillTally" && (
        <div style={{ background: "#fff", border: "2px solid #000", padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 900, color: "#000", textTransform: "uppercase" }}>🧾 KOT vs Bill — Leakage Drill-down</div>
              <div style={{ fontSize: 10, color: "#666", marginTop: 2, fontWeight: 500 }}>
                Closed tables tonight where printed KOTs don't match the final bill (after subtracting manager-approved voids).
                🔴 ≥₹500 unbilled · 🟠 small gap · 👻 phantom = bill &gt; KOT. Full breakdown in <strong>Reports → 🧾 KOT vs Bill</strong>.
              </div>
            </div>
            <button onClick={() => setDrill(null)} style={{ background: "#F4F4F0", border: "2px solid #000", color: "#000", padding: "4px 10px", fontSize: 11, cursor: "pointer", fontWeight: 700, boxShadow: "2px 2px 0px #000" }}>✕ Close</button>
          </div>
          {tallyRows.filter(r => r.verdict === "leakage" || r.verdict === "phantom" || r.verdict === "minor").length === 0 ? (
            <div style={{ fontSize: 12, color: GREEN, fontWeight: 700 }}>✓ All {tallyRows.length} closed tables tonight tally clean — no KOT-bill mismatches.</div>
          ) : (
            <>
              {tallyByCaptain.filter(c => c.totalLeakage + c.totalPhantom > 0).length > 0 && (
                <div style={{ marginBottom: 12, padding: 10, background: "#FFF0EE", border: "2px solid #FF5733" }}>
                  <div style={{ fontSize: 11, fontWeight: 900, color: RED, marginBottom: 6, textTransform: "uppercase" }}>👤 Per-Captain Leakage Tonight</div>
                  {tallyByCaptain.filter(c => c.totalLeakage + c.totalPhantom > 0).map(c => (
                    <div key={c.captain} style={{ display: "flex", justifyContent: "space-between", padding: "4px 2px", fontSize: 12, borderBottom: "1px solid #eee" }}>
                      <div><strong style={{ color: "#000" }}>{c.captain}</strong> · {c.tables} table{c.tables !== 1 ? "s" : ""}</div>
                      <div style={{ color: c.totalLeakage > 0 ? RED : AMBER, fontWeight: 800 }}>
                        {c.leakageTables > 0 && <>🔴 {c.leakageTables} · ₹{c.totalLeakage.toLocaleString()} unbilled</>}
                        {c.phantomTables > 0 && <span style={{ marginLeft: 8, color: AMBER }}>👻 {c.phantomTables} · ₹{c.totalPhantom.toLocaleString()} phantom</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ maxHeight: 360, overflowY: "auto" }}>
                {tallyRows.filter(r => r.verdict === "leakage" || r.verdict === "phantom" || r.verdict === "minor").map(r => (
                  <div key={r.reservationId} style={{ padding: "8px 6px", borderBottom: "1px solid #eee", fontSize: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <span style={{ color: "#000", fontWeight: 800 }}>{r.tableId}</span>
                        <span style={{ color: "#888", marginLeft: 6 }}>{r.floor}</span>
                        <span style={{ color: "#000", marginLeft: 8 }}>{r.customerName || "—"}</span>
                        <span style={{ color: "#888", marginLeft: 6 }}>· {r.captain || "—"}</span>
                      </div>
                      <div style={{ fontWeight: 800, color: r.verdict === "leakage" ? RED : r.verdict === "phantom" ? AMBER : "#888" }}>
                        {r.verdict === "leakage" && `🔴 ₹${r.leakageValue.toLocaleString()} UNBILLED`}
                        {r.verdict === "phantom" && `👻 ₹${r.phantomValue.toLocaleString()} PHANTOM`}
                        {r.verdict === "minor" && `🟠 ₹${Math.abs(r.diffValue).toLocaleString()} gap`}
                      </div>
                    </div>
                    {r.itemDiffs.length > 0 && (
                      <div style={{ fontSize: 10, color: "#666", marginTop: 4, paddingLeft: 8 }}>
                        {r.itemDiffs.slice(0, 4).map((d, i) => (
                          <span key={i} style={{ marginRight: 12 }}>
                            <strong>{d.name}</strong>: KOT {d.kotQty}{d.voidQty > 0 ? ` − void ${d.voidQty}` : ""} → bill {d.billQty} ({d.diffQty > 0 ? "+" : ""}{d.diffQty})
                          </span>
                        ))}
                        {r.itemDiffs.length > 4 && <span>+{r.itemDiffs.length - 4} more…</span>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Drill-down — generic tiles */}
      {drill && drill !== "kotBillTally" && drillEvents.length > 0 && (
        <div style={{ background: "#fff", border: "2px solid #000", padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 900, color: "#000", textTransform: "uppercase" }}>📋 {tiles.find(t => t.id === drill)?.label} — Drill-down</div>
            <button onClick={() => setDrill(null)} style={{ background: "#F4F4F0", border: "2px solid #000", color: "#000", padding: "4px 10px", fontSize: 11, cursor: "pointer", fontWeight: 700, boxShadow: "2px 2px 0px #000" }}>✕ Close</button>
          </div>
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {drillEvents.map((e) => (
              <div key={e.id} style={{ display: "grid", gridTemplateColumns: "70px 60px 80px 1fr 80px", gap: 8, padding: "8px 6px", borderBottom: "1px solid #eee", fontSize: 12, alignItems: "center" }}>
                <div style={{ color: "#888", fontSize: 10, fontWeight: 500 }}>{fmtRel(e.at)}</div>
                <div style={{ color: "#000", fontWeight: 800 }}>{e.table}</div>
                <div style={{ color: "#000", fontWeight: 600 }}>{e.staff}</div>
                <div style={{ color: "#222" }}>
                  <div>{e.details}</div>
                  {e.reason && <div style={{ fontSize: 10, color: "#777", marginTop: 2 }}>↳ "{e.reason}"</div>}
                </div>
                <div style={{ textAlign: "right", color: e.amount ? sevColor(e.severity) : "#ccc", fontWeight: 800 }}>
                  {e.amount ? `₹${e.amount.toLocaleString()}` : ""}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Modified discount list */}
      {modifiedDiscount.length > 0 && (
        <div style={{ background: "#FFFBEB", border: "2px solid #F2C744", padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 900, color: "#000", marginBottom: 10, textTransform: "uppercase" }}>✎ Tabs with non-default discount (live)</div>
          {modifiedDiscount.map((m) => (
            <div key={m.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 4px", borderBottom: "1px solid #eee", fontSize: 12 }}>
              <div><span style={{ color: "#000", fontWeight: 800 }}>{m.tableId}</span> · {m.customerName} · {m.aggregator}</div>
              <div style={{ color: AMBER, fontWeight: 800 }}>{m.defaultDisc}% → {m.actualDisc}%</div>
            </div>
          ))}
        </div>
      )}

      {/* Admin actions log */}
      <div style={{ background: "#fff", border: "2px solid #000", padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 900, color: "#000", textTransform: "uppercase" }}>🛠 Admin / Manager Actions Tonight ({auditEvents.length})</div>
          <button onClick={() => setDrill(drill === "audit" ? null : "audit")}
            style={{ background: "#F4F4F0", border: "2px solid #000", color: "#000", padding: "4px 10px", fontSize: 11, cursor: "pointer", fontWeight: 700, boxShadow: "2px 2px 0px #000" }}>
            {drill === "audit" ? "Hide" : "Show all"}
          </button>
        </div>
        {auditEvents.length === 0 ? (
          <div style={{ fontSize: 12, color: "#888", fontWeight: 500 }}>No admin-side changes logged tonight.</div>
        ) : drill !== "audit" ? (
          <div style={{ fontSize: 11, color: "#555", fontWeight: 500 }}>Latest: {auditEvents[0].details} ({fmtRel(auditEvents[0].at)})</div>
        ) : null}
      </div>
    </div>
  );
}
