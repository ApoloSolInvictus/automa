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
let auth, db, stops = [], chat = [], generation = 0, chatPending = false, workspaceWired = false, telegramIntegration = {}, gmailIntegration = {};
const crmState = { companies: [], contacts: [], opportunities: [], activities: [], contracts: [], services: [] };
const DEFAULT_WORKSPACE_COLOR = '#0b2a4a';
const INTEGRATION_CATALOG = Object.freeze({
  discord: { label: 'Discord', scope: 'Messages and escalation routing' },
  github: { label: 'GitHub', scope: 'Repository events, issues, and pull requests' },
  'google-drive': { label: 'Google Drive', scope: 'Approved folders and document context' },
  'google-docs': { label: 'Google Docs', scope: 'Contract and client document actions' },
  'google-calendar': { label: 'Google Calendar', scope: 'Availability and follow-up events' },
  'google-sheets': { label: 'Google Sheets', scope: 'CRM and workflow activity logs' }
});
let currentUser = null;
let workspace = { id: null, name: 'Personal workspace', color: DEFAULT_WORKSPACE_COLOR, role: 'owner', members: [], pendingInvites: [] };
let workspaceOptions = [workspace];

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
  if (sectionId === 'integrations') {
    telegramIntegration = rows.find(row => row.id === 'telegram' || row.provider?.toLowerCase() === 'telegram') || {};
    gmailIntegration = rows.find(row => row.id === 'gmail' || row.provider?.toLowerCase() === 'gmail') || {};
    const badge = host.querySelector('[data-telegram-status-label]');
    if (badge && telegramIntegration.status) badge.textContent = telegramIntegration.status;
    rows.forEach(row => {
      const card = [...host.querySelectorAll('[data-integration-id]')].find(item => item.dataset.integrationId === row.id);
      if (!card) return;
      card.dataset.integrationStatus = row.status || 'Available';
      const statusLabel = card.querySelector('[data-integration-status-label]');
      if (statusLabel) statusLabel.textContent = row.status || 'Available';
    });
    if (gmailIntegration.status) updateGmailUi({ connected: gmailIntegration.status === 'Connected', status: gmailIntegration.status, email: gmailIntegration.email || '' });
  }
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
const crmStageLabels = Object.freeze({ lead: 'Lead', qualified: 'Qualified', proposal: 'Proposal', won: 'Won', lost: 'Lost' });
const crmKindLabels = Object.freeze({ companies: 'Company', contacts: 'Contact', opportunities: 'Opportunity', activities: 'Activity', contracts: 'Contract', services: 'Service' });
function crmCompanyName(id) { return crmState.companies.find(company => company.id === id)?.name || 'No company'; }
function crmContactName(id) {
  const contact = crmState.contacts.find(item => item.id === id);
  return contact ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim() : 'No contact';
}
function crmFormatAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? `$${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—';
}
function crmMatches(row, search) {
  if (!search) return true;
  return Object.values(row).some(value => typeof value === 'string' && value.toLowerCase().includes(search));
}
function crmActionButton(label, icon, onClick) {
  const button = document.createElement('button');
  button.className = 'boc btn py-1 px-2';
  button.style.cssText = 'font-size:.68rem;border-radius:8px';
  button.innerHTML = `<i class="fa-solid ${icon} me-1"></i>${label}`;
  button.addEventListener('click', event => { event.stopPropagation(); onClick(); });
  return button;
}
function renderCrm() {
  const search = ($('crmSearch')?.value || '').trim().toLowerCase();
  const stageFilter = $('crmStageFilter')?.value || 'all';
  const companies = crmState.companies.filter(row => crmMatches(row, search));
  const contacts = crmState.contacts.filter(row => crmMatches(row, search));
  const opportunities = crmState.opportunities.filter(row => crmMatches(row, search) && (stageFilter === 'all' || row.stage === stageFilter));
  const activities = crmState.activities.filter(row => crmMatches(row, search));
  const setText = (id, value) => { const element = $(id); if (element) element.textContent = String(value); };
  setText('crmStatCompanies', crmState.companies.length);
  setText('crmStatContacts', crmState.contacts.length);
  setText('crmStatOpportunities', crmState.opportunities.filter(row => !['won', 'lost'].includes(row.stage)).length);
  setText('crmStatActivities', crmState.activities.filter(row => row.status !== 'done' && row.status !== 'completed').length);
  document.querySelectorAll('[data-crm-stage-list]').forEach(list => {
    const stage = list.dataset.crmStageList;
    const stageRows = opportunities.filter(row => row.stage === stage);
    const count = document.querySelector(`[data-crm-count="${stage}"]`); if (count) count.textContent = stageRows.length;
    list.replaceChildren(...(stageRows.length ? stageRows.map(row => {
      const card = document.createElement('div'); card.className = 'crm-op-card';
      const top = document.createElement('div'); top.className = 'd-flex align-items-start justify-content-between gap-2';
      const main = document.createElement('div'); main.className = 'crm-op-main';
      const name = document.createElement('span'); name.className = 'crm-op-name'; name.textContent = row.name || 'Untitled opportunity';
      const meta = document.createElement('span'); meta.className = 'crm-op-meta'; meta.textContent = `${crmCompanyName(row.companyId)} · ${row.nextStep || 'Next step not set'}`;
      main.append(name, meta); const amount = document.createElement('span'); amount.className = 'crm-op-amount'; amount.textContent = crmFormatAmount(row.amount); top.append(main, amount); card.append(top);
      const actions = document.createElement('div'); actions.className = 'd-flex gap-1 mt-2'; actions.append(crmActionButton('Edit', 'fa-pencil', () => openCrmEditor('opportunities', row.id, row))); card.append(actions);
      return card;
    }) : [Object.assign(document.createElement('div'), { className: 'crm-empty', textContent: 'No opportunities yet.' })]));
  });
  const records = $('crmRecords');
  if (records) {
    const rows = [
      ...companies.map(company => ({ type: 'Company', name: company.name, meta: [company.industry, company.owner, company.status].filter(Boolean).join(' · '), id: company.id, collection: 'companies', data: company })),
      ...contacts.map(contact => ({ type: 'Contact', name: `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || 'Unnamed contact', meta: [crmCompanyName(contact.companyId), contact.role, contact.email].filter(Boolean).join(' · '), id: contact.id, collection: 'contacts', data: contact }))
    ];
    records.replaceChildren(...(rows.length ? rows.slice(0, 20).map(row => { const item = document.createElement('div'); item.className = 'crm-record'; const main = document.createElement('div'); main.className = 'crm-record-main'; const name = document.createElement('span'); name.className = 'crm-record-name'; name.textContent = row.name; const meta = document.createElement('span'); meta.className = 'crm-record-meta'; meta.textContent = `${row.type} · ${row.meta || 'No details yet'}`; main.append(name, meta); item.append(main, crmActionButton('Edit', 'fa-pencil', () => openCrmEditor(row.collection, row.id, row.data))); return item; }) : [Object.assign(document.createElement('div'), { className: 'crm-empty', textContent: 'Create a company or contact to start your CRM.' })]));
  }
  const activityList = $('crmActivities');
  if (activityList) {
    activityList.replaceChildren(...(activities.length ? activities.slice(0, 12).map(activity => { const item = document.createElement('div'); item.className = 'crm-activity'; const dot = document.createElement('span'); dot.className = 'crm-activity-dot'; const main = document.createElement('div'); main.style.minWidth = '0'; const subject = document.createElement('span'); subject.className = 'crm-record-name'; subject.textContent = activity.subject || 'CRM activity'; const meta = document.createElement('span'); meta.className = 'crm-record-meta'; meta.textContent = `${activity.type || 'task'} · ${crmCompanyName(activity.companyId)}${activity.dueDate ? ` · ${activity.dueDate}` : ''}`; main.append(subject, meta); item.append(dot, main); item.append(crmActionButton(activity.status === 'done' ? 'Done' : 'Edit', activity.status === 'done' ? 'fa-check' : 'fa-pencil', () => openCrmEditor('activities', activity.id, activity))); return item; }) : [Object.assign(document.createElement('div'), { className: 'crm-empty', textContent: 'No activities scheduled.' })]));
  }
  const contractList = $('crmContracts');
  if (contractList) {
    const rows = crmState.contracts.filter(row => crmMatches(row, search));
    contractList.replaceChildren(...(rows.length ? rows.slice(0, 12).map(contract => {
      const item = document.createElement('div'); item.className = 'crm-activity';
      const main = document.createElement('div'); main.style.minWidth = '0';
      const subject = document.createElement('span'); subject.className = 'crm-record-name'; subject.textContent = contract.name || 'Contract';
      const meta = document.createElement('span'); meta.className = 'crm-record-meta'; meta.textContent = `${contract.status || 'draft'} · ${crmCompanyName(contract.companyId)}${contract.renewalDate ? ` · Renews ${contract.renewalDate}` : ''}${String(contract.customerVisible).toLowerCase() === 'true' ? ' · Customer visible' : ''}`;
      main.append(subject, meta); item.append(main, crmActionButton('Edit', 'fa-pencil', () => openCrmEditor('contracts', contract.id, contract))); return item;
    }) : [Object.assign(document.createElement('div'), { className: 'crm-empty', textContent: 'No contracts yet.' })]));
  }
  const serviceList = $('crmServices');
  if (serviceList) {
    const rows = crmState.services.filter(row => crmMatches(row, search));
    serviceList.replaceChildren(...(rows.length ? rows.slice(0, 12).map(service => {
      const item = document.createElement('div'); item.className = 'crm-activity';
      const main = document.createElement('div'); main.style.minWidth = '0';
      const subject = document.createElement('span'); subject.className = 'crm-record-name'; subject.textContent = service.name || 'Service';
      const meta = document.createElement('span'); meta.className = 'crm-record-meta'; meta.textContent = `${service.status || 'draft'} · ${crmCompanyName(service.companyId)}${service.plan ? ` · ${service.plan}` : ''}${String(service.customerVisible).toLowerCase() === 'true' ? ' · Customer visible' : ''}`;
      main.append(subject, meta); item.append(main, crmActionButton('Edit', 'fa-pencil', () => openCrmEditor('services', service.id, service))); return item;
    }) : [Object.assign(document.createElement('div'), { className: 'crm-empty', textContent: 'No services yet.' })]));
  }
}
function resetCrmState() {
  Object.keys(crmState).forEach(key => { crmState[key] = []; });
  renderCrm();
}
function workspacePayload() { return workspace.id ? { orgId: workspace.id } : {}; }
async function callBusiness(body) {
  const token = await auth.currentUser?.getIdToken(); if (!token) throw new Error('AUTH');
  const response = await fetch('/api/business', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed.'); return data;
}
async function callGmail(body) {
  const token = await auth.currentUser?.getIdToken(); if (!token) throw new Error('AUTH');
  const response = await fetch('/api/gmail', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Gmail request failed.'); return data;
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
function normalizedWorkspaceColor(value) {
  const color = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : DEFAULT_WORKSPACE_COLOR;
}
function hexToRgba(value, alpha = 0.16) {
  const color = normalizedWorkspaceColor(value).slice(1);
  const channel = index => parseInt(color.slice(index, index + 2), 16);
  return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${alpha})`;
}
function createModalShell(width = 'min(520px,100%)', zIndex = 3000) {
  const wrap = document.createElement('div');
  wrap.className = 'automa-modal-overlay';
  wrap.style.zIndex = zIndex;
  const box = document.createElement('div');
  box.className = 'automa-modal-card';
  box.style.width = width;
  const close = () => { document.removeEventListener('keydown', onKey); wrap.remove(); };
  const onKey = event => { if (event.key === 'Escape') close(); };
  wrap.addEventListener('click', event => { if (event.target === wrap) close(); });
  document.addEventListener('keydown', onKey);
  return { wrap, box, close };
}
function modal(title, fields, onSave) {
  const { wrap, box, close } = createModalShell('min(520px,100%)');
  const controls = fields.map(f => {
    if (f.type === 'note') return `<div class="mb-3 p-3" style="background:var(--bg3);border:1px solid var(--bd);border-radius:10px;color:var(--tx2);font-size:.8rem;line-height:1.5">${escapeHtml(f.value || '')}</div>`;
    const label = `<label class="olbl">${escapeHtml(f.label)}</label>`;
    if (f.type === 'select') return `${label}<select class="oinp mb-3" data-field="${escapeHtml(f.key)}">${f.options.map(option => `<option value="${escapeHtml(option.value)}" ${option.value === f.value ? 'selected' : ''}>${escapeHtml(option.label)}${option.description ? ` — ${escapeHtml(option.description)}` : ''}</option>`).join('')}</select>`;
    if (f.type === 'textarea') return `${label}<textarea class="oinp mb-3" data-field="${escapeHtml(f.key)}" rows="${f.rows || 4}" placeholder="${escapeHtml(f.placeholder || '')}">${escapeHtml(f.value || '')}</textarea>`;
    if (f.type === 'color') return `${label}<div class="workspace-color-field mb-3"><input type="color" data-field="${escapeHtml(f.key)}" value="${escapeHtml(normalizedWorkspaceColor(f.value))}" aria-label="${escapeHtml(f.label)}"><span>${escapeHtml(f.help || 'Choose the color shown in the workspace switcher.')}</span></div>`;
    const inputType = ['url', 'email', 'date', 'number', 'tel'].includes(f.type) ? f.type : 'text';
    return `${label}<input type="${inputType}" class="oinp mb-3" data-field="${escapeHtml(f.key)}" value="${escapeHtml(f.value || '')}" placeholder="${escapeHtml(f.placeholder || '')}"${f.readonly ? ' readonly' : ''}>`;
  }).join('');
  box.innerHTML = `<div class="automa-modal-head"><h4>${escapeHtml(title)}</h4><button type="button" class="automa-modal-close" data-modal-close aria-label="Close" title="Close">&times;</button></div>${controls}<div class="d-flex gap-2 justify-content-end"><button class="boc btn" data-cancel>Cancel</button><button class="bgrd btn" data-save>Save</button></div>`;
  wrap.append(box); document.body.append(wrap); box.querySelector('[data-modal-close]').onclick = close; box.querySelector('[data-cancel]').onclick = close; box.querySelector('[data-save]').onclick = async () => { const data = {}; box.querySelectorAll('[data-field]').forEach(i => data[i.dataset.field] = i.value.trim()); try { await onSave(data); close(); } catch (e) { showCrmNotice(title, e.message || 'The request could not be completed.'); } }; return wrap;
}
const modelFields = (value = DEFAULT_OPENAI_MODEL) => [{ key: 'model', label: 'OpenAI model', type: 'select', value, options: OPENAI_MODELS }];
const telegramAgentOptions = Object.entries(DEFAULT_AGENTS).map(([value, agent]) => ({ value, label: `${agent.name} · ${modelLabel(agent.model)}` }));
function telegramFields(integration = {}) {
  return [
    { type: 'note', value: 'The bot token and webhook secret stay in Vercel only. Update TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET under Vercel Project Settings → Environment Variables → Production, then redeploy. This form stores only Telegram metadata and the OpenAI agent selected for replies.' },
    { key: 'botUsername', label: 'Telegram bot', value: integration.botUsername || '@WSTUDIO3DBot', placeholder: '@WSTUDIO3DBot' },
    { key: 'businessProfile', label: 'Telegram Business profile', value: integration.businessProfile || '@wstudiio3d', placeholder: '@wstudiio3d' },
    { key: 'agentId', label: 'Replying agent', type: 'select', value: integration.agentId || 'support-bot-v2-1', options: telegramAgentOptions },
    { key: 'status', label: 'Connection status', type: 'select', value: integration.status || 'Needs setup', options: [{ value: 'Needs setup', label: 'Needs setup' }, { value: 'Active', label: 'Active' }, { value: 'Connected', label: 'Connected (legacy)' }, { value: 'Paused', label: 'Paused' }] },
    { key: 'webhookUrl', label: 'Webhook URL', type: 'url', value: integration.webhookUrl || `${window.location.origin}/api/telegram`, placeholder: 'https://automa.wstudio3d.com/api/telegram' }
  ];
}
window.openTelegramPairing = function openTelegramPairing() {
  if (!currentUser) return showCrmNotice('Telegram client link', 'Sign in before linking a CRM contact.');
  if (workspace.role === 'viewer') return showCrmNotice('Telegram client link', 'Viewer members have read-only access. Ask an Owner or Admin to create the secure link.');
  if (!crmState.contacts.length) return showCrmNotice('Telegram client link', 'Create a CRM contact first, then generate a secure Telegram link for that contact.');
  const options = crmState.contacts.map(contact => ({ value: contact.id, label: `${`${contact.firstName || ''} ${contact.lastName || ''}`.trim() || 'Unnamed contact'}${crmCompanyName(contact.companyId) !== 'No company' ? ` · ${crmCompanyName(contact.companyId)}` : ''}` }));
  return modal('Link a Telegram client', [
    { type: 'note', value: 'Generate a one-time link that expires in 15 minutes. The customer opens it in Telegram to bind this chat to exactly one CRM contact. Automa will only expose that contact’s approved contracts and services; the bot token never appears here.' },
    { key: 'contactId', label: 'CRM contact', type: 'select', value: options[0]?.value || '', options }
  ], async data => {
    const result = await callBusiness({ action: 'telegramPairingCreate', ...workspacePayload(), contactId: data.contactId });
    showCrmNotice('Telegram client link created', `Send this one-time link to the selected customer before it expires:\n\n${result.deepLink}\n\nExpires: ${new Date(result.expiresAt).toLocaleString()}`);
  });
};
window.openTelegramIntake = function openTelegramIntake() {
  if (!currentUser) return showCrmNotice('Telegram client intake', 'Sign in before creating an intake link.');
  if (workspace.role === 'viewer') return showCrmNotice('Telegram client intake', 'Viewer members have read-only access. Ask an Owner or Admin to create the secure link.');
  return modal('Create a Telegram client intake link', [
    { type: 'note', value: 'This one-time link opens a step-by-step Telegram form for a new client. It expires in 30 minutes, creates the company, contact, opportunity, requested services and draft contract only after the client confirms the summary, and keeps the data inside this workspace.' }
  ], async () => {
    const result = await callBusiness({ action: 'telegramIntakeCreate', ...workspacePayload() });
    showCrmNotice('Telegram intake link created', `Send this secure link to the new client before it expires:\n\n${result.deepLink}\n\nExpires: ${new Date(result.expiresAt).toLocaleString()}\n\nThe client confirms the details in Telegram before anything is saved.`);
  });
};
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
  return modal(id ? 'Configure Agent' : 'Deploy New Agent', agentFields(seed), data => callBusiness({ action: 'saveEntity', collection: 'agents', ...workspacePayload(), ...(id ? { id } : {}), data }));
}
function openAgentTest(agent = {}, id) {
  const seed = { ...(id ? getDefaultAgent(id) || {} : {}), ...agent };
  if (!id) return showCrmNotice('Agent test', 'Save this agent before running a test.');
  return modal(`Test ${seed.name || 'Agent'}`, [{ key: 'message', label: 'Test message', type: 'textarea', rows: 4, placeholder: 'Ask this agent to help with a business task.' }], async data => {
    if (!auth.currentUser) throw new Error('Your session expired. Please sign in again.');
    const result = await callBusiness({ action: 'runAgent', ...workspacePayload(), agentId: id, message: data.message, history: [] });
    showCrmNotice(`${result.agent || seed.name} · ${modelLabel(result.model || seed.model)}`, result.reply || 'No response.');
  });
}
const AUTOMATION_BLUEPRINTS = Object.freeze({
  triage: {
    name: 'Customer request triage',
    trigger: 'New customer or support message',
    steps: 'Classify the request, set its priority, assign the right agent or queue, and escalate when a human decision is needed.',
    prerequisites: 'Consistent tags or CRM fields and a defined escalation owner.',
    metrics: 'Time to assignment, first response time, and open queue size.'
  },
  autoresponder: {
    name: 'Smart autoresponder',
    trigger: 'New message that matches an approved common question',
    steps: 'Use the selected OpenAI agent to choose an approved answer, include the relevant next step, and escalate when context is missing.',
    prerequisites: 'Common inquiry templates, approved answers, and knowledge links.',
    metrics: 'Deflection rate, response quality, and customer satisfaction.'
  },
  scheduling: {
    name: 'Meeting scheduling',
    trigger: 'Customer or prospect requests a meeting',
    steps: 'Collect the meeting goal, check the permitted availability, propose a slot, and send a confirmation for review.',
    prerequisites: 'Calendar rules, booking link, and a meeting owner.',
    metrics: 'Time to booking, no-show rate, and completed meetings.'
  },
  sync: {
    name: 'Customer context sync',
    trigger: 'New or updated customer, lead, or contract record',
    steps: 'Validate the fields, map them to the destination, record the result, and flag conflicts for a human.',
    prerequisites: 'Field mapping and one source of truth for each record.',
    metrics: 'Sync failures, duplicate records, and synchronization delay.'
  },
  reports: {
    name: 'Scheduled workflow report',
    trigger: 'Scheduled time or reporting period closes',
    steps: 'Gather approved activity data, summarize changes and exceptions, and send the report to the configured recipients.',
    prerequisites: 'Trusted data, report recipients, and a reporting schedule.',
    metrics: 'Delivery time, action rate, and unresolved exceptions.'
  },
  contracts: {
    name: 'Contract follow-up',
    trigger: 'Contract stage changes or a required detail is missing',
    steps: 'Identify missing information, prepare a reminder, route the next approval, and keep the decision with the responsible person.',
    prerequisites: 'Contract stages, owners, required fields, and approval boundaries.',
    metrics: 'Cycle time, overdue steps, and approval completion.'
  }
});
window.openAutomationPlaybook = function openAutomationPlaybook() {
  const button = document.querySelector('.db-nl[onclick*=playbook]');
  if (typeof window.dbNav === 'function') window.dbNav('playbook', button);
};
window.openAutomationBlueprint = function openAutomationBlueprint(key) {
  const blueprint = AUTOMATION_BLUEPRINTS[key];
  if (!blueprint) return;
  return modal(`Create ${blueprint.name}`, [
    { type: 'note', value: `Planning blueprint\n\nPrerequisites: ${blueprint.prerequisites}\n\nMeasure: ${blueprint.metrics}` },
    { key: 'name', label: 'Automation name', value: blueprint.name },
    { key: 'trigger', label: 'Trigger', value: blueprint.trigger },
    { key: 'steps', label: 'Workflow steps', type: 'textarea', rows: 4, value: blueprint.steps },
    { key: 'status', label: 'Status', type: 'select', value: 'draft', options: [{ value: 'draft', label: 'Draft' }, { value: 'enabled', label: 'Enabled' }] }
  ], data => callBusiness({ action: 'saveEntity', ...workspacePayload(), collection: 'automations', data: { ...data, blueprint: key } }));
};
function crmOptions(rows, value, label) {
  return [{ value: '', label: `No ${label}` }, ...rows.map(row => ({ value: row.id, label: label === 'company' || label === 'opportunity' ? row.name : `${row.firstName || ''} ${row.lastName || ''}`.trim() || 'Unnamed contact' }))].map(option => ({ ...option, selected: option.value === value }));
}
function crmFields(collection, seed = {}) {
  if (collection === 'companies') return [
    { key: 'name', label: 'Company name', value: seed.name || '', placeholder: 'Acme Manufacturing' },
    { key: 'industry', label: 'Industry', value: seed.industry || '', placeholder: 'Professional services' },
    { key: 'website', label: 'Website', type: 'url', value: seed.website || '', placeholder: 'https://company.com' },
    { key: 'size', label: 'Company size', type: 'select', value: seed.size || 'small', options: [{ value: 'solo', label: 'Solo / freelancer' }, { value: 'small', label: 'Small business' }, { value: 'mid', label: 'Mid-market' }, { value: 'enterprise', label: 'Enterprise' }] },
    { key: 'owner', label: 'Relationship owner', value: seed.owner || '', placeholder: 'Team or person responsible' },
    { key: 'status', label: 'Status', type: 'select', value: seed.status || 'active', options: [{ value: 'active', label: 'Active' }, { value: 'prospect', label: 'Prospect' }, { value: 'inactive', label: 'Inactive' }] },
    { key: 'notes', label: 'Notes', type: 'textarea', rows: 3, value: seed.notes || '', placeholder: 'Context, goals and relationship notes' }
  ];
  if (collection === 'contacts') return [
    { key: 'firstName', label: 'First name', value: seed.firstName || '', placeholder: 'Alex' },
    { key: 'lastName', label: 'Last name', value: seed.lastName || '', placeholder: 'Morgan' },
    { key: 'companyId', label: 'Company', type: 'select', value: seed.companyId || '', options: crmOptions(crmState.companies, seed.companyId, 'company') },
    { key: 'email', label: 'Work email', type: 'email', value: seed.email || '', placeholder: 'alex@company.com' },
    { key: 'phone', label: 'Phone', type: 'tel', value: seed.phone || '', placeholder: '+1 555 0100' },
    { key: 'role', label: 'Role', value: seed.role || '', placeholder: 'Operations director' },
    { key: 'status', label: 'Status', type: 'select', value: seed.status || 'active', options: [{ value: 'active', label: 'Active' }, { value: 'lead', label: 'Lead' }, { value: 'inactive', label: 'Inactive' }] },
    { key: 'notes', label: 'Notes', type: 'textarea', rows: 3, value: seed.notes || '', placeholder: 'Preferences and relevant context' }
  ];
  if (collection === 'opportunities') return [
    { key: 'name', label: 'Opportunity name', value: seed.name || '', placeholder: 'Operations automation project' },
    { key: 'companyId', label: 'Company', type: 'select', value: seed.companyId || '', options: crmOptions(crmState.companies, seed.companyId, 'company') },
    { key: 'contactId', label: 'Primary contact', type: 'select', value: seed.contactId || '', options: crmOptions(crmState.contacts, seed.contactId, 'contact') },
    { key: 'stage', label: 'Pipeline stage', type: 'select', value: seed.stage || 'lead', options: Object.entries(crmStageLabels).map(([value, label]) => ({ value, label })) },
    { key: 'amount', label: 'Estimated value', type: 'number', value: seed.amount || '', placeholder: '25000' },
    { key: 'probability', label: 'Probability (%)', type: 'number', value: seed.probability || '', placeholder: '50' },
    { key: 'nextStep', label: 'Next step', value: seed.nextStep || '', placeholder: 'Book a discovery call' },
    { key: 'owner', label: 'Opportunity owner', value: seed.owner || '', placeholder: 'Sales or account team' },
    { key: 'expectedClose', label: 'Expected close', type: 'date', value: seed.expectedClose || '' },
    { key: 'notes', label: 'Notes', type: 'textarea', rows: 3, value: seed.notes || '', placeholder: 'Decision process and blockers' }
  ];
  if (collection === 'contracts') return [
    { key: 'name', label: 'Contract name', value: seed.name || '', placeholder: 'Annual services agreement' },
    { key: 'companyId', label: 'Company', type: 'select', value: seed.companyId || '', options: crmOptions(crmState.companies, seed.companyId, 'company') },
    { key: 'contactId', label: 'Primary contact', type: 'select', value: seed.contactId || '', options: crmOptions(crmState.contacts, seed.contactId, 'contact') },
    { key: 'status', label: 'Status', type: 'select', value: seed.status || 'active', options: [{ value: 'active', label: 'Active' }, { value: 'draft', label: 'Draft' }, { value: 'expired', label: 'Expired' }] },
    { key: 'startDate', label: 'Start date', type: 'date', value: seed.startDate || '' },
    { key: 'endDate', label: 'End date', type: 'date', value: seed.endDate || '' },
    { key: 'renewalDate', label: 'Renewal date', type: 'date', value: seed.renewalDate || '' },
    { key: 'summary', label: 'Customer-safe summary', type: 'textarea', rows: 3, value: seed.summary || '', placeholder: 'Summary that the linked customer may see' },
    { key: 'customerVisible', label: 'Visible to linked customer', type: 'select', value: seed.customerVisible || 'false', options: [{ value: 'true', label: 'Yes — share summary and dates' }, { value: 'false', label: 'No — keep private' }] }
  ];
  if (collection === 'services') return [
    { key: 'name', label: 'Service name', value: seed.name || '', placeholder: 'Managed workflow operations' },
    { key: 'companyId', label: 'Company', type: 'select', value: seed.companyId || '', options: crmOptions(crmState.companies, seed.companyId, 'company') },
    { key: 'contactId', label: 'Primary contact', type: 'select', value: seed.contactId || '', options: crmOptions(crmState.contacts, seed.contactId, 'contact') },
    { key: 'status', label: 'Status', type: 'select', value: seed.status || 'active', options: [{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }, { value: 'ended', label: 'Ended' }] },
    { key: 'plan', label: 'Plan', value: seed.plan || '', placeholder: 'Business' },
    { key: 'description', label: 'Customer-safe description', type: 'textarea', rows: 3, value: seed.description || '', placeholder: 'Description that the linked customer may see' },
    { key: 'renewalDate', label: 'Renewal date', type: 'date', value: seed.renewalDate || '' },
    { key: 'customerVisible', label: 'Visible to linked customer', type: 'select', value: seed.customerVisible || 'false', options: [{ value: 'true', label: 'Yes — share service details' }, { value: 'false', label: 'No — keep private' }] }
  ];
  return [
    { key: 'type', label: 'Activity type', type: 'select', value: seed.type || 'task', options: [{ value: 'call', label: 'Call' }, { value: 'email', label: 'Email' }, { value: 'meeting', label: 'Meeting' }, { value: 'task', label: 'Task' }, { value: 'note', label: 'Note' }] },
    { key: 'subject', label: 'Subject', value: seed.subject || '', placeholder: 'Follow up on proposal' },
    { key: 'companyId', label: 'Company', type: 'select', value: seed.companyId || '', options: crmOptions(crmState.companies, seed.companyId, 'company') },
    { key: 'contactId', label: 'Contact', type: 'select', value: seed.contactId || '', options: crmOptions(crmState.contacts, seed.contactId, 'contact') },
    { key: 'opportunityId', label: 'Opportunity', type: 'select', value: seed.opportunityId || '', options: crmOptions(crmState.opportunities, seed.opportunityId, 'opportunity') },
    { key: 'dueDate', label: 'Due date', type: 'date', value: seed.dueDate || '' },
    { key: 'status', label: 'Status', type: 'select', value: seed.status || 'pending', options: [{ value: 'pending', label: 'Pending' }, { value: 'done', label: 'Done' }] },
    { key: 'notes', label: 'Notes', type: 'textarea', rows: 3, value: seed.notes || '', placeholder: 'Outcome or preparation notes' }
  ];
}
function showCrmNotice(title, message) {
  const { wrap, box, close } = createModalShell('min(620px,100%)');
  box.innerHTML = `<div class="automa-modal-head"><h4>${escapeHtml(title)}</h4><button type="button" class="automa-modal-close" data-modal-close aria-label="Close" title="Close">&times;</button></div><div style="white-space:pre-wrap;color:var(--tx2);font-size:.85rem;line-height:1.65">${escapeHtml(message)}</div><div class="d-flex justify-content-end mt-4"><button class="bgrd btn" data-close>Close</button></div>`;
  wrap.append(box); document.body.append(wrap); box.querySelector('[data-modal-close]').onclick = close; box.querySelector('[data-close]').onclick = close; return wrap;
}
function updateGmailUi(status = {}) {
  const connected = Boolean(status.connected);
  document.querySelectorAll('[data-gmail-status-label]').forEach(element => { element.textContent = status.status || (connected ? 'Connected' : 'Needs setup'); });
  document.querySelectorAll('[data-gmail-email]').forEach(element => { element.textContent = status.email || (connected ? 'Connected Gmail account' : 'HTML email, inbox review, and replies'); });
  document.querySelectorAll('[data-gmail-disconnect]').forEach(button => { button.disabled = !connected; });
  document.querySelectorAll('[data-gmail-review]').forEach(button => { button.disabled = !connected || status.scopeReady === false; });
}
async function loadGmailStatus() {
  if (!currentUser) return;
  try { updateGmailUi(await callGmail({ action: 'gmailStatus', ...workspacePayload() })); }
  catch (error) { updateGmailUi({ status: 'Unavailable' }); console.warn('Gmail status unavailable', error.message); }
}
function recipientList(value) {
  return String(value || '').split(/[;,\n]+/).map(email => email.trim()).filter(Boolean);
}
function previewEmail(frame, html) {
  frame.srcdoc = html || '<!doctype html><html><body style="font-family:Arial,sans-serif;padding:28px;color:#475569">Your live HTML preview will appear here.</body></html>';
}
window.openGmailInboxReview = function openGmailInboxReview() {
  if (!currentUser) return showCrmNotice('Gmail inbox review', 'Sign in and connect Gmail before reviewing messages.');
  const { wrap, box, close: closeModal } = createModalShell('min(1080px,100%)', 3100);
  const heading = document.createElement('div'); heading.className = 'd-flex align-items-start justify-content-between gap-3 mb-3';
  const headingText = document.createElement('div'); headingText.innerHTML = '<h4 style="margin:0 0 5px">AI Gmail Inbox Review</h4><div style="font-size:.82rem;color:var(--tx3)">OpenAI reviews up to 20 recent inbox messages, summarizes them, flags threats, and suggests saved templates for safe replies.</div>';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'automa-modal-close'; close.innerHTML = '&times;'; close.setAttribute('aria-label', 'Close'); close.title = 'Close'; close.onclick = closeModal; heading.append(headingText, close);
  const controls = document.createElement('div'); controls.className = 'd-flex align-items-center gap-2 flex-wrap mb-3';
  const modelLabel = document.createElement('label'); modelLabel.className = 'olbl mb-0'; modelLabel.textContent = 'Review model';
  const model = document.createElement('select'); model.className = 'oinp'; model.style.width = 'min(300px,100%)'; OPENAI_MODELS.forEach(option => { const entry = document.createElement('option'); entry.value = option.id; entry.textContent = option.label; entry.selected = option.id === DEFAULT_OPENAI_MODEL; model.append(entry); });
  const refresh = document.createElement('button'); refresh.className = 'bgrd btn'; refresh.innerHTML = '<i class="fa-solid fa-rotate me-1"></i>Review inbox';
  const status = document.createElement('span'); status.style.cssText = 'font-size:.8rem;color:var(--tx3)'; status.textContent = 'The review never sends, archives, or deletes messages automatically.';
  controls.append(modelLabel, model, refresh, status);
  const summary = document.createElement('div'); summary.className = 'p-3 mb-3'; summary.style.cssText = 'background:var(--bg3);border:1px solid var(--bd);border-radius:10px;white-space:pre-wrap;color:var(--tx2);font-size:.86rem;line-height:1.55'; summary.textContent = 'Click Review inbox to fetch and analyze recent Gmail messages.';
  const list = document.createElement('div');
  const setBusy = value => { refresh.disabled = value; model.disabled = value; };
  const render = result => {
    const messages = Array.isArray(result.messages) ? result.messages : [];
    const reviews = new Map((result.items || []).map(item => [item.messageId, item]));
    const templates = new Map((result.templates || []).map(item => [item.id, item]));
    summary.textContent = `${result.summary || 'No summary returned.'}\n\nReviewed ${messages.length} message${messages.length === 1 ? '' : 's'} with ${result.model || model.value}.`;
    list.replaceChildren();
    if (!messages.length) { list.innerHTML = '<div class="p-4 text-center" style="background:var(--bg3);border:1px solid var(--bd);border-radius:10px;color:var(--tx3)">No inbox messages from the last 30 days were found.</div>'; return; }
    messages.forEach(message => {
      const review = reviews.get(message.id) || { summary: message.snippet || 'No AI review was returned for this message.', priority: 'normal', threatLevel: 'unknown', threatReason: 'No classification returned.', canReply: false, templateId: '' };
      const card = document.createElement('article'); card.className = 'p-3 mb-3'; card.style.cssText = 'background:var(--bg3);border:1px solid var(--bd);border-radius:12px';
      const top = document.createElement('div'); top.className = 'd-flex align-items-start justify-content-between gap-3 flex-wrap';
      const title = document.createElement('div'); const subject = document.createElement('strong'); subject.textContent = message.subject || '(No subject)'; const from = document.createElement('div'); from.style.cssText = 'font-size:.78rem;color:var(--tx3);margin-top:3px'; from.textContent = `${message.from || message.fromEmail || 'Unknown sender'} · ${message.date || 'Unknown date'}`; title.append(subject, from);
      const badge = document.createElement('span'); badge.className = 'bst'; badge.textContent = `${String(review.threatLevel || 'unknown').toUpperCase()} · ${String(review.priority || 'normal').toUpperCase()}`; top.append(title, badge); card.append(top);
      const ai = document.createElement('div'); ai.className = 'mt-3'; ai.style.cssText = 'font-size:.84rem;line-height:1.5;color:var(--tx2);white-space:pre-wrap'; ai.textContent = `${review.summary || 'No summary.'}\nThreat review: ${review.threatReason || 'No reason provided.'}`; card.append(ai);
      const body = document.createElement('details'); body.className = 'mt-2'; const bodySummary = document.createElement('summary'); bodySummary.style.cssText = 'cursor:pointer;color:var(--tx3);font-size:.8rem'; bodySummary.textContent = 'Show message text'; const bodyText = document.createElement('div'); bodyText.className = 'mt-2'; bodyText.style.cssText = 'white-space:pre-wrap;max-height:180px;overflow:auto;font-size:.8rem;color:var(--tx2)'; bodyText.textContent = message.body || message.snippet || '(No readable text)'; body.append(bodySummary, bodyText); card.append(body);
      const actions = document.createElement('div'); actions.className = 'd-flex gap-2 flex-wrap mt-3';
      if (review.canReply && review.templateId && templates.has(review.templateId)) { const reply = document.createElement('button'); reply.className = 'bgrd btn py-2'; reply.innerHTML = '<i class="fa-solid fa-reply me-1"></i>Reply with template'; reply.title = `Template: ${templates.get(review.templateId).name}`; reply.onclick = async () => { if (!window.confirm(`Reply to ${message.fromEmail || message.from || 'this sender'} using “${templates.get(review.templateId).name}”?`)) return; reply.disabled = true; status.textContent = 'Sending the reviewed reply through Gmail…'; try { const sent = await callGmail({ action: 'gmailReply', ...workspacePayload(), id: message.id, templateId: review.templateId }); status.textContent = `Reply sent through Gmail. Message ID: ${sent.id || 'confirmed'}.`; } catch (error) { status.textContent = error.message || 'Gmail could not send the reply.'; } finally { reply.disabled = false; } }; actions.append(reply); }
      if (message.unread) { const read = document.createElement('button'); read.className = 'boc btn py-2'; read.innerHTML = '<i class="fa-regular fa-envelope-open me-1"></i>Mark read'; read.onclick = async () => { read.disabled = true; try { await callGmail({ action: 'gmailMessageModify', ...workspacePayload(), id: message.id, operation: 'markRead' }); await reviewInbox(); } catch (error) { status.textContent = error.message || 'Gmail could not mark this message as read.'; read.disabled = false; } }; actions.append(read); }
      const archive = document.createElement('button'); archive.className = 'boc btn py-2'; archive.innerHTML = '<i class="fa-solid fa-box-archive me-1"></i>Archive'; archive.onclick = async () => { archive.disabled = true; try { await callGmail({ action: 'gmailMessageModify', ...workspacePayload(), id: message.id, operation: 'archive' }); await reviewInbox(); } catch (error) { status.textContent = error.message || 'Gmail could not archive this message.'; archive.disabled = false; } }; actions.append(archive);
      const trash = document.createElement('button'); trash.className = 'boc btn py-2'; trash.innerHTML = '<i class="fa-regular fa-trash-can me-1"></i>Trash'; trash.onclick = async () => { if (!window.confirm('Move this Gmail message to Trash?')) return; trash.disabled = true; try { await callGmail({ action: 'gmailMessageModify', ...workspacePayload(), id: message.id, operation: 'trash' }); await reviewInbox(); } catch (error) { status.textContent = error.message || 'Gmail could not move this message to Trash.'; trash.disabled = false; } }; actions.append(trash);
      card.append(actions); list.append(card);
    });
  };
  const reviewInbox = async () => { setBusy(true); status.textContent = 'Fetching recent Gmail messages and asking OpenAI for a security and reply review…'; try { render(await callGmail({ action: 'gmailInboxReview', ...workspacePayload(), model: model.value })); status.textContent = 'Review complete. Replies and mailbox changes require your confirmation.'; } catch (error) { status.textContent = error.message || 'Gmail inbox review failed.'; } finally { setBusy(false); } };
  refresh.onclick = reviewInbox;
  box.append(heading, controls, summary, list); wrap.append(box); document.body.append(wrap); void reviewInbox(); return wrap;
};
window.openGmailComposer = function openGmailComposer() {
  if (!currentUser) return showCrmNotice('Gmail', 'Sign in before composing an email.');
  const { wrap, box, close: closeModal } = createModalShell('min(1180px,100%)', 3100);
  const title = document.createElement('div'); title.className = 'd-flex align-items-start justify-content-between gap-3 mb-3';
  title.innerHTML = '<div><h4 style="margin:0 0 5px">Gmail HTML Composer</h4><div style="font-size:.82rem;color:var(--tx3)">Describe the email to OpenAI, then review the live preview and HTML before sending.</div></div>';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'automa-modal-close'; close.innerHTML = '&times;'; close.setAttribute('aria-label', 'Close'); close.title = 'Close'; close.onclick = closeModal; title.append(close);
  const form = document.createElement('div'); form.className = 'row g-3';
  const field = (label, placeholder, value = '') => { const holder = document.createElement('div'); holder.className = 'col-md-6'; const caption = document.createElement('label'); caption.className = 'olbl'; caption.textContent = label; const input = document.createElement('input'); input.className = 'oinp'; input.placeholder = placeholder; input.value = value; holder.append(caption, input); return { holder, input }; };
  const to = field('To', 'client@example.com, team@example.com'); const cc = field('CC (optional)', 'manager@example.com'); const bcc = field('BCC (optional)', 'archive@example.com'); const subject = field('Subject', 'Generated subject appears here');
  const modelHolder = document.createElement('div'); modelHolder.className = 'col-md-6'; const modelLabelElement = document.createElement('label'); modelLabelElement.className = 'olbl'; modelLabelElement.textContent = 'OpenAI model'; const model = document.createElement('select'); model.className = 'oinp'; OPENAI_MODELS.forEach(option => { const entry = document.createElement('option'); entry.value = option.id; entry.textContent = option.label; entry.selected = option.id === DEFAULT_OPENAI_MODEL; model.append(entry); }); modelHolder.append(modelLabelElement, model);
  const templateName = field('Template name (optional)', 'Automa customer introduction');
  const templateHolder = document.createElement('div'); templateHolder.className = 'col-md-6'; const templateLabel = document.createElement('label'); templateLabel.className = 'olbl'; templateLabel.textContent = 'Saved HTML templates'; const templateRow = document.createElement('div'); templateRow.className = 'd-flex gap-2'; const templates = document.createElement('select'); templates.className = 'oinp'; templates.setAttribute('aria-label', 'Saved HTML templates'); const emptyTemplate = document.createElement('option'); emptyTemplate.value = ''; emptyTemplate.textContent = 'Load a saved template…'; templates.append(emptyTemplate); const deleteTemplate = document.createElement('button'); deleteTemplate.className = 'boc btn px-3'; deleteTemplate.type = 'button'; deleteTemplate.title = 'Delete selected template'; deleteTemplate.innerHTML = '<i class="fa-regular fa-trash-can"></i>'; deleteTemplate.disabled = true; templateRow.append(templates, deleteTemplate); templateHolder.append(templateLabel, templateRow);
  const promptHolder = document.createElement('div'); promptHolder.className = 'col-12'; const promptLabel = document.createElement('label'); promptLabel.className = 'olbl'; promptLabel.textContent = 'AI email prompt'; const prompt = document.createElement('textarea'); prompt.className = 'oinp'; prompt.rows = 4; prompt.placeholder = 'Example: Write a warm welcome email for Automa customers. Use an email-safe HTML layout, the Automa text logo, three benefits, and a clear call to action.'; promptHolder.append(promptLabel, prompt);
  form.append(to.holder, cc.holder, bcc.holder, subject.holder, modelHolder, templateName.holder, templateHolder, promptHolder);
  const editorRow = document.createElement('div'); editorRow.className = 'row g-3 mt-1';
  const codeHolder = document.createElement('div'); codeHolder.className = 'col-lg-6'; const codeLabel = document.createElement('label'); codeLabel.className = 'olbl'; codeLabel.textContent = 'Editable HTML code'; const code = document.createElement('textarea'); code.className = 'oinp'; code.style.cssText = 'min-height:390px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.76rem;line-height:1.45'; code.spellcheck = false; code.placeholder = '<!doctype html>...'; codeHolder.append(codeLabel, code);
  const previewHolder = document.createElement('div'); previewHolder.className = 'col-lg-6'; const previewLabel = document.createElement('label'); previewLabel.className = 'olbl'; previewLabel.textContent = 'Live email preview'; const frame = document.createElement('iframe'); frame.setAttribute('sandbox', ''); frame.title = 'Gmail HTML preview'; frame.style.cssText = 'display:block;width:100%;height:390px;background:#fff;border:1px solid var(--bd);border-radius:10px'; previewHolder.append(previewLabel, frame); editorRow.append(codeHolder, previewHolder);
  const actions = document.createElement('div'); actions.className = 'd-flex align-items-center gap-2 justify-content-between flex-wrap mt-4'; const status = document.createElement('span'); status.style.cssText = 'font-size:.8rem;color:var(--tx3)'; status.textContent = 'Create a draft, inspect it, optionally save it as a template, then send it through Gmail.'; const buttons = document.createElement('div'); buttons.className = 'd-flex gap-2 flex-wrap'; const generate = document.createElement('button'); generate.className = 'boc btn'; generate.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles me-1"></i>Generate with OpenAI'; const saveTemplate = document.createElement('button'); saveTemplate.className = 'boc btn'; saveTemplate.innerHTML = '<i class="fa-regular fa-bookmark me-1"></i>Save HTML as template'; const send = document.createElement('button'); send.className = 'bgrd btn'; send.innerHTML = '<i class="fa-solid fa-paper-plane me-1"></i>Send with Gmail'; buttons.append(generate, saveTemplate, send); actions.append(status, buttons);
  const setBusy = (button, value) => { button.disabled = value; };
  let activeTemplateId = null;
  const loadTemplates = async (selectedId = activeTemplateId) => {
    try {
      const result = await callGmail({ action: 'gmailTemplateList', ...workspacePayload() });
      templates.replaceChildren();
      const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'Load a saved template…'; templates.append(blank);
      (result.templates || []).forEach(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; option.dataset.template = JSON.stringify(item); templates.append(option); });
      templates.value = selectedId || '';
      deleteTemplate.disabled = !templates.value;
    } catch (error) { status.textContent = error.message || 'Saved templates could not be loaded.'; }
  };
  code.addEventListener('input', () => previewEmail(frame, code.value)); previewEmail(frame, '');
  templates.addEventListener('change', () => {
    const selected = templates.selectedOptions[0];
    activeTemplateId = templates.value || null; deleteTemplate.disabled = !activeTemplateId;
    if (!activeTemplateId || !selected?.dataset.template) return;
    try {
      const saved = JSON.parse(selected.dataset.template);
      templateName.input.value = saved.name || ''; subject.input.value = saved.subject || ''; code.value = saved.html || ''; previewEmail(frame, code.value);
      if (saved.model && [...model.options].some(option => option.value === saved.model)) model.value = saved.model;
      status.textContent = `Loaded template “${saved.name}”. Review it before sending.`;
    } catch { status.textContent = 'This saved template could not be loaded.'; }
  });
  deleteTemplate.onclick = async () => {
    if (!activeTemplateId || !window.confirm('Delete this saved HTML template?')) return;
    setBusy(deleteTemplate, true);
    try { await callGmail({ action: 'gmailTemplateDelete', ...workspacePayload(), id: activeTemplateId }); activeTemplateId = null; templateName.input.value = ''; await loadTemplates(); status.textContent = 'Saved template deleted.'; }
    catch (error) { status.textContent = error.message || 'The template could not be deleted.'; }
    finally { setBusy(deleteTemplate, false); }
  };
  generate.onclick = async () => {
    if (!prompt.value.trim()) return showCrmNotice('Gmail composer', 'Write an AI email prompt first.');
    setBusy(generate, true); status.textContent = 'Generating the HTML email draft…';
    try { const result = await callGmail({ action: 'gmailGenerate', ...workspacePayload(), prompt: prompt.value.trim(), model: model.value }); subject.input.value = result.subject; code.value = result.html; previewEmail(frame, code.value); status.textContent = `Draft generated with ${modelLabel(result.model)}. Review or edit it before sending.`; }
    catch (error) { status.textContent = error.message || 'The email draft could not be generated.'; }
    finally { setBusy(generate, false); }
  };
  saveTemplate.onclick = async () => {
    if (!templateName.input.value.trim() || !subject.input.value.trim() || !code.value.trim()) return showCrmNotice('Save template', 'Add a template name, subject, and HTML before saving.');
    setBusy(saveTemplate, true); status.textContent = 'Saving the HTML template…';
    try {
      const result = await callGmail({ action: 'gmailTemplateSave', ...workspacePayload(), ...(activeTemplateId ? { id: activeTemplateId } : {}), name: templateName.input.value.trim(), subject: subject.input.value.trim(), html: code.value, model: model.value });
      activeTemplateId = result.template?.id || activeTemplateId; await loadTemplates(activeTemplateId); status.textContent = `Template “${templateName.input.value.trim()}” saved. You can load it again from Saved HTML templates.`;
    } catch (error) { status.textContent = error.message || 'The HTML template could not be saved.'; }
    finally { setBusy(saveTemplate, false); }
  };
  send.onclick = async () => {
    if (!subject.input.value.trim() || !code.value.trim() || !recipientList(to.input.value).length) return showCrmNotice('Gmail composer', 'Add at least one recipient, a subject, and HTML before sending.');
    if (!window.confirm(`Send this email to ${recipientList(to.input.value).length} primary recipient${recipientList(to.input.value).length === 1 ? '' : 's'} through Gmail?`)) return;
    setBusy(send, true); status.textContent = 'Sending email through Gmail…';
    try { const result = await callGmail({ action: 'gmailSend', ...workspacePayload(), to: recipientList(to.input.value), cc: recipientList(cc.input.value), bcc: recipientList(bcc.input.value), subject: subject.input.value.trim(), html: code.value }); status.textContent = `Email sent through Gmail. Message ID: ${result.id || 'confirmed'}.`; }
    catch (error) { status.textContent = error.message || 'Gmail could not send this email.'; }
    finally { setBusy(send, false); }
  };
  box.append(title, form, editorRow, actions); wrap.append(box); document.body.append(wrap); void loadTemplates(); return wrap;
};
function openCrmEditor(collection, id = null, seed = {}) {
  const label = crmKindLabels[collection] || 'CRM record';
  return modal(id ? `Edit ${label}` : `Add ${label}`, crmFields(collection, seed), data => callBusiness({ action: 'saveEntity', ...workspacePayload(), collection, ...(id ? { id } : {}), data }));
}
async function runCrmAssist(task) {
  const button = document.querySelector(`[data-crm-ai="${task}"]`); if (button) button.disabled = true;
  const project = (rows, fields) => rows.slice(0, 4).map(row => Object.fromEntries(fields.map(field => [field, String(row[field] ?? '').slice(0, 80)])));
  const context = JSON.stringify({
    companies: project(crmState.companies, ['name', 'industry', 'owner', 'status']),
    contacts: project(crmState.contacts, ['firstName', 'lastName', 'companyId', 'role', 'email']),
    opportunities: project(crmState.opportunities, ['name', 'companyId', 'stage', 'amount', 'nextStep', 'owner']),
    activities: project(crmState.activities, ['type', 'subject', 'companyId', 'opportunityId', 'dueDate', 'status']),
    contracts: project(crmState.contracts, ['name', 'companyId', 'contactId', 'status', 'startDate', 'endDate', 'renewalDate', 'customerVisible']),
    services: project(crmState.services, ['name', 'companyId', 'contactId', 'status', 'plan', 'renewalDate', 'customerVisible'])
  });
  try {
    const result = await callBusiness({ action: 'crmAssist', ...workspacePayload(), task, context, agentId: $('crmAgentSelect')?.value || 'data-analyzer' });
    showCrmNotice(`Automa CRM Copilot · ${modelLabel(result.model)}`, result.reply || 'No insight was returned.');
  } catch (error) { showCrmNotice('CRM Copilot', error.message || 'The CRM assistant could not complete the request.'); }
  finally { if (button) button.disabled = false; }
}
function updateWorkspaceUi() {
  workspace.color = normalizedWorkspaceColor(workspace.color);
  const name = $('workspaceName'); if (name) name.textContent = workspace.name || 'Personal workspace';
  const role = $('workspaceRole'); if (role) role.textContent = (workspace.role || 'owner').replace(/^./, letter => letter.toUpperCase());
  const switcher = $('workspaceBtn');
  if (switcher) {
    switcher.style.setProperty('--workspace-color', workspace.color);
    switcher.style.borderColor = hexToRgba(workspace.color, 0.55);
  }
  updateDemoControls();
}
function updateDemoControls() {
  const canWrite = Boolean(currentUser) && workspace.role !== 'viewer';
  document.querySelectorAll('[data-demo-create],[data-demo-clear]').forEach(button => {
    button.disabled = !canWrite;
    if (!canWrite && workspace.role === 'viewer') button.title = 'Viewer members have read-only access.';
  });
  document.querySelectorAll('[data-global-reset]').forEach(button => {
    button.disabled = !currentUser || workspace.role !== 'owner';
    if (button.disabled) button.title = 'Only the Automa owner can reset every profile.';
  });
}
async function runDemoAction(action) {
  if (!currentUser) return showCrmNotice('Demo data', 'Sign in before using the demo controls.');
  if (workspace.role === 'viewer') return showCrmNotice('Demo data', 'Viewer members have read-only access. Ask an Owner or Admin to manage demo data.');
  if (action === 'clearWorkspace' && !window.confirm(`Delete all Automa business data from ${workspace.name}? This removes CRM, agents, automations, integrations, leads, tasks and settings, but keeps authentication and organization membership.`)) return;
  const button = document.querySelector(action === 'seedDemo' ? '[data-demo-create]' : '[data-demo-clear]');
  if (button) button.disabled = true;
  try {
    const result = await callBusiness({ action, ...workspacePayload() });
    const message = action === 'seedDemo'
      ? `${result.count || 0} sample records were added to ${workspace.name}. Open CRM, AI Agents and Automations to explore them.`
      : `${result.count || 0} business records were removed from ${workspace.name}. Authentication and organization membership were preserved.`;
    showCrmNotice(action === 'seedDemo' ? 'Demo created' : 'Workspace reset', message);
  } catch (error) { showCrmNotice('Demo data', error.message || 'The demo action could not be completed.'); }
  finally { updateDemoControls(); }
}
window.createDemoData = () => runDemoAction('seedDemo');
window.clearDemoData = () => runDemoAction('clearWorkspace');
window.openGlobalReset = function openGlobalReset() {
  if (!currentUser) return showCrmNotice('Global reset', 'Sign in before using the global reset.');
  return modal('Borrar todos los perfiles', [
    { type: 'note', value: 'This permanently removes business data from every Automa user profile and organization: CRM, agents, automations, integrations, leads, tasks, history and settings. Firebase Authentication accounts and organization memberships are preserved. This action cannot be undone.' },
    { key: 'confirmation', label: 'Type DELETE_ALL_AUTOMA_DATA to confirm', placeholder: 'DELETE_ALL_AUTOMA_DATA' }
  ], async data => {
    const result = await callBusiness({ action: 'clearAllProfiles', confirmation: data.confirmation });
    showCrmNotice('Global reset complete', `${result.count || 0} records were removed from ${result.profiles || 0} profiles and organizations. Authentication accounts and memberships were preserved.`);
    await loadWorkspaces(currentUser, workspace.id);
  });
};
function stopSubscriptions() {
  stops.forEach(stop => stop());
  stops = [];
}
window.openOrganizationEditor = function openOrganizationEditor() {
  return modal('Create organization', [
    { type: 'note', value: 'Create a separate workspace for a company or business unit. Members, CRM records, agents and automations stay isolated from your personal workspace and other organizations.' },
    { key: 'name', label: 'Organization name', placeholder: 'Acme Operations' },
    { key: 'color', label: 'Workspace color', type: 'color', value: DEFAULT_WORKSPACE_COLOR, help: 'This color appears in the dashboard workspace switcher.' }
  ], async data => {
    const result = await callBusiness({ action: 'organizationCreate', name: data.name, color: data.color });
    await loadWorkspaces(currentUser, result.organization?.id);
  });
};
window.openOrganizationInvite = function openOrganizationInvite() {
  if (!workspace.id || !['owner', 'admin'].includes(workspace.role)) return showCrmNotice('Organization access', 'Create or select an organization where you are an Owner or Admin before inviting members.');
  return modal(`Invite to ${workspace.name}`, [
    { type: 'note', value: 'Existing Firebase users are added immediately. New email addresses receive a pending invitation record and can join after signing in with that email.' },
    { key: 'email', label: 'Member email', type: 'email', placeholder: 'teammate@company.com' },
    { key: 'role', label: 'Role', type: 'select', value: 'member', options: [{ value: 'admin', label: 'Admin — manage members and workspace' }, { value: 'member', label: 'Member — edit business records' }, { value: 'viewer', label: 'Viewer — read-only access' }] }
  ], async data => {
    await callBusiness({ action: 'organizationInvite', orgId: workspace.id, email: data.email, role: data.role });
    await loadWorkspaces(currentUser, workspace.id);
  });
};
window.openWorkspaceManager = function openWorkspaceManager() {
  if (!currentUser) return;
  const { wrap, box, close: closeModal } = createModalShell('min(560px,100%)');
  const render = () => {
    box.replaceChildren();
    const head = document.createElement('div'); head.className = 'automa-modal-head';
    const title = document.createElement('h4'); title.textContent = 'Workspaces';
    const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.className = 'automa-modal-close'; closeButton.innerHTML = '&times;'; closeButton.setAttribute('aria-label', 'Close'); closeButton.title = 'Close'; closeButton.onclick = closeModal;
    head.append(title, closeButton);
    const intro = document.createElement('p'); intro.style.cssText = 'font-size:.8rem;color:var(--tx3);margin-bottom:18px'; intro.textContent = 'Switch between your personal workspace and organizations shared with your team.';
    box.append(head, intro);
    const list = document.createElement('div'); list.className = 'd-grid gap-2';
    workspaceOptions.forEach(option => {
      const row = document.createElement('div'); row.className = 'workspace-option';
      const color = normalizedWorkspaceColor(option.color);
      const info = document.createElement('div'); info.className = 'workspace-option-info';
      const swatch = document.createElement('span'); swatch.className = 'workspace-color-swatch'; swatch.style.background = color;
      const detail = document.createElement('div'); detail.style.minWidth = '0';
      const name = document.createElement('strong'); name.textContent = option.name;
      const meta = document.createElement('small'); const roleLabel = (option.role || 'owner').replace(/^./, letter => letter.toUpperCase()); meta.textContent = `${roleLabel} · ${option.members?.length || 1} member${option.members?.length === 1 ? '' : 's'}`;
      detail.append(name, meta); info.append(swatch, detail);
      const select = document.createElement('button'); select.className = option.id === workspace.id ? 'bgrd btn py-1 px-2' : 'boc btn py-1 px-2'; select.style.fontSize = '.72rem'; select.textContent = option.id === workspace.id ? 'Current' : 'Open'; select.disabled = option.id === workspace.id; select.addEventListener('click', async () => { workspace = { ...option, color }; updateWorkspaceUi(); resetCrmState(); stopSubscriptions(); subscribe(currentUser); closeModal(); }); row.append(info, select); list.append(row);
    });
    box.append(list);
    const selected = document.createElement('div'); selected.className = 'workspace-selected mt-3'; selected.style.borderColor = hexToRgba(workspace.color, 0.65); selected.style.background = `linear-gradient(135deg, ${hexToRgba(workspace.color, 0.18)}, rgba(139, 92, 246, 0.06))`; selected.innerHTML = `<strong>${escapeHtml(workspace.name)}</strong><span>${escapeHtml(workspace.members?.length ? `${workspace.members.length} member${workspace.members.length === 1 ? '' : 's'} · ${workspace.pendingInvites?.length || 0} pending invitations` : 'Personal workspace data')}</span>`; box.append(selected);
    if (workspace.id && workspace.members?.length) {
      const members = document.createElement('div'); members.className = 'workspace-members mt-3';
      workspace.members.slice(0, 20).forEach(member => {
        const row = document.createElement('div'); row.className = 'workspace-member';
        const identity = document.createElement('span'); identity.textContent = member.displayName || member.email || member.id;
        const details = document.createElement('small'); details.textContent = `${member.email || ''}${member.email && member.role ? ' · ' : ''}${member.role || 'member'}`;
        row.append(identity, details); members.append(row);
      });
      box.append(members);
    }
    const actions = document.createElement('div'); actions.className = 'd-flex gap-2 justify-content-end mt-4 flex-wrap';
    const invite = document.createElement('button'); invite.className = 'boc btn'; invite.textContent = 'Invite member'; invite.disabled = !workspace.id || !['owner', 'admin'].includes(workspace.role); invite.addEventListener('click', () => { closeModal(); window.openOrganizationInvite(); });
    const create = document.createElement('button'); create.className = 'bgrd btn'; create.textContent = 'Create organization'; create.addEventListener('click', () => { closeModal(); window.openOrganizationEditor(); });
    const globalReset = document.createElement('button'); globalReset.className = 'boc btn'; globalReset.style.color = '#f87171'; globalReset.textContent = 'Borrar todos los perfiles'; globalReset.disabled = workspace.role !== 'owner'; globalReset.addEventListener('click', () => { closeModal(); window.openGlobalReset(); });
    const close = document.createElement('button'); close.className = 'boc btn'; close.textContent = 'Close'; close.addEventListener('click', closeModal); actions.append(invite, create, globalReset, close); box.append(actions);
  };
  render(); wrap.append(box); document.body.append(wrap);
};
async function loadWorkspaces(user, requestedId = null) {
  if (!user) return;
  try { await callBusiness({ action: 'organizationAccept' }); } catch (error) { console.warn('Organization invitations unavailable', error.message); }
  let organizations = [];
  try { const result = await callBusiness({ action: 'organizationList' }); organizations = result.organizations || []; } catch (error) { console.warn('Organizations unavailable', error.message); }
  workspaceOptions = [{ id: null, name: 'Personal workspace', color: DEFAULT_WORKSPACE_COLOR, role: 'owner', members: [], pendingInvites: [] }, ...organizations.map(option => ({ ...option, color: normalizedWorkspaceColor(option.color) }))];
  workspace = workspaceOptions.find(option => option.id === requestedId) || workspaceOptions.find(option => option.id === workspace.id) || workspaceOptions[0];
  updateWorkspaceUi(); resetCrmState(); stopSubscriptions(); subscribe(user); await loadGmailStatus();
  const gmailResult = new URLSearchParams(window.location.search).get('gmail');
  if (gmailResult) {
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    showCrmNotice('Gmail', gmailResult === 'connected' ? 'Gmail is connected. You can now generate, preview, edit, and send HTML email.' : 'Gmail could not complete the connection. Review the Google OAuth settings in Vercel and try again.');
  }
}
function wireWorkspace() {
  if (workspaceWired) return; workspaceWired = true;
  const section = id => document.querySelector(`#sec-${id}`);
  const add = (id, label, fields, collection) => { const btn = [...(section(id)?.querySelectorAll('button') || [])].find(b => b.textContent.includes(label)); btn?.addEventListener('click', () => modal(label, fields, data => callBusiness({ action: 'saveEntity', ...workspacePayload(), collection, data }))); };
  const deploy = [...(section('agents')?.querySelectorAll('button') || [])].find(b => b.textContent.includes('Deploy New Agent')); deploy?.addEventListener('click', () => openAgentEditor());
  add('automations', 'Create Automation', [{ key: 'name', label: 'Automation name', placeholder: 'Lead follow-up' }, { key: 'trigger', label: 'Trigger', placeholder: 'New lead' }], 'automations');
  document.querySelectorAll('[data-use-blueprint]').forEach(button => button.addEventListener('click', () => window.openAutomationBlueprint(button.dataset.useBlueprint)));
  document.querySelectorAll('[data-crm-action]').forEach(button => button.addEventListener('click', () => openCrmEditor({ company: 'companies', contact: 'contacts', opportunity: 'opportunities', activity: 'activities', contract: 'contracts', service: 'services' }[button.dataset.crmAction])));
  document.querySelectorAll('[data-crm-ai]').forEach(button => button.addEventListener('click', () => runCrmAssist(button.dataset.crmAi)));
  $('crmSearch')?.addEventListener('input', renderCrm);
  $('crmStageFilter')?.addEventListener('change', renderCrm);
  add('integrations', 'Add Integration', [{ key: 'provider', label: 'Provider', placeholder: 'Google Workspace, Discord, GitHub...' }, { key: 'status', label: 'Status', placeholder: 'Available' }, { key: 'scope', label: 'Approved scope', placeholder: 'What this connection can read or update' }], 'integrations');
  const save = [...(section('settings')?.querySelectorAll('button') || [])].find(b => b.textContent.includes('Save Changes')); save?.addEventListener('click', async () => { try { await callBusiness({ action: 'saveProfile', name: $('profileName')?.value.trim() || 'Automa user' }); save.textContent = 'Saved'; setTimeout(() => save.textContent = 'Save Changes', 1500); } catch (e) { showCrmNotice('Settings', e.message || 'The settings could not be saved.'); } });
  section('agents')?.querySelectorAll('.agent-card').forEach(card => {
    const id = card.dataset.agentId; const seed = getDefaultAgent(id) || {};
    card.querySelectorAll('button').forEach(btn => { if (btn.textContent.includes('Configure')) btn.addEventListener('click', () => openAgentEditor(seed, id)); if (btn.textContent.includes('View')) btn.addEventListener('click', () => openAgentTest(seed, id)); });
  });
  document.querySelectorAll('#sec-integrations button').forEach(btn => {
    if (!btn.textContent.includes('Configure')) return;
    const card = btn.closest('[data-integration-id]');
    if (card?.dataset.integrationId === 'telegram') {
      btn.addEventListener('click', () => modal('Configure Telegram', telegramFields(telegramIntegration), async data => {
        const saved = { ...data, provider: 'Telegram' };
        await callBusiness({ action: 'saveEntity', ...workspacePayload(), collection: 'integrations', id: 'telegram', data: saved });
        telegramIntegration = { ...telegramIntegration, ...saved };
        card.dataset.integrationStatus = saved.status || 'Needs setup';
        card.querySelector('[data-telegram-status-label]')?.replaceChildren(document.createTextNode(saved.status || 'Needs setup'));
        showCrmNotice('Telegram configuration saved', `Saved the bot, business profile, OpenAI agent, connection status and webhook URL for ${workspace.name}. Use Register webhook to apply this URL in Telegram.`);
      }));
      return;
    }
    const integrationId = card?.dataset.integrationId || '';
    const catalog = INTEGRATION_CATALOG[integrationId] || { label: card?.querySelector('.fw-semibold')?.textContent?.trim() || 'Integration', scope: '' };
    btn.addEventListener('click', () => modal(`Configure ${catalog.label}`, [{ key: 'provider', label: 'Provider', value: catalog.label, readonly: true }, { key: 'status', label: 'Connection status', type: 'select', value: card?.dataset.integrationStatus || 'Available', options: [{ value: 'Available', label: 'Available' }, { value: 'Connected', label: 'Connected' }, { value: 'Paused', label: 'Paused' }] }, { key: 'scope', label: 'Approved scope', value: catalog.scope, placeholder: catalog.scope }, { key: 'notes', label: 'Notes', placeholder: 'How this connection should be used in a workflow' }], data => callBusiness({ action: 'saveEntity', ...workspacePayload(), collection: 'integrations', id: integrationId || undefined, data })));
  });
  const telegramStatusButton = section('integrations')?.querySelector('[data-telegram-status]');
  telegramStatusButton?.addEventListener('click', async () => {
    telegramStatusButton.disabled = true;
    try {
      const result = await callBusiness({ action: 'telegramStatus', ...workspacePayload() });
      const variableState = Object.entries(result.variables || {}).map(([name, present]) => `${name}: ${present ? 'set' : 'missing'}`).join('\n');
      const lastErrorDate = result.webhook?.lastErrorDate ? new Date(result.webhook.lastErrorDate).toLocaleString() : '';
      const webhookState = result.webhook ? `\nWebhook URL: ${result.webhook.urlConfigured ? (result.webhook.urlMatches ? 'correct' : 'different URL') : 'not registered'}\nTarget URL: ${result.webhook.expectedUrl || 'not configured'}\nPending updates: ${result.webhook.pendingUpdates}${result.webhook.lastError ? `\nLast recorded Telegram error${lastErrorDate ? ` (${lastErrorDate})` : ''}: ${result.webhook.lastError}` : ''}` : '';
      showCrmNotice(`${result.bot?.name || 'Telegram'}${result.bot?.username ? ` (@${result.bot.username})` : ''}`, `${result.error || result.code}${result.ownerUidMatches === false ? '\nTELEGRAM_OWNER_UID does not match the signed-in user.' : ''}${webhookState}\n\n${variableState}`);
    } catch (error) { showCrmNotice('Telegram status', error.message || 'Telegram status could not be checked.'); }
    finally { telegramStatusButton.disabled = false; }
  });
  const telegramRegisterButton = section('integrations')?.querySelector('[data-telegram-register]');
  telegramRegisterButton?.addEventListener('click', async () => {
    if (!window.confirm('Register the Vercel webhook with Telegram now?')) return;
    telegramRegisterButton.disabled = true;
    try {
      const result = await callBusiness({ action: 'telegramRegister', ...workspacePayload() });
      if (result.ok) {
        telegramIntegration = { ...telegramIntegration, status: result.status || 'Active', webhookUrl: result.webhookUrl || telegramIntegration.webhookUrl };
        const card = telegramRegisterButton.closest('[data-integration-id]');
        if (card) card.dataset.integrationStatus = telegramIntegration.status;
        section('integrations')?.querySelector('[data-telegram-status-label]')?.replaceChildren(document.createTextNode(telegramIntegration.status));
      }
      showCrmNotice('Telegram webhook', result.ok ? `Webhook registered at ${result.webhookUrl}. Open @WSTUDIO3DBot and press START BOT.` : `Telegram setup failed: ${result.code}`);
    } catch (error) { showCrmNotice('Telegram webhook', error.message || 'Telegram could not register the webhook.'); }
    finally { telegramRegisterButton.disabled = false; }
  });
  const telegramPairButton = section('integrations')?.querySelector('[data-telegram-pair]');
  telegramPairButton?.addEventListener('click', () => window.openTelegramPairing());
  const telegramIntakeButton = section('integrations')?.querySelector('[data-telegram-intake]');
  telegramIntakeButton?.addEventListener('click', () => window.openTelegramIntake());
  const gmailConnectButton = section('integrations')?.querySelector('[data-gmail-connect]');
  gmailConnectButton?.addEventListener('click', async () => {
    gmailConnectButton.disabled = true;
    try { const result = await callGmail({ action: 'gmailConnect', ...workspacePayload() }); window.location.assign(result.authorizeUrl); }
    catch (error) { showCrmNotice('Connect Gmail', error.message || 'Gmail could not start the secure connection.'); gmailConnectButton.disabled = false; }
  });
  const gmailStatusButton = section('integrations')?.querySelector('[data-gmail-status]');
  gmailStatusButton?.addEventListener('click', async () => { gmailStatusButton.disabled = true; await loadGmailStatus(); gmailStatusButton.disabled = false; });
  const gmailDisconnectButton = section('integrations')?.querySelector('[data-gmail-disconnect]');
  gmailDisconnectButton?.addEventListener('click', async () => {
    if (!window.confirm('Disconnect Gmail from this workspace? Automa will delete its stored Gmail authorization.')) return;
    gmailDisconnectButton.disabled = true;
    try { await callGmail({ action: 'gmailDisconnect', ...workspacePayload() }); updateGmailUi({ status: 'Disconnected' }); showCrmNotice('Gmail', 'Gmail was disconnected from this workspace.'); }
    catch (error) { showCrmNotice('Gmail', error.message || 'Gmail could not be disconnected.'); }
    finally { await loadGmailStatus(); }
  });
  const gmailComposeButton = section('integrations')?.querySelector('[data-gmail-compose]');
  gmailComposeButton?.addEventListener('click', () => window.openGmailComposer());
  const gmailReviewButton = section('integrations')?.querySelector('[data-gmail-review]');
  gmailReviewButton?.addEventListener('click', () => window.openGmailInboxReview());
}
function subscribe(user) {
  const run = ++generation;
  resetStats();
  const watch = (name, callback) => {
    const source = workspace.id ? collection(db, 'organizations', workspace.id, name) : collection(db, 'users', user.uid, name);
    // Older integration documents may predate createdAt. Keep them visible
    // after a reload while newer records continue to use the ordered query.
    const sourceQuery = name === 'integrations' ? query(source, limit(100)) : query(source, orderBy('createdAt', 'desc'), limit(100));
    const stop = onSnapshot(sourceQuery, snap => { if (generation !== run) return; const rows = snap.docs.map(doc => ({ id: doc.id, ...doc.data() })); updateStats(name, rows); callback(rows); }, error => { if (generation === run) console.warn(`${name} unavailable`, error.code); });
    stops.push(stop);
  };
  watch('leads', rows => renderActivity(rows)); watch('tasks', rows => renderActivity(rows)); watch('runs', rows => renderActivity(rows));
  watch('agents', rows => renderEntities('agents', rows)); watch('automations', rows => renderEntities('automations', rows)); watch('integrations', rows => renderEntities('integrations', rows));
  watch('companies', rows => { crmState.companies = rows; renderCrm(); }); watch('contacts', rows => { crmState.contacts = rows; renderCrm(); }); watch('opportunities', rows => { crmState.opportunities = rows; renderCrm(); }); watch('activities', rows => { crmState.activities = rows; renderCrm(); }); watch('contracts', rows => { crmState.contracts = rows; renderCrm(); }); watch('services', rows => { crmState.services = rows; renderCrm(); });
  wireWorkspace();
}

if (Object.values(config).every(Boolean)) {
  const app = initializeApp(config); auth = getAuth(app); db = getFirestore(app);
  onAuthStateChanged(auth, user => { stopSubscriptions(); telegramIntegration = {}; gmailIntegration = {}; resetCrmState(); currentUser = user; if (user) { window.loginSuccess?.(userShape(user)); loadWorkspaces(user); } else { generation++; workspace = { id: null, name: 'Personal workspace', color: DEFAULT_WORKSPACE_COLOR, role: 'owner', members: [], pendingInvites: [] }; workspaceOptions = [workspace]; updateWorkspaceUi(); updateGmailUi({ status: 'Needs setup' }); document.querySelector('#dashboard')?.style.setProperty('display', 'none'); document.querySelector('#landing')?.style.setProperty('display', 'block'); } });
  const forgot = document.querySelector('#fLogin a[href="#"]');
  forgot?.addEventListener('click', async event => { event.preventDefault(); const email = $('loginEmail')?.value.trim(); if (!email) return showError('login', 'Enter your email first.'); try { await sendPasswordResetEmail(auth, email); showError('login', 'If that account exists, a reset email has been sent.'); } catch (error) { showError('login', errorMessage(error)); } });
} else {
  document.querySelectorAll('#loginBtn,#signupBtn').forEach(button => { button.disabled = true; });
  showError('login', 'Firebase is not configured. Add the VITE_FIREBASE_* variables in Vercel.');
}
