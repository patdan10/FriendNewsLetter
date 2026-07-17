const cron = require('node-cron');
const db = require('./db');
const { sendFormEmail, sendCompiledEmail, sendReminderEmail } = require('./mailer');

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

async function sendFormEmails(force = false) {
  const now = new Date();
  const newsletter = db.getOrCreateNewsletter(now.getFullYear(), now.getMonth() + 1);

  if (newsletter.form_sent && !force) {
    return { message: 'Form emails already sent this month', skipped: true };
  }

  // Always use the current questions list at send time
  const currentQuestions = db.getQuestions();
  db.updateNewsletterQuestions(newsletter.id, currentQuestions);
  newsletter.questions = currentQuestions;

  const subscribers = db.getSubscribers();
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  console.log(`\nSending form emails to ${subscribers.length} subscriber(s)...`);

  for (const sub of subscribers) {
    await sendFormEmail({ toEmail: sub.email, toName: sub.name, newsletter, baseUrl });
  }

  db.markFormSent(newsletter.id);
  const msg = `Form emails sent to ${subscribers.length} subscriber(s)`;
  console.log(msg);
  return { message: msg, count: subscribers.length };
}

async function sendCompiledEmails(force = false) {
  const now = new Date();
  const newsletter = db.getOrCreateNewsletter(now.getFullYear(), now.getMonth() + 1);

  if (newsletter.results_sent && !force) {
    return { message: 'Results already sent this month', skipped: true };
  }

  const responses = db.getResponses(newsletter.id);
  const subscribers = db.getSubscribers();
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  console.log(`\nSending compiled newsletter to ${subscribers.length} subscriber(s) (${responses.length} response(s))...`);

  for (const sub of subscribers) {
    await sendCompiledEmail({ toEmail: sub.email, toName: sub.name, newsletter, responses, baseUrl });
  }

  db.markResultsSent(newsletter.id);
  const msg = `Compiled newsletter sent to ${subscribers.length} subscriber(s) with ${responses.length} response(s)`;
  console.log(msg);
  return { message: msg, count: subscribers.length, responses: responses.length };
}

async function sendReminderEmails() {
  const now = new Date();
  const newsletter = db.getOrCreateNewsletter(now.getFullYear(), now.getMonth() + 1);
  const responses = db.getResponses(newsletter.id);
  const respondedEmails = new Set(responses.map(r => r.email));
  const subscribers = db.getSubscribers();
  const pending = subscribers.filter(s => !respondedEmails.has(s.email));
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  if (!pending.length) {
    return { message: 'Everyone has already responded — no reminders needed!', skipped: true };
  }

  console.log(`\nSending reminder emails to ${pending.length} non-responder(s)...`);

  for (const sub of pending) {
    await sendReminderEmail({ toEmail: sub.email, toName: sub.name, newsletter, baseUrl });
  }

  const msg = `Reminder emails sent to ${pending.length} non-responder(s)`;
  console.log(msg);
  return { message: msg, count: pending.length };
}

function startScheduler() {
  cron.schedule('0 9 * * *', async () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const last = daysInMonth(year, month);

    try {
      if (day === last - 7) {
        console.log('One week before month end — sending form emails');
        await sendFormEmails();
      }
      if (day === last - 2) {
        console.log('Two days before month end — sending reminder emails to non-responders');
        await sendReminderEmails();
      }
      if (day === last) {
        console.log('Last day of month — sending compiled newsletter');
        await sendCompiledEmails();
      }
    } catch (e) {
      console.error('Scheduler error:', e.message);
    }
  });

  console.log('Scheduler running — form emails 1 week before month end, reminders 2 days before, results on the last day.');
}

module.exports = { startScheduler, sendFormEmails, sendCompiledEmails, sendReminderEmails };
