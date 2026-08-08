import {
  COCOA_HOST_CONTROL_PROTOCOL,
  COCOA_HOST_CONTROL_PROTOCOL_VERSION,
  COCOA_HOST_CONTROL_SUPPORTED_VERSIONS,
  CocoaHostControlErrorResponse,
  CocoaHostControlEvent,
  CocoaHostControlHandshakeRequest,
  CocoaHostControlHandshakeErrorResponse,
  CocoaHostControlHandshakeResponse,
  CocoaHostControlRequest,
  CocoaHostControlRequestId,
  type CocoaHostControlHandshakeResponse as CocoaHostControlHandshakeResponseType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const HOST_ENDPOINT_CONTROL_PROTOCOL = COCOA_HOST_CONTROL_PROTOCOL;
export const HOST_ENDPOINT_CONTROL_VERSION = COCOA_HOST_CONTROL_PROTOCOL_VERSION;
export const HOST_ENDPOINT_CONTROL_SUPPORTED_VERSIONS = COCOA_HOST_CONTROL_SUPPORTED_VERSIONS;

export const HostEndpointCorrelatedFrame = Schema.Struct({
  requestId: CocoaHostControlRequestId,
});

export const HostEndpointRemoteErrorFrame = Schema.Union([
  CocoaHostControlHandshakeErrorResponse,
  CocoaHostControlErrorResponse,
]);

export type HostEndpointHandshakeResponse = CocoaHostControlHandshakeResponseType;

export const decodeHostEndpointJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown),
);
export const encodeHostEndpointJson = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown),
);
export const decodeHostEndpointCorrelatedFrame = Schema.decodeUnknownEffect(
  HostEndpointCorrelatedFrame,
);
export const decodeHostEndpointRemoteErrorFrame = Schema.decodeUnknownEffect(
  HostEndpointRemoteErrorFrame,
);
export const decodeHostEndpointEventFrame = Schema.decodeUnknownEffect(CocoaHostControlEvent);
export const decodeHostEndpointHandshakeResponse = Schema.decodeUnknownEffect(
  CocoaHostControlHandshakeResponse,
);
export const decodeHostEndpointHandshakeRequest = Schema.decodeUnknownEffect(
  CocoaHostControlHandshakeRequest,
);
export const decodeHostEndpointControlRequest = Schema.decodeUnknownEffect(CocoaHostControlRequest);
