import { describe, expect, it } from "vite-plus/test";

import { CocoaClientError } from "../src/errors.ts";
import { recoverShell } from "../src/recovery.ts";
import type { CocoaClientTransport } from "../src/transport.ts";
import { items, shellItem, shellSnapshot } from "./fixtures.ts";

function recoveryTransport(streamItems: ReadonlyArray<unknown>): CocoaClientTransport {
  return {
    state: { status: "connected", attempt: 1 },
    request: async () => shellSnapshot(5),
    subscribeShell: () => items(streamItems),
    subscribeThread: () => items([]),
    reconnect: async () => {},
    close: async () => {},
  } as unknown as CocoaClientTransport;
}

describe("Cocoa recovery helpers", () => {
  it("deduplicates snapshot overlap and waits for replay completion", async () => {
    const transport = recoveryTransport([
      shellItem(5),
      shellItem(6),
      { kind: "synchronized" },
      shellItem(7),
    ]);
    const recovery = await recoverShell(transport);
    const iterator = recovery[Symbol.asyncIterator]();

    expect(recovery.snapshot.snapshotSequence).toBe(5);
    expect(recovery.cursor).toBe(6);
    expect((await iterator.next()).value).toEqual({ kind: "item", item: shellItem(6) });
    expect((await iterator.next()).value).toEqual({ kind: "item", item: shellItem(7) });
    expect(recovery.cursor).toBe(7);
  });

  it("adopts an authoritative snapshot when the cursor is stale", async () => {
    const reset = shellSnapshot(20);
    const recovery = await recoverShell(
      recoveryTransport([
        { kind: "snapshot", snapshot: reset },
        { kind: "synchronized" },
        shellItem(21),
      ]),
    );
    const iterator = recovery[Symbol.asyncIterator]();

    expect(recovery.snapshot).toBe(reset);
    expect(recovery.cursor).toBe(20);
    expect((await iterator.next()).value).toEqual({ kind: "reset", snapshot: reset });
    expect((await iterator.next()).value).toEqual({ kind: "item", item: shellItem(21) });
  });

  it("fails when the server ends before the completion marker", async () => {
    await expect(recoverShell(recoveryTransport([shellItem(6)]))).rejects.toBeInstanceOf(
      CocoaClientError,
    );
  });
});
