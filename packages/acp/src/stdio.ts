/**
 * The stdio transport for the ACP host.
 *
 * Split out of `agent.ts` (the handler table): this is the one place raw `process.stdin` /
 * `process.stdout` are touched, including the backpressure and EPIPE rules a long-lived child
 * process needs. The ACP app itself stays transport-agnostic (`app.connect(stream)`).
 */

import { ndJsonStream } from "@agentclientprotocol/sdk";

import { createAcpAgent } from "./agent.js";

import type { AcpAgentOptions } from "./agent.js";
import type { AgentConnection } from "@agentclientprotocol/sdk";

/**
 * Serve an ACP agent over stdio. Returns the live connection.
 *
 * The caller (a bin entry) owns process teardown; this only wires the transport.
 */
export function runAcpAgentStdio(options: AcpAgentOptions): AgentConnection {
  const app = createAcpAgent(options);
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer): void => {
        controller.enqueue(new Uint8Array(chunk));
        // Honour backpressure: a client that stops reading must not make this process buffer an
        // unbounded stdin backlog. `pull` resumes when the stream wants more.
        if ((controller.desiredSize ?? 1) <= 0) process.stdin.pause();
      };
      process.stdin.on("data", onData);
      process.stdin.on("end", () => controller.close());
      process.stdin.on("error", (err) => controller.error(err));
    },
    pull() {
      process.stdin.resume();
    },
    cancel() {
      process.stdin.pause();
    },
  });
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve) => {
        if ((process.stdout as unknown as { destroyed?: boolean }).destroyed) return resolve();
        process.stdout.write(chunk, () => resolve());
      });
    },
  });
  // A client that closes its end turns the next write into EPIPE. That is a normal disconnect, not
  // a crash: keep it out of the process-wide uncaught-error path.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") return;
    process.stderr.write(`[codent-acp] stdout error: ${error.message}\n`);
  });
  return app.connect(ndJsonStream(output, input));
}
