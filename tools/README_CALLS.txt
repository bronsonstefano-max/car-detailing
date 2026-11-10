CALL PROJECT

1. Put your call recordings in the "audio" folder (start with about 30).
2. Put your call scripts in the "scripts" folder as bundle.json (already included if you downloaded the update folder).
   This lets the analysis compare every call to your script step by step.
3. Run it (double-click run_pilot.command, or in Terminal:  bash run_pilot.command).
4. Paste your Deepgram key and your Anthropic key when it asks. Nothing shows as you paste. That is normal.

What you get in the "out" folder:
  response_library.jsonl / .csv  EVERY thing a lead said that needed an answer, with the conversation just before it, the rep's exact reply, a 1-5 rating, a better answer when the reply was weak, and whether the call booked. This is what the live coach looks things up in.
  response_playbook.md           the best real answers to each topic, calls that booked first. Readable.
  turns_all.csv                  the full log: every sentence of every call with time, who said it (rep or lead), the exact words, and tags (what it was, topic, script step, which lead turn it answers, quality)
  lessons.md                     what winning calls have in common, best answers by topic, script gaps, rules for the AI coach
  services.csv                  how many tint, coating and other calls, with booking rate and average score for each
  calls.csv                      one row per call: agent, client, service, vehicle, result, price, scores, talk share, time to price
  agents.csv                     each rep's wins (deposit and a date), win rate adjusted for small samples, the weight the coach gives that rep, callbacks, and average scores
  deviations.csv                 every place a rep went off script, with whether it helped or hurt
  pivotal.csv                    the turning points in each call
  moments.csv                    the key questions and pushback with better answers
  knowledge.csv                  product claims made on calls that the script does not cover (verify before the coach uses them)
  closing.csv                    per call: how many times the deposit was asked, how soon after the price, payment route, whether a date was offered, callback time, the exact closing words, price framing, upsells
  missed_closes.csv              every moment a lead showed a buying signal and the rep did not ask for the deposit, with the exact line that would have
  objection_stats.csv            per objection type: how often, how often those calls won, how the lead reacted, and the best reply
  knowledge_conflicts.csv        facts that different reps told leads differently (warranty, timing...). You decide the right answer once
  holdout_pairs.jsonl            calls set aside (10%) and never used for learning; the coach is tested on these later
  mined/                         the full deep record for each call, including every turn
  transcripts/                   the raw transcripts

Wins/losses: win = deposit taken and a date set. Callbacks are a soft loss. Each library row has agent_weight and priority; sort by priority to see the best answers from the best closers.
Setup: roster.txt (rep names) and glossary.txt (business words) improve names and accuracy. Run  python3 call_miner.py plan audio  to see size and cost first.

Cost: about a nickel or two per call with the default model. Add  --model claude-haiku-5-5  for a cheaper, shallower pass.
To process more later:  python3 call_miner.py run audio --limit 700 --jobs 3   (it skips calls it already finished)
To redo the analysis after an update (keeps the transcripts, so no new transcription cost): delete the "mined" folder inside "out", then run it again.

Keys: Deepgram = console.deepgram.com > API Keys. Anthropic = console.anthropic.com > API Keys.
Never paste the keys into chat or email.

Extra inputs (all optional):
  roster.txt / glossary.txt      rep names and business words
  metadata.csv                   file, phone, date, direction, source for each recording (see metadata.csv.example). Dates and phone numbers are also read from file names if they are there
  results.csv                    phone, date, type (deposit / booked / job), amount from your CRM (see results.csv.example). When present, real deposits decide what counts as a win, not the AI's reading
Redo after an update: delete out/mined, run again (transcripts are kept, so no new Deepgram cost).
