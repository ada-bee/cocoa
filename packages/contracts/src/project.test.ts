import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import {
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectWorkspaceFailure,
} from "./project.ts";

const projectId = ProjectId.make("project");
const target = { projectId, threadId: ThreadId.make("thread") };
const decodeSearchEntriesInput = Schema.decodeUnknownSync(ProjectSearchEntriesInput);
const decodeSearchContentsInput = Schema.decodeUnknownSync(ProjectSearchContentsInput);

describe("project search inputs", () => {
  it("scopes entries search by project and allows an empty query", () => {
    const decoded = decodeSearchEntriesInput({
      target,
      query: "   ",
      limit: 10,
      kind: "file",
    });
    expect(decoded.target).toEqual(target);
    expect(decoded.query).toBe("");
  });

  it("preserves whitespace in content search queries", () => {
    const decoded = decodeSearchContentsInput({
      target,
      query: " foo ",
      limit: 10,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    expect(decoded.query).toBe(" foo ");
  });
});

describe("project RPC errors", () => {
  it.each([
    "thread_not_found",
    "thread_project_mismatch",
    "path_not_directory",
    "symlink_rejected",
    "protocol_incompatible",
  ] as const)("decodes the stable %s failure code", (failure) => {
    expect(Schema.decodeUnknownSync(ProjectWorkspaceFailure)(failure)).toBe(failure);
  });

  it("exposes provider-neutral failure metadata without host paths", () => {
    const searchError = new ProjectSearchEntriesError({
      target,
      queryLength: "authorization: Bearer secret-token".length,
      limit: 20,
      failure: "provider_unavailable",
      operation: "search-entries",
      retryable: true,
    });
    const readError = new ProjectReadFileError({
      target,
      relativePath: "src/index.ts",
      failure: "operation_failed",
      operation: "read-file",
      retryable: false,
    });

    expect(searchError.message).toBe("Failed to search workspace entries.");
    expect(searchError.queryLength).toBe("authorization: Bearer secret-token".length);
    expect(searchError.failure).toBe("provider_unavailable");
    expect(searchError.retryable).toBe(true);
    expect(searchError).not.toHaveProperty("cwd");
    expect(searchError).not.toHaveProperty("normalizedCwd");
    expect(searchError).not.toHaveProperty("detail");
    expect(searchError.message).not.toMatch(/Bearer|secret-token/);
    expect(readError.message).toBe("Failed to read workspace file 'src/index.ts'.");
    expect(readError).not.toHaveProperty("resolvedPath");
    expect(readError).not.toHaveProperty("operationPath");

    const contentSearchError = new ProjectSearchContentsError({
      target,
      queryLength: "authorization: Bearer secret-token".length,
      limit: 100,
      failure: "unsupported_operation",
      operation: "search-contents",
      retryable: false,
    });
    expect(contentSearchError.message).toBe("Failed to search workspace contents.");
    expect(contentSearchError).not.toHaveProperty("query");
  });
});
