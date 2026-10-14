# S27: Better Auth in workerd

Run on 2026-10-11 in workerd (`@cloudflare/vitest-plugin` 1.4.0, local D1). Code is in [`spikes/27-better-auth/`](../../spikes/27-better-auth/), and the run's output is in `spikes/27-better-auth/results.txt`.

## Answer

**PASS: GO.** `better-auth` 1.7.7 and `@better-auth/passkey` 1.7.7 (both published 2026-09-30, MIT) run in workerd on D1. All four cases passed:

- **Email OTP.** An OTP sent to a new address signs the person up and in. The session is an HttpOnly cookie, read back by `get-session`.
- **Passkeys.** A signed-in user registers a passkey (P-256, `none` attestation, from a software authenticator built in the test), then signs in with the passkey alone and gets a session for the same user. An assertion replayed with a counter that hasn't advanced is refused with 400 `AUTHENTICATION_FAILED`.
- **The device grant (RFC 8628).** `POST /device/code` answers a device code, a user code and the verification URI. Polling before approval answers `authorization_pending`. The signed-in user claims the code (`GET /device?user_code=…`) and approves it. Polling inside the interval answers `slow_down`, as the RFC requires. The token that comes back reads the same user's session as `Authorization: Bearer` (the bearer plugin).
- **Orgs.** The organization plugin creates an org whose only member is its creator, as `owner`.

**Fallback taken:** none. The email-OTP + GitHub fallback for a passkey failure isn't needed.

## Question

Can Better Auth be Keel's identity adapter inside a Worker? The test: its D1 support, the passkey plugin's registration and assertion, and the device-authorization plugin, all in workerd and not in Node.

## Findings that shape Keel's sign-in

- **D1 is native.** Pass the `D1Database` binding as `database`. The Kysely adapter then uses its own D1 dialect, with no extra package.
- **Migrations.** In 1.7.7, `getMigrations` is exported from `better-auth/db/migration`, not `better-auth/db`. It created `user`, `session`, `account`, `verification`, `passkey`, `deviceCode`, `organization`, `member` and `invitation` inside workerd. Keel will commit the generated SQL as a D1 migration instead, so schema changes stay reviewable and expand-only.
- **The device flow needs a claim step.** `POST /device/approve` refuses a code until a signed-in session has opened `GET /device?user_code=…`. That page is the console's `/device`.
- **The captcha plugin** in 1.7.7 has a Cloudflare Turnstile provider. It isn't used, because sign-up is open.
- **Plugins present in 1.7.7** that Keel uses: `organization` (with access control), `admin`, `deviceAuthorization`, `bearer`, `emailOTP` and `username`, plus `@better-auth/passkey`.

## Setup

- `src/worker.ts` mounts `betterAuth({ database: env.DB, basePath: "/v1/auth", plugins: [emailOTP, passkey, deviceAuthorization, bearer, organization, admin] })`.
- `test/auth.test.ts` drives it through the Worker's `fetch`, keeping the cookie jar by hand.
- The software authenticator encodes CBOR and DER itself and signs with WebCrypto, so registration and assertion are verified by the plugin's own WebAuthn code (SimpleWebAuthn 13).
- `pnpm install && pnpm test` in the spike's directory reproduces it.
