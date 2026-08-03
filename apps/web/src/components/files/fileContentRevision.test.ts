import { describe, expect, it } from "vite-plus/test";

import {
  fileContentRevision,
  projectFileCacheKey,
  projectFileEditorCacheKey,
} from "./fileContentRevision";
import { ProjectId, ThreadId } from "@t3tools/contracts";

const target = {
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
};

describe("fileContentRevision", () => {
  it("changes for same-length edits", () => {
    expect(fileContentRevision("nodeVersion")).not.toBe(fileContentRevision("nodeVeasdrs"));
  });

  it("keeps identical contents stable", () => {
    expect(projectFileCacheKey(target, "file.json", "contents")).toBe(
      projectFileCacheKey(target, "file.json", "contents"),
    );
  });

  it("keeps editor identity stable for locally edited contents", () => {
    const cacheKey = projectFileEditorCacheKey("local", target, "file.json", "after", undefined);

    expect(
      projectFileEditorCacheKey("local", target, "file.json", "after edit", {
        cacheKey,
        contents: "after edit",
      }),
    ).toBe(cacheKey);
  });

  it("rotates editor identity for external contents and environments", () => {
    const cacheKey = projectFileEditorCacheKey("local", target, "file.json", "before", undefined);
    const editorFile = { cacheKey, contents: "before" };

    expect(
      projectFileEditorCacheKey("local", target, "file.json", "external edit", editorFile),
    ).not.toBe(cacheKey);
    expect(projectFileEditorCacheKey("remote", target, "file.json", "before", undefined)).not.toBe(
      cacheKey,
    );
  });
});
