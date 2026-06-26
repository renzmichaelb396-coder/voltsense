// HMAC-SHA256 webhook signature verification — Law §1.3.2 / §1.3.4 step 1
// Uses Node's native 'node:crypto' module exclusively. No third-party HMAC libs.
// timingSafeEqual enforced to prevent timing-oracle attacks on signature bytes.

import { createHmac, timingSafeEqual } from 'node:crypto';

// ─── Signature normalization ───────────────────────────────────────────────────
// PSPs prefix their signature strings differently:
//   GCash: raw 64-char lowercase hex
//   Maya: "sha256=<hex>" prefix (GitHub-style)
// We strip the prefix before comparing bytes.

function normalizeSignatureHex(raw: string): string {
  const PREFIX = 'sha256=';
  return raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw;
}

// ─── verifyWebhookSignature ───────────────────────────────────────────────────
// Strict HMAC-SHA256 comparison with no loose fallbacks.
//
// Parameters:
//   payload   — raw request body as UTF-8 string (must be read before parsing JSON)
//   signature — value from PSP's signature header or body field
//   secret    — per-PSP HMAC secret from environment; never a default/fallback
//
// Returns true only when signatures match byte-for-byte using constant-time compare.
// Returns false (never throws) on malformed hex, length mismatch, or invalid input.

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  if (!payload || !signature || !secret) return false;

  const expected = createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');

  const normalizedReceived = normalizeSignatureHex(signature).toLowerCase();

  // Reject immediately if lengths differ — timingSafeEqual requires equal-length buffers.
  // This branch is safe to exit early: lengths are public (not secret-dependent).
  if (normalizedReceived.length !== expected.length) return false;

  // Reject non-hex input — Buffer.from with invalid hex silently fills with zeroes,
  // which would produce a false-positive match against a zeroed expected buffer.
  if (!/^[0-9a-f]+$/i.test(normalizedReceived)) return false;

  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(normalizedReceived, 'hex');

  // Constant-time byte comparison — required by Law §1.3.2 (W-02 compliance test).
  return timingSafeEqual(expectedBuf, receivedBuf);
}

// ─── computeExpectedSignature ─────────────────────────────────────────────────
// Exposed for testing and diagnostic logging. Never compare the return value with
// === — always route through verifyWebhookSignature to preserve constant-time semantics.

export function computeExpectedSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}
