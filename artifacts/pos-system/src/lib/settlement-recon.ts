// 🧮 SETTLEMENT RECONCILIATION
//
// Matches a vendor settlement file (Pine Labs Plutus today; Razorpay POS
// once the same flow is reused) against the `edcTransactions` Firestore
// collection for a given operational night.
//
// Why: the accountant currently does this by hand at month-end. Pine Labs
// and Razorpay both expose daily settlement CSVs that can be auto-matched
// by RRN / approval code, surfacing missed webhooks and short-settled
// charges the next morning instead of weeks later.
//
// The parser is intentionally lenient — vendor CSV headers drift between
// dashboard exports vs. API exports vs. partner-bank statements. We
// normalise headers (lowercase, strip non-alphanumerics) and accept any
// of a few well-known synonyms per field. Anything we can't parse is
// surfaced as an `unparsed` row so the accountant can still see it.

export type SettlementVendor = "pinelabs" | "razorpay";

/** A single parsed line from the vendor settlement file. */
export interface SettlementRow {
  /** Best-available reference for matching: RRN > ApprovalCode > PaymentId. */
  ref: string;
  /** Amount in INR (rupees, not paise). 0 if missing/unparseable. */
  amount: number;
  /** ISO-ish settlement / txn timestamp string from the file (display only). */
  when: string;
  /** Last 4 of the card if present (display + tie-breaker on duplicate RRNs). */
  last4: string;
  /** Raw row as parsed (for the diagnostic table). */
  raw: Record<string, string>;
}

/** Shape of an `edcTransactions` doc — we only depend on a few fields. */
export interface EdcTxnLike {
  id: string;
  vendor?: string;
  status?: string;
  amount?: number;
  pineLabsRef?: string;
  razorpayPaymentId?: string;
  edcRef?: string;
  last4?: string;
  bookingRef?: string;
  coverRef?: string;
  bouncerName?: string;
  createdAt?: string;
}

export type IssueKind =
  /** In settlement file but no matching success txn in Firestore. */
  | "settled_not_in_firestore"
  /** Marked success in Firestore but absent from settlement file. */
  | "in_firestore_not_settled"
  /** Both sides matched on ref but the amount differs by ≥ ₹1. */
  | "amount_mismatch";

export interface ReconIssue {
  kind: IssueKind;
  ref: string;
  /** Amount as the vendor reports it (settlement side). */
  settlementAmount: number;
  /** Amount as Firestore knows it (txn side). */
  firestoreAmount: number;
  /** The settlement row, when present. */
  settlement?: SettlementRow;
  /** The Firestore txn, when present. */
  txn?: EdcTxnLike;
  /** Human-readable one-liner for the row. */
  detail: string;
}

export interface ReconResult {
  vendor: SettlementVendor;
  /** Parsed settlement rows (everything we could read out of the file). */
  settlementRows: SettlementRow[];
  /** Lines we couldn't parse a `ref` from — surfaced raw for the accountant. */
  unparsed: Array<Record<string, string>>;
  /** Successful matches with no amount drift. */
  matched: Array<{ ref: string; amount: number; settlement: SettlementRow; txn: EdcTxnLike }>;
  /** Everything that needs a human look. */
  issues: ReconIssue[];
  /** Summary tallies for the header tiles. */
  totals: {
    settlementCount: number;
    settlementAmount: number;
    matchedCount: number;
    matchedAmount: number;
    issueCount: number;
  };
}

// ── CSV parsing ──────────────────────────────────────────────────────────

/** Tiny RFC-4180-ish CSV parser. Handles quoted cells, "" escapes, CRLF. */
export function parseCsv(text: string): string[][] {
  // Strip UTF-8 BOM if present (Excel exports add one).
  const src = text.replace(/^\uFEFF/, "");
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else { inQuotes = false; }
      } else { cell += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\r") { /* skip — handled by \n */ }
      else if (ch === "\n") { row.push(cell); out.push(row); row = []; cell = ""; }
      else { cell += ch; }
    }
  }
  // Trailing line without newline.
  if (cell.length > 0 || row.length > 0) { row.push(cell); out.push(row); }
  // Drop fully-empty trailing rows.
  while (out.length > 0 && out[out.length - 1].every(c => c.trim() === "")) out.pop();
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Header synonyms — case-insensitive, punctuation-insensitive. */
const HEADER_SYNONYMS: Record<keyof Omit<SettlementRow, "raw">, string[]> = {
  ref:    ["rrn", "retrievalreferencenumber", "approvalcode", "authcode", "auth", "paymentid", "rzppaymentid", "razorpaypaymentid", "transactionid", "txnid", "plutustransactionreferenceid"],
  amount: ["amount", "txnamount", "transactionamount", "settlementamount", "netamount", "amountinr"],
  when:   ["txndatetime", "transactiondate", "txndate", "settlementdate", "settledat", "createdat", "date"],
  last4:  ["last4", "cardlast4", "maskedcardno", "maskedcardnumber", "cardnumber", "pan"],
};

function pickHeaderIndex(headers: string[], candidates: string[]): number {
  const normed = headers.map(norm);
  for (const c of candidates) {
    const i = normed.indexOf(c);
    if (i !== -1) return i;
  }
  // Fallback: contains-match (e.g. "Settlement Amount (INR)" contains "amount").
  for (const c of candidates) {
    const i = normed.findIndex(h => h.includes(c));
    if (i !== -1) return i;
  }
  return -1;
}

/** Parse a vendor settlement CSV into structured rows. */
export function parseSettlementCsv(text: string): { rows: SettlementRow[]; unparsed: Array<Record<string, string>> } {
  const grid = parseCsv(text);
  if (grid.length < 2) return { rows: [], unparsed: [] };
  const headers = grid[0];
  const idx = {
    ref:    pickHeaderIndex(headers, HEADER_SYNONYMS.ref),
    amount: pickHeaderIndex(headers, HEADER_SYNONYMS.amount),
    when:   pickHeaderIndex(headers, HEADER_SYNONYMS.when),
    last4:  pickHeaderIndex(headers, HEADER_SYNONYMS.last4),
  };
  const rows: SettlementRow[] = [];
  const unparsed: Array<Record<string, string>> = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    const raw: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) raw[headers[c] || `col_${c}`] = cells[c] ?? "";
    const refRaw = idx.ref >= 0 ? (cells[idx.ref] ?? "").trim() : "";
    const amtRaw = idx.amount >= 0 ? (cells[idx.amount] ?? "").trim() : "";
    const whenRaw = idx.when >= 0 ? (cells[idx.when] ?? "").trim() : "";
    const last4Raw = idx.last4 >= 0 ? (cells[idx.last4] ?? "").trim() : "";
    if (!refRaw) { unparsed.push(raw); continue; }
    // Razorpay reports paise in some exports; if header literally says "paise" treat as paise.
    const amountIsPaise = idx.amount >= 0 && /paise/i.test(headers[idx.amount] || "");
    const amountNum = Number(amtRaw.replace(/[^\d.\-]/g, ""));
    const amount = !isFinite(amountNum) ? 0 : amountIsPaise ? amountNum / 100 : amountNum;
    const last4 = (last4Raw.match(/\d{4}\s*$/) || [""])[0].trim();
    rows.push({ ref: refRaw, amount, when: whenRaw, last4, raw });
  }
  return { rows, unparsed };
}

// ── Reconciliation ───────────────────────────────────────────────────────

/** Collect every ref a Firestore txn might be matched on (lowercased). */
function txnRefs(t: EdcTxnLike): string[] {
  const out: string[] = [];
  for (const v of [t.pineLabsRef, t.razorpayPaymentId, t.edcRef]) {
    const s = (v || "").trim().toLowerCase();
    if (s) out.push(s);
  }
  return out;
}

export interface ReconcileInput {
  vendor: SettlementVendor;
  settlement: SettlementRow[];
  /** All `edcTransactions` for the night (any vendor, any status). */
  txns: EdcTxnLike[];
  /** Lines from the settlement file that the parser couldn't extract a ref
   *  from. Passed through into `ReconResult.unparsed` so the UI can surface
   *  them in one shot without the caller mutating the result post-hoc. */
  unparsed?: Array<Record<string, string>>;
  /** Tolerance in ₹ — Pine Labs MDR sometimes rounds the slip by ₹1.
   *  Set to 0 if the accountant wants strict equality. */
  amountToleranceRupees?: number;
}

export function reconcile({ vendor, settlement, txns, unparsed = [], amountToleranceRupees = 1 }: ReconcileInput): ReconResult {
  // Only consider txns for THIS vendor — Pine Labs settlement won't list
  // Razorpay charges and vice versa.
  const vendorTxns = txns.filter(t => (t.vendor || "").toLowerCase() === vendor);

  // Build ref → txn index. Same RRN can in theory map to multiple attempts
  // (retry with same slip number) — keep them all so we can prefer the
  // success record if one exists.
  const refIndex = new Map<string, EdcTxnLike[]>();
  for (const t of vendorTxns) {
    for (const r of txnRefs(t)) {
      const list = refIndex.get(r) || [];
      list.push(t);
      refIndex.set(r, list);
    }
  }

  const matched: ReconResult["matched"] = [];
  const issues: ReconIssue[] = [];
  const matchedTxnIds = new Set<string>();

  // Pass 1 — every settlement row: matched / amount-mismatch / settled-not-in-firestore.
  // Settlement semantics: a vendor only settles money it actually captured,
  // so a settlement row should match a Firestore txn with `status === "success"`.
  // Any non-success txn sharing the ref (e.g. our row stuck in `pending` because
  // we never received the webhook, or already marked `failed`) is itself the
  // anomaly the accountant needs to see.
  for (const s of settlement) {
    const key = s.ref.toLowerCase();
    const list = refIndex.get(key) || [];
    const t = list.find(x => x.status === "success");
    if (!t) {
      // Either no Firestore txn at all, or one exists but isn't `success`.
      const stale = list[0];
      issues.push({
        kind: "settled_not_in_firestore",
        ref: s.ref,
        settlementAmount: s.amount,
        firestoreAmount: stale ? Number(stale.amount || 0) : 0,
        settlement: s,
        txn: stale,
        detail: stale
          ? `Vendor settled ₹${s.amount.toLocaleString()} on ref ${s.ref} but Firestore txn is "${stale.status || "unknown"}", not success — webhook likely failed to mark it captured.`
          : `Vendor settled ₹${s.amount.toLocaleString()} on ref ${s.ref} but no ${vendor} txn found in Firestore (likely a missed webhook).`,
      });
      if (stale) matchedTxnIds.add(stale.id);
      continue;
    }
    matchedTxnIds.add(t.id);
    const txnAmt = Number(t.amount || 0);
    const drift = Math.abs(txnAmt - s.amount);
    if (drift > amountToleranceRupees) {
      issues.push({
        kind: "amount_mismatch",
        ref: s.ref,
        settlementAmount: s.amount,
        firestoreAmount: txnAmt,
        settlement: s,
        txn: t,
        detail: `Amount drift on ref ${s.ref}: vendor settled ₹${s.amount.toLocaleString()}, Firestore says ₹${txnAmt.toLocaleString()} (Δ ₹${drift.toLocaleString()}).`,
      });
    } else {
      matched.push({ ref: s.ref, amount: s.amount, settlement: s, txn: t });
    }
  }

  // Pass 2 — Firestore "success" txns the vendor never settled.
  for (const t of vendorTxns) {
    if (t.status !== "success") continue;
    if (matchedTxnIds.has(t.id)) continue;
    const refs = txnRefs(t);
    const ref = refs[0] || t.id;
    issues.push({
      kind: "in_firestore_not_settled",
      ref,
      settlementAmount: 0,
      firestoreAmount: Number(t.amount || 0),
      txn: t,
      detail: `Firestore marks ₹${Number(t.amount || 0).toLocaleString()} success on ref ${ref} but ${vendor} hasn't settled it (short-settled or still in T+1 window).`,
    });
  }

  const settlementAmount = settlement.reduce((s, r) => s + r.amount, 0);
  const matchedAmount = matched.reduce((s, m) => s + m.amount, 0);

  return {
    vendor,
    settlementRows: settlement,
    unparsed,
    matched,
    issues,
    totals: {
      settlementCount: settlement.length,
      settlementAmount,
      matchedCount: matched.length,
      matchedAmount,
      issueCount: issues.length,
    },
  };
}
