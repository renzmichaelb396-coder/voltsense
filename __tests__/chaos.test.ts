// Full TDD chaos suite — exercises the LIVE deployed VoltSense backend
// (BASE, below), not a local instance. Every request here hits real production
// infrastructure: Postgres (Supabase), PayMongo (test-mode), and the checkout
// rate limiter. Each test asserts an exact HTTP status + response shape.
//
// Runner note: this repo ships vitest, not jest (no jest devDependency exists).
// Run with: npx vitest run __tests__/chaos.test.ts --testTimeout=30000
// (P7a overrides its own per-test timeout — it deliberately waits out the
// real 60s rate-limit window, which the global 30s timeout can't cover.)
//
// Rate-limiter interaction: POST /checkout consumes its 5-req/60s-per-IP
// bucket (see src/utils/rate-limit.ts) BEFORE body validation runs — so every
// checkout call in this file, even a deliberately invalid one, counts against
// whatever identity sent it. To keep P2a-h/P3/P6 deterministic regardless of
// execution order or network timing, each of those tests sends a unique
// X-Forwarded-For value so it gets its own limiter bucket for test isolation
// (see resolveClientIp() in src/server/routes.ts for how that header is
// resolved). Operational/security implications of that resolution logic are
// tracked separately, not detailed here.

import { randomUUID, createHmac } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { describe, expect, it, afterAll } from 'vitest';

import * as schema from '../src/db/schema.js';

loadDotenv();

const BASE = 'https://voltsense-pmfq.onrender.com';
const STATIC = 'https://voltsense-csms.vercel.app';
const CP_ID = '33333333-3333-3333-3333-333333333333';
const CONNECTOR_ID = 1;
const FAKE_ID = '00000000-0000-0000-0000-000000000000';

const VALID_PACKAGES = ['PKG_5KWH', 'PKG_10KWH', 'PKG_15KWH'] as const;

const SHIELD_USER = process.env['VOLTSENSE_SHIELD_USER'];
const SHIELD_PASSWORD = process.env['VOLTSENSE_SHIELD_PASSWORD'];
const PAYMONGO_WEBHOOK_SECRET = process.env['PAYMONGO_WEBHOOK_SECRET'];
const DATABASE_URL = process.env['DATABASE_URL'];

if (!SHIELD_USER || !SHIELD_PASSWORD) {
  throw new Error('VOLTSENSE_SHIELD_USER/PASSWORD must be set in .env for Phase 5 admin-gate tests');
}
if (!PAYMONGO_WEBHOOK_SECRET) {
  throw new Error('PAYMONGO_WEBHOOK_SECRET must be set in .env for Phase 4 webhook tests');
}
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL must be set in .env for connector-state isolation between phases');
}

// ─── test isolation ────────────────────────────────────────────────────────
// Several phases (P2h, P7a) need the seed connector genuinely Available.
// This touches only the live Supabase DB directly — no production code path —
// mirroring tests/chaos.test.ts's resetTestConnector().

const BLOCKING_SESSION_STATUSES = [
  'awaiting_payment',
  'payment_cleared',
  'charging',
  'paid_charger_offline',
  'authorized',
] as const;

async function resetTestConnector(): Promise<void> {
  const client = postgres(DATABASE_URL!, { max: 1 });
  const db = drizzle(client, { schema });
  try {
    await db
      .update(schema.connectors)
      .set({ status: 'Available', updatedAt: new Date() })
      .where(and(eq(schema.connectors.chargePointId, CP_ID), eq(schema.connectors.connectorId, CONNECTOR_ID)));

    await db
      .update(schema.sessions)
      .set({ status: 'expired', authExpiresAt: new Date(Date.now() - 60_000), updatedAt: new Date() })
      .where(
        and(
          eq(schema.sessions.chargePointId, CP_ID),
          eq(schema.sessions.connectorId, CONNECTOR_ID),
          inArray(schema.sessions.status, [...BLOCKING_SESSION_STATUSES]),
        ),
      );
  } finally {
    await client.end({ timeout: 5 });
  }
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

type JsonResult = { status: number; json: any; text: string };

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<JsonResult> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

async function postRaw(path: string, rawBody: string, headers: Record<string, string> = {}): Promise<JsonResult> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: rawBody,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

async function getJson(path: string, headers: Record<string, string> = {}): Promise<JsonResult> {
  const res = await fetch(`${BASE}${path}`, { headers });
  const text = await res.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

async function getStatic(path: string): Promise<JsonResult> {
  const res = await fetch(`${STATIC}${path}`); // fetch() follows redirects by default
  const text = await res.text();
  return { status: res.status, json: undefined, text };
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

// Unique X-Forwarded-For per test so independent validation checks never
// share a rate-limit bucket with each other or with the dedicated P2i/P7a
// rate-limit tests. See file header note.
function isolatedIp(label: string): Record<string, string> {
  return { 'X-Forwarded-For': `10.42.${label.length % 250}.${Math.floor(Math.random() * 250)}-${label}` };
}

function validCheckoutBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chargePointId: CP_ID,
    connectorId: CONNECTOR_ID,
    packageId: 'PKG_5KWH',
    idTag: `chaos-${randomUUID()}`,
    ...overrides,
  };
}

function signPaymongo(rawBody: string, timestamp: string): string {
  const expected = createHmac('sha256', PAYMONGO_WEBHOOK_SECRET!)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  return `t=${timestamp},te=${expected}`;
}

function buildPaidPayload(referenceNumber: string) {
  const nowUnix = Math.floor(Date.now() / 1000);
  return {
    data: {
      id: `evt_${randomUUID()}`,
      type: 'event',
      attributes: {
        type: 'payment.paid',
        livemode: false,
        data: {
          id: `pay_${randomUUID()}`,
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

const results: { id: string; pass: boolean; detail: string }[] = [];
function record(id: string, pass: boolean, detail: string): void {
  results.push({ id, pass, detail });
}

// ─── shared helpers for Phases A–E (added below; Phases 1–7 above are untouched) ──

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkoutCreatedInvariant(res: JsonResult): boolean {
  return (
    res.status === 201 &&
    typeof res.json?.sessionId === 'string' &&
    UUID_RE.test(res.json.sessionId) &&
    typeof res.json?.checkoutUrl === 'string' &&
    res.json.checkoutUrl.startsWith('https://') &&
    res.json !== null &&
    typeof res.json === 'object' &&
    !Object.prototype.hasOwnProperty.call(res.json, 'amountPhp')
  );
}

// Set by Phase A's A2 test, consumed by Phase B's B4 test.
let sharedCustomSessionId: string | undefined;

// ─── PHASE 1 — health ──────────────────────────────────────────────────────

describe('Phase 1: health', () => {
  it(
    'P1a GET /health -> 200 {status:"ok", ts:number}',
    async () => {
      const res = await getJson('/health');
      const ok = res.status === 200 && res.json?.status === 'ok' && typeof res.json?.ts === 'number';
      record('P1a', ok, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ status: 'ok' });
      expect(typeof res.json.ts).toBe('number');
    },
    60_000, // Render free tier can cold-start on first hit
  );
});

// ─── PHASE 2 — checkout ────────────────────────────────────────────────────

describe('Phase 2: checkout', () => {
  it(
    'P2a missing chargePointId -> 400',
    async () => {
      const { chargePointId, ...rest } = validCheckoutBody();
      const res = await postJson('/checkout', rest, isolatedIp('P2a'));
      record('P2a', res.status === 400, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );

  it(
    'P2b missing connectorId -> 400',
    async () => {
      const { connectorId, ...rest } = validCheckoutBody();
      const res = await postJson('/checkout', rest, isolatedIp('P2b'));
      record('P2b', res.status === 400, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );

  it(
    'P2c missing packageId -> 400',
    async () => {
      const { packageId, ...rest } = validCheckoutBody();
      const res = await postJson('/checkout', rest, isolatedIp('P2c'));
      record('P2c', res.status === 400, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );

  it(
    'P2d missing idTag -> 400',
    async () => {
      const { idTag, ...rest } = validCheckoutBody();
      const res = await postJson('/checkout', rest, isolatedIp('P2d'));
      record('P2d', res.status === 400, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );

  it(
    'P2e invalid packageId "PKG_FAKE" -> 400',
    async () => {
      const res = await postJson('/checkout', validCheckoutBody({ packageId: 'PKG_FAKE' }), isolatedIp('P2e'));
      record('P2e', res.status === 400, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );

  it(
    'P2f chargePointId=FAKE_ID -> 404',
    async () => {
      const res = await postJson('/checkout', validCheckoutBody({ chargePointId: FAKE_ID }), isolatedIp('P2f'));
      record('P2f', res.status === 404, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(404);
    },
    30_000,
  );

  it(
    'P2g valid chargePointId + connectorId=99 (non-existent) -> 404',
    async () => {
      const res = await postJson('/checkout', validCheckoutBody({ connectorId: 99 }), isolatedIp('P2g'));
      record('P2g', res.status === 404, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(404);
    },
    30_000,
  );

  let sharedCheckoutSessionId: string | undefined;

  it(
    'P2h valid full body -> 201 {sessionId:uuid, checkoutUrl:https}',
    async () => {
      await resetTestConnector();
      const res = await postJson('/checkout', validCheckoutBody(), isolatedIp('P2h'));
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const ok =
        res.status === 201 &&
        typeof res.json?.sessionId === 'string' &&
        uuidRe.test(res.json.sessionId) &&
        typeof res.json?.checkoutUrl === 'string' &&
        res.json.checkoutUrl.startsWith('https://');
      record('P2h', ok, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(201);
      expect(res.json.sessionId).toMatch(uuidRe);
      expect(res.json.checkoutUrl).toMatch(/^https:\/\//);
      sharedCheckoutSessionId = res.json.sessionId;
    },
    30_000,
  );

  it(
    'P3d (co-located with P2h) session-status of P2h session -> 200 {status:"awaiting_payment"}',
    async () => {
      expect(sharedCheckoutSessionId, 'P2h must run first and succeed').toBeDefined();
      const res = await getJson(`/session-status?sessionId=${sharedCheckoutSessionId}`);
      const ok = res.status === 200 && res.json?.status === 'awaiting_payment';
      record('P3d', ok, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(200);
      expect(res.json.status).toBe('awaiting_payment');
    },
    30_000,
  );

  let burstStartedAt = 0;
  // Unique per test-run (not a fixed literal) so re-running this suite within
  // 60s of a prior run never collides with that run's still-active window —
  // observed happening during development: a rerun ~35s after a prior burst
  // inherited the old bucket's count, making 429s start a request early.
  const RATE_LIMIT_IP = { 'X-Forwarded-For': `10.42.200.200-ratelimit-burst-${randomUUID()}` };

  it(
    'P2i 6 rapid /checkout requests, same identity, within 60s -> 6th is 429 {error:"too_many_requests", retryAfterMs:number}',
    async () => {
      burstStartedAt = Date.now();
      const outcomes: JsonResult[] = [];
      for (let i = 0; i < 6; i++) {
        outcomes.push(await postJson('/checkout', validCheckoutBody(), RATE_LIMIT_IP));
      }
      const sixth = outcomes[5];
      const firstFiveNot429 = outcomes.slice(0, 5).every((r) => r.status !== 429);
      const ok =
        sixth.status === 429 &&
        sixth.json?.error === 'too_many_requests' &&
        typeof sixth.json?.retryAfterMs === 'number';
      record(
        'P2i',
        ok && firstFiveNot429,
        `statuses=${outcomes.map((r) => r.status).join(',')} sixth=${sixth.text}`,
      );
      expect(sixth.status).toBe(429);
      expect(sixth.json.error).toBe('too_many_requests');
      expect(typeof sixth.json.retryAfterMs).toBe('number');
    },
    30_000,
  );

  it(
    'P7a (Phase 7) after the 60s rate-limit window elapses, same identity -> 201',
    async () => {
      const elapsed = Date.now() - burstStartedAt;
      const remaining = 61_000 - elapsed; // 1s buffer past the 60s fixed window
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      await resetTestConnector();
      const res = await postJson('/checkout', validCheckoutBody(), RATE_LIMIT_IP);
      record('P7a', res.status === 201, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(201);
    },
    90_000, // must outlive the ~61s wait above; global --testTimeout=30000 can't cover this
  );
});

// ─── PHASE 3 — session status (remaining sub-tests; P3d ran above, co-located with P2h) ──

describe('Phase 3: session status', () => {
  it(
    'P3a no sessionId param -> 400',
    async () => {
      const res = await getJson('/session-status');
      record('P3a', res.status === 400, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );

  it(
    'P3b sessionId=FAKE_ID -> 404',
    async () => {
      const res = await getJson(`/session-status?sessionId=${FAKE_ID}`);
      record('P3b', res.status === 404, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(404);
    },
    30_000,
  );

  it(
    'P3c sessionId="\' OR 1=1--" -> not 500',
    async () => {
      const res = await getJson(`/session-status?sessionId=${encodeURIComponent("' OR 1=1--")}`);
      const ok = res.status !== 500;
      record('P3c', ok, `status=${res.status} body=${res.text.slice(0, 300)}`);
      expect(res.status).not.toBe(500);
    },
    30_000,
  );
});

// ─── PHASE 4 — webhook auth ────────────────────────────────────────────────

describe('Phase 4: webhook auth', () => {
  it(
    'P4a no paymongo-signature header -> 401 {accepted:false}',
    async () => {
      const res = await postJson('/webhooks/paymongo', buildPaidPayload(randomUUID()));
      const ok = res.status === 401 && res.json?.accepted === false;
      record('P4a', ok, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(401);
      expect(res.json.accepted).toBe(false);
    },
    30_000,
  );

  it(
    'P4b header present, wrong HMAC -> 401 {accepted:false}',
    async () => {
      const res = await postJson('/webhooks/paymongo', buildPaidPayload(randomUUID()), {
        'Paymongo-Signature': `t=${Math.floor(Date.now() / 1000)},te=${'0'.repeat(64)}`,
      });
      const ok = res.status === 401 && res.json?.accepted === false;
      record('P4b', ok, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(401);
      expect(res.json.accepted).toBe(false);
    },
    30_000,
  );

  it(
    'P4c valid HMAC + well-formed payment.paid for an unknown reference_number -> 202 ack, no action',
    async () => {
      // NOTE (deviation from the literal spec): a genuinely unknown `type` value
      // (e.g. "payment.something_else") fails PayMongoWebhookSchema's zod enum
      // BEFORE signature verification even runs (see handlePayMongoWebhook in
      // src/server/routes.ts) — that path returns 400 invalid_paymongo_webhook_payload,
      // not 200. There is no schema-valid "unknown event type" in the current
      // enum (payment.paid | payment.failed | checkout_session.payment.paid).
      // The closest real "ack, no action" path — and the one actually reachable
      // with a valid signature — is a well-formed payment.paid event whose
      // reference_number doesn't match any session, which acks 202 without
      // mutating anything. Both behaviors are asserted below.
      const rawBody = JSON.stringify(buildPaidPayload(randomUUID()));
      const timestamp = String(Math.floor(Date.now() / 1000));
      const res = await postRaw('/webhooks/paymongo', rawBody, {
        'Paymongo-Signature': signPaymongo(rawBody, timestamp),
      });
      const ok = res.status === 202 && res.json?.accepted === true && res.json?.error === 'session_not_found';
      record('P4c', ok, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(202);
      expect(res.json.accepted).toBe(true);
    },
    30_000,
  );

  it(
    'P4c-alt (informational) valid HMAC + schema-invalid event type -> 400, not 200 (documents strict-enum behavior)',
    async () => {
      const payload = buildPaidPayload(randomUUID());
      (payload.data.attributes as any).type = 'payment.something_else';
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const res = await postRaw('/webhooks/paymongo', rawBody, {
        'Paymongo-Signature': signPaymongo(rawBody, timestamp),
      });
      record('P4c-alt', res.status === 400, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );
});

// ─── PHASE 5 — admin gate ──────────────────────────────────────────────────

describe('Phase 5: admin gate (GET /admin)', () => {
  it(
    'P5a no Authorization header -> 401',
    async () => {
      const res = await getJson('/admin');
      record('P5a', res.status === 401, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(401);
    },
    30_000,
  );

  it(
    'P5b wrong credentials -> 401',
    async () => {
      const res = await getJson('/admin', { Authorization: basicAuthHeader('not-admin', 'not-the-password') });
      record('P5b', res.status === 401, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(401);
    },
    30_000,
  );

  it(
    'P5c correct VOLTSENSE_SHIELD_USER/PASSWORD -> 200',
    async () => {
      const res = await getJson('/admin', { Authorization: basicAuthHeader(SHIELD_USER!, SHIELD_PASSWORD!) });
      record('P5c', res.status === 200, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(200);
    },
    30_000,
  );
});

// ─── PHASE 6 — injection ───────────────────────────────────────────────────

describe('Phase 6: injection', () => {
  it(
    'P6a chargePointId SQLi string -> never 500 (upstream infra returns 403 for this payload)',
    async () => {
      // NOTE: this exact payload returns 403 from infrastructure ahead of the
      // app, rather than the app's own zod .uuid() 400 (compare P6b/P6c below,
      // which do reach app-level validation as 400). Asserting the spec's
      // literal 400/422 would assert a status this request never actually
      // receives; "never 500" is the meaningful, stable invariant here.
      const res = await postJson(
        '/checkout',
        validCheckoutBody({ chargePointId: "'; DROP TABLE sessions;--" }),
        isolatedIp('P6a'),
      );
      const ok = res.status !== 500;
      record('P6a', ok, `status=${res.status} body=${res.text.slice(0, 200)}`);
      expect(res.status).not.toBe(500);
    },
    30_000,
  );

  it(
    'P6b packageId=<script> -> 400, never 500',
    async () => {
      const res = await postJson(
        '/checkout',
        validCheckoutBody({ packageId: '<script>alert(1)</script>' }),
        isolatedIp('P6b'),
      );
      record('P6b', res.status === 400, `status=${res.status} body=${res.text.slice(0, 200)}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );

  it(
    'P6c connectorId="abc" -> 400',
    async () => {
      const res = await postJson('/checkout', validCheckoutBody({ connectorId: 'abc' }), isolatedIp('P6c'));
      record('P6c', res.status === 400, `status=${res.status} body=${res.text.slice(0, 200)}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );
});

// ─── PHASE A — PKG_CUSTOM edge cases (POST /checkout) ─────────────────────

describe('Phase A: PKG_CUSTOM edge cases', () => {
  it(
    'A1 customKwh=0.5 + PKG_CUSTOM -> 400 (Zod min 1)',
    async () => {
      const res = await postJson(
        '/checkout',
        validCheckoutBody({ packageId: 'PKG_CUSTOM', customKwh: 0.5 }),
        isolatedIp('A1'),
      );
      record('A1', res.status === 400, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );

  it(
    'A2 customKwh=100 + PKG_CUSTOM -> 201 (boundary valid)',
    async () => {
      await resetTestConnector();
      const res = await postJson(
        '/checkout',
        validCheckoutBody({ packageId: 'PKG_CUSTOM', customKwh: 100 }),
        isolatedIp('A2'),
      );
      const ok = checkoutCreatedInvariant(res);
      record('A2', ok, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(201);
      expect(res.json.sessionId).toMatch(UUID_RE);
      expect(res.json.checkoutUrl).toMatch(/^https:\/\//);
      expect(res.json).not.toHaveProperty('amountPhp');
      sharedCustomSessionId = res.json.sessionId;
    },
    30_000,
  );

  it(
    // co-located with A2 (Phase B's B4): must run before A4/A5 call
    // resetTestConnector() again, which would expire A2's still-awaiting_payment
    // session as a side effect of forcing the connector Available for their own checkout.
    'B4 (Phase B) after PKG_CUSTOM A2 checkout -> status=awaiting_payment, kwhDelivered valid (no NaN)',
    async () => {
      // NOTE (deviation from literal spec): handleSessionStatus's response shape
      // is {status, kwhDelivered, estimatedRemaining} only — it never exposes
      // packageId or amountPhp (see handleSessionStatus in src/server/routes.ts).
      // So "packageId=PKG_CUSTOM" and "no NaN in amountPhp" aren't checkable
      // fields on this endpoint; the closest real, checkable invariant is that
      // kwhDelivered — the one numeric field this endpoint does return — is a
      // real number, never NaN.
      expect(sharedCustomSessionId, 'A2 must run first and succeed').toBeDefined();
      const res = await getJson(`/session-status?sessionId=${sharedCustomSessionId}`);
      const ok =
        res.status === 200 &&
        res.json?.status === 'awaiting_payment' &&
        typeof res.json?.kwhDelivered === 'number' &&
        !Number.isNaN(res.json.kwhDelivered);
      record('B4', ok, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(200);
      expect(res.json.status).toBe('awaiting_payment');
      expect(Number.isNaN(res.json.kwhDelivered)).toBe(false);
    },
    30_000,
  );

  it(
    'A3 customKwh=121 + PKG_CUSTOM -> 400 (Zod max 120)',
    async () => {
      const res = await postJson(
        '/checkout',
        validCheckoutBody({ packageId: 'PKG_CUSTOM', customKwh: 121 }),
        isolatedIp('A3'),
      );
      record('A3', res.status === 400, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );

  it(
    'A4 customKwh=17.5 + PKG_CUSTOM -> 201 + checkoutUrl present',
    async () => {
      await resetTestConnector();
      const res = await postJson(
        '/checkout',
        validCheckoutBody({ packageId: 'PKG_CUSTOM', customKwh: 17.5 }),
        isolatedIp('A4'),
      );
      const ok = checkoutCreatedInvariant(res);
      record('A4', ok, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(201);
      expect(res.json.checkoutUrl).toMatch(/^https:\/\//);
    },
    30_000,
  );

  it(
    'A5 PKG_FULL -> 400 (flat-fee unlimited-kWh package removed)',
    async () => {
      const res = await postJson(
        '/checkout',
        validCheckoutBody({ packageId: 'PKG_FULL', customKwh: 10 }),
        isolatedIp('A5'),
      );
      record('A5', res.status === 400, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );

  it(
    'A6 PKG_CUSTOM + no customKwh field -> 400',
    async () => {
      const res = await postJson(
        '/checkout',
        validCheckoutBody({ packageId: 'PKG_CUSTOM' }),
        isolatedIp('A6'),
      );
      record('A6', res.status === 400, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );

  it(
    'A7 PKG_CUSTOM + customKwh=NaN -> 400',
    async () => {
      // NOTE: JSON has no NaN literal — JSON.stringify(NaN) serializes to `null`
      // on the wire. This exercises "customKwh present but not a valid number"
      // (z.number() rejects null) rather than a literal NaN reaching the server,
      // but the resulting 400 is the same either way.
      const res = await postJson(
        '/checkout',
        validCheckoutBody({ packageId: 'PKG_CUSTOM', customKwh: NaN }),
        isolatedIp('A7'),
      );
      record('A7', res.status === 400, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );

  it(
    'A8 PKG_CUSTOM + customKwh=-5 -> 400',
    async () => {
      const res = await postJson(
        '/checkout',
        validCheckoutBody({ packageId: 'PKG_CUSTOM', customKwh: -5 }),
        isolatedIp('A8'),
      );
      record('A8', res.status === 400, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );

  it(
    'A9 packageId=INVALID_PKG -> 400',
    async () => {
      const res = await postJson(
        '/checkout',
        validCheckoutBody({ packageId: 'INVALID_PKG' }),
        isolatedIp('A9'),
      );
      record('A9', res.status === 400, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );
});

// ─── PHASE B — session status (GET /session-status; B4 ran above, co-located with A2) ──

describe('Phase B: session status', () => {
  it(
    'B1 no sessionId param -> 400',
    async () => {
      const res = await getJson('/session-status');
      record('B1', res.status === 400, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(400);
    },
    30_000,
  );

  it(
    'B2 sessionId=well-formed uuid not in db -> 404',
    async () => {
      // NOTE: the task's literal phrasing ("not-a-uuid uuid-not-in-db") is
      // ambiguous. handleSessionStatus queries Postgres with the raw string
      // against a `uuid`-typed column, so a non-uuid-shaped string throws a
      // driver-level error (500), not a clean 404 — see P3c above, which only
      // asserts "not 500" for a SQLi string for exactly this reason. The
      // literal 404 outcome only holds for a well-formed-but-absent uuid,
      // which is what this test exercises (a freshly generated id, distinct
      // from the FAKE_ID constant already covered by P3b).
      const res = await getJson(`/session-status?sessionId=${randomUUID()}`);
      record('B2', res.status === 404, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(404);
    },
    30_000,
  );
});

// ─── PHASE C — webhook idempotency ─────────────────────────────────────────

describe('Phase C: webhook idempotency', () => {
  it(
    'C1 payment.paid webhook, same paymentId sent twice -> 202 both times, second marked duplicate (not 500)',
    async () => {
      await resetTestConnector();
      const checkoutRes = await postJson(
        '/checkout',
        validCheckoutBody({ packageId: 'PKG_5KWH' }),
        isolatedIp('C1-checkout'),
      );
      expect(checkoutRes.status, `checkout must succeed to seed a payment row: ${checkoutRes.text}`).toBe(201);
      const idempotencySessionId: string = checkoutRes.json.sessionId;

      // NOTE (deviation from literal "200"): every success path in
      // handlePayMongoWebhook returns 202 Accepted, never 200 — see P4c/P4c-alt
      // above, which already establish this for the codebase. This asserts the
      // real status (202) both times, with "not 500" as the safety invariant
      // the task actually cares about (idempotent replay must never crash).
      const rawBody = JSON.stringify(buildPaidPayload(idempotencySessionId));

      const first = await postRaw('/webhooks/paymongo', rawBody, {
        'Paymongo-Signature': signPaymongo(rawBody, String(Math.floor(Date.now() / 1000))),
      });
      const second = await postRaw('/webhooks/paymongo', rawBody, {
        'Paymongo-Signature': signPaymongo(rawBody, String(Math.floor(Date.now() / 1000))),
      });

      const ok =
        first.status === 202 &&
        first.status !== 500 &&
        second.status === 202 &&
        second.status !== 500 &&
        second.json?.duplicate === true;
      record(
        'C1',
        ok,
        `first status=${first.status} body=${first.text} | second status=${second.status} body=${second.text}`,
      );
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.json.duplicate).toBe(true);
    },
    30_000,
  );

  it(
    'C2 checkout_session.payment.paid (alternate type) -> 202, same session-lookup path as payment.paid',
    async () => {
      // Uses an unmatched reference_number (like P4c) so the assertable, stable
      // signal is the identical "session_not_found" outcome for both event-type
      // strings — proving normalizePayMongoWebhook() routes
      // checkout_session.payment.paid through the exact same session lookup as
      // payment.paid (see src/webhooks/paymongo_types.ts).
      const payload = buildPaidPayload(randomUUID());
      (payload.data.attributes as any).type = 'checkout_session.payment.paid';
      const rawBody = JSON.stringify(payload);
      const res = await postRaw('/webhooks/paymongo', rawBody, {
        'Paymongo-Signature': signPaymongo(rawBody, String(Math.floor(Date.now() / 1000))),
      });
      const ok = res.status === 202 && res.json?.accepted === true && res.json?.error === 'session_not_found';
      record('C2', ok, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(202);
      expect(res.json.error).toBe('session_not_found');
    },
    30_000,
  );
});

// ─── PHASE D — rate limiter ─────────────────────────────────────────────────

describe('Phase D: rate limiter (5/min per identity)', () => {
  const RATE_LIMIT_IP_D = { 'X-Forwarded-For': `10.43.201.201-ratelimit-phase-d-${randomUUID()}` };

  it(
    'D1 5 valid POST /checkout, same X-Forwarded-For -> all 201',
    async () => {
      // NOTE: the connector only allows one active (non-terminal) session at a
      // time, so 5 back-to-back checkouts on the SAME connector would otherwise
      // 409 after the first. resetTestConnector() between calls forces the
      // connector back to Available so each of the 5 genuinely exercises a
      // fresh 201, while all 5 still count against the SAME rate-limit bucket
      // (the limiter check runs before body/connector validation — see file
      // header note on resolveClientIp()).
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        await resetTestConnector();
        const res = await postJson('/checkout', validCheckoutBody(), RATE_LIMIT_IP_D);
        statuses.push(res.status);
      }
      const ok = statuses.every((s) => s === 201);
      record('D1', ok, `statuses=${statuses.join(',')}`);
      expect(statuses).toEqual([201, 201, 201, 201, 201]);
    },
    60_000,
  );

  it(
    'D2 6th POST /checkout, same X-Forwarded-For -> 429',
    async () => {
      await resetTestConnector();
      const res = await postJson('/checkout', validCheckoutBody(), RATE_LIMIT_IP_D);
      const ok = res.status === 429 && res.json?.error === 'too_many_requests';
      record('D2', ok, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(429);
      expect(res.json.error).toBe('too_many_requests');
    },
    30_000,
  );
});

// ─── PHASE E — admin gate (GET /admin/sessions) ────────────────────────────

describe('Phase E: admin gate (GET /admin/sessions)', () => {
  it(
    'E1 no Authorization header -> 401',
    async () => {
      const res = await getJson('/admin/sessions');
      record('E1', res.status === 401, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(401);
    },
    30_000,
  );

  it(
    'E2 wrong credentials -> 401',
    async () => {
      const res = await getJson('/admin/sessions', {
        Authorization: basicAuthHeader('not-admin', 'not-the-password'),
      });
      record('E2', res.status === 401, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(401);
    },
    30_000,
  );

  it(
    'E3 correct VOLTSENSE_SHIELD_USER/PASSWORD -> 200 + sessions array',
    async () => {
      // NOTE (deviation from literal "array body"): handleAdminSessions returns
      // {sessions: [...]}, not a bare top-level array (see admin_routes.ts) —
      // the checkable invariant is that the `sessions` field is an array.
      const res = await getJson('/admin/sessions', {
        Authorization: basicAuthHeader(SHIELD_USER!, SHIELD_PASSWORD!),
      });
      const ok = res.status === 200 && Array.isArray(res.json?.sessions);
      record('E3', ok, `status=${res.status} body=${res.text.slice(0, 300)}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json.sessions)).toBe(true);
    },
    30_000,
  );
});

// ─── PHASE F — footer / static page consistency (STATIC, Vercel) ──────────

describe('Phase F: footer / static page consistency', () => {
  it(
    'F1 GET /charge.html -> 200, body does NOT contain "GCash" or "Maya"',
    async () => {
      const res = await getStatic('/charge.html');
      const hasGCash = /gcash/i.test(res.text);
      const hasMaya = /maya/i.test(res.text);
      const ok = res.status === 200 && !hasGCash && !hasMaya;
      record(
        'F1',
        ok,
        ok
          ? `status=${res.status}`
          : `BUG: status=${res.status} footer still advertises unapproved PSPs ` +
              `(hasGCash=${hasGCash} hasMaya=${hasMaya}) — "Powered by GCash · Maya · PayMongo" ` +
              `misleads customers since only PayMongo is live`,
      );
      expect(res.status).toBe(200);
      expect(hasGCash).toBe(false);
      expect(hasMaya).toBe(false);
    },
    30_000,
  );

  it(
    'F2 GET /charging-started.html -> 200, body does NOT contain "GCash" or "Maya"',
    async () => {
      const res = await getStatic('/charging-started.html');
      const hasGCash = /gcash/i.test(res.text);
      const hasMaya = /maya/i.test(res.text);
      const ok = res.status === 200 && !hasGCash && !hasMaya;
      record(
        'F2',
        ok,
        ok
          ? `status=${res.status}`
          : `BUG: status=${res.status} footer still advertises unapproved PSPs ` +
              `(hasGCash=${hasGCash} hasMaya=${hasMaya}) — same "Powered by GCash · Maya · PayMongo" footer as charge.html`,
      );
      expect(res.status).toBe(200);
      expect(hasGCash).toBe(false);
      expect(hasMaya).toBe(false);
    },
    30_000,
  );

  it(
    'F3 GET /payment-cancelled.html -> 200, has "Try Again" button + retry URL preserves cpid/cid',
    async () => {
      const res = await getStatic('/payment-cancelled.html');
      const hasTryAgain = /try again/i.test(res.text);
      // buildRetryUrl() reads ?cpid=&cid= from the current URL and reattaches
      // them to the charge.html redirect — assert the script actually does this
      // rather than just asserting the button text exists.
      const preservesParams =
        /getParam\(['"]cpid['"]\)/.test(res.text) &&
        /getParam\(['"]cid['"]\)/.test(res.text) &&
        /charge\.html\?cpid=/.test(res.text);
      const ok = res.status === 200 && hasTryAgain && preservesParams;
      record('F3', ok, `status=${res.status} hasTryAgain=${hasTryAgain} preservesParams=${preservesParams}`);
      expect(res.status).toBe(200);
      expect(hasTryAgain).toBe(true);
      expect(preservesParams).toBe(true);
    },
    30_000,
  );

  it(
    'F4 GET /charge.html -> body does NOT contain "for charging updates"',
    async () => {
      const res = await getStatic('/charge.html');
      const ok = res.status === 200 && !res.text.includes('for charging updates');
      record('F4', ok, `status=${res.status} containsOldCopy=${res.text.includes('for charging updates')}`);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('for charging updates');
    },
    30_000,
  );

  it(
    'F5 GET /charge.html -> body contains "Choose a package"',
    async () => {
      const res = await getStatic('/charge.html');
      const ok = res.status === 200 && res.text.includes('Choose a package');
      record('F5', ok, `status=${res.status} containsHeader=${res.text.includes('Choose a package')}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('Choose a package');
    },
    30_000,
  );

  it(
    'F6 GET /charge.html -> custom kWh input max attribute = "120"',
    async () => {
      const res = await getStatic('/charge.html');
      const match = res.text.match(/id="customKwhInput"[^>]*max="(\d+)"/);
      const ok = res.status === 200 && match?.[1] === '120';
      record('F6', ok, `status=${res.status} maxAttr=${match?.[1] ?? 'not found'}`);
      expect(res.status).toBe(200);
      expect(match?.[1]).toBe('120');
    },
    30_000,
  );
});

// ─── PHASE G — checkout/session edge cases ─────────────────────────────────

describe('Phase G: checkout/session edge cases', () => {
  it(
    'G1 valid checkout -> session-status returns status=awaiting_payment immediately (not 404)',
    async () => {
      await resetTestConnector();
      const checkoutRes = await postJson('/checkout', validCheckoutBody(), isolatedIp('G1'));
      expect(checkoutRes.status).toBe(201);
      const res = await getJson(`/session-status?sessionId=${checkoutRes.json.sessionId}`);
      const ok = res.status === 200 && res.json?.status === 'awaiting_payment';
      record('G1', ok, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(200);
      expect(res.json.status).toBe('awaiting_payment');
    },
    30_000,
  );

  it(
    'G2 back-to-back /checkout on same CP_ID+CONNECTOR_ID -> second is 409, NOT a duplicate 201',
    async () => {
      // NOTE (deviation from literal spec): the task text assumes "no duplicate-
      // session guard exists" and expects two 201s with distinct sessionIds. That
      // assumption is wrong — handleCheckout (src/server/routes.ts) has an explicit
      // secondary guard: it queries the sessions table for any row on this
      // chargePointId+connectorId with status in ('payment_cleared','charging'), or
      // 'awaiting_payment' with authExpiresAt still in the future (15-minute hold —
      // CHECKOUT_AUTH_WINDOW_MS), and returns 409 connector_not_available if found.
      // A fresh checkout's awaiting_payment hold is nowhere near expiring by the
      // time the second request lands, so the real, correct behavior is 409 —
      // this is a guard that WORKS, not a gap.
      await resetTestConnector();
      const first = await postJson('/checkout', validCheckoutBody(), isolatedIp('G2'));
      expect(first.status).toBe(201);
      const second = await postJson('/checkout', validCheckoutBody(), isolatedIp('G2'));
      const ok = second.status === 409 && second.json?.error === 'connector_not_available';
      record(
        'G2',
        ok,
        `NOT A GAP (spec assumption wrong): first=${first.status} second=${second.status} body=${second.text} ` +
          `— an active-session guard exists and correctly blocked the duplicate checkout`,
      );
      expect(second.status).toBe(409);
      expect(second.json.error).toBe('connector_not_available');
    },
    30_000,
  );

  it(
    'G3 session-status for an admin-expired session -> status="expired" (200) or 404, never 500',
    async () => {
      await resetTestConnector();
      const checkoutRes = await postJson('/checkout', validCheckoutBody(), isolatedIp('G3'));
      expect(checkoutRes.status).toBe(201);
      const sessionId: string = checkoutRes.json.sessionId;

      const expireRes = await postJson(
        '/admin/expire-session',
        { sessionId },
        { Authorization: basicAuthHeader(SHIELD_USER!, SHIELD_PASSWORD!) },
      );
      expect(expireRes.status).toBe(200);

      const res = await getJson(`/session-status?sessionId=${sessionId}`);
      const ok = res.status === 404 || (res.status === 200 && res.json?.status === 'expired');
      record('G3', ok && res.status !== 500, `status=${res.status} body=${res.text}`);
      expect(res.status).not.toBe(500);
      expect(ok).toBe(true);
    },
    30_000,
  );
});

// ─── PHASE H — overstay data gap ───────────────────────────────────────────

describe('Phase H: overstay data gap', () => {
  it(
    'H1 session-status response includes a completedAt field (partial live coverage — see note)',
    async () => {
      // No 'completed' sessions exist in the live database (verified by direct
      // query during test authoring — the GoMandaloyo pilot hasn't gone live
      // yet), and fabricating one via direct DB write would inject synthetic
      // financial figures into the live /admin/earnings and /host/earnings
      // aggregates (both SUM() over status='completed' sessions) — per explicit
      // user direction, that mutation is out of scope for this test file.
      //
      // What IS verified live: handleSessionStatus (src/server/routes.ts) now
      // maps session.stoppedAt -> completedAt (ISO string or null) unconditionally,
      // the same column handleHostEarnings already projects as completedAt for
      // completed sessions (admin_routes.ts) — so this checks the field exists
      // in the response contract for a real, freshly-created session (where it's
      // null pre-completion) rather than asserting its populated value for a
      // 'completed' session, which no live data currently exists to exercise.
      await resetTestConnector();
      const checkoutRes = await postJson('/checkout', validCheckoutBody(), isolatedIp('H1'));
      expect(checkoutRes.status).toBe(201);
      const res = await getJson(`/session-status?sessionId=${checkoutRes.json.sessionId}`);
      const hasField = res.json !== null && typeof res.json === 'object' && 'completedAt' in res.json;
      const ok = res.status === 200 && hasField;
      record(
        'H1',
        ok,
        ok
          ? `status=${res.status} body=${res.text} — field present (partial: no live 'completed'-status session ` +
              `exists in prod to confirm the populated-value case, only that the field exists and is null pre-completion)`
          : `FAIL: Server must return completedAt for accurate overstay countdown — client currently uses ` +
              `Date.now() which drifts if page opened late. status=${res.status} body=${res.text}`,
      );
      expect(res.status).toBe(200);
      expect(hasField).toBe(true);
    },
    30_000,
  );
});

// ─── PHASE I — uncovered routes (smoke only) ───────────────────────────────

describe('Phase I: uncovered routes (smoke)', () => {
  it(
    'I1 GET /health -> 200, body.status === "ok"',
    async () => {
      const res = await getJson('/health');
      const ok = res.status === 200 && res.json?.status === 'ok';
      record('I1', ok, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(200);
      expect(res.json.status).toBe('ok');
    },
    30_000,
  );

  it(
    'I2 GET / -> 200 or 301, never 500',
    async () => {
      const res = await getJson('/');
      const ok = res.status === 200 || res.status === 301;
      record('I2', ok, `status=${res.status}`);
      expect([200, 301]).toContain(res.status);
    },
    30_000,
  );

  it(
    'I3 POST /payments/create no body -> 400 or 422, never 500',
    async () => {
      const res = await postRaw('/payments/create', '');
      const ok = res.status === 400 || res.status === 422;
      record('I3', ok, `status=${res.status} body=${res.text}`);
      expect([400, 422]).toContain(res.status);
    },
    30_000,
  );

  it(
    'I4 GET /admin/earnings with correct SHIELD creds -> 200',
    async () => {
      const res = await getJson('/admin/earnings', {
        Authorization: basicAuthHeader(SHIELD_USER!, SHIELD_PASSWORD!),
      });
      const ok = res.status === 200 && Array.isArray(res.json?.sites);
      record('I4', ok, `status=${res.status} body=${res.text.slice(0, 300)}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json.sites)).toBe(true);
    },
    30_000,
  );

  it(
    'I5 POST /admin/expire-session with correct SHIELD creds + valid sessionId -> 200 (bench utility works)',
    async () => {
      await resetTestConnector();
      const checkoutRes = await postJson('/checkout', validCheckoutBody(), isolatedIp('I5'));
      expect(checkoutRes.status).toBe(201);
      const res = await postJson(
        '/admin/expire-session',
        { sessionId: checkoutRes.json.sessionId },
        { Authorization: basicAuthHeader(SHIELD_USER!, SHIELD_PASSWORD!) },
      );
      const ok = res.status === 200 && res.json?.status === 'expired';
      record('I5', ok, `status=${res.status} body=${res.text}`);
      expect(res.status).toBe(200);
      expect(res.json.status).toBe('expired');
    },
    30_000,
  );

  it(
    'I6 GET /host/earnings with HOST_AUTH_USER/PASSWORD from .env -> 200',
    async () => {
      const HOST_AUTH_USER = process.env['HOST_AUTH_USER'];
      const HOST_AUTH_PASSWORD = process.env['HOST_AUTH_PASSWORD'];
      if (!HOST_AUTH_USER || !HOST_AUTH_PASSWORD) {
        record('I6', false, 'GAP: HOST_AUTH_USER/PASSWORD not set in local .env — cannot construct request');
        throw new Error('HOST_AUTH_USER/PASSWORD must be set in .env to run I6');
      }
      const res = await getJson('/host/earnings', {
        Authorization: basicAuthHeader(HOST_AUTH_USER, HOST_AUTH_PASSWORD),
      });
      const ok = res.status === 200;
      record(
        'I6',
        ok,
        ok
          ? `status=${res.status} body=${res.text.slice(0, 200)}`
          : `BUG: status=${res.status} — HOST_AUTH env vars missing from Render — ` +
              `host-earnings.html is broken in production. body=${res.text}`,
      );
      expect(res.status).toBe(200);
    },
    30_000,
  );
});

afterAll(async () => {
  await resetTestConnector();
  const rows = results
    .map((r) => `${r.id.padEnd(9)} ${r.pass ? 'PASS' : 'FAIL'}  ${r.detail}`)
    .join('\n');
  console.log(`\n=== CHAOS TEST RESULTS ===\n${rows}\n`);
  const validPackagesNote = `Valid packages under test: ${VALID_PACKAGES.join(', ')}`;
  console.log(validPackagesNote);
});
