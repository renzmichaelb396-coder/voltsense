// OCPP 1.6J Security Profiles — WebSocket handshake authentication contract
// Profiles 1 and 2 only (VoltSense pilot scope). No Profile 0 (open) in production.

import { timingSafeEqual } from 'node:crypto';

// ─── Profile ID enum (OCPP 1.6 Appendix 5) ───────────────────────────────────

export const OCPP_SECURITY_PROFILE_ID = {
  PROFILE_1: 1,
  PROFILE_2: 2,
} as const;

export type OcppSecurityProfileId =
  (typeof OCPP_SECURITY_PROFILE_ID)[keyof typeof OCPP_SECURITY_PROFILE_ID];

// ─── Auth mode literals ────────────────────────────────────────────────────────

export type OcppPasswordAuthMode = 'basic_password';
export type OcppTlsClientAuthMode = 'tls_client_certificate';

// ─── Discriminated union — profile field is the discriminant ─────────────────

export type OcppSecurityProfile1 = {
  readonly profile: typeof OCPP_SECURITY_PROFILE_ID.PROFILE_1;
  readonly authMode: OcppPasswordAuthMode;
  readonly transport: 'wss';
  readonly subprotocol: 'ocpp1.6';
  readonly basicAuthUsername: string;
  readonly basicAuthPassword: string;
  readonly tlsMinVersion: 'TLSv1.2';
};

export type OcppSecurityProfile2 = {
  readonly profile: typeof OCPP_SECURITY_PROFILE_ID.PROFILE_2;
  readonly authMode: OcppTlsClientAuthMode;
  readonly transport: 'wss';
  readonly subprotocol: 'ocpp1.6';
  readonly clientCertificatePem: string;
  readonly clientPrivateKeyPem: string;
  readonly caCertificatePem: string;
  readonly tlsMinVersion: 'TLSv1.2';
};

export type OcppSecurityProfile = OcppSecurityProfile1 | OcppSecurityProfile2;

// ─── Runtime handshake context (injected at WebSocket upgrade) ───────────────

export type OcppHandshakeCredentials =
  | {
      readonly profile: typeof OCPP_SECURITY_PROFILE_ID.PROFILE_1;
      readonly username: string;
      readonly password: string;
    }
  | {
      readonly profile: typeof OCPP_SECURITY_PROFILE_ID.PROFILE_2;
      readonly clientCertificatePem: string;
      readonly clientPrivateKeyPem: string;
    };

// ─── Type guards ─────────────────────────────────────────────────────────────

export function isSecurityProfile1(
  profile: OcppSecurityProfile,
): profile is OcppSecurityProfile1 {
  return profile.profile === OCPP_SECURITY_PROFILE_ID.PROFILE_1;
}

export function isSecurityProfile2(
  profile: OcppSecurityProfile,
): profile is OcppSecurityProfile2 {
  return profile.profile === OCPP_SECURITY_PROFILE_ID.PROFILE_2;
}

export function isProfile1Credentials(
  creds: OcppHandshakeCredentials,
): creds is Extract<OcppHandshakeCredentials, { profile: typeof OCPP_SECURITY_PROFILE_ID.PROFILE_1 }> {
  return creds.profile === OCPP_SECURITY_PROFILE_ID.PROFILE_1;
}

export function isProfile2Credentials(
  creds: OcppHandshakeCredentials,
): creds is Extract<OcppHandshakeCredentials, { profile: typeof OCPP_SECURITY_PROFILE_ID.PROFILE_2 }> {
  return creds.profile === OCPP_SECURITY_PROFILE_ID.PROFILE_2;
}

// ─── Profile lookup ──────────────────────────────────────────────────────────

const SUPPORTED_PROFILES: ReadonlySet<OcppSecurityProfileId> = new Set<OcppSecurityProfileId>([
  OCPP_SECURITY_PROFILE_ID.PROFILE_1,
  OCPP_SECURITY_PROFILE_ID.PROFILE_2,
]);

export function isSupportedSecurityProfile(
  value: unknown,
): value is OcppSecurityProfileId {
  return (
    typeof value === 'number' &&
    (value === OCPP_SECURITY_PROFILE_ID.PROFILE_1 ||
      value === OCPP_SECURITY_PROFILE_ID.PROFILE_2) &&
    SUPPORTED_PROFILES.has(value)
  );
}

export function assertSecurityProfile(
  value: unknown,
): asserts value is OcppSecurityProfileId {
  if (!isSupportedSecurityProfile(value)) {
    throw new Error(
      `[OCPP SECURITY] Unsupported profile id=${String(value)}. ` +
      `Only Profile 1 (basic password) and Profile 2 (TLS client cert) are permitted.`,
    );
  }
}

// ─── Handshake validation ────────────────────────────────────────────────────

// Read once at module load — these are static process configuration, not
// per-request state. In production, missing credentials crash the server at
// boot rather than silently falling back to accept-all auth (P0 §18).
const configuredAuthUser = process.env['OCPP_AUTH_USER'];
const configuredAuthPassword = process.env['OCPP_AUTH_PASSWORD'];

if (configuredAuthUser === undefined || configuredAuthPassword === undefined) {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      '[OCPP SECURITY] OCPP_AUTH_USER and OCPP_AUTH_PASSWORD must be set in production. ' +
        'Server cannot start without them.',
    );
  }
  console.error(
    '[voltsense:ocpp] OCPP_AUTH_USER or OCPP_AUTH_PASSWORD not set — ' +
      'WebSocket auth is disabled. Set these before going live.',
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left, 'utf8');
  const rightBuf = Buffer.from(right, 'utf8');
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return timingSafeEqual(leftBuf, rightBuf);
}

export function validateHandshakeCredentials(
  creds: OcppHandshakeCredentials,
): void {
  if (isProfile1Credentials(creds)) {
    if (creds.username.length === 0 || creds.password.length === 0) {
      throw new Error('[OCPP SECURITY] Profile 1 requires non-empty username and password');
    }

    if (configuredAuthUser === undefined || configuredAuthPassword === undefined) {
      // Unreachable in production — the module-load check above throws first.
      // dev/test: accept non-empty creds without checking specific values.
      return;
    }

    const usernameMatches = constantTimeEqual(creds.username, configuredAuthUser);
    const passwordMatches = constantTimeEqual(creds.password, configuredAuthPassword);
    if (!usernameMatches || !passwordMatches) {
      throw new Error(
        '[OCPP SECURITY] Profile 1 credentials do not match configured OCPP_AUTH_USER/OCPP_AUTH_PASSWORD',
      );
    }
    return;
  }

  if (creds.clientCertificatePem.length === 0 || creds.clientPrivateKeyPem.length === 0) {
    throw new Error('[OCPP SECURITY] Profile 2 requires client certificate and private key PEM');
  }
}

export function securityProfileLabel(profile: OcppSecurityProfileId): string {
  switch (profile) {
    case OCPP_SECURITY_PROFILE_ID.PROFILE_1:
      return 'OCPP Security Profile 1 — TLS + HTTP Basic Authentication';
    case OCPP_SECURITY_PROFILE_ID.PROFILE_2:
      return 'OCPP Security Profile 2 — TLS + Client Certificate Authentication';
    default:
      return assertNeverProfile(profile);
  }
}

function assertNeverProfile(x: never): never {
  throw new Error(`Exhaustive check failed: ${String(x)}`);
}
