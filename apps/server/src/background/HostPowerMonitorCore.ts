import type { HostPowerSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { HostPowerMonitor, makeUnknownSnapshot } from "./HostPowerMonitorService.ts";

export { HostPowerMonitor, makeUnknownSnapshot } from "./HostPowerMonitorService.ts";

function samePowerState(left: HostPowerSnapshot, right: HostPowerSnapshot): boolean {
  return (
    left.source === right.source &&
    left.idle === right.idle &&
    left.locked === right.locked &&
    left.suspended === right.suspended &&
    left.onBattery === right.onBattery &&
    left.lowPowerMode === right.lowPowerMode &&
    left.thermalState === right.thermalState &&
    left.stale === right.stale
  );
}

export const make = Effect.fn("background.hostPower.make")(function* (
  initialSnapshot?: HostPowerSnapshot,
) {
  const initial = initialSnapshot ?? makeUnknownSnapshot("unknown", yield* DateTime.now);
  const latestRef = yield* Ref.make(initial);
  const changes = yield* PubSub.sliding<HostPowerSnapshot>(1);

  const report: HostPowerMonitor["Service"]["report"] = (snapshot) =>
    Ref.modify(latestRef, (current) => {
      if (DateTime.isLessThan(snapshot.updatedAt, current.updatedAt)) {
        return [Option.none<HostPowerSnapshot>(), current] as const;
      }
      return [
        samePowerState(current, snapshot) ? Option.none() : Option.some(snapshot),
        snapshot,
      ] as const;
    }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (next) => PubSub.publish(changes, next),
        }),
      ),
      Effect.asVoid,
    );

  return HostPowerMonitor.of({
    snapshot: Ref.get(latestRef),
    report,
    streamChanges: Stream.fromPubSub(changes),
  });
});
