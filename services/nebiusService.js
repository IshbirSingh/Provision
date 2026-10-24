// Nebius AI (OpenAI-compatible chat completions).
// AI interprets uploaded data and explains results; it never calculates.
// Callers must handle `isConfigured() === false` with a deterministic fallback.

const MODELS = {
  advanced: process.env.NEBIUS_MODEL_ADVANCED || 'Qwen/Qwen3-235B-A22B-Instruct-2507',
  efficient: process.env.NEBIUS_MODEL_EFFICIENT || 'Qwen/Qwen3-30B-A3B-Instruct-2507',
};
const BASE_URL = (process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1').replace(/\/+$/, '');
const TIMEOUT_MS = 60000;

class NebiusError extends Error {}

function isConfigured() {
  return Boolean(process.env.NEBIUS_API_KEY);
}

async function chat({ tier = 'efficient', system, user, json = false, temperature = 0.1, maxTokens = 2048 }) {
  if (!isConfigured()) throw new NebiusError('NEBIUS_API_KEY is not set');

  const body = {
    model: MODELS[tier] || tier,
    temperature,
    max_tokens: maxTokens,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) },
    ],
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.NEBIUS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new NebiusError(`Nebius request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? '';
  if (!json) return { content, model: body.model, usage: data.usage ?? null };

  try {
    return { content: JSON.parse(stripFences(content)), model: body.model, usage: data.usage ?? null };
  } catch {
    throw new NebiusError('Nebius returned invalid JSON');
  }
}

// Confirms the key works and both configured models are available.
// Lists models only, so no tokens are used.
async function checkConnection() {
  if (!isConfigured()) return { status: 'off', detail: 'NEBIUS_API_KEY is not set. Template explanations will be used.' };
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${process.env.NEBIUS_API_KEY}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { status: 'error', detail: `Nebius returned ${res.status}. Check NEBIUS_API_KEY.` };
    const ids = new Set(((await res.json()).data || []).map((m) => m.id));
    const missing = Object.values(MODELS).filter((m) => !ids.has(m));
    if (missing.length) return { status: 'error', detail: `Model not available: ${missing.join(', ')}` };
    return { status: 'ok', detail: `${MODELS.advanced} and ${MODELS.efficient}` };
  } catch (err) {
    return { status: 'error', detail: `Could not reach Nebius: ${err.message}` };
  }
}

function stripFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
}

module.exports = { MODELS, isConfigured, checkConnection, chat, NebiusError };
