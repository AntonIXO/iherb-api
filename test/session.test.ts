import { describe, expect, test } from "bun:test";

import { IHerbBlockedError } from "../src/errors.js";
import { IHerbSession } from "../src/session.js";

describe("IHerbSession", () => {
  test("sends supplied cookies and persists Set-Cookie", async () => {
    const cookieHeaders: string[] = [];
    let call = 0;
    const session = new IHerbSession({
      cookieHeader: "session=user-value; cf_clearance=clearance-value",
      fetch: async (_input, init) => {
        cookieHeaders.push(new Headers(init?.headers).get("cookie") ?? "");
        call += 1;
        return new Response("<html>ok</html>", {
          status: 200,
          headers: call === 1 ? { "set-cookie": "seen=yes; Path=/" } : {},
        });
      },
      rateLimit: { minDelayMs: 0 },
    });

    await session.requestText("/");
    await session.requestText("/");
    expect(cookieHeaders[0]).toContain("session=user-value");
    expect(cookieHeaders[0]).toContain("cf_clearance=clearance-value");
    expect(cookieHeaders[1]).toContain("seen=yes");
  });

  test("reports Cloudflare challenges without retrying them", async () => {
    let calls = 0;
    const session = new IHerbSession({
      fetch: async () => {
        calls += 1;
        return new Response("<title>Just a moment...</title>", {
          status: 403,
          headers: { "cf-mitigated": "challenge" },
        });
      },
      rateLimit: { minDelayMs: 0, maxRetries: 2 },
    });

    await expect(session.requestText("/search?kw=test")).rejects.toBeInstanceOf(
      IHerbBlockedError,
    );
    expect(calls).toBe(1);
  });

  test("retries a rate-limited request using Retry-After", async () => {
    let calls = 0;
    const session = new IHerbSession({
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("slow down", {
              status: 429,
              headers: { "retry-after": "0" },
            })
          : new Response("<html>ok</html>", { status: 200 });
      },
      rateLimit: { minDelayMs: 0, maxRetries: 1 },
    });

    await expect(session.requestText("/")).resolves.toContain("ok");
    expect(calls).toBe(2);
  });

  test("requests JSON with the locale cookie on catalog subdomains", async () => {
    let requestHeaders = new Headers();
    const session = new IHerbSession({
      fetch: async (_input, init) => {
        requestHeaders = new Headers(init?.headers);
        return Response.json({ ok: true });
      },
      rateLimit: { minDelayMs: 0 },
    });

    const result = await session.requestJson<{ ok: boolean }>(
      "https://catalog.app.iherb.com/recommendations/comparison/1",
    );

    expect(result).toEqual({ ok: true });
    expect(requestHeaders.get("accept")).toBe("application/json");
    // Not just "a preference cookie exists": the language has to be the
    // session's. The jar stores the preference against www.iherb.com and does
    // not return it for this sibling host, so iHerb used to fall back to the
    // caller's geography and answer in that language.
    expect(requestHeaders.get("cookie")).toContain("lan=en-US");
  });

  test("pins the locale on catalog subdomains when no cookie was supplied", async () => {
    let requestHeaders = new Headers();
    const session = new IHerbSession({
      locale: { country: "DE", language: "de-DE", currency: "EUR" },
      fetch: async (_input, init) => {
        requestHeaders = new Headers(init?.headers);
        return Response.json({ ok: true });
      },
      rateLimit: { minDelayMs: 0 },
    });

    await session.requestJson("https://catalog.app.iherb.com/product/137787");

    const cookie = requestHeaders.get("cookie") ?? "";
    expect(cookie).toContain("lan=de-DE");
    expect(cookie).toContain("sccode=DE");
    // One preference cookie, not a duplicate pair the server has to arbitrate.
    expect(cookie.match(/iher-pref1=/g)).toHaveLength(1);
  });

  test("does not leak iHerb cookies to a non-iHerb host", async () => {
    let requestHeaders = new Headers();
    const session = new IHerbSession({
      fetch: async (_input, init) => {
        requestHeaders = new Headers(init?.headers);
        return Response.json({ ok: true });
      },
      rateLimit: { minDelayMs: 0 },
    });

    await session.requestJson("https://example.com/product/1");

    expect(requestHeaders.get("cookie") ?? "").not.toContain("iher-pref1=");
  });

  test("preserves an explicit locale cookie across iHerb subdomains", async () => {
    let requestHeaders = new Headers();
    const session = new IHerbSession({
      cookieHeader:
        "iher-pref1=sccode=FI&lan=fi-FI&scurcode=EUR; locale-token=secret",
      fetch: async (_input, init) => {
        requestHeaders = new Headers(init?.headers);
        return Response.json({ ok: true });
      },
      rateLimit: { minDelayMs: 0 },
    });

    await session.requestJson(
      "https://catalog.app.iherb.com/product/137787",
    );

    expect(requestHeaders.get("cookie")).toContain("lan=fi-FI");
    expect(requestHeaders.get("cookie")).toContain("locale-token=secret");
    expect(requestHeaders.get("cookie")).not.toContain("lan=en-US");
  });
});
