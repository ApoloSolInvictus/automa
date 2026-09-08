import { InputError, parseCommand, planFollowUp } from '../server/domain.js';
import { handleChatCommand, requestOpenAI } from './chat.js';
import { DEFAULT_OPENAI_MODEL, isAllowedOpenAIModel } from '../shared/models.js';
import { getDefaultAgent } from '../shared/agents.js';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

async function services() {
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
  if (!projectId || !clientEmail || !privateKey) throw new Error('SERVER_NOT_CONFIGURED');
  const clean = value => value.trim().replace(/^["']|["']$/g, '').replace(/\\+r?\\+n/g, '\n').replace(/\\+n/g, '\n').replace(/\\"/g, '"');
  const normalizedProjectId = clean(projectId);
  const normalizedClientEmail = clean(clientEmail);
  const normalizedPrivateKey = clean(privateKey).replace(/\r/g, '');
  let adminApp;
  try { adminApp = getApps()[0] || initializeApp({ credential: cert({ projectId: normalizedProjectId, clientEmail: normalizedClientEmail, privateKey: normalizedPrivateKey }) }); }
  catch (error) { throw Object.assign(new Error('FIREBASE_ADMIN_CREDENTIALS'), { code: 'firebase_admin_credentials', cause: error }); }
  return { auth: getAuth(adminApp), db: getFirestore(adminApp), FieldValue };
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Usa POST.' }); }
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  try {
    if (JSON.stringify(req.body ?? '').length > 12000) return res.status(413).json({ error: 'Solicitud demasiado grande.' });
    const cmd = parseCommand(req.body);
    if (cmd.action === 'chat') {
      const result = await handleChatCommand(token, cmd);
      return res.status(result.status).json(result.body);
    }
    let auth, db, FieldValue;
    try { ({ auth, db, FieldValue } = await services()); }
    catch (error) {
      console.error('Firebase Admin initialization failed', { code: error?.code || error?.message || 'firebase_admin_init_failed' });
      if (error?.message === 'SERVER_NOT_CONFIGURED') return res.status(503).json({ error: 'Firebase Admin is not configured in Vercel. Add FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.', code: 'firebase_server_not_configured' });
      if (error?.code === 'firebase_admin_credentials') return res.status(503).json({ error: 'Firebase Admin rejected the service account. Check FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.', code: 'firebase_admin_credentials' });
      if (error?.code === 'firebase_admin_sdk_load') {
        const reason = String(error?.cause?.code || error?.cause?.name || '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
        return res.status(503).json({ error: `Firebase Admin SDK could not load in the Vercel function${reason ? ` (${reason})` : ''}.`, code: 'firebase_admin_sdk_load' });
      }
      return res.status(503).json({ error: 'Firebase Admin could not initialize in Vercel. Check the service account variables and private key format.', code: 'firebase_admin_init_failed' });
    }
    let user;
    try { user = await auth.verifyIdToken(token, true); }
    catch { return res.status(401).json({ error: 'Sesión inválida. Vuelve a iniciar sesión.' }); }
    const root = db.collection('users').doc(user.uid);
    const now = new Date();
    const stamp = FieldValue.serverTimestamp();
    if (cmd.action === 'saveSettings') {
      await root.collection('settings').doc('followUp').set({ enabled: cmd.enabled, hours: cmd.hours, updatedAt: stamp });
      return res.status(200).json({ ok: true });
    }
    if (cmd.action === 'updateTask') {
      const ref = root.collection('tasks').doc(cmd.id);
      await db.runTransaction(async tx => {
        if (!(await tx.get(ref)).exists) throw new InputError('Tarea no encontrada.');
        tx.update(ref, { status: cmd.status, updatedAt: stamp });
      });
      return res.status(200).json({ ok: true });
    }
    if (cmd.action === 'saveEntity') {
      const ref = cmd.id ? root.collection(cmd.collection).doc(cmd.id) : root.collection(cmd.collection).doc();
      await ref.set({ ...cmd.data, updatedAt: stamp, ...(cmd.id ? {} : { createdAt: stamp }) }, { merge: true });
      return res.status(200).json({ ok: true, id: ref.id });
    }
    if (cmd.action === 'runAgent') {
      const ref = root.collection('agents').doc(cmd.agentId);
      const snapshot = await ref.get();
      const saved = snapshot.exists ? snapshot.data() : null;
      const agent = { ...(getDefaultAgent(cmd.agentId) || {}), ...(saved || {}) };
      if (!agent.name) return res.status(404).json({ error: 'Agent not found.', code: 'agent_not_found' });
      if (agent.status === 'paused') return res.status(409).json({ error: 'This agent is paused. Enable it before running a test.', code: 'agent_paused' });
      const model = agent.model || DEFAULT_OPENAI_MODEL;
      if (!isAllowedOpenAIModel(model)) return res.status(400).json({ error: 'This agent has an unsupported OpenAI model. Reconfigure it first.', code: 'agent_model_invalid' });
      const instructions = [
        `You are the ${agent.name} agent.`,
        agent.description ? `Business area: ${agent.description}.` : '',
        agent.instructions || '',
        'Only answer with information grounded in the user message and conversation. Do not claim to have run an automation or changed external data.'
      ].filter(Boolean).join(' ');
      const result = await requestOpenAI(cmd, { model, instructions });
      return res.status(result.status).json({ ...result.body, agentId: cmd.agentId, agent: agent.name });
    }
    if (cmd.action === 'saveProfile') {
      await root.collection('settings').doc('profile').set({ name: cmd.name, email: user.email || '', updatedAt: stamp }, { merge: true });
      return res.status(200).json({ ok: true });
    }
    const result = await db.runTransaction(async tx => {
      const leadRef = root.collection('leads').doc(cmd.requestId);
      const existing = await tx.get(leadRef);
      if (existing.exists) return { ok: true, id: cmd.requestId, duplicate: true };
      const config = await tx.get(root.collection('settings').doc('followUp'));
      const quotaRef = root.collection('internal').doc(now.toISOString().slice(0, 10));
      const quota = await tx.get(quotaRef);
      const count = quota.data()?.count || 0;
      if (count >= 200) throw new InputError('Límite diario de 200 prospectos alcanzado.');
      const task = planFollowUp(cmd, config.data() || { enabled: true, hours: 24 }, now);
      tx.create(leadRef, { name: cmd.name, email: cmd.email, value: cmd.value, createdAt: stamp });
      if (task) tx.create(root.collection('tasks').doc(cmd.requestId), { ...task, createdAt: stamp });
      tx.create(root.collection('runs').doc(cmd.requestId), { leadId: cmd.requestId, status: task ? 'completed' : 'skipped', message: task ? 'Tarea de seguimiento creada' : 'Seguimiento desactivado: prospecto guardado', createdAt: stamp });
      tx.set(quotaRef, { count: count + 1 });
      return { ok: true, id: cmd.requestId, taskCreated: !!task };
    });
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof InputError) return res.status(400).json({ error: error.message });
    console.error('business request failed', { code: error.code || 'internal' });
    return res.status(503).json({ error: 'Servicio no disponible. Revisa la configuración de Firebase del servidor.' });
  }
}
