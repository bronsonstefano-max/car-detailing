#!/usr/bin/env python3
"""Call miner: turn a folder of sales-call recordings into a deep, comparable record of every call, then learn across all of them.

Runs on your own computer. Only needs python3 and curl (both come with a Mac). Your keys stay on your computer.

  export DEEPGRAM_API_KEY=...        # transcription (console.deepgram.com)
  export ANTHROPIC_API_KEY=...       # analysis (console.anthropic.com)
  python3 call_miner.py run audio --limit 30

Optional but strongly recommended: put your call scripts in a folder called "scripts" next to this file
(bundle.json, or tint.json and coating.json). The analysis then compares every call to your script step by step.

Steps (each can also be run alone; every step skips work that is already done):
  transcribe  audio files   -> out/transcripts/*.txt            (Deepgram)
  mine        transcripts   -> out/mined/*.json                 (Claude: one deep record per call)
  report      mined calls   -> out/calls.csv, agents.csv, deviations.csv, pivotal.csv, moments.csv, knowledge.csv,
                               turns_all.csv (every sentence of every call, with time, speaker role and tags) and
                               response_library.jsonl / .csv (every thing a lead said, with the context and how the rep answered)
  learn       all of it     -> out/lessons.md                    (Claude: what wins, what loses, what to teach the coach)

What one call record contains (out/mined/<call>.json):
  meta         agent name, client name, service, vehicle, call type, language
  outcome      result (booked, deposit, callback, lost...), evidence, price quoted, next step
  timeline     phase by phase: what happened and when
  script       which script steps were covered or skipped, and every place the rep went off script
               (better, worse, or neutral, with the rep's actual words and whether to keep it)
  lead         goals, pain points, vehicle condition, budget signals, decision maker, timing
  moments      each question or pushback from the lead, how the rep answered, a better answer
  pivotal      the turning points that helped or hurt the call
  knowledge    facts about tint, coating, correction and PPF said on the call, checked against the script
  scores       rapport, discovery, ACA framework, pitch, objections, close, control, overall (1-5)
  coaching     strengths, fixes, and one lesson the coach should learn
  turns        the full call, turn by turn: time, who (rep or lead), exact words, and tags (what it was, which topic,
               which script step, who it answers, how good the answer was)
"""
import argparse, collections, csv, difflib, glob, hashlib, json, os, re, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote

AUDIO_EXT = (".wav", ".wave", ".mp3", ".m4a", ".mp4", ".ogg", ".opus", ".flac", ".aac", ".webm")
DG_BASE = os.environ.get("DEEPGRAM_BASE", "https://api.deepgram.com")
AN_BASE = os.environ.get("ANTHROPIC_BASE", "https://api.anthropic.com")
DEFAULT_MODEL = "claude-sonnet-5-5"

TOPICS = "what_is_it, price, scratches_swirls, paint_condition_or_repaint, how_long, warranty, brand_or_film, legal_tint, heat_uv_privacy, location, booking_time, deposit_or_payment, wax_comparison, need_to_think, spouse, send_me_info, shopping_around, too_expensive, aftercare, other"

SCHEMA = """{
 "meta": {"agent_name": "first name of the sales rep as said on the call, or null", "agent_confidence": "high|medium|low", "client_name": "the lead's name as said on the call, or null", "service": "tint|coating|correction|ppf|wrap|detail|multiple|other", "vehicle": {"year": null, "make": null, "model": null, "color": null, "condition_notes": null}, "call_type": "outbound_followup|inbound|callback|voicemail|wrong_number|other", "language": "en|es|mixed", "transcript_quality": "good|fair|poor"},
 "rep_speaker": "S0",
 "outcome": {"result": "booked|deposit_taken|callback_set|not_interested|no_decision|lost_to_competitor|no_answer_or_voicemail|unclear", "win": false, "evidence": "what in the call shows this", "price_quoted": null, "deposit_asked": null, "appointment": null, "next_step": null},
 "summary": "two sentences: who the lead is, what they wanted, how it ended",
 "timeline": [{"t": "m:ss", "phase": "opener|rapport|discovery|recap|pitch|price|objection|close|deposit|wrap_up|other", "script_step": "step id like s06 or null", "what_happened": "one sentence"}],
 "script": {"compared_against": "tint|coating|none", "steps_covered": ["s02"], "steps_skipped": ["s09"], "order_notes": "how the call's order differed from the script, and whether that mattered",
   "deviations": [{"t": "m:ss", "script_step": "s15 or null", "script_said": "what the script says here, short", "rep_said": "what the rep actually said, close to verbatim", "type": "better|worse|neutral|missed_step|extra", "impact": "effect on the lead or the outcome", "keep_this": true}]},
 "lead": {"goals": [], "pain_points": [], "vehicle_condition": null, "budget_signals": null, "decision_maker": null, "timeline": null, "objections_raised": [], "buying_signals": []},
 "moments": [{"t": "m:ss", "kind": "question|objection", "topic": "one of the topics", "lead_said": "close to verbatim", "rep_said": "the rep's answer, close to verbatim, up to about 70 words", "quality": 1, "why": "why it worked or did not", "better_answer": "what the rep should have said, using only script facts or clearly general knowledge, or null if the answer was already strong"}],
 "pivotal": [{"t": "m:ss", "kind": "turning_point|lost_opportunity|strong_close|rapport_win|mistake|recovery", "description": "what happened", "effect": "how it changed the call", "repeat_or_avoid": "what to repeat or avoid next time"}],
 "knowledge": [{"topic": "short topic", "claim": "a factual statement about the product, process, price or paint/tint science made on the call", "said_by": "rep|lead", "vs_script": "matches|contradicts|not_in_script", "note": "why it matters or what to verify"}],
 "scores": {"rapport": 1, "discovery": 1, "aca_framework": 1, "pitch": 1, "objection_handling": 1, "close": 1, "control": 1, "overall": 1, "justification": "two or three sentences"},
 "coaching": {"strengths": [], "fixes": [], "one_lesson": "the single most useful lesson from this call for an AI coach"},
 "turn_tags": [{"i": 12, "kind": "question|objection|buying_signal|statement|small_talk|pitch|price|close|ack|other", "topic": "one of the topics or null", "phase": "opener|rapport|discovery|recap|pitch|price|objection|close|deposit|wrap_up|other", "script_step": "s06 or null", "needs_response": true, "answers_turn": null, "answered_by": [13, 14], "quality": 1}]
}"""

RUBRIC = """Scoring (1 to 5; use the whole range; a typical average call is a 3):
- rapport: warmth, listening, using the lead's words, natural conversation
- discovery: learned the vehicle, the goal or problem, condition, timeline, and who decides, before pitching
- aca_framework: acknowledged what the lead said, added a real comment, then asked a question that built on the answer
- pitch: explained the service in terms of the lead's own problem (not generic)
- objection_handling: empathy, qualifying question, calm rebuttal, held price sensibly
- close: asked for a day and a deposit, handled the card concern, confirmed details
- control: kept the call moving toward a booking; answered questions then steered back; did not ramble or let the lead drive off
- overall: your overall judgement of the call, not an average"""

MINE_RULES = """You are the head of sales training for a car detailing shop in Miami that sells window tint, ceramic coating, paint correction, paint protection film and wraps. You will be given the transcript of ONE recorded sales call (speakers are labeled S0/S1, or C0/C1 for the two audio channels; work out who is the sales rep: the one who introduces the shop and pitches) and the shop's call SCRIPTS.

Evaluate the call deeply and return ONLY one JSON object, no markdown, in exactly this shape (every key present; use null or [] when unknown):
""" + SCHEMA + """

""" + RUBRIC + """

Rules:
- Use only what is in the transcript. Quote the rep's and lead's words closely. Never invent names, prices or facts. If unsure, say so (lower the confidence, use null).
- Compare the rep to the script that matches the service sold. Script step ids look like s06; scripts are labeled [tint] or [coating]. A deviation is any place the rep said something materially different from the script, skipped a step, or added something not in the script. Mark type "better" only when it plausibly helped; "worse" when it hurt or risked a false claim; set keep_this true for deviations worth teaching to the coach. If no script is provided, set compared_against "none" and leave steps_covered, steps_skipped and deviations empty.
- "moments": every question or pushback from the lead (not small talk), at most 15, in order. "better_answer" must rely only on script facts or well-known general knowledge, and must be null when the rep's answer was already strong.
- "pivotal": 2 to 6 turning points. Say what changed because of it.
- "knowledge": factual claims about the products, process, pricing, durations, warranty, paint or tint science (for example whether a sun-damaged clear coat needs correction or repainting). Mark vs_script as contradicts or not_in_script when the script does not cover it, so a human can verify it. Do not treat opinions or small talk as knowledge.
- "turn_tags": the transcript is given with numbered turns (#12). Tag EVERY substantive turn of both speakers, in order. For a lead turn that needs a reply (a question, objection, buying signal, or a statement the rep should respond to) set needs_response true, list the rep turn numbers that answered it in answered_by, topic, and rate the answer in quality (1-5). For a rep turn that answers a lead turn, set answers_turn to that lead turn number and rate it. Skip one-word backchannels (yeah, ok, mm-hmm) and filler. Use the exact turn numbers from the transcript. script_step is the script step the turn corresponds to, when there is one.
- WIN: a win is a deposit taken (or a payment link sent and paid) AND a specific appointment date set, on this call. Set outcome.win true only then. A date without a deposit is "booked" but not a win. A callback, or "I'll call you back", is a soft loss (result callback_set, win false). Use the transcript's own words as evidence.
- Spoken numbers are often garbled in the transcript ("$2.69" is probably $269, "one seventy nine" is $179, "$4.99" may be $499). Interpret prices using the prices in the script and put the likely price in outcome.price_quoted; add "(unclear)" when you are not sure. Do not build a scoring judgment on a garbled number.
- If the call is a voicemail, wrong number, or too short to evaluate, still return the full shape with empty lists, outcome.result "no_answer_or_voicemail" or "unclear", and scores of 1 with a justification saying it was not a real conversation.
- Topics for moments: """ + TOPICS + "."


# ------------------------------------------------------------------ helpers
LOCK = threading.Lock()
ROSTER = {}      # lower-case name or alias -> real name
GLOSSARY = []    # business words the audio should get right


def say(msg):
    with LOCK:
        print(msg, flush=True)


def log_err(out, f, e):
    with LOCK:
        with open(os.path.join(out, "errors.log"), "a") as fh:
            fh.write("%s\t%s\n" % (f, e))


def load_roster(path):
    """roster.txt: one rep per line, optional aliases for how the audio mishears the name:  Sylvia=Silvia,Sylvie"""
    ROSTER.clear()
    if not path or not os.path.exists(path):
        return
    for line in open(path):
        line = line.split("#")[0].strip()
        if not line:
            continue
        name, _, al = line.partition("=")
        name = name.strip()
        for x in [name] + [y.strip() for y in al.split(",") if y.strip()]:
            ROSTER[x.lower()] = name


def load_glossary(path):
    GLOSSARY[:] = []
    if path and os.path.exists(path):
        GLOSSARY.extend(l.split("#")[0].strip() for l in open(path) if l.split("#")[0].strip())


def canon_agent(raw):
    n = str(raw or "").strip().split(" ")[0].lower()
    if not n or n in ("none", "null", "unknown"):
        return "Unknown"
    if n in ROSTER:
        return ROSTER[n]
    m = difflib.get_close_matches(n, list(ROSTER.keys()), n=1, cutoff=0.78)
    return ROSTER[m[0]] if m else n.capitalize()


def quick_hash(path):
    size = os.path.getsize(path)
    h = hashlib.sha1(str(size).encode())
    with open(path, "rb") as f:
        h.update(f.read(524288))
        if size > 1048576:
            f.seek(-524288, 2)
            h.update(f.read())
    return h.hexdigest()


def sh(args, stdin=None):
    p = subprocess.run(args, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return p.returncode, p.stdout, p.stderr


def retry(fn, tries=6):
    last = None
    for i in range(tries):
        try:
            return fn()
        except Exception as e:  # noqa
            last = e
            time.sleep(3 * (2 ** i))   # waits 3, 6, 12, 24, 48 seconds: enough for a rate limit to clear
    raise last


def wav_channels(path):
    try:
        with open(path, "rb") as f:
            h = f.read(40)
        if h[:4] == b"RIFF" and h[8:12] == b"WAVE":
            return int.from_bytes(h[22:24], "little")
    except Exception:
        pass
    return 1


def mmss(t):
    t = int(t or 0)
    return "%d:%02d" % (t // 60, t % 60)


def secs(label):
    m = re.match(r"(\d+):(\d+)", str(label or ""))
    return int(m.group(1)) * 60 + int(m.group(2)) if m else 0


# ------------------------------------------------------------------ transcribe
def transcribe_one(path, lang, key, smart=False):
    ch = wav_channels(path) if path.lower().endswith((".wav", ".wave")) else 1
    # smart_format turns "two sixty nine" into "$2.69", which loses the price; plain words are safer, the analysis reads them with the price list
    q = "model=nova-3&punctuate=true&utterances=true&language=%s" % lang
    if smart:
        q += "&smart_format=true"
    q += "&multichannel=true" if ch == 2 else "&diarize=true"
    qk = q + "".join("&keyterm=" + quote(t) for t in GLOSSARY[:80])
    ext = path.rsplit(".", 1)[-1].lower()
    ctype = {"wav": "audio/wav", "wave": "audio/wav", "mp3": "audio/mpeg", "m4a": "audio/mp4", "mp4": "audio/mp4", "ogg": "audio/ogg", "opus": "audio/ogg", "flac": "audio/flac", "aac": "audio/aac", "webm": "audio/webm"}.get(ext, "application/octet-stream")

    def go(query):
        code, out, err = sh(["curl", "-sS", "--max-time", "900", "-X", "POST", "%s/v1/listen?%s" % (DG_BASE, query),
                             "-H", "Authorization: Token " + key, "-H", "Content-Type: " + ctype, "--data-binary", "@" + path])
        if code != 0:
            raise RuntimeError("curl failed: " + err.decode("utf-8", "ignore")[:200])
        j = json.loads(out.decode("utf-8"))
        if j.get("err_code") or j.get("error"):
            raise RuntimeError(str(j.get("err_msg") or j.get("error"))[:200])
        return j

    def attempt():
        try:
            return go(qk)
        except RuntimeError as e:
            if GLOSSARY and "keyterm" in str(e).lower():
                return go(q)       # this language does not take key terms: transcribe without them
            raise
    j = retry(attempt)
    label = "C" if ch == 2 else "S"
    lines, utts = [], []
    for u in (j.get("results", {}).get("utterances") or []):
        who = u.get("channel") if ch == 2 else u.get("speaker")
        spk = "%s%s" % (label, who if who is not None else "?")
        text = str(u.get("transcript", "")).strip()
        lines.append("[%s] %s: %s" % (mmss(u.get("start")), spk, text))
        utts.append({"start": u.get("start"), "end": u.get("end"), "spk": spk, "text": text, "conf": u.get("confidence")})
    return j, "\n".join(lines), utts


def cmd_transcribe(a):
    key = os.environ.get("DEEPGRAM_API_KEY")
    if not key:
        sys.exit("Set DEEPGRAM_API_KEY first:  export DEEPGRAM_API_KEY=your-key")
    files = sorted(f for f in glob.glob(os.path.join(a.audio, "**", "*"), recursive=True) if f.lower().endswith(AUDIO_EXT))
    if a.limit:
        files = files[:a.limit]
    if not files:
        allf = [f for f in glob.glob(os.path.join(a.audio, "**", "*"), recursive=True) if os.path.isfile(f)]
        types = sorted(set(os.path.splitext(f)[1].lower() or "(no extension)" for f in allf))
        sys.exit("No audio files found.\n  Looked in: %s\n  Files there: %d (types: %s)\n  Put the recordings in that folder (unzip any .zip first), then run it again.\n  Not sure where they are? Run:  cd %s && pwd && ls audio | head"
                 % (os.path.abspath(a.audio), len(allf), ", ".join(types) or "none", os.getcwd()))
    os.makedirs(os.path.join(a.out, "transcripts"), exist_ok=True)
    hp = os.path.join(a.out, "hashes.json")
    try:
        hashes = json.load(open(hp)) if os.path.exists(hp) else {}
    except Exception:
        hashes = {}
    todo, skipped, dups = [], 0, 0
    for f in files:
        base = os.path.splitext(os.path.basename(f))[0]
        tp = os.path.join(a.out, "transcripts", base + ".txt")
        if os.path.exists(tp) and os.path.getsize(tp) > 0:
            skipped += 1
            continue
        h = quick_hash(f)
        if h in hashes and hashes[h] != base:
            dups += 1
            say("Skipping %s: the same recording as %s" % (os.path.basename(f), hashes[h]))
            continue
        hashes[h] = base
        todo.append((f, base, tp))
    json.dump(hashes, open(hp, "w"))
    counts = {"done": 0, "fail": 0}

    def work(n, item):
        f, base, tp = item
        try:
            j, text, utts = transcribe_one(f, a.lang, key, a.smart)
            with open(os.path.join(a.out, "transcripts", base + ".json"), "w") as fh:
                json.dump({"file": os.path.basename(f), "duration": j.get("metadata", {}).get("duration"), "utterances": utts}, fh)
            with open(tp, "w") as fh:
                fh.write(text or "(no speech found)")
            with LOCK:
                counts["done"] += 1
            say("[%d/%d] transcribed %s (%d lines)" % (n, len(todo), os.path.basename(f), text.count("\n") + 1))
        except Exception as e:
            with LOCK:
                counts["fail"] += 1
            say("[%d/%d] FAILED %s: %s" % (n, len(todo), os.path.basename(f), e))
            log_err(a.out, f, e)
    with ThreadPoolExecutor(max_workers=max(1, a.jobs)) as ex:
        list(ex.map(lambda t: work(t[0], t[1]), list(enumerate(todo, 1))))
    print("Transcription: %d new, %d already done, %d duplicate recordings skipped, %d failed" % (counts["done"], skipped, dups, counts["fail"]))


# ------------------------------------------------------------------ turns
def parse_turns(txt, jpath=None):
    """Every sentence of the call in order: number, start (and end when known), speaker label, words."""
    turns = []
    for line in txt.split("\n"):
        m = re.match(r"^(?:#\d+ )?\[(\d+:\d+)\] ([SC]\d+|S\?|C\?): (.*)$", line)
        if m:
            turns.append({"i": len(turns) + 1, "t": m.group(1), "start": secs(m.group(1)), "end": None, "spk": m.group(2), "text": m.group(3).strip()})
    ends = None
    try:
        if jpath and os.path.exists(jpath):
            ends = (json.load(open(jpath)).get("utterances") or [])
    except Exception:
        ends = None
    for k, t in enumerate(turns):
        if ends and len(ends) == len(turns) and ends[k].get("end") is not None:
            t["end"] = round(float(ends[k]["end"]), 1)
            t["start"] = round(float(ends[k].get("start") or t["start"]), 1)
        elif k + 1 < len(turns):
            t["end"] = turns[k + 1]["start"]
    return turns


def numbered(turns):
    return "\n".join("#%d [%s] %s: %s" % (t["i"], t["t"], t["spk"], t["text"]) for t in turns)


# ------------------------------------------------------------------ scripts
def script_text(sc, label):
    """Plain-text version of one imported call script (same format the dialer exports)."""
    def f(t):
        t = re.sub(r"\{(\w+)\}", lambda m: "(" + m.group(1) + ")", str(t or ""))
        return re.sub(r"\[\[([^\]]+)\]\]", lambda m: "<" + m.group(1).lower() + ">", t)

    def node(n):
        if not n:
            return ""
        k = n.get("k")
        if k == "outcomes":
            return "\n".join("IF " + f(o.get("cond")) + ":\n" + "\n".join(x for x in (node(y) for y in o.get("nodes", [])) if x) for o in n.get("opts", []))
        if k == "cond":
            return "IF " + f(n.get("t")) + ":"
        if k in ("ret", "pill", "router"):
            return ""
        tag = {"say": "SAY", "resp": "SAY", "obj": "LEAD SAYS", "probe": "ASK", "coach": "NOTE", "ex": "EXAMPLE"}.get(k, "SAY")
        ps = "\n".join(("NOTE: " + f(p.get("note"))) if p.get("note") else tag + ": " + f(p.get("t")) for p in n.get("ps", []))
        li = "\n".join("- %s: %s" % (i.get("h"), f(i.get("t"))) for i in n.get("list", []))
        return "\n".join(x for x in (ps, li) if x)
    out = []
    for st in sc.get("steps", []):
        out.append("## [%s] STEP %s%s - phase %s" % (label, st.get("id"), " (#%s)" % st.get("n") if st.get("n") else "", st.get("phase", "")))
        out.append("\n".join(x for x in (node(n) for n in st.get("main", [])) if x))
        if st.get("side"):
            out.append("If it comes up here:\n" + "\n".join(x for x in (node(n) for n in st["side"]) if x))
    for pl in sc.get("plays", []):
        out.append("## [%s] PLAYBOOK %s - %s" % (label, pl.get("id"), pl.get("title")))
        out.append("\n".join(x for x in (node(n) for n in pl.get("nodes", [])) if x))
    return "\n".join(out)


def load_scripts(folder):
    if not folder or not os.path.isdir(folder):
        return ""
    found = {}
    for name in ("bundle.json", "tint.json", "coating.json"):
        p = os.path.join(folder, name)
        if os.path.exists(p):
            try:
                found[name] = json.load(open(p))
            except Exception as e:
                print("Could not read %s: %s" % (p, e))
    parts = []
    b = found.get("bundle.json")
    if b:
        for k in ("tint", "coating"):
            if b.get(k):
                parts.append(script_text(b[k], k))
    for k in ("tint", "coating"):
        if found.get(k + ".json") and not (b and b.get(k)):
            parts.append(script_text(found[k + ".json"], k))
    return "\n\n".join(parts)


# ------------------------------------------------------------------ claude
def claude(model, effort, system_blocks, user, key, max_tokens=8000):
    body = json.dumps({"model": model, "max_tokens": max_tokens, "output_config": {"effort": effort}, "system": system_blocks,
                       "messages": [{"role": "user", "content": user}]})

    def go():
        code, out, err = sh(["curl", "-sS", "--max-time", "300", "-X", "POST", AN_BASE + "/v1/messages",
                             "-H", "content-type: application/json", "-H", "x-api-key: " + key, "-H", "anthropic-version: 2023-06-01", "-d", "@-"], stdin=body.encode("utf-8"))
        if code != 0:
            raise RuntimeError("curl failed: " + err.decode("utf-8", "ignore")[:200])
        j = json.loads(out.decode("utf-8"))
        if j.get("type") == "error":
            raise RuntimeError(str((j.get("error") or {}).get("message"))[:200])
        return j
    j = retry(go)
    text = "".join(b.get("text", "") for b in j.get("content", []) if b.get("type") == "text")
    return text, j.get("stop_reason")


def parse_json(text):
    a, b = text.find("{"), text.rfind("}")
    if a < 0 or b < a:
        raise ValueError("no JSON in the reply")
    return json.loads(text[a:b + 1])


def call_stats(turns, rep):
    """Numbers we can measure ourselves instead of asking the model: talk share, length, time to the first price mention."""
    words = {"rep": 0, "lead": 0}
    last = first_price = 0
    for t in turns:
        last = max(last, int(t.get("end") or t["start"] or 0))
        who = "rep" if t["spk"] == rep else "lead"
        words[who] += len(t["text"].split())
        if not first_price and re.search(r"\$|\bprice\b|\bcost\b|how much|\bquote\b|\bbucks\b|hundred", t["text"], re.I) and t["start"] > 20:
            first_price = int(t["start"])
    tot = words["rep"] + words["lead"]
    return {"duration_sec": last, "rep_word_share_pct": round(words["rep"] * 100 / tot) if tot else None, "first_price_mention_sec": first_price or None}


def merge_turns(turns, rep, tags):
    by = {}
    for tg in tags or []:
        try:
            by[int(tg.get("i"))] = tg
        except Exception:
            pass
    out = []
    for t in turns:
        tg = by.get(t["i"], {})
        out.append({"i": t["i"], "t": t["t"], "start": t["start"], "end": t["end"], "spk": t["spk"], "role": ("rep" if t["spk"] == rep else "lead") if rep else "unknown", "text": t["text"],
                    "kind": tg.get("kind"), "topic": tg.get("topic"), "phase": tg.get("phase"), "script_step": tg.get("script_step"), "needs_response": bool(tg.get("needs_response")),
                    "answers_turn": tg.get("answers_turn"), "answered_by": tg.get("answered_by") or [], "quality": tg.get("quality")})
    return out


def cmd_mine(a):
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("Set ANTHROPIC_API_KEY first:  export ANTHROPIC_API_KEY=your-key")
    scripts = load_scripts(a.scripts)
    if scripts:
        print("Comparing every call against your scripts (%d characters)." % len(scripts))
    else:
        print("No scripts found in '%s'. Calls will be evaluated without a script comparison. (Put bundle.json or tint.json and coating.json there to compare.)" % a.scripts)
    extra = ""
    if ROSTER:
        extra += "\n\nThe sales reps who make these calls (the transcript may mishear the name; pick the closest): " + ", ".join(sorted(set(ROSTER.values()))) + "."
    if GLOSSARY:
        extra += "\nBusiness terms that may be misheard in the transcript: " + ", ".join(GLOSSARY[:80]) + "."
    system = [{"type": "text", "text": MINE_RULES + extra + ("\n\nSCRIPTS:\n" + scripts if scripts else "\n\nNo scripts were provided."), "cache_control": {"type": "ephemeral"}}]
    files = sorted(glob.glob(os.path.join(a.out, "transcripts", "*.txt")))
    if a.limit:
        files = files[:a.limit]
    os.makedirs(os.path.join(a.out, "mined"), exist_ok=True)
    todo, skipped = [], 0
    for f in files:
        base = os.path.splitext(os.path.basename(f))[0]
        if os.path.exists(os.path.join(a.out, "mined", base + ".json")):
            skipped += 1
        else:
            todo.append((f, base))
    counts = {"done": 0, "fail": 0}

    def work(n, item):
        f, base = item
        mp = os.path.join(a.out, "mined", base + ".json")
        text = open(f).read()
        turns = parse_turns(text, os.path.join(a.out, "transcripts", base + ".json"))
        if len(text.split()) < 40 or not turns:
            json.dump({"call": base, "meta": {"service": "other", "call_type": "voicemail"}, "outcome": {"result": "no_answer_or_voicemail"}, "scores": {"overall": 1}, "moments": [], "turns": merge_turns(turns, None, []), "summary": "too short to evaluate"}, open(mp, "w"))
            return
        try:
            user = "Transcript of one call (numbered turns):\n" + numbered(turns)[:90000] + "\n\nReturn the JSON."
            reply, stop = claude(a.model, a.effort, system, user, key, max_tokens=14000)
            if stop == "max_tokens":
                reply, stop = claude(a.model, a.effort, system, user + "\nBe more concise in every text field and tag only the substantive turns.", key, max_tokens=24000)
            data = parse_json(reply)
            data["call"] = base
            rep_spk = data.get("rep_speaker")
            data["stats"] = call_stats(turns, rep_spk)
            data["turns"] = merge_turns(turns, rep_spk, data.pop("turn_tags", []))
            json.dump(data, open(mp, "w"), ensure_ascii=False, indent=1)
            with LOCK:
                counts["done"] += 1
            m = data.get("meta") or {}
            say("[%d/%d] %s: agent %s, client %s, %s, %s, overall %s, %d moments, %d deviations" % (
                n, len(todo), base[:24], canon_agent(m.get("agent_name")), m.get("client_name"), m.get("service"), (data.get("outcome") or {}).get("result"),
                (data.get("scores") or {}).get("overall"), len(data.get("moments") or []), len((data.get("script") or {}).get("deviations") or [])))
        except Exception as e:
            with LOCK:
                counts["fail"] += 1
            say("[%d/%d] FAILED %s: %s" % (n, len(todo), base[:30], e))
            log_err(a.out, f, e)
    with ThreadPoolExecutor(max_workers=max(1, a.jobs)) as ex:
        list(ex.map(lambda t: work(t[0], t[1]), list(enumerate(todo, 1))))
    print("Analysis: %d new, %d already done, %d failed" % (counts["done"], skipped, counts["fail"]))


# ------------------------------------------------------------------ report
def fingerprint(c):
    ts = c.get("turns") or []
    head = " ".join(t.get("text", "") for t in ts[:6]).lower()
    head = re.sub(r"[^a-z0-9]+", " ", head).strip()[:160]
    return (head, int((g(c, "stats", "duration_sec", default=0) or 0) / 4))


def load_mined(out):
    """All analyzed calls, with duplicate recordings (the same call saved twice) counted once."""
    calls, seen = [], set()
    for f in sorted(glob.glob(os.path.join(out, "mined", "*.json"))):
        try:
            c = json.load(open(f))
        except Exception:
            continue
        fp = fingerprint(c)
        if fp[0] and fp in seen:
            continue
        seen.add(fp)
        calls.append(c)
    return calls


def g(d, *path, **kw):
    for p in path:
        if not isinstance(d, dict):
            return kw.get("default")
        d = d.get(p)
    return d if d is not None else kw.get("default")


def write_csv(path, rows, fields):
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def outcome_class(c):
    """win = deposit taken AND a date set. Booked without a deposit and callbacks are not wins."""
    r, w = g(c, "outcome", "result"), g(c, "outcome", "win")
    if g(c, "meta", "call_type") in ("voicemail", "wrong_number") or r == "no_answer_or_voicemail":
        return "no_conversation"
    if w is True or r == "deposit_taken":
        return "win"
    if r == "booked":
        return "booked_no_deposit"
    if r == "callback_set":
        return "callback"
    if r in ("not_interested", "lost_to_competitor", "no_decision"):
        return "loss"
    return "unclear"


def won(c):
    return outcome_class(c) == "win"


def agent_key(c):
    return canon_agent(g(c, "meta", "agent_name", default=""))


def agent_weights(calls):
    """How much to trust each rep's answers: their win rate, pulled toward the team average when they have few calls."""
    real = [c for c in calls if outcome_class(c) != "no_conversation"]
    if not real:
        return {}
    overall = len([c for c in real if won(c)]) / float(len(real))
    by = collections.defaultdict(list)
    for c in real:
        by[agent_key(c)].append(c)
    out = {}
    for name, cs in by.items():
        wins, n, k = len([c for c in cs if won(c)]), len(cs), 8.0
        sm = (wins + k * overall) / (n + k)
        rel = sm / overall if overall > 0 else 1.0
        out[name] = {"n": n, "wins": wins, "win_pct": round(100.0 * wins / n), "smoothed_pct": round(100 * sm), "weight": 1.0 if name == "Unknown" else round(max(0.6, min(1.8, rel)), 2)}
    return out


SHOP_FACTS = re.compile(r"jack.?s auto customs|jax auto customs|jacksonville|georgia|amco|walgreens|o.?reilly|hitek|hypex|xpel|llumar|ethos|square|halloween|\\$\\s?\\d[\\d,\\.]*|\\b\\d{3,4}\\s?(?:dollars|bucks)\\b", re.I)


def mask(text):
    t = re.sub(r"jack.?s auto customs|jax auto customs", "{shop}", text, flags=re.I)
    t = re.sub(r"\\$\\s?\\d[\\d,\\.]*", "{amount}", t)
    return t


def build_library(c, W):
    """Every thing a lead said that needed an answer, with the context before it and how the rep answered. This is what the live coach looks things up in."""
    turns = c.get("turns") or []
    byi = {t["i"]: t for t in turns}
    out = []
    for k, t in enumerate(turns):
        if t.get("role") != "lead" or not t.get("needs_response"):
            continue
        reps = [byi[i] for i in (t.get("answered_by") or []) if i in byi and byi[i].get("role") == "rep"]
        if not reps:
            j = k + 1
            while j < len(turns) and turns[j].get("role") != "lead" and len(reps) < 3:
                if turns[j].get("role") == "rep":
                    reps.append(turns[j])
                j += 1
        if not reps:
            continue
        q = [r.get("quality") for r in reps if isinstance(r.get("quality"), (int, float))] + ([t.get("quality")] if isinstance(t.get("quality"), (int, float)) else [])
        better = None
        for m in c.get("moments") or []:
            if abs(secs(m.get("t")) - int(t.get("start") or 0)) <= 6 and m.get("better_answer"):
                better = m["better_answer"]
                break
        out.append({"id": "%s#%d" % (str(c.get("call"))[:12], t["i"]), "call": c.get("call"), "agent": agent_key(c), "client": g(c, "meta", "client_name"), "service": g(c, "meta", "service"),
                    "result": g(c, "outcome", "result"), "won": won(c), "t": t.get("t"), "kind": t.get("kind"), "topic": t.get("topic"), "phase": t.get("phase"), "script_step": t.get("script_step"),
                    "lead_said": t.get("text"), "context_before": [{"role": x["role"], "text": x["text"]} for x in turns[max(0, k - 3):k]],
                    "rep_response": " ".join(r["text"] for r in reps), "rep_response_turns": [r["i"] for r in reps], "response_t": reps[0].get("t"),
                    "has_shop_facts": bool(SHOP_FACTS.search(" ".join(r["text"] for r in reps) + " " + str(better or ""))),
                    "quality": round(sum(q) / len(q), 1) if q else None, "better_answer": better})
        wgt = (W.get(agent_key(c)) or {}).get("weight", 1.0)
        out[-1]["agent_weight"] = wgt
        out[-1]["priority"] = round((out[-1]["quality"] or 0) * wgt * (1.25 if won(c) else 1.0), 2)
    return out


def cmd_report(a):
    calls = load_mined(a.out)
    if not calls:
        sys.exit("Nothing to report yet. Run the mine step first.")
    rows, dev, piv, mom, kn, trows, lib = [], [], [], [], [], [], []
    W = agent_weights(calls)
    for c in calls:
        sc = c.get("scores") or {}
        rows.append({"call": c.get("call"), "agent": agent_key(c), "client": g(c, "meta", "client_name"), "service": g(c, "meta", "service"),
                     "vehicle": " ".join(str(g(c, "meta", "vehicle", k) or "") for k in ("year", "make", "model")).strip(), "call_type": g(c, "meta", "call_type"),
                     "result": g(c, "outcome", "result"), "outcome_class": outcome_class(c), "price_quoted": g(c, "outcome", "price_quoted"), "evidence": g(c, "outcome", "evidence"),
                     "overall": sc.get("overall"), "rapport": sc.get("rapport"), "discovery": sc.get("discovery"), "aca": sc.get("aca_framework"), "pitch": sc.get("pitch"),
                     "objections": sc.get("objection_handling"), "close": sc.get("close"), "control": sc.get("control"),
                     "minutes": round((g(c, "stats", "duration_sec", default=0) or 0) / 60, 1), "rep_talk_pct": g(c, "stats", "rep_word_share_pct"), "first_price_sec": g(c, "stats", "first_price_mention_sec"),
                     "steps_skipped": ", ".join(g(c, "script", "steps_skipped", default=[]) or []), "deviations": len(g(c, "script", "deviations", default=[]) or []),
                     "summary": c.get("summary"), "lesson": g(c, "coaching", "one_lesson")})
        base = {"call": c.get("call"), "agent": agent_key(c), "service": g(c, "meta", "service"), "result": g(c, "outcome", "result")}
        for d in g(c, "script", "deviations", default=[]) or []:
            dev.append(dict(base, **{k: d.get(k) for k in ("t", "script_step", "type", "script_said", "rep_said", "impact", "keep_this")}))
        for p in c.get("pivotal") or []:
            piv.append(dict(base, **{k: p.get(k) for k in ("t", "kind", "description", "effect", "repeat_or_avoid")}))
        for m in c.get("moments") or []:
            mom.append(dict(base, **{k: m.get(k) for k in ("t", "kind", "topic", "quality", "lead_said", "rep_said", "why", "better_answer")}))
        for k in c.get("knowledge") or []:
            kn.append(dict(base, **{x: k.get(x) for x in ("topic", "claim", "said_by", "vs_script", "note")}))
        for t in c.get("turns") or []:
            trows.append(dict(base, client=g(c, "meta", "client_name"), **{x: t.get(x) for x in ("i", "t", "end", "role", "spk", "kind", "topic", "phase", "script_step", "needs_response", "answers_turn", "answered_by", "quality", "text")}))
        lib.extend(build_library(c, W))
    mom.sort(key=lambda r: (str(r.get("topic")), -(r.get("quality") or 0)))
    write_csv(os.path.join(a.out, "calls.csv"), rows, ["call", "agent", "client", "service", "vehicle", "call_type", "result", "outcome_class", "price_quoted", "evidence", "overall", "rapport", "discovery", "aca", "pitch", "objections", "close", "control", "minutes", "rep_talk_pct", "first_price_sec", "steps_skipped", "deviations", "summary", "lesson"])
    write_csv(os.path.join(a.out, "deviations.csv"), dev, ["call", "agent", "service", "result", "t", "script_step", "type", "script_said", "rep_said", "impact", "keep_this"])
    write_csv(os.path.join(a.out, "pivotal.csv"), piv, ["call", "agent", "service", "result", "t", "kind", "description", "effect", "repeat_or_avoid"])
    write_csv(os.path.join(a.out, "moments.csv"), mom, ["call", "agent", "service", "result", "t", "kind", "topic", "quality", "lead_said", "rep_said", "why", "better_answer"])
    write_csv(os.path.join(a.out, "knowledge.csv"), kn, ["call", "agent", "service", "topic", "claim", "said_by", "vs_script", "note"])
    json.dump(mom, open(os.path.join(a.out, "moments.json"), "w"), ensure_ascii=False, indent=1)
    write_csv(os.path.join(a.out, "turns_all.csv"), trows, ["call", "agent", "client", "service", "result", "i", "t", "end", "role", "spk", "kind", "topic", "phase", "script_step", "needs_response", "answers_turn", "answered_by", "quality", "text"])
    lib_all = lib
    # the working library: real exchanges only (not "ok / awesome" back and forth), no repeats of the same reply, rated 3 or better
    best = {}
    for r in lib_all:
        if len(str(r["lead_said"]).split()) < 4 or len(str(r["rep_response"]).split()) < 6 or (r.get("quality") or 0) < 3:
            continue
        if (r.get("topic") or "other") == "other" and r.get("kind") not in ("question", "objection", "buying_signal"):
            continue
        k = re.sub(r"[^a-z0-9]+", " ", str(r["rep_response"]).lower())[:120]
        if k not in best or (r["priority"] or 0) > (best[k]["priority"] or 0):
            best[k] = r
    lib = sorted(best.values(), key=lambda r: (str(r.get("topic")), -(r["priority"] or 0)))
    for r in lib:
        r["rep_response_masked"] = mask(r["rep_response"])
    with open(os.path.join(a.out, "response_library.jsonl"), "w") as fh:
        for r in lib:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(os.path.join(a.out, "response_library_all.jsonl"), "w") as fh:
        for r in lib_all:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    write_csv(os.path.join(a.out, "response_library.csv"), [dict(r, context_before=" | ".join("%s: %s" % (x["role"], x["text"]) for x in r["context_before"])) for r in lib],
              ["id", "call", "agent", "client", "service", "result", "won", "t", "kind", "topic", "phase", "script_step", "lead_said", "context_before", "rep_response", "rep_response_masked", "has_shop_facts", "response_t", "quality", "agent_weight", "priority", "better_answer"])
    # a readable playbook: the best real answers to each topic, from calls that booked first
    by_topic = collections.defaultdict(list)
    for r in lib:
        by_topic[r.get("topic") or "other"].append(r)
    with open(os.path.join(a.out, "response_playbook.md"), "w") as fh:
        fh.write("# Best real answers by topic\n\nSorted by priority: the rating, raised for reps who close well and for calls that won. Each entry shows what the lead said and what the rep said next.\n")
        for topic, rs in sorted(by_topic.items(), key=lambda kv: -len(kv[1])):
            rs.sort(key=lambda r: -(r["priority"] or 0))
            fh.write("\n## %s (%d times it came up)\n" % (topic, len(rs)))
            for r in rs[:6]:
                fh.write("\n- **Lead** (%s, %s, %s, rated %s): %s\n  **Rep (%s):** %s\n" % (r["service"], r["agent"], "booked" if r["won"] else str(r["result"]), r["quality"], r["lead_said"], r["t"], r["rep_response"]))
                if r.get("better_answer"):
                    fh.write("  *Better:* %s\n" % r["better_answer"])
    # per-agent table
    ag = collections.defaultdict(list)
    for c in calls:
        if outcome_class(c) != "no_conversation":
            ag[agent_key(c)].append(c)
    arows = []
    for name, cs in sorted(ag.items(), key=lambda kv: -len(kv[1])):
        def avg(k):
            v = [g(c, "scores", k) for c in cs if isinstance(g(c, "scores", k), (int, float))]
            return round(sum(v) / len(v), 2) if v else None
        w = W.get(name) or {}
        arows.append({"agent": name, "calls": len(cs), "wins": w.get("wins"), "win_pct": w.get("win_pct"), "smoothed_win_pct": w.get("smoothed_pct"), "weight": w.get("weight"),
                      "callbacks": len([c for c in cs if outcome_class(c) == "callback"]), "overall": avg("overall"), "discovery": avg("discovery"), "aca": avg("aca_framework"), "pitch": avg("pitch"),
                      "objections": avg("objection_handling"), "close": avg("close"), "control": avg("control")})
    write_csv(os.path.join(a.out, "agents.csv"), arows, ["agent", "calls", "wins", "win_pct", "smoothed_win_pct", "weight", "callbacks", "overall", "discovery", "aca", "pitch", "objections", "close", "control"])
    real = [c for c in calls if g(c, "outcome", "result") != "no_answer_or_voicemail" and g(c, "meta", "call_type") not in ("voicemail", "wrong_number")]
    # how many calls of each service, and how each one does
    sv = collections.defaultdict(list)
    for c in calls:
        sv[str(g(c, "meta", "service") or "unknown")].append(c)
    srows = []
    for name, cs in sorted(sv.items(), key=lambda kv: -len(kv[1])):
        rc = [c for c in cs if c in real]
        def avg2(vals):
            vals = [v for v in vals if isinstance(v, (int, float))]
            return round(sum(vals) / len(vals), 1) if vals else None
        srows.append({"service": name, "calls": len(cs), "real_conversations": len(rc), "wins": len([c for c in rc if won(c)]),
                      "win_pct_of_real": round(100 * len([c for c in rc if won(c)]) / len(rc)) if rc else None,
                      "callbacks_set": len([c for c in rc if g(c, "outcome", "result") == "callback_set"]),
                      "avg_overall_score": avg2([g(c, "scores", "overall") for c in rc]), "avg_minutes": avg2([(g(c, "stats", "duration_sec", default=0) or 0) / 60 for c in rc]),
                      "avg_rep_talk_pct": avg2([g(c, "stats", "rep_word_share_pct") for c in rc]), "avg_secs_to_price": avg2([g(c, "stats", "first_price_mention_sec") for c in rc])})
    write_csv(os.path.join(a.out, "services.csv"), srows, ["service", "calls", "real_conversations", "wins", "win_pct_of_real", "callbacks_set", "avg_overall_score", "avg_minutes", "avg_rep_talk_pct", "avg_secs_to_price"])
    print("\nCalls by service:")
    for r in srows:
        print("  %-12s %3d calls, %3d real conversations, %3d wins (%s%%), avg score %s" % (r["service"], r["calls"], r["real_conversations"], r["wins"], r["win_pct_of_real"], r["avg_overall_score"]))
    oc = collections.Counter(outcome_class(c) for c in calls)
    print("\nCalls analyzed: %d unique (%d real conversations). Wins (deposit and a date): %d. Booked without deposit: %d. Callbacks: %d. Lost: %d. Unclear: %d" % (
        len(calls), len(real), oc["win"], oc["booked_no_deposit"], oc["callback"], oc["loss"], oc["unclear"]))
    print("Agent win rates (adjusted pulls small samples toward the team average; weight is how much the coach trusts that rep's answers):")
    for r in arows:
        print("  %-12s %3d calls, %s wins (%s%%, adjusted %s%%), weight %s, overall score %s" % (r["agent"], r["calls"], r["wins"], r["win_pct"], r["smoothed_win_pct"], r["weight"], r["overall"]))
    tc = collections.Counter(m.get("topic") for m in mom)
    print("Questions and pushback by topic: " + ", ".join("%s %d" % (t, n) for t, n in tc.most_common(8)))
    print("Off-script moments: %d (%d marked worth keeping). Pivotal moments: %d. Product claims to verify: %d" % (len(dev), len([d for d in dev if d.get("keep_this")]), len(piv), len([k for k in kn if k.get("vs_script") != "matches"])))
    print("Full logs: %d turns across %d unique calls; %d lead statements linked to the rep's answer, %d kept in the working library (substantive, rated 3+, no repeats)." % (len(trows), len(calls), len(lib_all), len(lib)))
    print("  %d of those mention shop-specific facts (names, prices, brands, places). Do not let the coach learn those facts from other shops' calls." % len([r for r in lib if r.get("has_shop_facts")]))
    print("\nFiles in %s: calls.csv agents.csv deviations.csv pivotal.csv moments.csv knowledge.csv turns_all.csv response_library.csv response_playbook.md services.csv" % a.out)


# ------------------------------------------------------------------ learn
LEARN_SYSTEM = """You are the head of sales training for a car detailing shop (window tint, ceramic coating, paint correction, PPF). You are given compact digests of many analyzed sales calls (agent, service, outcome, scores, pivotal moments, off-script moments, lessons, product claims). Find patterns that repeat across calls; ignore one-offs unless they are striking. Be specific, quote the rep's words where the digest has them, and say how many calls support each point (for example "7 of 12 booked calls"). Never invent facts that are not in the digests."""

LEARN_ASK = """Write a markdown report with these sections:
1. What winning calls have in common (booked or deposit) versus losing calls
2. Best answers by topic (what is it, price, scratches, how long, warranty, objections...), quoting the strongest wording and noting which agent said it
3. Where reps beat the script and should keep it, and where going off script hurt
4. Pivotal moments that repeat: what turns calls, and what loses them
5. Questions leads ask that the script does not answer well (script gaps)
6. Product and process claims reps made that the script does not cover, grouped by topic, with a note on which look consistent across calls and which conflict (a human must verify these before the coach uses them)
7. Coaching notes per agent (strengths, fixes)
8. Ten specific rules the AI coach should follow, each tied to evidence"""


def digest(c):
    d = {"call": str(c.get("call", ""))[:8], "agent": agent_key(c), "service": g(c, "meta", "service"), "result": g(c, "outcome", "result"), "evidence": g(c, "outcome", "evidence"),
         "price": g(c, "outcome", "price_quoted"), "overall": g(c, "scores", "overall"), "scores": {k: g(c, "scores", k) for k in ("discovery", "aca_framework", "pitch", "objection_handling", "close", "control")},
         "talk_pct": g(c, "stats", "rep_word_share_pct"), "first_price_sec": g(c, "stats", "first_price_mention_sec"), "summary": c.get("summary"),
         "pivotal": [{"kind": p.get("kind"), "what": p.get("description"), "effect": p.get("effect")} for p in (c.get("pivotal") or [])[:4]],
         "deviations": [{"type": x.get("type"), "rep_said": x.get("rep_said"), "impact": x.get("impact"), "keep": x.get("keep_this")} for x in (g(c, "script", "deviations", default=[]) or [])[:5]],
         "best_moments": [{"topic": m.get("topic"), "lead": m.get("lead_said"), "rep": m.get("rep_said"), "q": m.get("quality")} for m in sorted(c.get("moments") or [], key=lambda m: -(m.get("quality") or 0))[:3]],
         "claims": [{"topic": k.get("topic"), "claim": k.get("claim"), "vs_script": k.get("vs_script")} for k in (c.get("knowledge") or []) if k.get("vs_script") != "matches"][:4],
         "lesson": g(c, "coaching", "one_lesson")}
    return d


def cmd_learn(a):
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("Set ANTHROPIC_API_KEY first.")
    calls = [c for c in load_mined(a.out) if g(c, "outcome", "result") != "no_answer_or_voicemail" and g(c, "meta", "call_type") not in ("voicemail", "wrong_number")]
    if len(calls) < 3:
        print("Need at least 3 real conversations to learn patterns. Skipping the learning step.")
        return
    system = [{"type": "text", "text": LEARN_SYSTEM}]
    chunks = [calls[i:i + 40] for i in range(0, len(calls), 40)]
    parts = []
    for n, ch in enumerate(chunks, 1):
        print("Learning from calls %d-%d of %d..." % ((n - 1) * 40 + 1, (n - 1) * 40 + len(ch), len(calls)))
        text, _ = claude(a.model, a.effort, system, "Digests of %d calls (JSON):\n%s\n\n%s" % (len(ch), json.dumps([digest(c) for c in ch], ensure_ascii=False), LEARN_ASK), key, max_tokens=8000)
        parts.append(text)
    if len(parts) > 1:
        print("Merging the batches...")
        text, _ = claude(a.model, a.effort, system, "Below are %d reports, each written from a different batch of calls. Merge them into ONE report with the same 8 sections. Keep counts honest by adding them up across batches, drop duplicates, and keep the best quotes.\n\n%s" % (len(parts), "\n\n=====\n\n".join(parts)), key, max_tokens=12000)
    else:
        text = parts[0]
    with open(os.path.join(a.out, "lessons.md"), "w") as fh:
        fh.write("# What we learned from %d calls\n\n%s\n" % (len(calls), text))
    print("Wrote %s" % os.path.join(a.out, "lessons.md"))


# ------------------------------------------------------------------ main
def list_audio(folder):
    return sorted(f for f in glob.glob(os.path.join(folder, "**", "*"), recursive=True) if f.lower().endswith(AUDIO_EXT))


def cmd_plan(a):
    files = list_audio(a.audio)
    if a.limit:
        files = files[:a.limit]
    seen, dups, secs_total, unknown = {}, 0, 0.0, 0
    for f in files:
        h = quick_hash(f)
        if h in seen:
            dups += 1
            continue
        seen[h] = f
        d = None
        if f.lower().endswith((".wav", ".wave")):
            try:
                import wave
                with wave.open(f) as w:
                    d = w.getnframes() / float(w.getframerate())
            except Exception:
                d = None
        if d is None:
            unknown += 1
            d = os.path.getsize(f) / 16000.0   # rough: ~128 kbps
        secs_total += d
    n = len(seen)
    mins = secs_total / 60.0
    print("Found %d recordings: %d unique, %d exact duplicates." % (len(files), n, dups))
    print("About %.0f hours of audio (%.0f minutes, average %.1f minutes a call)%s." % (mins / 60.0, mins, mins / max(1, n), "; sizes of %d non-WAV files estimated" % unknown if unknown else ""))
    print("Deepgram transcription: about $%.0f." % (mins * 0.0043))
    print("Claude analysis: about $%.0f with Sonnet, about $%.0f with Haiku (rough, depends on call length)." % (n * 0.20, n * 0.06))
    print("Time with --jobs 3: about %.0f minutes." % max(1, n * 1.0 / 3))
    print("\nRun it with:  python3 call_miner.py run %s --limit %d --jobs 3" % (a.audio, max(n, 1)))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("transcribe", "run", "mine", "report", "learn", "plan"):
        s = sub.add_parser(name)
        if name in ("transcribe", "run", "plan"):
            s.add_argument("audio", help="folder with the recordings")
            s.add_argument("--lang", default="en", help="en, es, or multi")
            s.add_argument("--smart", action="store_true", help="let Deepgram reformat numbers (off by default: it garbles prices)")
        if name != "plan":
            s.add_argument("--jobs", type=int, default=3, help="calls processed at the same time (default 3; lower it if you see rate-limit errors)")
            s.add_argument("--roster", default="roster.txt", help="rep names, one per line (optional)")
            s.add_argument("--glossary", default="glossary.txt", help="business words to get right (optional)")
        s.add_argument("--out", default="out")
        s.add_argument("--limit", type=int, default=0, help="only the first N files (use 30 for a pilot)")
        if name in ("run", "mine", "learn"):
            s.add_argument("--model", default=DEFAULT_MODEL, help="default %s; use claude-haiku-5-5 for a cheaper, shallower pass" % DEFAULT_MODEL)
            s.add_argument("--effort", default="medium", help="low, medium or high")
        if name in ("run", "mine"):
            s.add_argument("--scripts", default="scripts", help="folder with bundle.json (or tint.json and coating.json)")
        if name == "run":
            s.add_argument("--no-learn", action="store_true", help="skip the cross-call learning step")
    a = p.parse_args()
    if a.cmd != "plan":
        load_roster(a.roster)
        load_glossary(a.glossary)
        if ROSTER or GLOSSARY:
            print("Using %d rep names and %d key words" % (len(set(ROSTER.values())), len(GLOSSARY)))
    if a.cmd == "plan":
        cmd_plan(a)
    elif a.cmd == "transcribe":
        cmd_transcribe(a)
    elif a.cmd == "mine":
        cmd_mine(a)
    elif a.cmd == "report":
        cmd_report(a)
    elif a.cmd == "learn":
        cmd_learn(a)
    else:
        cmd_transcribe(a)
        cmd_mine(a)
        cmd_report(a)
        if not a.no_learn:
            cmd_learn(a)


if __name__ == "__main__":
    main()
