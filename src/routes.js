const { version } = require('../package.json');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { makeToken, parseToken, sendFormEmail, sendCompiledEmail, sendReminderEmail, sendAdminNotification, buildCompiledEmail, sendCommentNotification, setTestMode, isTestMode } = require('./mailer');
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

router.post('/form/:token', upload.array('images', 10), (req, res) => {
  try {
    const { newsletterId, email } = parseToken(req.params.token);
    const newsletter = db.getNewsletter(newsletterId);
    if (!newsletter) return res.status(404).send(errorPage('Newsletter not found'));

    const answers = newsletter.questions.map((_, i) => (req.body[`answer_${i}`] || '').trim());
    const subscriber = db.getSubscribers().find(s => s.email === email);
    const name = subscriber?.name || email;
    const imageUrl = (req.body.image_url || '').trim();
    const imageFilenames = (req.files || []).map(f => path.basename(f.path));
    const musicUrl = (req.body.music_url || '').trim();

    const linkLabels = [].concat(req.body.link_label || []);
    const linkUrls = [].concat(req.body.link_url || []);
    const links = linkUrls
      .map((url, i) => ({ url: normalizeUrl(url.trim()), label: (linkLabels[i] || '').trim() }))
      .filter(l => l.url);

    db.saveResponse({ newsletterId, email, name, answers, links, imageUrl, imageFilenames, musicUrl });
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
  res.send(dashboardPage({ ...getDashboardData(), isAdmin: true, testMode: isTestMode() }));
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
    const currentQuestions = db.getQuestions();
    db.updateNewsletterQuestions(newsletter.id, currentQuestions);
    newsletter.questions = currentQuestions;
    const subscribers = db.getSubscribers();
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

    emit('info', `Newsletter #${newsletter.id} · ${subscribers.length} subscriber(s) · ${currentQuestions.length} question(s)`);
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

const TEST_EMAIL = process.env.TEST_EMAIL || 'patrick@danielsonweb.com';
const TEST_NAME = 'Patrick';

router.post('/admin/test-mode', (req, res) => {
  const enable = req.body.enable === 'true' || req.body.enable === true;
  setTestMode(enable);
  res.json({ testMode: isTestMode() });
});

router.get('/admin/send-test/:type/stream', (req, res) => {
  const type = req.params.type;
  sseStream(res, async (emit) => {
    const now = new Date();
    const newsletter = db.getOrCreateNewsletter(now.getFullYear(), now.getMonth() + 1);
    const currentQuestions = db.getQuestions();
    db.updateNewsletterQuestions(newsletter.id, currentQuestions);
    newsletter.questions = currentQuestions;
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

    emit('info', `Sending to ${TEST_EMAIL}...`);

    if (type === 'form' || type === 'all') {
      emit('sending', '→ Form email');
      try {
        await sendFormEmail({ toEmail: TEST_EMAIL, toName: TEST_NAME, newsletter, baseUrl });
        emit('ok', '✓ Form email sent');
      } catch (e) { emit('err', `✗ Form email: ${e.message}`); }
    }

    if (type === 'reminder' || type === 'all') {
      emit('sending', '→ Reminder email');
      try {
        await sendReminderEmail({ toEmail: TEST_EMAIL, toName: TEST_NAME, newsletter, baseUrl });
        emit('ok', '✓ Reminder email sent');
      } catch (e) { emit('err', `✗ Reminder email: ${e.message}`); }
    }

    if (type === 'results' || type === 'all') {
      emit('sending', '→ Compiled results email');
      try {
        const responses = db.getResponses(newsletter.id);
        await sendCompiledEmail({ toEmail: TEST_EMAIL, toName: TEST_NAME, newsletter, responses, baseUrl });
        emit('ok', `✓ Results email sent (${responses.length} response${responses.length !== 1 ? 's' : ''} included)`);
      } catch (e) { emit('err', `✗ Results email: ${e.message}`); }
    }

    if (type === 'comment' || type === 'all') {
      emit('sending', '→ Comment notification email');
      try {
        sendCommentNotification({
          subscribers: [{ email: TEST_EMAIL, name: TEST_NAME }],
          commenterEmail: null,
          commenterName: 'Test Commenter',
          commentText: 'This is what a comment notification email looks like!',
          questionText: newsletter.questions[0] || 'What was your highlight this month?',
          responderName: 'Test Responder',
          newsletter,
          baseUrl,
          parentCommentAuthor: null
        });
        emit('ok', '✓ Comment notification queued');
      } catch (e) { emit('err', `✗ Comment notification: ${e.message}`); }
    }

    if (!['form', 'reminder', 'results', 'comment', 'all'].includes(type)) {
      emit('err', `Unknown test type: ${type}`);
    }

    emit('done', 'Done');
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
  const existingFilenames = response.image_filenames && response.image_filenames.length
    ? response.image_filenames
    : (response.image_filename ? [response.image_filename] : []);
  const imageFilenames = req.file ? [path.basename(req.file.path)]
    : (req.body.clear_image === '1' ? [] : existingFilenames);

  const linkLabels = [].concat(req.body.link_label || []);
  const linkUrls = [].concat(req.body.link_url || []);
  const links = linkUrls
    .map((url, i) => ({ url: normalizeUrl(url.trim()), label: (linkLabels[i] || '').trim() }))
    .filter(l => l.url);

  const musicUrl = (req.body.music_url || '').trim();
  db.patchResponse(response.id, { imageUrl, imageFilenames, links, musicUrl });
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
  const comments = db.getComments(newsletter.id);
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  res.send(newsletterViewPage({ newsletter, responses, comments, token: null, viewerName: '', isAdmin: true, baseUrl }));
});

router.get('/past', (req, res) => {
  const all = db.getAllNewsletters();
  const published = all.filter(n => n.results_sent);
  res.send(pastNewslettersPage(published, false));
});

router.get('/newsletter/:id', (req, res) => {
  const newsletter = db.getNewsletter(parseInt(req.params.id));
  if (!newsletter) return res.status(404).send(errorPage('Newsletter not found'));
  if (!newsletter.results_sent) return res.status(403).send(errorPage('This newsletter hasn\'t been published yet'));
  const responses = db.getResponses(newsletter.id);
  const comments = db.getComments(newsletter.id);
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const token = req.query.token || null;
  let viewerName = '';
  if (token) {
    try {
      const { newsletterId, email } = parseToken(token);
      if (newsletterId === newsletter.id) {
        const sub = db.getSubscribers().find(s => s.email === email);
        viewerName = sub?.name || email;
      }
    } catch {}
  }
  res.send(newsletterViewPage({ newsletter, responses, comments, token, viewerName, isAdmin: false, baseUrl }));
});

router.post('/newsletter/:id/comment', (req, res) => {
  try {
    const newsletterId = parseInt(req.params.id);
    const newsletter = db.getNewsletter(newsletterId);
    if (!newsletter) return res.status(404).send(errorPage('Newsletter not found'));
    if (!newsletter.results_sent) return res.status(403).send(errorPage('Newsletter not published yet'));

    const { author_name, text, response_id, question_index, parent_id, token } = req.body;
    if (!author_name?.trim() || !text?.trim()) return res.status(400).send(errorPage('Name and comment text are required'));

    let authorEmail = null;
    if (token) {
      try {
        const parsed = parseToken(token);
        if (parsed.newsletterId === newsletterId) authorEmail = parsed.email;
      } catch {}
    }

    const allComments = db.getComments(newsletterId);
    const parentComment = parent_id ? allComments.find(c => c.id === parseInt(parent_id)) : null;

    db.addComment({
      newsletterId,
      responseId: parseInt(response_id),
      questionIndex: parseInt(question_index),
      parentId: parent_id ? parseInt(parent_id) : null,
      authorName: author_name.trim(),
      authorEmail,
      text: text.trim()
    });

    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const subscribers = db.getSubscribers();
    const response = db.getResponses(newsletterId).find(r => r.id === parseInt(response_id));
    const qi = parseInt(question_index);
    const questionText = qi === -1 ? 'their photo'
      : qi === -2 ? 'their music'
      : qi === -3 ? 'their links'
      : (newsletter.questions || [])[qi] || '';
    sendCommentNotification({
      subscribers,
      commenterEmail: authorEmail,
      commenterName: author_name.trim(),
      commentText: text.trim(),
      questionText,
      responderName: response?.name || '',
      newsletter,
      baseUrl,
      parentCommentAuthor: parentComment?.author_name || null
    }).catch(e => console.error('Comment notification error:', e));

    const redirectToken = token ? `?token=${encodeURIComponent(token)}` : '';
    res.redirect(`/newsletter/${newsletterId}${redirectToken}#q${question_index}-r${response_id}`);
  } catch (e) {
    console.error(e);
    res.status(500).send(errorPage('Error posting comment: ' + e.message));
  }
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

// ─── Music search ────────────────────────────────────────────────────────────

let _spotifyToken = null;
let _spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (_spotifyToken && Date.now() < _spotifyTokenExpiry) return _spotifyToken;
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
  try {
    const creds = Buffer.from(`${id}:${secret}`).toString('base64');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    if (!r.ok) return null;
    const d = await r.json();
    _spotifyToken = d.access_token;
    _spotifyTokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
    return _spotifyToken;
  } catch { return null; }
}



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

  const existingMusic = (() => {
    if (!existing?.music_url) return null;
    if (existing.music_url.startsWith('{')) {
      try { return JSON.parse(existing.music_url); } catch (e) {}
    }
    return { title: 'Music linked', artist: '', image: '' };
  })();

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
input[type=file]{width:100%;padding:10px;border:2px dashed #e5e7eb;border-radius:10px;cursor:pointer}
.img-url-input{display:block;width:100%;box-sizing:border-box;padding:10px 14px;border:2px solid #e5e7eb;border-radius:10px;font-size:14px;font-family:inherit;color:#1f2937;outline:none;transition:border-color .15s;margin-top:12px}
.img-url-input:focus{border-color:#667eea;box-shadow:0 0 0 3px rgba(102,126,234,.1)}
.img-url-label{display:block;font-size:13px;color:#6b7280;margin-top:14px;margin-bottom:4px}
.sub-btn{width:100%;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;padding:16px;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;margin-top:28px}
.sub-btn:hover{opacity:.9}
.msearch-wrap{display:flex;align-items:center;gap:8px;background:#fff;border:2px solid #e5e7eb;border-radius:12px;padding:6px 14px}
.msearch-wrap:focus-within{border-color:#667eea;box-shadow:0 0 0 3px rgba(102,126,234,.1)}
.msearch-icon{color:#9ca3af;font-size:18px;flex-shrink:0;user-select:none}
.msearch-input{flex:1;border:none;outline:none;font-size:15px;font-family:inherit;color:#1f2937;padding:6px 0;background:transparent;min-width:0}
.msearch-input::placeholder{color:#9ca3af}
.msearch-status{color:#9ca3af;font-size:12px;flex-shrink:0;white-space:nowrap}
.mres-list{margin-top:6px;max-height:320px;overflow-y:auto;border-radius:10px}
.mres-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;cursor:pointer;border:2px solid transparent;background:#f9fafb;margin-bottom:4px}
.mres-item:hover,.mres-item.focus{border-color:#667eea;background:#f0f0ff}
.mres-art{width:48px;height:48px;border-radius:7px;object-fit:cover;flex-shrink:0;background:#e5e7eb}
.mres-info{flex:1;min-width:0}
.mres-title{margin:0 0 2px;font-weight:600;color:#1f2937;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mres-sub{margin:0;color:#6b7280;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mres-msg{color:#9ca3af;font-size:14px;text-align:center;padding:14px 0}
.mpick-card{display:flex;align-items:center;gap:14px;background:#f0f0ff;border:2px solid #667eea;border-radius:12px;padding:14px 16px}
.mpick-art{width:54px;height:54px;border-radius:8px;object-fit:cover;flex-shrink:0;background:#ddd6fe}
.mpick-text{flex:1;min-width:0}
.mpick-title{margin:0 0 3px;font-weight:700;color:#1f2937;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mpick-artist{margin:0;color:#6b7280;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mpick-actions{display:flex;flex-direction:column;gap:6px;flex-shrink:0}
.mpick-change{background:#ede9fe;color:#7c3aed;border:none;padding:6px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
.mpick-change:hover{background:#ddd6fe}
.mpick-remove{background:none;border:none;color:#9ca3af;font-size:12px;cursor:pointer;padding:4px;white-space:nowrap}
.mpick-remove:hover{color:#ef4444}
.upload-btn{display:inline-flex;align-items:center;gap:8px;background:#fff;border:2px dashed #d1d5db;border-radius:10px;padding:12px 20px;font-size:14px;font-weight:600;color:#374151;cursor:pointer;font-family:inherit;transition:border-color .15s,background .15s}
.upload-btn:hover{border-color:#667eea;background:#f5f3ff;color:#667eea}
.upload-count{font-size:13px;color:#6b7280;margin-top:6px}
.img-thumb-wrap{position:relative;width:100px;height:100px;border-radius:8px;background:#f3f4f6;flex-shrink:0;overflow:hidden}
.img-thumb{width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .15s}
.img-thumb.loaded{opacity:1}
.img-thumb-spin{position:absolute;top:50%;left:50%;width:22px;height:22px;margin:-11px 0 0 -11px;border:3px solid #e5e7eb;border-top-color:#667eea;border-radius:50%;animation:img-spin .8s linear infinite}
@keyframes img-spin{to{transform:rotate(360deg)}}
.img-thumb-rm{position:absolute;top:4px;right:4px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;border:none;cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center;padding:0;line-height:1}
.img-thumb-rm:hover{background:rgba(0,0,0,.85)}
</style></head><body>
<div class="wrap">
  <div class="hdr"><h1>The Horseback Times</h1><p>${monthName} ${newsletter.year} Update</p></div>
  <div class="card">
    ${existing ? '<div class="already">✓ You already submitted — resubmitting will update your answers.</div>' : ''}
    <p style="margin-bottom:28px;color:#6b7280;font-size:15px;">Hey <strong style="color:#1f2937">${esc(name)}</strong>! Share what's been going on for you this month!</p>
    <form method="POST" action="/form/${token}" enctype="multipart/form-data">
      ${qs}
      <div class="sec">Share Links <span style="font-weight:400;font-size:14px;color:#9ca3af">(optional)</span></div>
      <p class="sec-sub">Articles, videos, recipes, etc...</p>
      <div id="links">${existingLinksHtml}</div>
      <button type="button" class="add-btn" onclick="addLink()">+ Add Link</button>

      <div class="sec">Share an Image <span style="font-weight:400;font-size:14px;color:#9ca3af">(optional)</span></div>
      <p class="sec-sub">A photo from your month, something that made you smile, etc...</p>
      <input type="file" name="images" accept="image/*" multiple id="img-file-input" style="position:absolute;opacity:0;width:1px;height:1px;pointer-events:none">
      <label for="img-file-input" class="upload-btn">+ Choose photos</label>
      <div id="img-file-count" class="upload-count"></div>
      <label class="img-url-label" for="img-url-input">Or add an image URL</label>
      <input type="text" name="image_url" id="img-url-input" class="img-url-input" placeholder="https://example.com/photo.jpg" value="${esc(existing?.image_url || '')}">
      <div id="img-previews" style="display:none;margin-top:10px;flex-wrap:wrap;gap:8px"></div>

      <div class="sec">Share Music <span style="font-weight:400;font-size:14px;color:#9ca3af">(optional)</span></div>
      <input type="hidden" name="music_url" id="music-url-val" value="${esc(existing?.music_url || '')}">

      <div id="music-picked" style="display:${existingMusic ? 'block' : 'none'}">
        <div class="mpick-card">
          <img id="mpick-art" class="mpick-art" src="${esc(existingMusic?.image || '')}" onerror="this.src=''" style="opacity:${existingMusic?.image ? '1' : '0'}">
          <div class="mpick-text">
            <p id="mpick-title" class="mpick-title">${esc(existingMusic?.title || '')}</p>
            <p id="mpick-artist" class="mpick-artist">${esc(existingMusic?.artist || '')}</p>
          </div>
          <div class="mpick-actions">
            <button type="button" class="mpick-change" onclick="musicChange()">Change</button>
            <button type="button" class="mpick-remove" onclick="musicClear()">Remove</button>
          </div>
        </div>
      </div>

      <div id="music-search-area" style="display:${existingMusic ? 'none' : 'block'}">
        <div class="msearch-wrap">
          <span class="msearch-icon">&#9835;</span>
          <input type="text" id="music-q" class="msearch-input" placeholder="Search for a song or artist..." autocomplete="off" spellcheck="false" oninput="musicInput(this.value)">
          <span id="music-status" class="msearch-status"></span>
        </div>
        <div id="music-results" class="mres-list"></div>
      </div>

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
var _mhits=[],_mTimer=null,_mSeq=0;
var _imgFileDataUrls=[],_accFiles=[];
function imgShowPreviews(urls){
  var w=document.getElementById('img-previews');
  if(!w)return;
  w.innerHTML='';
  var visible=(urls||[]).filter(Boolean);
  if(!visible.length){w.style.display='none';return;}
  visible.forEach(function(src,i){
    var wrap=document.createElement('div');wrap.className='img-thumb-wrap';
    var spin=document.createElement('div');spin.className='img-thumb-spin';
    var img=document.createElement('img');img.className='img-thumb';
    img.onload=function(){img.classList.add('loaded');spin.style.display='none';};
    img.onerror=function(){wrap.parentNode&&wrap.parentNode.removeChild(wrap);};
    img.src=src;
    var rm=document.createElement('button');rm.type='button';rm.className='img-thumb-rm';rm.textContent='✕';
    rm.setAttribute('data-i',i);
    rm.addEventListener('click',function(){imgRemove(Number(this.getAttribute('data-i')));});
    wrap.appendChild(spin);wrap.appendChild(img);wrap.appendChild(rm);w.appendChild(wrap);
  });
  w.style.display='flex';
}
function imgRefreshPreviews(){
  var urlEl=document.getElementById('img-url-input');
  var urlVal=urlEl&&urlEl.value.trim();
  imgShowPreviews(_imgFileDataUrls.concat(urlVal?[urlVal]:[]));
}
function imgRemove(i){
  if(i<_imgFileDataUrls.length){
    _imgFileDataUrls.splice(i,1);
    _accFiles.splice(i,1);
    var inp=document.getElementById('img-file-input');
    var dt=new DataTransfer();
    _accFiles.forEach(function(f){dt.items.add(f);});
    inp.files=dt.files;
    var countEl=document.getElementById('img-file-count');
    if(countEl)countEl.textContent=_accFiles.length?_accFiles.length+' photo'+(_accFiles.length===1?'':'s')+' selected':'';
  }else{
    var urlEl=document.getElementById('img-url-input');
    if(urlEl)urlEl.value='';
  }
  imgRefreshPreviews();
}
document.getElementById('img-file-input').addEventListener('change',function(){
  var newFiles=Array.prototype.slice.call(this.files||[]);
  if(!newFiles.length)return;
  _accFiles=_accFiles.concat(newFiles);
  var dt=new DataTransfer();
  _accFiles.forEach(function(f){dt.items.add(f);});
  this.files=dt.files;
  var countEl=document.getElementById('img-file-count');
  if(countEl)countEl.textContent=_accFiles.length+' photo'+(_accFiles.length===1?'':'s')+' selected';
  var nc=newFiles.length,nr=new Array(nc),done=0;
  newFiles.forEach(function(file,i){
    var r=new FileReader();
    r.onload=function(e){nr[i]=e.target.result;if(++done===nc){_imgFileDataUrls=_imgFileDataUrls.concat(nr);imgRefreshPreviews();}};
    r.readAsDataURL(file);
  });
});
var _imgUrlTimer=null;
document.getElementById('img-url-input').addEventListener('input',function(){
  clearTimeout(_imgUrlTimer);
  _imgUrlTimer=setTimeout(imgRefreshPreviews,400);
});
(function(){imgRefreshPreviews();})();
document.getElementById('music-q').addEventListener('keydown',function(e){if(e.key==='Enter')e.preventDefault();});
function musicInput(val){
  clearTimeout(_mTimer);
  var q=val.trim();
  if(!q){setMusicStatus('');document.getElementById('music-results').innerHTML='';return;}
  if(q.length<2){setMusicStatus('Keep typing...');document.getElementById('music-results').innerHTML='';return;}
  setMusicStatus('Searching...');
  _mTimer=setTimeout(function(){musicSearch(q);},380);
}
function musicRender(hits){
  var el=document.getElementById('music-results');
  if(!hits.length){el.innerHTML='<p class="mres-msg">No results. Try a different search.</p>';return;}
  var out='';
  hits.forEach(function(r,i){
    out+='<div class="mres-item" tabindex="0" data-i="'+i+'">'
      +'<img class="mres-art" src="'+mesc(r.image||'')+'" onerror="this.style.opacity=0">'
      +'<div class="mres-info">'
      +'<p class="mres-title">'+mesc(r.title)+'</p>'
      +'<p class="mres-sub">'+mesc(r.artist||'')+(r.album?' &middot; '+mesc(r.album):'')+'</p>'
      +'</div></div>';
  });
  el.innerHTML=out;
  el.querySelectorAll('.mres-item').forEach(function(item){
    var i=+item.dataset.i;
    item.addEventListener('click',function(){musicPick(i);});
    item.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();musicPick(i);}});
  });
}
function timedFetch(url,opts,ms){
  var ctrl=new AbortController();
  var t=setTimeout(function(){ctrl.abort();},ms||5000);
  return fetch(url,Object.assign({},opts,{signal:ctrl.signal})).finally(function(){clearTimeout(t);});
}
async function musicSearch(q){
  var seq=++_mSeq;
  var hits=[];
  try{
    var resp=await timedFetch('https://itunes.apple.com/search?term='+encodeURIComponent(q)+'&media=music&entity=song&limit=8',{},5000);
    if(resp.ok){
      var data=await resp.json();
      hits=(data.results||[]).map(function(t){return{title:t.trackName,artist:t.artistName,album:t.collectionName||'',image:(t.artworkUrl100||'').replace('100x100bb','300x300bb')};});
    }
  }catch(e){}
  if(seq!==_mSeq)return;
  if(hits.length){setMusicStatus('');_mhits=hits;musicRender(hits);return;}
  setMusicStatus('Trying backup...');
  try{
    var resp2=await timedFetch('https://musicbrainz.org/ws/2/recording/?query='+encodeURIComponent(q)+'&fmt=json&limit=8',{headers:{Accept:'application/json'}},5000);
    if(resp2.ok){
      var data2=await resp2.json();
      hits=(data2.recordings||[]).map(function(rec){
        var rel=(rec.releases||[])[0];
        var rgid=rel&&rel['release-group']&&rel['release-group'].id;
        return{title:rec.title||'',artist:(rec['artist-credit']&&rec['artist-credit'][0]&&rec['artist-credit'][0].artist&&rec['artist-credit'][0].artist.name)||'',album:rel&&rel.title||'',image:rgid?'https://coverartarchive.org/release-group/'+rgid+'/front-250':''};
      });
    }
  }catch(e){}
  if(seq!==_mSeq)return;
  setMusicStatus('');
  _mhits=hits;
  if(hits.length)musicRender(hits);
  else document.getElementById('music-results').innerHTML='<p class="mres-msg">No results. Try a different search.</p>';
}
function musicPick(i){
  var r=_mhits[i];
  document.getElementById('music-url-val').value=JSON.stringify({title:r.title,artist:r.artist||'',image:r.image||''});
  var art=document.getElementById('mpick-art');
  art.src=r.image||'';
  art.style.opacity=r.image?'1':'0';
  document.getElementById('mpick-title').textContent=r.title;
  document.getElementById('mpick-artist').textContent=r.artist||'';
  document.getElementById('music-picked').style.display='block';
  document.getElementById('music-search-area').style.display='none';
}
function musicChange(){
  document.getElementById('music-picked').style.display='none';
  document.getElementById('music-search-area').style.display='block';
  var q=document.getElementById('music-q');
  q.value='';
  document.getElementById('music-results').innerHTML='';
  setMusicStatus('');
  q.focus();
}
function musicClear(){
  document.getElementById('music-url-val').value='';
  document.getElementById('music-picked').style.display='none';
  document.getElementById('music-search-area').style.display='block';
  document.getElementById('music-q').value='';
  document.getElementById('music-results').innerHTML='';
  setMusicStatus('');
  document.getElementById('music-q').focus();
}
function setMusicStatus(msg){document.getElementById('music-status').textContent=msg;}
function mesc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
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

function dashboardPage({ newsletter, responses, subscribers, questions, baseUrl, isAdmin, testMode = false }) {
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
    <div class="q-row" draggable="true">
      <span class="drag-handle">⠿</span>
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
#log,#test-log{display:none;background:#0f172a;border-radius:10px;padding:14px 16px;margin-top:14px;font-family:'Cascadia Code','Consolas',monospace;font-size:13px;max-height:220px;overflow-y:auto;line-height:1.6}
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
.drag-handle{color:#d1d5db;cursor:grab;font-size:18px;padding:0 2px;user-select:none;flex-shrink:0;line-height:1}
.drag-handle:active{cursor:grabbing}
.q-row.drag-over{border-top:2px solid #667eea;margin-top:-2px}
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
  ${testMode ? `<div style="background:#fef3c7;border:2px solid #f59e0b;border-radius:12px;padding:14px 20px;margin-bottom:20px;display:flex;align-items:center;gap:12px;">
    <span style="font-size:20px;">⚠️</span>
    <div>
      <strong style="color:#92400e;">Test Mode is ON</strong>
      <span style="color:#78350f;font-size:14px;margin-left:8px;">All emails redirect to ${TEST_EMAIL}</span>
    </div>
    <button class="btn" onclick="toggleTestMode(false)" style="margin-left:auto;background:#f59e0b;color:#fff;padding:8px 16px;">Disable</button>
  </div>` : ''}
  <div class="card">
    <h2>Actions</h2>
    <div class="actions">
      <button class="btn btn-p" onclick="act('send-form')">📧 Send Form Emails</button>
      <button class="btn btn-s" onclick="act('send-reminders')">⏰ Send Reminders</button>
      <button class="btn btn-s" onclick="act('send-results')">📰 Send Compiled Results</button>
    </div>
    <div id="log"></div>
  </div>
  <div class="card">
    <h2>Test Emails</h2>
    <p style="color:#6b7280;font-size:14px;margin:0 0 16px;">Send samples to <strong>${TEST_EMAIL}</strong>. Enable Test Mode to redirect ALL outgoing emails there instead of real subscribers.</p>
    <div class="actions" style="flex-wrap:wrap;gap:8px;margin-bottom:16px;">
      <button class="btn btn-s" onclick="runTest('form')" style="border:2px dashed #a78bfa;">📝 Form</button>
      <button class="btn btn-s" onclick="runTest('reminder')" style="border:2px dashed #a78bfa;">⏰ Reminder</button>
      <button class="btn btn-s" onclick="runTest('results')" style="border:2px dashed #a78bfa;">📰 Results</button>
      <button class="btn btn-s" onclick="runTest('comment')" style="border:2px dashed #a78bfa;">💬 Comment</button>
      <button class="btn btn-s" onclick="runTest('all')" style="border:2px dashed #a78bfa;background:#ede9fe;">🧪 All</button>
    </div>
    <div style="display:flex;align-items:center;gap:12px;padding:12px;background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;margin-bottom:12px;">
      <span style="font-size:14px;color:#374151;font-weight:600;">Test Mode - redirect all real sends</span>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-left:auto;">
        <input type="checkbox" id="testModeToggle" ${testMode ? 'checked' : ''} onchange="toggleTestMode(this.checked)" style="width:18px;height:18px;cursor:pointer;">
        <span style="font-size:14px;color:#6b7280;" id="testModeLabel">${testMode ? 'On' : 'Off'}</span>
      </label>
    </div>
    <div id="test-log"></div>
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
  const d=document.createElement('div');d.className='q-row';d.draggable=true;
  d.innerHTML='<span class="drag-handle">&#x2807;</span><span class="q-num">'+n+'.</span><input type="text" name="question" placeholder="New question..."><button type="button" class="rm-btn" onclick="rmQuestion(this)">&#x2715;</button>';
  list.appendChild(d);d.querySelector('input').focus();
}
function rmQuestion(btn){
  btn.parentElement.remove();
  document.querySelectorAll('.q-num').forEach((el,i)=>el.textContent=(i+1)+'.');
}
(function(){
  let src=null;
  const list=document.getElementById('q-list');
  list.addEventListener('dragstart',e=>{src=e.target.closest('.q-row');e.dataTransfer.effectAllowed='move';});
  list.addEventListener('dragover',e=>{
    e.preventDefault();
    const row=e.target.closest('.q-row');
    list.querySelectorAll('.q-row').forEach(r=>r.classList.remove('drag-over'));
    if(row&&row!==src)row.classList.add('drag-over');
  });
  list.addEventListener('dragleave',e=>{if(!list.contains(e.relatedTarget))list.querySelectorAll('.q-row').forEach(r=>r.classList.remove('drag-over'));});
  list.addEventListener('drop',e=>{
    e.preventDefault();
    const row=e.target.closest('.q-row');
    if(row&&row!==src){
      const rows=[...list.children];
      if(rows.indexOf(src)<rows.indexOf(row))row.after(src);else row.before(src);
      list.querySelectorAll('.q-num').forEach((el,i)=>el.textContent=(i+1)+'.');
    }
    list.querySelectorAll('.q-row').forEach(r=>r.classList.remove('drag-over'));
  });
  list.addEventListener('dragend',()=>list.querySelectorAll('.q-row').forEach(r=>r.classList.remove('drag-over')));
})();
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
function runTest(type){
  const log=document.getElementById('test-log');
  log.innerHTML='';log.style.display='block';
  const cls={info:'li',sending:'ls',ok:'lo',err:'le',warn:'lw',done:'ld'};
  const src=new EventSource('/admin/send-test/'+type+'/stream');
  src.onmessage=e=>{
    const {type:t,text}=JSON.parse(e.data);
    const p=document.createElement('p');
    p.className='ll '+(cls[t]||'ls');
    p.textContent=text;
    log.appendChild(p);
    log.scrollTop=log.scrollHeight;
    if(t==='done')src.close();
  };
  src.onerror=()=>{
    const p=document.createElement('p');p.className='ll le';p.textContent='Connection lost';
    log.appendChild(p);src.close();
  };
}
function toggleTestMode(enable){
  fetch('/admin/test-mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enable})})
    .then(r=>r.json()).then(d=>{
      const chk=document.getElementById('testModeToggle');
      const lbl=document.getElementById('testModeLabel');
      if(chk)chk.checked=d.testMode;
      if(lbl)lbl.textContent=d.testMode?'On':'Off';
      location.reload();
    });
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

  const currentImgSrcs = [
    ...(response.image_filenames && response.image_filenames.length ? response.image_filenames.map(fn => `/uploads/${esc(fn)}`) : (response.image_filename ? [`/uploads/${esc(response.image_filename)}`] : [])),
    ...(response.image_url ? [esc(response.image_url)] : [])
  ];
  const currentImgHtml = currentImgSrcs.length
    ? `<div style="margin-bottom:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start">${currentImgSrcs.map(s => `<img src="${s}" style="max-height:120px;max-width:200px;border-radius:8px;object-fit:cover">`).join('')}</div><label style="display:inline-flex;align-items:center;gap:6px;margin-bottom:12px;font-size:13px;color:#dc2626;cursor:pointer;"><input type="checkbox" name="clear_image" value="1"> Remove current image(s)</label>`
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

      <div class="sec">🎵 Music</div>
      <input type="text" name="music_url" placeholder="Spotify or Apple Music URL" value="${esc(response.music_url || '')}">

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

function newsletterViewPage({ newsletter, responses, comments, token, viewerName, isAdmin, baseUrl }) {
  const monthName = MONTHS[newsletter.month - 1];
  const personHue = name => [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch { return ''; }
  }

  function commentFormHtml({ responseId, questionIndex, parentId, placeholder }) {
    return `<form method="POST" action="/newsletter/${newsletter.id}/comment" class="c-form">
      <input type="hidden" name="response_id" value="${responseId}">
      <input type="hidden" name="question_index" value="${questionIndex}">
      ${parentId != null ? `<input type="hidden" name="parent_id" value="${parentId}">` : ''}
      ${token ? `<input type="hidden" name="token" value="${esc(token)}">` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <input type="text" name="author_name" value="${esc(viewerName)}" placeholder="Your name" required class="c-name">
        <button type="submit" class="c-submit">Post</button>
      </div>
      <textarea name="text" placeholder="${placeholder || 'Add a comment...'}" required rows="2" class="c-text"></textarea>
    </form>`;
  }

  function renderThread(threadComments, parentId, depth) {
    const children = threadComments.filter(c => c.parent_id === parentId);
    if (!children.length) return '';
    return children.map(c => {
      const subReplies = renderThread(threadComments, c.id, depth + 1);
      const replyId = `rf-${c.id}`;
      return `<div class="comment${depth > 0 ? ' c-reply' : ''}">
  <div class="c-meta">
    <strong>${esc(c.author_name)}</strong>
    <span class="c-time">${fmtDate(c.created_at)}</span>
  </div>
  <p class="c-body">${esc(c.text)}</p>
  <button type="button" class="reply-toggle" onclick="toggleEl('${replyId}')">Reply</button>
  <div id="${replyId}" style="display:none;margin-top:8px;">
    ${commentFormHtml({ responseId: c.response_id, questionIndex: c.question_index, parentId: c.id, placeholder: `Reply to ${esc(c.author_name)}...` })}
  </div>
  ${subReplies ? `<div class="c-children">${subReplies}</div>` : ''}
</div>`;
    }).join('');
  }

  const qSections = (newsletter.questions || []).map((q, qi) => {
    const answersForQ = responses.map(r => ({ r, text: (r.answers || [])[qi]?.trim() })).filter(a => a.text);
    if (!answersForQ.length) return '';
    const blocks = answersForQ.map(({ r, text }) => {
      const h = personHue(r.name || r.email);
      const threadComments = comments.filter(c => c.response_id === r.id && c.question_index === qi);
      const addId = `add-${r.id}-${qi}`;
      return `<div class="answer-block" id="q${qi}-r${r.id}">
  <p class="person-tag" style="color:hsl(${h},50%,42%);">${esc(r.name || r.email)}</p>
  <p class="answer-text">${esc(text)}</p>
  ${threadComments.length ? `<div class="thread">${renderThread(threadComments, null, 0)}</div>` : ''}
  <button type="button" class="add-comment-btn" onclick="toggleEl('${addId}')">+ Comment</button>
  <div id="${addId}" style="display:none;margin-top:8px;">
    ${commentFormHtml({ responseId: r.id, questionIndex: qi })}
  </div>
</div>`;
    }).join('');
    return `<div class="card"><h2 class="q-label">${qi + 1}. ${esc(q)}</h2>${blocks}</div>`;
  }).join('');

  function parseMusicMeta(raw) {
    if (!raw) return null;
    if (raw.startsWith('{')) {
      try { return { type: 'meta', ...JSON.parse(raw) }; } catch (e) {}
    }
    return { type: 'url', url: raw };
  }

  function musicEmbedLocal(url) {
    if (!url) return null;
    const sp = url.match(/open\.spotify\.com\/(track|album|playlist|show|episode)\/([^?&/]+)/);
    if (sp) return `https://open.spotify.com/embed/${sp[1]}/${sp[2]}`;
    if (/music\.apple\.com\//.test(url)) return url.replace('music.apple.com', 'embed.music.apple.com');
    return null;
  }

  // Photos section (question_index = -1)
  const photoResps = responses.filter(r => (r.image_filenames && r.image_filenames.length) || r.image_filename || r.image_url);
  const photoBlocks = photoResps.map(r => {
    const h = personHue(r.name || r.email);
    const imgSrcs = [
      ...(r.image_filenames && r.image_filenames.length ? r.image_filenames.map(fn => `${baseUrl}/uploads/${esc(fn)}`) : (r.image_filename ? [`${baseUrl}/uploads/${esc(r.image_filename)}`] : [])),
      ...(r.image_url ? [esc(r.image_url)] : [])
    ];
    const imgHtml = imgSrcs.map(src => `<div style="margin-bottom:10px;"><img src="${src}" alt="Photo" style="max-width:100%;border-radius:10px;display:block;"></div>`).join('');
    const threadComments = comments.filter(c => c.response_id === r.id && c.question_index === -1);
    const addId = `add-photo-${r.id}`;
    return `<div class="answer-block" id="q-1-r${r.id}">
  <p class="person-tag" style="color:hsl(${h},50%,42%);">${esc(r.name || r.email)}</p>
  ${imgHtml}
  ${threadComments.length ? `<div class="thread">${renderThread(threadComments, null, 0)}</div>` : ''}
  <button type="button" class="add-comment-btn" onclick="toggleEl('${addId}')">+ Comment</button>
  <div id="${addId}" style="display:none;margin-top:8px;">${commentFormHtml({ responseId: r.id, questionIndex: -1 })}</div>
</div>`;
  }).join('');
  const photoSection = photoBlocks ? `<div class="card"><h2 class="q-label">Photos</h2>${photoBlocks}</div>` : '';

  // Links section (question_index = -3)
  const linkResps = responses.filter(r => r.links?.length);
  const linkBlocks = linkResps.map(r => {
    const h = personHue(r.name || r.email);
    const linksHtml = `<div style="margin-bottom:4px;">${r.links.map(l => `<a href="${esc(l.url)}" style="display:inline-block;margin:3px 6px 3px 0;background:#ede9fe;color:#7c3aed;text-decoration:none;padding:5px 12px;border-radius:20px;font-size:13px;">${esc(l.label || l.url)}</a>`).join('')}</div>`;
    const threadComments = comments.filter(c => c.response_id === r.id && c.question_index === -3);
    const addId = `add-links-${r.id}`;
    return `<div class="answer-block" id="q-3-r${r.id}">
  <p class="person-tag" style="color:hsl(${h},50%,42%);">${esc(r.name || r.email)}</p>
  ${linksHtml}
  ${threadComments.length ? `<div class="thread">${renderThread(threadComments, null, 0)}</div>` : ''}
  <button type="button" class="add-comment-btn" onclick="toggleEl('${addId}')">+ Comment</button>
  <div id="${addId}" style="display:none;margin-top:8px;">${commentFormHtml({ responseId: r.id, questionIndex: -3 })}</div>
</div>`;
  }).join('');
  const linksSection = linkBlocks ? `<div class="card"><h2 class="q-label">Links</h2>${linkBlocks}</div>` : '';

  // Music section (question_index = -2)
  const musicResps = responses.filter(r => r.music_url);
  const musicBlocks = musicResps.map(r => {
    const h = personHue(r.name || r.email);
    const meta = parseMusicMeta(r.music_url);
    let musicHtml = '';
    if (meta?.type === 'meta' && meta.title) {
      const ytSearch = `https://www.youtube.com/results?search_query=${encodeURIComponent(meta.title + (meta.artist ? ' ' + meta.artist : ''))}`;
      musicHtml = `<div style="display:flex;align-items:center;gap:12px;background:#f0f0ff;border-radius:10px;padding:12px 14px;margin-bottom:8px;">
  ${meta.image ? `<img src="${esc(meta.image)}" style="width:52px;height:52px;border-radius:8px;object-fit:cover;flex-shrink:0;">` : ''}
  <div style="flex:1;min-width:0;">
    <p style="margin:0 0 2px;font-weight:600;color:#1f2937;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(meta.title)}</p>
    ${meta.artist ? `<p style="margin:0;color:#6b7280;font-size:13px;">${esc(meta.artist)}</p>` : ''}
  </div>
  <a href="${esc(ytSearch)}" target="_blank" rel="noopener" style="flex-shrink:0;background:#ef4444;color:#fff;text-decoration:none;padding:6px 12px;border-radius:20px;font-size:12px;font-weight:600;">&#9654; YouTube</a>
</div>`;
    } else if (meta?.type === 'url') {
      const embedUrl = musicEmbedLocal(meta.url);
      if (embedUrl) musicHtml = `<div style="margin-bottom:4px;"><iframe src="${esc(embedUrl)}" width="100%" height="${/track|episode/.test(embedUrl) ? 80 : 152}" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy" style="border-radius:12px;display:block;"></iframe></div>`;
    }
    const threadComments = comments.filter(c => c.response_id === r.id && c.question_index === -2);
    const addId = `add-music-${r.id}`;
    return `<div class="answer-block" id="q-2-r${r.id}">
  <p class="person-tag" style="color:hsl(${h},50%,42%);">${esc(r.name || r.email)}</p>
  ${musicHtml}
  ${threadComments.length ? `<div class="thread">${renderThread(threadComments, null, 0)}</div>` : ''}
  <button type="button" class="add-comment-btn" onclick="toggleEl('${addId}')">+ Comment</button>
  <div id="${addId}" style="display:none;margin-top:8px;">${commentFormHtml({ responseId: r.id, questionIndex: -2 })}</div>
</div>`;
  }).join('');
  const musicSection = musicBlocks ? `<div class="card"><h2 class="q-label">Music</h2>${musicBlocks}</div>` : '';

  const backUrl = isAdmin ? '/admin/past' : '/past';
  const backLabel = isAdmin ? '← Back to Admin' : '← Back';

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${monthName} ${newsletter.year} — The Horseback Times</title>
<style>
${BASE_STYLE}
body{padding:32px 16px}
.wrap{max-width:740px;margin:0 auto}
.hdr{background:linear-gradient(135deg,#667eea,#764ba2);border-radius:16px;padding:28px 32px;color:#fff;margin-bottom:20px}
.hdr h1{font-size:22px;font-weight:700;margin-bottom:4px}
.hdr p{opacity:.85;font-size:14px}
.card{background:#fff;border-radius:16px;padding:24px 28px;box-shadow:0 2px 10px rgba(0,0,0,.06);margin-bottom:18px}
.card h2{font-size:15px;font-weight:700;color:#374151;margin-bottom:18px;padding-bottom:12px;border-bottom:1px solid #f3f4f6}
.q-label{font-size:16px;color:#1f2937}
.answer-block{padding:16px 0;border-bottom:1px solid #f3f4f6}
.answer-block:last-of-type{border-bottom:none;padding-bottom:0}
.person-tag{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;margin:0 0 6px}
.answer-text{margin:0 0 12px;color:#374151;font-size:15px;line-height:1.7;white-space:pre-wrap}
.thread{margin:0 0 8px}
.comment{padding:8px 0 4px;border-top:1px solid #f3f4f6}
.c-children{margin-left:16px;border-left:2px solid #f3f4f6;padding-left:12px;margin-top:4px}
.c-meta{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.c-meta strong{font-size:13px;color:#1f2937}
.c-time{font-size:11px;color:#9ca3af}
.c-body{margin:0 0 4px;color:#374151;font-size:14px;line-height:1.5}
.reply-toggle{background:none;border:none;color:#9ca3af;font-size:12px;cursor:pointer;padding:0}
.reply-toggle:hover{color:#667eea}
.add-comment-btn{background:none;border:none;color:#667eea;font-size:13px;cursor:pointer;padding:4px 0;font-weight:600}
.c-form{display:flex;flex-direction:column;gap:6px;background:#f9fafb;border-radius:10px;padding:12px}
.c-name{flex:1;padding:8px 12px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;font-family:inherit;min-width:120px}
.c-text{padding:8px 12px;border:1px solid #e5e7eb;border-radius:8px;font-size:14px;font-family:inherit;resize:vertical}
.c-name:focus,.c-text:focus{outline:none;border-color:#667eea}
.c-submit{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
.c-submit:hover{opacity:.9}
.back-link{display:inline-block;margin-bottom:20px;color:#667eea;font-size:14px;font-weight:600;text-decoration:none}
</style></head><body>
<div class="wrap">
  <a href="${backUrl}" class="back-link">${backLabel}</a>
  <div class="hdr">
    <h1>The Horseback Times</h1>
    <p>${monthName} ${newsletter.year} Edition · ${responses.length} response${responses.length !== 1 ? 's' : ''} · ${comments.length} comment${comments.length !== 1 ? 's' : ''}</p>
  </div>
  ${qSections || '<div class="card"><p style="color:#9ca3af;text-align:center;">No questions this month.</p></div>'}
  ${photoSection}
  ${linksSection}
  ${musicSection}
  <p style="text-align:center;color:#d1d5db;font-size:11px;padding-bottom:24px;">v${version}</p>
</div>
<script>
function toggleEl(id){const el=document.getElementById(id);if(el)el.style.display=el.style.display==='none'?'block':'none';}
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
    ? '<p style="color:#9ca3af;text-align:center;padding:32px;">No newsletters published yet.</p>'
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
