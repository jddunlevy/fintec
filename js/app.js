// App: five-state kiosk state machine. No router, no framework.

import * as Camera from './camera.js';
import * as Api from './api.js';
import { canvasToBase64Jpeg } from './image.js';
import { evaluateResponse, extractMcq, buildTranscript, parseAnswers } from './engine.js';

const AppState = {
  SETUP: 'setup',           // no key in localStorage
  CAMERA: 'camera',         // live viewfinder
  PROCESSING: 'processing', // frozen captured frame + indicator
  RESULTS: 'results',       // raw formula text from Claude
  ERROR: 'error',           // user-facing message + retry
};

const KEY_STORAGE = 'anthropic-api-key';
const TIP_STORAGE = 'seen-camera-tip';

const els = {
  screens: {
    [AppState.SETUP]: document.getElementById('screen-setup'),
    [AppState.CAMERA]: document.getElementById('screen-camera'),
    [AppState.PROCESSING]: document.getElementById('screen-processing'),
    [AppState.RESULTS]: document.getElementById('screen-results'),
    [AppState.ERROR]: document.getElementById('screen-error'),
  },
  setupPrompt: document.getElementById('setup-prompt'),
  keyInput: document.getElementById('key-input'),
  preview: document.getElementById('preview'),
  viewfinder: document.getElementById('viewfinder'),
  cameraDenied: document.getElementById('camera-denied'),
  cameraTip: document.getElementById('camera-tip'),
  btnCapture: document.getElementById('btn-capture'),
  frozenFrame: document.getElementById('frozen-frame'),
  resultsScroll: document.getElementById('results-scroll'),
  btnAnother: document.getElementById('btn-another'),
  errorMessage: document.getElementById('error-message'),
  btnRetry: document.getElementById('btn-retry'),
};

let current = null;

function show(state) {
  current = state;
  for (const [name, section] of Object.entries(els.screens)) {
    section.classList.toggle('active', name === state);
  }
}

// ---- transitions ----

const SETUP_PROMPT = 'enter API key to access this service';

function enterSetup(notice) {
  Camera.stop();
  els.setupPrompt.textContent = notice ?? SETUP_PROMPT;
  show(AppState.SETUP);
}

async function enterCamera() {
  show(AppState.CAMERA);
  els.cameraDenied.hidden = true;
  els.cameraTip.hidden = true;
  els.btnCapture.hidden = true;

  const ok = await Camera.start(els.preview, els.viewfinder);
  if (current !== AppState.CAMERA) {
    // State moved on while the permission prompt was up.
    Camera.stop();
    return;
  }
  if (!ok) {
    els.cameraDenied.hidden = false;
    return;
  }

  els.btnCapture.hidden = false;
  if (!localStorage.getItem(TIP_STORAGE)) {
    els.cameraTip.hidden = false;
    localStorage.setItem(TIP_STORAGE, '1');
  }
}

function enterResults(lines, answers) {
  renderResults(lines, answers);
  show(AppState.RESULTS);
}

function enterError(message) {
  els.errorMessage.textContent = message;
  show(AppState.ERROR);
}

// ---- setup: key entry + validation ----

let validating = false;

async function onValidate() {
  if (validating) return;

  const key = els.keyInput.value.trim();
  if (!key) {
    els.setupPrompt.textContent = 'enter a key';
    return;
  }

  els.keyInput.blur();
  validating = true;
  els.setupPrompt.textContent = 'validating...';

  try {
    await Api.validate(key);
    localStorage.setItem(KEY_STORAGE, key);
    els.keyInput.value = ''; // never displayed after entry
    els.setupPrompt.textContent = SETUP_PROMPT;
    enterCamera();
  } catch (err) {
    els.setupPrompt.textContent =
      err instanceof Api.ApiError && err.kind === 'unauthorized'
        ? 'invalid api key'
        : 'check connection'; // network failure: do not reject the key
  } finally {
    validating = false;
  }
}

// ---- solve pipeline: shutter → frozen frame → Claude → results/error ----

async function onCapture() {
  const canvas = Camera.captureFrame();
  if (!canvas) return;

  els.frozenFrame.src = canvas.toDataURL('image/jpeg', 0.5);
  show(AppState.PROCESSING);
  Camera.stop();

  const key = localStorage.getItem(KEY_STORAGE);
  if (!key) {
    enterSetup(null);
    return;
  }

  try {
    const base64 = await canvasToBase64Jpeg(canvas);
    const text = await Api.solve(base64, key);
    if (text.startsWith('ERROR:')) {
      enterError(text.slice('ERROR:'.length).trim().toUpperCase());
    } else {
      const { mcq, lines } = extractMcq(evaluateResponse(text));
      let answers = null;
      if (mcq) {
        // Second round-trip: Claude picks letters using engine-verified
        // values. Failure here never hides the formulas already computed;
        // only a 401 escalates (outer catch clears the key).
        try {
          answers = parseAnswers(
            await Api.pickAnswers(base64, buildTranscript(lines), key),
          );
        } catch (err) {
          if (err instanceof Api.ApiError && err.kind === 'unauthorized') throw err;
        }
        answers ??= ["couldn't verify answer choices \u2014 try again"];
      }
      enterResults(lines, answers);
    }
  } catch (err) {
    if (err instanceof Api.ApiError) {
      switch (err.kind) {
        case 'unauthorized':
          // 401 anywhere → clear key, return to Setup.
          localStorage.removeItem(KEY_STORAGE);
          enterSetup('key no longer valid');
          return;
        case 'http':
          enterError(`HTTP ${err.status} - TRY AGAIN`);
          return;
        case 'network':
          enterError('NO CONNECTION - CHECK WIFI');
          return;
        default:
          enterError("COULDN'T SOLVE - TRY AGAIN");
          return;
      }
    }
    enterError("COULDN'T SOLVE - TRY AGAIN");
  }
}

// ---- results rendering ----
// Answer lines render first (pink, the payoff), then the engine-annotated
// working: formulas that computed get a "→ value" line. Conceptual Answer
// lines from the first response are hoisted to the top alongside verified
// second-call picks. Content rendered verbatim via textContent — no markup
// interpretation.

const ANSWER_LINE_RE = /^answer\s*[:(]/i;

function renderResults(lines, answers) {
  els.resultsScroll.replaceChildren();

  function append(className, text) {
    const div = document.createElement('div');
    div.className = className;
    div.textContent = text;
    els.resultsScroll.appendChild(div);
  }

  const isAnswer = (l) => l.kind === 'text' && ANSWER_LINE_RE.test(l.text);
  for (const answer of answers ?? []) append('line-answer', answer);
  for (const line of lines) {
    if (isAnswer(line)) append('line-answer', line.text);
  }
  for (const line of lines) {
    if (isAnswer(line)) continue;
    append(line.kind === 'formula' ? 'line-formula' : 'line-label', line.text);
    if (line.value !== null) append('line-value', `\u2192 ${line.value}`);
  }
  els.resultsScroll.scrollTop = 0;
}

// ---- wiring ----

els.keyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') onValidate();
});
els.btnCapture.addEventListener('click', onCapture);
els.btnAnother.addEventListener('click', enterCamera);
els.btnRetry.addEventListener('click', enterCamera);

// iOS suspends the stream when the app is backgrounded; reacquire on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible'
      && current === AppState.CAMERA
      && !Camera.isRunning()) {
    enterCamera();
  }
});

// ---- launch ----

if (localStorage.getItem(KEY_STORAGE)) {
  enterCamera();
} else {
  enterSetup(null);
}
