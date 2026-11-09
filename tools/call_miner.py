#!/usr/bin/env python3
"""Call miner: turn a folder of sales-call recordings into a short list of the moments worth teaching the AI coach.

Runs on your own computer. Only needs python3 and curl (both come with a Mac). Your keys stay on your computer.

  export DEEPGRAM_API_KEY=...        # transcription (console.deepgram.com)
  export ANTHROPIC_API_KEY=...       # analysis (console.anthropic.com)
  python3 call_miner.py run audio --limit 30

Steps (each one can also be run alone, and every step skips work that is already done):
  transcribe  audio files  -> out/transcripts/*.json and *.txt   (Deepgram)
  mine        transcripts  -> out/mined/*.json                   (Claude: finds the questions, pushback, and how the rep answered)
  report      mined        -> out/moments.csv and out/moments.json
"""
import argparse, csv, glob, json, os, re, subprocess, sys, time

AUDIO_EXT = (".wav", ".wave", ".mp3", ".m4a", ".mp4", ".ogg", ".opus", ".flac", ".aac", ".webm")
DG_BASE = os.environ.get("DEEPGRAM_BASE", "https://api.deepgram.com")
AN_BASE = os.environ.get("ANTHROPIC_BASE", "https://api.anthropic.com")

TOPICS = "what_is_it, price, scratches_swirls, how_long, warranty, brand_or_film, legal_tint, location, booking_time, deposit_or_payment, wax_comparison, need_to_think, spouse, send_me_info, shopping_around, too_expensive, other"

MINE_SYSTEM = f"""You review a recorded sales phone call for a car detailing shop that sells window tint and ceramic coating (including paint correction). The transcript labels speakers only as S0/S1 (or C0/C1); work out which one is the sales rep (the one introducing the shop and pitching) and which is the lead.

Find the moments where the lead asked a question or pushed back, and judge how the rep answered. Return ONLY one JSON object, no markdown:
{{"service": "tint|coating|other", "outcome": "booked|not_booked|unclear", "outcome_evidence": "short reason (for example: a date was set and a deposit was taken)", "rep_speaker": "S0", "summary": "one sentence",
 "moments": [{{"kind": "question|objection", "topic": "one of: {TOPICS}", "lead_said": "what the lead said, close to verbatim", "rep_said": "the rep's answer, close to verbatim (up to about 60 words)", "quality": 1-5, "why": "one short sentence on why the answer was good or weak"}}]}}

Rules: use only what is actually in the transcript. Quality 5 = clear, confident, answers the question, then steers back with a question; 1 = vague, wrong, or lost the lead. Skip small talk. Include at most 12 moments. If the call is voicemail, wrong number or too short to matter, return "moments": [] and "outcome": "unclear"."""


def sh(args, stdin=None):
    p = subprocess.run(args, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return p.returncode, p.stdout, p.stderr


def retry(fn, tries=4):
    last = None
    for i in range(tries):
        try:
            return fn()
        except Exception as e:  # noqa
            last = e
            time.sleep(2 * (2 ** i))
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


def transcribe_one(path, lang, key):
    ch = wav_channels(path) if path.lower().endswith(".wav") else 1
    q = "model=nova-3&smart_format=true&punctuate=true&utterances=true&language=%s" % lang
    q += "&multichannel=true" if ch == 2 else "&diarize=true"
    ctype = {"wav": "audio/wav", "mp3": "audio/mpeg", "m4a": "audio/mp4", "mp4": "audio/mp4", "ogg": "audio/ogg", "flac": "audio/flac", "aac": "audio/aac", "webm": "audio/webm"}.get(path.rsplit(".", 1)[-1].lower(), "application/octet-stream")

    def go():
        code, out, err = sh(["curl", "-sS", "--max-time", "600", "-X", "POST", "%s/v1/listen?%s" % (DG_BASE, q),
                             "-H", "Authorization: Token " + key, "-H", "Content-Type: " + ctype, "--data-binary", "@" + path])
        if code != 0:
            raise RuntimeError("curl failed: " + err.decode("utf-8", "ignore")[:200])
        j = json.loads(out.decode("utf-8"))
        if j.get("err_code") or j.get("error"):
            raise RuntimeError(str(j.get("err_msg") or j.get("error"))[:200])
        return j
    j = retry(go)
    label = "C" if ch == 2 else "S"
    lines = []
    for u in (j.get("results", {}).get("utterances") or []):
        who = u.get("channel") if ch == 2 else u.get("speaker")
        lines.append("[%s] %s%s: %s" % (mmss(u.get("start")), label, who if who is not None else "?", str(u.get("transcript", "")).strip()))
    return j, "\n".join(lines)


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
    done = fail = skipped = 0
    for i, f in enumerate(files, 1):
        base = os.path.splitext(os.path.basename(f))[0]
        tp = os.path.join(a.out, "transcripts", base + ".txt")
        if os.path.exists(tp) and os.path.getsize(tp) > 0:
            skipped += 1
            continue
        try:
            j, text = transcribe_one(f, a.lang, key)
            with open(os.path.join(a.out, "transcripts", base + ".json"), "w") as fh:
                json.dump({"file": os.path.basename(f), "duration": j.get("metadata", {}).get("duration")}, fh)
            with open(tp, "w") as fh:
                fh.write(text or "(no speech found)")
            done += 1
            print("[%d/%d] transcribed %s (%d lines)" % (i, len(files), os.path.basename(f), text.count("\n") + 1))
        except Exception as e:
            fail += 1
            print("[%d/%d] FAILED %s: %s" % (i, len(files), os.path.basename(f), e))
            with open(os.path.join(a.out, "errors.log"), "a") as fh:
                fh.write("%s\t%s\n" % (f, e))
    print("Transcription: %d new, %d already done, %d failed" % (done, skipped, fail))


def claude(model, effort, system, user, key):
    body = json.dumps({"model": model, "max_tokens": 3000, "output_config": {"effort": effort},
                       "system": system, "messages": [{"role": "user", "content": user}]})

    def go():
        code, out, err = sh(["curl", "-sS", "--max-time", "120", "-X", "POST", AN_BASE + "/v1/messages",
                             "-H", "content-type: application/json", "-H", "x-api-key: " + key, "-H", "anthropic-version: 2023-06-01", "-d", "@-"], stdin=body.encode("utf-8"))
        if code != 0:
            raise RuntimeError("curl failed: " + err.decode("utf-8", "ignore")[:200])
        j = json.loads(out.decode("utf-8"))
        if j.get("type") == "error":
            raise RuntimeError(str((j.get("error") or {}).get("message"))[:200])
        return j
    j = retry(go)
    return "".join(b.get("text", "") for b in j.get("content", []) if b.get("type") == "text")


def parse_json(text):
    a, b = text.find("{"), text.rfind("}")
    if a < 0 or b < a:
        raise ValueError("no JSON in the reply")
    return json.loads(text[a:b + 1])


def cmd_mine(a):
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("Set ANTHROPIC_API_KEY first:  export ANTHROPIC_API_KEY=your-key")
    files = sorted(glob.glob(os.path.join(a.out, "transcripts", "*.txt")))
    if a.limit:
        files = files[:a.limit]
    os.makedirs(os.path.join(a.out, "mined"), exist_ok=True)
    done = fail = skipped = 0
    for i, f in enumerate(files, 1):
        base = os.path.splitext(os.path.basename(f))[0]
        mp = os.path.join(a.out, "mined", base + ".json")
        if os.path.exists(mp):
            skipped += 1
            continue
        text = open(f).read()
        if len(text.split()) < 40:
            json.dump({"service": "other", "outcome": "unclear", "moments": [], "summary": "too short"}, open(mp, "w"))
            skipped += 1
            continue
        try:
            reply = claude(a.model, a.effort, MINE_SYSTEM, "Transcript:\n" + text[:60000] + "\n\nReturn the JSON.", key)
            data = parse_json(reply)
            data["call"] = base
            json.dump(data, open(mp, "w"), ensure_ascii=False, indent=1)
            done += 1
            print("[%d/%d] mined %s: %s, %s, %d moments" % (i, len(files), base[:30], data.get("service"), data.get("outcome"), len(data.get("moments") or [])))
        except Exception as e:
            fail += 1
            print("[%d/%d] FAILED %s: %s" % (i, len(files), base[:30], e))
            with open(os.path.join(a.out, "errors.log"), "a") as fh:
                fh.write("%s\t%s\n" % (f, e))
    print("Analysis: %d new, %d already done, %d failed" % (done, skipped, fail))


def cmd_report(a):
    rows = []
    calls = {"booked": 0, "not_booked": 0, "unclear": 0}
    for f in sorted(glob.glob(os.path.join(a.out, "mined", "*.json"))):
        d = json.load(open(f))
        calls[d.get("outcome") if d.get("outcome") in calls else "unclear"] += 1
        for m in d.get("moments") or []:
            rows.append({"call": d.get("call") or os.path.basename(f)[:-5], "service": d.get("service"), "outcome": d.get("outcome"), "kind": m.get("kind"), "topic": m.get("topic"),
                         "quality": m.get("quality"), "lead_said": m.get("lead_said"), "rep_said": m.get("rep_said"), "why": m.get("why")})
    rows.sort(key=lambda r: (str(r["topic"]), -(r["quality"] or 0)))
    with open(os.path.join(a.out, "moments.json"), "w") as fh:
        json.dump(rows, fh, ensure_ascii=False, indent=1)
    with open(os.path.join(a.out, "moments.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["call", "service", "outcome", "kind", "topic", "quality", "lead_said", "rep_said", "why"])
        w.writeheader()
        w.writerows(rows)
    print("\nCalls: %d booked, %d not booked, %d unclear" % (calls["booked"], calls["not_booked"], calls["unclear"]))
    by = {}
    for r in rows:
        by.setdefault(r["topic"], []).append(r)
    print("Moments found: %d" % len(rows))
    for t, rs in sorted(by.items(), key=lambda kv: -len(kv[1])):
        good = len([r for r in rs if (r["quality"] or 0) >= 4])
        print("  %-22s %3d moments, %d rated 4-5" % (t, len(rs), good))
    print("\nFiles written: %s and %s" % (os.path.join(a.out, "moments.csv"), os.path.join(a.out, "moments.json")))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("transcribe", "run"):
        s = sub.add_parser(name)
        s.add_argument("audio", help="folder with the recordings")
        s.add_argument("--out", default="out")
        s.add_argument("--limit", type=int, default=0, help="only the first N files (use 30 for a pilot)")
        s.add_argument("--lang", default="en", help="en, es, or multi")
        s.add_argument("--model", default="claude-haiku-5-5")
        s.add_argument("--effort", default="low")
    for name in ("mine", "report"):
        s = sub.add_parser(name)
        s.add_argument("--out", default="out")
        s.add_argument("--limit", type=int, default=0)
        s.add_argument("--model", default="claude-haiku-5-5")
        s.add_argument("--effort", default="low")
    a = p.parse_args()
    if a.cmd == "transcribe":
        cmd_transcribe(a)
    elif a.cmd == "mine":
        cmd_mine(a)
    elif a.cmd == "report":
        cmd_report(a)
    else:
        cmd_transcribe(a)
        a.limit = a.limit
        cmd_mine(a)
        cmd_report(a)


if __name__ == "__main__":
    main()
