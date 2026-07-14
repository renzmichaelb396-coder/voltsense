// Unit test for the partial-refund gate on StopTransaction (§Fix 3).
//
// Mirrors the fake-db style established in ocpp_connection_boot_retry.test.ts:
// no real Postgres wired in, so this proves OcppConnection's partial-refund
// orchestration (amount computed, dispatchRefund called with the right
// arguments, payments.status flipped to 'partially_refunded' on success) —
// not that the underlying SQL predicates are correct against a real table.
//
// executeRevenueSplitOrRefund is mocked out entirely: this test only exercises
// the NEW partial-refund branch in settleStopTransaction, not the full
// Decimal.js revenue-split transaction (that has its own coverage elsewhere).

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
import { dispatchRefund } from '../src/services/refund.js';
import { executeRevenueSplitOrRefund } from '../src/services/settlement.js';

type SessionRow = typeof schema.sessions.$inferSelect;
type PaymentRow = typeof schema.payments.$inferSelect;

type UpdateCall = { table: unknown; patch: Record<string, unknown> };

function makeFakeDb(
  sessionRow: SessionRow,
  paymentRow: PaymentRow,
): { db: SettlementDb; updateCalls: UpdateCall[] } {
  const updateCalls: UpdateCall[] = [];

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
          updateCalls.push({ table, patch });
          if (table === schema.sessions) Object.assign(sessionRow as object, patch);
          if (table === schema.payments) Object.assign(paymentRow as object, patch);
        },
      }),
    }),
  };

  return { db: fakeDb as unknown as SettlementDb, updateCalls };
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

describe('OcppConnection partial refund on StopTransaction', () => {
  let connection: OcppConnection;

  beforeEach(() => {
    process.env['PAYMONGO_SECRET_KEY'] = 'sk_test_fake_for_unit_tests';
    vi.mocked(dispatchRefund).mockReset();
    vi.mocked(executeRevenueSplitOrRefund).mockReset();
    vi.mocked(executeRevenueSplitOrRefund).mockResolvedValue({
      status: 'settled',
      split: {
        sessionId: 'session-1',
        energyChargePhp: '43.500000',
        pspFeePhp: '0.870000',
        hostSharePhp: '33.000000',
        platformSharePhp: '9.630000',
        duReservePhp: '21.000000',
      },
    });
  });

  afterEach(() => {
    connection.onClose();
    vi.restoreAllMocks();
  });

  it('T_PARTIAL_REFUND: PKG_5KWH session delivering 1.5 kWh refunds the unused 3.5 kWh and marks the payment partially_refunded', async () => {
    const now = new Date();

    const sessionRow: SessionRow = {
      id: 'session-1',
      chargePointId: 'cp-1',
      connectorId: 1,
      status: 'charging',
      idTag: 'VS-guest-partial',
      packageId: 'PKG_5KWH',
      snapshotDuRatePerKwh: '14.000000',
      snapshotHostMarginPerKwh: '8.000000',
      snapshotPlatformFeePerKwh: '7.000000',
      snapshotPlatformFeeFlatPhp: '0.000000',
      snapshotPspFeeRate: '0.020000',
      maxKwh: '5.000000',
      maxDurationMin: null,
      holdAmountPhp: '145.000000',
      meterStartWh: 0,
      meterStopWh: null,
      kwhDelivered: null,
      ocppTransactionId: 555,
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
      id: 'payment-1',
      sessionId: 'session-1',
      psp: 'paymongo',
      externalId: 'pay_test_123',
      idempotencyKey: 'idem-1',
      amountPhp: '145.000000',
      status: 'paid',
      paidAt: now,
      rawPayload: {},
      createdAt: now,
      updatedAt: now,
    };

    vi.mocked(dispatchRefund).mockResolvedValue({
      outcome: 'success',
      psp: 'paymongo',
      refundId: 'refund_test_1',
      refundedAmountPhp: '101.500000',
      processedAt: now.toISOString(),
    });

    const { db, updateCalls } = makeFakeDb(sessionRow, paymentRow);
    connection = new OcppConnection('cp-1', () => {}, alwaysProvisioned, db);
    connection.onOpen();

    connection.onRawFrame(buildBootFrame());
    connection.onRawFrame(buildStopFrame(555, 1500, now.toISOString()));

    // refundAmount = Math.round(3.5 kWh unused * ₱29/kWh * 100) = 10150 cents = ₱101.50
    await vi.waitFor(() => {
      expect(dispatchRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId: 'payment-1',
          reason: 'partial_kwh',
          amountPhp: '101.500000',
        }),
        expect.anything(),
      );
    });

    await vi.waitFor(() => {
      expect(paymentRow.status).toBe('partially_refunded');
    });

    const paymentUpdate = updateCalls.find((c) => c.table === schema.payments && 'status' in c.patch);
    expect(paymentUpdate?.patch).toMatchObject({ status: 'partially_refunded' });
  });
});
