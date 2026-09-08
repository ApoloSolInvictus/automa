const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
const url = (process.env.TELEGRAM_WEBHOOK_URL || 'https://automa.wstudio3d.com/api/telegram').trim();
if (!token || !secret) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET before running this command.');
const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: false })
});
const payload = await response.json().catch(() => ({}));
if (!response.ok || payload.ok !== true) throw new Error(payload?.description || 'Telegram rejected the webhook.');
console.log(`Telegram webhook configured: ${url}`);
