import { test } from 'node:test';
import assert from 'node:assert/strict';
import telegramHandler, { buildTelegramCrmContext, parseTelegramPairingCode, parseTelegramUpdate, splitTelegramText, telegramBindingKey, webhookSecretMatches } from '../api/telegram.js';

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
  assert.deepEqual(parsed, { updateId: '42', chatId: '123', messageId: '7', text: 'Hello bot', businessConnectionId: null });
  const business = parseTelegramUpdate({ update_id: 43, business_message: { business_connection_id: 'business-1', message_id: 8, chat: { id: 456 }, text: 'Business hello' } });
  assert.equal(business.businessConnectionId, 'business-1');
  assert.equal(business.chatId, '456');
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

test('parses one-time Telegram pairing commands and scopes CRM context', () => {
  const code = 'A'.repeat(24);
  assert.equal(parseTelegramPairingCode(`/start automa_${code}`), code);
  assert.equal(parseTelegramPairingCode(`/start@WSTUDIO3DBot automa_${code}`), code);
  assert.equal(parseTelegramPairingCode('/start automa_short'), null);
  const context = JSON.parse(buildTelegramCrmContext({
    contacts: [{ id: 'contact-1', firstName: 'Alex', lastName: 'Morgan', companyId: 'company-1', email: 'private@example.com', notes: 'private' }],
    companies: [{ id: 'company-1', name: 'Acme', industry: 'Services', notes: 'internal' }],
    contracts: [
      { id: 'contract-1', contactId: 'contact-1', name: 'Approved agreement', status: 'active', customerVisible: 'true' },
      { id: 'contract-2', contactId: 'contact-1', name: 'Internal agreement', status: 'draft', customerVisible: 'false' },
      { id: 'contract-3', contactId: 'other', name: 'Other client', status: 'active', customerVisible: 'true' }
    ],
    services: [{ id: 'service-1', companyId: 'company-1', name: 'Managed workflows', status: 'active', customerVisible: true }],
    opportunities: [{ id: 'op-1', contactId: 'contact-1', name: 'Expansion', stage: 'proposal' }],
    activities: [{ id: 'activity-1', companyId: 'company-1', subject: 'Follow up', type: 'email' }]
  }, { contactId: 'contact-1', companyId: 'company-1' }));
  assert.equal(context.contact.email, undefined);
  assert.equal(context.company.notes, undefined);
  assert.deepEqual(context.contracts.map(item => item.name), ['Approved agreement']);
  assert.deepEqual(context.services.map(item => item.name), ['Managed workflows']);
  assert.equal(telegramBindingKey('123'), telegramBindingKey('123'));
  assert.notEqual(telegramBindingKey('123'), telegramBindingKey('124'));
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
