// Typed HTTP route table — public landing at GET /; admin/dev shielded via Basic Auth.
// Webhook listeners use the 'webhook' auth tier (HMAC validation on PayMongo).

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

import { Decimal } from 'decimal.js';
import { and, desc, eq, gt, inArray, or } from 'drizzle-orm';
import { z } from 'zod';

import * as schema from '../db/schema.js';
import { createCheckoutSession, loadPayMongoConfigFromEnv } from '../services/paymongo.js';
import type { SettlementDb } from '../services/settlement.js';
import { ADMIN_ROUTES } from './admin_routes.js';
import { getChargePointStatuses, getActiveSessionSummaries, sendRemoteStartTransaction } from './ocpp_ws.js';
import { verifyPayMongoWebhookSignature } from '../webhooks/crypto.js';
import {
  isPayMongoFailedEvent,
  isPayMongoPaidEvent,
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
  readonly db: SettlementDb;
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

type SessionRow = typeof schema.sessions.$inferSelect;
type PaymentRow = typeof schema.payments.$inferSelect;

type SessionPaymentMatch = {
  readonly session: SessionRow;
  readonly payment: PaymentRow;
};

// PayMongo link reference_number is persisted as payments.idempotency_key at session create.
async function findSessionPaymentByReferenceNumber(
  db: SettlementDb,
  referenceNumber: string,
): Promise<SessionPaymentMatch | undefined> {
  const joined = await db
    .select({
      session: schema.sessions,
      payment: schema.payments,
    })
    .from(schema.payments)
    .innerJoin(schema.sessions, eq(schema.payments.sessionId, schema.sessions.id))
    .where(eq(schema.payments.idempotencyKey, referenceNumber))
    .limit(1);

  const row = joined[0];
  if (row === undefined) {
    return undefined;
  }

  return { session: row.session, payment: row.payment };
}

async function handlePayMongoWebhook(ctx: RequestContext): Promise<HttpResponse> {
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

  if (event.externalReferenceNumber === null) {
    console.warn(
      '[voltsense:paymongo-webhook] external_reference_number is null — full event:',
      JSON.stringify({
        eventId: event.eventId,
        paymentId: event.paymentId,
        amountCentavos: event.amountCentavos,
        paymentIntentId: event.paymentIntentId,
        sourceType: event.sourceType,
        livemode: event.livemode,
      }),
    );
    return jsonResponse(202, { accepted: true, psp: 'paymongo', error: 'missing_reference_number' });
  }

  const match = await findSessionPaymentByReferenceNumber(
    ctx.db,
    event.externalReferenceNumber,
  );
  if (match === undefined) {
    console.warn(
      `[voltsense:paymongo-webhook] no payment for idempotency_key=${event.externalReferenceNumber}`,
    );
    return jsonResponse(202, {
      accepted: true,
      psp: 'paymongo',
      error: 'session_not_found',
    });
  }

  const { session, payment } = match;

  if (isPayMongoPaidEvent(event)) {
    if (payment.status === 'paid') {
      console.warn(
        `[voltsense:paymongo-webhook] duplicate paid event, skipping paymentId=${event.paymentId}`,
      );
      return jsonResponse(202, {
        accepted: true,
        psp: 'paymongo',
        event: event.event,
        duplicate: true,
      });
    }

    await ctx.db
      .update(schema.payments)
      .set({
        status: 'paid',
        externalId: event.paymentId,
        paidAt: new Date(event.paidAtUnix * 1000),
        updatedAt: new Date(),
      })
      .where(eq(schema.payments.id, payment.id));

    // Settlement runs later, off StopTransaction (once kwhDelivered is known) —
    // not here. Payment clearing only authorizes the charge to start.
    await ctx.db
      .update(schema.sessions)
      .set({
        status: 'payment_cleared',
        paymentClearedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.sessions.id, session.id));

    await sendRemoteStartTransaction(session.chargePointId, session.connectorId, session.idTag);

    return jsonResponse(202, {
      accepted: true,
      psp: 'paymongo',
      event: event.event,
      payment_id: event.paymentId,
      status: 'charging_authorized',
    });
  }

  if (isPayMongoFailedEvent(event)) {
    await ctx.db
      .update(schema.payments)
      .set({
        status: 'failed',
        updatedAt: new Date(),
      })
      .where(eq(schema.payments.id, payment.id));

    return jsonResponse(202, {
      accepted: true,
      psp: 'paymongo',
      event: event.event,
      payment_id: event.paymentId,
    });
  }

  const unhandledEvent: never = event;
  throw new Error(`[voltsense:paymongo-webhook] Unhandled event: ${String(unhandledEvent)}`);
}

const PhpAmountString = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'amount must be a positive decimal string');

const CreatePaymentRequestSchema = z
  .object({
    amount_php: PhpAmountString.optional(),
    amountPhp: PhpAmountString.optional(),
    description: z.string().min(1).max(255).optional(),
    session_id: z.string().uuid().optional(),
    sessionId: z.string().uuid().optional(),
    reference_number: z.string().min(1).max(64).optional(),
    referenceNumber: z.string().min(1).max(64).optional(),
    remarks: z.string().max(255).optional(),
  })
  .superRefine((data, ctx) => {
    const sessionId = data.session_id ?? data.sessionId;
    const amountPhp = data.amount_php ?? data.amountPhp;
    if (sessionId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'session_id or sessionId is required' });
    }
    if (amountPhp === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amount_php or amountPhp is required' });
    }
  })
  .transform((data) => {
    const session_id = data.session_id ?? data.sessionId;
    const amount_php = data.amount_php ?? data.amountPhp;
    if (session_id === undefined || amount_php === undefined) {
      throw new Error('[voltsense:create-payment] session_id and amount_php are required');
    }
    const reference_number = data.reference_number ?? data.referenceNumber ?? randomUUID();
    const description = data.description ?? `VoltSense session payment (${session_id})`;
    return {
      session_id,
      amount_php,
      description,
      reference_number,
      ...(data.remarks !== undefined ? { remarks: data.remarks } : {}),
    };
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

  const { amount_php, description, session_id, reference_number } = bodyParsed.data;

  const sessionRows = await ctx.db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, session_id))
    .limit(1);

  if (sessionRows[0] === undefined) {
    return jsonResponse(404, { error: 'session_not_found' });
  }

  const result = await createCheckoutSession(
    {
      amountPhp: amount_php,
      description,
      referenceNumber: reference_number,
      successUrl: `https://voltsense-csms.vercel.app/charging-started.html?session=${session_id}`,
      cancelUrl: 'https://voltsense-csms.vercel.app/payment-cancelled.html',
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

  const insertedRows = await ctx.db
    .insert(schema.payments)
    .values({
      sessionId: session_id,
      psp: 'paymongo',
      externalId: result.sessionId,
      idempotencyKey: reference_number,
      amountPhp: amount_php,
      status: 'pending',
      rawPayload: { checkout_session_id: result.sessionId, _url: result.checkoutUrl },
    })
    .returning({ id: schema.payments.id });

  const payment = insertedRows[0];
  if (payment === undefined) {
    throw new Error('[voltsense:create-payment] payments insert returned no row');
  }

  return jsonResponse(201, {
    payment_id: payment.id,
    checkout_url: result.checkoutUrl,
    session_id: result.sessionId,
    reference_number,
  });
}

const PACKAGE_IDS = ['PKG_5KWH', 'PKG_10KWH', 'PKG_15KWH', 'PKG_FULL'] as const;
type PackageId = (typeof PACKAGE_IDS)[number];

const PACKAGE_MAX_KWH: Readonly<Record<PackageId, string | null>> = {
  PKG_5KWH: '5',
  PKG_10KWH: '10',
  PKG_15KWH: '15',
  PKG_FULL: null,
};

// Full Session is a flat price, not a per-kWh formula — it has no kWh cap.
const FULL_SESSION_FLAT_PHP = '500.00';

function computePackagePrices(tariff: typeof schema.tariffs.$inferSelect): Record<PackageId, string> {
  const tariffTotal = new Decimal(tariff.duRatePerKwh)
    .plus(tariff.hostMarginPerKwh)
    .plus(tariff.platformFeePerKwh);

  return {
    PKG_5KWH: tariffTotal.times('5').plus(tariff.platformFeeFlatPhp).toFixed(2),
    PKG_10KWH: tariffTotal.times('10').plus(tariff.platformFeeFlatPhp).toFixed(2),
    PKG_15KWH: tariffTotal.times('15').plus(tariff.platformFeeFlatPhp).toFixed(2),
    PKG_FULL: FULL_SESSION_FLAT_PHP,
  };
}

const CHECKOUT_AUTH_WINDOW_MS = 15 * 60 * 1000;

const CheckoutRequestSchema = z.object({
  chargePointId: z.string().uuid(),
  connectorId: z.number().int().positive(),
  packageId: z.enum(PACKAGE_IDS),
  idTag: z.string().min(1),
});

// Thrown inside the checkout transaction when PayMongo link creation fails,
// so the session/payment inserts roll back instead of leaving an orphaned
// awaiting_payment session with no way to ever pay it (P1 §14).
class CheckoutPaymentLinkError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CheckoutPaymentLinkError';
  }
}


async function handleCheckout(ctx: RequestContext): Promise<HttpResponse> {
  const bodyParsed = CheckoutRequestSchema.safeParse(parseJsonBody(ctx.rawBody));
  if (!bodyParsed.success) {
    return jsonResponse(400, { error: 'invalid_checkout_payload' });
  }
  const { chargePointId, connectorId, packageId, idTag } = bodyParsed.data;

  const chargePointRows = await ctx.db
    .select({ siteId: schema.chargePoints.siteId, status: schema.chargePoints.status })
    .from(schema.chargePoints)
    .where(eq(schema.chargePoints.id, chargePointId))
    .limit(1);

  const chargePoint = chargePointRows[0];
  if (chargePoint === undefined) {
    return jsonResponse(404, { error: 'charge_point_not_found' });
  }

  if (chargePoint.status !== 'operational') {
    return jsonResponse(409, {
      error: 'charger_not_available',
      message: 'This charger is not available for charging.',
    });
  }

  const connectorRows = await ctx.db
    .select({ id: schema.connectors.id, status: schema.connectors.status })
    .from(schema.connectors)
    .where(
      and(
        eq(schema.connectors.chargePointId, chargePointId),
        eq(schema.connectors.connectorId, connectorId),
      ),
    )
    .limit(1);

  const connector = connectorRows[0];
  if (connector === undefined) {
    return jsonResponse(404, { error: 'connector_not_found' });
  }

  if (connector.status !== 'Available') {
    return jsonResponse(409, {
      error: 'connector_not_available',
      message: 'This connector is currently in use.',
    });
  }

  // Secondary guard: check sessions table for any active session on this connector.
  // We intentionally do NOT write to connectors.status here — that field is owned
  // by the OCPP StatusNotification handler and writing to it from checkout would
  // permanently lock the connector if the release path ever fails.
  const now = new Date();
  const activeSessionRows = await ctx.db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.chargePointId, chargePointId),
        eq(schema.sessions.connectorId, connectorId),
        or(
          // payment_cleared and charging are always blocking
          inArray(schema.sessions.status, ['payment_cleared', 'charging']),
          // awaiting_payment only blocks if the auth window hasn't expired
          and(
            eq(schema.sessions.status, 'awaiting_payment'),
            gt(schema.sessions.authExpiresAt, now),
          ),
        ),
      ),
    )
    .limit(1);

  if (activeSessionRows.length > 0) {
    return jsonResponse(409, {
      error: 'connector_not_available',
      message: 'This connector already has an active session.',
    });
  }

  const siteRows = await ctx.db
    .select({ name: schema.sites.name })
    .from(schema.sites)
    .where(eq(schema.sites.id, chargePoint.siteId))
    .limit(1);

  const site = siteRows[0];
  if (site === undefined) {
    return jsonResponse(404, { error: 'site_not_found' });
  }

  const tariffRows = await ctx.db
    .select()
    .from(schema.tariffs)
    .where(eq(schema.tariffs.siteId, chargePoint.siteId))
    .orderBy(desc(schema.tariffs.effectiveFrom))
    .limit(1);

  const tariff = tariffRows[0];
  if (tariff === undefined) {
    return jsonResponse(404, { error: 'tariff_not_found' });
  }

  let paymongoConfig;
  try {
    paymongoConfig = loadPayMongoConfigFromEnv();
  } catch {
    return jsonResponse(500, { error: 'paymongo_not_configured' });
  }

  const computedAmountPhp = computePackagePrices(tariff)[packageId];

  let checkoutResult: { sessionId: string; checkoutUrl: string };
  try {
    checkoutResult = await ctx.db.transaction(async (tx) => {
      const insertedSessions = await tx
        .insert(schema.sessions)
        .values({
          chargePointId,
          connectorId,
          status: 'awaiting_payment',
          idTag,
          packageId,
          snapshotDuRatePerKwh: tariff.duRatePerKwh,
          snapshotHostMarginPerKwh: tariff.hostMarginPerKwh,
          snapshotPlatformFeePerKwh: tariff.platformFeePerKwh,
          snapshotPlatformFeeFlatPhp: tariff.platformFeeFlatPhp,
          snapshotPspFeeRate: tariff.pspFeeRate,
          maxKwh: PACKAGE_MAX_KWH[packageId],
          holdAmountPhp: computedAmountPhp,
          authExpiresAt: new Date(Date.now() + CHECKOUT_AUTH_WINDOW_MS),
        })
        .returning({ id: schema.sessions.id });

      const session = insertedSessions[0];
      if (session === undefined) {
        throw new Error('[voltsense:checkout] sessions insert returned no row');
      }

      const linkResult = await createCheckoutSession(
        {
          amountPhp: computedAmountPhp,
          referenceNumber: session.id,
          description: `VoltSense charging session — ${site.name}`,
          successUrl: `https://voltsense-csms.vercel.app/charging-started.html?session=${session.id}`,
          cancelUrl: `https://voltsense-csms.vercel.app/payment-cancelled.html?cpid=${chargePointId}&cid=${connectorId}`,
        },
        paymongoConfig,
      );

      if (linkResult.outcome === 'failure') {
        throw new CheckoutPaymentLinkError(linkResult.errorCode, linkResult.errorMessage);
      }

      await tx.insert(schema.payments).values({
        sessionId: session.id,
        psp: 'paymongo',
        externalId: linkResult.checkoutUrl,
        idempotencyKey: session.id,
        amountPhp: computedAmountPhp,
        status: 'pending',
        rawPayload: { checkout_session_id: linkResult.sessionId, _url: linkResult.checkoutUrl },
      });

      return { sessionId: session.id, checkoutUrl: linkResult.checkoutUrl };
    });
  } catch (err) {
    if (err instanceof CheckoutPaymentLinkError) {
      return jsonResponse(502, {
        error: 'paymongo_link_creation_failed',
        code: err.code,
        message: err.message,
      });
    }
    throw err;
  }

  return jsonResponse(201, {
    sessionId: checkoutResult.sessionId,
    checkoutUrl: checkoutResult.checkoutUrl,
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

function handleHealth(_ctx: RequestContext): HttpResponse {
  return jsonResponse(200, { status: 'ok', ts: Date.now() });
}

function handleOcppStatus(_ctx: RequestContext): HttpResponse {
  const chargePoints = getChargePointStatuses();
  const activeSessions = getActiveSessionSummaries();
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({
      connected: chargePoints.length > 0,
      chargePoints,
      activeSessions,
    }),
  };
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
    pathname: '/health',
    auth: 'public',
    handler: handleHealth,
  },
  {
    method: 'GET',
    pathname: '/ocpp/status',
    auth: 'public',
    handler: handleOcppStatus,
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
  ...ADMIN_ROUTES,
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
    pathname: '/checkout',
    auth: 'public',
    handler: handleCheckout,
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
