import {
  createAuthEnvironmentAtoms,
  EMPTY_AUTH_ACCESS_SNAPSHOT,
} from "@t3tools/client-runtime/state/auth";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

export const authEnvironment = createAuthEnvironmentAtoms(connectionAtomRuntime);

export const primaryAuthAccessAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return EMPTY_AUTH_ACCESS_SNAPSHOT;

  return Option.match(
    AsyncResult.value(
      get(
        authEnvironment.accessChanges({
          environmentId,
          input: null,
        }),
      ),
    ),
    {
      onNone: () => EMPTY_AUTH_ACCESS_SNAPSHOT,
      onSome: (event) => (event.type === "snapshot" ? event.payload : EMPTY_AUTH_ACCESS_SNAPSHOT),
    },
  );
}).pipe(Atom.withLabel("web-primary-auth-access"));
