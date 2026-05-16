// ════════════════════════════════════════════════════════
// HOD — Google Sheets archive + audience tabs (v2 — 2026-05-08)
// ────────────────────────────────────────────────────────
// Runs daily at 06:00 IST. Two distinct flows:
//
//  A. ARCHIVE & DELETE (storage cleanup, unchanged)
//     Pulls tableReservations + covers older than 14 days,
//     pushes to Aggregators / Walk-ins / Events / Wallets /
//     Anti-Fraud Log / Customer Master, then deletes.
//
//  B. CONTACT SYNC (NEW — append-only, NEVER deletes)
//     Pulls NEW bookings + guestlist docs (since last cursor),
//     appends to Online Bookings / Entry-Only Bookings /
//     Guestlist Contacts tabs + Customer Master, advances cursor.
//     Cursor stored in Firestore: _meta/sheetsSync.
//
//  C. AUDIENCE TABS (NEW — auto-computed via Sheet QUERY formulas)
//     Regular Customers — phones in Customer Master with ≥2 visits
//     VVIP Customers    — phones with lifetime spend ≥ ₹15,000
//     Set up once on first run; auto-update as Customer Master grows.
//
// Sheet structure (auto-created on first run):
//   • Aggregators       — Zomato/Swiggy/EazyDiner/District tables
//   • Walk-ins          — in-house source tables
//   • Events            — wallet/cover docs that have an eventTitle
//   • Wallets           — all wallet/cover docs
//   • Anti-Fraud Log    — discount overrides + source swaps + KOT voids
//   • Customer Master   — UNIFIED contact log (all sources, all sheets feed here)
//   • Online Bookings   — NEW: paid customer-site bookings (ticketed events)
//   • Entry-Only Bookings — NEW: entry-only paid bookings
//   • Guestlist Contacts — NEW: free guestlist signups (incl. door FREE ENTRY)
//   • Regular Customers — NEW (formula): ≥2 visits across any source
//   • VVIP Customers    — NEW (formula): ≥₹15,000 lifetime spend
//
// Required env vars (firebase functions:secrets:set <NAME>):
//   • SHEETS_CLIENT_ID       (can reuse GMAIL_CLIENT_ID)
//   • SHEETS_CLIENT_SECRET   (can reuse GMAIL_CLIENT_SECRET)
//   • SHEETS_REFRESH_TOKEN   (must be obtained with sheets scope)
//   • HOD_SHEET_ID           (the spreadsheetId from the Sheet URL)
// ════════════════════════════════════════════════════════
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { google } = require('googleapis');

const REGION = 'asia-south1';
const RETENTION_DAYS = 14;
const VVIP_THRESHOLD = 15000;       // ₹ lifetime spend
const REGULAR_MIN_VISITS = 2;
const META_DOC = '_meta/sheetsSync'; // cursor doc

// ── Auth ─────────────────────────────────────────────────
function getSheetsClient() {
  const clientId = process.env.SHEETS_CLIENT_ID || process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.SHEETS_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.SHEETS_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Sheets credentials missing. Set SHEETS_CLIENT_ID, SHEETS_CLIENT_SECRET, SHEETS_REFRESH_TOKEN.');
  }
  const oAuth2 = new google.auth.OAuth2(clientId, clientSecret);
  oAuth2.setCredentials({ refresh_token: refreshToken });
  return google.sheets({ version: 'v4', auth: oAuth2 });
}

function sheetId() {
  const id = process.env.HOD_SHEET_ID;
  if (!id) throw new Error('HOD_SHEET_ID not set.');
  return id;
}

// ── Tab management ──────────────────────────────────────
// `seedFormula` (optional) — written to A2 on first creation only. Used for
// Regular Customers / VVIP Customers tabs which are populated by QUERY formulas
// over Customer Master and re-evaluate every time the sheet opens.
async function ensureTab(sheets, tabName, headers, seedFormula) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId() });
  const exists = (meta.data.sheets || []).some(s => s.properties && s.properties.title === tabName);
  if (exists) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId(),
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] }
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId(),
    range: `${tabName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers] }
  });
  if (seedFormula) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId(),
      range: `${tabName}!A2`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[seedFormula]] }
    });
  }
}

async function appendRows(sheets, tabName, headers, rows, seedFormula) {
  if (!rows.length) return;
  await ensureTab(sheets, tabName, headers, seedFormula);
  const values = rows.map(r => headers.map(h => r[h] == null ? '' : String(r[h])));
  const CHUNK = 1000;
  for (let i = 0; i < values.length; i += CHUNK) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId(),
      range: `${tabName}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: values.slice(i, i + CHUNK) }
    });
  }
}

// ── Schemas (header order = column order in Sheet) ──────
const AGG_HEADERS = [
  'archivedAt','date','source','customerName','phone','email','partySize','arrivalTime','captain',
  'tableId','floor','subtotal','defaultDiscountPct','actualDiscountPct','discountAmt','tax','total',
  'amountPaid','paymentStatus','paymentMethod','aggregatorPaid','aggregatorVariance',
  'billPrintCount','overrideCount','sourceSwapCount','voidCount','voidValueLost','flags','docId'
];
const WALKIN_HEADERS = AGG_HEADERS;
const EVENT_HEADERS = [
  'archivedAt','date','eventTitle','source','customerName','phone','email','agent',
  'activatedAt','checkedIn','coverActivated','recharged','redeemed','balance','paymentMethod','docId'
];
const WALLET_HEADERS = EVENT_HEADERS;
const FRAUD_HEADERS = [
  'archivedAt','at','kind','tableId','staff','manager','amount','from','to',
  'fromDiscount','toDiscount','reason','docId'
];
// Customer Master = SOURCE OF TRUTH for Regulars/VVIP formulas.
// Column order is locked — do not reorder without updating the QUERY formulas
// in REGULARS_FORMULA / VVIP_FORMULA below.
//   A=archivedAt  B=phone  C=name  D=email  E=source  F=date  G=spend  H=docId
const CUSTOMER_HEADERS = [
  'archivedAt','phone','name','email','source','date','spend','docId'
];

// NEW contact-tab schemas — minimal, focused on promo targeting (name/phone/email)
const ONLINE_BOOKING_HEADERS = [
  'archivedAt','bookedAt','name','phone','email','eventTitle','eventDate',
  'ticketType','qty','total','paymentId','status','docId'
];
const ENTRY_ONLY_HEADERS = ONLINE_BOOKING_HEADERS;
// Live contact-tab for tableReservations — captured IMMEDIATELY on every run
// (not waiting 14 days for archive). Ensures VVIP/Regulars formulas reflect
// table-booking customers within 24 hours.
const TABLE_BOOKING_HEADERS = [
  'archivedAt','date','arrivalTime','name','phone','email','source','partySize',
  'tableId','floor','captain','total','paymentStatus','docId'
];
const GUESTLIST_HEADERS = [
  'archivedAt','joinedAt','name','phone','email','type','eventTitle','eventDate',
  'checkedIn','source','docId'
];
const REGULARS_HEADERS = ['phone','name','email','visits','totalSpend','lastSeen'];
const VVIP_HEADERS = ['phone','name','email','totalSpend','visits','lastSeen'];

// QUERY formulas — auto-recompute whenever Customer Master grows.
// Group by PHONE ONLY (column B). Name/email vary across visits (typo, casing,
// blank email on walk-in, etc), so grouping by B,C,D would split the same
// customer into multiple buckets and undercount visits/spend. Use max() to
// pick the most recent non-empty representative name/email.
const REGULARS_FORMULA =
  `=IFERROR(QUERY('Customer Master'!A2:H, ` +
  `"select B, max(C), max(D), count(B), sum(G), max(F) ` +
  `where B is not null and B <> '' ` +
  `group by B ` +
  `having count(B) >= ${REGULAR_MIN_VISITS} ` +
  `order by count(B) desc ` +
  `label B 'Phone', max(C) 'Name', max(D) 'Email', count(B) 'Visits', sum(G) 'Total Spend', max(F) 'Last Seen'", 0), "no data yet")`;

const VVIP_FORMULA =
  `=IFERROR(QUERY('Customer Master'!A2:H, ` +
  `"select B, max(C), max(D), sum(G), count(B), max(F) ` +
  `where B is not null and B <> '' ` +
  `group by B ` +
  `having sum(G) >= ${VVIP_THRESHOLD} ` +
  `order by sum(G) desc ` +
  `label B 'Phone', max(C) 'Name', max(D) 'Email', sum(G) 'Total Spend', count(B) 'Visits', max(F) 'Last Seen'", 0), "no data yet")`;

// ── Mappers ─────────────────────────────────────────────
const nowIso = () => new Date().toISOString();
const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
const last10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);

function mapReservationRow(r, docId, archivedAt) {
  return {
    archivedAt, docId,
    date: r.date || '',
    source: r.source || (r.aggregator || 'inhouse'),
    customerName: r.customerName || '',
    phone: r.phone || '',
    email: r.email || '',
    partySize: r.partySize || 0,
    arrivalTime: r.arrivalTime || '',
    captain: r.captainName || r.captainId || '',
    tableId: r.tableId || '',
    floor: r.floorLabel || r.floor || '',
    subtotal: num(r.subtotal),
    defaultDiscountPct: num(r.defaultDiscountPct),
    actualDiscountPct: num(r.aggregatorDiscount || r.customDiscount || r.discountPct),
    discountAmt: num(r.discountAmount),
    tax: num(r.taxAmount),
    total: num(r.tabTotal || r.total),
    amountPaid: num(r.amountPaid),
    paymentStatus: r.paymentStatus || '',
    paymentMethod: r.paymentMethod || '',
    aggregatorPaid: num(r.aggregatorPaidAmount),
    aggregatorVariance: r.aggregatorPaidAmount != null
      ? num(r.aggregatorPaidAmount) - num(r.tabTotal || r.total) : '',
    billPrintCount: num(r.billPrintCount),
    overrideCount: (r.discountOverrideLog || []).length,
    sourceSwapCount: (r.sourceOverrideLog || []).length,
    voidCount: (r.voidLog || []).length,
    voidValueLost: (r.voidLog || []).reduce((s, v) => s + num(v.valueLost), 0),
    flags: [
      r.needsManualReview && 'needs-review',
      r.billStale && 'bill-stale',
      r.isDuplicate && 'duplicate-bill'
    ].filter(Boolean).join('|')
  };
}

function mapCoverRow(c, docId, archivedAt) {
  return {
    archivedAt, docId,
    date: c.date || '',
    eventTitle: c.eventTitle || '',
    source: c.source || (c.isAggregator ? 'aggregator' : 'walk-in'),
    customerName: c.name || '',
    phone: c.phone || '',
    email: c.email || '',
    agent: c.activatedBy || '',
    activatedAt: c.activatedAt || c.createdAt || '',
    checkedIn: c.checkedIn ? 'yes' : '',
    coverActivated: num(c.coverActivated),
    recharged: num(c.coverRecharged),
    redeemed: num(c.coverUsed),
    balance: num(c.coverBalance),
    paymentMethod: c.paymentMethod || ''
  };
}

function extractFraudEntries(r, docId, archivedAt) {
  const out = [];
  (r.discountOverrideLog || []).forEach(e => out.push({
    archivedAt, docId, at: e.at || '', kind: e.kind || 'discount-override',
    tableId: r.tableId || '', staff: e.staff || '', manager: e.managerName || '',
    amount: num(e.amount), from: e.from || '', to: e.to || '',
    fromDiscount: num(e.fromDiscount), toDiscount: num(e.toDiscount),
    reason: e.reason || ''
  }));
  (r.sourceOverrideLog || []).forEach(e => out.push({
    archivedAt, docId, at: e.at || '', kind: 'source-swap',
    tableId: r.tableId || '', staff: e.staff || '', manager: e.managerName || '',
    amount: '', from: e.from || '', to: e.to || '',
    fromDiscount: num(e.fromDiscount), toDiscount: num(e.toDiscount),
    reason: e.reason || ''
  }));
  (r.voidLog || []).forEach(e => out.push({
    archivedAt, docId, at: e.at || '', kind: 'kot-void',
    tableId: r.tableId || '', staff: e.staff || '', manager: e.managerName || '',
    amount: num(e.valueLost), from: '', to: '',
    fromDiscount: '', toDiscount: '',
    reason: e.reason || ''
  }));
  return out;
}

// NEW: bookings → split by entryType.
// `entryType` shape (from hodclub.in customer site):
//   'entry_only'         → Entry-Only Bookings tab
//   'guestlist_male' / 'guestlist_female' / 'guestlist_couple' → Guestlist
//   anything else (table/cover/event ticket) → Online Bookings
function bookingTab(b) {
  const t = String(b.entryType || '').toLowerCase();
  if (t === 'entry_only' || t === 'entry-only' || t === 'entryonly') return 'entry';
  if (t.startsWith('guestlist')) return 'guestlist';
  return 'online';
}

function mapBookingRow(b, docId, archivedAt, eventTitle, eventDate) {
  return {
    archivedAt, docId,
    bookedAt: b.bookedAt || '',
    name: b.name || '',
    phone: b.phone || '',
    email: b.email || '',
    eventTitle: eventTitle || b.eventTitle || '',
    eventDate: eventDate || b.date || '',
    ticketType: b.entryType || b.bookMode || '',
    qty: num(b.qty),
    total: num(b.total),
    paymentId: b.paymentId || '',
    status: b.status || ''
  };
}

function mapGuestlistRow(g, docId, archivedAt, eventTitle, eventDate) {
  return {
    archivedAt, docId,
    joinedAt: g.joinedAt || '',
    name: g.name || '',
    phone: g.phone || '',
    email: g.email || '',
    type: g.type || '',
    eventTitle: eventTitle || '',
    eventDate: eventDate || '',
    checkedIn: g.checkedIn ? 'yes' : '',
    // distinguishes door-side FREE ENTRY (source='door_free_entry') from
    // customer-site signups (no source field set by customer site)
    source: g.source || 'customer_site'
  };
}

// Customer Master row builder — single source of truth shape
function customerRow({ archivedAt, phone, name, email, source, date, spend, docId }) {
  return {
    archivedAt,
    phone: last10(phone),
    name: name || '',
    email: email || '',
    source: source || '',
    date: date || '',
    spend: num(spend),
    docId
  };
}

// ── Cursor management (for incremental contact sync) ────
// Tie-handling: cursor stores both the high-watermark timestamp AND the set of
// docIds at exactly that timestamp. Next run queries with `>=` (not `>`) and
// filters out the stored tie-ids in app code. This closes two race windows:
//   1. Records written at exactly the saved cursor would be skipped by `>`.
//   2. Multiple records sharing the same timestamp could be split across runs.
async function readCursor(db) {
  const ref = db.doc(META_DOC);
  const snap = await ref.get();
  const d = snap.exists ? snap.data() : {};
  return {
    lastBookingsCursor:    d.lastBookingsCursor    || '1970-01-01T00:00:00.000Z',
    lastBookingsTieIds:    Array.isArray(d.lastBookingsTieIds)    ? d.lastBookingsTieIds    : [],
    lastGuestlistCursor:   d.lastGuestlistCursor   || '1970-01-01T00:00:00.000Z',
    lastGuestlistTieIds:   Array.isArray(d.lastGuestlistTieIds)   ? d.lastGuestlistTieIds   : [],
    lastTableResCursor:    d.lastTableResCursor    || '1970-01-01T00:00:00.000Z',
    lastTableResTieIds:    Array.isArray(d.lastTableResTieIds)    ? d.lastTableResTieIds    : [],
    lastCoversCursor:      d.lastCoversCursor      || '1970-01-01T00:00:00.000Z',
    lastCoversTieIds:      Array.isArray(d.lastCoversTieIds)      ? d.lastCoversTieIds      : []
  };
}
async function writeCursor(db, cursor) {
  await db.doc(META_DOC).set(cursor, { merge: true });
}

// ── Run lock (prevents overlapping daily + manual triggers) ─
// Acquires `_meta/sheetsSyncLock` via Firestore transaction. Stale locks
// older than 15 min are auto-released (in case a previous run crashed).
const LOCK_DOC = '_meta/sheetsSyncLock';
const LOCK_TTL_MS = 15 * 60 * 1000;
async function acquireLock(db) {
  const ref = db.doc(LOCK_DOC);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const acquiredAt = snap.data().acquiredAt;
      const ageMs = Date.now() - new Date(acquiredAt).getTime();
      if (ageMs < LOCK_TTL_MS) {
        throw new Error(`sheetsSync already running (lock acquired ${Math.round(ageMs/1000)}s ago)`);
      }
      // stale — overwrite
    }
    tx.set(ref, { acquiredAt: nowIso(), pid: process.pid });
    return true;
  });
}
async function releaseLock(db) {
  try { await db.doc(LOCK_DOC).delete(); } catch (_) { /* best effort */ }
}

// ── Core: A. archive & delete (storage cleanup, unchanged) ─
function cutoffStr() {
  const d = new Date();
  d.setDate(d.getDate() - RETENTION_DAYS);
  return d.toISOString().split('T')[0];
}

async function batchDelete(db, docs) {
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
}

async function archiveOldReservationsAndCovers(db, sheets, archivedAt, dryRun) {
  const cutoff = cutoffStr();

  const resSnap = await db.collection('tableReservations').where('date', '<', cutoff).get();
  const aggregators = [], walkins = [], fraud = [];

  resSnap.docs.forEach(d => {
    const r = d.data();
    const row = mapReservationRow(r, d.id, archivedAt);
    const isAgg = r.source && r.source !== 'inhouse' && r.source !== 'walk-in';
    if (isAgg) aggregators.push(row); else walkins.push(row);
    fraud.push(...extractFraudEntries(r, d.id, archivedAt));
    // NOTE: Customer Master push intentionally REMOVED here. Live sync
    // (syncBookingsAndGuestlist → tableReservations branch) already captured
    // this customer days/weeks before archive cutoff. Re-pushing would
    // double-count visits in Regulars formula and double-sum in VVIP formula.
  });

  const coversSnap = await db.collection('covers').where('date', '<', cutoff).get();
  const wallets = [], events = [];
  coversSnap.docs.forEach(d => {
    const c = d.data();
    if (c.isTableBooking) return;
    const row = mapCoverRow(c, d.id, archivedAt);
    wallets.push(row);
    if (c.eventTitle) events.push(row);
    // Customer Master push REMOVED (same reason as above — covers are
    // live-synced via syncBookingsAndGuestlist → covers branch).
  });

  if (dryRun) return { aggregators, walkins, events, wallets, fraud, resSnap, coversSnap };

  await appendRows(sheets, 'Aggregators',     AGG_HEADERS,      aggregators);
  await appendRows(sheets, 'Walk-ins',        WALKIN_HEADERS,   walkins);
  await appendRows(sheets, 'Events',          EVENT_HEADERS,    events);
  await appendRows(sheets, 'Wallets',         WALLET_HEADERS,   wallets);
  await appendRows(sheets, 'Anti-Fraud Log',  FRAUD_HEADERS,    fraud);
  // Customer Master no longer appended here (live sync handles it).

  await batchDelete(db, resSnap.docs);
  await batchDelete(db, coversSnap.docs);

  return { archived: {
    aggregators: aggregators.length, walkins: walkins.length,
    events: events.length, wallets: wallets.length,
    fraud: fraud.length,
    deleted: resSnap.size + coversSnap.size
  }};
}

// ── Core: B. contact sync (incremental, no delete) ──────
async function syncBookingsAndGuestlist(db, sheets, archivedAt, dryRun) {
  const cursor = await readCursor(db);

  // Pre-fetch event titles/dates so we can decorate booking + guestlist rows
  const eventsSnap = await db.collection('events').get();
  const eventsById = {};
  eventsSnap.docs.forEach(d => { eventsById[d.id] = d.data(); });
  const evTitle = (id) => (eventsById[id] && (eventsById[id].title || eventsById[id].name)) || '';
  const evDate  = (id) => (eventsById[id] && eventsById[id].date) || '';

  // ── Bookings (incremental: `>=` cursor + dedupe via tie-ids)
  const bSnap = await db.collection('bookings')
    .where('bookedAt', '>=', cursor.lastBookingsCursor)
    .get();

  const onlineRows = [], entryRows = [], guestlistFromBookings = [], customerRowsB = [];
  let maxBookedAt = cursor.lastBookingsCursor;
  let bookingTieIdsAtMax = new Set(cursor.lastBookingsTieIds);
  const seenBookings = new Set(cursor.lastBookingsTieIds); // dedupe against last run

  bSnap.docs.forEach(d => {
    if (seenBookings.has(d.id)) return; // already exported in a prior run
    const b = d.data();
    if (b.bookedAt) {
      if (b.bookedAt > maxBookedAt) {
        maxBookedAt = b.bookedAt;
        bookingTieIdsAtMax = new Set([d.id]);
      } else if (b.bookedAt === maxBookedAt) {
        bookingTieIdsAtMax.add(d.id);
      }
    }
    const tab = bookingTab(b);
    const row = mapBookingRow(b, d.id, archivedAt, evTitle(b.eventId), evDate(b.eventId));
    if (tab === 'entry') entryRows.push(row);
    else if (tab === 'guestlist') {
      // booking-side guestlist write (dual-write from saveBooking) — adapt to
      // guestlist row shape so it shows up in Guestlist Contacts tab too
      guestlistFromBookings.push(mapGuestlistRow({
        joinedAt: b.bookedAt, name: b.name, phone: b.phone, email: b.email,
        type: (b.entryType || '').replace(/^guestlist_/, '') || 'couple',
        checkedIn: false, source: 'customer_site_booking_dualwrite'
      }, d.id, archivedAt, evTitle(b.eventId), evDate(b.eventId)));
    } else onlineRows.push(row);

    if (last10(b.phone)) customerRowsB.push(customerRow({
      archivedAt, phone: b.phone, name: b.name, email: b.email,
      source: tab === 'entry' ? 'entry_only' : (tab === 'guestlist' ? 'guestlist' : 'online_booking'),
      date: (b.bookedAt || '').split('T')[0],
      spend: b.total, docId: d.id
    }));
  });

  // ── Guestlist (incremental: `>=` cursor + dedupe via tie-ids; includes door FREE ENTRY)
  const gSnap = await db.collection('guestlist')
    .where('joinedAt', '>=', cursor.lastGuestlistCursor)
    .get();

  const guestlistRows = [], customerRowsG = [];
  let maxJoinedAt = cursor.lastGuestlistCursor;
  let glTieIdsAtMax = new Set(cursor.lastGuestlistTieIds);
  const seenGl = new Set(cursor.lastGuestlistTieIds);

  gSnap.docs.forEach(d => {
    if (seenGl.has(d.id)) return;
    const g = d.data();
    if (g.joinedAt) {
      if (g.joinedAt > maxJoinedAt) {
        maxJoinedAt = g.joinedAt;
        glTieIdsAtMax = new Set([d.id]);
      } else if (g.joinedAt === maxJoinedAt) {
        glTieIdsAtMax.add(d.id);
      }
    }
    // skip if this guestlist doc is a dual-write of a booking we already
    // captured via bookings cursor (avoids double-counting in Customer Master)
    if (g._bookingDualWrite) return;
    guestlistRows.push(mapGuestlistRow(g, d.id, archivedAt, evTitle(g.eventId), evDate(g.eventId)));
    if (last10(g.phone)) customerRowsG.push(customerRow({
      archivedAt, phone: g.phone, name: g.name, email: g.email,
      source: g.source === 'door_free_entry' ? 'door_free_entry' : 'guestlist',
      date: (g.joinedAt || '').split('T')[0],
      spend: 0, docId: d.id
    }));
  });

  // ── Table Reservations LIVE SYNC (Khushi 2026-05-08: "no matter what")
  // Cursor uses `bookedAt` (ISO timestamp set on every write — see
  // setManualAggregatorReservation in firestore-hod.ts). Write-monotonic, so
  // a far-future `date` (e.g. NYE pre-bookings) cannot poison the cursor.
  // Fallback for legacy/customer-site docs missing bookedAt:
  // `date + 'T12:00:00.000Z'` — synthetic but stable so cursor still advances.
  const trSnap = await db.collection('tableReservations')
    .where('bookedAt', '>=', cursor.lastTableResCursor)
    .get();
  // Belt & braces: also pull legacy docs lacking bookedAt that were created
  // before this v3 sync deployed. Safe because tieIds dedupe the overlap.
  const trLegacySnap = cursor.lastTableResCursor === '1970-01-01T00:00:00.000Z'
    ? await db.collection('tableReservations').get()
    : { docs: [] };
  const trDocs = [...trSnap.docs, ...trLegacySnap.docs];
  const trSeenIds = new Set(); // dedupe the union of the two snapshots

  const tableRows = [], customerRowsT = [];
  let maxTableTs = cursor.lastTableResCursor;
  let trTieIdsAtMax = new Set(cursor.lastTableResTieIds);
  const seenTr = new Set(cursor.lastTableResTieIds);

  trDocs.forEach(d => {
    if (trSeenIds.has(d.id)) return;
    trSeenIds.add(d.id);
    if (seenTr.has(d.id)) return;
    const r = d.data();
    const ts = r.bookedAt || (r.date ? `${r.date}T12:00:00.000Z` : null);
    if (ts) {
      if (ts > maxTableTs) {
        maxTableTs = ts;
        trTieIdsAtMax = new Set([d.id]);
      } else if (ts === maxTableTs) {
        trTieIdsAtMax.add(d.id);
      }
    }
    const src = r.source || (r.aggregator || 'in-house');
    tableRows.push({
      archivedAt, docId: d.id,
      date: r.date || '', arrivalTime: r.arrivalTime || '',
      name: r.customerName || '', phone: r.phone || '', email: r.email || '',
      source: src,
      partySize: r.partySize || 0,
      tableId: r.tableId || '', floor: r.floorLabel || r.floor || '',
      captain: r.captainName || r.captainId || '',
      total: num(r.tabTotal || r.total),
      paymentStatus: r.paymentStatus || ''
    });
    if (last10(r.phone)) customerRowsT.push(customerRow({
      archivedAt, phone: r.phone, name: r.customerName, email: r.email,
      source: src, date: r.date || '',
      spend: r.tabTotal || r.total, docId: d.id
    }));
  });

  // ── Covers LIVE SYNC (walk-in covers, event wallets) — same pattern
  // Cursor on `activatedAt` (ISO timestamp set in 3 cover-creation paths in
  // firestore-hod.ts: walk-in, aggregator-arrival, ensureZeroBalanceCoverForGuest).
  const cvSnap = await db.collection('covers')
    .where('activatedAt', '>=', cursor.lastCoversCursor)
    .get();
  const cvLegacySnap = cursor.lastCoversCursor === '1970-01-01T00:00:00.000Z'
    ? await db.collection('covers').get()
    : { docs: [] };
  const cvDocs = [...cvSnap.docs, ...cvLegacySnap.docs];
  const cvSeenIds = new Set();

  let maxCoverTs = cursor.lastCoversCursor;
  let cvTieIdsAtMax = new Set(cursor.lastCoversTieIds);
  const seenCv = new Set(cursor.lastCoversTieIds);
  const customerRowsC = [];

  cvDocs.forEach(d => {
    if (cvSeenIds.has(d.id)) return;
    cvSeenIds.add(d.id);
    if (seenCv.has(d.id)) return;
    const c = d.data();
    const ts = c.activatedAt || (c.date ? `${c.date}T12:00:00.000Z` : null);
    if (ts) {
      if (ts > maxCoverTs) {
        maxCoverTs = ts;
        cvTieIdsAtMax = new Set([d.id]);
      } else if (ts === maxCoverTs) {
        cvTieIdsAtMax.add(d.id);
      }
    }
    if (c.isTableBooking) return; // tableReservations branch already covers these
    if (last10(c.phone)) customerRowsC.push(customerRow({
      archivedAt, phone: c.phone, name: c.name, email: c.email,
      source: c.source || (c.eventTitle ? 'event_cover' : 'walkin_cover'),
      date: c.date || '',
      spend: num(c.coverActivated) + num(c.coverRecharged),
      docId: d.id
    }));
  });

  const summary = {
    onlineBookings: onlineRows.length,
    entryOnlyBookings: entryRows.length,
    guestlistContacts: guestlistRows.length + guestlistFromBookings.length,
    tableBookings: tableRows.length,
    coverContacts: customerRowsC.length,
    customerMasterAdds: customerRowsB.length + customerRowsG.length + customerRowsT.length + customerRowsC.length,
    cursorBookings: maxBookedAt,
    cursorBookingsTieIds: bookingTieIdsAtMax.size,
    cursorGuestlist: maxJoinedAt,
    cursorGuestlistTieIds: glTieIdsAtMax.size,
    cursorTableRes: maxTableTs,
    cursorTableResTieIds: trTieIdsAtMax.size,
    cursorCovers: maxCoverTs,
    cursorCoversTieIds: cvTieIdsAtMax.size
  };

  if (dryRun) return summary;

  await appendRows(sheets, 'Online Bookings',     ONLINE_BOOKING_HEADERS, onlineRows);
  await appendRows(sheets, 'Entry-Only Bookings', ENTRY_ONLY_HEADERS,     entryRows);
  await appendRows(sheets, 'Guestlist Contacts',  GUESTLIST_HEADERS,
    guestlistRows.concat(guestlistFromBookings));
  await appendRows(sheets, 'Table Bookings',      TABLE_BOOKING_HEADERS,  tableRows);
  await appendRows(sheets, 'Customer Master',     CUSTOMER_HEADERS,
    customerRowsB.concat(customerRowsG, customerRowsT, customerRowsC));

  await writeCursor(db, {
    lastBookingsCursor: maxBookedAt,
    lastBookingsTieIds: Array.from(bookingTieIdsAtMax),
    lastGuestlistCursor: maxJoinedAt,
    lastGuestlistTieIds: Array.from(glTieIdsAtMax),
    lastTableResCursor: maxTableTs,
    lastTableResTieIds: Array.from(trTieIdsAtMax),
    lastCoversCursor: maxCoverTs,
    lastCoversTieIds: Array.from(cvTieIdsAtMax)
  });

  return summary;
}

// ── Top-level orchestrator ──────────────────────────────
function archiveSummary(part) {
  // Unified shape for both dryRun (raw arrays returned) and real run (counts)
  if (part.archived) return part.archived;
  return {
    aggregators: (part.aggregators || []).length,
    walkins: (part.walkins || []).length,
    events: (part.events || []).length,
    wallets: (part.wallets || []).length,
    fraud: (part.fraud || []).length,
    deleted: 0 // dryRun never deletes
  };
}

async function runDailySync({ dryRun = false } = {}) {
  const db = admin.firestore();
  const sheets = getSheetsClient();
  const archivedAt = nowIso();

  // Lock prevents overlapping daily-cron + manual-trigger runs.
  // Skip lock for dryRun (read-only, safe to overlap).
  if (!dryRun) await acquireLock(db);
  try {
    // Pre-create ALL 12 tabs in fixed order BEFORE any append (archive or
    // sync). ensureTab is idempotent. Guarantees deterministic tab order on a
    // fresh Sheet regardless of which collections have data this run.
    if (!dryRun) {
      await ensureTab(sheets, 'Aggregators',         AGG_HEADERS);
      await ensureTab(sheets, 'Walk-ins',            WALKIN_HEADERS);
      await ensureTab(sheets, 'Events',              EVENT_HEADERS);
      await ensureTab(sheets, 'Wallets',             WALLET_HEADERS);
      await ensureTab(sheets, 'Anti-Fraud Log',      FRAUD_HEADERS);
      await ensureTab(sheets, 'Customer Master',     CUSTOMER_HEADERS);
      await ensureTab(sheets, 'Online Bookings',     ONLINE_BOOKING_HEADERS);
      await ensureTab(sheets, 'Entry-Only Bookings', ENTRY_ONLY_HEADERS);
      await ensureTab(sheets, 'Guestlist Contacts',  GUESTLIST_HEADERS);
      await ensureTab(sheets, 'Table Bookings',      TABLE_BOOKING_HEADERS);
      await ensureTab(sheets, 'Regular Customers',   REGULARS_HEADERS, REGULARS_FORMULA);
      await ensureTab(sheets, 'VVIP Customers',      VVIP_HEADERS,     VVIP_FORMULA);
    }
    const archivePart = await archiveOldReservationsAndCovers(db, sheets, archivedAt, dryRun);
    const contactPart = await syncBookingsAndGuestlist(db, sheets, archivedAt, dryRun);
    const summary = {
      archivedAt, dryRun,
      archive: archiveSummary(archivePart),
      contacts: contactPart
    };
    console.log('[sheetsSync v2]', summary);
    return summary;
  } finally {
    if (!dryRun) await releaseLock(db);
  }
}

// ── Exported functions ──────────────────────────────────
const SECRETS = ['SHEETS_CLIENT_ID', 'SHEETS_CLIENT_SECRET', 'SHEETS_REFRESH_TOKEN', 'HOD_SHEET_ID',
                 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'HOD_ADMIN_EMAILS'];

// Authz guard for the manual callable. Production HOD uses PIN-based auth at
// the UI layer (not Firebase Auth tokens), so this is the last line of defence
// against an unauthenticated callable client triggering archive+delete.
//   - Requires `context.auth` to exist (Firebase signed-in user)
//   - Requires email on token to be in `HOD_ADMIN_EMAILS` (comma-separated env)
function assertAdmin(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign-in required.');
  }
  const email = (context.auth.token && context.auth.token.email || '').toLowerCase();
  const allow = String(process.env.HOD_ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!allow.length) {
    throw new functions.https.HttpsError('failed-precondition',
      'HOD_ADMIN_EMAILS not configured. Set firebase functions:secrets:set HOD_ADMIN_EMAILS');
  }
  if (!allow.includes(email)) {
    throw new functions.https.HttpsError('permission-denied',
      `Email ${email || '(none)'} not in admin allowlist.`);
  }
}

exports.archiveToSheets = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 540, memory: '512MB', secrets: SECRETS })
  .pubsub.schedule('every day 06:00')
  .timeZone('Asia/Kolkata')
  .onRun(async () => runDailySync({ dryRun: false }));

// Manual trigger from admin UI — supports dryRun=true for safe preview.
// Authz: requires Firebase signed-in user whose email is in HOD_ADMIN_EMAILS.
exports.manualArchive = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 540, memory: '512MB', secrets: SECRETS })
  .https.onCall(async (data, context) => {
    assertAdmin(context);
    const dryRun = !!(data && data.dryRun);
    return await runDailySync({ dryRun });
  });
