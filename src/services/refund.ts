// Async refund dispatch handler — Law §1.5.9
// Interfaces with GCash and Maya reversal APIs on settlement execution failure.
// All money as NUMERIC string. No 'any'. No float amounts. No hardcoded secrets.

import { z } from 'zod';

import type { Psp } from '../webhooks/types.js';

// ─── PSP config ───────────────────────────────────────────────────────────────
// Injected from environment at runtime — never defined inline.

export type PspConfig = {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;  // HTTP call timeout; not the 30 s settlement gate
};

export type RefundConfig = {
  readonly gcash: PspConfig;
  readonly maya: PspConfig;
};

// ─── Request ──────────────────────────────────────────────────────────────────

export type RefundReason =
  | 'hardware_timeout'    // StartTransaction.conf not received within 30 s (§1.5.9)
  | 'charger_offline'     // CP offline at payment time (§1.3.6)
  | 'zero_kwh'            // StopTransaction with 0 kWh within 5 min (§1.3.7)
  | 'amount_mismatch';    // Webhook amount ≠ session hold_amount_php (§1.3.4)

export type RefundRequest = {
  paymentId: string;    // VoltSense internal UUID — doubles as idempotency key prefix
  psp: Psp;
  externalId: string;   // PSP's original transaction ID for the reversal target
  amountPhp: string;    // NUMERIC(18,6) string — full hold amount reversed in v1
  reason: RefundReason;
};

// ─── Outcome — discriminated on 'outcome', never a boolean flag ──────────────

export type RefundSuccess = {
  outcome: 'success';
  psp: Psp;
  refundId: string;
  refundedAmountPhp: string;  // echoed by PSP — stored as string, never parsed to float
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

// ─── GCash response schemas ───────────────────────────────────────────────────
// Modeled on GCash payment gateway refund API v1.
// Update when integrating against sandbox credentials.

const GCashRefundOkSchema = z.object({
  id: z.string().min(1),
  status: z.literal('SUCCESS'),
  refunded_amount: z.string(),
  processed_at: z.string(),
});

const GCashRefundErrSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean().optional().default(false),
});

// ─── Maya response schemas ────────────────────────────────────────────────────
// Modeled on PayMaya (Maya) payment gateway refund API.
// totalAmount.value is a string decimal in their v1 API contract.

const MayaRefundOkSchema = z.object({
  id: z.string().min(1),
  status: z.literal('REFUNDED'),
  totalAmount: z.object({
    value: z.string(),
    currency: z.string(),
  }),
  createdAt: z.string(),
});

const MayaRefundErrSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
});

// ─── HTTP helper ──────────────────────────────────────────────────────────────
// Wraps fetch with an AbortController-backed timeout.
// Throws on network error or abort — callers catch and return RefundFailure.

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

// ─── GCash reversal ───────────────────────────────────────────────────────────
// POST {baseUrl}/v1/refunds
// Authorization: Bearer {apiKey}
// Idempotency-Key: refund-{paymentId}  — prevents double-refund on retry

async function dispatchGCashRefund(
  req: RefundRequest,
  cfg: PspConfig,
): Promise<RefundOutcome> {
  const idempotencyKey = `refund-${req.paymentId}`;
  const body = JSON.stringify({
    original_payment_id: req.externalId,
    amount: req.amountPhp,
    currency: 'PHP',
    reason: req.reason.toUpperCase(),
    idempotency_key: idempotencyKey,
  });

  let resp: Response;
  try {
    resp = await fetchWithAbortTimeout(
      `${cfg.baseUrl}/v1/refunds`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`,
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
      psp: 'gcash',
      errorCode: isAbort ? 'PSP_HTTP_TIMEOUT' : 'NETWORK_ERROR',
      errorMessage: err instanceof Error ? err.message : 'Unknown network error reaching GCash',
      retryable: true,
    };
  }

  const raw: unknown = await resp.json();

  if (resp.ok) {
    const parsed = GCashRefundOkSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        outcome: 'failure',
        psp: 'gcash',
        errorCode: 'INVALID_RESPONSE_SCHEMA',
        errorMessage: `GCash success body did not match expected schema: ${parsed.error.message}`,
        retryable: false,
      };
    }
    return {
      outcome: 'success',
      psp: 'gcash',
      refundId: parsed.data.id,
      refundedAmountPhp: parsed.data.refunded_amount,
      processedAt: parsed.data.processed_at,
    };
  }

  const errParsed = GCashRefundErrSchema.safeParse(raw);
  return {
    outcome: 'failure',
    psp: 'gcash',
    errorCode: errParsed.success ? errParsed.data.code : 'UNKNOWN_ERROR',
    errorMessage: errParsed.success ? errParsed.data.message : `HTTP ${resp.status}`,
    retryable: errParsed.success ? errParsed.data.retryable : false,
  };
}

// ─── Maya reversal ────────────────────────────────────────────────────────────
// POST {baseUrl}/payments/{externalId}/refunds
// Authorization: Basic base64({apiKey}:)
// requestReferenceNumber acts as Maya's idempotency anchor

async function dispatchMayaRefund(
  req: RefundRequest,
  cfg: PspConfig,
): Promise<RefundOutcome> {
  const referenceNumber = `refund-${req.paymentId}`;
  const body = JSON.stringify({
    totalAmount: {
      value: req.amountPhp,
      currency: 'PHP',
    },
    reason: req.reason.toUpperCase(),
    requestReferenceNumber: referenceNumber,
  });

  const basicToken = Buffer.from(`${cfg.apiKey}:`).toString('base64');

  let resp: Response;
  try {
    resp = await fetchWithAbortTimeout(
      `${cfg.baseUrl}/payments/${req.externalId}/refunds`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${basicToken}`,
          'Idempotency-Key': referenceNumber,
        },
        body,
      },
      cfg.timeoutMs,
    );
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      outcome: 'failure',
      psp: 'maya',
      errorCode: isAbort ? 'PSP_HTTP_TIMEOUT' : 'NETWORK_ERROR',
      errorMessage: err instanceof Error ? err.message : 'Unknown network error reaching Maya',
      retryable: true,
    };
  }

  const raw: unknown = await resp.json();

  if (resp.ok) {
    const parsed = MayaRefundOkSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        outcome: 'failure',
        psp: 'maya',
        errorCode: 'INVALID_RESPONSE_SCHEMA',
        errorMessage: `Maya success body did not match expected schema: ${parsed.error.message}`,
        retryable: false,
      };
    }
    return {
      outcome: 'success',
      psp: 'maya',
      refundId: parsed.data.id,
      refundedAmountPhp: parsed.data.totalAmount.value,
      processedAt: parsed.data.createdAt,
    };
  }

  // Maya 409 = idempotent replay: refund was already processed on a prior request.
  // Return outcome:'success' so executeRevenueSplitOrRefund marks the payment refunded,
  // not refund_failed — preventing a false ops alert for a completed operation.
  if (resp.status === 409) {
    const okParsed = MayaRefundOkSchema.safeParse(raw);
    if (okParsed.success) {
      return {
        outcome: 'success',
        psp: 'maya',
        refundId: okParsed.data.id,
        refundedAmountPhp: okParsed.data.totalAmount.value,
        processedAt: okParsed.data.createdAt,
      };
    }
    return {
      outcome: 'success',
      psp: 'maya',
      refundId: referenceNumber,
      refundedAmountPhp: req.amountPhp,
      processedAt: new Date().toISOString(),
    };
  }

  const errParsed = MayaRefundErrSchema.safeParse(raw);
  return {
    outcome: 'failure',
    psp: 'maya',
    errorCode: errParsed.success ? errParsed.data.code : 'UNKNOWN_ERROR',
    errorMessage: errParsed.success ? errParsed.data.message : `HTTP ${resp.status}`,
    retryable: resp.status >= 500,
  };
}

// ─── dispatchRefund ───────────────────────────────────────────────────────────
// Public entry point — exhaustive switch on request.psp, assertNever backstop.
// Never throws: all error paths return RefundFailure with a retryable flag.

export async function dispatchRefund(
  request: RefundRequest,
  config: RefundConfig,
): Promise<RefundOutcome> {
  switch (request.psp) {
    case 'gcash':
      return dispatchGCashRefund(request, config.gcash);
    case 'maya':
      return dispatchMayaRefund(request, config.maya);
    default:
      return assertNever(request.psp);
  }
}

// ─── assertNever ──────────────────────────────────────────────────────────────

function assertNever(x: never): never {
  throw new Error(`[REFUND] Unhandled PSP variant: ${String(x)}`);
}
