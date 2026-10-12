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

async function adminPage(env) {
  await ensureTable(env.DB);
  const { results } = await env.DB.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT 500").all();
  const rows = results.map(l => `<tr class="${l.contacted ? "done" : ""}">
    <td>${esc(l.created_at)} UTC<br><small>${esc(l.type)}</small></td>
    <td><b>${esc(l.name)}</b><br><a href="mailto:${esc(l.email)}">${esc(l.email)}</a><br>${l.phone ? `<a class="call" href="tel:${esc(l.phone)}">${esc(l.phone)}</a>` : ""}</td>
    <td>${esc(l.service)}${l.also_interested ? `<br><small>also: ${esc(l.also_interested)}</small>` : ""}</td>
    <td>${esc([l.year, l.make, l.model].filter(Boolean).join(" "))}</td>
    <td class="msg">${esc(l.message)}</td>
    <td><small>${esc(l.utm_source || (l.gclid ? "google ads" : "") || l.referrer)}<br>${esc(l.utm_campaign)}<br>${esc(l.page)}</small></td>
    <td><button data-id="${l.id}" data-c="${l.contacted ? 0 : 1}">${l.contacted ? "Reopen" : "Mark contacted"}</button></td></tr>`).join("");
  const open = results.filter(l => !l.contacted).length;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Leads | Divine Detailers</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:0;background:#0b0d10;color:#e8eaed}header{display:flex;gap:16px;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #222;position:sticky;top:0;background:#0b0d10}h1{font-size:18px;margin:0}h1 b{color:#32cd32}
a{color:#7fe07f}.call{font-weight:700}table{width:100%;border-collapse:collapse}th,td{padding:10px 12px;border-bottom:1px solid #1d2126;text-align:left;vertical-align:top}th{color:#8a9099;font-weight:600;position:sticky;top:57px;background:#0b0d10}
tr.done{opacity:.45}.msg{max-width:320px;white-space:pre-wrap}small{color:#8a9099}button{background:#32cd32;border:0;border-radius:8px;padding:7px 10px;font-weight:700;cursor:pointer}.wrap{overflow-x:auto}.csv{background:#222;color:#fff;padding:8px 12px;border-radius:8px;text-decoration:none}</style></head>
<body><header><h1>Divine Detailers <b>leads</b> &middot; ${open} to contact &middot; ${results.length} shown</h1><a class="csv" href="/admin/leads.csv">Download CSV</a></header>
<div class="wrap"><table><thead><tr><th>Received</th><th>Contact</th><th>Service</th><th>Vehicle</th><th>Message</th><th>Source</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7">No leads yet.</td></tr>'}</tbody></table></div>
<script>document.addEventListener('click',async e=>{const b=e.target.closest('button[data-id]');if(!b)return;b.disabled=true;await fetch('/admin/contacted',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:+b.dataset.id,contacted:+b.dataset.c})});location.reload()})</script></body></html>`,
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

    if (p === "/api/lead") {
      if (request.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);
      try { return await handleLead(request, env, ctx); }
      catch (e) { console.error("lead error", e && e.message); return json({ success: false, message: "Server error" }, 500); }
    }

    if (p === "/admin" || p.startsWith("/admin/")) {
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

    return env.ASSETS.fetch(request);
  },
};
