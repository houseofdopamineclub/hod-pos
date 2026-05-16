# HOD — House of Dopamine
Nightclub POS for billing, KOTs, anti-fraud, and staff ops. Owner: **Khushi** (non-technical, ALL-CAPS comms, one-step-at-a-time, fail-open + always include fallbacks).

## Run & Operate
- **Run:** `pnpm dev` · **Build:** `pnpm build`
- **Required env:** `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `admin_password`
- **KOT Print Server:** HTTP per floor PC (default `http://192.168.0.x:3001/print`).

## Stack
- **Frontend:** React + Vite (pnpm monorepo).
- **Backend:** Firebase Cloud Functions (Node 20, asia-south1) — separate repo on Khushi's Mac at `~/Desktop/hod-functions-backend/`.
- **Firebase project:** `hod-tickets`. **DB:** Firestore.
- **Customer site:** Netlify (`hodclub-patched/index.html` — single-file SPA). Razorpay live key `rzp_live_Sgf6ON1mQY95kT`.
- **UI:** Black `#030305`, gold `#C9A84C`, Playfair Display + Space Grotesk.

## Where things live
- **Monorepo:** `artifacts/pos-system` (React POS) · `artifacts/hod-preview` (Netlify mirror) · `artifacts/api-server` (DO NOT TOUCH without explicit instruction).
- **Schemas (Firestore, implicit):** `tableReservations`, `posOrders`, `posKOTs`, `events`, `bookings`, `guestlist`, `covers`, `captainVoidStats`, `voidNotificationsQueue`.
- **Customer site:** `hodclub-patched/index.html` — booking + wallet + table reservations + Razorpay.
- **Admin Dashboard:** `artifacts/pos-system/src/pages/` — Reports, Live Monitor, Events, Staff, Audit, Locks.
- **Print Server:** `print-server/` (Node daemon, Windows Service per floor PC).

## Architecture decisions
- **PIN auth:** 4-digit per-staff (Captain/Bar/Door/Manager/Admin tiers).
- **Anti-fraud:** Manager PIN gates on high-risk ops; comp limits; full audit trail.
- **Real-time:** Firestore for cross-terminal sync.
- **Multi-floor printing:** KOTs → Firestore with destination tags; floor PCs subscribe.
- **Operational night** = 12pm→12pm IST via `getOperationalNightStr()`.
- **Fail-open philosophy:** anti-fraud cap failures NEVER block legitimate revenue ops — they lose audit and surface a banner.

## PINs (rotate via sha256(newPin) and replace hash constants)
- **Captain login** → set per-staff in Admin → Staff (default seed 1234).
- **Manager** → `8888` (post-bill source/discount swap, walk-in over-discount, KOT void, SC waiver ≥₹1500, high-discount mark-paid, pre-bill source change, door over-discount, bill void).
- **Admin** → `9999` (second factor for aggregator → in-house downgrade · Locks tab unlock).

## ✅ ALREADY DEPLOYED (verified via Khushi's Mac screenshot 16 May)
- Aggregator email parser: `pollAggregatorEmails` cron + `parsers.js` + `autoAssign.js` + `gmailPoll.js` LIVE in `~/Desktop/hod-functions-backend/functions/`. Writes `aggregatorBookings` → `tableReservations` (source: swiggy-dineout/zomato/eazydiner). When tables stop appearing → check `firebase functions:log --only pollAggregatorEmails`. Most likely: Gmail OAuth refresh token expired (~6mo lifespan in testing mode) or forwarding filter disabled.
- `walletRechargeWebhook.js` LIVE (Razorpay auto-credit). Previously thought pending — was wrong.
- `sheetsSync.js` LIVE (Google Sheets sync v3 cron).

## 🚧 Active pending work
- 🟡 **BAR MODE per-item VOID** — captain ✅ done; bar side gap: once a wallet round is activated, bartender has no UI to void an item. Target `BarMode.tsx` WalletOverlay activated rounds.
- 🟡 **WhatsApp send moved to Cloud Functions** — code-drop READY in `hod-functions-patch/whatsappSend.js` + `DEPLOY-WHATSAPP.md`. Customer site URL already flipped; Replit api-server route LEFT INTACT as silent fallback. **Verify deploy status on Khushi's Mac before assuming pending.**
- 🟡 **Sheets cron timezone fix** — currently us-central1 06:00 UTC = 11:30 IST; should be Asia/Kolkata 06:00. (Function is deployed, just wrong timezone.)
- 🟡 **WhatsApp template for void digest** — bypass 24-hr engagement window.
- 🟡 **TablePOS legacy retirement** — `/table/*` V1 (no aggregator/tax/anti-fraud); NEW work only in `/captain` and `/bar`.
- 🟡 **DigiPoS integration** — forward KOTs for inventory/recipe-cost analytics.
- 🟡 **Static IPs** for GF/FF/RT print PCs.
- 🟡 **Pine Labs Plutus integration** — pending API docs from Khushi (TID, static LAN IP, merchant key, REST/socket spec). On arrival, Bar Mode payment buttons collapse from 4 → 3 (CASH · CARD/UPI · SPLIT) — customer chooses method on machine, Razorpay UPI stays as silent fallback.

## 📱 APK plan (decided 15 May 2026)
- **Plan A (5-day internal alpha, HOD-only):** Capacitor + cleartext config + bill print via print server + Capacitor camera + WhatsApp Intent + audio gesture fix. Razorpay WebView popup accepted with ~5% fail rate.
- **Plan B (SaaS-ready, ~2-3 months out):** multi-tenant refactor first, then Razorpay native SDK, custom modals, kiosk lockdown, Bluetooth thermal printer, Capacitor Live Update, push notifications, Play Store listing.
- ✅ **Firestore offline persistence already shipped** (`firebase.ts` uses `persistentLocalCache` + `persistentMultipleTabManager` with memory-only fallback).
- Full audit + cost model archived in history file.

## Reports (`/admin → 📋 Reports`)
- Tables · Wallets · KOT vs Bill tabs; date picker (last 7 nights); CSV export with UTF-8 BOM.
- Tables view: ambiguity 🟢/🟠/🔴 · 💰 Aggregator Variance column (RED ≤ −₹500, AMBER ≥₹200) · DigiPoS per-item CSV.
- **Google Sheets sync v3** — 12 tabs. Source: `hod-functions-patch/sheetsSync.js`. Sheet `1xpuiwB96gLjQANaIe6qinKisQdEcNREoz2quRFb99sg`.
- **Sheet Regular/VVIP formulas** — use NESTED QUERY (parser rejects `having`).
- **Test phones excluded:** `9611111261`, `9611111126`, `9591961444`, `9999999999`.

## Live Monitor (`/admin → 🔴 Live Monitor` — DEFAULT)
- 9 real-time tiles (overrides · source swaps · KOT voids · duplicate bills · stale bills · unpaid >30min · modified discounts · open tabs · KOT-bill leakage). Pulse RED on 15-min activity.
- 👥 Per-Staff Leakage Score · 🌡 Discount Drift Heatmap · 🔇 Silent Pre-Print Edits.

## 🖨 Venue Printer Layout
- **GF** — `gf_bar` → .80 (dedicated bar) · `gf_bill` → .55. PC `SK-POS` @ .171. ✅ Service installed.
- **FF** — `ff_bar` + `ff_bill` + `kitchen` (eventual) → .15. PC @ .127. ✅ Service installed.
- **2F** — `2f_bar` + `kitchen` (food from all floors) → .89. ✅ Service installed.
- **Rooftop** — `rt_kitchen` + `rt_bill` → .130. PC @ .154. ✅ Service installed.
- **Routing:** ALL drink KOTs → `ff_bar` (single bar, runners distribute). See `deriveItemDestination`.

## Gotchas
- 🔴 **PRINT SERVER CMD WINDOW** must stay open until `node install-service.js` registers as Windows Service.
- 🔴 **WINDOWS CMD "SELECT MODE":** clicking inside cmd freezes Node. Press `Esc`. Best fix = service.
- **KOT Print Idempotency:** `printKOT` is fire-and-forget; manual retry needed if print fails after debit.
- **WhatsApp templates:** `wallet_ready`, `guestlist_ready` need Meta approval. Plain text requires recipient engagement in last 24hrs.
- **Aggregator integration:** manual; API sync future.
- **Offline printing:** tablet KOTs queue locally; total internet blackout = no print.
- **DO NOT touch `artifacts/api-server`** without explicit instruction.
- **DO NOT modify Firebase rules for non-`pos*` collections.**

## User preferences
- ALL-CAPS / non-technical communication. ONE STEP AT A TIME. Plain language.
- Always include fallback options ("if X fails, do Y") in every instruction.
- Iterative dev with clear comms on major changes.

## Pointers
- Firebase: https://firebase.google.com/docs · React: https://react.dev/ · Vite: https://vitejs.dev/ · pnpm: https://pnpm.io/
- WhatsApp Cloud API: https://developers.facebook.com/docs/whatsapp/cloud-api/
- Razorpay: https://razorpay.com/docs/webhooks/

---
*Full historical changelog (every shipped feature, file:line breadcrumbs, deploy guides, deep audits) archived to `replit.md.history-2026-05-16`. Read that file for the full audit trail.*
