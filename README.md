<p align="center"><a href="https://huloglobal.com/vendure-plugins/review-requests/"><img src="https://huloglobal.com/vendure-plugins/logos/review-requests.svg?v=2" width="96" height="96" alt="HULO Review Requests logo"></a></p>

# @huloglobal/vendure-plugin-review-requests

Automated post-purchase **review invitations** for [Vendure](https://www.vendure.io/),
timed off your order dates. Sends a branded, Trustpilot-style email that links to
your **free** Trustpilot review page — no paid Automatic Feedback Service required —
and can show your live star rating pulled from the free Trustpilot API.

**Plugin page & pricing:** https://huloglobal.com/vendure-plugins/review-requests/

## What it does

- **Timed off order dates.** An hourly worker finds orders that reached a trigger
  state (Delivered / Payment settled / Shipped) *N days ago* and invites the
  customer to review you.
- **Free Trustpilot, done right.** The review button links to
  `https://www.trustpilot.com/evaluate/<your-domain>` (organic Service Reviews,
  free). Optionally add a free Trustpilot developer API key and the email shows
  your live **TrustScore + review count** as social proof. The link template is
  configurable, so you can point at Google reviews or anywhere else instead.
- **Exclusions.** Never invite specific emails or whole domains (wholesale
  accounts, staff). One-click **unsubscribe** in every email auto-excludes.
- **No spam.** Deduped per order, plus a per-customer **cooldown** (default 120
  days) and a minimum order value.
- **Editable email** with live preview + test-send, per channel.
- **Click tracking.** The review button goes through a signed redirect, so
  the Overview shows how many invitations were opened and the click-through
  rate — not just how many were sent.
- **Multi-tab admin**: Overview (set-up checklist, sent / clicked / eligible /
  opt-outs / failed, live rating), Settings (including the weekly report),
  Email, Exclusions, Activity log.
- **Weekly report** by email every Monday, a **set-up checklist** on the
  first screen and a **dashboard widget** — see below.

## Install

```bash
npm i @huloglobal/vendure-plugin-review-requests
```

```ts
import { ReviewRequestPlugin } from '@huloglobal/vendure-plugin-review-requests';

plugins: [
    ReviewRequestPlugin.init({
        publicBaseUrl: 'https://shop.example.com',   // for unsubscribe links
        licenceKey: process.env.HULO_REVIEW_LICENCE,
    }),
],
```

Admin UI:

```ts
ReviewRequestPlugin.uiExtensions,   // in your compileUiExtensions extensions array
```

This registers the **Review Requests** page (Marketing section of the admin
nav, `/admin/extensions/review-requests`), the review panel on the order
detail page and the dashboard widget. Open the page, follow the set-up
checklist at the top (SMTP, email, review page, timing, first send), hit
**Send test**, and switch the channel on.


> **Since 0.15.2:** invitations need `publicBaseUrl` (the unsubscribe link);
> set `optOutSecret` to keep unsubscribe links valid across reinstalls
> (otherwise a per-install secret is generated and stored); the trigger
> matches orders at or beyond the chosen state within a 45-day window.
>
> **Since 0.15.3:** the email body may be up to 4 MB (the column is widened
> to MEDIUMTEXT on first boot) and the subject up to 255 characters — larger
> saves are refused with a `400` that says so. Skipped/failed audit rows
> older than 18 months are pruned monthly on the worker; sent rows are kept.
>
> **Since 0.16.0:** the review button goes through a signed click redirect on
> `publicBaseUrl`, the worker sends a weekly report (Settings → Weekly
> report), and the admin nav gains a Review Requests entry plus a dashboard
> widget. Needs `@huloglobal/vendure-licence-sdk` 0.15.1.

## Getting your Trustpilot bits (all free)

- **Review link** — nothing needed; it's just `evaluate/<your-domain>`.
- **Live rating (optional)** — register a free app at
  <https://developers.trustpilot.com/> for an **API key**, put it in Settings, and
  click *Check rating* (the plugin finds your business-unit id from the domain).

## Configuration (per channel)

| Setting | Default | Notes |
|---|---|---|
| Trigger state | Delivered | Delivered / Payment settled / Shipped |
| Delay (days) | 14 | days after the order date |
| Min order value | 0 | skip low-value orders |
| Cooldown (days) | 120 | don't re-ask the same customer |
| Max per run | 200 | hourly throttle |
| Review link template | Trustpilot evaluate URL | `{domain}` is substituted |

## Weekly report, setup checklist and dashboard widget

**Weekly report.** Every Monday at 08:00 (server-local time) the worker
emails one summary of last week — invitations sent, review links clicked,
orders skipped, failures and opt-outs, each against the previous week — plus
up to three next steps while the set-up checklist is incomplete. It is sent
through the same SMTP as the invitations (`SMTP_*` env or the `smtp` option),
so it needs nothing extra; without SMTP nothing is sent and the Settings card
says why. The recipient defaults to the first channel reply-to, then the
licence customer email, then the address given to "Email me before it ends";
change it or switch the report off under **Settings → Weekly report**, where
**Send me a test** and **Preview** show exactly what goes out. Sent once per
install, on the worker, and never more than once a week even with several
worker replicas.

**Set-up checklist.** The Overview opens with the five things that have to be
true before invitations go out: SMTP configured, invitation email saved,
business name and review page set, a channel switched on, first invitation
sent. Each row links to the right tab; **Hide** puts it away until an item
comes undone, and it disappears on its own once everything is done.

**Dashboard widget.** Dashboard → **Add widget** → **Review Requests**: the
last 7 days' invitations sent, review links clicked and opt-outs, the licence
notice when a trial or key is about to end, and a link to the page.

**Click tracking.** The review button in every real invitation goes through
`GET /review-requests/r/<token>` on your `publicBaseUrl` — a signed, rate-
limited redirect that records the first click on that invitation and sends the
customer straight on to Trustpilot / Google. Previews and test emails link
directly. The Overview shows **Clicked (30d)** and the click-through rate.

The licence server receives the same numbers (`invitesSent`,
`reviewLinkClicks`, `invitesSkipped`, `invitesFailed`, `optOuts`, last 30
days) through the evaluation client and the daily heartbeat — counts only,
never customer data.

## Licensing

Free tier: configure, preview and test-send. **Scheduled sending requires a
licence** from https://huloglobal.com/vendure-plugins/review-requests/.

## Compatibility

Vendure `>=3.5 <4`. MySQL / MariaDB / PostgreSQL (every statement is checked
against PostgreSQL 17 and MariaDB by the corpus test in `tests/`). Tables are created on
boot. Sends via your SMTP (`SMTP_SERVER` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM`,
or pass `smtp` to `init()`).

## License

AGPL-3.0-or-later — commercial licences available from HULO Global.

## Buying a licence

Pick monthly or annual on the plugin's admin banner and click **Start 14-day free trial** (card required, nothing charged until day 15, cancel any time), or choose lifetime — checkout opens in a new tab and the key installs itself within a minute. You can also buy at https://elite.charity/licence/buy/vendure-plugin-review-requests and paste the emailed key into the admin.
