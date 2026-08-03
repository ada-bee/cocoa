import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  FILESYSTEM_BROWSE_MAX_ENTRIES,
  FilesystemBrowseError,
  FilesystemBrowseInput,
  FilesystemBrowseResult,
} from "./filesystem.ts";

const providerInstanceId = ProviderInstanceId.make("codex-macbook");
const decodeInput = Schema.decodeUnknownSync(FilesystemBrowseInput);
const decodeResult = Schema.decodeUnknownSync(FilesystemBrowseResult);
const encodeError = Schema.encodeSync(FilesystemBrowseError);

describe("FilesystemBrowseInput", () => {
  it("requires an exact provider instance and normalized POSIX locator", () => {
    expect(
      decodeInput({
        providerInstanceId,
        locator: { kind: "absolute", path: "/Users/ada/Developer" },
      }),
    ).toEqual({
      providerInstanceId,
      locator: { kind: "absolute", path: "/Users/ada/Developer" },
    });
    expect(
      decodeInput({ providerInstanceId, locator: { kind: "home", relativePath: "" } }),
    ).toEqual({ providerInstanceId, locator: { kind: "home", relativePath: "" } });
  });

  it.each([
    { kind: "absolute", path: "relative/path" },
    { kind: "absolute", path: "/a/../b" },
    { kind: "absolute", path: "/a//b" },
    { kind: "absolute", path: "C:\\Users\\ada" },
    { kind: "home", relativePath: "../secret" },
    { kind: "home", relativePath: "a//b" },
    { kind: "home", relativePath: "a\\b" },
  ])("rejects ambiguous or non-POSIX locator %#", (locator) => {
    expect(() => decodeInput({ providerInstanceId, locator })).toThrow();
  });

  it("rejects legacy and excess request fields", () => {
    expect(() =>
      decodeInput({ providerInstanceId, partialPath: "~/Developer", cwd: "/tmp" }),
    ).toThrow();
    expect(() =>
      decodeInput({
        providerInstanceId,
        locator: { kind: "home", relativePath: "Developer", cwd: "/tmp" },
      }),
    ).toThrow();
  });
});

describe("FilesystemBrowseResult", () => {
  it("accepts a bounded directory-only wire result", () => {
    expect(
      decodeResult({
        directoryPath: "/Users/ada",
        parentPath: "/Users",
        entries: [{ name: "Developer" }],
        truncated: false,
      }),
    ).toEqual({
      directoryPath: "/Users/ada",
      parentPath: "/Users",
      entries: [{ name: "Developer" }],
      truncated: false,
    });
  });

  it("rejects oversized listings", () => {
    expect(() =>
      decodeResult({
        directoryPath: "/tmp",
        parentPath: "/",
        entries: Array.from({ length: FILESYSTEM_BROWSE_MAX_ENTRIES + 1 }, (_, index) => ({
          name: `entry-${index}`,
        })),
        truncated: false,
      }),
    ).toThrow();
  });
});

describe("FilesystemBrowseError", () => {
  it("encodes only stable sanitized failure context", () => {
    const error = new FilesystemBrowseError({
      providerInstanceId,
      failure: "path_not_found",
      retryable: false,
    });
    const encoded = encodeError(error);

    expect(encoded).toEqual({
      _tag: "FilesystemBrowseError",
      providerInstanceId,
      failure: "path_not_found",
      retryable: false,
      message: "The folder was not found.",
    });
    expect(encoded).not.toHaveProperty("requestedPath");
    expect(encoded).not.toHaveProperty("root");
    expect(encoded).not.toHaveProperty("parentPath");
    expect(encoded).not.toHaveProperty("platform");
    expect(encoded).not.toHaveProperty("cause");
  });

  it("rejects unbounded or legacy message-only error payloads", () => {
    const decodeError = Schema.decodeUnknownSync(FilesystemBrowseError);
    expect(() =>
      decodeError({
        _tag: "FilesystemBrowseError",
        providerInstanceId,
        failure: "operation_failed",
        retryable: true,
        message: "x".repeat(257),
      }),
    ).toThrow();
    expect(() =>
      decodeError({ _tag: "FilesystemBrowseError", message: "Legacy failure." }),
    ).toThrow();
    const decoded = decodeError({
      _tag: "FilesystemBrowseError",
      providerInstanceId,
      failure: "operation_failed",
      retryable: true,
      message: "The folder could not be browsed.",
      cause: "sensitive helper detail",
    });
    expect(decoded).not.toHaveProperty("cause");
    expect(encodeError(decoded)).not.toHaveProperty("cause");
  });
});
