require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { sendCompiledEmails } = require('../src/scheduler');

sendCompiledEmails(true)
  .then(r => { console.log('\nDone:', r.message); process.exit(0); })
  .catch(e => { console.error('\nError:', e.message); process.exit(1); });
