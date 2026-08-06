import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  ProviderExecutionDisconnectedError,
  ProviderExecutionProtocolError,
  ProviderExecutionUnsupportedError,
} from "../../provider/ProviderExecutionAdapter.ts";
import { ProjectExecutionProjectNotFoundError } from "../../project/ProjectExecution.ts";
import { projectExecutionRequestError } from "./Execution.ts";

const projectId = ProjectId.make("project-1");
const providerInstanceId = ProviderInstanceId.make("provider-1");

describe("Cocoa v1 project execution errors", () => {
  it("keeps disconnect outcomes explicitly non-retryable", () => {
    expect(
      projectExecutionRequestError(new ProviderExecutionDisconnectedError({ providerInstanceId })),
    ).toEqual({
      code: "provider_unavailable",
      message:
        "The selected project provider is unavailable; command outcome may be indeterminate.",
    });
  });

  it("separates routing, capability, and protocol failures", () => {
    expect(
      projectExecutionRequestError(new ProjectExecutionProjectNotFoundError({ projectId })).code,
    ).toBe("not_found");
    expect(
      projectExecutionRequestError(new ProviderExecutionUnsupportedError({ providerInstanceId }))
        .code,
    ).toBe("unsupported_operation");
    expect(
      projectExecutionRequestError(
        new ProviderExecutionProtocolError({ providerInstanceId, detail: "bad frame" }),
      ).code,
    ).toBe("protocol_incompatible");
  });
});
