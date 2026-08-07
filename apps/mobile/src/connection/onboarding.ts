import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectGateway = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:connect-gateway",
  scheduler: onboardingScheduler,
  concurrency: { mode: "singleFlight", key: (httpBaseUrl: string) => httpBaseUrl },
  execute: (httpBaseUrl: string) =>
    ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerDirect({ httpBaseUrl })),
    ),
});

export const updateDirectConnection = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:update-direct",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly environmentId: EnvironmentId }) => input.environmentId,
  },
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly httpBaseUrl: string;
  }) => ConnectionOnboarding.pipe(Effect.flatMap((onboarding) => onboarding.updateDirect(input))),
});
