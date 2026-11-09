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
  calls.csv                      one row per call: agent, client, service, vehicle, result, price, scores, talk share, time to price
  agents.csv                     each agent's booking rate and average scores
  deviations.csv                 every place a rep went off script, with whether it helped or hurt
  pivotal.csv                    the turning points in each call
  moments.csv                    the key questions and pushback with better answers
  knowledge.csv                  product claims made on calls that the script does not cover (verify before the coach uses them)
  mined/                         the full deep record for each call, including every turn
  transcripts/                   the raw transcripts

Cost: about a nickel or two per call with the default model. Add  --model claude-haiku-5-5  for a cheaper, shallower pass.
To process more later:  python3 call_miner.py run audio --limit 500   (it skips calls it already finished)
To redo the analysis after an update (keeps the transcripts, so no new transcription cost): delete the "mined" folder inside "out", then run it again.

Keys: Deepgram = console.deepgram.com > API Keys. Anthropic = console.anthropic.com > API Keys.
Never paste the keys into chat or email.
