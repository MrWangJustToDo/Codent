/**
 * UTF-8 byte length — the one definition.
 *
 * The byte size of a value is needed on three planes that cannot share a call stack: the runtime's
 * `byteLength` capability (`env`), the log sink's rotation budget and payload caps (`agent/log`),
 * and the tools' truncation and envelope maths. Each had spelled
 * `new TextEncoder().encode(x).length` for itself, so the rule had five homes and none to change.
 *
 * `TextEncoder` is a global in every runtime core targets (Node, browsers, workers), so this needs
 * no capability and stays importable from anywhere — including `env`, which is why it lives here
 * rather than beside any one consumer.
 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
