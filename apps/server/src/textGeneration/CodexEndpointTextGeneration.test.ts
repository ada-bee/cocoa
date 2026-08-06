import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatImageAttachment,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { attachmentRelativePath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import {
  type CodexEndpointStructuredGeneration,
  type CodexEndpointStructuredGenerationInput,
} from "../provider/codexEndpoint/CodexEndpointStructuredGeneration.ts";
import type { CodexEndpointSupervisor } from "../provider/codexEndpoint/CodexEndpointSupervisor.ts";
import { makeCodexEndpointTextGeneration } from "./CodexEndpointTextGeneration.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex_remote");
const OTHER_INSTANCE_ID = ProviderInstanceId.make("codex_other");
const MODEL_SELECTION = {
  instanceId: INSTANCE_ID,
  model: "gpt-5.6-sol",
  options: [],
} as const;
const REMOTE_PATH = "/remote/workspaces/cocoa";

const TestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "codex-endpoint-text-generation-test",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAttachment(sizeBytes: number) {
  return ChatImageAttachment.make({
    type: "image",
    id: "thread-12345678-1234-1234-1234-123456789abc",
    name: "screenshot.png",
    mimeType: "image/png",
    sizeBytes,
  });
}

const makeHarness = Effect.fn("CodexEndpointTextGeneration.test.makeHarness")(function* (
  responses: ReadonlyArray<string>,
) {
  const requests: Array<CodexEndpointStructuredGenerationInput> = [];
  let responseIndex = 0;
  const structuredGeneration: CodexEndpointStructuredGeneration = {
    generate: (input) =>
      Effect.sync(() => {
        requests.push(input);
        const text = responses[responseIndex++];
        if (text === undefined) throw new Error("Missing fake structured response.");
        return {
          text,
          nativeThreadId: `thread-${responseIndex}`,
          nativeTurnId: `turn-${responseIndex}`,
        };
      }),
  };
  const borrowRoutedConnection = Effect.die(
    "fake structured generation must not borrow",
  ) as CodexEndpointSupervisor["borrowRoutedConnection"];
  let capturedBorrow: CodexEndpointSupervisor["borrowRoutedConnection"] | undefined;
  const textGeneration = yield* makeCodexEndpointTextGeneration(
    { providerInstanceId: INSTANCE_ID, borrowRoutedConnection },
    {
      makeStructuredGeneration: (options) =>
        Effect.sync(() => {
          capturedBorrow = options.borrowRoutedConnection;
          return structuredGeneration;
        }),
    },
  );
  return {
    requests,
    textGeneration,
    borrowRoutedConnection,
    getCapturedBorrow: () => capturedBorrow,
  };
});

it.layer(TestLayer)("CodexEndpointTextGeneration", (it) => {
  it.effect("maps all four prompt/schema/result paths through one endpoint generator", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const serverConfig = yield* ServerConfig;
      const attachment = makeAttachment(5);
      yield* fileSystem.writeFile(
        `${serverConfig.attachmentsDir}/${attachmentRelativePath(attachment)}`,
        new TextEncoder().encode("hello"),
      );
      const harness = yield* makeHarness([
        '{"subject":"Fix endpoint.","body":" body ","branch":"endpoint cleanup"}',
        '{"title":" Endpoint PR ","body":" body "}',
        '{"branch":"Fix Endpoint Images"}',
        '{"title":"  \'Endpoint image title\'  "}',
      ]);

      const commit = yield* harness.textGeneration.generateCommitMessage({
        providerInstanceId: INSTANCE_ID,
        cwd: REMOTE_PATH,
        branch: "main",
        stagedSummary: "M file.ts",
        stagedPatch: "diff",
        includeBranch: true,
        modelSelection: MODEL_SELECTION,
      });
      const pr = yield* harness.textGeneration.generatePrContent({
        providerInstanceId: INSTANCE_ID,
        cwd: REMOTE_PATH,
        baseBranch: "main",
        headBranch: "feature/endpoint",
        commitSummary: "commit",
        diffSummary: "summary",
        diffPatch: "diff",
        modelSelection: MODEL_SELECTION,
      });
      const branch = yield* harness.textGeneration.generateBranchName({
        providerInstanceId: INSTANCE_ID,
        cwd: REMOTE_PATH,
        message: "Fix the screenshot",
        attachments: [attachment],
        modelSelection: MODEL_SELECTION,
      });
      const title = yield* harness.textGeneration.generateThreadTitle({
        providerInstanceId: INSTANCE_ID,
        cwd: REMOTE_PATH,
        message: "Fix the screenshot",
        attachments: [attachment],
        modelSelection: MODEL_SELECTION,
      });

      assert.deepStrictEqual(commit, {
        subject: "Fix endpoint",
        body: "body",
        branch: "feature/endpoint-cleanup",
      });
      assert.deepStrictEqual(pr, { title: "Endpoint PR", body: "body" });
      assert.deepStrictEqual(branch, { branch: "fix-endpoint-images" });
      assert.deepStrictEqual(title, { title: "Endpoint image title" });
      assert.strictEqual(harness.getCapturedBorrow(), harness.borrowRoutedConnection);
      assert.lengthOf(harness.requests, 4);
      for (const request of harness.requests) {
        assert.deepStrictEqual(request.workspace, {
          providerInstanceId: INSTANCE_ID,
          remotePath: REMOTE_PATH,
        });
        assert.strictEqual(request.modelSelection, MODEL_SELECTION);
        assert.equal((request.outputSchema as { type?: string }).type, "object");
      }
      assert.include(harness.requests[0]!.prompt, "git commit messages");
      assert.include(harness.requests[1]!.prompt, "change request content");
      assert.include(harness.requests[2]!.prompt, "git branch names");
      assert.include(harness.requests[3]!.prompt, "thread titles");
      assert.deepStrictEqual(harness.requests[0]!.imageDataUrls, []);
      assert.deepStrictEqual(harness.requests[1]!.imageDataUrls, []);
      assert.deepStrictEqual(harness.requests[2]!.imageDataUrls, [
        "data:image/png;base64,aGVsbG8=",
      ]);
      assert.deepStrictEqual(harness.requests[3]!.imageDataUrls, [
        "data:image/png;base64,aGVsbG8=",
      ]);
    }),
  );

  it.effect("rejects declared attachment aggregates above eight MiB before file access", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(['{"title":"must not run"}']);
      const attachment = makeAttachment(
        Math.ceil((PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES * 3) / 4),
      );

      const result = yield* harness.textGeneration
        .generateThreadTitle({
          providerInstanceId: INSTANCE_ID,
          cwd: REMOTE_PATH,
          message: "title",
          attachments: [attachment],
          modelSelection: MODEL_SELECTION,
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.include(result.failure.detail, "size limit");
      assert.lengthOf(harness.requests, 0);
    }),
  );

  it.effect("rejects ownership mismatches before reading attachments or calling the endpoint", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(['{"title":"must not run"}']);
      const attachment = makeAttachment(1);

      const result = yield* harness.textGeneration
        .generateThreadTitle({
          providerInstanceId: OTHER_INSTANCE_ID,
          cwd: "/sensitive/remote/path",
          message: "title",
          attachments: [attachment],
          modelSelection: MODEL_SELECTION,
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.include(result.failure.detail, "Workspace ownership");
        assert.notInclude(result.failure.detail, "/sensitive/remote/path");
      }
      assert.lengthOf(harness.requests, 0);
    }),
  );

  it.effect("bounded reads reject a managed blob larger than its metadata", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const serverConfig = yield* ServerConfig;
      const attachment = makeAttachment(1);
      yield* fileSystem.writeFile(
        `${serverConfig.attachmentsDir}/${attachmentRelativePath(attachment)}`,
        new Uint8Array(512 * 1024),
      );
      const harness = yield* makeHarness(['{"title":"must not run"}']);

      const result = yield* harness.textGeneration
        .generateThreadTitle({
          providerInstanceId: INSTANCE_ID,
          cwd: REMOTE_PATH,
          message: "title",
          attachments: [attachment],
          modelSelection: MODEL_SELECTION,
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.include(result.failure.detail, "could not be loaded");
      assert.lengthOf(harness.requests, 0);
    }),
  );
});
