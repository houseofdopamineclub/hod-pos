// 🧪 KOT-vs-BILL TALLY — fraud-scenario test harness.
// Run: node --experimental-strip-types artifacts/pos-system/src/lib/kot-bill-tally.test.ts
// Pure-logic exercise of every fraud / edge case Khushi cares about.

import {
  buildAllTallyRows,
  computeTallyRow,
  aggregateCaptainLeakage,
  isRealKot,
  type PosKotDoc,
  type TallyRow,
} from "./kot-bill-tally.ts";

let pass = 0, fail = 0;
const results: Array<{ name: string; ok: boolean; got: any; want: any; note?: string }> = [];

function check(name: string, ok: boolean, got: any, want: any, note?: string) {
  results.push({ name, ok, got, want, note });
  ok ? pass++ : fail++;
}

// Fixture builders ─────────────────────────────────────────────────────────
const MIN = 60_000;
const baseTime = Date.parse("2026-05-10T20:00:00+05:30");

function res(over: any = {}): any {
  return {
    _docId: over._docId || "r1",
    tableId: "T1",
    customerName: "Test Customer",
    captainName: "RAJESH",
    floorLabel: "GF",
    paymentStatus: "paid",
    paidAt: new Date(baseTime + 3 * 60 * MIN).toISOString(),
    bookedAt: new Date(baseTime).toISOString(),
    arrivalTime: new Date(baseTime).toISOString(),
    tabRounds: [],
    voidLog: [],
    ...over,
  };
}
function kot(items: Array<{n:string;p:number;qty:number}>, over: Partial<PosKotDoc> = {}): PosKotDoc {
  return {
    id: "k" + Math.random().toString(36).slice(2,7),
    tableId: "T1",
    items: items as any,
    createdAt: baseTime + 60 * MIN,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — CLEAN MATCH
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = res({ tabRounds: [{ items: [{n:"VODKA SHOT",p:400,qty:3},{n:"BEER",p:300,qty:2}] }] });
  const kots = [ kot([{n:"VODKA SHOT",p:400,qty:3},{n:"BEER",p:300,qty:2}]) ];
  const row = computeTallyRow(r, kots);
  check("S1 clean match → verdict=match", row.verdict === "match", row.verdict, "match");
  check("S1 diff = 0", row.diffValue === 0, row.diffValue, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — CASH-POCKET SCAM (KOT printed, items not on bill)
// ═══════════════════════════════════════════════════════════════════════════
{
  // Bartender served 5 vodka, captain only billed 3 → ₹800 leakage
  const r = res({ tabRounds: [{ items: [{n:"VODKA SHOT",p:400,qty:3}] }] });
  const kots = [ kot([{n:"VODKA SHOT",p:400,qty:5}]) ];
  const row = computeTallyRow(r, kots);
  check("S2 leakage detected (₹800 > ₹500 threshold)", row.verdict === "leakage", row.verdict, "leakage");
  check("S2 leakage value = ₹800", row.leakageValue === 800, row.leakageValue, 800);
  check("S2 mismatched item = vodka × 2", row.itemDiffs[0].diffQty === 2 && row.itemDiffs[0].name.toLowerCase().includes("vodka"), row.itemDiffs[0], "vodka diffQty=2");
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — LEGITIMATE VOID (manager-PIN approved)
// ═══════════════════════════════════════════════════════════════════════════
{
  // KOT 5 vodka, manager voided 2 (refund), bill 3 vodka → MATCH
  const r = res({
    tabRounds: [{ items: [{n:"VODKA SHOT",p:400,qty:3}] }],
    voidLog: [{ kind:"item-void", voided:[{n:"VODKA SHOT",p:400,qty:2}] }],
  });
  const kots = [ kot([{n:"VODKA SHOT",p:400,qty:5}]) ];
  const row = computeTallyRow(r, kots);
  check("S3 manager void absorbed → match", row.verdict === "match", row.verdict, "match");
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — PHANTOM BILL (billed > served, comp/error)
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = res({ tabRounds: [{ items: [{n:"WHISKEY",p:600,qty:3}] }] });
  const kots = [ kot([{n:"WHISKEY",p:600,qty:1}]) ];
  const row = computeTallyRow(r, kots);
  check("S4 phantom (₹1200 > ₹500 threshold)", row.verdict === "phantom", row.verdict, "phantom");
  check("S4 phantom value = ₹1200", row.phantomValue === 1200, row.phantomValue, 1200);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 5 — BILL VOIDED (whole bill cancelled — separate audit trail)
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = res({
    status: "voided",
    paymentStatus: "voided",
    tabRounds: [{ items: [{n:"VODKA",p:400,qty:5}] }],
    voidLog: [{ kind:"bill-void", billTotal: 2000, reason:"WALKED OUT" }],
  });
  const kots = [ kot([{n:"VODKA",p:400,qty:5}]) ];
  const row = computeTallyRow(r, kots);
  check("S5 bill-voided wins over leakage", row.verdict === "bill-voided", row.verdict, "bill-voided");
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 6 — NAME NORMALISATION ("VODKA SHOT  " vs "vodka shot")
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = res({ tabRounds: [{ items: [{n:"  vodka  shot ",p:400,qty:3}] }] });
  const kots = [ kot([{n:"VODKA SHOT",p:400,qty:3}]) ];
  const row = computeTallyRow(r, kots);
  check("S6 name normalisation matches dirty input", row.verdict === "match", row.verdict, "match");
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 7 — HAPPY-HOUR DUAL PRICE (same item, 2 prices in one night)
// ═══════════════════════════════════════════════════════════════════════════
{
  // KOT 1 @ ₹200 + KOT 1 @ ₹400 = ₹600 served. Bill same total → MATCH.
  const r = res({ tabRounds: [{ items: [{n:"VODKA",p:200,qty:1},{n:"VODKA",p:400,qty:1}] }] });
  const kots = [ kot([{n:"VODKA",p:200,qty:1}]), kot([{n:"VODKA",p:400,qty:1}]) ];
  const row = computeTallyRow(r, kots);
  check("S7 happy-hour dual-price → match (no false leakage drift)",
    row.verdict === "match" && row.diffValue === 0, { v: row.verdict, d: row.diffValue }, "match/0");
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 8 — MINOR DIFF (<₹500 → 🟠 minor, NOT red)
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = res({ tabRounds: [{ items: [{n:"WATER",p:100,qty:0}] }] });
  const kots = [ kot([{n:"WATER",p:100,qty:1}]) ]; // ₹100 leakage — too small for red
  const row = computeTallyRow(r, kots);
  check("S8 ₹100 leakage → minor (not red)", row.verdict === "minor", row.verdict, "minor");
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 9 — THRESHOLD EDGE CASE (exactly ₹500 → leakage, ₹499 → minor)
// ═══════════════════════════════════════════════════════════════════════════
{
  const r1 = res({ tabRounds: [] });
  const k1 = [ kot([{n:"X",p:500,qty:1}]) ];
  const row1 = computeTallyRow(r1, k1);
  check("S9a ₹500 exactly → LEAKAGE (red)", row1.verdict === "leakage", row1.verdict, "leakage");
  const r2 = res({ tabRounds: [] });
  const k2 = [ kot([{n:"X",p:499,qty:1}]) ];
  const row2 = computeTallyRow(r2, k2);
  check("S9b ₹499 → minor (not red)", row2.verdict === "minor", row2.verdict, "minor");
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 10 — KOT SUBSCRIPTION FAILED (status=error) → UNKNOWN, not phantom
// ═══════════════════════════════════════════════════════════════════════════
{
  // Bill has items, KOT data unavailable. WITHOUT the fix, this would
  // false-flag as PHANTOM (bill > zero KOT). WITH the fix → UNKNOWN.
  const r = res({ tabRounds: [{ items: [{n:"VODKA",p:400,qty:5}] }] });
  const row = computeTallyRow(r, [], { kotsStatus: "error" });
  check("S10 KOT failure → UNKNOWN (not false phantom)", row.verdict === "unknown", row.verdict, "unknown");
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 11 — VOID-SLIP / BILL-PRINT POS DOCS EXCLUDED FROM KOT TOTALS
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = res({ tabRounds: [{ items: [{n:"VODKA",p:400,qty:2}] }] });
  const kots = [
    kot([{n:"VODKA",p:400,qty:2}]),                          // real KOT
    kot([{n:"VODKA",p:400,qty:99}], { voidNotice: true }),   // void slip — IGNORE
    kot([{n:"BILL TOTAL",p:0,qty:1}], { kind: "bill" }),     // bill print — IGNORE
    kot([], { billNumber: "B-007" }),                        // bill print no kind  — IGNORE
  ];
  const row = computeTallyRow(r, kots);
  check("S11 void slip + bill print not counted as KOTs",
    row.verdict === "match" && row.kotCount === 1, { v: row.verdict, count: row.kotCount }, "match/1");
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 12 — TABLE REUSE (party A + party B same table tonight)
// ═══════════════════════════════════════════════════════════════════════════
{
  // Party A arrived 8pm, paid 9pm. Party B arrived 9:30pm, paid 11pm.
  // Each ordered 5 vodka. WITHOUT scoping, both parties' KOTs would be
  // dumped on whichever reservation we computed first → false ₹2000 leakage.
  // WITH scoping: time-window assigns KOTs to the right party.
  const partyA = res({
    _docId: "rA", customerName: "ALICE",
    bookedAt: new Date(baseTime).toISOString(),                       // 8pm
    arrivalTime: new Date(baseTime).toISOString(),
    paidAt: new Date(baseTime + 60 * MIN).toISOString(),              // 9pm
    tabRounds: [{ items: [{n:"VODKA",p:400,qty:5}] }],
  });
  const partyB = res({
    _docId: "rB", customerName: "BOB",
    bookedAt: new Date(baseTime + 90 * MIN).toISOString(),            // 9:30pm
    arrivalTime: new Date(baseTime + 90 * MIN).toISOString(),
    paidAt: new Date(baseTime + 180 * MIN).toISOString(),             // 11pm
    tabRounds: [{ items: [{n:"VODKA",p:400,qty:5}] }],
  });
  const kots = [
    kot([{n:"VODKA",p:400,qty:5}], { createdAt: baseTime + 30 * MIN }),    // 8:30pm → A
    kot([{n:"VODKA",p:400,qty:5}], { createdAt: baseTime + 120 * MIN }),   // 10pm → B
  ];
  const rows = buildAllTallyRows([partyA, partyB], kots);
  const a = rows.find(x => x.customerName === "ALICE")!;
  const b = rows.find(x => x.customerName === "BOB")!;
  check("S12 table reuse — party A matches (KOTs scoped)", a.verdict === "match", a.verdict, "match");
  check("S12 table reuse — party B matches (KOTs scoped)", b.verdict === "match", b.verdict, "match");
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 13 — buildAllTallyRows skips OPEN tabs and EMPTY tables
// ═══════════════════════════════════════════════════════════════════════════
{
  const open = res({ _docId: "ropen", paymentStatus: "open", paidAt: "" });
  const empty = res({ _docId: "rempty", tabRounds: [] }); // no KOTs either
  const real = res({ _docId: "rreal", tabRounds: [{ items: [{n:"X",p:100,qty:1}] }] });
  const rows = buildAllTallyRows(
    [open, empty, real],
    [ kot([{n:"X",p:100,qty:1}], { tableId: "T1" }) ]
  );
  check("S13 only the closed+active table tallied (open + empty skipped)",
    rows.length === 1 && rows[0].reservationId === "rreal",
    { len: rows.length, ids: rows.map(r=>r.reservationId) }, "1/[rreal]");
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 14 — PER-CAPTAIN LEAKAGE ROLL-UP
// ═══════════════════════════════════════════════════════════════════════════
{
  const rA = res({ _docId:"r1", tableId:"T1", captainName:"RAJESH",
    tabRounds: [{ items: [{n:"X",p:100,qty:1}] }] });
  const rB = res({ _docId:"r2", tableId:"T2", captainName:"RAJESH",
    tabRounds: [{ items: [{n:"X",p:100,qty:1}] }] });
  const rC = res({ _docId:"r3", tableId:"T3", captainName:"PRIYA",
    tabRounds: [{ items: [{n:"X",p:100,qty:5}] }] });
  const kots = [
    kot([{n:"X",p:100,qty:7}], { tableId:"T1" }),  // ₹600 leakage Rajesh table 1
    kot([{n:"X",p:100,qty:1}], { tableId:"T2" }),  // match Rajesh table 2
    kot([{n:"X",p:100,qty:5}], { tableId:"T3" }),  // match Priya
  ];
  const rows = buildAllTallyRows([rA,rB,rC], kots);
  const summary = aggregateCaptainLeakage(rows);
  const rajesh = summary.find(s => s.captain === "RAJESH")!;
  const priya = summary.find(s => s.captain === "PRIYA")!;
  check("S14 Rajesh: 1 leakage table, ₹600 total",
    rajesh.leakageTables === 1 && rajesh.totalLeakage === 600,
    { lt: rajesh.leakageTables, tl: rajesh.totalLeakage }, "1/600");
  check("S14 Priya: 0 leakage tables", priya.leakageTables === 0, priya.leakageTables, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 15 — isRealKot guard (sanity)
// ═══════════════════════════════════════════════════════════════════════════
{
  const r1 = isRealKot({ id:"k", items:[{n:"X",p:1,qty:1} as any] });
  check("S15 real KOT → true", r1 === true, r1, true);
  const r2 = isRealKot({ id:"k", items:[{} as any], voidNotice:true });
  check("S15 void slip skipped → false", r2 === false, r2, false);
  const r3 = isRealKot({ id:"k", items:[{} as any], kind:"bill" });
  check("S15 bill print skipped → false", r3 === false, r3, false);
  const r4 = isRealKot({ id:"k", items:[] });
  check("S15 empty items skipped → false", r4 === false, r4, false);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 16 — WALLET / COVER FLOW WITH NO TABLE ASSIGNED
// (regression: KAVYA's "sharanya / Sourodeep / pramath" rows showed KOTs=0
//  because reservation+KOT both had blank tableId → bucket lookup failed.
//  Fix: bucket KOTs by reservation _docId + bookingRef as fallback.)
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = res({
    _docId: "wallet-r99", tableId: "", bookingRef: "WLT-XYZ",
    tabRounds: [{ items: [{n:"VODKA SHOT",p:400,qty:2}] }],
  });
  // KOT also has blank tableId (printKOT writes whatever the reservation has)
  // but we DO write reservationId + bookingRef now → tally must find it.
  const kots = [ kot([{n:"VODKA SHOT",p:400,qty:2}], {
    tableId: "", reservationId: "wallet-r99", bookingRef: "WLT-XYZ",
  }) ];
  const rows = buildAllTallyRows([r], kots);
  check("S16 wallet/cover with no table → row exists", rows.length === 1, rows.length, 1);
  check("S16 wallet/cover → KOT matched via reservationId", rows[0]?.kotCount === 1, rows[0]?.kotCount, 1);
  check("S16 wallet/cover → verdict=match", rows[0]?.verdict === "match", rows[0]?.verdict, "match");
}
// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 17 — bookingRef-only fallback (legacy KOT with no reservationId)
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = res({
    _docId: "wallet-r100", tableId: "", bookingRef: "WLT-LEGACY",
    tabRounds: [{ items: [{n:"BEER",p:300,qty:1}] }],
  });
  const kots = [ kot([{n:"BEER",p:300,qty:1}], {
    tableId: "", reservationId: "", bookingRef: "WLT-LEGACY",
  }) ];
  const rows = buildAllTallyRows([r], kots);
  check("S17 bookingRef-only fallback → matched", rows[0]?.kotCount === 1, rows[0]?.kotCount, 1);
  check("S17 bookingRef-only fallback → verdict=match", rows[0]?.verdict === "match", rows[0]?.verdict, "match");
}
// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 18 — KOT must NOT be double-counted when both tableId AND
// reservationId match the same reservation
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = res({
    _docId: "r-dup", tableId: "T9",
    tabRounds: [{ items: [{n:"GIN",p:500,qty:1}] }],
  });
  const kots = [ kot([{n:"GIN",p:500,qty:1}], {
    tableId: "T9", reservationId: "r-dup", bookingRef: "BR-DUP",
  }) ];
  const rows = buildAllTallyRows([r], kots);
  check("S18 dual-key KOT not double-counted", rows[0]?.kotCount === 1, rows[0]?.kotCount, 1);
  check("S18 dual-key KOT → kotValue=500 (not 1000)", rows[0]?.kotValue === 500, rows[0]?.kotValue, 500);
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══════════════════════════════════════════════════════════════");
console.log("🧾 KOT-vs-BILL TALLY — FRAUD SCENARIO TEST RESULTS");
console.log("═══════════════════════════════════════════════════════════════\n");
for (const r of results) {
  const icon = r.ok ? "✅" : "❌";
  console.log(`${icon} ${r.name}`);
  if (!r.ok) {
    console.log(`     got:  ${JSON.stringify(r.got)}`);
    console.log(`     want: ${JSON.stringify(r.want)}`);
  }
}
console.log(`\n────────────────────────────────────────────────────────────────`);
console.log(`  RESULT: ${pass} passed · ${fail} failed`);
console.log(`────────────────────────────────────────────────────────────────\n`);
process.exit(fail > 0 ? 1 : 0);
