// Drizzle + postgres-js connection factory — Law §1.4.7
// DATABASE_URL is required at process startup; no lazy connect on first query.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import type { SettlementDb } from '../services/settlement.js';
import * as schema from './schema.js';

/** Drizzle instance — assigned by {@link loadDbFromEnv} before the HTTP server starts. */
export let db: SettlementDb;

const SUPABASE_TRANSACTION_POOLER_PORT = '6543';

// Warn (don't throw) if DATABASE_URL isn't on the Supabase transaction pooler
// port — a session-pooler or direct connection can still work locally, but
// leaks/exhausts connections under the short-lived-connection load this
// serverless-style deployment produces.
function warnIfNotTransactionPoolerPort(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  if (url.port !== SUPABASE_TRANSACTION_POOLER_PORT) {
    console.warn(
      `[voltsense:db] WARNING: DATABASE_URL port is ${url.port || '(default)'}, ` +
        `expected ${SUPABASE_TRANSACTION_POOLER_PORT} (Supabase transaction pooler). ` +
        `Connections may fail or leak under load.`,
    );
  }
}

export function loadDbFromEnv(): SettlementDb {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('[DB] DATABASE_URL is required');
  }

  warnIfNotTransactionPoolerPort(databaseUrl);

  const client = postgres(databaseUrl);
  db = drizzle(client, { schema }) as unknown as SettlementDb;
  return db;
}
