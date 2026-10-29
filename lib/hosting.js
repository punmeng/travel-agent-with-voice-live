export function hostingPolicy(env = process.env) {
  const mode = env.HOSTING_MODE ?? 'local';
  if (!['local', 'azure'].includes(mode)) throw new Error('HOSTING_MODE must be local or azure');
  if (mode === 'local') {
    if (env.PUBLIC_ORIGIN) throw new Error('PUBLIC_ORIGIN requires HOSTING_MODE=azure');
    const acceptsHost = host => typeof host === 'string' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    return Object.freeze({
      bindAddress: '127.0.0.1',
      secureCookies: false,
      acceptsHost,
      acceptsOrigin: (host, origin) => acceptsHost(host) && origin === `http://${host}`
    });
  }
  let url;
  try { url = new URL(env.PUBLIC_ORIGIN); } catch {
    throw new Error('HOSTING_MODE=azure requires PUBLIC_ORIGIN as an exact HTTPS origin');
  }
  const dnsName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (url.protocol !== 'https:' || url.origin !== env.PUBLIC_ORIGIN || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || url.port || !dnsName.test(url.hostname) ||
      url.hostname.endsWith('.localhost')) {
    throw new Error('PUBLIC_ORIGIN must be a canonical HTTPS DNS origin without a path, credentials or port');
  }
  return Object.freeze({
    bindAddress: '0.0.0.0',
    secureCookies: true,
    acceptsHost: host => host === url.host,
    acceptsOrigin: (host, origin) => host === url.host && origin === url.origin
  });
}
