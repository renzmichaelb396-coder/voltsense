// DC Fast Charger simulation harness — VoltSense §3 Fiscal Invariants
// Simulates a 30 kW DC unit against OcppConnection with decimal.js-only money math.
// Inspector rule: no native float ops on kWh/PHP. No `any`. No CivicGrid cross-read.

import { Decimal } from 'decimal.js';

import {
  OcppConnection,
  type ChargePointRegistryLookup,
} from './ocpp_connection.js';
import {
  MESSAGE_TYPE_CALL,
  type OcppAction,
  type OcppSessionState,
} from './types.js';

// ─── Decimal.js global config (matches settlement.ts Law §1.4.4) ─────────────

Decimal.set({ precision: 18, rounding: Decimal.ROUND_HALF_UP });

// ─── Macro pricing model (.claudecode-rules.md §3) ───────────────────────────

const RATE_CONSUMER_PER_KWH = new Decimal('29.00');
const RATE_MERALCO_PER_KWH = new Decimal('14.00');
const RATE_HOST_MARGIN_PER_KWH = new Decimal('8.00');
const RATE_PLATFORM_PER_KWH = new Decimal('7.00');

const SPLIT_TOLERANCE = new Decimal('0.000001');

// ─── DC hardware + battery model ─────────────────────────────────────────────

const DC_NAMEPLATE_KW = new Decimal('30');
const BATTERY_CAPACITY_KWH = new Decimal('60');
const START_SOC = new Decimal('0.20');
const TAPER_SOC = new Decimal('0.80');
const END_SOC = new Decimal('0.90');
const SIM_INTERVAL_SEC = new Decimal('60');

// ─── Result types ─────────────────────────────────────────────────────────────

export type DcChargingStep = {
  stepIndex: number;
  socPercent: string;
  powerKw: string;
  intervalKwh: string;
  cumulativeKwh: string;
  meterWh: number;
};

export type DcRevenueSplit = {
  kwhDelivered: string;
  energyChargePhp: string;
  duReservePhp: string;
  hostMarginPhp: string;
  hostSharePhp: string;
  platformSharePhp: string;
};

export type DcHarnessResult = {
  chargePointId: string;
  finalState: OcppSessionState;
  ocppFramesExchanged: number;
  chargingSteps: readonly DcChargingStep[];
  split: DcRevenueSplit;
  invariantDelta: string;
};

// ─── Split invariant (Law §1.4.4 / .claudecode-rules.md §3) ────────────────

function assertSplitInvariant(
  hostShare: Decimal,
  platformShare: Decimal,
  energyCharge: Decimal,
): void {
  const splitSum = hostShare.plus(platformShare);
  const delta = energyCharge.minus(splitSum).abs();

  if (delta.greaterThan(SPLIT_TOLERANCE)) {
    throw new Error(
      `[SPLIT INVARIANT VIOLATION] ` +
      `host=${hostShare.toFixed(6)} + platform=${platformShare.toFixed(6)} ` +
      `= ${splitSum.toFixed(6)}, expected energy_charge=${energyCharge.toFixed(6)}, ` +
      `delta=${delta.toFixed(8)} exceeds tolerance 0.000001`,
    );
  }
}

function computeRevenueSplit(kwhDelivered: Decimal): DcRevenueSplit {
  const energyCharge = kwhDelivered.times(RATE_CONSUMER_PER_KWH);
  const duReserve = kwhDelivered.times(RATE_MERALCO_PER_KWH);
  const hostMargin = kwhDelivered.times(RATE_HOST_MARGIN_PER_KWH);
  const hostShare = kwhDelivered.times(RATE_MERALCO_PER_KWH.plus(RATE_HOST_MARGIN_PER_KWH));
  const platformShare = kwhDelivered.times(RATE_PLATFORM_PER_KWH);

  assertSplitInvariant(hostShare, platformShare, energyCharge);

  return {
    kwhDelivered: kwhDelivered.toDecimalPlaces(6).toFixed(6),
    energyChargePhp: energyCharge.toDecimalPlaces(6).toFixed(6),
    duReservePhp: duReserve.toDecimalPlaces(6).toFixed(6),
    hostMarginPhp: hostMargin.toDecimalPlaces(6).toFixed(6),
    hostSharePhp: hostShare.toDecimalPlaces(6).toFixed(6),
    platformSharePhp: platformShare.toDecimalPlaces(6).toFixed(6),
  };
}

// ─── DC rapid-then-taper power curve ─────────────────────────────────────────
// 20% starting SoC → full 30 kW until 80% → linear taper to 25% power by 90%.

function powerKwAtSoc(soc: Decimal): Decimal {
  if (soc.lessThan(TAPER_SOC)) {
    return DC_NAMEPLATE_KW;
  }
  if (soc.greaterThanOrEqualTo(END_SOC)) {
    return DC_NAMEPLATE_KW.times('0.25');
  }
  const taperSpan = END_SOC.minus(TAPER_SOC);
  const progress = soc.minus(TAPER_SOC).div(taperSpan);
  const taperFactor = new Decimal('1').minus(progress.times('0.75'));
  return DC_NAMEPLATE_KW.times(taperFactor);
}

function simulateDcChargingCurve(): { steps: DcChargingStep[]; totalKwh: Decimal } {
  const steps: DcChargingStep[] = [];
  let soc = START_SOC;
  let cumulativeKwh = new Decimal('0');
  let stepIndex = 0;

  const hoursPerStep = SIM_INTERVAL_SEC.div('3600');

  while (soc.lessThan(END_SOC)) {
    const powerKw = powerKwAtSoc(soc);
    const intervalKwh = powerKw.times(hoursPerStep);
    cumulativeKwh = cumulativeKwh.plus(intervalKwh);
    soc = START_SOC.plus(cumulativeKwh.div(BATTERY_CAPACITY_KWH));

    if (soc.greaterThan(END_SOC)) {
      soc = END_SOC;
    }

    const meterWh = cumulativeKwh.times('1000').toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();

    steps.push({
      stepIndex,
      socPercent: soc.times('100').toDecimalPlaces(2).toFixed(2),
      powerKw: powerKw.toDecimalPlaces(3).toFixed(3),
      intervalKwh: intervalKwh.toDecimalPlaces(6).toFixed(6),
      cumulativeKwh: cumulativeKwh.toDecimalPlaces(6).toFixed(6),
      meterWh,
    });

    stepIndex = stepIndex + 1;

    if (stepIndex > 500) {
      throw new Error('[DC HARNESS] Simulation step guard tripped — curve did not converge');
    }
  }

  return { steps, totalKwh: cumulativeKwh };
}

// ─── OCPP frame builders (charge-point → CSMS Calls) ─────────────────────────

let _messageSeq = 0;

function nextMessageId(): string {
  _messageSeq = _messageSeq + 1;
  return `dc-harness-${_messageSeq.toString().padStart(4, '0')}`;
}

function buildCpCall(action: OcppAction, payload: unknown): string {
  return JSON.stringify([MESSAGE_TYPE_CALL, nextMessageId(), action, payload]);
}

function parseCallResultTransactionId(response: string | null): number {
  if (response === null) {
    throw new Error('[DC HARNESS] StartTransaction.conf missing — CSMS returned null');
  }
  const parsed: unknown = JSON.parse(response);
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    throw new Error('[DC HARNESS] StartTransaction.conf malformed');
  }
  const payload = parsed[2];
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('[DC HARNESS] StartTransaction.conf payload not an object');
  }
  const txId = (payload as Record<string, unknown>)['transactionId'];
  if (typeof txId !== 'number') {
    throw new Error('[DC HARNESS] StartTransaction.conf missing transactionId');
  }
  return txId;
}

// ─── Harness orchestration ───────────────────────────────────────────────────

export function runDcFastChargerHarness(
  registryLookup: ChargePointRegistryLookup = () => 'provisioned',
): DcHarnessResult {
  const chargePointId = 'CP-DC-30KW-SIM-001';
  const csmsToCp: string[] = [];
  const cpToCsms: string[] = [];

  const connection = new OcppConnection(
    chargePointId,
    (frame) => { csmsToCp.push(frame); },
    registryLookup,
  );

  const exchange = (raw: string): string | null => {
    cpToCsms.push(raw);
    return connection.onRawFrame(raw);
  };

  connection.onOpen();

  exchange(buildCpCall('BootNotification', {
    chargePointVendor: 'VoltSense-Sim',
    chargePointModel: 'DC-30kW-Fast',
    chargePointSerialNumber: 'VS-DC-30KW-0001',
    firmwareVersion: '1.0.0-harness',
  }));

  if (connection.getState() !== 'OPERATIONAL') {
    throw new Error(
      `[DC HARNESS] BootNotification failed — state=${connection.getState()}`,
    );
  }

  exchange(buildCpCall('Heartbeat', {}));

  exchange(buildCpCall('Authorize', {
    idTag: 'VS-550e8400-e29b-41d4-a716-446655440000',
  }));

  const startResponse = exchange(buildCpCall('StartTransaction', {
    connectorId: 1,
    idTag: 'VS-550e8400-e29b-41d4-a716-446655440000',
    meterStart: 0,
    timestamp: new Date().toISOString(),
  }));

  const transactionId = parseCallResultTransactionId(startResponse);

  const { steps, totalKwh } = simulateDcChargingCurve();

  for (const step of steps) {
    exchange(buildCpCall('MeterValues', {
      connectorId: 1,
      transactionId,
      meterValue: [{
        timestamp: new Date().toISOString(),
        sampledValue: [{
          value: step.meterWh.toString(),
          context: 'Sample.Periodic',
          measurand: 'Energy.Active.Import.Register',
          unit: 'Wh',
        }],
      }],
    }));
  }

  exchange(buildCpCall('StopTransaction', {
    transactionId,
    meterStop: steps[steps.length - 1]?.meterWh ?? 0,
    timestamp: new Date().toISOString(),
    reason: 'Local',
  }));

  const split = computeRevenueSplit(totalKwh);
  const hostShare = new Decimal(split.hostSharePhp);
  const platformShare = new Decimal(split.platformSharePhp);
  const energyCharge = new Decimal(split.energyChargePhp);
  const invariantDelta = energyCharge.minus(hostShare.plus(platformShare)).abs();

  return {
    chargePointId,
    finalState: connection.getState(),
    ocppFramesExchanged: cpToCsms.length,
    chargingSteps: steps,
    split,
    invariantDelta: invariantDelta.toFixed(8),
  };
}
