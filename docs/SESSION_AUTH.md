# Standalone identity and session model

The standalone Node server defaults to `FLOW_AUTH_MODE=session`. Client-supplied `X-Demo-Actor` values are ignored in this mode. The native Site keeps its separate ChatGPT identity adapter; this change does not deploy or replace that adapter.

## Create an account

Install dependencies and back up an existing database. Copy `.account.env.example` to `.account.env`, then edit it locally with your email, display name and a unique 15–128 character password. The local credential file is ignored by Git.

```bash
# Linux/macOS
cp .account.env.example .account.env
# Windows PowerShell: Copy-Item .account.env.example .account.env
# Edit .account.env before running the next command.
pnpm account:create
```

The CLI prints the created member ID and never the password/hash. Delete the local credential file when provisioning is complete. There is no open account-registration endpoint.

To preserve an existing member's workspace ownership, set `FLOW_USER_MEMBER_ID` to that member's ID in the local credential file. This is an administrator-only database operation; the browser cannot claim an existing member. Existing names, tasks and memberships are retained. A duplicate account/email fails atomically.

## Login and logout

`POST /api/auth/login` accepts `{email,password}` as JSON. The UI provides a native accessible dialog. Successful login rotates the current cookie and stores only a SHA-256 hash of a random 32-byte session token. Sessions expire after 24 hours and logout deletes the current server record. Account passwords use salted scrypt with N=32768, r=8, p=3.

Cookie properties are HttpOnly, SameSite=Strict and Path=/. Secure is enabled for an HTTPS public origin or production configuration. The browser does not persist passwords or tokens in localStorage.

All unsafe API requests reject cross-site fetches and mismatched Origin. JSON/body lengths, login attempts, KDF concurrency and the rate-limit map are bounded. Limits are per process; place a shared admission/rate limiter in front of multiple replicas. Password reset, MFA, session management across devices and verified email delivery are outside this implementation.

## Production configuration

Configure `NODE_ENV=production` and an explicit HTTPS `FLOW_PUBLIC_ORIGIN`. Terminate TLS at a controlled reverse proxy and preserve the public origin. Trust in forwarded headers is not enabled automatically. The server refuses production startup without an HTTPS public origin; deployment still requires separate operational verification.

`FLOW_AUTH_MODE=demo` preserves the old fixture-identity workflow only when explicitly selected on a non-production loopback server. Both the configured bind host and incoming peer/host are checked. It is not an alternative to account authentication on a public backend.

New standalone accounts have read-only access to the public sample workspace and can create private workspaces. Demo/native adapters retain their explicit collaborative sandbox behavior. Owners invite members as editor/viewer; membership and version checks remain in SQL at write time.

## Reproduce the checks

```bash
pnpm test
pnpm test:contract
pnpm test:upgrade
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test:e2e:auth
```

`real-sessions.test.ts` covers session rotation/revocation/expiry, password/token storage, private isolation, viewer/editor/owner boundaries, a conflicting edit and revocation. `session-auth.test.ts` reproduces the old header impersonation problem. The browser auth fixture uses isolated temporary accounts and checks desktop/mobile login, a private task, persistence and logout.
