import * as Layer from "effect/Layer";

import { layerConfig as SqlitePersistenceLayer } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

export const storageLayer = Layer.mergeAll(ServerSecretStore.layer, SqlitePersistenceLayer);

export const runtimeLayer = EnvironmentAuth.layer.pipe(Layer.provideMerge(storageLayer));
