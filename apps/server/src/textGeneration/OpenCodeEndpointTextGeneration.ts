import {
  TextGenerationError,
  type ChatAttachment,
  type OpenCodeSettings,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import {
  type GatewayManagedImageAttachmentError,
  materializeGatewayManagedImageDataUrls,
} from "../gatewayManagedImageAttachments.ts";
import {
  OpenCodeEndpointRuntime,
  parseOpenCodeModelSlug,
  toOpenCodeDataUrlFileParts,
  type OpenCodeEndpointRuntimeShape,
} from "../provider/OpenCodeEndpointRuntime.ts";
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
} from "./TextGenerationUtils.ts";

type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

interface OpenCodeTextPart {
  readonly type: "text";
  readonly text: string;
}

const isOpenCodeTextPart = (part: unknown): part is OpenCodeTextPart =>
  part !== null &&
  typeof part === "object" &&
  "type" in part &&
  part.type === "text" &&
  "text" in part &&
  typeof part.text === "string";

const promptFailureMessage = (error: unknown): string | null => {
  if (!error || typeof error !== "object") return null;
  if (
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string" &&
    error.data.message.trim() !== ""
  ) {
    return error.data.message.trim();
  }
  return "name" in error && typeof error.name === "string" && error.name.trim() !== ""
    ? error.name.trim()
    : null;
};

const failure = (
  operation: TextGenerationOperation,
  detail: string,
  cause?: unknown,
): TextGenerationError =>
  new TextGenerationError({ operation, detail, ...(cause ? { cause } : {}) });

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

export interface OpenCodeEndpointTextGenerationDependencies {
  readonly runtime: OpenCodeEndpointRuntimeShape;
}

const defaultDependencies: OpenCodeEndpointTextGenerationDependencies = {
  runtime: OpenCodeEndpointRuntime,
};

/** Endpoint-only extraction of the existing OpenCode SDK session/prompt generation flow. */
export const makeOpenCodeEndpointTextGeneration = Effect.fn("makeOpenCodeEndpointTextGeneration")(
  function* (
    providerInstanceId: ProviderInstanceId,
    settings: OpenCodeSettings,
    dependencies: Partial<OpenCodeEndpointTextGenerationDependencies> = {},
  ): Effect.fn.Return<
    TextGeneration.TextGeneration["Service"],
    never,
    FileSystem.FileSystem | ServerConfig
  > {
    const { runtime } = { ...defaultDependencies, ...dependencies };
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;

    const runStructured = Effect.fn("OpenCodeEndpointTextGeneration.runStructured")(function* <
      S extends Schema.Top,
    >(input: {
      readonly operation: TextGenerationOperation;
      readonly ownerInstanceId: ProviderInstanceId;
      readonly cwd: string;
      readonly prompt: string;
      readonly outputSchema: S;
      readonly modelSelection: TextGeneration.ThreadTitleGenerationInput["modelSelection"];
      readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
    }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
      if (
        input.ownerInstanceId !== providerInstanceId ||
        input.modelSelection.instanceId !== providerInstanceId
      ) {
        return yield* failure(
          input.operation,
          "Workspace ownership does not match the selected text-generation provider.",
        );
      }
      const parsedModel = parseOpenCodeModelSlug(input.modelSelection.model);
      if (!parsedModel) {
        return yield* failure(
          input.operation,
          "OpenCode model selection must use the 'provider/model' format.",
        );
      }

      const dataUrls = yield* materializeGatewayManagedImageDataUrls({
        attachments: input.attachments,
        attachmentsDir: serverConfig.attachmentsDir,
        fileSystem,
      }).pipe(Effect.mapError((error) => failure(input.operation, attachmentFailureDetail(error))));
      const fileParts = toOpenCodeDataUrlFileParts({
        attachments: input.attachments,
        dataUrls,
      });
      const client = runtime.createOpenCodeSdkClient({
        baseUrl: settings.serverUrl,
        directory: input.cwd,
        ...(settings.serverPassword ? { serverPassword: settings.serverPassword } : {}),
      });
      const session = yield* Effect.tryPromise({
        try: () =>
          client.session.create({
            title: `Cocoa Code ${input.operation}`,
            permission: [{ permission: "*", pattern: "*", action: "deny" }],
          }),
        catch: (cause) =>
          failure(input.operation, "OpenCode session.create request failed.", cause),
      });
      if (!session.data) {
        return yield* failure(
          input.operation,
          "OpenCode session.create returned no session payload.",
        );
      }

      const selectedAgent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
      const selectedVariant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
      const result = yield* Effect.tryPromise({
        try: () =>
          client.session.prompt({
            sessionID: session.data.id,
            model: parsedModel,
            ...(selectedAgent ? { agent: selectedAgent } : {}),
            ...(selectedVariant ? { variant: selectedVariant } : {}),
            parts: [{ type: "text", text: input.prompt }, ...fileParts],
          }),
        catch: (cause) =>
          failure(input.operation, "OpenCode session.prompt request failed.", cause),
      });
      const providerFailure = promptFailureMessage(result.data?.info?.error);
      if (providerFailure !== null) {
        return yield* failure(input.operation, providerFailure);
      }
      const rawText = (result.data?.parts ?? [])
        .flatMap((part) => (isOpenCodeTextPart(part) ? [part.text] : []))
        .join("")
        .trim();
      if (rawText === "") {
        return yield* failure(input.operation, "OpenCode returned empty output.");
      }

      // The prompt supplies an operation-specific schema, so there is no single
      // module-level decoder that can be compiled for every call.
      // eslint-disable-next-line t3code/no-inline-schema-compile
      return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
        extractJsonObject(rawText),
      ).pipe(
        Effect.mapError((cause) =>
          failure(input.operation, "OpenCode returned invalid structured output.", cause),
        ),
      );
    });

    const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
      Effect.fn("OpenCodeEndpointTextGeneration.generateCommitMessage")(function* (input) {
        const { prompt, outputSchema } = buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        });
        const generated = yield* runStructured({
          operation: "generateCommitMessage",
          ownerInstanceId: input.providerInstanceId,
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
      Effect.fn("OpenCodeEndpointTextGeneration.generatePrContent")(function* (input) {
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
          ownerInstanceId: input.providerInstanceId,
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
        return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
      });

    const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
      Effect.fn("OpenCodeEndpointTextGeneration.generateBranchName")(function* (input) {
        const { prompt, outputSchema } = buildBranchNamePrompt({
          message: input.message,
          attachments: input.attachments,
        });
        const generated = yield* runStructured({
          operation: "generateBranchName",
          ownerInstanceId: input.providerInstanceId,
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
          attachments: input.attachments,
        });
        return { branch: sanitizeBranchFragment(generated.branch) };
      });

    const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
      Effect.fn("OpenCodeEndpointTextGeneration.generateThreadTitle")(function* (input) {
        const { prompt, outputSchema } = buildThreadTitlePrompt({
          message: input.message,
          previousTitle: input.previousTitle,
          attachments: input.attachments,
        });
        const generated = yield* runStructured({
          operation: "generateThreadTitle",
          ownerInstanceId: input.providerInstanceId,
          cwd: input.cwd,
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
          attachments: input.attachments,
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
