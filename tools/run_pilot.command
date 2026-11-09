#!/bin/bash
# Double-click this file (or run it in Terminal). It asks for your two keys, then transcribes and analyzes the recordings in the "audio" folder next to it.
cd "$(dirname "$0")" || exit 1
echo "=== Call miner ==="
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is not installed. Open Terminal, type: xcode-select --install   then run this again."; read -r -p "Press Enter to close."; exit 1
fi
mkdir -p audio scripts
if [ ! -f scripts/bundle.json ] && [ ! -f scripts/tint.json ]; then echo "Tip: put your scripts file in the scripts folder as bundle.json to compare every call to your script."; fi
count=$(ls audio 2>/dev/null | grep -ciE '\.(wav|mp3|m4a|mp4|ogg|flac|aac|webm)$')
if [ "$count" -eq 0 ]; then
  echo "The audio folder is empty. Put your call recordings in:"; echo "  $(pwd)/audio"; open audio; read -r -p "Then run this again. Press Enter to close."; exit 0
fi
echo "Found $count recordings. The first 30 will be processed (the rest later)."
if [ -z "$DEEPGRAM_API_KEY" ]; then read -r -s -p "Paste your Deepgram key, press Enter (nothing will show as you paste): " DEEPGRAM_API_KEY; echo; fi
if [ -z "$ANTHROPIC_API_KEY" ]; then read -r -s -p "Paste your Anthropic key, press Enter: " ANTHROPIC_API_KEY; echo; fi
export DEEPGRAM_API_KEY ANTHROPIC_API_KEY
python3 call_miner.py run audio --limit "${1:-30}"
echo
echo "Done. Your results are in the out folder. Start with lessons.md and calls.csv."
open out 2>/dev/null
read -r -p "Press Enter to close."
