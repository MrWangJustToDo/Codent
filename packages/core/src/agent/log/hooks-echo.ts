/**
 * `MY_AGENT_LOG_HOOKS` — one owner for the hook-echo decision.
 *
 * The decision belongs to the log policy (an emitter must not decide "not to record"), but it has to
 * be cheap: emitting the echo for every middleware hook and then dropping it in the handler made a
 * request build tens of payloads and deliver them to every `ctx.events.observeAny` subscriber — even
 * with the flag off, because the event is observable. The emitter therefore ASKS the policy first;
 * the handler keeps the same guard so a programmatic `bus.emit` cannot record one either.
 *
 * `process` is read through `globalThis`: browser hosts have no `process` at all.
 */
export function hookEchoesEnabled(): boolean {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const raw = proc?.env?.MY_AGENT_LOG_HOOKS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
