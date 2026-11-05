# OpenRun

## Product purpose

OpenRun manages personal restaurant reservations and waiting-list registration across providers. The user records a restaurant, visit date, party size, contact information where needed, and a release/registration slot. An always-on remote service persists the request, runs the provider workflow at the chosen time, and records its result or hands the same server browser to the owner.

Read `README.md` for the full system overview. Operational installation/cutover belongs in `docs/REMOTE_MACHINE.md`; time-specific progress and pending user decisions belong in `docs/DEVELOPMENT_HANDOFF.md`.

## System overview

- **Web and owner API**: a private console manages Catchtable restaurant/booking requests and next-day Syrup waiting requests. One-use management grants become HttpOnly/SameSite owner cookies. Viewer cookies have separate, narrower privileges.
- **Persistence**: one SQLite database contains Catchtable and waiting tables. Waiting contacts are AES-GCM encrypted using a key derived from the SOPS-protected admin token; public API objects contain only masked contacts. Preserve the admin token when moving the DB.
- **Catchtable provider**: a persistent headed Chrome verifies the same account and reuses encrypted session state. Its scheduler prepares a restaurant page and hands that context to the owner through Xvfb/x11vnc/noVNC. Final booking, payment and provider cancellation are not implemented.
- **Syrup provider**: the Naniyori workflow is ported from `bots-on-lambda/syrupWaitingForNaniyori`. A separate temporary browser context selects party size, enters a phone, confirms, submits once, and reads the waiting result. Requests target a specific next-day date and AM/PM slot rather than an automatically recurring daily configuration.
- **Schedulers**: separate provider loops share a single service and durable state. Claim work before executing. Persist `SUBMITTING` before a Syrup final click; uncertain submissions and interrupted runs cannot silently replay.
- **Notifications**: SOPS-configured Slack Incoming Webhook, only for opted-in work or an explicit user-requested message. Notification failures must not repeat provider submission.
- **Deployment**: one continuously running Docker Compose service, Node/Chromium, and a persistent volume. No Lambda execution, distributed DB, multi-replica coordination, or automatic production cutover is currently included.

Code map: `src/remote/` owns the gateway/authentication and notifications, `src/app/` the Catchtable catalog/store/scheduler, `src/waiting/` the Syrup catalog/store/runner/scheduler, and `public/` the web console/viewer/waiting page.

Provider details belong in `docs/CATCHTABLE.md` and `docs/SYRUP_WAITING.md`. Keep this file and README focused on the whole product and architecture.

## Development

- Use the version pinned in `.node-version` / `.nvmrc`: Node 26.13.0. Modules run as native TypeScript. Keep strict checking and erasable syntax; no build step or additional TypeScript runner is required.
- Run `npm run check` and `npm test`. Browser tests intercept every provider request. For gateway/browser changes run `tests/integration/remote-desktop.e2e.ts` in the Docker image; for waiting changes also run `tests/integration/waiting.e2e.ts`.
- Keep dates and slots in Asia/Seoul/KST. Derive tomorrow and provider run times on the server, not from the client's local time zone.
- Preserve the one-account Catchtable coordinator and isolate Syrup contexts. Do not use a provider's unverified generic success banner as a confirmed reservation.

## Operational boundaries

- Catchtable `READY` means prepared, and `COMPLETED` means the owner acknowledged checking their booking history. Syrup `SUCCEEDED` needs the provider's result fields. `UNKNOWN` after submission needs manual reconciliation before another attempt.
- CAPTCHA and additional authentication are human-only. Keep account identity checks and do not bypass them.
- Real reservations/waiting, payments, cancellations, and Slack messages require concrete user authorization. An explicitly scheduled and confirmed web request authorizes its selected provider action and optional result notification. Never perform these operations as routine tests.
- The previously authorized Slack connection test was already sent and received; it is not ongoing authorization for new test messages. No real Naniyori waiting registration has been run in this project yet.
- This repository is public: never commit real SOPS documents, `.env`, cookies, profiles, databases, screenshots, credentials, or state archives. Do not print decrypted secrets, full contacts, authenticated responses, raw page HTML or raw Playwright errors.
- Use temporary test state. Do not restart production, remove its volume, alter the old Lambda/EventBridge configuration, or migrate live state as part of ordinary code verification.
