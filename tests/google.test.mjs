import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler, { decodeGoogleState, googleScopes, parseGoogleCommand } from '../api/google.js';

test('Google Workspace exposes the expected OAuth scopes and validates service actions', () => {
  const scopes = googleScopes();
  assert.ok(scopes.includes('https://www.googleapis.com/auth/drive'));
  assert.ok(scopes.includes('https://www.googleapis.com/auth/documents'));
  assert.ok(scopes.includes('https://www.googleapis.com/auth/calendar'));
  assert.ok(scopes.includes('https://www.googleapis.com/auth/spreadsheets'));
  assert.deepEqual(parseGoogleCommand({ action: 'googleStatus', orgId: 'workspace_1' }), { action: 'googleStatus', orgId: 'workspace_1' });
  assert.equal(parseGoogleCommand({ action: 'googleCalendarList', days: 7 }).days, 7);
  assert.deepEqual(parseGoogleCommand({ action: 'googleSheetsAppend', spreadsheetId: 'sheet_1234', range: 'Sheet1!A1', values: [['Lead', 'New']] }).values, [['Lead', 'New']]);
});

test('Google Workspace rejects malformed or unsafe service commands', () => {
  for (const body of [null, {}, { action: 'unknown' }, { action: 'googleDocsGet', documentId: '../private' }, { action: 'googleCalendarList', days: 0 }, { action: 'googleSheetsRead', spreadsheetId: 'bad', range: 'A1' }, { action: 'googleSheetsAppend', spreadsheetId: 'sheet_1234', range: 'A1', values: [] }]) assert.throws(() => parseGoogleCommand(body));
});

test('Google OAuth callback state rejects tampering and unauthenticated API calls', async () => {
  assert.throws(() => decodeGoogleState('invalid.state', 'test-secret'));
  const response = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'POST', headers: {}, body: { action: 'googleStatus' } }, response);
  assert.equal(response.code, 401);
});
