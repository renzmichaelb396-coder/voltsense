// PayMongo REST client — payment link creation and shared auth helpers.
// Base URL: https://api.paymongo.com/v1
// Auth: Basic base64(PAYMONGO_SECRET_KEY + ":")
// All money at the wire boundary is integer centavos; callers pass PHP decimal strings.

import { z } from 'zod';

// ─── Config ───────────────────────────────────────────────────────────────────

export type PayMongoConfig = {
  readonly secretKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
};

const DEFAULT_BASE_URL = 'https://api.paymongo.com/v1';
const DEFAULT_TIMEOUT_MS = 15_000;

export function loadPayMongoConfigFromEnv(): PayMongoConfig {
  const secretKey = process.env['PAYMONGO_SECRET_KEY'];
  if (secretKey === undefined || secretKey.length === 0) {
    throw new Error('[PAYMONGO] PAYMONGO_SECRET_KEY is required');
  }

  const baseUrl = process.env['PAYMONGO_BASE_URL'] ?? DEFAULT_BASE_URL;
  const timeoutMs = Number(process.env['PAYMONGO_TIMEOUT_MS'] ?? String(DEFAULT_TIMEOUT_MS));

  return { secretKey, baseUrl, timeoutMs };
}

export function payMongoBasicAuthHeader(secretKey: string): string {
  const token = Buffer.from(`${secretKey}:`).toString('base64');
  return `Basic ${token}`;
}

// ─── Amount conversion ────────────────────────────────────────────────────────

const PhpAmountString = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'amount_php must be a positive decimal string');

export function phpStringToCentavos(amountPhp: string): number {
  const parsed = PhpAmountString.parse(amountPhp);
  const [wholePart, fracPart = ''] = parsed.split('.');
  const fracPadded = fracPart.padEnd(6, '0').slice(0, 6);
  const centavosFromFrac = Math.round(Number(fracPadded.slice(0, 2)));
  const centavosFromSub = Math.round(Number(fracPadded.slice(2, 4)) / 100);
  return Number(wholePart) * 100 + centavosFromFrac + centavosFromSub;
}

// ─── Checkout session creation ─────────────────────────────────────────────────

export type CreateCheckoutSessionRequest = {
  amountPhp: string;
  description: string;
  referenceNumber?: string;
  successUrl: string;
  cancelUrl: string;
};

export type CreateCheckoutSessionSuccess = {
  outcome: 'success';
  sessionId: string;
  checkoutUrl: string;
};

export type CreateCheckoutSessionFailure = {
  outcome: 'failure';
  errorCode: string;
  errorMessage: string;
};

export type CreateCheckoutSessionResult = CreateCheckoutSessionSuccess | CreateCheckoutSessionFailure;

const PayMongoCheckoutSessionOkSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    type: z.literal('checkout_session'),
    attributes: z.object({
      checkout_url: z.string().url(),
    }),
  }),
});

const PayMongoErrorSchema = z.object({
  errors: z
    .array(
      z.object({
        code: z.string(),
        detail: z.string().optional(),
      }),
    )
    .min(1),
});

async function fetchWithTimeout(
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

export async function createCheckoutSession(
  req: CreateCheckoutSessionRequest,
  config: PayMongoConfig,
): Promise<CreateCheckoutSessionResult> {
  const amountCentavos = phpStringToCentavos(req.amountPhp);

  const attributes: Record<string, unknown> = {
    billing: { name: 'VoltSense Customer' },
    line_items: [
      {
        currency: 'PHP',
        amount: amountCentavos,
        name: req.description,
        quantity: 1,
      },
    ],
    payment_method_types: ['card', 'gcash', 'paymaya', 'grab_pay'],
    success_url: req.successUrl,
    cancel_url: req.cancelUrl,
    description: req.description,
  };

  if (req.referenceNumber !== undefined) {
    attributes['reference_number'] = req.referenceNumber;
  }

  const body = JSON.stringify({ data: { attributes } });

  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${config.baseUrl}/checkout_sessions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: payMongoBasicAuthHeader(config.secretKey),
        },
        body,
      },
      config.timeoutMs,
    );
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      outcome: 'failure',
      errorCode: isAbort ? 'PSP_HTTP_TIMEOUT' : 'NETWORK_ERROR',
      errorMessage: err instanceof Error ? err.message : 'Unknown network error reaching PayMongo',
    };
  }

  const raw: unknown = await resp.json();

  if (resp.ok) {
    const parsed = PayMongoCheckoutSessionOkSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        outcome: 'failure',
        errorCode: 'INVALID_RESPONSE_SCHEMA',
        errorMessage: `PayMongo checkout session body did not match expected schema: ${parsed.error.message}`,
      };
    }
    return {
      outcome: 'success',
      sessionId: parsed.data.data.id,
      checkoutUrl: parsed.data.data.attributes.checkout_url,
    };
  }

  const errParsed = PayMongoErrorSchema.safeParse(raw);
  const firstError = errParsed.success ? errParsed.data.errors[0] : undefined;
  return {
    outcome: 'failure',
    errorCode: firstError?.code ?? 'UNKNOWN_ERROR',
    errorMessage: firstError?.detail ?? `HTTP ${resp.status}`,
  };
}
