import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8787);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) return null;
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const start = buffer.indexOf(boundary);
  if (start < 0) return null;
  const headerStart = buffer.indexOf(Buffer.from('\r\n'), start) + 2;
  const bodyStart = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart);
  if (headerStart < 2 || bodyStart < 0) return null;
  const headers = buffer.slice(headerStart, bodyStart).toString('utf8');
  const nameMatch = /name="file";\s*filename="([^"]+)"/i.exec(headers);
  const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
  if (!nameMatch) return null;
  const dataStart = bodyStart + 4;
  const nextBoundary = buffer.indexOf(Buffer.from('\r\n--' + (match[1] || match[2])), dataStart);
  if (nextBoundary < 0) return null;
  return {
    filename: nameMatch[1],
    type: (typeMatch?.[1] || 'application/octet-stream').trim().toLowerCase(),
    data: buffer.slice(dataStart, nextBoundary),
  };
}

async function handleUpload(req, res) {
  const body = await readBody(req);
  const file = parseMultipart(body, req.headers['content-type']);
  if (!file) return sendJson(res, 400, { ok: false, error: '未收到文件' });
  if (file.data.length <= 0 || file.data.length > 3 * 1024 * 1024) {
    return sendJson(res, 413, { ok: false, error: '文件大小需不超过 3MB' });
  }
  const isJpeg = file.type === 'image/jpeg' && file.data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const isPng = file.type === 'image/png' && file.data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isJpeg && !isPng) return sendJson(res, 400, { ok: false, error: '仅支持 JPG / PNG 图片' });

  const now = new Date();
  const datePath = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const ext = isPng ? 'png' : 'jpg';
  const basename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const dir = path.join(root, 'uploads', ...datePath.split('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, basename), file.data);
  sendJson(res, 200, { ok: true, url: `http://localhost:${port}/uploads/${datePath}/${basename}` });
}

async function handleImageProxy(req, res) {
  const auth = req.headers.authorization || '';
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return sendJson(res, 401, { error: { message: 'Missing API Key' } });
  }
  const body = await readBody(req);
  const upstream = await fetch('https://tokenstation.top/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: auth,
    },
    body,
  });
  const text = await upstream.text();
  res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8' });
  res.end(text);
}

function serveStatic(req, res) {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  const rawPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const fullPath = path.resolve(root, '.' + rawPath);
  if (!fullPath.startsWith(root)) return sendJson(res, 403, { error: 'forbidden' });
  const ext = path.extname(fullPath).toLowerCase();
  res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
  createReadStream(fullPath)
    .on('error', () => sendJson(res, 404, { error: 'not found' }))
    .pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url?.startsWith('/upload.php')) return await handleUpload(req, res);
    if (req.method === 'POST' && req.url?.startsWith('/openai-image.php')) return await handleImageProxy(req, res);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    sendJson(res, 500, { error: err?.message || 'server error' });
  }
});

server.listen(port, () => {
  console.log(`咪咪Image创意工作台 running at http://localhost:${port}`);
});
