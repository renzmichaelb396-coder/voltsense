// Atomic revenue split execution — Law §1.4 / §1.5.9
// All arithmetic via Decimal.js. No native JS + on money strings. No float variables.
// Inspector rule: any numeric type that is not Decimal or a NUMERIC(18,6) string = P0 violation.

import { Decimal } from 'decimal.js';
import { eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import * as schema from '../db/schema.js';
import { dispatchRefund, type RefundConfig, type RefundOutcome } from './refund.js';
import type { Psp } from '../webhooks/types.js';

// ─── §1.5.9 timeout constant ─────────────────────────────────────────────────
// Single source of truth for the StartTransaction.conf connection deadline.
// Any change here propagates to executeRevenueSplitWithTimeout and compliance test T-01.

export const SETTLEMENT_TIMEOUT_MS = 30_000;

// ─── SettlementTimeoutError ───────────────────────────────────────────────────
// Typed sentinel emitted when the 30 s gate fires before the split transaction
// commits. Carries paymentId so the catch block can build the RefundRequest
// without an additional DB lookup.

export class SettlementTimeoutError extends Error {
  readonly paymentId: string;

  constructor(paymentId: string) {
    super(
      `[SETTLEMENT TIMEOUT] StartTransaction.conf not received within ` +
      `${SETTLEMENT_TIMEOUT_MS.toString()}ms — paymentId=${paymentId}. ` +
      `Ledger settlement halted per Law §1.5.9.`,
    );
    this.name = 'SettlementTimeoutError';
    this.paymentId = paymentId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Decimal.js global config ─────────────────────────────────────────────────
// ROUND_HALF_UP matches the spec (§1.4.4). Precision 18 matches NUMERIC(18,6).
// Set once at module load — never mutated per-call.

Decimal.set({ precision: 18, rounding: Decimal.ROUND_HALF_UP });

// ─── DB type ──────────────────────────────────────────────────────────────────
// Accepts any Drizzle PostgreSQL adapter (postgres-js, node-postgres, etc.).
// Table-reference queries (select().from(), insert().into()) work on all adapters.

export type SettlementDb = PgDatabase<PgQueryResultHKT>;

// ─── PLATFORM_ACCOUNT_ID ─────────────────────────────────────────────────────
// Well-known UUID for VoltSense's platform vault in account_balances.
// Must be seeded in the database before settlement runs.

export const PLATFORM_ACCOUNT_ID = '00000000-0000-0000-0000-000000000001' as const;

// ─── Result type ──────────────────────────────────────────────────────────────
// All amounts are NUMERIC(18,6) string representations — never JS numbers.

export type RevenueSplitResult = {
  sessionId: string;
  energyChargePhp: string;
  pspFeePhp: string;
  hostSharePhp: string;
  platformSharePhp: string;
  duReservePhp: string;
};

// ─── Settlement invariant assertion ──────────────────────────────────────────
// Unconditional: throws if (host_share + platform_share_net + psp_fee) diverges
// from energy_charge by more than 0.000001 PHP. Platform absorbs the PSP fee, so
// the three-way split — not host + platform alone — must reconstitute energy_charge.
// Catches formula regressions before any DB mutation commits.
// Computed on unrounded Decimal values to ensure sub-cent precision (R-01, R-02).

function assertSettlementInvariant(
  hostShare: Decimal,
  platformShareNet: Decimal,
  pspFee: Decimal,
  energyCharge: Decimal,
): void {
  const splitSum = hostShare.plus(platformShareNet).plus(pspFee);
  const delta = energyCharge.minus(splitSum).abs();
  const TOLERANCE = new Decimal('0.000001');

  if (delta.greaterThan(TOLERANCE)) {
    throw new Error(
      `[SPLIT INVARIANT VIOLATION] ` +
      `host=${hostShare.toFixed(6)} + platformNet=${platformShareNet.toFixed(6)} + pspFee=${pspFee.toFixed(6)} ` +
      `= ${splitSum.toFixed(6)}, expected energy_charge=${energyCharge.toFixed(6)}, ` +
      `delta=${delta.toFixed(8)} exceeds tolerance 0.000001`,
    );
  }
}

// ─── executeRevenueSplit ──────────────────────────────────────────────────────
// Runs inside a single SERIALIZABLE-like pg transaction. Either all mutations
// commit or none do — no partial balance updates or orphaned ledger rows.
//
// Parameters:
//   db          — Drizzle PostgreSQL database instance (injected for testability)
//   paymentId   — UUID of the payments row that triggered settlement
//   totalAmount — energy_charge_php as NUMERIC string; validated against DB record
//   stationId   — site UUID (maps to tariffs.site_id); used to read current tariff
//
// Returns the computed split amounts as NUMERIC(18,6) strings for the caller's log.

export async function executeRevenueSplit(
  db: SettlementDb,
  paymentId: string,
  totalAmount: string,
  stationId: string,
): Promise<RevenueSplitResult> {
  return db.transaction(async (tx) => {

    // ── Step 1: Load payment and validate totalAmount against persisted record ──
    const paymentRows = await tx
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, paymentId))
      .limit(1);

    const payment = paymentRows[0];
    if (!payment) {
      throw new Error(`[SETTLEMENT] Payment not found: paymentId=${paymentId}`);
    }

    // totalAmount must equal the payment record — rejects replay with tampered amount.
    const totalDec = new Decimal(totalAmount);
    const recordedDec = new Decimal(payment.amountPhp);
    if (!totalDec.eq(recordedDec)) {
      throw new Error(
        `[SETTLEMENT] totalAmount mismatch: ` +
        `passed=${totalAmount} record=${payment.amountPhp} paymentId=${paymentId}`,
      );
    }

    // ── Step 2: Load session — kwhDelivered must be set (StopTransaction precedes settlement) ──
    const sessionRows = await tx
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, payment.sessionId))
      .limit(1);

    const session = sessionRows[0];
    if (!session) {
      throw new Error(
        `[SETTLEMENT] Session not found: sessionId=${payment.sessionId} paymentId=${paymentId}`,
      );
    }

    // ── Idempotency guard: a repeat StopTransaction must never re-run the split ──
    // executeRevenueSplit already committed for this session iff energyChargePhp is
    // set (Step 9 below is the only writer). Replaying past this point would
    // double-credit host/platform balances and duplicate ledger rows.
    if (session.energyChargePhp !== null) {
      return {
        sessionId: session.id,
        energyChargePhp: session.energyChargePhp,
        pspFeePhp: session.pspFeePhp ?? '0',
        hostSharePhp: session.hostSharePhp ?? '0',
        platformSharePhp: session.platformSharePhp ?? '0',
        duReservePhp: session.duReservePhp ?? '0',
      };
    }

    if (session.kwhDelivered === null) {
      throw new Error(
        `[SETTLEMENT] kwhDelivered is null on session=${session.id} — ` +
        `StopTransaction must complete before settlement can run`,
      );
    }

    // ── Step 3: Extract immutable tariff snapshot from session row (§1.4.4) ──
    // Rates were snapshot-copied from tariffs at session create and are frozen for
    // the session lifetime — live tariff changes cannot retroactively affect in-flight sessions.

    // ── Step 4: Decimal.js arithmetic — zero native float operators on money ──
    // All inputs read as strings from NUMERIC(18,6) snapshot columns on the session row.
    // All intermediate values stay as Decimal instances until .toFixed(6) for storage.

    const kwh = new Decimal(session.kwhDelivered);
    const duRate = new Decimal(session.snapshotDuRatePerKwh);
    const hostMargin = new Decimal(session.snapshotHostMarginPerKwh);
    const platformPerKwh = new Decimal(session.snapshotPlatformFeePerKwh);
    const platformFlat = new Decimal(session.snapshotPlatformFeeFlatPhp);
    const pspFeeRate = new Decimal(session.snapshotPspFeeRate);

    // tariff_total_per_kwh = du_rate + host_margin + platform_fee_per_kwh (§1.4.3)
    const tariffTotalPerKwh = duRate.plus(hostMargin).plus(platformPerKwh);

    // energy_charge = kwh × tariff_total + flat (§1.4.4)
    const energyChargeDec = kwh.times(tariffTotalPerKwh).plus(platformFlat);

    // psp_fee = energy_charge × psp_fee_rate (§1.4.4)
    const pspFeeDec = energyChargeDec.times(pspFeeRate);

    // host_share = kwh × (du_rate + host_margin) — Meralco base + host premium (§1.4.4)
    const hostShareDec = kwh.times(duRate.plus(hostMargin));

    // platform_share = kwh × platform_fee_per_kwh + platform_fee_flat (§1.4.4)
    const platformShareDec = kwh.times(platformPerKwh).plus(platformFlat);

    // platform_share_net = platform_share − psp_fee — the platform absorbs the PSP
    // fee rather than it going unaccounted for between host and platform (§1.4.4).
    const platformShareNetDec = platformShareDec.minus(pspFeeDec);

    // du_reserve = kwh × du_rate — Meralco accrual within host_share (§1.4.4, §1.4.6)
    const duReserveDec = kwh.times(duRate);

    // net_collect = energy_charge − psp_fee — amount entering the split pool (§1.4.4)
    const netCollectDec = energyChargeDec.minus(pspFeeDec);

    // ── Step 4b: Cap at what PayMongo actually collected (sampling-gap overage) ──
    // MeterValues sampling can lag the enforced kWh cutoff, so kwh × tariff
    // occasionally computes an energy_charge above payment.amountPhp. Scale every
    // split component by the same factor so host_share + platform_share_net +
    // psp_fee never exceeds the collected amount — the excess kWh is real energy
    // delivered but is not monetized to host/platform. Scaling uniformly preserves
    // the invariant identity exactly (it held for the unscaled values by construction).

    let energyChargeFinalDec = energyChargeDec;
    let pspFeeFinalDec = pspFeeDec;
    let hostShareFinalDec = hostShareDec;
    let platformShareNetFinalDec = platformShareNetDec;
    let duReserveFinalDec = duReserveDec;
    let netCollectFinalDec = netCollectDec;

    if (energyChargeDec.greaterThan(totalDec)) {
      const capScale = totalDec.dividedBy(energyChargeDec);
      energyChargeFinalDec = totalDec;
      pspFeeFinalDec = pspFeeDec.times(capScale);
      hostShareFinalDec = hostShareDec.times(capScale);
      platformShareNetFinalDec = platformShareNetDec.times(capScale);
      duReserveFinalDec = duReserveDec.times(capScale);
      netCollectFinalDec = netCollectDec.times(capScale);

      console.warn(
        `[voltsense:settle] SETTLEMENT CAP TRIGGERED session=${session.id} ` +
        `kwhEnergyCharge=${energyChargeDec.toFixed(6)} exceeds collected=${totalDec.toFixed(6)} — ` +
        `capped split to collected amount, excess kWh not monetized`,
      );
    }

    // ── Step 5: Unconditional settlement invariant assert (§1.4.4) ──────────────
    // host_share + platform_share_net + psp_fee = energy_charge holds exactly in
    // Decimal.js because no intermediate rounding has been applied yet.
    // Throws inside the transaction — any violation triggers full rollback.

    assertSettlementInvariant(hostShareFinalDec, platformShareNetFinalDec, pspFeeFinalDec, energyChargeFinalDec);

    // Round all values to 6 decimal places for DB storage (NUMERIC(18,6))
    const energyChargePhp = energyChargeFinalDec.toDecimalPlaces(6).toFixed(6);
    const pspFeePhp = pspFeeFinalDec.toDecimalPlaces(6).toFixed(6);
    const netCollectPhp = netCollectFinalDec.toDecimalPlaces(6).toFixed(6);
    const hostSharePhp = hostShareFinalDec.toDecimalPlaces(6).toFixed(6);
    const platformSharePhp = platformShareNetFinalDec.toDecimalPlaces(6).toFixed(6);
    const duReservePhp = duReserveFinalDec.toDecimalPlaces(6).toFixed(6);

    // Host account ID: in v1 the stationId (siteId) is used as the host account key.
    // Production: replace with a lookup against a host_accounts table.
    const hostAccountId = stationId;

    // ── Step 6: Credit host balance — atomic upsert (§1.4.5) ──────────────────
    // Covers Meralco DU base cost + host margin; host remits DU portion to Meralco.
    // balance_php accumulation via SQL arithmetic — never read-modify-write in JS.

    await tx
      .insert(schema.accountBalances)
      .values({
        accountId: hostAccountId,
        role: 'site_host',
        balancePhp: hostSharePhp,
      })
      .onConflictDoUpdate({
        target: schema.accountBalances.accountId,
        set: {
          balancePhp: sql`account_balances.balance_php + ${hostSharePhp}::numeric`,
          updatedAt: new Date(),
        },
      });

    // ── Step 7: Credit platform vault balance — atomic upsert (§1.4.5) ─────────

    await tx
      .insert(schema.accountBalances)
      .values({
        accountId: PLATFORM_ACCOUNT_ID,
        role: 'platform',
        balancePhp: platformSharePhp,
      })
      .onConflictDoUpdate({
        target: schema.accountBalances.accountId,
        set: {
          balancePhp: sql`account_balances.balance_php + ${platformSharePhp}::numeric`,
          updatedAt: new Date(),
        },
      });

    // ── Step 8: Append signed ledger line-items — never delete or update (§1.4.5) ──
    // host split and platform split are credits (+). PSP fee is a deduction (−).
    // Negated PSP fee stored so nightly reconciliation can sum rows to zero-net.

    const pspFeeDeduction = pspFeeDec.negated().toDecimalPlaces(6).toFixed(6);

    await tx.insert(schema.ledgerEntries).values([
      {
        sessionId: session.id,
        recipientRole: 'site_host',
        amountPhp: hostSharePhp,
        entryType: 'split',
      },
      {
        sessionId: session.id,
        recipientRole: 'platform',
        amountPhp: platformSharePhp,
        entryType: 'split',
      },
      {
        sessionId: session.id,
        recipientRole: 'psp_fee',
        amountPhp: pspFeeDeduction,  // negative — deduction from gross collection
        entryType: 'psp_fee',
      },
    ]);

    // ── Step 9: Write settlement amounts back to session row (§1.4.4) ──────────
    // Persists all computed split amounts so the session row is the audit source of truth.

    await tx
      .update(schema.sessions)
      .set({
        energyChargePhp,
        pspFeePhp,
        netCollectPhp,
        hostSharePhp,
        platformSharePhp,
        duReservePhp,
        updatedAt: new Date(),
      })
      .where(eq(schema.sessions.id, session.id));

    return {
      sessionId: session.id,
      energyChargePhp,
      pspFeePhp,
      hostSharePhp,
      platformSharePhp,
      duReservePhp,
    };
  });
}

// ─── executeRevenueSplitWithTimeout ──────────────────────────────────────────
// Wraps executeRevenueSplit in a Promise.race against SETTLEMENT_TIMEOUT_MS.
// The finally block always clears the timer so no resource leak occurs when
// the settlement resolves before the deadline (compliance test T-04).
//
// On timeout, rejects with SettlementTimeoutError — caller must catch and
// dispatch a PSP reversal; never swallow this error.

export async function executeRevenueSplitWithTimeout(
  db: SettlementDb,
  paymentId: string,
  totalAmount: string,
  stationId: string,
): Promise<RevenueSplitResult> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutGate = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new SettlementTimeoutError(paymentId));
    }, SETTLEMENT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      executeRevenueSplit(db, paymentId, totalAmount, stationId),
      timeoutGate,
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ─── executeRevenueSplitOrRefund ─────────────────────────────────────────────
// Top-level orchestrator per Law §1.5.9.
// Timeout cancellation catch block: catches any settlement failure (including
// the 30 s gate) and immediately dispatches a PSP reversal via dispatchRefund.
//
// Returns a discriminated result so callers can log, alert ops, or retry:
//   'settled'       — split committed, no refund needed
//   'refunded'      — PSP confirmed reversal; update payments.status = 'refunded'
//   'refund_failed' — PSP reversal failed; alert ops, leave payments.status for retry job

export type SettlementWithRefundOptions = {
  db: SettlementDb;
  paymentId: string;
  totalAmount: string;
  stationId: string;
  psp: Psp;
  externalId: string;      // PSP's original transaction ID — needed for reversal call
  refundConfig: RefundConfig;
};

export type SettlementWithRefundResult =
  | { status: 'settled'; split: RevenueSplitResult }
  | { status: 'refunded'; refund: RefundOutcome }
  | { status: 'refund_failed'; refund: RefundOutcome; originalError: string };

export async function executeRevenueSplitOrRefund(
  opts: SettlementWithRefundOptions,
): Promise<SettlementWithRefundResult> {
  try {
    const split = await executeRevenueSplitWithTimeout(
      opts.db,
      opts.paymentId,
      opts.totalAmount,
      opts.stationId,
    );
    return { status: 'settled', split };
  } catch (err) {
    // ── Timeout cancellation catch block (§1.5.9) ────────────────────────────
    // Reaches here on: SettlementTimeoutError (30 s gate), DB error, invariant
    // violation, or any other settlement failure. All paths trigger a PSP reversal.

    const settlementError = err instanceof Error ? err : new Error(String(err));
    const refundReason = err instanceof SettlementTimeoutError
      ? 'hardware_timeout'
      : 'charger_offline';

    const refund = await dispatchRefund(
      {
        paymentId: opts.paymentId,
        psp: opts.psp,
        externalId: opts.externalId,
        amountPhp: opts.totalAmount,
        reason: refundReason,
      },
      opts.refundConfig,
    );

    if (refund.outcome === 'success') {
      await opts.db
        .update(schema.payments)
        .set({ status: 'refunded', updatedAt: new Date() })
        .where(eq(schema.payments.id, opts.paymentId));
      return { status: 'refunded', refund };
    }

    return { status: 'refund_failed', refund, originalError: settlementError.message };
  }
}
