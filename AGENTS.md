# OpenRun

## Product purpose

OpenRun manages restaurant reservations and waiting lists for a small trusted group. Members use one page with restaurant tabs, contact one another before changing shared plans, and leave requests for an always-on remote service. Naniyori accepts party size and phone for tomorrow's morning roster; Catchtable accepts a visit plan and a time to prepare its reservation page. The server persists requests and runs the provider workflow without requiring a member's PC to stay awake.

Read `README.md` for the full system overview. Operational installation/cutover belongs in `docs/REMOTE_MACHINE.md`; time-specific progress and pending user decisions belong in `docs/DEVELOPMENT_HANDOFF.md`.

## System overview

- **One shared console**: `/` renders restaurant tabs and provider panels; `/waiting` redirects there. Tabs come from the authenticated console catalog. Adding a Catchtable store adds a tab in combined mode. Keep roster editing simple: members coordinate by contacting the applicant; public signup and per-person row ownership are not implemented.
- **Access**: one-use management links become HttpOnly/SameSite cookies. Multiple management sessions coexist. Remote-control viewers have narrower privileges and single-device takeover. Grants and sessions live in memory; restarting requires fresh links, while DB requests persist. Preserve owner authentication and Origin protection on all writes.
- **Two runtime modes**: `waiting:serve` / Docker target `waiting` runs the web/API and Syrup scheduler with PostgreSQL, without Catchtable credentials or a desktop. `remote:serve` / target `remote` runs both provider loops with legacy SQLite and the persistent Catchtable browser. These modes reuse code; they do not share a unified PostgreSQL/SQLite database. SQLite is also an explicit local test adapter, never a fallback for a failed PostgreSQL connection.
- **Waiting data**: PostgreSQL stores `waiting_requests`, `waiting_attempts` and versioned migration metadata. Apply migrations before starting; runtime does not perform DDL. Contacts use AES-GCM with a key derived from `OPENRUN_ADMIN_TOKEN`, supplied through SOPS/GCP KMS or environment/Secret. Public objects contain masked contacts only. Preserve this key with DB backups and restores. See `docs/POSTGRESQL.md`.
- **Naniyori experience**: show only tomorrow's 10:00 KST roster. On a configured closed day show that date as closed instead of skipping ahead. Same-phone saves update the scheduled row; members may resize or remove entries after contacting the applicant. Do not add future date/slot selection, execution-state dashboards, or automatic carryover to this flow. Reject writes bound to an outdated opening ID at midnight. Hours and closed days live in `src/waiting/config.ts`.
- **Syrup execution**: the workflow comes from `bots-on-lambda/syrupWaitingForNaniyori`. New morning requests warm Chromium at 09:58 and attempt from 10:00:01. A separate context enters party/phone, submits once, and reads provider result fields. Serialize roster saves and lock edits against claiming; execution uses the party size returned by the atomic claim. Started or uncertain submissions cannot be resized. Previously stored dates/times remain readable.
- **Execution and recovery**: schedulers poll DB requests inside the service; no external queue, Lambda or EventBridge is needed. PostgreSQL execution and recovery require one dedicated session advisory lock. State and attempt updates commit together, including `SUBMITTING` before the final click. Losing that session stops the service and browser. Restart recovery records interrupted or uncertain work without replaying it. Keep this bookkeeping on the server rather than exposing it as roster management.
- **Catchtable execution**: one persistent headed Chrome verifies the same account and reuses encrypted authentication state. Its scheduler checks login ten minutes before opening, then prepares the restaurant page and hands that same browser to the owner through Xvfb/x11vnc/noVNC. Final booking, payment and provider cancellation are not implemented.
- **Notifications**: Slack Incoming Webhook configuration may come from SOPS or environment. Notify only opted-in work or an explicitly requested message; the current waiting web form does not opt in. Notification failures cannot repeat provider submission.
- **Deployment target**: prioritize one waiting service on the existing OCI k3s homelab with a dedicated `openrun` database/role in its shared PostgreSQL. Use one scheduler replica and `Recreate`, with migrations applied first. The waiting app needs no data PVC; combined mode retains SQLite/profile/session volumes. Compose is the standalone reference. Production DB provisioning, Helm/ArgoCD integration, state migration and cutover have not been performed by ordinary development work.

| Location | Responsibility |
| --- | --- |
| `public/index.html`, `public/console.js` | Shared page, restaurant tabs and management access |
| `public/app.js`, `public/waiting.js`, `public/viewer.*` | Catchtable panel, Naniyori roster, remote browser viewer |
| `src/remote/` | Gateway, authentication, Catchtable browser coordinator, notifications, combined entrypoint |
| `src/app/` | Catchtable catalog, SQLite store and booking-preparation scheduler |
| `src/waiting/` | KST roster rules, encryption, stores/migrations, Syrup runner/scheduler, waiting-only entrypoint |
| `src/catchtable.ts`, `src/session.ts` | Provider authentication and encrypted session capture/restoration |

Provider details belong in `docs/CATCHTABLE.md` and `docs/SYRUP_WAITING.md`. Keep this file and README focused on the whole product and architecture.

## Development

- Use the version pinned in `.node-version` / `.nvmrc`: Node 26.13.0. Modules run as native TypeScript. Keep strict checking and erasable syntax; no build step or additional TypeScript runner is required.
- Run `npm run check` and `npm test`. Browser tests intercept every provider request. For gateway/browser changes run `tests/integration/remote-desktop.e2e.ts` in the Docker image; for waiting changes also run `tests/integration/waiting.e2e.ts`.
- GitHub Actions CI is intentionally disabled. Run the relevant checks locally.
- Run `npm run test:postgres` for real PostgreSQL transactions, advisory-lock fencing, recovery and both waiting integration flows. It creates and removes its own disposable PostgreSQL 18 container; never point tests at homelab databases. `OPENRUN_POSTGRES_TEST_IMAGE` runs the same suite inside the built waiting image. Runtime requires applied migrations (`npm run waiting:db:migrate`); it never falls back from PostgreSQL to a local SQLite file.
- Keep dates and slots in Asia/Seoul/KST. Derive tomorrow and provider run times on the server, not from the client's local time zone.
- The waiting-only service must start without Catchtable credentials or a virtual display. Keep the owner gate and Origin protection in this mode. Existing DB rows without explicit preparation/attempt times must remain readable.
- Preserve the one-account Catchtable coordinator and isolate Syrup contexts. Do not use a provider's unverified generic success banner as a confirmed reservation.

## Operational boundaries

- Catchtable `READY` means prepared, and `COMPLETED` means the owner acknowledged checking their booking history. Syrup `SUCCEEDED` needs the provider's result fields. `UNKNOWN` after submission needs manual reconciliation before another attempt.
- CAPTCHA and additional authentication are human-only. Keep account identity checks and do not bypass them.
- Real reservations/waiting, payments, cancellations, and Slack messages require concrete user authorization. An explicitly scheduled and confirmed web request authorizes its selected provider action and optional result notification. Never perform these operations as routine tests.
- The previously authorized Slack connection test was already sent and received; it is not ongoing authorization for new test messages. No real Naniyori waiting registration has been run in this project yet.
- This repository is public: never commit real SOPS documents, `.env`, cookies, profiles, databases, screenshots, credentials, or state archives. Do not print decrypted secrets, full contacts, authenticated responses, raw page HTML or raw Playwright errors.
- Use temporary test state. Do not restart production, remove its volume, alter the old Lambda/EventBridge configuration, or migrate live state as part of ordinary code verification.
