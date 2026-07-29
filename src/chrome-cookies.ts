export interface ChromeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  expires?: number;
}

function domainMatchesHost(domain: string, host: string): boolean {
  const normalized = domain.replace(/^\./, "").toLowerCase();
  return domain.startsWith(".")
    ? host === normalized || host.endsWith(`.${normalized}`)
    : host === normalized;
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return (
    cookiePath.endsWith("/") ||
    requestPath.charAt(cookiePath.length) === "/"
  );
}

/**
 * Produces the Cookie header Chrome would send to the target iHerb URL.
 * The root URL is the safe default because those cookies also apply to search
 * and product pages.
 */
export function iHerbCookieHeader(
  cookies: ChromeCookie[],
  targetUrl = "https://www.iherb.com/",
): string {
  const nowSeconds = Date.now() / 1_000;
  const target = new URL(targetUrl);
  const targetHost = target.hostname.toLowerCase();
  const selected = new Map<string, ChromeCookie>();

  for (const cookie of cookies) {
    if (
      !domainMatchesHost(cookie.domain, targetHost) ||
      !pathMatches(cookie.path || "/", target.pathname)
    ) {
      continue;
    }
    if (cookie.expires != null && cookie.expires > 0 && cookie.expires <= nowSeconds) {
      continue;
    }
    const current = selected.get(cookie.name);
    if (!current || cookie.path.length > current.path.length) {
      selected.set(cookie.name, cookie);
    }
  }

  return [...selected.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export function dotenvValue(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")}"`;
}

export function formatIHerbEnv(cookieHeader: string, userAgent: string): string {
  return [
    `IHERB_COOKIE=${dotenvValue(cookieHeader)}`,
    `IHERB_USER_AGENT=${dotenvValue(userAgent)}`,
  ].join("\n");
}
