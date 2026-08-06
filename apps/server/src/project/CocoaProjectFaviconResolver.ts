import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectFaviconResolver } from "./ProjectFaviconResolverService.ts";

/** Remote projects have no gateway-local favicon path. */
export const layer = Layer.succeed(
  ProjectFaviconResolver,
  ProjectFaviconResolver.of({ resolvePath: () => Effect.succeed(null) }),
);
