import {
  TextGenerationError,
  type ChatAttachment,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import {
  CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_IMAGE_DATA_URL_BYTES,
  CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_IMAGES,
  makeCodexEndpointStructuredGeneration,
  type CodexEndpointStructuredGenerationError,
  type MakeCodexEndpointStructuredGenerationOptions,
} from "../provider/codexEndpoint/CodexEndpointStructuredGeneration.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";

type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const IMAGE_MIME_TYPE_PATTERN = /^image\/[a-z0-9.+-]+$/i;

class CodexEndpointAttachmentFileMismatchError extends Schema.TaggedErrorClass<CodexEndpointAttachmentFileMismatchError>()(
  "CodexEndpointAttachmentFileMismatchError",
  {},
) {}

interface CodexEndpointTextGenerationDependencies {
  readonly makeStructuredGeneration: typeof makeCodexEndpointStructuredGeneration;
}

const defaultDependencies: CodexEndpointTextGenerationDependencies = {
  makeStructuredGeneration: makeCodexEndpointStructuredGeneration,
};

export type MakeCodexEndpointTextGenerationOptions = MakeCodexEndpointStructuredGenerationOptions;

function textGenerationFailure(
  operation: TextGenerationOperation,
  detail: string,
): TextGenerationError {
  return new TextGenerationError({ operation, detail });
}

function structuredGenerationFailureDetail(error: CodexEndpointStructuredGenerationError): string {
  switch (error.reason) {
    case "instance-mismatch":
      return "Workspace ownership does not match the selected text-generation provider.";
    case "invalid-input":
      return "The text-generation request exceeds a supported input boundary.";
    case "endpoint-unavailable":
    case "endpoint-disconnected":
      return "The Codex endpoint is unavailable.";
    case "route-failed":
    case "request-failed":
      return "The Codex endpoint rejected the text-generation request.";
    case "turn-failed":
    case "turn-interrupted":
      return "The Codex endpoint did not complete text generation.";
    case "missing-final-response":
    case "malformed-final-response":
      return "The Codex endpoint returned invalid structured output.";
    case "timeout":
      return "The Codex endpoint text-generation request timed out.";
  }
}

function encodedDataUrlSize(attachment: ChatAttachment): number {
  const mimeType = attachment.mimeType.toLowerCase();
  return `data:${mimeType};base64,`.length + Math.ceil(attachment.sizeBytes / 3) * 4;
}

const readManagedAttachmentBounded = Effect.fn(
  "CodexEndpointTextGeneration.readManagedAttachmentBounded",
)(function* (fileSystem: FileSystem.FileSystem, path: string, declaredSize: number) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fileSystem.open(path, { flag: "r" });
      const info = yield* file.stat;
      if (info.type !== "File" || info.size !== BigInt(declaredSize)) {
        return yield* new CodexEndpointAttachmentFileMismatchError({});
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
        return yield* new CodexEndpointAttachmentFileMismatchError({});
      }

      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }),
  );
});

export const makeCodexEndpointTextGeneration = Effect.fn("makeCodexEndpointTextGeneration")(
  function* (
    options: MakeCodexEndpointTextGenerationOptions,
    dependencies: Partial<CodexEndpointTextGenerationDependencies> = {},
  ): Effect.fn.Return<
    TextGeneration.TextGeneration["Service"],
    never,
    FileSystem.FileSystem | ServerConfig
  > {
    const resolvedDependencies = { ...defaultDependencies, ...dependencies };
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const structuredGeneration = yield* resolvedDependencies.makeStructuredGeneration(options);

    const materializeImageDataUrls = Effect.fn(
      "CodexEndpointTextGeneration.materializeImageDataUrls",
    )(function* (
      operation: TextGenerationOperation,
      attachments: ReadonlyArray<ChatAttachment> | undefined,
    ): Effect.fn.Return<ReadonlyArray<string>, TextGenerationError> {
      if (attachments === undefined || attachments.length === 0) return [];
      if (attachments.length > CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_IMAGES) {
        return yield* textGenerationFailure(
          operation,
          "Too many image attachments were supplied for text generation.",
        );
      }

      let estimatedBytes = 0;
      for (const attachment of attachments) {
        if (!IMAGE_MIME_TYPE_PATTERN.test(attachment.mimeType) || attachment.sizeBytes <= 0) {
          return yield* textGenerationFailure(
            operation,
            "An image attachment is invalid for text generation.",
          );
        }
        estimatedBytes += encodedDataUrlSize(attachment);
        if (estimatedBytes > CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_IMAGE_DATA_URL_BYTES) {
          return yield* textGenerationFailure(
            operation,
            "Image attachments exceed the text-generation size limit.",
          );
        }
      }

      let aggregateBytes = 0;
      const dataUrls: Array<string> = [];
      for (const attachment of attachments) {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (attachmentPath === null) {
          return yield* textGenerationFailure(
            operation,
            "A gateway-managed image attachment could not be resolved.",
          );
        }
        const bytes = yield* readManagedAttachmentBounded(
          fileSystem,
          attachmentPath,
          attachment.sizeBytes,
        ).pipe(
          Effect.mapError(() =>
            textGenerationFailure(
              operation,
              "A gateway-managed image attachment could not be loaded.",
            ),
          ),
        );
        if (bytes.byteLength === 0) {
          return yield* textGenerationFailure(
            operation,
            "An image attachment is invalid for text generation.",
          );
        }
        const dataUrl = `data:${attachment.mimeType.toLowerCase()};base64,${Encoding.encodeBase64(bytes)}`;
        aggregateBytes += dataUrl.length;
        if (aggregateBytes > CODEX_ENDPOINT_STRUCTURED_GENERATION_MAX_IMAGE_DATA_URL_BYTES) {
          return yield* textGenerationFailure(
            operation,
            "Image attachments exceed the text-generation size limit.",
          );
        }
        dataUrls.push(dataUrl);
      }
      return dataUrls;
    });

    const runStructured = Effect.fn("CodexEndpointTextGeneration.runStructured")(function* <
      S extends Schema.Top,
    >(input: {
      readonly operation: TextGenerationOperation;
      readonly providerInstanceId: ProviderInstanceId;
      readonly cwd: string;
      readonly prompt: string;
      readonly outputSchema: S;
      readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
      readonly modelSelection: TextGeneration.ThreadTitleGenerationInput["modelSelection"];
    }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
      if (
        input.providerInstanceId !== options.providerInstanceId ||
        input.modelSelection.instanceId !== options.providerInstanceId
      ) {
        return yield* textGenerationFailure(
          input.operation,
          "Workspace ownership does not match the selected text-generation provider.",
        );
      }

      const imageDataUrls = yield* materializeImageDataUrls(input.operation, input.attachments);
      const generated = yield* structuredGeneration
        .generate({
          workspace: {
            providerInstanceId: input.providerInstanceId,
            remotePath: input.cwd,
          },
          modelSelection: input.modelSelection,
          prompt: input.prompt,
          outputSchema: toJsonSchemaObject(input.outputSchema),
          imageDataUrls,
        })
        .pipe(
          Effect.mapError((error) =>
            textGenerationFailure(input.operation, structuredGenerationFailureDetail(error)),
          ),
        );

      // The prompt builder selects the exact result schema at runtime (including the
      // commit schema variant), so this decoder cannot be safely hoisted.
      // eslint-disable-next-line t3code/no-inline-schema-compile
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(input.outputSchema))(
        generated.text,
      ).pipe(
        Effect.mapError(() =>
          textGenerationFailure(
            input.operation,
            "The Codex endpoint returned invalid structured output.",
          ),
        ),
      );
    });

    const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
      Effect.fn("CodexEndpointTextGeneration.generateCommitMessage")(function* (input) {
        const { prompt, outputSchema } = buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        });
        const generated = yield* runStructured({
          operation: "generateCommitMessage",
          providerInstanceId: input.providerInstanceId,
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
        return {
          subject: sanitizeCommitSubject(generated.subject),
          body: generated.body.trim(),
          ...("branch" in generated && typeof generated.branch === "string"
            ? { branch: sanitizeFeatureBranchName(generated.branch) }
            : {}),
        };
      });

    const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
      Effect.fn("CodexEndpointTextGeneration.generatePrContent")(function* (input) {
        const { prompt, outputSchema } = buildPrContentPrompt({
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          commitSummary: input.commitSummary,
          diffSummary: input.diffSummary,
          diffPatch: input.diffPatch,
          policy: input.policy,
          changeRequestTemplate: input.changeRequestTemplate,
        });
        const generated = yield* runStructured({
          operation: "generatePrContent",
          providerInstanceId: input.providerInstanceId,
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
        return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
      });

    const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
      Effect.fn("CodexEndpointTextGeneration.generateBranchName")(function* (input) {
        const { prompt, outputSchema } = buildBranchNamePrompt({
          message: input.message,
          attachments: input.attachments,
        });
        const generated = yield* runStructured({
          operation: "generateBranchName",
          providerInstanceId: input.providerInstanceId,
          cwd: input.cwd,
          prompt,
          outputSchema,
          attachments: input.attachments,
          modelSelection: input.modelSelection,
        });
        return { branch: sanitizeBranchFragment(generated.branch) };
      });

    const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
      Effect.fn("CodexEndpointTextGeneration.generateThreadTitle")(function* (input) {
        const { prompt, outputSchema } = buildThreadTitlePrompt({
          message: input.message,
          previousTitle: input.previousTitle,
          attachments: input.attachments,
        });
        const generated = yield* runStructured({
          operation: "generateThreadTitle",
          providerInstanceId: input.providerInstanceId,
          cwd: input.cwd,
          prompt,
          outputSchema,
          attachments: input.attachments,
          modelSelection: input.modelSelection,
        });
        return { title: sanitizeThreadTitle(generated.title) };
      });

    return TextGeneration.TextGeneration.of({
      generateCommitMessage,
      generatePrContent,
      generateBranchName,
      generateThreadTitle,
    });
  },
);
