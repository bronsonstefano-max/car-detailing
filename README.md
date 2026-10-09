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
