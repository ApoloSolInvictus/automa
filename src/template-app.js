import { initializeApp } from 'firebase/app';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider,
  GithubAuthProvider, sendPasswordResetEmail, signOut
} from 'firebase/auth';
import { getFirestore, collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};
let auth, db, stops = [], chat = [], generation = 0;

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
  if (!message) return;
  input.value = ''; input.style.height = 'auto';
  window.appendMsg?.(message, 'user'); chat.push({ role: 'user', content: message });
  const typing = window.appendTyping?.();
  try {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error('AUTH');
    const response = await fetch('/api/business', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'chat', message, history: chat.slice(0, -1).slice(-19) }), signal: AbortSignal.timeout(35000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'OpenAI request failed.');
    const reply = data.reply || 'I could not generate a response.'; chat.push({ role: 'assistant', content: reply }); window.appendMsg?.(reply, 'ai');
  } catch (error) { window.appendMsg?.(error.message === 'OpenAI no está configurado en Vercel.' ? 'OpenAI is not configured in Vercel yet.' : 'I could not connect to the AI service. Check your Vercel environment variables.', 'ai'); }
  finally { if (typing) window.removeTyping?.(typing); }
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
async function callBusiness(body) {
  const token = await auth.currentUser?.getIdToken(); if (!token) throw new Error('AUTH');
  const response = await fetch('/api/business', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed.'); return data;
}
function modal(title, fields, onSave) {
  const wrap = document.createElement('div'); wrap.style.cssText = 'position:fixed;inset:0;background:#0009;z-index:3000;display:grid;place-items:center;padding:20px';
  const box = document.createElement('div'); box.style.cssText = 'background:var(--bg2);border:1px solid var(--bd);border-radius:16px;padding:24px;width:min(520px,100%)';
  box.innerHTML = `<h4 style="margin-bottom:18px">${title}</h4>` + fields.map(f => `<label class="olbl">${f.label}</label><input class="oinp mb-3" data-field="${f.key}" value="${(f.value || '').replace(/"/g,'&quot;')}" placeholder="${f.placeholder || ''}">`).join('') + '<div class="d-flex gap-2 justify-content-end"><button class="boc btn" data-cancel>Cancel</button><button class="bgrd btn" data-save>Save</button></div>';
  wrap.append(box); document.body.append(wrap); box.querySelector('[data-cancel]').onclick = () => wrap.remove(); box.querySelector('[data-save]').onclick = async () => { const data = {}; box.querySelectorAll('[data-field]').forEach(i => data[i.dataset.field] = i.value.trim()); try { await onSave(data); wrap.remove(); } catch (e) { alert(e.message); } }; return wrap;
}
function wireWorkspace() {
  const section = id => document.querySelector(`#sec-${id}`);
  const add = (id, label, fields, collection) => { const btn = [...(section(id)?.querySelectorAll('button') || [])].find(b => b.textContent.includes(label)); btn?.addEventListener('click', () => modal(label, fields, data => callBusiness({ action: 'saveEntity', collection, data }))); };
  add('agents', 'Deploy New Agent', [{ key: 'name', label: 'Agent name', placeholder: 'Support Agent' }, { key: 'description', label: 'Description', placeholder: 'What this agent handles' }], 'agents');
  add('automations', 'Create Automation', [{ key: 'name', label: 'Automation name', placeholder: 'Lead follow-up' }, { key: 'trigger', label: 'Trigger', placeholder: 'New lead' }], 'automations');
  add('integrations', 'Add Integration', [{ key: 'provider', label: 'Provider', placeholder: 'Slack, Notion, CRM...' }, { key: 'status', label: 'Status', placeholder: 'Connected' }], 'integrations');
  const save = [...(section('settings')?.querySelectorAll('button') || [])].find(b => b.textContent.includes('Save Changes')); save?.addEventListener('click', async () => { try { await callBusiness({ action: 'saveProfile', name: $('profileName')?.value.trim() || 'NexusAI user' }); save.textContent = 'Saved'; setTimeout(() => save.textContent = 'Save Changes', 1500); } catch (e) { alert(e.message); } });
  section('agents')?.querySelectorAll('button').forEach(btn => { if (btn.textContent.includes('Configure')) btn.addEventListener('click', () => modal('Configure Agent', [{ key: 'status', label: 'Status', value: 'Active' }, { key: 'instructions', label: 'Instructions', placeholder: 'Describe the agent behavior' }], data => callBusiness({ action: 'saveEntity', collection: 'agents', data }))); if (btn.textContent.includes('View')) btn.addEventListener('click', () => alert('Agent details are available after deployment.')); });
  document.querySelectorAll('#sec-integrations button').forEach(btn => { if (btn.textContent.includes('Configure')) btn.addEventListener('click', () => modal('Configure Integration', [{ key: 'status', label: 'Status', value: 'Connected' }, { key: 'notes', label: 'Notes' }], data => callBusiness({ action: 'saveEntity', collection: 'integrations', data }))); });
}
function subscribe(user) {
  const run = ++generation;
  resetStats();
  const watch = (name, callback) => { const stop = onSnapshot(query(collection(db, 'users', user.uid, name), orderBy('createdAt', 'desc'), limit(100)), snap => { if (generation !== run) return; const rows = snap.docs.map(doc => ({ id: doc.id, ...doc.data() })); updateStats(name, rows); callback(rows); }, error => { if (generation === run) console.warn(`${name} unavailable`, error.code); }); stops.push(stop); };
  watch('leads', rows => renderActivity(rows)); watch('tasks', rows => renderActivity(rows)); watch('runs', rows => renderActivity(rows));
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
