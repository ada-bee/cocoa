import {
  type CodexCheckpointHelperConfig,
  CodexGitExecutablePath as CodexGitExecutablePathSchema,
  type CodexGitExecutablePath as CodexGitExecutablePathContract,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  PROVIDER_VCS_MAX_REFS,
  type ProviderVcsAdapter,
  type ProviderVcsChangedPath,
  ProviderVcsDisconnectedError,
  type ProviderVcsError,
  type ProviderVcsOperation,
  ProviderVcsOperationError,
  ProviderVcsPathError,
  ProviderVcsProtocolError,
  type ProviderVcsRef,
  type ProviderVcsRepository,
  type ProviderVcsReviewDiffSource,
  ProviderVcsUnsupportedError,
} from "../ProviderVcsAdapter.ts";
import type {
  CodexEndpointBorrowUnavailableError,
  CodexEndpointConnectionBorrow,
} from "../codexEndpoint/CodexEndpointSupervisor.ts";
import { makeCodexCheckpointHelperAdapter } from "./CodexCheckpointHelperAdapter.ts";

export const CodexGitExecutablePath = CodexGitExecutablePathSchema;
export type CodexGitExecutablePath = CodexGitExecutablePathContract;

export interface MakeCodexVcsAdapterOptions {
  readonly providerInstanceId: ProviderInstanceId;
  /** Administrator-configured absolute path. It is never discovered through PATH. */
  readonly gitExecutablePath: CodexGitExecutablePath;
  readonly checkpointHelper?: CodexCheckpointHelperConfig;
  readonly borrowConnection: Effect.Effect<
    CodexEndpointConnectionBorrow,
    CodexEndpointBorrowUnavailableError
  >;
}

export const CODEX_VCS_COMMAND_TIMEOUT_MS = 10_000;
export const CODEX_VCS_STATUS_OUTPUT_BYTES_CAP = 2 * 1024 * 1024;
export const CODEX_VCS_REFS_OUTPUT_BYTES_CAP = 2 * 1024 * 1024;
export const CODEX_VCS_REMOTES_OUTPUT_BYTES_CAP = 256 * 1024;
export const CODEX_VCS_OPEN_OUTPUT_BYTES_CAP = 16 * 1024;

export const CODEX_VCS_COMMAND_ENV = {
  LANG: "C",
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_EXTERNAL_DIFF: null,
} as const;

const GIT_CONFIG_PREFIX = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.pager=cat",
  "-c",
  "pager.status=false",
  "-c",
  "pager.branch=false",
  "-c",
  "pager.diff=false",
  "-c",
  "diff.external=",
  "-c",
  "diff.trustExitCode=false",
] as const;

const MAX_STATUS_PATH_BYTES = 4_096;
const MAX_REF_NAME_BYTES = 1_024;
const MAX_REMOTE_NAME_BYTES = 256;
const MAX_REMOTE_URL_BYTES = 8_192;

interface CommandOutput {
  readonly stdout: string;
  /** command/exec has no truncation bit, so equality is conservatively treated as capped. */
  readonly atOutputCap: boolean;
}

const isAbsoluteNormalizedPosixPath = (path: string): boolean => {
  if (!path.startsWith("/") || path.includes("\0") || path.includes("\\")) return false;
  if (path === "/") return true;
  if (path.endsWith("/") || path.includes("//")) return false;
  return path
    .split("/")
    .slice(1)
    .every((part) => part !== "" && part !== "." && part !== "..");
};

const disconnected = (providerInstanceId: ProviderInstanceId, operation: ProviderVcsOperation) =>
  new ProviderVcsDisconnectedError({ providerInstanceId, operation });
const unsupported = (providerInstanceId: ProviderInstanceId, operation: ProviderVcsOperation) =>
  new ProviderVcsUnsupportedError({ providerInstanceId, operation });
const protocol = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderVcsOperation,
  detail: string,
) => new ProviderVcsProtocolError({ providerInstanceId, operation, detail });
const operationFailed = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderVcsOperation,
  detail: string,
) => new ProviderVcsOperationError({ providerInstanceId, operation, detail });
const pathFailed = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderVcsOperation,
  providerHostPath: string,
  issue: string,
) =>
  new ProviderVcsPathError({
    providerInstanceId,
    operation,
    providerHostPath,
    issue,
  });

const isDisconnectedCodexError = (error: CodexErrors.CodexAppServerError): boolean =>
  error._tag === "CodexAppServerTransportError" ||
  error._tag === "CodexAppServerInputStreamEndedError" ||
  error._tag === "CodexAppServerProcessExitedError";

const mapCodexError = (
  providerInstanceId: ProviderInstanceId,
  operation: ProviderVcsOperation,
  error: CodexErrors.CodexAppServerError,
): ProviderVcsError => {
  if (isDisconnectedCodexError(error)) return disconnected(providerInstanceId, operation);
  if (error._tag === "CodexAppServerRequestError" && error.code === -32601) {
    return unsupported(providerInstanceId, operation);
  }
  if (
    error._tag === "CodexAppServerProtocolParseError" ||
    (error._tag === "CodexAppServerRequestError" && [-32700, -32600, -32602].includes(error.code))
  ) {
    return protocol(providerInstanceId, operation, "Codex rejected the Git command protocol.");
  }
  return operationFailed(providerInstanceId, operation, "Codex could not run the Git command.");
};

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;
const isBoundedField = (value: string, maxBytes: number): boolean =>
  value !== "" && !value.includes("\0") && utf8Length(value) <= maxBytes;
const isNormalizedRepositoryPath = (value: string): boolean =>
  isBoundedField(value, MAX_STATUS_PATH_BYTES) &&
  !value.startsWith("/") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..");

const clipUtf8 = (
  value: string,
  maxBytes: number,
): { value: string; bytes: number; clipped: boolean } => {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return { value, bytes: encoded.byteLength, clipped: false };
  let end = maxBytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      const clipped = decoder.decode(encoded.slice(0, end));
      return { value: clipped, bytes: end, clipped: true };
    } catch {
      end -= 1;
    }
  }
  return { value: "", bytes: 0, clipped: true };
};

const completeNulRecords = (
  value: string,
  capped: boolean,
): {
  records: ReadonlyArray<string>;
  truncated: boolean;
  malformed: boolean;
} => {
  const records = value.split("\0");
  const hasTerminator = records.at(-1) === "";
  if (hasTerminator) records.pop();
  else if (capped) records.pop();
  return {
    records,
    truncated: capped,
    malformed: !capped && !hasTerminator && value !== "",
  };
};

const statusKind = (
  xy: string,
  explicit?: "renamed" | "copied",
): ProviderVcsChangedPath["kind"] => {
  if (explicit !== undefined) return explicit;
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "conflicted";
  if (xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("C")) return "copied";
  if (xy.includes("M") || xy.includes("T")) return "modified";
  return "other";
};

const parseStatusPath = (
  record: string,
  metadataFieldCount: number,
): { xy: string; path: string } | undefined => {
  if (record.length < 5 || record[1] !== " " || record[4] !== " ") return undefined;
  const xy = record.slice(2, 4);
  let offset = 5;
  for (let index = 0; index < metadataFieldCount; index += 1) {
    const separator = record.indexOf(" ", offset);
    if (separator < 0) return undefined;
    offset = separator + 1;
  }
  const path = record.slice(offset);
  return path === "" ? undefined : { xy, path };
};

const parseStatus = (
  providerInstanceId: ProviderInstanceId,
  stdout: string,
  atOutputCap: boolean,
  maxChangedPaths: number,
): Effect.Effect<
  ReturnType<ProviderVcsRepository["getStatus"]> extends Effect.Effect<infer A, any> ? A : never,
  ProviderVcsProtocolError
> =>
  Effect.gen(function* () {
    const nul = completeNulRecords(stdout, atOutputCap);
    if (nul.malformed) {
      return yield* protocol(
        providerInstanceId,
        "getStatus",
        "Git status output was not NUL terminated.",
      );
    }
    let oid: string | undefined;
    let branch: string | undefined;
    let upstreamRef: string | null = null;
    let aheadCount = 0;
    let behindCount = 0;
    const changedPaths: Array<ProviderVcsChangedPath> = [];
    let truncated = nul.truncated;

    for (let index = 0; index < nul.records.length; index += 1) {
      const record = nul.records[index]!;
      if (record.startsWith("# branch.oid ")) {
        oid = record.slice(13);
        continue;
      }
      if (record.startsWith("# branch.head ")) {
        branch = record.slice(14);
        continue;
      }
      if (record.startsWith("# branch.upstream ")) {
        upstreamRef = record.slice(18);
        continue;
      }
      if (record.startsWith("# branch.ab ")) {
        const match = /^# branch\.ab \+([0-9]+) -([0-9]+)$/.exec(record);
        if (match === null) {
          return yield* protocol(
            providerInstanceId,
            "getStatus",
            "Git status branch counts were malformed.",
          );
        }
        aheadCount = Number(match[1]);
        behindCount = Number(match[2]);
        continue;
      }

      let parsed: ProviderVcsChangedPath | undefined;
      if (record.startsWith("? ")) {
        const path = record.slice(2);
        if (!isNormalizedRepositoryPath(path))
          return yield* protocol(
            providerInstanceId,
            "getStatus",
            "Git status contained an invalid path.",
          );
        parsed = {
          path,
          kind: "untracked",
          staged: false,
          unstaged: true,
          additions: null,
          deletions: null,
        };
      } else if (record.startsWith("! ")) {
        continue;
      } else if (record.startsWith("u ")) {
        const entry = parseStatusPath(record, 8);
        if (entry === undefined || !isNormalizedRepositoryPath(entry.path))
          return yield* protocol(
            providerInstanceId,
            "getStatus",
            "Git status contained a malformed unmerged entry.",
          );
        parsed = {
          path: entry.path,
          kind: "conflicted",
          staged: true,
          unstaged: true,
          additions: null,
          deletions: null,
        };
      } else if (record.startsWith("1 ")) {
        const entry = parseStatusPath(record, 6);
        if (entry === undefined || !isNormalizedRepositoryPath(entry.path))
          return yield* protocol(
            providerInstanceId,
            "getStatus",
            "Git status contained a malformed ordinary entry.",
          );
        parsed = {
          path: entry.path,
          kind: statusKind(entry.xy),
          staged: entry.xy[0] !== ".",
          unstaged: entry.xy[1] !== ".",
          additions: null,
          deletions: null,
        };
      } else if (record.startsWith("2 ")) {
        const entry = parseStatusPath(record, 7);
        const previousPath = nul.records[index + 1];
        if (
          entry === undefined ||
          !isNormalizedRepositoryPath(entry.path) ||
          previousPath === undefined ||
          !isNormalizedRepositoryPath(previousPath)
        ) {
          return yield* protocol(
            providerInstanceId,
            "getStatus",
            "Git status contained a malformed rename entry.",
          );
        }
        index += 1;
        const kind = entry.xy.includes("C") ? "copied" : "renamed";
        parsed = {
          path: entry.path,
          previousPath,
          kind,
          staged: entry.xy[0] !== ".",
          unstaged: entry.xy[1] !== ".",
          additions: null,
          deletions: null,
        };
      } else {
        return yield* protocol(
          providerInstanceId,
          "getStatus",
          "Git status contained an unknown record.",
        );
      }
      if (changedPaths.length < maxChangedPaths) changedPaths.push(parsed);
      else truncated = true;
    }

    if (oid === undefined || branch === undefined) {
      return yield* protocol(
        providerInstanceId,
        "getStatus",
        "Git status omitted branch identity.",
      );
    }
    const head =
      oid === "(initial)"
        ? ({ _tag: "Unborn" } as const)
        : branch === "(detached)"
          ? ({ _tag: "Detached", commit: oid } as const)
          : ({ _tag: "Branch", name: branch, commit: oid } as const);
    return {
      head,
      defaultRef: null,
      upstreamRef,
      aheadCount,
      behindCount,
      hasPrimaryRemote: upstreamRef !== null,
      hasWorkingTreeChanges: changedPaths.length > 0 || truncated,
      changedPaths,
      truncated,
    };
  });

const parseRefs = (
  providerInstanceId: ProviderInstanceId,
  stdout: string,
  atOutputCap: boolean,
): Effect.Effect<ReadonlyArray<ProviderVcsRef>, ProviderVcsProtocolError> =>
  Effect.gen(function* () {
    if (atOutputCap && !stdout.endsWith("\n"))
      stdout = stdout.slice(0, stdout.lastIndexOf("\n") + 1);
    if (!atOutputCap && stdout !== "" && !stdout.endsWith("\n"))
      return yield* protocol(
        providerInstanceId,
        "listRefs",
        "Git ref output was not line terminated.",
      );
    const refs: Array<ProviderVcsRef> = [];
    for (const line of stdout.split("\n")) {
      if (line === "") continue;
      const fields = line.split("\0");
      if (fields.length !== 3)
        return yield* protocol(
          providerInstanceId,
          "listRefs",
          "Git returned a malformed ref record.",
        );
      const [refname, target, headMarker] = fields as [string, string, string];
      const local = refname.startsWith("refs/heads/");
      const remote = refname.startsWith("refs/remotes/");
      if (
        (!local && !remote) ||
        !/^[0-9a-f]{40,64}$/.test(target) ||
        (headMarker !== " " && headMarker !== "*")
      ) {
        return yield* protocol(
          providerInstanceId,
          "listRefs",
          "Git returned an invalid ref record.",
        );
      }
      const name = refname.slice(local ? "refs/heads/".length : "refs/remotes/".length);
      if (!isBoundedField(name, MAX_REF_NAME_BYTES))
        return yield* protocol(providerInstanceId, "listRefs", "Git returned an invalid ref name.");
      refs.push({
        kind: local ? "local" : "knownRemote",
        name,
        target,
        current: headMarker === "*",
        isDefault: remote && name.endsWith("/HEAD"),
      });
    }
    return refs;
  });

export const redactCodexVcsRemoteUrl = (input: string): string => {
  const fragment = input.search(/[?#]/);
  const withoutSuffix = fragment < 0 ? input : input.slice(0, fragment);
  try {
    const parsed = new URL(withoutSuffix);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const scheme = withoutSuffix.indexOf("://");
    if (scheme >= 0) {
      const authorityStart = scheme + 3;
      const authorityEnd = withoutSuffix.indexOf("/", authorityStart);
      const end = authorityEnd < 0 ? withoutSuffix.length : authorityEnd;
      const authority = withoutSuffix.slice(authorityStart, end);
      const at = authority.lastIndexOf("@");
      return at < 0
        ? withoutSuffix
        : `${withoutSuffix.slice(0, authorityStart)}${authority.slice(at + 1)}${withoutSuffix.slice(end)}`;
    }
    const colon = withoutSuffix.indexOf(":");
    const at = withoutSuffix.lastIndexOf("@", colon < 0 ? undefined : colon);
    return at >= 0 ? withoutSuffix.slice(at + 1) : withoutSuffix;
  }
};

export const makeCodexVcsAdapter = (options: MakeCodexVcsAdapterOptions): ProviderVcsAdapter => {
  const checkpointHelper =
    options.checkpointHelper === undefined
      ? undefined
      : makeCodexCheckpointHelperAdapter({
          providerInstanceId: options.providerInstanceId,
          gitExecutablePath: options.gitExecutablePath,
          helper: options.checkpointHelper,
        });
  const command = (args: ReadonlyArray<string>): ReadonlyArray<string> => [
    options.gitExecutablePath,
    ...GIT_CONFIG_PREFIX,
    ...args,
  ];

  const execute = Effect.fn("CodexVcsAdapter.execute")(function* (
    borrowed: CodexEndpointConnectionBorrow,
    operation: ProviderVcsOperation,
    cwd: string,
    args: ReadonlyArray<string>,
    outputBytesCap: number,
  ): Effect.fn.Return<CommandOutput, ProviderVcsError> {
    yield* borrowed.ensureCurrent.pipe(
      Effect.mapError(() => disconnected(options.providerInstanceId, operation)),
    );
    const exit = yield* borrowed.connection.client
      .request("command/exec", {
        command: command(args),
        cwd,
        env: CODEX_VCS_COMMAND_ENV,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        timeoutMs: CODEX_VCS_COMMAND_TIMEOUT_MS,
        outputBytesCap,
      })
      .pipe(Effect.result);
    if (exit._tag === "Failure") {
      const current = yield* borrowed.ensureCurrent.pipe(Effect.result);
      if (current._tag === "Failure")
        return yield* disconnected(options.providerInstanceId, operation);
      return yield* mapCodexError(options.providerInstanceId, operation, exit.failure);
    }
    yield* borrowed.ensureCurrent.pipe(
      Effect.mapError(() => disconnected(options.providerInstanceId, operation)),
    );
    if (exit.success.exitCode === 126 || exit.success.exitCode === 127)
      return yield* unsupported(options.providerInstanceId, operation);
    if (exit.success.exitCode !== 0)
      return yield* operationFailed(
        options.providerInstanceId,
        operation,
        "Git exited unsuccessfully.",
      );
    return {
      stdout: exit.success.stdout,
      atOutputCap: utf8Length(exit.success.stdout) >= outputBytesCap,
    };
  });

  const openRepository: ProviderVcsAdapter["openRepository"] = Effect.fn(
    "CodexVcsAdapter.openRepository",
  )(function* (providerHostPath) {
    if (!isAbsoluteNormalizedPosixPath(providerHostPath)) {
      return yield* pathFailed(
        options.providerInstanceId,
        "openRepository",
        providerHostPath,
        "expected_absolute_normalized_posix_path",
      );
    }
    const borrowed = yield* options.borrowConnection.pipe(
      Effect.mapError(() => disconnected(options.providerInstanceId, "openRepository")),
    );
    yield* borrowed.ensureCurrent.pipe(
      Effect.mapError(() => disconnected(options.providerInstanceId, "openRepository")),
    );
    const exit = yield* borrowed.connection.client
      .request("command/exec", {
        command: command([
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
          "--git-common-dir",
          "--is-inside-work-tree",
        ]),
        cwd: providerHostPath,
        env: CODEX_VCS_COMMAND_ENV,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        timeoutMs: CODEX_VCS_COMMAND_TIMEOUT_MS,
        outputBytesCap: CODEX_VCS_OPEN_OUTPUT_BYTES_CAP,
      })
      .pipe(Effect.result);
    if (exit._tag === "Failure") {
      const current = yield* borrowed.ensureCurrent.pipe(Effect.result);
      if (current._tag === "Failure")
        return yield* disconnected(options.providerInstanceId, "openRepository");
      return yield* mapCodexError(options.providerInstanceId, "openRepository", exit.failure);
    }
    yield* borrowed.ensureCurrent.pipe(
      Effect.mapError(() => disconnected(options.providerInstanceId, "openRepository")),
    );
    if (exit.success.exitCode === 126 || exit.success.exitCode === 127)
      return yield* unsupported(options.providerInstanceId, "openRepository");
    // Git uses the same nonzero family for a non-repository and some inaccessible
    // cwd/repository cases. Workspace resolution validates accessibility first;
    // this unwired adapter therefore makes only the conservative Git distinction.
    if (exit.success.exitCode !== 0) return { _tag: "NotRepository" } as const;
    if (utf8Length(exit.success.stdout) >= CODEX_VCS_OPEN_OUTPUT_BYTES_CAP)
      return yield* protocol(
        options.providerInstanceId,
        "openRepository",
        "Git repository identity exceeded its output bound.",
      );
    if (!exit.success.stdout.endsWith("\n"))
      return yield* protocol(
        options.providerInstanceId,
        "openRepository",
        "Git repository identity was not line terminated.",
      );
    const lines = exit.success.stdout.slice(0, -1).split("\n");
    if (
      lines.length !== 3 ||
      lines[2] !== "true" ||
      !isAbsoluteNormalizedPosixPath(lines[0]!) ||
      !isAbsoluteNormalizedPosixPath(lines[1]!)
    ) {
      return yield* protocol(
        options.providerInstanceId,
        "openRepository",
        "Git returned a malformed repository identity.",
      );
    }
    const rootPath = lines[0]!;
    const commonDirectoryPath = lines[1]!;
    const checkpointResult =
      checkpointHelper === undefined
        ? undefined
        : yield* checkpointHelper.probe(borrowed, rootPath).pipe(
            Effect.flatMap((probeResult) =>
              checkpointHelper.open(borrowed, { rootPath, commonDirectoryPath }, probeResult),
            ),
            Effect.result,
          );
    const checkpoints = checkpointResult?._tag === "Success" ? checkpointResult.success : undefined;

    const repository: ProviderVcsRepository = {
      identity: { kind: "git", rootPath, commonDirectoryPath },
      capabilities: {
        status: true,
        refs: true,
        remotes: true,
        reviewDiff: true,
      },
      ...(checkpoints === undefined ? {} : { checkpoints }),
      getStatus: Effect.fn("CodexVcsAdapter.getStatus")(function* (input) {
        const result = yield* execute(
          borrowed,
          "getStatus",
          rootPath,
          ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
          CODEX_VCS_STATUS_OUTPUT_BYTES_CAP,
        );
        return yield* parseStatus(
          options.providerInstanceId,
          result.stdout,
          result.atOutputCap,
          input.maxChangedPaths,
        );
      }),
      listRefs: Effect.fn("CodexVcsAdapter.listRefs")(function* (input) {
        const prefixes =
          input.scope === "local"
            ? ["refs/heads"]
            : input.scope === "knownRemote"
              ? ["refs/remotes"]
              : ["refs/heads", "refs/remotes"];
        const result = yield* execute(
          borrowed,
          "listRefs",
          rootPath,
          [
            "for-each-ref",
            "--sort=refname",
            `--count=${PROVIDER_VCS_MAX_REFS + 1}`,
            "--format=%(refname)%00%(objectname)%00%(HEAD)",
            ...prefixes,
          ],
          CODEX_VCS_REFS_OUTPUT_BYTES_CAP,
        );
        const parsed = yield* parseRefs(
          options.providerInstanceId,
          result.stdout,
          result.atOutputCap,
        );
        const query = input.query?.toLocaleLowerCase("en-US");
        const matching =
          query === undefined
            ? parsed
            : parsed.filter((ref) => ref.name.toLocaleLowerCase("en-US").includes(query));
        return {
          refs: matching.slice(0, input.maxRefs),
          truncated:
            result.atOutputCap ||
            parsed.length > PROVIDER_VCS_MAX_REFS ||
            matching.length > input.maxRefs,
        };
      }),
      listRemotes: Effect.fn("CodexVcsAdapter.listRemotes")(function* (input) {
        const result = yield* execute(
          borrowed,
          "listRemotes",
          rootPath,
          ["remote", "-v"],
          CODEX_VCS_REMOTES_OUTPUT_BYTES_CAP,
        );
        let stdout = result.stdout;
        if (result.atOutputCap && !stdout.endsWith("\n"))
          stdout = stdout.slice(0, stdout.lastIndexOf("\n") + 1);
        if (!result.atOutputCap && stdout !== "" && !stdout.endsWith("\n"))
          return yield* protocol(
            options.providerInstanceId,
            "listRemotes",
            "Git remote output was not line terminated.",
          );
        const byName = new Map<string, { fetch?: string; push?: string }>();
        for (const line of stdout.split("\n")) {
          if (line === "") continue;
          const match = /^([^\t]+)\t(.*) \((fetch|push)\)$/.exec(line);
          if (
            match === null ||
            !isBoundedField(match[1]!, MAX_REMOTE_NAME_BYTES) ||
            !isBoundedField(match[2]!, MAX_REMOTE_URL_BYTES)
          )
            return yield* protocol(
              options.providerInstanceId,
              "listRemotes",
              "Git returned a malformed remote record.",
            );
          const name = match[1]!;
          const item = byName.get(name) ?? {};
          item[match[3] as "fetch" | "push"] = redactCodexVcsRemoteUrl(match[2]!);
          byName.set(name, item);
        }
        const names = [...byName.keys()].sort();
        const primary = names.includes("origin") ? "origin" : names[0];
        const remotes = names.flatMap((name) => {
          const item = byName.get(name)!;
          if (item.fetch === undefined) return [];
          return [
            {
              name,
              fetchUrl: item.fetch,
              pushUrl: item.push !== undefined && item.push !== item.fetch ? item.push : null,
              isPrimary: name === primary,
            },
          ];
        });
        return {
          remotes: remotes.slice(0, input.maxRemotes),
          truncated: result.atOutputCap || remotes.length > input.maxRemotes,
        };
      }),
      getReviewDiff: Effect.fn("CodexVcsAdapter.getReviewDiff")(function* (input) {
        let remaining: number = input.maxBytes;
        const sources: Array<ProviderVcsReviewDiffSource> = [];
        let aggregateTruncated = false;
        const runDiff = Effect.fn("CodexVcsAdapter.runDiff")(function* (
          kind: "workingTree" | "baseRange",
          args: ReadonlyArray<string>,
          baseRef: string | null,
          headRef: string | null,
        ) {
          if (remaining === 0) {
            aggregateTruncated = true;
            sources.push({
              kind,
              baseRef,
              headRef,
              patch: "",
              byteLength: 0,
              truncated: true,
            });
            return;
          }
          const result = yield* execute(borrowed, "getReviewDiff", rootPath, args, remaining);
          const clipped = clipUtf8(result.stdout, remaining);
          const truncated = result.atOutputCap || clipped.clipped;
          sources.push({
            kind,
            baseRef,
            headRef,
            patch: clipped.value,
            byteLength: clipped.bytes,
            truncated,
          });
          remaining -= clipped.bytes;
          aggregateTruncated ||= truncated;
        });
        const whitespace = input.ignoreWhitespace ? ["--ignore-all-space"] : [];
        yield* runDiff(
          "workingTree",
          [
            "diff",
            "--patch",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            ...whitespace,
            "HEAD",
            "--",
          ],
          null,
          "HEAD",
        );
        if (input.baseRef !== undefined) {
          yield* runDiff(
            "baseRange",
            [
              "diff",
              "--patch",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              ...whitespace,
              `${input.baseRef}...HEAD`,
              "--",
            ],
            input.baseRef,
            "HEAD",
          );
        }
        return { sources, truncated: aggregateTruncated };
      }),
    };
    return { _tag: "Repository", repository } as const;
  });

  return { openRepository };
};
