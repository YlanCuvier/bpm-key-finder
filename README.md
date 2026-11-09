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

Search Apple Music by song or artist and get the **BPM**, **key** (major/minor) and **Camelot code** of every track,
estimated from Apple's 30-second preview. Everything runs on your computer; nothing is saved.

## Install

Download the file for your system from the [latest release](../../releases/latest):

| System | File | How to open |
| --- | --- | --- |
| Windows | `BPM-Key-Finder-…-windows-setup.exe` | Double-click. If SmartScreen appears: **More info → Run anyway**. |
| macOS | `BPM-Key-Finder-…-mac.dmg` | Open it and drag the app to Applications. First launch: **right-click the app → Open → Open**. |
| Linux | `BPM-Key-Finder-…-linux.AppImage` | Right-click → Properties → allow executing, then double-click. Or `chmod +x` it and run it. |

The warnings appear because the app is not signed with a paid Apple/Microsoft developer certificate.

## Develop

```
npm install
npm start          # run the desktop app
npm run dist       # build an installer for the current system
```

`server.py` is the older web-server version (Python + ffmpeg + numpy), kept for hosting the page online.
