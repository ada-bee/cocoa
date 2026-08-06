import type { HostPowerSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

// Preserve the established service identity while keeping the tag in a runtime-neutral module.
export class HostPowerMonitor extends Context.Service<
  HostPowerMonitor,
  {
    readonly snapshot: Effect.Effect<HostPowerSnapshot>;
    readonly report: (snapshot: HostPowerSnapshot) => Effect.Effect<void>;
    readonly streamChanges: Stream.Stream<HostPowerSnapshot>;
  }
>()(
  // @effect-diagnostics-next-line deterministicKeys:off
  "t3/background/HostPowerMonitor",
) {}

export const makeUnknownSnapshot = (
  source: HostPowerSnapshot["source"],
  updatedAt: HostPowerSnapshot["updatedAt"],
): HostPowerSnapshot => ({
  source,
  idle: "unknown",
  idleSeconds: null,
  locked: "unknown",
  suspended: false,
  onBattery: "unknown",
  lowPowerMode: "unknown",
  thermalState: "unknown",
  stale: true,
  updatedAt,
});
