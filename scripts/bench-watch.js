#!/usr/bin/env node
// VoltSense Bench Test — run: node scripts/bench-watch.js

const SERVER = 'https://voltsense-pmfq.onrender.com';
const POLL_MS = 4000;
const AUTH_USER = process.env.OCPP_AUTH_USER || '(set OCPP_AUTH_USER env var)';
const AUTH_PASSWORD = process.env.OCPP_AUTH_PASSWORD || '(set OCPP_AUTH_PASSWORD env var)';

function line(c = '─', n = 52) { return c.repeat(n); }

async function preflight() {
  console.log('\n' + line('═'));
  console.log('  VoltSense — B26471 Bench Test');
  console.log(line('═'));

  console.log('\n[1/2] Checking Render server...');
  try {
    const r = await fetch(SERVER + '/health');
    const d = await r.json();
    if (d.status !== 'ok') throw new Error('bad health');
    console.log('      ✅ Server is UP.');
  } catch (e) {
    console.log('      ❌ Server not responding: ' + e.message);
    console.log('      Check dashboard.render.com → srv-d93u62ho3t8c739rdavg');
    process.exit(1);
  }

  console.log('\n[2/2] Checking OCPP status endpoint...');
  try {
    const r = await fetch(SERVER + '/ocpp/status');
    const d = await r.json();
    if (typeof d.connected !== 'boolean') throw new Error('bad response');
    console.log('      ✅ OCPP endpoint ready.');
    if (d.connected) {
      console.log('      ⚠️  Already connected: ' + d.chargePoints.join(', '));
    }
  } catch (e) {
    console.log('      ❌ OCPP endpoint failed: ' + e.message);
    process.exit(1);
  }

  console.log('\n' + line());
  console.log('  NOW DO THIS ON YOUR PHONE:');
  console.log(line());
  console.log('');
  console.log('  Step 1: Power on the B26471. Wait for screen to light up.');
  console.log('');
  console.log('  Step 2: Connect your phone WiFi to the charger hotspot.');
  console.log('          (The charger broadcasts its own WiFi when powered on)');
  console.log('');
  console.log('  Step 3: Open OCPPSetTool → tap "Select Device" → tap charger.');
  console.log('');
  console.log('  Step 4: Set URL — pick WSS (not WS), then enter:');
  console.log('');
  console.log('          wss://voltsense-pmfq.onrender.com/ocpp/' + AUTH_USER);
  console.log('');
  console.log('  Step 5: ChargerID field → enter:  ' + AUTH_USER);
  console.log('');
  console.log('  Step 6: If asked for credentials / Basic Auth:');
  console.log('          Username:  ' + AUTH_USER);
  console.log('          Password:  ' + AUTH_PASSWORD);
  console.log('');
  console.log('  Step 7: Tap Save / Apply. Charger restarts briefly.');
  console.log('');
  console.log(line());
  console.log('  Watching for connection — dots = polling, x = network error');
  console.log(line() + '\n');
}

async function poll() {
  try {
    const r = await fetch(SERVER + '/ocpp/status');
    if (!r.ok) { process.stdout.write('x'); }
    else {
      const d = await r.json();
      if (d.connected) {
        console.log('\n\n' + line('═'));
        console.log('  ✅  CHARGER CONNECTED!');
        console.log('  ID: ' + d.chargePoints.join(', '));
        console.log('  BootNotification received by server.');
        console.log('\n⚡ CRITICAL STEP — Set MeterValueSampleInterval');
        console.log('   In OCPPSetTool → Change Configuration');
        console.log('   Key:   MeterValueSampleInterval');
        console.log('   Value: 60');
        console.log('   Confirm charger responds: Accepted');
        console.log('   WARNING: Without this, kWh package cutoff will NEVER fire.\n');
        console.log('  BENCH TEST PASSED — ready for Go Hotels.');
        console.log(line('═'));
        process.exit(0);
      } else { process.stdout.write('.'); }
    }
  } catch { process.stdout.write('x'); }
  setTimeout(poll, POLL_MS);
}

preflight().then(() => poll());
