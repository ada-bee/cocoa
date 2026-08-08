import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  resolveServerBackedAppDisplayName,
  resolveServerBackedAppStageLabel,
  resolveSidebarV2Default,
  resolveSidebarV2Enabled,
} from "./branding.logic";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("branding", () => {
  it("uses injected desktop branding when available", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getAppBranding: () => ({
            baseName: "Cocoa Code",
            stageLabel: "Nightly",
            displayName: "Cocoa Code (Nightly)",
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_BASE_NAME).toBe("Cocoa Code");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("Cocoa Code (Nightly)");
    expect(branding.APP_DOCUMENT_TITLE).toBe("Cocoa");
  });
});

describe("branding logic", () => {
  it("returns Nightly for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "0.0.28-nightly.20260616.12",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Nightly");
  });

  it("updates the display name for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "Cocoa Code",
        fallbackDisplayName: "Cocoa Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616.12",
      }),
    ).toBe("Cocoa Code (Nightly)");
  });

  it("keeps the fallback display name for stable primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "Cocoa Code",
        fallbackDisplayName: "Cocoa Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.27",
      }),
    ).toBe("Cocoa Code (Alpha)");
  });

  it("keeps the fallback display name for malformed nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "Cocoa Code",
        fallbackDisplayName: "Cocoa Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616",
      }),
    ).toBe("Cocoa Code (Alpha)");
  });
});

describe("resolveSidebarV2Default", () => {
  it.each(["Nightly", "Dev", "nightly", " dev "])("enables the beta for %s builds", (stage) => {
    expect(resolveSidebarV2Default(stage)).toBe(true);
  });

  it.each(["Alpha", "Latest", ""])("leaves the beta off for %s builds", (stage) => {
    expect(resolveSidebarV2Default(stage)).toBe(false);
  });
});

describe("resolveSidebarV2Enabled", () => {
  const hydrated = { settingsHydrated: true } as const;

  it.each(["Alpha", "Latest"])(
    "keeps a legacy opt-in on %s builds even without the companion flag",
    (stageLabel) => {
      // `true` was never the schema default, so it can only be an explicit
      // opt-in from settings written before `sidebarV2ConfiguredByUser` existed.
      expect(
        resolveSidebarV2Enabled({
          ...hydrated,
          enabled: true,
          configuredByUser: false,
          stageLabel,
        }),
      ).toBe(true);
    },
  );

  it("applies the stage default when the beta was never enabled or configured", () => {
    expect(
      resolveSidebarV2Enabled({
        ...hydrated,
        enabled: false,
        configuredByUser: false,
        stageLabel: "Nightly",
      }),
    ).toBe(true);
    expect(
      resolveSidebarV2Enabled({
        ...hydrated,
        enabled: false,
        configuredByUser: false,
        stageLabel: "Latest",
      }),
    ).toBe(false);
  });

  it("honors an explicit opt-out over the stage default", () => {
    expect(
      resolveSidebarV2Enabled({
        ...hydrated,
        enabled: false,
        configuredByUser: true,
        stageLabel: "Nightly",
      }),
    ).toBe(false);
  });

  it("holds v1 until settings hydrate so the sidebar does not remount", () => {
    expect(
      resolveSidebarV2Enabled({
        enabled: true,
        configuredByUser: true,
        settingsHydrated: false,
        stageLabel: "Nightly",
      }),
    ).toBe(false);
  });
});
