import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { ProviderConversationCacheRepository } from "../../persistence/Services/ProviderConversationCache.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import type { ProviderConversationCatalogError } from "../ProviderConversationCatalog.ts";
import {
  ProviderConversationAuthority,
  ProviderConversationAuthorityError,
  type ProviderConversationAuthorityShape,
} from "../Services/ProviderConversationAuthority.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";

interface ProviderConversationTarget {
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerThreadId: string;
}

const fromCatalogError = (
  error: ProviderConversationCatalogError,
): ProviderConversationAuthorityError =>
  new ProviderConversationAuthorityError({
    reason:
      error.reason === "disconnected"
        ? "provider-unavailable"
        : error.reason === "unsupported"
          ? "unsupported"
          : error.reason === "protocol"
            ? "protocol"
            : "operation-failed",
    detail: "The provider rejected the conversation mutation.",
    cause: error,
  });

export const makeProviderConversationAuthority = Effect.gen(function* () {
  const cache = yield* ProviderConversationCacheRepository;
  const commandReceipts = yield* OrchestrationCommandReceiptRepository;
  const registry = yield* ProviderInstanceRegistry;
  const sessionDirectory = yield* ProviderSessionDirectory;

  const resolveTarget = Effect.fn("ProviderConversationAuthority.resolveTarget")(function* (
    threadId: ThreadId,
  ) {
    const cached = yield* cache.getThreadById({ threadId });
    if (Option.isSome(cached)) {
      return Option.some<ProviderConversationTarget>({
        providerInstanceId: cached.value.providerInstanceId,
        providerThreadId: cached.value.providerThreadId,
      });
    }

    // A provider thread can become actionable just before its catalog
    // invalidation has populated the cache. The durable runtime binding is the
    // authoritative identity bridge during that short window.
    const binding = yield* sessionDirectory.getBinding(threadId);
    if (
      Option.isNone(binding) ||
      binding.value.providerInstanceId === undefined ||
      !Predicate.isObject(binding.value.resumeCursor) ||
      !("threadId" in binding.value.resumeCursor) ||
      !Predicate.isString(binding.value.resumeCursor.threadId)
    ) {
      return Option.none<ProviderConversationTarget>();
    }
    return Option.some<ProviderConversationTarget>({
      providerInstanceId: binding.value.providerInstanceId,
      providerThreadId: binding.value.resumeCursor.threadId,
    });
  });

  const apply: ProviderConversationAuthorityShape["apply"] = (command) => {
    if (
      command.type !== "thread.archive" &&
      command.type !== "thread.unarchive" &&
      command.type !== "thread.delete" &&
      !(command.type === "thread.meta.update" && command.title !== undefined) &&
      !(command.type === "thread.title.regeneration.complete" && command.title !== undefined)
    ) {
      return Effect.succeed(false);
    }
    const identityError = (cause: unknown) =>
      new ProviderConversationAuthorityError({
        reason: "cache-failed",
        detail: "Cocoa could not resolve the provider conversation identity.",
        cause,
      });
    return commandReceipts.getByCommandId({ commandId: command.commandId }).pipe(
      Effect.mapError(identityError),
      Effect.flatMap((receipt) => {
        // The orchestration receipt is Cocoa's durable idempotency journal. A
        // retried accepted command must not repeat a provider mutation.
        if (Option.isSome(receipt)) return Effect.succeed(true);
        return resolveTarget(command.threadId).pipe(
          Effect.mapError(identityError),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(false),
              onSome: (target) =>
                registry.getInstance(target.providerInstanceId).pipe(
                  Effect.flatMap((instance) => {
                    const catalog = instance?.conversationCatalog;
                    if (!catalog) {
                      return Effect.fail(
                        new ProviderConversationAuthorityError({
                          reason: "provider-unavailable",
                          detail: "The provider conversation endpoint is unavailable.",
                        }),
                      );
                    }
                    const mutation =
                      command.type === "thread.archive"
                        ? catalog.archiveThread(target.providerThreadId)
                        : command.type === "thread.unarchive"
                          ? catalog.unarchiveThread(target.providerThreadId)
                          : command.type === "thread.delete"
                            ? catalog.deleteThread(target.providerThreadId)
                            : catalog.setThreadName(target.providerThreadId, command.title!);
                    return mutation.pipe(Effect.mapError(fromCatalogError), Effect.as(true));
                  }),
                ),
            }),
          ),
        );
      }),
    );
  };

  return ProviderConversationAuthority.of({ apply });
});

export const ProviderConversationAuthorityLive = Layer.effect(
  ProviderConversationAuthority,
  makeProviderConversationAuthority,
);
