// Okta push-approval alert for todolist task agents (umich-okta-login skill).
// Only tells the todolist server to show / clear a banner telling the user
// which number to tap in Okta Verify; it never touches credentials.
//
// CLI (inside a todolist session):
//   node todolist/okta.js alert <1-2 digit number> [--site okta.umich.edu]
//   node todolist/okta.js alert --failed     push rejected / timed out
//   node todolist/okta.js alert --password   needs a password typed by the user
//   node todolist/okta.js clear

const http = require('http');

function postJson(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: 'localhost',
      port: process.env.TODOLIST_PORT,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(process.env.TODOLIST_TOKEN ? { 'x-todolist-token': process.env.TODOLIST_TOKEN } : {}),
      },
    }, res => {
      let out = '';
      res.on('data', c => (out += c));
      res.on('end', () => {
        try { resolve({ code: res.statusCode, body: JSON.parse(out) }); } catch { resolve({ code: res.statusCode, body: { error: out } }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const taskId = process.env.TODOLIST_TASK_ID;
  if (!taskId || !process.env.TODOLIST_PORT) throw new Error('okta.js only works inside a todolist session.');
  const base = `/api/tasks/${encodeURIComponent(taskId)}`;

  let r;
  if (cmd === 'clear') {
    r = await postJson(`${base}/okta-clear`, {});
  } else if (cmd === 'alert') {
    const site = rest.includes('--site') ? rest[rest.indexOf('--site') + 1] : '';
    const kind = rest.includes('--failed') ? 'failed' : rest.includes('--password') ? 'password' : 'push';
    const number = rest.find(a => /^\d{1,2}$/.test(a)) || '';
    r = await postJson(`${base}/okta-alert`, { kind, number, site });
  } else {
    throw new Error('usage: okta.js alert <number> [--site host] | alert --failed | alert --password | clear');
  }
  if (r.code !== 200 || !r.body.ok) throw new Error(r.body.error || `HTTP ${r.code}`);
  console.log('ok');
}

main().catch(e => { console.error(e.message); process.exit(1); });
