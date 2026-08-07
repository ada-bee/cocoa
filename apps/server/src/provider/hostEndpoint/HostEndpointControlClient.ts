import {
  CocoaHostControlResponse,
  type CocoaHostControlEvent,
  type CocoaHostControlOperation,
  type CocoaHostControlRequest,
  type CocoaHostControlResponse as CocoaHostControlResponseType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type HostEndpointRpcClient,
  type HostEndpointRpcDecoder,
  type HostEndpointRpcMethodSpec,
  type HostEndpointRpcRequestError,
} from "./HostEndpointRpcClient.ts";

type RequestFrameFor<Operation extends CocoaHostControlOperation> = Extract<
  CocoaHostControlRequest,
  { readonly operation: Operation }
>;

type StripEnvelope<Input> = Input extends unknown
  ? Omit<Input, "protocolVersion" | "requestId" | "operation">
  : never;

export type HostEndpointControlRequestPayload<Operation extends CocoaHostControlOperation> =
  StripEnvelope<RequestFrameFor<Operation>>;

export type HostEndpointControlSuccess<Operation extends CocoaHostControlOperation> = Extract<
  CocoaHostControlResponseType,
  { readonly operation: Operation; readonly error?: never }
>;

export type HostEndpointControlContract = {
  readonly [Operation in CocoaHostControlOperation]: HostEndpointRpcMethodSpec<
    HostEndpointControlRequestPayload<Operation>,
    HostEndpointControlSuccess<Operation>
  >;
};

export type HostEndpointControlClient = HostEndpointRpcClient<
  HostEndpointControlContract,
  CocoaHostControlEvent
>;

const responseDecoderCache = new Map<
  CocoaHostControlOperation,
  HostEndpointRpcDecoder<HostEndpointControlSuccess<CocoaHostControlOperation>>
>();

export const hostEndpointResponseDecoder = <Operation extends CocoaHostControlOperation>(
  operation: Operation,
): HostEndpointRpcDecoder<HostEndpointControlSuccess<Operation>> => {
  const cached = responseDecoderCache.get(operation);
  if (cached !== undefined) {
    return cached as HostEndpointRpcDecoder<HostEndpointControlSuccess<Operation>>;
  }
  const schema = CocoaHostControlResponse.check(
    Schema.makeFilter(
      (response) =>
        (!("error" in response) && response.operation === operation) ||
        `Expected a successful '${operation}' response.`,
    ),
  );
  const decoder = Schema.decodeUnknownEffect(schema) as HostEndpointRpcDecoder<
    HostEndpointControlSuccess<Operation>
  >;
  responseDecoderCache.set(
    operation,
    decoder as HostEndpointRpcDecoder<HostEndpointControlSuccess<CocoaHostControlOperation>>,
  );
  return decoder;
};

export const requestHostEndpoint = Effect.fn("HostEndpointControlClient.request")(function* <
  Operation extends CocoaHostControlOperation,
>(
  client: HostEndpointControlClient,
  operation: Operation,
  payload: HostEndpointControlRequestPayload<Operation>,
) {
  const invoke = client.request as unknown as (
    operation: Operation,
    payload: HostEndpointControlRequestPayload<Operation>,
    decoder: HostEndpointRpcDecoder<HostEndpointControlSuccess<Operation>>,
  ) => Effect.Effect<HostEndpointControlSuccess<Operation>, HostEndpointRpcRequestError>;
  return yield* invoke(operation, payload, hostEndpointResponseDecoder(operation));
});
