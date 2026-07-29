#!/usr/bin/env bun

import { parseArgs } from "node:util";

import {
  extractIHerbBrowserSession,
  listBrowserProfiles,
  type BrowserChoice,
} from "./browser-session.js";
import { formatIHerbEnv } from "./chrome-cookies.js";

const IHERB_START_URL = "https://www.iherb.com/search?kw=magnesium";

interface CliOptions {
  browser: BrowserChoice;
  profile?: string;
  userAgent?: string;
  listProfiles: boolean;
  validate: boolean;
}

function usage(): string {
  return `iherb-api — export an existing iHerb browser session

Usage:
  bunx iherb-api [--browser auto|chrome|brave] [--profile NAME]
  bunx iherb-api --list-profiles

The command reads only *.iherb.com cookies from existing Chrome and Brave
profiles. It does not launch, stop, or modify a browser.

Options:
  --browser NAME     Auto-select (default), Chrome, or Brave
  --profile NAME     Browser profile display name or directory
  --list-profiles    Show discovered profiles without decrypting cookies
  --user-agent UA    Override the inferred browser User-Agent
  --no-validate      Skip the optional server-side validation request
  -h, --help         Show this help

Cookie values are printed to stdout. Do not paste them into logs or commit
them to Git.`;
}

function parseBrowser(value: string): BrowserChoice {
  const normalized = value.toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "chrome" ||
    normalized === "brave"
  ) {
    return normalized;
  }
  throw new Error("--browser must be auto, chrome, or brave");
}

function parseCliOptions(argv: string[]): CliOptions | null {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      browser: { type: "string", default: "auto" },
      profile: { type: "string" },
      "list-profiles": { type: "boolean", default: false },
      "user-agent": { type: "string" },
      "no-validate": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (parsed.values.help) return null;
  return {
    browser: parseBrowser(parsed.values.browser),
    ...(parsed.values.profile
      ? { profile: parsed.values.profile }
      : {}),
    ...(parsed.values["user-agent"]
      ? { userAgent: parsed.values["user-agent"] }
      : {}),
    listProfiles: parsed.values["list-profiles"],
    validate: !parsed.values["no-validate"],
  };
}

async function validateServerSideSession(
  cookieHeader: string,
  userAgent: string,
): Promise<{ ok: boolean; status: number | null; challenged: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(IHERB_START_URL, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: cookieHeader,
        "User-Agent": userAgent,
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const challenged =
      response.status === 403 ||
      response.headers.get("cf-mitigated")?.toLowerCase() === "challenge";
    return {
      ok: response.ok && !challenged,
      status: response.status,
      challenged,
    };
  } catch {
    return { ok: false, status: null, challenged: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function printProfiles(browser: BrowserChoice): Promise<void> {
  const profiles = await listBrowserProfiles({ browser });
  if (profiles.length === 0) {
    process.stdout.write("No Chrome or Brave profiles were found.\n");
    return;
  }
  process.stdout.write(
    ["BROWSER", "DIRECTORY", "PROFILE", "IHERB_COOKIES", "LAST_USED"].join(
      "\t",
    ) + "\n",
  );
  for (const profile of profiles) {
    process.stdout.write(
      [
        profile.browser,
        profile.directory,
        profile.name,
        String(profile.iHerbCookieCount),
        profile.lastUsed ? "yes" : "no",
      ].join("\t") + "\n",
    );
  }
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(argv);
  if (!options) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.listProfiles) {
    await printProfiles(options.browser);
    return;
  }

  process.stderr.write(
    "Reading existing Chrome/Brave profiles; no browser will be opened.\n",
  );
  const captured = await extractIHerbBrowserSession({
    browser: options.browser,
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
  });
  process.stderr.write(
    `Selected ${captured.profile.browser} profile ` +
      `"${captured.profile.name}" (${captured.profile.directory}).\n`,
  );
  if (captured.failedCookieCount > 0) {
    process.stderr.write(
      `Warning: ${captured.failedCookieCount} iHerb cookie(s) could not be ` +
        "decrypted and were omitted.\n",
    );
  }

  if (options.validate) {
    const validation = await validateServerSideSession(
      captured.cookieHeader,
      captured.userAgent,
    );
    if (validation.ok) {
      process.stderr.write(
        "The exported session was accepted by a server-side fetch.\n",
      );
    } else if (validation.challenged) {
      process.stderr.write(
        "Warning: cookies were extracted, but Bun fetch still received a " +
          `${validation.status ?? "blocked"} browser challenge. ` +
          "iHerb may also bind access to TLS fingerprint or IP.\n",
      );
    } else {
      process.stderr.write(
        "Warning: the exported session could not be validated by Bun fetch.\n",
      );
    }
  }

  process.stderr.write(
    "Existing browser session extracted. Treat the following values as secrets.\n",
  );
  process.stdout.write(
    `${formatIHerbEnv(captured.cookieHeader, captured.userAgent)}\n`,
  );
}

if (import.meta.main) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`iherb-api: ${message}\n`);
    process.exitCode = 1;
  });
}
