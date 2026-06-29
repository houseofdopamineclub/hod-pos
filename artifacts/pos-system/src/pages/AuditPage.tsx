import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, RefreshCw, Download } from "lucide-react";
import {
  getRecentBillPrints, getRecentKotPrints, getBillKotPrintsByRange,
  type BillAuditRow, type HodOrderItem,
} from "@/lib/firestore-hod";
import { getOperationalNightStr } from "@/lib/utils-pos";
import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { closeOnBackdrop } from "@/lib/centered-ui";

const GOLD = "#C9A84C";
const RED = "#EF4444";
const AMBER = "#F59E0B";
const BLUE = "#2563EB";
const PURPLE = "#A855F7";

/** Operational-night start (07:00 IST). A club night runs past midnight, so
 *  "today" = since 7 AM IST, NOT calendar midnight (a 1 AM bill still belongs to
 *  the night that opened the evening before). 07:00 IST = 01:30 UTC. Computed via
 *  UTC fields so it is correct no matter what timezone the viewer's device is in. */
function operationalNightStartMs(): number {
  const istNow = new Date(Date.now() + 5.5 * 3600_000); // UTC fields now read as IST wall-clock
  let y = istNow.getUTCFullYear(), m = istNow.getUTCMonth(), d = istNow.getUTCDate();
  if (istNow.getUTCHours() < 7) {                        // before 7 AM IST → still the previous night
    const prev = new Date(Date.UTC(y, m, d) - 86400_000);
    y = prev.getUTCFullYear(); m = prev.getUTCMonth(); d = prev.getUTCDate();
  }
  return Date.UTC(y, m, d, 1, 30, 0, 0);                 // 07:00 IST == 01:30 UTC
}

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

type Filter = "tonight" | "duplicates" | "voids" | "overrides" | "kots" | "bills" | "silent-edits";

export default function AuditPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("tonight");
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<AuditEvent | null>(null);
  // 📅 Download date range — defaults to tonight's operational night. Picking
  // wider dates pulls that exact range from the permanent cloud log.
  const todayNight = useMemo(() => getOperationalNightStr(), []);
  const [dlFrom, setDlFrom] = useState(todayNight);
  const [dlTo, setDlTo] = useState(todayNight);
  const [downloading, setDownloading] = useState(false);

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

  // 🌙 Every tab is scoped to TONIGHT (since 7 AM IST) — the owner only wants the
  // current night's KOTs/bills/etc on screen. Earlier nights are reached via the
  // ⬇ Download KOTs + Bills export (already-loaded data → 0 extra reads).
  const nightStart = operationalNightStartMs();
  const isTonight = (ev: AuditEvent) => new Date(ev.at).getTime() >= nightStart;
  const filtered = useMemo(() => events.filter((ev) => {
    if (new Date(ev.at).getTime() < nightStart) return false; // every tab = TONIGHT only (history is via ⬇ Download)
    if (filter === "tonight") return true;
    if (filter === "duplicates") return (ev.kind === "bill" && ev.row.isDuplicate) || (ev.kind === "kot" && ev.isDuplicate);
    if (filter === "voids") return ev.kind === "void";
    if (filter === "overrides") return ev.kind === "override";
    if (filter === "kots") return ev.kind === "kot";
    if (filter === "bills") return ev.kind === "bill";
    if (filter === "silent-edits") return ev.kind === "silent-edit";
    return true;
  }), [events, filter, nightStart]);

  const tonightEvents = events.filter(isTonight);
  const counts = {
    tonight: tonightEvents.length,
    duplicates: tonightEvents.filter((e) => (e.kind === "bill" && e.row.isDuplicate) || (e.kind === "kot" && e.isDuplicate)).length,
    voids: tonightEvents.filter((e) => e.kind === "void").length,
    overrides: tonightEvents.filter((e) => e.kind === "override").length,
    kots: tonightEvents.filter((e) => e.kind === "kot").length,
    bills: tonightEvents.filter((e) => e.kind === "bill").length,
    silentEdits: tonightEvents.filter((e) => e.kind === "silent-edit").length,
  };
  const nightLabel = new Date(nightStart).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short" });

  const fmt = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  };

  // ── Download KOTs + Bills as CSV for ANY date range the owner picks. Pulls
  //    the exact range from the permanent posKOTs cloud log (a real read, only on
  //    tap — never a listener). Every row carries its own IST Date + Time so the
  //    owner can sort/filter by any single day in Excel. ──
  // 07:00 IST (operational-night start) on the morning of YYYY-MM-DD = 01:30 UTC.
  const nightStartMsOf = (ymd: string) => Date.parse(`${ymd}T01:30:00Z`);

  const downloadCsv = async () => {
    if (downloading) return;
    const start = nightStartMsOf(dlFrom);
    // End = last millisecond BEFORE 07:00 IST the morning after `to`, so a print at
    // exactly the next night's 7 AM is NOT pulled into this night (exclusive boundary).
    const end = nightStartMsOf(dlTo) + 86_400_000 - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      alert("Please pick a valid date range — 'To' must be on or after 'From'."); return;
    }
    const nights = Math.round((end + 1 - start) / 86_400_000);
    if (nights > 7 && !window.confirm(
      `This will download ${nights} nights of bills + KOTs straight from the cloud.\n\n` +
      `Bigger ranges read more data (a small cost). Pick the smallest range you need.\n\nContinue?`
    )) return;

    setDownloading(true);
    try {
      const { bills, kots } = await getBillKotPrintsByRange(start, end);
      const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const row = (cells: unknown[]) => cells.map(esc).join(",");
      const r2 = (n: number) => Math.round(n * 100) / 100; // 2-decimal rupees
      const dt = (iso: string): [string, string] => {
        const d = new Date(iso);
        const date = d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
        const time = d.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false });
        return [date, time];
      };
      // 🆕 2026-06-28 (Khushi) — show HOW each bill was settled in plain words.
      // The stored paymentMethod is a raw token (e.g. "cash", "wallet+cash",
      // "split:cash+upi", or an aggregator slug like "zomato-district") — map it
      // to clean labels so the report clearly reads "Cash", "Card", "UPI", or the
      // actual platform "Swiggy"/"Zomato" instead of a slug. Combined modes
      // ("wallet+cash") are split and re-joined with " + ".
      const prettyPayMode = (raw: string | undefined): string => {
        const s = (raw || "").trim().toLowerCase();
        if (!s) return "Unspecified";
        const one = (t0: string): string => {
          const t = t0.replace(/^split:/, "").trim();
          if (!t) return "";
          if (t.includes("swiggy")) return "Swiggy";
          if (t.includes("zomato") || t.includes("district")) return "Zomato";
          if (t.includes("eazy")) return "EazyDiner";
          if (t.includes("magic")) return "Magicpin";
          if (t === "cash") return "Cash";
          if (t === "card") return "Card";
          if (t === "upi") return "UPI";
          if (t === "wallet") return "Wallet (prepaid)";
          if (t === "aggregator") return "Aggregator";
          if (t === "complimentary" || t === "comp") return "Complimentary";
          if (t === "waived") return "Waived";
          if (t === "online") return "Online";
          if (t === "other") return "Other";
          return t.charAt(0).toUpperCase() + t.slice(1);
        };
        const parts = s.split("+").map(one).filter(Boolean);
        return parts.length ? parts.join(" + ") : "Unspecified";
      };
      // GST back-calculation — must mirror the bill engine (computeHodBreakdown):
      //   gstBase = (food + non-alcoholic) + serviceCharge   ← alcohol is EXEMPT,
      //   but service charge IS taxed. GST = gstBase × 5% (CGST 2.5 + SGST 2.5).
      // So the value GST was actually charged on = (CGST+SGST)/5% = gstBase, and
      // that is the legal "Taxable Value @5%" for GSTR (it already includes SC).
      // The alcohol/exempt supply = net item value − the taxable food/soft items
      //   = (subtotal − discount) − (gstBase − serviceCharge).
      // These columns reconcile exactly:
      //   Taxable@5% + Exempt + CGST + SGST + RoundOff = Invoice Total.
      const gstBreakup = (b: { subtotal: number; discount: number; serviceCharge: number; cgst: number; sgst: number }) => {
        const gst = (b.cgst || 0) + (b.sgst || 0);
        const taxableValue = gst > 0 ? r2(gst / 0.05) : 0;          // = gstBase (incl. SC)
        const net = Math.max(0, (b.subtotal || 0) - (b.discount || 0));
        const taxableItemsExclSc = Math.max(0, taxableValue - (b.serviceCharge || 0));
        const exempt = Math.max(0, r2(net - taxableItemsExclSc));   // alcohol / non-GST supply
        return { gst, taxableValue, exempt };
      };

      // De-duplicate reprints: a bill ref prints "REF-1" (original) and "REF-2"
      // (reprint, often after a discount). For GST the FINAL print of each ref is
      // the real invoice. Group by ref base (strip trailing -N) + table + the
      // operational night (7AM IST) so reprints (seconds apart, same club night,
      // even across midnight) merge but two genuine bills that ever share a base
      // ref on different nights/tables never collapse.
      // Keep the latest print as the invoice; earlier prints are excluded reprints.
      const baseRef = (bn: string) => bn.replace(/-\d+$/, "");
      // Operational-night string (7AM IST boundary) for a given epoch-ms — same
      // rule as getOperationalNightStr() but for an arbitrary bill time, so a
      // reprint at 23:59 and 00:05 of the SAME club night share a key and merge.
      const opNight = (at: string) =>
        new Date(new Date(at).getTime() - 7 * 60 * 60 * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      const finalByRef = new Map<string, typeof bills[number]>();
      for (const b of bills) {
        const night = opNight(b.at);
        const key = b.billNumber ? `${baseRef(b.billNumber)}|${b.tableId}|${night}` : `__${b.tableId}__${b.at}`;
        const ex = finalByRef.get(key);
        if (!ex || b.at > ex.at) finalByRef.set(key, b);
      }
      const invoices = Array.from(finalByRef.values()).sort((a, b) => (a.at > b.at ? 1 : -1));
      const reprintCount = bills.length - invoices.length;

      const L: string[] = [];
      L.push("HOUSE OF DOPAMINE — GST REPORT (Bills + KOTs)");
      L.push(row(["Supplier GSTIN", bills.find((b) => b.gstin)?.gstin || "29AARFH2309E1ZC"]));
      L.push(row(["Period (club nights)", `${dlFrom} to ${dlTo}`, "A club night = 7 AM to next 7 AM"]));
      L.push(row(["Generated", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })]));
      L.push("");
      L.push("THIS FILE HAS 3 PARTS:");
      L.push("1) TAX INVOICE REGISTER = your actual GST bills (use this for GST filing). Reprints removed.");
      L.push("2) BILL ITEMS = the dishes/drinks on each bill (where the bill saved its items).");
      L.push("3) KOT REGISTER = kitchen/bar order tickets. These are NOT tax bills — operational only.");
      L.push("Note: alcohol is OUTSIDE GST (state excise). GST 5% (CGST 2.5% + SGST 2.5%) applies to food only.");
      L.push("");

      // ── GST SUMMARY (over final invoices only) ──
      const sum = invoices.reduce((a, b) => {
        const g = gstBreakup(b);
        a.subtotal += b.subtotal; a.discount += b.discount; a.sc += b.serviceCharge;
        a.cgst += b.cgst; a.sgst += b.sgst; a.taxable += g.taxableValue; a.exempt += g.exempt;
        a.roundOff += b.roundOff; a.total += b.total;
        const pm = prettyPayMode(b.paymentMethod);
        a.byPm.set(pm, (a.byPm.get(pm) || 0) + b.total);
        return a;
      }, { subtotal: 0, discount: 0, sc: 0, cgst: 0, sgst: 0, taxable: 0, exempt: 0, roundOff: 0, total: 0, byPm: new Map<string, number>() });
      L.push("=== GST SUMMARY (final invoices only) ===");
      L.push(row(["Number of invoices", invoices.length]));
      L.push(row(["Taxable value @5% (food + soft drinks + service charge)", r2(sum.taxable)]));
      L.push(row(["CGST (2.5%)", r2(sum.cgst)]));
      L.push(row(["SGST (2.5%)", r2(sum.sgst)]));
      L.push(row(["Total GST", r2(sum.cgst + sum.sgst)]));
      L.push(row(["Non-GST / exempt value (alcohol)", r2(sum.exempt)]));
      L.push(row(["Round off", r2(sum.roundOff)]));
      L.push(row(["GRAND TOTAL COLLECTED", r2(sum.total)]));
      L.push(row(["(of which service charge, already inside taxable value)", r2(sum.sc)]));
      L.push(row(["(of which discount given off item value)", r2(sum.discount)]));
      L.push("Check: Taxable@5% + Exempt + CGST + SGST + Round off = Grand Total.");
      L.push("");
      L.push("Collected by payment mode:");
      for (const [pm, amt] of Array.from(sum.byPm.entries()).sort((a, b) => b[1] - a[1])) L.push(row([pm, r2(amt)]));
      L.push("");

      // ── SECTION 1: TAX INVOICE REGISTER ──
      L.push("=== 1) TAX INVOICE REGISTER (GST bills — reprints removed) ===");
      L.push("Each row reconciles: Taxable@5% + Exempt + CGST + SGST + Round Off = INVOICE TOTAL. Taxable@5% already includes service charge (GST is charged on it). Alcohol is exempt.");
      L.push(row(["Date", "Time", "Invoice No", "Table", "Customer", "Cashier", "Payment",
        "Item Value", "Discount", "Service Charge", "Taxable @5%", "CGST", "SGST", "Exempt (alcohol)", "Round Off", "INVOICE TOTAL"]));
      for (const b of invoices) {
        const [date, time] = dt(b.at); const g = gstBreakup(b);
        L.push(row([date, time, b.billNumber, b.tableId, b.customerName, b.staff, prettyPayMode(b.paymentMethod),
          r2(b.subtotal), r2(b.discount), r2(b.serviceCharge), g.taxableValue, r2(b.cgst), r2(b.sgst), g.exempt, r2(b.roundOff), r2(b.total)]));
      }
      if (invoices.length === 0) L.push("(no bills in this range)");
      L.push("");

      // ── SECTION 2: BILL LINE ITEMS ──
      L.push("=== 2) BILL ITEMS (what was on each invoice) ===");
      L.push(row(["Date", "Time", "Invoice No", "Table", "Customer", "Item", "Qty", "Rate", "Amount", "Type", "GST treatment"]));
      let billItemRows = 0;
      for (const b of invoices) {
        const [date, time] = dt(b.at);
        for (const it of b.items) {
          billItemRows++;
          const isAlc = it.alc === true || (it.t === "drink" && it.alc !== false);
          L.push(row([date, time, b.billNumber, b.tableId, b.customerName, it.n, it.qty, r2(it.p), r2(it.p * it.qty),
            it.t === "food" ? "Food" : it.t === "drink" ? "Drink" : "—", isAlc ? "Non-GST (alcohol)" : "GST 5% (food)"]));
        }
      }
      if (billItemRows === 0) L.push("(bills in this range did not save line items — see KOT REGISTER below for the itemised orders)");
      L.push("");

      // ── SECTION 3: KOT REGISTER (operational, itemised) ──
      L.push("=== 3) KOT REGISTER (kitchen / bar order tickets — NOT tax bills) ===");
      L.push(row(["Date", "Time", "Table", "Customer", "Round", "Sent to", "Item", "Qty", "Rate", "Amount", "Staff", "Reprint"]));
      let kotItemRows = 0;
      for (const k of kots) {
        const [date, time] = dt(k.at); const sentTo = k.destinations.join(" ");
        if (k.items.length === 0) continue; // skip empty husk rounds
        for (const it of k.items) {
          kotItemRows++;
          L.push(row([date, time, k.tableId, k.customerName, k.roundNum, sentTo, it.n, it.qty, r2(it.p), r2(it.p * it.qty), k.staff, k.isDuplicate ? "YES" : ""]));
        }
      }
      if (kotItemRows === 0) L.push("(no KOTs in this range)");
      L.push("");
      if (reprintCount > 0) L.push(`Note: ${reprintCount} reprint(s)/duplicate bill print(s) were excluded from the GST totals above (only the final print of each bill counts).`);

      const blob = new Blob(["\uFEFF" + L.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `HOD_GST_Report_${dlFrom}_to_${dlTo}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert("Download failed — couldn't read that date range from the cloud.\n\n" + (e?.message || String(e)));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div style={{ color: "#000", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        {!embedded && (
          <Link href="/" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#000", textDecoration: "none", fontWeight: 700, border: "2px solid #000", padding: "6px 12px" }}>
            <ArrowLeft size={16} /> Back
          </Link>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 22, fontWeight: 900, color: "#000", margin: 0, textTransform: "uppercase", letterSpacing: "-.5px" }}>
            🔍 Operations Audit
          </h1>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#000", marginTop: 3 }}>
            <span style={{ background: "#FF90E8", color: "#000", padding: "2px 8px", border: "2px solid #000" }}>🌙 TONIGHT · {nightLabel} · since 7 AM</span>
          </div>
        </div>
        <button onClick={load} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#F4F4F0", border: "2px solid #000", color: "#000", padding: "8px 14px", cursor: "pointer", fontWeight: 700, boxShadow: "2px 2px 0px #000", fontSize: 13 }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* 📥 Download bills + KOTs for ANY date range (pulled from the permanent cloud log) */}
      <div style={{ border: "2px solid #000", background: "#FFF", padding: 12, marginBottom: 16, boxShadow: "3px 3px 0px #000" }}>
        <div style={{ fontSize: 14, fontWeight: 900, marginBottom: 2 }}>📥 Download Bills + KOTs (any dates)</div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: "#444", marginBottom: 10 }}>
          Every bill &amp; KOT is saved in the cloud forever. Pick the club nights you want and download them to Excel.
          A "night" runs 7&nbsp;AM → next 7&nbsp;AM. Bigger ranges read a little more data — pick the smallest you need.
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
          <label style={{ fontSize: 11, fontWeight: 800 }}>From
            <input type="date" value={dlFrom} max={todayNight} onChange={(e) => setDlFrom(e.target.value)}
              style={{ display: "block", marginTop: 3, border: "2px solid #000", padding: "6px 8px", fontWeight: 700, fontSize: 13, fontFamily: "inherit" }} />
          </label>
          <label style={{ fontSize: 11, fontWeight: 800 }}>To
            <input type="date" value={dlTo} max={todayNight} onChange={(e) => setDlTo(e.target.value)}
              style={{ display: "block", marginTop: 3, border: "2px solid #000", padding: "6px 8px", fontWeight: 700, fontSize: 13, fontFamily: "inherit" }} />
          </label>
          <button onClick={downloadCsv} disabled={downloading}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, background: downloading ? "#999" : "#000", border: "2px solid #000", color: "#fff", padding: "8px 16px", cursor: downloading ? "default" : "pointer", fontWeight: 800, boxShadow: "2px 2px 0px #000", fontSize: 13 }}>
            <Download size={14} /> {downloading ? "Preparing…" : "Download CSV"}
          </button>
        </div>
      </div>

      {/* Filter tab bar */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {([
          { id: "tonight",      label: `🌙 Tonight (${counts.tonight})`,    color: "#000",    bg: "#FF90E8" },
          { id: "voids",        label: `❌ Voids (${counts.voids})`,        color: "#fff",    bg: RED },
          { id: "silent-edits", label: `🔇 Silent Edits (${counts.silentEdits})`, color: "#000", bg: AMBER },
          { id: "overrides",    label: `🔒 Overrides (${counts.overrides})`,color: "#fff",    bg: PURPLE },
          { id: "duplicates",   label: `⚠ Duplicates (${counts.duplicates})`,color: "#000",  bg: AMBER },
          { id: "kots",         label: `🍳 KOTs (${counts.kots})`,          color: "#fff",    bg: BLUE },
          { id: "bills",        label: `🖨 Bills (${counts.bills})`,         color: "#000",    bg: "#F2C744" },
        ] as Array<{ id: Filter; label: string; color: string; bg: string }>).map((t) => (
          <button key={t.id} onClick={() => setFilter(t.id)}
            style={{
              padding: "8px 14px", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
              background: filter === t.id ? t.bg : "#fff",
              color: filter === t.id ? t.color : "#000",
              border: "2px solid #000",
              boxShadow: filter === t.id ? "3px 3px 0px #000" : "2px 2px 0px rgba(0,0,0,.35)",
              transform: filter === t.id ? "translate(-1px,-1px)" : "none",
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {loading && <div style={{ textAlign: "center", padding: 40, color: "#555", fontWeight: 500 }}>Loading audit log...</div>}
      {error && <div style={{ background: "#FFF0EE", border: "2px solid #EF4444", color: "#EF4444", padding: 14, fontWeight: 600 }}>Error: {error}</div>}

      {!loading && !error && filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: "#444", border: "2px dashed #999", fontWeight: 600 }}>
          Nothing for tonight yet. Use 📥 Download Bills + KOTs above to pull any past dates.
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((ev, i) => <AuditRow key={`${ev.kind}-${i}`} ev={ev} fmt={fmt} onSelect={setDetail} />)}
        </div>
      )}

      <div style={{ marginTop: 24, fontSize: 11, color: "#777", textAlign: "center" }}>
        Tonight = since 7 AM IST (a club night runs past midnight). Bill prints, KOTs, voids & manager-PIN overrides. Append-only — staff cannot delete. Tap a KOT or Bill for its items. Use 📥 Download Bills + KOTs (top) to export any past dates — every row has its date & time, so sort by date in Excel.
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
  const title = isBill ? (ev.row.invoiceNumber || ev.row.billNumber || "BILL") : ev.kind === "kot" ? `KOT · R${ev.roundNum}` : "DETAILS";
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
            <div style={{ textAlign: "center", color: "#555", fontWeight: 600, padding: 20 }}>No item details available for this record.</div>
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
                <div style={{ marginTop: 8, fontSize: 11, color: "#555", fontStyle: "italic" }}>
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

          <div style={{ marginTop: 12, fontSize: 11, color: "#555" }}>
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
        boxShadow: isDup ? `3px 3px 0px ${RED}` : "3px 3px 0px #000" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 52 }}>
          <div style={{ fontSize: 10, color: "#555", fontWeight: 600 }}>#{r.printIndex}</div>
          <div style={{ fontSize: 22 }}>{isDup ? "⚠️" : "🖨"}</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 900, color: accent }}>{r.invoiceNumber || r.billNumber}</span>
            {isDup && <span style={{ background: "#FFF0EE", color: RED, fontSize: 10, fontWeight: 900, padding: "2px 6px", border: `1px solid ${RED}`, letterSpacing: .5 }}>DUPLICATE</span>}
            <span style={{ background: r.source === "wallet" ? "#EFF6FF" : "#F5F0FF", color: r.source === "wallet" ? BLUE : PURPLE, fontSize: 10, fontWeight: 800, padding: "2px 6px", textTransform: "uppercase", border: `1px solid ${r.source === "wallet" ? BLUE : PURPLE}` }}>{r.source}</span>
          </div>
          <div style={{ fontSize: 13, color: "#000", fontWeight: 700, marginBottom: 2 }}>
            {r.ref} {r.customerName && `· ${r.customerName}`}
          </div>
          <div style={{ fontSize: 12, color: "#444" }}>
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
        boxShadow: "3px 3px 0px #000" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 52 }}>
          <div style={{ fontSize: 10, color: "#555", fontWeight: 600 }}>R{ev.roundNum}</div>
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
          <div style={{ fontSize: 12, color: "#444" }}>
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
        boxShadow: isBillVoid ? `3px 3px 0px ${RED}` : "3px 3px 0px #000" }}>
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
          <div style={{ fontSize: 12, color: "#444" }}>
            {fmt(ev.at)} · voided by <strong style={{ color: "#000" }}>{ev.by}</strong>
            {!isBillVoid && ev.reason && ` · "${ev.reason}"`}
          </div>
        </div>
        <div style={{ textAlign: "right", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: 10, color: "#555", marginBottom: 2, fontWeight: 500 }}>{isBillVoid ? "bill leakage" : "value lost"}</div>
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
        boxShadow: "3px 3px 0px #000" }}>
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
          <div style={{ fontSize: 12, color: "#444" }}>
            {fmt(ev.at)} · by <strong style={{ color: "#000" }}>{ev.by}</strong> · no manager PIN required (pre-print)
          </div>
        </div>
        <div style={{ textAlign: "right", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: 10, color: "#555", marginBottom: 2, fontWeight: 500 }}>silently dropped</div>
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
      boxShadow: "3px 3px 0px #000" }}>
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
        <div style={{ fontSize: 12, color: "#444" }}>
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
