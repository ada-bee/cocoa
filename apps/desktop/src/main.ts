// @effect-diagnostics anyUnknownInErrorContext:off - Cocoa's compatibility desktop layer still composes legacy service contexts.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
  });
}

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Electron from "electron";

import * as DesktopApp from "./app/DesktopApp.ts";
import * as DesktopAppIdentity from "./app/DesktopAppIdentity.ts";
import * as DesktopAssets from "./app/DesktopAssets.ts";
import * as DesktopConnectionCatalogStore from "./app/DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "./app/DesktopLifecycle.ts";
import * as DesktopPreReadyPlatform from "./app/DesktopPreReadyPlatform.ts";
import * as DesktopObservability from "./app/DesktopClientObservability.ts";
import * as DesktopShutdown from "./app/DesktopShutdown.ts";
import * as DesktopState from "./app/DesktopState.ts";
import * as ElectronApp from "./electron/ElectronApp.ts";
import * as ElectronDialog from "./electron/ElectronDialog.ts";
import * as ElectronMenu from "./electron/ElectronMenu.ts";
import * as ElectronPowerMonitor from "./electron/ElectronPowerMonitor.ts";
import * as ElectronProtocol from "./electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "./electron/ElectronSafeStorage.ts";
import * as ElectronShell from "./electron/ElectronShell.ts";
import * as ElectronTheme from "./electron/ElectronTheme.ts";
import * as ElectronUpdater from "./electron/ElectronUpdater.ts";
import * as ElectronWindow from "./electron/ElectronWindow.ts";
import * as DesktopIpc from "./ipc/DesktopIpc.ts";
import * as BrowserSession from "./preview/BrowserSession.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as DesktopAppSettings from "./settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "./settings/DesktopClientSettings.ts";
import * as DesktopUpdates from "./updates/DesktopUpdates.ts";
import * as DesktopApplicationMenu from "./window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "./window/DesktopWindow.ts";

const desktopEnvironmentLayer = Layer.unwrap(
  Effect.gen(function* () {
    const metadata = yield* Effect.service(ElectronApp.ElectronApp).pipe(
      Effect.flatMap((app) => app.metadata),
    );
    const platform = yield* HostProcessPlatform;
    const processArch = yield* HostProcessArchitecture;
    return DesktopEnvironment.layer({
      dirname: __dirname,
      homeDirectory: NodeOS.homedir(),
      platform,
      processArch,
      ...metadata,
    });
  }),
);

const electronLayer = Layer.mergeAll(
  ElectronApp.layer,
  ElectronDialog.layer,
  ElectronMenu.layer,
  ElectronPowerMonitor.layer,
  ElectronProtocol.layer,
  ElectronSafeStorage.layer,
  ElectronShell.layer,
  ElectronTheme.layer,
  ElectronUpdater.layer,
  ElectronWindow.layer,
  DesktopIpc.layer(Electron.ipcMain),
);

const desktopFoundationLayer = Layer.mergeAll(
  DesktopState.layer,
  DesktopShutdown.layer,
  DesktopAppSettings.layer,
  DesktopClientSettings.layer,
  DesktopConnectionCatalogStore.layer,
  DesktopAssets.layer,
  DesktopObservability.layer,
).pipe(Layer.provideMerge(desktopEnvironmentLayer));

const desktopPreviewLayer = PreviewManager.layer.pipe(
  Layer.provideMerge(BrowserSession.layer),
  Layer.provideMerge(desktopFoundationLayer),
  Layer.provideMerge(electronLayer),
);

const desktopWindowLayer = DesktopWindow.layer.pipe(
  Layer.provideMerge(desktopPreviewLayer),
  Layer.provideMerge(desktopFoundationLayer),
  Layer.provideMerge(electronLayer),
);

const desktopUpdatesLayer = DesktopUpdates.layer.pipe(
  Layer.provideMerge(desktopFoundationLayer),
  Layer.provideMerge(electronLayer),
);

const desktopIdentityLayer = DesktopAppIdentity.layer.pipe(
  Layer.provideMerge(desktopFoundationLayer),
  Layer.provideMerge(electronLayer),
);

const desktopApplicationLayer = Layer.mergeAll(
  DesktopLifecycle.layer,
  DesktopApplicationMenu.layer,
).pipe(
  Layer.provideMerge(desktopWindowLayer),
  Layer.provideMerge(desktopUpdatesLayer),
  Layer.provideMerge(desktopIdentityLayer),
  Layer.provideMerge(desktopFoundationLayer),
  Layer.provideMerge(electronLayer),
);

const desktopRuntimeLayer = desktopApplicationLayer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(DesktopPreReadyPlatform.layer),
);

DesktopApp.program.pipe(Effect.provide(desktopRuntimeLayer), NodeRuntime.runMain);
