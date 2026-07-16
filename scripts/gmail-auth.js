// Run once to get your Gmail OAuth refresh token.
// Usage: node scripts/gmail-auth.js
require('dotenv').config();
const http = require('http');
const { exec } = require('child_process');
const { google } = require('googleapis');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const REDIRECT = 'http://localhost:3333/callback';
const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);
const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });

console.log('\nOpening browser for Gmail authorization...');
exec(`start "" "${authUrl}"`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3333');
  const code = url.searchParams.get('code');
  if (!code) { res.end('No code — try again.'); return; }
  res.end('<h1>Authorized! You can close this tab.</h1>');
  server.close();
  const { tokens } = await oauth2Client.getToken(code);
  console.log('\n✅ Success! Add this to Railway as GMAIL_REFRESH_TOKEN:\n');
  console.log(tokens.refresh_token);
  console.log('');
});

server.listen(3333, () => console.log('Waiting for Google authorization...'));
