# Flowboard — Project Manager

Coordinate projects and tasks without silently overwriting another participant’s changes.

[Browser-only demo](https://memorim.github.io/flowboard-project-manager/) · [Hosted sandbox](https://memorim-flowboard-live.amusedcorgi34.chatgpt.site)

The browser-only build stores data locally. The hosted sandbox is a separate revision/deployment; new local audit guarantees are described below.

![Current local desktop interface](docs/desktop.png)

<img src="docs/mobile.png" width="320" alt="Current local mobile interface">

Screenshots were captured from the running local application with its bundled fixture data.

[Earlier sandbox interaction recording](docs/demo.gif)

## Implemented

- Kanban, task editor, filters, calendar and progress calculated from tasks.
- Private workspaces, owner/editor/viewer roles, expiring one-use invitations and owner export.
- Version-checked updates, a recycle bin, restoration, task history and activity records.

## Stack and architecture

React, TypeScript and Vite; Express, Zod and built-in Node SQLite.

```mermaid
flowchart LR
React --> API[Shared flowApi]
Identity[Verified identity adapter] --> API
API --> Batch[Transactional batch and version check]
Batch --> DB[(SQLite locally / D1 hosted)]
```

## Technical mechanisms and security

- `src/flow-api.ts` is the business/API implementation shared with the local SQLite adapter. `batch` is transactional; task updates use `WHERE id=? AND version=?`. A stale write returns HTTP 409, and the UI retains the draft.
- `server/access-constraints.sql` checks current membership inside task mutations, validates assignees and requires current ownership when creating invitations. An editor revoked after request validation cannot commit a late write.
- Membership/project changes use SQL conditions that recheck current privileges. Task changes, history triggers and activity are committed together; failures roll the batch back.
- Invitation tokens contain 32 random bytes; only hashes are stored. Conditional acceptance grants one membership, and a consumed/expired invitation returns 410.
- Standalone accounts use verified server sessions; client-selected actor headers are ignored. New accounts can create private workspaces and have read-only access to the sample workspace. The separate browser/native sandboxes retain their documented collaborative behavior.

## Local setup

Node.js 24.18.0 and pnpm 11.7.0 (see version files).

```bash
npm install --global pnpm@11.7.0
pnpm install --frozen-lockfile
# Provision an account using docs/SESSION_AUTH.md to edit private workspaces.
pnpm build
pnpm start
```

Open `http://localhost:4100`. For live UI development use `pnpm dev` where available. The API binds to `127.0.0.1` by default.

## Configuration

Configure process environment variables using [.env.example](.env.example). `pnpm start` uses the process environment; it does not implicitly load that file. To load a copied `.env` explicitly, run `node --env-file=.env --import tsx server/index.ts`.

## Database and upgrades

SQLite is stored at `data/flowboard.db`. Initialization creates/migrates the schema; sample rows are included for local use. Back up the database before upgrades. Do not remove the database as a migration step.

## Verification

```bash
pnpm lint
pnpm format:check
pnpm test
pnpm test:contract
pnpm test:upgrade
pnpm typecheck
pnpm build
pnpm exec playwright install chromium firefox webkit
pnpm test:e2e
pnpm test:e2e:auth
pnpm audit --audit-level=high
```

`tests/audit.test.ts`: revocation between validation and commit, and competing invitation acceptance. Existing API/E2E tests cover viewer restrictions, workspace isolation, stale versions, draft preservation, restoration and backup recovery.

CI installs locked dependencies and runs the configured checks; documentation checks also validate local links/images. A passing scanner only reports known advisories at the time of the run.

[Account provisioning, trust modes and migration](docs/SESSION_AUTH.md). The standalone server starts read-only until you log in; no sample passwords are provisioned automatically.

## Limits and next steps

- Standalone authentication uses administrator-provisioned accounts, salted scrypt and opaque revocable cookie sessions. Demo identity requires explicit non-production loopback configuration. See [session setup and migration](docs/SESSION_AUTH.md).
- The native hosted version uses ChatGPT identity and D1. Its currently deployed revision is separate; repository security fixes are not a claim that a new Site version has been deployed.
- The public sandbox is intentionally collaborative. Request limits and workspace quotas are small per-demo controls, not distributed admission control.
- SQLite is a single-writer store. No email invitation delivery, billing or organization directory integration is implemented.

## Further documentation

[Audit findings and follow-up](docs/AUDIT_2026_10.md) · [Technical reference](docs/TECHNICAL.md) · [Change history](CHANGELOG.md)

[API request/response example](docs/API_EXAMPLE.md)

[Scheduled backups and recovery](docs/SCHEDULED_BACKUPS.md) · [Hosted adapter](hosting/README.md)

[Revision and deployment checks](docs/DEPLOYMENT_CHECKS.md) — read-only `pnpm smoke` verifies a running Node API and an optional expected source SHA.
