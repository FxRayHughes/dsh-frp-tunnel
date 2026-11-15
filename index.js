import { spawn } from 'node:child_process';
import { mkdir, writeFile, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { startRelay } from './relay.js';
import { buildFrpcToml, p2pProxies, publicBaseUrl, scrub } from './frpc.js';

/**
 * FRP tunnel Host plugin.
 *
 * Every field is `.volatile()` so the Settings page renders an editable form
 * instead of requiring YAML edits: `dsh-settings` only projects volatile fields
 * into forms, and the Loader commits new values into these references in place
 * (no re-activation) while emitting `loader/volatile-update`.
 */

export const name = 'frp-tunnel';

/** The tunnel publishes the listener, so it must exist first. */
export const inject = ['webServer'];

const STATE_DIR = join(homedir(), '.dsh', 'frp-tunnel');

/** Unexpected frpc exits are retried this many times, then left to a settings change. */
const MAX_RESTARTS = 5;
/** Delay between restart attempts. */
const RESTART_DELAY_MS = 5000;

export const Config = z.object({
  enabled: z.boolean().default(true).description('启用隧道').volatile(),
  serverAddr: z.string().default('').description('frps 服务器地址（域名或 IP）').volatile(),
  serverPort: z.natural().min(1).max(65535).default(7000).description('frps 服务端口').volatile(),
  user: z.string().default('').description('frps 用户前缀（启用 user 隔离时填写）').volatile(),
  authToken: z.string().role('secret').default('').description('frps auth.token').volatile(),
  tls: z.boolean().default(true).description('与 frps 之间启用 TLS').volatile(),
  proxyType: z.union([z.const('tcp'), z.const('http')]).default('tcp').description('tcp 用公网端口；http 用域名').volatile(),
  remotePort: z.natural().min(1).max(65535).default(6080).description('frps 上暴露的公网端口（tcp）').volatile(),
  customDomain: z.string().default('').description('已解析到 frps 的域名（http）').volatile(),
  subdomain: z.string().default('').description('frps subDomainHost 下的子域名（http）').volatile(),
  proxyName: z.string().default('dsh-web').description('代理名称，同一 frps 上不可重复').volatile(),
  publicUrl: z.string().default('').description('覆盖对外访问地址；留空自动推导').volatile(),
  frpcPath: z.string().default('/opt/homebrew/bin/frpc').description('frpc 可执行文件路径').volatile(),
  tunnelUser: z.string().default('dsh').description('隧道入口的 HTTP Basic 用户名').volatile(),
  tunnelPassword: z.string().role('secret').default('').description('隧道入口的 HTTP Basic 密码；留空则不启用').volatile(),
  mobileLayout: z.boolean().default(true).description('经隧道访问时为手机注入移动端布局与前进后退').volatile(),
  p2p: z.boolean().default(true).description('允许安卓 App 先尝试 P2P 直连（xtcp 打洞），不通再经 frps 中转；需要设置入口密码').volatile(),
});

const KEYS = Object.keys(Config.dict);

/** Volatile references expose `.get()`; plain values pass through. */
const unwrap = (value) =>
  value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;

/** Detached plain snapshot of the live config. */
export function snapshot(config) {
  const plain = {};
  for (const key of KEYS) plain[key] = unwrap(config?.[key]);
  return plain;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `getOrigin()` throws until the listener has bound a port. */
async function waitForOrigin(ctx, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return ctx.webServer.getOrigin();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await wait(200);
    }
  }
}

function blockerFor(config) {
  if (!config.enabled) return 'disabled';
  if (!config.serverAddr) return 'serverAddr 未配置';
  if (config.proxyType === 'tcp' && !config.remotePort) return 'tcp 需要 remotePort';
  if (config.proxyType === 'http' && !config.customDomain && !config.subdomain) {
    return 'http 需要 customDomain 或 subdomain';
  }
  return undefined;
}

function runFrpc(binary, tomlPath, log, secrets) {
  const child = spawn(binary, ['-c', tomlPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const pump = (stream) => {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) log(scrub(line, secrets));
    });
  };
  pump(child.stdout);
  pump(child.stderr);
  return child;
}

/** Owns the running relay + frpc pair and rebuilds it when config changes. */
class Tunnel {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = (line) => ctx.logger.info(line);
    this.warn = (line) => ctx.logger.warn(line);
    this.disposed = false;
    this.signature = undefined;
    this.config = undefined;
    this.relay = undefined;
    this.child = undefined;
    this.tomlPath = undefined;
    this.restarts = 0;
    this.timer = undefined;
    this.queue = Promise.resolve();
  }

  /** Serialize rebuilds so a burst of field edits cannot interleave. */
  sync(config) {
    const signature = JSON.stringify(config);
    if (signature === this.signature) return this.queue;
    this.signature = signature;
    this.restarts = 0;
    this.queue = this.queue.then(() => this.rebuild(config)).catch((error) => {
      this.warn(`[frp-tunnel] 重建失败：${error instanceof Error ? error.message : String(error)}`);
    });
    return this.queue;
  }

  async rebuild(config) {
    await this.stop();
    if (this.disposed) return;
    const blocked = blockerFor(config);
    if (blocked !== undefined) {
      if (blocked === 'disabled') this.log('[frp-tunnel] enabled=false，隧道已停止');
      else this.warn(`[frp-tunnel] 未启动：${blocked}`);
      return;
    }
    await this.start(config);
  }

  async start(config) {
    this.config = config;
    const origin = await waitForOrigin(this.ctx);
    const upstream = new URL(origin);
    const announced = publicBaseUrl(config);

    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });

    // Resolve the per-launch token link lazily so the stable login always lands on
    // the token DSH accepts right now.
    const loginTarget = () => {
      const connection = this.ctx.get('connection');
      if (!connection?.authenticatedUrl) return undefined;
      try {
        const url = new URL(connection.authenticatedUrl(origin));
        return url.pathname + url.search;
      } catch {
        return undefined;
      }
    };
    const relay = await startRelay({
      upstreamOrigin: origin,
      username: config.tunnelUser,
      password: config.tunnelPassword,
      warn: this.warn,
      loginTarget,
      mobile: config.mobileLayout !== false,
      p2p: () => {
        const proxies = p2pProxies(config);
        if (proxies === undefined) return undefined;
        return {
          serverAddr: config.serverAddr,
          serverPort: config.serverPort,
          tls: config.tls,
          user: config.user,
          token: config.authToken,
          proxy: proxies.xtcp,
          fallbackProxy: proxies.stcp,
          secretKey: proxies.secretKey,
        };
      },
    });
    if (this.disposed) {
      await relay.close();
      return;
    }
    this.relay = relay;

    const tomlPath = join(STATE_DIR, 'frpc.toml');
    await writeFile(tomlPath, buildFrpcToml(config, relay.port), { mode: 0o600 });
    await chmod(tomlPath, 0o600);
    this.tomlPath = tomlPath;

    const secrets = [config.authToken, config.tunnelPassword].filter(Boolean);
    this.spawn(config.frpcPath, tomlPath, secrets);

    const connection = this.ctx.get('connection');
    const accessUrl = connection?.authenticatedUrl ? connection.authenticatedUrl(announced) : announced;
    if (!connection) this.warn('[frp-tunnel] 未取到 connection，访问链接不带登录令牌');
    const accessPath = join(STATE_DIR, 'access-url.txt');
    await writeFile(accessPath, `${accessUrl}\n`, { mode: 0o600 });

    this.log(`[frp-tunnel] 本地 ${upstream.origin} → 中继 127.0.0.1:${relay.port} → frps ${config.serverAddr}:${config.serverPort}`);
    if (config.tunnelPassword) {
      await writeFile(join(STATE_DIR, 'login-url.txt'), `${new URL('/__frp/login', announced).href}\n`, { mode: 0o600 });
    }
    this.log(`[frp-tunnel] 公网入口 ${announced}`);
    if (p2pProxies(config)) this.log(`[frp-tunnel] 安卓 App P2P 入口 ${p2pProxies(config).xtcp}（xtcp，失败时 stcp 中转）`);
    this.log(`[frp-tunnel] 固定登录入口 ${new URL('/__frp/login', announced).href}（账号密码登录，不需要令牌）`);
    this.log(`[frp-tunnel] 带令牌链接已写入 ${accessPath}`);
  }

  /** Launch frpc and wire the unexpected-exit restart. */
  spawn(frpcPath, tomlPath, secrets) {
    const child = runFrpc(frpcPath, tomlPath, this.log, secrets);
    this.child = child;
    child.on('error', (error) => {
      this.warn(`[frp-tunnel] 无法启动 frpc（${frpcPath}）：${error.message}`);
    });
    child.on('exit', (code, signal) => {
      if (this.disposed || this.child !== child) return;
      this.child = undefined;
      this.warn(`[frp-tunnel] frpc 退出 code=${String(code)} signal=${signal ?? '-'}`);
      this.scheduleRestart();
    });
  }

  /** Retry an unexpectedly exited frpc with a small budget so a broken config cannot spin. */
  scheduleRestart() {
    if (this.disposed || this.config === undefined || this.tomlPath === undefined) return;
    if (this.restarts >= MAX_RESTARTS) {
      this.warn(`[frp-tunnel] frpc 已连续退出 ${MAX_RESTARTS} 次，停止重试；改动任一设置项可重新拉起`);
      return;
    }
    this.restarts += 1;
    this.log(`[frp-tunnel] ${RESTART_DELAY_MS / 1000}s 后重启 frpc（第 ${this.restarts}/${MAX_RESTARTS} 次）`);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed || this.child !== undefined || this.tomlPath === undefined) return;
      const secrets = [this.config.authToken, this.config.tunnelPassword].filter(Boolean);
      this.spawn(this.config.frpcPath, this.tomlPath, secrets);
    }, RESTART_DELAY_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async stop() {
    const child = this.child;
    const relay = this.relay;
    const tomlPath = this.tomlPath;
    this.child = undefined;
    this.relay = undefined;
    this.tomlPath = undefined;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (child) {
      child.removeAllListeners('exit');
      child.kill('SIGTERM');
    }
    if (relay) await relay.close();
    if (tomlPath) await unlink(tomlPath).catch(() => {});
  }

  dispose() {
    this.disposed = true;
    return this.queue.then(() => this.stop());
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config) {
  const tunnel = new Tunnel(ctx);

  // Volatile edits are committed in place, so this event is the only signal.
  ctx.on('loader/volatile-update', () => {
    tunnel.sync(snapshot(config));
  });

  ctx.effect(() => {
    tunnel.sync(snapshot(config));
    return () => tunnel.dispose();
  }, 'frp-tunnel.apply()');
}
