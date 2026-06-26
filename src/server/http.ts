// VoltSense HTTP server — Xendit compliance routing boundary.
// GET / is public; /webhooks/* bypass Basic Auth (HMAC pending); admin/dev are shielded.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  loadShieldCredentialsFromEnv,
  verifyBasicAuth,
  type ShieldCredentials,
} from './basic_auth.js';
import {
  dispatchRoute,
  readRequestBody,
  requiresBasicAuth,
  type HttpMethod,
  type HttpResponse,
} from './routes.js';

const REALM = 'VoltSense Secure Surface';

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
      if (!enforceShield(req, method, pathname, options.credentials)) {
        sendUnauthorized(res);
        return;
      }

      const rawBody = await readRequestBody(req);
      const response = await dispatchRoute({
        method,
        pathname,
        headers: req.headers,
        rawBody,
      });
      writeHttpResponse(res, response);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'internal_server_error';
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: message }));
    }
  });

  return server.listen(options.port, options.host);
}

export function startHttpServerFromEnv(): ReturnType<typeof createVoltSenseHttpServer> {
  const port = Number(process.env['PORT'] ?? '3000');
  const host = process.env['HOST'] ?? '0.0.0.0';
  const credentials = loadShieldCredentialsFromEnv();

  return createVoltSenseHttpServer({ port, host, credentials });
}
