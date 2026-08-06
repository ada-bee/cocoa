import type { CocoaClientV1RequestError } from "@t3tools/contracts/client/v1";

import type { ProjectExecutionError } from "../../project/ProjectExecution.ts";

function unreachable(error: never): never {
  throw new Error(`Unhandled project execution error: ${String(error)}`);
}

/** Sanitize provider-normal execution failures before they cross the client boundary. */
export function projectExecutionRequestError(
  error: ProjectExecutionError,
): CocoaClientV1RequestError {
  switch (error._tag) {
    case "ProjectExecutionProjectNotFoundError":
      return { code: "not_found", message: "The requested project was not found." };
    case "ProjectExecutionProviderNotFoundError":
    case "ProjectExecutionProviderUnavailableError":
    case "ProviderExecutionDisconnectedError":
      // A disconnect after dispatch is indeterminate for mutating commands.
      // Never mark this retryable and never replay it in the gateway.
      return {
        code: "provider_unavailable",
        message:
          "The selected project provider is unavailable; command outcome may be indeterminate.",
      };
    case "ProjectExecutionCapabilityUnavailableError":
    case "ProviderExecutionUnsupportedError":
      return {
        code: "unsupported_operation",
        message: "The selected project provider does not support command execution.",
      };
    case "ProviderExecutionProtocolError":
      return {
        code: "protocol_incompatible",
        message: "The selected project provider rejected the command execution protocol.",
      };
    case "ProjectExecutionResolveOperationError":
    case "ProviderExecutionOperationError":
      return { code: "operation_failed", message: "The provider command execution failed." };
    default:
      return unreachable(error);
  }
}
