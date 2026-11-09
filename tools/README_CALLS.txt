CALL PROJECT

1. Put your call recordings (start with about 30) in the "audio" folder.
2. Put your call scripts in the "scripts" folder as bundle.json (the copied scripts text saved as a file).
   This lets the analysis compare every call to your script, step by step. It still works without it.
3. Run it (double-click run_pilot.command, or in Terminal:  bash run_pilot.command).
4. Paste your Deepgram key and your Anthropic key when it asks. Nothing shows as you paste. That is normal.

What you get in the "out" folder:
  lessons.md      what winning calls have in common, best answers by topic, script gaps, rules for the AI coach
  calls.csv       one row per call: agent, client, service, vehicle, result, price, scores, talk share, time to price
  agents.csv      each agent's booking rate and average scores
  deviations.csv  every place a rep went off script, with whether it helped or hurt
  pivotal.csv     the turning points in each call
  moments.csv     every lead question or pushback, how it was answered, and a better answer
  knowledge.csv   product claims made on calls that the script does not cover (verify these before the coach uses them)
  mined/          the full deep record for each call

Cost: about a nickel per call with the default model. Add  --model claude-haiku-5-5  for a cheaper, shallower pass.
To process more later:  python3 call_miner.py run audio --limit 500   (it skips calls it already finished)

Keys: Deepgram = console.deepgram.com > API Keys. Anthropic = console.anthropic.com > API Keys.
Never paste the keys into chat or email.
