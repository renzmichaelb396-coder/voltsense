// Earnings API — read-only reporting surface for Go Hotels + platform ops.
// Both routes are shielded via the 'protected' auth tier (Basic Auth, see basic_auth.ts).

import { desc, eq, and, sum, count } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { z } from 'zod';

import * as schema from '../db/schema.js';
import { PLATFORM_ACCOUNT_ID } from '../services/settlement.js';
import { loadHostShieldCredentialsFromEnv, verifyBasicAuth } from './basic_auth.js';
import type { RequestContext, RouteDefinition, HttpResponse } from './routes.js';

const JSON_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
};

function jsonResponse(statusCode: number, payload: unknown): HttpResponse {
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

// ─── handleAdminEarnings ──────────────────────────────────────────────────────
// GET /admin/earnings — per-site lifetime totals plus current account balances.
// Only 'completed' sessions have settlement amounts populated, so aggregates are
// scoped to that status; awaiting/cancelled/expired sessions contribute nothing.

type SiteEarningsRow = {
  siteId: string;
  siteName: string;
  totalSessions: number;
  totalKwhDelivered: string;
  totalEnergyChargePhp: string;
  totalHostSharePhp: string;
  totalPlatformSharePhp: string;
  totalPspFeePhp: string;
  hostAccountBalance: string;
  platformAccountBalance: string;
};

async function fetchPlatformAccountBalance(db: RequestContext['db']): Promise<string> {
  const rows = await db
    .select({ balancePhp: schema.accountBalances.balancePhp })
    .from(schema.accountBalances)
    .where(eq(schema.accountBalances.accountId, PLATFORM_ACCOUNT_ID))
    .limit(1);
  return rows[0]?.balancePhp ?? '0';
}

async function fetchHostAccountBalance(db: RequestContext['db'], siteId: string): Promise<string> {
  const rows = await db
    .select({ balancePhp: schema.accountBalances.balancePhp })
    .from(schema.accountBalances)
    .where(eq(schema.accountBalances.accountId, siteId))
    .limit(1);
  return rows[0]?.balancePhp ?? '0';
}

export async function handleAdminEarnings(ctx: RequestContext): Promise<HttpResponse> {
  const siteRows = await ctx.db
    .select({
      siteId: schema.sites.id,
      siteName: schema.sites.name,
      totalSessions: count(schema.sessions.id),
      totalKwhDelivered: sum(schema.sessions.kwhDelivered),
      totalEnergyChargePhp: sum(schema.sessions.energyChargePhp),
      totalHostSharePhp: sum(schema.sessions.hostSharePhp),
      totalPlatformSharePhp: sum(schema.sessions.platformSharePhp),
      totalPspFeePhp: sum(schema.sessions.pspFeePhp),
    })
    .from(schema.sites)
    .innerJoin(schema.chargePoints, eq(schema.chargePoints.siteId, schema.sites.id))
    .innerJoin(schema.sessions, eq(schema.sessions.chargePointId, schema.chargePoints.id))
    .where(eq(schema.sessions.status, 'completed'))
    .groupBy(schema.sites.id, schema.sites.name);

  const platformAccountBalance = await fetchPlatformAccountBalance(ctx.db);

  const sites: SiteEarningsRow[] = await Promise.all(
    siteRows.map(async (row): Promise<SiteEarningsRow> => ({
      siteId: row.siteId,
      siteName: row.siteName,
      totalSessions: row.totalSessions,
      totalKwhDelivered: row.totalKwhDelivered ?? '0',
      totalEnergyChargePhp: row.totalEnergyChargePhp ?? '0',
      totalHostSharePhp: row.totalHostSharePhp ?? '0',
      totalPlatformSharePhp: row.totalPlatformSharePhp ?? '0',
      totalPspFeePhp: row.totalPspFeePhp ?? '0',
      hostAccountBalance: await fetchHostAccountBalance(ctx.db, row.siteId),
      platformAccountBalance,
    })),
  );

  return jsonResponse(200, {
    sites,
    asOf: new Date().toISOString(),
  });
}

// ─── handleAdminSessions ──────────────────────────────────────────────────────
// GET /admin/sessions — last 50 completed sessions, newest first.
// Optional ?status= query param opts out of the completed-only default:
//   ?status=all           — any status, newest-created first (bench-test tooling)
//   ?status=<enum value>  — a single specific status (e.g. payment_cleared, charging)
// Omitting the param preserves the original completed-only behavior byte-for-byte.

const RECENT_SESSIONS_LIMIT = 50;

const SESSION_STATUS_VALUES = schema.sessionStatusEnum.enumValues;
type SessionStatus = (typeof SESSION_STATUS_VALUES)[number];

function isSessionStatus(value: string): value is SessionStatus {
  return (SESSION_STATUS_VALUES as readonly string[]).includes(value);
}

type AdminSessionRow = {
  sessionId: string;
  chargePointId: string;
  connectorId: number;
  siteId: string;
  siteName: string;
  packageId: string;
  status: string;
  idTag: string;
  kwhDelivered: string | null;
  energyChargePhp: string | null;
  hostSharePhp: string | null;
  platformSharePhp: string | null;
  pspFeePhp: string | null;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
};

export async function handleAdminSessions(ctx: RequestContext): Promise<HttpResponse> {
  const statusParam = ctx.searchParams.get('status');

  let whereClause;
  if (statusParam === null) {
    whereClause = eq(schema.sessions.status, 'completed');
  } else if (statusParam === 'all') {
    whereClause = undefined;
  } else if (isSessionStatus(statusParam)) {
    whereClause = eq(schema.sessions.status, statusParam);
  } else {
    return jsonResponse(400, { error: 'invalid_status_filter' });
  }

  const rows = await ctx.db
    .select({
      sessionId: schema.sessions.id,
      chargePointId: schema.sessions.chargePointId,
      connectorId: schema.sessions.connectorId,
      siteId: schema.sites.id,
      siteName: schema.sites.name,
      packageId: schema.sessions.packageId,
      status: schema.sessions.status,
      idTag: schema.sessions.idTag,
      kwhDelivered: schema.sessions.kwhDelivered,
      energyChargePhp: schema.sessions.energyChargePhp,
      hostSharePhp: schema.sessions.hostSharePhp,
      platformSharePhp: schema.sessions.platformSharePhp,
      pspFeePhp: schema.sessions.pspFeePhp,
      createdAt: schema.sessions.createdAt,
      startedAt: schema.sessions.startedAt,
      stoppedAt: schema.sessions.stoppedAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.chargePoints, eq(schema.chargePoints.id, schema.sessions.chargePointId))
    .innerJoin(schema.sites, eq(schema.sites.id, schema.chargePoints.siteId))
    .where(whereClause)
    .orderBy(desc(schema.sessions.createdAt))
    .limit(RECENT_SESSIONS_LIMIT);

  const sessions: AdminSessionRow[] = rows.map((row) => ({
    sessionId: row.sessionId,
    chargePointId: row.chargePointId,
    connectorId: row.connectorId,
    siteId: row.siteId,
    siteName: row.siteName,
    packageId: row.packageId,
    status: row.status,
    idTag: row.idTag,
    kwhDelivered: row.kwhDelivered,
    energyChargePhp: row.energyChargePhp,
    hostSharePhp: row.hostSharePhp,
    platformSharePhp: row.platformSharePhp,
    pspFeePhp: row.pspFeePhp,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
  }));

  return jsonResponse(200, { sessions });
}

// ─── handleAdminExpireSession ─────────────────────────────────────────────────
// POST /admin/expire-session — bench-test cleanup utility. Forces a session
// (e.g. a preflight/smoke-test checkout) into 'expired' so it stops blocking
// the connector's availability check in handleCheckout (routes.ts).

const ExpireSessionRequestSchema = z.object({
  sessionId: z.string().uuid(),
});

export async function handleAdminExpireSession(ctx: RequestContext): Promise<HttpResponse> {
  let parsedBody: unknown;
  try {
    parsedBody = parseJsonBody(ctx.rawBody);
  } catch {
    return jsonResponse(400, { error: 'invalid_json_body' });
  }

  const bodyParsed = ExpireSessionRequestSchema.safeParse(parsedBody);
  if (!bodyParsed.success) {
    return jsonResponse(400, { error: 'invalid_expire_session_payload' });
  }

  const updatedRows = await ctx.db
    .update(schema.sessions)
    .set({
      status: 'expired',
      authExpiresAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(),
    })
    .where(eq(schema.sessions.id, bodyParsed.data.sessionId))
    .returning({ id: schema.sessions.id });

  const updated = updatedRows[0];
  if (updated === undefined) {
    return jsonResponse(404, { error: 'session_not_found' });
  }

  return jsonResponse(200, { sessionId: updated.id, status: 'expired' });
}

// ─── handleHostEarnings ───────────────────────────────────────────────────────
// GET /host/earnings — scoped, host-facing view of the same earnings data,
// hardcoded to the single Go Hotels pilot charger (VS-MAN-001) for now.
// Protected by its own Basic Auth pair (HOST_AUTH_USER/PASSWORD) — see basic_auth.ts —
// not the platform VOLTSENSE_SHIELD_* credentials used by /admin/*.

const HOST_PILOT_CHARGE_POINT_SERIAL = 'VS-MAN-001';

type HostSessionRow = {
  sessionId: string;
  startedAt: string | null;
  completedAt: string | null;
  kwhDelivered: string | null;
  hostEarningsPhp: string | null;
};

function hostAuthenticationRequiredResponse(): HttpResponse {
  return {
    statusCode: 401,
    headers: {
      ...JSON_HEADERS,
      'WWW-Authenticate': 'Basic realm="VoltSense Host Earnings", charset="UTF-8"',
    },
    body: JSON.stringify({ error: 'authentication_required' }),
  };
}

export async function handleHostEarnings(ctx: RequestContext): Promise<HttpResponse> {
  let hostCredentials;
  try {
    hostCredentials = loadHostShieldCredentialsFromEnv();
  } catch {
    return jsonResponse(500, { error: 'host_auth_not_configured' });
  }

  if (!verifyBasicAuth(ctx.headers, hostCredentials).ok) {
    return hostAuthenticationRequiredResponse();
  }

  const rows = await ctx.db
    .select({
      sessionId: schema.sessions.id,
      startedAt: schema.sessions.startedAt,
      completedAt: schema.sessions.stoppedAt,
      kwhDelivered: schema.sessions.kwhDelivered,
      hostEarningsPhp: schema.sessions.hostSharePhp,
    })
    .from(schema.sessions)
    .innerJoin(schema.chargePoints, eq(schema.chargePoints.id, schema.sessions.chargePointId))
    .where(
      and(
        eq(schema.chargePoints.serialNumber, HOST_PILOT_CHARGE_POINT_SERIAL),
        eq(schema.sessions.status, 'completed'),
      ),
    )
    .orderBy(desc(schema.sessions.stoppedAt));

  const sessions: HostSessionRow[] = rows.map((row) => ({
    sessionId: row.sessionId,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    kwhDelivered: row.kwhDelivered,
    hostEarningsPhp: row.hostEarningsPhp,
  }));

  const totalKwhDelivered = sessions
    .reduce((acc, s) => acc.plus(s.kwhDelivered ?? '0'), new Decimal(0))
    .toFixed(6);
  const totalHostEarningsPhp = sessions
    .reduce((acc, s) => acc.plus(s.hostEarningsPhp ?? '0'), new Decimal(0))
    .toFixed(2);

  return jsonResponse(200, {
    summary: {
      totalSessions: sessions.length,
      totalKwhDelivered,
      totalHostEarningsPhp,
    },
    sessions,
  });
}

export const ADMIN_ROUTES: readonly RouteDefinition[] = [
  {
    method: 'GET',
    pathname: '/admin/earnings',
    auth: 'protected',
    handler: handleAdminEarnings,
  },
  {
    method: 'GET',
    pathname: '/admin/sessions',
    auth: 'protected',
    handler: handleAdminSessions,
  },
  {
    method: 'GET',
    pathname: '/host/earnings',
    auth: 'host',
    handler: handleHostEarnings,
  },
];
