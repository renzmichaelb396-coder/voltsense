// Mobile payment-bridge UI state machine — Law §1.1 (Strict Discriminated Unions)
// Customer-facing screen states for the GCash/Maya charging flow.
// No 'any'. No 'string' widening on gateways or poll status. Money is string decimal (§1.4.7).
//
// MobileScreenState is a strict, read-only discriminated union keyed on `screen`.
// Every variant is exhaustively typed; narrowing on `screen` yields the exact shape.

import type { Psp } from '../webhooks/types.js';

// ─── Payment gateway literal ──────────────────────────────────────────────────
// The mobile bridge only ever offers the two PSPs VoltSense settles against.
// Aliased to the canonical `Psp` union (single source of truth) — never re-derived
// or widened to `string`. If a third PSP is added, it flows from one place.

export type PaymentGateway = Psp;

// ─── PricingTier — money fields are string decimals (§1.4.7) ──────────────────
// Mirrors the NUMERIC(18,6) tariff snapshot semantics on the wire: every monetary
// value is a decimal string, never a JS number. `tierId` is a closed literal union
// so the UI cannot render an unknown tier.

export type TierId = 'standard' | 'fast' | 'turbo';

export type PricingTier = {
  readonly tierId: TierId;
  readonly label: string;
  // Per-kWh price the customer is quoted, as a decimal string (e.g. "18.500000").
  readonly pricePerKwhPhp: string;
  // Flat session fee, decimal string (e.g. "5.000000"); "0.000000" when none.
  readonly sessionFeePhp: string;
  // Energy this tier delivers for the session, decimal string in kWh.
  readonly estimatedKwh: string;
};

// ─── Poll status — closed literal union, never plain string ───────────────────
// Drives the spinner/copy on the `processing` screen while the bridge waits on
// the PSP webhook. Discriminating the polling lifecycle as a closed set keeps the
// UI exhaustive (no "unknown state" fallthrough).

export type PollStatus =
  | 'awaiting_redirect'   // customer sent to PSP-hosted checkout
  | 'awaiting_webhook'    // redirect returned; waiting on paid/failed webhook
  | 'confirming'          // webhook received; verifying signature + amount
  | 'retrying';           // transient poll failure; backing off and re-polling

// ─── Screen variants ──────────────────────────────────────────────────────────

// screen: 'idle_scan' — initialization prompts shown before a charger is selected.
export type IdleScanState = {
  readonly screen: 'idle_scan';
  // Ordered prompt lines (e.g. "Scan the QR on the charger to begin").
  readonly prompts: readonly string[];
};

// screen: 'payment_select' — charger chosen; pick a gateway and confirm the tier.
export type PaymentSelectState = {
  readonly screen: 'payment_select';
  readonly chargerId: string;
  readonly availablePaymentGateways: readonly PaymentGateway[];
  readonly selectedTier: PricingTier;
};

// screen: 'processing' — payment in flight; references + live poll status.
export type ProcessingState = {
  readonly screen: 'processing';
  readonly chargerId: string;
  // PSP-issued reference for the in-flight charge (external_id on the webhook).
  readonly paymentReference: string;
  // Idempotency key correlating UI poll → settlement, decimal-safe string.
  readonly idempotencyKey: string;
  readonly pollStatus: PollStatus;
};

// screen: 'charging_active' — settled; live countdown + energy telemetry.
export type ChargingActiveState = {
  readonly screen: 'charging_active';
  readonly chargerId: string;
  // Whole seconds left on the session; UI renders the countdown from this.
  readonly remainingSeconds: number;
  // Energy delivered so far, decimal string in kWh (§1.4.7) — never a JS number.
  readonly energyDeliveredKwh: string;
};

// ─── MobileScreenState — strict read-only discriminated union (§1.1) ──────────
// `screen` is the discriminant: it is the field that drives each variant's shape.
// Exhaustive narrowing on `screen` gives the exact variant with zero casts.

export type MobileScreenState =
  | IdleScanState
  | PaymentSelectState
  | ProcessingState
  | ChargingActiveState;

// ─── Narrowing helpers ────────────────────────────────────────────────────────
// Use after receiving an opaque MobileScreenState to recover the exact variant.

export function isIdleScan(s: MobileScreenState): s is IdleScanState {
  return s.screen === 'idle_scan';
}

export function isPaymentSelect(s: MobileScreenState): s is PaymentSelectState {
  return s.screen === 'payment_select';
}

export function isProcessing(s: MobileScreenState): s is ProcessingState {
  return s.screen === 'processing';
}

export function isChargingActive(s: MobileScreenState): s is ChargingActiveState {
  return s.screen === 'charging_active';
}
