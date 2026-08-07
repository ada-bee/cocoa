import * as NodeURL from "node:url";

import type { ChatAttachment, ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";
import {
  createOpencodeClient,
  type Agent,
  type FilePartInput,
  type OpencodeClient,
  type PermissionRuleset,
  type ProviderListResponse,
  type QuestionAnswer,
  type QuestionRequest,
} from "@opencode-ai/sdk/v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const OPENCODE_RUNTIME_ERROR_TAG = "OpenCodeRuntimeError";

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
}

export class OpenCodeRuntimeError extends Data.TaggedError(OPENCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCodeRuntimeError =>
    P.isTagged(u, OPENCODE_RUNTIME_ERROR_TAG);
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (OpenCodeRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (cause && typeof cause === "object") {
    const anyCause = cause as Record<string, unknown>;
    const status = (anyCause.response as { status?: number } | undefined)?.status;
    const body = anyCause.error ?? anyCause.data ?? anyCause.body;
    const encodedBody = encodeJsonStringForDiagnostics(body ?? cause);
    if (encodedBody) return `status=${status ?? "?"} body=${encodedBody}`;
  }
  return String(cause);
}

export const runOpenCodeSdk = <A>(
  operation: string,
  fn: () => Promise<A>,
): Effect.Effect<A, OpenCodeRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCodeRuntimeError({ operation, detail: openCodeRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`opencode.${operation}`));

export interface OpenCodeInventory {
  readonly providerList: ProviderListResponse;
  readonly agents: ReadonlyArray<Agent>;
}

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

/** SDK-only seam shared by externally managed OpenCode endpoints and the legacy local runtime. */
export interface OpenCodeEndpointRuntimeShape {
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly serverUrl?: string | null;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly directory?: string;
    readonly serverPassword?: string;
  }) => OpencodeClient;
  readonly loadOpenCodeInventory: (
    client: OpencodeClient,
  ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
}

export const createOpenCodeSdkClient: OpenCodeEndpointRuntimeShape["createOpenCodeSdkClient"] = (
  input,
) =>
  createOpencodeClient({
    baseUrl: input.baseUrl,
    ...(input.directory === undefined ? {} : { directory: input.directory }),
    ...(input.serverPassword
      ? {
          headers: {
            Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
          },
        }
      : {}),
    throwOnError: true,
  });

export const loadOpenCodeInventory: OpenCodeEndpointRuntimeShape["loadOpenCodeInventory"] = (
  client,
) =>
  Effect.all(
    [
      runOpenCodeSdk("provider.list", () => client.provider.list()).pipe(
        Effect.filterMapOrFail(
          (list) =>
            list.data
              ? Result.succeed(list.data)
              : Result.fail(
                  new OpenCodeRuntimeError({
                    operation: "provider.list",
                    detail: "OpenCode provider list was empty.",
                  }),
                ),
          (result) => result,
        ),
      ),
      runOpenCodeSdk("app.agents", () => client.app.agents()).pipe(
        Effect.map((result) => result.data ?? []),
      ),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.map(([providerList, agents]) => ({ providerList, agents })));

/** Runtime used by Cocoa: it can only accept an explicitly configured daemon URL. */
export const OpenCodeEndpointRuntime: OpenCodeEndpointRuntimeShape = {
  connectToOpenCodeServer: (input) => {
    const url = input.serverUrl?.trim();
    return url
      ? Effect.succeed({ url, exitCode: null, external: true })
      : Effect.fail(
          new OpenCodeRuntimeError({
            operation: "connectToOpenCodeServer",
            detail: "An explicit OpenCode server URL is required by the Cocoa gateway.",
          }),
        );
  },
  createOpenCodeSdkClient,
  loadOpenCodeInventory,
};

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") return null;
  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  return { providerID: trimmed.slice(0, separator), modelID: trimmed.slice(separator + 1) };
}

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];
  for (const attachment of input.attachments ?? []) {
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) continue;
    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.name,
      url: NodeURL.pathToFileURL(attachmentPath).href,
    });
  }
  return parts;
}

/** Build SDK file parts from gateway-materialized data URLs safe for a remote daemon. */
export function toOpenCodeDataUrlFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly dataUrls: ReadonlyArray<string>;
}): Array<FilePartInput> {
  const attachments = input.attachments ?? [];
  return attachments.flatMap((attachment, index) => {
    const url = input.dataUrls[index];
    return url === undefined
      ? []
      : [
          {
            type: "file" as const,
            mime: attachment.mimeType,
            filename: attachment.name,
            url,
          },
        ];
  });
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [{ permission: "*", pattern: "*", action: "allow" }];
  }
  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string") return raw.trim().length > 0 ? [raw] : [];
    return [];
  });
}
