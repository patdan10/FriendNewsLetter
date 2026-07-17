const { version } = require('../package.json');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { makeToken, parseToken, sendFormEmail, sendCompiledEmail, sendReminderEmail, sendAdminNotification, buildCompiledEmail } = require('./mailer');
const { sendFormEmails, sendCompiledEmails } = require('./scheduler');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

const MONTHS = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Auth ────────────────────────────────────────────────────────────────────

function authHash(password) {
  return crypto.createHmac('sha256', 'friendnewsletter-v1').update(password).digest('hex');
}

function parseCookies(req) {
  const list = {};
  (req.headers?.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.split('=');
    if (k?.trim()) list[k.trim()] = decodeURIComponent(v.join('=').trim());
  });
  return list;
}

function requireAuth(req, res, next) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return next();
  if (parseCookies(req).admin_auth === authHash(password)) return next();
  res.redirect('/admin/login?next=' + encodeURIComponent(req.originalUrl));
}

router.use('/admin', (req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') return next();
  requireAuth(req, res, next);
});

router.get('/admin/login', (req, res) => {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return res.redirect('/admin');
  if (parseCookies(req).admin_auth === authHash(password)) return res.redirect('/admin');
  res.send(loginPage(req.query.error, req.query.next));
});

router.post('/admin/login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminPassword && password !== adminPassword) {
    return res.redirect('/admin/login?error=1&next=' + encodeURIComponent(req.body.next || '/admin'));
  }
  const hash = authHash(password || '');
  res.setHeader('Set-Cookie', `admin_auth=${hash}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`);
  res.redirect(req.body.next || '/admin');
});

router.get('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_auth=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/admin/login');
});

// ─── Form ────────────────────────────────────────────────────────────────────

router.get('/form/:token', (req, res) => {
  try {
    const { newsletterId, email } = parseToken(req.params.token);
    const newsletter = db.getNewsletter(newsletterId);
    if (!newsletter) return res.status(404).send(errorPage('Newsletter not found'));
    const existing = db.getResponse(newsletterId, email);
    const subscriber = db.getSubscribers().find(s => s.email === email);
    const name = subscriber?.name || email;
    res.send(formPage({ newsletter, email, name, existing, token: req.params.token }));
  } catch {
    res.status(400).send(errorPage('Invalid or expired link'));
  }
});

router.post('/form/:token', upload.single('image'), (req, res) => {
  try {
    const { newsletterId, email } = parseToken(req.params.token);
    const newsletter = db.getNewsletter(newsletterId);
    if (!newsletter) return res.status(404).send(errorPage('Newsletter not found'));

    const answers = newsletter.questions.map((_, i) => (req.body[`answer_${i}`] || '').trim());
    const subscriber = db.getSubscribers().find(s => s.email === email);
    const name = subscriber?.name || email;
    const imageUrl = (req.body.image_url || '').trim();
    const imageFilename = req.file ? path.basename(req.file.path) : null;

    const linkLabels = [].concat(req.body.link_label || []);
    const linkUrls = [].concat(req.body.link_url || []);
    const links = linkUrls
      .map((url, i) => ({ url: normalizeUrl(url.trim()), label: (linkLabels[i] || '').trim() }))
      .filter(l => l.url);

    db.saveResponse({ newsletterId, email, name, answers, links, imageUrl, imageFilename });
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    sendAdminNotification({ responderName: name, newsletter, baseUrl }).catch(() => {});
    res.send(thankYouPage(MONTHS[newsletter.month - 1], newsletter.year, `${baseUrl}/form/${req.params.token}`));
  } catch (e) {
    console.error(e);
    res.status(500).send(errorPage('Error saving response: ' + e.message));
  }
});

// ─── Admin ───────────────────────────────────────────────────────────────────

function getDashboardData() {
  const now = new Date();
  const newsletter = db.getOrCreateNewsletter(now.getFullYear(), now.getMonth() + 1);
  return {
    newsletter,
    responses: db.getResponses(newsletter.id),
    subscribers: db.getSubscribers(),
    questions: db.getQuestions(),
    baseUrl: process.env.BASE_URL || 'http://localhost:3000'
  };
}

router.get('/', (req, res) => {
  res.send(dashboardPage({ ...getDashboardData(), isAdmin: false }));
});

router.get('/admin', (req, res) => {
  res.send(dashboardPage({ ...getDashboardData(), isAdmin: true }));
});

router.post('/admin/send-form', async (req, res) => {
  try {
    const result = await sendFormEmails(true);
    res.json({ success: true, message: result.message });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/admin/send-results', async (req, res) => {
  try {
    const result = await sendCompiledEmails(true);
    res.json({ success: true, message: result.message });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

function sseStream(res, fn) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  const emit = (type, text) => res.write(`data: ${JSON.stringify({ type, text })}\n\n`);
  fn(emit).catch(e => emit('err', 'Fatal: ' + e.message)).finally(() => res.end());
}

router.get('/admin/send-form/stream', (req, res) => {
  sseStream(res, async (emit) => {
    const now = new Date();
    const newsletter = db.getOrCreateNewsletter(now.getFullYear(), now.getMonth() + 1);
    const subscribers = db.getSubscribers();
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

    emit('info', `Newsletter #${newsletter.id} · ${subscribers.length} subscriber(s)`);
    if (newsletter.form_sent) emit('warn', 'Note: form emails already sent this month — resending anyway');

    let ok = 0, fail = 0;
    for (const sub of subscribers) {
      emit('sending', `→ ${sub.name} <${sub.email}>`);
      try {
        await sendFormEmail({ toEmail: sub.email, toName: sub.name, newsletter, baseUrl });
        ok++; emit('ok', `✓ ${sub.email}`);
      } catch (e) {
        fail++; emit('err', `✗ ${sub.email}: ${e.message}`);
      }
    }
    db.markFormSent(newsletter.id);
    emit('done', `Done — ${ok} sent${fail ? `, ${fail} failed` : ''}`);
  });
});

router.get('/admin/send-results/stream', (req, res) => {
  sseStream(res, async (emit) => {
    const now = new Date();
    const newsletter = db.getOrCreateNewsletter(now.getFullYear(), now.getMonth() + 1);
    const subscribers = db.getSubscribers();
    const responses = db.getResponses(newsletter.id);
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

    emit('info', `Newsletter #${newsletter.id} · ${responses.length} response(s) · sending to ${subscribers.length} subscriber(s)`);

    let ok = 0, fail = 0;
    for (const sub of subscribers) {
      emit('sending', `→ ${sub.name} <${sub.email}>`);
      try {
        await sendCompiledEmail({ toEmail: sub.email, toName: sub.name, newsletter, responses, baseUrl });
        ok++; emit('ok', `✓ ${sub.email}`);
      } catch (e) {
        fail++; emit('err', `✗ ${sub.email}: ${e.message}`);
      }
    }
    db.markResultsSent(newsletter.id);
    emit('done', `Done — ${ok} sent${fail ? `, ${fail} failed` : ''}`);
  });
});

router.get('/admin/send-reminders/stream', (req, res) => {
  sseStream(res, async (emit) => {
    const now = new Date();
    const newsletter = db.getOrCreateNewsletter(now.getFullYear(), now.getMonth() + 1);
    const responses = db.getResponses(newsletter.id);
    const respondedEmails = new Set(responses.map(r => r.email));
    const subscribers = db.getSubscribers();
    const pending = subscribers.filter(s => !respondedEmails.has(s.email));
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

    emit('info', `${pending.length} non-responder(s) of ${subscribers.length} subscriber(s)`);
    if (!pending.length) {
      emit('done', 'Everyone has responded — no reminders needed!');
      return;
    }

    let ok = 0, fail = 0;
    for (const sub of pending) {
      emit('sending', `→ ${sub.name} <${sub.email}>`);
      try {
        await sendReminderEmail({ toEmail: sub.email, toName: sub.name, newsletter, baseUrl });
        ok++; emit('ok', `✓ ${sub.email}`);
      } catch (e) {
        fail++; emit('err', `✗ ${sub.email}: ${e.message}`);
      }
    }
    emit('done', `Done — ${ok} reminder${ok !== 1 ? 's' : ''} sent${fail ? `, ${fail} failed` : ''}`);
  });
});

router.get('/admin/send-test/stream', (req, res) => {
  sseStream(res, async (emit) => {
    const now = new Date();
    const newsletter = db.getOrCreateNewsletter(now.getFullYear(), now.getMonth() + 1);
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const from = process.env.FROM_EMAIL || '';
    const m = from.match(/<([^>]+)>/) || ['', from.trim()];
    const adminEmail = m[1].trim();

    if (!adminEmail) {
      emit('err', '✗ No email found — set FROM_EMAIL in your environment');
      return;
    }

    emit('info', `Sending test emails to ${adminEmail}...`);

    emit('sending', '→ Test form email');
    try {
      await sendFormEmail({ toEmail: adminEmail, toName: 'Admin', newsletter, baseUrl });
      emit('ok', `✓ Form email sent`);
    } catch (e) {
      emit('err', `✗ Form email failed: ${e.message}`);
    }

    emit('sending', '→ Test reminder email');
    try {
      await sendReminderEmail({ toEmail: adminEmail, toName: 'Admin', newsletter, baseUrl });
      emit('ok', `✓ Reminder email sent`);
    } catch (e) {
      emit('err', `✗ Reminder email failed: ${e.message}`);
    }

    emit('sending', '→ Test compiled email');
    try {
      const responses = db.getResponses(newsletter.id);
      await sendCompiledEmail({ toEmail: adminEmail, toName: 'Admin', newsletter, responses, baseUrl });
      emit('ok', `✓ Compiled email sent`);
    } catch (e) {
      emit('err', `✗ Compiled email failed: ${e.message}`);
    }

    emit('done', `All test emails sent to ${adminEmail}`);
  });
});

router.get('/admin/responses', (req, res) => {
  const now = new Date();
  const newsletter = db.getOrCreateNewsletter(now.getFullYear(), now.getMonth() + 1);
  const responses = db.getResponses(newsletter.id);
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const html = buildCompiledEmail({ month: newsletter.month, year: newsletter.year, questions: newsletter.questions, responses, baseUrl });
  res.send(html);
});

router.get('/admin/response/:id', (req, res) => {
  const response = db.getResponseById(parseInt(req.params.id));
  if (!response) return res.status(404).send(errorPage('Response not found'));
  const newsletter = db.getNewsletter(response.newsletter_id);
  res.send(editResponsePage({ response, newsletter }));
});

router.post('/admin/response/:id', upload.single('image'), (req, res) => {
  const response = db.getResponseById(parseInt(req.params.id));
  if (!response) return res.status(404).send(errorPage('Response not found'));

  const imageUrl = (req.body.image_url || '').trim();
  const imageFilename = req.file ? path.basename(req.file.path) : (req.body.clear_image === '1' ? null : response.image_filename);

  const linkLabels = [].concat(req.body.link_label || []);
  const linkUrls = [].concat(req.body.link_url || []);
  const links = linkUrls
    .map((url, i) => ({ url: normalizeUrl(url.trim()), label: (linkLabels[i] || '').trim() }))
    .filter(l => l.url);

  db.patchResponse(response.id, { imageUrl, imageFilename, links });
  res.redirect('/admin/responses');
});

router.get('/admin/past', (req, res) => {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const all = db.getAllNewsletters();
  const past = all.filter(n => !(n.year === currentYear && n.month === currentMonth));
  res.send(pastNewslettersPage(past, true));
});

router.get('/admin/newsletter/:id', (req, res) => {
  const newsletter = db.getNewsletter(parseInt(req.params.id));
  if (!newsletter) return res.status(404).send(errorPage('Newsletter not found'));
  const responses = db.getResponses(newsletter.id);
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  res.send(buildCompiledEmail({ month: newsletter.month, year: newsletter.year, questions: newsletter.questions, responses, baseUrl }));
});

router.get('/past', (req, res) => {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const all = db.getAllNewsletters();
  const past = all.filter(n => !(n.year === currentYear && n.month === currentMonth));
  res.send(pastNewslettersPage(past, false));
});

router.get('/newsletter/:id', (req, res) => {
  const newsletter = db.getNewsletter(parseInt(req.params.id));
  if (!newsletter) return res.status(404).send(errorPage('Newsletter not found'));
  const now = new Date();
  if (newsletter.year === now.getFullYear() && newsletter.month === now.getMonth() + 1) {
    return res.status(403).send(errorPage('This month\'s newsletter hasn\'t been sent yet'));
  }
  const responses = db.getResponses(newsletter.id);
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  res.send(buildCompiledEmail({ month: newsletter.month, year: newsletter.year, questions: newsletter.questions, responses, baseUrl }));
});

router.post('/questions', (req, res) => {
  const questions = [].concat(req.body.question || []).map(q => q.trim()).filter(Boolean);
  db.saveQuestions(questions);
  res.redirect(req.get('Referer') || '/');
});

router.post('/admin/questions', (req, res) => {
  const questions = [].concat(req.body.question || []).map(q => q.trim()).filter(Boolean);
  db.saveQuestions(questions);
  res.redirect('/admin');
});

router.post('/admin/subscribers', (req, res) => {
  const { email, name, action } = req.body;
  try {
    if (action === 'add') db.addSubscriber(email.trim(), name.trim());
    else if (action === 'remove') db.removeSubscriber(email.trim());
    res.redirect('/admin');
  } catch (e) {
    res.status(400).send(errorPage(e.message));
  }
});

router.post('/admin/reset', (req, res) => {
  const now = new Date();
  const newsletter = db.getOrCreateNewsletter(now.getFullYear(), now.getMonth() + 1);
  db.resetNewsletter(newsletter.id);
  res.redirect('/admin');
});

// ─── HTML templates ──────────────────────────────────────────────────────────

const BASE_STYLE = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#f3f4f6;min-height:100vh}
`;

function formPage({ newsletter, email, name, existing, token }) {
  const monthName = MONTHS[newsletter.month - 1];
  const qs = newsletter.questions.map((q, i) => `
    <div class="qblock">
      <label class="qlabel">${i + 1}. ${esc(q)}</label>
      <textarea name="answer_${i}" rows="4" placeholder="Your answer...">${esc(existing?.answers?.[i] || '')}</textarea>
    </div>`).join('');

  const existingLinks = existing?.links || [];
  const existingLinksHtml = existingLinks.map(l => `
    <div class="link-row">
      <input type="text" name="link_label" class="link-label" placeholder="Label (e.g. Cool article)" value="${esc(l.label)}">
      <input type="text" name="link_url" class="link-url" placeholder="https://..." value="${esc(l.url)}">
      <button type="button" class="rm" onclick="this.parentElement.remove()">✕</button>
    </div>`).join('');

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${monthName} ${newsletter.year} — The Horseback Times</title>
<style>
${BASE_STYLE}
body{padding:40px 16px}
.wrap{max-width:680px;margin:0 auto}
.hdr{background:linear-gradient(135deg,#667eea,#764ba2);border-radius:16px 16px 0 0;padding:40px;text-align:center;color:#fff}
.hdr h1{font-size:26px;font-weight:700;margin-bottom:6px}
.hdr p{opacity:.85;font-size:15px}
.card{background:#fff;padding:36px;border-radius:0 0 16px 16px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
.already{background:#ecfdf5;border:2px solid #6ee7b7;border-radius:10px;padding:12px 16px;margin-bottom:24px;color:#059669;font-size:14px;font-weight:600}
.qblock{margin-bottom:28px;padding-bottom:28px;border-bottom:1px solid #f3f4f6}
.qblock:last-of-type{border-bottom:none}
.qlabel{display:block;font-weight:600;color:#374151;margin-bottom:8px;font-size:15px}
input[type=text],input[type=url],input[type=email],textarea{width:100%;padding:11px 14px;border:2px solid #e5e7eb;border-radius:10px;font-size:15px;font-family:inherit;color:#1f2937;resize:vertical}
input:focus,textarea:focus{outline:none;border-color:#667eea}
.sec{font-size:17px;font-weight:700;color:#1f2937;margin:32px 0 12px;padding-top:28px;border-top:2px solid #f3f4f6}
.sec-sub{color:#6b7280;font-size:14px;margin-bottom:14px}
.link-row{display:flex;gap:10px;margin-bottom:10px;align-items:center}
.link-label{flex:.5}
.link-url{flex:1}
.rm{background:#fee2e2;color:#dc2626;border:none;padding:9px 12px;border-radius:8px;cursor:pointer;font-size:13px;white-space:nowrap;flex-shrink:0}
.add-btn{background:#ede9fe;color:#7c3aed;border:none;padding:9px 16px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600}
.add-btn:hover{background:#ddd6fe}
.tabs{display:flex;gap:8px;margin-bottom:14px}
.tab{padding:8px 16px;border:2px solid #e5e7eb;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;color:#6b7280;background:#fff}
.tab.on{border-color:#667eea;color:#667eea;background:#f0f0ff}
.tc{display:none}.tc.on{display:block}
input[type=file]{width:100%;padding:10px;border:2px dashed #e5e7eb;border-radius:10px;cursor:pointer}
.sub-btn{width:100%;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;padding:16px;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;margin-top:28px}
.sub-btn:hover{opacity:.9}
</style></head><body>
<div class="wrap">
  <div class="hdr"><h1>The Horseback Times</h1><p>${monthName} ${newsletter.year} Update</p></div>
  <div class="card">
    ${existing ? '<div class="already">✓ You already submitted — resubmitting will update your answers.</div>' : ''}
    <p style="margin-bottom:28px;color:#6b7280;font-size:15px;">Hey <strong style="color:#1f2937">${esc(name)}</strong>! Share what's been going on in your life this month.</p>
    <form method="POST" action="/form/${token}" enctype="multipart/form-data">
      ${qs}
      <div class="sec">Share Links <span style="font-weight:400;font-size:14px;color:#9ca3af">(optional)</span></div>
      <p class="sec-sub">Articles, videos, recipes, etc...</p>
      <div id="links">${existingLinksHtml}</div>
      <button type="button" class="add-btn" onclick="addLink()">+ Add Link</button>

      <div class="sec">Share an Image <span style="font-weight:400;font-size:14px;color:#9ca3af">(optional)</span></div>
      <p class="sec-sub">A photo from your month, something that made you smile, etc...</p>
      <div class="tabs">
        <button type="button" class="tab on" onclick="tab('upload',this)">Upload file</button>
        <button type="button" class="tab" onclick="tab('url',this)">Image URL</button>
      </div>
      <div id="tc-upload" class="tc on"><input type="file" name="image" accept="image/*"></div>
      <div id="tc-url" class="tc"><input type="text" name="image_url" placeholder="https://example.com/photo.jpg" value="${esc(existing?.image_url || '')}"></div>

      <button type="submit" class="sub-btn">Submit My Update</button>
    </form>
  </div>
</div>
<script>
function addLink(){
  const c=document.getElementById('links');
  const d=document.createElement('div');d.className='link-row';
  d.innerHTML='<input type="text" name="link_label" class="link-label" placeholder="Label (e.g. Cool article)"><input type="text" name="link_url" class="link-url" placeholder="https://..."><button type="button" class="rm" onclick="this.parentElement.remove()">✕</button>';
  c.appendChild(d);d.querySelector('input').focus();
}
function tab(id,btn){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  document.querySelectorAll('.tc').forEach(t=>t.classList.remove('on'));
  btn.classList.add('on');
  document.getElementById('tc-'+id).classList.add('on');
}
</script>
<p style="text-align:center;margin-top:24px;"><a href="/admin" style="color:#d1d5db;font-size:12px;text-decoration:none;">Admin</a></p>
</body></html>`;
}

function thankYouPage(monthName, year, formUrl) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Thanks! — The Horseback Times</title>
<style>
${BASE_STYLE}
body{display:flex;align-items:center;justify-content:center;padding:16px}
.card{background:#fff;border-radius:16px;padding:60px 40px;text-align:center;max-width:440px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
.emoji{font-size:64px;margin-bottom:24px}
h1{font-size:26px;font-weight:700;color:#1f2937;margin-bottom:12px}
p{color:#6b7280;font-size:15px;line-height:1.7}
.edit-link{display:inline-block;margin-top:20px;color:#667eea;font-size:14px;font-weight:600;text-decoration:none}
</style></head><body>
<div class="card">
  <div class="emoji">🎉</div>
  <h1>Thanks for sharing!</h1>
  <p>Your ${monthName} ${year} update has been saved. It'll be compiled with everyone's responses and sent to the group on the last day of the month.</p>
  ${formUrl ? `<a href="${esc(formUrl)}" class="edit-link">Edit your answers</a>` : ''}
</div>
<p style="text-align:center;margin-top:20px;"><a href="/admin" style="color:#d1d5db;font-size:12px;text-decoration:none;">Admin</a></p>
</body></html>`;
}

function dashboardPage({ newsletter, responses, subscribers, questions, baseUrl, isAdmin }) {
  const monthName = MONTHS[newsletter.month - 1];
  const rate = subscribers.length ? Math.round((responses.length / subscribers.length) * 100) : 0;

  const subRows = subscribers.map(s => {
    const r = responses.find(r => r.email === s.email);
    const status = r ? '<span class="badge-yes">✓ Responded</span>' : '<span class="badge-no">—</span>';
    if (!isAdmin) return `
    <tr>
      <td>${esc(s.name)}</td>
      <td>${esc(s.email)}</td>
      <td>${status}</td>
    </tr>`;
    const formUrl = `${baseUrl}/form/${makeToken(newsletter.id, s.email)}`;
    return `
    <tr>
      <td>${esc(s.name)}</td>
      <td>${esc(s.email)}</td>
      <td>${status}</td>
      <td style="white-space:nowrap;">
        <button class="copy-btn" data-url="${esc(formUrl)}" title="Copy form link">🔗</button>
        ${r ? `<a href="/admin/response/${r.id}" class="edit-btn">Edit</a>` : ''}
        <form method="POST" action="/admin/subscribers" style="display:inline">
          <input type="hidden" name="email" value="${esc(s.email)}">
          <input type="hidden" name="action" value="remove">
          <button class="rm-btn" onclick="return confirm('Remove ${esc(s.name)}?')">Remove</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  const questionInputs = questions.map((q, i) => `
    <div class="q-row">
      <span class="q-num">${i + 1}.</span>
      <input type="text" name="question" value="${esc(q)}" placeholder="Question...">
      <button type="button" class="rm-btn" onclick="rmQuestion(this)">✕</button>
    </div>`).join('');

  const noQuestions = questions.length === 0
    ? '<p style="color:#dc2626;font-size:14px;margin-bottom:12px;">⚠️ No questions yet — add one below.</p>'
    : '';


  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${isAdmin ? 'Admin — ' : ''}The Horseback Times</title>
<style>
${BASE_STYLE}
body{padding:32px 16px}
.wrap{max-width:820px;margin:0 auto}
.hdr{background:linear-gradient(135deg,#667eea,#764ba2);border-radius:16px;padding:28px 32px;color:#fff;margin-bottom:20px;display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:8px;}
.hdr h1{font-size:22px;font-weight:700;margin-bottom:4px}
.hdr p{opacity:.85;font-size:14px}
.card{background:#fff;border-radius:16px;padding:24px 28px;box-shadow:0 2px 10px rgba(0,0,0,.06);margin-bottom:18px}
.card h2{font-size:16px;font-weight:700;color:#1f2937;margin-bottom:16px}
.stats{display:flex;gap:14px;flex-wrap:wrap}
.stat{flex:1;min-width:100px;background:#f9fafb;border-radius:10px;padding:14px;text-align:center}
.stat .n{font-size:30px;font-weight:700;color:#667eea}
.stat .l{font-size:12px;color:#6b7280;margin-top:3px}
.badges{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600}
.badge-sent{background:#d1fae5;color:#059669}
.badge-pend{background:#f3f4f6;color:#9ca3af}
.actions{display:flex;gap:12px;flex-wrap:wrap}
.btn{padding:11px 22px;border-radius:10px;border:none;cursor:pointer;font-size:14px;font-weight:600}
.btn-p{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}
.btn-s{background:#f3f4f6;color:#374151}
.btn:hover{opacity:.85}
#log{display:none;background:#0f172a;border-radius:10px;padding:14px 16px;margin-top:14px;font-family:'Cascadia Code','Consolas',monospace;font-size:13px;max-height:220px;overflow-y:auto;line-height:1.6}
.ll{margin:0}.li{color:#93c5fd}.ls{color:#cbd5e1}.lo{color:#6ee7b7}.le{color:#fca5a5}.lw{color:#fde68a}.ld{color:#fbbf24;font-weight:700;margin-top:4px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #f3f4f6;font-size:14px}
th{font-weight:600;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
.badge-yes{color:#059669;font-weight:600}
.badge-no{color:#d1d5db}
.rm-btn{background:#fee2e2;color:#dc2626;border:none;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:13px}
.add-form{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;padding-top:16px;border-top:1px solid #f3f4f6}
.add-form input{flex:1;min-width:140px;padding:9px 12px;border:2px solid #e5e7eb;border-radius:8px;font-size:14px;font-family:inherit}
.add-form input:focus{outline:none;border-color:#667eea}
.add-btn{background:#667eea;color:#fff;border:none;padding:9px 18px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;white-space:nowrap}
.save-btn{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;padding:9px 18px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600}
.q-row{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.q-num{color:#9ca3af;font-size:13px;min-width:20px;text-align:right;flex-shrink:0}
.q-row input{flex:1;padding:9px 12px;border:2px solid #e5e7eb;border-radius:8px;font-size:14px;font-family:inherit;color:#1f2937}
.q-row input:focus{outline:none;border-color:#667eea}
.edit-btn{background:#e0e7ff;color:#4338ca;border:none;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;text-decoration:none;margin-right:4px;}
.copy-btn{background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:13px;margin-right:4px;}
.copy-btn.copied{background:#d1fae5;color:#059669}
</style></head><body>
<div class="wrap">
  <div class="hdr">
    <div>
      <h1>The Horseback Times${isAdmin ? ' Admin' : ''}</h1>
      <p>${monthName} ${newsletter.year}${isAdmin ? ` · Newsletter #${newsletter.id}` : ''}</p>
    </div>
    ${isAdmin
      ? `<a href="/admin/logout" style="color:rgba(255,255,255,.7);font-size:13px;text-decoration:none;margin-top:4px;white-space:nowrap;">Sign out →</a>`
      : `<a href="/admin" style="color:rgba(255,255,255,.7);font-size:13px;text-decoration:none;margin-top:4px;white-space:nowrap;">Admin →</a>`}
  </div>

  <div class="card">
    <h2>This Month</h2>
    <div class="stats">
      <div class="stat"><div class="n">${subscribers.length}</div><div class="l">Subscribers</div></div>
      <div class="stat"><div class="n">${responses.length}</div><div class="l">Responses</div></div>
      <div class="stat"><div class="n">${rate}%</div><div class="l">Response Rate</div></div>
    </div>
    <div class="badges">
      <span class="badge ${newsletter.form_sent ? 'badge-sent' : 'badge-pend'}">${newsletter.form_sent ? '✓ Form emails sent' : '○ Form emails pending'}</span>
      <span class="badge ${newsletter.results_sent ? 'badge-sent' : 'badge-pend'}">${newsletter.results_sent ? '✓ Compiled results sent' : '○ Results pending'}</span>
    </div>
  </div>

  ${isAdmin ? `
  <div class="card">
    <h2>Actions</h2>
    <div class="actions">
      <button class="btn btn-p" onclick="act('send-form')">📧 Send Form Emails</button>
      <button class="btn btn-s" onclick="act('send-reminders')">⏰ Send Reminders</button>
      <button class="btn btn-s" onclick="act('send-results')">📰 Send Compiled Results</button>
      <button class="btn btn-s" onclick="act('send-test')" style="border:2px dashed #d1d5db;">🧪 Test: Send to Me</button>
    </div>
    <div id="log"></div>
  </div>` : ''}

  <div class="card">
    <h2>Subscribers</h2>
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Status</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
      <tbody>${subRows}</tbody>
    </table>
    ${isAdmin ? `
    <form method="POST" action="/admin/subscribers" class="add-form">
      <input type="hidden" name="action" value="add">
      <input type="text" name="name" placeholder="Name" required>
      <input type="email" name="email" placeholder="email@example.com" required>
      <button type="submit" class="add-btn">+ Add</button>
    </form>` : ''}
  </div>

  <div class="card">
    <h2>Questions <span style="font-weight:400;font-size:13px;color:#9ca3af">— used when next month's form is sent</span></h2>
    ${newsletter.form_sent ? '<p style="margin-bottom:14px;color:#92400e;background:#fef3c7;border-radius:8px;padding:10px 14px;font-size:13px;">⚠️ This month\'s form was already sent — changes here apply to next month.</p>' : ''}
    <form method="POST" action="${isAdmin ? '/admin/questions' : '/questions'}">
      ${noQuestions}
      <div id="q-list">${questionInputs}</div>
      <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
        <button type="button" class="add-btn" onclick="addQuestion()">+ Add Question</button>
        <button type="submit" class="save-btn">Save Questions</button>
      </div>
    </form>
  </div>

  <div style="text-align:center;padding:8px 0 16px;display:flex;justify-content:center;gap:24px;flex-wrap:wrap;">
    ${isAdmin ? `<a href="/admin/responses" style="color:#667eea;font-size:14px;text-decoration:none;font-weight:600;">View this month's responses →</a>` : ''}
    <a href="${isAdmin ? '/admin/past' : '/past'}" style="color:#9ca3af;font-size:14px;text-decoration:none;font-weight:600;">Past newsletters →</a>
  </div>

  ${isAdmin ? `
  <details style="margin-bottom:24px;">
    <summary style="cursor:pointer;font-size:13px;color:#9ca3af;text-align:center;list-style:none;user-select:none;">⚠️ Danger zone</summary>
    <div class="card" style="margin-top:10px;border:2px solid #fee2e2;">
      <h2 style="color:#dc2626;">Reset This Month</h2>
      <p style="font-size:14px;color:#6b7280;margin-bottom:16px;">Deletes all <strong>${responses.length}</strong> response${responses.length !== 1 ? 's' : ''} for ${monthName} ${newsletter.year} and marks form &amp; results as unsent. <strong>This cannot be undone.</strong></p>
      <form method="POST" action="/admin/reset" onsubmit="return confirm('Delete all ${responses.length} response(s) and reset ${monthName} ${newsletter.year}? This cannot be undone.')">
        <button type="submit" class="btn" style="background:#dc2626;color:#fff;">🗑️ Reset ${monthName} Newsletter</button>
      </form>
    </div>
  </details>` : ''}
  <p style="text-align:center;color:#d1d5db;font-size:11px;padding-bottom:24px;">v${version}</p>
</div>
<script>
function addQuestion(){
  const list=document.getElementById('q-list');
  const n=list.children.length+1;
  const d=document.createElement('div');d.className='q-row';
  d.innerHTML='<span class="q-num">'+n+'.</span><input type="text" name="question" placeholder="New question..."><button type="button" class="rm-btn" onclick="rmQuestion(this)">&#x2715;</button>';
  list.appendChild(d);d.querySelector('input').focus();
}
function rmQuestion(btn){
  btn.parentElement.remove();
  document.querySelectorAll('.q-num').forEach((el,i)=>el.textContent=(i+1)+'.');
}
${isAdmin ? `
function act(action){
  const log=document.getElementById('log');
  log.innerHTML='';log.style.display='block';
  const cls={info:'li',sending:'ls',ok:'lo',err:'le',warn:'lw',done:'ld'};
  const src=new EventSource('/admin/'+action+'/stream');
  src.onmessage=e=>{
    const {type,text}=JSON.parse(e.data);
    const p=document.createElement('p');
    p.className='ll '+(cls[type]||'ls');
    p.textContent=text;
    log.appendChild(p);
    log.scrollTop=log.scrollHeight;
    if(type==='done'){src.close();setTimeout(()=>location.reload(),2500);}
  };
  src.onerror=()=>{
    const p=document.createElement('p');p.className='ll le';p.textContent='Connection lost';
    log.appendChild(p);src.close();
  };
}
document.addEventListener('click',e=>{
  const btn=e.target.closest('.copy-btn');
  if(!btn)return;
  navigator.clipboard.writeText(btn.dataset.url).then(()=>{
    const orig=btn.textContent;
    btn.textContent='✓';btn.classList.add('copied');
    setTimeout(()=>{btn.textContent=orig;btn.classList.remove('copied');},2000);
  });
});` : ''}
</script>
</body></html>`;
}

function editResponsePage({ response, newsletter }) {
  const monthName = MONTHS[(newsletter?.month || 1) - 1];
  const year = newsletter?.year || '';
  const questions = newsletter?.questions || [];

  const answersHtml = questions.map((q, i) => `
    <div style="margin-bottom:20px;">
      <p style="font-weight:600;color:#374151;font-size:14px;margin-bottom:6px;">${i + 1}. ${esc(q)}</p>
      <p style="color:#6b7280;font-size:14px;line-height:1.6;background:#f9fafb;padding:10px 14px;border-radius:8px;white-space:pre-wrap;">${esc(response.answers?.[i] || '—')}</p>
    </div>`).join('');

  const existingLinks = (response.links || []).map(l => `
    <div class="link-row">
      <input type="text" name="link_label" class="link-label" placeholder="Label" value="${esc(l.label)}">
      <input type="text" name="link_url" class="link-url" placeholder="https://..." value="${esc(l.url)}">
      <button type="button" class="rm" onclick="this.parentElement.remove()">✕</button>
    </div>`).join('');

  const currentImg = response.image_filename
    ? `/uploads/${esc(response.image_filename)}`
    : response.image_url ? esc(response.image_url) : null;
  const currentImgHtml = currentImg
    ? `<div style="margin-bottom:12px;"><img src="${currentImg}" style="max-width:100%;max-height:200px;border-radius:8px;display:block;"><label style="display:inline-flex;align-items:center;gap:6px;margin-top:8px;font-size:13px;color:#dc2626;cursor:pointer;"><input type="checkbox" name="clear_image" value="1"> Remove current image</label></div>`
    : '';

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Edit Response — ${esc(response.name)}</title>
<style>
${BASE_STYLE}
body{padding:32px 16px}
.wrap{max-width:640px;margin:0 auto}
.hdr{background:linear-gradient(135deg,#667eea,#764ba2);border-radius:16px 16px 0 0;padding:24px 28px;color:#fff}
.hdr h1{font-size:18px;font-weight:700;margin-bottom:2px}
.hdr p{opacity:.8;font-size:13px}
.card{background:#fff;padding:28px;border-radius:0 0 16px 16px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
.sec{font-size:16px;font-weight:700;color:#1f2937;margin:24px 0 12px;padding-top:20px;border-top:2px solid #f3f4f6}
input[type=text],input[type=url]{width:100%;padding:10px 12px;border:2px solid #e5e7eb;border-radius:8px;font-size:14px;font-family:inherit}
input:focus{outline:none;border-color:#667eea}
.link-row{display:flex;gap:8px;margin-bottom:8px;align-items:center}
.link-label{flex:.5}.link-url{flex:1}
.rm{background:#fee2e2;color:#dc2626;border:none;padding:8px 10px;border-radius:6px;cursor:pointer;flex-shrink:0}
.add-btn{background:#ede9fe;color:#7c3aed;border:none;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600}
input[type=file]{width:100%;padding:10px;border:2px dashed #e5e7eb;border-radius:8px;cursor:pointer}
.tabs{display:flex;gap:8px;margin-bottom:10px}
.tab{padding:7px 14px;border:2px solid #e5e7eb;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;color:#6b7280;background:#fff}
.tab.on{border-color:#667eea;color:#667eea;background:#f0f0ff}
.tc{display:none}.tc.on{display:block}
.save-btn{width:100%;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;padding:14px;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;margin-top:24px}
.back{display:inline-block;margin-bottom:16px;color:#667eea;text-decoration:none;font-size:14px;font-weight:600}
</style></head><body>
<div class="wrap">
  <a href="/admin/responses" class="back">← Back to responses</a>
  <div class="hdr">
    <h1>Edit Response — ${esc(response.name)}</h1>
    <p>${monthName} ${year}</p>
  </div>
  <div class="card">
    <p style="font-size:13px;color:#9ca3af;margin-bottom:16px;">Answers are shown for reference. Only photos and links can be edited here.</p>
    ${answersHtml}
    <form method="POST" action="/admin/response/${response.id}" enctype="multipart/form-data">
      <div class="sec">🔗 Links</div>
      <div id="links">${existingLinks}</div>
      <button type="button" class="add-btn" onclick="addLink()">+ Add Link</button>

      <div class="sec">🖼️ Photo</div>
      ${currentImgHtml}
      <div class="tabs">
        <button type="button" class="tab on" onclick="tab('upload',this)">Upload new</button>
        <button type="button" class="tab" onclick="tab('url',this)">Image URL</button>
      </div>
      <div id="tc-upload" class="tc on"><input type="file" name="image" accept="image/*"></div>
      <div id="tc-url" class="tc"><input type="text" name="image_url" placeholder="https://example.com/photo.jpg"></div>

      <button type="submit" class="save-btn">Save Changes</button>
    </form>
  </div>
</div>
<script>
function addLink(){
  const c=document.getElementById('links');
  const d=document.createElement('div');d.className='link-row';
  d.innerHTML='<input type="text" name="link_label" class="link-label" placeholder="Label"><input type="text" name="link_url" class="link-url" placeholder="https://..."><button type="button" class="rm" onclick="this.parentElement.remove()">&#x2715;</button>';
  c.appendChild(d);d.querySelector('input').focus();
}
function tab(id,btn){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  document.querySelectorAll('.tc').forEach(t=>t.classList.remove('on'));
  btn.classList.add('on');document.getElementById('tc-'+id).classList.add('on');
}
</script>
</body></html>`;
}

function loginPage(error, next) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Login — The Horseback Times</title>
<style>
${BASE_STYLE}
body{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
.card{background:#fff;border-radius:16px;width:100%;max-width:380px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.1)}
.hdr{background:linear-gradient(135deg,#667eea,#764ba2);padding:32px;text-align:center;color:#fff}
.hdr h1{font-size:20px;font-weight:700;margin-bottom:4px}
.hdr p{opacity:.8;font-size:13px}
.body{padding:28px}
.err{background:#fef2f2;border:1px solid #fecaca;color:#dc2626;font-size:13px;padding:10px 14px;border-radius:8px;margin-bottom:16px}
label{display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px}
input[type=password]{width:100%;padding:11px 14px;border:2px solid #e5e7eb;border-radius:10px;font-size:15px;font-family:inherit}
input:focus{outline:none;border-color:#667eea}
.sub{width:100%;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;padding:13px;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;margin-top:16px}
</style></head><body>
<div class="card">
  <div class="hdr"><h1>📰 Admin Login</h1><p>The Horseback Times</p></div>
  <div class="body">
    ${error ? '<div class="err">⚠️ Incorrect password</div>' : ''}
    <form method="POST" action="/admin/login">
      <input type="hidden" name="next" value="${esc(next || '/admin')}">
      <label for="pw">Password</label>
      <input type="password" id="pw" name="password" autofocus required>
      <button type="submit" class="sub">Sign In →</button>
    </form>
  </div>
</div>
</body></html>`;
}

function pastNewslettersPage(newsletters, isAdmin) {
  const backUrl = isAdmin ? '/admin' : '/';
  const backLabel = isAdmin ? '← Back to Admin' : '← Back';
  const detailBase = isAdmin ? '/admin/newsletter' : '/newsletter';

  const rows = newsletters.length === 0
    ? '<p style="color:#9ca3af;text-align:center;padding:32px;">No past newsletters yet.</p>'
    : newsletters.map(n => {
        const monthName = MONTHS[n.month - 1];
        return `
<a href="${detailBase}/${n.id}" style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid #f3f4f6;text-decoration:none;color:inherit;background:#fff;transition:background .1s;" onmouseover="this.style.background='#f9fafb'" onmouseout="this.style.background='#fff'">
  <div>
    <p style="margin:0;font-weight:600;color:#1f2937;font-size:15px;">${monthName} ${n.year}</p>
    <p style="margin:2px 0 0;font-size:12px;color:#9ca3af;">Newsletter #${n.id}</p>
  </div>
  <div style="display:flex;gap:8px;align-items:center;">
    ${n.results_sent ? '<span style="background:#d1fae5;color:#059669;font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;">Sent</span>' : '<span style="background:#f3f4f6;color:#9ca3af;font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;">Not sent</span>'}
    <span style="color:#9ca3af;font-size:16px;">→</span>
  </div>
</a>`;
      }).join('');

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Past Newsletters — The Horseback Times</title>
<style>${BASE_STYLE} body{padding:32px 16px} .wrap{max-width:620px;margin:0 auto}</style>
</head><body>
<div class="wrap">
  <a href="${backUrl}" style="display:inline-block;margin-bottom:20px;color:#667eea;font-size:14px;font-weight:600;text-decoration:none;">${backLabel}</a>
  <div style="background:linear-gradient(135deg,#667eea,#764ba2);border-radius:16px 16px 0 0;padding:24px 28px;color:#fff;">
    <h1 style="margin:0;font-size:20px;font-weight:700;">Past Newsletters</h1>
    <p style="margin:4px 0 0;opacity:.8;font-size:13px;">${newsletters.length} previous edition${newsletters.length !== 1 ? 's' : ''}</p>
  </div>
  <div style="background:#fff;border-radius:0 0 16px 16px;box-shadow:0 4px 20px rgba(0,0,0,.08);overflow:hidden;">${rows}</div>
  <p style="text-align:center;color:#d1d5db;font-size:11px;padding:16px 0;">v${version}</p>
</div>
</body></html>`;
}

function errorPage(msg) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center;">
<h2 style="color:#dc2626">⚠️ ${esc(msg)}</h2></body></html>`;
}

function normalizeUrl(url) {
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) return 'https://' + url;
  return url;
}

module.exports = router;
