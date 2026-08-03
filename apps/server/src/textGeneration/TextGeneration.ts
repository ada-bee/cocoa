import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ChatAttachment, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";

export type TextGenerationProvider = "codex" | "claudeAgent" | "cursor" | "grok" | "opencode";

export interface CommitMessageGenerationInput {
  /** Persisted provider instance which owns `cwd`. */
  providerInstanceId: ProviderInstanceId;
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  /** Persisted provider instance which owns `cwd`. */
  providerInstanceId: ProviderInstanceId;
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  /** Persisted provider instance which owns `cwd`. */
  providerInstanceId: ProviderInstanceId;
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  /** Persisted provider instance which owns `cwd`. */
  providerInstanceId: ProviderInstanceId;
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
}

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    /**
     * Generate a commit message from staged change context.
     */
    readonly generateCommitMessage: (
      input: CommitMessageGenerationInput,
    ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

    /**
     * Generate change request title/body from branch and diff context.
     */
    readonly generatePrContent: (
      input: PrContentGenerationInput,
    ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

    /**
     * Generate a concise branch name from a user message.
     */
    readonly generateBranchName: (
      input: BranchNameGenerationInput,
    ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

    /** Generate a concise thread title from a first message or thread history. */
    readonly generateThreadTitle: (
      input: ThreadTitleGenerationInput,
    ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;
  }
>()("t3/textGeneration/TextGeneration") {}

/** @deprecated Use `TextGeneration["Service"]`. */
export type TextGenerationShape = TextGeneration["Service"];

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const failOwnershipMismatch = (operation: TextGenerationOp): TextGenerationError =>
  new TextGenerationError({
    operation,
    detail: "Workspace ownership does not match the selected text-generation provider.",
  });

export const bindTextGenerationOwnership = (
  providerInstanceId: ProviderInstanceId,
  service: TextGeneration["Service"],
): TextGeneration["Service"] => {
  const owns = (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelSelection: ModelSelection;
  }) =>
    input.providerInstanceId === providerInstanceId &&
    input.modelSelection.instanceId === providerInstanceId;

  return TextGeneration.of({
    generateCommitMessage: (input) =>
      owns(input)
        ? service.generateCommitMessage(input)
        : Effect.fail(failOwnershipMismatch("generateCommitMessage")),
    generatePrContent: (input) =>
      owns(input)
        ? service.generatePrContent(input)
        : Effect.fail(failOwnershipMismatch("generatePrContent")),
    generateBranchName: (input) =>
      owns(input)
        ? service.generateBranchName(input)
        : Effect.fail(failOwnershipMismatch("generateBranchName")),
    generateThreadTitle: (input) =>
      owns(input)
        ? service.generateThreadTitle(input)
        : Effect.fail(failOwnershipMismatch("generateThreadTitle")),
  });
};

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelSelection: ModelSelection;
  },
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  input.providerInstanceId !== input.modelSelection.instanceId
    ? Effect.fail(failOwnershipMismatch(operation))
    : registry.getInstance(input.providerInstanceId).pipe(
        Effect.flatMap((instance) =>
          instance
            ? Effect.succeed(instance.textGeneration)
            : Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: `No provider instance registered for id '${input.providerInstanceId}'.`,
                }),
              ),
        ),
      );

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
): TextGeneration["Service"] =>
  TextGeneration.of({
    generateCommitMessage: (input) =>
      resolveInstance(registry, "generateCommitMessage", input).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)),
      ),
    generatePrContent: (input) =>
      resolveInstance(registry, "generatePrContent", input).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
      ),
    generateBranchName: (input) =>
      resolveInstance(registry, "generateBranchName", input).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
      ),
    generateThreadTitle: (input) =>
      resolveInstance(registry, "generateThreadTitle", input).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateThreadTitle(input)),
      ),
  });

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return makeTextGenerationFromRegistry(registry);
});

export const layer = Layer.effect(TextGeneration, make);
