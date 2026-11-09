// Contact form storage API for the Acoustic Philosophy site.
// POST /api/contact   stores one inquiry
// GET  /api/messages  lists stored inquiries (requires the X-Inbox-Key header)
// GET  /api/health    readiness probe
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT || 8000);
const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = join(DATA_DIR, 'messages.jsonl');
const INBOX_KEY = process.env.INBOX_KEY || '';
const MAX_BODY = 64 * 1024;

function send(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function keyMatches(given) {
  if (!INBOX_KEY || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(INBOX_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function listMessages() {
  try {
    const raw = await readFile(DATA_FILE, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/health') {
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && path === '/api/contact') {
    let data;
    try {
      data = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'Invalid request.' });
    }
    const name = String(data?.name || '').trim().slice(0, 120);
    const email = String(data?.email || '').trim().slice(0, 200);
    if (!name || !validEmail(email)) {
      return send(res, 400, { error: 'Name and a valid email are required.' });
    }
    const record = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      name,
      email,
      city: String(data?.city || '').trim().slice(0, 120),
      type: String(data?.type || '').trim().slice(0, 80) || 'Inquiry',
      music: String(data?.music || '').trim().slice(0, 2000)
    };
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await appendFile(DATA_FILE, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      console.error('Could not store message:', err);
      return send(res, 500, { error: 'Could not store the request.' });
    }
    return send(res, 201, { ok: true, id: record.id });
  }

  if (req.method === 'GET' && path === '/api/messages') {
    if (!INBOX_KEY) return send(res, 503, { error: 'Inbox passcode is not configured.' });
    if (!keyMatches(String(req.headers['x-inbox-key'] || ''))) {
      return send(res, 401, { error: 'Incorrect passcode.' });
    }
    try {
      const messages = (await listMessages()).sort((a, b) =>
        String(b.createdAt).localeCompare(String(a.createdAt))
      );
      return send(res, 200, { messages });
    } catch (err) {
      console.error('Could not read messages:', err);
      return send(res, 500, { error: 'Could not read requests.' });
    }
  }

  return send(res, 404, { error: 'Not found.' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Contact API listening on ' + PORT);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
