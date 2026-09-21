#!/usr/bin/env node
/*
 * KTV 点歌台 / KTV Queue: server
 * Runs on the host's laptop. No npm packages needed, only Node.js 18 or newer.
 *   node server.js            (default port 3000)
 *   node server.js 8080       (custom port)
 */
'use strict';

if (typeof fetch !== 'function') {
  console.error('\n需要 Node.js 18 或更新版本。请到 https://nodejs.cn 下载“LTS”版本。\nNode.js 18 or newer is required. Download the LTS version from https://nodejs.org\n');
  process.exit(1);
}

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');

const PORT = parseInt(process.argv[2] || process.env.PORT, 10) || 3000;
const DATA_FILE = process.env.KTV_DATA || path.join(__dirname, 'data.json');
const INDEX_FILE = path.join(__dirname, 'index.html');
const BILI_API = process.env.KTV_BILI_API || 'https://api.bilibili.com';
const ROOM_TTL = 3 * 24 * 3600 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/* Link parsing (mirrors the copy in index.html, used as the authority) */
/* ------------------------------------------------------------------ */
function parseLink(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (!u.hostname.includes('.')) return null;
  const host = u.hostname.replace(/^(www|m)\./, '');

  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    if (id) return { kind: 'youtube', ref: id, url: u.href };
  }
  if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
    let id = u.searchParams.get('v');
    const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{6,})/);
    if (!id && m) id = m[2];
    if (id) return { kind: 'youtube', ref: id, url: u.href };
  }
  if (/(^|\.)bilibili\.com$/.test(host) || host === 'b23.tv') {
    const bv = (u.pathname + u.search).match(/BV[0-9A-Za-z]{10}/);
    const page = parseInt(u.searchParams.get('p'), 10) || 1;
    if (bv) return { kind: 'bilibili', ref: bv[0], page, url: u.href };
    const av = u.pathname.match(/\/av(\d+)/i);
    if (av) return { kind: 'bilibili', ref: 'av' + av[1], page, url: u.href };
    if (host === 'b23.tv') return { kind: 'link', ref: '', url: u.href, short: true };
  }
  if (/\.(mp4|webm|ogv|mov)$/i.test(u.pathname)) return { kind: 'file', ref: '', url: u.href };
  return { kind: 'link', ref: '', url: u.href };
}

/* ------------------------------------------------------------------ */
/* Looking up titles and lengths (best effort, never blocks adding)     */
/* ------------------------------------------------------------------ */
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
           (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(h)) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  return false;
}

async function httpGet(url, { timeout = 5000, maxBytes = 262144, referer } = {}) {
  let cur = url;
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(cur);
    if (!/^https?:$/.test(u.protocol) || (isPrivateHost(u.hostname) && !cur.startsWith(BILI_API))) throw new Error('blocked');
    const res = await fetch(cur, {
      redirect: 'manual', signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...(referer ? { Referer: referer } : {}) }
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      cur = new URL(res.headers.get('location'), cur).href;
      continue;
    }
    return { res, finalUrl: cur, read: () => readLimited(res, maxBytes) };
  }
  throw new Error('too many redirects');
}

async function readLimited(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = []; let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); total += value.length;
  }
  try { await reader.cancel(); } catch (e) { /* already closed */ }
  return Buffer.concat(chunks.map(c => Buffer.from(c)));
}

function decodeHtml(buf, contentType) {
  let label = (/charset=([\w-]+)/i.exec(contentType || '') || [])[1];
  if (!label) label = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1')) || [])[1];
  try { return new TextDecoder(label || 'utf-8').decode(buf); } catch (e) { return buf.toString('utf8'); }
}

function pageTitle(html) {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html);
  const tt = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  const raw = (og && og[1]) || (tt && tt[1]) || '';
  return raw.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim().slice(0, 100);
}

const metaCache = new Map();
async function resolveMeta(p) {
  if (metaCache.has(p.url)) return metaCache.get(p.url);
  let out = { parsed: p, title: '', dur: 0 };
  try {
    if (p.short) {
      // b23.tv short link: follow the redirect to find the real video address
      const { finalUrl, res } = await httpGet(p.url, { timeout: 5000 });
      try { await res.body.cancel(); } catch (e) { /* ignore */ }
      const q = parseLink(finalUrl);
      if (q) { out.parsed = q; p = q; }
    }
    if (p.kind === 'bilibili') {
      const qs = p.ref.startsWith('av') ? 'aid=' + p.ref.slice(2) : 'bvid=' + p.ref;
      const { read } = await httpGet(BILI_API + '/x/web-interface/view?' + qs, { referer: 'https://www.bilibili.com/' });
      const j = JSON.parse((await read()).toString('utf8'));
      if (j && j.code === 0 && j.data) {
        out.title = String(j.data.title || '').slice(0, 100);
        const pg = (j.data.pages || [])[(p.page || 1) - 1];
        out.dur = Number((pg && pg.duration) || j.data.duration) || 0;
      }
    } else if (p.kind === 'youtube') {
      const { read } = await httpGet('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(p.url), { timeout: 3500 });
      out.title = String(JSON.parse((await read()).toString('utf8')).title || '').slice(0, 100);
    } else if (p.kind === 'link') {
      const g = await httpGet(p.url, { timeout: 4500 });
      if (/text\/html/i.test(g.res.headers.get('content-type') || '')) {
        out.title = pageTitle(decodeHtml(await g.read(), g.res.headers.get('content-type')));
      } else { try { await g.res.body.cancel(); } catch (e) { /* ignore */ } }
    }
  } catch (e) { /* lookups are optional */ }
  if (out.title || out.dur) {
    metaCache.set(p.url, out);
    if (metaCache.size > 300) metaCache.delete(metaCache.keys().next().value);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Rooms                                                               */
/* ------------------------------------------------------------------ */
let rooms = {};
try { rooms = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).rooms || {}; } catch (e) { rooms = {}; }
for (const c of Object.keys(rooms)) if (Date.now() - (rooms[c].active || 0) > ROOM_TTL) delete rooms[c];

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify({ rooms })); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); }
    catch (e) { console.error('Could not save data:', e.message); }
  }, 400);
}
function flushNow() { try { fs.writeFileSync(DATA_FILE, JSON.stringify({ rooms })); } catch (e) { /* ignore */ } }
process.on('exit', flushNow);
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => process.on(sig, () => { flushNow(); process.exit(0); }));

const clients = new Map(); // code -> Set<{res, device, token}>
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
const newId = () => crypto.randomBytes(5).toString('hex');
const newToken = () => crypto.randomBytes(12).toString('hex');
const isHostToken = (room, token) => !!token && room.tokens.includes(token);

function view(room, device, host) {
  const songs = Object.values(room.songs).map(s => {
    const v = room.votes[s.id] || [];
    const o = {
      id: s.id, title: s.title, url: s.url, kind: s.kind, ref: s.ref, page: s.page || 0, dur: s.dur || 0,
      order: s.order, played: !!s.played, playedAt: s.playedAt || 0,
      votes: v.length, voted: v.includes(device), mine: s.by === device
    };
    if (host) o.requester = s.requester || '';   // only the host ever receives names
    return o;
  }).sort((a, b) => a.order - b.order);
  return { code: room.code, rev: room.rev, now: room.now, songs, host, t: Date.now() };
}

function broadcast(room) {
  const set = clients.get(room.code);
  if (!set) return;
  for (const c of set) {
    try { c.res.write('data: ' + JSON.stringify(view(room, c.device, isHostToken(room, c.token))) + '\n\n'); } catch (e) { /* closed */ }
  }
}
function touch(room) { room.rev++; room.active = Date.now(); save(); broadcast(room); }

const queueOf = room => Object.values(room.songs)
  .filter(s => !s.played && s.id !== room.now).sort((a, b) => a.order - b.order);
let lastOrder = 0;
const nextOrder = () => (lastOrder = Math.max(Date.now(), lastOrder + 1));

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */
class ApiError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status || 400; } }

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 65536) { reject(new ApiError('too_big', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new ApiError('bad_request')); } });
    req.on('error', reject);
  });
}

const attempts = new Map(); // ip -> [timestamps]
function rateLimit(ip, max) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter(t => now - t < 60000);
  if (list.length >= max) throw new ApiError('too_many', 429);
  list.push(now); attempts.set(ip, list);
}

function lanUrls() {
  const bad = /virtual|vmware|vbox|docker|hyper-v|vethernet|wsl|utun|tun|tap|vpn|loopback|bridge|awdl|llw/i;
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) {
        const ip = a.address;
        let score = ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
        if (bad.test(name)) score += 10;
        list.push({ url: `http://${ip}:${PORT}`, name, score });
      }
    }
  }
  return list.sort((a, b) => a.score - b.score).map(x => x.url);
}

const getRoom = code => {
  const room = rooms[String(code || '').toUpperCase()];
  if (!room) throw new ApiError('no_room', 404);
  return room;
};

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
async function handleApi(req, res, url) {
  const route = url.pathname;
  const ip = req.socket.remoteAddress || '';
  const q = url.searchParams;

  if (req.method === 'GET') {
    if (route === '/api/info') return json(res, 200, { lan: lanUrls(), port: PORT });

    if (route === '/api/state') {
      const room = getRoom(q.get('room'));
      return json(res, 200, view(room, q.get('device') || '', isHostToken(room, q.get('token'))));
    }

    if (route === '/api/events') {
      const room = getRoom(q.get('room'));
      const client = { res, device: q.get('device') || '', token: q.get('token') || '' };
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
      });
      res.write('retry: 2000\n\n');
      res.write('data: ' + JSON.stringify(view(room, client.device, isHostToken(room, client.token))) + '\n\n');
      if (!clients.has(room.code)) clients.set(room.code, new Set());
      clients.get(room.code).add(client);
      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* closed */ } }, 15000);
      req.on('close', () => { clearInterval(beat); const s = clients.get(room.code); if (s) s.delete(client); });
      return;
    }

    if (route === '/api/resolve') {
      const p = parseLink(q.get('url'));
      if (!p) throw new ApiError('bad_link');
      const m = await resolveMeta(p);
      return json(res, 200, { kind: m.parsed.kind, ref: m.parsed.ref, page: m.parsed.page || 0, url: m.parsed.url, short: !!m.parsed.short, title: m.title, dur: m.dur });
    }
    throw new ApiError('not_found', 404);
  }

  if (req.method !== 'POST') throw new ApiError('not_found', 404);
  const b = await readBody(req);

  if (route === '/api/create') {
    const pin = String(b.pin || '').trim();
    if (pin.length < 4 || pin.length > 12) throw new ApiError('pin_short');
    let code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (code) { if (rooms[code]) throw new ApiError('room_exists'); }
    else { do { code = newCode(); } while (rooms[code]); }
    const token = newToken();
    rooms[code] = { code, pin, tokens: [token], songs: {}, votes: {}, trash: {}, now: null, rev: 0, created: Date.now(), active: Date.now() };
    touch(rooms[code]);
    return json(res, 200, { code, token });
  }

  if (route === '/api/host') {
    rateLimit(ip, 10);
    const room = getRoom(b.code);
    if (String(b.pin || '').trim() !== room.pin) throw new ApiError('bad_pin', 403);
    const token = newToken();
    room.tokens.push(token); if (room.tokens.length > 10) room.tokens.shift();
    save();
    return json(res, 200, { code: room.code, token });
  }

  const room = getRoom(b.room);
  const host = isHostToken(room, b.token);
  const device = String(b.device || '').slice(0, 40);

  if (route === '/api/add') {
    if (!device) throw new ApiError('bad_request');
    let p = parseLink(b.url);
    if (!p) throw new ApiError('bad_link');
    const meta = await resolveMeta(p);
    p = meta.parsed;
    const title = String(b.title || '').trim().slice(0, 100) || meta.title;
    if (!title) throw new ApiError('need_title');
    const dup = Object.values(room.songs).some(s => !s.played &&
      ((p.ref && s.kind === p.kind && s.ref === p.ref && (s.page || 1) === (p.page || 1)) || s.url === p.url));
    if (dup) throw new ApiError('dup');
    const id = newId();
    room.songs[id] = {
      id, title, url: p.url, kind: p.kind, ref: p.ref || '', page: p.page || 0, dur: meta.dur || 0,
      by: device, requester: String(b.name || '').trim().slice(0, 24), order: nextOrder(), t: Date.now(), played: false
    };
    touch(room);
    return json(res, 200, { id });
  }

  if (route === '/api/vote') {
    const s = room.songs[b.id];
    if (!s || !device) throw new ApiError('bad_request');
    const set = new Set(room.votes[s.id] || []);
    if (b.on) set.add(device); else set.delete(device);
    room.votes[s.id] = [...set];
    touch(room);
    return json(res, 200, { ok: true });
  }

  if (route === '/api/remove') {
    const s = room.songs[b.id];
    if (!s) throw new ApiError('bad_request');
    if (!host && s.by !== device) throw new ApiError('forbidden', 403);
    room.trash[s.id] = { song: s, votes: room.votes[s.id] || [] };
    const keys = Object.keys(room.trash); if (keys.length > 30) delete room.trash[keys[0]];
    delete room.songs[s.id]; delete room.votes[s.id];
    if (room.now === s.id) room.now = null;
    touch(room);
    return json(res, 200, { ok: true });
  }

  if (route === '/api/restore') {
    const t = room.trash[b.id];
    if (!t) throw new ApiError('bad_request');
    if (!host && t.song.by !== device) throw new ApiError('forbidden', 403);
    room.songs[t.song.id] = t.song; room.votes[t.song.id] = t.votes; delete room.trash[b.id];
    touch(room);
    return json(res, 200, { ok: true });
  }

  /* everything below is host-only */
  if (!host) throw new ApiError('forbidden', 403);

  if (route === '/api/order') {
    const valid = new Set(queueOf(room).map(s => s.id));
    const ids = (Array.isArray(b.ids) ? b.ids : []).filter(id => valid.has(id));
    ids.forEach((id, i) => { room.songs[id].order = (i + 1) * 1000; });
    touch(room);
    return json(res, 200, { ok: true });
  }

  if (route === '/api/advance') {
    const cur = room.songs[room.now];
    if (cur && !cur.played) { cur.played = true; cur.playedAt = Date.now(); }
    const next = queueOf(room)[0];
    room.now = next ? next.id : null;
    touch(room);
    return json(res, 200, { now: room.now });
  }

  if (route === '/api/stop') {
    room.now = null;   // the song returns to its place in the queue
    touch(room);
    return json(res, 200, { ok: true });
  }

  throw new ApiError('not_found', 404);
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(INDEX_FILE));
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof ApiError) return json(res, e.status, { error: e.code });
    console.error(e);
    json(res, 500, { error: 'server' });
  }
});
server.keepAliveTimeout = 65000;

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\n端口 ${PORT} 已被占用。可以换一个：node server.js 8080\nPort ${PORT} is in use. Try another: node server.js 8080\n`);
  else console.error(e);
  process.exit(1);
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const urls = lanUrls();
    console.log('\n  KTV 点歌台已启动 / KTV Queue is running\n');
    console.log('  主持人（这台电脑）请打开 / Host, open on this computer:');
    console.log(`    http://localhost:${PORT}\n`);
    if (urls.length) {
      console.log('  朋友们会通过二维码加入，手机需要连上同一个 WiFi / Guests join by QR code on the same WiFi:');
      urls.forEach(u => console.log('    ' + u));
    } else {
      console.log('  没有检测到局域网地址，请先让电脑连上 WiFi。/ No network address found. Connect this computer to WiFi.');
    }
    console.log('\n  按 Ctrl+C 停止 / Press Ctrl+C to stop\n');
  });
}

module.exports = { server, parseLink, resolveMeta, rooms };
