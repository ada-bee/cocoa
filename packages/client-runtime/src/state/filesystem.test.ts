import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  appendFilesystemBrowseLeaf,
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
  getFilesystemBrowseLocator,
  getFilesystemBrowseInput,
} from "./filesystem.ts";

describe("filesystem browse model", () => {
  it("derives the browse target and navigation state", () => {
    expect(getFilesystemBrowsePath("~/projects/t3")).toEqual({
      isBrowsing: true,
      directoryPath: "~/projects/",
      filterQuery: "t3",
      parentPath: "~/",
      canBrowseUp: true,
      locator: { kind: "home", relativePath: "projects" },
    });
    expect(getFilesystemBrowsePath("/srv/work/").locator).toEqual({
      kind: "absolute",
      path: "/srv/work",
    });
    expect(getFilesystemBrowsePath("C:\\Users\\test").isBrowsing).toBe(false);
    expect(getFilesystemBrowsePath("./projects").isBrowsing).toBe(false);
    expect(getFilesystemBrowsePath("../projects").isBrowsing).toBe(false);
    expect(getFilesystemBrowsePath("projects").isBrowsing).toBe(false);
    expect(getFilesystemBrowsePath("~/projects/", false).isBrowsing).toBe(false);
  });

  it("accepts only normalized provider locators", () => {
    expect(getFilesystemBrowseLocator("~/code/")).toEqual({
      kind: "home",
      relativePath: "code",
    });
    expect(getFilesystemBrowseLocator("~/work/../code/")).toBeNull();
    expect(getFilesystemBrowseLocator("~/../etc/")).toBeNull();
    expect(getFilesystemBrowseLocator("/srv/../work/")).toBeNull();
    expect(getFilesystemBrowseLocator("/srv//work/")).toBeNull();
    expect(getFilesystemBrowseLocator("/srv\\work/")).toBeNull();
  });

  it("composes a typed leaf only under a provider-resolved absolute directory", () => {
    expect(appendFilesystemBrowseLeaf("/Users/ada/Code", "cocoa")).toBe("/Users/ada/Code/cocoa");
    expect(appendFilesystemBrowseLeaf("/", "srv")).toBe("/srv");
    expect(appendFilesystemBrowseLeaf("~/Code", "cocoa")).toBeNull();
    expect(appendFilesystemBrowseLeaf("/Users/ada", "../etc")).toBeNull();
  });

  it("keys every browse request to the selected provider", () => {
    const mac = getFilesystemBrowseInput(ProviderInstanceId.make("macbook"), "~/Code/");
    const linux = getFilesystemBrowseInput(ProviderInstanceId.make("rigatoni"), "~/Code/");

    expect(mac).toEqual({
      providerInstanceId: "macbook",
      locator: { kind: "home", relativePath: "Code" },
    });
    expect(linux).toEqual({
      providerInstanceId: "rigatoni",
      locator: { kind: "home", relativePath: "Code" },
    });
    expect(mac).not.toEqual(linux);
  });

  it("filters names, hidden directories, and exact matches consistently", () => {
    const entries = [{ name: ".config" }, { name: "Code" }, { name: "codething" }];

    expect(filterFilesystemBrowseEntries(entries, "co")).toEqual({
      visibleEntries: entries.slice(1, 3),
      exactEntry: null,
    });
    expect(filterFilesystemBrowseEntries(entries, "").visibleEntries).toEqual(entries.slice(1));
    expect(filterFilesystemBrowseEntries(entries, ".").visibleEntries).toEqual(entries.slice(0, 1));
    expect(filterFilesystemBrowseEntries(entries, "Code").exactEntry).toEqual(entries[1]);
  });
});

describe("browse navigation", () => {
  it("only commits the latest valid navigation", async () => {
    const navigation = createBrowseNavigationCoordinator();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const commits: string[] = [];
    const commit = (name: string) => () => commits.push(name);
    const firstRun = navigation.run(() => first.promise, commit("first"));
    const secondRun = navigation.run(() => second.promise, commit("second"));

    second.resolve();
    await expect(secondRun).resolves.toBe(true);
    first.resolve();
    await expect(firstRun).resolves.toBe(false);

    const invalidated = Promise.withResolvers<void>();
    const invalidatedRun = navigation.run(() => invalidated.promise, commit("stale"));
    navigation.invalidate();
    invalidated.resolve();

    await expect(invalidatedRun).resolves.toBe(false);
    expect(commits).toEqual(["second"]);
  });

  it("only preloads connected environments", () => {
    expect(canPreloadBrowsePath("connected")).toBe(true);
    expect(canPreloadBrowsePath("offline")).toBe(false);
    expect(canPreloadBrowsePath("reconnecting")).toBe(false);
    expect(canPreloadBrowsePath(null)).toBe(false);
  });
});
