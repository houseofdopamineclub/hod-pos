// ─────────────────────────────────────────────────────────────────────────
//  💰 SALES  —  Boss Mode whole-venue sales over a date range
// ─────────────────────────────────────────────────────────────────────────
//  Combines BAR + TABLES + NC for the WHOLE venue (all floors — per-floor
//  splits already live in Captain/Bar modes). Loads ON DEMAND (one-shot range
//  getDocs only when the owner taps LOAD) so idle Boss Mode pays zero reads.
//  All money math is re-used from lib/venue-sales.ts (which mirrors LiveReports
//  + BarMode to the rupee). Gumroad theme, fail-open.
// ─────────────────────────────────────────────────────────────────────────
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { getOperationalNightStr } from "@/lib/utils-pos";
import { useEffectiveMenu } from "@/lib/use-effective-menu";
import {
  getVenueSalesCached, fetchVenueRange, buildSalesTickets,
  type VenueSalesResult, type VenueSales, type PaymentMix,
} from "@/lib/venue-sales";
import { resetTonightData, sha256, type ResetTonightReport } from "@/lib/firestore-hod";
import {
  subscribeOpenNc, fetchNcForRange, type BillDueDoc,
} from "@/lib/bill-due";
// 🆕 2026-06-30 (Khushi) — the per-mode "Live Reports" buttons were removed from
// Door / Bar / Captain. Those reports now live here as sub-tabs under Sales. Each
// report self-subscribes ONLY while its sub-tab is mounted (cost-safe).
import LiveReports from "./LiveReports";
import { LiveReportsModal } from "./DoorMode";
import { BarReportsModal } from "./BarMode";

// ── Gumroad theme tokens (match LiveReports / AdminPage) ──
const C = { ink: "#000", grey: "#6B6B6B", bg: "#F4F4F0", card: "#fff", accent: "#23A094", pink: "#FF90E8" };
const NUM_FONT = "'Space Grotesk', sans-serif";
const SHADOW_SM = "2px 2px 0px #000";

// ── 🧨 RESET TONIGHT guard ──
// Manager PIN hash = sha256("8888") — the SAME manager PIN used by Bar/Captain
// modes (BAR_MANAGER_HASH). A typed "RESET" + this PIN gates the destructive wipe.
const RESET_MANAGER_HASH = "2926a2731f4b312c08982cacf8061eb14bf65c1a87cc5d70e864e079c6220731";
const RESET_LABELS: Record<string, string> = {
  covers: "Wallets", tableReservations: "Live tables", tableHistory: "Closed tables",
  bookings: "Door entries", billDue: "NC tabs",
  posKOTs: "Bills / KOTs", posAuditLog: "Audit log",
};

const inr = (n: number) => `₹${Math.round(n || 0).toLocaleString("en-IN")}`;
const fmt = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
const parse = (night: string) => { const [y, m, d] = night.split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const shiftDays = (night: string, delta: number) => { const dt = parse(night); dt.setDate(dt.getDate() + delta); return fmt(dt); };

type Preset = "today" | "yesterday" | "week" | "month" | "lastmonth" | "custom";

function rangeForPreset(p: Preset, today: string): { start: string; end: string } {
  const dt = parse(today);
  switch (p) {
    case "today": return { start: today, end: today };
    case "yesterday": { const y = shiftDays(today, -1); return { start: y, end: y }; }
    case "week": return { start: shiftDays(today, -6), end: today };
    case "month": return { start: `${fmt(dt).slice(0, 7)}-01`, end: today };
    case "lastmonth": {
      const firstThis = new Date(dt.getFullYear(), dt.getMonth(), 1);
      const endPrev = new Date(firstThis); endPrev.setDate(0);
      const startPrev = new Date(endPrev.getFullYear(), endPrev.getMonth(), 1);
      return { start: fmt(startPrev), end: fmt(endPrev) };
    }
    default: return { start: today, end: today };
  }
}

const PAY_META: Array<{ key: keyof PaymentMix; label: string; color: string }> = [
  { key: "wallet", label: "Wallet", color: "#FF90E8" },
  { key: "cash", label: "Cash", color: "#23A094" },
  { key: "card", label: "Card", color: "#2563EB" },
  { key: "upi", label: "UPI", color: "#7C3AED" },
  { key: "online", label: "Online", color: "#0EA5E9" },
  { key: "aggregator", label: "Aggregator", color: "#F59E0B" },
  { key: "comp", label: "Comp", color: "#9CA3AF" },
  { key: "other", label: "Other", color: "#6B7280" },
];

// The Payment Methods pie + the mini-table below it show ONLY the real tender
// types collected at settlement (Cash / Card / UPI / Other). Wallet / aggregator
// / comp are not cash-in-hand tenders, so they stay out of this chart.
const TENDER_META: Array<{ key: keyof PaymentMix; label: string; color: string }> = [
  { key: "cash", label: "Cash", color: "#23A094" },
  { key: "card", label: "Card", color: "#2563EB" },
  { key: "upi", label: "UPI", color: "#7C3AED" },
  { key: "other", label: "Other", color: "#6B7280" },
];

export default function SalesTab() {
  const today = useMemo(() => getOperationalNightStr(), []);
  const MENU_ITEMS = useEffectiveMenu();
  const foodNames = useMemo(
    () => new Set((MENU_ITEMS as Array<{ group?: string; name?: string }>)
      .filter((m) => m.group === "food")
      .map((m) => String(m.name || "").toLowerCase().replace(/\s+/g, " ").trim())),
    [MENU_ITEMS],
  );

  const [preset, setPreset] = useState<Preset>("today");
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<VenueSalesResult | null>(null);
  const [loadedRange, setLoadedRange] = useState("");
  // The date bounds that the CURRENT `result` was actually loaded for. The NC
  // dashboard's comp fetch keys off THESE (not the live From/To inputs) so
  // changing the inputs WITHOUT tapping LOAD never triggers an off-range fetch.
  const [loadedBounds, setLoadedBounds] = useState<{ s: string; e: string } | null>(null);
  const [cacheNote, setCacheNote] = useState("");
  const [ticketBusy, setTicketBusy] = useState(false);
  const autoLoaded = useRef(false);
  const [subTab, setSubTab] = useState<"venue" | "nc" | "door" | "bar" | "captain">("venue");

  // ── 🧨 RESET TONIGHT — destructive Boss-mode wipe of tonight's data ──
  const [resetOpen, setResetOpen] = useState(false);
  const [resetWord, setResetWord] = useState("");
  const [resetPin, setResetPin] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetErr, setResetErr] = useState("");
  const [resetReport, setResetReport] = useState<ResetTonightReport | null>(null);
  const closeReset = () => {
    if (resetBusy) return;
    setResetOpen(false); setResetWord(""); setResetPin(""); setResetErr(""); setResetReport(null);
  };
  const openReset = () => {
    setResetReport(null); setResetErr(""); setResetWord(""); setResetPin(""); setResetOpen(true);
  };
  const runReset = async () => {
    if (resetBusy) return;
    if (resetWord.trim().toUpperCase() !== "RESET") { setResetErr("Type the word RESET to confirm."); return; }
    let ok = false;
    try { ok = (await sha256(resetPin.trim())) === RESET_MANAGER_HASH; } catch { ok = false; }
    if (!ok) { setResetErr("WRONG MANAGER PIN"); setResetPin(""); return; }
    setResetErr(""); setResetBusy(true);
    try {
      // recompute the operational night at CLICK time (the Boss tab may have been
      // open across the 7AM rollover, which would make the mount-time `today` stale)
      const night = getOperationalNightStr();
      const rep = await resetTonightData(night);
      setResetReport(rep);
      await load(); // refresh the dashboard so the owner sees 0 immediately
    } catch {
      setResetErr("Reset failed. Please try again.");
    } finally {
      setResetBusy(false);
    }
  };

  const applyPreset = (p: Preset) => {
    setPreset(p);
    if (p !== "custom") { const r = rangeForPreset(p, today); setStart(r.start); setEnd(r.end); }
  };

  const load = async () => {
    if (loading) return;
    autoLoaded.current = true; // any load (auto, manual, or refresh) cancels the pending auto-load fallback
    let s = start, e = end;
    if (s > e) { const t = s; s = e; e = t; setStart(s); setEnd(e); }
    setLoading(true); setErr("");
    try {
      const res = await getVenueSalesCached(s, e, today, foodNames);
      setResult(res);
      setLoadedRange(s === e ? s : `${s} → ${e}`);
      setLoadedBounds({ s, e });
      const saved = res.fromCache;
      const fresh = res.computed;
      const liveN = res.live;
      const bits: string[] = [];
      if (saved) bits.push(`${saved} saved`);
      if (fresh) bits.push(`${fresh} newly saved`);
      if (liveN) bits.push(`${liveN} live`);
      setCacheNote(bits.length ? `Nights: ${bits.join(" · ")}. Past nights load almost free next time.` : "");
    } catch {
      setErr("Could not load sales. Please try again.");
      setResult(null);
      setCacheNote("");
    } finally {
      setLoading(false);
    }
  };

  // Auto-load TODAY the first time Sales opens so the owner sees tonight's live
  // numbers instantly (no need to tap LOAD). Waits for the menu so the food/drink
  // split is right; a 1.2s fallback fires even if the menu never populates.
  useEffect(() => {
    if (autoLoaded.current) return;
    if (MENU_ITEMS.length === 0) return;
    autoLoaded.current = true;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [MENU_ITEMS]);
  useEffect(() => {
    const id = setTimeout(() => {
      if (!autoLoaded.current) { autoLoaded.current = true; void load(); }
    }, 1200);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── CSV (multi-section, BOM so Excel opens it cleanly) ──
  const downloadCsv = () => {
    if (!result) return;
    const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const t = result.total;
    const L: string[] = [];
    L.push(`HOD Whole-Venue Sales,${esc(loadedRange)}`);
    L.push(`Nights,${result.perNight.length}`);
    L.push("");
    L.push("SUMMARY");
    L.push("Metric,Amount Rs");
    const rows: Array<[string, number]> = [
      ["Net Sales", t.netSales], ["Gross Sales", t.grossSales],
      ["  Tables Net", t.tableNet], ["  Bar Net (incl NC chargeable)", t.barNet],
      ["Total Orders", t.orders], ["Total Guests", t.guests],
      ["Food Sales", t.foodSales], ["Drink Sales", t.drinkSales],
      ["Service Charge", t.serviceCharge], ["Tax (GST)", t.tax],
      ["Discount (total)", t.discount], ["  In-house Discount", t.inhouseDiscount], ["  Aggregator Discount", t.aggregatorDiscount],
      ["Cover Charges Collected at Door", t.coverChargesAtDoor], ["Recharges Made", t.recharges],
      ["Redeemed", t.redeemed], ["Not Redeemed (kept)", t.notRedeemed],
      ["NC Comp Given (comp+waived+disc)", t.ncComp + t.ncDiscount + t.ncWaived],
      ["  NC Comp (Rs1000 lines)", t.ncComp], ["  NC Waived", t.ncWaived], ["  NC Discount", t.ncDiscount],
      ["NC Due (chargeable)", t.ncDue],
    ];
    for (const [k, v] of rows) L.push([k, Math.round(v)].map(esc).join(","));
    L.push("");
    L.push("PAYMENT METHODS (real tender collected - cash/card/UPI into the drawer)");
    L.push("Method,Amount Rs");
    for (const m of PAY_META) L.push([m.label, Math.round(t.pay[m.key])].map(esc).join(","));
    L.push("");
    L.push("DAILY BREAKDOWN");
    L.push(["Night", "Net", "Gross", "Orders", "Guests", "Service Charge", "Tax", "Discount", "Recharges", "Redeemed", "Not Redeemed"].join(","));
    for (const n of result.perNight) {
      L.push([n.night, Math.round(n.netSales), Math.round(n.grossSales), n.orders, n.guests,
        Math.round(n.serviceCharge), Math.round(n.tax), Math.round(n.discount),
        Math.round(n.recharges), Math.round(n.redeemed), Math.round(n.notRedeemed)].map(esc).join(","));
    }
    const blob = new Blob(["\uFEFF" + L.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `HOD_VenueSales_${start}_to_${end}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── PER-TICKET SALES REPORT (Digitory-style) — one-shot range fetch on tap ──
  // A SETTLEMENT view: one row per fully-settled F&B bill (tables + bar covers),
  // tender columns sum to each Total. Re-fetches raw docs on demand (same cheap
  // one-shot getDocs the dashboard uses); idle Boss Mode pays zero extra reads.
  const downloadTicketCsv = async () => {
    if (ticketBusy) return;
    let s = start, e = end;
    if (s > e) { const tmp = s; s = e; e = tmp; }
    setTicketBusy(true); setErr("");
    try {
      const raw = await fetchVenueRange(s, e);
      const tickets = buildSalesTickets(raw);
      const esc = (v: unknown) => { const str = v == null ? "" : String(v); return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str; };
      const money = (n: number) => (!n ? "" : n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })); // blank on 0 (matches Digitory)
      const moneyT = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });            // totals always show
      const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const dt = (iso: string) => { const d = new Date(iso || 0); if (isNaN(d.getTime())) return ""; const p = (x: number) => String(x).padStart(2, "0"); return `${p(d.getDate())}-${MON[d.getMonth()]}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
      const HEADERS = ["Ticket No", "Total Checks", "Guest Count", "Close Date Time", "Base Price", "Discount", "Net Sales", "Total Charge", "Total Tax", "Round Off", "Total", "Cash", "SWIGGY", "ZOMATO", "Token", "Card", "Due Payment", "UPI", "Prepaid"];
      const sum = tickets.reduce((a, r) => {
        a.guests += r.guests; a.basePrice += r.basePrice; a.discount += r.discount; a.netSales += r.netSales;
        a.serviceCharge += r.serviceCharge; a.tax += r.tax; a.roundOff += r.roundOff; a.total += r.total;
        a.cash += r.cash; a.swiggy += r.swiggy; a.zomato += r.zomato; a.token += r.token;
        a.card += r.card; a.due += r.due; a.upi += r.upi; a.prepaid += r.prepaid;
        return a;
      }, { guests: 0, basePrice: 0, discount: 0, netSales: 0, serviceCharge: 0, tax: 0, roundOff: 0, total: 0, cash: 0, swiggy: 0, zomato: 0, token: 0, card: 0, due: 0, upi: 0, prepaid: 0 });
      const totalRow = (label: string) => [
        label, tickets.length, sum.guests, "",
        moneyT(sum.basePrice), moneyT(sum.discount), moneyT(sum.netSales), moneyT(sum.serviceCharge), moneyT(sum.tax), moneyT(sum.roundOff), moneyT(sum.total),
        money(sum.cash), money(sum.swiggy), money(sum.zomato), money(sum.token), money(sum.card), money(sum.due), money(sum.upi), money(sum.prepaid),
      ].map(esc).join(",");
      const L: string[] = [];
      L.push(["Sales Report", "House of Dopamine", `From : ${s}  To : ${e}`].map(esc).join(","));
      L.push("");
      L.push(HEADERS.map(esc).join(","));
      L.push(totalRow("House of Dopamine"));
      for (const r of tickets) {
        L.push([
          r.ticketNo, 1, r.guests, dt(r.closeAt),
          moneyT(r.basePrice), money(r.discount), moneyT(r.netSales), money(r.serviceCharge), money(r.tax), money(r.roundOff), moneyT(r.total),
          money(r.cash), money(r.swiggy), money(r.zomato), money(r.token), money(r.card), money(r.due), money(r.upi), money(r.prepaid),
        ].map(esc).join(","));
      }
      L.push(totalRow("Total"));
      const blob = new Blob(["\uFEFF" + L.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `HOD_SalesReport_${s}_to_${e}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setErr("Could not build the sales report. Please try again.");
    } finally {
      setTicketBusy(false);
    }
  };

  // ── small components ──
  const PresetBtn = ({ id, label }: { id: Preset; label: string }) => (
    <button onClick={() => applyPreset(id)}
      style={{ padding: "8px 14px", borderRadius: 8, background: preset === id ? C.ink : C.card, color: preset === id ? "#fff" : C.ink, border: `2px solid ${C.ink}`, fontSize: 13, fontWeight: 800, letterSpacing: 0.3, cursor: "pointer", whiteSpace: "nowrap" }}>
      {label}
    </button>
  );
  const Tile = ({ label, value, accent, sub }: { label: string; value: string; accent?: string; sub?: string }) => (
    <div style={{ background: C.card, border: `2px solid ${C.ink}`, borderRadius: 14, padding: 16, boxShadow: SHADOW_SM, minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: 0.6, textTransform: "uppercase", color: C.grey }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 900, fontFamily: NUM_FONT, color: accent || C.ink, marginTop: 6, lineHeight: 1.1, wordBreak: "break-word" }}>{value}</div>
      {sub ? <div style={{ fontSize: 11, fontWeight: 700, color: C.grey, marginTop: 3 }}>{sub}</div> : null}
    </div>
  );

  const t = result?.total;
  const payData = useMemo(
    () => !t ? [] : TENDER_META.map((m) => ({ name: m.label, value: Math.round(t.pay[m.key]), color: m.color })).filter((d) => d.value > 0),
    [t],
  );
  const trendData = useMemo(
    () => !result ? [] : result.perNight.map((n) => ({ night: n.night.slice(5), Net: Math.round(n.netSales), Gross: Math.round(n.grossSales) })),
    [result],
  );

  return (
    <div style={{ fontFamily: "Inter, sans-serif", color: C.ink }}>
      {/* 🆕 2026-06-30 (Khushi) — REPORT SUB-TABS. Venue Sales (existing) + the
          three per-mode reports (Door / Bar / Captain) consolidated here. Only the
          active sub-tab mounts, so its Firestore subscriptions run on demand. */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
        {([["venue", "💰 VENUE SALES"], ["nc", "🎟️ NC"], ["door", "🚪 DOOR REPORTS"], ["bar", "🍸 BAR REPORTS"], ["captain", "🪩 CAPTAIN REPORTS"]] as const).map(([k, lbl]) => (
          <button key={k} onClick={() => setSubTab(k)}
            style={{
              padding: "14px 24px", borderRadius: 12, border: `2px solid ${C.ink}`, cursor: "pointer",
              background: subTab === k ? C.pink : "#fff", color: C.ink, fontSize: 15.5, fontWeight: 900, letterSpacing: 0.6,
              textTransform: "uppercase", boxShadow: subTab === k ? SHADOW_SM : "none", fontFamily: NUM_FONT,
            }}>
            {lbl}
          </button>
        ))}
      </div>

      {subTab === "nc" && (
        <NcDashboard start={loadedBounds?.s || start} end={loadedBounds?.e || end} t={t} loaded={!!result && !!loadedBounds} loading={loading} onLoad={load} loadedRange={loadedRange} />
      )}

      {subTab === "door" && (
        <LiveReportsModal embedded agentName="Boss" tableResByDate={{}} selectedEventId="all" eventChips={[]} onClose={() => {}} />
      )}
      {subTab === "bar" && (
        <BarReportsModal embedded onClose={() => {}} />
      )}
      {subTab === "captain" && (
        <LiveReports />
      )}

      {subTab === "venue" && (<>
      <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: -0.4, marginBottom: 4 }}>💰 Sales — Whole Venue</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.grey, marginBottom: 16 }}>
        Bar + tables + NC, all floors combined. Opens on tonight's live numbers — pick a range + LOAD for other days.
      </div>

      {/* date controls */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <PresetBtn id="today" label="Today" />
        <PresetBtn id="yesterday" label="Yesterday" />
        <PresetBtn id="week" label="Last 7 Days" />
        <PresetBtn id="month" label="This Month" />
        <PresetBtn id="lastmonth" label="Last Month" />
        <PresetBtn id="custom" label="Custom" />
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 18 }}>
        <label style={{ fontSize: 12, fontWeight: 800, color: C.grey }}>From</label>
        <input type="date" value={start} max={today}
          onChange={(e) => { setPreset("custom"); setStart(e.target.value); }}
          style={{ padding: "9px 12px", borderRadius: 8, background: C.card, border: `2px solid ${C.ink}`, color: C.ink, fontSize: 13, fontWeight: 700 }} />
        <label style={{ fontSize: 12, fontWeight: 800, color: C.grey }}>To</label>
        <input type="date" value={end} max={today}
          onChange={(e) => { setPreset("custom"); setEnd(e.target.value); }}
          style={{ padding: "9px 12px", borderRadius: 8, background: C.card, border: `2px solid ${C.ink}`, color: C.ink, fontSize: 13, fontWeight: 700 }} />
        <button onClick={load} disabled={loading}
          style={{ padding: "10px 22px", borderRadius: 8, background: loading ? C.grey : C.pink, border: `2px solid ${C.ink}`, color: C.ink, fontSize: 14, fontWeight: 900, letterSpacing: 0.6, cursor: loading ? "default" : "pointer", boxShadow: SHADOW_SM }}>
          {loading ? "LOADING…" : "LOAD"}
        </button>
        {result ? <span style={{ fontSize: 12, fontWeight: 700, color: C.grey }}>{loadedRange} · {result.perNight.length} night{result.perNight.length === 1 ? "" : "s"}</span> : null}
      </div>
      {result && cacheNote ? <div style={{ fontSize: 11, fontWeight: 700, color: C.grey, marginTop: -4, marginBottom: 14 }}>💾 {cacheNote}</div> : null}

      {err ? <div style={{ padding: "10px 14px", borderRadius: 8, background: "#FEE2E2", border: "2px solid #B91C1C", color: "#7F1D1D", fontWeight: 800, fontSize: 13, marginBottom: 16 }}>{err}</div> : null}

      {!result && !loading ? (
        <div style={{ padding: 40, textAlign: "center", color: C.grey, fontWeight: 700, fontSize: 14, border: `2px dashed ${C.ink}`, borderRadius: 14 }}>
          Pick a range and tap LOAD to see whole-venue sales.
        </div>
      ) : null}

      {t && result ? (
        <>
          {/* TILES */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12, marginBottom: 20 }}>
            <Tile label="Net Sales" value={inr(t.netSales)} accent={C.accent} sub={`Tables ${inr(t.tableNet)} · Bar ${inr(t.barNet)}`} />
            <Tile label="Gross Sales" value={inr(t.grossSales)} sub="incl. SC + tax" />
            <Tile label="Total Orders" value={String(t.orders)} />
            <Tile label="Total Guests" value={String(t.guests)} />
            <Tile label="Cover Charges at Door" value={inr(t.coverChargesAtDoor)} />
            <Tile label="Recharges Made" value={inr(t.recharges)} />
            <Tile label="Redeemed" value={inr(t.redeemed)} />
            {/* 🆕 2026-06-29 (Khushi) — Not Redeemed card now carries a 2nd
                section, PAID ENTRY = the door dashboard "ENTRY COLLECTED" value
                (entry-only passes paid + entry fees on cover walk-ins), so the
                owner reads "loaded but unspent" and "collected at door" together.
                NOTE: this is entryCollected (door entry-pass money), NOT the
                wallet Cover-Charges-at-Door tile above — they're distinct lines.
                ZERO new reads beyond the one bookings range fetch. */}
            <div style={{ background: C.card, border: `2px solid ${C.ink}`, borderRadius: 14, padding: 16, boxShadow: SHADOW_SM, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: 0.6, textTransform: "uppercase", color: C.grey }}>Not Redeemed</div>
              <div style={{ fontSize: 26, fontWeight: 900, fontFamily: NUM_FONT, color: "#B45309", marginTop: 6, lineHeight: 1.1, wordBreak: "break-word" }}>{inr(t.notRedeemed)}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.grey, marginTop: 3 }}>loaded but unspent</div>
              <div style={{ borderTop: `1px dashed ${C.grey}`, marginTop: 12, paddingTop: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: 0.6, textTransform: "uppercase", color: C.grey }}>Paid Entry</div>
                <div style={{ fontSize: 26, fontWeight: 900, fontFamily: NUM_FONT, color: C.ink, marginTop: 6, lineHeight: 1.1, wordBreak: "break-word" }}>{inr(t.entryCollected)}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.grey, marginTop: 3 }}>entry passes collected at door</div>
              </div>
            </div>
            <Tile label="Service Charge" value={inr(t.serviceCharge)} />
            <Tile label="Total Discount Given" value={inr(t.discount)} accent="#B45309" sub={`In-house ${inr(t.inhouseDiscount)} · Agg ${inr(t.aggregatorDiscount)}`} />
            <Tile label="NC Comp Given" value={inr(t.ncComp + t.ncDiscount + t.ncWaived)} accent="#B45309" sub={`Comp ${inr(t.ncComp)} · Waived ${inr(t.ncWaived)} · Disc ${inr(t.ncDiscount)}`} />
            <Tile label="NC Due" value={inr(t.ncDue)} sub="chargeable above ₹1000" />
            <Tile label="Taxes (GST)" value={inr(t.tax)} />
            <Tile label="Food / Drink" value={`${inr(t.foodSales)} / ${inr(t.drinkSales)}`} />
          </div>

          {/* CHARTS */}
          <div style={{ display: "grid", gridTemplateColumns: trendData.length > 1 ? "minmax(0,1fr) minmax(0,1.4fr)" : "minmax(0,1fr)", gap: 16, marginBottom: 20 }}>
            <div style={{ background: C.card, border: `2px solid ${C.ink}`, borderRadius: 14, padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 900, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 2 }}>Payment Methods</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.grey, marginBottom: 8 }}>Real cash / card / UPI collected — bar wallet loads + table & NC bills.</div>
              {payData.length === 0 ? (
                <div style={{ color: C.grey, fontWeight: 700, fontSize: 13, padding: 20, textAlign: "center" }}>No settled payments in range.</div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie data={payData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={95} paddingAngle={2} stroke="#000" strokeWidth={2}>
                      {payData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Pie>
                    <Tooltip formatter={(v: number, n: string) => [inr(v), n]} />
                    <Legend wrapperStyle={{ fontSize: 12, fontWeight: 700 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
              {/* Cash / Card / UPI sales table inside the pie box */}
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 10 }}>
                <tbody>
                  {TENDER_META.map((m) => (
                    <tr key={m.key} style={{ borderTop: `1px solid #E5E5E0` }}>
                      <td style={{ padding: "7px 4px", fontWeight: 800 }}>
                        <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: m.color, border: "1px solid #000", marginRight: 8, verticalAlign: "middle" }} />
                        {m.label}
                      </td>
                      <td style={{ padding: "7px 4px", textAlign: "right", fontWeight: 900, fontFamily: NUM_FONT }}>{inr(t.pay[m.key])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {trendData.length > 1 ? (
              <div style={{ background: C.card, border: `2px solid ${C.ink}`, borderRadius: 14, padding: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 900, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 8 }}>Daily Sales</div>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={trendData} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                    <XAxis dataKey="night" tick={{ fontSize: 11, fontWeight: 700 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `₹${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v: number, n: string) => [inr(v), n]} />
                    <Legend wrapperStyle={{ fontSize: 12, fontWeight: 700 }} />
                    <Bar dataKey="Net" fill={C.accent} stroke="#000" strokeWidth={1.5} />
                    <Bar dataKey="Gross" fill={C.pink} stroke="#000" strokeWidth={1.5} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : null}
          </div>

          {/* DAILY TABLE (multi-night only) */}
          {result.perNight.length > 1 ? (
            <div style={{ background: C.card, border: `2px solid ${C.ink}`, borderRadius: 14, padding: 16, marginBottom: 16, overflowX: "auto" }}>
              <div style={{ fontSize: 13, fontWeight: 900, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 10 }}>Daily Breakdown</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr style={{ background: C.bg }}>
                  {["Night", "Net", "Gross", "Orders", "Guests", "SC", "Tax", "Discount", "Recharges", "Not Redeemed"].map((h, i) => (
                    <th key={h} style={{ padding: "8px 10px", fontWeight: 900, fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase", textAlign: i === 0 ? "left" : "right", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {result.perNight.map((n: VenueSales) => (
                    <tr key={n.night} style={{ borderTop: "1px solid #E5E5E5" }}>
                      <td style={{ padding: "8px 10px", fontWeight: 800 }}>{n.night}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: NUM_FONT, fontWeight: 800 }}>{inr(n.netSales)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: NUM_FONT }}>{inr(n.grossSales)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: NUM_FONT }}>{n.orders}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: NUM_FONT }}>{n.guests}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: NUM_FONT }}>{inr(n.serviceCharge)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: NUM_FONT }}>{inr(n.tax)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: NUM_FONT }}>{inr(n.discount)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: NUM_FONT }}>{inr(n.recharges)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: NUM_FONT }}>{inr(n.notRedeemed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button onClick={downloadCsv}
              style={{ padding: "11px 22px", borderRadius: 8, background: C.ink, border: `2px solid ${C.ink}`, color: "#fff", fontSize: 13, fontWeight: 900, letterSpacing: 0.6, cursor: "pointer" }}>
              ⬇ DOWNLOAD CSV (Excel)
            </button>
            <button onClick={downloadTicketCsv} disabled={ticketBusy}
              style={{ padding: "11px 22px", borderRadius: 8, background: ticketBusy ? C.grey : C.accent, border: `2px solid ${C.ink}`, color: "#fff", fontSize: 13, fontWeight: 900, letterSpacing: 0.6, cursor: ticketBusy ? "wait" : "pointer", boxShadow: SHADOW_SM }}>
              {ticketBusy ? "BUILDING…" : "🧾 SALES REPORT (per-ticket)"}
            </button>
          </div>
        </>
      ) : null}

      {/* 🧨 RESET TONIGHT — DANGER ZONE (Khushi 2026-06-30). One-tap zero-out of
          everything that feeds tonight's sales: wallets, tables, door entries, NC.
          Always visible in the Venue tab (works even before LOAD). Gated by a
          typed "RESET" + Manager PIN, then deletes tonight's docs. */}
      <div style={{ marginTop: 30, padding: 18, borderRadius: 14, border: "2px dashed #B91C1C", background: "#FEF2F2" }}>
        <div style={{ fontSize: 13, fontWeight: 900, letterSpacing: 0.6, textTransform: "uppercase", color: "#7F1D1D" }}>⚠️ Danger Zone</div>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "#7F1D1D", marginTop: 5, marginBottom: 13, lineHeight: 1.5 }}>
          Permanently deletes ALL of tonight's wallets, tables, door entries, NC tabs, bills &amp; audit records (<b>{today}</b>) so Sales <i>and</i> Live Monitor reset to zero. Wallet money is gone for good. This cannot be undone — use it only to clear a test night.
        </div>
        <button onClick={openReset}
          style={{ padding: "12px 24px", borderRadius: 10, background: "#B91C1C", border: "2px solid #000", color: "#fff", fontSize: 14, fontWeight: 900, letterSpacing: 0.6, cursor: "pointer", boxShadow: SHADOW_SM }}>
          🧨 RESET TONIGHT
        </button>
      </div>
      </>)}

      {resetOpen && createPortal(
        <div onClick={closeReset} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 99999, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", border: "3px solid #000", borderRadius: 16, padding: 24, maxWidth: 440, width: "100%", boxShadow: "6px 6px 0 #000", fontFamily: "Inter, sans-serif", color: C.ink }}>
            {!resetReport ? (<>
              <div style={{ fontSize: 21, fontWeight: 900, color: "#7F1D1D" }}>🧨 Reset Tonight?</div>
              <div style={{ fontSize: 13, fontWeight: 700, marginTop: 8, lineHeight: 1.5 }}>
                This permanently deletes <b>everything from tonight ({today})</b>:
                <ul style={{ margin: "8px 0 0 18px", padding: 0 }}>
                  <li>All wallets (loaded money is gone)</li>
                  <li>All tables (live &amp; closed)</li>
                  <li>All door entries &amp; guestlist</li>
                  <li>All NC tabs</li>
                  <li>All bills, KOTs &amp; audit records</li>
                </ul>
                <div style={{ marginTop: 9, color: "#7F1D1D", fontWeight: 900 }}>This cannot be undone.</div>
              </div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 800, color: C.grey, marginTop: 16 }}>Type RESET to confirm</label>
              <input value={resetWord} onChange={(e) => setResetWord(e.target.value)} autoCapitalize="characters" placeholder="RESET"
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `2px solid ${C.ink}`, fontSize: 15, fontWeight: 800, marginTop: 4, boxSizing: "border-box" }} />
              <label style={{ display: "block", fontSize: 12, fontWeight: 800, color: C.grey, marginTop: 12 }}>Manager PIN</label>
              <input value={resetPin} onChange={(e) => setResetPin(e.target.value)} type="password" inputMode="numeric" placeholder="••••"
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `2px solid ${C.ink}`, fontSize: 15, fontWeight: 800, marginTop: 4, boxSizing: "border-box" }} />
              {resetErr ? <div style={{ marginTop: 10, color: "#B91C1C", fontWeight: 800, fontSize: 13 }}>{resetErr}</div> : null}
              <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                <button onClick={closeReset} disabled={resetBusy}
                  style={{ flex: 1, padding: 12, borderRadius: 10, background: "#fff", border: `2px solid ${C.ink}`, color: C.ink, fontSize: 14, fontWeight: 900, cursor: resetBusy ? "default" : "pointer" }}>CANCEL</button>
                <button onClick={runReset} disabled={resetBusy}
                  style={{ flex: 1, padding: 12, borderRadius: 10, background: resetBusy ? C.grey : "#B91C1C", border: "2px solid #000", color: "#fff", fontSize: 14, fontWeight: 900, cursor: resetBusy ? "wait" : "pointer", boxShadow: SHADOW_SM }}>
                  {resetBusy ? "WIPING…" : "DELETE TONIGHT"}
                </button>
              </div>
            </>) : (<>
              <div style={{ fontSize: 21, fontWeight: 900, color: (resetReport.totalFailed || resetReport.anyQueryFailed || resetReport.totalSkipped) ? "#B45309" : C.accent }}>
                {(resetReport.totalFailed || resetReport.anyQueryFailed) ? "⚠️ Partly done" : "✅ Tonight reset"}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, marginTop: 10, lineHeight: 1.6 }}>
                Deleted <b>{resetReport.totalDeleted}</b> of {resetReport.totalFound} record{resetReport.totalFound === 1 ? "" : "s"} for {resetReport.night}.
                <div style={{ marginTop: 10, borderTop: `1px dashed ${C.grey}`, paddingTop: 10 }}>
                  {Object.entries(resetReport.perCollection).map(([col, s]) => {
                    const notes = [
                      s.failed ? `${s.failed} blocked` : "",
                      s.skipped ? `${s.skipped} kept` : "",
                      s.queryFailed ? "couldn't read" : "",
                    ].filter(Boolean).join(" · ");
                    return (
                      <div key={col} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, fontWeight: 800, padding: "2px 0" }}>
                        <span>{RESET_LABELS[col] || col}</span>
                        <span style={{ color: (s.failed || s.queryFailed || s.skipped) ? "#B45309" : C.grey }}>{s.deleted}/{s.found}{notes ? ` · ${notes}` : ""}</span>
                      </div>
                    );
                  })}
                </div>
                {resetReport.totalFailed ? <div style={{ marginTop: 12, color: "#B45309", fontWeight: 800 }}>{resetReport.totalFailed} record(s) couldn't be deleted (permissions). Tell your developer.</div> : null}
                {resetReport.anyQueryFailed ? <div style={{ marginTop: 8, color: "#B45309", fontWeight: 800 }}>Some data couldn't be read — tonight may not be fully cleared. Try again, or tell your developer.</div> : null}
                {resetReport.totalSkipped ? <div style={{ marginTop: 8, color: "#B45309", fontWeight: 800 }}>{resetReport.totalSkipped} NC running tab(s) kept (they span other nights too, so deleting them would erase that history).</div> : null}
              </div>
              <button onClick={closeReset}
                style={{ marginTop: 18, width: "100%", padding: 12, borderRadius: 10, background: C.ink, border: `2px solid ${C.ink}`, color: "#fff", fontSize: 14, fontWeight: 900, cursor: "pointer" }}>DONE</button>
            </>)}
          </div>
        </div>, document.body)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  🎟️ NC DASHBOARD — Boss → Sales → NC sub-tab
// ─────────────────────────────────────────────────────────────────────────
//  Three sections, all fail-open:
//    • NC COMP   — give-aways logged in the loaded date range (≤₹1000, no tax,
//                  excluded from Net/Gross). One-shot range fetch on LOAD.
//    • NC BILL DUE — currently-OPEN per-person running tabs (live listener):
//                  total billed / paid / balance + round + payment counts.
//                  These DO count in Net/Gross on the consumption night.
//    • OWNERS    — currently-OPEN owner tabs (live listener): amount owed,
//                  excluded from Net/Gross, "waive off" zeros it in Bar Mode.
//  The live listener mounts ONLY while this sub-tab is open (cost-safe). The
//  comp list reuses the SAME date range the owner already picked above.
// ─────────────────────────────────────────────────────────────────────────
function NcDashboard({
  start, end, t, loaded, loading, onLoad, loadedRange,
}: {
  start: string; end: string; t?: VenueSales; loaded: boolean;
  loading: boolean; onLoad: () => void; loadedRange: string;
}) {
  const [open, setOpen] = useState<BillDueDoc[]>([]);
  const [rangeDocs, setRangeDocs] = useState<BillDueDoc[]>([]);
  const [fetching, setFetching] = useState(false);

  // Live: currently-open NC tabs (billdue + owner). One listener, mount-gated.
  useEffect(() => {
    const unsub = subscribeOpenNc(setOpen);
    return () => unsub();
  }, []);

  // One-shot: every NC doc created in the loaded range (for the COMP list).
  useEffect(() => {
    let alive = true;
    if (!loaded) { setRangeDocs([]); return; }
    setFetching(true);
    fetchNcForRange(start, end).then((rows) => { if (alive) { setRangeDocs(rows); setFetching(false); } });
    return () => { alive = false; };
  }, [start, end, loaded]);

  const openBillDue = useMemo(() => open.filter((d) => d.kind === "billdue"), [open]);
  const openOwners = useMemo(() => open.filter((d) => d.kind === "owner" && !d.waived), [open]);
  const compRows = useMemo(
    () => rangeDocs
      .filter((d) => d.kind === "comp")
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)),
    [rangeDocs],
  );

  const compValue = (d: BillDueDoc) => Math.round(d.compApplied ?? d.amountDue ?? 0);
  const billedOf = (d: BillDueDoc) =>
    Math.round((d.rounds || []).reduce((s, r) => s + (r.total || 0), 0) || d.totalBill || d.amountDue || 0);
  const ownerOwed = (d: BillDueDoc) => Math.round(d.balanceDue ?? d.amountDue ?? 0);

  const compTotal = compRows.reduce((s, d) => s + compValue(d), 0);
  const billOutstanding = openBillDue.reduce((s, d) => s + Math.round(d.balanceDue ?? 0), 0);
  const ownerTotal = openOwners.reduce((s, d) => s + ownerOwed(d), 0);

  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: -0.4, marginBottom: 4 }}>🎟️ NC — Non-Chargeable</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.grey, marginBottom: 16 }}>
        Open tabs are LIVE (who owes / who's owed right now). Comp give-aways use the date range from VENUE SALES — tap LOAD there for other days.
      </div>

      {/* summary tiles (range aggregate from venue-sales, live outstanding) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12, marginBottom: 22 }}>
        <DashTile label="NC Comp Given" value={inr(t ? t.ncComp : compTotal)} accent="#B45309" sub="≤₹1000, no tax · excluded from sales" />
        <DashTile label="NC Bill Due Billed" value={inr(t?.ncBillDueBilled || 0)} accent={C.accent} sub="counts in Net/Gross" />
        <DashTile label="NC Bill Due Outstanding" value={inr(billOutstanding)} sub="balance owed (live)" />
        <DashTile label="Owners Owed" value={inr(ownerTotal)} sub="excluded from sales · live" />
      </div>

      {/* ── NC BILL DUE (per-person, live) ── */}
      <Section title="🧾 Open NC Bill Due — Running Tabs (live)">
        {openBillDue.length === 0 ? (
          <Empty>No open NC bill-due tabs. 🎉</Empty>
        ) : (
          <NcTable
            head={["Person", "Role", "Billed", "Paid", "Balance", "Rounds", "Payments"]}
            rows={openBillDue.map((d) => [
              d.customerName || "—",
              d.role || "—",
              inr(billedOf(d)),
              inr(Math.round(d.amountPaid || 0)),
              inr(Math.round(d.balanceDue ?? 0)),
              String((d.rounds || []).length),
              String((d.payments || []).length),
            ])}
            highlightCol={4}
          />
        )}
      </Section>

      {/* ── OWNERS (live) ── */}
      <Section title="👑 Owners — Outstanding (live)">
        {openOwners.length === 0 ? (
          <Empty>No outstanding owner tabs.</Empty>
        ) : (
          <NcTable
            head={["Owner", "Approved By", "Amount Owed", "Night"]}
            rows={openOwners.map((d) => [
              d.customerName || "—",
              d.approvedBy || "—",
              inr(ownerOwed(d)),
              d.lastRoundNight || d.operationalNight || "—",
            ])}
            highlightCol={2}
          />
        )}
      </Section>

      {/* ── NC COMP (range fetch) ── */}
      <Section title="🎁 NC Comp Given (in range)">
        {!loaded ? (
          <Empty>
            <button onClick={onLoad} disabled={loading}
              style={{ padding: "10px 22px", borderRadius: 8, background: loading ? C.grey : C.pink, border: `2px solid ${C.ink}`, color: C.ink, fontSize: 14, fontWeight: 900, letterSpacing: 0.6, cursor: loading ? "default" : "pointer", boxShadow: SHADOW_SM }}>
              {loading ? "LOADING…" : "LOAD RANGE"}
            </button>
            <div style={{ marginTop: 8 }}>Pick a date range under VENUE SALES, then LOAD to see comp give-aways.</div>
          </Empty>
        ) : fetching ? (
          <Empty>Loading comp records…</Empty>
        ) : compRows.length === 0 ? (
          <Empty>No NC comp given in {loadedRange || "this range"}.</Empty>
        ) : (
          <NcTable
            head={["Guest", "Role", "Comp Value", "Approved By", "Night"]}
            rows={compRows.map((d) => [
              d.customerName || "—",
              d.role || "—",
              inr(compValue(d)),
              d.approvedBy || "—",
              d.operationalNight || "—",
            ])}
            highlightCol={2}
          />
        )}
      </Section>
    </div>
  );
}

function DashTile({ label, value, accent, sub }: { label: string; value: string; accent?: string; sub?: string }) {
  return (
    <div style={{ background: C.card, border: `2px solid ${C.ink}`, borderRadius: 14, padding: 16, boxShadow: SHADOW_SM, minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: 0.6, textTransform: "uppercase", color: C.grey }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 900, fontFamily: NUM_FONT, color: accent || C.ink, marginTop: 6, lineHeight: 1.1, wordBreak: "break-word" }}>{value}</div>
      {sub ? <div style={{ fontSize: 11, fontWeight: 700, color: C.grey, marginTop: 3 }}>{sub}</div> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: C.card, border: `2px solid ${C.ink}`, borderRadius: 14, padding: 16, marginBottom: 16, overflowX: "auto" }}>
      <div style={{ fontSize: 13, fontWeight: 900, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ color: C.grey, fontWeight: 700, fontSize: 13, padding: 14, textAlign: "center" }}>{children}</div>;
}

function NcTable({ head, rows, highlightCol }: { head: string[]; rows: string[][]; highlightCol?: number }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead><tr style={{ background: C.bg }}>
        {head.map((h, i) => (
          <th key={h} style={{ padding: "8px 10px", fontWeight: 900, fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase", textAlign: i === 0 ? "left" : "right", whiteSpace: "nowrap" }}>{h}</th>
        ))}
      </tr></thead>
      <tbody>
        {rows.map((r, ri) => (
          <tr key={ri} style={{ borderTop: "1px solid #E5E5E5" }}>
            {r.map((c, ci) => (
              <td key={ci} style={{
                padding: "8px 10px", textAlign: ci === 0 ? "left" : "right",
                fontWeight: ci === 0 ? 800 : (ci === highlightCol ? 900 : 700),
                fontFamily: ci === 0 ? "inherit" : NUM_FONT,
                color: ci === highlightCol ? "#B45309" : C.ink,
                whiteSpace: "nowrap",
              }}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
