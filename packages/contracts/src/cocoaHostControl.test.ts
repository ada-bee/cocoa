import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  COCOA_HOST_CONTROL_MAX_COMMIT_MESSAGE_BYTES,
  COCOA_HOST_CONTROL_MAX_DIFF_BYTES,
  COCOA_HOST_CONTROL_MAX_TERMINAL_WRITE_BYTES,
  CocoaHostControlEvent,
  CocoaHostControlHandshakeFrame,
  CocoaHostControlHandshakeRequest,
  CocoaHostControlHandshakeResponse,
  CocoaHostTerminalRequest,
  CocoaHostVcsRequest,
  CocoaHostVcsResponse,
  CocoaHostWorkspaceRequest,
  CocoaHostWorkspaceResponse,
} from "./cocoaHostControl.ts";

const decodeHandshakeRequest = Schema.decodeUnknownSync(CocoaHostControlHandshakeRequest);
const decodeHandshakeResponse = Schema.decodeUnknownSync(CocoaHostControlHandshakeResponse);
const decodeHandshakeFrame = Schema.decodeUnknownSync(CocoaHostControlHandshakeFrame);
const decodeWorkspaceRequest = Schema.decodeUnknownSync(CocoaHostWorkspaceRequest);
const decodeWorkspaceResponse = Schema.decodeUnknownSync(CocoaHostWorkspaceResponse);
const decodeVcsRequest = Schema.decodeUnknownSync(CocoaHostVcsRequest);
const decodeVcsResponse = Schema.decodeUnknownSync(CocoaHostVcsResponse);
const decodeTerminalRequest = Schema.decodeUnknownSync(CocoaHostTerminalRequest);
const decodeEvent = Schema.decodeUnknownSync(CocoaHostControlEvent);

const REQUEST = { protocolVersion: 1, requestId: "request-1" } as const;
const HANDLE = { generationId: "generation-1", repositoryId: "repository-1" } as const;

describe("cocoa-hostd capability handshake", () => {
  it("negotiates a version and advertises bounded host and relay capabilities", () => {
    expect(
      decodeHandshakeRequest({
        protocol: "cocoa-host-control",
        requestId: "request-1",
        supportedVersions: [1],
        client: { name: "cocoa-gateway", version: "0.1.0" },
      }),
    ).toMatchObject({ supportedVersions: [1] });

    const response = {
      protocol: "cocoa-host-control",
      requestId: "request-1",
      selectedVersion: 1,
      host: {
        generationId: "generation-1",
        implementation: "cocoa-hostd",
        version: "0.1.0",
        platformFamily: "unix",
        platformOs: "darwin",
      },
      capabilities: [
        {
          kind: "workspace",
          version: 1,
          operations: ["browse", "open", "stat", "list", "read"],
          maxEntries: 25_000,
          maxReadBytes: 1024 * 1024,
        },
        {
          kind: "vcs",
          version: 1,
          driverKinds: ["git"],
          operations: [
            "open",
            "status",
            "listRefs",
            "listRemotes",
            "pull",
            "createWorktree",
            "removeWorktree",
            "createRef",
            "switchRef",
            "prepareCommit",
            "commit",
            "push",
          ],
          maxChangedPaths: 10_000,
          maxRefs: 10_000,
        },
        {
          kind: "reviewDiff",
          version: 1,
          operations: ["diff"],
          maxPatchBytes: COCOA_HOST_CONTROL_MAX_DIFF_BYTES,
        },
        {
          kind: "terminal",
          version: 1,
          operations: ["start", "attach", "write", "resize", "terminate"],
          maxOutputBytes: 4 * 1024 * 1024,
          supportsReconnect: true,
        },
        {
          kind: "providerRelay",
          version: 1,
          providers: ["codex"],
          transport: "websocket-json-rpc",
        },
      ],
      providerRelays: [
        {
          relayId: "codex-primary",
          provider: "codex",
          route: "/provider-relays/codex-primary",
          transport: "websocket-json-rpc",
          status: "available",
          generationId: "codex-generation-1",
          serverVersion: "0.12.0",
        },
      ],
    } as const;

    expect(decodeHandshakeResponse(response)).toEqual(response);
  });

  it("keeps negotiation failures typed before a version is selected", () => {
    expect(
      decodeHandshakeFrame({
        protocol: "cocoa-host-control",
        requestId: "request-2",
        error: {
          code: "unsupportedProtocol",
          message: "No mutually supported protocol version.",
          retryable: false,
        },
      }),
    ).toMatchObject({ error: { code: "unsupportedProtocol" } });
  });

  it("rejects unknown nested fields and unsafe relay routes", () => {
    expect(() =>
      decodeHandshakeRequest({
        protocol: "cocoa-host-control",
        requestId: "request-1",
        supportedVersions: [1],
        client: { name: "gateway", version: "1", command: ["sh", "-c", "unsafe"] },
      }),
    ).toThrow(/command/);

    expect(() =>
      decodeHandshakeResponse({
        protocol: "cocoa-host-control",
        requestId: "request-1",
        selectedVersion: 1,
        host: {
          generationId: "generation-1",
          implementation: "hostd",
          version: "1",
          platformFamily: "unix",
          platformOs: "linux",
        },
        capabilities: [],
        providerRelays: [
          {
            relayId: "relay-1",
            provider: "codex",
            route: "ws://provider.example/internal",
            transport: "websocket-json-rpc",
            status: "available",
            generationId: null,
          },
        ],
      }),
    ).toThrow();
  });
});

describe("cocoa-hostd workspace control", () => {
  it("uses generation-bound opaque handles after opening an absolute host path", () => {
    expect(
      decodeWorkspaceRequest({
        ...REQUEST,
        operation: "workspace.open",
        path: "/Users/ada/repo",
      }),
    ).toMatchObject({ operation: "workspace.open", path: "/Users/ada/repo" });

    expect(
      decodeWorkspaceResponse({
        ...REQUEST,
        operation: "workspace.open",
        generationId: "generation-1",
        rootId: "root-1",
        canonicalRoot: "/Users/ada/repo",
        metadata: { kind: "directory", modifiedAtMs: 1_756_000_000_000 },
      }),
    ).toMatchObject({ generationId: "generation-1", rootId: "root-1" });
  });

  it("rejects traversal and arbitrary execution fields", () => {
    expect(() =>
      decodeWorkspaceRequest({
        ...REQUEST,
        operation: "workspace.read",
        generationId: "generation-1",
        rootId: "root-1",
        relativePath: "src/../../secret",
        maxBytes: 1024,
      }),
    ).toThrow();

    expect(() =>
      decodeWorkspaceRequest({
        ...REQUEST,
        operation: "workspace.list",
        generationId: "generation-1",
        rootId: "root-1",
        relativePath: "",
        maxEntries: 100,
        maxDepth: 2,
        maxDirectories: 100,
        command: ["find", "."],
      }),
    ).toThrow(/command/);
  });
});

describe("cocoa-hostd normalized VCS and review diff control", () => {
  it("covers prepareCommit, commit, and push without accepting VCS argv", () => {
    expect(
      decodeVcsRequest({
        ...REQUEST,
        ...HANDLE,
        operation: "vcs.prepareCommit",
        filePaths: ["src/index.ts", "README.md"],
      }),
    ).toMatchObject({ operation: "vcs.prepareCommit", filePaths: ["src/index.ts", "README.md"] });
    expect(
      decodeVcsRequest({
        ...REQUEST,
        ...HANDLE,
        operation: "vcs.commit",
        subject: "Add host control protocol",
        body: "Keep provider-host mutations normalized.",
      }),
    ).toMatchObject({ operation: "vcs.commit" });
    expect(decodeVcsRequest({ ...REQUEST, ...HANDLE, operation: "vcs.push" })).toMatchObject({
      operation: "vcs.push",
    });

    expect(() =>
      decodeVcsRequest({
        ...REQUEST,
        ...HANDLE,
        operation: "vcs.push",
        argv: ["push", "--force"],
      }),
    ).toThrow(/argv/);
  });

  it("expresses diff intent semantically and bounds revisions and patch bytes", () => {
    expect(
      decodeVcsRequest({
        ...REQUEST,
        ...HANDLE,
        operation: "vcs.diff",
        source: "baseRange",
        baseRef: "automatic",
        ignoreWhitespace: false,
        maxBytes: COCOA_HOST_CONTROL_MAX_DIFF_BYTES,
      }),
    ).toMatchObject({ operation: "vcs.diff", source: "baseRange", baseRef: "automatic" });

    expect(() =>
      decodeVcsRequest({
        ...REQUEST,
        ...HANDLE,
        operation: "vcs.diff",
        source: "baseRange",
        baseRef: "--exec=unsafe",
        ignoreWhitespace: false,
        maxBytes: 1024,
      }),
    ).toThrow();

    expect(() =>
      decodeVcsResponse({
        ...REQUEST,
        operation: "vcs.diff",
        source: "workingTree",
        baseRef: null,
        headRef: null,
        patch: "x".repeat(COCOA_HOST_CONTROL_MAX_DIFF_BYTES + 1),
        byteLength: COCOA_HOST_CONTROL_MAX_DIFF_BYTES,
        truncated: true,
      }),
    ).toThrow();
  });

  it("bounds commit payloads and repository-relative staged paths", () => {
    expect(() =>
      decodeVcsRequest({
        ...REQUEST,
        ...HANDLE,
        operation: "vcs.prepareCommit",
        filePaths: ["../outside"],
      }),
    ).toThrow();
    expect(() =>
      decodeVcsRequest({
        ...REQUEST,
        ...HANDLE,
        operation: "vcs.commit",
        subject: "subject",
        body: "x".repeat(COCOA_HOST_CONTROL_MAX_COMMIT_MESSAGE_BYTES + 1),
      }),
    ).toThrow();
  });
});

describe("cocoa-hostd PTY control", () => {
  it("carries bounded shell argv and generation-bound session controls", () => {
    expect(
      decodeTerminalRequest({
        ...REQUEST,
        operation: "terminal.start",
        cwd: "/Users/ada/repo",
        shellArgv: ["/bin/sh", "-l"],
        cols: 120,
        rows: 40,
        env: { TERM: "xterm-256color" },
        outputByteLimit: 1024 * 1024,
      }),
    ).toMatchObject({ operation: "terminal.start", shellArgv: ["/bin/sh", "-l"] });

    expect(
      decodeTerminalRequest({
        ...REQUEST,
        operation: "terminal.attach",
        generationId: "generation-1",
        sessionId: "terminal-1",
        afterSequence: 8,
      }),
    ).toMatchObject({ operation: "terminal.attach", afterSequence: 8 });
  });

  it("rejects default-shell substitution, relative executables, and oversized writes", () => {
    expect(() =>
      decodeTerminalRequest({
        ...REQUEST,
        operation: "terminal.start",
        cwd: "/repo",
        shell: "default",
        cols: 80,
        rows: 24,
        outputByteLimit: 1024,
      }),
    ).toThrow();
    expect(() =>
      decodeTerminalRequest({
        ...REQUEST,
        operation: "terminal.start",
        cwd: "/repo",
        shellArgv: ["sh"],
        cols: 80,
        rows: 24,
        outputByteLimit: 1024,
      }),
    ).toThrow();
    expect(() =>
      decodeTerminalRequest({
        ...REQUEST,
        operation: "terminal.write",
        generationId: "generation-1",
        sessionId: "terminal-1",
        dataBase64: "AAAA".repeat(Math.ceil((COCOA_HOST_CONTROL_MAX_TERMINAL_WRITE_BYTES + 1) / 3)),
      }),
    ).toThrow();
  });

  it("types ordered binary output and terminal exit events", () => {
    expect(
      decodeEvent({
        protocolVersion: 1,
        event: "terminal.output",
        generationId: "generation-1",
        sessionId: "terminal-1",
        sequence: 9,
        dataBase64: "aGk=",
      }),
    ).toMatchObject({ event: "terminal.output", sequence: 9, dataBase64: "aGk=" });
    expect(
      decodeEvent({
        protocolVersion: 1,
        event: "terminal.exited",
        generationId: "generation-1",
        sessionId: "terminal-1",
        sequence: 10,
        exitCode: 0,
        exitSignal: null,
        reason: "completed",
      }),
    ).toMatchObject({ event: "terminal.exited", sequence: 10, exitCode: 0 });
  });
});
