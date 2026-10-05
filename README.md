# Divine Detailers website

Static site (plain HTML, CSS and JS) for Divine Detailers, Miami.

- `index.html`, `services.html` and the other `.html` files are generated pages.
- `styles.css` and `script.js` are shared by every page.
- `build.py` generates all pages. Edit the `SITE` block at the top (phone, email, address, hours, social links)
  or the page content, then run `python3 build.py`. `content_faq.py` holds the FAQ text.
- Quote and newsletter forms use Netlify Forms (`data-netlify`), so they work once deployed on Netlify.

Placeholders to replace: address and hours, photos, partner/brand logos, Google reviews, social links, stats.
