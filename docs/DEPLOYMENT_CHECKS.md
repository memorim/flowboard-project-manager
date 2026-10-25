# Revision and release checks

The standalone Node API returns `X-App-Revision` on `/api/health`. Set `APP_REVISION` to the exact 40-character source commit SHA when starting a verified build. Omitted/invalid values report `local-unversioned`; the server does not invent a deployed revision. This operator-supplied header helps detect deployment drift; it is not a signed software attestation.

After the service is running, use `SMOKE_URL=http://127.0.0.1:4100 EXPECTED_REVISION=<source-sha> pnpm smoke` in a POSIX shell. In PowerShell set `$env:SMOKE_URL` and `$env:EXPECTED_REVISION` before `pnpm smoke`. A non-200 response, wrong content type/body, missing revision or revision mismatch exits nonzero. The check is read-only and never creates/deletes application data. It deliberately rejects redirects and credential-bearing URLs.

Before releasing: verify the source branch CI; back up the operator database; rehearse upgrade/restore with a copy; set the exact source revision; start in the supported identity/network mode; run smoke; check the primary user scenario manually. Preserve the old deployment and backup for rollback. Never delete a database to fix a failed migration.

GitHub source changes do not automatically upgrade the separate native D1 Site. Its authentication, migration order and source provenance must be validated from the full Sites project. No production Site deployment or database migration is included in this audit branch. A browser-only Pages build is a different execution mode and has no Node health header. Standalone Seatly remains a loopback-only demo; the other projects' identity/network restrictions still apply.
