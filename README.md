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
Google blocks keyless map embeds, so the map shows a "View on Google Maps" card by default.
To show the live embedded map with a pin: in Google Cloud Console create a project, enable **Maps Embed API**
(free, no usage charge), create an API key, restrict it to your site's domain (HTTP referrers), then paste it into
`gmaps_key` at the top of `build.py` and run `python3 build.py`.
