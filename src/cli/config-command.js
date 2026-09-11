/**
 * `aile config` — read and change this machine's settings.
 *
 *   aile config                    show every setting, grouped
 *   aile config <key>              show one value
 *   aile config <key> <value>      change it
 *   aile config --reset [key…]     restore defaults
 *   aile config --path             print the file's location
 *
 * Presentation only. Every rule about what a setting is, what it may hold and
 * whether it may be written at all lives in src/config/settings.js, so this file
 * cannot accidentally admit a value the schema would reject.
 */

import { loadConfig, updateSettings, resetSettings, storedOverrides, CONFIG_FILE } from "../relay/config.js";
import { SCHEMA, GROUPS, defaults, displayValue, isKnownKey, settableKeys } from "../config/settings.js";
import { C } from "./colors.js";

function fail(msg, hint = null) {
  console.error(`\n${C.red}${msg}${C.reset}`);
  if (hint) console.error(`${C.dim}${hint}${C.reset}`);
  console.error();
  process.exit(1);
}

function showAll() {
  const settings = loadConfig();
  const base = defaults();
  const overridden = storedOverrides();

  console.log(`\n${C.bold}Settings${C.reset} ${C.dim}${CONFIG_FILE}${C.reset}\n`);

  for (const group of GROUPS) {
    const keys = Object.keys(SCHEMA).filter((k) => SCHEMA[k].group === group);
    if (!keys.length) continue;
    console.log(`${C.bold}${group}${C.reset}`);

    for (const key of keys) {
      const spec = SCHEMA[key];
      const shown = displayValue(key, settings[key]);
      // Marking what differs from default is the whole reason to read this
      // screen: it answers "what did I change?" without a diff.
      const isChanged = Object.prototype.hasOwnProperty.call(overridden, key) &&
                        settings[key] !== base[key];
      const mark = isChanged ? `${C.yellow}*${C.reset}` : " ";
      const value = spec.dangerous && settings[key] === true
        ? `${C.yellow}${shown}${C.reset}`
        : `${C.cyan}${shown}${C.reset}`;
      const lock = spec.protected ? ` ${C.dim}(read-only)${C.reset}` : "";

      console.log(`${mark} ${key.padEnd(20)} ${value}${lock}`);
      console.log(`  ${C.dim}${" ".repeat(20)} ${spec.describe}${C.reset}`);
    }
    console.log();
  }

  const changedCount = Object.keys(overridden).filter((k) => k !== "renterToken" && isKnownKey(k)).length;
  console.log(`${C.dim}${C.reset}${C.yellow}*${C.reset}${C.dim} = changed from default (${changedCount})`);
  console.log(`Change one with: ${C.reset}${C.cyan}aile config <key> <value>${C.reset}\n`);
}

function showOne(key) {
  if (!isKnownKey(key)) {
    fail(`Unknown setting "${key}"`, "Run `aile config` to see them all.");
  }
  const settings = loadConfig();
  const spec = SCHEMA[key];

  console.log(`\n${C.bold}${key}${C.reset}  ${C.cyan}${displayValue(key, settings[key])}${C.reset}`);
  console.log(`${C.dim}${spec.describe}${C.reset}`);
  console.log(`${C.dim}default: ${displayValue(key, defaults()[key])}${C.reset}`);

  if (spec.type === "enum") console.log(`${C.dim}one of:  ${spec.values.join(", ")}${C.reset}`);
  if (spec.type === "int" && (spec.min !== undefined || spec.max !== undefined)) {
    console.log(`${C.dim}range:   ${spec.min ?? "-"} to ${spec.max ?? "-"}${C.reset}`);
  }
  if (spec.protected) console.log(`${C.dim}managed by \`aile login\` — not settable here${C.reset}`);
  console.log();
}

function setOne(key, rawValue) {
  const result = updateSettings({ [key]: rawValue });
  if (!result.ok) fail(result.error);

  const settings = result.value;
  console.log(`\n${C.green}${key}${C.reset} = ${C.cyan}${displayValue(key, settings[key])}${C.reset}`);

  if (SCHEMA[key].dangerous && settings[key] === true) {
    console.log(`${C.yellow}Warning:${C.reset} this weakens a protection. Staging only.`);
  }
  // A user who changes a timer while the node is running would otherwise
  // reasonably assume it took effect immediately.
  console.log(`${C.dim}Takes effect on the next ${C.reset}${C.cyan}aile start${C.reset}${C.dim}.${C.reset}\n`);
}

function doReset(keys) {
  for (const key of keys) {
    if (!isKnownKey(key)) fail(`Unknown setting "${key}"`, "Run `aile config` to see them all.");
    if (SCHEMA[key].protected) {
      fail(`"${key}" is not reset here.`, "To clear your sign-in, run: aile logout");
    }
  }

  const result = resetSettings(keys);
  const n = result.reset.length;
  if (!n) {
    console.log(`\n${C.dim}Nothing to reset — everything is already at its default.${C.reset}\n`);
    return;
  }
  console.log(`\n${C.green}Reset ${n} setting${n === 1 ? "" : "s"}${C.reset} ${C.dim}${result.reset.join(", ")}${C.reset}`);
  console.log(`${C.dim}Your sign-in and connected accounts are untouched.${C.reset}\n`);
}

export function configCommand(args) {
  if (args.path) {
    console.log(CONFIG_FILE);
    return;
  }

  // `aile config --reset` with no key resets everything settable; naming keys
  // narrows it. Both are explicit, so neither needs a confirmation prompt —
  // and nothing here can touch the token or a connected account.
  if (args.reset) {
    doReset(args._.slice(1));
    return;
  }

  const [, key, ...rest] = args._;
  if (!key) return showAll();

  const value = rest.join(" ");
  if (!value) return showOne(key);

  setOne(key, value);
}

export { settableKeys };
