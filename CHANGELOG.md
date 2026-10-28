# Changelog

All notable changes to `@huloglobal/vendure-plugin-review-requests` are documented
here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.16.1] — 2026-10-28

### Changed
- Every install now gets a 14-day evaluation with all features on and no card (granted by the HULO licence server). The licence banner's buttons read **Subscribe**: during the evaluation the first charge falls on the day it ends, so there is no second free trial.

## [0.16.0] — 2026-10-11

Retention pass: a weekly report, a set-up checklist, a dashboard widget and
review-link click tracking. One shared table (`hulo_plugin_prefs`) and one
column (`review_log.clickedAt`, with an index) are created on boot. Requires
`@huloglobal/vendure-licence-sdk` 0.15.1.

### Added
- **Review-link click tracking.** The review button in every real
  invitation now goes through a signed redirect (`GET
  /review-requests/r/<token>`, HMAC over the log row id using the same
  secret as unsubscribe links) that stamps `review_log.clickedAt` on the
  first click and sends the customer on to the review page. Previews and
  test emails link straight to the review page. The Overview gains a
  **Clicked (30d)** tile with the click-through rate next to **Sent**.
- **Weekly report.** Every Monday at 08:00 (server time) the worker emails
  last week's figures — invitations sent, review links clicked, orders
  skipped, failures, opt-outs — against the previous week, plus up to three
  next steps from the set-up checklist, through the plugin's own SMTP. A
  **Weekly report** card in Settings has the on/off switch, the recipient
  (defaults to the first channel reply-to, then the licence customer, then
  the trial-reminder address), the last/next send time, **Send me a test**
  and **Preview**. Endpoints: `GET/POST digest/settings`,
  `POST digest/send-test`, `GET digest/preview`.
- **Set-up checklist** at the top of the Overview (`GET setup`): SMTP
  reachable, invitation email saved, business name and review page set,
  sending switched on, first invitation sent — each with a hint and a link
  to the right tab. Hide it once you are done; it comes back if an item
  comes undone. The same items feed the weekly report's next steps.
- **Admin navigation and dashboard widget.** "Review Requests" appears in
  the Marketing section of the admin nav (star icon), and a dashboard widget
  (Dashboard → Add widget → Review Requests, `GET widget`) shows the 7-day
  invitations sent, review links clicked and opt-outs with a link to the
  page.
- **Usage stats to the licence server.** `invitesSent`, `reviewLinkClicks`,
  `invitesSkipped`, `invitesFailed` and `optOuts` for the last 30 days are
  reported through both the evaluation client and the daily heartbeat, so
  renewal and win-back emails can say what the plugin did. Numbers only.

### Changed
- **Licence banners.** `GET meta` now includes `notice` (trial ending, key
  expiring, evaluation ended), `premiumFeatures`, `recentStats` and
  `buyUrl`. The licensed banner shows the amber notice strip when one
  applies and reads "Renews automatically — current key valid until …" for
  subscriptions; the trial and free banners list what a licence includes
  and the 30-day figures so far. Every "needs a licence" failure (402 or
  a `licence_required` / `premium-feature` body) is worded the same way in
  the admin, and 402 bodies carry `buyUrl`.
- **Send log.** A real send writes its `review_log` row as `sending` before
  the email goes out (so the email can carry that row's click link), then
  sets `sent` or `failed`. `logSend` returns the row id.
- `evalStats()` reports the last 30 days (was all-time `invitesSent`).
- **Heartbeat jti.** The daily heartbeat reads the key currently in force
  (`licenceKeyProvider`), so an install licensed from the admin page or by
  the purchase claim no longer reports `unlicensed` until restart — the
  licence server keeps its usage stats after purchase.

## [0.15.3] — 2026-09-28

Optimisation pass — no new features, no new tables. `review_template.body`
is widened from TEXT to MEDIUMTEXT on MySQL/MariaDB at boot (Postgres TEXT is
already unbounded).

### Changed
- **Scan cost.** The hourly scan resolves opt-outs, exclusions and
  cooldown for the whole candidate batch in three `IN (…)` queries instead
  of three round trips per order. Skip logging is unchanged (still once
  per order and reason). A failed lookup aborts the channel run rather
  than sending past the exclusion list.
- **Overview / Exclusions tabs.** `GET /stats` no longer runs the full
  dry-run scan on every open: the pending summary is memoised for 60 s,
  shared between concurrent callers, and dropped after a real run, a
  manual send, or a config / exclusion / opt-out change.
- **Rating cache.** A failed Trustpilot / Google lookup is remembered for
  10 minutes (a success still for 6 h), so a transient outage no longer
  blanks the star block until the next restart. The admin "check" button
  probes live and never writes the key/domain typed in the form into the
  shared cache. A rating with a non-numeric score can no longer throw
  mid-send (`Number.isFinite` guard, `formatScore`).
- **Templates.** `review_template.body` is MEDIUMTEXT (16 MB; was 64 KB
  — templates with inlined images were silently truncated). Saving now
  returns `400` with the size in the message when the subject exceeds 255
  characters or the body 4 MB, and a `500` with the database message
  instead of a bare "Save failed"; the admin UI shows that message.
- **Log retention.** Monthly (worker only) `review_log` rows with
  `status <> 'sent'` older than 18 months are deleted in batches of 5 000.
  `sent` rows are kept — dedup and cooldown depend on them.
- **Postgres.** A corpus test (`tests/pg-corpus.test.ts`, skipped unless
  `HULO_PG_URL` is set) extracts every SQL statement in `src/`, translates
  it with the dialect adapter and runs it against PostgreSQL 17 with
  quoted-camelCase stand-ins for the Vendure tables. 43 statements, all
  passing.

## [0.15.2] — 2026-09-28

Reliability and security pass — no new features. A `review_claim` table
and a `(status, createdAt)` index on `review_log` are created on boot.

### Fixed
- **Duplicate invitations.** An order is now claimed in `review_claim`
  before the email goes out, so the hourly cron (worker), "Send due now"
  (server) and the order page can no longer send twice for the same order;
  a failed send releases the claim for the next run.
- **Trigger state.** `PaymentSettled`/`Shipped` triggers matched only
  orders still in exactly that state; an order that had moved on to
  Delivered was skipped. The scan now matches every state at or beyond the
  trigger, and the lookback window is 45 days (was 3) so slow deliveries
  and worker downtime no longer lose invitations silently.
- **Licence in the worker.** A key activated from the admin lives in the
  server process; the worker now re-loads the stored key before each run,
  so invitations keep going out after the evaluation ends.
- **Multi-channel branding.** Storefront channels run before the default
  channel and an order's own channel is used for its template and links
  (the default channel always won before).
- **Postgres.** Every camelCase column on Vendure tables is quoted;
  `SUM(boolean)` replaced with `SUM(CASE …)`; `ADD COLUMN IF NOT EXISTS`
  replaced with an information-schema check (MySQL 8 boots again).
- **Unsubscribe.** The secret is no longer a shared literal: when none is
  configured a per-install random secret is persisted; the token compare is
  constant-time; the GET link shows a confirm button and the POST performs
  the opt-out (mail scanners prefetch GETs), with RFC 8058
  `List-Unsubscribe` headers on every email and a rate limit on the route.
  Sending is refused when no `publicBaseUrl` (hence no unsubscribe link)
  is configured.
- Customer first names are HTML-escaped in the body; one pooled SMTP
  transport with timeouts and `requireTLS` on 587 replaces a fresh
  transport per message; a failure on one order no longer aborts the whole
  run; log values are truncated to their columns.
- Self-update requires SuperAdmin and a valid version string; config
  saves are validated (ranges, lengths, known channels); the evaluation
  lead request times out after 8 s.
- Admin UI: the preview is sanitised once (not on every change-detection
  cycle), "Send due now" is enabled during the evaluation, the copy button
  copies a real `@`, timers are cleared on destroy.

## [0.15.1] — 2026-09-02

### Changed
- **Branding.** The bundled `hulo-global-logo.svg` is now the HG wordmark on the HULO black rounded square (the same mark as the huloglobal.com header), with explicit `-light` and `-dark` variants alongside the auto-switching default.

## [0.15.0] — 2026-09-02

### Added
- **Licence & billing card in the admin.** Always visible: the current state (free tier, free trial with first-charge date, monthly/annual subscription, lifetime, or master licence) with the actions that apply — start the 14-day free trial or subscribe, buy lifetime, **Manage billing** (Stripe customer portal: update card, cancel, switch plan) and **Upgrade to lifetime** (the old subscription stops billing at the end of its paid period). Requires licence SDK ^0.14.0.

## [0.14.1] — 2026-09-02

### Changed
- **The 14-day free trial is now card-backed.** Unlicensed installs run in the free tier; start the trial from the admin banner (monthly or annual → *Start 14-day free trial*) — Stripe collects a card, nothing is charged until day 15, cancel any time before then, one trial per customer — and the licence installs itself within a minute. The automatic no-card evaluation window is retired (licence SDK ^0.13.0).

## [0.14.0] — 2026-09-02

### Added
- **Buy licence from the admin.** The evaluation / free-tier banner now has a plan picker and a **Buy licence** button: checkout opens in a new tab and, once payment completes, the licence **installs itself** — no email round-trip, no `.env` edit, no restart. Renewed subscription keys are picked up automatically too. New admin endpoints `licence/purchase-link` and `licence/claim-status`.

### Changed
- Requires `@huloglobal/vendure-licence-sdk` ^0.12.0.
- The 7-day card trial at checkout has been retired: every install already gets the 14-day no-card evaluation, and paid plans now bill from day one.

## [0.13.3] — 2026-09-02

### Changed
- **Licence SDK ^0.11.0.** Master licences (one key that activates every HULO plugin) and hardware-bound keys are now accepted by the runtime licence check.
- **Branding.** Refreshed HULO Global logo (inline HG monogram) in the admin UI.

## [0.13.2] — 2026-08-25

### Fixed
- **Double-send race hardening.** The hourly cron now carries a
  single-flight guard: schedule explorers were observed firing the handler
  twice in the same tick, and two overlapping scans could have raced past
  the per-order dedup and emailed a customer twice. Duplicate invocations
  now exit immediately.
- **Cleaner audit log.** A skipped order (excluded / cooldown) is logged
  once per reason instead of on every hourly re-scan of its window.

## [0.13.1] — 2026-08-25

### Fixed
- **Eligibility scan never found any orders.** The candidate query assumed
  an `order.channelId` column, but Vendure stores the order↔channel
  relation in the `order_channels_channel` join table — so the hourly scan
  failed on every install (the error was caught and logged, and no
  invitations were ever sent). The scan, the admin order panel and manual
  send now resolve the channel through the join table.

## [0.13.0] — 2026-08-25

### Added
- **PostgreSQL support.** All of the plugin's SQL now runs on Postgres as
  well as MySQL/MariaDB — the licence SDK's new dialect adapter translates
  queries transparently at runtime, so no configuration is needed: the
  plugin follows whatever database your Vendure `dbConnectionOptions` use.
  Verified against PostgreSQL 17. MySQL/MariaDB installs are unaffected
  (byte-identical passthrough).

## [0.12.1] — 2026-08-25

### Changed
- The update banner's "What's new" link now opens the plugin's
  changelog page on huloglobal.com, so you can read exactly what a
  release contains before updating.

## [0.12.0] — 2026-08-23

### Added
- **One-click in-app updates.** The update banner now has an "Update
  now" button: the plugin installs the new version via your project's
  own package manager (yarn/npm/pnpm auto-detected), verifies it landed,
  and gracefully restarts under your process supervisor (pm2/systemd).
  Admin-only; the target version is verified against the npm registry;
  a failed install never restarts anything. Disable with
  HULO_SELF_UPDATE=off; force restart without a detected supervisor
  with HULO_SELF_UPDATE=force. Note: a separate worker process picks
  the update up on its next restart, and the admin UI itself refreshes
  after your next admin build.

## [0.11.1] — 2026-08-23

### Added
- **Update notifications in the admin UI.** When a newer version is on
  npm, a dismissible banner shows current → latest with a copy-ready
  install command and a link to what's new. (Update data comes from the
  existing daily registry check — no new network calls.)

## [0.11.0] — 2026-08-22

### Added
- **Review panel on the admin order page.** Shows whether this order's
  customer was invited to review (with history), and lets staff send
  the invitation manually — including a confirmed force-resend and a
  confirmed override for excluded customers. Opt-outs are always
  honoured server-side. Light/dark theme aware. New
  GET order-status/:orderId + POST send-order/:orderId endpoints.

## [0.10.0] — 2026-08-21

### Added
- **In-admin licence activation.** Paste your key into the plugin's
  admin page and it verifies (signature, plugin id, domain binding,
  expiry, revocation) and activates instantly — no .env edit, no
  redeploy. The key persists in the shared hulo_licence_store table and
  is re-applied on every boot; an explicitly configured env/init key
  always wins. POST licence/activate + licence/deactivate endpoints.

## [0.9.1] — 2026-08-21

### Added
- Evaluation pings now include anonymous usage aggregates (counts only,
  never personal data) so the opt-in reminder emails can say what the
  plugin actually did during the trial.

## [0.9.0] — 2026-08-21

### Added
- **14-day full-featured evaluation.** Unlicensed installs now get the
  complete feature set for 14 days instead of the restricted free tier.
  Scheduled sending now also runs during the evaluation window. The clock is anchored server-side (a hashed
  instance id — no personal data), so reinstalling does not restart it,
  and it fails open: if the licence server is unreachable the plugin
  keeps running fully. After the window the plugin drops to the free
  tier; all configuration is kept and reactivates instantly with a key.
- Admin-UI evaluation banner with live countdown and an optional
  "email me before it ends" reminder opt-in (explicit consent — no
  email is sent anywhere otherwise).

## [0.8.0] — 2026-08-04

### Added
- **Upload image / asset library.** A new toolbar button opens Vendure's
  asset picker — browse the library or upload a new image — and inserts it
  into the email. Images are stored in your Vendure asset library like any
  other asset. The previous insert-by-URL button stays. Editor selection
  is now saved/restored so toolbar and colour actions apply reliably even
  after a dialog opens.

## [0.7.0] — 2026-08-04

### Added
- **Full editor toolbar**: text + highlight colour, font size, underline/
  strikethrough, headings/subheadings/quotes, numbered lists, indent/
  outdent, image insert (by URL, alt text), a custom button, horizontal
  divider, left/centre/right align, clear-formatting and undo/redo.

### Fixed
- Editor text showed grey in dark mode: the admin theme was colouring
  bare block elements. Canvas content now forces its own dark ink on the
  white paper (inline colours in your HTML still win).

## [0.6.1] — 2026-08-04

### Fixed
- Dark mode: the visual editor canvas now reads as an intentional white
  "paper" (framed, with a visible caret + selection) instead of a bare
  white block, and the email preview renders on white to match how the
  email actually looks.

## [0.6.0] — 2026-08-04

### Added
- **Visual email editor.** The invitation email now has a WYSIWYG editor
  with a formatting toolbar (bold, italic, heading, lists, links, a
  one-click review button, alignment), **drag-and-drop variable chips**
  (drop {{firstName}}, {{productList}}, etc. anywhere), and a **Visual /
  HTML toggle** so you can drop into raw HTML whenever you want. Live
  preview + test-send unchanged.

## [0.5.0] — 2026-08-04

### Added
- **Product reviews.** A new "What to ask for" mode — Store review /
  Product reviews / Both. In product (or both) mode the email lists the
  actual products from the customer's order, each with its own "Review
  this" button linking to your storefront's product-review page (a
  configurable link template with {slug}, {name}, {orderCode}). Works
  alongside the Trustpilot/Google store review. New template variables
  {{reviewButton}} and {{productList}}.
## [0.4.0] — 2026-08-04

### Added
- **Google reviews live rating.** Pick Google in the platform selector,
  add a Google Maps API key (Places API) + your Place ID, and Connect —
  the email now shows your live Google star rating + review count, the
  same way Trustpilot does. Both platforms cache for 6h and fail open.

## [0.3.0] — 2026-08-04

### Added
- **Live customer search in Exclusions.** Type a name or email and pick a
  real customer to exclude — each result shows whether they're *already*
  excluded (and why: excluded / domain rule / unsubscribed), so it doubles
  as a quick "is this customer excluded?" check.
- **Review-platform picker.** Choose Trustpilot / Google reviews /
  Reviews.io / Custom and the review link is built for you (Trustpilot
  keeps the live-rating auto-detect; the others use the link only). Any
  site with a review URL already worked via the template — this makes it
  one click.
- Endpoints: `GET /review-requests/customers/search`,
  `GET /review-requests/exclusions/check`.

## [0.2.0] — 2026-08-04

### Changed
- **Simpler setup.** The Settings tab now opens with a one-click
  **Connect Trustpilot**: enter your domain (and an optional free API
  key) and the plugin auto-detects your business-unit id and pulls your
  live star rating — no manual lookups. Just a domain, a business name
  and "days after order" are on the main screen; everything else moved
  behind an Advanced toggle.

### Added
- `POST /review-requests/trustpilot/detect` — resolve review link +
  business-unit id + live rating from a domain (+ key) in one call.

## [0.1.0] — 2026-08-04

First release.

### Added
- **Order-date-timed review invitations.** Hourly worker invites customers whose
  order reached a trigger state (Delivered / PaymentSettled / Shipped) a
  configurable number of days ago.
- **Free Trustpilot integration.** Review button links to the free
  `trustpilot.com/evaluate/<domain>` page (organic reviews, no paid AFS). Optional
  free Trustpilot API key reads the live TrustScore + review count to show as
  social proof in the email. Link template is configurable (Google, etc.).
- **Customer exclusions** by email or domain, plus signed one-click **unsubscribe**
  that auto-excludes.
- **Dedup + cooldown + minimum order value** so nobody is over-asked.
- **Editable email template** per channel, with live preview and **test-send**.
- **Multi-tab admin dashboard** (Overview / Settings / Email / Exclusions /
  Activity) on the HULO design system, with a send log and eligibility preview.
- HULO licence SDK: free tier = configure + preview + test-send; scheduled sending
  is licensed. Admin REST requires an authenticated admin session.
