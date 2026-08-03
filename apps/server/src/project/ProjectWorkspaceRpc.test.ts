import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import {
  ProjectWorkspaceCapabilityUnavailableError,
  ProjectWorkspaceProjectNotFoundError,
  ProjectWorkspaceProviderNotFoundError,
} from "./ProjectWorkspace.ts";
import * as ProjectWorkspaceRpc from "./ProjectWorkspaceRpc.ts";
import {
  ProviderWorkspaceDisconnectedError,
  ProviderWorkspaceOperationError,
  ProviderWorkspacePathError,
  ProviderWorkspaceProtocolError,
  ProviderWorkspaceUnsupportedError,
} from "../provider/ProviderWorkspaceAdapter.ts";

const projectId = ProjectId.make("project-rpc-map");
const providerInstanceId = ProviderInstanceId.make("provider-rpc-map");

it("maps project and provider failures to stable wire categories", () => {
  const cases = [
    [
      new ProjectWorkspaceProjectNotFoundError({ projectId }),
      { failure: "project_not_found", retryable: false },
    ],
    [
      new ProjectWorkspaceProviderNotFoundError({ projectId, providerInstanceId }),
      { failure: "provider_instance_not_found", retryable: false },
    ],
    [
      new ProjectWorkspaceCapabilityUnavailableError({ projectId, providerInstanceId }),
      { failure: "unsupported_operation", retryable: false },
    ],
    [
      new ProviderWorkspaceDisconnectedError({
        providerInstanceId,
        operation: "listEntries",
        cause: new Error("secret provider path"),
      }),
      { failure: "provider_unavailable", retryable: true },
    ],
    [
      new ProviderWorkspaceProtocolError({
        providerInstanceId,
        operation: "readFile",
        detail: "secret protocol detail",
      }),
      { failure: "protocol_incompatible", retryable: false },
    ],
    [
      new ProviderWorkspaceUnsupportedError({ providerInstanceId, operation: "listEntries" }),
      { failure: "unsupported_operation", retryable: false },
    ],
    [
      new ProviderWorkspaceOperationError({
        providerInstanceId,
        operation: "readFile",
        detail: "secret operation detail",
      }),
      { failure: "operation_failed", retryable: true },
    ],
  ] as const;

  for (const [error, expected] of cases) {
    assert.deepStrictEqual(ProjectWorkspaceRpc.projectWorkspaceFailureContext(error), expected);
  }
});

it("maps provider path issues without exposing provider paths", () => {
  const cases = [
    ["openRoot", "path_not_found", "workspace_root_not_found"],
    ["openRoot", "path_not_directory", "workspace_root_not_directory"],
    ["readFile", "path_not_found", "path_not_found"],
    ["readFile", "path_not_file", "path_not_file"],
    ["listEntries", "path_not_directory", "path_not_directory"],
    ["readFile", "path_is_symlink", "symlink_rejected"],
    ["readFile", "file_too_large", "file_too_large"],
    ["readFile", "invalid_path", "path_outside_workspace"],
    ["openRoot", "invalid_root", "operation_failed"],
  ] as const;

  for (const [operation, issue, failure] of cases) {
    const context = ProjectWorkspaceRpc.projectWorkspaceFailureContext(
      new ProviderWorkspacePathError({
        providerInstanceId,
        operation,
        path: "/secret/provider/root",
        issue,
        cause: new Error("authorization: Bearer secret-token"),
      }),
    );
    assert.deepStrictEqual(context, { failure, retryable: false });
    assert.notProperty(context, "path");
    assert.notProperty(context, "cause");
    assert.notProperty(context, "issue");
  }
});
