import { test } from 'node:test';
import assert from 'node:assert/strict';
import chatHandler, { classifyOpenAIFailure, extractResponseText } from '../api/chat.js';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('chat endpoint rejects unsupported methods and missing sessions without loading Firebase Admin', async () => {
  const getResponse = response();
  await chatHandler({ method: 'GET', headers: {}, body: null }, getResponse);
  assert.equal(getResponse.code, 405);
  assert.equal(getResponse.headers['X-Automa-Chat-Version'], '2');

  const postResponse = response();
  await chatHandler({ method: 'POST', headers: {}, body: { action: 'chat', message: 'Hello', history: [] } }, postResponse);
  assert.equal(postResponse.code, 401);
  assert.equal(postResponse.body.code, 'firebase_session_missing');
});

test('extracts text from a raw Responses API payload', () => {
  const payload = {
    output: [
      { type: 'reasoning', content: [] },
      { type: 'message', content: [{ type: 'output_text', text: 'First line' }, { type: 'output_text', text: 'Second line' }] }
    ]
  };
  assert.equal(extractResponseText(payload), 'First line\nSecond line');
  assert.equal(extractResponseText({ output: [] }), '');
});

test('chat endpoint validates Firebase by REST and returns an OpenAI reply', async () => {
  const originalFetch = globalThis.fetch;
  const originalFirebaseKey = process.env.FIREBASE_WEB_API_KEY;
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_MODEL;
  const calls = [];
  process.env.FIREBASE_WEB_API_KEY = 'firebase-test-key';
  process.env.OPENAI_API_KEY = 'openai-test-key';
  process.env.OPENAI_MODEL = 'test-model';
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('identitytoolkit.googleapis.com')) {
      return new Response(JSON.stringify({ users: [{ localId: 'user-1' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Automation ready.' }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const res = response();
    await chatHandler({ method: 'POST', headers: { authorization: 'Bearer firebase-id-token' }, body: { action: 'chat', message: 'Help me automate leads', history: [] } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.reply, 'Automation ready.');
    assert.equal(res.body.model, 'test-model');
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /identitytoolkit\.googleapis\.com/);
    assert.equal(calls[1].url, 'https://api.openai.com/v1/responses');
    assert.equal(JSON.parse(calls[1].options.body).store, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalFirebaseKey === undefined) delete process.env.FIREBASE_WEB_API_KEY; else process.env.FIREBASE_WEB_API_KEY = originalFirebaseKey;
    if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalOpenAIKey;
    if (originalModel === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = originalModel;
  }
});

test('distinguishes OpenAI authentication, quota, rate and model failures', () => {
  assert.equal(classifyOpenAIFailure(401, { error: { code: 'invalid_api_key' } }).code, 'invalid_api_key');
  assert.equal(classifyOpenAIFailure(429, { error: { code: 'insufficient_quota' } }).code, 'insufficient_quota');
  assert.equal(classifyOpenAIFailure(429, { error: { code: 'rate_limit_exceeded' } }).code, 'rate_limit_exceeded');
  assert.equal(classifyOpenAIFailure(404, { error: { code: 'model_not_found' } }).code, 'model_not_found');
});
