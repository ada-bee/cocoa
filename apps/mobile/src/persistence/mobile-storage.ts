import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as MobileSecureStorage from "./mobile-secure-storage";

const CLIENT_ID_KEY = "cocoa.client-id";
const RECENT_THREAD_SHORTCUTS_KEY = "t3code.recent-thread-shortcuts";

export class MobileStorageDecodeError extends Schema.TaggedErrorClass<MobileStorageDecodeError>()(
  "MobileStorageDecodeError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode mobile storage value for key ${this.key}.`;
  }
}

export class MobileStorageEncodeError extends Schema.TaggedErrorClass<MobileStorageEncodeError>()(
  "MobileStorageEncodeError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode mobile storage value for key ${this.key}.`;
  }
}

export class MobileClientIdGenerationError extends Schema.TaggedErrorClass<MobileClientIdGenerationError>()(
  "MobileClientIdGenerationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to generate the mobile Cocoa client id.";
  }
}

export interface RecentThreadShortcut {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
}

export class MobileStorage extends Context.Service<
  MobileStorage,
  {
    readonly loadOrCreateClientId: Effect.Effect<
      string,
      MobileSecureStorage.MobileSecureStorageError | MobileClientIdGenerationError
    >;
    readonly loadRecentThreadShortcuts: Effect.Effect<
      ReadonlyArray<RecentThreadShortcut>,
      MobileSecureStorage.MobileSecureStorageError
    >;
    readonly saveRecentThreadShortcuts: (
      threads: ReadonlyArray<RecentThreadShortcut>,
    ) => Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError | MobileStorageEncodeError
    >;
  }
>()("@t3tools/mobile/persistence/MobileStorage") {}

export const make = Effect.fn("MobileStorage.make")(function* () {
  const secureStorage = yield* MobileSecureStorage.MobileSecureStorage;

  const parseJson = <A>(key: string, raw: string): A | null => {
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw) as A;
    } catch (cause) {
      console.warn(
        "[mobile-storage] ignored invalid JSON",
        new MobileStorageDecodeError({ key, cause }),
      );
      return null;
    }
  };

  const readJson = Effect.fn("MobileStorage.readJson")(function* <A>(key: string) {
    const raw = (yield* secureStorage.getItem(key)) ?? "";
    return parseJson<A>(key, raw);
  });

  const writeJson = Effect.fn("MobileStorage.writeJson")(function* (key: string, value: unknown) {
    const encoded = yield* Effect.try({
      try: () => JSON.stringify(value),
      catch: (cause) => new MobileStorageEncodeError({ key, cause }),
    });
    yield* secureStorage.setItem(key, encoded);
  });

  const loadOrCreateClientId = Effect.gen(function* () {
    const existing = yield* secureStorage.getItem(CLIENT_ID_KEY);
    if (existing?.trim()) return existing;
    const clientId = yield* Effect.tryPromise({
      try: () => import("../lib/uuid").then(({ uuidv4 }) => uuidv4()),
      catch: (cause) => new MobileClientIdGenerationError({ cause }),
    });
    yield* secureStorage.setItem(CLIENT_ID_KEY, clientId);
    return clientId;
  });

  // Threads most recently opened on this device, newest first — the source
  // for the launcher's dynamic "recent thread" app shortcuts.
  const loadRecentThreadShortcuts = readJson<{
    readonly threads?: ReadonlyArray<RecentThreadShortcut>;
  }>(RECENT_THREAD_SHORTCUTS_KEY).pipe(
    Effect.map((parsed) =>
      pipe(
        parsed?.threads ?? [],
        Arr.filter(
          (thread) =>
            typeof thread?.environmentId === "string" &&
            thread.environmentId.length > 0 &&
            typeof thread.threadId === "string" &&
            thread.threadId.length > 0 &&
            typeof thread.title === "string",
        ),
      ),
    ),
  );

  return MobileStorage.of({
    loadOrCreateClientId,
    loadRecentThreadShortcuts,
    saveRecentThreadShortcuts: (threads) => writeJson(RECENT_THREAD_SHORTCUTS_KEY, { threads }),
  });
});

export const layer = Layer.effect(MobileStorage, make());
