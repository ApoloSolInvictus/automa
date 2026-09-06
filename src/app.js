import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail } from 'firebase/auth';
import { getFirestore, collection, doc, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
const $ = id => document.getElementById(id);
const config = { apiKey: import.meta.env.VITE_FIREBASE_API_KEY, authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN, projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID, appId: import.meta.env.VITE_FIREBASE_APP_ID };
let auth, db, subscriptions = [], generation = 0, requestId = null, requestPayload = null;
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
function friendly(error) {
  const messages = { 'auth/invalid-credential': 'Correo o contraseña incorrectos.', 'auth/email-already-in-use': 'Este correo ya tiene una cuenta.', 'auth/weak-password': 'Usa una contraseña más segura.', 'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.', 'auth/network-request-failed': 'No se pudo conectar. Revisa tu conexión.', 'auth/operation-not-allowed': 'Activa Correo/contraseña en Firebase Authentication.', 'permission-denied': 'No se pueden leer los datos. Revisa las reglas de Firestore.', 'auth/unauthorized-domain': 'Autoriza este dominio en Firebase Authentication.' };
  return messages[error.code] || 'No se pudo completar la operación. Revisa la conexión y la configuración de Firebase.';
}
async function busy(form, operation) { const buttons = [...form.querySelectorAll('button')]; buttons.forEach(b => b.disabled = true); try { await operation(); } catch (e) { notice(e.publicMessage || friendly(e)); } finally { buttons.forEach(b => b.disabled = false); } }
async function command(body) {
  if (!auth.currentUser) throw { publicMessage: 'Inicia sesión para continuar.' };
  const response = await fetch('/api/business', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await auth.currentUser.getIdToken()}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(35000) });
  let result;
  try { result = await response.json(); } catch { throw { publicMessage: 'La API no está disponible. En local usa vercel dev.' }; }
  if (!response.ok) throw { publicMessage: result.error || 'No se pudo guardar.' };
  return result;
}
function record(title, detail, button) { const row = document.createElement('div'); row.className = 'record'; const content = document.createElement('div'); const strong = document.createElement('strong'); strong.textContent = title; const small = document.createElement('small'); small.textContent = detail; content.append(strong, small); row.append(content); if (button) row.append(button); return row; }
function list(id, rows, empty) { $(id).replaceChildren(...rows); if (!rows.length) $(id).append(record(empty, 'Los nuevos registros aparecerán aquí.')); }
function date(value) { return value?.toDate ? value.toDate().toLocaleString('es-CR') : 'Guardando…'; }
const money = value => new Intl.NumberFormat('es-CR', { style: 'currency', currency: 'USD' }).format(value);
function clearWorkspace() { subscriptions.forEach(stop => stop()); subscriptions = []; generation++; requestId = null; requestPayload = null; $('leadForm').reset(); $('settingsForm').reset(); ['leads', 'tasks', 'runs'].forEach(id => $(id).replaceChildren()); ['leadCount', 'taskCount', 'pipeline', 'runCount'].forEach(id => $(id).textContent = '—'); }
function subscribe(user) {
  const current = generation;
  const watch = (name, render) => { subscriptions.push(onSnapshot(query(collection(db, 'users', user.uid, name), orderBy('createdAt', 'desc'), limit(100)), snapshot => { if (generation === current) render(snapshot.docs.map(d => ({ id: d.id, ...d.data() }))); }, error => { if (generation === current) { $(name).replaceChildren(record('Datos no disponibles', friendly(error))); notice(friendly(error)); } })); };
  watch('leads', rows => { $('leadCount').textContent = rows.length; $('pipeline').textContent = money(rows.reduce((sum, row) => sum + row.value, 0)); list('leads', rows.map(row => record(row.name, `${row.email} · ${money(row.value)} · ${date(row.createdAt)}`)), 'Todavía no hay prospectos'); });
  watch('tasks', rows => { $('taskCount').textContent = rows.filter(row => row.status === 'pending').length; list('tasks', rows.map(row => { const button = document.createElement('button'); button.className = 'secondary'; button.textContent = row.status === 'done' ? 'Reabrir' : 'Completar'; button.onclick = () => busy(button.parentElement, async () => { await command({ action: 'updateTask', id: row.id, status: row.status === 'done' ? 'pending' : 'done' }); if (generation === current) notice('Tarea actualizada.'); }); return record(row.title, `${row.status === 'done' ? 'Completada' : 'Pendiente'} · Vence: ${date(row.dueAt)}`, button); }), 'No hay tareas de seguimiento'); });
  watch('runs', rows => { $('runCount').textContent = rows.filter(row => row.status === 'completed').length; list('runs', rows.map(row => record(row.message, date(row.createdAt))), 'Aún no hay ejecuciones'); });
  subscriptions.push(onSnapshot(doc(db, 'users', user.uid, 'settings', 'followUp'), snapshot => { if (generation !== current) return; const data = snapshot.data() || { enabled: true, hours: 24 }; $('enabled').checked = data.enabled; $('hours').value = data.hours; }, error => { if (generation === current) notice(friendly(error)); }));
}
if (!Object.values(config).every(Boolean)) {
  $('configNote').textContent = 'Firebase pendiente de configuración. Consulta README.md para conectar tu proyecto. No se simulan sesiones ni datos.';
  $('authForm').querySelectorAll('button').forEach(button => button.disabled = true);
} else {
  try { const app = initializeApp(config); auth = getAuth(app); db = getFirestore(app); $('configNote').textContent = 'Acceso protegido por Firebase Authentication.';
    onAuthStateChanged(auth, user => { clearWorkspace(); notice(''); $('welcome').hidden = !!user; $('workspace').hidden = !user; $('password').value = ''; if (user) { $('identity').textContent = user.email; subscribe(user); } });
  } catch (error) { $('configNote').textContent = friendly(error); $('authForm').querySelectorAll('button').forEach(button => button.disabled = true); }
}
$('authForm').onsubmit = event => { event.preventDefault(); if (auth) busy($('authForm'), () => signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value)); };
$('signup').onclick = () => { if ($('authForm').reportValidity()) busy($('authForm'), () => createUserWithEmailAndPassword(auth, $('email').value.trim(), $('password').value)); };
$('reset').onclick = () => { if (!$('email').reportValidity()) return; busy($('authForm'), async () => { await sendPasswordResetEmail(auth, $('email').value.trim()); notice('Si la cuenta existe, recibirás un enlace para restablecer la contraseña.'); }); };
$('logout').onclick = () => busy($('logout').parentElement, () => signOut(auth));
$('leadForm').onsubmit = event => { event.preventDefault(); const current = generation; busy($('leadForm'), async () => { const form = new FormData($('leadForm')); const payload = { action: 'createLead', name: form.get('name'), email: form.get('email'), value: Number(form.get('value')) }; const serialized = JSON.stringify(payload); if (serialized !== requestPayload) { requestId = crypto.randomUUID(); requestPayload = serialized; } const result = await command({ ...payload, requestId }); if (generation !== current) return; requestId = requestPayload = null; $('leadForm').reset(); notice(result.duplicate ? 'Este prospecto ya se había guardado; no se duplicó.' : result.taskCreated ? 'Prospecto guardado y seguimiento creado.' : 'Prospecto guardado. El seguimiento automático está desactivado.'); }); };
$('settingsForm').onsubmit = event => { event.preventDefault(); const current = generation; busy($('settingsForm'), async () => { await command({ action: 'saveSettings', enabled: $('enabled').checked, hours: Number($('hours').value) }); if (generation === current) notice('Automatización guardada. Se aplicará a nuevos prospectos.'); }); };
