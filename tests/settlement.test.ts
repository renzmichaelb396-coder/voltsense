// Unit tests for executeRevenueSplit (src/services/settlement.ts).
//
// Fake-db style mirrors tests/ocpp_partial_refund.test.ts: no real Postgres
// wired in. db.transaction(cb) is stubbed to invoke cb with a fake tx object
// backing select/insert/update against in-memory rows, so these tests prove
// the Decimal.js split math and the sampling-gap overage cap — not that the
// underlying SQL predicates are correct against a real table.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from 'decimal.js';

import * as schema from '../src/db/schema.js';
import { executeRevenueSplit, type SettlementDb } from '../src/services/settlement.js';

type SessionRow = typeof schema.sessions.$inferSelect;
type PaymentRow = typeof schema.payments.$inferSelect;

function makeFakeDb(sessionRow: SessionRow, paymentRow: PaymentRow) {
  const sessionUpdates: Record<string, unknown>[] = [];
  const balanceUpserts: Record<string, unknown>[] = [];
  const ledgerInserts: Record<string, unknown>[] = [];

  function selectChainFor(rows: unknown[]) {
    const chain = {
      from: (_table: unknown) => chain,
      where: (..._args: unknown[]) => chain,
      limit: async (n: number) => rows.slice(0, n),
    };
    return chain;
  }

  const tx = {
    select: (_cols?: unknown) => ({
      from: (table: unknown) => {
        if (table === schema.payments) return selectChainFor([paymentRow]);
        if (table === schema.sessions) return selectChainFor([sessionRow]);
        return selectChainFor([]);
      },
    }),
    insert: (table: unknown) => ({
      values: (v: unknown) => {
        if (table === schema.ledgerEntries) {
          ledgerInserts.push(...(Array.isArray(v) ? (v as Record<string, unknown>[]) : [v as Record<string, unknown>]));
          return Promise.resolve();
        }
        // accountBalances — insert().values().onConflictDoUpdate() chain
        return {
          onConflictDoUpdate: async (_opts: unknown) => {
            balanceUpserts.push(v as Record<string, unknown>);
          },
        };
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          if (table === schema.sessions) {
            sessionUpdates.push(patch);
            Object.assign(sessionRow as object, patch);
          }
        },
      }),
    }),
  };

  const fakeDb = {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(tx),
  };

  return {
    db: fakeDb as unknown as SettlementDb,
    sessionUpdates,
    balanceUpserts,
    ledgerInserts,
  };
}

function buildRows(overrides: { amountPhp: string; kwhDelivered: string }): {
  sessionRow: SessionRow;
  paymentRow: PaymentRow;
} {
  const now = new Date();

  const sessionRow: SessionRow = {
    id: 'session-1',
    chargePointId: 'cp-1',
    connectorId: 1,
    status: 'charging',
    idTag: 'VS-guest-1',
    packageId: 'PKG_CUSTOM',
    phoneNumber: null,
    snapshotDuRatePerKwh: '14.000000',
    snapshotHostMarginPerKwh: '8.000000',
    snapshotPlatformFeePerKwh: '7.000000',
    snapshotPlatformFeeFlatPhp: '0.000000',
    snapshotPspFeeRate: '0.020000',
    maxKwh: null,
    maxDurationMin: null,
    holdAmountPhp: overrides.amountPhp,
    meterStartWh: 0,
    meterStopWh: null,
    kwhDelivered: overrides.kwhDelivered,
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
    amountPhp: overrides.amountPhp,
    status: 'paid',
    paidAt: now,
    rawPayload: {},
    createdAt: now,
    updatedAt: now,
  };

  return { sessionRow, paymentRow };
}

const STATION_ID = '11111111-1111-1111-1111-111111111111';

describe('executeRevenueSplit', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T_NO_OVERAGE: kwh-based charge equal to collected amount splits unchanged and never logs a cap', async () => {
    // 1.5 kWh @ tariff 29/kWh = 43.5 — exactly what was collected, no overage.
    const { sessionRow, paymentRow } = buildRows({ amountPhp: '43.500000', kwhDelivered: '1.500000' });
    const { db, sessionUpdates, balanceUpserts } = makeFakeDb(sessionRow, paymentRow);

    const result = await executeRevenueSplit(db, 'payment-1', '43.500000', STATION_ID);

    expect(result).toEqual({
      sessionId: 'session-1',
      energyChargePhp: '43.500000',
      pspFeePhp: '0.870000',
      hostSharePhp: '33.000000',
      platformSharePhp: '9.630000',
      duReservePhp: '21.000000',
    });

    expect(sessionUpdates[0]).toMatchObject({ energyChargePhp: '43.500000', hostSharePhp: '33.000000' });
    expect(balanceUpserts).toHaveLength(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('T_OVERAGE_CAP: kwh-based charge exceeding collected amount is capped so host+platform+psp never exceed it', async () => {
    // Same 1.5 kWh / 29 tariff → uncapped energy_charge = 43.5, but PayMongo only
    // collected 40.00 (sampling-gap overage). Split must cap to 40.00 exactly.
    const { sessionRow, paymentRow } = buildRows({ amountPhp: '40.000000', kwhDelivered: '1.500000' });
    const { db, sessionUpdates, balanceUpserts } = makeFakeDb(sessionRow, paymentRow);

    const result = await executeRevenueSplit(db, 'payment-1', '40.000000', STATION_ID);

    expect(result.energyChargePhp).toBe('40.000000');

    const capScale = new Decimal('40').dividedBy('43.5');
    const expectedPspFee = new Decimal('0.87').times(capScale).toDecimalPlaces(6).toFixed(6);
    const expectedHostShare = new Decimal('33').times(capScale).toDecimalPlaces(6).toFixed(6);
    const expectedPlatformShareNet = new Decimal('9.63').times(capScale).toDecimalPlaces(6).toFixed(6);
    const expectedDuReserve = new Decimal('21').times(capScale).toDecimalPlaces(6).toFixed(6);

    expect(result.pspFeePhp).toBe(expectedPspFee);
    expect(result.hostSharePhp).toBe(expectedHostShare);
    expect(result.platformSharePhp).toBe(expectedPlatformShareNet);
    expect(result.duReservePhp).toBe(expectedDuReserve);

    // The uncapped kwh math (43.5) must never be monetized — invariant holds against
    // the CAPPED collected amount, not the larger kwh-derived figure.
    const splitSum = new Decimal(result.hostSharePhp)
      .plus(result.platformSharePhp)
      .plus(result.pspFeePhp);
    expect(splitSum.minus('40').abs().lessThanOrEqualTo('0.00001')).toBe(true);
    expect(splitSum.lessThanOrEqualTo('40.000001')).toBe(true);

    expect(sessionUpdates[0]).toMatchObject({ energyChargePhp: '40.000000' });
    expect(balanceUpserts).toHaveLength(2);
    expect(balanceUpserts.find((b) => b['role'] === 'site_host')).toMatchObject({ balancePhp: expectedHostShare });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SETTLEMENT CAP TRIGGERED'));
  });
});
