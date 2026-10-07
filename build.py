#!/usr/bin/env python3
"""Generates every page of the Divine Detailers site.

Edit the SITE dict or the page content below, then run:  python3 build.py
The shared header and footer live here, so a change appears on every page.
"""
import re
from content_faq import FAQ_CERAMIC, FAQ_CORRECTION, FAQ_PPF, FAQ_TINT

SITE = dict(
    name="Divine Detailers",
    phone="(786) 757-2658",
    tel="+17867572658",
    email="info@divinedetailers.com",
    addr1="5181 NW 74th Ave",
    addr2="Miami, FL 33166",
    hours=("Mon - Fri - 9:00AM - 5:00PM", "Sat - Sun - Closed"),   # placeholder hours
    instagram="#", tiktok="#", facebook="#", youtube="#",
    map_query="5181 NW 74th Ave, Miami, FL 33166",
    map_embed="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3591.482286979325!2d-80.31968002393148!3d25.820648606165566!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x88d9bb4acc62bfe7%3A0x2f8c9a23ac76d3e2!2sDivine%20Detailers!5e0!3m2!1sen!2sus!4v1791389842431!5m2!1sen!2sus",   # Google "Share > Embed a map" URL for the business listing
    gmaps_key="",   # paste a Google Maps Embed API key here to show the live map with pin (see README)
)

SERVICES = [
    ("window-tinting", "Window Tinting", "Enhance privacy, reduce glare, and keep your interior cooler with professional ceramic tint."),
    ("paint-protection-film", "Paint Protection Film", "Self-healing clear film that guards your paint from rock chips, scratches and everyday road damage."),
    ("ceramic-coating", "Ceramic Coating", "A hard, glossy protective layer that repels water and dirt and makes every wash easier."),
    ("paint-correction", "Paint Correction", "Machine polishing removes swirls, scratches and water spots to restore deep, true gloss."),
    ("vinyl-wraps", "Vinyl Wraps", "Transform your vehicle with premium wraps and custom graphics in bold colors and finishes."),
    ("exterior-detailing", "Exterior Detailing", "Hand wash, decontamination and finishing that keep your paint looking its best."),
]
SERVICE_OPTIONS = ["Window Tint", "PPF / Clear Bra", "Ceramic Coating", "Paint Correction", "Vinyl Wraps", "Exterior Detailing", "Other"]

GENERAL_FAQ = [
    ("What services does Divine Detailers offer?", "We offer window tinting, paint protection film, ceramic coating, paint correction, vinyl wraps and exterior detailing. If you do not see what you need, ask us."),
    ("How long does a typical job take?", "It depends on the service. Tint is often a same-day job, while ceramic coating, paint correction and PPF can take one to several days. We will give you a time estimate with your quote."),
    ("Do you offer warranties on your services?", "Yes. Coatings, films and tint carry a manufacturer warranty, and we stand behind our own workmanship. We will confirm the exact terms in your quote."),
    ("Do you offer financing options?", "Ask us about payment options when you request your quote and we will walk you through what is available."),
    ("What are your business hours?", "You can find our current hours in the Locations section on the home page. Call or text us if you need something outside those hours."),
    ("Can I schedule an appointment online?", "Send us a quote request with your vehicle details and preferred timing, and we will reply to confirm your appointment."),
    ("Can I cancel or reschedule my appointment?", "Yes. Please give us as much notice as you can so we can offer the time to another customer, and we will find you a new slot."),
    ("Do you accept walk-ins?", "We work mostly by appointment so every vehicle gets our full attention. Call ahead and we will do our best to fit you in."),
    ("How can I get a quote for services?", "Fill out the quote form on this page, call us, or send a text with your vehicle year, make and model and the service you want."),
]

REVIEWS = [
 ("Olive", "Absolutely blown away by Divine Detailers! Found on instagram. They took my car in for a ceramic coating and window tints, and I can confidently say they exceeded every single expectation. My car looks insane, like it just rolled off a luxury showroom floor. The ceramic coating gave it the most flawless, glassy finish, and the tints are perfect, not only sleek but also super functional in the heat. Did everything in a timely manner and extremely thorough. Gio was professional, knowledgeable, and took real pride in their work. They walked me through the entire process, and made everything seamless and easy."),
 ("Bryant Chef", "Divine Detailers where do I start. The moment I contact Gio he was all in. From showing me demos of what need to be done explaining all the material that will be used to make this project worthwhile. Gio is the man to see. With my busy schedule he made sure to work something out to benefit my work schedule. With the end results I was blown away. I thought I brought my car all over again from the dealer off the showroom floor. Gio great work can't thank you enough."),
 ("Emilio Berkowitz Jr.", "I recently had my car detailed and I couldn't be more impressed! From start to finish, the experience was top-notch. The team was professional, punctual, and meticulous in their work. My car came back looking better than the day I bought it. The paint had an incredible shine, the interior was spotless, and even the smallest crevices were free of dust and grime. They took the time to explain the process, use high-quality products, and ensure every inch of my vehicle was flawless."),
 ("Alexander Gonzalez", "Absolutely amazing service! My car has never looked better, inside and out. The staff was professional, friendly, and paid close attention to every detail. They removed spots I thought were permanent, and the shine on my car is showroom-level. Quick, efficient, and worth every penny. Highly recommend to anyone looking for top-tier car care!"),
 ("Raider Farinas", "The best mobile detailing out there left my car looking like a 2026. El gio es un mostro."),
]

ICON = {
    "instagram": '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r=".6"/></svg>',
    "tiktok": '<svg viewBox="0 0 24 24"><path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5"/><path d="M14 3c.4 2.6 2 4.2 5 4.4"/></svg>',
    "facebook": '<svg viewBox="0 0 24 24"><path d="M14.5 21v-8h2.6l.4-3h-3V8.2c0-.9.3-1.5 1.6-1.5h1.5V4.1C17.3 4 16.4 4 15.5 4 13.3 4 11.5 5.3 11.5 7.8V10H9v3h2.5v8"/></svg>',
    "youtube": '<svg viewBox="0 0 24 24"><rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10 9.2v5.6l5-2.8z"/></svg>',
}

PHOTOS = {
    "spray": ("ppf-install", "Technician spraying slip solution on a dark blue car while installing film", "35% 45%"),
    "ppf": ("ppf-fender", "Technician smoothing clear paint protection film onto the fender of a gray car", "40% 50%"),
    "heat": ("tint-heatgun", "Technician using a heat gun and squeegee on film over a black car window", "50% 28%"),
    "ceramic": ("ceramic-apply", "Gloved hand dripping ceramic coating onto a blue applicator sponge", "50% 58%"),
    "tint": ("tint-squeegee", "Technician using a squeegee and heat gun to install window tint on an olive green truck", "62% 40%"),
    "wash": ("wash-porsche", "Technician foam washing a red Porsche sports car in the shop", "55% 55%"),
    "gwagon": ("gwagon-wipe", "Technician wiping the hood of a green Mercedes G-Class with a microfiber towel", "50% 45%"),
    "wheel": ("wheel-wipe", "Technician wiping the wheel of a green Porsche with a blue microfiber towel", "35% 50%"),
    "foam": ("foam-wash", "Technician foam washing a green Mercedes G-Class outside the shop", "40% 45%"),
    "rolls": ("rolls-tint", "Technician using a heat gun and squeegee to install window tint on the rear glass of a black luxury car", "55% 40%"),
    "polish": ("polishing", "Technician polishing the hood of a green Mercedes G-Class with a dual-action polisher", "40% 42%"),
}
CARD_PHOTO = {"window-tinting": "spray", "paint-protection-film": "ppf", "ceramic-coating": "ceramic", "paint-correction": "polish", "exterior-detailing": "foam"}
HERO_PHOTO = {"window-tinting": ("spray", "40% 45%"), "paint-protection-film": ("ppf", "40% 38%"), "ceramic-coating": ("ceramic", "50% 55%"), "paint-correction": ("polish", "40% 40%"), "exterior-detailing": ("foam", "40% 40%")}
SERVICE_PHOTOS = {"window-tinting": ("rolls", "tint"), "paint-protection-film": ("ppf", "heat"), "ceramic-coating": ("ceramic", "polish"), "paint-correction": ("polish", None), "vinyl-wraps": (None, None), "exterior-detailing": ("wash", "wheel")}
BAND_POS = {"wheel": "40% 52%", "wash": "55% 60%", "spray": "50% 50%", "tint": "62% 25%", "heat": "50% 58%", "ppf": "50% 52%", "ceramic": "50% 55%", "polish": "40% 45%"}

def photo(key, size=720, pos=None, cls="", alt=True, eager=False):
    f, a, p = PHOTOS[key]
    return (f'<img class="{cls}" src="assets/photos/{f}-{size}.webp" alt="{a if alt else ""}" '
            f'style="object-position:{pos or p}" loading="{"eager" if eager else "lazy"}" decoding="async">')

def photo_box(key, label="Photo", pos=None, size=720):
    if key:
        return f'<div class="ph-box has-img">{photo(key, size, pos)}</div>'
    return f'<div class="ph-box">{label}</div>'

def service_card(s, t, d):
    k = CARD_PHOTO.get(s)
    if k:
        return f'<a class="scard has-img" href="{s}.html">{photo(k, 720, None, "scard-img", alt=False)}<h3>{t}</h3><p>{d}</p><span class="btn gray sm">View Service</span></a>'
    return f'<a class="scard" href="{s}.html"><span class="ph">Photo</span><h3>{t}</h3><p>{d}</p><span class="btn gray sm">View Service</span></a>'

# ---------------------------------------------------------------- helpers
def esc(s):
    return s.replace("&", "&amp;")

def nav_active(slug):
    return slug

def header(active):
    dd = "".join(f'<a href="{s}.html">{t}</a>' for s, t, _ in SERVICES)
    cur = lambda s: ' aria-current="page"' if active == s else ""
    return f'''<header class="site-header">
  <div class="hdr">
    <a class="logo-img" href="index.html" aria-label="{SITE['name']} home"><img src="assets/logo.webp" alt="{SITE['name']} logo: It's time to shine" width="168" height="96"></a>
    <button class="menu-btn" aria-label="Open menu" aria-expanded="false" aria-controls="nav">&#9776;</button>
    <nav class="nav" id="nav">
      <div class="has-dd"><button class="dd-btn" aria-expanded="false">Services <i>+</i></button><div class="dd"><a href="services.html">All services</a>{dd}</div></div>
      <a href="brands.html"{cur("brands")}>Brands</a>
      <a href="projects.html"{cur("projects")}>Projects</a>
      <a href="about-us.html"{cur("about")}>About us</a>
      <a href="blog.html"{cur("blog")}>Blogs</a>
      <div class="nav-cta"><a class="callnow" href="tel:{SITE['tel']}">CALL NOW<b>{SITE['phone']}</b></a><a class="btn sm" href="contact.html#quote">Request Quote</a></div>
    </nav>
  </div>
</header>'''

STATUS = '<div class="status"><span class="dot"></span>Free quotes. Tell us about your vehicle and we will get back to you.</div>'

def quote_form(fid=None, select_default=None, extra="", status=True):
    opts = "".join(f'<option{" selected" if o == select_default else ""}>{o}</option>' for o in SERVICE_OPTIONS)
    idattr = f' id="{fid}"' if fid else ""
    return f'''<form class="qform"{idattr} name="quote" method="POST" action="thanks.html" data-netlify="true" data-form>
  <input type="hidden" name="form-name" value="quote">
  {STATUS if status else ""}
  <label>Full name*<input name="name" placeholder="Jane Smith" required autocomplete="name"></label>
  <label>Email*<input name="email" type="email" placeholder="jane@example.com" required autocomplete="email"></label>
  <label>Phone<input name="phone" type="tel" placeholder="(305) 555-0100" autocomplete="tel"></label>
  <label>Select Service*<select name="service" required><option value="">Select…</option>{opts}</select></label>
  {extra}
  <button class="submit" type="submit">Request Quote</button>
</form>'''

def stripes():
    return '<div class="stripes" aria-hidden="true"></div>'

BRANDS = [("avery-dennison", "Avery Dennison", "Wrap"), ("3m", "3M", "Wrap"), ("pure-ppf", "Pure PPF", ""), ("xpel", "XPEL", ""),
          ("braman-miami", "Braman Miami", ""), ("doral-collision-center", "Doral Collision Center", ""), ("limited-spec", "Limited Spec", "")]

def brand_tile(slug, name, sub):
    import os
    for ext in ("svg", "png", "webp"):
        if os.path.exists(f"assets/brands/{slug}.{ext}"):
            return f'<div class="brand has-logo" title="{name}"><img src="assets/brands/{slug}.{ext}" alt="{name}" loading="lazy"></div>'
    s = f"<small>{sub}</small>" if sub else ""
    return f'<div class="brand"><b>{name}</b>{s}</div>'

def partners():
    tiles = "".join(brand_tile(*x) for x in BRANDS)
    return f'''<section class="partners center"><span class="chip">In partnership with the best in the business</span>
  <div class="logos">{tiles}</div></section>'''

def cta_banner():
    return f'''<section class="banner center" style="--banner-img:url('assets/photos/tint-heatgun-1600.webp')">
  <div class="wrap"><span class="chip">Contact us</span>
  <h2>We don&rsquo;t just detail cars, <span class="dim">we perfect them.</span></h2>
  <p>Reach out and let&rsquo;s talk about what your car needs next.</p>
  <a class="btn" href="contact.html#quote"><span class="dot"></span>Contact us</a></div></section>'''

def footer():
    svc = "".join(f'<li><a href="{s}.html">{t}</a></li>' for s, t, _ in SERVICES)
    soc = "".join(f'<li><a href="{SITE[k]}">{k.capitalize()}</a></li>' for k in ("tiktok", "instagram", "youtube"))
    return f'''<footer class="foot-wrap">
  <div class="foot">
    <div><a class="foot-logo" href="index.html" aria-label="{SITE['name']} home"><img src="assets/logo.webp" alt="{SITE['name']} logo" width="240" height="138" loading="lazy"></a><h4>Quick links</h4><ul><li><a href="index.html">Home</a></li><li><a href="about-us.html">About us</a></li><li><a href="projects.html">Projects</a></li><li><a href="blog.html">Blogs</a></li><li><a href="contact.html">Contact us</a></li></ul></div>
    <div><h4>Services</h4><ul>{svc}</ul></div>
    <div><h4>Follow us</h4><ul>{soc}<li><a href="tel:{SITE['tel']}">{SITE['phone']}</a></li><li><a href="mailto:{SITE['email']}">{SITE['email']}</a></li></ul></div>
    <div class="news"><p>Join for expert car care tips and exclusive offers on our top services.</p>
      <form name="newsletter" method="POST" action="thanks.html" data-netlify="true" data-form><input type="hidden" name="form-name" value="newsletter"><input name="email" type="email" placeholder="Your email" required aria-label="Your email"><button class="btn" type="submit">Join Now</button></form>
      <small>By subscribing, you agree to our <a href="privacy-policy.html">Privacy Policy</a> and consent to receive updates from {SITE['name']}.</small></div>
  </div>
  <div class="copy">&copy; <span id="yr">2026</span> {SITE['name']}. All rights reserved.</div>
</footer>'''

def page(fname, title, desc, body, active=None):
    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(desc)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Special+Gothic+Expanded+One&display=swap" rel="stylesheet">
<link rel="icon" type="image/png" href="assets/favicon.png">
<link rel="apple-touch-icon" href="assets/apple-touch-icon.png">
<link rel="stylesheet" href="styles.css">
</head>
<body>
{header(active)}
<main class="page">
{body}
{footer()}
</main>
<script src="script.js"></script>
</body>
</html>
'''
    open(fname, "w").write(html)

def faq_block(items, cat=None, cid=None):
    out = ""
    if cat:
        out += f'<h3 class="faq-cat" id="{cid}">{esc(cat)}</h3>'
    out += "".join(f"<details><summary>{esc(q)}</summary><p>{esc(a)}</p></details>" for q, a in items)
    return out

def inner_hero(title_html, sub, crumbs, form=False, select=None, buttons=True, hero=None, status=True):
    c = " / ".join(crumbs)
    btns = f'''<div class="btn-row"><a class="btn" href="tel:{SITE['tel']}"><span class="dot"></span>CALL NOW: {SITE['phone']}</a><a class="btn gray" href="contact.html#quote"><span class="dot"></span>Get Your Free Quote</a></div>''' if buttons else ""
    q = f'<div class="qwrap">{quote_form(select_default=select, status=status)}</div>' if form else ""
    return f'''<section class="page-hero{' tall' if form else ''}">
  <div class="hero-media" aria-hidden="true"></div>
  <div class="wrap hero-in"><h1>{title_html}</h1><p class="lead" style="margin:16px auto 26px">{sub}</p>{btns}</div>
  {q}
</section>'''

# ---------------------------------------------------------------- home

def map_block(cls="map-embed"):
    from urllib.parse import quote_plus
    q = quote_plus(SITE["name"] + " " + SITE["map_query"])
    place = f"https://www.google.com/maps/search/?api=1&query={q}"
    direc = f"https://www.google.com/maps/dir/?api=1&destination={q}"
    if SITE["map_embed"]:
        frame = (f'<iframe class="{cls}" title="Map showing {SITE["name"]}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen '
                 f'src="{SITE["map_embed"]}"></iframe>')
    elif SITE["gmaps_key"]:
        frame = (f'<iframe class="{cls}" title="Map showing {SITE["name"]}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen '
                 f'src="https://www.google.com/maps/embed/v1/place?key={SITE["gmaps_key"]}&amp;q={q}"></iframe>')
    else:
        frame = (f'<a class="{cls} map-card" href="{place}" target="_blank" rel="noopener" aria-label="Open {SITE["name"]} in Google Maps">'
                 f'<span class="pin" aria-hidden="true"></span><b>{SITE["name"]}</b><span>{SITE["addr1"]}<br>{SITE["addr2"]}</span><em>View on Google Maps</em></a>')
    return frame, place, direc

def build_home():
    cards = "".join(service_card(s, t, d) for s, t, d in SERVICES)
    home_map = map_block()
    slides = "".join(f'<div class="slide">{photo(k, 720)}</div>' for k in ["ppf", "gwagon", "ceramic", "wash", "rolls", "polish", "foam", "tint", "wheel", "spray", "heat"])
    GICON = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>'
    revs = "".join(f'''<article class="review"><div class="rhead"><span class="gbadge">{GICON}</span><div class="rsrc"><b>GOOGLE REVIEW</b><span>{SITE['name']}</span></div><span class="rstars" aria-label="5 out of 5 stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span></div><h4>Recent Client</h4><p>{t}</p></article>''' for n, t in REVIEWS)
    socials = "".join(f'<a href="{SITE[k]}" aria-label="{k.capitalize()}">{ICON[k]}</a>' for k in ("instagram", "tiktok", "facebook", "youtube"))
    body = f'''<section class="hero">
  <div class="hero-top">
  <div class="hero-media has-photo lighter" aria-hidden="true">{photo("gwagon", 1600, "50% 60%", alt=False, eager=True)}</div>
  <div class="wrap hero-in">
    <p class="small">Welcome to {SITE['name']}</p>
    <h1>Window tint, PPF, ceramic coatings &amp; <em>paint correction</em></h1>
    <p class="sub">Premium vehicle protection and detailing</p>
    <p class="lead">Protect and perfect your vehicle with Miami&rsquo;s premium detailing and protection shop.</p>
    <div class="hero-btns"><a class="btn" href="tel:{SITE['tel']}"><span class="dot"></span>CALL NOW: {SITE['phone']}</a><a class="btn gray" href="#hero-quote">Request Quote</a></div>
  </div>
  </div>
  <div class="qwrap">{quote_form(fid="hero-quote")}</div>
</section>
{stripes()}
{partners()}
<section class="sec" id="services" style="border-top:1px solid var(--line)">
  <div class="wrap center"><span class="chip">Our Services</span>
  <h2>Professional automotive <em>services</em></h2>
  <p class="lead" style="margin-top:14px">At {SITE['name']}, we turn your vehicle into a head-turning masterpiece.</p>
  <div class="cards" style="text-align:initial">{cards}</div></div>
</section>
<section class="cta-strip" style="border-top:1px solid var(--line)"><div class="btn-row"><a class="btn" href="tel:{SITE['tel']}"><span class="dot"></span>CALL NOW: {SITE['phone']}</a><a class="btn gray" href="contact.html#quote"><span class="dot"></span>Get Your Free Quote</a></div></section>
{stripes()}
<section class="sec" style="padding-bottom:0">
  <div class="wrap center"><span class="chip">Our Achievements</span></div>
  <div class="stats"><div class="stat"><b>000+</b><span>Vehicles completed</span></div><div class="stat"><b>0.0★</b><span>Google rating</span></div><div class="stat"><b>00</b><span>Years of experience</span></div></div>
  <div class="wrap center" style="padding:70px 0 70px"><span class="chip">Social Media Following</span>
  <div class="social-ico">{socials}</div>
  <p class="followers"><b>15K+</b> Followers across platforms</p>
  <h2>Follow every <em>build</em></h2><div style="margin-top:26px"><a class="btn gray" href="{SITE['instagram']}">Visit Instagram</a></div></div>
  <div class="slider" aria-roledescription="carousel" aria-label="Recent work photos">
    <div class="slide-track" id="buildTrack">{slides}</div>
    <button class="slider-btn prev" data-slide="-1" aria-label="Previous photos">&#8249;</button>
    <button class="slider-btn next" data-slide="1" aria-label="Next photos">&#8250;</button>
  </div>
</section>
<section id="locations" style="border-top:1px solid var(--line)">
  <h2 class="loc-title">Our <em>Location</em></h2>
  <div class="loc-grid">
    <div class="loc hot"><h3>{SITE['name']}</h3><div class="cols"><div><b>Store Hours</b><span>{SITE['hours'][0]}<br>{SITE['hours'][1]}</span></div><div><b>Office</b><span>{SITE['addr1']}<br>{SITE['addr2']}</span></div></div></div>
    <div class="loc call"><small>CALL NOW</small><a href="tel:{SITE['tel']}">{SITE['phone']}</a></div>
  </div>
  <div class="loc-map">{home_map[0]}
  <a class="map-dir btn" href="{home_map[2]}" target="_blank" rel="noopener">Get Directions</a></div>
</section>
<section class="sec" id="reviews">
  <div class="wrap rev-head"><span class="chip">Recent Reviews</span><h2>What our <em>clients</em> say</h2>
  <div class="rev-wrap" style="text-align:initial"><div class="rev-track">{revs}</div>
  </div></div>
</section>
{stripes()}
<section class="sec">
  <div class="wrap"><div class="unlock"><div class="bar"><h2>Unlock the ultimate driving experience</h2>
  <p>{SITE['name']} brings vehicle protection and detailing to Miami drivers who care about how their car looks and how long it lasts. We tailor each service to your vehicle and your style, with certified installers who focus on the small details. Every project happens in a facility built for precise work, quality products and a polished experience from start to finish.</p>
  <a class="btn" href="about-us.html">About us</a></div>{photo_box("tint", pos="62% 35%")}</div></div>
</section>
<section class="feat"><div class="txt"><span class="kick">Protect</span><h2>Protect and preserve your car&rsquo;s flawless finish</h2><p>Keep your vehicle looking new with protection built for Miami&rsquo;s sun, salt air and storms. Paint protection film takes the hit from rock chips and road debris, while ceramic coating adds gloss, shrugs off contaminants and makes every wash faster.</p></div>{photo_box("ppf", pos="40% 50%")}</section>
<section class="feat rev"><div class="txt"><span class="kick">Customize</span><h2>Make your ride uniquely yours</h2><p>Whether you want a refined upgrade or a bold new look, we turn your ideas into high-quality results. Vinyl wraps change color, texture and finish, while premium window tint cuts heat and glare and gives the car a cleaner, finished look.</p></div>{photo_box("heat", pos="50% 35%")}</section>
<section class="feat"><div class="txt"><span class="kick">Enjoy</span><h2>Take your car&rsquo;s style to new heights</h2><p>Our shop is built on craft and customer satisfaction. Every vehicle gets a careful inspection before it goes home, and our work is backed by a workmanship guarantee so you can drive away with confidence.</p></div>{photo_box("polish", pos="40% 45%")}</section>
<section class="sec" id="portfolio">
  <div class="wrap center"><span class="chip">Our Portfolio</span><h2>Recent vehicles <em>completed.</em></h2>
  <div class="grid3">{photo_box("ppf")}{photo_box("ceramic")}{photo_box("polish")}</div>
  <div style="margin-top:44px"><a class="btn" href="projects.html">View More Projects</a></div></div>
</section>
{cta_banner()}'''
    page("index.html", f"Window Tinting, PPF & Ceramic Coating in Miami | {SITE['name']}",
         f"{SITE['name']} brings window tint, paint protection film, ceramic coating, paint correction and vinyl wraps to Miami drivers. Get a free quote.", body)

# ---------------------------------------------------------------- services hub
def build_services_hub():
    cards = "".join(service_card(s, t, d) for s, t, d in SERVICES)
    body = inner_hero("Our <em>Services</em>", "Elevate your ride with expert protection and customization.", ['<a href="index.html">Home</a>', "Services"], form=True, status=False)
    body += f'''{stripes()}{partners()}
<section class="sec"><div class="wrap center"><span class="chip">Our Services</span><h2>Elevate your ride with expert <em>custom services</em></h2>
<p class="lead" style="margin-top:14px">From window tint to ceramic coating, our services enhance your ride&rsquo;s style, protection and performance. Trust our skilled team to deliver quality and luxury your car deserves.</p>
<div class="cards" style="text-align:initial">{cards}</div></div></section>{cta_banner()}'''
    page("services.html", f"Our Services | {SITE['name']}", "Window tint, paint protection film, ceramic coating, paint correction, vinyl wraps and exterior detailing in Miami.", body, "services")

# ---------------------------------------------------------------- service pages
SERVICE_PAGES = {
 "window-tinting": dict(
    sub="Enhance privacy, reduce glare, and keep your interior cooler with tint installation.",
    pk_title="Tint package options", pk_sub="Browse our different package options.",
    packages=[("Two windows", ["Front driver side", "Front passenger side"]), ("Full tint", ["Front driver + passenger", "Rear driver + passenger"]), ("Windshield", ["Full windshield", "Extra protection"]), ("Sunvisor strip", ["Sun strip", "Reduces sun glare"])],
    impact_kick="The impact", impact_h="Cooler drives. Cleaner look.",
    impact_p="Miami&rsquo;s sunshine can heat up a cabin quickly. Premium ceramic window film stops heat before it builds up inside, so even after sitting in direct sun, the vehicle feels more comfortable for you and your passengers.",
    nums=[("00%", "Placeholder: heat rejection of your chosen film"), ("99%", "UV rays blocked by quality ceramic film")],
    tiles=[("Comfort", "Comfort", "Reduces interior heat and makes driving more enjoyable year-round."), ("Privacy", "Privacy", "Limits visibility into your vehicle while keeping clear visibility out."), ("Protection", "Protection", "Blocks harmful UV rays that damage interiors and skin."), ("Appearance", "Appearance", "Gives your vehicle a clean, finished and more refined look.")],
    why_h="Why trust Divine Detailers", why_p="Our certified installers cut film with precision and finish every job with a close final inspection before delivery. We use premium ceramic films with a manufacturer warranty, and we back our workmanship.",
    faq=[("Window tint", FAQ_TINT, "tint")], sim=True, select="Window Tint"),
 "paint-protection-film": dict(
    sub="Paint protection film guards your vehicle from rock chips, scratches and everyday road damage while keeping the original paint looking untouched.",
    pk_title="PPF coverage options", pk_sub="Choose the coverage that fits how you drive.",
    packages=[("Highway package", ["Hood or hood edge", "Front bumper", "Fender edges", "Headlights + mirrors"]), ("Full front", ["Full hood + fenders", "Front bumper", "Headlights", "Mirrors"]), ("Full body", ["Every painted panel", "Edges wrapped", "Door jambs optional", "Maximum protection"]), ("Individual panels", ["High-wear areas", "Door edges + cargo", "Targeted coverage", "Add more later"])],
    impact_kick="The impact", impact_h="Protection that takes the hit.",
    impact_p="Rock chips and road debris go through clear coat, not around it. Paint protection film is a thick, clear urethane that absorbs the impact so your paint does not. Self-healing top coats make light marks fade away.",
    nums=[("5-10", "Years a quality film typically lasts"), ("100%", "Clear, gloss or satin finish options")],
    tiles=[("Chip protection", "Rock chips", "Takes the impact from stones and debris so your paint stays intact."), ("Self-healing", "Light scratches", "A self-healing top coat lets light marks fade in the warmth."), ("Finish options", "Gloss or satin", "Keep the factory look or give gloss paint a satin finish."), ("Resale", "Preserve value", "Protected paint keeps your vehicle looking newer for longer.")],
    why_h="Why trust Divine Detailers", why_p="Film is only as good as the install. Our technicians prepare every panel, wrap edges where it counts and inspect the work under proper lighting. Your film carries a manufacturer warranty and our own workmanship cover.",
    faq=[("PPF / Clear Bra", FAQ_PPF, "ppf")], select="PPF / Clear Bra"),
 "ceramic-coating": dict(
    sub="Ceramic coating is not just about gloss. It is a long-term protective layer that keeps your vehicle looking newer, cleaner and easier to maintain.",
    pk_title="Coating options", pk_sub="Prep, correction and coating matched to your paint.",
    packages=[("Prep + coat", ["Decontamination wash", "Clay + iron removal", "Panel wipe", "Ceramic coating"]), ("Correct + coat", ["Single-stage polish", "Light defect removal", "Ceramic coating", "Gloss boost"]), ("Full correction", ["Multi-stage correction", "Deep defect removal", "Ceramic coating", "Maximum clarity"]), ("Add-ons", ["Glass coating", "Wheel coating", "Trim coating", "Over PPF"])],
    impact_kick="The impact", impact_h="Deeper gloss. Easier washes.",
    impact_p="A ceramic coating bonds to your clear coat and forms a slick, hydrophobic layer. Water, dirt and bird droppings have a hard time sticking, and washing takes a fraction of the time.",
    nums=[("2-5", "Years of protection from a quality coating"), ("1-2", "Days for a typical full install")],
    tiles=[("Gloss", "Deep shine", "Adds depth and clarity that wax cannot match."), ("Hydrophobic", "Sheds water", "Water beads and rolls off, carrying dirt with it."), ("Protection", "UV and chemicals", "Resists fading, oxidation and acid rain."), ("Easy care", "Faster washes", "Contaminants release easily so the paint stays cleaner.")],
    why_h="Why trust Divine Detailers", why_p="Prep is where most of the quality comes from. We decontaminate, correct the paint to the level it needs and wipe every panel before the coating goes on. Coatings carry a manufacturer warranty and we back our application.",
    faq=[("Ceramic coating", FAQ_CERAMIC, "ceramic")], select="Ceramic Coating"),
 "paint-correction": dict(
    sub="Machine polishing removes swirls, scratches and water spots to restore deep, true gloss to your paint.",
    pk_title="Correction levels", pk_sub="We inspect your paint first and recommend only what it needs.",
    packages=[("Enhancement", ["Light single-stage polish", "Boosts gloss", "Minimal paint removal", "Great for newer cars"]), ("One-step", ["Cut and polish in one pass", "Removes light swirls", "Improves clarity", "Daily-driver favorite"]), ("Multi-stage", ["Heavy cut + finish polish", "Deeper defect removal", "Maximum clarity", "For neglected paint"]), ("Spot repair", ["Wet sanding where needed", "Deep scratch work", "Targeted panels", "Inspected under lights"])],
    impact_kick="The impact", impact_h="Real defects removed, not filled.",
    impact_p="Polishes that only fill swirls wash out in weeks. Paint correction levels the clear coat so imperfections are gone, and the gloss you see is the paint itself.",
    nums=[("1-2", "Days for a thorough multi-stage correction"), ("100%", "Inspected under proper lighting")],
    tiles=[("Swirls", "Swirl marks", "Fine circular marks from washing disappear."), ("Scratches", "Light scratches", "Scratches in the clear coat are reduced or removed."), ("Etching", "Water spots", "Mineral etching is polished out where it is shallow."), ("Clarity", "Deep gloss", "A flawless surface gives the best base for ceramic coating or PPF.")],
    why_h="Why trust Divine Detailers", why_p="We measure the paint, inspect it under proper lighting and only recommend the level of correction your car needs. No upselling, and we will tell you honestly what polishing can and cannot fix.",
    faq=[("Paint correction", FAQ_CORRECTION, "correction")], select="Paint Correction"),
 "vinyl-wraps": dict(
    sub="Transform your vehicle with custom vinyl wraps in bold colors, textures and finishes.",
    pk_title="Wrap options", pk_sub="From accents to a complete color change.",
    packages=[("Accents", ["Roof, mirrors, trim", "Chrome delete", "Stripes + decals", "Quick turnaround"]), ("Partial wrap", ["Hood, roof or panels", "Two-tone looks", "Custom graphics", "Budget-friendly"]), ("Full color change", ["Every painted panel", "Gloss, satin, matte", "Premium cast vinyl", "Reversible"]), ("Custom graphics", ["Business branding", "Window graphics", "Printed designs", "Fleet-ready"])],
    impact_kick="The impact", impact_h="A new look, no repaint.",
    impact_p="Vinyl lets you change your car&rsquo;s color or finish without touching the factory paint. When you want a different look or you sell the car, the wrap can come off and the paint underneath stays protected.",
    nums=[("100+", "Colors and finishes to choose from (placeholder)"), ("100%", "Reversible when removed correctly")],
    tiles=[("Style", "Bold finishes", "Gloss, satin, matte, metallic and color-shift options."), ("Protection", "Covers the paint", "A wrap shields paint from light scratches and UV."), ("Custom", "Graphics", "Printed graphics and branding for personal or business cars."), ("Resale", "Reversible", "Remove it later and the factory paint is preserved.")],
    why_h="Why trust Divine Detailers", why_p="A great wrap comes from clean prep, careful tucking and patient finishing. Our installers take their time on edges, seams and curves so the wrap looks like paint.",
    faq=[], select="Vinyl Wraps"),
 "exterior-detailing": dict(
    sub="Hand wash, decontamination and finishing that keep your paint looking its best.",
    pk_title="Detail packages", pk_sub="Choose the level of care your car needs.",
    packages=[("Maintenance wash", ["Foam + hand wash", "Wheels and tires", "Drying + glass", "Quick refresh"]), ("Full exterior", ["Decontamination wash", "Clay + iron removal", "Sealant or wax", "Trim + tire dressing"]), ("Detail + coat prep", ["Full decontamination", "Panel prep", "Ready for ceramic or PPF", "Inspected"]), ("Ongoing care", ["Scheduled maintenance", "Coating upkeep", "Priority booking", "Ask us"])],
    impact_kick="The impact", impact_h="Clean paint, properly cared for.",
    impact_p="Most paint damage comes from the wash. Our process uses safe, controlled methods that lift dirt instead of grinding it in, so your finish stays glossy and swirl-free.",
    nums=[("2-step", "Safe contact wash process"), ("100%", "Hand finished")],
    tiles=[("Safe wash", "No swirls", "Lubricated hand washing keeps scratches out of the paint."), ("Decon", "Deep clean", "Iron and clay treatments remove what washing leaves behind."), ("Protect", "Sealant", "A protective layer keeps the shine and eases the next wash."), ("Finish", "Attention to detail", "Wheels, trim, glass and door jambs get the same care.")],
    why_h="Why trust Divine Detailers", why_p="We treat every wash like the first step of a correction or coating, because it is. Gentle methods and quality products keep your paint ready for whatever protection comes next.",
    faq=[], select="Exterior Detailing"),
}


EXTRA = {
 "window-tinting": dict(
    hl_h="Stay cool, private and protected.",
    hl=[("Heat rejection", "Cuts the heat that builds up in the cabin", "Easier on you and your AC"), ("UV protection", "Blocks nearly all harmful UV rays", "Protects skin and interiors"), ("Privacy", "Dark enough to limit views in", "Clear visibility looking out"), ("Clean look", "Computer-cut film, precise edges", "A finished, factory-style fit")],
    rows=[("Comfort", "Cooler drives in Miami's sun", "Premium ceramic window film stops solar heat before it warms the cabin. Seats, steering wheel and dash stay more comfortable after the car sits in the sun.", "Because the film has no metal in it, GPS, phone and radio signals keep working normally.", "tint"),
          ("Protection", "Protect your interior and your skin", "UV rays fade and crack leather, plastics and upholstery over time. Quality film blocks nearly all of them, so your interior keeps its color and feel.", "The same film helps hold glass together and reduces glare for safer, less tiring driving.", "heat"),
          ("Style", "A cleaner, more finished look", "Tint changes how a vehicle looks from the first glance. We help you pick a shade that fits your style and stays within legal limits for each window.", "Every piece is cut to fit and installed in a clean bay, then inspected before you drive away.", "rolls")]),
 "paint-protection-film": dict(
    hl_h="Defend your paint from day one.",
    hl=[("Chip protection", "Absorbs rock chips and road debris", "Keeps paint intact where it counts"), ("Self-healing", "Light marks fade with warmth", "Stays smooth and glossy"), ("Invisible look", "Clear, gloss or satin finishes", "Your color shows through"), ("Long-lasting", "Built for years of daily driving", "Backed by a manufacturer warranty")],
    rows=[("Protect", "Take the hit so your paint doesn't", "Paint protection film is a thick, clear urethane that sits over your paint. Chips, scratches and stains land on the film instead of the finish.", "The most-hit areas are the front bumper, hood, fenders and mirrors, and that is where most owners start.", "ppf"),
          ("Preserve", "Keep the factory finish like new", "Protected paint holds its gloss and color, and the car keeps stronger resale appeal. When the film's time is up, a pro can remove it and the paint underneath is untouched.", "Add a ceramic coating on top and the film is easier to wash and resists water spots.", "spray"),
          ("Customize", "Gloss, satin or even color", "Choose a clear gloss film to keep the factory look, a satin film for a matte-style finish, or a colored film to change the look while protecting the paint.", "We will recommend the right coverage and film for your car and how you drive.", "heat")]),
 "ceramic-coating": dict(
    hl_h="Why get ceramic coating.",
    hl=[("Prep", "Full wash, decon and clay treatment", "A clean base for proper bonding"), ("Correction", "Polish out swirls and light defects", "So the gloss you see is clean paint"), ("Application", "Applied panel by panel", "Even, consistent coverage"), ("Inspection", "Checked under proper lighting", "Nothing leaves until it is right")],
    rows=[("Gloss", "Deeper shine that lasts", "A ceramic coating bonds to your clear coat and adds depth, clarity and reflections that wax can't match, and it keeps that look far longer.", "Prep and correction come first, because the coating locks in whatever is under it.", "ceramic"),
          ("Protect", "Shrugs off dirt, water and sun", "The slick, hydrophobic surface helps resist dirt, road grime, bird droppings, water spots and UV fading. Less sticks, and what does comes off easily.", "It does not replace washing, but it makes every wash faster and keeps the car cleaner in between.", "polish"),
          ("Maintain", "Easier care, year after year", "With gentle washing and an occasional maintenance spray, a good coating keeps performing for years of daily driving and Miami weather.", "We will walk you through care tips so you get the most from it.", "wheel")]),
 "paint-correction": dict(
    hl_h="Real defects removed, not filled.",
    hl=[("Inspect", "Measure paint and check under lights", "We find what is really there"), ("Cut", "Remove swirls, scratches and etching", "Only as much as the paint needs"), ("Refine", "Polish to a deep, clear finish", "Maximum gloss and clarity"), ("Protect", "Finish with sealant, coating or film", "Keep the result looking new")],
    rows=[("Correct", "Restore the gloss you paid for", "Everyday washing, dust and water spots leave fine marks that dull the paint. Machine polishing levels the clear coat so those marks are gone, not hidden.", "We only correct as much as your paint needs, and we tell you honestly what polishing can and can't fix.", "polish"),
          ("Prepare", "The best base for coating or film", "A flawless surface is the first step before ceramic coating or paint protection film, since both lock in whatever is under them.", "Many customers combine correction with a coating for a finish that lasts.", "ceramic"),
          ("Enjoy", "Paint that looks new again", "After correction, color looks richer and reflections look sharper. It is the biggest visual change you can make without repainting.", "", "gwagon")]),
 "vinyl-wraps": dict(
    hl_h="Customize your vehicle color today.",
    hl=[("Preparation", "Deep clean and panel decontamination", "A perfect base for adhesion"), ("Precision install", "Seamless wrapping across curves and edges", "A paint-like finish"), ("After install", "Heat-set edges and final inspection", "A clean, tight finish built to last"), ("Care guidance", "Washing and maintenance tips", "Keep the color vibrant")],
    rows=[("Protect", "Shields your factory paint", "A wrap takes the beating from road debris, light scratches and weather, so the paint underneath stays in better shape.", "That added layer also helps resale when the wrap is removed.", None),
          ("Customize", "Colors and finishes without limits", "Gloss, satin, matte, metallic or color-shift: vinyl gives you looks that would be costly or impossible with paint, and it can be changed later.", "You can go for a bold full color change or just add accents.", None),
          ("Maintain", "Simple to care for", "Wrapped vehicles are easy to wash, and with proper care the color depth and finish stay fresh for years.", "We'll explain what to use and what to avoid.", None)]),
 "exterior-detailing": dict(
    hl_h="Clean paint, properly cared for.",
    hl=[("Safe wash", "Lubricated hand washing", "Keeps swirls out of the paint"), ("Decontamination", "Iron and clay treatment", "Removes what washing leaves behind"), ("Protection", "Sealant or wax", "Keeps the shine and eases the next wash"), ("Finishing", "Wheels, trim, glass, door jambs", "Every detail handled")],
    rows=[("Wash", "A wash that protects your paint", "Most paint damage starts with a bad wash. We use controlled, gentle methods that lift dirt away instead of grinding it in.", "The result is a clean surface that is ready for protection.", "foam"),
          ("Decon", "Deep clean beyond the wash", "Iron remover and clay treatment lift the embedded contamination that makes paint feel rough and look dull.", "It is also the right first step before correction, coating or film.", "wash"),
          ("Maintain", "Keep it looking its best", "Regular maintenance details keep coatings performing and paint glossy, so small problems never turn into big ones.", "Ask us about a maintenance schedule that fits your car.", "wheel")]),
}

SIM = [(5, "Limo tint", "Maximum privacy. Very dark, best for rear windows where legal."),
       (15, "Dark tint", "Strong privacy with a bold look. Check legal limits for your windows."),
       (30, "Medium tint", "Balanced privacy with clear night visibility. A daily-driver favorite."),
       (50, "Light tint", "Subtle look with strong heat and UV protection. Easy night driving."),
       (70, "Clear heat-rejection", "Nearly invisible film that still cuts heat and blocks UV.")]

def build_service(slug, title, short):
    d = SERVICE_PAGES[slug]
    pk = "".join(f'<div class="pkg"><div class="pimg">Photo</div><h3>{t}</h3><ul>{"".join(f"<li>{i}</li>" for i in items)}</ul></div>' for t, items in d["packages"])
    nums = "".join(f'<div><b>{n}</b><span>{l}</span></div>' for n, l in d["nums"])
    tiles = "".join(f'<div class="tile"><span class="kick">{k}</span><h3>{h}</h3><p>{p}</p></div>' for k, h, p in d["tiles"])
    sim = ""
    if d.get("sim"):
        btns = "".join(f'<button data-vlt="{v}" data-name="{n}" data-desc="{ds}"{" class=on" if v == 30 else ""}><i style="--a:{1 - v / 100:.2f}"></i>{v}%</button>' for v, n, ds in SIM)
        sim = f'''<div class="sim" id="simulator"><p class="sim-label"><span class="dot"></span>DIVINE DETAILERS</p><h3>Window Tint <em>Simulator</em></h3>
<p class="sim-sub">Select a side window shade below</p>
<div class="sim-tabs"><button class="on" data-sim-tab="side">Side Windows</button><button data-sim-tab="wind">Windshield</button></div>
<div class="sim-view" id="simView" aria-hidden="true"><div class="sim-shade" id="simShade"></div><div class="sim-badge"><b id="simBadge">30%</b><span id="simBadgeLabel">SIDE VLT</span></div></div>
<div class="sim-info"><b id="simTitle">30% VLT — Medium Tint</b><p id="simDesc">Balanced privacy with clear night visibility. A daily-driver favorite.</p></div>
<div class="sim-vlt" role="group" aria-label="Shade level">{btns}</div>
<p class="note"><b>Florida law:</b> Tint darkness limits differ by window and vehicle. We will confirm the legal options for your vehicle before we install anything.</p></div>'''
    faq = ""
    if d["faq"]:
        faq = '<section class="sec" id="faq"><div class="wrap"><div class="center"><span class="chip">FAQ</span><h2>Everything you wanted to <em>know</em></h2></div><div class="faq">' + "".join(faq_block(items) for _, items, _ in d["faq"]) + "</div></div></section>"
    ik, wk = SERVICE_PHOTOS[slug]
    bk = wk or ik
    band = (f'<div class="band has-photo" aria-hidden="true">{photo(bk, 1600, BAND_POS[bk], alt=False)}</div>' if bk else '<div class="band" aria-hidden="true"><span>Photo / video</span></div>')
    body = inner_hero(esc(title), d["sub"], ['<a href="index.html">Home</a>', '<a href="services.html">Services</a>', esc(title)], form=True, select=d["select"], hero=HERO_PHOTO.get(slug), status=False)
    x = EXTRA[slug]
    hl = "".join(f'<div class="hl"><h3>{t}</h3><p>{a}</p><p>{c}</p></div>' for t, a, c in x["hl"])
    rows = ""
    for i, (kick, h2, p1, p2, key) in enumerate(x["rows"]):
        rev = " rev" if i % 2 else ""
        p2h = f"<p>{p2}</p>" if p2 else ""
        rows += f'<section class="feat{rev}"><div class="txt"><span class="kick">{kick}</span><h2>{h2}</h2><p>{p1}</p>{p2h}</div>{photo_box(key)}</section>'
    portfolio = f'<section class="sec"><div class="wrap center"><span class="chip">Our Portfolio</span><h2>Real vehicles. Real work. <em>Real results.</em></h2><div class="grid3">{photo_box("ppf")}{photo_box("wash")}{photo_box("polish")}</div><div style="margin-top:44px"><a class="btn" href="projects.html">View More Projects</a></div></div></section>'
    body += f'''{stripes()}{partners()}
<section class="sec hl-sec"><div class="wrap"><h2 class="center">{x["hl_h"]}</h2><div class="hls">{hl}</div></div></section>
<section class="sec pk-sec"><div class="pk-head"><h2>{d["pk_title"]}</h2><p>{d["pk_sub"]}</p></div>
<div class="pkgs">{pk}</div>{sim}</section>{stripes()}{band}{stripes()}
<section class="sec"><div class="wrap"><div class="split"><div><span class="chip">{d["impact_kick"]}</span><h2>{d["impact_h"]}</h2><p>{d["impact_p"]}</p><div class="bignum">{nums}</div></div>{photo_box(ik)}</div></div></section>
<section class="sec" style="padding-top:0"><div class="wrap center"><span class="chip">Benefits</span><h2>Comfort, protection and <em>style</em></h2><div class="tiles" style="text-align:initial">{tiles}</div></div></section>
<section class="sec"><div class="wrap"><div class="split">{photo_box(wk)}<div><span class="chip">Why trust us</span><h2>{d["why_h"]}</h2><p>{d["why_p"]}</p><p><a class="btn" href="contact.html#quote">Get a Quote</a></p></div></div></div></section>
{rows}{portfolio}{faq}{cta_banner()}'''
    page(f"{slug}.html", f"{title} in Miami | {SITE['name']}", short, body, "services")

# ---------------------------------------------------------------- other pages
def build_brands():
    body = inner_hero("Our <em>Brands</em>", "We install premium products from manufacturers we trust.", ['<a href="index.html">Home</a>', "Brands"], form=False)
    body += f'''{stripes()}<section class="sec"><div class="wrap center"><span class="chip">Partners</span><h2>Premium products, <em>proven results</em></h2>
<p class="lead" style="margin-top:14px">The film, wrap and trade partners we work with.</p>
<div class="logos big">{"".join(brand_tile(*x) for x in BRANDS)}</div></div></section>{cta_banner()}'''
    page("brands.html", f"Brands | {SITE['name']}", "The premium film, coating and wrap brands we install.", body, "brands")

def build_projects():
    cats = ["All", "PPF", "Tint", "Ceramic", "Correction", "Wraps", "Detailing"]
    f = "".join(f'<button class="{"on" if c == "All" else ""}" data-filter="{c}">{c}</button>' for c in cats)
    items = [("PPF", "ppf"), ("Tint", "heat"), ("Ceramic", "ceramic"), ("Tint", "tint"), ("Correction", "polish"), ("Tint", "spray"),
             ("Tint", "rolls"), ("Detailing", "foam"), ("Detailing", "wheel"), ("Detailing", "wash"), ("Wraps", None), ("PPF", None)]
    grid = "".join(
        (f'<div class="ph-box has-img" data-cat="{c}">{photo(k)}</div>' if k else f'<div class="ph-box" data-cat="{c}">Add photo · {c}</div>')
        for c, k in items)
    body = inner_hero("Our recent <em>projects</em>", "Explore real vehicles completed in our shop featuring paint protection film, vinyl wraps, ceramic coating, tint and detailing.", ['<a href="index.html">Home</a>', "Projects"], form=True)
    body += f'''{stripes()}<section class="sec"><div class="wrap center"><span class="chip">Explore more of our projects</span><h2>Vehicles we&rsquo;ve <em>completed</em></h2>
<div class="filters" role="group" aria-label="Filter projects">{f}</div><div class="grid3" id="projectGrid">{grid}</div></div></section>{cta_banner()}'''
    page("projects.html", f"Our Projects | {SITE['name']}", "Recent vehicles completed by Divine Detailers in Miami.", body, "projects")

def build_about():
    body = inner_hero("About <em>us</em>", f"{SITE['name']} is a Miami vehicle protection and detailing shop built on craft and customer care.", ['<a href="index.html">Home</a>', "About us"], form=False)
    body += f'''{stripes()}
<section class="sec"><div class="wrap"><div class="split"><div><span class="chip">Our story</span><h2>Built on <em>craft</em></h2><p>Placeholder copy. Tell the story of {SITE['name']}: who started it, why, and what makes your shop different. Mention your experience, certifications and the kind of vehicles you love working on.</p><p><a class="btn" href="contact.html#quote">Get a Quote</a></p></div>{photo_box("heat", pos="50% 30%")}</div></div></section>
<section class="stats"><div class="stat"><b>000+</b><span>Vehicles completed</span></div><div class="stat"><b>00</b><span>Years of experience</span></div><div class="stat"><b>0.0★</b><span>Google rating</span></div></section>
<section class="feat"><div class="txt"><span class="kick">Our mission</span><h2>Correction, protection, reflection</h2><p>Placeholder copy. Describe your mission and values, and what customers can expect every time they bring a car in.</p></div>{photo_box("polish", pos="40% 45%")}</section>
<section class="sec"><div class="wrap center"><span class="chip">Meet the team</span><h2>The people behind <em>the work</em></h2><div class="grid3">{"".join('<div class="ph-box">Team member</div>' for _ in range(3))}</div></div></section>{cta_banner()}'''
    page("about-us.html", f"About Us | {SITE['name']}", f"Learn about {SITE['name']}, a Miami vehicle protection and detailing shop.", body, "about")

POSTS = [("gloss-vs-matte-ppf", "Gloss PPF vs. Matte PPF: Which Finish Fits Your Style", "Gloss and matte paint protection films are two distinct styling options. Before scheduling PPF installation, consider which finish fits your style and vehicle."),
         (None, "Ceramic Coating vs. Wax: What Is the Difference?", "A plain-language look at durability, gloss and cost, and which one fits your car."),
         (None, "How Window Tint Keeps Your Cabin Cool", "How ceramic tint cuts heat and UV, and how to choose the right shade.")]

def build_blog():
    cards = "".join(f'<article class="post">{photo_box(k)}<div class="b"><time>Month 00, 0000</time><h3>{esc(t)}</h3><p>{d}</p><a class="more" href="{(s + ".html") if s else "#"}">Read more</a></div></article>' for (s, t, d), k in zip(POSTS, ["ppf", "ceramic", "tint"]))
    body = inner_hero("Our <em>blog</em>", "Car care tips and answers from the team at Divine Detailers.", ['<a href="index.html">Home</a>', "Blogs"], buttons=False)
    body += f'<section class="sec"><div class="wrap"><div class="grid3" style="margin-top:0">{cards}</div></div></section>{cta_banner()}'
    page("blog.html", f"Blog | {SITE['name']}", "Car care tips on ceramic coating, paint protection film and window tint.", body, "blog")

def build_post():
    body = inner_hero("Gloss PPF vs. Matte PPF: <em>which finish fits your style</em>", "Gloss and matte paint protection films are two distinct styling options.", ['<a href="index.html">Home</a>', '<a href="blog.html">Blogs</a>', "Gloss vs. matte PPF"], buttons=False)
    body += f'''<section class="sec"><div class="wrap"><article class="article">
<p>Paint protection film (PPF) protects your paint from rock chips, scratches and road damage. The finish you choose decides how the car looks once it is protected. Here is how to think about gloss and matte (satin) film.</p>
<h2>Gloss PPF</h2>
<ul><li>Keeps the factory look and enhances depth and shine on gloss paint.</li><li>Nearly invisible once installed.</li><li>The right choice for most daily drivers.</li></ul>
<h2>Matte or satin PPF</h2>
<ul><li>Gives a smooth, non-reflective finish.</li><li>Protects factory matte or satin paint without changing its look.</li><li>Can turn a gloss car into a satin one while it is protected.</li></ul>
<h2>How to choose</h2>
<p>Start with your paint. If your car has matte or satin paint, matte film is the right match. If you want to keep a glossy look, choose gloss. If you want a new look, satin film changes the finish without repainting. Whichever you choose, a good install matters as much as the film.</p>
<h2>Care</h2>
<p>Wash gently with a pH-neutral soap and a microfiber mitt, and avoid automatic washes with brushes. Matte films should not be waxed or polished, so use products made for matte finishes.</p>
<p><a class="btn" href="contact.html#quote">Get a PPF quote</a></p></article></div></section>{cta_banner()}'''
    page("gloss-vs-matte-ppf.html", f"Gloss PPF vs. Matte PPF | {SITE['name']}", "Which paint protection film finish fits your style and vehicle.", body, "blog")

def build_contact():
    cmap = map_block()
    cats = [("Ceramic coating", FAQ_CERAMIC, "faq-ceramic"), ("Paint correction", FAQ_CORRECTION, "faq-correction"), ("PPF / Clear bra", FAQ_PPF, "faq-ppf"), ("Window tint", FAQ_TINT, "faq-tint")]
    jump = '<nav class="faq-jump"><a href="#faq-general">General</a>' + "".join(f'<a href="#{i}">{esc(n)}</a>' for n, _, i in cats) + "</nav>"
    faq = faq_block(GENERAL_FAQ, "General", "faq-general") + "".join(faq_block(it, n, i) for n, it, i in cats)
    ex = '<label class="full">Message<textarea name="message" rows="4" placeholder="Tell us about your vehicle and what you need"></textarea></label>'
    body = inner_hero("Request quote <em>today</em>", "Get your free quote now.", ['<a href="index.html">Home</a>', "Contact"], buttons=False)
    body += f'''{stripes()}
<section id="quote"><div class="contact-split"><div><span class="chip">Get quote</span><h2>Get your free <em>quote now!</em></h2><p class="lead" style="margin:14px 0 26px;max-width:none">Tell us about your vehicle and what you want done. We will reply with a quote and next steps.</p>{quote_form(extra=ex)}</div>
<div><span class="chip">Visit us</span><h2>Find the <em>shop</em></h2><ul class="info" style="margin-top:26px"><li><b>Address</b>{SITE['addr1']}<br>{SITE['addr2']}</li><li><b>Hours</b>{SITE['hours'][0]}<br>{SITE['hours'][1]}</li><li><b>Call</b><a href="tel:{SITE['tel']}">{SITE['phone']}</a></li><li><b>Email</b><a href="mailto:{SITE['email']}">{SITE['email']}</a></li></ul>
{cmap[0]}
<p style="margin-top:14px"><a class="btn gray sm" href="{cmap[2]}" target="_blank" rel="noopener">Get Directions</a></p></div></div></section>
<section class="sec" id="faq"><div class="wrap"><div class="center"><span class="chip">FAQ</span><h2>Everything you wanted to know <em>before looking up.</em></h2>{jump}</div><div class="faq">{faq}</div></div></section>{cta_banner()}'''
    page("contact.html", f"Request a Quote | {SITE['name']}", "Request a free quote for window tint, PPF, ceramic coating and more in Miami.", body, "contact")

def build_privacy():
    body = inner_hero("Privacy <em>policy</em>", "How we handle your information.", ['<a href="index.html">Home</a>', "Privacy Policy"], buttons=False)
    body += f'''<section class="sec"><div class="wrap"><article class="article legal">
<p><strong>Placeholder text.</strong> Have this reviewed by a professional before publishing.</p>
<h2>Information we collect</h2><p>When you request a quote or join our email list, we collect the details you give us, such as your name, email address, phone number and vehicle information.</p>
<h2>How we use it</h2><ul><li>To reply to your quote request and schedule your service.</li><li>To send updates and offers if you subscribe. You can unsubscribe at any time.</li></ul>
<h2>Sharing</h2><p>We do not sell your personal information. We share it only with service providers that help us run our business, and when the law requires it.</p>
<h2>Contact us</h2><p>Questions about this policy? Email <a href="mailto:{SITE['email']}">{SITE['email']}</a>.</p></article></div></section>'''
    page("privacy-policy.html", f"Privacy Policy | {SITE['name']}", "Divine Detailers privacy policy.", body)

def build_thanks():
    body = f'''<section class="sec"><div class="wrap center"><span class="chip">Thank you</span><h1>Message <em>received</em></h1><p class="lead" style="margin:16px auto 26px">Thanks for reaching out. We will get back to you shortly. For anything urgent, call {SITE['phone']}.</p><a class="btn" href="index.html">Back to home</a></div></section>'''
    page("thanks.html", f"Thank You | {SITE['name']}", "Thanks for contacting Divine Detailers.", body)

if __name__ == "__main__":
    build_home(); build_services_hub()
    for s, t, d in SERVICES:
        build_service(s, t, d)
    build_brands(); build_projects(); build_about(); build_blog(); build_post(); build_contact(); build_privacy(); build_thanks()
    print("built", len(SERVICES) + 11, "pages")
