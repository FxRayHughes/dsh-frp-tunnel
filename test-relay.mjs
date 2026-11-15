import http from 'node:http';
import assert from 'node:assert/strict';
import { startRelay } from './relay.js';
import { buildFrpcToml, publicBaseUrl, scrub } from './frpc.js';

// Upstream echoes the headers it saw, so we can assert the rewrite.
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      method: req.method,
      url: req.url,
      host: req.headers.host,
      origin: req.headers.origin ?? null,
      referer: req.headers.referer ?? null,
      authorization: req.headers.authorization ?? null,
      body,
    }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;

const get = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });

// 1. No Basic layer: Host/Origin rewritten to loopback, auth header stripped.
{
  const relay = await startRelay({ upstreamOrigin, warn: (m) => console.log('warn:', m) });
  const r = await get(relay.port, '/api/foo?x=1', {
    host: 'tunnel.example.com',
    origin: 'https://tunnel.example.com',
    referer: 'https://tunnel.example.com/page?q=1',
    authorization: 'Bearer leak-me',
  });
  const seen = JSON.parse(r.body);
  assert.equal(r.status, 200);
  assert.equal(seen.host, new URL(upstreamOrigin).host, 'Host rewritten to loopback');
  assert.equal(seen.origin, upstreamOrigin, 'Origin rewritten to loopback');
  assert.equal(seen.referer, `${upstreamOrigin}/page?q=1`, 'Referer rewritten, path kept');
  assert.equal(seen.authorization, null, 'client auth header stripped');
  assert.equal(seen.url, '/api/foo?x=1', 'path and query preserved');
  await relay.close();
  console.log('ok: no-auth rewrite');
}

// 2. Basic layer enforces credentials, then strips the header upstream.
{
  const relay = await startRelay({
    upstreamOrigin,
    username: 'dsh',
    password: 'p@ss:word',
    warn: (m) => console.log('warn:', m),
  });
  const denied = await get(relay.port, '/');
  assert.equal(denied.status, 401);
  assert.match(denied.headers['www-authenticate'], /Basic/);
  const wrong = await get(relay.port, '/', { authorization: `Basic ${Buffer.from('dsh:nope').toString('base64')}` });
  assert.equal(wrong.status, 401);
  const ok = await get(relay.port, '/', {
    authorization: `Basic ${Buffer.from('dsh:p@ss:word').toString('base64')}`,
  });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).authorization, null);
  await relay.close();
  console.log('ok: basic auth');
}

// 3. POST body passes through.
{
  const relay = await startRelay({ upstreamOrigin, warn: () => {} });
  const body = JSON.stringify({ hello: '世界' });
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: relay.port, path: '/api', method: 'POST', headers: { 'content-type': 'application/json' } },
      (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => resolve(d));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(JSON.parse(res).body, body);
  await relay.close();
  console.log('ok: post body');
}

// 4. Upgrade (WebSocket) rewrite — fake upstream that answers the handshake.
{
  const { default: net } = await import('node:net');
  const ws = net.createServer((socket) => {
    socket.once('data', (buf) => {
      const head = buf.toString('utf8');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.write(JSON.stringify({ host: /host: (.*)/i.exec(head)?.[1]?.trim() ?? null }));
    });
  });
  await new Promise((r) => ws.listen(0, '127.0.0.1', r));
  const wsOrigin = `http://127.0.0.1:${ws.address().port}`;
  const relay = await startRelay({ upstreamOrigin: wsOrigin, warn: () => {} });
  const got = await new Promise((resolve, reject) => {
    const sock = net.connect(relay.port, '127.0.0.1', () => {
      sock.write(
        'GET /api/stream HTTP/1.1\r\nHost: tunnel.example.com\r\nOrigin: https://tunnel.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
    });
    let data = '';
    sock.on('data', (c) => { data += c; if (data.includes('}')) { sock.destroy(); resolve(data); } });
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); resolve(data); }, 1500);
  });
  assert.match(got, /101/, 'upgrade accepted');
  assert.ok(got.includes(new URL(wsOrigin).host), 'upgrade Host rewritten to loopback');
  await relay.close();
  await new Promise((r) => ws.close(r));
  console.log('ok: upgrade rewrite');
}

// 5. TOML shape.
{
  const toml = buildFrpcToml(
    {
      serverAddr: 'frp.example.com', serverPort: 7000, user: 'ray', authToken: 'a"b\\c',
      tls: true, proxyType: 'tcp', remotePort: 6080, customDomain: '', subdomain: '',
      proxyName: 'dsh-web', metadatas: { from: 'dsh' },
    },
    5555,
  );
  assert.match(toml, /serverAddr = "frp\.example\.com"/);
  assert.match(toml, /auth\.token = "a\\"b\\\\c"/, 'token escaped for TOML');
  assert.match(toml, /localPort = 5555/);
  assert.match(toml, /remotePort = 6080/);
  assert.match(toml, /type = "tcp"/);
  assert.match(toml, /\[metadatas\]/);

  const httpToml = buildFrpcToml(
    { serverAddr: 'h', serverPort: 7000, user: '', authToken: '', tls: false,
      proxyType: 'http', remotePort: 0, customDomain: 'dsh.example.com', subdomain: '',
      proxyName: 'p' },
    6666,
  );
  assert.match(httpToml, /customDomains = \["dsh\.example\.com"\]/);
  assert.doesNotMatch(httpToml, /remotePort/);
  assert.doesNotMatch(httpToml, /auth\.token/);

  assert.equal(publicBaseUrl({ proxyType: 'tcp', serverAddr: 'frp.example.com', remotePort: 6080 }), 'http://frp.example.com:6080/');
  assert.equal(publicBaseUrl({ proxyType: 'http', serverAddr: 'x', customDomain: 'd.example.com' }), 'http://d.example.com/');
  assert.equal(publicBaseUrl({ proxyType: 'tcp', serverAddr: 'x', remotePort: 1, publicUrl: 'https://my.example.com/' }), 'https://my.example.com/');
  assert.equal(scrub('auth.token = "s3cret" ?token=abc', ['s3cret']), 'auth.token = "***" ?token=***');
  console.log('ok: toml + url + scrub');
}

// 6. frpc accepts the generated config (validates our TOML for real).
{
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'frp-test-'));
  const file = join(dir, 'frpc.toml');
  const toml = buildFrpcToml(
    { serverAddr: '127.0.0.1', serverPort: 1, user: 'u', authToken: 'tok',
      tls: true, proxyType: 'tcp', remotePort: 6080, customDomain: '', subdomain: '',
      proxyName: 'dsh-web' },
    5555,
  );
  await writeFile(file, toml);
  const ok = await new Promise((resolve) => {
    execFile('/opt/homebrew/bin/frpc', ['verify', '-c', file], (err, stdout, stderr) =>
      resolve(`${err ? 'FAIL' : 'PASS'} ${stdout}${stderr}`));
  });
  console.log('frpc verify:', ok.trim());
  assert.match(ok, /PASS|syntax is ok/i);
}

// 6. Stable login: credentials → gate cookie → current token link; no token on the client.
{
  // Upstream that behaves like DSH: 401 for HTML without its cookie or a token.
  const dsh = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('token') === 'T1') {
      res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-x=ok; Path=/' });
      res.end();
      return;
    }
    if (!String(req.headers.cookie ?? '').includes('dsh-auth-x=ok')) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
  });
  await new Promise((r) => dsh.listen(0, '127.0.0.1', r));
  const relay = await startRelay({
    upstreamOrigin: `http://127.0.0.1:${dsh.address().port}`,
    username: 'dsh',
    password: 'secret',
    warn: () => {},
    loginTarget: () => '/?token=T1',
  });
  const post = (body, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: relay.port, path: '/__frp/login', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } },
        (r) => {
          let d = '';
          r.on('data', (c) => (d += c));
          r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: d }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  const page = await get(relay.port, '/', { accept: 'text/html' });
  assert.equal(page.status, 302, 'browser without gate is sent to login');
  assert.equal(page.headers.location, '/__frp/login');
  const form = await get(relay.port, '/__frp/login');
  assert.equal(form.status, 200);
  assert.match(form.body, /<form/);

  const bad = await post('user=dsh&password=nope');
  assert.equal(bad.status, 401);
  const good = await post('user=dsh&password=secret');
  assert.equal(good.status, 200, 'form login answers a same-origin continue page, not a cross-site redirect');
  assert.match(good.body, /location\.replace\("\/\?token=T1"\)/, 'continue page goes to the current token link');
  const gate = good.headers['set-cookie'][0].split(';')[0];
  assert.match(gate, /^frp_gate=/);

  const json = await post(JSON.stringify({ user: 'dsh', password: 'secret' }), { 'content-type': 'application/json' });
  assert.equal(json.status, 200);
  assert.deepEqual(JSON.parse(json.body), { ok: true, location: '/?token=T1' });

  // Gate cookie alone passes; DSH 401 on a page load recovers through the token.
  const stale = await get(relay.port, '/', { accept: 'text/html', cookie: `${gate}; dsh-auth-x=old` });
  assert.equal(stale.status, 302, 'stale DSH cookie recovers via current token');
  assert.equal(stale.headers.location, '/?token=T1');
  const minted = await get(relay.port, '/?token=T1', { accept: 'text/html', cookie: gate });
  assert.equal(minted.status, 303);
  const dshCookie = minted.headers['set-cookie'][0].split(';')[0];
  const final = await get(relay.port, '/', { accept: 'text/html', cookie: `${gate}; ${dshCookie}` });
  assert.equal(final.status, 200);
  assert.equal(JSON.parse(final.body).cookie, dshCookie, 'gate cookie never reaches DSH');

  // API calls without the gate still get a plain 401, not a redirect.
  const api = await get(relay.port, '/api/x');
  assert.equal(api.status, 401);

  // Brute force is throttled per client address.
  for (let i = 0; i < 8; i += 1) await post('user=dsh&password=x', { 'x-real-ip': '9.9.9.9' });
  const locked = await post('user=dsh&password=secret', { 'x-real-ip': '9.9.9.9' });
  assert.equal(locked.status, 429, 'locked out after repeated failures');
  const other = await post('user=dsh&password=secret', { 'x-real-ip': '8.8.8.8' });
  assert.equal(other.status, 200, 'other clients unaffected');

  await relay.close();
  dsh.close();
  console.log('ok: stable login + gate cookie + token recovery + throttle');
}

// 7. Phone layer: injected into gated HTML only, assets served, encodings respected.
{
  const page = '<!doctype html><html><head><title>x</title></head><body><div id="root"></div></body></html>';
  const seen = [];
  const dsh = http.createServer((req, res) => {
    seen.push(req.headers['accept-encoding'] ?? null);
    if (req.url === '/gz') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end('compressed-bytes');
      return;
    }
    if (req.url.startsWith('/api')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"a":1}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"abc"', 'transfer-encoding': 'chunked' });
    res.write(page.slice(0, 20));
    res.end(page.slice(20));
  });
  await new Promise((r) => dsh.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${dsh.address().port}`;
  const relay = await startRelay({ upstreamOrigin: origin, username: 'dsh', password: 'secret', warn: () => {}, mobile: true });
  const base = `http://127.0.0.1:${relay.port}`;
  const basic = 'Basic ' + Buffer.from('dsh:secret').toString('base64');
  const get = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      http.get(base + path, { headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on('error', reject);
    });

  const html = await get('/', { authorization: basic, accept: 'text/html', 'accept-encoding': 'gzip, br' });
  assert.equal(html.status, 200);
  assert.match(html.body, /<link rel="stylesheet" href="\/__frp\/mobile\.css\?v=[0-9a-f]{10}" data-dsh-mobile><script src="\/__frp\/mobile\.js\?v=[0-9a-f]{10}" data-dsh-mobile><\/script><\/head>/);
  assert.equal(Number(html.headers['content-length']), Buffer.byteLength(html.body), 'length recomputed');
  assert.equal(html.headers.etag, undefined, 'stale etag dropped');
  assert.equal(seen.at(-1), 'identity', 'page fetched uncompressed for injection');

  const api = await get('/api/x', { authorization: basic, accept: 'application/json', 'accept-encoding': 'gzip' });
  assert.equal(api.body, '{"a":1}', 'non-HTML untouched');
  assert.equal(seen.at(-1), 'gzip', 'API keeps client encoding');

  const gz = await get('/gz', { authorization: basic, accept: 'text/html' });
  assert.equal(gz.body, 'compressed-bytes', 'encoded upstream body is never rewritten');

  const css = await get(html.body.match(/\/__frp\/mobile\.css\?v=\w+/)[0]);
  assert.equal(css.status, 200, 'assets need no credentials');
  assert.match(css.headers['content-type'], /text\/css/);
  assert.match(css.headers['cache-control'], /immutable/);
  assert.match(css.body, /html\.dsh-m/);
  const js = await get('/__frp/mobile.js');
  assert.match(js.headers['content-type'], /javascript/);
  assert.match(js.body, /__DSH_MOBILE__/);
  assert.equal((await get('/__frp/mobile.txt')).status, 404);

  await relay.close();
  const off = await startRelay({ upstreamOrigin: origin, username: 'dsh', password: 'secret', warn: () => {} });
  const plain = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${off.port}/`, { headers: { authorization: basic, accept: 'text/html' } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ body, status: res.statusCode }));
    });
  });
  assert.equal(plain.body, page, 'no injection when the layer is off');
  assert.equal((await new Promise((r) => http.get(`http://127.0.0.1:${off.port}/__frp/mobile.css`, r))).statusCode, 404);
  await off.close();
  dsh.close();
  console.log('ok: phone layer injection');
}

// --- phone P2P: proxies in the frpc config, settings only behind the gate ---
{
  const { p2pProxies } = await import('./frpc.js');
  const base = { serverAddr: 'f.example', serverPort: 7000, tls: true, proxyType: 'tcp', remotePort: 6080, proxyName: 'dsh-web', tunnelPassword: 'pw' };
  const toml = buildFrpcToml(base, 4321);
  assert.match(toml, /name = "dsh-web-p2p"\ntype = "xtcp"/);
  assert.match(toml, /name = "dsh-web-p2p-s"\ntype = "stcp"/);
  assert.equal((toml.match(/localPort = 4321/g) ?? []).length, 3);
  assert.equal(p2pProxies({ ...base, tunnelPassword: '' }), undefined, 'no P2P without a gate password');
  assert.equal(p2pProxies({ ...base, p2p: false }), undefined);
  assert.doesNotMatch(buildFrpcToml({ ...base, p2p: false }, 1), /xtcp/);
  assert.notEqual(p2pProxies(base).secretKey, p2pProxies({ ...base, tunnelPassword: 'other' }).secretKey);

  const info = { serverAddr: 'f.example', token: 'tok', proxy: 'dsh-web-p2p', secretKey: 'k' };
  const relay = await startRelay({ upstreamOrigin, username: 'dsh', password: 'secret', warn: () => {}, p2p: () => info });
  const ask = (headers) =>
    new Promise((resolve) => http.get(`http://127.0.0.1:${relay.port}/__frp/p2p`, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }));
  const anon = await ask({});
  assert.equal(anon.status, 401, 'P2P settings need the login');
  assert.doesNotMatch(anon.body, /tok/);
  const authed = await ask({ authorization: 'Basic ' + Buffer.from('dsh:secret').toString('base64') });
  assert.equal(authed.status, 200);
  assert.deepEqual(JSON.parse(authed.body), { ok: true, ...info });
  await relay.close();
  const none = await startRelay({ upstreamOrigin, username: 'dsh', password: 'secret', warn: () => {} });
  const missing = await new Promise((resolve) => http.get(`http://127.0.0.1:${none.port}/__frp/p2p`, { headers: { authorization: 'Basic ' + Buffer.from('dsh:secret').toString('base64') } }, (res) => { res.resume(); resolve(res.statusCode); }));
  assert.equal(missing, 404);
  await none.close();
  console.log('ok: phone P2P settings');
}

upstream.close();
console.log('\nALL RELAY TESTS PASSED');
