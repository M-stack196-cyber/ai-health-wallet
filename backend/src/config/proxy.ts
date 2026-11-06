/** How many reverse proxies sit in front of the API (nginx, load balancer). Client IPs for rate limits come from X-Forwarded-For only for these hops. */
export function trustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUST_PROXY_HOPS ?? "0";
  if (!/^[0-3]$/.test(raw)) throw new Error("TRUST_PROXY_HOPS must be an integer from 0 to 3.");
  return Number(raw);
}
