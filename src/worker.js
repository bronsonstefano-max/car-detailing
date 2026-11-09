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
//   DEEPGRAM_API_KEY  (secret)                 live transcript of dialer calls (Twilio Media Streams -> a Durable Object -> Deepgram). DEEPGRAM_LANGUAGE (optional, default "multi") sets the language
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

const STAGES = [["new", "New lead"], ["nocontact", "Not contacted"], ["contacted", "Contacted"], ["quoted", "Quote sent"], ["booked", "Booked"], ["working", "In the shop"], ["done", "Completed"], ["aged", "7 day +"], ["lost", "Lost"]];
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
    db.prepare("CREATE TABLE IF NOT EXISTS call_transcripts (call_sid TEXT PRIMARY KEY, lead_id INTEGER, turns TEXT, signals TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT)"),
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
  await env.DB.prepare(`INSERT INTO leads (type,name,email,phone,service,make,year,model,message,utm_source,utm_medium,stage,value)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(/call/i.test(source) ? "call" : "manual", name, email, phone, clean(b.service, 100), clean(b.make, 60), clean(b.year, 10), clean(b.model, 80), clean(b.notes, 2000), source, "manual", STAGE_KEYS.includes(b.stage) ? b.stage : "new", defaultValue(clean(b.service, 100))).run();
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
  const pw = passwordOf(env, user);
  if (!pw || !/^\d{10,}$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
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
function askBook(id,label){return new Promise(async res=>{const d=document.getElementById('bkdlg');let l=null,uc=false,pr=[],bst='';
  try{const r=await fetch('/admin/leadinfo?id='+id);const j=await r.json();l=j.lead;uc=!!j.urable;pr=j.products||[];bst=j.best||''}catch(_){}
  if(!l){res(null);return}
  const f=(k,v)=>{document.getElementById('bk'+k).value=v==null?'':v};
  f('n2',l.name);f('p',l.phone);f('e',l.email);f('s',l.service);f('y',l.year);f('m',l.make);f('d',l.model);f('v',l.value||'');f('t',l.appt_at||'');
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
document.addEventListener('click',e=>{const a=e.target.closest('a[href^="tel:"]');if(!a)return;const h=a.closest('[data-id]');const id=(h&&+h.dataset.id)||window.DD_LEAD;if(!id)return;e.preventDefault();if(a.dataset.busy)return;a.dataset.busy='1';const t=a.textContent;a.textContent='Calling your phone...';
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
  return `<nav class="navtabs"><a href="/admin/today" class="${on === "today" ? "on" : ""}">Today${badge(n)}</a><a href="/admin" class="${on === "leads" ? "on" : ""}">Leads</a><a href="/admin/pipeline" class="${on === "pipeline" ? "on" : ""}">Pipeline</a><a href="/admin/messages" class="${on === "messages" ? "on" : ""}">Messages<i class="nb unr" hidden></i></a>${owner ? `<a href="/admin/speed" class="${on === "speed" ? "on" : ""}">Speed</a><a href="/admin/rate" class="${on === "rate" ? "on" : ""}">Contact rate</a><a href="/admin/missed" class="${on === "missed" ? "on" : ""}">Missed dials</a><a href="/admin/insights" class="${on === "insights" ? "on" : ""}">Insights</a><a href="/admin/dialer" class="${on === "dialer" ? "on" : ""}">Dial</a><a href="/admin/calendar" class="${on === "calendar" ? "on" : ""}">Calendar</a><a href="/admin/automations" class="${on === "automations" ? "on" : ""}">Automations</a>` : ""}<a href="/logout" class="so">Sign out</a></nav>${PUSH_NAV}`;
}
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
  const moreKeys = ["speed", "rate", "missed", "insights", "calendar", "automations", "dialer"];
  const row = (href, key, label, svg) => `<a href="${href}" class="${on === key ? "on" : ""}">${svg}${label}</a>`;
  return `<nav class="bnav" aria-label="Sections">${tab("/admin/today", "today", "Today", badge(n))}${tab("/admin", "leads", "Leads")}${tab("/admin/pipeline", "pipeline", "Pipeline")}<a href="/admin/messages" class="${on === "messages" ? "on" : ""}">${ic.texts}Texts<i class="nb unr" hidden></i></a>${owner ? `<button type="button" id="morebtn" class="${moreKeys.includes(on) ? "on" : ""}">${ic.more}More</button>` : ""}</nav>
${owner ? `<div class="msheet" id="msheet"><div class="bd"></div><div class="sh"><div class="grab"></div>${row("/admin/speed", "speed", "Speed", SPEED_ICON)}${row("/admin/rate", "rate", "Contact rate", ic.rate)}${row("/admin/missed", "missed", "Missed dials", ic.missed)}${row("/admin/dialer", "dialer", "Dial", ic.phone)}${row("/admin/calendar", "calendar", "Calendar", ic.calendar)}${row("/admin/automations", "automations", "Automations", ic.bolt)}${row("/admin/insights", "insights", "Insights", ic.insights)}${row("/logout", "out", "Sign out", ic.out)}</div></div>` : ""}
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
const BNAV_CSS = `article.lead[hidden]{display:none!important}.bnav,.msheet{display:none}.nb{font-style:normal;background:#ff5d5d;color:#fff;border-radius:999px;font-size:11px;font-weight:700;padding:1px 7px;margin-left:6px}.nb[hidden]{display:none}.navtabs a.on .nb{background:#04120a;color:#32cd32}
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
  ...l, page: "", referrer: "", gclid: "", gbraid: "", wbraid: "", utm_source: "", utm_medium: "", utm_campaign: "", utm_term: "",
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
  const [tc, { results }] = await Promise.all([todayCount(env), env.DB.prepare("SELECT id,created_at,type,name,email,phone,service,also_interested,make,year,model,message,page,referrer,gclid,gbraid,wbraid,utm_medium,utm_source,utm_campaign,utm_term,stage,value,notes,appt_at,stage_changed_at,follow_up,follow_up_date,duration,recording,answered FROM leads WHERE type != 'newsletter' ORDER BY created_at DESC, id DESC LIMIT 1000").all()]);
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
.col{flex:1 0 190px;max-width:330px;background:#0b0e12;border:1px solid #1b2027;border-radius:14px;display:flex;flex-direction:column;max-height:100%;scroll-snap-align:start}
.col.over{border-color:#32cd32;background:#0d140f}.col h2{font-size:13px;margin:0;padding:12px 14px;display:flex;justify-content:space-between;align-items:baseline;text-transform:uppercase;letter-spacing:.7px;color:#c3c8cf}
.col h2 small{color:#7c838d;font-weight:500;text-transform:none;letter-spacing:0}.col.s-lost h2{color:#c48a8a}.col.s-aged h2{color:#ffb86b}.col.s-done h2{color:#7fe07f}
.cards{padding:0 10px 10px;display:flex;flex-direction:column;gap:9px;overflow-y:auto;min-height:60px}
.card{background:#12171e;border:1px solid #232a33;border-radius:11px;padding:11px 12px;cursor:grab}.card:hover{border-color:#3a4552}.card.drag{opacity:.4}
.card b{display:block;font-size:15px}.card .meta{color:#98a0aa;font-size:13px;margin-top:2px}.card .row span:first-child{white-space:nowrap}.card .row{display:flex;justify-content:space-between;gap:8px;margin-top:8px;align-items:center;color:#7c838d;font-size:12px}
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
function cardHtml(l,qa){const tel=(l.phone||'').replace(/[^\\d+]/g,'');return '<article class="card" draggable="'+(M.matches?'false':'true')+'" data-id="'+l.id+'"><b>'+$(l.name||l.email)+'</b><div class="meta">'+$(l.service||'')+(l.make?' &middot; '+$([l.year,l.make,l.model].filter(Boolean).join(' ')):'')+'</div><div class="row"><span>'+$(l.ago)+'</span><span>'+(l.type==='call'?(/voicemail/i.test(l.message||'')?'<span class="pill miss">Voicemail</span> ':l.answered===0?'<span class="pill miss">Missed</span> ':'<span class="pill call">Call</span> '):'')+(l.ad?'<span class="pill ad">Ads</span> ':'')+(l.value?'<span class="pill val">'+money(l.value)+'</span>':'')+'</span></div>'+(qa&&tel?'<div class="qa"><a class="call" href="tel:'+$(tel)+'" data-stop="1">Call</a><button type="button" data-open="'+l.id+'">Details</button></div>':'')+'</article>'}
const LIM={};const lim=k=>LIM[k]||40;const moreBtn=(k,n)=>n>lim(k)?'<button type="button" class="chip" data-more="'+k+'" style="margin:8px auto;display:block">Show '+Math.min(60,n-lim(k))+' more ('+(n-lim(k))+' left)</button>':'';
function draw(){
  let open=0,won=0,booked=0;
  S.forEach(([k])=>{const ls=L.filter(l=>l.stage===k),tot=ls.reduce((a,l)=>a+(l.value||0),0);if(k==='new'||k==='nocontact')open+=ls.length;if(k==='booked'||k==='working'||k==='done')booked+=tot;if(k==='done')won=tot});
  const pipe=L.filter(l=>['new','nocontact','contacted','quoted'].includes(l.stage)).reduce((a,l)=>a+(l.value||0),0);
  document.getElementById('sum').innerHTML='<div class="stat g"><b>'+open+'</b><span>new to contact</span></div><div class="stat"><b>'+money(pipe)+'</b><span>$ in pipeline</span></div><div class="stat"><b>'+money(booked)+'</b><span>booked + done</span></div><div class="stat"><b>'+money(won)+'</b><span>completed</span></div>';
  const tabs=document.getElementById('tabs');
  if(M.matches){
    tabs.innerHTML=S.map(([k,n])=>'<button class="tab'+(k===cur?' on':'')+'" data-tab="'+k+'">'+n+' <i>'+L.filter(l=>l.stage===k).length+'</i></button>').join('');
    const ls=L.filter(l=>l.stage===cur),tot=ls.reduce((a,l)=>a+(l.value||0),0),name=(S.find(x=>x[0]===cur)||[0,''])[1];
    board.innerHTML='<section class="col" data-stage="'+cur+'"><h2>'+name+' <small>'+ls.length+(tot?' &middot; '+money(tot):'')+'</small></h2><div class="cards">'+(ls.slice(0,lim(cur)).map(l=>cardHtml(l,true)).join('')||'<div class="empty">Nothing in '+$(name)+' right now</div>')+moreBtn(cur,ls.length)+'</div></section>';
    const on=tabs.querySelector('.tab.on');if(on&&on.scrollIntoView)on.scrollIntoView({inline:'center',block:'nearest'});
    return;
  }
  tabs.innerHTML='';
  board.innerHTML=S.map(([k,n])=>{const ls=L.filter(l=>l.stage===k),tot=ls.reduce((a,l)=>a+(l.value||0),0);
    return '<section class="col s-'+k+'" data-stage="'+k+'"><h2>'+n+' <small>'+ls.length+(tot?' &middot; '+money(tot):'')+'</small></h2><div class="cards">'+
    (ls.slice(0,lim(k)).map(l=>cardHtml(l,false)).join('')||'<div class="empty">Drop leads here</div>')+moreBtn(k,ls.length)+'</div></section>';}).join('');
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
board.addEventListener('drop',async e=>{const c=e.target.closest('.col');if(!c||dragId==null)return;e.preventDefault();const l=L.find(x=>x.id===dragId);const st=c.dataset.stage;if(l&&l.stage!==st){if(st==='booked'){const o=await askBook(l.id);if(o){Object.assign(l,o.lead||{});apply(l,o);if(o.log)l.log=o.log.concat(l.log||[])}draw();return}const o=await save(l.id,{stage:st},'/admin/stage');if(o){apply(l,o);draw();const nx=await askNext(l.name||l.phone||l.email,l.stage,l.id);if(nx){const o2=await save(l.id,{followup:nx.followup,follow_date:nx.follow_date},'/admin/stage');apply(l,o2)}}draw()}else draw()});
board.addEventListener('click',e=>{if(e.target.closest('[data-stop]'))return;const d=e.target.closest('[data-open]');if(d){open(+d.dataset.open);return}const c=e.target.closest('.card');if(c)open(+c.dataset.id)});
document.addEventListener('click',e=>{const a=e.target.closest('a[href^=\"tel:\"]');if(!a)return;const h=a.closest('[data-id]');if(!h||!h.dataset.id)return;markCall(+h.dataset.id,((h.querySelector('h3,b')||{}).textContent||'').trim());try{fetch('/admin/touch',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({id:+h.dataset.id,label:'Called'})})}catch(_){}});
const SVC=['Window Tint','PPF / Clear Bra','Ceramic Coating','Paint Correction','Vinyl Wraps','Exterior Detailing','Other'];
function open(id){const l=L.find(x=>x.id===id);if(!l)return;dlg.dataset.id=id;const tel=(l.phone||'').replace(/[^\\d+]/g,''),veh=[l.year,l.make,l.model].filter(Boolean).join(' '),isCall=l.type==='call';
  const ed='<details class="ed"'+((isCall||!l.service)?' open':'')+'><summary>Edit contact and vehicle</summary><div class="g2"><div><label>Name</label><input id="en" value="'+$(l.name||'')+'" autocomplete="off"></div><div><label>Phone</label><input id="ep" type="tel" inputmode="tel" value="'+$(l.phone||'')+'"></div><div><label>Email</label><input id="ee" type="email" value="'+$(l.email||'')+'"></div><div><label>Service</label><select id="es"><option value="">Not set</option>'+SVC.map(x=>'<option'+(x===l.service?' selected':'')+'>'+x+'</option>').join('')+'</select></div><div><label>Make</label><input id="em" value="'+$(l.make||'')+'"></div><div><label>Model</label><input id="ed2" value="'+$(l.model||'')+'"></div><div><label>Year</label><input id="ey" inputmode="numeric" value="'+$(l.year||'')+'"></div></div></details>';
  dlg.innerHTML='<div class="dh"><div><h3>'+$(l.name||l.phone||l.email||'Unknown caller')+'</h3><div style="color:#8a9099;font-size:13px">'+$(l.ago)+' &middot; '+$(l.abs)+' ET &middot; '+$(l.src)+'</div></div><button class="x" onclick="dlg.close()" aria-label="Close">&times;</button></div><div class="db">'+
  '<div class="acts">'+(tel?'<a class="btn call" href="tel:'+$(tel)+'">Call '+$(l.phone)+'</a>':'')+(l.email?'<a class="btn" href="mailto:'+$(l.email)+'">Email</a>':'')+(l.recording?'<a class="btn rec" href="'+$(l.recording)+'" target="_blank" rel="noopener">&#9654; Listen</a>':'')+'</div>'+
  (isCall?'<div style="color:#c9a8ff;font-size:14px">'+(/voicemail/i.test(l.message||'')?'Voicemail':l.answered===0?'Missed call':'Phone call'+(l.dur?' &middot; '+$(l.dur):''))+'</div>':'')+
  infoHtml(l,veh)+
  ed+
  '<div id="ca"></div>'+
  '<div id="hist">'+histHtml(l)+'</div>'+
  '<div id="cr"></div>'+
  '<div id="cn"></div>'+
  '<div class="rp"><label>One-tap reply</label><select id="tp">'+tplFor(l).map(t=>'<option value="'+t.id+'">'+$(t.label)+'</option>').join('')+'</select><div id="tap" style="display:none"><label>Appointment date and time'+(l.appt_at?' (saved)':'')+'</label><input id="tad" type="datetime-local" style="color-scheme:dark"></div><textarea id="tb" rows="3"></textarea><div class="acts">'+(tel?'<a class="btn call" id="tsms" href="#">Text</a>':'')+(l.email?'<a class="btn" id="tmail" href="#">Email</a>':'')+'<button type="button" class="btn" id="tcopy">Copy</button></div></div>'+
  '<div><label>Stage</label><div class="chips" id="fchips">'+S.map(([k,n])=>'<button type="button" data-k="'+k+'" class="'+(k===l.stage?'on':'')+'">'+n+'</button>').join('')+'</div></div><div><label>Next step <span id="fuh" style="text-transform:none;letter-spacing:0;color:#586069"></span></label><div class="fu-chips" id="fuc"></div></div><div class="g2"><div><label>Follow up on</label><input id="fd" type="date" value="'+$(l.follow_up_date||'')+'" style="color-scheme:dark"></div><div><label>Job value ($)</label><input id="fv" type="number" min="0" step="1" inputmode="numeric" value="'+(l.value||'')+'" placeholder="0"></div></div>'+
  '<div><label>Notes</label><textarea id="fn" placeholder="Called, left voicemail... quoted full front PPF...">'+$(l.notes||'')+'</textarea></div>'+
  '<div class="acts"><button class="btn go" id="fsave">Save</button>'+(IS_OWNER?'<button class="btn ghost" id="fdel" type="button">Delete lead</button>':'')+'</div></div>';
  dlg.showModal();
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
  const tp=document.getElementById('tp'),tb=document.getElementById('tb');
  const ap=document.getElementById('tap'),ad=document.getElementById('tad');
  function fmtAppt(v){const m=/^(\\d{4})-(\\d\\d)-(\\d\\d)T(\\d\\d):(\\d\\d)/.exec(v||'');if(!m)return '';const d=new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5]);return d.toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})+' at '+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}
  function tfill(){const t=TPL.find(x=>x.id===tp.value),need=t.body.indexOf('{appointment}')>=0;ap.style.display=need?'':'none';const when=fmtAppt(ad.value),f=tplFill(t,l,when);tb.value=f.body;tb.dataset.subj=f.subject;
    for(const id of ['tsms','tmail']){const e=document.getElementById(id);if(e){e.style.opacity=need&&!when?'.4':'';e.style.pointerEvents=need&&!when?'none':''}}sync()}
  if(l.appt_at)ad.value=l.appt_at;ad.oninput=tfill;
  function sync(){const sm=document.getElementById('tsms'),ml=document.getElementById('tmail');if(sm)sm.href=smsHref(l.phone,tb.value);if(ml)ml.href=mailHref(l.email,tb.dataset.subj||'',tb.value)}
  async function logTouch(kind){const id=tp.value,label=kind+': '+TPL.find(x=>x.id===id).label;
    const r=id==='scheduled'&&ad.value?await save(l.id,{label,appt:ad.value},'/admin/appt'):id==='reminder'&&l.appt_at?await save(l.id,{label,sent:'reminder'},'/admin/appt'):await save(l.id,{label},'/admin/touch');
    if(r&&r.stage){apply(l,r);if(id==='scheduled'&&ad.value)l.appt_at=ad.value;if(r.log)l.log=r.log.concat(l.log||[]);draw()}}
  tp.onchange=tfill;tb.oninput=sync;tfill();
  const sm=document.getElementById('tsms'),ml=document.getElementById('tmail');
  if(sm)sm.onclick=()=>{logTouch('Texted')};if(ml)ml.onclick=()=>{logTouch('Emailed')};
  document.getElementById('tcopy').onclick=async e=>{try{await navigator.clipboard.writeText(tb.value);e.target.textContent='Copied'}catch(_){tb.select()}};
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
    env.DB.prepare("INSERT INTO messages (lead_id, phone, direction, body, status, sid, by_user, auto, is_read) VALUES (?,?,?,?,?,?,?,?,1)").bind(lead.id, to, "out", body, status, ok ? j.sid : "", user, auto ? 1 : 0),
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
  if (sid && st) await env.DB.prepare("UPDATE messages SET status = ? WHERE sid = ? AND direction = 'out'").bind(st.slice(0, 20), sid).run();
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
  const rs = (await env.DB.prepare(`SELECT l.id, l.name, l.phone, l.service, l.stage,
      (SELECT body FROM messages WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) last_body,
      (SELECT direction FROM messages WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) last_dir,
      (SELECT at FROM messages WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) last_at,
      (SELECT COUNT(*) FROM messages WHERE lead_id = l.id AND direction = 'in' AND is_read = 0) unread
    FROM leads l WHERE EXISTS (SELECT 1 FROM messages WHERE lead_id = l.id) ORDER BY last_at DESC, l.id DESC LIMIT 200`).all()).results || [];
  return json({ success: true, on: twilioOn(env), threads: rs.map(r => ({ ...r, last_at: isoUtc(r.last_at) })) });
}
async function messageThread(env, url) {
  await ensureTable(env.DB);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id)) return json({ success: false }, 400);
  const lead = await env.DB.prepare("SELECT id, name, phone, service, stage, year, make, model FROM leads WHERE id = ?").bind(id).first();
  if (!lead) return json({ success: false }, 404);
  await env.DB.prepare("UPDATE messages SET is_read = 1 WHERE lead_id = ? AND direction = 'in' AND is_read = 0").bind(id).run();
  const ms = (await env.DB.prepare("SELECT id, direction, body, status, auto, by_user, at FROM messages WHERE lead_id = ? ORDER BY id DESC LIMIT 300").bind(id).all()).results || [];
  return json({ success: true, lead, on: twilioOn(env), optout: await isOptedOut(env, lead.phone), messages: ms.reverse().map(m => ({ ...m, at: isoUtc(m.at) })) });
}
async function messagesPage(env, user) {
  await ensureTable(env.DB);
  const tc = await todayCount(env), owner = user === OWNER;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">${PWA_HEAD}<title>Messages | Divine Detailers</title>
<style>
*{box-sizing:border-box}html,body{height:100%}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#07090c;color:#e8eaed;display:flex;flex-direction:column}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px;flex-wrap:wrap}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}.navtabs a.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
.app{flex:1;min-height:0;display:grid;grid-template-columns:330px 1fr}
.list{border-right:1px solid #1b1f25;overflow-y:auto;min-height:0;display:flex;flex-direction:column}
.sr{padding:10px;border-bottom:1px solid #1b1f25;display:flex;gap:8px}.sr input{flex:1;min-width:0;background:#12171e;border:1px solid #2a313a;color:#fff;border-radius:10px;padding:10px 12px;font:inherit;font-size:16px}
.th{display:block;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid #151a21;color:inherit;font:inherit;padding:12px 14px;cursor:pointer}.th.on{background:#10151b}
.th b{display:flex;justify-content:space-between;gap:8px}.th small{color:#7c838d;font-weight:400;white-space:nowrap}.th p{margin:3px 0 0;color:#98a0aa;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.un{background:#32cd32;color:#04120a;border-radius:999px;font-size:11px;font-weight:800;padding:1px 7px;margin-left:6px}
.pane{display:flex;flex-direction:column;min-height:0;min-width:0}
.ph{display:flex;gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid #1b1f25}.ph .t{flex:1;min-width:0}.ph .t b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ph .t span{color:#7c838d;font-size:13px}
.bk{display:none;background:#151a21;border:1px solid #2a313a;color:#e8eaed;border-radius:10px;padding:9px 12px;font:inherit;cursor:pointer}
.ph a.c{border:1px solid #2a313a;background:#151a21;color:#e8eaed;text-decoration:none;border-radius:10px;padding:9px 12px;font-weight:700}
.msgs{flex:1;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;-webkit-overflow-scrolling:touch}
.m{max-width:min(78%,520px);padding:9px 12px;border-radius:16px;white-space:pre-wrap;overflow-wrap:anywhere}.m.out{align-self:flex-end;background:#32cd32;color:#04120a;border-bottom-right-radius:5px}.m.in{align-self:flex-start;background:#1a2027;border-bottom-left-radius:5px}
.mt{font-size:11.5px;color:#7c838d;margin:-4px 4px 2px}.mt.out{align-self:flex-end}.mt.in{align-self:flex-start}
.empty{margin:auto;color:#7c838d;text-align:center;padding:20px}
.cmp{display:flex;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));border-top:1px solid #1b1f25;align-items:flex-end}
.cmp textarea{flex:1;min-width:0;background:#12171e;border:1px solid #2a313a;color:#fff;border-radius:14px;padding:11px 13px;font:inherit;font-size:16px;resize:none;max-height:140px;min-height:44px}
.cmp button{background:#32cd32;border:0;color:#04120a;border-radius:12px;padding:0 18px;font:inherit;font-weight:800;min-height:44px;cursor:pointer}.cmp button:disabled{opacity:.4}
.warn{background:#2a1d0e;color:#ffb86b;padding:10px 14px;font-size:14px;border-bottom:1px solid #3a2a14}.err{color:#ff8a8a;padding:0 14px 6px;font-size:13.5px;min-height:0}
${BNAV_CSS}
@media(max-width:700px){header{padding:10px 14px}h1{font-size:17px}.app{grid-template-columns:1fr}.pane{display:none}.app.open .list{display:none}.app.open .pane{display:flex}.bk{display:block}.m{max-width:86%}}
</style></head><body>
<header><h1>Divine Detailers <b>messages</b></h1>${nav("messages", tc, owner)}</header>
${bnav("messages", tc, owner)}
<div class="app" id="app"><div class="list"><div class="sr"><input id="q" placeholder="Search a lead to text" autocomplete="off"></div><div id="tl"></div></div>
<div class="pane" id="pane"><div class="empty" id="ph0">Pick a conversation, or search for a lead to start one.</div></div></div>
<script>
const $=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const app=document.getElementById('app'),tl=document.getElementById('tl'),pane=document.getElementById('pane'),q=document.getElementById('q');
let cur=null,on=true,busy=false,lastSig='';
function ago(iso){const d=new Date(iso),n=Date.now(),s=Math.max(0,(n-d)/1000);if(s<60)return 'now';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h';return d.toLocaleDateString('en-US',{month:'short',day:'numeric'})}
function nm(l){return l.name||l.phone||'Lead'}
async function loadList(){try{const r=await fetch('/admin/threads');if(!r.ok)return;const j=await r.json();on=j.on;
  tl.innerHTML=j.threads.length?j.threads.map(t=>'<button class="th'+(cur&&cur.id===t.id?' on':'')+'" data-id="'+t.id+'"><b><span>'+$(nm(t))+(t.unread?'<span class="un">'+t.unread+'</span>':'')+'</span><small>'+ago(t.last_at)+'</small></b><p>'+(t.last_dir==='out'?'You: ':'')+$(t.last_body)+'</p></button>').join(''):'<div class="empty">No texts yet. Search for a lead above to start one.</div>'}catch(_){}}
async function open(id,keep){try{const r=await fetch('/admin/thread?id='+id);if(!r.ok)return;const j=await r.json();const sig=j.messages.length+':'+(j.messages.length?j.messages[j.messages.length-1].id+j.messages[j.messages.length-1].status:'')+j.optout;
  if(keep&&cur&&cur.id===id&&sig===lastSig)return;lastSig=sig;cur=j.lead;on=j.on;
  const box=pane.querySelector('.msgs'),atEnd=!box||box.scrollHeight-box.scrollTop-box.clientHeight<80;const draft=pane.querySelector('textarea')?pane.querySelector('textarea').value:'';
  const car=[j.lead.year,j.lead.make,j.lead.model].filter(Boolean).join(' ');
  pane.innerHTML='<div class="ph"><button class="bk" id="bk">Back</button><div class="t"><b>'+$(nm(j.lead))+'</b><span>'+$([j.lead.service,car].filter(Boolean).join(' · ')||j.lead.phone)+'</span></div><a class="c" href="/admin/pipeline#id='+j.lead.id+'">Lead</a><a class="c" href="tel:'+$(j.lead.phone)+'">Call</a></div>'
   +(!on?'<div class="warn">Texting is not set up yet. Add the Twilio keys in Cloudflare to send texts from here.</div>':'')+(j.optout?'<div class="warn">This person replied STOP. They cannot be texted.</div>':'')
   +'<div class="msgs" id="ms">'+(j.messages.length?j.messages.map(m=>'<div class="m '+m.direction+'">'+$(m.body)+'</div><div class="mt '+m.direction+'">'+new Date(m.at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+(m.direction==='out'?(m.auto?' · auto':'')+(m.status==='failed'||m.status==='undelivered'?' · not delivered':m.status==='delivered'?' · delivered':''):'')+'</div>').join(''):'<div class="empty">No messages yet. Say hello.</div>')+'</div><div class="err" id="er"></div>'
   +'<div class="cmp"><textarea id="tx" rows="1" placeholder="Text message"'+(on&&!j.optout?'':' disabled')+'></textarea><button id="sd"'+(on&&!j.optout?'':' disabled')+'>Send</button></div>';
  const ms=document.getElementById('ms');if(!keep||atEnd)ms.scrollTop=ms.scrollHeight;const tx=document.getElementById('tx');tx.value=draft;
  document.getElementById('bk').onclick=()=>{app.classList.remove('open');cur=null;history.replaceState(null,'','#');loadList()};
  document.getElementById('sd').onclick=send;tx.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();send()}});
  app.classList.add('open');if(!keep)history.replaceState(null,'','#id='+id);loadList()}catch(_){}}
async function send(){if(busy||!cur)return;const tx=document.getElementById('tx'),er=document.getElementById('er'),b=tx.value.trim();if(!b)return;busy=true;document.getElementById('sd').disabled=true;er.textContent='';
  try{const r=await fetch('/admin/msg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:cur.id,body:b})});const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.success){er.textContent=j.message||'Could not send. Try again.';busy=false;document.getElementById('sd').disabled=false;return}
    tx.value='';busy=false;lastSig='';await open(cur.id,false)}catch(_){er.textContent='No connection. Try again.';busy=false;document.getElementById('sd').disabled=false}}
tl.addEventListener('click',e=>{const b=e.target.closest('.th,.fd');if(b)open(+b.dataset.id)});
let qt;q.addEventListener('input',()=>{clearTimeout(qt);const v=q.value.trim();if(!v){loadList();return}qt=setTimeout(async()=>{try{const r=await fetch('/admin/threads?find='+encodeURIComponent(v));const j=await r.json();tl.innerHTML=(j.found&&j.found.length?j.found.map(l=>'<button class="th fd" data-id="'+l.id+'"><b><span>'+$(nm(l))+'</span></b><p>'+$([l.phone,l.service].filter(Boolean).join(' · '))+'</p></button>').join(''):'<div class="empty">No lead found.</div>')}catch(_){}},250)});
const hm=/^#id=(\\d+)$/.exec(location.hash);loadList();if(hm)open(+hm[1]);
setInterval(()=>{if(document.hidden||q.value.trim())return;loadList();if(cur)open(cur.id,true)},6000);
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
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
  if (!quietHoursOk(env)) return xmlRes("<Say>Calls can only be placed between 8 AM and 9 PM Eastern.</Say><Hangup/>");
  const from = e164(env.TWILIO_VOICE_FROM || env.TWILIO_FROM);
  if (!from) return xmlRes("<Say>No caller ID number is set up.</Say><Hangup/>");
  const base = env.PUBLIC_URL || "https://divinedetailers.com";
  const sid = /^CA[0-9a-f]{32}$/.test(String(params.CallSid || "")) ? params.CallSid : "";
  const stream = sid && coachEnabled(env) ? `<Start><Stream url="${base.replace(/^http/, "ws")}/api/twilio/stream/${sid}/${await coachSig(env, sid)}" track="both_tracks"><Parameter name="lead" value="${lead.id}"/></Stream></Start>` : "";
  return xmlRes(`${stream}<Dial callerId="${from}" answerOnBridge="true" timeout="40" record="record-from-answer-dual" recordingStatusCallback="${base}/api/twilio/voice/recording?lead=${lead.id}" recordingStatusCallbackEvent="completed"><Number>${e164(lead.phone)}</Number></Dial>`);
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
async function dialerQueue(env) {
  await ensureTable(env.DB);
  const rows = (await env.DB.prepare(`SELECT l.id, l.name, l.phone, l.email, l.service, l.year, l.make, l.model, l.message, l.created_at, l.stage, l.value, l.follow_up_date, l.utm_medium,
      (SELECT COUNT(*) FROM dial_calls d WHERE d.lead_id = l.id AND d.started_at >= datetime('now','-1 day')) tries24,
      (SELECT COUNT(*) FROM dial_calls d WHERE d.lead_id = l.id AND d.started_at >= datetime('now','-3 hours')) tries3,
      (SELECT MAX(d.started_at) FROM dial_calls d WHERE d.lead_id = l.id) last_try,
      CASE WHEN l.follow_up_date IS NOT NULL AND l.follow_up_date != '' AND l.follow_up_date <= date('now') AND l.stage NOT IN ('new','nocontact') THEN 1 ELSE 0 END cb
    FROM leads l WHERE l.type != 'newsletter' AND COALESCE(l.ip,'') != 'demo' AND COALESCE(l.phone,'') != ''
      AND ((l.stage IN ('new','nocontact') AND l.created_at >= datetime('now','-14 days')) OR (l.follow_up_date IS NOT NULL AND l.follow_up_date != '' AND l.follow_up_date <= date('now') AND l.stage NOT IN ('done','lost','aged')))
    ORDER BY cb DESC, (tries3 > 0), l.created_at DESC LIMIT 60`).all()).results || [];
  const ids = rows.map(r => r.id);
  const notes = ids.length ? (await env.DB.prepare(`SELECT lead_id, reason, at FROM stage_log WHERE lead_id IN (${ids.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 400`).bind(...ids).all()).results || [] : [];
  const texts = ids.length ? (await env.DB.prepare(`SELECT lead_id, direction, body, at FROM messages WHERE lead_id IN (${ids.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 300`).bind(...ids).all()).results || [] : [];
  return json({ success: true, leads: rows.map(r => ({ ...r, created_at: isoUtc(r.created_at), history: notes.filter(n => n.lead_id === r.id).slice(0, 4).map(n => ({ reason: n.reason, at: isoUtc(n.at) })), texts: texts.filter(t => t.lead_id === r.id).slice(0, 3).map(t => ({ direction: t.direction, body: String(t.body).slice(0, 200), at: isoUtc(t.at) })) })) });
}
async function dialerLog(env, b, user) {
  await ensureTable(env.DB);
  if (!Number.isInteger(b.lead_id)) return json({ success: false }, 400);
  const cur = await env.DB.prepare("SELECT stage FROM leads WHERE id = ?").bind(b.lead_id).first();
  if (!cur) return json({ success: false }, 404);
  const dur = Math.max(0, Math.min(14400, Math.floor(Number(b.duration)) || 0));
  const mmss = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}`;
  const stmts = [
    env.DB.prepare("INSERT INTO dial_calls (lead_id, call_sid, duration, by_user) VALUES (?,?,?,?)").bind(b.lead_id, clean(b.sid, 60), dur, user),
    env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?,?,?,?,?)").bind(b.lead_id, cur.stage, cur.stage, dur ? `Called (in-app dialer): ${mmss}` : "Called (in-app dialer): not connected", user),
  ];
  // a conversation longer than the usual limit counts as contact, the same rule as the other calls
  if (dur > contactMinSecs(env) && isNewish(cur.stage)) {
    stmts.push(env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?,?,?,?,?)").bind(b.lead_id, cur.stage, "contacted", `Call longer than ${contactMinSecs(env)} seconds (${mmss})`, "system"));
    stmts.push(env.DB.prepare("UPDATE leads SET stage = 'contacted', contacted = 1, stage_changed_at = datetime('now') WHERE id = ?").bind(b.lead_id));
  }
  await env.DB.batch(stmts);
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
.outs{display:flex;gap:8px;flex-wrap:wrap}.outs .btn{flex:1 1 130px}
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
${BNAV_CSS}
@media(max-width:850px){header{padding:12px 14px}h1{font-size:17px}main{grid-template-columns:minmax(0,1fr);padding:10px 14px 24px}}
</style></head><body>
<header><h1>Divine Detailers <b>dialer</b></h1>${nav("dialer", tc, true)}</header>
${bnav("dialer", tc, true)}
<main>
<div class="col">
<div id="setup" class="ban" hidden></div>
<div class="bar"><span id="st" class="pill">Loading</span><span id="hrs" class="note"></span><span style="flex:1"></span><button class="btn sm" id="vmb" type="button">Voicemails</button><button class="btn sm" id="scb" type="button">Edit scripts</button></div>
<div id="newb" class="newb" hidden></div>
<div id="lead" class="lead"></div>
<div id="ctl" class="ctl"></div>
<div id="kp" class="kp" hidden></div>
<div id="coach" class="panel" hidden><div class="bar"><h3 style="margin:0">Live coach</h3><span id="cst" class="note"></span></div><div id="cards" style="display:flex;flex-direction:column;gap:8px"></div><div id="trn" class="tr"></div></div>
<div id="after" class="panel" hidden>
<h3>How did it go?</h3>
<div class="outs" id="outs"></div>
<textarea id="nt" rows="2" placeholder="Add a note (saved on the lead)"></textarea>
<div class="bar"><button class="btn sm" id="ntb" type="button">Save note</button><button class="btn sm" id="mtb" type="button">Text: I missed you</button><span id="am" class="note"></span></div>
<div id="mt" hidden><textarea id="mtx" rows="4"></textarea><div class="bar" style="margin-top:6px"><button class="btn g sm" id="mts" type="button">Send text</button><span id="mtm" class="note"></span></div></div>
</div>
<div class="bar"><button class="btn" id="nxt" type="button" style="flex:1;min-height:52px">Next lead &rarr;</button></div>
<div class="panel"><div class="bar"><h3 style="margin:0">Script</h3><span style="flex:1"></span><div class="tabs" id="stabs"><button type="button" data-k="tint">Tint</button><button type="button" data-k="coating">Coating</button></div></div><div id="script" class="script"></div></div>
</div>
<div class="col q"><h3 style="margin:0;font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:#c3c8cf">Up next</h3><div id="q"></div></div>
</main>
<dialog id="vdlg"></dialog><dialog id="sdlg"></dialog>
<script src="/assets/twilio-voice.min.js"></script>
<script>
const $=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const el=id=>document.getElementById(id),ET='America/New_York';
let Q=[],ix=0,ST={tint:'',coating:'',missed:''},AU={},dev=null,call=null,tmr=null,t0=0,sid='',state='idle',muted=false,sk='tint',vmArm=null;
const etHour=()=>+new Date().toLocaleString('en-US',{timeZone:ET,hour:'numeric',hour12:false});
const inHours=()=>{const h=etHour()%24;return h>=8&&h<21};
const e164=p=>{const d=String(p||'').replace(/\\D/g,'');return d.length===10?'+1'+d:d.length===11&&d[0]==='1'?'+'+d:d?'+'+d:''};
const pretty=p=>{const d=String(p||'').replace(/\\D/g,'').slice(-10);return d.length===10?'('+d.slice(0,3)+') '+d.slice(3,6)+'-'+d.slice(6):(p||'')};
const svcOf=l=>/coat/i.test(String(l&&l.service||''))?'coating':'tint';
function fillT(t,l){const veh=[l.year,l.make,l.model].filter(Boolean).join(' '),first=String(l.name||'').trim().split(/\\s+/)[0],sv=svcOf(l);
  const v={first:first&&!/^\\+?[\\d\\s()-]+$/.test(first)?first:'there',vehicle:veh?'your '+veh:'your car',service:String(l.service||'').toLowerCase()||'detailing',service_name:sv==='coating'?'ceramic coating':'ceramic tint',price:l.value?'$'+Math.round(l.value):(sv==='coating'?'$599':'$349'),shop:'Divine Detailers',address:'5181 NW 74th Ave, Miami, FL 33166'};
  return String(t||'').replace(/\\{(\\w+)\\}/g,(m,k)=>v[k]===undefined?m:v[k])}
function ago(iso){const s=Math.max(0,(Date.now()-new Date(iso))/1000);if(s<60)return 'just now';if(s<3600)return Math.floor(s/60)+' min ago';if(s<86400)return Math.floor(s/3600)+' hr ago';return Math.floor(s/86400)+' days ago'}
function setSt(t,c){const s=el('st');s.textContent=t;s.className='pill'+(c?' '+c:'')}
function scriptHtml(t){return String(t||'').split('\\n').map(line=>{line=line.replace(/\\s+$/,'');if(!line)return '';if(/^# /.test(line))return '<h4>'+$(line.slice(2))+'</h4>';if(/^- /.test(line))return '<li>'+$(line.slice(2))+'</li>';return '<p>'+$(line)+'</p>'}).join('').replace(/(<li>.*?<\\/li>)+/g,m=>'<ul>'+m+'</ul>')}
function drawScript(){const l=Q[ix]||{};document.querySelectorAll('#stabs button').forEach(b=>b.classList.toggle('on',b.dataset.k===sk));el('script').innerHTML=scriptHtml(fillT(ST[sk],l))}
function drawLead(){const l=Q[ix];const box=el('lead');
  if(!l){box.innerHTML='<h2>'+(Q.length?'Queue finished':'No leads to call')+'</h2><p class="note">'+(Q.length?'Nice work. Reload to check for new leads.':'New and not-contacted leads from the last 14 days, and callbacks that are due, show up here.')+'</p>';el('ctl').innerHTML='';el('after').hidden=true;return}
  const car=[l.year,l.make,l.model].filter(Boolean).join(' ');
  const lines=String(l.message||'').split('\\n').map(x=>x.trim()).filter(x=>x&&!/^(form name|ad name|adset name|platform):/i.test(x)).slice(0,6);
  box.innerHTML='<div class="bar"><h2 style="flex:1">'+$(l.name||pretty(l.phone))+'</h2>'+(l.cb?'<span class="pill warn">Callback due</span>':'')+(l.fresh?'<span class="pill ok">New lead</span>':'')+'</div><div class="ph">'+$(pretty(l.phone))+'</div>'
   +'<div class="chips">'+(l.service?'<span class="chip hot">'+$(l.service)+'</span>':'')+(car?'<span class="chip">'+$(car)+'</span>':'')+(l.value?'<span class="chip">$'+Math.round(l.value)+'</span>':'')+'<span class="chip">came in '+ago(l.created_at)+'</span>'+(l.tries24?'<span class="chip">'+l.tries24+' call'+(l.tries24===1?'':'s')+' today</span>':'')+(l.utm_medium==='paid_social'?'<span class="chip">Facebook</span>':'')+'</div>'
   +(lines.length?'<div class="kv">'+lines.map(x=>'<span>'+$(x)+'</span>').join('')+'</div>':'')
   +((l.texts&&l.texts.length)||(l.history&&l.history.length)?'<div class="hist">'+(l.texts||[]).map(t=>'<span>'+(t.direction==='in'?'They texted: ':'You texted: ')+$(t.body)+'</span>').join('')+(l.history||[]).slice(0,3).map(h=>'<span>'+$(h.reason)+'</span>').join('')+'</div>':'')
   +'<div class="bar"><a class="btn sm" href="/admin/pipeline#id='+l.id+'" style="text-decoration:none;display:inline-flex;align-items:center">Open lead / book</a></div>';
  sk=svcOf(l);drawScript();drawCtl()}
function drawCtl(){const l=Q[ix],c=el('ctl'),kp=el('kp');if(!l){return}
  const noDev=!dev;
  if(state==='idle'||state==='ended'){c.innerHTML='<button class="btn g call" id="cb" type="button"'+(noDev||!inHours()?' disabled':'')+'>'+(state==='ended'?'Call again':'Call '+$(pretty(l.phone)))+'</button>';kp.hidden=true;el('hrs').textContent=inHours()?'':'Calling hours are 8 AM to 9 PM Eastern.';
    const b=el('cb');if(b)b.onclick=dial;return}
  const live=state==='live';
  c.innerHTML='<span class="timer" id="tm">'+(live?'0:00':'...')+'</span><button class="btn r call" id="hb" type="button">Hang up</button><button class="btn'+(muted?' on':'')+'" id="mb" type="button"'+(live?'':' disabled')+'>'+(muted?'Unmute':'Mute')+'</button><button class="btn" id="kb" type="button"'+(live?'':' disabled')+'>Keypad</button>'
   +['tint','coating'].map(k=>'<button class="btn sm'+(svcOf(l)===k?' g':'')+'" data-vm="'+k+'" type="button"'+(live&&AU[k]&&AU[k].has?'':' disabled')+'>'+(vmArm===k?'Tap again to drop':'Drop '+k+' voicemail')+'</button>').join('');
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
  call.on('accept',()=>{state='live';t0=Date.now();sid=(call.parameters&&call.parameters.CallSid)||'';setSt('Connected','ok');coachStart(sid);clearInterval(tmr);tmr=setInterval(tick,500);drawCtl()});
  call.on('disconnect',()=>endCall());call.on('cancel',()=>endCall());call.on('reject',()=>endCall());
  call.on('error',e=>setSt('Call error: '+((e&&e.message)||e),'bad'))}
async function endCall(){if(state==='ended'||state==='idle')return;const l=Q[ix];clearInterval(tmr);const dur=t0?Math.round((Date.now()-t0)/1000):0;state='ended';call=null;t0=0;vmArm=null;setSt(dur?'Call ended':'Not connected',dur?'':'warn');
  el('after').hidden=false;el('am').textContent='';drawOuts();drawCtl();bannerDraw();
  if(l){l.tries24=(l.tries24||0)+1;try{await fetch('/admin/dialer/log',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lead_id:l.id,sid:sid,duration:dur})})}catch(_){}}}
async function vmDrop(k){const l=Q[ix];if(state!=='live'||!sid||!l)return;if(vmArm!==k){vmArm=k;drawCtl();setTimeout(()=>{if(vmArm===k){vmArm=null;drawCtl()}},3000);return}vmArm=null;
  const r=await fetch('/admin/dialer/vmdrop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sid:sid,kind:k,lead_id:l.id})});const j=await r.json().catch(()=>({}));setSt(j.success?'Voicemail dropped':(j.message||'Could not drop it'),j.success?'ok':'bad');drawCtl()}
const OUTS=[['Answered','Answered'],['No answer','No answer'],['Left a voicemail','Left voicemail'],['Wrong number','Wrong number'],['cb','Call back tomorrow']];
function drawOuts(){el('outs').innerHTML=OUTS.map(o=>'<button class="btn" type="button" data-o="'+$(o[0])+'">'+$(o[1])+'</button>').join('');el('mt').hidden=true;
  el('outs').querySelectorAll('button').forEach(b=>b.onclick=async()=>{const l=Q[ix];if(!l)return;b.disabled=true;
    if(b.dataset.o==='cb'){const d=new Date(Date.now()+864e5).toLocaleDateString('en-CA',{timeZone:ET});await fetch('/admin/stage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:l.id,follow_date:d})})}
    else await fetch('/admin/outcome',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:l.id,outcome:b.dataset.o})});
    el('am').textContent='Saved: '+b.textContent;b.classList.add('on')})}
el('ntb').onclick=async()=>{const l=Q[ix],t=el('nt').value.trim();if(!l||!t)return;await fetch('/admin/touch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:l.id,label:'Call note: '+t.slice(0,300)})});el('nt').value='';el('am').textContent='Note saved.'};
el('mtb').onclick=()=>{const l=Q[ix];if(!l)return;el('mtx').value=fillT(ST.missed,l);el('mt').hidden=false;el('mtm').textContent=''};
el('mts').onclick=async()=>{const l=Q[ix],b=el('mtx').value.trim();if(!l||!b)return;el('mts').disabled=true;const r=await fetch('/admin/msg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:l.id,body:b})});const j=await r.json().catch(()=>({}));el('mts').disabled=false;el('mtm').textContent=j.success?'Text sent.':(j.message||'Could not send.');el('mtm').className=j.success?'note okm':'note'};
function next(){if(state==='live'||state==='connecting')return;state='idle';ix=Math.min(ix+1,Q.length);el('after').hidden=true;el('nt').value='';setSt(dev?'Ready':'Not set up',dev?'ok':'bad');drawLead();drawQ();bannerDraw();window.scrollTo({top:0})}
el('nxt').onclick=next;
function drawQ(){el('q').innerHTML=Q.map((l,i)=>i<ix?'':'<button class="it'+(i===ix?' cur':'')+(l.fresh&&i!==ix?' fresh':'')+'" data-i="'+i+'" type="button"><b>'+(l.fresh?'<span class="chip new">NEW</span> ':'')+$(l.name||pretty(l.phone))+'</b><small>'+$([l.service,[l.year,l.make,l.model].filter(Boolean).join(' ')].filter(Boolean).join(' · '))+' · '+ago(l.created_at)+(l.tries24?' · '+l.tries24+' tries':'')+'</small></button>').join('')||'<p class="note">Nothing queued.</p>'}
el('q').addEventListener('click',e=>{const b=e.target.closest('[data-i]');if(!b||state==='live'||state==='connecting')return;ix=+b.dataset.i;state='idle';el('after').hidden=true;drawLead();drawQ()});
el('stabs').addEventListener('click',e=>{const b=e.target.closest('[data-k]');if(b){sk=b.dataset.k;drawScript()}});
// scripts and the missed-you text
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
let cws=null,coachOn=false,lastCard={};
async function coachStatus(){try{const j=await (await fetch('/admin/coach/status')).json();coachOn=!!j.enabled}catch(_){}}
function coachStart(sid){coachStop();if(!coachOn||!sid)return;const p=el('coach');p.hidden=false;el('trn').innerHTML='';el('cards').innerHTML='';lastCard={};el('cst').textContent='Connecting...';
  try{cws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/admin/coach/ws?sid='+sid)}catch(_){el('cst').textContent='Transcript unavailable';return}
  cws.onopen=()=>{el('cst').textContent='Listening'};cws.onclose=()=>{if(el('cst').textContent==='Listening')el('cst').textContent='Transcript stopped'};
  cws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch(_){return}coachMsg(m)}}
function coachStop(){if(cws){try{cws.close()}catch(_){}cws=null}}
function coachMsg(m){if(m.type==='hello'){(m.turns||[]).forEach(t=>addLine(t.who,t.text,true));return}
  if(m.type==='live'){el('cst').textContent='Listening';return}
  if(m.type==='transcript'){addLine(m.who,m.text,m.final);if(m.who==='lead')objCheck(m.text);return}
  if(m.type==='error'){el('cst').textContent=m.message;return}
  if(m.type==='ended'){el('cst').textContent='Call ended'}}
function addLine(who,text,final){const box=el('trn');let ln=box.querySelector('.ln.partial.w-'+who);if(!ln){ln=document.createElement('div');box.appendChild(ln)}ln.className='ln w-'+who+(final?'':' partial');ln.innerHTML='<b>'+(who==='lead'?'Lead':'You')+':</b> '+$(text);box.scrollTop=box.scrollHeight}
function objCheck(text){for(const o of OBJ){const es=o.es.test(text),en=o.en.test(text);if(!es&&!en)continue;const now=Date.now();if(lastCard[o.id]&&now-lastCard[o.id]<20000)continue;lastCard[o.id]=now;showCard(o,es&&!en);break}}
function showCard(o,es){const c=es?o.esc:o.enc,d=document.createElement('div');d.className='card2';
  d.innerHTML='<div class="bar"><span class="pill warn">'+$(o.label)+'</span></div><div class="aca"><div><span>ACKNOWLEDGE</span><p>'+$(c[0])+'</p></div><div><span>COMMENT</span><p>'+$(c[1])+'</p></div><div><span>ASK</span><p class="ask">'+$(c[2])+'</p></div></div>';
  const box=el('cards');box.insertBefore(d,box.firstChild);while(box.children.length>2)box.removeChild(box.lastChild);setTimeout(()=>{if(d.parentNode)d.parentNode.removeChild(d)},60000)}
let known=new Set(),defTitle=document.title;
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
  await loadAudio();await coachStatus();
  try{const q=await (await fetch('/admin/dialer/queue')).json();Q=q.leads||[]}catch(_){}
  ix=0;Q.forEach(l=>known.add(l.id));drawLead();drawQ();drawScript();setInterval(poll,10000);el('hrs').textContent=inHours()?'':'Calling hours are 8 AM to 9 PM Eastern.';
  await initDev()}
init();
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// ---- Live call coach, phase 1: Twilio sends both sides of a dialer call here (one Durable Object per call), each side is transcribed live by Deepgram,
// and the words are pushed to the Dial page over a WebSocket. The audio never goes through the browser. Needs DEEPGRAM_API_KEY.
const coachEnabled = env => !!(env.COACH && env.DEEPGRAM_API_KEY);
async function coachSig(env, sid) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(env.TWILIO_TOKEN || "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("stream:" + sid)))].map(x => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
const DG_KEYTERMS = ["ceramic coating", "ceramic tint", "paint correction", "paint protection film", "PPF", "Divine Detailers", "window tint", "clear coat", "XPEL", "Llumar", "3M", "Tesla", "Mercedes", "BMW", "Porsche"];
const ulaw = b => { b = ~b & 0xff; const s = (((b & 0x0f) << 3) + 0x84) << ((b >> 4) & 7); return (b & 0x80) ? -(s - 0x84) : s - 0x84; };
export class CallRoom {
  constructor(state, env) {
    this.env = env; this.browsers = new Set(); this.turns = []; this.dg = {}; this.pending = { inbound: [], outbound: [] };
    this.sid = ""; this.leadId = null; this.t0 = Date.now(); this.ended = false;
    this.sig = { talk: { rep: 0, lead: 0 }, words: { rep: 0, lead: 0 }, leadQuestions: 0, firstPriceSecs: null, turns: 0 };
    this.acc = { inbound: { sum: 0, n: 0 }, outbound: { sum: 0, n: 0 } }; this.energy = { rep: [], lead: [] };
  }
  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const path = new URL(request.url).pathname;
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    server.accept();
    if (path.startsWith("/api/twilio/stream/")) { this.sid = path.split("/")[4] || ""; this.attachTwilio(server); } else this.attachBrowser(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  broadcast(msg) { const t = JSON.stringify(msg); for (const b of this.browsers) { try { b.send(t); } catch (e) { this.browsers.delete(b); } } }
  attachBrowser(ws) {
    this.browsers.add(ws);
    try { ws.send(JSON.stringify({ type: "hello", turns: this.turns.slice(-40), live: !this.ended && !!this.twilioWs })); } catch (e) { /* closed */ }
    ws.addEventListener("close", () => this.browsers.delete(ws)); ws.addEventListener("error", () => this.browsers.delete(ws));
  }
  attachTwilio(ws) {
    this.twilioWs = ws;
    ws.addEventListener("message", ev => { try { this.onTwilio(JSON.parse(ev.data)); } catch (e) { /* ignore bad frame */ } });
    ws.addEventListener("close", () => this.finish()); ws.addEventListener("error", () => this.finish());
  }
  onTwilio(m) {
    if (m.event === "start") { const cp = (m.start && m.start.customParameters) || {}; this.leadId = Number(cp.lead) || this.leadId; this.t0 = Date.now(); this.broadcast({ type: "live" }); return; }
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
  async openDg(track) {
    const slot = this.dg[track] = { ready: false, ws: null };
    try {
      const qs = new URLSearchParams({ model: "nova-3", language: this.env.DEEPGRAM_LANGUAGE || "multi", encoding: "mulaw", sample_rate: "8000", channels: "1", interim_results: "true", endpointing: "300", utterance_end_ms: "1000", smart_format: "true", punctuate: "true" });
      for (const k of DG_KEYTERMS) qs.append("keyterm", k);
      const resp = await fetch(`${this.env.DEEPGRAM_BASE || "https://api.deepgram.com"}/v1/listen?${qs}`, { headers: { Upgrade: "websocket", Authorization: `Token ${this.env.DEEPGRAM_API_KEY}` } });
      const ws = resp.webSocket;
      if (!ws) { this.broadcast({ type: "error", message: "The transcription service refused the connection." }); return; }
      ws.accept(); slot.ws = ws; slot.ready = true;
      ws.addEventListener("message", ev => { try { this.onDg(track, JSON.parse(typeof ev.data === "string" ? ev.data : "")); } catch (e) { /* not json */ } });
      ws.addEventListener("close", () => { slot.ready = false; });
      for (const f of this.pending[track].splice(0)) ws.send(f);
      slot.keep = setInterval(() => { try { if (slot.ready) ws.send(JSON.stringify({ type: "KeepAlive" })); } catch (e) { /* closed */ } }, 8000);
    } catch (e) { this.broadcast({ type: "error", message: "Could not reach the transcription service." }); }
  }
  onDg(track, d) {
    if (d.type !== "Results") return;
    const alt = d.channel && d.channel.alternatives && d.channel.alternatives[0]; const text = alt && String(alt.transcript || "").trim();
    if (!text) return;
    const who = track === "outbound" ? "lead" : "rep";
    const final = !!d.is_final, at = Math.round((Date.now() - this.t0) / 1000);
    this.broadcast({ type: "transcript", who, text, final, end: !!d.speech_final, at });
    if (!final) return;
    this.turns.push({ who, text, at });
    this.sig.talk[who] += Number(d.duration) || 0; this.sig.words[who] += text.split(/\s+/).length; this.sig.turns++;
    if (who === "lead" && /\?/.test(text)) this.sig.leadQuestions++;
    if (this.sig.firstPriceSecs == null && /\$|price|how much|cost|precio|cu[aá]nto/i.test(text)) this.sig.firstPriceSecs = at;
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
<section><div class="mh"><h2 id="mt"></h2><div class="nv"><button id="pv" type="button" aria-label="Previous month">&lsaquo;</button><button id="tdy" type="button">Today</button><button id="nx" type="button" aria-label="Next month">&rsaquo;</button></div></div>
<div class="dow"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div><div class="grid" id="g"></div></section>
<section class="side"><div><h2 id="dh"></h2><div id="dl" style="display:flex;flex-direction:column;gap:8px;margin-top:8px"></div></div><div><h2>Coming up (next 14 days)</h2><div id="up" style="display:flex;flex-direction:column;gap:8px;margin-top:8px"></div></div></section>
</main>
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
      if (p === "/" || p === "/today" || p === "/admin/today") return adminRoute("/admin/today", request, env);
      if (p === "/speed" || p === "/admin/speed") return adminRoute("/admin/speed", request, env);
      if (p === "/rate" || p === "/admin/rate") return adminRoute("/admin/rate", request, env);
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
      if (p === "/admin/stage" || p === "/admin/coach/ws" || p === "/admin/coach/status" || p === "/admin/dialer/token" || p === "/admin/dialer/queue" || p === "/admin/dialer/log" || p === "/admin/dialer/vmdrop" || p === "/admin/dialer/audio" || p === "/admin/dialer/audio/play" || p === "/admin/dialer/settings" || p === "/admin/automations/data" || p === "/admin/campaigns/data" || p === "/admin/campaigns/preview" || p === "/admin/campaigns/mark-meta" || p === "/admin/campaign" || p === "/admin/campaign/test" || p === "/admin/campaign/cancel" || p === "/admin/calendar/urable" || p === "/admin/automation" || p === "/admin/automation/toggle" || p === "/admin/automation/delete" || p === "/admin/threads" || p === "/admin/thread" || p === "/admin/unread" || p === "/admin/msg" || p === "/admin/book" || p === "/admin/leadinfo" || p === "/admin/lead" || p === "/admin/add" || p === "/admin/touch" || p === "/admin/appt" || p === "/admin/delete" || p === "/admin/queue" || p === "/admin/queue/start" || p === "/admin/queue/stop" || p === "/admin/dial" || p === "/admin/outcome" || p === "/admin/callrailtest" || p === "/admin/verifyshop" || p === "/admin/purge" || p === "/admin/calls" || p === "/admin/adspend" || p === "/admin/jobcost" || p === "/admin/demo" || p === "/admin/testalert") return adminRoute(p, request, env);
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
    if (p === "/api/twilio/voice" || p === "/api/twilio/voice/recording") {
      if (request.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);
      try { return p === "/api/twilio/voice" ? await handleVoice(request, env) : await handleVoiceRecording(request, env); }
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
  const { results: leads } = await env.DB.prepare("SELECT id,created_at,type,name,phone,service,make,year,model,answered,stage,stage_changed_at,value,gclid,gbraid,wbraid,utm_medium,utm_source,utm_campaign,utm_term,referrer FROM leads WHERE type != 'newsletter' AND COALESCE(ip,'') != 'demo' ORDER BY created_at DESC, id DESC LIMIT 3000").all();
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
      service: l.service || "Not set", stage: l.stage, h: t.h, channel: l.utm_medium === "paid_social" ? "meta" : so.ad ? "google" : "", srckey: so.ad ? (l.utm_medium === "paid_social" ? "Meta Ads" : "Google Ads") + (l.utm_campaign ? " \u00b7 " + l.utm_campaign : "") : so.label,
      lost: l.stage === "lost" ? (lostLog && lostLog.reason && lostLog.reason !== "Moved" ? lostLog.reason : "No reason logged") : "",
      booked_days: bookedLog ? Math.max(0, (ms(bookedLog.at) - ms(l.created_at)) / 864e5) : null, qv: l.stage === "quoted" ? (l.value || 0) : 0,
      outs: gl.filter(g => RESULT.test(g.reason || "")).map(g => ({ h: etParts(g.at).h, ok: /answered/i.test(g.reason || "") })),
      attempts: gl.filter(g => ATTEMPT.test(g.reason || "")).length, to_reach: reachedLog ? Math.max(1, gl.slice(0, gl.indexOf(reachedLog) + 1).filter(g => ATTEMPT.test(g.reason || "")).length) : null, missed: gl.filter(g => /^agent missed the auto-dial/i.test(g.reason || "")).length, unrecorded: Math.max(0, gl.filter(g => /^called$/i.test(g.reason || "")).length - Math.max(0, results.length - gl.filter(g => /^called via callrail/i.test(g.reason || "")).length)), reached: !!reachedLog, reached_by: reachedLog ? reachedLog.by_user || "" : "", results,
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
  '<div class="kpi"><b>'+(calledF.length?(calledF.reduce((a,r)=>a+Math.max(1,r.attempts),0)/calledF.length).toFixed(1):'-')+'</b><span>Calls per form lead</span></div>'+
  '<div class="kpi '+(L.reduce((a,r)=>a+(r.missed||0),0)?'r':'')+'"><b>'+L.reduce((a,r)=>a+(r.missed||0),0)+'</b><span>Auto-dials the agent missed (see Missed dials)</span></div>';
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
async function missedPage(env, user) {
  await ensureTable(env.DB);
  const tc = await todayCount(env);
  const miss = (await env.DB.prepare(`SELECT s.lead_id, s.at miss_at, s.by_user, l.name, l.phone, l.service, l.stage,
      (SELECT MIN(x.at) FROM stage_log x WHERE x.lead_id = s.lead_id AND x.at > s.at AND (x.reason LIKE 'Called%' OR x.reason LIKE 'Call result:%' OR x.reason LIKE 'Left a voicemail%' OR x.reason LIKE 'Spoke to the customer%')) called_at
    FROM stage_log s JOIN leads l ON l.id = s.lead_id
    WHERE s.reason LIKE 'Agent missed the auto-dial%' AND COALESCE(l.ip,'') != 'demo' ORDER BY s.at DESC LIMIT 200`).all()).results || [];
  const tot = (await env.DB.prepare("SELECT COUNT(*) n FROM dial_log d JOIN leads l ON l.id = d.lead_id WHERE d.source = 'auto' AND COALESCE(l.ip,'') != 'demo'").first() || {}).n || 0;
  const ms = t => Date.parse(String(t).replace(" ", "T") + "Z");
  const mins = r => r.called_at ? Math.max(0, Math.round((ms(r.called_at) - ms(r.miss_at)) / 60000)) : null;
  const waiting = miss.filter(r => !r.called_at), later = miss.filter(r => r.called_at);
  const lag = later.map(mins).sort((a, b) => a - b), med = lag.length ? lag[Math.floor(lag.length / 2)] : null;
  const row = r => `<tr><td><a href="/admin/pipeline#id=${r.lead_id}">${esc(r.name || prettyPhone(r.phone))}</a><br><span class="note">${esc(prettyPhone(r.phone))}${r.service ? " &middot; " + esc(r.service) : ""}</span></td><td>${esc(when(r.miss_at).abs)}<br><span class="note">${esc(r.by_user || "")}</span></td><td>${r.called_at ? "Called " + mins(r) + " min later" : '<b style="color:#ff6b6b">Not called yet</b>'}</td><td>${esc(stageNameOf(r.stage))}</td></tr>`;
  const stageNameOf = k => (STAGES.find(x => x[0] === k) || [k, k])[1];
  const tbl = rs => rs.length ? `<div class="tbw"><table class="tb"><tr><th>Lead</th><th>Missed at</th><th>What happened next</th><th>Stage</th></tr>${rs.map(row).join("")}</table></div>` : '<p class="note">Nothing here.</p>';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Missed dials | Divine Detailers</title>
<style>
*{box-sizing:border-box}body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#07090c;color:#e8eaed}
header{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #1b1f25}
h1{font-size:19px;margin:0}h1 b{color:#32cd32}.navtabs{display:flex;gap:6px;flex-wrap:wrap}.navtabs a{color:#aab0b9;text-decoration:none;padding:8px 14px;border-radius:999px;border:1px solid #232932}.navtabs a.on{background:#32cd32;border-color:#32cd32;color:#04120a;font-weight:700}
main{max-width:1000px;margin:0 auto;padding:16px 22px 40px;display:flex;flex-direction:column;gap:18px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.kpi{background:#0d1116;border:1px solid #1d2229;border-radius:14px;padding:14px}.kpi b{display:block;font-size:26px;line-height:1.15}.kpi span{color:#8a9099;font-size:12.5px}.kpi.g b{color:#32cd32}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:#c3c8cf;margin:6px 0 0}.note{color:#7c838d;font-size:12.5px}
.tbw{overflow-x:auto;background:#0d1116;border:1px solid #1d2229;border-radius:14px}.tb{width:100%;border-collapse:collapse}.tb th,.tb td{text-align:left;padding:10px 12px;border-bottom:1px solid #1b1f25;vertical-align:top}.tb th{color:#8a9099;font-size:12px;text-transform:uppercase;letter-spacing:.6px}.tb a{color:#32cd32;text-decoration:none;font-weight:600}
${BNAV_CSS}
@media(max-width:700px){header{padding:12px 14px}h1{font-size:17px}main{padding:8px 14px 20px}}
</style></head><body>
<header><h1>Divine Detailers <b>missed dials</b></h1>${nav("missed", tc, true)}</header>
${bnav("missed", tc, true)}
<main>
<div class="kpis"><div class="kpi"><b>${tot}</b><span>auto-dials placed</span></div><div class="kpi ${miss.length ? "" : "g"}"><b>${miss.length}</b><span>missed by the agent${tot ? " (" + Math.round(miss.length * 100 / tot) + "%)" : ""}</span></div><div class="kpi ${waiting.length ? "" : "g"}"><b>${waiting.length}</b><span>still not called</span></div><div class="kpi"><b>${med === null ? "-" : med + " min"}</b><span>median time to call back</span></div></div>
<h2>Missed and still not called</h2>${tbl(waiting)}
<h2>Missed, then called later</h2>${tbl(later)}
<p class="note">A dial is missed when the agent's phone was rung and nobody answered or pressed 1, so the lead was never called. The lead stays in the normal pipeline so it can still be worked. Only the owner login sees this page.</p>
</main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

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
 document.getElementById('k').innerHTML='<div class="kpi g"><b>'+(tot.n?pc(tot.rc,tot.n)+'%':'-')+'</b><span>Contact rate (reached &divide; called)</span></div><div class="kpi"><b>'+tot.rc+' of '+tot.n+'</b><span>Form leads reached</span></div><div class="kpi"><b>'+(tot.rc?(L.filter(r=>r.reached).reduce((a,r)=>a+(r.to_reach||1),0)/tot.rc).toFixed(1):'-')+'</b><span>Avg calls per contact (calls it took to reach a lead)</span></div><div class="kpi g"><b>'+(tot.n?pc(tot.bk,tot.n)+'%':'-')+'</b><span>Booked rate (booked &divide; called)</span></div><div class="kpi"><b>'+tot.bk+'</b><span>Booked jobs ('+money(tot.val)+')</span></div>'+'<div class="kpi"><b>'+pick().reduce((a,r)=>a+(r.missed||0),0)+'</b><span>Auto-dials the agent missed (never reached the lead)</span></div><div class="kpi '+(pick().reduce((a,r)=>a+(r.unrecorded||0),0)?'r':'')+'"><b>'+pick().reduce((a,r)=>a+(r.unrecorded||0),0)+'</b><span>Manual calls with no answer recorded (not counted above)</span></div>';
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
  const spend = { google: {}, meta: {} };
  for (const r of (await env.DB.prepare("SELECT month, channel, amount FROM ad_spend2").all()).results) (spend[r.channel] = spend[r.channel] || {})[r.month] = r.amount;
  const costs = Object.fromEntries((await env.DB.prepare("SELECT service, cost FROM job_costs").all()).results.map(r => [r.service, r.cost]));
  const payload = JSON.stringify({ rows, today: todayStr(), spend, costs, services: ["Window Tint", "PPF / Clear Bra", "Ceramic Coating", "Paint Correction", "Vinyl Wraps", "Exterior Detailing", "Other"] }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${PWA_HEAD}<title>Insights | Divine Detailers</title>
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
 document.getElementById('bt').innerHTML=btItems.length?'':'<div class="note" style="padding:14px">No call results logged in this range yet. Answer the popup after tapping Call and this fills in.</div>';if(btItems.length)bars('bt',btItems)}
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

async function adminRoute(p, request, env) {
  const a = await authed(request, env);
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
  if (p === "/admin/calendar/urable" && request.method === "GET") return a === OWNER ? json({ success: true, ...(await urableCalendar(env)) }) : json({ success: false }, 403);
  if (p === "/admin/automation" && request.method === "POST") { if (a !== OWNER) return json({ success: false }, 403); return saveAutomation(env, await request.json().catch(() => ({}))); }
  if (p === "/admin/coach/status") return a === OWNER ? json({ enabled: coachEnabled(env) }) : json({ success: false }, 403);
  if (p === "/admin/coach/ws") {
    const sid = new URL(request.url).searchParams.get("sid") || "";
    if (a !== OWNER) return new Response("Forbidden", { status: 403 });
    if (!coachEnabled(env) || request.headers.get("upgrade") !== "websocket" || !/^CA[0-9a-f]{32}$/.test(sid)) return new Response("Not available", { status: 404 });
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
    if (p === "/admin/dialer/queue" && request.method === "GET") return dialerQueue(env);
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
  if (p === "/admin/unread" && request.method === "GET") { await ensureTable(env.DB); return json({ n: ((await env.DB.prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'in' AND is_read = 0").first()) || {}).n || 0 }); }
  if (p === "/admin/threads" && request.method === "GET") return messageThreads(env, new URL(request.url));
  if (p === "/admin/thread" && request.method === "GET") return messageThread(env, new URL(request.url));
  if (p.startsWith("/admin/send/")) { const sid = Number(p.slice(12)); return Number.isInteger(sid) && sid > 0 ? sendPage(env, sid, new URL(request.url).searchParams.get("n"), a) : new Response("Not found", { status: 404 }); }
  if (p.startsWith("/admin/go/")) { const gid = Number(p.slice(10)); return Number.isInteger(gid) && gid > 0 ? goPage(env, gid, a) : new Response("Not found", { status: 404 }); }
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
  if (p === "/admin/missed") return a === OWNER ? missedPage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/rate") return a === OWNER ? ratePage(env, a) : new Response(null, { status: 302, headers: { location: "/admin/today" } });
  if (p === "/admin/demo" && request.method === "POST") return demoRoute(request, env);
  if (p === "/admin/testalert" && request.method === "POST") return testAlert(request, env);
  const user = typeof a === "string" ? a : "";
  if (p === "/admin/calls") { const id = Number(new URL(request.url).searchParams.get("id")); return Number.isInteger(id) ? json({ success: true, notes: await callNotes(env, id), recordings: await callRecordings(env, id), attempts: await leadAttempts(env, id), history: await leadHistory(env, id) }) : json({ success: false }, 400); }
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
    const ok = OUTCOMES.find(o => o[0] === b.outcome);
    if (!Number.isInteger(b.id) || !ok) return json({ success: false }, 400);
    const cur = await env.DB.prepare("SELECT stage FROM leads WHERE id = ?").bind(b.id).first();
    if (!cur) return json({ success: false }, 404);
    // only Answered moves a lead (to Contacted); the other answers are just recorded
    const tgt = isNewish(cur.stage) && b.outcome === "Answered" ? "contacted" : cur.stage;
    const st2 = [env.DB.prepare("INSERT INTO stage_log (lead_id, from_stage, to_stage, reason, by_user) VALUES (?,?,?,?,?)").bind(b.id, cur.stage, tgt, "Call result: " + b.outcome, user)];
    if (tgt !== cur.stage) st2.push(env.DB.prepare("UPDATE leads SET stage = ?, contacted = ?, stage_changed_at = datetime('now') WHERE id = ?").bind(tgt, tgt === "contacted" ? 1 : 0, b.id));
    await env.DB.batch(st2);
    return json({ success: true });
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
