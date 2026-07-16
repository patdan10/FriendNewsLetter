require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const nodemailer = require('nodemailer');

const to = process.argv[2];
if (!to) {
  console.error('Usage: node scripts/test-email.js you@youremail.com');
  process.exit(1);
}

const cfg = {
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  user: process.env.SMTP_USER,
  from: process.env.FROM_EMAIL || process.env.SMTP_USER,
};

console.log('\n── Current SMTP config ───────────────────────────────');
console.log(`  SMTP_HOST:   ${cfg.host || '(not set)'}`);
console.log(`  SMTP_PORT:   ${cfg.port}`);
console.log(`  SMTP_SECURE: ${cfg.secure}`);
console.log(`  SMTP_USER:   ${cfg.user || '(not set)'}`);
console.log(`  FROM_EMAIL:  ${cfg.from}`);
console.log(`  Sending to:  ${to}`);
console.log('──────────────────────────────────────────────────────\n');

if (!cfg.host) {
  console.error('❌  SMTP_HOST is not set in .env — check your .env file.');
  process.exit(1);
}
if (!cfg.user) {
  console.error('❌  SMTP_USER is not set in .env — check your .env file.');
  process.exit(1);
}

const transport = nodemailer.createTransport({
  host: cfg.host,
  port: cfg.port,
  secure: cfg.secure,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  logger: true,   // log SMTP conversation to console
  debug: true,
});

console.log('Verifying SMTP connection...');
transport.verify()
  .then(() => {
    console.log('✅  SMTP connection OK — sending test email...\n');
    return transport.sendMail({
      from: cfg.from,
      to,
      subject: '✅ Friend Newsletter — test email',
      text: 'If you received this, your SMTP config is working correctly.',
      html: '<p>If you received this, your SMTP config is working correctly.</p>',
    });
  })
  .then(info => {
    console.log('\n✅  Sent! Message ID:', info.messageId);
    console.log('   Response:', info.response);
    console.log('\nIf the email does not arrive within a few minutes:');
    console.log('  1. Check your spam/junk folder');
    console.log('  2. Make sure FROM_EMAIL matches your authenticated SMTP account');
    console.log('  3. Check whether your provider requires domain verification');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌  Failed:', err.message);
    if (err.code === 'EAUTH') {
      console.error('\nAuthentication failed. Common fixes:');
      console.error('  • Gmail: use an App Password, not your regular password');
      console.error('    → myaccount.google.com/apppasswords');
      console.error('  • Outlook: check SMTP_HOST=smtp.office365.com, PORT=587, SECURE=false');
      console.error('  • Other: confirm SMTP_USER and SMTP_PASS are correct');
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
      console.error('\nCould not reach SMTP server. Try:');
      console.error('  • Double-check SMTP_HOST and SMTP_PORT');
      console.error('  • Port 587 (STARTTLS, SMTP_SECURE=false) vs 465 (SSL, SMTP_SECURE=true)');
    }
    process.exit(1);
  });
