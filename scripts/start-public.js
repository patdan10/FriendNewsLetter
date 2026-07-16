// Starts ngrok, reads the public URL, updates BASE_URL in .env, then keeps running
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');

function getNgrokUrl(retries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get('http://127.0.0.1:4040/api/tunnels', res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const tunnels = JSON.parse(data).tunnels;
            const tunnel = tunnels.find(t => t.proto === 'https');
            if (tunnel) return resolve(tunnel.public_url);
          } catch {}
          if (n > 0) setTimeout(() => attempt(n - 1), 1000);
          else reject(new Error('No HTTPS tunnel found'));
        });
      }).on('error', () => {
        if (n > 0) setTimeout(() => attempt(n - 1), 1000);
        else reject(new Error('ngrok API not reachable — is ngrok installed and authenticated?'));
      });
    };
    attempt(retries);
  });
}

function setBaseUrl(url) {
  let env = fs.readFileSync(ENV_FILE, 'utf8');
  if (/^BASE_URL=/m.test(env)) {
    env = env.replace(/^BASE_URL=.*/m, `BASE_URL=${url}`);
  } else {
    env += `\nBASE_URL=${url}\n`;
  }
  fs.writeFileSync(ENV_FILE, env);
}

// Start ngrok
const ngrok = spawn('ngrok', ['http', '3000'], { stdio: 'inherit', shell: true });

ngrok.on('error', () => {
  console.error('\n❌  ngrok not found.');
  console.error('   Install it: winget install ngrok');
  console.error('   Then authenticate: ngrok config add-authtoken YOUR_TOKEN');
  process.exit(1);
});

console.log('Waiting for ngrok tunnel...');
getNgrokUrl()
  .then(url => {
    setBaseUrl(url);
    console.log(`\n✅  Public URL: ${url}`);
    console.log('   BASE_URL updated in .env');
    console.log('\n   Form links in emails will now point to this URL.');
    console.log('   Keep this window open while people are filling out the form.\n');
  })
  .catch(err => {
    console.error('\n❌ ', err.message);
    console.error('   Make sure you ran: ngrok config add-authtoken YOUR_TOKEN');
  });

process.on('SIGINT', () => { ngrok.kill(); process.exit(); });
