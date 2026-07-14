// Unit test for the brownout/restart StopTransaction recovery path (§Fix 1).
//
// Simulates the scenario named in the fix: the CSMS process restarted (or a
// brief network brownout dropped the connection), wiping OcppConnection's
// in-memory activeTransactions map. The charger reconnects and replays its
// queued StopTransaction for a transactionId that's only recoverable via the
// sessions table (ocpp_transaction_id + status='charging'), never via memory.
//
// executeRevenueSplitOrRefund is mocked out — this test only proves that the
// DB-fallback lookup finds the session and settlement is invoked, not the
// internals of the Decimal.js revenue split itself (covered elsewhere).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/refund.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/refund.js')>();
  return {
    ...actual,
    dispatchRefund: vi.fn(),
  };
});

vi.mock('../src/services/settlement.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/settlement.js')>();
  return {
    ...actual,
    executeRevenueSplitOrRefund: vi.fn(),
  };
});

import { OcppConnection, type ChargePointRegistryLookup } from '../src/protocols/ocpp/ocpp_connection.js';
import * as schema from '../src/db/schema.js';
import type { SettlementDb } from '../src/services/settlement.js';
import { executeRevenueSplitOrRefund } from '../src/services/settlement.js';

type SessionRow = typeof schema.sessions.$inferSelect;
type PaymentRow = typeof schema.payments.$inferSelect;

function makeFakeDb(
  sessionRow: SessionRow,
  paymentRow: PaymentRow,
): { db: SettlementDb } {
  function selectChainFor(rows: unknown[]) {
    const chain = {
      from: (_table: unknown) => chain,
      where: (..._args: unknown[]) => chain,
      orderBy: (..._args: unknown[]) => chain,
      limit: async (n: number) => rows.slice(0, n),
    };
    return chain;
  }

  const fakeDb = {
    select: (_cols?: unknown) => ({
      from: (table: unknown) => {
        if (table === schema.sessions) return selectChainFor([sessionRow]);
        if (table === schema.payments) return selectChainFor([paymentRow]);
        if (table === schema.chargePoints) return selectChainFor([{ siteId: 'site-1' }]);
        return selectChainFor([]);
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          if (table === schema.sessions) Object.assign(sessionRow as object, patch);
          if (table === schema.payments) Object.assign(paymentRow as object, patch);
        },
      }),
    }),
  };

  return { db: fakeDb as unknown as SettlementDb };
}

function buildStopFrame(transactionId: number, meterStop: number, timestamp: string): string {
  return JSON.stringify([2, 'stop-1', 'StopTransaction', { transactionId, meterStop, timestamp }]);
}

function buildBootFrame(): string {
  return JSON.stringify([
    2,
    'boot-1',
    'BootNotification',
    { chargePointVendor: 'VoltSense-Test', chargePointModel: 'Test-Model' },
  ]);
}

const alwaysProvisioned: ChargePointRegistryLookup = () => 'provisioned';

describe('OcppConnection StopTransaction brownout recovery', () => {
  let connection: OcppConnection;

  beforeEach(() => {
    process.env['PAYMONGO_SECRET_KEY'] = 'sk_test_fake_for_unit_tests';
    vi.mocked(executeRevenueSplitOrRefund).mockReset();
    vi.mocked(executeRevenueSplitOrRefund).mockResolvedValue({
      status: 'settled',
      split: {
        sessionId: 'session-brownout',
        energyChargePhp: '87.000000',
        pspFeePhp: '1.740000',
        hostSharePhp: '66.000000',
        platformSharePhp: '19.260000',
        duReservePhp: '42.000000',
      },
    });
  });

  afterEach(() => {
    connection.onClose();
    vi.restoreAllMocks();
  });

  it('T_BROWNOUT_STOP: transactionId found in DB but NOT in the in-memory map still runs full settlement', async () => {
    const now = new Date();

    // A fresh OcppConnection has an empty activeTransactions map — exactly
    // what happens after a Render restart mid-charge (or a brownout drops
    // the connection and it's rebuilt on reconnect). No StartTransaction was
    // ever processed by THIS connection instance; the only way to recover
    // the session is the DB fallback lookup by ocppTransactionId + status.
    const sessionRow: SessionRow = {
      id: 'session-brownout',
      chargePointId: 'cp-1',
      connectorId: 1,
      status: 'charging',
      idTag: 'VS-guest-brownout',
      packageId: 'PKG_FULL',
      snapshotDuRatePerKwh: '14.000000',
      snapshotHostMarginPerKwh: '8.000000',
      snapshotPlatformFeePerKwh: '7.000000',
      snapshotPlatformFeeFlatPhp: '0.000000',
      snapshotPspFeeRate: '0.020000',
      maxKwh: null,
      maxDurationMin: null,
      holdAmountPhp: '500.000000',
      meterStartWh: 0,
      meterStopWh: null,
      kwhDelivered: null,
      ocppTransactionId: 777,
      energyChargePhp: null,
      pspFeePhp: null,
      netCollectPhp: null,
      hostSharePhp: null,
      platformSharePhp: null,
      duReservePhp: null,
      authExpiresAt: new Date(now.getTime() + 15 * 60 * 1000),
      paymentClearedAt: now,
      startedAt: now,
      stoppedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const paymentRow: PaymentRow = {
      id: 'payment-brownout',
      sessionId: 'session-brownout',
      psp: 'paymongo',
      externalId: 'pay_brownout_1',
      idempotencyKey: 'idem-brownout-1',
      amountPhp: '500.000000',
      status: 'paid',
      paidAt: now,
      rawPayload: {},
      createdAt: now,
      updatedAt: now,
    };

    const { db } = makeFakeDb(sessionRow, paymentRow);
    connection = new OcppConnection('cp-1', () => {}, alwaysProvisioned, db);
    connection.onOpen();

    // BootNotification only to reach OPERATIONAL state (required before any
    // other Call is accepted) — deliberately no StartTransaction beforehand,
    // so activeTransactions never hears about transactionId=777 in memory.
    // The charger replays its queued StopTransaction straight into that gap.
    connection.onRawFrame(buildBootFrame());
    connection.onRawFrame(buildStopFrame(777, 3000, now.toISOString()));

    await vi.waitFor(() => {
      expect(executeRevenueSplitOrRefund).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: 'payment-brownout' }),
      );
    });

    await vi.waitFor(() => {
      expect(sessionRow.status).toBe('completed');
    });
    expect(sessionRow.kwhDelivered).toBe('3.000000');
  });
});
