// Webhook inbound type layer — Law §1.3.3
// Parse pipeline: rawBody: unknown → Zod schema → PaymentWebhookPayload
// No 'any'. No 'psp: string' widening. No numeric money fields.

import { z } from 'zod';

// ─── Psp — standalone domain type ────────────────────────────────────────────
// Exported for use across services (refund.ts, settlement.ts) without re-deriving
// from Zod schemas or schema.ts enum. Single source of truth.

export type Psp = 'gcash' | 'maya';

// Wire-level PSP validator. Inferred type is exactly `Psp` (closed set, no widening).
const PspEnum = z.enum(['gcash', 'maya']);

// ─── Amount string validator ───────────────────────────────────────────────────
// Enforces string decimal (§1.4.7: "API JSON money fields → string decimal").
// Accepts up to 6 decimal places; rejects JSON numbers and empty strings.

const AmountPhpString = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'amount_php must be a positive decimal string (e.g. "120.500000")');

// ─── Variant schemas — discriminated on `status` ────────────────────────────────
// `status` is the explicit discriminant: the object SHAPE differs by status
// (paid carries amount_php + paid_at; failed carries failure_code), whereas the
// shape is identical across PSPs. `psp` is therefore a validated enum field, not a
// second discriminant — a flat discriminatedUnion permits exactly one discriminant
// key, and 'gcash'/'maya' each span both statuses.

const PaidWebhookSchema = z.object({
  status: z.literal('paid'),
  psp: PspEnum,
  external_id: z.string().min(1, 'external_id required'),
  amount_php: AmountPhpString,
  paid_at: z.string().datetime({ message: 'paid_at must be ISO 8601 UTC' }),
  idempotency_key: z.string().min(1, 'idempotency_key required'),
  signature: z.string().min(1, 'signature required'),
});

const FailedWebhookSchema = z.object({
  status: z.literal('failed'),
  psp: PspEnum,
  external_id: z.string().min(1, 'external_id required'),
  failure_code: z.string().min(1, 'failure_code required'),
  idempotency_key: z.string().min(1, 'idempotency_key required'),
  signature: z.string().min(1, 'signature required'),
});

// ─── Combined discriminated union ─────────────────────────────────────────────
// z.discriminatedUnion reads `status` first, then validates only the matching
// variant — O(1) dispatch and exhaustive, closed-set typing. Unknown status →
// ZodError listing the valid discriminant values.

export const PaymentWebhookSchema = z.discriminatedUnion('status', [
  PaidWebhookSchema,
  FailedWebhookSchema,
]);

// ─── Exported types ───────────────────────────────────────────────────────────

export type PaidWebhookPayload = z.infer<typeof PaidWebhookSchema>;
export type FailedWebhookPayload = z.infer<typeof FailedWebhookSchema>;

// PaymentWebhookPayload is the inferred discriminated union — never a hand-rolled interface.
export type PaymentWebhookPayload = z.infer<typeof PaymentWebhookSchema>;

// Narrowing helpers — use in handlers after parsing to get the fully typed variant.
export function isPaidPayload(p: PaymentWebhookPayload): p is PaidWebhookPayload {
  return p.status === 'paid';
}

export function isFailedPayload(p: PaymentWebhookPayload): p is FailedWebhookPayload {
  return p.status === 'failed';
}

// ─── Parse pipeline entrypoints ───────────────────────────────────────────────
// Callers provide rawBody: unknown (e.g. from req.body after reading raw bytes).
// 'parse' throws ZodError on invalid input — use in trusted server handler context.
// 'safeParse' returns Result — use when you need to distinguish validation failure.

export function parseWebhookPayload(rawBody: unknown): PaymentWebhookPayload {
  return PaymentWebhookSchema.parse(rawBody);
}

export function safeParseWebhookPayload(
  rawBody: unknown,
): ReturnType<typeof PaymentWebhookSchema.safeParse> {
  return PaymentWebhookSchema.safeParse(rawBody);
}
