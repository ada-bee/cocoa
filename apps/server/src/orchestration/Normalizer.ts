import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { normalizeProjectPathForDispatch } from "@t3tools/shared/path";
import {
  type ClientOrchestrationCommand,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  encodedImageDataUrlSize,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES,
} from "@t3tools/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand => {
  const canonicalCommand =
    "createdAt" in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command;

  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap?.createThread) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  };
};

interface NormalizedDispatchCommand {
  readonly command: OrchestrationCommand;
  readonly persistedAttachmentPaths: ReadonlyArray<string>;
}

const cleanupPersistedAttachments = (
  fileSystem: FileSystem.FileSystem,
  attachmentPaths: ReadonlyArray<string>,
) =>
  Effect.forEach(
    attachmentPaths,
    (attachmentPath) =>
      fileSystem.remove(attachmentPath, { force: true }).pipe(Effect.catch(() => Effect.void)),
    { concurrency: 1, discard: true },
  );

const normalizeDispatchCommandWithMetadata = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);

    if (canonicalCommand.type === "project.create") {
      return {
        command: {
          ...canonicalCommand,
          workspaceRoot: normalizeProjectPathForDispatch(canonicalCommand.workspaceRoot),
          createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
        } satisfies OrchestrationCommand,
        persistedAttachmentPaths: [],
      } satisfies NormalizedDispatchCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      canonicalCommand.workspaceRoot !== undefined
    ) {
      return {
        command: {
          ...canonicalCommand,
          workspaceRoot: normalizeProjectPathForDispatch(canonicalCommand.workspaceRoot),
        } satisfies OrchestrationCommand,
        persistedAttachmentPaths: [],
      } satisfies NormalizedDispatchCommand;
    }

    if (canonicalCommand.type !== "thread.turn.start") {
      return {
        command: canonicalCommand as OrchestrationCommand,
        persistedAttachmentPaths: [],
      } satisfies NormalizedDispatchCommand;
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

    if (canonicalCommand.message.attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      return yield* new OrchestrationDispatchCommandError({
        message: `A turn can include at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} image attachments.`,
      });
    }

    let aggregateEncodedBytes = 0;
    const preparedAttachments = yield* Effect.forEach(
      canonicalCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          aggregateEncodedBytes += encodedImageDataUrlSize({
            mimeType: parsed.mimeType,
            sizeBytes: bytes.byteLength,
          });
          if (aggregateEncodedBytes > PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Image attachments must encode to at most ${PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES} bytes.`,
            });
          }

          const attachmentId = createAttachmentId(canonicalCommand.threadId);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          return { attachment: persistedAttachment, attachmentPath, bytes };
        }),
      { concurrency: 1 },
    );

    const persistedAttachmentPaths = preparedAttachments.map((prepared) => prepared.attachmentPath);
    yield* Effect.forEach(
      preparedAttachments,
      (prepared) =>
        fileSystem.makeDirectory(path.dirname(prepared.attachmentPath), { recursive: true }).pipe(
          Effect.mapError(
            () =>
              new OrchestrationDispatchCommandError({
                message: `Failed to create attachment directory for '${prepared.attachment.name}'.`,
              }),
          ),
          Effect.andThen(
            fileSystem.writeFile(prepared.attachmentPath, prepared.bytes).pipe(
              Effect.mapError(
                () =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to persist attachment '${prepared.attachment.name}'.`,
                  }),
              ),
            ),
          ),
        ),
      { concurrency: 1, discard: true },
    ).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? cleanupPersistedAttachments(fileSystem, persistedAttachmentPaths)
          : Effect.void,
      ),
    );

    return {
      command: {
        ...canonicalCommand,
        message: {
          ...canonicalCommand.message,
          attachments: preparedAttachments.map((prepared) => prepared.attachment),
        },
      } satisfies OrchestrationCommand,
      persistedAttachmentPaths,
    } satisfies NormalizedDispatchCommand;
  });

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  normalizeDispatchCommandWithMetadata(command).pipe(
    Effect.map((normalized) => normalized.command),
  );

export const withNormalizedDispatchCommand = <A, E, R>(
  command: ClientOrchestrationCommand,
  use: (command: OrchestrationCommand) => Effect.Effect<A, E, R>,
  options?: {
    readonly cleanupAttachmentsOnSuccess?: (value: A) => boolean;
  },
) =>
  normalizeDispatchCommandWithMetadata(command).pipe(
    Effect.flatMap((normalized) =>
      use(normalized.command).pipe(
        Effect.onExit((exit) =>
          normalized.persistedAttachmentPaths.length > 0 &&
          (Exit.isFailure(exit) ||
            (Exit.isSuccess(exit) && options?.cleanupAttachmentsOnSuccess?.(exit.value) === true))
            ? Effect.gen(function* () {
                const fileSystem = yield* FileSystem.FileSystem;
                yield* cleanupPersistedAttachments(fileSystem, normalized.persistedAttachmentPaths);
              })
            : Effect.void,
        ),
      ),
    ),
  );
