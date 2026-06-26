// Xendit webhook inbound type layer — VoltSense payment rail extension
// Parse pipeline: rawBody: unknown → Zod schema → XenditWebhookPayload
// No 'any'. No 'event: string' widening. Amounts coerce to finite numbers at parse boundary.

import { z } from 'zod';

// ─── PSP domain tag ────────────────────────────────────────────────────────────

export type XenditPsp = 'xendit';

// ─── Amount coercion — wire may send string decimals; code layer uses number ─

const AmountPhpNumber = z.preprocess(
  (value: unknown) => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Number(value);
    return value;
  },
  z
    .number({ invalid_type_error: 'amount must be a number or numeric string' })
    .positive('amount must be positive')
    .finite('amount must be finite'),
);

// ─── Shared fields ─────────────────────────────────────────────────────────────

const XenditBaseFields = {
  psp: z.literal('xendit'),
  external_id: z.string().min(1, 'external_id required'),
  idempotency_key: z.string().min(1, 'idempotency_key required'),
  signature: z.string().min(1, 'signature required'),
  session_id: z.string().uuid('session_id must be a UUID'),
};

// ─── Event variants (closed set) ─────────────────────────────────────────────

const XenditPaymentClearedSchema = z.object({
  ...XenditBaseFields,
  event: z.literal('payment.cleared'),
  amount_php: AmountPhpNumber,
  cleared_at: z.string().datetime({ message: 'cleared_at must be ISO 8601 UTC' }),
  currency: z.literal('PHP'),
});

const XenditPaymentFailedSchema = z.object({
  ...XenditBaseFields,
  event: z.literal('payment.failed'),
  amount_php: AmountPhpNumber,
  failure_code: z.string().min(1, 'failure_code required'),
  failure_reason: z.string().min(1, 'failure_reason required'),
});

const XenditRefundProcessedSchema = z.object({
  ...XenditBaseFields,
  event: z.literal('refund.processed'),
  refund_amount_php: AmountPhpNumber,
  original_amount_php: AmountPhpNumber,
  processed_at: z.string().datetime({ message: 'processed_at must be ISO 8601 UTC' }),
  currency: z.literal('PHP'),
});

// ─── Discriminated union — discriminates on `event` literal ─────────────────

export const XenditWebhookSchema = z.discriminatedUnion('event', [
  XenditPaymentClearedSchema,
  XenditPaymentFailedSchema,
  XenditRefundProcessedSchema,
]);

// ─── Exported types ───────────────────────────────────────────────────────────

export type XenditPaymentClearedPayload = z.infer<typeof XenditPaymentClearedSchema>;
export type XenditPaymentFailedPayload = z.infer<typeof XenditPaymentFailedSchema>;
export type XenditRefundProcessedPayload = z.infer<typeof XenditRefundProcessedSchema>;

export type XenditWebhookPayload = z.infer<typeof XenditWebhookSchema>;

export type XenditWebhookEvent = XenditWebhookPayload['event'];

// ─── Narrowing helpers ─────────────────────────────────────────────────────────

export function isPaymentClearedPayload(
  p: XenditWebhookPayload,
): p is XenditPaymentClearedPayload {
  return p.event === 'payment.cleared';
}

export function isPaymentFailedPayload(
  p: XenditWebhookPayload,
): p is XenditPaymentFailedPayload {
  return p.event === 'payment.failed';
}

export function isRefundProcessedPayload(
  p: XenditWebhookPayload,
): p is XenditRefundProcessedPayload {
  return p.event === 'refund.processed';
}

// ─── Parse pipeline entrypoints ───────────────────────────────────────────────

export function parseXenditWebhookPayload(rawBody: unknown): XenditWebhookPayload {
  return XenditWebhookSchema.parse(rawBody);
}

export function safeParseXenditWebhookPayload(
  rawBody: unknown,
): ReturnType<typeof XenditWebhookSchema.safeParse> {
  return XenditWebhookSchema.safeParse(rawBody);
}
