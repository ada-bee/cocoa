import { ProjectExecuteCommandInput, ProviderExecutionResult } from "../../providerExecution.ts";

/** Project-scoped argv execution; cwd is intentionally absent from the wire shape. */
export const CocoaClientV1ExecuteCommandInput = ProjectExecuteCommandInput;
export type CocoaClientV1ExecuteCommandInput = typeof CocoaClientV1ExecuteCommandInput.Type;

export const CocoaClientV1ExecuteCommandResult = ProviderExecutionResult;
export type CocoaClientV1ExecuteCommandResult = typeof CocoaClientV1ExecuteCommandResult.Type;
