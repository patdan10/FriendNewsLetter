const nodemailer = require('nodemailer');

const MONTHS = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

// ─── Sender: Brevo (HTTPS API) or Ethereal (local dev) ───────────────────────

async function sendViaBrevo({ fromName, fromEmail, toEmail, toName, subject, html }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: fromName, email: fromEmail },
      to: [{ email: toEmail, name: toName }],
      subject,
      htmlContent: html
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || JSON.stringify(data));
  console.log(`  📬 ${toEmail}: sent`);
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

function parseFrom(from) {
  const m = from.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  return m ? { fromName: m[1].trim(), fromEmail: m[2].trim() } : { fromName: 'The Horseback Times', fromEmail: from.trim() };
}

async function deliver({ toEmail, toName, subject, html }) {
  const from = process.env.FROM_EMAIL || '"The Horseback Times" <newsletter@example.com>';
  if (process.env.BREVO_API_KEY) {
    const { fromName, fromEmail } = parseFrom(from);
    return sendViaBrevo({ fromName, fromEmail, toEmail, toName, subject, html });
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
  <h1 style="margin:0;color:#fff;font-size:28px;font-weight:700;">The Horseback Times</h1>
  <p style="margin:8px 0 0;color:rgba(255,255,255,.85);font-size:16px;">${monthName} ${year}</p>
</td></tr>
<tr><td style="padding:40px;">
  <p style="margin:0 0 16px;color:#1f2937;font-size:18px;">Hey ${esc(name)}!</p>
  <p style="margin:0 0 24px;color:#6b7280;font-size:15px;line-height:1.6;">Time for the ${monthName} update.</p>
  <div style="background:#f9fafb;border-radius:12px;padding:24px;margin-bottom:28px;border:1px solid #e5e7eb;">
    <p style="margin:0 0 12px;color:#1f2937;font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:.5px;">This month's questions:</p>
    <ol style="margin:0;padding-left:20px;">${qs}</ol>
  </div>
  <div style="text-align:center;margin-bottom:32px;">
    <a href="${formUrl}" style="display:inline-block;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;text-decoration:none;padding:16px 40px;border-radius:50px;font-size:16px;font-weight:600;">Click Here For The Form</a>
  </div>
  <p style="margin:0;color:#9ca3af;font-size:13px;text-align:center;">Everyone's responses get compiled and sent out at the end of the month.</p>
</td></tr>
<tr><td style="background:#f9fafb;padding:20px;text-align:center;border-top:1px solid #e5e7eb;">
  <p style="margin:0;color:#9ca3af;font-size:12px;">The Horseback Times · Sent with ❤️</p>
</td></tr>
</table>
</td></tr>
</table></body></html>`;
}

function buildCompiledEmail({ month, year, questions, responses, baseUrl, editUrl }) {
  const monthName = MONTHS[month - 1];

  const personHue = name => [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;

  const noResp = responses.length === 0
    ? '<p style="text-align:center;color:#9ca3af;padding:40px 20px;">No responses were submitted this month.</p>'
    : '';

  // One block per question, answers from each person underneath
  const questionBlocks = (questions || []).map((q, qi) => {
    const answered = responses
      .map(r => ({ name: r.name || r.email, text: (r.answers || [])[qi]?.trim() }))
      .filter(a => a.text);
    if (!answered.length) return '';

    const rows = answered.map((a, i) => {
      const h = personHue(a.name);
      const last = i === answered.length - 1;
      return `
<div style="padding:16px 0;${last ? '' : 'border-bottom:1px solid #f3f4f6;'}">
  <p style="margin:0 0 6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:hsl(${h},50%,42%);">${esc(a.name)}</p>
  <p style="margin:0;color:#374151;font-size:15px;line-height:1.75;white-space:pre-wrap;">${esc(a.text)}</p>
</div>`;
    }).join('');

    return `
<div style="margin-bottom:24px;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#667eea,#764ba2);padding:14px 20px;">
    <p style="margin:0;color:#fff;font-size:15px;font-weight:700;">${qi + 1}. ${esc(q)}</p>
  </div>
  <div style="padding:4px 20px 6px;">${rows}</div>
</div>`;
  }).join('');

  // Photos & links grouped by person at the bottom
  const mediaRows = responses.filter(r => r.image_filename || r.image_url || r.links?.length).map((r, i, arr) => {
    const name = r.name || r.email;
    const h = personHue(name);
    const last = i === arr.length - 1;
    const imgSrc = r.image_filename ? `${baseUrl}/uploads/${esc(r.image_filename)}` : r.image_url ? esc(r.image_url) : null;
    const imgHtml = imgSrc ? `<div style="margin-bottom:10px;"><img src="${imgSrc}" alt="Photo" style="max-width:100%;border-radius:10px;display:block;"></div>` : '';
    const linksHtml = r.links?.length
      ? r.links.map(l => `<a href="${esc(l.url)}" style="display:inline-block;margin:3px 6px 3px 0;background:#ede9fe;color:#7c3aed;text-decoration:none;padding:5px 12px;border-radius:20px;font-size:13px;">🔗 ${esc(l.label || l.url)}</a>`).join('')
      : '';
    return `
<div style="padding:16px 0;${last ? '' : 'border-bottom:1px solid #f3f4f6;'}">
  <p style="margin:0 0 10px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:hsl(${h},50%,42%);">${esc(name)}</p>
  ${imgHtml}${linksHtml}
</div>`;
  }).join('');

  const mediaSection = mediaRows ? `
<div style="margin-bottom:24px;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
  <div style="background:#f9fafb;border-bottom:1px solid #e5e7eb;padding:14px 20px;">
    <p style="margin:0;color:#374151;font-size:15px;font-weight:700;">📸 Photos &amp; Links</p>
  </div>
  <div style="padding:4px 20px 6px;">${mediaRows}</div>
</div>` : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 0;">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08);">
<tr><td style="background:linear-gradient(135deg,#667eea,#764ba2);padding:40px;text-align:center;">
  <h1 style="margin:0;color:#fff;font-size:28px;font-weight:700;">The Horseback Times</h1>
  <p style="margin:8px 0 0;color:rgba(255,255,255,.85);font-size:18px;font-weight:500;">${monthName} ${year} Edition</p>
  <p style="margin:6px 0 0;color:rgba(255,255,255,.7);font-size:14px;">${responses.length} response${responses.length !== 1 ? 's' : ''} from your friends</p>
</td></tr>
<tr><td style="padding:32px 40px;">${noResp}${questionBlocks}${mediaSection}</td></tr>
<tr><td style="background:#f9fafb;padding:20px;text-align:center;border-top:1px solid #e5e7eb;">
  ${editUrl ? `<p style="margin:0 0 8px;"><a href="${editUrl}" style="color:#667eea;font-size:13px;text-decoration:none;font-weight:600;">✏️ Update your response</a></p>` : ''}
  <p style="margin:0;color:#9ca3af;font-size:12px;">The Horseback Times · ${monthName} ${year} · Sent with ❤️</p>
</td></tr>
</table>
</td></tr>
</table></body></html>`;
}

async function sendFormEmail({ toEmail, toName, newsletter, baseUrl }) {
  const token = makeToken(newsletter.id, toEmail);
  return deliver({
    toEmail, toName,
    subject: `📝 ${MONTHS[newsletter.month - 1]} ${newsletter.year} - Share your update!`,
    html: buildFormEmail({ name: toName, month: newsletter.month, year: newsletter.year, questions: newsletter.questions, formUrl: `${baseUrl}/form/${token}` })
  });
}

async function sendCompiledEmail({ toEmail, toName, newsletter, responses, baseUrl }) {
  const token = makeToken(newsletter.id, toEmail);
  const editUrl = `${baseUrl}/form/${token}`;
  return deliver({
    toEmail, toName,
    subject: `📰 ${MONTHS[newsletter.month - 1]} ${newsletter.year} The Horseback Times`,
    html: buildCompiledEmail({ month: newsletter.month, year: newsletter.year, questions: newsletter.questions, responses, baseUrl, editUrl })
  });
}

function buildReminderEmail({ name, month, year, formUrl }) {
  const monthName = MONTHS[month - 1];
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08);">
<tr><td style="background:linear-gradient(135deg,#f59e0b,#d97706);padding:40px;text-align:center;">
  <h1 style="margin:0;color:#fff;font-size:28px;font-weight:700;">⏰ Friendly Reminder</h1>
  <p style="margin:8px 0 0;color:rgba(255,255,255,.85);font-size:16px;">${monthName} ${year} Newsletter</p>
</td></tr>
<tr><td style="padding:40px;">
  <p style="margin:0 0 16px;color:#1f2937;font-size:18px;">Hey ${esc(name)}!</p>
  <p style="margin:0 0 24px;color:#6b7280;font-size:15px;line-height:1.6;">The ${monthName} newsletter goes out in <strong style="color:#1f2937;">2 days</strong> - still time to fill it out if you haven't yet!</p>
  <div style="text-align:center;margin-bottom:32px;">
    <a href="${formUrl}" style="display:inline-block;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;text-decoration:none;padding:16px 40px;border-radius:50px;font-size:16px;font-weight:600;">✍️ Fill out your update</a>
  </div>
  <p style="margin:0;color:#9ca3af;font-size:13px;text-align:center;">No worries if you're swamped - just didn't want you to miss it.</p>
</td></tr>
<tr><td style="background:#f9fafb;padding:20px;text-align:center;border-top:1px solid #e5e7eb;">
  <p style="margin:0;color:#9ca3af;font-size:12px;">The Horseback Times · Sent with ❤️</p>
</td></tr>
</table>
</td></tr>
</table></body></html>`;
}

async function sendReminderEmail({ toEmail, toName, newsletter, baseUrl }) {
  const token = makeToken(newsletter.id, toEmail);
  return deliver({
    toEmail, toName,
    subject: `⏰ Reminder: ${MONTHS[newsletter.month - 1]} newsletter goes out in 2 days!`,
    html: buildReminderEmail({ name: toName, month: newsletter.month, year: newsletter.year, formUrl: `${baseUrl}/form/${token}` })
  });
}

async function sendAdminNotification({ responderName, newsletter, baseUrl }) {
  const from = process.env.FROM_EMAIL || '';
  const m = from.match(/<([^>]+)>/) || ['', from.trim()];
  const adminEmail = m[1].trim();
  if (!adminEmail) return;
  const monthName = MONTHS[newsletter.month - 1];
  return deliver({
    toEmail: adminEmail,
    toName: 'Admin',
    subject: `🎉 ${responderName} submitted their ${monthName} response`,
    html: `<!DOCTYPE html><html><body style="font-family:'Segoe UI',Arial,sans-serif;padding:40px;max-width:500px;margin:0 auto;">
<h2 style="color:#1f2937;">New response submitted!</h2>
<p style="color:#374151;font-size:16px;margin:16px 0;"><strong>${esc(responderName)}</strong> just filled out the ${monthName} ${newsletter.year} newsletter form.</p>
<a href="${baseUrl}/admin/responses" style="display:inline-block;background:#667eea;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">View Responses</a>
</body></html>`
  });
}

module.exports = { makeToken, parseToken, sendFormEmail, sendCompiledEmail, sendReminderEmail, sendAdminNotification, buildCompiledEmail };
