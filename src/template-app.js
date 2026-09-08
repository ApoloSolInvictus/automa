import { initializeApp } from 'firebase/app';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider,
  GithubAuthProvider, sendPasswordResetEmail, signOut
} from 'firebase/auth';
import { getFirestore, collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { OPENAI_MODELS, DEFAULT_OPENAI_MODEL, modelLabel } from '../shared/models.js';
import { DEFAULT_AGENTS, getDefaultAgent } from '../shared/agents.js';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};
let auth, db, stops = [], chat = [], generation = 0, chatPending = false, workspaceWired = false;

const $ = id => document.getElementById(id);
function errorMessage(error) {
  const messages = {
    'auth/invalid-credential': 'Invalid email or password.',
    'auth/email-already-in-use': 'This email already has an account.',
    'auth/weak-password': 'Use a stronger password.',
    'auth/operation-not-allowed': 'Enable this sign-in provider in Firebase Authentication.',
    'auth/unauthorized-domain': 'Add this domain to Firebase Authentication authorized domains.',
    'auth/popup-closed-by-user': 'The sign-in window was closed.',
    'auth/network-request-failed': 'Network error. Check your connection.'
  };
  return messages[error.code] || 'The operation could not be completed. Check Firebase configuration.';
}
function showError(kind, message) {
  const box = $(kind === 'signup' ? 'signupErr' : 'loginErr');
  const text = $(kind === 'signup' ? 'signupErrMsg' : 'loginErrMsg');
  if (box && text) { text.textContent = message; box.style.display = 'block'; }
}
function loading(id, value) {
  const button = $(id); if (!button) return;
  button.disabled = value;
  if (value) button.dataset.originalText ||= button.innerHTML;
  button.innerHTML = value ? '<span class="spinner-border spinner-border-sm me-2"></span>Please wait...' : (button.dataset.originalText || button.innerHTML);
}
function userShape(user) { return { name: user.displayName || user.email.split('@')[0], email: user.email, plan: 'Starter Plan' }; }

window.doLogin = async function doLogin() {
  const email = $('loginEmail')?.value.trim(), password = $('loginPass')?.value || '';
  if (!email || !password) return showError('login', 'Enter your email and password.');
  loading('loginBtn', true);
  try { await signInWithEmailAndPassword(auth, email, password); }
  catch (error) { showError('login', errorMessage(error)); }
  finally { loading('loginBtn', false); }
};
window.doSignup = async function doSignup() {
  const name = $('signupName')?.value.trim(), email = $('signupEmail')?.value.trim(), password = $('signupPass')?.value || '';
  if (!name || !email || password.length < 8) return showError('signup', 'Enter your name, a valid email and a password of at least 8 characters.');
  loading('signupBtn', true);
  try { const result = await createUserWithEmailAndPassword(auth, email, password); await result.user.updateProfile({ displayName: name }); }
  catch (error) { showError('signup', errorMessage(error)); }
  finally { loading('signupBtn', false); }
};
window.quickLogin = async function quickLogin(provider) {
  try { await signInWithPopup(auth, provider === 'google' ? new GoogleAuthProvider() : new GithubAuthProvider()); }
  catch (error) { showError('login', errorMessage(error)); showError('signup', errorMessage(error)); }
};
window.doLogout = () => auth ? signOut(auth) : null;

const originalClearChat = window.clearChat;
window.clearChat = function clearChat() { chat = []; originalClearChat?.(); };
window.quickMsg = message => { if ($('chatInp')) $('chatInp').value = message; window.sendChat(); };
window.sendChat = async function sendChat() {
  const input = $('chatInp'), message = input?.value.trim();
  if (!message || chatPending) return;
  chatPending = true;
  const sendButton = $('chatSendBtn'); if (sendButton) sendButton.disabled = true;
  input.value = ''; input.style.height = 'auto';
  window.appendMsg?.(message, 'user'); chat.push({ role: 'user', content: message });
  const typing = window.appendTyping?.();
  try {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error('AUTH');
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'chat', message, history: chat.slice(0, -1).slice(-19) }), signal: AbortSignal.timeout(35000) });
    const data = await response.json().catch(() => ({})); if (!response.ok) { const failure = new Error(data.error || `Chat service returned HTTP ${response.status}.`); failure.code = data.code; throw failure; }
    const reply = data.reply || 'I could not generate a response.'; chat.push({ role: 'assistant', content: reply }); window.appendMsg?.(reply, 'ai');
  } catch (error) { const message = error.message === 'AUTH' ? 'Your session expired. Please sign in again.' : error.name === 'TimeoutError' ? 'The AI service took too long to respond. Please try again.' : error.message || 'I could not connect to the AI service. Check your Vercel environment variables.'; window.appendMsg?.(message, 'ai'); }
  finally { chatPending = false; if (sendButton) sendButton.disabled = false; if (typing) window.removeTyping?.(typing); input?.focus(); }
};

function updateStats(name, rows) {
  const values = document.querySelectorAll('#sec-overview .db-stat-val'), labels = document.querySelectorAll('#sec-overview .db-stat-lbl');
  if (name === 'leads' && values[0]) { values[0].textContent = rows.length.toLocaleString(); labels[0].textContent = 'Prospects'; }
  if (name === 'tasks' && values[1]) { values[1].textContent = rows.filter(row => row.status === 'pending').length.toLocaleString(); labels[1].textContent = 'Pending Follow-ups'; }
  if (name === 'leads' && values[2]) { values[2].textContent = `$${rows.reduce((sum, row) => sum + (Number(row.value) || 0), 0).toLocaleString()}`; labels[2].textContent = 'Pipeline Value'; }
  if (name === 'runs' && values[3]) { values[3].textContent = rows.length.toLocaleString(); labels[3].textContent = 'Automation Runs'; }
}
function resetStats() {
  const values = document.querySelectorAll('#sec-overview .db-stat-val'), labels = document.querySelectorAll('#sec-overview .db-stat-lbl');
  ['Prospects', 'Pending Follow-ups', 'Pipeline Value', 'Automation Runs'].forEach((label, index) => { if (values[index]) values[index].textContent = '—'; if (labels[index]) labels[index].textContent = label; });
}
function renderActivity(rows) {
  const target = $('liveActivity'); if (!target) return;
  target.replaceChildren(...rows.slice(0, 4).map(row => {
    const item = document.createElement('div'); item.style.cssText = 'display:flex;gap:10px;padding:10px;background:var(--bg3);border-radius:10px;font-size:.78rem';
    const dot = document.createElement('span'); dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#34d399;margin-top:4px;flex-shrink:0';
    const text = document.createElement('span'); text.style.color = 'var(--tx2)'; text.textContent = row.message || row.title || 'Automation updated';
    const time = document.createElement('span'); time.style.cssText = 'margin-left:auto;color:var(--tx3);white-space:nowrap'; time.textContent = 'recently'; item.append(dot, text, time); return item;
  }));
}
function renderEntities(sectionId, rows) {
  const host = document.querySelector(`#sec-${sectionId}`); if (!host) return;
  let list = host.querySelector('.nexus-live-list');
  if (!list) { list = document.createElement('div'); list.className = 'nexus-live-list mb-3'; host.querySelector('.container-fluid, .row')?.prepend(list); }
  list.replaceChildren(...rows.slice(0, 20).map(row => {
    const item = document.createElement('div'); item.className = 'd-flex justify-content-between align-items-center gap-3 p-3 mb-2'; item.style.cssText = 'background:var(--bg3);border:1px solid var(--bd);border-radius:10px';
    const info = document.createElement('div'); info.style.minWidth = '0';
    const name = document.createElement('strong'); name.textContent = row.name || row.provider || row.title || 'Untitled';
    const meta = document.createElement('small'); meta.style.color = 'var(--tx3)'; meta.textContent = sectionId === 'agents' ? `${modelLabel(row.model)} · ${row.status || 'enabled'}` : (row.status || row.trigger || 'Active');
    info.append(name, document.createElement('br'), meta); item.append(info);
    if (sectionId === 'agents') {
      const actions = document.createElement('div'); actions.className = 'd-flex gap-2 flex-shrink-0';
      const view = document.createElement('button'); view.className = 'boc btn py-2'; view.innerHTML = '<i class="fa-solid fa-play me-1"></i>Test'; view.onclick = () => openAgentTest(row, row.id);
      const configure = document.createElement('button'); configure.className = 'bgrd btn py-2'; configure.innerHTML = '<i class="fa-solid fa-sliders me-1"></i>Configure'; configure.onclick = () => openAgentEditor(row, row.id);
      actions.append(view, configure); item.append(actions);
    }
    return item;
  }));
}
async function callBusiness(body) {
  const token = await auth.currentUser?.getIdToken(); if (!token) throw new Error('AUTH');
  const response = await fetch('/api/business', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed.'); return data;
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
function modal(title, fields, onSave) {
  const wrap = document.createElement('div'); wrap.style.cssText = 'position:fixed;inset:0;background:#0009;z-index:3000;display:grid;place-items:center;padding:20px';
  const box = document.createElement('div'); box.style.cssText = 'background:var(--bg2);border:1px solid var(--bd);border-radius:16px;padding:24px;width:min(520px,100%)';
  const controls = fields.map(f => {
    if (f.type === 'note') return `<div class="mb-3 p-3" style="background:var(--bg3);border:1px solid var(--bd);border-radius:10px;color:var(--tx2);font-size:.8rem;line-height:1.5">${escapeHtml(f.value || '')}</div>`;
    const label = `<label class="olbl">${escapeHtml(f.label)}</label>`;
    if (f.type === 'select') return `${label}<select class="oinp mb-3" data-field="${escapeHtml(f.key)}">${f.options.map(option => `<option value="${escapeHtml(option.value)}" ${option.value === f.value ? 'selected' : ''}>${escapeHtml(option.label)}${option.description ? ` — ${escapeHtml(option.description)}` : ''}</option>`).join('')}</select>`;
    if (f.type === 'textarea') return `${label}<textarea class="oinp mb-3" data-field="${escapeHtml(f.key)}" rows="${f.rows || 4}" placeholder="${escapeHtml(f.placeholder || '')}">${escapeHtml(f.value || '')}</textarea>`;
    return `${label}<input class="oinp mb-3" data-field="${escapeHtml(f.key)}" value="${escapeHtml(f.value || '')}" placeholder="${escapeHtml(f.placeholder || '')}"${f.readonly ? ' readonly' : ''}>`;
  }).join('');
  box.innerHTML = `<h4 style="margin-bottom:18px">${escapeHtml(title)}</h4>${controls}<div class="d-flex gap-2 justify-content-end"><button class="boc btn" data-cancel>Cancel</button><button class="bgrd btn" data-save>Save</button></div>`;
  wrap.append(box); document.body.append(wrap); box.querySelector('[data-cancel]').onclick = () => wrap.remove(); box.querySelector('[data-save]').onclick = async () => { const data = {}; box.querySelectorAll('[data-field]').forEach(i => data[i.dataset.field] = i.value.trim()); try { await onSave(data); wrap.remove(); } catch (e) { alert(e.message); } }; return wrap;
}
const modelFields = (value = DEFAULT_OPENAI_MODEL) => [{ key: 'model', label: 'OpenAI model', type: 'select', value, options: OPENAI_MODELS }];
const telegramAgentOptions = Object.entries(DEFAULT_AGENTS).map(([value, agent]) => ({ value, label: `${agent.name} · ${modelLabel(agent.model)}` }));
function telegramFields(integration = {}) {
  return [
    { type: 'note', value: 'The bot token and webhook secret stay in Vercel environment variables. This form stores only Telegram metadata and the OpenAI agent selected for replies.' },
    { key: 'botUsername', label: 'Telegram bot', value: integration.botUsername || '@WSTUDIO3DBot', placeholder: '@WSTUDIO3DBot' },
    { key: 'businessProfile', label: 'Telegram Business profile', value: integration.businessProfile || '@wstudiio3d', placeholder: '@wstudiio3d' },
    { key: 'agentId', label: 'Replying agent', type: 'select', value: integration.agentId || 'support-bot-v2-1', options: telegramAgentOptions },
    { key: 'status', label: 'Connection status', type: 'select', value: integration.status || 'Needs setup', options: [{ value: 'Needs setup', label: 'Needs setup' }, { value: 'Connected', label: 'Connected' }, { value: 'Paused', label: 'Paused' }] },
    { key: 'webhookUrl', label: 'Webhook URL', value: integration.webhookUrl || `${window.location.origin}/api/telegram`, readonly: true }
  ];
}
function agentFields(agent = {}) {
  return [
    { key: 'name', label: 'Agent name', value: agent.name || '', placeholder: 'Support Agent' },
    { key: 'description', label: 'Business area', value: agent.description || '', placeholder: 'What this agent handles' },
    ...modelFields(agent.model || DEFAULT_OPENAI_MODEL),
    { key: 'instructions', label: 'Instructions', type: 'textarea', rows: 5, value: agent.instructions || '', placeholder: 'Describe the agent behavior and boundaries' },
    { key: 'status', label: 'Status', type: 'select', value: agent.status === 'paused' ? 'paused' : 'enabled', options: [{ value: 'enabled', label: 'Enabled' }, { value: 'paused', label: 'Paused' }] }
  ];
}
function openAgentEditor(agent = {}, id = null) {
  const seed = { ...(id ? getDefaultAgent(id) || {} : {}), ...agent };
  return modal(id ? 'Configure Agent' : 'Deploy New Agent', agentFields(seed), data => callBusiness({ action: 'saveEntity', collection: 'agents', ...(id ? { id } : {}), data }));
}
function openAgentTest(agent = {}, id) {
  const seed = { ...(id ? getDefaultAgent(id) || {} : {}), ...agent };
  if (!id) return alert('Save this agent before running a test.');
  return modal(`Test ${seed.name || 'Agent'}`, [{ key: 'message', label: 'Test message', type: 'textarea', rows: 4, placeholder: 'Ask this agent to help with a business task.' }], async data => {
    if (!auth.currentUser) throw new Error('Your session expired. Please sign in again.');
    const result = await callBusiness({ action: 'runAgent', agentId: id, message: data.message, history: [] });
    alert(`${result.agent || seed.name} · ${modelLabel(result.model || seed.model)}\n\n${result.reply || 'No response.'}`);
  });
}
function wireWorkspace() {
  if (workspaceWired) return; workspaceWired = true;
  const section = id => document.querySelector(`#sec-${id}`);
  const add = (id, label, fields, collection) => { const btn = [...(section(id)?.querySelectorAll('button') || [])].find(b => b.textContent.includes(label)); btn?.addEventListener('click', () => modal(label, fields, data => callBusiness({ action: 'saveEntity', collection, data }))); };
  const deploy = [...(section('agents')?.querySelectorAll('button') || [])].find(b => b.textContent.includes('Deploy New Agent')); deploy?.addEventListener('click', () => openAgentEditor());
  add('automations', 'Create Automation', [{ key: 'name', label: 'Automation name', placeholder: 'Lead follow-up' }, { key: 'trigger', label: 'Trigger', placeholder: 'New lead' }], 'automations');
  add('integrations', 'Add Integration', [{ key: 'provider', label: 'Provider', placeholder: 'Slack, Notion, CRM...' }, { key: 'status', label: 'Status', placeholder: 'Connected' }], 'integrations');
  const save = [...(section('settings')?.querySelectorAll('button') || [])].find(b => b.textContent.includes('Save Changes')); save?.addEventListener('click', async () => { try { await callBusiness({ action: 'saveProfile', name: $('profileName')?.value.trim() || 'NexusAI user' }); save.textContent = 'Saved'; setTimeout(() => save.textContent = 'Save Changes', 1500); } catch (e) { alert(e.message); } });
  section('agents')?.querySelectorAll('.agent-card').forEach(card => {
    const id = card.dataset.agentId; const seed = getDefaultAgent(id) || {};
    card.querySelectorAll('button').forEach(btn => { if (btn.textContent.includes('Configure')) btn.addEventListener('click', () => openAgentEditor(seed, id)); if (btn.textContent.includes('View')) btn.addEventListener('click', () => openAgentTest(seed, id)); });
  });
  document.querySelectorAll('#sec-integrations button').forEach(btn => {
    if (!btn.textContent.includes('Configure')) return;
    const card = btn.closest('[data-integration-id]');
    if (card?.dataset.integrationId === 'telegram') {
      btn.addEventListener('click', () => modal('Configure Telegram', telegramFields(), data => callBusiness({ action: 'saveEntity', collection: 'integrations', id: 'telegram', data: { ...data, provider: 'telegram' } })));
      return;
    }
    btn.addEventListener('click', () => modal('Configure Integration', [{ key: 'status', label: 'Status', value: 'Connected' }, { key: 'notes', label: 'Notes' }], data => callBusiness({ action: 'saveEntity', collection: 'integrations', data })));
  });
  const telegramStatusButton = section('integrations')?.querySelector('[data-telegram-status]');
  telegramStatusButton?.addEventListener('click', async () => {
    telegramStatusButton.disabled = true;
    try {
      const result = await callBusiness({ action: 'telegramStatus' });
      const variableState = Object.entries(result.variables || {}).map(([name, present]) => `${name}: ${present ? 'set' : 'missing'}`).join('\n');
      const webhookState = result.webhook ? `\nWebhook URL: ${result.webhook.urlConfigured ? (result.webhook.urlMatches ? 'correct' : 'different URL') : 'not registered'}\nPending updates: ${result.webhook.pendingUpdates}` : '';
      alert(`${result.bot?.name || 'Telegram'}${result.bot?.username ? ` (@${result.bot.username})` : ''}\n\n${result.error || result.code}${result.ownerUidMatches === false ? '\nTELEGRAM_OWNER_UID does not match the signed-in user.' : ''}${webhookState}\n\n${variableState}`);
    } catch (error) { alert(error.message); }
    finally { telegramStatusButton.disabled = false; }
  });
  const telegramRegisterButton = section('integrations')?.querySelector('[data-telegram-register]');
  telegramRegisterButton?.addEventListener('click', async () => {
    if (!window.confirm('Register the Vercel webhook with Telegram now?')) return;
    telegramRegisterButton.disabled = true;
    try {
      const result = await callBusiness({ action: 'telegramRegister' });
      alert(result.ok ? `Webhook registered at ${result.webhookUrl}. Open @WSTUDIO3DBot and press START BOT.` : `Telegram setup failed: ${result.code}`);
    } catch (error) { alert(error.message); }
    finally { telegramRegisterButton.disabled = false; }
  });
}
function subscribe(user) {
  const run = ++generation;
  resetStats();
  const watch = (name, callback) => { const stop = onSnapshot(query(collection(db, 'users', user.uid, name), orderBy('createdAt', 'desc'), limit(100)), snap => { if (generation !== run) return; const rows = snap.docs.map(doc => ({ id: doc.id, ...doc.data() })); updateStats(name, rows); callback(rows); }, error => { if (generation === run) console.warn(`${name} unavailable`, error.code); }); stops.push(stop); };
  watch('leads', rows => renderActivity(rows)); watch('tasks', rows => renderActivity(rows)); watch('runs', rows => renderActivity(rows));
  watch('agents', rows => renderEntities('agents', rows)); watch('automations', rows => renderEntities('automations', rows)); watch('integrations', rows => renderEntities('integrations', rows));
  wireWorkspace();
}

if (Object.values(config).every(Boolean)) {
  const app = initializeApp(config); auth = getAuth(app); db = getFirestore(app);
  onAuthStateChanged(auth, user => { stops.forEach(stop => stop()); stops = []; if (user) { window.loginSuccess?.(userShape(user)); subscribe(user); } else { generation++; document.querySelector('#dashboard')?.style.setProperty('display', 'none'); document.querySelector('#landing')?.style.setProperty('display', 'block'); } });
  const forgot = document.querySelector('#fLogin a[href="#"]');
  forgot?.addEventListener('click', async event => { event.preventDefault(); const email = $('loginEmail')?.value.trim(); if (!email) return showError('login', 'Enter your email first.'); try { await sendPasswordResetEmail(auth, email); showError('login', 'If that account exists, a reset email has been sent.'); } catch (error) { showError('login', errorMessage(error)); } });
} else {
  document.querySelectorAll('#loginBtn,#signupBtn').forEach(button => { button.disabled = true; });
  showError('login', 'Firebase is not configured. Add the VITE_FIREBASE_* variables in Vercel.');
}
