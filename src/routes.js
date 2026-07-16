const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { parseToken } = require('./mailer');
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
    res.send(thankYouPage(MONTHS[newsletter.month - 1], newsletter.year));
  } catch (e) {
    console.error(e);
    res.status(500).send(errorPage('Error saving response: ' + e.message));
  }
});

// ─── Admin ───────────────────────────────────────────────────────────────────

router.get('/admin', (req, res) => {
  const now = new Date();
  const newsletter = db.getOrCreateNewsletter(now.getFullYear(), now.getMonth() + 1);
  const responses = db.getResponses(newsletter.id);
  const subscribers = db.getSubscribers();
  const questions = db.getQuestions();
  res.send(adminPage({ newsletter, responses, subscribers, questions }));
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
<title>${monthName} ${newsletter.year} — Friend Newsletter</title>
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
  <div class="hdr"><h1>📰 Friend Newsletter</h1><p>${monthName} ${newsletter.year} Update</p></div>
  <div class="card">
    ${existing ? '<div class="already">✓ You already submitted — resubmitting will update your answers.</div>' : ''}
    <p style="margin-bottom:28px;color:#6b7280;font-size:15px;">Hey <strong style="color:#1f2937">${esc(name)}</strong>! Share what's been going on in your life this month.</p>
    <form method="POST" action="/form/${token}" enctype="multipart/form-data">
      ${qs}
      <div class="sec">🔗 Share Links <span style="font-weight:400;font-size:14px;color:#9ca3af">(optional)</span></div>
      <p class="sec-sub">Articles, videos, recipes, tools — anything worth sharing.</p>
      <div id="links">${existingLinksHtml}</div>
      <button type="button" class="add-btn" onclick="addLink()">+ Add Link</button>

      <div class="sec">🖼️ Share an Image <span style="font-weight:400;font-size:14px;color:#9ca3af">(optional)</span></div>
      <p class="sec-sub">A photo from your month, something that made you smile, etc.</p>
      <div class="tabs">
        <button type="button" class="tab on" onclick="tab('upload',this)">Upload file</button>
        <button type="button" class="tab" onclick="tab('url',this)">Image URL</button>
      </div>
      <div id="tc-upload" class="tc on"><input type="file" name="image" accept="image/*"></div>
      <div id="tc-url" class="tc"><input type="text" name="image_url" placeholder="https://example.com/photo.jpg" value="${esc(existing?.image_url || '')}"></div>

      <button type="submit" class="sub-btn">✉️ Submit My Update</button>
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
</body></html>`;
}

function thankYouPage(monthName, year) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Thanks! — Friend Newsletter</title>
<style>
${BASE_STYLE}
body{display:flex;align-items:center;justify-content:center;padding:16px}
.card{background:#fff;border-radius:16px;padding:60px 40px;text-align:center;max-width:440px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
.emoji{font-size:64px;margin-bottom:24px}
h1{font-size:26px;font-weight:700;color:#1f2937;margin-bottom:12px}
p{color:#6b7280;font-size:15px;line-height:1.7}
</style></head><body>
<div class="card">
  <div class="emoji">🎉</div>
  <h1>Thanks for sharing!</h1>
  <p>Your ${monthName} ${year} update has been saved. It'll be compiled with everyone's responses and sent to the group on the last day of the month.</p>
</div>
</body></html>`;
}

function adminPage({ newsletter, responses, subscribers, questions }) {
  const monthName = MONTHS[newsletter.month - 1];
  const responded = new Set(responses.map(r => r.email));
  const rate = subscribers.length ? Math.round((responses.length / subscribers.length) * 100) : 0;

  const subRows = subscribers.map(s => `
    <tr>
      <td>${esc(s.name)}</td>
      <td>${esc(s.email)}</td>
      <td>${responded.has(s.email) ? '<span class="badge-yes">✓ Responded</span>' : '<span class="badge-no">—</span>'}</td>
      <td>
        <form method="POST" action="/admin/subscribers" style="display:inline">
          <input type="hidden" name="email" value="${esc(s.email)}">
          <input type="hidden" name="action" value="remove">
          <button class="rm-btn" onclick="return confirm('Remove ${esc(s.name)}?')">Remove</button>
        </form>
      </td>
    </tr>`).join('');

  const questionRows = questions.map((q, i) => `
    <tr><td style="color:#6b7280;width:28px">${i + 1}.</td><td>${esc(q)}</td></tr>`).join('');

  const noQuestions = questions.length === 0
    ? '<p style="color:#dc2626;font-size:14px;">⚠️ No questions found in questions.csv</p>'
    : '';

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — Friend Newsletter</title>
<style>
${BASE_STYLE}
body{padding:32px 16px}
.wrap{max-width:820px;margin:0 auto}
.hdr{background:linear-gradient(135deg,#667eea,#764ba2);border-radius:16px;padding:28px 32px;color:#fff;margin-bottom:20px}
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
#msg{margin-top:14px;padding:10px 14px;border-radius:8px;font-size:14px;display:none}
.msg-ok{background:#d1fae5;color:#059669}
.msg-err{background:#fee2e2;color:#dc2626}
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
</style></head><body>
<div class="wrap">
  <div class="hdr">
    <h1>📰 Friend Newsletter Admin</h1>
    <p>${monthName} ${newsletter.year} · Newsletter #${newsletter.id}</p>
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

  <div class="card">
    <h2>Actions</h2>
    <div class="actions">
      <button class="btn btn-p" onclick="act('send-form')">📧 Send Form Emails Now</button>
      <button class="btn btn-s" onclick="act('send-results')">📰 Send Compiled Results Now</button>
    </div>
    <div id="msg"></div>
    <p style="margin-top:14px;color:#9ca3af;font-size:13px;">When using Ethereal test email, preview URLs are logged to the console after sending.</p>
  </div>

  <div class="card">
    <h2>Subscribers <span style="font-weight:400;font-size:13px;color:#9ca3af">— saved to subscribers.csv</span></h2>
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Status</th><th></th></tr></thead>
      <tbody>${subRows}</tbody>
    </table>
    <form method="POST" action="/admin/subscribers" class="add-form">
      <input type="hidden" name="action" value="add">
      <input type="text" name="name" placeholder="Name" required>
      <input type="email" name="email" placeholder="email@example.com" required>
      <button type="submit" class="add-btn">+ Add</button>
    </form>
  </div>

  <div class="card">
    <h2>Questions for this month <span style="font-weight:400;font-size:13px;color:#9ca3af">— edit questions.csv to change</span></h2>
    ${noQuestions}
    <table>${questionRows}</table>
    <p style="margin-top:14px;color:#9ca3af;font-size:13px;">
      Questions are read from <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px">questions.csv</code> each time a new month starts.
      Edit that file to change next month's questions — one question per line.
      ${newsletter.form_sent ? '<br><strong style="color:#374151">This month\'s questions are already locked in (form emails were sent).</strong>' : ''}
    </p>
  </div>
</div>
<script>
async function act(action){
  const msg=document.getElementById('msg');
  msg.style.display='block';msg.className='';msg.textContent='Sending…';
  try{
    const r=await fetch('/admin/'+action,{method:'POST'});
    const d=await r.json();
    if(d.success){msg.className='msg-ok';msg.textContent='✓ '+d.message+' — check console for preview URLs';}
    else{msg.className='msg-err';msg.textContent='✗ '+d.error;}
    setTimeout(()=>location.reload(),4000);
  }catch(e){msg.className='msg-err';msg.textContent='✗ '+e.message;}
}
</script>
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
