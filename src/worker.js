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
  await db.prepare("CREATE TABLE IF NOT EXISTS dial_log (call_id TEXT PRIMARY KEY, lead_id INTEGER, by_user TEXT, source TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), done INTEGER NOT NULL DEFAULT 0)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS hook_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (datetime('now')), summary TEXT)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS ad_spend (month TEXT PRIMARY KEY, amount REAL NOT NULL DEFAULT 0)").run();
  const slCols = (await db.prepare("PRAGMA table_info(stage_log)").all()).results.map(c => c.name);
  if (!slCols.includes("by_user")) await db.prepare("ALTER TABLE stage_log ADD COLUMN by_user TEXT").run();
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
  if (!cols.includes("reminded_at")) await db.prepare("ALTER TABLE leads ADD COLUMN reminded_at TEXT").run();
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
// ---- Click-to-call through CallRail: CallRail rings the agent's phone first ("press 1 to connect"), then dials the lead from the tracking number.
// Needs CALLRAIL_API_TOKEN (secret), CALLRAIL_ACCOUNT_ID, CALLRAIL_CALLER_ID (a tracking number or verified outbound caller ID, +1...) and the agent's cell in AGENT_PHONE_GIORDANI / AGENT_PHONE_BRONSON.
// CALL_RECORDING=1 records the calls and plays CALL_GREETING first (Florida needs everyone on the call to agree to recording).
const dialOn = env => !!(env.CALLRAIL_API_TOKEN && env.CALLRAIL_ACCOUNT_ID && env.CALLRAIL_CALLER_ID);
const agentPhone = (env, user) => e164(env["AGENT_PHONE_" + String(user || "").toUpperCase()] || "");
function inBusinessHours(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(d).map(x => [x.type, x.value]));
  return !(p.weekday === "Sun" || Number(p.hour) < 9 || Number(p.hour) >= 18);
}
async function placeCall(env, lead, user, source) {
  if (!dialOn(env)) return { ok: false, message: "Calling through CallRail is not set up yet." };
  const agent = agentPhone(env, user), customer = e164(lead.phone);
  if (!agent) return { ok: false, message: `No cell number is saved for ${user}. Add AGENT_PHONE_${String(user).toUpperCase()} in Cloudflare.` };
  if (digitsOf(customer).length < 11) return { ok: false, message: "This lead has no valid phone number." };
  const body = { caller_id: e164(env.CALLRAIL_CALLER_ID), business_phone_number: agent, customer_phone_number: customer, recording_enabled: env.CALL_RECORDING === "1" };
  if (body.recording_enabled) body.outbound_greeting_text = env.CALL_GREETING || "This call may be recorded for quality and training purposes.";
  let r, j;
  try {
    r = await fetch(`${env.CALLRAIL_API_BASE || "https://api.callrail.com"}/v3/a/${env.CALLRAIL_ACCOUNT_ID}/calls.json`, { method: "POST", headers: { authorization: `Token token=${env.CALLRAIL_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    j = await r.json().catch(() => ({}));
  } catch (e) { return { ok: false, message: "Could not reach CallRail." }; }
  if (!r.ok || !j.id) return { ok: false, message: `CallRail refused the call (status ${r.status})` + (Object.keys(j).length ? ": " + JSON.stringify(j).slice(0, 220) : ".") };
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO dial_log (call_id, lead_id, by_user, source) VALUES (?,?,?,?)").bind(j.id, lead.id, user, source),
    env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) SELECT id, stage, stage, ?, ? FROM leads WHERE id = ?").bind(source === "auto" ? "Auto-dial requested (calling your phone first)" : "Dial requested (calling your phone first)", user, lead.id),
  ]);
  return { ok: true, id: j.id };
}
// CallRail posts finished outbound calls here (Outbound Post-Call and Call Modified webhooks): log the call, its result and recording on the lead
async function handleOutbound(env, c) {
  const callId = clean(String(c.id || c.call_id || c.resource_id || ""), 80);
  if (!callId) return json({ success: false, message: "No call id" }, 422);
  const dl = await env.DB.prepare("SELECT lead_id, by_user, done FROM dial_log WHERE call_id = ?").bind(callId).first();
  let leadId = dl ? dl.lead_id : null, by = dl ? dl.by_user || "" : "";
  if (!leadId) {
    const d10 = digitsOf(c.customer_phone_number || c.formatted_customer_phone_number || "").slice(-10);
    if (d10.length < 10) return json({ success: true, ignored: true });
    const m = await env.DB.prepare("SELECT id FROM leads WHERE type != 'newsletter' AND COALESCE(ip,'') != 'demo' AND replace(replace(replace(replace(replace(phone,'-',''),' ',''),'(',''),')',''),'+','') LIKE ? ORDER BY created_at DESC, id DESC LIMIT 1").bind("%" + d10).first();
    if (!m) return json({ success: true, ignored: true });
    leadId = m.id; by = "callrail app";
    await env.DB.prepare("INSERT OR IGNORE INTO dial_log (call_id, lead_id, by_user, source) VALUES (?,?,?,?)").bind(callId, leadId, by, "app").run();
  }
  const rec = clean(c.recording_player || c.recording || "", 500);
  if (rec) await env.DB.prepare("UPDATE leads SET recording = ? WHERE id = ?").bind(rec, leadId).run();
  const already = dl ? dl.done : (await env.DB.prepare("SELECT done FROM dial_log WHERE call_id = ?").bind(callId).first() || {}).done;
  if (already) return json({ success: true, updated: true });
  const answered = bool(c.answered) === 1, vm = bool(c.voicemail) === 1, dur = num(c.duration) || 0;
  // the lead was dialed when the agent pressed 1: CallRail then reports an answer, a voicemail or some talk time
  const dialed = answered || vm || dur > 0;
  const at = sqlTime(c.start_time) || new Date().toISOString().slice(0, 19).replace("T", " ");
  const cur = await env.DB.prepare("SELECT stage FROM leads WHERE id = ?").bind(leadId).first();
  if (!cur) return json({ success: true, ignored: true });
  const row = (reason, when) => env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, at, by_user) VALUES (?,?,?,?,?,?)").bind(leadId, cur.stage, cur.stage === "new" && dialed ? "contacted" : cur.stage, reason, when, by);
  const stmts = [env.DB.prepare("UPDATE dial_log SET done = 1 WHERE call_id = ?").bind(callId)];
  if (dialed) {
    stmts.push(row("Called via CallRail" + (dur ? ` (${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")})` : ""), at));
    stmts.push(row("Call result: " + (vm ? "Left a voicemail" : answered ? "Answered" : "No answer"), at));
    if (cur.stage === "new") stmts.push(env.DB.prepare("UPDATE leads SET stage = 'contacted', contacted = 1, stage_changed_at = datetime('now') WHERE id = ?").bind(leadId));
  } else stmts.push(row("Dial not connected (nobody pressed 1)", at));
  await env.DB.batch(stmts);
  if (!dialed && dl && (await env.DB.prepare("SELECT source FROM dial_log WHERE call_id = ?").bind(callId).first() || {}).source === "auto") {
    const ld = await env.DB.prepare("SELECT name, phone FROM leads WHERE id = ?").bind(leadId).first() || {};
    const link = env.CRM_HOST ? `https://${env.CRM_HOST}/today` : "";
    const text = `AUTO-DIAL NOT ANSWERED: nobody pressed 1, so ${ld.name || ld.phone || "the new lead"} (${prettyPhone(ld.phone)}) was not called. Call them now. ${link}`.trim();
    await alertTeam(env, { subject: "Auto-dial not answered: call the lead", text, html: `<p><b>${esc(text.replace(link, "").trim())}</b></p>${link ? `<p><a href="${esc(link)}">Open today's list</a></p>` : ""}`, push: { title: "Auto-dial not answered", message: `${ld.name || ld.phone || "New lead"}: call them now`, click: link || undefined } }).catch(() => {});
  }
  return json({ success: true, logged: true });
}

// Shows whether the CallRail click-to-call settings are in place and asks CallRail for the account id and tracking numbers (owner only)
async function callrailTest(env) {
  const out = { token_set: !!env.CALLRAIL_API_TOKEN, account_id_set: !!env.CALLRAIL_ACCOUNT_ID, caller_id_set: !!env.CALLRAIL_CALLER_ID, agent_giordani: !!agentPhone(env, "giordani"), agent_bronson: !!agentPhone(env, "bronson"), recording: env.CALL_RECORDING === "1", auto_dial: env.AUTO_DIAL === "1" };
  try {
    await ensureTable(env.DB);
    out.hooks = (await env.DB.prepare("SELECT at, summary FROM hook_log ORDER BY id DESC LIMIT 6").all()).results.map(h => ({ at: when(h.at).abs, summary: h.summary }));
  } catch (e) { out.hooks = []; }
  if (!env.CALLRAIL_API_TOKEN) return out;
  const base = env.CALLRAIL_API_BASE || "https://api.callrail.com", h = { authorization: `Token token=${env.CALLRAIL_API_TOKEN}` };
  try {
    const r = await fetch(`${base}/v3/a.json`, { headers: h });
    out.accounts_status = r.status;
    const j = await r.json().catch(() => ({}));
    out.accounts = (j.accounts || []).map(a => ({ id: a.id, name: a.name }));
    if (!r.ok) out.accounts_error = String(j.error || "").slice(0, 160);
  } catch (e) { out.accounts_status = 0; }
  if (env.CALLRAIL_ACCOUNT_ID) {
    try {
      const r = await fetch(`${base}/v3/a/${env.CALLRAIL_ACCOUNT_ID}/trackers.json?per_page=100`, { headers: h });
      out.trackers_status = r.status;
      const j = await r.json().catch(() => ({}));
      out.trackers = (j.trackers || []).map(t => ({ name: t.name, numbers: [].concat(t.tracking_numbers || []).join(", ") }));
      const cid = digitsOf(env.CALLRAIL_CALLER_ID).slice(-10);
      const hit = (j.trackers || []).find(t => [].concat(t.tracking_numbers || []).some(n => digitsOf(n).slice(-10) === cid));
      out.caller_id_match = hit ? hit.name : "";
      // a verified outbound caller ID (for example the shop's own number) is not a tracking number: ask CallRail for those too (best effort)
      try {
        const rco = await fetch(`${base}/v3/a/${env.CALLRAIL_ACCOUNT_ID}/companies.json`, { headers: h });
        const jco = await rco.json().catch(() => ({}));
        const companyId = ((jco.companies || [])[0] || {}).id || "";
        const rc = await fetch(`${base}/v3/a/${env.CALLRAIL_ACCOUNT_ID}/caller_ids.json?company_id=${companyId}&per_page=100`, { headers: h });
        out.callerids_status = rc.status;
        const jc = await rc.json().catch(() => ({}));
        const list = jc.caller_ids || jc.outbound_caller_ids || [];
        out.caller_ids = list.map(c => ({ name: c.name, number: c.phone_number || c.formatted_phone_number || "", verified: c.verified }));
        out.caller_id_verified = list.some(c => digitsOf(c.phone_number || c.formatted_phone_number || "").slice(-10) === cid);
      } catch (e) { out.callerids_status = 0; }
    } catch (e) { out.trackers_status = 0; }
  }
  return out;
}

// Rings the agent for a new form lead. A failure is written on the lead's history and sent as an alert, so it is never silent.
async function autoDial(env, lead) {
  const agent = (env.AUTO_DIAL_AGENT || "giordani").toLowerCase();
  let res;
  try { res = await placeCall(env, lead, agent, "auto"); } catch (e) { res = { ok: false, message: "Unexpected error: " + String((e && e.message) || e).slice(0, 160) }; }
  if (res.ok) return;
  try {
    await env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) SELECT id, stage, stage, ?, ? FROM leads WHERE id = ?").bind("Auto-dial failed: " + res.message.slice(0, 200), agent, lead.id).run();
    const link = env.CRM_HOST ? `https://${env.CRM_HOST}/today` : "";
    const text = `AUTO-DIAL FAILED for ${lead.name || lead.phone}: ${res.message.slice(0, 160)}. Call the lead by hand. ${link}`.trim();
    await alertTeam(env, { subject: "Auto-dial failed: call the lead", text, html: `<p><b>${esc(text.replace(link, "").trim())}</b></p>${link ? `<p><a href="${esc(link)}">Open today's list</a></p>` : ""}`, push: { title: "Auto-dial failed", message: `${lead.name || lead.phone}: call by hand. ${res.message.slice(0, 90)}`, click: link || undefined } });
  } catch (e) { /* nothing more to do */ }
}

// Registers the shop's own number with CallRail as an outbound caller ID. CallRail then phones that number: answer and key in the code shown (owner only)
async function verifyShopNumber(env, body) {
  if (!env.CALLRAIL_API_TOKEN || !env.CALLRAIL_ACCOUNT_ID) return { ok: false, message: "Add CALLRAIL_API_TOKEN and CALLRAIL_ACCOUNT_ID first." };
  const base = env.CALLRAIL_API_BASE || "https://api.callrail.com", acct = env.CALLRAIL_ACCOUNT_ID, h = { authorization: `Token token=${env.CALLRAIL_API_TOKEN}`, "content-type": "application/json" };
  const number = e164(body && body.phone ? body.phone : SHOP.phone);
  let companyId = body && body.company_id ? String(body.company_id) : "";
  try {
    if (!companyId) {
      const rc = await fetch(`${base}/v3/a/${acct}/companies.json`, { headers: h });
      const jc = await rc.json().catch(() => ({}));
      if (!rc.ok) return { ok: false, message: `Could not read your CallRail companies (status ${rc.status}): ${JSON.stringify(jc).slice(0, 160)}` };
      const list = jc.companies || [];
      if (!list.length) return { ok: false, message: "CallRail returned no companies." };
      if (list.length > 1) return { ok: false, message: "Several companies found. Tell Claude which one: " + list.map(c => `${c.name} = ${c.id}`).join("; ") };
      companyId = list[0].id;
    }
    const post = async () => { const r = await fetch(`${base}/v3/a/${acct}/caller_ids.json`, { method: "POST", headers: h, body: JSON.stringify({ phone_number: number, name: (body && body.name) || "Divine Detailers shop line", company_id: companyId }) }); return { r, j: await r.json().catch(() => ({})) }; };
    let { r, j } = await post();
    if (!r.ok && /taken/i.test(JSON.stringify(j))) {
      // the number is already registered: if it is verified we are done, if it is still waiting for a code remove it and register it again
      const rl = await fetch(`${base}/v3/a/${acct}/caller_ids.json?company_id=${companyId}&per_page=100`, { headers: h });
      const jl = await rl.json().catch(() => ({}));
      const found = (jl.caller_ids || jl.outbound_caller_ids || []).find(c => digitsOf(c.phone_number || c.formatted_phone_number || "").slice(-10) === digitsOf(number).slice(-10));
      if (!found) return { ok: false, message: `CallRail says the number is taken, but it is not in this account's list (status ${rl.status}). Ask CallRail support to release it.` };
      if (found.verified === true || /^verified$/i.test(found.status || "")) return { ok: true, already: true, number };
      const rd = await fetch(`${base}/v3/a/${acct}/caller_ids/${found.id}.json`, { method: "DELETE", headers: h });
      if (!rd.ok) return { ok: false, message: `The number is registered but not verified, and CallRail would not remove it (status ${rd.status}). Ask CallRail support to delete or re-verify caller ID ${found.id}. What CallRail knows about it: ${JSON.stringify(found).slice(0, 200)}` };
      ({ r, j } = await post());
    }
    if (!r.ok) return { ok: false, message: `CallRail refused (status ${r.status}): ${JSON.stringify(j).slice(0, 220)}` };
    return { ok: true, number, code: j.validation_code || j.verification_code || "", raw: j.validation_code ? "" : JSON.stringify(j).slice(0, 220) };
  } catch (e) { return { ok: false, message: "Could not reach CallRail." }; }
}

async function handleCallrail(request, env, url, ctx) {
  if (!env.CALLRAIL_KEY) return json({ success: false, message: "CALLRAIL_KEY is not set" }, 503);
  const reject = async (why) => { try { if (env.DB) { await ensureTable(env.DB); await env.DB.prepare("INSERT INTO hook_log (summary) VALUES (?)").bind("REJECTED: " + why).run(); } } catch (e) { /* ignore */ } };
  if (!safeEqual(url.searchParams.get("key") || "", env.CALLRAIL_KEY)) { await reject("wrong or missing key in the webhook URL"); return json({ success: false }, 401); }
  if (!env.DB) return json({ success: false, message: "Lead storage is not configured" }, 503);
  let c;
  try { c = await request.json(); } catch { await reject("body was not JSON (method " + request.method + ")"); return json({ success: false, message: "Bad request" }, 400); }
  await ensureTable(env.DB);
  // keep a short record of what CallRail sends (no names or numbers), so a broken webhook can be diagnosed from the CRM
  let lg = null;
  try {
    lg = await env.DB.prepare("INSERT INTO hook_log (summary) VALUES (?)").bind(JSON.stringify({ direction: c.direction, id: c.id || c.call_id, answered: c.answered, voicemail: c.voicemail, duration: c.duration, keys: Object.keys(c).slice(0, 30) }).slice(0, 600)).run();
    await env.DB.prepare("DELETE FROM hook_log WHERE id <= (SELECT MAX(id) FROM hook_log) - 40").run();
  } catch (e) { /* logging must never break a webhook */ }
  if (String(c.direction || "").toLowerCase() === "outbound") {
    const res = await handleOutbound(env, c);
    try { if (lg) await env.DB.prepare("UPDATE hook_log SET summary = summary || ? WHERE id = ?").bind(" => " + (await res.clone().text()).slice(0, 120), lg.meta.last_row_id).run(); } catch (e) { /* ignore */ }
    return res;
  }
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
  const insC = await env.DB.prepare(`INSERT INTO leads (created_at,type,name,phone,message,page,referrer,gclid,utm_source,utm_medium,utm_campaign,utm_term,call_id,duration,recording,answered,tracking_number,email)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(row.created, "call", row.name, row.phone, row.message, row.page, row.referrer, row.gclid, row.utm_source, row.utm_medium, row.utm_campaign, row.utm_term, row.call_id, row.duration, row.recording, row.answered, row.tracking, "").run();
  ctx.waitUntil(notifyCall(env, { id: insC.meta && insC.meta.last_row_id, name: row.name, phone: row.phone, answered: row.answered, message: row.message, utm_source: row.utm_source, utm_campaign: row.utm_campaign, recording: row.recording }, url.origin));
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

  const ins = await env.DB.prepare(`INSERT INTO leads (type,name,email,phone,service,also_interested,make,year,model,message,page,referrer,gclid,utm_source,utm_medium,utm_campaign,utm_term,ip,user_agent)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(type, lead.name, lead.email, lead.phone, lead.service, lead.also_interested, lead.make, lead.year, lead.model, lead.message,
      lead.page, lead.referrer, lead.gclid, lead.utm_source, lead.utm_medium, lead.utm_campaign, lead.utm_term, ip, clean(request.headers.get("user-agent") || "", 300)).run();

  const newLead = { ...lead, id: ins.meta && ins.meta.last_row_id };
  ctx.waitUntil(notify(env, newLead, new URL(request.url).origin));
  // optional: ring the agent's phone straight away and connect them to the new lead (AUTO_DIAL=1, AUTO_DIAL_AGENT=giordani)
  if (env.AUTO_DIAL === "1" && type === "quote" && newLead.id && (env.AUTO_DIAL_ANYTIME === "1" || inBusinessHours())) ctx.waitUntil(autoDial(env, newLead));
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

// Push notification through ntfy (free, no account): everyone subscribed to the private topic NTFY_TOPIC gets it on their phone
// within a second, on any carrier. NTFY_SERVER is only needed if you host your own server.
async function sendPush(env, { title, message, click }) {
  const topic = (env.NTFY_TOPIC || "").trim();
  if (!topic) return;
  const server = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  // with a free ntfy account token (NTFY_TOKEN) messages count against your own daily quota instead of a shared address
  const headers = { "content-type": "application/json" };
  if (env.NTFY_TOKEN) headers.authorization = `Bearer ${env.NTFY_TOKEN.trim()}`;
  await Promise.all(topic.split(",").map(t => t.trim()).filter(Boolean).map(t => fetch(server, {
    method: "POST",
    headers,
    body: JSON.stringify({ topic: t, title, message, priority: 4, tags: ["bell"], click: click || undefined }),
  }).catch(() => {})));
}

// one message to everyone who should react fast: push (NTFY_TOPIC), email list (NOTIFY_TO) and text list (ALERT_SMS_TO)
async function alertTeam(env, { subject, text, html, push }) {
  await Promise.all([
    push ? sendPush(env, push) : null,
    sendEmail(env, { to: env.NOTIFY_TO, subject, html }),
    sendSms(env, env.ALERT_SMS_TO, text),
  ]);
}

// tap-to-call: Slack and other chat apps make web links tappable but not phone numbers, so we send a link to a page with one big Call button
const digitsOf = p => String(p || "").replace(/\D/g, "");
const e164 = p => { const d = digitsOf(p); return d.length === 10 ? "+1" + d : d.length === 11 && d[0] === "1" ? "+" + d : d ? "+" + d : ""; };
const prettyPhone = p => { const d = digitsOf(p).slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || ""); };
const callLink = (base, p) => (digitsOf(p).length >= 10 ? `${base}/call/${digitsOf(p)}` : "");
// Link to the call page inside the CRM (needs a sign in, and logs who tapped Call). Falls back to the public page when there is no lead id.
const goLink = (env, base, id, p) => (id ? (env.CRM_HOST ? `https://${env.CRM_HOST}/go/${id}` : `${base}/admin/go/${id}`) : callLink(base, p));
function callPage(num) {
  const d = digitsOf(num);
  if (d.length < 10 || d.length > 15) return new Response("Not found", { status: 404 });
  const tel = e164(d), label = prettyPhone(d);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Call ${esc(label)}</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07090c;color:#e8eaed;font:18px system-ui,-apple-system,Segoe UI,sans-serif;padding:20px;text-align:center}
a.b{display:block;background:#32cd32;color:#04120a;font-weight:800;text-decoration:none;border-radius:16px;padding:22px 28px;font-size:24px;margin-top:18px}p{margin:0;color:#8a9099}</style></head>
<body><main><p>Tap to call</p><a class="b" href="tel:${esc(tel)}">Call ${esc(label)}</a></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function notify(env, lead, base) {
  const jobs = [];
  const veh = [lead.year, lead.make, lead.model].filter(Boolean).join(" ");
  const link = crmLink(env, base, "/admin/pipeline");
  // `text` is a ready-written line, so Zapier (or anything else) can pass it straight on as an SMS or chat message
  const line = lead.type === "newsletter" ? `Newsletter signup: ${lead.email}` : `NEW LEAD: ${lead.name}, ${lead.service}${veh ? ", " + veh : ""}. ${lead.phone}. Call now. ${link}`;
  if (env.LEAD_WEBHOOK_URL) jobs.push(fetch(env.LEAD_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...lead, text: line, crm_link: link, phone_e164: e164(lead.phone), phone_display: prettyPhone(lead.phone), call_link: goLink(env, base, lead.id, lead.phone) }) }).catch(() => {}));
  if (lead.type === "newsletter") {
    jobs.push(sendEmail(env, { to: env.NOTIFY_TO, subject: `Newsletter signup: ${lead.email}`, html: `<p>${esc(lead.email)} joined the newsletter.</p>` }));
  } else {
    const rows = Object.entries(lead).filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join("");
    const text = `NEW LEAD: ${lead.name}, ${lead.service}${veh ? ", " + veh : ""}. ${lead.phone}. Call now, answer fast wins the job. ${link}`;
    const html = `<p style="font-size:16px"><b>New lead: ${esc(lead.name)}</b> &middot; ${esc(lead.service)}${veh ? " &middot; " + esc(veh) : ""}</p>
      <p><a href="tel:${esc(lead.phone)}" style="background:#32cd32;color:#04120a;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:700">Call ${esc(lead.phone)}</a>
      &nbsp; <a href="${esc(link)}">Open in CRM</a></p><table>${rows}</table>`;
    jobs.push(alertTeam(env, { subject: `New lead: ${lead.name} (${lead.service}${veh ? ", " + veh : ""})`, text, html,
      push: { title: `New lead: ${lead.name}`, message: [lead.service, veh, lead.phone].filter(Boolean).join(" | "), click: crmLink(env, base, "/admin/today") } }));
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
    alertTeam(env, { subject: `${vm ? "Voicemail" : "Missed call"}: ${who}`, text, html,
      push: { title: `${vm ? "Voicemail" : "Missed call"}: ${who}`, message: [row.phone, src].filter(Boolean).join(" | ") + ". Call them back.", click: link } }),
    env.LEAD_WEBHOOK_URL ? fetch(env.LEAD_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "call", ...row, text, crm_link: link, phone_e164: e164(row.phone), phone_display: prettyPhone(row.phone), call_link: goLink(env, base, row.id, row.phone) }) }).catch(() => {}) : null,
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

// After someone taps Call, ask (when they come back to the CRM) whether the lead answered. This feeds the contact rate on the Speed page.
const OUTCOMES = [["Answered", "Answered"], ["No answer", "No answer"], ["Left a voicemail", "Voicemail"], ["Wrong number", "Wrong number"]];
const OUTCOME_HTML = `<dialog class="rdlg" id="odlg"><div class="rb"><h3 id="ot"></h3><p>Did they pick up?</p><div class="fu-chips" id="og"></div><div class="ra"><button type="button" id="os">Skip</button></div></div></dialog>`;
const OUTCOME_JS = `
const OUTC=${JSON.stringify(OUTCOMES)};
function markCall(id,name){try{localStorage.setItem('dd_pc',JSON.stringify({id:id,name:name||'this lead',t:Date.now()}))}catch(_){}}
function askOutcome(){let p=null;try{p=JSON.parse(localStorage.getItem('dd_pc')||'null')}catch(_){}
  const d=document.getElementById('odlg');if(!p||!d||d.open)return;const age=Date.now()-p.t;
  if(age>6*36e5){try{localStorage.removeItem('dd_pc')}catch(_){}return}if(age<4000)return;
  document.getElementById('ot').textContent='Did '+p.name+' answer?';const g=document.getElementById('og');g.innerHTML='';
  OUTC.forEach(([v,l])=>{const b=document.createElement('button');b.type='button';b.textContent=l;b.onclick=async()=>{b.disabled=true;try{await fetch('/admin/outcome',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:p.id,outcome:v})})}catch(_){}try{localStorage.removeItem('dd_pc')}catch(_){}d.close()};g.appendChild(b)});
  document.getElementById('os').onclick=()=>{try{localStorage.removeItem('dd_pc')}catch(_){}d.close()};d.showModal()}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)setTimeout(askOutcome,400)});window.addEventListener('focus',()=>setTimeout(askOutcome,400));window.addEventListener('pageshow',()=>setTimeout(askOutcome,600));setTimeout(askOutcome,800);
`;

const stageName = k => (STAGES.find(x => x[0] === k) || [k, k])[1];
const crmPrefix = env => ""; // paths are the same on every host
const badge = n => (n ? `<i class="nb">${n > 99 ? "99+" : n}</i>` : "");
const OWNER = "bronson"; // only this login sees the Speed page
const SPEED_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5l3 2M9 2h6M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z"/></svg>';
function nav(on, n = 0, owner = false) {
  return `<nav class="navtabs"><a href="/admin/today" class="${on === "today" ? "on" : ""}">Today${badge(n)}</a><a href="/admin" class="${on === "leads" ? "on" : ""}">Leads</a><a href="/admin/pipeline" class="${on === "pipeline" ? "on" : ""}">Pipeline</a>${owner ? `<a href="/admin/speed" class="${on === "speed" ? "on" : ""}">Speed</a><a href="/admin/rate" class="${on === "rate" ? "on" : ""}">Contact rate</a><a href="/admin/insights" class="${on === "insights" ? "on" : ""}">Insights</a>` : ""}<a href="/logout" class="so">Sign out</a></nav>`;
}
// phone: thumb-reach tab bar fixed to the bottom of the screen
function bnav(on, n = 0, owner = false) {
  return `<nav class="bnav" aria-label="Sections"><a href="/admin/today" class="${on === "today" ? "on" : ""}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM9 9l2 2 4-4M9 15h6"/></svg>Today${badge(n)}</a><a href="/admin" class="${on === "leads" ? "on" : ""}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>Leads</a><a href="/admin/pipeline" class="${on === "pipeline" ? "on" : ""}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z"/></svg>Pipeline</a>${owner ? `<a href="/admin/speed" class="${on === "speed" ? "on" : ""}">${SPEED_ICON}Speed</a><a href="/admin/rate" class="${on === "rate" ? "on" : ""}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V10M12 20V4M19 20v-7"/></svg>Rate</a><a href="/admin/insights" class="${on === "insights" ? "on" : ""}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19h16M6 15l4-5 3 3 5-7"/></svg>Insights</a>` : ""}</nav>`;
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
  .bnav{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:30;background:rgba(10,13,17,.97);backdrop-filter:blur(8px);border-top:1px solid #1d2229;padding:6px 6px calc(6px + env(safe-area-inset-bottom,0px));gap:3px}
  .bnav a{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 0;border-radius:12px;color:#8a9099;text-decoration:none;font-size:11px;font-weight:600;min-height:52px;justify-content:center}
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

async function adminPage(env, user = "") {
  await ensureTable(env.DB);
  const tc = await todayCount(env);
  const { results } = await env.DB.prepare("SELECT * FROM leads ORDER BY created_at DESC, id DESC LIMIT 500").all();
  const open = results.filter(l => l.stage === "new" && l.type === "quote").length;
  const ads = results.filter(l => sourceOf(l).ad).length;
  const cards = results.map(l => {
    const t = when(l.created_at), src = sourceOf(l);
    const veh = [l.year, l.make, l.model].filter(Boolean).join(" ");
    const tel = (l.phone || "").replace(/[^\d+]/g, "");
    return `<article class="lead ${["done", "lost"].includes(l.stage) ? "done" : l.stage === "new" ? "new" : ""}" data-id="${l.id}" data-q="${esc([l.name, l.email, l.phone, l.service, veh, l.message, src.label, src.detail].join(" ").toLowerCase())}" data-st="${l.stage === "new" ? "new" : "done"}" data-ad="${src.ad ? 1 : 0}">
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
<body><header><h1>Divine Detailers <b>leads</b></h1>${nav("leads", tc, user === OWNER)}
<div class="stats"><div class="stat hot"><b>${open}</b><span>to contact</span></div><div class="stat"><b>${results.length}</b><span>total</span></div><div class="stat"><b>${ads}</b><span>from Google Ads</span></div></div></header>
<div class="tools"><input type="search" id="q" placeholder="Search name, phone, vehicle, service..."><button class="chip on" data-f="all">All</button><button class="chip" data-f="new">New</button><button class="chip" data-f="done">Worked</button><button class="chip" data-f="ad">Google Ads</button><a class="csv" href="/admin/pipeline#add">+ Add lead</a><a class="csv" href="/admin/leads.csv">Download CSV</a></div>
${bnav("leads", tc, user === OWNER)}
${FOLLOW_HTML}
${OUTCOME_HTML}
<main id="list">${cards || '<p class="empty">No leads yet. They will appear here the moment someone submits a form.</p>'}</main>
<script>
const list=document.getElementById('list'),q=document.getElementById('q');let f='all';
function apply(){const t=q.value.trim().toLowerCase();list.querySelectorAll('.lead').forEach(e=>{const ok=(!t||e.dataset.q.includes(t))&&(f==='all'||(f==='ad'?e.dataset.ad==='1':e.dataset.st===f));e.hidden=!ok})}
q.addEventListener('input',apply);document.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{document.querySelectorAll('.chip').forEach(x=>x.classList.toggle('on',x===c));f=c.dataset.f;apply()}));
${FOLLOW_JS}
${OUTCOME_JS}
const post=(u,b)=>fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
document.addEventListener('click',e=>{const a=e.target.closest('a[href^="tel:"]');if(!a)return;const h=a.closest('[data-id]');if(!h||!h.dataset.id)return;markCall(+h.dataset.id,((h.querySelector('h3,b')||{}).textContent||'').trim());try{fetch('/admin/touch',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({id:+h.dataset.id,label:'Called'})})}catch(_){}});
document.addEventListener('change',async e=>{const s=e.target.closest('select.stage');if(!s)return;const to=s.value,id=+s.dataset.id;const nm=(s.closest('.lead').querySelector('h3')||{}).textContent;s.disabled=true;
  const r=await post('/admin/stage',{id,stage:to});if(!r.ok){s.disabled=false;s.value=s.dataset.cur;return}const nx=await askNext(nm,to);if(nx)await post('/admin/stage',{id,followup:nx.followup,follow_date:nx.follow_date});location.reload()});
</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}


async function pipelinePage(env, user = "") {
  await ensureTable(env.DB);
  const tc = await todayCount(env);
  const { results } = await env.DB.prepare("SELECT id,created_at,type,name,email,phone,service,also_interested,make,year,model,message,page,referrer,gclid,utm_medium,utm_source,utm_campaign,utm_term,stage,value,notes,stage_changed_at,follow_up,follow_up_date,duration,recording,answered FROM leads WHERE type != 'newsletter' ORDER BY created_at DESC, id DESC LIMIT 1000").all();
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
<header><h1>Divine Detailers <b>pipeline</b></h1>${nav("pipeline", tc, user === OWNER)}<div class="sum" id="sum"></div><button class="addb" id="addb" type="button">+ Add lead</button></header>
<div class="tabs" id="tabs"></div>
${bnav("pipeline", tc, user === OWNER)}
<div class="board" id="board"></div>
<dialog id="dlg"></dialog>
${FOLLOW_HTML}
${OUTCOME_HTML}
<script type="application/json" id="data">${payload}</script>
<script>
${FOLLOW_JS}
${OUTCOME_JS}
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
document.addEventListener('click',e=>{const a=e.target.closest('a[href^=\"tel:\"]');if(!a)return;const h=a.closest('[data-id]');if(!h||!h.dataset.id)return;markCall(+h.dataset.id,((h.querySelector('h3,b')||{}).textContent||'').trim());try{fetch('/admin/touch',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({id:+h.dataset.id,label:'Called'})})}catch(_){}});
const SVC=['Window Tint','PPF / Clear Bra','Ceramic Coating','Paint Correction','Vinyl Wraps','Exterior Detailing','Other'];
function open(id){const l=L.find(x=>x.id===id);if(!l)return;dlg.dataset.id=id;const tel=(l.phone||'').replace(/[^\\d+]/g,''),veh=[l.year,l.make,l.model].filter(Boolean).join(' '),isCall=l.type==='call';
  const ed='<details class="ed"'+((isCall||!l.service)?' open':'')+'><summary>Edit contact and vehicle</summary><div class="g2"><div><label>Name</label><input id="en" value="'+$(l.name||'')+'" autocomplete="off"></div><div><label>Phone</label><input id="ep" type="tel" inputmode="tel" value="'+$(l.phone||'')+'"></div><div><label>Email</label><input id="ee" type="email" value="'+$(l.email||'')+'"></div><div><label>Service</label><select id="es"><option value="">Not set</option>'+SVC.map(x=>'<option'+(x===l.service?' selected':'')+'>'+x+'</option>').join('')+'</select></div><div><label>Make</label><input id="em" value="'+$(l.make||'')+'"></div><div><label>Model</label><input id="ed2" value="'+$(l.model||'')+'"></div><div><label>Year</label><input id="ey" inputmode="numeric" value="'+$(l.year||'')+'"></div></div></details>';
  dlg.innerHTML='<div class="dh"><div><h3>'+$(l.name||l.phone||l.email||'Unknown caller')+'</h3><div style="color:#8a9099;font-size:13px">'+$(l.ago)+' &middot; '+$(l.abs)+' ET &middot; '+$(l.src)+'</div></div><button class="x" onclick="dlg.close()" aria-label="Close">&times;</button></div><div class="db">'+
  (!isCall&&l.recording?'<div style="font-size:14px"><a class="rec" href="'+$(l.recording)+'" target="_blank" rel="noopener">Listen to the call</a></div>':'')+(isCall?'<div style="color:#c9a8ff;font-size:14px">'+(/voicemail/i.test(l.message||'')?'Voicemail':l.answered===0?'Missed call':'Phone call'+(l.dur?' &middot; '+$(l.dur):''))+(l.recording?' &middot; <a class="rec" href="'+$(l.recording)+'" target="_blank" rel="noopener">Listen to the call</a>':'')+'</div>':'')+
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
  const { results } = await env.DB.prepare("SELECT * FROM leads ORDER BY created_at DESC, id DESC").all();
  const cols = ["id", "created_at", "type", "name", "email", "phone", "service", "also_interested", "make", "year", "model", "message", "page", "referrer", "gclid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "stage", "value", "notes", "duration", "answered", "recording"];
  const q = v => { let s = String(v ?? ""); if (/^(=|@|[+\-][^\d(\s])/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const body = [cols.join(","), ...results.map(r => cols.map(c => q(r[c])).join(","))].join("\n");
  return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="divine-detailers-leads.csv"', "cache-control": "no-store" } });
}

// ---- Reminder: leads nobody has called yet (runs every minute from a Cloudflare cron trigger)
// REMIND_MINUTES: how long a lead may wait before a reminder goes out (default 10, set to 0 to turn reminders off)
// Reminders only go out during business hours (Mon to Sat, 9 to 6 Eastern), so overnight leads get one reminder when the shop opens.
async function remindStale(env) {
  if (!env.DB) return;
  const mins = env.REMIND_MINUTES === undefined || env.REMIND_MINUTES === "" ? 10 : Number(env.REMIND_MINUTES);
  if (!(mins > 0)) return;
  const nowSql = new Date().toISOString().slice(0, 19).replace("T", " ");
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date()).map(x => [x.type, x.value]));
  if (env.REMIND_ALWAYS !== "1" && !inBusinessHours()) return;
  await ensureTable(env.DB);
  const { results } = await env.DB.prepare(`SELECT l.id, l.name, l.phone, l.created_at FROM leads l
    WHERE l.type != 'newsletter' AND l.stage = 'new' AND l.reminded_at IS NULL AND COALESCE(l.ip,'') != 'demo'
      AND NOT (l.type = 'call' AND l.answered = 1)
      AND l.created_at <= datetime('now', ?) AND l.created_at >= datetime('now', '-2 days')
      AND NOT EXISTS (SELECT 1 FROM stage_log s WHERE s.lead_id = l.id AND (s.reason LIKE 'Called%' OR s.reason LIKE 'Call result%' OR s.reason LIKE 'Left a voicemail%' OR s.reason LIKE 'Spoke to the customer%' OR s.reason LIKE 'Auto-dial: calling the lead%'))
    ORDER BY l.created_at ASC LIMIT 20`).bind(`-${Math.round(mins)} minutes`).all();
  if (!results.length) return;
  await env.DB.batch(results.map(r => env.DB.prepare("UPDATE leads SET reminded_at = ? WHERE id = ?").bind(nowSql, r.id)));
  const waited = r => { const m = Math.round((Date.now() - new Date(r.created_at.replace(" ", "T") + "Z").getTime()) / 60000); return m < 90 ? `${m} min` : `${Math.round(m / 60)} hr`; };
  const list = results.map(r => `${r.name || r.phone} (${waited(r)})`).join(", ");
  const link = env.CRM_HOST ? `https://${env.CRM_HOST}/today` : "";
  const text = `${results.length === 1 ? "REMINDER: 1 lead has not been called yet" : `REMINDER: ${results.length} leads have not been called yet`}: ${list}. ${link}`.trim();
  const html = `<p style="font-size:16px"><b>${esc(text.replace(link, "").trim())}</b></p>${link ? `<p><a href="${esc(link)}">Open today's list</a></p>` : ""}`;
  await Promise.all([
    alertTeam(env, { subject: "Leads waiting to be called", text, html, push: { title: "Leads waiting to be called", message: list, click: link || undefined } }),
    env.LEAD_WEBHOOK_URL ? fetch(env.LEAD_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "reminder", text, crm_link: link, leads: results.map(r => ({ id: r.id, name: r.name, phone: r.phone, phone_display: prettyPhone(r.phone), call_link: goLink(env, "", r.id, r.phone), waiting: waited(r) })) }) }).catch(() => {}) : null,
  ]);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(remindStale(env).catch(e => console.error("reminder error", e && e.message)));
  },
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
      if (p === "/speed" || p === "/admin/speed") return adminRoute("/admin/speed", request, env);
      if (p === "/rate" || p === "/admin/rate") return adminRoute("/admin/rate", request, env);
      if (p === "/insights" || p === "/admin/insights") return adminRoute("/admin/insights", request, env);
      if (p.startsWith("/go/")) return adminRoute("/admin/go/" + p.slice(4), request, env);
      if (p === "/admin" || p === "/leads") return adminRoute("/admin", request, env);
      if (p === "/pipeline" || p === "/admin/pipeline") return adminRoute("/admin/pipeline", request, env);
      if (p === "/admin/stage" || p === "/admin/lead" || p === "/admin/add" || p === "/admin/touch" || p === "/admin/outcome" || p === "/admin/callrailtest" || p === "/admin/verifyshop" || p === "/admin/adspend" || p === "/admin/demo" || p === "/admin/testalert") return adminRoute(p, request, env);
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

    if (p.startsWith("/call/")) return callPage(p.slice(6));

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
// Sends a test push and reports what happened, so a broken setup can be diagnosed from the CRM itself
async function testAlert(request, env) {
  const topic = (env.NTFY_TOPIC || "").trim();
  const out = { push_topic_set: !!topic, topic_hint: topic ? topic.slice(0, 3) + "..." + topic.slice(-2) + " (" + topic.length + " characters)" : "", has_slash_or_space: /[\s/:]/.test(topic), push_token_set: !!env.NTFY_TOKEN, topic_too_short: topic.length > 0 && topic.length < 16, email: !!(env.RESEND_API_KEY && env.NOTIFY_TO), sms: !!(env.TWILIO_SID && env.TWILIO_TOKEN && env.TWILIO_FROM && env.ALERT_SMS_TO), zapier_webhook: !!env.LEAD_WEBHOOK_URL };
  if (topic) {
    const server = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
    try {
      const r = await fetch(server, { method: "POST", headers: { "content-type": "application/json", ...(env.NTFY_TOKEN ? { authorization: `Bearer ${env.NTFY_TOKEN.trim()}` } : {}) }, body: JSON.stringify({ topic, title: "Test alert from your CRM", message: "If you can read this, lead alerts will reach this phone.", priority: 4, tags: ["white_check_mark"], click: crmLink(env, new URL(request.url).origin, "/admin/today") }) });
      out.push_status = r.status; out.push_response = (await r.text()).slice(0, 200);
    } catch (e) { out.push_status = 0; out.push_response = String(e && e.message || e).slice(0, 200); }
  }
  return json({ success: true, ...out });
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

// Tap-to-call page inside the CRM: one big Call button that logs who called, plus Text and a link to the lead
async function goPage(env, id, user) {
  await ensureTable(env.DB);
  const l = await env.DB.prepare("SELECT id,name,phone,email,service,make,year,model,message,stage FROM leads WHERE id = ?").bind(id).first();
  if (!l) return new Response("Lead not found", { status: 404 });
  const veh = [l.year, l.make, l.model].filter(Boolean).join(" "), tel = e164(l.phone), label = prettyPhone(l.phone);
  const first = (l.name || "").trim().split(/\s+/)[0] || "there";
  const sms = `sms:${tel}?&body=${encodeURIComponent(`Hi ${first}, this is ${SHOP.name}. Thanks for reaching out${l.service ? " about " + l.service.toLowerCase() : ""}. When is a good time to talk? Call or text me anytime at ${SHOP.phone}.`)}`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Call ${esc(l.name || label)}</title>
<style>${FOLLOW_CSS}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07090c;color:#e8eaed;font:17px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;padding:20px;text-align:center}
main{width:min(420px,100%);display:flex;flex-direction:column;gap:12px}h1{margin:0;font-size:26px}p{margin:0;color:#98a0aa}
a.b{display:block;border-radius:16px;padding:20px;font-weight:800;text-decoration:none;font-size:22px;border:1px solid #2a313a;background:#151a21;color:#e8eaed}a.b.c{background:#32cd32;border-color:#32cd32;color:#04120a;font-size:24px;padding:24px}
.s{font-size:15px;font-weight:600;padding:16px}.m{background:#0d1116;border-left:3px solid #32cd32;border-radius:0 10px 10px 0;padding:10px 12px;text-align:left;color:#d6d9de;font-size:15px}</style></head>
<body><main><h1>${esc(l.name || label)}</h1><p>${esc([l.service, veh].filter(Boolean).join(" · ") || "New lead")}</p>${l.message ? `<div class="m">&ldquo;${esc(l.message.slice(0, 240))}&rdquo;</div>` : ""}
<a class="b c" id="call" href="tel:${esc(tel)}">Call ${esc(label)}</a><a class="b" id="text" href="${esc(sms)}">Text</a><a class="b s" href="/admin/pipeline#id=${l.id}">Open in the CRM</a>
<p style="font-size:13px">Signed in as ${esc(user)}. Tapping Call or Text logs it on this lead.</p></main>
${OUTCOME_HTML}<script>${OUTCOME_JS}
for(const [id,label] of [['call','Called'],['text','Texted: First reply']])document.getElementById(id).addEventListener('click',()=>{if(label==='Called')markCall(${l.id},${JSON.stringify(l.name || label || "this lead").replace(/</g, "\\u003c")});try{fetch('/admin/touch',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({id:${l.id},label:label})})}catch(_){}});</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// ---- shared by the Speed and Contact rate pages: date range chips, business-hours toggle, simple bar charts
const RANGE_CSS = `.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center}#rs{background:#10141a;border:1px solid #232932;color:#fff;border-radius:999px;padding:0 38px 0 16px;font:inherit;font-size:16px;font-weight:600;min-height:44px;color-scheme:dark;flex:1 1 0;min-width:0;max-width:260px}.rf{flex-wrap:nowrap}.rf .chip{white-space:nowrap;flex:0 0 auto;font-size:13.5px;padding:9px 11px}#rs{padding-left:14px;padding-right:30px}#cr input{background:#10141a;border:1px solid #232932;color:#fff;border-radius:10px;padding:9px 10px;font:inherit;color-scheme:dark;min-height:42px}
.chip{background:#10141a;border:1px solid #232932;color:#cfd3d9;border-radius:999px;padding:9px 14px;cursor:pointer;font:inherit;min-height:42px}.chip.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}`;
const RANGE_HTML = `<div class="filters rf"><select id="rs" aria-label="Date range"><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="week">This week</option><option value="lastweek">Last week</option><option value="month">This month</option><option value="lastmonth">Last month</option><option value="last7" selected>Last 7 days</option><option value="last30">Last 30 days</option><option value="all">All time</option><option value="custom">Custom dates&hellip;</option></select><button class="chip" id="bh">Business hours only</button></div>
<div class="filters"><span id="cr" style="display:none;gap:8px;align-items:center"><input type="date" id="cf" aria-label="From"> <span>to</span> <input type="date" id="ct" aria-label="To"></span><span class="note" id="rl"></span></div>`;
const RANGE_JS = `let range='last7',bh=false;
const dt=s=>{const p=s.split('-').map(Number);return new Date(Date.UTC(p[0],p[1]-1,p[2]))},ds=d=>d.toISOString().slice(0,10),add=(s,n)=>{const d=dt(s);d.setUTCDate(d.getUTCDate()+n);return ds(d)},mon=s=>add(s,-((dt(s).getUTCDay()+6)%7));
function bounds(){if(range==='custom')return [document.getElementById('cf').value||null,document.getElementById('ct').value||null];
 const lm=add(TODAY.slice(0,8)+'01',-1);
 return ({today:[TODAY,TODAY],yesterday:[add(TODAY,-1),add(TODAY,-1)],week:[mon(TODAY),TODAY],lastweek:[add(mon(TODAY),-7),add(mon(TODAY),-1)],month:[TODAY.slice(0,8)+'01',TODAY],lastmonth:[lm.slice(0,8)+'01',lm],last7:[add(TODAY,-6),TODAY],last30:[add(TODAY,-29),TODAY],all:[null,null]})[range]}
const nice=s=>dt(s).toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'});
function pick(){const b=bounds(),f=b[0],t=b[1];document.getElementById('rl').textContent=(f||t)?((f?nice(f):'the beginning')+(f===t?'':' to '+(t?nice(t):'today'))):'All time';
 return R.filter(r=>(!f||r.cd>=f)&&(!t||r.cd<=t)&&!(bh&&r.after))}
document.getElementById('rs').addEventListener('change',e=>{range=e.target.value;document.getElementById('cr').style.display=range==='custom'?'inline-flex':'none';draw()});
document.getElementById('bh').addEventListener('click',e=>{bh=!bh;e.currentTarget.classList.toggle('on',bh);draw()});
['cf','ct'].forEach(i=>document.getElementById(i).addEventListener('change',draw));`;
const CHART_CSS = `.chart{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:14px 10px 10px;overflow-x:auto}.cols{display:flex;gap:6px;height:230px;min-width:480px}
.col{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center}.plot{flex:1;width:100%;display:flex;align-items:flex-end;justify-content:center;padding-top:24px}
.stack{position:relative;width:100%;max-width:66px;display:flex}.bar{flex:1;background:#32cd32;border-radius:6px 6px 0 0;min-height:2px}.bar.mid{background:#ffb86b}.bar.low{background:#ff8a8a}.bar.mute{background:#3a4552}.bar.small{opacity:.55}
.stack b{position:absolute;top:-20px;left:50%;transform:translateX(-50%);font-size:12px;white-space:nowrap}.col .l{font-size:11.5px;color:#aab0b9;text-align:center;margin-top:6px;line-height:1.25}.col .s{font-size:10.5px;color:#7c838d;text-align:center;line-height:1.2;min-height:13px}
.insight{background:#0d1116;border:1px solid #244d2a;border-radius:14px;padding:14px 16px;color:#d6d9de}.insight b{color:#32cd32}
table.tb{width:100%;border-collapse:collapse;font-size:14px}table.tb th,table.tb td{text-align:right;padding:9px 10px;border-bottom:1px solid #1d2229}table.tb th:first-child,table.tb td:first-child{text-align:left}table.tb th{color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.6px;font-weight:600}.tbw{overflow-x:auto;background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:4px 8px}`;
const CHART_JS = `function bars(id,items){const mx=Math.max(1,...items.map(i=>i.v));
 document.getElementById(id).innerHTML='<div class="cols">'+items.map(i=>'<div class="col"><div class="plot"><div class="stack" style="height:'+Math.max(i.v>0?2:0,Math.round(100*i.v/mx))+'%"><b>'+i.t+'</b><div class="bar '+(i.c||'')+(i.small?' small':'')+'"></div></div></div><span class="l">'+i.l+'</span><span class="s">'+(i.s||'')+'</span></div>').join('')+'</div>'}`;

// ---- Speed to lead (owner only): how fast every lead got its first contact attempt, and by whom
const BOOKED = ["booked", "working", "done"];
async function speedRows(env) {
  await ensureTable(env.DB);
  const { results: leads } = await env.DB.prepare("SELECT id,created_at,type,name,phone,service,make,year,model,answered,stage,stage_changed_at,value,gclid,utm_medium,utm_source,utm_campaign,utm_term,referrer FROM leads WHERE type != 'newsletter' AND COALESCE(ip,'') != 'demo' ORDER BY created_at DESC, id DESC LIMIT 3000").all();
  const { results: logs } = await env.DB.prepare("SELECT lead_id, at, by_user, reason, to_stage FROM stage_log ORDER BY id ASC LIMIT 30000").all();
  // The clock only stops when the lead is actually called: the Call button, a logged call outcome, or the auto-dial reaching the lead.
  // Texts, emails, the Contacted button and stage changes do not stop it.
  const isCallLog = r => /^(called|call result|auto-dial: calling the lead|left a voicemail|spoke to the customer)/i.test(r || "");
  const REACHED = /^(call result: answered|spoke to the customer|auto-dial: lead answered)/i, RESULT = /^call result: (.+)/i, ATTEMPT = /^(called|auto-dial: calling the lead)/i;
  const byLead = new Map();
  for (const g of logs) { if (!byLead.has(g.lead_id)) byLead.set(g.lead_id, []); byLead.get(g.lead_id).push(g); }
  const first = new Map();
  for (const g of logs) if (!first.has(g.lead_id) && isCallLog(g.reason)) first.set(g.lead_id, g);
  const ms = sql => new Date(sql.replace(" ", "T") + "Z").getTime();
  const iso = sql => new Date(ms(sql)).toISOString();
  const fmt = sql => new Date(ms(sql)).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const etParts = sql => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(ms(sql))).map(x => [x.type, x.value])); return { wd: p.weekday, h: Number(p.hour) }; };
  const rows = leads.map(l => {
    let contact = "", by = "", how = "";
    const g = first.get(l.id);
    if (l.type === "call" && l.answered === 1) { contact = l.created_at; how = "Answered live"; }
    else if (g) { contact = g.at; by = g.by_user || ""; how = g.reason || ""; }
    const t = etParts(l.created_at);
    const gl = byLead.get(l.id) || [];
    const reachedLog = gl.find(g => REACHED.test(g.reason || ""));
    const results = gl.map(g => { const m = RESULT.exec(g.reason || ""); return m ? { by: g.by_user || "", res: m[1] } : null; }).filter(Boolean);
    const lostLog = [...gl].reverse().find(g => g.to_stage === "lost"), bookedLog = gl.find(g => BOOKED.includes(g.to_stage));
    const so = sourceOf(l);
    return {
      id: l.id, name: l.name || l.phone || "Unknown", type: l.type, what: [l.service, [l.year, l.make, l.model].filter(Boolean).join(" ")].filter(Boolean).join(" · "),
      src: sourceOf(l).label, ad: sourceOf(l).ad, created: iso(l.created_at), created_abs: fmt(l.created_at), cd: new Date(ms(l.created_at)).toLocaleDateString("en-CA", { timeZone: TZ }),
      contact: contact ? iso(contact) : "", contact_abs: contact ? fmt(contact) : "", by, how,
      secs: contact ? Math.max(0, Math.round((ms(contact) - ms(l.created_at)) / 1000)) : null,
      booked: BOOKED.includes(l.stage) || gl.some(g => BOOKED.includes(g.to_stage)), value: l.value || 0,
      service: l.service || "Not set", stage: l.stage, h: t.h, srckey: so.ad ? "Google Ads" + (l.utm_campaign ? " \u00b7 " + l.utm_campaign : "") : so.label,
      lost: l.stage === "lost" ? (lostLog && lostLog.reason && lostLog.reason !== "Moved" ? lostLog.reason : "No reason logged") : "",
      booked_days: bookedLog ? Math.max(0, (ms(bookedLog.at) - ms(l.created_at)) / 864e5) : null, qv: l.stage === "quoted" ? (l.value || 0) : 0,
      outs: gl.filter(g => RESULT.test(g.reason || "")).map(g => ({ h: etParts(g.at).h, ok: /answered/i.test(g.reason || "") })),
      attempts: gl.filter(g => ATTEMPT.test(g.reason || "")).length, reached: !!reachedLog, reached_by: reachedLog ? reachedLog.by_user || "" : "", results,
      after: t.wd === "Sun" || t.h < 9 || t.h >= 18, open: !contact && !["done", "lost"].includes(l.stage),
    };
  });
  return rows;
}

async function speedPage(env, user) {
  await ensureTable(env.DB);
  const tc = await todayCount(env);
  const rows = await speedRows(env);
  const payload = JSON.stringify({ rows, now: Date.now(), today: todayStr() }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Speed to lead | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#07090c;color:#e8eaed}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}.navtabs a.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
main{max-width:1000px;margin:0 auto;padding:16px 22px 40px;display:flex;flex-direction:column;gap:18px}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center}#cr input{background:#10141a;border:1px solid #232932;color:#fff;border-radius:10px;padding:9px 10px;font:inherit;color-scheme:dark;min-height:42px}.chip{background:#10141a;border:1px solid #232932;color:#cfd3d9;border-radius:999px;padding:9px 14px;cursor:pointer;font:inherit;min-height:42px}.chip.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
${RANGE_CSS}
${CHART_CSS}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.kpi{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:14px}.kpi b{display:block;font-size:26px;line-height:1.15}.kpi span{color:#8a9099;font-size:12.5px}.kpi.g b{color:#32cd32}.kpi.r b{color:#ff8a8a}
.who{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.who div{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:12px 14px}.who h3{margin:0 0 4px;font-size:15px;text-transform:capitalize}.who span{color:#8a9099;font-size:13px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:#c3c8cf;margin:6px 0 0}
.list{display:flex;flex-direction:column;gap:8px}.row{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:12px 14px;display:grid;grid-template-columns:1.4fr 1fr 1fr .8fr .7fr .8fr;gap:8px 14px;align-items:start}
.row.late{border-color:#4a2424}.row .n b{display:block;font-size:16px}.row .n small{color:#8a9099;display:block}
.row label{display:block;color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:2px}.row .rt{font-weight:700}.rt.fast{color:#32cd32}.rt.slow{color:#ffb86b}.rt.vslow{color:#ff8a8a}.pill{font-size:11px;padding:2px 8px;border-radius:999px;background:#171c23;color:#aab0b9;margin-left:6px}.pill.ad{background:#14263f;color:#8ec0ff}.pill.ah{background:#2a1f3d;color:#c9a8ff}
.empty{color:#8a9099;padding:24px 0;text-align:center}.note{color:#7c838d;font-size:12.5px}
${BNAV_CSS}
@media(max-width:700px){header{padding:12px 14px}h1{font-size:17px}main{padding:8px 14px 20px}.row{grid-template-columns:1fr 1fr}.row .n{grid-column:1/-1}}
</style></head><body>
<header><h1>Divine Detailers <b>speed to lead</b></h1>${nav("speed", tc, true)}</header>
${bnav("speed", tc, true)}
<main>
${RANGE_HTML}
<div class="kpis" id="k"></div>
<h2>How fast leads were called (number of leads)</h2><div class="chart" id="c1"></div>
<h2>By person</h2><div class="who" id="w"></div>
<h2>Every lead, newest first</h2><div class="list" id="l"></div>
<p class="note">A lead's clock starts when the form is sent or the call comes in. It stops only when the lead is actually called: the first tap on a Call button, a logged call result (called, left a voicemail, spoke to the customer) or, later, the auto-dial reaching the lead. Texts, emails, the Contacted button and stage changes do not stop it. An answered inbound call counts as instant. Contact rate counts form leads only: after a Call tap the CRM asks whether the lead answered, and a lead counts as reached when someone answered (or the call result is logged as Spoke to the customer). Calls made from a phone without using the CRM buttons are not seen. Business hours are Mon to Sat, 9 AM to 6 PM Eastern.</p>
</main>
<script type="application/json" id="data">${payload}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent),R=D.rows,TODAY=D.today;
const $=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function dur(s){if(s==null)return '';if(s<60)return s+' sec';const m=Math.round(s/60);if(m<60)return m+' min';const h=Math.floor(m/60),mm=m%60;if(h<48)return h+' h'+(mm?' '+mm+' min':'');return Math.round(h/24)+' days'}
const med=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),i=Math.floor(b.length/2);return b.length%2?b[i]:Math.round((b[i-1]+b[i])/2)};
const avg=a=>a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length):null;
const cls=s=>s==null?'':s<=300?'fast':s<=3600?'slow':'vslow';
${RANGE_JS}
${CHART_JS}
function draw(){const L=pick(),done=L.filter(r=>r.secs!=null),secs=done.map(r=>r.secs),wait=L.filter(r=>r.secs==null&&r.open),forms=L.filter(r=>r.type==='quote'),calledF=forms.filter(r=>r.secs!=null),reachedF=calledF.filter(r=>r.reached);
 const pct=t=>done.length?Math.round(100*secs.filter(x=>x<=t).length/done.length)+'%':'-';
 const now=Date.now(),waits=wait.map(r=>Math.round((now-new Date(r.created).getTime())/1000));
 document.getElementById('k').innerHTML=
  '<div class="kpi g"><b>'+(med(secs)==null?'-':dur(med(secs)))+'</b><span>Median time to first call</span></div>'+
  '<div class="kpi"><b>'+(avg(secs)==null?'-':dur(avg(secs)))+'</b><span>Average time to first call</span></div>'+
  '<div class="kpi"><b>'+pct(300)+'</b><span>Called within 5 min</span></div>'+
  '<div class="kpi"><b>'+pct(3600)+'</b><span>Called within 1 hour</span></div>'+
  '<div class="kpi '+(wait.length?'r':'')+'"><b>'+wait.length+'</b><span>Not called yet'+(waits.length?' (longest '+dur(Math.max(...waits))+')':'')+'</span></div>'+
  '<div class="kpi"><b>'+L.length+'</b><span>Leads in this range</span></div>'+
  '<div class="kpi g"><b>'+(calledF.length?Math.round(100*reachedF.length/calledF.length)+'%':'-')+'</b><span>Contact rate: form leads reached &divide; form leads called</span></div>'+
  '<div class="kpi"><b>'+reachedF.length+' of '+calledF.length+'</b><span>Form leads reached (picked up) out of those called</span></div>'+
  '<div class="kpi"><b>'+(calledF.length?(calledF.reduce((a,r)=>a+Math.max(1,r.attempts),0)/calledF.length).toFixed(1):'-')+'</b><span>Calls per form lead</span></div>';
 const BK=[['1 min',-1,60],['1&ndash;5 min',60,300],['5&ndash;15 min',300,900],['15&ndash;30 min',900,1800],['30&ndash;60 min',1800,3600],['1&ndash;2 hr',3600,7200],['2&ndash;4 hr',7200,14400],['4&ndash;24 hr',14400,86400],['24 hr +',86400,Infinity]];
 bars('c1',BK.map((b,i)=>{const n=done.filter(r=>r.secs>b[1]&&r.secs<=b[2]).length;return {l:b[0],v:n,t:n,s:done.length?Math.round(100*n/done.length)+'%':'',c:i<2?'':i<4?'mid':'low'}}).concat([{l:'Not called yet',v:wait.length,t:wait.length,s:'',c:'mute'}]));
 const by={};done.forEach(r=>{const k=r.by||(r.how==='Answered live'?'answered live':'not recorded');(by[k]=by[k]||[]).push(r.secs)});
 const pc={};L.forEach(r=>(r.results||[]).forEach(x=>{const k=x.by||'not recorded';(pc[k]=pc[k]||{n:0,a:0});pc[k].n++;if(x.res==='Answered')pc[k].a++}));
 const names=[...new Set(Object.keys(by).concat(Object.keys(pc)))].sort();
 document.getElementById('w').innerHTML=names.map(k=>'<div><h3>'+$(k)+'</h3>'+(by[k]?'<b>'+by[k].length+' lead'+(by[k].length===1?'':'s')+'</b> <span>&middot; median '+dur(med(by[k]))+' &middot; avg '+dur(avg(by[k]))+'</span>':'')+(pc[k]?'<br><span>Calls answered: '+pc[k].a+' of '+pc[k].n+' ('+Math.round(100*pc[k].a/pc[k].n)+'%)</span>':'')+'</div>').join('')||'<div class="empty">No contacts recorded yet.</div>';
 document.getElementById('l').innerHTML=L.map(r=>{const w=r.secs==null&&r.open?Math.round((now-new Date(r.created).getTime())/1000):null;
  return '<div class="row'+(w!=null&&w>900?' late':'')+'"><div class="n"><b>'+$(r.name)+'</b><small>'+(r.type==='call'?'Phone call':'Form')+(r.what?' &middot; '+$(r.what):'')+'</small><small>'+(r.type==='call'&&r.src==='Phone call'?'':$(r.src))+(r.ad?'<span class="pill ad">Ads</span>':'')+(r.after?'<span class="pill ah">After hours</span>':'')+'</small></div>'+
  '<div><label>Created at</label>'+$(r.created_abs)+'</div>'+
  '<div><label>Attempted contact at</label>'+(r.contact?$(r.contact_abs)+(r.how?'<small style="display:block;color:#8a9099">'+$(r.how)+'</small>':''):(r.open?'<span class="rt vslow">Not called yet</span>':'<span class="rt" style="color:#8a9099">No call logged</span>'))+'</div>'+
  '<div><label>Time to contact</label><span class="rt '+cls(r.secs!=null?r.secs:w)+'">'+(r.secs!=null?(r.secs===0?'Instant':dur(r.secs)):(w!=null?'Waiting '+dur(w):'-'))+'</span></div>'+
  '<div><label>Contacted by</label>'+(r.by?'<span style="text-transform:capitalize">'+$(r.by)+'</span>':'<span style="color:#586069">-</span>')+'</div>'+
  '<div><label>Result</label>'+(r.reached?'<span class="rt fast">Reached</span>':(r.results&&r.results.length?'<span class="rt slow">'+$(r.results[r.results.length-1].res)+'</span>':(r.attempts?'<span style="color:#8a9099">'+r.attempts+' call'+(r.attempts===1?'':'s')+', no result</span>':'<span style="color:#586069">-</span>')))+(r.attempts>1?'<small style="display:block;color:#8a9099">'+r.attempts+' calls</small>':'')+'</div></div>'}).join('')||'<div class="empty">No leads in this range.</div>'}
draw();setInterval(draw,60000);
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// ---- Contact rate and booked jobs by how fast the lead was first called (owner only)
async function ratePage(env, user) {
  const rows = await speedRows(env);
  const tc = await todayCount(env);
  const payload = JSON.stringify({ rows, today: todayStr() }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Contact rate | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#07090c;color:#e8eaed}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px;flex-wrap:wrap}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}.navtabs a.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
main{max-width:1000px;margin:0 auto;padding:16px 22px 40px;display:flex;flex-direction:column;gap:18px}
${RANGE_CSS}
${CHART_CSS}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.kpi{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:14px}.kpi b{display:block;font-size:26px;line-height:1.15}.kpi span{color:#8a9099;font-size:12.5px}.kpi.g b{color:#32cd32}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:#c3c8cf;margin:6px 0 0}.note{color:#7c838d;font-size:12.5px}
${BNAV_CSS}
@media(max-width:700px){header{padding:12px 14px}h1{font-size:17px}main{padding:8px 14px 20px}}
</style></head><body>
<header><h1>Divine Detailers <b>contact rate</b></h1>${nav("rate", tc, true)}</header>
${bnav("rate", tc, true)}
<main>
${RANGE_HTML}
<div class="kpis" id="k"></div>
<div class="insight" id="ins"></div>
<h2>Contact rate by how fast the lead was first called</h2><div class="chart" id="c1"></div>
<h2>Booked jobs by how fast the lead was first called</h2><div class="chart" id="c2"></div>
<h2>The numbers behind the charts</h2><div class="tbw"><table class="tb" id="tb"></table></div>
<p class="note">Form leads only, and only leads that have been called. "How fast" is the time from the form being sent to the first call attempt. A lead is reached when someone answered (you answer the popup after tapping Call). A lead counts as booked when it is in Booked, In the shop or Completed, or ever was. Groups with fewer than 5 leads are faded, because a handful of leads can swing the percentages a lot.</p>
</main>
<script type="application/json" id="data">${payload}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent),R=D.rows,TODAY=D.today;
${RANGE_JS}
${CHART_JS}
const BK=[['Under 5 min',-1,300],['5&ndash;30 min',300,1800],['30&ndash;60 min',1800,3600],['1&ndash;2 hr',3600,7200],['2&ndash;4 hr',7200,14400],['4 hr +',14400,Infinity]];
const money=n=>n?'$'+Number(n).toLocaleString('en-US'):'$0',pc=(a,b)=>b?Math.round(100*a/b):null;
function draw(){const L=pick().filter(r=>r.type==='quote'&&r.secs!=null);
 const g=BK.map(b=>{const x=L.filter(r=>r.secs>b[1]&&r.secs<=b[2]);return {l:b[0],n:x.length,rc:x.filter(r=>r.reached).length,bk:x.filter(r=>r.booked).length,val:x.filter(r=>r.booked).reduce((a,r)=>a+(r.value||0),0)}});
 const tot={n:L.length,rc:L.filter(r=>r.reached).length,bk:L.filter(r=>r.booked).length,val:L.filter(r=>r.booked).reduce((a,r)=>a+(r.value||0),0)};
 document.getElementById('k').innerHTML='<div class="kpi g"><b>'+(tot.n?pc(tot.rc,tot.n)+'%':'-')+'</b><span>Contact rate (reached &divide; called)</span></div><div class="kpi"><b>'+tot.rc+' of '+tot.n+'</b><span>Form leads reached</span></div><div class="kpi g"><b>'+(tot.n?pc(tot.bk,tot.n)+'%':'-')+'</b><span>Booked rate (booked &divide; called)</span></div><div class="kpi"><b>'+tot.bk+'</b><span>Booked jobs ('+money(tot.val)+')</span></div>';
 const fast=L.filter(r=>r.secs<=300),slow=L.filter(r=>r.secs>3600),f=a=>({n:a.length,rc:pc(a.filter(r=>r.reached).length,a.length),bk:pc(a.filter(r=>r.booked).length,a.length)});
 const F=f(fast),S=f(slow);
 document.getElementById('ins').innerHTML=(F.n>=3&&S.n>=3)?('Leads called within <b>5 minutes</b> were reached <b>'+F.rc+'%</b> of the time and booked <b>'+F.bk+'%</b> (out of '+F.n+'). Leads called after <b>1 hour</b> were reached <b>'+S.rc+'%</b> and booked <b>'+S.bk+'%</b> (out of '+S.n+').'):'Not enough called leads yet to compare fast and slow calls. This fills in as leads are called and their results are logged.';
 const cl=(v,hi,mid)=>v==null?'mute':v>=hi?'':v>=mid?'mid':'low';
 bars('c1',g.map(x=>{const v=pc(x.rc,x.n);return {l:x.l,v:v==null?0:v,t:v==null?'-':v+'%',s:x.n?x.rc+' of '+x.n:'no leads',c:cl(v,60,35),small:x.n>0&&x.n<5}}));
 bars('c2',g.map(x=>{const v=pc(x.bk,x.n);return {l:x.l,v:v==null?0:v,t:v==null?'-':v+'%',s:x.n?x.bk+' of '+x.n:'no leads',c:cl(v,30,15),small:x.n>0&&x.n<5}}));
 document.getElementById('tb').innerHTML='<tr><th>Called within</th><th>Leads called</th><th>Reached</th><th>Contact rate</th><th>Booked</th><th>Booked rate</th><th>Booked value</th></tr>'+g.concat([{l:'All called leads',n:tot.n,rc:tot.rc,bk:tot.bk,val:tot.val}]).map(x=>'<tr><td>'+x.l+'</td><td>'+x.n+'</td><td>'+x.rc+'</td><td>'+(x.n?pc(x.rc,x.n)+'%':'-')+'</td><td>'+x.bk+'</td><td>'+(x.n?pc(x.bk,x.n)+'%':'-')+'</td><td>'+money(x.val)+'</td></tr>').join('')}
draw();
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// ---- Insights (owner only): funnel, revenue, sources and ad return, services, lost reasons, busiest hours, best time to call
async function insightsPage(env, user) {
  const rows = await speedRows(env);
  const tc = await todayCount(env);
  const spend = Object.fromEntries((await env.DB.prepare("SELECT month, amount FROM ad_spend").all()).results.map(r => [r.month, r.amount]));
  const payload = JSON.stringify({ rows, today: todayStr(), spend }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Insights | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#07090c;color:#e8eaed}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px;flex-wrap:wrap}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}.navtabs a.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
main{max-width:1000px;margin:0 auto;padding:16px 22px 40px;display:flex;flex-direction:column;gap:18px}
${RANGE_CSS}
${CHART_CSS}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.kpi{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:14px}.kpi b{display:block;font-size:24px;line-height:1.15}.kpi span{color:#8a9099;font-size:12.5px}.kpi.g b{color:#32cd32}.kpi.r b{color:#ff8a8a}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:#c3c8cf;margin:10px 0 0}h2 small{text-transform:none;letter-spacing:0;color:#7c838d;font-weight:400;font-size:12.5px;margin-left:6px}.note{color:#7c838d;font-size:12.5px}
.hb{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:10px 14px;display:flex;flex-direction:column;gap:8px}.hb div{display:grid;grid-template-columns:minmax(110px,32%) 1fr 60px;gap:10px;align-items:center;font-size:14px}.hb i{display:block;height:14px;background:#32cd32;border-radius:4px;min-width:2px}.hb i.r{background:#ff8a8a}.hb span:last-child{text-align:right;color:#aab0b9}
.sp{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:12px 14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}.sp label{display:block;color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:3px}.sp input{width:100%;background:#10141a;border:1px solid #232932;color:#fff;border-radius:10px;padding:10px;font:inherit;font-size:16px;min-height:44px}
${BNAV_CSS}
@media(max-width:700px){header{padding:12px 14px}h1{font-size:17px}main{padding:8px 14px 20px}.hb div{grid-template-columns:90px 1fr 48px}}
</style></head><body>
<header><h1>Divine Detailers <b>insights</b></h1>${nav("insights", tc, true)}</header>
${bnav("insights", tc, true)}
<main>
${RANGE_HTML}
<div class="kpis" id="k"></div>
<h2>Lead funnel<small>how many leads make it through each step</small></h2><div class="chart" id="fn"></div>
<h2>Google Ads return<small>uses the monthly ad spend you enter at the bottom</small></h2><div class="kpis" id="ads"></div>
<h2>Where leads come from</h2><div class="tbw"><table class="tb" id="src"></table></div>
<h2>Which services bring the money</h2><div class="tbw"><table class="tb" id="svc"></table></div>
<h2>Why leads are lost<small>the reason picked when a lead moves to Lost</small></h2><div class="hb" id="lost"></div>
<h2>When leads arrive<small>number of leads by hour of day, Eastern time (purple = outside business hours)</small></h2><div class="chart" id="hr"></div>
<h2>Best time to call<small>share of logged calls that were answered, by hour of day (needs at least 3 calls in an hour)</small></h2><div class="chart" id="bt"></div>
<h2>Monthly Google Ads spend<small>type the amount spent each month; it is saved automatically</small></h2><div class="sp" id="sp"></div>
<p class="note">Revenue uses the job value you enter on each lead in the Pipeline, and "booked" means the lead is in Booked, In the shop or Completed (or was). Numbers get more reliable as more leads are logged. Small groups can swing a lot.</p>
</main>
<script type="application/json" id="data">${payload}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent),R=D.rows,TODAY=D.today;let SP=D.spend||{};
${RANGE_JS}
${CHART_JS}
const $=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>'$'+Math.round(n||0).toLocaleString('en-US'),pc=(a,b)=>b?Math.round(100*a/b)+'%':'-',med=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),i=Math.floor(b.length/2);return b.length%2?b[i]:(b[i-1]+b[i])/2};
function spendFor(f,t){let tot=0;for(const m in SP){const y=+m.slice(0,4),mo=+m.slice(5,7),dim=new Date(Date.UTC(y,mo,0)).getUTCDate(),first=m+'-01',last=m+'-'+String(dim).padStart(2,'0'),lo=f&&f>first?f:first,hi=t&&t<last?t:last;if(lo>hi)continue;tot+=SP[m]*(((dt(hi)-dt(lo))/864e5)+1)/dim}return tot}
function tbl(id,head,body){document.getElementById(id).innerHTML='<tr>'+head.map(h=>'<th>'+h+'</th>').join('')+'</tr>'+(body.length?body.map(r=>'<tr>'+r.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join(''):'<tr><td colspan="'+head.length+'" style="text-align:center;color:#7c838d">No leads in this range</td></tr>')}
function hb(id,items,red){const mx=Math.max(1,...items.map(i=>i[1]));document.getElementById(id).innerHTML=items.length?items.map(i=>'<div><span>'+$(i[0])+'</span><span><i class="'+(red?'r':'')+'" style="width:'+Math.max(2,Math.round(100*i[1]/mx))+'%"></i></span><span>'+i[1]+'</span></div>').join(''):'<span style="color:#7c838d">Nothing to show in this range</span>'}
function groupBy(L,fn){const m={};L.forEach(r=>{const k=fn(r);(m[k]=m[k]||[]).push(r)});return Object.entries(m).sort((a,b)=>b[1].length-a[1].length)}
function stats(x){const b=x.filter(r=>r.booked),called=x.filter(r=>r.type==='quote'&&r.secs!=null),rev=b.reduce((a,r)=>a+(r.value||0),0),vals=b.filter(r=>r.value>0);return {n:x.length,b:b.length,rev:rev,avg:vals.length?rev/vals.length:0,calledF:called.length,reachedF:called.filter(r=>r.reached).length}}
function draw(){const L=pick(),S=stats(L),f=bounds()[0],t=bounds()[1];
 const lost=L.filter(r=>r.stage==='lost').length,quoted=L.reduce((a,r)=>a+r.qv,0),days=med(L.filter(r=>r.booked_days!=null).map(r=>r.booked_days));
 document.getElementById('k').innerHTML='<div class="kpi"><b>'+S.n+'</b><span>Leads</span></div><div class="kpi g"><b>'+S.b+'</b><span>Booked jobs ('+pc(S.b,S.n)+' of leads)</span></div><div class="kpi g"><b>'+money(S.rev)+'</b><span>Booked revenue</span></div><div class="kpi"><b>'+(S.avg?money(S.avg):'-')+'</b><span>Average job value</span></div><div class="kpi"><b>'+money(quoted)+'</b><span>Quoted, waiting on a decision</span></div><div class="kpi"><b>'+(days==null?'-':days<1?'Same day':days.toFixed(1)+' days')+'</b><span>Median time from lead to booked</span></div><div class="kpi '+(lost?'r':'')+'"><b>'+lost+'</b><span>Leads lost</span></div>';
 const called=L.filter(r=>r.secs!=null),reached=L.filter(r=>r.reached||(r.type==='call'&&r.how==='Answered live')),done=L.filter(r=>r.stage==='done');
 const fun=[['Leads',L.length],['Called',called.length],['Reached',reached.length],['Booked',S.b],['Completed',done.length]];
 bars('fn',fun.map((x,i)=>({l:x[0],v:x[1],t:x[1],s:i===0?'':pc(x[1],fun[i-1][1])+' of '+fun[i-1][0].toLowerCase(),c:'',small:false})));
 const ads=L.filter(r=>r.ad),as=stats(ads),sp=spendFor(f,t);
 document.getElementById('ads').innerHTML=sp>0&&ads.length?'<div class="kpi"><b>'+money(sp)+'</b><span>Ad spend in this range</span></div><div class="kpi"><b>'+ads.length+'</b><span>Leads from Google Ads</span></div><div class="kpi g"><b>'+money(sp/ads.length)+'</b><span>Cost per lead</span></div><div class="kpi g"><b>'+(as.b?money(sp/as.b):'-')+'</b><span>Cost per booked job</span></div><div class="kpi g"><b>'+(sp?(as.rev/sp).toFixed(1)+'x':'-')+'</b><span>Return on ad spend ('+money(as.rev)+' booked)</span></div>':'<div class="note">Enter your monthly Google Ads spend at the bottom of the page to see cost per lead, cost per booked job and return on ad spend.</div>';
 tbl('src',['Source','Leads','Reached','Booked','Booked rate','Revenue'],groupBy(L,r=>r.srckey).map(([k,x])=>{const a=stats(x);return [$(k),a.n,a.calledF?a.reachedF+' of '+a.calledF:'-',a.b,pc(a.b,a.n),money(a.rev)]}));
 tbl('svc',['Service','Leads','Booked','Booked rate','Revenue','Avg job'],groupBy(L,r=>r.service).map(([k,x])=>{const a=stats(x);return [$(k),a.n,a.b,pc(a.b,a.n),money(a.rev),a.avg?money(a.avg):'-']}));
 hb('lost',groupBy(L.filter(r=>r.stage==='lost'),r=>r.lost).map(([k,x])=>[k,x.length]),true);
 const hrs=Array.from({length:24},(_,h)=>L.filter(r=>r.h===h).length),lab=h=>(h%12||12)+(h<12?'a':'p');
 bars('hr',hrs.map((n,h)=>({l:lab(h),v:n,t:n||'',c:h>=9&&h<18?'':'mute'})));
 const outs=[].concat(...L.map(r=>r.outs||[])),bt=Array.from({length:24},(_,h)=>{const x=outs.filter(o=>o.h===h);return {h:h,n:x.length,a:x.filter(o=>o.ok).length}});
 const btItems=bt.filter(x=>x.n>0).map(x=>({l:lab(x.h),v:x.n>=3?Math.round(100*x.a/x.n):0,t:x.n>=3?Math.round(100*x.a/x.n)+'%':'-',s:x.a+' of '+x.n,c:x.n>=3?'':'mute',small:x.n<5}));
 document.getElementById('bt').innerHTML=btItems.length?'':'<div class="note" style="padding:14px">No call results logged in this range yet. Answer the popup after tapping Call and this fills in.</div>';if(btItems.length)bars('bt',btItems)}
function drawSpend(){const el=document.getElementById('sp'),ms=[];let d=TODAY.slice(0,7);for(let i=0;i<6;i++){ms.push(d);const dd=dt(d+'-01');dd.setUTCMonth(dd.getUTCMonth()-1);d=ds(dd).slice(0,7)}
 el.innerHTML=ms.map(m=>'<div><label>'+dt(m+'-01').toLocaleDateString('en-US',{timeZone:'UTC',month:'long',year:'numeric'})+'</label><input type="number" min="0" step="1" inputmode="numeric" data-m="'+m+'" value="'+(SP[m]||'')+'" placeholder="$0"></div>').join('')}
document.getElementById('sp').addEventListener('change',async e=>{const i=e.target.closest('input[data-m]');if(!i)return;const v=Math.max(0,Number(i.value)||0);SP[i.dataset.m]=v;try{await fetch('/admin/adspend',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({month:i.dataset.m,amount:v})})}catch(_){}draw()});
drawSpend();draw();
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function todayPage(env, user = "") {
  await ensureTable(env.DB);
  const today = todayStr();
  const { results } = await env.DB.prepare("SELECT id,created_at,type,name,email,phone,service,make,year,model,message,utm_source,utm_campaign,gclid,utm_medium,stage,follow_up,follow_up_date,duration,recording,answered FROM leads WHERE type != 'newsletter' AND (stage = 'new' OR (COALESCE(follow_up_date,'') != '' AND follow_up_date <= ? AND stage NOT IN ('done','lost'))) ORDER BY created_at DESC, id DESC LIMIT 300").bind(today).all();
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
<header><h1>Divine Detailers <b>today</b></h1>${nav("today", items.length, user === OWNER)}<span class="dt"><span id="dt"></span> &middot; <a href="/logout" style="color:#8a9099">Sign out</a></span></header>
${bnav("today", items.length, user === OWNER)}
${FOLLOW_HTML}
${OUTCOME_HTML}
<main id="m"></main>
<div class="demo"><span>Showing off the CRM?</span><button class="btn" id="dl">Load example leads</button><button class="btn" id="dc">Remove example leads</button><button class="btn" id="ta">Send test alert</button>${user === OWNER ? '<button class="btn" id="tc">Test CallRail</button><button class="btn" id="vs">Verify shop number</button>' : ""}<pre id="tr" style="flex:1 1 100%;white-space:pre-wrap;color:#c3c8cf;font-size:12.5px;margin:0"></pre></div>
<script type="application/json" id="data">${payload}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent),CFG=D.cfg,TODAY=D.today;let items=D.items;
const $=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
${FOLLOW_JS}
${OUTCOME_JS}
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
  if(a==='call'){markCall(l.id,l.name||l.phone);post('/admin/touch',{id:l.id,label:'Called'});return}
  if(a==='text'){post('/admin/touch',{id:l.id,label:'Texted: '+tplFor(l)[0].label});return}
  if(a==='snooze'){const d=new Date(TODAY+'T12:00:00');d.setDate(d.getDate()+1);const v=d.toISOString().slice(0,10);b.disabled=true;const o=await post('/admin/stage',{id:l.id,follow_date:v});if(o.ok){l.follow_up_date=v;items=items.filter(x=>x.id!==l.id);draw()}else b.disabled=false;return}
  if(a==='done'){b.disabled=true;let st=l.stage;if(st==='new'){const o=await post('/admin/stage',{id:l.id,stage:'contacted'});if(!o.ok){b.disabled=false;return}st='contacted'}
    const nx=await askNext(lab,st);const o2=await post('/admin/stage',{id:l.id,followup:nx?nx.followup:undefined,follow_date:nx?nx.follow_date:''});
    if(o2.ok){const j=await o2.json();l.stage=j.stage;l.follow_up_date=j.follow_up_date;l.follow_up=j.followup;if(!(j.follow_up_date&&j.follow_up_date<=TODAY&&!['done','lost'].includes(j.stage)))items=items.filter(x=>x.id!==l.id);draw()}else b.disabled=false}})
draw();
const vsb=document.getElementById('vs');if(vsb)vsb.onclick=async e=>{e.target.disabled=true;const tr=document.getElementById('tr');tr.textContent='Asking CallRail to verify the shop number...';try{const r=await post('/admin/verifyshop',{});const j=await r.json();tr.textContent=j.success&&j.already?('The shop number '+j.number+' is already verified. Set CALLRAIL_CALLER_ID to it in Cloudflare.'):j.success?('CallRail is calling '+j.number+' now.\\nAnswer that phone and key in this code on the keypad: '+(j.code||'(no code returned: '+j.raw+')')+'\\nIf you miss the call, tap this button again.'):('Could not start the verification: '+(j.message||'unknown error'))}catch(_){tr.textContent='Could not reach the server.'}e.target.disabled=false};
const tcb=document.getElementById('tc');if(tcb)tcb.onclick=async e=>{e.target.disabled=true;const tr=document.getElementById('tr');tr.textContent='Checking CallRail...';try{const r=await post('/admin/callrailtest',{});const j=await r.json();const yn=v=>v?'yes':'NO';const L=['Token set: '+yn(j.token_set)+' | Account ID set: '+yn(j.account_id_set)+' | Caller ID set: '+yn(j.caller_id_set),'Giordani phone set: '+yn(j.agent_giordani)+' | Bronson phone set: '+yn(j.agent_bronson)+' | Recording: '+(j.recording?'on':'off')+' | Auto-dial: '+(j.auto_dial?'on':'off')];
 if(j.accounts_status!==undefined){L.push('CallRail accounts (status '+j.accounts_status+'):');(j.accounts||[]).forEach(a=>L.push('  '+a.id+'  '+a.name));if(j.accounts_error)L.push('  '+j.accounts_error)}
 if(j.trackers_status!==undefined){L.push('Tracking numbers (status '+j.trackers_status+'):');(j.trackers||[]).forEach(t=>L.push('  '+t.name+': '+t.numbers));L.push(j.caller_id_match?'Caller ID matches tracking number: '+j.caller_id_match:(j.caller_id_verified?'Caller ID matches a verified outbound caller ID':'Caller ID is not a tracking number. That is fine only if it is a verified Outbound Caller ID in CallRail.'));if(j.callerids_status!==undefined){L.push('Outbound caller IDs (status '+j.callerids_status+'):');(j.caller_ids||[]).forEach(c=>L.push('  '+(c.name||'')+' '+c.number+(c.verified===false?' (not verified)':'')))}}
 L.push('Last webhooks received from CallRail (newest first):');(j.hooks||[]).forEach(h=>L.push('  '+h.at+'  '+h.summary));if(!(j.hooks||[]).length)L.push('  none yet');
 tr.textContent=L.join('\\n')}catch(_){tr.textContent='Could not reach the server.'}e.target.disabled=false};
document.getElementById('ta').onclick=async e=>{e.target.disabled=true;const tr=document.getElementById('tr');tr.textContent='Sending...';try{const r=await post('/admin/testalert',{});if(r.status===404){tr.textContent='This version of the site does not have alerts yet. Re-run the latest build in Cloudflare.'}else{const j=await r.json();tr.textContent=(j.push_topic_set?'Push topic is set: '+j.topic_hint+(j.has_slash_or_space?'\\nWARNING: the topic contains a space, a slash or a colon. It must be the name only.':'')+'\\nntfy answered: '+j.push_status+' '+j.push_response+(j.push_status===200?'\\nSent. Check the phone now.':'')+(j.push_status===429?'\\nThe free shared quota is used up. Add an ntfy account token as NTFY_TOKEN.':'')+(j.push_token_set?'\\nAccount token: set':'\\nAccount token: not set')+(j.topic_too_short?'\\nWARNING: the topic is short and easy to guess. Use 20+ random characters.':''):'NTFY_TOPIC is NOT set on the live site. Add it as a variable or secret and deploy.')+'\\nEmail alerts: '+(j.email?'on':'off')+' | Text alerts: '+(j.sms?'on':'off')+' | Zapier: '+(j.zapier_webhook?'on':'off')}}catch(_){tr.textContent='Could not reach the server.'}e.target.disabled=false};
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
  if (p === "/admin") return adminPage(env, a);
  if (p === "/admin/leads.csv") return csv(env);
  if (p === "/admin/pipeline") return pipelinePage(env, a);
  if (p === "/admin/add" && request.method === "POST") return addLead(request, env);
  if (p === "/admin/today") return todayPage(env, a);
  if (p.startsWith("/admin/go/")) { const gid = Number(p.slice(10)); return Number.isInteger(gid) && gid > 0 ? goPage(env, gid, a) : new Response("Not found", { status: 404 }); }
  if (p === "/admin/speed") return a === OWNER ? speedPage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/insights") return a === OWNER ? insightsPage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/adspend" && request.method === "POST") {
    if (a !== OWNER) return json({ success: false }, 403);
    const b = await request.json().catch(() => ({}));
    if (typeof b.month !== "string" || !/^\d{4}-\d{2}$/.test(b.month) || !Number.isFinite(b.amount) || b.amount < 0 || b.amount > 10000000) return json({ success: false }, 400);
    await env.DB.prepare("INSERT INTO ad_spend (month, amount) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET amount = excluded.amount").bind(b.month, b.amount).run();
    return json({ success: true });
  }
  if (p === "/admin/rate") return a === OWNER ? ratePage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/demo" && request.method === "POST") return demoRoute(request, env);
  if (p === "/admin/testalert" && request.method === "POST") return testAlert(request, env);
  const user = typeof a === "string" ? a : "";
  if (p === "/admin/verifyshop" && request.method === "POST") { if (a !== OWNER) return json({ success: false }, 403); const res = await verifyShopNumber(env, await request.json().catch(() => ({}))); return json({ success: res.ok, ...res }); }
  if (p === "/admin/callrailtest" && request.method === "POST") return a === OWNER ? json({ success: true, ...(await callrailTest(env)) }) : json({ success: false }, 403);
  if (p === "/admin/outcome" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const ok = OUTCOMES.find(o => o[0] === b.outcome);
    if (!Number.isInteger(b.id) || !ok) return json({ success: false }, 400);
    const cur = await env.DB.prepare("SELECT stage FROM leads WHERE id = ?").bind(b.id).first();
    if (!cur) return json({ success: false }, 404);
    await env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?,?,?,?,?)").bind(b.id, cur.stage, cur.stage, "Call result: " + b.outcome, user).run();
    return json({ success: true });
  }
  if (p === "/admin/touch" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!Number.isInteger(b.id) || typeof b.label !== "string") return json({ success: false }, 400);
    const cur = await env.DB.prepare("SELECT stage, follow_up_date FROM leads WHERE id = ?").bind(b.id).first();
    if (!cur) return json({ success: false }, 404);
    // a first text or email counts as contacting them
    const stage = cur.stage === "new" ? "contacted" : cur.stage;
    const stmts = [
      env.DB.prepare("UPDATE leads SET stage = ?, contacted = 1" + (stage !== cur.stage ? ", stage_changed_at = datetime('now')" : "") + " WHERE id = ?").bind(stage, b.id),
      env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?,?,?,?,?)").bind(b.id, cur.stage, stage, clean(b.label, 120), user),
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
    for (const [f, t, r] of logs) stmts.push(env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?,?,?,?,?)").bind(b.id, f, t, r, user));
    await env.DB.batch(stmts);
    const abs = when(new Date().toISOString().slice(0, 19).replace("T", " ")).abs;
    return json({ success: true, stage, followup: follow, follow_up_date: date, log: logs.map(([f, t, r]) => ({ from_stage: f, to_stage: t, reason: r, at: abs })).reverse() });
  }
  return new Response("Not found", { status: 404 });
}
