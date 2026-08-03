import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({
  session: {
    fromPartition: vi.fn(() => ({
      getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 cocoa/1.2.3"),
      setPermissionRequestHandler: vi.fn(),
      setUserAgent: vi.fn(),
    })),
  },
  screen: { getAllDisplays: vi.fn(() => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]) },
}));

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { MENU_ACTION_CHANNEL } from "../ipc/channels.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

function makeFakeBrowserWindow() {
  const windowListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const webContentsListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const send = vi.fn();
  const loadURL = vi.fn(() => Promise.resolve());
  const webContents = {
    copyImageAt: vi.fn(),
    getURL: vi.fn(() => "t3code-dev://app/"),
    isLoadingMainFrame: vi.fn(() => false),
    on: vi.fn((name: string, listener: (...args: readonly unknown[]) => void) => {
      webContentsListeners.set(name, listener);
    }),
    once: vi.fn(),
    openDevTools: vi.fn(),
    replaceMisspelling: vi.fn(),
    send,
    setWindowOpenHandler: vi.fn(),
  };
  const window = {
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1100, height: 780 })),
    getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1100, height: 780 })),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    loadURL,
    maximize: vi.fn(),
    on: vi.fn((name: string, listener: (...args: readonly unknown[]) => void) => {
      windowListeners.set(name, listener);
    }),
    once: vi.fn((name: string, listener: (...args: readonly unknown[]) => void) => {
      windowListeners.set(name, listener);
    }),
    setAutoHideCursor: vi.fn(),
    setBackgroundColor: vi.fn(),
    setTitle: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    webContents,
  } as unknown as Electron.BrowserWindow;
  return { window, loadURL, send, webContentsListeners };
}

const environmentLayer = DesktopEnvironment.layer({
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      DesktopConfig.layerTest({ VITE_DEV_SERVER_URL: "http://127.0.0.1:5733" }),
    ),
  ),
);

function makeLayer(input: {
  readonly window: Electron.BrowserWindow;
  readonly createCount: Ref.Ref<number>;
  readonly mainWindow: Ref.Ref<Option.Option<Electron.BrowserWindow>>;
  readonly revealed: Ref.Ref<number>;
}) {
  const nativeWindowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Ref.update(input.createCount, (count) => count + 1).pipe(Effect.as(input.window)),
    main: Ref.get(input.mainWindow),
    currentMainOrFirst: Ref.get(input.mainWindow),
    focusedMainOrFirst: Ref.get(input.mainWindow),
    setMain: (window) => Ref.set(input.mainWindow, Option.some(window)),
    clearMain: () => Ref.set(input.mainWindow, Option.none()),
    reveal: () => Ref.update(input.revealed, (count) => count + 1),
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  return DesktopWindow.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        environmentLayer,
        DesktopAppSettings.layerTest(),
        Layer.succeed(DesktopAssets.DesktopAssets, {
          iconPaths: Effect.succeed({
            ico: Option.none<string>(),
            icns: Option.none<string>(),
            png: Option.none<string>(),
          }),
          resolveResourcePath: () => Effect.succeed(Option.none<string>()),
        }),
        Layer.succeed(ElectronMenu.ElectronMenu, {
          setApplicationMenu: () => Effect.void,
          popupTemplate: () => Effect.void,
          showContextMenu: () => Effect.succeed(Option.none()),
        }),
        Layer.succeed(ElectronShell.ElectronShell, {
          openExternal: () => Effect.succeed(true),
          copyText: () => Effect.void,
        }),
        Layer.succeed(ElectronTheme.ElectronTheme, {
          shouldUseDarkColors: Effect.succeed(false),
          setSource: () => Effect.void,
          onUpdated: () => Effect.void,
        }),
        nativeWindowLayer,
        Layer.mock(PreviewManager.PreviewManager)({
          getBrowserSession: () => Effect.succeed({} as Electron.Session),
          setMainWindow: () => Effect.void,
          isBrowserPartition: () => true,
        }),
      ),
    ),
  );
}

describe("DesktopWindow", () => {
  it("contains navigation in the stable renderer origin", () => {
    assert.isTrue(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "t3code://app/",
        navigationUrl: "t3code://app/settings/connections",
      }),
    );
    assert.isFalse(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "t3code://app/",
        navigationUrl: "https://example.test/",
      }),
    );
  });

  it("restores bounds only when they fit a connected display", () => {
    const bounds = { x: 100, y: 80, width: 1320, height: 880 };
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(bounds, [
        { x: 0, y: 0, width: 1920, height: 1080 },
      ]),
      bounds,
    );
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(bounds, [
        { x: 1500, y: 0, width: 400, height: 300 },
      ]),
      DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE,
    );
  });

  it.effect("opens immediately and reuses the main window without backend readiness", () =>
    Effect.gen(function* () {
      const fake = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const revealed = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeLayer({ window: fake.window, createCount, mainWindow, revealed });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.activate;
        yield* desktopWindow.activate;
        assert.equal(yield* Ref.get(createCount), 1);
        assert.equal(yield* Ref.get(revealed), 2);
        assert.deepEqual(fake.loadURL.mock.calls[0], ["t3code-dev://app/"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("creates a window before dispatching a native menu action", () =>
    Effect.gen(function* () {
      const fake = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const revealed = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeLayer({ window: fake.window, createCount, mainWindow, revealed });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.dispatchMenuAction("open-settings");
        assert.equal(yield* Ref.get(createCount), 1);
        assert.deepEqual(fake.send.mock.calls, [[MENU_ACTION_CHANNEL, "open-settings"]]);
      }).pipe(Effect.provide(layer));
    }),
  );
});
