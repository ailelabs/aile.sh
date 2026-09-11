/**
 * Level-filtered logger for the node.
 *
 * SECURITY: nothing here ever receives a stream payload, and nothing may start
 * to. The bytes this node carries are TLS ciphertext it holds no keys for —
 * that is the property the whole design rests on. A "debug" level that dumped
 * frame contents would still be blind in practice, but it would put buyer
 * traffic through a code path whose only job is to write things down, on a
 * machine the renter owns. Log stream *metadata* (ids, counts, sizes) if you
 * need to; never the bytes.
 */

const ORDER = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const noop = () => {};

export function logger(level = "info", sink = console) {
  const threshold = ORDER[level] ?? ORDER.info;
  const at = (want) => (threshold >= ORDER[want] ? (...a) => sink.log(...a) : noop);
  return {
    level,
    error: threshold >= ORDER.error ? (...a) => sink.error(...a) : noop,
    warn: at("warn"),
    log: at("info"),
    info: at("info"),
    debug: at("debug"),
  };
}

export { ORDER as LOG_LEVELS };
