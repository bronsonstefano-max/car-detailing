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

async function ensureTable(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      type TEXT NOT NULL DEFAULT 'quote',
      name TEXT, email TEXT, phone TEXT, service TEXT, also_interested TEXT,
      make TEXT, year TEXT, model TEXT, message TEXT,
      page TEXT, referrer TEXT, gclid TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT,
      ip TEXT, user_agent TEXT, contacted INTEGER NOT NULL DEFAULT 0, notes TEXT)`),
    db.prepare("CREATE INDEX IF NOT EXISTS leads_created ON leads (created_at)"),
  ]);
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
  const open = results.filter(l => !l.contacted && l.type === "quote").length;
  const ads = results.filter(l => sourceOf(l).ad).length;
  const cards = results.map(l => {
    const t = when(l.created_at), src = sourceOf(l);
    const veh = [l.year, l.make, l.model].filter(Boolean).join(" ");
    const tel = (l.phone || "").replace(/[^\d+]/g, "");
    return `<article class="lead ${l.contacted ? "done" : "new"}" data-q="${esc([l.name, l.email, l.phone, l.service, veh, l.message, src.label, src.detail].join(" ").toLowerCase())}" data-st="${l.contacted ? "done" : "new"}" data-ad="${src.ad ? 1 : 0}">
      <div class="top"><div><h3>${esc(l.name || l.email)}</h3><div class="when" title="${esc(t.abs)} ET">${esc(t.ago)} &middot; ${esc(t.abs)}</div></div>
        <div class="tags">${l.type === "newsletter" ? '<span class="tag nl">Newsletter</span>' : ""}<span class="tag ${src.ad ? "ad" : ""}">${esc(src.label)}</span>${l.type === "newsletter" ? "" : l.contacted ? '<span class="tag ok">Contacted</span>' : '<span class="tag hot">New</span>'}</div></div>
      <div class="grid">
        ${l.service ? `<div><label>Service</label>${esc(l.service)}${l.also_interested ? `<small>also: ${esc(l.also_interested)}</small>` : ""}</div>` : ""}
        ${veh ? `<div><label>Vehicle</label>${esc(veh)}</div>` : ""}
        ${src.detail ? `<div><label>Campaign</label>${esc(src.detail)}</div>` : ""}
        ${l.page ? `<div><label>Landed on</label>${esc(l.page)}</div>` : ""}
      </div>
      ${l.message ? `<p class="msg">&ldquo;${esc(l.message)}&rdquo;</p>` : ""}
      <div class="actions">${tel ? `<a class="btn call" href="tel:${esc(tel)}">Call ${esc(l.phone)}</a>` : ""}<a class="btn" href="mailto:${esc(l.email)}">Email</a>
        <button class="btn ${l.contacted ? "ghost" : "go"}" data-id="${l.id}" data-c="${l.contacted ? 0 : 1}">${l.contacted ? "Reopen" : "Mark contacted"}</button></div>
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
.chip{background:#10141a;border:1px solid #232932;color:#cfd3d9;border-radius:999px;padding:9px 14px;cursor:pointer;font:inherit}.chip.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
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
<body><header><h1>Divine Detailers <b>leads</b></h1>
<div class="stats"><div class="stat hot"><b>${open}</b><span>to contact</span></div><div class="stat"><b>${results.length}</b><span>total</span></div><div class="stat"><b>${ads}</b><span>from Google Ads</span></div></div></header>
<div class="tools"><input type="search" id="q" placeholder="Search name, phone, vehicle, service..."><button class="chip on" data-f="all">All</button><button class="chip" data-f="new">New</button><button class="chip" data-f="done">Contacted</button><button class="chip" data-f="ad">Google Ads</button><a class="csv" href="/admin/leads.csv">Download CSV</a></div>
<main id="list">${cards || '<p class="empty">No leads yet. They will appear here the moment someone submits a form.</p>'}</main>
<script>
const list=document.getElementById('list'),q=document.getElementById('q');let f='all';
function apply(){const t=q.value.trim().toLowerCase();list.querySelectorAll('.lead').forEach(e=>{const ok=(!t||e.dataset.q.includes(t))&&(f==='all'||(f==='ad'?e.dataset.ad==='1':e.dataset.st===f));e.hidden=!ok})}
q.addEventListener('input',apply);document.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{document.querySelectorAll('.chip').forEach(x=>x.classList.toggle('on',x===c));f=c.dataset.f;apply()}));
document.addEventListener('click',async e=>{const b=e.target.closest('button[data-id]');if(!b)return;b.disabled=true;await fetch('/admin/contacted',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:+b.dataset.id,contacted:+b.dataset.c})});location.reload()});
</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function csv(env) {
  await ensureTable(env.DB);
  const { results } = await env.DB.prepare("SELECT * FROM leads ORDER BY id DESC").all();
  const cols = ["id", "created_at", "type", "name", "email", "phone", "service", "also_interested", "make", "year", "model", "message", "page", "referrer", "gclid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "contacted"];
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
  if (p === "/admin/contacted" && request.method === "POST") {
    const { id, contacted } = await request.json().catch(() => ({}));
    if (Number.isInteger(id)) await env.DB.prepare("UPDATE leads SET contacted = ? WHERE id = ?").bind(contacted ? 1 : 0, id).run();
    return json({ success: true });
  }
  return new Response("Not found", { status: 404 });
}
