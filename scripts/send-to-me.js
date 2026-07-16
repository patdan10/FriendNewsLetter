// Sends both the form email and the compiled newsletter to just you,
// so you can check how they look in a real inbox before sending to everyone.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../src/db');
const { sendFormEmail, sendCompiledEmail } = require('../src/mailer');

const myEmail = process.env.SMTP_USER;
if (!myEmail) { console.error('Set SMTP_USER in .env first'); process.exit(1); }

const myName = db.getSubscribers().find(s => s.email === myEmail)?.name || 'You';
const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

const now = new Date();
const newsletter = db.getOrCreateNewsletter(now.getFullYear(), now.getMonth() + 1);
const responses = db.getResponses(newsletter.id);

(async () => {
  console.log(`Sending test emails to ${myEmail}...\n`);

  console.log('1/2 Form email...');
  await sendFormEmail({ toEmail: myEmail, toName: myName, newsletter, baseUrl });

  console.log('2/2 Compiled newsletter...');
  await sendCompiledEmail({ toEmail: myEmail, toName: myName, newsletter, responses, baseUrl });

  console.log('\nDone! Check your inbox (and spam folder).');
  console.log(`Compiled newsletter includes ${responses.length} response(s) currently in the database.`);
  process.exit(0);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
