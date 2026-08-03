/**
 * CheckpointDiffQuery - fail-closed checkpoint diff boundary.
 *
 * Provider workspace paths are opaque to the gateway. Until the provider
 * contract exposes checkpoint helpers, diff queries must not inspect a path or
 * invoke gateway-local Git.
 *
 * @module CheckpointDiffQuery
 */
import type {
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CheckpointUnsupportedError, type CheckpointServiceError } from "./Errors.ts";

/** Service tag for checkpoint diff queries. */
export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResult, CheckpointServiceError>;
    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
  }
>()("t3/checkpointing/CheckpointDiffQuery") {}

export const make = Effect.succeed(
  CheckpointDiffQuery.of({
    getTurnDiff: () =>
      Effect.fail(new CheckpointUnsupportedError({ operation: "CheckpointDiffQuery.getTurnDiff" })),
    getFullThreadDiff: () =>
      Effect.fail(
        new CheckpointUnsupportedError({ operation: "CheckpointDiffQuery.getFullThreadDiff" }),
      ),
  }),
);

export const layer = Layer.effect(CheckpointDiffQuery, make);
