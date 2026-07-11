// PayMongo webhook inbound type layer — VoltSense payment rail
// Parse pipeline: rawBody: unknown → Zod schema → PayMongoWebhookPayload
// Matches PayMongo's nested event envelope:
//   data.attributes.type          → event type (payment.paid | payment.failed | checkout_session.payment.paid)
//   data.attributes.data.attributes → payment resource fields (amount, status, …)
// No 'any'. Amounts stay as centavo integers at the wire boundary; convert at the edge.
// NOTE: checkout_session.payment.paid is normalized → payment.paid internally so the rest of
// the pipeline (session lookup, RemoteStartTransaction) is identical for both event types.

import { z } from 'zod';

// ─── Event type literals ───────────────────────────────────────────────────────

export type PayMongoEventType = 'payment.paid' | 'payment.failed' | 'checkout_session.payment.paid';

const PayMongoEventTypeEnum = z.enum(['payment.paid', 'payment.failed', 'checkout_session.payment.paid']);

// ─── Payment source (GCash, Maya, card, …) ───────────────────────────────────

const PayMongoSourceSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    provider: z
      .object({
        id: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ─── Nested payment resource ─────────────────────────────────────────────────

const PayMongoPaymentAttributesSchema = z
  .object({
    amount: z.number().int().positive(),
    currency: z.literal('PHP'),
    status: z.enum(['paid', 'failed', 'pending']),
    description: z.string().nullable().optional(),
    external_reference_number: z.string().nullable().optional(),
    payment_intent_id: z.string().nullable().optional(),
    paid_at: z.number().int().optional(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
    source: PayMongoSourceSchema.optional(),
  })
  .passthrough();

const PayMongoPaymentResourceSchema = z.object({
  id: z.string().min(1),
  type: z.literal('payment'),
  attributes: PayMongoPaymentAttributesSchema,
});

// ─── Event envelope ──────────────────────────────────────────────────────────

const PayMongoEventAttributesSchema = z.object({
  type: PayMongoEventTypeEnum,
  livemode: z.boolean(),
  data: PayMongoPaymentResourceSchema,
  previous_data: z.record(z.unknown()).optional(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

export const PayMongoWebhookSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    type: z.literal('event'),
    attributes: PayMongoEventAttributesSchema,
  }),
});

// ─── Exported types ───────────────────────────────────────────────────────────

export type PayMongoPaymentAttributes = z.infer<typeof PayMongoPaymentAttributesSchema>;
export type PayMongoPaymentResource = z.infer<typeof PayMongoPaymentResourceSchema>;
export type PayMongoWebhookPayload = z.infer<typeof PayMongoWebhookSchema>;

// Flattened view for route handlers — maps PayMongo envelope to VoltSense semantics.
export type PayMongoPaymentPaidEvent = {
  readonly event: 'payment.paid';
  readonly eventId: string;
  readonly livemode: boolean;
  readonly paymentId: string;
  readonly amountCentavos: number;
  readonly currency: 'PHP';
  readonly paidAtUnix: number;
  readonly externalReferenceNumber: string | null;
  readonly paymentIntentId: string | null;
  readonly sourceType: string | undefined;
};

export type PayMongoPaymentFailedEvent = {
  readonly event: 'payment.failed';
  readonly eventId: string;
  readonly livemode: boolean;
  readonly paymentId: string;
  readonly amountCentavos: number;
  readonly currency: 'PHP';
  readonly externalReferenceNumber: string | null;
  readonly paymentIntentId: string | null;
  readonly sourceType: string | undefined;
};

export type PayMongoNormalizedEvent = PayMongoPaymentPaidEvent | PayMongoPaymentFailedEvent;

// ─── Narrowing helpers ────────────────────────────────────────────────────────

export function isPayMongoPaidEvent(e: PayMongoNormalizedEvent): e is PayMongoPaymentPaidEvent {
  return e.event === 'payment.paid';
}

export function isPayMongoFailedEvent(
  e: PayMongoNormalizedEvent,
): e is PayMongoPaymentFailedEvent {
  return e.event === 'payment.failed';
}

// ─── Centavos → PHP decimal string (§1.4.7) ──────────────────────────────────

export function centavosToPhpString(centavos: number): string {
  const whole = Math.trunc(centavos / 100);
  const frac = Math.abs(centavos % 100);
  return `${whole}.${frac.toString().padStart(2, '0')}0000`;
}

// ─── Normalize envelope → discriminated event ────────────────────────────────

export function normalizePayMongoWebhook(payload: PayMongoWebhookPayload): PayMongoNormalizedEvent {
  const { id: eventId, attributes } = payload.data;
  const payment = attributes.data;
  const attrs = payment.attributes;

  const base = {
    eventId,
    livemode: attributes.livemode,
    paymentId: payment.id,
    amountCentavos: attrs.amount,
    currency: attrs.currency,
    externalReferenceNumber: attrs.external_reference_number ?? null,
    paymentIntentId: attrs.payment_intent_id ?? null,
    sourceType: attrs.source?.type,
  } as const;

  // checkout_session.payment.paid is treated identically to payment.paid —
  // same session lookup, same RemoteStartTransaction dispatch.
  if (attributes.type === 'payment.paid' || attributes.type === 'checkout_session.payment.paid') {
    return {
      ...base,
      event: 'payment.paid',
      paidAtUnix: attrs.paid_at ?? attrs.created_at,
    };
  }

  return {
    ...base,
    event: 'payment.failed',
  };
}

// ─── Parse pipeline entrypoints ───────────────────────────────────────────────

export function parsePayMongoWebhookPayload(rawBody: unknown): PayMongoWebhookPayload {
  return PayMongoWebhookSchema.parse(rawBody);
}

export function safeParsePayMongoWebhookPayload(
  rawBody: unknown,
): ReturnType<typeof PayMongoWebhookSchema.safeParse> {
  return PayMongoWebhookSchema.safeParse(rawBody);
}
