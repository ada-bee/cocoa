#!/usr/bin/env bun
// @effect-diagnostics nodeBuiltinImport:off - This build-and-test harness runs before an Effect application exists.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPOSITORY_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const HELPER_MANIFEST = "native/cocoa-workspace-helper/Cargo.toml";
const HELPER_BIN = NodePath.join(
  REPOSITORY_ROOT,
  "native/cocoa-workspace-helper/target/debug/cocoa-workspace-helper",
);
const HELPER_BIN_RELATIVE = "native/cocoa-workspace-helper/target/debug/cocoa-workspace-helper";
const ACCEPTANCE_TEST =
  "apps/server/integration/cocoaCheckpointHelperDurability.integration.test.ts";
const VP = NodePath.join(REPOSITORY_ROOT, "node_modules/.bin/vp");

const run = async (command: ReadonlyArray<string>, env = process.env): Promise<void> => {
  const executable = command[0];
  if (executable === undefined) throw new Error("Acceptance command had no executable.");
  const child = NodeChildProcess.spawn(executable, command.slice(1), {
    cwd: REPOSITORY_ROOT,
    env,
    stdio: "inherit",
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null) resolve(code);
      else reject(new Error(`${executable} exited after signal ${signal ?? "unknown"}.`));
    });
  });
  if (exitCode !== 0) {
    throw new Error(`${executable} exited with status ${exitCode}.`);
  }
};

if (!NodeFS.existsSync(VP)) {
  throw new Error("Install workspace dependencies with `vp i` before running acceptance.");
}

await run([
  "nix-shell",
  "-p",
  "cargo",
  "rustc",
  "git",
  "nodejs_24",
  "--run",
  [
    `cargo build --locked --manifest-path ${HELPER_MANIFEST}`,
    `COCOA_WORKSPACE_HELPER_BIN=${HELPER_BIN_RELATIVE} ${NodePath.relative(REPOSITORY_ROOT, VP)} test run ${ACCEPTANCE_TEST}`,
  ].join(" && "),
]);

if (!NodeFS.existsSync(HELPER_BIN)) {
  throw new Error(`Native helper build did not produce ${HELPER_BIN}.`);
}
