#!/usr/bin/env node
// VoltSense CSMS — BYD Bench Test (gate-based)
// Run: node scripts/byd-bench-test.js
// Dry run (no real API calls, just walks the gates): node scripts/byd-bench-test.js --dry-run
//
// Zero npm installs — Node 18+ built-ins only (global fetch, node:readline/promises).
// Requires VOLTSENSE_SHIELD_USER / VOLTSENSE_SHIELD_PASSWORD in .env for the
// /admin/* Basic Auth shield (see src/server/basic_auth.ts).
//
// Note on GATE G: the real terminal session status in this codebase is
// 'completed' — there is no 'settled' value in session_status
// (see src/db/schema.ts sessionStatusEnum). This script polls for 'completed'.

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const DRY_RUN = process.argv.includes('--dry-run');

const BASE = 'https://voltsense-pmfq.onrender.com';
const CHARGE_POINT_ID = '33333333-3333-3333-3333-333333333333';
const CONNECTOR_ID = 1;
const ID_TAG = 'byd-bench-001';

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

if (!DRY_RUN) {
  if (SHIELD_USER === undefined || SHIELD_USER.length === 0 ||
      SHIELD_PASSWORD === undefined || SHIELD_PASSWORD.length === 0) {
    console.log(red(bold('❌ GATE FAILED')));
    console.log(red('VOLTSENSE_SHIELD_USER / VOLTSENSE_SHIELD_PASSWORD not set — check .env'));
    process.exit(1);
  }
}

const ADMIN_AUTH_HEADER =
  DRY_RUN ? '' : 'Basic ' + Buffer.from(`${SHIELD_USER}:${SHIELD_PASSWORD}`).toString('base64');

const rl = DRY_RUN ? null : createInterface({ input: stdin, output: stdout });
async function pressEnter(promptText) {
  if (DRY_RUN) {
    console.log(yellow(promptText) + yellow(' [dry-run: auto-continuing]'));
    return;
  }
  await rl.question(yellow(promptText + ' '));
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
function adminGet(path) {
  return request(path, { headers: { Authorization: ADMIN_AUTH_HEADER } });
}

// ─── Gate bookkeeping ───────────────────────────────────────────────────────────

const gateResults = [];
const runStartedAt = Date.now();

function gatePass(id, name, detail) {
  gateResults.push({ id, name, pass: true, at: new Date().toISOString(), detail });
  console.log(green(`\n  ✅ GATE ${id} PASS — ${name}${detail ? ` (${detail})` : ''}`));
}

function gateFail(id, name, message) {
  gateResults.push({ id, name, pass: false, at: new Date().toISOString(), detail: message });
  console.log('\n' + red(bold(`❌ GATE ${id} FAILED — ${name}`)));
  console.log(red(message));
  printReport();
  if (rl) rl.close();
  process.exit(1);
}

function gateHeader(id, name) {
  console.log('\n' + bold(cyan(line('═'))));
  console.log(bold(cyan(`  GATE ${id}: ${name}`)));
  console.log(bold(cyan(line('═'))));
}

function printReport() {
  const totalMs = Date.now() - runStartedAt;
  console.log('\n' + bold(line('─')));
  console.log(bold('  BENCH TEST REPORT'));
  console.log(bold(line('─')));
  for (const g of gateResults) {
    const tag = g.pass ? green('GREEN') : red('RED  ');
    console.log(`  [${tag}] GATE ${g.id} — ${g.name}  (${g.at})`);
  }
  console.log(`  Total duration: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(bold(line('─')) + '\n');
}

// ─── GATE A — health ────────────────────────────────────────────────────────────

async function gateA() {
  gateHeader('A', 'Backend health check');
  if (DRY_RUN) {
    console.log('  [dry-run] would retry GET /health every 5s up to 60s');
    return gatePass('A', 'Backend health check', 'dry-run');
  }

  const deadline = Date.now() + 60_000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const { res, body } = await request('/health');
      if (res.ok && body?.status === 'ok') {
        return gatePass('A', 'Backend health check');
      }
      lastErr = `HTTP ${res.status} ${JSON.stringify(body)}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    stdout.write('.');
    await sleep(5000);
  }
  gateFail('A', 'Backend health check', `Timed out after 60s. Last error: ${lastErr}`);
}

// ─── GATE B — BESEN powered on, charge point appears ───────────────────────────

async function gateB() {
  gateHeader('B', 'BESEN unit powered on');
  await pressEnter('  Power on BESEN. ENTER when LED is on.');
  if (DRY_RUN) {
    console.log('  [dry-run] would poll GET /ocpp/status every 3s up to 3min for chargePoint to appear');
    return gatePass('B', 'BESEN unit powered on', 'dry-run');
  }

  const deadline = Date.now() + 180_000;
  let lastBody = null;
  while (Date.now() < deadline) {
    const { res, body } = await request('/ocpp/status');
    lastBody = body;
    if (res.ok && Array.isArray(body?.chargePoints) && body.chargePoints.length > 0) {
      return gatePass('B', 'BESEN unit powered on', `${body.chargePoints.length} charge point(s) visible`);
    }
    stdout.write('.');
    await sleep(3000);
  }
  gateFail('B', 'BESEN unit powered on', `Timed out after 3min.\nLast /ocpp/status: ${JSON.stringify(lastBody)}`);
}

// ─── GATE C — OCPPSetTool configured, OPERATIONAL ──────────────────────────────

async function gateC() {
  gateHeader('C', 'OCPP connection OPERATIONAL');
  await pressEnter('  Configure OCPPSetTool (URL, creds). ENTER when done.');
  if (DRY_RUN) {
    console.log('  [dry-run] would poll GET /ocpp/status until ocppState = OPERATIONAL');
    return gatePass('C', 'OCPP connection OPERATIONAL', 'dry-run');
  }

  const deadline = Date.now() + 180_000;
  let lastBody = null;
  while (Date.now() < deadline) {
    const { res, body } = await request('/ocpp/status');
    lastBody = body;
    if (res.ok) {
      const operational = (body.chargePoints ?? []).some((cp) => cp.ocppState === 'OPERATIONAL');
      if (operational) {
        return gatePass('C', 'OCPP connection OPERATIONAL');
      }
    }
    stdout.write('.');
    await sleep(3000);
  }
  gateFail('C', 'OCPP connection OPERATIONAL', `Timed out after 3min.\nLast /ocpp/status: ${JSON.stringify(lastBody)}`);
}

// ─── GATE D — cable plugged in ──────────────────────────────────────────────────

async function gateD() {
  gateHeader('D', 'Cable plugged into BYD car');
  await pressEnter('  Plug cable into BYD car NOW. ENTER when plugged in.');
  return gatePass('D', 'Cable plugged into BYD car');
}

// ─── GATE E — checkout + payment ───────────────────────────────────────────────

async function gateE() {
  gateHeader('E', 'Checkout + payment');
  if (DRY_RUN) {
    console.log('  [dry-run] would POST /checkout and print checkoutUrl');
    console.log('  [dry-run] would prompt: Pay on your phone with test 4343 4343 4343 4345 / 12/28 / 123.');
    return { pass: gatePass('E', 'Checkout + payment', 'dry-run'), sessionId: 'dry-run-session-id' };
  }

  const { res, body } = await request('/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chargePointId: CHARGE_POINT_ID,
      connectorId: CONNECTOR_ID,
      packageId: 'PKG_5KWH',
      idTag: ID_TAG,
    }),
  });
  if (!res.ok || !body?.sessionId || !body?.checkoutUrl) {
    gateFail('E', 'Checkout + payment', `POST /checkout → HTTP ${res.status}\n${JSON.stringify(body, null, 2)}`);
  }

  console.log(`\n  checkoutUrl: ${cyan(body.checkoutUrl)}`);
  await pressEnter('  Pay on your phone with test card 4343 4343 4343 4345 | Exp: 12/28 | CVV: 123. ENTER when payment complete.');

  gatePass('E', 'Checkout + payment', `sessionId=${body.sessionId}`);
  return body.sessionId;
}

// ─── GATE F — payment cleared / charging ───────────────────────────────────────

async function gateF(sessionId) {
  gateHeader('F', 'Session charging');
  if (DRY_RUN) {
    console.log('  [dry-run] would poll GET /admin/sessions?status=all every 5s up to 90s for status=charging');
    return gatePass('F', 'Session charging', 'dry-run');
  }

  const deadline = Date.now() + 90_000;
  let lastBody = null;
  while (Date.now() < deadline) {
    const { res, body } = await adminGet('/admin/sessions?status=all');
    lastBody = body;
    if (res.ok) {
      const found = (body.sessions ?? []).find((s) => s.sessionId === sessionId);
      if (found?.status === 'charging') {
        return gatePass('F', 'Session charging', `sessionId=${sessionId}`);
      }
    }
    stdout.write('.');
    await sleep(5000);
  }
  gateFail('F', 'Session charging', `Timed out after 90s waiting for status=charging.\nLast /admin/sessions?status=all: ${JSON.stringify(lastBody, null, 2)}`);
}

// ─── GATE G — unplug + settle ───────────────────────────────────────────────────
// Real terminal status is 'completed' (session_status enum, src/db/schema.ts) —
// there is no 'settled' value.

async function gateG(sessionId) {
  gateHeader('G', 'Unplug + settlement');
  await pressEnter('  Unplug cable when ready. ENTER when done.');
  if (DRY_RUN) {
    console.log('  [dry-run] would poll GET /admin/sessions?status=all every 10s up to 10min for status=completed');
    return gatePass('G', 'Unplug + settlement', 'dry-run');
  }

  const deadline = Date.now() + 600_000;
  let lastBody = null;
  while (Date.now() < deadline) {
    const { res, body } = await adminGet('/admin/sessions?status=all');
    lastBody = body;
    if (res.ok) {
      const found = (body.sessions ?? []).find((s) => s.sessionId === sessionId);
      if (found?.status === 'completed') {
        console.log('\n  ' + bold('Session record:'));
        console.log(`    sessionId:        ${found.sessionId}`);
        console.log(`    status:           ${found.status}`);
        console.log(`    kwhDelivered:     ${found.kwhDelivered}`);
        console.log(`    energyChargePhp:  ${found.energyChargePhp}`);
        console.log(`    hostSharePhp:     ${found.hostSharePhp}`);
        console.log(`    platformSharePhp: ${found.platformSharePhp}`);
        console.log(`    pspFeePhp:        ${found.pspFeePhp}`);
        return gatePass('G', 'Unplug + settlement', `status=completed`);
      }
    }
    stdout.write('.');
    await sleep(10_000);
  }
  gateFail('G', 'Unplug + settlement', `Timed out after 10min waiting for status=completed.\nLast /admin/sessions?status=all: ${JSON.stringify(lastBody, null, 2)}`);
}

// ─── GATE H — cleanup ────────────────────────────────────────────────────────────

async function gateH(sessionId) {
  gateHeader('H', 'Cleanup (expire test session)');
  if (DRY_RUN) {
    console.log('  [dry-run] would POST /admin/expire-session for the test session');
    return gatePass('H', 'Cleanup (expire test session)', 'dry-run');
  }

  const { res, body } = await request('/admin/expire-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ADMIN_AUTH_HEADER },
    body: JSON.stringify({ sessionId }),
  });
  // A completed session has no effect on checkout availability, so a 404
  // session_not_found here (already completed, nothing to expire) is fine —
  // it's only a hard failure if the route itself is missing or errors.
  if (res.status === 404 && body?.error === 'not_found') {
    gateFail('H', 'Cleanup (expire test session)', 'POST /admin/expire-session route missing on the live server.');
  }
  if (!res.ok && !(res.status === 404 && body?.error === 'session_not_found')) {
    gateFail('H', 'Cleanup (expire test session)', `POST /admin/expire-session → HTTP ${res.status}\n${JSON.stringify(body, null, 2)}`);
  }
  gatePass('H', 'Cleanup (expire test session)');
}

// ─── MAIN ────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(bold(`\nVoltSense CSMS — BYD Bench Test${DRY_RUN ? ' (DRY RUN)' : ''}`));
  console.log(`Target: ${BASE}`);

  await gateA();
  await gateB();
  await gateC();
  await gateD();
  const sessionId = await gateE();
  await gateF(sessionId);
  await gateG(sessionId);
  await gateH(sessionId);

  printReport();
  console.log(bold(green('  ALL GATES GREEN — BENCH TEST COMPLETE\n')));

  if (rl) rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.log('\n' + red(bold('❌ GATE FAILED')));
  console.log(red(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  printReport();
  if (rl) rl.close();
  process.exit(1);
});
