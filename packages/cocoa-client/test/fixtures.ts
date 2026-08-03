import type {
  CocoaClientV1InfoResponse,
  CocoaClientV1ShellSnapshot,
  CocoaClientV1ShellStreamItem,
} from "@t3tools/contracts/client/v1";

export const testInfo = {
  protocolVersion: 1,
  protocolRange: { minimum: 1, maximum: 1 },
  capabilities: ["orchestration.core", "orchestration.search"],
  environment: {
    environmentId: "gateway-test",
    label: "Test Gateway",
    serverVersion: "0.0.31",
  },
  providers: [],
} as unknown as CocoaClientV1InfoResponse;

export function shellSnapshot(snapshotSequence: number): CocoaClientV1ShellSnapshot {
  return {
    snapshotSequence,
    projects: [],
    threads: [],
    updatedAt: "2026-08-04T00:00:00.000Z",
  } as CocoaClientV1ShellSnapshot;
}

export function shellItem(sequence: number): CocoaClientV1ShellStreamItem {
  return {
    kind: "project-removed",
    sequence,
    projectId: `project-${sequence}`,
  } as CocoaClientV1ShellStreamItem;
}

export async function* items<T>(values: ReadonlyArray<T>): AsyncIterable<T> {
  yield* values;
}
