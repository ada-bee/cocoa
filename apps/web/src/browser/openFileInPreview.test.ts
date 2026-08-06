import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { openFileInPreview } from "./openFileInPreview";

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  isPreviewSupportedInRuntime: () => true,
  rememberPreviewUrl: vi.fn(),
}));

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ openBrowser: vi.fn() }),
  },
}));

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-08-06T00:00:00.000Z",
};

describe("openFileInPreview", () => {
  it("sends only the workspace-relative path to the gateway", async () => {
    const createAssetUrl = vi.fn(async () =>
      AsyncResult.success({
        relativeUrl: "/api/assets/signed-token/index.html",
        expiresAt: Date.now() + 60_000,
      }),
    );
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    const result = await openFileInPreview({
      threadRef,
      relativePath: "site/index.html",
      httpBaseUrl: "https://cocoa.example.test/",
      createAssetUrl,
      openPreview,
    });

    expect(result._tag).toBe("Success");
    expect(createAssetUrl).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: {
        resource: {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path: "site/index.html",
        },
      },
    });
    expect(openPreview).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        url: "https://cocoa.example.test/api/assets/signed-token/index.html",
      },
    });
  });
});
