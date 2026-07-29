import { CookieJar } from "tough-cookie";

import {
  IHerbBlockedError,
  IHerbHttpError,
  IHerbRateLimitError,
} from "./errors.js";
import type {
  FetchLike,
  IHerbClientOptions,
  IHerbLocale,
  RateLimitOptions,
} from "./types.js";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

const CHALLENGE_PATTERNS = [
  /cf-chl-/i,
  /challenge-platform/i,
  /<title>\s*(?:just a moment|access denied)/i,
  /id=["']challenge-form["']/i,
  /verify you are human/i,
  /unusual traffic/i,
];

interface RequestTextOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
}

class RequestScheduler {
  private readonly concurrency: number;
  private readonly minDelayMs: number;
  private active = 0;
  private lastStartedAt = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: RateLimitOptions) {
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.minDelayMs = Math.max(0, options.minDelayMs ?? 750);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      const delay = Math.max(
        0,
        this.lastStartedAt + this.minDelayMs - Date.now(),
      );
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      this.lastStartedAt = Date.now();
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function getSetCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof extended.getSetCookie === "function") {
    return extended.getSetCookie();
  }
  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

function isChallengePage(html: string): boolean {
  const sample = html.slice(0, 150_000);
  return CHALLENGE_PATTERNS.some((pattern) => pattern.test(sample));
}

export class IHerbSession {
  readonly baseUrl: URL;
  readonly locale: IHerbLocale;
  readonly cookieJar: CookieJar;

  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly scheduler: RequestScheduler;
  private readonly maxRetries: number;
  private initialized = false;
  private readonly initialCookieHeader: string | undefined;

  constructor(options: IHerbClientOptions = {}) {
    this.baseUrl = new URL(options.baseUrl ?? "https://www.iherb.com");
    this.locale = {
      country: options.locale?.country ?? "US",
      language: options.locale?.language ?? "en-US",
      currency: options.locale?.currency ?? "USD",
    };
    this.cookieJar = options.cookieJar ?? new CookieJar();
    this.initialCookieHeader = options.cookieHeader;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 15_000);
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.maxRetries = Math.max(0, options.rateLimit?.maxRetries ?? 2);
    this.scheduler = new RequestScheduler(options.rateLimit ?? {});
  }

  async requestText(
    input: string | URL,
    options: RequestTextOptions = {},
  ): Promise<string> {
    await this.initializeCookies();
    const url = new URL(input, this.baseUrl);
    return this.scheduler.run(() => this.withRetries(url, options));
  }

  private async initializeCookies(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (this.initialCookieHeader) {
      const cookiePairs = this.initialCookieHeader.split(/;\s*/);
      for (const pair of cookiePairs) {
        if (!pair.includes("=")) continue;
        await this.cookieJar.setCookie(pair, this.baseUrl.href);
      }
    }

    const preference = [
      `sccode=${this.locale.country}`,
      `lan=${this.locale.language}`,
      `scurcode=${this.locale.currency}`,
      "noitmes=48",
    ].join("&");
    await this.cookieJar.setCookie(
      `iher-pref1=${preference}; Domain=.iherb.com; Path=/`,
      this.baseUrl.href,
    );
  }

  private async withRetries(
    url: URL,
    options: RequestTextOptions,
  ): Promise<string> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.singleRequest(url, options);
      } catch (error) {
        lastError = error;
        if (error instanceof IHerbBlockedError) throw error;
        if (error instanceof IHerbRateLimitError) {
          if (attempt >= this.maxRetries) throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, error.retryAfterMs ?? 1_000 * (attempt + 1)),
          );
          continue;
        }
        if (
          error instanceof IHerbHttpError &&
          error.status >= 500 &&
          attempt < this.maxRetries
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * 2 ** attempt),
          );
          continue;
        }
        throw error;
      }
    }

    throw lastError;
  }

  private async singleRequest(
    url: URL,
    options: RequestTextOptions,
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abortFromCaller = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const headers = new Headers(options.headers);
      headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
      headers.set("Accept-Language", `${this.locale.language},en;q=0.8`);
      headers.set("User-Agent", this.userAgent);
      headers.set("Cookie", await this.cookieJar.getCookieString(url.href));

      const response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: controller.signal,
      });

      for (const setCookie of getSetCookieHeaders(response.headers)) {
        await this.cookieJar.setCookie(setCookie, response.url || url.href, {
          ignoreError: true,
        });
      }

      if (
        response.status === 403 ||
        response.headers.get("cf-mitigated")?.toLowerCase() === "challenge"
      ) {
        throw new IHerbBlockedError();
      }
      if (response.status === 429) {
        throw new IHerbRateLimitError(
          retryAfterMs(response.headers.get("retry-after")),
        );
      }
      if (!response.ok) {
        throw new IHerbHttpError(
          `iHerb request failed with HTTP ${response.status}`,
          response.status,
        );
      }

      const text = await response.text();
      if (isChallengePage(text)) {
        throw new IHerbBlockedError(
          "iHerb returned a CAPTCHA or browser verification challenge",
          response.status,
        );
      }
      return text;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}
