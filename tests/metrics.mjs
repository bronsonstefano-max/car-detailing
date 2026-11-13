import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const D = process.env.D, PORT = process.env.PORT, B = `http://localhost:${PORT}`;
const cookie = readFileSync(join(D, "cj"), "utf8").split("\n").map(l => l.replace("#HttpOnly_", "").split("\t")).filter(a => a.length >= 7).map(a => `${a[5]}=${a[6]}`).join("; ");
const get = async p => (await fetch(B + p, { headers: { cookie } })).json();
const post = async (p, body) => (await fetch(B + p, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const T = `http://127.0.0.1:${PORT}`; // Twilio calls the public host, not the CRM host
const twilio = async (path, f) => { const url = T + path; let data = url; for (const k of Object.keys(f).sort()) data += k + f[k]; return (await fetch(url, { method: "POST", headers: { "x-twilio-signature": createHmac("sha1", "tok").update(data).digest("base64"), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(f) })).status; };
// find the database file that has the leads table
const files = []; (function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith(".sqlite") && files.push(p); } })(join(D, "state"));
const py = `
import sqlite3,sys,json
for f in ${JSON.stringify(files)}:
    c=sqlite3.connect(f)
    try: c.execute("SELECT 1 FROM stage_log LIMIT 1")
    except Exception: continue
    for sql in json.loads(sys.stdin.read()): c.execute(sql)
    c.commit(); break
`;
const sql = list => execFileSync("python3", ["-c", py], { input: JSON.stringify(list) });
const ts = minAgo => `datetime('now','-${minAgo} minutes')`;
const month = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }).slice(0, 7); // Eastern days, like the scorecard
// ---- the known data. minutes are minutes ago.
const S = [];
const lead = (id, name, mins, extra = "") => S.push(`INSERT INTO leads (id,type,name,phone,service,stage,value,created_at,contacted${extra ? "," + extra[0] : ""}) VALUES (${id},'quote','${name}','30555501${id}0','Window Tint','new',0,${ts(mins)},0${extra ? "," + extra[1] : ""})`);
lead(101, "A Meta booked", 300, ["utm_medium", "'paid_social'"]);
lead(102, "B Meta talked", 180, ["utm_medium", "'paid_social'"]);
lead(103, "C Google never called", 120, ["gclid", "'x'"]);
lead(104, "D Organic wrong number", 60);
const call = (lead, minsAgo, dur, tw, talk, by = "bronson") => { // one dial: a log line + a call row
  const m = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}`;
  S.push(`INSERT INTO stage_log (lead_id,from_stage,to_stage,reason,by_user,at) VALUES (${lead},'new','new','Called (in-app dialer): ${dur ? m : "not connected"}','${by}',${ts(minsAgo)})`);
  S.push(`INSERT INTO dial_calls (lead_id,call_sid,duration,by_user,started_at,tw_status,talk,src,logged) VALUES (${lead},'CA${String(lead).padStart(3, "0")}${String(minsAgo).padStart(3, "0")}${"0".repeat(26)}',${dur},'${by}',${ts(minsAgo)},'${tw}',${talk},'twilio',2)`);
};
const res = (lead, minsAgo, r) => S.push(`INSERT INTO stage_log (lead_id,from_stage,to_stage,reason,by_user,at) VALUES (${lead},'new','new','Call result: ${r}','bronson',${ts(minsAgo)})`);
// A: call at lead+2min (no answer), then at lead+60min a 5 minute conversation that booked $800. One text before booking.
call(101, 298, 0, "no-answer", 0); res(101, 298, "No answer");
S.push(`INSERT INTO messages (lead_id,phone,direction,body,status,sid,by_user,auto,is_read) VALUES (101,'3055550101','out','hi','sent','','bronson',0,1)`);
S.push(`UPDATE messages SET at=${ts(280)} WHERE lead_id=101`);
call(101, 240, 300, "completed", 300); res(101, 240, "Booked");
S.push(`UPDATE leads SET stage='booked',value=800,appt_at='2030-01-01T10:00',contacted=1 WHERE id=101`);
S.push(`INSERT INTO stage_log (lead_id,from_stage,to_stage,reason,by_user,at) VALUES (101,'new','booked','Booked (appointment)','bronson',${ts(239)})`);
// B: first call 10 minutes after the form, a 200 second conversation, no booking yet
call(102, 170, 200, "completed", 200); res(102, 170, "Answered");
// C: never called. D: called 4 minutes after the form, 0 seconds, wrong number
call(104, 56, 0, "no-answer", 0); res(104, 56, "Wrong number");
S.push(`INSERT INTO ad_spend2 (month,channel,amount) VALUES ('${month}','meta',3000) ON CONFLICT(month,channel) DO UPDATE SET amount=3000`);
sql(S);

let fails = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got ${JSON.stringify(got)}${ok ? "" : ", want " + JSON.stringify(want)}`); };
const near = (name, got, want, tol = 0.06) => { const ok = got != null && Math.abs(got - want) <= tol; if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got ${got}${ok ? "" : ", want about " + want}`); };

// ---- the numbers worked out by hand
const sc = await get("/admin/scorecard?days=30");
const a = sc.activity, c = sc.cohort, q = sc.quality;
eq("calls placed in period", a.dials, 4);
eq("picked up (Twilio completed with talk time)", a.picked_up, 2);
eq("pick-up rate %", a.pickup_rate, 50);
eq("conversations (results that count)", a.conversations, 2);
eq("conversation rate % of calls", a.conversation_rate, 50);
eq("average talk seconds", a.avg_talk_secs, 250);
eq("bookings in period", a.bookings, 1);
eq("calls per booking (period)", a.dials_per_booking, 4);
eq("leads in range", c.leads, 4);
eq("leads called", c.called, 3);
eq("leads never called", c.never_called, 1);
eq("median speed to lead (sec)", c.speed_median_secs, 240);
eq("called within 5 min %", c.within_5min, 50);
eq("leads reached", c.reached, 2);
near("contact rate % (2 of 3 called)", c.contact_rate, 66.7);
near("calls per called lead", c.dials_per_lead, 1.3);
eq("calls to reach (A took 2, B took 1)", c.dials_to_reach, 1.5);
eq("booked leads", c.booked, 1);
eq("booked rate %", c.booked_rate, 25);
eq("revenue", c.revenue, 800);
eq("calls per booking (cohort)", c.dials_per_booking, 2);
eq("touchpoints per booking (2 calls + 1 text)", c.touchpoints_per_booking, 3);
// ad spend: the month's 3000 spread over the days of the last 30 that fall in this month
const today = new Date(); const dim = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
const etDay = d => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const inMonth = Array.from({ length: 30 }, (_, i) => etDay(new Date(Date.now() - i * 864e5))).filter(d => d.slice(0, 7) === month).length;
const spend = 3000 * Math.min(inMonth, dim) / dim;
near("meta spend in range", sc.cost.meta.spend, spend, 2);
eq("paid leads (2 meta)", sc.cost.meta.leads, 2);
eq("paid booked", sc.cost.meta.booked, 1);
near("cost per booked job = spend / 1", sc.cost.meta.cost_per_booking, spend, 1);
near("ROAS = 800 / spend", sc.cost.meta.roas, 800 / spend, 0.02);
eq("data check: no booking price missing", q.booked_without_price, 0);

// ---- disposition rules
const book = await post("/admin/outcome", { id: 102, outcome: "Booked" });
eq("Booked refused without appointment and price", [book.success, book.need], [false, "booking"]);
const ni = await post("/admin/outcome", { id: 102, outcome: "Not interested" });
eq("Not interested refused without a reason", [ni.success, ni.need], [false, "reason"]);
const na = await post("/admin/outcome", { id: 103, outcome: "No answer" });
eq("No answer accepted", na.success, true);
sql([`SELECT 1`]);
const sr = await get("/admin/scorecard?days=30");
eq("scorecard still answers after changes", sr.success, true);

// ---- Twilio reports a call the browser never logged
const sid = "CA" + "e".repeat(32);
eq("Twilio callback accepted", await twilio(`/api/twilio/voice/status?lead=103&p=${sid}&u=bronson`, { CallStatus: "completed", CallDuration: "90" }), 204);
eq("unsigned callback refused", (await fetch(`${T}/api/twilio/voice/status?lead=103&p=${sid}`, { method: "POST", body: new URLSearchParams({ CallStatus: "completed" }) })).status, 403);
await twilio(`/api/twilio/voice/status?lead=103&p=${sid}&u=bronson`, { CallStatus: "completed", CallDuration: "90" }); // Twilio retries: must not double count
const sc2 = await get("/admin/scorecard?days=30");
eq("exactly one new call counted after a repeated callback", sc2.activity.dials, 5);

// ---- calls TO the CRM number
const twilioBody = async (path, f) => { const url = T + path; let data = url; for (const k of Object.keys(f).sort()) data += k + f[k]; const r = await fetch(url, { method: "POST", headers: { "x-twilio-signature": createHmac("sha1", "tok").update(data).digest("base64"), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(f) }); return { status: r.status, text: await r.text() }; };
const inc = await twilioBody("/api/twilio/voice/incoming", { From: "+13055558899", To: "+13055550000", CallSid: "CA" + "f".repeat(32) });
eq("incoming call rings the CRM dialer first, not the cell yet", [inc.status, inc.text.includes("<Client><Identity>bronson</Identity>"), inc.text.includes("+13055557777")], [200, true, false]);
const newLead = (await get("/admin/calendar/find?q=305")).leads.find(l => String(l.phone).includes("8899"));
eq("an unknown caller becomes a lead", !!newLead, true);
const lid = newLead ? newLead.id : 0;
const end1 = await twilioBody(`/api/twilio/voice/incoming-end?lead=${lid}&s=1`, { DialCallStatus: "no-answer", DialCallDuration: "0" });
eq("not answered in the CRM: the cell rings next", [end1.status, end1.text.includes("<Dial"), end1.text.includes("+13055557777"), end1.text.includes("<Record")], [200, true, true, false]);
const end1b = await twilioBody(`/api/twilio/voice/incoming-end?lead=${lid}&s=2`, { DialCallStatus: "no-answer", DialCallDuration: "0" });
eq("not answered on the cell either: AI-voice voicemail", [end1b.status, end1b.text.includes("<Record"), end1b.text.includes("Polly.Matthew-Neural"), end1b.text.includes("Divine Detailers")], [200, true, true, true]);
eq("voicemail callback saved", await twilio(`/api/twilio/voice/voicemail?lead=${lid}`, { RecordingSid: "RE" + "a".repeat(32), RecordingDuration: "14" }), 204);
const end2 = await twilioBody(`/api/twilio/voice/incoming-end?lead=${lid}&s=1`, { DialCallStatus: "completed", DialCallDuration: "75" });
eq("answered call just hangs up", end2.text.includes("<Hangup/>") && !end2.text.includes("<Record"), true);
eq("unsigned incoming refused", (await fetch(`${T}/api/twilio/voice/incoming`, { method: "POST", body: new URLSearchParams({ From: "+13055558899" }) })).status, 403);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
