#!/usr/bin/env bun

import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import CDP from "chrome-remote-interface";

import {
  formatIHerbEnv,
  iHerbCookieHeader,
  type ChromeCookie,
} from "./chrome-cookies.js";

const IHERB_START_URL = "https://www.iherb.com/search?kw=magnesium";
const DEFAULT_TIMEOUT_MS = 180_000;

interface CliOptions {
  chromePath?: string;
  timeoutMs: number;
}

function usage(): string {
  return `iherb-api — capture an iHerb browser session for the iherb-api package

Usage:
  bunx iherb-api [--chrome-path PATH] [--timeout SECONDS]

The command launches an isolated temporary Chrome profile, opens iHerb, waits
for browser verification to finish, and prints IHERB_COOKIE and
IHERB_USER_AGENT lines suitable for .env.

It does not read cookies from your normal Chrome profile. Cookie values are
printed to stdout, so do not paste the output into logs or commit it to Git.`;
}

function parseCliOptions(argv: string[]): CliOptions | null {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      "chrome-path": { type: "string" },
      timeout: { type: "string", default: String(DEFAULT_TIMEOUT_MS / 1_000) },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (parsed.values.help) return null;
  const timeoutSeconds = Number(parsed.values.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("--timeout must be a positive number of seconds");
  }
  return {
    ...(parsed.values["chrome-path"]
      ? { chromePath: parsed.values["chrome-path"] }
      : {}),
    timeoutMs: timeoutSeconds * 1_000,
  };
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findChrome(explicitPath?: string): Promise<string> {
  const candidates = [
    explicitPath,
    process.env.CHROME_PATH,
    ...(process.platform === "linux"
      ? [
          "/opt/google/chrome/chrome",
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ]
      : []),
    ...(process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : []),
    ...(process.platform === "win32"
      ? [
          process.env.LOCALAPPDATA
            ? join(
                process.env.LOCALAPPDATA,
                "Google",
                "Chrome",
                "Application",
                "chrome.exe",
              )
            : undefined,
          process.env.PROGRAMFILES
            ? join(
                process.env.PROGRAMFILES,
                "Google",
                "Chrome",
                "Application",
                "chrome.exe",
              )
            : undefined,
        ]
      : []),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await executableExists(candidate)) return candidate;
  }
  throw new Error(
    "Chrome/Chromium was not found. Set CHROME_PATH or pass --chrome-path.",
  );
}

async function waitForDevToolsPort(
  profileDirectory: string,
  child: ChildProcess,
  timeoutMs = 15_000,
): Promise<number> {
  const activePortFile = join(profileDirectory, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(
        "Chrome exited before DevTools became available. A graphical desktop may be required.",
      );
    }
    try {
      const contents = await readFile(activePortFile, "utf8");
      const port = Number(contents.split(/\r?\n/, 1)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Chrome creates DevToolsActivePort after its profile is initialized.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out while waiting for Chrome DevTools.");
}

async function findIHerbTarget(port: number): Promise<CDP.Target> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const targets = await CDP.List({ port });
    const target = targets.find(
      (item) =>
        item.type === "page" &&
        /^https:\/\/(?:www\.)?iherb\.com\//i.test(item.url),
    );
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Chrome opened, but the iHerb page was not found.");
}

async function captureCookies(
  port: number,
  timeoutMs: number,
): Promise<{ cookieHeader: string; userAgent: string }> {
  const target = await findIHerbTarget(port);
  const client = await CDP({ port, target: target.id });
  const deadline = Date.now() + timeoutMs;

  try {
    await Promise.all([client.Network.enable({}), client.Runtime.enable()]);
    const version = await client.Browser.getVersion();
    let consecutiveReadyChecks = 0;

    while (Date.now() < deadline) {
      const state = await client.Runtime.evaluate({
        expression: `(() => ({
          host: location.hostname,
          ready: document.readyState === "complete",
          title: document.title,
          challenged: Boolean(document.querySelector(
            "#challenge-form, [class*='cf-chl'], [id*='cf-chl']"
          )) || /verify you are human|just a moment|access denied/i.test(
            document.title
          )
        }))()`,
        returnByValue: true,
      });
      const value = state.result.value as
        | {
            host?: string;
            ready?: boolean;
            challenged?: boolean;
          }
        | undefined;
      const cookieResult = await client.Network.getCookies({
        urls: [
          "https://www.iherb.com/",
          "https://www.iherb.com/search",
          "https://www.iherb.com/pr/",
        ],
      });
      const cookieHeader = iHerbCookieHeader(
        cookieResult.cookies as ChromeCookie[],
      );
      const ready =
        value?.ready === true &&
        value.challenged !== true &&
        /(?:^|\.)iherb\.com$/i.test(value.host ?? "") &&
        cookieHeader.length > 0;

      consecutiveReadyChecks = ready ? consecutiveReadyChecks + 1 : 0;
      if (consecutiveReadyChecks >= 2) {
        return {
          cookieHeader,
          userAgent: version.userAgent,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  } finally {
    await client.close();
  }

  throw new Error(
    "Timed out waiting for iHerb verification. Complete the check in Chrome and retry.",
  );
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
    return { ok: response.ok && !challenged, status: response.status, challenged };
  } catch {
    return { ok: false, status: null, challenged: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function terminateChrome(child: ChildProcess): Promise<void> {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(argv);
  if (!options) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const chromePath = await findChrome(options.chromePath);
  const profileDirectory = await mkdtemp(join(tmpdir(), "iherb-api-chrome-"));
  const chrome = spawn(
    chromePath,
    [
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      IHERB_START_URL,
    ],
    {
      stdio: "ignore",
      windowsHide: false,
    },
  );

  process.stderr.write(
    "Chrome opened with an isolated temporary profile.\n" +
      "Complete any iHerb verification or sign-in in that window.\n" +
      "Waiting for a usable session…\n",
  );

  try {
    const port = await waitForDevToolsPort(profileDirectory, chrome);
    const captured = await captureCookies(port, options.timeoutMs);
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
        "Warning: cookies were captured, but Bun fetch still received a " +
          `${validation.status ?? "blocked"} browser challenge. ` +
          "iHerb may also bind access to TLS fingerprint or IP.\n",
      );
    } else {
      process.stderr.write(
        "Warning: the exported session could not be validated by Bun fetch.\n",
      );
    }
    process.stderr.write(
      "Browser session captured. Treat the following values as secrets.\n",
    );
    process.stdout.write(
      `${formatIHerbEnv(captured.cookieHeader, captured.userAgent)}\n`,
    );
  } finally {
    await terminateChrome(chrome);
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`iherb-api: ${message}\n`);
    process.exitCode = 1;
  });
}
