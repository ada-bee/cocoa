import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import { HostPowerMonitor, make } from "./HostPowerMonitorCore.ts";

export { HostPowerMonitor, make, makeUnknownSnapshot } from "./HostPowerMonitorCore.ts";

export const layer = Layer.effect(
  HostPowerMonitor,
  Effect.gen(function* () {
    const desktopTelemetry = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
    const desktopSubscription = yield* desktopTelemetry.subscribe;
    const initial = desktopSubscription.latest;
    const monitor = yield* Option.match(initial, {
      onNone: () => make(),
      onSome: (snapshot) => make(snapshot.power),
    });
    yield* desktopSubscription.changes.pipe(
      Stream.map((snapshot) => snapshot.power),
      Stream.runForEach(monitor.report),
      Effect.forkScoped,
    );
    return monitor;
  }),
);
