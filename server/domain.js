import { isAllowedOpenAIModel } from '../shared/models.js';

export class InputError extends Error {}
const CRM_COLLECTIONS = ['companies', 'contacts', 'opportunities', 'activities'];
const CRM_FIELDS = Object.freeze({
  companies: ['name', 'industry', 'website', 'size', 'owner', 'status', 'notes'],
  contacts: ['firstName', 'lastName', 'companyId', 'email', 'phone', 'role', 'status', 'notes'],
  opportunities: ['name', 'companyId', 'contactId', 'stage', 'amount', 'probability', 'nextStep', 'owner', 'expectedClose', 'notes'],
  activities: ['type', 'subject', 'companyId', 'contactId', 'opportunityId', 'dueDate', 'status', 'notes']
});
const CRM_ASSIST_TASKS = ['prioritize', 'summary', 'followup'];
const ORGANIZATION_ROLES = ['admin', 'member', 'viewer'];
const organizationId = value => {
  const id = text(value, 'Organización', 80);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new InputError('Organización inválida.');
  return id;
};
export function isAllowedTelegramWebhookUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    const isAutomaVercel = hostname === 'automa.vercel.app' || /^automa-[a-z0-9]+-ronny-woods-projects\.vercel\.app$/.test(hostname);
    return url.protocol === 'https:' && url.pathname === '/api/telegram' && !url.search && !url.hash && (hostname === 'automa.wstudio3d.com' || isAutomaVercel);
  } catch { return false; }
}
export function isAllowedTelegramWebhookSecret(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value.trim());
}
function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new InputError(`${label}: valor inválido.`);
  return value.trim();
}
function emailAddress(value, label) {
  const email = text(value, label, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError(`${label}: correo inválido.`);
  return email;
}
function emailAddresses(value, label, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 50) throw new InputError(`${label}: destinatarios inválidos.`);
  const emails = value.map(item => emailAddress(item, label));
  if (new Set(emails).size !== emails.length) throw new InputError(`${label}: no repitas destinatarios.`);
  return emails;
}
function emailHtml(value) {
  const html = text(value, 'HTML del correo', 60000);
  if (/<\/?(?:script|iframe|object|embed|form|base|meta|link)\b/i.test(html) || /\son[a-z]+\s*=/i.test(html) || /(?:javascript|data)\s*:/i.test(html)) throw new InputError('HTML del correo no permitido.');
  return html;
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
  if (body.action === 'crmAssist') {
    const task = text(body.task, 'Tarea CRM', 40);
    if (!CRM_ASSIST_TASKS.includes(task)) throw new InputError('Tarea CRM inválida.');
    const context = text(body.context, 'Contexto CRM', 7000);
    const agentId = body.agentId == null ? null : text(body.agentId, 'Agente', 80);
    if (agentId && !/^[a-zA-Z0-9_-]{1,80}$/.test(agentId)) throw new InputError('Agente inválido.');
    const orgId = body.orgId == null ? null : organizationId(body.orgId);
    return { action: body.action, task, context, agentId, orgId };
  }
  if (body.action === 'organizationList' || body.action === 'organizationAccept') return { action: body.action, ...(body.orgId == null ? {} : { orgId: organizationId(body.orgId) }) };
  if (body.action === 'organizationCreate') {
    const name = text(body.name, 'Nombre de organización', 120);
    return { action: body.action, name };
  }
  if (body.action === 'seedDemo' || body.action === 'clearDemo' || body.action === 'clearWorkspace') {
    const orgId = body.orgId == null ? null : organizationId(body.orgId);
    return { action: body.action, orgId };
  }
  if (body.action === 'clearAllProfiles') {
    if (body.confirmation !== 'DELETE_ALL_AUTOMA_DATA') throw new InputError('Escribe DELETE_ALL_AUTOMA_DATA para confirmar el restablecimiento global.');
    return { action: body.action, confirmation: body.confirmation };
  }
  if (body.action === 'gmailConnect' || body.action === 'gmailStatus' || body.action === 'gmailDisconnect') {
    return { action: body.action, orgId: body.orgId == null ? null : organizationId(body.orgId) };
  }
  if (body.action === 'gmailTemplateList') {
    return { action: body.action, orgId: body.orgId == null ? null : organizationId(body.orgId) };
  }
  if (body.action === 'gmailTemplateSave') {
    const id = body.id == null ? null : text(body.id, 'Identificador', 80);
    if (id && !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new InputError('Identificador inválido.');
    const name = text(body.name, 'Nombre de plantilla', 120);
    const subject = text(body.subject, 'Asunto', 200);
    if (/\r|\n/.test(subject)) throw new InputError('Asunto inválido.');
    const plainText = body.plainText == null ? '' : text(body.plainText, 'Texto del correo', 20000);
    const model = body.model == null ? '' : text(body.model, 'Modelo OpenAI', 80);
    if (model && !isAllowedOpenAIModel(model)) throw new InputError('Modelo OpenAI no permitido.');
    return { action: body.action, id, name, subject, html: emailHtml(body.html), plainText, model, orgId: body.orgId == null ? null : organizationId(body.orgId) };
  }
  if (body.action === 'gmailTemplateDelete') {
    const id = text(body.id, 'Identificador', 80);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new InputError('Identificador inválido.');
    return { action: body.action, id, orgId: body.orgId == null ? null : organizationId(body.orgId) };
  }
  if (body.action === 'gmailInboxReview') {
    const model = body.model == null ? null : text(body.model, 'Modelo OpenAI', 80);
    if (model && !isAllowedOpenAIModel(model)) throw new InputError('Modelo OpenAI no permitido.');
    return { action: body.action, model, orgId: body.orgId == null ? null : organizationId(body.orgId) };
  }
  if (body.action === 'gmailMessageModify') {
    const id = text(body.id, 'Identificador', 200);
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new InputError('Identificador inválido.');
    const operation = text(body.operation, 'Operación', 20);
    if (!['markRead', 'archive', 'trash'].includes(operation)) throw new InputError('Operación Gmail inválida.');
    return { action: body.action, id, operation, orgId: body.orgId == null ? null : organizationId(body.orgId) };
  }
  if (body.action === 'gmailReply') {
    const id = text(body.id, 'Identificador', 200);
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new InputError('Identificador inválido.');
    const templateId = body.templateId == null ? null : text(body.templateId, 'Plantilla', 80);
    if (templateId && !/^[a-zA-Z0-9_-]{1,80}$/.test(templateId)) throw new InputError('Plantilla inválida.');
    const html = body.html == null ? null : emailHtml(body.html);
    const plainText = body.plainText == null ? '' : text(body.plainText, 'Texto del correo', 20000);
    if (!templateId && !html) throw new InputError('Selecciona una plantilla o proporciona HTML para responder.');
    return { action: body.action, id, templateId, html, plainText, orgId: body.orgId == null ? null : organizationId(body.orgId) };
  }
  if (body.action === 'gmailGenerate') {
    const prompt = text(body.prompt, 'Instrucciones del correo', 5000);
    const model = body.model == null ? null : text(body.model, 'Modelo OpenAI', 80);
    if (model && !isAllowedOpenAIModel(model)) throw new InputError('Modelo OpenAI no permitido.');
    return { action: body.action, prompt, model, orgId: body.orgId == null ? null : organizationId(body.orgId) };
  }
  if (body.action === 'gmailSend') {
    const to = emailAddresses(body.to, 'Para', 1);
    const cc = body.cc == null ? [] : emailAddresses(body.cc, 'CC');
    const bcc = body.bcc == null ? [] : emailAddresses(body.bcc, 'CCO');
    if (to.length + cc.length + bcc.length > 50 || new Set([...to, ...cc, ...bcc]).size !== to.length + cc.length + bcc.length) throw new InputError('Destinatarios inválidos.');
    const subject = text(body.subject, 'Asunto', 200);
    if(/[\r\n]/.test(subject)) throw new InputError('Asunto inválido.');
    const plainText = body.plainText == null ? '' : text(body.plainText, 'Texto del correo', 20000);
    return { action: body.action, to, cc, bcc, subject, html: emailHtml(body.html), plainText, orgId: body.orgId == null ? null : organizationId(body.orgId) };
  }
  if (body.action === 'organizationInvite') {
    const orgId = organizationId(body.orgId);
    const email = text(body.email, 'Correo', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError('Correo inválido.');
    const role = text(body.role || 'member', 'Rol', 20).toLowerCase();
    if (!ORGANIZATION_ROLES.includes(role)) throw new InputError('Rol de organización inválido.');
    return { action: body.action, orgId, email, role };
  }
  if (body.action === 'runAgent') {
    const agentId = text(body.agentId, 'Agente', 80);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(agentId)) throw new InputError('Agente inválido.');
    const message = text(body.message, 'Mensaje', 4000);
    const rawHistory = body.history == null ? [] : body.history;
    if (!Array.isArray(rawHistory) || rawHistory.length > 20) throw new InputError('Historial inválido.');
    const history = rawHistory.map(item => {
      if (!item || !['user', 'assistant'].includes(item.role)) throw new InputError('Historial inválido.');
      return { role: item.role, content: text(item.content, 'Mensaje', 4000) };
    });
    const orgId = body.orgId == null ? null : organizationId(body.orgId);
    return { action: body.action, agentId, message, history, orgId };
  }
  if (body.action === 'saveEntity') {
    const collection = text(body.collection, 'Colección', 40);
    if (!['agents', 'automations', 'integrations', ...CRM_COLLECTIONS].includes(collection)) throw new InputError('Colección inválida.');
    const id = body.id == null ? null : text(body.id, 'Identificador', 80);
    if (id && !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new InputError('Identificador inválido.');
    const orgId = body.orgId == null ? null : organizationId(body.orgId);
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new InputError('Datos inválidos.');
    const data = {};
    for (const [key, value] of Object.entries(body.data)) {
      const maxValueLength = collection === 'agents' && key === 'instructions' ? 6000 : 500;
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,30}$/.test(key) || typeof value !== 'string' || value.length > maxValueLength) throw new InputError('Datos inválidos.');
      data[key] = value.trim();
    }
    if (!Object.keys(data).length) throw new InputError('Datos inválidos.');
    if (collection === 'agents') {
      const allowedKeys = ['name', 'description', 'model', 'instructions', 'status'];
      if (Object.keys(data).some(key => !allowedKeys.includes(key))) throw new InputError('Configuración de agente inválida.');
      if (!data.name) throw new InputError('Nombre de agente inválido.');
      if (data.name && data.name.length > 120) throw new InputError('Nombre de agente inválido.');
      if (data.description && data.description.length > 300) throw new InputError('Descripción de agente inválida.');
      if (data.instructions && data.instructions.length > 6000) throw new InputError('Instrucciones de agente inválidas.');
      if (data.model && !isAllowedOpenAIModel(data.model)) throw new InputError('Modelo OpenAI no permitido.');
      if (data.status && !['enabled', 'paused'].includes(data.status)) throw new InputError('Estado de agente inválido.');
    }
    if (CRM_COLLECTIONS.includes(collection)) {
      const allowedKeys = CRM_FIELDS[collection];
      if (Object.keys(data).some(key => !allowedKeys.includes(key))) throw new InputError('Campo CRM no permitido.');
      const required = collection === 'companies' ? ['name'] : collection === 'contacts' ? ['firstName', 'lastName'] : collection === 'opportunities' ? ['name', 'stage'] : ['subject', 'type'];
      if (required.some(key => !data[key])) throw new InputError('Faltan datos CRM obligatorios.');
      if (data.name && data.name.length > 160) throw new InputError('Nombre CRM inválido.');
      if ((data.firstName && data.firstName.length > 80) || (data.lastName && data.lastName.length > 80)) throw new InputError('Nombre de contacto inválido.');
      if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw new InputError('Correo CRM inválido.');
      if (data.website && !/^https:\/\//i.test(data.website)) throw new InputError('Sitio web CRM inválido.');
      if (collection === 'opportunities' && data.stage && !['lead', 'qualified', 'proposal', 'won', 'lost'].includes(data.stage)) throw new InputError('Etapa de oportunidad inválida.');
      if (collection === 'activities' && data.type && !['call', 'email', 'meeting', 'task', 'note'].includes(data.type)) throw new InputError('Tipo de actividad inválido.');
    }
    if (collection === 'integrations' && data.provider?.toLowerCase() === 'telegram' && data.webhookUrl && !isAllowedTelegramWebhookUrl(data.webhookUrl)) throw new InputError('Webhook URL de Telegram inválida. Usa una URL HTTPS de Automa/Vercel que termine en /api/telegram.');
    return { action: body.action, collection, id, orgId, data };
  }
  if (body.action === 'telegramStatus' || body.action === 'telegramRegister') return { action: body.action };
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
