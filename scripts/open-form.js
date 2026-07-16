// Opens your own form in the browser so you can see what subscribers see.
// Requires "1 - Start Server" to be running.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { execSync } = require('child_process');
const db = require('../src/db');
const { makeToken } = require('../src/mailer');

const myEmail = process.env.SMTP_USER;
if (!myEmail) { console.error('Set SMTP_USER in .env first'); process.exit(1); }

const now = new Date();
const newsletter = db.getOrCreateNewsletter(now.getFullYear(), now.getMonth() + 1);
const token = makeToken(newsletter.id, myEmail);
const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
const url = `${baseUrl}/form/${token}`;

console.log(`Opening form for ${myEmail}:`);
console.log(url);
execSync(`start "" "${url}"`);
