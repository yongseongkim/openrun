# OpenRun

## Product purpose

OpenRun manages restaurant reservations and waiting-list registration for a small trusted group across providers. The user records a restaurant, visit date, party size, contact information where needed, and a release/registration slot. An always-on remote service persists the request, runs the provider workflow at the chosen time, and records its result or hands the same server browser to the owner.

Read `README.md` for the full system overview. Operational installation/cutover belongs in `docs/REMOTE_MACHINE.md`; time-specific progress and pending user decisions belong in `docs/DEVELOPMENT_HANDOFF.md`.

## System overview

- **Web and owner API**: one OpenRun page at `/` has restaurant tabs for Syrup and available Catchtable stores. `/waiting` redirects to this page. One-use management grants become HttpOnly/SameSite cookies; management sessions coexist so acquaintances can share and edit the roster. Remote-control viewers retain separate privileges and single-device takeover. Members contact one another before changing shared party sizes; no public signup or per-person ownership workflow is included.
- **Persistence**: production waiting uses PostgreSQL (`DATABASE_URL`) with `waiting_requests`, `waiting_attempts` and versioned SQL migrations. Catchtable and explicit local fixtures retain SQLite. Waiting contacts share AES-GCM encryption derived from the admin token; public objects contain only masked contacts. Preserve the admin token when moving or restoring data. See `docs/POSTGRESQL.md`.
- **Catchtable provider**: a persistent headed Chrome verifies the same account and reuses encrypted session state. Its scheduler prepares a restaurant page and hands that context to the owner through Xvfb/x11vnc/noVNC. Final booking, payment and provider cancellation are not implemented.
- **Syrup provider**: the Naniyori workflow is ported from `bots-on-lambda/syrupWaitingForNaniyori`. Its tab shows only tomorrow's 10:00 KST roster. Closed days are shown without skipping to another day. Users enter party size and phone; a repeat save with the same full phone updates the scheduled row. Members can also resize or remove a row after contacting the applicant. Serialize saves and edits against claiming; started or uncertain submissions cannot be resized. Bind writes to the displayed opening ID and reject stale forms at midnight. Execution uses the party size returned by the atomic claim. A separate context enters party/phone and submits once. New requests warm up at 09:58 and attempt from 10:00:01. Existing stored dates/times remain readable. Store hours and closed days live in `src/waiting/config.ts`.
- **Schedulers**: separate provider loops share a single service and durable state. PostgreSQL waiting holds a dedicated session advisory lock; recovery and all execution transitions use that same session. Request and attempt changes commit together, including `SUBMITTING` before a Syrup final click. Loss of that session stops the service and browser. Uncertain submissions and interrupted runs cannot silently replay.
- **Notifications**: SOPS-configured Slack Incoming Webhook, only for opted-in work or an explicit user-requested message. Notification failures must not repeat provider submission.
- **Deployment**: prioritize the existing OCI k3s homelab and its shared PostgreSQL, with a dedicated `openrun` database/role. Docker target `waiting` is a stateless web/API/scheduler; `compose.waiting.yaml` is the standalone reference. No app PVC, Catchtable account or desktop is needed. Run one scheduler replica with `Recreate`; apply DB migrations before rollout. Existing combined mode retains SQLite. Helm/ArgoCD integration and production cutover are separate from ordinary code verification.

Code map: `src/remote/` owns the gateway/authentication and notifications, `src/app/` the Catchtable catalog/store/scheduler, `src/waiting/` the Syrup catalog/store/runner/scheduler, and `public/console.js` the shared restaurant-tab shell, `public/app.js` and `public/waiting.js` the provider panels, and `public/viewer.*` the remote browser.

Provider details belong in `docs/CATCHTABLE.md` and `docs/SYRUP_WAITING.md`. Keep this file and README focused on the whole product and architecture.

## Development

- Use the version pinned in `.node-version` / `.nvmrc`: Node 26.13.0. Modules run as native TypeScript. Keep strict checking and erasable syntax; no build step or additional TypeScript runner is required.
- Run `npm run check` and `npm test`. Browser tests intercept every provider request. For gateway/browser changes run `tests/integration/remote-desktop.e2e.ts` in the Docker image; for waiting changes also run `tests/integration/waiting.e2e.ts`.
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
