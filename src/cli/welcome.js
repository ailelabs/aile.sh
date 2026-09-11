/**
 * The first thing a new user sees.
 *
 * Typing `aile` with no arguments used to print a status table — machine id,
 * server URL, "Signed in: NO". That is a correct answer to a question a
 * first-time user has not asked yet. They ran the command to find out what to
 * do, and a table of empty fields does not say.
 *
 * So when there is no token, this takes over: name the product, say in one line
 * what it does, and offer the ways in as a numbered choice. Every other command
 * keeps its own `requireToken` guard — the gate is about the bare invocation,
 * which is the one that has no intent to honour.
 *
 * WHY A CHOICE RATHER THAN JUST STARTING THE BROWSER FLOW. Roughly half the
 * machines this runs on are headless. Opening a browser there does nothing
 * visible, and a flow that appears to hang while "waiting for approval" is the
 * single worst first impression available. Asking costs one keystroke and makes
 * the headless path a first-class answer instead of a recovery.
 *
 * The gate is skippable in every direction that matters: `--help`, `--version`,
 * any real command, and a non-interactive shell all bypass it. It must never be
 * the reason a script cannot run.
 */

import { promptChoice, isInteractive } from "./prompt.js";
import { C } from "./colors.js";

/**
 * The three ways in, in the order they are worth considering.
 *
 * Donating is LAST, and that placement is the honest one. It is the option that
 * pays nothing, so leading with it — or making it the default — would be steering
 * people away from money they could have had for the same work. It is offered at
 * all because the alternative was worse: before this, a machine whose owner did
 * not want an account could not contribute anything, and that is a strange thing
 * to enforce on someone trying to help.
 *
 * Its note says `not paid` in the two words that matter, not "free" or "community
 * mode", because those read as a description of the price to buyers rather than of
 * what the contributor gives up.
 */
export const CHOICES = [
  {
    id: "browser",
    label: "Sign in with your browser",
    note: "get paid · opens a page, or paste a token if it does not",
  },
  {
    id: "paste",
    label: "Paste a token from another device",
    note: "get paid · for a headless machine, SSH, or a container",
  },
  {
    id: "donate",
    label: "Contribute without an account",
    note: "not paid · no sign-up, nothing to remember",
  },
];

/**
 * Show the welcome and return the chosen method.
 *
 * Returns `null` when the user cancelled or there was no terminal to ask on —
 * the caller prints instructions rather than assuming.
 */
export async function welcome({
  serverUrl,
  log = console.log,
  interactive = isInteractive(),
  choose = promptChoice,
} = {}) {
  log(`\n${C.cyan}${C.bold}aile.sh${C.reset}`);
  log(`${C.dim}Share your AI subscription's spare capacity and get paid for it.`);
  log(`Traffic is relayed encrypted — this machine cannot read what it carries.${C.reset}`);

  if (!interactive) return null;

  log("");
  // "Get started" rather than "sign in": one of the three answers is not a
  // sign-in, and a question that presumes otherwise makes the third option look
  // like a mistake in the list.
  const index = await choose(`${C.bold}How would you like to get started?${C.reset}`, CHOICES);
  if (index === null || index === undefined) return null;
  return CHOICES[index].id;
}

/** What to print when we cannot ask — a pipe, a container, a CI job. */
export function welcomeNonInteractive({ log = console.log } = {}) {
  log(`\nSign in first:`);
  log(`  ${C.cyan}aile login${C.reset}                  ${C.dim}browser, or paste a token${C.reset}`);
  log(`  ${C.cyan}aile login --paste${C.reset}          ${C.dim}no browser on this machine${C.reset}`);
  log(`  ${C.cyan}aile login --token <token>${C.reset}  ${C.dim}scripts, images, systemd${C.reset}`);
  log(`\nOr contribute without an account:`);
  log(`  ${C.cyan}aile donate --yes${C.reset}           ${C.dim}not paid · nothing accrues${C.reset}`);
  log(`\n${C.dim}Then: ${C.reset}${C.cyan}aile connect${C.reset}${C.dim} to add an AI account, ${C.reset}${C.cyan}aile start${C.reset}${C.dim} to serve.${C.reset}\n`);
}
