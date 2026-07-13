#!/usr/bin/env node
// VoltSense CSMS — Physical Bench Test Runner (BYD / B26471)
// Run: node scripts/bench-test-runner.js
//
// Walks all 6 phases of the bench test. Between physical steps (charger power-on,
// phone tap-to-pay, cable unplug) it auto-verifies the system against the live
// Render backend so the operator never has to eyeball raw JSON.
//
// Requires VOLTSENSE_SHIELD_USER / VOLTSENSE_SHIELD_PASSWORD in .env (Basic Auth
// for the /admin/* surface — see src/server/basic_auth.ts).

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const BASE = 'https://voltsense-pmfq.onrender.com';
const CHARGE_POINT_ID = '33333333-3333-3333-3333-333333333333';
const CONNECTOR_ID = 1;
const PREFLIGHT_ID_TAG = 'preflight-test-001';

// Mirrors BLOCKING_SESSION_STATUSES in tests/chaos.test.ts — statuses that make
// handleCheckout (routes.ts) return 409 connector_not_available for this connector.
const BLOCKING_SESSION_STATUSES = new Set([
  'awaiting_payment',
  'payment_cleared',
  'charging',
  'paid_charger_offline',
  'authorized',
]);

const SHIELD_USER = process.env.VOLTSENSE_SHIELD_USER;
const SHIELD_PASSWORD = process.env.VOLTSENSE_SHIELD_PASSWORD;

const supportsColor = Boolean(stdout.isTTY);
function color(code, s) {
  return supportsColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const bold = (s) => color('1', s);
const green = (s) => color('32', s);
const red = (s) => color('31', s);
const yellow = (s) => color('33', s);
const cyan = (s) => color('36', s);

function line(c = '─', n = 60) {
  return c.repeat(n);
}

function phaseHeader(n, name) {
  console.log('\n' + bold(green(line('═'))));
  console.log(bold(green(`  PHASE ${n}: ${name}`)));
  console.log(bold(green(line('═'))));
}

function gateFail(message) {
  console.log('\n' + red(bold('❌ GATE FAILED')));
  console.log(red(message));
  process.exit(1);
}

if (SHIELD_USER === undefined || SHIELD_USER.length === 0 ||
    SHIELD_PASSWORD === undefined || SHIELD_PASSWORD.length === 0) {
  gateFail('VOLTSENSE_SHIELD_USER / VOLTSENSE_SHIELD_PASSWORD not set — check .env');
}

const ADMIN_AUTH_HEADER = 'Basic ' + Buffer.from(`${SHIELD_USER}:${SHIELD_PASSWORD}`).toString('base64');

const rl = createInterface({ input: stdin, output: stdout });
async function pressEnter(promptText) {
  await rl.question(yellow(promptText + ' '));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Thin fetch wrapper — always returns { res, body }, never throws on non-2xx.
async function request(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { res, body };
}

// One-shot call expected to succeed immediately — hard-fails on any non-2xx.
async function requireOk(path, opts, label) {
  const { res, body } = await request(path, opts);
  if (!res.ok) {
    gateFail(`${label} → HTTP ${res.status}\n${JSON.stringify(body, null, 2)}`);
  }
  return body;
}

function adminGet(path) {
  return request(path, { headers: { Authorization: ADMIN_AUTH_HEADER } });
}

// Returns { ok: true } | { ok: false, routeMissing: true } | { ok: false, res, body }
async function expireSession(sessionId) {
  const { res, body } = await request('/admin/expire-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ADMIN_AUTH_HEADER },
    body: JSON.stringify({ sessionId }),
  });
  if (res.status === 404 && body && body.error === 'not_found') {
    return { ok: false, routeMissing: true };
  }
  if (!res.ok) {
    return { ok: false, res, body };
  }
  return { ok: true };
}

function printExpireSessionMissingSql(sessionId) {
  console.log(yellow('\n  ⚠️  POST /admin/expire-session does not exist on the deployed server yet.'));
  console.log('  Run this SQL manually in Supabase to clean up:\n');
  console.log(cyan(
    `    UPDATE sessions SET status = 'expired', auth_expires_at = now() - interval '1 minute', ` +
    `updated_at = now() WHERE id = '${sessionId}';`,
  ));
}

// ─── PHASE 0 — PRE-FLIGHT ──────────────────────────────────────────────────────

async function phase0() {
  phaseHeader(0, 'PRE-FLIGHT (fully automated)');

  console.log('Checking GET /health...');
  const health = await requireOk('/health', {}, 'GET /health');
  if (health.status !== 'ok') {
    gateFail(`GET /health returned unexpected body: ${JSON.stringify(health)}`);
  }
  console.log(green('  ✓ /health → status: ok'));

  console.log('Checking GET /ocpp/status...');
  const { res: ocppRes, body: ocppBody } = await request('/ocpp/status');
  if (ocppRes.status >= 500) {
    gateFail(`GET /ocpp/status → HTTP ${ocppRes.status}\n${JSON.stringify(ocppBody, null, 2)}`);
  }
  if (typeof ocppBody !== 'object' || ocppBody === null || !Array.isArray(ocppBody.chargePoints)) {
    gateFail(`GET /ocpp/status returned an unexpected shape: ${JSON.stringify(ocppBody)}`);
  }
  console.log(green(`  ✓ /ocpp/status responded (${ocppBody.chargePoints.length} charge point(s) known — not connected yet is fine)`));

  console.log('Checking for stale sessions already blocking this connector...');
  const { res: preListRes, body: preListBody } = await adminGet('/admin/sessions?status=all');
  if (!preListRes.ok) {
    gateFail(`GET /admin/sessions?status=all → HTTP ${preListRes.status}\n${JSON.stringify(preListBody, null, 2)}`);
  }
  const blocking = (preListBody.sessions ?? []).filter(
    (s) =>
      s.chargePointId === CHARGE_POINT_ID &&
      s.connectorId === CONNECTOR_ID &&
      BLOCKING_SESSION_STATUSES.has(s.status),
  );
  if (blocking.length > 0) {
    console.log(yellow(`  Found ${blocking.length} stale blocking session(s) — expiring before checkout...`));
    for (const s of blocking) {
      const result = await expireSession(s.sessionId);
      if (result.routeMissing) {
        printExpireSessionMissingSql(s.sessionId);
        gateFail('POST /admin/expire-session route missing on the live server — run the SQL above for each stale session, then re-run this script.');
      }
      if (!result.ok) {
        gateFail(`POST /admin/expire-session (${s.sessionId}) → HTTP ${result.res.status}\n${JSON.stringify(result.body, null, 2)}`);
      }
      console.log(green(`    ✓ expired stale session ${s.sessionId} (was ${s.status})`));
    }
  } else {
    console.log(green('  ✓ connector is clear'));
  }

  console.log('Creating preflight checkout session (POST /checkout)...');
  const checkout = await requireOk('/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chargePointId: CHARGE_POINT_ID,
      connectorId: CONNECTOR_ID,
      packageId: 'PKG_5KWH',
      idTag: PREFLIGHT_ID_TAG,
    }),
  }, 'POST /checkout');
  if (!checkout.sessionId || !checkout.checkoutUrl) {
    gateFail(`POST /checkout response missing sessionId/checkoutUrl: ${JSON.stringify(checkout)}`);
  }
  console.log(green(`  ✓ checkout created — sessionId=${checkout.sessionId}`));

  console.log('Looking up the preflight session via GET /admin/sessions?status=all...');
  const { res: listRes, body: listBody } = await adminGet('/admin/sessions?status=all');
  if (!listRes.ok) {
    gateFail(`GET /admin/sessions?status=all → HTTP ${listRes.status}\n${JSON.stringify(listBody, null, 2)}`);
  }
  const match = (listBody.sessions ?? []).find(
    (s) => s.sessionId === checkout.sessionId || s.idTag === PREFLIGHT_ID_TAG,
  );
  if (match === undefined) {
    gateFail(
      `No session found for idTag=${PREFLIGHT_ID_TAG} / sessionId=${checkout.sessionId} in /admin/sessions?status=all.\n` +
      JSON.stringify(listBody, null, 2),
    );
  }
  console.log(green(`  ✓ found session id=${match.sessionId} status=${match.status}`));

  console.log('Expiring preflight session via POST /admin/expire-session...');
  const expireResult = await expireSession(match.sessionId);
  if (expireResult.routeMissing) {
    printExpireSessionMissingSql(match.sessionId);
    gateFail('POST /admin/expire-session route missing on the live server — run the SQL above, then re-run this script.');
  }
  if (!expireResult.ok) {
    gateFail(`POST /admin/expire-session → HTTP ${expireResult.res.status}\n${JSON.stringify(expireResult.body, null, 2)}`);
  }
  console.log(green(`  ✓ preflight session ${match.sessionId} expired`));

  console.log('\n' + bold(green('✅ PRE-FLIGHT CLEAN')));
}

// ─── PHASE 1 — CHARGER CONNECT ─────────────────────────────────────────────────

async function phase1() {
  phaseHeader(1, 'CHARGER CONNECT');

  console.log('  STEP 1: Power on the BESEN unit (plug into 220V)');
  console.log('  STEP 2: Open OCPPSetTool on iPhone, connect via Bluetooth');
  console.log('          URL:  wss://voltsense-pmfq.onrender.com/ocpp/VS-MAN-001');
  console.log('          User: VS-MAN-001 | Pass: voltsense-pilot');
  console.log('          Tap Set Basic → Save → Restart unit');
  await pressEnter('  Press ENTER when done.');

  console.log(`\n  Watching /ocpp/status for OPERATIONAL (up to 180s)...`);
  const deadline = Date.now() + 180_000;
  let lastBody = null;
  while (Date.now() < deadline) {
    const { res, body } = await request('/ocpp/status');
    lastBody = body;
    if (res.ok && Array.isArray(body?.chargePoints)) {
      const operational = body.chargePoints.some(
        (cp) => cp.ocppState === 'OPERATIONAL' || cp.ocppStatus === 'OPERATIONAL',
      );
      if (operational) {
        console.log('\n' + green('  ✅ CHARGER CONNECTED'));
        return;
      }
    }
    stdout.write('.');
    await sleep(5000);
  }

  console.log('\n');
  gateFail(
    `Timed out after 180s waiting for OPERATIONAL.\nLast GET /ocpp/status response:\n${JSON.stringify(lastBody, null, 2)}\n` +
    'Check OCPPSetTool config: URL, username/password, and that Save/Restart completed.',
  );
}

// ─── PHASE 2 — PAYMENT ─────────────────────────────────────────────────────────

async function phase2() {
  phaseHeader(2, 'PAYMENT');

  console.log('  STEP 3: Open this URL on YOUR phone (not Ana\'s):');
  console.log(`    https://voltsense-csms.vercel.app/charge.html?cpid=${CHARGE_POINT_ID}&cid=${CONNECTOR_ID}`);
  console.log('  STEP 4: Plug the cable into the BYD car BEFORE paying.');
  console.log('  STEP 5: Tap \'5 kWh — ₱145\'');
  console.log('          Test card: 4343 4343 4343 4345 | Exp: 12/28 | CVV: 123');
  await pressEnter('  Press ENTER when you\'ve submitted the payment.');

  console.log('\n  Watching /admin/sessions for payment_cleared / charging (up to 300s)...');
  const deadline = Date.now() + 300_000;
  let lastBody = null;
  while (Date.now() < deadline) {
    const { res, body } = await adminGet('/admin/sessions?status=all');
    lastBody = body;
    if (res.ok) {
      const found = (body.sessions ?? []).find(
        (s) =>
          s.status === 'payment_cleared' ||
          (s.status === 'charging' && s.idTag !== PREFLIGHT_ID_TAG),
      );
      if (found !== undefined) {
        console.log('\n' + green(`  ✅ PAYMENT RECEIVED — sessionId=${found.sessionId} status=${found.status}`));
        console.log(green('  RemoteStartTransaction should be firing.'));
        return found.sessionId;
      }
    }
    stdout.write('.');
    await sleep(3000);
  }

  console.log('\n');
  gateFail(
    `Timed out after 300s waiting for payment_cleared/charging.\nLast GET /admin/sessions?status=all response:\n${JSON.stringify(lastBody, null, 2)}`,
  );
}

// ─── PHASE 3 — CHARGING ACTIVE ─────────────────────────────────────────────────
// Note: /ocpp/status's chargePoints[].ocppState is the *socket* state
// (DISCONNECTED|WS_OPEN|BOOT_PENDING|BOOT_ACCEPTED|OPERATIONAL|BOOT_REJECTED|WS_CLOSE) —
// there is no "CHARGING" value there. The live signal that a transaction is actually
// running is an entry in /ocpp/status's activeSessions array for our sessionId.

async function phase3(sessionId) {
  phaseHeader(3, 'CHARGING ACTIVE');

  console.log('  Watching /ocpp/status.activeSessions for this session (up to 120s)...');
  const deadline = Date.now() + 120_000;
  let lastBody = null;
  while (Date.now() < deadline) {
    const { res, body } = await request('/ocpp/status');
    lastBody = body;
    if (res.ok) {
      const active = (body.activeSessions ?? []).some((s) => s.sessionId === sessionId);
      if (active) {
        console.log('\n' + green('  ✅ CHARGING ACTIVE — BYD car dashboard should show charging.'));
        console.log('\n  📸 SCREENSHOT 1: This terminal output');
        console.log('  📸 SCREENSHOT 2: https://voltsense-pmfq.onrender.com/ocpp/status');
        console.log('  📸 SCREENSHOT 3: Render logs (open dashboard.render.com)');
        await pressEnter('  Press ENTER when you\'ve taken all 3 screenshots.');
        return;
      }
    }
    stdout.write('.');
    await sleep(5000);
  }

  console.log('\n');
  gateFail(
    `Timed out after 120s waiting for an active session on /ocpp/status.\nLast response:\n${JSON.stringify(lastBody, null, 2)}`,
  );
}

// ─── PHASE 4 — STOP + SETTLE ───────────────────────────────────────────────────
// Note: the real terminal session status is 'completed' (session_status enum in
// src/db/schema.ts) — there is no 'settled' value.

async function phase4(sessionId) {
  phaseHeader(4, 'STOP + SETTLE');

  console.log('  STEP 6: Unplug the cable from the BYD car.');
  await pressEnter('  Press ENTER when done.');

  console.log('\n  Watching /admin/sessions for status=completed (up to 180s)...');
  const deadline = Date.now() + 180_000;
  let lastBody = null;
  while (Date.now() < deadline) {
    const { res, body } = await adminGet('/admin/sessions?status=all');
    lastBody = body;
    if (res.ok) {
      const settled = (body.sessions ?? []).find((s) => s.sessionId === sessionId && s.status === 'completed');
      if (settled !== undefined) {
        console.log('\n' + green('  ✅ BENCH TEST COMPLETE — Session settled.'));
        console.log('\n  ' + bold('Session record:'));
        console.log(`    sessionId:          ${settled.sessionId}`);
        console.log(`    status:             ${settled.status}`);
        console.log(`    kwhDelivered:       ${settled.kwhDelivered}`);
        console.log(`    energyChargePhp:    ${settled.energyChargePhp}`);
        console.log(`    hostSharePhp:       ${settled.hostSharePhp}`);
        console.log(`    platformSharePhp:   ${settled.platformSharePhp}`);
        console.log(`    pspFeePhp:          ${settled.pspFeePhp}`);
        console.log(`    startedAt:          ${settled.startedAt}`);
        console.log(`    stoppedAt:          ${settled.stoppedAt}`);
        console.log('\n  STEP 7: Run this SQL in Supabase to verify:');
        console.log(cyan(`    SELECT * FROM sessions WHERE id = '${settled.sessionId}';`));
        return;
      }
    }
    stdout.write('.');
    await sleep(5000);
  }

  console.log('\n');
  gateFail(
    `Timed out after 180s waiting for status=completed.\nLast GET /admin/sessions?status=all response:\n${JSON.stringify(lastBody, null, 2)}`,
  );
}

// ─── MAIN ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(bold('\nVoltSense CSMS — Bench Test Runner (BYD)'));
  console.log(`Target: ${BASE}`);

  await phase0();
  await phase1();
  const paymentSessionId = await phase2();
  await phase3(paymentSessionId);
  await phase4(paymentSessionId);

  console.log('\n' + bold(green(line('═'))));
  console.log(bold(green('  ALL 6 PHASES COMPLETE')));
  console.log(bold(green(line('═'))) + '\n');

  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.log('\n' + red(bold('❌ GATE FAILED')));
  console.log(red(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  rl.close();
  process.exit(1);
});
