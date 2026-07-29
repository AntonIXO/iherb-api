import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createCipheriv,
  createHash,
  pbkdf2Sync,
} from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decryptChromiumCookieValue,
  discoverBrowserProfiles,
  extractIHerbBrowserSession,
} from "../src/browser-session.js";

function encryptLinuxCookie(
  value: string,
  domain: string,
  databaseVersion: number,
): Buffer {
  const key = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
  const cipher = createCipheriv(
    "aes-128-cbc",
    key,
    Buffer.alloc(16, 0x20),
  );
  const payload =
    databaseVersion >= 24
      ? Buffer.concat([
          createHash("sha256").update(domain).digest(),
          Buffer.from(value),
        ])
      : Buffer.from(value);
  return Buffer.concat([
    Buffer.from("v10"),
    cipher.update(payload),
    cipher.final(),
  ]);
}

describe("existing browser profiles", () => {
  test("discovers Chrome and Brave profiles from Local State", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "iherb-profile-test-"));
    const roots = [
      join(homeDirectory, ".config", "google-chrome"),
      join(
        homeDirectory,
        ".config",
        "BraveSoftware",
        "Brave-Browser",
      ),
    ];
    for (const [index, root] of roots.entries()) {
      mkdirSync(join(root, "Default"), { recursive: true });
      writeFileSync(
        join(root, "Local State"),
        JSON.stringify({
          profile: {
            last_used: "Default",
            info_cache: {
              Default: {
                name: index === 0 ? "Personal Chrome" : "Personal Brave",
                active_time: 123,
              },
            },
          },
        }),
      );
      writeFileSync(join(root, "Default", "Cookies"), "");
    }

    const profiles = await discoverBrowserProfiles({
      homeDirectory,
      platform: "linux",
    });

    expect(
      profiles.map(({ browser, directory, name, lastUsed }) => ({
        browser,
        directory,
        name,
        lastUsed,
      })),
    ).toEqual([
      {
        browser: "chrome",
        directory: "Default",
        name: "Personal Chrome",
        lastUsed: true,
      },
      {
        browser: "brave",
        directory: "Default",
        name: "Personal Brave",
        lastUsed: true,
      },
    ]);
  });

  test("decrypts Linux v10 cookies and validates the v24 host hash", async () => {
    const encrypted = encryptLinuxCookie(
      "session-value",
      ".iherb.com",
      24,
    );
    const value = await decryptChromiumCookieValue(
      encrypted,
      ".iherb.com",
      {
        browser: "chrome",
        browserRoot: "/unused",
        databaseVersion: 24,
        platform: "linux",
      },
    );
    expect(value).toBe("session-value");

    expect(
      decryptChromiumCookieValue(encrypted, ".example.com", {
        browser: "chrome",
        browserRoot: "/unused",
        databaseVersion: 24,
        platform: "linux",
      }),
    ).rejects.toThrow("host-integrity");
  });

  test("auto-selects an existing profile and reads only iHerb rows", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "iherb-session-test-"));
    const root = join(homeDirectory, ".config", "google-chrome");
    const profile = join(root, "Default");
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      join(root, "Local State"),
      JSON.stringify({
        profile: {
          last_used: "Default",
          info_cache: { Default: { name: "Personal" } },
        },
      }),
    );
    writeFileSync(join(root, "Last Version"), "150.0.0.0");

    const database = new Database(join(profile, "Cookies"), {
      create: true,
      strict: true,
    });
    database.exec(
      `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
       CREATE TABLE cookies (
         host_key TEXT,
         name TEXT,
         path TEXT,
         is_secure INTEGER,
         expires_utc INTEGER,
         value TEXT,
         encrypted_value BLOB
       );`,
    );
    database
      .query("INSERT INTO meta (key, value) VALUES ($key, $value)")
      .run({ key: "version", value: "24" });
    const insert = database.query(
      `INSERT INTO cookies (
         host_key, name, path, is_secure, expires_utc, value, encrypted_value
       ) VALUES (
         $domain, $name, '/', 1, 0, $value, $encrypted
       )`,
    );
    insert.run({
      domain: ".iherb.com",
      name: "session",
      value: "",
      encrypted: encryptLinuxCookie(
        "from-existing-profile",
        ".iherb.com",
        24,
      ),
    });
    insert.run({
      domain: ".example.com",
      name: "unrelated",
      value: "must-not-be-read",
      encrypted: Buffer.alloc(0),
    });
    database.close(false);

    const session = await extractIHerbBrowserSession({
      browser: "auto",
      homeDirectory,
      platform: "linux",
      userAgent: "Test UA",
    });

    expect(session.profile.browser).toBe("chrome");
    expect(session.profile.directory).toBe("Default");
    expect(session.cookieHeader).toBe("session=from-existing-profile");
    expect(session.cookies).toHaveLength(1);
    expect(session.userAgent).toBe("Test UA");
  });
});
