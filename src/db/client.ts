// Drizzle + postgres-js connection factory — Law §1.4.7
// DATABASE_URL is required at process startup; no lazy connect on first query.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import type { SettlementDb } from '../services/settlement.js';
import * as schema from './schema.js';

/** Drizzle instance — assigned by {@link loadDbFromEnv} before the HTTP server starts. */
export let db: SettlementDb;

export function loadDbFromEnv(): SettlementDb {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('[DB] DATABASE_URL is required');
  }

  const client = postgres(databaseUrl);
  db = drizzle(client, { schema }) as unknown as SettlementDb;
  return db;
}
