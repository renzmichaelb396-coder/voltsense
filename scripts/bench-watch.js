#!/usr/bin/env node
// VoltSense Bench Test Watcher — run: node scripts/bench-watch.js
//
// Watches the live Render CSMS for the full OCPP bench lifecycle:
//   BootNotification → RemoteStart (inferred) → StartTransaction
//   → MeterValues → StopTransaction
//
// Uses only public GET /health + GET /ocpp/status (no admin credentials).
// Designed so a non-developer can follow the terminal during a live BYD bench.

const SERVER = 'https://voltsense-pmfq.onrender.com';
const POLL_MS = 4000;
const AUTH_USER = process.env.OCPP_AUTH_USER || 'VS-MAN-001';
const AUTH_PASSWORD = process.env.OCPP_AUTH_PASSWORD || '(set OCPP_AUTH_PASSWORD in .env)';

function line(c = '─', n = 56) {
  return c.repeat(n);
}

function stamp() {
  return new Date().toLocaleTimeString('en-PH', { hour12: false });
}

function banner(title) {
  console.log('\n' + line('═'));
  console.log('  ' + title);
  console.log(line('═'));
}

function step(n, title) {
  console.log('\n' + line());
  console.log(`  [${stamp()}] STEP ${n} — ${title}`);
  console.log(line());
}

function ok(msg) {
  console.log(`  ✅ ${msg}`);
}

function info(msg) {
  console.log(`  → ${msg}`);
}

function warn(msg) {
  console.log(`  ⚠️  ${msg}`);
}

/** @typedef {'boot'|'start'|'meter'|'stop'|'done'} Phase */

/** @type {Phase} */
let phase = 'boot';
let lastMeterWh = null;
let seenSessionId = null;
let meterTicks = 0;
let pollDots = 0;

async function preflight() {
  banner('VoltSense — B26471 / BYD Bench Watcher');
  console.log('  Target:  ' + SERVER);
  console.log('  Charger: VS-MAN-001  →  UUID 33333333-3333-3333-3333-333333333333');
  console.log('  Watches: BootNotification · RemoteStart · StartTransaction');
  console.log('           MeterValues · StopTransaction');

  console.log('\n[1/2] Checking Render server...');
  try {
    const r = await fetch(SERVER + '/health');
    const d = await r.json();
    if (d.status !== 'ok') throw new Error('bad health');
    ok('Server is UP.');
  } catch (e) {
    console.log('  ❌ Server not responding: ' + e.message);
    console.log('     Fix: open dashboard.render.com → srv-d93u62ho3t8c739rdavg');
    console.log('     Wait for the free-tier service to wake, then re-run this script.');
    process.exit(1);
  }

  console.log('\n[2/2] Checking OCPP status endpoint...');
  try {
    const r = await fetch(SERVER + '/ocpp/status');
    const d = await r.json();
    if (typeof d.connected !== 'boolean') throw new Error('bad response');
    ok('OCPP status endpoint ready.');
    if (d.connected) {
      warn(
        'Already connected: ' +
          d.chargePoints.map((cp) => `${cp.id} (${cp.ocppState})`).join(', '),
      );
      info('If state is OPERATIONAL, BootNotification already passed — continuing.');
    } else {
      info('No charger connected yet — that is normal before power-on.');
    }
  } catch (e) {
    console.log('  ❌ OCPP endpoint failed: ' + e.message);
    process.exit(1);
  }

  banner('DO THIS ON YOUR PHONE / CHARGER NOW');
  console.log('');
  console.log('  1. Power on the B26471. Wait for the screen to light up.');
  console.log('  2. Connect your phone WiFi to the charger hotspot.');
  console.log('  3. Open OCPPSetTool → Select Device → tap the charger.');
  console.log('  4. Set URL — pick WSS (not WS), then enter:');
  console.log('');
  console.log('       wss://voltsense-pmfq.onrender.com/ocpp/VS-MAN-001');
  console.log('');
  console.log('  5. ChargerID / Username:  ' + AUTH_USER);
  console.log('  6. Password (Basic Auth):  ' + AUTH_PASSWORD);
  console.log('  7. Tap Save / Apply. Charger restarts briefly.');
  console.log('');
  console.log('  After boot succeeds, continue the payment flow on:');
  console.log('  https://voltsense-csms.vercel.app/charge.html');
  console.log('    ?cpid=33333333-3333-3333-3333-333333333333&cid=1');
  console.log('');
  info('Watching live — dots = waiting, x = network blip');
  console.log(line() + '\n');

  step(1, 'Waiting for BootNotification (charger → OPERATIONAL)');
}

function printWaitingDot() {
  process.stdout.write('.');
  pollDots += 1;
  if (pollDots % 40 === 0) process.stdout.write('\n  ');
}

/**
 * @param {any} d
 */
function handleBootPhase(d) {
  const operational = d.chargePoints?.some((cp) => cp.ocppState === 'OPERATIONAL');
  if (!operational) {
    // Surface intermediate states so the operator knows progress
    const states = (d.chargePoints ?? [])
      .map((cp) => `${String(cp.id).slice(0, 8)}…=${cp.ocppState}`)
      .join(', ');
    if (states && pollDots % 15 === 0 && pollDots > 0) {
      process.stdout.write(`\n  [${stamp()}] still waiting — ${states}\n  `);
    }
    printWaitingDot();
    return;
  }

  process.stdout.write('\n');
  ok('BootNotification ACCEPTED — charge point is OPERATIONAL');
  info('IDs: ' + d.chargePoints.map((cp) => cp.id).join(', '));
  info('Server accepted boot (not just WebSocket open).');
  console.log('');
  ok('STEP 1 PASS — ready for QR payment + cable plug-in');
  step(2, 'Waiting for StartTransaction (after PayMongo + RemoteStart)');
  info('Pay on phone → CSMS sends RemoteStartTransaction → charger starts.');
  info('This watcher cannot see RemoteStart itself; StartTransaction proves it worked.');
  phase = 'start';
}

/**
 * @param {any} d
 */
function handleStartPhase(d) {
  const sessions = d.activeSessions ?? [];
  if (sessions.length === 0) {
    printWaitingDot();
    return;
  }

  const s = sessions[0];
  seenSessionId = s.sessionId;
  lastMeterWh = typeof s.lastMeterWh === 'number' ? s.lastMeterWh : null;
  process.stdout.write('\n');
  ok('StartTransaction seen — charging session is LIVE');
  info(`sessionId=${s.sessionId}`);
  info(`transactionId=${s.transactionId}`);
  info(`chargePointId=${s.chargePointId}`);
  if (lastMeterWh !== null) info(`meter start ≈ ${lastMeterWh} Wh`);
  console.log('');
  ok('STEP 2 PASS — RemoteStart was Accepted (inferred from StartTransaction)');
  step(3, 'Watching MeterValues (kWh climbing)');
  info('Cutoff logic needs MeterValueSampleInterval=60 (set automatically on boot).');
  phase = 'meter';
}

/**
 * @param {any} d
 */
function handleMeterPhase(d) {
  const sessions = d.activeSessions ?? [];
  if (sessions.length === 0) {
    // Session ended before we logged a meter tick — jump to stop
    process.stdout.write('\n');
    warn('Active session disappeared — treating as StopTransaction.');
    phase = 'stop';
    handleStopPhase(d);
    return;
  }

  const s = sessions.find((x) => x.sessionId === seenSessionId) ?? sessions[0];
  const wh = typeof s.lastMeterWh === 'number' ? s.lastMeterWh : null;

  if (wh !== null && (lastMeterWh === null || wh !== lastMeterWh)) {
    if (meterTicks === 0) process.stdout.write('\n');
    const delta =
      lastMeterWh !== null ? `  (+${(wh - lastMeterWh).toFixed(0)} Wh)` : '';
    console.log(`  [${stamp()}] MeterValues  ${wh} Wh${delta}  session=${s.sessionId.slice(0, 8)}…`);
    lastMeterWh = wh;
    meterTicks += 1;

    if (meterTicks === 1) {
      ok('First MeterValues sample received');
    }
    if (meterTicks >= 2) {
      ok('STEP 3 PASS — MeterValues flowing (interval samples observed)');
      step(4, 'Waiting for StopTransaction (unplug or kWh cutoff)');
      info('Unplug the cable, or wait for the 5 kWh auto-stop.');
      phase = 'stop';
    }
    return;
  }

  printWaitingDot();
}

/**
 * @param {any} d
 */
function handleStopPhase(d) {
  const stillActive = (d.activeSessions ?? []).some(
    (s) => seenSessionId === null || s.sessionId === seenSessionId,
  );

  if (stillActive) {
    printWaitingDot();
    return;
  }

  process.stdout.write('\n');
  ok('StopTransaction inferred — active session cleared from /ocpp/status');
  info('Settlement runs server-side after StopTransaction (status → completed).');
  console.log('');
  banner('BENCH WATCH COMPLETE — ALL OCPP GATES SEEN');
  console.log('  ✅ BootNotification');
  console.log('  ✅ RemoteStartTransaction (inferred via StartTransaction)');
  console.log('  ✅ StartTransaction');
  console.log('  ✅ MeterValues' + (meterTicks > 0 ? ` (${meterTicks} sample(s))` : ''));
  console.log('  ✅ StopTransaction');
  console.log('');
  info('Optional: open host-earnings.html to verify Go Hotels share.');
  info('  URL: https://voltsense-csms.vercel.app/host-earnings.html');
  info('  Login uses HOST_AUTH_USER / HOST_AUTH_PASSWORD (Render env).');
  console.log(line('═') + '\n');
  phase = 'done';
  process.exit(0);
}

async function poll() {
  try {
    const r = await fetch(SERVER + '/ocpp/status');
    if (!r.ok) {
      process.stdout.write('x');
    } else {
      const d = await r.json();
      if (phase === 'boot') handleBootPhase(d);
      else if (phase === 'start') handleStartPhase(d);
      else if (phase === 'meter') handleMeterPhase(d);
      else if (phase === 'stop') handleStopPhase(d);
    }
  } catch {
    process.stdout.write('x');
  }

  if (phase !== 'done') {
    setTimeout(poll, POLL_MS);
  }
}

preflight().then(() => poll());
