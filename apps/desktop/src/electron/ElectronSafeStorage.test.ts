import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({ safeStorage: {} }));

import { isSafeStorageBackendSecure } from "./ElectronSafeStorage.ts";

describe("ElectronSafeStorage", () => {
  it("rejects Electron's unencrypted Linux basic_text fallback", () => {
    assert.isFalse(
      isSafeStorageBackendSecure({
        platform: "linux",
        encryptionAvailable: true,
        selectedBackend: "basic_text",
      }),
    );
  });

  it("accepts OS-backed storage and rejects unavailable encryption", () => {
    assert.isTrue(
      isSafeStorageBackendSecure({
        platform: "linux",
        encryptionAvailable: true,
        selectedBackend: "gnome_libsecret",
      }),
    );
    assert.isTrue(
      isSafeStorageBackendSecure({
        platform: "darwin",
        encryptionAvailable: true,
        selectedBackend: undefined,
      }),
    );
    assert.isFalse(
      isSafeStorageBackendSecure({
        platform: "win32",
        encryptionAvailable: false,
        selectedBackend: undefined,
      }),
    );
  });
});
