require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { sendFormEmails } = require('../src/scheduler');

sendFormEmails(true)
  .then(r => { console.log('\nDone:', r.message); process.exit(0); })
  .catch(e => { console.error('\nError:', e.message); process.exit(1); });
