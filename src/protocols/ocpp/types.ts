// OCPP 1.6J type definitions — Law §1.1.4 / §1.1.5
// No 'any'. No 'string' widening on action or errorCode.

// ─── OCPP Actions ─────────────────────────────────────────────────────────────
// Closed allowlist per §1.1.5. Any string not in this union → NotSupported.

export type OcppActionFromCp =
  | 'BootNotification'
  | 'Heartbeat'
  | 'StatusNotification'
  | 'Authorize'
  | 'StartTransaction'
  | 'StopTransaction'
  | 'MeterValues'
  | 'DiagnosticsStatusNotification'
  | 'FirmwareStatusNotification';

export type OcppActionFromCsms =
  | 'RemoteStartTransaction'
  | 'RemoteStopTransaction'
  | 'ChangeConfiguration'
  | 'GetConfiguration'
  | 'Reset'
  | 'UnlockConnector'
  | 'TriggerMessage';

export type OcppAction = OcppActionFromCp | OcppActionFromCsms;

export const OCPP_ACTION_ALLOWLIST: ReadonlySet<OcppAction> = new Set<OcppAction>([
  'BootNotification',
  'Heartbeat',
  'StatusNotification',
  'Authorize',
  'StartTransaction',
  'StopTransaction',
  'MeterValues',
  'DiagnosticsStatusNotification',
  'FirmwareStatusNotification',
  'RemoteStartTransaction',
  'RemoteStopTransaction',
  'ChangeConfiguration',
  'GetConfiguration',
  'Reset',
  'UnlockConnector',
  'TriggerMessage',
]);

export function isOcppAction(value: unknown): value is OcppAction {
  // Cast the Set to ReadonlySet<string> — widens the element type, not the value.
  // Avoids the 'as OcppAction' assertion that would defeat the type guard's purpose.
  return typeof value === 'string' && (OCPP_ACTION_ALLOWLIST as ReadonlySet<string>).has(value);
}

// ─── OCPP Error Codes ─────────────────────────────────────────────────────────

export type OcppErrorCode =
  | 'NotImplemented'
  | 'NotSupported'
  | 'InternalError'
  | 'ProtocolError'
  | 'SecurityError'
  | 'FormationViolation'
  | 'PropertyConstraintViolation'
  | 'OccurrenceConstraintViolation'
  | 'TypeConstraintViolation'
  | 'GenericError';

const OCPP_ERROR_CODES: ReadonlySet<OcppErrorCode> = new Set<OcppErrorCode>([
  'NotImplemented',
  'NotSupported',
  'InternalError',
  'ProtocolError',
  'SecurityError',
  'FormationViolation',
  'PropertyConstraintViolation',
  'OccurrenceConstraintViolation',
  'TypeConstraintViolation',
  'GenericError',
]);

export function isOcppErrorCode(value: unknown): value is OcppErrorCode {
  return typeof value === 'string' && (OCPP_ERROR_CODES as ReadonlySet<string>).has(value);
}

// ─── MessageTypeId constants ──────────────────────────────────────────────────

export const MESSAGE_TYPE_CALL = 2 as const;
export const MESSAGE_TYPE_CALL_RESULT = 3 as const;
export const MESSAGE_TYPE_CALL_ERROR = 4 as const;

export type MessageTypeId =
  | typeof MESSAGE_TYPE_CALL
  | typeof MESSAGE_TYPE_CALL_RESULT
  | typeof MESSAGE_TYPE_CALL_ERROR;

// ─── OcppInbound discriminated union ─────────────────────────────────────────
// Required pattern per §1.1.4 — kind narrows exactly, no string widening.

export type OcppCall = {
  kind: 'call';
  messageId: string;
  action: OcppAction;
  payload: unknown;
};

export type OcppCallResult = {
  kind: 'call_result';
  messageId: string;
  payload: unknown;
};

export type OcppCallError = {
  kind: 'call_error';
  messageId: string;
  errorCode: OcppErrorCode;
  errorDescription: string;
  errorDetails: unknown;
};

export type OcppInbound = OcppCall | OcppCallResult | OcppCallError;

// ─── ParseError ───────────────────────────────────────────────────────────────

export type ParseErrorCode =
  | 'INVALID_JSON'
  | 'NOT_AN_ARRAY'
  | 'INVALID_FRAME_LENGTH'
  | 'UNKNOWN_MESSAGE_TYPE'
  | 'INVALID_MESSAGE_ID'
  | 'UNKNOWN_ACTION'
  | 'UNKNOWN_ERROR_CODE'
  | 'MISSING_FIELDS';

export type ParseError = {
  kind: 'parse_error';
  code: ParseErrorCode;
  detail: string;
  raw: string;
  // Present when the frame was parsed far enough to extract messageId (e.g. UNKNOWN_ACTION).
  // Required to send a properly correlated CallError back to the charge point.
  messageId: string | null;
};

export type ParseResult = OcppInbound | ParseError;

export function isParseError(result: ParseResult): result is ParseError {
  return result.kind === 'parse_error';
}

// ─── Pending call tracking ────────────────────────────────────────────────────
// Map<MessageId, PendingCall> per §1.1.6 — TTL 120 s

export type PendingCall = {
  action: OcppAction;
  sentAt: Date;
  resolve: (payload: unknown) => void;
  reject: (error: OcppCallError) => void;
};

// ─── Remote auth sources ──────────────────────────────────────────────────────
// Closed union per §1.5.2

export type RemoteAuthSource =
  | { source: 'gcash_webhook'; payment_id: string; idempotency_key: string }
  | { source: 'maya_webhook'; payment_id: string; idempotency_key: string }
  | { source: 'host_comp'; host_account_id: string; comp_reason: string }
  | { source: 'maintenance'; operator_id: string; ticket_id: string };

// ─── Session state machine ────────────────────────────────────────────────────
// Per §1.1.7 — OPERATIONAL is the only state that may enqueue RemoteStartTransaction

export type OcppSessionState =
  | 'DISCONNECTED'
  | 'WS_OPEN'
  | 'BOOT_PENDING'
  | 'BOOT_ACCEPTED'
  | 'OPERATIONAL'
  | 'BOOT_REJECTED'
  | 'WS_CLOSE';

// ─── BootNotification payload (§1.1.3) ───────────────────────────────────────

export type BootNotificationPayload = {
  chargePointVendor: string;
  chargePointModel: string;
  chargePointSerialNumber: string;
  firmwareVersion: string;
};

// ─── Outbound payloads ────────────────────────────────────────────────────────

export type BootNotificationConf = {
  status: 'Accepted' | 'Pending' | 'Rejected';
  currentTime: string;
  interval: number;
};

export type HeartbeatConf = {
  currentTime: string;
};

// idTag status values — closed literal union, never plain string (§1.5.5)
export type IdTagStatus = 'Accepted' | 'Blocked' | 'Expired' | 'Invalid' | 'ConcurrentTx';

export type RemoteStartTransactionReq = {
  connectorId: number;
  idTag: string;
};

export type CallResultPayload =
  | BootNotificationConf
  | HeartbeatConf
  | { status: IdTagStatus }
  | { transactionId: number; idTagInfo: { status: IdTagStatus } }
  | Record<string, never>;
