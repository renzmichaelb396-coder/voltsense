// Async refund dispatch handler — Law §1.5.9
// Interfaces with PayMongo Refunds API on settlement execution failure.
// All money as NUMERIC string. No 'any'. No float amounts. No hardcoded secrets.

import { z } from 'zod';

import { loadPayMongoConfigFromEnv, payMongoBasicAuthHeader, phpStringToCentavos } from './paymongo.js';
import type { Psp } from '../webhooks/types.js';

// ─── PSP config ───────────────────────────────────────────────────────────────
// Injected from environment at runtime — never defined inline.

export type PspConfig = {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;  // HTTP call timeout; not the 30 s settlement gate
};

export type RefundConfig = {
  readonly paymongo: PspConfig;
};

export function loadRefundConfigFromEnv(): RefundConfig {
  const paymongo = loadPayMongoConfigFromEnv();
  return {
    paymongo: {
      apiKey: paymongo.secretKey,
      baseUrl: paymongo.baseUrl,
      timeoutMs: paymongo.timeoutMs,
    },
  };
}

// ─── Request ──────────────────────────────────────────────────────────────────

export type RefundReason =
  | 'hardware_timeout'    // StartTransaction.conf not received within 30 s (§1.5.9)
  | 'charger_offline'     // CP offline at payment time (§1.3.6)
  | 'zero_kwh'            // StopTransaction with 0 kWh within 5 min (§1.3.7)
  | 'amount_mismatch'     // Webhook amount ≠ session hold_amount_php (§1.3.4)
  | 'partial_kwh';        // StopTransaction delivered less than the prepaid package kWh

export type RefundRequest = {
  paymentId: string;    // VoltSense internal UUID — doubles as idempotency key prefix
  psp: Psp;
  externalId: string;   // PayMongo payment ID (pay_…) for the reversal target
  amountPhp: string;    // NUMERIC(18,6) string — full hold amount reversed in v1
  reason: RefundReason;
};

// ─── Outcome — discriminated on 'outcome', never a boolean flag ──────────────

export type RefundSuccess = {
  outcome: 'success';
  psp: Psp;
  refundId: string;
  refundedAmountPhp: string;
  processedAt: string;         // ISO 8601 from PSP response
};

export type RefundFailure = {
  outcome: 'failure';
  psp: Psp;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
};

export type RefundOutcome = RefundSuccess | RefundFailure;

// ─── PayMongo refund response schemas ────────────────────────────────────────

const PayMongoRefundOkSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    type: z.literal('refund'),
    attributes: z.object({
      amount: z.number().int().positive(),
      currency: z.literal('PHP'),
      status: z.string(),
      created_at: z.number().int(),
    }),
  }),
});

const PayMongoRefundErrSchema = z.object({
  errors: z
    .array(
      z.object({
        code: z.string(),
        detail: z.string().optional(),
      }),
    )
    .min(1),
});

// Map VoltSense refund reasons → PayMongo's closed reason set.
function toPayMongoRefundReason(reason: RefundReason): string {
  switch (reason) {
    case 'hardware_timeout':
    case 'charger_offline':
    case 'zero_kwh':
    case 'amount_mismatch':
    case 'partial_kwh':
      return 'others';
    default:
      return assertNever(reason);
  }
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function fetchWithAbortTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function centavosToPhpString(centavos: number): string {
  const whole = Math.trunc(centavos / 100);
  const frac = Math.abs(centavos % 100);
  return `${whole}.${frac.toString().padStart(2, '0')}0000`;
}

// ─── PayMongo reversal ────────────────────────────────────────────────────────
// POST {baseUrl}/refunds
// Authorization: Basic base64({apiKey}:)
// payment_id = PayMongo pay_… ID stored as externalId

async function dispatchPayMongoRefund(
  req: RefundRequest,
  cfg: PspConfig,
): Promise<RefundOutcome> {
  const amountCentavos = phpStringToCentavos(req.amountPhp);
  const idempotencyKey = `refund-${req.paymentId}`;

  const body = JSON.stringify({
    data: {
      attributes: {
        amount: amountCentavos,
        payment_id: req.externalId,
        reason: toPayMongoRefundReason(req.reason),
        notes: req.reason,
        metadata: {
          voltsense_payment_id: req.paymentId,
          voltsense_psp: req.psp,
        },
      },
    },
  });

  let resp: Response;
  try {
    resp = await fetchWithAbortTimeout(
      `${cfg.baseUrl}/refunds`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: payMongoBasicAuthHeader(cfg.apiKey),
          'Idempotency-Key': idempotencyKey,
        },
        body,
      },
      cfg.timeoutMs,
    );
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      outcome: 'failure',
      psp: req.psp,
      errorCode: isAbort ? 'PSP_HTTP_TIMEOUT' : 'NETWORK_ERROR',
      errorMessage: err instanceof Error ? err.message : 'Unknown network error reaching PayMongo',
      retryable: true,
    };
  }

  const raw: unknown = await resp.json();

  if (resp.ok) {
    const parsed = PayMongoRefundOkSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        outcome: 'failure',
        psp: req.psp,
        errorCode: 'INVALID_RESPONSE_SCHEMA',
        errorMessage: `PayMongo success body did not match expected schema: ${parsed.error.message}`,
        retryable: false,
      };
    }
    return {
      outcome: 'success',
      psp: req.psp,
      refundId: parsed.data.data.id,
      refundedAmountPhp: centavosToPhpString(parsed.data.data.attributes.amount),
      processedAt: new Date(parsed.data.data.attributes.created_at * 1000).toISOString(),
    };
  }

  const errParsed = PayMongoRefundErrSchema.safeParse(raw);
  const firstError = errParsed.success ? errParsed.data.errors[0] : undefined;
  return {
    outcome: 'failure',
    psp: req.psp,
    errorCode: firstError?.code ?? 'UNKNOWN_ERROR',
    errorMessage: firstError?.detail ?? `HTTP ${resp.status}`,
    retryable: resp.status >= 500,
  };
}

// ─── dispatchRefund ───────────────────────────────────────────────────────────
// Public entry point — all PSP channels route through PayMongo Refunds API.
// Never throws: all error paths return RefundFailure with a retryable flag.

export async function dispatchRefund(
  request: RefundRequest,
  config: RefundConfig,
): Promise<RefundOutcome> {
  return dispatchPayMongoRefund(request, config.paymongo);
}

// ─── assertNever ──────────────────────────────────────────────────────────────

function assertNever(x: never): never {
  throw new Error(`[REFUND] Unhandled variant: ${String(x)}`);
}
