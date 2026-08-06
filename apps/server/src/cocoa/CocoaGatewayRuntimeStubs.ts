import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as ProcessDiagnostics from "../diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "../diagnostics/ProcessResourceMonitor.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";

export const CocoaExternalLauncherLayerLive = Layer.succeed(
  ExternalLauncher.ExternalLauncher,
  ExternalLauncher.ExternalLauncher.of({
    resolveAvailableEditors: () => Effect.succeed([]),
    launchBrowser: (target) =>
      Effect.fail(
        new ExternalLauncher.ExternalLauncherBrowserSpawnError({
          target,
          command: "",
          args: [],
          cause: new Error("Cocoa gateway does not launch local applications."),
        }),
      ),
    launchEditor: (input) =>
      Effect.fail(
        new ExternalLauncher.ExternalLauncherUnsupportedEditorError({ editor: input.editor }),
      ),
  }),
);

export const CocoaUnavailableDiagnosticsLayerLive = Layer.unwrap(
  DateTime.now.pipe(
    Effect.map((readAt) => {
      const aggregate = {
        processCount: 0,
        currentCpuPercent: 0,
        cpuTimeMs: 0,
        currentRssBytes: 0,
        peakRssBytes: 0,
        ioReadBytes: 0,
        ioWriteBytes: 0,
        ioReadBytesPerSecond: 0,
        ioWriteBytesPerSecond: 0,
        processStarts: 0,
        processExits: 0,
      } as const;
      const health = {
        native: {
          status: "unavailable" as const,
          lastSampleAt: Option.none(),
          lastError: Option.some("Local process diagnostics are unavailable in Cocoa gateway."),
        },
        desktop: {
          status: "unavailable" as const,
          lastSampleAt: Option.none(),
          lastError: Option.some("Desktop telemetry is unavailable in Cocoa gateway."),
        },
        sidecarVersion: Option.none(),
        sidecarPid: Option.none(),
        restartCount: 0,
        collectionDurationMicros: 0,
        scannedProcessCount: 0,
        retainedProcessCount: 0,
        inaccessibleProcessCount: 0,
      } as const;
      const snapshot = {
        readAt,
        sampleIntervalMs: 0,
        processes: [],
        groups: { backend: aggregate, electron: aggregate, monitor: aggregate, allT3: aggregate },
        power: HostPowerMonitor.makeUnknownSnapshot("unknown", readAt),
        speedLimitPercent: Option.none(),
        attribution: { readAt, entries: [] },
        health,
      } as const;
      const changes = Stream.empty;
      const telemetry = ResourceTelemetry.ResourceTelemetry.of({
        latest: Effect.succeed(snapshot),
        changes,
        subscribe: Effect.succeed({ latest: snapshot, changes }),
        readHistory: (input) =>
          Effect.succeed({
            readAt,
            windowMs: input.windowMs,
            bucketMs: input.bucketMs,
            sampleIntervalMs: 0,
            retainedSampleCount: 0,
            buckets: [],
            topProcesses: [],
            health,
            legacyBackendBuckets: [],
          }),
        refresh: Effect.succeed(snapshot),
        validateProcessIdentity: () => Effect.succeed(false),
        retry: Effect.succeed({ accepted: false, snapshot }),
      });
      const processDiagnostics = ProcessDiagnostics.ProcessDiagnostics.of({
        read: Effect.succeed({
          serverPid: process.pid,
          readAt,
          processCount: 0,
          totalRssBytes: 0,
          totalCpuPercent: 0,
          processes: [],
          error: Option.some({ message: "Local process diagnostics are unavailable." }),
        }),
        signal: (input) =>
          Effect.succeed({
            pid: input.pid,
            signal: input.signal,
            signaled: false,
            message: Option.some("Cocoa gateway does not signal local processes."),
          }),
      });
      const processResourceMonitor = ProcessResourceMonitor.ProcessResourceMonitor.of({
        readHistory: (input) =>
          Effect.succeed({
            readAt,
            windowMs: input.windowMs,
            bucketMs: input.bucketMs,
            sampleIntervalMs: 0,
            retainedSampleCount: 0,
            totalCpuSecondsApprox: 0,
            buckets: [],
            topProcesses: [],
            error: Option.some({
              failureTag: "ProcessDiagnosticsQueryFailedError" as const,
              message: "Local process diagnostics are unavailable.",
            }),
          }),
      });
      return Layer.mergeAll(
        Layer.succeed(ResourceTelemetry.ResourceTelemetry, telemetry),
        Layer.succeed(ProcessDiagnostics.ProcessDiagnostics, processDiagnostics),
        Layer.succeed(ProcessResourceMonitor.ProcessResourceMonitor, processResourceMonitor),
      );
    }),
  ),
);
