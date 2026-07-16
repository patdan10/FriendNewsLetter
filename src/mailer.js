const nodemailer = require('nodemailer');

const MONTHS = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

// ─── Sender: Gmail API / Resend / Ethereal ───────────────────────────────────

async function sendViaGmail({ from, to, subject, html }) {
  const { google } = require('googleapis');
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const raw = Buffer.from(
    [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`,
     'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', html].join('\r\n')
  ).toString('base64url');
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  console.log(`  📬 ${to}: sent (id: ${res.data.id})`);
  return res.data;
}

async function sendViaResend({ from, to, subject, html }) {
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({ from, to, subject, html });
  if (error) throw new Error(error.message);
  console.log(`  📬 ${to}: sent (id: ${data.id})`);
  return data;
}

let etherealTransporter;
async function sendViaEthereal({ from, to, subject, html }) {
  if (!etherealTransporter) {
    const testAccount = await nodemailer.createTestAccount();
    console.log('\n📧 Ethereal test account:');
    console.log(`   Preview: https://ethereal.email/messages`);
    console.log(`   Login:   ${testAccount.user} / ${testAccount.pass}\n`);
    etherealTransporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email', port: 587, secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass }
    });
  }
  const info = await etherealTransporter.sendMail({ from, to, subject, html });
  const preview = nodemailer.getTestMessageUrl(info);
  if (preview) console.log(`  📬 ${to}: ${preview}`);
  return info;
}

async function deliver({ toEmail, toName, subject, html }) {
  const from = process.env.FROM_EMAIL || '"Friend Newsletter" <newsletter@example.com>';
  if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_REFRESH_TOKEN) {
    return sendViaGmail({ from, to: toEmail, subject, html });
  }
  if (process.env.RESEND_API_KEY) {
    return sendViaResend({ from, to: toEmail, subject, html });
  }
  return sendViaEthereal({ from, to: `${toName} <${toEmail}>`, subject, html });
}

function makeToken(newsletterId, email) {
  return Buffer.from(`${newsletterId}:${email}`).toString('base64url');
}

function parseToken(token) {
  const decoded = Buffer.from(token, 'base64url').toString();
  const colon = decoded.indexOf(':');
  return {
    newsletterId: parseInt(decoded.slice(0, colon)),
    email: decoded.slice(colon + 1)
  };
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildFormEmail({ name, month, year, questions, formUrl }) {
  const monthName = MONTHS[month - 1];
  const qs = questions.map((q, i) => `<li style="margin-bottom:8px;color:#374151;">${esc(q)}</li>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08);">
<tr><td style="background:linear-gradient(135deg,#667eea,#764ba2);padding:40px;text-align:center;">
  <h1 style="margin:0;color:#fff;font-size:28px;font-weight:700;">📰 Friend Newsletter</h1>
  <p style="margin:8px 0 0;color:rgba(255,255,255,.85);font-size:16px;">${monthName} ${year}</p>
</td></tr>
<tr><td style="padding:40px;">
  <p style="margin:0 0 16px;color:#1f2937;font-size:18px;">Hey ${esc(name)}! 👋</p>
  <p style="margin:0 0 24px;color:#6b7280;font-size:15px;line-height:1.6;">It's that time of month! We'd love to hear what's been going on in your life. Share your highlights, discoveries, and anything on your mind.</p>
  <div style="background:#f9fafb;border-radius:12px;padding:24px;margin-bottom:28px;border:1px solid #e5e7eb;">
    <p style="margin:0 0 12px;color:#1f2937;font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:.5px;">This month's questions:</p>
    <ol style="margin:0;padding-left:20px;">${qs}</ol>
  </div>
  <div style="text-align:center;margin-bottom:32px;">
    <a href="${formUrl}" style="display:inline-block;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;text-decoration:none;padding:16px 40px;border-radius:50px;font-size:16px;font-weight:600;">✍️ Fill Out This Month's Update</a>
  </div>
  <p style="margin:0;color:#9ca3af;font-size:13px;text-align:center;">Responses will be compiled and shared with the group on the last day of the month. You can include links and images!</p>
</td></tr>
<tr><td style="background:#f9fafb;padding:20px;text-align:center;border-top:1px solid #e5e7eb;">
  <p style="margin:0;color:#9ca3af;font-size:12px;">Friend Newsletter · Sent with ❤️</p>
</td></tr>
</table>
</td></tr>
</table></body></html>`;
}

function buildCompiledEmail({ month, year, responses, baseUrl }) {
  const monthName = MONTHS[month - 1];

  const blocks = responses.map(r => {
    const initials = (r.name || r.email).slice(0, 2).toUpperCase();
    const hue = [...(r.name || r.email)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;

    const answersHtml = r.answers
      .map((a, i) => a?.trim() ? `<p style="margin:0 0 14px;color:#374151;font-size:15px;line-height:1.7;white-space:pre-wrap;">${esc(a)}</p>` : '')
      .join('');

    const imgSrc = r.image_filename
      ? `${baseUrl}/uploads/${esc(r.image_filename)}`
      : r.image_url ? esc(r.image_url) : null;
    const imgHtml = imgSrc
      ? `<div style="margin-top:16px;"><img src="${imgSrc}" alt="Shared photo" style="max-width:100%;border-radius:10px;display:block;"></div>`
      : '';

    const linksHtml = r.links?.length
      ? `<div style="margin-top:16px;">
          <p style="margin:0 0 8px;color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Shared Links</p>
          ${r.links.map(l => `<a href="${esc(l.url)}" style="display:inline-block;margin:4px 8px 4px 0;background:#ede9fe;color:#7c3aed;text-decoration:none;padding:6px 14px;border-radius:20px;font-size:14px;">🔗 ${esc(l.label || l.url)}</a>`).join('')}
        </div>`
      : '';

    const date = new Date(r.submitted_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

    return `
<div style="border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;margin-bottom:24px;">
  <div style="background:linear-gradient(135deg,hsl(${hue},55%,55%),hsl(${(hue+40)%360},55%,45%));padding:20px 24px;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="width:52px;vertical-align:middle;">
        <div style="width:48px;height:48px;background:rgba(255,255,255,.3);border-radius:50%;text-align:center;line-height:48px;font-size:18px;font-weight:700;color:#fff;">${initials}</div>
      </td>
      <td style="padding-left:16px;vertical-align:middle;">
        <div style="color:#fff;font-size:18px;font-weight:700;">${esc(r.name || r.email)}</div>
        <div style="color:rgba(255,255,255,.8);font-size:13px;">Submitted ${date}</div>
      </td>
    </tr></table>
  </div>
  <div style="padding:24px;background:#fff;">${answersHtml}${imgHtml}${linksHtml}</div>
</div>`;
  }).join('');

  const noResp = responses.length === 0
    ? '<p style="text-align:center;color:#9ca3af;padding:40px 20px;">No responses were submitted this month.</p>'
    : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 0;">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08);">
<tr><td style="background:linear-gradient(135deg,#667eea,#764ba2);padding:40px;text-align:center;">
  <h1 style="margin:0;color:#fff;font-size:28px;font-weight:700;">📰 Friend Newsletter</h1>
  <p style="margin:8px 0 0;color:rgba(255,255,255,.85);font-size:18px;font-weight:500;">${monthName} ${year} Edition</p>
  <p style="margin:6px 0 0;color:rgba(255,255,255,.7);font-size:14px;">${responses.length} response${responses.length !== 1 ? 's' : ''} from your friends</p>
</td></tr>
<tr><td style="padding:32px 40px;">${noResp}${blocks}</td></tr>
<tr><td style="background:#f9fafb;padding:20px;text-align:center;border-top:1px solid #e5e7eb;">
  <p style="margin:0;color:#9ca3af;font-size:12px;">Friend Newsletter · ${monthName} ${year} · Sent with ❤️</p>
</td></tr>
</table>
</td></tr>
</table></body></html>`;
}

async function sendFormEmail({ toEmail, toName, newsletter, baseUrl }) {
  const token = makeToken(newsletter.id, toEmail);
  return deliver({
    toEmail, toName,
    subject: `📝 ${MONTHS[newsletter.month - 1]} ${newsletter.year} — Share your update!`,
    html: buildFormEmail({ name: toName, month: newsletter.month, year: newsletter.year, questions: newsletter.questions, formUrl: `${baseUrl}/form/${token}` })
  });
}

async function sendCompiledEmail({ toEmail, toName, newsletter, responses, baseUrl }) {
  return deliver({
    toEmail, toName,
    subject: `📰 ${MONTHS[newsletter.month - 1]} ${newsletter.year} Friend Newsletter`,
    html: buildCompiledEmail({ month: newsletter.month, year: newsletter.year, responses, baseUrl })
  });
}

module.exports = { makeToken, parseToken, sendFormEmail, sendCompiledEmail, buildCompiledEmail };
