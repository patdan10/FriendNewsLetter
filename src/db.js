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

// ─── JSON db ──────────────────────────────────────────────────────────────────

let _cache = null;

function load() {
  if (_cache) return _cache;
  _cache = fs.existsSync(DB_FILE)
    ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
    : JSON.parse(JSON.stringify(DEFAULT_DB));
  return _cache;
}

function save(data) {
  _cache = data;
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

  saveResponse({ newsletterId, email, name, answers, links, imageUrls, imageFilenames, musicUrl }) {
    withDb(db => {
      const existing = db.responses.find(r => r.newsletter_id === newsletterId && r.email === email);
      const entry = {
        newsletter_id: newsletterId, email, name: name || email,
        answers, links: links || [],
        image_url: null,
        image_urls: imageUrls || [],
        image_filenames: imageFilenames || [],
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

  patchResponse(id, { imageUrls, imageFilenames, links, musicUrl }) {
    withDb(db => {
      const r = db.responses.find(r => r.id === id);
      if (!r) return;
      r.image_url = null;
      r.image_urls = imageUrls || [];
      r.image_filenames = imageFilenames || [];
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
