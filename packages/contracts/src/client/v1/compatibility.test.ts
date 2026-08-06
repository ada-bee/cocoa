import { describe, expect, it } from "@effect/vitest";
import * as CocoaClientV1 from "@t3tools/contracts/client/v1";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ProjectExecuteCommandInput,
  ProviderExecutionResult,
  UploadChatAttachment,
  UploadChatAttachments,
} from "@t3tools/contracts";

import discriminatorsFixture from "./fixtures/discriminators.v1.json" with { type: "json" };
import executionFixture from "./fixtures/execution.v1.json" with { type: "json" };
import infoResponseFixture from "./fixtures/info-response.v1.json" with { type: "json" };
import supportedMethodsFixture from "./fixtures/supported-methods.v1.json" with { type: "json" };
import threadEventFixture from "./fixtures/thread-event.v1.json" with { type: "json" };
import turnAttachmentsFixture from "./fixtures/turn-attachments.v1.json" with { type: "json" };
import versionMismatchFixture from "./fixtures/version-mismatch.v1.json" with { type: "json" };

const decodeInfo = Schema.decodeUnknownEffect(CocoaClientV1.CocoaClientV1InfoResponse);
const decodeExecuteCommand = Schema.decodeUnknownSync(
  CocoaClientV1.CocoaClientV1ExecuteCommandInput,
);
const decodeExecuteCommandResult = Schema.decodeUnknownSync(
  CocoaClientV1.CocoaClientV1ExecuteCommandResult,
);
const decodeCommand = Schema.decodeUnknownSync(CocoaClientV1.CocoaClientV1Command);
const decodeThreadEvent = Schema.decodeUnknownSync(CocoaClientV1.CocoaClientV1ThreadEvent);
const decodeMismatch = Schema.decodeUnknownSync(CocoaClientV1.CocoaClientProtocolVersionMismatch);

describe("Cocoa client protocol v1 compatibility", () => {
  it("owns execution and attachment schemas instead of aliasing internal roots", () => {
    expect(CocoaClientV1.CocoaClientV1ExecuteCommandInput).not.toBe(ProjectExecuteCommandInput);
    expect(CocoaClientV1.CocoaClientV1ExecuteCommandResult).not.toBe(ProviderExecutionResult);
    expect(CocoaClientV1.CocoaClientV1UploadChatAttachment).not.toBe(UploadChatAttachment);
    expect(CocoaClientV1.CocoaClientV1UploadChatAttachments).not.toBe(UploadChatAttachments);
  });

  it("pins v1 execution and attachment limits independently of internal contracts", () => {
    expect(CocoaClientV1.COCOA_CLIENT_V1_EXECUTION_MAX_ARGUMENTS).toBe(128);
    expect(CocoaClientV1.COCOA_CLIENT_V1_EXECUTION_MAX_ARGUMENT_BYTES).toBe(16 * 1024);
    expect(CocoaClientV1.COCOA_CLIENT_V1_EXECUTION_MAX_COMMAND_BYTES).toBe(64 * 1024);
    expect(CocoaClientV1.COCOA_CLIENT_V1_EXECUTION_MAX_TIMEOUT_MS).toBe(120_000);
    expect(CocoaClientV1.COCOA_CLIENT_V1_EXECUTION_MAX_OUTPUT_BYTES).toBe(4 * 1024 * 1024);
    expect(CocoaClientV1.COCOA_CLIENT_V1_SEND_TURN_MAX_INPUT_CHARS).toBe(120_000);
    expect(CocoaClientV1.COCOA_CLIENT_V1_SEND_TURN_MAX_ATTACHMENTS).toBe(4);
    expect(CocoaClientV1.COCOA_CLIENT_V1_SEND_TURN_MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
    expect(CocoaClientV1.COCOA_CLIENT_V1_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES).toBe(8 * 1024 * 1024);
  });

  it("pins the v1 execution wire shape with a golden fixture", () => {
    expect(decodeExecuteCommand(executionFixture.input)).toEqual({
      projectId: "project-1",
      command: ["git", "status", "--short"],
      timeoutMs: 5_000,
      outputByteLimit: 4_096,
    });
    expect(decodeExecuteCommandResult(executionFixture.result)).toEqual({
      exitCode: 0,
      stdout: " M packages/contracts/src/client/v1/execution.ts\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });

  it("pins the v1 turn attachment wire shape with a golden fixture", () => {
    expect(decodeCommand(turnAttachmentsFixture)).toEqual({
      type: "thread.turn.start",
      commandId: "command-upload-golden",
      threadId: "thread-1",
      message: {
        messageId: "message-upload-golden",
        role: "user",
        text: "Inspect this image.",
        attachments: [
          {
            type: "image",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 1,
            dataUrl: "data:image/png;base64,AA==",
          },
        ],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-08-04T10:00:00.000Z",
    });
  });

  it("freezes the v1 turn attachment count and aggregate policy", () => {
    const makeCommand = (dataUrls: ReadonlyArray<string>) => ({
      type: "thread.turn.start",
      commandId: "command-upload-policy",
      threadId: "thread-1",
      message: {
        messageId: "message-upload-policy",
        role: "user",
        text: "inspect",
        attachments: dataUrls.map((dataUrl, index) => ({
          type: "image",
          name: `image-${index}.png`,
          mimeType: "image/png",
          sizeBytes: 1,
          dataUrl,
        })),
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-08-04T10:00:00.000Z",
    });
    const smallDataUrl = "data:image/png;base64,AA==";

    expect(() =>
      decodeCommand(
        makeCommand(
          Array.from(
            { length: CocoaClientV1.COCOA_CLIENT_V1_SEND_TURN_MAX_ATTACHMENTS + 1 },
            () => smallDataUrl,
          ),
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeCommand(
        makeCommand([
          `data:image/png;base64,${"A".repeat(
            CocoaClientV1.COCOA_CLIENT_V1_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES,
          )}`,
        ]),
      ),
    ).toThrow();

    const prefix = "data:image/png;base64,";
    const aggregatePayloadChars =
      CocoaClientV1.COCOA_CLIENT_V1_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES - prefix.length * 2;
    const firstPayloadChars = Math.floor(aggregatePayloadChars / 8) * 4;
    const secondPayloadChars = aggregatePayloadChars - firstPayloadChars;
    const exactBoundary = makeCommand([
      `${prefix}${"A".repeat(firstPayloadChars)}`,
      `${prefix}${"A".repeat(secondPayloadChars)}`,
    ]);
    expect(() => decodeCommand(exactBoundary)).not.toThrow();
    expect(() =>
      decodeCommand({
        ...exactBoundary,
        message: {
          ...exactBoundary.message,
          attachments: exactBoundary.message.attachments.map((attachment, index) =>
            index === 1 ? { ...attachment, dataUrl: `${attachment.dataUrl}A` } : attachment,
          ),
        },
      }),
    ).toThrow();

    expect(() =>
      decodeCommand({
        ...makeCommand([]),
        message: {
          ...makeCommand([]).message,
          text: "x".repeat(CocoaClientV1.COCOA_CLIENT_V1_SEND_TURN_MAX_INPUT_CHARS + 1),
        },
      }),
    ).toThrow();

    expect(() =>
      decodeCommand({
        ...makeCommand([smallDataUrl]),
        message: {
          ...makeCommand([smallDataUrl]).message,
          attachments: [
            {
              type: "image",
              name: "oversized.png",
              mimeType: "image/png",
              sizeBytes: CocoaClientV1.COCOA_CLIENT_V1_SEND_TURN_MAX_IMAGE_BYTES + 1,
              dataUrl: smallDataUrl,
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("pins the exact supported core method inventory", () => {
    expect(CocoaClientV1.COCOA_CLIENT_V1_SUPPORTED_METHODS).toEqual(supportedMethodsFixture);
    expect(Array.from(CocoaClientV1.CocoaClientV1RpcGroup.requests.keys())).toEqual(
      supportedMethodsFixture,
    );
  });

  it("pins command and subscription discriminator inventories", () => {
    expect(CocoaClientV1.COCOA_CLIENT_V1_COMMAND_TYPES).toEqual(discriminatorsFixture.commandTypes);
    expect(CocoaClientV1.COCOA_CLIENT_V1_SHELL_STREAM_KINDS).toEqual(
      discriminatorsFixture.shellStreamKinds,
    );
    expect(CocoaClientV1.COCOA_CLIENT_V1_THREAD_EVENT_TYPES).toEqual(
      discriminatorsFixture.threadEventTypes,
    );
  });

  it("keeps optional workspace domains out of the core method inventory", () => {
    expect(CocoaClientV1.COCOA_CLIENT_V1_OPTIONAL_CAPABILITIES).toEqual([
      "workspace.filesystem",
      "workspace.vcs",
      "workspace.terminal",
      "workspace.execution",
    ]);
    expect(CocoaClientV1.COCOA_CLIENT_V1_SUPPORTED_METHODS).not.toContain("filesystem.browse");
    expect(CocoaClientV1.COCOA_CLIENT_V1_SUPPORTED_METHODS).not.toContain("vcs.pull");
    expect(CocoaClientV1.COCOA_CLIENT_V1_SUPPORTED_METHODS).not.toContain("terminal.open");
  });

  it("bounds project execution without accepting a client cwd", () => {
    const decoded = decodeExecuteCommand(executionFixture.input);
    expect(decoded).toEqual({
      projectId: "project-1",
      command: ["git", "status", "--short"],
      timeoutMs: 5_000,
      outputByteLimit: 4_096,
    });
  });

  it.each([
    [],
    [""],
    ["printf", "bad\0argument"],
    Array.from({ length: CocoaClientV1.COCOA_CLIENT_V1_EXECUTION_MAX_ARGUMENTS + 1 }, () => "x"),
    ["x".repeat(CocoaClientV1.COCOA_CLIENT_V1_EXECUTION_MAX_ARGUMENT_BYTES + 1)],
    [
      "x".repeat(CocoaClientV1.COCOA_CLIENT_V1_EXECUTION_MAX_ARGUMENT_BYTES),
      "x".repeat(CocoaClientV1.COCOA_CLIENT_V1_EXECUTION_MAX_ARGUMENT_BYTES),
      "x".repeat(CocoaClientV1.COCOA_CLIENT_V1_EXECUTION_MAX_ARGUMENT_BYTES),
      "x".repeat(CocoaClientV1.COCOA_CLIENT_V1_EXECUTION_MAX_ARGUMENT_BYTES),
      "y",
    ],
  ])("freezes unsafe or unbounded v1 argv %#", (command) => {
    expect(() => decodeExecuteCommand({ projectId: "project-1", command })).toThrow();
  });

  it("freezes v1 execution timeout, requested output, and returned output bounds", () => {
    expect(() =>
      decodeExecuteCommand({
        projectId: "project-1",
        command: ["true"],
        timeoutMs: CocoaClientV1.COCOA_CLIENT_V1_EXECUTION_MAX_TIMEOUT_MS + 1,
      }),
    ).toThrow();
    expect(() =>
      decodeExecuteCommand({
        projectId: "project-1",
        command: ["true"],
        outputByteLimit: CocoaClientV1.COCOA_CLIENT_V1_EXECUTION_MAX_OUTPUT_BYTES + 1,
      }),
    ).toThrow();
    expect(() =>
      decodeExecuteCommandResult({
        exitCode: 0,
        stdout: "x".repeat(CocoaClientV1.COCOA_CLIENT_V1_EXECUTION_MAX_OUTPUT_BYTES + 1),
        stderr: "",
        stdoutTruncated: true,
        stderrTruncated: false,
      }),
    ).toThrow();
    expect(() => decodeExecuteCommandResult({ exitCode: 0, stdout: "ok", stderr: "" })).toThrow();
  });

  it("rejects internal commands even when the legacy root contract accepts them", () => {
    expect(() =>
      decodeCommand({
        type: "thread.session.set",
        commandId: "command-internal",
        threadId: "thread-1",
        session: {},
        createdAt: "2026-08-04T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it.effect("accepts additive fields and drops unknown future capabilities", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeInfo(infoResponseFixture);

      expect(decoded).toEqual({
        protocolVersion: 1,
        protocolRange: { minimum: 1, maximum: 1 },
        capabilities: [
          "orchestration.core",
          "orchestration.resume",
          "orchestration.search",
          "orchestration.diff",
        ],
        environment: {
          environmentId: "gateway-1",
          label: "Cocoa Gateway",
          serverVersion: "0.0.31",
        },
        providers: [
          {
            instanceId: "codex_main",
            displayName: "Main Codex",
            enabled: true,
            available: true,
            status: "error",
            authStatus: "authenticated",
            connectionState: "blocked",
            message:
              "The Codex endpoint protocol is incompatible: required method 'thread/resume' is missing.",
            models: [],
          },
        ],
      });
    }),
  );

  it.effect("keeps endpoint health fields optional for older v1 gateways", () =>
    Effect.gen(function* () {
      const provider = infoResponseFixture.providers[0]!;
      const decoded = yield* decodeInfo({
        ...infoResponseFixture,
        providers: [
          {
            instanceId: provider.instanceId,
            displayName: provider.displayName,
            enabled: provider.enabled,
            available: provider.available,
            status: provider.status,
            authStatus: provider.authStatus,
            models: provider.models,
          },
        ],
      });

      expect(decoded.providers[0]).not.toHaveProperty("connectionState");
      expect(decoded.providers[0]).not.toHaveProperty("message");
    }),
  );

  it.effect("rejects required-field corruption", () =>
    Effect.gen(function* () {
      const corrupted = {
        ...infoResponseFixture,
        environment: {
          label: infoResponseFixture.environment.label,
          serverVersion: infoResponseFixture.environment.serverVersion,
        },
      };

      expect(yield* Effect.exit(decodeInfo(corrupted))).toMatchObject({ _tag: "Failure" });
    }),
  );

  it.effect("rejects a response from a different protocol major", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.exit(decodeInfo({ ...infoResponseFixture, protocolVersion: 2 })),
      ).toMatchObject({ _tag: "Failure" });
    }),
  );

  it("defines version mismatch as a non-overlapping range", () => {
    const mismatch = decodeMismatch(versionMismatchFixture);

    expect(
      CocoaClientV1.selectCocoaClientProtocolVersion(mismatch.clientRange, mismatch.serverRange),
    ).toBeNull();
    expect(
      CocoaClientV1.selectCocoaClientProtocolVersion(
        { minimum: 1, maximum: 2 },
        { minimum: 1, maximum: 1 },
      ),
    ).toBe(1);
  });

  it("projects thread events without provider-native metadata", () => {
    const decoded = decodeThreadEvent(threadEventFixture);

    expect(decoded).toEqual({
      sequence: 42,
      eventId: "event-42",
      threadId: "thread-1",
      occurredAt: "2026-08-04T10:00:00.000Z",
      commandId: "command-1",
      type: "thread.message-sent",
      payload: {
        threadId: "thread-1",
        messageId: "message-1",
        role: "assistant",
        text: "A normalized Cocoa message.",
        turnId: "turn-1",
        streaming: false,
        createdAt: "2026-08-04T10:00:00.000Z",
        updatedAt: "2026-08-04T10:00:00.000Z",
      },
    });
  });

  it("does not expose internal, provider-native, desktop, relay, or legacy RPC symbols", () => {
    const publicExports = new Set(Object.keys(CocoaClientV1));
    const forbiddenExports = [
      "InternalOrchestrationCommand",
      "OrchestrationCommand",
      "OrchestrationEvent",
      "CodexEndpointTransport",
      "CodexWorkspaceHelperRequest",
      "ProviderRuntimeEvent",
      "DesktopBridge",
      "RelayClientStatusSchema",
      "WsRpcGroup",
      "WS_METHODS",
    ];

    for (const forbiddenExport of forbiddenExports) {
      expect(publicExports.has(forbiddenExport)).toBe(false);
    }
  });
});
