import type { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveAttachmentPath } from "./attachmentStore.ts";

export const CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_IMAGES = 4;
export const CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_IMAGE_DATA_URL_BYTES = 8 * 1024 * 1024;

const IMAGE_MIME_TYPE_PATTERN = /^image\/[a-z0-9.+-]+$/i;

export class GatewayManagedImageAttachmentError extends Schema.TaggedErrorClass<GatewayManagedImageAttachmentError>()(
  "GatewayManagedImageAttachmentError",
  {
    reason: Schema.Literals([
      "too-many-images",
      "invalid-image",
      "aggregate-too-large",
      "unresolved-image",
      "file-mismatch",
      "read-failed",
    ]),
  },
) {}
const isGatewayManagedImageAttachmentError = Schema.is(GatewayManagedImageAttachmentError);

function failure(reason: GatewayManagedImageAttachmentError["reason"]) {
  return new GatewayManagedImageAttachmentError({ reason });
}

function encodedDataUrlSize(attachment: ChatAttachment): number {
  return (
    `data:${attachment.mimeType.toLowerCase()};base64,`.length +
    Math.ceil(attachment.sizeBytes / 3) * 4
  );
}

const readManagedAttachmentBounded = Effect.fn(
  "GatewayManagedImageAttachments.readManagedAttachmentBounded",
)(function* (fileSystem: FileSystem.FileSystem, path: string, declaredSize: number) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fileSystem.open(path, { flag: "r" });
      const info = yield* file.stat;
      if (info.type !== "File" || info.size !== BigInt(declaredSize)) {
        return yield* failure("file-mismatch");
      }

      const limit = declaredSize + 1;
      const chunks: Array<Uint8Array> = [];
      let total = 0;
      while (total < limit) {
        const chunk = yield* file.readAlloc(Math.min(64 * 1024, limit - total));
        if (Option.isNone(chunk)) break;
        chunks.push(chunk.value);
        total += chunk.value.byteLength;
      }
      if (total !== declaredSize) {
        return yield* failure("file-mismatch");
      }

      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }),
  ).pipe(
    Effect.mapError((error) =>
      isGatewayManagedImageAttachmentError(error) ? error : failure("read-failed"),
    ),
  );
});

export interface MaterializeGatewayManagedImageDataUrlsInput {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
  readonly fileSystem: FileSystem.FileSystem;
}

/**
 * Materialize gateway-owned images without exposing gateway paths to a provider.
 * Declared sizes are checked before I/O, and each read is bounded to declaredSize + 1.
 */
export const materializeGatewayManagedImageDataUrls = Effect.fn(
  "GatewayManagedImageAttachments.materializeGatewayManagedImageDataUrls",
)(function* (input: MaterializeGatewayManagedImageDataUrlsInput) {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) return [] as ReadonlyArray<string>;
  if (attachments.length > CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_IMAGES) {
    return yield* failure("too-many-images");
  }

  let estimatedBytes = 0;
  for (const attachment of attachments) {
    if (
      !IMAGE_MIME_TYPE_PATTERN.test(attachment.mimeType) ||
      !Number.isSafeInteger(attachment.sizeBytes) ||
      attachment.sizeBytes <= 0
    ) {
      return yield* failure("invalid-image");
    }
    estimatedBytes += encodedDataUrlSize(attachment);
    if (estimatedBytes > CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_IMAGE_DATA_URL_BYTES) {
      return yield* failure("aggregate-too-large");
    }
  }

  let aggregateBytes = 0;
  const dataUrls: Array<string> = [];
  for (const attachment of attachments) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (attachmentPath === null) {
      return yield* failure("unresolved-image");
    }

    const bytes = yield* readManagedAttachmentBounded(
      input.fileSystem,
      attachmentPath,
      attachment.sizeBytes,
    );
    if (bytes.byteLength === 0) {
      return yield* failure("invalid-image");
    }

    const dataUrl = `data:${attachment.mimeType.toLowerCase()};base64,${Encoding.encodeBase64(bytes)}`;
    aggregateBytes += dataUrl.length;
    if (aggregateBytes > CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_IMAGE_DATA_URL_BYTES) {
      return yield* failure("aggregate-too-large");
    }
    dataUrls.push(dataUrl);
  }
  return dataUrls as ReadonlyArray<string>;
});
