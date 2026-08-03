import type { ProjectReadFileResult } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  resolveProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-project-files-query-test");
const target = {
  projectId: ProjectId.make("project-files-query-test"),
  threadId: ThreadId.make("thread-files-query-test"),
};

describe("project files queries", () => {
  afterEach(() => {
    clearProjectFileQueryData(environmentId, target, "convex.json");
    vi.unstubAllGlobals();
  });

  it("keeps the latest optimistic draft when an older write finishes", () => {
    vi.stubGlobal("window", {});
    const initial = {
      relativePath: "convex.json",
      contents: '{"nodeVersion":"20"}',
      byteLength: 20,
      truncated: false,
    } satisfies ProjectReadFileResult;
    setProjectFileQueryData(environmentId, target, "convex.json", '{"nodeVersion":"220"}');
    setProjectFileQueryData(environmentId, target, "convex.json", '{"nodeVersion":"22"}');

    expect(getOptimisticProjectFileQueryData(environmentId, target, "convex.json")?.contents).toBe(
      '{"nodeVersion":"22"}',
    );

    expect(
      confirmProjectFileQueryData(environmentId, target, "convex.json", '{"nodeVersion":"220"}'),
    ).toBe(false);

    expect(resolveProjectFileQueryData(environmentId, target, "convex.json", initial)).toEqual({
      relativePath: "convex.json",
      contents: '{"nodeVersion":"22"}',
      byteLength: 20,
      truncated: false,
    });

    expect(
      confirmProjectFileQueryData(environmentId, target, "convex.json", '{"nodeVersion":"22"}'),
    ).toBe(true);
  });

  it("isolates optimistic file state by project and thread", () => {
    const otherTarget = { ...target, threadId: ThreadId.make("other-thread") };
    setProjectFileQueryData(environmentId, target, "convex.json", "first");
    setProjectFileQueryData(environmentId, otherTarget, "convex.json", "second");

    expect(getOptimisticProjectFileQueryData(environmentId, target, "convex.json")?.contents).toBe(
      "first",
    );
    expect(
      getOptimisticProjectFileQueryData(environmentId, otherTarget, "convex.json")?.contents,
    ).toBe("second");

    clearProjectFileQueryData(environmentId, otherTarget, "convex.json");
  });
});
