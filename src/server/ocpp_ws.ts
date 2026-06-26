// VoltSense OCPP 1.6J WebSocket listener bootstrap.
//
// Binds the bench WebSocket port from ACTIVE_HARDWARE_CONFIG (default 8080) and
// dispatches inbound connections on the hardware test-state discriminated union
// (mock_harness vs physical_hardware) via the config's own type guards.
//
// Security boundary (Law §10):
//   - §10.1 routing: physical_hardware mode is port-locked to 8080
//     (assertPhysicalHardwarePortLock, asserted at boot).
//   - §10.3 handshake auth: in physical_hardware mode the WebSocket upgrade is
//     intercepted by `verifyClient`, which extracts the Authorization header +
//     `ocpp1.6` subprotocol and runs them through validateHandshakeCredentials
//     (OCPP Security Profile 1). Any handshake that fails is rejected with 401.
//     mock_harness is local bench only — left open (no charger, no exposure).
//
// Laws honored:
//   - No 'any'. Inbound frames cross the trust boundary as 'unknown' and are only
//     used after explicit narrowing.
//   - Node has no native WebSocket *server*; we use the project's existing `ws`
//     dependency (the global `WebSocket` is a client-only, experimental API).

import type { IncomingMessage } from 'node:http';

import {
  WebSocketServer,
  WebSocket,
  type RawData,
  type VerifyClientCallbackAsync,
} from 'ws';

import {
  ACTIVE_HARDWARE_CONFIG,
  assertPhysicalHardwarePortLock,
  isMockHarnessState,
  isPhysicalHardwareState,
  type HardwareTestState,
  type OcppHardwareConfig,
} from '../protocols/ocpp/hardware_config.js';
import {
  OCPP_SECURITY_PROFILE_ID,
  validateHandshakeCredentials,
  type OcppHandshakeCredentials,
} from '../protocols/ocpp/security_profiles.js';

// OCPP 1.6 subprotocol token offered on the `Sec-WebSocket-Protocol` header.
const OCPP_SUBPROTOCOL = 'ocpp1.6' as const;

// ─── Bench-mode description (exhaustive over the union) ──────────────────────

function describeBenchMode(state: HardwareTestState): string {
  if (isMockHarnessState(state)) {
    return `mock_harness → simulated charger ${state.simulatedChargerId}`;
  }
  if (isPhysicalHardwareState(state)) {
    return `physical_hardware → ${state.activeChargerId} (fw ${state.firmwareVersion})`;
  }
  // Exhaustiveness weld: the union has exactly two arms. Adding a third without
  // updating this dispatch fails to compile here.
  const unreachable: never = state;
  return unreachable;
}

// ─── Handshake credential extraction (HTTP headers → typed creds) ─────────────

// Parse an `Authorization: Basic <base64(user:pass)>` header into its parts.
// Returns null for any malformed/absent header — never throws, never widens.
function parseBasicAuthorization(
  header: string | undefined,
): { readonly username: string; readonly password: string } | null {
  if (header === undefined) {
    return null;
  }

  const [scheme, encoded] = header.split(' ');
  if (scheme?.toLowerCase() !== 'basic' || encoded === undefined || encoded.length === 0) {
    return null;
  }

  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) {
    return null;
  }

  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

// The `Sec-WebSocket-Protocol` header may be a single string or a string list.
function offersOcppSubprotocol(raw: string | string[] | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  const offered = Array.isArray(raw) ? raw : raw.split(',');
  return offered.some((value) => value.trim() === OCPP_SUBPROTOCOL);
}

// Authorize a physical-hardware upgrade: require the ocpp1.6 subprotocol and a
// Profile-1 Basic credential that survives validateHandshakeCredentials.
function authorizePhysicalHandshake(req: IncomingMessage): boolean {
  if (!offersOcppSubprotocol(req.headers['sec-websocket-protocol'])) {
    return false;
  }

  const basic = parseBasicAuthorization(req.headers.authorization);
  if (basic === null) {
    return false;
  }

  const credentials: OcppHandshakeCredentials = {
    profile: OCPP_SECURITY_PROFILE_ID.PROFILE_1,
    username: basic.username,
    password: basic.password,
  };

  try {
    validateHandshakeCredentials(credentials);
    return true;
  } catch {
    // Structural validation failed (empty username/password) — deny.
    return false;
  }
}

// ─── Frame boundary — RawData in, 'unknown' out ──────────────────────────────

function decodeFrame(data: RawData): unknown {
  const text = Array.isArray(data)
    ? Buffer.concat(data).toString('utf8')
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString('utf8')
      : data.toString('utf8');

  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Malformed/non-JSON frame: stays opaque, never coerced.
    return undefined;
  }
}

// ─── Inbound dispatch keyed on the hardware test-state union ──────────────────

function handleInboundFrame(
  socket: WebSocket,
  state: HardwareTestState,
  frame: unknown,
): void {
  if (isMockHarnessState(state)) {
    socket.send(
      JSON.stringify({
        ack: 'mock_harness',
        charger: state.simulatedChargerId,
        decoded: frame !== undefined,
      }),
    );
    return;
  }

  if (isPhysicalHardwareState(state)) {
    socket.send(
      JSON.stringify({
        ack: 'physical_hardware',
        charger: state.activeChargerId,
        firmware: state.firmwareVersion,
        decoded: frame !== undefined,
      }),
    );
    return;
  }

  const unreachable: never = state;
  throw new Error(`[voltsense:ocpp] unhandled hardware state: ${String(unreachable)}`);
}

// ─── Listener handle ─────────────────────────────────────────────────────────

export type OcppWsListener = {
  readonly server: WebSocketServer;
  close(): Promise<void>;
};

export async function startOcppWsListener(
  config: OcppHardwareConfig = ACTIVE_HARDWARE_CONFIG,
): Promise<OcppWsListener> {
  // §10.1 routing invariant — a live BESEN station may only bind port 8080.
  assertPhysicalHardwarePortLock(config);

  // §10.3 handshake interceptor — enforce Security Profile auth before the
  // upgrade completes when a physical charger is on the wire. Closes over the
  // active test state so mode is resolved per-connection at handshake time.
  const verifyClient: VerifyClientCallbackAsync = (info, callback) => {
    if (isMockHarnessState(config.testState)) {
      callback(true);
      return;
    }
    if (authorizePhysicalHandshake(info.req)) {
      callback(true);
      return;
    }
    callback(false, 401, 'Unauthorized');
  };

  const wss = new WebSocketServer({ port: config.wsPort, verifyClient });

  // Resolve only once the socket is actually bound; reject on bind failure
  // (e.g. EADDRINUSE) so callers can surface a real startup error.
  await new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      wss.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      wss.off('listening', onListening);
      reject(error);
    };
    wss.once('listening', onListening);
    wss.once('error', onError);
  });

  console.log(
    `[voltsense:ocpp] WebSocket listener bound on port ${config.wsPort} — bench mode: ${describeBenchMode(
      config.testState,
    )}`,
  );

  wss.on('connection', (socket: WebSocket, request) => {
    const peer = request.socket.remoteAddress ?? 'unknown';
    console.log(`[voltsense:ocpp] charge point connected from ${peer}`);

    socket.on('message', (data: RawData) => {
      const frame: unknown = decodeFrame(data);
      handleInboundFrame(socket, config.testState, frame);
    });

    socket.on('error', (error: Error) => {
      console.error(`[voltsense:ocpp] socket error from ${peer}: ${error.message}`);
    });
  });

  return {
    server: wss,
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        wss.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
