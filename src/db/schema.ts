import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const chargePointStatusEnum = pgEnum('charge_point_status', [
  'provisioned',
  'operational',
  'offline',
  'faulted',
  'decommissioned',
]);

export const connectorStatusEnum = pgEnum('connector_status', [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
]);

export const sessionStatusEnum = pgEnum('session_status', [
  'awaiting_payment',
  'payment_cleared',
  'authorized',
  'charging',
  'lost_transaction',
  'paid_charger_offline',
  'completed',
  'cancelled',
  'expired',
]);

export const packageIdEnum = pgEnum('package_id', [
  'PKG_5KWH',
  'PKG_10KWH',
  'PKG_15KWH',
  'PKG_FULL',
  'PKG_CUSTOM',
]);

export const pspEnum = pgEnum('psp', ['gcash', 'maya', 'paymongo']);

export const paymentStatusEnum = pgEnum('payment_status', [
  'pending',
  'paid',
  'failed',
  'amount_mismatch',
  'refunded',
  'partially_refunded',
  'refund_failed',
]);

export const splitRecipientRoleEnum = pgEnum('split_recipient_role', [
  'site_host',
  'platform',
  'psp_fee',
  'du_pass_through',
]);

export const ledgerEntryTypeEnum = pgEnum('ledger_entry_type', [
  'charge',
  'split',
  'refund',
  'psp_fee',
]);

export const disbursementStatusEnum = pgEnum('disbursement_status', [
  'queued',
  'sent',
  'failed',
  'reconciled',
]);

export const ocppCommandActionEnum = pgEnum('ocpp_command_action', [
  'RemoteStartTransaction',
  'RemoteStopTransaction',
  'ChangeConfiguration',
  'GetConfiguration',
  'Reset',
  'UnlockConnector',
  'TriggerMessage',
]);

export const ocppCommandResultEnum = pgEnum('ocpp_command_result', [
  'ack',
  'nack',
  'timeout',
]);

export const phaseEnum = pgEnum('phase', ['single', 'three']);

// ─── Sites ────────────────────────────────────────────────────────────────────

export const sites = pgTable('sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  feederBreakerAmps: integer('feeder_breaker_amps').notNull(),
  feederCapacityWatts: integer('feeder_capacity_watts').notNull(),
  phase: phaseEnum('phase').notNull(),
  loadManagementEnabled: boolean('load_management_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Charge Points ────────────────────────────────────────────────────────────

export const chargePoints = pgTable('charge_points', {
  id: uuid('id').primaryKey().defaultRandom(),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  vendor: text('vendor').notNull(),
  model: text('model').notNull(),
  serialNumber: text('serial_number').notNull().unique(),
  firmwareVersion: text('firmware_version').notNull(),
  status: chargePointStatusEnum('status').notNull().default('provisioned'),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
  heartbeatIntervalSeconds: integer('heartbeat_interval_seconds').notNull().default(300),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Connectors ───────────────────────────────────────────────────────────────

export const connectors = pgTable('connectors', {
  id: uuid('id').primaryKey().defaultRandom(),
  chargePointId: uuid('charge_point_id').notNull().references(() => chargePoints.id),
  connectorId: integer('connector_id').notNull(),
  status: connectorStatusEnum('status').notNull().default('Unavailable'),
  maxAmps: integer('max_amps').notNull(),
  reservationSessionId: uuid('reservation_session_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Tariffs ──────────────────────────────────────────────────────────────────
// All rate columns are NUMERIC(18,6) — no float/double allowed (Law §1.4.3)

export const tariffs = pgTable('tariffs', {
  id: uuid('id').primaryKey().defaultRandom(),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  duRatePerKwh: numeric('du_rate_per_kwh', { precision: 18, scale: 6 }).notNull(),
  hostMarginPerKwh: numeric('host_margin_per_kwh', { precision: 18, scale: 6 }).notNull(),
  platformFeePerKwh: numeric('platform_fee_per_kwh', { precision: 18, scale: 6 }).notNull(),
  platformFeeFlatPhp: numeric('platform_fee_flat_php', { precision: 18, scale: 6 }).notNull(),
  pspFeeRate: numeric('psp_fee_rate', { precision: 18, scale: 6 }).notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Sessions ─────────────────────────────────────────────────────────────────
// Tariff rates are snapshot-copied at session start for immutability (Law §1.4.4)

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  chargePointId: uuid('charge_point_id').notNull().references(() => chargePoints.id),
  connectorId: integer('connector_id').notNull(),
  status: sessionStatusEnum('status').notNull().default('awaiting_payment'),
  idTag: text('id_tag').notNull(),
  packageId: packageIdEnum('package_id').notNull(),

  // Guest-supplied contact for future overstay/charging-update SMS (Phase 2+).
  // Optional — checkout must never block on this field being absent.
  phoneNumber: text('phone_number'),

  // Tariff snapshot — copied from tariffs at session create; never re-read post-start
  snapshotDuRatePerKwh: numeric('snapshot_du_rate_per_kwh', { precision: 18, scale: 6 }).notNull(),
  snapshotHostMarginPerKwh: numeric('snapshot_host_margin_per_kwh', { precision: 18, scale: 6 }).notNull(),
  snapshotPlatformFeePerKwh: numeric('snapshot_platform_fee_per_kwh', { precision: 18, scale: 6 }).notNull(),
  snapshotPlatformFeeFlatPhp: numeric('snapshot_platform_fee_flat_php', { precision: 18, scale: 6 }).notNull(),
  snapshotPspFeeRate: numeric('snapshot_psp_fee_rate', { precision: 18, scale: 6 }).notNull(),

  // Prepaid package limits
  maxKwh: numeric('max_kwh', { precision: 18, scale: 6 }),
  maxDurationMin: integer('max_duration_min'),
  holdAmountPhp: numeric('hold_amount_php', { precision: 18, scale: 6 }).notNull(),

  // OCPP meter readings — stored as integer Wh; kWh computed in SQL (Law §1.4.7)
  meterStartWh: integer('meter_start_wh'),
  meterStopWh: integer('meter_stop_wh'),
  kwhDelivered: numeric('kwh_delivered', { precision: 18, scale: 6 }),

  // CSMS-assigned OCPP transactionId — persisted so StopTransaction can recover
  // the session after a process restart wipes the in-memory activeTransactions map.
  ocppTransactionId: integer('ocpp_transaction_id'),

  // Settlement amounts — all NUMERIC(18,6) (Law §1.4.4)
  energyChargePhp: numeric('energy_charge_php', { precision: 18, scale: 6 }),
  pspFeePhp: numeric('psp_fee_php', { precision: 18, scale: 6 }),
  netCollectPhp: numeric('net_collect_php', { precision: 18, scale: 6 }),
  hostSharePhp: numeric('host_share_php', { precision: 18, scale: 6 }),
  platformSharePhp: numeric('platform_share_php', { precision: 18, scale: 6 }),
  duReservePhp: numeric('du_reserve_php', { precision: 18, scale: 6 }),

  // Auth & lifecycle
  authExpiresAt: timestamp('auth_expires_at', { withTimezone: true }).notNull(),
  paymentClearedAt: timestamp('payment_cleared_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idTagIdx: index('sessions_id_tag_idx').on(t.idTag),
  chargePointIdx: index('sessions_charge_point_idx').on(t.chargePointId),
}));

// ─── Payments ─────────────────────────────────────────────────────────────────
// amount_php must be NUMERIC(18,6) — never float (Law §1.3.5)

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id),
  psp: pspEnum('psp').notNull(),
  externalId: text('external_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  amountPhp: numeric('amount_php', { precision: 18, scale: 6 }).notNull(),
  status: paymentStatusEnum('status').notNull().default('pending'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  rawPayload: jsonb('raw_payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idempotencyIdx: uniqueIndex('payments_idempotency_key_idx').on(t.idempotencyKey),
  externalIdIdx: index('payments_external_id_idx').on(t.externalId),
}));

// ─── Account Balances ─────────────────────────────────────────────────────────
// balance_php is NUMERIC(18,6) — never real/float8 (Law §1.4.5, §1.4.7)

export const accountBalances = pgTable('account_balances', {
  accountId: uuid('account_id').primaryKey(),
  role: splitRecipientRoleEnum('role').notNull(),
  balancePhp: numeric('balance_php', { precision: 18, scale: 6 }).notNull().default('0'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Ledger Entries ───────────────────────────────────────────────────────────
// Append-only; amount_php signed (credit positive) (Law §1.4.5)

export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id),
  recipientRole: splitRecipientRoleEnum('recipient_role').notNull(),
  amountPhp: numeric('amount_php', { precision: 18, scale: 6 }).notNull(),
  entryType: ledgerEntryTypeEnum('entry_type').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sessionIdx: index('ledger_entries_session_idx').on(t.sessionId),
}));

// ─── Disbursements ────────────────────────────────────────────────────────────

export const disbursements = pgTable('disbursements', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id),
  recipientRole: splitRecipientRoleEnum('recipient_role').notNull(),
  amountPhp: numeric('amount_php', { precision: 18, scale: 6 }).notNull(),
  status: disbursementStatusEnum('status').notNull().default('queued'),
  pspJobId: text('psp_job_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── OCPP Command Log ─────────────────────────────────────────────────────────
// Audit trail for all remote commands emitted by CSMS (Law §1.5.8)

export const ocppCommandLog = pgTable('ocpp_command_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  chargePointId: uuid('charge_point_id').notNull().references(() => chargePoints.id),
  action: ocppCommandActionEnum('action').notNull(),
  messageId: text('message_id').notNull(),
  payloadJson: jsonb('payload_json').notNull(),
  result: ocppCommandResultEnum('result'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  chargePointIdx: index('ocpp_command_log_charge_point_idx').on(t.chargePointId),
}));

// ─── Reconciliation Flags ─────────────────────────────────────────────────────

export const reconciliationFlags = pgTable('reconciliation_flags', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id),
  deltaPhp: numeric('delta_php', { precision: 18, scale: 6 }).notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Sovereign Operators ──────────────────────────────────────────────────────
// Free-vend maintenance mode requires row here — never a charge-point config flag (Law §1.5.2)

export const sovereignOperators = pgTable('sovereign_operators', {
  id: uuid('id').primaryKey().defaultRandom(),
  operatorName: text('operator_name').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
