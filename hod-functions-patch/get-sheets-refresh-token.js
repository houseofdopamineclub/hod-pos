// ════════════════════════════════════════════════════════
// One-time: get a refresh token for Google Sheets API
// ────────────────────────────────────────────────────────
// Reuses your existing oauth-creds.json (the desktop OAuth client
// you already created for Gmail).
//
// IMPORTANT: sign in with the Google account that OWNS the
// HOD archive spreadsheet (or has Editor access to it).
//
// Usage:
//   1. cd into your functions/ folder (where oauth-creds.json lives)
//   2. node get-sheets-refresh-token.js
//   3. Open URL, sign in, paste code back
//   4. Copy SHEETS_REFRESH_TOKEN for firebase secrets
// ════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const readline = require('readline');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const CREDS_PATH = path.join(__dirname, 'oauth-creds.json');

async function main() {
  if (!fs.existsSync(CREDS_PATH)) {
    console.error('ERROR: oauth-creds.json not found in this folder.');
    console.error('Re-use the same JSON you used for Gmail (or create a new Desktop OAuth client).');
    process.exit(1);
  }
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  const c = creds.installed || creds.web;
  if (!c) { console.error('Bad oauth-creds.json'); process.exit(1); }

  const oAuth = new google.auth.OAuth2(c.client_id, c.client_secret, 'urn:ietf:wg:oauth:2.0:oob');
  const url = oAuth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

  console.log('\n════════════════════════════════════════════════');
  console.log('STEP 1 — Open this URL in your browser:');
  console.log('════════════════════════════════════════════════\n');
  console.log(url);
  console.log('\nSTEP 2 — Sign in with the Google account that OWNS');
  console.log('         the HOD archive spreadsheet.');
  console.log('STEP 3 — Approve "See, edit, create Sheets" access.');
  console.log('STEP 4 — Copy the auth code Google shows you.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Paste authorization code here: ', async (code) => {
    rl.close();
    try {
      const { tokens } = await oAuth.getToken(code.trim());
      console.log('\n════════════════════════════════════════════════');
      console.log('SUCCESS! Save these for firebase secrets:');
      console.log('════════════════════════════════════════════════\n');
      console.log('SHEETS_CLIENT_ID:');     console.log(c.client_id);
      console.log('\nSHEETS_CLIENT_SECRET:'); console.log(c.client_secret);
      console.log('\nSHEETS_REFRESH_TOKEN:'); console.log(tokens.refresh_token);
      console.log('\n════════════════════════════════════════════════\n');
      if (!tokens.refresh_token) {
        console.warn('No refresh_token — revoke previous access at:');
        console.warn('  https://myaccount.google.com/permissions');
      }
    } catch (e) {
      console.error('Failed:', e.message);
      process.exit(1);
    }
  });
}
main().catch(e => { console.error(e); process.exit(1); });
