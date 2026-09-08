import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, planFollowUp } from '../server/domain.js';
import handler from '../api/business.js';
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
test('API validates body size and malformed commands before connecting to services', async () => {
 for (const [body,status] of [[{},400],[{padding:'x'.repeat(13000)},413]]) {
  const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await handler({method:'POST',headers:{authorization:'Bearer example'},body},res);
  assert.equal(res.code,status);
 }
});
