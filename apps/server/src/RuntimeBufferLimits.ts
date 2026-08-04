import * as Context from "effect/Context";

/**
 * Production limits for the hot, in-memory hand-off points between provider
 * transports and orchestration. Every value is a power of two because Effect's
 * bounded PubSub implementation is most efficient at those capacities.
 *
 * Producer / consumer and overload policy:
 *
 * - `codexSessionNotifications`: endpoint router -> one Codex session decoder.
 *   The producer must not wait on the endpoint frame reader. Overflow ends the
 *   session and reports a reconciliation gap so a reconnect can recover from
 *   the provider's authoritative thread snapshot.
 * - `codexAdapterEvents`: one Codex session -> adapter stream subscriber.
 *   Backpressure is allowed; the upstream session-notification boundary is the
 *   non-blocking circuit breaker that prevents unbounded transport retention.
 * - `providerRuntimeEvents`: provider adapters -> runtime ingestion reactors.
 *   Delivery is lossless and bounded with backpressure. Provider mutation,
 *   approval, and terminal events are never silently dropped.
 * - `orchestrationCommands`: HTTP/RPC/reactors -> the serialized command worker.
 *   The dropping queue is used only as a non-blocking admission gate: a failed
 *   offer becomes a typed, retryable busy error before the command is accepted.
 * - `orchestrationEvents`: committed event publisher -> internal reactors and
 *   replay-capable client tails. Delivery is lossless and bounded with
 *   backpressure; clients can reconnect and replay persisted events/projections.
 * - `clientLiveEvents`: shared event stream -> one client subscription. Offers
 *   never block internal delivery; overflow terminates the client tail with a
 *   sanitized reset-required error so it can reconnect from a fresh snapshot.
 */
export interface RuntimeBufferLimits {
  readonly codexSessionNotifications: number;
  readonly codexAdapterEvents: number;
  readonly providerRuntimeEvents: number;
  readonly orchestrationCommands: number;
  readonly orchestrationEvents: number;
  readonly clientLiveEvents: number;
}

export const DEFAULT_RUNTIME_BUFFER_LIMITS = {
  codexSessionNotifications: 256,
  codexAdapterEvents: 512,
  providerRuntimeEvents: 1_024,
  orchestrationCommands: 256,
  orchestrationEvents: 1_024,
  clientLiveEvents: 256,
} as const satisfies RuntimeBufferLimits;

export type RuntimeBufferLimitOverrides = Partial<RuntimeBufferLimits>;

export class RuntimeBufferLimitsService extends Context.Service<
  RuntimeBufferLimitsService,
  RuntimeBufferLimits
>()("t3/RuntimeBufferLimits/RuntimeBufferLimitsService") {}

export function resolveRuntimeBufferLimits(
  overrides: RuntimeBufferLimitOverrides | undefined,
): RuntimeBufferLimits {
  return {
    ...DEFAULT_RUNTIME_BUFFER_LIMITS,
    ...overrides,
  };
}
