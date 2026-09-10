import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve('dist');
const server = createServer(async (req,res) => {
 const path = resolve(root, '.' + (req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
 if (!path.startsWith(root + sep)) {res.writeHead(403).end();return;}
 try { const content=await readFile(path); res.setHeader('Content-Type', {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'}[extname(path)] || 'application/octet-stream');res.end(content); } catch {res.writeHead(404).end();}
});
await new Promise(done=>server.listen(4173,'127.0.0.1',done));
let browser;
try {
 browser = await chromium.launch({channel:'msedge',headless:true});
 const page = await browser.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await mkdir('test-results',{recursive:true});
 for (const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]) {
  await page.setViewportSize({width,height});await page.goto('http://127.0.0.1:4173/', { waitUntil:'domcontentloaded' });
  await page.locator('#loginErrMsg').waitFor({state:'attached'});
  assert.match(await page.locator('#loginErrMsg').textContent(), /Firebase is not configured/);
  assert.equal(await page.locator('#loginBtn:disabled').count(),1);
  assert.equal(await page.locator('#dashboard').isVisible(),false);
  const landingOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(landingOverflow <= 1, `${name} landing should not overflow horizontally`);
  await page.evaluate(() => {
   document.querySelector('#landing').style.display = 'none';
   document.querySelector('#dashboard').style.display = 'block';
   if (window.dbNav) window.dbNav('crm', document.querySelector('[onclick*=crm]'));
  });
  await page.waitForTimeout(100);
  const dashboardOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(dashboardOverflow <= 1, `${name} dashboard should not overflow horizontally`);
  await page.screenshot({path:`test-results/${name}.png`,fullPage:false,timeout:60000});
 }
 await page.goto('http://127.0.0.1:4173/demo.html', { waitUntil:'domcontentloaded' });await page.getByText('DEMO VISUAL',{exact:false}).first().waitFor();
 assert.deepEqual(errors,[]);console.log('UI passed: desktop/mobile, disabled unconfigured auth, demo warning, no page errors.');
} finally {await browser?.close();server.close();}
