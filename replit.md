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

- **Enable in browser:** set `VITE_EDC=1` for the `pos-system` build, then restart the `artifacts/pos-system: web` workflow. Without it, Card payments fall back to the legacy "mark paid" flow with no behaviour change.
- **Cloud functions live in the separate `hod-tickets` Firebase project**, not in this monorepo. The reference source lives at `cloud-functions/edc/` — copy it into `hod-tickets/functions/src/edc/` and deploy.
- **Required cloud-function env vars** (set in `hod-tickets`, not here):
  - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` — reuse the wallet-recharge keys
  - `RAZORPAY_EDC_TERMINAL_ID` — the door card-machine's POS Terminal ID
  - `RAZORPAY_EDC_WEBHOOK_SECRET` — HMAC secret for `razorpayEdcWebhook`
  - `EDC_BOUNCER_PIN_SALT` — random hex string used to hash bouncer PINs server-side
  - `PINELABS_*` — Phase 2 only
- **Endpoints called from the browser** (region `asia-south1`):
  - `POST /edcChargeRazorpay` → returns `{ txnId }`
  - `POST /edcChargePineLabs` → Phase 2 placeholder, returns `vendor_disabled` today
  - `POST /edcCancelCharge` → best-effort cancel
- **Firestore source of truth:** `edcTransactions/{txnId}` — every charge attempt with status (`pending|success|failed|cancelled`), vendor, amount, card metadata. Reports → "💳 EDC Card" tab subscribes live and exports CSV for accountant reconciliation.
- **Security:** the cloud function reads canonical amount **only** from `covers/{coverRef}.coverBalance` then `bookings/{bookingId}.total` — no browser-writable path is honoured. `expectedAmount` from the browser is treated as a sanity check and rejected with `amount_mismatch` on divergence. Bouncer PIN is verified server-side against `hodStaffPins` with per-IP throttling (5 fails / 10 min). Webhooks are HMAC-verified (raw Buffer) before any `success` write. Idempotency keyed on `bookingRef + coverRef + minute_bucket`; the same key returns the existing txnId for `pending`/`success` and rejects re-dispatch for terminal `failed`/`cancelled` to prevent operator-driven double charges. **Constraint:** first-time activations with custom cover amounts must update `bookings/{id}.total` via the existing admin path before the EDC charge — the door tablet cannot inject ad-hoc amounts.
- **Rollout checklist:** see `cloud-functions/edc/README.md` (Razorpay dashboard setup → secrets → deploy → flip `VITE_EDC=1` → ₹1 live test).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
