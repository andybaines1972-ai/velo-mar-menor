// VÉLO Coach — pass-through to the intervals.icu API.
// The browser can't call intervals.icu directly, so the coach page calls /api/icu?path=/athlete/0/...
// The rider's own API key travels in the x-icu-key header and is used once for the forwarded request.
// Nothing is stored or logged here.

const ALLOWED_PATH = /^\/(athlete\/[A-Za-z0-9]+|activity\/[A-Za-z0-9]+)(\/[A-Za-z0-9_\-.\/]*)?$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');

  if (!METHODS.has(req.method)) {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  const key = String(req.headers['x-icu-key'] || '').trim();
  if (!key) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: 'Missing intervals.icu API key' }));
  }

  const url = new URL(req.url, 'http://local');
  const path = url.searchParams.get('path') || '';
  if (!ALLOWED_PATH.test(path) || path.includes('..')) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Path not allowed' }));
  }
  url.searchParams.delete('path');
  const qs = url.searchParams.toString();
  const target = 'https://intervals.icu/api/v1' + path + (qs ? '?' + qs : '');

  let body;
  if (req.method === 'POST' || req.method === 'PUT') {
    if (req.body !== undefined && req.body !== null) {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    } else {
      body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', c => { data += c; if (data.length > 2e6) reject(new Error('Body too large')); });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
    }
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        Authorization: 'Basic ' + Buffer.from('API_KEY:' + key).toString('base64'),
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body
    });
    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    return res.end(text);
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Could not reach intervals.icu', detail: String(e && e.message || e) }));
  }
};
