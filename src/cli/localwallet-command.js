/**
 * `aile wallet own …` — the opt-in self-custody wallet.
 *
 *   aile wallet own                 address and what it holds (no unlock)
 *   aile wallet own create          new recovery phrase, shown once
 *   aile wallet own import          restore from a phrase (typed or piped)
 *   aile wallet own send <amt> <USDC|SOL> <to>
 *   aile wallet own swap <amt> <SOL|USDC> <USDC|SOL>   through Jupiter
 *   aile wallet own remove          delete it from this machine
 *
 * ==========================================================================
 * A DIFFERENT WALLET FROM `aile wallet`, AND THE OUTPUT SAYS SO EVERY TIME.
 * `aile wallet` is the account's: custodial, made at sign-in, never touched by
 * this client. This one is a key on this machine that the user made on purpose.
 * Conflating them would be the worst confusion this command could cause — a
 * user funding the wrong one, or believing the server can recover a phrase it
 * has never seen. So every screen here names which wallet it is.
 * ==========================================================================
 *
 * THE PHRASE NEVER TRAVELS ON THE COMMAND LINE. `import` reads it from a hidden
 * prompt or stdin; a flag would leave it in shell history and in `ps`.
 */

import { loadConfig } from "../relay/config.js";
import { C } from "./colors.js";
import { die, withSpinner, kv, sym } from "./ui.js";
import { isInteractive, promptSecret, promptConfirm, promptLine } from "./prompt.js";
import { printQr } from "./qr.js";
import { showQr } from "./renter-command.js";

export async function localWalletCommand(args) {
  const sub = args._[2] || "show";
  switch (sub) {
    case "show": case "status": return show(args);
    case "create": case "new": return create(args);
    case "import": case "restore": return importPhrase(args);
    case "send": return send(args);
    case "swap": return swap(args);
    case "remove": case "delete": return remove(args);
    default:
      die(`Unknown: aile wallet own ${sub}`, "One of: show, create, import, send, swap, remove — `aile help wallet` has examples.");
  }
}

async function show(args) {
  const store = await import("../localwallet/store.js");
  if (!store.walletExists()) {
    if (args.json) return void console.log(JSON.stringify({ own: null }, null, 2));
    console.log(`\n  ${C.dim}Your own wallet isn't set up on this machine yet.${C.reset}`);
    console.log(`  ${C.dim}Create one to pay per call with a key you hold:${C.reset} ${C.cyan}aile wallet own create${C.reset}\n`);
    return;
  }
  const { network, balances } = await import("../localwallet/solana.js");
  const info = store.readWalletInfo();
  const net = network(loadConfig());
  const b = await withSpinner("Reading your own wallet…", balances(info.address, net));

  if (args.json) {
    console.log(JSON.stringify({ own: { address: info.address, network: net.name, encrypted: info.encrypted, usdc: b.usdc, sol: b.sol, file: store.WALLET_FILE } }, null, 2));
    return;
  }
  console.log(`\n  ${C.bold}Own wallet${C.reset}  ${C.dim}(a key on this machine — not your account's wallet)${C.reset}\n`);
  console.log(kv([
    ["Address", `${C.cyan}${info.address}${C.reset}`],
    ["USDC", b.usdc === null ? `${C.dim}could not be read${C.reset}` : `${C.green}$${b.usdc}${C.reset}`],
    ["SOL", b.sol === null ? `${C.dim}could not be read${C.reset}` : String(b.sol)],
    ["Network", `${net.name}${net.publicRpc ? ` ${C.dim}(public RPC — set solanaRpc for a faster one)${C.reset}` : ""}`],
    ["Stored", `${store.WALLET_FILE}${info.encrypted ? "" : ` ${C.yellow}(not encrypted)${C.reset}`}`],
  ]));
  if (showQr(args)) printQr(info.address, { caption: `${C.dim}Scan to send USDC on Solana ${net.name} to this wallet${C.reset}` });
  console.log(`\n  ${C.dim}Pays per call:${C.reset} ${C.cyan}aile chat "…" --model <m> --pay own${C.reset}`);
  console.log(`  ${C.dim}Tops up your account:${C.reset} ${C.cyan}aile deposit --from-own <amount>${C.reset}\n`);
}

async function create(args) {
  const store = await import("../localwallet/store.js");
  if (store.walletExists()) {
    die("You already have your own wallet on this machine.", "`aile wallet own remove` first — after backing up its phrase — to make a new one.");
  }
  const { newMnemonic, signerFromMnemonic } = await import("../localwallet/derive.js");
  const passphrase = await choosePassphrase(args);
  const mnemonic = newMnemonic();
  const signer = await signerFromMnemonic(mnemonic);
  const net = loadConfig().walletNetwork === "devnet" ? "devnet" : "mainnet";
  store.writeWallet({ mnemonic, address: signer.address, network: net, passphrase });

  if (args.json) {
    console.log(JSON.stringify({ address: signer.address, network: net, encrypted: Boolean(passphrase), mnemonic }, null, 2));
    return;
  }
  console.log(`\n  ${C.green}${sym.ok}${C.reset} Own wallet created ${C.dim}(${net}${passphrase ? ", encrypted" : ", NOT encrypted"})${C.reset}`);
  console.log(`\n  Address  ${C.cyan}${signer.address}${C.reset}`);
  console.log(`\n  ${C.yellow}${C.bold}Recovery phrase — write it down now. It is shown once, and nobody can recover it for you.${C.reset}\n`);
  printPhrase(mnemonic);
  console.log(`\n  ${C.dim}It restores this wallet in Phantom or Solflare too. aile never sends it anywhere.${C.reset}`);
  console.log(`  ${C.dim}Fund the address with USDC on Solana, then:${C.reset} ${C.cyan}aile chat "…" --model <m> --pay own${C.reset}\n`);
}

async function importPhrase(args) {
  const store = await import("../localwallet/store.js");
  if (store.walletExists()) die("You already have your own wallet on this machine.", "`aile wallet own remove` it first.");
  const { isValidMnemonic, normalizeMnemonic, signerFromMnemonic } = await import("../localwallet/derive.js");

  let phrase;
  if (isInteractive() && args.phrase !== "-") {
    phrase = await promptSecret("  Recovery phrase (hidden) > ");
  } else {
    let buf = "";
    for await (const chunk of process.stdin) buf += chunk;
    phrase = buf;
  }
  phrase = normalizeMnemonic(phrase);
  if (!isValidMnemonic(phrase)) die("That is not a valid recovery phrase.", "12 or 24 words, separated by spaces.");

  const passphrase = await choosePassphrase(args);
  const signer = await signerFromMnemonic(phrase);
  const net = loadConfig().walletNetwork === "devnet" ? "devnet" : "mainnet";
  store.writeWallet({ mnemonic: phrase, address: signer.address, network: net, passphrase });
  if (args.json) return void console.log(JSON.stringify({ address: signer.address, network: net, encrypted: Boolean(passphrase) }, null, 2));
  console.log(`\n  ${C.green}${sym.ok}${C.reset} Own wallet restored: ${C.cyan}${signer.address}${C.reset}\n`);
}

async function send(args) {
  const [, , , amount, token, to] = args._;
  if (!amount || !token || !to) die("usage: aile wallet own send <amount> <USDC|SOL> <address>");
  const lw = await import("../localwallet/index.js");
  if (!lw.walletExists()) die("Your own wallet isn't set up on this machine.", "Create one with `aile wallet own create`.");
  const config = loadConfig();

  // The cap applies to sends too, in USD terms, for USDC. SOL is not priced
  // here, so a SOL send always asks (or needs --yes).
  if (String(token).toUpperCase() === "USDC") {
    const micros = BigInt(Math.round(Number(amount) * 1e6));
    const cap = lw.capMicros(args, config);
    if (micros > cap) die(`$${amount} is over your own-wallet cap of $${lw.formatMicros(cap)}.`, "Raise it for this send with --max-usd.");
  }

  const passphrase = await lw.resolvePassphrase(args, { prompt: (q) => promptSecret(q), interactive: isInteractive() }).catch((e) => die(e.message));
  const wallet = await withSpinner("Unlocking your own wallet…", lw.unlock(passphrase, config)).catch((e) => die(e.message));

  if (!args.yes) {
    if (!isInteractive()) die("Refusing to send without a terminal to confirm on.", "Pass --yes to send from a script.");
    const ok = await promptConfirm(`  Send ${amount} ${String(token).toUpperCase()} to ${to}?`, { defaultYes: false });
    if (!ok) die("Cancelled — nothing was sent.");
  }
  try {
    const sent = await withSpinner("Sending…", lw.sendFromLocal({ wallet, token, amount, to }));
    if (args.json) return void console.log(JSON.stringify(sent, null, 2));
    console.log(`\n  ${C.green}${sym.ok}${C.reset} Sent ${amount} ${String(token).toUpperCase()}.`);
    console.log(`    ${C.dim}${sent.explorer}${C.reset}\n`);
  } catch (e) {
    die(`The transfer failed: ${e.message}`);
  }
}

/**
 * SOL ⇄ USDC through Jupiter. The quote is shown and confirmed before anything
 * is signed; off a terminal, `--yes` confirms. The payment cap does not apply —
 * nothing leaves the wallet, it changes denomination — but the checks in
 * localwallet/swap.js do (SOL kept for fees, price impact, the signer).
 */
async function swap(args) {
  const [, , , amount, from, to] = args._;
  if (!amount || !from || !to) die("usage: aile wallet own swap <amount> <SOL|USDC> <USDC|SOL>", "e.g. `aile wallet own swap 0.05 SOL USDC`");
  const lw = await import("../localwallet/index.js");
  if (!lw.walletExists()) die("Your own wallet isn't set up on this machine.", "Create one with `aile wallet own create`.");
  const { quoteSwap, executeSwap } = await import("../localwallet/swap.js");
  const config = loadConfig();

  const passphrase = await lw.resolvePassphrase(args, { prompt: (q) => promptSecret(q), interactive: isInteractive() }).catch((e) => die(e.message));
  const wallet = await withSpinner("Unlocking your own wallet…", lw.unlock(passphrase, config)).catch((e) => die(e.message));
  const holdings = await withSpinner("Reading the wallet…", lw.balances(wallet.address, wallet.net));

  let quote;
  try {
    quote = await withSpinner("Asking Jupiter for a quote…", quoteSwap({ address: wallet.address, net: wallet.net, amount, from, to, holdings }));
  } catch (e) {
    die(e.message, e.hint ?? null);
  }

  if (!args.json) {
    console.log(`\n  Swap     ${C.bold}${quote.inAmount} ${quote.from}${C.reset} → ${C.green}≈ ${quote.outAmount} ${quote.to}${C.reset}${quote.usd !== null ? ` ${C.dim}($${quote.usd.toFixed(2)})${C.reset}` : ""}`);
    console.log(`  ${C.dim}Route ${quote.route} ${sym.dot} price impact ${(quote.impact * 100).toFixed(3)}% ${sym.dot} network fee and rent ≈ ${quote.solCost.toFixed(6)} SOL${C.reset}`);
  }
  if (!args.yes) {
    if (!isInteractive()) die("Refusing to swap without a terminal to confirm on.", "Pass --yes to swap from a script.");
    const ok = await promptConfirm("  Swap?", { defaultYes: false });
    if (!ok) die("Cancelled — nothing was signed.");
  }

  try {
    const done = await withSpinner("Swapping…", executeSwap({ signer: wallet.signer, quote }));
    const link = wallet.net.explorer(done.signature);
    if (args.json) return void console.log(JSON.stringify({ ...done, from: quote.from, to: quote.to, explorer: link }, null, 2));
    console.log(`\n  ${C.green}${sym.ok}${C.reset} Swapped ${done.inAmount} ${quote.from} for ${done.outAmount} ${quote.to}.`);
    console.log(`    ${C.dim}${link}${C.reset}\n`);
  } catch (e) {
    die(e.message, e.hint ?? null);
  }
}

async function remove(args) {
  const store = await import("../localwallet/store.js");
  if (!store.walletExists()) die("Your own wallet isn't set up on this machine.");
  const info = store.readWalletInfo();
  if (!args.yes) {
    if (!isInteractive()) die("Refusing to delete a wallet without a terminal to confirm on.", "Pass --yes from a script.");
    console.log(`\n  ${C.yellow}This deletes the key for ${info.address} from this machine.${C.reset}`);
    console.log(`  ${C.dim}Anything it holds is only recoverable with its recovery phrase.${C.reset}`);
    const typed = await promptLine(`  Type the last 4 characters of the address to confirm > `);
    if (typed.trim() !== info.address.slice(-4)) die("Not removed — that did not match.");
  }
  store.removeWallet();
  console.log(`\n  ${C.green}${sym.ok}${C.reset} Own wallet removed from this machine.\n`);
}

/**
 * The passphrase for a new wallet. `--no-encrypt` is the only way to skip it,
 * and it is said out loud; off a terminal it comes from --passphrase or
 * AILE_WALLET_PASSPHRASE.
 */
async function choosePassphrase(args) {
  if (args["no-encrypt"]) return null;
  if (typeof args.passphrase === "string" && args.passphrase) return args.passphrase;
  if (process.env.AILE_WALLET_PASSPHRASE) return process.env.AILE_WALLET_PASSPHRASE;
  if (!isInteractive()) {
    die("A passphrase is needed to encrypt the wallet.", "Pass --passphrase, set AILE_WALLET_PASSPHRASE, or --no-encrypt for a throwaway wallet.");
  }
  for (;;) {
    const a = await promptSecret("  Passphrase to encrypt it (8+ characters) > ");
    if (!a || a.length < 8) { console.log(`  ${C.dim}At least 8 characters.${C.reset}`); continue; }
    const b = await promptSecret("  Same again > ");
    if (a === b) return a;
    console.log(`  ${C.dim}Those did not match — once more.${C.reset}`);
  }
}

function printPhrase(mnemonic) {
  const words = mnemonic.split(" ");
  const cols = 4;
  const rows = Math.ceil(words.length / cols);
  for (let r = 0; r < rows; r++) {
    const line = [];
    for (let c = 0; c < cols; c++) {
      const i = c * rows + r;
      if (i < words.length) line.push(`${String(i + 1).padStart(2)}. ${words[i].padEnd(10)}`);
    }
    console.log(`    ${line.join("  ")}`);
  }
}
