import { describe, expect, it } from "vite-plus/test";

import { CocoaClientError } from "../src/errors.ts";
import { subscribeToShell } from "../src/subscription.ts";
import type { CocoaClientTransport } from "../src/transport.ts";
import { items, shellItem } from "./fixtures.ts";

describe("Cocoa subscriptions", () => {
  it("resumes from its latest cursor after an explicit reconnect", async () => {
    const cursors: Array<number | undefined> = [];
    let reconnects = 0;
    const transport = {
      subscribeShell(input: { readonly afterSequence?: number }) {
        cursors.push(input.afterSequence);
        return items([shellItem((input.afterSequence ?? 2) + 1)]);
      },
      reconnect: async () => {
        reconnects += 1;
      },
    } as unknown as CocoaClientTransport;
    const subscription = subscribeToShell(transport, { afterSequence: 3 });

    expect((await subscription.next()).value).toMatchObject({ sequence: 4 });
    await subscription.reconnect();
    expect((await subscription.next()).value).toMatchObject({ sequence: 5 });
    expect(cursors).toEqual([3, 4]);
    expect(reconnects).toBe(1);
  });

  it("disposes the active iterator and stays closed", async () => {
    let finalized = false;
    async function* source() {
      try {
        yield shellItem(1);
        await new Promise<never>(() => {});
      } finally {
        finalized = true;
      }
    }
    const transport = {
      subscribeShell: () => source(),
      reconnect: async () => {},
    } as unknown as CocoaClientTransport;
    const subscription = subscribeToShell(transport);
    await subscription.next();
    await subscription.close();

    expect(finalized).toBe(true);
    expect((await subscription.next()).done).toBe(true);
    await expect(subscription.reconnect()).rejects.toBeInstanceOf(CocoaClientError);
  });
});
