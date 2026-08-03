import {
  CommandId,
  type AuthEnvironmentScope,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  ThreadId,
} from "@t3tools/contracts";
import {
  COCOA_CLIENT_PROTOCOL_VERSION,
  COCOA_CLIENT_V1_METHODS,
  COCOA_CLIENT_V1_PROTOCOL_RANGE,
  CocoaClientV1RpcGroup,
  selectCocoaClientProtocolVersion,
  type CocoaClientProtocolVersionMismatch,
  type CocoaClientV1RequestError,
  type CocoaClientV1ShellStreamItem,
  type CocoaClientV1ThreadStreamItem,
} from "@t3tools/contracts/client/v1";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CheckpointDiffQuery from "../../checkpointing/CheckpointDiffQuery.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { normalizeDispatchCommand } from "../../orchestration/Normalizer.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import type * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { requiredScopeForCocoaClientV1Method } from "./Authorization.ts";
import {
  projectInfo,
  projectProjectShell,
  projectShellSnapshot,
  projectThreadEvent,
  projectThreadShell,
  projectThreadSnapshot,
} from "./Projection.ts";

export const COCOA_CLIENT_V1_RESUME_MAX_GAP = 1_000;

const CHECKPOINT_MUTATION_UNAVAILABLE =
  "Checkpoint revert is unavailable until the bound provider supplies checkpoint operations.";

type CocoaClientV1Method = keyof typeof COCOA_CLIENT_V1_METHODS;
type CocoaClientV1MethodTag = (typeof COCOA_CLIENT_V1_METHODS)[CocoaClientV1Method];

const requestError = (
  code: CocoaClientV1RequestError["code"],
  message: string,
  requiredScope?: AuthEnvironmentScope,
): CocoaClientV1RequestError => ({
  code,
  message,
  ...(requiredScope === undefined ? {} : { requiredScope }),
});

const internalError = (message: string): CocoaClientV1RequestError =>
  requestError("internal_error", message);

const authorizeEffect = <A, E, R>(
  session: EnvironmentAuth.AuthenticatedSession,
  method: CocoaClientV1MethodTag,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | CocoaClientV1RequestError, R> => {
  const requiredScope = requiredScopeForCocoaClientV1Method(method);
  return session.scopes.includes(requiredScope)
    ? effect
    : Effect.fail(
        requestError(
          "insufficient_scope",
          `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        ),
      );
};

const authorizeStream = <A, E, R>(
  session: EnvironmentAuth.AuthenticatedSession,
  method: CocoaClientV1MethodTag,
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E | CocoaClientV1RequestError, R> => {
  const requiredScope = requiredScopeForCocoaClientV1Method(method);
  return session.scopes.includes(requiredScope)
    ? stream
    : Stream.fail(
        requestError(
          "insufficient_scope",
          `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        ),
      );
};

type BufferedEvent =
  | { readonly kind: "event"; readonly event: OrchestrationEvent }
  | { readonly kind: "synchronized" };

const attachLiveBuffer = (
  live: Stream.Stream<OrchestrationEvent>,
): Effect.Effect<Queue.Queue<BufferedEvent>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const buffer = yield* Queue.unbounded<BufferedEvent>();
    yield* Effect.forkScoped(
      live.pipe(Stream.runForEach((event) => Queue.offer(buffer, { kind: "event", event }))),
      { startImmediately: true },
    );
    return buffer;
  });

const markSynchronized = (
  buffer: Queue.Queue<BufferedEvent>,
  requested: boolean | undefined,
): Effect.Effect<void> =>
  requested === true
    ? Queue.offer(buffer, { kind: "synchronized" }).pipe(Effect.asVoid)
    : Effect.void;

const shellItemFromEvent = (
  event: OrchestrationEvent,
  projections: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
): Effect.Effect<Option.Option<CocoaClientV1ShellStreamItem>, ProjectionRepositoryError> => {
  const fromShellEvent = (item: OrchestrationShellStreamEvent): CocoaClientV1ShellStreamItem => {
    switch (item.kind) {
      case "project-upserted":
        return {
          kind: item.kind,
          sequence: item.sequence,
          project: projectProjectShell(item.project),
        };
      case "project-removed":
        return item;
      case "thread-upserted":
        return {
          kind: item.kind,
          sequence: item.sequence,
          thread: projectThreadShell(item.thread),
        };
      case "thread-removed":
        return item;
    }
  };

  switch (event.type) {
    case "project.created":
    case "project.meta-updated":
      return projections.getProjectShellById(event.payload.projectId).pipe(
        Effect.map(
          Option.match({
            onNone: () =>
              Option.some(
                fromShellEvent({
                  kind: "project-removed",
                  sequence: event.sequence,
                  projectId: event.payload.projectId,
                }),
              ),
            onSome: (project) =>
              Option.some(
                fromShellEvent({
                  kind: "project-upserted",
                  sequence: event.sequence,
                  project,
                }),
              ),
          }),
        ),
      );
    case "project.deleted":
      return Effect.succeed(
        Option.some<CocoaClientV1ShellStreamItem>({
          kind: "project-removed",
          sequence: event.sequence,
          projectId: event.payload.projectId,
        }),
      );
    case "thread.deleted":
    case "thread.archived":
      return Effect.succeed(
        Option.some<CocoaClientV1ShellStreamItem>({
          kind: "thread-removed",
          sequence: event.sequence,
          threadId: event.payload.threadId,
        }),
      );
    default:
      if (event.aggregateKind !== "thread") {
        return Effect.succeed(Option.none());
      }
      return projections.getThreadShellById(ThreadId.make(event.aggregateId)).pipe(
        Effect.map(
          Option.match({
            onNone: () =>
              Option.some<CocoaClientV1ShellStreamItem>({
                kind: "thread-removed",
                sequence: event.sequence,
                threadId: ThreadId.make(event.aggregateId),
              }),
            onSome: (thread) =>
              Option.some<CocoaClientV1ShellStreamItem>({
                kind: "thread-upserted",
                sequence: event.sequence,
                thread: projectThreadShell(thread),
              }),
          }),
        ),
      );
  }
};

const shellEvents = <E, R>(
  events: Stream.Stream<OrchestrationEvent, E, R>,
  projections: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
): Stream.Stream<CocoaClientV1ShellStreamItem, CocoaClientV1RequestError, R> =>
  events.pipe(
    Stream.mapEffect((event) => shellItemFromEvent(event, projections)),
    Stream.filterMap((item) =>
      Option.isSome(item) ? Result.succeed(item.value) : Result.failVoid,
    ),
    Stream.mapError(() => internalError("Failed to synchronize the orchestration shell.")),
  );

const shellLiveTail = (
  buffer: Queue.Queue<BufferedEvent>,
  minimumSequence: number,
  projections: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
): Stream.Stream<CocoaClientV1ShellStreamItem, CocoaClientV1RequestError> =>
  Stream.unwrap(
    Ref.make(minimumSequence).pipe(
      Effect.map((latestSequence) =>
        Stream.fromQueue(buffer).pipe(
          Stream.mapEffect((input) => {
            if (input.kind === "synchronized") {
              return Effect.succeed(
                Option.some<CocoaClientV1ShellStreamItem>({ kind: "synchronized" }),
              );
            }
            return Ref.modify(latestSequence, (latest) =>
              input.event.sequence <= latest
                ? [Option.none<OrchestrationEvent>(), latest]
                : [Option.some(input.event), input.event.sequence],
            ).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.succeed(Option.none<CocoaClientV1ShellStreamItem>()),
                  onSome: (event) => shellItemFromEvent(event, projections),
                }),
              ),
            );
          }),
          Stream.filterMap((item) =>
            Option.isSome(item) ? Result.succeed(item.value) : Result.failVoid,
          ),
          Stream.mapError(() => internalError("Failed to synchronize the orchestration shell.")),
        ),
      ),
    ),
  );

const threadEvents = <E, R>(
  events: Stream.Stream<OrchestrationEvent, E, R>,
  threadId: ThreadId,
): Stream.Stream<CocoaClientV1ThreadStreamItem, CocoaClientV1RequestError, R> =>
  events.pipe(
    Stream.filterMap((event) => {
      const projected = projectThreadEvent(event);
      return Option.isSome(projected) && projected.value.threadId === threadId
        ? Result.succeed<CocoaClientV1ThreadStreamItem>({
            kind: "event",
            event: projected.value,
          })
        : Result.failVoid;
    }),
    Stream.mapError(() => internalError(`Failed to synchronize thread ${threadId}.`)),
  );

const threadLiveTail = (
  buffer: Queue.Queue<BufferedEvent>,
  minimumSequence: number,
  threadId: ThreadId,
): Stream.Stream<CocoaClientV1ThreadStreamItem, CocoaClientV1RequestError> =>
  Stream.unwrap(
    Ref.make(minimumSequence).pipe(
      Effect.map((latestSequence) =>
        Stream.fromQueue(buffer).pipe(
          Stream.mapEffect((input) => {
            if (input.kind === "synchronized") {
              return Effect.succeed(
                Option.some<CocoaClientV1ThreadStreamItem>({ kind: "synchronized" }),
              );
            }
            return Ref.modify(latestSequence, (latest) =>
              input.event.sequence <= latest
                ? [Option.none<OrchestrationEvent>(), latest]
                : [Option.some(input.event), input.event.sequence],
            ).pipe(
              Effect.map(
                Option.flatMap((event) => {
                  const projected = projectThreadEvent(event);
                  return Option.isSome(projected) && projected.value.threadId === threadId
                    ? Option.some<CocoaClientV1ThreadStreamItem>({
                        kind: "event",
                        event: projected.value,
                      })
                    : Option.none();
                }),
              ),
            );
          }),
          Stream.filterMap((item) =>
            Option.isSome(item) ? Result.succeed(item.value) : Result.failVoid,
          ),
        ),
      ),
    ),
  );

const protocolMismatch = (
  clientRange: CocoaClientProtocolVersionMismatch["clientRange"],
): CocoaClientProtocolVersionMismatch => ({
  code: "protocol_version_mismatch",
  clientRange,
  serverRange: COCOA_CLIENT_V1_PROTOCOL_RANGE,
  message: "The client and server do not support a common Cocoa protocol version.",
});

const sanitizeDispatchError = (): CocoaClientV1RequestError =>
  requestError("invalid_request", "The orchestration command was rejected.");

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makeCocoaClientV1Handlers = (session: EnvironmentAuth.AuthenticatedSession) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
    const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const terminals = yield* TerminalManager.TerminalManager;

    const dispatchNormalized = (
      command: OrchestrationCommand,
    ): Effect.Effect<{ readonly sequence: number }, CocoaClientV1RequestError> =>
      command.type === "thread.checkpoint.revert"
        ? Effect.fail(requestError("invalid_request", CHECKPOINT_MUTATION_UNAVAILABLE))
        : startup
            .enqueueCommand(orchestration.dispatch(command))
            .pipe(Effect.mapError(sanitizeDispatchError));

    const dispatch = (command: Parameters<typeof normalizeDispatchCommand>[0]) =>
      Effect.gen(function* () {
        const normalized = yield* normalizeDispatchCommand(command);
        const shouldStopSessionAfterArchive =
          normalized.type === "thread.archive"
            ? yield* projections.getThreadShellById(normalized.threadId).pipe(
                Effect.map(
                  Option.match({
                    onNone: () => false,
                    onSome: (thread) =>
                      thread.session !== null && thread.session.status !== "stopped",
                  }),
                ),
                Effect.orElseSucceed(() => false),
              )
            : false;
        const result = yield* dispatchNormalized(normalized);
        if (normalized.type !== "thread.archive") {
          return result;
        }
        if (shouldStopSessionAfterArchive) {
          yield* normalizeDispatchCommand({
            type: "thread.session.stop",
            commandId: CommandId.make(`session-stop-for-archive:${normalized.commandId}`),
            threadId: normalized.threadId,
            createdAt: yield* nowIso,
          }).pipe(
            Effect.flatMap(dispatchNormalized),
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to stop provider session during Cocoa v1 archive", {
                threadId: normalized.threadId,
                cause,
              }),
            ),
          );
        }
        yield* terminals.close({ threadId: normalized.threadId }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to close thread terminals after Cocoa v1 archive", {
              threadId: normalized.threadId,
              detail: error.message,
            }),
          ),
        );
        return result;
      });

    const subscribeShell = (input: {
      readonly afterSequence?: number;
      readonly requestCompletionMarker?: boolean;
    }) =>
      Effect.gen(function* () {
        const buffer = yield* attachLiveBuffer(orchestration.streamDomainEvents);

        if (input.afterSequence !== undefined) {
          const head = yield* orchestration.latestSequence;
          const gap = head - input.afterSequence;
          if (gap >= 0 && gap <= COCOA_CLIENT_V1_RESUME_MAX_GAP) {
            yield* markSynchronized(buffer, input.requestCompletionMarker);
            const replay =
              gap === 0
                ? Stream.empty
                : shellEvents(orchestration.readEvents(input.afterSequence, gap), projections);
            return Stream.concat(replay, shellLiveTail(buffer, head, projections));
          }
        }

        const snapshot = yield* projections
          .getShellSnapshot()
          .pipe(
            Effect.mapError(() =>
              internalError("Failed to load the orchestration shell snapshot."),
            ),
          );
        yield* markSynchronized(buffer, input.requestCompletionMarker);
        return Stream.concat(
          Stream.make({
            kind: "snapshot",
            snapshot: projectShellSnapshot(snapshot),
          } satisfies CocoaClientV1ShellStreamItem),
          shellLiveTail(buffer, snapshot.snapshotSequence, projections),
        );
      });

    const subscribeThread = (input: {
      readonly threadId: ThreadId;
      readonly afterSequence?: number;
      readonly requestCompletionMarker?: boolean;
    }) =>
      Effect.gen(function* () {
        const buffer = yield* attachLiveBuffer(orchestration.streamDomainEvents);

        if (input.afterSequence !== undefined) {
          const head = yield* orchestration.latestSequence;
          const gap = head - input.afterSequence;
          if (gap >= 0 && gap <= COCOA_CLIENT_V1_RESUME_MAX_GAP) {
            yield* markSynchronized(buffer, input.requestCompletionMarker);
            const replay =
              gap === 0
                ? Stream.empty
                : threadEvents(orchestration.readEvents(input.afterSequence, gap), input.threadId);
            return Stream.concat(replay, threadLiveTail(buffer, head, input.threadId));
          }
        }

        const snapshot = yield* projections
          .getThreadDetailSnapshot(input.threadId)
          .pipe(Effect.mapError(() => internalError("Failed to load the thread snapshot.")));
        if (Option.isNone(snapshot)) {
          return yield* Effect.fail(
            requestError("not_found", "The requested thread was not found."),
          );
        }
        yield* markSynchronized(buffer, input.requestCompletionMarker);
        return Stream.concat(
          Stream.make({
            kind: "snapshot",
            snapshot: projectThreadSnapshot(snapshot.value),
          } satisfies CocoaClientV1ThreadStreamItem),
          threadLiveTail(buffer, snapshot.value.snapshotSequence, input.threadId),
        );
      });

    return CocoaClientV1RpcGroup.of({
      [COCOA_CLIENT_V1_METHODS.info]: (input) =>
        authorizeEffect(
          session,
          COCOA_CLIENT_V1_METHODS.info,
          Effect.gen(function* () {
            if (
              selectCocoaClientProtocolVersion(
                input.protocolRange,
                COCOA_CLIENT_V1_PROTOCOL_RANGE,
              ) === null
            ) {
              return yield* Effect.fail(protocolMismatch(input.protocolRange));
            }
            const info = yield* Effect.all({
              environment: environment.getDescriptor,
              providers: providers.getProviders,
            }).pipe(
              Effect.mapError(() => internalError("Failed to load Cocoa client information.")),
            );
            return projectInfo(info);
          }),
        ),
      [COCOA_CLIENT_V1_METHODS.probe]: (_input) =>
        authorizeEffect(
          session,
          COCOA_CLIENT_V1_METHODS.probe,
          Effect.succeed({ protocolVersion: COCOA_CLIENT_PROTOCOL_VERSION }),
        ),
      [COCOA_CLIENT_V1_METHODS.dispatchCommand]: (command) =>
        authorizeEffect(
          session,
          COCOA_CLIENT_V1_METHODS.dispatchCommand,
          dispatch(command).pipe(Effect.mapError(sanitizeDispatchError)),
        ),
      [COCOA_CLIENT_V1_METHODS.getShellSnapshot]: (_input) =>
        authorizeEffect(
          session,
          COCOA_CLIENT_V1_METHODS.getShellSnapshot,
          projections.getShellSnapshot().pipe(
            Effect.map(projectShellSnapshot),
            Effect.mapError(() =>
              internalError("Failed to load the orchestration shell snapshot."),
            ),
          ),
        ),
      [COCOA_CLIENT_V1_METHODS.getThreadSnapshot]: (input) =>
        authorizeEffect(
          session,
          COCOA_CLIENT_V1_METHODS.getThreadSnapshot,
          projections.getThreadDetailSnapshot(input.threadId).pipe(
            Effect.mapError(() => internalError("Failed to load the thread snapshot.")),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(requestError("not_found", "The requested thread was not found.")),
                onSome: (snapshot) => Effect.succeed(projectThreadSnapshot(snapshot)),
              }),
            ),
          ),
        ),
      [COCOA_CLIENT_V1_METHODS.subscribeShell]: (input) =>
        authorizeStream(
          session,
          COCOA_CLIENT_V1_METHODS.subscribeShell,
          Stream.unwrap(subscribeShell(input)),
        ),
      [COCOA_CLIENT_V1_METHODS.subscribeThread]: (input) =>
        authorizeStream(
          session,
          COCOA_CLIENT_V1_METHODS.subscribeThread,
          Stream.unwrap(subscribeThread(input)),
        ),
      [COCOA_CLIENT_V1_METHODS.searchThreads]: (input) =>
        authorizeEffect(
          session,
          COCOA_CLIENT_V1_METHODS.searchThreads,
          projections.searchThreads(input).pipe(
            Effect.map((result) => ({
              matches: result.matches.map((match) => ({
                threadId: match.threadId,
                projectId: match.projectId,
                source: match.source,
                snippet: match.snippet,
                messageCreatedAt: match.messageCreatedAt,
              })),
            })),
            Effect.mapError(() => internalError("Failed to search threads.")),
          ),
        ),
      [COCOA_CLIENT_V1_METHODS.getTurnDiff]: (input) =>
        authorizeEffect(
          session,
          COCOA_CLIENT_V1_METHODS.getTurnDiff,
          diffs.getTurnDiff(input).pipe(
            Effect.map((result) => ({
              threadId: result.threadId,
              fromTurnCount: result.fromTurnCount,
              toTurnCount: result.toTurnCount,
              diff: result.diff,
              byteLength: result.byteLength,
              truncated: result.truncated,
            })),
            Effect.mapError(() => internalError("Failed to load the requested turn diff.")),
          ),
        ),
      [COCOA_CLIENT_V1_METHODS.getFullThreadDiff]: (input) =>
        authorizeEffect(
          session,
          COCOA_CLIENT_V1_METHODS.getFullThreadDiff,
          diffs.getFullThreadDiff(input).pipe(
            Effect.map((result) => ({
              threadId: result.threadId,
              fromTurnCount: result.fromTurnCount,
              toTurnCount: result.toTurnCount,
              diff: result.diff,
              byteLength: result.byteLength,
              truncated: result.truncated,
            })),
            Effect.mapError(() => internalError("Failed to load the full thread diff.")),
          ),
        ),
    });
  });

export const cocoaClientV1HandlersLayer = (session: EnvironmentAuth.AuthenticatedSession) =>
  CocoaClientV1RpcGroup.toLayer(makeCocoaClientV1Handlers(session));
