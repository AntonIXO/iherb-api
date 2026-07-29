import { describe, expect, test } from "bun:test";

import {
  dotenvValue,
  formatIHerbEnv,
  iHerbCookieHeader,
} from "../src/chrome-cookies.js";

describe("Chrome cookie export", () => {
  test("exports only live iHerb cookies and keeps the most specific duplicate", () => {
    const header = iHerbCookieHeader([
      {
        name: "session",
        value: "root",
        domain: ".iherb.com",
        path: "/",
      },
      {
        name: "session",
        value: "specific",
        domain: "www.iherb.com",
        path: "/search",
      },
      {
        name: "other",
        value: "secret",
        domain: ".example.com",
        path: "/",
      },
      {
        name: "expired",
        value: "old",
        domain: ".iherb.com",
        path: "/",
        expires: 1,
      },
    ]);

    expect(header).toBe("session=specific");
  });

  test("escapes dotenv values without exposing extra lines", () => {
    expect(dotenvValue('a"b\\c\nnext')).toBe('"a\\"b\\\\c\\nnext"');
    expect(formatIHerbEnv("cookie=value", "Chrome/Test")).toBe(
      'IHERB_COOKIE="cookie=value"\nIHERB_USER_AGENT="Chrome/Test"',
    );
  });
});
