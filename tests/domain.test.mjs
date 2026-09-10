import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedTelegramWebhookSecret, isAllowedTelegramWebhookUrl, parseCommand, planFollowUp } from '../server/domain.js';
import handler from '../api/business.js';
import gmailHandler, { createRawEmail, htmlToPlainText, normalizeGmailMessage, safeGeneratedEmail } from '../api/gmail.js';
const lead = { action: 'createLead', name: ' Cliente ', email: ' TEST@example.com ', value: 50, requestId: 'aabbbbbb-1111-4111-8111-111111111111' };
test('normalizes lead without trusting supplied user identity', () => {
 const parsed = parseCommand({ ...lead, uid: 'victim' });
 assert.equal(parsed.name, 'Cliente'); assert.equal(parsed.email, 'test@example.com'); assert.equal(parsed.uid, undefined);
});
test('rejects malformed values, identifiers, payloads and unknown actions', () => {
 for (const body of [null, [], {}, {...lead, value: -1}, {...lead, value: Infinity}, {...lead, value: '50'}, {...lead, email:'invalid'}, {...lead, requestId:'../../victim'}, {...lead, name: 'a'.repeat(121)}, {action:'updateTask', id:'../x',status:'done'}, {action:'saveSettings', enabled:'yes',hours:24}, {action:'saveSettings',enabled:true,hours:0}]) assert.throws(() => parseCommand(body));
});
test('follow-up deadline uses configured hours and can be disabled', () => {
 const now = new Date('2026-09-06T00:00:00Z');
 assert.equal(planFollowUp(lead, {enabled:true,hours:24}, now).dueAt.toISOString(), '2026-09-07T00:00:00.000Z');
 assert.equal(planFollowUp(lead, {enabled:false,hours:24}, now), null);
});
test('API rejects unsupported methods and unauthenticated writes', async () => {
 for (const [method, status] of [['GET',405],['POST',401]]) {
  const res = { setHeader(){}, status(code){this.code=code;return this;},json(body){this.body=body;return this;} };
  await handler({method,headers:{},body:lead},res); assert.equal(res.code,status);
 }
});
test('rejects array IDs instead of coercing them into document paths', () => {
 assert.throws(() => parseCommand({...lead,requestId:[lead.requestId]}));
 assert.throws(() => parseCommand({action:'updateTask',id:['abc'],status:'done'}));
});
test('validates OpenAI chat messages and bounded history', () => {
 const parsed = parseCommand({action:'chat',message:' hello ',history:[{role:'user',content:'previous'}]});
 assert.equal(parsed.message, 'hello');
 assert.throws(() => parseCommand({action:'chat',message:'ok',history:[{role:'system',content:'no'}]}));
 assert.throws(() => parseCommand({action:'chat',message:'ok',history:Array.from({length:21},()=>({role:'user',content:'x'}))}));
 assert.throws(() => parseCommand({action:'chat',message:'',history:[]}));
});
test('validates agent runs and OpenAI-only agent configuration', () => {
 const parsed = parseCommand({action:'runAgent',agentId:'sales-qualifier',message:'Qualify this lead',history:[]});
 assert.equal(parsed.agentId, 'sales-qualifier');
 assert.throws(() => parseCommand({action:'runAgent',agentId:'sales-qualifier',message:'ok',history:Array.from({length:21},()=>({role:'user',content:'x'}))}));
 const saved = parseCommand({action:'saveEntity',collection:'agents',data:{name:'Sales',model:'gpt-5.6-sol',instructions:'Qualify leads',status:'enabled'}});
 assert.equal(saved.data.model, 'gpt-5.6-sol');
 assert.throws(() => parseCommand({action:'saveEntity',collection:'agents',data:{name:'Other',model:'claude-3.5'}}));
 assert.throws(() => parseCommand({action:'saveEntity',collection:'agents',data:{name:'Paused',model:'gpt-5.6-sol',status:'Active'}}));
});
test('validates CRM records and bounded CRM copilot requests', () => {
 const company = parseCommand({ action:'saveEntity', collection:'companies', data:{ name:'Acme', industry:'Services', website:'https://acme.example', size:'small', status:'active' } });
 assert.equal(company.collection, 'companies'); assert.equal(company.data.name, 'Acme');
 const opportunity = parseCommand({ action:'saveEntity', collection:'opportunities', data:{ name:'Expansion', stage:'proposal', amount:'25000' } });
 assert.equal(opportunity.data.stage, 'proposal');
 assert.throws(() => parseCommand({ action:'saveEntity', collection:'companies', data:{ name:'Acme', website:'http://acme.example' } }));
 assert.throws(() => parseCommand({ action:'saveEntity', collection:'opportunities', data:{ name:'Expansion', stage:'unknown' } }));
 const assist = parseCommand({ action:'crmAssist', task:'summary', context:'{"companies":[],"opportunities":[]}', agentId:'data-analyzer' });
 assert.equal(assist.task, 'summary'); assert.equal(assist.agentId, 'data-analyzer');
 assert.throws(() => parseCommand({ action:'crmAssist', task:'delete', context:'{}' }));
 const contract = parseCommand({ action:'saveEntity', collection:'contracts', data:{ name:'Services agreement', status:'active', customerVisible:'true' } });
 assert.equal(contract.collection, 'contracts');
 const service = parseCommand({ action:'saveEntity', collection:'services', data:{ name:'Managed support', status:'active', customerVisible:'false' } });
 assert.equal(service.collection, 'services');
 assert.throws(() => parseCommand({ action:'saveEntity', collection:'contracts', data:{ name:'Agreement', status:'active', customerVisible:'yes' } }));
});
test('validates Telegram intake management actions', () => {
 const create = parseCommand({ action: 'telegramIntakeCreate', orgId: 'org_demo' });
 assert.deepEqual(create, { action: 'telegramIntakeCreate', orgId: 'org_demo' });
 const revoke = parseCommand({ action: 'telegramIntakeRevoke', intakeId: 'intake_123', orgId: 'org_demo' });
 assert.equal(revoke.intakeId, 'intake_123');
 assert.throws(() => parseCommand({ action: 'telegramIntakeRevoke', intakeId: '../unsafe' }));
});
test('validates organization workspaces, roles and scoped records', () => {
 const listed = parseCommand({ action:'organizationList' });
 assert.deepEqual(listed, { action:'organizationList' });
 const created = parseCommand({ action:'organizationCreate', name:' Acme Operations ' });
 assert.equal(created.name, 'Acme Operations');
 const invited = parseCommand({ action:'organizationInvite', orgId:'acme_ops', email:' TEAM@example.com ', role:'Admin' });
 assert.deepEqual(invited, { action:'organizationInvite', orgId:'acme_ops', email:'team@example.com', role:'admin' });
 const scoped = parseCommand({ action:'saveEntity', orgId:'acme_ops', collection:'companies', data:{ name:'Acme' } });
 assert.equal(scoped.orgId, 'acme_ops');
 assert.throws(() => parseCommand({ action:'organizationInvite', orgId:'../acme', email:'team@example.com', role:'member' }));
 assert.throws(() => parseCommand({ action:'organizationInvite', orgId:'acme', email:'invalid', role:'member' }));
 assert.throws(() => parseCommand({ action:'organizationInvite', orgId:'acme', email:'team@example.com', role:'owner' }));
});
test('keeps demo controls scoped and bounded', () => {
 assert.deepEqual(parseCommand({ action:'seedDemo', orgId:'acme_ops' }), { action:'seedDemo', orgId:'acme_ops' });
 assert.deepEqual(parseCommand({ action:'clearDemo' }), { action:'clearDemo', orgId:null });
 assert.deepEqual(parseCommand({ action:'clearWorkspace', orgId:'acme_ops' }), { action:'clearWorkspace', orgId:'acme_ops' });
 assert.deepEqual(parseCommand({ action:'clearAllProfiles', confirmation:'DELETE_ALL_AUTOMA_DATA' }), { action:'clearAllProfiles', confirmation:'DELETE_ALL_AUTOMA_DATA' });
 assert.throws(() => parseCommand({ action:'clearAllProfiles', confirmation:'delete' }));
 assert.throws(() => parseCommand({ action:'clearDemo', orgId:'../all' }));
});
test('accepts the authenticated Telegram status action without a payload', () => {
 const parsed = parseCommand({action:'telegramStatus'});
 assert.deepEqual(parsed, {action:'telegramStatus'});
 const registration = parseCommand({action:'telegramRegister'});
 assert.deepEqual(registration, {action:'telegramRegister'});
});
test('only accepts secure Automa or Vercel Telegram webhook URLs', () => {
 assert.equal(isAllowedTelegramWebhookUrl('https://automa.wstudio3d.com/api/telegram'), true);
 assert.equal(isAllowedTelegramWebhookUrl('https://automa-bqi32f8no-ronny-woods-projects.vercel.app/api/telegram'), true);
 assert.equal(isAllowedTelegramWebhookUrl('http://automa.wstudio3d.com/api/telegram'), false);
 assert.equal(isAllowedTelegramWebhookUrl('https://example.com/api/telegram'), false);
 assert.equal(isAllowedTelegramWebhookUrl('https://attacker.vercel.app/api/telegram'), false);
 assert.equal(isAllowedTelegramWebhookUrl('https://automa.wstudio3d.com/api/telegram?x=1'), false);
});
test('validates Telegram webhook secret characters', () => {
 assert.equal(isAllowedTelegramWebhookSecret('aZ09_-safe-token'), true);
 assert.equal(isAllowedTelegramWebhookSecret('contains spaces'), false);
 assert.equal(isAllowedTelegramWebhookSecret('contains.dot'), false);
 assert.equal(isAllowedTelegramWebhookSecret(''), false);
 assert.equal(isAllowedTelegramWebhookSecret('x'.repeat(257)), false);
});
test('validates Gmail compose actions and creates an RFC 2822 raw message', () => {
 const generation = parseCommand({ action:'gmailGenerate', prompt:'Write a concise follow-up in English.', model:'gpt-5.6-terra', orgId:'acme_ops' });
 assert.equal(generation.orgId, 'acme_ops');
 const send = parseCommand({ action:'gmailSend', to:['Client@example.com'], cc:['team@example.com'], bcc:['archive@example.com'], subject:'Proposal follow-up', html:'<p>Hello <strong>Client</strong></p>' });
 assert.deepEqual(send.to, ['client@example.com']);
 assert.equal(htmlToPlainText('<p>Hello <strong>Client</strong></p>'), 'Hello Client');
 const raw = createRawEmail({ ...send, from:'sender@example.com' });
 const mime = Buffer.from(raw, 'base64url').toString('utf8');
 assert.match(mime, /^MIME-Version: 1\.0/m); assert.match(mime, /^From: sender@example\.com/m); assert.match(mime, /^To: client@example\.com/m); assert.match(mime, /^Cc: team@example\.com/m); assert.match(mime, /^Bcc: archive@example\.com/m); assert.match(mime, /^Subject: Proposal follow-up/m);
 assert.throws(() => parseCommand({ action:'gmailSend', to:['client@example.com','client@example.com'], subject:'Hello', html:'<p>Hello</p>' }));
 assert.throws(() => parseCommand({ action:'gmailSend', to:['client@example.com'], subject:'Hello', html:'<script>alert(1)</script>' }));
 assert.throws(() => parseCommand({ action:'gmailGenerate', prompt:'x', model:'claude-3' }));
 const replyRaw = createRawEmail({ from:'sender@example.com', to:['client@example.com'], subject:'Re: Proposal follow-up', html:'<p>Thanks</p>', extraHeaders:['In-Reply-To: <msg@example.com>', 'References: <thread@example.com> <msg@example.com>'] });
 const replyMime = Buffer.from(replyRaw, 'base64url').toString('utf8');
 assert.match(replyMime, /^In-Reply-To: <msg@example.com>/m); assert.match(replyMime, /^References: <thread@example.com> <msg@example.com>/m);
});
test('validates Telegram CRM pairing commands', () => {
 const pairing = parseCommand({ action:'telegramPairingCreate', contactId:'contact_123', orgId:'acme_ops' });
 assert.deepEqual(pairing, { action:'telegramPairingCreate', contactId:'contact_123', orgId:'acme_ops' });
 const revoke = parseCommand({ action:'telegramPairingRevoke', pairingId:'pairing_123' });
 assert.deepEqual(revoke, { action:'telegramPairingRevoke', pairingId:'pairing_123' });
 assert.throws(() => parseCommand({ action:'telegramPairingCreate', contactId:'../other' }));
});
test('normalizes safe HTML drafts returned by OpenAI', () => {
 const draft = safeGeneratedEmail('```json\n{"subject":"Welcome to Automa","html":"<!doctype html><html><head><meta charset=\\"utf-8\\"></head><body><p>Welcome</p></body></html>","text":"Welcome"}\n```');
 assert.equal(draft.subject, 'Welcome to Automa'); assert.doesNotMatch(draft.html, /<meta/i); assert.match(draft.html, /Welcome/);
 assert.throws(() => safeGeneratedEmail('{"subject":"Unsafe","html":"<script>alert(1)</script>","text":"Unsafe"}'));
});
test('validates reusable Gmail HTML templates', () => {
 const saved = parseCommand({ action:'gmailTemplateSave', id:'welcome_1', name:' Automa welcome ', subject:'Welcome to Automa', html:'<p>Hello <strong>customer</strong></p>', model:'gpt-5.6-terra', orgId:'acme_ops' });
 assert.equal(saved.name, 'Automa welcome'); assert.equal(saved.id, 'welcome_1'); assert.equal(saved.orgId, 'acme_ops');
 assert.deepEqual(parseCommand({ action:'gmailTemplateList' }), { action:'gmailTemplateList', orgId:null });
 assert.equal(parseCommand({ action:'gmailTemplateDelete', id:'welcome_1' }).id, 'welcome_1');
 assert.throws(() => parseCommand({ action:'gmailTemplateSave', name:'Template', subject:'Hello\nBcc: attacker@example.com', html:'<p>Hello</p>' }));
 assert.throws(() => parseCommand({ action:'gmailTemplateSave', name:'Template', subject:'Hello', html:'<script>alert(1)</script>' }));
});
test('validates Gmail inbox review, message actions and template replies', () => {
 const review = parseCommand({ action:'gmailInboxReview', model:'gpt-5.6-luna', orgId:'acme_ops' });
 assert.deepEqual(review, { action:'gmailInboxReview', model:'gpt-5.6-luna', orgId:'acme_ops' });
 assert.deepEqual(parseCommand({ action:'gmailMessageModify', id:'msg_123', operation:'archive' }), { action:'gmailMessageModify', id:'msg_123', operation:'archive', orgId:null });
 assert.deepEqual(parseCommand({ action:'gmailReply', id:'msg_123', templateId:'welcome_1' }), { action:'gmailReply', id:'msg_123', templateId:'welcome_1', html:null, plainText:'', orgId:null });
 assert.throws(() => parseCommand({ action:'gmailMessageModify', id:'msg_123', operation:'deleteForever' }));
 assert.throws(() => parseCommand({ action:'gmailReply', id:'msg_123' }));
});
test('normalizes Gmail headers and base64url message bodies for safe review', () => {
 const message = normalizeGmailMessage({ id:'msg_1', threadId:'thread_1', snippet:'Hello', labelIds:['INBOX','UNREAD'], payload:{ headers:[{name:'From',value:'Acme <Sales@Example.com>'},{name:'Subject',value:'Proposal'},{name:'Date',value:'Thu, 10 Sep 2026 12:00:00 +0000'}], mimeType:'text/plain', body:{ data:Buffer.from('Please review this proposal.','utf8').toString('base64url') } } });
 assert.equal(message.fromEmail, 'sales@example.com'); assert.equal(message.subject, 'Proposal'); assert.equal(message.body, 'Please review this proposal.'); assert.equal(message.unread, true);
});
test('Gmail endpoint rejects unauthenticated email actions', async () => {
 const res = { setHeader(){}, status(code){ this.code = code; return this; }, json(body){ this.body = body; return this; } };
 await gmailHandler({ method:'POST', headers:{}, body:{ action:'gmailStatus' } }, res);
 assert.equal(res.code, 401); assert.equal(res.body.code, 'firebase_session_missing');
});
test('API validates body size and malformed commands before connecting to services', async () => {
 for (const [body,status] of [[{},400],[{padding:'x'.repeat(13000)},413]]) {
  const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await handler({method:'POST',headers:{authorization:'Bearer example'},body},res);
  assert.equal(res.code,status);
 }
});
