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
- **Any review page.** Trustpilot, Google reviews (Place ID), Reviews.io
  (`reviews.io/company-reviews/store/<id>`) or your own link. Paste your review
  page and the plugin takes the domain, Place ID or store ID from it; an
  identifier the platform cannot use is refused with the reason. **Until the
  review page is set nothing is sent** — no dead review buttons, and nobody is
  held back by the cooldown.
- **Exclusions.** Never invite specific emails or whole domains (wholesale
  accounts, staff). One-click **unsubscribe** in every email; the Exclusions tab
  lists everyone who unsubscribed (never invited again, not even by Resend).
- **Send from the order page** (free): the Review invitation panel on every
  order sends the invitation now. Opt-outs, exclusions, the cooldown and the
  hourly limit apply; **Resend** overrides a previous invitation, an exclusion
  or the cooldown (premium). Every invitation sent for an order adds a
  staff-only note to the order's history.
- **Lists, bulk and "Not invited yet"** (premium): invite customers from a
  pasted or CSV list now or on a schedule, invite a selection of recent orders
  that have had no invitation, or use **Send review invitation** on the Orders
  list. The first 20 go out at once, the rest in the background within the
  hourly limit.
- **No spam.** Deduped per order, plus a per-customer **cooldown** (default 120
  days) and a minimum order value.
- **Editable email** with live preview + test-send, per channel.
- **Click tracking.** The review button goes through a signed redirect, so
  the Overview shows how many invitations were opened and the click-through
  rate — not just how many were sent.
- **Multi-tab admin**: Overview (set-up checklist, sent / clicked / eligible /
  opt-outs / failed, live rating), Settings (including the weekly report),
  Email, Customers (lists, Not invited yet), Exclusions (with the unsubscribed
  list), Activity log.
- **Weekly report** by email every Monday and a **set-up checklist** on the
  first screen (both premium), and a **dashboard widget** — see below.

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
        // Optional: the invitation e-mail's look (since 0.18.0)
        email: {
            accentColor: '#155dfc',                        // bar under the header and the buttons
            logoUrl: 'https://shop.example.com/logo.png',  // https; without it the store name is shown
            logoWidth: 140,                                // pixels
            footerText: 'Example Shop Ltd, registered in England and Wales no. 01234567',
        },
    }),
],
```

### The invitation e-mail

The e-mail is a 600px card: your logo (or the business name in bold), a bar
in your accent colour, the subject and body you edit on the E-mail tab, then a
footer strip with the unsubscribe link and your `footerText`. Every e-mail
also carries a plain-text version. The built-in body ends with `{{signOff}}`:
"Kind regards," and the business name, plus the channel's reply-to address
when one is set. A template you saved earlier renders as it is, inside the
card; to pick up the new built-in text, use **Reset to default** on the E-mail
tab. Variables: `{{firstName}}` `{{orderCode}}` `{{businessName}}`
`{{reviewUrl}}` `{{ratingBlock}}` `{{reviewButton}}` `{{productList}}`
`{{signOff}}` `{{unsubscribeUrl}}`.

Admin UI:

```ts
ReviewRequestPlugin.uiExtensions,   // in your compileUiExtensions extensions array
```

This registers the **Review Requests** page (Marketing section of the admin
nav, `/admin/extensions/review-requests`), the review panel on the order
detail page and the dashboard widget. Open the page, follow the set-up
checklist at the top (SMTP, email, review page, timing, first send), hit
**Send test**, and switch the channel on.


> **Since 0.18.0:** the invitation e-mail and the unsubscribe pages use the
> new card design (optional `email` options above) and invitations carry a
> plain-text part; nothing to migrate.
>
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
> **Since 0.17.0:** nothing is sent until the review page is set; sending
> from the order page is free (the weekly report, set-up checklist and the
> star-rating box are premium); new Customers tab (lists, Not invited yet), an
> Orders-list bulk action and the unsubscribed list. Tables `review_queue` and
> column `review_log.queueId` are created on boot.
>
> **Since 0.16.0:** the review button goes through a signed click redirect on
> `publicBaseUrl`, the worker sends a weekly report (Settings → Weekly
> report), and the admin nav gains a Review Requests entry plus a dashboard
> widget. Needs `@huloglobal/vendure-licence-sdk` 0.15.1.

## Getting your Trustpilot bits

- **Review link** (free) — nothing needed; it's just `evaluate/<your-domain>`.
- **Live rating (optional, premium)** — register a free app at
  <https://developers.trustpilot.com/> for an **API key**, put it in Settings, and
  press *Connect* (the plugin finds your business-unit id from the domain). The
  star-rating box in the e-mail needs a licence or the evaluation; without one
  the rating is not fetched.

## Configuration (per channel)

| Setting | Default | Notes |
|---|---|---|
| Trigger state | Delivered | Delivered / Payment settled / Shipped |
| Delay (days) | 14 | days after the order date |
| Min order value | 0 | skip low-value orders |
| Cooldown (days) | 120 | don't re-ask the same customer |
| Most invitations per hour | 200 | per channel; scheduled and staff sends together |
| Review link template | Trustpilot evaluate URL | `{domain}` is substituted; must be an `http(s)` link |
| Identifier | — | Trustpilot domain, Google Place ID or Reviews.io store ID (validated on save) |

## Lists, bulk sends and "Not invited yet" (premium)

**Customers tab → Invite customers from a list.** Paste one customer per line —
`Name, e-mail`, `e-mail, Name`, `Name <e-mail>`, the e-mail alone, several
addresses on a line, or a To: line copied from an e-mail (Gmail, Outlook's
`Last, First <e-mail>`, Apple Mail) — or choose a CSV file (up to 1 MB, 5,000
lines) whose header row names an e-mail column (`Email`, `E-mail address`,
Google's `E-mail 1 - Value` …) and a name column (the first name wins over the
full name; never the company, account, surname or username). Lines that cannot
be read are counted and the first is quoted back. **Send now** sends the first
20 straight away and the rest in the background, 20 a minute within the hourly
limit; **Schedule** invites each customer the channel's delay in days from now
(the hourly run sends them while the channel's sending is on). A customer from a
list gets the built-in e-mail without the order sentence (a custom template's
`{{orderCode}}` is empty for them).

**Not invited yet** lists recent orders at or beyond each channel's trigger
state that have had no invitation (including orders not due yet), flags
excluded customers and those in their cooldown, leaves out customers who
unsubscribed, and shows the scheduled list rows and the background queue.
Select any and press **Invite selected**. The Orders list gains a **Send review
invitation** bulk action that does the same for the selected orders.

Opt-outs, exclusions, the per-customer cooldown and the hourly limit apply to
every one of these sends. REST (admin, `UpdateSettings`): `POST
/review-requests/lists?channelId=&mode=now|schedule` (text/plain body), `GET
/review-requests/not-invited`, `POST /review-requests/invite-selected`, `POST
/review-requests/bulk-send`, `DELETE /review-requests/queue/:id`; `GET
/review-requests/optouts` (free).

## Weekly report, setup checklist and dashboard widget

**Weekly report** (premium). Every Monday at 08:00 (server-local time) the worker
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

**Set-up checklist** (premium). The Overview opens with the five things that have to be
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

Every install starts with a 14-day evaluation with everything enabled (no card
needed). Afterwards:

| Free | Premium (licence) |
|---|---|
| Configure, e-mail editor, preview, test send | Automatic sending a set number of days after each order (hourly), Send due now |
| Send the invitation for one order from the order page (opt-outs, exclusions, cooldown and hourly limit apply) | Invite from a pasted or CSV list, now or scheduled |
| Exclusions and the unsubscribe list; one-click unsubscribe | "Not invited yet" with Invite selected; the Orders-list bulk action |
| Click tracking, order note, dashboard widget | Resend (overrides a previous invitation, exclusions or the cooldown — never an opt-out) |
| | Trustpilot/Google star-rating box in the e-mail |
| | Weekly e-mail report and set-up checklist |

When a licence lapses nothing is deleted: the premium features stop (the weekly
report is not sent, the checklist is not shown, lists and the background queue
wait) and resume as soon as a licence is active. Licences:
https://huloglobal.com/vendure-plugins/review-requests/.

## Compatibility

Vendure `>=3.5 <4`. MySQL / MariaDB / PostgreSQL (every statement is checked
against PostgreSQL 17 and MariaDB by the corpus test in `tests/`). Tables are created on
boot. Sends via your SMTP (`SMTP_SERVER` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM`,
or pass `smtp` to `init()`).

## License

AGPL-3.0-only — commercial licences available from HULO Global.

## Buying a licence

Pick monthly or annual on the plugin's admin banner and click **Subscribe** (cancel any time), or choose lifetime — checkout opens in a new tab and the key installs itself within a minute. You can also buy at https://elite.charity/licence/buy/vendure-plugin-review-requests and paste the emailed key into the admin.
