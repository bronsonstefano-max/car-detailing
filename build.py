#!/usr/bin/env python3
"""Generates every page of the Divine Detailers site.

Edit the SITE dict or the page content below, then run:  python3 build.py
The shared header and footer live here, so a change appears on every page.
"""
import re
from content_faq import FAQ_CERAMIC, FAQ_CORRECTION, FAQ_PPF, FAQ_TINT

SITE = dict(
    name="Divine Detailers",
    phone="(786) 757-2826",
    tel="+17867572826",
    email="info@divinedetailers.com",
    addr1="5181 NW 74th Ave",
    addr2="Miami, FL 33166",
    hours=("Mon - Sat - 9:00AM - 6:00PM", "Sun - Closed"),
    instagram="https://www.instagram.com/divinedetailer", tiktok="#", facebook="#", youtube="#",
    map_query="5181 NW 74th Ave, Miami, FL 33166",
    map_embed="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3591.482286979325!2d-80.31968002393148!3d25.820648606165566!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x88d9bb4acc62bfe7%3A0x2f8c9a23ac76d3e2!2sDivine%20Detailers!5e0!3m2!1sen!2sus!4v1791389842431!5m2!1sen!2sus",   # Google "Share > Embed a map" URL for the business listing
    lead_endpoint="/api/lead",   # our own Cloudflare Worker (src/worker.js) stores leads in D1 and emails/webhooks them. Empty = fall back to Web3Forms/Netlify
    form_key="",   # free Web3Forms access key (web3forms.com) so form submissions are emailed to you on any host. Empty = Netlify Forms
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
 ("Lourdes Guiardinu", "Excellent work by this team of incredibly talented professionals. Reliable, punctual, very communicative and very good detailed work. My BMW 760i was taken care of with first-class treatment. Highly recommend this team."),
 ("Imran Valdes", "The only detailer I plan to ever use again. They provided excellent service to 3 of our cars and were very punctual. They took their time and took every extra step to make sure our vehicles were perfect. Worth every single penny, I highly recommend their service."),
 ("Brian Martinez", "Best detailers in south Florida, very clean and precise on the details. Makes your car look brand new."),
 ("Kendra Jimenez", "Highly recommend Divine Detailers. Great service, on time and attention to detail. Thank you!!"),
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
    "ppf911": ("ppf-porsche-front", "Technician installing clear paint protection film on the front bumper of a black Porsche 911", "45% 55%"),
    "ppf": ("ppf-fender", "Technician smoothing clear paint protection film onto the fender of a gray car", "40% 50%"),
    "heat": ("tint-heatgun", "Technician using a heat gun and squeegee on film over a black car window", "50% 28%"),
    "ceramic": ("ceramic-apply", "Gloved hand dripping ceramic coating onto a blue applicator sponge", "50% 58%"),
    "tint": ("tint-squeegee", "Technician using a squeegee and heat gun to install window tint on an olive green truck", "62% 40%"),
    "wash": ("wash-porsche", "Technician foam washing a red Porsche sports car in the shop", "55% 55%"),
    "gwagon": ("gwagon-wipe", "Technician wiping the hood of a green Mercedes G-Class with a microfiber towel", "50% 45%"),
    "wheel": ("wheel-wipe", "Technician wiping the wheel of a green Porsche with a blue microfiber towel", "35% 50%"),
    "foam": ("foam-wash", "Technician foam washing a green Mercedes G-Class outside the shop", "40% 45%"),
    "rolls": ("rolls-tint", "Technician using a heat gun and squeegee to install window tint on the rear glass of a black luxury car", "55% 40%"),
    "gblack": ("g63-matte-black", "Matte black Mercedes-AMG G63 with carbon fiber trim parked in the Divine Detailers shop", "50% 62%"),
    "urus": ("urus-matte", "Matte silver Lamborghini Urus with carbon fiber body kit and black wheels", "50% 47%"),
    "p1": ("ppf-porsche-wide", "Technician installing paint protection film on the front bumper of a black Porsche 911 with the front hood open", "50% 60%"),
    "p2": ("ppf-porsche-corner", "Hands smoothing clear paint protection film around the corner marker light of a black Porsche", "50% 50%"),
    "p3": ("ppf-porsche-spray", "Technician spraying water and lifting paint protection film around the headlight of a black Porsche", "50% 45%"),
    "p4": ("ppf-blue-g-edge", "Hands laying paint protection film around the corner marker of a blue Mercedes G-Class fender", "50% 50%"),
    "p5": ("ppf-blue-squeegee", "Close-up of a blue squeegee pressing paint protection film into a body-panel edge on a blue car", "50% 50%"),
    "q1": ("bmw-grille-ppf", "Technician applying paint protection film around the front grille of a white BMW", "50% 50%"),
    "q3": ("m3-pink-hood", "Pink color film being laid over the hood of a black BMW M3", "50% 55%"),
    "q4": ("m3-xpel-fender", "Technician finishing film on the pink fender of a BMW M3 next to an XPEL wheel cover", "50% 50%"),
    "q5": ("porsche-968-spoiler", "Technician applying paint protection film to the rear spoiler of a red Porsche 968", "40% 50%"),
    "q6": ("porsche-968-spoiler-close", "Hands lifting paint protection film along the edge of a red Porsche 968 rear spoiler", "50% 50%"),
    "c1": ("cc-red-roof", "Gloved hand applying ceramic coating along the roof edge of a red car", "50% 50%"),
    "c2": ("cc-applicator-red", "Ceramic coating dripping onto a red applicator pad", "50% 55%"),
    "c3": ("cc-g63-hood", "Technician buffing ceramic coating on the hood of a green Mercedes G-Class", "40% 55%"),
    "c4": ("cc-g63-wipe", "Technician wiping the hood of a green Mercedes G-Class after ceramic coating", "35% 50%"),
    "c5": ("cc-applicator-pour", "Technician pouring ceramic coating onto an applicator pad beside a green Mercedes G-Class", "40% 45%"),
    "fvan": ("ferrari-van", "Matte black Ferrari parked in front of the Divine Detailers mobile detailing van", "50% 100%"),
    "df": ("det-f150-wheel", "Divine Detailers technician hand-washing the custom wheel of a lifted white Ford F-150 at night", "40% 60%"),
    "dv": ("det-truck-van", "Lifted white Ford F-150 parked beside the Divine Detailers wrapped mobile detailing van at night", "35% 60%"),
    "dh": ("det-huracan-front", "Green and black Lamborghini Huracan parked in front of the Divine Detailers van", "50% 60%"),
    "dw": ("det-huracan-wash", "Technician pressure washing a green and black Lamborghini Huracan with foam", "40% 50%"),
    "svan": ("s550-van", "Gray Mercedes S-Class at night in front of the Divine Detailers mobile detailing van", "30% 78%"),
    "gt3": ("gt3-green", "Dark green Porsche 911 GT3 with gold wheels and a gold stripe parked in a driveway", "50% 55%"),
    "pc1": ("pc-demon-hood", "Technician machine polishing the masked hood of a black Dodge Challenger SRT in the shop", "50% 50%"),
    "pc2": ("pc-polish-bottle", "Polish being poured onto a yellow foam pad on a dual-action polisher", "50% 55%"),
    "pc3": ("pc-demon-fender", "Technician polishing the fender of a black Dodge Demon with a dual-action polisher", "50% 50%"),
    "pc4": ("pc-shop-wide", "Two technicians polishing cars in a bright shop with a Challenger, a blue Mustang and a red Demon", "45% 55%"),
    "pc5": ("pc-gt3-rear", "Dark green Porsche 911 GT3 with gold wheels after paint correction", "50% 55%"),
    "tspray": ("ppf-install", "Technician spraying slip solution on a car window before installing window tint", "45% 50%"),
    "tdoor": ("tint-door-wipe", "Technician wiping the freshly tinted door glass of a black luxury coupe in the shop", "50% 52%"),
    "tmirror": ("tint-mirror-clean", "Technician cleaning around the side mirror and tinted window of an olive green SUV", "55% 48%"),
    "tgarage": ("tint-garage-squeegee", "Technician squeegeeing window tint inside the open door of a gray SUV", "55% 40%"),
    "polish": ("polishing", "Technician polishing the hood of a green Mercedes G-Class with a dual-action polisher", "40% 42%"),
}
CARD_PHOTO = {"vinyl-wraps": "gblack", "window-tinting": "spray", "paint-protection-film": "ppf911", "ceramic-coating": "ceramic", "paint-correction": "polish", "exterior-detailing": "svan"}
HERO_PHOTO = {"window-tinting": ("spray", "40% 45%"), "paint-protection-film": ("ppf", "40% 38%"), "ceramic-coating": ("ceramic", "50% 55%"), "paint-correction": ("polish", "40% 40%"), "exterior-detailing": ("foam", "40% 40%")}
BOOK_URL = {"exterior-detailing": "https://app.urable.com/virtual-shop/5FEcNw77jDgOYcunLFZh"}
SERVICE_PHOTOS = {"window-tinting": ("rolls", "tdoor"), "paint-protection-film": ("p3", "p1"), "ceramic-coating": ("c3", "ceramic"), "paint-correction": ("pc2", "pc4"), "vinyl-wraps": (None, None), "exterior-detailing": ("dv", "wash")}
WHY_PHOTO = {"paint-correction": "pc3", "window-tinting": "tspray", "ceramic-coating": "c5", "paint-protection-film": "q6"}
BAND_POS = {"pc4": "45% 55%", "c3": "45% 48%", "c4": "50% 40%", "c5": "50% 45%", "p3": "50% 42%", "p1": "50% 74%", "tdoor": "50% 42%", "wheel": "40% 52%", "dv": "40% 62%", "wash": "55% 60%", "spray": "50% 50%", "tint": "62% 25%", "heat": "50% 58%", "ppf": "50% 52%", "ceramic": "50% 55%", "polish": "40% 45%"}

def photo(key, size=720, pos=None, cls="", alt=True, eager=False):
    f, a, p = PHOTOS[key]
    # wide (1600) images ship a 720 version too, so phones never download the big file
    srcset = f' srcset="assets/photos/{f}-720.webp 720w, assets/photos/{f}-1000.webp 1000w, assets/photos/{f}-1600.webp 1600w" sizes="100vw"' if size == 1600 else ""
    prio = ' fetchpriority="high"' if eager else ""
    return (f'<img class="{cls}" src="assets/photos/{f}-{size}.webp"{srcset} alt="{a if alt else ""}" '
            f'style="object-position:{pos or p}" loading="{"eager" if eager else "lazy"}"{prio} decoding="async">')

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
    <a class="logo-img" href="index.html" aria-label="{SITE['name']} home"><img src="assets/logo-340.webp" alt="{SITE['name']} logo: It's time to shine" width="168" height="96"></a>
    <a class="hdr-call" href="tel:{SITE['tel']}" aria-label="Call {SITE['phone']}"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg><b>Call Now</b></a>
    <button class="menu-btn" aria-label="Open menu" aria-expanded="false" aria-controls="nav"><i></i><i></i><i></i></button>
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

STATUS = '<div class="status"><span class="dot"></span>Estimated Wait Time: 30 Minutes or less</div>'

VEHICLE_MAKES = ["Acura", "Alfa Romeo", "Aston Martin", "Audi", "Bentley", "BMW", "Bugatti", "Cadillac", "Chevrolet", "Chrysler", "Dodge", "Ferrari", "Ford", "Genesis", "GMC", "Honda", "Hyundai", "Infiniti", "Jaguar", "Jeep", "Kia", "Lamborghini", "Land Rover", "Lexus", "Lincoln", "Lotus", "Maserati", "Mazda", "McLaren", "Mercedes-Benz", "Mini", "Mitsubishi", "Nissan", "Polestar", "Porsche", "Ram", "Rivian", "Rolls-Royce", "Subaru", "Tesla", "Toyota", "Volkswagen", "Volvo", "Other"]

def quote_form_short(fid=None, select_default=None):
    """Home page step 1: four inputs, then hands off to the full form on the Contact page."""
    opts = "".join(f'<option{" selected" if o == select_default else ""}>{o}</option>' for o in SERVICE_OPTIONS)
    idattr = f' id="{fid}"' if fid else ""
    return f'''<form class="qform"{idattr} name="quote-step1" action="contact.html#quote" method="GET" data-step1>
  {STATUS}
  <label>Full name*<input name="name" placeholder="Jane Smith" required autocomplete="name"></label>
  <label>Email*<input name="email" type="email" placeholder="jane@example.com" required autocomplete="email"></label>
  <label>Phone*<input name="phone" type="tel" placeholder="(305) 555-0100" autocomplete="tel" inputmode="tel" pattern="[0-9\\s\\(\\)\\+\\.\\-]{{7,}}" title="Enter a valid phone number" required></label>
  <label>Service interested in*<select name="service" required><option value="">Select…</option>{opts}</select></label>
  <p class="consent">By submitting, you agree that {SITE['name']} may contact you by phone, call or text about your request (message and data rates may apply; reply STOP to opt out), and you agree to our <a href="privacy-policy.html">Privacy Policy</a> and <a href="terms.html">Terms</a>. Calls may be recorded for quality.</p>
  <button class="submit" type="submit">Request Quote</button>
</form>'''

def quote_form(fid=None, select_default=None, extra="", status=True):
    import datetime
    opts = "".join(f'<option{" selected" if o == select_default else ""}>{o}</option>' for o in SERVICE_OPTIONS)
    opts_also = "".join(f"<option>{o}</option>" for o in SERVICE_OPTIONS if o != "Other")
    makes = "".join(f"<option>{m}</option>" for m in VEHICLE_MAKES)
    y = datetime.date.today().year + 1
    years = "".join(f"<option>{n}</option>" for n in range(y, 1989, -1)) + "<option>Older</option>"
    idattr = f' id="{fid}"' if fid else ""
    return f'''<form class="qform"{idattr} name="quote" method="POST" action="thanks.html" {form_attrs()} data-form>
  {form_extra("quote")}
  {STATUS if status else ""}
  <label>Full name*<input name="name" placeholder="Jane Smith" required autocomplete="name"></label>
  <label>Email*<input name="email" type="email" placeholder="jane@example.com" required autocomplete="email"></label>
  <label>Phone*<input name="phone" type="tel" placeholder="(305) 555-0100" autocomplete="tel" inputmode="tel" pattern="[0-9\\s\\(\\)\\+\\.\\-]{{7,}}" title="Enter a valid phone number" required></label>
  <label>Service interested in*<select name="service" required><option value="">Select…</option>{opts}</select></label>
  <label>Also interested in <span class="opt">(optional)</span><select name="also_interested" data-also><option value="">None</option>{opts_also}</select></label>
  <label>Vehicle make*<select name="make" data-make required><option value="">Select make…</option>{makes}</select></label>
  <label>Vehicle year*<select name="year" required><option value="">Select year…</option>{years}</select></label>
  <label class="vm">Vehicle model*<input name="model" data-model placeholder="e.g. M3, Model Y" autocomplete="off" required></label>
  {extra}
  <p class="consent">By submitting, you agree that {SITE['name']} may contact you by phone, call or text about your request (message and data rates may apply; reply STOP to opt out), and you agree to our <a href="privacy-policy.html">Privacy Policy</a> and <a href="terms.html">Terms</a>. Calls may be recorded for quality.</p>
  <button class="submit" type="submit">Request Quote</button>
</form>'''

def form_extra(name):
    """Hidden fields: honeypot for our own Worker, or Netlify form name / Web3Forms key as fallbacks."""
    if SITE["lead_endpoint"]:
        return f'<input type="hidden" name="form-name" value="{name}"><input type="checkbox" name="botcheck" style="display:none" tabindex="-1" autocomplete="off">'
    if SITE["form_key"]:
        return (f'<input type="hidden" name="access_key" value="{SITE["form_key"]}"><input type="hidden" name="subject" value="New {name} request from the {SITE["name"]} website">'
                f'<input type="hidden" name="from_name" value="{SITE["name"]} website"><input type="checkbox" name="botcheck" style="display:none" tabindex="-1" autocomplete="off">')
    return f'<input type="hidden" name="form-name" value="{name}">'

def form_attrs():
    if SITE["lead_endpoint"]:
        return f'data-endpoint="{SITE["lead_endpoint"]}" data-own="1"'
    return 'data-endpoint="https://api.web3forms.com/submit"' if SITE["form_key"] else 'data-netlify="true"'

def stripes():
    return '<div class="stripes" aria-hidden="true"></div>'

BRANDS = [("avery-dennison", "Avery Dennison", "Wrap"), ("3m", "3M", "Wrap"), ("pure-ppf", "Pure PPF", ""), ("xpel", "XPEL", ""),
          ("braman-miami", "Braman Miami", ""), ("doral-collision-center", "Doral Collision Center", ""), ("limited-spec", "Limited Spec", "")]

def brand_tile(slug, name, sub):
    import os
    for ext in ("svg", "png", "webp"):
        if os.path.exists(f"assets/brands/{slug}.{ext}"):
            dims = ""
            try:
                from PIL import Image
                w, h = Image.open(f"assets/brands/{slug}.{ext}").size
                dims = f' width="{w}" height="{h}"'
            except Exception:
                pass
            return f'<div class="brand has-logo" title="{name}"><img src="assets/brands/{slug}.{ext}" alt="{name}"{dims} loading="lazy" decoding="async"></div>'
    s = f"<small>{sub}</small>" if sub else ""
    return f'<div class="brand"><b>{name}</b>{s}</div>'

def partners():
    tiles = "".join(brand_tile(*x) for x in BRANDS)
    dup = tiles.replace('<div class="brand', '<div aria-hidden="true" class="brand')
    return f'''<section class="partners center"><span class="chip">In partnership with the best in the business</span>
  <div class="rev-track marquee logo-marquee"><div class="rev-run logo-run" style="animation-duration:{len(BRANDS) * 5}s">{tiles}{dup}</div></div></section>'''

def cta_banner():
    return f'''<section class="banner center">
  <div class="wrap"><a class="foot-logo banner-logo" href="index.html" aria-label="{SITE['name']} home"><img src="assets/logo-340.webp" alt="{SITE['name']} logo" width="240" height="138" loading="lazy"></a>
  <h2>We don&rsquo;t just detail cars, <span class="dim">we perfect them.</span></h2>
  <p>Reach out and let&rsquo;s talk about what your car needs next.</p>
  <a class="btn" href="contact.html#quote"><span class="dot"></span>Contact us</a></div></section>'''

def footer():
    svc = "".join(f'<li><a href="{s}.html">{t}</a></li>' for s, t, _ in SERVICES)
    soc = "".join(f'<li><a href="{SITE[k]}" target="_blank" rel="noopener">{k.capitalize()}</a></li>' for k in ("tiktok", "instagram", "youtube") if SITE[k] != "#")
    return f'''<footer class="foot-wrap">
  <div class="foot">
    <div><h4>Quick links</h4><ul><li><a href="index.html">Home</a></li><li><a href="about-us.html">About us</a></li><li><a href="projects.html">Projects</a></li><li><a href="blog.html">Blogs</a></li><li><a href="contact.html">Contact us</a></li></ul></div>
    <div><h4>Services</h4><ul>{svc}</ul></div>
    <div><h4>Follow us</h4><ul>{soc}<li><a href="tel:{SITE['tel']}">{SITE['phone']}</a></li><li><a href="mailto:{SITE['email']}">{SITE['email']}</a></li></ul></div>
    <div class="news"><p>Join for expert car care tips and exclusive offers on our top services.</p>
      <form name="newsletter" method="POST" action="thanks.html" {form_attrs()} data-form>{form_extra("newsletter")}<input name="email" type="email" placeholder="Your email" required aria-label="Your email"><button class="btn" type="submit">Join Now</button></form>
      <small>By subscribing, you agree to our <a href="privacy-policy.html">Privacy Policy</a> and consent to receive updates from {SITE['name']}.</small></div>
  </div>
  <div class="copy">&copy; <span id="yr">2026</span> {SITE['name']}. All rights reserved. <a href="privacy-policy.html">Privacy Policy</a> &middot; <a href="terms.html">Terms of Service</a></div>
</footer>'''

FONT_URL = "https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&family=Special+Gothic+Expanded+One&display=swap"
CSS_URL, JS_URL = "styles.css", "script.js"

def build_assets():
    """Minify styles.css / script.js into hashed files so they can be cached for a year."""
    global CSS_URL, JS_URL
    import hashlib
    for src, out, kind in (("styles.css", "styles.min.css", "css"), ("script.js", "script.min.js", "js")):
        text = open(src).read()
        try:
            if kind == "css":
                import rcssmin
                text = rcssmin.cssmin(text)
            else:
                import rjsmin
                text = rjsmin.jsmin(text)
        except ImportError:
            pass   # pip install rcssmin rjsmin for smaller files; unminified still works
        open(out, "w").write(text)
        v = hashlib.md5(text.encode()).hexdigest()[:8]
        if kind == "css": CSS_URL = f"{out}?v={v}"
        else: JS_URL = f"{out}?v={v}"

# CallRail call tracking: swaps the phone number on the page for a tracking number (set to "" to turn it off)
CALLRAIL_SRC = "https://cdn.callrail.com/companies/865473736/7dd16a198431c7d95229/12/swap.js"
GA4_ID = "G-MJXY53KT26"
GA4 = f'<script async src="https://www.googletagmanager.com/gtag/js?id={GA4_ID}"></script>\n<script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments);}}gtag("js",new Date());gtag("config","{GA4_ID}");</script>\n' if GA4_ID else ""
CALLRAIL = f'<link rel="preconnect" href="https://cdn.callrail.com">\n<script src="{CALLRAIL_SRC}" defer></script>\n' if CALLRAIL_SRC else ""

def page(fname, title, desc, body, active=None, noindex=False):
    preload = ""
    m = re.search(r'<img [^>]*src="([^"]+)"( srcset="([^"]+)" sizes="([^"]+)")?[^>]*fetchpriority="high"', body)
    if m:
        preload = (f'<link rel="preload" as="image" fetchpriority="high" imagesrcset="{m.group(3)}" imagesizes="{m.group(4)}">\n' if m.group(2)
                   else f'<link rel="preload" as="image" fetchpriority="high" href="{m.group(1)}">\n')
    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(desc)}">
{'<meta name="robots" content="noindex,nofollow">' if noindex else ''}
<link rel="preload" as="font" type="font/woff2" href="assets/fonts/special-gothic.woff2" crossorigin>
<link rel="preload" as="font" type="font/woff2" href="assets/fonts/manrope.woff2" crossorigin>
<link rel="icon" type="image/png" href="assets/favicon.png">
<link rel="apple-touch-icon" href="assets/apple-touch-icon.png">
{preload}<link rel="stylesheet" href="{CSS_URL}">
{GA4}{CALLRAIL}</head>
<body>
{header(active)}
<main class="page">
{body}
{footer()}
</main>
<a class="callfab" href="tel:{SITE['tel']}" aria-label="Call {SITE['name']} at {SITE['phone']}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg><span>Call Now<small>{SITE['phone']}</small></span></a>
<script src="{JS_URL}" defer></script>
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

def hero_video(name, poster):
    # sources are attached by script.js after the page has loaded, so the video never competes with the headline
    return (f'<video class="hero-vid" muted loop playsinline preload="none" tabindex="-1" '
            f'data-webm="assets/video/{name}.webm" data-mp4="assets/video/{name}.mp4"></video>')
VIDEO = hero_video("hero-bg", "tint-hero-poster")
HERO_VIDEO = {"window-tinting": VIDEO, "paint-protection-film": hero_video("ppf-hero", "ppf-hero-poster"), "ceramic-coating": hero_video("ceramic-hero", "ceramic-hero-poster"), "vinyl-wraps": hero_video("wrap-hero", "x"), "paint-correction": hero_video("pc-hero", "x"), "exterior-detailing": hero_video("detail-hero", "x")}

def inner_hero(title_html, sub, crumbs, form=False, select=None, buttons=True, hero=None, status=True, video=None, book=None):
    c = " / ".join(crumbs)
    btns = f'''<div class="btn-row"><a class="btn" href="tel:{SITE['tel']}"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg><b>Call Now</b><span>{SITE['phone']}</span></a><a class="btn gray" href="contact.html#quote"><span class="dot"></span>Get Your Free Quote</a></div>''' if buttons else ""
    q = f'<div class="qwrap">{quote_form(select_default=select, status=status)}</div>' if form else ""
    if book:
        q = f'''<div class="qwrap" id="book"><div class="book-frame"><iframe src="{book}" title="Book an appointment with {SITE['name']}" loading="lazy" scrolling="no" frameborder="0" marginheight="0" marginwidth="0" height="1200" width="100%"></iframe></div></div>'''
        btns = btns.replace('href="contact.html#quote"><span class="dot"></span>Get Your Free Quote', 'href="#book"><span class="dot"></span>Book Online')
    return f'''<section class="page-hero{' tall' if form else ''}{' has-vid' if video else ''}">
  <div class="hero-media" aria-hidden="true"></div>
  <div class="wrap hero-in"><div class="hero-txt"><h1>{title_html}</h1><p class="lead" style="margin:16px auto 26px">{sub}</p>{btns}</div>{('<div class="vframe" aria-hidden="true">' + video + '</div>') if video else ""}</div>
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

PROJECT_VIDS = [("Wraps", "urus-wrap", "Lamborghini Urus satin wrap", "Technicians installing a satin silver wrap on a Lamborghini Urus", False),
        ("Ceramic", "m3-ceramic", "BMW M3 ceramic coating", "Divine Detailers explaining a ceramic coating on a white BMW M3", True),
        ("PPF Wraps", "f150-ppf", "Ford F-150 PPF and trim wrap", "Technicians installing paint protection film and black trim wrap on a white Ford F-150", False),
        ("PPF", "gt4-ppf", "Porsche 718 GT4 PPF", "Technicians installing paint protection film on a red Porsche 718 GT4", True),
        ("Ceramic Correction", "correction-green", "G-Wagon polish and ceramic coating", "Technicians washing, machine polishing and ceramic coating an olive green Mercedes G-Wagon", False),
        ("Wraps", "gwagon-wrap", "Mercedes G-Wagon wrap makeover", "Mercedes G-Wagon wrap makeover finished in matte black", True),
        ("Tint", "black-ppf", "Rolls-Royce window tint", "Technicians installing window tint on a black Rolls-Royce", False),
        ("Detailing", "mobile-detail", "Mobile detailing: Porsche 911", "Divine Detailers explaining mobile detailing on a Porsche 911", True),
        ("Ceramic", "m3-prep", "BMW M3 ceramic coating application", "Technicians prepping and applying ceramic coating to a white BMW M3", False),
        ("PPF", "golf-ppf", "VW Golf R PPF", "Divine Detailers explaining paint protection film on a VW Golf R", True),
        ("Tint", "porsche-tint", "Porsche 718 GT4 window tint", "Technician tinting the windows of a red Porsche 718 GT4", False),
        ("Ceramic Detailing", "m3-ppf", "BMW M3 wash and ceramic coating", "Technicians washing and applying ceramic coating to a gray BMW M3", False),
        ("PPF Tint", "m2-ppf", "BMW M2 CS PPF and tint", "Divine Detailers explaining paint protection film and window tint on a BMW M2 CS", True),
        ("Wraps Tint", "cybertruck-wrap", "Tesla Cybertruck wrap and tint", "Divine Detailers explaining a matte black wrap and window tint on a Tesla Cybertruck", True),
        ("PPF", "p911-front-ppf", "Porsche 911 full-front PPF", "Technician explaining full-front paint protection film on a light blue Porsche 911", True),
        ("Correction", "polish-talk", "Machine polishing explained", "Technician machine polishing a gray car while explaining paint correction", True),
        ("Tint", "suv-tint", "Rivian window tint", "Technicians installing dark window tint on an olive green Rivian", False),
        ("PPF", "blue-ppf", "Dodge Charger PPF", "Divine Detailers explaining paint protection film on a blue Dodge Charger", True),
        ("Detailing", "gt3-detail", "Porsche 911 GT3 wash and detail", "Technicians washing and detailing a green Porsche 911 GT3 in a driveway", False),
        ("Tint", "bmw-tint-talk", "BMW window tint explained", "Divine Detailers explaining ceramic window tint on a white BMW", True),
        ("PPF", "ppf-install", "Jeep paint protection film install", "Technician installing clear paint protection film on the front end of a black Jeep", False),
        ("PPF Detailing", "gt3rs-wash", "Porsche 911 GT3 RS PPF and wash", "Divine Detailers explaining paint protection film and washing a white Porsche 911 GT3 RS", True),
        ("PPF Ceramic", "p911-turbo-talk", "Porsche 911 Turbo PPF and coating", "Divine Detailers explaining paint protection film and coatings on a gray Porsche 911 Turbo", True),
        ("PPF Correction Ceramic", "raptor-talk", "Ford F-150 Raptor R PPF, polish and ceramic", "Divine Detailers explaining PPF, paint correction and ceramic coating on a black Ford F-150 Raptor R", True),
        ("Ceramic Detailing", "cullinan-ceramic", "Rolls-Royce Cullinan interior ceramic", "Divine Detailers applying ceramic coating to the orange leather interior of a Rolls-Royce Cullinan", True),
        ("PPF Detailing", "ferrari-roma-ppf", "Ferrari Roma matte PPF care", "Divine Detailers explaining matte paint protection film care on a Ferrari Roma", True),
        ("Detailing", "aventador-wash", "Lamborghini Aventador SVJ wash", "Technician washing a gold Lamborghini Aventador SVJ in a driveway", False),
        ("Detailing", "mobile-concept", "Mobile detailing at your door", "Divine Detailers explaining the mobile detailing service with a Lamborghini Urus and Corvette being washed", True),
        ("Correction", "sf90-correction", "Ferrari SF90 paint correction", "Divine Detailers explaining paint correction on a red Ferrari SF90", True),
        ("Ceramic Detailing", "superduty-ceramic", "Ford Super Duty ceramic coating wash", "Divine Detailers explaining how a ceramic coating makes a white Ford Super Duty easier to rinse", True),
        ("Detailing", "skyline-wash", "Nissan Skyline GT-R wash", "Technicians washing and detailing a blue Nissan Skyline GT-R in a driveway", False),
        ("Correction", "charger-correction", "Dodge Charger paint correction", "Technicians masking and machine polishing a Dodge Charger while explaining paint correction", True),
        ("Detailing", "corvette-engine", "Corvette engine bay detail", "Divine Detailers explaining how to safely wash a Corvette engine bay", True),
        ("PPF Detailing", "m3-matte-care", "BMW M3 matte PPF care", "Divine Detailers explaining matte paint protection film care on a BMW M3", True),
        ("Detailing", "bmw7-wash", "BMW 7 Series wash and detail", "Divine Detailers explaining the signature wash package on a white BMW 7 Series", True),
        ("Detailing Ceramic", "tesla-wash", "Tesla signature wash and sealant", "Divine Detailers explaining the signature wash and sealant on a black Tesla", True),
        ("Detailing", "x6-calipers", "BMW X6 M brake caliper cleaning", "Divine Detailers explaining brake caliper and wheel cleaning on a BMW X6 M", True),
        ("Detailing", "sclass-interior", "Mercedes S-Class interior shampoo and conditioning", "Divine Detailers explaining an interior shampoo, exfoliation and leather conditioning on a Mercedes S-Class", True),
        ("Detailing", "bugatti-wash", "Bugatti Chiron Pur Sport wash", "Technicians hand washing a purple Bugatti Chiron Pur Sport in a driveway", False),
        ("Ceramic", "wheel-ceramic", "Ceramic coating for wheels", "Divine Detailers explaining ceramic coating on BMW wheels and rims", True),
        ("Detailing", "mobile-showroom", "Mobile detailing: Ferrari and Lamborghini", "Divine Detailers explaining keeping a Ferrari and Lamborghini showroom clean with mobile detailing", True),
        ("Detailing", "mobile-schedule", "Mobile detailing that fits your schedule", "Divine Detailers explaining mobile detailing at your home with a Rolls-Royce Cullinan and Porsche GT3", True),
        ("PPF", "bmw-m3-white-ppf", "BMW M3 PPF explained", "Divine Detailers explaining paint protection film on a white BMW M3", True),
        ("PPF", "p911-ppf", "Porsche 911 rocker PPF", "Technicians installing film on the side skirts of a black Porsche 911 cabriolet", False),
        ("PPF", "white-ppf-talk", "Why PPF matters", "Divine Detailers explaining paint protection film over carbon fiber", True)]

def vtile(c, n, t, a, talk, still=False):
    vid = "" if still else '<video muted loop playsinline preload="none" tabindex="-1" aria-hidden="true"></video>'
    return (f'<button class="vtile" type="button" data-cat="{c}" data-src="assets/projects/{n}.mp4" data-prev="assets/projects/{n}-p.mp4" data-title="{t}" aria-label="Play video: {t}">'
            f'<img src="assets/projects/{n}.webp" alt="{a}" width="480" height="853" loading="lazy" decoding="async">'
            f'{vid}'
            f'<span class="vplay" aria-hidden="true"></span>{"<span class=vsound>Sound on</span>" if talk else ""}<span class="vcap"><i>{c.replace(" "," · ")}</i>{t}</span></button>')

VMODAL = '<div class="vmodal" id="vmodal" hidden><button class="vclose" type="button" aria-label="Close video">&times;</button><video id="vmodalVid" controls playsinline></video></div>'

HOME_VIDS = [("Wraps Tint", "cybertruck-wrap", "Tesla Cybertruck wrap and tint", "Divine Detailers explaining a matte black wrap and window tint on a Tesla Cybertruck", True),
             ("PPF", "gt4-ppf", "Porsche 718 GT4 PPF", "Technicians installing paint protection film on a red Porsche 718 GT4", True),
             ("Ceramic", "m3-ceramic", "BMW M3 ceramic coating", "Divine Detailers explaining a ceramic coating on a white BMW M3", True),
             ("PPF Tint", "m2-ppf", "BMW M2 CS PPF and tint", "Divine Detailers explaining paint protection film and window tint on a BMW M2 CS", True)]

def build_home():
    cards = "".join(service_card(s, t, d) for s, t, d in SERVICES)
    home_map = map_block()
    slides = "".join(f'<div class="slide">{photo(k, 720)}</div>' for k in ["ppf911", "gwagon", "tdoor", "ceramic", "wash", "rolls", "tmirror", "polish", "foam", "tint", "tgarage", "q1", "q3", "wheel", "q4", "spray", "q5", "heat"])
    GICON = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>'
    revs = "".join(f'''<article class="review"><div class="rhead"><span class="gbadge">{GICON}</span><div class="rsrc"><b>GOOGLE REVIEW</b><span>{SITE['name']}</span></div><span class="rstars" aria-label="5 out of 5 stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span></div><h4>Recent Client</h4><p>{t}</p></article>''' for n, t in REVIEWS)
    revs_dup = revs.replace('<article class="review">', '<article class="review" aria-hidden="true">')
    socials = "".join(f'<a href="{SITE[k]}" target="_blank" rel="noopener" aria-label="{k.capitalize()}">{ICON[k]}</a>' for k in ("instagram", "tiktok", "facebook", "youtube") if SITE[k] != "#")
    body = f'''<section class="hero">
  <div class="hero-top">
  <div class="hero-media has-photo lighter" aria-hidden="true">{photo("gwagon", 1600, "50% 60%", alt=False, eager=True)}</div>
  <div class="wrap hero-in">
    <p class="small">Welcome to {SITE['name']}</p>
    <h1>Window tint, PPF, ceramic coatings &amp; <em>paint correction</em></h1>
    <p class="sub">Premium vehicle protection and detailing</p>
    <p class="lead">Protect and perfect your vehicle with Miami&rsquo;s premium detailing and protection shop.</p>
    <div class="hero-btns"><a class="btn" href="tel:{SITE['tel']}"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg><b>Call Now</b><span>{SITE['phone']}</span></a><a class="btn gray" href="#hero-quote">Request Quote</a></div>
  </div>
  </div>
  <div class="qwrap">{quote_form_short(fid="hero-quote")}</div>
</section>
{stripes()}
{partners()}
<section class="sec" id="services" style="border-top:1px solid var(--line)">
  <div class="wrap center"><span class="chip">Our Services</span>
  <h2>Professional automotive <em>services</em></h2>
  <p class="lead" style="margin-top:14px">At {SITE['name']}, we turn your vehicle into a head-turning masterpiece.</p>
  <div class="svc-slider"><div class="cards" style="text-align:initial">{cards}</div><button class="svc-btn prev" data-svc="-1" aria-label="Previous service">&#8249;</button><button class="svc-btn next" data-svc="1" aria-label="Next service">&#8250;</button></div></div>
</section>
<section class="cta-strip"><div class="btn-row"><a class="btn" href="tel:{SITE['tel']}"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg><b>Call Now</b><span>{SITE['phone']}</span></a><a class="btn gray" href="contact.html#quote"><span class="dot"></span>Get Your Free Quote</a></div></section>
{stripes()}
<section class="sec" style="padding-bottom:0">
  <div class="wrap center"><span class="chip">Our Achievements</span></div>
  <div class="stats"><div class="stat"><b>5000+</b><span>Vehicles completed</span></div><div class="stat"><b>4.9★</b><span>Google rating</span></div><div class="stat"><b>20+</b><span>Years of experience</span></div></div>
  <div class="wrap center" style="padding:70px 0 70px"><span class="chip">Social Media Following</span>
  <div class="social-ico">{socials}</div>
  <p class="followers"><b>15K+</b> Followers across platforms</p>
  <h2>Follow every <em>build</em></h2><div style="margin-top:26px"><a class="btn gray" href="{SITE['instagram']}" target="_blank" rel="noopener">Visit Instagram</a></div></div>
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
  <div class="rev-wrap" style="text-align:initial"><div class="rev-track marquee"><div class="rev-run" style="animation-duration:{len(REVIEWS) * 30}s">{revs}{revs_dup}</div></div>
  </div></div>
</section>
{stripes()}
<section class="sec">
  <div class="wrap"><div class="unlock single"><div class="bar"><h2>Unlock the ultimate driving experience</h2>
  <p>{SITE['name']} brings vehicle protection and detailing to Miami drivers who care about how their car looks and how long it lasts. We tailor each service to your vehicle and your style, with certified installers who focus on the small details. Every project happens in a facility built for precise work, quality products and a polished experience from start to finish.</p>
  <a class="btn" href="tel:{SITE['tel']}"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg><b>Call Now</b><span>{SITE['phone']}</span></a></div></div></div>
</section>
<section class="feat"><div class="txt"><span class="kick">Protect</span><h2>Protect and preserve your car&rsquo;s flawless finish</h2><p>Keep your vehicle looking new with protection built for Miami&rsquo;s sun, salt air and storms. Paint protection film takes the hit from rock chips and road debris, while ceramic coating adds gloss, shrugs off contaminants and makes every wash faster.</p></div>{photo_box("c3", pos="50% 55%")}</section>
<section class="feat rev"><div class="txt"><span class="kick">Customize</span><h2>Make your ride uniquely yours</h2><p>Whether you want a refined upgrade or a bold new look, we turn your ideas into high-quality results. Vinyl wraps change color, texture and finish, while premium window tint cuts heat and glare and gives the car a cleaner, finished look.</p></div>{photo_box("q3", pos="50% 60%")}</section>
<section class="feat"><div class="txt"><span class="kick">Enjoy</span><h2>Take your car&rsquo;s style to new heights</h2><p>Our shop is built on craft and customer satisfaction. Every vehicle gets a careful inspection before it goes home, and our work is backed by a workmanship guarantee so you can drive away with confidence.</p></div>{photo_box("gt3", pos="50% 55%")}</section>
<section class="sec" id="portfolio">
  <div class="wrap center"><span class="chip">Our Portfolio</span><h2>Recent vehicles <em>completed.</em></h2>
  <div class="vgrid vhome">{"".join(vtile(*v, still=True) for v in HOME_VIDS)}</div>
  <div style="margin-top:44px"><a class="btn" href="projects.html">View More Projects</a></div></div>{VMODAL}
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
<div class="svc-slider"><div class="cards" style="text-align:initial">{cards}</div><button class="svc-btn prev" data-svc="-1" aria-label="Previous service">&#8249;</button><button class="svc-btn next" data-svc="1" aria-label="Next service">&#8250;</button></div></div></section><section class="cta-strip"><div class="btn-row"><a class="btn" href="tel:{SITE['tel']}"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg><b>Call Now</b><span>{SITE['phone']}</span></a><a class="btn gray" href="contact.html#quote"><span class="dot"></span>Get Your Free Quote</a></div></section>{cta_banner()}'''
    page("services.html", f"Our Services | {SITE['name']}", "Window tint, paint protection film, ceramic coating, paint correction, vinyl wraps and exterior detailing in Miami.", body, "services")

# ---------------------------------------------------------------- service pages
SERVICE_PAGES = {
 "window-tinting": dict(
    sub="Enhance privacy, reduce glare, and keep your interior cooler with tint installation.",
    pk_title="Tint package options", pk_sub="Browse our different package options.",
    packages=[("Two windows", ["Front driver side", "Front passenger side"]), ("Full tint", ["Front driver + passenger", "Rear driver + passenger"]), ("Windshield", ["Full windshield", "Extra protection"]), ("Sunvisor strip", ["Sun strip", "Reduces sun glare"])],
    impact_kick="The impact", impact_h="Cooler drives. Cleaner look.",
    impact_p="Miami&rsquo;s sunshine can heat up a cabin quickly. Premium ceramic window film stops heat before it builds up inside, so even after sitting in direct sun, the vehicle feels more comfortable for you and your passengers.",
    nums=[("60%", "Quality window tint significantly lowers interior temperatures during hot days. This improves comfort and reduces strain on your AC system."), ("99%", "Tint protects your interior materials from fading and cracking over time. It also protects your skin during long drives.")],
    tiles=[("Comfort", "Comfort", "Reduces interior heat and makes driving more enjoyable year-round."), ("Privacy", "Privacy", "Limits visibility into your vehicle while keeping clear visibility out."), ("Protection", "Protection", "Blocks harmful UV rays that damage interiors and skin."), ("Appearance", "Appearance", "Gives your vehicle a clean, finished and more refined look.")],
    why_h="Why trust Divine Detailers", why_p="Our certified installers cut film with precision and finish every job with a close final inspection before delivery. We use premium ceramic films with a manufacturer warranty, and we back our workmanship.",
    faq=[("Window tint", FAQ_TINT, "tint")], sim=True, select="Window Tint"),
 "paint-protection-film": dict(
    sub="Paint protection film guards your vehicle from rock chips, scratches and everyday road damage while keeping the original paint looking untouched.",
    pk_title="PPF package options", pk_sub="Browse our different package options.",
    packages=[("Partial Front", ["Partial front bumper", "Partial front hood"]), ("Full Front", ["Full bumper + hood", "Full fenders + mirrors"]), ("Track Package", ["Hood + fenders + bumper", "A-pillars + roof edges + mirrors"]), ("Full Protection", ["Full vehicle coverage", "Rear trunk + bumper"])],
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
    impact_kick="The impact", impact_h="Professional ceramic coating for long-term protection",
    impact_p="At Divine Detailers, we know that paint condition decides how well a coating bonds and how good the final gloss looks. Our installers carefully inspect the vehicle, prepare the surface and apply the ceramic coating for long-lasting protection built for Miami&rsquo;s sun, rain and humidity.",
    nums=[("90%", "Ceramic coating helps block most dirt, grime and environmental fallout from bonding to your paint."), ("80%", "The coating reduces the sun exposure that causes fading and oxidation over time.")],
    tiles=[("Gloss", "Deep shine", "Adds depth and clarity that wax cannot match."), ("Hydrophobic", "Sheds water", "Water beads and rolls off, carrying dirt with it."), ("Protection", "UV and chemicals", "Resists fading, oxidation and acid rain."), ("Easy care", "Faster washes", "Contaminants release easily so the paint stays cleaner.")],
    why_h="Why ceramic coating is worth it", why_p="A ceramic coating doesn&rsquo;t replace regular washing. It makes routine care easier and helps your vehicle keep a sleek look between washes. For ceramic coating installation, book an appointment with Divine Detailers in Miami. We combine careful prep and premium products with workmanship we stand behind, so you are happy with the end result.",
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
    rows=[("Comfort", "Cooler drives in Miami's sun", "Premium ceramic window film stops solar heat before it warms the cabin. Seats, steering wheel and dash stay more comfortable after the car sits in the sun.", "Because the film has no metal in it, GPS, phone and radio signals keep working normally.", "tgarage"),
          ("Protection", "Protect your interior and your skin", "UV rays fade and crack leather, plastics and upholstery over time. Quality film blocks nearly all of them, so your interior keeps its color and feel.", "The same film helps hold glass together and reduces glare for safer, less tiring driving.", "tmirror"),
          ("Style", "A cleaner, more finished look", "Tint changes how a vehicle looks from the first glance. We help you pick a shade that fits your style and stays within legal limits for each window.", "Every piece is cut to fit and installed in a clean bay, then inspected before you drive away.", "tint")]),
 "paint-protection-film": dict(
    hl_h="Defend your paint from day one.",
    hl=[("Chip protection", "Absorbs rock chips and road debris", "Keeps paint intact where it counts"), ("Self-healing", "Light marks fade with warmth", "Stays smooth and glossy"), ("Invisible look", "Clear, gloss or satin finishes", "Your color shows through"), ("Long-lasting", "Built for years of daily driving", "Backed by a manufacturer warranty")],
    rows=[("Protect", "Take the hit so your paint doesn't", "Paint protection film is a thick, clear urethane that sits over your paint. Chips, scratches and stains land on the film instead of the finish.", "The most-hit areas are the front bumper, hood, fenders and mirrors, and that is where most owners start.", "p2"),
          ("Preserve", "Keep the factory finish like new", "Protected paint holds its gloss and color, and the car keeps stronger resale appeal. When the film's time is up, a pro can remove it and the paint underneath is untouched.", "Add a ceramic coating on top and the film is easier to wash and resists water spots.", "q1"),
          ("Customize", "Gloss, satin or even color", "Choose a clear gloss film to keep the factory look, a satin film for a matte-style finish, or a colored film to change the look while protecting the paint.", "We will recommend the right coverage and film for your car and how you drive.", "q3")]),
 "ceramic-coating": dict(
    hl_h="Why get ceramic coating.",
    hl_p="Divine Detailers provides ceramic coating installation in Miami for drivers who want lasting shine and easy exterior maintenance. The coating bonds to the paint and forms a slick surface that releases water, dirt and more during routine washing. The refined finish gives your vehicle a strong defensive layer against UV exposure and everyday buildup.",
    hl=[("Maximum protection", "Lasting UV protection", "Keeping your car cleaner for longer"), ("Long-lasting durability", "Superior UV protection", "Clean and vibrant longer"), ("Hydrophobic coating", "Advanced nanotechnology", "Reducing stains and buildup"), ("Glossy finish that turns heads", "Enhances your vehicle&rsquo;s finish", "Effortlessly polished look")],
    rows=[("Ceramic coating", "What it protects against", "Ceramic coating helps resist dirt, road grime, bird droppings, water spots and environmental fallout. This reduces staining and surface damage that normally affects unprotected paint.", "", "c4"),
          ("Ceramic coating", "How it improves appearance", "The coating enhances gloss and adds noticeable depth to your paint&rsquo;s color and reflections. Your vehicle keeps a freshly detailed look for much longer.", "", "c1"),
          ("Ceramic coating", "Maintenance becomes easier", "Water, mud and debris have a harder time sticking to the coated surface. This makes washing faster and keeps the vehicle cleaner between washes.", "", "gt3"),
          ("Ceramic coating", "How long it lasts", "With proper care, ceramic coating provides long-term protection that holds up against daily driving and weather exposure. It is designed to maintain its performance and appearance for years.", "", "c2")],
    proc_h="Our ceramic coating process",
    proc_p="In our shop, we wash, decontaminate and evaluate the paint before any coating goes on. This step removes surface buildup and gives the coating a clean foundation. Our installers then apply the coating in controlled sections to support even coverage and a smooth finish.",
    proc=[("Surface preparation", "We fully clean and decontaminate the paint to remove anything that could prevent proper bonding."), ("Paint correction", "Swirl marks and light imperfections are polished out to create a flawless surface before coating."), ("Coating application", "The ceramic is applied evenly in controlled sections for complete and consistent coverage."), ("Final inspection", "We inspect the entire vehicle under professional lighting to make sure the finish is perfect.")]),
 "paint-correction": dict(
    hl_h="Real defects removed, not filled.",
    hl=[("Inspect", "Measure paint and check under lights", "We find what is really there"), ("Cut", "Remove swirls, scratches and etching", "Only as much as the paint needs"), ("Refine", "Polish to a deep, clear finish", "Maximum gloss and clarity"), ("Protect", "Finish with sealant, coating or film", "Keep the result looking new")],
    rows=[("Correct", "Restore the gloss you paid for", "Everyday washing, dust and water spots leave fine marks that dull the paint. Machine polishing levels the clear coat so those marks are gone, not hidden.", "We only correct as much as your paint needs, and we tell you honestly what polishing can and can't fix.", "polish"),
          ("Prepare", "The best base for coating or film", "A flawless surface is the first step before ceramic coating or paint protection film, since both lock in whatever is under them.", "Many customers combine correction with a coating for a finish that lasts.", "pc1"),
          ("Enjoy", "Paint that looks new again", "After correction, color looks richer and reflections look sharper. It is the biggest visual change you can make without repainting.", "", "pc5")]),
 "vinyl-wraps": dict(
    hl_h="Customize your vehicle color today.",
    hl=[("Preparation", "Deep clean and panel decontamination", "A perfect base for adhesion"), ("Precision install", "Seamless wrapping across curves and edges", "A paint-like finish"), ("After install", "Heat-set edges and final inspection", "A clean, tight finish built to last"), ("Care guidance", "Washing and maintenance tips", "Keep the color vibrant")],
    rows=[("Protect", "Shields your factory paint", "A wrap takes the beating from road debris, light scratches and weather, so the paint underneath stays in better shape.", "That added layer also helps resale when the wrap is removed.", None),
          ("Customize", "Colors and finishes without limits", "Gloss, satin, matte, metallic or color-shift: vinyl gives you looks that would be costly or impossible with paint, and it can be changed later.", "You can go for a bold full color change or just add accents.", None),
          ("Maintain", "Simple to care for", "Wrapped vehicles are easy to wash, and with proper care the color depth and finish stay fresh for years.", "We'll explain what to use and what to avoid.", None)]),
 "exterior-detailing": dict(
    hl_h="Clean paint, properly cared for.",
    hl=[("Safe wash", "Lubricated hand washing", "Keeps swirls out of the paint"), ("Decontamination", "Iron and clay treatment", "Removes what washing leaves behind"), ("Protection", "Sealant or wax", "Keeps the shine and eases the next wash"), ("Finishing", "Wheels, trim, glass, door jambs", "Every detail handled")],
    rows=[("Wash", "A wash that protects your paint", "Most paint damage starts with a bad wash. We use controlled, gentle methods that lift dirt away instead of grinding it in.", "The result is a clean surface that is ready for protection.", "dw"),
          ("Decon", "Deep clean beyond the wash", "Iron remover and clay treatment lift the embedded contamination that makes paint feel rough and look dull.", "It is also the right first step before correction, coating or film.", "df"),
          ("Maintain", "Keep it looking its best", "Regular maintenance details keep coatings performing and paint glossy, so small problems never turn into big ones.", "Ask us about a maintenance schedule that fits your car.", "dh")]),
}

SIM = [(5, "Limo tint", "Maximum privacy. Very dark, best for rear windows where legal."),
       (15, "Dark tint", "Strong privacy with a bold look. Check legal limits for your windows."),
       (30, "Medium tint", "Balanced privacy with clear night visibility. A daily-driver favorite."),
       (50, "Light tint", "Subtle look with strong heat and UV protection. Easy night driving."),
       (70, "Clear heat-rejection", "Nearly invisible film that still cuts heat and blocks UV.")]

def build_service(slug, title, short):
    d = SERVICE_PAGES[slug]
    PIMG_ALL = {"window-tinting": ("tint", {"Two windows": "two-windows", "Full tint": "full-tint", "Windshield": "windshield", "Sunvisor strip": "sunvisor-strip"}),
                "paint-protection-film": ("ppf", {"Partial Front": "highway", "Full Front": "full-front", "Track Package": "individual-panels", "Full Protection": "full-body"})}
    PDIR, PIMG = PIMG_ALL.get(slug, ("", {}))
    pimg = lambda t: (f'<div class="pimg"><img src="assets/{PDIR}/{PIMG[t]}.webp" alt="{t} package at the Divine Detailers shop" width="960" height="559" loading="lazy"></div>' if t in PIMG else '<div class="pimg">Photo</div>')
    pk = "".join(f'<div class="pkg">{pimg(t)}<h3>{t}</h3><ul>{"".join(f"<li>{i}</li>" for i in items)}</ul></div>' for t, items in d["packages"])
    nums = "".join(f'<div><b>{n}</b><span>{l}</span></div>' for n, l in d["nums"])
    tiles = "".join(f'<div class="tile"><span class="kick">{k}</span><h3>{h}</h3><p>{p}</p></div>' for k, h, p in d["tiles"])
    sim = ""
    if d.get("sim"):
        btns = "".join(f'<button data-vlt="{v}" data-name="{n}" data-desc="{ds}"{" class=on" if v == 30 else ""}><i style="--a:{1 - v / 100:.2f}"></i>{v}%</button>' for v, n, ds in SIM)
        sim = f'''<div class="sim" id="simulator"><p class="sim-label"><span class="dot"></span>DIVINE DETAILERS</p><h3>Window Tint <em>Simulator</em></h3>
<p class="sim-sub">Select a side window shade below</p>
<div class="sim-tabs"><button class="on" data-sim-tab="side">Side Windows</button><button data-sim-tab="wind">Windshield</button></div>
<div class="sim-view" id="simView" aria-hidden="true"><img class="sim-car sim-car-side" src="assets/tint/sim-side.webp" alt="" width="1200" height="675" loading="lazy"><img class="sim-car sim-car-front" src="assets/tint/sim-front.webp" alt="" width="1200" height="675" loading="lazy"><div class="sim-shade sim-side" id="simShade"></div><div class="sim-shade sim-wind"></div><div class="sim-badge"><b id="simBadge">30%</b><span id="simBadgeLabel">SIDE VLT</span></div></div>
<div class="sim-info"><b id="simTitle">30% VLT — Medium Tint</b><p id="simDesc">Balanced privacy with clear night visibility. A daily-driver favorite.</p></div>
<div class="sim-vlt" role="group" aria-label="Shade level">{btns}</div>
<p class="note"><b>Florida law:</b> Tint darkness limits differ by window and vehicle. We will confirm the legal options for your vehicle before we install anything.</p></div>'''
    faq = ""
    if d["faq"]:
        faq = '<section class="sec" id="faq"><div class="wrap"><div class="center"><span class="chip">FAQ</span><h2>Everything you wanted to <em>know</em></h2></div><div class="faq">' + "".join(faq_block(items) for _, items, _ in d["faq"]) + "</div></div></section>"
    ik, wk = SERVICE_PHOTOS[slug]
    bk = wk or ik
    band = (f'<div class="band has-photo" aria-hidden="true">{photo(bk, 1600, BAND_POS[bk], alt=False)}</div>' if bk else '<div class="band" aria-hidden="true"><span>Photo / video</span></div>')
    body = inner_hero(esc(title), d["sub"], ['<a href="index.html">Home</a>', '<a href="services.html">Services</a>', esc(title)], form=True, select=d["select"], hero=HERO_PHOTO.get(slug), status=False, video=HERO_VIDEO.get(slug))
    x = EXTRA[slug]
    hl = "".join(f'<div class="hl"><h3>{t}</h3><p>{a}</p><p>{c}</p></div>' for t, a, c in x["hl"])
    hl_intro = '<p class="hl-intro">' + x["hl_p"] + '</p>' if x.get("hl_p") else ""
    process = ''
    if x.get('proc'):
        pc = ''.join(f'<div class="hl"><h3>{t}</h3><p>{c}</p></div>' for t, c in x['proc'])
        process = f'<section class="sec hl-sec proc-sec"><div class="wrap"><h2 class="center">{x["proc_h"]}</h2><p class="hl-intro">{x["proc_p"]}</p><div class="hls">{pc}</div></div></section>'
    rows = ""
    for i, (kick, h2, p1, p2, key) in enumerate(x["rows"]):
        rev = " rev" if i % 2 else ""
        p2h = f"<p>{p2}</p>" if p2 else ""
        rows += f'<section class="feat{rev}"><div class="txt"><span class="kick">{kick}</span><h2>{h2}</h2><p>{p1}</p>{p2h}</div>{photo_box(key)}</section>'
    portfolio = f'<section class="sec"><div class="wrap center"><span class="chip">Our Portfolio</span><h2>Real vehicles. Real work. <em>Real results.</em></h2><div class="grid3">{photo_box("gblack")}{photo_box("urus")}{photo_box("ppf")}</div><div style="margin-top:44px"><a class="btn" href="projects.html">View More Projects</a></div></div></section>'
    body += f'''{stripes()}{partners()}
<section class="sec"><div class="wrap center"><span class="chip">Our Services</span><h2>Elevate your ride with expert <em>custom services</em></h2>
<p class="lead" style="margin-top:14px">From window tint to ceramic coating, our services enhance your ride&rsquo;s style, protection and performance. Trust our skilled team to deliver quality and luxury your car deserves.</p>
<div class="svc-slider"><div class="cards" style="text-align:initial">{cards}</div><button class="svc-btn prev" data-svc="-1" aria-label="Previous service">&#8249;</button><button class="svc-btn next" data-svc="1" aria-label="Next service">&#8250;</button></div></div></section><section class="cta-strip"><div class="btn-row"><a class="btn" href="tel:{SITE['tel']}"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg><b>Call Now</b><span>{SITE['phone']}</span></a><a class="btn gray" href="contact.html#quote"><span class="dot"></span>Get Your Free Quote</a></div></section>{cta_banner()}'''
    page("services.html", f"Our Services | {SITE['name']}", "Window tint, paint protection film, ceramic coating, paint correction, vinyl wraps and exterior detailing in Miami.", body, "services")

# ---------------------------------------------------------------- service pages
SERVICE_PAGES = {
 "window-tinting": dict(
    sub="Enhance privacy, reduce glare, and keep your interior cooler with tint installation.",
    pk_title="Tint package options", pk_sub="Browse our different package options.",
    packages=[("Two windows", ["Front driver side", "Front passenger side"]), ("Full tint", ["Front driver + passenger", "Rear driver + passenger"]), ("Windshield", ["Full windshield", "Extra protection"]), ("Sunvisor strip", ["Sun strip", "Reduces sun glare"])],
    impact_kick="The impact", impact_h="Cooler drives. Cleaner look.",
    impact_p="Miami&rsquo;s sunshine can heat up a cabin quickly. Premium ceramic window film stops heat before it builds up inside, so even after sitting in direct sun, the vehicle feels more comfortable for you and your passengers.",
    nums=[("60%", "Quality window tint significantly lowers interior temperatures during hot days. This improves comfort and reduces strain on your AC system."), ("99%", "Tint protects your interior materials from fading and cracking over time. It also protects your skin during long drives.")],
    tiles=[("Comfort", "Comfort", "Reduces interior heat and makes driving more enjoyable year-round."), ("Privacy", "Privacy", "Limits visibility into your vehicle while keeping clear visibility out."), ("Protection", "Protection", "Blocks harmful UV rays that damage interiors and skin."), ("Appearance", "Appearance", "Gives your vehicle a clean, finished and more refined look.")],
    why_h="Why trust Divine Detailers", why_p="Our certified installers cut film with precision and finish every job with a close final inspection before delivery. We use premium ceramic films with a manufacturer warranty, and we back our workmanship.",
    faq=[("Window tint", FAQ_TINT, "tint")], sim=True, select="Window Tint"),
 "paint-protection-film": dict(
    sub="Paint protection film guards your vehicle from rock chips, scratches and everyday road damage while keeping the original paint looking untouched.",
    pk_title="PPF package options", pk_sub="Browse our different package options.",
    packages=[("Partial Front", ["Partial front bumper", "Partial front hood"]), ("Full Front", ["Full bumper + hood", "Full fenders + mirrors"]), ("Track Package", ["Hood + fenders + bumper", "A-pillars + roof edges + mirrors"]), ("Full Protection", ["Full vehicle coverage", "Rear trunk + bumper"])],
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
    impact_kick="The impact", impact_h="Professional ceramic coating for long-term protection",
    impact_p="At Divine Detailers, we know that paint condition decides how well a coating bonds and how good the final gloss looks. Our installers carefully inspect the vehicle, prepare the surface and apply the ceramic coating for long-lasting protection built for Miami&rsquo;s sun, rain and humidity.",
    nums=[("90%", "Ceramic coating helps block most dirt, grime and environmental fallout from bonding to your paint."), ("80%", "The coating reduces the sun exposure that causes fading and oxidation over time.")],
    tiles=[("Gloss", "Deep shine", "Adds depth and clarity that wax cannot match."), ("Hydrophobic", "Sheds water", "Water beads and rolls off, carrying dirt with it."), ("Protection", "UV and chemicals", "Resists fading, oxidation and acid rain."), ("Easy care", "Faster washes", "Contaminants release easily so the paint stays cleaner.")],
    why_h="Why ceramic coating is worth it", why_p="A ceramic coating doesn&rsquo;t replace regular washing. It makes routine care easier and helps your vehicle keep a sleek look between washes. For ceramic coating installation, book an appointment with Divine Detailers in Miami. We combine careful prep and premium products with workmanship we stand behind, so you are happy with the end result.",
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
    rows=[("Comfort", "Cooler drives in Miami's sun", "Premium ceramic window film stops solar heat before it warms the cabin. Seats, steering wheel and dash stay more comfortable after the car sits in the sun.", "Because the film has no metal in it, GPS, phone and radio signals keep working normally.", "tgarage"),
          ("Protection", "Protect your interior and your skin", "UV rays fade and crack leather, plastics and upholstery over time. Quality film blocks nearly all of them, so your interior keeps its color and feel.", "The same film helps hold glass together and reduces glare for safer, less tiring driving.", "tmirror"),
          ("Style", "A cleaner, more finished look", "Tint changes how a vehicle looks from the first glance. We help you pick a shade that fits your style and stays within legal limits for each window.", "Every piece is cut to fit and installed in a clean bay, then inspected before you drive away.", "tint")]),
 "paint-protection-film": dict(
    hl_h="Defend your paint from day one.",
    hl=[("Chip protection", "Absorbs rock chips and road debris", "Keeps paint intact where it counts"), ("Self-healing", "Light marks fade with warmth", "Stays smooth and glossy"), ("Invisible look", "Clear, gloss or satin finishes", "Your color shows through"), ("Long-lasting", "Built for years of daily driving", "Backed by a manufacturer warranty")],
    rows=[("Protect", "Take the hit so your paint doesn't", "Paint protection film is a thick, clear urethane that sits over your paint. Chips, scratches and stains land on the film instead of the finish.", "The most-hit areas are the front bumper, hood, fenders and mirrors, and that is where most owners start.", "p2"),
          ("Preserve", "Keep the factory finish like new", "Protected paint holds its gloss and color, and the car keeps stronger resale appeal. When the film's time is up, a pro can remove it and the paint underneath is untouched.", "Add a ceramic coating on top and the film is easier to wash and resists water spots.", "q1"),
          ("Customize", "Gloss, satin or even color", "Choose a clear gloss film to keep the factory look, a satin film for a matte-style finish, or a colored film to change the look while protecting the paint.", "We will recommend the right coverage and film for your car and how you drive.", "q3")]),
 "ceramic-coating": dict(
    hl_h="Why get ceramic coating.",
    hl_p="Divine Detailers provides ceramic coating installation in Miami for drivers who want lasting shine and easy exterior maintenance. The coating bonds to the paint and forms a slick surface that releases water, dirt and more during routine washing. The refined finish gives your vehicle a strong defensive layer against UV exposure and everyday buildup.",
    hl=[("Maximum protection", "Lasting UV protection", "Keeping your car cleaner for longer"), ("Long-lasting durability", "Superior UV protection", "Clean and vibrant longer"), ("Hydrophobic coating", "Advanced nanotechnology", "Reducing stains and buildup"), ("Glossy finish that turns heads", "Enhances your vehicle&rsquo;s finish", "Effortlessly polished look")],
    rows=[("Ceramic coating", "What it protects against", "Ceramic coating helps resist dirt, road grime, bird droppings, water spots and environmental fallout. This reduces staining and surface damage that normally affects unprotected paint.", "", "c4"),
          ("Ceramic coating", "How it improves appearance", "The coating enhances gloss and adds noticeable depth to your paint&rsquo;s color and reflections. Your vehicle keeps a freshly detailed look for much longer.", "", "c1"),
          ("Ceramic coating", "Maintenance becomes easier", "Water, mud and debris have a harder time sticking to the coated surface. This makes washing faster and keeps the vehicle cleaner between washes.", "", "gt3"),
          ("Ceramic coating", "How long it lasts", "With proper care, ceramic coating provides long-term protection that holds up against daily driving and weather exposure. It is designed to maintain its performance and appearance for years.", "", "c2")],
    proc_h="Our ceramic coating process",
    proc_p="In our shop, we wash, decontaminate and evaluate the paint before any coating goes on. This step removes surface buildup and gives the coating a clean foundation. Our installers then apply the coating in controlled sections to support even coverage and a smooth finish.",
    proc=[("Surface preparation", "We fully clean and decontaminate the paint to remove anything that could prevent proper bonding."), ("Paint correction", "Swirl marks and light imperfections are polished out to create a flawless surface before coating."), ("Coating application", "The ceramic is applied evenly in controlled sections for complete and consistent coverage."), ("Final inspection", "We inspect the entire vehicle under professional lighting to make sure the finish is perfect.")]),
 "paint-correction": dict(
    hl_h="Real defects removed, not filled.",
    hl=[("Inspect", "Measure paint and check under lights", "We find what is really there"), ("Cut", "Remove swirls, scratches and etching", "Only as much as the paint needs"), ("Refine", "Polish to a deep, clear finish", "Maximum gloss and clarity"), ("Protect", "Finish with sealant, coating or film", "Keep the result looking new")],
    rows=[("Correct", "Restore the gloss you paid for", "Everyday washing, dust and water spots leave fine marks that dull the paint. Machine polishing levels the clear coat so those marks are gone, not hidden.", "We only correct as much as your paint needs, and we tell you honestly what polishing can and can't fix.", "polish"),
          ("Prepare", "The best base for coating or film", "A flawless surface is the first step before ceramic coating or paint protection film, since both lock in whatever is under them.", "Many customers combine correction with a coating for a finish that lasts.", "pc1"),
          ("Enjoy", "Paint that looks new again", "After correction, color looks richer and reflections look sharper. It is the biggest visual change you can make without repainting.", "", "pc5")]),
 "vinyl-wraps": dict(
    hl_h="Customize your vehicle color today.",
    hl=[("Preparation", "Deep clean and panel decontamination", "A perfect base for adhesion"), ("Precision install", "Seamless wrapping across curves and edges", "A paint-like finish"), ("After install", "Heat-set edges and final inspection", "A clean, tight finish built to last"), ("Care guidance", "Washing and maintenance tips", "Keep the color vibrant")],
    rows=[("Protect", "Shields your factory paint", "A wrap takes the beating from road debris, light scratches and weather, so the paint underneath stays in better shape.", "That added layer also helps resale when the wrap is removed.", None),
          ("Customize", "Colors and finishes without limits", "Gloss, satin, matte, metallic or color-shift: vinyl gives you looks that would be costly or impossible with paint, and it can be changed later.", "You can go for a bold full color change or just add accents.", None),
          ("Maintain", "Simple to care for", "Wrapped vehicles are easy to wash, and with proper care the color depth and finish stay fresh for years.", "We'll explain what to use and what to avoid.", None)]),
 "exterior-detailing": dict(
    hl_h="Clean paint, properly cared for.",
    hl=[("Safe wash", "Lubricated hand washing", "Keeps swirls out of the paint"), ("Decontamination", "Iron and clay treatment", "Removes what washing leaves behind"), ("Protection", "Sealant or wax", "Keeps the shine and eases the next wash"), ("Finishing", "Wheels, trim, glass, door jambs", "Every detail handled")],
    rows=[("Wash", "A wash that protects your paint", "Most paint damage starts with a bad wash. We use controlled, gentle methods that lift dirt away instead of grinding it in.", "The result is a clean surface that is ready for protection.", "dw"),
          ("Decon", "Deep clean beyond the wash", "Iron remover and clay treatment lift the embedded contamination that makes paint feel rough and look dull.", "It is also the right first step before correction, coating or film.", "df"),
          ("Maintain", "Keep it looking its best", "Regular maintenance details keep coatings performing and paint glossy, so small problems never turn into big ones.", "Ask us about a maintenance schedule that fits your car.", "dh")]),
}

SIM = [(5, "Limo tint", "Maximum privacy. Very dark, best for rear windows where legal."),
       (15, "Dark tint", "Strong privacy with a bold look. Check legal limits for your windows."),
       (30, "Medium tint", "Balanced privacy with clear night visibility. A daily-driver favorite."),
       (50, "Light tint", "Subtle look with strong heat and UV protection. Easy night driving."),
       (70, "Clear heat-rejection", "Nearly invisible film that still cuts heat and blocks UV.")]

def build_service(slug, title, short):
    d = SERVICE_PAGES[slug]
    PIMG_ALL = {"window-tinting": ("tint", {"Two windows": "two-windows", "Full tint": "full-tint", "Windshield": "windshield", "Sunvisor strip": "sunvisor-strip"}),
                "paint-protection-film": ("ppf", {"Partial Front": "highway", "Full Front": "full-front", "Track Package": "individual-panels", "Full Protection": "full-body"})}
    PDIR, PIMG = PIMG_ALL.get(slug, ("", {}))
    pimg = lambda t: (f'<div class="pimg"><img src="assets/{PDIR}/{PIMG[t]}.webp" alt="{t} package at the Divine Detailers shop" width="960" height="559" loading="lazy"></div>' if t in PIMG else '')
    pk = "".join(f'<div class="pkg">{pimg(t)}<h3>{t}</h3><ul>{"".join(f"<li>{i}</li>" for i in items)}</ul></div>' for t, items in d["packages"])
    nums = "".join(f'<div><b>{n}</b><span>{l}</span></div>' for n, l in d["nums"])
    tiles = "".join(f'<div class="tile"><span class="kick">{k}</span><h3>{h}</h3><p>{p}</p></div>' for k, h, p in d["tiles"])
    sim = ""
    if d.get("sim"):
        btns = "".join(f'<button data-vlt="{v}" data-name="{n}" data-desc="{ds}"{" class=on" if v == 30 else ""}><i style="--a:{1 - v / 100:.2f}"></i>{v}%</button>' for v, n, ds in SIM)
        sim = f'''<div class="sim" id="simulator"><p class="sim-label"><span class="dot"></span>DIVINE DETAILERS</p><h3>Window Tint <em>Simulator</em></h3>
<p class="sim-sub">Select a side window shade below</p>
<div class="sim-tabs"><button class="on" data-sim-tab="side">Side Windows</button><button data-sim-tab="wind">Windshield</button></div>
<div class="sim-view" id="simView" aria-hidden="true"><img class="sim-car sim-car-side" src="assets/tint/sim-side.webp" alt="" width="1200" height="675" loading="lazy"><img class="sim-car sim-car-front" src="assets/tint/sim-front.webp" alt="" width="1200" height="675" loading="lazy"><div class="sim-shade sim-side" id="simShade"></div><div class="sim-shade sim-wind"></div><div class="sim-badge"><b id="simBadge">30%</b><span id="simBadgeLabel">SIDE VLT</span></div></div>
<div class="sim-info"><b id="simTitle">30% VLT — Medium Tint</b><p id="simDesc">Balanced privacy with clear night visibility. A daily-driver favorite.</p></div>
<div class="sim-vlt" role="group" aria-label="Shade level">{btns}</div>
<p class="note"><b>Florida law:</b> Tint darkness limits differ by window and vehicle. We will confirm the legal options for your vehicle before we install anything.</p></div>'''
    faq = ""
    if d["faq"]:
        faq = '<section class="sec" id="faq"><div class="wrap"><div class="center"><span class="chip">FAQ</span><h2>Everything you wanted to <em>know</em></h2></div><div class="faq">' + "".join(faq_block(items) for _, items, _ in d["faq"]) + "</div></div></section>"
    ik, wk = SERVICE_PHOTOS[slug]
    bk = wk or ik
    band = (f'<div class="band has-photo" aria-hidden="true">{photo(bk, 1600, BAND_POS[bk], alt=False)}</div>' if bk else '')
    if slug == "window-tinting":
        feats = "".join(f'<div class="cf"><h3>{h}</h3><p>{p}</p></div>' for _, h, p in d["tiles"])
        band = f'''<section class="cpp"><div class="cpp-img">{photo("tdoor", 1600, "50% 45%", alt=True)}</div><div class="cpp-txt"><h2>Comfort, privacy, and protection</h2><p>We install premium ceramic window film that rejects heat, cuts glare and blocks harmful UV rays, so every drive in Miami&rsquo;s sun feels cooler and more comfortable.</p><div class="cfs">{feats}</div></div></section>'''
    benefits = "" if slug in ("window-tinting", "ceramic-coating") else f'''<section class="sec" style="padding-top:0"><div class="wrap center"><span class="chip">Benefits</span><h2>Comfort, protection and <em>style</em></h2><div class="tiles" style="text-align:initial">{tiles}</div></div></section>'''
    pk_section = "" if slug == "ceramic-coating" else f'''<section class="sec pk-sec"><div class="pk-head"><h2>{d["pk_title"]}</h2><p>{d["pk_sub"]}</p></div>
<div class="pkgs">{pk}</div>{sim}</section>'''
    body = inner_hero(esc(title), d["sub"], ['<a href="index.html">Home</a>', '<a href="services.html">Services</a>', esc(title)], form=True, select=d["select"], hero=HERO_PHOTO.get(slug), status=False, video=HERO_VIDEO.get(slug), book=BOOK_URL.get(slug))
    x = EXTRA[slug]
    hl = "".join(f'<div class="hl"><h3>{t}</h3><p>{a}</p><p>{c}</p></div>' for t, a, c in x["hl"])
    hl_intro = '<p class="hl-intro">' + x["hl_p"] + '</p>' if x.get("hl_p") else ""
    process = ''
    if x.get('proc'):
        pc = ''.join(f'<div class="hl"><h3>{t}</h3><p>{c}</p></div>' for t, c in x['proc'])
        process = f'<section class="sec hl-sec proc-sec"><div class="wrap"><h2 class="center">{x["proc_h"]}</h2><p class="hl-intro">{x["proc_p"]}</p><div class="hls">{pc}</div></div></section>'
    rows = ""
    for i, (kick, h2, p1, p2, key) in enumerate(x["rows"]):
        rev = " rev" if i % 2 else ""
        p2h = f"<p>{p2}</p>" if p2 else ""
        rows += f'<section class="feat{rev}{"" if key else " noimg"}"><div class="txt"><span class="kick">{kick}</span><h2>{h2}</h2><p>{p1}</p>{p2h}</div>{photo_box(key) if key else ""}</section>'
    portfolio = f'<section class="sec"><div class="wrap center"><span class="chip">Our Portfolio</span><h2>Real vehicles. Real work. <em>Real results.</em></h2><div class="grid3">{photo_box("gblack")}{photo_box("urus")}{photo_box("ppf")}</div><div style="margin-top:44px"><a class="btn" href="projects.html">View More Projects</a></div></div></section>'
    video = ""
    if slug == "window-tinting":
        video = f'''<section class="sec vid-sec"><div class="wrap"><div class="split"><div><span class="chip">Watch it done</span><h2>See a tint install <em>start to finish</em></h2><p>Every film is cut to fit, applied wet and squeegeed flat in a clean bay. Watch how our installers handle the glass on a real car.</p><p><a class="btn" href="contact.html#quote">Get a Quote</a></p></div><div class="vid"><video controls playsinline preload="none" poster="assets/video/tint-install-poster.webp" width="540" height="960"><source src="assets/video/tint-install.mp4" type="video/mp4"></video></div></div></div></section>'''
    body += f'''{stripes()}{partners()}
<section class="sec hl-sec"><div class="wrap"><h2 class="center">{x["hl_h"]}</h2>{hl_intro}<div class="hls">{hl}</div></div></section>
{pk_section}{stripes()}{band}{stripes() if band else ""}
<section class="sec impact-sec"><div class="wrap"><div class="split{"" if ik else " noimg"}"><div><span class="chip">{d["impact_kick"]}</span><h2>{d["impact_h"]}</h2><p>{d["impact_p"]}</p><div class="bignum">{nums}</div></div>{photo_box(ik) if ik else ""}</div></div></section>
{process}{benefits}
<section class="sec"><div class="wrap"><div class="split{"" if WHY_PHOTO.get(slug, wk) else " noimg"}">{photo_box(WHY_PHOTO.get(slug, wk)) if WHY_PHOTO.get(slug, wk) else ""}<div><span class="chip">Why trust us</span><h2>{d["why_h"]}</h2><p>{d["why_p"]}</p><p><a class="btn" href="contact.html#quote">Get a Quote</a></p></div></div></div></section>
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
    # (category, file stem in assets/projects, title, alt)
    # (categories (space separated, first one is shown), file stem, title, alt, narrated)
    vids = PROJECT_VIDS
    grid = "".join(vtile(*v) for v in vids)
    _old = "".join(
        f'<button class="vtile" type="button" data-cat="{c}" data-src="assets/projects/{n}.mp4" data-prev="assets/projects/{n}-p.mp4" data-title="{t}" aria-label="Play video: {t}">'
        f'<img src="assets/projects/{n}.webp" alt="{a}" width="480" height="853" loading="lazy" decoding="async">'
        f'<video muted loop playsinline preload="none" tabindex="-1" aria-hidden="true"></video>'
        f'<span class="vplay" aria-hidden="true"></span>{"<span class=vsound>Sound on</span>" if talk else ""}<span class="vcap"><i>{c.replace(" "," · ")}</i>{t}</span></button>'
        for c, n, t, a, talk in vids)
    grid += VMODAL
    body = inner_hero("Our recent <em>projects</em>", "Explore real vehicles completed in our shop featuring paint protection film, vinyl wraps, ceramic coating, tint and detailing.", ['<a href="index.html">Home</a>', "Projects"], form=True)
    body += f'''{stripes()}<section class="sec"><div class="wrap center"><span class="chip">Explore more of our projects</span><h2>Vehicles we&rsquo;ve <em>completed</em></h2>
<div class="filters" role="group" aria-label="Filter projects">{f}</div><div class="vgrid" id="projectGrid">{grid}</div></div></section>{cta_banner()}'''
    page("projects.html", f"Our Projects | {SITE['name']}", "Recent vehicles completed by Divine Detailers in Miami.", body, "projects")

def build_about():
    body = f'''<section class="about-hero"><div class="wrap"><span class="chip">About us</span>
<h1><span class="dim">Crafting custom</span> automotive experiences</h1>
<div class="ah-row"><p>At {SITE['name']}, we&rsquo;re passionate about turning your vehicle into a reflection of your unique style. With over 20 years of experience, our dedicated team specializes in window tint, paint protection film, ceramic coating, paint correction, vinyl wraps and detailing that elevate both the appearance and protection of your car.</p>
<a class="btn" href="contact.html#quote"><span class="dot"></span>Get Your Free Quote</a></div></div></section>'''
    vals = [("Craft first", "Every film is cut, every panel is prepped and every finish is checked by hand. We take the time to do it right the first time."),
            ("Honest advice", "We tell you what your car actually needs, and what it does not. You get a clear quote before any work starts."),
            ("Protected for Miami", "Sun, salt air, storms and traffic are hard on paint and glass. We choose products and finishes built for exactly that."),
            ("Backed by a guarantee", "Every vehicle gets a careful inspection before it goes home, and our work is backed by a workmanship guarantee.")]
    vh = "".join(f'<div class="hl"><h3>{t}</h3><p>{p}</p></div>' for t, p in vals)
    svc = "".join(f'<a class="scard-lite" href="{s}.html"><h3>{t}</h3><p>{d}</p></a>' for s, t, d in SERVICES)
    body += f'''{stripes()}
<section class="sec"><div class="wrap"><div class="split"><div><span class="chip">Our story</span><h2>Built on <em>craft</em></h2><p>{SITE['name']} is a Miami shop focused on protecting and perfecting vehicles. With more than 20 years of experience behind our work, we have completed over 5,000 vehicles, from daily drivers to exotics and show cars.</p><p>We do window tint, paint protection film, ceramic coating, paint correction, vinyl wraps and exterior detailing under one roof, so one team looks after your car from the first wash to the final coat. Our customers find us through word of mouth and Instagram, and they keep coming back, which is why we hold a 4.9-star Google rating.</p><p><a class="btn" href="contact.html#quote">Get a Quote</a></p></div>{photo_box("svan")}</div></div></section>
<section class="stats"><div class="stat"><b>5000+</b><span>Vehicles completed</span></div><div class="stat"><b>20+</b><span>Years of experience</span></div><div class="stat"><b>4.9★</b><span>Google rating</span></div></section>
<section class="feat"><div class="txt"><span class="kick">Our mission</span><h2>Correction, protection, reflection</h2><p>Our mission is simple: make every car look its best and keep it that way. We correct what time and traffic have done to the paint, protect it with the right film or coating, and finish it so the reflection shows the difference.</p><p>You can expect a clean shop, clear communication and results we are proud to put our name on, every time you bring a car in.</p></div>{photo_box("pc3")}</section>
<section class="sec hl-sec"><div class="wrap"><h2 class="center">What we stand for</h2><div class="hls">{vh}</div></div></section>
<section class="feat rev"><div class="txt"><span class="kick">We come to you</span><h2>Mobile detailing across Miami</h2><p>Cannot spare the day? Our wrapped detailing van brings the shop to your home or office, with the water, power and products to wash, detail and coat your car on site.</p><p>Call us at <a href="tel:{SITE['tel']}">{SITE['phone']}</a> to book a mobile appointment.</p></div>{photo_box("dv")}</section>
<section class="sec"><div class="wrap center"><span class="chip">What we do</span><h2>Everything your car <em>needs</em></h2><div class="svc-links">{svc}</div></div></section>
<section class="sec"><div class="wrap center"><span class="chip">Visit us</span><h2>Find the shop</h2><p class="lead" style="margin-top:14px">{SITE['addr1']}, {SITE['addr2']}<br>Call <a href="tel:{SITE['tel']}">{SITE['phone']}</a> or <a href="mailto:{SITE['email']}">{SITE['email']}</a></p><p style="margin-top:22px"><a class="btn" href="contact.html">Contact us</a></p></div></section>{cta_banner()}'''
    page("about-us.html", f"About Us | {SITE['name']}", f"Learn about {SITE['name']}, a Miami vehicle protection and detailing shop with 20+ years of experience and 5000+ vehicles completed.", body, "about")

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
    ex = '<label class="full">Message*<textarea name="message" rows="4" placeholder="Tell us about your vehicle and what you need" required></textarea></label>'
    body = ''
    body += f'''<section id="quote" style="padding-top:10px"><div class="contact-split"><div><span class="chip">Get quote</span><h2>Get your free <em>quote now!</em></h2><p class="lead" style="margin:14px 0 26px;max-width:none">Tell us about your vehicle and what you want done. We will reply with a quote and next steps.</p>{quote_form(extra=ex)}</div>
<div><span class="chip">Visit us</span><h2>Find the <em>shop</em></h2><ul class="info" style="margin-top:26px"><li><b>Address</b>{SITE['addr1']}<br>{SITE['addr2']}</li><li><b>Hours</b>{SITE['hours'][0]}<br>{SITE['hours'][1]}</li><li><b>Call</b><a href="tel:{SITE['tel']}">{SITE['phone']}</a></li><li><b>Email</b><a href="mailto:{SITE['email']}">{SITE['email']}</a></li></ul>
{cmap[0]}
<p style="margin-top:14px"><a class="btn gray sm" href="{cmap[2]}" target="_blank" rel="noopener">Get Directions</a></p></div></div></section>
<section class="sec" id="faq"><div class="wrap"><div class="center"><span class="chip">FAQ</span><h2>Everything you wanted to know <em>before looking up.</em></h2>{jump}</div><div class="faq">{faq}</div></div></section>{cta_banner()}'''
    page("contact.html", f"Request a Quote | {SITE['name']}", "Request a free quote for window tint, PPF, ceramic coating and more in Miami.", body, "contact")

def build_privacy():
    body = inner_hero("Privacy <em>policy</em>", "Last updated: October 2026", ['<a href="index.html">Home</a>', "Privacy Policy"], buttons=False)
    n = SITE['name']
    body += f'''<section class="sec"><div class="wrap"><article class="article legal">
<p>At {n} (the &ldquo;Company&rdquo; or &ldquo;We&rdquo;), we respect your privacy and are committed to protecting it through our compliance with this policy. This policy describes the types of information we may collect from you or that you may provide when you visit this website and our practices for collecting, using, maintaining, protecting, and disclosing that information.</p>
<p>Please read this policy carefully. If you do not agree with our policies and practices, your choice is not to use our Website. By accessing or using this Website, you agree to this privacy policy. This policy may change from time to time. Your continued use of this Website after we make changes is deemed to be acceptance of those changes.</p>
<h2>Children Under the Age of 13</h2><p>Our Website is not intended for children under 13 years of age. No one under age 13 may provide any personal information on the Website. We do not knowingly collect personal information from children under 13. If we learn we have collected personal information from a child under 13 without parental consent, we will delete that information. If you believe we might have any information from or about a child under 13, please contact us.</p>
<h2>Information We Collect About You</h2><p>We collect several types of information from and about users of our Website, including your name, email address, phone number, and vehicle information when you fill out a quote or contact form. We also collect technical data such as IP address, browser type, and pages visited through cookies and analytics tools.</p>
<h2>SMS and Text Message Communications</h2>
<h3>A2P SMS Consent Notice</h3>
<p>By submitting a quote request or contact form on this Website, you consent to receive SMS text messages from {n} at the phone number you provide. These messages may include appointment confirmations, service updates, and promotional offers.</p>
<p>Message and data rates may apply. Message frequency may vary. Reply STOP at any time to unsubscribe. Reply HELP for assistance.</p>
<p>You are not required to consent to receive SMS messages as a condition of purchasing any goods or services from {n}.</p>
<p>We use a third-party SMS messaging platform to send text messages. Your phone number will not be shared with third parties for their own marketing purposes. All SMS communications comply with A2P 10DLC registration requirements set by U.S. mobile carriers.</p>
<h2>Automatic Data Collection Technologies</h2><p>As you navigate through our Website, we may use automatic data collection technologies including cookies, Flash cookies, and web beacons to collect information about your equipment, browsing actions, and patterns. This information helps us improve our Website, estimate audience size, store your preferences, and recognize you when you return.</p>
<h2>Third-Party Use of Cookies and Tracking Technologies</h2><p>Some content or applications on the Website may be served by third parties including advertisers and analytics providers. These third parties may use cookies or web beacons to collect information about you. We do not control these third parties&rsquo; tracking technologies. If you have questions about targeted content, please contact the responsible provider directly.</p>
<h2>How We Use Your Information</h2><p>We use the information we collect to respond to your service inquiries, send appointment confirmations and service updates, send promotional communications if you have opted in, improve our Website, carry out our contractual obligations, and fulfill any other purpose for which you provide the information.</p>
<h2>Disclosure of Your Information</h2><p>We do not sell, trade, or rent your personal information to third parties for their own marketing purposes. We may disclose your information to service providers who support our business under confidentiality obligations, to comply with legal requirements, or to protect the rights and safety of {n}, our customers, or others.</p>
<h2>Call Tracking and Recording</h2><p>We use a call tracking service so we can see which of our marketing brings in phone calls. When you call the number shown on our Website, the service may record the call, your phone number, the time and length of the call, and the page or ad that led you to us. Calls may be recorded or monitored for quality and training purposes. If we record a call, we will tell you at the start of the call.</p>
<h2>Advertising and Analytics</h2><p>We use Google Analytics and Google Ads to understand how visitors use our Website and to measure whether our advertising works. These services use cookies and similar technologies, and may receive information such as the page you visited, the ad you clicked, and your approximate location. When you send us a request, we may match the information you give us (such as your phone number or email) with the ad that brought you to us, to measure results. You can learn more about how Google uses information at <a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noopener">policies.google.com/technologies/partner-sites</a> and opt out of ad personalization in your Google account settings.</p>
<h2>Your Choices</h2><ul><li><strong>Email.</strong> You may unsubscribe from marketing emails at any time by clicking the unsubscribe link in any email we send.</li><li><strong>SMS.</strong> You may opt out of text messages at any time by replying STOP to any message from us.</li><li><strong>Cookies.</strong> You can set your browser to refuse cookies, though some Website functionality may be affected.</li></ul>
<h2>Accessing and Correcting Your Information</h2><p>You may contact us to request access to, correction of, or deletion of any personal information you have provided to us. We may not accommodate a request to change information if we believe the change would violate any law or legal requirement.</p>
<h2>California Privacy Rights</h2><p>California Civil Code Section 1798.83 permits users who are California residents to request certain information regarding our disclosure of personal information to third parties for their direct marketing purposes. To make such a request, please contact us using the information below.</p>
<h2>Data Security</h2><p>We have implemented measures designed to secure your personal information from accidental loss and from unauthorized access, use, alteration, and disclosure. However, the transmission of information via the internet is not completely secure. Any transmission of personal information is at your own risk.</p>
<h2>Changes to Our Privacy Policy</h2><p>We will post any changes to our privacy policy on this page with an updated revision date. You are responsible for periodically visiting this page to check for any changes.</p>
<div class="legal-card"><h2>Contact Us</h2><p>If you have any questions about this privacy policy, please contact us:</p><p><strong>{n}</strong></p><p><a href="mailto:{SITE['email']}">{SITE['email']}</a></p><p><a href="tel:{SITE['tel']}">{SITE['phone']}</a></p><p class="small">{SITE['addr1']}, {SITE['addr2']}</p><p class="small">Thank you for visiting {n}.</p></div></article></div></section>
<div class="ticker" aria-hidden="true"><div class="ticker-run">{"<span>Contact us <i>&#8600;</i></span>"*16}</div></div>
<section class="sec"><div class="wrap">{map_block()[0]}</div></section>''' + cta_banner()
    page("privacy-policy.html", f"Privacy Policy | {n}", "Divine Detailers privacy policy.", body)

def build_terms():
    body = inner_hero("Terms of <em>service</em>", "Last updated: October 2026", ['<a href="index.html">Home</a>', "Terms of Service"], buttons=False)
    n = SITE['name']
    body += f'''<section class="sec"><div class="wrap"><article class="article legal">
<p>These Terms of Service (&ldquo;Terms&rdquo;) apply to your use of the {n} website (the &ldquo;Website&rdquo;) and to quotes, bookings and services requested through it. By using the Website or requesting a quote, you agree to these Terms. If you do not agree, please do not use the Website.</p>
<h2>About Us</h2><p>{n} provides window tint, paint protection film (PPF), ceramic coating, paint correction, vinyl wrap and detailing services at our shop in {SITE['addr2']}.</p>
<h2>Quotes and Estimates</h2><p>Quotes and estimates given through the Website, by phone, text or email are based on the information you provide, such as the vehicle, the service and its condition. They are not a binding offer. The final price and scope are confirmed in writing before work begins, and may change if the vehicle&rsquo;s condition or your requested work differs from what was described.</p>
<h2>Booking and Appointments</h2><p>An appointment is confirmed only when we confirm it with you. Please give us as much notice as you can if you need to cancel or reschedule. Any deposit, cancellation or rescheduling terms will be stated in your quote or booking confirmation.</p>
<h2>Services and Warranties</h2><p>Coatings, films and tint carry the manufacturer&rsquo;s warranty that applies to the product installed, and we stand behind our own workmanship. The specific warranty and care instructions for your service will be given to you with your quote or invoice. Warranties do not cover damage caused by accidents, misuse, improper washing or care, or work done by others.</p>
<h2>Your Vehicle</h2><p>You confirm that you own the vehicle or are authorized to request work on it. Please remove valuables before drop-off. We take reasonable care of every vehicle in our shop, and will tell you promptly if we find damage or a pre-existing condition that affects the work.</p>
<h2>Payment</h2><p>Payment terms are stated in your quote or invoice. Payment is due when the work is complete unless we agree otherwise in writing.</p>
<h2>Calls, Texts and Emails</h2><p>If you submit a form or call us, you agree that we may contact you by phone, text message or email about your request. Message and data rates may apply, and you can reply STOP to any text to opt out. Calls to and from us may be recorded or monitored for quality and training, and we will tell you at the start of the call if it is being recorded. See our <a href="privacy-policy.html">Privacy Policy</a> for how we handle your information.</p>
<h2>Using the Website</h2><p>You agree to use the Website only for lawful purposes and to give accurate information in any form. You must not attempt to disrupt the Website, access it without permission, or use it to send spam or harmful content.</p>
<h2>Content and Intellectual Property</h2><p>The text, photos, videos, logos and design on the Website belong to {n} or are used with permission. You may not copy or reuse them without our written permission.</p>
<h2>Disclaimers</h2><p>The Website and its content are provided &ldquo;as is&rdquo; for general information. Photos and videos of past work are examples, and results vary with the vehicle, the product and how it is cared for. We do not guarantee that the Website will always be available or free of errors.</p>
<h2>Limitation of Liability</h2><p>To the fullest extent allowed by law, {n} is not liable for indirect, incidental or consequential damages arising from your use of the Website. Our liability for services is limited to the amount you paid for the service in question, except where the law does not allow that limit.</p>
<h2>Governing Law</h2><p>These Terms are governed by the laws of the State of Florida, and any dispute will be handled in the courts located in Miami-Dade County, Florida.</p>
<h2>Changes to These Terms</h2><p>We may update these Terms from time to time. The updated version will be posted on this page with a new date, and applies from the date it is posted.</p>
<div class="legal-card"><h2>Contact Us</h2><p>Questions about these Terms? Contact us:</p><p><strong>{n}</strong></p><p><a href="mailto:{SITE['email']}">{SITE['email']}</a></p><p><a href="tel:{SITE['tel']}">{SITE['phone']}</a></p></div>
</article></div></section>
<div class="ticker" aria-hidden="true"><div class="ticker-run">{"<span>Contact us <i>&#8600;</i></span>"*16}</div></div>
<section class="sec"><div class="wrap">{map_block()[0]}</div></section>''' + cta_banner()
    page("terms.html", f"Terms of Service | {n}", "Divine Detailers terms of service.", body)

FAQ_WRAP = [
    ("How long does a vinyl wrap last?", "With proper care, a quality wrap commonly lasts several years. Climate, parking and how the car is washed all affect how long it looks its best."),
    ("Will a wrap damage my paint?", "A wrap installed over sound factory paint protects it rather than harming it. Paint that is already damaged or poorly repainted can lift when the film is removed, so we inspect the paint first."),
    ("How do I wash a wrapped car?", "Hand wash with a gentle pH-neutral soap and a clean microfiber mitt. Avoid pressure washing close to the edges and skip automatic brush washes."),
    ("Can a wrap be removed?", "Yes. Vinyl can be removed and the paint underneath is usually left in good condition, which is one reason people choose a wrap over a repaint."),
    ("How do I choose a color and finish?", "Bring your ideas or a reference photo. We will show you gloss, satin, matte, metallic and color-shift options and help you pick what suits the car."),
]
FAQ_DETAIL = [
    ("What is included in an exterior detail?", "A safe hand wash, decontamination, drying and a protective finish such as a sealant or wax. We tailor the steps to the condition of your paint."),
    ("How often should I get my car detailed?", "Many owners book a maintenance detail every few weeks to a few months, depending on how the car is driven, stored and what protection is already on the paint."),
    ("Why does hand washing matter?", "Most swirl marks come from poor washing. A lubricated, controlled hand wash keeps dirt from being ground into the clear coat."),
    ("Do you offer mobile detailing?", "Yes. Our wrapped detailing van can come to your home or office. Call us to book a mobile appointment."),
    ("Will detailing remove scratches?", "A detail cleans and protects the paint but does not remove defects. Swirls and scratches need paint correction, and we can add it after a detail if the paint needs it."),
]
THANKS_SERVICES = [
    ("Window Tint", "window-tinting", "Tint", "window tint", FAQ_TINT),
    ("PPF / Clear Bra", "paint-protection-film", "PPF", "paint protection film", FAQ_PPF),
    ("Ceramic Coating", "ceramic-coating", "Ceramic", "ceramic coating", FAQ_CERAMIC),
    ("Paint Correction", "paint-correction", "Correction", "paint correction", FAQ_CORRECTION),
    ("Vinyl Wraps", "vinyl-wraps", "Wraps", "vinyl wraps", FAQ_WRAP),
    ("Exterior Detailing", "exterior-detailing", "Detailing", "exterior detailing", FAQ_DETAIL),
    ("Other", "services", "", "our services", GENERAL_FAQ),
]

def build_thanks():
    ico = '''<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>'''
    blocks = ""
    for opt, slug, cat, label, faqs in THANKS_SERVICES:
        pool = [v for v in PROJECT_VIDS if cat in v[0].split()] if cat else []
        if not pool:  # "Other": a taste of everything
            seen, pool = set(), []
            for v in PROJECT_VIDS:
                k = v[0].split()[0]
                if k not in seen and v[4]:
                    seen.add(k); pool.append(v)
        pool = sorted(pool, key=lambda v: not v[4])[:4]  # narrated clips first
        tiles = "".join(vtile(*v, still=True) for v in pool)
        faq = "".join(f"<details><summary>{esc(q)}</summary><p>{esc(a)}</p></details>" for q, a in faqs[:6])
        page_link = f'<a class="btn gray" href="{slug}.html">More about {label}</a>' if slug != "services" else '<a class="btn gray" href="services.html">Browse all services</a>'
        blocks += (f'<div class="th-svc" data-svc="{esc(opt)}"{"" if opt == "Other" else " hidden"}>'
                   f'<section class="sec" style="padding-top:0"><div class="wrap center"><span class="chip">While you wait</span><h2>{"See our <em>"+label+"</em> work" if slug != "services" else "See our <em>recent work</em>"}</h2>'
                   f'<div class="vgrid vhome th-vids">{tiles}</div><p style="margin-top:26px"><a class="btn" href="projects.html">Watch all projects</a></p></div></section>'
                   f'<section class="sec th-faq" style="padding-top:0"><div class="wrap"><div class="center"><span class="chip">Good to know</span><h2>{"Questions about <em>"+label+"</em>" if slug != "services" else "Questions we <em>hear most</em>"}</h2></div>'
                   f'<div class="faq">{faq}</div><p class="center" style="margin-top:26px">{page_link}</p></div></section></div>')
    body = f'''<section class="thanks-hero"><div class="wrap">
  <span class="chip" id="thChip">Request received</span>
  <h1 id="thH1">Thanks, <em>we got it.</em></h1>
  <p class="lead" id="thLead">A member of our team will reach out shortly. Want an answer right now? Calling is the fastest way to get a quote and book your appointment.</p>
  <div class="th-call"><a class="btn" id="thCall" href="tel:{SITE['tel']}" data-track="call_click">{ico}<b>Call Now</b><span>{SITE['phone']}</span></a><small>Prefer to wait? No problem. We will contact you soon.</small></div>
</div></section>
<section class="sec" id="thNext"><div class="wrap"><h2 class="center">What happens <em>next</em></h2>
<div class="th-steps"><div class="hl"><h3>1. We review your request</h3><p>We look at your vehicle and the service you asked about so we can give you a straight answer.</p></div>
<div class="hl"><h3>2. We reach out</h3><p>Expect a call or message from us shortly with options and pricing. Calling us first gets you answered fastest.</p></div>
<div class="hl"><h3>3. We book your car in</h3><p>Pick a time at the shop, or have our mobile detailing van come to you.</p></div></div></div></section>
{blocks}
<section class="sec" id="thMore" style="padding-top:0"><div class="wrap center">
<p class="th-meta">{SITE['addr1']}, {SITE['addr2']}<br>{SITE['hours'][0]} &middot; {SITE['hours'][1]}<br><a href="https://www.instagram.com/divinedetailer" target="_blank" rel="noopener">Follow us on Instagram</a></p></div></section>{VMODAL}'''
    page("thanks.html", f"Thank You | {SITE['name']}", "Thanks for contacting Divine Detailers.", body, noindex=True)

if __name__ == "__main__":
    build_assets()
    build_home(); build_services_hub()
    for s, t, d in SERVICES:
        build_service(s, t, d)
    build_brands(); build_projects(); build_about(); build_blog(); build_post(); build_contact(); build_privacy(); build_terms(); build_thanks()
    print("built", len(SERVICES) + 11, "pages")
