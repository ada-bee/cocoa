import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServiceLauncherClient from "../../cloud/serviceLauncherClient.ts";
import { ServerConfig } from "../../config.ts";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./SqliteCore.ts";

export { makeSqlitePersistenceLive, SqlitePersistenceMemory };

/** Legacy profile preserves hosted service-launcher trial-database behavior. */
export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const launcher = yield* ServiceLauncherClient.resolveServiceLauncherMode();
    return makeSqlitePersistenceLive(dbPath, { trial: launcher.trial });
  }),
);
