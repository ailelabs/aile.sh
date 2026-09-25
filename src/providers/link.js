/**
 * Connect a provider account to the signed-in aile.sh account.
 *
 * Sequence, and why it is this order:
 *
 *   1. Ask the server for a nonce. The SERVER picks it, so the resulting proof
 *      binds this authorization to this renter — a stolen id_token minted for
 *      some other nonce fails.
 *   2. Run the provider's OAuth flow locally, carrying that nonce.
 *   3. Upload the tokens. The server verifies the id_token against the
 *      provider's JWKS and encrypts the credential at rest.
 *
 * Provider tokens are NEVER written to disk on this machine. They exist in
 * memory for the seconds between the exchange and the upload, and that is all.
 * The server has to hold them anyway (it terminates TLS with the provider), so
 * a local copy would be a second place to steal them from and buy nothing.
 */

import { api } from "../api/client.js";
import { loadConfig } from "../relay/config.js";
import { linkProvider } from "./flows.js";
import { getProvider, isApiKeyProvider } from "./index.js";
import { probeCredential } from "./probe.js";

/**
 * Build the command that hands a URL to the desktop's browser.
 *
 * WINDOWS IS NOT LIKE THE OTHERS, AND GETTING IT WRONG IS SILENT.
 *
 * `cmd.exe` re-parses its own command line and treats `&` as a COMMAND
 * SEPARATOR. An authorize URL is a query string full of them, so
 * `cmd /c start "" <url>` delivers everything up to the first `&` and tries to
 * execute the rest as programs. What the browser opens is:
 *
 *     https://claude.ai/oauth/authorize?response_type=code
 *
 * — and the provider, seeing a request with no `client_id`, renders "Invalid
 * OAuth Request / Missing client_id parameter". That error names a parameter
 * that WAS built correctly and WAS printed correctly to the terminal, which is
 * what makes the bug so expensive: every visible artefact says the URL is fine,
 * because it is. Only the handoff to the OS drops it. Quoting the URL is not a
 * fix either — `&` is special to cmd inside double quotes too.
 *
 * So Windows goes through PowerShell's `Start-Process` with the whole command
 * base64-encoded (`-EncodedCommand` takes UTF-16LE). Encoding means no shell
 * metacharacter in the URL can be re-interpreted on the way, which is the same
 * reason the `open` package does exactly this on win32. macOS and Linux pass the
 * URL as a single argv entry to `open`/`xdg-open` — no shell is involved there,
 * so no escaping question arises.
 *
 * Split out from the spawn so a test can assert on the command WITHOUT opening a
 * browser on the machine running it, and can check all three platforms from any
 * one of them. `platform` is a parameter for the same reason.
 */
export function browserOpenCommand(url, platform = process.platform) {
  if (platform === "win32") {
    // Single-quoted for PowerShell, with `'` doubled — the only escape its
    // literal strings need, and the reason no other character here matters.
    const script = `Start-Process '${String(url).replace(/'/g, "''")}'`;
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",           // a user's profile can print banners or fail outright
        "-NonInteractive",
        "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
      ],
    };
  }
  return { cmd: platform === "darwin" ? "open" : "xdg-open", args: [String(url)] };
}

/** Lazily resolved so the CLI works headless where no opener exists. */
async function defaultOpenBrowser(url) {
  const { spawn } = await import("node:child_process");
  const { cmd, args } = browserOpenCommand(url);
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    // A missing opener (no xdg-open on a server or in a container) arrives as an
    // 'error' EVENT, not a throw, and an unheard one crashes the process — so
    // `aile login` died on exactly the headless machines it prints a URL for.
    child.on("error", () => { /* headless — the URL was printed, which is enough */ });
    child.unref();
  } catch { /* headless — the URL was printed, which is enough */ }
}

export async function connectProvider(providerId, {
  serverUrl = loadConfig().serverUrl,
  renterToken = loadConfig().renterToken,
  insecure = false,
  log = console.log,
  openBrowser = defaultOpenBrowser,
  // A lender's own name for this account, and the key that tells two accounts
  // of one provider apart when the provider gives us nothing better. An
  // attested `subject` always outranks the key server-side, so passing one can
  // never overwrite a verified account.
  label = null,
  accountKey = null,
  // Set for key-based providers, where the caller collected the key from a
  // terminal before getting here. Unused by every OAuth flow.
  apiKey = null,
  // Whether this account may serve with no node in the path, and which existing
  // account this link replaces. Both were accepted by the server from the start
  // and never sent by this client — so a key linked here could not be opted into
  // nodeless serving at all, while the same key linked in a browser could.
  // `null` means "say nothing", which is not the same as `false`.
  allowNodeless = null,
  replaceAccountId = null,
  // Injected the same way `openBrowser` is, so a test can drive the sequence
  // without standing up a provider. The default is the real flow runner.
  runFlow = linkProvider,
  // Injected for the same reason. A test that wants the old behaviour passes
  // `probe: null` rather than having to stand up an endpoint to be asked.
  probe = probeCredential,
} = {}) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  // "Not set up" rather than "not signed in": what is missing is a token, and a
  // machine contributing anonymously holds one without being signed in to
  // anything. Naming only `login` would make that machine look unable to link.
  if (!renterToken) throw new Error("This machine is not set up - run `aile login` or `aile donate` first");

  const opts = { serverUrl, token: renterToken, insecure };

  const { nonce, attestable } = await api.providerNonce({ provider: providerId, ...opts });
  if (!attestable) {
    log(`Note: ${provider.name} publishes no verification keys, so this account`);
    log(`      is recorded as an unverified claim.`);
  }

  const { suggestedLabel = null, probed = null, ...tokens } = await runFlow(providerId, {
    openBrowser,
    log,
    // The nonce reaches the provider ONLY where the server can check what comes
    // back. `attestable` is the server's own answer about its JWKS table, so
    // this cannot drift from it the way a second copy of that list here would.
    // Sending one anywhere else asks the lender's provider to carry a value
    // nothing will ever verify — and for the endpoints that reject parameters
    // they do not recognise, it costs the sign-in outright.
    nonce: attestable ? nonce : null,
    apiKey,
  });

  // Ask the provider whether the credential actually works, BEFORE uploading it.
  // Not a gate: unlike a pasted key, an OAuth token came from a completed
  // sign-in, so a probe that says no is more often a fussy endpoint than a bad
  // credential — see providers/probe.js. What it buys is the difference between
  // "we ran a flow" and "the provider accepted this", which is the difference
  // between advertised capacity and capacity that 401s on the first buyer.
  //
  // A flow that already asked reports it as `probed`, and is believed rather
  // than asked again: runApiKeyFlow fetches the very same `verifyUrl` this would
  // and refuses to return at all unless it passed. Re-probing would send a
  // second identical request to learn a fact already in hand.
  let probeResult = probed;
  if (probe && !probeResult) {
    probeResult = await probe(provider, tokens, { isApiKey: isApiKeyProvider(providerId) });
    if (probeResult.reason === "rejected") {
      log(`Note: ${provider.name} did not accept the credential this sign-in produced.`);
      log(`      Saving it anyway — but it may not serve requests.`);
    }
  }

  log(`Saving ${provider.name} to your account…`);
  const res = await api.saveProvider({
    provider: providerId,
    // `suggestedLabel` is split off above rather than passed through: the whole
    // of `tokens` goes into the encrypted credential blob, and a display hint
    // has no business inside custody.
    tokens,
    nonce,
    email: tokens.email || null,
    // A SEPARATE FIELD FROM `attested`, AND IT MUST STAY SEPARATE. This says the
    // provider accepted the credential once, from the lender's own machine.
    // `attested` says the provider SIGNED a statement about whose account it is,
    // which only the server can conclude and only from a verified id_token.
    // Merging them would let any client mint the stronger claim by asserting the
    // weaker one — the exact promotion relay/attest.js forbids. The server should
    // treat this as a claim and is free to re-run the same check itself, where
    // the result would be trustworthy because the server observed it.
    probe: probeResult ? { ok: probeResult.ok, reason: probeResult.reason } : null,
    // A key-based provider may report the key's own name at the provider. It is
    // a better default than nothing, and the lender's own --label still wins:
    // they named it deliberately, the provider named it incidentally.
    label: label || suggestedLabel || null,
    accountKey,
    allowNodeless,
    replaceAccountId,
    ...opts,
  });

  // `added` distinguishes a second account from a re-link of the first. The CLI
  // says which happened, because "Connected" over a silently replaced
  // credential is how a lender ends up wondering where their other account went.
  //
  // `probe_ok` is spread AFTER the server's account, so a server that has begun
  // returning its own — checked server-side, where it is worth something — wins
  // over what this machine observed. Until then it is what the CLI has to show.
  return {
    ...res.account,
    probe_ok: res.account?.probe_ok ?? (probeResult?.ok ? 1 : 0),
    added: res.added !== false,
    total: res.total ?? null,
    // Carried out so `aile connect` can say how many slots are left instead of
    // letting the lender discover the ceiling as a 400 on their next paste.
    maxPerProvider: res.maxAccountsPerProvider ?? null,
    // `total` from the server IS the per-provider count, not the grand total.
    providerTotal: res.total ?? null,
  };
}

export { defaultOpenBrowser };
