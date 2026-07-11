// HTTP Basic Authentication shield — protects admin, dev, and webhook routes.
// Public surface (GET /) bypasses this module entirely in the router.

import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export type ShieldCredentials = {
  readonly username: string;
  readonly password: string;
};

export type BasicAuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'missing' | 'malformed' | 'invalid' };

const BASIC_AUTH_SCHEME = 'Basic ';

function decodeBasicAuthHeader(headerValue: string): ShieldCredentials | null {
  if (!headerValue.startsWith(BASIC_AUTH_SCHEME)) {
    return null;
  }

  const encoded = headerValue.slice(BASIC_AUTH_SCHEME.length).trim();
  if (encoded.length === 0) {
    return null;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex <= 0) {
    return null;
  }

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  if (username.length === 0) {
    return null;
  }

  return { username, password };
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left, 'utf8');
  const rightBuf = Buffer.from(right, 'utf8');
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return timingSafeEqual(leftBuf, rightBuf);
}

export function verifyBasicAuth(
  headers: IncomingHttpHeaders,
  expected: ShieldCredentials,
): BasicAuthResult {
  const authorization = headers.authorization;
  if (authorization === undefined || authorization.length === 0) {
    return { ok: false, reason: 'missing' };
  }

  const presented = decodeBasicAuthHeader(authorization);
  if (presented === null) {
    return { ok: false, reason: 'malformed' };
  }

  const usernameMatch = constantTimeEqual(presented.username, expected.username);
  const passwordMatch = constantTimeEqual(presented.password, expected.password);
  if (!usernameMatch || !passwordMatch) {
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true };
}

export function loadShieldCredentialsFromEnv(): ShieldCredentials {
  const username = process.env['VOLTSENSE_SHIELD_USER'];
  const password = process.env['VOLTSENSE_SHIELD_PASSWORD'];

  if (username === undefined || username.length === 0) {
    throw new Error('[SHIELD] VOLTSENSE_SHIELD_USER must be set');
  }
  if (password === undefined || password.length === 0) {
    throw new Error('[SHIELD] VOLTSENSE_SHIELD_PASSWORD must be set');
  }
  if (password === 'change-me') {
    throw new Error(
      '[SHIELD] VOLTSENSE_SHIELD_PASSWORD must be set to a strong secret — ' +
        'the default placeholder "change-me" is not permitted',
    );
  }

  return { username, password };
}

// Distinct from VOLTSENSE_SHIELD_* — hosts (e.g. Go Hotels) get scoped read-only
// earnings access without holding the platform admin shield credentials.
export function loadHostShieldCredentialsFromEnv(): ShieldCredentials {
  const username = process.env['HOST_AUTH_USER'];
  const password = process.env['HOST_AUTH_PASSWORD'];

  if (username === undefined || username.length === 0) {
    throw new Error('[HOST_SHIELD] HOST_AUTH_USER must be set');
  }
  if (password === undefined || password.length === 0) {
    throw new Error('[HOST_SHIELD] HOST_AUTH_PASSWORD must be set');
  }

  return { username, password };
}
