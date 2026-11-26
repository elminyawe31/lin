// MINYAWE-LINK V8.0 — اختبار E2E محلي شامل (node tests/e2e.mjs [baseUrl])
const BASE = String(process.argv[2] || 'http://localhost:3100').replace(/\/$/, '');
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? ' :: ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
async function f(path, opts = {}) {
  console.log('  -> ' + (opts.method || 'GET') + ' ' + path);
  return fetch(BASE + path, { ...opts, signal: AbortSignal.timeout(30000) });
}

async function main() {
  // 1) health
  const h = await (await f('/health')).json();
  ok('health', h.status === 'MINYAWE-LINK OK' && h.db === 'dev-json');

  // 2) server-path upload (chain: onlyfiles)
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('v8 e2e payload ' + Date.now())], { type: 'text/plain' }), 'e2e-test.txt');
  fd.append('alias', 'v8-e2e');
  fd.append('expiry', 'never');
  const up = await (await f('/api/upload', { method: 'POST', body: fd })).json();
  ok('upload(server path)', !!up.id && up.slug === 'v8-e2e', 'id=' + (up.id || up.error));
  ok('upload permanent (expiryAt null)', up.expiryAt === null);
  if (!up.id) { console.log('STOP — upload failed'); return; }
  const key = up.slug || up.id;

  // 3) 302 redirects
  const rI = await f('/i/' + key, { redirect: 'manual' });
  ok('GET /i/:id 302', rI.status === 302, (rI.headers.get('location') || '').slice(0, 60));
  const rE = await f('/e/' + key + '.txt', { redirect: 'manual' });
  ok('GET /e/:id.ext 302', rE.status === 302, (rE.headers.get('location') || '').slice(0, 60));
  const loc = rE.headers.get('location') || '';
  ok('302 -> fresh onlyfiles dl token', loc.includes('onlyfiles.com/dl/'));
  const rD = await f('/d/' + key + '.txt', { redirect: 'manual' });
  ok('GET /d/:id.ext 302', rD.status === 302);
  const rWrongExt = await f('/e/' + key + '.mp3', { redirect: 'manual' });
  ok('wrong ext -> 301 normalize', rWrongExt.status === 301, rWrongExt.headers.get('location') || '');

  // 4) viewer pages (white-label: no provider names inside)
  const vPage = await (await f('/v/' + key)).text();
  ok('GET /v/:id 200 html', vPage.includes('MINYAWE-LINK') && /<video|<audio|<img|class="file"|class="txt"/.test(vPage));
  ok('v page hides provider', !vPage.includes('onlyfiles') && !vPage.includes('pixeldrain'));
  const oPage = await (await f('/o/' + key + '.txt')).text();
  ok('GET /o/:id.ext 200', oPage.includes('MINYAWE-LINK') && oPage.includes('e2e-test.txt'));
  ok('o page hides provider', !oPage.includes('onlyfiles'));

  // 5) browser-direct registration flow (real onlyfiles upload then register)
  const ofd = new FormData();
  ofd.append('file', new Blob([Buffer.from('browser-direct test ' + Date.now())], { type: 'text/plain' }), 'browser-direct.txt');
  const our = await fetch('https://api.onlyfiles.com/v1/upload', {
    method: 'POST', body: ofd,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'Referer': 'https://onlyfiles.com/' },
    signal: AbortSignal.timeout(30000)
  });
  const oj = await our.json();
  ok('onlyfiles direct upload', !!(oj && oj.status && oj.data && oj.data.file));
  if (oj && oj.status) {
    const reg = await (await f('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'onlyfiles', fullUrl: oj.data.file.url.full, shortUrl: oj.data.file.url.short,
        providerId: oj.data.file.metadata.id, filename: 'browser-direct.txt', mimetype: 'text/plain',
        size: 24, expiry: 'never'
      })
    })).json();
    ok('POST /api/register', !!reg.id, 'id=' + (reg.id || reg.error));
    if (reg.id) {
      const rI2 = await f('/i/' + (reg.slug || reg.id), { redirect: 'manual' });
      ok('register file 302', rI2.status === 302, (rI2.headers.get('location') || '').slice(0, 50));
      await f('/api/' + reg.id + '?token=' + reg.deleteToken, { method: 'DELETE' });
    }
  }

  // 6) album
  const alb = await (await f('/api/album', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ['v8-e2e'], expiry: 'never' })
  })).json();
  ok('POST /api/album', !!alb.id && alb.count === 1, 'url=' + (alb.url || alb.error));
  if (alb.id) {
    const aPage = await (await f('/a/' + alb.id)).text();
    ok('GET /a/:id album page', aPage.includes('ألبوم الملفات'));
  }

  // 7) admin
  const ping = await (await f('/api/admin/ping', { headers: { 'x-admin-token': 'test-admin-token-123' } })).json();
  ok('admin ping', ping.ok === true);
  const files = await (await f('/api/admin/files?q=e2e', { headers: { 'x-admin-token': 'test-admin-token-123' } })).json();
  ok('admin files search', files.total >= 1);
  const noAuth = await f('/api/admin/ping');
  ok('admin blocked w/o token', noAuth.status === 403);

  // 8) cron maintenance (with keep-alive)
  const cron = await (await f('/api/cron/maintenance?secret=test-cron-secret')).json();
  ok('cron maintenance + keepAlive', cron.ok === true && typeof cron.keepAlive === 'object', JSON.stringify(cron.keepAlive || {}).slice(0, 80));
  const cronNoAuth = await f('/api/cron/maintenance');
  ok('cron blocked w/o secret', cronNoAuth.status === 403);

  // 9) stats + docs + llms
  const st = await (await f('/api/stats')).json();
  ok('api/stats', st.files >= 1 && typeof st.totalBytes === 'number');
  const docs = await (await f('/api/docs')).json();
  ok('api/docs retention', docs.limits && docs.limits.retention.includes('never'));
  const llms = await (await f('/llms.txt')).text();
  ok('llms.txt permanent default', llms.includes('PERMANENT'));
  const cfg = await (await f('/api/config')).json();
  ok('api/config directProviders onlyfiles', JSON.stringify(cfg.directProviders) === '["onlyfiles"]');

  // 10) delete with owner token
  const del = await (await f('/api/' + up.id + '?token=' + up.deleteToken, { method: 'DELETE' })).json();
  ok('DELETE via deleteToken', del.ok === true);
  const gone = await f('/i/' + key, { redirect: 'manual' });
  ok('deleted file 404', gone.status === 404);

  console.log('\n==== RESULT: ' + pass + ' passed, ' + fail + ' failed ====');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('E2E crashed:', e.message); process.exit(1); });
