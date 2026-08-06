// @effect-diagnostics nodeBuiltinImport:off - Security integration exercises the configured host helper.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import {
  CODEX_WORKSPACE_HELPER_PROTOCOL_VERSION,
  ProviderInstanceId,
  type CodexWorkspaceHelperConfig,
  type CodexWorkspaceHelperRequest,
  type CodexWorkspaceHelperResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  ProviderWorkspaceBrowseMaxEntries,
  ProviderWorkspaceMaxDepth,
  ProviderWorkspaceMaxDirectories,
  ProviderWorkspaceMaxEntries,
  ProviderWorkspaceReadByteLimit,
} from "../ProviderWorkspaceAdapter.ts";
import * as CodexEndpointConnection from "../codexEndpoint/CodexEndpointConnection.ts";
import {
  CodexEndpointBorrowUnavailableError,
  type CodexEndpointConnectionBorrow,
} from "../codexEndpoint/CodexEndpointSupervisor.ts";
import {
  decodeCodexWorkspaceHelperFrame,
  encodeCodexWorkspaceHelperFrame,
  makeCodexWorkspaceAdapter,
} from "./CodexWorkspaceAdapter.ts";
import { CODEX_WORKSPACE_INLINE_PYTHON } from "./CodexWorkspaceInlinePython.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex_workspace_test");
const HELPER = {
  type: "inline-python3-v1" as const,
  executablePath: "/nix/store/python3/bin/python3",
};
const NATIVE_HELPER = {
  type: "cocoa-workspace-helper-v1" as const,
  executablePath: "/run/current-system/sw/bin/cocoa-workspace-helper",
  expectedProtocol: CODEX_WORKSPACE_HELPER_PROTOCOL_VERSION,
};
const ROOT = {
  canonicalRoot: "/srv/project",
  device: "12",
  inode: "34",
} as const;

type CommandExecResponse = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};
type RequestHandler = (
  method: string,
  payload: unknown,
) => Effect.Effect<CommandExecResponse, CodexErrors.CodexAppServerError>;

function success(
  result: Extract<CodexWorkspaceHelperResponse, { readonly ok: true }>["result"],
): CommandExecResponse {
  return {
    exitCode: 0,
    stderr: "",
    stdout: encodeCodexWorkspaceHelperFrame({
      protocol: CODEX_WORKSPACE_HELPER_PROTOCOL_VERSION,
      ok: true,
      result,
    }),
  };
}

function failure(
  code: Extract<CodexWorkspaceHelperResponse, { readonly ok: false }>["error"]["code"],
  message = "sanitized helper error",
): CommandExecResponse {
  return {
    exitCode: 0,
    stderr: "",
    stdout: encodeCodexWorkspaceHelperFrame({
      protocol: CODEX_WORKSPACE_HELPER_PROTOCOL_VERSION,
      ok: false,
      error: { code, message },
    }),
  };
}

function decodeRequest(payload: unknown): CodexWorkspaceHelperRequest {
  assert.isObject(payload);
  const command = (payload as { readonly command: ReadonlyArray<string> }).command;
  return JSON.parse(
    Result.getOrThrow(Encoding.decodeBase64String(command.at(-1)!)),
  ) as CodexWorkspaceHelperRequest;
}

function makeConnection(handler: RequestHandler) {
  const request = ((method: string, payload: unknown) =>
    handler(method, payload)) as CodexClient.CodexAppServerClient["Service"]["request"];
  return CodexEndpointConnection.CodexEndpointConnection.of({
    identity: { providerInstanceId: INSTANCE_ID },
    client: { request } as CodexClient.CodexAppServerClient["Service"],
    compatibility: {
      userAgent: "codex_cli_rs/0.146.0",
      serverVersion: "0.146.0",
      codexHome: "/remote/.codex",
      platformFamily: "unix",
      platformOs: "linux",
    },
    awaitTermination: Effect.never,
  });
}

function makeAdapter(input: {
  readonly handler: RequestHandler;
  readonly helper?: CodexWorkspaceHelperConfig;
  readonly ensureCurrent?: () => Effect.Effect<void, CodexEndpointBorrowUnavailableError>;
  readonly borrow?: Effect.Effect<
    CodexEndpointConnectionBorrow,
    CodexEndpointBorrowUnavailableError
  >;
}) {
  const connection = makeConnection(input.handler);
  let borrows = 0;
  let currentChecks = 0;
  const borrowConnection =
    input.borrow ??
    Effect.sync(() => {
      borrows += 1;
      return {
        generationId: 1,
        connection,
        ensureCurrent: Effect.suspend(() => {
          currentChecks += 1;
          return input.ensureCurrent?.() ?? Effect.void;
        }),
      };
    });
  return {
    adapter: makeCodexWorkspaceAdapter({
      providerInstanceId: INSTANCE_ID,
      helper: input.helper ?? HELPER,
      borrowConnection,
    }),
    counts: () => ({ borrows, currentChecks }),
  };
}

it.effect("uses exact buffered command/exec requests and revalidates root identity per call", () =>
  Effect.gen(function* () {
    const payloads: Array<Record<string, unknown>> = [];
    const requests: Array<CodexWorkspaceHelperRequest> = [];
    const { adapter, counts } = makeAdapter({
      handler: (method, payload) => {
        assert.strictEqual(method, "command/exec");
        payloads.push(payload as Record<string, unknown>);
        const request = decodeRequest(payload);
        requests.push(request);
        switch (request.operation) {
          case "validate":
            return Effect.succeed(
              success({
                operation: "validate",
                root: ROOT,
                metadata: { kind: "directory", modifiedAtMs: 1 },
              }),
            );
          case "stat":
            return Effect.succeed(
              success({
                operation: "stat",
                metadata: { kind: "file", size: 9, modifiedAtMs: 2 },
              }),
            );
          case "list":
            return Effect.succeed(
              success({
                operation: "list",
                entries: [
                  { path: "README.md", kind: "file" },
                  { path: "src", kind: "directory" },
                ],
                truncated: true,
              }),
            );
          case "read":
            return Effect.succeed(
              success({
                operation: "read",
                dataBase64: Encoding.encodeBase64(new TextEncoder().encode("hello")),
                byteLength: 9,
                truncated: true,
              }),
            );
          default:
            return Effect.die("unexpected helper operation");
        }
      },
    });

    const root = yield* adapter.openRoot("/configured/link");
    const metadata = yield* root.getMetadata({ relativePath: "README.md" });
    const listing = yield* root.listDirectory({
      relativePath: "",
      maxEntries: ProviderWorkspaceMaxEntries.make(2),
    });
    const read = yield* root.readFile({
      relativePath: "README.md",
      maxBytes: ProviderWorkspaceReadByteLimit.make(5),
    });

    assert.deepStrictEqual(metadata, { kind: "file", size: 9, modifiedAtMs: 2 });
    assert.deepStrictEqual(listing, {
      entries: [
        { name: "README.md", kind: "file" },
        { name: "src", kind: "directory" },
      ],
      truncated: true,
    });
    assert.strictEqual(new TextDecoder().decode(read.bytes), "hello");
    assert.strictEqual(read.byteLength, 9);
    assert.isTrue(read.truncated);
    assert.deepStrictEqual(counts(), { borrows: 4, currentChecks: 8 });

    for (const payload of payloads) {
      assert.deepStrictEqual(Object.keys(payload).sort(), [
        "command",
        "outputBytesCap",
        "sandboxPolicy",
        "timeoutMs",
      ]);
      const command = payload.command as ReadonlyArray<string>;
      assert.deepStrictEqual(command.slice(0, 5), [
        HELPER.executablePath,
        "-I",
        "-S",
        "-c",
        CODEX_WORKSPACE_INLINE_PYTHON,
      ]);
      assert.deepStrictEqual(payload.sandboxPolicy, { type: "readOnly", networkAccess: false });
      assert.strictEqual(payload.timeoutMs, 10_000);
      assert.isAbove(payload.outputBytesCap as number, 0);
    }
    for (const request of requests.slice(1)) {
      if (
        request.operation === "stat" ||
        request.operation === "list" ||
        request.operation === "read"
      ) {
        assert.deepStrictEqual(request.expectedRoot, ROOT);
        assert.strictEqual(request.root, ROOT.canonicalRoot);
      }
    }
    assert.deepStrictEqual(requests[2], {
      protocol: 1,
      operation: "list",
      root: ROOT.canonicalRoot,
      expectedRoot: ROOT,
      relativePath: "",
      limits: {
        maxEntries: 2,
        maxDepth: 1,
        maxDirectories: 1,
        maxResponseBytes: 8 * 1024 * 1024,
      },
    });
  }),
);

it.effect("enforces generation barriers before and after command execution", () =>
  Effect.gen(function* () {
    const unavailable = new CodexEndpointBorrowUnavailableError({
      providerInstanceId: INSTANCE_ID,
    });
    for (const helper of [HELPER, NATIVE_HELPER]) {
      let requestCalls = 0;
      const pre = makeAdapter({
        helper,
        handler: () => {
          requestCalls += 1;
          return Effect.die("must not request");
        },
        ensureCurrent: () => Effect.fail(unavailable),
      });
      const preError = yield* pre.adapter.openRoot("/srv/project").pipe(Effect.flip);
      assert.strictEqual(preError._tag, "ProviderWorkspaceDisconnectedError");
      assert.strictEqual(requestCalls, 0);

      let checks = 0;
      const post = makeAdapter({
        helper,
        handler: () =>
          Effect.succeed(
            success({
              operation: "validate",
              root: ROOT,
              metadata: { kind: "directory" },
            }),
          ),
        ensureCurrent: () => {
          checks += 1;
          return checks === 1 ? Effect.void : Effect.fail(unavailable);
        },
      });
      const postError = yield* post.adapter.openRoot("/srv/project").pipe(Effect.flip);
      assert.strictEqual(postError._tag, "ProviderWorkspaceDisconnectedError");
    }
  }),
);

it.effect("invokes the packaged native helper without Python flags or an inline script", () =>
  Effect.gen(function* () {
    const commands: Array<ReadonlyArray<string>> = [];
    const { adapter, counts } = makeAdapter({
      helper: NATIVE_HELPER,
      handler: (_method, payload) => {
        const command = (payload as { readonly command: ReadonlyArray<string> }).command;
        commands.push(command);
        const request = decodeRequest(payload);
        switch (request.operation) {
          case "validate":
            return Effect.succeed(
              success({
                operation: "validate",
                root: ROOT,
                metadata: { kind: "directory" },
              }),
            );
          case "stat":
            return Effect.succeed(
              success({ operation: "stat", metadata: { kind: "file", size: 5 } }),
            );
          case "list":
            return Effect.succeed(
              success({
                operation: "list",
                entries: [{ path: "README.md", kind: "file" }],
                truncated: false,
              }),
            );
          case "read":
            return Effect.succeed(
              success({
                operation: "read",
                dataBase64: Encoding.encodeBase64(new TextEncoder().encode("hello")),
                byteLength: 5,
                truncated: false,
              }),
            );
          default:
            return Effect.die("unexpected helper operation");
        }
      },
    });

    const root = yield* adapter.openRoot("/srv/project");
    yield* root.getMetadata({ relativePath: "README.md" });
    yield* root.listDirectory({
      relativePath: "",
      maxEntries: ProviderWorkspaceMaxEntries.make(1),
    });
    yield* root.readFile({
      relativePath: "README.md",
      maxBytes: ProviderWorkspaceReadByteLimit.make(5),
    });

    assert.deepStrictEqual(counts(), { borrows: 4, currentChecks: 8 });
    assert.strictEqual(commands.length, 4);
    for (const command of commands) {
      assert.strictEqual(command.length, 2);
      assert.strictEqual(command[0], NATIVE_HELPER.executablePath);
      assert.notInclude(command, "-I");
      assert.notInclude(command, "-S");
      assert.notInclude(command, "-c");
      assert.notInclude(command, CODEX_WORKSPACE_INLINE_PYTHON);
      assert.deepStrictEqual(decodeRequest({ command }).protocol, 1);
    }
  }),
);

it.effect("sends identical bounded recursive list requests to inline and native helpers", () =>
  Effect.gen(function* () {
    const requests = new Map<string, CodexWorkspaceHelperRequest>();
    const run = (helper: CodexWorkspaceHelperConfig) => {
      const { adapter } = makeAdapter({
        helper,
        handler: (_method, payload) => {
          const request = decodeRequest(payload);
          if (request.operation === "validate") {
            return Effect.succeed(
              success({
                operation: "validate",
                root: ROOT,
                metadata: { kind: "directory" },
              }),
            );
          }
          if (request.operation !== "list") return Effect.die("unexpected helper operation");
          requests.set(helper.type, request);
          return Effect.succeed(
            success({
              operation: "list",
              entries: [
                { path: "src", kind: "directory" },
                { path: "src/index.ts", kind: "file" },
                { path: "vendor-link", kind: "symlink" },
              ],
              truncated: true,
            }),
          );
        },
      });
      return Effect.gen(function* () {
        const root = yield* adapter.openRoot("/srv/project");
        return yield* root.listEntries({
          relativePath: "packages/app",
          maxEntries: ProviderWorkspaceMaxEntries.make(30),
          maxDepth: ProviderWorkspaceMaxDepth.make(4),
          maxDirectories: ProviderWorkspaceMaxDirectories.make(7),
        });
      });
    };

    const inline = yield* run(HELPER);
    const native = yield* run(NATIVE_HELPER);
    assert.deepStrictEqual(native, inline);
    assert.deepStrictEqual(
      requests.get("cocoa-workspace-helper-v1"),
      requests.get("inline-python3-v1"),
    );
    assert.deepStrictEqual(requests.get("inline-python3-v1"), {
      protocol: 1,
      operation: "list",
      root: ROOT.canonicalRoot,
      expectedRoot: ROOT,
      relativePath: "packages/app",
      limits: {
        maxEntries: 30,
        maxDepth: 4,
        maxDirectories: 7,
        maxResponseBytes: 8 * 1024 * 1024,
      },
    });
  }),
);

it.effect(
  "sends provider-scoped browse requests with native/inline parity and no root traversal",
  () =>
    Effect.gen(function* () {
      const requests = new Map<string, Array<CodexWorkspaceHelperRequest>>();
      const run = (helper: CodexWorkspaceHelperConfig) => {
        const helperRequests: Array<CodexWorkspaceHelperRequest> = [];
        requests.set(helper.type, helperRequests);
        const { adapter } = makeAdapter({
          helper,
          handler: (_method, payload) => {
            const request = decodeRequest(payload);
            helperRequests.push(request);
            if (request.operation === "probe") {
              return Effect.succeed(
                success({
                  operation: "probe",
                  implementation: "test-helper",
                  capabilities: ["probe", "validate", "stat", "list", "read", "browse"],
                }),
              );
            }
            if (request.operation !== "browse") return Effect.die("unexpected helper operation");
            const directoryPath =
              request.locator.kind === "absolute"
                ? request.locator.path
                : `/home/test/${request.locator.relativePath}`;
            return Effect.succeed(
              success({
                operation: "browse",
                directoryPath,
                parentPath:
                  directoryPath === "/"
                    ? null
                    : directoryPath.slice(0, directoryPath.lastIndexOf("/")) || "/",
                entries: [{ name: "project", kind: "directory" }],
                truncated: false,
              }),
            );
          },
        });
        return Effect.gen(function* () {
          const browse = adapter.browseDirectory;
          assert.isDefined(browse);
          const absolute = yield* browse!({
            locator: { kind: "absolute", path: "/" },
            maxEntries: ProviderWorkspaceBrowseMaxEntries.make(10),
          });
          const home = yield* browse!({
            locator: { kind: "home", relativePath: "Developer" },
            maxEntries: ProviderWorkspaceBrowseMaxEntries.make(20),
          });
          return { absolute, home };
        });
      };

      const inline = yield* run(HELPER);
      const native = yield* run(NATIVE_HELPER);
      assert.deepStrictEqual(native, inline);
      assert.deepStrictEqual(inline.absolute, {
        directoryPath: "/",
        parentPath: null,
        entries: [{ name: "project", kind: "directory" }],
        truncated: false,
      });
      assert.strictEqual(inline.home.directoryPath, "/home/test/Developer");

      const inlineRequests = requests.get("inline-python3-v1")!;
      const nativeRequests = requests.get("cocoa-workspace-helper-v1")!;
      assert.deepStrictEqual(nativeRequests, inlineRequests);
      assert.deepStrictEqual(
        inlineRequests.map((request) => request.operation),
        ["probe", "browse", "browse"],
      );
      assert.deepStrictEqual(inlineRequests[1], {
        protocol: 1,
        operation: "browse",
        locator: { kind: "absolute", path: "/" },
        maxEntries: 10,
        maxResponseBytes: 4 * 1024 * 1024,
      });
      assert.isFalse(
        inlineRequests.some((request) => request.operation === "validate" || "root" in request),
        "browse must not emulate host traversal by opening a workspace root",
      );
    }),
);

it.effect("returns typed unsupported for legacy probes and unavailable command execution", () =>
  Effect.gen(function* () {
    let legacyCalls = 0;
    const legacy = makeAdapter({
      handler: (_method, payload) => {
        legacyCalls += 1;
        const request = decodeRequest(payload);
        if (request.operation !== "probe") return Effect.die("unexpected helper operation");
        return Effect.succeed(
          success({
            operation: "probe",
            implementation: "legacy-helper",
            capabilities: ["probe", "validate", "stat", "list", "read"],
          }),
        );
      },
    });
    for (let index = 0; index < 2; index += 1) {
      const error = yield* legacy.adapter.browseDirectory!({
        locator: { kind: "home", relativePath: "" },
        maxEntries: ProviderWorkspaceBrowseMaxEntries.make(10),
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ProviderWorkspaceUnsupportedError");
      assert.strictEqual(error.operation, "browseDirectory");
    }
    assert.strictEqual(legacyCalls, 1, "legacy capability result is cached per generation");

    const unavailable = makeAdapter({
      handler: () =>
        Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound("command/exec")),
    });
    const unavailableError = yield* unavailable.adapter.browseDirectory!({
      locator: { kind: "absolute", path: "/srv" },
      maxEntries: ProviderWorkspaceBrowseMaxEntries.make(1),
    }).pipe(Effect.flip);
    assert.strictEqual(unavailableError._tag, "ProviderWorkspaceUnsupportedError");
    assert.strictEqual(unavailableError.operation, "browseDirectory");
  }),
);

it.effect("re-probes browse capability after a disconnected endpoint generation", () =>
  Effect.gen(function* () {
    const unavailable = new CodexEndpointBorrowUnavailableError({
      providerInstanceId: INSTANCE_ID,
    });
    let currentGeneration = 1;
    let disconnectFirstBrowse = true;
    let probes = 0;
    const connection = makeConnection((_method, payload) => {
      const request = decodeRequest(payload);
      if (request.operation === "probe") {
        probes += 1;
        return Effect.succeed(
          success({
            operation: "probe",
            implementation: "test-helper",
            capabilities: ["probe", "validate", "stat", "list", "read", "browse"],
          }),
        );
      }
      if (request.operation !== "browse") return Effect.die("unexpected helper operation");
      if (disconnectFirstBrowse) {
        disconnectFirstBrowse = false;
        currentGeneration = 2;
      }
      return Effect.succeed(
        success({
          operation: "browse",
          directoryPath: "/srv",
          parentPath: "/",
          entries: [],
          truncated: false,
        }),
      );
    });
    const { adapter } = makeAdapter({
      handler: () => Effect.die("unused"),
      borrow: Effect.sync(() => {
        const generationId = currentGeneration;
        return {
          generationId,
          connection,
          ensureCurrent: Effect.suspend(() =>
            generationId === currentGeneration ? Effect.void : Effect.fail(unavailable),
          ),
        };
      }),
    });
    const input = {
      locator: { kind: "absolute" as const, path: "/srv" },
      maxEntries: ProviderWorkspaceBrowseMaxEntries.make(5),
    };
    const disconnectedError = yield* adapter.browseDirectory!(input).pipe(Effect.flip);
    assert.strictEqual(disconnectedError._tag, "ProviderWorkspaceDisconnectedError");
    assert.deepStrictEqual(yield* adapter.browseDirectory!(input), {
      directoryPath: "/srv",
      parentPath: "/",
      entries: [],
      truncated: false,
    });
    yield* adapter.browseDirectory!(input);
    assert.strictEqual(probes, 2, "each endpoint generation is probed once");
  }),
);

it.effect("rejects browse results that exceed bounds or violate direct-entry invariants", () =>
  Effect.gen(function* () {
    for (const entries of [
      [
        { name: "one", kind: "file" as const },
        { name: "two", kind: "file" as const },
      ],
      [
        { name: "duplicate", kind: "file" as const },
        { name: "duplicate", kind: "directory" as const },
      ],
    ]) {
      const { adapter } = makeAdapter({
        handler: (_method, payload) => {
          const request = decodeRequest(payload);
          return Effect.succeed(
            request.operation === "probe"
              ? success({
                  operation: "probe",
                  implementation: "test-helper",
                  capabilities: ["probe", "browse"],
                })
              : success({
                  operation: "browse",
                  directoryPath: "/srv",
                  parentPath: "/",
                  entries,
                  truncated: false,
                }),
          );
        },
      });
      const error = yield* adapter.browseDirectory!({
        locator: { kind: "absolute", path: "/srv" },
        maxEntries: ProviderWorkspaceBrowseMaxEntries.make(1),
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ProviderWorkspaceProtocolError");
    }
  }),
);

it.effect("rejects recursive helper entries outside the requested depth or normalized shape", () =>
  Effect.gen(function* () {
    for (const path of ["nested/too/deep", "nested//invalid", "../outside", "\\windows"]) {
      const { adapter } = makeAdapter({
        handler: (_method, payload) => {
          const request = decodeRequest(payload);
          return Effect.succeed(
            request.operation === "validate"
              ? success({
                  operation: "validate",
                  root: ROOT,
                  metadata: { kind: "directory" },
                })
              : success({
                  operation: "list",
                  entries: [{ path, kind: "file" }],
                  truncated: false,
                }),
          );
        },
      });
      const root = yield* adapter.openRoot("/srv/project");
      const result = yield* root
        .listEntries({
          relativePath: "",
          maxEntries: ProviderWorkspaceMaxEntries.make(10),
          maxDepth: ProviderWorkspaceMaxDepth.make(2),
          maxDirectories: ProviderWorkspaceMaxDirectories.make(2),
        })
        .pipe(Effect.flip);
      assert.strictEqual(result._tag, "ProviderWorkspaceProtocolError");
    }
  }),
);

it.effect("normalizes RPC, framing, process, and helper-domain failures", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<{
      readonly response: Effect.Effect<CommandExecResponse, CodexErrors.CodexAppServerError>;
      readonly expected: string;
    }> = [
      {
        response: Effect.fail(
          CodexErrors.CodexAppServerRequestError.methodNotFound("command/exec"),
        ),
        expected: "ProviderWorkspaceUnsupportedError",
      },
      {
        response: Effect.succeed({ exitCode: 0, stderr: "", stdout: "malformed" }),
        expected: "ProviderWorkspaceProtocolError",
      },
      {
        response: Effect.succeed({
          exitCode: 0,
          stderr: "",
          stdout: `${encodeCodexWorkspaceHelperFrame({ protocol: 1 }).slice(0, -1)}x`,
        }),
        expected: "ProviderWorkspaceProtocolError",
      },
      {
        response: Effect.succeed({ exitCode: 1, stderr: "SECRET", stdout: "" }),
        expected: "ProviderWorkspaceOperationError",
      },
      {
        response: Effect.succeed({ exitCode: 127, stderr: "SECRET", stdout: "" }),
        expected: "ProviderWorkspaceUnsupportedError",
      },
      {
        response: Effect.succeed(failure("path_is_symlink", "SECRET remote path")),
        expected: "ProviderWorkspacePathError",
      },
    ];

    for (const testCase of cases) {
      const { adapter } = makeAdapter({ handler: () => testCase.response });
      const error = yield* adapter.openRoot("/srv/project").pipe(Effect.flip);
      assert.strictEqual(error._tag, testCase.expected);
      assert.notInclude(error.message, "SECRET");
    }
  }),
);

it("confines the inline Python helper with descriptors and enforces read/list bounds", () => {
  const python = process.env.COCOA_TEST_PYTHON3 ?? "python3";
  if (NodeChildProcess.spawnSync(python, ["--version"], { encoding: "utf8" }).status !== 0) return;

  // macOS reports its temp directory through `/var`, which is an ambient
  // symlink to `/private/var`. The helper deliberately rejects every symlink
  // component supplied by a caller, so build the fixture under the canonical
  // host path instead of weakening the containment contract for a platform
  // alias outside the provider workspace.
  const canonicalTempRoot = NodeFS.realpathSync(NodeOS.tmpdir());
  const temporary = NodeFS.mkdtempSync(
    NodePath.join(canonicalTempRoot, "cocoa-workspace-helper-"),
  );
  try {
    const workspace = NodePath.join(temporary, "workspace");
    const outside = NodePath.join(temporary, "outside");
    const workspaceLink = NodePath.join(temporary, "workspace-link");
    NodeFS.mkdirSync(workspace);
    NodeFS.mkdirSync(outside);
    NodeFS.writeFileSync(NodePath.join(workspace, "alpha.txt"), "0123456789", "utf8");
    NodeFS.writeFileSync(NodePath.join(workspace, "beta.txt"), "beta", "utf8");
    NodeFS.mkdirSync(NodePath.join(workspace, "tree", "deep"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(workspace, "tree", "child.txt"), "child", "utf8");
    NodeFS.writeFileSync(
      NodePath.join(workspace, "tree", "deep", "grandchild.txt"),
      "grandchild",
      "utf8",
    );
    NodeFS.writeFileSync(NodePath.join(outside, "secret.txt"), "secret", "utf8");
    NodeFS.symlinkSync(outside, NodePath.join(workspace, "escape"));
    NodeFS.symlinkSync(workspace, workspaceLink);

    const run = (
      request: unknown,
      environment: NodeJS.ProcessEnv = process.env,
    ): CodexWorkspaceHelperResponse => {
      const encoded = Encoding.encodeBase64(new TextEncoder().encode(JSON.stringify(request)));
      const child = NodeChildProcess.spawnSync(
        python,
        ["-I", "-S", "-c", CODEX_WORKSPACE_INLINE_PYTHON, encoded],
        { encoding: "utf8", env: environment },
      );
      assert.strictEqual(child.status, 0, child.stderr);
      assert.strictEqual(child.stderr, "");
      return decodeCodexWorkspaceHelperFrame(child.stdout) as CodexWorkspaceHelperResponse;
    };

    const probe = run({ protocol: 1, operation: "probe" });
    assert.isTrue(probe.ok);
    if (!probe.ok || probe.result.operation !== "probe") {
      return assert.fail("expected probe result");
    }
    assert.include(probe.result.capabilities, "browse");

    const browse = (
      locator: Extract<CodexWorkspaceHelperRequest, { readonly operation: "browse" }>["locator"],
      maxEntries = 100,
      maxResponseBytes = 1024 * 1024,
      environment: NodeJS.ProcessEnv = process.env,
    ) =>
      run(
        {
          protocol: 1,
          operation: "browse",
          locator,
          maxEntries,
          maxResponseBytes,
        },
        environment,
      );

    const rootBrowse = browse({ kind: "absolute", path: "/" }, 1);
    assert.isTrue(rootBrowse.ok);
    if (!rootBrowse.ok || rootBrowse.result.operation !== "browse") {
      return assert.fail("expected root browse result");
    }
    assert.strictEqual(rootBrowse.result.directoryPath, "/");
    assert.isNull(rootBrowse.result.parentPath);

    const directBrowse = browse({ kind: "absolute", path: workspace });
    assert.isTrue(directBrowse.ok);
    if (!directBrowse.ok || directBrowse.result.operation !== "browse") {
      return assert.fail("expected direct browse result");
    }
    assert.strictEqual(directBrowse.result.directoryPath, workspace);
    assert.strictEqual(directBrowse.result.parentPath, temporary);
    assert.deepInclude(directBrowse.result.entries, { name: "escape", kind: "symlink" });
    assert.deepInclude(directBrowse.result.entries, { name: "tree", kind: "directory" });
    assert.isFalse(directBrowse.result.entries.some((entry) => entry.name === "child.txt"));

    const homeBrowse = browse({ kind: "home", relativePath: "tree" }, 100, 1024 * 1024, {
      ...process.env,
      HOME: workspace,
    });
    assert.isTrue(homeBrowse.ok);
    if (!homeBrowse.ok || homeBrowse.result.operation !== "browse") {
      return assert.fail("expected home browse result");
    }
    assert.strictEqual(homeBrowse.result.directoryPath, NodePath.join(workspace, "tree"));
    assert.strictEqual(homeBrowse.result.parentPath, workspace);

    const symlinkBrowse = browse({ kind: "absolute", path: NodePath.join(workspace, "escape") });
    assert.isFalse(symlinkBrowse.ok);
    if (!symlinkBrowse.ok) assert.strictEqual(symlinkBrowse.error.code, "path_is_symlink");

    const invalidPathBrowse = browse({
      kind: "absolute",
      path: `${workspace}/../outside`,
    } as never);
    assert.isFalse(invalidPathBrowse.ok);
    if (!invalidPathBrowse.ok) assert.strictEqual(invalidPathBrowse.error.code, "invalid_path");

    const withoutHome = { ...process.env };
    delete withoutHome.HOME;
    const missingHomeBrowse = browse({ kind: "home", relativePath: "" }, 100, 1024, withoutHome);
    assert.isFalse(missingHomeBrowse.ok);
    if (!missingHomeBrowse.ok) assert.strictEqual(missingHomeBrowse.error.code, "invalid_root");

    const invalidHomeBrowse = browse({ kind: "home", relativePath: "" }, 100, 1024, {
      ...process.env,
      HOME: "relative/home",
    });
    assert.isFalse(invalidHomeBrowse.ok);
    if (!invalidHomeBrowse.ok) assert.strictEqual(invalidHomeBrowse.error.code, "invalid_root");

    const homeTraversalBrowse = browse(
      { kind: "home", relativePath: "../outside" } as never,
      100,
      1024,
      { ...process.env, HOME: workspace },
    );
    assert.isFalse(homeTraversalBrowse.ok);
    if (!homeTraversalBrowse.ok) {
      assert.strictEqual(homeTraversalBrowse.error.code, "invalid_path");
    }

    const entryBoundBrowse = browse({ kind: "absolute", path: workspace }, 1);
    assert.isTrue(entryBoundBrowse.ok);
    if (!entryBoundBrowse.ok || entryBoundBrowse.result.operation !== "browse") {
      return assert.fail("expected bounded browse result");
    }
    assert.strictEqual(entryBoundBrowse.result.entries.length, 1);
    assert.isTrue(entryBoundBrowse.result.truncated);

    for (const prefix of ["long-alpha-", "long-beta-"]) {
      NodeFS.writeFileSync(NodePath.join(workspace, `${prefix}${"x".repeat(180)}`), "x");
    }
    const responseBoundBrowse = browse({ kind: "absolute", path: workspace }, 100, 512);
    assert.isTrue(responseBoundBrowse.ok);
    if (!responseBoundBrowse.ok || responseBoundBrowse.result.operation !== "browse") {
      return assert.fail("expected response-bounded browse result");
    }
    assert.isTrue(responseBoundBrowse.result.truncated);
    assert.isBelow(
      responseBoundBrowse.result.entries.length,
      directBrowse.result.entries.length + 2,
    );
    assert.isAtMost(new TextEncoder().encode(JSON.stringify(responseBoundBrowse)).byteLength, 512);

    let createdNonUtf8Entry = false;
    try {
      const invalidName = Buffer.concat([
        Buffer.from(`${workspace}/invalid-`, "utf8"),
        Buffer.from([0xff]),
      ]);
      NodeFS.writeFileSync(invalidName, "x");
      createdNonUtf8Entry = true;
    } catch (error) {
      assert.instanceOf(error, Error);
    }
    if (createdNonUtf8Entry) {
      const nonUtf8Browse = browse({ kind: "absolute", path: workspace });
      assert.isFalse(nonUtf8Browse.ok);
      if (!nonUtf8Browse.ok) {
        assert.strictEqual(nonUtf8Browse.error.code, "operation_failed");
      }
    }

    const validated = run({ protocol: 1, operation: "validate", root: workspaceLink });
    assert.isTrue(validated.ok);
    if (!validated.ok || validated.result.operation !== "validate") {
      return assert.fail("expected validate result");
    }
    assert.strictEqual(validated.result.root.canonicalRoot, workspace);
    const root = validated.result.root;

    const listing = run({
      protocol: 1,
      operation: "list",
      root: workspace,
      expectedRoot: root,
      relativePath: "",
      limits: {
        maxEntries: 1,
        maxDepth: 1,
        maxDirectories: 1,
        maxResponseBytes: 1024 * 1024,
      },
    });
    assert.isTrue(listing.ok);
    if (!listing.ok || listing.result.operation !== "list") {
      return assert.fail("expected list result");
    }
    assert.strictEqual(listing.result.entries.length, 1);
    assert.isTrue(listing.result.truncated);

    const recursiveList = (relativePath: string, maxDepth: number, maxDirectories = 100) =>
      run({
        protocol: 1,
        operation: "list",
        root: workspace,
        expectedRoot: root,
        relativePath,
        limits: {
          maxEntries: 100,
          maxDepth,
          maxDirectories,
          maxResponseBytes: 1024 * 1024,
        },
      });
    const paths = (response: CodexWorkspaceHelperResponse): ReadonlyArray<string> => {
      assert.isTrue(response.ok);
      if (!response.ok || response.result.operation !== "list") {
        assert.fail("expected recursive list result");
      }
      return response.result.entries.map((entry) => entry.path);
    };

    const depthZero = recursiveList("", 0);
    assert.deepStrictEqual(paths(depthZero), []);
    if (depthZero.ok && depthZero.result.operation === "list") {
      assert.isFalse(depthZero.result.truncated);
    }
    const depthOnePaths = paths(recursiveList("", 1));
    assert.include(depthOnePaths, "tree");
    assert.notInclude(depthOnePaths, "tree/child.txt");
    const depthTwoPaths = paths(recursiveList("", 2));
    assert.include(depthTwoPaths, "tree/child.txt");
    assert.include(depthTwoPaths, "tree/deep");
    assert.notInclude(depthTwoPaths, "tree/deep/grandchild.txt");

    const relativePaths = paths(recursiveList("tree", 2));
    assert.deepStrictEqual(relativePaths, ["child.txt", "deep", "deep/grandchild.txt"]);

    const directoryBound = recursiveList("", 4, 2);
    const directoryBoundPaths = paths(directoryBound);
    if (directoryBound.ok && directoryBound.result.operation === "list") {
      assert.isTrue(directoryBound.result.truncated);
    }
    assert.include(directoryBoundPaths, "escape");
    assert.include(directoryBoundPaths, "tree/child.txt");
    assert.notInclude(directoryBoundPaths, "tree/deep/grandchild.txt");
    assert.isFalse(directoryBoundPaths.some((path) => path.includes("secret")));

    const read = run({
      protocol: 1,
      operation: "read",
      root: workspace,
      expectedRoot: root,
      relativePath: "alpha.txt",
      maxBytes: 5,
    });
    assert.isTrue(read.ok);
    if (!read.ok || read.result.operation !== "read") {
      return assert.fail("expected read result");
    }
    assert.strictEqual(
      Result.getOrThrow(Encoding.decodeBase64String(read.result.dataBase64)),
      "01234",
    );
    assert.strictEqual(read.result.byteLength, 10);
    assert.isTrue(read.result.truncated);

    const traversal = run({
      protocol: 1,
      operation: "stat",
      root: workspace,
      expectedRoot: root,
      relativePath: "../outside/secret.txt",
    });
    assert.isFalse(traversal.ok);
    if (!traversal.ok) assert.strictEqual(traversal.error.code, "invalid_path");

    const symlinkTraversal = run({
      protocol: 1,
      operation: "stat",
      root: workspace,
      expectedRoot: root,
      relativePath: "escape/secret.txt",
    });
    assert.isFalse(symlinkTraversal.ok);
    if (!symlinkTraversal.ok) {
      assert.strictEqual(symlinkTraversal.error.code, "path_is_symlink");
    }

    NodeFS.renameSync(workspace, `${workspace}-old`);
    NodeFS.mkdirSync(workspace);
    const replaced = run({
      protocol: 1,
      operation: "stat",
      root: workspace,
      expectedRoot: root,
      relativePath: "",
    });
    assert.isFalse(replaced.ok);
    if (!replaced.ok) assert.strictEqual(replaced.error.code, "invalid_root");
  } finally {
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
});
