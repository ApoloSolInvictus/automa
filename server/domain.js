export class InputError extends Error {}
function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new InputError(`${label}: valor inválido.`);
  return value.trim();
}
export function parseCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Solicitud inválida.');
  if (body.action === 'createLead') {
    const name = text(body.name, 'Nombre', 120);
    const email = text(body.email, 'Correo', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError('Correo inválido.');
    if (typeof body.value !== 'number' || !Number.isFinite(body.value) || body.value < 0 || body.value > 100000000) throw new InputError('Valor inválido.');
    if (typeof body.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.requestId)) throw new InputError('Identificador inválido.');
    return { action: body.action, name, email, value: Math.round(body.value * 100) / 100, requestId: body.requestId };
  }
  if (body.action === 'updateTask') {
    if (typeof body.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(body.id) || !['pending', 'done'].includes(body.status)) throw new InputError('Tarea inválida.');
    return { action: body.action, id: body.id, status: body.status };
  }
  if (body.action === 'saveSettings') {
    if (typeof body.enabled !== 'boolean' || !Number.isInteger(body.hours) || body.hours < 1 || body.hours > 720) throw new InputError('Configuración inválida.');
    return { action: body.action, enabled: body.enabled, hours: body.hours };
  }
  if (body.action === 'chat') {
    const message = text(body.message, 'Mensaje', 4000);
    if (!Array.isArray(body.history) || body.history.length > 20) throw new InputError('Historial inválido.');
    const history = body.history.map(item => {
      if (!item || !['user', 'assistant'].includes(item.role)) throw new InputError('Historial inválido.');
      return { role: item.role, content: text(item.content, 'Mensaje', 4000) };
    });
    return { action: body.action, message, history };
  }
  if (body.action === 'saveEntity') {
    const collection = text(body.collection, 'Colección', 40);
    if (!['agents', 'automations', 'integrations'].includes(collection)) throw new InputError('Colección inválida.');
    const id = body.id == null ? null : text(body.id, 'Identificador', 80);
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new InputError('Datos inválidos.');
    const data = {};
    for (const [key, value] of Object.entries(body.data)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,30}$/.test(key) || typeof value !== 'string' || value.length > 500) throw new InputError('Datos inválidos.');
      data[key] = value.trim();
    }
    if (!Object.keys(data).length) throw new InputError('Datos inválidos.');
    return { action: body.action, collection, id, data };
  }
  if (body.action === 'saveProfile') {
    const name = text(body.name, 'Nombre', 120);
    return { action: body.action, name };
  }
  throw new InputError('Acción no admitida.');
}
export function planFollowUp(lead, settings, now) {
  if (!settings.enabled) return null;
  return { leadId: lead.requestId, title: `Contactar a ${lead.name}`, status: 'pending', dueAt: new Date(now.getTime() + settings.hours * 3600000) };
}
