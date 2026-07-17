// ClaudeAPIClient: fetch POST to the Messages API, non-streaming.
// Returns raw text; caller checks startsWith("ERROR:").

/** Single model constant — swap to experiment (e.g. a Haiku model) later. */
export const MODEL = 'claude-sonnet-4-5';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const TIMEOUT_MS = 60000;

// App wrapper text. Lives here, NOT in the skill file, so the skill can be
// re-synced without clobbering app instructions.
const WRAPPER =
  'You will receive a photo of a computer screen. Solve or answer every finance ' +
  'problem visible in the image according to the rules below. If the image is ' +
  'unreadable, or contains no finance problem, respond with exactly one line ' +
  'starting with "ERROR:" followed by a brief reason.';

let skillText = null;

async function systemPrompt() {
  if (skillText === null) {
    try {
      const resp = await fetch('finance-solver-skill.txt');
      skillText = resp.ok ? await resp.text() : '';
    } catch {
      skillText = '';
    }
  }
  return skillText ? `${WRAPPER}\n\n${skillText}` : WRAPPER;
}

/**
 * Typed API failure.
 * kind: 'unauthorized' (401) | 'http' (other non-200, see .status)
 *     | 'network' (fetch rejected / timeout) | 'malformed' (bad body)
 */
export class ApiError extends Error {
  constructor(kind, status = 0) {
    super(`api-error:${kind}${status ? `:${status}` : ''}`);
    this.kind = kind;
    this.status = status;
  }
}

/** Sends the photographed problem to Claude. Returns raw response text. */
export async function solve(imageBase64, apiKey) {
  const body = {
    model: MODEL,
    max_tokens: 1024,
    system: await systemPrompt(),
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 },
        },
        { type: 'text', text: 'Solve every finance problem visible in this image.' },
      ],
    }],
  };
  const data = await send(body, apiKey);
  const text = (data.content ?? []).find((block) => block.type === 'text')?.text;
  if (!text) throw new ApiError('malformed');
  return text.trim();
}

// Second round-trip for multiple-choice questions: the first response only
// emitted formulas; the engine computed the values; now Claude selects the
// matching letter using verified numbers instead of its own arithmetic.
const ANSWER_WRAPPER =
  'You will receive a photo of a computer screen containing finance problems ' +
  'with multiple-choice options, plus a transcript of formulas whose values ' +
  'were computed by a verified calculation engine. For each multiple-choice ' +
  'question visible in the photo, select the correct option by comparing the ' +
  'verified values to the choices and applying standard finance decision ' +
  'rules. Never perform arithmetic yourself beyond comparing the provided ' +
  'values to the choices. Respond with exactly one line per multiple-choice ' +
  'question, formatted as: Answer: <letter> \u2014 <choice text>. If the image ' +
  'has several such questions, prefix each line with the question label. ' +
  'Output only the Answer lines \u2014 no reasoning, no deliberation, no ' +
  'alternatives. If no multiple-choice options are visible, respond with ' +
  'exactly: NONE';

/**
 * Asks Claude to pick the correct choice for each MCQ, given the photographed
 * problem and the engine-verified transcript. Returns raw response text.
 */
export async function pickAnswers(imageBase64, transcript, apiKey) {
  const body = {
    model: MODEL,
    max_tokens: 512,
    system: ANSWER_WRAPPER,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 },
        },
        {
          type: 'text',
          text: `Verified computed results:\n${transcript}\n\n` +
            'Select the correct choice for each multiple-choice question.',
        },
      ],
    }],
  };
  const data = await send(body, apiKey);
  const text = (data.content ?? []).find((block) => block.type === 'text')?.text;
  if (!text) throw new ApiError('malformed');
  return text.trim();
}

/**
 * Minimal messages call to validate an API key (max_tokens: 1, user "hi").
 * Resolves on 200; throws ApiError('unauthorized') on 401,
 * ApiError('network') on connection failure.
 */
export async function validate(apiKey) {
  await send({
    model: MODEL,
    max_tokens: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }, apiKey);
}

async function send(body, apiKey) {
  let resp;
  try {
    resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
    });
  } catch {
    throw new ApiError('network');
  }
  if (resp.status === 401) throw new ApiError('unauthorized');
  if (!resp.ok) throw new ApiError('http', resp.status);
  try {
    return await resp.json();
  } catch {
    throw new ApiError('malformed');
  }
}
