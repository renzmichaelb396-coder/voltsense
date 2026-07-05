// Process entrypoint — boots the VoltSense HTTP server with shield credentials from env,
// alongside the OCPP 1.6J WebSocket listener sharing the same port via http.Server upgrade.

import { loadDbFromEnv } from '../db/client.js';
import { startHttpServerFromEnv } from './http.js';
import { startOcppWsListener } from './ocpp_ws.js';
import { ACTIVE_HARDWARE_CONFIG } from '../protocols/ocpp/hardware_config.js';

const db = loadDbFromEnv();
const server = startHttpServerFromEnv(db);

server.on('listening', () => {
  const address = server.address();
  if (address !== null && typeof address === 'object') {
    console.log(`[voltsense] HTTP server listening on ${address.address}:${address.port}`);
    console.log('[voltsense] GET / is public; /webhooks/* bypass Basic Auth; admin/dev are shielded');
  }
});

server.on('error', (error: Error) => {
  console.error('[voltsense] HTTP server failed to start:', error.message);
  process.exitCode = 1;
});

startOcppWsListener(db, ACTIVE_HARDWARE_CONFIG, server)
  .then(() => {
    console.log('[voltsense:ocpp] WebSocket listener active — sharing HTTP server port');
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown_error';
    console.error(`[voltsense:ocpp] WebSocket listener failed to start: ${message}`);
    process.exitCode = 1;
  });
