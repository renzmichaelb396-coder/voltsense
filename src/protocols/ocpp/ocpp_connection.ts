// Runtime anchor for OCPP 1.6J connection lifecycle — Law §1.1
// Inspector rule: action: string or payload: any in this file = P0 weld violation.

import { Decimal } from 'decimal.js';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';

import * as schema from '../../db/schema.js';
import { executeRevenueSplitOrRefund, type SettlementDb } from '../../services/settlement.js';
import { loadRefundConfigFromEnv } from '../../services/refund.js';
import {
  type OcppInbound,
  type OcppCall,
  type OcppCallResult,  // used in handleCallResult
  type OcppCallError,
  type OcppAction,
  type OcppErrorCode,
  type ParseError,
  type ParseErrorCode,
  type ParseResult,
  type PendingCall,
  type OcppSessionState,
  type CallResultPayload,
  type BootNotificationPayload,
  type BootNotificationConf,
  type RemoteStartTransactionReq,
  isOcppAction,
  isOcppErrorCode,
  isParseError,
  MESSAGE_TYPE_CALL,
  MESSAGE_TYPE_CALL_RESULT,
  MESSAGE_TYPE_CALL_ERROR,
} from './types.js';

type SessionRow = typeof schema.sessions.$inferSelect;

// ─── Registry lookup contract ─────────────────────────────────────────────────
// Injected at construction; decouples the connection class from DB internals.
// Returns 'provisioned' only when the chargePointId is in the registry with
// status = 'provisioned' (§1.1.3 step 2). All other states block boot acceptance.

export type ChargePointRegistryStatus = 'provisioned' | 'not_found' | 'decommissioned' | 'rejected';
export type ChargePointRegistryLookup = (chargePointId: string) => ChargePointRegistryStatus;

// ─── BootNotification payload guard ──────────────────────────────────────────
// §1.1.3: vendor, model, serialNumber must be non-empty strings.

function isBootNotificationPayload(value: unknown): value is BootNotificationPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['chargePointVendor'] === 'string' && v['chargePointVendor'].length > 0 &&
    typeof v['chargePointModel'] === 'string' && v['chargePointModel'].length > 0 &&
    typeof v['chargePointSerialNumber'] === 'string' && v['chargePointSerialNumber'].length > 0 &&
    typeof v['firmwareVersion'] === 'string'
  );
}

// ─── StartTransaction / StopTransaction payload guards ────────────────────────
// Needed to correlate the CSMS-assigned transactionId back to a VoltSense
// session for settlement (§1.4.4) — neither field is part of the OcppAction union.

type StartTransactionPayload = {
  connectorId: number;
  idTag: string;
  meterStart: number;
  timestamp: string;
};

function isStartTransactionPayload(value: unknown): value is StartTransactionPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['connectorId'] === 'number' &&
    typeof v['idTag'] === 'string' && v['idTag'].length > 0 &&
    typeof v['meterStart'] === 'number' &&
    typeof v['timestamp'] === 'string'
  );
}

type StopTransactionPayload = {
  transactionId: number;
  meterStop: number;
  timestamp: string;
};

function isStopTransactionPayload(value: unknown): value is StopTransactionPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['transactionId'] === 'number' &&
    typeof v['meterStop'] === 'number' &&
    typeof v['timestamp'] === 'string'
  );
}

// ─── sendCall outcome formatting ───────────────────────────────────────────────
// Used to log BootNotification-retry results without leaking 'unknown' shapes.

function isOcppCallError(value: unknown): value is OcppCallError {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'call_error';
}

function extractRemoteStartStatus(result: unknown): string {
  if (typeof result === 'object' && result !== null && 'status' in result) {
    const status = (result as Record<string, unknown>)['status'];
    if (typeof status === 'string') {
      return status;
    }
  }
  return 'unknown';
}

function describeSendCallFailure(err: unknown): string {
  if (isOcppCallError(err)) {
    return err.errorDescription.includes('TTL expired') ? 'timeout' : `error(${err.errorCode})`;
  }
  return err instanceof Error ? `error(${err.message})` : 'error(unknown)';
}

// ─── parseInboundFrame ────────────────────────────────────────────────────────
// Safe error-boundary parse: raw string → OcppInbound | ParseError
// Complies with H-04: malformed frame → ParseError, no state mutation.

export function parseInboundFrame(raw: string): ParseResult {
  // knownMessageId is threaded through so UNKNOWN_ACTION errors can carry it,
  // enabling onRawFrame to send a properly correlated CallError (§1.1.5).
  const fail = (
    code: ParseErrorCode,
    detail: string,
    knownMessageId: string | null = null,
  ): ParseError => ({
    kind: 'parse_error',
    code,
    detail,
    raw,
    messageId: knownMessageId,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('INVALID_JSON', 'Frame is not valid JSON');
  }

  if (!Array.isArray(parsed)) {
    return fail('NOT_AN_ARRAY', 'OCPP frame must be a JSON array');
  }

  const messageTypeId = parsed[0];
  if (messageTypeId !== MESSAGE_TYPE_CALL &&
      messageTypeId !== MESSAGE_TYPE_CALL_RESULT &&
      messageTypeId !== MESSAGE_TYPE_CALL_ERROR) {
    return fail('UNKNOWN_MESSAGE_TYPE', `MessageTypeId ${String(messageTypeId)} is not 2, 3, or 4`);
  }

  const messageId = parsed[1];
  if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > 36) {
    return fail('INVALID_MESSAGE_ID', 'MessageId must be a non-empty string of max 36 chars');
  }

  if (messageTypeId === MESSAGE_TYPE_CALL) {
    // [2, messageId, action, payload] — exactly 4 elements
    if (parsed.length !== 4) {
      return fail('INVALID_FRAME_LENGTH', `Call frame must have 4 elements, got ${parsed.length}`);
    }
    const action = parsed[2];
    if (!isOcppAction(action)) {
      // Pass messageId so onRawFrame can wire a CallError NotSupported back to the CP (§1.1.5).
      return fail('UNKNOWN_ACTION', `Action "${String(action)}" is not in the VoltSense allowlist`, messageId);
    }
    const call: OcppCall = {
      kind: 'call',
      messageId,
      action,
      payload: parsed[3],
    };
    return call;
  }

  if (messageTypeId === MESSAGE_TYPE_CALL_RESULT) {
    // [3, messageId, payload] — exactly 3 elements
    if (parsed.length !== 3) {
      return fail('INVALID_FRAME_LENGTH', `CallResult frame must have 3 elements, got ${parsed.length}`);
    }
    const result: OcppCallResult = {
      kind: 'call_result',
      messageId,
      payload: parsed[2],
    };
    return result;
  }

  // messageTypeId === MESSAGE_TYPE_CALL_ERROR
  // [4, messageId, errorCode, errorDescription, errorDetails] — exactly 5 elements
  if (parsed.length !== 5) {
    return fail('INVALID_FRAME_LENGTH', `CallError frame must have 5 elements, got ${parsed.length}`);
  }
  const errorCode = parsed[2];
  if (!isOcppErrorCode(errorCode)) {
    return fail('UNKNOWN_ERROR_CODE', `ErrorCode "${String(errorCode)}" is not a valid OCPP error code`);
  }
  const errorDescription = parsed[3];
  if (typeof errorDescription !== 'string') {
    return fail('MISSING_FIELDS', 'errorDescription must be a string');
  }
  const error: OcppCallError = {
    kind: 'call_error',
    messageId,
    errorCode,
    errorDescription,
    errorDetails: parsed[4],
  };
  return error;
}

// ─── buildCallErrorFrame ──────────────────────────────────────────────────────

export function buildCallErrorFrame(
  messageId: string,
  errorCode: OcppErrorCode,
  errorDescription: string,
  errorDetails: Record<string, string> = {},
): string {
  return JSON.stringify([MESSAGE_TYPE_CALL_ERROR, messageId, errorCode, errorDescription, errorDetails]);
}

export function buildCallResultFrame(messageId: string, payload: CallResultPayload): string {
  return JSON.stringify([MESSAGE_TYPE_CALL_RESULT, messageId, payload]);
}

// ─── Transaction ID counter ───────────────────────────────────────────────────
// Module-level sequence: monotonically increasing per CSMS process lifetime.
// For multi-process deployments, replace with a PostgreSQL SERIAL sequence lookup.

let _transactionIdCounter = 0;

function nextTransactionId(): number {
  return ++_transactionIdCounter;
}

// ─── OcppConnection ───────────────────────────────────────────────────────────
// WebSocket lifecycle per charge_point_id — Law §1.1.7 state machine

export class OcppConnection {
  readonly chargePointId: string;
  private state: OcppSessionState = 'DISCONNECTED';
  private pendingCalls: Map<string, PendingCall> = new Map();
  private pendingCallTtlMs = 120_000;
  private pendingCallSweepTimer: ReturnType<typeof setInterval> | null = null;
  private send: (frame: string) => void;
  private registryLookup: ChargePointRegistryLookup;
  private db: SettlementDb | undefined;
  // CSMS-assigned transactionId → VoltSense session id, so StopTransaction can
  // find its session without relying on optional/absent OCPP fields (§1.4.4).
  private activeTransactions: Map<number, string> = new Map();

  constructor(
    chargePointId: string,
    send: (frame: string) => void,
    registryLookup: ChargePointRegistryLookup,
    db?: SettlementDb,
  ) {
    this.chargePointId = chargePointId;
    this.send = send;
    this.registryLookup = registryLookup;
    this.db = db;
  }

  getState(): OcppSessionState {
    return this.state;
  }

  onOpen(): void {
    this.state = 'WS_OPEN';
    this.startPendingCallSweep();
  }

  onClose(): void {
    this.state = 'WS_CLOSE';
    this.stopPendingCallSweep();
    this.rejectAllPending();
  }

  // ─── Frame ingestion ────────────────────────────────────────────────────────

  onRawFrame(raw: string): string | null {
    const result = parseInboundFrame(raw);

    if (isParseError(result)) {
      // H-05: unknown action with a recoverable messageId → send CallError NotSupported
      // down the wire so the charge point knows the frame was received but rejected (§1.1.5).
      if (result.code === 'UNKNOWN_ACTION' && result.messageId !== null) {
        return buildCallErrorFrame(result.messageId, 'NotSupported', result.detail);
      }
      // H-04: all other malformed frames → drop silently, no state mutation
      return null;
    }

    return this.dispatch(result);
  }

  private dispatch(msg: OcppInbound): string | null {
    switch (msg.kind) {
      case 'call':
        return this.handleCall(msg);
      case 'call_result':
        this.handleCallResult(msg);
        return null;
      case 'call_error':
        this.handleCallError(msg);
        return null;
      default:
        return assertNever(msg);
    }
  }

  // ─── Call handler ───────────────────────────────────────────────────────────

  private handleCall(msg: OcppCall): string {
    // Gate: only BootNotification allowed before OPERATIONAL in BOOT_PENDING state
    if (this.state === 'WS_OPEN' && msg.action !== 'BootNotification') {
      return buildCallErrorFrame(
        msg.messageId,
        'SecurityError',
        'BootNotification must be the first Call',
      );
    }

    // BootNotification advances state machine
    if (msg.action === 'BootNotification') {
      return this.handleBootNotification(msg);
    }

    // All other actions require OPERATIONAL state
    if (this.state !== 'OPERATIONAL') {
      return buildCallErrorFrame(
        msg.messageId,
        'SecurityError',
        `Action ${msg.action} requires OPERATIONAL state; current state is ${this.state}`,
      );
    }

    // Defer to action-specific handlers (action is fully narrowed — no string widening)
    switch (msg.action) {
      case 'Heartbeat':
        return this.handleHeartbeat(msg);
      case 'StatusNotification':
        return buildCallResultFrame(msg.messageId, {});
      case 'Authorize':
        return buildCallResultFrame(msg.messageId, { status: 'Accepted' });
      case 'StartTransaction': {
        const transactionId = nextTransactionId();
        this.trackStartTransaction(transactionId, msg.payload);
        return buildCallResultFrame(msg.messageId, { transactionId, idTagInfo: { status: 'Accepted' } });
      }
      case 'StopTransaction': {
        // Ack immediately — settlement runs after, so a slow PSP call never
        // blocks the OCPP response the charge point is waiting on.
        this.trackStopTransaction(msg.payload);
        return buildCallResultFrame(msg.messageId, {});
      }
      case 'MeterValues':
        return buildCallResultFrame(msg.messageId, {});
      case 'DiagnosticsStatusNotification':
        return buildCallResultFrame(msg.messageId, {});
      case 'FirmwareStatusNotification':
        return buildCallResultFrame(msg.messageId, {});
      // CSMS-originated actions are never inbound Calls from the CP
      case 'RemoteStartTransaction':
      case 'RemoteStopTransaction':
      case 'ChangeConfiguration':
      case 'GetConfiguration':
      case 'Reset':
      case 'UnlockConnector':
      case 'TriggerMessage':
        return buildCallErrorFrame(
          msg.messageId,
          'NotSupported',
          `${msg.action} is a CSMS-to-CP action and cannot be received as an inbound Call`,
        );
      default:
        return assertNever(msg.action);
    }
  }

  private handleBootNotification(msg: OcppCall): string {
    // §1.1.7 step 1: enter BOOT_PENDING before any validation touches session state.
    this.state = 'BOOT_PENDING';

    const reject = (reason: string): string => {
      this.state = 'BOOT_REJECTED';
      const conf: BootNotificationConf = {
        status: 'Rejected',
        currentTime: new Date().toISOString(),
        interval: 300,
      };
      // Attach reason to errorDetails via a separate CallError before closing — omitted
      // here since BootNotification.conf itself carries the Rejected status.
      void reason;
      return buildCallResultFrame(msg.messageId, conf);
    };

    // §1.1.3 step 3: validate mandatory payload fields — all must be non-empty strings.
    if (!isBootNotificationPayload(msg.payload)) {
      return reject('BootNotification payload missing required fields (vendor/model/serial/firmware)');
    }

    // §1.1.3 step 2: charge point must exist in registry with status = 'provisioned'.
    const registryStatus = this.registryLookup(this.chargePointId);
    if (registryStatus !== 'provisioned') {
      return reject(`chargePointId not provisioned in registry (status: ${registryStatus})`);
    }

    // §1.1.7: explicit transition through BOOT_ACCEPTED before OPERATIONAL.
    this.state = 'BOOT_ACCEPTED';
    this.state = 'OPERATIONAL';

    // Fire-and-forget: resumes any sessions that paid while this charge point
    // was offline. Must never delay or alter the BootNotification.conf below.
    this.retryPendingSessionsForReconnect();

    const conf: BootNotificationConf = {
      status: 'Accepted',
      currentTime: new Date().toISOString(),
      interval: 300,
    };
    return buildCallResultFrame(msg.messageId, conf);
  }

  private handleHeartbeat(msg: OcppCall): string {
    return buildCallResultFrame(msg.messageId, { currentTime: new Date().toISOString() });
  }

  // ─── BootNotification retry — resume paid sessions on reconnect ───────────
  // If a guest paid while this charge point was offline, sendRemoteStartTransaction
  // (ocpp_ws.ts) never reached it. Catch those sessions here instead of leaving
  // them stuck. No db injected (e.g. the simulation harness) → nothing to resume.

  private retryPendingSessionsForReconnect(): void {
    if (this.db === undefined) {
      return;
    }
    const db = this.db;
    void this.resumePendingSessions(db).catch((err: unknown) => {
      console.error(
        `[voltsense:ocpp] BootNotification retry sweep failed for chargePointId=${this.chargePointId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async resumePendingSessions(db: SettlementDb): Promise<void> {
    const rows = await db
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.chargePointId, this.chargePointId),
          // Includes 'paid_charger_offline' (set by sendRemoteStartTransaction
          // when this charge point was unreachable) so reconnect actually
          // catches those sessions, not just fresh 'payment_cleared' ones.
          inArray(schema.sessions.status, ['payment_cleared', 'paid_charger_offline']),
          gt(schema.sessions.authExpiresAt, new Date()),
        ),
      )
      .orderBy(asc(schema.sessions.paymentClearedAt))
      .limit(5);

    for (const session of rows) {
      // Sequential, not parallel — keeps retry order stable and avoids bursting
      // RemoteStartTransaction calls at a charge point the instant it reconnects.
      await this.retryRemoteStart(session);
    }
  }

  private async retryRemoteStart(session: SessionRow): Promise<void> {
    const payload: RemoteStartTransactionReq = {
      connectorId: session.connectorId,
      idTag: session.idTag,
    };

    try {
      const result = await this.sendCall('RemoteStartTransaction', payload);
      console.log(
        `[voltsense:ocpp] BootNotification retry sessionId=${session.id} chargePointId=${this.chargePointId} outcome=${extractRemoteStartStatus(result)}`,
      );
    } catch (err) {
      // The charge point just booted — a retry failure must never tear down
      // the connection or propagate past this method.
      console.error(
        `[voltsense:ocpp] BootNotification retry sessionId=${session.id} chargePointId=${this.chargePointId} outcome=${describeSendCallFailure(err)}`,
      );
    }
  }

  // ─── StartTransaction session correlation (fire-and-forget) ───────────────
  // No db injected (e.g. the simulation harness) → nothing to correlate.

  private trackStartTransaction(transactionId: number, payload: unknown): void {
    if (this.db === undefined || !isStartTransactionPayload(payload)) {
      return;
    }
    const db = this.db;
    void this.resolveSessionForStart(db, transactionId, payload).catch((err: unknown) => {
      console.error(
        `[voltsense:ocpp] failed to resolve session for StartTransaction: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async resolveSessionForStart(
    db: SettlementDb,
    transactionId: number,
    payload: StartTransactionPayload,
  ): Promise<void> {
    const rows = await db
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.chargePointId, this.chargePointId),
          eq(schema.sessions.idTag, payload.idTag),
          inArray(schema.sessions.status, ['payment_cleared', 'authorized']),
        ),
      )
      .orderBy(desc(schema.sessions.createdAt))
      .limit(1);

    const session = rows[0];
    if (session === undefined) {
      console.warn(
        `[voltsense:ocpp] StartTransaction with no matching session: chargePointId=${this.chargePointId} idTag=${payload.idTag}`,
      );
      return;
    }

    await db
      .update(schema.sessions)
      .set({
        status: 'charging',
        meterStartWh: payload.meterStart,
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.sessions.id, session.id));

    this.activeTransactions.set(transactionId, session.id);
  }

  // ─── StopTransaction settlement (fire-and-forget) ──────────────────────────
  // Sets kwhDelivered THEN runs executeRevenueSplitOrRefund — settlement.ts
  // rejects with "kwhDelivered is null" if that order is ever inverted.

  private trackStopTransaction(payload: unknown): void {
    if (this.db === undefined || !isStopTransactionPayload(payload)) {
      return;
    }
    const db = this.db;
    void this.settleStopTransaction(db, payload).catch((err: unknown) => {
      console.error(
        `[voltsense:ocpp] failed to settle StopTransaction: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async settleStopTransaction(db: SettlementDb, payload: StopTransactionPayload): Promise<void> {
    const sessionId = this.activeTransactions.get(payload.transactionId);
    if (sessionId === undefined) {
      console.warn(`[voltsense:ocpp] StopTransaction for untracked transactionId=${payload.transactionId}`);
      return;
    }
    this.activeTransactions.delete(payload.transactionId);

    const sessionRows = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .limit(1);

    const session = sessionRows[0];
    if (session === undefined) {
      console.error(`[voltsense:ocpp] session not found for StopTransaction: sessionId=${sessionId}`);
      return;
    }

    const meterStartWh = session.meterStartWh ?? 0;
    const kwhDelivered = new Decimal(payload.meterStop - meterStartWh)
      .div(1000)
      .toDecimalPlaces(6)
      .toFixed(6);

    await db
      .update(schema.sessions)
      .set({
        meterStopWh: payload.meterStop,
        kwhDelivered,
        stoppedAt: new Date(),
        status: 'completed',
        updatedAt: new Date(),
      })
      .where(eq(schema.sessions.id, session.id));

    const paymentRows = await db
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.sessionId, session.id), eq(schema.payments.status, 'paid')))
      .orderBy(desc(schema.payments.paidAt))
      .limit(1);

    const payment = paymentRows[0];
    if (payment === undefined) {
      console.error(`[voltsense:ocpp] no paid payment found for session=${session.id} — cannot settle`);
      return;
    }

    const chargePointRows = await db
      .select({ siteId: schema.chargePoints.siteId })
      .from(schema.chargePoints)
      .where(eq(schema.chargePoints.id, this.chargePointId))
      .limit(1);

    const stationId = chargePointRows[0]?.siteId;
    if (stationId === undefined) {
      console.error(`[voltsense:ocpp] charge point not found: chargePointId=${this.chargePointId}`);
      return;
    }

    let refundConfig;
    try {
      refundConfig = loadRefundConfigFromEnv();
    } catch (err) {
      console.error(`[voltsense:ocpp] refund config error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const settlementResult = await executeRevenueSplitOrRefund({
      db,
      paymentId: payment.id,
      totalAmount: payment.amountPhp,
      stationId,
      psp: payment.psp,
      externalId: payment.externalId,
      refundConfig,
    });

    console.log('[voltsense:ocpp] settlement outcome', JSON.stringify(settlementResult));
  }

  // ─── CallResult / CallError routing ────────────────────────────────────────

  private handleCallResult(msg: OcppCallResult): void {
    const pending = this.pendingCalls.get(msg.messageId);
    if (pending) {
      this.pendingCalls.delete(msg.messageId);
      pending.resolve(msg.payload);
    }
  }

  private handleCallError(msg: OcppCallError): void {
    const pending = this.pendingCalls.get(msg.messageId);
    if (pending) {
      this.pendingCalls.delete(msg.messageId);
      pending.reject(msg);
    }
  }

  // ─── Outbound Call ──────────────────────────────────────────────────────────

  sendCall(action: OcppAction, payload: unknown): Promise<unknown> {
    const messageId = generateMessageId();
    const frame = JSON.stringify([MESSAGE_TYPE_CALL, messageId, action, payload]);

    return new Promise((resolve, reject) => {
      this.pendingCalls.set(messageId, {
        action,
        sentAt: new Date(),
        resolve,
        reject,
      });
      this.send(frame);
    });
  }

  // ─── Pending call TTL sweep ─────────────────────────────────────────────────
  // Per §1.1.6: TTL 120 s on pending Call map

  private startPendingCallSweep(): void {
    this.pendingCallSweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, pending] of this.pendingCalls) {
        if (now - pending.sentAt.getTime() > this.pendingCallTtlMs) {
          this.pendingCalls.delete(id);
          const timeoutError: OcppCallError = {
            kind: 'call_error',
            messageId: id,
            errorCode: 'GenericError',
            errorDescription: 'Pending call TTL expired (120 s)',
            errorDetails: {},
          };
          pending.reject(timeoutError);
        }
      }
    }, 10_000);
  }

  private stopPendingCallSweep(): void {
    if (this.pendingCallSweepTimer !== null) {
      clearInterval(this.pendingCallSweepTimer);
      this.pendingCallSweepTimer = null;
    }
  }

  private rejectAllPending(): void {
    for (const [id, pending] of this.pendingCalls) {
      const closeError: OcppCallError = {
        kind: 'call_error',
        messageId: id,
        errorCode: 'GenericError',
        errorDescription: 'WebSocket closed before response received',
        errorDetails: {},
      };
      pending.reject(closeError);
    }
    this.pendingCalls.clear();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateMessageId(): string {
  // RFC 4122 v4 UUID — max 36 chars, unique per session (§1.1.6)
  return crypto.randomUUID();
}

// Exhaustive-check sentinel. If the compiler allows a call to reach this at
// runtime it means a new union member was added without updating the switch.
// The 'never' parameter type makes every call site a compile-time error unless
// the switch truly covers all members. The thrown Error is a runtime backstop.
function assertNever(x: never): never {
  throw new Error(`Exhaustive check failed: ${String(x)}`);
}

// ─── Re-exports for consumers ─────────────────────────────────────────────────

export { parseInboundFrame as default };
export type { OcppInbound, ParseError, ParseResult, OcppAction, OcppSessionState };
