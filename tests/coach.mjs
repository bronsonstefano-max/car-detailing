// Coach turn-logic test: replays Deepgram-style events into a CallRoom with a fake AI and checks what reaches the screen.
// No network, no keys. Run from the repo root:  node tests/coach.mjs
import { CallRoom } from "../src/worker.js";
import { readFileSync } from "node:fs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let aiDelay = 150, aiMode = "ok", aiCalls = [], aiAsk = "", aiSay = "", factsReply = null, factsCalls = [];
// fake Anthropic: streams one JSON answer that echoes what the lead "just finished saying"
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("/v1/messages")) throw new Error("unexpected fetch " + url);
  const body = JSON.parse(init.body), user = body.messages[0].content, sys = body.system[0].text;
  const sse = text => { const enc = new TextEncoder(), ev = o => enc.encode("data: " + JSON.stringify(o) + "\n\n"); return new Response(new ReadableStream({ start(c) { c.enqueue(ev({ type: "content_block_delta", delta: { type: "text_delta", text } })); c.enqueue(ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} })); c.close(); } }), { status: 200 }); };
  if (sys.startsWith("You keep the running notes")) { factsCalls.push(user); return sse(JSON.stringify(factsReply || { problem: "", solve: "", color: "", done: [], lead: [] })); }
  const said = (/The lead just finished saying: "([^"]*)"/.exec(user) || [])[1] || "";
  aiCalls.push({ said, user, thinking: body.thinking, max: body.max_tokens });
  if (aiMode === "no-disable" && body.thinking) return new Response("thinking.type.disabled is not supported", { status: 400 });
  if (aiMode === "http529") return new Response("overloaded", { status: 529 });
  const text = aiMode === "garbage" ? "Sure! Here is my answer" : JSON.stringify({ say: aiSay || "ANSWER TO: " + said, ask: aiAsk === "-" ? "" : aiAsk || "next question?", needs_eyes: false });
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

// 19b. a question the rep already asked is listed as done, and a stale position hint pointing at it is dropped
{ aiCalls = []; aiAsk = "Do you notice any swirl marks in the paint?"; const t = room();
  t.r.pos = { next: "Do you notice any swirl marks or light scratches in the paint?", step: "07" };
  t.lead("It's a blue Tesla.", { end: true }); await sleep(900);
  check("hint is passed before the question was asked", /NEXT SCRIPT LINE/.test(aiCalls[0].user) && !/ALREADY PUT TO THE LEAD/.test(aiCalls[0].user), aiCalls[0].user);
  t.rep("Nice, blue shows everything. Do you notice any swirl marks in the paint?"); await sleep(50);
  aiAsk = "Where do you notice them most?";
  t.lead("Yeah.", { end: true }); await sleep(1000);
  const u = last(aiCalls).user; aiAsk = "";
  check("asked question is listed and the stale hint is dropped", /ALREADY PUT TO THE LEAD[^]*- Do you notice any swirl marks in the paint\?/.test(u) && !/NEXT SCRIPT LINE/.test(u), u); }

// 19c. a question the coach suggested but the rep never said is NOT treated as asked
{ aiCalls = []; aiAsk = "How long are you planning to keep the car?"; const t = room();
  t.lead("It's a blue Tesla.", { end: true }); await sleep(900);
  t.rep("Got it, and where do you usually park it?"); await sleep(50); aiAsk = "";
  t.lead("In the garage.", { end: true }); await sleep(1000);
  check("a question shown on the card is listed so it is not given again, but the call does not treat it as covered", /ALREADY PUT TO THE LEAD[^]*How long are you planning to keep the car\?/.test(last(aiCalls).user) && t.r.askedSoFar().length === 0, last(aiCalls).user); }

// 19c2. REAL BUG (coach-pr7): "What got you interested in a ceramic coating?" was taken for "...you got a quick second to chat?" (shared: got, ceramic, coating),
// so it was never recorded and the coach asked it again ("You just asked me that").
{ aiCalls = []; const t = room();
  aiAsk = "Anyways, you clicked on our ceramic coating special, so you got a quick second to chat?";
  t.lead("Good, just getting home.", { end: true }); await sleep(1000);
  t.rep("Anyways, you clicked on our ceramic coating special, so you got a quick second to chat?"); await sleep(50);
  aiAsk = "What got you interested in a ceramic coating for it?";
  t.lead("Yeah sure go ahead.", { end: true }); await sleep(1000);
  t.rep("What got you interested in a ceramic coating for it?"); await sleep(50); aiAsk = "";
  t.lead("I want the car to look nice.", { end: true }); await sleep(1000);
  const u = last(aiCalls).user;
  check("two different questions are both recorded", /- What got you interested in a ceramic coating for it\?/.test(u) && /- Anyways, you clicked on our ceramic coating special/.test(u) && t.r.askedSoFar().length === 2, { u, asks: t.r.asks }); }

// 19d. the server keeps the call's progress: finished steps, the next step and what the lead has told us reach the model; the browser hint is no longer used
{ aiCalls = []; factsCalls = []; const t = room(); delete t.r.refreshFacts; // use the real notes request
  t.r.ctx.steps = [{ id: "06", phase: "discovery", q: "What's the year, make and model? And what color is the paint?" }, { id: "07", phase: "discovery", q: "When you look at your paint, do you notice any swirl marks, scratches or dull spots?" }, { id: "08", phase: "discovery", q: "Are you familiar with what a ceramic coating does?" }, { id: "09", phase: "discovery", q: "Do you keep it in a garage or outside?" }];
  t.r.pos = { next: "What's the year, make and model?", step: "06" }; // a stale browser hint
  factsReply = { problem: "you have swirls on the hood", solve: "bring that hood back to looking new", color: "blue", done: ["06", "07", "99"], lead: ["runs it through the car wash every week"] };
  t.rep("Do you notice any swirl marks in the paint?"); await sleep(50);
  t.lead("Yeah, on the hood mostly, I run it through the car wash every week.", { end: true }); await sleep(1300);
  check("notes request sees the script steps and the call", factsCalls.length >= 1 && /SCRIPT STEPS:\n06 \[discovery\]/.test(factsCalls[0]) && /car wash every week/.test(factsCalls[0]), factsCalls[0]);
  t.rep("Got it, that's really common."); await sleep(50);
  t.lead("So what does a coating actually do for that?", { end: true }); await sleep(900);
  const u = last(aiCalls).user;
  check("model is told the next step and the finished ones", /Finished steps: 06, 07\nNEXT STEP 08 \(discovery\): "Are you familiar/.test(u) && !/NEXT SCRIPT LINE/.test(u) && !/99/.test(u.split("Recent transcript")[0] + (u.match(/Finished steps[^\n]*/) || [""])[0]), u);
  check("model gets what the lead told us", /WHAT THIS LEAD HAS TOLD US[^]*- runs it through the car wash every week/.test(u), u);
  check("model sees its own last answers and is told not to reuse them", /YOUR LAST ANSWERS[^]*- ANSWER TO: Yeah, on the hood mostly/.test(u) && /Do not begin with "ANSWER"/.test(u), u);
  factsReply = { done: [], lead: [] }; await sleep(2800); t.lead("Okay that makes sense, what else?", { end: true }); await sleep(900);
  check("a finished step stays finished", /Finished steps: 06, 07/.test(last(aiCalls).user), last(aiCalls).user); factsReply = null; }

// 19h. REAL BUG (coach-pr6): a question that shared two words with a late step ("ceramic coating" in the price line) made the call jump from discovery to booking,
// skipping the recap and the pitch. The call must walk the script in order.
{ aiCalls = []; factsCalls = []; const t = room(); delete t.r.refreshFacts;
  const S = (id, q, extra) => ({ id, phase: "", q, full: q, passage: false, ...extra });
  const recap = "So if I'm understanding everything right, you have a <color year make & model> & you're interested in getting a ceramic coating because <problem>. Did I get that right? Got it. Well from what I heard, I think our coating is perfect for you. It can definitely <solve their problem>. Is it cool if I walk you through our process & how it all works?";
  t.r.ctx.steps = [S("s07", "When you look at your paint, do you notice any swirl marks, scratches or dull spots?"), S("s08", "Are you familiar with what a ceramic coating does? Tell me what you know."), S("s09", "Do you keep it in a garage or outside? & do you hand wash it or run it through the car wash? How often?"), S("s10", "How long are you planning on keeping it?"), S("s11", "Have you ever had a coating done on a car before?"),
    S("s12", recap.slice(0, 260), { full: recap, passage: true }), S("s13", "Awesome. So before any coating goes on, we do 3 things to get your paint perfect.", { full: "Awesome. So before any coating goes on, we do 3 things to get your paint perfect. Foam wash: Roof down to the wheels. Clay bar: Pulls out the dirt & contaminants stuck in the clear coat. Paint correction: A 1 stage correction levels out the paint.", passage: true }), S("s19", "So normally our 5 year ceramic coating package starts at $899, but with the special you get all of it for just $599. Sound good?"), S("s20", "Do weekdays or weekends usually work better for you?")];
  t.r.ctx.car = { year: 2022, make: "BMW", model: "430i" }; t.r.ctx.name = "Jeceline Test";
  factsReply = { problem: "you have chips on the side door", solve: "clean up the swirls around them and keep the gloss", color: "black", done: ["s07"], lead: [] };
  aiAsk = "Are you familiar with what a ceramic coating does?";
  t.rep("Do you notice any swirl marks or scratches?"); await sleep(50);
  t.lead("Yeah, on the side door.", { end: true }); await sleep(1300);
  t.rep("Got it. Are you familiar with what a ceramic coating does?"); await sleep(50);
  aiAsk = "";
  t.lead("Yeah. Protects it.", { end: true }); await sleep(1100);
  check("after step 08 the next step is 09, not booking", /NEXT STEP s09:/.test(last(aiCalls).user) && !/NEXT STEP s20/.test(last(aiCalls).user), last(aiCalls).user.match(/NEXT STEP[^\n]*/));
  // The notes now say discovery is finished AND wrongly claim the recap and the prep are finished too (this is how they were skipped on real calls).
  // The recap must still be next, and it goes on the card word for word with the blanks filled.
  factsReply = { problem: "you have chips on the side door", solve: "clean up the swirls around them and keep the gloss", color: "black", done: ["s07", "s08", "s09", "s10", "s11", "s12", "s13"], lead: [] };
  await sleep(2700); t.rep("Have you had a coating before?"); await sleep(50);
  aiAsk = "What got you interested in a coating?"; aiSay = "Perfect, thanks for walking me through that. The correction takes those chips out before the coating goes on.";
  t.lead("No, first time actually.", { end: true }); await sleep(1300);
  const a = last(t.answers()), u = last(aiCalls).user; aiAsk = ""; aiSay = "";
  check("notes cannot skip the recap: it is the next step", /NEXT STEP s12 is a SCRIPT PASSAGE/.test(u), u.match(/NEXT STEP[^\n]*/));
  check("the bridge is one sentence and the AI's own question is dropped", a.say === "Perfect, thanks for walking me through that." && !a.ask && t.answers().every(x => !/before the coating goes on/.test(x.say)), a);
  check("recap goes on the card word for word with the blanks filled", a.then && a.then.id === "s12" && /you have a black 2022 BMW 430i & you're interested in getting a ceramic coating because you have chips on the side door\. Did I get that right\?/.test(a.then.text) && /It can definitely clean up the swirls around them and keep the gloss\./.test(a.then.text), a);
  // the rep reads the recap: the call moves on to the prep (also a passage, also not skippable by the notes)
  t.rep("So if I'm understanding everything right, you have a black 2022 BMW 430i and you're interested in getting a ceramic coating because you have chips on the side door. Did I get that right? Got it. Well from what I heard I think our coating is perfect for you. It can definitely clean up the swirls. Is it cool if I walk you through our process and how it all works?"); await sleep(50);
  t.lead("Yeah that's right, go for it.", { end: true }); await sleep(1300);
  check("after the rep reads the recap the next step is the prep", /NEXT STEP s13 is a SCRIPT PASSAGE/.test(last(aiCalls).user) && last(t.answers()).then.id === "s13", last(aiCalls).user.match(/NEXT STEP[^\n]*/));
  // a lead who objects gets an answer first; the passage waits
  aiAsk = "Is it the price, or the timing?";
  t.rep("Let me walk you through it."); await sleep(50);
  t.lead("Honestly I need to think about it.", { end: true }); await sleep(1300);
  check("an objection is handled before the passage", !last(t.answers()).then && last(t.answers()).ask === "Is it the price, or the timing?", last(t.answers())); aiAsk = "";
  // the rep states the price: everything before the price step is behind us
  t.r.ctx.price = "599"; t.rep("With the special you get all of it for just $599."); await sleep(50);
  t.lead("Okay that works for me.", { end: true }); await sleep(1300);
  check("once the price is said the call is at booking", /NEXT STEP s20/.test(last(aiCalls).user), last(aiCalls).user.match(/NEXT STEP[^\n]*/));
  factsReply = null; }

// 19j. owner's rule enforced in code: free windshield and wheel coatings / add-ons never reach the card (the AI said them on real calls)
{ aiCalls = []; const t = room();
  aiSay = "With the special, the total comes to $599 with the paint correction, free windshield and wheel coatings, and a 5 year warranty."; aiAsk = "Want me to walk you through the free add-ons that come with the special?";
  t.lead("What is the price, sir?", { end: true }); await sleep(900); const a = last(t.answers()); aiSay = ""; aiAsk = "";
  check("free add-ons are replaced by the free interior detail", a.say === "With the special, the total comes to $599 with the paint correction, a free interior detail, and a 5 year warranty." && !/add-?ons?|windshield|wheel/i.test(a.ask) && /free interior detail/.test(a.ask) && t.answers().every(x => !/windshield/i.test(x.say)), t.answers()); }

// 19k. the lead's name is not used in answer after answer
{ aiCalls = []; const t = room(); t.r.ctx.name = "Angel Test"; aiSay = "Good to hear, Angel.";
  t.lead("I'm doing good today.", { end: true }); await sleep(1000); aiSay = "";
  t.rep("Glad to hear it."); await sleep(50);
  t.lead("So what is this about then?", { end: true }); await sleep(900);
  check("model is told not to use the name again", /Do NOT use their name in this answer/.test(last(aiCalls).user), last(aiCalls).user); }

// 19l. call screening cut off mid-sentence is still a machine
{ aiCalls = []; const t = room(); t.lead("Hi. If you record your", {}); await sleep(100); t.end(); await sleep(1300);
  check("partial call-screening line is skipped", aiCalls.length === 0 && t.logs.some(l => l.why === "machine"), t.logs); }

// 19i. the car is not named in answer after answer ("black BMW" five times in a row on a real call)
{ aiCalls = []; const t = room(); t.r.ctx.car = { year: 2025, make: "BMW", model: "430i" }; t.r.facts = { color: "black" };
  aiSay = "Oh no, rocks at a black BMW is rough.";
  t.lead("My girlfriend threw rocks at my car.", { end: true }); await sleep(1000); aiSay = "";
  t.rep("Where did they hit?"); await sleep(50);
  t.lead("On the side door mostly.", { end: true }); await sleep(1000);
  check("model is told not to name the car again", /do not mention the make, model, year or color/.test(last(aiCalls).user), last(aiCalls).user);
  const v = room(); v.lead("How much does it cost?", { end: true }); await sleep(800); v.rep("Great question."); await sleep(50); v.lead("Okay and how long does it take?", { end: true }); await sleep(800);
  check("no car warning when the car was not mentioned", !/do not mention the make/.test(last(aiCalls).user), 0); }

// 19e. the script outline is built from the imported script (main lines only, branches and coach notes left out, skipped steps dropped)
{ const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8"), a = src.indexOf("function coachVar("), b = src.indexOf("const KNOWLEDGE_DEFAULT");
  const c1 = src.indexOf("const COACH_STOP"), c2 = src.indexOf("function coachStepAsked");
  const coachSteps = new Function(src.slice(c1, c2) + src.slice(a, b) + "; return coachSteps;")();
  const sc = { steps: [
    { id: "06", phase: "discovery", main: [{ k: "say", ps: [{ t: "Fantastic. What's the year, make & model?" }, { t: "& what color is the paint?" }, { note: "Black shows swirls the most." }] }] },
    { id: "07", phase: "discovery", main: [{ k: "say", ps: [{ t: "Do you notice any swirl marks?" }, { sub: "If yes", t: "Where do you notice them the most?" }] }, { k: "outcomes", opts: [{ cond: "yes", nodes: [{ k: "probe", ps: [{ t: "How long?" }] }] }] }] },
    { id: "19", phase: "close", main: [{ k: "say", ps: [{ t: "With the special it is just {price}. Sound good?" }] }] },
    { id: "03", phase: "opener", main: [{ k: "say", ps: [{ t: "You doing anything exciting today?" }] }] } ] };
  const known = coachSteps(sc, { coatPrice: 695, coatSkip: "03" }, { year: 2010, make: "Toyota", model: "Camry" }, "coating");
  check("a car on file is confirmed, not asked for", known[0].q === "Fantastic. I have you down for a 2010 Toyota Camry, is that right? & what color is the paint?", known[0]);
  const addons = coachSteps({ steps: [{ id: "17", main: [{ k: "say", ps: [{ t: "& something I forgot to mention, the special also comes with 2 free add ons." }, { t: "So that’s $450 in add ons, free. Does all that sound good? Any questions?" }], list: [{ h: "Windshield coating · normally $150", t: "Rain beads right off." }, { h: "Wheel coating · normally $300", t: "Repels brake dust." }] }] }, { id: "19", main: [{ k: "say", ps: [{ t: "So normally our package starts at {reg}, but with the special you get all of it, plus the free windshield & wheel coatings, for just {price}. Sound good?" }] }] }] }, { coatPrice: 599, coatReg: 899 }, null, "coating");
  check("script lines about free add-ons are rewritten to the free interior detail", addons[0].full === "& something I forgot to mention, the special also comes with a free interior detail. Does all that sound good? Any questions?" && addons[1].full === "So normally our package starts at $899, but with the special you get all of it, plus a free interior detail, for just $599. Sound good?", addons);
  const out = coachSteps(sc, { coatPrice: 695, coatSkip: "03" }, null, "coating");
  check("script outline is built from the imported script", out.length === 3 && out[0].passage === false && out[0].q === "Fantastic. What's the year, make & model? & what color is the paint?" && out[1].q === "Do you notice any swirl marks?" && out[2].q === "With the special it is just $695. Sound good?", out); }

// 19f. one question per card: a question inside "say" is removed (seen on real calls: the same question in both places)
{ aiCalls = []; const t = room();
  aiSay = "Awesome, glad to hear it! I woke up on the right side of the grass today. You doing anything exciting today?"; aiAsk = "You doing anything exciting today?";
  t.lead("I'm doing great.", { end: true }); await sleep(1000);
  let a = last(t.answers());
  check("question is removed from say", a.say === "Awesome, glad to hear it! I woke up on the right side of the grass today." && a.ask === "You doing anything exciting today?" && t.answers().every(x => !/\?/.test(x.say)), t.answers());
  aiSay = "Got it, black. Do you notice any swirl marks?"; aiAsk = "-"; t.rep("What color is it?"); await sleep(50);
  t.lead("It's black.", { end: true }); await sleep(1000); a = last(t.answers());
  check("a question left in say moves to ask when ask is empty", a.say === "Got it, black." && a.ask === "Do you notice any swirl marks?", a);
  aiSay = "Yes, hi!"; aiAsk = "Is this Jeceline? Great, it's Bronson with Divine Detailers."; t.rep("Hello, can you hear me okay?"); await sleep(50);
  t.lead("Hello? Yes.", { end: true }); await sleep(1000); a = last(t.answers()); aiSay = ""; aiAsk = "";
  check("ask keeps only the question", a.ask === "Is this Jeceline?", a); }

// 19g. a question that has been on the card twice is treated as covered, even if the rep never said it word for word
{ aiCalls = []; aiAsk = "Did you want me to walk you through how our process works?"; const t = room();
  t.lead("No questions so far.", { end: true }); await sleep(1000);
  t.rep("Okay cool."); await sleep(50);
  t.lead("Actually what about the warranty?", { end: true }); await sleep(1000);
  t.rep("Let me check on that."); await sleep(50); aiAsk = "";
  t.lead("Alright sounds fine to me.", { end: true }); await sleep(1000);
  check("twice-shown question is listed as covered", /ALREADY PUT TO THE LEAD[^]*walk you through how our process works/.test(last(aiCalls).user), last(aiCalls).user); }

// 20. a model that refuses "thinking: disabled" still answers (falls back to thinking with a larger limit). Keep this test last: the fallback sticks.
{ aiMode = "no-disable"; aiCalls = []; const t = room();
  t.lead("What's included in the special?", { end: true }); await sleep(900); aiMode = "ok";
  check("fallback when thinking cannot be disabled", t.answers().length >= 1 && !last(t.answers()).backup && last(aiCalls).thinking === undefined && last(aiCalls).max >= 2000, aiCalls.map(c => [c.thinking, c.max])); }

console.log(fails ? `\n${fails} FAILED` : "\nAll coach checks passed");
process.exit(fails ? 1 : 0);
