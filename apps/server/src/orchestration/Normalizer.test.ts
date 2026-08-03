import { describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      providerInstanceId: ProviderInstanceId.make("codex"),
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

describe("normalizeDispatchCommand project paths", () => {
  it("uses lexical normalization for create and meta update without invoking WorkspacePaths", async () => {
    const workspacePathCalls: string[] = [];
    const workspacePaths = WorkspacePaths.WorkspacePaths.of({
      normalizeWorkspaceRoot: (workspaceRoot) =>
        Effect.sync(() => {
          workspacePathCalls.push(workspaceRoot);
          return workspaceRoot;
        }),
      resolveRelativePathWithinRoot: (input) =>
        Effect.succeed({ absolutePath: input.relativePath, relativePath: input.relativePath }),
    });
    const dependencies = Layer.mergeAll(
      Layer.succeed(WorkspacePaths.WorkspacePaths, workspacePaths),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "normalizer-project" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );

    const created = await Effect.runPromise(
      normalizeDispatchCommand({
        type: "project.create",
        providerInstanceId: ProviderInstanceId.make("codex"),
        commandId: CommandId.make("command-project-create"),
        projectId: ProjectId.make("project-create"),
        title: "Remote project",
        workspaceRoot: " /srv/cocoa/ ",
        createWorkspaceRootIfMissing: true,
        createdAt: clientCreatedAt,
      }).pipe(Effect.provide(dependencies)),
    );
    const updated = await Effect.runPromise(
      normalizeDispatchCommand({
        type: "project.meta.update",
        commandId: CommandId.make("command-project-meta"),
        projectId: ProjectId.make("project-create"),
        workspaceRoot: " C:\\Users\\Ada\\Cocoa\\ ",
      }).pipe(Effect.provide(dependencies)),
    );

    expect(created.type).toBe("project.create");
    expect(updated.type).toBe("project.meta.update");
    if (created.type !== "project.create" || updated.type !== "project.meta.update") {
      throw new Error("Expected project commands");
    }
    expect(created.workspaceRoot).toBe("/srv/cocoa");
    expect(created.createWorkspaceRootIfMissing).toBe(true);
    expect(updated.workspaceRoot).toBe("C:\\Users\\Ada\\Cocoa");
    expect(workspacePathCalls).toEqual([]);
  });
});
