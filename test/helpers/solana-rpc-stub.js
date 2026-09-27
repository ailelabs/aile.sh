/**
 * A Solana JSON-RPC server on loopback, answering exactly the reads the local
 * wallet makes — so a payment can be built and a balance read with no network.
 *
 *   getAccountInfo         the USDC mint (6 decimals, owned by the token program)
 *   getTokenAccountBalance `usdcMicros` in the wallet's USDC account
 *   getBalance             `lamports` of SOL
 *   getLatestBlockhash     a fixed blockhash
 *
 * `methods` records each method called, in order.
 */

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** An initialised SPL mint: 82 bytes, decimals at 44, isInitialized at 45. */
function mintData(decimals = 6) {
  const b = Buffer.alloc(82);
  b[44] = decimals;
  b[45] = 1;
  return b.toString("base64");
}

export function rpcStub({ usdcMicros = 5_000_000, lamports = 1_000_000_000 } = {}) {
  const methods = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json();
      const one = (call) => {
        methods.push(call.method);
        const context = { slot: 1 };
        switch (call.method) {
          case "getAccountInfo":
            return { context, value: { data: [mintData(), "base64"], executable: false, lamports: 1_461_600, owner: TOKEN_PROGRAM, rentEpoch: 0, space: 82 } };
          case "getTokenAccountBalance":
            return { context, value: { amount: String(usdcMicros), decimals: 6, uiAmount: usdcMicros / 1e6, uiAmountString: String(usdcMicros / 1e6) } };
          case "getBalance":
            return { context, value: lamports };
          case "getLatestBlockhash":
            return { context, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 } };
          default:
            return null;
        }
      };
      const answer = (call) => ({ jsonrpc: "2.0", id: call.id, result: one(call) });
      return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    methods,
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}
