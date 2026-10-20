/**
 * Build an frpc (>= 0.52, TOML) config. JSON string literals are valid TOML
 * basic strings, so every user value goes through `JSON.stringify`.
 */
const q = (value) => JSON.stringify(String(value));

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
