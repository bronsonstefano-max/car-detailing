const btn = document.querySelector('.menu-btn');
const menu = document.getElementById('menu');
if (btn && menu) {
  btn.addEventListener('click', () => {
    const open = menu.classList.toggle('open');
    btn.setAttribute('aria-expanded', open);
  });
  menu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => menu.classList.remove('open')));
}

document.querySelectorAll('.more').forEach(b => b.addEventListener('click', () => {
  const body = b.closest('.pbody');
  const open = body.classList.toggle('open');
  b.textContent = open ? 'Show Less –' : 'Expand & Read More +';
}));

const slides = document.querySelector('.slides');
if (slides) {
  const count = slides.children.length;
  let idx = 0;
  const go = n => { idx = (n + count) % count; slides.style.transform = `translateX(-${idx * 100}%)`; };
  document.querySelector('.prev').addEventListener('click', () => go(idx - 1));
  document.querySelector('.next').addEventListener('click', () => go(idx + 1));
  setInterval(() => go(idx + 1), 6000);
}

const rg = document.querySelector('.rev-grid');
if (rg) {
  document.querySelector('.rprev').addEventListener('click', () => rg.appendChild(rg.firstElementChild));
  document.querySelector('.rnext').addEventListener('click', () => rg.prepend(rg.lastElementChild));
}

const yr = document.getElementById('yr');
if (yr) yr.textContent = new Date().getFullYear();
