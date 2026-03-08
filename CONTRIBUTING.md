# Contributing to OpenPitch

Welcome! This document covers the project architecture, all recent changes and bug fixes, the messaging protocol between popup and content script, storage schema, and known limitations. Read this before touching anything.

---

## Table of Contents

- [Project Overview](#project-overview)
- [File Map](#file-map)
- [Architecture](#architecture)
  - [Audio Pipeline](#audio-pipeline)
  - [Popup ↔ Content Script Communication](#popup--content-script-communication)
  - [Storage Schema](#storage-schema)
  - [Video Lifecycle](#video-lifecycle)
- [Features Added (Changelog)](#features-added-changelog)
  - [1. Fine Tuning (Cents)](#1-fine-tuning-cents)
  - [2. Block Size Control](#2-block-size-control)
  - [3. Smart Processing](#3-smart-processing)
  - [4. Video Transition Reset](#4-video-transition-reset)
  - [5. YouTube-Only Messaging Guard](#5-youtube-only-messaging-guard)
  - [6. Popup ↔ Storage Live Sync](#6-popup--storage-live-sync)
- [Bug Fixes](#bug-fixes)
  - [Fix A: Audio Muting on Video Reuse](#fix-a-audio-muting-on-video-reuse)
  - [Fix B: yt-navigate-finish Race Condition](#fix-b-yt-navigate-finish-race-condition)
  - [Fix C: AudioContext Resume Reliability](#fix-c-audiocontext-resume-reliability)
  - [Fix D: Listener and Memory Leaks](#fix-d-listener-and-memory-leaks)
- [Known Limitations](#known-limitations)
- [Development Setup](#development-setup)
- [Guidelines for Contributors](#guidelines-for-contributors)

---

## Project Overview

OpenPitch is a Chrome extension (Manifest V3) that shifts the pitch of YouTube video audio in real time using the Web Audio API and [SoundTouch.js](https://github.com/nicatronTg/soundtouch-js). It changes pitch **without** affecting playback speed.

---

## File Map

```
open-pitch/
├── manifest.json               # MV3 manifest — DO NOT modify unless strictly necessary
├── content.js                  # Injected into YouTube — builds audio graph, handles pitch
├── popup.html                  # Extension popup UI (sliders, dropdown, toggle, button)
├── popup.js                    # Popup logic — reads UI, writes storage, sends messages
├── soundtouch-web-audio.js     # SoundTouch library — DO NOT modify
├── package.json                # npm metadata (no build step)
├── README.md                   # User-facing readme
└── CONTRIBUTING.md             # This file
```

### What each file does

| File | Role | Safe to edit? |
|------|------|---------------|
| `manifest.json` | Declares permissions, content scripts, popup | No — only if a fix strictly requires it |
| `soundtouch-web-audio.js` | SoundTouch DSP library (vendored) | **Never** |
| `content.js` | Audio processing — captures `<video>`, builds Web Audio graph, applies SoundTouch | Yes, carefully |
| `popup.html` | Popup UI markup and styles | Yes |
| `popup.js` | Popup logic — event listeners, storage, messaging | Yes |

---

## Architecture

### Audio Pipeline

```
                        pitch = 0 (bypass)
<video> ──► MediaElementSourceNode ──────────────────────► AudioContext.destination
                │                                                    ▲
                │        pitch ≠ 0 (processing)                      │
                └──► ScriptProcessorNode (SoundTouch) ──────────────┘
```

- **bypass mode**: When pitch is 0, audio flows directly from source to destination — no processing overhead.
- **processing mode**: When pitch ≠ 0, a `ScriptProcessorNode` sits between source and destination. Each audio block is fed into SoundTouch, processed, and written to the output buffer.

The `ScriptProcessorNode` buffer size is configurable via the Block Size setting (default `4096`).

### Popup ↔ Content Script Communication

The popup sends messages to the active YouTube tab. The content script listens and reacts.

| Message Type | Payload | Direction | Purpose |
|---|---|---|---|
| `SET_PITCH` | `{ type, semitones: float }` | popup → content | Set the pitch shift value (combined semitones + cents) |
| `SET_BLOCK_SIZE` | `{ type, blockSize: int }` | popup → content | Change the ScriptProcessorNode buffer size |

Both message senders in `popup.js` (`sendPitch`, `sendBlockSize`) include:
- A **YouTube URL guard** — only sends if `tab.url` includes `youtube.com`
- A **try-catch** — silently ignores errors if the content script isn't injected yet

### Storage Schema

All values are persisted in `chrome.storage.local` and restored when the popup opens or a page loads.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `pitch` | `number` | `0` | Semitone slider value (integer or half-step like `1.5`) |
| `pitchCents` | `number` | `0` | Fine-tuning cents value (-100 to +100) |
| `blockSize` | `number` | `4096` | ScriptProcessorNode buffer size |
| `smartProcessing` | `boolean` | `false` | Whether auto block-size selection is active |

The **effective pitch** sent to the content script is calculated as:

```
totalSemitones = pitch + (pitchCents / 100)
```

This single float is sent via `SET_PITCH`. The content script passes it directly to `soundtouch.pitchSemitones`, which handles sub-semitone precision natively.

### Video Lifecycle

YouTube is a single-page application. Video transitions happen without full page reloads. OpenPitch handles this through several mechanisms:

```
Page load → chrome.storage.local.get() → if pitch ≠ 0, wait for <video>, call init()
                                                                           │
yt-navigate-finish event ──► check if <video> element changed              │
  ├─ same element → do nothing (audio graph is still valid)                │
  └─ new element → teardown() → reset storage to defaults                  │
                                                                           │
Video 'ended' event ──► handleVideoEnded() → reset storage → teardown()    │
                                                                           │
init(semitones) ─────────────────────────────────────────────────────►──────┘
  ├─ if video element changed → teardown() first
  ├─ if no AudioContext → buildChain(video)
  └─ applyPitch(semitones)
```

**All storage values are reset to defaults on video transition** so each new video starts clean.

---

## Features Added (Changelog)

### 1. Fine Tuning (Cents)

**Files modified**: `popup.html`, `popup.js`

Added a second slider for sub-semitone precision.

- Range: -100 to +100, step 1, default 0
- The popup combines both values: `totalSemitones = semitones + (cents / 100)`
- Only the combined float is sent via `SET_PITCH` — the message shape did not change
- Both values persist independently in storage (`pitch`, `pitchCents`)
- The display rounds to 2 decimal places to avoid floating-point display noise

### 2. Block Size Control

**Files modified**: `popup.html`, `popup.js`, `content.js`

Exposed the `ScriptProcessorNode` buffer size as a user setting.

- Dropdown with options: 256, 512, 1024, 2048, **4096 (default)**, 8192
- Saved to storage as `blockSize`
- Sent to content script via new `SET_BLOCK_SIZE` message type
- `content.js` uses a `currentBlockSize` variable instead of a hardcoded constant
- Changing block size while pitch is active rebuilds the audio processor

### 3. Smart Processing

**Files modified**: `popup.html`, `popup.js`

Automatic block-size selection based on pitch magnitude.

| Pitch magnitude (abs) | Auto Block Size | Rationale |
|---|---|---|
| 0 – 3 semitones | 4096 | Light shift, large buffer is fine |
| 3 – 6 semitones | 2048 | Moderate shift |
| 6 – 9 semitones | 1024 | Heavy shift |
| 9 – 12 semitones | 512 | Maximum shift, smaller buffer for quality |

- Toggle switch in popup, persisted as `smartProcessing`
- When enabled: Block Size dropdown is visually disabled, auto value is sent on every pitch change
- When disabled: immediately sends the manual dropdown value, restoring control
- `content.js` does **not** need to know about this feature — it just receives `SET_BLOCK_SIZE`

### 4. Video Transition Reset

**Files modified**: `content.js`, `popup.js`

All pitch settings reset to defaults whenever a new video starts.

- **`content.js`**: Resets storage in both `handleVideoEnded` and `yt-navigate-finish`
- **`popup.js`**: A `chrome.storage.onChanged` listener syncs the UI in real time when storage is reset externally
- Reset values: `pitch: 0`, `pitchCents: 0`, `blockSize: 4096`, `smartProcessing: false`

### 5. YouTube-Only Messaging Guard

**Files modified**: `popup.js`

Both `sendPitch()` and `sendBlockSize()` now:
- Check `tab.url.includes('youtube.com')` before sending
- Wrap `chrome.tabs.sendMessage` in try-catch for gracefully handling tabs where the content script isn't injected

### 6. Popup ↔ Storage Live Sync

**Files modified**: `popup.js`

A `chrome.storage.onChanged` listener keeps the popup UI in sync when storage changes externally (e.g., content script resets on video transition).

> [!NOTE]
> This listener also fires for changes the popup itself makes (e.g., slider input → `storage.set`). This is safe because setting `.value` programmatically on an `<input>` does **not** fire the `input` DOM event — so there is no feedback loop or double-send.

---

## Bug Fixes

### Fix A: Audio Muting on Video Reuse

**File**: `content.js`

**Problem**: YouTube sometimes reuses the same `<video>` element across video transitions. The old `yt-navigate-finish` handler always called `teardown()`, which closes the `AudioContext`. When `buildChain()` was called again for the same `<video>`, `createMediaElementSource()` failed silently because the element was already captured by the now-closed context — resulting in a disconnected audio graph and **no sound**.

**Fix** (3 parts):
1. **`buildChain()`** — added an early-return guard: if `currentVideo === video` and the `AudioContext` is still open, skip rebuilding entirely
2. **`yt-navigate-finish`** — only calls `teardown()` if the DOM `<video>` element has actually changed (identity check, not equality)
3. **`buildChain()`** — registers an `'ended'` event listener on the video element that triggers `teardown()` when the video finishes naturally, ensuring the next video gets a fresh context
4. **`teardown()`** — removes the `'ended'` listener to prevent leaks

### Fix B: yt-navigate-finish Race Condition

**File**: `content.js`

**Problem**: The old handler called `chrome.storage.local.set(...)` (async) and then immediately called `chrome.storage.local.get(...)`. Since `set()` is asynchronous, there was a timing window where `get()` could read stale pre-reset values, causing `init()` to run with a non-zero pitch on a fresh video.

**Fix**: Removed the `get()` call entirely. After a navigation that triggers teardown, we know pitch has been reset to 0 — there is nothing to restore. The user will set pitch explicitly via the popup. Also reset `currentBlockSize = 4096` in-memory atomically alongside the storage write.

### Fix C: AudioContext Resume Reliability

**File**: `content.js`

**Problem**: Chrome requires a user gesture to resume an `AudioContext`. The old code registered `click`/`keydown` listeners using `() => audioCtx?.resume()`. This closure captured the `audioCtx` **variable** (not the value), so after teardown nulled it and `buildChain()` created a new context, a stale listener could attempt to resume a `null` reference (the `?.` prevented a crash, but it was semantically wrong and couldn't resume the correct context).

**Fix**: The resume handlers now capture a `const ctx = audioCtx` local reference inside `buildChain()`. Each closure targets the exact `AudioContext` it was created for. The handlers also check `ctx.state === 'suspended'` before calling `resume()` to avoid redundant calls.

### Fix D: Listener and Memory Leaks

**File**: `content.js`

**Problem**: The `click` and `keydown` resume listeners were registered with `{ once: true }` but were **never** removed in `teardown()`. If the user never clicked or pressed a key before a teardown (e.g., autoplay → navigate), the listeners would accumulate across rebuilds, each holding a closure reference to a different (now-closed) `AudioContext`.

**Fix**: Resume handlers are stored in top-level variables (`resumeClickHandler`, `resumeKeyHandler`). `teardown()` now explicitly removes both with `document.removeEventListener()` and nulls them. This ensures a clean slate for every `buildChain()` call.

### Audit: Storage Listener Feedback Loop (No Bug Found)

**File**: `popup.js`

**Verified**: The `chrome.storage.onChanged` listener fires for changes made by the popup itself. However, setting `.value` on an `<input>` or `<select>` programmatically does **not** dispatch the `input` or `change` DOM event, so no cascading write occurs. Added a clarifying comment in the code.

---

## Known Limitations

### ScriptProcessorNode Deprecation

Chrome logs a deprecation warning for `createScriptProcessor()`. The modern replacement is `AudioWorkletNode`, which requires:
1. A **separate JS file** loaded via `audioCtx.audioWorklet.addModule(url)`
2. The file must be accessible from the page's origin (requires `web_accessible_resources` in manifest)
3. The entire SoundTouch processing logic would need to be ported to worklet-compatible code

In a Manifest V3 content script, there is no clean, self-contained way to accomplish this without adding new files and significantly restructuring the audio processing. `ScriptProcessorNode` remains fully functional. Migration to `AudioWorklet` is deferred until a viable approach exists.

### YouTube SPA edge cases

YouTube's SPA navigation can be unpredictable. The `yt-navigate-finish` event is the most reliable signal, but edge cases with embedded players, YouTube Shorts, or mini-player transitions may exist.

---

## Development Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/KartikeyaKotkar/open-pitch.git
   ```

2. Open Chrome and navigate to `chrome://extensions`

3. Enable **Developer Mode** (toggle in the top right)

4. Click **Load unpacked** and select the project folder

5. Open any YouTube video and click the OpenPitch extension icon to test

### Making Changes

- Edit the files directly — there is no build step
- After editing, go to `chrome://extensions` and click the **reload** button (↻) on the OpenPitch card
- If you modified `content.js`, you must also **refresh the YouTube tab**
- If you modified `popup.html` or `popup.js`, just close and reopen the popup

### Debugging

- **Popup**: Right-click the extension icon → "Inspect popup"
- **Content script**: Open YouTube → F12 → Console tab → filter by `[OpenPitch]`
- **Storage**: In the popup DevTools console, run `chrome.storage.local.get(null, console.log)`

---

## Guidelines for Contributors

### Before you code

1. **Read the file you're modifying top to bottom** before making changes
2. Check the [Architecture](#architecture) section to understand how components interact
3. Review the [Bug Fixes](#bug-fixes) section — many of these were subtle and easy to reintroduce

### Rules

- **Do not modify** `soundtouch-web-audio.js` — it is a vendored library
- **Do not modify** `manifest.json` unless your change strictly requires it (and explain why in the PR)
- **Every `addEventListener`** in `content.js` must have a corresponding `removeEventListener` in `teardown()` or be registered with `{ once: true }`. Leaks are real bugs.
- **Never read storage immediately after writing it** — `chrome.storage.local.set()` is asynchronous. If you need to act on the value you just wrote, use the value directly, don't re-read it.
- **Closures in `buildChain()`** must capture `const ctx = audioCtx` locally. Never close over the `audioCtx` variable directly — teardown can null it at any time.
- Test your changes with these scenarios:
  - Play a video, change pitch, navigate to another video (SPA transition)
  - Let a video end naturally and confirm autoplay works with audio
  - Open the popup on a non-YouTube tab — the extension should do nothing
  - Open the popup, change pitch, then navigate — confirm the popup resets if still open

### Commit messages

Use clear, descriptive commit messages:
```
fix: prevent audio muting on YouTube video reuse
feat: add fine-tuning cents slider
refactor: track resume listeners for proper teardown cleanup
```
