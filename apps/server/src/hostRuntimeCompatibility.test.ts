import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/host-runtime/process";
import * as HostPty from "@t3tools/host-runtime/pty";
import * as HostVcs from "@t3tools/host-runtime/vcs";

import * as ProcessRunner from "./processRunner.ts";
import { collectUint8StreamText } from "./stream/collectUint8StreamText.ts";
import * as PtyAdapter from "./terminal/PtyAdapter.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";

it("keeps upstream server paths as thin exports of shared host primitives", () => {
  expect(ProcessRunner.ProcessRunner).toBe(HostProcess.ProcessRunner);
  expect(ProcessRunner.make).toBe(HostProcess.make);
  expect(collectUint8StreamText).toBe(HostProcess.collectUint8StreamText);
  expect(VcsProcess.VcsProcess).toBe(HostVcs.VcsProcess);
  expect(VcsProcess.make).toBe(HostVcs.make);
  expect(PtyAdapter.PtySpawnError).toBe(HostPty.PtySpawnError);
});
