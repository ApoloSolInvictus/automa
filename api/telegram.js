import { timingSafeEqual } from 'node:crypto';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { requestOpenAI } from './chat.js';
import { DEFAULT_OPENAI_MODEL, isAllowedOpenAIModel } from '../shared/models.js';
import { getDefaultAgent } from '../shared/agents.js';

const cleanEnv = value => typeof value === 'string'
  ? value.trim().replace(/^("|')(.*)\1$/s, '$2').trim()
  : '';

export function parseTelegramUpdate(update) {
  const message = update?.message;
  const chatId = message?.chat?.id;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if ((typeof chatId !== 'number' && typeof chatId !== 'string') || !text || text.length > 4000) return null;
  const updateId = update?.update_id == null ? null : String(update.update_id);
  if (updateId && !/^\d{1,30}$/.test(updateId)) return null;
  return {
    updateId,
    chatId: String(chatId),
    messageId: message.message_id == null ? null : String(message.message_id),
    text
  };
}

export function webhookSecretMatches(received, expected) {
  const actual = Buffer.from(String(received || ''));
  const wanted = Buffer.from(String(expected || ''));
  return actual.length > 0 && actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function splitTelegramText(value, maxLength = 4096) {
  const text = String(value || '').trim();
  if (!text) return [];
  const characters = Array.from(text);
  const chunks = [];
  for (let index = 0; index < characters.length; index += maxLength) chunks.push(characters.slice(index, index + maxLength).join(''));
  return chunks;
}

async function responseJson(response) {
  try { return await response.json(); } catch { return {}; }
}

function adminServices() {
  let { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey } = process.env;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountJson) {
    try {
      const account = JSON.parse(serviceAccountJson);
      projectId = account.project_id || projectId;
      clientEmail = account.client_email || clientEmail;
      privateKey = account.private_key || privateKey;
    } catch { throw Object.assign(new Error('FIREBASE_ADMIN_CREDENTIALS'), { code: 'firebase_admin_credentials' }); }
  }
  if (!projectId || !clientEmail || !privateKey) throw Object.assign(new Error('SERVER_NOT_CONFIGURED'), { code: 'firebase_server_not_configured' });
  const clean = value => cleanEnv(value).replace(/\\+r?\\+n/g, '\n').replace(/\\+n/g, '\n').replace(/\\"/g, '"');
  let app;
  try {
    app = getApps()[0] || initializeApp({ credential: cert({ projectId: clean(projectId), clientEmail: clean(clientEmail), privateKey: clean(privateKey).replace(/\r/g, '') }) });
  } catch (error) {
    throw Object.assign(new Error('FIREBASE_ADMIN_CREDENTIALS'), { code: 'firebase_admin_credentials', cause: error });
  }
  return { db: getFirestore(app) };
}

async function sendTelegramMessage(token, chatId, text) {
  for (const chunk of splitTelegramText(text)) {
    const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
      signal: AbortSignal.timeout(8000)
    });
    const payload = await responseJson(response);
    if (!response.ok || payload?.ok !== true) throw Object.assign(new Error('TELEGRAM_SEND_FAILED'), { code: 'telegram_send_failed' });
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Use POST.', code: 'method_not_allowed' }); }

  const expectedSecret = cleanEnv(process.env.TELEGRAM_WEBHOOK_SECRET);
  if (!expectedSecret || !webhookSecretMatches(req.headers['x-telegram-bot-api-secret-token'], expectedSecret)) return res.status(401).json({ error: 'Invalid webhook secret.', code: 'telegram_webhook_unauthorized' });

  const token = cleanEnv(process.env.TELEGRAM_BOT_TOKEN);
  const ownerUid = cleanEnv(process.env.TELEGRAM_OWNER_UID);
  const agentId = cleanEnv(process.env.TELEGRAM_AGENT_ID) || 'support-bot-v2-1';
  if (!token || !ownerUid) return res.status(503).json({ error: 'Telegram is not configured in Vercel.', code: 'telegram_not_configured' });
  if (JSON.stringify(req.body ?? '').length > 12000) return res.status(413).json({ error: 'The Telegram request is too large.', code: 'request_too_large' });

  const incoming = parseTelegramUpdate(req.body);
  if (!incoming) return res.status(200).json({ ok: true, ignored: true });

  try {
    const { db } = adminServices();
    const root = db.collection('users').doc(ownerUid);
    const agentSnapshot = await root.collection('agents').doc(agentId).get();
    const agent = { ...(getDefaultAgent(agentId) || {}), ...(agentSnapshot.exists ? agentSnapshot.data() : {}) };
    if (!agent.name) return res.status(503).json({ error: 'The configured Telegram agent does not exist.', code: 'telegram_agent_not_found' });
    if (agent.status === 'paused') return res.status(200).json({ ok: true, ignored: true, reason: 'agent_paused' });
    const model = agent.model || DEFAULT_OPENAI_MODEL;
    if (!isAllowedOpenAIModel(model)) return res.status(503).json({ error: 'The Telegram agent has an unsupported OpenAI model.', code: 'telegram_agent_model_invalid' });
    const updateRef = incoming.updateId ? root.collection('channels').doc('telegram').collection('updates').doc(incoming.updateId) : null;
    if (updateRef && (await updateRef.get()).exists) return res.status(200).json({ ok: true, duplicate: true });
    const conversationRef = root.collection('channels').doc('telegram').collection('chats').doc(incoming.chatId);
    const conversation = await conversationRef.get();
    const previous = Array.isArray(conversation.data()?.history)
      ? conversation.data().history.filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string').slice(-18)
      : [];
    const command = { action: 'runAgent', agentId, message: incoming.text, history: previous };
    const instructions = [
      `You are the ${agent.name} agent replying through Telegram.`,
      agent.description ? `Business area: ${agent.description}.` : '',
      agent.instructions || '',
      'Keep the answer clear and concise for a Telegram chat. Do not claim to have completed an external action unless a verified tool result is provided.'
    ].filter(Boolean).join(' ');
    const result = await requestOpenAI(command, { model, instructions });
    if (result.status !== 200 || !result.body?.reply) return res.status(502).json({ error: 'OpenAI could not answer the Telegram message.', code: result.body?.code || 'telegram_openai_failed' });
    await sendTelegramMessage(token, incoming.chatId, result.body.reply);
    await conversationRef.set({
      history: [...previous, { role: 'user', content: incoming.text }, { role: 'assistant', content: result.body.reply }].slice(-20),
      agentId,
      model,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    if (updateRef) await updateRef.set({ chatId: incoming.chatId, messageId: incoming.messageId, agentId, createdAt: FieldValue.serverTimestamp() });
    return res.status(200).json({ ok: true, agent: agent.name, model });
  } catch (error) {
    console.error('Telegram webhook failed', { code: error?.code || error?.name || 'internal_error' });
    return res.status(503).json({ error: 'Telegram agent service is temporarily unavailable.', code: 'telegram_service_unavailable' });
  }
}
