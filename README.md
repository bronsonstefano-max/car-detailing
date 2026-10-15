# Divine Detailers website

Static site (plain HTML, CSS and JS) for Divine Detailers, Miami.

- `index.html`, `services.html` and the other `.html` files are generated pages.
- `styles.css` and `script.js` are shared by every page.
- `build.py` generates all pages. Edit the `SITE` block at the top (phone, email, address, hours, social links)
  or the page content, then run `python3 build.py`. `content_faq.py` holds the FAQ text.
- Quote and newsletter forms use Netlify Forms (`data-netlify`), so they work once deployed on Netlify.

Placeholders to replace: address and hours, photos, partner/brand logos, Google reviews, social links, stats.

Photos live in `assets/photos/` (a 720px and a 1600px version of each). To add more, drop the files there and
reference them in `PHOTOS` / the page functions in `build.py`, then run `python3 build.py`.

## Google Map with pin
The map uses the Google "Share > Embed a map" URL for the Divine Detailers listing (`map_embed` in `build.py`).
If it is cleared, a "View on Google Maps" card is shown instead.
To show the live embedded map with a pin: in Google Cloud Console create a project, enable **Maps Embed API**
(free, no usage charge), create an API key, restrict it to your site's domain (HTTP referrers), then paste it into
`gmaps_key` at the top of `build.py` and run `python3 build.py`.

## Forms on any host (Web3Forms)

The quote and newsletter forms work on Netlify out of the box. To use any other host (Cloudflare Pages, GitHub Pages, Vercel):

1. Go to https://web3forms.com, enter the email that should receive leads, and copy the free access key they email you.
2. In `build.py`, set `form_key="YOUR_KEY"` in the `SITE` dict.
3. Run `python3 build.py`, commit and push.

With a key set, submissions are emailed to you and the visitor lands on `thanks.html`. With no key, the forms use Netlify Forms.

## Speed notes

- `python3 build.py` also writes `styles.min.css` and `script.min.js` (minified, with a content hash in the link so they can be cached for a year). Edit `styles.css` / `script.js`, never the `.min` files. For minifying, run `pip install rcssmin rjsmin` once.
- `_headers` sets cache rules for Cloudflare/Netlify. `.assetsignore` keeps source files off the public site.
- Wide photos ship at 720 / 1000 / 1600 px and phones pick the smallest that fits.

## Adding photos later (service pages)

Service pages no longer show empty "Photo" boxes. A slot with no photo is simply left out and the section becomes text-only
(`.noimg`). To switch a slot on, register the photo in `PHOTOS` in `build.py` and point the slot at its key:

- Page banner / "impact" photo / "why trust us" photo: `SERVICE_PHOTOS[slug] = (impact_key, why_key)` and `WHY_PHOTO`.
- Alternating text + photo rows: the last item of each tuple in that page's `rows=[...]` in `EXTRA`.
- Package pictures (the 4 cards): add `slug: (folder, {"Package name": "file-stem"})` to `PIMG_ALL` in `build_service`.

Pages currently without photos: Vinyl Wraps (all slots), plus the package pictures on Paint Correction and Exterior Detailing.

## Lead backend (Cloudflare Worker + D1)

Forms post to `/api/lead`, handled by `src/worker.js`. Leads are stored in a D1 database and can also be emailed and/or forwarded to a webhook/CRM.
Everything else is served as static files. Set `lead_endpoint=""` in `build.py` to go back to Web3Forms/Netlify.

One-time setup (Cloudflare dashboard, Workers & Pages > divine-detailers > Settings):
1. **Database**: created automatically on the first deploy (binding `DB`, name `divine-detailers-leads`). If the build says it cannot create it, create a D1 database with that name in the dashboard, then bind it to the worker as `DB`.
2. **PASSWORD_GIORDANI** and **PASSWORD_BRONSON** (secrets, required): the two people who can sign in at the CRM sign-in page (usernames `giordani` and `bronson`). `ADMIN_PASSWORD` also still works as the `bronson` password. Shows all leads (search, filters, CSV download) and a drag-and-drop **Pipeline** board (New lead, Contacted, Quote sent, Booked, In the shop, Completed, Lost) where you can set each job's value and add notes.
3. **Email each lead** (optional): create a free account at resend.com, add the key as the secret `RESEND_API_KEY`, and set the `NOTIFY_TO` variable (in the dashboard under Settings > Variables and Secrets) (comma separated emails). For a branded sender, verify your domain at Resend and set `NOTIFY_FROM`.
4. **CRM / Zapier / Slack** (optional): add the secret `LEAD_WEBHOOK_URL`. Every lead is POSTed to it as JSON.

Each lead also records the landing page, referrer, Google Ads click id (`gclid`) and UTM tags, so you can see which ads produced it.
Local test: `npx wrangler dev` (put `PASSWORD_BRONSON=...` in a `.dev.vars` file, which is git-ignored).

### Custom domain and CRM address (divinedetailers.com + crm.divinedetailers.com)
1. Add `divinedetailers.com` to your Cloudflare account (Websites > Add a site) and point the registrar's nameservers at Cloudflare.
2. In `wrangler.jsonc` uncomment `routes` and set `"CRM_HOST": "crm.divinedetailers.com"`, then deploy. Cloudflare creates the DNS records and certificates for the three hostnames.
3. The site then lives at `divinedetailers.com` / `www.divinedetailers.com`, and the lead dashboard at `https://crm.divinedetailers.com` (it serves only the dashboard; `/admin` on any other host redirects there).
4. Optional hardening: protect `crm.divinedetailers.com` with Cloudflare Access (Zero Trust, free for up to 50 users) so staff sign in with their email instead of a shared password.
5. Email: verify `divinedetailers.com` at Resend and set `NOTIFY_FROM` to e.g. `Divine Detailers <leads@divinedetailers.com>`.

### Phone calls from CallRail
Calls tracked by CallRail show up in the same Leads list and Pipeline as web form leads (tagged Call, Missed call or Voicemail, with duration, source, campaign and a link to the recording).
1. Choose a long random string and save it as the Cloudflare secret `CALLRAIL_KEY`.
2. In CallRail: Settings > Integrations > Webhooks > add a **Post-Call** webhook with the URL `https://<your site>/api/callrail?key=<CALLRAIL_KEY>` (use the main domain, not the crm. address).
3. Every finished call creates one lead (a second webhook for the same call only refreshes duration and recording, it does not overwrite edits).
4. Callers CallRail does not know show up as a number only. Open the lead (Details) and use **Edit contact and vehicle** to add the name, service and car. **+ Add lead** records walk-ins, texts or calls that were not tracked.

### Follow-up steps
Each pipeline stage has its own list of next steps (for example Quote sent: Invoice sent, Waiting on a decision, Accepted deposit paid, Too expensive, Not interested). After a lead moves, the dashboard offers those steps (optional, can be skipped) and an optional "follow up on" date. Some steps also move the lead (Too expensive moves it to Lost). The lists live in `FOLLOWUPS` in `src/worker.js`. Every move and step is saved in the lead's stage history.


## Instant alerts, Today list and one-tap replies

- **Alerts**: every new form lead and every missed call or voicemail emails everyone in `NOTIFY_TO` (comma separated) through Resend, with a big Call button. For texts, add the secrets `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` and set `ALERT_SMS_TO` to the numbers that should get them (comma separated).
- **Confirmation to the customer**: set `AUTO_REPLY` to `1` (needs a verified sending domain at Resend as `NOTIFY_FROM`).
- **Today** (the CRM home page): calls to return, new leads nobody has contacted, follow-ups due today and overdue. The tab shows how many are waiting.
- **One-tap replies**: open a lead and pick a message, then tap Text or Email. It opens your phone's messages or mail app with the text filled in. Set `GOOGLE_REVIEW_URL` for the review request message. Each use is logged in the lead's history, and texting a brand new lead moves it to Contacted.

## Free push alerts (ntfy)
Set the variable `NTFY_TOPIC` (a long private name, for example `dd-leads-x7k29qpm`) in the Cloudflare dashboard. Everyone who installs the free ntfy app (iPhone or Android) and subscribes to that topic gets a notification within a second of every new lead and missed call or voicemail. Tapping it opens the CRM's Today page. Several topics can be listed, separated by commas.

If ntfy answers 429 (daily quota), create a free account at ntfy.sh, make an access token (Account, Access tokens) and add it as the secret `NTFY_TOKEN`. Messages then count against your own quota. Use a long random topic name, since anyone who knows it can read the alerts.

## Owner pages and reminders
- Signed in as `bronson` there are three extra pages: **Speed** (time to first call), **Contact rate** (reached and booked rate by how fast a lead was called) and **Insights** (funnel, revenue, sources and Google Ads return, services, lost reasons, busiest hours, best time to call). Enter the monthly Google Ads spend at the bottom of Insights.
- A cron trigger runs every minute and sends one reminder (push, email, text and the Zapier webhook, whichever are set up) when a lead has not been called within `REMIND_MINUTES` (default 10; set to 0 to turn reminders off). Reminders only go out during business hours, so overnight leads get a single reminder when the shop opens. If a deploy ever fails because of the cron trigger, delete the `triggers` line in `wrangler.jsonc`.

## Auto-dial new form leads through CallRail
When a form lead arrives, CallRail rings the agent's phone first ("press 1 to connect"), then dials the lead from your tracking number. Turn it on in the Cloudflare dashboard (Settings, Variables and Secrets):
- `CALLRAIL_API_TOKEN` (secret): your CallRail API token. `CALLRAIL_ACCOUNT_ID`: your account id.
- `CALLRAIL_CALLER_ID`: the tracking number (or verified outbound caller ID) the lead will see, like `+17865550123`.
- `AGENT_PHONE_GIORDANI` (and `AGENT_PHONE_BRONSON`): the cell that CallRail rings first, like `+13055550123`.
- `AUTO_DIAL=1` turns it on. `AUTO_DIAL_AGENT` picks who gets rung (default `giordani`). It only runs Mon to Sat, 9 to 6 Eastern.
- `CALL_RECORDING=1` records the calls and plays `CALL_GREETING` first (default: "This call may be recorded for quality and training purposes."). Set `CALL_GREETING=off` to record without an announcement (check the recording-consent law for the states the calls reach).
- In CallRail add the Outbound Post-Call and Call Modified webhooks pointing at `/api/callrail?key=YOUR_KEY`, the same address as the inbound webhook. The CRM then logs the call, its result and the recording on the lead. If nobody presses 1, the team gets an alert to call the lead by hand.
