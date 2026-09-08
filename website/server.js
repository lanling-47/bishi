"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

loadEnv(path.join(__dirname, ".env"));
function required(name) {
  const value = process.env[name];
  if (!value || value.startsWith("replace-with-")) throw new Error(`${name} must be configured in website/.env.`);
  return value;
}

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const ingestToken = required("INGEST_TOKEN");
const dataDirectory = path.join(__dirname, "data", "captures");
const jobs = new Map();
const maximumBodyBytes = 16 * 1024 * 1024;

function send(response, status, type, body, headers = {}) {
  response.writeHead(status, { "Content-Type": type, "X-Content-Type-Options": "nosniff", ...headers });
  response.end(body);
}
function json(response, status, body) { send(response, status, "application/json; charset=utf-8", JSON.stringify(body)); }
function safeEqual(left, right) {
  const a = crypto.createHash("sha256").update(left).digest();
  const b = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(a, b);
}
function readBody(request, limit = maximumBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("Request body is too large.")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
function validWorker(request, response) {
  const value = request.headers.authorization || "";
  if (value.startsWith("Bearer ") && safeEqual(value.slice(7), ingestToken)) return true;
  json(response, 401, { error: "Invalid ingest token." });
  return false;
}
function validId(id) { return /^[a-f0-9-]{36}$/.test(id); }
function publicJob(job) { return { id: job.id, status: job.status, requestedAt: job.requestedAt, completedAt: job.completedAt || null, error: job.error || null, captureId: job.captureId || null }; }

async function listCaptures() {
  await fsp.mkdir(dataDirectory, { recursive: true });
  const results = [];
  for (const item of await fsp.readdir(dataDirectory, { withFileTypes: true })) {
    if (!item.isDirectory() || !validId(item.name)) continue;
    try {
      const record = JSON.parse(await fsp.readFile(path.join(dataDirectory, item.name, "record.json"), "utf8"));
      results.push({ id: item.name, capturedAt: record.capturedAt, answer: record.answer, imageUrl: `/api/captures/${item.name}/image` });
    } catch { /* Ignore incomplete writes. */ }
  }
  return results.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

function createJob(response) {
  const active = [...jobs.values()].find((job) => job.status === "queued" || job.status === "processing");
  if (active) return json(response, 409, { error: "A screenshot request is already active.", job: publicJob(active) });
  const job = { id: crypto.randomUUID(), status: "queued", requestedAt: new Date().toISOString() };
  jobs.set(job.id, job);
  json(response, 201, publicJob(job));
}

function claimJob(response) {
  const job = [...jobs.values()].find((item) => item.status === "queued");
  if (!job) { return json(response, 200, { none: true }); }
  job.status = "processing";
  job.claimedAt = new Date().toISOString();
  json(response, 200, publicJob(job));
}

async function saveResult(request, response, jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== "processing") return json(response, 409, { error: "No processing job with this id." });
  let capture;
  try { capture = JSON.parse((await readBody(request)).toString("utf8")); }
  catch (error) { return json(response, 400, { error: error.message === "Request body is too large." ? error.message : "Invalid JSON request." }); }
  if (typeof capture.answer !== "string" || typeof capture.imageBase64 !== "string" || capture.answer.length > 100000) return json(response, 400, { error: "Invalid result payload." });
  const image = Buffer.from(capture.imageBase64, "base64");
  if (image.length < 8 || image.length > 12 * 1024 * 1024 || image.readUInt32BE(0) !== 0x89504e47) return json(response, 400, { error: "Image must be a PNG no larger than 12 MB." });
  const captureId = crypto.randomUUID();
  const directory = path.join(dataDirectory, captureId);
  await fsp.mkdir(directory, { recursive: true });
  await Promise.all([
    fsp.writeFile(path.join(directory, "screen.png"), image),
    fsp.writeFile(path.join(directory, "record.json"), JSON.stringify({ capturedAt: capture.capturedAt || new Date().toISOString(), answer: capture.answer }))
  ]);
  job.status = "completed";
  job.completedAt = new Date().toISOString();
  job.captureId = captureId;
  json(response, 201, publicJob(job));
}

async function failJob(request, response, jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== "processing") return json(response, 409, { error: "No processing job with this id." });
  let payload;
  try { payload = JSON.parse((await readBody(request, 64 * 1024)).toString("utf8")); }
  catch { return json(response, 400, { error: "Invalid error payload." }); }
  if (typeof payload.error !== "string" || !payload.error.trim() || payload.error.length > 2000) return json(response, 400, { error: "Invalid error message." });
  job.status = "failed";
  job.completedAt = new Date().toISOString();
  job.error = payload.error.trim();
  json(response, 200, publicJob(job));
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Screen Codex</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f5f7fa;color:#172033;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{height:58px;background:#fff;border-bottom:1px solid #dfe4ea;display:flex;align-items:center;padding:0 max(18px,calc((100% - 1120px)/2))}
h1{font-size:18px;margin:0;font-weight:650}
button{border:1px solid #c9d1dc;background:#fff;border-radius:5px;padding:8px 11px;color:#172033;font:inherit;cursor:pointer}
button:disabled{cursor:wait;opacity:.6}
.primary{background:#1769aa;color:#fff;border-color:#1769aa}
.danger{color:#b42318;border-color:#f0b6b0}
main{max-width:1120px;margin:28px auto;padding:0 18px}
.toolbar{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.status{color:#5d6878;font-size:14px}
.capture{background:#fff;border:1px solid #dfe4ea;border-radius:7px;margin:0 0 16px;overflow:hidden}
.meta{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #e7ebf0;color:#5d6878;font-size:14px}
.content{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,42%)}
.content img{width:100%;display:block;background:#202936;max-height:70vh;object-fit:contain}
.answer{padding:16px;white-space:pre-wrap;overflow-wrap:anywhere}
.empty{color:#5d6878;padding:26px 0}
@media(max-width:720px){main{margin-top:18px}.content{grid-template-columns:1fr}.meta{align-items:flex-start;gap:8px}.meta time{max-width:70%;overflow-wrap:anywhere}}
</style>
</head>
<body>
<header><h1>Screen Codex</h1></header>
<main id="app"><p class="empty">正在加载...</p></main>
<script>
const app = document.getElementById('app');
const escape = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let timer;

async function load() {
  try {
    const [jr, cr] = await Promise.all([fetch('/api/jobs'), fetch('/api/captures')]);

    const jobs = await jr.json();
    const captures = await cr.json();

    const active = jobs.find(x => x.status === 'queued' || x.status === 'processing');
    const failed = jobs.find(x => x.status === 'failed');
    const state = active
      ? (active.status === 'queued' ? '请求已排队，等待电脑响应。' : '电脑正在截图并由 Codex 分析。')
      : (failed ? '上次请求失败：' + failed.error : '');

    app.innerHTML = '<div class="toolbar"><button class="primary" id="request" ' + (active ? 'disabled' : '') + '>截图并分析</button><span class="status">' + escape(state) + '</span></div>' +
      (captures.length ? captures.map(x => '<article class="capture"><div class="meta"><time>' + escape(new Date(x.capturedAt).toLocaleString()) + '</time><button class="danger" data-id="' + x.id + '">删除</button></div><div class="content"><img loading="lazy" src="' + x.imageUrl + '" alt="屏幕截图"><div class="answer">' + escape(x.answer) + '</div></div></article>').join('') : '<p class="empty">点击"截图并分析"后，电脑会执行一次截图和 Codex 推理。</p>');

    document.getElementById('request').onclick = async () => {
      const r = await fetch('/api/jobs', {method: 'POST'});
      if (r.ok || r.status === 409) load();
    };

    document.querySelectorAll('[data-id]').forEach(b => b.onclick = async () => {
      if (confirm('删除这条截图与回答？')) {
        await fetch('/api/captures/' + b.dataset.id, {method: 'DELETE'});
        load();
      }
    });

    clearTimeout(timer);
    if (active) timer = setTimeout(load, 2500);
  } catch(e) {
    console.error('加载失败:', e);
    app.innerHTML = '<p class="empty" style="color:red">加载失败: ' + escape(e.message) + '<br>请打开开发者工具查看详细错误。</p>';
  }
}

load();
</script>
</body>
</html>
`;
}


const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/") return send(response, 200, "text/html; charset=utf-8", page(), { "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    if (request.method === "GET" && url.pathname === "/api/jobs/next") { if (validWorker(request, response)) claimJob(response); return; }
    const result = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/result$/);
    if (request.method === "POST" && result) { if (validWorker(request, response)) await saveResult(request, response, result[1]); return; }
    const failure = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/error$/);
    if (request.method === "POST" && failure) { if (validWorker(request, response)) await failJob(request, response, failure[1]); return; }
    if (request.method === "POST" && url.pathname === "/api/jobs") return createJob(response);
    if (request.method === "GET" && url.pathname === "/api/jobs") return json(response, 200, [...jobs.values()].map(publicJob).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).slice(0, 10));
    if (request.method === "GET" && url.pathname === "/api/captures") return json(response, 200, await listCaptures());
    const image = url.pathname.match(/^\/api\/captures\/([a-f0-9-]{36})\/image$/);
    if (request.method === "GET" && image) { try { return send(response, 200, "image/png", await fsp.readFile(path.join(dataDirectory, image[1], "screen.png")), { "Cache-Control": "private, no-store" }); } catch { return json(response, 404, { error: "Capture not found." }); } }
    const deletion = url.pathname.match(/^\/api\/captures\/([a-f0-9-]{36})$/);
    if (request.method === "DELETE" && deletion) { await fsp.rm(path.join(dataDirectory, deletion[1]), { recursive: true, force: true }); return json(response, 200, { ok: true }); }
    json(response, 404, { error: "Not found." });
  } catch (error) {
    console.error(error);
    if (!response.headersSent) json(response, 500, { error: "Internal server error." }); else response.end();
  }
});

server.listen(port, host, () => console.log(`Screen Codex website listening at http://${host}:${port}`));
