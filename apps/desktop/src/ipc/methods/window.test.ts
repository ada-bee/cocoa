import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import type * as Electron from "electron";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { getAppBranding, getWindowFullscreenState, pickFolder } from "./window.ts";

const window = { isFullScreen: () => true } as Electron.BrowserWindow;
const windowLayer = Layer.mock(ElectronWindow.ElectronWindow)({
  currentMainOrFirst: Effect.succeed(Option.some(window)),
  focusedMainOrFirst: Effect.succeed(Option.some(window)),
});
const environmentLayer = DesktopEnvironment.layer({
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: true,
  resourcesPath: "/resources",
  runningUnderArm64Translation: false,
}).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))));

describe("desktop window IPC", () => {
  it.effect("reads native fullscreen state and Cocoa branding", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* getWindowFullscreenState.handler());
      assert.deepInclude(yield* getAppBranding.handler(), {
        baseName: "T3 Code",
        stageLabel: "Alpha",
      });
    }).pipe(Effect.provide(Layer.mergeAll(windowLayer, environmentLayer))),
  );

  it.effect("uses only the host-native folder picker", () => {
    let defaultPath: Option.Option<string> = Option.none();
    const dialogLayer = Layer.mock(ElectronDialog.ElectronDialog)({
      pickFolder: (input) =>
        Effect.sync(() => {
          defaultPath = input.defaultPath;
          return Option.some("/Users/alice/project");
        }),
    });

    return Effect.gen(function* () {
      const selected = yield* pickFolder.handler({ initialPath: "~/project" });
      assert.equal(selected, "/Users/alice/project");
      assert.deepEqual(defaultPath, Option.some("/Users/alice/project"));
    }).pipe(Effect.provide(Layer.mergeAll(windowLayer, dialogLayer, environmentLayer)));
  });
});
