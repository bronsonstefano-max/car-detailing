// Divine Detailers lead backend (Cloudflare Worker).
// - POST /api/lead   : receives website forms, stores them in D1, notifies by email and/or webhook
// - GET  /admin      : password-protected list of leads (+ /admin/leads.csv)
// Everything else is served from the static site (env.ASSETS).
//
// Bindings / settings (see wrangler.jsonc and README):
//   DB                (D1 database)            required to store leads
//   ADMIN_PASSWORD    (secret)                 required to open /admin
//   RESEND_API_KEY    (secret, optional)       email each new lead via resend.com
//   NOTIFY_TO         (var, optional)          who gets the email (comma separated)
//   NOTIFY_FROM       (var, optional)          sender, e.g. "Divine Detailers <leads@yourdomain.com>"
//   LEAD_WEBHOOK_URL  (secret, optional)       POST each lead as JSON (Zapier, Make, Slack, a CRM...)
//   CRM_HOST          (var, optional)          e.g. crm.divinedetailers.com: dashboard moves there (at "/"); /admin on other hosts redirects to it

const FIELDS = ["name", "email", "phone", "service", "also_interested", "make", "year", "model", "message"];
const MAX = { default: 300, message: 4000 };

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STAGES = [["new", "New lead"], ["contacted", "Contacted"], ["quoted", "Quote sent"], ["booked", "Booked"], ["working", "In the shop"], ["done", "Completed"], ["lost", "Lost"]];
const STAGE_KEYS = STAGES.map(x => x[0]);

async function ensureTable(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      type TEXT NOT NULL DEFAULT 'quote',
      name TEXT, email TEXT, phone TEXT, service TEXT, also_interested TEXT,
      make TEXT, year TEXT, model TEXT, message TEXT,
      page TEXT, referrer TEXT, gclid TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT,
      ip TEXT, user_agent TEXT, contacted INTEGER NOT NULL DEFAULT 0, notes TEXT,
      stage TEXT NOT NULL DEFAULT 'new', value INTEGER NOT NULL DEFAULT 0, stage_changed_at TEXT)`),
    db.prepare("CREATE INDEX IF NOT EXISTS leads_created ON leads (created_at)"),
  ]);
  // upgrade tables created before the pipeline existed
  const cols = (await db.prepare("PRAGMA table_info(leads)").all()).results.map(c => c.name);
  if (!cols.includes("stage")) {
    await db.batch([
      db.prepare("ALTER TABLE leads ADD COLUMN stage TEXT NOT NULL DEFAULT 'new'"),
      db.prepare("ALTER TABLE leads ADD COLUMN value INTEGER NOT NULL DEFAULT 0"),
      db.prepare("ALTER TABLE leads ADD COLUMN stage_changed_at TEXT"),
      db.prepare("UPDATE leads SET stage = 'contacted' WHERE contacted = 1"),
    ]);
  }
}

const clean = (v, n = MAX.default) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, n) : "");

async function handleLead(request, env, ctx) {
  let data;
  try {
    const ct = request.headers.get("content-type") || "";
    data = ct.includes("json") ? await request.json() : Object.fromEntries(await request.formData());
  } catch { return json({ success: false, message: "Bad request" }, 400); }

  // honeypot: bots tick the hidden box
  if (data.botcheck) return json({ success: true });

  const type = data["form-name"] === "newsletter" || data.type === "newsletter" ? "newsletter" : "quote";
  const lead = { type };
  for (const f of FIELDS) lead[f] = clean(data[f], f === "message" ? MAX.message : MAX.default);
  for (const f of ["page", "referrer", "gclid", "utm_source", "utm_medium", "utm_campaign", "utm_term"]) lead[f] = clean(data[f], 500);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(lead.email);
  if (!emailOk) return json({ success: false, message: "Please enter a valid email" }, 422);
  if (type === "quote") {
    const phoneOk = (lead.phone.match(/\d/g) || []).length >= 7;
    if (!lead.name || !phoneOk || !lead.service) return json({ success: false, message: "Please complete the required fields" }, 422);
  }

  if (!env.DB) return json({ success: false, message: "Lead storage is not configured" }, 503);
  await ensureTable(env.DB);

  const ip = request.headers.get("cf-connecting-ip") || "";
  // light rate limit: 6 submissions per IP per 10 minutes
  if (ip) {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM leads WHERE ip = ? AND created_at > datetime('now','-10 minutes')").bind(ip).first();
    if (r && r.n >= 6) return json({ success: false, message: "Too many requests. Please call us." }, 429);
  }

  await env.DB.prepare(`INSERT INTO leads (type,name,email,phone,service,also_interested,make,year,model,message,page,referrer,gclid,utm_source,utm_medium,utm_campaign,utm_term,ip,user_agent)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(type, lead.name, lead.email, lead.phone, lead.service, lead.also_interested, lead.make, lead.year, lead.model, lead.message,
      lead.page, lead.referrer, lead.gclid, lead.utm_source, lead.utm_medium, lead.utm_campaign, lead.utm_term, ip, clean(request.headers.get("user-agent") || "", 300)).run();

  ctx.waitUntil(notify(env, lead));
  return json({ success: true });
}

async function notify(env, lead) {
  const jobs = [];
  if (env.LEAD_WEBHOOK_URL) {
    jobs.push(fetch(env.LEAD_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(lead) }).catch(() => {}));
  }
  if (env.RESEND_API_KEY && env.NOTIFY_TO) {
    const rows = Object.entries(lead).filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join("");
    const subject = lead.type === "newsletter" ? `Newsletter signup: ${lead.email}` : `New lead: ${lead.name} (${lead.service}${lead.make ? ", " + lead.year + " " + lead.make + " " + lead.model : ""})`;
    jobs.push(fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: env.NOTIFY_FROM || "Divine Detailers <onboarding@resend.dev>",
        to: env.NOTIFY_TO.split(",").map(s => s.trim()).filter(Boolean),
        reply_to: lead.email,
        subject,
        html: `<p>New website lead${lead.phone ? ` &middot; <a href="tel:${esc(lead.phone)}">${esc(lead.phone)}</a>` : ""}</p><table>${rows}</table>`,
      }),
    }).catch(() => {}));
  }
  await Promise.all(jobs);
}

// ---------------------------------------------------------------- admin
function authed(request, env) {
  if (!env.ADMIN_PASSWORD) return "unconfigured";
  const h = request.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  try {
    const [, pass = ""] = atob(h.slice(6)).split(/:(.*)/s);
    // constant-time-ish compare
    if (pass.length !== env.ADMIN_PASSWORD.length) return false;
    let d = 0; for (let i = 0; i < pass.length; i++) d |= pass.charCodeAt(i) ^ env.ADMIN_PASSWORD.charCodeAt(i);
    return d === 0;
  } catch { return false; }
}
const challenge = () => new Response("Sign in", { status: 401, headers: { "www-authenticate": 'Basic realm="Divine Detailers leads", charset="UTF-8"' } });

const stageName = k => (STAGES.find(x => x[0] === k) || [k, k])[1];
const crmPrefix = env => ""; // paths are the same on every host
function nav(on) {
  return `<nav class="navtabs"><a href="/admin" class="${on === "leads" ? "on" : ""}">Leads</a><a href="/admin/pipeline" class="${on === "pipeline" ? "on" : ""}">Pipeline</a></nav>`;
}
const TZ = "America/New_York";
function when(sqlUtc) {
  const d = new Date(sqlUtc.replace(" ", "T") + "Z");
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const ago = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} hr ago` : `${Math.round(mins / 1440)} d ago`;
  const abs = d.toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return { ago, abs };
}
function sourceOf(l) {
  if (l.gclid || l.utm_medium === "cpc") return { label: "Google Ads", ad: true, detail: [l.utm_campaign, l.utm_term].filter(Boolean).join(" · ") };
  if (l.utm_source) return { label: l.utm_source, ad: false, detail: l.utm_campaign || "" };
  if (l.referrer) { try { return { label: new URL(l.referrer).hostname.replace(/^www\./, ""), ad: false, detail: "" }; } catch { /* ignore */ } }
  return { label: "Direct", ad: false, detail: "" };
}

async function adminPage(env) {
  await ensureTable(env.DB);
  const { results } = await env.DB.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT 500").all();
  const open = results.filter(l => l.stage === "new" && l.type === "quote").length;
  const ads = results.filter(l => sourceOf(l).ad).length;
  const cards = results.map(l => {
    const t = when(l.created_at), src = sourceOf(l);
    const veh = [l.year, l.make, l.model].filter(Boolean).join(" ");
    const tel = (l.phone || "").replace(/[^\d+]/g, "");
    return `<article class="lead ${["done", "lost"].includes(l.stage) ? "done" : l.stage === "new" ? "new" : ""}" data-q="${esc([l.name, l.email, l.phone, l.service, veh, l.message, src.label, src.detail].join(" ").toLowerCase())}" data-st="${l.stage === "new" ? "new" : "done"}" data-ad="${src.ad ? 1 : 0}">
      <div class="top"><div><h3>${esc(l.name || l.email)}</h3><div class="when" title="${esc(t.abs)} ET">${esc(t.ago)} &middot; ${esc(t.abs)}</div></div>
        <div class="tags">${l.type === "newsletter" ? '<span class="tag nl">Newsletter</span>' : ""}<span class="tag ${src.ad ? "ad" : ""}">${esc(src.label)}</span>${l.type === "newsletter" ? "" : l.stage === "new" ? '<span class="tag hot">New</span>' : `<span class="tag ok">${esc(stageName(l.stage))}</span>`}</div></div>
      <div class="grid">
        ${l.service ? `<div><label>Service</label>${esc(l.service)}${l.also_interested ? `<small>also: ${esc(l.also_interested)}</small>` : ""}</div>` : ""}
        ${veh ? `<div><label>Vehicle</label>${esc(veh)}</div>` : ""}
        ${src.detail ? `<div><label>Campaign</label>${esc(src.detail)}</div>` : ""}
        ${l.page ? `<div><label>Landed on</label>${esc(l.page)}</div>` : ""}
      </div>
      ${l.message ? `<p class="msg">&ldquo;${esc(l.message)}&rdquo;</p>` : ""}
      <div class="actions">${tel ? `<a class="btn call" href="tel:${esc(tel)}">Call ${esc(l.phone)}</a>` : ""}<a class="btn" href="mailto:${esc(l.email)}">Email</a>
        <select class="btn stage" data-id="${l.id}" aria-label="Stage">${STAGES.map(([k, n]) => `<option value="${k}"${k === l.stage ? " selected" : ""}>${n}</option>`).join("")}</select></div>
    </article>`;
  }).join("");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Leads | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#07090c;color:#e8eaed}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25;position:sticky;top:0;background:rgba(7,9,12,.96);backdrop-filter:blur(6px);z-index:5}
h1{font-size:19px;margin:0;letter-spacing:.2px}h1 b{color:#32cd32}
.stats{display:flex;gap:10px;flex-wrap:wrap}.stat{background:#10141a;border:1px solid #1d2229;border-radius:10px;padding:8px 14px}.stat b{display:block;font-size:20px;line-height:1.1}.stat span{font-size:12px;color:#8a9099}.stat.hot b{color:#32cd32}
.tools{display:flex;gap:10px;flex-wrap:wrap;padding:14px 22px;align-items:center}
input[type=search]{flex:1;min-width:200px;background:#10141a;border:1px solid #232932;color:#fff;border-radius:10px;padding:11px 14px;font:inherit}
.chip{background:#10141a;border:1px solid #232932;color:#cfd3d9;border-radius:999px;padding:9px 14px;cursor:pointer;font:inherit}.navtabs{display:flex;gap:6px}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}.navtabs a.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
.stage{appearance:auto;background:#151a21}
.chip.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
.csv{color:#cfd3d9;text-decoration:none;border:1px solid #232932;border-radius:10px;padding:10px 14px}
main{padding:0 22px 40px;display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px}
.lead{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px}.lead.new{border-color:#244d2a}.lead.done{opacity:.6}
.top{display:flex;justify-content:space-between;gap:10px}h3{margin:0;font-size:17px}.when{color:#8a9099;font-size:12.5px;margin-top:2px}
.tags{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;align-content:flex-start}.tag{font-size:11.5px;padding:3px 9px;border-radius:999px;background:#171c23;color:#aab0b9;white-space:nowrap}
.tag.ad{background:#14263f;color:#8ec0ff}.tag.hot{background:#32cd32;color:#04120a;font-weight:700}.tag.ok{background:#1a2a1c;color:#7fe07f}.tag.nl{background:#2b2411;color:#f0c050}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}label{display:block;color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:1px}small{display:block;color:#8a9099}
.msg{margin:0;background:#10141a;border-left:3px solid #32cd32;padding:10px 12px;border-radius:0 8px 8px 0;color:#d6d9de}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:auto}.btn{border:1px solid #2a313a;background:#151a21;color:#e8eaed;border-radius:10px;padding:10px 13px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.btn.call{background:#32cd32;border-color:#32cd32;color:#04120a}.btn.go{background:#1d2630}.btn.ghost{color:#8a9099}
.empty{grid-column:1/-1;color:#8a9099;padding:40px 0;text-align:center}
@media(max-width:560px){main{grid-template-columns:1fr;padding:0 14px 40px}.tools,header{padding-left:14px;padding-right:14px}}
</style></head>
<body><header><h1>Divine Detailers <b>leads</b></h1>${nav("leads")}
<div class="stats"><div class="stat hot"><b>${open}</b><span>to contact</span></div><div class="stat"><b>${results.length}</b><span>total</span></div><div class="stat"><b>${ads}</b><span>from Google Ads</span></div></div></header>
<div class="tools"><input type="search" id="q" placeholder="Search name, phone, vehicle, service..."><button class="chip on" data-f="all">All</button><button class="chip" data-f="new">New</button><button class="chip" data-f="done">Worked</button><button class="chip" data-f="ad">Google Ads</button><a class="csv" href="/admin/leads.csv">Download CSV</a></div>
<main id="list">${cards || '<p class="empty">No leads yet. They will appear here the moment someone submits a form.</p>'}</main>
<script>
const list=document.getElementById('list'),q=document.getElementById('q');let f='all';
function apply(){const t=q.value.trim().toLowerCase();list.querySelectorAll('.lead').forEach(e=>{const ok=(!t||e.dataset.q.includes(t))&&(f==='all'||(f==='ad'?e.dataset.ad==='1':e.dataset.st===f));e.hidden=!ok})}
q.addEventListener('input',apply);document.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{document.querySelectorAll('.chip').forEach(x=>x.classList.toggle('on',x===c));f=c.dataset.f;apply()}));
document.addEventListener('change',async e=>{const s=e.target.closest('select.stage');if(!s)return;s.disabled=true;await fetch('/admin/stage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:+s.dataset.id,stage:s.value})});location.reload()});
</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}


async function pipelinePage(env) {
  await ensureTable(env.DB);
  const { results } = await env.DB.prepare("SELECT id,created_at,type,name,email,phone,service,also_interested,make,year,model,message,page,referrer,gclid,utm_medium,utm_source,utm_campaign,utm_term,stage,value,notes,stage_changed_at FROM leads WHERE type = 'quote' ORDER BY id DESC LIMIT 1000").all();
  const data = results.map(l => ({ ...l, ago: when(l.created_at).ago, abs: when(l.created_at).abs, src: sourceOf(l).label, ad: sourceOf(l).ad, detail: sourceOf(l).detail }));
  const payload = JSON.stringify({ stages: STAGES, leads: data }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Pipeline | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#07090c;color:#e8eaed;height:100vh;display:flex;flex-direction:column}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}.navtabs a.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
.sum{display:flex;gap:10px;flex-wrap:wrap}.stat{background:#10141a;border:1px solid #1d2229;border-radius:10px;padding:7px 13px}.stat b{display:block;font-size:19px;line-height:1.1}.stat span{font-size:12px;color:#8a9099}.stat.g b{color:#32cd32}
.board{flex:1;display:flex;gap:12px;padding:14px 22px 22px;overflow-x:auto;align-items:flex-start;scroll-snap-type:x proximity}
.col{flex:1 0 190px;max-width:330px;background:#0b0e12;border:1px solid #1b2027;border-radius:14px;display:flex;flex-direction:column;max-height:100%;scroll-snap-align:start}
.col.over{border-color:#32cd32;background:#0d140f}.col h2{font-size:13px;margin:0;padding:12px 14px;display:flex;justify-content:space-between;align-items:baseline;text-transform:uppercase;letter-spacing:.7px;color:#c3c8cf}
.col h2 small{color:#7c838d;font-weight:500;text-transform:none;letter-spacing:0}.col.s-lost h2{color:#c48a8a}.col.s-done h2{color:#7fe07f}
.cards{padding:0 10px 10px;display:flex;flex-direction:column;gap:9px;overflow-y:auto;min-height:60px}
.card{background:#12171e;border:1px solid #232a33;border-radius:11px;padding:11px 12px;cursor:grab}.card:hover{border-color:#3a4552}.card.drag{opacity:.4}
.card b{display:block;font-size:15px}.card .meta{color:#98a0aa;font-size:13px;margin-top:2px}.card .row span:first-child{white-space:nowrap}.card .row{display:flex;justify-content:space-between;gap:8px;margin-top:8px;align-items:center;color:#7c838d;font-size:12px}
.pill{font-size:11px;padding:2px 8px;border-radius:999px;background:#171c23;color:#aab0b9}.pill.ad{background:#14263f;color:#8ec0ff}.pill.val{background:#16301a;color:#7fe07f;font-weight:700}
.empty{color:#586069;font-size:13px;text-align:center;padding:14px 0}
dialog{background:#0f1319;color:#e8eaed;border:1px solid #2a313a;border-radius:16px;padding:0;width:min(520px,94vw);max-height:92vh;overflow:auto}dialog::backdrop{background:rgba(0,0,0,.65)}
.dh{display:flex;justify-content:space-between;gap:10px;padding:18px 20px 6px}.dh h3{margin:0;font-size:20px}.x{background:none;border:0;color:#8a9099;font-size:26px;cursor:pointer;line-height:1}
.db{padding:6px 20px 20px;display:flex;flex-direction:column;gap:12px}.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}label{display:block;color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:2px}
.msg{margin:0;background:#12171e;border-left:3px solid #32cd32;padding:10px 12px;border-radius:0 8px 8px 0;color:#d6d9de}
select,input,textarea{width:100%;background:#12171e;border:1px solid #2a313a;color:#fff;border-radius:10px;padding:10px 12px;font:inherit}textarea{min-height:84px;resize:vertical}
.acts{display:flex;gap:8px;flex-wrap:wrap}.btn{border:1px solid #2a313a;background:#151a21;color:#e8eaed;border-radius:10px;padding:10px 14px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}.btn.call{background:#32cd32;border-color:#32cd32;color:#04120a}.btn.go{background:#32cd32;border-color:#32cd32;color:#04120a;margin-left:auto}
@media(max-width:700px){.board{padding:12px 12px 20px}.col{flex-basis:84vw}header{padding:12px 14px}}
</style></head><body>
<header><h1>Divine Detailers <b>pipeline</b></h1>${nav("pipeline")}<div class="sum" id="sum"></div></header>
<div class="board" id="board"></div>
<dialog id="dlg"></dialog>
<script type="application/json" id="data">${payload}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent),S=D.stages,L=D.leads,board=document.getElementById('board'),dlg=document.getElementById('dlg');
const $=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),money=n=>n?'$'+Number(n).toLocaleString('en-US'):'';
function draw(){
  let open=0,won=0,booked=0;
  board.innerHTML=S.map(([k,n])=>{const ls=L.filter(l=>l.stage===k),tot=ls.reduce((a,l)=>a+(l.value||0),0);
    if(k==='new')open=ls.length;if(k==='booked'||k==='working'||k==='done')booked+=tot;if(k==='done')won=tot;
    return '<section class="col s-'+k+'" data-stage="'+k+'"><h2>'+n+' <small>'+ls.length+(tot?' &middot; '+money(tot):'')+'</small></h2><div class="cards">'+
    (ls.map(l=>'<article class="card" draggable="true" data-id="'+l.id+'"><b>'+$(l.name||l.email)+'</b><div class="meta">'+$(l.service||'')+(l.make?' &middot; '+$([l.year,l.make,l.model].filter(Boolean).join(' ')):'')+'</div><div class="row"><span>'+$(l.ago)+'</span><span>'+(l.ad?'<span class="pill ad">Ads</span> ':'')+(l.value?'<span class="pill val">'+money(l.value)+'</span>':'')+'</span></div></article>').join('')||'<div class="empty">Drop leads here</div>')+'</div></section>';}).join('');
  document.getElementById('sum').innerHTML='<div class="stat g"><b>'+open+'</b><span>new to contact</span></div><div class="stat"><b>'+money(booked)+'</b><span>booked + done</span></div><div class="stat"><b>'+money(won)+'</b><span>completed</span></div>';
}
async function save(id,patch,url){const r=await fetch(url||'/admin/lead',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({id},patch))});return r.ok}
let dragId=null;
board.addEventListener('dragstart',e=>{const c=e.target.closest('.card');if(!c)return;dragId=+c.dataset.id;c.classList.add('drag');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(dragId))});
board.addEventListener('dragend',()=>{dragId=null;draw()});
board.addEventListener('dragover',e=>{const c=e.target.closest('.col');if(!c)return;e.preventDefault();board.querySelectorAll('.col.over').forEach(x=>x!==c&&x.classList.remove('over'));c.classList.add('over')});
board.addEventListener('drop',async e=>{const c=e.target.closest('.col');if(!c||dragId==null)return;e.preventDefault();const l=L.find(x=>x.id===dragId);const st=c.dataset.stage;if(l&&l.stage!==st){l.stage=st;draw();await save(l.id,{stage:st})}else draw()});
board.addEventListener('click',e=>{const c=e.target.closest('.card');if(c)open(+c.dataset.id)});
function open(id){const l=L.find(x=>x.id===id);if(!l)return;const tel=(l.phone||'').replace(/[^\\d+]/g,''),veh=[l.year,l.make,l.model].filter(Boolean).join(' ');
  dlg.innerHTML='<div class="dh"><div><h3>'+$(l.name||l.email)+'</h3><div style="color:#8a9099;font-size:13px">'+$(l.ago)+' &middot; '+$(l.abs)+' ET &middot; '+$(l.src)+'</div></div><button class="x" onclick="dlg.close()" aria-label="Close">&times;</button></div><div class="db">'+
  '<div class="g2"><div><label>Service</label>'+$(l.service||'-')+(l.also_interested?'<div style="color:#8a9099;font-size:13px">also: '+$(l.also_interested)+'</div>':'')+'</div><div><label>Vehicle</label>'+$(veh||'-')+'</div>'+(l.detail?'<div><label>Campaign</label>'+$(l.detail)+'</div>':'')+(l.page?'<div><label>Landed on</label>'+$(l.page)+'</div>':'')+'</div>'+
  (l.message?'<p class="msg">&ldquo;'+$(l.message)+'&rdquo;</p>':'')+
  '<div class="acts">'+(tel?'<a class="btn call" href="tel:'+$(tel)+'">Call '+$(l.phone)+'</a>':'')+'<a class="btn" href="mailto:'+$(l.email)+'">Email</a></div>'+
  '<div class="g2"><div><label>Stage</label><select id="fs">'+S.map(([k,n])=>'<option value="'+k+'"'+(k===l.stage?' selected':'')+'>'+n+'</option>').join('')+'</select></div><div><label>Job value ($)</label><input id="fv" type="number" min="0" step="1" inputmode="numeric" value="'+(l.value||'')+'" placeholder="0"></div></div>'+
  '<div><label>Notes</label><textarea id="fn" placeholder="Called, left voicemail... quoted full front PPF...">'+$(l.notes||'')+'</textarea></div>'+
  '<div class="acts"><button class="btn go" id="fsave">Save</button></div></div>';
  dlg.showModal();
  document.getElementById('fsave').onclick=async()=>{const p={stage:document.getElementById('fs').value,value:Math.max(0,parseInt(document.getElementById('fv').value||'0',10)||0),notes:document.getElementById('fn').value};if(await save(l.id,p)){Object.assign(l,p);dlg.close();draw()}}}
draw();
</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function csv(env) {
  await ensureTable(env.DB);
  const { results } = await env.DB.prepare("SELECT * FROM leads ORDER BY id DESC").all();
  const cols = ["id", "created_at", "type", "name", "email", "phone", "service", "also_interested", "make", "year", "model", "message", "page", "referrer", "gclid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "stage", "value", "notes"];
  const q = v => { let s = String(v ?? ""); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const body = [cols.join(","), ...results.map(r => cols.map(c => q(r[c])).join(","))].join("\n");
  return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="divine-detailers-leads.csv"', "cache-control": "no-store" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    // When CRM_HOST is set (e.g. crm.divinedetailers.com) the lead dashboard lives only on that host, at its root.
    const crmHost = (env.CRM_HOST || "").toLowerCase();
    const onCrm = !!crmHost && url.hostname.toLowerCase() === crmHost;

    if (onCrm) {
      // the CRM host only serves the dashboard (and its few endpoints), never the marketing site or the form API
      if (p === "/" || p === "/admin") return adminRoute("/admin", request, env);
      if (p === "/pipeline" || p === "/admin/pipeline") return adminRoute("/admin/pipeline", request, env);
      if (p === "/admin/stage" || p === "/admin/lead") return adminRoute(p, request, env);
      if (p === "/leads.csv" || p === "/admin/leads.csv") return adminRoute("/admin/leads.csv", request, env);
      if (p === "/admin/contacted") return adminRoute("/admin/contacted", request, env);
      if (p === "/favicon.ico" || p.startsWith("/assets/favicon")) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    }

    if (p === "/api/lead") {
      if (request.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);
      try { return await handleLead(request, env, ctx); }
      catch (e) { console.error("lead error", e && e.message); return json({ success: false, message: "Server error" }, 500); }
    }

    if (p === "/admin" || p.startsWith("/admin/")) {
      if (crmHost) return Response.redirect(`https://${crmHost}/`, 301);
      return adminRoute(p, request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function adminRoute(p, request, env) {
  const a = authed(request, env);
  if (a === "unconfigured") return new Response("Admin is not configured yet. Set the ADMIN_PASSWORD secret.", { status: 503 });
  if (!a) return challenge();
  if (!env.DB) return new Response("Lead database is not configured.", { status: 503 });
  if (p === "/admin") return adminPage(env);
  if (p === "/admin/leads.csv") return csv(env);
  if (p === "/admin/pipeline") return pipelinePage(env);
  if ((p === "/admin/stage" || p === "/admin/lead") && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!Number.isInteger(b.id)) return json({ success: false }, 400);
    const sets = [], vals = [];
    if (typeof b.stage === "string" && STAGE_KEYS.includes(b.stage)) { sets.push("stage = ?", "contacted = ?", "stage_changed_at = datetime('now')"); vals.push(b.stage, b.stage === "new" ? 0 : 1); }
    if (p === "/admin/lead") {
      if (Number.isFinite(b.value)) { sets.push("value = ?"); vals.push(Math.max(0, Math.min(10000000, Math.floor(b.value)))); }
      if (typeof b.notes === "string") { sets.push("notes = ?"); vals.push(b.notes.slice(0, 4000)); }
    }
    if (!sets.length) return json({ success: false }, 400);
    await env.DB.prepare(`UPDATE leads SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, b.id).run();
    return json({ success: true });
  }
  return new Response("Not found", { status: 404 });
}
