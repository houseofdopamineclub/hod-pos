# HOD — Google Sheets Sync v2 (DEPLOY GUIDE)

**What v2 adds on top of v1:**
- ✅ **Guestlist Contacts** tab — every guestlist signup (customer-site + door 🎁 FREE ENTRY)
- ✅ **Online Bookings** tab — paid customer-site ticket bookings
- ✅ **Entry-Only Bookings** tab — entry-only paid bookings
- ✅ **Table Bookings** tab — every table reservation (in-house + Zomato/Swiggy/EazyDiner/District) synced **immediately**, not waiting 14 days for archive
- ✅ **Regular Customers** tab (auto-formula) — phones with **≥2 visits** across any source
- ✅ **VVIP Customers** tab (auto-formula) — phones with **≥₹15,000 lifetime spend**
- ✅ Incremental cursor-based sync for bookings / guestlist / tableReservations / covers — no duplicates
- ✅ **Bookings + guestlist NEVER deleted** (only old `tableReservations` + `covers` cleaned at 14 days, AFTER their contact data is safely in Customer Master)
- ✅ **Customer Master is the ONLY source of truth for VVIP/Regulars formulas** — populated by live sync, never double-counted at archive time

Daily run at **6 AM IST**. Manual `manualArchive` callable still works (with optional `dryRun: true`).

---

## ✅ STEP 1 — Drop the files into your `functions/` folder

Copy these 2 files into your `hod-cloud-functions-patch/functions/` folder:

```
hod-functions-patch/sheetsSync.js               →  functions/sheetsSync.js   (REPLACES v1)
hod-functions-patch/get-sheets-refresh-token.js →  functions/get-sheets-refresh-token.js
```

In your `functions/index.js` (if v1 was already wired, **no change needed** — same exports):

```js
const sheetsSync = require('./sheetsSync');
exports.archiveToSheets = sheetsSync.archiveToSheets;
exports.manualArchive   = sheetsSync.manualArchive;
```

> No new `npm install` needed — `googleapis` already in `package.json`.
> **One new secret needed:** `HOD_ADMIN_EMAILS` (comma-separated list of Firebase-signed-in emails allowed to trigger `manualArchive`). Without it the manual callable refuses to run. Daily cron is unaffected.
>
> ```bash
> firebase functions:secrets:set HOD_ADMIN_EMAILS
> # paste e.g.: darshan@hodclub.in,manager@hodclub.in
> ```

---

## ✅ STEP 2 — (Skip if v1 already deployed) Create the Sheet + secrets

If you already deployed v1, skip to Step 3. Otherwise follow v1 setup:
1. Create blank Sheet at [sheets.new](https://sheets.new), name it `HOD Archive — Reservations & Wallets`
2. Copy spreadsheetId from URL (the long string between `/d/` and `/edit`)
3. `cd functions && node get-sheets-refresh-token.js` → copy refresh token
4. `firebase functions:secrets:set` for: `SHEETS_CLIENT_ID`, `SHEETS_CLIENT_SECRET`, `SHEETS_REFRESH_TOKEN`, `HOD_SHEET_ID`

> All **11 tabs** auto-create on first run with proper headers + formulas. **Don't add tabs yourself.**

---

## ✅ STEP 3 — Deploy

```bash
cd functions
firebase deploy --only functions:archiveToSheets,functions:manualArchive
```

~2 min. Same deploy command as v1.

---

## ✅ STEP 4 — Smoke test (DRY RUN — no writes, no deletes)

In browser console signed in as a Firebase user:

```js
firebase.functions('asia-south1')
  .httpsCallable('manualArchive')({ dryRun: true })
  .then(r => console.log(r.data));
```

You should see:

```js
{
  archivedAt: "2026-05-08T...",
  dryRun: true,
  archive: { aggregators: 18, walkins: 29, ... },
  contacts: {
    onlineBookings: 47,
    entryOnlyBookings: 12,
    guestlistContacts: 89,
    tableBookings: 156,
    coverContacts: 203,
    customerMasterAdds: 507,
    cursorBookings: "2026-05-08T...",
    cursorGuestlist: "2026-05-08T...",
    cursorTableRes: "2026-05-08",
    cursorCovers: "2026-05-08"
  }
}
```

**Nothing was written or deleted.** Just a preview.

---

## ✅ STEP 5 — First REAL run

```js
firebase.functions('asia-south1')
  .httpsCallable('manualArchive')({})
  .then(r => console.log(r.data));
```

Open the Sheet. You should now see **12 tabs**:

| Tab | What's in it | Source |
|---|---|---|
| Aggregators | Zomato/Swiggy/EazyDiner/District tables (>14 days old) | tableReservations |
| Walk-ins | In-house tables (>14 days old) | tableReservations |
| Events | Wallet/cover docs with eventTitle (>14 days old) | covers |
| Wallets | All wallet/cover docs (>14 days old) | covers |
| Anti-Fraud Log | Discount overrides + source swaps + KOT voids | tableReservations |
| Customer Master | UNIFIED contact log — every phone, every source (sole input to Regular/VVIP formulas) | live sync from bookings + guestlist + tableReservations + covers |
| **Online Bookings** | Paid ticket bookings from hodclub.in | bookings |
| **Entry-Only Bookings** | Entry-only paid bookings | bookings (entryType=entry_only) |
| **Guestlist Contacts** | Free guestlist + door FREE ENTRY | guestlist |
| **Table Bookings** | Every table reservation (in-house + Zomato/Swiggy/EazyDiner/District) — synced immediately | tableReservations |
| **Regular Customers** ⭐ | Auto-formula: phones with ≥2 visits | QUERY over Customer Master |
| **VVIP Customers** ⭐ | Auto-formula: phones with ≥₹15,000 lifetime spend | QUERY over Customer Master |

⭐ Regular & VVIP tabs auto-update every time you open the Sheet — no re-deploy or re-run needed. As Customer Master grows, your promo lists grow with it.

After this succeeds once, the daily 06:00 IST schedule runs automatically forever.

---

## 🎯 Using it for promo WhatsApp blasts

1. Open Sheet → **Regular Customers** or **VVIP Customers** tab
2. Filter/sort as needed (the QUERY result is sortable like normal data)
3. Copy the **phone** column → paste into WhatsApp Business broadcast list, or feed to a Twilio/Meta Cloud API script
4. Phone numbers are stored as last-10-digits (e.g. `9686444906`) — prefix `+91` if needed for international format

---

## 🛡 Safety guarantees

- **Sheet writes happen BEFORE Firestore deletes.** If Sheets fails, nothing is deleted.
- **Bookings + guestlist are NEVER deleted** — only old reservations + covers are cleaned.
- **Cursor-based incremental sync** for bookings/guestlist — same doc never appears twice in the Sheet.
- **Dry-run mode** lets you preview every run.
- **VVIP threshold** set in `sheetsSync.js` line 50 (`VVIP_THRESHOLD = 15000`). Change + redeploy if you want different cutoff.
- **Regular threshold** set in `sheetsSync.js` line 51 (`REGULAR_MIN_VISITS = 2`).
- **14-day reservation/cover cutoff** set line 49 (`RETENTION_DAYS = 14`).

---

## 🐛 If something goes wrong

```bash
firebase functions:log --only archiveToSheets
firebase functions:log --only manualArchive
```

| Error | Fix |
|---|---|
| `HOD_SHEET_ID not set` | Re-run `firebase functions:secrets:set HOD_SHEET_ID`, redeploy |
| `The caller does not have permission` | Share Sheet with the OAuth account from Step 3 (Editor) |
| `invalid_grant` | Refresh token expired — re-run `node get-sheets-refresh-token.js` |
| Regular/VVIP tabs show `#REF!` or "no data yet" | Customer Master has no rows yet. Run again after some bookings/guestlist activity. |
| Same booking appears twice in Online Bookings | Check `_meta/sheetsSync` doc in Firestore — manually edit `lastBookingsCursor` to a recent ISO timestamp to skip duplicates |

---

## 📦 v1 → v2 migration notes

- v1 left no cursor doc → first v2 run will pick up **ALL existing bookings + guestlist + tableReservations + covers** (from start of time). Expect ~all-time totals on first run, then incremental thereafter.
- v1's 6 tabs are unchanged. New 6 tabs append below them in the Sheet.
- Customer Master is now populated by **live sync only** (was: only at 14-day archive in v1). Regular/VVIP formulas now reflect tonight's customers within 24 hours instead of 14 days.
- v1 archive step pushed customers to Customer Master. v2 removes that to prevent double-counting (live sync got there first). One-time effect: any customer who appeared in Customer Master via v1 archive AND lives in `bookings`/`tableReservations`/`covers` collections will be re-counted on first v2 run. Manually de-dup once via Sheet → Data → Remove duplicates if you care about historical accuracy. New runs are clean.

That's it. ~10 min total deploy time.

---

## v3 ADDITION (2026-05-10) — DAILY VOID DIGEST (Anti-Fraud #B4)

A new scheduled function that sends Khushi a WhatsApp every morning at **11:00 IST** summarizing last night's voids.

**Sample message:**
```
🔴 HOD VOID DIGEST — SAT, 9 MAY

📊 Last night: 3 voids · ₹4,200 leakage

👤 TOP VOIDERS (7-day):
1. Rohan — ₹4,200 (1 bills · 2 item-voids)
2. Sumit — ₹1,800 (1 bills · 0 item-voids)
3. Anish — ₹900 (0 bills · 2 item-voids)

🍽 REPEAT-VOIDED DISHES (7-day, ≥3):
• Old Fashioned — voided 4× by Rohan, Sumit

🔍 Review: https://hodclub.in/admin/audit
```

### One-time setup on Khushi's Mac

```bash
cd ~/Desktop/hod-functions-backend

# 1. Drop the file in
cp /path/to/repl/hod-functions-patch/voidDigest.js ./voidDigest.js

# 2. Wire it up — append to functions/index.js
cat >> index.js <<'EOJ'
const { dailyVoidDigest, runVoidDigestNow } = require("./voidDigest");
exports.dailyVoidDigest = dailyVoidDigest;
exports.runVoidDigestNow = runVoidDigestNow;
EOJ

# 3. Set the secrets (one-time — replace XXX with real values)
firebase functions:config:set \
  whatsapp.token="EAAxxx..." \
  whatsapp.phone_id="123456789" \
  khushi.phone="91XXXXXXXXXX"

# 4. Deploy ONLY the new function (won't touch sheetsSync etc)
firebase deploy --only functions:dailyVoidDigest,functions:runVoidDigestNow
```

### Fallback (Khushi's safety net)

- If WhatsApp send ever fails, the digest is **always** written to Firestore at `_meta/lastVoidDigest`. Read it manually if the morning message doesn't arrive.
- If last night had **0 voids** → no WhatsApp sent (no spam).

### Verify after deploy

In Firebase Console → Functions → `dailyVoidDigest` → trigger manually OR call `runVoidDigestNow` from the React admin (future button) to confirm the WhatsApp lands on Khushi's phone.

---

## v3 ADDITION (2026-05-10) — CUSTOMER NOTIFY ON BILL VOID (Anti-Fraud #A3)

A Firestore trigger that WhatsApps the customer the moment their bill is voided in the POS — closing the cash-pocket scam (captain pockets cash + voids).

**Sample message customer receives (within seconds):**
```
🔴 HOD — BILL VOIDED

Hi Kajjal, your bill at HOD (FD17, ₹2,450) was VOIDED at 11:48 pm by Rohan.

Reason: WALKED OUT

If you believe you DID pay, please call Khushi at +919XXXXXXXXX immediately
so we can verify with our records.

— House of Dopamine
```

### One-time setup on Khushi's Mac

```bash
cd ~/Desktop/hod-functions-backend

# 1. Drop the file in
cp /path/to/repl/hod-functions-patch/voidNotifyCustomer.js ./voidNotifyCustomer.js

# 2. Wire it up — append to functions/index.js
cat >> index.js <<'EOJ'
const { voidNotifyCustomer } = require("./voidNotifyCustomer");
exports.voidNotifyCustomer = voidNotifyCustomer;
EOJ

# 3. Secrets — REUSE the same ones you set for voidDigest:
#    whatsapp.token, whatsapp.phone_id, khushi.phone
#    (no extra config needed)

# 4. Deploy ONLY this trigger
firebase deploy --only functions:voidNotifyCustomer
```

### How it works

1. POS captain taps **🚫 Void Bill** + Manager PIN + reason → `voidBill()` runs.
2. After the void persists, POS writes one doc into `voidNotificationsQueue` with `{type:"bill-void", customerPhone, customerName, billTotal, tableId, voidedBy, voidReason, status:"pending"}`.
3. Cloud function `voidNotifyCustomer` triggers on the new doc → normalizes phone (adds `91` prefix if missing) → sends WhatsApp text → updates queue doc to `status:"sent"` with `sentAt` + `sendResult`.

### Fallbacks

| Scenario | Behaviour |
|---|---|
| Customer phone missing on the table | Queue row written with `status:"skipped-no-phone"` straight from the POS. No function call. No spam. Audit shows the gap. |
| WhatsApp API down / token expired | Queue row updated with `status:"failed"` + the API error string. **Bill void itself is NEVER blocked** — captain can finish the void and we retry/audit later. |
| 24-hour conversation window expired (cold lead) | WhatsApp may reject with `131047`. We log it; consider migrating to an approved Meta template later. |
| Customer phone is invalid format | Normalizer best-effort (adds `91`, strips non-digits). If WhatsApp rejects, queue shows `status:"failed"` with the raw API error for debugging. |

### Verify after deploy

1. Captain mode → run a test bill void on a table with your own phone number → check WhatsApp lands within ~5s.
2. Firebase Console → Firestore → `voidNotificationsQueue` → confirm the doc moved from `status:"pending"` → `status:"sent"`.
