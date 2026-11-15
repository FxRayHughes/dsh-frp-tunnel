import { createHmac } from 'node:crypto';

/**
 * Build an frpc (>= 0.52, TOML) config. JSON string literals are valid TOML
 * basic strings, so every user value goes through `JSON.stringify`.
 */
const q = (value) => JSON.stringify(String(value));

/**
 * The phone app's direct route: an xtcp proxy (P2P hole punching) and an
 * stcp proxy frps relays when no hole opens, both in front of the relay.
 * Only clients that know the key can visit them; the app gets it from
 * `/__frp/p2p` after logging in. Undefined without an entry password.
 */
export function p2pProxies(config) {
  if (config.p2p === false || !config.tunnelPassword) return undefined;
  const name = `${config.proxyName}-p2p`;
  const secretKey = createHmac('sha256', config.tunnelPassword).update(`frp-p2p:${name}`).digest('base64url').slice(0, 32);
  return { xtcp: name, stcp: `${name}-s`, secretKey };
}

/**
 * @param {object} config - resolved plugin config
 * @param {number} localPort - relay port frpc forwards to
 * @returns {string} TOML document
 */
export function buildFrpcToml(config, localPort) {
  const lines = [
    `serverAddr = ${q(config.serverAddr)}`,
    `serverPort = ${config.serverPort}`,
    'loginFailExit = false',
    `transport.tls.enable = ${config.tls ? 'true' : 'false'}`,
    'log.to = "console"',
    'log.level = "info"',
  ];
  if (config.user) lines.push(`user = ${q(config.user)}`);
  if (config.authToken) {
    lines.push('auth.method = "token"', `auth.token = ${q(config.authToken)}`);
  }
  const metas = Object.entries(config.metadatas ?? {});
  if (metas.length > 0) {
    lines.push('', '[metadatas]');
    for (const [key, value] of metas) lines.push(`${q(key)} = ${q(value)}`);
  }

  lines.push(
    '',
    '[[proxies]]',
    `name = ${q(config.proxyName)}`,
    `type = ${q(config.proxyType)}`,
    'localIP = "127.0.0.1"',
    `localPort = ${localPort}`,
  );
  if (config.proxyType === 'tcp') {
    lines.push(`remotePort = ${config.remotePort}`);
  } else {
    if (config.customDomain) lines.push(`customDomains = [${q(config.customDomain)}]`);
    if (config.subdomain) lines.push(`subdomain = ${q(config.subdomain)}`);
  }
  const p2p = p2pProxies(config);
  if (p2p !== undefined) {
    for (const [type, name] of [['xtcp', p2p.xtcp], ['stcp', p2p.stcp]]) {
      lines.push('', '[[proxies]]', `name = ${q(name)}`, `type = "${type}"`, `secretKey = ${q(p2p.secretKey)}`);
      lines.push('localIP = "127.0.0.1"', `localPort = ${localPort}`, 'transport.useEncryption = true');
    }
  }
  return lines.join('\n') + '\n';
}

/** Public base URL announced to the user, before the launch token is added. */
export function publicBaseUrl(config) {
  if (config.publicUrl) return config.publicUrl;
  if (config.proxyType === 'tcp') return `http://${config.serverAddr}:${config.remotePort}/`;
  const host = config.customDomain || config.subdomain || config.serverAddr;
  const scheme = config.proxyType === 'https' ? 'https' : 'http';
  return `${scheme}://${host}/`;
}

/** Remove secrets from an frpc log line before it reaches the DSH logger. */
export function scrub(line, secrets) {
  let out = line;
  for (const secret of secrets) if (secret) out = out.split(secret).join('***');
  return out.replace(/([?&]token=)[^&\s]+/g, '$1***');
}
