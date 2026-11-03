# OpenRun development

Read `docs/DEVELOPMENT_HANDOFF.md` for the current scope and pending user decisions, and `docs/REMOTE_MACHINE.md` before moving or starting the production service.

- Use the Node version in `.node-version` / `.nvmrc` (26.13.0). Source files are native TypeScript modules; no build step or third-party TypeScript runner is needed. Preserve erasable syntax and strict type checking.
- This is one continuously running container with one account/browser and SQLite. It is not a Lambda worker or a multi-replica service.
- Current booking automation only prepares a restaurant page and hands the same browser to the owner. `READY` is not a confirmed reservation; `COMPLETED` records the owner's acknowledgement. Never report either as provider-verified booking success.
- CAPTCHA and additional authentication are completed by the human through the remote viewer. Keep account identity checks and single-browser coordination intact.
- Tests use intercepted restaurant/provider requests. Run `npm run check` and `npm test`; use the Docker integration test when changing the browser, gateway, remote viewer, or scheduling flow. Do not submit live reservations, cancel bookings, or send Slack messages as a routine test.
- Live Slack messages need an explicit user request. Booking dates, party size, fees, refund rules, and final submission must follow the user's concrete instructions. The previously authorized connection test has already been sent and received.
- This repository is public. Keep real SOPS documents, `.env`, cookies, profiles, database files, screenshots, credentials, and state archives out of commits. Never print decrypted secret values, raw authenticated responses, or raw Playwright errors.
- Verify changes with temporary test state. Do not restart the production service, delete its volume, or migrate live state during ordinary code verification without a task that calls for it.
