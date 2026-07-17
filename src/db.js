const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_DB = {
  subscribers: [],
  questions: [],
  newsletters: [],
  responses: [],
  comments: [],
  _nextId: { newsletter: 1, response: 1, comment: 1 }
};

// ─── CSV migration helper (read-only, used once) ──────────────────────────────

function _csvMigrate(file) {
  const candidates = [path.join(DATA_DIR, file), path.join(__dirname, '..', file)];
  const src = candidates.find(f => fs.existsSync(f));
  if (!src) return [];
  try {
    const lines = fs.readFileSync(src, 'utf8').trim().split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
    return lines.slice(1).map(line => {
      const vals = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
        else if (c === ',' && !inQ) { vals.push(cur); cur = ''; }
        else cur += c;
      }
      vals.push(cur);
      return Object.fromEntries(headers.map((h, i) => [h, (vals[i] || '').replace(/^"|"$/g, '').trim()]));
    });
  } catch { return []; }
}

// ─── JSON db ──────────────────────────────────────────────────────────────────

function load() {
  let db;
  if (!fs.existsSync(DB_FILE)) {
    db = JSON.parse(JSON.stringify(DEFAULT_DB));
  } else {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }

  let dirty = false;

  if (!Array.isArray(db.subscribers)) {
    db.subscribers = _csvMigrate('subscribers.csv')
      .filter(r => r.email)
      .map(r => ({ name: r.name || '', email: r.email }));
    dirty = true;
  }

  if (!Array.isArray(db.questions)) {
    db.questions = _csvMigrate('questions.csv').map(r => r.question).filter(Boolean);
    dirty = true;
  }

  if (dirty) save(db);
  return db;
}

function save(data) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function withDb(fn) {
  const data = load();
  const result = fn(data);
  save(data);
  return result;
}

// ─── Subscribers ──────────────────────────────────────────────────────────────

module.exports = {
  getSubscribers() {
    return load().subscribers.filter(s => s.email);
  },

  addSubscriber(email, name) {
    withDb(db => {
      const existing = db.subscribers.find(s => s.email === email);
      if (existing) existing.name = name;
      else db.subscribers.push({ name: name || '', email });
    });
  },

  removeSubscriber(email) {
    withDb(db => { db.subscribers = db.subscribers.filter(s => s.email !== email); });
  },

  // ─── Questions ──────────────────────────────────────────────────────────────

  getQuestions() {
    return load().questions.filter(Boolean);
  },

  saveQuestions(questions) {
    withDb(db => { db.questions = questions.filter(Boolean); });
  },

  // ─── Newsletters ────────────────────────────────────────────────────────────

  getOrCreateNewsletter(year, month) {
    const db = load();
    let nl = db.newsletters.find(n => n.year === year && n.month === month);
    if (nl) return { ...nl };

    const questions = db.questions.filter(Boolean);
    nl = { id: db._nextId.newsletter++, year, month, questions, form_sent: false, results_sent: false };
    db.newsletters.push(nl);
    save(db);
    return { ...nl };
  },

  getNewsletter(id) {
    return load().newsletters.find(n => n.id === id) || null;
  },

  markFormSent(id) {
    withDb(db => { const nl = db.newsletters.find(n => n.id === id); if (nl) nl.form_sent = true; });
  },

  updateNewsletterQuestions(id, questions) {
    withDb(db => { const nl = db.newsletters.find(n => n.id === id); if (nl) nl.questions = questions; });
  },

  markResultsSent(id) {
    withDb(db => { const nl = db.newsletters.find(n => n.id === id); if (nl) nl.results_sent = true; });
  },

  // ─── Responses ──────────────────────────────────────────────────────────────

  saveResponse({ newsletterId, email, name, answers, links, imageUrl, imageFilename, musicUrl }) {
    withDb(db => {
      const existing = db.responses.find(r => r.newsletter_id === newsletterId && r.email === email);
      const entry = {
        newsletter_id: newsletterId, email, name: name || email,
        answers, links: links || [],
        image_url: imageUrl || null,
        image_filename: imageFilename || null,
        music_url: musicUrl || null,
        submitted_at: new Date().toISOString()
      };
      if (existing) Object.assign(existing, entry);
      else { entry.id = db._nextId.response++; db.responses.push(entry); }
    });
  },

  getResponses(newsletterId) {
    return load().responses.filter(r => r.newsletter_id === newsletterId);
  },

  getResponse(newsletterId, email) {
    return load().responses.find(r => r.newsletter_id === newsletterId && r.email === email) || null;
  },

  getAllNewsletters() {
    return load().newsletters.slice().sort((a, b) => b.year - a.year || b.month - a.month);
  },

  getResponseById(id) {
    return load().responses.find(r => r.id === id) || null;
  },

  patchResponse(id, { imageUrl, imageFilename, links, musicUrl }) {
    withDb(db => {
      const r = db.responses.find(r => r.id === id);
      if (!r) return;
      r.image_url = imageUrl || null;
      r.image_filename = imageFilename !== undefined ? imageFilename : r.image_filename;
      r.links = links || [];
      r.music_url = musicUrl || null;
    });
  },

  getComments(newsletterId) {
    return (load().comments || []).filter(c => c.newsletter_id === newsletterId);
  },

  addComment({ newsletterId, responseId, questionIndex, parentId, authorName, authorEmail, text }) {
    let comment;
    withDb(db => {
      if (!db.comments) db.comments = [];
      if (!db._nextId.comment) db._nextId.comment = 1;
      comment = {
        id: db._nextId.comment++,
        newsletter_id: newsletterId,
        response_id: responseId,
        question_index: questionIndex != null ? Number(questionIndex) : null,
        parent_id: parentId != null ? Number(parentId) : null,
        author_name: authorName,
        author_email: authorEmail || null,
        text,
        created_at: new Date().toISOString()
      };
      db.comments.push(comment);
    });
    return comment;
  },

  resetNewsletter(id) {
    withDb(db => {
      const nl = db.newsletters.find(n => n.id === id);
      if (!nl) return;
      nl.form_sent = false;
      nl.results_sent = false;
      db.responses = db.responses.filter(r => r.newsletter_id !== id);
    });
  }
};
