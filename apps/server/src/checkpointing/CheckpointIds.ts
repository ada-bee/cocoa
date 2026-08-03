/**
 * Deterministic identities for durable provider checkpoint intents.
 *
 * These UUID namespaces are part of Cocoa's persisted identity format. They
 * were derived once with UUIDv5(DNS, `xyz.brbc.cocoa.checkpoint.<kind>.v1`)
 * and must not be changed after release. A distinct namespace for every
 * logical checkpoint and operation kind prevents cross-kind collisions.
 *
 * Raw identifiers never become UUID names. Inputs are length-framed and
 * SHA-256 hashed first, so the UUIDv5 name is always a bounded 64-byte ASCII
 * digest and cannot retain provider-host paths or other sensitive input text.
 */
import {
  CodexCheckpointHelperCheckpointId,
  CodexCheckpointHelperOperationId,
  CodexCheckpointHelperUuid,
  CommandId,
  EventId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type CodexCheckpointHelperCheckpointId as CheckpointId,
  type CodexCheckpointHelperOperationId as OperationId,
  type CodexCheckpointHelperUuid as CheckpointUuid,
  type CommandId as CommandIdType,
  type EventId as EventIdType,
  type ProviderInstanceId as ProviderInstanceIdType,
  type ThreadId as ThreadIdType,
  type TurnId as TurnIdType,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

const UUID_V5_NAME_MAX_BYTES = 4_096;
const IDENTITY_COMPONENT_MAX_BYTES = 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const BASELINE_LOGICAL_NAMESPACE = "286f913f-b44b-5b69-acbd-21d0bccc4170";
const BASELINE_OPERATION_NAMESPACE = "288cfd89-18e6-5101-a441-d5f3804f68f2";
const POST_TURN_LOGICAL_NAMESPACE = "2d1e2676-2f5a-51fb-a9d0-c3b01f74350d";
const POST_TURN_OPERATION_NAMESPACE = "954c045f-93f6-5a5e-8a07-1ebcda4a7250";
const RESTORE_OPERATION_NAMESPACE = "7e866216-0278-54d2-bb34-4a121796a159";
const DELETE_OPERATION_NAMESPACE = "3cd42963-3720-5a5a-9e2a-ceaa21fd8ba8";

export type CheckpointIdentityInputField =
  | "namespace"
  | "name"
  | "providerInstanceId"
  | "threadId"
  | "sourceCommandId"
  | "sourceEventId"
  | "providerTurnId"
  | "revertEventId"
  | "batchOrdinal";

export type CheckpointIdentityInputErrorReason = "invalid" | "oversize" | "invalid_unicode";

/** Error messages identify the field but deliberately never echo its value. */
export class CheckpointIdentityInputError extends Error {
  readonly _tag = "CheckpointIdentityInputError";
  readonly field: CheckpointIdentityInputField;
  readonly reason: CheckpointIdentityInputErrorReason;

  constructor(field: CheckpointIdentityInputField, reason: CheckpointIdentityInputErrorReason) {
    super(`Invalid checkpoint identity ${field}: ${reason}.`);
    this.name = "CheckpointIdentityInputError";
    this.field = field;
    this.reason = reason;
  }
}

const hasUnpairedSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
};

const utf8 = (field: CheckpointIdentityInputField, value: string, maxBytes: number): Buffer => {
  if (hasUnpairedSurrogate(value)) {
    throw new CheckpointIdentityInputError(field, "invalid_unicode");
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > maxBytes) {
    throw new CheckpointIdentityInputError(field, "oversize");
  }
  return bytes;
};

/** Standards-correct RFC UUIDv5 over the UTF-8 encoding of `name`. */
export const uuidV5 = (namespace: string, name: string): CheckpointUuid => {
  if (!UUID_PATTERN.test(namespace)) {
    throw new CheckpointIdentityInputError("namespace", "invalid");
  }
  const nameBytes = utf8("name", name, UUID_V5_NAME_MAX_BYTES);
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const digest = NodeCrypto.createHash("sha1").update(namespaceBytes).update(nameBytes).digest();

  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;

  const hex = digest.subarray(0, 16).toString("hex");
  return CodexCheckpointHelperUuid.make(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
};

type IdentityComponent = readonly [field: CheckpointIdentityInputField, value: string];

const identityName = (...components: ReadonlyArray<IdentityComponent>): string => {
  const hash = NodeCrypto.createHash("sha256");
  hash.update("cocoa-checkpoint-identity-v1\0", "utf8");
  for (const [field, value] of components) {
    const fieldBytes = Buffer.from(field, "utf8");
    const bytes = utf8(field, value, IDENTITY_COMPONENT_MAX_BYTES);
    const fieldLength = Buffer.allocUnsafe(4);
    const valueLength = Buffer.allocUnsafe(4);
    fieldLength.writeUInt32BE(fieldBytes.byteLength);
    valueLength.writeUInt32BE(bytes.byteLength);
    hash.update(fieldLength).update(fieldBytes).update(valueLength).update(bytes);
  }
  return hash.digest("hex");
};

const isProviderInstanceId = Schema.is(ProviderInstanceId);
const isThreadId = Schema.is(ThreadId);
const isCommandId = Schema.is(CommandId);
const isEventId = Schema.is(EventId);
const isTurnId = Schema.is(TurnId);

const checkedComponent = <A extends string>(
  field: CheckpointIdentityInputField,
  value: A,
  isValid: (input: unknown) => input is A,
): A => {
  if (!isValid(value)) throw new CheckpointIdentityInputError(field, "invalid");
  utf8(field, value, IDENTITY_COMPONENT_MAX_BYTES);
  return value;
};

export interface BaselineCheckpointIdentityInput {
  readonly providerInstanceId: ProviderInstanceIdType;
  readonly threadId: ThreadIdType;
  /** Stable ID of the accepted turn-start command. */
  readonly sourceCommandId: CommandIdType;
}

export interface BaselineCheckpointEventFallbackIdentityInput {
  readonly providerInstanceId: ProviderInstanceIdType;
  readonly threadId: ThreadIdType;
  /** Explicit fallback for historical events that lack a stable command ID. */
  readonly sourceEventId: EventIdType;
}

export interface PostTurnCheckpointIdentityInput {
  readonly providerInstanceId: ProviderInstanceIdType;
  readonly threadId: ThreadIdType;
  /** Provider-native turn identity; a Cocoa runtime event ID must not be substituted. */
  readonly providerTurnId: TurnIdType;
}

export interface RestoreCheckpointOperationIdentityInput {
  readonly revertEventId: EventIdType;
}

export interface DeleteCheckpointOperationIdentityInput {
  readonly revertEventId: EventIdType;
  readonly batchOrdinal: number;
}

export interface CaptureCheckpointIdentity {
  readonly logicalCheckpointId: CheckpointId;
  readonly operationId: OperationId;
}

const captureIdentity = (
  logicalNamespace: string,
  operationNamespace: string,
  components: ReadonlyArray<IdentityComponent>,
): CaptureCheckpointIdentity => {
  const name = identityName(...components);
  return {
    logicalCheckpointId: CodexCheckpointHelperCheckpointId.make(uuidV5(logicalNamespace, name)),
    operationId: CodexCheckpointHelperOperationId.make(uuidV5(operationNamespace, name)),
  };
};

export const makeBaselineCheckpointIdentity = (
  input: BaselineCheckpointIdentityInput,
): CaptureCheckpointIdentity =>
  captureIdentity(BASELINE_LOGICAL_NAMESPACE, BASELINE_OPERATION_NAMESPACE, [
    [
      "providerInstanceId",
      checkedComponent("providerInstanceId", input.providerInstanceId, isProviderInstanceId),
    ],
    ["threadId", checkedComponent("threadId", input.threadId, isThreadId)],
    ["sourceCommandId", checkedComponent("sourceCommandId", input.sourceCommandId, isCommandId)],
  ]);

/**
 * Historical fallback only. New turn-start flows must use
 * `makeBaselineCheckpointIdentity` with the stable source command ID.
 */
export const makeBaselineCheckpointIdentityFromEvent = (
  input: BaselineCheckpointEventFallbackIdentityInput,
): CaptureCheckpointIdentity =>
  captureIdentity(BASELINE_LOGICAL_NAMESPACE, BASELINE_OPERATION_NAMESPACE, [
    [
      "providerInstanceId",
      checkedComponent("providerInstanceId", input.providerInstanceId, isProviderInstanceId),
    ],
    ["threadId", checkedComponent("threadId", input.threadId, isThreadId)],
    ["sourceEventId", checkedComponent("sourceEventId", input.sourceEventId, isEventId)],
  ]);

export const makePostTurnCheckpointIdentity = (
  input: PostTurnCheckpointIdentityInput,
): CaptureCheckpointIdentity =>
  captureIdentity(POST_TURN_LOGICAL_NAMESPACE, POST_TURN_OPERATION_NAMESPACE, [
    [
      "providerInstanceId",
      checkedComponent("providerInstanceId", input.providerInstanceId, isProviderInstanceId),
    ],
    ["threadId", checkedComponent("threadId", input.threadId, isThreadId)],
    ["providerTurnId", checkedComponent("providerTurnId", input.providerTurnId, isTurnId)],
  ]);

export const makeRestoreCheckpointOperationId = (
  input: RestoreCheckpointOperationIdentityInput,
): OperationId => {
  const name = identityName([
    "revertEventId",
    checkedComponent("revertEventId", input.revertEventId, isEventId),
  ]);
  return CodexCheckpointHelperOperationId.make(uuidV5(RESTORE_OPERATION_NAMESPACE, name));
};

export const makeDeleteCheckpointOperationId = (
  input: DeleteCheckpointOperationIdentityInput,
): OperationId => {
  if (!Number.isSafeInteger(input.batchOrdinal) || input.batchOrdinal < 0) {
    throw new CheckpointIdentityInputError("batchOrdinal", "invalid");
  }
  const name = identityName(
    ["revertEventId", checkedComponent("revertEventId", input.revertEventId, isEventId)],
    ["batchOrdinal", input.batchOrdinal.toString(10)],
  );
  return CodexCheckpointHelperOperationId.make(uuidV5(DELETE_OPERATION_NAMESPACE, name));
};
