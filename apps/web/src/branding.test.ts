import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  resolveServerBackedAppDisplayName,
  resolveServerBackedAppStageLabel,
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
