require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'data', 'uploads')));

const routes = require('./routes');
app.use('/', routes);
app.get('/', (req, res) => res.redirect('/admin'));

app.listen(PORT, () => {
  console.log(`\n🚀 Friend Newsletter running at http://localhost:${PORT}`);
  console.log(`📊 Admin panel:  http://localhost:${PORT}/admin\n`);
  const { startScheduler } = require('./scheduler');
  startScheduler();
});
