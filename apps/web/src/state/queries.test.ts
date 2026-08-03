import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { areProjectPathSearchTargetsEqual } from "./queries";

describe("areProjectPathSearchTargetsEqual", () => {
  const target = {
    environmentId: EnvironmentId.make("environment-a"),
    target: {
      projectId: ProjectId.make("project-a"),
      threadId: ThreadId.make("thread-a"),
    },
    query: "index",
  };

  it("requires the environment, workspace, query, and entry kind to match", () => {
    expect(areProjectPathSearchTargetsEqual(target, target)).toBe(true);
    expect(
      areProjectPathSearchTargetsEqual(target, {
        ...target,
        environmentId: EnvironmentId.make("environment-b"),
      }),
    ).toBe(false);
    expect(
      areProjectPathSearchTargetsEqual(target, {
        ...target,
        target: { ...target.target, projectId: ProjectId.make("project-b") },
      }),
    ).toBe(false);
    expect(
      areProjectPathSearchTargetsEqual(target, {
        ...target,
        target: { ...target.target, threadId: ThreadId.make("thread-b") },
      }),
    ).toBe(false);
    expect(areProjectPathSearchTargetsEqual(target, { ...target, query: "readme" })).toBe(false);
    expect(areProjectPathSearchTargetsEqual(target, { ...target, kind: "file" })).toBe(false);
  });
});
