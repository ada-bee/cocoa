import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "./DesktopAppSettings.ts";

function makeLayer(baseDir: string, version = "1.2.3") {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: version,
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  return DesktopAppSettings.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("DesktopAppSettings", () => {
  it("keeps only thin-shell window and update preferences", () => {
    assert.deepEqual(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, {
      mainWindowBounds: null,
      mainWindowMaximized: false,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
    });
    assert.deepEqual(
      DesktopAppSettings.normalizeMainWindowBounds({ x: 10, y: 20, width: 900, height: 700 }),
      { x: 10, y: 20, width: 900, height: 700 },
    );
    assert.isNull(
      DesktopAppSettings.normalizeMainWindowBounds({ x: 10, y: 20, width: 100, height: 100 }),
    );
  });

  it.effect("persists bounds and explicit update channel without legacy runtime settings", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "cocoa-desktop-settings-test-",
      });
      const layer = makeLayer(baseDir);

      yield* Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.load;
        const bounds = yield* settings.setMainWindowBounds(
          { x: 40, y: 60, width: 1200, height: 800 },
          true,
        );
        assert.isTrue(bounds.changed);
        const channel = yield* settings.setUpdateChannel("nightly");
        assert.isTrue(channel.changed);
        const raw = yield* fileSystem.readFileString(`${baseDir}/userdata/desktop-settings.json`);
        assert.include(raw, '"updateChannel":"nightly"');
        assert.include(raw, '"mainWindowMaximized":true');
        assert.notInclude(raw, "wsl");
        assert.notInclude(raw, "tailscale");
        assert.notInclude(raw, "serverExposure");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("loads valid preferences and ignores retired legacy fields", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "cocoa-desktop-settings-test-",
      });
      yield* fileSystem.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      yield* fileSystem.writeFileString(
        `${baseDir}/userdata/desktop-settings.json`,
        '{"updateChannel":"nightly","updateChannelConfiguredByUser":true,"serverExposureMode":"network-accessible","tailscaleServeEnabled":true,"wslBackendEnabled":true}',
      );
      const loaded = yield* DesktopAppSettings.DesktopAppSettings.pipe(
        Effect.flatMap((settings) => settings.load),
        Effect.provide(makeLayer(baseDir)),
      );
      assert.deepEqual(loaded, {
        mainWindowBounds: null,
        mainWindowMaximized: false,
        updateChannel: "nightly",
        updateChannelConfiguredByUser: true,
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
