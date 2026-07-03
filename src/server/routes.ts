// Typed HTTP route table — public landing at GET /; admin/dev shielded via Basic Auth.
// Webhook listeners use the 'webhook' auth tier (HMAC validation on PayMongo).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

import { z } from 'zod';

import { createPaymentLink, loadPayMongoConfigFromEnv } from '../services/paymongo.js';
import { verifyPayMongoWebhookSignature } from '../webhooks/crypto.js';
import {
  normalizePayMongoWebhook,
  safeParsePayMongoWebhookPayload,
} from '../webhooks/paymongo_types.js';
import { safeParseWebhookPayload } from '../webhooks/types.js';
import { safeParseXenditWebhookPayload } from '../webhooks/xendit_types.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export type RouteAuth = 'public' | 'protected' | 'webhook';

export type HttpResponse = {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type RequestContext = {
  readonly method: HttpMethod;
  readonly pathname: string;
  readonly headers: IncomingHttpHeaders;
  readonly rawBody: string;
};

export type RouteDefinition = {
  readonly method: HttpMethod;
  readonly pathname: string;
  readonly auth: RouteAuth;
  readonly handler: (ctx: RequestContext) => Promise<HttpResponse> | HttpResponse;
};

const JSON_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
};

const HTML_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
};

let cachedLandingHtml: string | null = null;

function resolveProjectRoot(): string {
  return join(import.meta.dirname, '../..');
}

async function loadPublicLandingHtml(): Promise<string> {
  if (cachedLandingHtml !== null) {
    return cachedLandingHtml;
  }

  const landingPath = join(resolveProjectRoot(), 'public', 'index.html');
  cachedLandingHtml = await readFile(landingPath, 'utf8');
  return cachedLandingHtml;
}

function jsonResponse(statusCode: number, payload: Record<string, string | number | boolean>): HttpResponse {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  };
}

function parseJsonBody(rawBody: string): unknown {
  if (rawBody.length === 0) {
    return undefined;
  }
  return JSON.parse(rawBody) as unknown;
}

async function handlePublicLanding(_ctx: RequestContext): Promise<HttpResponse> {
  const html = await loadPublicLandingHtml();
  return {
    statusCode: 200,
    headers: HTML_HEADERS,
    body: html,
  };
}

function handleAdminDashboard(_ctx: RequestContext): HttpResponse {
  return jsonResponse(200, {
    surface: 'admin',
    status: 'ok',
    message: 'VoltSense admin dashboard (shielded)',
  });
}

function handleDevTools(_ctx: RequestContext): HttpResponse {
  return jsonResponse(200, {
    surface: 'dev',
    status: 'ok',
    message: 'VoltSense development tools (shielded)',
  });
}

function handleGcashWebhook(ctx: RequestContext): HttpResponse {
  const parsed = safeParseWebhookPayload(parseJsonBody(ctx.rawBody));
  if (!parsed.success) {
    return jsonResponse(400, { accepted: false, error: 'invalid_gcash_webhook_payload' });
  }
  return jsonResponse(202, { accepted: true, psp: parsed.data.psp, status: parsed.data.status });
}

function handleMayaWebhook(ctx: RequestContext): HttpResponse {
  const parsed = safeParseWebhookPayload(parseJsonBody(ctx.rawBody));
  if (!parsed.success) {
    return jsonResponse(400, { accepted: false, error: 'invalid_maya_webhook_payload' });
  }
  return jsonResponse(202, { accepted: true, psp: parsed.data.psp, status: parsed.data.status });
}

function loadPayMongoWebhookSecret(): string | null {
  const secret = process.env['PAYMONGO_WEBHOOK_SECRET'];
  if (secret === undefined || secret.length === 0) {
    return null;
  }
  return secret;
}

function readPayMongoSignatureHeader(headers: IncomingHttpHeaders): string | null {
  const raw = headers['paymongo-signature'];
  if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  }
  if (Array.isArray(raw) && raw[0] !== undefined && raw[0].length > 0) {
    return raw[0];
  }
  return null;
}

function handlePayMongoWebhook(ctx: RequestContext): HttpResponse {
  const secret = loadPayMongoWebhookSecret();
  if (secret === null) {
    return jsonResponse(500, { accepted: false, error: 'paymongo_webhook_secret_not_configured' });
  }

  const signatureHeader = readPayMongoSignatureHeader(ctx.headers);
  if (signatureHeader === null) {
    return jsonResponse(401, { accepted: false, error: 'missing_paymongo_signature' });
  }

  const rawJson = parseJsonBody(ctx.rawBody);
  const parsed = safeParsePayMongoWebhookPayload(rawJson);
  if (!parsed.success) {
    return jsonResponse(400, { accepted: false, error: 'invalid_paymongo_webhook_payload' });
  }

  const livemode = parsed.data.data.attributes.livemode;
  if (!verifyPayMongoWebhookSignature(ctx.rawBody, signatureHeader, secret, livemode)) {
    return jsonResponse(401, { accepted: false, error: 'invalid_paymongo_signature' });
  }

  const event = normalizePayMongoWebhook(parsed.data);
  return jsonResponse(202, {
    accepted: true,
    psp: 'paymongo',
    event: event.event,
    payment_id: event.paymentId,
  });
}

const CreatePaymentRequestSchema = z.object({
  amount_php: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, 'amount_php must be a positive decimal string'),
  description: z.string().min(1).max(255),
  session_id: z.string().uuid().optional(),
  reference_number: z.string().min(1).max(64).optional(),
  remarks: z.string().max(255).optional(),
});

async function handleCreatePayment(ctx: RequestContext): Promise<HttpResponse> {
  const bodyParsed = CreatePaymentRequestSchema.safeParse(parseJsonBody(ctx.rawBody));
  if (!bodyParsed.success) {
    return jsonResponse(400, { error: 'invalid_payment_create_payload' });
  }

  let paymongoConfig;
  try {
    paymongoConfig = loadPayMongoConfigFromEnv();
  } catch {
    return jsonResponse(500, { error: 'paymongo_not_configured' });
  }

  const { amount_php, description, session_id, reference_number, remarks } = bodyParsed.data;

  const metadata: Record<string, string> = {};
  if (session_id !== undefined) {
    metadata['session_id'] = session_id;
  }

  const result = await createPaymentLink(
    {
      amountPhp: amount_php,
      description,
      ...(reference_number !== undefined ? { referenceNumber: reference_number } : {}),
      ...(remarks !== undefined ? { remarks } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
    paymongoConfig,
  );

  if (result.outcome === 'failure') {
    return jsonResponse(502, {
      error: 'paymongo_link_creation_failed',
      code: result.errorCode,
      message: result.errorMessage,
    });
  }

  return jsonResponse(201, {
    checkout_url: result.checkoutUrl,
    link_id: result.linkId,
    ...(result.referenceNumber !== null
      ? { reference_number: result.referenceNumber }
      : {}),
    amount_centavos: result.amountCentavos,
  });
}

/** @deprecated Xendit rail replaced by PayMongo — handler retained for in-flight events only. */
function handleXenditWebhook(ctx: RequestContext): HttpResponse {
  const parsed = safeParseXenditWebhookPayload(parseJsonBody(ctx.rawBody));
  if (!parsed.success) {
    return jsonResponse(400, { accepted: false, error: 'invalid_xendit_webhook_payload' });
  }
  return jsonResponse(202, { accepted: true, psp: 'xendit', event: parsed.data.event });
}

function handleNotFound(_ctx: RequestContext): HttpResponse {
  return jsonResponse(404, { error: 'not_found' });
}

export const ROUTE_TABLE: readonly RouteDefinition[] = [
  {
    method: 'GET',
    pathname: '/',
    auth: 'public',
    handler: handlePublicLanding,
  },
  {
    method: 'GET',
    pathname: '/admin',
    auth: 'protected',
    handler: handleAdminDashboard,
  },
  {
    method: 'GET',
    pathname: '/dev',
    auth: 'protected',
    handler: handleDevTools,
  },
  {
    method: 'POST',
    pathname: '/webhooks/gcash',
    auth: 'webhook',
    handler: handleGcashWebhook,
  },
  {
    method: 'POST',
    pathname: '/webhooks/maya',
    auth: 'webhook',
    handler: handleMayaWebhook,
  },
  {
    method: 'POST',
    pathname: '/webhooks/paymongo',
    auth: 'webhook',
    handler: handlePayMongoWebhook,
  },
  {
    method: 'POST',
    pathname: '/payments/create',
    auth: 'public',
    handler: handleCreatePayment,
  },
  {
    method: 'POST',
    pathname: '/webhooks/xendit',
    auth: 'webhook',
    handler: handleXenditWebhook,
  },
];

export function matchRoute(method: HttpMethod, pathname: string): RouteDefinition | undefined {
  return ROUTE_TABLE.find((route) => route.method === method && route.pathname === pathname);
}

export function requiresBasicAuth(method: HttpMethod, pathname: string): boolean {
  const route = matchRoute(method, pathname);
  if (route === undefined) {
    return true;
  }
  return route.auth === 'protected';
}

export async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

export async function dispatchRoute(ctx: RequestContext): Promise<HttpResponse> {
  const route = matchRoute(ctx.method, ctx.pathname);
  if (route === undefined) {
    return handleNotFound(ctx);
  }
  return route.handler(ctx);
}
