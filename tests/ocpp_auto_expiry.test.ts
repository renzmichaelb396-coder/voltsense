// Unit test for the abandoned-session auto-expiry sweep on BootNotification
// (§Fix 2). Uses a call-order-aware fake db: expireAbandonedSessions always
// issues its two sessions-table checks (awaiting_payment, then
// payment_cleared) before resumePendingSessions' main retry query runs — so
// queuing responses per call, in that known order, proves the ordering
// requirement directly instead of trying to introspect drizzle predicates.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OcppConnection, type ChargePointRegistryLookup } from '../src/protocols/ocpp/ocpp_connection.js';
import * as schema from '../src/db/schema.js';
import type { SettlementDb } from '../src/services/settlement.js';

type SessionRow = typeof schema.sessions.$inferSelect;

function buildSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  const now = new Date();
  return {
    id: 'session-default',
    chargePointId: 'cp-1',
    connectorId: 1,
    status: 'payment_cleared',
    idTag: 'VS-guest-default',
    packageId: 'PKG_10KWH',
    snapshotDuRatePerKwh: '14.000000',
    snapshotHostMarginPerKwh: '8.000000',
    snapshotPlatformFeePerKwh: '7.000000',
    snapshotPlatformFeeFlatPhp: '0.000000',
    snapshotPspFeeRate: '0.020000',
    maxKwh: '10',
    maxDurationMin: null,
    holdAmountPhp: '290.000000',
    meterStartWh: null,
    meterStopWh: null,
    kwhDelivered: null,
    ocppTransactionId: null,
    energyChargePhp: null,
    pspFeePhp: null,
    netCollectPhp: null,
    hostSharePhp: null,
    platformSharePhp: null,
    duReservePhp: null,
    authExpiresAt: new Date(now.getTime() + 15 * 60 * 1000),
    paymentClearedAt: now,
    startedAt: null,
    stoppedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

type UpdateCall = { table: unknown; patch: Record<string, unknown>; order: number };

function makeQueueDb(sessionsQueue: unknown[][]): { db: SettlementDb; updateCalls: UpdateCall[] } {
  const updateCalls: UpdateCall[] = [];
  let sessionsCallIndex = 0;

  function chainFor(rows: unknown[]) {
    const chain = {
      from: (_t: unknown) => chain,
      where: (..._a: unknown[]) => chain,
      orderBy: (..._a: unknown[]) => chain,
      limit: async (n: number) => rows.slice(0, n),
      // expireAbandonedSessions deliberately queries without .limit() — mirror
      // Drizzle's real query builder, which is thenable at every stage, so
      // `await db.select().from(t).where(...)` resolves without needing .limit().
      then: (resolve: (rows: unknown[]) => void, reject: (err: unknown) => void) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return chain;
  }

  const fakeDb = {
    select: (_cols?: unknown) => ({
      from: (table: unknown) => {
        if (table === schema.sessions) {
          const rows = sessionsQueue[sessionsCallIndex] ?? [];
          sessionsCallIndex++;
          return chainFor(rows);
        }
        return chainFor([]);
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          updateCalls.push({ table, patch, order: updateCalls.length });
        },
      }),
    }),
  };

  return { db: fakeDb as unknown as SettlementDb, updateCalls };
}

function parseCallFrame(frame: string): { messageId: string; action: string; payload: unknown } {
  const [, messageId, action, payload] = JSON.parse(frame) as [number, string, string, unknown];
  return { messageId, action, payload };
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

describe('OcppConnection auto-expiry sweep', () => {
  let connection: OcppConnection;

  afterEach(() => {
    connection.onClose();
    vi.restoreAllMocks();
  });

  it('T_AUTO_EXPIRY: BootNotification clears a 2-hour-old awaiting_payment session before running retry logic', async () => {
    const staleAwaitingPayment = { id: 'session-stale-await' };
    const freshRetry = buildSessionRow({ id: 'session-fresh', idTag: 'VS-guest-fresh', status: 'payment_cleared' });

    const { db, updateCalls } = makeQueueDb([
      [staleAwaitingPayment], // 1st sessions select: expireAbandonedSessions' awaiting_payment check
      [], // 2nd sessions select: expireAbandonedSessions' payment_cleared check
      [freshRetry], // 3rd sessions select: resumePendingSessions' main retry query
      [], // 4th sessions select: warnStaleChargingSessions check
    ]);

    const sent: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    connection = new OcppConnection('cp-1', (frame) => { sent.push(frame); }, alwaysProvisioned, db);
    connection.onOpen();

    connection.onRawFrame(buildBootFrame());

    await vi.waitFor(() => {
      const remoteStart = sent.map(parseCallFrame).filter((c) => c.action === 'RemoteStartTransaction');
      expect(remoteStart).toHaveLength(1);
    });

    // The stale session's expiry update must be the FIRST db.update call —
    // proving expireAbandonedSessions ran to completion before the retry
    // sweep issued any RemoteStartTransaction.
    expect(updateCalls[0]).toMatchObject({
      table: schema.sessions,
      patch: { status: 'expired' },
    });
    expect(updateCalls).toHaveLength(1);

    await vi.waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('auto-expired 1 abandoned awaiting_payment session(s) chargePointId=cp-1'),
      );
    });

    // The fresh payment_cleared session is untouched by expiry and still retried normally.
    const remoteStart = sent.map(parseCallFrame).filter((c) => c.action === 'RemoteStartTransaction');
    expect((remoteStart[0]!.payload as { idTag: string }).idTag).toBe('VS-guest-fresh');
  });
});
