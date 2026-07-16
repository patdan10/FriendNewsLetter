const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SUBSCRIBERS_CSV = path.join(DATA_DIR, 'subscribers.csv');
const QUESTIONS_CSV = path.join(DATA_DIR, 'questions.csv');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// On first deploy, seed from repo copies
const rootSubscribersCSV = path.join(__dirname, '..', 'subscribers.csv');
if (!fs.existsSync(SUBSCRIBERS_CSV) && fs.existsSync(rootSubscribersCSV)) {
  fs.copyFileSync(rootSubscribersCSV, SUBSCRIBERS_CSV);
}
const rootQuestionsCSV = path.join(__dirname, '..', 'questions.csv');
if (!fs.existsSync(QUESTIONS_CSV) && fs.existsSync(rootQuestionsCSV)) {
  fs.copyFileSync(rootQuestionsCSV, QUESTIONS_CSV);
}

// ─── CSV helpers ─────────────────────────────────────────────────────────────

function splitCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      result.push(cur); cur = '';
    } else cur += c;
  }
  result.push(cur);
  return result;
}

function readCSV(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = splitCSVLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, (vals[i] || '').trim()]));
  });
}

function csvQuote(val) {
  const s = String(val || '');
  return /[,"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function writeCSV(file, headers, rows) {
  const out = [
    headers.join(','),
    ...rows.map(r => headers.map(h => csvQuote(r[h])).join(','))
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(file, out);
}

// ─── JSON db (responses + newsletter state only) ──────────────────────────────

const DEFAULT_DB = { newsletters: [], responses: [], _nextId: { newsletter: 1, response: 1 } };

function load() {
  if (!fs.existsSync(DB_FILE)) { save(DEFAULT_DB); return DEFAULT_DB; }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
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

// ─── Subscribers (CSV) ────────────────────────────────────────────────────────

module.exports = {
  getSubscribers() {
    return readCSV(SUBSCRIBERS_CSV).filter(r => r.email);
  },

  addSubscriber(email, name) {
    const rows = readCSV(SUBSCRIBERS_CSV);
    if (rows.find(r => r.email === email)) {
      // update name if already present
      rows.find(r => r.email === email).name = name;
    } else {
      rows.push({ name, email });
    }
    writeCSV(SUBSCRIBERS_CSV, ['name', 'email'], rows);
  },

  removeSubscriber(email) {
    const rows = readCSV(SUBSCRIBERS_CSV).filter(r => r.email !== email);
    writeCSV(SUBSCRIBERS_CSV, ['name', 'email'], rows);
  },

  // ─── Questions (CSV) ───────────────────────────────────────────────────────

  getQuestions() {
    const rows = readCSV(QUESTIONS_CSV);
    return rows.map(r => r.question).filter(Boolean);
  },

  saveQuestions(questions) {
    writeCSV(QUESTIONS_CSV, ['question'], questions.map(q => ({ question: q })));
  },

  // ─── Newsletters (JSON) ───────────────────────────────────────────────────

  getOrCreateNewsletter(year, month) {
    const db = load();
    let nl = db.newsletters.find(n => n.year === year && n.month === month);
    if (nl) return { ...nl };

    // Snapshot questions from CSV at newsletter creation time
    const questions = module.exports.getQuestions();
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

  markResultsSent(id) {
    withDb(db => { const nl = db.newsletters.find(n => n.id === id); if (nl) nl.results_sent = true; });
  },

  // ─── Responses (JSON) ─────────────────────────────────────────────────────

  saveResponse({ newsletterId, email, name, answers, links, imageUrl, imageFilename }) {
    withDb(db => {
      const existing = db.responses.find(r => r.newsletter_id === newsletterId && r.email === email);
      const entry = {
        newsletter_id: newsletterId, email, name: name || email,
        answers, links: links || [],
        image_url: imageUrl || null,
        image_filename: imageFilename || null,
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

  patchResponse(id, { imageUrl, imageFilename, links }) {
    withDb(db => {
      const r = db.responses.find(r => r.id === id);
      if (!r) return;
      r.image_url = imageUrl || null;
      r.image_filename = imageFilename !== undefined ? imageFilename : r.image_filename;
      r.links = links || [];
    });
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
