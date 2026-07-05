# VoltSense — Session Notes & Lessons

---

## LESSON-020: Monaco Editor Cannot Be Set via form_input
**Date:** 2026-07-04
**System:** Global (Cowork / browser automation)
**What Happened:** Tried to set Supabase SQL editor content using `form_input` on the textarea ref. Only the last line was saved; all previous lines were lost.
**Root Cause:** Supabase SQL editor uses Monaco (CodeMirror-style), not a standard textarea. `form_input` sets `.value` directly, which Monaco ignores except for the final newline.
**Fix:** Use `javascript_exec` with `window.monaco.editor.getEditors()[0].setValue(sql)` to set content programmatically.
**Prevention:** Never use form_input on a Monaco/CodeMirror editor. Always use the Monaco JS API.

---

## LESSON-021: Supabase SQL Editor Requires DO $$ Block for Multi-Statement + ON CONFLICT
**Date:** 2026-07-04
**System:** VoltSense / Supabase
**What Happened:** Multiple INSERT ... ON CONFLICT DO NOTHING statements separated by semicolons threw "syntax error at or near ON" when run together.
**Root Cause:** Supabase SQL Editor (via PostgREST) doesn't always handle multi-statement batches with ON CONFLICT cleanly when typed via keyboard simulation (newlines collapse).
**Fix:** Wrap all INSERTs in a `DO $$ BEGIN ... END $$;` block, then run the verification SELECT separately.
**Prevention:** Always use DO $$ blocks for multi-INSERT seeds with ON CONFLICT clauses in Supabase SQL editor.

---

## LESSON-022: Payment.paid Must NOT Trigger Settlement — kwhDelivered is Null
**Date:** 2026-07-04
**System:** VoltSense
**What Happened:** `handlePayMongoWebhook` called `executeRevenueSplitOrRefund` on `payment.paid`. Settlement threw "kwhDelivered is null" every time, which triggered a spurious refund on every successful payment.
**Root Cause:** `settlement.ts` requires `kwhDelivered` to be set on the session, which only happens after OCPP `StopTransaction`. At `payment.paid` time, charging hasn't started yet.
**Fix:** `payment.paid` → mark session `payment_cleared` + send `RemoteStartTransaction`. Settlement runs in the `StopTransaction` handler after `kwhDelivered` is computed.
**Prevention:** In any prepaid EV charging CSMS, settlement is ALWAYS post-charging, never post-payment. Never call settlement at payment webhook time.

---

## LESSON-023: OCPP BootNotification Retry Must Be Fire-and-Forget
**Date:** 2026-07-04
**System:** VoltSense
**What Happened:** When wiring BootNotification retry for pending sessions, the retry sweep must not block the `BootNotification.conf` response.
**Root Cause:** If the retry sweep is awaited before returning `Accepted`, a slow DB query or PSP call delays the charger's boot handshake, causing the charger to retry the connection.
**Fix:** Call `retryPendingSessionsForReconnect()` as fire-and-forget (not awaited) after sending `Accepted`. Failures are caught per-session and logged, never re-thrown.
**Prevention:** Any async work triggered by an OCPP message must never delay the `.conf` response. Always ack first, then do work.

---

## LESSON-024: Supabase Pooler Region is aws-1, Not aws-0
**Date:** 2026-07-04
**System:** VoltSense
**What Happened:** DATABASE_URL used `aws-0-ap-southeast-1` as the pooler host. Connection failed silently.
**Root Cause:** The actual Supabase Supavisor pooler for ap-southeast-1 is on `aws-1-ap-southeast-1`. `aws-0` is wrong for this region.
**Fix:** Changed to `aws-1-ap-southeast-1.pooler.supabase.com:5432`.
**Prevention:** Always copy the pooler URL directly from Supabase Dashboard → Settings → Database → Connection Pooling. Never type it from memory.

---

## Session Summary — 2026-07-04

**What was built:**
- VoltSense backend deployed to Render (Free tier, Singapore)
- PayMongo webhook registered (test mode, payment.paid + payment.failed)
- DB password rotated after exposure in Cursor transcript
- Full payment→charging→settlement flow wired end-to-end
- POST /checkout endpoint (session + PayMongo link in one call)
- Real OCPP WebSocket dispatch for RemoteStartTransaction
- BootNotification retry for paid-but-charger-offline sessions
- First test suite (BootNotification retry, 4 cases)
- GoMandaloyo seed data in Supabase (site, tariff, charger, connector, platform vault)

**Commits:** 4a4533b → a335ea8 → 141a6eb → 524265f → a271222 → 7973b62

**Next session start:**
1. Check Gmail for PayMongo GCash/Maya approval (submitted 2026-07-01)
2. If approved: swap sk_test_→sk_live_ in Render, register live webhook, update PAYMONGO_WEBHOOK_SECRET
3. GoMandaloyo outreach — demo pitch, not more code
4. If more code needed: integration tests (real Postgres), markSessionChargerOffline test, retry queue for persistent offline sessions

---

## LESSON-025: GoMandaloyo Tariff Was Seeded Wrong
**Date:** 2026-07-05
**System:** VoltSense
**What Happened:** Initial Supabase seed used ₱11 DU + ₱3 host + ₱1 platform + ₱5 flat (~₱15/kWh). Vault spec §4.1 requires ₱29/kWh (₱14 DU + ₱8 host + ₱7 platform + ₱0 flat). Caught via vault inspection before hardware arrived.
**Fix:** SQL UPDATE on tariff row `22222222-2222-2222-2222-222222222222`. Verified via SELECT.
**Prevention:** Always cross-check tariff seed against 00-VOLTSENSE-MASTER.md §4.1 before marking seed complete.

---

## LESSON-026: OCPP liveConnections Must Be Keyed by UUID, Not URL String
**Date:** 2026-07-05
**System:** VoltSense
**What Happened:** ocpp_ws.ts registered liveConnections using raw URL path segment (e.g. "VS-MAN-001"). sendRemoteStartTransaction looked up by UUID ("33333333-...") → always got undefined → charger always treated as offline.
**Fix:** On WebSocket connect, resolve the URL segment against chargePoints.serialNumber → get UUID, key liveConnections by UUID. fallback to raw segment if no match.
**Prevention:** Any Map that is written by one codepath and read by another must use the same key type. Document the key type in a comment on the Map declaration.

---

## Session Summary — 2026-07-05

**What was done:**
- Read Obsidian vault (VoltSense-Platform-Vault) — confirmed B26471 at Manila Port since June 30
- Confirmed vault tariff spec: ₱29/kWh total (₱14 DU + ₱8 host + ₱7 platform)
- Fixed 3 gaps via Cursor (commit 5d348f0):
  1. Tariff seed corrected to ₱29/kWh
  2. OCPP liveConnections keyed by UUID via serial number lookup
  3. PayMongo description now dynamic (uses site.name)
- Confirmed PayMongo dashboard: QRPh Active, GCash Submitted, Maya Submitted (day 5)

**Commits:** … → 7973b62 → 5d348f0

**Next session start:**
1. Call KPC — confirm B26471 warehouse arrival date (may have cleared customs already)
2. Build QR paywall page (HTML on Vercel) — deeplink → package select → POST /checkout → PayMongo redirect
3. Watch Gmail for GCash/Maya approval
4. On approval: swap to live PayMongo keys in Render
