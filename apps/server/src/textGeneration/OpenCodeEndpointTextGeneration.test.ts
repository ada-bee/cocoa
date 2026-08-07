import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, OpenCodeSettings } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import {
  OpenCodeRuntimeError,
  type OpenCodeEndpointRuntimeShape,
} from "../provider/OpenCodeEndpointRuntime.ts";
import { makeOpenCodeEndpointTextGeneration } from "./OpenCodeEndpointTextGeneration.ts";

const INSTANCE_ID = ProviderInstanceId.make("remote_opencode");
const settings = Schema.decodeSync(OpenCodeSettings)({
  serverUrl: "https://opencode.example.test",
  serverPassword: "secret",
});

const state = {
  directories: [] as string[],
  prompts: [] as Array<Record<string, unknown>>,
};

const runtime: OpenCodeEndpointRuntimeShape = {
  connectToOpenCodeServer: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "connectToOpenCodeServer",
        detail: "text generation must not manage the endpoint",
      }),
    ),
  createOpenCodeSdkClient: ({ directory }) => {
    state.directories.push(directory ?? "<missing-directory>");
    return {
      session: {
        create: async () => ({ data: { id: "session-1" } }),
        prompt: async (input: Record<string, unknown>) => {
          state.prompts.push(input);
          return {
            data: {
              parts: [
                {
                  type: "text",
                  text: JSON.stringify(
                    "parts" in input &&
                      Array.isArray(input.parts) &&
                      input.parts.some(
                        (part) => typeof part === "object" && part !== null && "url" in part,
                      )
                      ? { title: "Endpoint attachment title" }
                      : { subject: "Use the endpoint", body: "Never spawn OpenCode." },
                  ),
                },
              ],
            },
          };
        },
      },
    } as never;
  },
  loadOpenCodeInventory: () =>
    Effect.fail(new OpenCodeRuntimeError({ operation: "loadOpenCodeInventory", detail: "unused" })),
};

const TestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "cocoa-opencode-endpoint-text-generation-test",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(TestLayer)("OpenCodeEndpointTextGeneration", (it) => {
  it.effect("uses the configured daemon and the remote workspace path", () =>
    Effect.gen(function* () {
      state.directories.length = 0;
      state.prompts.length = 0;
      const service = yield* makeOpenCodeEndpointTextGeneration(INSTANCE_ID, settings, {
        runtime,
      });
      const result = yield* service.generateCommitMessage({
        providerInstanceId: INSTANCE_ID,
        cwd: "/remote/worktree",
        branch: "feature/endpoint",
        stagedSummary: "M src/index.ts",
        stagedPatch: "diff --git a/src/index.ts b/src/index.ts",
        modelSelection: { instanceId: INSTANCE_ID, model: "openai/gpt-5" },
      });

      assert.deepStrictEqual(result, {
        subject: "Use the endpoint",
        body: "Never spawn OpenCode.",
      });
      assert.deepStrictEqual(state.directories, ["/remote/worktree"]);
      assert.deepStrictEqual(state.prompts[0]?.model, {
        providerID: "openai",
        modelID: "gpt-5",
      });
    }),
  );

  it.effect("sends gateway-managed images as data URLs instead of file URLs", () =>
    Effect.gen(function* () {
      state.prompts.length = 0;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const attachment = {
        type: "image" as const,
        id: "endpoint-image",
        name: "endpoint.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      const path = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      assert.isNotNull(path);
      yield* fileSystem.writeFile(path!, new Uint8Array([1, 2, 3]));

      const service = yield* makeOpenCodeEndpointTextGeneration(INSTANCE_ID, settings, {
        runtime,
      });
      const result = yield* service.generateThreadTitle({
        providerInstanceId: INSTANCE_ID,
        cwd: "/remote/worktree",
        message: "Use this image",
        attachments: [attachment],
        modelSelection: { instanceId: INSTANCE_ID, model: "openai/gpt-5" },
      });

      assert.deepStrictEqual(result, { title: "Endpoint attachment title" });
      const promptParts = state.prompts[0]?.parts as Array<{ readonly url?: string }>;
      const attachmentUrl = promptParts.find((part) => part.url !== undefined)?.url;
      assert.strictEqual(attachmentUrl, "data:image/png;base64,AQID");
      assert.notMatch(attachmentUrl!, /^file:/);
    }),
  );

  it.effect("rejects cross-instance model selection before an SDK request", () =>
    Effect.gen(function* () {
      state.prompts.length = 0;
      const service = yield* makeOpenCodeEndpointTextGeneration(INSTANCE_ID, settings, {
        runtime,
      });
      const error = yield* service
        .generateThreadTitle({
          providerInstanceId: INSTANCE_ID,
          cwd: "/remote/worktree",
          message: "Title me",
          modelSelection: {
            instanceId: ProviderInstanceId.make("another_instance"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);

      assert.match(error.detail, /ownership does not match/i);
      assert.lengthOf(state.prompts, 0);
    }),
  );
});
