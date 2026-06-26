# VoltSense — Engineering Guidelines

VoltSense is the CSMS core: an OCPP 1.6J backend and payment rail operated by
Civicgrid Software Development Services. These are the standing technical laws for
this codebase. Future agents and contributors must follow them automatically,
without being asked.

## Core Architectural Laws

### 1. Strict Discriminated Unions
**Always use strict Discriminated Unions for all webhook data maps and state
structures.** Any type that can take more than one shape — webhook payloads,
state machines, result/event objects — must be modeled as a discriminated union
with an explicit literal discriminant field (e.g. `status`, `kind`, `type`).

- Choose the discriminant by the field that actually changes the object's shape.
  When two fields vary independently (e.g. `psp` × `status`), discriminate on the
  one that drives the differing shape and validate the other as a closed `z.enum`.
  A flat `z.discriminatedUnion` permits exactly one discriminant key.
- Prefer `z.discriminatedUnion` over `z.union` for closed sets: it gives O(1)
  dispatch, exhaustive typing, and clear validation errors.
- Derive TypeScript types from the schema with `z.infer`. Never hand-roll a
  parallel `interface` that can drift from the validator.

### 2. Zero `any`
**No usage of the `any` keyword is permitted across the codebase.** This is
absolute — not in source, not in tests, not in casts.

- Untrusted input enters as `unknown` and is narrowed by a Zod schema before use.
- Reach for `unknown` + narrowing, generics, or precise types instead of `any`.
- Do not widen literal unions to `string` (no `psp: string`).

### 3. Money is string decimal
API JSON money fields are string decimals, never JSON numbers (§1.4.7). Validate
with a strict decimal regex and compute with `decimal.js`. No floating-point money.

## Validation & Parsing
- All inbound webhooks parse through their Zod schema at the boundary
  (`parseWebhookPayload` / `safeParseWebhookPayload`). Handlers receive fully typed,
  validated payloads — never raw bodies.
- Use `safeParse` when validation failure is an expected branch (return 400);
  use `parse` only in trusted contexts where a throw is acceptable.

## Verification
- `npm run typecheck` (`tsc --noEmit`) must pass with zero errors before any change
  is considered done.
- `npm test` (Vitest) must stay green.
- `npm run lint` must pass.

## Project Shape
- `src/webhooks/` — inbound payment webhook type layer and crypto verification.
- `src/services/` — settlement, refund, and related domain logic.
- `src/server/` — HTTP routing and request handling.
- `src/protocols/ocpp/` — OCPP 1.6J protocol layer.
- `public/` — static public assets (compliance landing page).
