'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

// Пароль для страницы сотрудников /admin (логин: admin).
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(6).toString('hex');
  console.log(`ADMIN_PASSWORD не задан. Временный пароль для /admin: admin / ${ADMIN_PASSWORD}`);
}

/* ---------- База данных (SQLite, встроена в Node.js 22.5+) ---------- */
let db = null;
try {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(path.join(DATA_DIR, 'chat.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      last_at TEXT NOT NULL,
      staff_read_id INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL REFERENCES chats(id),
      sender TEXT NOT NULL CHECK (sender IN ('client','staff')),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
  `);
} catch (e) {
  db = null;
  console.error('Чат отключён: нужен Node.js 22.5+ (модуль node:sqlite).', e.message);
}

const q = db && {
  newChat: db.prepare('INSERT INTO chats (token,name,phone,created_at,last_at) VALUES (?,?,?,?,?)'),
  chatByToken: db.prepare('SELECT * FROM chats WHERE token = ?'),
  chatById: db.prepare('SELECT * FROM chats WHERE id = ?'),
  addMsg: db.prepare('INSERT INTO messages (chat_id,sender,text,created_at) VALUES (?,?,?,?)'),
  touch: db.prepare('UPDATE chats SET last_at = ? WHERE id = ?'),
  msgs: db.prepare('SELECT id,sender,text,created_at FROM messages WHERE chat_id = ? AND id > ? ORDER BY id LIMIT 200'),
  markRead: db.prepare('UPDATE chats SET staff_read_id = MAX(staff_read_id, ?) WHERE id = ?'),
  list: db.prepare(`
    SELECT c.id, c.name, c.phone, c.last_at,
      (SELECT text FROM messages m WHERE m.chat_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_text,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.sender = 'client' AND m.id > c.staff_read_id) AS unread
    FROM chats c ORDER BY c.last_at DESC LIMIT 100`)
};
const now = () => new Date().toISOString();

/* ---------- Вспомогательное ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8'
};
const SECURITY = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};

function send(res, status, body, type, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8' }, SECURITY, extra || {}));
  res.end(body);
}
function json(res, status, obj) { send(res, status, JSON.stringify(obj), MIME['.json'], { 'Cache-Control': 'no-store' }); }

function clientIp(req) {
  if (TRUST_PROXY) {
    const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (f) return f;
  }
  return req.socket.remoteAddress || '';
}
const hits = new Map();
function limited(key, max, windowMs) {
  const t = Date.now();
  const arr = (hits.get(key) || []).filter(x => t - x < windowMs);
  arr.push(t);
  hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some(x => t - x < 3600e3)) hits.delete(k); }, 600e3).unref();

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('bad')); } });
    req.on('error', reject);
  });
}
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);

function isAdmin(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const given = crypto.createHash('sha256').update(Buffer.from(h.slice(6), 'base64').toString('utf8')).digest();
  const want = crypto.createHash('sha256').update('admin:' + ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(given, want);
}
function askAuth(res) {
  send(res, 401, 'Нужен пароль', undefined, { 'WWW-Authenticate': 'Basic realm="Service chats", charset="UTF-8"', 'Cache-Control': 'no-store' });
}

/* ---------- API чата ---------- */
async function api(req, res, p, url) {
  if (!db) return json(res, 503, { error: 'Чат временно недоступен. Позвоните нам.' });
  const ip = clientIp(req);
  try {
    // --- клиент ---
    if (p === '/api/chat/start' && req.method === 'POST') {
      if (limited('start:' + ip, 10, 3600e3)) return json(res, 429, { error: 'Слишком много попыток. Попробуйте позже.' });
      const b = await readBody(req);
      const name = clean(b.name, 60) || 'Клиент';
      const phone = clean(b.phone, 30);
      const token = crypto.randomBytes(16).toString('hex');
      const t = now();
      const id = Number(q.newChat.run(token, name, phone, t, t).lastInsertRowid);
      q.addMsg.run(id, 'staff', 'Здравствуйте! Напишите, чем помочь. Отвечаем ежедневно с 08:30 до 17:30.', t);
      return json(res, 200, { token });
    }
    if (p === '/api/chat/messages') {
      const token = clean(url.searchParams.get('token') || '', 64);
      const chat = q.chatByToken.get(token);
      if (!chat) return json(res, 404, { error: 'Чат не найден' });
      if (req.method === 'GET') {
        const after = Number(url.searchParams.get('after')) || 0;
        return json(res, 200, { messages: q.msgs.all(chat.id, after) });
      }
      if (req.method === 'POST') {
        if (limited('msg:' + ip, 30, 300e3)) return json(res, 429, { error: 'Слишком часто. Подождите минуту.' });
        const b = await readBody(req);
        const text = clean(b.text, 1000);
        if (!text) return json(res, 400, { error: 'Пустое сообщение' });
        const t = now();
        const id = Number(q.addMsg.run(chat.id, 'client', text, t).lastInsertRowid);
        q.touch.run(t, chat.id);
        return json(res, 200, { message: { id, sender: 'client', text, created_at: t } });
      }
    }

    // --- сотрудники ---
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return askAuth(res);
      if (p === '/api/admin/chats' && req.method === 'GET') return json(res, 200, { chats: q.list.all() });
      const m = p.match(/^\/api\/admin\/chats\/(\d+)\/messages$/);
      if (m) {
        const chat = q.chatById.get(Number(m[1]));
        if (!chat) return json(res, 404, { error: 'Чат не найден' });
        if (req.method === 'GET') {
          const after = Number(url.searchParams.get('after')) || 0;
          const messages = q.msgs.all(chat.id, after);
          if (messages.length) q.markRead.run(messages[messages.length - 1].id, chat.id);
          return json(res, 200, { chat: { id: chat.id, name: chat.name, phone: chat.phone }, messages });
        }
        if (req.method === 'POST') {
          const b = await readBody(req);
          const text = clean(b.text, 1000);
          if (!text) return json(res, 400, { error: 'Пустое сообщение' });
          const t = now();
          const id = Number(q.addMsg.run(chat.id, 'staff', text, t).lastInsertRowid);
          q.touch.run(t, chat.id);
          q.markRead.run(id, chat.id);
          return json(res, 200, { message: { id, sender: 'staff', text, created_at: t } });
        }
      }
    }
    return json(res, 404, { error: 'Не найдено' });
  } catch (e) {
    if (e.message === 'big') return json(res, 413, { error: 'Слишком длинное сообщение' });
    if (e.message === 'bad') return json(res, 400, { error: 'Некорректный запрос' });
    console.error(e);
    return json(res, 500, { error: 'Ошибка сервера' });
  }
}

/* ---------- Статика ---------- */
function indexHtml() {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const seo = SITE_URL ? `<link rel="canonical" href="${SITE_URL}/">\n<meta property="og:url" content="${SITE_URL}/">` : '';
  return html.replace('<!--SEO-->', seo);
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return send(res, 400, 'Некорректный адрес'); }
  if (rel.includes('\0')) return send(res, 400, 'Некорректный адрес');
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin' || rel === '/admin/' || rel === '/admin.html') {
    if (!isAdmin(req)) return askAuth(res);
    rel = '/admin.html';
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Страница не найдена');
  if (path.basename(file).startsWith('.')) return send(res, 404, 'Страница не найдена');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    if (path.basename(file) === 'index.html') {
      const body = indexHtml();
      return send(res, 200, req.method === 'HEAD' ? '' : body, type, { 'Cache-Control': 'no-cache' });
    }
    const priv = path.basename(file) === 'admin.html';
    const cache = priv ? 'no-store' : ext === '.html' ? 'no-cache' : 'public, max-age=300';
    res.writeHead(200, Object.assign({ 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': cache }, SECURITY));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

function notFound(res) {
  const page = path.join(PUBLIC_DIR, '404.html');
  fs.readFile(page, (err, buf) => send(res, 404, err ? 'Страница не найдена' : buf, err ? undefined : MIME['.html']));
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p.startsWith('/api/')) return api(req, res, p, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Метод не поддерживается', undefined, { Allow: 'GET, HEAD' });
    if (p === '/robots.txt') return send(res, 200, `User-agent: *\nAllow: /\nDisallow: /admin\n${SITE_URL ? `Sitemap: ${SITE_URL}/sitemap.xml\n` : ''}`);
    if (p === '/sitemap.xml') {
      const body = SITE_URL
        ? `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE_URL}/</loc></url>\n</urlset>\n`
        : `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n`;
      return send(res, 200, body, MIME['.xml']);
    }
    serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    send(res, 500, 'Внутренняя ошибка сервера');
  }
});
server.listen(PORT, HOST, () => console.log(`Сайт запущен: http://localhost:${PORT}  |  Чаты сотрудников: http://localhost:${PORT}/admin`));
