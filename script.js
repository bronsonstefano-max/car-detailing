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

// Reviews carousel
const track = document.querySelector('.rev-track');
document.querySelectorAll('[data-rev]').forEach(b => b.addEventListener('click', () => {
  if (track) track.scrollBy({ left: Number(b.dataset.rev) * (track.firstElementChild.offsetWidth + 16), behavior: 'smooth' });
}));

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
    shade.style.opacity = (1 - v / 100).toFixed(2);
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
