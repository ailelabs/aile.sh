/**
 * Where self-hosting downloads come from, and the one rule every URL obeys.
 *
 * These are the user's OWN downloads, made by a command they typed. They are
 * not relay traffic and do not pass through the egress allowlist, which governs
 * what the NODE may dial for the server. Nothing the server sends can reach
 * the code that uses these (`test/local-isolation.test.js` proves it).
 *
 * The base URLs are overridable so tests can point them at a local stub. The
 * override is held to the same rule as the default: https, or http only to
 * this machine.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const trim = (s) => String(s).replace(/\/+$/, "");

/** Hugging Face: the model-file API and `resolve` downloads. */
export const hfBase = () => trim(process.env.AILE_HF_URL || "https://huggingface.co");

/** llama.cpp release assets: `<base>/<tag>/<file>`. */
export const llamacppBase = () => trim(process.env.AILE_LLAMACPP_URL || "https://github.com/ggml-org/llama.cpp/releases/download");

/** Ollama's install script (Linux), shown to the user before it runs. */
export const OLLAMA_INSTALL_SCRIPT = "https://ollama.com/install.sh";
export const OLLAMA_DOWNLOAD_PAGE = "https://ollama.com/download";

export class DownloadUrlError extends Error {
  constructor(message) { super(message); this.name = "DownloadUrlError"; }
}

/**
 * Refuse anything but https, or plain http to this machine. Applied to the
 * first URL and to every redirect hop, so a redirect cannot downgrade a
 * download to clear text on the network.
 */
export function assertDownloadUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new DownloadUrlError(`not a URL: ${raw}`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url;
  throw new DownloadUrlError(`refusing to download over ${url.protocol}//${url.host} (https only)`);
}
