import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES,
  ThreadId,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  canonicalizeClientCommandTimestamps,
  normalizeDispatchCommand,
  withNormalizedDispatchCommand,
} from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

const imageUpload = (name: string, bytes: Uint8Array): UploadChatAttachment => ({
  type: "image",
  name,
  mimeType: "image/png",
  sizeBytes: bytes.byteLength,
  dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
});

const turnStart = (
  attachments: ReadonlyArray<UploadChatAttachment>,
): ClientOrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make("command-attachments"),
  threadId: ThreadId.make("thread-attachments"),
  message: {
    messageId: MessageId.make("message-attachments"),
    role: "user",
    text: "Inspect these images",
    attachments,
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: clientCreatedAt,
});

const attachmentTestLayer = (prefix: string) =>
  Layer.mergeAll(
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), { prefix }).pipe(Layer.provide(NodeServices.layer)),
  );

const attachmentFileNames = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  return yield* fileSystem.readDirectory(config.attachmentsDir);
});

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

describe("normalizeDispatchCommand attachment policy", () => {
  it.effect("rejects count overflow before persisting any blobs", () =>
    Effect.gen(function* () {
      const attachment = imageUpload("small.png", Uint8Array.of(1));
      yield* normalizeDispatchCommand(
        turnStart(Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 }, () => attachment)),
      ).pipe(Effect.flip);
      expect(yield* attachmentFileNames).toEqual([]);
    }).pipe(Effect.provide(attachmentTestLayer("normalizer-count-overflow"))),
  );

  it.effect("rejects aggregate overflow before persisting any blobs", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(
        Math.ceil((PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES * 3) / 4),
      );
      yield* normalizeDispatchCommand(turnStart([imageUpload("too-large.png", bytes)])).pipe(
        Effect.flip,
      );
      expect(yield* attachmentFileNames).toEqual([]);
    }).pipe(Effect.provide(attachmentTestLayer("normalizer-aggregate-overflow"))),
  );

  it.effect("preflights every payload so a late normalization failure leaves no blobs", () =>
    Effect.gen(function* () {
      const valid = imageUpload("valid.png", Uint8Array.of(1, 2, 3));
      const invalid: UploadChatAttachment = {
        ...valid,
        name: "invalid.png",
        dataUrl: "not-a-data-url",
      };
      yield* normalizeDispatchCommand(turnStart([valid, invalid])).pipe(Effect.flip);
      expect(yield* attachmentFileNames).toEqual([]);
    }).pipe(Effect.provide(attachmentTestLayer("normalizer-late-invalid"))),
  );

  it.effect("persists an exact encoded aggregate boundary without exposing upload data URLs", () =>
    Effect.gen(function* () {
      const first = imageUpload("first.png", new Uint8Array(3 * 1_048_570));
      const second = imageUpload("second.png", new Uint8Array(3 * 1_048_571));
      expect(first.dataUrl.length + second.dataUrl.length).toBe(
        PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES,
      );

      const normalized = yield* normalizeDispatchCommand(turnStart([first, second]));
      expect(normalized.type).toBe("thread.turn.start");
      if (normalized.type !== "thread.turn.start") {
        throw new Error("Expected a turn-start command");
      }
      expect(normalized.message.attachments).toHaveLength(2);
      expect(normalized.message.attachments.every((attachment) => !("dataUrl" in attachment))).toBe(
        true,
      );
      expect(yield* attachmentFileNames).toHaveLength(2);
    }).pipe(Effect.provide(attachmentTestLayer("normalizer-exact-boundary"))),
  );

  it.effect("removes staged blobs when downstream dispatch fails", () =>
    Effect.gen(function* () {
      const attachment = imageUpload("dispatch.png", Uint8Array.of(1, 2, 3));
      yield* withNormalizedDispatchCommand(turnStart([attachment]), () =>
        Effect.fail("dispatch-failed"),
      ).pipe(Effect.flip);
      expect(yield* attachmentFileNames).toEqual([]);
    }).pipe(Effect.provide(attachmentTestLayer("normalizer-dispatch-cleanup"))),
  );

  it.effect("removes newly staged retry blobs when dispatch returns a duplicate receipt", () =>
    Effect.gen(function* () {
      const command = turnStart([imageUpload("retry.png", Uint8Array.of(1, 2, 3))]);
      yield* withNormalizedDispatchCommand(
        command,
        () => Effect.succeed({ sequence: 1, deduplicated: false }),
        { cleanupAttachmentsOnSuccess: (result) => result.deduplicated },
      );
      const originalFiles = yield* attachmentFileNames;
      expect(originalFiles).toHaveLength(1);

      yield* withNormalizedDispatchCommand(
        command,
        () => Effect.succeed({ sequence: 1, deduplicated: true }),
        { cleanupAttachmentsOnSuccess: (result) => result.deduplicated },
      );
      expect(yield* attachmentFileNames).toEqual(originalFiles);
    }).pipe(Effect.provide(attachmentTestLayer("normalizer-duplicate-cleanup"))),
  );
});
