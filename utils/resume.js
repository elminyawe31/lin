const fs = require('fs');
const path = require('path');

// دعم Range requests للتحميل الاستئنافي
function handleRangeRequest(req, res, filePath, filename, mimetype) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  
  if (!range) {
    // لا يوجد range - أرسل الملف كاملاً
    res.set({
      'Content-Type': mimetype,
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  
  // تحليل الـ range
  const parts = range.replace(/bytes=/, '').split('-');
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
  
  // التحقق من صحة الـ range
  if (start >= fileSize || end >= fileSize || start > end) {
    res.status(416).set({
      'Content-Range': `bytes */${fileSize}`
    }).send('Range Not Satisfiable');
    return;
  }
  
  const chunkSize = end - start + 1;
  
  res.status(206).set({
    'Content-Type': mimetype,
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  });
  
  const stream = fs.createReadStream(filePath, { start, end });
  stream.pipe(res);
  
  // معالجة الأخطاء
  stream.on('error', (err) => {
    console.error('  [resume] Stream error:', err.message);
    if (!res.headersSent) {
      res.status(500).send('Internal Server Error');
    }
  });
}

// دعم Range requests للبث (streaming)
function handleStreamRange(req, res, filePath, filename, mimetype) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  
  if (!range) {
    // لا يوجد range - أرسل الملف كاملاً
    res.set({
      'Content-Type': mimetype,
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  
  // تحليل الـ range
  const parts = range.replace(/bytes=/, '').split('-');
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
  
  // التحقق من صحة الـ range
  if (start >= fileSize || end >= fileSize || start > end) {
    res.status(416).set({
      'Content-Range': `bytes */${fileSize}`
    }).send('Range Not Satisfiable');
    return;
  }
  
  const chunkSize = end - start + 1;
  
  res.status(206).set({
    'Content-Type': mimetype,
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
  });
  
  const stream = fs.createReadStream(filePath, { start, end });
  stream.pipe(res);
  
  // معالجة الأخطاء
  stream.on('error', (err) => {
    console.error('  [resume] Stream error:', err.message);
    if (!res.headersSent) {
      res.status(500).send('Internal Server Error');
    }
  });
}

// التحقق من دعم المتصفح للـ range
function supportsRange(req) {
  const range = req.headers.range;
  const acceptRanges = req.headers['accept-ranges'];
  return !!range || acceptRanges === 'bytes';
}

module.exports = {
  handleRangeRequest,
  handleStreamRange,
  supportsRange
};
