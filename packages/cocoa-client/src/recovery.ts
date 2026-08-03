import type {
  CocoaClientV1GetThreadSnapshotInput,
  CocoaClientV1ShellSnapshot,
  CocoaClientV1ShellStreamItem,
  CocoaClientV1ThreadDetailSnapshot,
  CocoaClientV1ThreadStreamItem,
} from "@t3tools/contracts/client/v1";

import { CocoaClientError } from "./errors.ts";
import type { CocoaClientRecovery, CocoaClientRecoveryUpdate } from "./public-types.ts";
import {
  CocoaSubscription,
  cocoaStreamItemSequence,
  subscribeToShell,
  subscribeToThread,
} from "./subscription.ts";
import type { CocoaClientTransport } from "./transport.ts";

type RecoveryItem = CocoaClientV1ShellStreamItem | CocoaClientV1ThreadStreamItem;
type RecoverySnapshot = CocoaClientV1ShellSnapshot | CocoaClientV1ThreadDetailSnapshot;

class Recovery<Snapshot extends RecoverySnapshot, Item extends RecoveryItem>
  implements
    CocoaClientRecovery<Snapshot, Item>,
    AsyncIterator<CocoaClientRecoveryUpdate<Snapshot, Item>>
{
  readonly #subscription: CocoaSubscription<Item>;
  readonly #pending: Array<CocoaClientRecoveryUpdate<Snapshot, Item>> = [];
  #snapshot: Snapshot;
  #cursor: number;
  #closed = false;

  private constructor(snapshot: Snapshot, subscription: CocoaSubscription<Item>) {
    this.#snapshot = snapshot;
    this.#cursor = snapshot.snapshotSequence;
    this.#subscription = subscription;
  }

  static async make<Snapshot extends RecoverySnapshot, Item extends RecoveryItem>(
    snapshot: Snapshot,
    subscription: CocoaSubscription<Item>,
  ): Promise<Recovery<Snapshot, Item>> {
    const recovery = new Recovery(snapshot, subscription);
    await recovery.#consumeUntilSynchronized();
    return recovery;
  }

  get snapshot(): Snapshot {
    return this.#snapshot;
  }

  get cursor(): number {
    return this.#cursor;
  }

  get closed(): boolean {
    return this.#closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<CocoaClientRecoveryUpdate<Snapshot, Item>> {
    return this;
  }

  #accept(item: Item): CocoaClientRecoveryUpdate<Snapshot, Item> | undefined {
    if (item.kind === "synchronized") return undefined;
    if (item.kind === "snapshot") {
      this.#snapshot = item.snapshot as Snapshot;
      this.#cursor = item.snapshot.snapshotSequence;
      return { kind: "reset", snapshot: this.#snapshot };
    }
    const sequence = cocoaStreamItemSequence(item);
    if (sequence !== undefined && sequence <= this.#cursor) return undefined;
    if (sequence !== undefined) this.#cursor = sequence;
    return { kind: "item", item };
  }

  async #consumeUntilSynchronized(): Promise<void> {
    for (;;) {
      const result = await this.#subscription.next();
      if (result.done) {
        throw new CocoaClientError(
          "transport",
          "The Cocoa recovery stream ended before its synchronization marker.",
        );
      }
      if (result.value.kind === "synchronized") return;
      const update = this.#accept(result.value);
      if (update?.kind === "reset") this.#pending.length = 0;
      if (update !== undefined) this.#pending.push(update);
    }
  }

  async next(): Promise<IteratorResult<CocoaClientRecoveryUpdate<Snapshot, Item>>> {
    if (this.#pending.length > 0) return { done: false, value: this.#pending.shift()! };
    if (this.#closed) return { done: true, value: undefined };
    for (;;) {
      const result = await this.#subscription.next();
      if (result.done) return { done: true, value: undefined };
      const update = this.#accept(result.value);
      if (update !== undefined) return { done: false, value: update };
    }
  }

  async reconnect(): Promise<void> {
    if (this.#closed) throw new CocoaClientError("closed", "The Cocoa recovery stream is closed.");
    await this.#subscription.reconnect();
    await this.#consumeUntilSynchronized();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#subscription.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export async function recoverShell(
  transport: CocoaClientTransport,
): Promise<CocoaClientRecovery<CocoaClientV1ShellSnapshot, CocoaClientV1ShellStreamItem>> {
  const snapshot = await transport.request("orchestration.getShellSnapshot", {});
  const subscription = subscribeToShell(transport, {
    afterSequence: snapshot.snapshotSequence,
    requestCompletionMarker: true,
  });
  return Recovery.make(snapshot, subscription);
}

export async function recoverThread(
  transport: CocoaClientTransport,
  input: CocoaClientV1GetThreadSnapshotInput,
): Promise<CocoaClientRecovery<CocoaClientV1ThreadDetailSnapshot, CocoaClientV1ThreadStreamItem>> {
  const snapshot = await transport.request("orchestration.getThreadSnapshot", input);
  const subscription = subscribeToThread(transport, {
    threadId: input.threadId,
    afterSequence: snapshot.snapshotSequence,
    requestCompletionMarker: true,
  });
  return Recovery.make(snapshot, subscription);
}
