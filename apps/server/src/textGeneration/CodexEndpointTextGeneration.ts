import {
  TextGenerationError,
  type ChatAttachment,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import {
  type GatewayManagedImageAttachmentError,
  materializeGatewayManagedImageDataUrls,
} from "../gatewayManagedImageAttachments.ts";
import {
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

function attachmentFailureDetail(error: GatewayManagedImageAttachmentError): string {
  switch (error.reason) {
    case "too-many-images":
      return "Too many image attachments were supplied for text generation.";
    case "invalid-image":
      return "An image attachment is invalid for text generation.";
    case "aggregate-too-large":
      return "Image attachments exceed the text-generation size limit.";
    case "unresolved-image":
      return "A gateway-managed image attachment could not be resolved.";
    case "file-mismatch":
    case "read-failed":
      return "A gateway-managed image attachment could not be loaded.";
  }
}

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
      return yield* materializeGatewayManagedImageDataUrls({
        attachmentsDir: serverConfig.attachmentsDir,
        attachments,
        fileSystem,
      }).pipe(
        Effect.mapError((error) =>
          textGenerationFailure(operation, attachmentFailureDetail(error)),
        ),
      );
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
