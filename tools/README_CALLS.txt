CALL PROJECT

1. Put your call recordings (start with about 30) in the "audio" folder.
2. Double-click "run_pilot.command". (First time on a Mac: right-click it, choose Open, then Open again.)
3. Paste your Deepgram key and your Anthropic key when it asks. Nothing shows as you paste. That is normal.
4. When it finishes, the "out" folder opens. Send moments.csv back (or paste the summary it printed).

Keys: Deepgram = console.deepgram.com > API Keys. Anthropic = console.anthropic.com > API Keys.
Never paste the keys into chat or email.
To process more later, run it again in Terminal:  python3 call_miner.py run audio --limit 500
It skips calls it already finished.
