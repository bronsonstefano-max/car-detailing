// Divine Detailers lead backend (Cloudflare Worker).
// - POST /api/lead   : receives website forms, stores them in D1, notifies by email and/or webhook
// - GET  /admin      : password-protected list of leads (+ /admin/leads.csv)
// Everything else is served from the static site (env.ASSETS).
//
// Bindings / settings (see wrangler.jsonc and README):
//   DB                (D1 database)            required to store leads
//   PASSWORD_GIORDANI, PASSWORD_BRONSON (secrets)  one password each for the two people who can sign in (ADMIN_PASSWORD still works as the bronson password)
//   RESEND_API_KEY    (secret, optional)       email each new lead via resend.com
//   NOTIFY_TO         (var, optional)          who gets the email (comma separated)
//   NOTIFY_FROM       (var, optional)          sender, e.g. "Divine Detailers <leads@yourdomain.com>"
//   LEAD_WEBHOOK_URL  (secret, optional)       POST each new lead and each missed call as JSON, with a ready-made `text` line (Zapier, Make, Slack...)
//   CRM_HOST          (var, optional)          e.g. crm.divinedetailers.com: dashboard moves there (at "/"); /admin on other hosts redirects to it

const FIELDS = ["name", "email", "phone", "service", "also_interested", "make", "year", "model", "message"];
const MAX = { default: 300, message: 4000 };

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STAGES = [["new", "New lead"], ["contacted", "Contacted"], ["quoted", "Quote sent"], ["booked", "Booked"], ["working", "In the shop"], ["done", "Completed"], ["lost", "Lost"]];
const STAGE_KEYS = STAGES.map(x => x[0]);
// What can happen next at each stage: [label, stage it moves the lead to (or null to stay)]
const FOLLOWUPS = {
  new: [["Called, no answer", null], ["Left a voicemail", null], ["Sent a text", null], ["Spoke to the customer", "contacted"], ["Wrong number or spam", "lost"]],
  contacted: [["Needs a quote", null], ["Waiting on the customer", null], ["Quote sent", "quoted"], ["Not interested", "lost"], ["No response", "lost"]],
  quoted: [["Invoice sent", null], ["Waiting on a decision", null], ["Sent a reminder", null], ["Accepted, deposit paid", "booked"], ["Too expensive", "lost"], ["Not interested", "lost"], ["Went with another shop", "lost"], ["No response", "lost"]],
  booked: [["Drop-off confirmed", null], ["Rescheduled", null], ["Car dropped off", "working"], ["Cancelled", "lost"]],
  working: [["Work in progress", null], ["Waiting on film or parts", null], ["Customer update sent", null], ["Work finished, ready for pickup", "done"]],
  done: [["Paid in full", null], ["Asked for a review", null], ["Review received", null], ["Wants more work", "contacted"]],
  lost: [["Follow up later", null], ["Customer came back", "contacted"]],
};

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
      stage TEXT NOT NULL DEFAULT 'new', value INTEGER NOT NULL DEFAULT 0, stage_changed_at TEXT,
      call_id TEXT, duration INTEGER, recording TEXT, answered INTEGER, tracking_number TEXT, follow_up TEXT, follow_up_date TEXT)`),
    db.prepare("CREATE INDEX IF NOT EXISTS leads_created ON leads (created_at)"),
  ]);
  await db.prepare(`CREATE TABLE IF NOT EXISTS stage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, from_stage TEXT, to_stage TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS stage_log_lead ON stage_log (lead_id)").run();
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
  if (!cols.includes("follow_up")) {
    await db.batch([
      db.prepare("ALTER TABLE leads ADD COLUMN follow_up TEXT"),
      db.prepare("ALTER TABLE leads ADD COLUMN follow_up_date TEXT"),
    ]);
  }
  if (!cols.includes("call_id")) {
    await db.batch([
      db.prepare("ALTER TABLE leads ADD COLUMN call_id TEXT"),
      db.prepare("ALTER TABLE leads ADD COLUMN duration INTEGER"),
      db.prepare("ALTER TABLE leads ADD COLUMN recording TEXT"),
      db.prepare("ALTER TABLE leads ADD COLUMN answered INTEGER"),
      db.prepare("ALTER TABLE leads ADD COLUMN tracking_number TEXT"),
    ]);
  }
}

const clean = (v, n = MAX.default) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, n) : "");


// ---------------------------------------------------------------- CallRail (post-call webhook)
// In CallRail: Settings > Integrations > Webhooks > Post-Call, URL: https://<site>/api/callrail?key=<CALLRAIL_KEY>
const num = v => (v === undefined || v === null || v === "" ? null : Number(v));
const bool = v => (v === true || v === "true" || v === 1 || v === "1" ? 1 : v === false || v === "false" || v === 0 || v === "0" ? 0 : null);
function sqlTime(v) {
  const d = v ? new Date(v) : new Date();
  const t = isNaN(d) ? new Date() : d;
  return t.toISOString().slice(0, 19).replace("T", " ");
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function handleCallrail(request, env, url, ctx) {
  if (!env.CALLRAIL_KEY) return json({ success: false, message: "CALLRAIL_KEY is not set" }, 503);
  if (!safeEqual(url.searchParams.get("key") || "", env.CALLRAIL_KEY)) return json({ success: false }, 401);
  if (!env.DB) return json({ success: false, message: "Lead storage is not configured" }, 503);
  let c;
  try { c = await request.json(); } catch { return json({ success: false, message: "Bad request" }, 400); }
  await ensureTable(env.DB);
  const phone = clean(c.customer_phone_number || c.caller_number || c.formatted_customer_phone_number || c.customer_phone || "", 40);
  let name = clean(c.customer_name || c.resolved_customer_name || c.caller_name || "", 120);
  if (/^(unknown|anonymous|private|null)$/i.test(name) || name === phone) name = "";
  const answered = bool(c.answered);
  const voicemail = bool(c.voicemail) === 1;
  const src = clean(c.formatted_tracking_source || c.source || c.utm_source || "", 120);
  const rec = clean(c.recording_player || c.recording || "", 500);
  const callId = clean(String(c.id || c.call_id || c.resource_id || ""), 80);
  const dir = clean(String(c.direction || ""), 20);
  const row = {
    created: sqlTime(c.start_time || c.created_at), name, phone, call_id: callId,
    duration: num(c.duration), recording: rec, answered, tracking: clean(c.tracking_phone_number || c.formatted_tracking_phone_number || "", 40),
    page: clean(c.landing_page_url || c.last_requested_url || "", 500), referrer: clean(c.referrer_domain || c.referrer || "", 300),
    gclid: clean(c.gclid || "", 300), utm_source: clean(c.utm_source || src, 200), utm_medium: clean(c.utm_medium || (c.medium || "call"), 200),
    utm_campaign: clean(c.utm_campaign || c.campaign || "", 200), utm_term: clean(c.utm_term || c.keywords || "", 200),
    message: [dir === "outbound" ? "Outbound call" : "", voicemail ? "Left a voicemail" : answered === 0 ? "Missed call, call back" : "", c.first_call === true || c.first_call === "true" ? "First-time caller" : "", [c.customer_city, c.customer_state].filter(Boolean).join(", ")].filter(Boolean).join(" · "),
  };
  if (!phone && !callId) return json({ success: false, message: "No call data" }, 422);
  const existing = callId ? await env.DB.prepare("SELECT id FROM leads WHERE call_id = ?").bind(callId).first() : null;
  if (existing) {
    // CallRail sends the webhook again when a call is updated (recording ready, tags): keep the person's edits, refresh call facts
    await env.DB.prepare("UPDATE leads SET duration = ?, recording = ?, answered = ? WHERE id = ?").bind(row.duration, row.recording, row.answered, existing.id).run();
    return json({ success: true, updated: true });
  }
  await env.DB.prepare(`INSERT INTO leads (created_at,type,name,phone,message,page,referrer,gclid,utm_source,utm_medium,utm_campaign,utm_term,call_id,duration,recording,answered,tracking_number,email)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(row.created, "call", row.name, row.phone, row.message, row.page, row.referrer, row.gclid, row.utm_source, row.utm_medium, row.utm_campaign, row.utm_term, row.call_id, row.duration, row.recording, row.answered, row.tracking, "").run();
  ctx.waitUntil(notifyCall(env, { name: row.name, phone: row.phone, answered: row.answered, message: row.message, utm_source: row.utm_source, utm_campaign: row.utm_campaign, recording: row.recording }, url.origin));
  return json({ success: true });
}

async function addLead(request, env) {
  const b = await request.json().catch(() => ({}));
  const name = clean(b.name, 120), phone = clean(b.phone, 40), email = clean(b.email, 200);
  if (!name && !phone && !email) return json({ success: false, message: "Add a name, phone or email" }, 422);
  const source = clean(b.source, 60) || "Phone call";
  await env.DB.prepare(`INSERT INTO leads (type,name,email,phone,service,make,year,model,message,utm_source,utm_medium,stage)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(/call/i.test(source) ? "call" : "manual", name, email, phone, clean(b.service, 100), clean(b.make, 60), clean(b.year, 10), clean(b.model, 80), clean(b.notes, 2000), source, "manual", STAGE_KEYS.includes(b.stage) ? b.stage : "new").run();
  return json({ success: true });
}

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

  ctx.waitUntil(notify(env, lead, new URL(request.url).origin));
  return json({ success: true });
}

const SHOP = { name: "Divine Detailers", phone: "(786) 757-2826", address: "5181 NW 74th Ave, Miami, FL 33166" };
const crmLink = (env, base, path) => (env.CRM_HOST ? `https://${env.CRM_HOST}${path === "/admin" ? "/" : path.replace(/^\/admin/, "")}` : `${base}${path}`);

async function sendEmail(env, { to, subject, html, replyTo, from }) {
  if (!env.RESEND_API_KEY) return;
  const list = (Array.isArray(to) ? to : String(to || "").split(",")).map(x => x.trim()).filter(Boolean);
  if (!list.length) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: from || env.NOTIFY_FROM || "Divine Detailers <onboarding@resend.dev>", to: list, reply_to: replyTo || undefined, subject, html }),
  }).catch(() => {});
}

// SMS through Twilio (needs TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM and ALERT_SMS_TO, a comma separated list of numbers)
async function sendSms(env, to, body) {
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM) return;
  const nums = String(to || "").split(",").map(x => x.trim()).filter(Boolean);
  await Promise.all(nums.map(n => fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
    method: "POST",
    headers: { authorization: "Basic " + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: n, From: env.TWILIO_FROM, Body: body.slice(0, 600) }).toString(),
  }).catch(() => {})));
}

// one message to everyone who should react fast: email list (NOTIFY_TO) and text list (ALERT_SMS_TO)
async function alertTeam(env, { subject, text, html }) {
  await Promise.all([
    sendEmail(env, { to: env.NOTIFY_TO, subject, html }),
    sendSms(env, env.ALERT_SMS_TO, text),
  ]);
}

async function notify(env, lead, base) {
  const jobs = [];
  const veh = [lead.year, lead.make, lead.model].filter(Boolean).join(" ");
  const link = crmLink(env, base, "/admin/pipeline");
  // `text` is a ready-written line, so Zapier (or anything else) can pass it straight on as an SMS or chat message
  const line = lead.type === "newsletter" ? `Newsletter signup: ${lead.email}` : `NEW LEAD: ${lead.name}, ${lead.service}${veh ? ", " + veh : ""}. ${lead.phone}. Call now. ${link}`;
  if (env.LEAD_WEBHOOK_URL) jobs.push(fetch(env.LEAD_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...lead, text: line, crm_link: link }) }).catch(() => {}));
  if (lead.type === "newsletter") {
    jobs.push(sendEmail(env, { to: env.NOTIFY_TO, subject: `Newsletter signup: ${lead.email}`, html: `<p>${esc(lead.email)} joined the newsletter.</p>` }));
  } else {
    const rows = Object.entries(lead).filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join("");
    const text = `NEW LEAD: ${lead.name}, ${lead.service}${veh ? ", " + veh : ""}. ${lead.phone}. Call now, answer fast wins the job. ${link}`;
    const html = `<p style="font-size:16px"><b>New lead: ${esc(lead.name)}</b> &middot; ${esc(lead.service)}${veh ? " &middot; " + esc(veh) : ""}</p>
      <p><a href="tel:${esc(lead.phone)}" style="background:#32cd32;color:#04120a;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:700">Call ${esc(lead.phone)}</a>
      &nbsp; <a href="${esc(link)}">Open in CRM</a></p><table>${rows}</table>`;
    jobs.push(alertTeam(env, { subject: `New lead: ${lead.name} (${lead.service}${veh ? ", " + veh : ""})`, text, html }));
    // optional confirmation to the customer (needs a verified sending domain at Resend: set NOTIFY_FROM and AUTO_REPLY=1)
    if (env.AUTO_REPLY === "1" && lead.email) {
      jobs.push(sendEmail(env, {
        to: lead.email, replyTo: (env.NOTIFY_TO || "").split(",")[0] || undefined,
        subject: `We got your request, ${(lead.name || "").split(/\s+/)[0] || "thanks"}`,
        html: `<p>Hi ${esc((lead.name || "").split(/\s+/)[0] || "there")},</p><p>Thanks for reaching out to ${SHOP.name}. We received your request${lead.service ? " for " + esc(lead.service.toLowerCase()) : ""}${veh ? " on your " + esc(veh) : ""} and someone will contact you shortly.</p>
          <p>For the fastest answer, call or text us at <b>${SHOP.phone}</b>. We are open Mon to Sat, 9 AM to 6 PM.</p><p>${SHOP.name}<br>${SHOP.address}</p>`,
      }));
    }
  }
  await Promise.all(jobs);
}

async function notifyCall(env, row, base) {
  const missed = row.answered === 0;
  if (!missed) return; // answered calls were handled live: no alert needed
  const vm = /voicemail/i.test(row.message || "");
  const who = row.name || row.phone;
  const src = [row.utm_source, row.utm_campaign].filter(Boolean).join(" · ");
  const link = crmLink(env, base, "/admin/today");
  const text = `${vm ? "VOICEMAIL" : "MISSED CALL"} from ${who} (${row.phone})${src ? " via " + src : ""}. Call them back now. ${link}`;
  const html = `<p style="font-size:16px"><b>${vm ? "Voicemail" : "Missed call"}: ${esc(who)}</b>${src ? " &middot; " + esc(src) : ""}</p>
    <p><a href="tel:${esc(row.phone)}" style="background:#32cd32;color:#04120a;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:700">Call back ${esc(row.phone)}</a>
    &nbsp; <a href="${esc(link)}">Open today's list</a></p>${row.recording ? `<p><a href="${esc(row.recording)}">Listen to the recording</a></p>` : ""}`;
  await Promise.all([
    alertTeam(env, { subject: `${vm ? "Voicemail" : "Missed call"}: ${who}`, text, html }),
    env.LEAD_WEBHOOK_URL ? fetch(env.LEAD_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "call", ...row, text, crm_link: link }) }).catch(() => {}) : null,
  ]);
}

// ---------------------------------------------------------------- admin
// ---- sign in: a page with a password box, then a signed cookie (no browser pop-up login)
const SESSION_DAYS = 30;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
// the only two people who can sign in. Each has their own password, stored as a Cloudflare secret.
const USERS = { giordani: "PASSWORD_GIORDANI", bronson: "PASSWORD_BRONSON" };
const passwordOf = (env, user) => (Object.hasOwn(USERS, user) ? env[USERS[user]] || (user === "bronson" ? env.ADMIN_PASSWORD : "") || "" : "");
const anyPassword = env => Object.keys(USERS).some(u => passwordOf(env, u));
async function sign(pw, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("dd-session|" + pw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const cookieOf = (request, name) => (request.headers.get("cookie") || "").split(/;\s*/).map(c => c.split(/=(.*)/s)).find(c => c[0] === name)?.[1] || "";
// returns the signed-in username, false, or "unconfigured"
async function authed(request, env) {
  if (!anyPassword(env)) return "unconfigured";
  const [user = "", exp = "", sig = ""] = cookieOf(request, "dd_session").split(".");
  const pw = passwordOf(env, user);
  if (!pw || !/^\d{10,}$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  return same(sig, await sign(pw, user + "|" + exp)) ? user : false;
}
const safeNext = n => (typeof n === "string" && /^\/(?!\/)[\w\-./?=&%#]*$/.test(n) && !n.startsWith("/login") ? n : "/");
const loginHtml = (err, next, user = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Sign in | Divine Detailers</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07090c;color:#e8eaed;font:16px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;padding:20px}
.box{width:min(380px,100%);background:#0d1116;border:1px solid #1d2229;border-radius:18px;padding:28px 24px;display:flex;flex-direction:column;gap:16px}
h1{margin:0;font-size:22px}h1 b{color:#32cd32}p{margin:0;color:#8a9099;font-size:14px}label{display:block;color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:6px}
input{width:100%;background:#12171e;border:1px solid #2a313a;color:#fff;border-radius:12px;padding:14px;font:inherit;min-height:50px}input:focus{outline:2px solid #32cd32;outline-offset:1px}
button{background:#32cd32;border:0;color:#04120a;border-radius:12px;padding:14px;font:inherit;font-weight:700;min-height:50px;cursor:pointer}.err{background:#3b1d1d;color:#ff9a9a;border-radius:10px;padding:10px 12px;font-size:14px}</style></head>
<body><form class="box" method="post" action="/login"><h1>Divine Detailers <b>CRM</b></h1><p>Sign in to see your leads.</p>${err ? `<div class="err" role="alert">${esc(err)}</div>` : ""}
<div><label for="u">Username</label><input id="u" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(user)}" ${user ? "" : "autofocus"} required></div>
<div><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" ${user ? "autofocus" : ""} required></div><input type="hidden" name="next" value="${esc(next || "/")}"><button type="submit">Sign in</button></form></body></html>`;
const htmlRes = (body, status = 200, extra = {}) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...extra } });
async function loginRoute(p, request, env) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  if (p === "/logout") return new Response(null, { status: 302, headers: { location: "/login", "set-cookie": `dd_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`, "cache-control": "no-store" } });
  if (!anyPassword(env)) return new Response("Sign in is not set up yet. Add the PASSWORD_GIORDANI and PASSWORD_BRONSON secrets.", { status: 503 });
  const url = new URL(request.url);
  if (request.method !== "POST") return htmlRes(loginHtml("", safeNext(url.searchParams.get("next"))));
  const form = await request.formData().catch(() => null);
  const next = safeNext(form && form.get("next"));
  const pass = String((form && form.get("password")) || "");
  const user = String((form && form.get("username")) || "").trim().toLowerCase();
  // slow down guessing: 8 failures per 15 minutes per address
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (env.DB) {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS login_fails (ip TEXT, at INTEGER)").run();
    const since = Math.floor(Date.now() / 1000) - 900;
    const r = await env.DB.prepare("SELECT COUNT(*) n FROM login_fails WHERE ip = ? AND at > ?").bind(ip, since).first();
    if (r && r.n >= 8) return htmlRes(loginHtml("Too many tries. Wait a few minutes and try again.", next), 429);
  }
  const pw = passwordOf(env, user);
  if (!pw || !same(pass, pw)) {
    if (env.DB) await env.DB.prepare("INSERT INTO login_fails (ip, at) VALUES (?, ?)").bind(ip, Math.floor(Date.now() / 1000)).run();
    return htmlRes(loginHtml("That username or password is not right.", next, user), 401);
  }
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400);
  return new Response(null, { status: 303, headers: { location: next, "set-cookie": `dd_session=${user}.${exp}.${await sign(pw, user + "|" + exp)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure}`, "cache-control": "no-store" } });
}

const mmss = n => (n || n === 0 ? `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}` : "");
function callTag(l) {
  if (l.type !== "call") return "";
  if (/voicemail/i.test(l.message || "")) return '<span class="tag miss">Voicemail</span>';
  if (l.answered === 0) return '<span class="tag miss">Missed call</span>';
  return `<span class="tag call">Call${l.duration ? " · " + mmss(l.duration) : ""}</span>`;
}

// ---- "what's next?" dialog shared by the leads list and the pipeline (optional, can be skipped)
const FOLLOW_CSS = `.rdlg{background:#0f1319;color:#e8eaed;border:1px solid #2a313a;border-radius:16px;padding:0;width:min(480px,94vw);max-height:92vh;overflow:auto}.rdlg::backdrop{background:rgba(0,0,0,.7)}
.rdlg .rb{padding:18px 20px 20px;display:flex;flex-direction:column;gap:12px}.rdlg h3{margin:0;font-size:18px}.rdlg p{margin:0;color:#98a0aa;font-size:14px}.rdlg label{display:block;color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:4px}
.rdlg input{width:100%;background:#12171e;border:1px solid #2a313a;color:#fff;border-radius:10px;padding:12px;font:inherit;font-size:16px;min-height:48px;color-scheme:dark}
.fu-chips{display:flex;flex-wrap:wrap;gap:8px}.fu-chips button{padding:9px 13px;border-radius:12px;border:1px solid #2a313a;background:#12171e;color:#e8eaed;font:inherit;font-size:14px;cursor:pointer;min-height:44px;text-align:left}.fu-chips button small{display:block;color:#7c838d;font-size:11.5px}
.fu-chips button.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}.fu-chips button.on small{color:#0b3d12}.fu-chips button.mv{border-color:#4a3a2a}
.rdlg .ra{display:flex;gap:8px;justify-content:flex-end}.rdlg .ra button{border:1px solid #2a313a;background:#151a21;color:#e8eaed;border-radius:10px;padding:12px 16px;font:inherit;font-weight:700;cursor:pointer;min-height:46px}.rdlg .ra .ok{background:#32cd32;border-color:#32cd32;color:#04120a}.rdlg .ra .ok:disabled{opacity:.4;cursor:default}`;
const FOLLOW_HTML = `<dialog class="rdlg" id="rdlg"><div class="rb"><h3 id="rt"></h3><p id="rs"></p><div><label>Next step</label><div class="fu-chips" id="rg"></div></div><div><label>Follow up on (optional)</label><input id="rd" type="date"></div><div class="ra"><button type="button" id="rc">Skip</button><button type="button" class="ok" id="ro" disabled>Save</button></div></div></dialog>`;
const FOLLOW_JS = `
const FU=${JSON.stringify(FOLLOWUPS)},STG=Object.fromEntries(${JSON.stringify(STAGES)});
function askNext(name,stage){return new Promise(res=>{const d=document.getElementById('rdlg'),ok=document.getElementById('ro'),di=document.getElementById('rd'),g=document.getElementById('rg');let pick='';
  document.getElementById('rt').textContent='What is next for '+(name||'this lead')+'?';document.getElementById('rs').textContent='Now in: '+STG[stage]+'. Pick the next step, or skip.';
  g.innerHTML='';(FU[stage]||[]).forEach(([l,mv])=>{const b=document.createElement('button');b.type='button';if(mv)b.className='mv';b.innerHTML=l.replace(/&/g,'&amp;').replace(/</g,'&lt;')+(mv?'<small>moves to '+STG[mv]+'</small>':'');b.onclick=()=>{pick=l;g.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));ok.disabled=false};g.appendChild(b)});
  di.value='';di.oninput=()=>{ok.disabled=!pick&&!di.value};ok.disabled=true;let done=false;const fin=v=>{if(done)return;done=true;d.close();res(v)};
  ok.onclick=()=>fin({followup:pick,follow_date:di.value});document.getElementById('rc').onclick=()=>fin(null);d.oncancel=()=>fin(null);d.showModal()})}`;

const stageName = k => (STAGES.find(x => x[0] === k) || [k, k])[1];
const crmPrefix = env => ""; // paths are the same on every host
const badge = n => (n ? `<i class="nb">${n > 99 ? "99+" : n}</i>` : "");
function nav(on, n = 0) {
  return `<nav class="navtabs"><a href="/admin/today" class="${on === "today" ? "on" : ""}">Today${badge(n)}</a><a href="/admin" class="${on === "leads" ? "on" : ""}">Leads</a><a href="/admin/pipeline" class="${on === "pipeline" ? "on" : ""}">Pipeline</a><a href="/logout" class="so">Sign out</a></nav>`;
}
// phone: thumb-reach tab bar fixed to the bottom of the screen
function bnav(on, n = 0) {
  return `<nav class="bnav" aria-label="Sections"><a href="/admin/today" class="${on === "today" ? "on" : ""}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM9 9l2 2 4-4M9 15h6"/></svg>Today${badge(n)}</a><a href="/admin" class="${on === "leads" ? "on" : ""}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>Leads</a><a href="/admin/pipeline" class="${on === "pipeline" ? "on" : ""}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z"/></svg>Pipeline</a></nav>`;
}
const cfgOf = env => ({ shop: SHOP.name, phone: SHOP.phone, address: SHOP.address, review: env.GOOGLE_REVIEW_URL || "" });
const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
async function todayCount(env) {
  try {
    await ensureTable(env.DB);
    const r = await env.DB.prepare("SELECT COUNT(*) n FROM leads WHERE type != 'newsletter' AND (stage = 'new' OR (COALESCE(follow_up_date,'') != '' AND follow_up_date <= ? AND stage NOT IN ('done','lost')))").bind(todayStr()).first();
    return r ? r.n : 0;
  } catch { return 0; }
}
const BNAV_CSS = `.bnav{display:none}.nb{font-style:normal;background:#ff5d5d;color:#fff;border-radius:999px;font-size:11px;font-weight:700;padding:1px 7px;margin-left:6px}.navtabs a.on .nb,.bnav a.on .nb{background:#04120a;color:#32cd32}.bnav .nb{margin:0;position:absolute;top:2px;right:calc(50% - 26px)}.bnav a{position:relative}
@media(max-width:700px){
  .navtabs{display:none!important}
  .bnav{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:30;background:rgba(10,13,17,.97);backdrop-filter:blur(8px);border-top:1px solid #1d2229;padding:6px 10px calc(6px + env(safe-area-inset-bottom,0px));gap:8px}
  .bnav a{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 0;border-radius:12px;color:#8a9099;text-decoration:none;font-size:12px;font-weight:600;min-height:52px;justify-content:center}
  .bnav a.on{color:#04120a;background:#32cd32}.bnav a{min-width:0}.bnav svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  body{padding-bottom:calc(76px + env(safe-area-inset-bottom,0px))}
}`;

// one-tap replies. Merge fields: {first} {service} {vehicle} {shop} {phone} {address} {review}
const TEMPLATES = [
  { id: "first", label: "First reply", subject: "Your {service} request at {shop}", body: "Hi {first}, this is {shop}. Thanks for reaching out about {service} for {vehicle}. Do you have a minute to go over options and pricing? Call or text me anytime at {phone}." },
  { id: "missed", label: "Sorry we missed your call", subject: "Sorry we missed your call", body: "Hi {first}, sorry we missed your call! This is {shop}. What can we help you with? Reply here or call us back at {phone}." },
  { id: "quote", label: "Quote follow-up", subject: "Following up on your {service} quote", body: "Hi {first}, just following up on the {service} quote for {vehicle}. Any questions I can answer? Happy to get you on the schedule." },
  { id: "invoice", label: "Invoice sent", subject: "Your invoice from {shop}", body: "Hi {first}, your invoice for {service} on {vehicle} is on its way. Let us know when you have seen it and we will lock in your date." },
  { id: "booked", label: "Booking confirmed", subject: "You are booked with {shop}", body: "Hi {first}, you are booked for {service} on {vehicle}. We are at {address}. Text us here if anything changes." },
  { id: "ready", label: "Ready for pickup", subject: "Your vehicle is ready", body: "Hi {first}, your {vehicle} is ready for pickup at {address}. We are open Mon to Sat, 9 AM to 6 PM." },
  { id: "review", label: "Ask for a review", subject: "How did we do?", body: "Hi {first}, thank you for trusting {shop} with your {vehicle}! If you are happy with the work, a quick Google review helps a lot: {review}" },
  { id: "checkin", label: "Checking in", subject: "Checking in", body: "Hi {first}, just checking in. Still thinking about {service}? Glad to answer any questions." },
];
// which templates to suggest first, by stage
const TPL_BY_STAGE = { new: ["first", "missed"], contacted: ["quote", "checkin"], quoted: ["quote", "invoice", "checkin"], booked: ["booked"], working: ["ready"], done: ["review"], lost: ["checkin"] };
const TPL_JS = `
const TPL=${JSON.stringify(TEMPLATES)},TBS=${JSON.stringify(TPL_BY_STAGE)};
function tplFill(t,l){const veh=[l.year,l.make,l.model].filter(Boolean).join(' ')||'your vehicle',first=(l.name||'').trim().split(/\\s+/)[0];
  const v={first:first&&!/^\\+?[\\d\\s()-]+$/.test(first)?first:'there',service:(l.service||'our services').toLowerCase(),vehicle:/your/.test(veh)?veh:'your '+veh,shop:CFG.shop,phone:CFG.phone,address:CFG.address,review:CFG.review||''};
  const f=x=>x.replace(/\\{(\\w+)\\}/g,(m,k)=>v[k]===undefined?m:v[k]).replace(/\\s+/g,' ').trim();return {subject:f(t.subject),body:f(t.body)}}
function tplFor(l){const ids=(l.type==='call'&&l.answered===0&&l.stage==='new')?['missed','first']:(TBS[l.stage]||['first']);return ids.map(i=>TPL.find(t=>t.id===i)).filter(Boolean).concat(TPL.filter(t=>!ids.includes(t.id)))}
function smsHref(phone,body){return 'sms:'+(phone||'').replace(/[^\\d+]/g,'')+'?&body='+encodeURIComponent(body)}
function mailHref(email,subj,body){return 'mailto:'+email+'?subject='+encodeURIComponent(subj)+'&body='+encodeURIComponent(body)}
`;

const TZ = "America/New_York";
function when(sqlUtc) {
  const d = new Date(sqlUtc.replace(" ", "T") + "Z");
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const ago = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} hr ago` : `${Math.round(mins / 1440)} d ago`;
  const abs = d.toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return { ago, abs };
}
function sourceOf(l) {
  if (l.type === "call" && !l.gclid && l.utm_medium !== "cpc") {
    const g = /google ads|adwords|ppc|paid/i.test(l.utm_source || "");
    return { label: g ? "Google Ads" : (l.utm_source || "Phone call"), ad: g, detail: [l.utm_campaign, l.utm_term].filter(Boolean).join(" · ") };
  }
  if (l.gclid || l.utm_medium === "cpc") return { label: "Google Ads", ad: true, detail: [l.utm_campaign, l.utm_term].filter(Boolean).join(" · ") };
  if (l.utm_source) return { label: l.utm_source, ad: false, detail: l.utm_campaign || "" };
  if (l.referrer) { try { return { label: new URL(l.referrer).hostname.replace(/^www\./, ""), ad: false, detail: "" }; } catch { /* ignore */ } }
  return { label: "Direct", ad: false, detail: "" };
}

async function adminPage(env) {
  await ensureTable(env.DB);
  const tc = await todayCount(env);
  const { results } = await env.DB.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT 500").all();
  const open = results.filter(l => l.stage === "new" && l.type === "quote").length;
  const ads = results.filter(l => sourceOf(l).ad).length;
  const cards = results.map(l => {
    const t = when(l.created_at), src = sourceOf(l);
    const veh = [l.year, l.make, l.model].filter(Boolean).join(" ");
    const tel = (l.phone || "").replace(/[^\d+]/g, "");
    return `<article class="lead ${["done", "lost"].includes(l.stage) ? "done" : l.stage === "new" ? "new" : ""}" data-q="${esc([l.name, l.email, l.phone, l.service, veh, l.message, src.label, src.detail].join(" ").toLowerCase())}" data-st="${l.stage === "new" ? "new" : "done"}" data-ad="${src.ad ? 1 : 0}">
      <div class="top"><div><h3>${esc(l.name || l.email)}</h3><div class="when" title="${esc(t.abs)} ET">${esc(t.ago)} &middot; ${esc(t.abs)}</div></div>
        <div class="tags">${l.type === "newsletter" ? '<span class="tag nl">Newsletter</span>' : ""}${callTag(l)}<span class="tag ${src.ad ? "ad" : ""}">${esc(src.label)}</span>${l.type === "newsletter" ? "" : l.stage === "new" ? '<span class="tag hot">New</span>' : `<span class="tag ok">${esc(stageName(l.stage))}</span>`}${l.follow_up ? `<span class="tag fu">${esc(l.follow_up)}</span>` : ""}</div></div>
      <div class="grid">
        ${l.service ? `<div><label>Service</label>${esc(l.service)}${l.also_interested ? `<small>also: ${esc(l.also_interested)}</small>` : ""}</div>` : ""}
        ${veh ? `<div><label>Vehicle</label>${esc(veh)}</div>` : ""}
        ${src.detail ? `<div><label>Campaign</label>${esc(src.detail)}</div>` : ""}
        ${l.page ? `<div><label>Landed on</label>${esc(l.page)}</div>` : ""}
      </div>
      ${l.message ? `<p class="msg">&ldquo;${esc(l.message)}&rdquo;</p>` : ""}
      ${l.recording ? `<a class="rec" href="${esc(l.recording)}" target="_blank" rel="noopener">Listen to the call</a>` : ""}
      <div class="actions">${tel ? `<a class="btn call" href="tel:${esc(tel)}">Call ${esc(l.phone)}</a>` : ""}<a class="btn" href="mailto:${esc(l.email)}">Email</a>
        <select class="btn stage" data-id="${l.id}" data-cur="${l.stage}" aria-label="Stage">${STAGES.map(([k, n]) => `<option value="${k}"${k === l.stage ? " selected" : ""}>${n}</option>`).join("")}</select></div>
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
${BNAV_CSS}
${FOLLOW_CSS}
.chip.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
.csv{color:#cfd3d9;text-decoration:none;border:1px solid #232932;border-radius:10px;padding:10px 14px}
main{padding:0 22px 40px;display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px}
.lead{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px}.lead.new{border-color:#244d2a}.lead.done{opacity:.6}
.top{display:flex;justify-content:space-between;gap:10px}h3{margin:0;font-size:17px}.when{color:#8a9099;font-size:12.5px;margin-top:2px}
.tags{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;align-content:flex-start}.tag{font-size:11.5px;padding:3px 9px;border-radius:999px;background:#171c23;color:#aab0b9;white-space:nowrap}
.tag.ad{background:#14263f;color:#8ec0ff}.tag.call{background:#2a1f3d;color:#c9a8ff}.tag.fu{background:#2a1f3d;color:#c9a8ff}.tag.miss{background:#3b1d1d;color:#ff9a9a;font-weight:700}.rec{color:#8ec0ff;font-size:13px}.tag.hot{background:#32cd32;color:#04120a;font-weight:700}.tag.ok{background:#1a2a1c;color:#7fe07f}.tag.nl{background:#2b2411;color:#f0c050}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}label{display:block;color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:1px}small{display:block;color:#8a9099}
.msg{margin:0;background:#10141a;border-left:3px solid #32cd32;padding:10px 12px;border-radius:0 8px 8px 0;color:#d6d9de}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:auto}.btn{border:1px solid #2a313a;background:#151a21;color:#e8eaed;border-radius:10px;padding:10px 13px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.btn.call{background:#32cd32;border-color:#32cd32;color:#04120a}.btn.go{background:#1d2630}.btn.ghost{color:#8a9099}
.empty{grid-column:1/-1;color:#8a9099;padding:40px 0;text-align:center}
@media(max-width:700px){
  header{padding:12px 14px;position:static;gap:8px}h1{font-size:17px}
  .stats{width:100%;gap:8px}.stat{flex:1;padding:8px 10px}
  .tools{position:sticky;top:0;z-index:6;background:rgba(7,9,12,.97);padding:10px 14px;flex-wrap:nowrap;overflow-x:auto;gap:8px;-webkit-overflow-scrolling:touch;scrollbar-width:none}.tools::-webkit-scrollbar{display:none}
  input[type=search]{flex:0 0 62vw;min-width:0;font-size:16px;padding:12px 14px}.chip,.csv{flex:0 0 auto;white-space:nowrap;min-height:44px;padding:0 16px;display:inline-flex;align-items:center}
  main{grid-template-columns:1fr;padding:6px 14px 20px;gap:12px}.lead{padding:14px;gap:12px}
  .actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.actions .call{grid-column:1/-1;text-align:center;padding:14px;font-size:16px}
  .actions .btn,.actions select{min-height:46px;font-size:15px;text-align:center;display:flex;align-items:center;justify-content:center}.actions select.stage{text-align:left;display:block}
  .grid{grid-template-columns:1fr 1fr}
}
</style></head>
<body><header><h1>Divine Detailers <b>leads</b></h1>${nav("leads", tc)}
<div class="stats"><div class="stat hot"><b>${open}</b><span>to contact</span></div><div class="stat"><b>${results.length}</b><span>total</span></div><div class="stat"><b>${ads}</b><span>from Google Ads</span></div></div></header>
<div class="tools"><input type="search" id="q" placeholder="Search name, phone, vehicle, service..."><button class="chip on" data-f="all">All</button><button class="chip" data-f="new">New</button><button class="chip" data-f="done">Worked</button><button class="chip" data-f="ad">Google Ads</button><a class="csv" href="/admin/pipeline#add">+ Add lead</a><a class="csv" href="/admin/leads.csv">Download CSV</a></div>
${bnav("leads", tc)}
${FOLLOW_HTML}
<main id="list">${cards || '<p class="empty">No leads yet. They will appear here the moment someone submits a form.</p>'}</main>
<script>
const list=document.getElementById('list'),q=document.getElementById('q');let f='all';
function apply(){const t=q.value.trim().toLowerCase();list.querySelectorAll('.lead').forEach(e=>{const ok=(!t||e.dataset.q.includes(t))&&(f==='all'||(f==='ad'?e.dataset.ad==='1':e.dataset.st===f));e.hidden=!ok})}
q.addEventListener('input',apply);document.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{document.querySelectorAll('.chip').forEach(x=>x.classList.toggle('on',x===c));f=c.dataset.f;apply()}));
${FOLLOW_JS}
const post=(u,b)=>fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
document.addEventListener('change',async e=>{const s=e.target.closest('select.stage');if(!s)return;const to=s.value,id=+s.dataset.id;const nm=(s.closest('.lead').querySelector('h3')||{}).textContent;s.disabled=true;
  const r=await post('/admin/stage',{id,stage:to});if(!r.ok){s.disabled=false;s.value=s.dataset.cur;return}const nx=await askNext(nm,to);if(nx)await post('/admin/stage',{id,followup:nx.followup,follow_date:nx.follow_date});location.reload()});
</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}


async function pipelinePage(env) {
  await ensureTable(env.DB);
  const tc = await todayCount(env);
  const { results } = await env.DB.prepare("SELECT id,created_at,type,name,email,phone,service,also_interested,make,year,model,message,page,referrer,gclid,utm_medium,utm_source,utm_campaign,utm_term,stage,value,notes,stage_changed_at,follow_up,follow_up_date,duration,recording,answered FROM leads WHERE type != 'newsletter' ORDER BY id DESC LIMIT 1000").all();
  const logs = (await env.DB.prepare("SELECT lead_id,from_stage,to_stage,reason,at FROM stage_log ORDER BY id DESC LIMIT 5000").all()).results;
  const byLead = {}; for (const g of logs) (byLead[g.lead_id] = byLead[g.lead_id] || []).push(g);
  const data = results.map(l => ({ ...l, followup: l.follow_up || "", log: (byLead[l.id] || []).map(g => ({ ...g, at: when(g.at).abs })), dur: mmss(l.duration), ago: when(l.created_at).ago, abs: when(l.created_at).abs, src: sourceOf(l).label, ad: sourceOf(l).ad, detail: sourceOf(l).detail }));
  const payload = JSON.stringify({ stages: STAGES, today: todayStr(), cfg: cfgOf(env), leads: data }).replace(/</g, "\\u003c");
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
.pill{font-size:11px;padding:2px 8px;border-radius:999px;background:#171c23;color:#aab0b9}.pill.ad{background:#14263f;color:#8ec0ff}.pill.val{background:#16301a;color:#7fe07f;font-weight:700}.pill.call{background:#2a1f3d;color:#c9a8ff}.pill.miss{background:#3b1d1d;color:#ff9a9a;font-weight:700}
details.ed{border:1px solid #232a33;border-radius:12px;padding:10px 12px}details.ed summary{cursor:pointer;font-weight:600;color:#c3c8cf;min-height:30px;display:flex;align-items:center}details.ed .g2{margin-top:10px}.rec{color:#8ec0ff}.addb{background:#32cd32;color:#04120a;border:0;border-radius:999px;padding:9px 16px;font:inherit;font-weight:800;cursor:pointer}
.empty{color:#586069;font-size:13px;text-align:center;padding:14px 0}
dialog{background:#0f1319;color:#e8eaed;border:1px solid #2a313a;border-radius:16px;padding:0;width:min(520px,94vw);max-height:92vh;overflow:auto}dialog::backdrop{background:rgba(0,0,0,.65)}
.dh{display:flex;justify-content:space-between;gap:10px;padding:18px 20px 6px}.dh h3{margin:0;font-size:20px}.x{background:none;border:0;color:#8a9099;font-size:26px;cursor:pointer;line-height:1}
.db{padding:6px 20px 20px;display:flex;flex-direction:column;gap:12px}.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}label{display:block;color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:2px}
.msg{margin:0;background:#12171e;border-left:3px solid #32cd32;padding:10px 12px;border-radius:0 8px 8px 0;color:#d6d9de}
select,input,textarea{width:100%;background:#12171e;border:1px solid #2a313a;color:#fff;border-radius:10px;padding:10px 12px;font:inherit}textarea{min-height:84px;resize:vertical}
.acts{display:flex;gap:8px;flex-wrap:wrap}.btn{border:1px solid #2a313a;background:#151a21;color:#e8eaed;border-radius:10px;padding:10px 14px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}.btn.call{background:#32cd32;border-color:#32cd32;color:#04120a}.btn.go{background:#32cd32;border-color:#32cd32;color:#04120a;margin-left:auto}
${BNAV_CSS}
${FOLLOW_CSS}
.rp{display:flex;flex-direction:column;gap:8px}.next{margin-top:8px;font-size:13px;color:#c9a8ff}.next.late{color:#ff9a9a;font-weight:700}
.hist{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}.hist li{font-size:13.5px;color:#cfd3d9;border-left:2px solid #2a313a;padding-left:10px}.hist small{display:block;color:#7c838d;font-size:12px}
.tabs{display:none}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chips button{padding:8px 13px;border-radius:999px;border:1px solid #2a313a;background:#12171e;color:#e8eaed;font:inherit;cursor:pointer}.chips button.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
@media(max-width:700px){
  body{height:auto;min-height:100%;display:block}
  header{padding:12px 14px 8px}h1{font-size:17px}.sum{width:100%;gap:8px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}.stat{flex:1 0 auto}
  .tabs{display:flex;gap:8px;overflow-x:auto;padding:8px 14px 10px;position:sticky;top:0;z-index:6;background:rgba(7,9,12,.97);border-bottom:1px solid #1b1f25;scrollbar-width:none;-webkit-overflow-scrolling:touch}.tabs::-webkit-scrollbar{display:none}
  .tab{flex:0 0 auto;display:flex;align-items:center;gap:7px;min-height:44px;padding:0 15px;border-radius:999px;border:1px solid #232932;background:#10141a;color:#c3c8cf;font:inherit;font-weight:600;cursor:pointer}
  .tab i{font-style:normal;background:#1c222a;color:#aab0b9;border-radius:999px;padding:1px 8px;font-size:12px}.tab.on{background:#32cd32;border-color:#32cd32;color:#04120a}.tab.on i{background:rgba(0,0,0,.18);color:#04120a}
  .board{display:block;padding:12px 14px 24px;overflow:visible}.col{max-width:none;border:0;background:none}.col h2{padding:4px 2px 10px}.cards{padding:0;overflow:visible;gap:12px}
  .card{padding:14px;cursor:pointer}.card b{font-size:17px}.card .meta{font-size:14px}.card .row{font-size:13px;margin-top:10px}.pill{font-size:12px;padding:3px 9px}
  .qa{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.qa a,.qa button{min-height:46px;border-radius:11px;border:1px solid #2a313a;background:#151a21;color:#e8eaed;font:inherit;font-weight:700;text-decoration:none;display:flex;align-items:center;justify-content:center;cursor:pointer}.qa .call{background:#32cd32;border-color:#32cd32;color:#04120a}
  dialog{width:100vw;max-width:100vw;margin:auto 0 0;border-radius:18px 18px 0 0;max-height:94vh}
  .db{padding-bottom:calc(20px + env(safe-area-inset-bottom,0px))}.dh h3{font-size:21px}.x{font-size:34px;padding:0 8px;min-height:44px}
  select,input,textarea{font-size:16px;min-height:48px}textarea{min-height:100px}.btn{min-height:48px}.btn{display:flex;align-items:center;justify-content:center}.acts .btn{flex:1}.acts .btn.call{flex:1 1 100%;font-size:17px}
  .chips{display:flex;flex-wrap:wrap;gap:8px}.chips button{min-height:44px;padding:0 14px;border-radius:999px;border:1px solid #2a313a;background:#12171e;color:#e8eaed;font:inherit;cursor:pointer}.chips button.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
}
</style></head><body>
<header><h1>Divine Detailers <b>pipeline</b></h1>${nav("pipeline", tc)}<div class="sum" id="sum"></div><button class="addb" id="addb" type="button">+ Add lead</button></header>
<div class="tabs" id="tabs"></div>
${bnav("pipeline", tc)}
<div class="board" id="board"></div>
<dialog id="dlg"></dialog>
${FOLLOW_HTML}
<script type="application/json" id="data">${payload}</script>
<script>
${FOLLOW_JS}
${TPL_JS}
const D=JSON.parse(document.getElementById('data').textContent),S=D.stages,L=D.leads,CFG=D.cfg,board=document.getElementById('board'),dlg=document.getElementById('dlg');
const $=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),money=n=>n?'$'+Number(n).toLocaleString('en-US'):'';
const M=window.matchMedia('(max-width:700px)');let cur='new';
function cardHtml(l,qa){const tel=(l.phone||'').replace(/[^\\d+]/g,'');return '<article class="card" draggable="'+(M.matches?'false':'true')+'" data-id="'+l.id+'"><b>'+$(l.name||l.email)+'</b><div class="meta">'+$(l.service||'')+(l.make?' &middot; '+$([l.year,l.make,l.model].filter(Boolean).join(' ')):'')+'</div><div class="row"><span>'+$(l.ago)+'</span><span>'+(l.type==='call'?(/voicemail/i.test(l.message||'')?'<span class="pill miss">Voicemail</span> ':l.answered===0?'<span class="pill miss">Missed</span> ':'<span class="pill call">Call</span> '):'')+(l.ad?'<span class="pill ad">Ads</span> ':'')+(l.value?'<span class="pill val">'+money(l.value)+'</span>':'')+'</span></div>'+(qa&&tel?'<div class="qa"><a class="call" href="tel:'+$(tel)+'" data-stop="1">Call</a><button type="button" data-open="'+l.id+'">Details</button></div>':'')+'</article>'}
function draw(){
  let open=0,won=0,booked=0;
  S.forEach(([k])=>{const ls=L.filter(l=>l.stage===k),tot=ls.reduce((a,l)=>a+(l.value||0),0);if(k==='new')open=ls.length;if(k==='booked'||k==='working'||k==='done')booked+=tot;if(k==='done')won=tot});
  document.getElementById('sum').innerHTML='<div class="stat g"><b>'+open+'</b><span>new to contact</span></div><div class="stat"><b>'+money(booked)+'</b><span>booked + done</span></div><div class="stat"><b>'+money(won)+'</b><span>completed</span></div>';
  const tabs=document.getElementById('tabs');
  if(M.matches){
    tabs.innerHTML=S.map(([k,n])=>'<button class="tab'+(k===cur?' on':'')+'" data-tab="'+k+'">'+n+' <i>'+L.filter(l=>l.stage===k).length+'</i></button>').join('');
    const ls=L.filter(l=>l.stage===cur),tot=ls.reduce((a,l)=>a+(l.value||0),0),name=(S.find(x=>x[0]===cur)||[0,''])[1];
    board.innerHTML='<section class="col" data-stage="'+cur+'"><h2>'+name+' <small>'+ls.length+(tot?' &middot; '+money(tot):'')+'</small></h2><div class="cards">'+(ls.map(l=>cardHtml(l,true)).join('')||'<div class="empty">Nothing in '+$(name)+' right now</div>')+'</div></section>';
    const on=tabs.querySelector('.tab.on');if(on&&on.scrollIntoView)on.scrollIntoView({inline:'center',block:'nearest'});
    return;
  }
  tabs.innerHTML='';
  board.innerHTML=S.map(([k,n])=>{const ls=L.filter(l=>l.stage===k),tot=ls.reduce((a,l)=>a+(l.value||0),0);
    return '<section class="col s-'+k+'" data-stage="'+k+'"><h2>'+n+' <small>'+ls.length+(tot?' &middot; '+money(tot):'')+'</small></h2><div class="cards">'+
    (ls.map(l=>cardHtml(l,false)).join('')||'<div class="empty">Drop leads here</div>')+'</div></section>';}).join('');
}
M.addEventListener&&M.addEventListener('change',draw);
document.getElementById('tabs').addEventListener('click',e=>{const t=e.target.closest('[data-tab]');if(t){cur=t.dataset.tab;draw();window.scrollTo({top:0})}});
const SN=k=>(S.find(x=>x[0]===k)||[0,k])[1];const TODAY=D.today;const fmtD=d=>{const p=d.split('-');return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+p[1]-1]+' '+(+p[2])};
async function save(id,patch,url){const r=await fetch(url||'/admin/lead',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({id},patch))});if(!r.ok)return false;try{return await r.json()}catch(_){return {success:true}}}
function apply(l,o){if(o&&o.stage){l.stage=o.stage;l.followup=o.followup||'';l.follow_up_date=o.follow_up_date||''}}
let dragId=null;
board.addEventListener('dragstart',e=>{const c=e.target.closest('.card');if(!c)return;dragId=+c.dataset.id;c.classList.add('drag');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(dragId))});
board.addEventListener('dragend',()=>{dragId=null;draw()});
board.addEventListener('dragover',e=>{const c=e.target.closest('.col');if(!c)return;e.preventDefault();board.querySelectorAll('.col.over').forEach(x=>x!==c&&x.classList.remove('over'));c.classList.add('over')});
board.addEventListener('drop',async e=>{const c=e.target.closest('.col');if(!c||dragId==null)return;e.preventDefault();const l=L.find(x=>x.id===dragId);const st=c.dataset.stage;if(l&&l.stage!==st){const o=await save(l.id,{stage:st},'/admin/stage');if(o){apply(l,o);draw();const nx=await askNext(l.name||l.phone||l.email,l.stage);if(nx){const o2=await save(l.id,{followup:nx.followup,follow_date:nx.follow_date},'/admin/stage');apply(l,o2)}}draw()}else draw()});
board.addEventListener('click',e=>{if(e.target.closest('[data-stop]'))return;const d=e.target.closest('[data-open]');if(d){open(+d.dataset.open);return}const c=e.target.closest('.card');if(c)open(+c.dataset.id)});
const SVC=['Window Tint','PPF / Clear Bra','Ceramic Coating','Paint Correction','Vinyl Wraps','Exterior Detailing','Other'];
function open(id){const l=L.find(x=>x.id===id);if(!l)return;const tel=(l.phone||'').replace(/[^\\d+]/g,''),veh=[l.year,l.make,l.model].filter(Boolean).join(' '),isCall=l.type==='call';
  const ed='<details class="ed"'+((isCall||!l.service)?' open':'')+'><summary>Edit contact and vehicle</summary><div class="g2"><div><label>Name</label><input id="en" value="'+$(l.name||'')+'" autocomplete="off"></div><div><label>Phone</label><input id="ep" type="tel" inputmode="tel" value="'+$(l.phone||'')+'"></div><div><label>Email</label><input id="ee" type="email" value="'+$(l.email||'')+'"></div><div><label>Service</label><select id="es"><option value="">Not set</option>'+SVC.map(x=>'<option'+(x===l.service?' selected':'')+'>'+x+'</option>').join('')+'</select></div><div><label>Make</label><input id="em" value="'+$(l.make||'')+'"></div><div><label>Model</label><input id="ed2" value="'+$(l.model||'')+'"></div><div><label>Year</label><input id="ey" inputmode="numeric" value="'+$(l.year||'')+'"></div></div></details>';
  dlg.innerHTML='<div class="dh"><div><h3>'+$(l.name||l.phone||l.email||'Unknown caller')+'</h3><div style="color:#8a9099;font-size:13px">'+$(l.ago)+' &middot; '+$(l.abs)+' ET &middot; '+$(l.src)+'</div></div><button class="x" onclick="dlg.close()" aria-label="Close">&times;</button></div><div class="db">'+
  (isCall?'<div style="color:#c9a8ff;font-size:14px">'+(/voicemail/i.test(l.message||'')?'Voicemail':l.answered===0?'Missed call':'Phone call'+(l.dur?' &middot; '+$(l.dur):''))+(l.recording?' &middot; <a class="rec" href="'+$(l.recording)+'" target="_blank" rel="noopener">Listen to the call</a>':'')+'</div>':'')+
  '<div class="g2"><div><label>Service</label>'+$(l.service||'-')+(l.also_interested?'<div style="color:#8a9099;font-size:13px">also: '+$(l.also_interested)+'</div>':'')+'</div><div><label>Vehicle</label>'+$(veh||'-')+'</div>'+(l.detail?'<div><label>Campaign</label>'+$(l.detail)+'</div>':'')+(l.page?'<div><label>Landed on</label>'+$(l.page)+'</div>':'')+'</div>'+
  (l.message?'<p class="msg">&ldquo;'+$(l.message)+'&rdquo;</p>':'')+
  '<div class="acts">'+(tel?'<a class="btn call" href="tel:'+$(tel)+'">Call '+$(l.phone)+'</a>':'')+(l.email?'<a class="btn" href="mailto:'+$(l.email)+'">Email</a>':'')+'</div>'+
  ed+
  '<div class="rp"><label>One-tap reply</label><select id="tp">'+tplFor(l).map(t=>'<option value="'+t.id+'">'+$(t.label)+'</option>').join('')+'</select><textarea id="tb" rows="3"></textarea><div class="acts">'+(tel?'<a class="btn call" id="tsms" href="#">Text</a>':'')+(l.email?'<a class="btn" id="tmail" href="#">Email</a>':'')+'<button type="button" class="btn" id="tcopy">Copy</button></div></div>'+
  '<div><label>Stage</label><div class="chips" id="fchips">'+S.map(([k,n])=>'<button type="button" data-k="'+k+'" class="'+(k===l.stage?'on':'')+'">'+n+'</button>').join('')+'</div></div><div><label>Next step <span id="fuh" style="text-transform:none;letter-spacing:0;color:#586069"></span></label><div class="fu-chips" id="fuc"></div></div><div class="g2"><div><label>Follow up on</label><input id="fd" type="date" value="'+$(l.follow_up_date||'')+'" style="color-scheme:dark"></div><div><label>Job value ($)</label><input id="fv" type="number" min="0" step="1" inputmode="numeric" value="'+(l.value||'')+'" placeholder="0"></div></div>'+
  '<div><label>Notes</label><textarea id="fn" placeholder="Called, left voicemail... quoted full front PPF...">'+$(l.notes||'')+'</textarea></div>'+
  ((l.log&&l.log.length)?'<div><label>Stage history</label><ul class="hist">'+l.log.map(h=>'<li><b>'+(h.from_stage===h.to_stage?$(h.reason||'Update'):$(SN(h.from_stage))+' \u2192 '+$(SN(h.to_stage))+'</b>'+(h.reason&&h.reason!=='Moved'?': '+$(h.reason):''))+(h.from_stage===h.to_stage?'</b>':'')+'<small>'+$(h.at==='now'?'just now':h.at)+'</small></li>').join('')+'</ul></div>':'')+
  '<div class="acts"><button class="btn go" id="fsave">Save</button></div></div>';
  dlg.showModal();
  const tp=document.getElementById('tp'),tb=document.getElementById('tb');
  function tfill(){const t=TPL.find(x=>x.id===tp.value),f=tplFill(t,l);tb.value=f.body;tb.dataset.subj=f.subject;sync()}
  function sync(){const sm=document.getElementById('tsms'),ml=document.getElementById('tmail');if(sm)sm.href=smsHref(l.phone,tb.value);if(ml)ml.href=mailHref(l.email,tb.dataset.subj||'',tb.value)}
  async function logTouch(kind){const r=await save(l.id,{label:kind+': '+TPL.find(x=>x.id===tp.value).label},'/admin/touch');if(r&&r.stage){apply(l,r);if(r.log)l.log=r.log.concat(l.log||[]);draw()}}
  tp.onchange=tfill;tb.oninput=sync;tfill();
  const sm=document.getElementById('tsms'),ml=document.getElementById('tmail');
  if(sm)sm.onclick=()=>{logTouch('Texted')};if(ml)ml.onclick=()=>{logTouch('Emailed')};
  document.getElementById('tcopy').onclick=async e=>{try{await navigator.clipboard.writeText(tb.value);e.target.textContent='Copied'}catch(_){tb.select()}};
  let stg=l.stage,pick=(stg===l.stage?'':'');
  function drawFu(){const fuc=document.getElementById('fuc');fuc.innerHTML='';(FU[stg]||[]).forEach(([lab,mv])=>{const b=document.createElement('button');b.type='button';b.dataset.l=lab;b.className=(mv?'mv ':'')+(pick===lab?'on':'');b.innerHTML=$(lab)+(mv?'<small>moves to '+$(SN(mv))+'</small>':'');fuc.appendChild(b)});document.getElementById('fuh').textContent=(stg===l.stage&&l.followup?'(now: '+l.followup+')':'')}
  document.getElementById('fuc').onclick=e=>{const b=e.target.closest('button[data-l]');if(!b)return;pick=pick===b.dataset.l?'':b.dataset.l;drawFu()};
  document.getElementById('fchips').onclick=e=>{const b=e.target.closest('button[data-k]');if(!b)return;stg=b.dataset.k;pick='';document.querySelectorAll('#fchips button').forEach(x=>x.classList.toggle('on',x===b));drawFu()};
  drawFu();
  document.getElementById('fsave').onclick=async()=>{const g=i=>document.getElementById(i).value.trim();const base={name:g('en'),phone:g('ep'),email:g('ee'),service:g('es'),make:g('em'),model:g('ed2'),year:g('ey'),value:Math.max(0,parseInt(document.getElementById('fv').value||'0',10)||0),notes:document.getElementById('fn').value};
    const o=await save(l.id,Object.assign({stage:stg,followup:pick||undefined,follow_date:g('fd')},base));if(o){Object.assign(l,base,{follow_up_date:g('fd')});apply(l,o);if(o.stage&&o.log)l.log=o.log.concat(l.log||[]);dlg.close();draw()}}}
const SRCS=['Phone call','Walk-in','Text / DM','Referral','Other'];
function openAdd(){dlg.innerHTML='<div class="dh"><h3>Add a lead</h3><button class="x" onclick="dlg.close()" aria-label="Close">&times;</button></div><div class="db"><div class="g2"><div><label>Name</label><input id="an" autocomplete="off"></div><div><label>Phone</label><input id="ap" type="tel" inputmode="tel"></div><div><label>Email</label><input id="ae" type="email"></div><div><label>How they reached you</label><select id="as">'+SRCS.map(x=>'<option>'+x+'</option>').join('')+'</select></div><div><label>Service</label><select id="av"><option value="">Not set</option>'+SVC.map(x=>'<option>'+x+'</option>').join('')+'</select></div><div><label>Make</label><input id="am"></div><div><label>Model</label><input id="ad"></div><div><label>Year</label><input id="ay" inputmode="numeric"></div></div><div><label>Notes</label><textarea id="ano"></textarea></div><div class="acts"><button class="btn go" id="asave">Add lead</button></div></div>';dlg.showModal();
  document.getElementById('asave').onclick=async()=>{const g=i=>document.getElementById(i).value.trim();const r=await fetch('/admin/add',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:g('an'),phone:g('ap'),email:g('ae'),source:g('as'),service:g('av'),make:g('am'),model:g('ad'),year:g('ay'),notes:g('ano')})});if(r.ok)location.reload();else document.getElementById('asave').textContent='Add a name or phone'}}
document.getElementById('addb').onclick=openAdd;if(location.hash==='#add')openAdd();{const m=/^#id=(\\d+)$/.exec(location.hash);if(m)open(+m[1])}
draw();
</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function csv(env) {
  await ensureTable(env.DB);
  const { results } = await env.DB.prepare("SELECT * FROM leads ORDER BY id DESC").all();
  const cols = ["id", "created_at", "type", "name", "email", "phone", "service", "also_interested", "make", "year", "model", "message", "page", "referrer", "gclid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "stage", "value", "notes", "duration", "answered", "recording"];
  const q = v => { let s = String(v ?? ""); if (/^(=|@|[+\-][^\d(\s])/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
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

    // www.divinedetailers.com sends visitors to the bare domain (only once the real domain is configured)
    if (crmHost && url.hostname.toLowerCase().startsWith("www.") && url.hostname.toLowerCase().slice(4) === crmHost.replace(/^crm\./, "")) {
      return Response.redirect(`https://${url.hostname.slice(4)}${url.pathname}${url.search}`, 301);
    }

    if (onCrm) {
      // the CRM host only serves the dashboard (and its few endpoints), never the marketing site or the form API
      if (p === "/" || p === "/today" || p === "/admin/today") return adminRoute("/admin/today", request, env);
      if (p === "/admin" || p === "/leads") return adminRoute("/admin", request, env);
      if (p === "/pipeline" || p === "/admin/pipeline") return adminRoute("/admin/pipeline", request, env);
      if (p === "/admin/stage" || p === "/admin/lead" || p === "/admin/add" || p === "/admin/touch" || p === "/admin/demo") return adminRoute(p, request, env);
      if (p === "/leads.csv" || p === "/admin/leads.csv") return adminRoute("/admin/leads.csv", request, env);
      if (p === "/admin/contacted") return adminRoute("/admin/contacted", request, env);
      if (p === "/login" || p === "/logout") return loginRoute(p, request, env);
      if (p === "/favicon.ico" || p.startsWith("/assets/favicon")) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    }

    if (p === "/api/callrail") {
      if (request.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);
      try { return await handleCallrail(request, env, url, ctx); }
      catch (e) { console.error("callrail error", e && e.message); return json({ success: false, message: "Server error" }, 500); }
    }

    if (p === "/api/lead") {
      if (request.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);
      try { return await handleLead(request, env, ctx); }
      catch (e) { console.error("lead error", e && e.message); return json({ success: false, message: "Server error" }, 500); }
    }

    if (p === "/login" || p === "/logout") {
      if (crmHost) return Response.redirect(`https://${crmHost}${p}`, 301);
      return loginRoute(p, request, env);
    }

    if (p === "/admin" || p.startsWith("/admin/")) {
      if (crmHost) return Response.redirect(`https://${crmHost}/`, 301);
      return adminRoute(p, request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

// ---- example leads, so the CRM can be shown off. They are marked ip = 'demo' and can be removed in one click.
const DEMO_NOTE = "Example lead. Remove all examples with the button at the bottom of the Today page.";
function demoLeads() {
  const day = n => new Date(Date.now() + n * 864e5).toLocaleDateString("en-CA", { timeZone: TZ });
  const ago = m => new Date(Date.now() - m * 60000).toISOString().slice(0, 19).replace("T", " ");
  const L = (o) => ({ type: "quote", stage: "new", value: 0, ...o });
  return [
    L({ m: 4, name: "Marcus Rivera", phone: "(305) 555-0142", email: "marcus.r@example.com", service: "Window Tint", make: "BMW", model: "M3", year: "2022", message: "Want 20% all the way around and a clear strip on the windshield. Can I come Saturday?", gclid: "demo", utm_source: "google", utm_medium: "cpc", utm_campaign: "Miami Window Tint", utm_term: "window tint near me", page: "/window-tinting" }),
    L({ m: 18, type: "call", name: "UNKNOWN CALLER", phone: "(786) 555-0178", answered: 0, duration: 0, utm_source: "Google Ads", utm_campaign: "Miami Window Tint", message: "" }),
    L({ m: 47, type: "call", name: "Danielle Brooks", phone: "(305) 555-0119", answered: 0, duration: 31, utm_source: "Google Ads", utm_campaign: "PPF Miami", message: "Voicemail: hi I need a quote on full front PPF for a Porsche Macan, call me back" }),
    L({ m: 95, name: "Kevin Alvarez", phone: "(954) 555-0166", email: "kalvarez@example.com", service: "Ceramic Coating", also_interested: "Paint Correction", make: "Tesla", model: "Model Y", year: "2024", message: "Brand new car, want it protected before it gets dirty.", gclid: "demo", utm_source: "google", utm_medium: "cpc", utm_campaign: "Ceramic Coating Miami", page: "/ceramic-coating" }),
    L({ m: 150, type: "call", name: "Priya Shah", phone: "(305) 555-0187", answered: 1, duration: 412, utm_source: "Google Ads", utm_campaign: "Miami Window Tint" }),
    L({ m: 60 * 26, name: "Tony Delgado", phone: "(786) 555-0133", email: "tony.d@example.com", service: "PPF / Clear Bra", make: "Chevrolet", model: "Corvette C8", year: "2023", message: "Full front end and rocker panels.", stage: "contacted", follow_up: "Left a voicemail", follow_up_date: day(0), page: "/paint-protection-film" }),
    L({ m: 60 * 50, name: "Samantha Cole", phone: "(305) 555-0124", email: "sam.cole@example.com", service: "Window Tint", make: "Audi", model: "Q5", year: "2021", stage: "quoted", value: 450, follow_up: "Waiting on a decision", follow_up_date: day(-2), page: "/window-tinting" }),
    L({ m: 60 * 72, name: "Luis Ortega", phone: "(786) 555-0151", email: "luis.o@example.com", service: "Vinyl Wraps", make: "Dodge", model: "Charger", year: "2020", message: "Satin black full wrap.", stage: "quoted", value: 3200, follow_up: "Invoice sent", follow_up_date: day(1), page: "/vinyl-wraps" }),
    L({ m: 60 * 100, name: "Jasmine Wright", phone: "(305) 555-0172", email: "jwright@example.com", service: "Ceramic Coating", make: "Mercedes-Benz", model: "G-Class", year: "2022", stage: "booked", value: 1400, follow_up: "Accepted, deposit paid", follow_up_date: day(3) }),
    L({ m: 60 * 120, name: "Carlos Mendez", phone: "(954) 555-0109", email: "carlos.m@example.com", service: "Paint Correction", make: "Lamborghini", model: "Huracan", year: "2019", stage: "working", value: 1800 }),
    L({ m: 60 * 24 * 6, name: "Aaliyah Grant", phone: "(786) 555-0194", email: "aaliyah.g@example.com", service: "PPF / Clear Bra", make: "Toyota", model: "GR Supra", year: "2023", stage: "done", value: 2600 }),
    L({ m: 60 * 24 * 8, name: "Brian Foster", phone: "(305) 555-0116", email: "bfoster@example.com", service: "Window Tint", make: "Ford", model: "F-150", year: "2021", stage: "lost", value: 380, follow_up: "Too expensive" }),
  ].map(l => ({ ...l, created: ago(l.m) }));
}
async function demoRoute(request, env) {
  const b = await request.json().catch(() => ({}));
  await ensureTable(env.DB);
  if (b.action === "clear") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM stage_log WHERE lead_id IN (SELECT id FROM leads WHERE ip = 'demo')"),
      env.DB.prepare("DELETE FROM leads WHERE ip = 'demo'"),
    ]);
    return json({ success: true });
  }
  if (b.action !== "load") return json({ success: false }, 400);
  const have = await env.DB.prepare("SELECT COUNT(*) n FROM leads WHERE ip = 'demo'").first();
  if (have && have.n) return json({ success: true, added: 0 });
  const ins = env.DB.prepare(`INSERT INTO leads (created_at,type,name,email,phone,service,also_interested,make,year,model,message,page,gclid,utm_source,utm_medium,utm_campaign,utm_term,ip,contacted,notes,stage,value,stage_changed_at,call_id,duration,answered,follow_up,follow_up_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'demo',?,?,?,?,?,?,?,?,?,?)`);
  const stmts = demoLeads().map((l, i) => ins.bind(l.created, l.type, l.name, l.email || "", l.phone, l.service || "", l.also_interested || "", l.make || "", l.year || "", l.model || "", l.message || "", l.page || "", l.gclid || "", l.utm_source || "", l.utm_medium || "", l.utm_campaign || "", l.utm_term || "",
    l.stage === "new" ? 0 : 1, DEMO_NOTE, l.stage, l.value, l.created, l.type === "call" ? "demo-" + i : null, l.duration ?? null, l.answered ?? null, l.follow_up || "", l.follow_up_date || ""));
  await env.DB.batch(stmts);
  return json({ success: true, added: stmts.length });
}

async function todayPage(env) {
  await ensureTable(env.DB);
  const today = todayStr();
  const { results } = await env.DB.prepare("SELECT id,created_at,type,name,email,phone,service,make,year,model,message,utm_source,utm_campaign,gclid,utm_medium,stage,follow_up,follow_up_date,duration,recording,answered FROM leads WHERE type != 'newsletter' AND (stage = 'new' OR (COALESCE(follow_up_date,'') != '' AND follow_up_date <= ? AND stage NOT IN ('done','lost'))) ORDER BY id ASC LIMIT 300").bind(today).all();
  const items = results.map(l => ({ ...l, ago: when(l.created_at).ago, src: sourceOf(l).label, ad: sourceOf(l).ad, vm: /voicemail/i.test(l.message || "") }));
  const payload = JSON.stringify({ today, cfg: cfgOf(env), items }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Today | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#07090c;color:#e8eaed}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}.navtabs a.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
.dt{color:#8a9099;font-size:14px}
main{max-width:880px;margin:0 auto;padding:8px 22px 40px;display:flex;flex-direction:column;gap:26px}
section h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;margin:18px 0 10px;display:flex;align-items:center;gap:8px;color:#c3c8cf}section h2 i{font-style:normal;background:#1c222a;border-radius:999px;padding:1px 9px;font-size:12px;color:#aab0b9}
section.miss h2{color:#ff9a9a}section.late h2{color:#ffb86b}section.new h2{color:#32cd32}
.rows{display:flex;flex-direction:column;gap:10px}
.row{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}.miss .row{border-color:#4a2424}.late .row{border-color:#4d3a1d}.new .row{border-color:#244d2a}
.hd{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.hd b{font-size:17px;display:block}.hd small{color:#8a9099;font-size:13px}.hd a.op{color:#8ec0ff;font-size:13px;white-space:nowrap}
.why{font-size:13px;color:#c9a8ff}.msg{margin:0;color:#c9ced5;font-size:14px}
.pill{font-size:11.5px;padding:2px 9px;border-radius:999px;background:#171c23;color:#aab0b9}.pill.ad{background:#14263f;color:#8ec0ff}.pill.miss{background:#3b1d1d;color:#ff9a9a;font-weight:700}
.acts{display:flex;gap:8px;flex-wrap:wrap}.btn{border:1px solid #2a313a;background:#151a21;color:#e8eaed;border-radius:10px;padding:11px 15px;font:inherit;font-weight:700;text-decoration:none;cursor:pointer;min-height:46px;display:inline-flex;align-items:center;justify-content:center}
.btn.call{background:#32cd32;border-color:#32cd32;color:#04120a}.btn.dn{background:#1d2630}
.demo{max-width:880px;margin:0 auto;padding:0 22px 40px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;color:#7c838d;font-size:13px}.demo .btn{min-height:40px;padding:8px 12px;font-weight:600}
.empty{color:#7c838d;padding:10px 0}.all{text-align:center;padding:50px 0;color:#8a9099}.all b{display:block;color:#32cd32;font-size:20px;margin-bottom:6px}
${BNAV_CSS}
${FOLLOW_CSS}
@media(max-width:700px){header{padding:12px 14px}h1{font-size:17px}main{padding:4px 14px 20px;gap:18px}.acts{display:grid;grid-template-columns:1fr 1fr}.acts .call{grid-column:1/-1;font-size:17px;padding:14px}}
</style></head><body>
<header><h1>Divine Detailers <b>today</b></h1>${nav("today", items.length)}<span class="dt"><span id="dt"></span> &middot; <a href="/logout" style="color:#8a9099">Sign out</a></span></header>
${bnav("today", items.length)}
${FOLLOW_HTML}
<main id="m"></main>
<div class="demo"><span>Showing off the CRM?</span><button class="btn" id="dl">Load example leads</button><button class="btn" id="dc">Remove example leads</button></div>
<script type="application/json" id="data">${payload}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent),CFG=D.cfg,TODAY=D.today;let items=D.items;
const $=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
${FOLLOW_JS}
${TPL_JS}
const post=(u,b)=>fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
const fmtD=d=>{const p=d.split('-');return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+p[1]-1]+' '+(+p[2])};
document.getElementById('dt').textContent=new Date(TODAY+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
function group(){return {miss:items.filter(l=>l.type==='call'&&l.answered===0&&l.stage==='new'),late:items.filter(l=>l.stage!=='new'&&l.follow_up_date&&l.follow_up_date<TODAY),due:items.filter(l=>l.stage!=='new'&&l.follow_up_date===TODAY),nw:items.filter(l=>l.stage==='new'&&!(l.type==='call'&&l.answered===0))}}
function row(l,kind){const veh=[l.year,l.make,l.model].filter(Boolean).join(' '),tel=(l.phone||'').replace(/[^\\d+]/g,''),t=tplFor(l)[0],msg=tplFill(t,l).body;
  const why=kind==='miss'?(l.vm?'Left a voicemail':'Missed call')+(l.src?' &middot; '+$(l.src):''):kind==='nw'?(l.type==='call'?'Called in':$(l.service||'Quote request'))+(veh?' &middot; '+$(veh):''):($(l.follow_up||'Follow up')+' &middot; '+(kind==='late'?'was due '+fmtD(l.follow_up_date):'due today')+(l.service?' &middot; '+$(l.service):''));
  return '<div class="row" data-id="'+l.id+'"><div class="hd"><div><b>'+$(l.name||l.phone||l.email||'Unknown caller')+'</b><small>'+$(l.ago)+(l.ad?' &middot; <span class="pill ad">Ads</span>':'')+'</small></div><a class="op" href="/admin/pipeline#id='+l.id+'">Details</a></div><div class="why">'+why+'</div>'+(l.message&&kind!=='miss'?'<p class="msg">&ldquo;'+$(l.message.slice(0,180))+'&rdquo;</p>':'')+
  '<div class="acts">'+(tel?'<a class="btn call" href="tel:'+$(tel)+'" data-act="call">Call '+$(l.phone)+'</a><a class="btn" href="'+$(smsHref(l.phone,msg))+'" data-act="text">Text</a>':'')+(l.stage==='new'?'<button class="btn dn" data-act="done">Contacted</button>':'<button class="btn dn" data-act="done">Done</button><button class="btn" data-act="snooze">Tomorrow</button>')+'</div></div>'}
function sec(cls,title,ls,kind){return ls.length?'<section class="'+cls+'"><h2>'+title+' <i>'+ls.length+'</i></h2><div class="rows">'+ls.map(l=>row(l,kind)).join('')+'</div></section>':''}
function draw(){const g=group();const h=sec('miss','Return these calls',g.miss,'miss')+sec('new','New leads nobody has contacted',g.nw,'nw')+sec('late','Overdue follow-ups',g.late,'late')+sec('due','Follow-ups due today',g.due,'due');
  document.getElementById('m').innerHTML=h||'<div class="all"><b>All caught up</b>No calls to return, no new leads, no follow-ups due.</div>';
  document.title=(items.length?'('+items.length+') ':'')+'Today | Divine Detailers'}
document.getElementById('m').addEventListener('click',async e=>{const b=e.target.closest('[data-act]');if(!b)return;const r=b.closest('.row'),l=items.find(x=>x.id===+r.dataset.id);if(!l)return;const a=b.dataset.act;
  const lab=l.name||l.phone||'this lead';
  if(a==='call'){post('/admin/touch',{id:l.id,label:'Called'});return}
  if(a==='text'){post('/admin/touch',{id:l.id,label:'Texted: '+tplFor(l)[0].label});return}
  if(a==='snooze'){const d=new Date(TODAY+'T12:00:00');d.setDate(d.getDate()+1);const v=d.toISOString().slice(0,10);b.disabled=true;const o=await post('/admin/stage',{id:l.id,follow_date:v});if(o.ok){l.follow_up_date=v;items=items.filter(x=>x.id!==l.id);draw()}else b.disabled=false;return}
  if(a==='done'){b.disabled=true;let st=l.stage;if(st==='new'){const o=await post('/admin/stage',{id:l.id,stage:'contacted'});if(!o.ok){b.disabled=false;return}st='contacted'}
    const nx=await askNext(lab,st);const o2=await post('/admin/stage',{id:l.id,followup:nx?nx.followup:undefined,follow_date:nx?nx.follow_date:''});
    if(o2.ok){const j=await o2.json();l.stage=j.stage;l.follow_up_date=j.follow_up_date;l.follow_up=j.followup;if(!(j.follow_up_date&&j.follow_up_date<=TODAY&&!['done','lost'].includes(j.stage)))items=items.filter(x=>x.id!==l.id);draw()}else b.disabled=false}})
draw();
for(const [id,act] of [['dl','load'],['dc','clear']])document.getElementById(id).onclick=async e=>{e.target.disabled=true;await post('/admin/demo',{action:act});location.reload()};
</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function adminRoute(p, request, env) {
  const a = await authed(request, env);
  if (a === "unconfigured") return new Response("Sign in is not set up yet. Add the PASSWORD_GIORDANI and PASSWORD_BRONSON secrets.", { status: 503 });
  if (!a) {
    if (request.method === "GET") { const u = new URL(request.url); return new Response(null, { status: 302, headers: { location: "/login?next=" + encodeURIComponent(u.pathname + u.search), "cache-control": "no-store" } }); }
    return json({ success: false, message: "Signed out" }, 401);
  }
  if (!env.DB) return new Response("Lead database is not configured.", { status: 503 });
  if (p === "/admin") return adminPage(env);
  if (p === "/admin/leads.csv") return csv(env);
  if (p === "/admin/pipeline") return pipelinePage(env);
  if (p === "/admin/add" && request.method === "POST") return addLead(request, env);
  if (p === "/admin/today") return todayPage(env);
  if (p === "/admin/demo" && request.method === "POST") return demoRoute(request, env);
  if (p === "/admin/touch" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!Number.isInteger(b.id) || typeof b.label !== "string") return json({ success: false }, 400);
    const cur = await env.DB.prepare("SELECT stage, follow_up_date FROM leads WHERE id = ?").bind(b.id).first();
    if (!cur) return json({ success: false }, 404);
    // a first text or email counts as contacting them
    const stage = cur.stage === "new" ? "contacted" : cur.stage;
    const stmts = [
      env.DB.prepare("UPDATE leads SET stage = ?, contacted = 1" + (stage !== cur.stage ? ", stage_changed_at = datetime('now')" : "") + " WHERE id = ?").bind(stage, b.id),
      env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason) VALUES (?,?,?,?)").bind(b.id, cur.stage, stage, clean(b.label, 120)),
    ];
    await env.DB.batch(stmts);
    const abs = when(new Date().toISOString().slice(0, 19).replace("T", " ")).abs;
    return json({ success: true, stage, followup: "", follow_up_date: cur.follow_up_date || "", log: [{ from_stage: cur.stage, to_stage: stage, reason: clean(b.label, 120), at: abs }] });
  }
  if ((p === "/admin/stage" || p === "/admin/lead") && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!Number.isInteger(b.id)) return json({ success: false }, 400);
    const cur = await env.DB.prepare("SELECT stage, follow_up, follow_up_date FROM leads WHERE id = ?").bind(b.id).first();
    if (!cur) return json({ success: false }, 404);
    let stage = cur.stage, follow = cur.follow_up || "", date = cur.follow_up_date || "", moved = false;
    const logs = [];
    if (typeof b.stage === "string" && STAGE_KEYS.includes(b.stage) && b.stage !== stage) {
      logs.push([stage, b.stage, "Moved"]); stage = b.stage; follow = ""; moved = true;
    }
    if (typeof b.followup === "string" && b.followup) {
      const act = (FOLLOWUPS[stage] || []).find(a => a[0] === b.followup);
      if (!act) return json({ success: false, message: "Unknown next step for this stage" }, 422);
      const to = act[1] || stage;
      logs.push([stage, to, act[0]]);
      if (to !== stage) { stage = to; moved = true; }
      follow = act[0];
    }
    if (typeof b.follow_date === "string" && /^(\d{4}-\d{2}-\d{2})?$/.test(b.follow_date)) date = b.follow_date;
    const sets = ["stage = ?", "contacted = ?", "follow_up = ?", "follow_up_date = ?"], vals = [stage, stage === "new" ? 0 : 1, follow, date];
    if (moved) sets.push("stage_changed_at = datetime('now')");
    if (p === "/admin/lead") {
      if (Number.isFinite(b.value)) { sets.push("value = ?"); vals.push(Math.max(0, Math.min(10000000, Math.floor(b.value)))); }
      if (typeof b.notes === "string") { sets.push("notes = ?"); vals.push(b.notes.slice(0, 4000)); }
      for (const f of ["name", "email", "phone", "service", "make", "year", "model"]) {
        if (typeof b[f] === "string") { sets.push(`${f} = ?`); vals.push(clean(b[f], f === "email" ? 200 : 120)); }
      }
    }
    const stmts = [env.DB.prepare(`UPDATE leads SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, b.id)];
    for (const [f, t, r] of logs) stmts.push(env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason) VALUES (?,?,?,?)").bind(b.id, f, t, r));
    await env.DB.batch(stmts);
    const abs = when(new Date().toISOString().slice(0, 19).replace("T", " ")).abs;
    return json({ success: true, stage, followup: follow, follow_up_date: date, log: logs.map(([f, t, r]) => ({ from_stage: f, to_stage: t, reason: r, at: abs })).reverse() });
  }
  return new Response("Not found", { status: 404 });
}
