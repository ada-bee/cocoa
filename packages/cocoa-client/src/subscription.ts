import type {
  CocoaClientV1ShellStreamItem,
  CocoaClientV1SubscribeShellInput,
  CocoaClientV1SubscribeThreadInput,
  CocoaClientV1ThreadStreamItem,
} from "@t3tools/contracts/client/v1";

import { CocoaClientError, CocoaClientRequestError } from "./errors.ts";
import type { DisposableAsyncIterable } from "./public-types.ts";
import type { CocoaClientTransport } from "./transport.ts";

type ResumableItem = CocoaClientV1ShellStreamItem | CocoaClientV1ThreadStreamItem;

export function cocoaStreamItemSequence(item: ResumableItem): number | undefined {
  if (item.kind === "snapshot") return item.snapshot.snapshotSequence;
  if (item.kind === "event") return item.event.sequence;
  if ("sequence" in item) return item.sequence;
  return undefined;
}

export class CocoaSubscription<Item extends ResumableItem>
  implements DisposableAsyncIterable<Item>, AsyncIterator<Item>
{
  readonly #transport: CocoaClientTransport;
  readonly #open: (afterSequence: number | undefined) => AsyncIterable<Item>;
  #iterator: AsyncIterator<Item> | undefined;
  #cursor: number | undefined;
  #closed = false;
  #generation = 0;

  constructor(input: {
    readonly transport: CocoaClientTransport;
    readonly afterSequence?: number;
    readonly open: (afterSequence: number | undefined) => AsyncIterable<Item>;
  }) {
    this.#transport = input.transport;
    this.#cursor = input.afterSequence;
    this.#open = input.open;
  }

  get closed(): boolean {
    return this.#closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<Item> {
    return this;
  }

  async next(): Promise<IteratorResult<Item>> {
    if (this.#closed) return { done: true, value: undefined };
    const generation = this.#generation;
    if (this.#iterator === undefined) {
      this.#iterator = this.#open(this.#cursor)[Symbol.asyncIterator]();
    }
    let result: IteratorResult<Item>;
    try {
      result = await this.#iterator.next();
    } catch (error) {
      if (
        error instanceof CocoaClientRequestError &&
        error.remoteCode === "reset_required" &&
        error.retryable
      ) {
        // The server intentionally terminated a bounded live tail. Discard the
        // cursor so reconnect requests a fresh authoritative snapshot instead
        // of assuming the live gap can be resumed incrementally.
        this.#cursor = undefined;
      }
      throw error;
    }
    if (generation !== this.#generation) return this.next();
    if (!result.done) {
      const sequence = cocoaStreamItemSequence(result.value);
      if (sequence !== undefined) this.#cursor = Math.max(this.#cursor ?? -1, sequence);
    }
    return result;
  }

  async reconnect(): Promise<void> {
    if (this.#closed) throw new CocoaClientError("closed", "The Cocoa subscription is closed.");
    this.#generation += 1;
    const iterator = this.#iterator;
    this.#iterator = undefined;
    if (iterator?.return !== undefined) await iterator.return();
    await this.#transport.reconnect();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    const iterator = this.#iterator;
    this.#iterator = undefined;
    if (iterator?.return !== undefined) await iterator.return();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export function subscribeToShell(
  transport: CocoaClientTransport,
  input: CocoaClientV1SubscribeShellInput = {},
): CocoaSubscription<CocoaClientV1ShellStreamItem> {
  const { afterSequence: _initialAfterSequence, ...baseInput } = input;
  return new CocoaSubscription({
    transport,
    ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
    open: (afterSequence) =>
      transport.subscribeShell({
        ...baseInput,
        ...(afterSequence === undefined ? {} : { afterSequence }),
      }),
  });
}

export function subscribeToThread(
  transport: CocoaClientTransport,
  input: CocoaClientV1SubscribeThreadInput,
): CocoaSubscription<CocoaClientV1ThreadStreamItem> {
  const { afterSequence: _initialAfterSequence, ...baseInput } = input;
  return new CocoaSubscription({
    transport,
    ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
    open: (afterSequence) =>
      transport.subscribeThread({
        ...baseInput,
        ...(afterSequence === undefined ? {} : { afterSequence }),
      }),
  });
}
