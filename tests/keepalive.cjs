// MINYAWE-LINK V8.0 — اختبار keep-alive (pixeldrain + 0x0) بدون HTTP server
process.env.PIXELDRAIN_API_KEY = '190df9f9-1c45-4ce0-84da-3b630d725ae3';
const { fileDB } = require('../utils/db');
const storage = require('../storage');

async function main() {
  const TEST_PD_ID = 'E6uid6YH'; // ملف حقيقي مرفوع بحساب المستخدم

  // معلومات الملف قبل اللمسة (date_last_view)
  const infoBefore = await (await fetch('https://pixeldrain.com/api/file/' + TEST_PD_ID + '/info', {
    headers: { 'Authorization': 'Bearer ' + process.env.PIXELDRAIN_API_KEY },
    signal: AbortSignal.timeout(10000)
  })).json();

  // تسجيل سجل وهمي في قاعدة البيانات المحلية
  await fileDB.insert({
    id: 'kapdtest1',
    original: 'ka-test.txt',
    mimetype: 'text/plain',
    size: 61,
    deleteToken: 'x',
    createdAt: Date.now(),
    views: 0,
    driver: 'pixeldrain',
    stored: TEST_PD_ID,
    directUrl: 'https://pixeldrain.com/api/file/' + TEST_PD_ID,
    compressed: 0
  });

  const res = await storage.keepAlive();
  console.log('keepAlive result:', JSON.stringify(res));

  const infoAfter = await (await fetch('https://pixeldrain.com/api/file/' + TEST_PD_ID + '/info', {
    headers: { 'Authorization': 'Bearer ' + process.env.PIXELDRAIN_API_KEY },
    signal: AbortSignal.timeout(10000)
  })).json();

  const before = infoBefore.date_last_view || '';
  const after = infoAfter.date_last_view || '';
  console.log('date_last_view before:', before);
  console.log('date_last_view after :', after);

  await fileDB.delete('kapdtest1');

  const pass = res.pinged >= 1 && after >= before && (res.drivers.pixeldrain || 0) >= 1;
  console.log(pass ? 'KEEP-ALIVE TEST: PASS' : 'KEEP-ALIVE TEST: FAIL');
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error('crashed:', e.message); process.exit(1); });
