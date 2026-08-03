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

  const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cocoa-workspace-helper-"));
  try {
    const workspace = NodePath.join(temporary, "workspace");
    const outside = NodePath.join(temporary, "outside");
    const workspaceLink = NodePath.join(temporary, "workspace-link");
    NodeFS.mkdirSync(workspace);
    NodeFS.mkdirSync(outside);
    NodeFS.writeFileSync(NodePath.join(workspace, "alpha.txt"), "0123456789", "utf8");
    NodeFS.writeFileSync(NodePath.join(workspace, "beta.txt"), "beta", "utf8");
    NodeFS.writeFileSync(NodePath.join(outside, "secret.txt"), "secret", "utf8");
    NodeFS.symlinkSync(outside, NodePath.join(workspace, "escape"));
    NodeFS.symlinkSync(workspace, workspaceLink);

    const run = (request: unknown): CodexWorkspaceHelperResponse => {
      const encoded = Encoding.encodeBase64(new TextEncoder().encode(JSON.stringify(request)));
      const child = NodeChildProcess.spawnSync(
        python,
        ["-I", "-S", "-c", CODEX_WORKSPACE_INLINE_PYTHON, encoded],
        { encoding: "utf8" },
      );
      assert.strictEqual(child.status, 0, child.stderr);
      assert.strictEqual(child.stderr, "");
      return decodeCodexWorkspaceHelperFrame(child.stdout) as CodexWorkspaceHelperResponse;
    };

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
