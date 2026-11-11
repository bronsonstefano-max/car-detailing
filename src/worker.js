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
//   LEAD_WEBHOOK_URL  (secret, optional)       POST each new lead and each new call ("NEW LEAD: Incoming call") as JSON, with a ready-made `text` line (Zapier, Make, Slack...)
//   CALL_WEBHOOK_URL  (secret, optional)       same as LEAD_WEBHOOK_URL but only for calls (its own Zap); calls use LEAD_WEBHOOK_URL when this is not set
//   BOOKED_WEBHOOK_URL (secret, optional)     POST a lead as JSON when it is moved to Booked or its appointment changes (Zapier -> Urable calendar). "event" is booked | rescheduled
//   URABLE_API_KEY    (secret, optional)       Urable API key (scopes: customers, items, products read, jobs, events). Moving a lead to Booked then creates the customer, vehicle and job on the Urable calendar
//   URABLE_JOB_HOURS  (var, optional)          default length of a booking in hours when none is known (default: tint 3, coating/PPF/correction 8, other 4)
//   TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM (secrets)  Twilio texting: the Messages tab sends and receives texts. TWILIO_MESSAGING_SERVICE (optional) sends through a Messaging Service instead of one number
//   TEXT_AUTO         (var, optional, "1")      send the follow-up texts (#1 right away, #2 after 2 hours...) automatically instead of a push for each one; stops when the lead replies
//   META_SMS_CONSENT / META_SMS_MARKETING (var, "1") the Facebook lead form's consent covers texts / promotional texts: new Meta leads are marked as agreed (marketing also marks texts)
//   TEXT_HOURS        (var, optional "8-21")   hours (Eastern) when texts may go out
//   TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID (secrets)  in-browser dialing on the Dial page (Twilio Voice SDK); the TwiML App's Voice URL is https://divinedetailers.com/api/twilio/voice. TWILIO_VOICE_FROM (optional) is the caller ID for calls (defaults to TWILIO_FROM)
//   DEEPGRAM_API_KEY  (secret)                 live transcript of dialer calls (Twilio Media Streams -> a Durable Object -> Deepgram). DEEPGRAM_LANGUAGE (optional, default "en"; "multi" also hears Spanish but is less accurate in English) sets the language
//   CALL_HEADSUP      (optional, "0" turns off)  push notification as a call rings the agent: "Calling Tony" and "Window Tint · 2026 Hyundai Sonata"
//   CRM_HOST          (var, optional)          e.g. crm.divinedetailers.com: dashboard moves there (at "/"); /admin on other hosts redirects to it

// default job values (tint $349, ceramic coating $599) so the pipeline total means something before a price is quoted
const CERAMIC_TINT_VALUE = 349;
const CERAMIC_COATING_VALUE = 599;
const defaultValue = service => (/tint/i.test(service || "") ? CERAMIC_TINT_VALUE : /coating/i.test(service || "") ? CERAMIC_COATING_VALUE : 0);
const FIELDS = ["name", "email", "phone", "service", "also_interested", "make", "year", "model", "message"];
const MAX = { default: 300, message: 4000 };

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STAGES = [["new", "New lead"], ["nocontact", "Not contacted"], ["contacted", "Contacted"], ["quoted", "Quote sent"], ["aged", "7 day +"], ["interested", "Interested (call back)"], ["deposit", "Deposit pending (follow up)"], ["booked", "Deposit collected"], ["working", "In shop"], ["done", "Service completed"], ["lost", "NO"]];
const STAGE_KEYS = STAGES.map(x => x[0]);
const isNewish = st => st === "new" || st === "nocontact"; // still needs its first real conversation
// What can happen next at each stage: [label, stage it moves the lead to (or null to stay)]
const FOLLOWUPS = {
  new: [["Called, no answer", null], ["Left a voicemail", null], ["Sent a text", null], ["Spoke to the customer", "contacted"], ["Wrong number or spam", "lost"]],
  nocontact: [["Called, no answer", null], ["Left a voicemail", null], ["Sent a text", null], ["Spoke to the customer", "contacted"], ["Wrong number or spam", "lost"]],
  contacted: [["Needs a quote", null], ["Waiting on the customer", null], ["Quote sent", "quoted"], ["Not interested", "lost"], ["No response", "lost"]],
  quoted: [["Invoice sent", null], ["Waiting on a decision", null], ["Sent a reminder", null], ["Accepted, deposit paid", "booked"], ["Too expensive", "lost"], ["Not interested", "lost"], ["Went with another shop", "lost"], ["No response", "lost"]],
  booked: [["Drop-off confirmed", null], ["Rescheduled", null], ["Car dropped off", "working"], ["Cancelled", "lost"]],
  working: [["Work in progress", null], ["Waiting on film or parts", null], ["Customer update sent", null], ["Work finished, ready for pickup", "done"]],
  done: [["Paid in full", null], ["Asked for a review", null], ["Review received", null], ["Wants more work", "contacted"]],
  aged: [["Called, no answer", null], ["Left a voicemail", null], ["Sent a text", null], ["Spoke to the customer", "contacted"], ["Wrong number or spam", "lost"]],
  interested: [["Called, no answer", null], ["Left a voicemail", null], ["Sent a text", null], ["Call back booked", null], ["Sent a quote", "quoted"], ["Deposit link sent", "deposit"], ["Not interested", "lost"]],
  deposit: [["Sent a reminder", null], ["Called about the deposit", null], ["Waiting on the customer", null], ["Deposit paid", "booked"], ["Backed out", "lost"]],
  lost: [["Follow up later", null], ["Customer came back", "contacted"]],
};

// the table setup and upgrades are dozens of database round trips: do them once per worker instance, not on every page and every poll
let schemaReady = null;
function ensureTable(db) {
  if (!schemaReady) schemaReady = ensureTableRun(db).catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}
async function ensureTableRun(db) {
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
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS ad_spend2 (month TEXT NOT NULL, channel TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, PRIMARY KEY (month, channel))"),
    db.prepare("CREATE TABLE IF NOT EXISTS job_costs (service TEXT PRIMARY KEY, cost REAL NOT NULL DEFAULT 0)"),
  ]);
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
  if (!cols.includes("tags")) await db.prepare("ALTER TABLE leads ADD COLUMN tags TEXT NOT NULL DEFAULT ''").run();
  if (!cols.includes("starred")) await db.prepare("ALTER TABLE leads ADD COLUMN starred INTEGER NOT NULL DEFAULT 0").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS call_notes (call_id TEXT PRIMARY KEY, lead_id INTEGER, direction TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), summary TEXT, transcript TEXT, keys TEXT, tries INTEGER NOT NULL DEFAULT 0, next_try TEXT, done INTEGER NOT NULL DEFAULT 0)").run();
  const dcols = (await db.prepare("PRAGMA table_info(dial_log)").all()).results.map(c => c.name);
  if (dcols.length && !dcols.includes("attempt")) await db.batch([db.prepare("ALTER TABLE dial_log ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1"), db.prepare("ALTER TABLE dial_log ADD COLUMN retried INTEGER NOT NULL DEFAULT 0")]);
  if (dcols.length && !dcols.includes("result")) await db.prepare("ALTER TABLE dial_log ADD COLUMN result TEXT").run();
  if (dcols.length && !dcols.includes("flagged")) await db.prepare("ALTER TABLE dial_log ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0").run();
  if (!cols.includes("sms_marketing")) await db.prepare("ALTER TABLE leads ADD COLUMN sms_marketing INTEGER NOT NULL DEFAULT 0").run();
  if (!cols.includes("sms_consent")) await db.prepare("ALTER TABLE leads ADD COLUMN sms_consent INTEGER NOT NULL DEFAULT 0").run();
  if (!cols.includes("urable_ref")) await db.batch([db.prepare("ALTER TABLE leads ADD COLUMN urable_ref TEXT"), db.prepare("ALTER TABLE leads ADD COLUMN urable_kind TEXT")]);
  if (!cols.includes("gbraid")) await db.batch([db.prepare("ALTER TABLE leads ADD COLUMN gbraid TEXT"), db.prepare("ALTER TABLE leads ADD COLUMN wbraid TEXT")]);
  if (!cols.includes("reminded_at")) await db.prepare("ALTER TABLE leads ADD COLUMN reminded_at TEXT").run();
  if (!cols.includes("follow_up")) {
    await db.batch([
      db.prepare("ALTER TABLE leads ADD COLUMN follow_up TEXT"),
      db.prepare("ALTER TABLE leads ADD COLUMN follow_up_date TEXT"),
    ]);
  }
  if (!cols.includes("appt_at")) await db.batch([db.prepare("ALTER TABLE leads ADD COLUMN appt_at TEXT"), db.prepare("ALTER TABLE leads ADD COLUMN appt_remind_at TEXT"), db.prepare("ALTER TABLE leads ADD COLUMN appt_reminded INTEGER NOT NULL DEFAULT 0")]);
  if (!cols.includes("call_id")) {
    await db.batch([
      db.prepare("ALTER TABLE leads ADD COLUMN call_id TEXT"),
      db.prepare("ALTER TABLE leads ADD COLUMN duration INTEGER"),
      db.prepare("ALTER TABLE leads ADD COLUMN recording TEXT"),
      db.prepare("ALTER TABLE leads ADD COLUMN answered INTEGER"),
      db.prepare("ALTER TABLE leads ADD COLUMN tracking_number TEXT"),
    ]);
  }
  // one time: tint leads that are still open and have no value yet start at the default job value
  await db.prepare("CREATE TABLE IF NOT EXISTS app_flags (k TEXT PRIMARY KEY)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS text_reminders (lead_id INTEGER, n INTEGER, at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (lead_id, n))").run();
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user TEXT, p256dh TEXT, auth TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))"),
    db.prepare("CREATE TABLE IF NOT EXISTS push_keys (k TEXT PRIMARY KEY, v TEXT)"),
  ]);
  await db.prepare("CREATE TABLE IF NOT EXISTS call_recordings (call_id TEXT PRIMARY KEY, lead_id INTEGER, direction TEXT, url TEXT NOT NULL DEFAULT '', duration INTEGER, at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, phone TEXT, direction TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT, sid TEXT, by_user TEXT, auto INTEGER NOT NULL DEFAULT 0, is_read INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL DEFAULT (datetime('now')))"),
    db.prepare("CREATE INDEX IF NOT EXISTS messages_lead ON messages (lead_id, id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS messages_sid ON messages (sid)"),
    db.prepare("CREATE TABLE IF NOT EXISTS sms_optout (phone TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')))"),
    db.prepare("CREATE TABLE IF NOT EXISTS automations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'sequence', active INTEGER NOT NULL DEFAULT 0, rules TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS automation_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, automation_id INTEGER NOT NULL, pos INTEGER NOT NULL DEFAULT 0, after_min INTEGER NOT NULL DEFAULT 0, gap_min INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL DEFAULT '')"),
    db.prepare("CREATE TABLE IF NOT EXISTS automation_runs (automation_id INTEGER NOT NULL, lead_id INTEGER NOT NULL, step_id INTEGER NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')), status TEXT, body TEXT, PRIMARY KEY (automation_id, lead_id, step_id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS automation_steps_a ON automation_steps (automation_id, pos)"),
    db.prepare("CREATE TABLE IF NOT EXISTS campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', audience TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft', send_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS campaign_sends (campaign_id INTEGER NOT NULL, lead_id INTEGER NOT NULL, status TEXT, at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (campaign_id, lead_id))"),
    db.prepare("CREATE TABLE IF NOT EXISTS dial_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, call_sid TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now')), duration INTEGER NOT NULL DEFAULT 0, by_user TEXT)"),
    db.prepare("CREATE INDEX IF NOT EXISTS dial_calls_lead ON dial_calls (lead_id, started_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS dial_audio (kind TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL, token TEXT NOT NULL, updated_at TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS dial_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '')"),
    db.prepare("CREATE TABLE IF NOT EXISTS practice_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (datetime('now')), svc TEXT, level TEXT, kind TEXT, overall REAL, outcome TEXT, score TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS call_library (id INTEGER PRIMARY KEY AUTOINCREMENT, src TEXT, svc TEXT, topic TEXT, objection TEXT, kind TEXT, stage TEXT, lead_said TEXT NOT NULL, rep_response TEXT NOT NULL, better TEXT, quality REAL, priority REAL, won INTEGER, reaction TEXT)"),
    db.prepare("CREATE INDEX IF NOT EXISTS call_library_svc ON call_library (svc, priority)"),
    db.prepare("CREATE TABLE IF NOT EXISTS call_transcripts (call_sid TEXT PRIMARY KEY, lead_id INTEGER, turns TEXT, signals TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS coach_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (datetime('now')), call_sid TEXT, build TEXT, gen INTEGER, said TEXT, trig TEXT, outcome TEXT, why TEXT, restarts INTEGER, wait_ms INTEGER, dg_lag_ms INTEGER, ctx_ms INTEGER, first_ms INTEGER, say_ms INTEGER, total_ms INTEGER, shown_ms INTEGER, rep_spoke INTEGER, http INTEGER, stop TEXT, in_tok INTEGER, cache_read INTEGER, cache_write INTEGER, out_tok INTEGER, raw TEXT)"),
    db.prepare("CREATE INDEX IF NOT EXISTS coach_turns_sid ON coach_turns (call_sid, id)"),
  ]);
  const flagAuto = await db.prepare("INSERT OR IGNORE INTO app_flags (k) VALUES ('automations_v1')").run();
  if (flagAuto.meta && flagAuto.meta.changes) await seedAutomations(db);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS queue_run (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, active INTEGER NOT NULL DEFAULT 1, started_at TEXT NOT NULL DEFAULT (datetime('now')), next_at TEXT, ended_at TEXT, note TEXT, misses INTEGER NOT NULL DEFAULT 0)"),
    db.prepare("CREATE TABLE IF NOT EXISTS queue_items (run_id INTEGER, lead_id INTEGER, pos INTEGER, status TEXT NOT NULL DEFAULT 'waiting', call_id TEXT, PRIMARY KEY (run_id, lead_id))"),
  ]);
  const flag = await db.prepare("INSERT OR IGNORE INTO app_flags (k) VALUES ('tint_value_349')").run();
  if (flag.meta && flag.meta.changes) await db.prepare("UPDATE leads SET value = ? WHERE value = 0 AND service LIKE '%tint%' AND type != 'newsletter' AND COALESCE(ip,'') != 'demo' AND stage IN ('new','nocontact','contacted','quoted')").bind(CERAMIC_TINT_VALUE).run();
  // one time: leads that were moved to Contacted just because Call was tapped, and whose calls were never answered, go back to Not contacted
  const flag3 = await db.prepare("INSERT OR IGNORE INTO app_flags (k) VALUES ('called_not_contacted_fix')").run();
  if (flag3.meta && flag3.meta.changes) {
    const pred = `stage = 'contacted' AND id IN (SELECT lead_id FROM stage_log WHERE reason IN ('Call result: No answer','Call result: Left a voicemail'))
      AND id NOT IN (SELECT lead_id FROM stage_log WHERE reason IN ('Call result: Answered') OR reason LIKE 'Texted%' OR reason LIKE 'Emailed%' OR reason LIKE 'Spoke%' OR (to_stage = 'contacted' AND reason NOT LIKE 'Called%' AND reason NOT LIKE 'Call result%' AND reason NOT LIKE 'Left a voicemail%'))`;
    await db.batch([
      db.prepare(`INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) SELECT id, 'contacted', 'nocontact', 'Moved back to Not contacted: the call was not answered', 'system' FROM leads WHERE ${pred}`),
      db.prepare(`UPDATE leads SET stage = 'nocontact', contacted = 0, stage_changed_at = datetime('now') WHERE ${pred}`),
    ]);
  }
  // one time: the recording each lead already has becomes the first entry in its recordings list
  const flag4 = await db.prepare("INSERT OR IGNORE INTO app_flags (k) VALUES ('recordings_list')").run();
  if (flag4.meta && flag4.meta.changes) await db.prepare("INSERT OR IGNORE INTO call_recordings (call_id, lead_id, direction, url, duration, at) SELECT COALESCE(NULLIF(l.call_id,''), (SELECT d.call_id FROM dial_log d WHERE d.lead_id = l.id ORDER BY d.created_at DESC LIMIT 1), 'lead-' || l.id), l.id, CASE WHEN l.type = 'call' THEN 'inbound' ELSE 'outbound' END, l.recording, l.duration, l.created_at FROM leads l WHERE COALESCE(l.recording,'') != ''").run();
  // one time: the monthly ad spend entered so far was Google Ads spend
  const flag5 = await db.prepare("INSERT OR IGNORE INTO app_flags (k) VALUES ('ad_spend_by_channel')").run();
  if (flag5.meta && flag5.meta.changes) await db.prepare("INSERT OR IGNORE INTO ad_spend2 (month, channel, amount) SELECT month, 'google', amount FROM ad_spend").run();
  const flagCar = await db.prepare("INSERT OR IGNORE INTO app_flags (k) VALUES ('split_car_v1')").run();
  if (flagCar.meta && flagCar.meta.changes) {
    const rows = (await db.prepare("SELECT id, model FROM leads WHERE COALESCE(make,'') = '' AND COALESCE(year,'') = '' AND COALESCE(model,'') != '' AND type != 'newsletter' AND COALESCE(ip,'') != 'demo' LIMIT 3000").all()).results || [];
    const ups = [];
    for (const r of rows) { const sp = splitCar(r.model); if (sp.make || sp.year) ups.push(db.prepare("UPDATE leads SET year = ?, make = ?, model = ? WHERE id = ?").bind(sp.year, sp.make, sp.model, r.id)); }
    for (let i = 0; i < ups.length; i += 50) await db.batch(ups.slice(i, i + 50));
  }
  const flag2 = await db.prepare("INSERT OR IGNORE INTO app_flags (k) VALUES ('coating_value_599')").run();
  if (flag2.meta && flag2.meta.changes) await db.prepare("UPDATE leads SET value = ? WHERE value = 0 AND service LIKE '%coating%' AND type != 'newsletter' AND COALESCE(ip,'') != 'demo' AND stage IN ('new','nocontact','contacted','quoted')").bind(CERAMIC_COATING_VALUE).run();
  // lookups by lead and by date stay fast as the history grows (only adds indexes: nothing is changed or removed)
  await db.batch([
    db.prepare("CREATE INDEX IF NOT EXISTS idx_stage_log_lead ON stage_log(lead_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_dial_log_lead ON dial_log(lead_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_call_notes_lead ON call_notes(lead_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_call_recordings_lead ON call_recordings(lead_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_leads_call_id ON leads(call_id)"),
  ]);
  await db.prepare("ALTER TABLE dial_calls ADD COLUMN from_num TEXT").run().catch(() => {});
  await db.prepare("ALTER TABLE leads ADD COLUMN lost_reason TEXT").run().catch(() => {});
  await db.prepare("ALTER TABLE dial_calls ADD COLUMN tw_status TEXT").run().catch(() => {});
  await db.prepare("ALTER TABLE dial_calls ADD COLUMN talk INTEGER").run().catch(() => {});
  await db.prepare("ALTER TABLE dial_calls ADD COLUMN src TEXT").run().catch(() => {});
  await db.prepare("ALTER TABLE dial_calls ADD COLUMN logged INTEGER").run().catch(() => {});
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS dial_calls_sid ON dial_calls(call_sid) WHERE call_sid IS NOT NULL AND call_sid <> ''").run().catch(() => {});
  await db.prepare("ALTER TABLE messages ADD COLUMN from_num TEXT").run().catch(() => {});
  await db.prepare("ALTER TABLE messages ADD COLUMN err TEXT").run().catch(() => {});
  await db.prepare("CREATE TABLE IF NOT EXISTS number_health (num TEXT PRIMARY KEY, level INTEGER NOT NULL DEFAULT 0, at TEXT)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS user_perms (username TEXT PRIMARY KEY, perms TEXT NOT NULL DEFAULT '[]')").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS snippets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  await db.prepare("ALTER TABLE leads ADD COLUMN unread_flag INTEGER NOT NULL DEFAULT 0").run().catch(() => {});
}

const clean = (v, n = MAX.default) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, n) : "");


// ---------------------------------------------------------------- CallRail (post-call webhook)
// In CallRail: Settings > Integrations > Webhooks > Pre-Call (the lead appears the moment the phone rings) and Post-Call (adds the result and recording), both with the URL https://<site>/api/callrail?key=<CALLRAIL_KEY>
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
async function placeCall(env, lead, user, source, attempt = 1) {
  if (!dialOn(env)) return { ok: false, message: "Calling through CallRail is not set up yet." };
  const agent = agentPhone(env, user), customer = e164(lead.phone);
  if (!agent) return { ok: false, message: `No cell number is saved for ${user}. Add AGENT_PHONE_${String(user).toUpperCase()} in Cloudflare.` };
  if (digitsOf(customer).length < 11) return { ok: false, message: "This lead has no valid phone number." };
  const body = { caller_id: e164(env.CALLRAIL_CALLER_ID), business_phone_number: agent, customer_phone_number: customer, recording_enabled: env.CALL_RECORDING !== "0" };
  // CALL_GREETING=off records without any announcement (the owner's choice; check the recording-consent law for the states the calls reach)
  const noGreeting = /^(off|none|no)$/i.test(String(env.CALL_GREETING || "").trim());
  if (body.recording_enabled && !noGreeting) body.outbound_greeting_text = env.CALL_GREETING || "This call may be recorded for quality and training purposes.";
  let r, j;
  try {
    r = await fetch(`${env.CALLRAIL_API_BASE || "https://api.callrail.com"}/v3/a/${env.CALLRAIL_ACCOUNT_ID}/calls.json`, { method: "POST", headers: { authorization: `Token token=${env.CALLRAIL_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    j = await r.json().catch(() => ({}));
  } catch (e) { return { ok: false, message: "Could not reach CallRail." }; }
  if (!r.ok || !j.id) return { ok: false, message: `CallRail refused the call (status ${r.status})` + (Object.keys(j).length ? ": " + JSON.stringify(j).slice(0, 220) : ".") };
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO dial_log (call_id, lead_id, by_user, source, attempt) VALUES (?,?,?,?,?)").bind(j.id, lead.id, user, source, attempt),
    env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) SELECT id, stage, stage, ?, ? FROM leads WHERE id = ?").bind(attempt > 1 ? "Auto-dial: ringing the agent a second time (first ring not answered)" : source === "auto" ? "Auto-dial requested (calling your phone first)" : source === "queue" ? "Call queue: calling your phone first" : "Dial requested (calling your phone first)", user, lead.id),
  ]);
  // heads-up on the agent's phone as the call rings: "Calling Tony" / "Window Tint · 2026 Hyundai Sonata" (CALL_HEADSUP=0 turns it off).
  // CallRail does not play custom text on the agent's leg, so this is a push notification instead.
  if (env.CALL_HEADSUP !== "0") {
    const ld = await env.DB.prepare("SELECT name, service, year, make, model FROM leads WHERE id = ?").bind(lead.id).first().catch(() => null);
    if (ld) {
      const car = [ld.year, ld.make, ld.model].filter(Boolean).join(" ");
      const line = [String(ld.name || "").trim() || prettyPhone(lead.phone), ld.service, car].filter(Boolean).join(", ");
      await sendPush(env, { title: "Calling Lead", message: line, users: [user], click: env.CRM_HOST ? `https://${env.CRM_HOST}/pipeline#id=${lead.id}` : undefined }).catch(() => {});
    }
  }
  return { ok: true, id: j.id };
}
// Was the lead dialed (the agent picked up and pressed 1)? This follows CallRail's own report: answered, voicemail, talk or recording time.
// CallRail's duration also counts the agent's ring time (about 24 seconds when nobody answers), so a bare duration is not proof: it only counts once it reaches DIAL_CONNECT_SECS (default 40).
function callConnected(env, c) {
  const limit = Number(env.DIAL_CONNECT_SECS) > 0 ? Number(env.DIAL_CONNECT_SECS) : 40;
  return bool(c.answered) === 1 || bool(c.voicemail) === 1 || (num(c.talk_time) || 0) > 0 || (num(c.recording_duration) || 0) > 0 || (num(c.duration) || 0) >= limit;
}
const contactMinSecs = env => Number(env.CONTACT_MIN_SECS) || 45;
// an answered inbound call longer than that also counts as contact
async function inboundContact(env, leadId, row) {
  if (row.answered !== 1 || /voicemail/i.test(row.message || "") || !((row.duration || 0) > contactMinSecs(env))) return;
  const cur = await env.DB.prepare("SELECT stage FROM leads WHERE id = ?").bind(leadId).first();
  if (!cur || !isNewish(cur.stage)) return;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?,?,?,?,?)").bind(leadId, cur.stage, "contacted", `Call longer than ${contactMinSecs(env)} seconds (${Math.floor(row.duration / 60)}:${String(row.duration % 60).padStart(2, "0")})`, "system"),
    env.DB.prepare("UPDATE leads SET stage = 'contacted', contacted = 1, stage_changed_at = datetime('now') WHERE id = ?").bind(leadId),
  ]);
}
// every recording is kept in a list per lead (the lead's own `recording` field only holds the latest one)
async function saveRecording(env, { callId, leadId, direction, url, duration, at }) {
  if (!callId || !leadId || !url) return;
  await env.DB.prepare("INSERT INTO call_recordings (call_id, lead_id, direction, url, duration, at) VALUES (?,?,?,?,?, COALESCE(?, datetime('now'))) ON CONFLICT(call_id) DO UPDATE SET url = excluded.url, duration = COALESCE(excluded.duration, call_recordings.duration), lead_id = excluded.lead_id")
    .bind(callId, leadId, direction, url, duration == null ? null : Number(duration), at || null).run().catch(() => {});
}
// CallRail posts finished outbound calls here (Outbound Post-Call and Call Modified webhooks): log the call, its result and recording on the lead
async function handleOutbound(env, c, ctx) {
  const callId = clean(String(c.id || c.call_id || c.resource_id || ""), 80);
  if (!callId) return json({ success: false, message: "No call id" }, 422);
  const dl = await env.DB.prepare("SELECT lead_id, by_user, done, attempt, retried, source, (julianday('now') - julianday(created_at)) * 86400 AS age FROM dial_log WHERE call_id = ?").bind(callId).first();
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
  if (rec) { await env.DB.prepare("UPDATE leads SET recording = ? WHERE id = ?").bind(rec, leadId).run(); await saveRecording(env, { callId, leadId, direction: "outbound", url: rec, duration: num(c.duration), at: c.start_time ? sqlTime(c.start_time) : null }); }
  const already = dl ? dl.done : (await env.DB.prepare("SELECT done FROM dial_log WHERE call_id = ?").bind(callId).first() || {}).done;
  if (already) return json({ success: true, updated: true });
  const answered = bool(c.answered) === 1, vm = bool(c.voicemail) === 1, dur = num(c.duration) || 0;
  // the lead was dialed when the agent pressed 1: CallRail then reports an answer, a voicemail or some talk time
  const dialed = callConnected(env, c);
  const at = sqlTime(c.start_time) || new Date().toISOString().slice(0, 19).replace("T", " ");
  const cur = await env.DB.prepare("SELECT stage FROM leads WHERE id = ?").bind(leadId).first();
  if (!cur) return json({ success: true, ignored: true });
  const leadAnswered = answered && !vm;
  // a call does not move the lead by itself, except a connected call longer than CONTACT_MIN_SECS (45 seconds): that is a real conversation.
  // Otherwise the agent decides (moves it by hand, or answers "Did they answer?" with Answered).
  const target = isNewish(cur.stage) && dialed && !vm && dur > contactMinSecs(env) ? "contacted" : cur.stage;
  const row = (reason, when) => env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, at, by_user) VALUES (?,?,?,?,?,?)").bind(leadId, cur.stage, cur.stage, reason, when, by);
  const willRetry = !dialed && !!dl && dl.source === "auto" && dl.attempt === 1 && !dl.retried && dialOn(env) && env.AUTO_DIAL === "1" && env.AUTO_DIAL_RETRY !== "0" && isNewish(cur.stage);
  // a first ring that "failed" within a minute is not acted on yet: the per-minute check decides once the call has had time to ring out (about 100 seconds), so the agent is never rung twice in quick succession
  if (!dialed && dl && dl.source === "auto" && dl.attempt === 1 && !dl.retried && dl.age < 60) return json({ success: true, deferred: true });
  const stmts = [env.DB.prepare("UPDATE dial_log SET done = 1, result = ? WHERE call_id = ?").bind(!dialed ? "notconnected" : vm ? "voicemail" : leadAnswered ? "answered" : "noanswer", callId)];
  if (dialed) {
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO call_notes (call_id, lead_id, direction, next_try) VALUES (?,?,?, datetime('now','+3 minutes'))").bind(callId, leadId, "outbound"));
    stmts.push(row("Called via CallRail" + (dur ? ` (${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")})` : ""), at));
    stmts.push(row("Call result: CallRail reported " + (vm ? "voicemail" : answered ? "answered" : "no answer"), at));
    if (target !== cur.stage) {
      stmts.push(env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, at, by_user) VALUES (?,?,?,?,?,?)").bind(leadId, cur.stage, target, `Call longer than ${contactMinSecs(env)} seconds (${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")})`, at, "system"));
      stmts.push(env.DB.prepare("UPDATE leads SET stage = ?, contacted = 1, stage_changed_at = datetime('now') WHERE id = ?").bind(target, leadId));
    }
  } else if ((dl && dl.retried) || willRetry) stmts.push(row("Auto-dial: first ring not answered, ringing the agent again", at));
  else stmts.push(row((dl && dl.source === "auto" ? "Agent missed the auto-dial" : "Call not connected") + " (did not answer or did not press 1, so the lead was not called)" + (dl && dl.attempt > 1 ? " after two rings" : ""), at));
  await env.DB.batch(stmts);
  if (dl && dl.source === "queue") await queueAfterCall(env, callId, dialed, ctx).catch(() => {});
  if (willRetry && await retryAuto(env, callId, leadId, dl.by_user).catch(() => false)) return json({ success: true, logged: true, retry: true });
  if (!dialed && dl && !dl.retried && (await env.DB.prepare("SELECT source FROM dial_log WHERE call_id = ?").bind(callId).first() || {}).source === "auto") {
    const ld = await env.DB.prepare("SELECT name, phone FROM leads WHERE id = ?").bind(leadId).first() || {};
    const link = env.CRM_HOST ? `https://${env.CRM_HOST}/today` : "";
    const text = `AUTO-DIAL NOT ANSWERED: nobody pressed 1, so ${ld.name || ld.phone || "the new lead"} (${prettyPhone(ld.phone)}) was not called. Call them now. ${link}`.trim();
    await alertTeam(env, { subject: "Auto-dial not answered: call the lead", text, html: `<p><b>${esc(text.replace(link, "").trim())}</b></p>${link ? `<p><a href="${esc(link)}">Open today's list</a></p>` : ""}`, push: { title: "Auto-dial not answered", message: `${ld.name || ld.phone || "New lead"}: call them now`, click: link || undefined } }).catch(() => {});
  }
  return json({ success: true, logged: true });
}

async function retryAuto(env, callId, leadId, user) {
  const claim = await env.DB.prepare("UPDATE dial_log SET retried = 1 WHERE call_id = ? AND retried = 0").bind(callId).run();
  if (!claim.meta || !claim.meta.changes) return true;
  const lead = await env.DB.prepare("SELECT id, name, phone, stage FROM leads WHERE id = ?").bind(leadId).first();
  if (!lead || !isNewish(lead.stage)) return true;
  const res = await placeCall(env, lead, user || "giordani", "auto", 2);
  if (!res.ok) {
    // the second ring is tried once only: retried stays 1 so a failure is not repeated every minute
    await env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) SELECT id, stage, stage, ?, ? FROM leads WHERE id = ?").bind("Auto-dial: second ring failed: " + res.message.slice(0, 150), user || "giordani", leadId).run().catch(() => {});
    return false;
  }
  return true;
}
// Rings the agent a second time when the first auto-dial ring was not picked up (AUTO_DIAL_RETRY=0 turns this off)
async function retryDials(env) {
  if (!dialOn(env) || !env.DB || env.AUTO_DIAL !== "1" || env.AUTO_DIAL_RETRY === "0") return;
  await ensureTable(env.DB);
  const rows = (await env.DB.prepare("SELECT d.call_id, d.lead_id, d.by_user FROM dial_log d WHERE d.source = 'auto' AND d.attempt = 1 AND d.retried = 0 AND d.done = 0 AND d.created_at <= datetime('now','-100 seconds') AND d.created_at >= datetime('now','-8 minutes') LIMIT 5").all()).results || [];
  for (const row of rows) {
    try {
      const r = await fetch(`${env.CALLRAIL_API_BASE || "https://api.callrail.com"}/v3/a/${env.CALLRAIL_ACCOUNT_ID}/calls/${encodeURIComponent(row.call_id)}.json`, { headers: { authorization: `Token token=${env.CALLRAIL_API_TOKEN}` } });
      if (!r.ok) { await logOnce(env, `RETRY CHECK FAILED: CallRail returned status ${r.status} for call ${row.call_id}`); continue; }
      const c = await r.json().catch(() => null);
      if (!c || !(c.id || c.call_id)) continue;
      // the lead was reached or is on the line: no second ring
      const connected = callConnected(env, c);
      try { await env.DB.prepare("INSERT INTO hook_log (summary) VALUES (?)").bind(("RETRY CHECK: " + JSON.stringify({ id: row.call_id, answered: c.answered, voicemail: c.voicemail, duration: c.duration, talk_time: c.talk_time, call_type: c.call_type, retry: !connected })).slice(0, 300)).run(); } catch (e) { /* ignore */ }
      if (connected) continue;
      if (!(await retryAuto(env, row.call_id, row.lead_id, row.by_user))) {
        const ld = await env.DB.prepare("SELECT name, phone FROM leads WHERE id = ?").bind(row.lead_id).first() || {};
        const link = env.CRM_HOST ? `https://${env.CRM_HOST}/today` : "";
        const text = `AUTO-DIAL NOT ANSWERED: the first ring was missed and the second ring could not be placed, so ${ld.name || ld.phone || "the new lead"} (${prettyPhone(ld.phone)}) was not called. Call them now. ${link}`.trim();
        await alertTeam(env, { subject: "Auto-dial not answered: call the lead", text, html: `<p><b>${esc(text.replace(link, "").trim())}</b></p>`, push: { title: "Auto-dial not answered", message: `${ld.name || ld.phone || "New lead"}: call them now`, click: link || undefined } }).catch(() => {});
      }
    } catch (e) { console.error("retry error", e && e.message); }
  }
}

async function logOnce(env, text) {
  try { const has = await env.DB.prepare("SELECT 1 x FROM hook_log WHERE summary = ?").bind(text).first(); if (!has) await env.DB.prepare("INSERT INTO hook_log (summary) VALUES (?)").bind(text).run(); } catch (e) { /* ignore */ }
}
// Auto-dials with no result after 12 minutes: say so on the lead and alert, instead of leaving the history silent
async function flagSilentDials(env) {
  if (!env.DB) return;
  await ensureTable(env.DB);
  const rows = (await env.DB.prepare("SELECT d.call_id, d.lead_id, d.by_user, l.name, l.phone FROM dial_log d JOIN leads l ON l.id = d.lead_id WHERE d.source = 'auto' AND d.done = 0 AND d.flagged = 0 AND d.created_at <= datetime('now','-12 minutes') AND d.created_at >= datetime('now','-6 hours') LIMIT 10").all()).results || [];
  for (const row of rows) {
    const claim = await env.DB.prepare("UPDATE dial_log SET flagged = 1 WHERE call_id = ? AND flagged = 0").bind(row.call_id).run();
    if (!claim.meta || !claim.meta.changes) continue;
    await env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) SELECT id, stage, stage, ?, ? FROM leads WHERE id = ?").bind("No result from CallRail for this auto-dial after 12 minutes (the call may not have connected, or the CallRail report did not arrive). Check the lead and call them.", row.by_user || "", row.lead_id).run().catch(() => {});
    const link = env.CRM_HOST ? `https://${env.CRM_HOST}/today` : "";
    const text = `AUTO-DIAL RESULT UNKNOWN: no report from CallRail for ${row.name || row.phone || "a new lead"} (${prettyPhone(row.phone)}). Check it and call them if needed. ${link}`.trim();
    await alertTeam(env, { subject: "Auto-dial result unknown", text, html: `<p><b>${esc(text.replace(link, "").trim())}</b></p>`, push: { title: "Auto-dial result unknown", message: `${row.name || row.phone || "Lead"}: check and call`, click: link || undefined } }).catch(() => {});
  }
}
// ---- Call summaries and transcripts from CallRail (Conversation Intelligence). They are produced a few minutes after a call ends, so each call is checked a few times.
const TX_BACKOFF = [8, 20, 45, 90, 180];
function formatTranscript(t) {
  if (!t) return "";
  if (typeof t === "string") return t.trim();
  const list = Array.isArray(t) ? t : (Array.isArray(t.sentences) ? t.sentences : (Array.isArray(t.utterances) ? t.utterances : null));
  if (!list) return "";
  return list.map(u => {
    if (typeof u === "string") return u;
    const who = u.speaker || u.speaker_name || u.role || u.participant || "";
    const text = u.text || u.transcript || u.content || u.sentence || "";
    return text ? (who ? who + ": " : "") + text : "";
  }).filter(Boolean).join("\n").slice(0, 20000);
}
async function pullTranscripts(env) {
  if (!env.CALLRAIL_API_TOKEN || !env.CALLRAIL_ACCOUNT_ID || !env.DB) return;
  await ensureTable(env.DB);
  const rows = (await env.DB.prepare("SELECT call_id, tries FROM call_notes WHERE done = 0 AND next_try <= datetime('now') AND created_at >= datetime('now','-2 days') ORDER BY next_try LIMIT 5").all()).results || [];
  const base = `${env.CALLRAIL_API_BASE || "https://api.callrail.com"}/v3/a/${env.CALLRAIL_ACCOUNT_ID}/calls/`;
  const h = { authorization: `Token token=${env.CALLRAIL_API_TOKEN}` };
  for (const row of rows) {
    try {
      let r = await fetch(`${base}${encodeURIComponent(row.call_id)}.json?fields=call_summary,transcription,conversational_transcript,call_highlights,keywords_spotted,recording,recording_player`, { headers: h });
      if (!r.ok) r = await fetch(`${base}${encodeURIComponent(row.call_id)}.json`, { headers: h });
      if (!r.ok) { await logOnce(env, `TRANSCRIPT CHECK FAILED: CallRail returned status ${r.status} for call ${row.call_id}`); throw new Error("status " + r.status); }
      const c = await r.json().catch(() => ({}));
      const summary = String(c.call_summary || c.summary || (Array.isArray(c.call_highlights) ? c.call_highlights.map(x => x.text || x.highlight || x).join(" ") : c.call_highlights) || "").trim().slice(0, 3000);
      const transcript = formatTranscript(c.conversational_transcript) || formatTranscript(c.transcription) || formatTranscript(c.transcript);
      const keys = Object.keys(c).join(",").slice(0, 400);
      // the recording is not ready when the call ends and the call details only include it when asked for: attach it to the lead as soon as CallRail has it
      const rec = clean(c.recording_player || c.recording || "", 500);
      if (rec) { await env.DB.prepare("UPDATE leads SET recording = ? WHERE id = (SELECT lead_id FROM call_notes WHERE call_id = ?)").bind(rec, row.call_id).run(); const nl = await env.DB.prepare("SELECT lead_id, direction FROM call_notes WHERE call_id = ?").bind(row.call_id).first(); if (nl) await saveRecording(env, { callId: row.call_id, leadId: nl.lead_id, direction: nl.direction || "outbound", url: rec, duration: num(c.duration) }); }
      if (summary || transcript) await env.DB.prepare("UPDATE call_notes SET summary = ?, transcript = ?, keys = ?, done = 1 WHERE call_id = ?").bind(summary, transcript, keys, row.call_id).run();
      else {
        const t = row.tries + 1, last = t > TX_BACKOFF.length;
        await env.DB.prepare("UPDATE call_notes SET tries = ?, keys = ?, done = ?, next_try = datetime('now', ?) WHERE call_id = ?").bind(t, keys, last ? 1 : 0, "+" + (TX_BACKOFF[Math.min(t - 1, TX_BACKOFF.length - 1)]) + " minutes", row.call_id).run();
      }
    } catch (e) {
      const t = row.tries + 1;
      await env.DB.prepare("UPDATE call_notes SET tries = ?, done = ?, next_try = datetime('now', ?) WHERE call_id = ?").bind(t, t > TX_BACKOFF.length ? 1 : 0, "+" + (TX_BACKOFF[Math.min(t - 1, TX_BACKOFF.length - 1)]) + " minutes", row.call_id).run().catch(() => {});
    }
  }
}
// Calls whose transcript is already in but whose lead has no recording link yet (it arrives after the call): look again every 30 minutes for two days
async function pullRecordings(env) {
  if (!env.CALLRAIL_API_TOKEN || !env.CALLRAIL_ACCOUNT_ID || !env.DB) return;
  const rows = (await env.DB.prepare("SELECT n.call_id, n.lead_id, n.direction FROM call_notes n WHERE n.done = 1 AND n.next_try <= datetime('now') AND n.created_at >= datetime('now','-2 days') AND NOT EXISTS (SELECT 1 FROM call_recordings r WHERE r.call_id = n.call_id AND r.url != '') LIMIT 3").all()).results || [];
  for (const row of rows) {
    try {
      await env.DB.prepare("UPDATE call_notes SET next_try = datetime('now','+30 minutes') WHERE call_id = ?").bind(row.call_id).run();
      const r = await fetch(`${env.CALLRAIL_API_BASE || "https://api.callrail.com"}/v3/a/${env.CALLRAIL_ACCOUNT_ID}/calls/${encodeURIComponent(row.call_id)}.json?fields=recording,recording_player`, { headers: { authorization: `Token token=${env.CALLRAIL_API_TOKEN}` } });
      if (!r.ok) continue;
      const c = await r.json().catch(() => ({}));
      const rec = clean(c.recording_player || c.recording || "", 500);
      if (rec) { await env.DB.prepare("UPDATE leads SET recording = ? WHERE id = ?").bind(rec, row.lead_id).run(); await saveRecording(env, { callId: row.call_id, leadId: row.lead_id, direction: row.direction || "outbound", url: rec, duration: num(c.duration) }); }
    } catch (e) { console.error("recording check error", e && e.message); }
  }
}
// the lead's outreach so far, and whether anyone has actually been reached (a call answered, or a person moved the lead past Not contacted)
async function leadAttempts(env, id) {
  await ensureTable(env.DB);
  const lead = await env.DB.prepare("SELECT stage FROM leads WHERE id = ?").bind(id).first();
  if (!lead) return null;
  const d = await env.DB.prepare("SELECT COUNT(*) calls, SUM(result = 'answered') answered, SUM(result = 'voicemail') voicemail, SUM(result = 'noanswer') noanswer, SUM(result = 'notconnected') notconnected FROM dial_log WHERE lead_id = ? AND attempt = 1").bind(id).first() || {};
  const t = await env.DB.prepare("SELECT SUM(reason LIKE 'Texted%') texts, SUM(reason LIKE 'Emailed%') emails, SUM(reason = 'Call result: Answered' OR reason LIKE 'Spoke%') talked, MAX(CASE WHEN reason LIKE 'Texted%' OR reason LIKE 'Emailed%' OR reason LIKE 'Called%' OR reason LIKE 'Call result%' THEN at END) last_at FROM stage_log WHERE lead_id = ?").bind(id).first() || {};
  const n = v => Number(v) || 0;
  const contact = n(t.talked) > 0 || !["new", "nocontact", "lost"].includes(lead.stage);
  return { calls: n(d.calls), answered: n(d.answered), voicemail: n(d.voicemail), noanswer: n(d.noanswer), notconnected: n(d.notconnected), texts: n(t.texts), emails: n(t.emails), contact, last: t.last_at ? when(t.last_at).ago : "" };
}
async function leadHistory(env, id) {
  const rows = (await env.DB.prepare("SELECT from_stage, to_stage, reason, at, by_user FROM stage_log WHERE lead_id = ? ORDER BY id DESC LIMIT 300").bind(id).all()).results || [];
  return rows.map(g => ({ ...g, at: when(g.at).abs }));
}
async function callRecordings(env, id) {
  await ensureTable(env.DB);
  const rows = (await env.DB.prepare("SELECT call_id, direction, url, duration, at FROM call_recordings WHERE lead_id = ? AND url != '' ORDER BY at DESC LIMIT 50").bind(id).all()).results || [];
  return rows.map(r => ({ call_id: r.call_id, direction: r.direction, url: r.url, duration: r.duration, at: when(r.at).abs }));
}
async function callNotes(env, id) {
  await ensureTable(env.DB);
  const rows = (await env.DB.prepare("SELECT call_id, direction, created_at, summary, transcript, done FROM call_notes WHERE lead_id = ? ORDER BY created_at DESC LIMIT 20").bind(id).all()).results || [];
  return rows.map(r => ({ call_id: r.call_id, direction: r.direction, at: when(r.created_at).abs, summary: r.summary || "", transcript: r.transcript || "", done: !!r.done }));
}

// ---- Calling queue: "Start calling" rings the agent's phone for each lead that is New or Not contacted, one after another (newest first).
// Each call is the usual CallRail click-to-call (agent presses 1, the lead is dialed, recorded). When one ends the next starts after a short pause.
// It stops on Stop, when the list is done, outside calling hours, or when the agent does not pick up twice in a row.
const QUEUE_MAX = 40, QUEUE_GAP_SECS = 8;
const QUEUE_WHERE = "l.stage IN ('new','nocontact') AND l.type != 'newsletter' AND COALESCE(l.ip,'') != 'demo' AND length(replace(replace(replace(replace(replace(COALESCE(l.phone,''),'-',''),' ',''),'(',''),')',''),'+','')) >= 10";
const queueEnd = (env, id, note) => env.DB.prepare("UPDATE queue_run SET active = 0, ended_at = datetime('now'), next_at = NULL, note = ? WHERE id = ? AND active = 1").bind(note, id).run();
async function startQueue(env, user) {
  if (!queueOn(env)) return { ok: false, message: "The calling queue is turned off." };
  if (!dialOn(env)) return { ok: false, message: "Calling through CallRail is not set up yet." };
  if (!agentPhone(env, user)) return { ok: false, message: `No cell number is saved for ${user}. Add AGENT_PHONE_${String(user).toUpperCase()} in Cloudflare.` };
  if (env.AUTO_DIAL_ANYTIME !== "1" && !inBusinessHours()) return { ok: false, message: "Calling hours are Monday to Saturday, 9 AM to 6 PM Eastern." };
  await ensureTable(env.DB);
  await env.DB.prepare("UPDATE queue_run SET active = 0, ended_at = datetime('now'), next_at = NULL, note = 'Replaced by a new run' WHERE active = 1 AND user = ?").bind(user).run();
  const leads = (await env.DB.prepare(`SELECT l.id FROM leads l WHERE ${QUEUE_WHERE} ORDER BY l.created_at DESC, l.id DESC LIMIT ${QUEUE_MAX}`).all()).results || [];
  if (!leads.length) return { ok: false, message: "No new or not-contacted leads to call." };
  const run = await env.DB.prepare("INSERT INTO queue_run (user, next_at) VALUES (?, datetime('now'))").bind(user).run();
  const id = run.meta.last_row_id;
  await env.DB.batch(leads.map((l, i) => env.DB.prepare("INSERT INTO queue_items (run_id, lead_id, pos) VALUES (?,?,?)").bind(id, l.id, i)));
  const res = await runQueue(env, id);
  return { ok: !res.message, message: res.message || "", total: leads.length };
}
// places the next call of every run that is due (and every minute from the schedule, as a backup for the short pause)
async function runQueue(env, onlyRun) {
  if (!queueOn(env) || !dialOn(env) || !env.DB) return { message: "" };
  await ensureTable(env.DB);
  const runs = (await env.DB.prepare("SELECT id, user FROM queue_run WHERE active = 1 AND next_at IS NOT NULL AND next_at <= datetime('now')" + (onlyRun ? " AND id = ?" : "")).bind(...(onlyRun ? [onlyRun] : [])).all()).results || [];
  let message = "";
  for (const run of runs) {
    const claim = await env.DB.prepare("UPDATE queue_run SET next_at = NULL WHERE id = ? AND next_at IS NOT NULL").bind(run.id).run();
    if (!claim.meta || !claim.meta.changes) continue;
    if (env.AUTO_DIAL_ANYTIME !== "1" && !inBusinessHours()) { await queueEnd(env, run.id, "Stopped: outside calling hours."); continue; }
    const item = await env.DB.prepare(`SELECT l.id, l.phone FROM queue_items i JOIN leads l ON l.id = i.lead_id WHERE i.run_id = ? AND i.status = 'waiting' AND ${QUEUE_WHERE} ORDER BY i.pos LIMIT 1`).bind(run.id).first();
    if (!item) { await queueEnd(env, run.id, "Queue finished."); continue; }
    await env.DB.prepare("UPDATE queue_items SET status = 'calling' WHERE run_id = ? AND lead_id = ?").bind(run.id, item.id).run();
    const res = await placeCall(env, item, run.user, "queue");
    if (!res.ok) { await queueEnd(env, run.id, "Stopped: " + res.message); message = res.message; continue; }
    await env.DB.prepare("UPDATE queue_items SET call_id = ? WHERE run_id = ? AND lead_id = ?").bind(res.id, run.id, item.id).run();
  }
  return { message };
}
// a queue call finished: ring for the next lead after a short pause, or stop if the agent did not pick up twice in a row
async function queueAfterCall(env, callId, dialed, ctx) {
  const it = await env.DB.prepare("SELECT run_id FROM queue_items WHERE call_id = ?").bind(callId).first();
  if (!it) return;
  await env.DB.prepare("UPDATE queue_items SET status = ? WHERE call_id = ?").bind(dialed ? "done" : "missed", callId).run();
  await env.DB.prepare(dialed ? "UPDATE queue_run SET misses = 0 WHERE id = ?" : "UPDATE queue_run SET misses = misses + 1 WHERE id = ?").bind(it.run_id).run();
  const st = await env.DB.prepare("SELECT misses FROM queue_run WHERE id = ?").bind(it.run_id).first();
  if (st && st.misses >= 2) { await queueEnd(env, it.run_id, "Stopped: you did not pick up twice in a row."); return; }
  await env.DB.prepare("UPDATE queue_run SET next_at = datetime('now', ?) WHERE id = ? AND active = 1").bind(`+${QUEUE_GAP_SECS} seconds`, it.run_id).run();
  if (ctx) ctx.waitUntil((async () => { await new Promise(r => setTimeout(r, (QUEUE_GAP_SECS + 1) * 1000)); await runQueue(env, it.run_id); })().catch(() => {}));
}
const queueOn = env => env.QUEUE === "1"; // the one-by-one calling queue is switched off unless QUEUE=1 (kept for later)
async function queueStatus(env, user) {
  if (!queueOn(env)) return { disabled: true };
  await ensureTable(env.DB);
  const run = await env.DB.prepare("SELECT id, active, note, (ended_at IS NOT NULL AND ended_at >= datetime('now','-10 minutes')) AS recent FROM queue_run WHERE user = ? ORDER BY id DESC LIMIT 1").bind(user).first();
  const eligible = (await env.DB.prepare(`SELECT COUNT(*) n FROM leads l WHERE ${QUEUE_WHERE}`).first() || {}).n || 0;
  if (!run || !run.active) return { active: false, eligible: Math.min(eligible, QUEUE_MAX), note: run && run.recent ? run.note || "" : "" };
  const q = (extra) => env.DB.prepare(`SELECT l.name, l.phone FROM queue_items i JOIN leads l ON l.id = i.lead_id WHERE i.run_id = ? AND ${extra} LIMIT 1`).bind(run.id);
  const cnt = await env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status IN ('done','missed') THEN 1 ELSE 0 END) done FROM queue_items WHERE run_id = ?").bind(run.id).first() || {};
  const now = await q("i.status = 'calling'").first(), next = await env.DB.prepare(`SELECT l.name, l.phone FROM queue_items i JOIN leads l ON l.id = i.lead_id WHERE i.run_id = ? AND i.status = 'waiting' AND ${QUEUE_WHERE} ORDER BY i.pos LIMIT 1`).bind(run.id).first();
  const nm = r => (r ? r.name || prettyPhone(r.phone) : "");
  return { active: true, total: cnt.total || 0, done: cnt.done || 0, now: nm(now), next: nm(next) };
}

// Backup for the webhook: every minute ask CallRail how each requested call ended (4 to 90 minutes after it was requested) and log it the same way
async function pollDials(env) {
  if (!dialOn(env) || !env.DB) return;
  await ensureTable(env.DB);
  const rows = (await env.DB.prepare("SELECT call_id FROM dial_log WHERE done = 0 AND created_at <= datetime('now','-4 minutes') AND created_at >= datetime('now','-90 minutes') ORDER BY created_at LIMIT 8").all()).results || [];
  for (const row of rows) {
    try {
      const r = await fetch(`${env.CALLRAIL_API_BASE || "https://api.callrail.com"}/v3/a/${env.CALLRAIL_ACCOUNT_ID}/calls/${encodeURIComponent(row.call_id)}.json`, { headers: { authorization: `Token token=${env.CALLRAIL_API_TOKEN}` } });
      if (!r.ok) { await logOnce(env, `POLL FAILED: CallRail returned status ${r.status} for call ${row.call_id}` + (r.status === 403 ? " (the API key may not be allowed to read calls)" : "")); continue; }
      const c = await r.json().catch(() => null);
      if (!c || !(c.id || c.call_id)) continue;
      try { await env.DB.prepare("INSERT INTO hook_log (summary) VALUES (?)").bind("POLLED: " + JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k, v]) => v !== null && v !== "" && !/recording|url|name|city|state|country|zip|email|phone_number|company|tags|note/i.test(k) || /recording_duration|business_phone/i.test(k)).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 40) : v]))).slice(0, 600)).run(); } catch (e) { /* ignore */ }
      await handleOutbound(env, { ...c, id: row.call_id });
    } catch (e) { console.error("poll error", e && e.message); }
  }
}

// Shows whether the CallRail click-to-call settings are in place and asks CallRail for the account id and tracking numbers (owner only)
async function callrailTest(env) {
  const out = { token_set: !!env.CALLRAIL_API_TOKEN, account_id_set: !!env.CALLRAIL_ACCOUNT_ID, caller_id_set: !!env.CALLRAIL_CALLER_ID, agent_giordani: !!agentPhone(env, "giordani"), agent_bronson: !!agentPhone(env, "bronson"), recording: env.CALL_RECORDING === "1", auto_dial: env.AUTO_DIAL === "1" };
  try {
    await ensureTable(env.DB);
    const tn = await env.DB.prepare("SELECT SUM(CASE WHEN done=1 AND (COALESCE(summary,'')!='' OR COALESCE(transcript,'')!='') THEN 1 ELSE 0 END) ready, SUM(CASE WHEN done=1 AND COALESCE(summary,'')='' AND COALESCE(transcript,'')='' THEN 1 ELSE 0 END) none, SUM(CASE WHEN done=0 THEN 1 ELSE 0 END) pending FROM call_notes").first().catch(() => null);
    const tk = await env.DB.prepare("SELECT keys FROM call_notes WHERE keys IS NOT NULL ORDER BY created_at DESC LIMIT 1").first().catch(() => null);
    out.transcripts = { ready: (tn && tn.ready) || 0, none: (tn && tn.none) || 0, pending: (tn && tn.pending) || 0, keys: (tk && tk.keys) || "" };
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

// The same phone number is never auto-dialed twice within 15 minutes (a double form submission, or a test repeated quickly)
async function autoDialOnce(env, lead) {
  const d10 = digitsOf(lead.phone).slice(-10);
  if (d10.length === 10) {
    const dup = await env.DB.prepare("SELECT 1 x FROM dial_log d JOIN leads l ON l.id = d.lead_id WHERE d.source = 'auto' AND d.created_at >= datetime('now','-15 minutes') AND l.id != ? AND replace(replace(replace(replace(replace(l.phone,'-',''),' ',''),'(',''),')',''),'+','') LIKE ? LIMIT 1").bind(lead.id, "%" + d10).first().catch(() => null);
    if (dup) {
      await env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) SELECT id, stage, stage, ?, 'system' FROM leads WHERE id = ?").bind("Auto-dial skipped: this phone number was already auto-dialed in the last 15 minutes", lead.id).run().catch(() => {});
      return;
    }
  }
  return autoDial(env, lead);
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

// One person, one source: a form lead and a phone call from the same number (last 90 days) share the ad click that brought them. Whichever record is missing the click ID gets it from the other.
async function linkByPhone(env, id) {
  const me = await env.DB.prepare("SELECT id, phone, gclid, gbraid, wbraid, utm_source, utm_medium, utm_campaign, utm_term FROM leads WHERE id = ?").bind(id).first();
  const d10 = me ? digitsOf(me.phone).slice(-10) : "";
  if (!me || d10.length < 10) return;
  const others = (await env.DB.prepare("SELECT id, gclid, gbraid, wbraid, utm_source, utm_medium, utm_campaign, utm_term FROM leads WHERE id != ? AND type != 'newsletter' AND COALESCE(ip,'') != 'demo' AND created_at >= datetime('now','-90 days') AND replace(replace(replace(replace(replace(phone,'-',''),' ',''),'(',''),')',''),'+','') LIKE ? ORDER BY id DESC LIMIT 10").bind(id, "%" + d10).all()).results || [];
  const give = (from, to) => {
    const plain = (!to.utm_medium || to.utm_medium === "call") && !!from.utm_medium && from.utm_medium !== "call";
    return [
      env.DB.prepare("UPDATE leads SET gclid = ?, gbraid = ?, wbraid = ?, utm_campaign = CASE WHEN COALESCE(utm_campaign,'') = '' THEN ? ELSE utm_campaign END, utm_term = CASE WHEN COALESCE(utm_term,'') = '' THEN ? ELSE utm_term END" + (plain ? ", utm_source = ?, utm_medium = ?" : "") + " WHERE id = ?")
        .bind(...[from.gclid || "", from.gbraid || "", from.wbraid || "", from.utm_campaign || "", from.utm_term || "", ...(plain ? [from.utm_source || "", from.utm_medium || ""] : []), to.id]),
      env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) SELECT id, stage, stage, ?, 'system' FROM leads WHERE id = ?").bind("Ad click linked: the same phone number came in earlier or later with a Google Ads click", to.id),
    ];
  };
  if (!hasClick(me)) { const src = others.find(hasClick); if (src) await env.DB.batch(give(src, me)); }
  else { const miss = others.filter(o => !hasClick(o)); if (miss.length) await env.DB.batch(miss.flatMap(o => give(me, o))); }
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
    const res = await handleOutbound(env, c, ctx);
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
    gclid: clean(c.gclid || "", 300), gbraid: clean(c.gbraid || "", 300), wbraid: clean(c.wbraid || "", 300), utm_source: clean(c.utm_source || src, 200), utm_medium: clean(c.utm_medium || (c.medium || "call"), 200),
    utm_campaign: clean(c.utm_campaign || c.campaign || "", 200), utm_term: clean(c.utm_term || c.keywords || "", 200),
    message: [dir === "outbound" ? "Outbound call" : "", voicemail ? "Left a voicemail" : answered === 0 ? "Missed call, call back" : "", c.first_call === true || c.first_call === "true" ? "First-time caller" : "", [c.customer_city, c.customer_state].filter(Boolean).join(", ")].filter(Boolean).join(" · "),
  };
  if (!phone && !callId) return json({ success: false, message: "No call data" }, 422);
  const existing = callId ? await env.DB.prepare("SELECT id FROM leads WHERE call_id = ?").bind(callId).first() : null;
  if (existing) {
    // CallRail sends the webhook again when a call is updated (recording ready, tags) and a Pre-Call lead is finished by the Post-Call one: keep the person's edits, refresh call facts
    const prev = await env.DB.prepare("SELECT answered, message, gclid, gbraid, wbraid, page, utm_source, utm_campaign, name FROM leads WHERE id = ?").bind(existing.id).first() || {};
    const keep = (a, b) => a || b || "";
    await env.DB.prepare("UPDATE leads SET duration = ?, recording = COALESCE(NULLIF(?, ''), recording), answered = ?, message = ?, name = ?, gclid = ?, gbraid = ?, wbraid = ?, page = ?, utm_source = ?, utm_campaign = ? WHERE id = ?")
      .bind(row.duration, row.recording, row.answered, keep(prev.message, row.message), keep(prev.name, row.name), keep(prev.gclid, row.gclid), keep(prev.gbraid, row.gbraid), keep(prev.wbraid, row.wbraid), keep(prev.page, row.page), keep(prev.utm_source, row.utm_source), keep(prev.utm_campaign, row.utm_campaign), existing.id).run();
    if (row.recording) await saveRecording(env, { callId: row.call_id, leadId: existing.id, direction: "inbound", url: row.recording, duration: row.duration, at: row.created });
    await inboundContact(env, existing.id, row).catch(() => {});
    if (prev.answered === null && row.answered !== null) {
      if (row.call_id && row.answered === 1 && (row.duration || 0) >= 20) ctx.waitUntil(env.DB.prepare("INSERT OR IGNORE INTO call_notes (call_id, lead_id, direction, next_try) VALUES (?,?,?, datetime('now','+3 minutes'))").bind(row.call_id, existing.id, "inbound").run().catch(() => {}));
      ctx.waitUntil(notifyCall(env, { id: existing.id, name: keep(prev.name, row.name), phone: row.phone, answered: row.answered, message: keep(prev.message, row.message), utm_source: keep(prev.utm_source, row.utm_source), utm_campaign: keep(prev.utm_campaign, row.utm_campaign), recording: row.recording }, url.origin, false));
    }
    return json({ success: true, updated: true });
  }
  const insC = await env.DB.prepare(`INSERT INTO leads (created_at,type,name,phone,message,page,referrer,gclid,gbraid,wbraid,utm_source,utm_medium,utm_campaign,utm_term,call_id,duration,recording,answered,tracking_number,email)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(row.created, "call", row.name, row.phone, row.message, row.page, row.referrer, row.gclid, row.gbraid, row.wbraid, row.utm_source, row.utm_medium, row.utm_campaign, row.utm_term, row.call_id, row.duration, row.recording, row.answered, row.tracking, "").run();
  if (insC.meta && insC.meta.last_row_id) {
    if (row.recording) ctx.waitUntil(saveRecording(env, { callId: row.call_id, leadId: insC.meta.last_row_id, direction: "inbound", url: row.recording, duration: row.duration, at: row.created }));
    await inboundContact(env, insC.meta.last_row_id, row).catch(() => {});
    ctx.waitUntil(linkByPhone(env, insC.meta.last_row_id).catch(() => {}));
    // an answered call longer than 20 seconds gets its summary and transcript pulled once CallRail has produced them
    if (row.call_id && row.answered === 1 && (row.duration || 0) >= 20) ctx.waitUntil(env.DB.prepare("INSERT OR IGNORE INTO call_notes (call_id, lead_id, direction, next_try) VALUES (?,?,?, datetime('now','+3 minutes'))").bind(row.call_id, insC.meta.last_row_id, "inbound").run().catch(() => {}));
  }
  ctx.waitUntil(notifyCall(env, { id: insC.meta && insC.meta.last_row_id, name: row.name, phone: row.phone, answered: row.answered, message: row.message, utm_source: row.utm_source, utm_campaign: row.utm_campaign, recording: row.recording }, url.origin));
  return json({ success: true });
}

// ---- Meta (Facebook / Instagram) Instant Form leads: Zapier's "Facebook Lead Ads" trigger posts each lead here as JSON.
// URL: https://<site>/api/meta?key=<META_KEY>   (META_KEY is a Cloudflare secret you choose). The lead lands in the CRM like a website form lead (and auto-dials if that is on).
// "26 VW Tiguan", "2019 Honda Accord EX", "Tesla Model 3 2022" -> { year, make, model }
const CAR_MAKES = ["Mercedes-Benz", "Land Rover", "Range Rover", "Alfa Romeo", "Aston Martin", "Rolls-Royce", "Rolls Royce", "Acura", "Audi", "Bentley", "BMW", "Buick", "Cadillac", "Chevrolet", "Chrysler", "Dodge", "Ferrari", "Fiat", "Ford", "Genesis", "GMC", "Honda", "Hyundai", "Infiniti", "Jaguar", "Jeep", "Kia", "Lamborghini", "Lexus", "Lincoln", "Lotus", "Maserati", "Mazda", "McLaren", "Mercedes", "Mini", "Mitsubishi", "Nissan", "Polestar", "Porsche", "Ram", "Rivian", "Subaru", "Tesla", "Toyota", "Volkswagen", "Volvo", "Lucid", "Scion", "Saturn", "Pontiac", "Hummer"];
const CAR_ALIAS = { vw: "Volkswagen", chevy: "Chevrolet", benz: "Mercedes-Benz", mercedes: "Mercedes-Benz", "mercedes benz": "Mercedes-Benz", merc: "Mercedes-Benz", "range rover": "Land Rover", "rolls royce": "Rolls-Royce", landrover: "Land Rover", bmw: "BMW", gmc: "GMC" };
function splitCar(text) {
  let t = String(text || "").trim().replace(/\s+/g, " ");
  if (!t) return { year: "", make: "", model: "" };
  let year = "";
  const four = /(^|\s)((?:19|20)\d{2})(?=\s|$)/.exec(t);
  if (four) { year = four[2]; t = t.replace(four[0], " ").trim(); }
  else {
    const two = /^(\d{2})(?=\s)/.exec(t);
    if (two) { const n = Number(two[1]), cur = new Date().getFullYear() % 100; year = String(n <= cur + 1 ? 2000 + n : 1900 + n); t = t.slice(two[0].length).trim(); }
  }
  t = t.replace(/^(older|old|newer|new|my|a|the)\s+/i, "");
  const low = t.toLowerCase();
  let make = "", rest = t;
  const cands = [...CAR_MAKES.map(m => [m.toLowerCase(), m]), ...Object.entries(CAR_ALIAS)].sort((a, b) => b[0].length - a[0].length);
  for (const [k, v] of cands) {
    if (low === k || low.startsWith(k + " ") || low.endsWith(" " + k)) {
      make = CAR_ALIAS[k] || v;
      if (k === "range rover") { rest = t; break; }
      rest = low === k ? "" : low.startsWith(k + " ") ? t.slice(k.length + 1) : t.slice(0, t.length - k.length - 1);
      break;
    }
  }
  return { year, make, model: rest.trim() };
}

async function handleMeta(request, env, url, ctx) {
  if (!env.META_KEY) return json({ success: false, message: "META_KEY is not set" }, 503);
  if (!safeEqual(url.searchParams.get("key") || "", env.META_KEY)) return json({ success: false }, 401);
  let d;
  try { const ct = request.headers.get("content-type") || ""; d = ct.includes("json") ? await request.json() : Object.fromEntries(await request.formData()); } catch { return json({ success: false, message: "Bad request" }, 400); }
  // field names are matched ignoring case, spaces and punctuation, so "Full Name", "full_name" and "fullname" are the same
  const norm = k => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");
  const nd = {}; for (const [k, v] of Object.entries(d)) if (v !== undefined && v !== null && typeof v !== "object") nd[norm(k)] = v;
  const pick = (...ks) => { for (const k of ks) { const v = nd[norm(k)]; if (v !== undefined && String(v).trim() !== "") return String(v); } return ""; };
  try { await env.DB.prepare("INSERT INTO hook_log (summary) VALUES (?)").bind("META fields: " + Object.keys(d).slice(0, 30).join(",").slice(0, 400)).run(); await env.DB.prepare("DELETE FROM hook_log WHERE id <= (SELECT MAX(id) FROM hook_log) - 40").run(); } catch (e) { /* logging must never break a lead */ }
  const name = clean(pick("name", "full_name", "fullname", "customer_name", "contact_name", "your_name") || [pick("first_name", "firstname"), pick("last_name", "lastname")].filter(Boolean).join(" "), MAX.default);
  const phone = clean(pick("phone", "phone_number", "Phone Number"), MAX.default);
  const email = clean(pick("email", "Email"), MAX.default);
  if (!name && !phone && !email) return json({ success: false, message: "No lead data" }, 422);
  if ((phone.match(/\d/g) || []).length < 7 && !email) return json({ success: false, message: "No phone or email" }, 422);
  if (!env.DB) return json({ success: false, message: "Lead storage is not configured" }, 503);
  await ensureTable(env.DB);
  // Meta sends each lead once, but Zapier can retry: the Meta lead id keeps a repeat from creating a second lead
  const metaId = clean(pick("lead_id", "leadgen_id", "id"), 80);
  const key = metaId ? "meta:" + metaId : "";
  if (key && await env.DB.prepare("SELECT id FROM leads WHERE call_id = ?").bind(key).first()) return json({ success: true, duplicate: true });
  const service = clean(pick("service", "Service") || "Window Tint", MAX.default);
  const extras = ["form_name", "ad_name", "adset_name", "platform"].map(k => [k, pick(k)]).filter(x => x[1]).map(x => x[0].replace(/_/g, " ") + ": " + x[1]).join(" · ");
  // every other answer on the form is kept as "Question: answer", so the lead shows what was asked ("How soon are you looking to get this done?" and so on)
  const known = new Set(["name", "fullname", "firstname", "lastname", "customername", "contactname", "yourname", "phone", "phonenumber", "email", "emailaddress", "service", "vehicle", "car", "make", "year", "model", "leadid", "leadgenid", "id", "campaignname", "campaign", "utmcampaign", "adname", "adsetname", "formname", "platform", "message", "notes", "comments", "key"]);
  const pretty = k => (/[\s?]/.test(k) ? k.trim() : k.replace(/[_-]+/g, " ").replace(/^./, c => c.toUpperCase()));
  let carAnswer = "", yearAns = "", makeAns = "", modelAns = "";
  const answers = [];
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === null || typeof v === "object" || String(v).trim() === "") continue;
    const nk = norm(k);
    if (known.has(nk)) continue;
    // vehicle questions: separate "Vehicle Year", "Make" and "Model" answers fill their own fields; one combined answer goes into the model field
    if (/year/.test(nk) && !/model|make/.test(nk)) { yearAns = yearAns || String(v); continue; }
    if (/make/.test(nk) && !/model/.test(nk)) { makeAns = makeAns || String(v); continue; }
    if (/model/.test(nk) && !/make/.test(nk)) { modelAns = modelAns || String(v); continue; }
    if (/make|model|vehicle|^car/.test(nk)) { carAnswer = carAnswer || String(v); continue; }
    const label = pretty(k).replace(/[:\s]+$/, "");
    answers.push(label + (label.endsWith("?") ? " " : ": ") + String(v).trim());
  }
  const msg = clean([pick("message", "notes", "comments"), answers.join("\n"), extras].filter(Boolean).join("\n"), MAX.message);
  let vMake = pick("make", "Make") || makeAns, vYear = pick("year", "Year") || yearAns, vModel = pick("model", "Model") || modelAns;
  const vCombined = pick("vehicle", "Vehicle", "car", "Car") || carAnswer;
  if (vCombined && !vMake && !vModel) { const sp = splitCar(vCombined); vMake = sp.make; vYear = vYear || sp.year; vModel = sp.model || (sp.make ? "" : vCombined); }
  const lead = { type: "quote", name: name || "Meta lead", email, phone, service, also_interested: "", make: clean(vMake, 60), year: clean(vYear, 10), model: clean(vModel, 80), message: msg,
    page: "Meta Instant Form", referrer: "", gclid: "", gbraid: "", wbraid: "", utm_source: "meta", utm_medium: "paid_social", utm_campaign: clean(pick("campaign_name", "campaign", "utm_campaign"), 200), utm_term: clean(pick("ad_name", "adset_name"), 200) };
  const ins = await env.DB.prepare(`INSERT INTO leads (type,name,email,phone,service,also_interested,make,year,model,message,page,referrer,gclid,gbraid,wbraid,utm_source,utm_medium,utm_campaign,utm_term,call_id,ip,user_agent,value)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(lead.type, lead.name, lead.email, lead.phone, lead.service, lead.also_interested, lead.make, lead.year, lead.model, lead.message, lead.page, lead.referrer, lead.gclid, lead.gbraid, lead.wbraid, lead.utm_source, lead.utm_medium, lead.utm_campaign, lead.utm_term, key, "", "meta-instant-form", defaultValue(lead.service)).run();
  const newLead = { ...lead, id: ins.meta && ins.meta.last_row_id };
  // the Instant Form has a required text-message consent box, so a Meta lead has agreed to texts. META_SMS_CONSENT=1 says so for every lead; otherwise a consent-looking answer on the form has to be ticked
  const consentAns = Object.entries(nd).find(([k, v]) => /consent|agree|optin|sms|text/.test(k) && !/^(no|false|0|)$/i.test(String(v).trim()));
  if (newLead.id && (env.META_SMS_CONSENT === "1" || env.META_SMS_MARKETING === "1" || consentAns)) await env.DB.prepare("UPDATE leads SET sms_consent = 1 WHERE id = ?").bind(newLead.id).run().catch(() => {});
  // META_SMS_MARKETING=1: the Facebook lead form's consent covers promotional texts too, so a new Meta lead can receive campaigns
  if (newLead.id && env.META_SMS_MARKETING === "1") await env.DB.prepare("UPDATE leads SET sms_marketing = 1 WHERE id = ?").bind(newLead.id).run().catch(() => {});
  if (newLead.id) ctx.waitUntil(linkByPhone(env, newLead.id).catch(() => {}));
  ctx.waitUntil(notify(env, newLead, url.origin));
  if (env.AUTO_DIAL === "1" && newLead.id && phone && (env.AUTO_DIAL_ANYTIME === "1" || inBusinessHours())) ctx.waitUntil(autoDialOnce(env, newLead));
  return json({ success: true });
}

async function addLead(request, env) {
  const b = await request.json().catch(() => ({}));
  const name = clean(b.name, 120), phone = clean(b.phone, 40), email = clean(b.email, 200);
  if (!name && !phone && !email) return json({ success: false, message: "Add a name, phone or email" }, 422);
  const source = clean(b.source, 60) || "Phone call";
  const d10 = last10(phone);
  if (d10.length === 10) { // a customer already in the CRM is reused, never duplicated
    const hit = ((await env.DB.prepare("SELECT id, phone FROM leads WHERE type != 'newsletter' AND phone LIKE ? ORDER BY id DESC LIMIT 20").bind("%" + d10.slice(-4) + "%").all()).results || []).find(x => last10(x.phone) === d10);
    if (hit) return json({ success: true, id: hit.id, existing: true });
  }
  const ins = await env.DB.prepare(`INSERT INTO leads (type,name,email,phone,service,make,year,model,message,utm_source,utm_medium,stage,value)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(/call/i.test(source) ? "call" : "manual", name, email, phone, clean(b.service, 100), clean(b.make, 60), clean(b.year, 10), clean(b.model, 80), clean(b.notes, 2000), source, "manual", STAGE_KEYS.includes(b.stage) ? b.stage : "new", defaultValue(clean(b.service, 100))).run();
  return json({ success: true, id: ins.meta && ins.meta.last_row_id });
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
  const smsConsent = String(data.sms_consent || "").toLowerCase() === "yes";
  for (const f of ["page", "referrer", "gclid", "gbraid", "wbraid", "utm_source", "utm_medium", "utm_campaign", "utm_term"]) lead[f] = clean(data[f], 500);

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

  const ins = await env.DB.prepare(`INSERT INTO leads (type,name,email,phone,service,also_interested,make,year,model,message,page,referrer,gclid,gbraid,wbraid,utm_source,utm_medium,utm_campaign,utm_term,ip,user_agent,value)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(type, lead.name, lead.email, lead.phone, lead.service, lead.also_interested, lead.make, lead.year, lead.model, lead.message,
      lead.page, lead.referrer, lead.gclid, lead.gbraid, lead.wbraid, lead.utm_source, lead.utm_medium, lead.utm_campaign, lead.utm_term, ip, clean(request.headers.get("user-agent") || "", 300), type === "quote" ? defaultValue(lead.service) : 0).run();

  const newLead = { ...lead, id: ins.meta && ins.meta.last_row_id };
  if (newLead.id && smsConsent) await env.DB.prepare("UPDATE leads SET sms_consent = 1 WHERE id = ?").bind(newLead.id).run().catch(() => {});
  if (newLead.id) ctx.waitUntil(linkByPhone(env, newLead.id).catch(() => {}));
  ctx.waitUntil(notify(env, newLead, new URL(request.url).origin));
  // optional: ring the agent's phone straight away and connect them to the new lead (AUTO_DIAL=1, AUTO_DIAL_AGENT=giordani)
  if (env.AUTO_DIAL === "1" && type === "quote" && newLead.id && (env.AUTO_DIAL_ANYTIME === "1" || inBusinessHours())) ctx.waitUntil(autoDialOnce(env, newLead));
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
async function sendNtfy(env, { title, message, click }) {
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

// ---- Web Push: the CRM installed on a phone as an app (Add to Home Screen) can receive notifications.
// Standard Web Push (RFC 8030 / 8291 / 8292) with Web Crypto, no extra service. The signing keys are created once and kept in the database.
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = str => { const t = String(str).replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(t + "=".repeat((4 - t.length % 4) % 4)), c => c.charCodeAt(0)); };
const concatBytes = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
let vapidCache = null;
async function getVapid(env) {
  if (vapidCache) return vapidCache;
  await ensureTable(env.DB);
  let row = await env.DB.prepare("SELECT v FROM push_keys WHERE k = 'vapid'").first();
  if (!row) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    await env.DB.prepare("INSERT OR IGNORE INTO push_keys (k, v) VALUES ('vapid', ?)").bind(JSON.stringify({ priv, pub: b64u(pub) })).run();
    row = await env.DB.prepare("SELECT v FROM push_keys WHERE k = 'vapid'").first();
  }
  const o = JSON.parse(row.v);
  const key = await crypto.subtle.importKey("jwk", o.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return (vapidCache = { pub: o.pub, key });
}
async function vapidHeader(env, endpoint) {
  const v = await getVapid(env), te = new TextEncoder();
  const enc = o => b64u(te.encode(JSON.stringify(o)));
  const unsigned = enc({ typ: "JWT", alg: "ES256" }) + "." + enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:" + (env.VAPID_SUBJECT || "info@divinedetailers.com") });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.key, te.encode(unsigned)));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${v.pub}`;
}
// RFC 8291 message encryption (aes128gcm). `salt` and `eph` (an ECDH key pair) can be given for testing.
async function webPushEncrypt(p256dh, auth, plaintext, { salt, eph } = {}) {
  const te = new TextEncoder(), clientPub = unb64u(p256dh), authSecret = unb64u(auth);
  salt = salt || crypto.getRandomValues(new Uint8Array(16));
  eph = eph || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const clientKey = await crypto.subtle.importKey("raw", clientPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey }, eph.privateKey, 256));
  const hkdf = async (saltB, ikm, info, len) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: saltB, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), len * 8));
  const ikm = await hkdf(authSecret, ecdh, concatBytes(te.encode("WebPush: info\0"), clientPub, ephPub), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]), concatBytes(plaintext, new Uint8Array([2]))));
  return concatBytes(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([ephPub.length]), ephPub, ct);
}
async function sendWebPush(env, sub, payload) {
  const body = await webPushEncrypt(sub.p256dh, sub.auth, new TextEncoder().encode(JSON.stringify(payload)));
  const r = await fetch(sub.endpoint, { method: "POST", headers: { authorization: await vapidHeader(env, sub.endpoint), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high" }, body });
  // the phone removed the app or turned notifications off: forget that device
  if (r.status === 404 || r.status === 410) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(sub.endpoint).run().catch(() => {});
  return r.status;
}
async function pushToDevices(env, { title, message, click, users }) {
  if (!env.DB) return 0;
  await ensureTable(env.DB);
  const rows = (await env.DB.prepare("SELECT endpoint, p256dh, auth, user FROM push_subs").all()).results || [];
  let targets = users && users.length ? rows.filter(r => users.includes(r.user)) : rows;
  // the shop owner's phone only gets "New Lead Incoming" (and the alerts-on confirmation); every other alert goes to the owner login only
  if (title !== "New Lead Incoming" && title !== "Alerts are on") targets = targets.filter(r => r.user === OWNER);
  if (!targets.length) return 0;
  let path = "/today"; try { const u = new URL(click); path = u.pathname + u.search + u.hash; } catch (e) { /* no link */ }
  const payload = { title, body: message, url: path };
  const res = await Promise.all(targets.map(t => sendWebPush(env, t, payload).catch(() => 0)));
  return res.filter(c => c >= 200 && c < 300).length;
}
async function sendPush(env, msg) {
  await Promise.all([sendNtfy(env, msg), pushToDevices(env, msg).catch(e => console.error("web push error", e && e.message))]);
}

// tell Zapier (and from there the Urable calendar) that a lead is booked or its appointment moved
async function bookedHook(env, id, event) {
  if (!env.BOOKED_WEBHOOK_URL || !env.DB) return;
  try {
    const l = await env.DB.prepare("SELECT id, name, email, phone, service, make, year, model, value, notes, appt_at FROM leads WHERE id = ?").bind(id).first();
    if (!l) return;
    const at = l.appt_at ? etLocalToUtc(l.appt_at) : null;
    const nm = String(l.name || "").trim().split(/\s+/), veh = [l.year, l.make, l.model].filter(Boolean).join(" ");
    await fetch(env.BOOKED_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      type: "booking", event, lead_id: l.id, name: l.name || "", first_name: nm[0] || "", last_name: nm.slice(1).join(" "), email: l.email || "",
      phone_e164: e164(l.phone), phone_display: prettyPhone(l.phone), service: l.service || "", vehicle: veh, year: l.year || "", make: l.make || "", model: l.model || "",
      price: l.value || 0, notes: l.notes || "", appt_local: l.appt_at || "", appt_start: at ? at.toISOString() : "", timezone: TZ, crm_link: crmLink(env, "", "/admin/pipeline#id=" + l.id),
      text: `${event === "rescheduled" ? "Rescheduled" : "Booked"}: ${l.name || prettyPhone(l.phone)}, ${[l.service, veh].filter(Boolean).join(", ")}${l.appt_at ? " on " + l.appt_at.replace("T", " ") : ""}`,
    }) });
  } catch (e) { console.error("booked webhook error", e && e.message); }
}

// ---- Urable calendar: a booked lead becomes a customer + vehicle + scheduled job (or a calendar event) in Urable ----
const URABLE = env => (env.URABLE_BASE || "https://app.urable.com/api").replace(/\/$/, "");
async function urableCall(env, method, path, body) {
  const r = await fetch(URABLE(env) + path, { method, headers: { authorization: "Bearer " + env.URABLE_API_KEY, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`Urable ${method} ${path.split("?")[0]} ${r.status}: ${String(j.error || "").slice(0, 160)}`);
  return j.data;
}
const urableHours = (env, service) => {
  const sv = String(service || "").toLowerCase();
  const d = /tint/.test(sv) ? 3 : /coat|ppf|paint|correct|wrap|protection/.test(sv) ? 8 : 4;
  return Math.max(0.5, Math.min(24, Number(env.URABLE_JOB_HOURS) || d));
};
const words = t => String(t || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2 && !["window", "the", "and", "for"].includes(w));
// every service in the Urable catalog (pages of 100)
async function urableCatalog(env) {
  const out = [];
  let after = "";
  for (let i = 0; i < 5; i++) {
    const page = (await urableCall(env, "GET", "/v1/products?limit=100&type=service" + (after ? "&startAfter=" + encodeURIComponent(after) : ""))) || [];
    out.push(...page);
    if (page.length < 100) break;
    after = page[page.length - 1].id;
  }
  return out;
}
// the shop's own service names in Urable: tint leads go on "Ceramic Tints", coating leads on the "1 Step Paint Correction and Ceramic Coating" package (plain name first, then the shortest variant)
const URABLE_PREFER = [[/tint/i, /ceramic.*tint/i], [/coat|ceramic pro|paint correction/i, /^1 step paint correction and ceramic coating/i]];
function preferredProduct(prods, service) {
  for (const [svc, name] of URABLE_PREFER) if (svc.test(service || "")) { const ms = prods.filter(x => name.test(String(x.name || "").trim()) && !/windshield|removal|remove|strip|repair/i.test(x.name)).sort((x, y) => String(x.name).length - String(y.name).length); if (ms[0]) return ms[0]; }
  return null;
}
// closest catalog service to what the lead asked for: shared words count, extra words and "removal/repair" services count against it, near price breaks ties
function rankProducts(prods, service, cents) {
  const want = words(service), bad = ["removal", "remove", "repair", "restoration", "install", "replacement", "windshield", "strip"];
  return prods.map(pr => {
    const w = words(pr.name), hit = want.filter(x => w.includes(x)).length;
    let sc = hit ? hit * 3 - w.filter(x => !want.includes(x)).length * 0.5 : 0;
    if (hit && w.some(x => bad.includes(x)) && !want.some(x => bad.includes(x))) sc -= 6;
    const price = Number(pr.prices && pr.prices[0] && pr.prices[0].value) || 0;
    return { pr, sc: sc > 0 && cents && price ? sc + 1 / (1 + Math.abs(price - cents) / 1000) : sc };
  }).filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc).map(x => x.pr);
}
async function urableSync(env, id, event, opts = {}) {
  if (!env.URABLE_API_KEY || !env.DB) return;
  const l = await env.DB.prepare("SELECT id, stage, name, email, phone, service, make, year, model, value, notes, appt_at, urable_ref, urable_kind FROM leads WHERE id = ?").bind(id).first();
  if (!l) return;
  const log = reason => env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?,?,?,?,?)").bind(id, l.stage, l.stage, reason, "system").run().catch(() => {});
  try {
    const at = l.appt_at ? etLocalToUtc(l.appt_at) : null;
    const start = at ? at.getTime() : 0, end = start ? start + urableHours(env, l.service) * 3600000 : 0;
    // already in Urable: only move the time
    if (l.urable_ref) {
      if (start) { await urableCall(env, "PATCH", `/v1/${l.urable_kind === "event" ? "events" : "jobs"}/${l.urable_ref}`, { start, end }); await log("Urable: appointment time updated"); }
      return;
    }
    const nm = String(l.name || "").trim().split(/\s+/), first = nm[0] || "Lead", last = nm.slice(1).join(" ");
    const veh = [l.year, l.make, l.model].filter(Boolean).join(" ") || "Vehicle";
    // customer: match on email, else create
    let cid = null;
    if (l.email) { const m = await urableCall(env, "GET", "/v1/customers?email=" + encodeURIComponent(l.email)); cid = Array.isArray(m) && m[0] && m[0].id; }
    if (!cid) cid = (await urableCall(env, "POST", "/v1/customers", { type: "person", status: "new", firstName: first, lastName: last, emails: l.email ? [{ label: "main", value: l.email }] : [], phoneNumbers: l.phone ? [{ label: "mobile", value: e164(l.phone) }] : [], origin: "Divine Detailers CRM", notes: `Vehicle: ${veh}\n${l.notes || ""}`.trim() })).id;
    // best matching service in the Urable catalog
    const prods = await urableCatalog(env).catch(() => []);
    const best = (opts.productId && prods.find(x => x.id === opts.productId)) || preferredProduct(prods, l.service) || rankProducts(prods, l.service, Math.round((Number(l.value) || 0) * 100))[0] || null;
    const title = `${l.service || "Booking"}: ${l.name || prettyPhone(l.phone)} (${veh})`;
    const cents = Math.round((Number(l.value) || 0) * 100);
    const desc = [`Service: ${l.service || "n/a"}`, `Vehicle: ${veh}${l.year || l.make || l.model ? ` (Year ${l.year || "?"}, Make ${l.make || "?"}, Model ${l.model || "?"})` : ""}`, `Customer: ${l.name || "n/a"}, ${prettyPhone(l.phone)}${l.email ? ", " + l.email : ""}`, cents ? `Price: $${(cents / 100).toLocaleString("en-US")}` : "", l.appt_at ? `Appointment: ${l.appt_at.replace("T", " ")} (Eastern)` : "", l.notes ? `Notes: ${l.notes}` : "", `Booked from the CRM: ${crmLink(env, "", "/admin/pipeline#id=" + id)}`].filter(Boolean).join("\n");
    if (best) {
      let iid = null;
      const its = (await urableCall(env, "GET", "/v1/items?customerId=" + cid).catch(() => [])) || [];
      const hit = its.find(x => String(x.name || "").toLowerCase() === veh.toLowerCase()); iid = hit && hit.id;
      if (!iid) iid = (await urableCall(env, "POST", "/v1/items", { customerId: cid, industry: "vehicleCare", type: "automotive", name: veh, notes: `Year: ${l.year || ""}\nMake: ${l.make || ""}\nModel: ${l.model || ""}` })).id;
      const job = { customerId: cid, industry: "vehicleCare", itemIds: [iid], type: "shop", status: "scheduled", name: title, lineItems: [{ productServiceId: best.id, quantity: 1 }], notes: desc, autoTax: false };
      // the CRM job value is the price: adjust the Urable service price up or down to land exactly on it
      const base = Number(best.prices && best.prices[0] && best.prices[0].value) || 0;
      if (cents && cents !== base) job.adjustments = [cents > base ? { type: "fee", name: "Quoted price", value: cents - base, taxable: false } : { type: "discount", name: "Quoted price", value: base - cents }];
      if (start) { job.start = start; job.end = end; }
      const made = await urableCall(env, "POST", "/v1/jobs", job);
      await env.DB.prepare("UPDATE leads SET urable_ref = ?, urable_kind = 'job' WHERE id = ?").bind(made.id, id).run();
      await log(`Urable: job #${made.num || ""} created (${best.name})${start ? "" : ", no time yet"}`);
    } else if (start) {
      const made = await urableCall(env, "POST", "/v1/events", { type: "other", name: title, customerId: cid, start, end, notes: desc });
      await env.DB.prepare("UPDATE leads SET urable_ref = ?, urable_kind = 'event' WHERE id = ?").bind(made.id, id).run();
      await log("Urable: calendar event created (no matching service in your Urable catalog)");
    } else await log("Urable: customer saved. No calendar entry yet: pick an appointment time");
  } catch (e) { console.error("urable sync error", e && e.message); await log("Urable sync failed: " + String(e && e.message).slice(0, 200)); }
}
const afterBooked = (env, id, event, opts) => Promise.all([bookedHook(env, id, event), urableSync(env, id, event, opts)]);

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
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Call ${esc(label)}</title>
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
      push: { title: "New Lead Incoming", message: [lead.name, lead.service, veh].filter(Boolean).join(", "), click: lead.id ? crmLink(env, base, `/admin/pipeline#id=${lead.id}`) : crmLink(env, base, "/admin/today") } }));
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

async function notifyCall(env, row, base, slack = true) {
  const missed = row.answered === 0;
  const status = row.answered === null || row.answered === undefined ? "ringing" : missed ? (/voicemail/i.test(row.message || "") ? "voicemail" : "missed") : "answered";
  const vm = status === "voicemail";
  const who = row.name || row.phone;
  const src = [row.utm_source, row.utm_campaign].filter(Boolean).join(" · ");
  const link = crmLink(env, base, "/admin/today");
  const head = { ringing: "INCOMING CALL", answered: "CALL ANSWERED", voicemail: "VOICEMAIL", missed: "MISSED CALL" }[status];
  const text = `${head} from ${who}${who !== row.phone ? ` (${prettyPhone(row.phone)})` : ""}${src ? " via " + src : ""}.${missed ? " Call them back now." : ""} ${link}`.replace(/\s+/g, " ").trim();
  const jobs = [];
  // every call goes to the chat webhook (Zapier to Slack) once, as soon as the call is first seen: just "NEW LEAD: Incoming call"
  if (slack && (env.CALL_WEBHOOK_URL || env.LEAD_WEBHOOK_URL)) jobs.push(fetch(env.CALL_WEBHOOK_URL || env.LEAD_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "call", call_status: status, ...row, text: "NEW LEAD: Incoming call", alert_text: text, crm_link: link, phone_e164: e164(row.phone), phone_display: prettyPhone(row.phone), call_link: goLink(env, base, row.id, row.phone) }) }).catch(() => {}));
  // a call coming in is a new lead: phones get "New Lead Incoming" as soon as it is first seen (missed calls have their own alert below)
  if (slack && !missed) jobs.push(sendPush(env, { title: "New Lead Incoming", message: ["Phone call", who !== row.phone ? who : prettyPhone(row.phone), src].filter(Boolean).join(", "), click: row.id ? crmLink(env, base, `/admin/pipeline#id=${row.id}`) : link }).catch(() => {}));
  // phone and email alerts stay for missed calls only
  if (missed) {
    const html = `<p style="font-size:16px"><b>${vm ? "Voicemail" : "Missed call"}: ${esc(who)}</b>${src ? " &middot; " + esc(src) : ""}</p>
    <p><a href="tel:${esc(row.phone)}" style="background:#32cd32;color:#04120a;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:700">Call back ${esc(row.phone)}</a>
    &nbsp; <a href="${esc(link)}">Open today's list</a></p>${row.recording ? `<p><a href="${esc(row.recording)}">Listen to the recording</a></p>` : ""}`;
    jobs.push(alertTeam(env, { subject: `${vm ? "Voicemail" : "Missed call"}: ${who}`, text, html,
      push: { title: `${vm ? "Voicemail" : "Missed call"}: ${who}`, message: [row.phone, src].filter(Boolean).join(" | ") + ". Call them back.", click: link } }));
  }
  await Promise.all(jobs);
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
  let pw = passwordOf(env, user);
  if (!/^\d{10,}$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  if (!pw && !Object.hasOwn(USERS, user)) { const u = await dbUser(env, user); pw = u ? u.hash : ""; }
  if (!pw) return false;
  return same(sig, await sign(pw, user + "|" + exp)) ? user : false;
}
const safeNext = n => (typeof n === "string" && /^\/(?!\/)[\w\-./?=&%#]*$/.test(n) && !n.startsWith("/login") ? n : "/");
const loginHtml = (err, next, user = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Sign in | Divine Detailers</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07090c;color:#e8eaed;font:16px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;padding:20px}
.box{width:min(380px,100%);background:#0d1116;border:1px solid #1d2229;border-radius:18px;padding:28px 24px;display:flex;flex-direction:column;gap:16px}
h1{margin:0;font-size:22px}h1 b{color:#32cd32}p{margin:0;color:#8a9099;font-size:14px}label{display:block;color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:6px}
input{width:100%;background:#12171e;border:1px solid #2a313a;color:#fff;border-radius:12px;padding:14px;font:inherit;min-height:50px}input:focus{outline:2px solid #32cd32;outline-offset:1px}
button{background:#32cd32;border:0;color:#04120a;border-radius:12px;padding:14px;font:inherit;font-weight:700;min-height:50px;cursor:pointer}.err{background:#3b1d1d;color:#ff9a9a;border-radius:10px;padding:10px 12px;font-size:14px}</style></head>
<body><form class="box" method="post" action="/login"><h1>Divine Detailers <b>CRM</b></h1><p>Sign in to see your leads.</p>${err ? `<div class="err" role="alert">${esc(err)}</div>` : ""}
<div><label for="u">Username</label><input id="u" name="username" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="text" value="${esc(user)}" ${user ? "" : "autofocus"} required></div>
<div><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" ${user ? "autofocus" : ""} required><label style="display:flex;align-items:center;gap:8px;margin:8px 0 0;text-transform:none;letter-spacing:0;font-size:13px;color:#8a9099;cursor:pointer"><input type="checkbox" style="width:auto;min-height:0" onchange="document.getElementById('p').type=this.checked?'text':'password'"> Show password</label></div><input type="hidden" name="next" value="${esc(next || "/")}"><button type="submit">Sign in</button></form></body></html>`;
const htmlRes = (body, status = 200, extra = {}) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...extra } });
async function loginRoute(p, request, env) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  if (p === "/logout") return new Response(null, { status: 302, headers: { location: "/login", "set-cookie": `dd_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`, "cache-control": "no-store" } });
  if (!anyPassword(env)) return new Response("Sign in is not set up yet. Add the PASSWORD_GIORDANI and PASSWORD_BRONSON secrets.", { status: 503 });
  const url = new URL(request.url);
  if (request.method !== "POST") return htmlRes(loginHtml("", safeNext(url.searchParams.get("next"))));
  const form = await request.formData().catch(() => null);
  const next = safeNext(form && form.get("next"));
  const pass0 = String((form && form.get("password")) || ""), pass = pass0.trim(); // phone keyboards often add a space after a word
  const user = String((form && form.get("username")) || "").trim().toLowerCase();
  // slow down guessing: 8 failures per 15 minutes per address
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (env.DB) {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS login_fails (ip TEXT, at INTEGER)").run();
    const since = Math.floor(Date.now() / 1000) - 900;
    const r = await env.DB.prepare("SELECT COUNT(*) n FROM login_fails WHERE ip = ? AND at > ?").bind(ip, since).first();
    if (r && r.n >= 8) return htmlRes(loginHtml("Too many tries. Wait a few minutes and try again.", next), 429);
  }
  let pw = passwordOf(env, user), ok = !!pw && (same(pass, pw) || same(pass0, pw));
  if (!pw && !Object.hasOwn(USERS, user)) { const u = await dbUser(env, user); if (u) { ok = same(await hashPw(pass, u.salt), u.hash); pw = u.hash; } }
  if (!ok) {
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
const FOLLOW_CSS = `.rdlg{background:#0f1319;color:#e8eaed;border:1px solid #2a313a;border-radius:16px;padding:0;width:min(480px,calc(100vw - 24px));max-height:92vh;max-height:calc(100dvh - 24px);overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;box-sizing:border-box}.rdlg *{box-sizing:border-box;min-width:0}.rdlg::backdrop{background:rgba(0,0,0,.7)}#bkdlg .rb{gap:10px;padding:16px 16px 0}#bkdlg input{min-height:44px;padding:10px 12px;max-width:100%;-webkit-appearance:none;appearance:none;display:block;text-align:left}#bkdlg input[type=datetime-local]{width:100%;font-size:16px;line-height:1.2}#bkdlg .ra{position:sticky;bottom:0;background:#0f1319;padding:10px 0 calc(12px + env(safe-area-inset-bottom,0px));margin-top:2px;border-top:1px solid #1d232b}#bkdlg .ra button{flex:1}#bkdlg #bkerr:empty{display:none}
.rdlg .rb{padding:18px 20px 20px;display:flex;flex-direction:column;gap:12px}.rdlg h3{margin:0;font-size:18px}.rdlg p{margin:0;color:#98a0aa;font-size:14px}.rdlg label{display:block;color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:4px}
.rdlg input{width:100%;background:#12171e;border:1px solid #2a313a;color:#fff;border-radius:10px;padding:12px;font:inherit;font-size:16px;min-height:48px;color-scheme:dark}
.fu-chips{display:flex;flex-wrap:wrap;gap:8px}.fu-chips button{padding:9px 13px;border-radius:12px;border:1px solid #2a313a;background:#12171e;color:#e8eaed;font:inherit;font-size:14px;cursor:pointer;min-height:44px;text-align:left}.fu-chips button small{display:block;color:#7c838d;font-size:11.5px}
.fu-chips button.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}.fu-chips button.on small{color:#0b3d12}.fu-chips button.mv{border-color:#4a3a2a}
.rdlg .ra{display:flex;gap:8px;justify-content:flex-end}.rdlg .ra button{border:1px solid #2a313a;background:#151a21;color:#e8eaed;border-radius:10px;padding:12px 16px;font:inherit;font-weight:700;cursor:pointer;min-height:46px}.rdlg .ra .ok{background:#32cd32;border-color:#32cd32;color:#04120a}.rdlg .ra .ok:disabled{opacity:.4;cursor:default}`;
const FOLLOW_HTML = `<dialog class="rdlg" id="rdlg"><div class="rb"><h3 id="rt"></h3><p id="rs"></p><div><label>Next step</label><div class="fu-chips" id="rg"></div></div><div><label>Follow up on (optional)</label><input id="rd" type="date"></div><div class="ra"><button type="button" id="rc">Skip</button><button type="button" class="ok" id="ro" disabled>Save</button></div></div></dialog>`
  + `<dialog class="rdlg" id="bkdlg"><div class="rb"><h3>Confirm the booking</h3><p id="bkn">Check the details, pick the appointment, and confirm the price.</p>
<div><label>Appointment date and time</label><input id="bkt" type="datetime-local"></div>
<div><label>Name</label><input id="bkn2" autocomplete="off"></div><div><label>Phone</label><input id="bkp" type="tel" inputmode="tel"></div><div><label>Email</label><input id="bke" type="email"></div>
<div><label>Service</label><input id="bks" autocomplete="off"></div>
<div id="bkqw" hidden><label>Urable service (shows as the job line item)</label><select id="bkq" style="width:100%;min-height:44px;background:#12171e;border:1px solid #2a313a;color:#fff;border-radius:10px;padding:10px 12px;font:inherit;font-size:16px;color-scheme:dark"></select></div>
<div style="display:grid;grid-template-columns:1fr 1.3fr 1.3fr;gap:8px"><div><label>Year</label><input id="bky" inputmode="numeric"></div><div><label>Make</label><input id="bkm"></div><div><label>Model</label><input id="bkd"></div></div>
<div><label>Job value ($) - this is the price sent to the calendar</label><input id="bkv" type="number" inputmode="numeric" min="0"></div>
<p id="bkerr" style="color:#ff8a8a;min-height:18px"></p><div class="ra"><button type="button" id="bkx">Cancel</button><button type="button" class="ok" id="bkok">Book it</button></div></div></dialog>`;
const FOLLOW_JS = `
const FU=${JSON.stringify(FOLLOWUPS)},STG=Object.fromEntries(${JSON.stringify(STAGES)});
function askBook(id,label,dt){return new Promise(async res=>{const d=document.getElementById('bkdlg');let l=null,uc=false,pr=[],bst='';
  try{const r=await fetch('/admin/leadinfo?id='+id);const j=await r.json();l=j.lead;uc=!!j.urable;pr=j.products||[];bst=j.best||''}catch(_){}
  if(!l){res(null);return}
  const f=(k,v)=>{document.getElementById('bk'+k).value=v==null?'':v};
  f('n2',l.name);f('p',l.phone);f('e',l.email);f('s',l.service);f('y',l.year);f('m',l.make);f('d',l.model);f('v',l.value||'');f('t',l.appt_at||dt||'');
  const qw=document.getElementById('bkqw'),qs=document.getElementById('bkq');qw.hidden=!pr.length;
  qs.innerHTML=(bst?'':'<option value="">Pick the Urable service</option>')+pr.map(x=>'<option value="'+x.id+'"'+(x.id===bst?' selected':'')+'>'+String(x.name).replace(/&/g,'&amp;').replace(/</g,'&lt;')+(x.price?' - $'+Math.round(x.price/100):'')+'</option>').join('');
  document.getElementById('bkn').textContent=uc?'Check the details, pick the appointment, and confirm the price. Saving adds this job to the Urable calendar.':'Check the details, pick the appointment, and confirm the price.';
  const err=document.getElementById('bkerr'),ok=document.getElementById('bkok');err.textContent='';ok.disabled=false;ok.textContent='Book it';
  let done=false;const fin=v=>{if(done)return;done=true;d.close();res(v)};
  ok.onclick=async()=>{const g=k=>document.getElementById('bk'+k).value.trim();
    if(!g('t')){err.textContent='Pick the appointment date and time.';return}
    if(!g('n2')&&!g('p')){err.textContent='Add a name or phone.';return}
    ok.disabled=true;ok.textContent='Saving...';
    try{const r=await fetch('/admin/book',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,label:label||'',name:g('n2'),phone:g('p'),email:g('e'),service:g('s'),year:g('y'),make:g('m'),model:g('d'),value:parseInt(g('v')||'0',10)||0,appt:g('t'),product_id:qs.value||''})});
      const j=await r.json().catch(()=>({}));if(!r.ok||!j.success){err.textContent=j.message||'Could not save. Try again.';ok.disabled=false;ok.textContent='Book it';return}
      fin(j)}catch(_){err.textContent='No connection. Try again.';ok.disabled=false;ok.textContent='Book it'}};
  document.getElementById('bkx').onclick=()=>fin(null);d.oncancel=()=>fin(null);d.showModal()})}
function askNext(name,stage,id){return new Promise(res=>{const d=document.getElementById('rdlg'),ok=document.getElementById('ro'),di=document.getElementById('rd'),g=document.getElementById('rg');let pick='';
  document.getElementById('rt').textContent='What is next for '+(name||'this lead')+'?';document.getElementById('rs').textContent='Now in: '+STG[stage]+'. Pick the next step, or skip.';
  g.innerHTML='';(FU[stage]||[]).forEach(([l,mv])=>{const b=document.createElement('button');b.type='button';if(mv)b.className='mv';b.innerHTML=l.replace(/&/g,'&amp;').replace(/</g,'&lt;')+(mv?'<small>moves to '+STG[mv]+'</small>':'');b.onclick=()=>{pick=l;g.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));ok.disabled=false};g.appendChild(b)});
  di.value='';di.oninput=()=>{ok.disabled=!pick&&!di.value};ok.disabled=true;let done=false;const fin=v=>{if(done)return;done=true;d.close();res(v)};
  ok.onclick=async()=>{const mv=((FU[stage]||[]).find(x=>x[0]===pick)||[])[1];if(mv==='booked'&&id){ok.disabled=true;d.close();const o=await askBook(id,pick);if(!o){res(null);return}done=true;res({followup:'',follow_date:di.value,booked:true});return}fin({followup:pick,follow_date:di.value})};document.getElementById('rc').onclick=()=>fin(null);d.oncancel=()=>fin(null);d.showModal()})}`;

// After someone taps Call, ask (when they come back to the CRM) whether the lead answered. This feeds the contact rate on the Speed page.
const OUTCOMES = [["Answered", "Answered"], ["No answer", "No answer"], ["Left a voicemail", "Voicemail"], ["Wrong number", "Wrong number"]];
// how a call ended (picked in the dialer after each call). stage = where the lead moves; talked = a real conversation happened; follow = ask for a callback day
const OUTCOME_RULES = {
  "Booked": { stage: "booked", talked: true, needs: "booking", clear: true }, "Deposit pending": { stage: "deposit", talked: true, next: "depositDays", what: "Collect deposit" }, "Callback": { stage: "interested", talked: true, follow: true },
  "Interested": { stage: "interested", talked: true, next: "talkedDays", what: "Follow up" }, "Quote sent": { stage: "quoted", talked: true, next: "talkedDays", what: "Follow up on quote" }, "Not interested": { stage: "lost", talked: true, needs: "reason", clear: true },
  "Answered": { talked: true, next: "talkedDays", what: "Follow up" }, "Lead hung up": { retry: true }, "Left a voicemail": { retry: true }, "No answer": { retry: true }, "Wrong number": { stage: "lost", clear: true, reason: "Wrong number" },
};
// ---- Disposition rulebook: what each call result means and what the system does about it
// reach = a real conversation happened. next = days until the next step is due (a lead in play always has one). needs = what must be filled in first.
const LOST_REASONS = ["Price too high", "Went elsewhere", "Not ready yet", "Changed their mind", "Other"];
const CALL_RULES = {
  maxTries: 6, // never-reached leads leave the automatic call list after this many calls
  retryDays: [0, 1, 1, 2, 3], // days until the next try after the 1st, 2nd, 3rd... call that did not reach them
  talkedDays: 2, depositDays: 1,
};
const KEEP_STAGES = ["booked", "working", "done"]; // a quick follow-up result never moves a booked or finished job backwards
const QUEUE_HTML = `<div id="qbar" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:0 18px 10px"></div>`;
const QUEUE_JS = `
(function(){const bar=document.getElementById('qbar');if(!bar)return;
const qe=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bs='border:1px solid #2a313a;border-radius:10px;padding:10px 14px;font:inherit;font-weight:700;cursor:pointer;';
async function get(){try{const r=await fetch('/admin/queue');return r.ok?await r.json():null}catch(_){return null}}
function draw(s){if(!s||s.disabled){bar.innerHTML='';bar.style.display='none';return}
  if(s.active){bar.innerHTML='<span style="color:#e8eaed"><b style="color:#32cd32">Calling queue</b> &middot; '+s.done+' of '+s.total+' done'+(s.now?' &middot; now: '+qe(s.now):' &middot; ringing your phone')+(s.next?' &middot; next: '+qe(s.next):'')+'</span><button id="qstop" type="button" style="'+bs+'background:#2a1414;color:#ff8a8a">Stop</button>';document.getElementById('qstop').onclick=async e=>{e.target.disabled=true;await fetch('/admin/queue/stop',{method:'POST'});refresh()};return}
  bar.innerHTML=(s.eligible?'<button id="qgo" type="button" style="'+bs+'background:#32cd32;color:#04120a">Start calling ('+s.eligible+')</button>':'')+(s.note?'<span style="color:#98a0aa">'+qe(s.note)+'</span>':'');
  const go=document.getElementById('qgo');if(go)go.onclick=async e=>{if(!confirm('Your phone will ring first. Press 1 to connect, and the next new lead is called when each call ends. Start calling '+s.eligible+' lead'+(s.eligible===1?'':'s')+'?'))return;e.target.disabled=true;const r=await fetch('/admin/queue/start',{method:'POST'});const j=await r.json().catch(()=>({}));if(!r.ok&&j.message)alert(j.message);refresh()}}
async function refresh(){draw(await get())}
refresh().then(()=>{if(location.hash==='#start'){const g=document.getElementById('qgo');if(g)g.click()}});const poll=setInterval(()=>{if(bar.style.display==='none'){clearInterval(poll);return}if(!document.hidden)refresh()},12000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});
})();`;
const OUTCOME_HTML = `<style>#odlg{position:fixed;inset:0;margin:auto;height:fit-content;z-index:60;box-shadow:0 0 0 100vmax rgba(0,0,0,.72)}</style><dialog class="rdlg" id="odlg"><div class="rb"><h3 id="ot"></h3><p>Did they pick up?</p><div class="fu-chips" id="og"></div><div class="ra"><button type="button" id="os">I did not make this call</button></div></div></dialog>`;
const OUTCOME_JS = `
const OUTC=${JSON.stringify(OUTCOMES)};
function pcq(){try{const a=JSON.parse(localStorage.getItem('dd_pcq')||'[]');return Array.isArray(a)?a:[]}catch(_){return []}}
function pcs(a){try{localStorage.setItem('dd_pcq',JSON.stringify(a))}catch(_){}}
function markCall(id,name){const a=pcq().filter(x=>x.id!==id);a.push({id:id,name:name||'this lead',t:Date.now()});pcs(a)}
function askOutcome(){const d=document.getElementById('odlg');if(!d||d.open)return;const now=Date.now();let a=pcq().filter(x=>now-x.t<=6*36e5);if(a.length!==pcq().length)pcs(a);
  const p=a.find(x=>now-x.t>=4000);if(!p)return;
  const done=()=>{pcs(pcq().filter(x=>x.id!==p.id));d.close();setTimeout(askOutcome,300)};
  document.getElementById('ot').textContent='Did '+p.name+' answer?';const g=document.getElementById('og');g.innerHTML='';
  OUTC.forEach(([v,l])=>{const b=document.createElement('button');b.type='button';b.textContent=l;b.onclick=async()=>{b.disabled=true;try{await fetch('/admin/outcome',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:p.id,outcome:v})})}catch(_){}done()};g.appendChild(b)});
  document.getElementById('os').onclick=done;try{d.show()}catch(_){}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)setTimeout(askOutcome,400)});window.addEventListener('focus',()=>setTimeout(askOutcome,400));window.addEventListener('pageshow',()=>setTimeout(askOutcome,600));setTimeout(askOutcome,800);
document.addEventListener('click',e=>{const a=e.target.closest('a[href^="tel:"]');if(!a)return;const h=a.closest('[data-id]');const id=(h&&+h.dataset.id)||window.DD_LEAD;if(!id)return;e.preventDefault();if((typeof IS_OWNER!=='undefined'&&IS_OWNER)||document.querySelector('a[href="/admin/dialer"]')){location.href='/admin/dialer?lead='+id;return}if(a.dataset.busy)return;a.dataset.busy='1';const t=a.textContent;a.textContent='Calling your phone...';
  fetch('/admin/dial',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})}).then(r=>r.json()).catch(()=>({})).then(j=>{if(j.success){a.textContent='Answer your phone and press 1';setTimeout(()=>{a.textContent=t;delete a.dataset.busy},15000)}else{a.textContent=t;delete a.dataset.busy;if(confirm((j.message||'Could not start the call.')+'\\n\\nCall without recording?'))location.href=a.getAttribute('href')}})},true);
`;

const stageName = k => (STAGES.find(x => x[0] === k) || [k, k])[1];
const crmPrefix = env => ""; // paths are the same on every host
const badge = n => (n ? `<i class="nb">${n > 99 ? "99+" : n}</i>` : "");
const OWNER = "bronson"; // only this login sees the Speed page
const SPEED_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5l3 2M9 2h6M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z"/></svg>';
// ---- the CRM as an app: installable on a phone's Home Screen, with notifications
const SW_JS = `self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(_){d={body:e.data?e.data.text():''}}
  e.waitUntil(self.registration.showNotification(d.title||'Divine Detailers',{body:d.body||'',icon:'/assets/crm-icon-192.png',badge:'/assets/crm-icon-192.png',data:{url:d.url||'/today'}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const u=(e.notification.data&&e.notification.data.url)||'/today';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{for(const c of cs){if('focus' in c){if(c.navigate)c.navigate(u);return c.focus()}}return self.clients.openWindow(u)}))});`;
const MANIFEST = { name: "Divine Detailers CRM", short_name: "DD CRM", start_url: "/today", scope: "/", display: "standalone", background_color: "#000000", theme_color: "#000000",
  icons: [{ src: "/assets/crm-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" }, { src: "/assets/crm-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }] };
const PWA_HEAD = `<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/assets/crm-icon-192.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="DD CRM"><meta name="theme-color" content="#000000">`;
const PUSH_NAV = `<style>.pushbtn{border:1px solid #2a313a;background:#151a21;color:#aab0b9;border-radius:999px;padding:7px 13px;font:inherit;font-size:13px;font-weight:700;cursor:pointer}.pushbtn[data-s=act]{background:#32cd32;border-color:#32cd32;color:#04120a}.pushbtn[data-s=on]{color:#7fe07f}.pushbtn[data-s=off],.pushbtn[data-s=help]{color:#ffb86b;border-color:#4d3a1d}</style><button type="button" id="rfbtn" class="pushbtn" aria-label="Refresh" title="Refresh">&#8635;</button><button type="button" id="pushbtn" class="pushbtn" hidden></button>
<script>(()=>{const b=document.getElementById('pushbtn');if(!b||window.__pushInit)return;window.__pushInit=1;
const standalone=(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||navigator.standalone;
const ios=/iphone|ipad|ipod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const ok='serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
const u8=s=>{s=s.replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(s+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0))};
const show=(t,c)=>{b.hidden=false;b.textContent=t;b.dataset.s=c};
async function sub(){let step='checking the app file';try{const t=await fetch('/sw.js',{cache:'no-store'}).catch(()=>null);if(!t||!t.ok||t.redirected||!/javascript/.test(t.headers.get('content-type')||''))throw new Error('the app file could not be loaded from '+location.host+(t?' (status '+t.status+(t.redirected?', redirected':'')+')':' (no connection)'));
  step='registering the app';const r=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
  step='getting the notification key';const kr=await fetch('/admin/push/key');if(!kr.ok)throw new Error('server said '+kr.status);const k=await kr.json();
  step='asking the phone to allow notifications';let s=await r.pushManager.getSubscription();if(!s)s=await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:u8(k.key)});
  step='saving this phone';const j=s.toJSON();const res=await fetch('/admin/push/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:j.endpoint,keys:j.keys})});if(!res.ok)throw new Error('server said '+res.status)}catch(e){throw new Error('while '+step+' on '+location.host+': '+((e&&e.message)||e))}}
async function refresh(){
  if(!ok){if(ios&&!standalone)show('Get alerts: add to Home Screen','help');return}
  if(Notification.permission==='denied'){show('Alerts blocked','off');return}
  if(Notification.permission==='granted'){let t=0;try{t=+localStorage.getItem('dd_push_ok')||0}catch(_){}
    if(Date.now()-t<864e5){show('Alerts on','on');return}
    try{await sub();try{localStorage.setItem('dd_push_ok',String(Date.now()))}catch(_){}show('Alerts on','on')}catch(_){show('Enable alerts','act')}return}
  show('Enable alerts','act')}
b.onclick=async()=>{const s=b.dataset.s;
  if(s==='help'){alert('To get alerts on an iPhone: tap the Share button, choose Add to Home Screen, then open the app from your Home Screen and tap Enable alerts.');return}
  if(s==='off'){alert('Alerts are blocked for this app. Turn them on in your phone Settings under Notifications, then reopen the app.');return}
  if(s==='on'){const r=await fetch('/admin/push/test',{method:'POST'});const j=await r.json().catch(()=>({}));b.textContent=j.sent?'Test sent':'No device found';setTimeout(refresh,2500);return}
  try{const p=await Notification.requestPermission();if(p==='granted'){await sub();show('Alerts on','on');fetch('/admin/push/test',{method:'POST'})}else refresh()}catch(e){alert('Could not turn on alerts: '+((e&&e.message)||e))}};
refresh()})();</script>
<script>(function(){var rf=document.getElementById('rfbtn');function go(){var t=document.createElement('div');t.textContent='Refreshing...';t.style.cssText='position:fixed;top:calc(env(safe-area-inset-top,0px) + 8px);left:50%;transform:translateX(-50%);background:#32cd32;color:#04120a;font:700 13px system-ui;padding:7px 14px;border-radius:999px;z-index:99';document.body.appendChild(t);location.reload()}
if(rf)rf.onclick=go;
var hiddenAt=0;document.addEventListener('visibilitychange',function(){if(document.hidden){hiddenAt=Date.now();return}var a=document.activeElement;if(hiddenAt&&Date.now()-hiddenAt>300000&&!document.querySelector('dialog[open]')&&!(a&&/^(INPUT|TEXTAREA)$/.test(a.tagName))){var last=0;try{last=+sessionStorage.getItem('dd_rl')||0}catch(_){}if(Date.now()-last<60000)return;try{sessionStorage.setItem('dd_rl',String(Date.now()))}catch(_){}setTimeout(function(){if(navigator.onLine!==false)location.reload()},1200)}});
window.addEventListener('pageshow',function(e){if(e.persisted)setTimeout(function(){location.reload()},600)});
var y0=null;document.addEventListener('touchstart',function(e){y0=null;if(window.scrollY>0||e.touches.length!==1)return;if(e.target.closest&&e.target.closest('dialog,.msgs,.board,textarea,input,select'))return;y0=e.touches[0].clientY},{passive:true});
document.addEventListener('touchmove',function(e){if(y0==null)return;if(e.touches[0].clientY-y0>120&&window.scrollY<=0){y0=null;go()}},{passive:true});
document.addEventListener('touchend',function(){y0=null},{passive:true});})();</script>`;
function nav(on, n = 0, owner = false) {
  const ins = ["insights", "speed", "rate", "playbook", "msgstats", "dials", "meta", "numbers"].includes(on), t = (href, key, label, extra = "") => `<a href="${href}" class="${on === key ? "on" : ""}">${label}${extra}</a>`;
  return `<nav class="navtabs">${t("/admin/dashboard", "dashboard", "Dashboard")}${t("/admin/today", "today", "Today", badge(n))}${t("/admin", "leads", "Leads")}${t("/admin/pipeline", "pipeline", "Pipeline")}${t("/admin/messages", "messages", "Messages", '<i class="nb unr" hidden></i>')}${t("/admin/dialer", "dialer", "Dial")}${t("/admin/calendar", "calendar", "Calendar")}${t("/admin/automations", "automations", "Automations")}<a href="/admin/insights" class="${ins ? "on" : ""}">Reports</a><a href="/admin/users" class="so ${on === "users" ? "on" : ""}">Logins</a><a href="/logout" class="so">Sign out</a></nav><script>if(window.top!==window.self){document.documentElement.classList.add("emb");document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest('a[href^="/admin/dialer"]');if(a){e.preventDefault();parent.postMessage({ddgo:a.getAttribute("href")},location.origin)}},true)}</script>${PUSH_NAV}`;
}
// one Insights section: overview, speed to lead and contact rate share this tab bar
const insightTabs = on => `<div class="itabs">${[["insights", "/admin/insights", "Overview"], ["meta", "/admin/meta", "Meta Ads"], ["dials", "/admin/dials", "Dials"], ["numbers", "/admin/numbers", "Number health"], ["speed", "/admin/speed", "Speed to lead"], ["rate", "/admin/rate", "Contact rate"], ["playbook", "/admin/playbook", "Playbook"], ["msgstats", "/admin/msgstats", "Messages"], ["ads", "/admin/ads", "Google Ads upload"]].map(([k, h, l]) => `<a href="${h}" class="${on === k ? "on" : ""}">${l}</a>`).join("")}</div>`;
// phone: thumb-reach tab bar fixed to the bottom of the screen
function bnav(on, n = 0, owner = false) {
  const ic = {
    today: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM9 9l2 2 4-4M9 15h6"/></svg>',
    leads: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    pipeline: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z"/></svg>',
    texts: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>',
    rate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V10M12 20V4M19 20v-7"/></svg>',
    missed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4l16 16M7 7c-1 3 0 6 3 9s6 4 9 3"/></svg>',
    insights: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19h16M6 15l4-5 3 3 5-7"/></svg>',
    out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H5v16h4M15 8l4 4-4 4M19 12H9"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v15H5zM5 10h14M9 3v4M15 3v4"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3L5 14h6l-1 7 8-11h-6z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>',
  };
  const tab = (href, key, label, extra = "") => `<a href="${href}" class="${on === key ? "on" : ""}">${ic[key]}${label}${extra}</a>`;
  const moreKeys = ["speed", "rate", "msgstats", "dials", "meta", "numbers", "insights", "calendar", "automations", "dialer"];
  const row = (href, key, label, svg) => `<a href="${href}" class="${on === key ? "on" : ""}">${svg}${label}</a>`;
  return `<nav class="bnav" aria-label="Sections">${tab("/admin/today", "today", "Today", badge(n))}${tab("/admin", "leads", "Leads")}${tab("/admin/pipeline", "pipeline", "Pipeline")}<a href="/admin/messages" class="${on === "messages" ? "on" : ""}">${ic.texts}Texts<i class="nb unr" hidden></i></a><button type="button" id="morebtn" class="${moreKeys.includes(on) ? "on" : ""}">${ic.more}More</button></nav>
<div class="msheet" id="msheet"><div class="bd"></div><div class="sh"><div class="grab"></div>${row("/admin/dashboard", "dashboard", "Dashboard", ic.rate)}${row("/admin/dialer", "dialer", "Dial", ic.phone)}${row("/admin/calendar", "calendar", "Calendar", ic.calendar)}${row("/admin/automations", "automations", "Automations", ic.bolt)}${row("/admin/insights", "insights", "Reports", ic.insights)}${row("/admin/users", "users", "Logins", ic.out)}${row("/logout", "out", "Sign out", ic.out)}</div></div>
<script>(function(){var els=document.querySelectorAll('.unr');function go(){fetch('/admin/unread').then(function(r){return r.ok?r.json():null}).then(function(j){if(!j)return;els.forEach(function(e){e.textContent=j.n>99?'99+':j.n;e.hidden=!j.n})}).catch(function(){})}go();setInterval(function(){if(!document.hidden)go()},30000);
var m=document.getElementById('msheet'),b=document.getElementById('morebtn');if(m&&b){b.onclick=function(){m.classList.add('open')};m.querySelector('.bd').onclick=function(){m.classList.remove('open')}}})();</script>`;
}
// review requests use a link on our own domain (it forwards to Google), which is what carriers expect for links in registered texts
const reviewLink = env => (env.GOOGLE_REVIEW_URL ? `${env.PUBLIC_URL || "https://divinedetailers.com"}/review` : "");
const cfgOf = env => ({ shop: SHOP.name, phone: SHOP.phone, address: SHOP.address, review: reviewLink(env) });
const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
async function todayCount(env) {
  try {
    await ensureTable(env.DB);
    const r = await env.DB.prepare("SELECT COUNT(*) n FROM leads WHERE type != 'newsletter' AND created_at >= datetime('now','-24 hours') AND (stage IN ('new','nocontact') OR (COALESCE(follow_up_date,'') != '' AND follow_up_date <= ? AND stage NOT IN ('done','lost')))").bind(todayStr()).first();
    return r ? r.n : 0;
  } catch { return 0; }
}
const BNAV_CSS = `/* Divine Detailers design system: dark tokens shared by every page */
:root{--bg:#07090c;--bg2:#0a0d11;--panel:#0d1116;--panel2:#10151b;--line:#1b2128;--line2:#232b34;--text:#e8eaed;--mut:#8a939e;--dim:#6b727c;--accent:#32cd32;--accent2:#4fdc5a;--accent-bg:#0f2c18;--accent-line:#1f6a37;--warn:#ffb86b;--bad:#ff7a7a;--info:#8ec0ff;--r:14px}
html{scrollbar-color:#2a323b #0a0d11;scrollbar-width:thin}::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:#242c35;border-radius:8px;border:2px solid #0a0d11}::-webkit-scrollbar-track{background:transparent}
:focus-visible{outline:2px solid #32cd32;outline-offset:2px}::selection{background:#1f6a37;color:#fff}button,a{-webkit-tap-highlight-color:transparent}select,input,textarea{color-scheme:dark}
header{border-bottom-color:var(--line)!important}
article.lead[hidden]{display:none!important}.bnav,.msheet{display:none}.itabs{display:flex;gap:6px;flex-wrap:wrap;padding:14px 22px 0;max-width:1100px;margin:0 auto}.itabs a{color:#9aa1ab;text-decoration:none;font-weight:600;font-size:14px;padding:8px 16px;border-radius:999px;border:1px solid #232932;background:#0d1116}.itabs a.on{background:#112417;border-color:#1f6a37;color:#32cd32}@media(max-width:700px){.itabs{padding:10px 14px 0}}.nb{font-style:normal;background:#ff5d5d;color:#fff;border-radius:999px;font-size:11px;font-weight:700;padding:1px 7px;margin-left:6px}.nb[hidden]{display:none}.navtabs a.on .nb{background:#04120a;color:#32cd32}
@media(min-width:1024px){
  body{padding-left:228px}
  .navtabs{position:fixed;left:0;top:0;bottom:0;width:228px;z-index:25;display:flex!important;flex-direction:column;flex-wrap:nowrap!important;gap:2px!important;padding:74px 12px 16px;background:#090c10;border-right:1px solid #1d2229;overflow-y:auto}
  .navtabs::before{content:"Divine Detailers";position:absolute;left:0;right:0;top:0;height:62px;display:flex;align-items:center;padding:0 20px;font-weight:800;font-size:16px;letter-spacing:.2px;color:#e8eaed}
  .navtabs a{display:flex!important;align-items:center;gap:8px;position:relative;padding:11px 14px!important;border:0!important;border-radius:10px!important;color:#9aa1ab!important;font-weight:600;font-size:14.5px;background:none!important}
  .navtabs a:hover{background:#10151b!important;color:#e8eaed!important}
  .navtabs a.on{background:#112417!important;color:#32cd32!important}
  .navtabs a.on::before{content:"";position:absolute;left:-12px;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:#32cd32}
  .navtabs a.so{margin-top:auto;color:#6b727c!important}
  .navtabs a.so+a.so{margin-top:0}
  .navtabs .nb{margin-left:auto}
  header{padding-left:26px!important;min-height:64px;justify-content:flex-end!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}header>h1{margin-right:auto}
  .emb body{padding-left:0}
}
.emb .navtabs,.emb .bnav,.emb .msheet,.emb #rfbtn,.emb .pushbtn{display:none!important}.emb body{padding-left:0!important;padding-bottom:0!important}
@media(max-width:700px){
  .navtabs{display:none!important}
  .bnav{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:30;background:#0a0d11;border-top:1px solid #1d2229;padding:0 6px calc(4px + env(safe-area-inset-bottom,0px));gap:2px}
  .bnav a,.bnav button{flex:1;min-width:0;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:10px 0 8px;margin:0;border:0;background:none;color:#7c838d;text-decoration:none;font:inherit;font-size:11px;font-weight:600;min-height:58px;cursor:pointer;-webkit-tap-highlight-color:transparent}
  .bnav a.on,.bnav button.on{color:#32cd32}.bnav a.on::before,.bnav button.on::before{content:"";position:absolute;top:0;left:50%;width:24px;height:3px;margin-left:-12px;border-radius:0 0 3px 3px;background:#32cd32}
  .bnav svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.bnav svg circle{fill:currentColor;stroke:none}
  .bnav .nb{position:absolute;top:6px;left:calc(50% + 7px);margin:0;min-width:17px;height:17px;line-height:17px;padding:0 5px;text-align:center;font-size:10.5px;background:#ff5d5d;color:#fff}
  .msheet.open{display:block;position:fixed;inset:0;z-index:40}.msheet .bd{position:absolute;inset:0;background:rgba(0,0,0,.62)}
  .msheet .sh{position:absolute;left:0;right:0;bottom:0;background:#0f1319;border-top:1px solid #232932;border-radius:20px 20px 0 0;padding:10px 14px calc(16px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:2px}
  .msheet .grab{width:40px;height:4px;border-radius:2px;background:#2a313a;margin:2px auto 8px}
  .msheet a{display:flex;align-items:center;gap:16px;padding:15px 10px;border-radius:12px;color:#e8eaed;text-decoration:none;font-size:17px;font-weight:600}.msheet a.on{color:#32cd32}.msheet a:active{background:#151a21}
  .msheet svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;color:#7c838d}.msheet a.on svg{color:#32cd32}
  body{padding-bottom:calc(80px + env(safe-area-inset-bottom,0px))}
}`;

// one-tap replies. Merge fields: {first} {service} {vehicle} {shop} {phone} {address} {review}
const TEMPLATES = [
  { id: "first", label: "First reply", subject: "Your ceramic tint request at {shop}", body: "Hey {first}, this is {shop}. Thanks for requesting a quote for ceramic tint for {vehicle}.\n\nOur tint keeps your ride cooler, protected and more private, with a clean, factory look. When would you like to get it done?" },
  { id: "first_coating", label: "First reply (ceramic coating)", subject: "Your ceramic coating request at {shop}", body: "Hey {first}, this is {shop}. Thanks for requesting a quote for ceramic coating for {vehicle}.\n\nOur ceramic coating adds a deep, glossy finish, protects your paint and makes every wash easier. When would you like to get it done?" },
  { id: "scheduled", label: "Scheduled", subject: "Your appointment with {shop}", body: "Hi {first}, you are scheduled! Your {service} appointment for {vehicle} is set for {appointment}. We are at {address}. Reply here if you need to change anything." },
  { id: "reminder", label: "Appointment reminder", subject: "Reminder: your appointment with {shop}", body: "Hi {first}, a quick reminder about your {service} appointment for {vehicle} on {appointment}. We are at {address}. See you then!" },
  { id: "fu2", label: "Follow-up #2", subject: "Following up on your {service} request", body: "Hey {first}, it's {shop} following up about {service} for {vehicle}. Are you still interested? I can get you on the schedule this week." },
  { id: "fu3", label: "Follow-up #3", subject: "Checking in on your {service}", body: "Hi {first}, just checking in on your {service}. We have openings coming up. What day works best for you?" },
  { id: "fu4", label: "Follow-up #4", subject: "Did you get my messages?", body: "Hey {first}, I haven't heard back so I wanted to make sure you got my messages. Happy to answer any questions about the {service} for {vehicle}." },
  { id: "fu5", label: "Follow-up #5 (last)", subject: "Last follow-up from {shop}", body: "Hi {first}, last follow-up from {shop}. If you're still thinking about {service}, just reply here and we'll take care of you. Otherwise no worries!" },
  { id: "missed", label: "Sorry we missed your call", subject: "Sorry we missed your call", body: "Hi {first}, sorry we missed your call! This is {shop}. What can we help you with? Reply here or call us back at {phone}." },
  { id: "quote", label: "Quote follow-up", subject: "Following up on your {service} quote", body: "Hi {first}, just following up on the {service} quote for {vehicle}. Any questions I can answer? Happy to get you on the schedule." },
  { id: "invoice", label: "Invoice sent", subject: "Your invoice from {shop}", body: "Hi {first}, your invoice for {service} on {vehicle} is on its way. Let us know when you have seen it and we will lock in your date." },
  { id: "booked", label: "Booking confirmed", subject: "You are booked with {shop}", body: "Hi {first}, you are booked for {service} on {vehicle}. We are at {address}. Text us here if anything changes." },
  { id: "ready", label: "Ready for pickup", subject: "Your vehicle is ready", body: "Hi {first}, your {vehicle} is ready for pickup at {shop}, {address}. We are open Mon to Sat, 9 AM to 6 PM." },
  { id: "review", label: "Ask for a review", subject: "How did we do?", body: "Hi {first}, thank you for trusting {shop} with your {vehicle}! If you are happy with the work, a quick Google review helps a lot: {review}" },
  { id: "checkin", label: "Checking in", subject: "Checking in", body: "Hi {first}, just checking in. Still thinking about {service}? Glad to answer any questions." },
];
// which templates to suggest first, by stage
const TPL_BY_STAGE = { new: ["first", "missed"], contacted: ["quote", "scheduled", "checkin"], quoted: ["quote", "scheduled", "invoice", "checkin"], booked: ["reminder", "scheduled", "booked"], working: ["ready"], done: ["review"], aged: ["first", "checkin"], lost: ["checkin"] };
const TPL_JS = `
const TPL=${JSON.stringify(TEMPLATES)},TBS=${JSON.stringify(TPL_BY_STAGE)};
function tplFill(t,l,appt){const veh=[l.year,l.make,l.model].filter(Boolean).join(' ')||'your vehicle',first=(l.name||'').trim().split(/\\s+/)[0];
  const v={first:first&&!/^\\+?[\\d\\s()-]+$/.test(first)?first:'there',service:(l.service||'our services').toLowerCase(),vehicle:/your/.test(veh)?veh:'your '+veh,shop:CFG.shop,phone:CFG.phone,address:CFG.address,review:CFG.review||'',appointment:appt||'[pick a date and time]'};
  const f=x=>x.replace(/\\{(\\w+)\\}/g,(m,k)=>v[k]===undefined?m:v[k]).replace(/[ \\t]+/g,' ').replace(/ ?\\n ?/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim();return {subject:f(t.subject).replace(/\\s+/g,' '),body:f(t.body)}}
function tplFor(l){const fr=/coating/i.test(l.service||'')?'first_coating':'first';const ids=((l.type==='call'&&l.answered===0&&l.stage==='new')?['missed','first']:(TBS[l.stage]||['first'])).map(i=>i==='first'?fr:i);return ids.map(i=>TPL.find(t=>t.id===i)).filter(Boolean).concat(TPL.filter(t=>!ids.includes(t.id)))}
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
const hasClick = l => !!(l && (l.gclid || l.gbraid || l.wbraid));
// the shop login never sees where a lead came from: campaign, ad, keyword, landing page, form name and click ids are blanked before the page is built
const AD_LINE = /^(form name|ad name|adset name|platform|campaign|keyword)\s*:/i;
const noAds = l => ({
  ...l, recording: "", page: "", referrer: "", gclid: "", gbraid: "", wbraid: "", utm_source: "", utm_medium: "", utm_campaign: "", utm_term: "",
  message: String(l.message || "").split("\n").map(line => line.split(" · ").filter(seg => !AD_LINE.test(seg.trim())).join(" · ")).filter(x => x.trim()).join("\n"),
});
function sourceOf(l) {
  if (l.type === "call" && !hasClick(l) && l.utm_medium !== "cpc") {
    const g = /google ads|adwords|ppc|paid/i.test(l.utm_source || "");
    return { label: g ? "Google Ads" : (l.utm_source || "Phone call"), ad: g, detail: [l.utm_campaign, l.utm_term].filter(Boolean).join(" · ") };
  }
  if (hasClick(l) || l.utm_medium === "cpc") return { label: "Google Ads", ad: true, detail: [l.utm_campaign, l.utm_term].filter(Boolean).join(" · ") };
  if (l.utm_medium === "paid_social") return { label: "Meta Ads", ad: true, detail: [l.utm_campaign, l.utm_term].filter(Boolean).join(" · ") };
  if (l.utm_source) return { label: l.utm_source, ad: false, detail: l.utm_campaign || "" };
  if (l.referrer) { try { return { label: new URL(l.referrer).hostname.replace(/^www\./, ""), ad: false, detail: "" }; } catch { /* ignore */ } }
  return { label: "Direct", ad: false, detail: "" };
}

async function adminPage(env, user = "") {
  await ensureTable(env.DB);
  const own = user === OWNER;
  const [tc, rs] = await Promise.all([todayCount(env), env.DB.prepare("SELECT * FROM leads ORDER BY created_at DESC, id DESC LIMIT 300").all()]);
  const results = own ? rs.results : rs.results.map(noAds);
  const cutoff = new Date(Date.now() - 864e5).toISOString().slice(0, 19).replace("T", " ");
  const notContacted = results.filter(l => isNewish(l.stage) && l.type !== "newsletter" && (!own || l.utm_medium === "paid_social")).length;
  const last24 = results.filter(l => l.type !== "newsletter" && l.created_at >= cutoff).length;
  const cutoff7 = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 19).replace("T", " ");
  const last7 = results.filter(l => l.type !== "newsletter" && l.created_at >= cutoff7).length;
  const ads = results.filter(l => sourceOf(l).ad).length;
  const cardList = results.map(l => {
    const t = when(l.created_at), src = sourceOf(l);
    const veh = [l.year, l.make, l.model].filter(Boolean).join(" ");
    const tel = (l.phone || "").replace(/[^\d+]/g, "");
    return `<article class="lead ${["done", "lost"].includes(l.stage) ? "done" : isNewish(l.stage) ? "new" : ""}" data-id="${l.id}" data-q="${esc([l.name, l.email, l.phone, String(l.phone || "").replace(/\D/g, ""), l.service, veh, l.message, src.label, src.detail].join(" ").toLowerCase())}" data-st="${isNewish(l.stage) ? "new" : "done"}" data-stg="${esc(l.stage)}" data-svc="${esc(String(l.service || "").toLowerCase())}" data-ad="${src.ad ? 1 : 0}">
      <div class="top"><div><h3>${esc(l.name || l.email)}</h3><div class="when" title="${esc(t.abs)} ET">${esc(t.ago)} &middot; ${esc(t.abs)}</div></div>
        <div class="tags">${l.type === "newsletter" ? '<span class="tag nl">Newsletter</span>' : ""}${callTag(l)}${own ? `<span class="tag ${src.ad ? "ad" : ""}">${esc(src.label)}</span>` : ""}${l.type === "newsletter" ? "" : l.stage === "new" ? '<span class="tag hot">New</span>' : `<span class="tag ok">${esc(stageName(l.stage))}</span>`}${l.follow_up ? `<span class="tag fu">${esc(l.follow_up)}</span>` : ""}</div></div>
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
  });
  const FIRST = 60, cards = cardList.slice(0, FIRST).join(""), restCards = cardList.slice(FIRST);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Leads | Divine Detailers</title>
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
.lead{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px;cursor:pointer}.lead.new{border-color:#244d2a}.lead.done{opacity:.6}
.top{display:flex;justify-content:space-between;gap:10px}h3{margin:0;font-size:17px}.when{color:#8a9099;font-size:12.5px;margin-top:2px}
.tags{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;align-content:flex-start}.tag{font-size:11.5px;padding:3px 9px;border-radius:999px;background:#171c23;color:#aab0b9;white-space:nowrap}
.tag.ad{background:#14263f;color:#8ec0ff}.tag.call{background:#2a1f3d;color:#c9a8ff}.tag.fu{background:#2a1f3d;color:#c9a8ff}.tag.miss{background:#3b1d1d;color:#ff9a9a;font-weight:700}.rec{color:#8ec0ff;font-size:13px}.tag.hot{background:#32cd32;color:#04120a;font-weight:700}.tag.ok{background:#1a2a1c;color:#7fe07f}.tag.nl{background:#2b2411;color:#f0c050}
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px 14px}label{display:block;color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:1px}small{display:block;color:#8a9099}
.msg{margin:0;background:#10141a;border-left:3px solid #32cd32;padding:10px 12px;border-radius:0 8px 8px 0;color:#d6d9de;white-space:pre-line}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:auto}.btn{border:1px solid #2a313a;background:#151a21;color:#e8eaed;border-radius:10px;padding:10px 13px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.btn.call{background:#32cd32;border-color:#32cd32;color:#04120a}.btn.go{background:#1d2630}.btn.ghost{color:#8a9099}
.empty{grid-column:1/-1;color:#8a9099;padding:40px 0;text-align:center}
@media(max-width:700px){
  header{padding:12px 14px;position:static;gap:8px}h1{font-size:17px}
  .stats{width:100%;gap:8px}.stat{flex:1;padding:8px 10px}
  .tools{position:sticky;top:0;z-index:6;background:rgba(7,9,12,.97);padding:10px 14px;flex-wrap:nowrap;overflow-x:auto;gap:8px;-webkit-overflow-scrolling:touch;scrollbar-width:none}.tools::-webkit-scrollbar{display:none}
  input[type=search]{flex:0 0 62vw;min-width:0;font-size:16px;padding:12px 14px}.chip,.csv{flex:0 0 auto;white-space:nowrap;min-height:44px;padding:0 16px;display:inline-flex;align-items:center}
  main{grid-template-columns:minmax(0,1fr);padding:6px 14px 20px;gap:12px}.lead{padding:14px;gap:12px;min-width:0;overflow-wrap:anywhere}.lead select,.lead .btn{min-width:0;max-width:100%}
  .actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}.actions .call{grid-column:1/-1;text-align:center;padding:14px;font-size:16px}
  .actions .btn,.actions select{min-height:46px;font-size:15px;text-align:center;display:flex;align-items:center;justify-content:center}.actions select.stage{text-align:left;display:block}
  .grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
}
</style></head>
<body><header><h1>Divine Detailers <b>leads</b></h1>${nav("leads", tc, user === OWNER)}
<div class="stats"><div class="stat"><b>${last24}</b><span>leads in the past 24 hours</span></div><div class="stat hot"><b>${notContacted}</b><span>${own ? "Meta leads not contacted" : "leads not contacted"}</span></div><div class="stat"><b>${last7}</b><span>leads in the past 7 days</span></div></div></header>
<div class="tools"><input type="search" id="q" placeholder="Search name, phone, vehicle, service..."><button class="chip on" data-f="all">All</button><button class="chip" data-f="new">New</button><button class="chip" data-f="nocontact">Not contacted</button><button class="chip" data-f="coating">Coatings</button><button class="chip" data-f="tint">Tints</button><button class="chip" data-f="booked">Booked</button><a class="csv" href="/admin/pipeline#add">+ Add lead</a><a class="csv" href="/admin/leads.csv">Download CSV</a></div>
${bnav("leads", tc, user === OWNER)}
${FOLLOW_HTML}
${OUTCOME_HTML}
<main id="list">${cards || '<p class="empty">No leads yet. They will appear here the moment someone submits a form.</p>'}</main>
${restCards.length ? `<div style="text-align:center;padding:4px 14px 20px"><button type="button" id="moreb" class="chip">Show ${restCards.length} older leads</button></div><script type="application/json" id="rest">${JSON.stringify(restCards).replace(/</g, "\\u003c")}</script>` : ""}
<script>
const list=document.getElementById('list'),q=document.getElementById('q');let f='all',REST=[];try{const r=document.getElementById('rest');if(r)REST=JSON.parse(r.textContent)}catch(_){}
function more(){if(!REST.length)return;list.insertAdjacentHTML('beforeend',REST.join(''));REST=[];const b=document.getElementById('moreb');if(b)b.parentNode.remove()}
const mb=document.getElementById('moreb');if(mb)mb.onclick=more;
function apply(){const t=q.value.trim().toLowerCase(),td=t.replace(/\\D/g,'');if(t||f!=='all')more();list.querySelectorAll('.lead').forEach(e=>{const d=e.dataset,txt=!t||d.q.includes(t)||(td.length>=3&&d.q.includes(td)),fl=f==='all'||(f==='coating'||f==='tint'?d.svc.includes(f):d.stg===f);e.hidden=!(txt&&fl)})}
q.addEventListener('input',apply);document.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{document.querySelectorAll('.chip').forEach(x=>x.classList.toggle('on',x===c));f=c.dataset.f;apply()}));
${FOLLOW_JS}
${OUTCOME_JS}
document.addEventListener('click',e=>{const c=e.target.closest('article.lead');if(!c||e.target.closest('a,button,select,input,textarea,label,summary,details'))return;location.href='/admin/pipeline#id='+c.dataset.id});
const post=(u,b)=>fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
document.addEventListener('click',e=>{const a=e.target.closest('a[href^="tel:"]');if(!a)return;const h=a.closest('[data-id]');if(!h||!h.dataset.id)return;markCall(+h.dataset.id,((h.querySelector('h3,b')||{}).textContent||'').trim());try{fetch('/admin/touch',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({id:+h.dataset.id,label:'Called'})})}catch(_){}});
document.addEventListener('change',async e=>{const s=e.target.closest('select.stage');if(!s)return;const to=s.value,id=+s.dataset.id;const nm=(s.closest('.lead').querySelector('h3')||{}).textContent;s.disabled=true;
  if(to==='booked'){const o=await askBook(id);if(!o){s.disabled=false;s.value=s.dataset.cur;return}const nx=await askNext(nm,to,id);if(nx)await post('/admin/stage',{id,followup:nx.followup,follow_date:nx.follow_date});location.reload();return}
  const r=await post('/admin/stage',{id,stage:to});if(!r.ok){s.disabled=false;s.value=s.dataset.cur;return}const nx=await askNext(nm,to,id);if(nx)await post('/admin/stage',{id,followup:nx.followup,follow_date:nx.follow_date});location.reload()});
</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}


async function pipelinePage(env, user = "") {
  await ensureTable(env.DB);
  const [tc, { results }] = await Promise.all([todayCount(env), env.DB.prepare("SELECT id,created_at,type,name,email,phone,service,also_interested,make,year,model,message,page,referrer,gclid,gbraid,wbraid,utm_medium,utm_source,utm_campaign,utm_term,stage,value,notes,appt_at,stage_changed_at,follow_up,follow_up_date,duration,recording,answered,tags,starred,(SELECT COUNT(*) FROM dial_calls d WHERE d.lead_id = leads.id) AS calls,(SELECT COUNT(*) FROM messages m WHERE m.lead_id = leads.id) AS texts,((SELECT COUNT(*) FROM messages m WHERE m.lead_id = leads.id AND m.direction = 'in' AND m.is_read = 0) + COALESCE(unread_flag, 0)) AS unread,(SELECT COUNT(*) FROM stage_log s WHERE s.lead_id = leads.id AND s.reason LIKE 'Note:%') AS nlog FROM leads WHERE type != 'newsletter' ORDER BY created_at DESC, id DESC LIMIT 1000").all()]);
  // each lead's history is loaded when the lead is opened (it was more than half of this page); the click ids are only used to work out the source here
  const ownP = user === OWNER;
  const data = results.map(l0 => { const l = ownP ? l0 : noAds(l0), t = when(l.created_at), sc = sourceOf(l); const { gclid, gbraid, wbraid, referrer, ...rest } = l; return { ...rest, followup: l.follow_up || "", dur: mmss(l.duration), ago: t.ago, abs: t.abs, src: ownP ? sc.label : "", ad: ownP && sc.ad, detail: ownP ? sc.detail : "" }; });
  const payload = JSON.stringify({ own: ownP, stages: STAGES, today: todayStr(), cfg: cfgOf(env), leads: data }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Pipeline | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#07090c;color:#e8eaed;height:100vh;display:flex;flex-direction:column}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}.navtabs a.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
.sum{display:flex;gap:10px;flex-wrap:wrap}.stat{background:#10141a;border:1px solid #1d2229;border-radius:10px;padding:7px 13px}.stat b{display:block;font-size:19px;line-height:1.1}.stat span{font-size:12px;color:#8a9099}.stat.g b{color:#32cd32}
.board{flex:1;display:flex;gap:12px;padding:14px 22px 22px;overflow-x:auto;align-items:flex-start;scroll-snap-type:x proximity}
.col.auto{background:#0a0d11;border-style:dashed}.col h2 small{white-space:nowrap}.col h2{gap:8px}.col{flex:1 0 280px;max-width:380px;background:#0b0e12;border:1px solid #1b2027;border-radius:14px;display:flex;flex-direction:column;max-height:100%;scroll-snap-align:start}
.col.over{border-color:#32cd32;background:#0d140f}.col h2{font-size:13px;margin:0;padding:12px 14px;display:flex;justify-content:space-between;align-items:baseline;text-transform:uppercase;letter-spacing:.7px;color:#c3c8cf}
.col h2 small{color:#7c838d;font-weight:500;text-transform:none;letter-spacing:0}.col.s-lost h2{color:#c48a8a}.col.s-aged h2{color:#ffb86b}.col.s-done h2{color:#7fe07f}
.cards{padding:0 10px 10px;display:flex;flex-direction:column;gap:9px;overflow-y:auto;min-height:60px}
.card{background:#12171e;border:1px solid #232a33;border-radius:11px;padding:11px 12px;cursor:grab}.card:hover{border-color:#3a4552}.card.drag{opacity:.4}
.card b{display:block;font-size:15px}.card .meta{color:#98a0aa;font-size:13px;margin-top:2px}.card .row span:first-child{white-space:nowrap}.card .row{display:flex;justify-content:space-between;gap:8px;margin-top:8px;align-items:center;color:#7c838d;font-size:12px}
.ch{display:flex;justify-content:space-between;align-items:flex-start;gap:6px}.ch b{flex:1;min-width:0;overflow-wrap:anywhere}.stb{background:none;border:0;color:#4b5560;font-size:17px;cursor:pointer;padding:0;line-height:1}.stb.on{color:#ffcc4d}.stb:hover{color:#ffcc4d}
.cps{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}.cp{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;border-radius:7px;padding:2px 8px;background:#161c23;color:#aab0b9;border:1px solid #212932}.cp svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.cp.ap{background:#0f2234;border-color:#1d3d5c;color:#8ec0ff}.cp.fu{background:#241d10;border-color:#4a3a18;color:#ffcf8a}.cp.fu.late{background:#2b1414;border-color:#6a2a2a;color:#ff9a9a}.cp.nc{background:#2b1414;border-color:#6a2a2a;color:#ff9a9a;font-weight:700}.cp.tg{background:#142029;border-color:#20323f;color:#9fc4de}
.qk{display:flex;gap:6px;margin-top:10px;padding-top:9px;border-top:1px solid #1d242c}.qb{position:relative;flex:1;display:flex;align-items:center;justify-content:center;gap:5px;height:34px;border-radius:9px;border:1px solid #232b34;background:#0f141a;color:#9aa4af;text-decoration:none;cursor:pointer;font:inherit}.qb svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.qb:hover{border-color:#34404c;color:#fff}.qb.call{color:#4fdc5a}.qb.call:hover{background:#0f2c18;border-color:#1f6a37}.qb i{font-style:normal;font-size:11px;font-weight:700;color:#8a939e}.qb i.ub{background:#2f7bff;color:#fff;border-radius:999px;padding:0 6px;min-width:17px;text-align:center}
.pill{font-size:11px;padding:2px 8px;border-radius:999px;background:#171c23;color:#aab0b9}.pill.ad{background:#14263f;color:#8ec0ff}.pill.val{background:#16301a;color:#7fe07f;font-weight:700}.pill.call{background:#2a1f3d;color:#c9a8ff}.pill.miss{background:#3b1d1d;color:#ff9a9a;font-weight:700}
details.ed{border:1px solid #232a33;border-radius:12px;padding:10px 12px}details.ed summary{cursor:pointer;font-weight:600;color:#c3c8cf;min-height:30px;display:flex;align-items:center}details.ed .g2{margin-top:10px}.rec{color:#8ec0ff}.addb{background:#32cd32;color:#04120a;border:0;border-radius:999px;padding:9px 16px;font:inherit;font-weight:800;cursor:pointer}
.empty{color:#586069;font-size:13px;text-align:center;padding:14px 0}
dialog{background:#0f1319;color:#e8eaed;border:1px solid #2a313a;border-radius:16px;padding:0;width:min(520px,94vw);max-height:92vh;overflow:auto}dialog::backdrop{background:rgba(0,0,0,.65)}
.dh{display:flex;justify-content:space-between;gap:10px;padding:18px 20px 6px}.dh h3{margin:0;font-size:20px}.x{background:none;border:0;color:#8a9099;font-size:26px;cursor:pointer;line-height:1}
.db{padding:6px 20px 20px;display:flex;flex-direction:column;gap:12px}.g2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px 14px}label{display:block;color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:2px}
.msg{margin:0;background:#12171e;border-left:3px solid #32cd32;padding:10px 12px;border-radius:0 8px 8px 0;color:#d6d9de;white-space:pre-line}
select,input,textarea{width:100%;background:#12171e;border:1px solid #2a313a;color:#fff;border-radius:10px;padding:10px 12px;font:inherit}textarea{min-height:84px;resize:vertical}
.acts{display:flex;gap:8px;flex-wrap:wrap}.btn{border:1px solid #2a313a;background:#151a21;color:#e8eaed;border-radius:10px;padding:10px 14px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}.btn.call{background:#32cd32;border-color:#32cd32;color:#04120a}.btn.go{background:#32cd32;border-color:#32cd32;color:#04120a;margin-left:auto}
${BNAV_CSS}
${FOLLOW_CSS}
.rp{display:flex;flex-direction:column;gap:8px}.next{margin-top:8px;font-size:13px;color:#c9a8ff}.next.late{color:#ff9a9a;font-weight:700}
.hist{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}.hist li{font-size:13.5px;color:#cfd3d9;border-left:2px solid #2a313a;padding-left:10px}.hist small{display:block;color:#7c838d;font-size:12px}.sum2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px 16px}.sum2 b{display:block;font-size:16px;font-weight:700}.sum2 small{display:block;color:#8a9099;font-size:12.5px;margin-top:2px}
.src{background:#0d1116;border:1px solid #1d2229;border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:7px}.srch{display:flex;align-items:center;gap:10px;margin-bottom:2px}.spill{font-size:12px;font-weight:700;letter-spacing:.04em;padding:3px 10px;border-radius:999px;background:#171c23;color:#c3c8cf}.spill.ad{background:#14263f;color:#8ec0ff}.sm{color:#7c838d;font-size:12.5px}
.kvr{display:grid;grid-template-columns:84px 1fr;gap:10px;font-size:13.5px;align-items:baseline}.kvr span{color:#7c838d;font-size:12px;text-transform:uppercase;letter-spacing:.06em}.kvr b{font-weight:600;color:#dfe3e8;overflow-wrap:anywhere}
.fans{display:flex;flex-direction:column;gap:6px;border-left:3px solid #32cd32;padding:2px 0 2px 12px}.fanr span{display:block;color:#8a9099;font-size:12.5px}.fanr b{font-size:15px;font-weight:600}
.tlist{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column}.tld{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6d747e;margin:10px 0 2px}.tld:first-child{margin-top:2px}
.tl{display:grid;grid-template-columns:14px 1fr auto;gap:10px;align-items:start;padding:5px 0}.tl i{width:8px;height:8px;border-radius:50%;background:#98a0aa;margin-top:6px;justify-self:center}.tl b{font-size:13.5px;font-weight:600;color:#e3e6ea;display:block;line-height:1.35}.tl small{display:block;color:#7c838d;font-size:12px;line-height:1.35}.tl>span{font-size:12px;color:#8a9099;white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}.tl>span em{display:block;font-style:normal;color:#586069;font-size:11px}
.tl.h-call i{background:#32cd32}.tl.h-text i{background:#8ec0ff}.tl.h-mail i{background:#c9a8ff}.tl.h-stage i{background:#ffb86b}.tl.h-new i{background:#98a0aa}
.tl[hidden],.tld[hidden]{display:none}.hmore{margin-top:6px;background:none;border:1px solid #2a313a;color:#9aa3ad;border-radius:999px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}.hist li.h-call{border-left-color:#32cd32}.hist li.h-text{border-left-color:#8ec0ff}.hist li.h-mail{border-left-color:#c9a8ff}.hist li.h-stage{border-left-color:#ffb86b}.hist li.h-new{border-left-color:#98a0aa}
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
  .qa{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;margin-top:12px}.qa a,.qa button{min-height:46px;border-radius:11px;border:1px solid #2a313a;background:#151a21;color:#e8eaed;font:inherit;font-weight:700;text-decoration:none;display:flex;align-items:center;justify-content:center;cursor:pointer}.qa .call{background:#32cd32;border-color:#32cd32;color:#04120a}
  dialog{width:100vw;max-width:100vw;margin:auto 0 0;border-radius:18px 18px 0 0;max-height:94vh}
  .db{padding-bottom:calc(20px + env(safe-area-inset-bottom,0px))}.dh h3{font-size:21px}.x{font-size:34px;padding:0 8px;min-height:44px}
  select,input,textarea{font-size:16px;min-height:48px}textarea{min-height:100px}.btn{min-height:48px}.btn{display:flex;align-items:center;justify-content:center}.acts .btn{flex:1}.acts .btn.call{flex:1 1 100%;font-size:17px}
  .chips{display:flex;flex-wrap:wrap;gap:8px}.chips button{min-height:44px;padding:0 14px;border-radius:999px;border:1px solid #2a313a;background:#12171e;color:#e8eaed;font:inherit;cursor:pointer}.chips button.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
}
</style></head><body>
<header><h1>Divine Detailers <b>pipeline</b></h1>${nav("pipeline", tc, user === OWNER)}<div class="sum" id="sum"></div><button class="addb" id="addb" type="button">+ Add lead</button></header>
<div class="tabs" id="tabs"></div>
${bnav("pipeline", tc, user === OWNER)}
${QUEUE_HTML}
<div class="board" id="board"></div>
<dialog id="dlg"></dialog>
${FOLLOW_HTML}
${OUTCOME_HTML}
<script type="application/json" id="data">${payload}</script>
<script>
const IS_OWNER=${user === OWNER};
${FOLLOW_JS}
${OUTCOME_JS}
${QUEUE_JS}
${TPL_JS}
const D=JSON.parse(document.getElementById('data').textContent),S=D.stages,L=D.leads,CFG=D.cfg,board=document.getElementById('board'),dlg=document.getElementById('dlg');
const $=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),money=n=>n?'$'+Number(n).toLocaleString('en-US'):'';
const M=window.matchMedia('(max-width:700px)');let cur='new';
const CI={phone:'<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>',msg:'<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',note:'<svg viewBox="0 0 24 24"><path d="M5 4h14v16H5zM9 9h6M9 13h6"/></svg>',cal:'<svg viewBox="0 0 24 24"><path d="M5 5h14v15H5zM5 10h14M9 3v4M15 3v4"/></svg>',open:'<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>'};
const apFmt=a=>{const d=new Date(String(a).replace(' ','T'));return isNaN(d)?'':d.toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).replace(':00','')};
const fuFmt=d=>{const p=String(d).split('-');return p.length===3?['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+p[1]-1]+' '+(+p[2]):d};
function cardHtml(l,qa){const tel=(l.phone||'').replace(/[^\\d+]/g,''),car=[l.year,l.make,l.model].filter(Boolean).join(' '),closed=['done','lost'].includes(l.stage),tags=String(l.tags||'').split(',').filter(Boolean);
  const chips=[];
  if(l.appt_at&&!closed)chips.push('<span class="cp ap">'+CI.cal+apFmt(l.appt_at)+'</span>');
  if(l.follow_up_date&&!closed)chips.push('<span class="cp fu'+(l.follow_up_date<=TODAY?' late':'')+'">'+CI.phone+(l.follow_up||'Follow up')+' '+fuFmt(l.follow_up_date)+'</span>');
  if(!l.calls&&(l.stage==='new'||l.stage==='nocontact')&&l.type!=='call')chips.push('<span class="cp nc">Not called</span>');
  tags.slice(0,2).forEach(t=>chips.push('<span class="cp tg">'+$(t)+'</span>'));if(tags.length>2)chips.push('<span class="cp tg">+'+(tags.length-2)+'</span>');
  const callHref=IS_OWNER?'/admin/dialer?lead='+l.id:'tel:'+$(tel);
  const qk='<div class="qk">'+(tel?'<a class="qb call" href="'+callHref+'" data-stop="1" title="Call">'+CI.phone+(l.calls?'<i>'+l.calls+'</i>':'')+'</a>':'')+'<a class="qb" href="/admin/messages#id='+l.id+'" data-stop="1" title="Text">'+CI.msg+(l.unread?'<i class="ub">'+l.unread+'</i>':(l.texts?'<i>'+l.texts+'</i>':''))+'</a><button type="button" class="qb" data-open="'+l.id+'" title="Notes and details">'+CI.note+(l.nlog?'<i>'+l.nlog+'</i>':'')+'</button></div>';
  return '<article class="card" draggable="'+(M.matches?'false':'true')+'" data-id="'+l.id+'"><div class="ch"><b>'+$(l.name||l.email)+'</b><button type="button" class="stb'+(l.starred?' on':'')+'" data-star="'+l.id+'" data-stop="1" aria-label="Star">'+(l.starred?'&#9733;':'&#9734;')+'</button></div><div class="meta">'+$(l.service||'')+(car?' &middot; '+$(car):'')+'</div>'+(chips.length?'<div class="cps">'+chips.join('')+'</div>':'')+'<div class="row"><span>'+$(l.ago)+'</span><span>'+(l.type==='call'?(/voicemail/i.test(l.message||'')?'<span class="pill miss">Voicemail</span> ':l.answered===0?'<span class="pill miss">Missed</span> ':'<span class="pill call">Call</span> '):'')+(STG_PILL[l.stage]?'<span class="pill">'+STG_PILL[l.stage]+'</span> ':'')+(l.ad?'<span class="pill ad">Ads</span> ':'')+(l.value?'<span class="pill val">'+money(l.value)+'</span>':'')+'</span></div>'+(qa&&tel?'<div class="qa"><a class="call" href="'+callHref+'" data-stop="1">Call</a><button type="button" data-open="'+l.id+'">Details</button></div>':qk)+'</article>'}
const LIM={};const lim=k=>LIM[k]||40;const moreBtn=(k,n)=>n>lim(k)?'<button type="button" class="chip" data-more="'+k+'" style="margin:8px auto;display:block">Show '+Math.min(60,n-lim(k))+' more ('+(n-lim(k))+' left)</button>':'';
const OPEN=['new','nocontact','contacted','quoted','aged'],DAYC=[['d1','1-2 days',0,2],['d3','3-6 days',3,6],['d7','7+ days',7,29],['d30','30+ days',30,1e9]],STG_PILL={nocontact:'Not contacted',contacted:'Contacted',quoted:'Quote sent'};
const ageDays=l=>{const t=Date.parse(String(l.created_at||'').replace(' ','T')+'Z');return isNaN(t)?0:Math.max(0,Math.floor((Date.now()-t)/864e5))};
const colOf=l=>{if(!OPEN.includes(l.stage))return l.stage;const a=ageDays(l);return (DAYC.find(d=>a>=d[2]&&a<=d[3])||DAYC[0])[0]};
const COLS=DAYC.map(d=>[d[0],d[1],true]).concat(S.filter(x=>!OPEN.includes(x[0])).map(x=>[x[0],x[1],false]));
function draw(){
  let open=0,won=0,booked=0;
  L.forEach(l=>{if(l.stage==='new'||l.stage==='nocontact')open++;if(l.stage==='booked'||l.stage==='working'||l.stage==='done')booked+=(l.value||0);if(l.stage==='done')won+=(l.value||0)});
  const pipe=L.filter(l=>OPEN.concat(['interested','deposit']).includes(l.stage)).reduce((a,l)=>a+(l.value||0),0);
  document.getElementById('sum').innerHTML='<div class="stat g"><b>'+open+'</b><span>new to contact</span></div><div class="stat"><b>'+money(pipe)+'</b><span>$ in pipeline</span></div><div class="stat"><b>'+money(booked)+'</b><span>booked + done</span></div><div class="stat"><b>'+money(won)+'</b><span>completed</span></div>';
  const tabs=document.getElementById('tabs'),inCol=k=>L.filter(l=>colOf(l)===k);
  if(M.matches){
    if(!COLS.some(c=>c[0]===cur))cur='d1';
    tabs.innerHTML=COLS.map(([k,n])=>'<button class="tab'+(k===cur?' on':'')+'" data-tab="'+k+'">'+n+' <i>'+inCol(k).length+'</i></button>').join('');
    const ls=inCol(cur),tot=ls.reduce((a,l)=>a+(l.value||0),0),name=(COLS.find(x=>x[0]===cur)||[0,''])[1];
    board.innerHTML='<section class="col" data-stage="'+cur+'"><h2>'+name+' <small>'+ls.length+(tot?' &middot; '+money(tot):'')+'</small></h2><div class="cards">'+(ls.slice(0,lim(cur)).map(l=>cardHtml(l,true)).join('')||'<div class="empty">Nothing in '+$(name)+' right now</div>')+moreBtn(cur,ls.length)+'</div></section>';
    const on=tabs.querySelector('.tab.on');if(on&&on.scrollIntoView)on.scrollIntoView({inline:'center',block:'nearest'});
    return;
  }
  tabs.innerHTML='';
  board.innerHTML=COLS.map(([k,n,auto])=>{const ls=inCol(k),tot=ls.reduce((a,l)=>a+(l.value||0),0);
    return '<section class="col s-'+k+(auto?' auto':'')+'" data-stage="'+k+'"'+(auto?' title="Fills automatically by how long ago the lead came in"':'')+'><h2>'+n+' <small>'+ls.length+(tot?' &middot; '+money(tot):'')+'</small></h2><div class="cards">'+
    (ls.slice(0,lim(k)).map(l=>cardHtml(l,false)).join('')||'<div class="empty">'+(auto?'No leads this age':'Drop leads here')+'</div>')+moreBtn(k,ls.length)+'</div></section>';}).join('');
}
M.addEventListener&&M.addEventListener('change',draw);
board.addEventListener('click',e=>{const m=e.target.closest('[data-more]');if(m){LIM[m.dataset.more]=lim(m.dataset.more)+60;draw()}});
document.getElementById('tabs').addEventListener('click',e=>{const t=e.target.closest('[data-tab]');if(t){cur=t.dataset.tab;draw();window.scrollTo({top:0})}});
const SN=k=>(S.find(x=>x[0]===k)||[0,k])[1];const TODAY=D.today;const fmtD=d=>{const p=d.split('-');return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+p[1]-1]+' '+(+p[2])};
function parseMsg(l){const x={answers:[],form:'',ad:'',adset:'',plat:'',rest:[]};(l.message||'').split('\\n').forEach(line=>{line=line.trim();if(!line)return;
    if(/^(form name|ad name|adset name|platform):/i.test(line)){line.split(' · ').forEach(seg=>{const m=/^(form name|ad name|adset name|platform):\\s*(.*)$/i.exec(seg.trim());if(m){const k=m[1].toLowerCase();if(k==='form name')x.form=m[2];else if(k==='ad name')x.ad=m[2];else if(k==='adset name')x.adset=m[2];else x.plat=m[2]}});return}
    const q=line.indexOf('?');if(q>3&&q<140){x.answers.push([line.slice(0,q+1),line.slice(q+1).trim()]);return}
    const m=/^([^:]{2,60}):\\s+(.+)$/.exec(line);if(m&&!/^(Voicemail|Missed)/i.test(line)&&l.type!=='call'){x.answers.push([m[1],m[2]]);return}
    x.rest.push(line)});return x}
const kv=(k,v)=>v?'<div class="kvr"><span>'+$(k)+'</span><b>'+$(v)+'</b></div>':'';
function infoHtml(l,veh){const p=parseMsg(l),meta=l.utm_medium==='paid_social',web=!meta&&(l.page||'').replace(/^https?:\\/\\/[^/]+/,'');
  const ad=meta?(p.ad||l.utm_term):'',kw=meta?'':l.utm_term;
  const src='<div class="src"><div class="srch"><span class="spill'+(l.ad?' ad':'')+'">'+$(l.src||'Direct')+'</span>'+(meta?'<span class="sm">Instant Form</span>':'')+'</div>'+
    kv('Campaign',l.utm_campaign)+kv(meta?'Ad':'Keyword',meta?ad:kw)+kv('Ad set',p.adset)+kv('Form',p.form)+kv('Landed on',web)+'</div>';
  const ans=p.answers.length?'<div class="fans">'+p.answers.map(a=>'<div class="fanr"><span>'+$(a[0])+'</span><b>'+$(a[1]||'-')+'</b></div>').join('')+'</div>':'';
  const rest=p.rest.length?'<p class="msg">&ldquo;'+$(p.rest.join(' '))+'&rdquo;</p>':'';
  if(!D.own)return '<div class="sum2"><div><label>Service</label><b>'+$(l.service||'-')+'</b>'+(l.also_interested?'<small>also: '+$(l.also_interested)+'</small>':'')+'</div><div><label>Vehicle</label><b>'+$(veh||'-')+'</b></div></div>'+ans+rest;
  return '<div class="sum2"><div><label>Service</label><b>'+$(l.service||'-')+'</b>'+(l.also_interested?'<small>also: '+$(l.also_interested)+'</small>':'')+'</div><div><label>Vehicle</label><b>'+$(veh||'-')+'</b></div></div>'+ans+src+rest}
const shortR=r=>r.replace(/^Agent missed the auto-dial.*/i,'Missed the auto-dial (no answer or no 1)').replace(/^Call not connected.*/i,'Call not connected').replace(/^Called via CallRail/i,'Call connected').replace(/^Call queue: calling your phone first/i,'Call queue: ringing you first').replace(/^Auto-dial requested.*/i,'Auto-dial: ringing you first').replace(/^Dial requested.*/i,'Call: ringing you first').replace(/^Call result: CallRail reported /i,'CallRail: ').replace(/^Auto-dial: first ring not answered.*/i,'Auto-dial: ringing you again');
function histHtml(l){const rows=(l.log||[]).map(h=>{const same=h.from_stage===h.to_stage,r=h.reason||'';
    const k=/^(Texted)/i.test(r)?'text':/^(Emailed)/i.test(r)?'mail':/^(Called|Call |Dial|Auto-dial|Agent missed|Left a voicemail|Spoke|Call queue)/i.test(r)?'call':!same?'stage':'note';
    const t=same?shortR(r||'Update'):SN(h.from_stage)+' → '+SN(h.to_stage),sub=same?'':(r&&r!=='Moved'?shortR(r):'');
    const m=/^(.*), (\\d+:\\d\\d [AP]M)$/.exec(h.at==='now'?'':(h.at||''));
    return {k,t,sub,d:m?m[1]:'',tm:m?m[2]:(h.at==='now'?'now':(h.at||'')),by:h.by_user||''}});
  const m0=/^(.*), (\\d+:\\d\\d [AP]M)$/.exec(l.abs||'');rows.push({k:'new',t:'Lead created',sub:(l.type==='call'?'Inbound call':'Form')+(l.src?' · '+l.src:''),d:m0?m0[1]:'',tm:m0?m0[2]:(l.abs||''),by:''});
  let last='';const li=rows.map((r,i)=>{const hd=r.d&&r.d!==last?'<li class="tld'+(i>=5?' more':'')+'" '+(i>=5?'hidden':'')+'>'+$(r.d)+'</li>':'';if(r.d)last=r.d;
    return hd+'<li class="tl h-'+r.k+(i>=5?' more':'')+'" '+(i>=5?'hidden':'')+'><i></i><div><b>'+$(r.t)+'</b>'+(r.sub?'<small>'+$(r.sub)+'</small>':'')+'</div><span>'+$(r.tm)+(r.by&&r.by!=='system'?'<em>'+$(r.by)+'</em>':'')+'</span></li>'}).join('');
  return '<div><label>Lead history ('+rows.length+')</label><ul class="tlist">'+li+'</ul>'+(rows.length>5?'<button type="button" class="hmore" id="hmore">Show all '+rows.length+'</button>':'')+'</div>'}
async function save(id,patch,url){const r=await fetch(url||'/admin/lead',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({id},patch))});if(!r.ok)return false;try{return await r.json()}catch(_){return {success:true}}}
function apply(l,o){if(o&&o.stage){l.stage=o.stage;l.followup=o.followup||'';l.follow_up_date=o.follow_up_date||''}}
let dragId=null;
board.addEventListener('dragstart',e=>{const c=e.target.closest('.card');if(!c)return;dragId=+c.dataset.id;c.classList.add('drag');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(dragId))});
board.addEventListener('dragend',()=>{dragId=null;draw()});
board.addEventListener('dragover',e=>{const c=e.target.closest('.col');if(!c)return;e.preventDefault();board.querySelectorAll('.col.over').forEach(x=>x!==c&&x.classList.remove('over'));c.classList.add('over')});
board.addEventListener('drop',async e=>{const c=e.target.closest('.col');if(!c||dragId==null)return;e.preventDefault();const l=L.find(x=>x.id===dragId);const st=c.dataset.stage;if(/^d\\d+$/.test(st)){draw();return}if(l&&colOf(l)!==st&&l.stage!==st){if(st==='booked'){const o=await askBook(l.id);if(o){Object.assign(l,o.lead||{});apply(l,o);if(o.log)l.log=o.log.concat(l.log||[])}draw();return}const o=await save(l.id,{stage:st},'/admin/stage');if(o){apply(l,o);draw();const nx=await askNext(l.name||l.phone||l.email,l.stage,l.id);if(nx){const o2=await save(l.id,{followup:nx.followup,follow_date:nx.follow_date},'/admin/stage');apply(l,o2)}}draw()}else draw()});
board.addEventListener('click',async e=>{const st=e.target.closest('[data-star]');if(st){e.stopPropagation();const id=+st.dataset.star,l=L.find(x=>x.id===id);if(l){l.starred=l.starred?0:1;draw();try{await fetch('/admin/star',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,on:!!l.starred})})}catch(_){}}return}if(e.target.closest('[data-stop]'))return;const d=e.target.closest('[data-open]');if(d){open(+d.dataset.open);return}const c=e.target.closest('.card');if(c)open(+c.dataset.id)});
document.addEventListener('click',e=>{const a=e.target.closest('a[href^=\"tel:\"]');if(!a)return;const h=a.closest('[data-id]');if(!h||!h.dataset.id)return;markCall(+h.dataset.id,((h.querySelector('h3,b')||{}).textContent||'').trim());try{fetch('/admin/touch',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({id:+h.dataset.id,label:'Called'})})}catch(_){}});
const SVC=['Window Tint','PPF / Clear Bra','Ceramic Coating','Paint Correction','Vinyl Wraps','Exterior Detailing','Other'];
function open(id){const l=L.find(x=>x.id===id);if(!l)return;dlg.dataset.id=id;const tel=(l.phone||'').replace(/[^\\d+]/g,''),veh=[l.year,l.make,l.model].filter(Boolean).join(' '),isCall=l.type==='call';
  const ed='<details class="ed"'+((isCall||!l.service)?' open':'')+'><summary>Edit contact and vehicle</summary><div class="g2"><div><label>Name</label><input id="en" value="'+$(l.name||'')+'" autocomplete="off"></div><div><label>Phone</label><input id="ep" type="tel" inputmode="tel" value="'+$(l.phone||'')+'"></div><div><label>Email</label><input id="ee" type="email" value="'+$(l.email||'')+'"></div><div><label>Service</label><select id="es"><option value="">Not set</option>'+SVC.map(x=>'<option'+(x===l.service?' selected':'')+'>'+x+'</option>').join('')+'</select></div><div><label>Make</label><input id="em" value="'+$(l.make||'')+'"></div><div><label>Model</label><input id="ed2" value="'+$(l.model||'')+'"></div><div><label>Year</label><input id="ey" inputmode="numeric" value="'+$(l.year||'')+'"></div></div></details>';
  dlg.innerHTML='<div class="dh"><div><h3>'+$(l.name||l.phone||l.email||'Unknown caller')+'</h3><div style="color:#8a9099;font-size:13px">'+$(l.ago)+' &middot; '+$(l.abs)+' ET &middot; '+$(l.src)+'</div></div><button class="x" onclick="dlg.close()" aria-label="Close">&times;</button></div><div class="db">'+
  '<div class="acts">'+(tel?'<a class="btn call" href="'+(IS_OWNER?'/admin/dialer?lead='+l.id:'tel:'+$(tel))+'">Call '+$(l.phone)+'</a>':'')+(l.email?'<a class="btn" href="mailto:'+$(l.email)+'">Email</a>':'')+(l.recording?'<a class="btn rec" href="'+$(l.recording)+'" target="_blank" rel="noopener">&#9654; Listen</a>':'')+'</div>'+
  (isCall?'<div style="color:#c9a8ff;font-size:14px">'+(/voicemail/i.test(l.message||'')?'Voicemail':l.answered===0?'Missed call':'Phone call'+(l.dur?' &middot; '+$(l.dur):''))+'</div>':'')+
  infoHtml(l,veh)+
  ed+
  '<div id="ca"></div>'+
  '<div id="hist">'+histHtml(l)+'</div>'+
  '<div id="cr"></div>'+
  '<div id="cn"></div>'+
  '<div><label>Stage</label><div class="chips" id="fchips">'+S.map(([k,n])=>'<button type="button" data-k="'+k+'" class="'+(k===l.stage?'on':'')+'">'+n+'</button>').join('')+'</div></div><div><label>Next step <span id="fuh" style="text-transform:none;letter-spacing:0;color:#586069"></span></label><div class="fu-chips" id="fuc"></div></div><div class="g2"><div><label>Follow up on</label><input id="fd" type="date" value="'+$(l.follow_up_date||'')+'" style="color-scheme:dark"></div><div><label>Job value ($)</label><input id="fv" type="number" min="0" step="1" inputmode="numeric" value="'+(l.value||'')+'" placeholder="0"></div></div>'+
  '<div><label>Notes</label><textarea id="fn" placeholder="Called, left voicemail... quoted full front PPF...">'+$(l.notes||'')+'</textarea></div>'+
  '<div class="acts"><button class="btn go" id="fsave">Save</button>'+(IS_OWNER?'<button class="btn ghost" id="fdel" type="button">Delete lead</button>':'')+'</div></div>';
  dlg.showModal();
  fetch('/admin/note?id='+id).then(r=>r.json()).then(j=>{if(!j.success)return;const ta=document.getElementById('fn');if(ta&&ta.value===(l.notes||'')){ta.value=j.notes||''}l.notes=j.notes||''}).catch(()=>{});
  const wireHist=()=>{const hm=document.getElementById('hmore');if(hm)hm.onclick=()=>{dlg.querySelectorAll('.tlist [hidden]').forEach(e=>e.hidden=false);hm.remove()}};wireHist();
  const CALLS=fetch('/admin/calls?id='+l.id).then(r=>r.json());
  CALLS.then(j=>{if(!j.history||dlg.dataset.id!=String(l.id))return;l.log=j.history;const hb=document.getElementById('hist');if(hb){hb.innerHTML=histHtml(l);wireHist()}});
  CALLS.then(j=>{const a=j.attempts,box=document.getElementById('ca');if(!box||!a||dlg.dataset.id!=String(l.id))return;
    const chip=(n,t)=>'<span style="background:#0d1116;border:1px solid #232932;border-radius:999px;padding:4px 11px;font-size:13px"><b style="font-variant-numeric:tabular-nums">'+n+'</b> '+t+'</span>';
    const parts=[chip(a.calls,'outbound call'+(a.calls===1?'':'s'))];
    if(a.answered)parts.push(chip(a.answered,'answered'));if(a.voicemail)parts.push(chip(a.voicemail,'voicemail'));if(a.noanswer)parts.push(chip(a.noanswer,'no answer'));if(a.notconnected)parts.push(chip(a.notconnected,'you missed'));
    parts.push(chip(a.texts,'text'+(a.texts===1?'':'s')+' sent'));if(a.emails)parts.push(chip(a.emails,'email'+(a.emails===1?'':'s')+' sent'));
    box.innerHTML='<label>Contact attempts</label><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:4px 0 2px"><span style="border-radius:999px;padding:5px 12px;font-size:13px;font-weight:700;'+(a.contact?'background:#32cd32;color:#04120a':'background:#3a2a14;color:#ffb86b')+'">'+(a.contact?'Contact made':'No contact yet')+'</span>'+parts.join('')+(a.last?'<span style="color:#8a9099;font-size:13px">last attempt '+$(a.last)+'</span>':'')+'</div>'});
  CALLS.then(j=>{const c=document.getElementById('cr');if(!c||dlg.dataset.id!=String(l.id)||!j.recordings||!j.recordings.length)return;
    const mmss=n=>n==null?'':Math.floor(n/60)+':'+String(n%60).padStart(2,'0');
    c.innerHTML='<label>Recordings ('+j.recordings.length+')</label>'+j.recordings.map(r=>'<div style="display:flex;gap:10px;align-items:center;justify-content:space-between;margin:6px 0;padding:8px 10px;background:#0d1116;border:1px solid #232932;border-radius:10px"><span style="font-size:14px">'+(r.direction==='inbound'?'Inbound call':'Call')+' &middot; '+$(r.at)+(r.duration!=null?' &middot; '+mmss(r.duration):'')+'</span><a class="rec" href="'+$(r.url)+'" target="_blank" rel="noopener" style="white-space:nowrap">Listen</a></div>').join('')});
  CALLS.then(j=>{const b=document.getElementById('cn');if(!b||dlg.dataset.id!=String(l.id)||!j.notes||!j.notes.length)return;b.innerHTML='<label>Call summary and transcript</label>'+j.notes.map(n=>'<div style="margin:6px 0 10px"><b style="font-size:13px">'+(n.direction==='inbound'?'Inbound call':'Call')+' &middot; '+$(n.at)+'</b>'+(n.summary?'<p style="margin:6px 0">'+$(n.summary)+'</p>':'')+(n.transcript?'<details><summary style="cursor:pointer;color:#32cd32">Transcript</summary><pre style="white-space:pre-wrap;font:13px/1.5 system-ui;color:#c3c8cf;margin:6px 0">'+$(n.transcript)+'</pre></details>':'')+(!n.summary&&!n.transcript?'<p style="color:#8a9099;margin:6px 0">'+(n.done?'No transcript was available for this call (CallRail Conversation Intelligence may not be turned on).':'Transcript is being prepared (usually a few minutes)...')+'</p>':'')+'</div>').join('')}).catch(()=>{});
  let stg=l.stage,pick=(stg===l.stage?'':'');
  function drawFu(){const fuc=document.getElementById('fuc');fuc.innerHTML='';(FU[stg]||[]).forEach(([lab,mv])=>{const b=document.createElement('button');b.type='button';b.dataset.l=lab;b.className=(mv?'mv ':'')+(pick===lab?'on':'');b.innerHTML=$(lab)+(mv?'<small>moves to '+$(SN(mv))+'</small>':'');fuc.appendChild(b)});document.getElementById('fuh').textContent=(stg===l.stage&&l.followup?'(now: '+l.followup+')':'')}
  document.getElementById('fuc').onclick=e=>{const b=e.target.closest('button[data-l]');if(!b)return;pick=pick===b.dataset.l?'':b.dataset.l;drawFu()};
  document.getElementById('fchips').onclick=e=>{const b=e.target.closest('button[data-k]');if(!b)return;stg=b.dataset.k;pick='';document.querySelectorAll('#fchips button').forEach(x=>x.classList.toggle('on',x===b));drawFu()};
  drawFu();
  const fdb=document.getElementById('fdel');if(fdb)fdb.onclick=async()=>{if(!confirm('Delete '+(l.name||l.phone||l.email||'this lead')+'? This removes the lead and its history for good.'))return;const o=await save(l.id,{},'/admin/delete');if(o){const i=L.findIndex(x=>x.id===l.id);if(i>=0)L.splice(i,1);dlg.close();draw()}};
  document.getElementById('fsave').onclick=async()=>{const g=i=>document.getElementById(i).value.trim();const base={name:g('en'),phone:g('ep'),email:g('ee'),service:g('es'),make:g('em'),model:g('ed2'),year:g('ey'),value:Math.max(0,parseInt(document.getElementById('fv').value||'0',10)||0),notes:document.getElementById('fn').value};
    const mvB=((FU[stg]||[]).find(x=>x[0]===pick)||[])[1]==='booked',book=(stg==='booked'&&l.stage!=='booked')||mvB;
    if(book){const o1=await save(l.id,Object.assign({stage:l.stage,follow_date:g('fd')},base));if(o1)Object.assign(l,base);dlg.close();const o=await askBook(l.id,pick||'');if(o){Object.assign(l,o.lead||{});apply(l,o);if(o.log)l.log=o.log.concat(l.log||[])}draw();return}
    const o=await save(l.id,Object.assign({stage:stg,followup:pick||undefined,follow_date:g('fd')},base));if(o){Object.assign(l,base,{follow_up_date:g('fd')});apply(l,o);if(o.stage&&o.log)l.log=o.log.concat(l.log||[]);dlg.close();draw()}}}
const SRCS=['Phone call','Walk-in','Text / DM','Referral','Other'];
function openAdd(){dlg.innerHTML='<div class="dh"><h3>Add a lead</h3><button class="x" onclick="dlg.close()" aria-label="Close">&times;</button></div><div class="db"><div class="g2"><div><label>Name</label><input id="an" autocomplete="off"></div><div><label>Phone</label><input id="ap" type="tel" inputmode="tel"></div><div><label>Email</label><input id="ae" type="email"></div><div><label>How they reached you</label><select id="as">'+SRCS.map(x=>'<option>'+x+'</option>').join('')+'</select></div><div><label>Service</label><select id="av"><option value="">Not set</option>'+SVC.map(x=>'<option>'+x+'</option>').join('')+'</select></div><div><label>Make</label><input id="am"></div><div><label>Model</label><input id="ad"></div><div><label>Year</label><input id="ay" inputmode="numeric"></div></div><div><label>Notes</label><textarea id="ano"></textarea></div><div class="acts"><button class="btn go" id="asave">Add lead</button></div></div>';dlg.showModal();
  document.getElementById('asave').onclick=async()=>{const g=i=>document.getElementById(i).value.trim();const r=await fetch('/admin/add',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:g('an'),phone:g('ap'),email:g('ae'),source:g('as'),service:g('av'),make:g('am'),model:g('ad'),year:g('ay'),notes:g('ano')})});if(r.ok)location.reload();else document.getElementById('asave').textContent='Add a name or phone'}}
document.getElementById('addb').onclick=openAdd;if(location.hash==='#add')openAdd();{const m=/^#id=(\\d+)$/.exec(location.hash);if(m)open(+m[1])}
draw();
</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function csv(env, user = "") {
  await ensureTable(env.DB);
  const rs = await env.DB.prepare("SELECT * FROM leads ORDER BY created_at DESC, id DESC").all();
  const results = user === OWNER ? rs.results : rs.results.map(noAds);
  const cols = ["id", "created_at", "type", "name", "email", "phone", "service", "also_interested", "make", "year", "model", "message", "page", "referrer", "gclid", "gbraid", "wbraid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "stage", "value", "notes", "duration", "answered", "recording"];
  const q = v => { let s = String(v ?? ""); if (/^(=|@|[+\-][^\d(\s])/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const body = [cols.join(","), ...results.map(r => cols.map(c => q(r[c])).join(","))].join("\n");
  return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="divine-detailers-leads.csv"', "cache-control": "no-store" } });
}

// ---- Reminder: leads nobody has called yet (runs every minute from a Cloudflare cron trigger)
// REMIND_MINUTES: how long a lead may wait before a reminder goes out (default 10, set to 0 to turn reminders off)
// Reminders only go out during business hours (Mon to Sat, 9 to 6 Eastern), so overnight leads get one reminder when the shop opens.
// ---- Appointments: the "Scheduled" text saves the appointment on the lead (picker times are Eastern), moves the lead to Booked, and
// asks the agent to send a reminder: 24 hours before, or 2 hours before when the appointment is sooner than a day away.
function etLocalToUtc(str) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(String(str || ""));
  if (!m) return null;
  const [Y, Mo, D, h, mi] = m.slice(1).map(Number), want = Date.UTC(Y, Mo - 1, D, h, mi);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(t));
    const g = k => Number(parts.find(x => x.type === k).value);
    t -= Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - want;
  }
  return new Date(t);
}
const fmtAppt = str => { const d = etLocalToUtc(str); return d ? d.toLocaleString("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(/, (\d+:\d\d)/, " at $1") : ""; };
const sqlUtc = d => d.toISOString().slice(0, 19).replace("T", " ");
function reminderTime(d) {
  const now = Date.now();
  let r = d.getTime() - 24 * 36e5;
  if (r < now + 30 * 6e4) r = d.getTime() - 2 * 36e5;
  return r < now + 6e4 ? null : new Date(r);
}
// ---- Follow-up texts for leads nobody has reached. The CRM does not send texts itself: it sends a push "Send Antonio Text #2" and the tap
// opens Messages with the text filled in, so the agent only has to press send. Text #1 is due as soon as the lead arrives, #2 two hours after
// the lead (and after text #1), then #3 after 1 day, #4 after 3 days and #5 after 5 days. Only New and Not contacted leads, in calling hours.
const TEXT_PLAN_SECS = [0, 0, 2 * 3600, 86400, 3 * 86400, 5 * 86400]; // when each text is due, counted from the lead arriving (text #1 is immediate)
const TEXT_GAP_SECS = [0, 0, 2 * 3600, 12 * 3600, 12 * 3600, 12 * 3600]; // at least this long after the previous text
const TEXT_MAX = 5;
const textTemplateFor = (n, l) => n === 1 ? TEMPLATES.find(t => t.id === (/coating/i.test(l.service || "") ? "first_coating" : "first")) : TEMPLATES.find(t => t.id === "fu" + n);
function fillTemplate(t, l, env) {
  const veh = [l.year, l.make, l.model].filter(Boolean).join(" ") || "your vehicle", first = String(l.name || "").trim().split(/\s+/)[0];
  const v = { first: first && !/^\+?[\d\s()-]+$/.test(first) ? first : "there", service: String(l.service || "our services").toLowerCase(), vehicle: /your/.test(veh) ? veh : "your " + veh, shop: SHOP.name, phone: SHOP.phone, address: SHOP.address, review: reviewLink(env) };
  const f = x => x.replace(/\{(\w+)\}/g, (m, k) => (v[k] === undefined ? m : v[k])).replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { subject: f(t.subject), body: f(t.body) };
}
async function remindTexts(env) {
  if (!env.DB || env.TEXT_REMINDERS === "0") return;
  if (env.AUTO_DIAL_ANYTIME !== "1" && !inBusinessHours()) return;
  await ensureTable(env.DB);
  const auto = env.TEXT_AUTO === "1" && twilioOn(env);
  const rows = (await env.DB.prepare(`SELECT l.id, l.name, l.phone, l.service, l.year, l.make, l.model, l.created_at,
      (SELECT COUNT(*) FROM stage_log s WHERE s.lead_id = l.id AND s.reason LIKE 'Texted%' AND s.reason NOT LIKE 'Texted: Message%') AS texts,
      (SELECT MAX(s.at) FROM stage_log s WHERE s.lead_id = l.id AND s.reason LIKE 'Texted%') AS last_text,
      (SELECT COUNT(*) FROM messages m WHERE m.lead_id = l.id AND m.direction = 'in') AS replies
    FROM leads l WHERE l.stage IN ('new','nocontact') AND l.type != 'newsletter' AND COALESCE(l.ip,'') != 'demo' AND COALESCE(l.phone,'') != '' ${auto ? 'AND l.sms_consent = 1' : ''} AND l.created_at >= datetime('now','-8 days')
    ORDER BY l.created_at LIMIT 300`).all()).results || [];
  const ms = x => new Date(String(x).replace(" ", "T") + "Z").getTime();
  let sent = 0;
  for (const r of rows) {
    const n = r.texts + 1;
    if (n > TEXT_MAX) continue;
    if (Date.now() < Math.max(ms(r.created_at) + TEXT_PLAN_SECS[n] * 1000, r.last_text ? ms(r.last_text) + TEXT_GAP_SECS[n] * 1000 : 0)) continue;
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO text_reminders (lead_id, n) VALUES (?, ?)").bind(r.id, n).run();
    if (!claim.meta || !claim.meta.changes) continue;
    if (auto) {
      // sends itself. Once the lead has texted back, a person takes over and the automatic texts stop
      if (r.replies) continue;
      let body = fillTemplate(textTemplateFor(n, r), r, env).body;
      if (n === 1 && !/stop/i.test(body)) body += "\n\nMsg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.";
      const res = await sendLeadText(env, r, body, { auto: true, label: n === 1 ? "First reply" : "Follow-up #" + n });
      if (!res.ok && !res.optout) await env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) SELECT id, stage, stage, ?, 'system' FROM leads WHERE id = ?").bind("Auto text #" + n + " failed: " + String(res.message || "").slice(0, 120), r.id).run().catch(() => {});
      if (++sent >= 3) break;
      continue;
    }
    const first = String(r.name || "").trim().split(/\s+/)[0] || "lead", car = [r.year, r.make, r.model].filter(Boolean).join(" ");
    await sendPush(env, { title: `Send ${first} Text #${n}`, message: ["Tap to send", r.service, car].filter(Boolean).join(" · "), click: env.CRM_HOST ? `https://${env.CRM_HOST}/send/${r.id}?n=${n}` : undefined }).catch(() => {});
    if (++sent >= 3) break; // a few a minute, so a morning with many due leads does not arrive all at once
  }
}
async function sendPage(env, id, n, user) {
  await ensureTable(env.DB);
  const l = await env.DB.prepare("SELECT id,name,phone,service,year,make,model FROM leads WHERE id = ?").bind(id).first();
  if (!l) return new Response("Lead not found", { status: 404 });
  const num = Math.min(TEXT_MAX, Math.max(1, Number(n) || 1));
  const t = textTemplateFor(num, l), body = fillTemplate(t, l, env).body;
  const sms = `sms:${e164(l.phone)}?&body=${encodeURIComponent(body)}`, label = `Texted: ${num === 1 ? "First reply" : "Follow-up #" + num}`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Text #${num}</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07090c;color:#e8eaed;font:17px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;padding:20px;text-align:center}
main{width:min(440px,100%);display:flex;flex-direction:column;gap:12px}h1{margin:0;font-size:26px}p{margin:0;color:#98a0aa}
a.b{display:block;border-radius:16px;padding:22px;font-weight:800;text-decoration:none;font-size:22px;border:1px solid #2a313a;background:#151a21;color:#e8eaed}a.b.c{background:#32cd32;border-color:#32cd32;color:#04120a;font-size:24px}
.m{background:#0d1116;border-left:3px solid #32cd32;border-radius:0 10px 10px 0;padding:12px 14px;text-align:left;color:#d6d9de;font-size:15px;white-space:pre-line}.s{font-size:15px;font-weight:600;padding:16px}</style></head>
<body><main><h1>${esc(l.name || prettyPhone(l.phone))}</h1><p>Text #${num} &middot; ${esc([l.service, [l.year, l.make, l.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ") || "lead")}</p><div class="m">${esc(body)}</div>
<a class="b c" id="go" href="${esc(sms)}">Open Messages</a><a class="b s" href="/admin/pipeline#id=${l.id}">Open the lead</a>
<p style="font-size:13px">Opening Messages logs this text on the lead. Signed in as ${esc(user)}.</p></main>
<script>let logged=false;const go=document.getElementById('go');function note(){if(logged)return;logged=true;try{fetch('/admin/touch',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({id:${l.id},label:${JSON.stringify(label)}})})}catch(_){}}
go.addEventListener('click',note);setTimeout(()=>{note();location.href=go.getAttribute('href')},500);</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// ---- Twilio texting: send and receive texts inside the CRM (Messages tab), plus automatic follow-up texts ----
const twilioOn = env => !!(env.TWILIO_SID && env.TWILIO_TOKEN && (env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE));
const last10 = p => String(p || "").replace(/\D/g, "").slice(-10);
const OPT_OUT_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*[.!]*\s*$/i, OPT_IN_WORDS = /^\s*(start|unstop)\s*[.!]*\s*$/i;
async function isOptedOut(env, phone) {
  const d = last10(phone);
  return !!d && !!(await env.DB.prepare("SELECT 1 FROM sms_optout WHERE phone = ?").bind(d).first());
}
// send one text through Twilio and keep it in the lead's thread; calling or texting never moves the lead
async function sendLeadText(env, lead, body, { user = "system", auto = false, label = "" } = {}) {
  body = String(body || "").trim().slice(0, 1500);
  if (!body) return { ok: false, message: "Write a message first." };
  if (!twilioOn(env)) return { ok: false, message: "Texting is not set up yet." };
  const to = e164(lead.phone);
  if (!to) return { ok: false, message: "This lead has no phone number." };
  if (await isOptedOut(env, lead.phone)) return { ok: false, message: "This person replied STOP. Do not text them.", optout: true };
  const form = new URLSearchParams({ To: to, Body: body });
  if (env.TWILIO_MESSAGING_SERVICE) form.set("MessagingServiceSid", env.TWILIO_MESSAGING_SERVICE); else form.set("From", env.TWILIO_FROM);
  // the CRM host only serves the dashboard, so Twilio reports delivery to the public site address
  form.set("StatusCallback", `${env.PUBLIC_URL || "https://divinedetailers.com"}/api/twilio/status`);
  let j = {}, ok = false;
  try {
    const r = await fetch(`${env.TWILIO_API_BASE || "https://api.twilio.com"}/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, { method: "POST", headers: { authorization: "Basic " + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`), "content-type": "application/x-www-form-urlencoded" }, body: form.toString(), signal: AbortSignal.timeout(10000) });
    j = await r.json().catch(() => ({}));
    ok = r.ok && !!j.sid;
  } catch (e) { j = { message: "Could not reach Twilio." }; }
  const status = ok ? String(j.status || "queued") : "failed";
  const reason = auto ? `Texted: ${label || "Auto text"} (auto)` : `Texted: Message: ${body.slice(0, 80)}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO messages (lead_id, phone, direction, body, status, sid, by_user, auto, is_read, from_num, err) VALUES (?,?,?,?,?,?,?,?,1,?,?)").bind(lead.id, to, "out", body, status, ok ? j.sid : "", user, auto ? 1 : 0, normNum(env.TWILIO_FROM) || null, ok ? null : String(j.code || "").slice(0, 12) || null),
    ...(ok ? [env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) SELECT id, stage, stage, ?, ? FROM leads WHERE id = ?").bind(reason, user, lead.id)] : []),
  ]);
  return ok ? { ok: true } : { ok: false, message: String(j.message || "Twilio refused the text.").slice(0, 200) };
}
// Twilio signs each webhook: HMAC-SHA1 of the full URL plus the sorted form fields, keyed with the auth token
async function twilioSigOk(env, request, params) {
  if (!env.TWILIO_TOKEN) return false;
  const sig = request.headers.get("x-twilio-signature") || "";
  let data = request.url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TWILIO_TOKEN), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  let bin = ""; for (const b of mac) bin += String.fromCharCode(b);
  return !!sig && safeEqual(btoa(bin), sig);
}
const twiml = () => new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { headers: { "content-type": "text/xml" } });
async function handleTwilioSms(request, env) {
  if (!env.DB) return new Response("No database", { status: 503 });
  const params = Object.fromEntries(await request.formData().catch(() => new FormData()));
  if (!(await twilioSigOk(env, request, params))) return new Response("Forbidden", { status: 403 });
  await ensureTable(env.DB);
  const sid = String(params.MessageSid || params.SmsSid || ""), from = String(params.From || ""), body = String(params.Body || "").slice(0, 1500);
  if (!from) return twiml();
  if (sid && await env.DB.prepare("SELECT 1 FROM messages WHERE sid = ?").bind(sid).first()) return twiml();
  const d = last10(from);
  const cands = (await env.DB.prepare("SELECT id, name, phone FROM leads WHERE type != 'newsletter' AND COALESCE(ip,'') != 'demo' AND phone LIKE ? ORDER BY id DESC LIMIT 20").bind("%" + d.slice(-4) + "%").all()).results || [];
  let lead = cands.find(x => last10(x.phone) === d), fresh = false;
  if (!lead) {
    const ins = await env.DB.prepare("INSERT INTO leads (type,name,email,phone,service,make,year,model,message,utm_source,utm_medium,stage,value) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind("manual", prettyPhone(from), "", from, "", "", "", "", "", "Text message", "manual", "new", 0).run();
    lead = { id: ins.meta && ins.meta.last_row_id, name: prettyPhone(from), phone: from }; fresh = true;
  }
  await env.DB.prepare("INSERT INTO messages (lead_id, phone, direction, body, status, sid, by_user, auto, is_read) VALUES (?,?,?,?,?,?,?,?,0)").bind(lead.id, from, "in", body, "received", sid, "", 0).run();
  if (OPT_OUT_WORDS.test(body)) {
    await env.DB.batch([env.DB.prepare("INSERT OR IGNORE INTO sms_optout (phone) VALUES (?)").bind(d), env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) SELECT id, stage, stage, 'Replied STOP: no more texts', 'system' FROM leads WHERE id = ?").bind(lead.id)]);
    return twiml();
  }
  if (OPT_IN_WORDS.test(body)) await env.DB.prepare("DELETE FROM sms_optout WHERE phone = ?").bind(d).run();
  const first = String(lead.name || "").trim().split(/\s+/)[0] || prettyPhone(from);
  await sendPush(env, fresh
    ? { title: "New Lead Incoming", message: ["Text message", prettyPhone(from)].join(", "), click: env.CRM_HOST ? `https://${env.CRM_HOST}/messages#id=${lead.id}` : undefined }
    : { title: `Text from ${first}`, message: body.slice(0, 120), click: env.CRM_HOST ? `https://${env.CRM_HOST}/messages#id=${lead.id}` : undefined, users: [OWNER] }).catch(() => {});
  return twiml();
}
async function handleTwilioStatus(request, env) {
  if (!env.DB) return new Response("No database", { status: 503 });
  const params = Object.fromEntries(await request.formData().catch(() => new FormData()));
  if (!(await twilioSigOk(env, request, params))) return new Response("Forbidden", { status: 403 });
  const sid = String(params.MessageSid || params.SmsSid || ""), st = String(params.MessageStatus || params.SmsStatus || "");
  if (sid && st) await env.DB.prepare("UPDATE messages SET status = ?, err = COALESCE(NULLIF(?, ''), err) WHERE sid = ? AND direction = 'out'").bind(st.slice(0, 20), String(params.ErrorCode || "").slice(0, 12), sid).run();
  return twiml();
}
const isoUtc = t => String(t || "").replace(" ", "T") + "Z";
async function messageThreads(env, url) {
  await ensureTable(env.DB);
  const find = (url.searchParams.get("find") || "").trim().slice(0, 60);
  if (find) {
    const like = "%" + find.replace(/[%_]/g, "") + "%", dg = find.replace(/\D/g, "");
    const rs = (await env.DB.prepare("SELECT id, name, phone, service, stage FROM leads WHERE type != 'newsletter' AND COALESCE(ip,'') != 'demo' AND COALESCE(phone,'') != '' AND (name LIKE ? OR phone LIKE ?) ORDER BY id DESC LIMIT 15").bind(like, "%" + (dg.length >= 3 ? dg : "@@none@@") + "%").all()).results || [];
    return json({ success: true, found: rs });
  }
  const rs = (await env.DB.prepare(`SELECT l.id, l.name, l.phone, l.service, l.stage, l.starred, l.tags, l.value,
      (SELECT body FROM messages WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) last_body,
      (SELECT direction FROM messages WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) last_dir,
      (SELECT at FROM messages WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) last_at,
      ((SELECT COUNT(*) FROM messages WHERE lead_id = l.id AND direction = 'in' AND is_read = 0) + COALESCE(l.unread_flag, 0)) unread
    FROM leads l WHERE EXISTS (SELECT 1 FROM messages WHERE lead_id = l.id) ORDER BY last_at DESC, l.id DESC LIMIT 200`).all()).results || [];
  return json({ success: true, on: twilioOn(env), threads: rs.map(r => ({ ...r, last_at: isoUtc(r.last_at) })) });
}
async function messageThread(env, url, owner = false) {
  await ensureTable(env.DB);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id)) return json({ success: false }, 400);
  const lead = await env.DB.prepare("SELECT id, name, phone, email, service, stage, year, make, model, value, appt_at, follow_up, follow_up_date, created_at, utm_medium, utm_campaign, tags, starred, notes FROM leads WHERE id = ?").bind(id).first();
  if (!lead) return json({ success: false }, 404);
  await env.DB.batch([env.DB.prepare("UPDATE messages SET is_read = 1 WHERE lead_id = ? AND direction = 'in' AND is_read = 0").bind(id), env.DB.prepare("UPDATE leads SET unread_flag = 0 WHERE id = ?").bind(id)]);
  const q = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all().catch(() => ({ results: [] }))).results || [];
  const ms = await q("SELECT id, direction, body, status, auto, by_user, at FROM messages WHERE lead_id = ? ORDER BY id DESC LIMIT 300", id);
  // calls (dialer calls matched to their recording), notes, call results and stage moves share one timeline with the texts
  const calls = await q("SELECT call_sid, started_at, duration, by_user FROM dial_calls WHERE lead_id = ? ORDER BY id DESC LIMIT 60", id);
  const recs = await q("SELECT call_id, direction, url, duration, at FROM call_recordings WHERE lead_id = ? AND url != '' ORDER BY at DESC LIMIT 60", id);
  const logs = await q("SELECT from_stage, to_stage, reason, by_user, at FROM stage_log WHERE lead_id = ? ORDER BY id DESC LIMIT 150", id);
  const t2 = x => Date.parse(String(x).replace(" ", "T") + "Z"), used = new Set(), events = [];
  for (const c of calls) {
    let best = -1, bd = 9e15; recs.forEach((r, i) => { if (used.has(i)) return; const d = Math.abs(t2(r.at) - t2(c.started_at)); if (d < bd) { bd = d; best = i; } });
    const rec = best >= 0 && bd < 900000 ? (used.add(best), recs[best]) : null;
    events.push({ kind: "call", at: isoUtc(c.started_at), dur: c.duration || 0, by: c.by_user || "", url: owner && rec ? rec.url : "", dir: "out" });
  }
  recs.forEach((r, i) => { if (!used.has(i)) events.push({ kind: "call", at: isoUtc(r.at), dur: r.duration || 0, by: "", url: owner ? r.url : "", dir: r.direction === "inbound" ? "in" : "out" }); });
  for (const g of logs) {
    const r = g.reason || "";
    if (/^called \(in-app dialer\)/i.test(r) || /^texted/i.test(r)) continue;
    if (/^note:/i.test(r)) events.push({ kind: "note", at: isoUtc(g.at), text: r.replace(/^note:\s*/i, ""), by: g.by_user || "" });
    else if (/^call result:/i.test(r)) events.push({ kind: "result", at: isoUtc(g.at), text: r.replace(/^call result:\s*/i, ""), by: g.by_user || "" });
    else if (g.to_stage !== g.from_stage) events.push({ kind: "stage", at: isoUtc(g.at), text: "Moved to " + stageName(g.to_stage), by: g.by_user || "" });
  }
  const notes = owner ? (await callNotes(env, id).catch(() => [])).filter(n => n.summary).slice(0, 3) : [];
  return json({ success: true, lead: { ...lead, tags: String(lead.tags || "").split(",").filter(Boolean), stage_label: stageName(lead.stage), created_at: isoUtc(lead.created_at) }, on: twilioOn(env), optout: await isOptedOut(env, lead.phone), messages: ms.reverse().map(m => ({ ...m, at: isoUtc(m.at) })), events, notes });
}
async function messagesPage(env, user) {
  await ensureTable(env.DB);
  const tc = await todayCount(env), owner = user === OWNER;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">${PWA_HEAD}<title>Conversations | Divine Detailers</title>
<style>
*{box-sizing:border-box}html,body{height:100%}body{font:14.5px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:var(--bg,#07090c);color:var(--text,#e8eaed);display:flex;flex-direction:column}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px;flex-wrap:wrap}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}.navtabs a.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
.app{flex:1;min-height:0;display:grid;grid-template-columns:350px minmax(0,1fr) 330px}.app.noinfo{grid-template-columns:350px minmax(0,1fr)}
.list{border-right:1px solid var(--line,#1b2128);min-height:0;display:flex;flex-direction:column;background:#090c10}
.lh{padding:14px 16px 6px;display:flex;align-items:center;justify-content:space-between}.lh b{font-size:16px}
.tb{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:6px 10px 10px;border-bottom:1px solid var(--line,#1b2128)}
.tb button{background:none;border:0;color:#8a939e;font:inherit;font-size:12.5px;font-weight:650;padding:8px 2px;border-radius:10px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:3px}.tb button i{font-style:normal;font-size:11px;min-width:20px;border-radius:999px;background:#151b22;color:#aab0b9;padding:1px 6px}
.tb button.on{background:#0f2c18;color:#4fdc5a}.tb button.on i{background:#1f6a37;color:#eafbea}.tb button.hot i{background:#2f7bff;color:#fff}
.sr{padding:10px 10px 0}.sr input{width:100%;background:#0d1217;border:1px solid #1d252e;color:#fff;border-radius:11px;padding:10px 12px;font:inherit;font-size:14px}
.fl{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--line,#1b2128)}.fl select{flex:1 1 0;min-width:0;background:#0d1217;border:1px solid #1d252e;color:#aab0b9;border-radius:9px;padding:6px 8px;font:inherit;font-size:12.5px;color-scheme:dark}
.tl{overflow-y:auto;flex:1;min-height:0}
.th{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:2px 11px;align-items:center;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid #12171d;color:inherit;font:inherit;padding:12px 14px;cursor:pointer;border-left:3px solid transparent}
.th:hover{background:#0d1217}.th.on{background:#0f1a14;border-left-color:#32cd32}
.av{width:40px;height:40px;border-radius:50%;background:linear-gradient(145deg,#1b5d30,#0f3a1f);color:#c9f7c9;font-weight:800;display:grid;place-items:center;font-size:14px;grid-row:1/3}
.th .nm{display:flex;align-items:center;gap:6px;min-width:0;font-weight:650}.th .nm span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.th .tm{color:#7c838d;font-size:11.5px;white-space:nowrap;text-align:right}
.th .sn{grid-column:2/3;color:#8f98a3;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.th .rt{grid-column:3;grid-row:2;display:flex;align-items:center;gap:6px;justify-content:flex-end}
.th.unr .nm{color:#fff}.th.unr .sn{color:#cfd6de}.un{background:#2f7bff;color:#fff;border-radius:999px;font-size:11px;font-weight:800;min-width:19px;text-align:center;padding:1px 6px}
.st{background:none;border:0;color:#4b5560;font-size:16px;cursor:pointer;padding:0;line-height:1}.st.on{color:#ffcc4d}.st:hover{color:#ffcc4d}
.pane{display:flex;flex-direction:column;min-height:0;min-width:0;background:#0a0d11}
.ph{display:flex;gap:12px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--line,#1b2128);background:#0b0f13}.ph .t{flex:1;min-width:0}.ph .t b{display:block;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ph .t span{color:#7c838d;font-size:12.5px}
.bk{display:none;background:#151a21;border:1px solid #2a313a;color:#e8eaed;border-radius:10px;padding:8px 12px;font:inherit;cursor:pointer}
.ib{border:1px solid #232b34;background:#10151b;color:#cfd6de;text-decoration:none;border-radius:10px;padding:8px 12px;font:inherit;font-size:13.5px;font-weight:650;cursor:pointer;display:inline-flex;align-items:center;gap:6px}.ib:hover{border-color:#34404c;color:#fff}.ib.g{background:#32cd32;border-color:#32cd32;color:#04120a}.ib.on{color:#ffcc4d;border-color:#5a4a1f}
.msgs{flex:1;min-height:0;overflow-y:auto;padding:16px 22px;display:flex;flex-direction:column;gap:7px;-webkit-overflow-scrolling:touch}
.dv{align-self:center;margin:10px 0 4px;font-size:12px;color:#7c838d;background:#0f141a;border:1px solid #1b2128;border-radius:999px;padding:3px 14px}
.m{max-width:min(72%,560px);padding:9px 13px;border-radius:16px;white-space:pre-wrap;overflow-wrap:anywhere}.m.out{align-self:flex-end;background:#16452a;color:#eafbea;border-bottom-right-radius:5px}.m.in{align-self:flex-start;background:#18202a;border-bottom-left-radius:5px}
.mt{font-size:11.5px;color:#6f7782;margin:-3px 6px 3px}.mt.out{align-self:flex-end}.mt.in{align-self:flex-start}
.cc{align-self:center;width:min(92%,520px);background:#0e151b;border:1px solid #1f2b35;border-radius:14px;padding:10px 14px;display:flex;flex-direction:column;gap:7px}.cc .h{display:flex;align-items:center;gap:9px;font-weight:650}.cc .h svg{width:18px;height:18px;stroke:#4fdc5a;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.cc small{color:#7c838d;font-weight:400}.cc audio{width:100%;height:36px;color-scheme:dark}
.ev{align-self:center;font-size:12.5px;color:#9fe29f;background:#0d1c13;border:1px solid #1b3a26;border-radius:999px;padding:4px 13px;display:flex;gap:8px}.ev small{color:#6f7782}.ev.stage{color:#aab0b9;background:#10151b;border-color:#1f2830}
.nt{align-self:center;width:min(92%,520px);background:#1b1708;border:1px solid #3a3213;border-radius:12px;padding:8px 13px;color:#ecd9a0;font-size:13.5px;white-space:pre-wrap}.nt small{display:block;color:#8a7d4a;margin-bottom:2px}
.empty{margin:auto;color:#7c838d;text-align:center;padding:20px}
.cmp{display:flex;gap:8px;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--line,#1b2128);align-items:flex-end;background:#0b0f13}
.cmp textarea{flex:1;min-width:0;background:#0d1217;border:1px solid #1d252e;color:#fff;border-radius:14px;padding:11px 13px;font:inherit;font-size:15px;resize:none;max-height:140px;min-height:44px}
.cmp #sd{background:#32cd32;border:0;color:#04120a;border-radius:12px;padding:0 20px;font:inherit;font-weight:800;min-height:44px;cursor:pointer}.cmp #sd:disabled{opacity:.4}.cmp #snb{min-height:44px}
.cmp{position:relative}.snp{position:absolute;bottom:calc(100% + 6px);left:16px;width:min(440px,calc(100% - 32px));max-height:340px;overflow-y:auto;background:#0e141a;border:1px solid #232b34;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.6);padding:8px;display:flex;flex-direction:column;gap:4px;z-index:30}.snp[hidden]{display:none}.snp input{width:100%;background:#0b1015;border:1px solid #1d252e;color:#fff;border-radius:9px;padding:8px 10px;font:inherit;font-size:13.5px}.snp [data-sn]{text-align:left;background:none;border:0;border-radius:9px;padding:8px 10px;color:inherit;font:inherit;cursor:pointer;display:flex;flex-direction:column;gap:2px}.snp [data-sn]:hover{background:#141d26}.snp [data-sn] b{font-size:13.5px}.snp [data-sn] span{color:#8a939e;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.snp .mg{background:none;border:0;color:#8ec0ff;font:inherit;font-size:13px;cursor:pointer;padding:8px 10px;text-align:left}
#sndlg{background:#0f1319;color:#e8eaed;border:1px solid #2a313a;border-radius:16px;padding:18px;width:min(560px,94vw);max-height:90vh;overflow:auto}#sndlg::backdrop{background:rgba(0,0,0,.65)}.sdh{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:17px}.snr{display:flex;flex-direction:column;gap:6px;border:1px solid #1d242c;border-radius:12px;padding:10px;margin-bottom:10px}.snr input,.snr textarea{background:#0b1015;border:1px solid #1d252e;color:#fff;border-radius:9px;padding:8px 10px;font:inherit;font-size:14px;width:100%;resize:vertical}.snb2{display:flex;gap:8px}
.warn{background:#2a1d0e;color:#ffb86b;padding:10px 16px;font-size:13.5px;border-bottom:1px solid #3a2a14}.err{color:#ff8a8a;padding:0 16px 6px;font-size:13px;min-height:0}
.info{border-left:1px solid var(--line,#1b2128);overflow-y:auto;min-height:0;background:#090c10;padding:16px;display:flex;flex-direction:column;gap:14px}.info[hidden]{display:none}
.ic0{display:flex;gap:12px;align-items:center}.ic0 .av{width:52px;height:52px;font-size:18px;grid-row:auto}.ic0 b{display:block;font-size:17px}.ic0 span{color:#7c838d;font-size:12.5px}
.sec{background:#0d1217;border:1px solid #181f27;border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}.sec h4{margin:0;font-size:11px;letter-spacing:1.1px;text-transform:uppercase;color:#7c838d}
.kv{display:grid;grid-template-columns:96px 1fr;gap:6px 10px;font-size:13.5px}.kv span{color:#7c838d}.kv b{font-weight:600;overflow-wrap:anywhere}.kv a{color:#8ec0ff;text-decoration:none}
.tg{display:flex;flex-wrap:wrap;gap:6px}.tg span{display:inline-flex;align-items:center;gap:5px;background:#142029;border:1px solid #20323f;color:#b9d7ee;border-radius:999px;padding:3px 6px 3px 11px;font-size:12.5px}.tg span button{background:none;border:0;color:#6f8aa0;cursor:pointer;font-size:14px;padding:0 3px;line-height:1}
.tg input{background:#0b1015;border:1px dashed #2a3642;color:#fff;border-radius:999px;padding:4px 11px;font:inherit;font-size:12.5px;width:110px}
.sm{font-size:13px;color:#cfd6de;white-space:pre-wrap}.sm small{display:block;color:#6f7782;margin-bottom:2px}
.pill2{display:inline-block;background:#0f2c18;color:#4fdc5a;border:1px solid #1f6a37;border-radius:999px;padding:2px 11px;font-size:12px;font-weight:700}
${BNAV_CSS}
@media(max-width:1279px){.app{grid-template-columns:330px minmax(0,1fr)}.info{position:fixed;top:0;right:0;bottom:0;width:min(360px,100vw);z-index:40;box-shadow:-20px 0 60px rgba(0,0,0,.6)}}
@media(max-width:700px){header{padding:10px 14px}h1{font-size:17px}.app,.app.noinfo{grid-template-columns:1fr}.pane{display:none}.app.open .list{display:none}.app.open .pane{display:flex}.bk{display:block}.m{max-width:86%}.msgs{padding:12px}.th{padding:13px 12px}}
</style></head><body>
<header><h1>Divine Detailers <b>conversations</b></h1>${nav("messages", tc, owner)}</header>
${bnav("messages", tc, owner)}
<div class="app noinfo" id="app"><aside class="list"><div class="lh"><b>Team inbox</b></div><div class="tb" id="tb"></div><div class="sr"><input id="q" placeholder="Search a lead to text" autocomplete="off"></div><div class="fl" id="fl"></div><div class="tl" id="tl"></div></aside>
<section class="pane" id="pane"><div class="empty" id="ph0">Pick a conversation, or search for a lead to start one.</div></section>
<aside class="info" id="info" hidden></aside></div>
<script>
const IS_OWNER=${owner};
const $=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const app=document.getElementById('app'),tl=document.getElementById('tl'),pane=document.getElementById('pane'),q=document.getElementById('q'),info=document.getElementById('info');
let cur=null,on=true,busy=false,lastSig='',TH=[],TAB='all',FL={sort:'recent',svc:'all'},showInfo=false,D=null;
try{Object.assign(FL,JSON.parse(localStorage.getItem('mf')||'{}'));TAB=localStorage.getItem('mt')||'all';showInfo=localStorage.getItem('mi')==='1'}catch(_){}
const nm=l=>l.name||l.phone||'Lead',ini=l=>{const w=String(l.name||'').trim().split(/\\s+/).filter(Boolean);return ((w[0]||'?')[0]+((w[1]||'')[0]||'')).toUpperCase()};
function ago(iso){const d=new Date(iso),s=Math.max(0,(Date.now()-d)/1000);if(s<60)return 'now';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});if(s<604800)return d.toLocaleDateString('en-US',{weekday:'short'});return d.toLocaleDateString('en-US',{month:'short',day:'numeric'})}
const svcOf=t=>/tint/i.test(t.service||'')?'Window Tint':/coat/i.test(t.service||'')?'Ceramic Coating':(t.service||'Other');
const TABS=[['unread','Unread'],['all','All'],['recent','Recent'],['starred','Starred']];
const isRecent=t=>Date.now()-new Date(t.last_at).getTime()<3*864e5;
function drawTabs(){const n={unread:TH.filter(t=>t.unread>0).length,all:TH.length,recent:TH.filter(isRecent).length,starred:TH.filter(t=>t.starred).length};
  document.getElementById('tb').innerHTML=TABS.map(x=>'<button type="button" data-t="'+x[0]+'" class="'+(TAB===x[0]?'on':'')+(x[0]==='unread'&&n.unread?' hot':'')+'">'+x[1]+'<i>'+n[x[0]]+'</i></button>').join('')}
function drawFl(){const sv=[...new Set(TH.map(svcOf))].sort();const opt=(v,l,c)=>'<option value="'+$(v)+'"'+(c===v?' selected':'')+'>'+$(l)+'</option>';
  document.getElementById('fl').innerHTML='<select data-k="sort" aria-label="Sort">'+[['recent','Newest first'],['oldest','Oldest first'],['unread','Unread first'],['name','Name A-Z']].map(x=>opt(x[0],x[1],FL.sort)).join('')+'</select><select data-k="svc" aria-label="Service">'+opt('all','All services',FL.svc)+sv.map(x=>opt(x,x,FL.svc)).join('')+'</select>'}
function drawList(){let a=TH.slice();
  if(TAB==='unread')a=a.filter(t=>t.unread>0);else if(TAB==='recent')a=a.filter(isRecent);else if(TAB==='starred')a=a.filter(t=>t.starred);
  if(FL.svc!=='all')a=a.filter(t=>svcOf(t)===FL.svc);
  const T=t=>new Date(t.last_at).getTime()||0;
  if(FL.sort==='oldest')a.sort((x,y)=>T(x)-T(y));else if(FL.sort==='unread')a.sort((x,y)=>(y.unread>0)-(x.unread>0)||T(y)-T(x));else if(FL.sort==='name')a.sort((x,y)=>nm(x).localeCompare(nm(y)));else a.sort((x,y)=>T(y)-T(x));
  drawTabs();
  tl.innerHTML=a.length?a.map(t=>'<div class="th'+(cur&&cur.id===t.id?' on':'')+(t.unread?' unr':'')+'" data-id="'+t.id+'" role="button" tabindex="0"><span class="av">'+$(ini(t))+'</span><span class="nm"><span>'+$(nm(t))+'</span></span><span class="tm">'+ago(t.last_at)+'</span><span class="sn">'+(t.last_dir==='out'?'You: ':'')+$(t.last_body)+'</span><span class="rt">'+(t.unread?'<span class="un">'+t.unread+'</span>':'')+'<button type="button" class="st'+(t.starred?' on':'')+'" data-star="'+t.id+'" aria-label="Star">'+(t.starred?'&#9733;':'&#9734;')+'</button></span></div>').join(''):'<div class="empty">'+(TH.length?'Nothing here with these filters.':'No texts yet. Search for a lead above to start one.')+'</div>'}
document.getElementById('tb').addEventListener('click',e=>{const b=e.target.closest('[data-t]');if(!b)return;TAB=b.dataset.t;try{localStorage.setItem('mt',TAB)}catch(_){}drawList()});
document.getElementById('fl').addEventListener('change',e=>{const k=e.target.dataset.k;if(!k)return;FL[k]=e.target.value;try{localStorage.setItem('mf',JSON.stringify(FL))}catch(_){}drawList()});
async function loadList(){try{const r=await fetch('/admin/threads');if(!r.ok)return;const j=await r.json();on=j.on;TH=j.threads;if(!document.getElementById('fl').children.length||(document.activeElement&&document.activeElement.closest&&!document.activeElement.closest('#fl')))drawFl();drawList()}catch(_){}}
async function toggleStar(id,val){try{await fetch('/admin/star',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,on:val})})}catch(_){}const t=TH.find(x=>x.id===id);if(t)t.starred=val?1:0;if(D&&D.lead.id===id){D.lead.starred=val?1:0;const b=document.getElementById('stb');if(b){b.classList.toggle('on',!!val);b.innerHTML=(val?'&#9733;':'&#9734;')+' '+(val?'Starred':'Star')}}drawList()}
const day=d=>{const t=new Date(d),n=new Date(),a=new Date(t.getFullYear(),t.getMonth(),t.getDate()),b=new Date(n.getFullYear(),n.getMonth(),n.getDate()),diff=Math.round((b-a)/864e5);return diff===0?'Today':diff===1?'Yesterday':t.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})};
const hm=iso=>new Date(iso).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
const mmss=s=>Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
const PHONE='<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>';
function timeline(j){const items=j.messages.map(m=>({k:'m',at:m.at,m:m})).concat(j.events.map(e=>({k:e.kind,at:e.at,e:e})));items.sort((a,b)=>new Date(a.at)-new Date(b.at));
  let last='',h='';items.forEach(it=>{const dv=day(it.at);if(dv!==last){last=dv;h+='<div class="dv">'+$(dv)+'</div>'}
    if(it.k==='m'){const m=it.m;h+='<div class="m '+m.direction+'">'+$(m.body)+'</div><div class="mt '+m.direction+'">'+hm(m.at)+(m.direction==='out'?(m.by_user&&!m.auto?' &middot; '+$(m.by_user):'')+(m.auto?' &middot; auto':'')+(m.status==='failed'||m.status==='undelivered'?' &middot; not delivered':m.status==='delivered'?' &middot; delivered':''):'')+'</div>'}
    else if(it.k==='call'){const e=it.e;h+='<div class="cc"><div class="h">'+PHONE+'<span>'+(e.dir==='in'?'Incoming call':'Call')+(e.dur?' &middot; '+mmss(e.dur):' &middot; not connected')+' <small>'+(e.by?$(e.by)+' &middot; ':'')+hm(e.at)+'</small></span></div>'+(e.url?'<audio controls preload="none" src="'+$(e.url)+'"></audio>':'')+'</div>'}
    else if(it.k==='result')h+='<div class="ev">Result: '+$(it.e.text)+' <small>'+hm(it.at)+'</small></div>';
    else if(it.k==='stage')h+='<div class="ev stage">'+$(it.e.text)+' <small>'+hm(it.at)+'</small></div>';
    else if(it.k==='note')h+='<div class="nt"><small>Note &middot; '+(it.e.by?$(it.e.by)+' &middot; ':'')+hm(it.at)+'</small>'+$(it.e.text)+'</div>'});
  return h||'<div class="empty">No messages yet. Say hello.</div>'}
function drawInfo(j){const l=j.lead,car=[l.year,l.make,l.model].filter(Boolean).join(' '),kv=(k,v)=>v?'<span>'+k+'</span><b>'+v+'</b>':'';
  const ap=l.appt_at?new Date(l.appt_at.replace(' ','T')).toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
  info.innerHTML='<div class="ic0"><span class="av">'+$(ini(l))+'</span><div><b>'+$(nm(l))+'</b><span>'+$(l.phone||'')+'</span></div></div>'
   +'<div class="sec"><h4>Details</h4><div class="kv">'+kv('Stage','<span class="pill2">'+$(l.stage_label)+'</span>')+kv('Phone',l.phone?'<a href="tel:'+$(l.phone)+'">'+$(l.phone)+'</a>':'')+kv('Email',l.email?'<a href="mailto:'+$(l.email)+'">'+$(l.email)+'</a>':'')+kv('Service',$(l.service||''))+kv('Vehicle',$(car))+kv('Value',l.value?'$'+Number(l.value).toLocaleString('en-US'):'')+kv('Appointment',$(ap))+kv('Follow up',$((l.follow_up||'')+(l.follow_up_date?' '+l.follow_up_date:'')))+kv('Source',$(l.utm_medium==='paid_social'?'Facebook / Meta ads':(l.utm_campaign||'')))+kv('Came in',$(day(l.created_at)))+'</div></div>'
   +'<div class="sec"><h4>Tags</h4><div class="tg" id="tg">'+l.tags.map(t=>'<span>'+$(t)+'<button type="button" data-rt="'+$(t)+'" aria-label="Remove">&times;</button></span>').join('')+'<input id="tin" placeholder="+ add tag" maxlength="24"></div></div>'
   +'<div class="sec"><h4>Notes</h4>'+(l.notes?'<div class="sm" style="max-height:180px;overflow-y:auto">'+String(l.notes).split('\\n').filter(Boolean).reverse().map(n=>'<div style="padding:4px 0;border-bottom:1px solid #141a20">'+$(n)+'</div>').join('')+'</div>':'<div class="note">No notes yet.</div>')+'<textarea id="nin" rows="2" placeholder="Add a note" style="width:100%;background:#0b1015;border:1px solid #1d252e;color:#fff;border-radius:10px;padding:8px 10px;font:inherit;font-size:13.5px;resize:vertical"></textarea><button type="button" class="ib" id="nadd">Add note</button></div>'
   +(j.notes&&j.notes.length?'<div class="sec"><h4>Call notes</h4>'+j.notes.map(n=>'<div class="sm"><small>'+$(n.at)+'</small>'+$(n.summary)+'</div>').join('')+'</div>':'')
   +'<div class="sec"><h4>Actions</h4><div style="display:flex;gap:8px;flex-wrap:wrap"><a class="ib g" href="'+(IS_OWNER?'/admin/dialer?lead='+l.id:'tel:'+$(l.phone||''))+'">Call</a><a class="ib" href="/admin/pipeline#id='+l.id+'">Open lead</a></div></div>';
  info.hidden=!showInfo;app.classList.toggle('noinfo',!showInfo)}
info.addEventListener('click',async e=>{if(e.target.id==='nadd'&&D){const t=document.getElementById('nin').value.trim();if(!t)return;e.target.disabled=true;try{await fetch('/admin/note',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:D.lead.id,text:t})})}catch(_){}lastSig='';await open(D.lead.id,false);return}const b=e.target.closest('[data-rt]');if(!b||!D)return;D.lead.tags=D.lead.tags.filter(t=>t!==b.dataset.rt);await saveTags();drawInfo(D)});
info.addEventListener('keydown',async e=>{if(e.target.id!=='tin'||e.key!=='Enter'||!D)return;e.preventDefault();const v=e.target.value.trim();if(!v)return;if(D.lead.tags.indexOf(v)<0)D.lead.tags.push(v);await saveTags();drawInfo(D);const t=document.getElementById('tin');if(t)t.focus()});
async function saveTags(){try{const r=await fetch('/admin/tags',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:D.lead.id,tags:D.lead.tags})});const j=await r.json();if(j.success)D.lead.tags=j.tags}catch(_){}}
let SN=[],SNF=[];async function loadSn(){try{const j=await (await fetch('/admin/snippets')).json();if(j.success){SN=j.snippets;SNF=j.fields}}catch(_){}}
function snMenu(f){const p=document.getElementById('snp');if(!p)return;const fl=(f||'').toLowerCase(),a=SN.filter(x=>!fl||x.name.toLowerCase().indexOf(fl)>=0||x.body.toLowerCase().indexOf(fl)>=0);
  p.innerHTML='<input id="snq" placeholder="Search snippets" autocomplete="off" value="'+$(f||'')+'">'+(a.length?a.map(x=>'<button type="button" data-sn="'+x.id+'"><b>'+$(x.name)+'</b><span>'+$(x.body)+'</span></button>').join(''):'<div class="empty">No snippets match.</div>')+'<button type="button" class="mg" id="snm">Manage snippets</button>';p.hidden=false;
  const q=document.getElementById('snq');q.focus();q.setSelectionRange(q.value.length,q.value.length);q.oninput=()=>snMenu(q.value);q.onkeydown=e=>{if(e.key==='Escape'){p.hidden=true;document.getElementById('tx').focus()}else if(e.key==='Enter'){const f1=p.querySelector('[data-sn]');if(f1)f1.click()}}}
document.addEventListener('click',async e=>{const p=document.getElementById('snp');if(!p)return;const b=e.target.closest('[data-sn]');
  if(b&&p.contains(b)){let t='';try{const j=await (await fetch('/admin/snippets/render?id='+b.dataset.sn+'&lead='+(cur?cur.id:''))).json();t=j.text||''}catch(_){}const tx=document.getElementById('tx');if(tx&&t){tx.setRangeText((tx.value&&!/\s$/.test(tx.value)?' ':'')+t,tx.selectionStart,tx.selectionEnd,'end');tx.focus()}p.hidden=true;return}
  if(e.target.id==='snm'){p.hidden=true;snManage();return}
  if(!p.hidden&&!e.target.closest('#snp')&&e.target.id!=='snb')p.hidden=true});
function snManage(){let d=document.getElementById('sndlg');if(!d){d=document.createElement('dialog');d.id='sndlg';document.body.appendChild(d)}
  const row=x=>'<div class="snr" data-id="'+(x?x.id:'')+'"><input class="snn" placeholder="Name" maxlength="60" value="'+$(x?x.name:'')+'"><textarea class="snt" rows="3" placeholder="Text. Use {first}, {service}, {vehicle}, {appointment}, {shop}, {address}">'+$(x?x.body:'')+'</textarea><div class="snb2"><button type="button" class="ib g" data-save="1">'+(x?'Save':'Add snippet')+'</button>'+(x?'<button type="button" class="ib" data-del="1">Delete</button>':'')+'</div></div>';
  d.innerHTML='<div class="sdh"><b>Text snippets</b><button type="button" class="ib" id="sdx">Close</button></div><p class="note" style="margin:0 0 10px">Fields fill in for each lead: '+SNF.map(f=>'{'+f+'}').join(' ')+'</p>'+row(null)+SN.map(row).join('');
  d.querySelector('#sdx').onclick=()=>d.close();
  d.onclick=async e=>{const r=e.target.closest('.snr');if(!r)return;const id=r.dataset.id?+r.dataset.id:null;
    if(e.target.dataset.del){await fetch('/admin/snippets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,delete:true})});await loadSn();snManage();return}
    if(e.target.dataset.save){const name=r.querySelector('.snn').value.trim(),body=r.querySelector('.snt').value.trim();if(!name||!body)return;await fetch('/admin/snippets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,name:name,body:body})});await loadSn();snManage()}};
  if(!d.open)d.showModal()}
async function open(id,keep){try{const r=await fetch('/admin/thread?id='+id);if(!r.ok)return;const j=await r.json();const lm=j.messages.length?j.messages[j.messages.length-1]:{};const sig=j.messages.length+':'+(lm.id||'')+(lm.status||'')+j.optout+':'+j.events.length+':'+j.lead.stage+':'+j.lead.starred+':'+j.lead.tags.join();
  if(keep&&cur&&cur.id===id&&sig===lastSig)return;lastSig=sig;cur=j.lead;D=j;on=j.on;
  const box=pane.querySelector('.msgs'),atEnd=!box||box.scrollHeight-box.scrollTop-box.clientHeight<80;const draft=pane.querySelector('textarea')?pane.querySelector('textarea').value:'';
  const car=[j.lead.year,j.lead.make,j.lead.model].filter(Boolean).join(' ');
  pane.innerHTML='<div class="ph"><button class="bk" id="bk">Back</button><span class="av" style="width:40px;height:40px">'+$(ini(j.lead))+'</span><div class="t"><b>'+$(nm(j.lead))+'</b><span>'+$([j.lead.service,car].filter(Boolean).join(' · ')||j.lead.phone)+'</span></div><button type="button" class="ib'+(j.lead.starred?' on':'')+'" id="stb">'+(j.lead.starred?'&#9733; Starred':'&#9734; Star')+'</button><button type="button" class="ib" id="mub" title="Mark as unread and close">Mark unread</button><a class="ib g" href="'+(IS_OWNER?'/admin/dialer?lead='+j.lead.id:'tel:'+$(j.lead.phone||''))+'">Call</a><button type="button" class="ib" id="inb">Info</button></div>'
   +(!on?'<div class="warn">Texting is not set up yet. Add the Twilio keys in Cloudflare to send texts from here.</div>':'')+(j.optout?'<div class="warn">This person replied STOP. They cannot be texted.</div>':'')
   +'<div class="msgs" id="ms">'+timeline(j)+'</div><div class="err" id="er"></div>'
   +'<div class="cmp"><div class="snp" id="snp" hidden></div><button type="button" class="ib" id="snb" title="Insert a saved text (or type / )">Snippets</button><textarea id="tx" rows="1" placeholder="Type a message, or / for snippets"'+(on&&!j.optout?'':' disabled')+'></textarea><button id="sd"'+(on&&!j.optout?'':' disabled')+'>Send</button></div>';
  const ms=document.getElementById('ms');if(!keep||atEnd)ms.scrollTop=ms.scrollHeight;const tx=document.getElementById('tx');tx.value=draft;
  document.getElementById('bk').onclick=()=>{app.classList.remove('open');cur=null;D=null;history.replaceState(null,'','#');loadList()};
  document.getElementById('stb').onclick=()=>toggleStar(j.lead.id,!D.lead.starred);
  document.getElementById('inb').onclick=()=>{showInfo=!showInfo;try{localStorage.setItem('mi',showInfo?'1':'0')}catch(_){}info.hidden=!showInfo;app.classList.toggle('noinfo',!showInfo)};
  document.getElementById('sd').onclick=send;tx.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}else if(e.key==='/'&&!tx.value){e.preventDefault();snMenu('')}});
  document.getElementById('snb').onclick=()=>{const p=document.getElementById('snp');if(p.hidden)snMenu('');else p.hidden=true};
  document.getElementById('mub').onclick=async()=>{const id=cur.id;try{await fetch('/admin/markunread',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})})}catch(_){}cur=null;D=null;lastSig='';app.classList.remove('open');pane.innerHTML='<div class="empty" id="ph0">Marked unread. Pick a conversation.</div>';history.replaceState(null,'','#');info.hidden=true;loadList()};
  const ti=document.activeElement&&document.activeElement.id==='tin';if(!ti)drawInfo(j);
  app.classList.add('open');if(!keep)history.replaceState(null,'','#id='+id);loadList()}catch(_){}}
async function send(){if(busy||!cur)return;const tx=document.getElementById('tx'),er=document.getElementById('er'),b=tx.value.trim();if(!b)return;busy=true;document.getElementById('sd').disabled=true;er.textContent='';
  try{const r=await fetch('/admin/msg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:cur.id,body:b})});const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.success){er.textContent=j.message||'Could not send. Try again.';busy=false;document.getElementById('sd').disabled=false;return}
    tx.value='';busy=false;lastSig='';await open(cur.id,false)}catch(_){er.textContent='No connection. Try again.';busy=false;document.getElementById('sd').disabled=false}}
tl.addEventListener('click',e=>{const s=e.target.closest('[data-star]');if(s){e.stopPropagation();const id=+s.dataset.star,t=TH.find(x=>x.id===id);toggleStar(id,!(t&&t.starred));return}const b=e.target.closest('.th,.fd');if(b)open(+b.dataset.id)});
tl.addEventListener('keydown',e=>{if(e.key==='Enter'){const b=e.target.closest('.th,.fd');if(b)open(+b.dataset.id)}});
let qt;q.addEventListener('input',()=>{clearTimeout(qt);const v=q.value.trim();if(!v){loadList();return}qt=setTimeout(async()=>{try{const r=await fetch('/admin/threads?find='+encodeURIComponent(v));const j=await r.json();tl.innerHTML=(j.found&&j.found.length?j.found.map(l=>'<div class="th fd" data-id="'+l.id+'" role="button" tabindex="0"><span class="av">'+$(ini(l))+'</span><span class="nm"><span>'+$(nm(l))+'</span></span><span class="tm"></span><span class="sn">'+$([l.phone,l.service].filter(Boolean).join(' · '))+'</span></div>').join(''):'<div class="empty">No lead found.</div>')}catch(_){}},250)});
loadSn();const hmm=/^#id=(\\d+)$/.exec(location.hash);loadList();if(hmm)open(+hmm[1]);
setInterval(()=>{if(document.hidden||q.value.trim())return;loadList();if(cur&&!(document.activeElement&&document.activeElement.id==='tin'))open(cur.id,true)},6000);
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// reusable texts. The starter set only goes in the first time; after that they are yours to edit or delete. {first}, {service}, {vehicle}, {appointment}, {shop}, {address} fill in per lead.
async function snippetList(env) {
  let rows = (await env.DB.prepare("SELECT id, name, body FROM snippets ORDER BY name COLLATE NOCASE").all()).results || [];
  const seeded = await env.DB.prepare("SELECT 1 FROM dial_settings WHERE k = 'snippets_seeded'").first().catch(() => null);
  if (!rows.length && !seeded) {
    const base = [
      ["Intro", "Hey {first}, it's from {shop}. I saw you asked about {service} for {vehicle}. Do you have a minute to talk?"],
      ["Missed you", "Hey {first}, I just tried to call you about {service} for {vehicle}. What's a good time to reach you?"],
      ["Quote follow-up", "Hey {first}, just checking in on the quote for {vehicle}. Any questions I can answer?"],
      ["Appointment reminder", "Hey {first}, a reminder about {appointment} at {shop}. Reply here if anything changes."],
      ["Address", "We're at {address}. See you soon!"],
    ];
    await env.DB.batch(base.map(([n, t]) => env.DB.prepare("INSERT INTO snippets (name, body) VALUES (?, ?)").bind(n, t)));
    await env.DB.prepare("INSERT OR IGNORE INTO dial_settings (k, v) VALUES ('snippets_seeded', '1')").run();
    rows = (await env.DB.prepare("SELECT id, name, body FROM snippets ORDER BY name COLLATE NOCASE").all()).results || [];
  }
  return rows;
}
// ---- Message statistics (owner only): delivery, replies, response times and what each automation earns
// midnight Eastern of a date (YYYY-MM-DD) as the UTC text the database stores; 04:00 in summer, 05:00 in winter
const etStartUtc = d => { for (const off of ["04", "05"]) { const t = new Date(`${d}T${off}:00:00Z`); if (new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(t) * 1 === 0) return `${d} ${off}:00:00`; } return `${d} 05:00:00`; };
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
async function msgStatsData(env, from, to) {
  await ensureTable(env.DB);
  const okd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
  to = okd(to) ? to : todayStr();
  from = okd(from) ? from : addDays(to, -29);
  if (from > to) from = to;
  let days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  if (days > 366) { from = addDays(to, -365); days = 366; }
  const pTo = addDays(from, -1), pFrom = addDays(pTo, -(days - 1));
  const lo = addDays(pFrom, -1) + " 00:00:00", hi = addDays(to, 2) + " 00:00:00";
  const rows = (await env.DB.prepare("SELECT id, lead_id, direction, status, auto, by_user, at FROM messages WHERE at >= ? AND at < ? ORDER BY id ASC LIMIT 120000").bind(lo, hi).all()).results || [];
  const ms = s => Date.parse(String(s).replace(" ", "T") + "Z");
  const ed = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }), eh = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" });
  const dayOf = t => ed.format(new Date(t)), hourOf = t => Number(eh.format(new Date(t)));
  const FAIL = new Set(["failed", "undelivered"]);
  // thread pass: how long we take to answer a text, how long they take, and whether a text got a reply within a day
  const byLead = new Map();
  for (const r of rows) { r.t = ms(r.at); r.d = dayOf(r.t); r.h = hourOf(r.t); if (r.lead_id != null) { if (!byLead.has(r.lead_id)) byLead.set(r.lead_id, []); byLead.get(r.lead_id).push(r); } }
  const ours = [], theirs = [];
  for (const th of byLead.values()) {
    th.sort((a, b) => a.t - b.t || a.id - b.id);
    for (let i = 0; i < th.length; i++) {
      const m = th[i];
      if (m.direction === "in") { const nx = th.slice(i + 1).find(x => x.direction === "out" && !x.auto); if (nx && nx.t - m.t < 864e5 * 3) ours.push({ d: m.d, s: (nx.t - m.t) / 1000 }); }
      else { const nx = th.slice(i + 1).find(x => x.direction === "in"); m.replied = !!(nx && nx.t - m.t <= 864e5); if (nx && nx.t - m.t < 864e5 * 3) theirs.push({ d: m.d, s: (nx.t - m.t) / 1000 }); }
    }
  }
  const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), i = Math.floor(b.length / 2); return Math.round(b.length % 2 ? b[i] : (b[i - 1] + b[i]) / 2); };
  const agg = (f, t) => {
    const r = rows.filter(x => x.d >= f && x.d <= t), out = r.filter(x => x.direction === "out"), inn = r.filter(x => x.direction === "in");
    const sent = out.length, delivered = out.filter(x => x.status === "delivered").length, failed = out.filter(x => FAIL.has(x.status)).length;
    const texted = new Set(out.map(x => x.lead_id).filter(v => v != null)), replied = new Set(inn.map(x => x.lead_id).filter(v => v != null));
    const perDay = {}; for (let i = 0; i < days; i++) perDay[addDays(f, i)] = { sent: 0, delivered: 0, failed: 0, received: 0 };
    out.forEach(x => { const p = perDay[x.d]; if (p) { p.sent++; if (x.status === "delivered") p.delivered++; if (FAIL.has(x.status)) p.failed++; } });
    inn.forEach(x => { const p = perDay[x.d]; if (p) p.received++; });
    const hr = Array.from({ length: 24 }, () => ({ sent: 0, replied: 0, received: 0 }));
    out.forEach(x => { hr[x.h].sent++; if (x.replied) hr[x.h].replied++; }); inn.forEach(x => { hr[x.h].received++; });
    const who = {}; out.forEach(x => { const k = x.auto ? "Automations" : (x.by_user || "Not recorded"); who[k] = (who[k] || 0) + 1; });
    return { sent, delivered, failed, received: inn.length, auto: out.filter(x => x.auto).length, texted: texted.size, replied: [...replied].filter(v => texted.has(v)).length,
      ourMed: med(ours.filter(x => x.d >= f && x.d <= t).map(x => x.s)), theirMed: med(theirs.filter(x => x.d >= f && x.d <= t).map(x => x.s)), perDay, hr, who };
  };
  const cur = agg(from, to), prev = agg(pFrom, pTo);
  const q = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all().catch(() => ({ results: [] }))).results || [];
  const f0 = from + " 00:00:00", t1 = addDays(to, 1) + " 00:00:00", pf0 = pFrom + " 00:00:00", pt1 = addDays(pTo, 1) + " 00:00:00";
  const optN = async (a, b) => ((await q("SELECT COUNT(*) n FROM sms_optout WHERE at >= ? AND at < ?", a, b))[0] || {}).n || 0;
  const bk = "('booked','working','done')";
  const [waiting, failedList, autos, camps, resp] = await Promise.all([
    q(`SELECT l.id, l.name, l.phone, m.at, m.body FROM messages m JOIN leads l ON l.id = m.lead_id WHERE m.id = (SELECT MAX(id) FROM messages WHERE lead_id = l.id) AND m.direction = 'in' ORDER BY m.at ASC LIMIT 25`),
    q("SELECT m.at, m.status, l.id, l.name, m.phone FROM messages m LEFT JOIN leads l ON l.id = m.lead_id WHERE m.direction = 'out' AND m.status IN ('failed','undelivered') AND m.at >= ? AND m.at < ? ORDER BY m.id DESC LIMIT 15", f0, t1),
    q(`SELECT a.name, COUNT(*) sent, SUM(EXISTS(SELECT 1 FROM messages m WHERE m.lead_id = r.lead_id AND m.direction = 'in' AND m.at > r.at AND m.at <= datetime(r.at,'+2 days'))) replies, SUM(COALESCE(l.stage,'') IN ${bk}) booked FROM automation_runs r JOIN automations a ON a.id = r.automation_id LEFT JOIN leads l ON l.id = r.lead_id WHERE r.at >= ? AND r.at < ? GROUP BY a.id ORDER BY sent DESC LIMIT 20`, f0, t1),
    q(`SELECT c.name, COUNT(*) sent, SUM(EXISTS(SELECT 1 FROM messages m WHERE m.lead_id = s.lead_id AND m.direction = 'in' AND m.at > s.at AND m.at <= datetime(s.at,'+2 days'))) replies, SUM(COALESCE(l.stage,'') IN ${bk}) booked FROM campaign_sends s JOIN campaigns c ON c.id = s.campaign_id LEFT JOIN leads l ON l.id = s.lead_id WHERE s.at >= ? AND s.at < ? GROUP BY c.id ORDER BY sent DESC LIMIT 20`, f0, t1),
    q(`SELECT COALESCE(SUM(rep),0) rep, COALESCE(SUM(rep*b),0) repb, COALESCE(SUM(1-rep),0) non, COALESCE(SUM((1-rep)*b),0) nonb FROM (SELECT l.id, EXISTS(SELECT 1 FROM messages WHERE lead_id = l.id AND direction = 'in') rep, (l.stage IN ${bk}) b FROM leads l WHERE EXISTS(SELECT 1 FROM messages m WHERE m.lead_id = l.id AND m.direction = 'out' AND m.at >= ? AND m.at < ?))`, f0, t1),
  ]);
  const now = Date.now();
  return { from, to, days, prevFrom: pFrom, prevTo: pTo, cur: { ...cur, optouts: await optN(f0, t1) }, prev: { ...prev, optouts: await optN(pf0, pt1) },
    waiting: waiting.map(w => ({ id: w.id, name: w.name || w.phone, body: String(w.body || "").slice(0, 90), mins: Math.round((now - ms(w.at)) / 60000) })),
    failedList: failedList.map(f => ({ id: f.id, name: f.name || prettyPhone(f.phone), phone: f.phone, status: f.status, at: isoUtc(f.at) })),
    autos: autos.map(a => ({ ...a, kind: "Automation" })).concat(camps.map(c => ({ ...c, kind: "Campaign" }))), resp: resp[0] || {} };
}
async function msgStatsPage(env, user) {
  await ensureTable(env.DB);
  const tc = await todayCount(env);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Message statistics | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:var(--bg,#07090c);color:var(--text,#e8eaed)}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px;flex-wrap:wrap}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}
main{max-width:1100px;margin:0 auto;padding:16px 22px 50px;display:flex;flex-direction:column;gap:18px}
.rb{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.rb input[type=date]{background:#10141a;border:1px solid #232932;color:#fff;border-radius:10px;padding:9px 10px;font:inherit;min-height:42px}.rb button{background:#10141a;border:1px solid #232932;color:#cfd3d9;border-radius:999px;padding:9px 14px;cursor:pointer;font:inherit;min-height:42px}.rb button.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
.g2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}
.card{background:#0d1116;border:1px solid #1d2229;border-radius:16px;padding:18px 20px;display:flex;flex-direction:column;gap:14px;min-width:0}.card h3{margin:0;font-size:13px;letter-spacing:.9px;text-transform:uppercase;color:#aab0b9;display:flex;align-items:center;gap:8px}
.kp{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:14px}.k small{display:block;color:#8a939e;font-size:12.5px;margin-bottom:4px}.k b{display:block;font-size:30px;line-height:1.1;letter-spacing:-.5px}.k b i{font-style:normal;font-size:14px;color:#8a939e;font-weight:600;margin-left:4px}
.dl{display:inline-block;font-size:12px;font-weight:700;border-radius:6px;padding:1px 6px;margin-top:6px}.dl.up{background:#0f2c18;color:#4fdc5a}.dl.dn{background:#2c1414;color:#ff8a8a}.dl.fl{background:#1a2027;color:#8a939e}.dls{color:#6f7782;font-size:12px;margin-left:6px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:#c3c8cf;margin:8px 0 0}h2 small{text-transform:none;letter-spacing:0;color:#7c838d;font-weight:400;font-size:12.5px;margin-left:6px}
.ch{background:#0d1116;border:1px solid #1d2229;border-radius:16px;padding:14px 16px}.ch svg{width:100%;height:auto;display:block}
.tbw{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th{font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:#7c838d;text-align:left;padding:8px 10px;border-bottom:1px solid #1d2229}td{padding:10px;border-bottom:1px solid #141a20}td a{color:#8ec0ff;text-decoration:none}
.note{color:#7c838d;font-size:12.5px}.empty{color:#7c838d;padding:16px 0;text-align:center}.warn{color:#ffb86b}
.hb div{display:grid;grid-template-columns:130px 1fr 70px;gap:10px;align-items:center;font-size:14px;margin:6px 0}.hb i{display:block;height:10px;border-radius:6px;background:#32cd32}
${BNAV_CSS}
@media(max-width:700px){header{padding:12px 14px}h1{font-size:17px}main{padding:8px 14px 24px}.k b{font-size:26px}}
</style></head><body>
<header><h1>Divine Detailers <b>message statistics</b></h1>${nav("msgstats", tc, true)}</header>
${bnav("msgstats", tc, true)}
${insightTabs("msgstats")}
<main>
<div class="rb"><input type="date" id="f"><span class="note">to</span><input type="date" id="t"><button data-d="7">7 days</button><button data-d="30" class="on">30 days</button><button data-d="90">90 days</button></div>
<p class="note" id="rn"></p>
<div class="g2"><div class="card"><h3>Texts you sent</h3><div class="kp" id="o"></div></div><div class="card"><h3>Texts you received</h3><div class="kp" id="i"></div></div></div>
<div class="g2"><div class="card"><h3>Speed of replies</h3><div class="kp" id="rs"></div></div><div class="card"><h3>Text replies and booking</h3><div class="kp" id="bk"></div></div></div>
<h2>Failure rate by day<small>the dashed line is 10%: above it, check your numbers and the Twilio registration</small></h2><div class="ch" id="c1"></div>
<h2>Texts sent and received by day</h2><div class="ch" id="c2"></div>
<h2>Best time to text<small>share of texts that got a reply within 24 hours, by the hour they were sent (Eastern)</small></h2><div class="ch" id="c3"></div>
<h2>Waiting on you<small>the lead texted last and nobody has answered yet</small></h2><div class="card"><div class="tbw"><table id="wt"></table></div></div>
<h2>Automations and campaigns<small>texts sent in this range, replies within 2 days, and how many of those leads are booked now</small></h2><div class="card"><div class="tbw"><table id="at"></table></div></div>
<div class="g2"><div><h2>Who sent them</h2><div class="card hb" id="wh"></div></div><div><h2>Texts that failed<small>fix these numbers</small></h2><div class="card"><div class="tbw"><table id="ft"></table></div></div></div></div>
<p class="note">Times are Eastern. "Delivered" and "failed" come from the carrier's report, so the most recent texts can show as sent for a few minutes. Reply rate counts leads who replied at least once. Booked means Deposit collected, In shop or Service completed.</p>
</main>
<script>
const $=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const F=document.getElementById('f'),T=document.getElementById('t');
const pct=(a,b)=>b?Math.round(1000*a/b)/10:0,fmt=n=>n>=10000?(n/1000).toFixed(1).replace(/\\.0$/,'')+'K':Number(n).toLocaleString('en-US');
const dur=s=>{if(s==null)return '-';if(s<60)return s+' sec';const m=Math.round(s/60);if(m<60)return m+' min';const h=Math.floor(m/60);if(h<48)return h+' h '+(m%60)+' min';return Math.round(h/24)+' days'};
function delta(c,p,inv){if(!p&&!c)return '<span class="dl fl">0%</span>';if(!p)return '<span class="dl fl">new</span>';const d=Math.round(100*(c-p)/p);if(!d)return '<span class="dl fl">0%</span>';const good=inv?d<0:d>0;return '<span class="dl '+(good?'up':'dn')+'">'+(d>0?'&#9650; ':'&#9660; ')+Math.abs(d)+'%</span>'}
const kp=(l,v,sub,dl)=>'<div class="k"><small>'+l+'</small><b>'+v+(sub?'<i>'+sub+'</i>':'')+'</b>'+(dl?dl+'<span class="dls">vs previous</span>':'')+'</div>';
function chart(id,days,series,opt){const W=900,H=230,L=40,B=26,Tp=12,n=days.length,bw=(W-L-10)/n,mx=Math.max(opt.min||1,...days.map((d,i)=>Math.max(...series.map(s=>s.v[i]))));const y=v=>Tp+(H-B-Tp)*(1-v/mx);
  let s='<svg viewBox="0 0 '+W+' '+H+'" role="img">';for(let k=0;k<=4;k++){const v=mx*k/4;s+='<line x1="'+L+'" x2="'+(W-6)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="#1b2128"/><text x="'+(L-6)+'" y="'+(y(v)+4)+'" fill="#6f7782" font-size="11" text-anchor="end">'+(opt.unit==='%'?Math.round(v)+'%':Math.round(v))+'</text>'}
  const sw=bw/(series.length)*0.78;days.forEach((d,i)=>{series.forEach((se,j)=>{const v=se.v[i],x=L+i*bw+(bw-sw*series.length)/2+j*sw,col=se.hot&&se.hot(v)?'#ff7a7a':se.c;s+='<rect x="'+x+'" y="'+y(v)+'" width="'+Math.max(1,sw-1)+'" height="'+Math.max(0,(H-B)-y(v))+'" rx="2" fill="'+col+'"><title>'+d+': '+(opt.unit==='%'?v+'%':v)+' '+se.n+'</title></rect>'});if(n<=14||i%Math.ceil(n/12)===0)s+='<text x="'+(L+i*bw+bw/2)+'" y="'+(H-8)+'" fill="#6f7782" font-size="11" text-anchor="middle">'+d.slice(5)+'</text>'});
  if(opt.line!=null)s+='<line x1="'+L+'" x2="'+(W-6)+'" y1="'+y(opt.line)+'" y2="'+y(opt.line)+'" stroke="#ff5d5d" stroke-dasharray="6 5"/>';
  if(opt.legend)s+=series.map((se,j)=>'<rect x="'+(L+j*110)+'" y="2" width="10" height="10" rx="2" fill="'+se.c+'"/><text x="'+(L+j*110+15)+'" y="11" fill="#aab0b9" font-size="11">'+se.n+'</text>').join('');
  document.getElementById(id).innerHTML=s+'</svg>'}
function mins(m){if(m<60)return m+' min';const h=Math.floor(m/60);if(h<48)return h+' h';return Math.round(h/24)+' days'}
function draw(d){const c=d.cur,p=d.prev;document.getElementById('rn').textContent=d.from+' to '+d.to+' ('+d.days+' days), compared with '+d.prevFrom+' to '+d.prevTo+'.';
  const nd=c.sent-c.delivered-c.failed;
  document.getElementById('o').innerHTML=kp('Sent',fmt(c.sent),'',delta(c.sent,p.sent))+kp('Delivered',fmt(c.delivered),pct(c.delivered,c.sent)+'%',delta(c.delivered,p.delivered))+kp('Failed',fmt(c.failed),pct(c.failed,c.sent)+'%',delta(c.failed,p.failed,true))+(nd>0?kp('No report yet',fmt(nd),'',''):'');
  document.getElementById('i').innerHTML=kp('Received',fmt(c.received),'',delta(c.received,p.received))+kp('Reply rate',pct(c.replied,c.texted)+'%',c.replied+' of '+c.texted,delta(pct(c.replied,c.texted),pct(p.replied,p.texted)))+kp('Opt-out rate',pct(c.optouts,c.texted)+'%',c.optouts+' STOP',delta(pct(c.optouts,c.texted),pct(p.optouts,p.texted),true));
  document.getElementById('rs').innerHTML=kp('You answer in (median)',dur(c.ourMed),'',p.ourMed!=null&&c.ourMed!=null?delta(c.ourMed,p.ourMed,true):'')+kp('They answer in (median)',dur(c.theirMed),'',p.theirMed!=null&&c.theirMed!=null?delta(c.theirMed,p.theirMed):'')+kp('Waiting on you',d.waiting.length,'',d.waiting.length?'<span class="dl dn">answer these</span>':'<span class="dl up">all caught up</span>');
  const r=d.resp,rr=pct(r.repb,r.rep),nr=pct(r.nonb,r.non);
  document.getElementById('bk').innerHTML=kp('Booked, replied to texts',rr+'%',(r.repb||0)+' of '+(r.rep||0))+kp('Booked, never replied',nr+'%',(r.nonb||0)+' of '+(r.non||0))+kp('Automatic texts',pct(c.auto,c.sent)+'%',fmt(c.auto)+' of '+fmt(c.sent));
  const days=Object.keys(c.perDay);
  chart('c1',days,[{n:'failed',v:days.map(k=>pct(c.perDay[k].failed,c.perDay[k].sent)),c:'#4a5ae8',hot:v=>v>10}],{unit:'%',line:10,min:12});
  chart('c2',days,[{n:'sent',v:days.map(k=>c.perDay[k].sent),c:'#32cd32'},{n:'received',v:days.map(k=>c.perDay[k].received),c:'#4a9be8'}],{legend:true});
  const hrs=Array.from({length:24},(_,h)=>h),lab=h=>(h%12||12)+(h<12?'a':'p');
  chart('c3',hrs.map(lab),[{n:'reply rate',v:hrs.map(h=>c.hr[h].sent>=5?pct(c.hr[h].replied,c.hr[h].sent):0),c:'#a78bfa'}],{unit:'%',min:10});
  document.getElementById('wt').innerHTML=d.waiting.length?'<tr><th>Lead</th><th>Their last text</th><th>Waiting</th></tr>'+d.waiting.map(w=>'<tr><td><a href="/admin/messages#id='+w.id+'">'+$(w.name)+'</a></td><td>'+$(w.body)+'</td><td'+(w.mins>60?' class="warn"':'')+'>'+mins(w.mins)+'</td></tr>').join(''):'<tr><td class="empty">Every text has been answered.</td></tr>';
  document.getElementById('at').innerHTML=d.autos.length?'<tr><th>Name</th><th>Type</th><th>Sent</th><th>Replies</th><th>Reply rate</th><th>Booked now</th></tr>'+d.autos.map(a=>'<tr><td>'+$(a.name)+'</td><td>'+a.kind+'</td><td>'+a.sent+'</td><td>'+a.replies+'</td><td>'+pct(a.replies,a.sent)+'%</td><td>'+a.booked+'</td></tr>').join(''):'<tr><td class="empty">No automation or campaign texts in this range.</td></tr>';
  const who=Object.entries(c.who).sort((a,b)=>b[1]-a[1]),mx=Math.max(1,...who.map(w=>w[1]));
  document.getElementById('wh').innerHTML=who.length?who.map(w=>'<div><span style="text-transform:capitalize">'+$(w[0])+'</span><span><i style="width:'+Math.max(3,Math.round(100*w[1]/mx))+'%"></i></span><span>'+w[1]+'</span></div>').join(''):'<span class="note">No texts sent in this range.</span>';
  document.getElementById('ft').innerHTML=d.failedList.length?'<tr><th>Lead</th><th>Number</th><th>Result</th></tr>'+d.failedList.map(f=>'<tr><td>'+(f.id?'<a href="/admin/pipeline#id='+f.id+'">'+$(f.name)+'</a>':$(f.name))+'</td><td>'+$(f.phone||'')+'</td><td class="warn">'+$(f.status)+'</td></tr>').join(''):'<tr><td class="empty">No failed texts. Nice.</td></tr>'}
async function load(){const r=await fetch('/admin/msgstats/data?from='+F.value+'&to='+T.value);const j=await r.json();if(j.success){F.value=j.from;T.value=j.to;draw(j)}}
const iso=d=>d.toLocaleDateString('en-CA',{timeZone:'America/New_York'});
function preset(n){const t=new Date();T.value=iso(t);F.value=iso(new Date(t.getTime()-(n-1)*864e5));document.querySelectorAll('.rb button').forEach(b=>b.classList.toggle('on',+b.dataset.d===n));load()}
document.querySelectorAll('.rb button').forEach(b=>b.onclick=()=>preset(+b.dataset.d));[F,T].forEach(i=>i.onchange=()=>{document.querySelectorAll('.rb button').forEach(b=>b.classList.remove('on'));load()});
preset(30);setInterval(()=>{if(!document.hidden)load()},120000);
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// shared look and helpers for the report pages (cards, KPI blocks, SVG charts)
const RPT_CSS = `main{max-width:1100px;margin:0 auto;padding:16px 22px 50px;display:flex;flex-direction:column;gap:18px}
.rb{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.rb input[type=date],.rb select,.rb input[type=number]{background:#10141a;border:1px solid #232932;color:#fff;border-radius:10px;padding:9px 10px;font:inherit;min-height:42px}.rb button{background:#10141a;border:1px solid #232932;color:#cfd3d9;border-radius:999px;padding:9px 14px;cursor:pointer;font:inherit;min-height:42px}.rb button.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
.g2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}
.card{background:#0d1116;border:1px solid #1d2229;border-radius:16px;padding:18px 20px;display:flex;flex-direction:column;gap:14px;min-width:0}.card h3{margin:0;font-size:13px;letter-spacing:.9px;text-transform:uppercase;color:#aab0b9;display:flex;align-items:center;gap:8px}
.kp{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:14px}.k small{display:block;color:#8a939e;font-size:12.5px;margin-bottom:4px}.k b{display:block;font-size:30px;line-height:1.1;letter-spacing:-.5px}.k b i{font-style:normal;font-size:14px;color:#8a939e;font-weight:600;margin-left:4px}
.dl{display:inline-block;font-size:12px;font-weight:700;border-radius:6px;padding:1px 6px;margin-top:6px}.dl.up{background:#0f2c18;color:#4fdc5a}.dl.dn{background:#2c1414;color:#ff8a8a}.dl.fl{background:#1a2027;color:#8a939e}.dls{color:#6f7782;font-size:12px;margin-left:6px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:#c3c8cf;margin:8px 0 0}h2 small{text-transform:none;letter-spacing:0;color:#7c838d;font-weight:400;font-size:12.5px;margin-left:6px}
.ch{background:#0d1116;border:1px solid #1d2229;border-radius:16px;padding:14px 16px}.ch svg{width:100%;height:auto;display:block}
.tbw{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th{font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:#7c838d;text-align:left;padding:8px 10px;border-bottom:1px solid #1d2229;white-space:nowrap}td{padding:10px;border-bottom:1px solid #141a20}td a{color:#8ec0ff;text-decoration:none}
.note{color:#7c838d;font-size:12.5px}.empty{color:#7c838d;padding:16px 0;text-align:center}.warn{color:#ffb86b}.good{color:#4fdc5a}
.hb div{display:grid;grid-template-columns:130px 1fr 70px;gap:10px;align-items:center;font-size:14px;margin:6px 0}.hb i{display:block;height:10px;border-radius:6px;background:#32cd32}
@media(max-width:700px){main{padding:8px 14px 24px}.k b{font-size:26px}}`;
const RPT_JS = `const $=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=(a,b)=>b?Math.round(1000*a/b)/10:0,fmt=n=>n>=10000?(n/1000).toFixed(1).replace(/\\.0$/,'')+'K':Number(n).toLocaleString('en-US'),money=n=>'$'+Math.round(n||0).toLocaleString('en-US'),m2=n=>'$'+(n>=100?Math.round(n).toLocaleString('en-US'):n.toFixed(2));
const dur=s=>{if(s==null)return '-';if(s<60)return s+' sec';const m=Math.round(s/60);if(m<60)return m+' min';const h=Math.floor(m/60);if(h<48)return h+' h '+(m%60)+' min';return Math.round(h/24)+' days'};
const iso=d=>d.toLocaleDateString('en-CA',{timeZone:'America/New_York'});
function delta(c,p,inv){if(!p&&!c)return '<span class="dl fl">0%</span>';if(!p)return '<span class="dl fl">new</span>';const d=Math.round(100*(c-p)/p);if(!d)return '<span class="dl fl">0%</span>';const good=inv?d<0:d>0;return '<span class="dl '+(good?'up':'dn')+'">'+(d>0?'&#9650; ':'&#9660; ')+Math.abs(d)+'%</span>'}
const kp=(l,v,sub,dl)=>'<div class="k"><small>'+l+'</small><b>'+v+(sub?'<i>'+sub+'</i>':'')+'</b>'+(dl?dl+'<span class="dls">vs previous</span>':'')+'</div>';
function chart(id,days,series,opt){const W=900,H=230,L=40,B=26,Tp=12,n=days.length,bw=(W-L-10)/n,mx=Math.max(opt.min||1,...days.map((d,i)=>Math.max(...series.map(s=>s.v[i]))));const y=v=>Tp+(H-B-Tp)*(1-v/mx);
  let s='<svg viewBox="0 0 '+W+' '+H+'" role="img">';for(let k=0;k<=4;k++){const v=mx*k/4;s+='<line x1="'+L+'" x2="'+(W-6)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="#1b2128"/><text x="'+(L-6)+'" y="'+(y(v)+4)+'" fill="#6f7782" font-size="11" text-anchor="end">'+(opt.unit==='%'?Math.round(v)+'%':Math.round(v))+'</text>'}
  const sw=bw/(series.length)*0.78;days.forEach((d,i)=>{series.forEach((se,j)=>{const v=se.v[i],x=L+i*bw+(bw-sw*series.length)/2+j*sw,col=se.hot&&se.hot(v)?'#ff7a7a':se.c;s+='<rect x="'+x+'" y="'+y(v)+'" width="'+Math.max(1,sw-1)+'" height="'+Math.max(0,(H-B)-y(v))+'" rx="2" fill="'+col+'"><title>'+d+': '+(opt.unit==='%'?v+'%':v)+' '+se.n+'</title></rect>'});if(n<=14||i%Math.ceil(n/12)===0)s+='<text x="'+(L+i*bw+bw/2)+'" y="'+(H-8)+'" fill="#6f7782" font-size="11" text-anchor="middle">'+(String(d).length>8?String(d).slice(5):d)+'</text>'});
  if(opt.line!=null)s+='<line x1="'+L+'" x2="'+(W-6)+'" y1="'+y(opt.line)+'" y2="'+y(opt.line)+'" stroke="#ff5d5d" stroke-dasharray="6 5"/>';
  if(opt.legend)s+=series.map((se,j)=>'<rect x="'+(L+j*110)+'" y="2" width="10" height="10" rx="2" fill="'+se.c+'"/><text x="'+(L+j*110+15)+'" y="11" fill="#aab0b9" font-size="11">'+se.n+'</text>').join('');
  document.getElementById(id).innerHTML=s+'</svg>'}
function rangeUI(load){const F=document.getElementById('f'),T=document.getElementById('t');window.RF=F;window.RT=T;
  function preset(n){const t=new Date();T.value=iso(t);F.value=iso(new Date(t.getTime()-(n-1)*864e5));document.querySelectorAll('.rb button[data-d]').forEach(b=>b.classList.toggle('on',+b.dataset.d===n));load()}
  document.querySelectorAll('.rb button[data-d]').forEach(b=>b.onclick=()=>preset(+b.dataset.d));[F,T].forEach(i=>i.onchange=()=>{document.querySelectorAll('.rb button[data-d]').forEach(b=>b.classList.remove('on'));load()});preset(30)}`;

// ---- Dials report (owner only): how many dials, how many connected, and how many dials it takes to book
function rptRange(from, to) {
  const okd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
  to = okd(to) ? to : todayStr(); from = okd(from) ? from : addDays(to, -29); if (from > to) from = to;
  let days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  if (days > 366) { from = addDays(to, -365); days = 366; }
  const pTo = addDays(from, -1), pFrom = addDays(pTo, -(days - 1));
  return { from, to, days, pFrom, pTo };
}
async function dialsData(env, from, to) {
  await ensureTable(env.DB);
  const R = rptRange(from, to), { days } = R;
  from = R.from; to = R.to;
  const lo = addDays(R.pFrom, -1) + " 00:00:00", hi = addDays(to, 2) + " 00:00:00";
  const q = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all().catch(() => ({ results: [] }))).results || [];
  const dials = await q("SELECT d.id, d.lead_id, d.duration, d.by_user, d.started_at FROM dial_calls d JOIN leads l ON l.id = d.lead_id WHERE d.started_at >= ? AND d.started_at < ? AND COALESCE(l.ip,'') != 'demo' ORDER BY d.started_at ASC, d.id ASC LIMIT 60000", lo, hi);
  const logs = await q("SELECT lead_id, from_stage, to_stage, reason, by_user, at FROM stage_log WHERE at >= ? AND at < ? AND (reason LIKE 'Call result:%' OR to_stage = 'booked') ORDER BY at ASC, id ASC LIMIT 60000", lo, hi);
  const ms = s => Date.parse(String(s).replace(" ", "T") + "Z");
  const ed = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }), eh = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" });
  const minS = contactMinSecs(env), byLead = new Map();
  for (const d of dials) { d.t = ms(d.started_at); d.d = ed.format(new Date(d.t)); d.h = Number(eh.format(new Date(d.t))); d.out = ""; if (!byLead.has(d.lead_id)) byLead.set(d.lead_id, []); byLead.get(d.lead_id).push(d); }
  for (const g of logs) {
    const m = /^call result: (.+)$/i.exec(g.reason || ""); if (!m) continue;
    const arr = byLead.get(g.lead_id) || [], t = ms(g.at); let best = null;
    for (const d of arr) if (d.t <= t + 60000 && t - d.t < 6 * 36e5) best = d;
    if (best) best.out = m[1];
  }
  const REACH = new Set(["Answered", "Interested", "Callback", "Booked", "Deposit pending", "Quote sent", "Not interested"]), NO = new Set(["Left a voicemail", "Voicemail", "No answer", "Lead hung up", "Wrong number"]);
  for (const d of dials) d.ok = d.out ? (REACH.has(d.out) ? true : NO.has(d.out) ? false : d.duration > minS) : d.duration > minS;
  // bookings: the first time a lead reached Deposit collected
  const seen = new Set(), closes = [];
  for (const g of logs) { if (g.to_stage === "booked" && g.from_stage !== "booked" && !seen.has(g.lead_id)) { seen.add(g.lead_id); closes.push({ lead: g.lead_id, d: ed.format(new Date(ms(g.at))), t: ms(g.at), by: g.by_user || "" }); } }
  const before = closes.length ? await q(`SELECT lead_id, started_at FROM dial_calls WHERE lead_id IN (${closes.map(() => "?").join(",")})`, ...closes.map(c => c.lead)) : [];
  for (const c of closes) c.n = before.filter(b => b.lead_id === c.lead && ms(b.started_at) <= c.t + 60000).length;
  const agg = (f, t) => {
    const ds = dials.filter(x => x.d >= f && x.d <= t), cs = closes.filter(x => x.d >= f && x.d <= t);
    const perDay = {}; for (let i = 0; i < days; i++) perDay[addDays(f, i)] = { dials: 0, reached: 0, closes: 0 };
    ds.forEach(x => { const p = perDay[x.d]; if (p) { p.dials++; if (x.ok) p.reached++; } }); cs.forEach(x => { const p = perDay[x.d]; if (p) p.closes++; });
    const hr = Array.from({ length: 24 }, () => ({ dials: 0, reached: 0 })); ds.forEach(x => { hr[x.h].dials++; if (x.ok) hr[x.h].reached++; });
    const out = {}; ds.forEach(x => { const k = x.out || (x.ok ? "Connected (no result picked)" : (x.duration ? "Short call (no result picked)" : "Not connected")); out[k] = (out[k] || 0) + 1; });
    const who = {}; const W = k => (who[k] = who[k] || { dials: 0, reached: 0, talk: 0, closes: 0 });
    ds.forEach(x => { const w = W(x.by_user || "Not recorded"); w.dials++; if (x.ok) { w.reached++; w.talk += x.duration || 0; } }); cs.forEach(x => { W(x.by || "Not recorded").closes++; });
    const leads = new Set(ds.map(x => x.lead_id)); let firstReach = [], neverReached = 0;
    for (const id of leads) { const arr = ds.filter(x => x.lead_id === id), i = arr.findIndex(x => x.ok); if (i >= 0) firstReach.push(i + 1); else neverReached++; }
    return { dials: ds.length, reached: ds.filter(x => x.ok).length, talk: ds.filter(x => x.ok).reduce((a, x) => a + (x.duration || 0), 0), closes: cs.length, leads: leads.size, perDay, hr, out, who,
      neverReached, avgToReach: firstReach.length ? Math.round(10 * firstReach.reduce((a, b) => a + b, 0) / firstReach.length) / 10 : null,
      dist: [0, 1, 2, 3, 4, 5].map(n => cs.filter(x => n === 5 ? x.n >= 5 : x.n === n).length) };
  };
  return { success: true, from, to, days, prevFrom: R.pFrom, prevTo: R.pTo, cur: agg(from, to), prev: agg(R.pFrom, R.pTo), today: dials.filter(x => x.d === todayStr()).length };
}
async function dialsPage(env, user) {
  await ensureTable(env.DB);
  const tc = await todayCount(env);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Dials | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:var(--bg,#07090c);color:var(--text,#e8eaed)}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px;flex-wrap:wrap}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}
${RPT_CSS}
.gl{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.gl input{width:90px}.pb{flex:1;min-width:140px;height:10px;border-radius:6px;background:#161c23;overflow:hidden}.pb i{display:block;height:100%;background:#32cd32}
${BNAV_CSS}
@media(max-width:700px){header{padding:12px 14px}h1{font-size:17px}}
</style></head><body>
<header><h1>Divine Detailers <b>dials</b></h1>${nav("dials", tc, true)}</header>
${bnav("dials", tc, true)}
${insightTabs("dials")}
<main>
<div class="rb"><input type="date" id="f"><span class="note">to</span><input type="date" id="t"><button data-d="7">7 days</button><button data-d="30" class="on">30 days</button><button data-d="90">90 days</button></div>
<p class="note" id="rn"></p>
<div class="card"><h3>Today</h3><div class="gl"><div class="k"><b id="td">0</b><small>dials so far</small></div><div class="pb"><i id="tp" style="width:0"></i></div><label class="note">Daily goal <input type="number" id="gl" min="1" max="500" value="50" style="background:#10141a;border:1px solid #232932;color:#fff;border-radius:8px;padding:6px 8px;font:inherit"></label></div></div>
<div class="g2"><div class="card"><h3>Dials</h3><div class="kp" id="a"></div></div><div class="card"><h3>Closing</h3><div class="kp" id="b"></div></div></div>
<h2>Dials per day<small>green = someone picked up</small></h2><div class="ch" id="c1"></div>
<div class="g2"><div><h2>Dials by hour<small>Eastern</small></h2><div class="ch" id="c2"></div></div><div><h2>Connect rate by hour<small>needs 5+ dials in the hour</small></h2><div class="ch" id="c3"></div></div></div>
<div class="g2"><div><h2>How calls ended</h2><div class="card hb" id="oc"></div></div><div><h2>Dials before a booking</h2><div class="card"><div class="tbw"><table id="ds"></table></div></div></div></div>
<h2>By person</h2><div class="card"><div class="tbw"><table id="bp"></table></div></div>
<p class="note">A dial is one call placed from the Dial page. Connected means the result you picked after the call was a real conversation, or, when none was picked, the call lasted longer than 45 seconds. A booking is the first time a lead reaches Deposit collected, and it is credited to whoever moved it. Dials per booking is all dials in the range divided by bookings in the range.</p>
</main>
<script>
${RPT_JS}
function draw(d){const c=d.cur,p=d.prev;document.getElementById('rn').textContent=d.from+' to '+d.to+' ('+d.days+' days), compared with '+d.prevFrom+' to '+d.prevTo+'.';
  const dpd=Math.round(10*c.dials/d.days)/10,pdpd=Math.round(10*p.dials/d.days)/10;
  document.getElementById('a').innerHTML=kp('Dials',fmt(c.dials),'',delta(c.dials,p.dials))+kp('Dials per day',dpd,'',delta(dpd,pdpd))+kp('Connected',fmt(c.reached),pct(c.reached,c.dials)+'%',delta(c.reached,p.reached))+kp('Talk time',dur(c.talk),'',delta(c.talk,p.talk))+kp('Leads called',fmt(c.leads),'',delta(c.leads,p.leads))+kp('Dials per lead',c.leads?(Math.round(10*c.dials/c.leads)/10):'-','');
  const dpc=c.closes?Math.round(10*c.dials/c.closes)/10:null,pdpc=p.closes?Math.round(10*p.dials/p.closes)/10:null;
  document.getElementById('b').innerHTML=kp('Bookings',c.closes,'',delta(c.closes,p.closes))+kp('Dials per booking',dpc==null?'-':dpc,'',dpc!=null&&pdpc!=null?delta(dpc,pdpc,true):'')+kp('Connects per booking',c.closes?Math.round(10*c.reached/c.closes)/10:'-','')+kp('Dials to reach a lead',c.avgToReach==null?'-':c.avgToReach,'')+kp('Never reached',c.neverReached,'leads')+kp('Talk time per connect',c.reached?dur(Math.round(c.talk/c.reached)):'-','');
  const days=Object.keys(c.perDay);
  chart('c1',days,[{n:'not connected',v:days.map(k=>c.perDay[k].dials-c.perDay[k].reached),c:'#3b4552'},{n:'connected',v:days.map(k=>c.perDay[k].reached),c:'#32cd32'}],{legend:true});
  const hrs=Array.from({length:24},(_,h)=>h),lab=h=>(h%12||12)+(h<12?'a':'p');
  chart('c2',hrs.map(lab),[{n:'dials',v:hrs.map(h=>c.hr[h].dials),c:'#4a9be8'}],{});
  chart('c3',hrs.map(lab),[{n:'connect rate',v:hrs.map(h=>c.hr[h].dials>=5?pct(c.hr[h].reached,c.hr[h].dials):0),c:'#a78bfa'}],{unit:'%',min:10});
  const oc=Object.entries(c.out).sort((a,b)=>b[1]-a[1]),mx=Math.max(1,...oc.map(o=>o[1]));
  document.getElementById('oc').innerHTML=oc.length?oc.map(o=>'<div><span>'+$(o[0])+'</span><span><i style="width:'+Math.max(3,Math.round(100*o[1]/mx))+'%"></i></span><span>'+o[1]+'</span></div>').join(''):'<span class="note">No dials in this range.</span>';
  const L=['No dial recorded','1 dial','2 dials','3 dials','4 dials','5 or more'];
  document.getElementById('ds').innerHTML=c.closes?'<tr><th>Dials before booking</th><th>Bookings</th><th>Share</th></tr>'+L.map((l,i)=>'<tr><td>'+l+'</td><td>'+c.dist[i]+'</td><td>'+pct(c.dist[i],c.closes)+'%</td></tr>').join(''):'<tr><td class="empty">No bookings in this range.</td></tr>';
  const who=Object.entries(c.who).sort((a,b)=>b[1].dials-a[1].dials);
  document.getElementById('bp').innerHTML=who.length?'<tr><th>Person</th><th>Dials</th><th>Connected</th><th>Connect rate</th><th>Talk time</th><th>Bookings</th><th>Dials per booking</th></tr>'+who.map(([k,w])=>'<tr><td style="text-transform:capitalize">'+$(k)+'</td><td>'+w.dials+'</td><td>'+w.reached+'</td><td>'+pct(w.reached,w.dials)+'%</td><td>'+dur(w.talk)+'</td><td>'+w.closes+'</td><td>'+(w.closes?Math.round(10*w.dials/w.closes)/10:'-')+'</td></tr>').join(''):'<tr><td class="empty">No dials in this range.</td></tr>';
  const g=+document.getElementById('gl').value||50;document.getElementById('td').textContent=d.today;document.getElementById('tp').style.width=Math.min(100,Math.round(100*d.today/g))+'%'}
let LAST=null;async function load(){const r=await fetch('/admin/dials/data?from='+RF.value+'&to='+RT.value);const j=await r.json();if(j.success){RF.value=j.from;RT.value=j.to;LAST=j;draw(j)}}
try{document.getElementById('gl').value=localStorage.getItem('dgoal')||50}catch(_){}
document.getElementById('gl').onchange=e=>{try{localStorage.setItem('dgoal',e.target.value)}catch(_){}if(LAST)draw(LAST)};
rangeUI(load);setInterval(()=>{if(!document.hidden)load()},60000);
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// ---- Meta Ads report (owner only): what the Facebook and Instagram leads turned into. Spend is typed in by month because the CRM is not connected to Meta's ad account yet.
async function metaPage(env, user) {
  await ensureTable(env.DB);
  const tc = await todayCount(env);
  const rows = (await speedRows(env)).filter(r => r.channel === "meta").map(r => ({ id: r.id, name: r.name, cd: r.cd, created: r.created, service: r.service, stage: r.stage, booked: r.booked, value: r.value, secs: r.secs, reached: r.reached, attempts: r.attempts, camp: r.camp, adset: r.adset, ad: r.adname, form: r.form, lost: r.lost, open: r.open, h: r.h }));
  const spend = {};
  for (const r of (await env.DB.prepare("SELECT month, amount FROM ad_spend2 WHERE channel = 'meta'").all()).results || []) spend[r.month] = r.amount;
  const payload = JSON.stringify({ rows, spend, today: todayStr() }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Meta Ads report | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:var(--bg,#07090c);color:var(--text,#e8eaed)}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px;flex-wrap:wrap}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}
${RPT_CSS}
.sp{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}.sp label{display:block;color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:3px}.sp input{width:100%;background:#10141a;border:1px solid #232932;color:#fff;border-radius:8px;padding:8px 10px;font:inherit}
.btnc{background:#32cd32;color:#04120a;text-decoration:none;font-weight:800;border-radius:9px;padding:6px 12px;font-size:13px}
${BNAV_CSS}
@media(max-width:700px){header{padding:12px 14px}h1{font-size:17px}}
</style></head><body>
<header><h1>Divine Detailers <b>meta ads</b></h1>${nav("meta", tc, true)}</header>
${bnav("meta", tc, true)}
${insightTabs("meta")}
<main>
<div class="rb"><input type="date" id="f"><span class="note">to</span><input type="date" id="t"><button data-d="7">7 days</button><button data-d="30" class="on">30 days</button><button data-d="90">90 days</button></div>
<div class="g2"><div class="card"><h3>Results</h3><div class="kp" id="k1"></div></div><div class="card"><h3>What they turned into</h3><div class="kp" id="k2"></div></div></div>
<h2>Leads per day</h2><div class="ch" id="c1"></div>
<h2>Funnel<small>how many Meta leads make it through each step</small></h2><div class="ch" id="c2"></div>
<h2>Performance<small>group by</small> <select id="gb" style="background:#10141a;border:1px solid #232932;color:#fff;border-radius:8px;padding:6px 8px;font:inherit"><option value="camp">Campaign</option><option value="adset">Ad set</option><option value="ad">Ad</option><option value="form">Form</option><option value="service">Service</option></select></h2>
<div class="card"><div class="tbw"><table id="tb"></table></div></div>
<h2>Not called yet<small>Meta leads in this range nobody has dialed. Oldest first.</small></h2><div class="card"><div class="tbw"><table id="nc"></table></div></div>
<h2>Ad spend<small>type what you spent on Meta each month; it is saved automatically and used for cost per lead and return</small></h2><div class="card"><div class="sp" id="sp"></div></div>
<p class="note">Impressions, clicks and click-through rate live inside Meta, so they are not shown here yet (connecting Meta's Ads API would add them). Everything above is counted from your CRM: leads from Meta forms, the calls made from the dialer, and bookings. Spend per campaign is estimated by splitting the month's spend by each campaign's share of leads. Booked means Deposit collected, In shop or Service completed.</p>
</main>
<script type="application/json" id="data">${payload}</script>
<script>
${RPT_JS}
const D=JSON.parse(document.getElementById('data').textContent),R=D.rows;let SPD=D.spend||{};
const med=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),i=Math.floor(b.length/2);return Math.round(b.length%2?b[i]:(b[i-1]+b[i])/2)};
const dt=s=>new Date(s+'T00:00:00Z');
function spendFor(f,t){let tot=0;for(const m in SPD){const y=+m.slice(0,4),mo=+m.slice(5,7),dim=new Date(Date.UTC(y,mo,0)).getUTCDate(),first=m+'-01',last=m+'-'+String(dim).padStart(2,'0'),lo=f>first?f:first,hi=t<last?t:last;if(lo>hi)continue;tot+=SPD[m]*(((dt(hi)-dt(lo))/864e5)+1)/dim}return tot}
function monthsIn(f,t){const out=[];let d=dt(f.slice(0,7)+'-01');const end=dt(t);while(d<=end){out.push(d.toISOString().slice(0,7));d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1))}return out}
function drawSpend(f,t){const ms=monthsIn(f,t);document.getElementById('sp').innerHTML=ms.map(m=>'<div><label>'+m+'</label><input type="number" min="0" step="1" data-m="'+m+'" value="'+(SPD[m]||'')+'" placeholder="$0"></div>').join('')}
document.getElementById('sp').addEventListener('change',async e=>{const i=e.target.closest('input[data-m]');if(!i)return;const v=Math.max(0,Number(i.value)||0);SPD[i.dataset.m]=v;try{await fetch('/admin/adspend',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({month:i.dataset.m,channel:'meta',amount:v})})}catch(_){}draw()});
const keyOf={camp:r=>r.camp||'(no campaign)',adset:r=>r.adset||'(no ad set)',ad:r=>r.ad||'(no ad name)',form:r=>r.form||'(no form)',service:r=>r.service||'Not set'};
function draw(){const f=RF.value,t=RT.value,L=R.filter(r=>r.cd>=f&&r.cd<=t),n=L.length,called=L.filter(r=>r.secs!=null),reached=L.filter(r=>r.reached),bk=L.filter(r=>r.booked),rev=bk.reduce((a,r)=>a+(r.value||0),0),sp=spendFor(f,t),nc=L.filter(r=>r.secs==null&&r.open);
  document.getElementById('k1').innerHTML=kp('Leads',fmt(n),'')+kp('Ad spend',sp?money(sp):'-','')+kp('Cost per lead',sp&&n?m2(sp/n):'-','')+kp('Cost per booking',sp&&bk.length?m2(sp/bk.length):'-','')+kp('Return on ad spend',sp&&rev?(rev/sp).toFixed(1)+'x':'-','');
  const m=med(called.map(r=>r.secs));
  document.getElementById('k2').innerHTML=kp('Called',pct(called.length,n)+'%',called.length+' of '+n)+kp('Reached',pct(reached.length,called.length)+'%',reached.length+' of '+called.length)+kp('Booked',bk.length,pct(bk.length,n)+'%')+kp('Booked revenue',money(rev),'')+kp('Median time to first call',m==null?'-':dur(m),'');
  const days=[];for(let d=dt(f);d<=dt(t);d=new Date(d.getTime()+864e5))days.push(d.toISOString().slice(0,10));
  chart('c1',days,[{n:'leads',v:days.map(d=>L.filter(r=>r.cd===d).length),c:'#4a9be8'},{n:'booked',v:days.map(d=>L.filter(r=>r.cd===d&&r.booked).length),c:'#32cd32'}],{legend:true});
  chart('c2',['Leads','Called','Reached','Booked'],[{n:'leads',v:[n,called.length,reached.length,bk.length],c:'#32cd32'}],{});
  const g=document.getElementById('gb').value,groups={};L.forEach(r=>{const k=keyOf[g](r);(groups[k]=groups[k]||[]).push(r)});
  const rows=Object.entries(groups).sort((a,b)=>b[1].length-a[1].length);
  document.getElementById('tb').innerHTML=rows.length?'<tr><th>Name</th><th>Leads</th><th>Not called</th><th>Called</th><th>Reached</th><th>Booked</th><th>Booked rate</th><th>Revenue</th><th>Est. spend</th><th>Cost per lead</th><th>Cost per booking</th><th>Return</th></tr>'+rows.map(([k,x])=>{const c=x.filter(r=>r.secs!=null).length,rc=x.filter(r=>r.reached).length,b=x.filter(r=>r.booked),rv=b.reduce((a,r)=>a+(r.value||0),0),es=n?sp*x.length/n:0;return '<tr><td>'+$(k)+'</td><td>'+x.length+'</td><td'+(x.length-c?' class="warn"':'')+'>'+(x.length-c)+'</td><td>'+pct(c,x.length)+'%</td><td>'+pct(rc,c)+'%</td><td>'+b.length+'</td><td>'+pct(b.length,x.length)+'%</td><td>'+money(rv)+'</td><td>'+(es?money(es):'-')+'</td><td>'+(es?m2(es/x.length):'-')+'</td><td>'+(es&&b.length?m2(es/b.length):'-')+'</td><td>'+(es&&rv?(rv/es).toFixed(1)+'x':'-')+'</td></tr>'}).join(''):'<tr><td class="empty">No Meta leads in this range.</td></tr>';
  const ncs=nc.sort((a,b)=>new Date(a.created)-new Date(b.created)).slice(0,25);
  document.getElementById('nc').innerHTML=ncs.length?'<tr><th>Lead</th><th>Service</th><th>Campaign</th><th>Waiting</th><th></th></tr>'+ncs.map(r=>'<tr><td><a href="/admin/pipeline#id='+r.id+'">'+$(r.name)+'</a></td><td>'+$(r.service)+'</td><td>'+$(r.camp||'')+'</td><td class="warn">'+dur(Math.round((Date.now()-new Date(r.created).getTime())/1000))+'</td><td><a class="btnc" href="/admin/dialer?lead='+r.id+'">Call</a></td></tr>').join(''):'<tr><td class="empty good">Every Meta lead in this range has been called.</td></tr>';
  drawSpend(f,t)}
document.getElementById('gb').onchange=draw;
rangeUI(draw);
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// ---- Number health (owner only): is each calling and texting number still getting through, or is it being flagged as spam?
const normNum = n => { const d = String(n || "").replace(/\D/g, ""); return !d ? "" : d.length === 10 ? "+1" + d : d.length === 11 && d[0] === "1" ? "+" + d : "+" + d; };
const ourNumbers = env => [...new Set([env.TWILIO_FROM, ...String(env.TWILIO_NUMBERS || "").split(/[\s,]+/)].map(normNum).filter(Boolean))];
async function numberHealth(env) {
  await ensureTable(env.DB);
  const nums = ourNumbers(env), primary = nums[0] || "";
  const q = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all().catch(() => ({ results: [] }))).results || [];
  const [dials, msgs, outc, opt, texted] = await Promise.all([
    q("SELECT lead_id, duration, started_at, from_num FROM dial_calls WHERE started_at >= datetime('now','-30 days') ORDER BY started_at ASC LIMIT 20000"),
    q("SELECT status, err, at, from_num FROM messages WHERE direction = 'out' AND at >= datetime('now','-30 days') LIMIT 40000"),
    q("SELECT lead_id, reason, at FROM stage_log WHERE reason LIKE 'Call result: Left a voicemail%' AND at >= datetime('now','-30 days')"),
    q("SELECT COUNT(*) n FROM sms_optout WHERE at >= datetime('now','-7 days')"),
    q("SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE direction = 'out' AND at >= datetime('now','-7 days')"),
  ]);
  const ms = s => Date.parse(String(s).replace(" ", "T") + "Z"), now = Date.now(), day = 864e5;
  const all = [...new Set([...nums, ...dials.map(r => normNum(r.from_num)), ...msgs.map(r => normNum(r.from_num))].filter(Boolean))];
  if (!all.length && (dials.length || msgs.length)) all.push("Not recorded");
  const numOf = r => normNum(r.from_num) || primary || "Not recorded";
  const vmAt = new Map(); for (const o of outc) { if (!vmAt.has(o.lead_id)) vmAt.set(o.lead_id, []); vmAt.get(o.lead_id).push(ms(o.at)); }
  const out = [];
  for (const num of all) {
    const dr = dials.filter(r => numOf(r) === num).map(r => ({ t: ms(r.started_at), dur: r.duration || 0, lead: r.lead_id }));
    const mr = msgs.filter(r => numOf(r) === num).map(r => ({ t: ms(r.at), st: r.status, err: String(r.err || "") }));
    for (const d of dr) d.vm = (vmAt.get(d.lead) || []).some(t => t >= d.t - 6e4 && t - d.t < 6 * 36e5);
    const calls = rows => ({ n: rows.length, picked: rows.filter(x => x.dur > 0).length, short: rows.filter(x => x.dur > 0 && x.dur < 10).length, vm: rows.filter(x => x.vm).length });
    const texts = rows => ({ n: rows.length, delivered: rows.filter(x => x.st === "delivered").length, failed: rows.filter(x => x.st === "failed" || x.st === "undelivered").length, blocked: rows.filter(x => x.err === "30007").length });
    const inW = (rows, a, b) => rows.filter(x => x.t >= now - b * day && x.t < now - a * day);
    const cur = { calls: calls(inW(dr, 0, 7)), texts: texts(inW(mr, 0, 7)) }, base = { calls: calls(inW(dr, 7, 30)), texts: texts(inW(mr, 7, 30)) };
    const rate = (a, b) => (b ? a / b : null), reasons = []; let level = 0;
    const up = (l, t) => { level = Math.max(level, l); reasons.push(t); };
    const ar = rate(cur.calls.picked, cur.calls.n), bar = rate(base.calls.picked, base.calls.n), P = v => Math.round(v * 100) + "%";
    const callsOk = cur.calls.n >= 15, textsOk = cur.texts.n >= 30;
    if (callsOk && base.calls.n >= 20 && bar != null) {
      const drop = bar - ar;
      if (drop >= 0.2 && ar <= 0.6 * bar) up(2, "Answer rate fell from " + P(bar) + " to " + P(ar) + " this week.");
      else if (drop >= 0.1) up(1, "Answer rate dipped from " + P(bar) + " to " + P(ar) + " this week.");
    } else if (callsOk && ar < 0.15) up(1, "Only " + P(ar) + " of calls are being picked up (not enough history to compare yet).");
    if (cur.calls.picked >= 10) { const sr = cur.calls.short / cur.calls.picked; if (sr > 0.6) up(2, P(sr) + " of answered calls ended in under 10 seconds (people hanging up fast)."); else if (sr > 0.4) up(1, P(sr) + " of answered calls ended in under 10 seconds (people hanging up fast)."); }
    if (textsOk) {
      const br = cur.texts.blocked / cur.texts.n, fr = cur.texts.failed / cur.texts.n;
      if (br >= 0.08) up(2, P(br) + " of texts were blocked by carriers (error 30007)."); else if (br >= 0.03) up(1, P(br) + " of texts were blocked by carriers (error 30007).");
      if (fr >= 0.2) up(2, P(fr) + " of texts failed or were not delivered."); else if (fr >= 0.1) up(1, P(fr) + " of texts failed or were not delivered.");
    }
    if (all.length <= 1 && texted[0] && texted[0].n >= 20) { const or = (opt[0].n || 0) / texted[0].n; if (or >= 0.06) up(2, P(or) + " of the people texted this week replied STOP."); else if (or >= 0.03) up(1, P(or) + " of the people texted this week replied STOP."); }
    const status = !callsOk && !textsOk ? "learning" : level >= 2 ? "red" : level === 1 ? "yellow" : "green";
    const daily = Array.from({ length: 14 }, (_, i) => { const a = 13 - i, c = calls(inW(dr, a, a + 1)), t = texts(inW(mr, a, a + 1)); return { d: new Date(now - a * day).toLocaleDateString("en-CA", { timeZone: TZ }), dials: c.n, picked: c.picked, texts: t.n, delivered: t.delivered, blocked: t.blocked }; });
    out.push({ num, label: num.startsWith("+1") ? prettyPhone(num.slice(2)) : num, primary: num === primary, status, level: status === "learning" ? 0 : level, reasons,
      suggest: status === "red" ? "Pause outbound calls from this number, switch to a backup number, and register a replacement." : status === "yellow" ? "Keep an eye on it for a few days. Lower the daily volume and vary your text wording." : status === "learning" ? "Needs about 15 calls or 30 texts in a week to judge." : "Looks healthy.",
      cur, base, daily });
  }
  return out;
}
async function numberHealthAlert(env) {
  if (!env.DB || new Date().getUTCMinutes() !== 7) return;
  await ensureTable(env.DB);
  for (const n of await numberHealth(env)) {
    const prev = await env.DB.prepare("SELECT level FROM number_health WHERE num = ?").bind(n.num).first();
    const was = prev ? prev.level : 0;
    if (n.level > was && n.level >= 1) await pushToDevices(env, { title: n.level >= 2 ? "Number health: RED" : "Number health: yellow", message: `${n.label}: ${n.reasons[0] || "check this number"}`, click: env.CRM_HOST ? `https://${env.CRM_HOST}/admin/numbers` : undefined, users: [OWNER] }).catch(() => {});
    await env.DB.prepare("INSERT INTO number_health (num, level, at) VALUES (?,?,datetime('now')) ON CONFLICT(num) DO UPDATE SET level = excluded.level, at = excluded.at").bind(n.num, n.level).run();
  }
}
// best-effort look at Twilio's own spam status for each number (Voice Integrity). Only runs when the owner presses the button.
async function twilioNumberCheck(env) {
  const base = env.TWILIO_API_BASE || "https://api.twilio.com", auth = { authorization: "Basic " + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`) }, out = [];
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN) return [{ num: "", ok: false, message: "Twilio is not set up yet." }];
  for (const num of ourNumbers(env)) {
    try {
      const r = await fetch(`${base}/2010-04-01/Accounts/${env.TWILIO_SID}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(num)}`, { headers: auth, signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => ({})), sid = j.incoming_phone_numbers && j.incoming_phone_numbers[0] && j.incoming_phone_numbers[0].sid;
      if (!sid) { out.push({ num, ok: false, message: "Twilio does not list this number on the account." }); continue; }
      const v = await fetch(`${env.TWILIO_VOICE_INTEGRITY_BASE || "https://voiceintegrity.twilio.com"}/v1/PhoneNumbers/${sid}`, { headers: auth, signal: AbortSignal.timeout(8000) });
      if (!v.ok) {
        if (v.status !== 404) { out.push({ num, ok: false, message: "Twilio answered " + v.status + "." }); continue; }
        // a registration can be approved without this number being added to it: look through the Trust Hub registrations to say which
        const th = env.TWILIO_TRUSTHUB_BASE || "https://trusthub.twilio.com";
        const tp = await fetch(`${th}/v1/TrustProducts?PageSize=50`, { headers: auth, signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(() => ({}));
        let found = null, approved = "";
        for (const t of tp.results || tp.trust_products || []) {
          const ea = await fetch(`${th}/v1/TrustProducts/${t.sid}/EntityAssignments?PageSize=100`, { headers: auth, signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(() => ({}));
          if ((ea.results || ea.entity_assignments || []).some(e => e.object_sid === sid)) { found = t; break; }
          if (/approved/i.test(t.status || "") && !approved) approved = t.friendly_name || t.sid;
        }
        if (found && /approved/i.test(found.status || "")) out.push({ num, ok: true, data: `Registered with "${found.friendly_name || found.sid}" (approved). Twilio does not report a spam label for it.` });
        else if (found) out.push({ num, ok: false, message: `Added to "${found.friendly_name || found.sid}", but that registration is ${found.status || "not approved yet"}.` });
        else if (approved) out.push({ num, ok: false, message: `The registration "${approved}" is approved, but this number is not added to it yet. In Twilio open Voice Trust > Voice Integrity and add this number to the registration.` });
        else out.push({ num, ok: false, message: "No approved Voice Integrity registration found. Create one in Twilio (Voice Trust > Voice Integrity)." });
        continue;
      }
      const d = await v.json().catch(() => ({})); out.push({ num, ok: true, data: JSON.stringify(d).slice(0, 600) });
    } catch (e) { out.push({ num, ok: false, message: "Could not reach Twilio." }); }
  }
  return out;
}
async function numbersPage(env, user) {
  await ensureTable(env.DB);
  const tc = await todayCount(env), list = await numberHealth(env);
  const payload = JSON.stringify({ list, twilio: !!(env.TWILIO_SID && env.TWILIO_TOKEN) }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Number health | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:var(--bg,#07090c);color:var(--text,#e8eaed)}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px;flex-wrap:wrap}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}
${RPT_CSS}
.nm{display:flex;flex-direction:column;gap:14px}.nh{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.nh b{font-size:22px;letter-spacing:-.3px}.st{border-radius:999px;padding:4px 14px;font-weight:800;font-size:13px;letter-spacing:.5px;text-transform:uppercase}
.st.green{background:#0f2c18;color:#4fdc5a;border:1px solid #1f6a37}.st.yellow{background:#2a2410;color:#ffd166;border:1px solid #5a4a1f}.st.red{background:#2c1414;color:#ff8a8a;border:1px solid #6a2a2a}.st.learning{background:#161c23;color:#9aa4af;border:1px solid #2a323b}
.rs{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px}.sg{background:#0b0f13;border:1px solid #1b2530;border-radius:12px;padding:10px 14px;color:#cfd6de}
.btnc{background:#10151b;border:1px solid #232b34;color:#e8eaed;border-radius:10px;padding:9px 14px;font:inherit;font-weight:650;cursor:pointer}.btnc:hover{border-color:#34404c}
${BNAV_CSS}
@media(max-width:700px){header{padding:12px 14px}h1{font-size:17px}}
</style></head><body>
<header><h1>Divine Detailers <b>number health</b></h1>${nav("numbers", tc, true)}</header>
${bnav("numbers", tc, true)}
${insightTabs("numbers")}
<main>
<p class="note">Each number gets a status from how people react to it: calls picked up, calls ended in seconds, texts delivered and texts blocked by carriers. It compares the last 7 days with the 3 weeks before. A phone alert goes to your login only when a number turns yellow or red.</p>
<div id="list"></div>
<div class="card"><h3>Twilio's own spam status</h3><p class="note" id="tw">Asks Twilio what it reports for each number (Voice Integrity). Turn Voice Integrity on in Twilio first, or this will say it has nothing for the number.</p><div><button class="btnc" id="chk" type="button">Check with Twilio</button></div><div id="twr" class="note"></div></div>
<p class="note">No tool can promise a number is clean: the carriers' spam lists are not public. This catches problems early from behavior, but it needs a few days of calling to sharpen. Numbers are recorded from now on; older calls and texts count toward your main number.</p>
</main>
<script type="application/json" id="data">${payload}</script>
<script>
${RPT_JS}
const D=JSON.parse(document.getElementById('data').textContent);
const P=v=>v==null?'-':Math.round(v*100)+'%';
function card(n){const c=n.cur,b=n.base,ar=c.calls.n?c.calls.picked/c.calls.n:null,bar=b.calls.n?b.calls.picked/b.calls.n:null,dl=c.texts.n?c.texts.delivered/c.texts.n:null,bl=c.texts.n?c.texts.blocked/c.texts.n:null,sh=c.calls.picked?c.calls.short/c.calls.picked:null;
  return '<div class="card nm"><div class="nh"><b>'+$(n.label)+'</b><span class="st '+n.status+'">'+n.status+'</span>'+(n.primary?'<span class="note">main number</span>':'')+'</div>'
  +(n.reasons.length?'<ul class="rs">'+n.reasons.map(r=>'<li>'+$(r)+'</li>').join('')+'</ul>':'')+'<div class="sg">'+$(n.suggest)+'</div>'
  +'<div class="kp">'+kp('Calls (7 days)',c.calls.n,'')+kp('Picked up',P(ar),bar!=null?'was '+P(bar):'')+kp('Hung up in under 10 sec',P(sh),'of answered')+kp('Texts (7 days)',c.texts.n,'')+kp('Delivered',P(dl),'')+kp('Blocked by carriers',P(bl),'')+'</div>'
  +'<div class="ch" id="ch'+n.num.replace(/\\D/g,'')+'"></div></div>'}
const el=document.getElementById('list');
el.innerHTML=D.list.length?D.list.map(card).join(''):'<div class="card"><div class="empty">No numbers found. Add TWILIO_FROM in Cloudflare and make a few calls.</div></div>';
D.list.forEach(n=>{const e=document.getElementById('ch'+n.num.replace(/\\D/g,''));if(e)chart('ch'+n.num.replace(/\\D/g,''),n.daily.map(d=>d.d),[{n:'calls',v:n.daily.map(d=>d.dials),c:'#4a9be8'},{n:'picked up',v:n.daily.map(d=>d.picked),c:'#32cd32'},{n:'texts blocked',v:n.daily.map(d=>d.blocked),c:'#ff7a7a'}],{legend:true})});
document.getElementById('chk').onclick=async e=>{e.target.disabled=true;document.getElementById('twr').textContent='Asking Twilio...';try{const j=await (await fetch('/admin/numbers/check',{method:'POST'})).json();document.getElementById('twr').innerHTML=(j.results||[]).map(r=>'<p><b>'+$(r.num||'')+'</b> '+(r.ok?'<span class="good">'+$(r.data)+'</span>':'<span class="warn">'+$(r.message)+'</span>')+'</p>').join('')||'No numbers to check.'}catch(_){document.getElementById('twr').textContent='Could not reach the server.'}e.target.disabled=false};
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// ---- Scorecard: every sales number in one place, each with one fixed definition (written out on the Playbook page)
const median = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), m = Math.floor(b.length / 2); return b.length % 2 ? b[m] : Math.round((b[m - 1] + b[m]) / 2); };
const ratio = (a, b, d = 1) => b ? Math.round(a / b * 10 ** d) / 10 ** d : null;
async function scorecard(env, days) {
  await ensureTable(env.DB);
  days = [7, 14, 30, 90].includes(days) ? days : 30;
  const today = todayStr(), start = addDays(today, -(days - 1)), startUtc = etStartUtc(start);
  const q = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all().catch(() => ({ results: [] }))).results || [];
  const rows = await speedRows(env);
  const [dials, results, bookLogs, spendRows, texts] = await Promise.all([
    q("SELECT lead_id, duration, tw_status, talk FROM dial_calls WHERE started_at >= ?", startUtc),
    q("SELECT lead_id, reason FROM stage_log WHERE reason LIKE 'Call result: %' AND at >= ?", startUtc),
    q("SELECT lead_id, MIN(at) at FROM stage_log WHERE to_stage IN ('booked','working','done') GROUP BY lead_id HAVING MIN(at) >= ?", startUtc),
    q("SELECT month, channel, amount FROM ad_spend2"),
    q("SELECT COUNT(*) n FROM messages WHERE direction = 'out' AND at >= ?", startUtc),
  ]);
  const REACH = ["Answered", "Interested", "Callback", "Booked", "Deposit pending", "Quote sent", "Not interested"];
  // ---- activity inside the period
  const withStatus = dials.filter(d => d.tw_status), picked = withStatus.filter(d => d.tw_status === "completed" && d.talk > 0);
  const convs = results.filter(r => REACH.includes(r.reason.slice(13))).length;
  const talkSecs = picked.reduce((a, d) => a + (d.talk || 0), 0);
  const bookings = bookLogs.length;
  const activity = {
    dials: dials.length, picked_up: picked.length, pickup_rate: ratio(100 * picked.length, withStatus.length), conversations: convs, conversation_rate: ratio(100 * convs, dials.length),
    avg_talk_secs: picked.length ? Math.round(talkSecs / picked.length) : null, bookings, dials_per_booking: ratio(dials.length, bookings), texts_out: (texts[0] || {}).n || 0,
  };
  // ---- the leads that arrived in the period (cohort)
  const L = rows.filter(r => r.type === "quote" && r.cd >= start && r.cd <= today);
  const called = L.filter(r => r.secs != null), booked = L.filter(r => r.booked);
  const calledIn = (r, sec) => r.secs != null && r.secs <= sec;
  const cohort = {
    leads: L.length, called: called.length, never_called: L.filter(r => r.never_called).length,
    speed_median_secs: median(called.map(r => r.secs)), within_5min: ratio(100 * L.filter(r => calledIn(r, 300)).length, L.length), within_1hr: ratio(100 * L.filter(r => calledIn(r, 3600)).length, L.length),
    reached: L.filter(r => r.reached).length, contact_rate: ratio(100 * L.filter(r => r.reached).length, called.length),
    dials_per_lead: ratio(L.reduce((a, r) => a + r.calls, 0), called.length), dials_to_reach: ratio(L.filter(r => r.reached).reduce((a, r) => a + (r.to_reach || 0), 0), L.filter(r => r.reached).length),
    booked: booked.length, booked_rate: ratio(100 * booked.length, L.length), revenue: booked.reduce((a, r) => a + (r.value || 0), 0), avg_job: ratio(booked.reduce((a, r) => a + (r.value || 0), 0), booked.length, 0),
    dials_per_booking: ratio(booked.reduce((a, r) => a + r.calls, 0), booked.length), touchpoints_per_booking: ratio(booked.reduce((a, r) => a + r.touches_pre, 0), booked.length),
    days_to_book: ratio(booked.filter(r => r.booked_days != null).reduce((a, r) => a + r.booked_days, 0), booked.filter(r => r.booked_days != null).length),
  };
  // ---- ad cost (month totals spread evenly over the days they cover)
  const dayN = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate(), spend = {};
  for (const r of spendRows) {
    let tot = 0; const n = dayN(r.month);
    for (let i = 1; i <= n; i++) { const d = `${r.month}-${String(i).padStart(2, "0")}`; if (d >= start && d <= today) tot++; }
    spend[r.channel] = (spend[r.channel] || 0) + r.amount * tot / n;
  }
  const paid = ch => L.filter(r => ch === "all" ? r.channel : r.channel === ch), cost = {};
  for (const ch of ["meta", "google", "all"]) {
    const pl = paid(ch), pb = pl.filter(r => r.booked), sp = ch === "all" ? (spend.meta || 0) + (spend.google || 0) : (spend[ch] || 0), rev = pb.reduce((a, r) => a + (r.value || 0), 0);
    cost[ch] = { spend: Math.round(sp), leads: pl.length, booked: pb.length, cost_per_lead: ratio(sp, pl.length, 2), cost_per_booking: ratio(sp, pb.length, 2), revenue: rev, roas: ratio(rev, sp, 2) };
  }
  // ---- how trustworthy the numbers above are
  const unclass = L.reduce((a, r) => a + (r.unclassified || 0), 0), callsAll = L.reduce((a, r) => a + r.calls, 0);
  const noValue = booked.filter(r => !r.value).length;
  const quality = {
    dials_without_twilio_report: dials.length - withStatus.length, dials_unclassified: unclass, dials_unclassified_pct: ratio(100 * unclass, callsAll),
    booked_without_price: noValue, lost_without_reason: L.filter(r => r.stage === "lost" && r.lost === "No reason logged").length,
    note: "Cost per booking only means something once 14+ days have passed since the leads arrived (late bookings are still coming in).",
  };
  return { success: true, days, start, today, activity, cohort, cost, quality };
}

// ---- Dashboard (owner only): the page the CRM opens to
async function dashData(env, days) {
  await ensureTable(env.DB);
  days = [1, 7, 30, 90].includes(days) ? days : 30;
  const today = todayStr(), start = days === 1 ? today : addDays(today, -(days - 1)), startUtc = etStartUtc(start), minS = contactMinSecs(env);
  const q = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all().catch(() => ({ results: [] }))).results || [];
  const base = "l.type != 'newsletter' AND COALESCE(l.ip,'') != 'demo'";
  const sr = await speedRows(env).catch(() => []);
  const [all, logs, notCalled, due, waiting, appts, dialsToday] = await Promise.all([
    q(`SELECT l.id, l.stage, l.value, l.created_at FROM leads l WHERE ${base} ORDER BY l.id DESC LIMIT 6000`),
    q(`SELECT s.lead_id, s.to_stage FROM stage_log s JOIN leads l ON l.id = s.lead_id WHERE l.created_at >= ? AND ${base} AND s.to_stage IN ('interested','quoted','deposit','booked','working','done')`, startUtc),
    q(`SELECT l.id, l.name, l.service, l.created_at FROM leads l WHERE ${base} AND l.stage IN ('new','nocontact') AND l.created_at >= datetime('now','-7 days') AND NOT EXISTS (SELECT 1 FROM dial_calls d WHERE d.lead_id = l.id) ORDER BY l.created_at ASC LIMIT 8`),
    q(`SELECT l.id, l.name, l.service, l.follow_up_date, l.follow_up FROM leads l WHERE ${base} AND COALESCE(l.follow_up_date,'') != '' AND l.follow_up_date <= ? AND l.stage NOT IN ('lost','done') ORDER BY l.follow_up_date ASC LIMIT 8`, today),
    q(`SELECT l.id, l.name, m.at FROM messages m JOIN leads l ON l.id = m.lead_id WHERE m.id = (SELECT MAX(id) FROM messages WHERE lead_id = l.id) AND m.direction = 'in' ORDER BY m.at ASC LIMIT 8`),
    q(`SELECT l.id, l.name, l.service, l.appt_at, l.stage FROM leads l WHERE ${base} AND COALESCE(l.appt_at,'') != '' AND l.stage != 'lost' AND l.appt_at >= ? ORDER BY l.appt_at ASC LIMIT 8`, today),
    q("SELECT COUNT(*) n FROM dial_calls WHERE started_at >= ?", etStartUtc(today)),
  ]);
  const OPEN = ["new", "nocontact", "contacted", "quoted", "aged", "interested", "deposit"], WON = ["booked", "working", "done"];
  const ms = s => Date.parse(String(s).replace(" ", "T") + "Z"), age = l => Math.floor((Date.now() - ms(l.created_at)) / 864e5);
  const inR = all.filter(l => l.created_at >= startUtc);
  const ever = { interested: new Set(), deposit: new Set(), booked: new Set(), working: new Set(), done: new Set() };
  const rank = { interested: 0, quoted: 0, deposit: 1, booked: 2, working: 3, done: 4 };
  // one definition of "called" and "reached" for every report: the same per-lead facts the Speed page uses (a picked result beats guessing from call length)
  const reach = new Set(sr.filter(r => r.reached).map(r => r.id));
  const step = new Map(); // furthest step a lead ever reached
  const bump = (id, r) => step.set(id, Math.max(step.get(id) ?? -1, r));
  for (const g of logs) bump(g.lead_id, rank[g.to_stage]);
  for (const l of inR) { const cur = { interested: 0, quoted: 0, deposit: 1, booked: 2, working: 3, done: 4 }[l.stage]; if (cur != null) bump(l.id, cur); }
  const n = inR.length, cnt = f => inR.filter(l => f(step.get(l.id) ?? -1)).length;
  const calledSet = new Set(sr.filter(r => r.calls > 0).map(r => r.id));
  const funnel = [["New leads", n], ["Called", inR.filter(l => calledSet.has(l.id)).length], ["Reached", inR.filter(l => reach.has(l.id)).length], ["Interested", cnt(r => r >= 0)], ["Deposit pending", cnt(r => r >= 1)], ["Deposit collected", cnt(r => r >= 2)], ["In shop", cnt(r => r >= 3)], ["Completed", cnt(r => r >= 4)]];
  const sum = (arr, f) => arr.filter(f).reduce((a, l) => a + (l.value || 0), 0);
  const status = { open: inR.filter(l => OPEN.includes(l.stage)).length, won: inR.filter(l => WON.includes(l.stage)).length, lost: inR.filter(l => l.stage === "lost").length };
  const value = { open: sum(inR, l => OPEN.includes(l.stage)), won: sum(inR, l => WON.includes(l.stage)), lost: sum(inR, l => l.stage === "lost") };
  const BK = [["d1", "1-2 days", 0, 2], ["d3", "3-6 days", 3, 6], ["d7", "7+ days", 7, 29], ["d30", "30+ days", 30, 1e9]], dist = {};
  for (const l of all) { let k = l.stage; if (["new", "nocontact", "contacted", "quoted", "aged"].includes(k)) { const a = age(l); k = (BK.find(b => a >= b[2] && a <= b[3]) || BK[0])[0]; } (dist[k] = dist[k] || { n: 0, v: 0 }); dist[k].n++; dist[k].v += l.value || 0; }
  const labels = Object.fromEntries(BK.map(b => [b[0], b[1]]).concat([["interested", "Interested (call back)"], ["deposit", "Deposit pending"], ["booked", "Deposit collected"], ["working", "In shop"], ["done", "Service completed"], ["lost", "NO"]]));
  const order = ["d1", "d3", "d7", "d30", "interested", "deposit", "booked", "working", "done", "lost"];
  const nums = await numberHealth(env).catch(() => []);
  return { success: true, days, start, today, n, status, value, funnel, won: status.won, conv: n ? Math.round(1000 * status.won / n) / 10 : 0,
    dist: order.filter(k => dist[k]).map(k => ({ k, label: labels[k], n: dist[k].n, v: dist[k].v })),
    notCalled: notCalled.map(l => ({ id: l.id, name: l.name, service: l.service, mins: Math.round((Date.now() - ms(l.created_at)) / 60000) })),
    due: due.map(l => ({ id: l.id, name: l.name, what: l.follow_up || "Follow up", date: l.follow_up_date })),
    waiting: waiting.map(w => ({ id: w.id, name: w.name, mins: Math.round((Date.now() - ms(w.at)) / 60000) })),
    appts: appts.map(a => ({ id: a.id, name: a.name, service: a.service, at: a.appt_at })),
    dialsToday: (dialsToday[0] || {}).n || 0, numbers: nums.map(x => ({ label: x.label, status: x.status, reason: x.reasons[0] || x.suggest })) };
}
async function dashboardPage(env, user) {
  await ensureTable(env.DB);
  const tc = await todayCount(env);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Dashboard | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:var(--bg,#07090c);color:var(--text,#e8eaed)}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px;flex-wrap:wrap}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}
${RPT_CSS}
main{max-width:1300px}.dh{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.dh h2{margin:0;font-size:22px;text-transform:none;letter-spacing:-.3px;color:#fff}
.g3{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.g6{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.sm{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:14px 16px;text-decoration:none;color:inherit;display:block}.sm small{display:block;color:#8a939e;font-size:12.5px}.sm b{display:block;font-size:28px;line-height:1.15;margin-top:4px;letter-spacing:-.4px}.sm span{font-size:12px;color:#7c838d}.sm.hot b{color:#ff9a6b}.sm:hover{border-color:#2b3641}
.dn{display:flex;align-items:center;gap:20px;flex-wrap:wrap;justify-content:center}.lg{display:flex;flex-direction:column;gap:8px;font-size:13.5px}.lg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:8px}.lg span{color:#8a939e;margin-left:6px}
.rg{text-align:center}.rg b{display:block;font-size:12px;color:#8a939e;font-weight:500}.rg strong{font-size:26px}
.fn div{display:grid;grid-template-columns:150px 1fr 90px;gap:10px;align-items:center;margin:7px 0;font-size:14px}.fn i{display:block;height:22px;border-radius:6px;background:linear-gradient(90deg,#1f6a37,#32cd32)}.fn span.p{color:#8a939e;font-size:12.5px;text-align:right}
.li{display:flex;flex-direction:column}.li a{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid #141a20;color:inherit;text-decoration:none;font-size:14px}.li a:last-child{border:0}.li a span{color:#8a939e;white-space:nowrap}.li a:hover b{color:#4fdc5a}
.nb2{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #141a20}.nb2:last-child{border:0}.pl{border-radius:999px;padding:2px 10px;font-weight:800;font-size:11px;letter-spacing:.5px;text-transform:uppercase;flex:none;margin-top:2px}.pl.green{background:#0f2c18;color:#4fdc5a}.pl.yellow{background:#2a2410;color:#ffd166}.pl.red{background:#2c1414;color:#ff8a8a}.pl.learning{background:#161c23;color:#9aa4af}
${BNAV_CSS}
@media(max-width:700px){header{padding:12px 14px}h1{font-size:17px}.fn div{grid-template-columns:110px 1fr 70px}}
</style></head><body>
<header><h1>Divine Detailers <b>dashboard</b></h1>${nav("dashboard", tc, true)}</header>
${bnav("dashboard", tc, true)}
<main>
<div class="dh"><h2 id="hi">Dashboard</h2><div class="rb"><button data-d="1">Today</button><button data-d="7">7 days</button><button data-d="30" class="on">30 days</button><button data-d="90">90 days</button></div></div>
<div class="g6" id="kpi"></div>
<div class="g3"><div class="card"><h3>Opportunity status</h3><div class="dn" id="st"></div></div><div class="card"><h3>Opportunity value</h3><div class="kp" id="vl"></div></div><div class="card"><h3>Conversion rate</h3><div class="dn" id="cv"></div></div></div>
<div class="g2"><div class="card"><h3>Funnel</h3><div class="fn" id="fn"></div></div><div class="card"><h3>Where leads are now</h3><div class="dn" id="ds"></div></div></div>
<div class="g3"><div class="card"><h3>Needs attention</h3><div class="li" id="at"></div></div><div class="card"><h3>Coming up</h3><div class="li" id="ap"></div></div><div class="card"><h3>Number health</h3><div id="nh"></div></div></div>
<p class="note" id="nt"></p>
</main>
<script>
${RPT_JS}
const COL=['#4a9be8','#22d3ee','#a78bfa','#32cd32','#f5b942','#ff8a5b','#8b95a3','#6ee7b7','#f472b6','#64748b'];
function donut(id,parts,center){const tot=parts.reduce((a,p)=>a+p.v,0)||1,R=62,C=2*Math.PI*R;let off=0,s='<svg width="170" height="170" viewBox="0 0 170 170"><g transform="rotate(-90 85 85)"><circle cx="85" cy="85" r="'+R+'" fill="none" stroke="#161c23" stroke-width="22"/>';
  parts.forEach(p=>{const len=C*p.v/tot;if(p.v>0)s+='<circle cx="85" cy="85" r="'+R+'" fill="none" stroke="'+p.c+'" stroke-width="22" stroke-dasharray="'+len+' '+(C-len)+'" stroke-dashoffset="'+(-off)+'"><title>'+p.n+': '+p.v+'</title></circle>';off+=len});
  s+='</g><text x="85" y="92" text-anchor="middle" fill="#e8eaed" font-size="24" font-weight="700">'+center+'</text></svg>';
  document.getElementById(id).innerHTML=s+'<div class="lg">'+parts.map(p=>'<div><i style="background:'+p.c+'"></i>'+$(p.n)+'<span>'+p.v+(p.x?' &middot; '+p.x:'')+'</span></div>').join('')+'</div>'}
function ring(pctv,label,sub){const R=62,C=2*Math.PI*R,len=C*Math.min(100,pctv)/100;return '<div class="rg"><svg width="170" height="170" viewBox="0 0 170 170"><g transform="rotate(-90 85 85)"><circle cx="85" cy="85" r="'+R+'" fill="none" stroke="#161c23" stroke-width="16"/><circle cx="85" cy="85" r="'+R+'" fill="none" stroke="#32cd32" stroke-width="16" stroke-linecap="round" stroke-dasharray="'+len+' '+(C-len)+'"/></g><text x="85" y="94" text-anchor="middle" fill="#e8eaed" font-size="26" font-weight="700">'+pctv+'%</text></svg><b>'+label+'</b><strong>'+sub+'</strong></div>'}
const mn=m=>m<60?m+' min':m<2880?Math.floor(m/60)+' h':Math.round(m/1440)+' days';
const sd=a=>{const d=new Date(String(a).replace(' ','T'));return isNaN(d)?a:d.toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})};
function draw(d){const h=new Date().getHours();document.getElementById('hi').textContent=(h<12?'Good morning':h<18?'Good afternoon':'Good evening')+', Bronson';
  const goal=+(localStorage.getItem('dgoal')||50);
  document.getElementById('kpi').innerHTML=
   '<a class="sm" href="/admin/pipeline"><small>New leads</small><b>'+d.n+'</b><span>in this range</span></a>'
   +'<a class="sm'+(d.notCalled.length?' hot':'')+'" href="/admin/dialer"><small>Not called yet</small><b>'+d.notCalled.length+'</b><span>new leads, last 7 days</span></a>'
   +'<a class="sm" href="/admin/dials"><small>Dials today</small><b>'+d.dialsToday+'</b><span>goal '+goal+'</span></a>'
   +'<a class="sm'+(d.waiting.length?' hot':'')+'" href="/admin/messages"><small>Texts waiting on you</small><b>'+d.waiting.length+'</b><span>lead texted last</span></a>'
   +'<a class="sm" href="/admin/pipeline"><small>Bookings</small><b>'+d.won+'</b><span>'+d.conv+'% of leads</span></a>'
   +'<a class="sm" href="/admin/meta"><small>Booked revenue</small><b>'+money(d.value.won)+'</b><span>in this range</span></a>';
  donut('st',[{n:'Open',v:d.status.open,c:'#4a9be8'},{n:'Won',v:d.status.won,c:'#32cd32'},{n:'Lost',v:d.status.lost,c:'#64748b'}],fmt(d.n));
  document.getElementById('vl').innerHTML=kp('Open pipeline',money(d.value.open),'')+kp('Won',money(d.value.won),'')+kp('Lost',money(d.value.lost),'')+kp('Average job',d.status.won&&d.value.won?money(d.value.won/d.status.won):'-','');
  document.getElementById('cv').innerHTML=ring(d.conv,'Won revenue',money(d.value.won));
  const f=d.funnel,mx=Math.max(1,f[0][1]);document.getElementById('fn').innerHTML=f.map((x,i)=>'<div><span>'+x[0]+'</span><span><i style="width:'+Math.max(2,Math.round(100*x[1]/mx))+'%"></i></span><span class="p">'+x[1]+(i?' &middot; '+pct(x[1],f[i-1][1])+'%':'')+'</span></div>').join('');
  const tot=d.dist.reduce((a,x)=>a+x.n,0);donut('ds',d.dist.map((x,i)=>({n:x.label,v:x.n,c:COL[i%COL.length],x:x.v?money(x.v):''})),fmt(tot));
  const li=(arr,fn)=>arr.length?arr.map(fn).join(''):'';
  document.getElementById('at').innerHTML=li(d.notCalled,l=>'<a href="/admin/dialer?lead='+l.id+'"><b>'+$(l.name||'Lead')+'</b><span>not called &middot; '+mn(l.mins)+'</span></a>')+li(d.due,l=>'<a href="/admin/dialer?lead='+l.id+'"><b>'+$(l.name||'Lead')+'</b><span>'+$(l.what)+' &middot; due '+l.date+'</span></a>')+li(d.waiting,l=>'<a href="/admin/messages#id='+l.id+'"><b>'+$(l.name||'Lead')+'</b><span>text waiting &middot; '+mn(l.mins)+'</span></a>')||'<div class="empty good">Nothing needs attention right now.</div>';
  document.getElementById('ap').innerHTML=d.appts.length?d.appts.map(a=>'<a href="/admin/pipeline#id='+a.id+'"><b>'+$(a.name||'Lead')+' <small style="color:#8a939e;font-weight:400">'+$(a.service||'')+'</small></b><span>'+sd(a.at)+'</span></a>').join(''):'<div class="empty">No appointments booked ahead.</div>';
  document.getElementById('nh').innerHTML=d.numbers.length?d.numbers.map(n=>'<div class="nb2"><span class="pl '+n.status+'">'+n.status+'</span><div><b>'+$(n.label)+'</b><div class="note">'+$(n.reason)+'</div></div></div>').join('')+'<p class="note"><a href="/admin/numbers" style="color:#8ec0ff">Open number health</a></p>':'<div class="empty">No numbers recorded yet.</div>';
  document.getElementById('nt').textContent='Range: '+d.start+' to '+d.today+'. Won means Deposit collected, In shop or Service completed. Value is the job value set on each lead.'}
async function load(){const d=+(document.querySelector('.rb .on')||{dataset:{d:30}}).dataset.d;const j=await (await fetch('/admin/dashboard/data?days='+d)).json();if(j.success)draw(j)}
document.querySelectorAll('.rb button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.rb button').forEach(x=>x.classList.toggle('on',x===b));load()});
load();setInterval(()=>{if(!document.hidden)load()},60000);
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// ---- Logins you create in the CRM (owner only). Passwords are never stored: only a salted hash, so nothing secret goes in the code or the public repository.
async function hashPw(pw, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode("dd-user|" + salt), iterations: 100000 }, key, 256));
}
async function dbUser(env, name) {
  if (!env.DB || !/^[a-z0-9]{3,20}$/.test(name)) return null;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS crm_users (username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  return await env.DB.prepare("SELECT username, salt, hash FROM crm_users WHERE username = ?").bind(name).first().catch(() => null);
}
async function usersPage(env, user) {
  await ensureTable(env.DB);
  const tc = await todayCount(env);
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS crm_users (username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  const rows = (await env.DB.prepare("SELECT username, created_at FROM crm_users ORDER BY username").all()).results || [];
  const allUsers = [{ username: "giordani", at: "", env: true }, ...rows.map(r => ({ username: r.username, at: isoUtc(r.created_at), env: false }))];
  for (const u of allUsers) u.perms = [...(await userPerms(env, u.username))];
  const payload = JSON.stringify({ users: allUsers, labels: PERM_LABELS }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Logins | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:var(--bg,#07090c);color:var(--text,#e8eaed)}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px;flex-wrap:wrap}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}
${RPT_CSS}
main{max-width:760px}.fr{display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end}.fr label{display:block;color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:4px}.fr input{width:100%;background:#10141a;border:1px solid #232932;color:#fff;border-radius:10px;padding:10px 12px;font:inherit;min-height:44px}
.bt{background:#10151b;border:1px solid #232b34;color:#e8eaed;border-radius:10px;padding:9px 14px;font:inherit;font-weight:650;cursor:pointer;min-height:44px}.bt.g{background:#32cd32;border-color:#32cd32;color:#04120a}.bt.r{color:#ff8a8a}
.pm{flex-basis:100%;display:flex;flex-wrap:wrap;gap:6px 16px;padding-top:4px}.pm label{display:flex;align-items:center;gap:7px;color:#cfd6de;font-size:13.5px;margin:0;text-transform:none;letter-spacing:0;cursor:pointer}.pm input[type=checkbox]{width:auto!important;min-height:0!important;padding:0!important;margin:0}.ps{color:#4fdc5a;font-size:12.5px;flex-basis:100%;min-height:16px}.ur{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 0;border-bottom:1px solid #141a20}.ur:last-child{border:0}.ur b{flex:1;font-size:16px}.ur input{background:#10141a;border:1px solid #232932;color:#fff;border-radius:10px;padding:8px 10px;font:inherit;width:180px}
${BNAV_CSS}
@media(max-width:700px){header{padding:12px 14px}h1{font-size:17px}.fr{grid-template-columns:1fr}}
</style></head><body>
<header><h1>Divine Detailers <b>logins</b></h1>${nav("users", tc, true)}</header>
${bnav("users", tc, true)}
<main>
<p class="note">Tick what each person can open. The dialer, call scripts, coach, call recordings, call transcripts, number health and this page are never available to them. Only you can add, change or remove logins.</p>
<div class="card"><h3>Add a login</h3><div class="fr"><div><label for="nu">Username</label><input id="nu" autocomplete="off" autocapitalize="none" maxlength="20" placeholder="letters and numbers"></div><div><label for="np">Password</label><input id="np" type="text" autocomplete="off" placeholder="at least 8 characters"></div><button class="bt g" id="add" type="button">Add login</button></div><div class="note" id="am"></div></div>
<div class="card"><h3>Current logins</h3><div id="ul"></div></div>
<p class="note">Bronson's and Giordani's passwords are Cloudflare secrets: change them there. Giordani is listed so you can choose what he sees. Reports include revenue, ad spend and cost numbers, so turn that on only for someone you trust with them.</p>
</main>
<script type="application/json" id="data">${payload}</script>
<script>
${RPT_JS}
const DATA=JSON.parse(document.getElementById('data').textContent);let U=DATA.users;const LB=DATA.labels;
const pm=u=>'<div class="pm">'+Object.keys(LB).map(k=>'<label><input type="checkbox" data-p="'+k+'"'+(u.perms.indexOf(k)>=0?' checked':'')+'> '+$(LB[k])+'</label>').join('')+'</div><div class="ps"></div>';
function draw(){document.getElementById('ul').innerHTML=U.map(u=>'<div class="ur" data-u="'+$(u.username)+'"><b>'+$(u.username)+(u.env?' <span class="note">(password is in Cloudflare)</span>':'')+'</b>'+(u.env?'':'<input type="text" placeholder="New password" autocomplete="off"><button class="bt" data-a="reset" type="button">Change password</button><button class="bt r" data-a="delete" type="button">Remove</button>')+pm(u)+'</div>').join('')}
document.getElementById('ul').addEventListener('change',async e=>{const c=e.target.closest('input[data-p]');if(!c)return;const row=c.closest('[data-u]'),u=U.find(x=>x.username===row.dataset.u);const perms=[...row.querySelectorAll('input[data-p]')].filter(x=>x.checked).map(x=>x.dataset.p);const j=await act({action:'perms',username:u.username,perms:perms});const st=row.querySelector('.ps');if(j.success){u.perms=perms;st.textContent='Saved.'}else{st.style.color='#ff8a8a';st.textContent=j.message||'Could not save.'}setTimeout(()=>{st.textContent='';st.style.color=''},2000)});
async function act(body){const r=await fetch('/admin/users',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return r.json().catch(()=>({success:false,message:'No connection.'}))}
document.getElementById('add').onclick=async()=>{const m=document.getElementById('am');m.textContent='';const j=await act({action:'add',username:document.getElementById('nu').value,password:document.getElementById('np').value});if(j.success){U=U.concat(j.users.filter(x=>!U.some(y=>y.username===x.username)).map(x=>Object.assign(x,{env:false,perms:j.perms||[]})));document.getElementById('nu').value='';document.getElementById('np').value='';m.textContent='Login added. Choose what they can see below.';draw()}else m.textContent=j.message||'Could not add it.'};
document.getElementById('ul').onclick=async e=>{const b=e.target.closest('[data-a]');if(!b)return;const row=b.closest('[data-u]'),u=row.dataset.u;
  if(b.dataset.a==='delete'){if(b.dataset.sure!=='1'){b.dataset.sure='1';b.textContent='Tap again to remove';return}const j=await act({action:'delete',username:u});if(j.success){U=U.filter(x=>x.username!==u);draw()}return}
  const pw=row.querySelector('input').value;const j=await act({action:'reset',username:u,password:pw});b.textContent=j.success?'Changed':(j.message||'Could not change');setTimeout(()=>{b.textContent='Change password'},2500)};
draw();
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
async function usersApi(env, request) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS crm_users (username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  const b = await request.json().catch(() => ({})), name = String(b.username || "").trim().toLowerCase(), pw = String(b.password || "").trim();
  const list = async () => ((await env.DB.prepare("SELECT username, created_at FROM crm_users ORDER BY username").all()).results || []).map(r => ({ username: r.username, at: isoUtc(r.created_at) }));
  if (!/^[a-z0-9]{3,20}$/.test(name)) return json({ success: false, message: "Use 3 to 20 letters or numbers for the username." }, 400);
  if (name === OWNER) return json({ success: false, message: "That username is already used." }, 400);
  if (b.action === "perms") {
    if (!Object.hasOwn(USERS, name) && !(await env.DB.prepare("SELECT 1 FROM crm_users WHERE username = ?").bind(name).first())) return json({ success: false, message: "No such login." }, 404);
    const perms = (Array.isArray(b.perms) ? b.perms : []).filter(k => Object.hasOwn(PERM_PATHS, k));
    await env.DB.prepare("INSERT INTO user_perms (username, perms) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET perms = excluded.perms").bind(name, JSON.stringify(perms)).run();
    return json({ success: true, perms });
  }
  if (Object.hasOwn(USERS, name)) return json({ success: false, message: "That username is already used." }, 400);
  if (b.action === "delete") { await env.DB.batch([env.DB.prepare("DELETE FROM crm_users WHERE username = ?").bind(name), env.DB.prepare("DELETE FROM user_perms WHERE username = ?").bind(name)]); return json({ success: true, users: await list() }); }
  if (pw.length < 8 || pw.length > 100) return json({ success: false, message: "The password needs at least 8 characters." }, 400);
  const exists = await env.DB.prepare("SELECT 1 FROM crm_users WHERE username = ?").bind(name).first();
  const salt = hex(crypto.getRandomValues(new Uint8Array(16))), hash = await hashPw(pw, salt);
  if (b.action === "add") {
    if (exists) return json({ success: false, message: "That username is already used." }, 400);
    await env.DB.prepare("INSERT INTO crm_users (username, salt, hash) VALUES (?,?,?)").bind(name, salt, hash).run();
    await env.DB.prepare("INSERT OR IGNORE INTO user_perms (username, perms) VALUES (?, ?)").bind(name, JSON.stringify(PERM_DEFAULT)).run();
  } else if (b.action === "reset") {
    if (!exists) return json({ success: false, message: "No such login." }, 404);
    await env.DB.prepare("UPDATE crm_users SET salt = ?, hash = ? WHERE username = ?").bind(salt, hash, name).run();
  } else return json({ success: false }, 400);
  return json({ success: true, users: await list(), perms: PERM_DEFAULT });
}

// ---- Automations: editable text sequences and campaigns. Each automation has rules (who, when, what stage) and ordered steps (timing + message).
// Texting only ever goes to leads who agreed (sms_consent), never in quiet hours (before 8 AM or after 9 PM Eastern), and stops for a number that replied STOP.
const AUTO_KINDS = ["sequence", "stage", "appointment"];
const autoMode = env => env.TEXT_AUTO === "1" && twilioOn(env);
// texts only go out between 8 AM and 9 PM Eastern (TEXT_HOURS, e.g. "9-20", can narrow that window)
function quietHoursOk(env = {}, d = new Date()) {
  const [from, to] = /^\d{1,2}-\d{1,2}$/.test(String(env.TEXT_HOURS || "")) ? String(env.TEXT_HOURS).split("-").map(Number) : [8, 21];
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(d));
  return h >= from && h < to;
}
const AUTO_FIELDS = ["first", "service", "service_name", "vehicle", "pitch", "shop", "address", "appointment", "review"];
function renderAuto(body, l, env) {
  const veh = [l.year, l.make, l.model].filter(Boolean).join(" ") || "vehicle", first = String(l.name || "").trim().split(/\s+/)[0], sv = String(l.service || "").toLowerCase();
  const coat = /coat/.test(sv), tint = /tint/.test(sv);
  const v = {
    first: first && !/^\+?[\d\s()-]+$/.test(first) ? first : "there", service: sv || "our services",
    service_name: coat ? "ceramic coating" : tint ? "ceramic tint" : sv || "our services", vehicle: /^your /.test(veh) ? veh : "your " + veh,
    pitch: coat ? "Our ceramic coating adds a deep, glossy finish, protects your paint and makes every wash easier." : tint ? "Our tint keeps your ride cooler, protected and more private, with a clean, factory look." : "",
    shop: SHOP.name, address: SHOP.address, appointment: fmtAppt(l.appt_at) || "your appointment time", review: reviewLink(env),
  };
  return String(body || "").replace(/\{(\w+)\}/g, (m, k) => (v[k] === undefined ? m : v[k])).replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
const FIRST_TEXT_TAIL = "Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.";
async function autoSend(env, a, step, lead) {
  const raw = String(step.body || "");
  if (/\{review\}/.test(raw) && !reviewLink(env)) return 0; // needs GOOGLE_REVIEW_URL: nothing is claimed, so it sends once that is set
  let body = renderAuto(raw, lead, env);
  if (/\{\w+\}/.test(body)) return 0;
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO automation_runs (automation_id, lead_id, step_id, status) VALUES (?,?,?, 'sending')").bind(a.id, lead.id, step.id).run();
  if (!claim.meta || !claim.meta.changes) return 0;
  // the very first text a lead gets always carries the required disclosures
  const prior = (await env.DB.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id = ? AND direction = 'out'").bind(lead.id).first()) || {};
  if (!prior.n && !/stop/i.test(body)) body += "\n\n" + FIRST_TEXT_TAIL;
  const res = await sendLeadText(env, lead, body, { auto: true, label: `${a.name} #${step.pos + 1}` }).catch(e => ({ ok: false, message: String((e && e.message) || e) }));
  await env.DB.prepare("UPDATE automation_runs SET status = ?, body = ? WHERE automation_id = ? AND lead_id = ? AND step_id = ?").bind(res.ok ? "sent" : "failed: " + String(res.message || "").slice(0, 100), body.slice(0, 1000), a.id, lead.id, step.id).run().catch(() => {});
  return 1;
}
async function runAutomations(env) {
  if (!env.DB || !autoMode(env) || !quietHoursOk(env)) return;
  await ensureTable(env.DB);
  const autos = (await env.DB.prepare("SELECT * FROM automations WHERE active = 1 ORDER BY id").all()).results || [];
  if (!autos.length) return;
  const allSteps = (await env.DB.prepare("SELECT * FROM automation_steps ORDER BY automation_id, pos").all()).results || [];
  const ms = x => Date.parse(String(x).replace(" ", "T") + "Z");
  const now = Date.now();
  let sent = 0;
  for (const a of autos) {
    if (sent >= 5) break; // a few a minute, so a busy morning does not go out all at once
    const steps = allSteps.filter(s => s.automation_id === a.id);
    if (!steps.length) continue;
    let rules = {}; try { rules = JSON.parse(a.rules || "{}"); } catch (e) { /* defaults */ }
    if (rules.business_hours && env.AUTO_DIAL_ANYTIME !== "1" && !inBusinessHours()) continue;
    const runs = (await env.DB.prepare("SELECT lead_id, step_id, at FROM automation_runs WHERE automation_id = ?").bind(a.id).all()).results || [];
    if (a.kind === "appointment") {
      const rows = (await env.DB.prepare("SELECT id, name, phone, service, year, make, model, appt_at FROM leads WHERE stage = 'booked' AND appt_at IS NOT NULL AND sms_consent = 1 AND COALESCE(phone,'') != '' AND COALESCE(ip,'') != 'demo' AND appt_at >= date('now','-1 day') LIMIT 200").all()).results || [];
      for (const l of rows) {
        const at = etLocalToUtc(l.appt_at); if (!at) continue;
        for (const st of steps) {
          const due = at.getTime() - st.after_min * 60000;
          if (now < due || now >= due + 30 * 60000 || now >= at.getTime()) continue;
          if (runs.some(r => r.lead_id === l.id && r.step_id === st.id)) continue;
          sent += await autoSend(env, a, st, l);
          if (sent >= 5) break;
        }
        if (sent >= 5) break;
      }
      continue;
    }
    const stages = (Array.isArray(rules.stages) ? rules.stages : []).filter(x => STAGE_KEYS.includes(x));
    const useStages = stages.length ? stages : ["new", "nocontact"];
    const anchor = a.kind === "stage" ? "COALESCE(l.stage_changed_at, l.created_at)" : "l.created_at";
    const days = Math.max(1, Math.min(365, Number(rules.max_days) || 8));
    const svc = (Array.isArray(rules.services) ? rules.services : []).map(x => String(x).toLowerCase().replace(/[%_]/g, "")).filter(Boolean).slice(0, 5);
    const svcSql = svc.length ? " AND (" + svc.map(() => "LOWER(l.service) LIKE ?").join(" OR ") + ")" : "";
    const rows = (await env.DB.prepare(`SELECT l.id, l.name, l.phone, l.service, l.year, l.make, l.model, l.appt_at, ${anchor} AS anchor,
        (SELECT COUNT(*) FROM messages m WHERE m.lead_id = l.id AND m.direction = 'in' AND m.at >= ${anchor}) AS replies
      FROM leads l WHERE l.type != 'newsletter' AND COALESCE(l.ip,'') != 'demo' AND COALESCE(l.phone,'') != '' AND l.sms_consent = 1
        AND l.stage IN (${useStages.map(() => "?").join(",")}) AND ${anchor} >= datetime('now', ?)${svcSql} ORDER BY ${anchor} LIMIT 300`)
      .bind(...useStages, `-${days} days`, ...svc.map(x => "%" + x + "%")).all()).results || [];
    for (const l of rows) {
      if (rules.stop_on_reply !== false && l.replies) continue; // they answered: a person takes over
      const mine = runs.filter(r => r.lead_id === l.id);
      const next = steps.find(s => !mine.some(r => r.step_id === s.id));
      if (!next) continue;
      const last = mine.length ? Math.max(...mine.map(r => ms(r.at))) : 0;
      if (now < ms(l.anchor) + next.after_min * 60000 || (last && now < last + (next.gap_min || 0) * 60000)) continue;
      sent += await autoSend(env, a, next, l);
      if (sent >= 5) break;
    }
  }
}
// ---- the Automations page and its API (owner login only)
const DEFAULT_AUTOMATIONS = [
  { name: "New lead follow-up", kind: "sequence", active: 1, rules: { anchor: "created", stages: ["new", "nocontact"], services: [], business_hours: true, stop_on_reply: true, max_days: 8 }, steps: [
    { after_min: 0, gap_min: 0, body: "Hey {first}, this is {shop}. Thanks for requesting a quote for {service_name} for {vehicle}.\n\n{pitch} When would you like to get it done?\n\nMsg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out." },
    { after_min: 120, gap_min: 120, body: "Hey {first}, it's {shop} following up about {service} for {vehicle}. Are you still interested? I can get you on the schedule this week." },
    { after_min: 1440, gap_min: 720, body: "Hi {first}, just checking in on your {service}. We have openings coming up. What day works best for you?" },
    { after_min: 4320, gap_min: 720, body: "Hey {first}, I haven't heard back so I wanted to make sure you got my messages. Happy to answer any questions about the {service} for {vehicle}." },
    { after_min: 7200, gap_min: 720, body: "Hi {first}, last follow-up from {shop}. If you're still thinking about {service}, just reply here and we'll take care of you. Otherwise no worries!" },
  ] },
  { name: "Appointment reminders", kind: "appointment", active: 1, rules: { stages: ["booked"], business_hours: false, stop_on_reply: false }, steps: [
    { after_min: 1440, gap_min: 0, body: "Hi {first}, a quick reminder from {shop} about your {service} appointment for {vehicle} on {appointment}. We are at {address}. See you then!" },
    { after_min: 120, gap_min: 0, body: "Hi {first}, see you in about 2 hours for your {service} appointment at {shop}, {address}. Reply here if anything changes." },
  ] },
  { name: "Review request", kind: "stage", active: 0, rules: { anchor: "stage", stages: ["done"], services: [], business_hours: true, stop_on_reply: false, max_days: 14 }, steps: [
    { after_min: 1440, gap_min: 0, body: "Hi {first}, thank you for trusting {shop} with {vehicle}! If you are happy with the work, a quick Google review helps a lot: {review}" },
  ] },
];
async function seedAutomations(db) {
  for (const d of DEFAULT_AUTOMATIONS) {
    const r = await db.prepare("INSERT INTO automations (name, kind, active, rules) VALUES (?,?,?,?)").bind(d.name, d.kind, d.active, JSON.stringify(d.rules)).run();
    const id = r.meta && r.meta.last_row_id;
    if (!id) continue;
    await db.batch(d.steps.map((s, i) => db.prepare("INSERT INTO automation_steps (automation_id, pos, after_min, gap_min, body) VALUES (?,?,?,?,?)").bind(id, i, s.after_min, s.gap_min, s.body)));
  }
}
async function automationsData(env) {
  await ensureTable(env.DB);
  const autos = (await env.DB.prepare("SELECT id, name, kind, active, rules FROM automations ORDER BY id").all()).results || [];
  const steps = (await env.DB.prepare("SELECT id, automation_id, pos, after_min, gap_min, body FROM automation_steps ORDER BY automation_id, pos").all()).results || [];
  const log = (await env.DB.prepare(`SELECT r.at, r.status, r.body, r.lead_id, l.name lead, a.name automation, s.pos
      FROM automation_runs r LEFT JOIN leads l ON l.id = r.lead_id LEFT JOIN automations a ON a.id = r.automation_id LEFT JOIN automation_steps s ON s.id = r.step_id ORDER BY r.rowid DESC LIMIT 40`).all()).results || [];
  return json({
    success: true, twilio: twilioOn(env), auto: env.TEXT_AUTO === "1", review: !!reviewLink(env), stages: STAGES,
    automations: autos.map(a => { let rules = {}; try { rules = JSON.parse(a.rules || "{}"); } catch (e) { /* */ } return { ...a, rules, steps: steps.filter(s => s.automation_id === a.id) }; }),
    log: log.map(x => ({ ...x, at: isoUtc(x.at) })),
  });
}
async function saveAutomation(env, b) {
  await ensureTable(env.DB);
  const name = clean(b.name, 80);
  if (!name) return json({ success: false, message: "Give it a name." }, 400);
  const kind = AUTO_KINDS.includes(b.kind) ? b.kind : "sequence";
  const r = b.rules || {};
  const rules = {
    anchor: kind === "stage" ? "stage" : "created",
    stages: (Array.isArray(r.stages) ? r.stages : []).filter(x => STAGE_KEYS.includes(x)),
    services: (Array.isArray(r.services) ? r.services : []).map(x => clean(x, 40)).filter(Boolean).slice(0, 5),
    business_hours: !!r.business_hours, stop_on_reply: r.stop_on_reply !== false, max_days: Math.max(1, Math.min(365, Math.floor(Number(r.max_days)) || 8)),
  };
  if (kind === "appointment") rules.stages = ["booked"];
  else if (!rules.stages.length) return json({ success: false, message: "Pick at least one stage." }, 400);
  const steps = (Array.isArray(b.steps) ? b.steps : []).slice(0, 10);
  if (!steps.length) return json({ success: false, message: "Add at least one text." }, 400);
  for (const s of steps) {
    if (!String(s.body || "").trim()) return json({ success: false, message: "Every text needs a message." }, 400);
    if (String(s.body).length > 600) return json({ success: false, message: "Keep each text under 600 characters." }, 400);
    const bad = (String(s.body).match(/\{(\w+)\}/g) || []).map(x => x.slice(1, -1)).find(k => !AUTO_FIELDS.includes(k));
    if (bad) return json({ success: false, message: `{${bad}} is not a merge field. Use: ${AUTO_FIELDS.map(x => "{" + x + "}").join(" ")}` }, 400);
  }
  let id = Number.isInteger(b.id) ? b.id : null;
  if (id && !(await env.DB.prepare("SELECT 1 FROM automations WHERE id = ?").bind(id).first())) id = null;
  if (id) await env.DB.prepare("UPDATE automations SET name = ?, kind = ?, rules = ?, active = ?, updated_at = datetime('now') WHERE id = ?").bind(name, kind, JSON.stringify(rules), b.active ? 1 : 0, id).run();
  else { const ins = await env.DB.prepare("INSERT INTO automations (name, kind, rules, active) VALUES (?,?,?,?)").bind(name, kind, JSON.stringify(rules), b.active ? 1 : 0).run(); id = ins.meta && ins.meta.last_row_id; }
  // steps keep their id when edited, so a lead's progress through the sequence is not lost
  const have = ((await env.DB.prepare("SELECT id FROM automation_steps WHERE automation_id = ?").bind(id).all()).results || []).map(x => x.id);
  const keep = steps.filter(s => Number.isInteger(s.id) && have.includes(s.id)).map(s => s.id);
  const stmts = have.filter(x => !keep.includes(x)).map(x => env.DB.prepare("DELETE FROM automation_steps WHERE id = ?").bind(x));
  const mins = v => Math.max(0, Math.min(60 * 24 * 90, Math.floor(Number(v)) || 0));
  steps.forEach((s, i) => {
    const vals = [i, mins(s.after_min), mins(s.gap_min), String(s.body).trim()];
    stmts.push(keep.includes(s.id) ? env.DB.prepare("UPDATE automation_steps SET pos = ?, after_min = ?, gap_min = ?, body = ? WHERE id = ?").bind(...vals, s.id) : env.DB.prepare("INSERT INTO automation_steps (pos, after_min, gap_min, body, automation_id) VALUES (?,?,?,?,?)").bind(...vals, id));
  });
  await env.DB.batch(stmts);
  return json({ success: true, id });
}
async function automationsPage(env, user) {
  await ensureTable(env.DB);
  const tc = await todayCount(env);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">${PWA_HEAD}<title>Automations | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#07090c;color:#e8eaed}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px;flex-wrap:wrap}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}.navtabs a.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
main{max-width:900px;margin:0 auto;padding:16px 22px 40px;display:flex;flex-direction:column;gap:16px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:#c3c8cf;margin:8px 0 0}.note{color:#7c838d;font-size:13px}
.ban{border-radius:12px;padding:12px 14px;font-size:14px;border:1px solid #2a313a;background:#10151b}.ban.ok{border-color:#1f5a2a;color:#9fe29f}.ban.warn{border-color:#4d3a1d;color:#ffb86b}
.top{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.btn{border:1px solid #2a313a;background:#151a21;color:#e8eaed;border-radius:10px;padding:10px 14px;font:inherit;font-weight:700;cursor:pointer;min-height:44px}.btn.g{background:#32cd32;border-color:#32cd32;color:#04120a}.btn.r{color:#ff8a8a}
.card{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:14px;display:flex;gap:12px;align-items:center;justify-content:space-between}.card .t{min-width:0;flex:1}.card b{display:block}.card small{color:#8a9099}
.pill{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;border-radius:999px;padding:2px 9px;background:#1a2027;color:#aab0b9;margin-right:6px}
.sw{position:relative;width:48px;height:28px;flex:0 0 auto}.sw input{opacity:0;width:100%;height:100%;position:absolute;inset:0;margin:0;cursor:pointer;z-index:2}.sw i{position:absolute;inset:0;border-radius:999px;background:#2a313a;transition:.15s}.sw i::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;transition:.15s}.sw input:checked+i{background:#32cd32}.sw input:checked+i::after{left:23px}
.tbw{overflow-x:auto;background:#0d1116;border:1px solid #1d2229;border-radius:14px}.tb{width:100%;border-collapse:collapse}.tb th,.tb td{text-align:left;padding:9px 12px;border-bottom:1px solid #1b1f25;vertical-align:top;font-size:13.5px}#log{min-width:620px}.tb th{color:#8a9099;font-size:12px;text-transform:uppercase;letter-spacing:.6px}
dialog:is(#adlg,#cdlg){background:#0f1319;color:#e8eaed;border:1px solid #2a313a;border-radius:16px;padding:0;width:min(640px,calc(100vw - 20px));max-height:calc(100dvh - 20px);overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}dialog:is(#adlg,#cdlg)::backdrop{background:rgba(0,0,0,.7)}
:is(#adlg,#cdlg) .rb{padding:16px;display:flex;flex-direction:column;gap:12px}:is(#adlg,#cdlg) h3{margin:0;font-size:18px}:is(#adlg,#cdlg) label{display:block;color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:4px}
:is(#adlg,#cdlg) input[type=text],:is(#adlg,#cdlg) input[type=number],:is(#adlg,#cdlg) select,:is(#adlg,#cdlg) textarea{width:100%;background:#12171e;border:1px solid #2a313a;color:#fff;border-radius:10px;padding:10px 12px;font:inherit;font-size:16px;min-height:44px;color-scheme:dark}:is(#adlg,#cdlg) textarea{resize:vertical;min-height:96px}
:is(#adlg,#cdlg) .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}:is(#adlg,#cdlg) .row>*{min-width:0}:is(#adlg,#cdlg) .num{width:84px!important}:is(#adlg,#cdlg) .un{width:120px!important}
:is(#adlg,#cdlg) input[type=checkbox]{accent-color:#32cd32}:is(#adlg,#cdlg) .chk{display:flex;gap:8px;align-items:center;font-size:14.5px;color:#e8eaed;text-transform:none;letter-spacing:0;margin:0}.chk input{width:20px;height:20px;flex:0 0 auto;margin:0;accent-color:#32cd32}
.stp{background:#0d1116;border:1px solid #1d2229;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px}.stp .sh{display:flex;justify-content:space-between;align-items:center}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chips button{border:1px solid #2a313a;background:#151a21;color:#aab0b9;border-radius:999px;padding:4px 10px;font:inherit;font-size:12.5px;cursor:pointer}.cnt{color:#7c838d;font-size:12px}
.prev{background:#0b1a10;border-left:3px solid #32cd32;border-radius:0 10px 10px 0;padding:10px 12px;white-space:pre-line;font-size:14px;color:#d6d9de}.err{color:#ff8a8a;font-size:14px;min-height:18px}
.acts{position:sticky;bottom:0;background:#0f1319;padding:10px 0 calc(10px + env(safe-area-inset-bottom,0px));border-top:1px solid #1d2229;display:flex;gap:8px;justify-content:flex-end}
${BNAV_CSS}
@media(max-width:700px){header{padding:12px 14px}h1{font-size:17px}main{padding:10px 14px 24px}}
</style></head><body>
<header><h1>Divine Detailers <b>automations</b></h1>${nav("automations", tc, true)}</header>
${bnav("automations", tc, true)}
<main>
<div id="ban" class="ban">Loading...</div>
<div class="top"><h2 style="margin:0">Text automations</h2><button class="btn g" id="newb" type="button">+ New campaign</button></div>
<p class="note">Automations text leads who ticked the text-message box, in order, on the timing you set. They never text before 8 AM or after 9 PM Eastern, skip anyone who replied STOP, and can stop when the lead replies.</p>
<div id="list" style="display:flex;flex-direction:column;gap:10px"></div>
<div class="top" style="margin-top:14px"><h2 style="margin:0">Promotional campaigns</h2><button class="btn g" id="cnew" type="button">+ New promotional campaign</button></div>
<p class="note">One-off promotional texts to a group you choose. They go Monday to Saturday, 9 AM to 6 PM Eastern, never to a number that replied STOP, and each one ends with &ldquo;Reply STOP to opt out.&rdquo;</p>
<div id="clist" style="display:flex;flex-direction:column;gap:10px"></div>
<h2>Recent sends</h2>
<div class="tbw"><table class="tb" id="log"></table></div>
</main>
<dialog id="adlg"></dialog><dialog id="cdlg"></dialog>
<script>
const $=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dlg=document.getElementById('adlg');let D=null;
const FIELDS=['first','service','service_name','vehicle','pitch','shop','address','appointment','review'];
const KIND={sequence:'Follow-up sequence',stage:'Stage campaign',appointment:'Appointment reminders'};
const ANCH={sequence:'after the lead arrives',stage:'after the lead enters the stage',appointment:'before the appointment'};
function spl(m){m=+m||0;if(m&&m%1440===0)return[m/1440,1440];if(m&&m%60===0)return[m/60,60];return[m,1]}
function dur(m){const s=spl(m);const u=s[1]===1440?'day':s[1]===60?'hour':'minute';return s[0]+' '+u+(s[0]===1?'':'s')}
async function load(){try{const r=await fetch('/admin/automations/data');D=await r.json();draw()}catch(_){document.getElementById('ban').textContent='Could not load. Pull down to refresh.'}}
function draw(){const b=document.getElementById('ban');
  if(!D.twilio){b.className='ban warn';b.innerHTML='Texting is not connected yet. Add the Twilio keys in Cloudflare. Nothing below sends until then.'}
  else if(!D.auto){b.className='ban warn';b.innerHTML='Automatic sending is <b>OFF</b>. Add <b>TEXT_AUTO = 1</b> in Cloudflare to start. Nothing below sends until then.'}
  else{b.className='ban ok';b.innerHTML='Automatic sending is <b>ON</b>. Active automations are sending now.'}
  document.getElementById('list').innerHTML=D.automations.map(a=>'<div class="card" data-id="'+a.id+'"><div class="t"><b>'+$(a.name)+'</b><small><span class="pill">'+$(KIND[a.kind]||a.kind)+'</span>'+a.steps.length+' text'+(a.steps.length===1?'':'s')+(a.kind==='appointment'?'':' &middot; stops after '+(a.rules.max_days||8)+' days')+'</small></div><button class="btn" data-edit="'+a.id+'" type="button">Edit</button><label class="sw" title="On or off"><input type="checkbox" data-tg="'+a.id+'"'+(a.active?' checked':'')+'><i></i></label></div>').join('')||'<p class="note">No automations yet.</p>';
  const L=D.log||[];document.getElementById('log').innerHTML=L.length?'<tr><th>When</th><th>Automation</th><th>Lead</th><th>Result</th><th>Message</th></tr>'+L.map(x=>'<tr><td>'+new Date(x.at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+'</td><td>'+$(x.automation||'')+' #'+((x.pos||0)+1)+'</td><td><a href="/admin/pipeline#id='+x.lead_id+'" style="color:#7fb7ff">'+$(x.lead||'Lead')+'</a></td><td>'+$(x.status)+'</td><td>'+$(String(x.body||'').slice(0,90))+'</td></tr>').join(''):'<tr><td class="note">Nothing has been sent yet.</td></tr>'}
document.getElementById('list').addEventListener('click',e=>{const b=e.target.closest('[data-edit]');if(b)edit(D.automations.find(a=>a.id==b.dataset.edit))});
document.getElementById('list').addEventListener('change',async e=>{const t=e.target.closest('[data-tg]');if(!t)return;const a=D.automations.find(x=>x.id==t.dataset.tg);const r=await fetch('/admin/automation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:a.id,name:a.name,kind:a.kind,rules:a.rules,active:t.checked,steps:a.steps})});if(!r.ok){t.checked=!t.checked}else a.active=t.checked?1:0});
document.getElementById('newb').onclick=()=>edit({id:null,name:'',kind:'sequence',active:0,rules:{stages:['new','nocontact'],services:[],business_hours:true,stop_on_reply:true,max_days:8},steps:[{id:null,after_min:0,gap_min:0,body:'Hi {first}, this is {shop}. '}]});
function stepHtml(s,i,kind){const a=spl(s.after_min),g=spl(s.gap_min);const un=(v)=>[['minutes',1],['hours',60],['days',1440]].map(u=>'<option value="'+u[1]+'"'+(u[1]===v?' selected':'')+'>'+u[0]+'</option>').join('');
  return '<div class="stp" data-sid="'+(s.id||'')+'"><div class="sh"><b>Text #'+(i+1)+'</b><button type="button" class="btn r rm">Remove</button></div>'
   +'<div class="row">Send <input class="num v1" type="number" min="0" value="'+a[0]+'"><select class="un u1">'+un(a[1])+'</select> '+ANCH[kind]+'</div>'
   +(kind!=='appointment'&&i>0?'<div class="row">and at least <input class="num v2" type="number" min="0" value="'+g[0]+'"><select class="un u2">'+un(g[1])+'</select> after the previous text</div>':'')
   +'<textarea class="bd" rows="4" maxlength="600">'+$(s.body)+'</textarea><div class="chips">'+FIELDS.map(f=>'<button type="button" data-f="'+f+'">{'+f+'}</button>').join('')+'</div><div class="cnt"></div></div>'}
function sample(b){const v={first:'Alex',service:'window tint',service_name:'ceramic tint',vehicle:'your 2023 Tesla Model Y',pitch:'Our tint keeps your ride cooler, protected and more private, with a clean, factory look.',shop:'Divine Detailers',address:'5181 NW 74th Ave, Miami, FL 33166',appointment:'Tuesday, Nov 10 at 10:30 AM',review:'https://divinedetailers.com/review'};return String(b).replace(/\\{(\\w+)\\}/g,(m,k)=>v[k]===undefined?m:v[k]).replace(/[ \\t]+/g,' ').trim()}
let EA=null,lastTa=null;
function edit(a){EA=JSON.parse(JSON.stringify(a));const r=EA.rules||{};
  dlg.innerHTML='<div class="rb"><h3>'+(EA.id?'Edit automation':'New campaign')+'</h3>'
  +'<div><label>Name</label><input type="text" id="en" maxlength="80" value="'+$(EA.name)+'"></div>'
  +'<div><label>Type</label><select id="ek"'+(EA.id?' disabled':'')+'>'+Object.keys(KIND).map(k=>'<option value="'+k+'"'+(k===EA.kind?' selected':'')+'>'+KIND[k]+(k==='sequence'?' (starts when a lead arrives)':k==='stage'?' (starts when a lead enters a stage)':' (before a booked appointment)')+'</option>').join('')+'</select></div>'
  +'<div id="aud"></div>'
  +'<div><label>Rules</label><label class="chk"><input type="checkbox" id="ebh"'+(r.business_hours?' checked':'')+'> Only send Monday to Saturday, 9 AM to 6 PM</label><label class="chk" id="esrw"><input type="checkbox" id="esr"'+(r.stop_on_reply!==false?' checked':'')+'> Stop when the lead replies</label><p class="note" style="margin:6px 0 0">Always on: only leads who agreed to texts, nothing before 8 AM or after 9 PM, and STOP is respected.</p></div>'
  +'<div><label>Texts, in order</label><div id="steps" style="display:flex;flex-direction:column;gap:10px"></div><button type="button" class="btn" id="adds" style="margin-top:8px">+ Add a text</button></div>'
  +'<div><label>Preview of text #1</label><div class="prev" id="pv"></div></div>'
  +'<div class="err" id="er"></div><div class="acts">'+(EA.id?'<button type="button" class="btn r" id="del" style="margin-right:auto">Delete</button>':'')+'<button type="button" class="btn" id="cx">Cancel</button><button type="button" class="btn g" id="sv">Save</button></div></div>';
  audience();drawSteps();dlg.showModal();wire()}
function audience(){const k=document.getElementById('ek').value;EA.kind=k;const r=EA.rules||{};const aud=document.getElementById('aud');
  if(k==='appointment'){aud.innerHTML='<label>Who</label><p class="note" style="margin:0">Leads in <b>Booked</b> with an appointment time. Times below are before the appointment.</p>';document.getElementById('esrw').style.display='none';return}
  document.getElementById('esrw').style.display='';
  const sv=(r.services&&r.services[0])||'';
  aud.innerHTML='<label>'+(k==='stage'?'Starts when a lead enters':'Leads in these stages')+'</label><div class="row">'+D.stages.map(s=>'<label class="chk"><input type="checkbox" class="stg" value="'+s[0]+'"'+((r.stages||[]).includes(s[0])?' checked':'')+'> '+$(s[1])+'</label>').join('')+'</div>'
   +'<div class="row" style="margin-top:8px"><div style="flex:1;min-width:150px"><label>Service</label><select id="esv"><option value="">Any service</option><option value="tint"'+(sv==='tint'?' selected':'')+'>Tint only</option><option value="coat"'+(sv==='coat'?' selected':'')+'>Ceramic coating only</option></select></div><div style="flex:1;min-width:150px"><label>Stop after (days)</label><input type="number" id="emd" min="1" max="365" value="'+(r.max_days||8)+'"></div></div>'}
function drawSteps(){const c=document.getElementById('steps');const k=EA.kind;c.innerHTML=EA.steps.map((s,i)=>stepHtml(s,i,k)).join('');upd()}
function readSteps(){return [].map.call(document.querySelectorAll('#steps .stp'),(el,i)=>{const v1=+el.querySelector('.v1').value||0,u1=+el.querySelector('.u1').value;const v2=el.querySelector('.v2'),u2=el.querySelector('.u2');return{id:el.dataset.sid?+el.dataset.sid:null,after_min:v1*u1,gap_min:v2?(+v2.value||0)*(+u2.value):0,body:el.querySelector('.bd').value}})}
function upd(){document.querySelectorAll('#steps .stp').forEach(el=>{const t=el.querySelector('.bd').value,n=t.length;el.querySelector('.cnt').textContent=n+' characters'+(n>160?' (about '+Math.ceil(n/153)+' text segments)':'')});const f=document.querySelector('#steps .bd');document.getElementById('pv').textContent=f?sample(f.value):''}
function wire(){document.getElementById('ek').onchange=()=>{audience();EA.steps=readSteps();drawSteps()};
  document.getElementById('cx').onclick=()=>dlg.close();
  document.getElementById('adds').onclick=()=>{EA.steps=readSteps();if(EA.steps.length>=10)return;EA.steps.push({id:null,after_min:1440,gap_min:720,body:'Hi {first}, '});drawSteps()};
  dlg.addEventListener('click',e=>{const rm=e.target.closest('.rm');if(rm){EA.steps=readSteps();const i=[].indexOf.call(document.querySelectorAll('#steps .stp'),rm.closest('.stp'));EA.steps.splice(i,1);if(!EA.steps.length)EA.steps.push({id:null,after_min:0,gap_min:0,body:''});drawSteps();return}
    const ch=e.target.closest('[data-f]');if(ch){const ta=lastTa||document.querySelector('#steps .bd');if(!ta)return;const t='{'+ch.dataset.f+'}',s=ta.selectionStart==null?ta.value.length:ta.selectionStart;ta.value=ta.value.slice(0,s)+t+ta.value.slice(ta.selectionEnd==null?s:ta.selectionEnd);ta.focus();ta.selectionStart=ta.selectionEnd=s+t.length;upd()}});
  dlg.addEventListener('input',e=>{if(e.target.classList.contains('bd'))upd()});dlg.addEventListener('focusin',e=>{if(e.target.classList&&e.target.classList.contains('bd'))lastTa=e.target});
  const del=document.getElementById('del');if(del)del.onclick=async()=>{if(!confirm('Delete this automation? Its history of sent texts stays in each lead.'))return;await fetch('/admin/automation/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:EA.id})});dlg.close();load()};
  document.getElementById('sv').onclick=async()=>{const er=document.getElementById('er');er.textContent='';const k=document.getElementById('ek').value;
    const rules={business_hours:document.getElementById('ebh').checked,stop_on_reply:k==='appointment'?false:document.getElementById('esr').checked};
    if(k!=='appointment'){rules.stages=[].map.call(document.querySelectorAll('.stg:checked'),x=>x.value);const sv=document.getElementById('esv').value;rules.services=sv?[sv]:[];rules.max_days=+document.getElementById('emd').value||8}
    const body={id:EA.id,name:document.getElementById('en').value,kind:k,active:!!EA.active,rules:rules,steps:readSteps()};
    const r=await fetch('/admin/automation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.success){er.textContent=j.message||'Could not save.';return}dlg.close();load()}}
load();
const CSTAT={draft:'Draft',scheduled:'Scheduled',sending:'Sending',sent:'Sent',canceled:'Canceled'};
let CD=null,EC=null,confirmN=null;
async function loadC(){try{const r=await fetch('/admin/campaigns/data');CD=await r.json();drawC()}catch(_){}}
function fmtT(s){if(!s)return '';const d=new Date(String(s).replace(' ','T')+'Z');return d.toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' ET'}
function drawC(){const l=document.getElementById('clist');
  l.innerHTML=CD.campaigns.map(c=>'<div class="card" data-cid="'+c.id+'"><div class="t"><b>'+$(c.name)+'</b><small><span class="pill">'+$(CSTAT[c.status]||c.status)+'</span>'+(c.status==='scheduled'?fmtT(c.send_at):c.status==='sent'||c.status==='sending'?c.sent+' sent'+(c.failed?', '+c.failed+' failed':''):'')+'</small></div>'+(c.status==='draft'||c.status==='scheduled'?'<button class="btn" data-cedit="'+c.id+'" type="button">Edit</button>':'')+(c.status==='scheduled'||c.status==='sending'?'<button class="btn r" data-ccancel="'+c.id+'" type="button">Cancel</button>':'')+'</div>').join('')||'<p class="note">No campaigns yet.</p>'}
document.getElementById('clist').addEventListener('click',async e=>{const ed=e.target.closest('[data-cedit]');if(ed){editC(CD.campaigns.find(c=>c.id==ed.dataset.cedit));return}
  const cn=e.target.closest('[data-ccancel]');if(cn){if(!confirm('Cancel this campaign? Texts already sent stay sent.'))return;await fetch('/admin/campaign/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:+cn.dataset.ccancel})});loadC()}});
document.getElementById('cnew').onclick=()=>editC({id:null,name:'',body:'Hi {first}, ',audience:{stages:[],services:[],days:90},status:'draft'});
function editC(c){EC=JSON.parse(JSON.stringify(c));confirmN=null;const a=EC.audience||{},sv=(a.services&&a.services[0])||'';
  const cd=document.getElementById('cdlg');
  cd.innerHTML='<div class="rb"><h3>'+(EC.id?'Edit campaign':'New promotional campaign')+'</h3>'
  +'<div><label>Name</label><input type="text" id="cn" maxlength="80" value="'+$(EC.name)+'"></div>'
  +'<div><label>Message</label><textarea id="cb" rows="5" maxlength="600">'+$(EC.body)+'</textarea><div class="chips" style="margin-top:6px">'+FIELDS.filter(f=>f!=='appointment'&&f!=='review').map(f=>'<button type="button" data-cf="'+f+'">{'+f+'}</button>').join('')+'</div><div class="cnt" id="cc"></div><p class="note" style="margin:4px 0 0">&ldquo;Reply STOP to opt out.&rdquo; is added automatically if the message does not already say it.</p></div>'
  +'<div><label>Preview</label><div class="prev" id="cp"></div></div>'
  +'<div><label>Who gets it</label><div class="row">'+D.stages.map(s=>'<label class="chk"><input type="checkbox" class="cst" value="'+s[0]+'"'+((a.stages||[]).includes(s[0])?' checked':'')+'> '+$(s[1])+'</label>').join('')+'</div><p class="note" style="margin:4px 0 0">None ticked means every stage except Lost.</p></div>'
  +'<div class="row"><div style="flex:1;min-width:150px"><label>Service</label><select id="csv"><option value="">Any service</option><option value="tint"'+(sv==='tint'?' selected':'')+'>Tint</option><option value="coat"'+(sv==='coat'?' selected':'')+'>Ceramic coating</option></select></div><div style="flex:1;min-width:150px"><label>Lead came in</label><select id="cdy">'+[[0,'Any time'],[30,'Last 30 days'],[90,'Last 90 days'],[180,'Last 6 months'],[365,'Last year']].map(x=>'<option value="'+x[0]+'"'+((+a.days||0)===x[0]?' selected':'')+'>'+x[1]+'</option>').join('')+'</select></div></div>'
  +'<div class="row"><button type="button" class="btn" id="ccount">Count who will get it</button><span id="cres" class="note"></span></div>'
  +'<div><label>When</label><label class="chk"><input type="radio" name="cm" value="draft" checked> Save as a draft</label><label class="chk"><input type="radio" name="cm" value="now"> Send now (Monday to Saturday, 9 AM to 6 PM Eastern; otherwise it starts at the next opening)</label><label class="chk"><input type="radio" name="cm" value="schedule"> Schedule it</label><input type="datetime-local" id="cat" style="margin-top:6px;display:none"></div>'
  +'<div class="err" id="cer"></div><div class="acts"><button type="button" class="btn" id="ctest" style="margin-right:auto">Send a test to my phone</button><button type="button" class="btn" id="ccx">Cancel</button><button type="button" class="btn g" id="csave">Save</button></div></div>';
  cwire();cupd();cd.showModal()}
function caud(){const sv=document.getElementById('csv').value;return{stages:[].map.call(document.querySelectorAll('.cst:checked'),x=>x.value),services:sv?[sv]:[],days:+document.getElementById('cdy').value||0}}
function cupd(){const t=document.getElementById('cb').value,n=t.length;document.getElementById('cc').textContent=n+' characters'+(n>160?' (about '+Math.ceil(n/153)+' text segments)':'');let p=sample(t);if(!/stop/i.test(p))p+='\\n\\nReply STOP to opt out.';document.getElementById('cp').textContent=p}
function cwire(){const cd=document.getElementById('cdlg');
  document.getElementById('ccx').onclick=()=>cd.close();
  cd.addEventListener('click',e=>{const f=e.target.closest('[data-cf]');if(f){const ta=document.getElementById('cb'),t='{'+f.dataset.cf+'}',s=ta.selectionStart==null?ta.value.length:ta.selectionStart;ta.value=ta.value.slice(0,s)+t+ta.value.slice(ta.selectionEnd==null?s:ta.selectionEnd);ta.focus();ta.selectionStart=ta.selectionEnd=s+t.length;cupd()}});
  document.getElementById('cb').oninput=cupd;
  cd.querySelectorAll('input[name=cm]').forEach(r=>r.onchange=()=>{const m=cd.querySelector('input[name=cm]:checked').value;document.getElementById('cat').style.display=m==='schedule'?'':'none';document.getElementById('csave').textContent=m==='draft'?'Save':m==='now'?'Send now':'Schedule';confirmN=null});
  document.getElementById('ccount').onclick=async()=>{const el=document.getElementById('cres');el.textContent='Counting...';const r=await fetch('/admin/campaigns/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({audience:caud()})});const j=await r.json().catch(()=>({}));el.textContent=j.success?(j.count?j.count+' lead'+(j.count===1?'':'s')+' will get it (for example '+j.sample.join(', ')+').':'Nobody matches that group.'):'Could not count.'};
  document.getElementById('ctest').onclick=async()=>{const er=document.getElementById('cer');er.textContent='';const r=await fetch('/admin/campaign/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:document.getElementById('cb').value})});const j=await r.json().catch(()=>({}));er.style.color=j.success?'#9fe29f':'#ff8a8a';er.textContent=j.success?'Test sent to your phone.':(j.message||'Could not send the test.')};
  document.getElementById('csave').onclick=async()=>{const er=document.getElementById('cer');er.style.color='';er.textContent='';const m=cd.querySelector('input[name=cm]:checked').value;
    if(m!=='draft'&&confirmN===null){const r=await fetch('/admin/campaigns/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({audience:caud()})});const j=await r.json().catch(()=>({}));confirmN=j.count||0;if(!confirmN){er.textContent='Nobody matches that group.';confirmN=null;return}document.getElementById('csave').textContent='Confirm: text '+confirmN+' lead'+(confirmN===1?'':'s');er.textContent='Press again to confirm. This sends real texts.';return}
    const body={id:EC.id,name:document.getElementById('cn').value,body:document.getElementById('cb').value,audience:caud(),mode:m,send_at:document.getElementById('cat').value};
    const r=await fetch('/admin/campaign',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.success){er.textContent=j.message||'Could not save.';confirmN=null;return}cd.close();loadC()}}
loadC();
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}


// ---- Promotional campaigns (blasts): one-off texts to a chosen group. Every lead with a phone number is eligible (they have all agreed),
// only Monday to Saturday 9 AM to 6 PM Eastern, never to a number that replied STOP, and every one ends with the opt-out line.
async function campaignAudience(env, aud, limit = 5000) {
  const a = aud || {};
  const stages = (Array.isArray(a.stages) ? a.stages : []).filter(x => STAGE_KEYS.includes(x));
  const useStages = stages.length ? stages : STAGE_KEYS.filter(x => x !== "lost");
  const svc = (Array.isArray(a.services) ? a.services : []).map(x => String(x).toLowerCase().replace(/[%_]/g, "")).filter(Boolean).slice(0, 5);
  const days = Number(a.days) > 0 ? Math.min(3650, Math.floor(Number(a.days))) : 0;
  const rows = (await env.DB.prepare(`SELECT l.id, l.name, l.phone, l.service, l.year, l.make, l.model FROM leads l
      WHERE l.type != 'newsletter' AND COALESCE(l.ip,'') != 'demo' AND COALESCE(l.phone,'') != ''
        AND l.stage IN (${useStages.map(() => "?").join(",")})${days ? " AND l.created_at >= datetime('now', ?)" : ""}${svc.length ? " AND (" + svc.map(() => "LOWER(l.service) LIKE ?").join(" OR ") + ")" : ""}
      ORDER BY l.id LIMIT ${limit}`).bind(...useStages, ...(days ? [`-${days} days`] : []), ...svc.map(x => "%" + x + "%")).all()).results || [];
  const out = new Set(((await env.DB.prepare("SELECT phone FROM sms_optout").all()).results || []).map(x => x.phone));
  const seen = new Set();
  return rows.filter(r => { const d = last10(r.phone); if (d.length < 10 || out.has(d) || seen.has(d)) return false; seen.add(d); return true; });
}
const CAMPAIGN_TAIL = "Reply STOP to opt out.";
async function runCampaigns(env) {
  if (!env.DB || !autoMode(env) || !quietHoursOk(env)) return;
  if (env.AUTO_DIAL_ANYTIME !== "1" && !inBusinessHours()) return; // promotions only Monday to Saturday, 9 AM to 6 PM
  await ensureTable(env.DB);
  await env.DB.prepare("UPDATE campaigns SET status = 'sending' WHERE status = 'scheduled' AND send_at IS NOT NULL AND send_at <= datetime('now')").run();
  const c = await env.DB.prepare("SELECT * FROM campaigns WHERE status = 'sending' ORDER BY id LIMIT 1").first();
  if (!c) return;
  let aud = {}; try { aud = JSON.parse(c.audience || "{}"); } catch (e) { /* all */ }
  const people = await campaignAudience(env, aud);
  const done = new Set(((await env.DB.prepare("SELECT lead_id FROM campaign_sends WHERE campaign_id = ?").bind(c.id).all()).results || []).map(x => x.lead_id));
  const todo = people.filter(l => !done.has(l.id));
  let n = 0;
  for (const l of todo.slice(0, 20)) { // a steady trickle, well inside carrier throughput limits
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO campaign_sends (campaign_id, lead_id, status) VALUES (?,?,'sending')").bind(c.id, l.id).run();
    if (!claim.meta || !claim.meta.changes) continue;
    let body = renderAuto(c.body, l, env);
    if (/\{\w+\}/.test(body)) { await env.DB.prepare("UPDATE campaign_sends SET status = 'skipped: unknown merge field' WHERE campaign_id = ? AND lead_id = ?").bind(c.id, l.id).run(); continue; }
    if (!/stop/i.test(body)) body += "\n\n" + CAMPAIGN_TAIL;
    const res = await sendLeadText(env, l, body, { auto: true, label: "Campaign: " + c.name }).catch(e => ({ ok: false, message: String((e && e.message) || e) }));
    await env.DB.prepare("UPDATE campaign_sends SET status = ? WHERE campaign_id = ? AND lead_id = ?").bind(res.ok ? "sent" : "failed: " + String(res.message || "").slice(0, 80), c.id, l.id).run();
    n++;
  }
  if (todo.length <= n) await env.DB.prepare("UPDATE campaigns SET status = 'sent', finished_at = datetime('now') WHERE id = ?").bind(c.id).run();
}
async function campaignsData(env) {
  await ensureTable(env.DB);
  const rows = (await env.DB.prepare(`SELECT c.id, c.name, c.body, c.audience, c.status, c.send_at, c.created_at, c.finished_at,
      (SELECT COUNT(*) FROM campaign_sends s WHERE s.campaign_id = c.id AND s.status = 'sent') sent,
      (SELECT COUNT(*) FROM campaign_sends s WHERE s.campaign_id = c.id AND s.status LIKE 'failed%') failed
    FROM campaigns c ORDER BY c.id DESC LIMIT 50`).all()).results || [];
  const opted = ((await env.DB.prepare("SELECT COUNT(*) n FROM leads WHERE sms_marketing = 1 AND COALESCE(ip,'') != 'demo'").first()) || {}).n || 0;
  return json({ success: true, opted, testPhone: !!env.AGENT_PHONE_BRONSON, campaigns: rows.map(r => { let aud = {}; try { aud = JSON.parse(r.audience || "{}"); } catch (e) { /* */ } return { ...r, audience: aud }; }) });
}
async function markMetaPromo(env, b, user) {
  await ensureTable(env.DB);
  const where = "utm_medium = 'paid_social' AND type != 'newsletter' AND COALESCE(ip,'') != 'demo' AND COALESCE(phone,'') != '' AND sms_marketing = 0";
  const n = ((await env.DB.prepare(`SELECT COUNT(*) n FROM leads WHERE ${where}`).first()) || {}).n || 0;
  if (!b.confirm) return json({ success: true, count: n });
  if (!n) return json({ success: true, count: 0, done: true });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) SELECT id, stage, stage, ?, ? FROM leads WHERE ${where}`).bind("Promotional text consent recorded (Facebook lead form), marked by " + user, user),
    env.DB.prepare(`UPDATE leads SET sms_marketing = 1, sms_consent = 1 WHERE ${where}`),
  ]);
  return json({ success: true, count: n, done: true });
}
async function campaignPreview(env, b) {
  await ensureTable(env.DB);
  const people = await campaignAudience(env, b.audience);
  return json({ success: true, count: people.length, sample: people.slice(0, 3).map(x => x.name || prettyPhone(x.phone)) });
}
async function saveCampaign(env, b) {
  await ensureTable(env.DB);
  const name = clean(b.name, 80), body = String(b.body || "").trim();
  if (!name) return json({ success: false, message: "Give the campaign a name." }, 400);
  if (!body) return json({ success: false, message: "Write the message." }, 400);
  if (body.length > 600) return json({ success: false, message: "Keep the message under 600 characters." }, 400);
  const bad = (body.match(/\{(\w+)\}/g) || []).map(x => x.slice(1, -1)).find(k => !AUTO_FIELDS.includes(k));
  if (bad) return json({ success: false, message: `{${bad}} is not a merge field. Use: ${AUTO_FIELDS.map(x => "{" + x + "}").join(" ")}` }, 400);
  const au = b.audience || {};
  const audience = { stages: (Array.isArray(au.stages) ? au.stages : []).filter(x => STAGE_KEYS.includes(x)), services: (Array.isArray(au.services) ? au.services : []).map(x => clean(x, 40)).filter(Boolean).slice(0, 5), days: Math.max(0, Math.min(3650, Math.floor(Number(au.days)) || 0)) };
  let id = Number.isInteger(b.id) ? b.id : null, status = "draft", sendAt = null;
  if (id) { const cur = await env.DB.prepare("SELECT status FROM campaigns WHERE id = ?").bind(id).first(); if (!cur) id = null; else if (!["draft", "scheduled"].includes(cur.status)) return json({ success: false, message: "This campaign already started, so it can't be edited." }, 400); }
  if (b.mode === "now" || b.mode === "schedule") {
    if (!autoMode(env)) return json({ success: false, message: "Texting isn't switched on yet (Twilio keys and TEXT_AUTO), so a campaign can't be sent." }, 400);
    if (!(await campaignAudience(env, audience, 1)).length) return json({ success: false, message: "Nobody matches that group." }, 400);
    if (b.mode === "now") status = "sending";
    else { const at = etLocalToUtc(b.send_at); if (!at || at.getTime() < Date.now() - 60000) return json({ success: false, message: "Pick a date and time in the future." }, 400); status = "scheduled"; sendAt = sqlUtc(at); }
  }
  if (id) await env.DB.prepare("UPDATE campaigns SET name = ?, body = ?, audience = ?, status = ?, send_at = ? WHERE id = ?").bind(name, body, JSON.stringify(audience), status, sendAt, id).run();
  else { const ins = await env.DB.prepare("INSERT INTO campaigns (name, body, audience, status, send_at) VALUES (?,?,?,?,?)").bind(name, body, JSON.stringify(audience), status, sendAt).run(); id = ins.meta && ins.meta.last_row_id; }
  return json({ success: true, id, status });
}
// a test goes only to the owner's own phone (AGENT_PHONE_BRONSON), never to a lead
async function campaignTest(env, b) {
  if (!twilioOn(env)) return json({ success: false, message: "Texting isn't connected yet. Add the Twilio keys in Cloudflare." }, 400);
  if (!env.AGENT_PHONE_BRONSON) return json({ success: false, message: "Add AGENT_PHONE_BRONSON (your cell) in Cloudflare to receive test texts." }, 400);
  let body = renderAuto(String(b.body || ""), { name: "Alex Rivera", service: "Window Tint", year: "2023", make: "Tesla", model: "Model Y", appt_at: "" }, env);
  if (!body) return json({ success: false, message: "Write the message first." }, 400);
  if (/\{\w+\}/.test(body)) return json({ success: false, message: "The message has a merge field that doesn't exist." }, 400);
  if (!/stop/i.test(body)) body += "\n\n" + CAMPAIGN_TAIL;
  const form = new URLSearchParams({ To: e164(env.AGENT_PHONE_BRONSON), Body: "TEST: " + body });
  if (env.TWILIO_MESSAGING_SERVICE) form.set("MessagingServiceSid", env.TWILIO_MESSAGING_SERVICE); else form.set("From", env.TWILIO_FROM);
  try {
    const r = await fetch(`${env.TWILIO_API_BASE || "https://api.twilio.com"}/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, { method: "POST", headers: { authorization: "Basic " + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`), "content-type": "application/x-www-form-urlencoded" }, body: form.toString(), signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.sid ? json({ success: true }) : json({ success: false, message: String(j.message || "Twilio refused the test.").slice(0, 160) }, 502);
  } catch (e) { return json({ success: false, message: "Could not reach Twilio." }, 502); }
}

// ---- In-app dialer (owner login): calls are made from the browser with Twilio's Voice SDK, every call is recorded, and two voicemail messages can be dropped
const DIAL_DEFAULTS = {
  tint: `# OPENER
Hi {first}, this is Bronson with Divine Detailers in Miami. You asked about ceramic tint for {vehicle}. Did I catch you at an okay time?

# FIND OUT WHAT THEY WANT
- Is it just the side and rear windows, or the whole car?
- Any darkness in mind? Most people want the heat and glare gone but still want to see out at night.
- Is the heat, the privacy, or the look the main reason?
- When do they want it done, and can they drop the car off for the day?

# PRICE
Ceramic tint starts at {price} for {vehicle}. It cuts the heat and glare and protects the interior. (Confirm the final price and what the warranty covers for their car.)

# CLOSE
I have openings this week. What day works best for you? We are at {address}. I can lock you in right now.

# IF THEY HESITATE
- "Too expensive": cheaper film can bubble or fade and need redoing. Ask what they are comparing it to.
- "Need to think": totally fine. Which day would you pencil in so you do not lose the spot?
- "Shopping around": ask what quote they have and what film it is.`,
  coating: `# OPENER
Hi {first}, this is Bronson with Divine Detailers in Miami. You asked about a ceramic coating for {vehicle}. Did I catch you at an okay time?

# FIND OUT WHAT THEY WANT
- Is the car new or has it had paint work or swirls?
- Do they want gloss, protection, or easier washing?
- How do they usually wash it, and where is it parked?
- When do they want it done?

# PRICE
Our ceramic coating package starts at {price} for {vehicle}. It adds gloss, protects the paint, and makes washing easier. (Confirm the final price after seeing the car.)

# CLOSE
The car needs to be here for the day. What day works best? We are at {address}. I can get you on the schedule now.

# IF THEY HESITATE
- "Too expensive": a coating protects the paint and cuts down on waxing and detailing. Ask what they are comparing it to.
- "Need to think": no problem. Which day should I hold for you?
- "Is it worth it": ask what bothers them most about the paint, then match the answer to that.`,
  missed: "Hi {first}, this is Bronson with Divine Detailers. I just tried to call you about your {service} for {vehicle} and missed you. What's a good time to talk? Reply STOP to opt out.",
};
async function dialSetting(env, k) {
  const r = await env.DB.prepare("SELECT v FROM dial_settings WHERE k = ?").bind(k).first();
  return r && String(r.v).trim() ? r.v : DIAL_DEFAULTS[k];
}
const dialConfigured = env => ({ ok: !!(env.TWILIO_SID && env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET && env.TWILIO_TWIML_APP_SID && (env.TWILIO_VOICE_FROM || env.TWILIO_FROM)), missing: ["TWILIO_SID", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_TWIML_APP_SID"].filter(k => !env[k]).concat(env.TWILIO_VOICE_FROM || env.TWILIO_FROM ? [] : ["TWILIO_FROM"]) });
const jwtB64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function voiceToken(env, identity) {
  const enc = o => jwtB64(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" });
  const body = enc({ jti: `${env.TWILIO_API_KEY_SID}-${now}`, iss: env.TWILIO_API_KEY_SID, sub: env.TWILIO_SID, iat: now, exp: now + 3600, grants: { identity, voice: { incoming: { allow: false }, outgoing: { application_sid: env.TWILIO_TWIML_APP_SID } } } });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TWILIO_API_KEY_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(head + "." + body));
  return head + "." + body + "." + jwtB64(sig);
}
const xmlRes = body => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { "content-type": "text/xml" } });
const twAuth = env => ({ authorization: "Basic " + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`) });
// Twilio calls this when the browser starts a call: it checks the number belongs to a lead, then dials it with recording on
async function handleVoice(request, env) {
  if (!env.DB) return new Response("No database", { status: 503 });
  const params = Object.fromEntries(await request.formData().catch(() => new FormData()));
  if (!(await twilioSigOk(env, request, params))) return new Response("Forbidden", { status: 403 });
  await ensureTable(env.DB);
  const lead = Number.isInteger(Number(params.leadId)) ? await env.DB.prepare("SELECT id, phone FROM leads WHERE id = ?").bind(Number(params.leadId)).first() : null;
  if (!lead || !last10(lead.phone) || last10(lead.phone) !== last10(params.To)) return xmlRes("<Say>This call cannot be placed.</Say><Hangup/>");
  const from = e164(env.TWILIO_VOICE_FROM || env.TWILIO_FROM);
  if (!from) return xmlRes("<Say>No caller ID number is set up.</Say><Hangup/>");
  const base = env.PUBLIC_URL || "https://divinedetailers.com";
  const sid = /^CA[0-9a-f]{32}$/.test(String(params.CallSid || "")) ? params.CallSid : "";
  const who = String(params.From || params.Caller || "").replace(/^client:/, "").replace(/[^a-z0-9_.-]/gi, "").slice(0, 30);
  const stream = sid && coachEnabled(env) ? `<Start><Stream url="${base.replace(/^http/, "ws")}/api/twilio/stream/${sid}/${await coachSig(env, sid)}" track="both_tracks"><Parameter name="lead" value="${lead.id}"/></Stream></Start>` : "";
  return xmlRes(`${stream}<Dial callerId="${from}" answerOnBridge="true" timeout="40" record="record-from-answer-dual" recordingStatusCallback="${base}/api/twilio/voice/recording?lead=${lead.id}" recordingStatusCallbackEvent="completed"><Number statusCallback="${base}/api/twilio/voice/status?lead=${lead.id}&amp;p=${sid}&amp;f=${encodeURIComponent(from)}&amp;u=${encodeURIComponent(who)}" statusCallbackEvent="answered completed">${e164(lead.phone)}</Number></Dial>`);
}
// Twilio reports every dialer call here, so a call is logged even if the browser tab was closed or lost signal.
// Whichever side (Twilio or the browser) reports first creates the row and the "Called" log line; the other only fills in details.
async function recordDial(env, { lead, sid, user, from, tw, talk, browser }) {
  const mm = n => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
  let row = sid ? await env.DB.prepare("SELECT id FROM dial_calls WHERE call_sid = ?").bind(sid).first().catch(() => null) : null;
  const dur = Math.max(talk || 0, browser || 0);
  // the browser only learns the call id once the lead picks up, so a missed call arrives from the browser without one: pair it with Twilio's report of the same call
  if (!row) row = await env.DB.prepare(browser == null
    ? "SELECT id FROM dial_calls WHERE lead_id = ? AND logged = 1 AND (call_sid IS NULL OR call_sid = '') AND src = 'browser' AND started_at >= datetime('now','-4 minutes') ORDER BY id DESC LIMIT 1"
    : "SELECT id FROM dial_calls WHERE lead_id = ? AND logged = 1 AND src = 'twilio' AND (? = '' OR call_sid IS NULL OR call_sid <> ?) AND started_at >= datetime('now','-4 minutes') ORDER BY id DESC LIMIT 1").bind(...(browser == null ? [lead] : [lead, sid, sid])).first().catch(() => null);
  if (row) {
    await env.DB.prepare("UPDATE dial_calls SET logged = 2, call_sid = COALESCE(NULLIF(call_sid,''), NULLIF(?,'')), duration = MAX(duration, ?), by_user = COALESCE(NULLIF(by_user,''), ?), from_num = COALESCE(from_num, ?), tw_status = COALESCE(?, tw_status), talk = COALESCE(?, talk) WHERE id = ?").bind(sid, dur, user || null, from || null, tw || null, talk == null ? null : talk, row.id).run();
    return false;
  }
  const cur = await env.DB.prepare("SELECT stage FROM leads WHERE id = ?").bind(lead).first();
  if (!cur) return false;
  const r = await env.DB.prepare("INSERT INTO dial_calls (lead_id, call_sid, duration, by_user, from_num, tw_status, talk, src, logged) VALUES (?,?,?,?,?,?,?,?,1) ON CONFLICT(call_sid) WHERE call_sid IS NOT NULL AND call_sid <> '' DO NOTHING").bind(lead, sid || null, dur, user || null, from || null, tw || null, talk == null ? null : talk, browser == null ? "twilio" : "browser").run();
  if (!r.meta || !r.meta.changes) return false;
  await env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?,?,?,?,?)").bind(lead, cur.stage, cur.stage, dur ? `Called (in-app dialer): ${mm(dur)}` : "Called (in-app dialer): not connected", user || "system").run();
  return true;
}
async function handleVoiceStatus(request, env) {
  if (!env.DB) return new Response("No database", { status: 503 });
  const params = Object.fromEntries(await request.formData().catch(() => new FormData()));
  if (!(await twilioSigOk(env, request, params))) return new Response("Forbidden", { status: 403 });
  await ensureTable(env.DB);
  const u = new URL(request.url), lead = Number(u.searchParams.get("lead")), sid = String(u.searchParams.get("p") || "");
  if (!Number.isInteger(lead) || !/^CA[0-9a-f]{32}$/.test(sid)) return new Response(null, { status: 204 });
  const ev = String(params.CallStatus || "");
  if (!["completed", "no-answer", "busy", "failed", "canceled"].includes(ev)) return new Response(null, { status: 204 });
  const talk = Math.max(0, Math.min(14400, parseInt(params.CallDuration, 10) || 0));
  const user = /^[a-z0-9_.-]{1,30}$/i.test(u.searchParams.get("u") || "") ? u.searchParams.get("u") : "";
  await recordDial(env, { lead, sid, user, from: normNum(u.searchParams.get("f")) || null, tw: ev, talk });
  return new Response(null, { status: 204 });
}
async function handleVoiceRecording(request, env) {
  if (!env.DB) return new Response("No database", { status: 503 });
  const params = Object.fromEntries(await request.formData().catch(() => new FormData()));
  if (!(await twilioSigOk(env, request, params))) return new Response("Forbidden", { status: 403 });
  await ensureTable(env.DB);
  const lead = Number(new URL(request.url).searchParams.get("lead")), sid = String(params.RecordingSid || "");
  if (Number.isInteger(lead) && /^RE[0-9a-f]{32}$/.test(sid)) await saveRecording(env, { callId: "tw:" + sid, leadId: lead, direction: "outbound", url: "/admin/rec/" + sid, duration: params.RecordingDuration });
  return new Response(null, { status: 204 });
}
// recordings stay private in Twilio: the CRM streams them to a signed-in owner
async function recordingProxy(env, sid, request) {
  if (!/^RE[0-9a-f]{32}$/.test(sid) || !env.TWILIO_SID) return new Response("Not found", { status: 404 });
  const h = { ...twAuth(env) }; const range = request.headers.get("range"); if (range) h.range = range;
  const r = await fetch(`${env.TWILIO_API_BASE || "https://api.twilio.com"}/2010-04-01/Accounts/${env.TWILIO_SID}/Recordings/${sid}.mp3`, { headers: h });
  if (!r.ok && r.status !== 206) return new Response("Recording not available", { status: r.status });
  const out = { "content-type": "audio/mpeg", "accept-ranges": "bytes", "cache-control": "private, max-age=3600" };
  for (const k of ["content-range", "content-length"]) if (r.headers.get(k)) out[k] = r.headers.get(k);
  return new Response(r.body, { status: r.status, headers: out });
}
// the next days the shop can take a job, read from the CRM calendar (booked leads plus Urable jobs), counted per service:
// COATING_DAILY_CAP (default 2) ceramic coatings and TINT_DAILY_CAP (default 4) tint jobs per day. CLOSED_DAYS (default Sun) are skipped.
const jobKind = t => /coat|ceramic/i.test(t || "") ? "coating" : /tint/i.test(t || "") ? "tint" : "other";
async function openDays(env, n = 6, svc = "tint") {
  try {
    const cap = svc === "coating" ? (Number(env.COATING_DAILY_CAP) || 2) : (Number(env.TINT_DAILY_CAP) || 4);
    const closed = String(env.CLOSED_DAYS || "Sun").toLowerCase().split(/[\s,]+/).filter(Boolean).map(x => x.slice(0, 3));
    const base = todayStr(), cnt = {};
    const leads = (await env.DB.prepare("SELECT appt_at, urable_ref, service FROM leads WHERE COALESCE(appt_at,'') != '' AND stage NOT IN ('lost') AND appt_at >= ?").bind(base).all().catch(() => ({ results: [] }))).results || [];
    const refs = new Set(leads.map(l => l.urable_ref).filter(Boolean));
    const add = (d, text) => { if (jobKind(text) === svc) cnt[d] = (cnt[d] || 0) + 1; };
    for (const l of leads) add(String(l.appt_at).slice(0, 10), l.service);
    const cal = await urableCalendar(env).catch(() => ({ items: [] }));
    for (const it of cal.items || []) { if (!it.appt_at || refs.has(it.ref)) continue; const d = String(it.appt_at).slice(0, 10); if (d >= base) add(d, (it.service || "") + " " + (it.name || "")); }
    const out = [], ord = d => d + (d % 100 >= 11 && d % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][d % 10] || "th");
    for (let i = 1; i <= 45 && out.length < n; i++) {
      const t = new Date(base + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + i);
      const wd = t.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }), key = t.toISOString().slice(0, 10);
      if (closed.includes(wd.slice(0, 3).toLowerCase())) continue;
      const used = cnt[key] || 0; if (used >= cap) continue;
      out.push({ date: key, say: `${wd} the ${ord(t.getUTCDate())}`, left: cap - used });
    }
    return out;
  } catch (_) { return []; }
}
const DIAL_STAGES = ["nocontact", "contacted", "quoted", "aged", "interested", "deposit", "lost"];
async function dialerQueue(env, url) {
  await ensureTable(env.DB);
  // ?stages=aged,contacted dials everyone in those pipeline stages (any age), least recently tried first. Without it: new leads and follow-ups that are due.
  const want = String((url && url.searchParams.get("stages")) || "").split(",").filter(x => DIAL_STAGES.includes(x));
  const counts = {};
  for (const r of (await env.DB.prepare("SELECT stage, COUNT(*) n FROM leads WHERE type != 'newsletter' AND COALESCE(ip,'') != 'demo' AND COALESCE(phone,'') != '' GROUP BY stage").all().catch(() => ({ results: [] }))).results || []) counts[r.stage] = r.n;
  const where = want.length
    ? `l.stage IN (${want.map(() => "?").join(",")})`
    : `((l.stage IN ('new','nocontact') AND l.created_at >= datetime('now','-14 days')) OR (l.follow_up_date IS NOT NULL AND l.follow_up_date != '' AND l.follow_up_date <= date('now') AND l.stage NOT IN ('done','lost','aged')))`;
  const order = want.length ? "(tries3 > 0), (last_try IS NOT NULL), last_try ASC, l.created_at DESC LIMIT 120" : "cb DESC, (tries3 > 0), l.created_at DESC LIMIT 60";
  const sel = (w, o) => `SELECT l.id, l.name, l.phone, l.email, l.service, l.year, l.make, l.model, l.message, l.created_at, l.stage, l.value, l.follow_up_date, l.utm_medium,
      (SELECT COUNT(*) FROM dial_calls d WHERE d.lead_id = l.id AND d.started_at >= datetime('now','-1 day')) tries24,
      (SELECT COUNT(*) FROM dial_calls d WHERE d.lead_id = l.id AND d.started_at >= datetime('now','-3 hours')) tries3,
      (SELECT MAX(d.started_at) FROM dial_calls d WHERE d.lead_id = l.id) last_try,
      CASE WHEN l.follow_up_date IS NOT NULL AND l.follow_up_date != '' AND l.follow_up_date <= date('now') AND l.stage NOT IN ('new','nocontact') THEN 1 ELSE 0 END cb
    FROM leads l WHERE l.type != 'newsletter' AND COALESCE(l.ip,'') != 'demo' AND COALESCE(l.phone,'') != ''
      AND ${w}
    ORDER BY ${o}`;
  let rows = (await env.DB.prepare(sel(where, order)).bind(...want).all()).results || [];
  // ?lead=ID puts one lead (clicked from the pipeline) first, whatever its stage
  const one = Number(url && url.searchParams.get("lead"));
  if (Number.isInteger(one) && one > 0) { const r1 = (await env.DB.prepare(sel("l.id = ?", "l.id")).bind(one).all().catch(() => ({ results: [] }))).results || []; if (r1.length) rows = r1.concat(rows.filter(r => r.id !== one)); }
  const ids = rows.map(r => r.id);
  const notes = ids.length ? (await env.DB.prepare(`SELECT lead_id, reason, at FROM stage_log WHERE lead_id IN (${ids.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 400`).bind(...ids).all()).results || [] : [];
  const texts = ids.length ? (await env.DB.prepare(`SELECT lead_id, direction, body, at FROM messages WHERE lead_id IN (${ids.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 300`).bind(...ids).all()).results || [] : [];
  return json({ success: true, counts, open: { tint: await openDays(env, 6, "tint"), coating: await openDays(env, 6, "coating") }, leads: rows.map(r => ({ ...r, created_at: isoUtc(r.created_at), last_try: r.last_try ? isoUtc(r.last_try) : null, history: notes.filter(n => n.lead_id === r.id).slice(0, 4).map(n => ({ reason: n.reason, at: isoUtc(n.at) })), texts: texts.filter(t => t.lead_id === r.id).slice(0, 3).map(t => ({ direction: t.direction, body: String(t.body).slice(0, 200), at: isoUtc(t.at) })) })) });
}
async function dialerLead(env, id) {
  await ensureTable(env.DB);
  if (!Number.isInteger(id)) return json({ success: false }, 400);
  const lead = await env.DB.prepare("SELECT id, created_at, name, email, phone, service, also_interested, year, make, model, message, page, utm_source, utm_medium, utm_campaign, stage, value, notes, appt_at, follow_up_date, call_id, duration, recording, answered FROM leads WHERE id = ?").bind(id).first();
  if (!lead) return json({ success: false }, 404);
  const q = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all().catch(() => ({ results: [] }))).results || [];
  const [dials, recs, cnotes, trs, msgs, log] = await Promise.all([
    q("SELECT call_sid, started_at, duration, by_user FROM dial_calls WHERE lead_id = ? ORDER BY id DESC LIMIT 40", id),
    q("SELECT call_id, url, duration, at FROM call_recordings WHERE lead_id = ? ORDER BY at DESC LIMIT 60", id),
    q("SELECT call_id, direction, created_at, summary FROM call_notes WHERE lead_id = ? ORDER BY created_at DESC LIMIT 20", id),
    q("SELECT call_sid, turns FROM call_transcripts WHERE lead_id = ? ORDER BY started_at DESC LIMIT 10", id),
    q("SELECT direction, body, status, auto, by_user, at FROM messages WHERE lead_id = ? ORDER BY id DESC LIMIT 120", id),
    q("SELECT from_stage, to_stage, reason, by_user, at FROM stage_log WHERE lead_id = ? ORDER BY id DESC LIMIT 120", id),
  ]);
  const ms = t => Date.parse(isoUtc(t));
  const used = new Set(), calls = [];
  for (const d of dials) {
    const t0 = ms(d.started_at), r = recs.find(x => !used.has(x.call_id) && ms(x.at) >= t0 - 60000 && ms(x.at) <= t0 + ((d.duration || 0) + 1200) * 1000);
    if (r) used.add(r.call_id);
    const tr = trs.find(x => x.call_sid && x.call_sid === d.call_sid);
    let turns = []; try { turns = tr ? JSON.parse(tr.turns || "[]").slice(0, 300) : []; } catch (_) {}
    calls.push({ kind: "dialer", at: isoUtc(d.started_at), secs: d.duration || 0, by: d.by_user, rec: r ? r.url : "", turns });
  }
  for (const r of recs) if (!used.has(r.call_id) && !calls.some(c => c.rec === r.url)) calls.push({ kind: "recording", at: isoUtc(r.at), secs: r.duration || 0, by: "", rec: r.url, turns: [] });
  for (const n of cnotes) calls.push({ kind: "callrail", at: isoUtc(n.created_at), direction: n.direction || "", summary: n.summary || "", rec: n.call_id && lead.call_id === n.call_id ? (lead.recording || "") : "", secs: n.call_id && lead.call_id === n.call_id ? (lead.duration || 0) : 0, turns: [] });
  calls.sort((a, b) => b.at.localeCompare(a.at));
  const notes = log.filter(x => /^(Call )?note: /i.test(x.reason || "")).map(x => ({ text: String(x.reason).replace(/^(Call )?note: /i, ""), by: x.by_user, at: isoUtc(x.at) }));
  const activity = log.filter(x => !/^(Call )?note: /i.test(x.reason || "")).slice(0, 60).map(x => ({ reason: x.reason, from: x.from_stage, to: x.to_stage, by: x.by_user, at: isoUtc(x.at) }));
  const first = dials.length ? dials[dials.length - 1] : null;
  const facts = {
    attempts: dials.length, talkSecs: dials.reduce((a, d) => a + (d.duration || 0), 0), connected: dials.filter(d => (d.duration || 0) > 0).length,
    lastTry: dials.length ? isoUtc(dials[0].started_at) : "", firstContactMins: first ? Math.max(0, Math.round((ms(first.started_at) - ms(lead.created_at)) / 60000)) : null,
    textsIn: msgs.filter(m => m.direction === "in").length, textsOut: msgs.filter(m => m.direction !== "in").length, optout: await isOptedOut(env, lead.phone).catch(() => false),
  };
  return json({ success: true, lead: { ...lead, created_at: isoUtc(lead.created_at) }, facts, calls, texts: msgs.reverse().map(m => ({ ...m, at: isoUtc(m.at) })), notes, activity });
}
const SCRIPT_SVCS = ["tint", "coating"];
// the guided call scripts are private: owner only, stored in the database, never part of the website or this code
async function dialerScriptGet(env, svc) {
  await ensureTable(env.DB);
  if (!SCRIPT_SVCS.includes(svc)) return json({ success: false }, 400);
  const r = await env.DB.prepare("SELECT v FROM dial_settings WHERE k = ?").bind("script_" + svc).first();
  let script = null; try { script = r && r.v ? JSON.parse(r.v) : null; } catch (_) {}
  return json({ success: true, script });
}
async function dialerScriptSave(env, b) {
  await ensureTable(env.DB);
  if (!SCRIPT_SVCS.includes(b.svc)) return json({ success: false, message: "Unknown script." }, 400);
  const s = b.script, txt = JSON.stringify(s || null);
  if (!s || typeof s !== "object" || s.v !== 1 || !Array.isArray(s.steps) || !s.steps.length || s.steps.length > 120 || !Array.isArray(s.plays) || !Array.isArray(s.phases) || txt.length > 400000) return json({ success: false, message: "That is not a script file this dialer understands." }, 400);
  await env.DB.prepare("INSERT INTO dial_settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind("script_" + b.svc, txt).run();
  return json({ success: true });
}
// ---- Call library: the best real answers from analyzed past calls. The AI coach looks up the closest ones for what the lead just said. Owner only.
const libMask = t => String(t || "").replace(/jack.?s auto customs|jax auto customs/gi, "{shop}").replace(/\$\s?\d[\d,.]*/g, "{amount}").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "{email}").replace(/(?<!\w)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\w)/g, "{phone}").slice(0, 600);
// answers that name another shop, a place, a promotion, a film brand or a price are dropped, so the coach never repeats facts that are not ours
const LIB_BLOCK = /jack|jacksonville|beltway|amco|walgreens|o.?reilly|hitek|hypex|llumar|ethos|halloween|georgia|unit \d+|\{shop\}|\$|\bbucks\b|\bdollars?\b|\b(?:two|three|four|five|six|seven|eight|nine)\s+(?:hundred|ninety|eighty|seventy|sixty|fifty|forty|thirty|twenty)\b|\b(?:ninety|eighty|seventy|sixty|fifty|forty|thirty|twenty)[ -](?:one|two|three|four|five|six|seven|eight|nine)\b/i;
// topics where the answer is a shop fact (place, duration, film, warranty, legal limits, heat numbers): those come from SHOP FACTS, not from other people's calls
const LIB_FACT_TOPICS = new Set(["location", "how_long", "brand_or_film", "warranty", "legal_tint", "heat_uv_privacy", "hours"]);
const libSvc = x => { const v = String(x || ""); return /tint/i.test(v) ? "tint" : /coat|ceramic|correct|polish|detail/i.test(v) ? "coating" : "other"; };
async function dialerLibrary(env, b) {
  await ensureTable(env.DB);
  if (b && b.clear) { await env.DB.prepare("DELETE FROM call_library").run(); return json({ success: true, count: 0 }); }
  if (b && Array.isArray(b.rows)) {
    if (b.replace) await env.DB.prepare("DELETE FROM call_library").run();
    const rows = b.rows.slice(0, 300).map(r => ({ src: String(r.id || "").slice(0, 40), svc: libSvc(r.service), topic: String(r.topic || "").slice(0, 40), objection: String(r.objection || "").slice(0, 40), kind: String(r.customer_type || r.kind || "").slice(0, 20),
      stage: String(r.stage || r.phase || "").slice(0, 20), lead: libMask(r.lead_said_masked || r.lead_said), rep: libMask(r.rep_response_masked || r.rep_response), better: libMask(r.better_answer), quality: Number(r.quality) || 0, priority: Number(r.priority) || 0, won: r.won ? 1 : 0, reaction: String(r.reaction || "").slice(0, 10) }))
      .map(r => ({ ...r, better: LIB_BLOCK.test(r.better) ? "" : r.better }))
      .filter(r => r.lead.split(/\s+/).length >= 3 && r.rep.split(/\s+/).length >= 6 && !LIB_BLOCK.test(r.lead) && !LIB_BLOCK.test(r.rep) && !LIB_FACT_TOPICS.has(r.topic));
    for (let i = 0; i < rows.length; i += 40) await env.DB.batch(rows.slice(i, i + 40).map(r => env.DB.prepare("INSERT INTO call_library (src, svc, topic, objection, kind, stage, lead_said, rep_response, better, quality, priority, won, reaction) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(r.src, r.svc, r.topic, r.objection, r.kind, r.stage, r.lead, r.rep, r.better, r.quality, r.priority, r.won, r.reaction)));
    return json({ success: true, added: rows.length, skipped: b.rows.length - rows.length });
  }
  const t = await env.DB.prepare("SELECT svc, COUNT(*) n, SUM(won) w FROM call_library GROUP BY svc").all().then(r => r.results || []).catch(() => []);
  return json({ success: true, count: t.reduce((a, x) => a + x.n, 0), byService: t });
}
const libTok = s => [...new Set(String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 3 && !["that", "this", "with", "have", "what", "your", "about", "just", "they", "them", "there", "would", "could", "from", "like", "know", "were", "been", "then", "yeah"].includes(w)))];
function libPick(lib, said, k = 3) {
  const a = libTok(said); if (!a.length || !lib || !lib.length) return [];
  const sa = new Set(a), seen = new Set(), out = [];
  const scored = lib.map(r => { const b = r.tok || (r.tok = libTok(r.lead_said)); if (!b.length) return null; const hit = b.filter(w => sa.has(w)).length, ov = hit / Math.sqrt(a.length * b.length); return ov >= 0.25 ? { r, s: ov * (0.6 + 0.08 * (r.priority || 0)) } : null; }).filter(Boolean).sort((x, y) => y.s - x.s);
  for (const { r } of scored) { const key = r.rep_response.slice(0, 50); if (seen.has(key)) continue; seen.add(key); out.push(r); if (out.length >= k) break; }
  return out;
}
const OFFER_KEYS = ["rep", "shop", "address", "area", "special", "specialEnd", "tintPrice", "tintDeposit", "tintFloor", "coatPrice", "coatReg", "coatDeposit", "coatYears", "tintSkip", "coatSkip"];
async function dialerOfferGet(env) {
  await ensureTable(env.DB);
  const r = await env.DB.prepare("SELECT v FROM dial_settings WHERE k = 'offer'").first();
  let offer = {}; try { offer = r && r.v ? JSON.parse(r.v) : {}; } catch (_) {}
  return json({ success: true, offer, knowledge_default: KNOWLEDGE_DEFAULT });
}
async function dialerOfferSave(env, b) {
  await ensureTable(env.DB);
  const o = b.offer && typeof b.offer === "object" ? b.offer : null;
  if (!o) return json({ success: false }, 400);
  const out = {};
  for (const k of OFFER_KEYS) out[k] = String(o[k] == null ? "" : o[k]).trim().slice(0, 200);
  out.swaps = (Array.isArray(o.swaps) ? o.swaps : []).slice(0, 40).map(x => ({ f: String((x && x.f) || "").slice(0, 200), t: String((x && x.t) || "").slice(0, 400) })).filter(x => x.f);
  out.knowledge = String(o.knowledge || "").trim().slice(0, 12000);
  out.fixes = (Array.isArray(o.fixes) ? o.fixes : []).slice(0, 80).map(x => ({ f: String((x && x.f) || "").slice(0, 80), t: String((x && x.t) || "").slice(0, 80) })).filter(x => x.f);
  out.terms = (Array.isArray(o.terms) ? o.terms : []).slice(0, 30).map(x => String(x || "").trim().slice(0, 40)).filter(Boolean);
  await env.DB.prepare("INSERT INTO dial_settings (k, v) VALUES ('offer', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(out)).run();
  return json({ success: true });
}
// Every note written anywhere in the CRM goes through here: it is added to the lead's Notes (leads.notes, stamped with the time and who wrote it) and logged on the timeline
async function addLeadNote(env, id, text, user) {
  await ensureTable(env.DB);
  text = String(text || "").trim().slice(0, 1000);
  if (!Number.isInteger(id) || !text) return { ok: false, status: 400, message: "Write a note first." };
  const cur = await env.DB.prepare("SELECT stage, notes FROM leads WHERE id = ?").bind(id).first();
  if (!cur) return { ok: false, status: 404 };
  const stamp = new Date().toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  let notes = (cur.notes ? String(cur.notes).replace(/\s+$/, "") + "\n" : "") + `${stamp} \u00b7 ${user || "someone"}: ${text}`;
  if (notes.length > 6000) notes = notes.slice(notes.length - 6000).replace(/^[^\n]*\n/, "");
  await env.DB.batch([
    env.DB.prepare("UPDATE leads SET notes = ? WHERE id = ?").bind(notes, id),
    env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?,?,?,?,?)").bind(id, cur.stage, cur.stage, "Note: " + text, user),
  ]);
  return { ok: true, notes };
}
async function dialerNote(env, b, user) {
  const r = await addLeadNote(env, b.id, b.text, user);
  return r.ok ? json({ success: true, notes: r.notes }) : json({ success: false, message: r.message || "Could not save the note." }, r.status || 400);
}
// older dialer notes only lived on the timeline: copy them into the lead's Notes once so every screen shows the same notes
async function backfillNotes(env) {
  if (await env.DB.prepare("SELECT 1 FROM dial_settings WHERE k = 'notes_backfill'").first().catch(() => null)) return;
  const rows = (await env.DB.prepare("SELECT s.lead_id, s.reason, s.by_user, s.at, l.notes FROM stage_log s JOIN leads l ON l.id = s.lead_id WHERE s.reason LIKE 'Note: %' OR s.reason LIKE 'Call note: %' ORDER BY s.lead_id, s.at LIMIT 5000").all()).results || [];
  const by = new Map();
  for (const r of rows) { if (!by.has(r.lead_id)) by.set(r.lead_id, { notes: String(r.notes || ""), add: [] }); const g = by.get(r.lead_id), t = String(r.reason).replace(/^(Call )?note: /i, "").trim(); if (!t || g.notes.includes(t)) continue; const when = new Date(String(r.at).replace(" ", "T") + "Z").toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); g.add.push(`${when} \u00b7 ${r.by_user || "someone"}: ${t}`); }
  const stmts = [];
  for (const [id, g] of by) if (g.add.length) stmts.push(env.DB.prepare("UPDATE leads SET notes = ? WHERE id = ?").bind(((g.notes ? g.notes.replace(/\s+$/, "") + "\n" : "") + g.add.join("\n")).slice(-6000), id));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await env.DB.prepare("INSERT OR IGNORE INTO dial_settings (k, v) VALUES ('notes_backfill', '1')").run();
}
async function dialerLog(env, b, user) {
  await ensureTable(env.DB);
  if (!Number.isInteger(b.lead_id)) return json({ success: false }, 400);
  const cur = await env.DB.prepare("SELECT stage FROM leads WHERE id = ?").bind(b.lead_id).first();
  if (!cur) return json({ success: false }, 404);
  const dur = Math.max(0, Math.min(14400, Math.floor(Number(b.duration)) || 0));
  const mmss = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}`;
  const sid = /^CA[0-9a-f]{32}$/.test(String(b.sid || "")) ? b.sid : "";
  await recordDial(env, { lead: b.lead_id, sid, user, from: normNum(env.TWILIO_VOICE_FROM || env.TWILIO_FROM) || null, browser: dur });
  // the result picked after the call decides what happened (a voicemail greeting can run a minute or more), so only a call of 3+ minutes counts as contact on its own
  if (dur > Math.max(contactMinSecs(env), 180) && isNewish(cur.stage)) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?,?,?,?,?)").bind(b.lead_id, cur.stage, "contacted", `Call longer than ${Math.max(contactMinSecs(env), 180)} seconds (${mmss})`, "system"),
      env.DB.prepare("UPDATE leads SET stage = 'contacted', contacted = 1, stage_changed_at = datetime('now') WHERE id = ?").bind(b.lead_id),
    ]);
  }
  return json({ success: true });
}
const VM_KINDS = ["tint", "coating"];
async function dialerAudioSave(env, b) {
  await ensureTable(env.DB);
  if (!VM_KINDS.includes(b.kind)) return json({ success: false, message: "Unknown voicemail." }, 400);
  const mime = /^audio\/(wav|x-wav|mpeg|mp3)$/.test(String(b.mime)) ? String(b.mime).replace("mp3", "mpeg") : "";
  const data = String(b.data || "");
  if (!mime || !/^[A-Za-z0-9+/=]+$/.test(data)) return json({ success: false, message: "Use a WAV or MP3 recording." }, 400);
  if (data.length > 1300000) return json({ success: false, message: "That recording is too long. Keep it under about 40 seconds." }, 413);
  const token = [...crypto.getRandomValues(new Uint8Array(12))].map(x => x.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("INSERT INTO dial_audio (kind, mime, data, token, updated_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(kind) DO UPDATE SET mime = excluded.mime, data = excluded.data, token = excluded.token, updated_at = excluded.updated_at").bind(b.kind, mime, data, token).run();
  return json({ success: true });
}
const audioBytes = row => Uint8Array.from(atob(row.data), c => c.charCodeAt(0));
async function dialerAudioPlay(env, kind) {
  await ensureTable(env.DB);
  const row = VM_KINDS.includes(kind) ? await env.DB.prepare("SELECT mime, data FROM dial_audio WHERE kind = ?").bind(kind).first() : null;
  return row ? new Response(audioBytes(row), { headers: { "content-type": row.mime, "cache-control": "no-store" } }) : new Response("Not found", { status: 404 });
}
// Twilio fetches the voicemail from this unguessable address while the message plays on the call
async function publicVoicemail(env, token) {
  if (!/^[0-9a-f]{24}$/.test(token) || !env.DB) return new Response("Not found", { status: 404 });
  await ensureTable(env.DB);
  const row = await env.DB.prepare("SELECT mime, data FROM dial_audio WHERE token = ?").bind(token).first();
  return row ? new Response(audioBytes(row), { headers: { "content-type": row.mime, "cache-control": "public, max-age=300" } }) : new Response("Not found", { status: 404 });
}
// plays the saved message to whoever is on the line, then hangs up: the lead's call leg is told to play it instead of staying connected
async function dialerVoicemailDrop(env, b, user) {
  await ensureTable(env.DB);
  if (!VM_KINDS.includes(b.kind) || !/^CA[0-9a-f]{32}$/.test(String(b.sid || "")) || !Number.isInteger(b.lead_id)) return json({ success: false, message: "Bad request." }, 400);
  const row = await env.DB.prepare("SELECT token FROM dial_audio WHERE kind = ?").bind(b.kind).first();
  if (!row) return json({ success: false, message: "Record that voicemail first." }, 400);
  const base = `${env.TWILIO_API_BASE || "https://api.twilio.com"}/2010-04-01/Accounts/${env.TWILIO_SID}`;
  try {
    const list = await (await fetch(`${base}/Calls.json?ParentCallSid=${b.sid}&PageSize=5`, { headers: twAuth(env) })).json();
    const child = (list.calls || []).find(c => ["in-progress", "ringing", "queued"].includes(c.status)) || (list.calls || [])[0];
    if (!child) return json({ success: false, message: "The call is not connected to the lead yet." }, 409);
    const play = `${env.PUBLIC_URL || "https://divinedetailers.com"}/vm/${row.token}`;
    const r = await fetch(`${base}/Calls/${child.sid}.json`, { method: "POST", headers: { ...twAuth(env), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ Twiml: `<Response><Pause length="1"/><Play>${play}</Play><Hangup/></Response>` }).toString() });
    if (!r.ok) return json({ success: false, message: "Twilio could not play the voicemail." }, 502);
  } catch (e) { return json({ success: false, message: "Could not reach Twilio." }, 502); }
  await env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) SELECT id, stage, stage, ?, ? FROM leads WHERE id = ?").bind(`Left a voicemail (${b.kind} message dropped)`, user, b.lead_id).run().catch(() => {});
  return json({ success: true });
}

async function dialerPage(env, user) {
  await ensureTable(env.DB);
  const tc = await todayCount(env);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">${PWA_HEAD}<title>Dial | Divine Detailers</title>
<style>
*{box-sizing:border-box}[hidden]{display:none!important}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#07090c;color:#e8eaed}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px;flex-wrap:wrap}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}.navtabs a.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
main{max-width:1100px;margin:0 auto;padding:16px 22px 40px;display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:18px;align-items:start}
.col{display:flex;flex-direction:column;gap:14px;min-width:0}
.ban{border-radius:12px;padding:12px 14px;font-size:14px;border:1px solid #4d3a1d;background:#10151b;color:#ffb86b}.ban code{background:#1a2027;padding:1px 6px;border-radius:6px;color:#e8eaed}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.pill{display:inline-block;font-size:12px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;border-radius:999px;padding:4px 12px;background:#1a2027;color:#aab0b9}.pill.ok{background:#10301a;color:#7fe07f}.pill.warn{background:#2a2410;color:#ffd166}.pill.bad{background:#3a1414;color:#ff8a8a}
.btn{border:1px solid #2a313a;background:#151a21;color:#e8eaed;border-radius:12px;padding:10px 14px;font:inherit;font-weight:700;cursor:pointer;min-height:46px}.btn.g{background:#32cd32;border-color:#32cd32;color:#04120a}.btn.r{background:#d83a3a;border-color:#d83a3a;color:#fff}.btn:disabled{opacity:.4;cursor:default}.btn.sm{min-height:38px;padding:6px 12px;font-size:13.5px}.btn.on{background:#e8eaed;color:#07090c}
.lead{background:#0d1116;border:1px solid #1d2229;border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:10px}.lead h2{margin:0;font-size:24px;overflow-wrap:anywhere}.lead .ph{font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;color:#32cd32}
.chips{display:flex;gap:6px;flex-wrap:wrap}.chip{background:#1a2027;border-radius:999px;padding:3px 11px;font-size:13px;color:#cfd3d9}.chip.hot{background:#10301a;color:#7fe07f}
.kv{display:flex;flex-direction:column;gap:4px;font-size:13.5px;color:#aab0b9}.kv b{color:#e8eaed;font-weight:600}.hist{font-size:13px;color:#8a9099;border-top:1px solid #1b1f25;padding-top:8px;display:flex;flex-direction:column;gap:3px}
.ctl{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.ctl .call{flex:1 1 220px;min-height:64px;font-size:20px}.timer{font-size:28px;font-weight:800;font-variant-numeric:tabular-nums;min-width:78px}
.kp{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;max-width:260px}.kp button{min-height:46px;background:#151a21;border:1px solid #2a313a;color:#e8eaed;border-radius:10px;font:inherit;font-size:18px;font-weight:700}
.panel{background:#0d1116;border:1px solid #1d2229;border-radius:16px;padding:14px;display:flex;flex-direction:column;gap:10px}.panel h3{margin:0;font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:#c3c8cf}
.outs{display:flex;flex-direction:column;gap:12px}.outs .og{display:flex;flex-direction:column;gap:6px}.outs .ol{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#7c838d}.outs .ob{display:flex;gap:8px;flex-wrap:wrap}.outs .ob .btn{flex:1 1 130px}.outs .btn.on{background:#10301a;border-color:#2f9e3f;color:#9fe29f}
textarea,input[type=text]{width:100%;background:#12171e;border:1px solid #2a313a;color:#fff;border-radius:10px;padding:10px 12px;font:inherit;font-size:16px;color-scheme:dark}textarea{resize:vertical;min-height:84px}
.script{font-size:15px;line-height:1.5}.script h4{margin:12px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:#32cd32}.script p{margin:0 0 6px}.script ul{margin:0 0 6px;padding-left:20px}.script li{margin:2px 0}
.tabs{display:flex;gap:6px}.tabs button{border:1px solid #2a313a;background:#151a21;color:#aab0b9;border-radius:999px;padding:6px 14px;font:inherit;font-weight:700;cursor:pointer}.tabs button.on{background:#32cd32;border-color:#32cd32;color:#04120a}
.q .it{display:block;width:100%;text-align:left;background:#0d1116;border:1px solid #1d2229;border-radius:12px;padding:10px 12px;color:inherit;font:inherit;cursor:pointer;margin-bottom:8px}.tr{max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;font-size:14px;background:#0b0e12;border:1px solid #1b1f25;border-radius:10px;padding:8px 10px}.ln.w-rep b{color:#7fb7ff}.ln.w-lead b{color:#32cd32}.ln.partial{opacity:.65;font-style:italic}
.card2{background:#0b1a10;border:1px solid #1f5a2a;border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}.aca{display:flex;flex-direction:column;gap:6px}.aca div{display:flex;gap:10px;align-items:baseline}.aca span{font-weight:800;color:#32cd32;min-width:96px;font-size:11px;letter-spacing:.6px}.aca p{margin:0;font-size:14.5px}.aca p.ask{font-size:18px;font-weight:700}
.q .it.cur{border-color:#32cd32}.q .it.fresh{border-color:#32cd32;background:#0b1a10}.chip.new{background:#32cd32;color:#04120a;font-weight:800}
.newb{background:#10301a;border:1px solid #1f5a2a;color:#cdf5cd;border-radius:12px;padding:10px 14px;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}.q .it b{display:block;overflow-wrap:anywhere}.q .it small{color:#8a9099}
.note{color:#7c838d;font-size:13px}.err{color:#ff8a8a;font-size:14px;min-height:18px}.okm{color:#9fe29f}
dialog{background:#0f1319;color:#e8eaed;border:1px solid #2a313a;border-radius:16px;padding:0;width:min(560px,calc(100vw - 20px));max-height:calc(100dvh - 20px);overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}dialog::backdrop{background:rgba(0,0,0,.7)}
dialog .rb{padding:16px;display:flex;flex-direction:column;gap:12px}dialog h3{margin:0}dialog label{display:block;color:#7c838d;font-size:11px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:4px}
.vm{background:#0d1116;border:1px solid #1d2229;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px}
#cards{display:flex;flex-direction:column;gap:10px;min-width:0}.cw{display:flex;flex-direction:column;gap:10px}
main{display:flex;flex-direction:column;gap:14px}.center,.rcol{display:flex;flex-direction:column;gap:14px;min-width:0}.callrow,.callbar,.cctl{display:flex;flex-direction:column;gap:10px;min-width:0}
.cwho,.rail .rs,.q .it .av,.q .it .bd,.q .it.done,.shb,.shl{display:none}.q .it .tx{display:block}
.gnx{flex-direction:column;align-items:stretch;gap:8px;padding:12px 14px;border-left:4px solid #32cd32}.gnx .gq.big{flex:none;font-size:21px;font-weight:700;color:#fff;line-height:1.35}.gnx.det{background:#0e1318;border-color:#2a313a;border-left-color:#2a313a}.gnx.det .gq.big{font-size:16px;font-weight:600;color:#cfd3d9}.gnx.det .gl{color:#8b929c}.gtip{font-size:13.5px;color:#aeb4bd}.gtip b{color:#32cd32;font-size:11px;letter-spacing:.6px;text-transform:uppercase;margin-right:6px}.gb{display:flex;gap:8px;flex-wrap:wrap}.nudge{background:#2a1d08;border:1px solid #ffb86b;border-left:4px solid #ffb86b;border-radius:12px;padding:10px 14px;font-size:15px;color:#ffe3bd;line-height:1.4}.nudge b{display:block;color:#ffb86b;margin-bottom:2px}.pbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#0b1a10;border:1px solid #1f5a2a;border-radius:12px;padding:8px 10px}.pbar input[type=text]{flex:1 1 220px;min-width:0;background:#12171e;border:1px solid #2a313a;color:#fff;border-radius:10px;padding:10px 12px;font:inherit;font-size:16px}.pbar #pmic.on{background:#c0392b;border-color:#c0392b;color:#fff}.pch{display:flex;gap:8px;flex-wrap:wrap}.pch button{background:#141a21;border:1px solid #2a313a;color:#aeb4bd;border-radius:999px;padding:8px 14px;font-size:14px;font-weight:600}.pch button.on{background:#32cd32;border-color:#32cd32;color:#04130a}.rb .psc{display:flex;flex-direction:column;gap:6px;border:0;padding:0;background:none}.rb .psc .row{display:flex;flex-direction:row;gap:10px;align-items:center;font-size:14px;border:0;padding:0;background:none;min-height:0}.rb .psc .row b{width:96px;color:#aeb4bd;font-weight:600}.rb .psc .bar2{flex:1;height:8px;background:#1a2028;border:0;padding:0;border-radius:99px;overflow:hidden}.rb .psc .bar2 i{display:block;height:100%;background:#32cd32}.pfix{border:1px solid #2a313a;border-radius:10px;padding:10px 12px;font-size:14px;display:flex;flex-direction:column;gap:4px}.pfix .b{color:#7fe07f;font-weight:600}.qf{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.qf button{background:#141a21;border:1px solid #2a313a;color:#aeb4bd;border-radius:999px;padding:6px 12px;font-size:13px;font-weight:600}.qf button.on{background:#32cd32;border-color:#32cd32;color:#04130a}.ln.low{opacity:.7;font-style:italic}.ln.low::after{content:' (unclear)';color:#ffb86b;font-size:11px}.card2.used{opacity:.55}.more{font-size:14px;color:#cfd3d9}.more summary{cursor:pointer;color:#8b929c;font-size:12.5px;letter-spacing:.4px;padding:2px 0}.more.tai summary{color:#32cd32}.say.sm{font-size:16px!important;font-weight:600!important;margin:6px 0 0}.ask.sm{margin:4px 0 0;color:#fff;font-size:15px}.hist{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px}.hist span{font-size:11px;color:#6d747e;letter-spacing:.6px;text-transform:uppercase}.hist button{background:#141a21;border:1px solid #2a313a;color:#aeb4bd;border-radius:999px;padding:4px 10px;font-size:12.5px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ln{padding:6px 11px;border-radius:12px;max-width:92%;overflow-wrap:anywhere}.ln.w-rep{align-self:flex-end;background:#0f2238}.ln.w-lead{align-self:flex-start;background:#0f2a17}
.cl{display:flex;flex-direction:column;gap:10px;min-width:0}.gnx{flex-wrap:nowrap!important;flex-shrink:0;align-items:stretch!important;min-width:0;max-width:100%;overflow:hidden}.gnx .gts{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.gnx .gts .gt2{max-width:100%;overflow:hidden;text-overflow:ellipsis}.gnx .gb{flex-wrap:wrap}.gnx,.gnx>*{text-align:left}
#trn:empty::before{content:"The live transcript appears here once the call connects.";color:#6d747e;font-size:14px;margin:auto;text-align:center;padding:18px}
#cst.on::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:#32cd32;margin-right:7px;animation:pls 1.4s ease-in-out infinite}@keyframes pls{50%{opacity:.25}}
.ic{display:inline-block;width:18px;height:18px;vertical-align:-4px;margin-right:6px}.ic svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.rec{display:none}.brk{display:none}.brief,.nl{display:none}#stabs{display:none!important}
#script,.gs,.rcol,.center,.panel{min-width:0;max-width:100%}.gs{overflow-x:clip}
.gbar{position:sticky;top:0;z-index:4;background:#0d1116;padding:6px 0 8px;display:flex;flex-direction:column;gap:6px;border-bottom:1px solid #1b2128}.gline{display:flex;gap:6px;overflow-x:auto;white-space:nowrap}.gline .gpb{flex:none}.gpb.red{background:#2b1b1c;border-color:#6a3633;color:#f2918a}.gpb.now{margin-left:auto;border-color:#32cd32;color:#32cd32}.gpb.here{border-color:#32cd32;color:#e8eaed}
.gsh{margin:12px 0 0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#32cd32;scroll-margin-top:96px}
.card2.ans{gap:10px}.card2.ans .say{margin:0;font-size:19px;font-weight:700;line-height:1.35;color:#fff}.alines{display:flex;flex-direction:column;gap:6px}.alines div{font-size:14.5px;color:#cfd3d9}.alines b{display:block;color:#7c838d;font-size:11px;letter-spacing:.7px;text-transform:uppercase}.ansq{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gnx{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#0b1a10;border:1px solid #1f5a2a;border-radius:12px;padding:8px 12px}.gnx .gl{font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:#7c838d}.gnx .gq{flex:1 1 220px;min-width:0;color:#cfd3d9;font-size:14px}
.gstep{background:#0b0f13;border:1px solid #1b2128;border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;scroll-margin-top:96px}.gstep.cur{border-color:#32cd32;box-shadow:0 0 0 1px #32cd32}.gck{display:none;color:#32cd32;font-size:12px;font-weight:800}.gstep.done .gck{display:inline}.gstep .ghd b{font-size:15px}
.gmap{display:flex;flex-direction:column;gap:5px}.gph{display:flex;flex-wrap:wrap;gap:5px;align-items:center}.gpl{font-size:10.5px;letter-spacing:.8px;text-transform:uppercase;color:#7c838d;width:70px;flex:none}
.gpb{border:1px solid #2a313a;background:#12171e;color:#aab0b9;border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;font-weight:700;cursor:pointer}.gpb.here{border-color:#32cd32;color:#e8eaed}.gpb.on{background:#e8eaed;border-color:#e8eaed;color:#07090c}.gpb.done:not(.on)::after{content:' \\2713';color:#32cd32}
.gobjs{flex-wrap:nowrap!important;overflow-x:auto;white-space:nowrap;padding-bottom:4px}.gobjs button{flex:none}
.gt2{border:1px solid #2a313a;background:#12171e;color:#aab0b9;border-radius:8px;padding:4px 8px;font:inherit;font-size:12.5px;cursor:pointer}.gt2 b{color:#7c838d;margin-right:5px}.gt2.done{border-color:#2a5f57;color:#6fd2c3;background:#0b1a16}.gt2.done b{color:#6fd2c3}.gt2.on{background:#32cd32;border-color:#32cd32;color:#04120a}.gt2.on b{color:#04120a}.gt2.sug:not(.on){box-shadow:0 0 0 2px rgba(50,205,50,.5)}
.gs{display:flex;flex-direction:column;gap:10px}.gphases,.gobjs{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.gphases button,.gobjs button{border:1px solid #2a313a;background:#12171e;color:#aab0b9;border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;font-weight:700;cursor:pointer}.gphases button.on{background:#32cd32;border-color:#32cd32;color:#04120a}
.gobjs button{background:#2b1b1c;border-color:#6a3633;color:#f2918a}.gobjs button.on{background:#f2918a;color:#2b1b1c}.gobjs button.hot{animation:pls 1s ease-in-out infinite;box-shadow:0 0 0 3px rgba(242,145,138,.35)}.gol{font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:#7c838d}
.gcard{background:#0b0f13;border:1px solid #1b2128;border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}.ghd{display:flex;gap:10px;align-items:baseline;justify-content:space-between;flex-wrap:wrap}.ghd b{font-size:15px}.gback{border:1px solid #2a313a;background:#12171e;color:#e8eaed;border-radius:999px;padding:4px 12px;font:inherit;font-size:12.5px;cursor:pointer}
.gn{border-radius:12px;padding:10px 13px;border:1px solid #1b2128;background:#10161b}.gn p{margin:0;font-size:16px;line-height:1.5}.gn p+p{margin-top:8px}.gt{font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:#7c838d;margin-bottom:4px}
.gn.obj{background:#2b1b1c;border-color:#6a3633}.gn.obj p{font-weight:700}.gn.obj .gt{color:#f2918a}.gn.resp{background:#122925;border-color:#2a5f57}.gn.resp .gt{color:#6fd2c3}.gn.probe{border:2px solid #3d5680}.gn.probe .gt{color:#8fb1ea}.gn.coach{background:#282114;border:1px dashed #6b5527}.gn.coach .gt,.gnote{color:#e7bd66}.gn.ex{background:transparent;border:1px dashed #344252;color:#94a1b0}.gn.router .glinks{flex-direction:column;align-items:stretch}
.gnote{font-size:14px!important;border-top:1px dashed #6b5527;padding-top:7px}.gnote b{font-size:10.5px;letter-spacing:.8px;text-transform:uppercase;margin-right:6px}.gsub{display:block;font-size:10.5px;letter-spacing:.8px;text-transform:uppercase;color:#7c838d;margin-bottom:2px}
.glist{margin:8px 0 0;padding-left:20px;display:flex;flex-direction:column;gap:8px}.glist li{font-size:15.5px}.glist b{display:block;font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:#7c838d}
.gchips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.gchips span{border:1px solid #344252;border-radius:999px;padding:2px 10px;font-size:13px;color:#aab0b9}.gaddr{font-weight:700}
.glinks{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.gjump{border:1px solid #2a5f57;background:#0b1a16;color:#6fd2c3;border-radius:999px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer}.gjump.ob{border-color:#6a3633;color:#f2918a;background:#2b1b1c}.gjump.fu{border-color:#3d5680;color:#8fb1ea;background:#0f1b2c}.gn.router .gjump{border-radius:10px;text-align:left;font-weight:700}
.gcond{align-self:flex-start;font-size:12.5px;color:#94a1b0;background:#12171e;border:1px solid #2a313a;border-radius:8px;padding:3px 10px}.gcond b{color:#e8eaed}.gout{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.gopt{display:flex;flex-direction:column;gap:8px;min-width:0}
.gside{border:1px solid #1b2128;border-radius:12px;padding:8px 12px}.gside summary{cursor:pointer;font-size:13.5px;color:#f2918a;font-weight:700}.gside>.gn,.gside>.gcond,.gside>.gjump,.gside>.gout{margin-top:8px}.gex summary{color:#94a1b0}
.gnav{display:flex;align-items:center;justify-content:space-between;gap:10px}
.ph{background:#1e2c42;color:#b5c9ee;border-radius:5px;padding:0 6px;font-weight:700;cursor:pointer}.ph.ok{background:#122925;color:#6fd2c3}.ph.un{background:#282114;color:#e7bd66;border:1px dashed #6b5527}.phin{background:#12171e;border:1px solid #32cd32;color:#fff;border-radius:6px;padding:2px 8px;font:inherit;width:11em}
.gform{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}.gform>div{min-width:0}.gform input{min-width:0!important;max-width:100%}.gdet{border:1px solid #1d2229;border-radius:12px;padding:10px 12px}.gdet summary{cursor:pointer;font-weight:700}.gdet[open] summary{margin-bottom:10px}
.inf{display:flex;flex-direction:column;gap:12px;font-size:14.5px}.inf[hidden]{display:none!important}.itabs{display:flex;gap:6px;flex-wrap:wrap}.itabs button{border:1px solid #2a313a;background:#12171e;color:#aab0b9;border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;font-weight:700;cursor:pointer}.itabs button.on{background:#e8eaed;border-color:#e8eaed;color:#07090c}.itabs small{opacity:.7;margin-left:4px}
.fg{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}.fg div{background:#0b0f13;border:1px solid #1b2128;border-radius:12px;padding:9px 12px;min-width:0}.fg small{display:block;font-size:11px;letter-spacing:.7px;text-transform:uppercase;color:#7c838d}.fg b{display:block;font-size:15px;overflow-wrap:anywhere}
.warnb{background:#2a1414;border:1px solid #5a2323;color:#ffb3b3;border-radius:12px;padding:9px 12px;font-size:13.5px}
.lst{display:flex;flex-direction:column;gap:8px}.row{background:#0b0f13;border:1px solid #1b2128;border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}.row .top{display:flex;gap:8px;align-items:baseline;justify-content:space-between;flex-wrap:wrap}.row .top b{font-size:14.5px}.row .top span{color:#7c838d;font-size:12.5px}.row p{margin:0;overflow-wrap:anywhere}.row audio{width:100%;height:34px}.row details summary{cursor:pointer;color:#32cd32;font-size:13px;font-weight:700}.row .tl{display:flex;flex-direction:column;gap:4px;margin-top:6px;max-height:260px;overflow-y:auto}.row .tl div{font-size:13.5px}.row .tl .r b{color:#7fb7ff}.row .tl .l b{color:#32cd32}
.bub{max-width:90%;padding:7px 11px;border-radius:12px;font-size:14px;overflow-wrap:anywhere}.bub.in{align-self:flex-start;background:#0f2a17}.bub.out{align-self:flex-end;background:#0f2238}.bub small{display:block;color:#7c838d;font-size:11px;margin-top:2px}.thr{display:flex;flex-direction:column;gap:6px;max-height:340px;overflow-y:auto}
.inf textarea{min-height:64px}.inf .btn{min-height:38px}.empty{color:#6d747e;font-size:13.5px;padding:8px 2px}
@media(min-width:1100px){
body{background:radial-gradient(1100px 480px at 65% -10%,#0d1a12 0,#07090c 62%)}
main{display:grid;max-width:1440px;margin:0 auto;padding:20px 32px 48px;column-gap:24px;row-gap:0;align-items:start}
#setup,#topbar,#newb{grid-column:1/-1;margin-bottom:16px}#topbar{display:flex;align-items:center;gap:12px}#st{display:none}
.av{width:52px;height:52px;border-radius:50%;background:linear-gradient(145deg,#1b5d30,#0f3a1f);color:#c9f7c9;font-weight:800;display:grid;place-items:center;font-size:19px;flex:none;letter-spacing:.5px}
.nl{align-items:center;gap:8px;font-size:15px;color:#aab0b9;background:#0d1116;border:1px solid #1d2229;border-radius:999px;padding:7px 16px}.nl b{color:#e8eaed}.nl .nb{margin-left:4px;animation:pls 1s ease-in-out infinite;box-shadow:0 0 0 3px rgba(50,205,50,.25)}
main.m-call .nl{display:inline-flex}
/* between calls: queue left, brief right */
main.m-idle,main.m-ended{grid-template-columns:370px minmax(0,1fr)}
main.m-idle .rail,main.m-ended .rail{grid-column:1;grid-row:4;position:sticky;top:16px;max-height:calc(100dvh - 40px);overflow-y:auto}
main.m-idle .center,main.m-ended .center{grid-column:2;grid-row:4;display:flex;flex-direction:column;gap:16px;min-width:0}
main.m-idle .rcol,main.m-ended .rcol,main.m-idle .callrow,main.m-ended .callrow{display:none}
main.m-idle #after,main.m-idle #coach,main.m-idle #nxtrow{display:none}main.m-ended #coach,main.m-ended .rcol,main.m-ended #script,main.m-ended .tr{display:none!important} /* after the call the script, coach and transcript go away: only the wrap-up shows */main.m-ended .brief{display:none}main.m-idle .brief{display:flex}
/* on a call: the script is the big column on the left, the AI coach sits on the right, queue tucked away */
main.m-call{grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)}
main.m-call .rail,main.m-call .brief,main.m-call #after,main.m-call #nxtrow{display:none}
main.m-call .center,main.m-call .callrow{display:contents}
main.m-call .callbar{grid-column:1/-1;grid-row:4;margin-bottom:16px}main.m-call #coach{grid-column:2;grid-row:5}main.m-call .cw{grid-template-columns:minmax(0,1fr)}main.m-call .tr{display:none} /* the transcript is hidden on screen only: the AI coach reads the call itself on the server */
main.m-call .rcol{grid-column:1;grid-row:5;display:flex;flex-direction:column;gap:16px;position:sticky;top:96px;max-height:calc(100dvh - 116px);overflow-y:auto}
.callbar{position:sticky;top:12px;z-index:6;flex-direction:row;align-items:center;gap:22px;background:linear-gradient(115deg,#06271b,#0a1712 55%,#0d1116);border:1px solid #1f5a2a;border-radius:22px;padding:14px 22px;box-shadow:0 14px 34px rgba(0,0,0,.55)}
.cwho{display:flex;gap:14px;align-items:center;min-width:0;flex:1 1 auto}
.cwho b{display:block;font-size:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cwho .ph2{color:#9aa3ad;font-size:14.5px;font-variant-numeric:tabular-nums}.cwho .stt{display:inline-block;margin-left:10px;font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:#aab0b9}.cwho .stt.ok{color:#32cd32}.cwho .stt.warn{color:#ffd166}.cwho .stt.bad{color:#ff8a8a}
.cctl{position:relative;flex:0 0 auto;flex-direction:row;min-width:0}
.ctl{flex-wrap:nowrap;align-items:center;gap:8px}.ctl .btn{border-radius:999px;min-height:46px;padding:8px 14px;font-size:14px;background:#121a17;border-color:#25402d;order:3}.ctl .btn.on{background:#e8eaed;color:#07090c}.ctl .btn.g{background:#32cd32;border-color:#32cd32;color:#04120a}.ctl .btn.r{background:#e24545;border-color:#e24545;color:#fff}.ctl .btn.sm{min-height:46px}.ctl .vl{display:none}.ctl [data-vm]{text-transform:capitalize}.ctl .ic{margin-right:5px}
.ctl .call{flex:0 0 auto;min-width:150px;min-height:50px;font-size:16px;order:9}.timer{font-size:34px;min-width:84px;color:#32cd32;order:1;margin-right:2px}.rec{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:800;letter-spacing:.8px;color:#ff8a8a;order:2;margin-right:8px}.rec::before{content:"";width:8px;height:8px;border-radius:50%;background:#ff4d4d;animation:pls 1.2s infinite}
.kp{position:absolute;top:calc(100% + 18px);right:0;background:#0d1116;border:1px solid #2a313a;border-radius:18px;padding:12px;z-index:7;width:260px;box-shadow:0 16px 40px rgba(0,0,0,.6)}
#coach{min-height:calc(100dvh - 290px);border-color:#1f3a27;background:linear-gradient(180deg,#0c1410,#0d1116 45%);border-radius:20px;padding:18px}
.shb{display:block;height:6px;border-radius:99px;background:#0f2a17;overflow:hidden}.shb[hidden]{display:none!important}.shb i{display:block;height:100%;width:50%;background:#7fb7ff;transition:width .6s}.shl{display:inline;font-size:12.5px;color:#9aa3ad;font-variant-numeric:tabular-nums}.shl.hi{color:#ffd166}
.cw{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:16px;flex:1}
.tr{max-height:calc(100dvh - 360px);min-height:300px;font-size:15px;gap:7px;padding:12px}
.card2{padding:14px 16px;gap:10px;border-left:4px solid #32cd32;border-radius:14px}.aca{gap:10px}.aca div{flex-direction:column;gap:2px}.aca span{min-width:0}.aca p{font-size:16px}.aca p.ask{font-size:23px;line-height:1.25;color:#fff}.aca p.ask::before{content:"\\2192  ";color:#32cd32}
.rcol .lead{background:#0d1116;margin-bottom:0;padding:12px 14px}.rcol .lead .kv,.rcol .lead .hist,.rcol .lead .bar:last-child{display:none}.rcol .lead .bar:first-child,.rcol .lead .ph{display:none}.rcol .script{font-size:18px;line-height:1.5}
.rail{border-radius:20px;padding:16px}.rail .rs{display:flex;gap:8px;flex-wrap:wrap}.rs span{background:#121a17;border:1px solid #25402d;border-radius:999px;padding:4px 11px;font-size:12.5px;color:#aab0b9}.rs b{color:#e8eaed}
.q .it{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:12px;align-items:center;margin-bottom:8px;padding:10px 12px}.q .it .av{display:grid;width:44px;height:44px;font-size:16px}.q .it .tx{min-width:0}.q .it .tx b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15.5px}.q .it .tx small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.q .it .bd{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;border-radius:999px;padding:3px 9px;background:#1a2027;color:#8a9099}.q .it.cur{background:#0f2418}.q .it.cur .bd{background:#32cd32;color:#04120a}
.q .it.done{display:grid;opacity:.5;cursor:default;background:transparent;border-color:transparent}.q .it.done .av{background:#1a2027;color:#6d747e}
.brief{flex-direction:column;gap:22px;background:linear-gradient(160deg,#0f1a13,#0d1116 62%);border:1px solid #1f3a27;border-radius:24px;padding:30px 32px}
.bh{display:flex;gap:20px;align-items:center}.bh .av{width:72px;height:72px;font-size:26px}.bh h2{margin:0;font-size:34px;line-height:1.1;overflow-wrap:anywhere}.bh .ph{color:#32cd32;font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;margin-top:4px}
.bgrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:18px;align-items:start}
.bc{background:#0b0f13;border:1px solid #1b2128;border-radius:16px;padding:18px 20px;display:flex;flex-direction:column;gap:6px}.bc h4{margin:10px 0 2px;font-size:11.5px;letter-spacing:.9px;text-transform:uppercase;color:#32cd32}.bc h4:first-child{margin-top:0}.bc p{margin:0;font-size:16px;line-height:1.5}.bc .mut{color:#8a9099;font-size:14px}.bc .big{font-size:18px;font-weight:700}
.bcall{min-height:80px;font-size:24px;border-radius:20px;width:100%}
.skip{align-self:center}
}
/* polish: dialer idle screen */
.bh .ph,.lead .ph{background:none!important;color:#32cd32!important;padding:0!important;border-radius:0!important;cursor:default;letter-spacing:.4px}
.brief{background:radial-gradient(120% 90% at 0% 0%,#123220 0,#0d1612 38%,#0b0f13 75%);border:1px solid #1d4029;box-shadow:0 18px 50px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.04);gap:20px}
.bh{gap:18px}.bh .av{width:76px;height:76px;box-shadow:0 0 0 3px #0b0f13,0 0 0 5px #1f6a37,0 8px 24px rgba(50,205,50,.18)}
.bh h2{letter-spacing:-.4px;font-size:36px}
.brief .chips{gap:8px}.brief .chip{padding:6px 14px;font-size:13.5px;background:#141b22;border:1px solid #232d37;color:#d6dbe1}.brief .chip.hot{background:#0f2c18;border-color:#1f6a37;color:#8cf08c;font-weight:700}
.bc{background:linear-gradient(180deg,#0e1419,#0b0f13);border:1px solid #1b2530;border-radius:18px;padding:20px 22px;gap:8px;box-shadow:0 6px 18px rgba(0,0,0,.25)}
.bc h4{display:flex;align-items:center;gap:8px;color:#4fdc5a;font-size:11px;letter-spacing:1.2px}.bc h4::after{content:"";flex:1;height:1px;background:#1b2530}
.bc p{color:#dfe3e8}.bc .big{font-size:19px;color:#fff;letter-spacing:-.1px}
.bcall{background:linear-gradient(180deg,#3bdc3b,#27b927);border:0;color:#04120a;box-shadow:0 10px 30px rgba(50,205,50,.28),inset 0 1px 0 rgba(255,255,255,.35);transition:transform .12s,box-shadow .12s,filter .12s;letter-spacing:.2px}
.bcall:hover:not(:disabled){transform:translateY(-1px);filter:brightness(1.06);box-shadow:0 14px 36px rgba(50,205,50,.36),inset 0 1px 0 rgba(255,255,255,.35)}.bcall:active:not(:disabled){transform:translateY(1px)}
.skip{background:none;border:1px solid #232d37;color:#8a939e}.skip:hover{color:#e8eaed;border-color:#34404c}
.q .it{background:#0d1217;border:1px solid #1a222b;border-radius:14px;transition:border-color .12s,background .12s}.q .it:hover{border-color:#2c3a47;background:#10161c}.q .it.cur{border-color:#2f9e3f;background:#0e1d14;box-shadow:0 0 0 1px #1f6a37 inset}
.panel{border-radius:18px;background:#0b0f13;border-color:#19212a}.panel h3{letter-spacing:1.2px;color:#8a939e;font-size:11.5px}
.tabs button{padding:7px 16px}.tabs button.on{box-shadow:0 4px 14px rgba(50,205,50,.22)}
header h1{letter-spacing:-.2px}
.bbody{display:flex;flex-direction:column;gap:20px}
#gnx{display:none!important}#navdr{position:fixed;top:0;bottom:0;left:228px;right:0;z-index:20;background:#07090c}#navdr[hidden]{display:none}#navdr iframe{width:100%;height:100%;border:0;background:#07090c;display:block}
#fbox{position:fixed;right:20px;bottom:20px;width:350px;max-width:calc(100vw - 24px);z-index:80;background:linear-gradient(180deg,#0e1a12,#0a110d);border:1px solid #1f6a37;border-radius:20px;box-shadow:0 22px 60px rgba(0,0,0,.65),0 0 0 1px rgba(50,205,50,.08);padding:14px;display:flex;flex-direction:column;gap:10px}#fbox[hidden]{display:none}
#fbox .fh{display:flex;align-items:center;gap:10px}#fbox .av{width:40px;height:40px;font-size:15px}#fbox .fn{flex:1;min-width:0}#fbox .fn b{display:block;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#fbox .fn small{color:#7fe08a;font-size:12.5px}#fbox .timer{font-size:22px;min-width:0}
#fbox .fs{background:#0b0f13;border:1px solid #1b2530;border-radius:12px;padding:9px 11px}#fbox .fs i{display:block;font-style:normal;font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:#4fdc5a;margin-bottom:3px}#fbox .fs p{margin:0;font-size:15px;line-height:1.35;color:#fff;font-weight:650;max-height:96px;overflow:auto}#fbox .fl2 p{font-size:13.5px;color:#aab0b9;font-weight:500;max-height:54px}
#fbox .fbs{display:flex;gap:8px}#fbox .fbs .btn{flex:1;min-height:42px;padding:8px 6px}#fbox .fo{display:grid;grid-template-columns:1fr 1fr;gap:6px}#fbox .fo .btn{min-height:40px;padding:6px}#fbox .btn.on{background:#10301a;border-color:#2f9e3f;color:#9fe29f}#fbox .fm{color:#ffb86b;font-size:12.5px}
@media(max-width:1023px){#navdr{left:0;bottom:calc(58px + env(safe-area-inset-bottom,0px))}#fbox{right:10px;left:10px;width:auto;bottom:calc(70px + env(safe-area-inset-bottom,0px))}}
${BNAV_CSS}
/* dialer idle screen, redesign: quiet dark surfaces, hairlines instead of boxes, one accent, text over chips */
#topbar .btn.sm{background:none;border:1px solid var(--line2);color:var(--mut);font-size:12.5px;font-weight:600;border-radius:999px;padding:6px 14px;min-height:0}#topbar .btn.sm:hover{color:var(--text);border-color:#344150}
main.m-idle{grid-template-columns:316px minmax(0,1fr);column-gap:28px;row-gap:0}main.m-idle>.bar,main.m-idle>#setup,main.m-idle>#newb{margin-bottom:10px}main.m-idle>#setup[hidden],main.m-idle>#newb[hidden]{display:none}
/* queue */
.rail{background:none;border:0;border-right:1px solid var(--line);border-radius:0;padding:0 24px 0 0;box-shadow:none}
.rail h3{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);font-weight:700}
.qf{display:flex;flex-wrap:wrap;gap:6px;padding:10px 0 10px}
.qf button,.qf .chip{flex:0 0 auto;background:none;border:1px solid var(--line2);color:var(--mut);border-radius:999px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
.qf button.on,.qf .on{background:var(--accent-bg);border-color:var(--accent-line);color:var(--accent2)}
.rail .rs{display:flex;gap:14px;flex-wrap:wrap;padding:2px 0 12px}.rs span{background:none;border:0;padding:0;border-radius:0;font-size:12px;color:var(--dim)}.rs b{color:var(--text)}
.q .it{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:12px;align-items:center;background:none;border:0;border-top:1px solid var(--line);border-radius:0;margin:0;padding:11px 10px 11px 12px;box-shadow:none;position:relative}
.q .it:hover{background:var(--panel2)}.q .it .av{width:34px;height:34px;font-size:12px;background:var(--panel2);border:1px solid var(--line2);color:var(--mut)}
.q .it .tx b{font-size:14px;font-weight:600}.q .it .tx small{font-size:12px;color:var(--dim)}
.q .it .bd{background:none;color:var(--dim);font-size:10.5px;padding:0;letter-spacing:.08em}
.q .it.cur{background:#0c1a11;box-shadow:none;border-color:var(--line)}.q .it.cur::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:2px;border-radius:2px;background:var(--accent)}.q .it.cur .av{background:var(--accent-bg);border-color:var(--accent-line);color:var(--accent2)}.q .it.cur .bd{background:none;color:var(--accent2)}
.q .it.fresh{background:none}.q .it.done{opacity:.4}
/* lead card */
.brief{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:18px;box-shadow:none;padding:20px 28px 26px;gap:18px}
.brief .tabs{gap:22px;background:none;padding:0;border:0}.brief .tabs button{background:none;border:0;border-bottom:2px solid transparent;border-radius:0;color:var(--mut);padding:6px 0;font-size:13px;font-weight:600;min-height:0}.brief .tabs button.on{color:var(--text);border-bottom-color:var(--accent)}
.bact{position:absolute;top:14px;right:22px;display:flex;align-items:center;gap:8px}
.bcall{height:38px;min-height:38px;width:auto;padding:0 22px;border-radius:999px;background:var(--accent);border:0;color:#04120a;font-size:14px;font-weight:700;box-shadow:0 0 0 4px rgba(50,205,50,.12);letter-spacing:0}.bcall:hover{filter:brightness(1.08)}
.skip{background:none;border:0;color:var(--mut);font-size:13px;font-weight:600;padding:8px 10px;min-height:0}.skip:hover{color:var(--text)}
.bh{gap:16px;margin-top:6px}.bh .av{width:52px;height:52px;font-size:18px;background:var(--panel2);border:1px solid var(--accent-line);color:var(--accent2);box-shadow:none}
.bh h2{font-size:26px;font-weight:650;letter-spacing:-.02em}.bh .ph{color:var(--mut)!important;font-size:14px;font-weight:500;letter-spacing:.02em;margin-top:3px}
.brief .chips{gap:0;flex-wrap:wrap;margin-top:-6px}.brief .chip{background:none;border:0;padding:0;border-radius:0;color:var(--mut);font-size:13px;font-weight:500}.brief .chip+.chip::before{content:"\\00b7";margin:0 9px;color:var(--dim)}.brief .chip.hot{background:none;color:var(--accent2);font-weight:650}
.bgrid{grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:40px;border-top:1px solid var(--line);padding-top:20px}
.bc{background:none;border:0;border-radius:0;padding:0;box-shadow:none;gap:6px}
.bc h4{display:block;margin:14px 0 4px;font-size:10.5px;letter-spacing:.14em;color:var(--dim);font-weight:700}.bc h4::after{display:none}.bc h4:first-child{margin-top:0}
.bc p{font-size:14px;line-height:1.55;color:#b4bcc5}.bc .big{font-size:17px;font-weight:600;color:var(--text);line-height:1.4}.bc .mut{font-size:13px;color:var(--dim)}
@media(max-width:850px){.bgrid{grid-template-columns:1fr;gap:18px}.bact{position:static;justify-content:flex-end}}
@media(max-width:850px){header{padding:12px 14px}h1{font-size:17px}main{grid-template-columns:minmax(0,1fr);padding:10px 14px 24px}}
</style></head><body>
<header><h1>Divine Detailers <b>dialer</b></h1>${nav("dialer", tc, true)}</header>
${bnav("dialer", tc, true)}
<main id="mainv" class="m-idle">
<div id="setup" class="ban" hidden></div>
<div class="bar" id="topbar"><span id="st" class="pill">Loading</span><span id="hrs" class="note"></span><span id="nextline" class="nl"></span><span style="flex:1"></span><button class="btn sm" id="prb" type="button">Practice</button><button class="btn sm" id="vmb" type="button">Voicemails</button><button class="btn sm" id="gcb" type="button">Guided scripts</button><button class="btn sm" id="scb" type="button">Edit scripts</button></div>
<div id="newb" class="newb" hidden></div>
<div class="center">
<section id="brief" class="brief"></section>
<div class="callrow" id="callrow"><div id="lead" class="lead"></div>
<div class="callbar" id="callbar"><div class="cwho" id="cwho"></div><div class="cctl"><div id="ctl" class="ctl"></div><div id="kp" class="kp" hidden></div></div></div></div>
<div id="coach" class="panel" hidden><div class="bar"><h3 style="margin:0">Live coach</h3><span id="cst" class="note"></span><span id="aip" class="pill ok" hidden>AI on</span><span style="flex:1"></span><span class="shl" id="shl"></span></div><div class="shb" id="shb" hidden><i id="shi"></i></div><div id="nudge" class="nudge" hidden></div><div id="pbar" class="pbar" hidden><input id="pin" type="text" autocomplete="off" placeholder="Type what you say, then press Enter, or tap the mic"><button class="btn g" id="psend" type="button">Send</button><button class="btn" id="pmic" type="button">Mic</button><label class="note"><input type="checkbox" id="pspk" checked> Hear the caller</label></div><div class="cw"><div class="cl"><div id="cards"></div><div id="gnx" class="gnx" hidden></div><div id="hist" class="hist"></div></div><div id="trn" class="tr"></div></div></div>
<div id="after" class="panel" hidden>
<h3>How did it go?</h3>
<div class="outs" id="outs"></div>
<textarea id="nt" rows="2" placeholder="Add a note (saved on the lead)"></textarea>
<div class="bar"><button class="btn sm" id="ntb" type="button">Save note</button><button class="btn sm" id="mtb" type="button">Text: I missed you</button><span id="am" class="note"></span></div>
<div id="mt" hidden><textarea id="mtx" rows="4"></textarea><div class="bar" style="margin-top:6px"><button class="btn g sm" id="mts" type="button">Send text</button><span id="mtm" class="note"></span></div></div>
</div>
<div class="bar" id="nxtrow"><button class="btn" id="nxt" type="button" style="flex:1;min-height:52px">Next lead &rarr;</button></div>
</div>
<div class="rcol" id="rcol"><div class="panel"><div class="bar"><div class="tabs" id="mtabs"><button type="button" data-m="script" class="on">Script</button><button type="button" data-m="info">Lead info</button></div><span style="flex:1"></span><div class="tabs" id="stabs"><button type="button" data-k="tint">Tint</button><button type="button" data-k="coating">Coating</button></div></div><div id="script" class="script"></div><div id="info" class="inf" hidden></div></div></div>
<aside class="rail panel q"><h3 style="margin:0">Up next</h3><div class="qf" id="qf" role="group" aria-label="Who to dial"></div><div class="rs" id="rs"></div><div id="q"></div></aside>
</main>
<dialog id="vdlg"></dialog><dialog id="sdlg"></dialog><dialog id="gdlg"></dialog><dialog id="prdlg"></dialog>
<script src="/assets/twilio-voice.min.js"></script>
<script>
const $=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const el=id=>document.getElementById(id),ET='America/New_York';
const QF=[['','New leads'],['nocontact','Not contacted'],['contacted','Contacted'],['quoted','Quote sent'],['aged','7 day +'],['interested','Interested'],['deposit','Deposit pending'],['lost','NO']];let QS=[],QC={};try{QS=JSON.parse(localStorage.getItem('dq')||'[]').filter(x=>QF.some(f=>f[0]===x))}catch(_){}
let Q=[],ix=0,ST={tint:'',coating:'',missed:''},AU={},dev=null,call=null,tmr=null,t0=0,sid='',state='idle',muted=false,sk='tint',vmArm=null;
const etHour=()=>+new Date().toLocaleString('en-US',{timeZone:ET,hour:'numeric',hour12:false});
const inHours=()=>true; // manual dialing works at any hour; only the automatic dialer keeps its calling hours
const e164=p=>{const d=String(p||'').replace(/\\D/g,'');return d.length===10?'+1'+d:d.length===11&&d[0]==='1'?'+'+d:d?'+'+d:''};
const pretty=p=>{const d=String(p||'').replace(/\\D/g,'').slice(-10);return d.length===10?'('+d.slice(0,3)+') '+d.slice(3,6)+'-'+d.slice(6):(p||'')};
const svcOf=l=>/coat/i.test(String(l&&l.service||''))?'coating':'tint';
function fillT(t,l){const veh=[l.year,l.make,l.model].filter(Boolean).join(' '),first=String(l.name||'').trim().split(/\\s+/)[0],sv=svcOf(l);
  const v={first:first&&!/^\\+?[\\d\\s()-]+$/.test(first)?first:'there',vehicle:veh?'your '+veh:'your car',service:String(l.service||'').toLowerCase()||'detailing',service_name:sv==='coating'?'ceramic coating':'ceramic tint',price:l.value?'$'+Math.round(l.value):(sv==='coating'?'$599':'$349'),shop:'Divine Detailers',address:'5181 NW 74th Ave, Miami, FL 33166'};
  return String(t||'').replace(/\\{(\\w+)\\}/g,(m,k)=>v[k]===undefined?m:v[k])}
function ago(iso){const s=Math.max(0,(Date.now()-new Date(iso))/1000);if(s<60)return 'just now';if(s<3600)return Math.floor(s/60)+' min ago';if(s<86400)return Math.floor(s/3600)+' hr ago';return Math.floor(s/86400)+' days ago'}
const svcLab=l=>{const g=gsvc(l);return g==='coating'?'Ceramic':g==='tint'?'Tint':String(l.service||'Lead').split(/\\s+/).slice(0,2).join(' ')};
const shortN=n=>{const w=String(n||'').trim().split(/\\s+/).filter(Boolean);return w.length>1&&/^[A-Za-z]/.test(w[1])?w[0]+' '+w[1][0].toUpperCase()+'.':(w[0]||'')};
function secs(t){const o=[];String(t||'').split('\\n').forEach(line=>{line=line.replace(/\\s+$/,'');if(/^# /.test(line))o.push({h:line.slice(2),l:[]});else if(line&&o.length)o[o.length-1].l.push(line.replace(/^- /,''))});return o}
function setMode(){const m=el('mainv');if(!m)return;m.className=(state==='connecting'||state==='live')?'m-call':(state==='ended'?'m-ended':'m-idle');if(state==='idle')el('coach').hidden=true}
function drawBrief(l){const b=el('brief');if(!l){b.innerHTML='';return}
  const car=[l.year,l.make,l.model].filter(Boolean).join(' '),first=String(l.name||'').trim().split(/\\s+/)[0],fn=first&&!/^\\+?[\\d\\s()-]+$/.test(first)?first:pretty(l.phone);
  const lines=String(l.message||'').split('\\n').map(x=>x.trim()).filter(x=>x&&!/^(form name|ad name|adset name|platform):/i.test(x)).slice(0,6);
  let open='',ask='',offer='';{const bl=briefLines(l);if(bl){open=bl.open;ask=bl.ask;offer=bl.offer}else if(gsvc(l)){const S=secs(fillT(ST[gsvc(l)],l)),off=S.find(x=>/price|offer|quote/i.test(x.h));open=S[0]&&S[0].l[0];ask=S[1]&&S[1].l[0];offer=off&&off.l[0]}}
  const hist=(l.texts||[]).map(t=>(t.direction==='in'?'They texted: ':'You texted: ')+t.body).concat((l.history||[]).slice(0,3).map(h=>h.reason));
  b.innerHTML='<div class="tabs" id="btabs"><button type="button" data-b="brief" class="'+(bt==='brief'?'on':'')+'">Brief</button><button type="button" data-b="info" class="'+(bt==='info'?'on':'')+'">Lead info</button></div><div id="bbody" class="bbody"'+(bt==='brief'?'':' hidden')+'><div class="bh"><span class="av">'+$(initials(l.name))+'</span><div style="min-width:0;flex:1"><h2>'+$(l.name||pretty(l.phone))+'</h2><div class="ph">'+$(pretty(l.phone))+'</div></div>'+(l.cb?'<span class="pill warn">Callback due</span>':'')+(l.fresh?'<span class="pill ok">New lead</span>':'')+'</div>'
   +'<div class="chips">'+(l.service?'<span class="chip hot">'+$(l.service)+'</span>':'')+(car?'<span class="chip">'+$(car)+'</span>':'')+(l.value?'<span class="chip">$'+Math.round(l.value)+'</span>':'')+'<span class="chip">came in '+ago(l.created_at)+'</span>'+(l.tries24?'<span class="chip">'+l.tries24+' call'+(l.tries24===1?'':'s')+' today</span>':'')+(l.utm_medium==='paid_social'?'<span class="chip">Facebook</span>':'')+'</div>'
   +'<div class="bgrid"><div class="bc"><h4>What they asked for</h4><p class="big">'+$(l.service||'Quote request')+'</p>'+(car?'<p>'+$(car)+'</p>':'')+lines.map(x=>'<p class="mut">'+$(x)+'</p>').join('')+(hist.length?'<h4>History</h4>'+hist.map(x=>'<p class="mut">'+$(x)+'</p>').join(''):'')+'</div>'
   +'<div class="bc">'+(ask?'<h4>Ask first</h4><p class="big">'+$(ask)+'</p>':'')+(offer?'<h4>The offer</h4><p>'+$(offer)+'</p>':'')+'</div></div></div><div id="infoc" class="inf"'+(bt==='info'?'':' hidden')+'></div>'
   +'<div class="bact"><button class="btn skip" id="sk2" type="button">Skip</button><button class="btn g bcall" id="cb2" type="button">Call '+$(fn)+'</button></div>';
  el('cb2').onclick=dial;el('sk2').onclick=()=>el('nxt').click();syncCb();if(bt==='info')loadInfo(l.id);if(mt==='info')loadInfo(l.id)}
function syncCb(){const b=el('cb2');if(b)b.disabled=!dev||!inHours()||(state!=='idle'&&state!=='ended')}
let mt='script',bt='brief',itab='ov',INFO={},SNIPD=[];
fetch('/admin/snippets').then(r=>r.json()).then(j=>{if(j.success){SNIPD=j.snippets;if(typeof renderInfo==='function')try{renderInfo()}catch(_){}}}).catch(()=>{});
document.addEventListener('change',async e=>{const sel=e.target.closest&&e.target.closest('select[data-sn]');if(!sel||!sel.value)return;const l=Q[ix];let t='';try{const j=await (await fetch('/admin/snippets/render?id='+sel.value+'&lead='+(l?l.id:''))).json();t=j.text||''}catch(_){}const tb=document.querySelector('.tbox');if(tb&&t){tb.value=(tb.value?tb.value+' ':'')+t;tb.focus()}sel.value=''});
const fmtT=iso=>{try{return new Date(iso).toLocaleString('en-US',{timeZone:ET,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}catch(_){return ''}};
const dur=n=>Math.floor(n/60)+':'+String(n%60).padStart(2,'0');
async function loadInfo(id,force){if(!id)return;if(!force&&INFO[id]){renderInfo();return}try{const j=await (await fetch('/admin/dialer/lead?id='+id)).json();if(j.success){INFO[id]=j}}catch(_){}renderInfo()}
function infoHtml(d){if(!d)return '<p class="empty">Loading lead info...</p>';const L=d.lead,F=d.facts,sub=(k,n,c)=>'<button type="button" data-it="'+k+'" class="'+(itab===k?'on':'')+'">'+n+(c?'<small>'+c+'</small>':'')+'</button>';
  let h='<div class="itabs">'+sub('ov','Overview')+sub('nt','Notes',(L.notes?String(L.notes).split('\\n').filter(Boolean).length:'')||'')+sub('cl','Calls',d.calls.length||'')+sub('tx','Texts',d.texts.length||'')+sub('ac','Activity',d.activity.length||'')+'</div>';
  const car=[L.year,L.make,L.model].filter(Boolean).join(' ');
  if(itab==='ov'){
    h+=(F.optout?'<div class="warnb"><b>Replied STOP.</b> Do not text this person.</div>':'')
     +'<div class="fg"><div><small>Stage</small><b>'+$(L.stage)+'</b></div><div><small>Job value</small><b>'+(L.value?'$'+Math.round(L.value):'-')+'</b></div><div><small>Came in</small><b>'+$(fmtT(L.created_at))+'</b></div><div><small>Source</small><b>'+$([L.utm_medium==='paid_social'?'Facebook':L.utm_source,L.utm_campaign].filter(Boolean).join(' / ')||'Website')+'</b></div>'
     +'<div><small>Call attempts</small><b>'+F.attempts+' ('+F.connected+' connected)</b></div><div><small>Talk time</small><b>'+dur(F.talkSecs)+'</b></div><div><small>First contact</small><b>'+(F.firstContactMins==null?'Not yet':F.firstContactMins<60?F.firstContactMins+' min':Math.round(F.firstContactMins/60)+' hr')+'</b></div><div><small>Last attempt</small><b>'+(F.lastTry?$(fmtT(F.lastTry)):'-')+'</b></div>'
     +'<div><small>Texts</small><b>'+F.textsOut+' sent / '+F.textsIn+' got</b></div><div><small>Appointment</small><b>'+(L.appt_at?$(L.appt_at.replace('T',' ')):'-')+'</b></div><div><small>Follow-up</small><b>'+$(L.follow_up_date||'-')+'</b></div><div><small>Email</small><b>'+$(L.email||'-')+'</b></div></div>'
     +'<div class="row"><div class="top"><b>What they asked for</b></div><p>'+$([L.service,car].filter(Boolean).join(' \u00b7 ')||'Quote request')+'</p>'+(L.also_interested?'<p class="empty">Also interested in: '+$(L.also_interested)+'</p>':'')+String(L.message||'').split('\\n').map(x=>x.trim()).filter(x=>x&&!/^(form name|ad name|adset name|platform):/i.test(x)).map(x=>'<p class="empty">'+$(x)+'</p>').join('')+'</div>'
     +(L.notes?'<div class="row"><div class="top"><b>Notes on the lead</b></div><p>'+$(L.notes)+'</p></div>':'')
     +'<a class="btn sm" href="/admin/pipeline#id='+L.id+'" style="text-decoration:none;display:inline-flex;align-items:center;align-self:flex-start">Open lead / book</a>'}
  else if(itab==='nt'){
    h+='<textarea class="nbox" rows="3" placeholder="Add an internal note (only you can see it)"></textarea><div class="bar"><button class="btn g sm" data-act="note" type="button">Add note</button><span class="note nm"></span></div><div class="lst">'
     +(L.notes?String(L.notes).split('\\n').filter(Boolean).reverse().map(n=>'<div class="row"><p>'+$(n)+'</p></div>').join(''):'<p class="empty">No notes yet.</p>')+'</div>'}
  else if(itab==='cl'){
    h+='<div class="lst">'+(d.calls.length?d.calls.map(c=>'<div class="row"><div class="top"><b>'+(c.kind==='callrail'?'Call'+(c.direction?' ('+$(c.direction)+')':''):'Call')+(c.secs?' \u00b7 '+dur(c.secs):(c.kind==='dialer'?' \u00b7 no answer':''))+'</b><span>'+$(fmtT(c.at))+(c.by?' \u00b7 '+$(c.by):'')+'</span></div>'+(c.summary?'<p>'+$(c.summary)+'</p>':'')+(c.rec?'<audio controls preload="none" src="'+$(c.rec)+'"></audio>':'')+(c.turns&&c.turns.length?'<details><summary>Transcript</summary><div class="tl">'+c.turns.map(t=>'<div class="'+(t.who==='lead'?'l':'r')+'"><b>'+(t.who==='lead'?'Lead':'You')+':</b> '+$(t.text)+'</div>').join('')+'</div></details>':'')+'</div>').join(''):'<p class="empty">No calls yet.</p>')+'</div>'}
  else if(itab==='tx'){
    h+=(F.optout?'<div class="warnb"><b>Replied STOP.</b> Texting is turned off for this number.</div>':'')+'<div class="thr">'+(d.texts.length?d.texts.map(m=>'<div class="bub '+(m.direction==='in'?'in':'out')+'">'+$(m.body)+'<small>'+$(fmtT(m.at))+(m.auto?' \u00b7 automatic':'')+(m.status==='failed'||m.status==='undelivered'?' \u00b7 not delivered':'')+'</small></div>').join(''):'<p class="empty">No texts yet.</p>')+'</div>'
     +(F.optout?'':'<select data-sn class="snsel" style="width:100%;margin-bottom:6px"><option value="">Insert a snippet...</option>'+SNIPD.map(x=>'<option value="'+x.id+'">'+$(x.name)+'</option>').join('')+'</select><textarea class="tbox" rows="3" placeholder="Write a text"></textarea><div class="bar"><button class="btn g sm" data-act="send" type="button">Send text</button><span class="note nm"></span></div>')}
  else{h+='<div class="lst">'+(d.activity.length?d.activity.map(a=>'<div class="row"><div class="top"><b>'+$(a.reason)+'</b><span>'+$(fmtT(a.at))+(a.by?' \u00b7 '+$(a.by):'')+'</span></div>'+(a.from&&a.to&&a.from!==a.to?'<p class="empty">'+$(a.from)+' \u2192 '+$(a.to)+'</p>':'')+'</div>').join(''):'<p class="empty">Nothing yet.</p>')+'</div>'}
  return h}
function renderInfo(){const l=Q[ix];if(!l)return;const h=infoHtml(INFO[l.id]);['info','infoc'].forEach(id=>{const e=el(id);if(e&&!e.hidden){const keep={};e.querySelectorAll('textarea').forEach(t=>keep[t.className]=t.value);e.innerHTML=h;e.querySelectorAll('textarea').forEach(t=>{if(keep[t.className])t.value=keep[t.className]})}})}
function setMain(m){mt=m;document.querySelectorAll('#mtabs button').forEach(b=>b.classList.toggle('on',b.dataset.m===m));el('script').hidden=m!=='script';el('stabs').hidden=m!=='script';el('info').hidden=m!=='info';if(m==='info'){const l=Q[ix];if(l)loadInfo(l.id)}}
function setBrief(m){bt=m;const i=el('infoc'),b=el('bbody');if(!i||!b)return;document.querySelectorAll('#btabs button').forEach(x=>x.classList.toggle('on',x.dataset.b===m));b.hidden=m!=='brief';i.hidden=m!=='info';if(m==='info'){const l=Q[ix];if(l)loadInfo(l.id)}}
document.addEventListener('click',async e=>{const t=e.target.closest('button');if(!t)return;
  if(t.dataset.m){setMain(t.dataset.m);return}if(t.dataset.b){setBrief(t.dataset.b);return}if(t.dataset.it){itab=t.dataset.it;renderInfo();return}
  const l=Q[ix],box=t.closest('.inf');if(!l||!box)return;const nm=box.querySelector('.nm');
  if(t.dataset.act==='note'){const v=box.querySelector('.nbox').value.trim();if(!v)return;t.disabled=true;let ok=false;try{ok=(await (await fetch('/admin/dialer/note',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:l.id,text:v})})).json()).success}catch(_){}t.disabled=false;if(ok){box.querySelector('.nbox').value='';await loadInfo(l.id,true)}else if(nm)nm.textContent='Could not save the note.'}
  if(t.dataset.act==='send'){const v=box.querySelector('.tbox').value.trim();if(!v)return;t.disabled=true;let j={};try{j=await (await fetch('/admin/msg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:l.id,body:v})})).json()}catch(_){}t.disabled=false;if(j.success){box.querySelector('.tbox').value='';await loadInfo(l.id,true)}else if(nm)nm.textContent=j.message||'Could not send.'}});
function setSt(t,c){const s=el('st');s.textContent=t;s.className='pill'+(c?' '+c:'');const s2=el('st2');if(s2){s2.textContent=t;s2.className='stt'+(c?' '+c:'')}}
let made=0;const CALLED=new Set();const initials=n=>(String(n||'').trim().split(/\\s+/).filter(w=>/^[A-Za-z]/.test(w)).slice(0,2).map(w=>w[0].toUpperCase()).join(''))||'#';
const mq=window.matchMedia('(min-width:1100px)');function place(){const r=el('rcol'),lead=el('lead');if(mq.matches)r.insertBefore(lead,r.firstChild);else el('callrow').insertBefore(lead,el('callrow').firstChild)}
function scriptHtml(t){return String(t||'').split('\\n').map(line=>{line=line.replace(/\\s+$/,'');if(!line)return '';if(/^# /.test(line))return '<h4>'+$(line.slice(2))+'</h4>';if(/^- /.test(line))return '<li>'+$(line.slice(2))+'</li>';return '<p>'+$(line)+'</p>'}).join('').replace(/(<li>.*?<\\/li>)+/g,m=>'<ul>'+m+'</ul>')}
function drawScript(){const l=Q[ix]||{};const svc=gsvc(l);
  if(svc&&GS[svc]&&gRender())return;
  if(svc&&GS[svc]===undefined){el('script').innerHTML='<p class="note">Loading script...</p>';gLoad(svc).then(drawScript);return}
  if(!svc){el('script').innerHTML='<p class="note">There is no script for '+$(l.service||'this service')+' yet. Use the Lead info tab and the coach cards.</p>';return}
  el('script').innerHTML='<p class="note">Showing the basic script. Import yours under Guided scripts to get the step by step flow.</p>'+scriptHtml(fillT(ST[svc],l))}
function drawLead(){const l=Q[ix];const box=el('lead');
  if(!l){box.innerHTML='<h2>'+(Q.length?'Queue finished':'No leads to call')+'</h2><p class="note">'+(Q.length?'Nice work. Reload to check for new leads.':'New and not-contacted leads from the last 14 days, and callbacks that are due, show up here.')+'</p>';el('ctl').innerHTML='';el('brief').innerHTML='';el('after').hidden=true;return}
  const car=[l.year,l.make,l.model].filter(Boolean).join(' ');
  el('cwho').innerHTML='<span class="av">'+$(initials(l.name))+'</span><span style="min-width:0"><b>'+$(l.name||pretty(l.phone))+'</b><span class="ph2">'+$(pretty(l.phone))+'</span><br><span class="stt" id="st2">'+$(el('st').textContent)+'</span></span>';
  const lines=String(l.message||'').split('\\n').map(x=>x.trim()).filter(x=>x&&!/^(form name|ad name|adset name|platform):/i.test(x)).slice(0,6);
  box.innerHTML='<div class="bar"><h2 style="flex:1">'+$(l.name||pretty(l.phone))+'</h2>'+(l.cb?'<span class="pill warn">Callback due</span>':'')+(l.fresh?'<span class="pill ok">New lead</span>':'')+'</div><div class="ph">'+$(pretty(l.phone))+'</div>'
   +'<div class="chips">'+(l.service?'<span class="chip hot">'+$(l.service)+'</span>':'')+(car?'<span class="chip">'+$(car)+'</span>':'')+(l.value?'<span class="chip">$'+Math.round(l.value)+'</span>':'')+'<span class="chip">came in '+ago(l.created_at)+'</span>'+(l.tries24?'<span class="chip">'+l.tries24+' call'+(l.tries24===1?'':'s')+' today</span>':'')+(l.utm_medium==='paid_social'?'<span class="chip">Facebook</span>':'')+'</div>'
   +(lines.length?'<div class="kv">'+lines.map(x=>'<span>'+$(x)+'</span>').join('')+'</div>':'')
   +((l.texts&&l.texts.length)||(l.history&&l.history.length)?'<div class="hist">'+(l.texts||[]).map(t=>'<span>'+(t.direction==='in'?'They texted: ':'You texted: ')+$(t.body)+'</span>').join('')+(l.history||[]).slice(0,3).map(h=>'<span>'+$(h.reason)+'</span>').join('')+'</div>':'')
   +'<div class="bar"><a class="btn sm" href="/admin/pipeline#id='+l.id+'" style="text-decoration:none;display:inline-flex;align-items:center">Open lead / book</a></div>';
  if(gLead!==l.id){gLead=l.id;gi=0;gPlay=null;gHot='';OVR={};FACTS={goals:[]};COV={};SAID={};LH={};LH={};BR={};lastSaid=null;priceAt=0;depAsked=false;sigAt=0;gOpenPh=''}
  sk=svcOf(l);{const sv=gsvc(l);if(sv&&GS[sv]===undefined)gLoad(sv).then(()=>{if(Q[ix]===l){drawScript();drawBrief(l)}})}
  drawScript();drawBrief(l);drawCtl()}
function drawCtl(){setMode();drawQ();syncCb();const l=Q[ix],c=el('ctl'),kp=el('kp');if(!l){return}
  if(practiceOn&&state==='live'){c.innerHTML='<span class="timer" id="tm">0:00</span><span class="rec" style="color:#ffb86b">PRACTICE</span><button class="btn r call" id="hb" type="button">End practice</button>';kp.hidden=true;el('hb').onclick=endPractice;return}
  const noDev=!dev;
  if(state==='idle'||state==='ended'){c.innerHTML='<button class="btn g call" id="cb" type="button"'+(noDev||!inHours()?' disabled':'')+'><i class="ic"><svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg></i>'+(state==='ended'?'Call again':'Call '+$(pretty(l.phone)))+'</button>';kp.hidden=true;el('hrs').textContent=inHours()?'':'Calling hours are 8 AM to 9 PM Eastern.';
    const b=el('cb');if(b)b.onclick=dial;return}
  const live=state==='live';
  c.innerHTML='<span class="timer" id="tm">'+(live?'0:00':'...')+'</span>'+(live?'<span class="rec">REC</span>':'')+'<button class="btn r call" id="hb" type="button">Hang up</button><span class="brk"></span><button class="btn'+(muted?' on':'')+'" id="mb" type="button"'+(live?'':' disabled')+'><i class="ic"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></i>'+(muted?'Unmute':'Mute')+'</button><button class="btn" id="kb" type="button"'+(live?'':' disabled')+'><i class="ic"><svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="1.2"/><circle cx="12" cy="6" r="1.2"/><circle cx="18" cy="6" r="1.2"/><circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/><circle cx="6" cy="18" r="1.2"/><circle cx="12" cy="18" r="1.2"/><circle cx="18" cy="18" r="1.2"/></svg></i> Keypad</button>'
   +['tint','coating'].map(k=>'<button class="btn sm'+(svcOf(l)===k?' g':'')+'" data-vm="'+k+'" type="button"'+(live&&AU[k]&&AU[k].has?'':' disabled')+'>'+'<i class="ic"><svg viewBox="0 0 24 24"><circle cx="7" cy="12" r="3.5"/><circle cx="17" cy="12" r="3.5"/><path d="M7 15.5h10"/></svg></i>'+(vmArm===k?'Tap again to drop':'<span class="vl">Drop </span>'+k+'<span class="vl"> voicemail</span>')+'</button>').join('');
  el('hb').onclick=()=>{if(call)call.disconnect()};el('mb').onclick=()=>{if(call){muted=!muted;call.mute(muted);drawCtl()}};el('kb').onclick=()=>{kp.hidden=!kp.hidden};
  c.querySelectorAll('[data-vm]').forEach(b=>b.onclick=()=>vmDrop(b.dataset.vm));
  kp.innerHTML='123456789*0#'.split('').map(d=>'<button type="button" data-d="'+d+'">'+d+'</button>').join('');kp.querySelectorAll('button').forEach(b=>b.onclick=()=>{if(call)call.sendDigits(b.dataset.d)})}
function tick(){const t=el('tm');if(!t||!t0)return;const s=Math.floor((Date.now()-t0)/1000);t.textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
async function tok(){const r=await fetch('/admin/dialer/token');return r.json().catch(()=>({success:false,message:'Could not reach the server.'}))}
function setup(msg,missing){const s=el('setup');s.hidden=false;s.innerHTML='<b>Calling is not set up yet.</b> '+$(msg||'')+(missing&&missing.length?'<br>Add these in Cloudflare: '+missing.map(m=>'<code>'+$(m)+'</code>').join(' '):'');setSt('Not set up','bad')}
async function initDev(){if(typeof Twilio==='undefined'||!Twilio.Device){setup('The calling library did not load. Reload the page.');return}
  const j=await tok();if(!j.success){setup(j.message,j.missing);return}
  dev=new Twilio.Device(j.token,{codecPreferences:['opus','pcmu'],closeProtection:'A call is in progress. Leave anyway?'});
  dev.on('error',e=>setSt('Error: '+((e&&e.message)||e),'bad'));
  dev.on('tokenWillExpire',async()=>{const k=await tok();if(k.success)dev.updateToken(k.token)});
  setSt('Ready','ok');drawCtl()}
async function dial(){const l=Q[ix];if(!l||!dev||(state!=='idle'&&state!=='ended'))return;
  if(!inHours()){setSt('Outside calling hours','bad');return}
  try{const m=await navigator.mediaDevices.getUserMedia({audio:true});m.getTracks().forEach(t=>t.stop())}catch(_){setSt('Allow the microphone to call','bad');return}
  state='connecting';muted=false;sid='';t0=0;vmArm=null;el('after').hidden=true;drawCtl();setSt('Connecting...','warn');
  try{call=await dev.connect({params:{To:e164(l.phone),leadId:String(l.id)}})}catch(e){state='idle';setSt('Could not start the call','bad');drawCtl();return}
  call.on('ringing',()=>setSt('Ringing...','warn'));
  call.on('accept',()=>{state='live';t0=Date.now();sid=(call.parameters&&call.parameters.CallSid)||'';setSt('Connected','ok');gi=0;gPlay=null;gHot='';FACTS={goals:[]};COV={};SAID={};LH={};LH={};lastSaid=null;priceAt=0;depAsked=false;sigAt=0;gOpenPh='';drawScript();drawQ();coachStart(sid);clearInterval(tmr);tmr=setInterval(tick,500);drawCtl()});
  call.on('disconnect',()=>endCall());call.on('cancel',()=>endCall());call.on('reject',()=>endCall());
  call.on('error',e=>setSt('Call error: '+((e&&e.message)||e),'bad'))}
async function endCall(){if(state==='ended'||state==='idle')return;outSaved=false;outPick='';const l=Q[ix];made++;if(l)CALLED.add(l.id);if(l)setTimeout(()=>loadInfo(l.id,true),2500);clearInterval(tmr);const dur=t0?Math.round((Date.now()-t0)/1000):0;state='ended';call=null;t0=0;vmArm=null;setSt(dur?'Call ended':'Not connected',dur?'':'warn');
  el('after').hidden=false;el('am').textContent='';drawOuts();drawCtl();bannerDraw();
  if(l){l.tries24=(l.tries24||0)+1;try{await fetch('/admin/dialer/log',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lead_id:l.id,sid:sid,duration:dur})})}catch(_){}}}
async function vmDrop(k){const l=Q[ix];if(state!=='live'||!sid||!l)return;if(vmArm!==k){vmArm=k;drawCtl();setTimeout(()=>{if(vmArm===k){vmArm=null;drawCtl()}},3000);return}vmArm=null;
  const r=await fetch('/admin/dialer/vmdrop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sid:sid,kind:k,lead_id:l.id})});const j=await r.json().catch(()=>({}));setSt(j.success?'Voicemail dropped':(j.message||'Could not drop it'),j.success?'ok':'bad');drawCtl();if(j.success)saveOutcome('Left a voicemail')}
const LOSTR=${JSON.stringify(LOST_REASONS)};
const OUTG=[['Talked to them',[['Booked','Booked'],['Deposit pending','Deposit pending'],['Callback','Callback'],['Interested','Interested'],['Quote sent','Quote sent'],['Not interested','Not interested']]],['Did not reach them',[['Left a voicemail','Voicemail'],['No answer','No answer'],['Lead hung up','Lead hung up'],['Wrong number','Wrong number']]]];
const SN2={booked:'Deposit collected',deposit:'Deposit pending (follow up)',interested:'Interested (call back)',quoted:'Quote sent',lost:'NO',contacted:'Contacted'};
let outSaved=true,outPick='';
const dayPlus=n=>new Date(Date.now()+n*864e5).toLocaleDateString('en-CA',{timeZone:ET});
async function saveOutcome(o,date,why){const l=Q[ix];if(!l)return false;let j={};try{j=await (await fetch('/admin/outcome',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:l.id,outcome:o,follow_date:date||'',reason:why||''})})).json()}catch(_){}
  if(!j.success){el('am').textContent=j.message||'Could not save. Try again.';return false}
  outSaved=true;outPick=o;if(j.stage)l.stage=j.stage;const mv=j.stage&&SN2[j.stage]&&['booked','deposit','interested','quoted','lost'].includes(j.stage);
  el('am').textContent='Saved: '+(OUTG.flatMap(g=>g[1]).find(x=>x[0]===o)||[0,o])[1]+(mv?' (moved to '+SN2[j.stage]+')':'')+(date?' - '+date:'');drawOuts();fbPaint&&fbPaint();return true}
function drawOuts(){el('mt').hidden=true;
  el('outs').innerHTML=OUTG.map(g=>'<div class="og"><div class="ol">'+g[0]+'</div><div class="ob">'+g[1].map(o=>'<button class="btn'+(outPick===o[0]?' on':'')+'" type="button" data-o="'+$(o[0])+'">'+$(o[1])+'</button>').join('')+'</div></div>').join('')+'<div class="og" id="bkp" hidden><div class="ol">Booking details (needed to count it as booked)</div><div class="ob"><input type="datetime-local" id="bkat" style="width:auto;min-height:46px"><input type="number" id="bkv" placeholder="Price $" style="width:120px;min-height:46px"><button class="btn g" type="button" id="bkgo">Save booking</button></div></div><div class="og" id="nrp" hidden><div class="ol">Why not?</div><div class="ob">'+LOSTR.map(x=>'<button class="btn" type="button" data-r="'+$(x)+'">'+$(x)+'</button>').join('')+'</div></div>'+'<div class="og" id="cbd" hidden><div class="ol">Call back when?</div><div class="ob"><button class="btn" type="button" data-d="1">Tomorrow</button><button class="btn" type="button" data-d="2">In 2 days</button><button class="btn" type="button" data-d="7">Next week</button><input type="date" id="cbdate" style="width:auto;min-height:46px"><button class="btn g" type="button" id="cbgo">Save callback</button></div></div>';
  el('outs').querySelectorAll('[data-o]').forEach(b=>b.onclick=()=>{const o=b.dataset.o;el('cbd').hidden=o!=='Callback';el('bkp').hidden=o!=='Booked';el('nrp').hidden=o!=='Not interested';
    if(o==='Booked'){const l=Q[ix];if(l&&l.value&&!el('bkv').value)el('bkv').value=l.value;return}
    if(o==='Callback'||o==='Not interested')return;saveOutcome(o)});
  el('outs').querySelectorAll('[data-r]').forEach(b=>b.onclick=()=>saveOutcome('Not interested','',b.dataset.r));
  el('bkgo').onclick=async()=>{const l=Q[ix],at=el('bkat').value,v=parseInt(el('bkv').value||'0',10)||0;if(!l)return;if(!at||v<=0){el('am').textContent='Pick the appointment day and time and the price.';return}
    el('bkgo').disabled=true;let j={};try{j=await (await fetch('/admin/book',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:l.id,label:'Booked on the call',name:l.name||'',phone:l.phone||'',email:l.email||'',service:l.service||'',year:l.year||'',make:l.make||'',model:l.model||'',value:v,appt:at})})).json()}catch(_){}
    el('bkgo').disabled=false;if(!j.success){el('am').textContent=j.message||'Could not save the booking.';return}l.value=v;saveOutcome('Booked')};
  el('outs').querySelectorAll('[data-d]').forEach(b=>b.onclick=()=>saveOutcome('Callback',dayPlus(+b.dataset.d)));
  el('cbgo').onclick=()=>{const d=el('cbdate').value;if(d)saveOutcome('Callback',d)}}
el('ntb').onclick=async()=>{const l=Q[ix],t=el('nt').value.trim();if(!l||!t)return;await fetch('/admin/dialer/note',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:l.id,text:t})});el('nt').value='';el('am').textContent='Note saved.';loadInfo(l.id,true)};
el('mtb').onclick=()=>{const l=Q[ix];if(!l)return;el('mtx').value=fillT(ST.missed,l);el('mt').hidden=false;el('mtm').textContent=''};
el('mts').onclick=async()=>{const l=Q[ix],b=el('mtx').value.trim();if(!l||!b)return;el('mts').disabled=true;const r=await fetch('/admin/msg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:l.id,body:b})});const j=await r.json().catch(()=>({}));el('mts').disabled=false;el('mtm').textContent=j.success?'Text sent.':(j.message||'Could not send.');el('mtm').className=j.success?'note okm':'note'};
function next(){if(state==='live'||state==='connecting')return;outSaved=true;outPick='';state='idle';ix=Math.min(ix+1,Q.length);el('after').hidden=true;el('nt').value='';setSt(dev?'Ready':'Not set up',dev?'ok':'bad');drawLead();drawQ();bannerDraw();window.scrollTo({top:0})}
el('nxt').onclick=next;
function drawQF(){const b=el('qf');if(!b)return;b.innerHTML=QF.map(f=>{const on=f[0]===''?!QS.length:QS.indexOf(f[0])>=0,n=f[0]===''?'':(QC[f[0]]!=null?' ('+QC[f[0]]+')':'');return '<button type="button" data-f="'+f[0]+'" class="'+(on?'on':'')+'">'+f[1]+n+'</button>'}).join('')}
let OPEN_BY={tint:[],coating:[]};let WANT=+(new URLSearchParams(location.search).get('lead')||0)||0;
async function loadQ(){try{const q=await (await fetch('/admin/dialer/queue'+(QS.length?'?stages='+QS.join(','):'')+(WANT?(QS.length?'&':'?')+'lead='+WANT:''))).json();Q=q.leads||[];QC=q.counts||{};OPEN_BY={tint:((q.open||{}).tint||[]).map(d=>d.say),coating:((q.open||{}).coating||[]).map(d=>d.say)};if(WANT){WANT=0;try{history.replaceState(null,'','/admin/dialer')}catch(_){}}}catch(_){Q=[]}ix=0;Q.forEach(l=>known.add(l.id));state='idle';el('after').hidden=true;drawQF();drawLead();drawQ();drawScript()}
el('qf').addEventListener('click',e=>{const b=e.target.closest('[data-f]');if(!b||state==='live'||state==='connecting')return;const k=b.dataset.f;if(k==='')QS=[];else{const i=QS.indexOf(k);if(i>=0)QS.splice(i,1);else QS.push(k)}try{localStorage.setItem('dq',JSON.stringify(QS))}catch(_){}loadQ()});
const stLab=k=>(QF.find(f=>f[0]===k)||[0,k])[1]||'';
function drawQ(){const lab={idle:'Ready',connecting:'Calling',live:'In call',ended:'Wrap-up'};const nm=l=>$(l.name||pretty(l.phone));
  {const nx=Q[ix+1],left=Math.max(0,Q.length-ix-1),fr=Q.slice(ix+1).some(x=>x.fresh);el('nextline').innerHTML=nx?'Next: <b>'+$(shortN(nx.name)||pretty(nx.phone))+'</b> \\u00b7 '+svcLab(nx)+' \\u00b7 '+left+' waiting'+(fr?' <span class="pill ok nb">New lead</span>':''):'Last lead in the queue'}
  el('rs').innerHTML='<span><b>'+Math.max(0,Q.length-ix)+'</b> in queue</span><span><b>'+made+'</b> called</span>';
  el('q').innerHTML=Q.map((l,i)=>i<ix?(CALLED.has(l.id)?'<div class="it done"><span class="av">\u2713</span><span class="tx"><b>'+nm(l)+'</b><small>Called</small></span></div>':'<button class="it" data-i="'+i+'" type="button"><span class="av">'+$(initials(l.name))+'</span><span class="tx"><b>'+nm(l)+'</b><small>Skipped, not called. Tap to call</small></span><span class="bd">Skipped</span></button>'):'<button class="it'+(i===ix?' cur':'')+(l.fresh&&i!==ix?' fresh':'')+'" data-i="'+i+'" type="button"><span class="av">'+$(initials(l.name))+'</span><span class="tx"><b>'+(l.fresh?'<span class="chip new">NEW</span> ':'')+nm(l)+'</b><small>'+$([l.service,[l.year,l.make,l.model].filter(Boolean).join(' ')].filter(Boolean).join(' \u00b7 '))+' \u00b7 '+(QS.length?stLab(l.stage)+' \u00b7 '+(l.last_try?'last tried '+ago(l.last_try):'never called'):ago(l.created_at))+(l.tries24?' \u00b7 '+l.tries24+' tries':'')+'</small></span>'+(i===ix?'<span class="bd'+(state==='live'?' live':'')+'">'+lab[state]+'</span>':'<span class="bd">Waiting</span>')+'</button>').join('')||'<p class="note">Nothing queued.</p>'}
el('q').addEventListener('click',e=>{const b=e.target.closest('[data-i]');if(!b||state==='live'||state==='connecting')return;ix=+b.dataset.i;state='idle';el('after').hidden=true;drawLead();drawQ()});
el('stabs').addEventListener('click',e=>{const b=e.target.closest('[data-k]');if(b){sk=b.dataset.k;drawScript()}});
// ---- guided scripts: private, owner-only, loaded from the database (never part of the page source) ----
let GS={},OF={},OVR={},FACTS={goals:[]},gi=0,gPlay=null,gLead=0,gHot='',gHotAt=0;
const OFD={shop:'Divine Detailers',address:'5181 NW 74th Ave, Miami, FL 33166',area:'Miami',rep:'Bronson'};
const LBL={dep:'deposit',price:'price',reg:'normal price',yrs:'warranty years',special:'special name',days:'days left',otd:'out the door',floor:'lowest price',pkg:'windows'};
const SHORT={'p-expensive':'Too expensive','p-wife':'Wife','p-think':'Think about it','p-text':'Text me','p-schedule':'Schedule','p-calendar':'Calendar','p-shop':'Shopping around','p-catch':'The catch','a-price':'How much?','a-location':'Location','a-booked':'Booked elsewhere','a-scratch':'Scratches','a-wax':'I wax it','followup':'Follow up'};
function gsvc(l){const s=String(l&&l.service||'');if(/tint/i.test(s))return 'tint';if(/coat|ceramic|correct|polish|detail/i.test(s))return 'coating';return ''}
async function gLoad(svc){if(!svc||GS[svc]!==undefined)return;GS[svc]=null;try{const j=await (await fetch('/admin/dialer/script?svc='+svc)).json();GS[svc]=j&&j.script?j.script:false}catch(_){GS[svc]=false}}
let OFKD='';
async function loadOffer(){try{const j=await (await fetch('/admin/dialer/offer')).json();if(j&&j.success){OF=j.offer||{};OFKD=j.knowledge_default||''}}catch(_){}}
const mny=n=>'$'+Number(n).toLocaleString('en-US');
const numOf=s=>Number(String(s).replace(/[^0-9.]/g,''))||0;
const firstOf=l=>{const f=String(l&&l.name||'').trim().split(/\\s+/)[0];return f&&!/^\\+?[\\d\\s()-]+$/.test(f)?f:''};
const vehOf=l=>[l&&l.year,l&&l.make,l&&l.model].filter(Boolean).join(' ');
function ofv(k){return OF[k]!==undefined&&OF[k]!==''?OF[k]:OFD[k]}
function vv(name,l,svc){
  switch(name){
    case 'rep':return ofv('rep')||'';case 'shop':return ofv('shop')||'';case 'address':return ofv('address')||'';case 'area':return ofv('area')||'';
    case 'special':return OF.special||'';
    case 'price':{const v=l&&l.value>0?l.value:numOf(svc==='coating'?OF.coatPrice:(OF.tintPrice||299));return v>0?mny(Math.round(v)):''}
    case 'reg':return numOf(OF.coatReg)>0?mny(numOf(OF.coatReg)):'';
    case 'dep':{const d=numOf(svc==='coating'?OF.coatDeposit:OF.tintDeposit)||50;return d>0?mny(d):''}
    case 'otd':{const p=vv('price',l,svc),d=vv('dep',l,svc);return p&&d?mny(Math.max(0,numOf(p)-numOf(d))):''}
    case 'yrs':return String(numOf(OF.coatYears)||5);
    case 'floor':return mny(numOf(OF.tintFloor)||274);
    case 'days':{if(!OF.specialEnd)return '';const e=new Date(OF.specialEnd+'T00:00:00'),t=new Date();t.setHours(0,0,0,0);const d=Math.round((e-t)/864e5);return d>=0?String(d):''}
  }return ''}
// what the coach has picked up from the conversation, in the rep's own words from the script examples
const GOALT={heat:['keeping the car cool','block out the majority of the heat & keep your car cool'],look:['the privacy & the look','give you the privacy & the look you are going for'],uv:['protecting your skin & interior from the sun','block the UV to protect your skin & your interior'],
  restore:['it has swirls in the paint & you want it looking new again','take those swirls out & give it a deep glossy finish, then the coating locks that in & makes washing super easy'],
  protect:['you want to keep it looking new & protected','keep that paint looking new & protected from the sun, & dirt & water slide right off so washing takes no time'],
  wash:['you want washing to be easier','make washing super easy, because dirt & water slide right off']};
const joinAnd=a=>a.length<2?(a[0]||''):a.slice(0,-1).join(', ')+' & '+a[a.length-1];
function sv(slot,l,svc){
  if(OVR[slot])return OVR[slot];
  const g=FACTS.goals||[];
  switch(slot){
    case 'NAME':return firstOf(l);
    case 'YEAR MAKE MODEL':case 'YEAR MAKE & MODEL':return vehOf(l);
    case 'AREA':return ofv('area')||'';
    case 'WINDOWS':return FACTS.windows||'';case 'SHADE':return FACTS.shade||'';case 'TIMEFRAME':return FACTS.time||'';case 'COLOR':return FACTS.color||'';
    case 'GOAL':case 'PROBLEM':if(FACTS.ai&&FACTS.ai.problem)return FACTS.ai.problem;return g.length?joinAnd(g.map(x=>GOALT[x][0])):'';
    case 'SOLVE THEIR PROBLEM':{if(FACTS.ai&&FACTS.ai.solve)return FACTS.ai.solve;const u=g.filter(x=>!(x==='wash'&&g.indexOf('restore')>=0));return u.length?joinAnd(u.map(x=>GOALT[x][1])):''}
  }return ''}
function setAiFacts(m){const n={problem:String(m.problem||''),solve:String(m.solve||'')};const o=FACTS.ai||{};if(n.problem===(o.problem||'')&&n.solve===(o.solve||''))return;FACTS.ai=n;if(m.color&&!FACTS.color)FACTS.color=String(m.color);if(gScript()&&Q[ix])gFull()}
function gAnalyze(who,text){
  if(who!=='lead')return;const t=String(text||'').toLowerCase(),F=FACTS,sv0=gsvc(Q[ix]),ok=g=>sv0==='coating'?/restore|protect|wash/.test(g):/heat|look|uv/.test(g),add=g=>{if(ok(g)&&F.goals.indexOf(g)<0&&F.goals.length<2)F.goals.push(g)};
  if(/\\b(hot|heat|cool|sweat|a\\/?c|air condition|burn|baking|boiling)\\b/.test(t))add('heat');
  if(/\\b(privacy|private|look|sleek|slick|style|stylish|dark(er)?)\\b/.test(t))add('look');
  if(/\\b(uv|sunburn|skin|fad(e|ing)|cracking)\\b/.test(t))add('uv');
  if(/(swirl|scratch|dull|oxidi|restore|new again|shine|shiny|gloss|polish|buff)/.test(t))add('restore');
  if(/(protect|brand new|new car|just bought|just got|keep it new|bird|sap|rain)/.test(t))add('protect');
  if(/(easier to wash|easy to wash|wash it|washing|maintenance|clean it)/.test(t))add('wash');
  const NW={five:5,ten:10,fifteen:15,twenty:20,thirty:30,'thirty five':35,'thirty-five':35,thirtyfive:35,forty:40,fifty:50,seventy:70,'seventy five':75,ninety:90};let m=t.match(/(\\d{1,2})\\s?(%|percent)/);if(m)F.shade=m[1]+'%';else{m=t.match(/\\b(thirty[ -]?five|seventy[ -]?five|five|ten|fifteen|twenty|thirty|forty|fifty|seventy|ninety)\\s?(%|percent)/);if(m)F.shade=NW[m[1].replace(/[ -]/g,' ').replace('thirty five','thirty five')]+'%'}
  m=t.match(/(sides? (and|&) (the )?(back|rear)|whole car|all (the )?windows|windshield|front (two |2 )?windows|just the front)/);if(m)F.windows=m[1].replace(/\\band\\b/,'&');
  m=gi>=5?t.match(/\\b(asap|right away|today|tomorrow|this week|next week|this weekend|the weekend|couple (of )?weeks?|few days)\\b/):null;if(m)F.time=m[1];
  m=t.match(/\\b(black|white|silver|gr[ae]y|red|blue|green|gold|orange|yellow|brown|maroon|burgundy|beige|tan|charcoal|pearl)\\b/);if(m)F.color=m[1];
  const sig=JSON.stringify(F);if(sig!==gSig){gSig=sig;gSoon()}gMark(false)}
let gSig='';
const gScript=()=>{const l=Q[ix],s=l&&gsvc(l),sc=s&&GS[s];if(!sc)return null;const sk=String((s==='coating'?OF.coatSkip:OF.tintSkip)||'').split(/[\\s,]+/).filter(Boolean);if(!sk.length)return sc;const key=s+sk.join();if(sc._k!==key){sc._f=Object.assign({},sc,{steps:sc.steps.filter(x=>sk.indexOf(x.id)<0)});sc._k=key}return sc._f};
let gT=0,gUserAt=0;function gSoon(){clearTimeout(gT);gT=setTimeout(()=>{const a=document.activeElement;if(a&&a.classList&&a.classList.contains('phin'))return;if(!el('script').hidden)gFull()},250)}
function gFull(){const r=el('rcol'),top=r?r.scrollTop:0,wy=window.scrollY;drawScript();if(r)r.scrollTop=top;window.scrollTo(0,wy)}
['wheel','touchmove'].forEach(ev=>document.addEventListener(ev,()=>{gUserAt=Date.now()},{passive:true}));
// light update: current step, covered ticks, pulsing pushback chip. Scrolls to the current step unless you scrolled yourself in the last few seconds
function gScrollTo(e){if(!e)return;const r=el('rcol'),bar=document.querySelector('#script .gbar'),bh=(bar?bar.offsetHeight:0)+6,t=e.getBoundingClientRect();
  if(r&&getComputedStyle(r).overflowY==='auto'&&r.scrollHeight>r.clientHeight+2)r.scrollTo({top:r.scrollTop+t.top-r.getBoundingClientRect().top-bh,behavior:'smooth'});
  else window.scrollTo({top:window.scrollY+t.top-bh,behavior:'smooth'})}
function gMark(scroll){if(gScript()&&Q[ix])gCov();gNext();const sc=gScript();if(!sc||el('script').hidden)return;
  sc.steps.forEach((s,i)=>{const e=document.getElementById('gs-'+s.id);if(!e)return;e.classList.toggle('cur',i===gi);e.classList.toggle('done',!!COV[s.id])});
  document.querySelectorAll('#script .gobjs button').forEach(b=>b.classList.toggle('hot',b.dataset.p===gHot&&Date.now()-gHotAt<45000));
  const ph=sc.steps[gi]&&sc.steps[gi].phase;document.querySelectorAll('#script .gline [data-a]').forEach(b=>b.classList.toggle('here',b.dataset.a==='gp-'+ph));
  /* the script on the right never scrolls by itself: only the coach box follows the call. Tapping Open or a step chip still jumps to it. */}
// objections the lead just raised light up their playbook
const OBJRX=[['p-expensive',/(too (much|expensive)|expensive|that.?s a lot|can.?t afford|too pricey)/],['p-wife',/(my wife|my husband|my girlfriend|talk to my)/],['p-think',/(think about it|let me think|need to think)/],['p-text',/(text (it|me)|send (it|me)|email (it|me))/],['p-calendar',/(my (calendar|schedule)|check my|i.?m driving)/],['p-shop',/(shopping around|other (quotes|shops)|more quotes|compar)/],['p-catch',/(what.?s the catch|too good|why so cheap)/],['a-price',/(how much|what.?s the price|price)/],['a-location',/(where are you|too far|how far|located)/],['a-booked',/(already (booked|got|did|have)|someone else)/],['a-scratch',/(scratch proof|stop scratch|rock chip)/],['a-wax',/(i wax|waxing|i just wax)/]];
function gObjHint(text){const sc=gScript();if(!sc)return;const t=String(text||'').toLowerCase();for(const [id,rx] of OBJRX){if(rx.test(t)&&sc.plays.some(p=>p.id===id||(id==='p-expensive'&&p.id==='p-shop'))){gHot=sc.plays.some(p=>p.id===id)?id:'p-shop';gHotAt=Date.now();gMark(false);return}}}
// follow the rep: when what they just said matches the next step, move to it
const words=s=>String(s||'').toLowerCase().replace(/[^a-z0-9 ']/g,' ').split(/\\s+/).filter(w=>w.length>3);
function gLines(sc,l,svc){const out=[];sc.steps.forEach((s,si)=>{if(!s.n)return;(s.main||[]).forEach(n=>{if(n.k!=='say')return;(n.ps||[]).forEach((p,pi)=>{if(p.t&&!p.note&&!/^if\\b/i.test(p.sub||''))out.push({si:si,sid:s.id,k:s.id+'.'+out.length,t:gplain(p.t,l,svc)})})})});return out}
function gFollow(text){const sc=gScript(),l=Q[ix];if(!sc||!l)return;brFollow(text);const w=words(text);if(w.length<1)return;const svc=gsvc(l),L=gLines(sc,l,svc);let best=-1,bs=0;
  L.forEach((x,j)=>{const set=new Set(words(x.t));if(!set.size)return;const hs=w.filter(y=>set.has(y)),hit=hs.length,need=set.size===1?1:set.size<=3?2:3;if(set.size===1&&w.length>4)return;if(hit<need||hit/Math.max(w.length,2)<0.5)return;
    // words only add up across a sentence split by pauses (15 seconds), and a line more than one step ahead needs nearly all its words in a single breath, so common words said over a long call never add up to a skipped step
    const nowT=Date.now();let en=LH[x.k];if(!en||!en.s||nowT-en.t>15000)en=LH[x.k]={s:new Set(),t:nowT};en.t=nowT;const far=x.si>gi+1,acc=far?new Set():en.s;hs.forEach(y=>acc.add(y));const r=acc.size/set.size;if(r>=(set.size<=3?1:far?0.9:0.7)&&r>bs){bs=r;best=j}});
  if(best>=0){const m=L[best];lastSaid={k:m.k,sid:m.sid,t:m.t,at:Date.now()};L.forEach((x,j)=>{if(x.si===m.si&&j<=best)SAID[x.k]=1});if(L.filter(x=>x.si===m.si).every(x=>SAID[x.k]))COV[m.sid]=1;const mv=m.si!==gi;if(mv)gi=m.si;gMark(mv)}}
// the line the rep should say next: the first line, at or after the current step, that has not been said or already covered by what the lead told us
// follow-ups under a question ("If yes, swirls..." / "If no..."): once the lead answers yes or no, the lines for that answer come next, before the script moves on
let BR={};
const brPol=c=>{const t=String(c||'').toLowerCase().replace(/^\\s*if\\s+/,'').trim();return /^(no|nope|none|not|never|brand new|haven)/.test(t)?'no':/^(yes|yeah|yep|sure|they say yes|they have|they do)/.test(t)?'yes':null};
function brOpts(s,l,svc){const out=[];(s.main||[]).forEach(n=>{if(n.k!=='outcomes')return;(n.opts||[]).forEach(o=>{const pol=brPol(o.cond);if(!pol)return;const lines=[];(o.nodes||[]).forEach(x=>{if(x.k!=='say')return;(x.ps||[]).forEach(p=>{if(p.t&&!p.note)lines.push(gplain(p.t,l,svc))})});if(lines.length)out.push({pol:pol,cond:gplain(o.cond,l,svc),lines:lines})})});return out}
function brPick(text){const sc=gScript(),l=Q[ix];if(!sc||!l||!lastSaid||Date.now()-lastSaid.at>90000)return;const s=sc.steps[gi];if(!s||s.id!==lastSaid.sid||BR[s.id])return;
  const t=String(text||'').toLowerCase(),no=/\\b(no|nope|nah|not really|none|never|haven't|don't|doesn't|brand new)\\b/.test(t),yes=/\\b(yes|yeah|yep|yup|sure|a little|a bit|some|kind of|sort of|definitely|absolutely|correct|i do|we do)\\b/.test(t);
  const pol=no&&!yes?'no':yes&&!no?'yes':(yes&&no?(/^\\s*(no|nope|nah)\\b/.test(t)?'no':'yes'):null);if(!pol)return;
  const o=brOpts(s,l,gsvc(l)).find(x=>x.pol===pol);if(o){BR[s.id]={si:gi,sid:s.id,cond:o.cond,lines:o.lines,said:{}};gMark(false)}}
function brNext(){const sc=gScript();if(!sc)return null;const s=sc.steps[gi],b=s&&BR[s.id];if(!b)return null;const i=b.lines.findIndex((x,j)=>!b.said[j]);return i<0?null:{si:b.si,sid:b.sid,k:b.sid+'.b'+i,t:b.lines[i],branch:true,sub:b.cond,bi:i}}
function brFollow(text){const sc=gScript();if(!sc)return;const s=sc.steps[gi],b=s&&BR[s.id];if(!b)return;const w=words(text);if(w.length<1)return;
  b.lines.forEach((ln,j)=>{if(b.said[j])return;const set=new Set(words(ln));if(!set.size)return;const hit=w.filter(y=>set.has(y)).length,need=set.size<=3?2:3;if(hit>=need&&hit/Math.max(w.length,2)>=0.5){const k=b.sid+'.b'+j;const acc=LH[k]||(LH[k]=new Set());w.filter(y=>set.has(y)).forEach(y=>acc.add(y));if(acc.size/set.size>=(set.size<=3?1:0.7)){for(let q=0;q<=j;q++)b.said[q]=1;gMark(false)}}})}
function gNextLine(){const sc=gScript(),l=Q[ix];if(!sc||!l)return null;const bn=brNext();if(bn)return bn;const svc=gsvc(l),L=gLines(sc,l,svc),open=L.filter(x=>!SAID[x.k]&&!COV[x.sid]);if(!open.length)return{done:true};return open.find(x=>x.si>=gi)||open[0]}
function sendPos(nl){const t=nl&&nl.t?nl.t:'';if(t===lastPos||!cws||cws.readyState!==1)return;lastPos=t;try{const sc=gScript(),s=nl&&sc?sc.steps[nl.si]:null;cws.send(JSON.stringify({type:'pos',next:t,step:s?s.n+' '+topicOf(gsvc(Q[ix]),s):''}))}catch(_){}}
const TOPIC={tint:{s01:'Name check',s02:'Intro',s03:'Rapport',s04:'Why calling',s05:'Set the frame',s06:'Vehicle',s07:'Windows',s08:'Current tint',s09:'Main goal',s10:'Darkness',s11:'Other shops',s12:'Recap',s13:'Process',s14:'Questions',s15:'Why us',s16:'Questions',s17:'Timing',s18:'Price',s19:'Book the day',s20:'Contact info',s21:'Deposit',s22:'Referral',s23:'Wrap up'},
 coating:{s01:'Name check',s02:'Intro',s03:'Rapport',s04:'Why calling',s05:'Set the frame',s06:'Vehicle & color',s07:'Paint condition',s08:'What they know',s09:'Storage & washing',s10:'How long keeping',s11:'Past coatings',s12:'Recap',s13:'The prep',s14:'Questions',s15:'The coating',s16:'Questions',s17:'Free add ons',s18:'Timing',s19:'Price',s20:'Book the day',s21:'Contact info',s22:'Deposit',s23:'Wrap up'}};
let COV={},gOpenPh='',SAID={},LH={},lastPos='',lastSaid=null,priceAt=0,depAsked=false,sigAt=0;
const topicOf=(svc,s)=>(TOPIC[svc]&&TOPIC[svc][s.id])||s.tag||s.id;
function gCov(m){m=m||COV;const l=Q[ix],svc=gsvc(l),F=FACTS;if(!svc)return; // the vehicle step is never skipped because the CRM already has the car: it is the confirmation line, so it must be said
  if(svc==='tint'){if(F.windows)m.s07=1;if(F.goals.length)m.s09=1;if(F.shade)m.s10=1;if(F.time)m.s17=1}
  else{if(F.goals.length)m.s07=1;if(F.time)m.s18=1}}
function gSugIdx(sc){return sc.steps.findIndex(s=>s.n&&!COV[s.id])}
function gMap(sc,svc){const sug=gSugIdx(sc),cur=sc.steps[gi],show=gOpenPh||(cur&&cur.phase)||sc.phases[0].id;
  const inPh=id=>sc.steps.filter(s=>s.phase===id&&s.n);
  return '<div class="gmap"><div class="gph">'+sc.phases.map(ph=>{const L=inPh(ph.id),all=L.length&&L.every(s=>COV[s.id]);return '<button type="button" data-ph="'+$(ph.id)+'" class="gpb'+(ph.id===show?' on':'')+(all?' done':'')+((cur&&cur.phase===ph.id&&!gPlay)?' here':'')+'">'+$(ph.name)+'</button>'}).join('')+'</div>'
   +'<div class="gph">'+sc.steps.map((s,i)=>s.phase===show&&s.n?'<button type="button" data-s="'+i+'" class="gt2'+(!gPlay&&i===gi?' on':'')+(COV[s.id]?' done':'')+(i===sug?' sug':'')+'"><b>'+$(s.n)+'</b>'+$(topicOf(svc,s))+'</button>':'').join('')+'</div></div>'}
const swp=t=>{let s=String(t||'');(OF.swaps||[]).forEach(p=>{if(p&&p.f)s=s.split(p.f).join(p.t||'')});return s};
function gfmt(t,l,svc){let h=$(swp(t));
  h=h.replace(/\\{(\\w+)\\}/g,(m,n)=>{const k='{'+n+'}',v=OVR[k]||vv(n,l,svc);return v?'<span class="ph ok" data-e="'+k+'">'+$(v)+'</span>':'<span class="ph un" data-e="'+k+'">'+$('['+(LBL[n]||n)+']')+'</span>'});
  let di=0;const od=OPEN_BY[svc]||[];h=h.replace(/\\[\\[([^\\]]+)\\]\\]/g,(m,n0)=>{const n=n0.replace(/&amp;/g,'&'),v=n==='DATE'?(od[di++]||''):sv(n,l,svc);return v?'<span class="ph ok" data-e="'+$(n)+'">'+$(v)+'</span>':'<span class="ph un" data-e="'+$(n)+'">'+$(n.toLowerCase())+'</span>'});
  return h}
function gplain(t,l,svc){let di=0;const od=OPEN_BY[svc]||[];return swp(t).replace(/\\{(\\w+)\\}/g,(m,n)=>OVR['{'+n+'}']||vv(n,l,svc)||'...').replace(/\\[\\[([^\\]]+)\\]\\]/g,(m,n)=>(n==='DATE'?(od[di++]||''):sv(n,l,svc))||'...')}
function gnode(n,l,svc){const f=t=>gfmt(t,l,svc);
  if(n.k==='pill')return '';
  if(n.k==='cond')return '<div class="gcond"><b>If</b> '+f(n.t)+'</div>';
  if(n.k==='ret')return '<button class="gjump" data-j="'+$(n.to)+'" type="button">'+$(n.t)+'</button>';
  if(n.k==='outcomes')return '<div class="gout">'+n.opts.map(o=>'<div class="gopt">'+(o.cond?'<div class="gcond"><b>If</b> '+f(o.cond)+'</div>':'')+o.nodes.map(x=>gnode(x,l,svc)).join('')+'</div>').join('')+'</div>';
  let h='<div class="gn '+$(n.k||'say')+'">'+(n.tag?'<div class="gt">'+$(n.tag)+'</div>':'');
  (n.ps||[]).forEach(p=>{h+=p.note?'<p class="gnote"><b>Coach</b> '+f(p.note)+'</p>':'<p>'+(p.sub?'<span class="gsub">'+$(p.sub)+'</span>':'')+f(p.t)+'</p>'});
  if(n.list)h+='<ol class="glist">'+n.list.map(i=>'<li><b>'+$(i.h)+'</b> '+f(i.t)+'</li>').join('')+'</ol>';
  if(n.chips)h+='<div class="gchips">'+n.chips.map(c=>'<span>'+$(c)+'</span>').join('')+'</div>';
  if(n.addr)h+='<p class="gaddr">'+$(vv('address',l,svc))+'</p>';
  if(n.links)h+='<div class="glinks">'+n.links.map(k=>'<button class="gjump '+$(k.c||'')+'" data-j="'+$(k.to)+'" type="button">'+$(k.t)+'</button>').join('')+'</div>';
  return h+'</div>'}
function gSide(side,l,svc){if(!side||!side.length)return '';const first=side.find(x=>x.k==='obj'),lab=first&&first.ps&&first.ps[0]?first.ps[0].t:'';
  return '<details class="gside"><summary>If they say'+(lab?': '+$(lab):'...')+'</summary>'+side.map(x=>gnode(x,l,svc)).join('')+'</details>'}
function gStepHtml(s,l,svc){let m=s.main;
  // the lead form already gave us the vehicle, so confirm it instead of asking
  if(s.id==='s06'&&vehOf(l)){m=JSON.parse(JSON.stringify(s.main));const p=m[0]&&m[0].ps&&m[0].ps[0];if(p){p.t=svc==='coating'?'Fantastic, just to confirm, I have you down for a [[YEAR MAKE MODEL]], is that right? ... & what color is the paint?':'Fantastic, just to confirm, I have you down for a [[YEAR MAKE MODEL]], is that right?'}}
  return m.map(x=>gnode(x,l,svc)).join('')+gSide(s.side,l,svc)+(s.examples&&s.examples.length?'<details class="gside gex"><summary>Examples of how it sounds (do not read)</summary>'+s.examples.map(x=>gnode(x,l,svc)).join('')+'</details>':'')}
function gRender(){const sc=gScript(),l=Q[ix];if(!sc||!l)return false;const svc=gsvc(l);gCov();
  const pushes=sc.plays.filter(p=>p.id!=='followup');
  let h='<div class="gs"><div class="gbar"><div class="gline">'+sc.phases.map(p=>'<button type="button" data-a="gp-'+$(p.id)+'" class="gpb">'+$(p.name)+'</button>').join('')+'<button type="button" data-a="gp-push" class="gpb red">Pushback</button><button type="button" data-a="gp-follow" class="gpb">Follow up</button><button type="button" data-a="now" class="gpb now">&#9679; Now</button></div>'
   +'<div class="gobjs">'+pushes.map(p=>'<button type="button" data-p="'+$(p.id)+'" class="'+(gHot===p.id&&Date.now()-gHotAt<45000?'hot':'')+'">'+$(SHORT[p.id]||p.title.replace(/[“”"]/g,''))+'</button>').join('')+'</div></div>';
  let lastPh='';
  sc.steps.forEach((st,i)=>{if(st.phase&&st.phase!==lastPh){lastPh=st.phase;const ph=sc.phases.find(x=>x.id===st.phase);h+='<h4 class="gsh" id="gp-'+$(st.phase)+'">'+$(ph?ph.name:'')+'</h4>'}
    h+='<section class="gstep'+(i===gi?' cur':'')+(COV[st.id]?' done':'')+'" id="gs-'+$(st.id)+'" data-i="'+i+'"><div class="ghd"><b>'+(st.n?$(st.n)+' &middot; '+$(topicOf(svc,st)):'Coach')+'</b><span class="gck">&#10003; covered</span></div>'+gStepHtml(st,l,svc)+'</section>'});
  let grp='',first=true;
  sc.plays.forEach(p=>{if(p.group!==grp){grp=p.group;const id=p.id==='followup'?'gp-follow':(first?'gp-push':'');if(p.id!=='followup')first=false;h+='<h4 class="gsh"'+(id?' id="'+id+'"':'')+'>'+$(p.id==='followup'?'Follow up':'Pushback &middot; '+p.group)+'</h4>'}
    h+='<section class="gstep gplay" id="gx-'+$(p.id)+'"><div class="ghd"><b>'+$(p.title)+'</b><button type="button" class="gback" data-a="now">Back to step</button></div>'+p.nodes.map(x=>gnode(x,l,svc)).join('')+'</section>'});
  el('script').innerHTML=h+'</div>';gNext();return true}
const gGo=id=>{const e=document.getElementById(id);if(e){gUserAt=Date.now();gScrollTo(e)}};
function gJump(to){const sc=gScript();if(!sc)return;if(sc.plays.some(x=>x.id===to)){gGo('gx-'+to);return}const i=sc.steps.findIndex(x=>x.id===to);if(i>=0){gi=i;gMark(false);gGo('gs-'+to)}}
// script panel click handling
el('script').addEventListener('click',e=>{const t=e.target.closest('button,.ph');const sc=gScript();
  if(!t){const st=e.target.closest('.gstep:not(.gplay)');if(st&&sc&&!e.target.closest('summary')){gi=Number(st.dataset.i);gMark(false)}return}
  if(t.classList.contains('ph')&&t.dataset.e){const k=t.dataset.e,cur=t.classList.contains('ok')?t.textContent:'';const inp=document.createElement('input');inp.className='phin';inp.value=cur;inp.placeholder=t.textContent;t.replaceWith(inp);inp.focus();inp.select();const done=()=>{const v=inp.value.trim();if(v)OVR[k]=v;else delete OVR[k];gFull()};inp.onkeydown=ev=>{if(ev.key==='Enter')done();if(ev.key==='Escape'){inp.value=cur;done()}};inp.onblur=done;return}
  if(!sc)return;
  if(t.dataset.a==='now'){const c=sc.steps[gi];if(c)gGo('gs-'+c.id);return}
  if(t.dataset.a){gGo(t.dataset.a);return}
  if(t.dataset.p){gHot='';gMark(false);gGo('gx-'+t.dataset.p);return}
  if(t.dataset.j){gJump(t.dataset.j)}});
function briefLines(l){const svc=gsvc(l),sc=svc&&GS[svc];if(!sc)return null;
  const say=s=>{const p=s&&s.main&&s.main[0]&&s.main[0].ps&&s.main[0].ps.find(x=>x.t);return p?gplain(p.t,l,svc):''};
  const byId=id=>sc.steps.find(s=>s.id===id),price=sc.steps.find(s=>/price/i.test(s.tag||''));
  return{open:say(byId('s02')),ask:say(byId(vehOf(l)?'s07':'s06')),offer:say(price)}}
// owner-only setup: import the scripts, set the offer numbers, swap words
async function gSetup(){await loadOffer();const d=el('gdlg'),o=OF,st=k=>GS[k]?'Imported ('+GS[k].steps.length+' steps)':'Not imported yet';
  await Promise.all([gLoad('tint'),gLoad('coating')]);
  const fld=(id,lab,val,type,ph)=>'<div><label>'+lab+'</label><input id="'+id+'" type="'+(type||'text')+'" value="'+$(val==null?'':val)+'" placeholder="'+$(ph||'')+'" style="width:100%;background:#12171e;border:1px solid #2a313a;color:#fff;border-radius:10px;padding:9px 11px;font:inherit;font-size:15px;color-scheme:dark"></div>';
  d.innerHTML='<div class="rb"><h3>Guided scripts</h3><p class="note" style="margin:0">Only you can see these. They are saved in your private database.</p>'
   +'<div class="vm"><b>Paste your scripts</b><span class="note">Tint: <span id="gst-tint">'+st('tint')+'</span> &middot; Coating: <span id="gst-coating">'+st('coating')+'</span></span><textarea id="g-paste" rows="3" placeholder="Paste here"></textarea><div class="bar"><button class="btn g" id="g-pb" type="button">Import pasted scripts</button><span class="note" id="g-pm"></span></div></div>'
   +'<details class="gdet"><summary>Import from a file instead</summary>'+['tint','coating'].map(k=>'<div class="vm"><b>'+(k==='tint'?'Ceramic tint script':'Ceramic coating script')+'</b><input type="file" accept=".json,application/json" data-imp="'+k+'" class="note"></div>').join('')+'</details>'
   +'<p class="note" style="margin:0">That is all you need. Everything below is optional.</p>'
   +'<details class="gdet"><summary>Shop details (already filled in)</summary><div class="gform">'+fld('o-rep','Your name',o.rep,'text',OFD.rep)+fld('o-shop','Shop name',o.shop,'text',OFD.shop)+fld('o-addr','Address',o.address,'text',OFD.address)+fld('o-area','Area',o.area,'text',OFD.area)+'</div></details>'
   +'<details class="gdet"><summary>Offer numbers (optional)</summary><p class="note" style="margin:0 0 8px">Anything left empty shows up in the script as an amber [blank] you can fill in during the call. The lead job value is used as the price when it has one.</p><div class="gform">'
   +fld('o-sp','Special name',o.special,'text','e.g. Spring')+fld('o-end','Special ends',o.specialEnd,'date')+fld('o-tp','Tint price (if the lead has none)',o.tintPrice,'number')+fld('o-td','Tint deposit',o.tintDeposit,'number')+fld('o-tf','Tint lowest price',o.tintFloor,'number')
   +fld('o-cp','Coating special price',o.coatPrice,'number')+fld('o-cr','Coating normal price',o.coatReg,'number')+fld('o-cd','Coating deposit',o.coatDeposit,'number')+fld('o-cy','Coating warranty (years)',o.coatYears,'number')+'</div></details>'
   +'<details class="gdet"><summary>Shop facts and skipped steps</summary><p class="note" style="margin:0 0 8px">Facts the coach is allowed to state: film, times, deposit, legal limits, plain-English words for new reps. Edit anything that is wrong. Whatever is not here, in the script or in your offer, the coach will not state.</p><div class="gform">'+fld('o-ts','Tint steps to skip (for example s17)',o.tintSkip,'text','')+fld('o-cs','Coating steps to skip (for example s17)',o.coatSkip,'text','')+'</div><textarea id="o-kn" rows="14" style="width:100%">'+$(o.knowledge||OFKD||'')+'</textarea><div class="bar"><button class="btn sm" id="o-kr" type="button">Use the built-in facts again</button></div></details>'
   +'<details class="gdet"><summary>Transcription fixes (optional)</summary><div><label>Words the phone line mishears (one per line: heard => meant), for example: "tent => tint". Common ones are already built in.</label><textarea id="o-fx" rows="4" placeholder="heard => meant">'+$((o.fixes||[]).map(p=>p.f+' => '+p.t).join('\\n'))+'</textarea></div><div><label>Extra words the transcriber should listen for (one per line): car models, names, anything it keeps missing</label><textarea id="o-tm" rows="3">'+$((o.terms||[]).join('\\n'))+'</textarea></div></details>'
   +'<details class="gdet"><summary>Word swaps (optional)</summary><div><label>Word swaps (one per line: find => replace). Use this to change brand names, warranty wording or anything else in the script.</label><textarea id="o-sw" rows="5" placeholder="old word => new word">'+$((o.swaps||[]).map(p=>p.f+' => '+p.t).join('\\n'))+'</textarea></div></details>'
   +'<div class="vm"><b>AI coach</b><span class="note" id="ai-st">Checks that the Anthropic key you added in Cloudflare works.</span><div class="bar"><button class="btn sm" id="ai-t" type="button">Test AI coach</button></div></div>'
   +'<div class="vm"><b>Call library</b><span class="note" id="lib-st">Checking...</span><span class="note">Load response_library.jsonl from your analyzed calls. The AI coach then looks up how your best closers handled the same moment.</span><input type="file" accept=".jsonl,.json,.txt" id="lib-f" class="note"><div class="bar"><button class="btn sm" id="lib-c" type="button">Clear library</button></div></div>'
   +'<div class="err" id="ge"></div><div class="bar" style="justify-content:flex-end"><button class="btn" id="gx" type="button">Close</button><button class="btn g" id="gs" type="button">Save</button></div></div>';
  d.showModal();el('gx').onclick=()=>d.close();
  d.querySelectorAll('[data-imp]').forEach(inp=>inp.onchange=async()=>{const f=inp.files&&inp.files[0];if(!f)return;let j;try{j=JSON.parse(await f.text())}catch(_){el('ge').textContent='That file is not valid JSON.';return}
    const r=await fetch('/admin/dialer/script',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({svc:inp.dataset.imp,script:j})});const jj=await r.json().catch(()=>({}));
    if(!jj.success){el('ge').textContent=jj.message||'Could not import.';return}GS[inp.dataset.imp]=j;el('gst-'+inp.dataset.imp).textContent=st(inp.dataset.imp);el('ge').textContent='';gi=0;drawScript();drawBrief(Q[ix])});
  el('o-kr').onclick=()=>{el('o-kn').value=OFKD};
  const libSt=async()=>{try{const j=await (await fetch('/admin/dialer/library')).json();el('lib-st').textContent=j.count?j.count+' answers loaded ('+(j.byService||[]).map(x=>x.svc+' '+x.n).join(', ')+')':'Nothing loaded yet'}catch(_){el('lib-st').textContent='Could not check'}};libSt();
  el('lib-c').onclick=async()=>{await fetch('/admin/dialer/library',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clear:true})});libSt()};
  el('lib-f').onchange=async()=>{const f=el('lib-f').files&&el('lib-f').files[0];if(!f)return;const st=el('lib-st');let rows=[];const t=await f.text();
    try{rows=t.trim()[0]==='['?JSON.parse(t):t.split(/\\r?\\n/).filter(x=>x.trim()).map(x=>JSON.parse(x))}catch(_){st.textContent='That file is not a response library (expected one JSON per line).';return}
    let add=0,skip=0;for(let i=0;i<rows.length;i+=150){st.textContent='Loading '+Math.min(i+150,rows.length)+' of '+rows.length+'...';let j={};try{j=await (await fetch('/admin/dialer/library',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rows:rows.slice(i,i+150),replace:i===0})})).json()}catch(_){}if(!j.success){st.textContent='Upload stopped. Try again.';return}add+=j.added||0;skip+=j.skipped||0}
    st.textContent='Loaded '+add+' answers'+(skip?' ('+skip+' too short, skipped)':'');libSt()};
  el('ai-t').onclick=async()=>{const st=el('ai-st');st.textContent='Testing...';let j={};try{j=await (await fetch('/admin/coach/aitest')).json()}catch(_){}
    st.textContent=j.ok?(j.message||'Working. '+(j.model||'')+' answered.'):(j.message||'No answer from the server.')+(j.status?' (status '+j.status+')':'')};
  el('g-pb').onclick=async()=>{let j;try{j=JSON.parse(el('g-paste').value)}catch(_){el('g-pm').textContent='That does not look like the copied scripts. Copy them again and paste all of it.';return}
    const list=j&&j.bundle?['tint','coating'].filter(k=>j[k]).map(k=>[k,j[k]]):(j&&j.service?[[j.service,j]]:[]);if(!list.length){el('g-pm').textContent='No scripts found in what you pasted.';return}
    let n=0;for(const [k,sc] of list){const r=await fetch('/admin/dialer/script',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({svc:k,script:sc})});const jj=await r.json().catch(()=>({}));if(!jj.success){el('g-pm').textContent=jj.message||'Could not import.';return}GS[k]=sc;n++}
    el('g-pm').textContent='Imported '+n+' script'+(n===1?'':'s')+'.';el('g-paste').value='';['tint','coating'].forEach(k=>{const e=el('gst-'+k);if(e)e.textContent=st(k)});gi=0;drawScript();drawBrief(Q[ix])};
  el('gs').onclick=async()=>{const fx=el('o-fx').value.split('\\n').map(x=>{const i=x.indexOf('=>');return i<0?null:{f:x.slice(0,i).trim(),t:x.slice(i+2).trim()}}).filter(x=>x&&x.f),tm=el('o-tm').value.split('\\n').map(x=>x.trim()).filter(Boolean);const sw=el('o-sw').value.split('\\n').map(x=>{const i=x.indexOf('=>');return i<0?null:{f:x.slice(0,i).trim(),t:x.slice(i+2).trim()}}).filter(x=>x&&x.f);
    const v=id=>el(id).value.trim(),off={rep:v('o-rep'),shop:v('o-shop'),address:v('o-addr'),area:v('o-area'),special:v('o-sp'),specialEnd:v('o-end'),tintPrice:v('o-tp'),tintDeposit:v('o-td'),tintFloor:v('o-tf'),coatPrice:v('o-cp'),coatReg:v('o-cr'),coatDeposit:v('o-cd'),coatYears:v('o-cy'),tintSkip:v('o-ts'),coatSkip:v('o-cs'),knowledge:el('o-kn').value.trim()===String(OFKD).trim()?'':el('o-kn').value.trim(),swaps:sw,fixes:fx,terms:tm};
    const r=await fetch('/admin/dialer/offer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({offer:off})});const j=await r.json().catch(()=>({}));if(!j.success){el('ge').textContent=j.message||'Could not save.';return}OF=off;d.close();drawScript();drawBrief(Q[ix])}}

// scripts and the missed-you text
el('gcb').onclick=gSetup;
el('scb').onclick=()=>{const d=el('sdlg');d.innerHTML='<div class="rb"><h3>Scripts and text</h3><p class="note" style="margin:0">Use {first} {vehicle} {service} {service_name} {price} {address}. Lines starting with # are headings and lines starting with - are bullets.</p><div><label>Tint script</label><textarea id="s1" rows="10"></textarea></div><div><label>Ceramic coating script</label><textarea id="s2" rows="10"></textarea></div><div><label>Text: I missed you</label><textarea id="s3" rows="4"></textarea></div><div class="err" id="se"></div><div class="bar" style="justify-content:flex-end"><button class="btn" id="sx" type="button">Cancel</button><button class="btn g" id="ss" type="button">Save</button></div></div>';
  el('s1').value=ST.tint;el('s2').value=ST.coating;el('s3').value=ST.missed;d.showModal();el('sx').onclick=()=>d.close();
  el('ss').onclick=async()=>{const r=await fetch('/admin/dialer/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tint:el('s1').value,coating:el('s2').value,missed:el('s3').value})});const j=await r.json().catch(()=>({}));if(!j.success){el('se').textContent=j.message||'Could not save.';return}ST.tint=el('s1').value;ST.coating=el('s2').value;ST.missed=el('s3').value;d.close();drawScript()}};
// voicemail recordings
let rcr=null,rto=null,rk=null;
function wavBlob(f,rate){const n=f.length,buf=new ArrayBuffer(44+n*2),v=new DataView(buf);const w=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i))};w(0,'RIFF');v.setUint32(4,36+n*2,true);w(8,'WAVE');w(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);w(36,'data');v.setUint32(40,n*2,true);for(let i=0;i<n;i++){const s=Math.max(-1,Math.min(1,f[i]));v.setInt16(44+i*2,s<0?s*0x8000:s*0x7fff,true)}return new Blob([buf],{type:'audio/wav'})}
async function toWav(blob){const ab=await blob.arrayBuffer();const C=window.AudioContext||window.webkitAudioContext,ctx=new C();const buf=await new Promise((ok,no)=>ctx.decodeAudioData(ab,ok,no));const off=new OfflineAudioContext(1,Math.max(1,Math.ceil(buf.duration*8000)),8000);const s=off.createBufferSource();s.buffer=buf;s.connect(off.destination);s.start();const out=await off.startRendering();ctx.close();return wavBlob(out.getChannelData(0),8000)}
function b64(blob){return new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(',')[1]);r.onerror=no;r.readAsDataURL(blob)})}
async function saveAudio(k,wav){const j=await (await fetch('/admin/dialer/audio',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:k,mime:'audio/wav',data:await b64(wav)})})).json().catch(()=>({}));if(!j.success)throw new Error(j.message||'Could not save');await loadAudio()}
async function loadAudio(){try{AU=await (await fetch('/admin/dialer/audio')).json()}catch(_){}}
function vmDraw(msg){const d=el('vdlg');if(!d.open)return;d.querySelector('.rb').innerHTML='<h3>Voicemail messages</h3><p class="note" style="margin:0">Record each one here (up to 40 seconds) or upload a file. During a call, the Drop button plays it to the lead and hangs up. Leave the greeting and your number in it.</p>'
  +['tint','coating'].map(k=>'<div class="vm"><b>'+(k==='tint'?'Ceramic tint':'Ceramic coating')+' voicemail</b><span class="note">'+(AU[k]&&AU[k].has?'Saved '+$(AU[k].updated_at||''):'Not recorded yet')+'</span>'+(AU[k]&&AU[k].has?'<audio controls preload="none" src="/admin/dialer/audio/play?kind='+k+'&t='+Date.now()+'" style="width:100%"></audio>':'')+'<div class="bar"><button class="btn sm'+(rcr&&rk===k?' r':' g')+'" data-rec="'+k+'" type="button">'+(rcr&&rk===k?'Stop and save':'Record')+'</button><label class="btn sm" style="margin:0;text-transform:none;letter-spacing:0;color:#e8eaed;font-size:13.5px">Upload file<input type="file" accept="audio/*" data-up="'+k+'" hidden></label></div><span class="note" id="vi-'+k+'">'+(msg&&msg[0]===k?$(msg[1]):'')+'</span></div>').join('')
  +'<div class="bar" style="justify-content:flex-end"><button class="btn" id="vx" type="button">Close</button></div>';
  el('vx').onclick=()=>{if(rcr)rcr.stop();d.close()}}
el('vmb').onclick=async()=>{const d=el('vdlg');d.innerHTML='<div class="rb"></div>';d.showModal();await loadAudio();vmDraw()};
el('vdlg').addEventListener('click',async e=>{const r=e.target.closest('[data-rec]');if(!r)return;const k=r.dataset.rec;
  if(rcr){rcr.stop();return}
  try{const st=await navigator.mediaDevices.getUserMedia({audio:true});const chunks=[];rk=k;rcr=new MediaRecorder(st);rcr.ondataavailable=ev=>{if(ev.data.size)chunks.push(ev.data)};
    rcr.onstop=async()=>{clearTimeout(rto);st.getTracks().forEach(t=>t.stop());const b=new Blob(chunks,{type:rcr.mimeType||'audio/webm'});rcr=null;vmDraw([k,'Saving...']);try{await saveAudio(k,await toWav(b));vmDraw([k,'Saved.'])}catch(er){vmDraw([k,'Could not save: '+((er&&er.message)||er)])}};
    rcr.start();rto=setTimeout(()=>{if(rcr)rcr.stop()},40000);vmDraw([k,'Recording... tap Stop and save when done.'])}catch(_){vmDraw([k,'Allow the microphone to record.'])}});
el('vdlg').addEventListener('change',async e=>{const u=e.target.closest('[data-up]');if(!u||!u.files[0])return;const k=u.dataset.up;vmDraw([k,'Converting...']);try{await saveAudio(k,await toWav(u.files[0]));vmDraw([k,'Saved.'])}catch(er){vmDraw([k,'Could not use that file: '+((er&&er.message)||er)])}});

// ---- live coach: transcript and instant objection cards (ACA format)
const OBJ=[
 {id:'price',label:'Price pushback',en:/(too (much|expensive|high)|expensive|that'?s a lot|a lot of money|over (my )?budget|out of (my )?budget|cheaper|can'?t afford)/i,es:/(muy caro|es caro|cuesta mucho|demasiado|más barato|mas barato|presupuesto|no puedo pagar)/i,
  enc:['Totally get it, it is an investment.','Most people end up comparing it to the cheaper option that has to be redone, so it is worth looking at what you are getting.','What number did you have in mind, or what are you comparing it to?'],
  esc:['Lo entiendo, es una inversión.','Mucha gente compara con la opción barata que luego hay que repetir, por eso conviene ver qué incluye.','¿Qué precio tenía en mente, o con qué lo está comparando?']},
 {id:'think',label:'Needs to think',en:/(think about it|let me think|get back to you|talk (it over )?(to|with) (my )?(wife|husband|partner|girlfriend|boyfriend|dad|mom)|sleep on it|not sure yet|i'?ll let you know)/i,es:/(lo voy a pensar|d[eé]jame pensar|te aviso|hablar con mi (esposa|esposo|pareja)|m[aá]s adelante|no estoy seguro)/i,
  enc:['That makes sense, it is a decision worth thinking through.','A lot of people just want to see how it fits their schedule before they commit.','What would you want to be sure about before deciding?'],
  esc:['Tiene sentido, es una decisión para pensarla bien.','Mucha gente solo quiere ver cómo encaja con su agenda antes de decidir.','¿Qué le gustaría tener claro antes de decidir?']},
 {id:'compare',label:'Comparing quotes',en:/(other (quotes?|shops?|places?)|shopping around|getting (a few |some )?quotes|another (shop|place|company)|someone else|found (it )?cheaper|a guy (who|that))/i,es:/(otras? cotizaci|otro (taller|lugar|sitio)|comparando|buscando m[aá]s|alguien m[aá]s)/i,
  enc:['Smart to compare.','Quotes can look alike and still be different products and different coverage.','What are they offering, and what product is it?'],
  esc:['Es buena idea comparar.','Las cotizaciones pueden parecerse y aun así ser productos y coberturas distintas.','¿Qué le ofrecen, y qué producto es?']},
 {id:'worth',label:'Is it worth it?',en:/(is it worth|worth it|do i (really )?need|does it (really )?work|is it necessary|why would i)/i,es:/(vale la pena|realmente funciona|lo necesito de verdad|es necesario)/i,
  enc:['Fair question.','It depends on how you use the car and what bugs you most, whether that is heat, glare, or how it looks.','What made you start looking into this?'],
  esc:['Buena pregunta.','Depende de cómo use el carro y qué le molesta más: el calor, el brillo o la apariencia.','¿Qué le hizo empezar a buscar esto?']},
 {id:'timing',label:'Timing',en:/(not right now|next month|later on|in a few (weeks|months)|after (the )?(holidays?|summer|new year)|not yet|maybe later)/i,es:/(ahora no|el pr[oó]ximo mes|m[aá]s tarde|despu[eé]s de|todav[ií]a no)/i,
  enc:['No problem, timing matters.','A lot of people book ahead so they have a date locked in.','When were you thinking, so I can see what is open?'],
  esc:['Sin problema, el momento importa.','Mucha gente reserva con tiempo para asegurar una fecha.','¿Para cuándo pensaba, para ver qué hay disponible?']},
 {id:'trust',label:'Warranty / trust',en:/(warranty|guarantee|how long (have you|has the shop)|reviews|are you (licensed|insured)|references)/i,es:/(garant[ií]a|cu[aá]nto tiempo llevan|rese[nñ]as|referencias|est[aá]n asegurados)/i,
  enc:['Good thing to ask.','I will walk you through exactly what is covered for this service.','Which service are we talking about for your car?'],
  esc:['Buena pregunta.','Le explico exactamente qué cubre este servicio.','¿De qué servicio hablamos para su carro?']},
];
let cws=null,coachOn=false,lastCard={},wR=0,wL=0;
function cs(t){const e=el('cst');e.textContent=t;e.className='note'+(t==='Listening'?' on':'')}
function share(){const n=wR+wL;if(n<12){el('shb').hidden=true;el('shl').textContent='';return}const r=Math.round(wR*100/n);el('shb').hidden=false;el('shi').style.width=r+'%';const l=el('shl');l.textContent='You '+r+'% \u00b7 Lead '+(100-r)+'%'+(r>60?' \u2014 let them talk':'');l.className='shl'+(r>60?' hi':'')}
async function coachStatus(){try{const j=await (await fetch('/admin/coach/status')).json();coachOn=!!j.enabled;coachAiOn=!!j.ai;coachPracticeOn=!!j.practice}catch(_){}}
let cRe=0;function coachStart(sid,po,re){coachStop();if(!re)cRe=0;if(!(coachOn||po)||!sid)return;const p=el('coach');p.hidden=false;el('trn').innerHTML='';el('cards').innerHTML='';curAns=null;ansHist=[];pend=null;leadBuf='';lastPos='';lastCard={};wR=0;wL=0;share();cs('Connecting...');
  try{cws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/admin/coach/ws?sid='+sid+(po?'&practice=1&svc='+po.svc+'&level='+po.level:''))}catch(_){cs('Transcript unavailable');return}
  cws.onopen=()=>{lastPos='';cs('Listening');el('aip').hidden=!coachAiOn;el('aip').textContent='AI on';gNext()};const me=cws;cws.onclose=()=>{if(cws!==me)return;/* dropped mid-call: reconnect, the server sends the transcript and the current answer again */if(!po&&state==='live'&&cRe<8){cRe++;cs('Reconnecting...');setTimeout(()=>{if(cws===me&&state==='live')coachStart(sid,null,1)},800);return}if(el('cst').textContent==='Listening'||el('cst').textContent==='Reconnecting...')cs('Transcript stopped')};
  cws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch(_){return}coachMsg(m)}}
function coachStop(){if(cws){try{cws.close()}catch(_){}cws=null}}
// ---- answers: what the lead asked, answered from your script (instant) and by the AI coach (a moment later) ----
let coachAiOn=false,lastAns={};
const INTENTS=[
 {id:'what',rx:/(what('s| is| does)? (a |an |the )?(ceramic )?(coating|tint)|how does (it|that|this) work|what (does|do) (it|that|they) do|explain (it|that|this)|tell me (more )?about|what exactly)/,tint:{steps:['s15','s13']},coating:{steps:['s15','s13']}},
 {id:'scratch',rx:/(deep(er)? (scratch|scrape|gouge)|gouge|scratch.?proof|scratch.?resist|(stop|stops|prevent|prevents|protect (from|against)|protects (from|against))[^.?!]{0,25}scratch)/,coating:{plays:['a-scratch'],steps:['s13']}}, // the "not scratch proof" answer is only for deep scratches or asking if it stops scratches: a lead who just says they have swirl marks is answering discovery
 {id:'price',rx:/(how much|what('s| is) the (price|cost)|\\bprice\\b|\\bcost\\b|quote|ballpark)/,tint:{plays:['a-price']},coating:{plays:['a-price']}},
 {id:'time',rx:/(how long (does|will|would|is) (it|that|the)|how many hours|take all day|how much time)/,tint:{steps:['s13']},coating:{steps:['s20']}},
 {id:'warranty',rx:/(warrant|guarantee|how long (does|will) (it|that) last|lifetime)/,tint:{steps:['s15']},coating:{steps:['s15']}},
 {id:'brand',rx:/(what (brand|film|coating|kind)|which (brand|film|coating)|what do you (guys )?use)/,tint:{steps:['s15']},coating:{steps:['s15']}},
 {id:'legal',rx:/(legal|ticket|how dark|darkest|florida law|pulled over)/,tint:{steps:['s10']}},
 {id:'where',rx:/(where (are|is) you|your address|located|location|how far)/,tint:{plays:['a-location']},coating:{plays:['a-location']}},
 {id:'book',rx:/(when can|availab|openings|how soon|earliest|appointment)/,tint:{steps:['s19']},coating:{steps:['s20']}},
 {id:'deposit',rx:/(deposit|pay (now|up front)|credit card|payment|square)/,tint:{steps:['s21']},coating:{steps:['s22']}},
 {id:'wax',rx:/\\bwax/,coating:{plays:['a-wax']}}];
const OBJ2=[['p-expensive',/(too (much|expensive|pricey)|expensive|that.?s a lot|can.?t afford)/],['p-wife',/(my wife|my husband|my girlfriend|talk to my)/],['p-think',/(think about it|let me think|need to think)/],['p-text',/(text (it|me)|send (it|me)|email (it|me))/],['p-calendar',/(my (calendar|schedule)|check my|i.?m driving)/],['p-shop',/(shopping around|other (quotes|shops)|more quotes|compar)/],['p-catch',/(what.?s the catch|too good|why so cheap)/],['a-booked',/(already (booked|got|did)|someone else)/]];
function nodesText(nodes,l,svc,kinds){const out=[];(nodes||[]).forEach(n=>{if(!n)return;if(n.k==='outcomes'){return}if(kinds.indexOf(n.k)<0)return;(n.ps||[]).forEach(p=>{if(p.t)out.push({t:gplain(p.t,l,svc)})});(n.list||[]).forEach(i=>out.push({h:i.h,t:gplain(i.t,l,svc)}))});return out}
function sayOf(sc,spec,l,svc){const lines=[];(spec.plays||[]).forEach(id=>{const p=sc.plays.find(x=>x.id===id);if(p)nodesText(p.nodes,l,svc,['resp']).forEach(x=>lines.push(x))});
  (spec.steps||[]).forEach(id=>{const s=sc.steps.find(x=>x.id===id);if(s){nodesText(s.main,l,svc,['say']).forEach(x=>lines.push(x));if(s.side)nodesText(s.side,l,svc,['coach']).forEach(x=>lines.push(x))}});
  return lines}
function openDisc(sc){return sc.steps.map((st,i)=>({st,i})).filter(o=>o.st.phase==='discovery'&&o.st.n&&!COV[o.st.id]&&o.i!==gi)}
function nextStep(sc){let i=sc.steps.findIndex((st,k)=>k>gi&&st.n&&!COV[st.id]);if(i<0)i=sc.steps.findIndex(st=>st.n&&!COV[st.id]);return i}
function nextAsk(sc,l,svc){const od=openDisc(sc),i=od.length?od[0].i:nextStep(sc),s=sc.steps[i];if(!s)return null;const p=s.main&&s.main[0]&&s.main[0].ps&&s.main[0].ps.find(x=>x.t);return p?{t:gplain(p.t,l,svc),id:s.id}:null}
const isQ=t=>/\\?|^\\s*(what|how|why|where|when|who|do|does|did|can|could|is|are|will|would)\\b/i.test(String(t||''));
function gDet(text){const sc=gScript(),l=Q[ix];if(!sc||!l)return false;brPick(text);if(!coachAiOn&&isQ(text))markRedo();const svc=gsvc(l),t=String(text||'').toLowerCase();
  const fresh=id=>{const n=Date.now();if(lastAns[id]&&n-lastAns[id]<20000)return false;lastAns[id]=n;return true};
  // pushback first, then questions
  for(const [id,rx] of OBJ2){if(rx.test(t)){const pid=sc.plays.some(p=>p.id===id)?id:(id==='p-expensive'&&sc.plays.some(p=>p.id==='p-shop')?'p-shop':'');if(!pid||!fresh(pid))continue;
    const lines=sayOf(sc,{plays:[pid]},l,svc);if(!lines.length)continue;showAns({src:'script',q:text,say:lines[0].t,lines:lines.slice(1,2).map(x=>({t:x.t})),anchor:'gx-'+pid});return true}}
  // asking about a different service than the one this script covers: the script has no answer for it, so leave it to the AI instead of quoting the wrong price
  if((svc==='tint'?/(coat|coding|paint protection|ppf|wrap|correction|polish)/:/(tint|tent|ppf|paint protection|wrap)/).test(t))return true;
  for(const it of INTENTS){if(!it.rx.test(t))continue;const spec=it[svc];if(!spec||!fresh(it.id))continue;const lines=sayOf(sc,spec,l,svc);if(!lines.length)continue;
    const na=nextAsk(sc,l,svc),anc=(spec.plays&&spec.plays[0])?'gx-'+spec.plays[0]:'gs-'+spec.steps[0];
    showAns({src:'script',q:text,say:lines[0].t,lines:lines.slice(1,4),ask:'',anchor:anc});return true}
  return true}
function anchorId(a){a=String(a||'');if(!a)return '';if(/^(gs|gx)-/.test(a))return a;const sc=gScript();if(sc&&sc.plays.some(p=>p.id===a))return 'gx-'+a;return 'gs-'+a}
// One answer at a time: it stays put while the rep reads it, and the AI version is folded into the same card
let curAns=null,ansHist=[],pend=null,pendTm=0,leadBuf='',leadTm=0,lastNext='',detTm=0;const DWELL=2500;
function leadSaid(text,end){leadBuf=(leadBuf+' '+text).trim();clearTimeout(leadTm);if(end)flushLead();else leadTm=setTimeout(flushLead,900)}
function flushLead(){clearTimeout(leadTm);const t=leadBuf.trim();leadBuf='';if(!t)return;if(!gScript())objCheck(t);else gDet(t)}
function sameQ(a,b){const x=words(String(a||'')),y=words(String(b||''));if(!x.length||!y.length)return false;const st=new Set(y),h=x.filter(w=>st.has(w)).length;return h/Math.min(x.length,y.length)>=0.4}
function markRedo(){const ls=lastSaid;if(!ls||Date.now()-ls.at>20000||!/\\?\\s*$/.test(ls.t))return;const tmp={};gCov(tmp);if(tmp[ls.sid])return;delete SAID[ls.k];delete COV[ls.sid]}
function showAns(o){if(o.src!=='ai')return; // only the AI coach answers: scripted answer cards are not shown
  const now=Date.now(),key=o.src==='ai'?'ai:'+String(o.q||'').toLowerCase().slice(0,40):String(o.anchor||o.q||'').toLowerCase();
  if(o.src==='ai'&&curAns&&curAns.src!=='ai'&&now-curAns.t<30000&&sameQ(curAns.q,o.q)){curAns.ai=o;drawAns();return}
  /* a newer answer replaces the one on screen at once: no waiting */
  if(curAns&&curAns.key===key&&now-curAns.t<30000){if(o.src==='ai'){Object.assign(curAns,o);drawAns()}return}
  if(curAns){ansHist.unshift(curAns);ansHist=ansHist.slice(0,4)}
  curAns=Object.assign({},o,{t:now,key:key,used:false,ai:null});drawAns()}
function ansHtml(a){const q=String(a.q||'').slice(0,90),ai=a.ai;
  const lat=a.ms&&(a.ms.total||a.ms.say)?' &middot; '+((a.ms.total||a.ms.say)/1000).toFixed(1)+'s':'';
  const pill=a.src==='ai'?(a.backup?'<span class="pill warn">Backup answer</span>':'<span class="pill ok">AI answer'+lat+'</span>'):a.src==='card'?'<span class="pill warn">'+$(a.label||'Pushback')+'</span>':'<span class="pill warn">From your script</span>';
  let h='<div class="bar">'+pill+(q?'<span class="note ansq">Lead: &ldquo;'+$(q)+'&rdquo;</span>':'')+'</div>';
  if(a.needs_eyes)h+='<div class="warnb">Not covered in your script. Confirm before you state it.'+(a.note?' '+$(a.note):'')+'</div>';
  h+='<p class="say">'+$(a.say||'')+'</p>';
  if(a.ask)h+='<div class="aca"><div><span>ASK</span><p class="ask">'+$(a.ask)+'</p></div></div>';
  if(a.then&&a.then.text)h+='<div class="aca"><div><span>THEN READ</span><p class="ask">'+$(a.then.text)+'</p></div></div>';
  const more=(a.lines&&a.lines.length?'<div class="alines">'+a.lines.map(x=>'<div>'+(x.h?'<b>'+$(x.h)+'</b>':'')+$(x.t)+'</div>').join('')+'</div>':'')+((a.ack||a.comment)&&a.src==='ai'?'<div class="aca"><div><span>ACKNOWLEDGE</span><p>'+$(a.ack||'')+'</p></div><div><span>COMMENT</span><p>'+$(a.comment||'')+'</p></div></div>':'');
  if(more)h+='<details class="more" data-k="m"'+(a.openM?' open':'')+'><summary>More wording</summary>'+more+'</details>';
  if(ai)h+='<details class="more tai" data-k="a"'+(a.openA===false?'':' open')+'><summary>AI version for this lead</summary><p class="say sm">'+$(ai.say||'')+'</p>'+(ai.ask?'<p class="ask sm">&rarr; '+$(ai.ask)+'</p>':'')+(ai.needs_eyes?'<div class="warnb">Not in your script. Confirm before you state it.</div>':'')+'</details>';
  h+='<div class="bar">'+(a.anchor?'<button type="button" class="btn sm" data-open="'+$(anchorId(a.anchor))+'">Open in script</button>':'')+'<button type="button" class="btn sm" data-x="1">Dismiss</button></div>';
  return h}
function drawAns(){const box=el('cards');if(!box)return;clearTimeout(detTm);if(curAns)detTm=setTimeout(gNext,40500);
  el('hist').innerHTML=ansHist.length?'<span>Earlier</span>'+ansHist.map((h,i)=>'<button type="button" data-h="'+i+'">'+$(String(h.q||h.label||'answer').slice(0,34))+'</button>').join(''):'';
  if(!curAns){box.innerHTML='';gNext();return}
  box.innerHTML=(curAns?'<div class="card2 ans'+(curAns.src==='ai'?'':' det')+(curAns.used?' used':'')+'">'+ansHtml(curAns)+'</div>':'')
   +'';gNext()}
el('cards').addEventListener('toggle',e=>{const d=e.target;if(!curAns||!d||!d.dataset)return;if(d.dataset.k==='m')curAns.openM=d.open;if(d.dataset.k==='a')curAns.openA=d.open},true);
el('coach').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.said){const nl=gNextLine();if(nl&&nl.branch){const bb=BR[nl.sid];if(bb)for(let q=0;q<=nl.bi;q++)bb.said[q]=1;gMark(false);return}if(nl&&!nl.done){const sc=gScript(),L=gLines(sc,Q[ix],gsvc(Q[ix]));SAID[nl.k]=1;if(L.filter(x=>x.si===nl.si).every(x=>SAID[x.k]))COV[nl.sid]=1;gi=nl.si;gMark(false)}return}
  if(b.dataset.skip){COV[b.dataset.skip]=1;gMark(false);return}
  if(b.dataset.x){curAns=null;pend=null;drawAns();return}
  if(b.dataset.h){const h=ansHist.splice(Number(b.dataset.h),1)[0];if(h){if(curAns)ansHist.unshift(curAns);curAns=h;curAns.t=Date.now()-DWELL;drawAns()}return}
  if(b.dataset.open){if(mt!=='script')setMain('script');const id=b.dataset.open;setTimeout(()=>{const sc=gScript();const st=id.indexOf('gs-')===0?sc&&sc.steps.findIndex(s=>'gs-'+s.id===id):-1;if(st>=0){gi=st;gMark(false)}gGo(id)},60)}});
// the next thing still to cover, so the call keeps its shape when the lead leads
function gNext(){const box=el('gnx');if(!box)return;const sc=gScript(),l=Q[ix];if(!sc||!l||state!=='live'){box.hidden=true;return}
  const svc=gsvc(l),nl=gNextLine(),det=!!(curAns&&!curAns.used&&Date.now()-curAns.t<40000),od=openDisc(sc);let h='';
  if(nl&&nl.done)h='<span class="gl">Script complete</span><span class="gq big">Before you hang up: deposit taken and a date set? If not, offer the payment link and a specific day. If they need a callback, set an exact day and time.</span>';
  else if(nl){const s=sc.steps[nl.si],cond=[].concat.apply([],(s.main||[]).map(n=>(n.ps||[]).filter(p=>p.t&&!p.note&&/^if\\b/i.test(p.sub||'')).map(p=>({sub:p.sub,t:gplain(p.t,l,svc)})))),nt=[].concat.apply([],(s.main||[]).map(n=>(n.ps||[]).filter(p=>p.note).map(p=>gplain(p.note,l,svc))))[0];lastNext=nl.t;
    h='<span class="gl">'+(nl.branch?'Their answer: '+$(nl.sub):det?'Then back to the script':'Say this next')+'</span><b>'+$(s.n)+' &middot; '+$(topicOf(svc,s))+'</b><span class="gq big">'+$(nl.t)+'</span>'+(nt&&!det?'<span class="gtip"><b>Coach</b> '+$(nt)+'</span>':'')+(!det?cond.map(c=>'<span class="gtip"><b>'+$(c.sub)+'</b> '+$(c.t)+'</span>').join(''):'')
     +'<span class="gb"><button type="button" class="btn sm g" data-said="1">Said it</button><button type="button" class="btn sm" data-skip="'+$(s.id)+'">Skip step</button><button type="button" class="btn sm" data-open="gs-'+$(s.id)+'">Open</button></span>'}
  if(od.length&&!det)h+='<div class="gts"><span class="gl">Still open</span>'+od.slice(0,5).map(o=>'<button type="button" class="gt2" data-open="gs-'+$(o.st.id)+'"><b>'+$(o.st.n)+'</b>'+$(topicOf(svc,o.st))+'</button>').join('')+'</div>';
  box.hidden=false;box.className='gnx'+(det?' det':'');box.innerHTML=h;sendPos(nl)}
function coachMsg(m){if(m.type==='hello'){(m.turns||[]).forEach(t=>addLine(t.who,t.text,true));if(m.facts)setAiFacts(m.facts);if(m.ans&&m.ans.type==='answer')coachMsg(m.ans);return}
  if(m.type==='live'){cs('Listening');return}
  if(m.type==='transcript'){addLine(m.who,m.text,m.final,m.low);if(m.speak&&practiceOn&&el('pspk')&&el('pspk').checked&&window.speechSynthesis){try{const u=new SpeechSynthesisUtterance(m.text);u.rate=1.05;speechSynthesis.speak(u)}catch(_){}}if(m.who==='lead'&&m.final)leadSaid(m.text,m.end);return}
  if(m.type==='practice_ready'){const l=Q[ix];if(l&&l.practice){Object.assign(l,m.lead);INFO[0]={lead:l,facts:{attempts:0,talkSecs:0,connected:0},notes:[],calls:[],texts:[],activity:[]};drawLead();drawScript();drawBrief(l);drawQ()}return}
  if(m.type==='practice_score'){practiceFinish(m.score,m.persona);return}
  if(m.type==='practice_error'){setSt(m.message||'Practice problem','bad');return}
  if(m.type==='end'){if(m.who==='lead')flushLead();return}
  if(m.type==='facts'){setAiFacts(m);return}
  if(m.type==='coach_skip'){cs('AI quiet on "'+String(m.q||'').slice(0,40)+'" ('+(m.why||'')+')');setTimeout(()=>{if(el('cst').textContent.indexOf('AI quiet')===0)cs('Listening')},12000);return}
  if(m.type==='answer'){if(!m.early&&m.answered===false){markRedo();gMark(false)}showAns({src:'ai',backup:m.backup,q:m.q,say:m.say,ack:m.ack,comment:m.comment,ask:m.ask,then:m.then,anchor:m.anchor,needs_eyes:m.needs_eyes,note:m.note,ms:m.ms});return}
  if(m.type==='coach_error'){el('aip').textContent='AI unavailable';return}
  if(m.type==='error'){cs(m.message);return}
  if(m.type==='ended'){cRe=99;cs('Call ended')}}
const PRICE_RX=/\\$\\s?\\d|\\b\\d{3}\\s?dollars|\\b(two|three|four|five|six|seven)\\s+(ninety|seventy|eighty|sixty|fifty|forty|thirty|twenty)\\b|out the door|the price is/i,DEP_RX=/deposit|debit or credit|payment link|secure link|apple pay|card (over|by) the phone/i,SIG_RX=/(sounds? (good|great|fair)|that works|that.?s fair|not bad|let.?s do it|i want to (get|do|book)|how (do|can) i (pay|book)|when can (you|i)|what (days|times) do you have|go ahead|sounds like a plan)/i;
function priceStep(){const sc=gScript(),l=Q[ix],st=sc&&sc.steps[gi];return !!(st&&l&&topicOf(gsvc(l),st)==='Price')}
function nudgeNote(who,text){if(who==='rep'){if(!priceAt&&PRICE_RX.test(text)&&priceStep())priceAt=Date.now();if(DEP_RX.test(text)){depAsked=true;nudgeCheck()}}else if(priceAt&&!depAsked&&SIG_RX.test(text))sigAt=Date.now()}
function nudgeCheck(){const box=el('nudge');if(!box)return;if(state!=='live'||depAsked||!priceAt){box.hidden=true;return}
  const now=Date.now(),sc=gScript(),l=Q[ix],nl=sc?gNextLine():null,s=nl&&!nl.done?sc.steps[nl.si]:null,tp=s&&l?topicOf(gsvc(l),s):'';
  if(/^(Book the day|Contact info|Deposit|Referral|Wrap up)$/.test(tp)){box.hidden=true;return}
  const hot=sigAt>priceAt&&now-sigAt<120000,late=now-priceAt>40000;if(!hot&&!late){box.hidden=true;return}
  const dep=(l&&vv('dep',l,gsvc(l)))||'The deposit';
  box.hidden=false;box.innerHTML='<b>'+(hot?'Buying signal. Close now.':'You gave the price. Close now.')+'</b>Offer two open days, then say: &ldquo;'+$(dep)+' comes off your total and it is refundable. Debit or credit?&rdquo;'}
setInterval(nudgeCheck,2000);
// browsing the CRM during a call: pages open full width beside the sidebar and the call follows you in a small floating box
let fbPaint=null;
(function(){let pn=null,fb=null,open=false,sig='',msg='',msgT=0,dis=false,disT=0;
const act=()=>state==='live'||state==='connecting'||(state==='ended'&&!outSaved);
function path(u){return String(u).split('#')[0].split('?')[0]}
function mark(u){document.querySelectorAll('.navtabs a').forEach(a=>a.classList.toggle('on',path(a.getAttribute('href'))===path(u)))}
function build(){if(pn)return;pn=document.createElement('div');pn.id='navdr';pn.hidden=true;pn.innerHTML='<iframe id="ndf" title="CRM"></iframe>';document.body.appendChild(pn);
  fb=document.createElement('div');fb.id='fbox';fb.hidden=true;document.body.appendChild(fb);fb.addEventListener('click',onFb)}
function show(u){build();pn.hidden=false;open=true;pn.querySelector('#ndf').src=u;mark(u);sig='';paint()}
function hide(){if(!pn)return;pn.hidden=true;open=false;mark('/admin/dialer');paint()}
function onFb(e){const b=e.target.closest('[data-fa]');if(!b)return;const a=b.dataset.fa;
  if(a==='mute'){const m=el('mb');if(m)m.click()}else if(a==='hang'){const h=el('hb');if(h)h.click()}else if(a==='open')hide();
  else if(a==='out')saveOutcome(b.dataset.o,b.dataset.o==='Callback'?dayPlus(1):'');else if(a==='done'){outSaved=true;dis=true;sig='';paint()}}
function paint(){if(!fb)return;const l=Q[ix];if(state!=='ended'){dis=false;clearTimeout(disT);disT=0}if(state==='ended'&&outSaved&&!disT)disT=setTimeout(()=>{dis=true;paint()},6000);if(!open||!l||!(state==='live'||state==='connecting'||(state==='ended'&&!dis))){fb.hidden=true;return}
  const nm=String(l.name||pretty(l.phone)),ini=initials(l.name),ended=state==='ended',nl=!ended&&typeof gNextLine==='function'?gNextLine():null;
  const s2=[state,muted,l.id,outSaved,outPick,msg,dis].join('|');
  if(s2!==sig){sig=s2;fb.hidden=false;
    const head='<div class="fh"><span class="av">'+$(ini)+'</span><div class="fn"><b>'+$(nm)+'</b><small>'+(ended?'Call ended. How did it go?':state==='live'?'Connected':'Calling...')+'</small></div>'+(ended?'':'<span class="timer" id="fbt">0:00</span>')+'</div>';
    if(ended){fb.innerHTML=head+'<div class="fo">'+OUTG.flatMap(g=>g[1]).map(o=>'<button class="btn sm'+(outPick===o[0]?' on':'')+'" type="button" data-fa="out" data-o="'+$(o[0])+'">'+$(o[1])+'</button>').join('')+'</div><div class="fbs"><button class="btn sm" type="button" data-fa="open">Open dialer</button>'+(outSaved?'<button class="btn g sm" type="button" data-fa="done">Done</button>':'')+'</div>'+(outPick==='Callback'?'<small class="fm">Callback set for tomorrow. Change it in the dialer.</small>':'')}
    else fb.innerHTML=head+'<div class="fs"><i>Say this next</i><p id="fbs"></p></div><div class="fs fl2"><i>Lead just said</i><p id="fbl"></p></div><div class="fbs"><button class="btn sm'+(muted?' on':'')+'" type="button" data-fa="mute"'+(state==='live'?'':' disabled')+'>'+(muted?'Unmute':'Mute')+'</button><button class="btn sm" type="button" data-fa="open">Open dialer</button><button class="btn r sm" type="button" data-fa="hang">Hang up</button></div>'+(msg?'<small class="fm">'+$(msg)+'</small>':'')}
  const t=document.getElementById('fbt');if(t&&t0){const sc=Math.floor((Date.now()-t0)/1000);t.textContent=Math.floor(sc/60)+':'+String(sc%60).padStart(2,'0')}
  const fs=document.getElementById('fbs');if(fs)fs.textContent=nl&&nl.t?nl.t:(nl&&nl.done?'Script finished. Close the deal.':'');
  const ll=document.querySelectorAll('#trn .ln.w-lead:not(.partial)');const fl=document.getElementById('fbl');if(fl)fl.textContent=ll.length?ll[ll.length-1].textContent.replace(/^Lead:\\s*/,''):'...'}
fbPaint=paint;setInterval(()=>{if(open)paint()},700);
document.addEventListener('click',e=>{if(!(act()||open))return;const a=e.target.closest('a[href]');if(!a||a.closest('#navdr'))return;const h=a.getAttribute('href')||'';if(h.charAt(0)!=='/'||h.indexOf('/logout')===0||a.target==='_blank')return;e.preventDefault();if(path(h)==='/admin/dialer'&&h.indexOf('lead=')<0)hide();else if(path(h)==='/admin/dialer'){msg='Finish this call first';clearTimeout(msgT);msgT=setTimeout(()=>{msg='';paint()},3500);paint()}else show(h)},true);
window.addEventListener('message',e=>{if(e.origin!==location.origin||!e.data||!e.data.ddgo)return;if(act()){msg='Finish this call first';clearTimeout(msgT);msgT=setTimeout(()=>{msg='';paint()},3500);paint();return}location.href=e.data.ddgo});
window.addEventListener('beforeunload',e=>{if(act()){e.preventDefault();e.returnValue=''}})})();
function addLine(who,text,final,low){if(final){nudgeNote(who,text);gAnalyze(who,text);if(who==='lead')gObjHint(text);else{gFollow(text)}const n=String(text).split(/\\s+/).filter(Boolean).length;if(who==='rep'&&n>=4)pend=null;if(who==='rep'&&curAns&&!curAns.used&&n>=6&&Date.now()-curAns.t>1200){curAns.used=true;drawAns()}if(who==='lead')wL+=n;else wR+=n;share()}const box=el('trn');let ln=box.querySelector('.ln.partial.w-'+who);if(!ln){ln=document.createElement('div');box.appendChild(ln)}ln.className='ln w-'+who+(final?'':' partial')+(low?' low':'');ln.innerHTML='<b>'+(who==='lead'?'Lead':'You')+':</b> '+$(text);box.scrollTop=box.scrollHeight}
function objCheck(text){for(const o of OBJ){const es=o.es.test(text),en=o.en.test(text);if(!es&&!en)continue;const now=Date.now();if(lastCard[o.id]&&now-lastCard[o.id]<20000)continue;lastCard[o.id]=now;showCard(o,es&&!en);break}}
function showCard(o,es){const c=es?o.esc:o.enc;showAns({src:'card',label:o.label,q:'',say:c[0]+' '+c[1],ask:c[2],anchor:''})}
// ---- practice call: an AI plays the customer ----
let practiceOn=false,prSvc='tint',prLevel='typical',prRec=null,prSaid=false,coachPracticeOn=false;
const prSend=t=>{t=String(t||'').trim();if(!t||!cws||cws.readyState!==1)return;try{window.speechSynthesis&&speechSynthesis.cancel()}catch(_){}cws.send(JSON.stringify({type:'practice_say',text:t}))};
async function prMenu(){if(state==='live'||state==='connecting')return;const d=el('prdlg');let runs=[];try{runs=(await (await fetch('/admin/dialer/practice')).json()).runs||[]}catch(_){}
  const avg=runs.length?(runs.reduce((a,r)=>a+(Number(r.overall)||0),0)/runs.length).toFixed(1):'';
  d.innerHTML='<div class="rb"><h3>Practice call</h3><p class="note" style="margin:0">An AI plays a customer. You type or talk as the rep, the coach helps you exactly like a real call, and you get a score and exact lines to fix at the end. Nothing goes to a real lead.</p>'
   +'<div><label>Service</label><div class="pch" id="pr-s"><button type="button" data-v="tint" class="on">Window tint</button><button type="button" data-v="coating">Ceramic coating</button></div></div>'
   +'<div><label>How hard</label><div class="pch" id="pr-l"><button type="button" data-v="easy">Easy</button><button type="button" data-v="typical" class="on">Typical</button><button type="button" data-v="tough">Tough</button></div></div>'
   +(coachPracticeOn?'':'<div class="err">Practice needs the Anthropic key to be working. Press Test AI coach in Guided scripts.</div>')
   +(runs.length?'<div><label>Recent practice'+(avg?' (average '+avg+' of 5)':'')+'</label>'+runs.map(r=>'<div class="note">'+$(new Date(r.at).toLocaleDateString('en-US',{month:'short',day:'numeric'}))+' &middot; '+$(r.svc==='tint'?'Tint':'Coating')+' &middot; '+$(r.level)+' &middot; '+$(r.kind||'')+' &middot; <b>'+$(r.overall)+'/5</b> &middot; '+$(r.outcome||'')+'</div>').join('')+'</div>':'')
   +'<div class="bar" style="justify-content:flex-end"><button class="btn" id="pr-x" type="button">Close</button><button class="btn g" id="pr-go" type="button"'+(coachPracticeOn?'':' disabled')+'>Start practice</button></div></div>';
  d.showModal();el('pr-x').onclick=()=>d.close();
  d.querySelectorAll('.pch').forEach(g=>g.onclick=e=>{const b=e.target.closest('button');if(!b)return;g.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b))});
  el('pr-go').onclick=()=>{startPractice(d.querySelector('#pr-s .on').dataset.v,d.querySelector('#pr-l .on').dataset.v)}}
function startPractice(svc,level){if(state==='live'||state==='connecting')return;el('prdlg').close();
  practiceOn=true;prSvc=svc;prLevel=level;prSaid=false;const pl={id:0,practice:true,name:'Practice caller',phone:'',service:svc==='tint'?'Window Tint':'Ceramic Coating',year:'',make:'',model:'',stage:'new',created_at:new Date().toISOString(),message:''};
  Q.splice(ix,0,pl);INFO[0]={lead:pl,facts:{attempts:0,talkSecs:0,connected:0},notes:[],calls:[],texts:[],activity:[]};
  sid='PR'+Array.from(crypto.getRandomValues(new Uint8Array(12))).map(x=>('0'+x.toString(16)).slice(-2)).join('');state='live';t0=Date.now();muted=false;el('after').hidden=true;setSt('Practice','warn');gi=0;gPlay=null;gHot='';FACTS={goals:[]};COV={};SAID={};LH={};LH={};lastSaid=null;priceAt=0;depAsked=false;sigAt=0;gOpenPh='';
  drawLead();drawScript();drawQ();coachStart(sid,{svc:svc,level:level});clearInterval(tmr);tmr=setInterval(tick,500);drawCtl();el('pbar').hidden=false;setTimeout(()=>{const i=el('pin');if(i)i.focus()},400)}
function endPractice(){if(!practiceOn||prSaid)return;prSaid=true;const sc=gScript(),l=Q[ix],cov=sc&&l?sc.steps.filter(s=>COV[s.id]).map(s=>s.n+' '+topicOf(gsvc(l),s)):[];
  try{cws.send(JSON.stringify({type:'practice_end',covered:cov}))}catch(_){}
  const h=el('hb');if(h){h.disabled=true;h.textContent='Scoring...'}el('cst').textContent='Scoring your call...';setTimeout(()=>{if(practiceOn)practiceFinish(null,null)},45000)}
function practiceFinish(score,persona){if(!practiceOn)return;practiceOn=false;prSaid=false;if(prRec){try{prRec.stop()}catch(_){}prRec=null}try{window.speechSynthesis&&speechSynthesis.cancel()}catch(_){}
  coachStop();clearInterval(tmr);t0=0;Q=Q.filter(x=>!x.practice);if(ix>=Q.length)ix=Math.max(0,Q.length-1);state='idle';el('pbar').hidden=true;el('coach').hidden=true;setSt('Ready','ok');drawLead();drawScript();drawCtl();drawQ();prScore(score,persona)}
function prScore(sc,pe){const d=el('prdlg');const bar=(k,v)=>'<div class="row"><b>'+k+'</b><div class="bar2"><i style="width:'+Math.max(0,Math.min(5,Number(v)||0))*20+'%"></i></div><span>'+(Number(v)||0)+'/5</span></div>';
  if(!sc){d.innerHTML='<div class="rb"><h3>Practice finished</h3><p class="note">The score did not come back this time. Try another practice call.</p><div class="bar" style="justify-content:flex-end"><button class="btn" id="pr-x" type="button">Close</button><button class="btn g" id="pr-again" type="button">Practice again</button></div></div>'}
  else{const S=sc.scores||{},oc={win:'Booked with a deposit',callback:'Callback (not a win)',lost:'Lost'}[sc.outcome]||sc.outcome||'';
   d.innerHTML='<div class="rb"><h3>Your score: '+$(Number(sc.overall)||0)+' out of 5</h3><p class="note" style="margin:0"><b>'+$(oc)+'</b> &middot; deposit asked: '+(sc.deposit_asked?'yes':'no')+' &middot; day set: '+(sc.date_set?'yes':'no')+'</p><p style="margin:0">'+$(sc.summary||'')+'</p>'
    +'<div class="psc">'+bar('Rapport',S.rapport)+bar('Discovery',S.discovery)+bar('Pitch',S.pitch)+bar('Objections',S.objections)+bar('Close',S.close)+bar('Control',S.control)+'</div>'
    +((sc.went_well||[]).length?'<div><label>What went well</label>'+(sc.went_well||[]).map(x=>'<div class="note">&bull; '+$(x)+'</div>').join('')+'</div>':'')
    +((sc.fix||[]).length?'<div><label>Fix these</label>'+(sc.fix||[]).map(f=>'<div class="pfix"><span class="note">Customer: &ldquo;'+$(f.moment||'')+'&rdquo;</span><span>You said: '+$(f.you_said||'')+'</span><span class="b">Say instead: '+$(f.better||'')+'</span></div>').join('')+'</div>':'')
    +((sc.missed_steps||[]).length?'<div><label>Script steps you skipped</label><div class="note">'+$((sc.missed_steps||[]).join(', '))+'</div></div>':'')
    +(sc.next_practice?'<div><label>Work on next</label><div>'+$(sc.next_practice)+'</div></div>':'')
    +(pe?'<div class="note">The caller was: <b>'+$(pe.kind)+'</b> ('+$(pe.level)+'). '+$(pe.how)+'</div>':'')
    +'<div class="bar" style="justify-content:flex-end"><button class="btn" id="pr-x" type="button">Close</button><button class="btn g" id="pr-again" type="button">Practice again</button></div></div>'}
  d.showModal();d.scrollTop=0;const rb=d.querySelector('.rb');if(rb)rb.scrollTop=0;el('pr-x').onclick=()=>d.close();el('pr-again').onclick=()=>{d.close();prMenu()}}
el('prb').onclick=prMenu;
el('psend').onclick=()=>{prSend(el('pin').value);el('pin').value='';el('pin').focus()};
el('pin').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();el('psend').click()}});
el('pmic').onclick=()=>{const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR){setSt('Voice input works in Chrome or Edge. Type instead.','warn');return}
  if(prRec){const r0=prRec;prRec=null;try{r0.stop()}catch(_){}el('pmic').classList.remove('on');return}
  const r=new SR();r.continuous=true;r.interimResults=false;r.lang='en-US';r.onresult=e=>{if(window.speechSynthesis&&speechSynthesis.speaking)return;for(let i=e.resultIndex;i<e.results.length;i++)if(e.results[i].isFinal)prSend(e.results[i][0].transcript)};
  r.onend=()=>{if(prRec===r&&practiceOn)try{r.start()}catch(_){}};prRec=r;try{r.start()}catch(_){}el('pmic').classList.add('on')};
let known=new Set(),defTitle=document.title;place();mq.addEventListener&&mq.addEventListener('change',place);
function beep(){try{const C=window.AudioContext||window.webkitAudioContext,c=new C(),o=c.createOscillator(),g=c.createGain();o.frequency.value=880;g.gain.value=0.08;o.connect(g);g.connect(c.destination);o.start();setTimeout(()=>{o.stop();c.close()},350)}catch(_){}}
async function poll(){let q;try{q=await (await fetch('/admin/dialer/queue')).json()}catch(_){return}if(!q||!q.leads)return;
  const inc=q.leads.filter(l=>!known.has(l.id));q.leads.forEach(l=>known.add(l.id));
  const fresh=inc.filter(l=>l.stage==='new'&&(Date.now()-new Date(l.created_at))<3600000);if(!fresh.length)return;
  fresh.forEach(l=>{l.fresh=true});
  const atEnd=ix>=Q.length;const at=atEnd?Q.length:Math.min(ix+1,Q.length);Q.splice(at,0,...fresh);
  if(atEnd){drawLead()}drawQ();beep();document.title='(New lead) '+defTitle;
  nb={names:fresh.map(l=>$(l.name||pretty(l.phone))).join(', '),id:fresh[0].id};bannerDraw()}
let nb=null;
function bannerDraw(){const b=el('newb');if(!nb){b.hidden=true;return}const busy=state==='live'||state==='connecting',i=Q.findIndex(x=>x.id===nb.id);if(i<0||i<ix&&!busy){nb=null;b.hidden=true;return}
  b.hidden=false;b.innerHTML='<span><b>New lead:</b> '+nb.names+' is next in line.</span>'+(busy||i===ix?'':'<button class="btn g sm" id="gonew" type="button">Go to it now</button>');
  const g=el('gonew');if(g)g.onclick=()=>{if(state==='live'||state==='connecting')return;ix=i;state='idle';el('after').hidden=true;nb=null;b.hidden=true;document.title=defTitle;drawLead();drawQ();window.scrollTo({top:0})}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)document.title=defTitle});
async function init(){
  try{const s=await (await fetch('/admin/dialer/settings')).json();if(s.success){ST={tint:s.tint,coating:s.coating,missed:s.missed}}}catch(_){}
  await loadAudio();await coachStatus();await loadOffer();
  try{const q=await (await fetch('/admin/dialer/queue'+(QS.length?'?stages='+QS.join(','):'')+(WANT?(QS.length?'&':'?')+'lead='+WANT:''))).json();Q=q.leads||[];QC=q.counts||{};OPEN_BY={tint:((q.open||{}).tint||[]).map(d=>d.say),coating:((q.open||{}).coating||[]).map(d=>d.say)};if(WANT){WANT=0;try{history.replaceState(null,'','/admin/dialer')}catch(_){}}}catch(_){}
  ix=0;Q.forEach(l=>known.add(l.id));drawQF();drawLead();drawQ();drawScript();setInterval(poll,10000);el('hrs').textContent=inHours()?'':'Calling hours are 8 AM to 9 PM Eastern.';
  await initDev()}
init();
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// ---- Live call coach, phase 1: Twilio sends both sides of a dialer call here (one Durable Object per call), each side is transcribed live by Deepgram,
// and the words are pushed to the Dial page over a WebSocket. The audio never goes through the browser. Needs DEEPGRAM_API_KEY.
const coachEnabled = env => !!(env.COACH && env.DEEPGRAM_API_KEY);
// ---- AI coach: answers what the lead just said, using only the owner's imported script and offer ----
const COACH_MODEL_DEFAULT = "claude-haiku-5-5";
const coachAi = env => !!env.ANTHROPIC_API_KEY;
const coachSvc = service => { const s = String(service || ""); return /tint/i.test(s) ? "tint" : /coat|ceramic|correct|polish|detail/i.test(s) ? "coating" : ""; };
function coachVar(name, o, lead, svc) {
  const dflt = { shop: "Divine Detailers", address: "5181 NW 74th Ave, Miami, FL 33166", area: "Miami", rep: "Bronson" };
  const g = k => (o[k] !== undefined && o[k] !== "" ? o[k] : dflt[k]);
  const n = x => Number(String(x || "").replace(/[^0-9.]/g, "")) || 0, m = x => "$" + Number(x).toLocaleString("en-US");
  const price = () => { const v = lead && lead.value > 0 ? lead.value : n(svc === "coating" ? o.coatPrice : (o.tintPrice || 299)); return v > 0 ? Math.round(v) : 0; };
  const dep = () => n(svc === "coating" ? o.coatDeposit : o.tintDeposit) || 50;
  switch (name) {
    case "rep": case "shop": case "address": case "area": return g(name) || "";
    case "special": return o.special || "";
    case "price": return price() ? m(price()) : "";
    case "reg": return n(o.coatReg) ? m(n(o.coatReg)) : "";
    case "dep": return dep() ? m(dep()) : "";
    case "otd": return price() && dep() ? m(Math.max(0, price() - dep())) : "";
    case "yrs": return String(n(o.coatYears) || 5);
    case "floor": return m(n(o.tintFloor) || 274);
    case "days": { if (!o.specialEnd) return ""; const d = Math.round((Date.parse(o.specialEnd + "T00:00:00Z") - Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z")) / 864e5); return d >= 0 ? String(d) : ""; }
  }
  return "";
}
function coachScriptText(sc, o, lead, svc) {
  const sw = t => { let x = String(t || ""); for (const p of (o.swaps || [])) if (p && p.f) x = x.split(p.f).join(p.t || ""); return x; };
  const f = t => coachOwner(sw(t), svc).replace(/\{(\w+)\}/g, (_, k) => coachVar(k, o, lead, svc) || "[not set]").replace(/\[\[([^\]]+)\]\]/g, (_, k) => "<" + k.toLowerCase() + ">");
  const node = nd => {
    if (!nd) return "";
    if (nd.k === "outcomes") return (nd.opts || []).map(op => "IF " + f(op.cond) + ":\n" + (op.nodes || []).map(node).filter(Boolean).join("\n")).join("\n");
    if (nd.k === "cond") return "IF " + f(nd.t) + ":";
    if (["ret", "pill", "router"].includes(nd.k)) return "";
    const tag = { say: "SAY", resp: "SAY", obj: "LEAD SAYS", probe: "ASK", coach: "NOTE", ex: "EXAMPLE (style only)" }[nd.k] || "SAY";
    const ps = (nd.ps || []).map(x => x.note ? "NOTE: " + f(x.note) : tag + ": " + f(x.t)).join("\n");
    const li = (nd.list || []).map(i => "- " + i.h + ": " + f(i.t)).join("\n");
    return [ps, li].filter(Boolean).join("\n");
  };
  const out = [];
  const skip = String((svc === "coating" ? o.coatSkip : o.tintSkip) || "").split(/[\s,]+/).filter(Boolean);
  for (const st of (sc.steps || []).filter(x => !skip.includes(x.id))) {
    out.push(`## STEP ${st.id}${st.n ? " (#" + st.n + ")" : ""} - phase ${st.phase || ""}`);
    out.push((st.main || []).map(node).filter(Boolean).join("\n"));
    if (st.side && st.side.length) out.push("If it comes up here:\n" + st.side.map(node).filter(Boolean).join("\n"));
    if (st.examples && st.examples.length) out.push(st.examples.map(node).filter(Boolean).join("\n"));
  }
  for (const pl of sc.plays || []) { out.push(`## PLAYBOOK ${pl.id} - ${pl.title}`); out.push((pl.nodes || []).map(node).filter(Boolean).join("\n")); }
  return out.join("\n");
}
// The imported script as a short ordered outline: one entry per step with the main line the rep says. The server uses it to keep track of where the call is.
function coachSteps(sc, o, lead, svc) {
  if (!sc || !Array.isArray(sc.steps)) return [];
  const sw = t => { let x = String(t || ""); for (const p of (o.swaps || [])) if (p && p.f) x = x.split(p.f).join(p.t || ""); return x; };
  const veh = lead ? [lead.year, lead.make, lead.model].filter(Boolean).join(" ") : "";
  // the car is already on file: confirm it, do not ask for it ("Man, you just told me. Toyota Camry 2010.")
  const known = t => veh ? t.replace(/what(?:[’']s| is) the year,? make,? (?:&|and) model\??/i, "I have you down for a " + veh + ", is that right?") : t;
  const f = t => known(coachOwner(sw(t), svc).replace(/\{(\w+)\}/g, (_, k) => coachVar(k, o, lead, svc) || "").replace(/\[\[([^\]]+)\]\]/g, (_, k) => "<" + k.toLowerCase() + ">").replace(/\s+/g, " ").trim());
  const skip = String((svc === "coating" ? o.coatSkip : o.tintSkip) || "").split(/[\s,]+/).filter(Boolean), out = [];
  for (const st of sc.steps.filter(x => x && !skip.includes(x.id))) {
    const lines = [], all = [];
    for (const nd of st.main || []) if (nd && ["say", "probe", "resp"].includes(nd.k || "say")) {
      for (const x of nd.ps || []) if (x && x.t && !x.note && !/^if\b/i.test(x.sub || "")) { lines.push(f(x.t)); all.push(f(x.t)); }
      for (const i of nd.list || []) if (i && i.t && !(svc === "coating" && /windshield|wheel coating/i.test(String(i.h || "") + " " + i.t))) all.push((i.h ? f(i.h) + ": " : "") + f(i.t));
    }
    const q = lines.join(" ").slice(0, 260), full = all.join(" ").slice(0, 1200);
    // A long step (the recap, the prep, the coating, the deposit) is a passage: the card shows it word for word instead of the AI paraphrasing or skipping it.
    // Lines that conflict with the owner's rules (free add-ons other than the interior detail, "the next week or two") are left to the AI, which applies those rules.
    const passage = full.length > 170 && !/week or two/i.test(full);
    if (q) out.push({ id: String(st.id), phase: String(st.phase || ""), q, full, passage });
  }
  return out;
}
// Fill the blanks of a script passage (<color>, <problem>, <solve their problem>, <year make model>, <name>) from what is known about this lead and this call.
function coachFill(text, facts, car, name) {
  const f = facts || {}, veh = [car && car.year, car && car.make, car && car.model].filter(Boolean).join(" ");
  return String(text || "").replace(/<([^<>]{2,60})>/g, (m, k) => {
    k = k.toLowerCase(); let v = "";
    if (/solve/.test(k)) v = f.solve; else if (/problem|reason/.test(k)) v = f.problem;
    else if (/color/.test(k) && /year|make|model|vehicle|car/.test(k)) v = [f.color, veh].filter(Boolean).join(" ");
    else if (/color/.test(k)) v = f.color; else if (/year|make|model|vehicle/.test(k)) v = veh; else if (/^name$|first name|lead/.test(k)) v = String(name || "").split(/\s+/)[0];
    return v ? String(v) : "___";
  });
}
const KNOWLEDGE_DEFAULT = `BUSINESS
- Divine Detailers, 5181 NW 74th Ave, Miami, FL 33166. Open Monday to Saturday, 9:00 AM to 6:00 PM. Closed Sunday. Phone (786) 757-2826. Email info@divinedetailers.com.
- Services: window tint, ceramic coating, paint correction, paint protection film (PPF) and vinyl wraps. Tint and ceramic coating are marketed separately, so a caller is about one or the other.

PRICES (typical, from recent calls; the lead's own quote and the OFFER override these, and the special changes often)
- Sides and rear on a sedan: $299 special. SUV: about $349 to $399. Minivan or truck: about $499. Windshield add-on: $179. Visor strip: $99. Old tint removal is quoted by vehicle: say the installer will confirm the exact removal cost.

BOOKING AND MONEY
- The deposit is $50 for both tint and ceramic coating, and it is refundable.
- The ceramic coating special includes a free interior detail. That is the only free extra. There are no free windshield coatings, wheel coatings or any other free add-ons with any service: never offer them, even if a script line mentions them.

WINDOW TINT
- Film: XPEL PRIME XR PLUS, a nano-ceramic window film. It is non-metallic.
- Time: about 2.5 hours for a tint job, about 4 hours when old tint has to be removed first.
- Published XPEL figures (the owner has not confirmed exact numbers, so say "up to" and do not quote a specific total-heat number): blocks over 99% of UV; very high infrared (heat) rejection, published as up to roughly 96 to 98 percent depending on the shade.
- Warranty: the tint comes with a lifetime warranty. It covers film defects such as bubbling, peeling and fading. For any other warranty detail, say the installer will go over it.
- Quality check: every window is checked under a very bright light before the car goes back to the customer.
- Benefits of ceramic tint: keeps the car noticeably cooler and the AC works less; blocks over 99% of UV, which protects skin and stops the interior fading and cracking; cuts glare; adds privacy; very clear; does not fade or turn purple the way cheap dyed film can.
- Signal: ceramic tint is non-metallic, so it does not interfere with cell phone, GPS, radio or Bluetooth signals. Cheap metalized film can, which is not what we install.
- Windshield: we do tint the windshield. In Florida only a non-reflective strip above the AS-1 line (the small marking near the top of the windshield) is allowed without a medical exemption.
- Shade: the customer chooses the shade, including darker film. Always tell them the Florida limits briefly so a ticket never surprises them, and never say a shade is legal when it is not. If they are unsure, we show the shade card at drop-off.
- Florida limits, general information (the installer confirms the exact vehicle; VLT is how much light gets through, so a higher number is lighter): front side windows at least 28%; rear side windows and rear window on a sedan at least 15%; rear side windows and rear window on an SUV or van as dark as 6%; reflective or mirror-like films have limits too. Medical exemptions exist. If the caller is not sure what shade to pick, we show the shade card at drop-off.
- After install (general guidance): a little haze or tiny water spots for a few days to a couple of weeks is normal while the film cures. Do not roll the windows down for a few days.

CERAMIC COATING
- Our ceramic coating comes from Ceramic Coating Inc. Right now we offer the 5-year coating warranty only. Do not mention any other length.
- Paint correction is included with the ceramic coating.
- Time: 24 hours. The car stays with us for a day.
- What it is: a liquid layer that bonds to the paint's clear coat. Water beads and rolls off, the car washes easier, and the paint looks glossier and deeper. It helps protect against UV, bird droppings, bug acids, tree sap and water spots.
- What it is not: not scratch-proof. It does not stop rock chips, dings or deep scratches (paint protection film does that). The car still needs washing.
- Paint correction: polishing that removes swirl marks, light scratches and oxidation. It is done before the coating because a coating locks in whatever is on the paint. Scratches that go through the clear coat cannot be fully polished out.
- Coating versus wax: wax lasts weeks to a few months; a coating lasts years.
- Care (general guidance): hand wash with a pH-neutral soap, avoid brush-style automatic car washes, and wait about a week after coating before the first wash.

PAINT PROTECTION FILM (PPF)
- A clear urethane film applied over the paint. It takes the hit from rock chips and road debris, and light scratches in it can heal with heat.

PLAIN-ENGLISH WORDS FOR NEW REPS
- VLT: how much light passes through the tint. Higher is lighter. 5% is very dark, 35% is medium, 70% is very light.
- Infrared (IR): the part of sunlight that creates most of the heat you feel.
- UV: the sunlight rays that damage skin and fade interiors.
- AS-1 line: the marking near the top of the windshield.
- Clear coat: the protective top layer of the paint.
- Swirl marks: tiny circular scratches in the clear coat, most visible in sunlight.
- Hydrophobic: repels water.
- Cure: the time film or coating needs to settle and harden fully.

ALWAYS
- If a fact is not in the SCRIPT, OFFER or this list, do not state it. Say "good question, let me confirm that and get right back to you".`;
const COACH_RULES = `You are a real-time call coach whispering to a sales rep at Divine Detailers, a car detailing shop that sells window tint, ceramic coating, paint correction, PPF and wraps. You see the live transcript of a phone call with a lead. Every time the lead finishes speaking, you write the exact words the rep says next. The rep reads your words aloud while the lead waits, so you ALWAYS give an answer: there is no case where you stay silent, refuse, or return an empty "say".

Ground rules:
- Use ONLY facts that appear in the SCRIPT, OFFER or SHOP FACTS below. Never invent prices, warranties, brands, durations, guarantees, discounts or claims. If a value shows [not set], do not state a number: say you will confirm it. If the lead asks something the script does not cover, set "needs_eyes" true and give a safe line such as "Good question, let me confirm that for you."
- Inside "say", acknowledge what the lead said and add one short real comment taken from the script, in the script's own wording adapted to what they actually said. Answer the question first; do not read the script aloud blindly.
- Be brief and fast. "say" is what the rep says out loud: at most 2 short sentences (about 25 words), plain spoken English, no lists. If the lead speaks Spanish, answer in Spanish.
- "ask" is ONE short question (at most 15 words), chosen in this order: (1) the script's or PLAYBOOK's own follow-up for what the lead just said (an objection's qualifying question, or the "If yes" / "If no" follow-up to the question the rep just asked); otherwise (2) the NEXT STEP from CALL PROGRESS when it is given: use that step's question in the script's wording, shortened to fit and bridged naturally from what the lead just said. CALL PROGRESS is the system's record of the whole call, so trust it over your own reading of the last few lines; never go back to a finished step. If there is no CALL PROGRESS, use the next question from the script that the lead has not answered yet (a NEXT SCRIPT LINE, when given, is only a hint and can be wrong).
- Follow the script's order. The call goes opener, discovery, recap, pitch (the prep, the coating), timing, price, booking, deposit. Never skip ahead: no price, dates or booking talk while CALL PROGRESS shows discovery, the recap or the pitch still to come, unless the lead asks for it directly. A.C.A. (acknowledge, comment, ask) is the shape of every discovery answer; objections get empathy, then the script's qualifying question, then the answer; the price is said once and then you stop; the close is assumptive ("debit or credit?").
- Sound like a person who has been listening, not like a script that was handed the lead's file. When WHAT THIS LEAD HAS TOLD US is given and a note truly fits the moment, you may use it in your comment in the lead's own words ("since you're running it through the car wash every week..."), but in at most one answer out of three, and never the same detail twice. Do not keep naming the car, its color, or a joke the lead made: say it once on the whole call, then say "it" or "the car". If the lead jokes or tests you, one light line back is enough; do not repeat the joke in later answers. Match the lead's energy: relaxed with a relaxed lead, quick with a rushed one. Do not open every answer the same way ("Great question", "Got it"): vary it, and often just react to what they said.
- Small talk, a joke or a story from the lead gets one warm, real line back first, then the question. Do not skip the human moment to get to the script, and do not stay in it for more than one line.
- Free extras: the ceramic coating special comes with a free interior detail and nothing else free. Never say "free windshield coating", "free wheel coating" or a dollar value of free add-ons, even where the SCRIPT has such a line: say "a free interior detail" in its place. Tint has no free extras.
- Timing and the special (the owner's rule, it overrides the script's wording): first get the date the lead wants, with an open question ("How soon were you looking to get it done?"). Do not list calendar days at this point and do not say the special needs a booking within a week or two. Whatever date they give, this week, next month or later, the next thing "say" does is confirm it: "Perfect, that date does qualify for the coating special." Then move on to the price step. Never tell a lead their date does not qualify, never push them to an earlier date, and if they change the date later, the new date qualifies too. Offer specific open days only at the booking step, after they have agreed to the price, and only if they have not already named a day.
- "say" never contains a question. Every question goes in "ask", and "ask" is exactly one question with nothing after it.
- Take the lead's answer as given. When the lead names a day, a time, a car, a color or a preference, accept it and move to the next step. Never ask them to confirm what they just said ("is next month the timing you're leaning toward?"), never offer other options after they chose one, and never ask for something the Lead line or the transcript already gives you (the car, the color).
- Names are written by ear in the transcript and often differ from the name on file (Jessalyn for Jeceline). It is the same person. Never ask the lead to confirm or spell their name and never apologize about the name, unless the lead says you have the wrong person.
- Never give anything away. Do not agree to waive, cover, split or lower the deposit or the price, and do not promise gifts or favours, even as a joke the lead started ("you cover the down payment and bring a six pack"): laugh it off in a few words and restate the real terms.
- When the Lead line gives the vehicle, do not ask for the year, make or model: confirm it in a few words ("I have you down for a 2010 Toyota Camry, right?") and ask only for what is missing (the color).
- Use the lead's first name rarely: at the hello and at the close, not in every answer.
- Never ask the same question twice. Each answer must move the call one step forward. When QUESTIONS ALREADY PUT TO THE LEAD is given, your "ask" must be a different question from every line in it, normally the next one in the script after the last one listed.
- A short reply such as "yes", "yeah", "no", "not really", "a little" or "I guess" is the lead's answer to REP JUST SAID. Acknowledge that answer in a few words, add one short comment that fits it, and ask the script's follow-up for that answer (the "If yes" or "If no" branch) or the next unanswered question. Never treat a short reply as nothing.
- Objections: use the matching PLAYBOOK's opening moves (empathy, then the qualifying question), not a hard close.
- The transcript is live speech-to-text over a phone line and contains mistakes: similar-sounding words (tint heard as tent, coating as coding, XPEL as expel), wrong car names, garbled numbers. Work out what the lead most likely meant from the car-detailing context. If a word that matters (a price, a date, a car, which service) is unclear, or the line is marked unclear audio, make "say" a short clarifying question ("Sorry, did you say the sides and the back?") instead of guessing.
- When the lead says they do not know about the product ("I don't know anything", "not really", "no idea", "never heard of it", "what is that"), always step in: this is not a normal answer. "say" is a warm one-breath reassurance plus a plain-English explanation of the product in at most two short sentences (what it is and the main benefit: protection, gloss, easier washing for a coating; heat, privacy, UV for tint), using only wording and facts from the SCRIPT, OFFER or SHOP FACTS, with no numbers or claims that are not there. "ask" is then the next unanswered question from the script so the call keeps moving.
- Your answer is the main thing the rep reads. Answer everything: a question (even one the script covers), confusion or a request to repeat ("hello?", "what?", "wait, what is that?"), "I don't know", an objection or worry, a comparison, an off-topic remark or story, a joke, a complaint, new information that changes the plan, an unusual request, a buying signal, and also a plain answer to the rep's question (acknowledge it, comment, ask the next question).
- Price questions ("how much", "what does it cost"): do not state a dollar amount the first time it is asked, unless the call is already at the script's price step. Acknowledge, say that with the special it is a lot less than the normal price, and say the price depends on when they would like to book, then ask when they would like to get it done. Example: "Great question, with the special it's a lot less than our normal price. The price depends on when you'd like to book, so what day were you thinking?" Give the exact number only when the lead asks again, presses for it, or the call has reached the script's price step. Use only the amounts in the OFFER.
- "I don't have much time" / "I'm busy" / "I'm at work": follow the script's own answer. Acknowledge it and ask permission to keep it quick ("No problem, how about I keep this quick for the both of us?"). Once they agree, carry on with the NEXT STEP exactly as normal, just with short lines. Do NOT jump to the price, the date or the booking because they are short on time: the discovery questions and the recap are what make the price make sense. If they still cannot talk, set an exact callback time. Only when they demand the number outright a second time ("just give me the price") give the price from the OFFER in one line, then return to the next step.
- "I'm not interested" / "no thanks" / "I don't need it": never give up and never argue. Acknowledge it warmly, then ask one soft curious question to find the real reason ("Totally fair. Was it the price, or just not sure it's right for the car?"), using any matching PLAYBOOK from the script. Do not stack the pitch.
- "I thought it was free" (or any surprise about cost): acknowledge the mix-up without blame, say what the special actually is using only wording from the SCRIPT or OFFER (the special is a lower price, not free), and ask whether they would still like to hear what it includes.
- "Just shopping around" or comparing prices: respect it ("Smart, you should compare"), and ask what they are comparing or what matters most (quality, warranty, price), then use only the script's own points about why the shop is different. Do not quote a number on the first ask.
- Always follow the shop's A.C.A. method in every answer: ACKNOWLEDGE what the lead said in a few words ("Yeah, black shows them the most"), COMMENT with one short remark from the script that fits what they actually said, then ASK one question. The acknowledge and comment go in "say", the question goes in "ask". Never skip the acknowledgment, never stack two questions, never fire questions back to back.
- A lead saying they have swirl marks, light scratches, dull spots or chips is a normal discovery answer: acknowledge it, comment briefly (for example that coating plus correction brings the gloss back), and ask the next question. Use the "not scratch proof" explanation only when the lead mentions deep scratches or asks whether the coating stops or prevents scratches.
- When REAL ANSWERS from past calls are given, they show how this shop's best closers handled the same moment. Use their approach and tone in your own words. Never copy prices, names or claims from them: {amount} and {shop} are blanks, and the OFFER always wins.
- Closing tactics that won on hundreds of real calls: (1) state the deposit as coming off the total and give the out-the-door number, then ask "debit or credit?" instead of "if that's okay" or "does that sound good?"; (2) offer both ways to pay in one breath: card over the phone, or a secure link they can Apple Pay; (3) if payment hits a snag, stay on the line ("I'll wait") instead of letting them go; (4) after any "okay", "sounds good" or a named date, stop pitching, lock the date and take the deposit; (5) never accept "call us when you're ready": hold the slot with the deposit link or set an exact time; (6) when the quote is higher than the ad, explain the scope first (vehicle size, extra windows, removal) and then give the number; (7) give a reason or a trade for a lower price (drop an add-on, a lever the OFFER allows), never an unprompted or stacked discount; (8) when a spouse, partner or parent has to approve, ask what questions they would have, answer them now, and hold the date with the refundable deposit; (9) never mention quotas, being desperate, or "that's just our policy"; (10) never improvise legal limits, windshield rules or film numbers: use only the SHOP FACTS, otherwise say the installer will confirm.
- Closing: the goal of a call is a deposit AND a specific date. When the lead shows a buying signal (agrees to the price, asks about dates, payment or how it works, says it sounds good), do not ask "how does that sound": offer a way to pay (a secure link or the card over the phone) and a specific day. Never accept "I'll call you back" before trying to hold the spot with the deposit; if a callback is still the outcome, set an exact day and time. A lead who only needs time gets a specific follow-up time, not "whenever".

Reply with ONLY one JSON object, no markdown and nothing before or after it, with the keys in exactly this order (the rep sees "say" the moment it is written):
{"say": "...", "ask": "...", "needs_eyes": false}`;
// one tiny request so the owner can confirm the key, model and network work without placing a call
async function coachAiTest(env) {
  if (!coachAi(env)) return json({ ok: false, message: "The ANTHROPIC_API_KEY secret is not set in Cloudflare yet." });
  const model = env.COACH_MODEL || COACH_MODEL_DEFAULT;
  try {
    const ctx = await coachContext(env, null, "tint");
    const user = `${ctx.facts}\n\nRecent transcript:\nREP: Hey Alex, it's the rep from Divine Detailers. How are you doing today?\nLEAD: Good. How much is it for the whole car?\n\nNEXT SCRIPT LINE: "What are you driving?"\n\nThe lead just finished saying: "how much is it for the whole car"\nReturn the JSON.`;
    const runs = [];
    for (let i = 0; i < 2; i++) {
      const r = await coachStream(env, ctx.system, user, null);
      if (r.error) return json({ ok: false, model, status: r.error, message: r.error === 401 || r.error === 403 ? "Anthropic refused the key." : "The request failed (" + r.error + ")." });
      const u = r.usage || {};
      runs.push({ first: r.ms.first, say: r.ms.say, total: r.ms.total, cache_read: u.cache_read_input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0, input: u.input_tokens || 0 });
    }
    const sec = n => n == null ? "?" : (n / 1000).toFixed(1) + "s";
    return json({ ok: true, model, runs, message: `Coach speed: the first words appear in ${sec(runs[1].say)} and the full answer in ${sec(runs[1].total)} (first try ${sec(runs[0].say)} / ${sec(runs[0].total)}). Add about 0.3s for the lead to be recognised as finished.` });
  } catch (e) { return json({ ok: false, model, message: "Could not reach Anthropic from Cloudflare." }); }
}
// Owner-only: what the coach did on recent calls, one row per lead remark (why it stayed quiet, how long each stage took, whether the cache was used)
async function coachTurnsLog(env, url) {
  await ensureTable(env.DB);
  const sid = url.searchParams.get("sid") || "", lim = Math.min(500, Number(url.searchParams.get("n")) || 200);
  const rows = await (sid ? env.DB.prepare("SELECT * FROM coach_turns WHERE call_sid = ? ORDER BY id DESC LIMIT ?").bind(sid, lim) : env.DB.prepare("SELECT * FROM coach_turns ORDER BY id DESC LIMIT ?").bind(lim)).all().then(r => r.results || []).catch(() => []);
  const sh = rows.filter(r => r.outcome === "shown" && r.shown_ms != null).map(r => r.shown_ms).sort((x, y) => x - y), pct = q => (sh.length ? sh[Math.min(sh.length - 1, Math.floor(sh.length * q))] : null);
  const count = k => rows.filter(r => r.outcome === k).length;
  return json({ success: true, build: COACH_BUILD, summary: { rows: rows.length, shown: count("shown"), backup: count("backup"), skipped: count("skipped"), restarted: count("restarted"), heard_to_screen_ms: { p50: pct(0.5), p90: pct(0.9) }, cache_misses: rows.filter(r => r.outcome === "shown" && !r.cache_read).length }, rows });
}
async function coachContext(env, leadId, forceSvc, fakeLead) {
  await ensureTable(env.DB);
  const lead = fakeLead || Number.isInteger(leadId) ? await env.DB.prepare("SELECT id, name, service, year, make, model, value, message FROM leads WHERE id = ?").bind(leadId).first() : null;
  const svc = coachSvc(lead && lead.service) || forceSvc || "";
  const rows = await env.DB.prepare("SELECT k, v FROM dial_settings WHERE k IN ('offer', ?)").bind("script_" + (svc || "none")).all().then(r => r.results || []).catch(() => []);
  const get = k => { const r = rows.find(x => x.k === k); try { return r ? JSON.parse(r.v) : null; } catch (_) { return null; } };
  const offer = get("offer") || {}, sc = svc ? get("script_" + svc) : null;
  const facts = lead ? `Lead: ${lead.name || "unknown"}. Service tag: ${lead.service || "unknown"}. Vehicle: ${[lead.year, lead.make, lead.model].filter(Boolean).join(" ") || "unknown"}. Quoted job value: ${lead.value > 0 ? "$" + lead.value : "not set"}.` : "Lead: unknown.";
  const odP = openDays(env, 4, svc === "coating" ? "coating" : "tint").catch(() => []);
  const libP = svc ? env.DB.prepare("SELECT lead_said, rep_response, better, quality, priority, won FROM call_library WHERE svc IN (?, 'other') ORDER BY priority DESC LIMIT 2500").bind(svc).all().then(r => r.results || []).catch(() => []) : Promise.resolve([]);
  const offerText = ["rep", "shop", "address", "area", "special", "price", "reg", "dep", "otd", "yrs", "floor", "days"].map(k => `${k}: ${coachVar(k, offer, lead, svc) || "[not set]"}`).join("\n");
  const system = COACH_RULES + `\n\nOFFER (values the rep may say):\n${offerText}\n\nSHOP FACTS (confirmed by the owner; the rep may state these):\n${String(offer.knowledge || KNOWLEDGE_DEFAULT)}\n\nSCRIPT (${svc || "no script for this service"}):\n` + (sc ? coachScriptText(sc, offer, lead, svc) : "(No script has been imported for this service. Only give generic, safe, non-factual guidance, and set needs_eyes true for any factual question.)");
  let steps = []; try { steps = coachSteps(sc, offer, lead, svc); } catch (e) { /* the coach still works from the script text */ }
  const ctx = { system, facts, svc, lib: [], steps, body: system.slice(COACH_RULES.length), price: String(coachVar("price", offer, lead, svc) || "").replace(/[^0-9]/g, ""), car: lead ? { year: lead.year, make: lead.make, model: lead.model } : null, name: lead ? lead.name : "" };
  // The calendar (an outside service) and the answer library are slow and the first answer does not need them: they fill in as soon as they arrive.
  const fill = Promise.all([
    odP.then(od => { if (od && od.length) ctx.facts += `\nOpen days on our calendar right now (ONLY for the booking step, after the lead has agreed to the price, and only if the lead has not named a day of their own): ${od.map(d => d.say).join(", ")}.`; }),
    libP.then(l => { ctx.lib = l; }),
  ]).catch(() => {});
  await Promise.race([fill, new Promise(r => setTimeout(r, 250))]);
  return ctx;
}
// One streamed request to the coach model. onSay fires the moment the "say" line is complete, so the rep can start talking before the rest has been written.
let coachThinkOff = true; // set to false for the rest of this isolate if the model refuses "thinking: disabled"
async function coachStream(env, system, user, onSay, opts) {
  const o = opts || {};
  const t0 = Date.now(), ms = {}, ac = new AbortController(), timer = setTimeout(() => ac.abort(), o.timeout || 12000);
  if (o.signal) { if (o.signal.aborted) ac.abort(); else o.signal.addEventListener("abort", () => ac.abort()); }
  try {
    // The live coach must not "think" before it writes: on the default setting the model spends its whole token limit reasoning and the answer never arrives.
    // o.think keeps thinking on (used only for the after-call practice score). If a model refuses the setting, fall back to thinking with a much larger limit.
    const send = off => fetch(`${env.ANTHROPIC_BASE || "https://api.anthropic.com"}/v1/messages`, {
      method: "POST", signal: ac.signal,
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: env.COACH_MODEL || COACH_MODEL_DEFAULT, max_tokens: off || o.think ? (o.max || 300) : Math.max(2000, o.max || 300), stream: true, output_config: { effort: o.effort || "low" }, ...(off ? { thinking: { type: "disabled" } } : {}),
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: user }] }),
    });
    const off = coachThinkOff && !o.think;
    let r = await send(off);
    if (r.status === 400 && off) { coachThinkOff = false; r = await send(false); }
    ms.think = off && r.ok ? 0 : 1;
    if (!r.ok) return { error: r.status, ms };
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "", text = "", usage = {}, said = false, stop = "";
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).split("\n").find(l => l.startsWith("data:")); buf = buf.slice(i + 2);
        if (!line) continue;
        let j; try { j = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (j.type === "message_start") usage = (j.message && j.message.usage) || {};
        else if (j.type === "message_delta") { usage = { ...usage, ...(j.usage || {}) }; if (j.delta && j.delta.stop_reason) stop = j.delta.stop_reason; }
        else if (j.type === "content_block_delta" && j.delta && j.delta.type === "text_delta") {
          if (ms.first == null) ms.first = Date.now() - t0;
          text += j.delta.text;
          if ((!opts || opts.abortFalse === true) && /"answer"\s*:\s*false/.test(text)) { ac.abort(); ms.total = Date.now() - t0; return { text: '{"answer":false}', usage, ms }; }
          if (!said) { const m = /"say"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text); if (m) { said = true; ms.say = Date.now() - t0; let say = m[1]; try { say = JSON.parse('"' + m[1] + '"'); } catch (e) { /* keep raw */ } if (onSay) onSay(say, ms.say); } }
        }
      }
    }
    ms.total = Date.now() - t0;
    return { text, usage, ms, stop };
  } catch (e) { ms.total = Date.now() - t0; return { error: ac.signal.aborted ? (o.signal && o.signal.aborted ? "aborted" : "timeout") : "failed", ms }; } finally { clearTimeout(timer); }
}
// What the lead has told us so far, in their own words, for the recap line ("you're interested in a coating because ___ ... it can definitely ___")
const FACTS_RULES = `You keep the running notes for a live car-detailing sales call. Use ONLY what was actually said on the call, plus the shop's own benefits from the SCRIPT or SHOP FACTS below. Reply with ONLY one JSON object, nothing before or after it:
{"problem": "", "solve": "", "color": "", "done": [], "lead": []}
- "problem": why the lead wants this, phrased to finish the sentence "you're interested in getting it because ____". Start with "you" and be specific, in their words: "you have swirl marks on the bumper", "you just bought the car and want to keep it protected", "you're sick of how hot the car gets". Keep the exact spot when they named one (bumper, hood, doors). If they said they have no swirls or scratches, use their answer to "what has you interested" instead. At most 18 words.
- "solve": how the service fixes that, phrased to finish "It can definitely ____". A verb phrase using only benefits from the SCRIPT or SHOP FACTS, matched to their problem: "bring that bumper back to looking new again", "keep the paint protected so washing is easy". At most 20 words.
- "color": the paint color if the lead said it, otherwise "".
- "done": the ids of the SCRIPT STEPS (listed in the message) that are finished. A step is finished when the rep said its line or asked its question in any wording, OR the lead already gave the information that step asks for, even without being asked. Do not mark a step finished just because of where it sits in the list. Copy the ids exactly.
- "lead": up to 8 short notes on what the lead has told us about themselves, the car and what they want, as close to their own words as possible, the most useful for rapport first: "parks outside under a tree", "runs it through the car wash every week", "keeping it about another year", "noticed the swirls a couple of months ago". Only things the lead said. No guesses, nothing the rep said.
- If the lead has not said enough yet, leave a field as an empty string or an empty list. Never invent anything. The transcript is live speech-to-text from a phone line and has mistakes (paint heard as pain, coating as coding): read through them.`;
const COACH_BUILD = "coach-pr8";
const COACH_ACK = /^((yeah|yes|yep|yup|ok|okay|uh[ -]?huh|mm+|m+hm+|sure|right|no|nope|nah|thanks|thank you|good|fine|cool|great|alright|all right|got it|i see|oh|correct|exactly|perfect|awesome|bye)[.!, ]*)+$/i;
const COACH_FILLER = /^((um+|uh+|hm+|mm+|ah+|er+|oh|so|and|well|like|you know)[.!, ]*)+$/i;
const COACH_INTENT = /\?|^(hello|what|huh|why|how|who|wait|sorry|pardon|hold on|excuse)\b|not interested|no thanks|no thank you|expensive|pricey|too much|how much|price|cost|free\b|busy|later|call (me )?back|not now|bad time|can'?t talk|driving|working|wrong number|stop calling|remove me|who is this|sounds good|let'?s do it|i'?ll take it|book it|sign me up|think about|no idea|don'?t know|espa[nñ]ol|spanish/i;
// an answering machine, call screening or a phone-company recording is not the lead: nothing to answer
const COACH_MACHINE = /record your name|if you record your|reason for calling|stay on the line|(person|party|caller|number|customer|subscriber)[^.]{0,40}(is )?(not available|unavailable)|leave (a|your|me a) (message|name)|after the (tone|beep)|voice ?mail|mailbox|is not in service|been disconnected|call has been forwarded|please hold|to continue in english|press (one|two|\d)\b|cannot be completed as dialed/i;
// The rep's own voice sometimes lands on the lead's side of the call (speakerphone, line echo). If most of what the "lead" said is word-for-word what the rep
// just said or what the card on screen says, it is an echo, not the lead.
function coachEcho(text, ref) {
  const w = t => String(t || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean), a = w(text), b = w(ref);
  if (a.length < 5 || b.length < 5) return false;
  const pairs = new Set(); for (let i = 0; i < b.length - 1; i++) pairs.add(b[i] + " " + b[i + 1]);
  let hit = 0; for (let i = 0; i < a.length - 1; i++) if (pairs.has(a[i] + " " + a[i + 1])) hit++;
  return hit / (a.length - 1) >= 0.65;
}
// how long to wait after the lead goes quiet: a question is done; a finished sentence may have another one behind it; a sentence left hanging certainly does
function coachPause(text) {
  const t = String(text || "").trim();
  if (/\?["')\]]?$/.test(t)) return 250;
  if (/(\.\.\.|…|,|-)$/.test(t) || !/[.!]["')\]]?$/.test(t) || /\b(and|but|so|or|because|cause|like|the|a|an|to|of|for|with|my|your|i|if|when|that|which|you know|i mean|um|uh)[.,!]*$/i.test(t)) return 1100;
  return 450;
}
// are two lines the same question? (shared words, ignoring the small ones)
const COACH_STOP = new Set("the a an and or but so to of for in on at is are do does did you your i it that this what how when where which would could can have has be with me my we our just any got great perfect awesome gotcha okay ok alright ceramic coating coated car special quick".split(" "));
const coachWords = t => [...new Set(String(t || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(x => x.length > 1 && !COACH_STOP.has(x)))];
// Are two short questions the same question? They must share most of their meaningful words in BOTH directions.
// (The earlier test divided by the shorter one and counted "ceramic", "coating" and "got", so "What got you interested in a coating?" was taken for
// "you got a quick second?" and never recorded: the coach then asked it again and the lead said "you just asked me that".)
function coachSame(a, b) {
  const x = coachWords(a), y = new Set(coachWords(b));
  if (!x.length || !y.size) return false;
  return x.filter(k => y.has(k)).length / Math.max(x.length, y.size) >= 0.6;
}
// Did the rep say this line? Most of the line's meaningful words must appear inside one stretch of the rep's speech.
function coachSaid(line, speech, min) {
  const x = coachWords(line), y = new Set(coachWords(speech));
  if (!x.length) return false;
  const n = x.filter(k => y.has(k)).length;
  return n >= Math.min(2, x.length) && n / x.length >= (min || 0.7);
}
// Owner's rule for the coating special: a free interior detail is the only free extra. Script lines that still promise free windshield and wheel coatings
// or "add ons" are rewritten before the AI sees them, and the AI's own words are checked again on the way out (the AI said it on real calls despite the rule).
function coachOwner(text, svc) {
  if (svc !== "coating") return String(text || "");
  return String(text || "")
    .replace(/So that[’']s \$\s?[\d,]+ in add[- ]?ons?,? free\.\s*/gi, "")
    .replace(/(the |those |these |two |2 |both )*free windshield\s*(and|&)\s*wheel coatings?/gi, "a free interior detail")
    .replace(/(the |those |these |two |2 |both |a couple of )+free add[- ]?ons?/gi, "a free interior detail")
    .replace(/\bfree add[- ]?ons?\b/gi, "free interior detail")
    .replace(/\b(the |those |these )?add[- ]?ons?\b/gi, "the free interior detail")
    .replace(/\b(free )?(windshield|wheel) coatings?\b/gi, "free interior detail")
    .replace(/a free interior detail(,? (and|&|plus) a free interior detail)+/gi, "a free interior detail");
}
const coachFirst = t => { const m = /^[^.!?]+[.!?]+["')\]]*/.exec(String(t || "").trim()); return (m ? m[0] : String(t || "")).trim(); };
// One question per card, and it lives in "ask". The model often ends "say" with a question too (sometimes the same one), which made the rep ask twice.
function coachTidy(say, ask) {
  say = String(say || "").trim(); ask = String(ask || "").trim();
  const isQ = x => /\?["')\]]*\s*$/.test(x), parts = say.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [say];
  const keep = parts.filter(x => !isQ(x)).join(" ").replace(/\s+/g, " ").trim(), qs = parts.filter(isQ);
  if (qs.length) { if (keep) { say = keep; if (!ask) ask = qs[qs.length - 1].trim(); } else if (ask && coachSame(ask, say)) ask = ""; }
  const cut = ask.indexOf("?"); if (cut >= 0 && cut < ask.length - 1 && !isQ(ask.slice(cut + 1))) ask = ask.slice(0, cut + 1); // "Is this X? Great, it's..." keeps only the question
  return { say, ask };
}
// was this question (asked on the call) the question of this script step? Most of the question's meaningful words must be in the step's line. Only ever checked against the step the call is on.
function coachStepAsked(q, stepLine) { return coachSaid(q, stepLine, 0.7); }
// did the rep just ask something? (phone transcripts often drop the question mark, so the opening words count too)
const coachRepAsked = t => { const x = String(t || "").trim().slice(-200); return !!x && (/\?["')\]]?\s*$/.test(x) || /\b(do you|did you|are you|is it|is that|is this|what|how|when|where|which|would you|could you|can you|can i|have you|does it|were you|may i)\b[^.!?]*$/i.test(x)); };
// Returns "" when the remark needs an answer, otherwise the reason it is safe to stay quiet. The model is never asked to make this call.
function coachQuiet(said, repLast, afterAnswer) {
  const t = String(said || "").trim(), n = t.split(/\s+/).filter(Boolean).length, asked = coachRepAsked(repLast);
  if (!t) return "empty";
  if (COACH_FILLER.test(t)) return "filler";
  if (COACH_MACHINE.test(t)) return "machine";
  if (afterAnswer) return n < 3 && !COACH_INTENT.test(t) ? "tail" : ""; // a trailing word or two after the answer is already up ("...today")
  if (COACH_ACK.test(t)) return asked ? "" : "ack"; // "yeah" answers a question; "yeah" over the rep's own talking is just listening noise
  if (n < 3 && !COACH_INTENT.test(t)) return asked ? "" : "short";
  return "";
}
// last line of defense: if the AI cannot answer (service error, slow reply, unreadable reply) the rep still gets a safe answer for the common moments
function backupAnswer(said, pos) {
  const t = String(said || "").toLowerCase(), next = pos && pos.next ? String(pos.next).slice(0, 200) : "";
  const ans = (say, ask) => ({ answer: true, say, ask: ask || next, anchor: "", needs_eyes: false, note: "", answered: true, backup: true });
  if (/(how much|price|cost|quote|ballpark)/.test(t)) return ans("Great question, with the special it's a lot less than our normal price. The price depends on when you'd like to book.", "So how soon were you looking to get it done?");
  if (/(no time|not much time|don'?t have (too |much |a lot of )?time|bottom line|in a hurry|busy|have to go|got to go|gotta go|quick)/.test(t)) return ans("No problem, I'll keep this quick for the both of us.", next || "Is it okay if I ask two quick questions about the car?");
  if (/(free\b)/.test(t)) return ans("No worries, that's a common mix-up. It's a special price, not free, and it's a lot less than our normal price.", "Would you still like to hear what's included?");
  if (/(not interested|no thanks|no thank you|don'?t (want|need))/.test(t)) return ans("Totally fair, I appreciate you being upfront.", "Just so I understand, was it the price, or you're not sure it's right for the car?");
  if (/(shopping|shop around|lowest|cheapest|compare|looking around|other shop|another shop)/.test(t)) return ans("Smart to compare, you should.", "What are you comparing it to, and what matters most to you, the price or how long it lasts?");
  if (/(think about|wife|husband|girlfriend|boyfriend|talk to)/.test(t)) return ans("Makes sense, it's a decision you should feel good about.", "What's the main thing you'd want to think over?");
  if (/(what is|what's|don'?t know|no idea|never heard)/.test(t)) return ans("No worries, that's what I'm here for. A ceramic coating is a protective layer that bonds to your paint, keeps it glossy and makes washing easier.", "");
  return ans("Got it, thanks for telling me.", "");
}
// The transcript arrives in fragments (one per Deepgram segment). For the model, join back-to-back fragments from the same speaker into one turn.
function coachTurns(turns, max) {
  const out = [];
  for (const t of turns) { const l = out[out.length - 1]; if (l && l.who === t.who && l.text.length < 600) { l.text += " " + t.text; l.low = l.low || t.low; } else out.push({ who: t.who, text: t.text, low: t.low }); }
  return out.slice(-(max || 14));
}
async function coachAnswer(env, ctx, turns, said, pos, low, onSay, signal, repLast, asked, st) {
  const recent = coachTurns(turns, 14).map(t => `${t.who === "lead" ? "LEAD" : "REP"}${t.low ? " (unclear audio)" : ""}: ${t.text}`).join("\n");
  const real = libPick(ctx.lib, said, 2);
  const realText = real.length ? "REAL ANSWERS from past calls to something similar (best closers first):\n" + real.map((r, i) => `${i + 1}. Lead said: "${r.lead_said}"\n   ${r.won ? "Rep (the call booked)" : "Rep"}: "${r.rep_response}"${r.quality && r.quality < 4 && r.better ? `\n   Better answer: "${r.better}"` : ""}`).join("\n") + "\n\n" : "";
  // Questions the rep has already asked on this call (the coach gave them and the rep said them). The position hint from the browser often lags behind,
  // so a hint that points at one of these is dropped: otherwise the same question comes back again and again.
  const done = (asked || []).slice(-14), stale = pos && pos.next && done.some(q => coachSame(q, pos.next));
  const prog = st && st.prog, notes = (st && st.notes) || [], openers = (st && st.openers) || [];
  // the server's own record of the call wins over the browser's position hint, which is only used until the first notes exist
  const nextText = prog && prog.next && prog.next.passage ? `CALL PROGRESS (kept by the system from the whole call)\nFinished steps: ${prog.done.join(", ") || "none"}\nNEXT STEP ${prog.next.id} is a SCRIPT PASSAGE. The card will show it word for word under your line, and the rep reads it: "${prog.next.q.slice(0, 160)}..."\nIf the lead's remark is a plain answer, an agreement, small talk or "no questions": write ONLY a short bridge in "say" (at most 12 words: acknowledge what they said, nothing from the passage, no pitch) and leave "ask" as an empty string. If the lead asked a question or raised an objection: handle it as usual with your own "ask"; the passage waits for the next turn.\n\n`
    : prog && prog.next ? `CALL PROGRESS (kept by the system from the whole call)\nFinished steps: ${prog.done.join(", ") || "none"}\nNEXT STEP ${prog.next.id}${prog.next.phase ? " (" + prog.next.phase + ")" : ""}: "${prog.next.q}"\n\n`
    : prog && !prog.next ? "CALL PROGRESS: every script step is finished. Close: confirm the day, take the deposit, wrap up.\n\n"
    : pos && pos.next && !stale ? `NEXT SCRIPT LINE${pos.step ? " (" + pos.step + ")" : ""}: "${pos.next}"\n\n` : "";
  const notesText = notes.length ? "WHAT THIS LEAD HAS TOLD US (their words):\n" + notes.map(x => "- " + x).join("\n") + "\n\n" : "";
  const says = (st && st.says) || [];
  const openText = (says.length ? "YOUR LAST ANSWERS (the lead has already heard these: do not reuse their opening word, their phrases, their jokes or the details they mention):\n" + says.map(x => "- " + x).join("\n") + "\n" : "")
    + (openers.length ? `Do not begin with ${openers.map(x => '"' + x.split(" ")[0] + '"').join(" or ")}.\n` : "")
    + (st && st.noCar ? "You named the car or its color in a recent answer. In THIS answer do not mention the make, model, year or color at all: say \"it\" or \"the car\".\n" : "")
    + (st && st.noName ? "You used the lead's name in a recent answer. Do NOT use their name in this answer.\n" : "")
    + (st && st.passage ? "This card is a bridge into the SCRIPT PASSAGE: \"say\" is ONE short sentence that only reacts to what the lead just said (no facts, no pitch, nothing from the passage), and \"ask\" is an empty string.\n" : "");
  const askedText = done.length ? "QUESTIONS ALREADY PUT TO THE LEAD ON THIS CALL (oldest first):\n" + done.map(q => "- " + q).join("\n") + "\nDo NOT give any of these again, even reworded, even if the lead's reply was short or vague: take the reply as the answer and move forward to the next question in the script that has not been asked. Repeat one only if the lead plainly did not hear it (\"what?\", \"say that again\").\n\n" : "";
  const repText = repLast ? `REP JUST SAID: "${String(repLast).slice(-300)}"\n` : "";
  const user = `${ctx.facts}\n\nRecent transcript:\n${recent}\n\n${nextText}${notesText}${askedText}${realText}${openText}${repText}The lead just finished saying: "${said}"${low ? " (the audio was unclear, so some words may be wrong)" : ""}\nReturn the JSON.`;
  const res = await coachStream(env, ctx.system, user, onSay, { max: 400, abortFalse: false, signal, timeout: 8000 });
  const diag = { ms: res.ms || {}, usage: res.usage || {}, stop: res.stop || "", http: typeof res.error === "number" ? res.error : 0, prog };
  if (res.error) return { error: res.error, ...diag };
  const text = res.text || "", a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0) return { unreadable: true, raw: text.slice(0, 500), ...diag };
  let o;
  try { o = JSON.parse(text.slice(a, b + 1)); }
  catch (e) { // cut off mid-answer: keep what was written rather than showing nothing
    const grab = k => { const m = new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(text); return m ? m[1].replace(/\\"/g, '"') : ""; };
    o = { say: grab("say"), ask: grab("ask") };
    if (!o.say) return { unreadable: true, raw: text.slice(0, 500), ...diag };
  }
  const c = x => String(x == null ? "" : x).slice(0, 400);
  if (!c(o.say)) return { unreadable: true, raw: text.slice(0, 500), ...diag };
  const tidy = coachTidy(c(o.say), c(o.ask));
  return { answer: true, say: tidy.say, ask: tidy.ask, needs_eyes: !!o.needs_eyes, ...diag };
}

async function coachSig(env, sid) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(env.TWILIO_TOKEN || "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("stream:" + sid)))].map(x => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
const DG_KEYTERMS = ["ceramic coating", "ceramic tint", "paint correction", "paint protection film", "PPF", "Divine Detailers", "window tint", "clear coat", "XPEL", "Ceramic Coating Inc", "windshield", "visor strip", "sunroof", "tint percentage", "VLT", "five percent", "twenty percent", "thirty-five percent", "swirl marks", "deposit", "Apple Pay", "Zelle", "Square", "sedan", "SUV", "coupe", "minivan", "pickup",
  "Tesla", "Model Y", "Model 3", "Cybertruck", "Mercedes", "Porsche", "Lexus", "Audi", "Infiniti", "Genesis", "Hyundai", "Kia", "Telluride", "Wrangler", "Rubicon", "Bronco", "Silverado", "Escalade", "Corvette", "Camaro", "Challenger", "Charger", "Hellcat", "Camry", "RAV4", "Tacoma", "Maserati", "Bentley", "Lamborghini", "Rivian", "Range Rover", "BMW", "F-150", "Mustang", "Tahoe", "Durango", "Accord", "Civic"];
// the phone line mishears a handful of words again and again: fixed before the coach and the rep see them. [pattern, replacement]
const BUILTIN_FIXES = [
  [/\bceramic (coding|coat in|coting|cotton)\b/gi, "ceramic coating"], [/\b(ceramic|ceramics|seramic) (tin|tent|tints)\b/gi, "ceramic tint"], [/\bcarmic\b/gi, "ceramic"],
  [/\b(window|car|my|the|dark|darker|lighter|get|got|have|any|your|new|old|of) tent(s|ed|ing)?\b/gi, (m, a, b) => `${a} tint${b || ""}`],
  [/\b(x|ex)[\s-]?pell?\b/gi, "XPEL"], [/\bp[\s.]?p[\s.]?f\b/gi, "PPF"], [/\bv[\s.]?l[\s.]?t\b/gi, "VLT"], [/\bdivine (details?|detailer)\b/gi, "Divine Detailers"],
  [/\bwind[\s-]shield\b/gi, "windshield"], [/\bsun[\s-]roof\b/gi, "sunroof"], [/\bmodel (why|wide)\b/gi, "Model Y"], [/\bclear (code|coach)\b/gi, "clear coat"],
  [/\bsquirrel (marks?)\b/gi, "swirl $1"], [/\b(car|vinyl|full|color change) rap\b/gi, "$1 wrap"], [/\bapple[\s-]?pay\b/gi, "Apple Pay"],
];
const fixHeard = (text, extra) => { let t = String(text || ""); for (const [re, to] of BUILTIN_FIXES) t = t.replace(re, to); for (const [re, to] of (extra || [])) t = t.replace(re, to); return t; };
const esc2 = x => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ulaw = b => { b = ~b & 0xff; const s = (((b & 0x0f) << 3) + 0x84) << ((b >> 4) & 7); return (b & 0x80) ? -(s - 0x84) : s - 0x84; };
// ---- Practice calls: an AI plays a customer, the rep practices on the same coach screen, then gets scored. Owner only.
const PR_NAMES = ["Alex", "Jordan", "Marcus", "Daniela", "Chris", "Priya", "Mike", "Sofia", "Dre", "Jenna", "Luis", "Tamara", "Kevin", "Nicole", "Andre", "Rachel"];
const PR_CARS = { tint: [["2023", "Tesla", "Model Y"], ["2021", "Honda", "Accord"], ["2022", "Toyota", "Camry"], ["2020", "BMW", "X5"], ["2019", "Ford", "F-150"], ["2024", "Hyundai", "Tucson"], ["2018", "Dodge", "Charger"], ["2022", "Kia", "Telluride"]],
  coating: [["2024", "BMW", "M4"], ["2023", "Porsche", "Macan"], ["2022", "Tesla", "Model 3"], ["2021", "Mercedes", "C300"], ["2024", "Toyota", "Tacoma"], ["2023", "Lexus", "RX 350"]] };
const PR_TYPES = {
  easy: [["Warm and ready", "You filled out the ad form, you are interested and fairly ready to book this week. You are friendly, answer simply, and ask one question about price. If the rep builds a little value and asks for a deposit and a specific day, you agree."],
    ["Curious first-timer", "You have never had it done before and have a few basic questions (how long it takes, how long it lasts, whether it affects anything). You are polite and open. You book if the rep explains clearly and asks for a deposit with a specific day."]],
  typical: [["Price shopper", "You care mostly about price. You have a quote from another shop. You push on price twice. You only book if the rep shows real value (the film or product, the warranty, the install quality) and asks for the deposit with a specific day."],
    ["Needs to ask a partner", "Your spouse or partner has a say in money. You like it but say you need to talk to them. You only agree to a deposit if the rep offers a refundable deposit to hold a spot and sets a specific callback time."],
    ["Vague browser", "You answer in short, vague sentences ('I don't know', 'maybe'), are not sure what you want, and need the rep to lead with good questions. You book only if the rep guides you to a clear next step."]],
  tough: [["Rushed and distracted", "You are in the middle of something and want to get off the phone. You give short answers, interrupt, and say 'can you just text me the price'. You only engage if the rep is quick, respectful and gets to a clear next step fast."],
    ["Skeptical after a bad experience", "A previous job went badly (bubbles, peeling, overpromised). You distrust shops, ask hard questions about warranty and proof, and say 'everyone says that'. You open up only if the rep is honest, specific and does not overpromise."],
    ["Lowballer who demands a discount", "You ask for a discount on everything, mention a cheaper quote, ask if cash is cheaper, and threaten to go elsewhere. You never get a discount unless you are offered one by the rep; you book if the rep holds the price, shows value without caving, and asks for the deposit."],
    ["Avoids commitment", "You say 'I'll think about it and call you back' as soon as price is mentioned. You only commit to a deposit if the rep offers a refundable deposit with a specific day and handles the hesitation calmly."],
    ["Technical interrogator", "You ask many technical questions (legal limits, heat, signal, curing time, warranty details, what exactly it is, whether it prevents scratches). You test whether the rep knows the product. You book if the answers are clear and honest."]],
};
function makePersona(svc, level) {
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const [year, make, model] = pick(PR_CARS[svc]), [kind, how] = pick(PR_TYPES[level]);
  return { svc, level, name: pick(PR_NAMES), year, make, model, kind, how, quote: svc === "tint" ? pick([225, 250, 275, 300, 325]) : pick([550, 650, 750, 850]),
    speak: level === "tough" ? pick(["Short and a bit curt.", "Casual, drops filler words.", "Slightly impatient."]) : pick(["Casual and friendly.", "Polite and brief.", "Chatty."]), phone: "(305) 555-01" + String(10 + Math.floor(Math.random() * 89)) };
}
const callerSystem = p => `You are role-playing a customer on a phone call with a car detailing shop's salesperson, for sales training. Stay in character at all times.
You are ${p.name}. You drive a ${p.year} ${p.make} ${p.model}. You filled out an online ad form about ${p.svc === "tint" ? "window tint" : "ceramic coating"}.
Your situation and personality: ${p.how}
How you speak: ${p.speak}
If it comes up, another shop quoted you about $${p.quote}. Only mention it when it is relevant.
Rules:
- Speak like a real person on a phone: short (usually one or two sentences), natural, a little imperfect. Never say you are an AI and never mention training.
- You know only what a normal customer knows. Do not volunteer information the rep has not asked about; answer what is asked.
- Do not make it easy. Raise objections naturally, in your own words, one at a time. You may ask things the shop's script would not cover.
- Decide realistically. If the rep handles you well (listens, answers honestly, builds value, deals with your objection without caving or lying, and asks for a deposit and a specific day), agree to book and pay the deposit. If the rep is pushy, vague, wrong or ignores you, stay resistant or end the call.
- React to whatever price, deposit or details the rep states as a real customer would.
- When the call has clearly ended (you booked and agreed to pay, you declined, or you hung up), set "end" to true and say a short goodbye.
Reply with ONLY JSON: {"say": "...", "end": false}`;
const SCORE_RULES = `You are a sales trainer scoring a PRACTICE phone call made by a beginner at a car detailing shop. The shop's SCRIPT, OFFER and SHOP FACTS are given below. Be honest and specific; a typical beginner call scores 2 or 3. Quote the rep's own words.
Return ONLY JSON in this shape:
{"outcome": "win|callback|lost", "deposit_asked": true, "date_set": false, "overall": 3, "scores": {"rapport": 3, "discovery": 3, "pitch": 3, "objections": 3, "close": 3, "control": 3}, "summary": "two sentences", "went_well": ["..."], "fix": [{"moment": "what the customer said", "you_said": "what the rep said", "better": "the exact line to say instead"}], "missed_steps": ["script steps not covered"], "next_practice": "the one thing to work on next"}
Also check these and mention any the rep missed: did they offer a way to pay (link or card), state the deposit as coming off the total, offer two specific days, avoid soft closes like \"if that's okay\", avoid stacked discounts, and avoid improvising legal or film facts. Rules: a win is a deposit asked and accepted AND a specific day set; a callback or "I'll think about it" is not a win. "better" lines must use only facts from the SCRIPT, OFFER or SHOP FACTS. At most 4 items in fix and 4 in went_well. Scores are 1 to 5.`;

export class CallRoom {
  constructor(state, env) {
    this.env = env; this.browsers = new Set(); this.turns = []; this.dg = {}; this.pending = { inbound: [], outbound: [] };
    this.sid = ""; this.leadId = null; this.t0 = Date.now(); this.ended = false;
    this.leadBuf = []; this.coachBusy = false; this.coachNext = null; this.ctx = null;
    this.gen = 0; this.restarts = 0; this.leadHeardAt = 0; this.repHeardAt = 0; this.leadEnded = false; this.repSaid = []; this.repInterim = ""; this.lastAns = null; this.lastMsg = null; this.asks = [];
    this.sig = { talk: { rep: 0, lead: 0 }, words: { rep: 0, lead: 0 }, leadQuestions: 0, firstPriceSecs: null, turns: 0 };
    this.acc = { inbound: { sum: 0, n: 0 }, outbound: { sum: 0, n: 0 } }; this.energy = { rep: [], lead: [] };
  }
  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const path = new URL(request.url).pathname;
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    server.accept();
    if (path.startsWith("/api/twilio/stream/")) { this.sid = path.split("/")[4] || ""; this.attachTwilio(server); } else {
      this.attachBrowser(server);
      const q = new URL(request.url).searchParams;
      if (q.get("practice") === "1" && !this.practice) this.startPractice({ svc: q.get("svc"), level: q.get("level") });
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  broadcast(msg) { const t = JSON.stringify(msg); for (const b of this.browsers) { try { b.send(t); } catch (e) { this.browsers.delete(b); } } }
  attachBrowser(ws) {
    this.browsers.add(ws);
    try { ws.send(JSON.stringify({ type: "hello", build: COACH_BUILD, facts: this.facts || null, turns: this.turns.slice(-40), live: !this.ended && !!this.twilioWs, ans: this.ended ? null : this.lastMsg })); } catch (e) { /* closed */ }
    ws.addEventListener("message", ev => { try { const m = JSON.parse(ev.data); if (m && m.type === "pos") this.pos = { next: String(m.next || "").slice(0, 400), step: String(m.step || "").slice(0, 80) }; else if (m && m.type === "practice_say") this.onPracticeSay(m.text); else if (m && m.type === "practice_end") this.scorePractice(m.covered); } catch (e) { /* ignore */ } });
    ws.addEventListener("close", () => this.browsers.delete(ws)); ws.addEventListener("error", () => this.browsers.delete(ws));
  }
  attachTwilio(ws) {
    this.twilioWs = ws;
    ws.addEventListener("message", ev => { try { this.onTwilio(JSON.parse(ev.data)); } catch (e) { /* ignore bad frame */ } });
    ws.addEventListener("close", () => this.finish()); ws.addEventListener("error", () => this.finish());
  }
  onTwilio(m) {
    if (m.event === "start") { const cp = (m.start && m.start.customParameters) || {}; this.leadId = Number(cp.lead) || this.leadId; this.t0 = Date.now(); this.broadcast({ type: "live" }); this.warm(); return; }
    if (m.event === "stop") { this.finish(); return; }
    if (m.event !== "media" || !m.media || !m.media.payload) return;
    const track = m.media.track === "outbound" ? "outbound" : "inbound"; // outbound = what the rep hears (the lead); inbound = the rep's own voice
    const bin = Uint8Array.from(atob(m.media.payload), c => c.charCodeAt(0));
    // loudness per second is only logged, never shown (it is for testing whether it predicts sales)
    const a = this.acc[track]; for (let i = 0; i < bin.length; i += 4) { const v = ulaw(bin[i]); a.sum += v * v; a.n++; }
    if (a.n >= 8000 / 4) { const who = track === "outbound" ? "lead" : "rep"; if (this.energy[who].length < 1800) this.energy[who].push(Math.round(20 * Math.log10(Math.sqrt(a.sum / a.n) / 32768 + 1e-6))); a.sum = 0; a.n = 0; }
    const sock = this.dg[track];
    if (sock && sock.ready) sock.ws.send(bin); else { this.pending[track].push(bin); if (!sock) this.openDg(track); if (this.pending[track].length > 400) this.pending[track].shift(); }
  }
  async loadCfg() {
    this.fixes = []; this.terms = [];
    try {
      const r = this.env.DB ? await this.env.DB.prepare("SELECT v FROM dial_settings WHERE k = 'offer'").first() : null; const o = r && r.v ? JSON.parse(r.v) : {};
      this.fixes = (o.fixes || []).filter(x => x && x.f).map(x => [new RegExp(`\\b${esc2(x.f)}\\b`, "gi"), x.t || ""]);
      this.terms = (o.terms || []).filter(Boolean);
      // this call's own words: the lead's name and car, so they are transcribed as written in the CRM instead of by ear ("Jessalyn" for Jeceline made the coach doubt the name)
      const l = this.env.DB && this.leadId ? await this.env.DB.prepare("SELECT name, make, model FROM leads WHERE id = ?").bind(this.leadId).first().catch(() => null) : null;
      if (l) for (const w of [String(l.name || "").trim().split(/\s+/)[0], l.make, l.model, [l.make, l.model].filter(Boolean).join(" ")]) { const k = String(w || "").trim(); if (k.length > 2 && k.length < 40 && !this.terms.includes(k)) this.terms.unshift(k); }
    } catch (e) { /* built-in fixes still apply */ }
  }
  async openDg(track) {
    const slot = this.dg[track] = { ready: false, ws: null, t0: Date.now() - this.pending[track].length * 20 };
    try {
      if (!this.cfgP) this.cfgP = this.loadCfg(); await this.cfgP;
      const qs = new URLSearchParams({ model: "nova-3", language: this.env.DEEPGRAM_LANGUAGE || "en", encoding: "mulaw", sample_rate: "8000", channels: "1", tag: track === "outbound" ? "dialer-lead" : "dialer-rep", interim_results: "true", endpointing: "300", utterance_end_ms: "1000", smart_format: "true", punctuate: "true" });
      for (const k of [...new Set([...this.terms, ...DG_KEYTERMS])].slice(0, 100)) qs.append("keyterm", k);
      const resp = await fetch(`${this.env.DEEPGRAM_BASE || "https://api.deepgram.com"}/v1/listen?${qs}`, { headers: { Upgrade: "websocket", Authorization: `Token ${this.env.DEEPGRAM_API_KEY}` } });
      const ws = resp.webSocket;
      if (!ws) { this.broadcast({ type: "error", message: "The transcription service refused the connection." }); return; }
      ws.accept(); slot.ws = ws; slot.ready = true;
      ws.addEventListener("message", ev => { try { this.onDg(track, JSON.parse(typeof ev.data === "string" ? ev.data : "")); } catch (e) { /* not json */ } });
      // if Deepgram drops the connection mid-call, forget it so the next audio frame opens a fresh one (the audio in between is buffered)
      ws.addEventListener("close", () => { slot.ready = false; clearInterval(slot.keep); if (this.dg[track] === slot && !this.ended) this.dg[track] = null; });
      for (const f of this.pending[track].splice(0)) ws.send(f);
      slot.keep = setInterval(() => { try { if (slot.ready) ws.send(JSON.stringify({ type: "KeepAlive" })); } catch (e) { /* closed */ } }, 8000);
    } catch (e) { this.broadcast({ type: "error", message: "Could not reach the transcription service." }); }
  }
  async startPractice(q) {
    const svc = q.svc === "coating" ? "coating" : "tint", level = ["easy", "typical", "tough"].includes(q.level) ? q.level : "typical";
    const persona = makePersona(svc, level); this.practice = { svc, level, persona, done: false, scored: false }; this.t0 = Date.now();
    const lead = { name: persona.name, service: svc === "tint" ? "Window Tint" : "Ceramic Coating", year: persona.year, make: persona.make, model: persona.model, value: 0, message: "" };
    try { this.ctx = await coachContext(this.env, null, svc, lead); } catch (e) { this.broadcast({ type: "practice_error", message: "Could not load the script." }); return; }
    this.broadcast({ type: "practice_ready", level, lead: { id: 0, practice: true, name: persona.name + " (practice)", phone: persona.phone, service: lead.service, year: persona.year, make: persona.make, model: persona.model, stage: "new", created_at: new Date().toISOString(), message: "Ad form: " + lead.service } });
    setTimeout(() => this.practiceLead("Hello?"), 1500);
  }
  practiceLead(text) {
    const at = Math.round((Date.now() - this.t0) / 1000);
    this.turns.push({ who: "lead", text, at });
    this.broadcast({ type: "transcript", who: "lead", text, final: true, end: true, at, speak: true });
    if (coachAi(this.env)) { this.leadBuf.push(text); this.leadHeardAt = Date.now(); this.leadEnded = true; this.queueAsk("utterance_end"); }
  }
  async onPracticeSay(text) {
    const pr = this.practice; text = String(text || "").trim().slice(0, 600);
    if (!pr || pr.done || !text) return;
    const at = Math.round((Date.now() - this.t0) / 1000);
    this.turns.push({ who: "rep", text, at }); this.repSaid.push(text); this.repHeardAt = Date.now();
    this.broadcast({ type: "transcript", who: "rep", text: fixHeard(text), final: true, end: true, at });
    if (!this.callerBusy) await this.callerReply();
  }
  async callerReply() {
    const pr = this.practice; if (!pr || pr.done) return;
    this.callerBusy = true;
    try {
      const convo = this.turns.slice(-24).map(t => `${t.who === "lead" ? "CUSTOMER" : "REP"}: ${t.text}`).join("\n");
      const res = await coachStream(this.env, callerSystem(pr.persona), `Conversation so far:\n${convo}\n\nReply as the customer. JSON only.`, null, { max: 220, timeout: 12000 });
      let o = null;
      if (!res.error) { const a = (res.text || "").indexOf("{"), b = (res.text || "").lastIndexOf("}"); try { o = JSON.parse(res.text.slice(a, b + 1)); } catch (e) { /* retry below */ } }
      if (!o || !o.say) { this.broadcast({ type: "practice_error", message: "The practice caller did not answer. Say that again." }); return; }
      await new Promise(r => setTimeout(r, 500 + Math.random() * 700));
      this.practiceLead(String(o.say).slice(0, 400));
      if (o.end) { pr.done = true; setTimeout(() => this.scorePractice(this.lastCovered), 2500); }
    } finally {
      this.callerBusy = false;
      const last = this.turns[this.turns.length - 1];
      if (pr && !pr.done && last && last.who === "rep") this.callerReply();
    }
  }
  async scorePractice(covered) {
    const pr = this.practice; if (!pr || pr.scored) return;
    if (Array.isArray(covered)) this.lastCovered = covered;
    pr.scored = true; pr.done = true;
    const p = pr.persona, convo = this.turns.map(t => `${t.who === "lead" ? "CUSTOMER" : "REP"}: ${t.text}`).join("\n");
    const user = `The customer was a "${p.kind}" (${pr.level}). The brief the customer played: ${p.how}\nScript steps the rep covered on screen: ${(this.lastCovered || []).join(", ") || "unknown"}\n\nTranscript:\n${convo || "(the rep said nothing)"}\n\nReturn the JSON.`;
    let score = null;
    try {
      const res = await coachStream(this.env, SCORE_RULES + (this.ctx ? this.ctx.body : ""), user, null, { max: 4000, effort: "medium", timeout: 40000, think: true });
      if (!res.error) { const a = (res.text || "").indexOf("{"), b = (res.text || "").lastIndexOf("}"); try { score = JSON.parse(res.text.slice(a, b + 1)); } catch (e) { /* none */ } }
    } catch (e) { /* none */ }
    if (!score) { this.broadcast({ type: "practice_score", score: null, persona: { kind: p.kind, how: p.how, level: pr.level } }); return; }
    try { await this.env.DB.prepare("INSERT INTO practice_runs (svc, level, kind, overall, outcome, score) VALUES (?,?,?,?,?,?)").bind(pr.svc, pr.level, p.kind, Number(score.overall) || 0, String(score.outcome || ""), JSON.stringify(score).slice(0, 8000)).run(); } catch (e) { /* history is a nice-to-have */ }
    this.broadcast({ type: "practice_score", score, persona: { kind: p.kind, how: p.how, level: pr.level } });
  }
  endOfSpeech(track) {
    const who = track === "outbound" ? "lead" : "rep";
    this.broadcast({ type: "end", who });
    if (who === "lead" && coachAi(this.env) && this.leadBuf.length) { this.leadEnded = true; this.queueAsk("utterance_end"); }
  }
  async refreshFacts() {
    if (this.factsBusy || this.coachBusy || this.leadBuf.length || this.ended || !coachAi(this.env)) return;
    const since = Date.now() - (this.factsAt || 0);
    if (since < 2500) { clearTimeout(this.factsTm); this.factsTm = setTimeout(() => this.refreshFacts(), 2600 - since); return; } // too soon: run once the gap has passed
    this.factsAt = Date.now();
    const turns = coachTurns(this.turns, 80);
    if (!turns.some(t => t.who === "lead")) return;
    this.factsBusy = true; const n = this.turns.length;
    try {
      if (!this.ctx) await this.getCtx();
      const recent = turns.map(t => `${t.who === "lead" ? "LEAD" : "REP"}: ${t.text}`).join("\n").slice(-9000), steps = this.ctx.steps || [];
      const stepText = steps.length ? "SCRIPT STEPS:\n" + steps.map(x => `${x.id} [${x.phase}] ${x.q.slice(0, 160)}`).join("\n") + "\n\n" : "";
      const res = await coachStream(this.env, FACTS_RULES + "\n\nService: " + (this.ctx.svc || "unknown") + "\n\n" + this.ctx.body, `${stepText}Transcript (whole call so far):\n${recent}\n\nReturn the JSON.`, null, { max: 600, abortFalse: false, timeout: 10000 });
      const text = res && res.text || "", a = text.indexOf("{"), b = text.lastIndexOf("}");
      if (a >= 0 && b > a) {
        const o = JSON.parse(text.slice(a, b + 1)), c = x => String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, 160);
        const f = { problem: c(o.problem), solve: c(o.solve), color: c(o.color) };
        if (JSON.stringify(f) !== JSON.stringify(this.facts || {})) { this.facts = f; this.broadcast({ type: "facts", ...f }); }
        // call progress: a finished step stays finished (one odd reply cannot send the call backwards), and the lead notes are replaced by the latest full list
        const ids = new Set(steps.map(x => x.id)); this.done = this.done || new Set();
        for (const id of Array.isArray(o.done) ? o.done : []) if (ids.has(String(id))) this.done.add(String(id));
        const notes = (Array.isArray(o.lead) ? o.lead : []).map(c).filter(Boolean).slice(0, 8); if (notes.length) this.leadNotes = notes;
      }
    } catch (e) { /* the recap falls back to the standard wording */ }
    finally { this.factsBusy = false; }
  }
  async warm() {
    if (this.warmed || !coachAi(this.env) || !this.env.DB) return; this.warmed = true;
    try { await this.getCtx(); await coachStream(this.env, this.ctx.system, "Warm-up only. Reply with {}", null, { max: 8, timeout: 10000 }); } catch (e) { /* the real request will build it */ }
  }
  // the script, offer and answer library for this call: loaded once (the warm-up and the first answer used to load it twice, which cost the first answer 2 to 3 seconds)
  getCtx() {
    if (this.ctx) return Promise.resolve(this.ctx);
    if (!this.ctxP) this.ctxP = coachContext(this.env, this.leadId).then(c => (this.ctx = c)).catch(e => { this.ctxP = null; throw e; });
    return this.ctxP;
  }
  onDg(track, d) {
    if (d.type === "UtteranceEnd") { this.endOfSpeech(track); return; }
    if (d.type !== "Results") return;
    const alt = d.channel && d.channel.alternatives && d.channel.alternatives[0]; const raw = alt && String(alt.transcript || "").trim();
    if (!raw) { if (d.speech_final) this.endOfSpeech(track); return; }
    const text = fixHeard(raw, this.fixes), low = typeof alt.confidence === "number" && alt.confidence < 0.75;
    const who = track === "outbound" ? "lead" : "rep";
    const final = !!d.is_final, at = Math.round((Date.now() - this.t0) / 1000);
    this.broadcast({ type: "transcript", who, text, final, end: !!d.speech_final, at, low });
    const now = Date.now();
    if (who === "lead") this.leadHeardAt = now; else { this.repHeardAt = now; this.repInterim = final ? "" : text; }
    if (!final) { if (who === "lead" && coachAi(this.env) && this.leadBuf.length) { this.leadEnded = false; this.queueAsk("more"); } return; } // the lead is still talking: hold the answer
    this.turns.push({ who, text, at, low });
    this.sig.talk[who] += Number(d.duration) || 0; this.sig.words[who] += text.split(/\s+/).length; this.sig.turns++;
    if (who === "lead" && /\?/.test(text)) this.sig.leadQuestions++;
    if (this.sig.firstPriceSecs == null && /\$|price|how much|cost|precio|cu[aá]nto/i.test(text)) this.sig.firstPriceSecs = at;
    if (who === "rep") { this.repSaid.push(text); if (this.repSaid.length > 6) this.repSaid.shift(); this.repRecent = (this.repRecent || []).filter(x => now - x.at < 12000); this.repRecent.push({ t: text, at: now }); return; }
    if (!coachAi(this.env)) return;
    if (coachEcho(text, this.repRef())) { this.logTurn({ gen: this.gen, said: text, trig: "final", outcome: "skipped", why: "echo" }); return; }
    const slot = this.dg[track]; // how far behind the live audio this transcript arrived (approximate)
    this.leadLag = slot && slot.t0 && typeof d.start === "number" ? Math.max(0, Math.round(now - (slot.t0 + (d.start + (Number(d.duration) || 0)) * 1000))) : null;
    this.leadBuf.push(text); if (low) this.leadLow = true; this.leadEnded = !!d.speech_final;
    this.leadMore(); this.queueAsk(d.speech_final ? "final" : "more");
  }
  // The lead speaks in fragments ("How are you doing?" ... "today"). Gather them, wait a beat for more, then answer the whole thing once.
  // More speech while a request is running: stop it and answer the merged text instead (capped, so a lead who never pauses still gets an answer).
  leadMore() { if (this.coachBusy && this.restarts < 4) { this.coachRestart = true; try { this.coachAc && this.coachAc.abort(); } catch (e) { /* done */ } } }
  // Wait measured from the last moment the lead was heard: 0 once Deepgram says the utterance ended, 250 ms after a finished sentence, 650 ms after an unfinished one,
  // 1200 ms while Deepgram has not marked the end of speech yet (its own utterance-end signal normally arrives first).
  queueAsk(trigger) {
    clearTimeout(this.askTm);
    if (!this.leadBuf.length) return;
    // A lead who keeps adding to the same remark after an answer went up (a story, a long explanation) gets more room each time, so the card stops changing under the rep.
    const prev = this.lastAns, again = prev && Date.now() - prev.at < 6000 && !(this.repHeardAt > prev.at) ? Math.min(3, this.burst || 0) : 0;
    const text = this.leadBuf.join(" ").trim(), p0 = coachPause(text), more = again * 400;
    const base = (trigger === "utterance_end" ? Math.min(p0, 1000) : trigger === "more" ? Math.max(1200, p0) : p0) + more;
    this.askTrig = trigger;
    this.askTm = setTimeout(() => this.askCoach(), Math.max(0, base - (Date.now() - (this.leadHeardAt || 0))));
  }
  // what the rep has said in the last few seconds plus the answer on screen (which the rep is probably reading aloud)
  repRef() { const now = Date.now(), m = this.lastMsg; return (this.repRecent || []).filter(x => now - x.at < 12000).map(x => x.t).join(" ") + " " + (this.repInterim || "") + " " + (m && m.type === "answer" ? (m.say || "") + " " + (m.ask || "") : ""); }
  // The coach's earlier questions that the rep really asked (their words show up in the rep's side of the transcript after the card went up)
  // the rep's speech since a given second of the call, as stretches (back-to-back fragments joined)
  repSpeech(fromSec) { return coachTurns(this.turns.filter(t => t.who === "rep" && t.at >= (fromSec || 0)), 400).map(t => t.text).concat(this.repInterim ? [this.repInterim] : []); }
  // The coach's earlier questions that count as covered: the rep said them (their words show up in one stretch of the rep's speech after the card went up),
  // or they have been on the card twice.
  askedSoFar() {
    for (const a of this.asks) if (!a.done && this.repSpeech(a.at).some(c => coachSaid(a.q, c, a.q.length > 140 ? 0.5 : 0.7))) a.done = true;
    return this.asks.filter(a => a.done || a.n >= 2).map(a => a.q);
  }
  // Where the call is, worked out by the server (not the browser, not the model). A pointer walks the script in order.
  // - An ordinary step is passed when the notes say it is finished or the rep asked its question.
  // - A PASSAGE (recap, the prep, the coating, the deposit) is passed only when the rep actually read it, or it has been on the card twice.
  //   The notes cannot pass it, and nothing can hop over it: on real calls the AI's own comments ("the correction takes those out before the coating
  //   goes on") made the notes think the pitch was done, and the recap was skipped.
  // - Once the rep has said the price, everything before the price step is behind us (a lead who pushed straight to the price is not dragged back).
  progress() {
    const steps = (this.ctx && this.ctx.steps) || [], done = this.done || new Set(), asked = this.askedSoFar();
    if (!steps.length || (!done.size && !asked.length)) return null;
    const speech = this.repSpeech(0);
    const read = x => { const e = this.asks.find(a => a.q === x.q); return !!(e && (e.done || e.n >= 2)) || speech.some(c => coachSaid(x.q, c, 0.5)); };
    const hit = x => x.passage ? read(x) : (done.has(x.id) || asked.some(q => coachStepAsked(q, x.q)));
    let i = this.stepIdx || 0;
    while (i < steps.length) {
      if (hit(steps[i])) { i++; continue; }
      if (steps[i].passage) break;
      let j = -1; for (let k = i + 1; k <= i + 3 && k < steps.length && !steps[k].passage; k++) if (done.has(steps[k].id)) j = k;
      if (j < 0) break; i = j + 1;
    }
    const price = this.ctx.price, pi = price && price.length >= 2 ? steps.findIndex(x => String(x.full || x.q).replace(/[^0-9$]/g, " ").includes("$" + price)) : -1;
    if (pi >= i && speech.some(c => c.replace(/[^0-9]/g, " ").split(/\s+/).includes(price))) i = pi + 1;
    this.stepIdx = i;
    return { done: steps.slice(0, i).map(x => x.id), next: steps[i] || null, notes: this.leadNotes || [] };
  }
  // did one of the last two answers already name the car, its color, or the lead? (leads noticed "your black BMW" and their own name in every other sentence)
  overused() {
    const car = (this.ctx && this.ctx.car) || {}, has = words => { const ws = words.map(x => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).filter(x => x.length > 2); return ws.length > 0 && (this.says || []).slice(-2).some(s => { const t = " " + String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ") + " "; return ws.some(w => t.includes(" " + w + " ")); }); };
    return { car: has([car.make, car.model, this.facts && this.facts.color]), name: has([String((this.ctx && this.ctx.name) || "").trim().split(/\s+/)[0]]) };
  }
  logTurn(r) {
    try {
      if (!this.env.DB || this.practice) return;
      const u = r.usage || {}, ms = r.ms || {}, n = x => (typeof x === "number" && isFinite(x) ? Math.round(x) : null);
      this.env.DB.prepare("INSERT INTO coach_turns (call_sid, build, gen, said, trig, outcome, why, restarts, wait_ms, dg_lag_ms, ctx_ms, first_ms, say_ms, total_ms, shown_ms, rep_spoke, http, stop, in_tok, cache_read, cache_write, out_tok, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(this.sid || "", COACH_BUILD, r.gen || 0, String(r.said || "").slice(0, 300), r.trig || "", r.outcome || "", String(r.why || "").slice(0, 120), r.restarts || 0, n(r.wait), n(r.lag), n(r.ctx), n(ms.first), n(ms.say), n(r.total), n(r.shown), r.rep_spoke ? 1 : 0, n(r.http) || 0, r.stop || "", n(u.input_tokens), n(u.cache_read_input_tokens), n(u.cache_creation_input_tokens), n(u.output_tokens), String(r.raw || "").slice(0, 500))
        .run().catch(() => { /* the log is a nice-to-have */ });
    } catch (e) { /* never let logging break the call */ }
  }
  async askCoach() {
    if (this.coachBusy) return; // the running request is restarted with the merged text when it stops
    clearTimeout(this.askTm);
    let frag = this.leadBuf.join(" ").trim(); this.leadBuf = []; const low = this.leadLow; this.leadLow = false;
    if (this.ended || !frag) return;
    const heardAt = this.leadHeardAt || Date.now(), t0 = Date.now();
    // a word or two that was not worth answering on its own ("I thought" ... "this was free") is kept and joined to what comes next
    const car = this.carry; this.carry = null;
    if (car && t0 - car.at < 5000 && !(this.repHeardAt > car.at)) frag = car.text + " " + frag;
    const log = { gen: ++this.gen, said: frag, trig: this.askTrig || "", restarts: this.restarts, wait: t0 - heardAt, lag: this.leadLag };
    // what the rep said since the lead's last remark: a "yeah" or "no" only makes sense next to the question it answers
    const repLast = (this.repSaid.join(" ") + " " + (this.repInterim || "")).trim();
    // more words right after an answer went up, before the rep has said anything: same remark, so answer the whole thing or leave the screen alone
    const prev = this.lastAns, after = !!(prev && t0 - prev.at < 6000 && !(this.repHeardAt > prev.at));
    const quiet = coachEcho(frag, this.repRef()) ? "echo" : coachQuiet(frag, repLast, after);
    if (quiet) { log.outcome = "skipped"; log.why = quiet; log.said = frag; this.carry = { text: frag.slice(-300), at: t0 }; this.logTurn(log); if (this.leadBuf.length) this.queueAsk(this.leadEnded ? "final" : "more"); return; }
    const said = after ? (prev.said + " " + frag).slice(-600) : frag; if (after) log.said = said;
    this.coachBusy = true; this.coachRestart = false; this.coachAc = new AbortController();
    let shown = 0, backup = false, backupTm = 0;
    const show = msg => { if (!shown) { shown = Date.now(); log.shown = shown - heardAt; log.rep_spoke = this.repHeardAt > heardAt; } this.lastMsg = msg; this.broadcast(msg); };
    try {
      if (!this.ctx) await this.getCtx();
      const ctxMs = log.ctx = Date.now() - t0;
      // nothing from the AI after 3 seconds: the safe backup answer goes up and STAYS up (a late AI answer would change the words while the rep is reading them)
      backupTm = setTimeout(() => { if (shown || this.coachRestart || this.ended) return; backup = true; show({ type: "answer", q: said, ...backupAnswer(said, this.pos), ms: { total: Date.now() - t0 } }); try { this.coachAc.abort(); } catch (e) { /* done */ } }, 3000);
      // The next step is a script passage: unless the lead just asked something or objected, the card is a one-sentence bridge plus the passage word for word.
      const prog = this.progress(), over = this.overused(), stepN = prog && prog.next, svcNow = this.ctx.svc;
      const leadNeeds = /\?/.test(said) || /(not interested|expensive|too much|how much|price|cost|think about|wife|husband|girlfriend|call (me )?back|later|busy|no time|free\b|why|what is|what's|scam|catch|cheaper|discount)/i.test(said);
      const forceThen = !!(stepN && stepN.passage && !leadNeeds);
      const out = await coachAnswer(this.env, this.ctx, this.turns, said, this.pos, low, say0 => { if (this.coachRestart || backup) return; let say = coachOwner(coachTidy(say0, "").say, svcNow); if (forceThen) say = coachFirst(say); show({ type: "answer", q: said, answer: true, say, ask: "", early: true, backup: false, ms: { say: Date.now() - t0, ctx: ctxMs } }); }, this.coachAc.signal, repLast, this.asks.filter(a => a.q.length <= 140).map(a => a.q), { prog, notes: this.leadNotes || [], openers: this.openers || [], says: (this.says || []).map(x => x.slice(0, 140)), noCar: over.car, noName: over.name, passage: forceThen }) || {};
      if (stepN) log.why = "next " + stepN.id + (forceThen ? " passage" : "");
      log.ms = out.ms; log.usage = out.usage; log.stop = out.stop; log.http = out.http; log.raw = out.raw;
      if (this.coachRestart) { log.outcome = "restarted"; return; } // more of the lead's sentence arrived: this answer is out of date
      if (backup) { log.outcome = "backup"; log.why = "slow"; this.broadcast({ type: "coach_skip", q: said.slice(0, 80), why: "AI took over 3s, backup answer shown" }); }
      else if (out.answer) { log.outcome = "shown"; log.raw = (out.say + " | ASK: " + out.ask).slice(0, 500);
        this.openers = [...(this.openers || []), String(out.say).split(/[,.!?]/)[0].split(/\s+/).slice(0, 3).join(" ")].filter(Boolean).slice(-3);
        this.says = [...(this.says || []), out.say].slice(-3);
        out.say = coachOwner(out.say, svcNow); out.ask = coachOwner(out.ask, svcNow);
        const lastA = this.asks[this.asks.length - 1];
        if (after && lastA && !lastA.done) { lastA.n--; if (lastA.n <= 0) this.asks.pop(); } // same remark answered again: the earlier card does not count
        // put the passage on the card word for word, blanks filled from this call; the AI's line is cut to its first sentence so it does not pre-empt the passage
        const then = stepN && stepN.passage && (forceThen || !out.ask) ? { id: stepN.id, text: coachFill(stepN.full, this.facts, this.ctx.car, this.ctx.name) } : null;
        if (then) { out.then = then; out.ask = ""; out.say = coachFirst(out.say); const sameP = this.asks.find(a => a.q === stepN.q); if (sameP) sameP.n++; else this.asks.push({ q: stepN.q, n: 1, at: Math.round((Date.now() - this.t0) / 1000) }); }
        log.raw = (out.say + (then ? " | THEN " + then.id + ": " + then.text : " | ASK: " + out.ask)).slice(0, 500);
        this.says[this.says.length - 1] = out.say;
        const sameA = out.ask ? this.asks.find(a => coachSame(a.q, out.ask)) : null;
        if (sameA) sameA.n++; else if (out.ask) { this.asks.push({ q: out.ask, n: 1, at: Math.round((Date.now() - this.t0) / 1000) }); if (this.asks.length > 30) this.asks.shift(); } show({ type: "answer", q: said, answer: true, say: out.say, ask: out.ask, then: out.then || null, needs_eyes: out.needs_eyes, backup: false, ms: { ...out.ms, say: out.ms && out.ms.say != null ? out.ms.say + ctxMs : null, total: Date.now() - t0, ctx: ctxMs } }); }
      else { // no usable AI answer: show the safe backup so the rep is never left without help (unless the first sentence is already on screen)
        log.why = out.error ? "error " + out.error : "unreadable" + (out.stop ? " " + out.stop : "");
        this.broadcast({ type: "coach_skip", q: said.slice(0, 80), why: out.error ? "AI service error " + out.error + (shown ? "" : ", backup answer shown") : "reply could not be read" + (shown ? "" : ", backup answer shown") });
        if (shown) log.outcome = "partial"; else { log.outcome = "backup"; show({ type: "answer", q: said, ...backupAnswer(said, this.pos), ms: { total: Date.now() - t0 } }); }
      }
    } catch (e) { log.outcome = "crash"; log.why = String(e && e.message || e).slice(0, 100); if (!this.coachRestart) this.broadcast({ type: "coach_error" }); }
    finally {
      clearTimeout(backupTm); this.coachBusy = false; log.total = Date.now() - t0; this.logTurn(log);
      if (this.coachRestart) { // answer the merged remark, but only once the lead has actually paused (not instantly, which would just be stopped again)
        this.coachRestart = false; this.restarts++; this.leadBuf.unshift(frag); if (low) this.leadLow = true;
        this.queueAsk(this.leadEnded ? "final" : "more");
      } else {
        this.restarts = 0; this.repSaid = []; this.burst = after ? (this.burst || 0) + 1 : 0; if (shown) this.lastAns = { said, at: Date.now() };
        if (this.leadBuf.length) this.queueAsk(this.leadEnded ? "final" : "more"); else this.refreshFacts();
      }
    }
  }
  async finish() {
    if (this.ended) return; this.ended = true;
    for (const t of ["inbound", "outbound"]) { const s = this.dg[t]; if (s) { clearInterval(s.keep); try { if (s.ws) { s.ws.send(JSON.stringify({ type: "CloseStream" })); s.ws.close(); } } catch (e) { /* closed */ } } }
    this.broadcast({ type: "ended" });
    try {
      if (this.env.DB && this.turns.length) {
        const tot = this.sig.talk.rep + this.sig.talk.lead;
        const signals = { ...this.sig, repTalkShare: tot ? Math.round(this.sig.talk.rep * 100 / tot) : null, secs: Math.round((Date.now() - this.t0) / 1000), energyDb: this.energy };
        await this.env.DB.prepare("INSERT INTO call_transcripts (call_sid, lead_id, turns, signals) VALUES (?,?,?,?) ON CONFLICT(call_sid) DO UPDATE SET turns = excluded.turns, signals = excluded.signals, ended_at = datetime('now')").bind(this.sid, this.leadId, JSON.stringify(this.turns), JSON.stringify(signals)).run();
      }
    } catch (e) { /* the transcript is also on screen; not saving is not fatal */ }
  }
}
// ---- Urable bookings on the calendar: jobs and calendar events straight from Urable, including ones made there and not in the CRM
let urableCal = { at: 0, items: [] };
const etLocal = ms => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
async function urableCalendar(env) {
  if (!env.URABLE_API_KEY) return { urable: false, items: [] };
  if (Date.now() - urableCal.at < 180000) return { urable: true, items: urableCal.items };
  const since = Date.now() - 62 * 864e5;
  const all = async path => {
    const out = []; let after = "";
    for (let i = 0; i < 3; i++) {
      const page = (await urableCall(env, "GET", `${path}?limit=100&orderBy=start${after ? "&startAfter=" + encodeURIComponent(after) : ""}`).catch(() => [])) || [];
      out.push(...page);
      if (page.length < 100 || (page[page.length - 1].start || 0) < since) break;
      after = page[page.length - 1].id;
    }
    return out;
  };
  const [jobs, events] = await Promise.all([all("/v1/jobs"), all("/v1/events")]);
  const keepJob = j => j.start && j.start >= since && !["canceled", "archived", "quote"].includes(String(j.status || "").toLowerCase());
  const live = jobs.filter(keepJob);
  const ids = [...new Set([...live.map(j => j.customerRef), ...events.filter(e => e.start >= since).map(e => e.customerRef)].filter(Boolean).map(r => String(r).split("/").pop()))].slice(0, 25);
  const names = {};
  await Promise.all(ids.map(id => urableCall(env, "GET", "/v1/customers/" + id).then(c => { if (c) names[id] = c.name || [c.firstName, c.lastName].filter(Boolean).join(" "); }).catch(() => {})));
  const who = r => names[String(r || "").split("/").pop()] || "";
  const items = [
    ...live.map(j => ({ uid: "job:" + j.id, ref: j.id, kind: "Job" + (j.num ? " #" + j.num : ""), name: who(j.customerRef) || j.name || "Urable job", service: who(j.customerRef) ? j.name || "" : "", appt_at: etLocal(j.start), end_at: j.end ? etLocal(j.end) : "", status: j.status || "scheduled" })),
    ...events.filter(e => e.start >= since && !e.private).map(e => ({ uid: "event:" + e.id, ref: e.id, kind: "Event", name: e.name || "Calendar event", service: who(e.customerRef), appt_at: etLocal(e.start), end_at: e.end ? etLocal(e.end) : "", status: e.type || "event" })),
  ];
  urableCal = { at: Date.now(), items };
  return { urable: true, items };
}

// ---- Calendar: every lead with an appointment, by day (owner login)
async function calendarPage(env, user) {
  await ensureTable(env.DB);
  const tc = await todayCount(env);
  const rows = (await env.DB.prepare("SELECT id, name, phone, service, year, make, model, appt_at, stage, value, urable_ref FROM leads WHERE appt_at IS NOT NULL AND appt_at != '' AND stage != 'lost' AND appt_at >= date('now','-70 days') AND COALESCE(ip,'') != 'demo' ORDER BY appt_at LIMIT 800").all()).results || [];
  const payload = JSON.stringify({ appts: rows, today: todayStr(), stages: STAGES }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">${PWA_HEAD}<title>Calendar | Divine Detailers</title>
<style>
${FOLLOW_CSS}.addb{border:0;background:#32cd32;color:#04120a;border-radius:10px;padding:9px 14px;font:inherit;font-weight:800;cursor:pointer;min-height:44px}#nbdlg .rb{gap:10px}#nbr{display:flex;flex-direction:column;gap:6px}#nbr button{text-align:left;border:1px solid #2a313a;background:#12171e;color:#e8eaed;border-radius:10px;padding:10px 12px;font:inherit;cursor:pointer;min-height:44px}#nbr button small{color:#7c838d;display:block}
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#07090c;color:#e8eaed}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px;flex-wrap:wrap}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}.navtabs a.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
main{max-width:1000px;margin:0 auto;padding:16px 22px 40px;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:18px;align-items:start}
.mh{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}.mh h2{margin:0;font-size:18px}.nv{display:flex;gap:6px}.nv button{border:1px solid #2a313a;background:#151a21;color:#e8eaed;border-radius:10px;padding:8px 14px;font:inherit;font-weight:700;cursor:pointer;min-height:40px}
.dow,.grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}.dow span{color:#7c838d;font-size:11.5px;text-align:center;text-transform:uppercase;letter-spacing:.6px;padding:4px 0}
.d{aspect-ratio:1/1;min-height:44px;background:#0d1116;border:1px solid #1d2229;border-radius:10px;color:#e8eaed;font:inherit;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;cursor:pointer;padding:2px}
.d.out{opacity:.35}.d.td{border-color:#32cd32}.d.sel{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:800}.d .c{font-size:11px;font-weight:800;background:#1f5a2a;color:#9fe29f;border-radius:999px;padding:0 7px;min-width:18px}.d.sel .c{background:#04120a;color:#32cd32}
.side{display:flex;flex-direction:column;gap:12px}.side h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:#c3c8cf;margin:0}
.ap{display:flex;gap:12px;align-items:flex-start;background:#0d1116;border:1px solid #1d2229;border-radius:12px;padding:12px;text-decoration:none;color:inherit}.ap .tm{font-weight:800;min-width:64px;font-variant-numeric:tabular-nums;color:#32cd32}.ap .i{min-width:0;flex:1}.ap .i b{display:block;overflow-wrap:anywhere}.ap .i small{color:#8a9099;display:block}
.pill{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;border-radius:999px;padding:1px 8px;background:#1a2027;color:#aab0b9;margin-top:4px}.pill.booked{background:#10301a;color:#7fe07f}.pill.working{background:#2a2410;color:#ffd166}.pill.done{background:#1a2027;color:#aab0b9}.pill.u{background:#14233d;color:#7fb7ff}
.empty{color:#7c838d;padding:10px 2px}
${BNAV_CSS}
@media(max-width:800px){header{padding:12px 14px}h1{font-size:17px}main{grid-template-columns:minmax(0,1fr);padding:10px 14px 24px}}
</style></head><body>
<header><h1>Divine Detailers <b>calendar</b></h1>${nav("calendar", tc, true)}</header>
${bnav("calendar", tc, true)}
<main>
<section><div class="mh"><h2 id="mt"></h2><div class="nv"><button id="addbk" class="addb" type="button">+ Add booking</button><button id="pv" type="button" aria-label="Previous month">&lsaquo;</button><button id="tdy" type="button">Today</button><button id="nx" type="button" aria-label="Next month">&rsaquo;</button></div></div>
<div class="dow"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div><div class="grid" id="g"></div></section>
<section class="side"><div><h2 id="dh"></h2><div id="dl" style="display:flex;flex-direction:column;gap:8px;margin-top:8px"></div></div><div><h2>Coming up (next 14 days)</h2><div id="up" style="display:flex;flex-direction:column;gap:8px;margin-top:8px"></div></div></section>
</main>
<dialog class="rdlg" id="nbdlg"><div class="rb"><h3>Add a booking</h3><p>Find the customer, or add a new one. Next you pick the day, time and price.</p>
<div><label>Search by name or phone</label><input id="nbq" autocomplete="off" placeholder="Start typing"></div><div id="nbr"></div>
<div><label>Or add a new customer: name</label><input id="nbn" autocomplete="off"></div><div><label>Phone</label><input id="nbp" type="tel" inputmode="tel"></div>
<p id="nberr" style="color:#ff8a8a;min-height:18px"></p><div class="ra"><button type="button" id="nbx">Cancel</button><button type="button" class="ok" id="nbgo">Continue</button></div></div></dialog>
${FOLLOW_HTML}
<script>${FOLLOW_JS}</script>
<script type="application/json" id="data">${payload}</script>
<script>
const $=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const D=JSON.parse(document.getElementById('data').textContent),SN=Object.fromEntries(D.stages),MON=['January','February','March','April','May','June','July','August','September','October','November','December'];
const by={};D.appts.forEach(a=>{const d=String(a.appt_at).slice(0,10);(by[d]=by[d]||[]).push(a)});
const t0=D.today.split('-').map(Number);let Y=t0[0],M=t0[1]-1,sel=D.today;
const pad=n=>String(n).padStart(2,'0'),key=(y,m,d)=>y+'-'+pad(m+1)+'-'+pad(d);
function tm(a){const m=/T(\\d\\d):(\\d\\d)/.exec(a.appt_at||'');if(!m)return '';let h=+m[1];const ap=h>=12?'PM':'AM';h=h%12||12;return h+':'+m[2]+' '+ap}
function card(a){if(a.src==='urable')return '<div class="ap"><div class="tm">'+tm(a)+'</div><div class="i"><b>'+$(a.name)+'</b><small>'+$(a.service||'')+'</small><span class="pill u">Urable &middot; '+$(a.status)+'</span> <small style="display:inline">'+$(a.kind)+'</small></div></div>';const car=[a.year,a.make,a.model].filter(Boolean).join(' ');return '<a class="ap" href="/admin/pipeline#id='+a.id+'"><div class="tm">'+tm(a)+'</div><div class="i"><b>'+$(a.name||a.phone||'Lead')+'</b><small>'+$([a.service,car].filter(Boolean).join(' \\u00b7 '))+'</small><span class="pill '+$(a.stage)+'">'+$(SN[a.stage]||a.stage)+'</span>'+(a.value?' <small style="display:inline">$'+Math.round(a.value)+'</small>':'')+'</div></a>'}
function day(k){const l=(by[k]||[]).slice().sort((a,b)=>String(a.appt_at).localeCompare(String(b.appt_at)));return l.length?l.map(card).join(''):'<div class="empty">Nothing scheduled.</div>'}
function draw(){document.getElementById('mt').textContent=MON[M]+' '+Y;const first=new Date(Y,M,1).getDay(),dim=new Date(Y,M+1,0).getDate(),prev=new Date(Y,M,0).getDate();let h='';
  for(let i=0;i<first;i++){h+='<div class="d out"><span>'+(prev-first+1+i)+'</span></div>'}
  for(let d=1;d<=dim;d++){const k=key(Y,M,d),n=(by[k]||[]).length;h+='<button type="button" class="d'+(k===D.today?' td':'')+(k===sel?' sel':'')+'" data-k="'+k+'"><span>'+d+'</span>'+(n?'<span class="c">'+n+'</span>':'')+'</button>'}
  const rest=(7-((first+dim)%7))%7;for(let i=1;i<=rest;i++)h+='<div class="d out"><span>'+i+'</span></div>';document.getElementById('g').innerHTML=h;
  const sp=sel.split('-').map(Number);document.getElementById('dh').textContent=(sel===D.today?'Today, ':'')+new Date(sp[0],sp[1]-1,sp[2]).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});document.getElementById('dl').innerHTML=day(sel);
  const up=[];for(let i=0;i<14;i++){const dt=new Date(t0[0],t0[1]-1,t0[2]+i),k=key(dt.getFullYear(),dt.getMonth(),dt.getDate());(by[k]||[]).forEach(a=>up.push([k,a]))}
  document.getElementById('up').innerHTML=up.length?up.map(x=>{const p=x[0].split('-').map(Number);return '<div><small style="color:#7c838d">'+new Date(p[0],p[1]-1,p[2]).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})+'</small>'+card(x[1])+'</div>'}).join(''):'<div class="empty">No appointments in the next 14 days.</div>'}
document.getElementById('g').addEventListener('click',e=>{const b=e.target.closest('[data-k]');if(b){sel=b.dataset.k;draw()}});
document.getElementById('pv').onclick=()=>{M--;if(M<0){M=11;Y--}draw()};document.getElementById('nx').onclick=()=>{M++;if(M>11){M=0;Y++}draw()};
document.getElementById('tdy').onclick=()=>{Y=t0[0];M=t0[1]-1;sel=D.today;draw()};draw();
(async()=>{try{const r=await fetch('/admin/calendar/urable');if(!r.ok)return;const j=await r.json();if(!j.urable)return;const mine=new Set(D.appts.map(a=>a.urable_ref).filter(Boolean));
  (j.items||[]).forEach(u=>{if(mine.has(u.ref))return;const a=Object.assign({src:'urable',id:null},u);const k=String(a.appt_at).slice(0,10);(by[k]=by[k]||[]).push(a)});draw()}catch(_){}})();
(function(){const d=document.getElementById('nbdlg'),q=document.getElementById('nbq'),r=document.getElementById('nbr'),err=document.getElementById('nberr');let tm0=0,picked=null;
  function open(){q.value='';r.innerHTML='';document.getElementById('nbn').value='';document.getElementById('nbp').value='';err.textContent='';picked=null;d.showModal()}
  async function go(id){d.close();const o=await askBook(id,'Booked from the calendar',sel+'T10:00');if(o)location.reload()}
  document.getElementById('addbk').onclick=open;document.getElementById('nbx').onclick=()=>d.close();
  q.oninput=()=>{clearTimeout(tm0);const v=q.value.trim();if(v.length<2){r.innerHTML='';return}tm0=setTimeout(async()=>{try{const j=await (await fetch('/admin/calendar/find?q='+encodeURIComponent(v))).json();
    r.innerHTML=(j.leads||[]).map(l=>'<button type="button" data-i="'+l.id+'"><b>'+$(l.name||l.phone)+'</b><small>'+$(l.phone||'')+(l.service?' &middot; '+$(l.service):'')+'</small></button>').join('')||'<small style="color:#7c838d">No match. Add them below.</small>'}catch(_){}},250)};
  r.onclick=e=>{const b=e.target.closest('[data-i]');if(b)go(+b.dataset.i)};
  document.getElementById('nbgo').onclick=async()=>{const n=document.getElementById('nbn').value.trim(),ph=document.getElementById('nbp').value.trim();if(!n||(ph.replace(/\\D/g,'').length<7)){err.textContent='Add a name and a phone number, or pick someone from the search.';return}
    let j={};try{j=await (await fetch('/admin/add',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:n,phone:ph,source:'Calendar'})})).json()}catch(_){}
    if(!j.success||!j.id){err.textContent='Could not add the customer. Try again.';return}go(j.id)};
})();
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
// ---- Dial sessions: at set times (DIAL_SESSIONS, default 09:30, 13:00, 17:00 Eastern, Monday to Saturday) a push says how many leads are waiting and opens Start calling
const SESSION_NAMES = ["Morning", "Afternoon", "End of day"];
async function dialSessionReminder(env) {
  if (!env.DB || env.DIAL_SESSIONS === "off") return;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date()).map(x => [x.type, x.value]));
  if (parts.weekday === "Sun") return;
  const nowMin = Number(parts.hour) * 60 + Number(parts.minute);
  const times = String(env.DIAL_SESSIONS || "09:30,13:00,17:00").split(",").map(x => x.trim()).filter(Boolean);
  for (let i = 0; i < times.length; i++) {
    const m = /^(\d{1,2}):(\d\d)$/.exec(times[i]);
    if (!m) continue;
    const at = Number(m[1]) * 60 + Number(m[2]);
    if (nowMin < at || nowMin > at + 4) continue;
    await ensureTable(env.DB);
    const key = `dial:${todayStr()}:${times[i]}`;
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO app_flags (k) VALUES (?)").bind(key).run();
    if (!claim.meta || !claim.meta.changes) continue;
    const n = (await env.DB.prepare(`SELECT COUNT(*) n FROM leads l WHERE ${QUEUE_WHERE}`).first() || {}).n || 0;
    if (!n) continue;
    await sendPush(env, { title: `${SESSION_NAMES[i] || "Dial"} dial session`, message: `${Math.min(n, QUEUE_MAX)} lead${n === 1 ? "" : "s"} waiting to be called. Tap to open.`, click: env.CRM_HOST ? `https://${env.CRM_HOST}/today` : undefined }).catch(() => {});
  }
}

// Leads still New, Not contacted or Contacted after 7 days move to the "7 day +" stage once (a person can move them back and they stay put)
async function ageLeads(env) {
  if (!env.DB) return;
  await ensureTable(env.DB);
  const rows = (await env.DB.prepare(`SELECT l.id, l.stage FROM leads l WHERE l.stage IN ('new','nocontact','contacted') AND l.type != 'newsletter' AND COALESCE(l.ip,'') != 'demo' AND l.created_at <= datetime('now','-7 days')
    AND NOT EXISTS (SELECT 1 FROM stage_log s WHERE s.lead_id = l.id AND s.reason LIKE 'Moved to 7 day +%') LIMIT 200`).all()).results || [];
  if (!rows.length) return;
  await env.DB.batch(rows.flatMap(r => [
    env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?, ?, 'aged', 'Moved to 7 day +: more than 7 days since the lead came in', 'system')").bind(r.id, r.stage),
    env.DB.prepare("UPDATE leads SET stage = 'aged', stage_changed_at = datetime('now') WHERE id = ? AND stage = ?").bind(r.id, r.stage),
  ]));
}
async function remindAppointments(env) {
  if (!env.DB) return;
  await ensureTable(env.DB);
  if (autoMode(env) && await env.DB.prepare("SELECT 1 FROM automations WHERE kind = 'appointment' AND active = 1").first()) return;
  const rows = (await env.DB.prepare("SELECT id, name, phone, appt_at FROM leads WHERE appt_reminded = 0 AND appt_remind_at IS NOT NULL AND appt_remind_at <= datetime('now') AND appt_remind_at >= datetime('now','-1 day') AND stage = 'booked' LIMIT 10").all()).results || [];
  for (const r of rows) {
    const claim = await env.DB.prepare("UPDATE leads SET appt_reminded = 1 WHERE id = ? AND appt_reminded = 0").bind(r.id).run();
    if (!claim.meta || !claim.meta.changes) continue;
    const who = r.name || prettyPhone(r.phone), at = fmtAppt(r.appt_at);
    const link = env.CRM_HOST ? `https://${env.CRM_HOST}/pipeline#id=${r.id}` : "";
    const text = `Hey, ${who} needs to be reminded of their appointment (${at}). Come press send. ${link}`.trim();
    await alertTeam(env, { subject: `Send a reminder: ${who}`, text, html: `<p style="font-size:16px"><b>Hey, ${esc(who)} needs to be reminded of their appointment (${esc(at)}).</b> Come press send.</p>${link ? `<p><a href="${esc(link)}">Open the lead</a></p>` : ""}`, push: { title: `Send a reminder: ${who}`, message: `Appointment ${at}. Come press send.`, click: link || undefined } }).catch(() => {});
  }
}

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
    ctx.waitUntil(retryDials(env).catch(e => console.error("retry error", e && e.message)));
    ctx.waitUntil(flagSilentDials(env).catch(e => console.error("flag error", e && e.message)));
    ctx.waitUntil(pullTranscripts(env).catch(e => console.error("transcript error", e && e.message)));
    ctx.waitUntil(pullRecordings(env).catch(e => console.error("recording error", e && e.message)));
    ctx.waitUntil(pollDials(env).catch(e => console.error("poll error", e && e.message)));
    ctx.waitUntil(runQueue(env).catch(e => console.error("queue error", e && e.message)));
    ctx.waitUntil((autoMode(env) ? runAutomations(env) : remindTexts(env)).catch(e => console.error("text automation error", e && e.message)));
    ctx.waitUntil(runCampaigns(env).catch(e => console.error("campaign error", e && e.message)));
    ctx.waitUntil(dialSessionReminder(env).catch(e => console.error("dial session error", e && e.message)));
    ctx.waitUntil(ageLeads(env).catch(e => console.error("aging error", e && e.message)));
    ctx.waitUntil(remindAppointments(env).catch(e => console.error("appointment reminder error", e && e.message)));
    ctx.waitUntil(numberHealthAlert(env).catch(e => console.error("number health error", e && e.message)));
    ctx.waitUntil(backfillNotes(env).catch(e => console.error("notes backfill error", e && e.message)));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    // When CRM_HOST is set (e.g. crm.divinedetailers.com) the lead dashboard lives only on that host, at its root.
    const crmHost = (env.CRM_HOST || "").toLowerCase();
    const onCrm = !!crmHost && url.hostname.toLowerCase() === crmHost;

    // Twilio domain verification: the file has to answer at exactly this address (the static site would redirect a .html name)
    if (p === "/6b27245cfce7349ca55c00a5acb5d511.html") return new Response("twilio-domain-verification=6b27245cfce7349ca55c00a5acb5d511", { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    // /review forwards to the Google review page (set GOOGLE_REVIEW_URL); texts link to this address on our own domain
    if (p === "/review" && env.GOOGLE_REVIEW_URL) return new Response(null, { status: 302, headers: { location: env.GOOGLE_REVIEW_URL, "cache-control": "no-store", "x-robots-tag": "noindex" } });
    if (p === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/" } });
    if (p === "/manifest.webmanifest") return new Response(JSON.stringify(MANIFEST), { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" } });

    // www.divinedetailers.com sends visitors to the bare domain (only once the real domain is configured)
    if (crmHost && url.hostname.toLowerCase().startsWith("www.") && url.hostname.toLowerCase().slice(4) === crmHost.replace(/^crm\./, "")) {
      return Response.redirect(`https://${url.hostname.slice(4)}${url.pathname}${url.search}`, 301);
    }

    if (onCrm) {
      // the CRM host only serves the dashboard (and its few endpoints), never the marketing site or the form API
      if (p === "/") return adminRoute("/admin/dashboard", request, env);
      if (p === "/dashboard" || p === "/admin/dashboard") return adminRoute("/admin/dashboard", request, env);
      if (p === "/today" || p === "/admin/today") return adminRoute("/admin/today", request, env);
      if (p === "/speed" || p === "/admin/speed") return adminRoute("/admin/speed", request, env);
      if (p === "/msgstats" || p === "/admin/msgstats") return adminRoute("/admin/msgstats", request, env);
      if (p === "/dials" || p === "/admin/dials") return adminRoute("/admin/dials", request, env);
      if (p === "/numbers" || p === "/admin/numbers") return adminRoute("/admin/numbers", request, env);
      if (p === "/meta" || p === "/admin/meta") return adminRoute("/admin/meta", request, env);
      if (p === "/reports" || p === "/admin/reports") return adminRoute("/admin/insights", request, env);
      if (p === "/rate" || p === "/admin/rate") return adminRoute("/admin/rate", request, env);
      if (p === "/playbook" || p === "/admin/playbook") return adminRoute("/admin/playbook", request, env);
      if (p === "/admin/scorecard") return adminRoute("/admin/scorecard", request, env);
      if (p === "/missed" || p === "/admin/missed") return adminRoute("/admin/missed", request, env);
      if (p === "/messages" || p === "/admin/messages") return adminRoute("/admin/messages", request, env);
      if (p === "/calendar" || p === "/admin/calendar") return adminRoute("/admin/calendar", request, env);
      if (p === "/dialer" || p === "/admin/dialer") return adminRoute("/admin/dialer", request, env);
      if (p.startsWith("/admin/rec/")) return adminRoute(p, request, env);
      if (p === "/automations" || p === "/admin/automations") return adminRoute("/admin/automations", request, env);
      if (p === "/ads" || p === "/admin/ads") return adminRoute("/admin/ads", request, env);
      if (p === "/ads.csv" || p === "/admin/ads.csv") return adminRoute("/admin/ads.csv", request, env);
      if (p === "/insights" || p === "/admin/insights") return adminRoute("/admin/insights", request, env);
      if (p.startsWith("/go/")) return adminRoute("/admin/go/" + p.slice(4), request, env);
      if (p === "/admin" || p === "/leads") return adminRoute("/admin", request, env);
      if (p === "/pipeline" || p === "/admin/pipeline") return adminRoute("/admin/pipeline", request, env);
      if (p.startsWith("/admin/push/")) return adminRoute(p, request, env);
      if (p.startsWith("/send/")) return adminRoute("/admin/send/" + p.slice(6), request, env);
      if (p === "/admin/stage" || p === "/admin/coach/ws" || p === "/admin/coach/status" || p === "/admin/coach/aitest" || p === "/admin/coach/turns" || p === "/admin/dialer/token" || p === "/admin/dialer/queue" || p === "/admin/dialer/lead" || p === "/admin/dialer/script" || p === "/admin/dialer/library" || p === "/admin/dialer/practice" || p === "/admin/dialer/offer" || p === "/admin/dialer/note" || p === "/admin/dialer/log" || p === "/admin/dialer/vmdrop" || p === "/admin/dialer/audio" || p === "/admin/dialer/audio/play" || p === "/admin/dialer/settings" || p === "/admin/automations/data" || p === "/admin/campaigns/data" || p === "/admin/campaigns/preview" || p === "/admin/campaigns/mark-meta" || p === "/admin/campaign" || p === "/admin/campaign/test" || p === "/admin/campaign/cancel" || p === "/admin/calendar/urable" || p === "/admin/calendar/find" || p === "/admin/automation" || p === "/admin/automation/toggle" || p === "/admin/automation/delete" || p === "/admin/threads" || p === "/admin/thread" || p === "/admin/msgstats/data" || p === "/admin/dials/data" || p === "/admin/users" || p === "/admin/dashboard/data" || p === "/admin/numbers/check" || p === "/admin/star" || p === "/admin/tags" || p === "/admin/note" || p === "/admin/markunread" || p === "/admin/snippets" || p === "/admin/snippets/render" || p === "/admin/unread" || p === "/admin/msg" || p === "/admin/book" || p === "/admin/leadinfo" || p === "/admin/lead" || p === "/admin/add" || p === "/admin/touch" || p === "/admin/appt" || p === "/admin/delete" || p === "/admin/queue" || p === "/admin/queue/start" || p === "/admin/queue/stop" || p === "/admin/dial" || p === "/admin/outcome" || p === "/admin/callrailtest" || p === "/admin/verifyshop" || p === "/admin/purge" || p === "/admin/calls" || p === "/admin/adspend" || p === "/admin/jobcost" || p === "/admin/demo" || p === "/admin/testalert") return adminRoute(p, request, env);
      if (p === "/leads.csv" || p === "/admin/leads.csv") return adminRoute("/admin/leads.csv", request, env);
      if (p === "/admin/contacted") return adminRoute("/admin/contacted", request, env);
      if (p === "/login" || p === "/logout") return loginRoute(p, request, env);
      if (p === "/ads-feed.csv" || p === "/api/ads-feed.csv" || p === "/ads-feed-completed.csv" || p === "/api/ads-feed-completed.csv") return adsFeed(request, env, url);
      if (p === "/favicon.ico" || p.startsWith("/assets/favicon")) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    }

    if (p === "/api/ads-feed.csv" || p === "/api/ads-feed-completed.csv") return adsFeed(request, env, url);

    if (p === "/api/callrail") {
      if (request.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);
      try { return await handleCallrail(request, env, url, ctx); }
      catch (e) { console.error("callrail error", e && e.message); return json({ success: false, message: "Server error" }, 500); }
    }

    if (p.startsWith("/api/twilio/stream/") && request.headers.get("upgrade") === "websocket") {
      const [, , , , sid, sig] = p.split("/");
      if (!coachEnabled(env) || !/^CA[0-9a-f]{32}$/.test(sid || "") || sig !== (await coachSig(env, sid))) return new Response("Forbidden", { status: 403 });
      return env.COACH.get(env.COACH.idFromName(sid)).fetch(request);
    }
    if (p === "/api/twilio/voice" || p === "/api/twilio/voice/recording" || p === "/api/twilio/voice/status") {
      if (request.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);
      try { return p === "/api/twilio/voice" ? await handleVoice(request, env) : p === "/api/twilio/voice/status" ? await handleVoiceStatus(request, env) : await handleVoiceRecording(request, env); }
      catch (e) { console.error("voice error", e && e.message); return new Response("Server error", { status: 500 }); }
    }
    if (p.startsWith("/vm/") && request.method === "GET") return publicVoicemail(env, p.slice(4).replace(/\.\w+$/, ""));
    if (p === "/api/twilio/sms" || p === "/api/twilio/status") {
      if (request.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);
      try { return p === "/api/twilio/sms" ? await handleTwilioSms(request, env) : await handleTwilioStatus(request, env); }
      catch (e) { console.error("twilio error", e && e.message); return new Response("Server error", { status: 500 }); }
    }
    if (p === "/api/meta") {
      if (request.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);
      try { return await handleMeta(request, env, url, ctx); }
      catch (e) { console.error("meta error", e && e.message); return json({ success: false, message: "Server error" }, 500); }
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
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Call ${esc(l.name || label)}</title>
<style>${FOLLOW_CSS}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07090c;color:#e8eaed;font:17px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;padding:20px;text-align:center}
main{width:min(420px,100%);display:flex;flex-direction:column;gap:12px}h1{margin:0;font-size:26px}p{margin:0;color:#98a0aa}
a.b{display:block;border-radius:16px;padding:20px;font-weight:800;text-decoration:none;font-size:22px;border:1px solid #2a313a;background:#151a21;color:#e8eaed}a.b.c{background:#32cd32;border-color:#32cd32;color:#04120a;font-size:24px;padding:24px}
.s{font-size:15px;font-weight:600;padding:16px}.m{background:#0d1116;border-left:3px solid #32cd32;border-radius:0 10px 10px 0;padding:10px 12px;text-align:left;color:#d6d9de;font-size:15px}</style></head>
<body><main><h1>${esc(l.name || label)}</h1><p>${esc([l.service, veh].filter(Boolean).join(" · ") || "New lead")}</p>${l.message ? `<div class="m">&ldquo;${esc(l.message.slice(0, 240))}&rdquo;</div>` : ""}
<a class="b c" id="call" href="tel:${esc(tel)}">Call ${esc(label)}</a><a class="b" id="text" href="${esc(sms)}">Text</a><a class="b s" href="/admin/pipeline#id=${l.id}">Open in the CRM</a>
<p style="font-size:13px">Signed in as ${esc(user)}. Tapping Call or Text logs it on this lead.</p></main>
${OUTCOME_HTML}<script>window.DD_LEAD=${l.id};${OUTCOME_JS}
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
  const { results: leads } = await env.DB.prepare("SELECT id,created_at,type,name,phone,service,make,year,model,answered,stage,stage_changed_at,value,gclid,gbraid,wbraid,utm_medium,utm_source,utm_campaign,utm_term,referrer,message,lost_reason FROM leads WHERE type != 'newsletter' AND COALESCE(ip,'') != 'demo' ORDER BY created_at DESC, id DESC LIMIT 3000").all();
  const { results: logs } = await env.DB.prepare("SELECT lead_id, at, by_user, reason, to_stage FROM stage_log ORDER BY id ASC LIMIT 30000").all();
  // The clock only stops when the lead is actually called: the Call button, a logged call outcome, or the auto-dial reaching the lead.
  // Texts, emails, the Contacted button and stage changes do not stop it.
  const isCallLog = r => /^called \(in-app dialer\)/i.test(r || "");
  // only calls placed from the in-app dialer count. Its log lines read "Called (in-app dialer): 3:12" or "...: not connected"
  const REACH_OUT = new Set(["Answered", "Interested", "Callback", "Booked", "Deposit pending", "Quote sent", "Not interested"]), NOREACH_OUT = new Set(["Left a voicemail", "Voicemail", "No answer", "Lead hung up", "Wrong number"]);
  const ATTEMPT = /^called \(in-app dialer\)/i, DIALRX = /^called \(in-app dialer\): (?:(\d+):(\d\d)|not connected)/i, minS = contactMinSecs(env);
  const dsec = g => { const m = DIALRX.exec(g.reason || ""); return m && m[1] != null ? Number(m[1]) * 60 + Number(m[2]) : 0; };
  const { results: msgs } = await env.DB.prepare("SELECT lead_id, direction, auto, at FROM messages WHERE lead_id IS NOT NULL ORDER BY id ASC LIMIT 80000").all();
  const msgBy = new Map();
  for (const m of msgs) { if (!msgBy.has(m.lead_id)) msgBy.set(m.lead_id, []); msgBy.get(m.lead_id).push(m); }
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
    if (g) { const st = new Date(ms(g.at) - dsec(g) * 1000).toISOString().slice(0, 19).replace("T", " "); contact = ms(st) < ms(l.created_at) ? g.at : st; by = g.by_user || ""; how = "Called from the dialer"; }
    else if (l.type === "call" && l.answered === 1) { contact = l.created_at; how = "Answered live"; }
    const t = etParts(l.created_at);
    const gl = byLead.get(l.id) || [];
    const dl = gl.filter(g => ATTEMPT.test(g.reason || ""));
    // the result picked after each dialer call ("Call result: Voicemail"); the latest pick for a call wins. A picked result beats guessing from call length (a voicemail greeting can run long)
    const callOut = new Map(); let lastCall = null;
    for (const g of gl) { if (ATTEMPT.test(g.reason || "")) lastCall = g; else { const m = /^call result: (.+)$/i.exec(g.reason || ""); if (m && lastCall) callOut.set(lastCall, m[1]); } }
    const reachedOf = g => { const o = callOut.get(g); if (o) { if (REACH_OUT.has(o)) return true; if (NOREACH_OUT.has(o)) return false; } return dsec(g) > minS; };
    const reachedLog = dl.find(reachedOf);
    const results = dl.map(g => ({ by: g.by_user || "", res: callOut.get(g) || (dsec(g) > minS ? "Answered" : dsec(g) ? "Short call" : "Not connected") }));
    const ml = msgBy.get(l.id) || [], bk = gl.find(g => BOOKED.includes(g.to_stage)), cutAt = bk ? ms(bk.at) : Infinity;
    const callsPre = dl.filter(g => ms(g.at) <= cutAt).length, textsPre = ml.filter(m => m.direction === "out" && ms(m.at) <= cutAt).length;
    const lostLog = [...gl].reverse().find(g => g.to_stage === "lost"), bookedLog = gl.find(g => BOOKED.includes(g.to_stage));
    const so = sourceOf(l);
    return {
      camp: l.utm_campaign || "", adname: ((/ad name:\s*([^\u00b7\n]+)/i.exec(l.message || "") || [])[1] || l.utm_term || "").trim(), adset: ((/adset name:\s*([^\u00b7\n]+)/i.exec(l.message || "") || [])[1] || "").trim(), form: ((/form name:\s*([^\u00b7\n]+)/i.exec(l.message || "") || [])[1] || "").trim(),
      id: l.id, name: l.name || l.phone || "Unknown", type: l.type, what: [l.service, [l.year, l.make, l.model].filter(Boolean).join(" ")].filter(Boolean).join(" · "),
      src: sourceOf(l).label, ad: sourceOf(l).ad, created: iso(l.created_at), created_abs: fmt(l.created_at), cd: new Date(ms(l.created_at)).toLocaleDateString("en-CA", { timeZone: TZ }),
      contact: contact ? iso(contact) : "", contact_abs: contact ? fmt(contact) : "", by, how,
      secs: contact ? Math.max(0, Math.round((ms(contact) - ms(l.created_at)) / 1000)) : null,
      booked: BOOKED.includes(l.stage) || gl.some(g => BOOKED.includes(g.to_stage)), value: l.value || 0,
      service: l.service || "Not set", stage: l.stage, h: t.h, channel: l.utm_medium === "paid_social" ? "meta" : so.ad ? "google" : "", srckey: so.ad ? (l.utm_medium === "paid_social" ? "Meta Ads" : "Google Ads") + (l.utm_campaign ? " \u00b7 " + l.utm_campaign : "") : so.label,
      lost: l.stage === "lost" ? (l.lost_reason ? l.lost_reason : lostLog && lostLog.reason && lostLog.reason !== "Moved" ? lostLog.reason.replace(/^Call result: /i, "") : "No reason logged") : "",
      booked_days: bookedLog ? Math.max(0, (ms(bookedLog.at) - ms(l.created_at)) / 864e5) : null, qv: l.stage === "quoted" ? (l.value || 0) : 0,
      outs: dl.map(g => ({ h: etParts(g.at).h, ok: reachedOf(g) })), outcomes: dl.map(g => callOut.get(g) || ""),
      unclassified: dl.filter(g => dsec(g) > 0 && !callOut.get(g)).length, attempts: dl.length, to_reach: reachedLog ? dl.indexOf(reachedLog) + 1 : null, reached: !!reachedLog, reached_by: reachedLog ? reachedLog.by_user || "" : "", results,
      calls: dl.length, texts_out: ml.filter(m => m.direction === "out").length, texts_auto: ml.filter(m => m.direction === "out" && m.auto).length, texts_in: ml.filter(m => m.direction === "in").length,
      touches_pre: callsPre + textsPre, never_called: dl.length === 0, inbound: l.type === "call",
      after: t.wd === "Sun" || t.h < 9 || t.h >= 18, open: !contact && l.type !== "call" && !["done", "lost"].includes(l.stage),
    };
  });
  return rows;
}

async function speedPage(env, user) {
  await ensureTable(env.DB);
  const tc = await todayCount(env);
  const rows = await speedRows(env);
  const payload = JSON.stringify({ rows, now: Date.now(), today: todayStr() }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Speed to lead | Divine Detailers</title>
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
@media(max-width:700px){header{padding:12px 14px}h1{font-size:17px}main{padding:8px 14px 20px}.row{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.row .n{grid-column:1/-1}}
</style></head><body>
<header><h1>Divine Detailers <b>speed to lead</b></h1>${nav("speed", tc, true)}</header>
${bnav("speed", tc, true)}
${insightTabs("speed")}
<main>
${RANGE_HTML}
<div class="kpis" id="k"></div>
<h2>How fast leads were called (number of leads)</h2><div class="chart" id="c1"></div>
<h2>By person</h2><div class="who" id="w"></div>
<h2>Every lead, newest first</h2><div class="list" id="l"></div>
<p class="note">A lead's clock starts when the form is sent. It stops when you place the first call from the dialer (the Call buttons in the Dial page and Pipeline both use it). Calls placed any other way, texts, emails and stage changes do not stop it. Leads who phoned you are left out of this page.</p>
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
function draw(){const L=pick().filter(r=>!r.inbound),done=L.filter(r=>r.secs!=null),secs=done.map(r=>r.secs),wait=L.filter(r=>r.secs==null&&r.open),forms=L.filter(r=>r.type==='quote'),calledF=forms.filter(r=>r.secs!=null),reachedF=calledF.filter(r=>r.reached);
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
  '<div class="kpi"><b>'+(calledF.length?(calledF.reduce((a,r)=>a+Math.max(1,r.attempts),0)/calledF.length).toFixed(1):'-')+'</b><span>Calls per form lead</span></div>'+
  '<div class="kpi"><b>'+L.reduce((a,r)=>a+(r.calls||0),0)+'</b><span>Dialer calls placed</span></div>';
 const BK=[['1 min',-1,60],['1&ndash;5 min',60,300],['5&ndash;15 min',300,900],['15&ndash;30 min',900,1800],['30&ndash;60 min',1800,3600],['1&ndash;2 hr',3600,7200],['2&ndash;4 hr',7200,14400],['4&ndash;24 hr',14400,86400],['24 hr +',86400,Infinity]];
 bars('c1',BK.map((b,i)=>{const n=done.filter(r=>r.secs>b[1]&&r.secs<=b[2]).length;return {l:b[0],v:n,t:n,s:done.length?Math.round(100*n/done.length)+'%':'',c:i<2?'':i<4?'mid':'low'}}).concat([{l:'Not called yet',v:wait.length,t:wait.length,s:'',c:'mute'}]));
 const by={};done.forEach(r=>{const k=r.by||(r.how==='Answered live'?'answered live':'not recorded');(by[k]=by[k]||[]).push(r.secs)});
 const pc={};L.forEach(r=>(r.results||[]).forEach(x=>{const k=x.by||'not recorded';(pc[k]=pc[k]||{n:0,a:0});pc[k].n++;if(!/voicemail|no answer|hung up|wrong number|not connected|short call/i.test(x.res))pc[k].a++}));
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


// ---- Booked jobs for Google Ads: the offline conversion upload (owner only)
// One row per booked (or completed) lead that carries a Google click ID, with the time it reached that stage and the job value.
async function adsData(env, days, stage) {
  await ensureTable(env.DB);
  const completed = stage === "completed";
  const rows = (await env.DB.prepare(`SELECT l.id, l.created_at, l.name, l.phone, l.type, l.value, l.stage, l.gclid, l.gbraid, l.wbraid, l.utm_source, l.utm_medium, l.utm_campaign, l.referrer,
      (SELECT MIN(s.at) FROM stage_log s WHERE s.lead_id = l.id AND s.to_stage IN (${completed ? "'done'" : "'booked','working','done'"})) AS conv_at
    FROM leads l WHERE l.type != 'newsletter' AND COALESCE(l.ip,'') != 'demo' AND l.stage IN (${completed ? "'done'" : "'booked','working','done'"}) ORDER BY l.id DESC LIMIT 2000`).all()).results || [];
  const ms = t => Date.parse(String(t).replace(" ", "T") + "Z");
  const cutoff = Date.now() - days * 864e5;
  const out = [];
  for (const r of rows) {
    const at = r.conv_at || r.created_at;
    if (ms(at) < cutoff) continue;
    // a click ID must be at most 90 days old, and the conversion cannot come before the lead
    const when = Math.max(ms(at), ms(r.created_at));
    out.push({ ...r, conv_at: new Date(when).toISOString().slice(0, 19).replace("T", " "), has: hasClick(r), ad: sourceOf(r).ad });
  }
  return out;
}
const etStamp = sql => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(String(sql).replace(" ", "T") + "Z")).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; };
const etStampOffset = sql => {
  const d = new Date(String(sql).replace(" ", "T") + "Z");
  const off = (new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(d).find(x => x.type === "timeZoneName") || {}).value || "GMT-05:00";
  const m = /GMT([+-]\d{2}:\d{2})/.exec(off);
  return etStamp(sql) + (m ? m[1] : "-05:00");
};
async function adsCsv(env, url, plain = false) {
  const days = [7, 30, 90].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
  const stage = url.searchParams.get("stage") === "completed" ? "completed" : "booked";
  const name = clean(url.searchParams.get("name") || (stage === "completed" ? "Completed job" : "Booked job"), 100).replace(/[",\r\n]/g, " ");
  const rows = (await adsData(env, days, stage)).filter(r => r.has);
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  // plain = the scheduled feed for Google's Data Manager: a normal table (no "Parameters" line, which it would read as a column name), with the Eastern UTC offset inside each time
  const lines = [...(plain ? [] : ["Parameters:TimeZone=" + TZ]), "Google Click ID,GBRAID,WBRAID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency"];
  for (const r of rows) {
    // one click ID per row: gclid first, otherwise the iPhone IDs
    const g = r.gclid || "", gb = !g ? (r.gbraid || "") : "", wb = !g && !gb ? (r.wbraid || "") : "";
    lines.push([g, gb, wb, name, (plain ? etStampOffset(r.conv_at) : etStamp(r.conv_at)), Number(r.value) > 0 ? Number(r.value) : 0, "USD"].map(q).join(","));
  }
  return new Response(lines.join("\n") + "\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="google-ads-${stage}-jobs-${days}d.csv"`, "cache-control": "no-store" } });
}
// A private address Google Ads can fetch on a schedule (Goals > Uploads > Schedules > HTTPS). It is protected with HTTP Basic sign-in:
// set the secrets ADS_FEED_USER and ADS_FEED_PASS, then give Google Ads the same user name and password. Without them the address does not exist.
async function adsFeed(request, env, url) {
  if (!env.ADS_FEED_USER || !env.ADS_FEED_PASS || !env.DB) return new Response("Not found", { status: 404 });
  const h = request.headers.get("authorization") || "";
  let ok = false;
  if (/^basic /i.test(h)) { try { const [u, ...pw] = atob(h.slice(6).trim()).split(":"); ok = safeEqual(u, env.ADS_FEED_USER) && safeEqual(pw.join(":"), env.ADS_FEED_PASS); } catch (e) { ok = false; } }
  if (!ok) return new Response("Sign in required", { status: 401, headers: { "www-authenticate": 'Basic realm="Divine Detailers ads feed"', "cache-control": "no-store" } });
  if (!url.searchParams.get("days")) url.searchParams.set("days", "90");
  if (/completed\.csv$/.test(url.pathname)) url.searchParams.set("stage", "completed");
  return adsCsv(env, url, true);
}
async function adsPage(env, user, url) {
  const tc = await todayCount(env);
  const days = [7, 30, 90].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
  const stage = url.searchParams.get("stage") === "completed" ? "completed" : "booked";
  const rows = await adsData(env, days, stage);
  const withId = rows.filter(r => r.has), leaks = rows.filter(r => !r.has && r.ad), organic = rows.filter(r => !r.has && !r.ad);
  const val = withId.reduce((a, r) => a + (Number(r.value) || 0), 0);
  const money = n => "$" + Math.round(n).toLocaleString("en-US");
  const dflt = stage === "completed" ? "Completed job" : "Booked job";
  const link = (d, st, label) => `<a class="rb${d === days && st === stage ? " on" : ""}" href="/admin/ads?days=${d}&stage=${st}">${label}</a>`;
  const leakRows = leaks.map(r => `<tr><td><a href="/admin/pipeline#id=${r.id}">${esc(r.name || prettyPhone(r.phone))}</a><br><span class="note">${esc(prettyPhone(r.phone))}</span></td><td>${esc(when(r.conv_at).abs)}</td><td>${esc(sourceOf(r).label)}${sourceOf(r).detail ? '<br><span class="note">' + esc(sourceOf(r).detail) + "</span>" : ""}</td><td>${r.value ? money(r.value) : "-"}</td></tr>`).join("");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Google Ads upload | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#07090c;color:#e8eaed}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px;flex-wrap:wrap}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}.navtabs a.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
main{max-width:1000px;margin:0 auto;padding:16px 22px 40px;display:flex;flex-direction:column;gap:18px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.kpi{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:14px}.kpi b{display:block;font-size:26px;line-height:1.15}.kpi span{color:#8a9099;font-size:12.5px}.kpi.g b{color:#32cd32}.kpi.r b{color:#ff6b6b}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:#c3c8cf;margin:6px 0 0}.note{color:#7c838d;font-size:12.5px}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.rb{color:#aab0b9;text-decoration:none;padding:7px 14px;border-radius:999px;border:1px solid #232932}.rb.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
.dl{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:10px}.dl form{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.dl input{background:#07090c;border:1px solid #2a313a;color:#e8eaed;border-radius:10px;padding:10px 12px;font:inherit;min-width:200px}.dl button{background:#32cd32;color:#04120a;border:0;border-radius:10px;padding:11px 18px;font:700 15px system-ui;cursor:pointer}
ol{margin:0;padding-left:20px;color:#c3c8cf}ol li{margin:4px 0}
.tbw{overflow-x:auto;background:#0d1116;border:1px solid #1d2229;border-radius:14px}.tb{width:100%;border-collapse:collapse}.tb th,.tb td{text-align:left;padding:10px 12px;border-bottom:1px solid #1b1f25;vertical-align:top}.tb th{color:#8a9099;font-size:12px;text-transform:uppercase;letter-spacing:.6px}.tb a{color:#32cd32;text-decoration:none;font-weight:600}
${BNAV_CSS}
@media(max-width:700px){header{padding:12px 14px}h1{font-size:17px}main{padding:8px 14px 20px}}
</style></head><body>
<header><h1>Divine Detailers <b>Google Ads upload</b></h1>${nav("insights", tc, true)}</header>
${bnav("insights", tc, true)}
${insightTabs("ads")}
<main>
<div class="bar">${link(7, stage, "Last 7 days")}${link(30, stage, "Last 30 days")}${link(90, stage, "Last 90 days")}<span class="note">&nbsp;|&nbsp;</span>${link(days, "booked", "Booked jobs")}${link(days, "completed", "Completed jobs")}</div>
<div class="kpis"><div class="kpi"><b>${rows.length}</b><span>${stage === "completed" ? "completed" : "booked"} jobs in range</span></div><div class="kpi g"><b>${withId.length}</b><span>ready to upload (have a Google click ID)</span></div><div class="kpi g"><b>${money(val)}</b><span>value in the upload</span></div><div class="kpi ${leaks.length ? "r" : ""}"><b>${leaks.length}</b><span>from Google Ads but no click ID saved</span></div><div class="kpi"><b>${organic.length}</b><span>not from ads (left out)</span></div></div>
<div class="dl"><h2>Download</h2>
<form method="GET" action="/admin/ads.csv"><input type="hidden" name="days" value="${days}"><input type="hidden" name="stage" value="${stage}"><input name="name" value="${esc(dflt)}" aria-label="Conversion name"><button type="submit">Download CSV (${withId.length} rows)</button></form>
<span class="note">The conversion name must match the name of the conversion action in Google Ads exactly.</span></div>
<h2>Automatic upload (no clicking)</h2>
<p class="note" style="color:#c3c8cf;font-size:14px">Google Ads can fetch this file by itself every day. In Cloudflare add two secrets, <b>ADS_FEED_USER</b> and <b>ADS_FEED_PASS</b> (pick any user name and a long password), and Deploy. Then in Google Ads go to <b>Goals → Uploads → Schedules → +</b>, choose <b>HTTPS</b>, and enter this address plus the same user name and password:</p>
<p><code style="background:#0d1116;border:1px solid #1d2229;border-radius:8px;padding:8px 10px;display:inline-block;word-break:break-all">https://${esc(url.host)}/${env.CRM_HOST && url.host === env.CRM_HOST ? "" : "api/"}ads-feed${stage === "completed" ? "-completed" : ""}.csv</code></p>
<p class="note">Schedule it daily. The address returns the last 90 days of ${stage === "completed" ? "completed" : "booked"} jobs that have a click ID. Google ignores jobs it already has.</p>
<h2>Or upload it by hand</h2>
<ol><li>In Google Ads, go to <b>Goals → Conversions → New conversion action → Import → Other data sources or CRMs → Track conversions from clicks</b>. Name it "${esc(dflt)}" (once).</li><li>Go to <b>Goals → Uploads → +</b>, choose the CSV and upload it. Open Google's own template first if it asks, to compare the column names.</li><li>Upload weekly (or daily). Uploading the same job twice is ignored by Google, so overlapping ranges are safe.</li><li>Click IDs expire after 90 days, so upload within that window.</li></ol>
<h2>Booked jobs from ads that are missing a click ID</h2>
${leaks.length ? `<div class="tbw"><table class="tb"><tr><th>Lead</th><th>Reached stage</th><th>Source</th><th>Value</th></tr>${leakRows}</table></div><p class="note">These are tagged as Google Ads (UTM or call tracking) but no click ID was saved, so Google can't match them. They are left out of the file.</p>` : '<p class="note">None. Every booked job from Google Ads has a click ID.</p>'}
</main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// Owner-only board: every auto-dial where the agent did not answer or did not press 1, and whether the lead was called afterwards
async function ratePage(env, user) {
  const rows = await speedRows(env);
  const tc = await todayCount(env);
  const payload = JSON.stringify({ rows, today: todayStr() }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Contact rate | Divine Detailers</title>
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
${insightTabs("rate")}
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
function draw(){const L=pick().filter(r=>r.type==='quote'&&r.secs!=null);const UN=L.reduce((a,r)=>a+(r.unclassified||0),0),CALLS=L.reduce((a,r)=>a+(r.calls||0),0);
 const g=BK.map(b=>{const x=L.filter(r=>r.secs>b[1]&&r.secs<=b[2]);return {l:b[0],n:x.length,rc:x.filter(r=>r.reached).length,bk:x.filter(r=>r.booked).length,val:x.filter(r=>r.booked).reduce((a,r)=>a+(r.value||0),0)}});
 const tot={n:L.length,rc:L.filter(r=>r.reached).length,bk:L.filter(r=>r.booked).length,val:L.filter(r=>r.booked).reduce((a,r)=>a+(r.value||0),0)};
 document.getElementById('k').innerHTML='<div class="kpi g"><b>'+(tot.n?pc(tot.rc,tot.n)+'%':'-')+'</b><span>Contact rate (reached &divide; called)</span></div><div class="kpi"><b>'+tot.rc+' of '+tot.n+'</b><span>Form leads reached</span></div><div class="kpi"><b>'+(tot.rc?(L.filter(r=>r.reached).reduce((a,r)=>a+(r.to_reach||1),0)/tot.rc).toFixed(1):'-')+'</b><span>Avg calls per contact (calls it took to reach a lead)</span></div><div class="kpi g"><b>'+(tot.n?pc(tot.bk,tot.n)+'%':'-')+'</b><span>Booked rate (booked &divide; called)</span></div><div class="kpi"><b>'+tot.bk+'</b><span>Booked jobs ('+money(tot.val)+')</span></div>'+'<div class="kpi '+(UN?'r':'')+'"><b>'+UN+' of '+CALLS+'</b><span>Calls that connected but have no result picked afterwards (guessed from call length, so less reliable)</span></div>';
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

// ---- Playbook (owner): the rules, in plain words, with live numbers from the same definitions
const PB_RESULTS = [
  ["Booked", "They agreed to a date and paid or promised the deposit.", "Asks for the appointment day/time and price first. Moves to Deposit collected, sets the reminder text, clears follow-ups.", "Yes"],
  ["Deposit pending", "They want it but have not paid the deposit yet.", "Moves to Deposit pending, follow-up due in 1 day (Collect deposit).", "Yes"],
  ["Callback", "They asked you to call at another time.", "Moves to Interested. You pick the day; it shows on Today and in the dialer on that day.", "Yes"],
  ["Interested", "Real conversation, no date yet.", "Moves to Interested, follow-up due in 2 days unless a later one is already set.", "Yes"],
  ["Quote sent", "You gave a price and are waiting.", "Moves to Quote sent, follow-up due in 2 days. Never moves a Deposit pending lead backwards.", "Yes"],
  ["Answered", "They picked up and talked but none of the above fits.", "Marks the lead contacted, follow-up due in 2 days.", "Yes"],
  ["Not interested", "A real person said no.", "Asks why (price, went elsewhere, not ready, changed mind, other). Moves to NO, stops all follow-ups and automations.", "Yes"],
  ["Left a voicemail", "You hit the voicemail, with or without dropping a message.", "Lead stays where it is. Next call is scheduled by the retry cadence below.", "No"],
  ["No answer", "It rang out.", "Same as voicemail: retry cadence.", "No"],
  ["Lead hung up", "They picked up and hung up straight away.", "Same as voicemail: retry cadence. Not a conversation.", "No"],
  ["Wrong number", "Not the lead's phone.", "Moves to NO with the reason Wrong number, stops follow-ups.", "No"],
];
const PB_METRICS = [
  ["Speed to lead", "Time from the form arriving to the start of your first dialer call.", "A lead called in 5 minutes is far more likely to answer than one called in an hour. This is the number to beat first.", "Calls you make from the dialer only. Texts, the Contacted button and moving stages do not stop the clock. Reliable from day one."],
  ["Pick-up rate", "Calls Twilio says the lead answered (a real connection, talk time over 0) divided by calls placed.", "Shows if your number gets answered at all. A fall here with no change in your habits means the number is flagged as spam.", "Needs Twilio's call reports (added with this update). Older calls show as not reported."],
  ["Contact rate (leads)", "Leads that had a real conversation divided by leads you called.", "Tells you how much of your lead supply you can talk to. Every sale starts here.", "Uses the result you pick after each call. If no result was picked, a call over 45 seconds is guessed as a conversation and flagged as unclassified."],
  ["Conversation rate (dials)", "Calls that ended in a conversation result divided by all calls placed.", "Tells you how much calling effort it takes to get one conversation. Different from contact rate: this counts every attempt.", "Inside the chosen days, by when the call was made."],
  ["Dials per lead", "Average calls placed to each called lead.", "Too low means giving up early. Too high means chasing leads who will not answer.", "Leads that came in during the chosen days."],
  ["Dials to reach", "Average number of calls it took to get the first conversation, for leads that were reached.", "Tells you how many tries to plan for before a lead is not worth more calls.", "Only leads that were reached."],
  ["Dials per booking", "Cohort: total calls on booked leads divided by booked jobs. Period: all calls in the days divided by bookings in the days.", "How hard you work for one job. The lowest honest measure of calling efficiency.", "Cohort needs leads to have had time to book (14 days). Period is instant but mixes old and new leads."],
  ["Touchpoints per booking", "Calls plus texts you sent to a lead before it booked, averaged over booked leads.", "Shows how many contacts a sale takes, so you know when to keep going and when to stop.", "Automatic texts count; the lead's own texts do not."],
  ["Booked rate", "Booked leads divided by all leads that came in.", "The headline: how many leads turn into jobs.", "A lead counts as booked once, the first time it reaches Deposit collected."],
  ["Average job", "Total value of booked leads divided by booked leads.", "What a booking is worth. Needs the price saved with the booking, which the Booked result now requires.", "Bookings with no price are listed under data checks."],
  ["Cost per lead", "Ad spend in the days divided by paid leads (Meta or Google) in the days.", "Shows what the ads cost to get a form.", "Spend is the monthly amount you enter, spread evenly over its days."],
  ["Cost per booked job", "Ad spend divided by paid leads that booked.", "The number that says if ads make money. Compare it with the average job.", "Wait 14 days after the leads arrive before trusting it: late bookings are still coming in."],
  ["ROAS", "Booked revenue from paid leads divided by ad spend.", "Dollars back for every ad dollar. Under 1 loses money.", "Same 14 day wait. Uses the saved booking price."],
];
async function playbookPage(env, user) {
  const tc = await todayCount(env);
  const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const tr = rows => rows.map(r => "<tr>" + r.map((c, i) => `<td${i === 0 ? " class=\"k\"" : ""}>${esc(c)}</td>`).join("") + "</tr>").join("");
  const ret = CALL_RULES.retryDays.map((d, i) => `try ${i + 2}: ${d === 0 ? "later today" : d === 1 ? "next day" : "after " + d + " days"}`).join(", ");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Playbook | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#07090c;color:#e8eaed}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px;flex-wrap:wrap}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}
main{max-width:1000px;margin:0 auto;padding:16px 22px 40px;display:flex;flex-direction:column;gap:16px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:#c3c8cf;margin:14px 0 0}p,li{color:#c9ced6}ol,ul{margin:6px 0;padding-left:22px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.kpi{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:14px}.kpi b{display:block;font-size:26px;line-height:1.15}.kpi span{color:#8a9099;font-size:12.5px}.kpi.g b{color:#32cd32}.kpi.r b{color:#ff8a8a}
.rb{display:flex;gap:6px}.rb button{background:#10141a;border:1px solid #232932;color:#cfd3d9;border-radius:999px;padding:8px 14px;cursor:pointer;font:inherit}.rb button.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
.tbw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th{text-align:left;color:#8a939e;font-size:12px;text-transform:uppercase;letter-spacing:.5px;padding:8px 10px;border-bottom:1px solid #232932}td{padding:9px 10px;border-bottom:1px solid #161c23;vertical-align:top}td.k{font-weight:700;white-space:nowrap}
.warn{background:#1d1608;border:1px solid #4d3a1d;color:#f5c97a;border-radius:12px;padding:10px 14px;font-size:14px}
${BNAV_CSS}
@media(max-width:700px){header{padding:12px 14px}main{padding:8px 14px 20px}}
</style></head><body>
<header><h1>Divine Detailers <b>playbook</b></h1>${nav("playbook", tc, true)}</header>
${bnav("playbook", tc, true)}
${insightTabs("playbook")}
<main>
<div class="rb" id="rg"><button data-d="7">7 days</button><button data-d="14">14 days</button><button data-d="30" class="on">30 days</button><button data-d="90">90 days</button></div>
<h2>Scorecard</h2><div class="kpis" id="sc"></div>
<h2>Data checks (fix these first if they are not zero)</h2><div class="kpis" id="dq"></div><div class="warn" id="dqn" hidden></div>

<h2>How to use the system, every day</h2>
<ol>
<li><b>Open Today.</b> It lists new leads not yet called (oldest first) and everything due: callbacks, follow-ups, reminders. Work top to bottom.</li>
<li><b>Call new leads the moment they arrive.</b> The goal is under 5 minutes, any hour you are awake. Manual dials work at any hour; the automatic dialer and texts keep their quiet hours.</li>
<li><b>After every call, pick the result.</b> The call box stays open until you do. This is the one habit the numbers depend on. If you skip it, the call is guessed from its length and flagged.</li>
<li><b>Never leave a lead without a next step.</b> Booked leads have an appointment. Everyone else in play has a follow-up date. The result you pick sets it for you.</li>
<li><b>Look at this page weekly.</b> Fix any data check above zero, then read the scorecard against the targets below.</li>
</ol>

<h2>What each call result means and what the system does</h2>
<div class="tbw"><table><tr><th>Result</th><th>Pick it when</th><th>What the system does</th><th>Counts as a conversation</th></tr>${tr(PB_RESULTS)}</table></div>
<p>Rules that cannot be skipped: <b>Booked</b> needs the appointment and price. <b>Not interested</b> needs a reason. <b>Callback</b> needs a day. Calling, texting or emailing never moves a lead on its own, only the result you pick does. A booked, in-shop or finished job is never moved backwards by a later result.</p>

<h2>Calling cadence</h2>
<ul>
<li><b>First call:</b> within 5 minutes of the form. Second attempt within the hour if there was no answer, then a text (the "missed you" snippet).</li>
<li><b>When a call does not reach them</b> the next try is scheduled for you: ${esc(ret)}.</li>
<li><b>Stop after ${CALL_RULES.maxTries} calls</b> with no conversation. The lead drops off the automatic call list. You can still call it from the pipeline.</li>
<li><b>Best times:</b> the Insights page shows the hours where calls get answered. Use it to space your tries across different hours rather than calling at the same time.</li>
</ul>

<h2>The numbers: definition, why, and when to trust it</h2>
<div class="tbw"><table><tr><th>Metric</th><th>How it is worked out</th><th>Why it matters</th><th>When it is reliable</th></tr>${tr(PB_METRICS)}</table></div>

<h2>Why this can be trusted, and where it cannot</h2>
<ul>
<li>Every call is now reported twice: by your browser and by Twilio. If the tab closes mid-call, Twilio still records the call, who made it and how long it was.</li>
<li>Day boundaries use Eastern time year round, including daylight saving.</li>
<li>One definition of "called" and "reached" is used by the Dashboard, Speed to lead, Contact rate and this page.</li>
<li>It cannot know a result you did not pick, a price you did not enter, or ad spend you did not type in. The data checks above count exactly those gaps.</li>
<li>Small samples lie. With fewer than about 20 leads in a range, treat percentages as direction, not fact.</li>
</ul>
</main>
<script>
const $=t=>String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;');
const mn=s=>s==null?'-':s<90?s+' sec':s<5400?Math.round(s/60)+' min':(s/3600).toFixed(1)+' hr';
const pc=v=>v==null?'-':v+'%',dl=v=>v==null?'-':'$'+Number(v).toLocaleString('en-US'),nm=v=>v==null?'-':v;
let days=30;
function kp(b,l,c){return '<div class="kpi '+(c||'')+'"><b>'+b+'</b><span>'+l+'</span></div>'}
async function load(){const j=await (await fetch('/admin/scorecard?days='+days)).json();if(!j.success)return;const a=j.activity,c=j.cohort,m=j.cost.all,q=j.quality;
 document.getElementById('sc').innerHTML=
  kp(mn(c.speed_median_secs),'Median speed to lead','g')+kp(pc(c.within_5min),'Leads called within 5 min')+kp(pc(c.contact_rate),'Contact rate (leads reached / called)','g')+kp(c.never_called,'Leads never called',c.never_called?'r':'')+
  kp(a.dials,'Calls placed')+kp(pc(a.pickup_rate),'Pick-up rate (Twilio)')+kp(pc(a.conversation_rate),'Conversation rate (per call)')+kp(nm(c.dials_to_reach),'Calls to reach a lead')+
  kp(c.booked+' ('+pc(c.booked_rate)+')','Booked from leads in range','g')+kp(nm(c.dials_per_booking),'Calls per booking (these leads)')+kp(nm(a.dials_per_booking),'Calls per booking (this period)')+kp(nm(c.touchpoints_per_booking),'Touchpoints per booking')+
  kp(dl(c.avg_job),'Average job')+kp(dl(c.revenue),'Booked revenue')+kp(nm(c.days_to_book),'Days from lead to booking')+
  kp(dl(m.cost_per_lead),'Cost per paid lead')+kp(dl(m.cost_per_booking),'Cost per booked job (paid)','g')+kp(m.roas==null?'-':m.roas+'x','ROAS');
 document.getElementById('dq').innerHTML=kp(q.dials_unclassified+' ('+pc(q.dials_unclassified_pct)+')','Connected calls with no result picked',q.dials_unclassified?'r':'')+kp(q.dials_without_twilio_report,'Calls with no Twilio report',q.dials_without_twilio_report?'r':'')+kp(q.booked_without_price,'Bookings with no price',q.booked_without_price?'r':'')+kp(q.lost_without_reason,'NO leads with no reason',q.lost_without_reason?'r':'');
 const n=document.getElementById('dqn');n.hidden=false;n.textContent=q.note}
document.querySelectorAll('#rg button').forEach(b=>b.onclick=()=>{days=+b.dataset.d;document.querySelectorAll('#rg button').forEach(x=>x.classList.toggle('on',x===b));load()});
load();
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// ---- Insights (owner only): funnel, revenue, sources and ad return, services, lost reasons, busiest hours, best time to call
async function insightsPage(env, user) {
  const rows = await speedRows(env);
  const tc = await todayCount(env);
  const spend = { google: {}, meta: {} };
  for (const r of (await env.DB.prepare("SELECT month, channel, amount FROM ad_spend2").all()).results) (spend[r.channel] = spend[r.channel] || {})[r.month] = r.amount;
  const costs = Object.fromEntries((await env.DB.prepare("SELECT service, cost FROM job_costs").all()).results.map(r => [r.service, r.cost]));
  const payload = JSON.stringify({ rows, today: todayStr(), spend, costs, services: ["Window Tint", "PPF / Clear Bra", "Ceramic Coating", "Paint Correction", "Vinyl Wraps", "Exterior Detailing", "Other"] }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Reports | Divine Detailers</title>
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
<header><h1>Divine Detailers <b>reports</b></h1>${nav("insights", tc, true)}</header>
${bnav("insights", tc, true)}
${insightTabs("insights")}
<main>
${RANGE_HTML}
<div class="kpis" id="k"></div>
<h2>Lead funnel<small>how many leads make it through each step</small></h2><div class="chart" id="fn"></div>
<h2>Speed to lead vs closing<small>how fast the first dialer call went out, and how many of those leads booked</small></h2><div class="tbw"><table class="tb" id="spd"></table></div>
<h2>How calls ended<small>the result picked after each dialer call</small></h2><div class="hb" id="oc"></div>
<h2>Follow-up effort<small>calls from the dialer plus texts sent</small></h2><div class="kpis" id="eff"></div><div class="tbw"><table class="tb" id="tch"></table></div>
<h2>Ad return<small>worked out for you from the leads, booked job values, and the ad spend and job costs entered at the bottom &middot; <a href="/admin/ads" style="color:#32cd32">Upload booked jobs to Google Ads</a></small></h2><div class="kpis" id="ads"></div><div class="tbw"><table class="tb" id="adt"></table></div>
<h2>Where leads come from</h2><div class="tbw"><table class="tb" id="src"></table></div>
<h2>Which services bring the money</h2><div class="tbw"><table class="tb" id="svc"></table></div>
<h2>Why leads are lost<small>the reason picked when a lead moves to Lost</small></h2><div class="hb" id="lost"></div>
<h2>When leads arrive<small>number of leads by hour of day, Eastern time (purple = outside business hours)</small></h2><div class="chart" id="hr"></div>
<h2>Best time to call<small>share of logged calls that were answered, by hour of day (needs at least 3 calls in an hour)</small></h2><div class="chart" id="bt"></div>
<h2>Monthly Google Ads spend<small>type the amount spent each month; it is saved automatically</small></h2><div class="sp" id="sp"></div>
<h2>Monthly Meta Ads spend<small>same for Facebook and Instagram</small></h2><div class="sp" id="spm"></div>
<h2>What a job costs you<small>materials and labor for an average job of each service; used for profit per job</small></h2><div class="sp" id="jc"></div>
<p class="note">Revenue uses the job value you enter on each lead in the Pipeline, and "booked" means the lead is in Booked, In the shop or Completed (or was). Numbers get more reliable as more leads are logged. Small groups can swing a lot.</p>
</main>
<script type="application/json" id="data">${payload}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent),R=D.rows,TODAY=D.today;let SP=D.spend||{};SP.google=SP.google||{};SP.meta=SP.meta||{};const JC=D.costs||{};
${RANGE_JS}
${CHART_JS}
const $=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>'$'+Math.round(n||0).toLocaleString('en-US'),pc=(a,b)=>b?Math.round(100*a/b)+'%':'-',med=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),i=Math.floor(b.length/2);return b.length%2?b[i]:(b[i-1]+b[i])/2};
function spendFor(ch,f,t){let tot=0;const S=SP[ch]||{};for(const m in S){const y=+m.slice(0,4),mo=+m.slice(5,7),dim=new Date(Date.UTC(y,mo,0)).getUTCDate(),first=m+'-01',last=m+'-'+String(dim).padStart(2,'0'),lo=f&&f>first?f:first,hi=t&&t<last?t:last;if(lo>hi)continue;tot+=S[m]*(((dt(hi)-dt(lo))/864e5)+1)/dim}return tot}
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
 const CHS=[['google','Google Ads'],['meta','Meta Ads'],['all','All paid']];
 const cs=Object.fromEntries(CHS.map(([k])=>{const x=k==='all'?L.filter(r=>r.ad):L.filter(r=>r.channel===k),b=x.filter(r=>r.booked),rev=b.reduce((a,r)=>a+(r.value||0),0),jc=b.reduce((a,r)=>a+(JC[r.service]||0),0),sp=k==='all'?spendFor('google',f,t)+spendFor('meta',f,t):spendFor(k,f,t);return [k,{n:x.length,b:b.length,rev:rev,jc:jc,sp:sp,profit:rev-jc-sp}]}));
 const dv=(a,b,fn)=>b?fn(a/b):'-',m1=n=>'$'+(n>=100?Math.round(n).toLocaleString('en-US'):n.toFixed(2)),A=cs.all,hasCost=Object.values(JC).some(v=>v>0);
 document.getElementById('ads').innerHTML=A.sp>0&&A.n?'<div class="kpi g"><b>'+dv(A.sp,A.n,m1)+'</b><span>Average cost per lead</span></div><div class="kpi"><b>'+dv(A.n,A.b,x=>x.toFixed(1))+'</b><span>Leads for 1 booked job</span></div><div class="kpi g"><b>'+dv(A.sp,A.b,m1)+'</b><span>Ad cost per booked job</span></div><div class="kpi g"><b>'+dv(A.profit,A.b,m1)+'</b><span>Profit per job'+(hasCost?'':' (job costs not entered)')+'</span></div><div class="kpi g"><b>'+dv(A.rev,A.sp,x=>x.toFixed(1)+'x')+'</b><span>Return on ad spend ('+money(A.rev)+' booked)</span></div>':'<div class="note">Enter your monthly ad spend at the bottom of the page and these fill in by themselves: cost per lead, leads per booked job, profit per job and return on ad spend.</div>';
 const row=(lab,fn)=>[lab].concat(CHS.map(([k])=>fn(cs[k])));
 tbl('adt',['Per channel (this range)','Google Ads','Meta Ads','All paid'],A.n||A.sp?[
  row('Ad spend',c=>c.sp?money(c.sp):'-'),row('Leads',c=>c.n),row('Cost per lead',c=>dv(c.sp,c.n,m1)),
  row('Booked jobs',c=>c.b),row('Leads for 1 booked job',c=>dv(c.n,c.b,x=>x.toFixed(1))),row('Booked rate',c=>pc(c.b,c.n)),
  row('Ad cost per booked job',c=>dv(c.sp,c.b,m1)),row('Booked revenue',c=>money(c.rev)),row('Average job value',c=>dv(c.rev,c.b,money)),
  row('Estimated job costs',c=>c.jc?money(c.jc):'-'),row('Profit after ads and job costs',c=>c.sp||c.rev?money(c.profit):'-'),
  row('Profit per job',c=>dv(c.profit,c.b,m1)),row('Return on ad spend',c=>dv(c.rev,c.sp,x=>x.toFixed(1)+'x'))]:[]);
 tbl('src',['Source','Leads','Reached','Booked','Booked rate','Revenue'],groupBy(L,r=>r.srckey).map(([k,x])=>{const a=stats(x);return [$(k),a.n,a.calledF?a.reachedF+' of '+a.calledF:'-',a.b,pc(a.b,a.n),money(a.rev)]}));
 tbl('svc',['Service','Leads','Booked','Booked rate','Revenue','Avg job'],groupBy(L,r=>r.service).map(([k,x])=>{const a=stats(x);return [$(k),a.n,a.b,pc(a.b,a.n),money(a.rev),a.avg?money(a.avg):'-']}));
 hb('lost',groupBy(L.filter(r=>r.stage==='lost'),r=>r.lost).map(([k,x])=>[k,x.length]),true);
 const hrs=Array.from({length:24},(_,h)=>L.filter(r=>r.h===h).length),lab=h=>(h%12||12)+(h<12?'a':'p');
 bars('hr',hrs.map((n,h)=>({l:lab(h),v:n,t:n||'',c:h>=9&&h<18?'':'mute'})));
 const outs=[].concat(...L.map(r=>r.outs||[])),bt=Array.from({length:24},(_,h)=>{const x=outs.filter(o=>o.h===h);return {h:h,n:x.length,a:x.filter(o=>o.ok).length}});
 const btItems=bt.filter(x=>x.n>0).map(x=>({l:lab(x.h),v:x.n>=3?Math.round(100*x.a/x.n):0,t:x.n>=3?Math.round(100*x.a/x.n)+'%':'-',s:x.a+' of '+x.n,c:x.n>=3?'':'mute',small:x.n<5}));
 document.getElementById('bt').innerHTML=btItems.length?'':'<div class="note" style="padding:14px">No dialer calls in this range yet.</div>';if(btItems.length)bars('bt',btItems);
 // speed to lead vs closing: leads grouped by how fast the first dialer call went out
 const FL=L.filter(r=>!r.inbound),SB=[['Within 5 min',0,300],['5-15 min',300,900],['15-60 min',900,3600],['1-4 hours',3600,14400],['4-24 hours',14400,86400],['Over 24 hours',86400,Infinity]];
 const sr=SB.map(b=>{const x=FL.filter(r=>r.secs!=null&&r.secs>=b[1]&&(r.secs<b[2]||(b[2]===Infinity&&r.secs>=b[1])));const bk=x.filter(r=>r.booked);return [b[0],x.length,x.filter(r=>r.reached).length,bk.length,pc(bk.length,x.length),money(bk.reduce((a,r)=>a+(r.value||0),0))]});
 const nc=FL.filter(r=>r.secs==null),ncb=nc.filter(r=>r.booked);sr.push(['Never called',nc.length,0,ncb.length,pc(ncb.length,nc.length),money(ncb.reduce((a,r)=>a+(r.value||0),0))]);
 tbl('spd',['First dialer call','Leads','Reached','Booked','Booked rate','Revenue'],FL.length?sr:[]);
 hb('oc',groupBy(FL.flatMap(r=>(r.outcomes||[]).filter(Boolean).map(o=>({o:o}))),x=>x.o).map(([k,x])=>[k,x.length]));
 // touchpoints: dialer calls + texts sent
 const T=r=>(r.calls||0)+(r.texts_out||0),bkd=FL.filter(r=>r.booked),avgT=a=>a.length?(a.reduce((x,r)=>x+T(r),0)/a.length).toFixed(1):'-',withT=FL.filter(r=>(r.texts_out||0)>0);
 document.getElementById('eff').innerHTML='<div class="kpi g"><b>'+(bkd.length?(bkd.reduce((a,r)=>a+(r.touches_pre||0),0)/bkd.length).toFixed(1):'-')+'</b><span>Touchpoints before a booking (calls + texts, on average)</span></div>'
  +'<div class="kpi"><b>'+avgT(FL)+'</b><span>Touchpoints per lead, all leads</span></div>'
  +'<div class="kpi '+(FL.filter(r=>r.never_called).length?'r':'')+'"><b>'+FL.filter(r=>r.never_called).length+'</b><span>Leads never called ('+pc(FL.filter(r=>r.never_called).length,FL.length)+')</span></div>'
  +'<div class="kpi"><b>'+pc(withT.filter(r=>(r.texts_in||0)>0).length,withT.length)+'</b><span>Texted leads who replied ('+withT.filter(r=>(r.texts_in||0)>0).length+' of '+withT.length+')</span></div>'
  +'<div class="kpi"><b>'+(FL.filter(r=>r.calls>0).length?(FL.reduce((a,r)=>a+(r.calls||0),0)/FL.filter(r=>r.calls>0).length).toFixed(1):'-')+'</b><span>Dialer calls per lead called</span></div>'
  +'<div class="kpi"><b>'+FL.reduce((a,r)=>a+(r.texts_out||0),0)+' / '+FL.reduce((a,r)=>a+(r.texts_in||0),0)+'</b><span>Texts sent / replies received</span></div>';
 const TB=[['0 (none)',0,0],['1',1,1],['2',2,2],['3-4',3,4],['5-7',5,7],['8 or more',8,Infinity]];
 tbl('tch',['Touchpoints so far','Leads','Booked','Booked rate'],FL.length?TB.map(b=>{const x=FL.filter(r=>T(r)>=b[1]&&T(r)<=b[2]),k=x.filter(r=>r.booked).length;return [b[0],x.length,k,pc(k,x.length)]}):[]);
}
function drawSpend(){const ms=[];let d=TODAY.slice(0,7);for(let i=0;i<6;i++){ms.push(d);const dd=dt(d+'-01');dd.setUTCMonth(dd.getUTCMonth()-1);d=ds(dd).slice(0,7)}
 for(const [id,ch] of [['sp','google'],['spm','meta']])document.getElementById(id).innerHTML=ms.map(m=>'<div><label>'+dt(m+'-01').toLocaleDateString('en-US',{timeZone:'UTC',month:'long',year:'numeric'})+'</label><input type="number" min="0" step="1" inputmode="numeric" data-m="'+m+'" data-ch="'+ch+'" value="'+((SP[ch]||{})[m]||'')+'" placeholder="$0"></div>').join('');
 const svc=[...new Set((D.services||[]).concat(R.map(r=>r.service).filter(x=>x&&x!=='Not set')))];
 document.getElementById('jc').innerHTML=svc.map(x=>'<div><label>'+$(x)+'</label><input type="number" min="0" step="1" inputmode="numeric" data-s="'+$(x)+'" value="'+(JC[x]||'')+'" placeholder="$0"></div>').join('')}
for(const id of ['sp','spm'])document.getElementById(id).addEventListener('change',async e=>{const i=e.target.closest('input[data-m]');if(!i)return;const v=Math.max(0,Number(i.value)||0),ch=i.dataset.ch;SP[ch]=SP[ch]||{};SP[ch][i.dataset.m]=v;try{await fetch('/admin/adspend',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({month:i.dataset.m,channel:ch,amount:v})})}catch(_){}draw()});
document.getElementById('jc').addEventListener('change',async e=>{const i=e.target.closest('input[data-s]');if(!i)return;const v=Math.max(0,Number(i.value)||0);JC[i.dataset.s]=v;try{await fetch('/admin/jobcost',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({service:i.dataset.s,cost:v})})}catch(_){}draw()});
drawSpend();draw();
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function todayPage(env, user = "") {
  await ensureTable(env.DB);
  const today = todayStr();
  const { results } = await env.DB.prepare("SELECT id,created_at,type,name,email,phone,service,make,year,model,message,utm_source,utm_campaign,gclid,gbraid,wbraid,utm_medium,stage,follow_up,follow_up_date,duration,recording,answered FROM leads WHERE type != 'newsletter' AND created_at >= datetime('now','-24 hours') ORDER BY created_at DESC, id DESC LIMIT 300").all();
  const ownT = user === OWNER;
  const items = results.map(l0 => { const l = ownT ? l0 : noAds(l0); return { ...l, ago: when(l.created_at).ago, src: ownT ? sourceOf(l).label : "", ad: ownT && sourceOf(l).ad, vm: /voicemail/i.test(l.message || "") }; });
  const payload = JSON.stringify({ today, cfg: cfgOf(env), items, stages: STAGES }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Today | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#07090c;color:#e8eaed}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}.navtabs a.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
.dt{color:#8a9099;font-size:14px}
main{max-width:880px;margin:0 auto;padding:8px 22px 40px;display:flex;flex-direction:column;gap:26px}
section h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;margin:18px 0 10px;display:flex;align-items:center;gap:8px;color:#c3c8cf}section h2 i{font-style:normal;background:#1c222a;border-radius:999px;padding:1px 9px;font-size:12px;color:#aab0b9}
section.miss h2{color:#ff9a9a}section.late h2{color:#ffb86b}section.new h2{color:#32cd32}
.rows{display:flex;flex-direction:column;gap:10px}
.row{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;cursor:pointer}.miss .row{border-color:#4a2424}.late .row{border-color:#4d3a1d}.new .row{border-color:#244d2a}.new .row.roth{border-color:#1d2229}.new .row.rmiss{border-color:#4a2424}.pill.st{background:#1c222a;color:#c3c8cf;font-weight:700}
.hd{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.hd b{font-size:17px;display:block}.hd small{color:#8a9099;font-size:13px}.hd a.op{color:#8ec0ff;font-size:13px;white-space:nowrap}
.why{font-size:13px;color:#c9a8ff}.msg{margin:0;color:#c9ced5;font-size:14px;white-space:pre-line}
.pill{font-size:11.5px;padding:2px 9px;border-radius:999px;background:#171c23;color:#aab0b9}.pill.ad{background:#14263f;color:#8ec0ff}.pill.miss{background:#3b1d1d;color:#ff9a9a;font-weight:700}
.acts{display:flex;gap:8px;flex-wrap:wrap}.btn{border:1px solid #2a313a;background:#151a21;color:#e8eaed;border-radius:10px;padding:11px 15px;font:inherit;font-weight:700;text-decoration:none;cursor:pointer;min-height:46px;display:inline-flex;align-items:center;justify-content:center}
.btn.call{background:#32cd32;border-color:#32cd32;color:#04120a}.btn.dn{background:#1d2630}
.demo{max-width:880px;margin:0 auto;padding:0 22px 40px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;color:#7c838d;font-size:13px}.demo .btn{min-height:40px;padding:8px 12px;font-weight:600}
.empty{color:#7c838d;padding:10px 0}.all{text-align:center;padding:50px 0;color:#8a9099}.all b{display:block;color:#32cd32;font-size:20px;margin-bottom:6px}
${BNAV_CSS}
${FOLLOW_CSS}
@media(max-width:700px){header{padding:12px 14px}h1{font-size:17px}main{padding:4px 14px 20px;gap:18px}.acts{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.acts .call{grid-column:1/-1;font-size:17px;padding:14px}}
</style></head><body>
<header><h1>Divine Detailers <b>today</b></h1>${nav("today", items.length, user === OWNER)}<span class="dt"><span id="dt"></span> &middot; <a href="/logout" style="color:#8a9099">Sign out</a></span></header>
${bnav("today", items.length, user === OWNER)}
${FOLLOW_HTML}
${OUTCOME_HTML}
${QUEUE_HTML}
<main id="m"></main>
${user === OWNER ? `<div class="demo"><span>Showing off the CRM?</span><button class="btn" id="dl">Load example leads</button><button class="btn" id="dc">Remove example leads</button><button class="btn" id="ta">Send test alert</button>${user === OWNER ? '<button class="btn" id="tc">Test CallRail</button><button class="btn" id="vs">Verify shop number</button><button class="btn" id="vo">Verify another number</button><a class="btn" href="/admin/leads.csv">Download all leads (CSV)</a><button class="btn" id="pg" style="border-color:#7a2b2b;color:#ff8a8a">Delete ALL leads</button>' : ""}<pre id="tr" style="flex:1 1 100%;white-space:pre-wrap;color:#c3c8cf;font-size:12.5px;margin:0"></pre></div>` : ""}
<script type="application/json" id="data">${payload}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent),CFG=D.cfg,TODAY=D.today;let items=D.items;
const $=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
${FOLLOW_JS}
${OUTCOME_JS}
${QUEUE_JS}
${TPL_JS}
const post=(u,b)=>fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
const fmtD=d=>{const p=d.split('-');return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+p[1]-1]+' '+(+p[2])};
document.getElementById('dt').textContent=new Date(TODAY+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
const NW=l=>l.stage==='new'||l.stage==='nocontact';const SNm=Object.fromEntries(D.stages||[]);
function group(){return {miss:items.filter(l=>l.type==='call'&&l.answered===0&&NW(l)),late:items.filter(l=>!NW(l)&&l.follow_up_date&&l.follow_up_date<TODAY),due:items.filter(l=>!NW(l)&&l.follow_up_date===TODAY),nw:items.filter(l=>NW(l)&&!(l.type==='call'&&l.answered===0))}}
function row(l,kind){const veh=[l.year,l.make,l.model].filter(Boolean).join(' '),tel=(l.phone||'').replace(/[^\\d+]/g,''),t=tplFor(l)[0],msg=tplFill(t,l).body;
  const st='<span class="pill st">'+$(SNm[l.stage]||l.stage)+'</span> ';
  const why=st+(kind==='miss'?(l.vm?'Left a voicemail':'Missed call')+(l.src?' &middot; '+$(l.src):''):(l.type==='call'?'Called in':$(l.service||'Quote request'))+(veh?' &middot; '+$(veh):''));
  return '<div class="row'+(kind==='miss'?' rmiss':NW(l)?'':' roth')+'" data-id="'+l.id+'"><div class="hd"><div><b>'+$(l.name||l.phone||l.email||'Unknown caller')+'</b><small>'+$(l.ago)+(l.ad?' &middot; <span class="pill ad">Ads</span>':'')+'</small></div><a class="op" href="/admin/pipeline#id='+l.id+'">Details</a></div><div class="why">'+why+'</div>'+(l.message&&kind!=='miss'?'<p class="msg">&ldquo;'+$(l.message.slice(0,400))+'&rdquo;</p>':'')+
  '<div class="acts">'+(tel?'<a class="btn call" href="tel:'+$(tel)+'" data-act="call">Call '+$(l.phone)+'</a><a class="btn" href="'+$(smsHref(l.phone,msg))+'" data-act="text">Text</a>':'')+(NW(l)?'<button class="btn dn" data-act="done">Contacted</button>':'')+'</div></div>'}
function draw(){const open=items.filter(NW).length;
  const h=items.length?'<section class="new"><h2>Last 24 hours <i>'+items.length+'</i></h2><div class="rows">'+items.map(l=>row(l,l.type==='call'&&l.answered===0&&NW(l)?'miss':'nw')).join('')+'</div></section>':'';
  document.getElementById('m').innerHTML=h||'<div class="all"><b>Nothing new</b>No leads in the last 24 hours.</div>';
  document.title=(open?'('+open+') ':'')+'Today | Divine Detailers'}
document.getElementById('m').addEventListener('click',async e=>{const b=e.target.closest('[data-act]');if(!b){const rw=e.target.closest('.row');if(rw&&!e.target.closest('a,button'))location.href='/admin/pipeline#id='+rw.dataset.id;return}const r=b.closest('.row'),l=items.find(x=>x.id===+r.dataset.id);if(!l)return;const a=b.dataset.act;
  const lab=l.name||l.phone||'this lead';
  if(a==='call'){markCall(l.id,l.name||l.phone);post('/admin/touch',{id:l.id,label:'Called'});return}
  if(a==='text'){post('/admin/touch',{id:l.id,label:'Texted: '+tplFor(l)[0].label});return}
  if(a==='snooze'){const d=new Date(TODAY+'T12:00:00');d.setDate(d.getDate()+1);const v=d.toISOString().slice(0,10);b.disabled=true;const o=await post('/admin/stage',{id:l.id,follow_date:v});if(o.ok){l.follow_up_date=v;items=items.filter(x=>x.id!==l.id);draw()}else b.disabled=false;return}
  if(a==='done'){b.disabled=true;let st=l.stage;if(st==='new'||st==='nocontact'){const o=await post('/admin/stage',{id:l.id,stage:'contacted'});if(!o.ok){b.disabled=false;return}st='contacted'}
    const nx=await askNext(lab,st,l.id);const o2=await post('/admin/stage',{id:l.id,followup:nx?nx.followup:undefined,follow_date:nx?nx.follow_date:''});
    if(o2.ok){const j=await o2.json();l.stage=j.stage;l.follow_up_date=j.follow_up_date;l.follow_up=j.followup;if(!(j.follow_up_date&&j.follow_up_date<=TODAY&&!['done','lost'].includes(j.stage)))items=items.filter(x=>x.id!==l.id);draw()}else b.disabled=false}})
draw();
async function vfy(btn,phone){btn.disabled=true;const tr=document.getElementById('tr');tr.textContent='Asking CallRail to verify '+(phone||'the shop number')+'...';try{const r=await post('/admin/verifyshop',phone?{phone:phone,name:'Divine Detailers test line'}:{});const j=await r.json();tr.textContent=j.success&&j.already?('The number '+j.number+' is already verified. Set CALLRAIL_CALLER_ID to it in Cloudflare.'):j.success?('CallRail is calling '+j.number+' now.\\nAnswer that phone and key in this code on the keypad: '+(j.code||'(no code returned: '+j.raw+')')+'\\nIf you miss the call, tap this button again.'):('Could not start the verification: '+(j.message||'unknown error'))}catch(_){tr.textContent='Could not reach the server.'}btn.disabled=false}
const vsb=document.getElementById('vs');if(vsb)vsb.onclick=e=>vfy(e.target,'');
const pgb=document.getElementById('pg');if(pgb)pgb.onclick=async e=>{const w=prompt('This permanently deletes EVERY lead and its history. Download the CSV first if you want a copy.\\n\\nType DELETE to confirm.');if(w!=='DELETE')return;e.target.disabled=true;const tr=document.getElementById('tr');try{const r=await post('/admin/purge',{confirm:'DELETE'});const j=await r.json();tr.textContent=j.success?('Deleted '+j.deleted+' leads. Reloading...'):('Could not delete: '+(j.message||'error'));if(j.success)setTimeout(()=>location.reload(),900)}catch(_){tr.textContent='Could not reach the server.'}e.target.disabled=false};
const vob=document.getElementById('vo');if(vob)vob.onclick=e=>{const n=(prompt('Phone number to verify as a caller ID (10 digits)')||'').replace(/[^\\d]/g,'');if(n.length>=10)vfy(e.target,'+1'+n.slice(-10))};
const tcb=document.getElementById('tc');if(tcb)tcb.onclick=async e=>{e.target.disabled=true;const tr=document.getElementById('tr');tr.textContent='Checking CallRail...';try{const r=await post('/admin/callrailtest',{});const j=await r.json();const yn=v=>v?'yes':'NO';const L=['Token set: '+yn(j.token_set)+' | Account ID set: '+yn(j.account_id_set)+' | Caller ID set: '+yn(j.caller_id_set),'Giordani phone set: '+yn(j.agent_giordani)+' | Bronson phone set: '+yn(j.agent_bronson)+' | Recording: '+(j.recording?'on':'off')+' | Auto-dial: '+(j.auto_dial?'on':'off')];
 if(j.accounts_status!==undefined){L.push('CallRail accounts (status '+j.accounts_status+'):');(j.accounts||[]).forEach(a=>L.push('  '+a.id+'  '+a.name));if(j.accounts_error)L.push('  '+j.accounts_error)}
 if(j.trackers_status!==undefined){L.push('Tracking numbers (status '+j.trackers_status+'):');(j.trackers||[]).forEach(t=>L.push('  '+t.name+': '+t.numbers));L.push(j.caller_id_match?'Caller ID matches tracking number: '+j.caller_id_match:(j.caller_id_verified?'Caller ID matches a verified outbound caller ID':'Caller ID is not a tracking number. That is fine only if it is a verified Outbound Caller ID in CallRail.'));if(j.callerids_status!==undefined){L.push('Outbound caller IDs (status '+j.callerids_status+'):');(j.caller_ids||[]).forEach(c=>L.push('  '+(c.name||'')+' '+c.number+(c.verified===false?' (not verified)':'')))}}
 const tx=j.transcripts||{};L.push('Call transcripts: '+(tx.ready||0)+' ready, '+(tx.pending||0)+' waiting, '+(tx.none||0)+' with none from CallRail'+(tx.keys?'\\nFields CallRail returned on the last call: '+tx.keys:''));L.push('Last webhooks received from CallRail (newest first):');(j.hooks||[]).forEach(h=>L.push('  '+h.at+'  '+h.summary));if(!(j.hooks||[]).length)L.push('  none yet');
 tr.textContent=L.join('\\n')}catch(_){tr.textContent='Could not reach the server.'}e.target.disabled=false};
const tab=document.getElementById('ta');if(tab)tab.onclick=async e=>{e.target.disabled=true;const tr=document.getElementById('tr');tr.textContent='Sending...';try{const r=await post('/admin/testalert',{});if(r.status===404){tr.textContent='This version of the site does not have alerts yet. Re-run the latest build in Cloudflare.'}else{const j=await r.json();tr.textContent=(j.push_topic_set?'Push topic is set: '+j.topic_hint+(j.has_slash_or_space?'\\nWARNING: the topic contains a space, a slash or a colon. It must be the name only.':'')+'\\nntfy answered: '+j.push_status+' '+j.push_response+(j.push_status===200?'\\nSent. Check the phone now.':'')+(j.push_status===429?'\\nThe free shared quota is used up. Add an ntfy account token as NTFY_TOKEN.':'')+(j.push_token_set?'\\nAccount token: set':'\\nAccount token: not set')+(j.topic_too_short?'\\nWARNING: the topic is short and easy to guess. Use 20+ random characters.':''):'NTFY_TOPIC is NOT set on the live site. Add it as a variable or secret and deploy.')+'\\nEmail alerts: '+(j.email?'on':'off')+' | Text alerts: '+(j.sms?'on':'off')+' | Zapier: '+(j.zapier_webhook?'on':'off')}}catch(_){tr.textContent='Could not reach the server.'}e.target.disabled=false};
for(const [id,act] of [['dl','load'],['dc','clear']]){const el=document.getElementById(id);if(el)el.onclick=async e=>{e.target.disabled=true;await post('/admin/demo',{action:act});location.reload()}}
</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// What each non-owner login may open. The owner sets it on the Logins page. The dialer, scripts, recordings, number health and logins are never available to these logins.
const PERM_PATHS = { today: ["/admin/today"], leads: ["/admin"], pipeline: ["/admin/pipeline"], messages: ["/admin/messages"], calendar: ["/admin/calendar"], dashboard: ["/admin/dashboard"], reports: ["/admin/insights", "/admin/meta", "/admin/dials", "/admin/speed", "/admin/rate", "/admin/msgstats", "/admin/reports", "/admin/playbook", "/admin/scorecard"] };
const PERM_LABELS = { today: "Today", leads: "Leads", pipeline: "Pipeline", messages: "Messages", calendar: "Calendar", dashboard: "Dashboard", reports: "Reports (money and ad numbers)" };
const PERM_DEFAULT = ["today", "leads", "pipeline", "messages"];
async function userPerms(env, user) {
  await ensureTable(env.DB);
  const r = await env.DB.prepare("SELECT perms FROM user_perms WHERE username = ?").bind(user).first().catch(() => null);
  let list = PERM_DEFAULT; try { if (r) list = JSON.parse(r.perms); } catch (_) {}
  return new Set(list.filter(k => Object.hasOwn(PERM_PATHS, k)));
}
function permKeyFor(p) {
  if (p === "/admin" || p === "/admin/leads.csv") return "leads";
  if (p === "/admin/pipeline") return "pipeline";
  if (p === "/admin/today") return "today";
  if (p === "/admin/messages" || p === "/admin/threads" || p === "/admin/thread") return "messages";
  if (p === "/admin/calendar" || p === "/admin/calendar/urable" || p === "/admin/calendar/find") return "calendar";
  if (p === "/admin/dashboard" || p === "/admin/dashboard/data") return "dashboard";
  if (["/admin/insights", "/admin/speed", "/admin/rate", "/admin/meta", "/admin/msgstats", "/admin/msgstats/data", "/admin/dials", "/admin/dials/data"].includes(p)) return "reports";
  return null;
}
const permAllows = (perms, href) => { const path = String(href || "").split(/[?#]/)[0].replace(/\/+$/, "") || "/"; if (path === "/logout") return true; return [...perms].some(k => PERM_PATHS[k].includes(path)); };
function filterNav(res, perms) {
  if (!/text\/html/.test(res.headers.get("content-type") || "")) return res;
  const rm = { element(e) { const h = e.getAttribute("href"); if (h && !permAllows(perms, h)) e.remove(); } };
  return new HTMLRewriter().on("nav.navtabs a", rm).on(".bnav a", rm).on(".msheet a", rm).on(".itabs a", rm).transform(res);
}
// the pages that were owner-only but can be switched on for a login (Calendar, Dashboard, Reports)
async function ownerViews(p, request, env) {
  const u = new URL(request.url), days = Number(u.searchParams.get("days"));
  if (p === "/admin/dashboard") return dashboardPage(env, OWNER);
  if (p === "/admin/dashboard/data") return json(await dashData(env, days));
  if (p === "/admin/calendar") return calendarPage(env, OWNER);
  if (p === "/admin/calendar/urable") return json({ success: true, ...(await urableCalendar(env)) });
  if (p === "/admin/insights") return insightsPage(env, OWNER);
  if (p === "/admin/speed") return speedPage(env, OWNER);
  if (p === "/admin/rate") return ratePage(env, OWNER);
  if (p === "/admin/playbook") return playbookPage(env, OWNER);
  if (p === "/admin/scorecard") return json(await scorecard(env, days));
  if (p === "/admin/meta") return metaPage(env, OWNER);
  if (p === "/admin/msgstats") return msgStatsPage(env, OWNER);
  if (p === "/admin/msgstats/data") return json({ success: true, ...(await msgStatsData(env, u.searchParams.get("from"), u.searchParams.get("to"))) });
  if (p === "/admin/dials") return dialsPage(env, OWNER);
  if (p === "/admin/dials/data") return json(await dialsData(env, u.searchParams.get("from"), u.searchParams.get("to")));
  return null;
}
async function adminRoute(p, request, env) {
  const a = await authed(request, env);
  if (!a || a === "unconfigured" || a === OWNER || !env.DB) return adminRouteCore(p, request, env, a);
  const perms = await userPerms(env, a), need = permKeyFor(p);
  if (need && !perms.has(need)) {
    if (request.method !== "GET") return json({ success: false, message: "Not allowed" }, 403);
    const first = ["today", "leads", "pipeline", "messages", "calendar", "dashboard", "reports"].find(k => perms.has(k));
    return first ? new Response(null, { status: 302, headers: { location: PERM_PATHS[first][0], "cache-control": "no-store" } }) : new Response("Nothing has been turned on for your login yet. Ask Bronson.", { status: 403 });
  }
  const view = need && ["calendar", "dashboard", "reports"].includes(need) ? await ownerViews(p, request, env) : null;
  return filterNav(view || await adminRouteCore(p, request, env, a), perms);
}
async function adminRouteCore(p, request, env, a0) {
  const a = a0 !== undefined ? a0 : await authed(request, env);
  if (a === "unconfigured") return new Response("Sign in is not set up yet. Add the PASSWORD_GIORDANI and PASSWORD_BRONSON secrets.", { status: 503 });
  if (!a) {
    if (request.method === "GET") { const u = new URL(request.url); return new Response(null, { status: 302, headers: { location: "/login?next=" + encodeURIComponent(u.pathname + u.search), "cache-control": "no-store" } }); }
    return json({ success: false, message: "Signed out" }, 401);
  }
  if (!env.DB) return new Response("Lead database is not configured.", { status: 503 });
  if (p === "/admin") return adminPage(env, a);
  if (p === "/admin/leads.csv") return csv(env, a);
  if (p === "/admin/pipeline") return pipelinePage(env, a);
  if (p === "/admin/add" && request.method === "POST") return addLead(request, env);
  if (p === "/admin/today") return todayPage(env, a);
  if (p === "/admin/messages") return messagesPage(env, a);
  if (p === "/admin/calendar") return a === OWNER ? calendarPage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/automations") return a === OWNER ? automationsPage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/automations/data" && request.method === "GET") return a === OWNER ? automationsData(env) : json({ success: false }, 403);
  if (p === "/admin/calendar/find" && request.method === "GET") {
    const q = String(new URL(request.url).searchParams.get("q") || "").trim().slice(0, 40), dg = q.replace(/\D/g, "");
    if (q.length < 2) return json({ success: true, leads: [] });
    const { results } = await env.DB.prepare("SELECT id, name, phone, service, stage FROM leads WHERE type != 'newsletter' AND COALESCE(ip,'') != 'demo' AND (name LIKE ? OR (? != '' AND phone LIKE ?)) ORDER BY id DESC LIMIT 8").bind("%" + q + "%", dg.length >= 3 ? dg : "", "%" + dg + "%").all();
    return json({ success: true, leads: results || [] });
  }
  if (p === "/admin/calendar/urable" && request.method === "GET") return a === OWNER ? json({ success: true, ...(await urableCalendar(env)) }) : json({ success: false }, 403);
  if (p === "/admin/automation" && request.method === "POST") { if (a !== OWNER) return json({ success: false }, 403); return saveAutomation(env, await request.json().catch(() => ({}))); }
  if (p === "/admin/coach/aitest") return a === OWNER ? coachAiTest(env) : json({ success: false }, 403);
  if (p === "/admin/coach/turns") return a === OWNER ? coachTurnsLog(env, new URL(request.url)) : json({ success: false }, 403);
  if (p === "/admin/coach/status") return a === OWNER ? json({ enabled: coachEnabled(env), ai: coachAi(env), practice: !!(env.COACH && coachAi(env)) }) : json({ success: false }, 403);
  if (p === "/admin/coach/ws") {
    const sid = new URL(request.url).searchParams.get("sid") || "";
    if (a !== OWNER) return new Response("Forbidden", { status: 403 });
    const practice = /^PR[0-9a-f]{24}$/.test(sid);
    if (request.headers.get("upgrade") !== "websocket" || !env.COACH || (practice ? !coachAi(env) : (!coachEnabled(env) || !/^CA[0-9a-f]{32}$/.test(sid)))) return new Response("Not available", { status: 404 });
    return env.COACH.get(env.COACH.idFromName(sid)).fetch(request);
  }
  if (p === "/admin/dialer") return a === OWNER ? dialerPage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p.startsWith("/admin/rec/")) return a === OWNER ? recordingProxy(env, p.slice(11), request) : new Response("Not found", { status: 404 });
  if (p.startsWith("/admin/dialer/")) {
    if (a !== OWNER) return json({ success: false }, 403);
    if (p === "/admin/dialer/token" && request.method === "GET") {
      const cfg = dialConfigured(env);
      if (!cfg.ok) return json({ success: false, message: "Finish the Twilio voice setup.", missing: cfg.missing }, 200);
      return json({ success: true, token: await voiceToken(env, a) });
    }
    if (p === "/admin/dialer/queue" && request.method === "GET") return dialerQueue(env, new URL(request.url));
    if (p === "/admin/dialer/lead" && request.method === "GET") return dialerLead(env, Number(new URL(request.url).searchParams.get("id")));
    if (p === "/admin/dialer/script" && request.method === "GET") return dialerScriptGet(env, new URL(request.url).searchParams.get("svc") || "");
    if (p === "/admin/dialer/script" && request.method === "POST") return dialerScriptSave(env, await request.json().catch(() => ({})));
    if (p === "/admin/dialer/practice" && request.method === "GET") { await ensureTable(env.DB); const r = await env.DB.prepare("SELECT id, at, svc, level, kind, overall, outcome FROM practice_runs ORDER BY id DESC LIMIT 12").all().then(x => x.results || []).catch(() => []); return json({ success: true, runs: r.map(x => ({ ...x, at: isoUtc(x.at) })) }); }
    if (p === "/admin/dialer/library" && request.method === "GET") return dialerLibrary(env, null);
    if (p === "/admin/dialer/library" && request.method === "POST") return dialerLibrary(env, await request.json().catch(() => ({})));
    if (p === "/admin/dialer/offer" && request.method === "GET") return dialerOfferGet(env);
    if (p === "/admin/dialer/offer" && request.method === "POST") return dialerOfferSave(env, await request.json().catch(() => ({})));
    if (p === "/admin/dialer/note" && request.method === "POST") return dialerNote(env, await request.json().catch(() => ({})), a);
    if (p === "/admin/dialer/log" && request.method === "POST") return dialerLog(env, await request.json().catch(() => ({})), a);
    if (p === "/admin/dialer/vmdrop" && request.method === "POST") return dialerVoicemailDrop(env, await request.json().catch(() => ({})), a);
    if (p === "/admin/dialer/audio" && request.method === "POST") return dialerAudioSave(env, await request.json().catch(() => ({})));
    if (p === "/admin/dialer/audio/play" && request.method === "GET") return dialerAudioPlay(env, new URL(request.url).searchParams.get("kind"));
    if (p === "/admin/dialer/audio" && request.method === "GET") {
      await ensureTable(env.DB);
      const rows = (await env.DB.prepare("SELECT kind, updated_at FROM dial_audio").all()).results || [];
      return json(Object.fromEntries(VM_KINDS.map(k => { const r = rows.find(x => x.kind === k); return [k, { has: !!r, updated_at: r ? r.updated_at : "" }]; })));
    }
    if (p === "/admin/dialer/settings" && request.method === "GET") { await ensureTable(env.DB); return json({ success: true, tint: await dialSetting(env, "tint"), coating: await dialSetting(env, "coating"), missed: await dialSetting(env, "missed") }); }
    if (p === "/admin/dialer/settings" && request.method === "POST") {
      await ensureTable(env.DB);
      const b = await request.json().catch(() => ({}));
      for (const k of ["tint", "coating", "missed"]) if (typeof b[k] !== "string" || b[k].length > 6000) return json({ success: false, message: "Each script has to be under 6,000 characters." }, 400);
      await env.DB.batch(["tint", "coating", "missed"].map(k => env.DB.prepare("INSERT INTO dial_settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, b[k])));
      return json({ success: true });
    }
    return json({ success: false }, 404);
  }
  if (p === "/admin/campaigns/data" && request.method === "GET") return a === OWNER ? campaignsData(env) : json({ success: false }, 403);
  if (p === "/admin/campaigns/mark-meta" && request.method === "POST") return a === OWNER ? markMetaPromo(env, await request.json().catch(() => ({})), a) : json({ success: false }, 403);
  if (p === "/admin/campaigns/preview" && request.method === "POST") return a === OWNER ? campaignPreview(env, await request.json().catch(() => ({}))) : json({ success: false }, 403);
  if (p === "/admin/campaign" && request.method === "POST") return a === OWNER ? saveCampaign(env, await request.json().catch(() => ({}))) : json({ success: false }, 403);
  if (p === "/admin/campaign/test" && request.method === "POST") return a === OWNER ? campaignTest(env, await request.json().catch(() => ({}))) : json({ success: false }, 403);
  if (p === "/admin/campaign/cancel" && request.method === "POST") {
    if (a !== OWNER) return json({ success: false }, 403);
    const b = await request.json().catch(() => ({}));
    if (!Number.isInteger(b.id)) return json({ success: false }, 400);
    await env.DB.prepare("UPDATE campaigns SET status = 'canceled' WHERE id = ? AND status IN ('scheduled','sending','draft')").bind(b.id).run();
    return json({ success: true });
  }
  if (p === "/admin/automation/delete" && request.method === "POST") {
    if (a !== OWNER) return json({ success: false }, 403);
    const b = await request.json().catch(() => ({}));
    if (!Number.isInteger(b.id)) return json({ success: false }, 400);
    await env.DB.batch([env.DB.prepare("DELETE FROM automation_steps WHERE automation_id = ?").bind(b.id), env.DB.prepare("DELETE FROM automation_runs WHERE automation_id = ?").bind(b.id), env.DB.prepare("DELETE FROM automations WHERE id = ?").bind(b.id)]);
    return json({ success: true });
  }
  if (p === "/admin/unread" && request.method === "GET") { await ensureTable(env.DB); return json({ n: ((await env.DB.prepare("SELECT (SELECT COUNT(*) FROM messages WHERE direction = 'in' AND is_read = 0) + (SELECT COUNT(*) FROM leads WHERE unread_flag = 1) n").first()) || {}).n || 0 }); }
  if (p === "/admin/threads" && request.method === "GET") return messageThreads(env, new URL(request.url));
  if (p === "/admin/thread" && request.method === "GET") return messageThread(env, new URL(request.url), a === OWNER);
  if (p === "/admin/markunread" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!Number.isInteger(b.id)) return json({ success: false }, 400);
    await ensureTable(env.DB);
    await env.DB.prepare("UPDATE leads SET unread_flag = 1 WHERE id = ?").bind(b.id).run();
    return json({ success: true });
  }
  if (p === "/admin/snippets" && request.method === "GET") { await ensureTable(env.DB); return json({ success: true, snippets: await snippetList(env), fields: AUTO_FIELDS }); }
  if (p === "/admin/snippets" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    await ensureTable(env.DB);
    if (b.delete && Number.isInteger(b.id)) { await env.DB.prepare("DELETE FROM snippets WHERE id = ?").bind(b.id).run(); return json({ success: true }); }
    const name = clean(b.name, 60), body = String(b.body || "").trim().slice(0, 1000);
    if (!name || !body) return json({ success: false, message: "Give the snippet a name and some text." }, 400);
    if (Number.isInteger(b.id)) await env.DB.prepare("UPDATE snippets SET name = ?, body = ? WHERE id = ?").bind(name, body, b.id).run();
    else await env.DB.prepare("INSERT INTO snippets (name, body) VALUES (?, ?)").bind(name, body).run();
    return json({ success: true, snippets: await snippetList(env) });
  }
  if (p === "/admin/snippets/render" && request.method === "GET") {
    const u = new URL(request.url), sid = Number(u.searchParams.get("id")), lid = Number(u.searchParams.get("lead"));
    await ensureTable(env.DB);
    const sn = await env.DB.prepare("SELECT body FROM snippets WHERE id = ?").bind(sid).first();
    if (!sn) return json({ success: false }, 404);
    const lead = Number.isInteger(lid) ? await env.DB.prepare("SELECT name, service, year, make, model, appt_at FROM leads WHERE id = ?").bind(lid).first() : null;
    return json({ success: true, text: renderAuto(sn.body, lead || {}, env) });
  }
  if (p === "/admin/note" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const r = await addLeadNote(env, b.id, b.text, a);
    return r.ok ? json({ success: true, notes: r.notes }) : json({ success: false, message: r.message || "Could not save the note." }, r.status || 400);
  }
  if (p === "/admin/note" && request.method === "GET") {
    const id = Number(new URL(request.url).searchParams.get("id"));
    if (!Number.isInteger(id)) return json({ success: false }, 400);
    const l = await env.DB.prepare("SELECT notes FROM leads WHERE id = ?").bind(id).first();
    return l ? json({ success: true, notes: l.notes || "" }) : json({ success: false }, 404);
  }
  if (p === "/admin/star" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!Number.isInteger(b.id)) return json({ success: false }, 400);
    await ensureTable(env.DB);
    await env.DB.prepare("UPDATE leads SET starred = ? WHERE id = ?").bind(b.on ? 1 : 0, b.id).run();
    return json({ success: true });
  }
  if (p === "/admin/tags" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!Number.isInteger(b.id) || !Array.isArray(b.tags)) return json({ success: false }, 400);
    await ensureTable(env.DB);
    const tags = [...new Set(b.tags.map(t => String(t || "").replace(/[,<>]/g, " ").trim().slice(0, 24)).filter(Boolean))].slice(0, 12);
    await env.DB.prepare("UPDATE leads SET tags = ? WHERE id = ?").bind(tags.join(","), b.id).run();
    return json({ success: true, tags });
  }

  if (p.startsWith("/admin/send/")) { const sid = Number(p.slice(12)); return Number.isInteger(sid) && sid > 0 ? sendPage(env, sid, new URL(request.url).searchParams.get("n"), a) : new Response("Not found", { status: 404 }); }
  if (p.startsWith("/admin/go/")) { const gid = Number(p.slice(10)); return Number.isInteger(gid) && gid > 0 ? goPage(env, gid, a) : new Response("Not found", { status: 404 }); }
  if (p === "/admin/dashboard") return a === OWNER ? dashboardPage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/dashboard/data" && request.method === "GET") return a === OWNER ? json(await dashData(env, Number(new URL(request.url).searchParams.get("days")))) : json({ success: false }, 403);
  if (p === "/admin/users" && request.method === "GET") return a === OWNER ? usersPage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/users" && request.method === "POST") return a === OWNER ? usersApi(env, request) : json({ success: false }, 403);
  if (p === "/admin/numbers") return a === OWNER ? numbersPage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/numbers/check" && request.method === "POST") return a === OWNER ? json({ success: true, results: await twilioNumberCheck(env) }) : json({ success: false }, 403);
  if (p === "/admin/dials") return a === OWNER ? dialsPage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/meta") return a === OWNER ? metaPage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/dials/data" && request.method === "GET") { if (a !== OWNER) return json({ success: false }, 403); const u = new URL(request.url); return json(await dialsData(env, u.searchParams.get("from"), u.searchParams.get("to"))); }
  if (p === "/admin/msgstats") return a === OWNER ? msgStatsPage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/msgstats/data" && request.method === "GET") { if (a !== OWNER) return json({ success: false }, 403); const u = new URL(request.url); return json({ success: true, ...(await msgStatsData(env, u.searchParams.get("from"), u.searchParams.get("to"))) }); }
  if (p === "/admin/speed") return a === OWNER ? speedPage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/insights") return a === OWNER ? insightsPage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/adspend" && request.method === "POST") {
    if (a !== OWNER) return json({ success: false }, 403);
    const b = await request.json().catch(() => ({}));
    const channel = b.channel === "meta" ? "meta" : "google";
    if (typeof b.month !== "string" || !/^\d{4}-\d{2}$/.test(b.month) || !Number.isFinite(b.amount) || b.amount < 0 || b.amount > 10000000) return json({ success: false }, 400);
    await env.DB.prepare("INSERT INTO ad_spend2 (month, channel, amount) VALUES (?, ?, ?) ON CONFLICT(month, channel) DO UPDATE SET amount = excluded.amount").bind(b.month, channel, b.amount).run();
    return json({ success: true });
  }
  if (p === "/admin/jobcost" && request.method === "POST") {
    if (a !== OWNER) return json({ success: false }, 403);
    const b = await request.json().catch(() => ({}));
    if (typeof b.service !== "string" || !b.service.trim() || b.service.length > 100 || !Number.isFinite(b.cost) || b.cost < 0 || b.cost > 10000000) return json({ success: false }, 400);
    await env.DB.prepare("INSERT INTO job_costs (service, cost) VALUES (?, ?) ON CONFLICT(service) DO UPDATE SET cost = excluded.cost").bind(b.service.trim(), b.cost).run();
    return json({ success: true });
  }
  if (p === "/admin/ads") return a === OWNER ? adsPage(env, a, new URL(request.url)) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/ads.csv") return a === OWNER ? adsCsv(env, new URL(request.url)) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/missed") return new Response(null, { status: 302, headers: { location: "/admin/speed" } });
  if (p === "/admin/playbook") return a === OWNER ? playbookPage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/scorecard") return a === OWNER ? json(await scorecard(env, Number(new URL(request.url).searchParams.get("days")))) : json({ success: false }, 403);
  if (p === "/admin/rate") return a === OWNER ? ratePage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/demo" && request.method === "POST") return demoRoute(request, env);
  if (p === "/admin/testalert" && request.method === "POST") return testAlert(request, env);
  const user = typeof a === "string" ? a : "";
  if (p === "/admin/calls") { const id = Number(new URL(request.url).searchParams.get("id")); if (a !== OWNER && Number.isInteger(id)) return json({ success: true, notes: [], recordings: [], attempts: await leadAttempts(env, id), history: await leadHistory(env, id) }); return Number.isInteger(id) ? json({ success: true, notes: await callNotes(env, id), recordings: await callRecordings(env, id), attempts: await leadAttempts(env, id), history: await leadHistory(env, id) }) : json({ success: false }, 400); }
  if (p === "/admin/delete" && request.method === "POST") {
    if (a !== OWNER) return json({ success: false, message: "Only the owner login can delete leads." }, 403);
    const b = await request.json().catch(() => ({}));
    if (!Number.isInteger(b.id)) return json({ success: false }, 400);
    await env.DB.batch([env.DB.prepare("DELETE FROM stage_log WHERE lead_id = ?").bind(b.id), env.DB.prepare("DELETE FROM dial_log WHERE lead_id = ?").bind(b.id), env.DB.prepare("DELETE FROM call_notes WHERE lead_id = ?").bind(b.id), env.DB.prepare("DELETE FROM queue_items WHERE lead_id = ?").bind(b.id), env.DB.prepare("DELETE FROM call_recordings WHERE lead_id = ?").bind(b.id), env.DB.prepare("DELETE FROM leads WHERE id = ?").bind(b.id)]);
    return json({ success: true });
  }
  if (p === "/admin/purge" && request.method === "POST") {
    // owner only, and only with the word DELETE typed in: removes every lead and its history, call log and webhook log (ad spend and logins are kept)
    if (a !== OWNER) return json({ success: false }, 403);
    const b = await request.json().catch(() => ({}));
    if (b.confirm !== "DELETE") return json({ success: false, message: "Confirmation word missing." }, 400);
    const n = (await env.DB.prepare("SELECT COUNT(*) n FROM leads").first() || {}).n || 0;
    await env.DB.batch([env.DB.prepare("DELETE FROM stage_log"), env.DB.prepare("DELETE FROM dial_log"), env.DB.prepare("DELETE FROM hook_log"), env.DB.prepare("DELETE FROM call_notes"), env.DB.prepare("DELETE FROM queue_items"), env.DB.prepare("DELETE FROM queue_run"), env.DB.prepare("DELETE FROM call_recordings"), env.DB.prepare("DELETE FROM leads")]);
    return json({ success: true, deleted: n });
  }
  if (p === "/admin/verifyshop" && request.method === "POST") { if (a !== OWNER) return json({ success: false }, 403); const res = await verifyShopNumber(env, await request.json().catch(() => ({}))); return json({ success: res.ok, ...res }); }
  if (p === "/admin/callrailtest" && request.method === "POST") return a === OWNER ? json({ success: true, ...(await callrailTest(env)) }) : json({ success: false }, 403);
  if (p === "/admin/outcome" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const rule = OUTCOME_RULES[b.outcome];
    if (!Number.isInteger(b.id) || !rule) return json({ success: false }, 400);
    const cur = await env.DB.prepare("SELECT stage, appt_at, value, follow_up_date FROM leads WHERE id = ?").bind(b.id).first();
    if (!cur) return json({ success: false }, 404);
    // required details, so reports never rest on a guess
    if (rule.needs === "booking" && !(cur.appt_at && cur.value > 0)) return json({ success: false, need: "booking", message: "Set the appointment and price first." }, 422);
    const reason = rule.reason || (LOST_REASONS.includes(b.reason) ? b.reason : "");
    if (rule.needs === "reason" && !reason) return json({ success: false, need: "reason", message: "Pick why they said no." }, 422);
    let tgt = cur.stage;
    if (rule.stage && (rule.stage === "booked" || rule.stage === "lost" || !KEEP_STAGES.includes(cur.stage))) tgt = rule.stage;
    else if (!rule.stage && isNewish(cur.stage) && rule.talked) tgt = "contacted";
    if (rule.stage === "quoted" && cur.stage === "deposit") tgt = cur.stage;
    const st2 = [env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?,?,?,?,?)").bind(b.id, cur.stage, tgt, "Call result: " + b.outcome, user)];
    if (tgt !== cur.stage) st2.push(env.DB.prepare("UPDATE leads SET stage = ?, stage_changed_at = datetime('now') WHERE id = ?").bind(tgt, b.id));
    if (rule.talked) st2.push(env.DB.prepare("UPDATE leads SET contacted = 1 WHERE id = ?").bind(b.id));
    if (tgt === "lost" && reason) st2.push(env.DB.prepare("UPDATE leads SET lost_reason = ? WHERE id = ?").bind(reason, b.id));
    const dayStr = n => addDays(todayStr(), n);
    if (rule.follow) {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(String(b.follow_date || "")) ? b.follow_date : dayStr(1);
      st2.push(env.DB.prepare("UPDATE leads SET follow_up = 'Call back', follow_up_date = ? WHERE id = ?").bind(d, b.id));
    } else if (rule.clear || tgt === "lost") {
      st2.push(env.DB.prepare("UPDATE leads SET follow_up = '', follow_up_date = '' WHERE id = ?").bind(b.id));
    } else if (rule.retry && !KEEP_STAGES.includes(cur.stage) && tgt !== "lost") {
      // not reached: count the tries that failed and schedule the next one by the cadence, unless a callback they asked for is already coming up
      const n = ((await env.DB.prepare("SELECT COUNT(*) n FROM stage_log WHERE lead_id = ? AND reason IN ('Call result: No answer','Call result: Left a voicemail','Call result: Lead hung up')").bind(b.id).first()) || {}).n + 1;
      const gap = CALL_RULES.retryDays[Math.min(n - 1, CALL_RULES.retryDays.length - 1)];
      if (!(cur.follow_up_date && cur.follow_up_date > todayStr())) st2.push(env.DB.prepare("UPDATE leads SET follow_up = 'Call again', follow_up_date = ? WHERE id = ?").bind(dayStr(gap), b.id));
    } else if (rule.next && !KEEP_STAGES.includes(cur.stage)) {
      const keep = cur.follow_up_date && cur.follow_up_date > todayStr();
      if (!keep) st2.push(env.DB.prepare("UPDATE leads SET follow_up = ?, follow_up_date = ? WHERE id = ?").bind(rule.what || "Follow up", dayStr(CALL_RULES[rule.next]), b.id));
    }
    await env.DB.batch(st2);
    return json({ success: true, stage: tgt });
  }
  if (p === "/admin/push/key" && request.method === "GET") return json({ key: (await getVapid(env)).pub });
  if (p === "/admin/push/subscribe" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const k = b.keys || {};
    if (typeof b.endpoint !== "string" || !/^https:\/\//.test(b.endpoint) || typeof k.p256dh !== "string" || typeof k.auth !== "string") return json({ success: false }, 400);
    await ensureTable(env.DB);
    await env.DB.prepare("INSERT INTO push_subs (endpoint, user, p256dh, auth) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user = excluded.user, p256dh = excluded.p256dh, auth = excluded.auth").bind(b.endpoint.slice(0, 600), user, k.p256dh.slice(0, 200), k.auth.slice(0, 100)).run();
    return json({ success: true });
  }
  if (p === "/admin/push/test" && request.method === "POST") {
    const sent = await pushToDevices(env, { title: "Alerts are on", message: "You will get new lead, missed call and reminder alerts here.", click: env.CRM_HOST ? `https://${env.CRM_HOST}/today` : "", users: [user] }).catch(() => 0);
    return json({ success: true, sent });
  }
  if (p === "/admin/queue" && request.method === "GET") return json(await queueStatus(env, user));
  if (p === "/admin/queue/start" && request.method === "POST") { const res = await startQueue(env, user); return json({ success: res.ok, message: res.message || "", total: res.total || 0 }, res.ok ? 200 : 502); }
  if (p === "/admin/queue/stop" && request.method === "POST") {
    await env.DB.prepare("UPDATE queue_run SET active = 0, ended_at = datetime('now'), next_at = NULL, note = 'Stopped.' WHERE active = 1 AND user = ?").bind(user).run();
    return json({ success: true });
  }
  if (p === "/admin/dial" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!Number.isInteger(b.id)) return json({ success: false, message: "Missing lead." }, 400);
    const lead = await env.DB.prepare("SELECT id, phone FROM leads WHERE id = ?").bind(b.id).first();
    if (!lead) return json({ success: false, message: "Lead not found." }, 404);
    const res = await placeCall(env, lead, user, "manual");
    return json({ success: res.ok, message: res.message || "" }, res.ok ? 200 : 502);
  }
  if (p === "/admin/touch" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!Number.isInteger(b.id) || typeof b.label !== "string") return json({ success: false }, 400);
    const cur = await env.DB.prepare("SELECT stage, follow_up_date FROM leads WHERE id = ?").bind(b.id).first();
    if (!cur) return json({ success: false }, 404);
    // Calling, texting or emailing never moves a lead. Only a person does: by moving it, or by answering "Did they answer?" with Answered.
    const stage = cur.stage;
    const stmts = [
      env.DB.prepare("UPDATE leads SET stage = ?" + (stage !== cur.stage ? ", stage_changed_at = datetime('now')" : "") + " WHERE id = ?").bind(stage, b.id),
      env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?,?,?,?,?)").bind(b.id, cur.stage, stage, clean(b.label, 120), user),
    ];
    await env.DB.batch(stmts);
    const abs = when(new Date().toISOString().slice(0, 19).replace("T", " ")).abs;
    return json({ success: true, stage, followup: "", follow_up_date: cur.follow_up_date || "", log: [{ from_stage: cur.stage, to_stage: stage, reason: clean(b.label, 120), at: abs }] });
  }
  if (p === "/admin/msg" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!Number.isInteger(b.id)) return json({ success: false }, 400);
    const lead = await env.DB.prepare("SELECT id, phone FROM leads WHERE id = ?").bind(b.id).first();
    if (!lead) return json({ success: false }, 404);
    const res = await sendLeadText(env, lead, b.body, { user });
    return json({ success: res.ok, message: res.message || "" }, res.ok ? 200 : 422);
  }
  if (p === "/admin/leadinfo" && request.method === "GET") {
    const id = Number(new URL(request.url).searchParams.get("id"));
    const lead = Number.isInteger(id) ? await env.DB.prepare("SELECT id, name, phone, email, service, year, make, model, value, appt_at, stage FROM leads WHERE id = ?").bind(id).first() : null;
    if (!lead) return json({ success: false }, 404);
    let products = [], best = "";
    if (env.URABLE_API_KEY) {
      const cat = await urableCatalog(env).catch(() => []);
      products = cat.map(x => ({ id: x.id, name: x.name, price: Number(x.prices && x.prices[0] && x.prices[0].value) || 0 })).sort((a, b) => a.name.localeCompare(b.name));
      const r = preferredProduct(cat, lead.service) || rankProducts(cat, lead.service, Math.round((Number(lead.value) || 0) * 100))[0];
      best = r ? r.id : "";
    }
    return json({ success: true, lead, urable: !!env.URABLE_API_KEY, products, best });
  }
  if (p === "/admin/book" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!Number.isInteger(b.id)) return json({ success: false }, 400);
    const cur = await env.DB.prepare("SELECT stage, follow_up_date FROM leads WHERE id = ?").bind(b.id).first();
    if (!cur) return json({ success: false }, 404);
    const at = etLocalToUtc(b.appt);
    if (!at) return json({ success: false, message: "Pick the appointment date and time." }, 400);
    const f = (k, n) => clean(b[k], n || 120);
    const lead = { name: f("name"), phone: f("phone"), email: f("email", 200), service: f("service"), year: f("year"), make: f("make"), model: f("model"), value: Math.max(0, Math.min(10000000, Math.floor(Number(b.value) || 0))) };
    if (!lead.name && !lead.phone) return json({ success: false, message: "Add a name or phone." }, 400);
    const rem = reminderTime(at), to = ["working", "done"].includes(cur.stage) ? cur.stage : "booked";
    const reason = `${clean(b.label, 120) || "Booked"} (appointment ${fmtAppt(b.appt)})`;
    await env.DB.batch([
      env.DB.prepare("UPDATE leads SET name = ?, phone = ?, email = ?, service = ?, year = ?, make = ?, model = ?, value = ?, appt_at = ?, appt_remind_at = ?, appt_reminded = 0, stage = ?, contacted = 1, follow_up = ''" + (to !== cur.stage ? ", stage_changed_at = datetime('now')" : "") + " WHERE id = ?").bind(lead.name, lead.phone, lead.email, lead.service, lead.year, lead.make, lead.model, lead.value, String(b.appt).slice(0, 16), rem ? sqlUtc(rem) : null, to, b.id),
      env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?,?,?,?,?)").bind(b.id, cur.stage, to, reason, user),
    ]);
    await env.DB.prepare("DELETE FROM automation_runs WHERE lead_id = ? AND automation_id IN (SELECT id FROM automations WHERE kind = 'appointment')").bind(b.id).run().catch(() => {});
    await afterBooked(env, b.id, cur.stage === "booked" ? "rescheduled" : "booked", { productId: clean(b.product_id, 80) });
    const abs = when(sqlUtc(new Date())).abs;
    return json({ success: true, stage: to, followup: "", follow_up_date: cur.follow_up_date || "", lead: { ...lead, appt_at: String(b.appt).slice(0, 16), follow_up: "" }, log: [{ from_stage: cur.stage, to_stage: to, reason, at: abs }] });
  }
  if (p === "/admin/appt" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!Number.isInteger(b.id)) return json({ success: false }, 400);
    const cur = await env.DB.prepare("SELECT stage, follow_up_date FROM leads WHERE id = ?").bind(b.id).first();
    if (!cur) return json({ success: false }, 404);
    const label = clean(b.label, 120) || "Texted: Scheduled";
    const abs = when(sqlUtc(new Date())).abs;
    const done = (stage, reason) => json({ success: true, stage, followup: "", follow_up_date: cur.follow_up_date || "", log: [{ from_stage: cur.stage, to_stage: stage, reason, at: abs }] });
    if (b.sent === "reminder") {
      await env.DB.batch([env.DB.prepare("UPDATE leads SET appt_reminded = 1, contacted = 1 WHERE id = ?").bind(b.id), env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?,?,?,?,?)").bind(b.id, cur.stage, cur.stage, label, user)]);
      return done(cur.stage, label);
    }
    const at = etLocalToUtc(b.appt);
    if (!at) return json({ success: false, message: "Pick a date and time." }, 400);
    const rem = reminderTime(at), to = ["working", "done"].includes(cur.stage) ? cur.stage : "booked";
    const reason = `${label} (appointment ${fmtAppt(b.appt)})`;
    await env.DB.batch([
      env.DB.prepare("UPDATE leads SET appt_at = ?, appt_remind_at = ?, appt_reminded = 0, stage = ?, contacted = 1" + (to !== cur.stage ? ", stage_changed_at = datetime('now')" : "") + " WHERE id = ?").bind(String(b.appt).slice(0, 16), rem ? sqlUtc(rem) : null, to, b.id),
      env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?,?,?,?,?)").bind(b.id, cur.stage, to, reason, user),
    ]);
    await env.DB.prepare("DELETE FROM automation_runs WHERE lead_id = ? AND automation_id IN (SELECT id FROM automations WHERE kind = 'appointment')").bind(b.id).run().catch(() => {});
    await afterBooked(env, b.id, cur.stage === "booked" ? "rescheduled" : to === "booked" ? "booked" : "rescheduled");
    return done(to, reason);
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
    if (moved && stage === "booked") await bookedHook(env, b.id, "booked");
    const abs = when(new Date().toISOString().slice(0, 19).replace("T", " ")).abs;
    return json({ success: true, stage, followup: follow, follow_up_date: date, log: logs.map(([f, t, r]) => ({ from_stage: f, to_stage: t, reason: r, at: abs })).reverse() });
  }
  return new Response("Not found", { status: 404 });
}
