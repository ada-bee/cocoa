/**
 * Fail-closed provider policy for Cocoa's remote-only gateway runtime.
 *
 * The upstream-compatible runtime continues to accept legacy provider fields.
 * This policy is applied only when `runtimeProfile === "cocoa-gateway"` and
 * deliberately validates the opaque provider-instance config before the
 * registry can construct a driver or spawn a transport helper.
 */
import {
  CodexSettings,
  OpenCodeSettings,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");

const ConfigRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodeConfigRecord = Schema.decodeUnknownEffect(ConfigRecord);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeOpenCodeSettings = Schema.decodeUnknownEffect(OpenCodeSettings);

const ALLOWED_CODEX_ENDPOINT_FIELDS = new Set([
  "checkpointHelper",
  "customModels",
  "enabled",
  "endpointGitExecutablePath",
  "endpointTerminal",
  "endpointTransport",
  "workspaceHelper",
]);

const LOCAL_PROCESS_FIELDS = new Set(["binaryPath", "homePath", "launchArgs", "shadowHomePath"]);
const ALLOWED_OPENCODE_ENDPOINT_FIELDS = new Set([
  "customModels",
  "enabled",
  "serverPassword",
  "serverUrl",
]);

export const CocoaGatewayPolicyFailureReason = Schema.Literals([
  "checkpoint-helper-requires-endpoint-git",
  "invalid-provider-config",
  "local-process-field",
  "missing-provider-config",
  "missing-provider-host",
  "missing-source-control-host",
  "missing-endpoint-transport",
  "missing-server-url",
  "provider-environment-forbidden",
  "unknown-provider-field",
  "unsupported-driver",
  "invalid-model-selection",
]);
export type CocoaGatewayPolicyFailureReason = typeof CocoaGatewayPolicyFailureReason.Type;

export class CocoaGatewayPolicyError extends Schema.TaggedErrorClass<CocoaGatewayPolicyError>()(
  "CocoaGatewayPolicyError",
  {
    reason: CocoaGatewayPolicyFailureReason,
    providerInstanceId: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const instance =
      this.providerInstanceId === undefined ? "" : ` for provider '${this.providerInstanceId}'`;
    return `Cocoa gateway provider policy rejected configuration${instance}: ${this.reason}.`;
  }
}

const fail = (
  reason: CocoaGatewayPolicyFailureReason,
  options: {
    readonly providerInstanceId?: string;
    readonly detail?: string;
    readonly cause?: unknown;
  } = {},
) =>
  Effect.fail(
    new CocoaGatewayPolicyError({
      reason,
      ...(options.providerInstanceId === undefined
        ? {}
        : { providerInstanceId: options.providerInstanceId }),
      ...(options.detail === undefined ? {} : { detail: options.detail }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    }),
  );

const validateInstance = Effect.fn("CocoaGatewayPolicy.validateInstance")(function* (
  providerInstanceId: string,
  instance: ProviderInstanceConfig,
  settings: ServerSettings,
) {
  if (instance.driver !== CODEX_DRIVER && instance.driver !== OPENCODE_DRIVER) {
    return yield* fail("unsupported-driver", {
      providerInstanceId,
      detail: `Driver '${instance.driver}' is not available in the Cocoa gateway profile.`,
    });
  }

  if (instance.environment !== undefined && instance.environment.length > 0) {
    return yield* fail("provider-environment-forbidden", {
      providerInstanceId,
      detail:
        "Cocoa endpoint providers cannot carry process environment values; pair a Cocoa host instead.",
    });
  }

  if (instance.hostId !== undefined && settings.providerHosts[instance.hostId] === undefined) {
    return yield* fail("missing-provider-host", {
      providerInstanceId,
      detail: `Provider host '${instance.hostId}' is not configured.`,
    });
  }

  if (instance.config === undefined) {
    return yield* fail("missing-provider-config", { providerInstanceId });
  }

  const configRecord = yield* decodeConfigRecord(instance.config).pipe(
    Effect.mapError(
      (cause) =>
        new CocoaGatewayPolicyError({
          reason: "invalid-provider-config",
          providerInstanceId,
          cause,
        }),
    ),
  );

  const allowedFields =
    instance.driver === CODEX_DRIVER
      ? ALLOWED_CODEX_ENDPOINT_FIELDS
      : ALLOWED_OPENCODE_ENDPOINT_FIELDS;
  for (const field of Object.keys(configRecord)) {
    if (LOCAL_PROCESS_FIELDS.has(field)) {
      return yield* fail("local-process-field", { providerInstanceId, detail: field });
    }
    if (!allowedFields.has(field)) {
      return yield* fail("unknown-provider-field", { providerInstanceId, detail: field });
    }
  }

  const mapConfigError = (cause: unknown) =>
    new CocoaGatewayPolicyError({
      reason: "invalid-provider-config",
      providerInstanceId,
      cause,
    });
  if (instance.driver === CODEX_DRIVER) {
    const codexConfig = yield* decodeCodexSettings(configRecord).pipe(
      Effect.mapError(mapConfigError),
    );
    if (instance.hostId === undefined && codexConfig.endpointTransport === undefined) {
      return yield* fail("missing-endpoint-transport", { providerInstanceId });
    }
    if (
      codexConfig.checkpointHelper !== undefined &&
      codexConfig.endpointGitExecutablePath === undefined
    ) {
      return yield* fail("checkpoint-helper-requires-endpoint-git", {
        providerInstanceId,
        detail: "checkpointHelper requires an explicit endpointGitExecutablePath.",
      });
    }
    return { enabled: instance.enabled ?? codexConfig.enabled } as const;
  }

  const openCodeConfig = yield* decodeOpenCodeSettings(configRecord).pipe(
    Effect.mapError(mapConfigError),
  );
  if (openCodeConfig.serverUrl.trim() === "") {
    return yield* fail("missing-server-url", { providerInstanceId });
  }

  return { enabled: instance.enabled ?? openCodeConfig.enabled } as const;
});

const validateModelSelection = (
  selectionName: string,
  instanceId: ProviderInstanceId,
  enabledByInstanceId: ReadonlyMap<string, boolean>,
) => {
  const enabled = enabledByInstanceId.get(instanceId);
  return enabled === true
    ? Effect.void
    : fail("invalid-model-selection", {
        providerInstanceId: instanceId,
        detail: `${selectionName} must reference an enabled explicit Cocoa provider instance.`,
      });
};

/** Validate and return the exact explicit instance map; no legacy defaults are synthesized. */
export const resolveCocoaGatewayProviderInstanceConfigMap = Effect.fn(
  "CocoaGatewayPolicy.resolveProviderInstanceConfigMap",
)(function* (
  settings: ServerSettings,
): Effect.fn.Return<ProviderInstanceConfigMap, CocoaGatewayPolicyError> {
  const instances = Object.entries(settings.providerInstances);

  for (const [provider, hostId] of Object.entries(settings.sourceControlHostingHostDefaults)) {
    if (settings.providerHosts[hostId] === undefined) {
      return yield* fail("missing-source-control-host", {
        detail: `${provider} API operations reference provider host '${hostId}', which is not configured.`,
      });
    }
  }

  const enabledByInstanceId = new Map<string, boolean>();
  for (const [providerInstanceId, instance] of instances) {
    const validated = yield* validateInstance(providerInstanceId, instance, settings);
    enabledByInstanceId.set(providerInstanceId, validated.enabled);
  }

  // An empty registry is Cocoa's online onboarding state. The settings schema
  // still carries legacy/default model selections, but there is no route for
  // them to validate against until the first endpoint is paired.
  if (instances.length > 0) {
    yield* validateModelSelection(
      "textGenerationModelSelection",
      settings.textGenerationModelSelection.instanceId,
      enabledByInstanceId,
    );
    for (const [providerInstanceId, selection] of Object.entries(
      settings.textGenerationModelSelections ?? {},
    )) {
      if (selection.instanceId !== providerInstanceId) {
        return yield* fail("invalid-model-selection", {
          providerInstanceId,
          detail:
            "textGenerationModelSelections entries must reference the provider instance that owns the map key.",
        });
      }
      yield* validateModelSelection(
        "textGenerationModelSelections",
        selection.instanceId,
        enabledByInstanceId,
      );
    }
    for (const [providerInstanceId, selection] of Object.entries(
      settings.defaultModelSelections ?? {},
    )) {
      if (selection.instanceId !== providerInstanceId) {
        return yield* fail("invalid-model-selection", {
          providerInstanceId,
          detail:
            "defaultModelSelections entries must reference the provider instance that owns the map key.",
        });
      }
      yield* validateModelSelection(
        "defaultModelSelections",
        selection.instanceId,
        enabledByInstanceId,
      );
    }
    if (settings.sourceControlWriterModelSelection !== null) {
      yield* validateModelSelection(
        "sourceControlWriterModelSelection",
        settings.sourceControlWriterModelSelection.instanceId,
        enabledByInstanceId,
      );
    }
  }

  return settings.providerInstances;
});
