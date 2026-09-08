import { InputError, parseCommand } from '../server/domain.js';
import { DEFAULT_OPENAI_MODEL, isAllowedOpenAIModel } from '../shared/models.js';

const systemInstructions = [
  'You are NexusAI, a concise business automation assistant.',
  'Answer in English.',
  'Help with support analytics, AI agents, workflow automation, and business metrics.',
  'Never claim that you executed a dashboard action.',
  'When asked to change business data, explain which dashboard action the user should use.'
].join(' ');

const cleanEnv = value => typeof value === 'string'
  ? value.trim().replace(/^(["'])(.*)\1$/s, '$2').trim()
  : '';

async function responseJson(response) {
  try { return await response.json(); }
  catch { return {}; }
}

export function extractResponseText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();
  return (response?.output || [])
    .flatMap(item => Array.isArray(item?.content) ? item.content : [])
    .filter(item => item?.type === 'output_text' && typeof item.text === 'string')
    .map(item => item.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function classifyOpenAIFailure(status, payload = {}) {
  const code = payload?.error?.code || payload?.error?.type || 'openai_upstream_error';
  if (status === 401 || code === 'invalid_api_key') return { status: 502, code: 'invalid_api_key', error: 'OpenAI rejected the API key configured in Vercel.' };
  if (code === 'insufficient_quota') return { status: 502, code, error: 'The OpenAI API project has no available quota or credits.' };
  if (status === 429 || code === 'rate_limit_exceeded') return { status: 502, code: 'rate_limit_exceeded', error: 'OpenAI rate limit reached. Please retry shortly.' };
  if (status === 403 || status === 404 || code === 'model_not_found') return { status: 502, code: code === 'model_not_found' ? code : 'model_access', error: 'The selected OpenAI model is not available to this API project.' };
  return { status: 502, code: 'openai_upstream_error', error: 'OpenAI could not complete the request. Check OPENAI_MODEL and API project access in Vercel.' };
}

async function verifyFirebaseSession(token) {
  const apiKey = cleanEnv(process.env.FIREBASE_WEB_API_KEY || process.env.VITE_FIREBASE_API_KEY);
  if (!apiKey) return { status: 503, body: { error: 'Firebase Web API key is not configured in Vercel.', code: 'firebase_web_api_key_missing' } };

  let response;
  try {
    response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
      signal: AbortSignal.timeout(7000)
    });
  } catch (error) {
    console.error('Firebase Auth REST request failed', { code: error?.name || 'network_error' });
    return { status: 502, body: { error: 'Firebase Authentication is temporarily unavailable.', code: 'firebase_auth_unavailable' } };
  }

  const payload = await responseJson(response);
  if (!response.ok) {
    const reason = String(payload?.error?.message || '');
    if (/API_KEY|PROJECT|CONFIGURATION_NOT_FOUND|SERVICE_BLOCKED/i.test(reason) || response.status === 403) {
      console.error('Firebase Auth REST configuration rejected', { status: response.status, reason: reason.slice(0, 80) });
      return { status: 503, body: { error: 'Firebase rejected the Web API key configured in Vercel.', code: 'firebase_web_api_key_invalid' } };
    }
    return { status: 401, body: { error: 'Your session is invalid. Please sign in again.', code: 'invalid_firebase_session' } };
  }
  if (!payload?.users?.[0]?.localId) return { status: 401, body: { error: 'Your session is invalid. Please sign in again.', code: 'invalid_firebase_session' } };
  return { status: 200, user: payload.users[0] };
}

export async function requestOpenAI(command, options = {}) {
  const apiKey = cleanEnv(process.env.OPENAI_API_KEY);
  const model = cleanEnv(options.model) || cleanEnv(process.env.OPENAI_MODEL) || DEFAULT_OPENAI_MODEL;
  if (!apiKey) return { status: 503, body: { error: 'OpenAI is not configured in Vercel.', code: 'openai_key_missing' } };
  if (!isAllowedOpenAIModel(model)) return { status: 503, body: { error: 'The configured OpenAI model is not in the supported agent catalog.', code: 'openai_model_invalid' } };
  const instructions = cleanEnv(options.instructions) || systemInstructions;

  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: 800,
        instructions,
        input: [...command.history, { role: 'user', content: command.message }]
      }),
      signal: AbortSignal.timeout(22000)
    });
  } catch (error) {
    console.error('OpenAI transport failed', { code: error?.name || 'network_error' });
    return { status: 502, body: { error: error?.name === 'TimeoutError' ? 'OpenAI took too long to respond. Please try again.' : 'The Vercel function could not reach OpenAI.', code: 'openai_transport_error' } };
  }

  const payload = await responseJson(response);
  if (!response.ok) {
    const failure = classifyOpenAIFailure(response.status, payload);
    console.error('OpenAI request rejected', { status: response.status, code: failure.code });
    return { status: failure.status, body: { error: failure.error, code: failure.code } };
  }

  const reply = extractResponseText(payload);
  if (!reply) return { status: 502, body: { error: 'OpenAI returned an empty response. Please try again.', code: 'openai_empty_response' } };
  return { status: 200, body: { ok: true, reply, model } };
}

export async function handleChatCommand(token, command) {
  const session = await verifyFirebaseSession(token);
  if (!session.user) return session;
  return requestOpenAI(command);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Automa-Chat-Version', '2');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST.', code: 'method_not_allowed' });
  }

  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return res.status(401).json({ error: 'Sign in to continue.', code: 'firebase_session_missing' });

  try {
    if (JSON.stringify(req.body ?? '').length > 12000) return res.status(413).json({ error: 'The chat request is too large.', code: 'request_too_large' });
    const command = parseCommand(req.body);
    if (command.action !== 'chat') throw new InputError('Chat request required.');
    const result = await handleChatCommand(token, command);
    return res.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof InputError) return res.status(400).json({ error: 'Invalid chat request.', code: 'invalid_request' });
    console.error('Chat request failed', { code: error?.code || error?.name || 'internal_error' });
    return res.status(502).json({ error: 'The chat service is temporarily unavailable.', code: 'chat_internal_error' });
  }
}
