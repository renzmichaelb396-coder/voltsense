# VoltSense — Auto Session Start
Cursor loads this automatically. Do not skip any step.

## Step 1 — Load vault context
Read in order:
- ~/Documents/Renz BRAIN/projects/VoltSense-Platform-Vault/CLAUDE.md
- ~/Documents/Renz BRAIN/projects/VoltSense-Platform-Vault/CONTEXT.md
- ~/Documents/Renz BRAIN/GLOBAL-CLAUDE-CODE-RULES.md

## Step 2 — Check deficiencies
Read ~/Documents/Renz BRAIN/DEFICIENCIES.md
List every OPEN row tagged "VoltSense"
State them before any work begins.

## Step 3 — State readiness
Context loaded. Open deficiencies listed. Ready to work.

## Non-negotiables
- No code before Step 1 completes
- No deploy without pre-deploy gate in GLOBAL-CLAUDE-CODE-RULES.md
- Every bug: diagnose root cause before touching code

---

## VoltSense CSMS — System State (updated 2026-07-05)

### Deployment
- **Backend:** https://voltsense-pmfq.onrender.com (Render Free, Singapore)
- **Service ID:** srv-d93u62ho3t8c739rdavg
- **Repo:** renzmichaelb396-coder/voltsense, branch main
- **Build:** `npm install --include=dev && npm run build:emit`
- **Start:** `node dist/server/main.js`
- **Landing page:** https://voltsense-csms.vercel.app (static only, no deploys needed)

### Supabase
- **Project:** uwalsvtegdgwveaejpep (ap-southeast-1, voltsense-csms)
- **Pooler URL:** `aws-1-ap-southeast-1.pooler.supabase.com:6543` (NOT aws-0; port 6543 = transaction pooler, NOT 5432)
- **DB password:** <redacted — see Render dashboard> (rotated 2026-07-06; if Render 500s with "password authentication failed", reset password in Supabase → update Render DATABASE_URL immediately in same session)

### Environment Variables (Render + .env)
- `DATABASE_URL` — postgresql://postgres.uwalsvtegdgwveaejpep:<password>@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres (confirmed working 2026-07-06)
- `PAYMONGO_SECRET_KEY` — sk_test_<redacted> (swap for sk_live_ on approval)
- `PAYMONGO_WEBHOOK_SECRET` — whsk_<redacted> (test mode)
- `VOLTSENSE_SHIELD_USER` — admin
- `VOLTSENSE_SHIELD_PASSWORD` — <redacted — see Render dashboard> (rejects 'change-me' at startup)
- `NODE_ENV` — production

### API Routes
- `POST /checkout` — create session + PayMongo link. Body: `{ chargePointId, connectorId, packageId, idTag }`. Price computed server-side from tariff. Returns `{ sessionId, checkoutUrl }`
- `GET /health` — public, returns `{ status: "ok", ts: <epoch> }` — used by keep-warm ping
- `POST /payments/create` — legacy; creates payment link for existing sessionId
- `POST /webhooks/paymongo` — HMAC-verified; payment.paid → payment_cleared + RemoteStartTransaction; payment.failed → status=failed
- OCPP WebSocket: `wss://host/ocpp/{serialNumber}` — URL segment resolved against chargePoints.serialNumber → UUID; liveConnections keyed by UUID

### Payment → Charging Flow (critical ordering)
1. `POST /checkout` → session(awaiting_payment) + payments(pending) + PayMongo link
2. `payment.paid` webhook → payments(paid) + session(payment_cleared) → `sendRemoteStartTransaction`
3. OCPP `StartTransaction` → session(charging), meterStartWh stored, transactionId→sessionId mapped in memory
4. OCPP `StopTransaction` → kwhDelivered computed → `executeRevenueSplitOrRefund` → ledger entries
5. BootNotification on reconnect → retryPendingSessionsForReconnect() fires async (catches payment_cleared + paid_charger_offline sessions)

**⚠️ DO NOT call settlement on payment.paid** — kwhDelivered is null until StopTransaction. Settlement MUST run in the StopTransaction handler only.

### GoMandaloyo Seed (Supabase — tariff corrected 2026-07-05)
- Site: `11111111-1111-1111-1111-111111111111` — Go Hotel Mandaluyong
- Tariff: `22222222-2222-2222-2222-222222222222` — DU ₱14/kWh, host ₱8/kWh, platform ₱7/kWh, flat ₱0, PSP 3.5% → **₱29/kWh total** (vault spec §4.1)
- Charge point: `33333333-3333-3333-3333-333333333333` — VS-AC-7KW serial VS-MAN-001
- Connector: `44444444-4444-4444-4444-444444444444` — connector 1, 32A
- Platform vault: `00000000-0000-0000-0000-000000000001`
- ⚠️ Configure B26471 OCPPSetTool to connect via serial: `wss://voltsense-pmfq.onrender.com/ocpp/VS-MAN-001`

### PayMongo — LIVE MODE (switched 2026-07-15)
- ⚠️ LIVE MODE ACTIVE — sk_live_ keys in Render, real customer money
- Live webhook ID: registered pointing to https://voltsense-pmfq.onrender.com/webhooks/paymongo
- Payment methods: qrph, gcash, paymaya, card, grab_pay
- GCash/Maya: APPROVED under QRPH (July 13, 2026)
- BPI settlement account added: 009763-0453-09, CIVICGRID SOFTWARE DEVELOPMENT SERVICES (Payouts → Saved Recipients)
- ⚠️ ROTATE KEYS — sk_live_ and whsk_ were pasted in chat history. Rotate in PayMongo dashboard before real guests arrive.
- statement_descriptor: 'VoltSense EV' added to checkout payload

### Commits (2026-07-04 → 2026-07-15)
4a4533b → … → 15c4ee6 → b5ff43d → ef08ec0 → 8cd3642 → 9727d4b → 2ac4854 → **9727d4b**
Key commits this session:
- b5ff43d — add QRPh payment method
- ef08ec0 — statement_descriptor + live key deploy
- 8cd3642 — UX polish: best value ribbon, battery hints, iOS zoom
- 9727d4b — bold battery hints (Battery reaches X%)

### Full Session — REMOVED (2026-07-15, pending execution)
⚠️ Full Session (₱500 flat, unlimited kWh) is a money-losing product:
- Breakeven: 17.24 kWh. Any session >17.24 kWh loses money.
- 22kW charger = 22 kWh/hr. Every 1-hour session loses money.
- REPLACEMENT: Smart Fill (calculates exact kWh from car + battery %, sends as PKG_CUSTOM)
- Goal prompt generated — run in Claude Code to execute the removal.

### DB Schema — sessions table additions (2026-07-05)
- `ocpp_transaction_id integer` — applied manually via Supabase SQL editor (IF NOT EXISTS). Persists CSMS transactionId so StopTransaction settlement survives Render restarts. No drizzle-kit migrate in this repo — all migrations via Supabase SQL editor directly.

### Known Gaps (acceptable for pilot)
- `sendRemoteStartTransaction` drops silently if charger offline at payment time → sets session to paid_charger_offline; BootNotification retry picks it up on reconnect
- No integration tests (Drizzle query correctness against real Postgres unverified)
- `markSessionChargerOffline` in ocpp_ws.ts untested
- Two guests with same idTag on same charger simultaneously → wrong session lookup (won't happen in current one-checkout-per-guest flow)
- Admin dashboard (/admin) is a stub — returns JSON only, no real session UI

### Pre-Pilot Blocklist (must clear before B26471 goes live)
- [ ] Call KPC — confirm B26471 warehouse arrival date
- [ ] Print QR sticker — deeplink: `https://voltsense-csms.vercel.app/charge.html?cpid=33333333-3333-3333-3333-333333333333&cid=1`
- [x] QR paywall page — charge.html deployed to Vercel (scan → select package → POST /checkout → redirect to PayMongo)
- [ ] GCash/Maya approval (watch renzmichaelb396@gmail.com — submitted 2026-07-01, day 5 of 3–9 biz days)
- [ ] On GCash/Maya approval: swap sk_test_→sk_live_, new live webhook, update Render PAYMONGO_WEBHOOK_SECRET
- [ ] Confirm electrician + site host (Go Hotels) install date
- [ ] Configure B26471 in OCPPSetTool: `wss://voltsense-pmfq.onrender.com/ocpp/VS-MAN-001`
