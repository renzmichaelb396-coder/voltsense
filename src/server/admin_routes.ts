// Earnings API — read-only reporting surface for Go Hotels + platform ops.
// Both routes are shielded via the 'protected' auth tier (Basic Auth, see basic_auth.ts).

import { desc, eq, sum, count } from 'drizzle-orm';

import * as schema from '../db/schema.js';
import { PLATFORM_ACCOUNT_ID } from '../services/settlement.js';
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

const RECENT_SESSIONS_LIMIT = 50;

type AdminSessionRow = {
  sessionId: string;
  siteId: string;
  siteName: string;
  packageId: string;
  kwhDelivered: string | null;
  energyChargePhp: string | null;
  hostSharePhp: string | null;
  platformSharePhp: string | null;
  pspFeePhp: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
};

export async function handleAdminSessions(ctx: RequestContext): Promise<HttpResponse> {
  const rows = await ctx.db
    .select({
      sessionId: schema.sessions.id,
      siteId: schema.sites.id,
      siteName: schema.sites.name,
      packageId: schema.sessions.packageId,
      kwhDelivered: schema.sessions.kwhDelivered,
      energyChargePhp: schema.sessions.energyChargePhp,
      hostSharePhp: schema.sessions.hostSharePhp,
      platformSharePhp: schema.sessions.platformSharePhp,
      pspFeePhp: schema.sessions.pspFeePhp,
      startedAt: schema.sessions.startedAt,
      stoppedAt: schema.sessions.stoppedAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.chargePoints, eq(schema.chargePoints.id, schema.sessions.chargePointId))
    .innerJoin(schema.sites, eq(schema.sites.id, schema.chargePoints.siteId))
    .where(eq(schema.sessions.status, 'completed'))
    .orderBy(desc(schema.sessions.stoppedAt))
    .limit(RECENT_SESSIONS_LIMIT);

  const sessions: AdminSessionRow[] = rows.map((row) => ({
    sessionId: row.sessionId,
    siteId: row.siteId,
    siteName: row.siteName,
    packageId: row.packageId,
    kwhDelivered: row.kwhDelivered,
    energyChargePhp: row.energyChargePhp,
    hostSharePhp: row.hostSharePhp,
    platformSharePhp: row.platformSharePhp,
    pspFeePhp: row.pspFeePhp,
    startedAt: row.startedAt?.toISOString() ?? null,
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
  }));

  return jsonResponse(200, { sessions });
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
];
