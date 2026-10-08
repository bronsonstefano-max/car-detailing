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
    const res = await fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(new FormData(f)).toString() });
    if (!res.ok) throw new Error('not ok');
    window.location.href = 'thanks.html';
  } catch (err) {
    btn.textContent = 'Not connected here. Works once the site is live on Netlify.';
    setTimeout(() => { btn.disabled = false; btn.textContent = label; }, 4000);
  }
}));

const yr = document.getElementById('yr');
if (yr) yr.textContent = new Date().getFullYear();
