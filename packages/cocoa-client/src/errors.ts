import type {
  CocoaClientProtocolRange,
  CocoaClientV1CapabilityId,
  CocoaClientV1RequestError as CocoaClientV1RemoteRequestError,
} from "@t3tools/contracts/client/v1";

export type CocoaClientErrorCode =
  | "configuration"
  | "http"
  | "authentication"
  | "protocol"
  | "request"
  | "transport"
  | "closed"
  | "capability";

export class CocoaClientError extends Error {
  readonly code: CocoaClientErrorCode;
  override readonly cause: unknown | undefined;

  constructor(code: CocoaClientErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message);
    this.name = "CocoaClientError";
    this.code = code;
    this.cause = options?.cause;
  }
}

export class CocoaClientHttpError extends CocoaClientError {
  readonly status: number;
  readonly endpoint: string;

  constructor(input: {
    readonly status: number;
    readonly endpoint: string;
    readonly message?: string;
    readonly cause?: unknown;
  }) {
    super(
      input.status === 401 || input.status === 403 ? "authentication" : "http",
      input.message ?? `Cocoa HTTP request failed with status ${input.status}.`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "CocoaClientHttpError";
    this.status = input.status;
    this.endpoint = input.endpoint;
  }
}

export class CocoaClientRequestError extends CocoaClientError {
  readonly remoteCode: CocoaClientV1RemoteRequestError["code"];
  readonly requiredScope?: CocoaClientV1RemoteRequestError["requiredScope"];
  readonly traceId: string | undefined;

  constructor(error: CocoaClientV1RemoteRequestError) {
    super("request", error.message);
    this.name = "CocoaClientRequestError";
    this.remoteCode = error.code;
    this.requiredScope = error.requiredScope;
    this.traceId = error.traceId;
  }
}

export class CocoaClientProtocolError extends CocoaClientError {
  readonly clientRange: CocoaClientProtocolRange;
  readonly serverRange: CocoaClientProtocolRange;

  constructor(input: {
    readonly clientRange: CocoaClientProtocolRange;
    readonly serverRange: CocoaClientProtocolRange;
    readonly message: string;
  }) {
    super("protocol", input.message);
    this.name = "CocoaClientProtocolError";
    this.clientRange = input.clientRange;
    this.serverRange = input.serverRange;
  }
}

export class CocoaClientCapabilityError extends CocoaClientError {
  readonly capability: CocoaClientV1CapabilityId;

  constructor(capability: CocoaClientV1CapabilityId) {
    super("capability", `Cocoa gateway does not advertise capability "${capability}".`);
    this.name = "CocoaClientCapabilityError";
    this.capability = capability;
  }
}
