// Coach turn-logic test: replays Deepgram-style events into a CallRoom with a fake AI and checks what reaches the screen.
// No network, no keys. Run from the repo root:  node tests/coach.mjs
import { CallRoom } from "../src/worker.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let aiDelay = 150, aiMode = "ok", aiCalls = [];
// fake Anthropic: streams one JSON answer that echoes what the lead "just finished saying"
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("/v1/messages")) throw new Error("unexpected fetch " + url);
  const body = JSON.parse(init.body), user = body.messages[0].content, said = (/The lead just finished saying: "([^"]*)"/.exec(user) || [])[1] || "";
  aiCalls.push({ said, user, thinking: body.thinking, max: body.max_tokens });
  if (aiMode === "no-disable" && body.thinking) return new Response("thinking.type.disabled is not supported", { status: 400 });
  if (aiMode === "http529") return new Response("overloaded", { status: 529 });
  const text = aiMode === "garbage" ? "Sure! Here is my answer" : JSON.stringify({ say: "ANSWER TO: " + said, ask: "next question?", needs_eyes: false });
  const enc = new TextEncoder(), ev = o => enc.encode("data: " + JSON.stringify(o) + "\n\n");
  const delay = aiMode === "slow" ? 6000 : aiDelay;
  return new Response(new ReadableStream({
    async start(c) {
      const abort = new Promise(r => init.signal && init.signal.addEventListener("abort", () => r("aborted")));
      if (await Promise.race([sleep(delay), abort]) === "aborted") { c.error(new Error("aborted")); return; }
      c.enqueue(ev({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 5000 } } }));
      c.enqueue(ev({ type: "content_block_delta", delta: { type: "text_delta", text } }));
      c.enqueue(ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } }));
      c.close();
    },
  }), { status: 200 });
};

function room() {
  const logs = [];
  const stmt = sql => ({ bind: (...a) => ({ run: async () => { if (/coach_turns/.test(sql)) logs.push({ said: a[3], trig: a[4], outcome: a[5], why: a[6] }); return {}; }, first: async () => null, all: async () => ({ results: [] }) }), run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) });
  const r = new CallRoom({}, { ANTHROPIC_API_KEY: "test", DB: { prepare: stmt, batch: async () => [] } });
  r.ctx = { system: "SYSTEM", facts: "Lead: test.", svc: "coating", lib: [], body: "" }; // skip the database
  r.refreshFacts = async () => {};
  r.sid = "CAtest";
  const sent = []; r.broadcast = m => { if (m.type === "answer" || m.type === "coach_skip") sent.push(m); };
  const dg = (track, transcript, o = {}) => r.onDg(track, { type: "Results", is_final: o.final !== false, speech_final: !!o.end, start: 0, duration: 1, channel: { alternatives: [{ transcript, confidence: 0.95 }] } });
  return { r, sent, logs, lead: (t, o) => dg("outbound", t, o), rep: (t, o) => dg("inbound", t, { end: true, ...o }), end: () => r.onDg("outbound", { type: "UtteranceEnd" }), answers: () => sent.filter(m => m.type === "answer") };
}

let fails = 0;
const check = (name, ok, extra) => { console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   " + JSON.stringify(extra))); if (!ok) fails++; };
const last = a => a[a.length - 1];

// 1. a normal question gets one answer for the whole remark
{ aiMode = "ok"; aiCalls = []; const t = room();
  t.lead("How much does it cost?", { end: true }); await sleep(700);
  const a = t.answers(); check("question is answered", a.length >= 1 && last(a).say === "ANSWER TO: How much does it cost?" && !last(a).backup, a); }

// 2. "How are you doing?" ... "today": the trailing word must not change the answer on screen
{ aiCalls = []; const t = room();
  t.lead("How are you doing?", { end: true }); await sleep(700);
  const before = t.answers().length;
  t.lead("today", { end: true }); await sleep(1500);
  check("trailing word leaves the answer alone", t.answers().length === before && aiCalls.length === 1 && t.logs.some(l => l.why === "tail"), { n: t.answers().length, before, aiCalls: aiCalls.length, logs: t.logs }); }

// 3. a split remark that arrives after the first answer is answered as ONE remark, not the tail alone
{ aiCalls = []; const t = room();
  t.lead("How much is it?", { end: true }); await sleep(700);
  t.lead("for the whole car because I am comparing", { end: true }); await sleep(1700);
  check("late fragment is merged with the remark before it", last(aiCalls).said === "How much is it? for the whole car because I am comparing", aiCalls.map(c => c.said)); }

// 4. fragments while the AI is still writing: one answer for the merged text, the stale one never shown
{ aiDelay = 500; aiCalls = []; const t = room();
  t.lead("I really thought", { end: true }); await sleep(1250); // unfinished sentence: asked after 1100 ms, AI is now writing
  t.lead("this was free", { end: true }); await sleep(2200);
  const a = t.answers(); aiDelay = 150;
  check("mid-answer fragment restarts with merged text", a.length >= 1 && a.every(x => x.say === "ANSWER TO: I really thought this was free") && t.logs.some(l => l.outcome === "restarted"), { a: a.map(x => x.say), logs: t.logs }); }

// 4b. a two-word opening that is skipped on its own is not lost: it is joined to the rest
{ aiCalls = []; const t = room();
  t.lead("I thought", { end: true }); await sleep(1300);
  t.lead("this was free", { end: true }); await sleep(1600);
  check("skipped opening words are joined to the rest", aiCalls.length === 1 && aiCalls[0].said === "I thought this was free", aiCalls.map(c => c.said)); }

// 5. the lead is still talking (no end of speech yet): nothing is asked until they stop
{ aiCalls = []; const t = room();
  t.lead("so I was looking at", {}); await sleep(300);
  t.lead("your ad", { final: false }); await sleep(300); // interim: still talking
  check("no request while the lead is still talking", aiCalls.length === 0, aiCalls.length);
  t.lead("your ad and I had a question about the price", { end: true }); await sleep(1600);
  check("one request once they stop", aiCalls.length === 1 && aiCalls[0].said === "so I was looking at your ad and I had a question about the price", aiCalls.map(c => c.said)); }

// 6. "yeah" right after the rep's question is an answer and gets the follow-up
{ aiCalls = []; const t = room();
  t.rep("Do you notice any swirl marks or light scratches in the paint?"); await sleep(50);
  t.lead("Yeah.", { end: true }); await sleep(1000);
  check("yes to a discovery question is answered", t.answers().length >= 1 && /REP JUST SAID: "Do you notice any swirl marks/.test(aiCalls[0].user), { n: t.answers().length }); }

// 7. "no" after a question with no question mark in the transcript
{ aiCalls = []; const t = room();
  t.rep("and do you keep it in a garage"); await sleep(50);
  t.lead("No.", { end: true }); await sleep(1000);
  check("no to an unpunctuated question is answered", t.answers().length >= 1, t.logs); }

// 8. "uh huh" while the rep is explaining is listening noise: stay quiet, and say why in the log
{ aiCalls = []; const t = room();
  t.rep("So the coating bonds to the clear coat and it lasts for years."); await sleep(50);
  t.lead("Uh huh.", { end: true }); await sleep(1000);
  check("backchannel is skipped and logged", t.answers().length === 0 && t.logs.some(l => l.outcome === "skipped" && l.why === "ack"), t.logs); }

// 9. two-word objections are never dropped
for (const said of ["Not interested.", "Too expensive.", "Call back later", "Sounds good."]) { aiCalls = []; const t = room();
  t.rep("It is a five year ceramic coating with paint correction included."); await sleep(50);
  t.lead(said, { end: true }); await sleep(1600);
  check('short remark answered: "' + said + '"', t.answers().length >= 1, t.logs); }

// 10. a short answer to a question ("Black") is answered; a stray word with no question is not
{ aiCalls = []; const t = room();
  t.rep("What color is the car?"); await sleep(50); t.lead("Black.", { end: true }); await sleep(1000);
  check("one-word answer to a question is answered", t.answers().length >= 1, t.logs);
  const u = room(); u.rep("We are right by the Palmetto."); await sleep(50); u.lead("the car", { end: true }); await sleep(1500);
  check("stray fragment with no question is skipped", u.answers().length === 0 && u.logs.some(l => l.why === "short"), u.logs); }

// 11. the AI service fails: the backup answer is shown and the reason is reported
{ aiMode = "http529"; const t = room();
  t.lead("I'm really just shopping around.", { end: true }); await sleep(1000); aiMode = "ok";
  const a = t.answers();
  check("service error shows the backup with a reason", a.length === 1 && a[0].backup === true && t.sent.some(m => m.type === "coach_skip" && /529/.test(m.why)) && t.logs.some(l => l.outcome === "backup" && /529/.test(l.why)), { a, logs: t.logs }); }

// 12. unreadable reply: backup shown, raw text logged
{ aiMode = "garbage"; const t = room();
  t.lead("What's the price of something like this?", { end: true }); await sleep(700); aiMode = "ok";
  check("unreadable reply shows the backup", t.answers().length === 1 && t.answers()[0].backup === true && t.logs.some(l => /unreadable/.test(l.why)), t.logs); }

// 13. slow AI: backup at 3 s, and it is NOT replaced afterwards
{ aiMode = "slow"; const t = room();
  t.lead("I don't have too much time, I want the bottom line.", { end: true }); await sleep(3900);
  const n = t.answers().length, first = t.answers()[0]; await sleep(3500); aiMode = "ok";
  check("slow AI: one backup answer that stays", n === 1 && first.backup === true && t.answers().length === 1, t.answers()); }

// 14. Deepgram never marks the end of speech (noisy line): the utterance-end signal still gets an answer
{ aiCalls = []; const t = room();
  t.lead("I have no questions how much does it cost", {}); await sleep(200); t.end(); await sleep(1300);
  check("utterance end triggers the answer", t.answers().length >= 1, t.logs); }

// 15. after the rep has spoken, new lead words are a new remark (not merged into the old one)
{ aiCalls = []; const t = room();
  t.lead("How much does it cost?", { end: true }); await sleep(700);
  t.rep("Great question, it depends on when you would like to book?"); await sleep(50);
  t.lead("Probably next week sometime", { end: true }); await sleep(1600);
  check("new remark after the rep spoke is not merged", last(aiCalls).said === "Probably next week sometime", aiCalls.map(c => c.said)); }

// 16. the live coach never lets the model "think" first (thinking used up the whole token limit on real calls and no answer arrived)
{ aiCalls = []; const t = room();
  t.lead("How long does ceramic coating last?", { end: true }); await sleep(700);
  check("thinking is turned off for live answers", aiCalls.length === 1 && aiCalls[0].thinking && aiCalls[0].thinking.type === "disabled", aiCalls.map(c => c.thinking)); }

// 17. the rep's own voice on the lead's side of the line (echo) is not answered
{ aiCalls = []; const t = room();
  t.rep("Hey Jessalyn, this is Bronson with Divine Detailers. How are you doing today?"); await sleep(50);
  t.lead("Hey, Jessalyn. This is Bronson with Divine Detailers. How are you doing today?", { end: true }); await sleep(900);
  check("echo of the rep is skipped", aiCalls.length === 0 && t.logs.some(l => l.why === "echo"), t.logs);
  const u = room(); u.lead("I don't know anything about ceramic coating.", { end: true }); await sleep(1000);
  const card = last(u.answers()); u.lead(card.say + " " + card.ask, { end: true }); await sleep(1500);
  check("echo of the card being read aloud is skipped", u.logs.some(l => l.why === "echo") && u.answers().every(a => a.q === "I don't know anything about ceramic coating."), u.logs); }

// 18. voicemail and call screening are not the lead
for (const said of ["Hi. If you record your name and reason for calling, I'll see if this person is available.", "I'm sorry. This person is not available.", "Please leave a message after the tone."]) { aiCalls = []; const t = room();
  t.lead(said, { end: true }); await sleep(1000);
  check('machine is skipped: "' + said.slice(0, 40) + '"', aiCalls.length === 0 && t.logs.some(l => l.why === "machine"), t.logs); }

// 19. a sentence left hanging waits longer than a finished one ("I got the..." must not be answered at once)
{ aiCalls = []; const t = room();
  t.rep("What kind of car is it?"); await sleep(50);
  t.lead("I got the...", { end: true }); await sleep(700);
  check("hanging sentence is not answered right away", aiCalls.length === 0, aiCalls.length);
  t.lead("the Tesla Model 3.", { end: true }); await sleep(1000);
  check("answered once the sentence is finished", aiCalls.length === 1 && aiCalls[0].said === "I got the... the Tesla Model 3.", aiCalls.map(c => c.said)); }

// 20. a model that refuses "thinking: disabled" still answers (falls back to thinking with a larger limit). Keep this test last: the fallback sticks.
{ aiMode = "no-disable"; aiCalls = []; const t = room();
  t.lead("What's included in the special?", { end: true }); await sleep(900); aiMode = "ok";
  check("fallback when thinking cannot be disabled", t.answers().length >= 1 && !last(t.answers()).backup && last(aiCalls).thinking === undefined && last(aiCalls).max >= 2000, aiCalls.map(c => [c.thinking, c.max])); }

console.log(fails ? `\n${fails} FAILED` : "\nAll coach checks passed");
process.exit(fails ? 1 : 0);
