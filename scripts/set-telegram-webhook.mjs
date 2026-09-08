import { readFile } from 'node:fs/promises';

async function loadLocalEnv() {
  for (const filename of ['.env.local', '.env']) {
    try {
      const content = await readFile(filename, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match || process.env[match[1]]) continue;
        process.env[match[1]] = match[2].replace(/^("|')(.*)\1$/, '$2');
      }
    } catch { /* local env file is optional */ }
  }
}

await loadLocalEnv();
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
const url = (process.env.TELEGRAM_WEBHOOK_URL || 'https://automa.wstudio3d.com/api/telegram').trim();
if (!token || !secret) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET before running this command.');
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new Error('TELEGRAM_WEBHOOK_SECRET must be 1-256 characters using only A-Z, a-z, 0-9, underscore or hyphen.');
const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message', 'business_message'], drop_pending_updates: false })
});
const payload = await response.json().catch(() => ({}));
if (!response.ok || payload.ok !== true) throw new Error(payload?.description || 'Telegram rejected the webhook.');
console.log(`Telegram webhook configured: ${url}`);
