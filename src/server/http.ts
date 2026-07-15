// VoltSense HTTP server — Xendit compliance routing boundary.
// GET / is public; /webhooks/* bypass Basic Auth (HMAC pending); admin/dev are shielded.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  loadShieldCredentialsFromEnv,
  verifyBasicAuth,
  type ShieldCredentials,
} from './basic_auth.js';
import type { SettlementDb } from '../services/settlement.js';
import {
  dispatchRoute,
  readRequestBody,
  requiresBasicAuth,
  type HttpMethod,
  type HttpResponse,
} from './routes.js';

const REALM = 'VoltSense Secure Surface';

// Paths the browser (charge.html on Vercel) is allowed to call directly.
const CORS_PUBLIC_PATHS: ReadonlySet<string> = new Set(['/checkout', '/health', '/ocpp/status', '/session-status']);

const CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// These endpoints carry a Basic Auth Authorization header entered by a human
// (host/admin dashboards), so they need 'Authorization' in Allow-Headers, and —
// since it's earnings/session data — a scoped origin rather than the wildcard
// used by the other public paths above.
const AUTH_SCOPED_CORS_PATHS: ReadonlySet<string> = new Set([
  '/host/earnings',
  '/admin/earnings',
  '/admin/sessions',
]);

const HOST_CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': 'https://voltsense-csms.vercel.app',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization',
};

const SUPPORTED_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
]);

function parseRequestUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? 'localhost';
  return new URL(req.url ?? '/', `http://${host}`);
}

function toHttpMethod(value: string): HttpMethod | null {
  if (!SUPPORTED_METHODS.has(value)) {
    return null;
  }
  return value as HttpMethod;
}

function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify({ error: 'authentication_required' }));
}

function writeHttpResponse(res: ServerResponse, response: HttpResponse): void {
  res.writeHead(response.statusCode, response.headers);
  res.end(response.body);
}

function enforceShield(
  req: IncomingMessage,
  method: HttpMethod,
  pathname: string,
  credentials: ShieldCredentials,
): boolean {
  if (!requiresBasicAuth(method, pathname)) {
    return true;
  }

  const authResult = verifyBasicAuth(req.headers, credentials);
  if (!authResult.ok) {
    return false;
  }

  return true;
}

export type HttpServerOptions = {
  readonly port: number;
  readonly host: string;
  readonly credentials: ShieldCredentials;
  readonly db: SettlementDb;
};

export function createVoltSenseHttpServer(options: HttpServerOptions) {
  const server = createServer(async (req, res) => {
    try {
      const requestUrl = parseRequestUrl(req);
      const method = toHttpMethod(req.method ?? 'GET');
      if (method === null) {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }

      const pathname = requestUrl.pathname;

      // Handle CORS preflight for public browser-facing endpoints.
      if (method === 'OPTIONS' && AUTH_SCOPED_CORS_PATHS.has(pathname)) {
        res.writeHead(204, HOST_CORS_HEADERS);
        res.end();
        return;
      }
      if (method === 'OPTIONS' && CORS_PUBLIC_PATHS.has(pathname)) {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      if (!enforceShield(req, method, pathname, options.credentials)) {
        sendUnauthorized(res);
        return;
      }

      const rawBody = await readRequestBody(req);
      const response = await dispatchRoute({
        method,
        pathname,
        searchParams: requestUrl.searchParams,
        headers: req.headers,
        rawBody,
        db: options.db,
        remoteAddress: req.socket.remoteAddress ?? 'unknown',
      });

      // Inject CORS headers on public/host paths so the browser accepts the response.
      const finalResponse =
        AUTH_SCOPED_CORS_PATHS.has(pathname)
          ? { ...response, headers: { ...response.headers, ...HOST_CORS_HEADERS } }
          : CORS_PUBLIC_PATHS.has(pathname)
            ? { ...response, headers: { ...response.headers, ...CORS_HEADERS } }
            : response;

      writeHttpResponse(res, finalResponse);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'internal_server_error';
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: message }));
    }
  });

  return server.listen(options.port, options.host);
}

export function startHttpServerFromEnv(db: SettlementDb): ReturnType<typeof createVoltSenseHttpServer> {
  const port = Number(process.env['PORT'] ?? '3000');
  const host = process.env['HOST'] ?? '0.0.0.0';
  const credentials = loadShieldCredentialsFromEnv();

  return createVoltSenseHttpServer({ port, host, credentials, db });
}
