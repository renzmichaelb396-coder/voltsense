#!/usr/bin/env node
const SERVER = 'https://voltsense-pmfq.onrender.com';
const POLL_MS = 3000;

async function poll() {
  try {
    const res = await fetch(`${SERVER}/ocpp/status`);
    const data = await res.json();
    if (data.connected) {
      console.log('\n✅ CHARGER CONNECTED!');
      console.log('   IDs: ' + data.chargePoints.join(', '));
      console.log('   BootNotification received. Pilot is live.');
      process.exit(0);
    } else {
      process.stdout.write('.');
    }
  } catch {
    process.stdout.write('x');
  }
  setTimeout(poll, POLL_MS);
}

console.log('Watching ' + SERVER + ' for charger connection...');
console.log('Power on the B26471 and set OCPPSetTool URL.');
console.log('Press Ctrl+C to stop.\n');
poll();
