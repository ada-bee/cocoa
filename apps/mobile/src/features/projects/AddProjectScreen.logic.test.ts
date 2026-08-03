import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveAddProjectEnvironment,
  resolveAddProjectProviderSelection,
} from "./AddProjectScreen.logic";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");

function environment(environmentId: EnvironmentId, connectionState: EnvironmentConnectionPhase) {
  return { environmentId, connectionState };
}

describe("resolveAddProjectEnvironment", () => {
  it("does not redirect an explicit unavailable environment to another environment", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "offline"), environment(ENVIRONMENT_B, "connected")],
        ENVIRONMENT_A,
      ),
    ).toBeNull();
  });

  it("resolves an explicit connected environment", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "connected"), environment(ENVIRONMENT_B, "connected")],
        ENVIRONMENT_A,
      )?.environmentId,
    ).toBe(ENVIRONMENT_A);
  });

  it("defaults to the first connected environment when no environment is requested", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "offline"), environment(ENVIRONMENT_B, "connected")],
        null,
      )?.environmentId,
    ).toBe(ENVIRONMENT_B);
  });
});

describe("resolveAddProjectProviderSelection", () => {
  const personal = {
    instanceId: ProviderInstanceId.make("personal"),
    enabled: true,
    installed: true,
  };
  const work = {
    instanceId: ProviderInstanceId.make("work"),
    enabled: true,
    installed: true,
  };
  const team = {
    instanceId: ProviderInstanceId.make("team"),
    enabled: true,
    installed: true,
  };

  it("requires an explicit choice when multiple endpoints are available", () => {
    expect(resolveAddProjectProviderSelection([personal, work], null)).toMatchObject({
      selectedProviderInstanceId: null,
      requiresSelection: true,
    });
  });

  it("preserves a valid choice across provider snapshot refreshes", () => {
    expect(
      resolveAddProjectProviderSelection([{ ...personal }, { ...work }], work.instanceId),
    ).toMatchObject({
      selectedProviderInstanceId: work.instanceId,
      requiresSelection: false,
    });
  });

  it("clears a choice that is no longer available", () => {
    expect(
      resolveAddProjectProviderSelection(
        [personal, { ...work, enabled: false }, team],
        work.instanceId,
      ),
    ).toMatchObject({
      selectedProviderInstanceId: null,
      requiresSelection: true,
    });
  });
});
