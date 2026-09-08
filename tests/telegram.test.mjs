import { test } from 'node:test';
import assert from 'node:assert/strict';
import telegramHandler, { parseTelegramUpdate, splitTelegramText, webhookSecretMatches } from '../api/telegram.js';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('parses only bounded Telegram text messages', () => {
  const parsed = parseTelegramUpdate({ update_id: 42, message: { message_id: 7, chat: { id: 123 }, text: ' Hello bot ' } });
  assert.deepEqual(parsed, { updateId: '42', chatId: '123', messageId: '7', text: 'Hello bot' });
  assert.equal(parseTelegramUpdate({ message: { chat: { id: 123 }, text: '' } }), null);
  assert.equal(parseTelegramUpdate({ message: { chat: { id: 123 }, text: 'x'.repeat(4001) } }), null);
  assert.equal(parseTelegramUpdate({ message: { chat: { id: 123 }, photo: [] } }), null);
  assert.equal(parseTelegramUpdate({ update_id: 'unsafe/path', message: { chat: { id: 123 }, text: 'hello' } }), null);
});

test('compares webhook secrets safely and splits Telegram message limits', () => {
  assert.equal(webhookSecretMatches('secret-123', 'secret-123'), true);
  assert.equal(webhookSecretMatches('secret-123', 'secret-124'), false);
  assert.equal(webhookSecretMatches('', 'secret-123'), false);
  const chunks = splitTelegramText('😀'.repeat(4097), 4096);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.join(''), '😀'.repeat(4097));
});

test('Telegram webhook rejects unsupported methods and invalid secrets', async () => {
  const get = response();
  await telegramHandler({ method: 'GET', headers: {}, body: null }, get);
  assert.equal(get.code, 405);
  const originalSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-test-secret';
  try {
    const post = response();
    await telegramHandler({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, body: {} }, post);
    assert.equal(post.code, 401);
    assert.equal(post.body.code, 'telegram_webhook_unauthorized');
  } finally {
    if (originalSecret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET; else process.env.TELEGRAM_WEBHOOK_SECRET = originalSecret;
  }
});
