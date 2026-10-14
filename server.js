const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { prepareSource, moshCut, render, formatCatalog } = require('./lib/pipeline');
const { jobs, newJob } = require('./lib/ffmpeg');

const PORT = Number(process.env.PORT) || 5177;
const WORK = path.join(__dirname, 'work');
const PUBLIC = path.join(__dirname, 'public');
// Exports outlive the session; everything in WORK is scratch and gets wiped.
const EXPORTS = process.env.NEOMUX_EXPORTS || path.join(os.homedir(), 'Videos', 'NeoMux');
const MIN_FREE = 1024 ** 3;
const ID = /^[a-f0-9]{12}$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
};

const projectDir = (id) => {
  if (!ID.test(id || '')) throw httpError(400, 'Projeto inválido.');
  return path.join(WORK, id);
};

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function sourceOf(dir) {
  const file = (await fsp.readdir(dir)).find((f) => f.startsWith('source.') && !f.endsWith('.json'));
  if (!file) throw httpError(404, 'Vídeo original não encontrado.');
  return path.join(dir, file);
}

const readMeta = async (dir, name) => JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));

const routes = {
  'POST /api/import': async (req, progress) => {
    // Importing replaces the previous project of this window.
    await discard(req.headers['x-replace']);
    const name = decodeURIComponent(req.headers['x-filename'] || 'video.mp4');
    const ext = (path.extname(name).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || ['.mp4'])[0];
    const id = crypto.randomBytes(6).toString('hex');
    const dir = path.join(WORK, id);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `source${ext}`);
    try {
      await new Promise((resolve, reject) => {
        req.on('aborted', () => reject(cancelled()));
        req.pipe(fs.createWriteStream(file)).on('finish', resolve).on('error', reject);
      });
      return { id, name: path.parse(name).name, ...(await prepareSource(dir, file, progress)) };
    } catch (e) {
      await fsp.rm(dir, { recursive: true, force: true });
      if (e.cancelled) throw e;
      throw httpError(422, 'Não consegui ler esse vídeo. ' + e.message.split('\n').slice(-2).join(' '));
    }
  },
  'POST /api/mosh': async (req, progress) => {
    const body = await readJson(req);
    const dir = projectDir(body.id);
    return moshCut(dir, await sourceOf(dir), await readMeta(dir, 'source.json'), body, progress);
  },
  'POST /api/render': async (req, progress) => {
    const body = await readJson(req);
    const dir = projectDir(body.id);
    const [info, meta] = await Promise.all([readMeta(dir, 'source.json'), readMeta(dir, 'moshed.json')]);
    const file = await render(dir, await sourceOf(dir), info, meta, body, { report: progress, outDir: EXPORTS });
    const { size } = await fsp.stat(file);
    const name = path.basename(file);
    return { file: name, url: `/exports/${encodeURIComponent(name)}`, size, folder: EXPORTS };
  },
  'GET /api/formats': async () => formatCatalog(),
  // Sent with sendBeacon when the window closes.
  'POST /api/close': async (req) => {
    await discard((await readJson(req)).id);
    return { ok: true };
  },
  'POST /api/reveal': async (req) => {
    const { file } = await readJson(req);
    const target = path.join(EXPORTS, path.basename(String(file)));
    await fsp.access(target);
    spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  },
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function cancelled() {
  return Object.assign(new Error('Cancelado.'), { cancelled: true });
}

function serveFile(req, res, file, extraHeaders = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'Não encontrado.' });
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...extraHeaders };
    if (range) {
      const start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

// Long jobs answer with NDJSON: {"progress":0.42,"label":"…"} lines, then {"result":…} or {"error":…}.
const STREAMED = new Set(['/api/import', '/api/mosh', '/api/render']);

async function freeSpace() {
  const { bavail, bsize } = await fsp.statfs(__dirname);
  return bavail * bsize;
}

function friendly(e) {
  if (/No space left on device|ENOSPC/i.test(e.message)) return 'O disco ficou cheio durante o processamento. Libere espaço e tente de novo.';
  return e.message;
}

async function stream(res, route, req) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  let last = 0;
  const progress = (p, label) => {
    const now = Date.now();
    if (p < 1 && now - last < 150) return;
    last = now;
    res.write(JSON.stringify({ progress: Math.round(p * 1000) / 1000, label }) + '\n');
  };
  // Client gone before we finished (Cancel button, window closed): kill its ffmpeg processes.
  const job = newJob();
  res.on('close', () => !res.writableFinished && job.cancel());
  try {
    const free = await freeSpace();
    if (free < MIN_FREE) {
      req.resume();
      throw new Error(`Pouco espaço em disco (${(free / 1024 ** 3).toFixed(1)} GB livres). O NeoMux precisa de pelo menos 1 GB livre para trabalhar com segurança.`);
    }
    const result = await jobs.run(job, () => route(req, progress));
    res.end(JSON.stringify({ result }) + '\n');
  } catch (e) {
    if (!e.cancelled) console.error(e);
    res.end(JSON.stringify({ error: friendly(e) }) + '\n');
  }
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = routes[`${req.method} ${url.pathname}`];
  try {
    if (route && STREAMED.has(url.pathname)) return stream(res, route, req);
    if (route) return send(res, 200, await route(req));
    if (req.method !== 'GET') return send(res, 405, { error: 'Método não suportado.' });

    const media = /^\/media\/([a-f0-9]{12})\/([\w.-]+)$/.exec(url.pathname);
    if (media) return serveFile(req, res, path.join(projectDir(media[1]), media[2]));
    const exported = /^\/exports\/([^/]+)$/.exec(url.pathname);
    if (exported) {
      const name = path.basename(decodeURIComponent(exported[1]));
      const download = url.searchParams.has('download') ? { 'Content-Disposition': `attachment; filename="${name}"` } : {};
      return serveFile(req, res, path.join(EXPORTS, name), download);
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Proibido.' });
    serveFile(req, res, file);
  } catch (e) {
    console.error(e);
    send(res, e.status || 500, { error: e.message });
  }
});

// ---------- scratch cleanup ----------
// Imports, previews and mosh intermediates only live while the window is open.
async function discard(id) {
  if (!ID.test(id || '')) return;
  await fsp.rm(path.join(WORK, id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

function wipeWorkSync() {
  try {
    fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (e) {
    console.error('Não consegui limpar a pasta work:', e.message);
  }
}

function shutdown() {
  wipeWorkSync();
  process.exit(0);
}

function start() {
  return new Promise((resolve, reject) => {
    server.once('error', (e) =>
      reject(e.code === 'EADDRINUSE' ? Object.assign(new Error('O NeoMux já está aberto.'), { code: e.code }) : e),
    );
    server.listen(PORT, '127.0.0.1', () => {
      // Only the instance that owns the port may wipe: these are leftovers from a session that crashed.
      wipeWorkSync();
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, shutdown);
      console.log(`NeoMux rodando em http://localhost:${PORT}`);
      console.log(`Exportações em ${EXPORTS}`);
      resolve(`http://localhost:${PORT}`);
    });
  });
}

module.exports = { start, shutdown };
if (require.main === module) start().catch((e) => (console.error(e.message), process.exit(1)));
