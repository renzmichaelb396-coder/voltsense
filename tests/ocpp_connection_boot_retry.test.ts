// Unit tests for OcppConnection's BootNotification retry sweep.
//
// No real Postgres instance is wired into this repo yet, so `db` is a hand-rolled
// fake that only supports the select().from().where().orderBy().limit() chain
// resumePendingSessions actually calls. It proves OcppConnection's retry
// orchestration (ack-first, sequential per-session retry, failure isolation,
// LIMIT respected) — it does NOT prove the WHERE/ORDER BY clause is correct SQL
// against a real sessions table. That would need an integration test against
// real Postgres, which this project doesn't have set up.

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

function makeFakeDb(rows: SessionRow[]): { db: SettlementDb; limitCalls: number[] } {
  const limitCalls: number[] = [];
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async (n: number) => {
      limitCalls.push(n);
      return rows.slice(0, n);
    },
  };
  const fakeDb = { select: () => chain };
  return { db: fakeDb as unknown as SettlementDb, limitCalls };
}

type ParsedCall = { messageId: string; action: string; payload: unknown };

function parseCallFrame(frame: string): ParsedCall {
  const [, messageId, action, payload] = JSON.parse(frame) as [number, string, string, unknown];
  return { messageId, action, payload };
}

function buildCpCallFrame(action: string, messageId: string, payload: unknown): string {
  return JSON.stringify([2, messageId, action, payload]);
}

function buildCallResultFrame(messageId: string, payload: unknown): string {
  return JSON.stringify([3, messageId, payload]);
}

function buildCallErrorFrame(messageId: string): string {
  return JSON.stringify([4, messageId, 'GenericError', 'simulated failure', {}]);
}

function remoteStartFrames(sent: string[]): ParsedCall[] {
  return sent.map(parseCallFrame).filter((c) => c.action === 'RemoteStartTransaction');
}

const alwaysProvisioned: ChargePointRegistryLookup = () => 'provisioned';

const BOOT_PAYLOAD = {
  chargePointVendor: 'VoltSense-Test',
  chargePointModel: 'Test-Model',
  chargePointSerialNumber: 'SN-0001',
  firmwareVersion: '1.0.0',
};

describe('OcppConnection BootNotification retry', () => {
  let connection: OcppConnection;
  let sent: string[];

  afterEach(() => {
    connection.onClose();
    vi.restoreAllMocks();
  });

  function setUpConnection(db: SettlementDb): void {
    sent = [];
    connection = new OcppConnection('cp-1', (frame) => { sent.push(frame); }, alwaysProvisioned, db);
    connection.onOpen();
  }

  it('accepts BootNotification synchronously without waiting on the retry sweep', () => {
    const { db } = makeFakeDb([buildSessionRow()]);
    setUpConnection(db);

    const response = connection.onRawFrame(buildCpCallFrame('BootNotification', 'boot-1', BOOT_PAYLOAD));

    expect(response).not.toBeNull();
    const parsed = JSON.parse(response as string) as [number, string, { status: string }];
    expect(parsed[2].status).toBe('Accepted');
    // Fire-and-forget: the retry sweep is still awaiting the (async) DB lookup
    // at this point, so no RemoteStartTransaction should have been sent yet.
    // (A ChangeConfiguration frame for MeterValueSampleInterval IS sent
    // synchronously as part of BootNotification handling — that's expected.)
    expect(remoteStartFrames(sent)).toHaveLength(0);
  });

  it('retries RemoteStartTransaction for each pending session, sequentially', async () => {
    const pending = [
      buildSessionRow({ id: 'session-1', idTag: 'VS-guest-1', connectorId: 1, status: 'payment_cleared' }),
      buildSessionRow({ id: 'session-2', idTag: 'VS-guest-2', connectorId: 2, status: 'paid_charger_offline' }),
    ];
    const { db } = makeFakeDb(pending);
    setUpConnection(db);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    connection.onRawFrame(buildCpCallFrame('BootNotification', 'boot-1', BOOT_PAYLOAD));

    // Session 1 goes out first — session 2 must NOT be sent until session 1's
    // RemoteStartTransaction settles (the sweep awaits each retry in order).
    await vi.waitFor(() => expect(remoteStartFrames(sent)).toHaveLength(1));
    let calls = remoteStartFrames(sent);
    expect(calls[0]?.payload).toEqual({ connectorId: 1, idTag: 'VS-guest-1' });
    connection.onRawFrame(buildCallResultFrame(calls[0]!.messageId, { status: 'Accepted' }));

    await vi.waitFor(() => expect(remoteStartFrames(sent)).toHaveLength(2));
    calls = remoteStartFrames(sent);
    expect(calls[1]?.payload).toEqual({ connectorId: 2, idTag: 'VS-guest-2' });
    connection.onRawFrame(buildCallResultFrame(calls[1]!.messageId, { status: 'Accepted' }));

    await vi.waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('sessionId=session-1 chargePointId=cp-1 outcome=Accepted'),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('sessionId=session-2 chargePointId=cp-1 outcome=Accepted'),
      );
    });
  });

  it('logs and continues past a failed retry, without throwing or crashing the connection', async () => {
    const pending = [
      buildSessionRow({ id: 'session-fail', idTag: 'VS-guest-fail', connectorId: 1 }),
      buildSessionRow({ id: 'session-ok', idTag: 'VS-guest-ok', connectorId: 2 }),
    ];
    const { db } = makeFakeDb(pending);
    setUpConnection(db);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    connection.onRawFrame(buildCpCallFrame('BootNotification', 'boot-1', BOOT_PAYLOAD));

    await vi.waitFor(() => expect(remoteStartFrames(sent)).toHaveLength(1));
    let calls = remoteStartFrames(sent);
    expect((calls[0]!.payload as { idTag: string }).idTag).toBe('VS-guest-fail');
    connection.onRawFrame(buildCallErrorFrame(calls[0]!.messageId));

    // The failure above must not stop the sweep — session-ok still gets retried.
    await vi.waitFor(() => expect(remoteStartFrames(sent)).toHaveLength(2));
    calls = remoteStartFrames(sent);
    connection.onRawFrame(buildCallResultFrame(calls[1]!.messageId, { status: 'Accepted' }));

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('sessionId=session-fail'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('sessionId=session-ok'));
    });

    expect(connection.getState()).toBe('OPERATIONAL');
  });

  it('caps the retry sweep at 5 sessions', async () => {
    const pending = Array.from({ length: 8 }, (_, i) =>
      buildSessionRow({ id: `session-${i}`, idTag: `VS-guest-${i}`, connectorId: 1 }),
    );
    const { db, limitCalls } = makeFakeDb(pending);
    setUpConnection(db);

    connection.onRawFrame(buildCpCallFrame('BootNotification', 'boot-1', BOOT_PAYLOAD));

    for (let expected = 1; expected <= 5; expected++) {
      await vi.waitFor(() => expect(remoteStartFrames(sent)).toHaveLength(expected));
      const calls = remoteStartFrames(sent);
      const latest = calls[calls.length - 1]!;
      connection.onRawFrame(buildCallResultFrame(latest.messageId, { status: 'Accepted' }));
    }

    // Give the (already-satisfied) sweep a beat to prove it stops at 5.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(remoteStartFrames(sent)).toHaveLength(5);
    expect(limitCalls).toEqual([5]);
  });
});
