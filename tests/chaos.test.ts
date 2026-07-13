// Chaos / adversarial test suite — exercises the LIVE deployed VoltSense backend
// (not a local instance). Every request in this file hits real production
// infrastructure: Postgres, PayMongo (test-mode), and the OCPP command log.
// See CLAUDE.md "Known Gaps" for context on what this suite is probing for.

import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema.js';

loadDotenv();

const TARGET = 'https://voltsense-pmfq.onrender.com';

const CP = '33333333-3333-3333-3333-333333333333';
const FAKE = '00000000-0000-0000-0000-000000000000';

/** Blocking session statuses that leave the GoMandaloyo test connector unusable. */
const BLOCKING_SESSION_STATUSES = [
  'awaiting_payment',
  'payment_cleared',
  'charging',
  'paid_charger_offline',
  'authorized',
] as const;

/**
 * Test isolation for T03 / T15 / T24: reset connector to Available and expire
 * any blocking sessions on CP+connector 1 so prior chaos runs cannot leak 409s.
 * Touches the live Supabase DB only — no production code path.
 */
async function resetTestConnector(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL must be set in .env for chaos test isolation');
  }

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client, { schema });
  try {
    await db
      .update(schema.connectors)
      .set({ status: 'Available', updatedAt: new Date() })
      .where(and(eq(schema.connectors.chargePointId, CP), eq(schema.connectors.connectorId, 1)));

    await db
      .update(schema.sessions)
      .set({
        status: 'expired',
        authExpiresAt: new Date(Date.now() - 60_000),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.sessions.chargePointId, CP),
          eq(schema.sessions.connectorId, 1),
          inArray(schema.sessions.status, [...BLOCKING_SESSION_STATUSES]),
        ),
      );
  } finally {
    await client.end({ timeout: 5 });
  }
}

function validCheckoutBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chargePointId: CP,
    connectorId: 1,
    packageId: 'PKG_5KWH',
    idTag: 'chaos-test-001',
    ...overrides,
  };
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${TARGET}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    // Non-JSON response (e.g. an upstream WAF/edge block page) — leave json undefined.
  }
  return { status: res.status, json, text };
}

async function getJson(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${TARGET}${path}`, { headers });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    // ignore
  }
  return { status: res.status, json, text };
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

// ─── PayMongo webhook fixture ──────────────────────────────────────────────
// Builds a well-formed payload matching PayMongoWebhookSchema so signature
// verification (which runs AFTER payload-shape validation in the route
// handler) is actually what's under test, not a 400 from a malformed body.

function buildPaymongoPaidPayload(referenceNumber: string, paymentId: string) {
  const nowUnix = Math.floor(Date.now() / 1000);
  return {
    data: {
      id: `evt_${randomUUID()}`,
      type: 'event',
      attributes: {
        type: 'payment.paid',
        livemode: false,
        data: {
          id: paymentId,
          type: 'payment',
          attributes: {
            amount: 29000,
            currency: 'PHP',
            status: 'paid',
            external_reference_number: referenceNumber,
            paid_at: nowUnix,
            created_at: nowUnix,
            updated_at: nowUnix,
          },
        },
        created_at: nowUnix,
        updated_at: nowUnix,
      },
    },
  };
}

function signPaymongoPayload(rawBody: string, secret: string, timestamp: string): string {
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return `t=${timestamp},te=${expected}`;
}

const results: { id: string; pass: boolean; detail: string }[] = [];

function record(id: string, pass: boolean, detail: string) {
  results.push({ id, pass, detail });
}

describe('chaos: preflight', () => {
  it('T01 GET /health -> 200 {status}', async () => {
    const res = await getJson('/health');
    const ok = res.status === 200 && typeof (res.json as any)?.status === 'string';
    record('T01', ok, `status=${res.status} body=${res.text}`);
    expect(res.status).toBe(200);
    expect(res.json).toHaveProperty('status');
  });

  it('T02 GET /ocpp/status -> 200 {connected, chargePoints, activeSessions}', async () => {
    const res = await getJson('/ocpp/status');
    const body = res.json as any;
    const ok =
      res.status === 200 &&
      typeof body?.connected === 'boolean' &&
      Array.isArray(body?.chargePoints) &&
      Array.isArray(body?.activeSessions);
    record('T02', ok, `status=${res.status} body=${res.text}`);
    expect(res.status).toBe(200);
    expect(body).toHaveProperty('connected');
    expect(body).toHaveProperty('chargePoints');
    expect(body).toHaveProperty('activeSessions');
  });
});

describe('chaos: checkout happy path', () => {
  beforeEach(async () => {
    await resetTestConnector();
  });

  it('T03 POST /checkout VALID -> 201 {sessionId(uuid), checkoutUrl(https)}', async () => {
    const res = await postJson('/checkout', validCheckoutBody());
    const body = res.json as any;
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ok =
      res.status === 201 &&
      typeof body?.sessionId === 'string' &&
      uuidRe.test(body.sessionId) &&
      typeof body?.checkoutUrl === 'string' &&
      body.checkoutUrl.startsWith('https');
    record('T03', ok, `status=${res.status} body=${res.text}`);
    expect(res.status).toBe(201);
    expect(body.sessionId).toMatch(uuidRe);
    expect(body.checkoutUrl).toMatch(/^https/);
  });
});

describe('chaos: checkout input validation', () => {
  it('T04 missing chargePointId -> 400 invalid_checkout_payload', async () => {
    const { chargePointId, ...rest } = validCheckoutBody();
    const res = await postJson('/checkout', rest);
    const ok = res.status === 400 && (res.json as any)?.error === 'invalid_checkout_payload';
    record('T04', ok, `status=${res.status} body=${res.text}`);
    expect(res.status).toBe(400);
    expect((res.json as any).error).toBe('invalid_checkout_payload');
  });

  it('T05 chargePointId="not-a-uuid" -> 400 invalid_checkout_payload', async () => {
    const res = await postJson('/checkout', validCheckoutBody({ chargePointId: 'not-a-uuid' }));
    const ok = res.status === 400 && (res.json as any)?.error === 'invalid_checkout_payload';
    record('T05', ok, `status=${res.status} body=${res.text}`);
    expect(res.status).toBe(400);
    expect((res.json as any).error).toBe('invalid_checkout_payload');
  });

  it('T06 connectorId=0 -> 400 invalid_checkout_payload', async () => {
    const res = await postJson('/checkout', validCheckoutBody({ connectorId: 0 }));
    const ok = res.status === 400 && (res.json as any)?.error === 'invalid_checkout_payload';
    record('T06', ok, `status=${res.status} body=${res.text}`);
    expect(res.status).toBe(400);
    expect((res.json as any).error).toBe('invalid_checkout_payload');
  });

  it('T07 packageId="FAKE_PKG" -> 400 invalid_checkout_payload', async () => {
    const res = await postJson('/checkout', validCheckoutBody({ packageId: 'FAKE_PKG' }));
    const ok = res.status === 400 && (res.json as any)?.error === 'invalid_checkout_payload';
    record('T07', ok, `status=${res.status} body=${res.text}`);
    expect(res.status).toBe(400);
    expect((res.json as any).error).toBe('invalid_checkout_payload');
  });

  it('T08 idTag="" -> 400 invalid_checkout_payload', async () => {
    const res = await postJson('/checkout', validCheckoutBody({ idTag: '' }));
    const ok = res.status === 400 && (res.json as any)?.error === 'invalid_checkout_payload';
    record('T08', ok, `status=${res.status} body=${res.text}`);
    expect(res.status).toBe(400);
    expect((res.json as any).error).toBe('invalid_checkout_payload');
  });

  it('T09 chargePointId=FAKE -> 404 charge_point_not_found', async () => {
    const res = await postJson('/checkout', validCheckoutBody({ chargePointId: FAKE }));
    const ok = res.status === 404 && (res.json as any)?.error === 'charge_point_not_found';
    record('T09', ok, `status=${res.status} body=${res.text}`);
    expect(res.status).toBe(404);
    expect((res.json as any).error).toBe('charge_point_not_found');
  });

  it('T10 connectorId=999 -> 404 connector_not_found', async () => {
    const res = await postJson('/checkout', validCheckoutBody({ connectorId: 999 }));
    const ok = res.status === 404 && (res.json as any)?.error === 'connector_not_found';
    record('T10', ok, `status=${res.status} body=${res.text}`);
    expect(res.status).toBe(404);
    expect((res.json as any).error).toBe('connector_not_found');
  });

  it('T11 idTag=10000 chars -> NOT 500', async () => {
    const res = await postJson('/checkout', validCheckoutBody({ idTag: 'a'.repeat(10000) }));
    const ok = res.status < 500;
    record('T11', ok, `status=${res.status} body=${res.text.slice(0, 200)}`);
    expect(res.status).toBeLessThan(500);
  });
});

describe('chaos: webhook security', () => {
  const secret = process.env.PAYMONGO_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('PAYMONGO_WEBHOOK_SECRET must be set in .env for webhook chaos tests');
  }

  beforeEach(async () => {
    await resetTestConnector();
  });

  it('T12 no signature header -> 401 missing_paymongo_signature', async () => {
    const res = await postJson('/webhooks/paymongo', buildPaymongoPaidPayload(randomUUID(), `pay_${randomUUID()}`));
    const ok = res.status === 401 && (res.json as any)?.error === 'missing_paymongo_signature';
    record('T12', ok, `status=${res.status} body=${res.text}`);
    expect(res.status).toBe(401);
    expect((res.json as any).error).toBe('missing_paymongo_signature');
  });

  it('T13 wrong signature (well-formed body) -> 401 invalid_paymongo_signature', async () => {
    const payload = buildPaymongoPaidPayload(randomUUID(), `pay_${randomUUID()}`);
    const res = await postJson('/webhooks/paymongo', payload, {
      'Paymongo-Signature': `t=${Math.floor(Date.now() / 1000)},te=${'0'.repeat(64)}`,
    });
    const ok = res.status === 401 && (res.json as any)?.error === 'invalid_paymongo_signature';
    record('T13', ok, `status=${res.status} body=${res.text}`);
    expect(res.status).toBe(401);
    expect((res.json as any).error).toBe('invalid_paymongo_signature');
  });

  it('T14 valid sig + malformed body -> 400 invalid_paymongo_webhook_payload', async () => {
    const rawBody = JSON.stringify({ not: 'a valid paymongo envelope' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = signPaymongoPayload(rawBody, secret, timestamp);
    const res = await fetch(`${TARGET}/webhooks/paymongo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Paymongo-Signature': sig },
      body: rawBody,
    });
    const text = await res.text();
    const json = text.length > 0 ? JSON.parse(text) : undefined;
    const ok = res.status === 400 && json?.error === 'invalid_paymongo_webhook_payload';
    record('T14', ok, `status=${res.status} body=${text}`);
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid_paymongo_webhook_payload');
  });

  it('T15 valid sig + payment.paid sent 3x -> 202 authorized, then duplicate x2', async () => {
    // Uses the sessionId/reference_number created by T03 so findSessionPaymentByReferenceNumber
    // resolves to a real payments row (idempotency_key = session id at /checkout time).
    const checkout = await postJson('/checkout', validCheckoutBody({ idTag: `chaos-webhook-${randomUUID()}` }));
    expect(checkout.status).toBe(201);
    const referenceNumber = (checkout.json as any).sessionId as string;
    const paymentId = `pay_${randomUUID()}`;
    const payload = buildPaymongoPaidPayload(referenceNumber, paymentId);
    const rawBody = JSON.stringify(payload);

    async function sendOnce() {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sig = signPaymongoPayload(rawBody, secret!, timestamp);
      const res = await fetch(`${TARGET}/webhooks/paymongo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Paymongo-Signature': sig },
        body: rawBody,
      });
      const text = await res.text();
      const json = text.length > 0 ? JSON.parse(text) : undefined;
      return { status: res.status, json, text };
    }

    const first = await sendOnce();
    const second = await sendOnce();
    const third = await sendOnce();

    const firstOk =
      first.status === 202 &&
      (first.json?.status === 'charging_authorized' || first.json?.accepted === true);
    const secondOk = second.status === 202 && second.json?.duplicate === true;
    const thirdOk = third.status === 202 && third.json?.duplicate === true;

    record(
      'T15',
      firstOk && secondOk && thirdOk,
      `1st=${first.status}/${first.text} 2nd=${second.status}/${second.text} 3rd=${third.status}/${third.text}`,
    );

    expect(first.status).toBe(202);
    expect(first.json?.status === 'charging_authorized' || first.json?.accepted === true).toBe(true);
    expect(second.status).toBe(202);
    expect(second.json?.duplicate).toBe(true);
    expect(third.status).toBe(202);
    expect(third.json?.duplicate).toBe(true);
  });
});

describe('chaos: admin auth boundary', () => {
  const username = process.env.VOLTSENSE_SHIELD_USER;
  const password = process.env.VOLTSENSE_SHIELD_PASSWORD;
  if (!username || !password) {
    throw new Error('VOLTSENSE_SHIELD_USER/PASSWORD must be set in .env for admin auth chaos tests');
  }

  it('T16 GET /admin/earnings no auth -> 401', async () => {
    const res = await getJson('/admin/earnings');
    record('T16', res.status === 401, `status=${res.status} body=${res.text}`);
    expect(res.status).toBe(401);
  });

  it('T17 GET /admin/earnings wrong username -> 401', async () => {
    const res = await getJson('/admin/earnings', {
      Authorization: basicAuthHeader('not-the-admin', password),
    });
    record('T17', res.status === 401, `status=${res.status} body=${res.text}`);
    expect(res.status).toBe(401);
  });

  it('T18 GET /admin/earnings correct creds -> 200', async () => {
    const res = await getJson('/admin/earnings', {
      Authorization: basicAuthHeader(username, password),
    });
    record('T18', res.status === 200, `status=${res.status} body=${res.text.slice(0, 200)}`);
    expect(res.status).toBe(200);
  });

  it('T19 GET /admin/sessions no auth -> 401', async () => {
    const res = await getJson('/admin/sessions');
    record('T19', res.status === 401, `status=${res.status} body=${res.text}`);
    expect(res.status).toBe(401);
  });

  it('T20 GET /admin/sessions correct creds -> 200', async () => {
    const res = await getJson('/admin/sessions', {
      Authorization: basicAuthHeader(username, password),
    });
    record('T20', res.status === 200, `status=${res.status} body=${res.text.slice(0, 200)}`);
    expect(res.status).toBe(200);
  });
});

describe('chaos: injection', () => {
  it('T21 chargePointId=SQLi string -> NOT 500', async () => {
    const res = await postJson('/checkout', validCheckoutBody({ chargePointId: "'; DROP TABLE sessions;--" }));
    const ok = res.status < 500;
    record('T21', ok, `status=${res.status} body=${res.text.slice(0, 200)}`);
    expect(res.status).toBeLessThan(500);
  });

  it('T22 idTag=<script> -> NOT 500', async () => {
    const res = await postJson('/checkout', validCheckoutBody({ idTag: '<script>alert(1)</script>' }));
    const ok = res.status < 500;
    record('T22', ok, `status=${res.status} body=${res.text.slice(0, 200)}`);
    expect(res.status).toBeLessThan(500);
  });

  it('T23 connectorId=null -> 400, NOT 500', async () => {
    const res = await postJson('/checkout', validCheckoutBody({ connectorId: null }));
    const ok = res.status === 400 && res.status < 500;
    record('T23', ok, `status=${res.status} body=${res.text.slice(0, 200)}`);
    expect(res.status).toBe(400);
  });
});

describe('chaos: double-booking race', () => {
  beforeEach(async () => {
    await resetTestConnector();
  });

  it('T24 concurrent /checkout on same charger+connector -> exactly one 201', async () => {
    const idTag = `chaos-race-${randomUUID()}`;
    const [a, b] = await Promise.all([
      postJson('/checkout', validCheckoutBody({ idTag: `${idTag}-a` })),
      postJson('/checkout', validCheckoutBody({ idTag: `${idTag}-b` })),
    ]);

    const statuses = [a.status, b.status].sort();
    const exactlyOne201 = statuses.filter((s) => s === 201).length === 1;
    const otherIs409 = statuses.some((s) => s === 409);
    const bothAre201 = statuses[0] === 201 && statuses[1] === 201;

    if (bothAre201) {
      record(
        'T24',
        false,
        `[BUG FOUND] double-booking allowed — both requests got 201. a=${a.text} b=${b.text}`,
      );
    } else if (exactlyOne201 && otherIs409) {
      record('T24', true, `a=${a.status} b=${b.status} (409 connector_not_available on loser) — PASS`);
    } else {
      record('T24', false, `unexpected outcome a=${a.status}/${a.text} b=${b.status}/${b.text}`);
    }

    // Primary assertion: never both 201 (double-booking).
    expect(bothAre201).toBe(false);
    expect(exactlyOne201).toBe(true);
  });
});

afterAll(() => {
  const rows = results
    .sort((x, y) => Number(x.id.slice(1)) - Number(y.id.slice(1)))
    .map((r) => `${r.id.padEnd(4)} ${r.pass ? 'PASS' : 'FAIL'}  ${r.detail}`)
    .join('\n');
  console.log(`\n=== CHAOS TEST RESULTS (T01-T24) ===\n${rows}\n`);
  const bugs = results.filter((r) => r.detail.includes('[BUG FOUND]'));
  if (bugs.length > 0) {
    console.log('=== BUGS FLAGGED ===');
    bugs.forEach((b) => console.log(`${b.id}: ${b.detail}`));
  }
});
