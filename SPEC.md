# Finance Solver Web App (PWA) - Design Specification (Revised)

**Date:** 2026-07-13
**Status:** Revised - replatformed from native iOS to mobile web after design review
**Platform:** Mobile web app (PWA), used in Safari on iPhone
**Development:** Built entirely on this Windows machine. No Mac, no Xcode, no App Store.

## Overview

A PhotoMath-style web app for finance homework: photograph a finance problem on a
laptop screen using the phone's browser camera, the image is sent directly to the
Claude API with the finance-solver skill as system prompt, and paste-ready Excel
formulas display on screen. Added to the iPhone home screen, it launches full-screen
and behaves like an app.

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Image-direct, no OCR.** Send the photo straight to Claude. | Screen photos are OCR's worst case (moire, glare); OCR destroys cash-flow table structure; a silently mangled digit produces a confidently wrong formula. Claude vision preserves layout. |
| 2 | **No crop UI.** Pinch-to-zoom on viewfinder; prompt tells Claude to solve every finance problem visible. | Effortless capture loop; extra solved problems are labeled, harmless. |
| 3 | **Model: `claude-sonnet-4-5`**, defined in one constant. | Correctness over pennies; constant allows trivial Haiku test later. |
| 4 | **`ERROR:` sentinel contract** for unreadable/non-finance images. | One line of JS cleanly separates formula state from error state. |
| 5 | **Auto-send on shutter tap.** No preview/confirm step. Frozen captured frame shown during processing. | One tap per problem; bad shot costs ~$0.01 and is caught by the error path. |
| 6 | **Non-streaming API call.** Client returns a plain string. | ~200 output tokens; streaming complexity not worth 2-3s of perceived latency in v1. |
| 7 | **Image resized to 1568px long edge, JPEG ~0.8** via canvas. | Anthropic downscales beyond ~1568px anyway; keeps small screen text legible; ~300-600KB upload. |
| 8 | **401 anywhere → clear key, return to Setup.** | Key rotation for free, no settings screen needed. |
| 9 | **Five-state state machine** drives the whole app. | It is a kiosk, not a navigation app. |
| 10 | **Web app, not native iOS.** Vanilla HTML/CSS/JS, zero dependencies, no build step. | Native iOS requires Xcode on a Mac; this project is developed on a Windows machine. A PWA loses nothing this app needs: camera, network, and text display all work in Safari. |
| 11 | **Direct browser → Anthropic API** with the `anthropic-dangerous-direct-browser-access: true` header. No backend. | Single-user personal tool; a proxy server is pure overhead. The header is Anthropic's explicit opt-in for browser-side calls. |
| 12 | **API key in `localStorage`.** | No Keychain on the web. Plaintext-on-device is acceptable for a personal phone and a rotatable, spend-capped key. Never logged or displayed after entry. |
| 13 | **Pinch-to-zoom is digital**: CSS transform on the live preview, matching center-crop of the capture canvas. | iOS Safari support for the native `zoom` media-track constraint is inconsistent across versions/devices; digital crop is deterministic. Capture at max stream resolution so crops keep enough pixels. |
| 14 | **Hosted as static files on a free HTTPS host** (e.g. GitHub Pages). | `getUserMedia` requires a secure context: HTTPS on the phone, plain `localhost` OK for desktop dev. Static hosting is free and the repo contains no secrets (key is entered at runtime). |

## User Flow

1. Open from home screen icon → camera viewfinder immediately visible (setup screen on first launch only)
2. Point at finance problem, pinch to zoom if needed
3. Tap shutter → frame freezes, `PROCESSING...` indicator
4. Image resized and sent to Claude with skill as system prompt
5. Formulas display in large monospace text
6. User types formulas into Excel on the laptop (no tap-to-copy in v1)
7. `[ SOLVE ANOTHER ]` returns to camera

## State Machine

```
const AppState = {
    SETUP:      'setup',        // no key in localStorage
    CAMERA:     'camera',       // live viewfinder
    PROCESSING: 'processing',   // frozen captured frame + indicator
    RESULTS:    'results',      // raw formula text from Claude
    ERROR:      'error',        // user-facing message + retry
};
// current state + payload (frozen frame dataURL, result text, or error message)
```

Transitions:

```
load ──────────────────► SETUP        (no key in localStorage)
load ──────────────────► CAMERA       (key exists)
SETUP ─── validate OK ──► CAMERA
CAMERA ── shutter ──────► PROCESSING(frame)   [auto-send, resized]
PROCESSING ── reply ────► RESULTS(text)       (no "ERROR:" prefix)
PROCESSING ── "ERROR:" or API/network failure ──► ERROR(message)
PROCESSING ── HTTP 401 ─► SETUP               (key cleared)
RESULTS ── SOLVE ANOTHER ─► CAMERA
ERROR ──── TRY AGAIN ─────► CAMERA
```

One state object, one `setState(state, payload)` function that shows/hides the
matching `<section>`. No router, no framework.

## Architecture

### Components

**1. Camera (camera.js)**
- `getUserMedia({ video: { facingMode: 'environment', width/height: ideal max } })`
- Full-screen `<video>` preview; pinch gesture (two-pointer `touchmove`) scales a
  CSS transform on the video, clamped 1x-5x
- Shutter tap: draw current video frame to an offscreen canvas, center-cropped to
  the visible (zoomed) region → immediately transitions to PROCESSING with the
  frozen frame
- Stream stopped when leaving camera state (battery), reacquired on return
- Page pinch-zoom disabled (`touch-action: none` on the viewfinder) so the gesture
  only zooms the camera

**2. ClaudeAPIClient (api.js)**
- `fetch` POST to `https://api.anthropic.com/v1/messages`, non-streaming
- Headers: `x-api-key`, `anthropic-version: 2023-06-01`,
  `anthropic-dangerous-direct-browser-access: true`, `content-type: application/json`
- Request: base64 JPEG image block + short user instruction
- System prompt = app wrapper text (in code) + verbatim contents of
  `finance-solver-skill.txt` (fetched once at load)
- Wrapper text (lives in api.js, NOT in the skill file, so the skill can be
  re-synced without clobbering app instructions):
  > "You will receive a photo of a computer screen. Solve every finance problem
  > visible in the image according to the rules below. If the image is
  > unreadable, or contains no finance problem, respond with exactly one line
  > starting with `ERROR:` followed by a brief reason."
- Model ID `claude-sonnet-4-5` in a single constant
- Returns raw text or throws typed errors (network, HTTP status, parse).
  Caller checks `startsWith("ERROR:")`.

**3. ImageProcessor (image.js)**
- Resize captured frame to 1568px long edge via canvas, encode
  `toBlob('image/jpeg', 0.8)`, convert to base64

**4. Results screen (section in index.html)**
- Renders raw response text line by line: lines starting with `=` are formulas
  (large white monospace); other lines are labels/notes (gray)
  (skill output format preserved verbatim)
- `[ SOLVE ANOTHER ]` button

**5. Setup screen (section in index.html)**
- API key entry field + link to console.anthropic.com
- Validate = minimal messages call (`max_tokens: 1`, user message `"hi"`)
  - 200 → store in localStorage, proceed to camera
  - 401 → "INVALID API KEY"
  - Network failure → "CHECK CONNECTION" (do not reject the key)
- Also shown whenever a 401 occurs later (key cleared first, "KEY NO LONGER VALID")

**6. Storage (storage.js or inline)**
- `localStorage` get/set/remove for the API key. Never logged or displayed after entry.

**7. Resources**
- `finance-solver-skill.txt`: verbatim copy of the finance-solver SKILL.md
  (~700 tokens); fetched at app load
- `manifest.json`: name, `display: standalone`, black background/theme color,
  so Add to Home Screen launches full-screen without Safari chrome

### Data Flow

```
<video> → canvas frame → ImageProcessor → ClaudeAPIClient → string
                                               │
                               "ERROR:" prefix ─► ERROR state
                               HTTP 401 ────────► SETUP (key cleared)
                               other failure ───► ERROR state
                               otherwise ───────► RESULTS state
```

## Design Language: ASCII Minimalism

Monochrome, plaintext, undecorated. The formulas are the only visual event.

- **Palette:** pure black `#000000` background, white `#FFFFFF` text, one gray
  `#8E8E8E` for secondary text. No accent color, no gradients, no shadows.
- **Typography:** monospace everywhere, including buttons and labels:
  `font-family: ui-monospace, 'SF Mono', Menlo, monospace`. No webfonts, no icons.
- **Buttons are text:** `[ SOLVE ANOTHER ]`, `[ TRY AGAIN ]`, `[ VALIDATE ]`,
  `[ CAPTURE ]` — bracketed uppercase monospace strings, no filled shapes.
- **Dividers:** box-drawing / ASCII rules (`────────`) where separation is needed.
- **Processing state:** frozen frame dimmed to ~40%, overlaid with plain
  `PROCESSING...` text and a blinking block cursor (`▌`, CSS animation). No spinners.
- **Results screen:** black screen, formulas in large white monospace exactly as
  returned. Labels/notes render in the gray secondary color. Nothing else on
  screen except `[ SOLVE ANOTHER ]` at the bottom.
- **Motion:** none beyond the blinking cursor. Respects Reduce Motion trivially
  by having nothing to reduce.

## Technical Specifications

- Vanilla HTML/CSS/JS (ES2020+). No framework, no build step, no dependencies.
- Target: iOS Safari 16+ (getUserMedia, canvas, fetch, localStorage all standard)
- Layout: `100dvh` full-height sections, `viewport-fit=cover`, safe-area insets
- PWA: `manifest.json` + `apple-mobile-web-app-capable` meta for full-screen
  home-screen launch. No service worker in v1 (offline is out of scope).

**Project Structure:**
```
fincel/
├── index.html                  # all five screens as <section>s; state machine toggles
├── style.css                   # ASCII minimalism
├── js/
│   ├── app.js                  # state machine, transitions, screen wiring
│   ├── camera.js               # getUserMedia, pinch zoom, frame capture
│   ├── api.js                  # Claude client, model constant, wrapper prompt
│   └── image.js                # canvas resize + JPEG encode + base64
├── manifest.json               # PWA: standalone, black
└── finance-solver-skill.txt    # verbatim SKILL.md content (fetched at load)
```

## Hosting & Development Workflow

- **Develop on this Windows machine**: any static file server
  (`python -m http.server`) + desktop browser with a webcam for the full loop;
  `localhost` is a secure context so the camera works locally.
- **Use on the iPhone**: deploy the static files to a free HTTPS host
  (GitHub Pages / Netlify / Cloudflare Pages). HTTPS is mandatory for
  `getUserMedia` on the phone. Repo contains no secrets — the API key is
  entered at runtime on the device.
- **Install**: open the URL in Safari → Share → Add to Home Screen.

## Error Handling

| Failure | Detection | UI |
|---------|-----------|-----|
| Unreadable image / no finance problem | Response starts with `ERROR:` | Error state with Claude's brief reason, `[ TRY AGAIN ]` |
| No network / timeout | `fetch` rejects (TypeError) | "NO CONNECTION - CHECK WIFI" |
| Invalid/revoked key | HTTP 401 (any time) | Key cleared → Setup screen with "KEY NO LONGER VALID" |
| Rate limit / server error | HTTP 429/5xx | Show status + `[ TRY AGAIN ]` |
| Malformed response body | JSON parse failure | "COULDN'T SOLVE - TRY AGAIN" |
| Camera permission denied | `getUserMedia` rejects | "CAMERA ACCESS DENIED - ENABLE IN SETTINGS" |

## First Launch

1. Brief welcome text (one screen, monospace, minimal)
2. API key entry → validate → localStorage
3. Camera permission (browser prompt, requested when camera first appears)
4. One-line tip on first camera view: `TIP: FILL THE FRAME WITH THE PROBLEM`

Subsequent launches go straight to camera.

## Cost Analysis (per problem, Sonnet 4.5)

- Input: image ~1,100-1,600 tokens + skill/wrapper ~800 tokens ≈ 2,400 × $3/M ≈ $0.007
- Output: ~200 tokens × $15/M ≈ $0.003
- **Total: ~$0.01 per problem**
- 500 problems (semester): ~$5

## Testing Strategy

**Phase 1 - Capture + upload:** desktop browser + webcam first, then iPhone Safari
over the HTTPS deploy. Verify capture, resize output size/legibility, request
reaches API (test with screenshots displayed on the laptop).

**Phase 2 - Solving accuracy:** simple single-formula problems (NPV) → multi-step
(IRR, MIRR, PI, EAA with `[VARIABLE]` placeholders) → real homework problems.
Verify cash-flow tables map to correct formula arguments.

**Phase 3 - Error paths:** blurry/dark photos (expect `ERROR:`), non-finance content,
airplane mode, revoked key (expect return to Setup), camera permission denied.

## Success Criteria

1. Capture photo of a finance problem from laptop screen in one tap
2. Claude returns correct Excel formulas, including correct digits from tables
3. Formulas readable at desk distance; typed into Excel without confusion
4. Capture-to-formulas: < 5 seconds typical
5. Cost per problem: ~$0.01

## Out of Scope (v1)

- Native iOS app (requires a Mac; entire project replatformed to web)
- OCR / on-device text recognition
- Crop UI, preview/confirm step
- Streaming responses
- Tap-to-copy, history, offline mode (service worker), Android-specific testing,
  voice input, direct Excel integration, non-finance problem types

## Future Enhancements (not v1)

- Streaming display if measured latency annoys in practice
- Tap-to-copy per formula (trivial on the web: `navigator.clipboard`)
- Haiku 4.5 experiment via the model constant
- Problem history (localStorage)
- Service worker for instant loads

## Build Order

1. Static shell: index.html sections, style.css, state machine, setup screen
2. Camera: preview, pinch zoom, capture, frozen frame
3. ImageProcessor + ClaudeAPIClient: end-to-end solve
4. Error states, PWA manifest, deploy to HTTPS host, test on iPhone
