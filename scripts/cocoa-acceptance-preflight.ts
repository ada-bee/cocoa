#!/usr/bin/env bun
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - This read-only deployment CLI runs before an Effect application exists.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  computeCocoaSettingsIdentity,
  normalizeCocoaBuildIdentity,
} from "@t3tools/shared/cocoaDeploymentIdentity";

export const COCOA_ACCEPTANCE_PREFLIGHT_SCHEMA_VERSION = 2 as const;
export const DEFAULT_COCOA_ACCEPTANCE_GATEWAY = "http://127.0.0.1:7331/";
export const DEFAULT_COCOA_ACCEPTANCE_SETTINGS = "deploy/raspberry-pi/settings.example.json";
export const DEFAULT_COCOA_ACCEPTANCE_TIMEOUT_MS = 5_000;
export const COCOA_ACCEPTANCE_MAX_RESPONSE_BYTES = 1_048_576;
export const COCOA_ENDPOINT_SECRET_MINIMUM_BYTES = 48;

export type PreflightCheckStatus = "pass" | "fail" | "skipped";

export interface CocoaAcceptancePreflightOptions {
  readonly gatewayBaseUrl: string;
  readonly settingsFile: string;
  readonly providerIds?: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly endpointSecrets?: ReadonlyArray<string>;
  readonly expectedBuildIdentity?: string;
  readonly verifySettingsIdentity?: boolean;
}

export interface CocoaAcceptancePreflightFailure {
  readonly code:
    | "settings.read_failed"
    | "settings.invalid_json"
    | "settings.invalid_contract"
    | "settings.no_enabled_providers"
    | "settings.invalid_provider_override"
    | "settings.duplicate_provider_override"
    | "secret.not_found"
    | "secret.stat_failed"
    | "secret.not_regular_file"
    | "secret.readable_by_others"
    | "secret.too_short"
    | "http.timeout"
    | "http.request_failed"
    | "http.unexpected_status"
    | "http.response_too_large"
    | "http.malformed_json"
    | "health.invalid_body"
    | "health.not_ok"
    | "identity.build_mismatch"
    | "identity.settings_mismatch"
    | "readiness.invalid_body"
    | "readiness.not_ready"
    | "readiness.check_not_ready"
    | "providers.missing"
    | "providers.duplicate"
    | "providers.not_ready"
    | "cli.invalid_arguments";
  readonly check: "settings" | "secrets" | "healthz" | "readyz" | "providers" | "identity";
  readonly target?: string;
  readonly message: string;
}

export interface CocoaAcceptanceProviderEvidence {
  readonly instanceId: string;
  readonly state: string;
}

interface HttpCheckEvidence {
  readonly status: PreflightCheckStatus;
  readonly url: string;
  readonly httpStatus: number | null;
  readonly reportedStatus: string | null;
}

interface DeploymentIdentityEvidence {
  readonly status: PreflightCheckStatus;
  readonly expectedBuild: string | null;
  readonly reportedBuild: string | null;
  readonly expectedSettings: string | null;
  readonly reportedSettings: string | null;
}

interface SecretEvidence {
  readonly kind: "endpoint-auth";
  readonly path: string;
  readonly status: PreflightCheckStatus;
  readonly regularFile: boolean | null;
  readonly mode: string | null;
  readonly byteLength: number | null;
}

export interface CocoaAcceptancePreflightEvidence {
  readonly schemaVersion: typeof COCOA_ACCEPTANCE_PREFLIGHT_SCHEMA_VERSION;
  readonly timestamp: string;
  readonly gateway: {
    readonly baseUrl: string;
    readonly healthzUrl: string;
    readonly readyzUrl: string;
    readonly timeoutMs: number;
  };
  readonly expected: {
    readonly source: "settings" | "explicit";
    readonly providerIds: ReadonlyArray<string>;
  };
  readonly providers: ReadonlyArray<CocoaAcceptanceProviderEvidence>;
  readonly checks: {
    readonly settings: {
      readonly status: PreflightCheckStatus;
      readonly file: string;
      readonly enabledProviderIds: ReadonlyArray<string>;
    };
    readonly secrets: {
      readonly status: PreflightCheckStatus;
      readonly files: ReadonlyArray<SecretEvidence>;
    };
    readonly healthz: HttpCheckEvidence;
    readonly readyz: HttpCheckEvidence & {
      readonly checks: {
        readonly startup: string | null;
        readonly database: string | null;
        readonly webIndex: string | null;
        readonly providers: string | null;
      };
    };
    readonly providers: {
      readonly status: PreflightCheckStatus;
      readonly expectedCount: number;
      readonly reportedCount: number;
    };
    readonly identity: DeploymentIdentityEvidence;
  };
  readonly success: boolean;
  readonly failures: ReadonlyArray<CocoaAcceptancePreflightFailure>;
}

export interface CocoaAcceptanceFileMetadata {
  readonly regularFile: boolean;
  readonly mode: number;
  readonly byteLength: number;
}

export interface CocoaAcceptancePreflightDependencies {
  readonly fetch: typeof globalThis.fetch;
  readonly readTextFile: (path: string) => Promise<string>;
  readonly statFile: (path: string) => Promise<CocoaAcceptanceFileMetadata>;
  readonly now: () => Date;
}

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeProviderInstanceId = Schema.decodeUnknownSync(ProviderInstanceId);

const defaultDependencies: CocoaAcceptancePreflightDependencies = {
  fetch: globalThis.fetch,
  readTextFile: (path) => NodeFS.promises.readFile(path, "utf8"),
  statFile: async (path) => {
    const stat = await NodeFS.promises.stat(path);
    return { regularFile: stat.isFile(), mode: stat.mode, byteLength: stat.size };
  },
  now: () => new Date(),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeGatewayBaseUrl = (value: string): URL => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--gateway must use http:// or https://");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("--gateway must not contain credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("--gateway must not contain a query or fragment");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
};

const octalMode = (mode: number): string => (mode & 0o777).toString(8).padStart(4, "0");

const failure = (
  code: CocoaAcceptancePreflightFailure["code"],
  check: CocoaAcceptancePreflightFailure["check"],
  message: string,
  target?: string,
): CocoaAcceptancePreflightFailure => ({
  code,
  check,
  ...(target === undefined ? {} : { target }),
  message,
});

type HttpJsonResult =
  | { readonly kind: "response"; readonly status: number; readonly body: unknown }
  | {
      readonly kind: "failure";
      readonly reason: "timeout" | "request" | "too-large" | "malformed-json";
      readonly status: number | null;
    };

const readBoundedResponseText = async (response: Response): Promise<string> => {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > COCOA_ACCEPTANCE_MAX_RESPONSE_BYTES
  ) {
    throw new RangeError("response-too-large");
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > COCOA_ACCEPTANCE_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RangeError("response-too-large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
};

const getJson = async (
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  timeoutMs: number,
): Promise<HttpJsonResult> => {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImplementation(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    let text: string;
    try {
      text = await readBoundedResponseText(response);
    } catch (error) {
      if (error instanceof RangeError && error.message === "response-too-large") {
        return { kind: "failure", reason: "too-large", status: response.status };
      }
      return {
        kind: "failure",
        reason: timedOut ? "timeout" : "request",
        status: response.status,
      };
    }
    try {
      return { kind: "response", status: response.status, body: JSON.parse(text) };
    } catch {
      return { kind: "failure", reason: "malformed-json", status: response.status };
    }
  } catch {
    return {
      kind: "failure",
      reason: timedOut ? "timeout" : "request",
      status: null,
    };
  } finally {
    clearTimeout(timeout);
  }
};

const httpFailure = (
  result: Extract<HttpJsonResult, { readonly kind: "failure" }>,
  check: "healthz" | "readyz",
  url: string,
): CocoaAcceptancePreflightFailure => {
  switch (result.reason) {
    case "timeout":
      return failure("http.timeout", check, "The HTTP GET exceeded its bounded timeout.", url);
    case "too-large":
      return failure(
        "http.response_too_large",
        check,
        "The HTTP response exceeded the one MiB evidence limit.",
        url,
      );
    case "malformed-json":
      return failure("http.malformed_json", check, "The HTTP response was not valid JSON.", url);
    case "request":
      return failure("http.request_failed", check, "The HTTP GET failed.", url);
  }
};

const validateSecret = async (
  path: string,
  dependencies: CocoaAcceptancePreflightDependencies,
): Promise<{
  readonly evidence: SecretEvidence;
  readonly failures: ReadonlyArray<CocoaAcceptancePreflightFailure>;
}> => {
  try {
    const metadata = await dependencies.statFile(path);
    const mode = octalMode(metadata.mode);
    const failures: Array<CocoaAcceptancePreflightFailure> = [];
    if (!metadata.regularFile) {
      failures.push(
        failure(
          "secret.not_regular_file",
          "secrets",
          "The supplied path is not a regular file.",
          path,
        ),
      );
    }
    if ((metadata.mode & 0o044) !== 0) {
      failures.push(
        failure(
          "secret.readable_by_others",
          "secrets",
          "Endpoint authentication secrets must not be group- or world-readable.",
          path,
        ),
      );
    }
    if (metadata.byteLength < COCOA_ENDPOINT_SECRET_MINIMUM_BYTES) {
      failures.push(
        failure(
          "secret.too_short",
          "secrets",
          `Endpoint authentication secrets must be at least ${COCOA_ENDPOINT_SECRET_MINIMUM_BYTES} bytes.`,
          path,
        ),
      );
    }
    return {
      evidence: {
        kind: "endpoint-auth",
        path,
        status: failures.length === 0 ? "pass" : "fail",
        regularFile: metadata.regularFile,
        mode,
        byteLength: metadata.byteLength,
      },
      failures,
    };
  } catch (error) {
    const missing = isRecord(error) && error.code === "ENOENT";
    return {
      evidence: {
        kind: "endpoint-auth",
        path,
        status: "fail",
        regularFile: null,
        mode: null,
        byteLength: null,
      },
      failures: [
        failure(
          missing ? "secret.not_found" : "secret.stat_failed",
          "secrets",
          missing ? "The supplied path does not exist." : "Could not inspect the supplied path.",
          path,
        ),
      ],
    };
  }
};

interface ReadinessBody {
  readonly status: string;
  readonly identity: {
    readonly build: string;
    readonly settings: string;
  };
  readonly checks: {
    readonly startup: string;
    readonly database: string;
    readonly webIndex: string;
    readonly providers: string;
  };
  readonly providers: ReadonlyArray<CocoaAcceptanceProviderEvidence>;
}

const parseReadinessBody = (value: unknown): ReadinessBody | null => {
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    !isRecord(value.identity) ||
    typeof value.identity.build !== "string" ||
    typeof value.identity.settings !== "string" ||
    !isRecord(value.checks)
  ) {
    return null;
  }
  const checks = value.checks;
  if (
    typeof checks.startup !== "string" ||
    typeof checks.database !== "string" ||
    typeof checks.webIndex !== "string" ||
    typeof checks.providers !== "string" ||
    !Array.isArray(value.providers)
  ) {
    return null;
  }
  const providers: Array<CocoaAcceptanceProviderEvidence> = [];
  for (const provider of value.providers) {
    if (
      !isRecord(provider) ||
      typeof provider.instanceId !== "string" ||
      provider.instanceId.length === 0 ||
      typeof provider.state !== "string"
    ) {
      return null;
    }
    providers.push({ instanceId: provider.instanceId, state: provider.state });
  }
  return {
    status: value.status,
    identity: {
      build: value.identity.build,
      settings: value.identity.settings,
    },
    checks: {
      startup: checks.startup,
      database: checks.database,
      webIndex: checks.webIndex,
      providers: checks.providers,
    },
    providers,
  };
};

export const runCocoaAcceptancePreflight = async (
  options: CocoaAcceptancePreflightOptions,
  dependencies: CocoaAcceptancePreflightDependencies = defaultDependencies,
): Promise<CocoaAcceptancePreflightEvidence> => {
  const gateway = normalizeGatewayBaseUrl(options.gatewayBaseUrl);
  const healthzUrl = new URL("healthz", gateway).toString();
  const readyzUrl = new URL("readyz", gateway).toString();
  const settingsFile = NodePath.resolve(options.settingsFile);
  const failures: Array<CocoaAcceptancePreflightFailure> = [];

  let settingsStatus: PreflightCheckStatus = "pass";
  let enabledProviderIds: ReadonlyArray<string> = [];
  let expectedSettingsIdentity: string | null = null;
  try {
    const settingsText = await dependencies.readTextFile(settingsFile);
    let settingsUnknown: unknown;
    try {
      settingsUnknown = JSON.parse(settingsText);
    } catch {
      settingsStatus = "fail";
      failures.push(
        failure(
          "settings.invalid_json",
          "settings",
          "The settings file is not valid JSON.",
          settingsFile,
        ),
      );
    }
    if (settingsStatus === "pass") {
      try {
        const settings = decodeServerSettings(settingsUnknown);
        if (options.verifySettingsIdentity) {
          expectedSettingsIdentity = computeCocoaSettingsIdentity(settings);
        }
        enabledProviderIds = Object.entries(settings.providerInstances)
          .filter(([, provider]) => provider.enabled !== false)
          .map(([instanceId]) => instanceId)
          .sort();
      } catch {
        settingsStatus = "fail";
        failures.push(
          failure(
            "settings.invalid_contract",
            "settings",
            "The settings file does not match the public ServerSettings contract.",
            settingsFile,
          ),
        );
      }
    }
  } catch {
    settingsStatus = "fail";
    failures.push(
      failure(
        "settings.read_failed",
        "settings",
        "Could not read the settings file.",
        settingsFile,
      ),
    );
  }

  const expectedSource = options.providerIds === undefined ? "settings" : "explicit";
  let expectedProviderIds =
    options.providerIds === undefined ? [...enabledProviderIds] : [...options.providerIds];
  if (options.providerIds !== undefined) {
    for (const instanceId of options.providerIds) {
      try {
        decodeProviderInstanceId(instanceId);
      } catch {
        settingsStatus = "fail";
        failures.push(
          failure(
            "settings.invalid_provider_override",
            "settings",
            "An explicit provider ID does not match the public ProviderInstanceId contract.",
            instanceId,
          ),
        );
      }
    }
    const unique = new Set(options.providerIds);
    if (unique.size !== options.providerIds.length) {
      settingsStatus = "fail";
      failures.push(
        failure(
          "settings.duplicate_provider_override",
          "settings",
          "Explicit provider IDs must not contain duplicates.",
        ),
      );
    }
    expectedProviderIds = Array.from(unique).sort();
  }
  if (expectedProviderIds.length === 0) {
    settingsStatus = "fail";
    failures.push(
      failure(
        "settings.no_enabled_providers",
        "settings",
        "At least one expected enabled provider is required.",
      ),
    );
  }

  const secretResults: Array<Awaited<ReturnType<typeof validateSecret>>> = [];
  for (const endpointSecret of options.endpointSecrets ?? []) {
    secretResults.push(await validateSecret(NodePath.resolve(endpointSecret), dependencies));
  }
  for (const result of secretResults) failures.push(...result.failures);

  const healthResult = await getJson(dependencies.fetch, healthzUrl, options.timeoutMs);
  let healthStatus: PreflightCheckStatus = "pass";
  let healthHttpStatus: number | null = null;
  let healthReportedStatus: string | null = null;
  let healthReportedBuild: string | null = null;
  if (healthResult.kind === "failure") {
    healthStatus = "fail";
    healthHttpStatus = healthResult.status;
    failures.push(httpFailure(healthResult, "healthz", healthzUrl));
  } else {
    healthHttpStatus = healthResult.status;
    if (healthResult.status !== 200) {
      healthStatus = "fail";
      failures.push(
        failure(
          "http.unexpected_status",
          "healthz",
          "The liveness endpoint must return HTTP 200.",
          healthzUrl,
        ),
      );
    }
    if (
      !isRecord(healthResult.body) ||
      typeof healthResult.body.status !== "string" ||
      !isRecord(healthResult.body.identity) ||
      typeof healthResult.body.identity.build !== "string"
    ) {
      healthStatus = "fail";
      failures.push(
        failure("health.invalid_body", "healthz", "The liveness body is malformed.", healthzUrl),
      );
    } else {
      healthReportedStatus = healthResult.body.status;
      healthReportedBuild = healthResult.body.identity.build;
      if (healthResult.body.status !== "ok") {
        healthStatus = "fail";
        failures.push(
          failure(
            "health.not_ok",
            "healthz",
            "The liveness body status must be exactly 'ok'.",
            healthzUrl,
          ),
        );
      }
    }
  }

  const readyResult = await getJson(dependencies.fetch, readyzUrl, options.timeoutMs);
  let readinessStatus: PreflightCheckStatus = "pass";
  let readinessHttpStatus: number | null = null;
  let readinessReportedStatus: string | null = null;
  let readinessReportedBuild: string | null = null;
  let readinessReportedSettings: string | null = null;
  let readinessChecks: CocoaAcceptancePreflightEvidence["checks"]["readyz"]["checks"] = {
    startup: null,
    database: null,
    webIndex: null,
    providers: null,
  };
  let reportedProviders: ReadonlyArray<CocoaAcceptanceProviderEvidence> = [];
  let validReadinessBody = false;
  if (readyResult.kind === "failure") {
    readinessStatus = "fail";
    readinessHttpStatus = readyResult.status;
    failures.push(httpFailure(readyResult, "readyz", readyzUrl));
  } else {
    readinessHttpStatus = readyResult.status;
    if (readyResult.status !== 200) {
      readinessStatus = "fail";
      failures.push(
        failure(
          "http.unexpected_status",
          "readyz",
          "The readiness endpoint must return HTTP 200.",
          readyzUrl,
        ),
      );
    }
    const parsed = parseReadinessBody(readyResult.body);
    if (parsed === null) {
      readinessStatus = "fail";
      failures.push(
        failure("readiness.invalid_body", "readyz", "The readiness body is malformed.", readyzUrl),
      );
    } else {
      validReadinessBody = true;
      readinessReportedStatus = parsed.status;
      readinessReportedBuild = parsed.identity.build;
      readinessReportedSettings = parsed.identity.settings;
      readinessChecks = parsed.checks;
      reportedProviders = [...parsed.providers].sort((left, right) =>
        left.instanceId === right.instanceId
          ? left.state.localeCompare(right.state)
          : left.instanceId.localeCompare(right.instanceId),
      );
      if (parsed.status !== "ready") {
        readinessStatus = "fail";
        failures.push(
          failure(
            "readiness.not_ready",
            "readyz",
            "The readiness body status must be exactly 'ready'; degraded is not accepted.",
            readyzUrl,
          ),
        );
      }
      for (const [check, value] of Object.entries(parsed.checks)) {
        if (value !== "ready") {
          readinessStatus = "fail";
          failures.push(
            failure(
              "readiness.check_not_ready",
              "readyz",
              `Readiness check '${check}' must be exactly 'ready'.`,
              check,
            ),
          );
        }
      }
    }
  }

  let providerStatus: PreflightCheckStatus = validReadinessBody ? "pass" : "skipped";
  if (validReadinessBody) {
    const providersById = new Map<string, Array<CocoaAcceptanceProviderEvidence>>();
    for (const provider of reportedProviders) {
      const entries = providersById.get(provider.instanceId) ?? [];
      entries.push(provider);
      providersById.set(provider.instanceId, entries);
    }
    for (const [instanceId, providers] of Array.from(providersById.entries()).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (providers.length > 1) {
        providerStatus = "fail";
        failures.push(
          failure(
            "providers.duplicate",
            "providers",
            "A provider ID appears more than once in readiness evidence.",
            instanceId,
          ),
        );
      }
    }
    for (const instanceId of expectedProviderIds) {
      const providers = providersById.get(instanceId) ?? [];
      if (providers.length === 0) {
        providerStatus = "fail";
        failures.push(
          failure(
            "providers.missing",
            "providers",
            "An expected provider is absent from readiness evidence.",
            instanceId,
          ),
        );
      } else if (providers.length === 1 && providers[0]?.state !== "ready") {
        providerStatus = "fail";
        failures.push(
          failure(
            "providers.not_ready",
            "providers",
            "An expected provider state must be exactly 'ready'.",
            instanceId,
          ),
        );
      }
    }
  }

  let identityStatus: PreflightCheckStatus = "pass";
  if (
    healthReportedBuild !== null &&
    readinessReportedBuild !== null &&
    healthReportedBuild !== readinessReportedBuild
  ) {
    identityStatus = "fail";
    failures.push(
      failure(
        "identity.build_mismatch",
        "identity",
        "The liveness and readiness endpoints report different Cocoa build identities.",
      ),
    );
  }
  if (
    options.expectedBuildIdentity !== undefined &&
    (healthReportedBuild !== options.expectedBuildIdentity ||
      readinessReportedBuild !== options.expectedBuildIdentity)
  ) {
    identityStatus = "fail";
    failures.push(
      failure(
        "identity.build_mismatch",
        "identity",
        "The gateway does not report the explicitly expected Cocoa build identity.",
        options.expectedBuildIdentity,
      ),
    );
  }
  if (
    options.verifySettingsIdentity &&
    (expectedSettingsIdentity === null || readinessReportedSettings !== expectedSettingsIdentity)
  ) {
    identityStatus = "fail";
    failures.push(
      failure(
        "identity.settings_mismatch",
        "identity",
        "The gateway's loaded Cocoa provider configuration does not match the supplied settings file.",
        expectedSettingsIdentity ?? undefined,
      ),
    );
  }

  const secretEvidence = secretResults.map((result) => result.evidence);
  const evidenceWithoutSuccess = {
    schemaVersion: COCOA_ACCEPTANCE_PREFLIGHT_SCHEMA_VERSION,
    timestamp: dependencies.now().toISOString(),
    gateway: {
      baseUrl: gateway.toString(),
      healthzUrl,
      readyzUrl,
      timeoutMs: options.timeoutMs,
    },
    expected: {
      source: expectedSource,
      providerIds: expectedProviderIds,
    },
    providers: reportedProviders,
    checks: {
      settings: {
        status: settingsStatus,
        file: settingsFile,
        enabledProviderIds,
      },
      secrets: {
        status:
          secretEvidence.length === 0
            ? ("skipped" as const)
            : secretEvidence.every((entry) => entry.status === "pass")
              ? ("pass" as const)
              : ("fail" as const),
        files: secretEvidence,
      },
      healthz: {
        status: healthStatus,
        url: healthzUrl,
        httpStatus: healthHttpStatus,
        reportedStatus: healthReportedStatus,
      },
      readyz: {
        status: readinessStatus,
        url: readyzUrl,
        httpStatus: readinessHttpStatus,
        reportedStatus: readinessReportedStatus,
        checks: readinessChecks,
      },
      providers: {
        status: providerStatus,
        expectedCount: expectedProviderIds.length,
        reportedCount: reportedProviders.length,
      },
      identity: {
        status: identityStatus,
        expectedBuild: options.expectedBuildIdentity ?? null,
        reportedBuild: readinessReportedBuild ?? healthReportedBuild,
        expectedSettings: expectedSettingsIdentity,
        reportedSettings: readinessReportedSettings,
      },
    },
    failures,
  } satisfies Omit<CocoaAcceptancePreflightEvidence, "success">;

  return {
    ...evidenceWithoutSuccess,
    success: failures.length === 0,
  };
};

const cliFail = (message: string): never => {
  throw new Error(message);
};

export const parseCocoaAcceptancePreflightOptions = (
  args: ReadonlyArray<string>,
): CocoaAcceptancePreflightOptions => {
  let gatewayBaseUrl = DEFAULT_COCOA_ACCEPTANCE_GATEWAY;
  let settingsFile = DEFAULT_COCOA_ACCEPTANCE_SETTINGS;
  let timeoutMs = DEFAULT_COCOA_ACCEPTANCE_TIMEOUT_MS;
  const endpointSecrets: Array<string> = [];
  let expectedBuildIdentity: string | undefined;
  let verifySettingsIdentity = false;
  const providerIds: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--gateway")
      gatewayBaseUrl = args[++index] ?? cliFail("--gateway requires a value");
    else if (arg === "--settings")
      settingsFile = args[++index] ?? cliFail("--settings requires a value");
    else if (arg === "--provider")
      providerIds.push(args[++index] ?? cliFail("--provider requires a value"));
    else if (arg === "--timeout-ms") {
      const raw = args[++index] ?? cliFail("--timeout-ms requires a value");
      timeoutMs = Number(raw);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
        cliFail("--timeout-ms must be an integer from 1 through 120000");
      }
    } else if (arg === "--endpoint-secret") {
      endpointSecrets.push(args[++index] ?? cliFail("--endpoint-secret requires a value"));
    } else if (arg === "--expected-build-identity") {
      const value = args[++index] ?? cliFail("--expected-build-identity requires a value");
      expectedBuildIdentity = normalizeCocoaBuildIdentity(value);
    } else if (arg === "--verify-settings-identity") {
      verifySettingsIdentity = true;
    } else if (arg === "--help") {
      process.stdout.write(
        [
          "Usage: bun scripts/cocoa-acceptance-preflight.ts [options]",
          "",
          "Options:",
          "  --gateway URL                       Gateway base URL.",
          "  --settings FILE                     Settings file used for deployment.",
          "  --provider ID                       Expected ready provider; repeatable.",
          "  --timeout-ms MS                     Per-request timeout (1-120000).",
          "  --endpoint-secret FILE              Check endpoint auth secret metadata; repeatable.",
          "  --expected-build-identity ID        Require the baked Cocoa build identity.",
          "  --verify-settings-identity          Match the gateway's loaded provider configuration to --settings.",
          "  --help                              Show this help.",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else cliFail(`unknown argument: ${arg}`);
  }
  normalizeGatewayBaseUrl(gatewayBaseUrl);
  return {
    gatewayBaseUrl,
    settingsFile,
    ...(providerIds.length === 0 ? {} : { providerIds }),
    timeoutMs,
    ...(endpointSecrets.length === 0 ? {} : { endpointSecrets }),
    ...(expectedBuildIdentity === undefined ? {} : { expectedBuildIdentity }),
    ...(verifySettingsIdentity ? { verifySettingsIdentity: true } : {}),
  };
};

const main = async (): Promise<void> => {
  const options = parseCocoaAcceptancePreflightOptions(process.argv.slice(2));
  const evidence = await runCocoaAcceptancePreflight(options);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!evidence.success) process.exitCode = 1;
};

const cliFailureEvidence = (message: string): CocoaAcceptancePreflightEvidence => {
  const gateway = normalizeGatewayBaseUrl(DEFAULT_COCOA_ACCEPTANCE_GATEWAY);
  return {
    schemaVersion: COCOA_ACCEPTANCE_PREFLIGHT_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    gateway: {
      baseUrl: gateway.toString(),
      healthzUrl: new URL("healthz", gateway).toString(),
      readyzUrl: new URL("readyz", gateway).toString(),
      timeoutMs: DEFAULT_COCOA_ACCEPTANCE_TIMEOUT_MS,
    },
    expected: { source: "settings", providerIds: [] },
    providers: [],
    checks: {
      settings: {
        status: "fail",
        file: NodePath.resolve(DEFAULT_COCOA_ACCEPTANCE_SETTINGS),
        enabledProviderIds: [],
      },
      secrets: { status: "skipped", files: [] },
      healthz: {
        status: "skipped",
        url: new URL("healthz", gateway).toString(),
        httpStatus: null,
        reportedStatus: null,
      },
      readyz: {
        status: "skipped",
        url: new URL("readyz", gateway).toString(),
        httpStatus: null,
        reportedStatus: null,
        checks: { startup: null, database: null, webIndex: null, providers: null },
      },
      providers: { status: "skipped", expectedCount: 0, reportedCount: 0 },
      identity: {
        status: "skipped",
        expectedBuild: null,
        reportedBuild: null,
        expectedSettings: null,
        reportedSettings: null,
      },
    },
    success: false,
    failures: [failure("cli.invalid_arguments", "settings", message)],
  };
};

const invokedPath = process.argv[1] === undefined ? undefined : NodePath.resolve(process.argv[1]);
if (invokedPath !== undefined && import.meta.url === NodeURL.pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify(cliFailureEvidence(message), null, 2)}\n`);
    process.exitCode = 2;
  });
}
