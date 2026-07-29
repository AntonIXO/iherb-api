export interface ChromeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  expires?: number;
}

function domainMatchesIHerb(domain: string): boolean {
  const normalized = domain.replace(/^\./, "").toLowerCase();
  return normalized === "iherb.com" || normalized.endsWith(".iherb.com");
}

/**
 * Produces the Cookie header that Chrome would send to public www.iherb.com
 * pages. Duplicate names are resolved in favor of the most specific path.
 */
export function iHerbCookieHeader(cookies: ChromeCookie[]): string {
  const nowSeconds = Date.now() / 1_000;
  const selected = new Map<string, ChromeCookie>();

  for (const cookie of cookies) {
    if (!domainMatchesIHerb(cookie.domain)) continue;
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
