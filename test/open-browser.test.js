/**
 * Handing the authorize URL to the desktop's browser.
 *
 * THE BUG THIS FILE EXISTS FOR. `cmd.exe` treats `&` as a command separator, and
 * an OAuth authorize URL is a query string full of them. Opening one with
 * `cmd /c start "" <url>` delivered this to the browser:
 *
 *     https://claude.ai/oauth/authorize?response_type=code
 *
 * and ran `client_id=…`, `state=…` and `scope=…` as if they were programs. The
 * provider then rendered "Invalid OAuth Request / Missing client_id parameter" —
 * naming a parameter that had been built correctly, printed correctly to the
 * terminal, and asserted on correctly by `authorize-url.test.js`. EVERY existing
 * test passed while the feature was broken, because every one of them injected
 * `openBrowser` and so stopped exactly one step short of the defect.
 *
 * That is the lesson worth encoding: the seam we inject at is also the seam we
 * stop testing at. So these tests take the command as DATA, from a pure builder,
 * and check the URL survives it — which needs no browser, no display, and no
 * Windows. `platform` is a parameter, so a Linux CI box checks the win32 branch
 * that only a Windows user can hit at runtime, which is the branch that broke.
 */

import { describe, expect, it } from "bun:test";
import { browserOpenCommand } from "../src/providers/link.js";

/** A real authorize URL: every metacharacter that matters, in one string. */
const AUTH_URL = "https://claude.ai/oauth/authorize"
  + "?response_type=code"
  + "&client_id=9d1c3e12-1234-4a5b-8c9d-abcdef012345"
  + "&redirect_uri=http%3A%2F%2Flocalhost%3A54321%2Fcallback"
  + "&state=Zm9vYmFy-_x"
  + "&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  + "&code_challenge_method=S256"
  + "&scope=org%3Acreate_api_key%20user%3Aprofile"
  + "&code=true";

/** What PowerShell will actually run, recovered from -EncodedCommand. */
function decodeWindows({ args }) {
  const i = args.indexOf("-EncodedCommand");
  expect(i).toBeGreaterThan(-1);
  return Buffer.from(args[i + 1], "base64").toString("utf16le");
}

// ---------------------------------------------------------------------------

describe("windows", () => {
  /**
   * The regression, stated as the symptom the user saw. Not "the args contain
   * the URL" — the truncated URL is *also* a substring of the full one, so a
   * containment check would have passed against the bug. What matters is that
   * nothing is LOST, so the assertion is on the whole string.
   */
  it("carries every query parameter, not just the ones before the first &", () => {
    const script = decodeWindows(browserOpenCommand(AUTH_URL, "win32"));
    expect(script).toContain(AUTH_URL);
    for (const p of ["client_id", "state", "code_challenge", "scope", "code=true"]) {
      expect({ param: p, present: script.includes(p) }).toEqual({ param: p, present: true });
    }
  });

  it("never spawns cmd.exe, whose parser is the whole problem", () => {
    const { cmd, args } = browserOpenCommand(AUTH_URL, "win32");
    expect(cmd).toBe("powershell.exe");
    expect(cmd).not.toBe("cmd");
    // `/c` would mean cmd came back by another name.
    expect(args).not.toContain("/c");
  });

  it("passes the command base64-encoded, so no metacharacter is re-parsed", () => {
    // The encoding IS the fix: an encoded argument cannot be split on `&`,
    // quoted wrong, or expanded by anything between here and PowerShell.
    const { args } = browserOpenCommand(AUTH_URL, "win32");
    expect(args).toContain("-EncodedCommand");
    // UTF-16LE is what -EncodedCommand requires; UTF-8 decodes to mojibake and
    // PowerShell rejects it, which would break opening entirely.
    expect(decodeWindows({ args })).toMatch(/^Start-Process /);
  });

  it("does not load the user's profile, which can print or fail on its own", () => {
    const { args } = browserOpenCommand(AUTH_URL, "win32");
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-NonInteractive");
  });

  /**
   * A URL cannot contain a bare `'` un-encoded, but the escape is what stops a
   * malformed one from ending the string literal and turning the rest into
   * PowerShell code. Cheap to pin, and this is the only injection route in the
   * fix.
   */
  it("escapes a single quote rather than letting it close the literal", () => {
    const script = decodeWindows(browserOpenCommand("https://x.test/?a='; whoami; '", "win32"));
    expect(script).toContain("''");
    expect(script).not.toMatch(/Start-Process '[^']*'\s*;\s*whoami/);
  });

  it("survives the characters a PKCE challenge and an encoded scope actually use", () => {
    // `-`, `_`, `%20`, `:` and `+` all appear in real authorize URLs.
    const url = "https://a.test/o?c=aB-_9%20x&s=org%3Aread+write&t=a+b";
    expect(decodeWindows(browserOpenCommand(url, "win32"))).toContain(url);
  });
});

describe("macos and linux", () => {
  // No shell is involved: the URL is one argv entry, so there is nothing to
  // re-parse and nothing to escape. Pinned so a future "let's unify the
  // platforms" refactor cannot quietly route these through a shell too.
  it.each([
    ["darwin", "open"],
    ["linux", "xdg-open"],
  ])("hands %s's %s the URL as a single unmodified argument", (platform, expected) => {
    const { cmd, args } = browserOpenCommand(AUTH_URL, platform);
    expect(cmd).toBe(expected);
    expect(args).toEqual([AUTH_URL]);
  });

  it("treats an unknown platform as posix rather than guessing at a shell", () => {
    const { cmd, args } = browserOpenCommand(AUTH_URL, "freebsd");
    expect(cmd).toBe("xdg-open");
    expect(args).toEqual([AUTH_URL]);
  });
});

describe("across every platform", () => {
  /**
   * The property that actually matters, checked the same way everywhere: the URL
   * the provider receives is the URL we built. Per-platform assertions above can
   * each be right while a new branch added later is wrong; this one covers the
   * branch that does not exist yet.
   */
  it.each(["win32", "darwin", "linux"])("loses nothing from the URL on %s", (platform) => {
    const built = browserOpenCommand(AUTH_URL, platform);
    const carried = platform === "win32" ? decodeWindows(built) : built.args.join(" ");
    expect(carried).toContain(AUTH_URL);
  });

  it("keeps the URL in argv, never interpolated into a shell string", () => {
    // `shell: true` anywhere in this path would reintroduce the bug on Windows
    // and add an injection route everywhere else. The shape of the return value
    // is what prevents it: a command plus an argv array, never one string.
    for (const platform of ["win32", "darwin", "linux"]) {
      const { cmd, args } = browserOpenCommand(AUTH_URL, platform);
      expect({ platform, isArray: Array.isArray(args) }).toEqual({ platform, isArray: true });
      expect({ platform, hasSpace: cmd.includes(" ") }).toEqual({ platform, hasSpace: false });
    }
  });
});
