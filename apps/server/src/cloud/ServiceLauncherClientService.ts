import type { ServerSelfUpdateOutcome } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class ServiceLauncherClientError extends Schema.TaggedErrorClass<ServiceLauncherClientError>()(
  "ServiceLauncherClientError",
  {
    operation: Schema.Literals([
      "decode-context",
      "version-mismatch",
      "ipc-unavailable",
      "unmanaged",
      "send",
      "disconnect",
      "timeout",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.operation) {
      case "decode-context":
        return "The service launcher supplied invalid startup context.";
      case "version-mismatch":
        return "The service launcher started a different t3 version.";
      case "ipc-unavailable":
        return "The service launcher IPC channel is unavailable.";
      case "unmanaged":
        return "This server is not managed by the launcher.";
      case "send":
        return "Could not send a request to the service launcher.";
      case "disconnect":
        return "The service launcher disconnected before acknowledging the request.";
      case "timeout":
        return "The service launcher did not respond within 30 seconds.";
    }
  }
}

export class ServiceLauncherRejectedError extends Schema.TaggedErrorClass<ServiceLauncherRejectedError>()(
  "ServiceLauncherRejectedError",
  {
    targetVersion: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class ServiceLauncherClient extends Context.Service<
  ServiceLauncherClient,
  {
    readonly managed: boolean;
    readonly trial: boolean;
    readonly requestUpdate: (input: {
      readonly targetVersion: string;
    }) => Effect.Effect<string, ServiceLauncherClientError | ServiceLauncherRejectedError>;
    readonly prepareTrial: Effect.Effect<
      ServerSelfUpdateOutcome | undefined,
      ServiceLauncherClientError
    >;
  }
>()(
  // @effect-diagnostics-next-line deterministicKeys:off
  "t3/cloud/serviceLauncherClient",
) {}

/** Cocoa is administrator-managed and never participates in T3 launcher IPC. */
export const cocoaGatewayLayer = Layer.succeed(
  ServiceLauncherClient,
  ServiceLauncherClient.of({
    managed: false,
    trial: false,
    requestUpdate: () => Effect.fail(new ServiceLauncherClientError({ operation: "unmanaged" })),
    prepareTrial: Effect.sync((): ServerSelfUpdateOutcome | undefined => undefined),
  }),
);
