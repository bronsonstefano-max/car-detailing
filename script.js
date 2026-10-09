// Menu
const menuBtn = document.querySelector('.menu-btn');
const nav = document.getElementById('nav');
if (menuBtn && nav) {
  menuBtn.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', open);
  });
}
document.querySelectorAll('.dd-btn').forEach(b => b.addEventListener('click', () => {
  const dd = b.closest('.has-dd');
  const open = dd.classList.toggle('open');
  b.setAttribute('aria-expanded', open);
}));
document.addEventListener('click', e => {
  document.querySelectorAll('.has-dd.open').forEach(d => { if (!d.contains(e.target)) d.classList.remove('open'); });
});

// Services slider (phones)
document.querySelectorAll('[data-svc]').forEach(btn => btn.addEventListener('click', () => {
  const cards = btn.closest('.svc-slider').querySelector('.cards');
  const w = cards.firstElementChild.offsetWidth;
  const atEnd = cards.scrollLeft + cards.clientWidth >= cards.scrollWidth - 4;
  const dir = Number(btn.dataset.svc);
  if (dir > 0 && atEnd) cards.scrollTo({ left: 0, behavior: 'smooth' });
  else if (dir < 0 && cards.scrollLeft <= 4) cards.scrollTo({ left: cards.scrollWidth, behavior: 'smooth' });
  else cards.scrollBy({ left: dir * w, behavior: 'smooth' });
}));

// Build slideshow
const buildTrack = document.getElementById('buildTrack');
if (buildTrack) {
  const step = dir => {
    const w = buildTrack.firstElementChild.offsetWidth + 8;
    const atEnd = buildTrack.scrollLeft + buildTrack.clientWidth >= buildTrack.scrollWidth - 4;
    const atStart = buildTrack.scrollLeft <= 4;
    if (dir > 0 && atEnd) buildTrack.scrollTo({ left: 0, behavior: 'smooth' });
    else if (dir < 0 && atStart) buildTrack.scrollTo({ left: buildTrack.scrollWidth, behavior: 'smooth' });
    else buildTrack.scrollBy({ left: dir * w, behavior: 'smooth' });
  };
  document.querySelectorAll('[data-slide]').forEach(b => b.addEventListener('click', () => step(Number(b.dataset.slide))));
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce) {
    let timer = setInterval(() => step(1), 4500);
    const pause = () => { clearInterval(timer); timer = null; };
    const resume = () => { if (!timer) timer = setInterval(() => step(1), 4500); };
    const slider = buildTrack.parentElement;
    slider.addEventListener('mouseenter', pause);
    slider.addEventListener('mouseleave', resume);
    slider.addEventListener('focusin', pause);
    slider.addEventListener('focusout', resume);
    slider.addEventListener('touchstart', pause, { passive: true });
  }
}

// Project filter
document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('on', x === b));
  const f = b.dataset.filter;
  document.querySelectorAll('#projectGrid [data-cat]').forEach(i => { i.hidden = f !== 'All' && i.dataset.cat !== f; });
}));

// Tint simulator
const shade = document.getElementById('simShade');
if (shade) {
  const view = document.getElementById('simView');
  const setShade = btn => {
    const v = Number(btn.dataset.vlt);
    view.style.setProperty('--o', (1 - v / 100).toFixed(2));
    document.getElementById('simBadge').textContent = v + '%';
    document.getElementById('simTitle').textContent = v + '% VLT — ' + btn.dataset.name;
    document.getElementById('simDesc').textContent = btn.dataset.desc;
  };
  document.querySelectorAll('[data-vlt]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-vlt]').forEach(x => x.classList.toggle('on', x === b));
    setShade(b);
  }));
  document.querySelectorAll('[data-sim-tab]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-sim-tab]').forEach(x => x.classList.toggle('on', x === b));
    const wind = b.dataset.simTab === 'wind';
    view.classList.toggle('wind', wind);
    document.getElementById('simBadgeLabel').textContent = wind ? 'WINDSHIELD VLT' : 'SIDE VLT';
    // windshield tab only offers the lighter shades
    const cur = document.querySelector('[data-vlt].on');
    if (wind && cur && Number(cur.dataset.vlt) < 30) document.querySelector('[data-vlt="50"]').click();
  }));
  setShade(document.querySelector('[data-vlt].on'));
}

// Forms: post to Netlify Forms; show a clear message anywhere else (local file, preview)
document.querySelectorAll('form[data-form]').forEach(f => f.addEventListener('submit', async e => {
  e.preventDefault();
  const btn = f.querySelector('button[type=submit]');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const endpoint = f.dataset.endpoint;
    if (endpoint) {
      // Web3Forms (works on any host): emails the submission to the address tied to the access key
      const data = Object.fromEntries(new FormData(f));
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(data) });
      const out = await res.json();
      if (!out.success) throw new Error('not ok');
    } else {
      const res = await fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(new FormData(f)).toString() });
      if (!res.ok) throw new Error('not ok');
    }
    window.location.href = 'thanks.html';
  } catch (err) {
    btn.textContent = 'Not connected here. Works once the site is live on Netlify.';
    setTimeout(() => { btn.disabled = false; btn.textContent = label; }, 4000);
  }
}));

const yr = document.getElementById('yr');
if (yr) yr.textContent = new Date().getFullYear();

// Hero background video: start downloading only after the page has fully loaded and the browser is idle
(() => {
  const v = document.querySelector('video.hero-vid[data-mp4]');
  if (!v || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const conn = navigator.connection;
  if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) return;
  const start = () => {
    // MP4 (H.264) first: hardware decoded on iPhones. WebM is the fallback. iOS ignores preload, so play() is what starts the download
    v.muted = true;
    v.setAttribute('playsinline', '');
    v.src = v.canPlayType('video/mp4; codecs="avc1.42E01E"') ? v.dataset.mp4 : v.dataset.webm;
    const tryPlay = () => { const p = v.play(); if (p && p.catch) p.catch(() => {}); };
    tryPlay();
    v.addEventListener('loadeddata', tryPlay, { once: true });
    // if the phone blocked autoplay (Low Power Mode etc.), start on the first touch or scroll
    ['touchstart', 'scroll', 'click'].forEach(ev => window.addEventListener(ev, () => { if (v.paused) tryPlay(); }, { once: true, passive: true }));
  };
  const go = () => ('requestIdleCallback' in window ? requestIdleCallback(start, { timeout: 2500 }) : setTimeout(start, 1200));
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
})();

// Floating call button: appears once the visitor starts scrolling
(() => {
  const fab = document.querySelector('.callfab');
  if (!fab) return;
  let on = false, inline = 0;
  const update = () => {
    const show = window.scrollY > 240 && inline === 0;
    if (show !== on) { on = show; fab.classList.toggle('show', show); }
  };
  // hide the floating bar while a call button is already on screen
  if ('IntersectionObserver' in window) {
    const seen = new Set();
    const io = new IntersectionObserver(es => {
      es.forEach(e => e.isIntersecting ? seen.add(e.target) : seen.delete(e.target));
      inline = seen.size;
      update();
    });
    document.querySelectorAll('a.btn[href^="tel:"]').forEach(a => io.observe(a));
  }
  window.addEventListener('scroll', update, { passive: true });
  update();
})();

// Phone reviews: slow continuous auto-scroll on a native scroll container (pauses while touched)
(() => {
  const track = document.querySelector('.rev-track.marquee:not(.logo-marquee)');
  if (!track || !window.matchMedia('(max-width:860px)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion:reduce)').matches) return;
  const run = track.querySelector('.rev-run');
  const SPEED = 37; // px per second (matches the brand logos strip: 1302px / 35s)
  let pos = 0, last = 0, visible = false, touching = false, resumeAt = 0;
  new IntersectionObserver(e => { visible = e[0].isIntersecting; }, { threshold: 0.1 }).observe(track);
  const hold = () => { touching = true; };
  const release = () => { touching = false; resumeAt = performance.now() + 2500; };
  track.addEventListener('touchstart', hold, { passive: true });
  track.addEventListener('touchend', release, { passive: true });
  track.addEventListener('touchcancel', release, { passive: true });
  const tick = t => {
    const dt = Math.min(t - last, 100); last = t;
    if (visible && !touching && t >= resumeAt && !document.hidden) {
      if (resumeAt) { pos = track.scrollLeft; resumeAt = 0; }
      pos += SPEED * dt / 1000;
      const half = run.scrollWidth / 2;
      if (pos >= half) pos -= half;
      if (Math.round(pos) !== Math.round(track.scrollLeft)) track.scrollLeft = pos;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
