import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Loopback relay in front of the DSH web listener.
 *
 * frpc forwards public traffic here. The relay rewrites `Host` and `Origin`
 * to the loopback authority so the DSH browser-trust fence and the
 * authority-bound auth cookie keep working without widening `trustedHosts`.
 * An optional HTTP Basic layer guards the tunnel before any DSH route runs.
 */

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const GATE_COOKIE = 'frp_gate';
const LOGIN_PATH = '/__frp/login';
const GATE_MAX_AGE = 30 * 24 * 3600;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 8;

const MOBILE_PREFIX = '/__frp/mobile.';
const P2P_PATH = '/__frp/p2p';
/** Largest DSH HTML document the relay will buffer to inject the phone layer. */
const INJECT_LIMIT = 4 * 1024 * 1024;

/**
 * Phone layer assets, read once per relay start so a plugin reload picks up
 * edits. The content hash versions the URLs, so browsers may cache them forever.
 */
function loadMobileAssets() {
  const read = (name) => readFileSync(new URL(`./mobile/${name}`, import.meta.url));
  const css = read('mobile.css');
  const js = read('mobile.js');
  const version = createHash('sha256').update(css).update(js).digest('hex').slice(0, 10);
  const tags =
    `<link rel="stylesheet" href="/__frp/mobile.css?v=${version}" data-dsh-mobile>` +
    `<script src="/__frp/mobile.js?v=${version}" data-dsh-mobile></script>`;
  return {
    tags: Buffer.from(tags),
    files: {
      css: { body: css, type: 'text/css; charset=utf-8' },
      js: { body: js, type: 'text/javascript; charset=utf-8' },
    },
  };
}

/** Insert the phone layer right before `</head>` (or at the top of `<body>` as a fallback). */
export function injectMobile(htmlBuffer, tags) {
  const text = htmlBuffer.toString('latin1');
  if (text.includes('data-dsh-mobile')) return htmlBuffer;
  let at = text.search(/<\/head\s*>/i);
  if (at < 0) {
    const body = text.search(/<body[^>]*>/i);
    if (body < 0) return htmlBuffer;
    at = text.indexOf('>', body) + 1;
  }
  return Buffer.concat([htmlBuffer.subarray(0, at), tags, htmlBuffer.subarray(at)]);
}

/** Stable gate value: changes whenever the credentials change, survives DSH restarts. */
function gateValue(username, password) {
  return createHmac('sha256', password).update(`frp-gate:${username}`).digest('base64url');
}

function readCookie(header, name) {
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function makeAuthCheck(username, password) {
  if (!password) return () => true;
  const expected = `${username}:${password}`;
  const gate = gateValue(username, password);
  return (headers) => {
    const cookie = readCookie(headers.cookie, GATE_COOKIE);
    if (cookie !== undefined && safeEqual(cookie, gate)) return true;
    const header = headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    return safeEqual(decoded, expected);
  };
}

/** Client address as the edge proxy reports it; frpc always connects from loopback. */
function clientAddress(req) {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function wantsHtml(req) {
  return req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html');
}

function isSecure(req) {
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCredentials(body, contentType) {
  if (String(contentType ?? '').includes('application/json')) {
    try {
      const value = JSON.parse(body);
      return { user: String(value.user ?? ''), password: String(value.password ?? '') };
    } catch {
      return { user: '', password: '' };
    }
  }
  const params = new URLSearchParams(body);
  return { user: params.get('user') ?? '', password: params.get('password') ?? '' };
}

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Same-origin hop after login; the onward navigation is initiated by this site. */
function continuePage(location) {
  const target = JSON.stringify(location).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>正在进入 DSH…</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,system-ui,sans-serif;background:#0f1115;color:#8a91a0}</style>
</head><body>正在进入 DSH…
<script>location.replace(${target});</script>
<noscript><a href="${escapeHtml(location)}">继续</a></noscript>
</body></html>`;
}

function loginPage(message = '') {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 登录</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,system-ui,sans-serif;background:#0f1115;color:#e8eaf0}
form{width:min(320px,88vw);display:flex;flex-direction:column;gap:12px}
h1{font-size:20px;margin:0 0 8px}
input,button{font-size:16px;padding:12px;border-radius:8px;border:1px solid #2c313c;background:#171a21;color:inherit}
button{background:#4d6bfe;border-color:#4d6bfe;font-weight:600}
p{margin:0;color:#ff7b7b;font-size:14px;min-height:18px}
</style></head><body>
<form method="post" action="${LOGIN_PATH}">
<h1>DeepSeek Harness</h1>
<input name="user" placeholder="用户名" autocomplete="username" autocapitalize="none" required>
<input name="password" type="password" placeholder="密码" autocomplete="current-password" required>
<button type="submit">登录</button>
<p>${escapeHtml(message)}</p>
</form></body></html>`;
}

/** Rewrite request headers so the upstream sees a loopback request. */
function rewriteHeaders(headers, upstreamHost, upstreamOrigin) {
  // Every relayed browser is somewhere else; plugins such as dsh-peer-link
  // then offer downloads and an in-page folder browser instead of launching
  // apps on this desktop. The relay always overwrites a client-sent value.
  const out = { ...headers, 'x-dsh-remote-viewer': 'frp' };
  out.host = upstreamHost;
  if (out.origin) out.origin = upstreamOrigin;
  if (out.referer) {
    try {
      const ref = new URL(out.referer);
      out.referer = upstreamOrigin + ref.pathname + ref.search;
    } catch {
      delete out.referer;
    }
  }
  // The relay terminates the Basic layer; never leak it upstream.
  delete out.authorization;
  delete out['proxy-authorization'];
  if (typeof out.cookie === 'string') {
    const kept = out.cookie
      .split(';')
      .filter((part) => part.split('=')[0].trim() !== GATE_COOKIE)
      .join(';')
      .trim();
    if (kept) out.cookie = kept;
    else delete out.cookie;
  }
  return out;
}

/**
 * Start the relay on 127.0.0.1 with an OS-assigned port.
 * @param {object} options
 * @param {string} options.upstreamOrigin - e.g. http://127.0.0.1:54220
 * @param {string} [options.username]
 * @param {string} [options.password] - empty disables Basic auth
 * @param {(msg: string) => void} options.warn
 * @param {() => string | undefined} [options.loginTarget] - path+query carrying the
 *   current DSH launch token (e.g. `/?token=…`); the stable login redirects there so
 *   clients never need the per-launch token.
 * @param {boolean} [options.mobile] - inject the phone layout + history layer
 *   (mobile/mobile.css, mobile/mobile.js) into DSH pages served through the tunnel.
 * @param {() => object | undefined} [options.p2p] - the phone app's P2P
 *   settings, served at `/__frp/p2p` to logged-in clients only.
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startRelay({ upstreamOrigin, username = 'dsh', password = '', warn, loginTarget, mobile = false, p2p }) {
  let assets;
  if (mobile) {
    try {
      assets = loadMobileAssets();
    } catch (error) {
      warn(`relay: phone layer unavailable: ${error.message}`);
    }
  }
  const upstream = new URL(upstreamOrigin);
  const upstreamHost = upstream.host;
  const upstreamPort = Number(upstream.port || 80);
  const upstreamHostname = upstream.hostname;
  const authorized = makeAuthCheck(username, password);
  const gate = password ? gateValue(username, password) : undefined;
  const expected = `${username}:${password}`;
  const failures = new Map();
  const sockets = new Set();

  const throttled = (address) => {
    const record = failures.get(address);
    if (!record) return false;
    if (Date.now() - record.since > FAIL_WINDOW_MS) {
      failures.delete(address);
      return false;
    }
    return record.count >= FAIL_LIMIT;
  };
  const recordFailure = (address) => {
    const record = failures.get(address);
    if (!record || Date.now() - record.since > FAIL_WINDOW_MS) failures.set(address, { count: 1, since: Date.now() });
    else record.count += 1;
  };

  const target = () => {
    const value = loginTarget?.();
    return typeof value === 'string' && value.startsWith('/') ? value : '/';
  };

  const gateCookie = (req) =>
    `${GATE_COOKIE}=${gate}; Path=/; Max-Age=${GATE_MAX_AGE}; HttpOnly; SameSite=Lax${isSecure(req) ? '; Secure' : ''}`;

  /** Stable login: credentials in, gate cookie + redirect to the current token link out. */
  async function handleLogin(req, res) {
    const address = clientAddress(req);
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(loginPage());
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST' });
      res.end();
      return;
    }
    if (throttled(address)) {
      res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '600' });
      res.end(loginPage('尝试次数过多，请 10 分钟后再试'));
      return;
    }
    let credentials;
    try {
      credentials = parseCredentials(await readBody(req), req.headers['content-type']);
    } catch {
      res.writeHead(413);
      res.end();
      return;
    }
    const json = String(req.headers['content-type'] ?? '').includes('application/json');
    if (!gate || !safeEqual(`${credentials.user}:${credentials.password}`, expected)) {
      recordFailure(address);
      warn(`relay: login refused from ${address}`);
      if (json) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '用户名或密码错误' }));
      } else {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        res.end(loginPage('用户名或密码错误'));
      }
      return;
    }
    failures.delete(address);
    const location = target();
    if (json) {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': gateCookie(req), 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, location }));
      return;
    }
    // Not a 303: when the form was posted from another site (the Android app's
    // bundled page) the whole redirect chain stays cross-site, and DSH's
    // SameSite=Strict session cookie would never be sent back — an endless
    // token loop. A same-origin page that navigates onward makes it same-site.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': gateCookie(req), 'cache-control': 'no-store' });
    res.end(continuePage(location));
  }

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === LOGIN_PATH) {
      handleLogin(req, res).catch((error) => {
        warn(`relay: login error: ${error.message}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      return;
    }
    if (path.startsWith(MOBILE_PREFIX)) {
      // Static and credential-free; served without the gate like any other CSS/JS.
      const file = assets?.files[path.slice(MOBILE_PREFIX.length)];
      if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': file.type,
        'content-length': file.body.length,
        'cache-control': 'public, max-age=31536000, immutable',
      });
      res.end(req.method === 'HEAD' ? undefined : file.body);
      return;
    }
    if (!authorized(req.headers)) {
      if (gate && wantsHtml(req)) {
        res.writeHead(302, { location: LOGIN_PATH, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="DSH", charset="UTF-8"' });
      res.end('Unauthorized');
      return;
    }
    if (path === P2P_PATH) {
      // Behind the gate: it holds the frps token, which the app's visitor needs to log in.
      const info = gate === undefined || req.method !== 'GET' ? undefined : p2p?.();
      res.writeHead(info ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(info ? { ok: true, ...info } : { ok: false }));
      return;
    }
    // Past the gate, a page load DSH refuses (no cookie yet, or one from an older
    // launch) is sent to the current token link so DSH mints a fresh cookie.
    const recoverToken = gate !== undefined && wantsHtml(req) && !new URL(req.url ?? '/', 'http://relay').searchParams.has('token');
    // Page loads are fetched uncompressed so the phone layer can be spliced in.
    const inject = assets !== undefined && req.method === 'GET' && wantsHtml(req);
    const headers = rewriteHeaders(req.headers, upstreamHost, upstream.origin);
    if (inject) headers['accept-encoding'] = 'identity';
    const proxyReq = http.request(
      {
        host: upstreamHostname,
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (proxyRes) => {
        const location = target();
        if (recoverToken && proxyRes.statusCode === 401 && location !== '/') {
          proxyRes.resume();
          res.writeHead(302, { location, 'cache-control': 'no-store' });
          res.end();
          return;
        }
        const encoding = String(proxyRes.headers['content-encoding'] ?? 'identity');
        const isHtml = String(proxyRes.headers['content-type'] ?? '').includes('text/html');
        if (!inject || proxyRes.statusCode !== 200 || !isHtml || encoding !== 'identity') {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
          return;
        }
        const chunks = [];
        let size = 0;
        let passthrough = false;
        proxyRes.on('data', (chunk) => {
          if (passthrough) return;
          size += chunk.length;
          chunks.push(chunk);
          if (size > INJECT_LIMIT) {
            // Too large to be the app shell; stream it through untouched.
            passthrough = true;
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            for (const part of chunks) res.write(part);
            proxyRes.pipe(res);
          }
        });
        proxyRes.on('end', () => {
          if (passthrough) return;
          const body = injectMobile(Buffer.concat(chunks), assets.tags);
          const out = { ...proxyRes.headers, 'content-length': String(body.length) };
          delete out['transfer-encoding'];
          delete out.etag; // the document differs from what DSH hashed
          res.writeHead(200, out);
          res.end(body);
        });
        proxyRes.on('error', () => res.destroy());
      },
    );
    proxyReq.on('error', (error) => {
      warn(`relay upstream error: ${error.message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on('aborted', () => proxyReq.destroy());
    req.pipe(proxyReq);
  });

  // WebSocket and other upgrades: replay the rewritten head, then splice sockets.
  server.on('upgrade', (req, socket, head) => {
    if (!authorized(req.headers)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="DSH"\r\n\r\n');
      return;
    }
    const upstreamSocket = net.connect(upstreamPort, upstreamHostname, () => {
      const headers = rewriteHeaders(req.headers, upstreamHost, upstream.origin);
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (const [key, value] of Object.entries(headers)) {
        for (const v of Array.isArray(value) ? value : [value]) raw += `${key}: ${v}\r\n`;
      }
      upstreamSocket.write(raw + '\r\n');
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    // Either side ending must tear down the other: `pipe` only forwards `end`,
    // so a `destroy()` on one side would otherwise leak the paired socket.
    const destroyBoth = () => {
      socket.destroy();
      upstreamSocket.destroy();
    };
    upstreamSocket.on('error', destroyBoth);
    socket.on('error', destroyBoth);
    upstreamSocket.on('close', destroyBoth);
    socket.on('close', destroyBoth);
    // Forward a graceful half-close instead of truncating the peer.
    socket.on('end', () => upstreamSocket.end());
    upstreamSocket.on('end', () => socket.end());
    sockets.add(socket);
    sockets.add(upstreamSocket);
    socket.on('close', () => sockets.delete(socket));
    upstreamSocket.on('close', () => sockets.delete(upstreamSocket));
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
