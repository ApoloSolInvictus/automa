import { createHmac, timingSafeEqual } from 'node:crypto';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { InputError } from '../server/domain.js';

const GOOGLE_SCOPES = Object.freeze([
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets'
]);
const GOOGLE_SERVICES = Object.freeze(['google-drive', 'google-docs', 'google-calendar', 'google-sheets']);
const GOOGLE_API_ROOT = 'https://www.googleapis.com';

const cleanEnv = value => typeof value === 'string' ? value.trim().replace(/^(['"])(.*)\1$/s, '$2').trim() : '';

async function services() {
  const projectId = cleanEnv(process.env.FIREBASE_PROJECT_ID);
  const clientEmail = cleanEnv(process.env.FIREBASE_CLIENT_EMAIL);
  const privateKey = cleanEnv(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) throw new Error('FIREBASE_NOT_CONFIGURED');
  const app = getApps()[0] || initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  return { auth: getAuth(app), db: getFirestore(app), FieldValue };
}

export function googleScopes() { return [...GOOGLE_SCOPES]; }

function oauthConfig() {
  const clientId = cleanEnv(process.env.GOOGLE_CLIENT_ID) || cleanEnv(process.env.GMAIL_CLIENT_ID);
  const clientSecret = cleanEnv(process.env.GOOGLE_CLIENT_SECRET) || cleanEnv(process.env.GMAIL_CLIENT_SECRET);
  const stateSecret = cleanEnv(process.env.GOOGLE_OAUTH_STATE_SECRET) || cleanEnv(process.env.GMAIL_OAUTH_STATE_SECRET);
  const redirectUri = cleanEnv(process.env.GOOGLE_WORKSPACE_REDIRECT_URI) || cleanEnv(process.env.GOOGLE_REDIRECT_URI) || 'https://automa.wstudio3d.com/api/google';
  if (!clientId || !clientSecret || !stateSecret) {
    const error = new Error('GOOGLE_NOT_CONFIGURED');
    error.code = 'google_not_configured';
    throw error;
  }
  try {
    const url = new URL(redirectUri);
    if (url.protocol !== 'https:' || url.pathname !== '/api/google' || url.search || url.hash) throw new Error('invalid');
  } catch {
    const error = new Error('GOOGLE_REDIRECT_INVALID');
    error.code = 'google_redirect_invalid';
    throw error;
  }
  return { clientId, clientSecret, stateSecret, redirectUri };
}

function sign(value, secret) { return createHmac('sha256', secret).update(value).digest('base64url'); }
function encodeState(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}
export function decodeGoogleState(value, secret) {
  if (typeof value !== 'string' || value.length > 1600) throw new Error('GOOGLE_STATE_INVALID');
  const [encoded, signature, extra] = value.split('.');
  if (!encoded || !signature || extra) throw new Error('GOOGLE_STATE_INVALID');
  const expected = sign(encoded, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) throw new Error('GOOGLE_STATE_INVALID');
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw new Error('GOOGLE_STATE_INVALID'); }
  if (!payload || typeof payload.uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.uid) || (payload.orgId != null && !/^[A-Za-z0-9_-]{1,80}$/.test(payload.orgId)) || !Number.isFinite(payload.expiresAt) || payload.expiresAt < Date.now()) throw new Error('GOOGLE_STATE_INVALID');
  return payload;
}

function authorizationUrl(config, state) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
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
  if (!response.ok || !payload.access_token) {
    const error = new Error('GOOGLE_TOKEN_EXCHANGE_FAILED');
    error.code = 'google_token_exchange_failed';
    throw error;
  }
  return payload;
}

async function refreshAccessToken(refreshToken, config) {
  const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(12000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const error = new Error('GOOGLE_REFRESH_FAILED');
    error.code = 'google_reconnect_required';
    throw error;
  }
  return payload.access_token;
}

async function googleEmail(accessToken) {
  const response = await fetch(`${GOOGLE_API_ROOT}/oauth2/v3/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000) });
  const payload = await response.json().catch(() => ({}));
  return response.ok && typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
}

async function workspace(db, uid, orgId, requireWrite = true) {
  if (!orgId) return db.collection('users').doc(uid);
  const root = db.collection('organizations').doc(orgId);
  const member = await root.collection('members').doc(uid).get();
  if (!member.exists) { const error = new Error('ORGANIZATION_FORBIDDEN'); error.status = 403; error.code = 'organization_forbidden'; throw error; }
  if (requireWrite && member.data()?.role === 'viewer') { const error = new Error('ORGANIZATION_READ_ONLY'); error.status = 403; error.code = 'organization_read_only'; throw error; }
  return root;
}

function cleanText(value, label, max, optional = false) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new InputError(`${label} is invalid.`);
  return value.trim();
}
function id(value, label) {
  const text = cleanText(value, label, 200);
  if (!/^[A-Za-z0-9_-]{4,200}$/.test(text)) throw new InputError(`${label} is invalid.`);
  return text;
}
function workspaceId(value) {
  if (value == null || value === '') return null;
  const text = cleanText(value, 'Organization', 80);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(text)) throw new InputError('Organization is invalid.');
  return text;
}
function parseValues(value) {
  if (!Array.isArray(value) || !value.length || value.length > 30 || value.some(row => !Array.isArray(row) || !row.length || row.length > 30 || row.some(cell => typeof cell !== 'string' && typeof cell !== 'number' && typeof cell !== 'boolean'))) throw new InputError('Sheet values are invalid.');
  return value.map(row => row.map(cell => String(cell).slice(0, 2000)));
}

export function parseGoogleCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string') throw new InputError('A Google action is required.');
  const orgId = workspaceId(body.orgId);
  if (['googleConnect', 'googleStatus', 'googleDisconnect'].includes(body.action)) return { action: body.action, orgId };
  if (body.action === 'googleDriveList') return { action: body.action, orgId, query: cleanText(body.query, 'Drive query', 300, true), pageToken: cleanText(body.pageToken, 'Page token', 500, true) };
  if (body.action === 'googleDocsGet') return { action: body.action, orgId, documentId: id(body.documentId, 'Document ID') };
  if (body.action === 'googleDocsCreate') return { action: body.action, orgId, title: cleanText(body.title, 'Document title', 200), text: cleanText(body.text, 'Document text', 30000) };
  if (body.action === 'googleCalendarList') {
    const days = body.days == null ? 14 : Number(body.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new InputError('Calendar range is invalid.');
    return { action: body.action, orgId, days };
  }
  if (body.action === 'googleCalendarCreate') {
    const start = cleanText(body.start, 'Event start', 80);
    const end = cleanText(body.end, 'Event end', 80);
    if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start)) throw new InputError('Event dates are invalid.');
    return { action: body.action, orgId, summary: cleanText(body.summary, 'Event title', 200), description: cleanText(body.description, 'Event description', 2000, true), start, end, timezone: cleanText(body.timezone, 'Time zone', 80, true) || 'UTC' };
  }
  if (body.action === 'googleSheetsRead') return { action: body.action, orgId, spreadsheetId: id(body.spreadsheetId, 'Spreadsheet ID'), range: cleanText(body.range, 'Sheet range', 300) };
  if (body.action === 'googleSheetsAppend') return { action: body.action, orgId, spreadsheetId: id(body.spreadsheetId, 'Spreadsheet ID'), range: cleanText(body.range, 'Sheet range', 300), values: parseValues(body.values) };
  throw new InputError('Google action not supported.');
}

async function googleApi(accessToken, path, options = {}) {
  const response = await fetch(`${GOOGLE_API_ROOT}${path}`, { ...options, headers: { Accept: 'application/json', ...(options.headers || {}), Authorization: `Bearer ${accessToken}` }, signal: options.signal || AbortSignal.timeout(18000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(String(payload?.error?.message || 'Google API request failed.').replace(/[\r\n]+/g, ' ').slice(0, 240)); error.status = response.status; error.code = 'google_api_error'; error.payload = payload; throw error; }
  return payload;
}

async function accessFor(root, config, FieldValue) {
  const credentials = await root.collection('private').doc('googleWorkspace').get();
  const data = credentials.exists ? credentials.data() || {} : {};
  if (typeof data.refreshToken !== 'string' || !data.refreshToken) { const error = new Error('google_not_connected'); error.status = 409; error.code = 'google_not_connected'; throw error; }
  let accessToken;
  try { accessToken = await refreshAccessToken(data.refreshToken, config); }
  catch (error) { await root.collection('integrations').doc('google-drive').set({ provider: 'Google Drive', status: 'Reconnect required', updatedAt: FieldValue.serverTimestamp() }, { merge: true }); error.status = 409; throw error; }
  return { accessToken, email: data.email || await googleEmail(accessToken) };
}

async function googleStatus(root, configured) {
  const privateDoc = await root.collection('private').doc('googleWorkspace').get();
  const data = privateDoc.exists ? privateDoc.data() || {} : {};
  const connected = Boolean(data.refreshToken);
  const scope = typeof data.scope === 'string' ? data.scope : '';
  const servicesStatus = Object.fromEntries(GOOGLE_SERVICES.map(service => [service, { connected, scopeReady: connected && GOOGLE_SCOPES.every(item => scope.includes(item)) }]));
  return { ok: true, configured, connected, email: data.email || '', scope: scope || GOOGLE_SCOPES.join(' '), services: servicesStatus, status: connected ? (GOOGLE_SCOPES.every(item => scope.includes(item)) ? 'Connected' : 'Reconnect required') : 'Needs setup' };
}

async function storeConnection(root, token, email, FieldValue) {
  const stamp = FieldValue.serverTimestamp();
  const existing = await root.collection('private').doc('googleWorkspace').get();
  const old = existing.exists ? existing.data() || {} : {};
  const refreshToken = token.refresh_token || old.refreshToken;
  if (!refreshToken) { const error = new Error('GOOGLE_REFRESH_TOKEN_MISSING'); error.code = 'google_refresh_token_missing'; throw error; }
  const scope = typeof token.scope === 'string' && token.scope ? token.scope : GOOGLE_SCOPES.join(' ');
  await Promise.all([
    root.collection('private').doc('googleWorkspace').set({ provider: 'google-workspace', refreshToken, email, scope, connectedAt: old.connectedAt || stamp, updatedAt: stamp }, { merge: true }),
    ...GOOGLE_SERVICES.map(service => root.collection('integrations').doc(service).set({ provider: service, status: 'Connected', email, scope, notes: 'Google Workspace OAuth is connected. Use the service test to verify access.', updatedAt: stamp, createdAt: stamp }, { merge: true }))
  ]);
}

function redirectAfterOAuth(res, result) { res.statusCode = 302; res.setHeader('Location', `/?google=${result}`); return res.end(); }
async function handleOAuthCallback(req, res) {
  const code = typeof req.query?.code === 'string' ? req.query.code : '';
  const state = typeof req.query?.state === 'string' ? req.query.state : '';
  if (!code || !state || req.query?.error) return redirectAfterOAuth(res, 'error');
  try {
    const config = oauthConfig();
    const payload = decodeGoogleState(state, config.stateSecret);
    const token = await exchangeAuthorizationCode(code, config);
    const email = await googleEmail(token.access_token);
    const { db, FieldValue } = await services();
    const root = await workspace(db, payload.uid, payload.orgId, true);
    await storeConnection(root, token, email, FieldValue);
    return redirectAfterOAuth(res, 'connected');
  } catch (error) { console.error('Google OAuth callback failed', { code: error?.code || error?.message || 'google_oauth_callback_failed' }); return redirectAfterOAuth(res, 'error'); }
}

async function runAction(command, root, config, FieldValue) {
  const { accessToken } = await accessFor(root, config, FieldValue);
  if (command.action === 'googleDriveList') {
    const query = command.query || 'trashed = false';
    const params = new URLSearchParams({ q: query, pageSize: '50', fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,parents)', orderBy: 'modifiedTime desc' });
    if (command.pageToken) params.set('pageToken', command.pageToken);
    const payload = await googleApi(accessToken, `/drive/v3/files?${params}`);
    return { ok: true, service: 'google-drive', files: Array.isArray(payload.files) ? payload.files : [], nextPageToken: payload.nextPageToken || '' };
  }
  if (command.action === 'googleDocsGet') {
    const payload = await googleApi(accessToken, `/docs/v1/documents/${encodeURIComponent(command.documentId)}`);
    return { ok: true, service: 'google-docs', document: { documentId: payload.documentId, title: payload.title, body: payload.body || {} } };
  }
  if (command.action === 'googleDocsCreate') {
    const created = await googleApi(accessToken, '/docs/v1/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: command.title }) });
    const endIndex = Number(created.body?.content?.at(-1)?.endIndex || 1);
    const requests = [{ insertText: { location: { index: Math.max(1, endIndex - 1) }, text: command.text } }];
    const document = await googleApi(accessToken, `/docs/v1/documents/${encodeURIComponent(created.documentId)}:batchUpdate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }) });
    return { ok: true, service: 'google-docs', documentId: created.documentId, document }; 
  }
  if (command.action === 'googleCalendarList') {
    const params = new URLSearchParams({ timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + command.days * 86400000).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50' });
    const payload = await googleApi(accessToken, `/calendar/v3/calendars/primary/events?${params}`);
    return { ok: true, service: 'google-calendar', events: Array.isArray(payload.items) ? payload.items : [] };
  }
  if (command.action === 'googleCalendarCreate') {
    const event = await googleApi(accessToken, '/calendar/v3/calendars/primary/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: command.summary, description: command.description || undefined, start: { dateTime: new Date(command.start).toISOString(), timeZone: command.timezone }, end: { dateTime: new Date(command.end).toISOString(), timeZone: command.timezone } }) });
    return { ok: true, service: 'google-calendar', event: { id: event.id, htmlLink: event.htmlLink, summary: event.summary, start: event.start, end: event.end } };
  }
  if (command.action === 'googleSheetsRead') {
    const payload = await googleApi(accessToken, `/sheets/v4/spreadsheets/${encodeURIComponent(command.spreadsheetId)}/values/${encodeURIComponent(command.range)}`);
    return { ok: true, service: 'google-sheets', range: payload.range || command.range, values: Array.isArray(payload.values) ? payload.values : [] };
  }
  if (command.action === 'googleSheetsAppend') {
    const params = new URLSearchParams({ valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' });
    const payload = await googleApi(accessToken, `/sheets/v4/spreadsheets/${encodeURIComponent(command.spreadsheetId)}/values/${encodeURIComponent(command.range)}:append?${params}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: command.values }) });
    return { ok: true, service: 'google-sheets', updates: payload.updates || {}, tableRange: payload.tableRange || '' };
  }
  throw new InputError('Google action not supported.');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return handleOAuthCallback(req, res);
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Use GET for OAuth callback or POST for Google Workspace actions.', code: 'method_not_allowed' }); }
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return res.status(401).json({ error: 'Sign in to continue.', code: 'firebase_session_missing' });
  try {
    if (JSON.stringify(req.body ?? '').length > 90000) return res.status(413).json({ error: 'The Google request is too large.', code: 'request_too_large' });
    const command = parseGoogleCommand(req.body);
    const { auth, db, FieldValue } = await services();
    const user = await auth.verifyIdToken(token, true);
    const readOnly = command.action === 'googleStatus';
    const root = await workspace(db, user.uid, command.orgId, !readOnly);
    if (command.action === 'googleStatus') { let configured = true; try { oauthConfig(); } catch { configured = false; } return res.status(200).json(await googleStatus(root, configured)); }
    if (command.action === 'googleConnect') {
      const config = oauthConfig();
      const state = encodeState({ uid: user.uid, ...(command.orgId ? { orgId: command.orgId } : {}), expiresAt: Date.now() + 10 * 60 * 1000 }, config.stateSecret);
      return res.status(200).json({ ok: true, authorizeUrl: authorizationUrl(config, state), scopes: GOOGLE_SCOPES });
    }
    if (command.action === 'googleDisconnect') {
      await Promise.all([root.collection('private').doc('googleWorkspace').delete(), ...GOOGLE_SERVICES.map(service => root.collection('integrations').doc(service).set({ provider: service, status: 'Disconnected', email: '', notes: 'Connect Google Workspace to enable this service.', updatedAt: FieldValue.serverTimestamp() }, { merge: true }))]);
      return res.status(200).json({ ok: true, connected: false });
    }
    const result = await runAction(command, root, oauthConfig(), FieldValue);
    await root.collection('runs').add({ type: command.action, provider: 'google-workspace', status: 'completed', createdAt: FieldValue.serverTimestamp() });
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof InputError) return res.status(400).json({ error: error.message, code: 'invalid_request' });
    if (error?.status) return res.status(error.status).json({ error: String(error.message || 'Google rejected the request.').replace(/[\r\n]+/g, ' ').slice(0, 240), code: error.code || 'google_api_error' });
    if (error?.code === 'google_not_configured') return res.status(503).json({ error: 'Google Workspace is not configured in Vercel. Add the Google OAuth variables before connecting.', code: error.code });
    if (error?.code === 'google_redirect_invalid') return res.status(503).json({ error: 'GOOGLE_WORKSPACE_REDIRECT_URI must be an HTTPS URL ending in /api/google.', code: error.code });
    if (error?.message === 'FIREBASE_NOT_CONFIGURED') return res.status(503).json({ error: 'Firebase Admin is not configured in Vercel.', code: 'firebase_server_not_configured' });
    console.error('Google Workspace request failed', { code: error?.code || error?.message || 'google_internal_error' });
    return res.status(503).json({ error: 'Google Workspace is temporarily unavailable. Check the Vercel configuration and try again.', code: 'google_internal_error' });
  }
}
