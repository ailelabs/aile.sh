/**
 * One colour table, and one decision about whether to use it.
 *
 * This existed three times over — `index.js`, `config-command.js` and
 * `welcome.js` each declared the same six escapes, `login.js` declared two of
 * them again under different names, and `prompt.js` wrote them inline. Every
 * copy was unconditional, so every copy was wrong in the same way: `aile >
 * setup.log` wrote raw escape bytes into the file, and so did piping into
 * `grep`, into a CI log, or into anything that is not a terminal.
 *
 * That is not cosmetic for this command in particular. The first-run screen is
 * the one a new user is most likely to redirect somewhere — into a gist, into a
 * support ticket, into a screenshot of a log — and `\x1b[36m\x1b[1maile.sh` is
 * what they would be sending.
 *
 * THE DECISION IS MADE ONCE, AT IMPORT, from stdout. Colour is on when stdout
 * is a terminal, off when it is not, with `NO_COLOR` forcing off and
 * `FORCE_COLOR` forcing on. Deciding per-stream would be more precise — stderr
 * can be a terminal while stdout is a pipe — but the same `C` table is used by
 * `console.log` and `console.error` within single functions, and a table that
 * changed meaning depending on which one you passed it to would be a worse
 * trap than the imprecision. Redirecting stdout is the case that matters; it is
 * the one that writes a file someone will read later.
 *
 * `NO_COLOR` is honoured on presence, whatever the value, per no-color.org —
 * `NO_COLOR=0` means the user set it, and second-guessing that is exactly the
 * thing the standard exists to stop.
 */

/**
 * Should we emit colour? Exported so it can be tested against a stub, because
 * the table below is frozen at first import and cannot be re-decided in-process.
 */
export function colorEnabled(env = process.env, stream = process.stdout) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") return true;
  return Boolean(stream?.isTTY);
}

export const COLOR = colorEnabled();

const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

/**
 * The table callers interpolate. When colour is off every key is the empty
 * string, so `${C.cyan}aile connect${C.reset}` degrades to plain text with no
 * conditional at the call site — which is the point. A caller that has to ask
 * "are we in colour?" is a caller that will eventually forget to.
 */
export const C = Object.freeze(
  Object.fromEntries(Object.keys(CODES).map((k) => [k, COLOR ? CODES[k] : ""])),
);
