import { InputError, parseCommand, planFollowUp } from '../server/domain.js';

async function services() {
  const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey } = process.env;
  if (!projectId || !clientEmail || !privateKey) throw new Error('SERVER_NOT_CONFIGURED');
  const { cert, getApps, initializeApp } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
  const app = getApps()[0] || initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) });
  return { auth: getAuth(app), db: getFirestore(app), FieldValue };
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Usa POST.' }); }
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  try {
    if (JSON.stringify(req.body ?? '').length > 12000) return res.status(413).json({ error: 'Solicitud demasiado grande.' });
    const cmd = parseCommand(req.body);
    const { auth, db, FieldValue } = await services();
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
