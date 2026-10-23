---
title: BPM & Key Finder
emoji: 🎵
colorFrom: red
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# BPM & Key Finder

Search Apple Music (song or artist) and get the BPM, key (major/minor) and Camelot code of each track,
estimated from Apple's 30-second preview. Audio is analyzed in memory and never saved.

Run locally: `pip install numpy`, install ffmpeg, then `python3 server.py` and open http://localhost:8765.
