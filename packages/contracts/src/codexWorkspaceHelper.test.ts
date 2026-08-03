import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CODEX_WORKSPACE_HELPER_MAX_BROWSE_ENTRIES,
  CODEX_WORKSPACE_HELPER_MAX_BROWSE_RESPONSE_BYTES,
  CODEX_WORKSPACE_HELPER_MAX_ENTRY_NAME_CHARS,
  CODEX_WORKSPACE_HELPER_MAX_LIST_DEPTH,
  CODEX_WORKSPACE_HELPER_MAX_LIST_ENTRIES,
  CODEX_WORKSPACE_HELPER_MAX_READ_BYTES,
  CodexWorkspaceHelperConfig,
  CodexWorkspaceHelperProbeResult,
  CodexWorkspaceHelperRequest,
  CodexWorkspaceHelperResponse,
} from "./codexWorkspaceHelper.ts";
import { CodexSettings, ServerSettingsPatch } from "./settings.ts";

const decodeConfig = Schema.decodeUnknownSync(CodexWorkspaceHelperConfig);
const decodeProbeResult = Schema.decodeUnknownSync(CodexWorkspaceHelperProbeResult);
const decodeRequest = Schema.decodeUnknownSync(CodexWorkspaceHelperRequest);
const decodeResponse = Schema.decodeUnknownSync(CodexWorkspaceHelperResponse);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const ROOT_IDENTITY = {
  canonicalRoot: "/Users/ada/repo",
  device: "16777234",
  inode: "12345678901234567890",
} as const;

describe("CodexWorkspaceHelperConfig", () => {
  it("decodes only the two fixed v1 implementations", () => {
    expect(
      decodeConfig({
        type: "inline-python3-v1",
        executablePath: "/usr/bin/python3",
      }),
    ).toEqual({
      type: "inline-python3-v1",
      executablePath: "/usr/bin/python3",
    });

    expect(
      decodeConfig({
        type: "cocoa-workspace-helper-v1",
        executablePath: "/run/current-system/sw/bin/cocoa-workspace-helper",
        expectedProtocol: 1,
      }),
    ).toEqual({
      type: "cocoa-workspace-helper-v1",
      executablePath: "/run/current-system/sw/bin/cocoa-workspace-helper",
      expectedProtocol: 1,
    });
  });

  it.each(["python3", "./python3", "", "relative/bin/helper", "/usr/bin/python\0evil"])(
    "rejects non-absolute or NUL executable path %j",
    (executablePath) => {
      expect(() => decodeConfig({ type: "inline-python3-v1", executablePath })).toThrow();
    },
  );

  it("rejects arbitrary command arrays instead of silently accepting an execution surface", () => {
    expect(() =>
      decodeConfig({
        type: "inline-python3-v1",
        executablePath: "/usr/bin/python3",
        command: ["sh", "-c", "unsafe"],
      }),
    ).toThrow(/command/);
  });

  it("requires the executable helper to declare the exact v1 protocol", () => {
    expect(() =>
      decodeConfig({
        type: "cocoa-workspace-helper-v1",
        executablePath: "/opt/cocoa-workspace-helper",
      }),
    ).toThrow();
    expect(() =>
      decodeConfig({
        type: "cocoa-workspace-helper-v1",
        executablePath: "/opt/cocoa-workspace-helper",
        expectedProtocol: 2,
      }),
    ).toThrow();
  });
});

describe("CodexWorkspaceHelper v1 wire contracts", () => {
  it("decodes every bounded read-only request operation", () => {
    expect(decodeRequest({ protocol: 1, operation: "probe" })).toEqual({
      protocol: 1,
      operation: "probe",
    });
    expect(
      decodeRequest({ protocol: 1, operation: "validate", root: "/Users/ada/repo" }),
    ).toMatchObject({ operation: "validate", root: "/Users/ada/repo" });
    expect(
      decodeRequest({
        protocol: 1,
        operation: "stat",
        root: "/Users/ada/repo",
        expectedRoot: ROOT_IDENTITY,
        relativePath: "src/index.ts",
      }),
    ).toMatchObject({ operation: "stat", relativePath: "src/index.ts" });
    expect(
      decodeRequest({
        protocol: 1,
        operation: "list",
        root: "/Users/ada/repo",
        expectedRoot: ROOT_IDENTITY,
        relativePath: "",
        limits: {
          maxEntries: CODEX_WORKSPACE_HELPER_MAX_LIST_ENTRIES,
          maxDepth: CODEX_WORKSPACE_HELPER_MAX_LIST_DEPTH,
          maxDirectories: 10_000,
          maxResponseBytes: 8 * 1024 * 1024,
        },
      }),
    ).toMatchObject({ operation: "list", relativePath: "" });
    expect(
      decodeRequest({
        protocol: 1,
        operation: "read",
        root: "/Users/ada/repo",
        expectedRoot: ROOT_IDENTITY,
        relativePath: "README.md",
        maxBytes: CODEX_WORKSPACE_HELPER_MAX_READ_BYTES,
      }),
    ).toMatchObject({ operation: "read", maxBytes: CODEX_WORKSPACE_HELPER_MAX_READ_BYTES });
  });

  it("preserves old probe payloads while allowing browse to be advertised", () => {
    expect(
      decodeProbeResult({
        operation: "probe",
        implementation: "cocoa-workspace-helper",
        capabilities: ["probe", "validate", "stat", "list", "read"],
      }).capabilities,
    ).toEqual(["probe", "validate", "stat", "list", "read"]);

    expect(
      decodeProbeResult({
        operation: "probe",
        implementation: "cocoa-workspace-helper",
        capabilities: ["probe", "validate", "stat", "list", "read", "browse"],
      }).capabilities,
    ).toContain("browse");
  });

  it("decodes explicit absolute and home-relative browse locators without cwd", () => {
    expect(
      decodeRequest({
        protocol: 1,
        operation: "browse",
        locator: { kind: "absolute", path: "/Users/ada/Developer" },
        maxEntries: 200,
        maxResponseBytes: 1024 * 1024,
      }),
    ).toEqual({
      protocol: 1,
      operation: "browse",
      locator: { kind: "absolute", path: "/Users/ada/Developer" },
      maxEntries: 200,
      maxResponseBytes: 1024 * 1024,
    });

    expect(
      decodeRequest({
        protocol: 1,
        operation: "browse",
        locator: { kind: "home", relativePath: "" },
        maxEntries: 200,
        maxResponseBytes: 1024 * 1024,
      }),
    ).toMatchObject({ locator: { kind: "home", relativePath: "" } });
  });

  it("rejects cwd, ambiguous relative locators, and unsafe locator paths", () => {
    const browse = (locator: unknown, extras: Record<string, unknown> = {}) =>
      decodeRequest({
        protocol: 1,
        operation: "browse",
        locator,
        maxEntries: 200,
        maxResponseBytes: 1024 * 1024,
        ...extras,
      });

    expect(() =>
      browse({ kind: "absolute", path: "/Users/ada" }, { cwd: "/private/project" }),
    ).toThrow(/cwd/);
    expect(() => browse({ kind: "absolute", path: "Developer" })).toThrow();
    expect(() => browse({ path: "Developer" })).toThrow();

    for (const relativePath of ["../secret", "src/../secret", "src\\nested", "x\0y"]) {
      expect(() => browse({ kind: "home", relativePath })).toThrow();
    }
    for (const path of [
      "/Users/ada/../secret",
      "/Users//ada",
      "/Users/ada/",
      "/Users\\ada",
      "/Users/ada\0evil",
    ]) {
      expect(() => browse({ kind: "absolute", path })).toThrow();
    }
  });

  it("enforces browse request entry and response bounds", () => {
    const request = (maxEntries: number, maxResponseBytes: number) =>
      decodeRequest({
        protocol: 1,
        operation: "browse",
        locator: { kind: "home", relativePath: "Developer" },
        maxEntries,
        maxResponseBytes,
      });

    expect(() => request(0, 1024)).toThrow();
    expect(() => request(CODEX_WORKSPACE_HELPER_MAX_BROWSE_ENTRIES + 1, 1024)).toThrow();
    expect(() => request(1, 0)).toThrow();
    expect(() => request(1, CODEX_WORKSPACE_HELPER_MAX_BROWSE_RESPONSE_BYTES + 1)).toThrow();
  });

  it("decodes bounded direct browse entries and normalized resolved paths", () => {
    expect(
      decodeResponse({
        protocol: 1,
        ok: true,
        result: {
          operation: "browse",
          directoryPath: "/Users/ada/Developer",
          parentPath: "/Users/ada",
          entries: [
            { name: "cocoa", kind: "directory" },
            { name: "notes.txt", kind: "file" },
          ],
          truncated: false,
        },
      }),
    ).toMatchObject({
      ok: true,
      result: { operation: "browse", directoryPath: "/Users/ada/Developer" },
    });

    expect(
      decodeResponse({
        protocol: 1,
        ok: true,
        result: {
          operation: "browse",
          directoryPath: "/",
          parentPath: null,
          entries: [],
          truncated: false,
        },
      }),
    ).toMatchObject({ ok: true, result: { parentPath: null } });
  });

  it("rejects unsafe or over-limit browse result paths, names, and entries", () => {
    const result = (overrides: Record<string, unknown>) =>
      decodeResponse({
        protocol: 1,
        ok: true,
        result: {
          operation: "browse",
          directoryPath: "/Users/ada",
          parentPath: "/Users",
          entries: [],
          truncated: false,
          ...overrides,
        },
      });

    expect(() => result({ directoryPath: "/Users/ada/../secret" })).toThrow();
    expect(() => result({ parentPath: "Users" })).toThrow();
    for (const name of ["", ".", "..", "nested/name", "nested\\name", "x\0y"]) {
      expect(() => result({ entries: [{ name, kind: "directory" }] })).toThrow();
    }
    expect(() =>
      result({
        entries: [
          {
            name: "x".repeat(CODEX_WORKSPACE_HELPER_MAX_ENTRY_NAME_CHARS + 1),
            kind: "file",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      result({
        entries: Array.from(
          { length: CODEX_WORKSPACE_HELPER_MAX_BROWSE_ENTRIES + 1 },
          (_, index) => ({ name: `entry-${index}`, kind: "file" }),
        ),
      }),
    ).toThrow();
  });

  it.each([
    "/etc/passwd",
    "../secret",
    "src/../secret",
    "./src",
    "src//index.ts",
    "src\\index.ts",
    "x\0y",
  ])("rejects unsafe workspace-relative path %j", (relativePath) => {
    expect(() =>
      decodeRequest({
        protocol: 1,
        operation: "read",
        root: "/workspace",
        expectedRoot: { ...ROOT_IDENTITY, canonicalRoot: "/workspace" },
        relativePath,
        maxBytes: 1024,
      }),
    ).toThrow();
  });

  it("enforces hard request bounds and exact v1 fields", () => {
    expect(() =>
      decodeRequest({
        protocol: 1,
        operation: "read",
        root: "/workspace",
        expectedRoot: { ...ROOT_IDENTITY, canonicalRoot: "/workspace" },
        relativePath: "large.bin",
        maxBytes: CODEX_WORKSPACE_HELPER_MAX_READ_BYTES + 1,
      }),
    ).toThrow();
    expect(() =>
      decodeRequest({
        protocol: 1,
        operation: "list",
        root: "/workspace",
        expectedRoot: { ...ROOT_IDENTITY, canonicalRoot: "/workspace" },
        relativePath: "",
        limits: {
          maxEntries: CODEX_WORKSPACE_HELPER_MAX_LIST_ENTRIES + 1,
          maxDepth: 1,
          maxDirectories: 1,
          maxResponseBytes: 1024,
        },
      }),
    ).toThrow();
    expect(() => decodeRequest({ protocol: 1, operation: "probe", command: ["ls"] })).toThrow(
      /command/,
    );
  });

  it("decodes typed success and failure responses", () => {
    expect(
      decodeResponse({
        protocol: 1,
        ok: true,
        result: {
          operation: "probe",
          implementation: "inline-python3",
          capabilities: ["probe", "validate", "stat", "list", "read"],
        },
      }),
    ).toMatchObject({ ok: true, result: { operation: "probe" } });

    expect(
      decodeResponse({
        protocol: 1,
        ok: true,
        result: {
          operation: "read",
          dataBase64: "aGVsbG8=",
          byteLength: 5,
          truncated: false,
        },
      }),
    ).toMatchObject({ ok: true, result: { operation: "read", byteLength: 5 } });

    expect(
      decodeResponse({
        protocol: 1,
        ok: false,
        error: { code: "path_is_symlink", message: "Symlinks are not followed by v1." },
      }),
    ).toMatchObject({ ok: false, error: { code: "path_is_symlink" } });
  });

  it("rejects malformed read data but represents oversized files without oversized payloads", () => {
    expect(() =>
      decodeResponse({
        protocol: 1,
        ok: true,
        result: {
          operation: "read",
          dataBase64: "not base64!",
          byteLength: 7,
          truncated: false,
        },
      }),
    ).toThrow();
    expect(
      decodeResponse({
        protocol: 1,
        ok: true,
        result: {
          operation: "read",
          dataBase64: "",
          byteLength: CODEX_WORKSPACE_HELPER_MAX_READ_BYTES + 1,
          truncated: true,
        },
      }),
    ).toMatchObject({ ok: true, result: { truncated: true } });
  });
});

describe("CodexSettings workspace helper", () => {
  it("is absent by default and decodes as an internal provider setting", () => {
    expect(decodeCodexSettings({}).workspaceHelper).toBeUndefined();
    expect(
      decodeCodexSettings({
        workspaceHelper: {
          type: "inline-python3-v1",
          executablePath: "/usr/bin/python3",
        },
      }).workspaceHelper,
    ).toEqual({ type: "inline-python3-v1", executablePath: "/usr/bin/python3" });
  });

  it("decodes the workspace helper through the legacy settings patch", () => {
    const patch = decodeServerSettingsPatch({
      providers: {
        codex: {
          workspaceHelper: {
            type: "cocoa-workspace-helper-v1",
            executablePath: "/opt/cocoa-workspace-helper",
            expectedProtocol: 1,
          },
        },
      },
    });

    expect(patch.providers?.codex?.workspaceHelper).toEqual({
      type: "cocoa-workspace-helper-v1",
      executablePath: "/opt/cocoa-workspace-helper",
      expectedProtocol: 1,
    });
  });
});
