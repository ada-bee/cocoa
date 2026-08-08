import { PROVIDER_HOST_ICONS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterProviderHostIconOptions,
  PROVIDER_HOST_ICON_OPTIONS,
} from "./ProviderHostAppearanceDialog";
import { PROVIDER_HOST_ICON_COMPONENTS } from "../ProviderHostIcon";

describe("provider host appearance icon catalog", () => {
  it("maps every contract icon exactly once", () => {
    expect(PROVIDER_HOST_ICON_OPTIONS.map((option) => option.id)).toEqual(PROVIDER_HOST_ICONS);
    expect(Object.keys(PROVIDER_HOST_ICON_COMPONENTS)).toEqual(PROVIDER_HOST_ICONS);
  });

  it("searches icon labels and infrastructure aliases", () => {
    expect(filterProviderHostIconOptions("docker").map((option) => option.id)).toEqual([
      "container",
    ]);
    expect(filterProviderHostIconOptions("computer").map((option) => option.id)).toEqual([
      "monitor",
      "laptop",
    ]);
    expect(filterProviderHostIconOptions("does-not-exist")).toEqual([]);
  });
});
