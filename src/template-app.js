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
function subscribe(user) {
  const run = ++generation;
  resetStats();
  const watch = (name, callback) => { const stop = onSnapshot(query(collection(db, 'users', user.uid, name), orderBy('createdAt', 'desc'), limit(100)), snap => { if (generation !== run) return; const rows = snap.docs.map(doc => ({ id: doc.id, ...doc.data() })); updateStats(name, rows); callback(rows); }, error => { if (generation === run) console.warn(`${name} unavailable`, error.code); }); stops.push(stop); };
  watch('leads', rows => renderActivity(rows)); watch('tasks', rows => renderActivity(rows)); watch('runs', rows => renderActivity(rows));
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
