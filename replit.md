# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## EDC Cloud (Razorpay POS + Pine Labs)

Door Mode can charge cards through a cloud-dispatched EDC machine instead of manual reconciliation. Off by default behind a feature flag.

- **Enable in browser:** set `VITE_EDC=1` for the `pos-system` build, then restart the `artifacts/pos-system: web` workflow. Without it, Card payments fall back to the legacy "mark paid" flow with no behaviour change. Optional `VITE_EDC_VENDOR=razorpay|pinelabs` sets the default vendor; the bouncer can override per-device from the picker on the EDC PIN panel (saved to `localStorage` under `hod.edc.vendor`).
- **Cloud functions live in the separate `hod-tickets` Firebase project**, not in this monorepo. The reference source lives at `cloud-functions/edc/` — copy it into `hod-tickets/functions/src/edc/` and deploy.
- **Required cloud-function env vars** (set in `hod-tickets`, not here):
  - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` — reuse the wallet-recharge keys
  - `RAZORPAY_EDC_TERMINAL_ID` — the door card-machine's POS Terminal ID
  - `RAZORPAY_EDC_WEBHOOK_SECRET` — HMAC secret for `razorpayEdcWebhook`
  - `EDC_BOUNCER_PIN_SALT` — random hex string used to hash bouncer PINs server-side
  - `PINELABS_MERCHANT_ID`, `PINELABS_STORE_ID`, `PINELABS_CLIENT_ID`, `PINELABS_SECURITY_TOKEN` — Pine Labs Plutus Smart Cloud creds (skip the set if the venue is Razorpay-only)
  - `PINELABS_WEBHOOK_SECRET` — HMAC secret for `pineLabsEdcWebhook`
  - `PINELABS_BASE_URL` — optional override (defaults to production; set to `https://www.plutuscloudserviceuat.in:8201` for UAT)
- **Endpoints called from the browser** (region `asia-south1`):
  - `POST /edcChargeRazorpay` → returns `{ txnId }`
  - `POST /edcChargePineLabs` → returns `{ txnId }` (or `vendor_disabled` if `PINELABS_*` secrets are unset)
  - `POST /edcCancelCharge` → best-effort cancel
- **Firestore source of truth:** `edcTransactions/{txnId}` — every charge attempt with status (`pending|success|failed|cancelled`), vendor, amount, card metadata. Reports → "💳 EDC Card" tab subscribes live and exports CSV for accountant reconciliation.
- **Security:** the cloud function reads canonical amount **only** from `covers/{coverRef}.coverBalance` then `bookings/{bookingId}.total` — no browser-writable path is honoured. `expectedAmount` from the browser is treated as a sanity check and rejected with `amount_mismatch` on divergence. Bouncer PIN is verified server-side against `hodStaffPins` with per-IP throttling (5 fails / 10 min). Webhooks are HMAC-verified (raw Buffer) before any `success` write. Idempotency keyed on `bookingRef + coverRef + minute_bucket`; the same key returns the existing txnId for `pending`/`success` and rejects re-dispatch for terminal `failed`/`cancelled` to prevent operator-driven double charges. **Constraint:** first-time activations with custom cover amounts must update `bookings/{id}.total` via the existing admin path before the EDC charge — the door tablet cannot inject ad-hoc amounts.
- **Rollout checklist:** see `cloud-functions/edc/README.md` (Razorpay dashboard setup → secrets → deploy → flip `VITE_EDC=1` → ₹1 live test).
- **Default vendor — venue-wide override (Admin → ⚙️ Settings):** owners can flip the venue's default card machine from Admin → Settings → "Default card machine" without rebuilding. Stored at Firestore `venueSettings/edc.defaultVendor`. Door Mode subscribes live and uses it as the default *unless* the tablet has a per-device override (set by the bouncer toggle on the EDC PIN panel, persisted to `localStorage` under `hod.edc.vendor`). Priority: per-device localStorage > venue Firestore default > build-time `VITE_EDC_VENDOR`. **Firestore rules:** add a rule allowing authenticated reads/writes to `venueSettings/{doc}` (matches the pattern already used for `posHappyHour` / `posAggregatorSettings`).

## Editable Customer Menu (📋 Menu Editor)

The customer wallet at hodclub.in used to ship hardcoded `HOD_FOOD_MENU` /
`HOD_BAR_MENU` / `HOD_SMOKE_MENU` arrays. They are now Firestore-backed and
live-editable from POS Admin → "📋 Menu Editor".

- **Storage:** one doc per tab at `venueMenu/{food|liquor|nab|smoke}` in the
  `hod-tickets` Firebase project. Shape: `{ tabId, categories: [{cat, items: [{n,p,t,alc,v?,oos?,sub?}]}], updatedBy, updatedAt }`.
- **POS editor:** `artifacts/pos-system/src/pages/MenuEditor.tsx`. CRUD on
  categories + items per tab, veg toggle (food only), out-of-stock toggle,
  search, and "Restore Defaults" (re-seeds from `hod-menu.ts`). Manager-PIN
  gated using the same `MANAGER_HASH_ADMIN` (PIN 8888) as the existing
  OOS/Discount tab. Every publish writes to `posAuditLog` with
  `action: "venue_menu_published"` plus tab + counts.
- **Firestore helpers:** `subscribeToVenueMenuTab`, `getVenueMenuTab`,
  `saveVenueMenuTab` in `artifacts/pos-system/src/lib/firestore.ts`. Types
  + seed defaults in `artifacts/pos-system/src/lib/venue-menu.ts`.
- **Customer wallet (separate `hodclub.in` repo):** drop-in script lives at
  `customer-wallet/menu-firestore.js` with integration steps in
  `customer-wallet/README.md`. It paints from `localStorage` cache instantly
  on boot, attaches a Firestore listener for live updates, and falls back to
  the original baked-in arrays when offline / cache-empty. Items with
  `oos:true` are hidden from the customer view (kept editable in POS).
- **Firestore rules** (add to `hod-tickets` project — do NOT use a bare
  `auth != null` write rule, that's too weak for anonymous auth):
  ```
  match /venueMenu/{tabId} {
    allow read: if true;
    // Require a custom claim set on POS-authorised identities only.
    allow write: if request.auth != null
                 && request.auth.token.posManager == true;
  }
  ```
  The editor UI is *also* gated to `admin` / `manager` roles and behind the
  existing manager-PIN prompt before publish (defence in depth).
- **Why per-tab docs (not per-item):** the wallet renders one tab at a time,
  so a single subscription per tab is the cheapest read pattern. Each tab doc
  stays well under Firestore's 1 MiB limit (current full menu ≈ 90 KB).
- **Note — independent of the existing OOS/Discount tab:** the legacy "OOS /
  Discount" admin tab still drives `posMenuOverrides` for in-house
  Captain/Bar mode. The new Menu Editor is for the customer-facing wallet.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
