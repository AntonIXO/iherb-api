import { execFile } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  timingSafeEqual,
} from "node:crypto";
import {
  access,
  readFile,
  readdir,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  iHerbCookieHeader,
  type ChromeCookie,
} from "./chrome-cookies.js";

const execFileAsync = promisify(execFile);
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const COOKIE_HOST_HASH_LENGTH = 32;
const LINUX_IV = Buffer.alloc(16, 0x20);
const SALT = "saltysalt";

export type SupportedBrowser = "chrome" | "brave";
export type BrowserChoice = SupportedBrowser | "auto";

export interface BrowserProfile {
  browser: SupportedBrowser;
  directory: string;
  name: string;
  rootDirectory: string;
  cookiePath: string;
  lastUsed: boolean;
  activeTime?: number;
}

export interface BrowserProfileWithCookieCount extends BrowserProfile {
  iHerbCookieCount: number;
}

export interface ExtractBrowserSessionOptions {
  browser?: BrowserChoice;
  profile?: string;
  userAgent?: string;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

export interface ExtractedBrowserSession {
  profile: BrowserProfile;
  cookies: ChromeCookie[];
  cookieHeader: string;
  userAgent: string;
  failedCookieCount: number;
}

interface LocalStateProfile {
  name?: unknown;
  active_time?: unknown;
}

interface LocalState {
  profile?: {
    info_cache?: Record<string, LocalStateProfile>;
    last_used?: unknown;
  };
  os_crypt?: {
    encrypted_key?: unknown;
  };
}

interface CookieRow {
  domain: string;
  name: string;
  path: string;
  secure: number;
  expires: number;
  value: string;
  encryptedValue: Uint8Array;
}

interface DecryptionContext {
  browser: SupportedBrowser;
  browserRoot: string;
  databaseVersion: number;
  platform: NodeJS.Platform;
}

interface ProfileAttempt {
  profile: BrowserProfile;
  cookies: ChromeCookie[];
  cookieHeader: string;
  usableCookieCount: number;
  failedCookieCount: number;
}

export class BrowserCookieError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserCookieError";
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function browserRoot(
  browser: SupportedBrowser,
  platform: NodeJS.Platform,
  homeDirectory: string,
): string {
  if (platform === "linux") {
    return browser === "chrome"
      ? join(homeDirectory, ".config", "google-chrome")
      : join(
          homeDirectory,
          ".config",
          "BraveSoftware",
          "Brave-Browser",
        );
  }
  if (platform === "darwin") {
    return browser === "chrome"
      ? join(
          homeDirectory,
          "Library",
          "Application Support",
          "Google",
          "Chrome",
        )
      : join(
          homeDirectory,
          "Library",
          "Application Support",
          "BraveSoftware",
          "Brave-Browser",
        );
  }
  if (platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ??
      join(homeDirectory, "AppData", "Local");
    return browser === "chrome"
      ? join(localAppData, "Google", "Chrome", "User Data")
      : join(
          localAppData,
          "BraveSoftware",
          "Brave-Browser",
          "User Data",
        );
  }
  throw new BrowserCookieError(
    `Browser cookie extraction is not supported on ${platform}.`,
  );
}

async function readLocalState(rootDirectory: string): Promise<LocalState> {
  try {
    return JSON.parse(
      await readFile(join(rootDirectory, "Local State"), "utf8"),
    ) as LocalState;
  } catch (error) {
    throw new BrowserCookieError(
      `Could not read browser Local State from ${rootDirectory}.`,
      { cause: error },
    );
  }
}

async function profileDirectories(
  rootDirectory: string,
  localState: LocalState,
): Promise<string[]> {
  const cached = Object.keys(localState.profile?.info_cache ?? {}).filter(
    (directory) =>
      directory !== "." &&
      directory !== ".." &&
      !directory.includes("/") &&
      !directory.includes("\\"),
  );
  if (cached.length > 0) return cached;

  try {
    const entries = await readdir(rootDirectory, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (entry.name === "Default" || /^Profile \d+$/.test(entry.name)),
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function parseActiveTime(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Finds normal Chrome and Brave profiles without launching or modifying either
 * browser. Only profiles with a Cookies database are returned.
 */
export async function discoverBrowserProfiles(
  options: Pick<
    ExtractBrowserSessionOptions,
    "browser" | "homeDirectory" | "platform"
  > = {},
): Promise<BrowserProfile[]> {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const browsers: SupportedBrowser[] =
    options.browser && options.browser !== "auto"
      ? [options.browser]
      : ["chrome", "brave"];
  const profiles: BrowserProfile[] = [];

  for (const browser of browsers) {
    const rootDirectory = browserRoot(browser, platform, homeDirectory);
    if (!(await fileExists(join(rootDirectory, "Local State")))) continue;

    const localState = await readLocalState(rootDirectory);
    const directories = await profileDirectories(rootDirectory, localState);
    const cache = localState.profile?.info_cache ?? {};
    const lastUsed =
      typeof localState.profile?.last_used === "string"
        ? localState.profile.last_used
        : undefined;

    for (const directory of directories) {
      const cookieCandidates = [
        join(rootDirectory, directory, "Network", "Cookies"),
        join(rootDirectory, directory, "Cookies"),
      ];
      let cookiePath: string | undefined;
      for (const candidate of cookieCandidates) {
        if (await fileExists(candidate)) {
          cookiePath = candidate;
          break;
        }
      }
      if (!cookiePath) continue;

      const info = cache[directory];
      const name =
        typeof info?.name === "string" && info.name.trim()
          ? info.name.trim()
          : directory;
      const activeTime = parseActiveTime(info?.active_time);
      profiles.push({
        browser,
        directory,
        name,
        rootDirectory,
        cookiePath,
        lastUsed: directory === lastUsed,
        ...(activeTime === undefined ? {} : { activeTime }),
      });
    }
  }

  return profiles;
}

async function openCookieDatabase(path: string) {
  try {
    const { Database } = await import("bun:sqlite");
    return new Database(path, { readonly: true, strict: true });
  } catch (error) {
    throw new BrowserCookieError(
      "Reading an existing browser profile currently requires the Bun runtime.",
      { cause: error },
    );
  }
}

async function countIHerbCookies(path: string): Promise<number> {
  const database = await openCookieDatabase(path);
  try {
    const row = database
      .query(
        `SELECT count(*) AS count
         FROM cookies
         WHERE host_key = $domain OR host_key LIKE $subdomain`,
      )
      .get({ domain: "iherb.com", subdomain: "%.iherb.com" }) as
      | { count: number }
      | null;
    return row?.count ?? 0;
  } finally {
    database.close(false);
  }
}

/**
 * Lists profiles and counts matching rows without decrypting any cookie value.
 */
export async function listBrowserProfiles(
  options: Pick<
    ExtractBrowserSessionOptions,
    "browser" | "homeDirectory" | "platform"
  > = {},
): Promise<BrowserProfileWithCookieCount[]> {
  const profiles = await discoverBrowserProfiles(options);
  const result: BrowserProfileWithCookieCount[] = [];
  for (const profile of profiles) {
    let iHerbCookieCount = 0;
    try {
      iHerbCookieCount = await countIHerbCookies(profile.cookiePath);
    } catch {
      // A locked or unreadable database is still useful in profile listings.
    }
    result.push({ ...profile, iHerbCookieCount });
  }
  return result;
}

async function readCookieRows(
  path: string,
): Promise<{ databaseVersion: number; rows: CookieRow[] }> {
  const database = await openCookieDatabase(path);
  try {
    const versionRow = database
      .query("SELECT value FROM meta WHERE key = $key")
      .get({ key: "version" }) as { value: string } | null;
    const databaseVersion = Number(versionRow?.value ?? 0);
    const rows = database
      .query(
        `SELECT
           host_key AS domain,
           name,
           path,
           is_secure AS secure,
           CASE
             WHEN expires_utc = 0 THEN 0
             ELSE CAST(expires_utc / 1000000 - ${CHROME_EPOCH_OFFSET_SECONDS} AS INTEGER)
           END AS expires,
           value,
           encrypted_value AS encryptedValue
         FROM cookies
         WHERE host_key = $domain OR host_key LIKE $subdomain`,
      )
      .all({ domain: "iherb.com", subdomain: "%.iherb.com" }) as CookieRow[];
    return {
      databaseVersion: Number.isFinite(databaseVersion) ? databaseVersion : 0,
      rows,
    };
  } finally {
    database.close(false);
  }
}

async function commandOutput(
  command: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      windowsHide: true,
    });
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

const linuxSecretCache = new Map<SupportedBrowser, Promise<string>>();
const macSecretCache = new Map<SupportedBrowser, Promise<string>>();
const windowsKeyCache = new Map<string, Promise<Buffer>>();

async function linuxSafeStorageSecret(
  browser: SupportedBrowser,
): Promise<string> {
  const cached = linuxSecretCache.get(browser);
  if (cached) return cached;

  const promise = (async () => {
    const applications =
      browser === "chrome"
        ? ["chrome", "chrome-libsecret-password-v2"]
        : ["brave", "brave-browser", "brave-libsecret-password-v2"];
    for (const application of applications) {
      const secret = await commandOutput("secret-tool", [
        "lookup",
        "application",
        application,
      ]);
      if (secret) return secret;
    }
    throw new BrowserCookieError(
      `Could not read ${browser} Safe Storage from the Linux keyring. ` +
        "Unlock the desktop keyring and install libsecret's secret-tool.",
    );
  })();
  linuxSecretCache.set(browser, promise);
  return promise;
}

async function macSafeStorageSecret(
  browser: SupportedBrowser,
): Promise<string> {
  const cached = macSecretCache.get(browser);
  if (cached) return cached;

  const promise = (async () => {
    const service =
      browser === "chrome" ? "Chrome Safe Storage" : "Brave Safe Storage";
    const secret = await commandOutput("security", [
      "find-generic-password",
      "-w",
      "-s",
      service,
    ]);
    if (secret) return secret;
    throw new BrowserCookieError(
      `Could not read "${service}" from macOS Keychain. Allow your terminal ` +
        "to access that item and retry.",
    );
  })();
  macSecretCache.set(browser, promise);
  return promise;
}

interface DpapiModule {
  Dpapi: {
    unprotectData(
      encryptedData: Uint8Array,
      optionalEntropy: Uint8Array | null,
      scope: "CurrentUser" | "LocalMachine",
    ): Uint8Array;
  };
  isPlatformSupported: boolean;
}

async function loadDpapi(): Promise<DpapiModule> {
  try {
    const moduleName = "@primno/dpapi";
    return (await import(moduleName)) as DpapiModule;
  } catch (error) {
    throw new BrowserCookieError(
      "Windows cookie decryption requires the optional @primno/dpapi package.",
      { cause: error },
    );
  }
}

async function windowsMasterKey(browserRootDirectory: string): Promise<Buffer> {
  const cached = windowsKeyCache.get(browserRootDirectory);
  if (cached) return cached;

  const promise = (async () => {
    const state = await readLocalState(browserRootDirectory);
    if (typeof state.os_crypt?.encrypted_key !== "string") {
      throw new BrowserCookieError(
        "The browser Local State does not contain a DPAPI encrypted key.",
      );
    }
    const wrapped = Buffer.from(state.os_crypt.encrypted_key, "base64");
    if (!wrapped.subarray(0, 5).equals(Buffer.from("DPAPI"))) {
      throw new BrowserCookieError(
        "Unsupported Windows browser master-key format.",
      );
    }
    const dpapi = await loadDpapi();
    if (!dpapi.isPlatformSupported) {
      throw new BrowserCookieError(
        "@primno/dpapi does not support this Windows architecture.",
      );
    }
    return Buffer.from(
      dpapi.Dpapi.unprotectData(
        wrapped.subarray(5),
        null,
        "CurrentUser",
      ),
    );
  })();
  windowsKeyCache.set(browserRootDirectory, promise);
  return promise;
}

function stripHostHash(
  plaintext: Buffer,
  domain: string,
  databaseVersion: number,
): Buffer {
  if (databaseVersion < 24) return plaintext;
  if (plaintext.length < COOKIE_HOST_HASH_LENGTH) {
    throw new BrowserCookieError("Decrypted cookie is missing its host hash.");
  }
  const expected = createHash("sha256").update(domain).digest();
  const actual = plaintext.subarray(0, COOKIE_HOST_HASH_LENGTH);
  if (!timingSafeEqual(actual, expected)) {
    throw new BrowserCookieError(
      "Cookie decryption failed host-integrity validation.",
    );
  }
  return plaintext.subarray(COOKIE_HOST_HASH_LENGTH);
}

async function decryptCbcCookie(
  encryptedValue: Buffer,
  domain: string,
  context: DecryptionContext,
  prefix: "v10" | "v11",
): Promise<string> {
  let secret: string;
  let iterations: number;
  if (context.platform === "linux") {
    secret =
      prefix === "v10"
        ? "peanuts"
        : await linuxSafeStorageSecret(context.browser);
    iterations = 1;
  } else {
    secret = await macSafeStorageSecret(context.browser);
    iterations = 1_003;
  }
  const key = pbkdf2Sync(secret, SALT, iterations, 16, "sha1");
  const decipher = createDecipheriv("aes-128-cbc", key, LINUX_IV);
  const plaintext = Buffer.concat([
    decipher.update(encryptedValue.subarray(3)),
    decipher.final(),
  ]);
  return stripHostHash(
    plaintext,
    domain,
    context.databaseVersion,
  ).toString("utf8");
}

async function decryptWindowsCookie(
  encryptedValue: Buffer,
  domain: string,
  context: DecryptionContext,
): Promise<string> {
  const prefix = encryptedValue.subarray(0, 3).toString("ascii");
  if (prefix === "v20") {
    throw new BrowserCookieError(
      "Chrome/Brave App-Bound Encryption (v20) is active. Windows does not " +
        "allow a standalone CLI to decrypt these cookies.",
    );
  }
  const dpapi = await loadDpapi();
  let plaintext: Buffer;
  if (prefix === "v10") {
    const key = await windowsMasterKey(context.browserRoot);
    const payload = encryptedValue.subarray(3);
    const nonce = payload.subarray(0, 12);
    const authenticationTag = payload.subarray(payload.length - 16);
    const ciphertext = payload.subarray(12, payload.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(authenticationTag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
  } else {
    plaintext = Buffer.from(
      dpapi.Dpapi.unprotectData(
        encryptedValue,
        null,
        "CurrentUser",
      ),
    );
  }
  return stripHostHash(
    plaintext,
    domain,
    context.databaseVersion,
  ).toString("utf8");
}

/** Module-level low-level decryptor used by deterministic tests. */
export async function decryptChromiumCookieValue(
  encryptedValue: Uint8Array,
  domain: string,
  context: DecryptionContext,
): Promise<string> {
  const value = Buffer.from(encryptedValue);
  if (value.length === 0) return "";
  const prefix = value.subarray(0, 3).toString("ascii");

  if (context.platform === "linux" || context.platform === "darwin") {
    if (prefix !== "v10" && prefix !== "v11") {
      throw new BrowserCookieError(
        `Unsupported ${context.platform} cookie encryption prefix.`,
      );
    }
    return decryptCbcCookie(value, domain, context, prefix);
  }
  if (context.platform === "win32") {
    return decryptWindowsCookie(value, domain, context);
  }
  throw new BrowserCookieError(
    `Cookie decryption is not supported on ${context.platform}.`,
  );
}

async function extractProfile(
  profile: BrowserProfile,
  platform: NodeJS.Platform,
): Promise<ProfileAttempt> {
  const { databaseVersion, rows } = await readCookieRows(profile.cookiePath);
  const cookies: ChromeCookie[] = [];
  let failedCookieCount = 0;
  let lastDecryptionError: unknown;
  const context: DecryptionContext = {
    browser: profile.browser,
    browserRoot: profile.rootDirectory,
    databaseVersion,
    platform,
  };

  for (const row of rows) {
    try {
      const value =
        row.value.length > 0
          ? row.value
          : await decryptChromiumCookieValue(
              row.encryptedValue,
              row.domain,
              context,
            );
      cookies.push({
        name: row.name,
        value,
        domain: row.domain,
        path: row.path || "/",
        secure: row.secure === 1,
        expires: row.expires,
      });
    } catch (error) {
      failedCookieCount += 1;
      lastDecryptionError = error;
    }
  }

  if (
    rows.length > 0 &&
    cookies.length === 0 &&
    lastDecryptionError !== undefined
  ) {
    throw lastDecryptionError;
  }

  return {
    profile,
    cookies,
    cookieHeader: iHerbCookieHeader(cookies),
    usableCookieCount: cookies.filter(
      (cookie) =>
        cookie.expires == null ||
        cookie.expires <= 0 ||
        cookie.expires > Date.now() / 1_000,
    ).length,
    failedCookieCount,
  };
}

function matchesRequestedProfile(
  profile: BrowserProfile,
  requested: string,
): boolean {
  const normalized = requested.trim().toLocaleLowerCase();
  return (
    profile.directory.toLocaleLowerCase() === normalized ||
    profile.name.toLocaleLowerCase() === normalized
  );
}

function compareProfileAttempts(
  left: ProfileAttempt,
  right: ProfileAttempt,
): number {
  const cookieDifference =
    right.usableCookieCount - left.usableCookieCount;
  if (cookieDifference !== 0) return cookieDifference;
  const lastUsedDifference =
    Number(right.profile.lastUsed) - Number(left.profile.lastUsed);
  if (lastUsedDifference !== 0) return lastUsedDifference;
  return (
    (right.profile.activeTime ?? 0) -
    (left.profile.activeTime ?? 0)
  );
}

function chromiumUserAgent(
  platform: NodeJS.Platform,
  majorVersion: string,
): string {
  const platformToken =
    platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : platform === "darwin"
        ? "Macintosh; Intel Mac OS X 10_15_7"
        : "X11; Linux x86_64";
  return (
    `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`
  );
}

async function inferUserAgent(
  profile: BrowserProfile,
  platform: NodeJS.Platform,
  override?: string,
): Promise<string> {
  if (override?.trim()) return override.trim();
  if (process.env.IHERB_USER_AGENT?.trim()) {
    return process.env.IHERB_USER_AGENT.trim();
  }
  try {
    const version = (
      await readFile(join(profile.rootDirectory, "Last Version"), "utf8")
    ).trim();
    const majorVersion = version.match(/^\d+/)?.[0];
    if (majorVersion) {
      return chromiumUserAgent(platform, majorVersion);
    }
  } catch {
    // The override guidance below is more useful than a filesystem error.
  }
  throw new BrowserCookieError(
    "Could not infer the browser User-Agent. Pass --user-agent or set " +
      "IHERB_USER_AGENT.",
  );
}

/**
 * Extracts only iHerb cookies from an existing Chrome or Brave profile. The
 * browser is never launched, stopped, or modified.
 */
export async function extractIHerbBrowserSession(
  options: ExtractBrowserSessionOptions = {},
): Promise<ExtractedBrowserSession> {
  const platform = options.platform ?? process.platform;
  const profiles = await discoverBrowserProfiles(options);
  const filtered = options.profile
    ? profiles.filter((profile) =>
        matchesRequestedProfile(profile, options.profile ?? ""),
      )
    : profiles;

  if (profiles.length === 0) {
    throw new BrowserCookieError(
      "No Chrome or Brave profiles with a Cookies database were found.",
    );
  }
  if (filtered.length === 0) {
    throw new BrowserCookieError(
      `Browser profile "${options.profile}" was not found. Use --list-profiles.`,
    );
  }

  const attempts: ProfileAttempt[] = [];
  let lastError: unknown;
  for (const profile of filtered) {
    try {
      const attempt = await extractProfile(profile, platform);
      if (attempt.cookieHeader) attempts.push(attempt);
    } catch (error) {
      lastError = error;
    }
  }
  attempts.sort(compareProfileAttempts);
  const selected = attempts[0];
  if (!selected) {
    const detail =
      lastError instanceof BrowserCookieError
        ? ` Last extraction error: ${lastError.message}`
        : "";
    throw new BrowserCookieError(
      "No usable iHerb cookies were found. Log in to iHerb in Chrome or " +
        "Brave, wait a few seconds for the cookie database to flush, and retry." +
        detail,
      lastError === undefined ? undefined : { cause: lastError },
    );
  }

  return {
    profile: selected.profile,
    cookies: selected.cookies,
    cookieHeader: selected.cookieHeader,
    userAgent: await inferUserAgent(
      selected.profile,
      platform,
      options.userAgent,
    ),
    failedCookieCount: selected.failedCookieCount,
  };
}
