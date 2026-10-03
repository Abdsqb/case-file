/**
 * ai.js — the only place in Case File that talks to a model.
 *
 * One function, `complete()`, against one wire format: OpenAI's
 * chat-completions shape. That is not a preference for OpenAI — it is the
 * format Groq serves natively and the one Google publishes a compatible
 * endpoint for, which means two providers, two free tiers and one code path
 * instead of two SDKs and a translation layer between them.
 *
 * Nothing above this file knows which provider answered. Jobs ask for a
 * CAPABILITY — 'fast' or 'deep' — and the routing below picks a provider that
 * has a key and a model that fits the job:
 *
 *   deep   filing and deck-building. Wants a large window (your whole archive
 *          plus a syllabus) and careful structure. Gemini first.
 *   fast   the brief and the chat. Wants to be on screen before you have
 *          finished reading the heading. Groq first — a 70B at Groq's speed
 *          turns a two-second wait into no wait at all.
 *
 * ---------------------------------------------------------------------------
 * The clerk is OFF unless a key is present.
 *
 * This app's first claim about itself is that nothing leaves your machine.
 * A model call breaks that, so it is opt-in by the only mechanism that cannot
 * be enabled by accident: you have to put a key in .env yourself. With no key
 * every entry point here reports `ready: false` and the UI says so plainly
 * rather than failing at the moment you try to use it.
 */

const TIMEOUT_MS = 45000;

/* Free tiers rate-limit, and a 429 that bubbles up as a red box is a worse
   experience than waiting a second. Two retries on the retryable statuses
   only — a 400 is a bug in our request and retrying it just spends quota. */
const RETRY_ON = new Set([408, 409, 429, 500, 502, 503, 504]);
const RETRIES = 2;

/* ---------------------------------------------------------------- providers */

/**
 * Each provider is its base URL, where its key comes from, and which of its
 * models to use for each capability. `jsonSchema` records whether it honours
 * response_format: json_schema — the ones that do not still get asked for JSON,
 * they are just told the shape in words instead. Either way the answer is
 * validated before it is believed (see clerk.js), because a model's output
 * becomes rows in your archive and "it said it was JSON" is not a guarantee.
 */
/* Model names rot, and they rot without warning.
 *
 * Every default below was chosen by calling it — not from a docs page — and
 * checking the three things the clerk actually needs: that it answers with
 * prose, that it calls a tool when given one, and that it honours a JSON
 * schema. A model can fail any of those independently, and a model that
 * silently ignores tools is worse than one that errors, because it fails
 * later and looks like a bad prompt.
 *
 * `modelEnv` is the escape hatch, and it is the important part. Groq retired
 * llama-3.3-70b-versatile out from under this app, and Google's own model
 * list advertises gemini-2.5-flash while the OpenAI-compatible endpoint
 * returns 404 for it. When that happens again — and it will — the fix should
 * be one line in .env, not an edit to this file. */
const PROVIDERS = [
  {
    id: 'gemini',
    label: 'Gemini',
    env: 'GEMINI_API_KEY',
    modelEnv: 'CLERK_GEMINI_MODEL',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    jsonSchema: true,
    /* Both jobs go to flash-lite, and the reason is the free tier rather
       than the model. flash-latest is the stronger one, but its free quota is
       20 requests A DAY — and one filing spends three or four of them on its
       tool lookups alone, so it is exhausted inside a handful of uses and
       then returns 429 for the rest of the day. flash-lite answered every
       probe in well under a second and kept going. A better model you cannot
       call is worse than a good one you can.

       The `-latest` aliases rather than pinned versions, for the reason in
       the paragraph above: gemini-2.5-flash is still listed by the models
       endpoint and returns 404 from the OpenAI-compatible one. */
    models: { deep: 'gemini-flash-lite-latest', fast: 'gemini-flash-lite-latest' },
  },
  {
    id: 'groq',
    label: 'Groq',
    env: 'GROQ_API_KEY',
    modelEnv: 'CLERK_GROQ_MODEL',
    base: 'https://api.groq.com/openai/v1',
    jsonSchema: true,
    /* qwen3.8 answered in 84ms — fast enough that the chat card feels local —
       and spends no tokens on reasoning first. gpt-oss-120b is the more
       capable one for filing, but it emits several hundred characters of
       reasoning before any content, which is why maxTokens on the short jobs
       has room in it.

       Groq's free tier is 1000 requests a day and 8000 tokens a MINUTE. The
       request count is generous; the token rate is the one that bites, and it
       is why Gemini is preferred for the deep jobs: a long document can be
       more than 8000 tokens on its own, so filing a whole syllabus through
       Groq fails on a single request however much daily quota is left. */
    models: { deep: 'openai/gpt-oss-120b', fast: 'qwen/qwen3.8-27b' },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    env: 'OPENROUTER_API_KEY',
    base: 'https://openrouter.ai/api/v1',
    jsonSchema: false,
    /* CLERK_OPENROUTER_MODEL first, and only then the older OPENROUTER_MODEL.
       That variable was already in this project's .env for something else, and
       silently inheriting it would mean the clerk quietly running on whatever
       model was picked for a different purpose — which is exactly the kind of
       thing that gets diagnosed as "the AI is bad" rather than as a stray
       environment variable. */
    models: (() => {
      const m = (process.env.CLERK_OPENROUTER_MODEL || process.env.OPENROUTER_MODEL || '').trim()
        || 'google/gemini-2.0-flash-exp:free';
      return { deep: m, fast: m };
    })(),
  },
];

/* Who gets asked first, per capability. Everything else is a fallback in this
   same order, so one key alone is a complete installation — you are never told
   to go and get a second one. */
const ORDER = {
  deep: ['gemini', 'groq', 'openrouter'],
  fast: ['groq', 'gemini', 'openrouter'],
};

const keyOf = (p) => (process.env[p.env] || '').trim();

/** The model for a capability, with .env allowed to overrule the default. */
const modelOf = (p, capability) =>
  (p.modelEnv && (process.env[p.modelEnv] || '').trim())
  || p.models[capability]
  || p.models.fast;

function byId(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

/** Every provider that could actually be called right now. */
export function available() {
  return PROVIDERS.filter((p) => keyOf(p));
}

/**
 * The provider that will serve a capability, or null when none can.
 * `CLERK_PROVIDER=groq` in .env pins every job to one of them, which is the
 * only knob worth having here: it is what makes "is it the model or is it me"
 * answerable without editing code.
 */
export function providersFor(capability = 'fast') {
  const pinned = (process.env.CLERK_PROVIDER || '').trim();
  if (pinned) {
    const p = byId(pinned);
    /* Pinned means pinned. The whole point of the setting is to answer "is it
       the model or is it me", and a pin that quietly falls through to another
       provider cannot answer that. */
    if (p && keyOf(p)) return [p];
  }
  return (ORDER[capability] || ORDER.fast)
    .map(byId)
    .filter((p) => p && keyOf(p));
}

export function providerFor(capability = 'fast') {
  return providersFor(capability)[0] || null;
}

/** Is the clerk on duty at all? */
export function ready() {
  return available().length > 0;
}

/**
 * What the UI is allowed to say about the setup. Deliberately key-free: this
 * crosses the wire to the browser, and a key that is only ever read in this
 * file cannot leak from anywhere else.
 */
export function status() {
  const fast = providerFor('fast');
  const deep = providerFor('deep');
  return {
    ready: ready(),
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      env: p.env,
      configured: !!keyOf(p),
    })),
    routing: {
      fast: fast ? { provider: fast.id, label: fast.label, model: modelOf(fast, 'fast') } : null,
      deep: deep ? { provider: deep.id, label: deep.label, model: modelOf(deep, 'deep') } : null,
    },
  };
}

/** Thrown for everything a caller might want to show the reader verbatim. */
export class AiError extends Error {
  constructor(message, { status = 502, provider = null, retryable = false } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.provider = provider;
    this.retryable = retryable;
  }
}

/* ------------------------------------------------------------------- calling */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A provider's error body, reduced to one line worth showing a person. */
function readError(body, res) {
  if (body && typeof body === 'object') {
    const e = body.error;
    if (typeof e === 'string') return e;
    if (e && typeof e.message === 'string') return e.message;
    if (typeof body.message === 'string') return body.message;
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 300);
  return res.statusText || `HTTP ${res.status}`;
}

/**
 * One request to one provider.
 *
 * Returns { text, toolCalls, model, provider, usage }. `toolCalls` is always an
 * array — an empty one means the model answered rather than asked, which is how
 * the agent loop in clerk.js knows it is done.
 */
/**
 * Ask one provider, with its own retries. Throws AiError; never falls through
 * to a different provider — that decision belongs to `complete` below.
 */
async function attempt(provider, { capability, messages, tools, schema, temperature, maxTokens }) {
  const model = modelOf(provider, capability);

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  /* Structured output, as strictly as this provider will take it. Asking for a
     schema the provider does not implement is not harmless — some reject the
     whole request — so the ones that cannot take it are asked for JSON and told
     the shape in the prompt instead. Both paths are validated downstream. */
  if (schema && !(tools && tools.length)) {
    body.response_format = provider.jsonSchema
      ? { type: 'json_schema', json_schema: { name: schema.name, schema: schema.schema, strict: false } }
      : { type: 'json_object' };
  }

  let lastError = null;

  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    /* A hung request is worse than a failed one: the pad sits there spinning
       and there is nothing to click. Every call is on a leash. */
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

    let res;
    try {
      res = await fetch(`${provider.base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keyOf(provider)}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      const aborted = cause && cause.name === 'AbortError';
      lastError = new AiError(
        aborted
          ? `${provider.label} did not answer within ${Math.round(TIMEOUT_MS / 1000)}s.`
          : `could not reach ${provider.label}.`,
        { status: 504, provider: provider.id, retryable: true },
      );
      if (attempt < RETRIES) { await sleep(400 * (attempt + 1)); continue; }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }

    if (!res.ok) {
      const detail = readError(data, res);
      const retryable = RETRY_ON.has(res.status);

      /* "The model X does not exist or you do not have access to it" is a
         true sentence that leaves the reader nowhere to go. Say what to do
         about it, because the answer is always the same and it is one line. */
      const gone = res.status === 404
        || /does not exist|not found|decommissioned|no longer|deprecated/i.test(detail);
      let hint = '';
      if (gone && provider.modelEnv) {
        hint = ` — that model is gone. Set ${provider.modelEnv} in .env to one this key can use.`;
      } else if (res.status === 429) {
        /* Two different walls wear the same status code, and the thing to do
           about them is not the same: a per-minute token rate means this one
           document was too big, a daily request quota means come back
           tomorrow or use the other provider. */
        hint = /token/i.test(detail)
          ? ' — that was too much text for one request on this provider\'s free tier. File it in smaller pieces.'
          : ' — the free tier for today is spent. Add the other provider\'s key, or try again tomorrow.';
      }

      lastError = new AiError(`${provider.label}: ${detail}${hint}`, {
        status: res.status === 429 ? 429 : 502,
        provider: provider.id,
        retryable,
      });
      if (retryable && attempt < RETRIES) {
        /* Honour Retry-After when the provider sends one — guessing shorter
           than it asked for is how a rate limit becomes a ban. */
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 8000) : 700 * (attempt + 1));
        continue;
      }
      throw lastError;
    }

    const choice = data && data.choices && data.choices[0];
    const message = (choice && choice.message) || {};

    return {
      provider: provider.id,
      providerLabel: provider.label,
      model,
      text: typeof message.content === 'string' ? message.content : '',
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
      usage: (data && data.usage) || null,
      raw: message,
    };
  }

  throw lastError || new AiError('the model could not be reached.', { provider: provider.id });
}

/**
 * Ask for a completion, and move to the next provider if the first one is out
 * of road.
 *
 * This is the reason having both keys is worth anything. The two free tiers
 * are limited along completely different axes — Gemini's is requests per
 * minute, Groq's is a thousand requests a day but only eight thousand tokens
 * per minute — so the one you hit first is usually the one the other would
 * have served without noticing. Falling over turns "the clerk is rate limited,
 * try later" into something the reader never sees.
 *
 * Only a wall gets a second provider: a rate limit, or a provider that is
 * down. A 400 is a bad request and asking someone else the same bad question
 * wastes a second quota to get the same answer. And when CLERK_PROVIDER is
 * pinned there is only ever one candidate, by design.
 */
export async function complete({
  capability = 'fast',
  messages,
  tools = null,
  schema = null,
  temperature = 0.4,
  maxTokens = 1600,
} = {}) {
  const candidates = providersFor(capability);
  if (!candidates.length) {
    throw new AiError(
      'the clerk is off duty — no API key is configured. Add GEMINI_API_KEY or GROQ_API_KEY to .env.',
      { status: 503 },
    );
  }

  const opts = { capability, messages, tools, schema, temperature, maxTokens };
  let first = null;

  for (let i = 0; i < candidates.length; i += 1) {
    try {
      return await attempt(candidates[i], opts);
    } catch (err) {
      if (!first) first = err;
      const wall = err.status === 429 || err.status === 503 || err.status === 504;
      const more = i < candidates.length - 1;
      if (!wall || !more) throw first;
      console.warn(`Clerk: ${candidates[i].label} is out of road (${err.status}) — trying ${candidates[i + 1].label}`);
    }
  }

  throw first || new AiError('the model could not be reached.');
}
