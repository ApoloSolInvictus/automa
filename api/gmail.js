import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { InputError, parseCommand } from '../server/domain.js';
import { requestOpenAI } from './chat.js';
import { DEFAULT_OPENAI_MODEL } from '../shared/models.js';

const GMAIL_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send'];

const cleanEnv = value => typeof value === 'string' ? value.trim().replace(/^(['"])(.*)\1$/s, '$2').trim() : '';

async function services() {
  const projectId = cleanEnv(process.env.FIREBASE_PROJECT_ID);
  const clientEmail = cleanEnv(process.env.FIREBASE_CLIENT_EMAIL);
  const privateKey = cleanEnv(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) throw new Error('FIREBASE_NOT_CONFIGURED');
  const app = getApps()[0] || initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  return { auth: getAuth(app), db: getFirestore(app), FieldValue };
}

function oauthConfig() {
  const clientId = cleanEnv(process.env.GMAIL_CLIENT_ID);
  const clientSecret = cleanEnv(process.env.GMAIL_CLIENT_SECRET);
  const stateSecret = cleanEnv(process.env.GMAIL_OAUTH_STATE_SECRET);
  const redirectUri = cleanEnv(process.env.GMAIL_REDIRECT_URI) || 'https://automa.wstudio3d.com/api/gmail';
  if (!clientId || !clientSecret || !stateSecret) {
    const error = new Error('GMAIL_NOT_CONFIGURED');
    error.code = 'gmail_not_configured';
    throw error;
  }
  try {
    const url = new URL(redirectUri);
    if (url.protocol !== 'https:' || url.pathname !== '/api/gmail' || url.search || url.hash) throw new Error('invalid');
  } catch {
    const error = new Error('GMAIL_REDIRECT_INVALID');
    error.code = 'gmail_redirect_invalid';
    throw error;
  }
  return { clientId, clientSecret, stateSecret, redirectUri };
}

function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function encodeState(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

function decodeState(value, secret) {
  if (typeof value !== 'string' || value.length > 1200) throw new Error('GMAIL_STATE_INVALID');
  const [encoded, signature, extra] = value.split('.');
  if (!encoded || !signature || extra) throw new Error('GMAIL_STATE_INVALID');
  const expected = sign(encoded, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) throw new Error('GMAIL_STATE_INVALID');
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw new Error('GMAIL_STATE_INVALID'); }
  if (!payload || typeof payload.uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.uid) || (payload.orgId != null && !/^[A-Za-z0-9_-]{1,80}$/.test(payload.orgId)) || !Number.isFinite(payload.expiresAt) || payload.expiresAt < Date.now()) throw new Error('GMAIL_STATE_INVALID');
  return payload;
}

function authorizationUrl(config, state) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GMAIL_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeAuthorizationCode(code, config) {
  const body = new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code' });
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(12000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    const error = new Error('GMAIL_TOKEN_EXCHANGE_FAILED');
    error.code = 'gmail_token_exchange_failed';
    throw error;
  }
  return payload;
}

async function refreshAccessToken(refreshToken, config) {
  const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(12000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const error = new Error('GMAIL_REFRESH_FAILED');
    error.code = 'gmail_reconnect_required';
    throw error;
  }
  return payload.access_token;
}

async function gmailEmail(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000) });
  const payload = await response.json().catch(() => ({}));
  return response.ok && typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
}

async function workspace(db, uid, orgId, requireWrite = true) {
  if (!orgId) return db.collection('users').doc(uid);
  const root = db.collection('organizations').doc(orgId);
  const member = await root.collection('members').doc(uid).get();
  if (!member.exists) {
    const error = new Error('ORGANIZATION_FORBIDDEN');
    error.status = 403;
    error.code = 'organization_forbidden';
    throw error;
  }
  if (requireWrite && member.data()?.role === 'viewer') {
    const error = new Error('ORGANIZATION_READ_ONLY');
    error.status = 403;
    error.code = 'organization_read_only';
    throw error;
  }
  return root;
}

const EMAIL_DRAFT_FORMAT = Object.freeze({
  type: 'json_schema',
  name: 'automa_email_draft',
  description: 'A complete, safe HTML email draft for Automa.',
  strict: true,
  schema: {
    type: 'object',
    properties: { subject: { type: 'string' }, html: { type: 'string' }, text: { type: 'string' } },
    required: ['subject', 'html', 'text'],
    additionalProperties: false
  }
});

function cleanGeneratedHtml(value) {
  const html = String(value || '').trim().replace(/<meta\b[^>]*>/gi, '').replace(/<link\b[^>]*>/gi, '');
  if (!html || !/<[a-z][\s\S]*>/i.test(html) || /<\/?(?:script|iframe|object|embed|form|base)\b/i.test(html) || /\son[a-z]+\s*=/i.test(html) || /(?:javascript|data)\s*:/i.test(html) || /url\s*\(/i.test(html)) throw new InputError('OpenAI returned an unsafe or incomplete email draft. Please generate it again.');
  return html;
}

export function safeGeneratedEmail(value) {
  const source = String(value || '').trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const json = (fenced || source).match(/\{[\s\S]*\}/)?.[0] || fenced || source;
  let draft;
  try { draft = JSON.parse(json); }
  catch { throw new InputError('OpenAI did not return a valid email draft. Try a more specific prompt.'); }
  const subject = typeof draft.subject === 'string' ? draft.subject.trim() : '';
  const html = cleanGeneratedHtml(draft.html);
  const plainText = typeof draft.text === 'string' ? draft.text.trim() : '';
  if (!subject || subject.length > 200 || /[\r\n]/.test(subject) || html.length > 60000) throw new InputError('OpenAI returned an unsafe or incomplete email draft. Please generate it again.');
  return { subject, html, plainText: plainText.slice(0, 20000) };
}

export function htmlToPlainText(html) {
  return String(html || '').replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\s*\/p\s*>/gi, '\n\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function mimeBase64(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64').replace(/.{1,76}/g, line => `${line}\r\n`).trim();
}

function encodedHeader(value) {
  const clean = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

export function createRawEmail({ from = '', to, cc = [], bcc = [], subject, html, plainText }) {
  const boundary = `automa_${randomBytes(12).toString('hex')}`;
  const headers = ['MIME-Version: 1.0', from ? `From: ${encodedHeader(from)}` : '', `To: ${to.join(', ')}`, cc.length ? `Cc: ${cc.join(', ')}` : '', bcc.length ? `Bcc: ${bcc.join(', ')}` : '', `Date: ${new Date().toUTCString()}`, `Subject: ${encodedHeader(subject)}`, `Content-Type: multipart/alternative; boundary="${boundary}"`].filter(Boolean);
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    mimeBase64(plainText || htmlToPlainText(html)),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    mimeBase64(html),
    `--${boundary}--`,
    ''
  ].join('\r\n');
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url');
}

async function storeConnection(root, FieldValue, token, email) {
  const stamp = FieldValue.serverTimestamp();
  await Promise.all([
    root.collection('private').doc('gmail').set({ provider: 'gmail', refreshToken: token.refresh_token, email, scope: 'gmail.send', connectedAt: stamp, updatedAt: stamp }, { merge: true }),
    root.collection('integrations').doc('gmail').set({ provider: 'gmail', status: 'Connected', email, notes: 'HTML email sending is enabled.', updatedAt: stamp, createdAt: stamp }, { merge: true })
  ]);
}

function redirectAfterOAuth(res, result) {
  res.statusCode = 302;
  res.setHeader('Location', `/?gmail=${result}`);
  return res.end();
}

async function handleOAuthCallback(req, res) {
  const code = typeof req.query?.code === 'string' ? req.query.code : '';
  const state = typeof req.query?.state === 'string' ? req.query.state : '';
  if (!code || !state || req.query?.error) return redirectAfterOAuth(res, 'error');
  try {
    const config = oauthConfig();
    const payload = decodeState(state, config.stateSecret);
    const token = await exchangeAuthorizationCode(code, config);
    const email = await gmailEmail(token.access_token);
    const { db, FieldValue } = await services();
    const root = await workspace(db, payload.uid, payload.orgId, true);
    await storeConnection(root, FieldValue, token, email);
    return redirectAfterOAuth(res, 'connected');
  } catch (error) {
    console.error('Gmail OAuth callback failed', { code: error?.code || error?.message || 'gmail_oauth_callback_failed' });
    return redirectAfterOAuth(res, 'error');
  }
}

async function gmailStatus(root, configured) {
  const [privateDoc, integrationDoc] = await Promise.all([root.collection('private').doc('gmail').get(), root.collection('integrations').doc('gmail').get()]);
  const privateData = privateDoc.exists ? privateDoc.data() || {} : {};
  const integration = integrationDoc.exists ? integrationDoc.data() || {} : {};
  return { ok: true, configured, connected: Boolean(privateData.refreshToken), email: privateData.email || integration.email || '', status: privateData.refreshToken ? 'Connected' : 'Needs setup' };
}

function gmailTemplate(template) {
  const data = template.data() || {};
  return {
    id: template.id,
    name: typeof data.name === 'string' ? data.name : 'Untitled template',
    subject: typeof data.subject === 'string' ? data.subject : '',
    html: typeof data.html === 'string' ? data.html : '',
    plainText: typeof data.plainText === 'string' ? data.plainText : '',
    model: typeof data.model === 'string' ? data.model : ''
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return handleOAuthCallback(req, res);
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Use GET for OAuth callback or POST for Gmail actions.', code: 'method_not_allowed' }); }
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return res.status(401).json({ error: 'Sign in to continue.', code: 'firebase_session_missing' });
  try {
    if (JSON.stringify(req.body ?? '').length > 90000) return res.status(413).json({ error: 'The Gmail request is too large.', code: 'request_too_large' });
    const command = parseCommand(req.body);
    if (!command.action.startsWith('gmail')) throw new InputError('Gmail action required.');
    const { auth, db, FieldValue } = await services();
    const user = await auth.verifyIdToken(token, true);
    const readOnlyAction = command.action === 'gmailStatus' || command.action === 'gmailTemplateList';
    const root = await workspace(db, user.uid, command.orgId, !readOnlyAction);
    if (command.action === 'gmailStatus') {
      let configured = true;
      try { oauthConfig(); } catch { configured = false; }
      return res.status(200).json(await gmailStatus(root, configured));
    }
    if (command.action === 'gmailConnect') {
      const config = oauthConfig();
      const state = encodeState({ uid: user.uid, orgId: command.orgId, expiresAt: Date.now() + 10 * 60 * 1000 }, config.stateSecret);
      return res.status(200).json({ ok: true, authorizeUrl: authorizationUrl(config, state) });
    }
    if (command.action === 'gmailDisconnect') {
      await Promise.all([
        root.collection('private').doc('gmail').delete(),
        root.collection('integrations').doc('gmail').set({ provider: 'gmail', status: 'Disconnected', email: '', notes: 'Connect Gmail to send HTML email.', updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      ]);
      return res.status(200).json({ ok: true, connected: false });
    }
    if (command.action === 'gmailTemplateList') {
      const templates = await root.collection('emailTemplates').orderBy('updatedAt', 'desc').limit(50).get();
      return res.status(200).json({ ok: true, templates: templates.docs.map(gmailTemplate) });
    }
    if (command.action === 'gmailTemplateSave') {
      const ref = command.id ? root.collection('emailTemplates').doc(command.id) : root.collection('emailTemplates').doc();
      await ref.set({ name: command.name, subject: command.subject, html: command.html, plainText: command.plainText, model: command.model, updatedAt: FieldValue.serverTimestamp(), ...(command.id ? {} : { createdAt: FieldValue.serverTimestamp() }) }, { merge: true });
      return res.status(200).json({ ok: true, template: { id: ref.id, name: command.name, subject: command.subject, html: command.html, plainText: command.plainText, model: command.model } });
    }
    if (command.action === 'gmailTemplateDelete') {
      await root.collection('emailTemplates').doc(command.id).delete();
      return res.status(200).json({ ok: true, id: command.id });
    }
    if (command.action === 'gmailGenerate') {
      const instructions = [
        'You create professional HTML email drafts for Automa by W Studio 3D.',
        'Return the structured email draft requested by the response format.',
        'html must be a complete, compact email-safe HTML document using inline CSS only. Keep HTML below 25000 characters. Never use meta or link tags, scripts, forms, iframes, style tags, external assets, tracking pixels, CSS url() values, javascript URLs, data URLs, or unprovided links.',
        'text must be a concise plain-text equivalent. Do not claim that the email was sent. Use the requested language and only facts given by the user.'
      ].join(' ');
      const result = await requestOpenAI({ message: command.prompt, history: [] }, { model: command.model || DEFAULT_OPENAI_MODEL, instructions, textFormat: EMAIL_DRAFT_FORMAT, maxOutputTokens: 4000 });
      if (result.status !== 200) return res.status(result.status).json(result.body);
      return res.status(200).json({ ok: true, ...safeGeneratedEmail(result.body.reply), model: result.body.model });
    }
    if (command.action === 'gmailSend') {
      const config = oauthConfig();
      const credentials = await root.collection('private').doc('gmail').get();
      const credentialData = credentials.data() || {};
      const refreshToken = credentialData.refreshToken;
      if (!credentials.exists || typeof refreshToken !== 'string' || !refreshToken) return res.status(409).json({ error: 'Connect Gmail before sending an email.', code: 'gmail_not_connected' });
      let accessToken;
      try { accessToken = await refreshAccessToken(refreshToken, config); }
      catch (error) {
        await root.collection('integrations').doc('gmail').set({ provider: 'gmail', status: 'Reconnect required', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return res.status(409).json({ error: 'Gmail authorization expired or was revoked. Reconnect Gmail and try again.', code: error.code || 'gmail_reconnect_required' });
      }
      let sender = typeof credentialData.email === 'string' ? credentialData.email.trim().toLowerCase() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) sender = await gmailEmail(accessToken);
      if (!sender) return res.status(409).json({ error: 'Automa could not identify the connected Gmail sender. Disconnect and reconnect Gmail.', code: 'gmail_sender_missing' });
      const raw = createRawEmail({ ...command, from: sender });
      const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }), signal: AbortSignal.timeout(18000) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const reason = String(payload?.error?.message || payload?.error?.status || '').replace(/[^\x20-\x7e]/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 180);
        const code = response.status === 401 ? 'gmail_access_expired' : response.status === 403 ? 'gmail_access_denied' : response.status === 429 ? 'gmail_rate_limited' : 'gmail_send_failed';
        console.error('Gmail send failed', { status: response.status, reason });
        return res.status(response.status === 429 ? 429 : 502).json({ error: reason ? `Gmail rejected the message: ${reason}` : 'Gmail could not send this email. Review the recipients and Gmail connection.', code });
      }
      await root.collection('runs').add({ type: 'gmail_send', provider: 'gmail', status: 'completed', subject: command.subject, recipientCount: command.to.length + command.cc.length + command.bcc.length, message: `Gmail sent “${command.subject}” to ${command.to.length} primary recipient${command.to.length === 1 ? '' : 's'}.`, gmailMessageId: payload.id || '', createdAt: FieldValue.serverTimestamp() });
      return res.status(200).json({ ok: true, id: payload.id || '', threadId: payload.threadId || '' });
    }
    throw new InputError('Gmail action not supported.');
  } catch (error) {
    if (error instanceof InputError) return res.status(400).json({ error: error.message, code: 'invalid_request' });
    if (error?.status) return res.status(error.status).json({ error: error.code === 'organization_read_only' ? 'Viewer members have read-only access.' : 'You are not a member of this organization.', code: error.code });
    if (error?.code === 'gmail_not_configured') return res.status(503).json({ error: 'Gmail is not configured in Vercel. Add the Google OAuth variables before connecting.', code: error.code });
    if (error?.code === 'gmail_redirect_invalid') return res.status(503).json({ error: 'GMAIL_REDIRECT_URI must be an HTTPS URL ending in /api/gmail.', code: error.code });
    if (error?.message === 'FIREBASE_NOT_CONFIGURED') return res.status(503).json({ error: 'Firebase Admin is not configured in Vercel.', code: 'firebase_server_not_configured' });
    console.error('Gmail request failed', { code: error?.code || error?.message || 'gmail_internal_error' });
    return res.status(503).json({ error: 'Gmail is temporarily unavailable. Check the Vercel configuration and try again.', code: 'gmail_internal_error' });
  }
}
