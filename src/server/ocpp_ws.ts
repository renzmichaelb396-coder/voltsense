// VoltSense OCPP 1.6J WebSocket listener bootstrap.
//
// Binds the bench WebSocket port from ACTIVE_HARDWARE_CONFIG (default 8080).
// Each connection is identified by the last URL path segment (chargePointId)
// and gets its own real OcppConnection state machine — mock_harness vs
// physical_hardware (config.testState) only changes handshake auth, not
// protocol handling.
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

import type { IncomingMessage, Server as HttpServer } from 'node:http';

import { and, desc, eq } from 'drizzle-orm';
import {
  WebSocketServer,
  WebSocket,
  type RawData,
  type VerifyClientCallbackAsync,
} from 'ws';

import * as schema from '../db/schema.js';
import {
  ACTIVE_HARDWARE_CONFIG,
  assertPhysicalHardwarePortLock,
  isMockHarnessState,
  isPhysicalHardwareState,
  type HardwareTestState,
  type OcppHardwareConfig,
} from '../protocols/ocpp/hardware_config.js';
import {
  OcppConnection,
  type ChargePointRegistryLookup,
  type ChargePointRegistryStatus,
  type OcppSessionState,
} from '../protocols/ocpp/ocpp_connection.js';
import {
  OCPP_SECURITY_PROFILE_ID,
  validateHandshakeCredentials,
  type OcppHandshakeCredentials,
} from '../protocols/ocpp/security_profiles.js';
import type { RemoteStartTransactionReq } from '../protocols/ocpp/types.js';
import { dispatchRefund, loadRefundConfigFromEnv } from '../services/refund.js';
import type { SettlementDb } from '../services/settlement.js';

// OCPP 1.6 subprotocol token offered on the `Sec-WebSocket-Protocol` header.
const OCPP_SUBPROTOCOL = 'ocpp1.6' as const;

// TEMPORARY single-tenant pilot shim — BESEN firmware may connect to bare /ocpp
// (no serial-number path segment). Route to the one registered Mandaluyong pilot
// charger (VS-MAN-001 / 33333333-3333-3333-3333-333333333333). Remove before
// onboarding a second charger; bare-path routing is ambiguous with multiple CPs.
const PILOT_BARE_PATH_CHARGE_POINT_SERIAL = 'VS-MAN-001' as const;

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

// ─── Frame boundary — RawData in, text out ────────────────────────────────────
// OcppConnection.onRawFrame does its own JSON parsing/validation; the WS layer
// only needs to normalize the wire payload down to a UTF-8 string.

function rawDataToText(data: RawData): string {
  return Array.isArray(data)
    ? Buffer.concat(data).toString('utf8')
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString('utf8')
      : data.toString('utf8');
}

// ─── chargePointId extraction ─────────────────────────────────────────────────
// OCPP 1.6J convention: the charge point identity is the last path segment of
// the WebSocket URL, e.g. wss://host/ocpp/{chargePointId}.
// Pilot exception: bare /ocpp or /ocpp/ (no segment) falls back to
// PILOT_BARE_PATH_CHARGE_POINT_SERIAL — see constant above.

function isBareOcppPath(pathname: string): boolean {
  const normalized =
    pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
  return normalized === '/ocpp';
}

function isOcppUpgradePath(url: string): boolean {
  const pathname = new URL(url, 'http://internal').pathname;
  return isBareOcppPath(pathname) || pathname.startsWith('/ocpp/');
}

function extractChargePointId(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://internal');
  if (isBareOcppPath(url.pathname)) {
    return PILOT_BARE_PATH_CHARGE_POINT_SERIAL;
  }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  return last !== undefined && last.length > 0 ? decodeURIComponent(last) : null;
}

// ─── URL segment → charge point UUID resolution ───────────────────────────────
// OCPP chargers connect with their serialNumber as the URL path segment, but
// every downstream consumer (sessions.chargePointId, liveConnections lookups
// from sendRemoteStartTransaction) works in terms of the charge_points.id UUID.
// Resolve once at connection time so liveConnections is keyed by UUID
// consistently — falls back to the raw segment if it's already a UUID (or
// unrecognized; the registry lookup below will then report 'not_found').

async function resolveChargePointId(db: SettlementDb, urlSegment: string): Promise<string> {
  const rows = await db
    .select({ id: schema.chargePoints.id })
    .from(schema.chargePoints)
    .where(eq(schema.chargePoints.serialNumber, urlSegment))
    .limit(1);
  return rows[0]?.id ?? urlSegment;
}

// ─── DB-backed registry lookup ─────────────────────────────────────────────────
// §1.1.3 step 2 requires 'provisioned' to accept BootNotification. Resolved once
// per connection (not per-frame) since ChargePointRegistryLookup is synchronous.

async function lookupChargePointRegistryStatus(
  db: SettlementDb,
  chargePointId: string,
): Promise<ChargePointRegistryStatus> {
  const rows = await db
    .select({ status: schema.chargePoints.status })
    .from(schema.chargePoints)
    .where(eq(schema.chargePoints.id, chargePointId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return 'not_found';
  }
  if (row.status === 'decommissioned') {
    return 'decommissioned';
  }
  if (row.status === 'provisioned' || row.status === 'operational') {
    return 'provisioned';
  }
  return 'rejected';
}

// ─── Live connection registry ─────────────────────────────────────────────────
// chargePointId → its active OcppConnection, so CSMS-originated calls (e.g.
// RemoteStartTransaction) can reach the right socket.

const liveConnections: Map<string, OcppConnection> = new Map();

// Exposed for GET /ocpp/status — bench test visibility only.
// ocppState distinguishes a live WebSocket from an accepted BootNotification:
// a charger can hold a WS_OPEN connection without ever reaching OPERATIONAL.
export type ChargePointStatus = {
  readonly id: string;
  readonly ocppState: OcppSessionState;
};

export function getChargePointStatuses(): ChargePointStatus[] {
  return Array.from(liveConnections.entries()).map(([id, connection]) => ({
    id,
    ocppState: connection.getState(),
  }));
}

// Exposed for GET /ocpp/status — bench test visibility into in-progress
// sessions (kWh delivered so far) without tailing Render logs.
export type ActiveSessionSummary = {
  readonly chargePointId: string;
  readonly transactionId: number;
  readonly sessionId: string;
  readonly lastMeterWh: number;
};

export function getActiveSessionSummaries(): ActiveSessionSummary[] {
  const summaries: ActiveSessionSummary[] = [];
  for (const [chargePointId, connection] of liveConnections) {
    for (const tx of connection.getActiveSessionSummary()) {
      summaries.push({ chargePointId, ...tx });
    }
  }
  return summaries;
}

// Set once by startOcppWsListener — sendRemoteStartTransaction needs DB access
// to flag a session as offline, but (like routes.ts's call site) doesn't carry
// a sessionId, only chargePointId/idTag, so it re-derives the session itself.
let activeDb: SettlementDb | undefined;

// ─── Offline fallback ──────────────────────────────────────────────────────────
// No live connection to dispatch RemoteStartTransaction to. Flag the session so
// the BootNotification retry sweep (ocpp_connection.ts) picks it up on reconnect,
// and so ops has a queryable state instead of a silently dropped request.

async function markSessionChargerOffline(chargePointId: string, idTag: string): Promise<void> {
  if (activeDb === undefined) {
    return;
  }
  const db = activeDb;

  try {
    const rows = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.chargePointId, chargePointId),
          eq(schema.sessions.idTag, idTag),
          eq(schema.sessions.status, 'payment_cleared'),
        ),
      )
      .orderBy(desc(schema.sessions.paymentClearedAt))
      .limit(1);

    const session = rows[0];
    if (session === undefined) {
      console.warn(
        `[voltsense:ocpp] no payment_cleared session found to flag offline: chargePointId=${chargePointId} idTag=${idTag}`,
      );
      return;
    }

    await db
      .update(schema.sessions)
      .set({ status: 'paid_charger_offline', updatedAt: new Date() })
      .where(eq(schema.sessions.id, session.id));

    console.log(
      `[voltsense:ocpp] session flagged paid_charger_offline: sessionId=${session.id} chargePointId=${chargePointId}`,
    );
  } catch (err) {
    console.error(
      `[voltsense:ocpp] failed to flag session paid_charger_offline: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Per-socket wiring ─────────────────────────────────────────────────────────

async function handleConnection(
  socket: WebSocket,
  urlSegment: string,
  db: SettlementDb,
): Promise<void> {
  // Buffer frames that arrive during async DB setup so BootNotification
  // is not silently dropped if the charger sends immediately on open.
  const pendingFrames: string[] = [];
  socket.on('message', (data: RawData) => {
    pendingFrames.push(rawDataToText(data));
  });

  const chargePointId = await resolveChargePointId(db, urlSegment);
  const registryStatus = await lookupChargePointRegistryStatus(db, chargePointId);
  const registryLookup: ChargePointRegistryLookup = () => registryStatus;

  const connection = new OcppConnection(
    chargePointId,
    (frame: string) => { socket.send(frame); },
    registryLookup,
    db,
  );

  liveConnections.set(chargePointId, connection);
  connection.onOpen();

  // Replay buffered frames before switching to the live handler
  for (const frame of pendingFrames) {
    const response = connection.onRawFrame(frame);
    if (response !== null) socket.send(response);
  }

  // Replace buffer handler with live handler
  socket.removeAllListeners('message');
  socket.on('message', (data: RawData) => {
    const response = connection.onRawFrame(rawDataToText(data));
    if (response !== null) {
      socket.send(response);
    }
  });

  socket.on('close', () => {
    connection.onClose();
    if (liveConnections.get(chargePointId) === connection) {
      liveConnections.delete(chargePointId);
    }
    console.log(`[voltsense:ocpp] charge point ${chargePointId} disconnected`);
  });

  socket.on('error', (error: Error) => {
    console.error(`[voltsense:ocpp] socket error for ${chargePointId}: ${error.message}`);
  });
}

// ─── sendCall outcome narrowing ────────────────────────────────────────────────
// sendCall()'s return type is Promise<unknown> (§1.1.4 — no OCPP CallResult
// payload is typed), so the 'status' field is narrowed manually here rather
// than assumed.

function extractRemoteStartStatus(result: unknown): string | undefined {
  if (typeof result === 'object' && result !== null && 'status' in result) {
    const status = (result as Record<string, unknown>)['status'];
    return typeof status === 'string' ? status : undefined;
  }
  return undefined;
}

// ─── RemoteStartTransaction rejection handling ────────────────────────────────
// The charger is live and explicitly refused to start (status: 'Rejected')
// even though payment already cleared — unlike the offline case, there is no
// reconnect to wait for, so refund the customer now and close out the session.

async function handleRemoteStartRejected(chargePointId: string, idTag: string): Promise<void> {
  if (activeDb === undefined) {
    return;
  }
  const db = activeDb;

  try {
    const sessionRows = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.chargePointId, chargePointId),
          eq(schema.sessions.idTag, idTag),
          eq(schema.sessions.status, 'payment_cleared'),
        ),
      )
      .orderBy(desc(schema.sessions.paymentClearedAt))
      .limit(1);

    const session = sessionRows[0];
    if (session === undefined) {
      console.error(
        `[voltsense:ocpp] RemoteStartTransaction rejected — no payment_cleared session found to refund: chargePointId=${chargePointId} idTag=${idTag}`,
      );
      return;
    }

    const paymentRows = await db
      .select({
        id: schema.payments.id,
        psp: schema.payments.psp,
        externalId: schema.payments.externalId,
        amountPhp: schema.payments.amountPhp,
      })
      .from(schema.payments)
      .where(and(eq(schema.payments.sessionId, session.id), eq(schema.payments.status, 'paid')))
      .orderBy(desc(schema.payments.paidAt))
      .limit(1);

    const payment = paymentRows[0];
    if (payment === undefined) {
      console.error(
        `[voltsense:ocpp] RemoteStartTransaction rejected — session=${session.id} has no paid payment to refund: chargePointId=${chargePointId} idTag=${idTag}`,
      );
      return;
    }

    try {
      const refundConfig = loadRefundConfigFromEnv();
      const refundResult = await dispatchRefund(
        {
          paymentId: payment.id,
          psp: payment.psp,
          externalId: payment.externalId,
          amountPhp: payment.amountPhp,
          reason: 'hardware_timeout',
        },
        refundConfig,
      );

      if (refundResult.outcome === 'success') {
        await db
          .update(schema.payments)
          .set({ status: 'refunded', updatedAt: new Date() })
          .where(eq(schema.payments.id, payment.id));
        console.log(
          `[voltsense:ocpp] RemoteStartTransaction rejected — refunded payment=${payment.id} session=${session.id} chargePointId=${chargePointId}`,
        );
      } else {
        await db
          .update(schema.payments)
          .set({ status: 'refund_failed', updatedAt: new Date() })
          .where(eq(schema.payments.id, payment.id));
        console.error(
          `[voltsense:ocpp] RemoteStartTransaction rejected — refund FAILED (${refundResult.errorCode}) payment=${payment.id} session=${session.id} chargePointId=${chargePointId} — manual review needed`,
        );
      }
    } catch (err) {
      await db
        .update(schema.payments)
        .set({ status: 'refund_failed', updatedAt: new Date() })
        .where(eq(schema.payments.id, payment.id));
      console.error(
        `[voltsense:ocpp] RemoteStartTransaction rejected — refund dispatch error payment=${payment.id} session=${session.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await db
      .update(schema.sessions)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(schema.sessions.id, session.id));
  } catch (err) {
    console.error(
      `[voltsense:ocpp] failed to handle RemoteStartTransaction rejection chargePointId=${chargePointId} idTag=${idTag}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Outbound RemoteStartTransaction ───────────────────────────────────────────
// Called once a session's payment clears (handlePayMongoWebhook). Looks up the
// charge point's live connection and sends the real OCPP Call; never throws —
// callers get a best-effort dispatch and read the outcome from logs.

export async function sendRemoteStartTransaction(
  chargePointId: string,
  connectorId: number,
  idTag: string,
): Promise<void> {
  const connection = liveConnections.get(chargePointId);
  if (connection === undefined) {
    console.error(
      `[voltsense:ocpp] RemoteStartTransaction failed — no live connection for chargePointId=${chargePointId}`,
    );
    await markSessionChargerOffline(chargePointId, idTag);
    return;
  }

  const payload: RemoteStartTransactionReq = { connectorId, idTag };

  try {
    const result = await connection.sendCall('RemoteStartTransaction', payload);
    console.log(
      `[voltsense:ocpp] RemoteStartTransaction.conf chargePointId=${chargePointId} connectorId=${connectorId} idTag=${idTag} result=${JSON.stringify(result)}`,
    );
    if (extractRemoteStartStatus(result) === 'Rejected') {
      console.error(
        `[voltsense:ocpp] RemoteStartTransaction REJECTED by charge point chargePointId=${chargePointId} connectorId=${connectorId} idTag=${idTag}`,
      );
      await handleRemoteStartRejected(chargePointId, idTag);
    }
  } catch (err) {
    console.error(
      `[voltsense:ocpp] RemoteStartTransaction failed chargePointId=${chargePointId}: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
    );
  }
}

// ─── Listener handle ─────────────────────────────────────────────────────────

export type OcppWsListener = {
  readonly server: WebSocketServer;
  close(): Promise<void>;
};

export async function startOcppWsListener(
  db: SettlementDb,
  config: OcppHardwareConfig = ACTIVE_HARDWARE_CONFIG,
  httpServer?: HttpServer,
): Promise<OcppWsListener> {
  activeDb = db;

  // §10.1 routing invariant — a live BESEN station may only bind port 8080.
  // Skipped when sharing the HTTP server (production: Render exposes one port).
  if (httpServer === undefined) {
    assertPhysicalHardwarePortLock(config);
  }

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

  let wss: WebSocketServer;

  if (httpServer !== undefined) {
    // Production (Render): share the single exposed $PORT via the http.Server
    // upgrade event. noServer:true means wss never binds its own port — all
    // /ocpp/* WebSocket upgrades are forwarded here from the HTTP server.
    wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
      const url = req.url ?? '';
      const peer = req.socket.remoteAddress ?? 'unknown';
      const proto = req.headers['sec-websocket-protocol'] ?? '(none)';
      const hasAuth = req.headers.authorization !== undefined;
      console.log(
        `[voltsense:ocpp] WS upgrade attempt — peer=${peer} url=${url} subprotocol=${proto} hasAuth=${String(hasAuth)}`,
      );
      if (!isOcppUpgradePath(url)) {
        console.log(
          `[voltsense:ocpp] WS upgrade rejected — path is not /ocpp, /ocpp/, or /ocpp/{chargePointId}`,
        );
        socket.destroy();
        return;
      }
      const info = { origin: req.headers.origin ?? '', req, secure: false };
      verifyClient(info, (allowed, code, message) => {
        if (!allowed) {
          console.log(
            `[voltsense:ocpp] WS upgrade rejected — auth failed (${code ?? 401} ${message ?? 'Unauthorized'}) peer=${peer} subprotocol=${proto} hasAuth=${String(hasAuth)}`,
          );
          socket.write(`HTTP/1.1 ${code ?? 401} ${message ?? 'Unauthorized'}\r\n\r\n`);
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      });
    });

    console.log(
      `[voltsense:ocpp] WebSocket listener attached to HTTP server — bench mode: ${describeBenchMode(config.testState)}`,
    );
  } else {
    // Bench: bind own isolated port (not behind Render's single-port proxy).
    wss = new WebSocketServer({ port: config.wsPort, verifyClient });

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
      `[voltsense:ocpp] WebSocket listener bound on port ${config.wsPort} — bench mode: ${describeBenchMode(config.testState)}`,
    );
  }

  wss.on('connection', (socket: WebSocket, request) => {
    const peer = request.socket.remoteAddress ?? 'unknown';
    const urlSegment = extractChargePointId(request);

    if (urlSegment === null) {
      console.error(`[voltsense:ocpp] connection rejected from ${peer} — no chargePointId in path`);
      socket.close(1008, 'chargePointId required in connection path');
      return;
    }

    const barePathFallback =
      isBareOcppPath(new URL(request.url ?? '/', 'http://internal').pathname);
    console.log(
      `[voltsense:ocpp] charge point ${urlSegment} connected from ${peer}${barePathFallback ? ' (pilot bare /ocpp fallback)' : ''}`,
    );

    void handleConnection(socket, urlSegment, db).catch((error: unknown) => {
      console.error(
        `[voltsense:ocpp] failed to initialize connection for ${urlSegment}: ${error instanceof Error ? error.message : String(error)}`,
      );
      socket.close(1011, 'Internal error');
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
